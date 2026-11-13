// ============================================
// AUTOMATIC RULEBOOK PUBLISHING — THE COMBINED PIPELINE, END TO END (integration of #201, #202, #203, #207)
// ============================================
//
// One FICTIONAL rulebook (invented rule numbers, invented generic guidance
// text, no real country or route) goes through every part, with the real code
// and fakes only where a model or Firebase would be:
//
//   1. EXTRACTION (#207, the existing scripted-provider harness) writes a
//      pending draft that holds: ordinary rules, a specialist rule with a
//      trigger on a MULTI-choice question, a conditional rule with a trigger on
//      a YES/NO question, a conditional rule with no trigger, a mandatory bar,
//      a rule whose quote is cut off mid-sentence, a pair of exact-duplicate
//      questions and a question whose wording will fail its check.
//   2. THE PIPELINE (#201) in `auto` mode: code gates -> the independent check
//      (#202, real, over a scripted provider) -> the question planner (#203,
//      real, over a fake model) -> flags re-evaluated -> the SHARED approval
//      transaction as `system:rubric-auto-publish`.
//   3. WHAT APPLICANTS GET: `rubricStore.getApprovedRubric` serves every rule
//      but the correctness leave-out, the specialist rule WITH its trigger, the
//      failed question gone with its dependents, the duplicate merged, the
//      questions in plan order.
//   4. THE CONSUMERS on two fictional applicants (one whose answers trigger the
//      specialist rule, one whose do not): intake shows the specialist rule's
//      question only to the first; the assessment (fake model) assesses the
//      specialist rule only for the first and reports nothing for the second.
//   5. A HELD variant (the check fails the mandatory bar): the previous version
//      keeps serving, the held alert is raised, nothing else moves.
//   6. THE AUDIT ENTRY and the RUN RECORD, and the two triggers that follow
//      every approval (bulk re-assessment, rule-change events) fire exactly as
//      for a human approval.
//
// No network, no model call, no real Firestore, no real alert email.

import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { Timestamp } from "firebase-admin/firestore";
import { fakeCollection, fakeRunTransaction, installFakes, resetStore, store } from "../../helpers/fake-firestore";
import { fakeCollectionGroup } from "../../helpers/fake-collection-group";
import { installAdminClaimsFromUserDocs } from "../../helpers/fake-admin-claims";
import { rubricStore, type RubricDraft } from "../../../src/scrapers/rubric/rubric.store";
import { PUBLISH_SETTINGS_DOC_ID, publishSettingsTx } from "../../../src/scrapers/rubric/rubric-publish-settings";
import { RubricQuestionPlanner } from "../../../src/scrapers/rubric/rubric-question-planner";
import { RubricCheckerService } from "../../../src/scrapers/rubric/rubric-checker";
import { scrapeAlertService } from "../../../src/scrapers/shared/alerts/scrape-alert.service";
import { RubricAutoPublishService } from "../../../src/services/rubric-auto-publish.service";
import { rubricReviewService, rubricVersionId } from "../../../src/services/rubric-review.service";
import { BulkReassessmentService } from "../../../src/services/ai-bulk-reassessment.service";
import { RuleChangeAlertsService } from "../../../src/services/rule-change-alerts.service";
import { IntakeService } from "../../../src/services/intake.service";
import { RUBRIC_SYSTEM_ACTOR_ID, type RubricPublishRun, type VisaRubric } from "../../../src/types/rubric";
import { LlmProviderError, type LlmProvider, type LlmRequest } from "../../../src/services/ai/llm-provider";
import { ROUTE_A, SOURCE_A_ID, SOURCE_A_URL } from "./fixtures/synthetic-guidance";
import { answer, crit, headDoc, installRubricFakes, makeHarness, quiet, recordAnswers, resetBucket, seedSource, snapshotStore, versionDoc, type Harness } from "./rubric-harness";
import { MemoryLedger, ScriptedProvider as CheckerProvider, settingsWith } from "./checker-fakes";
import { REVIEW_T0 } from "./rubric-review-fixtures";
import { ScriptedProvider as AssessmentProvider, installAssessmentFakes, seedApplication, seedDocument, seedEligibility, seedStatement, seedUser, serviceWith } from "../../ai-case-officer/harness";

/* eslint-disable @typescript-eslint/no-explicit-any */

// ============================================
// The fictional guidance
// ============================================

const KEY = `${ROUTE_A.countryCode}_${ROUTE_A.visaTypeId}`;
const SETTINGS_PATH = `appConfig/${PUBLISH_SETTINGS_DOC_ID}`;
const nowMs = REVIEW_T0 + 7_200_000;

