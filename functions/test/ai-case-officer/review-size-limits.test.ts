// ============================================
// Unit tests — review size limits (issue #310)
// ============================================
//
// The real AiCaseOfficerService over the in-memory Firestore, a scripted model
// provider and synthetic file bytes. No network, no emulator, no model spend.
//
// What changed in #310 and is pinned here:
//  - an attached file's bytes no longer count toward the input-characters cap
//    (a 3 MB photo used to end the job with `cost_cap_exceeded`);
//  - each file is bounded by its REAL byte length after download, never by the
//    stored `fileSizeMb`, and an image also by what the model accepts;
//  - the default request cap fits an ordinary application (10 documents and a
//    rulebook that needs 5 judgement calls);
//  - an application that is too big for one review fails with its own code
//    (`too_many_documents` / `review_too_large`) BEFORE any model call, and
//    never with the daily-cap code;
//  - `daily_cap_exceeded` behaves as before;
//  - all of it is the same with or without a stored `appConfig/aiSettings`.

import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";
import { store } from "../helpers/fake-firestore";
import { AiCaseOfficerService } from "../../src/services/ai-case-officer.service";
import {
  DEFAULT_AI_SETTINGS,
  MODEL_IMAGE_MAX_BYTES,
  fileByteLimitFor,
  isImageType,
  megabytesLabel,
  mergeAiSettings,
  readAiSettings,
} from "../../src/services/ai/ai-settings";
import { ASSESSMENT_ERROR_CODES } from "../../src/types/assessment";
import { planJudgementBatches } from "../../src/services/ai/assessment-engine";
import {
  criterion,
  fictionalRubric,
  installAssessmentFakes,
  resetAll,
  routeARubric,
  rubricBook,
  ScriptedProvider,
  seedApplication,
  seedDocument,
  seedEligibility,
  seedStatement,
  seedUser,
  serviceWith,
} from "./harness";

/* eslint-disable @typescript-eslint/no-explicit-any */

const MB = 1024 * 1024;

// ----- Synthetic files -----

/**
 * A file of exactly `size` bytes that the media-type sniffer recognises, with
 * the harness's "KEY:<name>" marker so the scripted provider can tell which
 * document a request carries. The rest is zero padding: only the header and
 * the length matter to the code under test.
 */
function fileBytes(kind: "pdf" | "jpeg", key: string, size: number): Buffer {
  const out = Buffer.alloc(size);
  if (kind === "pdf") out.write("%PDF-1.4 ", 0, "latin1");
  else out.set([0xff, 0xd8, 0xff, 0xe0], 0);
  out.write(` KEY:${key} `, 10, "latin1");
  return out;
}

/** The files a test put "in storage", by the document's storage path. */
const files = new Map<string, Buffer>();

/** Seed one document whose stored bytes are `bytes`. `sizeMb` is what the RECORD claims. */
function seedFile(id: string, bytes: Buffer, opts: { label?: string; sizeMb?: number } = {}): void {
  seedDocument({ id, key: id, label: opts.label ?? "Document", sizeMb: opts.sizeMb ?? 0.1 });
  files.set(`storage/${id}`, bytes);
}

/** `loadBytes` over the map above. */
const loadBytes = async (path: string): Promise<Buffer> => {
  const hit = files.get(path);
  if (!hit) throw new Error("no such object");
  return hit;
};

// ----- Scripted answers -----

/** A well-formed, empty stage 2 answer. */
const EXTRACTION = JSON.stringify({ readable: true, values: [] });
/** A well-formed, empty stage 3 answer. */
const JUDGEMENT = JSON.stringify({ findings: [], strengths: [], statementNotes: [], suspiciousPassages: [] });

/** A provider that answers every call with an empty, valid answer. */
function provider(): ScriptedProvider {
  return new ScriptedProvider((req) => (req.role === "extraction" ? EXTRACTION : JUDGEMENT));
}

/** The keys of the documents that were sent to the model, sorted. */
function keysSent(p: ScriptedProvider): string[] {
  return p.requests
    .filter((r) => r.role === "extraction")
    .map((r) => /KEY:([A-Za-z0-9_-]+)/.exec(Buffer.from(r.documents![0].data, "base64").toString("latin1"))![1])
    .sort();
}

// ----- Fixtures -----

/**
 * Route A plus enough judgement rules to need FIVE judgement calls, the number
 * UK Standard Visitor v2 needed on dev (assessment 607619bc…). A fictional
 * rulebook: no real rulebook is drafted, extracted or published by this test.
 */
