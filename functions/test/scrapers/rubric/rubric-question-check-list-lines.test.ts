// ============================================
// (#461) The wording check is shown a linked rule's LIST LINES
// ============================================
//
// `buildCheckItems` shows each question the official words of its linked rules. A rule that
// introduces a list (`source.listItems`, read from the snapshot by code, #222) is now shown as
// its quote followed by its stored list lines, exactly as stored, in stored order, one per
// line: those lines are what applicants see under the rule. These tests pin:
//   - a rule with list lines: quote + lines; a rule without (absent or EMPTY list): exactly as before;
//   - the 3-quote and the MAX_FIELD_CHARS cuts still apply, `[shortened]` as before, and the
//     number of shortened quotes is reported;
//   - document items are unchanged;
//   - the prompt version moved, and a question linked only to rules without lists keeps its payload;
//   - on a fixture shaped like the shared rulebook's version 2 (some list rules served, one list
//     rule left out by the review), exactly the questions linked to a SERVED list rule change.
// Pure: no provider, no network.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { AssessmentCriterion, EvidenceItem, IntakeQuestion, VisaRubric } from "../../../src/types/rubric";
import { DEFAULT_QUESTION_CHECK_LIMITS, MAX_FIELD_CHARS, MAX_QUOTES_PER_QUESTION, QUESTION_CHECK_PROMPT_VERSION, batchItems, buildCheckItems, questionQuoteOf } from "../../../src/scrapers/rubric/rubric-question-check";
import { applyExclusions } from "../../../src/scrapers/rubric/rubric-exclusions";

/* eslint-disable @typescript-eslint/no-explicit-any */

// ---- fixtures (made up; no real rulebook words) ----
const HASH = "e".repeat(64);
function rule(id: string, listItems?: string[], quote = `Official sentence for ${id}:`): AssessmentCriterion {
  return {
    criterionId: id,
    title: `Rule ${id}`,
    kind: "judgement",
    stage: "eligibility",
    severity: "high",
    confidence: 0.9,
    probeFactors: ["a factor"],
    requiresInterviewBeforeRefusal: false,
    source: { quote, sourceId: "src-a", url: "https://example.test/a", contentHash: HASH, retrievedAt: "2026-11-12T00:00:00.000Z", ...(listItems !== undefined ? { listItems } : {}) },
  } as AssessmentCriterion;
}
const question = (id: string, criterionIds: string[]): IntakeQuestion => ({ id, label: `Question ${id}?`, answerType: "yes_no", required: true, criterionIds });
const doc = (key: string, criterionIds: string[], quote: string): EvidenceItem => ({ key, title: `Document ${key}`, party: "applicant", criterionIds, source: { ...rule("x").source, quote } });
const view = (criteria: AssessmentCriterion[], intakeQuestions: IntakeQuestion[], evidenceItems: EvidenceItem[] = []) => ({ criteria, intakeQuestions, evidenceItems });
const quotesOf = (items: ReturnType<typeof buildCheckItems>["questions"], id: string): string[] => (items.find((i) => i.realId === id)?.payload as any).quotes;

/**
 * The payload `buildCheckItems` built BEFORE #461 for a plain yes/no question (no help, no options, no party):
 * the question, its answer type and the bare quotes. Written out here so the "unchanged" pin does not depend on
 * the code under test.
 */
const payloadBefore461 = (q: IntakeQuestion, quotes: string[]) => ({ question: q.label, answer_type: q.answerType, quotes });

describe("(#461) a linked rule is shown with its list lines", () => {
  test("a rule with list items: its quote, then each stored line exactly, in stored order, one per line", () => {
    const lines = ["(a) the first case;", "(b) the second case, with  two spaces;", "(c) the third case."];
    const { questions } = buildCheckItems(view([rule("c1", lines)], [question("q1", ["c1"])]));
    assert.deepEqual(quotesOf(questions, "q1"), [`Official sentence for c1:\n${lines.join("\n")}`]);
    assert.equal(questionQuoteOf(rule("c1", lines)), ["Official sentence for c1:", ...lines].join("\n"));
  });

  test("a rule without list items, and a rule with an EMPTY list, are shown exactly as before", () => {
    const { questions } = buildCheckItems(view([rule("c1"), rule("c2", [])], [question("q1", ["c1"]), question("q2", ["c2"])]));
    assert.deepEqual(quotesOf(questions, "q1"), ["Official sentence for c1:"]);
    assert.deepEqual(quotesOf(questions, "q2"), ["Official sentence for c2:"]);
  });

  test("still at most 3 quotes, in rulebook order, the list lines going with their own rule", () => {
    const rules = [rule("c1"), rule("c2", ["(i) line"]), rule("c3"), rule("c4", ["(ii) line"])];
    const { questions } = buildCheckItems(view(rules, [question("q1", ["c4", "c3", "c2", "c1"])]));
    assert.equal(MAX_QUOTES_PER_QUESTION, 3);
    assert.deepEqual(quotesOf(questions, "q1"), ["Official sentence for c1:", "Official sentence for c2:\n(i) line", "Official sentence for c3:"]);
  });

  test("a quote whose list lines take it past the cut is shortened and marked as before, and counted", () => {
    // The quote alone is short; with its lines it is longer than MAX_FIELD_CHARS.
    const long = Array.from({ length: 40 }, (_, k) => `(${k + 1}) a case named in a list line of some length here;`);
    const joined = ["Official sentence for c1:", ...long].join("\n");
    assert.ok(joined.length > MAX_FIELD_CHARS);
    const built = buildCheckItems(view([rule("c1", long), rule("c2")], [question("q1", ["c1"]), question("q2", ["c2"])]));
    assert.deepEqual(quotesOf(built.questions, "q1"), [`${joined.slice(0, MAX_FIELD_CHARS)} [shortened]`]);
    assert.deepEqual(quotesOf(built.questions, "q2"), ["Official sentence for c2:"]);
    assert.equal(built.shortenedQuotes, 1);
    // Nothing long: nothing shortened.
    assert.equal(buildCheckItems(view([rule("c1", ["(a) short"])], [question("q1", ["c1"])])).shortenedQuotes, 0);
  });

  test("document items are unchanged: their own quote, never a rule's list lines", () => {
    const { evidence } = buildCheckItems(view([rule("c1", ["(a) line"])], [question("q1", ["c1"])], [doc("d1", ["c1"], "A document sentence.")]));
    assert.deepEqual(evidence[0].payload, { document: "Document d1", whose_document: "applicant", quote: "A document sentence." });
  });
});

