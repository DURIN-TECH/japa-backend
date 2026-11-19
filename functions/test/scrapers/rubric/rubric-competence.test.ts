// ============================================
// Which country do I apply through (issue #235, P6 of #228): the pure parts
// ============================================
//
// No Firestore, no model, no network. Covers:
//  - `resolveCompetence` on fixture rulebooks: one destination, several with
//    a main destination, several with none (falls to the next step), an answer
//    naming a non-member, a member that left on a stated date, no rule at all,
//    and "ask" when an answer is missing (never inferred from other answers);
//  - the code check of a block (`competenceProblems`): quote, wording, question;
//  - the validator: destination questions store no country, no block on a
//    country's own rulebook;
//  - the read side (`applyExclusions`): a block whose rule is left out is not served;
//  - drafting (`mergeAssessments`): the block is built from the rule's quote,
//    one bad step drops the whole block, typed-in country options are dropped;
//  - the stack merge: a shared layer's block is scoped and served;
//  - the prompt: version moved, no country / bloc named.
// Every code, id and sentence is made up.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { resolveCompetence, competenceQuestions, COMPETENCE_MESSAGES } from "../../../src/services/competence.service";
import { competenceProblems, servableCompetence, storedCountryOptions } from "../../../src/scrapers/rubric/rubric-competence";
import { validateVisaRubric } from "../../../src/scrapers/rubric/rubric-validate";
import { applyExclusions } from "../../../src/scrapers/rubric/rubric-exclusions";
import { mergeRulebookStack, scopedId } from "../../../src/scrapers/rubric/rubric-stack";
import { assessChunkOutput, mergeAssessments } from "../../../src/scrapers/rubric/rubric-extraction.service";
import { RUBRIC_INTAKE_SYSTEM_PROMPT, RUBRIC_PROMPT_VERSION, RUBRIC_REPAIR_PROMPT_VERSION, buildIntakeOutputSchema, parseRubricOutput } from "../../../src/scrapers/rubric/rubric-prompt";
import { CHECKER_PROMPT_VERSION } from "../../../src/scrapers/rubric/rubric-checker-prompt";
import { SnapshotQuoteIndex } from "../../../src/scrapers/rubric/rubric-quote";
import { membersOn } from "../../../src/authorities/authority-ids";
import { DEFAULT_SEVERITY_LEVELS, type AssessmentCriterion, type CompetenceBlock, type IntakeQuestion, type VisaRubric } from "../../../src/types/rubric";
import type { GuidanceSnapshotContent } from "../../../src/scrapers/guidance/types";
import { answer, crit } from "./rubric-harness";

/* eslint-disable @typescript-eslint/no-explicit-any */

// ============================================
// Fixture rulebook (a made-up shared layer)
// ============================================

const URL = "https://rules.example.org/shared-route";
// One made-up paragraph stating three cases, in order.
const QUOTE = "The country competent to examine an application shall be the country that is the sole destination of the visit; where the visit includes more than one destination, the country that is the main destination in terms of the length or purpose of stay; or where no main destination can be determined, the country whose border the applicant intends to cross first.";

const RULE: AssessmentCriterion = {
  criterionId: "rule-competent",
  title: "Which country examines the application",
  kind: "judgement",
  stage: "validity",
  severity: "high",
  source: { quote: QUOTE, sourceId: "src-1", url: URL, contentHash: "a".repeat(64), retrievedAt: "2026-11-01T00:00:00.000Z" },
  probeFactors: ["the applicant's own account of the trip"],
  requiresInterviewBeforeRefusal: false,
  concernsIntent: false,
  confidence: 0.9,
  intakeQuestionIds: ["q-visit", "q-basis", "q-main", "q-border"],
} as AssessmentCriterion;

