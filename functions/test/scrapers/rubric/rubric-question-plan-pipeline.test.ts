// ============================================
// Question plan (issue #203) — end to end through part A's pipeline
// ============================================
//
// The REAL pipeline (gates, approval transaction, alerts engine) over the
// in-memory Firestore, with the REAL planner over a fake model provider and a
// stub for the independent check (part B). Proves: the plan is written with
// the automatic approval, the read side serves it, consumers (intake) need no
// change and see questions in plan order and only when their condition holds,
// the admin review detail keeps the full draft plus the plan, and every
// unusable outcome HOLDS the draft with the serving version untouched.

import { before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { Timestamp } from "firebase-admin/firestore";
import { fakeCollection, fakeRunTransaction, installFakes, resetStore, store } from "../../helpers/fake-firestore";
import { fakeCollectionGroup } from "../../helpers/fake-collection-group";
import { installAdminClaimsFromUserDocs } from "../../helpers/fake-admin-claims";
import { rubricStore } from "../../../src/scrapers/rubric/rubric.store";
import type { RubricDraft } from "../../../src/scrapers/rubric/rubric.store";
import { PUBLISH_SETTINGS_DOC_ID, publishSettingsTx } from "../../../src/scrapers/rubric/rubric-publish-settings";
import { RubricQuestionPlanner } from "../../../src/scrapers/rubric/rubric-question-planner";
import { DEFAULT_QUESTION_CHECK_LIMITS } from "../../../src/scrapers/rubric/rubric-question-check";
import { scrapeAlertService } from "../../../src/scrapers/shared/alerts/scrape-alert.service";
import { RubricAutoPublishService, type RubricChecker } from "../../../src/services/rubric-auto-publish.service";
import { rubricReviewService, rubricVersionId } from "../../../src/services/rubric-review.service";
import { intakeService } from "../../../src/services/intake.service";
import type { LlmProvider, LlmRequest } from "../../../src/services/ai/llm-provider";
import type { IntakeQuestion, QuestionPlan } from "../../../src/types/rubric";
import { A_LINES, A_TEXT, ROUTE_A, SOURCE_A_ID, SOURCE_A_URL } from "./fixtures/synthetic-guidance";
import { headDoc, installRubricFakes, quiet, resetBucket, seedSource, snapshotStore, versionDoc } from "./rubric-harness";
import { A_POLARITY_QUOTE, KEY_A, REVIEW_T0, body, criterion, draft, sourceA } from "./rubric-review-fixtures";

/* eslint-disable @typescript-eslint/no-explicit-any */

const nowMs = REVIEW_T0 + 7_200_000;
const SETTINGS_PATH = `appConfig/${PUBLISH_SETTINGS_DOC_ID}`;

before(async () => {
  await installFakes();
  await installAdminClaimsFromUserDocs();
  await installRubricFakes();
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
  scrapeAlertService.notify = async () => undefined;
  scrapeAlertService.log = () => undefined;
  scrapeAlertService.realClock = () => nowMs;
});

beforeEach(() => {
  resetStore();
  resetBucket();
  store.set(SETTINGS_PATH, { mode: "auto" });
});

// ---------- the draft: ten rules, eight questions (one duplicate, one with bad wording and a child), two document items ----------

/** The ten rules of the pipeline tests' draft. */
function makeDraft(hash: string): RubricDraft {
  const s = sourceA(hash);
  const criteria = [
    criterion(s, { title: "Aged 18 or over", kind: "objective", ruleRef: "SV 2.1", quote: body(A_LINES.age), check: { field: "applicant.age", op: "gte", value: 18 } }),
    criterion(s, { title: "Funds held for 28 days", kind: "objective", ruleRef: "SV 2.2", quote: body(A_LINES.held), check: { field: "funds.balance", op: "heldForDays", value: 28, unit: "days" } }),
    criterion(s, { title: "Will leave at the end of the visit", kind: "judgement", stage: "credibility", ruleRef: "SV 3.1", quote: "The decision maker must be satisfied that the applicant will leave Avalen at the end of the visit.", concernsIntent: true }),
    criterion(s, { title: "Nationals refused from a stated date", kind: "mandatory_bar", stage: "suitability", severity: "critical", ruleRef: "SV 4.1", quote: body(A_LINES.bar), appliesTo: { nationalities: ["QM", "QN"], asWritten: ["Borduria", "Syldavia"] }, validFrom: "2026-03-26" }),
    criterion(s, { title: "Valid application", kind: "judgement", stage: "validity", quote: "An application is valid only if the applicant has paid the application fee and provided a passport." }),
    criterion(s, { title: "No set level of funds", kind: "judgement", quote: "There is no set level of funds." }),
    criterion(s, { title: "Reasonable costs of the visit", kind: "judgement", quote: "The decision maker must consider whether the applicant can meet the reasonable costs of the visit" }),
    criterion(s, { title: "Third party support", kind: "judgement", quote: "A sponsor may provide a letter of support and their bank statements as evidence of third party support." }),
    criterion(s, { title: "Intention to remain", kind: "judgement", stage: "credibility", quote: A_POLARITY_QUOTE, concernsIntent: true }),
    criterion(s, { title: "Income and planned spending", kind: "judgement", quote: "having regard to their income and their planned spending" }),
  ];
  const id = (title: string) => criteria.find((c) => c.title === title)!.criterionId;
  const q = (qid: string, label: string, titles: string[], extra: Partial<IntakeQuestion> = {}): IntakeQuestion => ({ id: qid, label, answerType: "yes_no", required: true, criterionIds: titles.map(id), ...extra });
  const intakeQuestions: IntakeQuestion[] = [
    q("age-confirm", "Are you aged 18 or over?", ["Aged 18 or over"]),
    q("sponsor-name", "What is your sponsor's full name?", ["Third party support"], { answerType: "text", showWhen: { anyOf: [{ questionId: "paying", op: "eq", value: "sponsor" }] } }),
    q("age-again", "Are you aged 18 or over", ["Valid application"]),
    q("budget", "What are your planned costs?", ["Reasonable costs of the visit"], { answerType: "text" }),
    q("paying", "Who is paying for the visit?", ["Third party support", "Funds held for 28 days"], { answerType: "single_choice", options: [{ value: "me", label: "I am" }, { value: "sponsor", label: "A sponsor" }] }),
    q("fee", "Have you paid the application fee?", ["Valid application"]),
    q("leading", "You will surely leave afterwards, won't you?", ["Will leave at the end of the visit"]),
    q("leading-child", "Why will you leave?", ["Will leave at the end of the visit"], { answerType: "text", showWhen: { anyOf: [{ questionId: "leading", op: "eq", value: true }] } }),
  ];
  const evidenceItems = [
    { key: "passport", title: "Passport", party: "applicant" as const, criterionIds: [id("Valid application")], source: criteria[4].source },
    { key: "sponsor-letter", title: "Letter of support", party: "sponsor" as const, criterionIds: [id("Third party support")], source: criteria[7].source, when: { questionId: "paying", op: "eq" as const, value: "sponsor" } },
    { key: "leave-proof", title: "Proof of return", party: "applicant" as const, criterionIds: [id("Will leave at the end of the visit")], source: criteria[2].source, when: { questionId: "leading", op: "eq" as const, value: true } },
  ];
  const d = draft(ROUTE_A, [s], criteria, { proposal: { value: "immigrant_intent_penalised", quote: A_POLARITY_QUOTE }, extra: { intakeQuestions, evidenceItems } as any });
  d.flags = [...d.flags, { code: "intake_wording_uncited", message: "wording is the model's", target: "rubric" }];
  return d;
}

async function seed(): Promise<void> {
  const hash = await seedSource({ id: SOURCE_A_ID, url: SOURCE_A_URL, text: A_TEXT });
  const key = `guidanceSources/${SOURCE_A_ID}`;
  store.set(key, { ...(store.get(key) as any), role: "route_guidance" });
  const d = makeDraft(hash);
  await rubricStore.writePendingVersion(d, d.sourceSnapshots.map((s) => s.sourceId), { now: d.createdAt, force: true });
}

/** The independent check (part B) as a passing stub. */
const checker: RubricChecker = { check: async () => ({ ok: true, leftOut: [], resolvedFlagCodes: [], intentPolarity: "immigrant_intent_penalised" }) };

/** Items of a request (batch-local ids). */
function itemsOf(req: LlmRequest): any[] {
  return JSON.parse(/<user_uploaded_document source="rubric_items">\n([\s\S]*?)\n<\/user_uploaded_document>/.exec(req.user)![1]);
}

/** A model that fails the questions/items whose text matches. */
function model(failMatching: RegExp | null): LlmProvider {
  return {
    modelFor: () => "fake-model",
    complete: async (req) => {
      const items = itemsOf(req);
      const isQ = "question" in items[0];
      const verdicts = items.map((it) => {
        const text = String(it.question ?? it.document);
        const bad = failMatching !== null && failMatching.test(text);
        return isQ
          ? { id: it.id, asks_only_what_quote_requires: "yes", answer_type_fits: "yes", neutral_wording: bad ? "no" : "yes" }
          : { id: it.id, names_only_quoted_documents: "yes", party_right: bad ? "unsure" : "yes" };
      });
      return { text: JSON.stringify({ verdicts }), stopReason: "end_turn", usage: { inputTokens: 500, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 }, model: "fake-model" };
    },
  };
}

const service = (provider: LlmProvider, limits = DEFAULT_QUESTION_CHECK_LIMITS) =>
  new RubricAutoPublishService({ checker, planner: new RubricQuestionPlanner({ provider, limits }), now: () => Timestamp.fromMillis(nowMs), appUrl: () => "https://portal.test" });
const run = async (svc: RubricAutoPublishService) => (await quiet(() => svc.onVersionCreated(KEY_A, 1))).result;

describe("question plan through the pipeline", () => {
  test("published with the plan written as a review field; the read side serves it; the intake renders it in plan order and by condition", async () => {
    await seed();
    const r = await run(service(model(/surely/)));
    assert.equal(r?.outcome, "published", JSON.stringify(r?.reasonCodes));
    assert.equal(r?.questionPlan, "built");

    // ---- stored: the plan, and only on the review fields ----
    const stored = versionDoc(KEY_A, 1);
    const plan = stored.questionPlan as QuestionPlan;
    assert.deepEqual(plan.omittedQuestions, [{ id: "leading", failed: ["neutral_wording"] }]);
    assert.deepEqual(plan.droppedWithDependents.questionIds, ["leading-child"]);
    assert.deepEqual(plan.droppedWithDependents.evidenceKeys, ["leave-proof"]);
    assert.deepEqual(plan.merges, [{ from: "age-again", to: "age-confirm" }]);
    assert.equal(plan.check?.questionsChecked, 8);
    assert.equal(plan.check?.questionsFailed, 1);
    assert.equal(stored.criteria.length, 10, "the draft itself is untouched");
    assert.equal(stored.intakeQuestions.length, 8);
    assert.equal(headDoc(KEY_A).approvedVersion, 1);

    // ---- served: failed question and dependents gone, duplicate merged, rules all there ----
    const served = (await rubricStore.getApprovedRubric(ROUTE_A.countryCode, ROUTE_A.visaTypeId))!;
    assert.equal(served.criteria.length, 10);
    assert.ok(!("questionPlan" in served));
    assert.equal(served.intakeQuestions[0].id, "paying", "the question that decides what else is asked comes first");
    assert.deepEqual(served.intakeQuestions.map((x) => x.id).sort(), ["age-confirm", "budget", "fee", "paying", "sponsor-name"]);
    assert.equal(served.intakeQuestions.find((x) => x.id === "age-confirm")!.criterionIds.length, 2);
    assert.deepEqual(served.evidenceItems.map((e) => e.key).sort(), ["passport", "sponsor-letter"]);
    const known = new Set(served.intakeQuestions.map((x) => x.id));
    for (const c of served.criteria) for (const qid of c.intakeQuestionIds ?? []) assert.ok(known.has(qid));

    // ---- consumer: intake, unchanged code ----
    const app: any = { countryCode: ROUTE_A.countryCode, visaTypeId: ROUTE_A.visaTypeId, status: "draft", id: "a1" };
    const intake = await intakeService.getIntake(app);
    assert.deepEqual(intake.questions.map((x) => x.id), served.intakeQuestions.map((x) => x.id), "plan order");
    assert.ok(!JSON.stringify(intake).includes("questionPlan"));
    // The sponsor question is shown only once the sponsor answer is given.
    assert.ok(!intake.openRequiredIds.includes("sponsor-name"));
    const sponsored = await intakeService.getIntake({ ...app, intake: { routeKey: KEY_A, rubricVersion: 1, answers: { paying: "sponsor", "gone-question": "x", leading: true } } });
    assert.ok(sponsored.openRequiredIds.includes("sponsor-name"));
    assert.ok(!("gone-question" in sponsored.answers) && !("leading" in sponsored.answers), "answers to an omitted question are ignored, not an error");
  });

  test("the admin review detail keeps the full draft and returns the plan beside it", async () => {
    await seed();
    await run(service(model(/surely/)));
    const detail: any = await rubricReviewService.getVersion(rubricVersionId(KEY_A, 1));
    assert.equal(detail.intakeQuestions.length, 8, "unfiltered");
    assert.equal(detail.evidenceItems.length, 3);
    assert.equal(detail.questionPlan.merges.length, 1);
  });

  test("a model answer with a wrong id holds the draft: question_plan_unusable, serving version and draft untouched", async () => {
    await seed();
    const bad: LlmProvider = { modelFor: () => "m", complete: async () => ({ text: JSON.stringify({ verdicts: [{ id: "nope" }] }), stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }, model: "m" }) };
    const r = await run(service(bad));
    assert.equal(r?.outcome, "held");
    assert.deepEqual(r?.reasonCodes, ["question_plan_unusable"]);
    assert.equal(versionDoc(KEY_A, 1).reviewStatus, "pending_review");
    assert.equal(versionDoc(KEY_A, 1).questionPlan, undefined);
    assert.equal(headDoc(KEY_A).approvedVersion, null);
  });

  test("the spend cap holds the draft: question_check_capped, no call made", async () => {
    await seed();
    let calls = 0;
    const counting: LlmProvider = { modelFor: () => "m", complete: async () => (calls++, Promise.reject(new Error("must not be called"))) };
    const r = await run(service(counting, { ...DEFAULT_QUESTION_CHECK_LIMITS, maxCalls: 1 }));
    assert.deepEqual(r?.reasonCodes, ["question_check_capped"]);
    assert.equal(calls, 0);
    assert.equal(headDoc(KEY_A).approvedVersion, null);
  });

  test("the plan is the only thing the planner may write: a forged field is refused", async () => {
    await seed();
    const rogue = { check: checker.check, plan: async () => ({ ok: true as const, reviewFields: { questionPlan: undefined, intentPolarity: "not_assessed" } }) };
    const svc = new RubricAutoPublishService({ checker, planner: rogue as any, now: () => Timestamp.fromMillis(nowMs), appUrl: () => "https://portal.test" });
    const r = await run(svc);
    assert.notEqual(r?.outcome, "published");
    assert.equal(headDoc(KEY_A).approvedVersion, null);
  });
});