function fiveBatchRubric() {
  const base = routeARubric();
  const stages = ["validity", "suitability", "eligibility", "credibility"] as const;
  const extra = Array.from({ length: 160 }, (_, i) =>
    criterion({ criterionId: `j${String(i).padStart(3, "0")}`, title: `Judgement rule ${i}`, kind: "judgement", stage: stages[i % 4], severity: "low", probeFactors: ["f"] })
  );
  return fictionalRubric({ countryCode: "AA", visaTypeId: "route-a", intentPolarity: "immigrant_intent_penalised", criteria: [...base.criteria, ...extra] });
}

/** The applicant every test uses: profile, eligibility, and a short statement. */
function seedApplicant(): void {
  seedApplication({ id: "app-1" });
  seedUser("client-1", "Ada", "Lovelace");
  seedEligibility({ nationality: "IN", score: 80 });
  seedStatement({ id: "stmt-1", text: "I will return home at the end of the visit." });
}

/** Request a review and run its job; returns the stored assessment. */
async function review(svc: AiCaseOfficerService): Promise<any> {
  const app = { id: "app-1", ...(store.get("applications/app-1") as any) } as any;
  const out: any = await svc.requestAssessment(app, { tier: "full", trigger: "manual", requestedBy: "tester" });
  assert.ok(out.assessmentId, `unexpected ${out.kind}`);
  await svc.runJob(out.assessmentId);
  return store.get(`applicationAssessments/${out.assessmentId}`) as any;
}

beforeEach(async () => {
  resetAll();
  files.clear();
  await installAssessmentFakes();
  rubricBook.set("AA_route-a", routeARubric());
});

// ============================================
// The settings and the per-file limit
// ============================================

describe("defaults and the per-file limit", () => {
  test("the default request cap is 30, and a stored value in range still overrides it", () => {
    assert.equal(DEFAULT_AI_SETTINGS.maxRequestsPerAssessment, 30);
    assert.equal(mergeAiSettings(undefined).maxRequestsPerAssessment, 30, "no settings document: the default");
    assert.equal(mergeAiSettings({ maxRequestsPerAssessment: 12 }).maxRequestsPerAssessment, 12, "a stored value in 1-50 wins");
    assert.equal(mergeAiSettings({ maxRequestsPerAssessment: 50 }).maxRequestsPerAssessment, 50);
    assert.equal(mergeAiSettings({ maxRequestsPerAssessment: 51 }).maxRequestsPerAssessment, 30, "out of range: the default");
    assert.equal(mergeAiSettings({ maxRequestsPerAssessment: 0 }).maxRequestsPerAssessment, 30);
  });

  test("the caps this issue must not raise are unchanged", () => {
    assert.equal(DEFAULT_AI_SETTINGS.maxAssessmentsPerDay, 200);
    assert.equal(DEFAULT_AI_SETTINGS.maxInputCharsPerAssessment, 2_000_000);
    assert.equal(DEFAULT_AI_SETTINGS.maxFileBytes, 10 * MB);
  });

  test("the default cap fits 15 documents plus five judgement calls, with a margin", () => {
    const judgementCalls = planJudgementBatches(fiveBatchRubric().criteria.filter((c) => c.kind === "judgement")).length;
    assert.equal(judgementCalls, 5, "the fixture needs as many judgement calls as UK Standard Visitor v2");
    assert.ok(15 + judgementCalls < DEFAULT_AI_SETTINGS.maxRequestsPerAssessment);
  });

  test("one file is bounded by maxFileBytes; an image also by what the model accepts", () => {
    const s = mergeAiSettings(undefined);
    assert.equal(fileByteLimitFor(s, false), 10 * MB, "a PDF: maxFileBytes");
    assert.equal(fileByteLimitFor(s, true), MODEL_IMAGE_MAX_BYTES, "an image: the model's limit, which is lower");
    // The provider refuses an image over 10 MB of base64 text: the raw limit must encode to less.
    assert.ok(Math.ceil(MODEL_IMAGE_MAX_BYTES / 3) * 4 < 10_000_000);
    // A 2-4 MB phone photo is inside it.
    assert.ok(4 * MB < MODEL_IMAGE_MAX_BYTES);
    // A stored maxFileBytes below the image limit applies to images too.
    assert.equal(fileByteLimitFor(mergeAiSettings({ maxFileBytes: 5 * MB }), true), 5 * MB);
    assert.equal(fileByteLimitFor(mergeAiSettings({ maxFileBytes: 20 * MB }), true), MODEL_IMAGE_MAX_BYTES);
    assert.equal(fileByteLimitFor(mergeAiSettings({ maxFileBytes: 20 * MB }), false), 20 * MB);
  });

  test("image types are recognised by MIME type only", () => {
    assert.equal(isImageType("image/jpeg"), true);
    assert.equal(isImageType(" IMAGE/HEIC "), true);
    assert.equal(isImageType("application/pdf"), false);
    assert.equal(isImageType("jpeg"), false);
    assert.equal(isImageType(undefined), false);
    assert.equal(megabytesLabel(10 * MB), "10 MB");
    assert.equal(megabytesLabel(MODEL_IMAGE_MAX_BYTES), "7 MB");
  });

  test("the new codes are stored codes, and the old one is kept for old failures", () => {
    for (const code of ["too_many_documents", "review_too_large", "cost_cap_exceeded", "daily_cap_exceeded"]) {
      assert.ok((ASSESSMENT_ERROR_CODES as readonly string[]).includes(code), code);
    }
  });
});

