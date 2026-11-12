// ============================================
// Rubric structural validator (issue #40) — unit tests, pure
// ============================================
//
// The rubrics here are TEST DATA built by hand for invented routes in
// invented jurisdictions (user-assigned country codes). Two of them carry
// opposite intent polarity, each citing its (invented) rule reference: they
// are the fixtures the assessment engine's polarity regression test (#42)
// can reuse. None is, or stands in for, an approved production rubric.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { Timestamp } from "firebase-admin/firestore";
import { validateCriterionShape, validateVisaRubric } from "../../../src/scrapers/rubric/rubric-validate";
import { DEFAULT_SEVERITY_LEVELS, RUBRIC_SCHEMA_VERSION, type AssessmentCriterion, type IntakeQuestion, type VisaRubric } from "../../../src/types/rubric";

const HASH = "a".repeat(64);

/** A citation into an invented document. */
const cite = (quote: string, page?: number) => ({
  quote,
  sourceId: "avalen-short-visit-rules",
  url: "https://rules.avalen-border.example/short-visit",
  contentHash: HASH,
  retrievedAt: "2026-11-11T01:00:00.000Z",
  ...(page !== undefined ? { page } : {}),
});

/** A valid objective criterion. */
const objective = (id = "crit_age"): AssessmentCriterion => ({
  criterionId: id,
  title: "Aged 18 or over",
  kind: "objective",
  stage: "eligibility",
  severity: "high",
  ruleRef: "SV 2.1",
  source: cite("An applicant must be aged 18 or over on the date of application."),
  check: { field: "applicant.age", op: "gte", value: 18 },
  confidence: 0.9,
});

/** A valid judgement criterion about intent. */
const judgement = (id = "crit_leave"): AssessmentCriterion => ({
  criterionId: id,
  title: "Will leave at the end of the visit",
  kind: "judgement",
  stage: "credibility",
  severity: "high",
  ruleRef: "SV 3.1",
  source: cite("The decision maker must be satisfied that the applicant will leave Avalen at the end of the visit."),
  probeFactors: ["ties outside the destination"],
  requiresInterviewBeforeRefusal: false,
  concernsIntent: true,
  confidence: 0.8,
});

/** A valid nationality-scoped mandatory bar with dates. */
const bar = (id = "crit_bar"): AssessmentCriterion => ({
  criterionId: id,
  title: "Nationals refused from a stated date",
  kind: "mandatory_bar",
  stage: "suitability",
  severity: "critical",
  source: cite("An application must be refused where the applicant is a national of Borduria or Syldavia and applies on or after 26 March 2026."),
  appliesTo: { nationalities: ["QM", "QN"], asWritten: ["Borduria", "Syldavia"] },
  validFrom: "2026-03-26",
  confidence: 0.9,
});

/** A valid pending rubric for an invented route. */
function rubric(overrides: Partial<VisaRubric> = {}): VisaRubric {
  return {
    schemaVersion: RUBRIC_SCHEMA_VERSION,
    routeKey: "XA_xa-short-visit",
    countryCode: "XA",
    visaTypeId: "xa-short-visit",
    version: 1,
    reviewStatus: "pending_review",
    intentPolarity: null,
    reviewedBy: null,
    reviewedAt: null,
    rejectReason: null,
    revision: 0,
    supersededAt: null,
    intentPolarityProposal: { value: "immigrant_intent_penalised", source: cite("An intention to remain beyond the visit counts against the applicant.") },
    severityLevels: [...DEFAULT_SEVERITY_LEVELS],
    criteria: [objective(), judgement(), bar()],
    intakeQuestions: [],
    evidenceItems: [],
    sourceSnapshots: [{ sourceId: "avalen-short-visit-rules", contentHash: HASH, url: "https://rules.avalen-border.example/short-visit", docType: "html" }],
    sourceSetHash: HASH,
    extractorModel: "recorded-model",
    extractorPromptVersion: "test",
    extractionRunId: "run-1",
    discardedCount: 0,
    discarded: [],
    suspiciousPassages: [],
    flags: [],
    createdAt: Timestamp.fromMillis(0),
    ...overrides,
  };
}

/** An intake question read by the given criteria. */
const question = (id: string, criterionIds: string[], extra: Partial<IntakeQuestion> = {}): IntakeQuestion => ({ id, label: "A question", answerType: "text", required: true, criterionIds, ...extra });

