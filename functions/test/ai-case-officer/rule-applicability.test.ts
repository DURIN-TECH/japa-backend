// ============================================
// Specialist and conditional rules are assessed only where they apply (#207)
// ============================================
//
// FICTIONAL rulebooks only: invented rule ids, invented activities, no real
// country, route, nationality or rule. What is checked, per consumer:
//
//   resolver     applies / not applicable / could not tell, from the answers
//   intake       a specialist rule's questions show only after the triggering answer
//   checklist    its documents likewise
//   assessment   not applied when not triggered, applied when triggered,
//                "could not be assessed" when unknown (never a failure)
//   scale        a 500-rule rulebook: nothing truncated, every triggered rule
//                accounted for, spend caps keep failing instead of truncating
//   others       proposed actions, chat prompt, upload-check expectations,
//                the free-tier shape

import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";
import { store } from "../helpers/fake-firestore";
import { rubricStore } from "../../src/scrapers";
import { IntakeService } from "../../src/services/intake.service";
import { buildChecklist } from "../../src/services/ai/checklist-builder";
import { deriveProposedActions } from "../../src/services/ai-action.service";
import { buildChatContext, buildChatUserPrompt } from "../../src/services/ai-chat.service";
import { expectationsFor } from "../../src/services/ai/document-check-engine";
import { serializeFree } from "../../src/services/ai/tier-serializer";
import {
  JUDGEMENT_BATCH_MAX_CRITERIA,
  planJudgementBatches,
} from "../../src/services/ai/assessment-engine";
import {
  couldNotAssessReason,
  effectiveIntakeQuestions,
  isValidTrigger,
  resolveApplicability,
  splitByApplicability,
} from "../../src/services/ai/rule-applicability";
import type { AssessmentCriterion, IntakeQuestion, VisaRubric } from "../../src/types/rubric";
import { ScriptedProvider, criterion, fictionalRubric, installAssessmentFakes, resetAll, rubricBook, seedApplication, seedDocument, seedEligibility, seedStatement, seedUser, serviceWith, storedAssessments } from "./harness";

/* eslint-disable @typescript-eslint/no-explicit-any */

// ----- Fictional fixtures -----

/** The question that establishes the applicant's activity (three fictional activities). */
const ACTIVITY: IntakeQuestion = {
  id: "activity",
  label: "What will you do on your visit?",
  answerType: "single_choice",
  required: true,
  criterionIds: [],
  options: [{ value: "alpha", label: "Alpha work" }, { value: "beta", label: "Beta work" }, { value: "gamma", label: "Gamma work" }],
};
/** A follow-up that only the "alpha" rules read. */
const ALPHA_DETAIL: IntakeQuestion = { id: "alpha-detail", label: "Name of the alpha host", answerType: "text", required: true, criterionIds: ["s-alpha"] };
/** A yes/no question some conditional rule hangs on. */
const PAYER: IntakeQuestion = { id: "third-party", label: "Is someone else paying?", answerType: "yes_no", required: true, criterionIds: [] };

/** A specialist rule triggered by `values` of the activity question. */
const specialist = (id: string, values: string[], over: Partial<AssessmentCriterion> = {}): AssessmentCriterion =>
  criterion({ criterionId: id, title: `Rule ${id}`, kind: "judgement", stage: "eligibility", severity: "medium", probeFactors: ["f"], applicability: "specialist", applicabilityCondition: "for an invented activity", trigger: { questionId: "activity", anyOf: values }, ...over });

