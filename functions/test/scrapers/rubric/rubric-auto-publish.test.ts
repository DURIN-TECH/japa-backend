// ============================================
// Automatic rubric publishing (issue #201) — the pipeline, end to end
// ============================================
//
// No network, no model, no emulator: the in-memory Firestore fake, the in-memory
// snapshot bucket of the #40 harness, the REAL review service (its approval
// transaction) and the REAL alert engine (with a captured email sender). The
// two plug-in points (the independent check of part B and the question plan of
// part C) are stubs written here.
//
// What is proved:
//   - settings and the kill switch (manual does nothing; unreadable fails closed);
//   - `auto` HOLDS every draft until the two plug-ins exist;
//   - with stubs, a clean draft is published through the SAME approval code
//     (`decideAs`, spied), by the named system actor, and the audit entry has
//     the shape of a human approval plus the marker; both existing triggers'
//     services accept it unchanged, and the rule-change event carries the
//     exclusion-aware diff;
//   - idempotency (a re-delivered trigger publishes nothing twice);
//   - every hold path leaves the head and the version untouched and alerts;
//   - the shared transaction still enforces its invariants for the system actor;
//   - alerts: raised, bumped, auto-resolved; an alert failure never undoes a publish;
//   - the admin endpoints (settings GET / PATCH, auto-publish, dry run) and
//     their role matrix over the real router and the real `verifyAuth`;
//   - the CLI refuses to run without an explicit project and refuses production.
//
// Fixtures: the invented route A of rubric-review-fixtures.ts. No real rule.

import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawnSync } from "node:child_process";
import type { AddressInfo } from "node:net";
import express from "express";
import { Timestamp } from "firebase-admin/firestore";
import { ROLES } from "@durin-tech/authz";
import { fakeCollection, fakeRunTransaction, installFakes, resetStore, store, writes } from "../../helpers/fake-firestore";
import { fakeCollectionGroup } from "../../helpers/fake-collection-group";
import { installAdminClaimsFromUserDocs } from "../../helpers/fake-admin-claims";
import { rubricStore } from "../../../src/scrapers/rubric/rubric.store";
import type { RubricDraft } from "../../../src/scrapers/rubric/rubric.store";
import { PUBLISH_SETTINGS_DOC_ID, publishSettingsTx } from "../../../src/scrapers/rubric/rubric-publish-settings";
import { scrapeAlertService } from "../../../src/scrapers/shared/alerts/scrape-alert.service";
import { BulkReassessmentService } from "../../../src/services/ai-bulk-reassessment.service";
import { RuleChangeAlertsService } from "../../../src/services/rule-change-alerts.service";
import {
  RubricAutoPublishService,
  SUPERSEDED_REASON,
  type QuestionPlanner,
  type RubricCheckInput,
  type RubricCheckOutcome,
  type RubricChecker,
  rubricAutoPublishService,
} from "../../../src/services/rubric-auto-publish.service";
import { RubricReviewError, rubricReviewService, rubricVersionId } from "../../../src/services/rubric-review.service";
import { RUBRIC_ACTOR_KIND, RUBRIC_SYSTEM_ACTOR_ID, isRubricSystemActor, type IntentPolarity, type RubricPublishRun } from "../../../src/types/rubric";
import { adminRubricRoutes } from "../../../src/routes/rubric-review.routes";
import { A_LINES, A_TEXT, ROUTE_A, SOURCE_A_ID, SOURCE_A_URL, SOURCE_B_ID, SOURCE_B_URL, B_PAGES } from "./fixtures/synthetic-guidance";
import { headDoc, installRubricFakes, quiet, resetBucket, seedSource, snapshotStore, versionDoc } from "./rubric-harness";
import { A2_POLARITY_QUOTE, A2_TEXT, A_POLARITY_QUOTE, KEY_A, KEY_B, REVIEW_T0, body, criterion, draft, routeBV1, sourceA } from "./rubric-review-fixtures";

/* eslint-disable @typescript-eslint/no-explicit-any */

// ============================================
// Wiring
// ============================================

const ID_A1 = rubricVersionId(KEY_A, 1);
const ID_A2 = rubricVersionId(KEY_A, 2);
const SETTINGS_PATH = `appConfig/${PUBLISH_SETTINGS_DOC_ID}`;
const SYSTEM = { kind: RUBRIC_ACTOR_KIND.SYSTEM, id: RUBRIC_SYSTEM_ACTOR_ID } as const;

/** The review-clock and the pipeline clock. */
const nowMs = REVIEW_T0 + 7_200_000;

/** Decoded ID tokens by bearer token, one per role. */
const TOKENS: Record<string, any> = {
  "t-admin": { uid: "admin-uid", role: ROLES.ADMIN },
  "t-client": { uid: "client-uid", role: ROLES.CLIENT },
  "t-agent": { uid: "agent-uid", role: ROLES.AGENT, agencyId: "agency-1" },
  "t-owner": { uid: "owner-uid", role: ROLES.OWNER, agencyId: "agency-1" },
};

let server: http.Server;
let baseUrl = "";
let emails: any[] = [];

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
  firebase.auth.verifyIdToken = async (token: string) => {
    const decoded = TOKENS[token];
    if (!decoded) throw new Error("invalid token");
    return decoded;
  };
  const { entitlementService }: any = await import("../../../src/services/entitlement.service");
  entitlementService.getEntitlements = async () => null;
  const { claimsService }: any = await import("../../../src/services/claims.service");
  claimsService.resolveRoleFromDb = async () => ({ role: ROLES.CLIENT, agencyId: null });
  claimsService.setRoleClaims = async () => undefined;

  rubricStore.runTransaction = fakeRunTransaction as any;
  rubricReviewService.runTransaction = fakeRunTransaction as any;
  publishSettingsTx.run = fakeRunTransaction as any;
  (rubricReviewService as any).deps.snapshots = snapshotStore;
  (rubricReviewService as any).deps.now = () => Timestamp.fromMillis(nowMs);
  // Never send an email: capture what the alert engine would send.
  scrapeAlertService.notify = async (input: any) => void emails.push(input);
  scrapeAlertService.log = () => undefined;
  scrapeAlertService.realClock = () => nowMs;

  const app = express();
  app.use(express.json());
  app.use("/admin/rubrics", adminRubricRoutes);
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => new Promise((resolve) => server.close(resolve)));

beforeEach(() => {
  resetStore();
  resetBucket();
  emails = [];
  store.set("users/admin1", { email: "delivered+admin1@resend.dev", admin: true });
  // The endpoint's singleton must not reach the real alert engine's config read with a stray service.
  rubricAutoPublishService.registerChecker(null);
  rubricAutoPublishService.registerPlanner(null);
});

// ============================================
// Fixtures and helpers
// ============================================

/** A rulebook of ten rules from route A's page (a leave-out of one stays inside the 15% budget). */
function bigDraft(hash: string, opts: { flags?: (ids: string[]) => { code: string; message: string; target: string }[]; extra?: Partial<RubricDraft>; noProposal?: boolean } = {}): RubricDraft {
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
  const d = draft(ROUTE_A, [s], criteria, { proposal: opts.noProposal ? null : { value: "immigrant_intent_penalised", quote: A_POLARITY_QUOTE }, ...(opts.extra ? { extra: opts.extra } : {}) });
  if (opts.flags) d.flags = [...d.flags, ...opts.flags(criteria.map((c) => c.criterionId))];
  return d;
}

/** Store a draft as its route's next version (the path extraction uses). */
async function write(d: RubricDraft): Promise<number> {
  return (await rubricStore.writePendingVersion(d, d.sourceSnapshots.map((s) => s.sourceId), { now: d.createdAt, force: true })).version;
}

/** Seed route A's page (with the registry role of its source) and a draft as version 1. */
async function seedA(opts: Parameters<typeof bigDraft>[1] = {}, role: string | undefined = "route_guidance"): Promise<string> {
  const hash = await seedSource({ id: SOURCE_A_ID, url: SOURCE_A_URL, text: A_TEXT });
  setRole(role);
  await write(bigDraft(hash, opts));
  return hash;
}

/** Set the registry role of route A's source (seeding a source rewrites its entry without one). */
function setRole(role: string | undefined): void {
  const key = `guidanceSources/${SOURCE_A_ID}`;
  const doc: any = { ...(store.get(key) as any) };
  if (role === undefined) delete doc.role;
  else doc.role = role;
  store.set(key, doc);
}

/** Write the publish settings doc. */
const settings = (over: Record<string, unknown> = { mode: "auto" }) => store.set(SETTINGS_PATH, over);

