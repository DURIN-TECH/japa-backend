// ============================================
// A bar whose trigger is not confirmed (issue #248)
// ============================================
//
// A "bar" (a mandatory bar on a named group) may carry a `trigger`: the intake
// question and answers that narrow which applicants it is put to. Before #248, a
// bar whose rule BOTH check models confirmed but whose trigger they did not held
// the whole rulebook (`trigger_not_repairable`, or `trigger_not_confirmed` on its
// re-draft). Now it is served WITHOUT the trigger and is NEVER decided by code.
//
// The two failure directions this file pins:
//   - a barred applicant told they may apply: the bar is still served (wider, not
//     narrower) and put to EVERY applicant's assessment, where the model is shown
//     the quote, list lines, the group as written and the condition words, and a
//     concern on it becomes a flag (never silently dropped);
//   - an eligible applicant wrongly barred: code never refuses on such a bar
//     (`mandatoryBarHits` skips it), so a nationality match alone, without the
//     trigger, bars nobody.
// Plus: an aspect failure is handled exactly as before; a stored mark is never
// trusted; a version without the field reads exactly as before; re-running the
// check on stored answers makes ZERO requests.
//
// No network, no model, no Firestore: the scripted provider (checker-fakes.ts),
// an in-memory ledger and snapshot. Invented names only.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { RubricCheckerService, JUDGED_BAR_DETAIL, servableWithoutTrigger } from "../../../src/scrapers/rubric/rubric-checker";
import { applyExclusions, barsServedWithoutTrigger, isJudgedBarShape } from "../../../src/scrapers/rubric/rubric-exclusions";
import { buildQuestionPlan } from "../../../src/scrapers/rubric/rubric-question-planner";
import { evaluateGates, unanchoredScopedRules } from "../../../src/scrapers/rubric/rubric-gates";
import { validateVisaRubric } from "../../../src/scrapers/rubric/rubric-validate";
import { assembleContent, buildJudgementRequest, judgementCriteriaOf, mandatoryBarHits, isJudgedBar } from "../../../src/services/ai/assessment-engine";
import { resolveApplicability, splitByApplicability, effectiveIntakeQuestions } from "../../../src/services/ai/rule-applicability";
import { judgedBarInWords } from "../../../src/services/rubric-auto-publish.service";
import { evaluateRubricAutoPublished, evaluateRubricDraftHeld } from "../../../src/scrapers/shared/alerts/scrape-alert-rules";
import { JUDGED_BAR_NOTE, type AssessmentCriterion, type IntakeQuestion, type VisaRubric } from "../../../src/types/rubric";
import { answer, crit, criteriaWire } from "./rubric-harness";
import { MemoryLedger, ScriptedProvider, isRepairRequest, isTriggerRequest, pageOf, ruleOf, rubricOf, settingsWith, SRC_HASH, SRC_ID } from "./checker-fakes";

/* eslint-disable @typescript-eslint/no-explicit-any */

// ---------- fixtures ----------

/** The bar's line (invented names). */
const BAR_QUOTE = "An application must be refused where the applicant is a national of Borduria or Syldavia.";
/** Words of the bar's line that stand for its condition (the drafting validator finds them in the snapshot). */
const BAR_COND = "where the applicant is a national of Borduria or Syldavia";

/** The question the bar's trigger reads: what the visit is for. */
const PURPOSE: IntakeQuestion = {
  id: "visit-purpose",
  label: "What is the main purpose of your visit?",
  answerType: "single_choice",
  options: [
    { value: "tourism", label: "Tourism" },
    { value: "ceremony", label: "A ceremony" },
  ],
  required: true,
  criterionIds: [],
} as unknown as IntakeQuestion;

const TRIGGER = { questionId: "visit-purpose", anyOf: ["ceremony"] };

/** A bar CODE decides from nationality (coded members), with a trigger. */
function codedBar(over: Partial<AssessmentCriterion> = {}): AssessmentCriterion {
  return ruleOf(100, {
    title: "Original coded bar",
    kind: "mandatory_bar",
    stage: "validity",
    severity: "critical",
    probeFactors: undefined,
    source: { quote: BAR_QUOTE, sourceId: SRC_ID, url: "https://rules.example/page", contentHash: SRC_HASH, retrievedAt: "2026-11-13T00:00:00Z" },
    appliesTo: { nationalities: ["QM", "QN"], asWritten: ["Borduria", "Syldavia"] },
    applicability: "specialist",
    applicabilityCondition: BAR_COND,
    trigger: { ...TRIGGER, anyOf: [...TRIGGER.anyOf] },
    ...over,
  });
}

