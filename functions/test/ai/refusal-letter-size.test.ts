// ============================================
// Unit tests — the refusal-letter job and the input-size cap (issue #310)
// ============================================
//
// The real RefusalLetterService over the in-memory Firestore and a stub model
// provider. No network, no emulator, no model spend.
//
// Before #310 the job compared the letter's BASE64 length with
// `maxInputCharsPerAssessment` (2,000,000 characters), so any letter over about
// 1.5 MB failed with `cost_cap_exceeded` although the file limit is 10 MB. The
// cap now counts the request's text only; the file is bounded by its real byte
// length against `maxFileBytes`, as it already was a few lines earlier.

import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";
import { Timestamp } from "firebase-admin/firestore";
import { fakeCollection, fakeRunTransaction, resetStore, store } from "../helpers/fake-firestore";
import { RefusalLetterService, type RefusalDeps } from "../../src/services/ai/refusal-letter.service";
import { mergeAiSettings, type AiSettings } from "../../src/services/ai/ai-settings";
import type { LlmProvider, LlmRequest, LlmResponse } from "../../src/services/ai/llm-provider";

/* eslint-disable @typescript-eslint/no-explicit-any */

const MB = 1024 * 1024;
const NOW = new Date("2026-11-11T10:00:00Z");

/** A model stub that records every request and says "I could not read this". */
class StubProvider implements LlmProvider {
  readonly requests: LlmRequest[] = [];
  modelFor(): string {
    return "stub-model";
  }
  async complete(request: LlmRequest): Promise<LlmResponse> {
    this.requests.push(request);
    // The shortest valid answer: the job stores "unreadable" and stops, which
    // is all these tests need (they are about what happens BEFORE the call).
    const text = JSON.stringify({ readable: false, isRefusalLetter: false, decisionDate: null, visaTypeNamed: null, applicantName: null, dateOfBirth: null, reasons: [] });
    return { text, stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }, model: "stub-model" };
  }
}

/** A PDF of exactly `size` bytes (only the header and the length matter). */
function pdfOf(size: number): Buffer {
  const out = Buffer.alloc(size);
  out.write("%PDF-1.4 ", 0, "latin1");
  return out;
}

/** The service over the stub, the given settings and the given letter bytes. */
function serviceWith(provider: LlmProvider, bytes: Buffer, settings: Partial<AiSettings> = {}): RefusalLetterService {
  const deps: RefusalDeps = {
    provider,
    getApprovedRubric: async () => null,
    loadBytes: async () => bytes,
    runTransaction: fakeRunTransaction,
    readSettings: async () => ({ ok: true, settings: mergeAiSettings(settings as Record<string, unknown>) }),
    now: () => NOW,
  };
  return new RefusalLetterService(deps);
}

/** One queued analysis for one uploaded letter on one application. */
function seedQueuedAnalysis(): void {
  store.set("applications/app-1", { userId: "client-1", countryCode: "AA", visaTypeId: "route-a", status: "in_progress" });
  store.set("documents/doc-1", {
    applicationId: "app-1",
    userId: "client-1",
    requirementId: "refusal-letter",
    storageUrl: "documents/client-1/app-1/letter.pdf",
    fileType: "application/pdf",
    fileSizeMb: 3,
    updatedAt: Timestamp.fromMillis(1_000),
  });
  store.set("refusalAnalyses/an-1", { documentId: "doc-1", applicationId: "app-1", userId: "client-1", status: "queued", createdAt: Timestamp.fromDate(NOW) });
}

beforeEach(async () => {
  resetStore();
  const firebase: any = await import("../../src/utils/firebase");
  for (const name of ["applications", "documents", "refusalAnalyses", "aiCosts", "users", "appConfig"]) {
    firebase.collections[name] = fakeCollection(name);
  }
});

describe("refusal-letter job: the letter's bytes are not input characters (#310)", () => {
  test("a 3 MB letter reaches the model at the default settings (it used to fail with cost_cap_exceeded)", async () => {
    seedQueuedAnalysis();
    const provider = new StubProvider();
    const result = await serviceWith(provider, pdfOf(3 * MB)).runJob("an-1");
    const stored = store.get("refusalAnalyses/an-1") as any;
    assert.equal(result, "succeeded");
    assert.equal(stored.status, "succeeded");
    assert.equal(stored.error, null);
    assert.equal(provider.requests.length, 1);
    // What was sent is larger than the whole character cap, and that is fine.
    assert.ok(provider.requests[0].documents![0].data.length > 2_000_000);
  });

  test("a letter of exactly maxFileBytes is still sent", async () => {
    seedQueuedAnalysis();
    const provider = new StubProvider();
    await serviceWith(provider, pdfOf(10 * MB)).runJob("an-1");
    assert.equal((store.get("refusalAnalyses/an-1") as any).status, "succeeded");
    assert.equal(provider.requests.length, 1);
  });

  test("a letter over maxFileBytes (real bytes) is refused as file_too_large, with no call", async () => {
    seedQueuedAnalysis();
    const provider = new StubProvider();
    await serviceWith(provider, pdfOf(10 * MB + 1)).runJob("an-1");
    const stored = store.get("refusalAnalyses/an-1") as any;
    assert.equal(stored.status, "failed");
    assert.equal(stored.error.code, "file_too_large");
    assert.equal(provider.requests.length, 0);
  });

  test("the same with a stored cap: only the request's TEXT is compared with it", async () => {
    seedQueuedAnalysis();
    const provider = new StubProvider();
    // The lowest allowed character cap (10,000): the short fixed prompt fits, the 3 MB file is not counted.
    await serviceWith(provider, pdfOf(3 * MB), { maxInputCharsPerAssessment: 10_000 }).runJob("an-1");
    assert.equal((store.get("refusalAnalyses/an-1") as any).status, "succeeded");
    assert.equal(provider.requests.length, 1);
  });

  test("the daily limit is still daily_cap_exceeded, with no call", async () => {
    seedQueuedAnalysis();
    store.set("aiCosts/2026-11-11", { refusalAnalyses: 200 });
    const provider = new StubProvider();
    await serviceWith(provider, pdfOf(3 * MB)).runJob("an-1");
    const stored = store.get("refusalAnalyses/an-1") as any;
    assert.equal(stored.error.code, "daily_cap_exceeded");
    assert.equal(provider.requests.length, 0);
  });
});