/** Stored audit entries, oldest first. */
const audits = () => [...store.entries()].filter(([p]) => p.startsWith("rubricReviewHistory/")).map(([, d]) => d as any);
/** Stored publish run records. */
const runs = () => [...store.entries()].filter(([p]) => p.startsWith("rubricPublishRuns/")).map(([, d]) => d as unknown as RubricPublishRun);
/** Stored scrape alerts. */
const alerts = () => [...store.entries()].filter(([p]) => p.startsWith("scrapeAlerts/")).map(([, d]) => d as any);

/** A checker stub that returns `out` and counts its calls. */
function checkerStub(out: RubricCheckOutcome | ((i: RubricCheckInput) => RubricCheckOutcome) = { ok: true, leftOut: [], resolvedFlagCodes: [], intentPolarity: "immigrant_intent_penalised" }): RubricChecker & { calls: RubricCheckInput[] } {
  const calls: RubricCheckInput[] = [];
  return { calls, check: async (i) => (calls.push(i), typeof out === "function" ? out(i) : out) };
}

/** A planner stub. */
function plannerStub(out: Awaited<ReturnType<QuestionPlanner["plan"]>> = { ok: true }): QuestionPlanner & { calls: number } {
  const p = { calls: 0, plan: async () => (p.calls++, out) };
  return p;
}

/** The pipeline over the fakes, with `decideAs` spied. */
function service(over: ConstructorParameters<typeof RubricAutoPublishService>[0] = {}): RubricAutoPublishService & { decideCalls: any[][] } {
  const decideCalls: any[][] = [];
  const review = {
    decideAs: (...args: any[]) => (decideCalls.push(args), (rubricReviewService as any).decideAs(...args)),
    knownEligibilityIds: (r: any) => rubricReviewService.knownEligibilityIds(r),
  };
  const svc: any = new RubricAutoPublishService({ review: review as any, now: () => Timestamp.fromMillis(nowMs), appUrl: () => "https://portal.test", ...over });
  svc.decideCalls = decideCalls;
  return svc;
}

/** A service with both plug-ins present and passing. */
const fullService = () => service({ checker: checkerStub(), planner: plannerStub() });

/** Run the trigger path with console output silenced. */
const trigger = async (svc: RubricAutoPublishService, routeKey = KEY_A, version = 1) => (await quiet(() => svc.onVersionCreated(routeKey, version))).result;

/** Everything that must NOT have changed when a draft is held. */
function assertUntouched(routeKey: string, version: number, auditCount: number, approved: number | null): void {
  assert.equal(versionDoc(routeKey, version).reviewStatus, "pending_review");
  assert.equal(versionDoc(routeKey, version).reviewedBy, null);
  assert.equal(headDoc(routeKey).approvedVersion, approved);
  assert.equal(audits().length, auditCount);
}

// ============================================
// Settings and the kill switch
// ============================================

describe("auto-publish: mode and settings", () => {
  test("no settings doc = manual: nothing happens (no record, no check, no alert, no email)", async () => {
    await seedA();
    const checker = checkerStub();
    const r = await trigger(service({ checker, planner: plannerStub() }));
    assert.equal(r?.outcome, "skipped");
    assert.deepEqual(r?.reasonCodes, ["mode_manual"]);
    assert.equal(checker.calls.length, 0);
    assert.equal(runs().length, 0);
    assert.equal(alerts().length, 0);
    assert.equal(emails.length, 0);
    assertUntouched(KEY_A, 1, 0, null);
  });

  test("an explicit `manual` doc behaves the same", async () => {
    await seedA();
    settings({ mode: "manual" });
    const r = await trigger(fullService());
    assert.equal(r?.outcome, "skipped");
    assert.equal(runs().length, 0);
    assertUntouched(KEY_A, 1, 0, null);
  });

  test("an unreadable settings doc fails closed: skipped as settings_unreadable, a CRITICAL alert, nothing published, no check", async () => {
    await seedA();
    const checker = checkerStub();
    const real = (await import("../../../src/utils/firebase") as any).collections.appConfig;
    (await import("../../../src/utils/firebase") as any).collections.appConfig = {
      doc: (id: string) => (id === PUBLISH_SETTINGS_DOC_ID ? { get: async () => { throw Object.assign(new Error("unavailable"), { code: 14 }); } } : real.doc(id)),
    };
    try {
      const r = await trigger(service({ checker, planner: plannerStub() }));
      assert.equal(r?.outcome, "skipped");
      assert.deepEqual(r?.reasonCodes, ["settings_unreadable"]);
      assert.equal(runs().length, 1);
      assert.deepEqual(runs()[0].reasonCodes, ["settings_unreadable"]);
      assert.equal(runs()[0].mode, "manual");
      assert.equal(alerts().length, 1);
      assert.equal(alerts()[0].rule, "rubric_draft_held");
      assert.equal(alerts()[0].severity, "critical");
      assert.equal(checker.calls.length, 0);
      assertUntouched(KEY_A, 1, 0, null);
    } finally {
      (await import("../../../src/utils/firebase") as any).collections.appConfig = real;
    }
  });

  test("a route outside the allowlist is skipped (recorded, no alert, no check)", async () => {
    await seedA();
    settings({ mode: "auto", routeAllowlist: ["XZ_other-route"] });
    const checker = checkerStub();
    const r = await trigger(service({ checker, planner: plannerStub() }));
    assert.equal(r?.outcome, "skipped");
    assert.deepEqual(r?.reasonCodes, ["route_not_in_allowlist"]);
    assert.equal(runs().length, 1);
    assert.equal(alerts().length, 0);
    assert.equal(checker.calls.length, 0);
    assertUntouched(KEY_A, 1, 0, null);
  });

  test("a route inside the allowlist is processed", async () => {
    await seedA();
    settings({ mode: "auto", routeAllowlist: [KEY_A] });
    assert.equal((await trigger(fullService()))?.outcome, "published");
  });
});

// ============================================
// Until parts B and C exist, `auto` holds everything
// ============================================

describe("auto-publish: the plug-in points hold when empty", () => {
  test("auto with no checker and no planner holds with both reasons; nothing changes; one alert; one record", async () => {
    await seedA();
    settings();
    const svc = service();
    const r = await trigger(svc);
    assert.equal(r?.outcome, "held");
    assert.deepEqual(r?.reasonCodes, ["checker_not_configured", "question_plan_missing"]);
    assert.equal(r?.checker, "not_configured");
    assert.equal(r?.questionPlan, "not_configured");
    assert.equal(r?.codeGatesPassed, true);
    assertUntouched(KEY_A, 1, 0, null);
    assert.equal(svc.decideCalls.length, 0, "the approval transaction was never asked");
    assert.equal(runs().length, 1);
    assert.equal(runs()[0].outcome, "held");
    assert.equal(runs()[0].runId, ID_A1);
    assert.equal(runs()[0].attempts, 1);
    assert.equal(alerts().length, 1);
    assert.equal(alerts()[0].rule, "rubric_draft_held");
    assert.equal(alerts()[0].dedupeKey, `rubric_draft_held:${ID_A1}`);
    assert.equal(alerts()[0].severity, "warning");
    assert.match(alerts()[0].message, /independent AI check is not set up yet/);
    assert.match(alerts()[0].message, /question plan is not set up yet/);
    assert.match(alerts()[0].message, /https:\/\/portal\.test\/admin\/visa-review\?tab=rubrics&rubric=XA_xa-short-visit__v1/);
  });

  test("one plug-in present and the other missing still holds, and the present one is not spent", async () => {
    await seedA();
    settings();
    const checker = checkerStub();
    const r = await trigger(service({ checker }));
    assert.deepEqual(r?.reasonCodes, ["question_plan_missing"]);
    assert.equal(checker.calls.length, 0);
    const planner = plannerStub();
    const r2 = (await quiet(() => service({ planner }).run(KEY_A, 1, { trigger: "admin_endpoint" }))).result;
    assert.deepEqual(r2.reasonCodes, ["checker_not_configured"]);
    assert.equal(planner.calls, 0);
  });

  test("a stub checker that fails, throws, or whose planner fails or throws: held, head unchanged", async () => {
    const cases: [string, RubricChecker | null, QuestionPlanner | null, string[]][] = [
      ["checker not ok", checkerStub({ ok: false, reasonCodes: ["checker_capped"] }), plannerStub(), ["checker_capped"]],
      ["checker protected failure", checkerStub({ ok: false, reasonCodes: ["protected_rule_failed:x"], protectedRuleIds: ["x"] }), plannerStub(), ["protected_rule_failed:x"]],
      ["checker throws", { check: async () => { throw new Error("boom"); } }, plannerStub(), ["checker_unavailable:internal"]],
      ["planner not ok", checkerStub(), plannerStub({ ok: false, reasonCodes: ["question_plan_unusable"] }), ["question_plan_unusable"]],
      ["planner throws", checkerStub(), { plan: async () => { throw new Error("boom"); } }, ["question_plan_unusable"]],
      ["polarity not verified", checkerStub({ ok: true, leftOut: [], resolvedFlagCodes: [], intentPolarity: null }), plannerStub(), ["polarity_unverified"]],
    ];
    for (const [name, checker, planner, expected] of cases) {
      resetStore();
      resetBucket();
      store.set("users/admin1", { email: "delivered+admin1@resend.dev", admin: true });
      await seedA();
      settings();
      const r = await trigger(service({ checker, planner }));
      assert.equal(r?.outcome, "held", name);
      assert.deepEqual(r?.reasonCodes, expected, name);
      assertUntouched(KEY_A, 1, 0, null);
      assert.equal(alerts().length, 1, name);
    }
  });

  test("the planner is only called when the check passed with no reason", async () => {
    await seedA();
    settings();
    const planner = plannerStub();
    await trigger(service({ checker: checkerStub({ ok: false, reasonCodes: ["checker_unavailable"] }), planner }));
    assert.equal(planner.calls, 0);
  });
});