/** A bar whose group has NO code (an uncoded member only), with a trigger: the dev case's shape. */
function uncodedBar(over: Partial<AssessmentCriterion> = {}): AssessmentCriterion {
  return codedBar({ title: "Original uncoded bar", appliesTo: { nationalities: [], asWritten: [], uncoded: ["visa nationals"] }, ...over });
}

/** A page of `n` ordinary lines plus the bar line. */
const page = (n = 6) => pageOf(n, [`B1.1 ${BAR_QUOTE}`]);

/** A draft: `n` ordinary rules, the bar, and the purpose question (linked to an ordinary rule and to the bar). */
function draftWith(bar: AssessmentCriterion, n = 6): VisaRubric {
  const ordinary = Array.from({ length: n }, (_, k) => ruleOf(k + 1));
  return { ...rubricOf([...ordinary, bar], null), intakeQuestions: [{ ...PURPOSE, criterionIds: ["crit-0001", bar.criterionId] }], evidenceItems: [] } as unknown as VisaRubric;
}

function rig(opts: { ledger?: MemoryLedger } = {}) {
  const provider = new ScriptedProvider();
  const ledger = opts.ledger ?? new MemoryLedger();
  const p = page();
  const svc = new RubricCheckerService({ provider: () => provider, readSnapshot: async () => p, loadSettings: settingsWith(), ledger, nowMs: () => Date.parse("2026-11-13T10:00:00Z"), sleep: async () => undefined });
  return { svc, provider, ledger };
}
const input = (rubric: VisaRubric) => ({ routeKey: rubric.routeKey, version: 1, runId: `${rubric.routeKey}__v1`, rubric, codeLeftOutIds: [] as string[] });

/** The trigger check's judgement-role model is unsure about the bar's trigger; everything else is `yes`. */
const unsureOnBarTrigger = ({ role, item }: { role: string; item: any }) => (role === "judgement" && item.quote === BAR_QUOTE ? ("unsure" as const) : ("yes" as const));

/** The served rulebook for a check outcome: the plan as the pipeline builds it, then the one read-side filter. */
function servedFor(rubric: VisaRubric, out: any): VisaRubric {
  const repairs = out.repairs ?? [];
  const withRepairs = { ...rubric, ...(repairs.length > 0 ? { ruleRepairs: repairs } : {}) } as VisaRubric;
  const planBase = repairs.length > 0 ? { ...rubric, criteria: rubric.criteria.map((c) => repairs.find((r: any) => r.criterionId === c.criterionId)?.replacement ?? c) } : rubric;
  const plan = buildQuestionPlan(planBase as VisaRubric, [], { questions: [], evidence: [] }, null, out.droppedTriggerIds ?? []);
  return applyExclusions({ ...withRepairs, questionPlan: plan });
}

/** A redraft answer for the bar: the same line, a different title, the same scope. */
const goodRedraft = (over: Record<string, unknown> = {}) =>
  criteriaWire(answer({
    criteria: [
      crit({
        ref: "r1",
        title: "Repaired coded bar",
        kind: "mandatory_bar",
        stage: "suitability",
        severity: "critical",
        quote: BAR_QUOTE,
        appliesTo: { nationalities: ["QM", "QN"], asWritten: ["Borduria", "Syldavia"] },
        applicability: "specialist",
        applicabilityCondition: BAR_COND,
        ...over,
      }),
    ],
  }));

// ============================================
// The check
// ============================================