// Nine rules for everybody (one with a quote that will be cut off), two scoped rules with a trigger, one scoped rule without.
const G = {
  doc: "The applicant must hold a valid travel document.",
  age: "The applicant must be aged 18 or over on the date of application.",
  pay: "The applicant must show that they can pay for the visit and the return journey.",
  fee: "The applicant must have paid the application fee before the application is considered.",
  plan: "The applicant must give a clear account of the plan for the visit.",
  lodging: "The applicant must show where they will stay during the visit.",
  health: "The applicant must not have a condition that needs urgent treatment on arrival.",
  bar: "An application must be refused where the applicant is a national of Borduria or Syldavia.",
  // The cut-off rule: the model quotes only the first part of the sentence.
  coverFull: "The applicant must hold travel insurance covering the whole stay and all medical costs.",
  coverCut: "The applicant must hold travel insurance covering the whole",
};
const TEACH = "An applicant coming to teach at a school must hold a letter from the school.";
const TEACH_COND = "An applicant coming to teach at a school";
const PAYER = "Where someone else is paying for the visit, the applicant must provide that person's written consent.";
const PAYER_COND = "Where someone else is paying for the visit";
const TRAVELLED = "An applicant who has travelled before must list those journeys.";
const TRAVELLED_COND = "An applicant who has travelled before";

const TEXT = [
  "Q 1.1 " + G.doc,
  "Q 1.2 " + G.age,
  "Q 1.3 " + G.pay,
  "Q 1.4 " + G.fee,
  "Q 1.5 " + G.plan,
  "Q 1.6 " + G.lodging,
  "Q 1.7 " + G.health,
  "Q 2.1 " + TEACH,
  "Q 2.2 " + PAYER,
  "Q 2.3 " + TRAVELLED,
  "Q 3.1 " + G.bar,
  "Q 4.1 " + G.coverFull,
].join("\n");

const j = { kind: "judgement" as const, probeFactors: ["x"], requiresInterviewBeforeRefusal: false };

/** The model's hand-written answer: what an extraction of this page would yield. */
function modelAnswer() {
  return answer({
    criteria: [
      crit({ ref: "doc", title: "Holds a travel document", ...j, quote: G.doc }),
      crit({ ref: "age", title: "Aged 18 or over", kind: "objective", quote: G.age, check: { field: "applicant.age", op: "gte", value: 18, unit: null }, probeFactors: [] }),
      crit({ ref: "pay", title: "Can pay for the visit", ...j, quote: G.pay }),
      crit({ ref: "fee", title: "Application fee paid", ...j, stage: "validity", quote: G.fee }),
      crit({ ref: "plan", title: "Clear plan for the visit", ...j, stage: "credibility", quote: G.plan }),
      crit({ ref: "lodging", title: "Shows where they will stay", ...j, quote: G.lodging }),
      crit({ ref: "health", title: "No urgent treatment need", ...j, quote: G.health }),
      crit({ ref: "teach", title: "Letter from the school", ...j, quote: TEACH, applicability: "specialist", applicabilityCondition: TEACH_COND }),
      crit({ ref: "payer", title: "Consent of the person paying", ...j, quote: PAYER, applicability: "conditional", applicabilityCondition: PAYER_COND }),
      crit({ ref: "travelled", title: "List of earlier journeys", ...j, quote: TRAVELLED, applicability: "conditional", applicabilityCondition: TRAVELLED_COND }),
      crit({ ref: "bar", title: "Nationals refused", kind: "mandatory_bar", stage: "suitability", severity: "critical", quote: G.bar, appliesTo: { nationalities: ["QM", "QN"], asWritten: ["Borduria", "Syldavia"] } }),
      crit({ ref: "cover", title: "Holds travel insurance", ...j, quote: G.coverCut }),
    ],
    intakeQuestions: [
      // The question that establishes the activity: MULTI-choice.
      { id: "visit-activity", label: "What will you do on your visit?", helpText: null, answerType: "multi_choice", required: true, criterionRefs: ["doc", "teach"], group: null, party: null, options: [{ value: "teaching", label: "Teach at a school", description: null }, { value: "sport", label: "Compete in a sporting event", description: null }], textMaxLength: null, dateRelativeToToday: null, showWhenAnyOf: [] },
      // YES/NO: who pays. Read by an ordinary rule and by the conditional one.
      { id: "third-party-paying", label: "Is someone else paying for your visit?", helpText: null, answerType: "yes_no", required: true, criterionRefs: ["pay", "payer"], group: null, party: null, options: [], textMaxLength: null, dateRelativeToToday: null, showWhenAnyOf: [] },
      { id: "payer-name", label: "What is the full name of the person paying?", helpText: null, answerType: "text", required: true, criterionRefs: ["payer"], group: null, party: "sponsor", options: [], textMaxLength: 120, dateRelativeToToday: null, showWhenAnyOf: [{ questionId: "third-party-paying", op: "eq", value: true }] },
      // Only the specialist rule reads this one.
      { id: "school-name", label: "What is the name of the school?", helpText: null, answerType: "text", required: true, criterionRefs: ["teach"], group: null, party: null, options: [], textMaxLength: 120, dateRelativeToToday: null, showWhenAnyOf: [] },
      // An exact duplicate pair.
      { id: "age-confirm", label: "Are you aged 18 or over?", helpText: null, answerType: "yes_no", required: true, criterionRefs: ["age"], group: null, party: null, options: [], textMaxLength: null, dateRelativeToToday: null, showWhenAnyOf: [] },
      { id: "age-again", label: "Are you aged 18 or over", helpText: null, answerType: "yes_no", required: true, criterionRefs: ["fee"], group: null, party: null, options: [], textMaxLength: null, dateRelativeToToday: null, showWhenAnyOf: [] },
      // A question whose wording fails its check, and its follow-up.
      { id: "leading", label: "You will surely go home afterwards, will you not?", helpText: null, answerType: "yes_no", required: true, criterionRefs: ["plan"], group: null, party: null, options: [], textMaxLength: null, dateRelativeToToday: null, showWhenAnyOf: [] },
      { id: "leading-why", label: "Why will you go home?", helpText: null, answerType: "text", required: true, criterionRefs: ["plan"], group: null, party: null, options: [], textMaxLength: 200, dateRelativeToToday: null, showWhenAnyOf: [{ questionId: "leading", op: "eq", value: true }] },
      { id: "stay-where", label: "Where will you stay?", helpText: null, answerType: "text", required: true, criterionRefs: ["lodging"], group: null, party: null, options: [], textMaxLength: 200, dateRelativeToToday: null, showWhenAnyOf: [] },
    ],
    ruleTriggers: [
      { criterionRef: "teach", questionId: "visit-activity", answerValues: ["teaching"] },
      { criterionRef: "payer", questionId: "third-party-paying", answerValues: ["true"] },
    ],
  });
}