/** Intake questions and criteria of the small fixture rubric. */
function smallRubric(): VisaRubric {
  const general = criterion({ criterionId: "g-all", title: "Everyone", kind: "judgement", stage: "eligibility", severity: "high", probeFactors: ["f"], applicability: "all_applicants" });
  const sAlpha = specialist("s-alpha", ["alpha"]);
  const sBeta = specialist("s-beta", ["beta"]);
  const sNone = specialist("s-none", [], { trigger: undefined });
  const cond = criterion({ criterionId: "c-pay", title: "Payer rule", kind: "judgement", stage: "eligibility", severity: "medium", probeFactors: ["f"], applicability: "conditional", applicabilityCondition: "if someone else pays", trigger: { questionId: "third-party", anyOf: ["true"] } });
  const rb = fictionalRubric({ countryCode: "AA", visaTypeId: "route-s", intentPolarity: "dual_intent_permitted", criteria: [general, sAlpha, sBeta, sNone, cond] });
  rb.intakeQuestions = [{ ...ACTIVITY, criterionIds: ["g-all", "s-alpha", "s-beta"] }, ALPHA_DETAIL, PAYER].map((q) => (q.id === "third-party" ? { ...q, criterionIds: ["c-pay"] } : q));
  rb.evidenceItems = [
    { key: "alpha-letter", title: "Alpha letter", party: "applicant", criterionIds: ["s-alpha"], source: { quote: "Quote A.", url: "https://example.test/a", sourceId: "x", contentHash: "h", retrievedAt: "2026-11-01T00:00:00.000Z" } },
    { key: "beta-letter", title: "Beta letter", party: "applicant", criterionIds: ["s-beta"], source: { quote: "Quote B.", url: "https://example.test/b", sourceId: "x", contentHash: "h", retrievedAt: "2026-11-01T00:00:00.000Z" } },
    { key: "general-doc", title: "General document", party: "applicant", criterionIds: ["g-all"], source: { quote: "Quote G.", url: "https://example.test/g", sourceId: "x", contentHash: "h", retrievedAt: "2026-11-01T00:00:00.000Z" } },
  ] as any;
  return rb;
}

// ============================================
// The resolver
// ============================================

describe("resolveApplicability", () => {
  const rb = smallRubric();
  const qs = rb.intakeQuestions;
  const of = (id: string, answers: Record<string, unknown> | null) => resolveApplicability(rb.criteria.find((c) => c.criterionId === id) as AssessmentCriterion, qs, answers);

  test("a specialist rule applies when the answer is one of its trigger values, and not otherwise", () => {
    assert.equal(of("s-alpha", { activity: "alpha" }).status, "applies");
    assert.equal(of("s-alpha", { activity: "beta" }).status, "not_applicable");
    assert.equal(of("s-beta", { activity: "beta" }).status, "applies");
  });

  test("unanswered question: could not tell, naming the question", () => {
    const r = of("s-alpha", {});
    assert.equal(r.status, "unknown");
    assert.equal((r as any).reason, "unanswered");
    assert.equal((r as any).need, ACTIVITY.label);
    assert.equal(of("s-alpha", null).status, "unknown");
    assert.equal(of("s-alpha", { activity: "" }).status, "unknown");
  });

  test("a specialist rule with no valid trigger is could-not-tell, never applies, never dropped", () => {
    assert.equal(of("s-none", { activity: "alpha" }).status, "unknown");
    // Damaged links read as absent: the question is missing, or the value is not one of its options.
    const missingQ = { ...rb.criteria[1], trigger: { questionId: "gone", anyOf: ["alpha"] } } as AssessmentCriterion;
    const badValue = { ...rb.criteria[1], trigger: { questionId: "activity", anyOf: ["delta"] } } as AssessmentCriterion;
    assert.equal(resolveApplicability(missingQ, qs, { activity: "alpha" }).status, "unknown");
    assert.equal(resolveApplicability(badValue, qs, { activity: "alpha" }).status, "unknown");
    assert.equal(isValidTrigger(badValue.trigger, qs), false);
  });

  test("multi-choice answers include, and yes/no answers compare as true / false", () => {
    const multi: IntakeQuestion[] = [{ ...ACTIVITY, answerType: "multi_choice" }];
    const c = specialist("m", ["beta"]);
    assert.equal(resolveApplicability(c, multi, { activity: ["alpha", "beta"] }).status, "applies");
    assert.equal(resolveApplicability(c, multi, { activity: ["alpha"] }).status, "not_applicable");
    assert.equal(of("c-pay", { "third-party": true }).status, "applies");
    assert.equal(of("c-pay", { "third-party": false }).status, "not_applicable");
    assert.equal(of("c-pay", {}).status, "unknown");
  });

  test("conditional rules get the same treatment; one with no trigger keeps applying as before", () => {
    const noTrigger = criterion({ criterionId: "c-old", title: "Old", kind: "judgement", stage: "eligibility", severity: "low", probeFactors: ["f"], applicability: "conditional", applicabilityCondition: "if x" });
    assert.equal(resolveApplicability(noTrigger, qs, {}).status, "applies");
  });

  test("a rule with no applicability, or all_applicants, always applies; the reason text says what is needed", () => {
    assert.equal(of("g-all", {}).status, "applies");
    assert.equal(resolveApplicability(criterion({ criterionId: "legacy", title: "L", kind: "objective", stage: "validity", severity: "low", check: { field: "a.b", op: "present" } }), qs, {}).status, "applies");
    assert.match(couldNotAssessReason({ reason: "unanswered", need: "X" }), /^could not be assessed: we need to know X$/);
  });

  test("every criterion lands in exactly one of the three lists", () => {
    const split = splitByApplicability(rb, { activity: "alpha", "third-party": false });
    assert.equal(split.applicable.length + split.notApplicableIds.length + split.unknown.length, rb.criteria.length);
    assert.deepEqual(split.applicable.map((c) => c.criterionId), ["g-all", "s-alpha"]);
    assert.deepEqual(split.notApplicableIds.sort(), ["c-pay", "s-beta"].sort());
    assert.deepEqual(split.unknown.map((u) => u.criterion.criterionId), ["s-none"]);
    // The payer question unanswered: that rule is could-not-tell, not "not applicable".
    assert.deepEqual(splitByApplicability(rb, { activity: "alpha" }).unknown.map((u) => u.criterion.criterionId).sort(), ["c-pay", "s-none"]);
  });
});