// ============================================
// Publishing through the shared transaction
// ============================================

describe("auto-publish: a clean draft is published through the SAME approval code", () => {
  test("outcome, version, head and the audit entry of the system actor", async () => {
    await seedA();
    settings();
    const svc = fullService();
    const r = await trigger(svc);
    assert.equal(r?.outcome, "published");
    assert.deepEqual(r?.reasonCodes, []);
    assert.equal(r?.codeGatesPassed, true);
    // The approval code was called exactly once, with the system actor and the run id: not a second path.
    assert.equal((svc as any).decideCalls.length, 1);
    const [id, input, actor, extras] = (svc as any).decideCalls[0];
    assert.equal(id, ID_A1);
    assert.equal(input.action, "approve");
    assert.deepEqual(actor, { kind: "system", id: "system:rubric-auto-publish" });
    assert.equal(extras.publishRunId, ID_A1);

    const v = versionDoc(KEY_A, 1);
    assert.equal(v.reviewStatus, "approved");
    assert.equal(v.reviewedBy, RUBRIC_SYSTEM_ACTOR_ID);
    assert.equal(isRubricSystemActor(v.reviewedBy), true);
    assert.equal(v.intentPolarity, "immigrant_intent_penalised");
    assert.equal(v.excludedCriterionIds, undefined, "nothing left out: no exclusion fields");
    assert.equal(v.exclusionNote, undefined);
    assert.equal(v.outcomeStatistics, undefined, "outcomeStatistics is left unset");
    assert.equal(v.evidenceHelpsCriterionIds, undefined, "evidenceHelpsCriterionIds is left unset");
    assert.equal(headDoc(KEY_A).approvedVersion, 1);
    assert.equal((await rubricStore.getApprovedRubric(ROUTE_A.countryCode, ROUTE_A.visaTypeId))?.version, 1);

    const [a] = audits();
    assert.equal(audits().length, 1);
    assert.equal(a.action, "approve");
    assert.equal(a.by, RUBRIC_SYSTEM_ACTOR_ID);
    assert.equal(a.automatic, true);
    assert.equal(a.publishRunId, ID_A1);
    assert.equal(a.approvedVersion, 1);
    assert.equal(a.previousApprovedVersion, null);
    assert.equal(a.intentPolarity, "immigrant_intent_penalised");
    assert.equal(a.intentPolarityOverridden, false);
    assert.equal(a.outcomeStatistics, null);
    assert.equal(a.evidenceHelpsCriterionIds, null);
    assert.equal(a.exclusionCount, 0);
    assert.deepEqual(a.confirmedPrimaryExclusions, []);

    // The run record.
    const run = runs()[0];
    assert.equal(run.outcome, "published");
    assert.equal(run.auditId, a.id);
    assert.equal(run.mode, "auto");
    assert.equal(run.trigger, "version_created");
    assert.equal(run.checker, "passed");
    assert.equal(run.questionPlan, "built");
    assert.equal(run.counts.rules, 10);
    assert.equal(run.counts.kept, 10);
    assert.deepEqual(run.reasonCodes, []);
    assert.ok(run.gates.every((g) => g.gate === "checker_resolved_flags" || g.passed));
  });

  test("the audit entry has EXACTLY the keys of a human approval, plus the system marker", async () => {
    // A human approval of another route...
    const hashB = await seedSource({ id: SOURCE_B_ID, url: SOURCE_B_URL, pages: B_PAGES });
    await write(routeBV1(hashB));
    await rubricReviewService.decide(rubricVersionId(KEY_B, 1), { action: "approve", revision: 0, intentPolarity: "dual_intent_permitted", acknowledgedFlags: [], reason: null }, "admin-uid");
    // ...and the automatic publish of route A.
    await seedA();
    settings();
    await trigger(fullService());
    const [human, automatic] = audits();
    assert.equal(human.by, "admin-uid");
    assert.equal(human.automatic, undefined);
    const keys = (o: any) => Object.keys(o).sort();
    assert.deepEqual(keys(automatic), [...keys(human), "automatic", "publishRunId"].sort());
    // The version carries the same review fields a human approval writes.
    const reviewKeys = (v: any) => ["reviewStatus", "intentPolarity", "reviewedBy", "reviewedAt", "rejectReason", "revision", "supersededAt"].map((k) => `${k}:${typeof v[k]}`);
    assert.deepEqual(reviewKeys(versionDoc(KEY_A, 1)), reviewKeys(versionDoc(KEY_B, 1)));
  });

  test("the review service refuses a person whose uid is the system id, and the system id outside the system actor", async () => {
    await seedA();
    const input = { action: "approve" as const, revision: 0, intentPolarity: "immigrant_intent_penalised" as IntentPolarity, acknowledgedFlags: [], reason: null };
    await assert.rejects(rubricReviewService.decide(ID_A1, input, RUBRIC_SYSTEM_ACTOR_ID), /reserved/);
    await assert.rejects(rubricReviewService.decideAs(ID_A1, input, { kind: RUBRIC_ACTOR_KIND.ADMIN, uid: "admin-uid" }, { publishRunId: "x" }), /system actor/);
    await assert.rejects(rubricReviewService.decideAs(ID_A1, input, { kind: RUBRIC_ACTOR_KIND.SYSTEM, id: "system:other" as any }), /unknown system actor/);
    assert.equal(versionDoc(KEY_A, 1).reviewStatus, "pending_review");
  });

  test("planner review fields outside the allow-list are refused (nothing is written)", async () => {
    await seedA();
    settings();
    const svc = service({ checker: checkerStub(), planner: plannerStub({ ok: true, reviewFields: { reviewStatus: "approved", questionPlan: {} } }) });
    const r = await trigger(svc);
    assert.equal(r?.outcome, "held");
    assert.deepEqual(r?.reasonCodes, ["pipeline_error"]);
    assertUntouched(KEY_A, 1, 0, null);
  });

  test("downstream triggers: bulk re-assessment starts and a rule-change event with the exclusion-aware diff is recorded for a second automatic approval", async () => {
    await seedA();
    settings();
    await trigger(fullService());
    const firstAudit = audits()[0];
    // Bulk re-assessment (onRubricApproved) accepts the entry unchanged.
    const bulk = new BulkReassessmentService();
    assert.equal((await quiet(() => bulk.startRun(firstAudit.id, firstAudit))).result, "started");
    const run: any = store.get(`bulkReassessments/${firstAudit.id}`);
    assert.equal(run.approvedBy, RUBRIC_SYSTEM_ACTOR_ID, "the system id is copied, never looked up as a user");
    // The first approval replaces nothing: the rule-change service records a skipped event.
    const changes = new RuleChangeAlertsService({ getRubricVersion: (k: string, v: number) => rubricStore.getVersionForReview(k, v), now: () => new Date(nowMs) } as any);
    assert.equal((await quiet(() => changes.recordRubricApproval(firstAudit.id, firstAudit))).result, "skipped");

    // Version 2: a re-draft of the same page in which one rule is left out by a flag; a second automatic approval.
    const hash = (store.get(`guidanceSources/${SOURCE_A_ID}`) as any).latestSnapshotId;
    await write(bigDraft(hash, { flags: (ids) => [{ code: "quote_starts_mid_sentence", message: "m", target: ids[5] }], extra: { createdAt: Timestamp.fromMillis(REVIEW_T0 + 86_400_000) } }));
    assert.equal((await trigger(fullService(), KEY_A, 2))?.outcome, "published");
    const second = audits()[1];
    assert.equal(second.by, RUBRIC_SYSTEM_ACTOR_ID);
    assert.equal(second.previousApprovedVersion, 1);
    assert.equal(second.excludedCriterionIds.length, 1);
    assert.equal((await quiet(() => changes.recordRubricApproval(second.id, second))).result, "recorded");
    const event: any = [...store.values()].find((d: any) => d.sourceKind === "guidance" && d.status === "pending");
    assert.equal(event.approvedBy, RUBRIC_SYSTEM_ACTOR_ID);
    assert.equal(event.rubricSummary.removedCount, 1, "the left-out rule is a removal for applicants");
    assert.equal(event.rubricSummary.addedCount, 0);
  });
});