// ============================================
// Wiring
// ============================================

let h: Harness;

before(async () => {
  await installFakes();
  await installAdminClaimsFromUserDocs();
  await installRubricFakes();
  await installAssessmentFakes();
  const firebase: any = await import("../../../src/utils/firebase");
  firebase.collections.rubricReviewHistory = fakeCollection("rubricReviewHistory");
  firebase.collections.rubricPublishRuns = fakeCollection("rubricPublishRuns");
  firebase.collections.rubricPublishSettingsHistory = fakeCollection("rubricPublishSettingsHistory");
  firebase.collections.bulkReassessments = fakeCollection("bulkReassessments");
  firebase.collections.applicationAssessments = fakeCollection("applicationAssessments");
  firebase.collectionGroups.rubricVersions = () => fakeCollectionGroup("rubricVersions");
  rubricStore.runTransaction = fakeRunTransaction as any;
  rubricReviewService.runTransaction = fakeRunTransaction as any;
  publishSettingsTx.run = fakeRunTransaction as any;
  (rubricReviewService as any).deps.snapshots = snapshotStore;
  (rubricReviewService as any).deps.now = () => Timestamp.fromMillis(nowMs);
  scrapeAlertService.notify = async (input: any) => void emails.push(input);
  scrapeAlertService.log = () => undefined;
  scrapeAlertService.realClock = () => nowMs;
});

let emails: any[] = [];

beforeEach(() => {
  resetStore();
  resetBucket();
  emails = [];
  store.set("users/admin1", { email: "delivered+admin1@resend.dev", admin: true });
  store.set(SETTINGS_PATH, { mode: "auto" });
  h = makeHarness();
});

after(() => undefined);

/** Seed the page as the route's source and run the REAL extraction over the recorded answer: a pending version 1. */
async function extractDraft(): Promise<RubricDraft> {
  h.state.knownVisaTypes.add(`${ROUTE_A.countryCode}/${ROUTE_A.visaTypeId}`);
  await seedSource({ id: SOURCE_A_ID, url: SOURCE_A_URL, text: TEXT });
  store.set(`guidanceSources/${SOURCE_A_ID}`, { ...(store.get(`guidanceSources/${SOURCE_A_ID}`) as any), role: "route_guidance" });
  await recordAnswers(h.provider, SOURCE_A_ID, [modelAnswer()]);
  const { result } = await quiet(() => h.service.extractRoute({ ...ROUTE_A, sourceIds: [SOURCE_A_ID] }));
  assert.equal(result.status, "succeeded");
  const { version: _v, ...pristine } = structuredClone(versionDoc(KEY, 1));
  void _v;
  return pristine as RubricDraft;
}

/** The pipeline: real check over a scripted provider, real planner over a fake model, real approval, real alerts. */
function wire(opts: { check?: (p: CheckerProvider) => void; failQuestionsMatching?: RegExp | null; questionModel?: LlmProvider & { requests: LlmRequest[] } } = {}) {
  const provider = new CheckerProvider();
  opts.check?.(provider);
  const checker = new RubricCheckerService({ provider: () => provider, readSnapshot: (s, hash) => snapshotStore.read(s, hash), loadSettings: settingsWith(), ledger: new MemoryLedger(), nowMs: () => nowMs, sleep: async () => undefined });
  const questionModel = opts.questionModel ?? fakeQuestionModel(opts.failQuestionsMatching === undefined ? /surely/ : opts.failQuestionsMatching);
  const decideCalls: any[][] = [];
  const review = { decideAs: (...args: any[]) => (decideCalls.push(args), (rubricReviewService as any).decideAs(...args)), knownEligibilityIds: (r: any) => rubricReviewService.knownEligibilityIds(r) };
  const svc = new RubricAutoPublishService({ review: review as any, checker, planner: new RubricQuestionPlanner({ provider: questionModel }), now: () => Timestamp.fromMillis(nowMs), appUrl: () => "https://portal.test" });
  return { svc, provider, questionModel, decideCalls };
}