// ============================================
// Intake: questions appear after the triggering answer
// ============================================

describe("intake shows a specialist rule's questions only after the triggering answer", () => {
  const rb = smallRubric();
  const eff = effectiveIntakeQuestions(rb);

  test("the activity question is always asked; the alpha question carries the alpha trigger as its show-when", () => {
    const activity = eff.find((q) => q.id === "activity") as IntakeQuestion;
    assert.equal(activity.showWhen, undefined, "the question that establishes the activity is never hidden by the rules it triggers");
    const detail = eff.find((q) => q.id === "alpha-detail") as IntakeQuestion;
    assert.deepEqual(detail.showWhen, { anyOf: [{ questionId: "activity", op: "in", value: ["alpha"] }] });
  });

  test("a question read only by specialist rules that cannot be assessed is left out", () => {
    const r = smallRubric();
    r.intakeQuestions = [...r.intakeQuestions, { id: "orphan", label: "Orphan?", answerType: "text", required: true, criterionIds: ["s-none"] }];
    assert.equal(effectiveIntakeQuestions(r).some((q) => q.id === "orphan"), false);
  });

  test("through the intake service: required follow-ups open only once the answer triggers them", async () => {
    // (#233) The application carries its stored `routeStack` (every application
    // stores one since #231), so the intake reads its one-layer stack without
    // resolving the visa record live (no Firestore in unit tests).
    const original = rubricStore.getApprovedRubric;
    (rubricStore as any).getApprovedRubric = async () => rb;
    try {
      const svc = new IntakeService();
      const app = (answers: Record<string, unknown>) => ({ id: "app-1", countryCode: "AA", visaTypeId: "route-s", routeStack: ["AA_route-s"], status: "draft", intake: { routeKey: "AA_route-s", rubricVersion: 1, answers, updatedAt: null } }) as any;
      const none = await svc.getIntake(app({}));
      assert.deepEqual(none.openRequiredIds, ["activity", "third-party"], "no follow-up before an activity is chosen");
      const alpha = await svc.getIntake(app({ activity: "alpha" }));
      assert.ok(alpha.openRequiredIds.includes("alpha-detail"));
      const beta = await svc.getIntake(app({ activity: "beta" }));
      assert.equal(beta.openRequiredIds.includes("alpha-detail"), false);
    } finally {
      (rubricStore as any).getApprovedRubric = original;
    }
  });
});

