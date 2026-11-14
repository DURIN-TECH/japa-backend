// ============================================
// Route onboarding runs (issue #217): the service and the worker
// ============================================
//
// The REAL service over fakes (see onboarding-harness.ts): the in-memory
// Firestore, the real drafting-job service on the scripted provider, scripted
// crawlers and a scripted publishing pipeline. No network, no live model.

import { before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { Timestamp } from "firebase-admin/firestore";
import { resetStore, store } from "../../helpers/fake-firestore";
import { resetBucket } from "../rubric/rubric-harness";
import { seedSource } from "../rubric/rubric-harness";
import { textOf } from "../rubric/rubric-job-fixtures";
import {
  ADMIN, COUNTRY, Killed, ROUTE_KEY, VISA_ID, confirm, confirmAndDraft, docsUnder, driveJob, installOnboardingFakes, makeOnboarding, prepare, pump, runOf, writePublishRun,
  type OnboardingHarness,
} from "./onboarding-harness";
import { OnboardingError } from "../../../src/scrapers/onboarding/onboarding-types";

/* eslint-disable @typescript-eslint/no-explicit-any */

let oh: OnboardingHarness;

before(async () => {
  await installOnboardingFakes();
});

beforeEach(async () => {
  resetStore();
  resetBucket();
  oh = await makeOnboarding();
});

/** The message of the OnboardingError a promise rejects with. */
async function refused(p: Promise<unknown>): Promise<OnboardingError> {
  try {
    await p;
  } catch (err) {
    assert.ok(err instanceof OnboardingError, `expected an OnboardingError, got ${err}`);
    return err;
  }
  assert.fail("expected a refusal");
}

/** Forget every run and the route head (a clean slate for the same route). */
function forgetRuns(): void {
  for (const k of docsUnder("routeOnboardingRuns/")) store.delete(k);
  store.delete(`routeOnboardingRoutes/${ROUTE_KEY}`);
}

const stepStatus = (run: any, id: string) => run.steps.find((s: any) => s.id === id).status;

describe("preparing", () => {
  test("reads the pages with NO model call and stops at awaiting_confirmation with a stored estimate", async () => {
    const run = await prepare(oh);
    assert.equal(run.status, "awaiting_confirmation");
    // Zero calls of any kind to the model before confirmation.
    assert.equal(oh.h.provider.requests.length, 0);
    assert.equal(oh.jh.calls.length, 0);
    assert.equal(docsUnder("rubricExtractionJobs/").length, 0);
    assert.deepEqual(run.steps.map((s) => s.status), ["done", "done", "done", "done", "waiting", "pending", "pending"]);
    const est = run.estimate as any;
    assert.equal(est.chunks, oh.chunks);
    assert.equal(est.extractionCallsAtMost, oh.chunks * 2);
    assert.equal(est.checkCallsAtMost, oh.publish.settings.checkerMaxRequestsPerRun);
    assert.ok(est.checkCallsAbout <= est.checkCallsAtMost);
    assert.equal(est.sourceCount, 2);
    assert.equal(est.publishState.code, "on");
    assert.match(est.estimateId, /^est_[0-9a-f]{16}$/);
    assert.match(est.statement, /Nobody will read the rules first/);
    assert.equal(est.sources[0].host, "docs.invalid");
    assert.equal(run.links.visaTypeId, VISA_ID);
    assert.equal(run.links.snapshotIds.length, 2);
    assert.deepEqual(oh.visaCrawls, [{ countryCode: COUNTRY, force: false }]);
  });

  test("the visa record stays in review and the country stays hidden", async () => {
    await prepare(oh);
    const visa: any = store.get(`countries/${COUNTRY}/visaTypes/${VISA_ID}`);
    assert.equal(visa.reviewStatus, "pending_review");
    assert.equal(visa.isActive, false);
    assert.equal((store.get(`countries/${COUNTRY}`) as any).isSupported, false);
  });

  test("an existing visa record from the same page is not read again (no crawl)", async () => {
    await prepare(oh);
    oh.visaCrawls.length = 0;
    // A fresh route attempt over the same record.
    store.delete(`routeOnboardingRuns/${ROUTE_KEY}__r1`);
    store.delete(`routeOnboardingRoutes/${ROUTE_KEY}`);
    const run = await prepare(oh);
    assert.equal(run.status, "awaiting_confirmation");
    assert.equal(oh.visaCrawls.length, 0);
  });

  test("a plan over a cap is refused before any call, naming the cap in plain words", async () => {
    oh.onboarding.settings.maxChunksPerRun = 1;
    const a = await prepare(oh);
    assert.equal(a.status, "failed");
    assert.match(a.summary, /maxChunksPerRun/);
    assert.equal(a.estimate, null);

    forgetRuns();
    oh.onboarding.settings.maxChunksPerRun = 100;
    oh.h.settings.maxRequestsPerRun = 2;
    const b = await prepare(oh);
    assert.equal(b.status, "failed");
    assert.match(b.summary, /maxRequestsPerRun/);

    forgetRuns();
    oh.h.settings.maxRequestsPerRun = 40;
    oh.h.settings.maxInputCharsPerRun = 500;
    const c = await prepare(oh);
    assert.equal(c.status, "failed");
    assert.match(c.summary, /maxInputCharsPerRun/);
    assert.equal(oh.h.provider.requests.length, 0);
  });

  test("a rule page that fails to crawl ends the run failed with the page and the error class in plain words", async () => {
    oh.pages.set("src-2", { outcome: "failed", errorKind: "http_error" });
    const run = await prepare(oh);
    assert.equal(run.status, "failed");
    assert.match(run.summary, /Rule page 2/);
    assert.match(run.summary, /answered with an error/);
    assert.match(run.summary, /Nothing was extracted/);
    assert.equal(stepStatus(run, "read_rule_pages"), "failed");
    assert.equal(run.estimate, null);
    assert.equal(oh.jh.calls.length, 0);
  });

  test("a paused or unverified rule page ends the run failed before anything is fetched", async () => {
    const d: any = store.get("guidanceSources/src-1");
    store.set("guidanceSources/src-1", { ...d, status: "paused" });
    const run = await prepare(oh);
    assert.equal(run.status, "failed");
    assert.match(run.summary, /paused/);
    assert.equal(oh.pageCrawls.length, 0);
    assert.equal(oh.visaCrawls.length, 0);
  });

  test("a registered route with no primary rule page fails at the setup check", async () => {
    const d: any = store.get("guidanceSources/src-1");
    store.set("guidanceSources/src-1", { ...d, role: "secondary" });
    const run = await prepare(oh);
    assert.equal(run.status, "failed");
    assert.match(run.summary, /primary/);
  });

  test("a visa page that yields no record fails with the crawl's own error in plain words", async () => {
    oh.visaScript = { leased: false, createsRecord: false, lastError: "HTTP 404" };
    const run = await prepare(oh);
    assert.equal(run.status, "failed");
    assert.match(run.summary, /visa page could not be read: HTTP 404/);
    assert.equal(stepStatus(run, "read_visa_page"), "failed");
  });

  test("a visa source another crawl holds becomes waiting and is retried; a stuck wait ends failed", async () => {
    oh.visaScript.leased = true;
    const run = await oh.svc.start(COUNTRY, VISA_ID, ADMIN);
    await pump(oh, run.runId);
    let cur = runOf(run.runId);
    assert.equal(cur.status, "preparing");
    assert.equal(stepStatus(cur, "read_visa_page"), "waiting");
    assert.match(cur.steps[1].detail, /another crawl/);
    assert.ok(cur.nextAttemptAt);
    // The lease frees: the next invocation (the sweep's wake) carries on.
    oh.visaScript.leased = false;
    await pump(oh, run.runId);
    cur = runOf(run.runId);
    assert.equal(cur.status, "awaiting_confirmation");

    // A source that stays busy ends the run instead of waiting for ever.
    resetStore();
    resetBucket();
    oh = await makeOnboarding();
    oh.visaScript.leased = true;
    oh.deps.timing.maxWaits = 2;
    const r2 = await oh.svc.start(COUNTRY, VISA_ID, ADMIN);
    for (let i = 0; i < 6; i++) await oh.svc.advance(r2.runId);
    assert.equal(runOf(r2.runId).status, "failed");
    assert.match(runOf(r2.runId).summary, /stayed that way for too long/);
  });

  test("a rule page whose host asked us to slow down waits, then carries on", async () => {
    oh.pages.set("src-1", { outcome: "lease_held" });
    const run = await oh.svc.start(COUNTRY, VISA_ID, ADMIN);
    await pump(oh, run.runId);
    assert.equal(stepStatus(runOf(run.runId), "read_rule_pages"), "waiting");
    oh.pages.delete("src-1");
    await pump(oh, run.runId);
    assert.equal(runOf(run.runId).status, "awaiting_confirmation");
    // Each page was crawled at most once successfully (no repeat of a stored result).
    assert.equal(oh.pageCrawls.filter((p) => p === "src-2").length, 1);
  });
});

describe("confirming the estimate", () => {
  test("records who, when and the number, writes an audit entry, and starts exactly one job", async () => {
    const run = await prepare(oh);
    const est = run.estimate as any;
    const r = await confirm(oh, run);
    assert.equal(r.alreadyConfirmed, false);
    const confirmed = runOf(run.runId);
    assert.equal(confirmed.status, "running");
    assert.equal(confirmed.confirmation?.by, ADMIN);
    assert.equal(confirmed.confirmation?.estimateId, est.estimateId);
    assert.equal(confirmed.confirmation?.maxRequests, est.extractionCallsAtMost);
    assert.ok(confirmed.confirmation?.at);
    const audits = docsUnder("sourceRegistryAudit/").map((k) => store.get(k) as any).filter((a) => a.action === "onboarding_confirmed");
    assert.equal(audits.length, 1);
    assert.equal(audits[0].actorUid, ADMIN);
    // A second confirm (a double click) is a harmless repeat.
    const again = await confirm(oh, run);
    assert.equal(again.alreadyConfirmed, true);
    await pump(oh, run.runId);
    await pump(oh, run.runId);
    assert.equal(docsUnder("rubricExtractionJobs/").length, 1);
    assert.equal(oh.h.provider.requests.length, 0, "the model is called by the drafting job's worker, not here");
  });

  test("refuses a wrong estimate id, a wrong status and a cancelled run", async () => {
    const run = await prepare(oh);
    assert.equal((await refused(oh.svc.confirm(run.runId, { estimateId: "est_0000000000000000", addToAllowlist: false }, ADMIN))).code, "ESTIMATE_MISMATCH");
    assert.equal((await refused(oh.svc.confirm("XA_none__r9", { estimateId: "est_0000000000000000", addToAllowlist: false }, ADMIN))).code, "NOT_FOUND");
    await confirm(oh, run);
    assert.equal((await refused(oh.svc.confirm(run.runId, { estimateId: "est_0000000000000000", addToAllowlist: false }, ADMIN))).code, "NOT_AWAITING_CONFIRMATION");
    assert.equal(runOf(run.runId).voidedConfirmations.length, 0);
  });

  test("does not confirm while onboarding is off or its settings cannot be read", async () => {
    const run = await prepare(oh);
    oh.onboarding.settings.enabled = false;
    assert.equal((await refused(confirm(oh, run))).code, "ONBOARDING_DISABLED");
    oh.onboarding.readError = "x";
    assert.equal((await refused(confirm(oh, run))).code, "SETTINGS_UNAVAILABLE");
    assert.equal(runOf(run.runId).status, "awaiting_confirmation");
  });

  test("a plan that changed after confirming is NOT started: re-estimate and ask again", async () => {
    const run = await prepare(oh);
    const firstId = (run.estimate as any).estimateId;
    await confirm(oh, run);
    // A page changes between the confirmation and the start.
    const grown = textOf(1, 6);
    await seedSource({ id: "src-1", url: "https://docs.invalid/src-1", text: grown.text });
    const d: any = store.get("guidanceSources/src-1");
    store.set("guidanceSources/src-1", { ...d, title: "Rule page 1", jurisdiction: COUNTRY, route: VISA_ID.slice(COUNTRY.length + 1), role: "primary", verificationStatus: "registered" });
    await pump(oh, run.runId);
    const cur = runOf(run.runId);
    assert.equal(cur.status, "awaiting_confirmation");
    assert.equal(cur.confirmation, null);
    assert.equal(cur.voidedConfirmations.length, 1);
    assert.notEqual((cur.estimate as any).estimateId, firstId);
    assert.equal(docsUnder("rubricExtractionJobs/").length, 0, "no job was started");
    assert.equal(oh.h.provider.requests.length, 0);
    // The old number cannot be confirmed; the new one can.
    assert.equal((await refused(oh.svc.confirm(run.runId, { estimateId: firstId, addToAllowlist: false }, ADMIN))).code, "ESTIMATE_MISMATCH");
    await confirm(oh, runOf(run.runId));
    await pump(oh, run.runId);
    assert.equal(docsUnder("rubricExtractionJobs/").length, 1);
  });

  test("addToAllowlist applies the audited patch before the job starts, once; unticked it is never touched", async () => {
    const run = await prepare(oh);
    await confirm(oh, run, { addToAllowlist: true });
    await pump(oh, run.runId);
    assert.deepEqual(oh.allowlistCalls, [ROUTE_KEY]);
    assert.equal(runOf(run.runId).allowlist, "added");
    assert.equal(docsUnder("rubricExtractionJobs/").length, 1);

    resetStore();
    resetBucket();
    oh = await makeOnboarding();
    const r2 = await prepare(oh);
    await confirmAndDraft(oh, r2);
    assert.deepEqual(oh.allowlistCalls, []);
    assert.equal(runOf(r2.runId).allowlist, "not_requested");
  });
});

describe("the draft and the safeguards", () => {
  test("happy path to published: counters kept, links set, nothing visible, no alert", async () => {
    const run = await prepare(oh);
    const waiting = await confirmAndDraft(oh, run);
    assert.equal(waiting.status, "waiting_for_publish");
    assert.equal(waiting.links.rulebookVersion, 1);
    assert.equal(waiting.counters.chunksTotal, oh.chunks);
    assert.equal(waiting.counters.chunksDone, oh.chunks);
    assert.ok(waiting.counters.calls > 0);
    assert.ok(waiting.counters.inputTokens > 0);
    assert.equal(waiting.counters.costUsd === null || typeof waiting.counters.costUsd === "number", true);
    assert.ok(waiting.links.jobId);
    // No pipeline record yet: the run waits and does not decide.
    await pump(oh, run.runId);
    assert.equal(runOf(run.runId).status, "waiting_for_publish");
    writePublishRun(ROUTE_KEY, 1, { outcome: "published" });
    await pump(oh, run.runId);
    const done = runOf(run.runId);
    assert.equal(done.status, "published");
    assert.equal(done.links.publishRunId, `${ROUTE_KEY}__v1`);
    assert.equal(done.holdReason, null);
    assert.equal(done.alertPending, false);
    assert.equal(oh.raised.length, 0);
    assert.ok(done.finishedAt);
    assert.deepEqual(done.steps.map((s) => s.status), ["done", "done", "done", "done", "done", "done", "done"]);
    // Visibility never changed.
    assert.equal((store.get(`countries/${COUNTRY}/visaTypes/${VISA_ID}`) as any).isActive, false);
    assert.equal((store.get(`countries/${COUNTRY}`) as any).isSupported, false);
    const checklist = await oh.svc.checklistOf(done);
    assert.deepEqual(checklist.map((c) => [c.id, c.done]), [["approve_visa_record", false], ["make_country_visible", false]]);
    assert.equal(checklist[0].visaTypeId, VISA_ID);
    assert.equal(checklist[1].countryCode, COUNTRY);
    // The run never started the pipeline itself and never changed settings.
    assert.equal(oh.allowlistCalls.length, 0);
    assert.equal(oh.rejected.length, 0);
  });

  test("a version approved by a person ends the run published", async () => {
    const run = await prepare(oh);
    await confirmAndDraft(oh, run);
    const v: any = store.get(`visaRubrics/${ROUTE_KEY}/rubricVersions/1`);
    store.set(`visaRubrics/${ROUTE_KEY}/rubricVersions/1`, { ...v, reviewStatus: "approved" });
    await pump(oh, run.runId);
    assert.equal(runOf(run.runId).status, "published");
  });

  test("held by a gate: the pipeline's own reason in plain words, one deduplicated alert", async () => {
    const run = await prepare(oh);
    await confirmAndDraft(oh, run);
    writePublishRun(ROUTE_KEY, 1, { outcome: "held", reasonCodes: ["shrink_below_floor", "intent_polarity_conflict"] });
    await pump(oh, run.runId);
    const done = runOf(run.runId);
    assert.equal(done.status, "held");
    assert.match(done.summary, /far fewer rules/);
    assert.match(done.summary, /conflicting passages/);
    assert.equal(done.holdReason?.retryScheduled, false);
    assert.deepEqual(done.holdReason?.codes, ["shrink_below_floor", "intent_polarity_conflict"]);
    assert.equal(oh.raised.length, 1);
    const signal = (oh.raised[0][0] as any).signals[0];
    assert.equal(signal.rule, "route_onboarding_attention");
    assert.equal(signal.key, `route_onboarding_attention:${run.runId}`);
    assert.match(signal.message, new RegExp(`https://admin.test/admin/route-onboarding/${run.runId}`));
    assert.equal(runOf(run.runId).alertPending, false);
    // The sweep raising it again would only bump the same key.
    store.set(`routeOnboardingRuns/${run.runId}`, { ...done, alertPending: true });
    await oh.svc.sweep();
    assert.equal((oh.raised[1][0] as any).signals[0].key, signal.key);
  });

  test("held because the independent check could not run: retry scheduled, then published by the hourly sweep with no admin action", async () => {
    const run = await prepare(oh);
    await confirmAndDraft(oh, run);
    writePublishRun(ROUTE_KEY, 1, { outcome: "held", reasonCodes: ["checker_unavailable"], attempts: 1 });
    await pump(oh, run.runId);
    const held = runOf(run.runId);
    assert.equal(held.status, "held");
    assert.equal(held.holdReason?.retryScheduled, true);
    assert.match(held.summary, /could not run yet.*retry by itself/);
    // The pipeline's hourly sweep clears it: the run turns published without anyone acting.
    writePublishRun(ROUTE_KEY, 1, { outcome: "published", attempts: 2 });
    const swept = await oh.svc.sweep();
    assert.equal(swept.heldChecked, 1);
    const done = runOf(run.runId);
    assert.equal(done.status, "published");
    assert.equal(done.holdReason, null);
    // The run's own alert was resolved (an evaluation with no signals).
    const last = oh.raised[oh.raised.length - 1][0] as any;
    assert.equal(last.signals.length, 0);
    assert.deepEqual(last.scope, { keys: [`route_onboarding_attention:${run.runId}`] });
  });

  test("after the last retry the hold stands and says so", async () => {
    const run = await prepare(oh);
    await confirmAndDraft(oh, run);
    writePublishRun(ROUTE_KEY, 1, { outcome: "held", reasonCodes: ["checker_capped"], attempts: 3 });
    await pump(oh, run.runId);
    const held = runOf(run.runId);
    assert.equal(held.holdReason?.retryScheduled, false);
    assert.match(held.summary, /Rubrics tab/);
  });

  test("no rules, or a main source left with none: too_thin in plain words", async () => {
    for (const code of ["no_criteria", "primary_source_empty:src-1"]) {
      resetStore();
      resetBucket();
      oh = await makeOnboarding();
      const run = await prepare(oh);
      await confirmAndDraft(oh, run);
      writePublishRun(ROUTE_KEY, 1, { outcome: "held", reasonCodes: [code] });
      await pump(oh, run.runId);
      const done = runOf(run.runId);
      assert.equal(done.status, "too_thin", code);
      assert.match(done.summary, /state too little to form a rulebook/);
      assert.equal(oh.raised.length, 0, "too thin is an outcome, not a failure to alert on");
    }
  });

  test("route not on the allow-list, or manual mode: held 'automatic publishing is not on for this route'", async () => {
    // Not on the allow-list: the pipeline records a skip.
    let run = await prepare(oh);
    await confirmAndDraft(oh, run);
    writePublishRun(ROUTE_KEY, 1, { outcome: "skipped", reasonCodes: ["route_not_in_allowlist"] });
    await pump(oh, run.runId);
    assert.equal(runOf(run.runId).status, "held");
    assert.match(runOf(run.runId).summary, /Automatic publishing is not on for this route/);
    assert.equal(runOf(run.runId).holdReason?.code, "route_not_in_allowlist");

    // Manual mode: the pipeline writes nothing, so the run reads the setting.
    resetStore();
    resetBucket();
    oh = await makeOnboarding();
    oh.publish.settings.mode = "manual";
    run = await prepare(oh);
    assert.equal((run.estimate as any).publishState.code, "off_manual_mode");
    await confirmAndDraft(oh, run);
    await pump(oh, run.runId);
    assert.equal(runOf(run.runId).status, "held");
    assert.equal(runOf(run.runId).holdReason?.code, "manual_mode");
    assert.match(runOf(run.runId).summary, /not on for this route \(manual mode\)/);
    // And the run never changed the mode or started the safeguards itself.
    assert.equal(oh.publish.settings.mode, "manual");
    assert.equal(oh.allowlistCalls.length, 0);
  });

  test("a pipeline that never reports ends held 'no safeguard report' after the wait limit", async () => {
    const run = await prepare(oh);
    await confirmAndDraft(oh, run);
    oh.h.state.nowMs += oh.onboarding.settings.publishWaitMinutes * 60_000 + 1;
    await pump(oh, run.runId);
    assert.equal(runOf(run.runId).holdReason?.code, "no_safeguard_report");
  });

  test("a drafting job that failed or stopped is reported in plain words with the parts done", async () => {
    const cases: [any, RegExp][] = [
      [{ status: "failed", reasonCode: "provider_error", message: "x" }, /AI service kept failing/],
      [{ status: "skipped", reasonCode: "sources_changed", message: "x" }, /page changed while the draft was being written/],
      [{ status: "skipped", reasonCode: "daily_cap_reached", message: "x" }, /daily limit/],
      [{ status: "failed", reasonCode: "run_cap_exceeded", message: "x" }, /would pass a drafting limit/],
    ];
    for (const [patch, re] of cases) {
      resetStore();
      resetBucket();
      oh = await makeOnboarding();
      const run = await prepare(oh);
      await confirm(oh, run);
      await pump(oh, run.runId);
      const jobId = runOf(run.runId).links.jobId as string;
      store.set(`rubricExtractionJobs/${jobId}`, { ...(store.get(`rubricExtractionJobs/${jobId}`) as any), ...patch, finishedAt: Timestamp.fromMillis(oh.h.state.nowMs) });
      await pump(oh, run.runId);
      const done = runOf(run.runId);
      assert.equal(done.status, "failed", patch.reasonCode);
      assert.match(done.summary, re);
      assert.match(done.summary, /0 of \d+ parts were done/);
      assert.equal(oh.raised.length, 1);
    }
  });

  test("a job that accepted no rule from any page ends too_thin", async () => {
    const run = await prepare(oh);
    await confirm(oh, run);
    await pump(oh, run.runId);
    const jobId = runOf(run.runId).links.jobId as string;
    store.set(`rubricExtractionJobs/${jobId}`, { ...(store.get(`rubricExtractionJobs/${jobId}`) as any), status: "failed", reasonCode: "no_criteria_accepted", message: "x", finishedAt: Timestamp.fromMillis(oh.h.state.nowMs) });
    await pump(oh, run.runId);
    assert.equal(runOf(run.runId).status, "too_thin");
  });

  test("a re-run with unchanged sources ends without a model call and says so", async () => {
    const first = await prepare(oh);
    await confirmAndDraft(oh, first);
    writePublishRun(ROUTE_KEY, 1, { outcome: "published" });
    await pump(oh, first.runId);
    assert.equal(runOf(first.runId).status, "published");
    const v: any = store.get(`visaRubrics/${ROUTE_KEY}/rubricVersions/1`);
    store.set(`visaRubrics/${ROUTE_KEY}/rubricVersions/1`, { ...v, reviewStatus: "approved" });
    const callsBefore = oh.jh.calls.length;
    const jobsBefore = docsUnder("rubricExtractionJobs/").length;
    const second = await oh.svc.start(COUNTRY, VISA_ID, ADMIN);
    assert.equal(second.runId, `${ROUTE_KEY}__r2`);
    await pump(oh, second.runId);
    const done = runOf(second.runId);
    assert.equal(done.status, "published");
    assert.equal(done.unchanged, true);
    assert.match(done.steps.find((s) => s.id === "plan")!.detail, /no model call was made/);
    assert.equal(oh.jh.calls.length, callsBefore);
    assert.equal(docsUnder("rubricExtractionJobs/").length, jobsBefore);
    assert.equal(done.estimate, null);
  });
});

describe("starting, listing and limits", () => {
  test("a double click opens one run; the second sees RUN_ACTIVE with the run id", async () => {
    const [a, b] = await Promise.allSettled([oh.svc.start(COUNTRY, VISA_ID, ADMIN), oh.svc.start(COUNTRY, VISA_ID, ADMIN)]);
    const ok = [a, b].filter((r) => r.status === "fulfilled");
    const bad = [a, b].filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    assert.equal(ok.length, 1);
    assert.equal(bad.length, 1);
    assert.equal(bad[0].reason.code, "RUN_ACTIVE");
    assert.equal(bad[0].reason.status, 409);
    assert.equal(bad[0].reason.extra.activeRunId, `${ROUTE_KEY}__r1`);
    assert.equal(docsUnder("routeOnboardingRuns/").length, 1);
  });

  test("a new run is allowed once the last is final; awaiting confirmation still blocks", async () => {
    const run = await prepare(oh);
    assert.equal((await refused(oh.svc.start(COUNTRY, VISA_ID, ADMIN))).code, "RUN_ACTIVE");
    await oh.svc.cancel(run.runId, ADMIN);
    const next = await oh.svc.start(COUNTRY, VISA_ID, ADMIN);
    assert.equal(next.runId, `${ROUTE_KEY}__r2`);
  });

  test("404 for an unregistered route, 429 beyond maxRunsPerDay, 503 when off or unreadable", async () => {
    assert.equal((await refused(oh.svc.start(COUNTRY, "xa-other", ADMIN))).code, "ROUTE_NOT_REGISTERED");
    assert.equal((await refused(oh.svc.start("QM", VISA_ID, ADMIN))).status, 404);
    oh.onboarding.settings.maxRunsPerDay = 1;
    const run = await oh.svc.start(COUNTRY, VISA_ID, ADMIN);
    await oh.svc.cancel(run.runId, ADMIN);
    const limited = await refused(oh.svc.start(COUNTRY, VISA_ID, ADMIN));
    assert.equal(limited.status, 429);
    assert.equal(limited.code, "DAILY_LIMIT_REACHED");
    oh.onboarding.settings.enabled = false;
    const off = await refused(oh.svc.start(COUNTRY, VISA_ID, ADMIN));
    assert.equal(off.status, 503);
    oh.onboarding.settings.enabled = true;
    oh.onboarding.readError = "boom";
    assert.equal((await refused(oh.svc.start(COUNTRY, VISA_ID, ADMIN))).code, "SETTINGS_UNAVAILABLE");
  });

  test("list is newest first and filters by status; get returns the checklist", async () => {
    const run = await prepare(oh);
    const rows = await oh.svc.list({ limit: 10 });
    assert.equal(rows.length, 1);
    assert.equal((await oh.svc.list({ status: "failed", limit: 10 })).length, 0);
    assert.equal((await oh.svc.list({ status: "awaiting_confirmation", limit: 10 })).length, 1);
    const got = await oh.svc.get(run.runId);
    assert.equal(got?.checklist.length, 2);
    assert.equal(await oh.svc.get("XA_nothing__r1"), null);
  });

  test("progress is read live from the drafting job while it runs", async () => {
    const run = await prepare(oh);
    await confirm(oh, run);
    await pump(oh, run.runId);
    const jobId = runOf(run.runId).links.jobId as string;
    // One worker invocation that stops after a couple of steps.
    await oh.jh.jobs.advance(jobId, { deadlineAt: oh.h.state.nowMs });
    const live = await oh.svc.get(run.runId);
    assert.equal(live!.run.counters.chunksTotal, oh.chunks);
    await driveJob(oh, jobId);
    const after = await oh.svc.get(run.runId);
    assert.equal(after!.run.counters.chunksDone, oh.chunks);
  });
});

describe("cancel", () => {
  test("in every non-final status; spent counters stay; a final run is 409", async () => {
    // preparing (nobody working on it)
    let run = await oh.svc.start(COUNTRY, VISA_ID, ADMIN);
    let c = await oh.svc.cancel(run.runId, ADMIN);
    assert.equal(c.status, "cancelled");
    assert.ok(c.steps.every((s) => s.status === "cancelled"));
    assert.equal((await refused(oh.svc.cancel(run.runId, ADMIN))).code, "RUN_FINISHED");
    assert.equal((await refused(oh.svc.cancel("XA_none__r4", ADMIN))).code, "NOT_FOUND");

    // awaiting_confirmation
    run = await prepare(oh);
    c = await oh.svc.cancel(run.runId, ADMIN);
    assert.equal(c.status, "cancelled");
    assert.equal(docsUnder("rubricExtractionJobs/").length, 0);
    assert.equal((await refused(confirm(oh, run))).code, "NOT_AWAITING_CONFIRMATION");

    // running: the drafting job is cancelled and its counters are kept
    run = await prepare(oh);
    await confirm(oh, run);
    await pump(oh, run.runId);
    const jobId = runOf(run.runId).links.jobId as string;
    await oh.jh.jobs.advance(jobId, { deadlineAt: oh.h.state.nowMs });
    c = await oh.svc.cancel(run.runId, ADMIN);
    assert.equal(c.status, "cancelled");
    assert.equal((store.get(`rubricExtractionJobs/${jobId}`) as any).status, "cancelled");
    // Nothing more happens: no version, no further call.
    const calls = oh.jh.calls.length;
    await oh.jh.jobs.advance(jobId);
    assert.equal(oh.jh.calls.length, calls);
    assert.equal(docsUnder(`visaRubrics/${ROUTE_KEY}/rubricVersions/`).length, 0);
    assert.equal((await oh.svc.advance(run.runId)).kind, "idle");

    // waiting_for_publish: the undecided draft is rejected so nothing new is published
    resetStore();
    resetBucket();
    oh = await makeOnboarding();
    run = await prepare(oh);
    await confirmAndDraft(oh, run);
    assert.equal(runOf(run.runId).status, "waiting_for_publish");
    c = await oh.svc.cancel(run.runId, ADMIN);
    assert.equal(c.status, "cancelled");
    assert.deepEqual(oh.rejected, [{ routeKey: ROUTE_KEY, version: 1, uid: ADMIN }]);
    assert.equal(c.counters.chunksDone, oh.chunks);
    assert.ok(c.counters.calls > 0, "spent counters are kept");
  });

  test("a run with a live worker gets the flag; the worker obeys before its next action", async () => {
    const run = await oh.svc.start(COUNTRY, VISA_ID, ADMIN);
    // A worker holds the lease.
    store.set(`routeOnboardingRuns/${run.runId}`, { ...runOf(run.runId), leaseOwner: "someone", leaseUntil: Timestamp.fromMillis(oh.h.state.nowMs + 60_000) });
    const flagged = await oh.svc.cancel(run.runId, ADMIN);
    assert.equal(flagged.status, "preparing");
    assert.equal(flagged.cancelRequested, true);
    // The lease expires; the next invocation finds the flag and ends the run without acting.
    oh.h.state.nowMs += 120_000;
    const out = await oh.svc.advance(run.runId);
    assert.deepEqual(out, { kind: "finished", status: "cancelled" });
    assert.equal(oh.visaCrawls.length, 0);
  });

  test("a cancel that arrives during an action ends the run after that action's result is recorded", async () => {
    const run = await oh.svc.start(COUNTRY, VISA_ID, ADMIN);
    // The visa crawl is mid-way when the cancel lands.
    const original = oh.deps.crawlVisa;
    let during = false;
    (oh.deps as any).crawlVisa = async (...a: any[]) => {
      if (!during) {
        during = true;
        await oh.svc.advance(run.runId).catch(() => undefined);
      }
      return original(...(a as [string, boolean]));
    };
    await oh.svc.advance(run.runId); // check_setup
    store.set(`routeOnboardingRuns/${run.runId}`, { ...runOf(run.runId), cancelRequested: true, cancelRequestedBy: ADMIN });
    const out = await oh.svc.advance(run.runId);
    assert.equal(out.kind, "finished");
    assert.equal(runOf(run.runId).status, "cancelled");
  });
});

describe("crash safety and re-delivery", () => {
  /** The scenario every kill point is run against: prepare, confirm, draft, pipeline publishes. */
  async function scenario(kill: number | null): Promise<{ killed: boolean }> {
    resetStore();
    resetBucket();
    oh = await makeOnboarding();
    let killed = false;
    const guard = async <T>(fn: () => Promise<T>): Promise<T | undefined> => {
      try {
        return await fn();
      } catch (err) {
        if (!(err instanceof Killed)) throw err;
        killed = true;
        // The dead worker's lease expires.
        oh.killAtTx = null;
        oh.h.state.nowMs += 11 * 60_000;
        return undefined;
      }
    };
    oh.txCount = 0;
    oh.killAtTx = kill;
    const run = await guard(() => oh.svc.start(COUNTRY, VISA_ID, ADMIN));
    const runId = run?.runId ?? `${ROUTE_KEY}__r1`;
    if (!run) {
      // The start itself died before its transaction: nothing exists; start again.
      assert.equal(docsUnder("routeOnboardingRuns/").length, 0);
      await oh.svc.start(COUNTRY, VISA_ID, ADMIN);
    }
    const settle = async () => {
      for (let i = 0; i < 80; i++) {
        const out = await guard(() => oh.svc.advance(runId));
        if (!out) continue;
        if (out.kind === "idle" || out.kind === "finished") return;
        if (out.kind === "advanced" && !out.wake) return;
      }
    };
    await settle();
    // After a death, wake the run again until it reaches the confirmation (the sweep's job).
    for (let i = 0; i < 5 && runOf(runId).status !== "awaiting_confirmation"; i++) await settle();
    assert.equal(runOf(runId).status, "awaiting_confirmation");
    await guard(() => confirm(oh, runOf(runId)));
    if (runOf(runId).status !== "running") await confirm(oh, runOf(runId));
    for (let i = 0; i < 5 && !runOf(runId).links.jobId; i++) await settle();
    const jobId = runOf(runId).links.jobId as string;
    await driveJob(oh, jobId);
    for (let i = 0; i < 5 && runOf(runId).status !== "waiting_for_publish"; i++) {
      await settle();
      oh.h.state.nowMs += 11 * 60_000;
    }
    writePublishRun(ROUTE_KEY, 1, { outcome: "published" });
    for (let i = 0; i < 5 && runOf(runId).status !== "published"; i++) {
      await settle();
      oh.h.state.nowMs += 11 * 60_000;
    }
    return { killed };
  }

  test("a worker killed at ANY transaction, then replayed, gives the same final status, one job and one version", async () => {
    const baseline = await scenario(null);
    assert.equal(baseline.killed, false);
    const total = oh.txCount;
    assert.equal(runOf(`${ROUTE_KEY}__r1`).status, "published");
    assert.ok(total > 10, `expected a real run, saw ${total} transactions`);
    let killedRuns = 0;
    for (let k = 1; k <= total; k++) {
      const r = await scenario(k);
      if (r.killed) killedRuns += 1;
      const final = runOf(`${ROUTE_KEY}__r1`);
      assert.equal(final.status, "published", `killed at transaction ${k}`);
      assert.equal(docsUnder("rubricExtractionJobs/").length, 1, `one job (killed at ${k})`);
      assert.equal(docsUnder(`visaRubrics/${ROUTE_KEY}/rubricVersions/`).length, 1, `one version (killed at ${k})`);
      assert.equal(docsUnder("routeOnboardingRuns/").length, 1, `one run (killed at ${k})`);
      assert.equal(oh.h.provider.requests.length > 0, true);
      // Every guidance page was crawled once per successful read; the visa page at most twice (a repeat after a death).
      assert.ok(oh.visaCrawls.length <= 2, `visa crawls ${oh.visaCrawls.length} (killed at ${k})`);
    }
    assert.ok(killedRuns > 10, "the kill points were really reached");
  });

  test("re-delivered triggers are inert; two workers at once never both act", async () => {
    const run = await oh.svc.start(COUNTRY, VISA_ID, ADMIN);
    const outs = await Promise.all([oh.svc.advance(run.runId), oh.svc.advance(run.runId), oh.svc.advance(run.runId)]);
    assert.equal(outs.filter((o) => o.kind === "advanced").length, 1);
    assert.equal(outs.filter((o) => o.kind === "lease_held").length, 2);
    await pump(oh, run.runId);
    await oh.svc.cancel(run.runId, ADMIN);
    assert.deepEqual(await oh.svc.advance(run.runId), { kind: "idle", status: "cancelled" });
    assert.deepEqual(await oh.svc.advance("XA_none__r1"), { kind: "idle", status: null });
    // A finished run stays finished however often it is delivered again.
    const before = JSON.stringify(runOf(run.runId));
    await oh.svc.advance(run.runId);
    assert.equal(JSON.stringify(runOf(run.runId)), before);
  });

  test("an unexpected error is counted and fails the run after three tries instead of looping", async () => {
    const run = await oh.svc.start(COUNTRY, VISA_ID, ADMIN);
    (oh.deps as any).loadSettings = async () => {
      throw new Error("db down");
    };
    // `start` already read settings; the worker's reads now fail.
    for (let i = 0; i < 5; i++) {
      await oh.svc.advance(run.runId);
      oh.h.state.nowMs += 11 * 60_000;
    }
    const cur = runOf(run.runId);
    assert.equal(cur.status, "failed");
    assert.match(cur.summary, /unexpected problem/);
  });

  test("the sweep wakes a stalled run, skips a leased or waiting one", async () => {
    const run = await oh.svc.start(COUNTRY, VISA_ID, ADMIN);
    oh.h.state.nowMs += 120_000;
    const first = await oh.svc.sweep();
    assert.equal(first.kicked, 1);
    const kick = runOf(run.runId).kick;
    // Just woken: not woken again at once.
    assert.equal((await oh.svc.sweep()).kicked, 0);
    // Waiting for a time that has not come yet: left alone.
    store.set(`routeOnboardingRuns/${run.runId}`, { ...runOf(run.runId), nextAttemptAt: Timestamp.fromMillis(oh.h.state.nowMs + 600_000) });
    oh.h.state.nowMs += 120_000;
    assert.equal((await oh.svc.sweep()).kicked, 0);
    oh.h.state.nowMs += 600_000;
    assert.equal((await oh.svc.sweep()).kicked, 1);
    assert.ok(runOf(run.runId).kick > kick);
  });

  test("wakeRoute bumps the active run's kick (and ignores a route with none)", async () => {
    const run = await prepare(oh);
    await confirm(oh, run);
    const before = runOf(run.runId).kick;
    await oh.svc.wakeRoute(ROUTE_KEY);
    assert.equal(runOf(run.runId).kick, before + 1);
    await oh.svc.wakeRoute("XA_no-such-route");
  });
});