/** Error codes of a validation, sorted. */
const codes = (r: VisaRubric, opts = {}) => validateVisaRubric(r, opts).errors.map((e) => e.code).sort();

describe("rubric validator: a consistent rubric", () => {
  test("a rubric with one criterion of each kind is valid", () => {
    const v = validateVisaRubric(rubric());
    assert.deepEqual(v.errors, []);
    assert.deepEqual(v.flags, []);
  });

  test("a nationality-scoped bar with dates round-trips through JSON and the validator", () => {
    const stored = JSON.parse(JSON.stringify(rubric({ createdAt: undefined as never })));
    const again = stored.criteria.find((c: AssessmentCriterion) => c.kind === "mandatory_bar");
    assert.deepEqual(again.appliesTo, { nationalities: ["QM", "QN"], asWritten: ["Borduria", "Syldavia"] });
    assert.equal(again.validFrom, "2026-03-26");
    assert.deepEqual(validateVisaRubric(stored).errors, []);
  });
});

describe("rubric validator: kind boundaries", () => {
  test("a judgement criterion that also carries a check is rejected", () => {
    const bad = { ...judgement(), check: { field: "funds.balance", op: "gte" as const, value: 1 } };
    assert.deepEqual(validateCriterionShape(bad, DEFAULT_SEVERITY_LEVELS).map((i) => i.code), ["judgement_has_check"]);
    assert.deepEqual(codes(rubric({ criteria: [bad] })), ["judgement_has_check"]);
  });

  test("an objective criterion with no check, and a mandatory bar with no appliesTo, are rejected", () => {
    const { check: _c, ...noCheck } = objective();
    assert.deepEqual(codes(rubric({ criteria: [noCheck as AssessmentCriterion] })), ["objective_without_check"]);
    const { appliesTo: _a, ...noGroup } = bar();
    assert.deepEqual(codes(rubric({ criteria: [noGroup as AssessmentCriterion] })), ["bar_without_applies_to"]);
  });

  test("a judgement criterion needs probe factors and the interview flag", () => {
    const { probeFactors: _p, requiresInterviewBeforeRefusal: _r, ...bare } = judgement();
    assert.deepEqual(codes(rubric({ criteria: [bare as AssessmentCriterion], intentPolarityProposal: null })), ["interview_flag_missing", "probe_factors_missing"]);
  });

  test("a check needs a field, a known op, and a value unless the op is `present`", () => {
    const withCheck = (check: unknown) => codes(rubric({ criteria: [{ ...objective(), check } as AssessmentCriterion] }));
    assert.deepEqual(withCheck({ field: "x", op: "present" }), []);
    assert.deepEqual(withCheck({ field: "x", op: "gte" }), ["check_value_missing"]);
    assert.deepEqual(withCheck({ field: "", op: "eq", value: 1 }), ["check_field_missing"]);
    assert.deepEqual(withCheck({ field: "x", op: "approximately", value: 1 }), ["check_op_invalid"]);
    assert.deepEqual(withCheck({ field: "x", op: "heldForDays", value: 28 }), ["check_duration_invalid"]);
    assert.deepEqual(withCheck({ field: "x", op: "heldForDays", value: 28, unit: "days" }), []);
  });

  test("severity must be one of the scale the rubric declares", () => {
    assert.deepEqual(codes(rubric({ criteria: [{ ...objective(), severity: "catastrophic" }] })), ["severity_invalid"]);
    // A rubric may declare its own scale.
    assert.deepEqual(codes(rubric({ severityLevels: ["blocker", "minor"], criteria: [{ ...objective(), severity: "blocker" }] })), []);
    assert.deepEqual(codes(rubric({ severityLevels: [] })).includes("severity_levels_invalid"), true);
  });

  test("every criterion must be cited: quote, URL, snapshot hash, retrieval time", () => {
    const c = { ...objective(), source: { quote: " ", sourceId: "", url: "javascript:alert(1)", contentHash: "abc", retrievedAt: "yesterday" } };
    assert.deepEqual(codes(rubric({ criteria: [c] })), ["content_hash_invalid", "quote_empty", "retrieved_at_invalid", "source_id_missing", "source_url_invalid"]);
  });

  test("a title is required (the free tier shows it on its own)", () => {
    assert.deepEqual(codes(rubric({ criteria: [{ ...objective(), title: "" }] })), ["title_missing"]);
  });
});