// ============================================
// Checklist
// ============================================

describe("checklist items follow the trigger", () => {
  const rb = smallRubric();
  const titles = (answers: Record<string, unknown> | null) => buildChecklist({ rubric: rb, intakeAnswers: answers }).items.map((i) => i.title);

  test("a specialist rule's document is listed only for an applicant its answer triggers", () => {
    assert.deepEqual(titles({ activity: "alpha" }), ["Alpha letter", "General document"]);
    assert.deepEqual(titles({ activity: "beta" }), ["Beta letter", "General document"]);
    assert.deepEqual(titles({ activity: "gamma" }), ["General document"]);
  });

  test("with the trigger question unanswered the specialist documents wait (could not tell is not asked for)", () => {
    assert.deepEqual(titles({ "third-party": false }), ["General document"]);
  });
});

// ============================================
// Assessment job
// ============================================

/** A judgement answer built from the ids named in the request: one strength each, no concern. */
function judgeAll(): ScriptedProvider {
  return new ScriptedProvider((req) => {
    if (req.role === "extraction") {
      // Report every requested field: a balance of 100, anything else "x".
      const fields = /Fields to report: ([^\n]*)\./.exec(req.user)?.[1].split(", ") ?? [];
      return JSON.stringify({ readable: true, values: fields.map((field) => ({ field, value: field === "funds.balance" ? 100 : "x", unit: field === "funds.balance" ? "GBP" : null, page: 1, quote: "q" })) });
    }
    const ids = [...req.user.matchAll(/^- (\S+) \|/gm)].map((m) => m[1]);
    return JSON.stringify({ findings: [], strengths: ids.map((criterionId) => ({ criterionId, detail: "Looks reasonable." })), statementNotes: [], suspiciousPassages: [] });
  });
}

/** Seed one application with the given saved intake answers, one document and one statement. */
function seedCase(answers: Record<string, unknown> | undefined): void {
  seedApplication({ id: "app-1", visaTypeId: "route-s" });
  if (answers) store.set("applications/app-1", { ...(store.get("applications/app-1") as any), intake: { routeKey: "AA_route-s", rubricVersion: 1, answers, updatedAt: null } });
  seedUser("client-1", "Ada", "Lovelace");
  seedEligibility({ nationality: "IN", score: 80, visaTypeId: "route-s" });
  seedDocument({ id: "doc-1", key: "bank", label: "Bank statement" });
  seedStatement({ id: "stmt-1", text: "I will return home." });
}

async function assess(svc: ReturnType<typeof serviceWith>): Promise<any> {
  const app = { id: "app-1", ...(store.get("applications/app-1") as any) } as any;
  const out = await svc.requestAssessment(app, { tier: "full", trigger: "manual", requestedBy: "tester" });
  if (out.kind === "created" || out.kind === "queued") await svc.runJob(out.assessmentId);
  return store.get(`applicationAssessments/${(out as any).assessmentId}`);
}