/** A model that fails the questions whose text matches. */
function fakeQuestionModel(failMatching: RegExp | null): LlmProvider & { requests: LlmRequest[] } {
  const requests: LlmRequest[] = [];
  return {
    requests,
    modelFor: () => "fake-model",
    complete: async (req) => {
      requests.push(req);
      const items = JSON.parse(/<user_uploaded_document source="rubric_items">\n([\s\S]*?)\n<\/user_uploaded_document>/.exec(req.user)![1]);
      const isQuestion = "question" in items[0];
      const verdicts = items.map((it: any) => {
        const bad = failMatching !== null && failMatching.test(String(it.question ?? it.document));
        return isQuestion ? { id: it.id, asks_only_what_quote_requires: "yes", answer_type_fits: "yes", neutral_wording: bad ? "no" : "yes" } : { id: it.id, names_only_quoted_documents: "yes", party_right: "yes" };
      });
      return { text: JSON.stringify({ verdicts }), stopReason: "end_turn", usage: { inputTokens: 500, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 }, model: "fake-model" };
    },
  };
}

const trigger = async (svc: RubricAutoPublishService, version = 1) => (await quiet(() => svc.onVersionCreated(KEY, version))).result;
const audits = () => [...store.entries()].filter(([p]) => p.startsWith("rubricReviewHistory/")).map(([id, d]) => ({ id: id.split("/")[1], ...(d as any) }));
const runs = () => [...store.entries()].filter(([p]) => p.startsWith("rubricPublishRuns/")).map(([, d]) => d as unknown as RubricPublishRun);
const alerts = () => [...store.entries()].filter(([p]) => p.startsWith("scrapeAlerts/")).map(([, d]) => d as any);
const served = async (): Promise<VisaRubric> => (await rubricStore.getApprovedRubric(ROUTE_A.countryCode, ROUTE_A.visaTypeId)) as VisaRubric;
const idOf = (rubric: VisaRubric, title: string): string => (rubric.criteria.find((c) => c.title === title) as any).criterionId;

// ============================================
// 1. Extraction writes the draft
// ============================================

describe("e2e 1: extraction (#207) writes a pending draft with every kind of rule and question", () => {
  test("ordinary rules, a specialist rule with a trigger, conditional rules, a bar, a cut-off quote, a duplicate pair and a question to fail", async () => {
    await extractDraft();
    const draft = versionDoc(KEY, 1) as VisaRubric;
    assert.equal(draft.reviewStatus, "pending_review");
    assert.equal(headDoc(KEY).approvedVersion, null);
    assert.equal(draft.criteria.length, 12, "every rule of the page, none dropped for size or specialism");
    const by = (t: string) => draft.criteria.find((c) => c.title === t) as any;
    assert.deepEqual(by("Letter from the school").trigger, { questionId: "visit-activity", anyOf: ["teaching"] });
    assert.equal(by("Letter from the school").applicability, "specialist");
    assert.deepEqual(by("Consent of the person paying").trigger, { questionId: "third-party-paying", anyOf: ["true"] });
    assert.equal(by("List of earlier journeys").trigger, undefined, "a conditional rule nobody could tie to a question");
    assert.equal(by("Nationals refused").kind, "mandatory_bar");
    // The cut-off quote is kept in the draft and flagged; code will leave it out.
    const cut = draft.flags.find((f) => f.code === "quote_ends_mid_sentence");
    assert.equal(cut?.target, idOf(draft, "Holds travel insurance"));
    assert.equal(draft.intakeQuestions.length, 9);
  });
});

// ============================================
// 2 + 3. The pipeline publishes; what applicants get
// ============================================

