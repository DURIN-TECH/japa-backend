// ============================================
// Route onboarding and languages (issue #220): the estimate and the hold in words
// ============================================

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { Timestamp } from "firebase-admin/firestore";
import { buildEstimate, mapPublish } from "../../../src/scrapers/onboarding/onboarding-words";
import { reasonInWords } from "../../../src/scrapers/rubric/rubric-gates";

/* eslint-disable @typescript-eslint/no-explicit-any */

const plan = [
  { sourceId: "b", contentHashPrefix: "bbbb", docType: "html" as const, chars: 1000, chunks: 2 },
  { sourceId: "a", contentHashPrefix: "aaaa", docType: "pdf" as const, chars: 500, chunks: 1 },
];
const input = (facts: [string, { title: string; host: string; role: string; language?: string }][]) => ({
  runId: "XA_x__r1", routeKey: "XA_x", plan, sourceFacts: new Map(facts),
  extraction: { maxRequestsPerRun: 40, maxInputCharsPerRun: 600_000 }, checkerMaxRequestsPerRun: 120,
  onboarding: { maxChunksPerRun: 20, maxRunsPerDay: 3 }, publishState: { code: "on" as const, plain: "Automatic publishing is on for this route." }, now: Timestamp.fromMillis(0),
});

describe("the estimate counts the translation calls when a non-English source is present", () => {
  test("one call at most per text part of a page not in the product language, said in plain words", () => {
    const e = buildEstimate(input([["a", { title: "A", host: "h.test", role: "primary", language: "es" }], ["b", { title: "B", host: "h.test", role: "primary", language: "en" }]]));
    assert.equal(e.translationCallsAtMost, 1, "only page a (1 text part) is not in the product language");
    assert.match(e.plain, /up to 1 more calls translate their quotes/);
    assert.match(e.plain, /never used as evidence/);
    assert.equal(e.sources.find((s) => s.sourceId === "a")?.language, "es");
  });

  test("all pages in the product language (or with no language): the estimate is exactly what it was before", () => {
    const before = buildEstimate(input([["a", { title: "A", host: "h.test", role: "primary" }]]));
    const withEn = buildEstimate(input([["a", { title: "A", host: "h.test", role: "primary", language: "en" }], ["b", { title: "B", host: "h.test", role: "primary", language: "en" }]]));
    for (const e of [before, withEn]) {
      assert.equal("translationCallsAtMost" in e, false);
      assert.ok(!/translate/.test(e.plain));
    }
    assert.equal(before.plain, withEn.plain);
    assert.equal(before.estimateId, withEn.estimateId);
  });
});

describe("a language hold is put in plain words", () => {
  test("language_not_supported reads as a sentence, not a code", () => {
    assert.match(reasonInWords("language_not_supported"), /not yet supported for automatic publishing/);
    const v = mapPublish({ versionStatus: "pending_review", settings: null, waitedMs: 0, waitLimitMs: 1000, run: { outcome: "held", reasonCodes: ["language_not_supported"], attempts: 1 } }) as any;
    assert.equal(v.status, "held");
    assert.match(v.plain, /Held by the safeguards: .*not yet supported for automatic publishing/);
    assert.equal(v.hold.code, "language_not_supported");
    assert.equal(v.hold.retryScheduled, false, "an enabled language is a decision, not something a retry fixes");
  });
});