describe("#248 the check: a bar confirmed on every aspect but not on its trigger", () => {
  test("uncoded bar, trigger not confirmed: NOT a protected failure; served without the trigger, judged; replay makes zero requests", async () => {
    const r = rig();
    r.provider.triggerPolicy = unsureOnBarTrigger;
    const bar = uncodedBar();
    const rubric = draftWith(bar);
    const out = await r.svc.check(input(rubric));
    assert.equal(out.ok, true, JSON.stringify(!out.ok && out.reasonCodes));
    if (!out.ok) return;
    assert.equal(out.protectedFailures, undefined, "no protected failure, nothing to repair");
    assert.deepEqual(out.droppedTriggerIds, [bar.criterionId]);
    assert.deepEqual(out.judgedBars, [{ criterionId: bar.criterionId, ruleRef: null, title: "Original uncoded bar", replaced: false, removedTrigger: TRIGGER }]);
    assert.equal(r.provider.requests.filter(isRepairRequest).length, 0, "no re-draft: there is no failed aspect");
    // Replay: the same version again, with the stored answers: ZERO model requests for this change.
    const before = r.provider.requests.length;
    const again = await r.svc.check(input(rubric));
    assert.equal(r.provider.requests.length, before, "stored answers are reused");
    assert.deepEqual(again, out, "the same outcome, deterministically");
  });

  test("coded bar, trigger not confirmed: served without the trigger; the read side marks it never code-decided", async () => {
    const r = rig();
    r.provider.triggerPolicy = unsureOnBarTrigger;
    const bar = codedBar();
    const rubric = draftWith(bar);
    const out = await r.svc.check(input(rubric));
    assert.equal(out.ok, true);
    const served = servedFor(rubric, out);
    const s = served.criteria.find((c) => c.criterionId === bar.criterionId) as AssessmentCriterion;
    assert.equal(s.trigger, undefined, "the unconfirmed trigger is removed");
    assert.equal(s.notCodeDecided, true, "and the bar is never decided by code");
    assert.deepEqual(s.appliesTo, bar.appliesTo, "the group as written is kept");
    assert.equal(s.applicabilityCondition, BAR_COND, "the original condition words are kept");
    // Code does not bar a QM national on it; the model is shown it in full.
    assert.deepEqual(mandatoryBarHits(served, "QM", "2026-11-14"), []);
    assert.deepEqual(judgementCriteriaOf(served).map((c) => c.criterionId).filter((id) => id === bar.criterionId), [bar.criterionId]);
  });

  test("a protected rule that also FAILS an aspect is handled exactly as before: one re-draft, then hold when the re-draft fails", async () => {
    const r = rig();
    r.provider.triggerPolicy = unsureOnBarTrigger;
    // The judgement-role model says the group is wrong on the original AND on any re-draft.
    r.provider.policy = ({ role, rule }) => (rule.appliesTo && role === "judgement" ? { group_matches_codes: "no" } : undefined);
    r.provider.redraftPolicy = () => goodRedraft();
    const out = await r.svc.check(input(draftWith(codedBar())));
    assert.equal(out.ok, false);
    assert.deepEqual(!out.ok && out.reasonCodes, ["protected_rule_failed:crit-0100"]);
    assert.equal(r.provider.requests.filter(isRepairRequest).length, 1, "exactly one re-draft");
    const f = !out.ok ? out.protectedFailures?.[0] : undefined;
    assert.equal(f?.repair.status, "failed_check");
    assert.deepEqual(f?.repair.replacementFailedAspects, ["group_matches_codes"]);
    assert.equal(!out.ok && out.judgedBars, undefined, "a bar that failed an aspect is never served judged");
  });

  test("an aspect failure with a CONFIRMED trigger on the re-draft: repaired as before (the trigger stays)", async () => {
    const r = rig();
    r.provider.policy = ({ role, rule }) => (rule.title === "Original coded bar" && role === "judgement" ? { group_matches_codes: "unsure" } : undefined);
    r.provider.redraftPolicy = () => goodRedraft();
    const out = await r.svc.check(input(draftWith(codedBar())));
    assert.equal(out.ok, true);
    if (!out.ok) return;
    assert.equal(out.protectedFailures?.[0].repair.status, "repaired");
    assert.equal(out.protectedFailures?.[0].repair.detail, undefined);
    assert.deepEqual(out.droppedTriggerIds, []);
    assert.equal(out.judgedBars, undefined);
    assert.deepEqual(out.repairs?.[0].replacement.trigger, TRIGGER, "the original's trigger is carried and kept");
  });

  test("REPLACEMENT bar: passes every aspect with both models, trigger not confirmed -> repaired, served without the trigger, judged; replay zero", async () => {
    const r = rig();
    // The original fails an aspect (so it is re-drafted); its replacement passes every aspect.
    r.provider.policy = ({ role, rule }) => (rule.title === "Original coded bar" && role === "judgement" ? { group_matches_codes: "unsure" } : undefined);
    r.provider.triggerPolicy = unsureOnBarTrigger;
    r.provider.redraftPolicy = () => goodRedraft();
    const rubric = draftWith(codedBar());
    const out = await r.svc.check(input(rubric));
    assert.equal(out.ok, true, JSON.stringify(!out.ok && out.reasonCodes));
    if (!out.ok) return;
    const f = out.protectedFailures?.[0];
    assert.equal(f?.repair.status, "repaired");
    assert.equal(f?.repair.detail, JUDGED_BAR_DETAIL);
    assert.deepEqual(f?.repair.replacementFailedAspects, []);
    assert.deepEqual(out.droppedTriggerIds, ["crit-0100"]);
    assert.deepEqual(out.judgedBars?.map((b) => [b.criterionId, b.title, b.replaced]), [["crit-0100", "Repaired coded bar", true]]);
    const served = servedFor(rubric, out).criteria.find((c) => c.criterionId === "crit-0100") as AssessmentCriterion;
    assert.equal(served.title, "Repaired coded bar", "the replacement is what is served");
    assert.equal(served.trigger, undefined);
    assert.equal(served.notCodeDecided, true);
    // Replay with the stored attempt and the stored answers: ZERO requests, same outcome.
    const before = r.provider.requests.length;
    const again = await r.svc.check(input(rubric));
    assert.equal(r.provider.requests.length, before, "no re-draft and no check request: everything is stored");
    const { requests: _a, ...a } = again as any;
    const { requests: _b, ...b } = out as any;
    void _a;
    void _b;
    assert.deepEqual(a, b);
  });

  test("the request count of a fresh run is unchanged by #248 (no new kind of request: rule batches + trigger batches only)", async () => {
    const r = rig();
    r.provider.triggerPolicy = unsureOnBarTrigger;
    await r.svc.check(input(draftWith(codedBar())));
    // 1 ordinary batch + 2 protected batches (one per model) + 1 ordinary-free trigger batch per model for the bar.
    const triggerCalls = r.provider.requests.filter(isTriggerRequest).length;
    assert.equal(triggerCalls, 2, "the bar's trigger is checked by both models, once");
    assert.equal(r.provider.requests.length, 5);
  });

  test("servableWithoutTrigger and the read side's test agree: only a mandatory bar", () => {
    for (const kind of ["mandatory_bar", "objective", "judgement"] as const) assert.equal(servableWithoutTrigger({ kind }), isJudgedBarShape({ kind }), kind);
    assert.equal(servableWithoutTrigger({ kind: "mandatory_bar" }), true);
    assert.equal(servableWithoutTrigger({ kind: "objective" }), false);
  });
});

