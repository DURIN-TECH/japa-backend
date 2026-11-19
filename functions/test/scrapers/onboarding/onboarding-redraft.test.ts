// ============================================
// The automatic re-draft defers to an active onboarding run (issue #225)
// ============================================
//
// Two parts:
//   1. The PURE decisions of onboarding-redraft.ts (no database).
//   2. The real trigger path (`rubricExtractionService.onGuidanceChanged`)
//      through the real onboarding guard and the real drafting-job service,
//      over the in-memory Firestore of the onboarding harness. No network, no
//      live model, no emulator.
//
// What must hold (the issue's decision):
//   - no active run: the re-draft starts exactly as before;
//   - an active run: nothing is started, and the reason is recorded;
//   - the run ends without covering the change (cancelled, failed): the normal
//     re-draft starts then (the change is not lost);
//   - the run drafted the change: nothing is started again (no double spend);
//   - a re-draft that took its claim just before a run was created: the run
//     does not crawl until the claim is released (no race).

import { before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { Timestamp } from "firebase-admin/firestore";
import { resetStore, store } from "../../helpers/fake-firestore";
import { quiet, resetBucket } from "../rubric/rubric-harness";
import {
  ADMIN, COUNTRY, ROUTE_KEY, VISA_ID, T0, confirmAndDraft, docsUnder, installOnboardingFakes, makeOnboarding, prepare, pump, runOf, writePublishRun,
  type OnboardingHarness,
} from "./onboarding-harness";
import {
  DEFERRED_REASON_CODE,
  hasLiveClaim,
  isSettled,
  liveClaims,
  mergeDeferral,
  runBlocksRedraft,
} from "../../../src/scrapers/onboarding/onboarding-redraft";
import { RUN_STATUSES, isTerminalRun } from "../../../src/scrapers/onboarding/onboarding-types";
import type { StartJobResult } from "../../../src/scrapers/rubric/rubric-extraction-job";

/* eslint-disable @typescript-eslint/no-explicit-any */

// ============================================
// 1. Pure decisions
// ============================================

/** A start result with only the fields a test cares about. */
const result = (outcome: StartJobResult["outcome"], reasonCode: string | null = null, jobId: string | null = null): StartJobResult => ({
  routeKey: ROUTE_KEY, outcome, jobId, jobStatus: null, reasonCode, message: null, plan: [], estimate: null,
});

describe("pure decisions", () => {
  test("every ACTIVE run status blocks the re-draft; every final one, or no run, does not", () => {
    for (const status of RUN_STATUSES) {
      assert.equal(runBlocksRedraft({ status }), !isTerminalRun(status), status);
    }
    assert.equal(runBlocksRedraft(null), false);
    assert.equal(runBlocksRedraft(undefined), false);
    // The four the issue names as "before it finishes, fails or is cancelled".
    for (const s of ["preparing", "awaiting_confirmation", "running", "waiting_for_publish"] as const) assert.equal(runBlocksRedraft({ status: s }), true);
  });

  test("claims hold until they expire; expired ones are dropped", () => {
    const claims = { a: Timestamp.fromMillis(1000), b: Timestamp.fromMillis(3000) };
    assert.deepEqual(Object.keys(liveClaims(claims, 2000)), ["b"]);
    assert.equal(hasLiveClaim(claims, 2000), true);
    assert.equal(hasLiveClaim(claims, 3000), false, "a claim is dead AT its expiry");
    assert.equal(hasLiveClaim(undefined, 0), false);
    assert.equal(hasLiveClaim({}, 0), false);
  });

  test("a deferral records the sources once each, keeps its first time and bumps seq", () => {
    const t1 = Timestamp.fromMillis(1);
    const t2 = Timestamp.fromMillis(2);
    const a = mergeDeferral(null, { countryCode: "XX", visaTypeId: "xx-v", sourceId: "s1", runId: "r1" }, t1);
    assert.deepEqual(a.sourceIds, ["s1"]);
    assert.equal(a.seq, 1);
    assert.match(a.reason, /onboarding run \(r1\) is active/);
    const b = mergeDeferral(a, { countryCode: "XX", visaTypeId: "xx-v", sourceId: "s1", runId: "r1" }, t2);
    const c = mergeDeferral(b, { countryCode: "XX", visaTypeId: "xx-v", sourceId: "s2", runId: "r2" }, t2);
    assert.deepEqual(c.sourceIds, ["s1", "s2"]);
    assert.equal(c.seq, 3);
    assert.equal(c.firstAt.toMillis(), 1);
    assert.equal(c.lastAt.toMillis(), 2);
    assert.equal(c.runId, "r2");
  });

  test("what settles a deferral: a start, an unchanged gate, a live job; NOT a job being cancelled or a refusal that clears by itself", () => {
    assert.equal(isSettled(result("started"), null), true);
    assert.equal(isSettled(result("restarted"), null), true);
    assert.equal(isSettled(result("unchanged", "source_unchanged"), null), true);
    // An existing job covers the change only while it is not on its way out.
    assert.equal(isSettled(result("existing", null, "j"), { status: "running", cancelRequested: false }), true);
    assert.equal(isSettled(result("existing", null, "j"), { status: "succeeded", cancelRequested: false }), true);
    assert.equal(isSettled(result("existing", null, "j"), { status: "running", cancelRequested: true }), false);
    assert.equal(isSettled(result("existing", null, "j"), null), false);
    // Refusals: permanent ones settle (the trigger would have ended there too), transient ones are retried.
    assert.equal(isSettled(result("refused", "disabled"), null), true);
    assert.equal(isSettled(result("refused", "run_cap_exceeded"), null), true);
    for (const code of ["settings_unavailable", "unexpected_error", "daily_cap_reached"]) assert.equal(isSettled(result("refused", code), null), false, code);
    assert.equal(isSettled(result("dry_run"), null), false);
  });
});

// ============================================
// 2. The trigger path over the real guard and job service
// ============================================

let oh: OnboardingHarness;

before(async () => {
  await installOnboardingFakes();
});

beforeEach(async () => {
  resetStore();
  resetBucket();
  oh = await makeOnboarding();
  // The trigger's listener starts jobs through the real job service and asks
  // the real onboarding service (the guard), as in production.
  (oh.h.service as any).deps.startJob = (input: any) => oh.jh.jobs.startJob(input);
  (oh.h.service as any).deps.redraftGuard = oh.svc;
});

/** The stored onboarding head of the route. */
const headOf = (): any => store.get(`routeOnboardingRoutes/${ROUTE_KEY}`);
/** Drafting jobs in the store. */
const jobCount = () => docsUnder("rubricExtractionJobs/").length;
/** What `onGuidanceSourceChanged` does for a moved hash of `sourceId`. */
const pageChanged = async (sourceId: string) => (await quiet(() => oh.h.service.onGuidanceChanged({ sourceId }))).result;

/**
 * A route that already has a rulebook (run 1, published and approved), whose
 * pages then "changed": the rulebook head's source-set hash is made stale, so
 * the job's hash gate sees new pages. The text itself is unchanged, so the
 * scripted answers of the harness still apply to a second draft.
 */
async function routeWithRulebookAndChangedPages(): Promise<void> {
  const first = await prepare(oh);
  await confirmAndDraft(oh, first);
  writePublishRun(ROUTE_KEY, 1, { outcome: "published" });
  await pump(oh, first.runId);
  assert.equal(runOf(first.runId).status, "published");
  const v: any = store.get(`visaRubrics/${ROUTE_KEY}/rubricVersions/1`);
  store.set(`visaRubrics/${ROUTE_KEY}/rubricVersions/1`, { ...v, reviewStatus: "approved" });
  const head: any = store.get(`visaRubrics/${ROUTE_KEY}`);
  store.set(`visaRubrics/${ROUTE_KEY}`, { ...head, latestSourceSetHash: "stale-hash" });
}

describe("the trigger with no active run: unchanged behaviour", () => {
  test("a changed page starts the re-draft job, and the claim is released", async () => {
    await routeWithRulebookAndChangedPages();
    const before = jobCount();
    const results = await pageChanged(oh.sourceIds[0]);
    assert.deepEqual(results.map((r) => r.outcome), ["started"]);
    assert.equal(jobCount(), before + 1);
    const job: any = store.get(`rubricExtractionJobs/${results[0].jobId}`);
    assert.equal(job.trigger, "guidance_changed");
    // No claim is left behind and nothing is deferred.
    assert.deepEqual(headOf().redraftClaims, {});
    assert.ok(!headOf().redraftDeferredPending);
  });

  test("a route with no onboarding head at all: the trigger writes one with lastSeq 0, and a later run is r1", async () => {
    await routeWithRulebookAndChangedPages();
    // Forget every onboarding document (a rulebook made by hand, before onboarding existed).
    for (const k of docsUnder("routeOnboardingRuns/")) store.delete(k);
    store.delete(`routeOnboardingRoutes/${ROUTE_KEY}`);
    assert.deepEqual((await pageChanged(oh.sourceIds[0])).map((r) => r.outcome), ["started"]);
    assert.equal(headOf().lastSeq, 0);
    assert.equal(headOf().activeRunId, null);
    const run = await oh.svc.start(COUNTRY, VISA_ID, ADMIN);
    assert.equal(run.runId, `${ROUTE_KEY}__r1`);
  });
});

describe("the trigger while a run is active: deferred, and recorded", () => {
  test("in every active status nothing is started; the deferral names the run and the source", async () => {
    await routeWithRulebookAndChangedPages();
    const run = await oh.svc.start(COUNTRY, VISA_ID, ADMIN);
    const before = jobCount();
    const callsBefore = oh.jh.calls.length;
    // preparing
    let results = await pageChanged(oh.sourceIds[0]);
    assert.deepEqual(results.map((r) => [r.outcome, r.reasonCode]), [["refused", DEFERRED_REASON_CODE]]);
    assert.match(results[0].message ?? "", /preparing/);
    // awaiting_confirmation (the run's own crawls are what moves the hash in production)
    await pump(oh, run.runId);
    assert.equal(runOf(run.runId).status, "awaiting_confirmation");
    results = await pageChanged(oh.sourceIds[1]);
    assert.equal(results[0].reasonCode, DEFERRED_REASON_CODE);
    assert.equal(jobCount(), before, "no job was started before the admin confirmed");
    assert.equal(oh.jh.calls.length, callsBefore, "no model call since run 1: the deferral calls nothing");
    const d = headOf().deferredRedraft;
    assert.equal(headOf().redraftDeferredPending, true);
    assert.deepEqual(d.sourceIds, [oh.sourceIds[0], oh.sourceIds[1]]);
    assert.equal(d.runId, run.runId);
    assert.equal(d.seq, 2);
    assert.equal(d.countryCode, COUNTRY);
    assert.equal(d.visaTypeId, VISA_ID);
    // The run itself is untouched by the deferral.
    assert.equal(runOf(run.runId).status, "awaiting_confirmation");
    // The re-evaluation while the run is still active changes nothing.
    assert.equal(await oh.svc.settleDeferredRedraft(ROUTE_KEY), "deferred");
    assert.equal(jobCount(), before);
    assert.equal(headOf().deferredRedraft.seq, 2);
  });

  test("the sweep leaves a deferral alone while its run is active", async () => {
    await routeWithRulebookAndChangedPages();
    const run = await oh.svc.start(COUNTRY, VISA_ID, ADMIN);
    await pump(oh, run.runId);
    await pageChanged(oh.sourceIds[0]);
    const before = jobCount();
    const swept = await quiet(() => oh.svc.sweep());
    assert.equal(swept.result.redraftsChecked, 1);
    assert.equal(jobCount(), before);
    assert.equal(headOf().redraftDeferredPending, true);
  });
});

describe("a deferred change is not lost", () => {
  test("cancelled before confirming: the normal re-draft starts when the run ends, and the deferral is cleared", async () => {
    await routeWithRulebookAndChangedPages();
    const run = await prepare(oh);
    await pageChanged(oh.sourceIds[0]);
    const before = jobCount();
    await quiet(() => oh.svc.cancel(run.runId, ADMIN));
    assert.equal(runOf(run.runId).status, "cancelled");
    assert.equal(jobCount(), before + 1, "the re-draft the trigger deferred was started");
    const queued = docsUnder("rubricExtractionJobs/").map((k) => store.get(k) as any).filter((j) => j.status === "queued");
    assert.deepEqual(queued.map((j) => j.trigger), ["guidance_changed"]);
    assert.ok(!headOf().redraftDeferredPending);
    assert.equal(headOf().deferredRedraft, null);
  });

  test("failed: the run's end re-evaluates the deferral the same way", async () => {
    await routeWithRulebookAndChangedPages();
    const run = await oh.svc.start(COUNTRY, VISA_ID, ADMIN);
    await pageChanged(oh.sourceIds[0]);
    // A rule page that cannot be read ends the run failed before any plan.
    oh.pages.set(oh.sourceIds[1], { outcome: "failed", errorKind: "http_error" });
    const before = jobCount();
    await quiet(() => pump(oh, run.runId));
    assert.equal(runOf(run.runId).status, "failed");
    assert.equal(jobCount(), before + 1);
    assert.ok(!headOf().redraftDeferredPending);
  });

  test("cancelled while the run's own job (same inputs) is being cancelled: kept, then the sweep restarts that job once it stopped", async () => {
    await routeWithRulebookAndChangedPages();
    const run = await prepare(oh);
    await pageChanged(oh.sourceIds[0]);
    // Confirm and let the run start its job (the same inputs the trigger uses).
    await oh.svc.confirm(run.runId, { estimateId: (runOf(run.runId).estimate as any).estimateId, addToAllowlist: false }, ADMIN);
    await pump(oh, run.runId);
    const jobId = runOf(run.runId).links.jobId as string;
    assert.ok(jobId);
    // The job's worker holds a lease (it is mid-step), so its cancel is only a flag.
    const job: any = store.get(`rubricExtractionJobs/${jobId}`);
    store.set(`rubricExtractionJobs/${jobId}`, { ...job, status: "running", leaseOwner: "someone", leaseUntil: Timestamp.fromMillis(T0 + 3_600_000) });
    const jobsBefore = jobCount();
    await quiet(() => oh.svc.cancel(run.runId, ADMIN));
    assert.equal(runOf(run.runId).status, "cancelled");
    // The settle at the run's end found the job `existing` but being cancelled: not settled.
    assert.equal((store.get(`rubricExtractionJobs/${jobId}`) as any).cancelRequested, true);
    assert.equal(headOf().redraftDeferredPending, true, "the deferral waits for the job to stop");
    // The job's worker obeys the flag (simulated: the job ends cancelled).
    store.set(`rubricExtractionJobs/${jobId}`, { ...(store.get(`rubricExtractionJobs/${jobId}`) as any), status: "cancelled", leaseOwner: null, leaseUntil: null });
    await quiet(() => oh.svc.sweep());
    const after: any = store.get(`rubricExtractionJobs/${jobId}`);
    assert.equal(after.status, "queued", "the normal re-draft queued the stopped job again (its finished steps are kept)");
    assert.equal(after.cancelRequested, false);
    assert.equal(jobCount(), jobsBefore, "no second job for the same change");
    assert.ok(!headOf().redraftDeferredPending);
  });
});

describe("no double spend", () => {
  test("the run drafts the change after confirmation; its end starts NOTHING more for that change", async () => {
    await routeWithRulebookAndChangedPages();
    const run = await prepare(oh);
    await pageChanged(oh.sourceIds[0]);
    const jobsBefore = jobCount();
    const waiting = await confirmAndDraft(oh, run);
    assert.equal(waiting.status, "waiting_for_publish");
    assert.equal(waiting.links.rulebookVersion, 2);
    assert.equal(jobCount(), jobsBefore + 1, "the run's job is the only new job");
    const callsAfterDraft = oh.jh.calls.length;
    // A page-change event arriving while the safeguards decide is deferred too.
    assert.equal((await pageChanged(oh.sourceIds[1]))[0].reasonCode, DEFERRED_REASON_CODE);
    writePublishRun(ROUTE_KEY, 2, { outcome: "published" });
    await quiet(() => pump(oh, run.runId));
    assert.equal(runOf(run.runId).status, "published");
    // The settle at the run's end: the hash gate sees the pages of version 2.
    assert.equal(jobCount(), jobsBefore + 1);
    assert.equal(oh.jh.calls.length, callsAfterDraft, "no model call after the run's own draft");
    assert.ok(!headOf().redraftDeferredPending, "settled by the gate's `unchanged`");
    // And the same event after the run is over still starts nothing (unchanged).
    assert.deepEqual((await pageChanged(oh.sourceIds[0])).map((r) => r.outcome), ["unchanged"]);
  });

  test("a trigger and a settle for the same change create ONE job (deterministic id)", async () => {
    await routeWithRulebookAndChangedPages();
    const run = await prepare(oh);
    await pageChanged(oh.sourceIds[0]);
    // Make the run end without settling, so a pending deferral meets a live trigger.
    oh.jh.jobs.startJob = (() => Promise.resolve(result("refused", "unexpected_error"))) as any;
    await quiet(() => oh.svc.cancel(run.runId, ADMIN));
    assert.equal(headOf().redraftDeferredPending, true);
    delete (oh.jh.jobs as any).startJob;
    const before = jobCount();
    // The next page-change event proceeds (no active run) and settles the deferral itself.
    assert.deepEqual((await pageChanged(oh.sourceIds[0])).map((r) => r.outcome), ["started"]);
    assert.ok(!headOf().redraftDeferredPending);
    // The sweep then has nothing to do: still one job.
    await quiet(() => oh.svc.sweep());
    assert.equal(jobCount(), before + 1);
  });
});

describe("no race with a run being created", () => {
  test("a re-draft that claimed the route first: the new run waits before crawling until the claim is released", async () => {
    await routeWithRulebookAndChangedPages();
    let runId = "";
    let crawlsDuringClaim = -1;
    const out = await quiet(() => oh.svc.guardedRedraft(
      { routeKey: ROUTE_KEY, countryCode: COUNTRY, visaTypeId: VISA_ID, sourceId: oh.sourceIds[0] },
      async () => {
        // While the trigger is pinning its job, an admin starts a run.
        const crawlsBefore = oh.pageCrawls.length;
        runId = (await oh.svc.start(COUNTRY, VISA_ID, ADMIN)).runId;
        await pump(oh, runId);
        crawlsDuringClaim = oh.pageCrawls.length - crawlsBefore;
        return oh.jh.jobs.startJob({ countryCode: COUNTRY, visaTypeId: VISA_ID, trigger: "guidance_changed" });
      }
    ));
    assert.equal(out.result.kind, "ran");
    assert.equal(crawlsDuringClaim, 0, "no rule page was crawled under the trigger's job");
    const waiting = runOf(runId);
    assert.equal(waiting.status, "preparing");
    assert.match(waiting.steps.find((s) => s.id === "read_rule_pages")!.detail, /automatic re-draft/);
    // Claim released: the run carries on and reads its pages.
    assert.deepEqual(headOf().redraftClaims, {});
    await pump(oh, runId);
    assert.ok(oh.pageCrawls.length > 0);
    assert.equal(runOf(runId).status, "awaiting_confirmation");
  });

  test("a claim whose holder died expires, and the run carries on", async () => {
    await routeWithRulebookAndChangedPages();
    const head = headOf();
    store.set(`routeOnboardingRoutes/${ROUTE_KEY}`, { ...head, redraftClaims: { dead: Timestamp.fromMillis(oh.h.state.nowMs + 1000) } });
    const run = await oh.svc.start(COUNTRY, VISA_ID, ADMIN);
    await pump(oh, run.runId);
    assert.equal(runOf(run.runId).status, "preparing");
    oh.h.state.nowMs += 2000;
    await pump(oh, run.runId);
    assert.equal(runOf(run.runId).status, "awaiting_confirmation");
  });

  test("a run created first: the trigger's transaction sees it and defers (the head is the one meeting point)", async () => {
    await routeWithRulebookAndChangedPages();
    // start() and the guard both read and write routeOnboardingRoutes/{routeKey}
    // in a transaction; here the run commits first.
    const run = await oh.svc.start(COUNTRY, VISA_ID, ADMIN);
    const out = await quiet(() => oh.svc.guardedRedraft({ routeKey: ROUTE_KEY, countryCode: COUNTRY, visaTypeId: VISA_ID, sourceId: oh.sourceIds[0] }, async () => assert.fail("must not start")));
    assert.deepEqual(out.result, { kind: "deferred", runId: run.runId, status: "preparing" });
  });

  test("a new run keeps a pending deferral on the head (start() does not wipe it)", async () => {
    await routeWithRulebookAndChangedPages();
    const first = await prepare(oh);
    await pageChanged(oh.sourceIds[0]);
    oh.jh.jobs.startJob = (() => Promise.resolve(result("refused", "unexpected_error"))) as any;
    await quiet(() => oh.svc.cancel(first.runId, ADMIN));
    delete (oh.jh.jobs as any).startJob;
    assert.equal(headOf().redraftDeferredPending, true);
    const second = await oh.svc.start(COUNTRY, VISA_ID, ADMIN);
    assert.equal(headOf().activeRunId, second.runId);
    assert.equal(headOf().redraftDeferredPending, true, "carried over to the new run's end");
  });
});