describe("e2e 2-3: the pipeline publishes automatically and applicants are served the right rulebook", () => {
  test("code gates -> check -> planner -> shared approval as the system actor; every rule but the correctness leave-out is served", async () => {
    await extractDraft();
    const w = wire();
    const r = await trigger(w.svc);
    assert.equal(r?.outcome, "published", JSON.stringify(r?.reasonCodes));
    assert.equal(r?.checker, "passed");
    assert.equal(r?.questionPlan, "built");

    // ---- through the SHARED approval, as the named system actor ----
    assert.equal(w.decideCalls.length, 1);
    assert.deepEqual(w.decideCalls[0][2], { kind: "system", id: RUBRIC_SYSTEM_ACTOR_ID });
    const stored = versionDoc(KEY, 1);
    assert.equal(stored.reviewStatus, "approved");
    assert.equal(stored.reviewedBy, RUBRIC_SYSTEM_ACTOR_ID);
    assert.equal(headDoc(KEY).approvedVersion, 1);

    // ---- what applicants get ----
    const s = await served();
    const cutId = idOf(stored, "Holds travel insurance");
    assert.deepEqual(stored.excludedCriterionIds, [cutId], "the ONLY leave-out is the correctness one");
    assert.equal(s.criteria.length, 11, "every rule except the cut-off quote");
    assert.ok(!s.criteria.some((c) => c.criterionId === cutId));
    assert.ok(s.criteria.some((c) => c.kind === "mandatory_bar"), "the bar stays");
    // The specialist rule is present WITH its trigger; the conditional one too; the unanchored one without.
    const teach = s.criteria.find((c) => c.title === "Letter from the school") as any;
    assert.equal(teach.applicability, "specialist");
    assert.deepEqual(teach.trigger, { questionId: "visit-activity", anyOf: ["teaching"] });
    assert.deepEqual((s.criteria.find((c) => c.title === "Consent of the person paying") as any).trigger, { questionId: "third-party-paying", anyOf: ["true"] });
    assert.equal((s.criteria.find((c) => c.title === "List of earlier journeys") as any).trigger, undefined);
    // Internal records never reach applicants.
    for (const key of ["questionPlan", "excludedCriterionIds", "exclusionNote"]) assert.ok(!(key in s), key);

    // ---- questions: failed one gone with its dependent, duplicate merged, plan order ----
    const ids = s.intakeQuestions.map((q) => q.id);
    assert.ok(!ids.includes("leading") && !ids.includes("leading-why"), "the failed question goes with its dependents");
    assert.ok(!ids.includes("age-again"), "the exact duplicate is merged");
    assert.equal(s.intakeQuestions.find((q) => q.id === "age-confirm")?.criterionIds.length, 2, "the merged question serves both rules");
    const plan = stored.questionPlan;
    assert.deepEqual(plan.omittedQuestions.map((o: any) => o.id), ["leading"]);
    assert.deepEqual(plan.droppedWithDependents.questionIds, ["leading-why"]);
    assert.deepEqual(plan.merges, [{ from: "age-again", to: "age-confirm" }]);
    assert.deepEqual(ids, plan.order, "served in plan order");
    // The two questions that decide what else applies come first; a follow-up never precedes its parent.
    assert.deepEqual(new Set(ids.slice(0, 2)), new Set(["visit-activity", "third-party-paying"]));
    assert.ok(ids.indexOf("third-party-paying") < ids.indexOf("payer-name"));
    // The question only the specialist rule reads is shown only when its trigger holds (derived from the trigger, multi-choice parent).
    const school = s.intakeQuestions.find((q) => q.id === "school-name") as any;
    assert.deepEqual(school.showWhen, { anyOf: [{ questionId: "visit-activity", op: "in", value: ["teaching"] }] });
    assert.deepEqual(plan.droppedTriggerCriterionIds, [], "every trigger was confirmed");

    // ---- audit entry and run record ----
    const [audit] = audits();
    assert.equal(audits().length, 1);
    assert.equal(audit.action, "approve");
    assert.equal(audit.by, RUBRIC_SYSTEM_ACTOR_ID);
    assert.equal(audit.automatic, true);
    assert.equal(audit.publishRunId, rubricVersionId(KEY, 1));
    assert.deepEqual(audit.excludedCriterionIds, [cutId]);
    assert.ok(audit.acknowledgedFlags.some((f: any) => f.code === "quote_ends_mid_sentence"), "acknowledged because a gate recorded a result for it");
    const [run] = runs();
    assert.equal(run.outcome, "published");
    assert.equal(run.auditId, audit.id);
    assert.equal(run.counts.rules, 12);
    assert.equal(run.counts.kept, 11);
    assert.deepEqual(run.counts.leftOutByReason, { quote_ends_mid_sentence: 1 });
    assert.equal(run.counts.informationalFlags.conditional_rules_without_trigger, 1, "the standing count of conditional rules that apply to everyone for want of a trigger");
    assert.ok(run.gates.every((g) => g.passed));
    assert.deepEqual(run.droppedTriggerIds, []);
    // The check spent: 1 batch of ordinary rules + 1 protected batch per model + trigger batches (2 ordinary rules; none protected).
    assert.equal(w.provider.requests.filter((q) => (q.schema as any).properties.verdicts?.items?.properties?.trigger_faithful).length, 1);
    // An alert says what was published.
    assert.ok(alerts().some((a) => a.rule === "rubric_auto_published"));
  });

  test("the two triggers that follow every approval fire as for a human approval: bulk re-assessment, and a rule-change event on a later approval", async () => {
    const pristine = await extractDraft();
    await trigger(wire().svc);
    const first = audits()[0];
    const bulk = new BulkReassessmentService();
    assert.equal((await quiet(() => bulk.startRun(first.id, first))).result, "started");
    assert.equal((store.get(`bulkReassessments/${first.id}`) as any).approvedBy, RUBRIC_SYSTEM_ACTOR_ID, "the system id is copied, never looked up as a user");
    const changes = new RuleChangeAlertsService({ getRubricVersion: (k: string, v: number) => rubricStore.getVersionForReview(k, v), now: () => new Date(nowMs) } as any);
    assert.equal((await quiet(() => changes.recordRubricApproval(first.id, first))).result, "skipped", "a first approval replaces nothing");

    // A re-draft in which the check fails one more ordinary rule: a second automatic approval with a diff.
    // (In this re-draft the cut-off sentence is whole, so only the rule the check fails is left out: two leave-outs
    // among nine general rules would rightly trip the leave-out budget.)
    const redraft = { ...pristine, flags: pristine.flags.filter((f) => f.code !== "quote_ends_mid_sentence"), createdAt: Timestamp.fromMillis(REVIEW_T0 + 86_400_000) };
    await rubricStore.writePendingVersion(redraft, [SOURCE_A_ID], { force: true, now: Timestamp.fromMillis(REVIEW_T0 + 86_400_000) });
    const w2 = wire({ check: (p) => { p.policy = ({ rule }) => (rule.title === "Shows where they will stay" ? { stage_right: "no" } : undefined); } });
    assert.equal((await trigger(w2.svc, 2))?.outcome, "published");
    const second = audits().find((a) => a.version === 2);
    assert.equal(second.by, RUBRIC_SYSTEM_ACTOR_ID);
    assert.equal(second.previousApprovedVersion, 1);
    assert.equal(second.excludedCriterionIds.length, 1, "the rule the check failed");
    assert.equal((await quiet(() => changes.recordRubricApproval(second.id, second))).result, "recorded");
    const event: any = [...store.values()].find((d: any) => d.sourceKind === "guidance" && d.status === "pending");
    assert.equal(event.approvedBy, RUBRIC_SYSTEM_ACTOR_ID);
    assert.equal(event.rubricSummary.removedCount, 1, "the rule the check failed is a removal for applicants");
    assert.equal(event.rubricSummary.addedCount, 1, "and the rule whose sentence is whole again is an addition");
  });
});