// ============================================
// The read side (what consumers are served)
// ============================================

describe("#248 the read side: the mark is derived, never stored, never trusted", () => {
  const planned = (rubric: VisaRubric, dropped: string[]) => ({ ...rubric, questionPlan: buildQuestionPlan(rubric, [], { questions: [], evidence: [] }, null, dropped) }) as VisaRubric;

  test("an approved version WITHOUT the field (no bar in the dropped list) reads exactly as before #248", () => {
    const bar = codedBar();
    const rubric = draftWith(bar);
    // A pre-#248 plan: only an ordinary rule's trigger was ever dropped (here none carries one: no change at all).
    const served = applyExclusions(planned(rubric, []));
    const s = served.criteria.find((c) => c.criterionId === bar.criterionId) as AssessmentCriterion;
    assert.deepEqual(s.trigger, TRIGGER, "the bar keeps its trigger");
    assert.equal(s.notCodeDecided, undefined);
    assert.deepEqual(mandatoryBarHits({ criteria: [s] }, "QM", "2026-11-14").map((c) => c.criterionId), [bar.criterionId], "code still decides it for a covered applicant");
    assert.deepEqual(served.intakeQuestions[0].criterionIds, ["crit-0001", bar.criterionId], "links unchanged");
    // And an ordinary rule's dropped trigger is handled exactly as before (trigger removed, nothing marked, links kept).
    const ord = ruleOf(1, { applicability: "specialist", applicabilityCondition: "x", trigger: { ...TRIGGER } } as any);
    const r2 = { ...draftWith(bar), criteria: [ord, bar] } as VisaRubric;
    const s2 = applyExclusions(planned(r2, ["crit-0001"]));
    const o = s2.criteria.find((c) => c.criterionId === "crit-0001") as AssessmentCriterion;
    assert.equal(o.trigger, undefined);
    assert.equal(o.notCodeDecided, undefined, "an ordinary rule is never marked");
    assert.deepEqual(s2.intakeQuestions[0].criterionIds, ["crit-0001", bar.criterionId], "an ordinary rule's links are not touched");
  });

  test("a STORED notCodeDecided (never written by any path) is stripped: a forged mark cannot weaken a bar", () => {
    const bar = codedBar({ notCodeDecided: true } as any);
    const served = applyExclusions(draftWith(bar));
    const s = served.criteria.find((c) => c.criterionId === bar.criterionId) as AssessmentCriterion;
    assert.equal(s.notCodeDecided, undefined);
    assert.equal(mandatoryBarHits({ criteria: [s] }, "QM", "2026-11-14").length, 1, "code still decides it");
  });

  test("the removed trigger no longer links its question to the bar when the question serves another rule; the question stays", () => {
    const bar = codedBar();
    const served = applyExclusions(planned(draftWith(bar), [bar.criterionId]));
    const q = served.intakeQuestions.find((x) => x.id === "visit-purpose") as IntakeQuestion;
    assert.ok(q, "the question is never deleted");
    assert.deepEqual(q.criterionIds, ["crit-0001"], "the bar left the question's links");
    const s = served.criteria.find((c) => c.criterionId === bar.criterionId) as AssessmentCriterion;
    assert.ok(!(s.intakeQuestionIds ?? []).includes("visit-purpose"));
  });

  test("a question that served ONLY the bar keeps the link: never orphaned, never deleted, its answer still collected", () => {
    const bar = codedBar({ intakeQuestionIds: ["visit-purpose"] });
    const rubric = { ...rubricOf([ruleOf(1), bar], null), intakeQuestions: [{ ...PURPOSE, criterionIds: [bar.criterionId] }], evidenceItems: [] } as unknown as VisaRubric;
    const served = applyExclusions(planned(rubric, [bar.criterionId]));
    assert.deepEqual(served.intakeQuestions.map((q) => [q.id, q.criterionIds]), [["visit-purpose", [bar.criterionId]]]);
    assert.ok(effectiveIntakeQuestions(served).some((q) => q.id === "visit-purpose" && !q.showWhen), "always asked: the bar is put to everyone");
  });

  test("the plan with a bar's dropped trigger validates, and barsServedWithoutTrigger names it (the audit's source)", () => {
    const bar = codedBar();
    const p = planned(draftWith(bar), [bar.criterionId]);
    assert.deepEqual(validateVisaRubric(p).errors.filter((e) => e.code === "question_plan_invalid"), []);
    assert.deepEqual(p.questionPlan?.droppedTriggerCriterionIds, [bar.criterionId]);
    assert.deepEqual(barsServedWithoutTrigger(p), [bar.criterionId]);
    assert.deepEqual(barsServedWithoutTrigger(draftWith(bar)), [], "nothing without a plan");
  });

  test("deterministic: the same stored version gives the same served rule on every read", () => {
    const bar = uncodedBar();
    const p = planned(draftWith(bar), [bar.criterionId]);
    assert.deepEqual(applyExclusions(p), applyExclusions(structuredClone(p)));
  });

  test("the gates do not count such a bar as an unanchored scoped rule (it has its own record line)", () => {
    const bar = codedBar();
    assert.deepEqual(unanchoredScopedRules([bar], [PURPOSE], [bar.criterionId]), { conditional: 0, specialist: 0 });
    // An ordinary specialist rule with a dropped trigger is still counted as before.
    const ord = ruleOf(1, { applicability: "specialist", trigger: { ...TRIGGER } } as any);
    assert.deepEqual(unanchoredScopedRules([ord], [PURPOSE], ["crit-0001"]), { conditional: 0, specialist: 1 });
    void evaluateGates;
  });
});

