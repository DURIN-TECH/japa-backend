// ============================================
// Rubric scope, applicability and list rules (issue #112)
// ============================================
//
// Synthetic documents only: fictional rule numbers, no country, no real
// route. What is checked: what code keeps from each source ROLE, the four
// applicabilities, the verbatim condition quote, the standing flag for
// dropped specialist criteria, and the combined-sub-conditions flag.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, test } from "node:test";
import { SnapshotQuoteIndex } from "../../../src/scrapers/rubric/rubric-quote";
import { assessChunkOutput, mergeAssessments, primaryNamesDocument, routeScopeFrom, type SourceRole, type SourceScope } from "../../../src/scrapers/rubric/rubric-extraction.service";
import type { GuidanceSnapshotContent } from "../../../src/scrapers/guidance/types";
import { DEFAULT_SEVERITY_LEVELS } from "../../../src/types/rubric";
import type { RawCriterion } from "../../../src/scrapers/rubric/rubric-prompt";
import { answer, crit } from "./rubric-harness";

const LINES = [
  "Z 1.1. The applicant must hold a valid travel document.",
  "Z 1.2. If a third party pays for the stay, the third party:",
  "(a) must have a genuine relationship with the applicant; and",
  "(b) must not be in breach of the rules; and",
  "(c) must be able to support the applicant.",
  "Z 1.3. An applicant coming to teach at a school must hold a letter from the school.",
  "Z 1.4. An applicant for the other category must hold a sponsor licence.",
  "Z 1.5. The applicant must not be in the country unlawfully; see Part Alpha.",
  "Z 1.6. A person with no earlier refusals is treated in the same way as any other applicant.",
];
const TEXT = LINES.join("\n");
const snap = (text: string, sourceId = "doc"): GuidanceSnapshotContent => ({ schemaVersion: 1, sourceId, contentHash: createHash("sha256").update(text).digest("hex"), docType: "html", url: "https://docs.example/z", finalUrl: "https://docs.example/z", fetchedAt: "2026-11-11T01:00:00.000Z", text, pages: null });
const DOC = snap(TEXT);
const INDEX = new SnapshotQuoteIndex(DOC);
const BASE = { sourceId: DOC.sourceId, url: DOC.url, contentHash: DOC.contentHash, retrievedAt: DOC.fetchedAt };
const CHUNK = { sourceId: DOC.sourceId, chunkIndex: 0 };

const judgement = (quote: string, extra: Partial<RawCriterion> = {}) => crit({ ref: "r", title: "T", kind: "judgement", quote, probeFactors: ["x"], requiresInterviewBeforeRefusal: false, ...extra });
const FEE_LINE = "The applicant must hold a valid travel document.";
const TEACH = "An applicant coming to teach at a school must hold a letter from the school.";
const OTHER = "An applicant for the other category must hold a sponsor licence.";
const LEAD_IN = "If a third party pays for the stay, the third party:";

/** The scope of a source with `role` whose route's own text is `primaryText`. */
function scopeOf(role: SourceRole, opts: { primaryText?: string; named?: boolean } = {}): SourceScope {
  return { role, allow: routeScopeFrom([opts.primaryText ?? ""]), namedByPrimary: opts.named ?? false };
}
function assess(c: RawCriterion, scope: SourceScope | null) {
  const out = assessChunkOutput(answer({ criteria: [c] }), CHUNK, INDEX, BASE, DEFAULT_SEVERITY_LEVELS, scope);
  return { accepted: out.criteria[0], reason: out.discards[0]?.reason, out };
}

describe("scope: primary and route guidance keep all_applicants and conditional", () => {
  for (const role of ["primary", "route_guidance"] as const) {
    test(`${role}: all_applicants and conditional are kept, the condition verbatim`, () => {
      assert.ok(assess(judgement(FEE_LINE), scopeOf(role)).accepted);
      const cond = assess(judgement("(a) must have a genuine relationship with the applicant; and", { applicability: "conditional", applicabilityCondition: LEAD_IN }), scopeOf(role)).accepted;
      assert.equal(cond?.criterion.applicability, "conditional");
      assert.equal(cond?.criterion.applicabilityCondition, LEAD_IN);
    });

    test(`${role}: specialist and other_route are dropped under their own reasons, with audit fields`, () => {
      const sp = assess(judgement(TEACH, { applicability: "specialist", applicabilityCondition: "coming to teach at a school" }), scopeOf(role));
      assert.equal(sp.accepted, undefined);
      assert.equal(sp.reason, "specialist_activity");
      assert.ok(sp.out.discards[0].quoteHash && sp.out.discards[0].quoteStart);
      const other = assess(judgement(OTHER, { applicability: "other_route" }), scopeOf(role));
      assert.equal(other.reason, "other_route");
      assert.ok(other.out.discards[0].quoteHash);
    });
  }

  test("a conditional criterion whose condition is not verbatim in the source is refused", () => {
    const r = assess(judgement(FEE_LINE, { applicability: "conditional", applicabilityCondition: "if the moon is full tonight" }), scopeOf("primary"));
    assert.equal(r.accepted, undefined);
    assert.equal(r.reason, "quote_not_found");
  });
});