// ============================================
// 4. The consumers, on two applicants
// ============================================

describe("e2e 4: the consumers apply the specialist rule only to the applicant whose answers trigger it", () => {
  // A: teaches at a school, nobody else pays.  B: competes in a sporting event, someone else pays.
  const ANSWERS_A = { "visit-activity": ["teaching"], "third-party-paying": false };
  const ANSWERS_B = { "visit-activity": ["sport"], "third-party-paying": true };

  const appDoc = (answers: Record<string, unknown>, id: string): any => ({ id, countryCode: ROUTE_A.countryCode, visaTypeId: ROUTE_A.visaTypeId, status: "draft", intake: { routeKey: KEY, rubricVersion: 1, answers, updatedAt: null } });

  test("intake shows the specialist rule's question (and the payer's name) only to the applicant they apply to", async () => {
    await extractDraft();
    await trigger(wire().svc);
    const svc = new IntakeService();
    const a = await svc.getIntake(appDoc(ANSWERS_A, "app-a"));
    const b = await svc.getIntake(appDoc(ANSWERS_B, "app-b"));
    assert.ok(a.openRequiredIds.includes("school-name"), "A teaches: the school question is asked");
    assert.ok(!b.openRequiredIds.includes("school-name"), "B does not: it is not asked");
    assert.ok(b.openRequiredIds.includes("payer-name"), "B has someone else paying (a yes/no trigger): the payer's name is asked");
    assert.ok(!a.openRequiredIds.includes("payer-name"));
    // Before any answer, neither follow-up is asked.
    const none = await svc.getIntake(appDoc({}, "app-none"));
    assert.ok(!none.openRequiredIds.includes("school-name") && !none.openRequiredIds.includes("payer-name"));
    // The failed question and the merged duplicate are not offered, and no internal record leaks.
    for (const out of [a, b]) {
      const text = JSON.stringify(out);
      assert.ok(!out.questions.some((q: any) => q.id === "leading" || q.id === "age-again"));
      assert.ok(!text.includes("questionPlan") && !text.includes("excludedCriterionIds"));
    }
  });

  /** Seed one application with saved answers, a document and a statement (route fictional XA). */
  function seedCase(id: string, answers: Record<string, unknown>): void {
    seedApplication({ id, visaTypeId: ROUTE_A.visaTypeId });
    store.set(`applications/${id}`, { ...(store.get(`applications/${id}`) as any), countryCode: ROUTE_A.countryCode, intake: { routeKey: KEY, rubricVersion: 1, answers, updatedAt: null } });
    seedUser("client-1", "Ada", "Lovelace");
    seedEligibility({ nationality: "IN", score: 80, visaTypeId: ROUTE_A.visaTypeId });
    seedDocument({ id: `doc-${id}`, applicationId: id, key: "bank", label: "Bank statement" });
    seedStatement({ id: `stmt-${id}`, applicationId: id, text: "I will return home." });
  }

  /** A fake model that reports every requested field as "x" and one strength per judgement rule it was asked about. */
  const judge = () =>
    new AssessmentProvider((req) => {
      if (req.role === "extraction") {
        const fields = /Fields to report: ([^\n]*)\./.exec(req.user)?.[1].split(", ") ?? [];
        return JSON.stringify({ readable: true, values: fields.map((field) => ({ field, value: "x", unit: null, page: 1, quote: "q" })) });
      }
      const ids = [...req.user.matchAll(/^- (\S+) \|/gm)].map((m) => m[1]);
      return JSON.stringify({ findings: [], strengths: ids.map((criterionId) => ({ criterionId, detail: "Looks reasonable." })), statementNotes: [], suspiciousPassages: [] });
    });

  /** The real store behind the assessment, as the controller wires it. */
  const storeReader = {
    getApprovedRubric: (cc: string, vt: string) => rubricStore.getApprovedRubric(cc, vt),
    approvedVersionOf: async (cc: string, vt: string) => (await rubricStore.getHead(`${cc}_${vt}`))?.approvedVersion ?? null,
  };

  async function assess(id: string, provider: AssessmentProvider): Promise<any> {
    const svc = serviceWith(provider, {}, { rubrics: storeReader });
    const out = await svc.requestAssessment({ id, ...(store.get(`applications/${id}`) as any) } as any, { tier: "full", trigger: "manual", requestedBy: "tester" });
    assert.ok(out.kind === "created" || out.kind === "queued", out.kind);
    await svc.runJob(out.assessmentId);
    return store.get(`applicationAssessments/${out.assessmentId}`);
  }

  test("the assessment assesses the specialist rule for A only; for B it reports nothing about it, and the payer rule is B's", async () => {
    await extractDraft();
    await trigger(wire().svc);
    const rubric = await served();
    const teachId = idOf(rubric, "Letter from the school");
    const payerId = idOf(rubric, "Consent of the person paying");
    const travelledId = idOf(rubric, "List of earlier journeys");

    seedCase("app-a", ANSWERS_A);
    const providerA = judge();
    const storedA = await assess("app-a", providerA);
    assert.equal(storedA.status, "succeeded");
    const promptsA = providerA.requests.filter((r) => r.role === "judgement").map((r) => r.user).join("\n");
    assert.ok(promptsA.includes(teachId), "A is assessed against the specialist rule");
    assert.ok(!promptsA.includes(payerId), "A's payer rule does not apply");
    assert.ok(promptsA.includes(travelledId), "a conditional rule with no trigger still applies to everyone (as before #207)");

    resetCaseData();
    seedCase("app-b", ANSWERS_B);
    const providerB = judge();
    const storedB = await assess("app-b", providerB);
    assert.equal(storedB.status, "succeeded");
    const promptsB = providerB.requests.filter((r) => r.role === "judgement").map((r) => r.user).join("\n");
    assert.ok(!promptsB.includes(teachId), "B is not assessed against the specialist rule");
    assert.ok(promptsB.includes(payerId), "B's yes/no answer triggers the payer rule");
    assert.equal(storedB.refusalGrounds.some((g: any) => g.criterionId === teachId), false);
    assert.equal(storedB.insufficientInformation.some((i: any) => i.criterionId === teachId), false, "nothing is reported for it: not a pass, not a failure, not 'could not tell'");
    assert.equal(JSON.stringify(storedB).includes(teachId), false, "no trace of it in B's assessment");
  });

  function resetCaseData(): void {
    for (const key of [...store.keys()]) if (key.startsWith("applications/") || key.startsWith("documents/") || key.startsWith("applicationAssessments/") || key.startsWith("eligibilityChecks/") || key.startsWith("users/client")) store.delete(key);
  }

  test("a trigger the check cannot confirm is dropped, never the rule: the rule is then 'could not tell' for A and still never applied to B", async () => {
    await extractDraft();
    const w = wire({ check: (p) => { p.triggerPolicy = ({ item }) => (item.quote.startsWith("An applicant coming to teach") ? "unsure" : "yes"); } });
    const r = await trigger(w.svc);
    assert.equal(r?.outcome, "published");
    const rubric = await served();
    const teach = rubric.criteria.find((c) => c.title === "Letter from the school") as any;
    assert.ok(teach, "the rule is KEPT");
    assert.equal(teach.trigger, undefined, "its unconfirmed trigger is ignored");
    assert.deepEqual(runs()[0].droppedTriggerIds, [teach.criterionId]);
    assert.equal(runs()[0].counts.informationalFlags.specialist_rules_unanchored, 1);
    assert.equal(runs()[0].counts.leftOut, 1, "only the cut-off rule: a wrong trigger is not a leave-out");
    // A specialist rule without a trigger is "could not tell" for everyone, never applied to everyone.
    seedCase("app-a", ANSWERS_A);
    const stored = await assess("app-a", judge());
    const item = stored.insufficientInformation.find((i: any) => i.criterionId === teach.criterionId);
    assert.equal(item.notAssessed, "no_trigger");
    assert.equal(stored.refusalGrounds.some((g: any) => g.criterionId === teach.criterionId), false);
  });
});