// ============================================
// Leave-outs
// ============================================

describe("auto-publish: per-rule leave-outs go through the existing exclusion mechanism", () => {
  test("a flagged rule is excluded with a code-written note; the rule itself is never edited", async () => {
    await seedA({ flags: (ids) => [{ code: "quote_starts_mid_sentence", message: "m", target: ids[5] }] });
    settings();
    const before = JSON.stringify(versionDoc(KEY_A, 1).criteria);
    const r = await trigger(fullService());
    assert.equal(r?.outcome, "published");
    const v = versionDoc(KEY_A, 1);
    assert.equal(v.excludedCriterionIds.length, 1);
    assert.equal(v.excludedCriterionIds[0], r?.leftOut[0].criterionId);
    assert.match(v.exclusionNote, /^Automatic publish XA_xa-short-visit__v1: 1 of 10 rules left out \(quote_starts_mid_sentence: 1\)\.$/);
    assert.equal(JSON.stringify(v.criteria), before, "no rule was edited or reworded");
    assert.deepEqual(r?.counts.leftOutByReason, { quote_starts_mid_sentence: 1 });
    // What applicants get lacks the rule; the bar is intact.
    const served = await rubricStore.getApprovedRubric(ROUTE_A.countryCode, ROUTE_A.visaTypeId);
    assert.equal(served?.criteria.length, 9);
    assert.ok(served?.criteria.some((c) => c.kind === "mandatory_bar"));
    // The flag was acknowledged only because the gate recorded a result for it.
    const a = audits()[0];
    assert.deepEqual(a.acknowledgedFlags.map((f: any) => f.code), ["quote_starts_mid_sentence"]);
    assert.equal(a.exclusionCount, 1);
    assert.deepEqual(a.excludedCriterionIds, v.excludedCriterionIds);
  });

  test("a leave-out from a PRIMARY source is confirmed by the system's own list and recorded; from another source it is not needed", async () => {
    await seedA({ flags: (ids) => [{ code: "combined_sub_conditions", message: "m", target: ids[5] }] }, "primary");
    settings();
    const r = await trigger(fullService());
    assert.equal(r?.outcome, "published");
    const id = r?.leftOut[0].criterionId;
    assert.deepEqual(audits()[0].confirmedPrimaryExclusions, [id]);
    assert.equal(r?.counts.leftOut, 1);
    // The alert lists the primary-source leave-out by title.
    const published = alerts().find((x) => x.rule === "rubric_auto_published");
    assert.match(published.message, /Left out from the main official source \(1\): No set level of funds/);

    resetStore();
    resetBucket();
    store.set("users/admin1", { email: "delivered+admin1@resend.dev", admin: true });
    await seedA({ flags: (ids) => [{ code: "combined_sub_conditions", message: "m", target: ids[5] }] }, "route_guidance");
    settings();
    await trigger(fullService());
    assert.deepEqual(audits()[0].confirmedPrimaryExclusions, []);
  });

  test("a protected rule with a leave-out flag HOLDS (critical) and is never excluded", async () => {
    await seedA({ flags: (ids) => [{ code: "quote_ends_mid_sentence", message: "m", target: ids[3] }] });
    settings();
    const r = await trigger(fullService());
    assert.equal(r?.outcome, "held");
    assert.equal(r?.reasonCodes[0].startsWith("protected_rule_flagged:"), true);
    assert.equal(r?.counts.held, 1);
    assertUntouched(KEY_A, 1, 0, null);
    assert.equal(alerts()[0].severity, "critical");
  });
});

// ============================================
// Idempotency
// ============================================

describe("auto-publish: idempotent per version", () => {
  test("a re-delivered trigger on a published version publishes nothing twice: one audit doc, one head move, one record", async () => {
    await seedA();
    settings();
    const svc = fullService();
    const first = await trigger(svc);
    const headWrites = () => writes.filter((w) => w.path === `visaRubrics/${KEY_A}` && w.op === "update").length;
    const writesAfterFirst = writes.length;
    const again = await trigger(svc);
    assert.equal(first?.outcome, "published");
    // The version is decided, so the second delivery is a quiet no-op.
    assert.equal(again?.outcome, "skipped");
    assert.deepEqual(again?.reasonCodes, ["already_decided"]);
    assert.equal(again?.recorded, false);
    assert.equal(audits().length, 1);
    assert.equal(runs().length, 1);
    assert.equal(headWrites(), 1);
    assert.equal(writes.length, writesAfterFirst, "the second delivery wrote nothing at all");
    assert.equal((svc as any).decideCalls.length, 1);
  });

  test("a re-delivered trigger on a HELD version writes nothing and does not alert again", async () => {
    await seedA();
    settings();
    const svc = service();
    await trigger(svc);
    const alertsBefore = JSON.stringify(alerts());
    const writesBefore = writes.length;
    const again = await trigger(svc);
    assert.equal(again?.outcome, "held");
    assert.equal(writes.length, writesBefore);
    assert.equal(JSON.stringify(alerts()), alertsBefore);
    assert.equal(emails.length, 1);
  });

  test("a trigger delivered for a version somebody already decided does nothing", async () => {
    await seedA();
    settings();
    await rubricReviewService.decide(ID_A1, { action: "reject", revision: 0, reason: "Rejected by a person." }, "admin-uid");
    const r = await trigger(fullService());
    assert.equal(r?.outcome, "skipped");
    assert.deepEqual(r?.reasonCodes, ["already_decided"]);
    assert.equal(runs().length, 0);
    assert.equal(versionDoc(KEY_A, 1).reviewStatus, "rejected");
  });

  test("the record is created with create(): a duplicate loses and is ignored", async () => {
    await seedA();
    settings();
    const svc = service();
    store.set(`rubricPublishRuns/${ID_A1}`, { outcome: "held", reasonCodes: ["x"], attempts: 1, mode: "auto" });
    const r = await trigger(svc);
    assert.equal(r?.outcome, "held");
    assert.deepEqual(r?.reasonCodes, ["x"], "the existing record wins; nothing was re-run");
    assert.equal(alerts().length, 0);
  });
});

// ============================================
// Older pending versions
// ============================================

describe("auto-publish: older pending versions are rejected by the system when a newer one publishes", () => {
  test("version 1 (pending) is rejected with superseded_by_newer_version when version 2 publishes", async () => {
    await seedA();
    const hash2 = await seedSource({ id: SOURCE_A_ID, url: SOURCE_A_URL, text: A2_TEXT });
    setRole("route_guidance");
    const s2 = sourceA(hash2);
    const d2 = draft(
      ROUTE_A,
      [s2],
      [
        criterion(s2, { title: "Aged 21 or over", kind: "objective", ruleRef: "SV 2.1", quote: "An applicant must be aged 21 or over on the date of application.", check: { field: "applicant.age", op: "gte", value: 21 } }),
        criterion(s2, { title: "Intention to settle later", kind: "judgement", stage: "credibility", quote: A2_POLARITY_QUOTE, concernsIntent: true }),
      ],
      { proposal: { value: "dual_intent_permitted", quote: A2_POLARITY_QUOTE }, createdAtMs: REVIEW_T0 + 86_400_000 }
    );
    await write(d2);
    settings();
    const checker = checkerStub({ ok: true, leftOut: [], resolvedFlagCodes: [], intentPolarity: "dual_intent_permitted" });
    const r = await trigger(service({ checker, planner: plannerStub() }), KEY_A, 2);
    assert.equal(r?.outcome, "published");
    const v1 = versionDoc(KEY_A, 1);
    assert.equal(v1.reviewStatus, "rejected");
    assert.equal(v1.rejectReason, SUPERSEDED_REASON);
    assert.equal(v1.reviewedBy, RUBRIC_SYSTEM_ACTOR_ID);
    const reject = audits().find((a) => a.action === "reject");
    assert.equal(reject.by, RUBRIC_SYSTEM_ACTOR_ID);
    assert.equal(reject.automatic, true);
    assert.equal(reject.version, 1);
    assert.equal(headDoc(KEY_A).approvedVersion, 2);
    assert.equal(versionDoc(KEY_A, 2).reviewStatus, "approved");
  });
});