/** A rubric with one objective specialist rule (fails on the scripted 100 balance) and one judgement specialist rule. */
function jobRubric(): VisaRubric {
  const objectiveAlpha = criterion({ criterionId: "o-alpha", title: "Alpha funds", kind: "objective", stage: "eligibility", severity: "high", check: { field: "funds.balance", op: "gte", value: 9000, unit: "GBP" }, applicability: "specialist", applicabilityCondition: "alpha", trigger: { questionId: "activity", anyOf: ["alpha"] } });
  const judgementBeta = specialist("j-beta", ["beta"]);
  const everyone = criterion({ criterionId: "j-all", title: "Everyone judged", kind: "judgement", stage: "credibility", severity: "low", probeFactors: ["f"] });
  const unlinked = specialist("j-unlinked", [], { trigger: undefined });
  const rb = fictionalRubric({ countryCode: "AA", visaTypeId: "route-s", intentPolarity: "dual_intent_permitted", criteria: [objectiveAlpha, judgementBeta, everyone, unlinked] });
  rb.intakeQuestions = [{ ...ACTIVITY, criterionIds: ["o-alpha", "j-beta", "j-all"] }];
  return rb;
}

describe("assessment honours the trigger", () => {
  beforeEach(async () => {
    resetAll();
    await installAssessmentFakes();
    rubricBook.set("AA_route-s", jobRubric());
  });

  test("not triggered: the rule is not assessed, produces no finding, no refusal ground, and is not in the prompt", async () => {
    seedCase({ activity: "beta" });
    const provider = judgeAll();
    const stored = await assess(serviceWith(provider));
    assert.equal(stored.status, "succeeded");
    assert.equal(stored.refusalGrounds.some((g: any) => g.criterionId === "o-alpha"), false, "the alpha rule is not applied to a beta applicant");
    assert.equal(stored.insufficientInformation.some((i: any) => i.criterionId === "o-alpha"), false, "and it is not even listed as unassessed");
    const judgementPrompts = provider.requests.filter((r) => r.role === "judgement").map((r) => r.user).join("\n");
    assert.equal(judgementPrompts.includes("o-alpha"), false);
    assert.ok(judgementPrompts.includes("j-beta") && judgementPrompts.includes("j-all"));
    assert.equal(judgementPrompts.includes("- j-unlinked"), false, "an unlinked specialist rule is not judged");
  });

  test("triggered: the same rule IS applied, and code decides it (the 100 balance fails 9000)", async () => {
    seedCase({ activity: "alpha" });
    const stored = await assess(serviceWith(judgeAll()));
    const ground = stored.refusalGrounds.find((g: any) => g.criterionId === "o-alpha");
    assert.ok(ground, "an applicant whose answer triggers the rule is assessed against it");
    assert.equal(stored.insufficientInformation.some((i: any) => i.criterionId === "j-beta"), false, "the beta rule does not apply to an alpha applicant");
  });

  test("unknown trigger: 'could not be assessed - we need to know X', never a failed rule, no proposed action", async () => {
    seedCase({});
    const provider = judgeAll();
    const stored = await assess(serviceWith(provider));
    assert.equal(stored.status, "succeeded");
    const unknown = stored.insufficientInformation.filter((i: any) => i.notAssessed);
    assert.deepEqual(unknown.map((i: any) => i.criterionId).sort(), ["j-beta", "j-unlinked", "o-alpha"]);
    const alpha = unknown.find((i: any) => i.criterionId === "o-alpha");
    assert.equal(alpha.reason, `could not be assessed: we need to know ${ACTIVITY.label}`);
    assert.equal(alpha.notAssessed, "unanswered");
    assert.equal(unknown.find((i: any) => i.criterionId === "j-unlinked").notAssessed, "no_trigger");
    assert.equal(stored.refusalGrounds.length, 0, "an unknown rule is never a failed rule");
    // No evidence action for them: what is missing is an answer, not a document.
    const { actions } = deriveProposedActions({ id: "a1", applicationId: "app-1", userId: "client-1", agencyId: "agency-1" } as any, rubricBook.get("AA_route-s") as VisaRubric, stored);
    assert.equal(actions.some((a: any) => unknown.some((u: any) => a.criterionId === u.criterionId)), false);
    // And none of them is a free-tier top issue.
    assert.equal(stored.topIssues.some((t: any) => unknown.some((u: any) => u.criterionId === t.criterionId)), false);
  });

  test("the free tier still serves exactly readiness, topIssues, hasBlockingRule", async () => {
    seedCase({});
    const stored = await assess(serviceWith(judgeAll()));
    assert.deepEqual(Object.keys(serializeFree(stored)).sort(), ["hasBlockingRule", "readiness", "topIssues"]);
    for (const t of serializeFree(stored).topIssues) assert.deepEqual(Object.keys(t).sort(), ["criterionId", "title"]);
  });
});