const QUESTIONS: IntakeQuestion[] = [
  { id: "q-visit", label: "Which countries on this route will you visit?", answerType: "multi_choice", required: true, criterionIds: ["rule-competent"], optionsFrom: "route_destinations" },
  // F1: the guidance allows "length OR purpose": the applicant says which applies.
  { id: "q-basis", label: "Is your main destination the country where you stay longest, or the one that is the main purpose of your trip?", answerType: "single_choice", required: true, criterionIds: ["rule-competent"], options: [{ value: "length", label: "Where I stay longest" }, { value: "purpose", label: "The main purpose of my trip" }, { value: "neither", label: "I can't say" }] },
  { id: "q-main", label: "Which country is your main destination, on the basis you chose?", answerType: "single_choice", required: true, criterionIds: ["rule-competent"], optionsFrom: "route_destinations", options: [{ value: "cannot_say", label: "I can't say" }] },
  { id: "q-border", label: "Which country's border will you cross first?", answerType: "single_choice", required: true, criterionIds: ["rule-competent"], optionsFrom: "route_destinations" },
];

const BLOCK: CompetenceBlock = {
  steps: [
    { criterionId: "rule-competent", questionId: "q-visit", resultFrom: "answer", restsOn: "sole destination", source: RULE.source },
    { criterionId: "rule-competent", questionId: "q-main", when: [{ questionId: "q-basis", op: "in", value: ["length", "purpose"] }], resultFrom: "answer", restsOn: "main destination in terms of the length or purpose of stay", source: RULE.source },
    { criterionId: "rule-competent", questionId: "q-border", resultFrom: "answer", restsOn: "intends to cross first", source: RULE.source },
  ],
};

/** A shared layer version with the block (bloc id and route id made up). */
function sharedRubric(over: Partial<VisaRubric> = {}): VisaRubric {
  return {
    schemaVersion: 1,
    routeKey: "test-bloc_route-one",
    authorityId: "test-bloc",
    routeSlug: "route-one",
    version: 3,
    reviewStatus: "approved",
    intentPolarity: "not_assessed",
    reviewedBy: "auto",
    reviewedAt: { toMillis: () => 0 } as any,
    rejectReason: null,
    revision: 1,
    supersededAt: null,
    intentPolarityProposal: null,
    severityLevels: [...DEFAULT_SEVERITY_LEVELS],
    criteria: [RULE],
    intakeQuestions: QUESTIONS,
    evidenceItems: [],
    competence: BLOCK,
    sourceSnapshots: [],
    sourceSetHash: "s",
    extractorModel: "m",
    extractorPromptVersion: RUBRIC_PROMPT_VERSION,
    extractionRunId: "r",
    discardedCount: 0,
    discarded: [],
    suspiciousPassages: [],
    flags: [],
    createdAt: { toMillis: () => 0 } as any,
    ...over,
  } as VisaRubric;
}

const MEMBERS = ["XA", "XB", "XC"];
const stack = (destinations: string[] = MEMBERS, competence: CompetenceBlock | undefined = BLOCK) => ({ competence, destinations });

// ============================================
// resolveCompetence
// ============================================