// ============================================
// Every hold leaves the serving version alone
// ============================================

describe("auto-publish: every hold path leaves the head and the version unchanged and alerts", () => {
  /** Run a held scenario and check the common outcome. */
  async function expectHeld(codes: string[] | ((c: string[]) => boolean), over: ConstructorParameters<typeof RubricAutoPublishService>[0] = {}, version = 1, approved: number | null = null, auditCount = 0): Promise<any> {
    const r = await trigger(service({ checker: checkerStub(), planner: plannerStub(), ...over }), KEY_A, version);
    assert.equal(r?.outcome, "held", JSON.stringify(r?.reasonCodes));
    if (typeof codes === "function") assert.ok(codes(r?.reasonCodes ?? []), JSON.stringify(r?.reasonCodes));
    else assert.deepEqual(r?.reasonCodes, codes);
    assertUntouched(KEY_A, version, auditCount, approved);
    assert.ok(alerts().some((a) => a.rule === "rubric_draft_held" && a.dedupeKey === `rubric_draft_held:${rubricVersionId(KEY_A, version)}`));
    assert.equal(runs().at(-1)?.outcome, "held");
    return r;
  }

  test("suspicious passages", async () => {
    const hash = await seedSource({ id: SOURCE_A_ID, url: SOURCE_A_URL, text: A_TEXT });
    setRole("route_guidance");
    const s = sourceA(hash);
    await write(bigDraft(hash, { extra: { suspiciousPassages: [{ quote: A_LINES.sponsor, sourceId: s.sourceId, url: s.url, contentHash: hash, retrievedAt: new Date(REVIEW_T0).toISOString() }] } }));
    settings();
    await expectHeld(["suspicious_passages"]);
  });

  test("structural validator error", async () => {
    await seedA();
    const doc = versionDoc(KEY_A, 1);
    doc.criteria[2].check = { field: "x.y", op: "present" };
    store.set(`visaRubrics/${KEY_A}/rubricVersions/1`, doc);
    settings();
    await expectHeld(["rubric_invalid"]);
  });

  test("intent criteria with no polarity proposal at all (the validator's own flag) hold", async () => {
    await seedA({ noProposal: true });
    settings();
    await expectHeld((c) => c.includes("intent_criteria_without_polarity"));
  });

  test("no_criteria, intent_polarity_conflict, an unknown flag", async () => {
    const cases: [string, string][] = [
      ["no_criteria", "no_criteria"],
      ["intent_polarity_conflict", "intent_polarity_conflict"],
      ["made_up_code", "unknown_flag:made_up_code"],
    ];
    for (const [code, reason] of cases) {
      resetStore();
      resetBucket();
      store.set("users/admin1", { email: "delivered+admin1@resend.dev", admin: true });
      await seedA({ flags: () => [{ code, message: "m", target: "rubric" }] });
      settings();
      await expectHeld((c) => c.includes(reason));
    }
  });

  test("shrink guard against the serving version", async () => {
    // Version 1 serves with ten kept rules.
    await seedA();
    settings();
    await trigger(fullService());
    assert.equal(headDoc(KEY_A).approvedVersion, 1);
    // Version 2 would leave out five of its ten: kept 5 < 0.7 * 10, inside a widened budget.
    settings({ mode: "auto", maxLeftOutShare: 1, maxPrimaryLeftOutShare: 1 });
    const hash2 = await seedSource({ id: SOURCE_A_ID, url: SOURCE_A_URL, text: A_TEXT + "\n" });
    setRole("route_guidance");
    const d2 = bigDraft(hash2, { flags: (ids) => ids.slice(4, 9).map((id) => ({ code: "quote_starts_mid_sentence", message: "m", target: id })), extra: { createdAt: Timestamp.fromMillis(REVIEW_T0 + 86_400_000) } });
    await write(d2);
    await expectHeld(["shrink_below_floor"], {}, 2, 1, 1);
    assert.equal(headDoc(KEY_A).approvedVersion, 1, "version 1 keeps serving");
  });

  test("leave-out budget", async () => {
    await seedA({ flags: (ids) => ids.slice(4, 7).map((id) => ({ code: "quote_starts_mid_sentence", message: "m", target: id })) });
    settings();
    await expectHeld((c) => c.includes("leave_out_budget_exceeded"));
  });

  test("NOT_LATEST_VERSION: a newer draft exists (the older one is held with that code)", async () => {
    await seedA();
    const hash2 = await seedSource({ id: SOURCE_A_ID, url: SOURCE_A_URL, text: A_TEXT + "\n" });
    setRole("route_guidance");
    await write(bigDraft(hash2, { extra: { createdAt: Timestamp.fromMillis(REVIEW_T0 + 86_400_000) } }));
    settings();
    await expectHeld(["NOT_LATEST_VERSION"], {}, 1, null, 0);
  });

  test("STALE_CITATION: the source moved on after the draft was written (refused by the shared transaction)", async () => {
    await seedA();
    await seedSource({ id: SOURCE_A_ID, url: SOURCE_A_URL, text: A2_TEXT });
    setRole("route_guidance");
    settings();
    await expectHeld(["STALE_CITATION"]);
  });

  test("SOURCE_CHANGED: a source moves between the citation check and the write (refused by the shared transaction)", async () => {
    await seedA();
    settings();
    const real = rubricReviewService.runTransaction;
    rubricReviewService.runTransaction = (async (fn: any) => {
      await seedSource({ id: SOURCE_A_ID, url: SOURCE_A_URL, text: A2_TEXT });
      return fakeRunTransaction(fn);
    }) as any;
    try {
      await expectHeld(["SOURCE_CHANGED"]);
    } finally {
      rubricReviewService.runTransaction = real;
    }
  });

  test("FLAGS_NOT_ACKNOWLEDGED: a flag with no recorded gate result is never acknowledged, so the transaction refuses", async () => {
    // The check returns `not_assessed` while rules concern intent: the decided polarity raises a flag no gate resolved.
    await seedA();
    settings();
    await expectHeld(["FLAGS_NOT_ACKNOWLEDGED"], { checker: checkerStub({ ok: true, leftOut: [], resolvedFlagCodes: [], intentPolarity: "not_assessed" }) });
  });

  test("a pipeline error: held as pipeline_error, the trigger entry does not throw, nothing changes", async () => {
    await seedA();
    settings();
    await expectHeld(["pipeline_error"], { review: { decideAs: async () => { throw new Error("storage unavailable"); }, knownEligibilityIds: async () => undefined } as any });
  });

  test("an error reading the serving version is a hold, not 'no floor'", async () => {
    await seedA();
    settings();
    await trigger(fullService());
    const hash2 = await seedSource({ id: SOURCE_A_ID, url: SOURCE_A_URL, text: A_TEXT + "\n" });
    setRole("route_guidance");
    await write(bigDraft(hash2, { extra: { createdAt: Timestamp.fromMillis(REVIEW_T0 + 86_400_000) } }));
    // The serving version's document disappears.
    store.delete(`visaRubrics/${KEY_A}/rubricVersions/1`);
    await expectHeld(["pipeline_error"], {}, 2, 1, 1);
  });

  test("a held explicit run can be re-run: attempts go up and the alert is bumped, not duplicated", async () => {
    await seedA();
    settings();
    const svc = service();
    await trigger(svc);
    const r2 = await quiet(() => svc.runOnDraft(ID_A1, { trigger: "admin_endpoint" }));
    assert.equal(r2.result.outcome, "held");
    assert.equal(r2.result.attempts, 2);
    assert.equal(runs().length, 1);
    assert.equal(runs()[0].attempts, 2);
    assert.equal(alerts().length, 1);
    assert.equal(alerts()[0].count, 2);
  });
});