// ============================================
// Scale: a 500-rule rulebook
// ============================================

/**
 * 500 fictional rules: 16 for everyone, 44 for "alpha" (so 60 apply to an alpha
 * applicant) and 440 for ten other activities. Half of each group are judgement
 * rules, half objective. Stages are spread so batching by stage is exercised.
 */
function bigRubric(opts: { alphaJudgement?: boolean } = {}): VisaRubric {
  const stages = ["validity", "suitability", "eligibility", "credibility"] as const;
  const criteria: AssessmentCriterion[] = [];
  const activities = ["alpha", ...Array.from({ length: 10 }, (_, i) => `act${i}`)];
  const options = activities.map((a) => ({ value: a, label: `Activity ${a}` }));
  let n = 0;
  const make = (activity: string | null, i: number, forceJudgement = false): AssessmentCriterion => {
    const id = `r${String(n++).padStart(3, "0")}`;
    const kind = forceJudgement || i % 2 === 0 ? "judgement" : "objective";
    const base = { criterionId: id, title: `Rule ${id}`, stage: stages[i % 4], severity: "medium" } as const;
    const shape = kind === "judgement"
      ? { kind: "judgement" as const, probeFactors: ["f"] }
      : { kind: "objective" as const, check: { field: `doc.field${i}`, op: "present" as const } };
    return criterion({ ...base, ...shape, ...(activity ? { applicability: "specialist" as const, applicabilityCondition: `for ${activity}`, trigger: { questionId: "activity", anyOf: [activity] } } : {}) });
  };
  for (let i = 0; i < 16; i++) criteria.push(make(null, i));
  for (let i = 0; i < 44; i++) criteria.push(make("alpha", i, opts.alphaJudgement === true));
  for (const a of activities.slice(1)) for (let i = 0; i < 44; i++) criteria.push(make(a, i));
  const rb = fictionalRubric({ countryCode: "AA", visaTypeId: "route-s", intentPolarity: "dual_intent_permitted", criteria });
  rb.intakeQuestions = [{ ...ACTIVITY, options, criterionIds: criteria.map((c) => c.criterionId) }];
  return rb;
}