// ============================================
// Attached bytes are not input characters
// ============================================

describe("attached files do not count toward the input-characters cap", () => {
  test("one 3 MB photo is reviewed at the default settings (it used to fail with cost_cap_exceeded)", async () => {
    seedApplicant();
    seedFile("photo", fileBytes("jpeg", "photo", 3 * MB));
    const p = provider();
    const stored = await review(serviceWith(p, {}, { loadBytes }));
    assert.equal(stored.status, "succeeded");
    assert.equal(stored.error, null);
    assert.deepEqual(keysSent(p), ["photo"]);
  });

  test("the cap still counts the TEXT of every request: a statement over it fails as review_too_large, with no call", async () => {
    seedApplication({ id: "app-1" });
    seedUser("client-1", "Ada", "Lovelace");
    seedEligibility({ nationality: "IN", score: 80 });
    seedStatement({ id: "stmt-1", text: "word ".repeat(4_000) }); // 20,000 characters
    seedFile("bank", fileBytes("pdf", "bank", 1_000));
    const p = provider();
    const stored = await review(serviceWith(p, { maxInputCharsPerAssessment: 10_000 }, { loadBytes }));
    assert.equal(stored.status, "failed");
    assert.equal(stored.error.code, "review_too_large");
    assert.equal(p.requests.length, 0, "decided before any model call");
    assert.equal(store.has("aiCosts/2026-11-11"), false, "and before one of today's reviews is used");
  });

  test("a file far larger than the character cap still passes it (only its text counts)", async () => {
    seedApplicant();
    seedFile("scan", fileBytes("pdf", "scan", 2 * MB)); // 2.8 million base64 characters
    const p = provider();
    // The lowest allowed character cap: only the prompt text has to fit.
    const stored = await review(serviceWith(p, { maxInputCharsPerAssessment: 100_000 }, { loadBytes }));
    assert.equal(stored.status, "succeeded");
    assert.deepEqual(keysSent(p), ["scan"]);
  });
});

// ============================================
// The per-file check uses the real byte length
// ============================================

describe("the file-size check reads the real bytes, not the stored fileSizeMb", () => {
  test("a file over the limit is reported for that document only, whatever its record says; the job succeeds", async () => {
    seedApplicant();
    // The record claims 0.001 MB (what a client once sent for a 21 MB object).
    seedFile("huge", fileBytes("pdf", "huge", 10 * MB + 1), { sizeMb: 0.001, label: "Huge scan" });
    seedFile("bank", fileBytes("pdf", "bank", 1_000), { label: "Bank statement" });
    const p = provider();
    const stored = await review(serviceWith(p, {}, { loadBytes }));
    assert.equal(stored.status, "succeeded");
    assert.deepEqual(keysSent(p), ["bank"], "the oversized file never reaches the model; the other document is read");
  });

  test("a small file whose record claims a huge size is read normally", async () => {
    seedApplicant();
    seedFile("bank", fileBytes("pdf", "bank", 1_000), { sizeMb: 99_999 });
    const p = provider();
    const stored = await review(serviceWith(p, {}, { loadBytes }));
    assert.equal(stored.status, "succeeded");
    assert.deepEqual(keysSent(p), ["bank"]);
  });

  test("a PDF of exactly the limit is sent; an image is held to the lower model limit", async () => {
    seedApplicant();
    seedFile("pdf-at-limit", fileBytes("pdf", "pdf-at-limit", 10 * MB));
    seedFile("img-at-limit", fileBytes("jpeg", "img-at-limit", MODEL_IMAGE_MAX_BYTES));
    seedFile("img-over", fileBytes("jpeg", "img-over", MODEL_IMAGE_MAX_BYTES + 1));
    const p = provider();
    const stored = await review(serviceWith(p, {}, { loadBytes }));
    assert.equal(stored.status, "succeeded");
    assert.deepEqual(keysSent(p), ["img-at-limit", "pdf-at-limit"]);
    // Nothing sent to the provider is over what it accepts for one image.
    for (const r of p.requests.filter((x) => x.documents?.[0]?.mediaType === "image/jpeg")) {
      assert.ok(r.documents![0].data.length < 10_000_000);
    }
  });
});