// ============================================
// The assessment engine
// ============================================

describe("#248 the assessment engine: such a bar is judged in full and never code-decided", () => {
  const servedOf = (bar: AssessmentCriterion) => applyExclusions({ ...draftWith(bar), questionPlan: buildQuestionPlan(draftWith(bar), [], { questions: [], evidence: [] }, null, [bar.criterionId]) } as VisaRubric);
  const request = (rubric: VisaRubric) => buildJudgementRequest({ rubric: { criteria: rubric.criteria, intentPolarity: null }, statementText: null, profileSummary: "p", intakeSummary: "i", extractionSummary: "e", objectiveSummary: "o" });
  const lineOf = (user: string, id: string) => user.split("\n").find((l) => l.startsWith(`- ${id} |`)) ?? "";

  test("coded bar served without trigger: code does NOT bar a covered nationality; the rule is in the judgement set with its full text", () => {
    const rubric = servedOf(codedBar());
    assert.deepEqual(mandatoryBarHits(rubric, "QM", "2026-11-14"), [], "no code refusal on a nationality match alone");
    assert.ok(isJudgedBar(rubric.criteria.find((c) => c.criterionId === "crit-0100") as AssessmentCriterion));
    const line = lineOf(request(rubric).user, "crit-0100");
    assert.ok(line.includes(BAR_QUOTE), "the quote");
    assert.ok(line.includes("NOT decided by code"), "the model is told code does not decide it");
    assert.ok(line.includes("Borduria; Syldavia"), "the group as written");
    assert.ok(line.includes(`"${BAR_COND}"`), "the original condition words");
    assert.ok(!line.includes("QM"), "no code is shown as if it settled anything");
    // Put to every applicant: not "could not tell", whatever they answered (or not).
    const bar = rubric.criteria.find((c) => c.criterionId === "crit-0100") as AssessmentCriterion;
    for (const answers of [{}, { "visit-purpose": "tourism" }, { "visit-purpose": "ceremony" }]) {
      assert.deepEqual(resolveApplicability(bar, rubric.intakeQuestions, answers), { status: "applies" });
    }
    assert.ok(splitByApplicability(rubric, {}).applicable.some((c) => c.criterionId === "crit-0100"));
  });

  test("uncoded bar served without trigger: in the judgement set, never a code hit, same full block", () => {
    const rubric = servedOf(uncodedBar());
    assert.deepEqual(mandatoryBarHits(rubric, "QM", "2026-11-14"), []);
    const line = lineOf(request(rubric).user, "crit-0100");
    assert.ok(line.includes("NOT decided by code") && line.includes("visa nationals") && line.includes(BAR_COND));
  });

  test("an uncoded bar WITH its trigger (no #248 change) keeps the #222 text and stays scoped by its trigger", () => {
    const bar = uncodedBar();
    const rubric = applyExclusions(draftWith(bar));
    const line = lineOf(request(rubric).user, "crit-0100");
    assert.ok(line.includes("also named, with no code: visa nationals"));
    assert.ok(!line.includes("NOT decided by code"));
    assert.equal(resolveApplicability(rubric.criteria.find((c) => c.criterionId === "crit-0100") as AssessmentCriterion, rubric.intakeQuestions, { "visit-purpose": "tourism" }).status, "not_applicable");
  });

  const assemble = (rubric: VisaRubric, findings: any[], mandatoryHits: AssessmentCriterion[] = []) =>
    assembleContent({ rubric: { criteria: rubric.criteria, intentPolarity: null, severityLevels: ["critical", "high", "medium", "low"] }, mandatoryHits, objective: [], judgement: { findings, strengths: [], statementNotes: [], suspiciousPassages: [], dropped: 0, unanchored: 0 }, documents: [], statementReadable: true, score: 90, suspiciousDocumentIds: [], judgementFailed: false });

  test("a concern the model raises on such a bar becomes a FLAG marked as a bar, never a refusal ground", () => {
    const rubric = servedOf(codedBar());
    const content = assemble(rubric, [{ criterionId: "crit-0100", detail: "The visit is for a ceremony.", whatWouldHelp: "Ask your agent.", concern: true }]);
    assert.equal(content.refusalGrounds.length, 0, "the model can never create a refusal");
    assert.equal(content.hasBlockingRule, false);
    assert.deepEqual(content.credibilityFlags.map((f) => [f.criterionId, f.kind, f.isMandatoryBar]), [["crit-0100", "mandatory_bar", true]]);
    assert.equal(content.stageOutcomes.credibility, "at_risk");
    assert.notEqual(content.readiness, "strong", "a concern on a bar caps the band");
  });

  test("the model cannot clear a bar code decided: a code hit stays a refusal ground whatever the model says, and is not flagged twice", () => {
    // The #222 shape: coded AND uncoded members, trigger confirmed (code decides the coded members).
    const bar = codedBar({ appliesTo: { nationalities: ["QM"], asWritten: ["Borduria"], uncoded: ["visa nationals"] }, trigger: undefined, applicability: "all_applicants" });
    const rubric = applyExclusions(draftWith(bar));
    const hits = mandatoryBarHits(rubric, "QM", "2026-11-14");
    assert.equal(hits.length, 1, "code decides the coded member");
    const content = assemble(rubric, [{ criterionId: "crit-0100", detail: "Looks fine.", whatWouldHelp: "-", concern: false }, { criterionId: "crit-0100", detail: "x", whatWouldHelp: "y", concern: true }], hits);
    assert.deepEqual(content.refusalGrounds.map((g) => g.criterionId), ["crit-0100"]);
    assert.equal(content.hasBlockingRule, true);
    assert.equal(content.credibilityFlags.length, 0, "no second entry for a bar code already refused on");
  });

  test("CONTAINMENT (extended, not loosened): a finding on an objective rule or on a bar the model was not shown is still ignored", () => {
    const shownNot = codedBar({ trigger: undefined, applicability: "all_applicants" }); // coded only, code-decided, not judged
    const obj = ruleOf(1, { kind: "objective", check: { field: "applicant.age", op: "gte", value: 18 }, probeFactors: undefined });
    const rubric = { ...draftWith(shownNot), criteria: [obj, shownNot] } as VisaRubric;
    assert.deepEqual(judgementCriteriaOf(rubric), []);
    const content = assemble(rubric, [{ criterionId: "crit-0100", detail: "x", whatWouldHelp: "y", concern: true }, { criterionId: "crit-0001", detail: "x", whatWouldHelp: "y", concern: true }]);
    assert.equal(content.credibilityFlags.length, 0);
    assert.equal(content.refusalGrounds.length, 0);
  });
});

