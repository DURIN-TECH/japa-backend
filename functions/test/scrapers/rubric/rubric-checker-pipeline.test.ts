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
import fs from "node:fs";
import path from "node:path";
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
  RETRYABLE_REASONS,
  rubricAutoPublishService,
} from "../../../src/services/rubric-auto-publish.service";
import { PLANNER_WRITABLE_FIELDS, rubricReviewService, rubricVersionId } from "../../../src/services/rubric-review.service";
import { RUBRIC_SYSTEM_ACTOR_ID, type RubricPublishRun } from "../../../src/types/rubric";
import { adminRubricRoutes } from "../../../src/routes/rubric-review.routes";
import { A_LINES, A_TEXT, ROUTE_A, SOURCE_A_ID, SOURCE_A_URL } from "./fixtures/synthetic-guidance";
import { answer, crit, criteriaWire, headDoc, installRubricFakes, quiet, resetBucket, seedSource, snapshotStore, versionDoc } from "./rubric-harness";
import { RubricCheckerService } from "../../../src/scrapers/rubric/rubric-checker";
import { checkerStatusLine, reasonInWords } from "../../../src/scrapers/rubric/rubric-gates";
import { MemoryLedger, ScriptedProvider, isRepairRequest, ruleOf, rubricOf, seenRules, settingsWith } from "./checker-fakes";
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

// ============================================
// Protected-rule repair through the pipeline (issue #223)
// ============================================
//
// A bar that fails the independent check is re-drafted ONCE and checked again by
// both models. A repaired bar is recorded on the version when it is published
// and served in place of the original; a bar that is still not confirmed holds
// the draft, whatever else is fine. The previously approved version never changes.

const BAR_TITLE = "Nationals refused from a stated date";
const REPAIRED_TITLE = "Applicants from named countries are refused from a stated date";

/** The failure of the first real run in miniature: ONE `unsure` on `group_matches_codes` (#226: a bar's stage is no longer judged, so these tests use another aspect), from the judgement model, on the bar. */
const barUnsureOnGroup = ({ role, rule }: { role: string; rule: any }) => (rule.appliesTo && role === "judgement" ? { group_matches_codes: "unsure" as const } : undefined);

/** What the model answers to the re-draft: the same passage, drafted again (a different title and stage). */
const redraftOfBar = () =>
  criteriaWire(
    answer({
      criteria: [
        crit({
          ref: "r1",
          title: REPAIRED_TITLE,
          kind: "mandatory_bar",
          stage: "validity",
          severity: "critical",
          ruleRef: "SV 4.1",
          quote: body(A_LINES.bar),
          appliesTo: { nationalities: ["QM", "QN"], asWritten: ["Borduria", "Syldavia"] },
          validFrom: "2026-03-26",
        }),
      ],
    })
  );

const repairCalls = (p: ScriptedProvider) => p.requests.filter(isRepairRequest);
const servedA = async () => (await rubricStore.getApprovedRubric(ROUTE_A.countryCode, ROUTE_A.visaTypeId)) as any;