describe("resolveCompetence (fixture rulebooks)", () => {
  test("one destination: that country, from step 1, with its quote and URL", () => {
    const r = resolveCompetence(stack(), { "q-visit": ["XB"] });
    assert.deepEqual(r, { status: "country", countryCode: "XB", stepIndex: 0, restsOn: "sole destination", quote: QUOTE, url: URL });
  });

  test("several destinations, the applicant names the main one (longest stay): step 2", () => {
    const r = resolveCompetence(stack(), { "q-visit": ["XA", "XB"], "q-basis": "length", "q-main": "XA" });
    assert.equal(r.status, "country");
    assert.equal((r as any).countryCode, "XA");
    assert.equal((r as any).stepIndex, 1);
  });

  test("several destinations, main destination by PURPOSE: the same step, the applicant's own basis", () => {
    const r = resolveCompetence(stack(), { "q-visit": ["XA", "XB"], "q-basis": "purpose", "q-main": "XB" });
    assert.equal((r as any).countryCode, "XB");
  });

  test("several destinations and no main destination: the border step decides", () => {
    for (const answers of [
      { "q-visit": ["XA", "XB"], "q-basis": "neither", "q-border": "XC" },
      { "q-visit": ["XA", "XB"], "q-basis": "length", "q-main": "cannot_say", "q-border": "XC" },
    ]) {
      const r = resolveCompetence(stack(), answers);
      assert.equal((r as any).countryCode, "XC");
      assert.equal((r as any).stepIndex, 2);
      assert.equal((r as any).restsOn, "intends to cross first");
    }
  });

  test("an answer that names a non-member: unknown, never another country", () => {
    const r = resolveCompetence(stack(), { "q-visit": ["XZ"] });
    assert.deepEqual(r, { status: "unknown", reason: "NOT_A_MEMBER", why: COMPETENCE_MESSAGES.notMember("XZ"), countryCode: "XZ" });
  });

  test("a member that left on a stated date is not a member today: unknown", () => {
    const today = "2026-11-14";
    const members = membersOn(
      [
        { countryCode: "XA", joinedOn: "2020-01-01" },
        { countryCode: "XB", joinedOn: "2020-01-01", leftOn: "2026-06-01" },
      ],
      today
    ).map((m) => m.countryCode);
    assert.deepEqual(members, ["XA"]);
    const r = resolveCompetence(stack(members), { "q-visit": ["XB"] });
    assert.equal(r.status, "unknown");
    assert.equal((r as any).reason, "NOT_A_MEMBER");
    // The day before it left, it decides.
    const before = membersOn([{ countryCode: "XB", joinedOn: "2020-01-01", leftOn: "2026-06-01" }], "2026-05-31").map((m) => m.countryCode);
    assert.equal((resolveCompetence(stack(before), { "q-visit": ["XB"] }) as any).countryCode, "XB");
  });

  test("no competence rule: unknown NO_COMPETENCE_RULE (the applicant picks, nothing guessed)", () => {
    const r = resolveCompetence({ destinations: MEMBERS }, { "q-visit": ["XA"] });
    assert.deepEqual(r, { status: "unknown", reason: "NO_COMPETENCE_RULE", why: COMPETENCE_MESSAGES.noRule });
  });

  test("a missing answer is asked for, in step order; other answers never stand in for it", () => {
    assert.deepEqual(resolveCompetence(stack(), {}), { status: "ask", questionId: "q-visit" });
    // Several countries: the step's condition question comes next.
    assert.deepEqual(resolveCompetence(stack(), { "q-visit": ["XA", "XB"] }), { status: "ask", questionId: "q-basis" });
    // F1: stay dates or any other answer never decide the main destination: it is asked.
    assert.deepEqual(resolveCompetence(stack(), { "q-visit": ["XA", "XB"], "q-basis": "length", "q-stay-XA": { from: "2027-01-01", to: "2027-01-20" } }), { status: "ask", questionId: "q-main" });
  });

  test("no step decides: unknown NO_STEP_APPLIES", () => {
    const twoSteps: CompetenceBlock = { steps: BLOCK.steps.slice(0, 1) };
    const r = resolveCompetence(stack(MEMBERS, twoSteps), { "q-visit": ["XA", "XB"] });
    assert.equal((r as any).reason, "NO_STEP_APPLIES");
  });

  test("the facts argument never changes the result", () => {
    const facts: any = { nationalities: { status: "stated", codes: ["XC"] }, takenAt: null };
    assert.deepEqual(resolveCompetence(stack(), { "q-visit": ["XA"] }, facts), resolveCompetence(stack(), { "q-visit": ["XA"] }));
  });

  test("competenceQuestions lists the steps' questions and their conditions, in rulebook order", () => {
    const extra: IntakeQuestion = { id: "q-other", label: "Other", answerType: "yes_no", required: false, criterionIds: ["rule-competent"] };
    assert.deepEqual(competenceQuestions(BLOCK, [...QUESTIONS, extra]).map((q) => q.id), ["q-visit", "q-basis", "q-main", "q-border"]);
    assert.deepEqual(competenceQuestions(undefined, QUESTIONS), []);
  });
});

// ============================================
// The code check of a block
// ============================================