describe("a 500-rule rulebook is assessed without truncation", () => {
  beforeEach(async () => {
    resetAll();
    await installAssessmentFakes();
  });

  test("60 rules apply to an alpha applicant: every one is accounted for, none of the other 440 is touched", async () => {
    const rb = bigRubric();
    assert.equal(rb.criteria.length, 500);
    rubricBook.set("AA_route-s", rb);
    seedCase({ activity: "alpha" });
    const provider = judgeAll();
    const stored = await assess(serviceWith(provider));
    assert.equal(stored.status, "succeeded");

    const triggered = splitByApplicability(rb, { activity: "alpha" }).applicable;
    assert.equal(triggered.length, 60);
    const triggeredJudgement = triggered.filter((c) => c.kind === "judgement").map((c) => c.criterionId);
    const triggeredObjective = triggered.filter((c) => c.kind === "objective").map((c) => c.criterionId);

    // Judgement: every triggered judgement rule was asked about (a strength was
    // scripted for each id the prompt named), and no other rule was.
    assert.deepEqual(stored.strengths.map((s: any) => s.criterionId).sort(), [...triggeredJudgement].sort());
    // Objective: code decided every triggered objective rule (the prompt carries each outcome).
    const judgementPrompt = provider.requests.filter((r) => r.role === "judgement").map((r) => r.user).join("\n");
    for (const id of triggeredObjective) assert.ok(judgementPrompt.includes(`${id}: `), `${id} was decided`);
    // Nothing outside the triggered set is in any request.
    const outside = rb.criteria.filter((c) => !triggered.includes(c)).map((c) => c.criterionId);
    assert.equal(outside.some((id) => provider.requests.some((r) => r.user.includes(id))), false);
  });

  test("model calls per application: 1 document + 1 judgement call here (before: 1 judgement call over all 250 judgement rules)", async () => {
    rubricBook.set("AA_route-s", bigRubric());
    seedCase({ activity: "alpha" });
    const provider = judgeAll();
    await assess(serviceWith(provider));
    assert.equal(provider.callsFor("extraction"), 1);
    assert.equal(provider.callsFor("judgement"), 1, "30 triggered judgement rules fit one call");
    // The request carries 30 rules, where it used to carry all 250.
    const ids = [...provider.requests.find((r) => r.role === "judgement")!.user.matchAll(/^- (\S+) \|/gm)];
    assert.equal(ids.length, 30);
  });

  test("when hundreds of judgement rules apply they are split into batches, none dropped, combined in code", async () => {
    // 44 alpha rules, all judgement, plus the 8 general judgement rules = 52, in 4 stages.
    const rb = bigRubric({ alphaJudgement: true });
    rubricBook.set("AA_route-s", rb);
    seedCase({ activity: "alpha" });
    const provider = judgeAll();
    const stored = await assess(serviceWith(provider));
    const applicableJudgement = splitByApplicability(rb, { activity: "alpha" }).applicable.filter((c) => c.kind === "judgement");
    assert.ok(applicableJudgement.length > JUDGEMENT_BATCH_MAX_CRITERIA);
    const calls = provider.callsFor("judgement");
    assert.equal(calls, Math.ceil(applicableJudgement.length / JUDGEMENT_BATCH_MAX_CRITERIA));
    assert.deepEqual(stored.strengths.map((s: any) => s.criterionId).sort(), applicableJudgement.map((c) => c.criterionId).sort(), "every applicable rule judged exactly once");
  });

  test("planJudgementBatches: every criterion in exactly one batch; short lists stay one call; stage order kept", () => {
    const rb = bigRubric();
    const all = rb.criteria.filter((c) => c.kind === "judgement");
    const batches = planJudgementBatches(all);
    assert.deepEqual(batches.flat().map((c) => c.criterionId).sort(), all.map((c) => c.criterionId).sort());
    assert.ok(batches.every((b) => b.length <= JUDGEMENT_BATCH_MAX_CRITERIA));
    assert.equal(batches.length, Math.ceil(all.length / JUDGEMENT_BATCH_MAX_CRITERIA));
    assert.equal(planJudgementBatches(all.slice(0, 5)).length, 1);
    assert.deepEqual(planJudgementBatches([]), []);
    const order = ["validity", "suitability", "eligibility", "credibility"];
    const ranks = batches.flat().map((c) => order.indexOf(c.stage));
    assert.deepEqual(ranks, [...ranks].sort((a, b) => a - b), "criteria are grouped by stage");
    // Deterministic.
    assert.deepEqual(planJudgementBatches(all).map((b) => b.map((c) => c.criterionId)), batches.map((b) => b.map((c) => c.criterionId)));
  });

  test("a rulebook the request cap cannot cover fails with the cap error instead of assessing a subset", async () => {
    rubricBook.set("AA_route-s", bigRubric({ alphaJudgement: true }));
    seedCase({ activity: "alpha" });
    const provider = judgeAll();
    // 1 document call + 2 judgement batches needed, cap 2.
    const stored = await assess(serviceWith(provider, { maxRequestsPerAssessment: 2 }));
    assert.equal(stored.status, "failed");
    assert.equal(stored.error.code, "cost_cap_exceeded");
    assert.equal(stored.strengths?.length ?? 0, 0, "nothing is stored for a subset");
    assert.ok(storedAssessments("app-1").length === 1);
  });

  test("one failed batch records only its own rules as insufficient; the others keep their findings", async () => {
    const rb = bigRubric({ alphaJudgement: true });
    rubricBook.set("AA_route-s", rb);
    seedCase({ activity: "alpha" });
    let judged = 0;
    const provider = new ScriptedProvider((req) => {
      if (req.role === "extraction") return JSON.stringify({ readable: true, values: [] });
      judged++;
      if (judged === 1) return "not json";
      const ids = [...req.user.matchAll(/^- (\S+) \|/gm)].map((m) => m[1]);
      return JSON.stringify({ findings: [], strengths: ids.map((criterionId) => ({ criterionId, detail: "Fine." })), statementNotes: [], suspiciousPassages: [] });
    });
    const stored = await assess(serviceWith(provider));
    const applicable = splitByApplicability(rb, { activity: "alpha" }).applicable.filter((c) => c.kind === "judgement").map((c) => c.criterionId);
    const accounted = new Set([...stored.strengths.map((s: any) => s.criterionId), ...stored.insufficientInformation.map((i: any) => i.criterionId)]);
    for (const id of applicable) assert.ok(accounted.has(id), `${id} is judged or reported, never lost`);
    assert.ok(stored.insufficientInformation.length > 0 && stored.strengths.length > 0);
  });
});

