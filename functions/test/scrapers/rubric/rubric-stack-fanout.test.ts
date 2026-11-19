// ============================================
// Stacked rulebooks, second half: a shared layer's new version fans out
// (issue #233, P4b of #228)
// ============================================
//
// When a SHARED layer publishes a new version:
//   (a) the open applications whose stack includes it are ESTIMATED, and wait
//       for an admin's confirmation; only then are they queued as ordinary
//       bulk jobs (the daily batch caps apply in the sweep, unchanged);
//   (b) one rule-change event per affected MEMBER route is recorded, keyed by
//       the layer, the version and the member route.
// What this file pins: the estimate (who is a candidate), no job and no spend
// before the confirmation, the confirmation's refusals, the queue after it,
// the confirmed number never passed, idempotence of a re-delivered event and
// a repeated confirm, the alerts per member route (and who is told), and the
// per-layer change summary.
//
// Made-up ids only. No Firebase (the in-memory fake), no model call.

import { before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { Timestamp } from "firebase-admin/firestore";
import { fakeCollection, fakeRunTransaction, installFakes, resetStore, store } from "../../helpers/fake-firestore";
import { BulkReassessmentService, FanOutError, fanOutEstimateId } from "../../../src/services/ai-bulk-reassessment.service";
import { RuleChangeAlertsService } from "../../../src/services/rule-change-alerts.service";
import { stackFromReads } from "../../../src/scrapers/rubric/rubric-stack";
import { keyFieldsOf, rulebookTargetOf } from "../../../src/scrapers/rubric/rubric-key";
import { layerEventId } from "../../../src/types/rule-change";
import type { AssessmentCriterion, VisaRubric } from "../../../src/types/rubric";
import type { RouteLayer } from "../../../src/types/shared-route";
import type { RubricReviewAuditEntry } from "../../../src/services/rubric-review.service";

/* eslint-disable @typescript-eslint/no-explicit-any */

// ============================================
// Fixtures
// ============================================

const BLOC = "zq-bloc";
const SHARED_ROUTE = "zq-short-stay";
const SHARED_KEY = `${BLOC}_${SHARED_ROUTE}`;
const A = { countryCode: "XQ", visaTypeId: "xq-short-stay" };
const B = { countryCode: "XZ", visaTypeId: "xz-short-stay" };
const keyOf = (r: { countryCode: string; visaTypeId: string }) => `${r.countryCode}_${r.visaTypeId}`;
const T0 = Date.parse("2026-11-14T08:00:00Z");

/** An approved layer version. */
function layer(key: { countryCode?: string; visaTypeId?: string; authorityId?: string; routeSlug?: string }, version: number, ruleIds: string[]): VisaRubric {
  const target = rulebookTargetOf(key);
  return {
    schemaVersion: 1, ...keyFieldsOf(target), version, reviewStatus: "approved", intentPolarity: "dual_intent_permitted", reviewedBy: "system:rubric-auto-publish",
    reviewedAt: Timestamp.fromMillis(T0), rejectReason: null, revision: 1, supersededAt: null, intentPolarityProposal: null, severityLevels: ["high"],
    criteria: ruleIds.map((id) => ({ criterionId: id, title: `Rule ${id}`, kind: "judgement", stage: "eligibility", severity: "high", applicability: "all_applicants", confidence: 0.9, source: { quote: `Quote of ${id}.`, sourceId: "src", url: `https://rules.example/${id}`, contentHash: "h".repeat(64), retrievedAt: "2026-11-01T00:00:00.000Z" } }) as AssessmentCriterion),
    intakeQuestions: [], evidenceItems: [], sourceSnapshots: [], sourceSetHash: `h-${target.routeKey}-${version}`, extractorModel: "m", extractorPromptVersion: "p", extractionRunId: `r-${version}`,
    discardedCount: 0, discarded: [], suspiciousPassages: [], flags: [], createdAt: Timestamp.fromMillis(T0),
  };
}

/** The approved versions by key: the shared layer at v4 (new) over v3, each member's own layer at v2. */
const VERSIONS: Record<string, VisaRubric> = {
  [`${SHARED_KEY}#3`]: layer({ authorityId: BLOC, routeSlug: SHARED_ROUTE }, 3, ["s-1", "s-2"]),
  [`${SHARED_KEY}#4`]: layer({ authorityId: BLOC, routeSlug: SHARED_ROUTE }, 4, ["s-1", "s-3"]),
  [`${keyOf(A)}#2`]: layer(A, 2, ["o-1"]),
  [`${keyOf(B)}#2`]: layer(B, 2, ["o-1"]),
};
let sharedVersion = 4;

/** The stack of an application on member route `r`: the shared layer at `sharedVersion`, its own at v2. */
function stackOf(app: { countryCode: string; visaTypeId: string }) {
  const layers: RouteLayer[] = [{ authorityId: BLOC, rulebookKey: SHARED_KEY, role: "shared" }, { authorityId: app.countryCode, rulebookKey: keyOf(app), role: "own" }];
  return stackFromReads([{ layer: layers[0], rubric: VERSIONS[`${SHARED_KEY}#${sharedVersion}`] }, { layer: layers[1], rubric: VERSIONS[`${keyOf(app)}#2`] }]);
}

/** Seed an application, optionally with a succeeded assessment on the previous shared version, and documents. */
function seedApp(id: string, route: { countryCode: string; visaTypeId: string }, opts: { status?: string; assessed?: boolean; current?: boolean; docs?: number; routeStack?: string[] | null; agentId?: string } = {}): void {
  store.set(`applications/${id}`, {
    id, userId: `u-${id}`, countryCode: route.countryCode, visaTypeId: route.visaTypeId, status: opts.status ?? "in_progress", visaTypeName: "Short stay",
    ...(opts.routeStack === null ? {} : { routeStack: opts.routeStack ?? [SHARED_KEY, keyOf(route)] }),
    ...(opts.agentId ? { agentId: opts.agentId, agencyId: "agency-1" } : {}),
  });
  if (opts.assessed !== false) {
    store.set(`applicationAssessments/prev-${id}`, {
      id: `prev-${id}`, applicationId: id, countryCode: route.countryCode, visaTypeId: route.visaTypeId, status: "succeeded", rubricVersion: 2,
      layerVersions: { [SHARED_KEY]: opts.current ? 4 : 3, [keyOf(route)]: 2 }, createdAt: Timestamp.fromMillis(T0 - 86_400_000),
    });
  }
  for (let i = 0; i < (opts.docs ?? 0); i++) store.set(`documents/${id}-d${i}`, { applicationId: id });
}

/** The audit entry of the shared layer's approval (no country pair). */
const approval = (id = "audit-shared-4", version = 4, previous: number | null = 3): RubricReviewAuditEntry & { id: string } => ({
  id, at: Timestamp.fromMillis(T0), by: "system:rubric-auto-publish", action: "approve", routeKey: SHARED_KEY, authorityId: BLOC, routeSlug: SHARED_ROUTE,
  version, reason: null, intentPolarity: "dual_intent_permitted", intentPolarityProposal: null, intentPolarityOverridden: false, acknowledgedFlags: [],
  previousApprovedVersion: previous, approvedVersion: version, revisionBefore: 0, revisionAfter: 1, sourceSetHash: "h",
} as any);

/** A provider of batches that records every submit (nothing may be submitted before a confirmation). */
const batches = { submits: 0, async submit() { this.submits++; return "provider-batch-1"; }, async retrieve() { return null as any; }, async results() { return []; } } as any;

/** The bulk service over fakes. */
function bulk(): BulkReassessmentService {
  const officer: any = {
    loadInputs: async () => ({ documents: [], statements: [], intake: {}, eligibilityAnswers: null, nationality: null, applicantName: null, eligibilityScore: null }),
    inputsFor: (_l: unknown, rubricVersion: number, layerVersions: unknown) => ({ rubricVersion, layerVersions, documents: [], statements: [], eligibilityAnswers: null, intake: {} }),
  };
  const svc = new BulkReassessmentService({
    officer,
    batches,
    getApprovedRubric: async () => null,
    getRubricVersion: async (k: string, v: number) => VERSIONS[`${k}#${v}`] ?? null,
    getRulebookStack: async (app: any) => stackOf(app),
    loadBytes: async () => Buffer.from(""),
    readSettings: async () => ({ ok: true, settings: { enabled: true, maxBatchRequestsPerDay: 1000, maxBatchCostUsdPerDay: 0, maxFileBytes: 10_000_000 } as any }),
    notify: async () => undefined as any,
    adminUids: async () => [],
    now: () => new Date(T0),
    openApplicationsOnLayer: async () => [...store.entries()].filter(([p]) => /^applications\/[^/]+$/.test(p)).map(([, d]) => d as any).filter((a) => !["approved", "rejected", "withdrawn", "expired"].includes(a.status)).sort((a, b) => a.id.localeCompare(b.id)),
  } as any);
  svc.runTransaction = fakeRunTransaction as any;
  return svc;
}

/** Queued bulk jobs. */
const jobs = () => [...store.entries()].filter(([p, d]) => p.startsWith("applicationAssessments/") && (d as any).viaBatch === true).map(([, d]) => d as any);
const runDoc = (id = "audit-shared-4") => store.get(`bulkReassessments/${id}`) as any;
const quiet = async <T>(fn: () => Promise<T>): Promise<T> => {
  const log = console.log;
  console.log = () => undefined;
  try {
    return await fn();
  } finally {
    console.log = log;
  }
};

before(async () => {
  await installFakes();
  const firebase: any = await import("../../../src/utils/firebase");
  for (const c of ["applications", "applicationAssessments", "bulkReassessments", "documents", "assessmentBatches", "aiCosts", "ruleChangeEvents", "ruleChangeNotices", "agencies"]) firebase.collections[c] = fakeCollection(c);
});

beforeEach(() => {
  resetStore();
  sharedVersion = 4;
  batches.submits = 0;
  // A: one candidate with two documents, one already current, one closed, one never assessed.
  seedApp("app-a1", A, { docs: 2 });
  seedApp("app-a2", A, { current: true });
  seedApp("app-a3", A, { status: "approved" });
  seedApp("app-a4", A, { assessed: false });
  // B: one candidate with no document, started before stacks were stored (resolves live).
  seedApp("app-b1", B, { routeStack: null });
});

// ============================================
// (a) The re-assessment fan-out
// ============================================

describe("a shared layer's approval: estimate, confirmation, then the bulk path", () => {
  test("the estimate: only open, assessed, not-yet-current applications; counts per member route; NOTHING queued", async () => {
    const svc = bulk();
    assert.equal(await quiet(() => svc.startRun("audit-shared-4", approval())), "started");
    const run = runDoc();
    assert.equal(run.status, "awaiting_confirmation");
    assert.equal(run.countryCode, undefined, "a fan-out run names no single route");
    assert.equal(run.fanOut.layerKey, SHARED_KEY);
    assert.equal(run.fanOut.layerVersion, 4);
    const e = run.fanOut.estimate;
    assert.equal(e.applications, 2);
    assert.equal(e.requestsAtMost, (1 + 2) + (1 + 0), "one judgement each plus one read per stored document");
    assert.deepEqual(e.memberRoutes, [{ ...A, applications: 1 }, { ...B, applications: 1 }]);
    assert.match(e.plain, /2 open applications on 2 member routes/);
    assert.equal(e.estimateId, fanOutEstimateId(SHARED_KEY, 4, [{ applicationId: "app-a1", requestsAtMost: 3 }, { applicationId: "app-b1", requestsAtMost: 1 }]));
    assert.equal(jobs().length, 0, "no job before the confirmation");
  });

  test("no spend before the confirmation: the sweep submits nothing and queues nothing", async () => {
    const svc = bulk();
    await quiet(() => svc.startRun("audit-shared-4", approval()));
    const sweep = await quiet(() => svc.runSweep());
    assert.equal(sweep.skipped, "idle");
    assert.equal(batches.submits, 0);
    assert.equal(jobs().length, 0);
  });

  test("the confirmation refuses a wrong estimate id and a missing statement, and changes nothing", async () => {
    const svc = bulk();
    await quiet(() => svc.startRun("audit-shared-4", approval()));
    await assert.rejects(svc.confirmFanOut("audit-shared-4", { estimateId: "stale", statementAccepted: true }, "admin-1"), (e: unknown) => e instanceof FanOutError && e.code === "ESTIMATE_MISMATCH" && e.status === 409);
    await assert.rejects(svc.confirmFanOut("audit-shared-4", { estimateId: runDoc().fanOut.estimate.estimateId, statementAccepted: false }, "admin-1"), (e: unknown) => e instanceof FanOutError && e.code === "STATEMENT_REQUIRED");
    await assert.rejects(svc.confirmFanOut("nope", { estimateId: "x", statementAccepted: true }, "admin-1"), (e: unknown) => e instanceof FanOutError && e.status === 404);
    assert.equal(runDoc().status, "awaiting_confirmation");
    assert.equal(jobs().length, 0);
  });

  test("confirmed: the candidates are queued as ordinary bulk jobs on the stack's versions; a repeat confirm adds nothing", async () => {
    const svc = bulk();
    await quiet(() => svc.startRun("audit-shared-4", approval()));
    const estimateId = runDoc().fanOut.estimate.estimateId;
    const out = await quiet(() => svc.confirmFanOut("audit-shared-4", { estimateId, statementAccepted: true }, "admin-1"));
    assert.equal(out.alreadyConfirmed, false);
    assert.deepEqual(out.run.fanOut?.confirmation && [out.run.fanOut.confirmation.by, out.run.fanOut.confirmation.maxRequests], ["admin-1", 4]);
    const queued = jobs();
    assert.deepEqual(queued.map((j) => j.applicationId).sort(), ["app-a1", "app-b1"]);
    for (const j of queued) {
      assert.equal(j.status, "queued");
      assert.equal(j.bulkRunId, "audit-shared-4");
      assert.equal(j.rubricVersion, 2, "the application's own layer version");
      assert.equal(j.layerVersions[SHARED_KEY], 4, "assessed against the NEW shared version");
      assert.equal(j.updateReason, "rules_updated");
    }
    assert.equal(runDoc().status, "running");
    assert.equal(runDoc().enqueueDone, true);
    // Repeated confirm (a double click): harmless, nothing new.
    const again = await quiet(() => svc.confirmFanOut("audit-shared-4", { estimateId, statementAccepted: true }, "admin-1"));
    assert.equal(again.alreadyConfirmed, true);
    assert.equal(jobs().length, 2);
  });

  test("the confirmed number is never passed: a document added after the estimate stops the queue and asks again", async () => {
    const svc = bulk();
    await quiet(() => svc.startRun("audit-shared-4", approval()));
    const estimateId = runDoc().fanOut.estimate.estimateId;
    // After the estimate (bound 3 + 1 = 4) a third document arrives on app-a1: it now needs 4 on its own.
    store.set("documents/app-a1-late", { applicationId: "app-a1" });
    store.set("documents/app-b1-late", { applicationId: "app-b1" });
    await quiet(() => svc.confirmFanOut("audit-shared-4", { estimateId, statementAccepted: true }, "admin-1"));
    const run = runDoc();
    assert.equal(run.status, "awaiting_confirmation", "asked again");
    assert.equal(run.fanOut.voidedConfirmations.length, 1);
    assert.equal(run.fanOut.confirmation, null);
    assert.deepEqual(jobs().map((j) => j.applicationId), ["app-a1"], "only what fits the confirmed number was queued");
    assert.equal(run.fanOut.estimate.applications, 1, "the new estimate covers what is left");
    assert.notEqual(run.fanOut.estimate.estimateId, estimateId);
  });

  test("a re-delivered approval event does nothing twice", async () => {
    const svc = bulk();
    await quiet(() => svc.startRun("audit-shared-4", approval()));
    const before = JSON.stringify(runDoc());
    assert.equal(await quiet(() => svc.startRun("audit-shared-4", approval())), "duplicate");
    assert.equal(JSON.stringify(runDoc()), before);
  });

  test("a newer shared approval overtakes a fan-out still waiting for its confirmation", async () => {
    const svc = bulk();
    await quiet(() => svc.startRun("audit-shared-4", approval()));
    sharedVersion = 4;
    await quiet(() => svc.startRun("audit-shared-5", approval("audit-shared-5", 5, 4)));
    assert.equal(runDoc("audit-shared-4").status, "cancelled");
  });

  test("nothing to re-assess: the run completes without asking anyone", async () => {
    resetStore();
    seedApp("app-x", A, { current: true });
    const svc = bulk();
    await quiet(() => svc.startRun("audit-shared-4", approval()));
    assert.equal(runDoc().status, "running");
    assert.equal(runDoc().fanOut.estimate.applications, 0);
    await quiet(() => svc.runSweep());
    assert.equal(runDoc().status, "completed");
  });

  test("the change summary of a stack assessment is per layer, with the shared layer's ids as served", async () => {
    const svc: any = bulk();
    const rubric = stackOf(A).rubric as VisaRubric;
    const criteria = await svc.stackDiff(rubric, { layerVersions: { [SHARED_KEY]: 3, [keyOf(A)]: 2 } });
    assert.deepEqual(criteria, { added: [`${SHARED_KEY}::s-3`], removed: [`${SHARED_KEY}::s-2`], changed: [] });
    assert.equal(await svc.stackDiff(rubric, {}), null, "no recorded layer versions: no guessed diff");
  });
});

// ============================================
// (b) One rule-change alert per affected member route
// ============================================

describe("a shared layer's approval: one rule-change event per member route", () => {
  const told: any[] = [];
  const alerts = () =>
    new RuleChangeAlertsService({
      getRubricVersion: async (k: string, v: number) => VERSIONS[`${k}#${v}`] ?? null,
      notify: async (input: any) => void told.push(input),
      addNote: async () => undefined,
      now: () => new Date(T0),
      memberRoutesOfLayer: async () => [A, B],
    } as any);
  const events = () => [...store.entries()].filter(([p]) => p.startsWith("ruleChangeEvents/")).map(([, d]) => d as any);

  beforeEach(() => void (told.length = 0));

  test("recorded per member route, keyed by layer + version + route, with the shared layer's diff", async () => {
    const svc = alerts();
    assert.equal(await quiet(() => svc.recordRubricApproval("audit-shared-4", approval())), "recorded");
    const ev = events();
    assert.deepEqual(ev.map((e) => e.id).sort(), [layerEventId(SHARED_KEY, 4, keyOf(A)), layerEventId(SHARED_KEY, 4, keyOf(B))].sort());
    for (const e of ev) {
      assert.equal(e.layerKey, SHARED_KEY);
      assert.equal(e.status, "pending");
      assert.equal(e.rubricVersion, 4);
      assert.deepEqual([e.rubricSummary.addedCount, e.rubricSummary.removedCount], [1, 1]);
    }
    assert.deepEqual(ev.map((e) => e.routeKey).sort(), [keyOf(A), keyOf(B)]);
    // Re-delivered: nothing twice.
    assert.equal(await quiet(() => svc.recordRubricApproval("audit-shared-4", approval())), "duplicate");
    assert.equal(events().length, 2);
  });

  test("a first shared approval changes nobody's rules: recorded as skipped, sends nothing", async () => {
    const svc = alerts();
    assert.equal(await quiet(() => svc.recordRubricApproval("audit-shared-1", approval("audit-shared-1", 4, null))), "skipped");
    assert.ok(events().every((e) => e.status === "skipped" && e.skipReason === "first_approval"));
  });

  test("on a member route, only applications whose stack includes the layer are told (staff only; the applicant on an agent case gets nothing)", async () => {
    const svc: any = alerts();
    await quiet(() => svc.recordRubricApproval("audit-shared-4", approval()));
    const event = events().find((e) => e.routeKey === keyOf(A));
    seedApp("app-on", A, { agentId: "agent-1" });
    seedApp("app-off", A, { agentId: "agent-2", routeStack: [keyOf(A)] });
    const tally = { ...event };
    await quiet(() => svc.handleApplication(tally, { ...(store.get("applications/app-on") as any) }));
    await quiet(() => svc.handleApplication(tally, { ...(store.get("applications/app-off") as any) }));
    assert.deepEqual(told.map((t) => t.userId), ["agent-1"]);
    assert.equal(tally.skippedOtherStack, 1);
    assert.match(told[0].body, new RegExp(`shared rules \\(${SHARED_KEY}\\)`));
    assert.match(told[0].body, /once an admin confirms/);
  });

  test("the event's wait for the re-assessment ends when the fan-out is waiting for its confirmation (no reviewer was told yet)", async () => {
    const svc: any = alerts();
    await quiet(() => svc.recordRubricApproval("audit-shared-4", approval()));
    store.set("bulkReassessments/audit-shared-4", { status: "awaiting_confirmation" });
    assert.equal(await svc.readyToNotify(events()[0]), true);
  });
});