// ============================================
// An ordinary application fits
// ============================================

describe("an ordinary application is reviewed at the default settings", () => {
  test("1 passport PDF, 3 bank statements and 6 photos of 2-4 MB with a five-call rulebook: succeeded, every document read", async () => {
    rubricBook.set("AA_route-a", fiveBatchRubric());
    seedApplicant();
    seedFile("passport", fileBytes("pdf", "passport", 1 * MB), { label: "Passport" });
    for (let i = 1; i <= 3; i++) seedFile(`bank${i}`, fileBytes("pdf", `bank${i}`, 1.5 * MB), { label: "Bank statement" });
    const photoSizes = [2, 2.5, 3, 3.5, 4, 4];
    photoSizes.forEach((mb, i) => seedFile(`photo${i + 1}`, fileBytes("jpeg", `photo${i + 1}`, mb * MB), { label: "Photo" }));

    const p = provider();
    // `serviceWith(p)` resolves the settings exactly as a missing settings document does.
    const stored = await review(serviceWith(p, {}, { loadBytes }));

    assert.equal(stored.status, "succeeded");
    assert.equal(stored.error, null);
    assert.equal(p.callsFor("extraction"), 10, "one extraction per document");
    assert.deepEqual(keysSent(p), ["bank1", "bank2", "bank3", "passport", "photo1", "photo2", "photo3", "photo4", "photo5", "photo6"]);
    assert.equal(p.callsFor("judgement"), 5);
    assert.equal(p.requests.length, 15, "well inside the cap of 30");
  });
});

// ============================================
// Too big for one review: its own codes, never the daily-cap code
// ============================================

describe("an application that passes a per-review cap", () => {
  /** Seed `n` small documents. */
  function seedDocs(n: number): void {
    for (let i = 0; i < n; i++) seedFile(`d${String(i).padStart(2, "0")}`, fileBytes("pdf", `d${i}`, 500));
  }

  test("more documents than the request cap leaves room for: too_many_documents, zero calls, no daily slot used", async () => {
    seedApplicant();
    seedDocs(30); // route A needs 1 judgement call, so the default cap of 30 has room for 29
    const p = provider();
    const stored = await review(serviceWith(p, {}, { loadBytes }));
    assert.equal(stored.status, "failed");
    assert.equal(stored.error.code, "too_many_documents");
    assert.match(stored.error.message, /more documents \(30\) than one review can read \(29\)/);
    assert.equal(p.requests.length, 0, "nothing is spent on a review that cannot finish");
    assert.equal(store.has("aiCosts/2026-11-11"), false, "the daily count is untouched");
  });

  test("exactly as many documents as there is room for: succeeded, using the whole cap", async () => {
    seedApplicant();
    seedDocs(29);
    const p = provider();
    const stored = await review(serviceWith(p, {}, { loadBytes }));
    assert.equal(stored.status, "succeeded");
    assert.equal(p.requests.length, 30);
  });

  test("the rules alone need every request: review_too_large (removing documents would not help), zero calls", async () => {
    rubricBook.set("AA_route-a", fiveBatchRubric());
    seedApplicant();
    seedDocs(1);
    const p = provider();
    const stored = await review(serviceWith(p, { maxRequestsPerAssessment: 5 }, { loadBytes }));
    assert.equal(stored.status, "failed");
    assert.equal(stored.error.code, "review_too_large");
    assert.equal(p.requests.length, 0);
  });

  test("a statement-only application whose rules pass the cap: review_too_large", async () => {
    rubricBook.set("AA_route-a", fiveBatchRubric());
    seedApplicant();
    const p = provider();
    const stored = await review(serviceWith(p, { maxRequestsPerAssessment: 4 }, { loadBytes }));
    assert.equal(stored.error.code, "review_too_large");
    assert.equal(p.requests.length, 0);
  });

  test("the platform-wide daily limit is still daily_cap_exceeded, with zero calls", async () => {
    seedApplicant();
    seedFile("photo", fileBytes("jpeg", "photo", 3 * MB));
    store.set("aiCosts/2026-11-11", { assessments: 200 });
    const p = provider();
    const stored = await review(serviceWith(p, {}, { loadBytes }));
    assert.equal(stored.status, "failed");
    assert.equal(stored.error.code, "daily_cap_exceeded");
    assert.equal(stored.error.message, "today's assessment cap is used up");
    assert.equal(p.requests.length, 0);
    assert.deepEqual(store.get("aiCosts/2026-11-11"), { assessments: 200 });
  });

  test("a review that reaches the model still counts once against the daily limit", async () => {
    seedApplicant();
    seedDocs(2);
    await review(serviceWith(provider(), {}, { loadBytes }));
    assert.deepEqual(store.get("aiCosts/2026-11-11"), { assessments: 1 });
  });
});