describe("scope: secondary sources", () => {
  test("kept only when the primary source names the document (or prints the criterion's reference) AND it is all_applicants / conditional", () => {
    // Not pointed at: dropped, whatever the applicability.
    assert.equal(assess(judgement(FEE_LINE), scopeOf("secondary")).reason, "out_of_route_scope");
    // Named by the primary source: kept.
    assert.ok(assess(judgement(FEE_LINE), scopeOf("secondary", { named: true })).accepted);
    // Named, but specialist / other_route: out of scope.
    assert.equal(assess(judgement(TEACH, { applicability: "specialist" }), scopeOf("secondary", { named: true })).reason, "out_of_route_scope");
    assert.equal(assess(judgement(OTHER, { applicability: "other_route" }), scopeOf("secondary", { named: true })).reason, "out_of_route_scope");
    // Not named, but the primary source prints this criterion's reference (derived from the layout: "Z 1.1").
    assert.ok(assess(judgement(FEE_LINE), scopeOf("secondary", { primaryText: "see Z 1.1 for the document" })).accepted);
  });

  test("a document is 'named' when a part or appendix name the primary source mentions is in its title or opening text", () => {
    const scope = routeScopeFrom(["The applicant must not fall for refusal under Part Alpha and must meet Appendix Beta."]);
    assert.equal(primaryNamesDocument(scope, "Immigration Rules: Part Alpha", "text"), true);
    assert.equal(primaryNamesDocument(scope, "Something else", "Appendix Beta Money rules\n..."), true);
    assert.equal(primaryNamesDocument(scope, "Part Gamma", "nothing relevant"), false);
  });
});

describe("applicability is optional for callers that predate it, and no scope means no scoping", () => {
  test("a run with no primary source keeps everything", () => {
    assert.ok(assess(judgement(TEACH, { applicability: "specialist" }), null).accepted);
  });
});

describe("standing flag for dropped specialist criteria", () => {
  test("the merged rubric says how many were dropped", () => {
    const out = assessChunkOutput(
      answer({ criteria: [judgement(FEE_LINE, { ref: "a", title: "A" }), judgement(TEACH, { ref: "b", title: "B", applicability: "specialist" }), judgement(OTHER, { ref: "c", title: "C", applicability: "specialist" })] }),
      CHUNK, INDEX, BASE, DEFAULT_SEVERITY_LEVELS, scopeOf("primary")
    );
    const merged = mergeAssessments([{ chunk: CHUNK, assessment: out }]);
    const flag = merged.flags.find((f) => f.code === "specialist_criteria_dropped");
    assert.ok(flag);
    assert.equal(flag.target, "rubric");
    assert.match(flag.message, /^2 criteria/);
    // No dropped specialist criteria: no flag.
    const none = mergeAssessments([{ chunk: CHUNK, assessment: assessChunkOutput(answer({ criteria: [judgement(FEE_LINE)] }), CHUNK, INDEX, BASE, DEFAULT_SEVERITY_LEVELS, scopeOf("primary")) }]);
    assert.equal(none.flags.some((f) => f.code === "specialist_criteria_dropped"), false);
  });
});

describe("combined sub-conditions", () => {
  const flagsFor = (criteria: RawCriterion[], text = TEXT) => {
    const doc = snap(text);
    const out = assessChunkOutput(answer({ criteria }), { sourceId: doc.sourceId, chunkIndex: 0 }, new SnapshotQuoteIndex(doc), { ...BASE, contentHash: doc.contentHash }, DEFAULT_SEVERITY_LEVELS, null);
    return mergeAssessments([{ chunk: { sourceId: doc.sourceId, chunkIndex: 0 }, assessment: out }]).flags.filter((f) => f.code === "combined_sub_conditions");
  };

  test("one criterion per sub-condition: no flag, and each carries its own derived reference", () => {
    const flags = flagsFor([
      judgement("(a) must have a genuine relationship with the applicant; and", { ref: "a", title: "A", applicability: "conditional", applicabilityCondition: LEAD_IN }),
      judgement("(b) must not be in breach of the rules; and", { ref: "b", title: "B", applicability: "conditional", applicabilityCondition: LEAD_IN }),
    ]);
    assert.deepEqual(flags, []);
    const out = assessChunkOutput(answer({ criteria: [judgement("(b) must not be in breach of the rules; and", { applicability: "conditional", applicabilityCondition: LEAD_IN })] }), CHUNK, INDEX, BASE, DEFAULT_SEVERITY_LEVELS, null);
    assert.equal(out.criteria[0].criterion.ruleRef, "Z 1.2(b)");
  });

  test("a quote spanning two markers of one level is flagged", () => {
    const text = ["Z 2.1. The third party:", "(a) must be genuine; and (b) must be lawful; and (c) must support the applicant."].join("\n");
    const flags = flagsFor([judgement("(a) must be genuine; and (b) must be lawful; and (c) must support the applicant.", { ref: "x", title: "Combined" })], text);
    assert.equal(flags.length, 1);
  });

  test("a quote that is only the lead-in of a list is flagged", () => {
    const flags = flagsFor([judgement("Z 1.2. If a third party pays for the stay, the third party:", { ref: "x", title: "Lead-in only" })]);
    assert.equal(flags.length, 1);
  });

  test("a bracketed letter in running text is a cross-reference, not a second marker", () => {
    const text = "Z 3.1. The applicant must meet paragraph (a) and paragraph (b) of the annex in full.";
    assert.deepEqual(flagsFor([judgement("The applicant must meet paragraph (a) and paragraph (b) of the annex in full.", { ref: "x", title: "Cross refs" })], text), []);
  });
});

describe("the absence rule", () => {
  test("a statement about how to treat a missing history is an ordinary criterion", () => {
    const r = assess(judgement("A person with no earlier refusals is treated in the same way as any other applicant."), scopeOf("route_guidance"));
    assert.ok(r.accepted);
  });
});