describe("competenceProblems", () => {
  const rub = (block: CompetenceBlock, questions = QUESTIONS) => ({ competence: block, criteria: [RULE], intakeQuestions: questions });
  const codes = (block: CompetenceBlock, questions = QUESTIONS) => competenceProblems(rub(block, questions)).map((p) => p.code);

  test("the fixture block passes", () => {
    assert.deepEqual(codes(BLOCK), []);
    assert.equal(servableCompetence(rub(BLOCK)), BLOCK);
  });

  test("wording not in the quote, a different quote, an unknown rule: refused", () => {
    const step0 = BLOCK.steps[0];
    assert.deepEqual(codes({ steps: [{ ...step0, restsOn: "only destination" }] }), ["competence_rests_on_not_in_quote"]);
    assert.deepEqual(codes({ steps: [{ ...step0, source: { ...step0.source, quote: "Another sentence." } }] }), ["competence_source_mismatch"]);
    assert.deepEqual(codes({ steps: [{ ...step0, source: { ...step0.source, url: "https://other.example.org/" } }] }), ["competence_source_mismatch"]);
    assert.deepEqual(codes({ steps: [{ ...step0, criterionId: "nope" }] }), ["competence_rule_unknown"]);
  });

  test("the question must list the route's member countries; the result comes from the answer", () => {
    const step0 = BLOCK.steps[0];
    assert.deepEqual(codes({ steps: [{ ...step0, questionId: "q-basis" }] }), ["competence_question_not_destinations"]);
    assert.deepEqual(codes({ steps: [{ ...step0, questionId: "q-none" }] }), ["competence_question_unknown"]);
    assert.deepEqual(codes({ steps: [{ ...step0, resultFrom: "dates" as any }] }), ["competence_result_from_invalid"]);
    assert.deepEqual(codes({ steps: [{ ...step0, when: [{ questionId: "q-none", op: "eq", value: "x" }] }] }), ["competence_condition_invalid"]);
    assert.deepEqual(codes({ steps: [] }), ["competence_empty"]);
  });

  test("a block on a country's own rulebook is refused", () => {
    assert.deepEqual(competenceProblems(rub(BLOCK), { sharedRulebook: false }).map((p) => p.code), ["competence_not_shared"]);
  });

  test("a destination question stores no country option", () => {
    assert.deepEqual(storedCountryOptions({ optionsFrom: "route_destinations", options: [{ value: "XA", label: "A" }, { value: "cannot_say", label: "No" }] }), ["XA"]);
    assert.deepEqual(storedCountryOptions({ options: [{ value: "XA", label: "A" }] }), []);
  });
});

// ============================================
// Validator and read side
// ============================================

describe("validator and read side", () => {
  test("the fixture shared rulebook validates; a destination question needs no stored options", () => {
    assert.deepEqual(validateVisaRubric(sharedRubric()).errors, []);
  });

  test("a country option stored on a destination question is an error", () => {
    const qs = QUESTIONS.map((q) => (q.id === "q-border" ? { ...q, options: [{ value: "XA", label: "Country XA" }] } : q));
    assert.ok(validateVisaRubric(sharedRubric({ intakeQuestions: qs })).errors.some((e) => e.code === "intake_options_from_country_stored"));
  });

  test("a competence block on a country's own rulebook is an error", () => {
    const own = sharedRubric({ routeKey: "XA_xa-visit", authorityId: "XA", routeSlug: "xa-visit", countryCode: "XA", visaTypeId: "xa-visit" });
    assert.ok(validateVisaRubric(own).errors.some((e) => e.code === "competence_not_shared"));
  });

  test("a damaged block is an error naming the step", () => {
    const bad = sharedRubric({ competence: { steps: [{ ...BLOCK.steps[0], restsOn: "not there" }] } });
    const e = validateVisaRubric(bad).errors.find((x) => x.code === "competence_rests_on_not_in_quote");
    assert.equal(e?.target, "competence.steps[0]");
  });

  test("served as stored while sound; a rubric without a block reads exactly as before", () => {
    const r = sharedRubric();
    assert.equal(applyExclusions(r).competence, BLOCK);
    const plain = sharedRubric({ competence: undefined });
    assert.equal(applyExclusions(plain), plain);
  });

  test("when the rule a step rests on is left out, the WHOLE block is not served", () => {
    const other: AssessmentCriterion = { ...RULE, criterionId: "rule-other", title: "Other", source: { ...RULE.source, quote: "Another rule." }, intakeQuestionIds: [] } as AssessmentCriterion;
    const r = sharedRubric({ criteria: [RULE, other], intakeQuestions: QUESTIONS.map((q) => ({ ...q, criterionIds: ["rule-competent", "rule-other"] })), excludedCriterionIds: ["rule-competent"] });
    const served = applyExclusions(r);
    assert.equal(served.competence, undefined);
    assert.equal(served.criteria.some((c) => c.criterionId === "rule-competent"), false);
  });
});