describe("rubric validator: joins and integrity", () => {
  test("a duplicated criterion id is rejected", () => {
    assert.deepEqual(codes(rubric({ criteria: [objective("same"), judgement("same")] })), ["criterion_id_duplicate"]);
  });

  test("a duplicated intake question id is rejected", () => {
    assert.deepEqual(codes(rubric({ intakeQuestions: [question("q1", ["crit_age"]), question("q1", ["crit_leave"])] })), ["intake_question_id_duplicate"]);
  });

  test("a criterion that reads an intake question that does not exist is rejected", () => {
    const c = { ...objective(), intakeQuestionIds: ["missing_question"] };
    assert.deepEqual(codes(rubric({ criteria: [c] })), ["criterion_intake_unknown"]);
  });

  test("an intake question must name criteria that exist", () => {
    assert.deepEqual(codes(rubric({ intakeQuestions: [question("q1", ["crit_nope"])] })), ["intake_criterion_unknown"]);
    assert.deepEqual(codes(rubric({ intakeQuestions: [question("q1", [])] })), ["intake_without_criteria"]);
  });

  test("intake questions are data: any id, label, type and condition is accepted when the joins hold", () => {
    const qs = [
      question("has_sponsor", ["crit_age"], { answerType: "yes_no", group: "Money" }),
      question("sponsor_full_name", ["crit_age"], { party: "sponsor", textLimits: { maxLength: 120 }, showWhen: { anyOf: [{ questionId: "has_sponsor", op: "eq", value: true }] } }),
      question("purpose", ["crit_leave"], { answerType: "single_choice", options: [{ value: "a", label: "A", description: "First" }, { value: "b", label: "B" }] }),
      question("stay", ["crit_leave"], { answerType: "date_range", dateLimits: { relativeToToday: "future_only" } }),
    ];
    const v = validateVisaRubric(rubric({ intake: { title: "About you", cardTitle: "You", intro: "A few questions." }, intakeQuestions: qs }));
    assert.deepEqual(v.errors, []);
    assert.deepEqual(v.flags, []);
  });

  test("an answer type no client knows yet is flagged, not rejected", () => {
    const v = validateVisaRubric(rubric({ intakeQuestions: [question("q1", ["crit_age"], { answerType: "signature" })] }));
    assert.deepEqual(v.errors, []);
    assert.deepEqual(v.flags.map((f) => f.code), ["intake_answer_type_unknown"]);
  });

  test("a choice question needs options, and a condition must name an existing other question", () => {
    assert.deepEqual(codes(rubric({ intakeQuestions: [question("q1", ["crit_age"], { answerType: "multi_choice" })] })), ["intake_options_missing"]);
    assert.deepEqual(codes(rubric({ intakeQuestions: [question("q1", ["crit_age"], { showWhen: { anyOf: [{ questionId: "q9", op: "eq", value: 1 }] } })] })), ["intake_condition_unknown"]);
    assert.deepEqual(codes(rubric({ intakeQuestions: [question("q1", ["crit_age"], { showWhen: { anyOf: [{ questionId: "q1", op: "eq", value: 1 }] } })] })), ["intake_condition_self"]);
  });

  test("an eligibilityQuestionId must resolve; with no list to check against it is an error, never accepted unchecked", () => {
    const c = { ...objective(), eligibilityQuestionId: "eq-1" };
    assert.deepEqual(codes(rubric({ criteria: [c] })), ["eligibility_question_unverified"]);
    assert.deepEqual(codes(rubric({ criteria: [c] }), { knownEligibilityQuestionIds: new Set(["eq-2"]) }), ["eligibility_question_unknown"]);
    assert.deepEqual(codes(rubric({ criteria: [c] }), { knownEligibilityQuestionIds: new Set(["eq-1"]) }), []);
  });

  test("evidence items: unique keys, existing criteria, a party and a quote", () => {
    const item = (key: string, extra = {}) => ({ key, title: "Bank statements", party: "sponsor" as const, criterionIds: ["crit_age"], source: cite("A sponsor may provide their bank statements."), ...extra });
    assert.deepEqual(codes(rubric({ evidenceItems: [item("bank"), item("payslips", { party: "applicant" })] })), []);
    assert.deepEqual(codes(rubric({ evidenceItems: [item("bank"), item("bank")] })), ["evidence_key_duplicate"]);
    assert.deepEqual(codes(rubric({ evidenceItems: [item("bank", { criterionIds: ["crit_nope"] })] })), ["evidence_criterion_unknown"]);
    assert.deepEqual(codes(rubric({ evidenceItems: [item("bank", { party: "employer" })] })), ["evidence_party_invalid"]);
    assert.deepEqual(codes(rubric({ evidenceItems: [item("bank", { when: { questionId: "q9", op: "eq", value: true } })] })), ["evidence_condition_unknown"]);
  });

  test("an outcome-statistics mapping is optional, and checked when present", () => {
    assert.deepEqual(codes(rubric({ outcomeStatistics: { categoryKey: "all-visit-categories", categoryLabel: "All visit categories", adapterId: "avalen-tables", sourceUrl: "https://stats.avalen.example/tables", note: "Wider than this route." } })), []);
    assert.deepEqual(codes(rubric({ outcomeStatistics: { categoryKey: "", categoryLabel: "" } })), ["outcome_statistics_category_missing"]);
  });

  test("the route key must match the country code and visa type id", () => {
    assert.deepEqual(codes(rubric({ routeKey: "XA_something-else" })), ["route_key_mismatch"]);
  });
});