describe("(#461) the prompt version moved; questions without list rules keep their payload", () => {
  test("QUESTION_CHECK_PROMPT_VERSION is bumped", () => {
    assert.notEqual(QUESTION_CHECK_PROMPT_VERSION, "question-check-2026-11-14.1");
    assert.equal(QUESTION_CHECK_PROMPT_VERSION, "question-check-2026-11-22.1");
  });

  test("a question linked only to rules without list items: the same payload as before", () => {
    const q = question("q1", ["c1", "c2"]);
    const { questions } = buildCheckItems(view([rule("c1"), rule("c2", []), rule("c3", ["(a) line"])], [q]));
    assert.deepEqual(questions[0].payload, payloadBefore461(q, ["Official sentence for c1:", "Official sentence for c2:"]));
  });
});

describe("(#461) on a fixture shaped like version 2, only questions of served list rules change", () => {
  // 10 rules; list rules l1..l3 served, l4 a list rule the review left out (so not served); plain rules p1..p6.
  // Questions: some read a served list rule (directly or among others), one reads only l4 (dropped with it),
  // some read only plain rules. Document items read rules of both kinds.
  const rules = [rule("p1"), rule("l1", ["(a) one", "(b) two"]), rule("p2"), rule("l2", ["(i) first"]), rule("p3"), rule("l3", ["- alpha", "- beta", "- gamma"]), rule("p4"), rule("l4", ["(x) left out"]), rule("p5"), rule("p6")];
  const qs = [
    question("travel_kind", ["l1"]),
    question("who", ["p1", "l2"]),
    question("dates", ["p2"]),
    question("only_left_out", ["l4"]),
    question("mixed_left_out", ["p3", "l4"]),
    question("third", ["p4", "p5", "l3"]),
    question("fourth_quote", ["p1", "p2", "p3", "l3"]),
    question("plain", ["p5", "p6"]),
  ];
  const docs = [doc("d1", ["l1"], "Document sentence one."), doc("d2", ["p2"], "Document sentence two.")];
  const v2Shaped = { criteria: rules, intakeQuestions: qs, evidenceItems: docs, excludedCriterionIds: ["l4"] } as unknown as VisaRubric;

  test("the changed payloads are exactly those of questions linked to a served rule with list lines", () => {
    const served = applyExclusions({ ...v2Shaped, questionPlan: undefined } as any);
    const now = buildCheckItems(served);
    // The same served view with every list removed: what the check was shown before #461.
    const bare = { ...served, criteria: served.criteria.map((c: AssessmentCriterion) => ({ ...c, source: { ...c.source, listItems: undefined } })) };
    const before = buildCheckItems(bare);
    const changed = now.questions.filter((it, i) => JSON.stringify(it.payload) !== JSON.stringify(before.questions[i].payload)).map((it) => it.realId);
    // `fourth_quote` reads l3 as its 4th rule: the cut at 3 quotes means it is not shown, so its payload is unchanged.
    assert.deepEqual(changed, ["travel_kind", "who", "third"]);
    // Expected from the rule links alone: questions whose FIRST 3 linked rules (in rubric order) include a served list rule.
    const servedList = new Set(served.criteria.filter((c: AssessmentCriterion) => (c.source.listItems?.length ?? 0) > 0).map((c: AssessmentCriterion) => c.criterionId));
    assert.deepEqual([...servedList], ["l1", "l2", "l3"]);
    assert.deepEqual(JSON.stringify(now.evidence), JSON.stringify(before.evidence), "document items do not change");
    // Batching runs on the new payloads as before.
    assert.ok(batchItems(now.questions, DEFAULT_QUESTION_CHECK_LIMITS).length >= 1);
    assert.equal(now.shortenedQuotes, 0);
  });
});