// ============================================
// Chat prompt and upload-check expectations
// ============================================

describe("the other consumers honour the trigger", () => {
  test("chat: rules the applicant's answers do not trigger are not in the prompt, and an omission is never silent", () => {
    const rb = bigRubric();
    const app = { id: "app-1", countryCode: "AA", status: "draft", intake: { answers: { activity: "alpha" } } } as any;
    const assessment = { rubricVersion: rb.version, readiness: "weak", topIssues: [], hasBlockingRule: false, refusalGrounds: [], credibilityFlags: [], strengths: [], insufficientInformation: [], statementFindings: [], stageOutcomes: {}, finishedAt: null } as any;
    const ctx = buildChatContext(app, assessment, rb, "full", "agent");
    assert.equal(ctx.criteria.length, 60, "only the 60 rules that apply, not all 500");
    assert.equal(ctx.omittedCriteria, 0);
    const prompt = buildChatUserPrompt({ ...ctx, omittedCriteria: 3 }, [], "hello");
    assert.match(prompt, /3 further published rule\(s\) that apply to this application are not shown/);
    assert.doesNotMatch(buildChatUserPrompt(ctx, [], "hello"), /further published rule/);
  });

  test("upload check: a document is held only to the rules that apply to the applicant", () => {
    const dur = criterion({ criterionId: "d-alpha", title: "Alpha period", kind: "objective", stage: "eligibility", severity: "low", check: { field: "funds.balance", op: "heldForDays", value: 28, unit: "days" }, applicability: "specialist", applicabilityCondition: "alpha", trigger: { questionId: "activity", anyOf: ["alpha"] } });
    const rb = fictionalRubric({ countryCode: "AA", visaTypeId: "route-s", intentPolarity: null, criteria: [dur] });
    rb.intakeQuestions = [{ ...ACTIVITY, criterionIds: ["d-alpha"] }];
    rb.evidenceItems = [{ key: "stmt", title: "Statement", party: "applicant", criterionIds: ["d-alpha"], source: { quote: "q", url: "https://example.test", sourceId: "s", contentHash: "h", retrievedAt: "2026-11-01T00:00:00.000Z" } }] as any;
    assert.deepEqual(expectationsFor(rb, "ev-stmt", "Statement", "applicant", { activity: "alpha" }).requiredPeriod, { value: 28, unit: "days" });
    assert.equal(expectationsFor(rb, "ev-stmt", "Statement", "applicant", { activity: "beta" }).requiredPeriod, null);
    // No answers passed (a caller that predates #207): every linked rule counts, as before.
    assert.deepEqual(expectationsFor(rb, "ev-stmt", "Statement", "applicant").requiredPeriod, { value: 28, unit: "days" });
  });
});
