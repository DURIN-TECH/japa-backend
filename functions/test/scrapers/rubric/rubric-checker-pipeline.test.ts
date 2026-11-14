// ============================================
// Independent check, end to end through the pipeline (issue #202)
// ============================================
//
// The REAL check (`RubricCheckerService`) over a scripted provider, plugged into
// part A's pipeline over the in-memory Firestore, the in-memory snapshot bucket,
// the real review service (the shared approval transaction) and the real alert
// engine. No network, no model. Proved: a draft that passes is published through
// the shared approval by the system actor (a rule the check fails is left out of
// what applicants see, never edited); a draft that fails is held with the right
// reason and the serving version is untouched; dry runs never call the model;
// a re-delivered trigger spends nothing twice; the hourly sweep retries what can
// clear (at most 3 runs per version).
//
// Fixtures: the invented route A of rubric-review-fixtures.ts. No real rule.

import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { Timestamp } from "firebase-admin/firestore";
import { ROLES } from "@durin-tech/authz";
import { fakeCollection, fakeRunTransaction, installFakes, resetStore, store } from "../../helpers/fake-firestore";
import { fakeCollectionGroup } from "../../helpers/fake-collection-group";
import { installAdminClaimsFromUserDocs } from "../../helpers/fake-admin-claims";
import { rubricStore } from "../../../src/scrapers/rubric/rubric.store";
import type { RubricDraft } from "../../../src/scrapers/rubric/rubric.store";
import { PUBLISH_SETTINGS_DOC_ID, publishSettingsTx } from "../../../src/scrapers/rubric/rubric-publish-settings";
import { scrapeAlertService } from "../../../src/scrapers/shared/alerts/scrape-alert.service";
import {
  RubricAutoPublishService,
  type QuestionPlanner,
  type RubricChecker,
  rubricAutoPublishService,
} from "../../../src/services/rubric-auto-publish.service";
import { rubricReviewService, rubricVersionId } from "../../../src/services/rubric-review.service";
import { RUBRIC_SYSTEM_ACTOR_ID, type RubricPublishRun } from "../../../src/types/rubric";
import { adminRubricRoutes } from "../../../src/routes/rubric-review.routes";
import { A_LINES, A_TEXT, ROUTE_A, SOURCE_A_ID, SOURCE_A_URL } from "./fixtures/synthetic-guidance";
import { headDoc, installRubricFakes, quiet, resetBucket, seedSource, snapshotStore, versionDoc } from "./rubric-harness";
import { RubricCheckerService } from "../../../src/scrapers/rubric/rubric-checker";
import { MemoryLedger, ScriptedProvider, seenRules, settingsWith } from "./checker-fakes";
import { A_POLARITY_QUOTE, KEY_A, REVIEW_T0, body, criterion, draft, sourceA } from "./rubric-review-fixtures";

/* eslint-disable @typescript-eslint/no-explicit-any */

// ============================================
// Wiring
// ============================================

const ID_A1 = rubricVersionId(KEY_A, 1);
const SETTINGS_PATH = `appConfig/${PUBLISH_SETTINGS_DOC_ID}`;

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
// The check, wired
// ============================================

/** The real check over a scripted provider and the in-memory snapshot store. */
function wired() {
  const provider = new ScriptedProvider();
  const ledger = new MemoryLedger();
  const checker = new RubricCheckerService({ provider: () => provider, readSnapshot: (s, h) => snapshotStore.read(s, h), loadSettings: settingsWith(), ledger, nowMs: () => nowMs, sleep: async () => undefined });
  return { provider, ledger, checker };
}

/** The pipeline with the real check and a passing planner. */
function pipeline(checker: RubricChecker) {
  return service({ checker, planner: plannerStub() });
}

const batchRequests = (p: ScriptedProvider) => p.requests.filter((q) => (q.schema as any).properties.verdicts);