// ============================================
// Stack merge
// ============================================

describe("stack merge", () => {
  test("the shared layer's block is served on the stack, scoped like its questions", () => {
    const shared = sharedRubric();
    const own = sharedRubric({ routeKey: "XA_xa-visit", authorityId: "XA", routeSlug: "xa-visit", countryCode: "XA", visaTypeId: "xa-visit", competence: undefined, criteria: [], intakeQuestions: [] });
    const merged = mergeRulebookStack([
      { layer: { authorityId: "test-bloc", rulebookKey: "test-bloc_route-one", role: "shared" }, rubric: shared },
      { layer: { authorityId: "XA", rulebookKey: "XA_xa-visit", role: "own" }, rubric: own },
    ]) as VisaRubric;
    const steps = merged.competence?.steps ?? [];
    assert.equal(steps.length, 3);
    assert.equal(steps[0].questionId, scopedId("test-bloc_route-one", "q-visit"));
    assert.equal(steps[1].when?.[0].questionId, scopedId("test-bloc_route-one", "q-basis"));
    assert.equal(steps[0].criterionId, scopedId("test-bloc_route-one", "rule-competent"));
    assert.equal(steps[0].source.quote, QUOTE);
    // Still sound against the merged view.
    assert.deepEqual(competenceProblems(merged), []);
  });

  test("a single-layer read is the rulebook itself (block included)", () => {
    const shared = sharedRubric();
    assert.equal(mergeRulebookStack([{ layer: { authorityId: "test-bloc", rulebookKey: "test-bloc_route-one", role: "shared" }, rubric: shared }]), shared);
  });
});

// ============================================
// Drafting
// ============================================