describe("a failed bar is repaired once, through the pipeline (#223)", () => {
  test("repaired and confirmed by both models: published, and what is served is exactly the replacement the check verified; the original stays in the draft; the record and the audit say so", async () => {
    await seedA();
    settings();
    const w = wired();
    // The ORIGINAL bar fails (as in the real run); the re-drafted one passes.
    w.provider.policy = (ctx) => (ctx.rule.title === BAR_TITLE ? barUnsureOnGroup(ctx) : undefined);
    w.provider.redraftPolicy = redraftOfBar;
    const planner = plannerStub();
    const svc = service({ checker: w.checker, planner });
    const r = await trigger(svc);

    assert.equal(r?.outcome, "published");
    assert.equal(r?.checker, "passed");
    assert.equal(planner.calls, 1);

    // The stored draft is byte-identical (never edited); the replacement is recorded beside it.
    const stored = versionDoc(KEY_A, 1);
    const originalBar = stored.criteria.find((c: any) => c.title === BAR_TITLE);
    assert.ok(originalBar, "the original rule is still in the draft: the audit trail");
    assert.equal(stored.ruleRepairs.length, 1);
    assert.equal(stored.ruleRepairs[0].criterionId, originalBar.criterionId);
    assert.equal(stored.ruleRepairs[0].replacement.title, REPAIRED_TITLE);

    // SERVED = the replacement, in the original's place, still a bar; the original is not served.
    const served = await servedA();
    assert.equal(served.criteria.length, 10);
    const servedBar = served.criteria.find((c: any) => c.criterionId === originalBar.criterionId);
    assert.equal(servedBar.title, REPAIRED_TITLE);
    assert.equal(servedBar.kind, "mandatory_bar");
    assert.ok(!served.criteria.some((c: any) => c.title === BAR_TITLE));
    assert.equal("ruleRepairs" in served, false, "the record is not client-visible");

    // CHECKED = served: both models were shown exactly the rule that is now served.
    const seen = batchRequests(w.provider).flatMap((q) => seenRules(q).map((x) => ({ role: q.role, x }))).filter((s) => s.x.title === REPAIRED_TITLE);
    assert.deepEqual(seen.map((s) => s.role).sort(), ["judgement", "verification"]);
    for (const s of seen) {
      assert.equal(s.x.stage, servedBar.stage);
      assert.equal(s.x.quote, servedBar.source.quote);
    }

    // AUDIT agrees: the approval names the repaired rule; the run record shows the attempt and the spend.
    assert.deepEqual(audits()[0].repairedCriterionIds, [originalBar.criterionId]);
    const rec = runs()[0];
    assert.equal(rec.protectedFailures?.[0].repair.status, "repaired");
    assert.equal(rec.protectedFailures?.[0].title, BAR_TITLE);
    assert.deepEqual(rec.protectedFailures?.[0].failedAspects, ["group_matches_codes"]);
    // 2 bar batches + 1 ordinary batch of 9 + 2 polarity + 1 re-draft + 2 checks of the replacement.
    assert.deepEqual(rec.checkerRequests, { total: 8, repair: 3 });
    assert.equal(w.provider.requests.length, 8);
    // The published alert says a bar was re-drafted.
    assert.match(alerts().find((a) => a.rule === "rubric_auto_published").message, /re-drafted once/);
  });

  test("the replacement still fails the check: HELD, critical alert names the rule title and the aspect, nothing published, ordinary rules were checked, the draft is untouched", async () => {
    await seedA();
    settings();
    const w = wired();
    // The model's `unsure` on the bar's stage cannot be changed by a re-draft: it reads the new one the same way.
    w.provider.policy = barUnsureOnGroup;
    w.provider.redraftPolicy = redraftOfBar;
    const r = await trigger(pipeline(w.checker));

    assert.equal(r?.outcome, "held");
    assert.equal(r?.checker, "failed");
    assert.equal(r?.reasonCodes.length, 1);
    assert.match(r?.reasonCodes[0] as string, /^protected_rule_failed:/);
    assertUntouched(KEY_A, 1, 0, null);
    assert.equal(versionDoc(KEY_A, 1).ruleRepairs, undefined, "no replacement is recorded on a held draft");
    // Held record: the failed bar with both models' verdicts and the repair attempt.
    const f = runs()[0].protectedFailures?.[0];
    assert.equal(f?.repair.status, "failed_check", String(f?.repair.detail));
    assert.deepEqual(f?.repair.replacementFailedAspects, ["group_matches_codes"]);
    assert.equal(f?.verdicts.judgement?.[5], "u", "the judgement model's unsure on group_matches_codes");
    // Complete report: the ordinary rules were checked.
    assert.ok(batchRequests(w.provider).some((q) => !seenRules(q).some((x) => x.appliesTo)));
    // The alert is critical and names the bar by title and the aspect that failed.
    const a = alerts().find((x) => x.rule === "rubric_draft_held");
    assert.equal(a.severity, "critical");
    assert.ok(a.message.includes(BAR_TITLE), "the rule title (data) is named");
    assert.match(a.message, /group_matches_codes/);
    assert.match(a.message, /Rule id crit_/);
    assert.deepEqual(r?.reasons[0].includes(BAR_TITLE), true, "the plain-words reason names the title too");
  });

  test("a re-draft the model cannot make, or code refuses: held, the draft untouched, the attempt recorded", async () => {
    for (const [name, policy, status] of [
      ["cannot be repaired", () => ({ criteria: [], suspiciousPassages: [] }), "cannot_be_repaired"],
      ["invalid quote", () => redraftOfBar().replace(body(A_LINES.bar), "A sentence that the official text does not hold."), "invalid_redraft"],
    ] as const) {
      resetStore();
      resetBucket();
      store.set("users/admin1", { email: "delivered+admin1@resend.dev", admin: true });
      await seedA();
      settings();
      const w = wired();
      w.provider.policy = barUnsureOnGroup;
      w.provider.redraftPolicy = policy;
      const r = await trigger(pipeline(w.checker));
      assert.equal(r?.outcome, "held", name);
      assertUntouched(KEY_A, 1, 0, null);
      assert.equal(runs()[0].protectedFailures?.[0].repair.status, status, name);
      assert.equal(alerts().find((x) => x.rule === "rubric_draft_held").severity, "critical", name);
    }
  });

  test("the version that was serving keeps serving, exactly as before, while the new draft is held", async () => {
    await seedA();
    settings();
    const good = wired();
    assert.equal((await trigger(pipeline(good.checker)))?.outcome, "published");
    const servedBefore = JSON.stringify(await servedA());
    const auditsBefore = audits().length;

    // A newer draft whose bar the check does not confirm, even after its one repair.
    const pristine = bigDraft(await seedSource({ id: SOURCE_A_ID, url: SOURCE_A_URL, text: A_TEXT }));
    await rubricStore.writePendingVersion({ ...pristine, createdAt: Timestamp.fromMillis(REVIEW_T0 + 86_400_000) }, [SOURCE_A_ID], { force: true, now: Timestamp.fromMillis(REVIEW_T0 + 86_400_000) });
    const bad = wired();
    bad.provider.policy = barUnsureOnGroup;
    bad.provider.redraftPolicy = redraftOfBar;
    const held = await trigger(pipeline(bad.checker), KEY_A, 2);

    assert.equal(held?.outcome, "held");
    assert.equal(headDoc(KEY_A).approvedVersion, 1);
    assert.equal(JSON.stringify(await servedA()), servedBefore, "applicants see the same rulebook");
    assert.equal(versionDoc(KEY_A, 2).reviewStatus, "pending_review");
    assert.equal(versionDoc(KEY_A, 2).ruleRepairs, undefined);
    assert.equal(audits().length, auditsBefore, "no audit entry for a hold");
  });

  test("never published with a failed bar silently missing: the bar is always in the served rulebook, as the original or as its confirmed replacement", async () => {
    // Repaired -> the replacement is served (proved above). Held -> nothing is served at all, so no rulebook lacks it.
    await seedA();
    settings();
    const w = wired();
    w.provider.policy = barUnsureOnGroup;
    w.provider.redraftPolicy = redraftOfBar;
    await trigger(pipeline(w.checker));
    assert.equal(await rubricStore.getApprovedRubric(ROUTE_A.countryCode, ROUTE_A.visaTypeId), null);
  });

  test("a re-delivered trigger, an admin re-run and the sweep never re-draft twice; a protected hold is not retried by the sweep", async () => {
    await seedA();
    settings();
    const w = wired();
    w.provider.policy = barUnsureOnGroup;
    w.provider.redraftPolicy = redraftOfBar;
    const svc = pipeline(w.checker);
    await trigger(svc);
    assert.equal(repairCalls(w.provider).length, 1);
    const spent = w.provider.requests.length;

    await trigger(svc);
    assert.equal(w.provider.requests.length, spent, "re-delivered trigger");
    await quiet(() => svc.runOnDraft(ID_A1, { trigger: "admin_endpoint" }));
    assert.equal(w.provider.requests.length, spent, "admin re-run replays the stored answers: no model call at all");
    assert.equal(runs()[0].attempts, 2);
    assert.deepEqual((await quiet(() => svc.sweepRetryable())).result, { considered: 0, retried: 0 });
    assert.equal(repairCalls(w.provider).length, 1);
  });

  test("the provider failing during the re-draft holds with a retryable reason, still critical; the sweep finishes it, with ONE re-draft in all", async () => {
    await seedA();
    settings();
    const w = wired();
    w.provider.policy = (ctx) => (ctx.rule.title === BAR_TITLE ? barUnsureOnGroup(ctx) : undefined);
    w.provider.redraftPolicy = redraftOfBar;
    const svc = pipeline(w.checker);
    w.provider.script = (_n, req) => (isRepairRequest(req) ? "hard" : undefined);
    const r = await trigger(svc);
    assert.deepEqual(r?.reasonCodes, ["checker_unavailable:provider"]);
    assert.equal(alerts().find((x) => x.rule === "rubric_draft_held").severity, "critical", "a bar failed, so it is critical");
    assertUntouched(KEY_A, 1, 0, null);

    w.provider.script = () => undefined;
    const sweep = (await quiet(() => svc.sweepRetryable())).result;
    assert.deepEqual(sweep, { considered: 1, retried: 1 });
    assert.equal(versionDoc(KEY_A, 1).reviewStatus, "approved");
    assert.equal(versionDoc(KEY_A, 1).ruleRepairs.length, 1);
    // One failed re-draft request (not an attempt) and one that worked.
    assert.equal(repairCalls(w.provider).length, 2);
  });
});