// ============================================
// The shared transaction still enforces everything for the system actor
// ============================================

describe("auto-publish: the shared transaction's invariants hold for the system actor", () => {
  const input = (revision = 0, extra: Record<string, unknown> = {}) => ({ action: "approve" as const, revision, intentPolarity: "immigrant_intent_penalised" as IntentPolarity, acknowledgedFlags: [], reason: null, ...extra });
  const expectRefused = async (id: string, code: string, extra: Record<string, unknown> = {}) => {
    const before = writes.length;
    await assert.rejects(
      () => quiet(() => rubricReviewService.decideAs(id, input(0, extra), SYSTEM, { publishRunId: id })),
      (e: any) => e instanceof RubricReviewError && e.code === code,
      code
    );
    assert.equal(writes.length, before, `${code}: nothing written`);
  };

  test("NOT_LATEST_VERSION, STALE_CITATION, RUBRIC_INVALID, ALREADY_DECIDED, PRIMARY_EXCLUSION_UNCONFIRMED", async () => {
    await seedA({}, "primary");
    // PRIMARY_EXCLUSION_UNCONFIRMED: a primary-source exclusion with no confirmation.
    await expectRefused(ID_A1, "PRIMARY_EXCLUSION_UNCONFIRMED", { excludedCriterionIds: [versionDoc(KEY_A, 1).criteria[5].criterionId] });
    // A mandatory bar can never be excluded.
    await assert.rejects(() => quiet(() => rubricReviewService.decideAs(ID_A1, input(0, { excludedCriterionIds: [versionDoc(KEY_A, 1).criteria[3].criterionId], confirmPrimaryExclusions: true }), SYSTEM)), /mandatory_bar_excluded/);
    // RUBRIC_INVALID
    const doc = versionDoc(KEY_A, 1);
    doc.criteria[2].check = { field: "x.y", op: "present" };
    store.set(`visaRubrics/${KEY_A}/rubricVersions/1`, doc);
    await expectRefused(ID_A1, "RUBRIC_INVALID");
    delete doc.criteria[2].check;
    store.set(`visaRubrics/${KEY_A}/rubricVersions/1`, doc);
    // NOT_LATEST_VERSION
    const hash2 = await seedSource({ id: SOURCE_A_ID, url: SOURCE_A_URL, text: A_TEXT + "\n" });
    setRole("primary");
    await write(bigDraft(hash2, { extra: { createdAt: Timestamp.fromMillis(REVIEW_T0 + 86_400_000) } }));
    await expectRefused(ID_A1, "NOT_LATEST_VERSION");
    // STALE_CITATION
    await seedSource({ id: SOURCE_A_ID, url: SOURCE_A_URL, text: A2_TEXT });
    await expectRefused(ID_A2, "STALE_CITATION");
    // ALREADY_DECIDED
    await rubricReviewService.decide(ID_A2, { action: "reject", revision: 0, reason: "Rejected by a person." }, "admin-uid");
    await expectRefused(ID_A2, "ALREADY_DECIDED");
  });

  test("a stale revision is refused too", async () => {
    await seedA();
    await assert.rejects(
      () => quiet(() => rubricReviewService.decideAs(ID_A1, input(5), SYSTEM)),
      (e: any) => e.code === "REVISION_MISMATCH"
    );
  });

  test("the version write still goes through reviewFieldsUpdate: no key outside the review fields (content byte-identical)", async () => {
    await seedA({ flags: (ids) => [{ code: "quote_starts_mid_sentence", message: "m", target: ids[5] }] });
    settings();
    const content = (d: any) => JSON.stringify(Object.fromEntries(Object.entries(d).filter(([k]) => !["reviewStatus", "intentPolarity", "reviewedBy", "reviewedAt", "rejectReason", "revision", "supersededAt", "excludedCriterionIds", "exclusionNote"].includes(k))));
    const before = content(versionDoc(KEY_A, 1));
    await trigger(fullService());
    assert.equal(content(versionDoc(KEY_A, 1)), before);
  });
});

// ============================================
// Alerts
// ============================================

describe("auto-publish: alerts", () => {
  test("a publish raises ONE alert with counts, informational flags, the 10-rule sample and a link; it emails immediately under the default config", async () => {
    await seedA({ flags: () => [{ code: "multiple_chunks", message: "m", target: "rubric" }, { code: "rule_ref_derived", message: "m", target: "x" }] });
    settings();
    await trigger(fullService());
    const published = alerts().filter((a) => a.rule === "rubric_auto_published");
    assert.equal(published.length, 1);
    const a = published[0];
    assert.equal(a.severity, "warning");
    assert.equal(a.subject.type, "rubric_route");
    assert.equal(a.subject.id, KEY_A);
    assert.equal(a.dedupeKey, `rubric_auto_published:${ID_A1}`);
    assert.match(a.message, /Published XA_xa-short-visit version 1 \(first rulebook for this route\)/);
    assert.match(a.message, /Rules: 10 kept, 0 left out \(none\), 0 held, of 10\./);
    assert.match(a.message, /Informational remarks: 1 multiple_chunks, 1 rule_ref_derived\./);
    assert.equal((a.message.match(/^\d+\. /gm) ?? []).length, 10, "the sample audit lists 10 rules");
    assert.match(a.message, /Open it: https:\/\/portal\.test\/admin\/visa-review\?tab=rubrics&rubric=XA_xa-short-visit__v1/);
    assert.equal(emails.length, 1, "warning emails immediately");
    assert.equal(emails[0].userId, "admin1");
    // The sample is reproducible: the same version always samples the same rules.
    resetStore();
    resetBucket();
    store.set("users/admin1", { email: "delivered+admin1@resend.dev", admin: true });
    await seedA({ flags: () => [{ code: "multiple_chunks", message: "m", target: "rubric" }] });
    settings();
    await trigger(fullService());
    const sample = (m: string) => m.split("\n").filter((l) => /^\d+\. /.test(l)).map((l) => l.replace(/^\d+\. /, ""));
    assert.deepEqual(sample(alerts().find((x) => x.rule === "rubric_auto_published").message), sample(a.message));
  });

  test("the severity is overridable in appConfig/scrapeAlerts like the other rules, and a disabled rule raises nothing", async () => {
    await seedA();
    settings();
    store.set("appConfig/scrapeAlerts", { rules: { rubric_auto_published: { severity: "info" }, rubric_draft_held: { enabled: false } } });
    await trigger(fullService());
    assert.equal(alerts().find((a) => a.rule === "rubric_auto_published").severity, "info");
    assert.equal(emails.length, 0, "info is below the immediate threshold");
  });

  test("a hold alert: warning by default, one per route and version, resolved when a later version publishes", async () => {
    await seedA();
    settings();
    await trigger(service());
    let held = alerts().filter((a) => a.rule === "rubric_draft_held");
    assert.equal(held.length, 1);
    assert.equal(held[0].status, "open");
    assert.equal(held[0].severity, "warning");
    // A later version publishes: the held alert auto-resolves.
    const hash2 = await seedSource({ id: SOURCE_A_ID, url: SOURCE_A_URL, text: A_TEXT + "\n" });
    setRole("route_guidance");
    await write(bigDraft(hash2, { extra: { createdAt: Timestamp.fromMillis(REVIEW_T0 + 86_400_000) } }));
    assert.equal((await trigger(fullService(), KEY_A, 2))?.outcome, "published");
    held = alerts().filter((a) => a.rule === "rubric_draft_held");
    assert.equal(held[0].status, "resolved");
    assert.equal(held[0].autoResolved, true);
    // v1 was superseded by the system.
    assert.equal(versionDoc(KEY_A, 1).reviewStatus, "rejected");
  });

  test("a held draft's alert resolves when it is rejected or approved by hand (the decision trigger's handler)", async () => {
    await seedA();
    settings();
    const svc = service();
    await trigger(svc);
    assert.equal(alerts().filter((a) => a.rule === "rubric_draft_held" && a.status === "open").length, 1);
    await rubricReviewService.decide(ID_A1, { action: "reject", revision: 0, reason: "Rejected by a person." }, "admin-uid");
    await quiet(() => svc.afterDecision(audits()[0]));
    assert.equal(alerts().find((a) => a.rule === "rubric_draft_held").status, "resolved");
    // An entry that is not a decision is ignored.
    await quiet(() => svc.afterDecision({ action: "set_statistics", routeKey: KEY_A, version: 1 }));

    // And an approval by hand settles every held draft of the route.
    resetStore();
    resetBucket();
    store.set("users/admin1", { email: "delivered+admin1@resend.dev", admin: true });
    await seedA();
    settings();
    await trigger(svc);
    await rubricReviewService.decide(ID_A1, { action: "approve", revision: 0, intentPolarity: "immigrant_intent_penalised", acknowledgedFlags: [], reason: null }, "admin-uid");
    await quiet(() => svc.afterDecision(audits()[0]));
    assert.equal(alerts().find((a) => a.rule === "rubric_draft_held").status, "resolved");
  });

  test("an alert failure never fails or undoes a publish", async () => {
    await seedA();
    settings();
    const svc = service({
      checker: checkerStub(),
      planner: plannerStub(),
      loadAlertConfig: async () => { throw new Error("config unreadable"); },
      raiseAlerts: async () => { throw new Error("alerts down"); },
    });
    const r = await trigger(svc);
    assert.equal(r?.outcome, "published");
    assert.equal(headDoc(KEY_A).approvedVersion, 1);
    assert.equal(audits().length, 1);
    assert.equal(runs()[0].outcome, "published");
  });

  test("manual mode raises no alert from this pipeline", async () => {
    await seedA();
    settings({ mode: "manual" });
    await trigger(fullService());
    assert.equal(alerts().length, 0);
    assert.equal(emails.length, 0);
  });
});