// ============================================
// 5. A held variant
// ============================================

describe("e2e 5: a draft that fails a safeguard is held and the previous version keeps serving", () => {
  test("the check fails the mandatory bar: version 1 keeps serving, nothing else moves, the held alert is raised; a later good draft supersedes it", async () => {
    const pristine = await extractDraft();
    assert.equal((await trigger(wire().svc))?.outcome, "published");
    const servedBefore = JSON.stringify(await served());
    const auditsBefore = audits().length;

    await rubricStore.writePendingVersion({ ...pristine, createdAt: Timestamp.fromMillis(REVIEW_T0 + 86_400_000) }, [SOURCE_A_ID], { force: true, now: Timestamp.fromMillis(REVIEW_T0 + 86_400_000) });
    const bad = wire({ check: (p) => { p.policy = ({ rule }) => (rule.appliesTo ? { group_matches_codes: "no" } : undefined); } });
    const held = await trigger(bad.svc, 2);
    assert.equal(held?.outcome, "held");
    assert.equal(held?.checker, "failed");
    assert.match(held?.reasonCodes[0] as string, /^protected_rule_failed:/);

    // Nothing changed for applicants.
    assert.equal(headDoc(KEY).approvedVersion, 1);
    assert.equal(JSON.stringify(await served()), servedBefore, "the previous version serves exactly as before");
    assert.equal(versionDoc(KEY, 2).reviewStatus, "pending_review");
    assert.equal(versionDoc(KEY, 2).reviewedBy, null);
    assert.equal(audits().length, auditsBefore, "no audit entry for a hold");
    assert.equal(bad.decideCalls.length, 0, "the approval transaction was never entered");
    // The held alert names the reason in words and is critical (a protected rule failed).
    const heldAlert = alerts().find((a) => a.rule === "rubric_draft_held");
    assert.ok(heldAlert);
    assert.equal(heldAlert.severity, "critical");
    assert.match(heldAlert.message, /protected rule/);
    assert.equal(runs().find((r) => r.version === 2)?.outcome, "held");

    // A later good draft publishes and the held one is rejected by the system as superseded.
    await rubricStore.writePendingVersion({ ...pristine, createdAt: Timestamp.fromMillis(REVIEW_T0 + 2 * 86_400_000) }, [SOURCE_A_ID], { force: true, now: Timestamp.fromMillis(REVIEW_T0 + 2 * 86_400_000) });
    assert.equal((await trigger(wire().svc, 3))?.outcome, "published");
    assert.equal(headDoc(KEY).approvedVersion, 3);
    assert.equal(versionDoc(KEY, 2).reviewStatus, "rejected");
    assert.equal(versionDoc(KEY, 2).reviewedBy, RUBRIC_SYSTEM_ACTOR_ID);
    assert.equal(versionDoc(KEY, 2).rejectReason, "superseded_by_newer_version");
  });

  test("a hiccup in the question check (not the rule check) is retried by the hourly sweep and then publishes", async () => {
    await extractDraft();
    // The planner's model fails its first request, then works.
    const good = fakeQuestionModel(/surely/);
    let failures = 1;
    const flaky: LlmProvider & { requests: LlmRequest[] } = { requests: good.requests, modelFor: () => "fake-model", complete: async (req) => { if (failures-- > 0) throw new LlmProviderError("provider_error", "status=529 overloaded"); return good.complete(req); } };
    const w = wire({ questionModel: flaky });
    const first = await trigger(w.svc);
    assert.equal(first?.outcome, "held");
    assert.deepEqual(first?.reasonCodes, ["question_plan_unusable"]);
    assert.equal(headDoc(KEY).approvedVersion, null);
    // The sweep re-runs it: the rule check reuses its stored batches (no second spend), the planner now succeeds.
    const before = w.provider.requests.length;
    const swept = await quiet(() => w.svc.sweepRetryable());
    assert.deepEqual(swept.result, { considered: 1, retried: 1 });
    assert.equal(w.provider.requests.length, before, "the rule check made no model call on the retry");
    assert.equal(headDoc(KEY).approvedVersion, 1);
    assert.equal(runs()[0].outcome, "published");
    assert.equal(runs()[0].attempts, 2);
  });

  test("manual mode (and a missing settings doc) does nothing at all: no check, no publish", async () => {
    await extractDraft();
    store.set(SETTINGS_PATH, { mode: "manual" });
    const w = wire();
    const r = await trigger(w.svc);
    assert.equal(r?.outcome, "skipped");
    assert.equal(w.provider.requests.length, 0);
    assert.equal(w.questionModel.requests.length, 0);
    assert.equal(headDoc(KEY).approvedVersion, null);
    assert.equal(audits().length, 0);
  });
});