// ============================================
// Words: the record line, the alerts
// ============================================

describe("#248 the words: each such bar is named, with its trigger not confirmed and assessed by judgement", () => {
  const bar = { criterionId: "crit-0100", ruleRef: "B1.1", title: "Nationals seeking a ceremony", replaced: true, removedTrigger: TRIGGER };

  test("the record line", () => {
    const line = judgedBarInWords(bar);
    assert.ok(line.startsWith("Nationals seeking a ceremony [B1.1] (its one automatic re-draft): "));
    assert.ok(line.includes(JUDGED_BAR_NOTE));
    assert.match(JUDGED_BAR_NOTE, /trigger was not confirmed/);
    assert.match(JUDGED_BAR_NOTE, /assessed by judgement/);
    assert.match(JUDGED_BAR_NOTE, /never decided by code/);
  });

  const facts = (extra: Record<string, unknown> = {}) => ({ routeKey: "XA_xa-test", version: 2, previousVersion: null, link: "https://portal.test/x", rules: 10, kept: 10, leftOutByReason: {}, held: 0, primaryLeftOut: [], informationalFlags: {}, sample: [], reasons: [], protectedHold: false, settingsUnreadable: false, attempt: 1, ...extra });
  const config = { rules: {} } as any;

  test("the published alert names the bar and says it is assessed by judgement", () => {
    const msg = evaluateRubricAutoPublished(facts({ judgedBars: [judgedBarInWords(bar)] }) as any, config).signals[0].message;
    assert.match(msg, /Bars served without their trigger/);
    assert.ok(msg.includes("Nationals seeking a ceremony [B1.1]"));
    assert.ok(msg.includes("assessed by judgement"));
    assert.ok(!evaluateRubricAutoPublished(facts() as any, config).signals[0].message.includes("Bars served without"), "nothing when there is none");
  });

  test("the held alert names it too (held for another reason)", () => {
    const msg = evaluateRubricDraftHeld(facts({ judgedBars: [judgedBarInWords(bar)], reasons: ["x"] }) as any, config).signals[0].message;
    assert.ok(msg.includes("Nationals seeking a ceremony [B1.1]"));
  });

  test("nothing names a country, nationality or route in the new code", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const root = path.join(__dirname, "../../../src");
    const files = ["scrapers/rubric/rubric-exclusions.ts", "scrapers/rubric/rubric-checker.ts", "services/ai/assessment-engine.ts", "services/ai/rule-applicability.ts", "services/rubric-auto-publish.service.ts"];
    for (const f of files) {
      const text = fs.readFileSync(path.join(root, f), "utf8");
      assert.ok(!/\b(united kingdom|britain|british|ireland|canada|nigeria|schengen|marriage visa|non-visa national)\b/i.test(text), f);
    }
  });
});