describe("rubric validator: intent polarity", () => {
  /** The opposite-polarity fixture: an invented study route that allows dual intent. */
  const dualIntent = () =>
    rubric({
      routeKey: "XZ_xz-study-permit",
      countryCode: "XZ",
      visaTypeId: "xz-study-permit",
      intentPolarityProposal: { value: "dual_intent_permitted", source: { ...cite("An applicant may hold an intention to study temporarily and an intention to settle later.", 2), sourceId: "zembla-study-casework" } },
      criteria: [{ ...judgement("crit_ties"), ruleRef: "G 3", title: "Ties, study plan and previous travel" }],
    });

  test("two test-data rubrics carry opposite polarity, each with its cited rule", () => {
    const penalised = rubric();
    const dual = dualIntent();
    assert.equal(penalised.intentPolarityProposal?.value, "immigrant_intent_penalised");
    assert.equal(dual.intentPolarityProposal?.value, "dual_intent_permitted");
    assert.ok(penalised.intentPolarityProposal?.source?.quote);
    assert.ok(dual.intentPolarityProposal?.source?.quote);
    for (const r of [penalised, dual]) {
      const v = validateVisaRubric(r);
      assert.deepEqual(v.errors, []);
      assert.deepEqual(v.flags, []);
    }
  });

  test("criteria about intent with polarity not_assessed (or none) are flagged, not accepted silently", () => {
    for (const proposal of [null, { value: "not_assessed" as const }]) {
      const v = validateVisaRubric(rubric({ intentPolarityProposal: proposal }));
      assert.deepEqual(v.errors, []);
      assert.deepEqual(v.flags.map((f) => f.code), ["intent_criteria_without_polarity"]);
    }
    // A rubric with no intent criteria may leave the polarity unassessed.
    assert.deepEqual(validateVisaRubric(rubric({ intentPolarityProposal: { value: "not_assessed" }, criteria: [objective()] })).flags, []);
  });

  test("the admin's decision wins over the proposal", () => {
    const decided = rubric({ intentPolarityProposal: null, intentPolarity: "dual_intent_permitted" });
    assert.deepEqual(validateVisaRubric(decided).flags, []);
    const undone = rubric({ intentPolarity: "not_assessed" });
    assert.deepEqual(validateVisaRubric(undone).flags.map((f) => f.code), ["intent_criteria_without_polarity"]);
  });

  test("an approved rubric must carry a decided polarity and its reviewer", () => {
    assert.deepEqual(codes(rubric({ reviewStatus: "approved" })), ["approved_without_polarity", "approved_without_reviewer"]);
    assert.deepEqual(codes(rubric({ reviewStatus: "approved", intentPolarity: "immigrant_intent_penalised", reviewedBy: "admin-1", reviewedAt: Timestamp.fromMillis(1), revision: 1 })), []);
  });

  test("an unknown polarity or review status is rejected", () => {
    assert.deepEqual(codes(rubric({ intentPolarity: "sometimes" as never })), ["intent_polarity_invalid"]);
    assert.deepEqual(codes(rubric({ reviewStatus: "published" as never })), ["review_status_invalid"]);
  });
});