describe("independent check through the pipeline", () => {
  test("a draft that passes is published through the shared approval by the system actor", async () => {
    await seedA();
    settings();
    const w = wired();
    const svc = pipeline(w.checker);
    const r = await trigger(svc);
    assert.equal(r?.outcome, "published");
    assert.equal(r?.checker, "passed");
    assert.equal((svc as any).decideCalls.length, 1);
    assert.deepEqual((svc as any).decideCalls[0][2], { kind: "system", id: RUBRIC_SYSTEM_ACTOR_ID });
    assert.equal(versionDoc(KEY_A, 1).reviewedBy, RUBRIC_SYSTEM_ACTOR_ID);
    assert.equal(versionDoc(KEY_A, 1).intentPolarity, "immigrant_intent_penalised", "the verified reading, not copied unchecked");
    assert.equal(headDoc(KEY_A).approvedVersion, 1);
    assert.equal(audits().length, 1);
    // 1 ordinary batch of 9 + 1 protected batch per model + 2 polarity readings.
    assert.equal(w.provider.requests.length, 5);
    assert.deepEqual(w.provider.requests.map((q) => q.role).sort(), ["judgement", "judgement", "verification", "verification", "verification"]);
    const rec = [...w.ledger.docs.values()][0];
    assert.equal(rec.runId, ID_A1);
    assert.equal(rec.usage.requests, 5);
  });

  test("an ordinary rule the check fails is left out of what applicants see; nothing is edited; the reason is recorded with the aspect", async () => {
    await seedA();
    settings();
    const w = wired();
    w.provider.policy = ({ rule }) => (rule.title === "Reasonable costs of the visit" ? { condition_faithful: "no" } : undefined);
    const before = JSON.stringify(versionDoc(KEY_A, 1).criteria);
    const r = await trigger(pipeline(w.checker));
    assert.equal(r?.outcome, "published");
    assert.deepEqual(r?.counts.leftOutByReason, { "checker:condition_faithful": 1 });
    const v = versionDoc(KEY_A, 1);
    assert.equal(v.excludedCriterionIds.length, 1);
    assert.match(v.exclusionNote, /checker:condition_faithful: 1/);
    assert.equal(JSON.stringify(v.criteria), before, "the stored rules are byte-identical");
    const served = await rubricStore.getApprovedRubric(ROUTE_A.countryCode, ROUTE_A.visaTypeId);
    assert.equal(served?.criteria.length, 9);
    assert.ok(!served?.criteria.some((c) => c.title === "Reasonable costs of the visit"));
  });

  test("a protected rule that fails holds the draft (critical alert), nothing published; (#223) the ordinary rules are still checked", async () => {
    await seedA();
    settings();
    const w = wired();
    w.provider.policy = ({ rule }) => (rule.appliesTo ? { group_matches_codes: "no" } : undefined);
    const r = await trigger(pipeline(w.checker));
    assert.equal(r?.outcome, "held");
    assert.equal(r?.checker, "failed");
    assert.equal(r?.reasonCodes.length, 1);
    assert.match(r?.reasonCodes[0] as string, /^protected_rule_failed:/);
    assertUntouched(KEY_A, 1, 0, null);
    assert.equal(alerts()[0].severity, "critical");
    assert.match(alerts()[0].message, /protected rule/);
    // (#223) The ordinary rules ARE checked now, so the held report is complete.
    assert.ok(batchRequests(w.provider).filter((q) => !seenRules(q).some((x) => x.appliesTo)).length > 0);
  });

  test("role disagreement on the bar holds", async () => {
    await seedA();
    settings();
    const w = wired();
    w.provider.policy = ({ role, rule }) => (rule.appliesTo && role === "judgement" ? { group_matches_codes: "unsure" } : undefined);
    const r = await trigger(pipeline(w.checker));
    assert.equal(r?.outcome, "held");
    assert.match(r?.reasonCodes[0] as string, /^protected_rule_failed:/);
    assertUntouched(KEY_A, 1, 0, null);
  });

  test("provider down: held checker_unavailable, serving version untouched, no audit doc, alert in words", async () => {
    await seedA();
    settings();
    const w = wired();
    w.provider.script = () => "hard";
    const r = await trigger(pipeline(w.checker));
    assert.equal(r?.outcome, "held");
    // (#223) The reason says what was unreachable.
    assert.deepEqual(r?.reasonCodes, ["checker_unavailable:provider"]);
    assertUntouched(KEY_A, 1, 0, null);
    assert.match(alerts()[0].message, /independent AI check could not be completed because the AI provider could not be reached/);
  });

  test("an answer that does not match what was asked: held checker_output_invalid", async () => {
    await seedA();
    settings();
    const w = wired();
    w.provider.script = (_n, req) => ((req.schema as any).properties.verdicts && !seenRules(req).some((x) => x.appliesTo) ? { text: "{\"verdicts\":[]}" } : undefined);
    const r = await trigger(pipeline(w.checker));
    assert.deepEqual(r?.reasonCodes, ["checker_output_invalid"]);
    assertUntouched(KEY_A, 1, 0, null);
  });

  test("over a spend cap: held checker_capped before any call", async () => {
    await seedA();
    settings();
    const provider = new ScriptedProvider();
    const checker = new RubricCheckerService({ provider: () => provider, readSnapshot: (s, h) => snapshotStore.read(s, h), loadSettings: settingsWith({ checkerMaxRequestsPerRun: 1 }), ledger: new MemoryLedger(), nowMs: () => nowMs });
    const r = await trigger(pipeline(checker));
    assert.deepEqual(r?.reasonCodes, ["checker_capped"]);
    assert.equal(provider.requests.length, 0);
    assertUntouched(KEY_A, 1, 0, null);
  });

  test("the intention-to-stay readings disagree: held polarity_unverified", async () => {
    await seedA();
    settings();
    const w = wired();
    w.provider.polarity = (role) => (role === "judgement" ? "dual_intent_permitted" : "immigrant_intent_penalised");
    const r = await trigger(pipeline(w.checker));
    assert.deepEqual(r?.reasonCodes, ["polarity_unverified"]);
    assertUntouched(KEY_A, 1, 0, null);
  });

  test("manual mode, dry run and --skip-checker never call the model", async () => {
    await seedA();
    const w = wired();
    const svc = pipeline(w.checker);
    await trigger(svc);
    assert.equal(w.provider.requests.length, 0, "manual");
    settings();
    await quiet(() => svc.runOnDraft(ID_A1, { dryRun: true }));
    await quiet(() => svc.runOnDraft(ID_A1, { skipChecker: true }));
    assert.equal(w.provider.requests.length, 0, "dry run and skip-checker");
    assertUntouched(KEY_A, 1, 0, null);
  });

  test("a re-delivered trigger on a published version spends nothing and publishes nothing twice", async () => {
    await seedA();
    settings();
    const w = wired();
    const svc = pipeline(w.checker);
    await trigger(svc);
    const calls = w.provider.requests.length;
    await trigger(svc);
    assert.equal(w.provider.requests.length, calls);
    assert.equal(audits().length, 1);
  });

  test("the hourly sweep retries a held draft whose reason can clear, and publishes it", async () => {
    await seedA();
    settings();
    const w = wired();
    const svc = pipeline(w.checker);
    w.provider.script = () => "hard";
    assert.deepEqual((await trigger(svc))?.reasonCodes, ["checker_unavailable:provider"]);
    w.provider.script = () => undefined;
    const sweep = (await quiet(() => svc.sweepRetryable())).result;
    assert.deepEqual(sweep, { considered: 1, retried: 1 });
    assert.equal(versionDoc(KEY_A, 1).reviewStatus, "approved");
    assert.equal(runs()[0].outcome, "published");
    assert.equal(runs()[0].attempts, 2);
    assert.equal(audits().length, 1);
  });

  test("the sweep stops at 3 runs per version; a reason that cannot clear is never retried; manual mode sweeps nothing", async () => {
    await seedA();
    settings();
    const w = wired();
    const svc = pipeline(w.checker);
    w.provider.script = () => "hard";
    await trigger(svc);
    assert.deepEqual((await quiet(() => svc.sweepRetryable())).result, { considered: 1, retried: 1 });
    assert.deepEqual((await quiet(() => svc.sweepRetryable())).result, { considered: 1, retried: 1 });
    assert.equal(runs()[0].attempts, 3);
    assert.deepEqual((await quiet(() => svc.sweepRetryable())).result, { considered: 0, retried: 0 });
    assertUntouched(KEY_A, 1, 0, null);

    resetStore();
    resetBucket();
    store.set("users/admin1", { email: "delivered+admin1@resend.dev", admin: true });
    await seedA();
    settings();
    const w2 = wired();
    w2.provider.polarity = () => "unsure";
    const svc2 = pipeline(w2.checker);
    await trigger(svc2);
    assert.deepEqual((await quiet(() => svc2.sweepRetryable())).result, { considered: 0, retried: 0 }, "polarity_unverified is not retryable");
    settings({ mode: "manual" });
    assert.deepEqual((await quiet(() => svc2.sweepRetryable())).result, { considered: 0, retried: 0 });
  });
});