// ============================================
// Dry run and report-only modes
// ============================================

describe("auto-publish: dry run and --skip-checker write nothing", () => {
  test("a dry run on a pending draft returns gates, planned leave-outs and counts; nothing is written; the check is not called", async () => {
    await seedA({ flags: (ids) => [{ code: "quote_starts_mid_sentence", message: "m", target: ids[5] }] });
    const checker = checkerStub();
    const planner = plannerStub();
    const svc = service({ checker, planner });
    const before = writes.length;
    const r = (await quiet(() => svc.runOnDraft(ID_A1, { dryRun: true }))).result;
    assert.equal(writes.length, before, "a dry run writes nothing at all");
    assert.equal(r.dryRun, true);
    assert.equal(r.recorded, false);
    assert.equal(r.outcome, "held");
    assert.equal(r.codeGatesPassed, true);
    assert.equal(r.plannedExcludedCriterionIds.length, 1);
    assert.equal(r.counts.kept, 9);
    assert.ok(r.gates.length >= 6);
    assert.ok(r.reasonCodes.includes("checker_not_run"));
    assert.equal(checker.calls.length, 0);
    assert.equal(planner.calls, 0);
    assert.equal(runs().length, 0);
    assert.equal(alerts().length, 0);
    assertUntouched(KEY_A, 1, 0, null);
  });

  test("skipChecker reports the code gates, says the check did not run, and can never publish", async () => {
    await seedA();
    const svc = fullService();
    const r = (await quiet(() => svc.runOnDraft(ID_A1, { skipChecker: true }))).result;
    assert.equal(r.outcome, "held");
    assert.equal(r.dryRun, true);
    assert.equal(r.checker, "not_run");
    assert.equal((svc as any).decideCalls.length, 0);
    assertUntouched(KEY_A, 1, 0, null);
  });

  test("a dry run reports a failing gate with its reason", async () => {
    await seedA({ flags: () => [{ code: "no_criteria", message: "m", target: "rubric" }] });
    const r = (await quiet(() => service().runOnDraft(ID_A1, { dryRun: true }))).result;
    assert.equal(r.codeGatesPassed, false);
    assert.ok(r.reasonCodes.includes("no_criteria"));
    assert.equal(r.gates.find((g) => g.gate === "hold_flags")?.passed, false);
  });
});

// ============================================
// The admin endpoints
// ============================================

describe("auto-publish: admin endpoints", () => {
  /** One HTTP call to /admin/rubrics. */
  async function api(method: string, urlPath: string, token: string | null, payload?: unknown): Promise<{ status: number; body: any }> {
    const { result } = await quiet(async () => {
      const res = await fetch(`${baseUrl}/admin/rubrics${urlPath}`, {
        method,
        headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json" },
        ...(payload !== undefined ? { body: JSON.stringify(payload) } : {}),
      });
      return { status: res.status, body: await res.json() };
    });
    return result;
  }

  /** The three new endpoints. */
  const calls = (): [string, string, unknown?][] => [
    ["GET", "/publish-settings"],
    ["PATCH", "/publish-settings", { mode: "auto" }],
    ["POST", `/${ID_A1}/auto-publish`],
  ];

  /** Point the endpoint's singleton at the fakes (no real alert engine config read, no model). */
  function wireSingleton(): void {
    const s: any = rubricAutoPublishService;
    s.deps.now = () => Timestamp.fromMillis(nowMs);
    s.deps.appUrl = () => "https://portal.test";
  }

  test("anonymous: 401; client, agent and owner: 403 FORBIDDEN; nothing is written", async () => {
    await seedA();
    wireSingleton();
    writes.length = 0;
    for (const [method, p, payload] of calls()) {
      assert.equal((await api(method, p, null, payload)).status, 401, `anonymous ${method} ${p}`);
      for (const token of ["t-client", "t-agent", "t-owner"]) {
        const out = await api(method, p, token, payload);
        assert.equal(out.status, 403, `${token} ${method} ${p}`);
        assert.equal(out.body.error, "FORBIDDEN");
      }
    }
    assert.equal(writes.length, 0);
    assert.equal(store.has(SETTINGS_PATH), false);
    assert.equal(versionDoc(KEY_A, 1).reviewStatus, "pending_review");
  });

  test("admin: GET /publish-settings is not captured by /:id; PATCH changes it and writes one audit doc with the verified uid", async () => {
    wireSingleton();
    const got = await api("GET", "/publish-settings", "t-admin");
    assert.equal(got.status, 200);
    assert.equal(got.body.data.settings.mode, "manual");
    assert.equal(got.body.data.exists, false);
    const patched = await api("PATCH", "/publish-settings", "t-admin", { mode: "auto", routeAllowlist: [KEY_A], maxLeftOutShare: 0.1 });
    assert.equal(patched.status, 200);
    assert.equal(patched.body.data.settings.mode, "auto");
    assert.deepEqual(patched.body.data.settings.routeAllowlist, [KEY_A]);
    assert.equal(patched.body.data.settings.maxLeftOutShare, 0.1);
    assert.deepEqual(store.get(SETTINGS_PATH), { mode: "auto", routeAllowlist: [KEY_A], maxLeftOutShare: 0.1 });
    const hist = [...store.entries()].filter(([p]) => p.startsWith("rubricPublishSettingsHistory/")).map(([, d]) => d as any);
    assert.equal(hist.length, 1);
    assert.equal(hist[0].by, "admin-uid");
    assert.equal(hist[0].before, null);
    assert.deepEqual(hist[0].after, { mode: "auto", routeAllowlist: [KEY_A], maxLeftOutShare: 0.1 });
  });

  test("PATCH is strict: 400 for an unknown field, a bad value, an empty body, or a body that tries to name the author", async () => {
    wireSingleton();
    for (const bad of [{}, { mode: "yes" }, { who: "me" }, { by: "someone" }, { maxLeftOutShare: 5 }]) {
      const out = await api("PATCH", "/publish-settings", "t-admin", bad);
      assert.equal(out.status, 400, JSON.stringify(bad));
      assert.equal(out.body.error, "VALIDATION_ERROR");
    }
    assert.equal(store.has(SETTINGS_PATH), false);
  });

  test("POST /:id/auto-publish runs whatever the mode is, still subject to every gate (held while the plug-ins are missing)", async () => {
    await seedA();
    wireSingleton();
    settings({ mode: "manual" });
    const out = await api("POST", `/${ID_A1}/auto-publish`, "t-admin");
    assert.equal(out.status, 200);
    assert.equal(out.body.data.outcome, "held");
    assert.deepEqual(out.body.data.reasonCodes, ["checker_not_configured", "question_plan_missing"]);
    assert.equal(out.body.data.trigger, "admin_endpoint");
    assert.equal(runs().length, 1);
    assertUntouched(KEY_A, 1, 0, null);
  });

  test("with stubs registered, the endpoint publishes a pending draft in manual mode (an explicit action)", async () => {
    await seedA();
    wireSingleton();
    rubricAutoPublishService.registerChecker(checkerStub());
    rubricAutoPublishService.registerPlanner(plannerStub());
    const out = await api("POST", `/${ID_A1}/auto-publish`, "t-admin");
    assert.equal(out.status, 200);
    assert.equal(out.body.data.outcome, "published");
    assert.equal(headDoc(KEY_A).approvedVersion, 1);
    assert.equal(audits()[0].by, RUBRIC_SYSTEM_ACTOR_ID);
    // A second call is 409: it is published.
    assert.equal((await api("POST", `/${ID_A1}/auto-publish`, "t-admin")).status, 409);
  });

  test("?dryRun=true writes nothing and returns gates, planned leave-outs and counts", async () => {
    await seedA({ flags: (ids) => [{ code: "multiple_dates_in_quote", message: "m", target: ids[5] }] });
    wireSingleton();
    writes.length = 0;
    const out = await api("POST", `/${ID_A1}/auto-publish?dryRun=true`, "t-admin");
    assert.equal(out.status, 200);
    assert.equal(out.body.data.dryRun, true);
    assert.equal(out.body.data.plannedExcludedCriterionIds.length, 1);
    assert.equal(out.body.data.counts.kept, 9);
    assert.ok(Array.isArray(out.body.data.gates));
    assert.equal(writes.length, 0);
    assert.equal((await api("POST", `/${ID_A1}/auto-publish?dryRun=maybe`, "t-admin")).status, 400);
  });

  test("409 for a non-pending version and for a non-latest one; 404 for an unknown or malformed id", async () => {
    await seedA();
    wireSingleton();
    // not the newest
    const hash2 = await seedSource({ id: SOURCE_A_ID, url: SOURCE_A_URL, text: A_TEXT + "\n" });
    setRole("route_guidance");
    await write(bigDraft(hash2, { extra: { createdAt: Timestamp.fromMillis(REVIEW_T0 + 86_400_000) } }));
    const notLatest = await api("POST", `/${ID_A1}/auto-publish`, "t-admin");
    assert.equal(notLatest.status, 409);
    assert.equal(notLatest.body.error, "NOT_LATEST_VERSION");
    // not pending
    await rubricReviewService.decide(ID_A2, { action: "reject", revision: 0, reason: "Rejected by a person." }, "admin-uid");
    const decided = await api("POST", `/${ID_A2}/auto-publish`, "t-admin");
    assert.equal(decided.status, 409);
    assert.equal(decided.body.error, "ALREADY_DECIDED");
    assert.equal((await api("POST", `/${rubricVersionId(KEY_A, 9)}/auto-publish`, "t-admin")).status, 404);
    assert.equal((await api("POST", "/not-an-id/auto-publish", "t-admin")).status, 404);
    assert.equal(runs().length, 0);
  });
});

