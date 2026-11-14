// ============================================
// A bar with an unconfirmed trigger, END TO END (issue #248)
// ============================================
//
// One FICTIONAL rulebook (invented guidance, invented group names, no real
// country or route) holds a mandatory bar with a TRIGGER (the intake answer
// that narrows who it is put to). The independent check confirms the bar's rule
// with both models but not its trigger. Proved, with the real extraction, the
// real check (scripted provider), the real planner (fake model), the real
// approval transaction, the real alert engine and the real assessment (fake
// model):
//   - the draft is PUBLISHED (not held), the bar is served WITHOUT the trigger
//     and marked never code-decided;
//   - the run record, the published alert and the audit entry name the bar and
//     say its trigger was not confirmed and that it is assessed by judgement;
//   - the question plan is built on the final rule set (the bar left the
//     trigger question's links; the question stays for the other rule);
//   - an applicant of the bar's coded group whose visit is NOT the one the
//     condition names is NOT refused by code (the eligible direction);
//   - an applicant it covers is put to the model with the full rule, and the
//     model's concern becomes a flag marked as a bar (the barred direction);
//   - a re-run of the held version (a sweep retry) makes no new rule-check request.
//
// No network, no model call, no real Firestore, no real alert email.

import { before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { Timestamp } from "firebase-admin/firestore";
import { fakeCollection, fakeRunTransaction, installFakes, resetStore, store } from "../../helpers/fake-firestore";
import { fakeCollectionGroup } from "../../helpers/fake-collection-group";
import { installAdminClaimsFromUserDocs } from "../../helpers/fake-admin-claims";
import { rubricStore } from "../../../src/scrapers/rubric/rubric.store";
import { PUBLISH_SETTINGS_DOC_ID, publishSettingsTx } from "../../../src/scrapers/rubric/rubric-publish-settings";
import { RubricQuestionPlanner } from "../../../src/scrapers/rubric/rubric-question-planner";
import { RubricCheckerService } from "../../../src/scrapers/rubric/rubric-checker";
import { scrapeAlertService } from "../../../src/scrapers/shared/alerts/scrape-alert.service";
import { RubricAutoPublishService } from "../../../src/services/rubric-auto-publish.service";
import { rubricReviewService } from "../../../src/services/rubric-review.service";
import { JUDGED_BAR_NOTE, type RubricPublishRun, type VisaRubric } from "../../../src/types/rubric";
import { LlmProviderError, type LlmProvider, type LlmRequest } from "../../../src/services/ai/llm-provider";
import { ROUTE_A, SOURCE_A_ID, SOURCE_A_URL } from "./fixtures/synthetic-guidance";
import { answer, crit, installRubricFakes, makeHarness, quiet, recordAnswers, resetBucket, seedSource, snapshotStore, type Harness } from "./rubric-harness";
import { MemoryLedger, ScriptedProvider as CheckerProvider, settingsWith } from "./checker-fakes";
import { REVIEW_T0 } from "./rubric-review-fixtures";
import { ScriptedProvider as AssessmentProvider, installAssessmentFakes, seedApplication, seedDocument, seedEligibility, seedStatement, seedUser, serviceWith } from "../../ai-case-officer/harness";

/* eslint-disable @typescript-eslint/no-explicit-any */

const KEY = `${ROUTE_A.countryCode}_${ROUTE_A.visaTypeId}`;
const SETTINGS_PATH = `appConfig/${PUBLISH_SETTINGS_DOC_ID}`;
const nowMs = REVIEW_T0 + 7_200_000;

// ---------- the fictional guidance ----------

const G = {
  doc: "The applicant must hold a valid travel document.",
  pay: "The applicant must show that they can pay for the visit and the return journey.",
  plan: "The applicant must give a clear account of the plan for the visit.",
  lodging: "The applicant must show where they will stay during the visit.",
  health: "The applicant must not have a condition that needs urgent treatment on arrival.",
  fee: "The applicant must have paid the application fee before the application is considered.",
  // The bar: coded group (code would decide it from nationality) with a condition and a trigger.
  bar: "A national of Ruritania who is coming for a ceremony must be refused unless they hold a ceremony visa.",
};
const BAR_COND = "who is coming for a ceremony";

const TEXT = ["Q 1.1 " + G.doc, "Q 1.2 " + G.pay, "Q 1.3 " + G.plan, "Q 1.4 " + G.lodging, "Q 1.5 " + G.health, "Q 1.6 " + G.fee, "Q 3.1 " + G.bar].join("\n");

const j = { kind: "judgement" as const, probeFactors: ["x"], requiresInterviewBeforeRefusal: false };

/** The model's hand-written answer for this page. */
function modelAnswer() {
  return answer({
    criteria: [
      crit({ ref: "doc", title: "Holds a travel document", ...j, quote: G.doc }),
      crit({ ref: "pay", title: "Can pay for the visit", ...j, quote: G.pay }),
      crit({ ref: "plan", title: "Clear plan for the visit", ...j, stage: "credibility", quote: G.plan }),
      crit({ ref: "lodging", title: "Shows where they will stay", ...j, quote: G.lodging }),
      crit({ ref: "health", title: "No urgent treatment need", ...j, quote: G.health }),
      crit({ ref: "fee", title: "Application fee paid", ...j, stage: "validity", quote: G.fee }),
      crit({ ref: "bar", title: "Ruritanian nationals coming for a ceremony refused", kind: "mandatory_bar", stage: "validity", severity: "critical", quote: G.bar, appliesTo: { nationalities: ["QR"], asWritten: ["Ruritania"] }, applicability: "conditional", applicabilityCondition: BAR_COND }),
    ],
    intakeQuestions: [
      // The purpose question: read by an ordinary rule and (through the trigger) by the bar.
      { id: "visit-purpose", label: "What is the main purpose of your visit?", helpText: null, answerType: "single_choice", required: true, criterionRefs: ["plan"], group: null, party: null, options: [{ value: "tourism", label: "Tourism", description: null }, { value: "ceremony", label: "A ceremony", description: null }], textMaxLength: null, dateRelativeToToday: null, showWhenAnyOf: [] },
      { id: "stay-where", label: "Where will you stay?", helpText: null, answerType: "text", required: true, criterionRefs: ["lodging"], group: null, party: null, options: [], textMaxLength: 200, dateRelativeToToday: null, showWhenAnyOf: [] },
    ],
    ruleTriggers: [{ criterionRef: "bar", questionId: "visit-purpose", answerValues: ["ceremony"] }],
  });
}

// ---------- wiring (the same as rubric-auto-publish-e2e.test.ts) ----------

let h: Harness;
let emails: any[] = [];

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

beforeEach(() => {
  resetStore();
  resetBucket();
  emails = [];
  store.set("users/admin1", { email: "delivered+admin1@resend.dev", admin: true });
  store.set(SETTINGS_PATH, { mode: "auto" });
  h = makeHarness();
});

/** The real extraction over the recorded answer: a pending version 1. */
async function extractDraft(): Promise<void> {
  h.state.knownVisaTypes.add(`${ROUTE_A.countryCode}/${ROUTE_A.visaTypeId}`);
  await seedSource({ id: SOURCE_A_ID, url: SOURCE_A_URL, text: TEXT });
  store.set(`guidanceSources/${SOURCE_A_ID}`, { ...(store.get(`guidanceSources/${SOURCE_A_ID}`) as any), role: "route_guidance" });
  await recordAnswers(h.provider, SOURCE_A_ID, [modelAnswer()]);
  const { result } = await quiet(() => h.service.extractRoute({ ...ROUTE_A, sourceIds: [SOURCE_A_ID] }));
  assert.equal(result.status, "succeeded");
}

/** A question model that confirms every question (wording check). */
function passingQuestionModel(): LlmProvider & { requests: LlmRequest[] } {
  const requests: LlmRequest[] = [];
  return {
    requests,
    modelFor: () => "fake-model",
    complete: async (req) => {
      requests.push(req);
      const items = JSON.parse(/<user_uploaded_document source="rubric_items">\n([\s\S]*?)\n<\/user_uploaded_document>/.exec(req.user)![1]);
      const isQuestion = "question" in items[0];
      const verdicts = items.map((it: any) => (isQuestion ? { id: it.id, asks_only_what_quote_requires: "yes", answer_type_fits: "yes", neutral_wording: "yes" } : { id: it.id, names_only_quoted_documents: "yes", party_right: "yes" }));
      return { text: JSON.stringify({ verdicts }), stopReason: "end_turn", usage: { inputTokens: 500, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 }, model: "fake-model" };
    },
  };
}

/** The pipeline. The check's judgement-role model is unsure about the bar's TRIGGER only. */
function wire(questionModel: LlmProvider & { requests: LlmRequest[] } = passingQuestionModel()) {
  const provider = new CheckerProvider();
  provider.triggerPolicy = ({ role, item }) => (role === "judgement" && item.quote === G.bar ? "unsure" : "yes");
  const checker = new RubricCheckerService({ provider: () => provider, readSnapshot: (s, hash) => snapshotStore.read(s, hash), loadSettings: settingsWith(), ledger: new MemoryLedger(), nowMs: () => nowMs, sleep: async () => undefined });
  const svc = new RubricAutoPublishService({ review: rubricReviewService as any, checker, planner: new RubricQuestionPlanner({ provider: questionModel }), now: () => Timestamp.fromMillis(nowMs), appUrl: () => "https://portal.test" });
  return { svc, provider, questionModel };
}

const trigger = async (svc: RubricAutoPublishService) => (await quiet(() => svc.onVersionCreated(KEY, 1))).result;
const audits = () => [...store.entries()].filter(([p]) => p.startsWith("rubricReviewHistory/")).map(([, d]) => d as any);
const runs = () => [...store.entries()].filter(([p]) => p.startsWith("rubricPublishRuns/")).map(([, d]) => d as unknown as RubricPublishRun);
const alerts = () => [...store.entries()].filter(([p]) => p.startsWith("scrapeAlerts/")).map(([, d]) => d as any);
const served = async (): Promise<VisaRubric> => (await rubricStore.getApprovedRubric(ROUTE_A.countryCode, ROUTE_A.visaTypeId)) as VisaRubric;
const barOf = (r: VisaRubric) => r.criteria.find((c) => c.kind === "mandatory_bar") as any;

// ============================================
// Published, named, served without the trigger
// ============================================

describe("#248 e2e: the bar's unconfirmed trigger no longer holds the rulebook", () => {
  test("published; record, alert and audit name the bar; served without its trigger, never code-decided; plan on the final rule set", async () => {
    await extractDraft();
    const w = wire();
    const r = await trigger(w.svc);
    assert.equal(r?.outcome, "published", JSON.stringify(r?.reasonCodes));
    const s = await served();
    const bar = barOf(s);
    assert.ok(bar, "the bar is served");
    assert.equal(bar.trigger, undefined, "without its unconfirmed trigger");
    assert.equal(bar.notCodeDecided, true, "never decided by code");
    assert.equal(bar.applicabilityCondition, BAR_COND);

    // ---- the run record ----
    const [run] = runs();
    assert.deepEqual(run.droppedTriggerIds, [bar.criterionId]);
    assert.deepEqual(run.barsJudgedWithoutTrigger?.map((b) => [b.criterionId, b.title, b.replaced, b.removedTrigger]), [[bar.criterionId, bar.title, false, { questionId: "visit-purpose", anyOf: ["ceremony"] }]]);
    const gate = run.gates.find((g) => g.gate === "bars_judged_without_trigger");
    assert.ok(gate?.passed && gate.detail?.includes(bar.criterionId));
    assert.equal(run.protectedFailures, undefined);
    assert.equal(run.counts.informationalFlags.conditional_rules_without_trigger, undefined, "not counted as an ordinary unanchored rule");

    // ---- the published alert ----
    const published = alerts().find((a) => a.rule === "rubric_auto_published");
    assert.ok(published);
    assert.ok(published.message.includes(bar.title), "names the bar");
    assert.ok(published.message.includes(JUDGED_BAR_NOTE), "says its trigger was not confirmed and that it is assessed by judgement");

    // ---- the audit entry ----
    const [audit] = audits();
    assert.deepEqual(audit.barsJudgedWithoutTrigger, [{ criterionId: bar.criterionId, title: bar.title, note: JUDGED_BAR_NOTE }]);

    // ---- the question plan: the removed trigger no longer links the question to the bar; the question stays ----
    const q = s.intakeQuestions.find((x) => x.id === "visit-purpose") as any;
    assert.ok(q, "the trigger question is kept (another rule reads it)");
    assert.ok(!q.criterionIds.includes(bar.criterionId), "the bar left its links");
    assert.ok(!(bar.intakeQuestionIds ?? []).includes("visit-purpose"));
  });

  test("a held run re-run by the sweep makes NO new rule-check request and then publishes", async () => {
    await extractDraft();
    // The planner's model fails once: the first run is held for a retryable reason after the rule check ran.
    const good = passingQuestionModel();
    let failures = 1;
    const flaky: LlmProvider & { requests: LlmRequest[] } = { requests: good.requests, modelFor: () => "fake-model", complete: async (req) => { if (failures-- > 0) throw new LlmProviderError("provider_error", "status=529 overloaded"); return good.complete(req); } };
    const w = wire(flaky);
    const first = await trigger(w.svc);
    assert.deepEqual(first?.reasonCodes, ["question_plan_unusable"], "the bar did NOT hold it");
    const before = w.provider.requests.length;
    await quiet(() => w.svc.sweepRetryable());
    assert.equal(w.provider.requests.length, before, "zero new rule-check requests: every answer is stored");
    assert.equal(runs()[0].outcome, "published");
  });
});

// ============================================
// The assessment, in both directions
// ============================================

describe("#248 e2e: the assessment never code-decides the bar, and still puts it to the applicant it covers", () => {
  function seedCase(id: string, nationality: string, answers: Record<string, unknown>): void {
    seedApplication({ id, visaTypeId: ROUTE_A.visaTypeId });
    store.set(`applications/${id}`, { ...(store.get(`applications/${id}`) as any), countryCode: ROUTE_A.countryCode, intake: { routeKey: KEY, rubricVersion: 1, answers, updatedAt: null } });
    seedUser("client-1", "Ada", "Lovelace");
    seedEligibility({ nationality, score: 80, visaTypeId: ROUTE_A.visaTypeId });
    seedDocument({ id: `doc-${id}`, applicationId: id, key: "bank", label: "Bank statement" });
    seedStatement({ id: `stmt-${id}`, applicationId: id, text: "I am coming for my cousin's ceremony." });
  }

  /** A fake assessment model that raises a concern on `concernOn` (when shown it) and nothing else. */
  const judge = (concernOn: string | null) =>
    new AssessmentProvider((req) => {
      if (req.role === "extraction") {
        const fields = /Fields to report: ([^\n]*)\./.exec(req.user)?.[1].split(", ") ?? [];
        return JSON.stringify({ readable: true, values: fields.map((field) => ({ field, value: "x", unit: null, page: 1, quote: "q" })) });
      }
      const ids = [...req.user.matchAll(/^- (\S+) \|/gm)].map((m) => m[1]);
      const findings = concernOn && ids.includes(concernOn) ? [{ criterionId: concernOn, detail: "The applicant says the visit is for a ceremony.", whatWouldHelp: "Check with your agent which visa fits this visit.", concern: true }] : [];
      return JSON.stringify({ findings, strengths: [], statementNotes: [], suspiciousPassages: [] });
    });

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

  test("ELIGIBLE direction: a national of the coded group whose visit is NOT the condition's is not refused by code", async () => {
    await extractDraft();
    await trigger(wire().svc);
    const barId = barOf(await served()).criterionId;
    seedCase("app-tourist", "QR", { "visit-purpose": "tourism" });
    const provider = judge(null);
    const stored = await assess("app-tourist", provider);
    assert.equal(stored.status, "succeeded");
    assert.equal(stored.refusalGrounds.some((g: any) => g.criterionId === barId), false, "no code refusal from nationality alone");
    assert.equal(stored.hasBlockingRule, false);
    // The bar was put to the model in full (judged), never as "could not tell".
    const prompt = provider.requests.filter((r) => r.role === "judgement").map((r) => r.user).join("\n");
    const line = prompt.split("\n").find((l) => l.startsWith(`- ${barId} |`)) ?? "";
    assert.ok(line.includes("NOT decided by code") && line.includes("Ruritania") && line.includes(BAR_COND) && line.includes(G.bar));
    assert.equal(stored.insufficientInformation.some((i: any) => i.criterionId === barId && i.notAssessed), false);
  });

  test("BARRED direction: the applicant the bar covers is put to the model, and its concern is a flag marked as a bar (never a refusal ground)", async () => {
    await extractDraft();
    await trigger(wire().svc);
    const barId = barOf(await served()).criterionId;
    seedCase("app-ceremony", "QR", { "visit-purpose": "ceremony" });
    const stored = await assess("app-ceremony", judge(barId));
    assert.equal(stored.status, "succeeded");
    const flag = stored.credibilityFlags.find((f: any) => f.criterionId === barId);
    assert.ok(flag, "the concern reaches the applicant's assessment");
    assert.equal(flag.isMandatoryBar, true);
    assert.equal(flag.kind, "mandatory_bar");
    assert.equal(stored.refusalGrounds.some((g: any) => g.criterionId === barId), false, "the model never creates a refusal");
    assert.notEqual(stored.readiness, "strong");
  });
});