// ============================================
// With and without a stored settings document
// ============================================

describe("the same behaviour with or without appConfig/aiSettings", () => {
  /** The service reading its settings through the REAL reader, over the in-memory appConfig. */
  const viaStoredSettings = (p: ScriptedProvider) => serviceWith(p, {}, { loadBytes, readSettings: readAiSettings });

  /** Ten small documents: fits the default cap, not a stored cap of 6. */
  function seedTen(): void {
    seedApplicant();
    for (let i = 0; i < 10; i++) seedFile(`d${i}`, fileBytes("pdf", `d${i}`, 500));
  }

  test("no settings document: the code defaults apply and ten documents are reviewed", async () => {
    seedTen();
    assert.equal(store.has("appConfig/aiSettings"), false);
    const p = provider();
    const stored = await review(viaStoredSettings(p));
    assert.equal(stored.status, "succeeded");
    assert.equal(p.callsFor("extraction"), 10);
  });

  test("an empty settings document changes nothing", async () => {
    seedTen();
    store.set("appConfig/aiSettings", {});
    const p = provider();
    const stored = await review(viaStoredSettings(p));
    assert.equal(stored.status, "succeeded");
    assert.equal(p.callsFor("extraction"), 10);
  });

  test("a stored request cap inside the allowed range overrides the default", async () => {
    seedTen();
    store.set("appConfig/aiSettings", { maxRequestsPerAssessment: 6 });
    const p = provider();
    const stored = await review(viaStoredSettings(p));
    assert.equal(stored.status, "failed");
    assert.equal(stored.error.code, "too_many_documents");
    assert.match(stored.error.message, /\(10\).*\(5\)/);
    assert.equal(p.requests.length, 0);
  });

  test("a stored request cap outside the allowed range is ignored (the default applies)", async () => {
    seedTen();
    store.set("appConfig/aiSettings", { maxRequestsPerAssessment: 500 });
    const p = provider();
    const stored = await review(viaStoredSettings(p));
    assert.equal(stored.status, "succeeded");
  });

  test("a stored maxFileBytes is the per-file limit the review applies", async () => {
    seedApplicant();
    seedFile("big", fileBytes("pdf", "big", 2 * MB));
    seedFile("small", fileBytes("pdf", "small", 500));
    store.set("appConfig/aiSettings", { maxFileBytes: 1 * MB });
    const p = provider();
    const stored = await review(viaStoredSettings(p));
    assert.equal(stored.status, "succeeded");
    assert.deepEqual(keysSent(p), ["small"]);
  });

  test("a stored 'off' still stops the review (the kill switch is untouched)", async () => {
    seedTen();
    store.set("appConfig/aiSettings", { enabled: false });
    const p = provider();
    const app = { id: "app-1", ...(store.get("applications/app-1") as any) } as any;
    const out: any = await viaStoredSettings(p).requestAssessment(app, { tier: "full", trigger: "manual", requestedBy: "tester" });
    if (out.assessmentId) {
      await viaStoredSettings(p).runJob(out.assessmentId);
      assert.equal((store.get(`applicationAssessments/${out.assessmentId}`) as any).error.code, "disabled");
    } else {
      assert.equal(out.kind, "disabled");
    }
    assert.equal(p.requests.length, 0);
  });
});