// ============================================
// The script
// ============================================

describe("publish:rubric script: refuses without an explicit project, and refuses production", () => {
  const script = path.join(__dirname, "..", "..", "..", "src", "scrapers", "rubric", "scripts", "publish-rubric.ts");
  const run = (args: string[]) => {
    const env = { ...process.env };
    delete env.GCLOUD_PROJECT;
    delete env.GOOGLE_CLOUD_PROJECT;
    delete env.FIRESTORE_EMULATOR_HOST;
    return spawnSync(process.execPath, ["--import", "tsx", script, ...args], { encoding: "utf8", env, timeout: 60_000 });
  };

  test("no --project: exit 1 with a message; nothing is loaded", () => {
    const r = run(["--route", "XA_x", "--version", "1", "--dry-run"]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /--project/);
  });

  test("the production project needs --allow-production", () => {
    const r = run(["--project", "japa-platform", "--route", "XA_x", "--version", "1", "--dry-run"]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /production/);
    assert.match(r.stderr, /--allow-production/);
  });

  test("a project that disagrees with GCLOUD_PROJECT is refused", () => {
    const r = spawnSync(process.execPath, ["--import", "tsx", script, "--project", "demo-a", "--route", "XA_x", "--version", "1"], { encoding: "utf8", env: { ...process.env, GCLOUD_PROJECT: "demo-b" }, timeout: 60_000 });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /disagrees/);
  });

  test("a missing route or version is refused", () => {
    const r = run(["--project", "demo-x", "--route", "XA_x"]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /--route/);
  });

  test("package.json has the npm script", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "..", "package.json"), "utf8"));
    assert.match(pkg.scripts["publish:rubric"], /publish-rubric\.js/);
  });
});

// ============================================
// Structure: one approval path, generic code
// ============================================

describe("auto-publish: no second approval path, and the new files are generic", () => {
  const SRC = path.join(__dirname, "..", "..", "..", "src");
  const FILES = ["services/rubric-auto-publish.service.ts", "scrapers/rubric/rubric-gates.ts", "scrapers/rubric/rubric-publish-settings.ts", "scrapers/rubric/scripts/publish-rubric.ts"];
  const sources = new Map(FILES.map((f) => [f, fs.readFileSync(path.join(SRC, f), "utf8")]));
  /** The code of a file without comments (a comment may talk about approvals). */
  const code = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

  test("the publisher writes no approved status and no head: it only calls the shared approval code", () => {
    for (const [file, text] of sources) {
      const c = code(text);
      assert.doesNotMatch(c, /reviewStatus:\s*"approved"/, `${file} writes an approved status`);
      assert.doesNotMatch(c, /approvedVersion\s*:/, `${file} writes the head`);
      // (The settings module has its own, separate, audited transaction for ITS doc; nothing else may open one.)
      if (!file.endsWith("rubric-publish-settings.ts")) assert.doesNotMatch(c, /reviewFieldsUpdate|runTransaction\s*\(/, `${file} opens its own write path`);
    }
    assert.match(code(sources.get("services/rubric-auto-publish.service.ts") as string), /\.decideAs\(/);
  });

  test("no country, route, publisher or nationality name from the seed data, and no URL", () => {
    const seed = fs.readFileSync(path.join(SRC, "data", "seed-countries-visas.ts"), "utf8");
    const names = [...new Set([...seed.matchAll(/\bname:\s*"([^"]+)"/g)].map((m) => m[1]))].filter((n) => /^[A-Z][A-Za-z .'-]+$/.test(n));
    const codes = [...new Set([...seed.matchAll(/\b(?:code|countryCode):\s*"([A-Z]{2})"/g)].map((m) => m[1]))];
    assert.ok(names.length >= 12 && codes.length >= 12, "the seed was parsed");
    const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    for (const [file, text] of sources) {
      for (const n of names) assert.doesNotMatch(text, new RegExp(`\\b${esc(n)}\\b`, "i"), `${file}: ${n}`);
      for (const c of codes) assert.doesNotMatch(text, new RegExp(`\\b${c}\\b`), `${file}: ${c}`);
      assert.doesNotMatch(text, /https?:\/\/[a-z0-9.-]+\.[a-z]{2,}/i, `${file} has a URL`);
    }
  });

  test("nothing in the new alert text or the gates uses outcome or likelihood wording", () => {
    for (const [file, text] of sources) {
      assert.doesNotMatch(code(text), /\b(likely|unlikely|chance|probab\w+|will be (approved|refused))\b/i, file);
    }
  });

  test("the trigger: a separate function on version creation, own timeout, binds the AI and email secrets, guards on a fresh extraction draft, never rethrows", () => {
    const index = fs.readFileSync(path.join(SRC, "index.ts"), "utf8");
    const at = index.indexOf("export const onRubricVersionCreated");
    assert.ok(at > 0, "the trigger exists");
    const block = index.slice(at, index.indexOf("\n  });\n", at));
    assert.match(block, /timeoutSeconds: 540/);
    assert.match(block, /secrets: \[\.\.\.AI_SECRETS, \.\.\.EMAIL_SECRETS\]/);
    assert.match(block, /\.firestore\.document\("visaRubrics\/\{routeKey\}\/rubricVersions\/\{version\}"\)\s*\.onCreate/);
    assert.match(block, /reviewStatus !== "pending_review" \|\| !data\.extractionRunId/);
    assert.match(block, /rubricAutoPublishService\.onVersionCreated\(/);
    // It is not the guidance-source trigger, and it does not call extraction.
    assert.doesNotMatch(block, /rubricExtractionService|onGuidanceSourceChanged/);
    // The decision-alert handler is its own function on the audit document; the two existing triggers are untouched.
    assert.match(index, /export const onRubricDecisionResolveHeldAlerts/);
    assert.match(index, /bulkReassessmentService\.startRun\(context\.params\.auditId, snap\.data\(\) as RubricReviewAuditEntry\)/);
    assert.match(index, /ruleChangeAlertsService\.recordRubricApproval\(context\.params\.auditId, snap\.data\(\) as RubricReviewAuditEntry\)/);
  });
});