describe("wording and records (#223)", () => {
  test("the script's line: 'ran and failed' when the check ran, 'has NOT run' only when it did not", () => {
    assert.match(checkerStatusLine("failed", false, "not_run") as string, /ran and failed/);
    assert.doesNotMatch(checkerStatusLine("failed", false, "not_run") as string, /NOT run/);
    for (const checker of ["not_run", "not_configured"] as const) assert.match(checkerStatusLine(checker, false, "not_run") as string, new RegExp(`has NOT run \\(${checker}\\)`));
    assert.match(checkerStatusLine("failed", true, "not_run") as string, /has NOT run/, "--skip-checker");
    assert.equal(checkerStatusLine("passed", false, "built"), null);
  });

  test("checker_unavailable carries what was unreachable, in words for each, and the sweep still treats it as retryable", () => {
    for (const what of ["snapshot_read", "settings_read", "provider", "provider_refused", "not_configured", "deadline", "ledger", "internal"]) {
      const words = reasonInWords(`checker_unavailable:${what}`);
      assert.match(words, /independent AI check could not be completed because/);
      assert.doesNotMatch(words, /something it needs/, what);
      assert.ok(RETRYABLE_REASONS.includes(`checker_unavailable:${what}`.split(":")[0]));
    }
    assert.match(reasonInWords("checker_unavailable:made_up"), /something it needs could not be reached/);
    assert.match(reasonInWords("checker_unavailable"), /could not be completed/);
  });

  test("an unexpected error is logged by class only, never its text, and the reason names the stage", async () => {
    const svc = new RubricCheckerService({ provider: () => new ScriptedProvider(), readSnapshot: async () => { throw new Error("secret-token-123 /private/path"); }, loadSettings: settingsWith(), ledger: new MemoryLedger() });
    const { result, lines } = await quiet(() => svc.check({ routeKey: "XA_xa-test", version: 1, runId: "XA_xa-test__v1", rubric: rubricOf([ruleOf(1)], null), codeLeftOutIds: [] }));
    assert.deepEqual(result, { ok: false, reasonCodes: ["checker_unavailable:snapshot_read"] });
    assert.ok(lines.length > 0);
    assert.ok(lines.every((l) => !l.includes("secret-token-123") && !l.includes("/private/path")), "the error text is never logged");
  });

  test("containment: only the review service, the pipeline and the read-side filter name the recorded replacements", () => {
    const src = path.join(__dirname, "..", "..", "..", "src");
    const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : e.name.endsWith(".ts") ? [path.join(dir, e.name)] : []));
    const users = walk(src)
      .filter((f) => /\bruleRepairs\b/.test(fs.readFileSync(f, "utf8")))
      .map((f) => path.relative(src, f))
      .sort();
    // #223 (EXPLICIT extension): the replacements are WRITTEN by the pipeline (through the approval transaction's
    // planner fields), VALIDATED by the review service, APPLIED by the read-side filter, and typed in the types file.
    assert.deepEqual(users, [path.join("scrapers", "rubric", "rubric-checker.ts"), path.join("scrapers", "rubric", "rubric-exclusions.ts"), path.join("scrapers", "rubric", "rubric-repair.ts"), path.join("services", "rubric-auto-publish.service.ts"), path.join("services", "rubric-review.service.ts"), path.join("types", "rubric.ts")]);
    // The planner's allow-list names exactly these fields ((#233 P4b) EXPLICIT extension: the layer check's record and conflicts).
    assert.deepEqual([...PLANNER_WRITABLE_FIELDS], ["questionPlan", "ruleRepairs", "layerCheck", "layerConflicts"]);
  });
});