describe("drafting (mergeAssessments)", () => {
  const doc: GuidanceSnapshotContent = {
    schemaVersion: 1,
    sourceId: "src-1",
    contentHash: createHash("sha256").update(QUOTE).digest("hex"),
    docType: "html",
    url: URL,
    finalUrl: URL,
    fetchedAt: "2026-11-01T00:00:00.000Z",
    text: QUOTE,
    pages: null,
  };
  const base = { sourceId: doc.sourceId, url: doc.url, contentHash: doc.contentHash, retrievedAt: doc.fetchedAt };
  const q = (id: string, fields: Record<string, unknown> = {}) => ({ id, label: `Question ${id}`, helpText: null, answerType: "single_choice", required: true, criterionRefs: ["c1"], group: null, party: null, options: [], textMaxLength: null, dateRelativeToToday: null, showWhenAnyOf: [], optionsFrom: "route_destinations" as const, ...fields });
  const run = (steps: any[], questions = [q("visit", { answerType: "multi_choice" }), q("border")]) => {
    const crit1 = crit({ ref: "c1", title: "Which country examines the application", kind: "judgement", stage: "validity", quote: QUOTE, probeFactors: ["the countries the applicant will visit"], requiresInterviewBeforeRefusal: false });
    const criteriaPart = assessChunkOutput(answer({ criteria: [crit1] }), { sourceId: "src-1", chunkIndex: 0 }, new SnapshotQuoteIndex(doc), base, DEFAULT_SEVERITY_LEVELS);
    const intakePart = assessChunkOutput(answer({ intakeQuestions: questions as any, competenceSteps: steps }), { sourceId: "src-1", chunkIndex: 0 }, new SnapshotQuoteIndex(doc), base, DEFAULT_SEVERITY_LEVELS);
    const m = mergeAssessments([{ chunk: { sourceId: "src-1", chunkIndex: 0 }, assessment: { ...intakePart, criteria: criteriaPart.criteria } }]);
    return m;
  };

  test("the block is built from the rule's own quote and URL, in the excerpt's order", () => {
    const merged = run([
      { criterionRef: "c1", restsOn: "sole destination", questionId: "visit", whenAllOf: [] },
      { criterionRef: "c1", restsOn: "intends to cross first", questionId: "border", whenAllOf: [] },
    ]);
    const steps = merged.competence?.steps ?? [];
    assert.deepEqual(steps.map((s) => [s.questionId, s.restsOn, s.resultFrom]), [["visit", "sole destination", "answer"], ["border", "intends to cross first", "answer"]]);
    assert.equal(steps[0].source.quote, QUOTE);
    assert.equal(steps[0].source.url, URL);
    assert.equal(steps[0].criterionId, merged.criteria[0].criterionId);
    // The destination questions kept no options and are linked to the rule.
    const visit = merged.intakeQuestions.find((x) => x.id === "visit") as IntakeQuestion;
    assert.equal(visit.optionsFrom, "route_destinations");
    assert.equal(visit.options, undefined);
    assert.deepEqual(merged.flags.filter((f) => f.code.startsWith("competence")), []);
  });

  test("one step whose wording is not in the quote drops the WHOLE block, with a flag", () => {
    const merged = run([
      { criterionRef: "c1", restsOn: "sole destination", questionId: "visit", whenAllOf: [] },
      { criterionRef: "c1", restsOn: "first port of entry", questionId: "border", whenAllOf: [] },
    ]);
    assert.equal(merged.competence, undefined);
    assert.ok(merged.flags.some((f) => f.code === "competence_dropped"));
  });

  test("a step on a question that does not list member countries drops the block", () => {
    const merged = run([{ criterionRef: "c1", restsOn: "sole destination", questionId: "visit", whenAllOf: [] }], [q("visit", { optionsFrom: null, options: [{ value: "a", label: "A", description: null }] })]);
    assert.equal(merged.competence, undefined);
  });

  test("country options typed into a destination question are dropped and flagged", () => {
    const merged = run([], [q("visit", { options: [{ value: "XA", label: "Country XA", description: null }, { value: "cannot_say", label: "I can't say", description: null }] })]);
    const visit = merged.intakeQuestions.find((x) => x.id === "visit") as IntakeQuestion;
    assert.deepEqual(visit.options?.map((o) => o.value), ["cannot_say"]);
    assert.ok(merged.flags.some((f) => f.code === "destination_country_options_dropped"));
  });

  test("no steps proposed: no block, no flag (every rulebook before #235)", () => {
    const merged = run([]);
    assert.equal(merged.competence, undefined);
    assert.equal(merged.flags.some((f) => f.code === "competence_dropped"), false);
  });
});

// ============================================
// Prompt
// ============================================

describe("prompt", () => {
  test("versions: drafting moved to v12; re-draft and check unchanged", () => {
    assert.equal(RUBRIC_PROMPT_VERSION, "2026-11-rubric-v12");
    assert.equal(RUBRIC_REPAIR_PROMPT_VERSION, "2026-11-repair-v5");
    assert.equal(CHECKER_PROMPT_VERSION, "2026-11-checker-v7");
  });

  test("the intake prompt asks for steps only when the excerpt states them, and never for a basis the applicant must give", () => {
    assert.ok(RUBRIC_INTAKE_SYSTEM_PROMPT.includes("only when the excerpt itself states which member country is responsible"));
    assert.ok(RUBRIC_INTAKE_SYSTEM_PROMPT.includes("never choose a basis for them"));
    assert.ok(RUBRIC_INTAKE_SYSTEM_PROMPT.includes("list NO country among its options"));
    for (const w of ["Schengen", "European", "EU", "Union", "Member State"]) assert.ok(!new RegExp(`\\b${w}\\b`).test(RUBRIC_INTAKE_SYSTEM_PROMPT), `names ${w}`);
  });

  test("an intake answer without competenceSteps (every recording before v12) parses exactly as before", () => {
    const out = parseRubricOutput(JSON.stringify({ intakeQuestions: [], evidenceItems: [], ruleTriggers: [], suspiciousPassages: [] }), buildIntakeOutputSchema());
    assert.equal("competenceSteps" in out, false);
  });
});