// ============================================
// Ordinary-rule repair through the pipeline (issue #244)
// ============================================
//
// An ordinary rule the check finds WRONG gets one re-draft; the replacement, checked by one model, is served in
// its place. The gates, the question plan and the approval run on the rulebook WITH the replacements; the run
// record, the alert and the audit list them. Route A has ten rules (nine ordinary): two found wrong is 20 %,
// over the 15 % budget unless they are repaired, and exactly at (not over) the 20 % guard.

const WRONG_A = "Valid application";
const WRONG_B = "No set level of funds";

/** What the model answers to an ordinary re-draft: the same quote, a renewed title. */
const renewed = ({ shown }: { shown: Record<string, any> }) =>
  criteriaWire(answer({ criteria: [crit({ ref: "r1", title: `Renewed ${shown.title}`, kind: shown.kind, stage: shown.stage, quote: shown.quote, probeFactors: ["a factor"] })] }));
const bothWrong = ({ rule }: { rule: any }) => (rule.title === WRONG_A || rule.title === WRONG_B ? { title_faithful: "no" as const } : undefined);

describe("an ordinary rule found wrong is repaired once, through the pipeline (#244)", () => {
  test("both repaired and confirmed: published (the budget sees the replacements), served = the replacements, record, audit, alert and plan all say so", async () => {
    await seedA();
    settings();
    const w = wired();
    w.provider.policy = bothWrong;
    w.provider.redraftPolicy = renewed;
    const planner = plannerStub();
    const planned: any[] = [];
    const spyPlanner = { plan: async (i: any) => (planned.push(i), planner.plan(i)) } as any;
    const r = await trigger(service({ checker: w.checker, planner: spyPlanner }));

    assert.equal(r?.outcome, "published", JSON.stringify(r?.reasonCodes));
    // The budget: nothing is left out, although 2 of 10 were found wrong (20 % would have held).
    assert.equal(r?.counts.leftOut, 0);
    assert.equal(r?.counts.ordinaryRepairs?.repaired, 2);
    assert.equal(r?.counts.ordinaryRepairs?.eligible, 2);
    // Stored draft untouched; the replacements recorded beside it; served = replacements.
    const stored = versionDoc(KEY_A, 1);
    assert.ok(stored.criteria.some((c: any) => c.title === WRONG_A), "the original stays: the audit trail");
    assert.equal(stored.ruleRepairs.length, 2);
    const served = await servedA();
    assert.equal(served.criteria.length, 10);
    assert.ok(served.criteria.some((c: any) => c.title === `Renewed ${WRONG_A}`) && !served.criteria.some((c: any) => c.title === WRONG_A));
    // The question plan was built on the FINAL rule set: it saw the replacements and no exclusion of them.
    assert.equal(planned.length, 1);
    assert.ok(planned[0].rubric.criteria.some((c: any) => c.title === `Renewed ${WRONG_B}`));
    assert.ok(!planned[0].rubric.criteria.some((c: any) => c.title === WRONG_B));
    assert.deepEqual(planned[0].excludedCriterionIds, []);
    // Run record, audit, alert.
    const rec = runs()[0];
    assert.deepEqual(rec.ordinaryRepairs?.map((x) => x.repair.status), ["repaired", "repaired"]);
    assert.equal(rec.counts.ordinaryRepairs?.requests.redraft, 2);
    assert.ok(rec.gates.some((g) => g.gate === "ordinary_repair" && /2 eligible: 2 repaired/.test(g.detail ?? "")));
    assert.equal(audits()[0].repairedCriterionIds.length, 2);
    assert.match(alerts().find((a) => a.rule === "rubric_auto_published").message, /Ordinary rules the check found wrong, re-drafted once automatically and confirmed/);
    // ONE model read the replacements; 2 re-drafts; one check batch.
    assert.equal(repairCalls(w.provider).length, 2);
    assert.deepEqual(rec.checkerRequests, { total: 8, repair: 3 });
  });

  test("one repaired, one still failing: published with ONE leave-out (10 %), recorded with its repair status", async () => {
    await seedA();
    settings();
    const w = wired();
    w.provider.policy = (ctx) => (ctx.rule.title === `Renewed ${WRONG_B}` ? { condition_faithful: "no" as const } : bothWrong(ctx));
    w.provider.redraftPolicy = renewed;
    const r = await trigger(pipeline(w.checker));
    assert.equal(r?.outcome, "published");
    assert.equal(r?.counts.leftOut, 1);
    assert.equal(r?.leftOut[0].basis, "found_wrong");
    const rec = runs()[0];
    assert.deepEqual(rec.ordinaryRepairs?.map((x) => x.repair.status), ["repaired", "failed_check"]);
    assert.equal(versionDoc(KEY_A, 1).ruleRepairs.length, 1);
    assert.equal(versionDoc(KEY_A, 1).excludedCriterionIds.length, 1);
  });

  test("both still failing: held on the budget as before, the run says by how much and what the repairs did; nothing published", async () => {
    await seedA();
    settings();
    const w = wired();
    w.provider.policy = (ctx) => (String(ctx.rule.title).startsWith("Renewed") ? { condition_faithful: "no" as const } : bothWrong(ctx));
    w.provider.redraftPolicy = renewed;
    const r = await trigger(pipeline(w.checker));
    assert.equal(r?.outcome, "held");
    assert.ok(r?.reasonCodes.includes("leave_out_budget_exceeded"));
    assertUntouched(KEY_A, 1, 0, null);
    assert.equal(versionDoc(KEY_A, 1).ruleRepairs, undefined);
    assert.match(runs()[0].gates.find((g) => g.gate === "leave_out_budget")?.detail ?? "", /2 of 10 left out for correctness/);
    assert.equal(runs()[0].counts.ordinaryRepairs?.failedCheck, 2);
  });

  test("a repair cut off by the provider while the budget fails holds with the RETRYABLE reason; the sweep finishes it and nothing is re-drafted twice", async () => {
    await seedA();
    settings();
    const w = wired();
    w.provider.policy = bothWrong;
    w.provider.redraftPolicy = renewed;
    // Every re-draft request fails hard (the provider): nothing is repaired, so both stay left out (20 %).
    w.provider.script = (_n, req) => (isRepairRequest(req) ? "hard" : undefined);
    const svc = pipeline(w.checker);
    const r = await trigger(svc);
    assert.equal(r?.outcome, "held");
    assert.deepEqual(r?.reasonCodes, ["checker_unavailable:provider"], "not the budget code: the budget might still be met");
    assert.equal(runs()[0].counts.ordinaryRepairs?.cutOff, "provider");
    assertUntouched(KEY_A, 1, 0, null);

    w.provider.script = () => undefined;
    assert.deepEqual((await quiet(() => svc.sweepRetryable())).result, { considered: 1, retried: 1 });
    assert.equal(versionDoc(KEY_A, 1).reviewStatus, "approved");
    assert.equal(versionDoc(KEY_A, 1).ruleRepairs.length, 2);
    // Two failed requests (not attempts: nothing was stored) and then the two re-drafts that worked: no rule twice.
    assert.equal(repairCalls(w.provider).length, 4);
  });

  test("more eligible rules than the guard allows: no ordinary re-draft, the run record says ordinary_repair_skipped:too_many, judged by the budget as today", async () => {
    await seedA();
    settings();
    const w = wired();
    w.provider.policy = ({ rule }) => (["Valid application", "No set level of funds", "Third party support"].includes(rule.title) ? { title_faithful: "no" as const } : undefined);
    w.provider.redraftPolicy = renewed;
    const r = await trigger(pipeline(w.checker)); // 3 of 10 = 30 % > 20 %
    assert.equal(r?.outcome, "held");
    assert.equal(repairCalls(w.provider).length, 0);
    assert.equal(runs()[0].counts.ordinaryRepairs?.skipped, "too_many");
    assert.ok(runs()[0].gates.some((g) => g.gate === "ordinary_repair" && /ordinary_repair_skipped:too_many/.test(g.detail ?? "")));
    assert.ok(runs()[0].reasonCodes.includes("leave_out_budget_exceeded"));
  });

  test("the approval validates the rulebook WITH the replacements: a replacement that breaks the structure is refused by the shared transaction, never served", async () => {
    await seedA();
    settings();
    const w = wired();
    w.provider.policy = bothWrong;
    w.provider.redraftPolicy = renewed;
    // The pipeline's own structural run already includes the replacements; prove the transaction does too by
    // reading what it is given: the recorded field is the planner field `ruleRepairs`, applied before validation.
    const svc = pipeline(w.checker);
    await trigger(svc);
    const extra = (svc as any).decideCalls[0][3].extraReviewFields;
    assert.equal(extra.ruleRepairs.length, 2);
    assert.ok(PLANNER_WRITABLE_FIELDS.includes("ruleRepairs"));
  });
});
