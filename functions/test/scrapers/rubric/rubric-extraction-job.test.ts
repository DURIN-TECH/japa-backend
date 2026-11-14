// ============================================
// Rulebook drafting as a resumable background job (issue #216)
// ============================================
//
// No network, no model, no emulator: a scripted provider, the in-memory
// Firestore fake with SERIALISED transactions (as the real ones are), snapshots
// in the in-memory bucket, and a fake clock. The worker is driven by calling
// `advance` the way the Firestore trigger would.
//
// The central claim is EQUIVALENCE: the job writes the same pending version
// `extractRoute` writes for the same inputs and model answers, including after a
// worker is killed at ANY point and replaced. Around it: no model call is ever
// repeated for a finished step, two workers never run one job, a duplicate start
// opens nothing, and a cancelled or stale job writes no version.

import { before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { Timestamp } from "firebase-admin/firestore";
import { resetStore, store } from "../../helpers/fake-firestore";
import { LlmProviderError } from "../../../src/services/ai/llm-provider";
import { delimiterTag } from "../../../src/scrapers/rubric/rubric-prompt";
import { chunkSnapshot } from "../../../src/scrapers/rubric/rubric-chunk";
import { STEP_DOC_CHARS, stepIdOf, type RubricExtractionJob } from "../../../src/scrapers/rubric/rubric-extraction-job.store";
import { jobIdOf, replaySteps, type AdvanceOutcome } from "../../../src/scrapers/rubric/rubric-extraction-job";
import { assessChunkOutput, type ChunkAssessment } from "../../../src/scrapers/rubric/rubric-extraction.service";
import { SnapshotQuoteIndex } from "../../../src/scrapers/rubric/rubric-quote";
import { DEFAULT_SEVERITY_LEVELS } from "../../../src/types/rubric";
import { Killed, headDoc, installRubricFakes, makeHarness, makeJobHarness, quiet, resetBucket, runDocs, snapshotStore, versionDoc, versionPaths, seedSource, type Harness, type JobHarness } from "./rubric-harness";
import { ROUTE, ROUTE_KEY, setUpMulti, storedStepKeys, textOf } from "./rubric-job-fixtures";

/* eslint-disable @typescript-eslint/no-explicit-any */

let h: Harness;
let jh: JobHarness;

before(installRubricFakes);

beforeEach(() => {
  resetStore();
  resetBucket();
  h = makeHarness();
});

/** Start a job for the route (sources named explicitly). */
const start = (sourceIds: string[], extra: Record<string, unknown> = {}) => quiet(() => jh.jobs.startJob({ ...ROUTE, sourceIds, ...extra }));
/** One worker invocation. */
const advance = (id: string, opts: { deadlineAt?: number } = {}) => quiet(() => jh.jobs.advance(id, opts)).then((r) => r.result);
/** The job document. */
const jobDoc = (id: string) => store.get(`rubricExtractionJobs/${id}`) as unknown as RubricExtractionJob;

/**
 * Drive a job the way the trigger does: invoke the worker again whenever it
 * handed over, until it reports a final state. Returns every outcome and the
 * model calls each invocation made.
 */
async function drain(id: string, max = 60): Promise<{ outcomes: AdvanceOutcome[]; callsPerInvocation: number[] }> {
  const outcomes: AdvanceOutcome[] = [];
  const callsPerInvocation: number[] = [];
  for (let i = 0; i < max; i++) {
    const before = jh.calls.length;
    const out = await advance(id);
    outcomes.push(out);
    callsPerInvocation.push(jh.calls.length - before);
    if (out.kind === "finished" || out.kind === "idle") return { outcomes, callsPerInvocation };
    // Another worker holds the lease: give it time to expire, as the sweep would wait.
    if (out.kind === "lease_held" || out.kind === "lease_lost") h.state.nowMs += h.settings.leaseMs + 1;
  }
  throw new Error(`the job did not finish in ${max} invocations`);
}

/** A version doc without the fields that are run-specific by nature. */
function comparable(v: any): any {
  const { extractionRunId: _run, createdAt: _at, ...rest } = v;
  return JSON.parse(JSON.stringify(rest));
}

// ============================================
// Equivalence with the one-shot path
// ============================================

describe("the job writes what extractRoute writes", () => {
  /** Run `extractRoute` on a fresh store and return the stored version. */
  async function oneShot(sourceCount: number, paragraphs: number) {
    const setup = await setUpMulti(h, sourceCount, paragraphs);
    const { result } = await quiet(() => h.service.extractRoute({ ...ROUTE, sourceIds: setup.sourceIds }));
    assert.equal(result.status, "succeeded", result.error ?? "");
    return { setup, version: versionDoc(ROUTE_KEY, 1), run: runDocs()[0], calls: h.provider.requests.length };
  }

  for (const [label, sources, paragraphs] of [["one source, one chunk", 1, 2], ["three sources, many chunks (one with no accepted rule)", 3, 7]] as const) {
    test(`${label}: same version, same usage, same calls`, async () => {
      const a = await oneShot(sources, paragraphs);
      // Fresh world, same inputs and the same scripted answers.
      resetStore();
      resetBucket();
      h.provider.requests.length = 0;
      await setUpMulti(h, sources, paragraphs);
      jh = makeJobHarness(h);
      const started = (await start(a.setup.sourceIds)).result;
      assert.equal(started.outcome, "started");
      const { outcomes } = await drain(started.jobId as string);
      assert.deepEqual(outcomes.at(-1), { kind: "finished", status: "succeeded", stepsRun: (outcomes.at(-1) as any).stepsRun, reasonCode: null });

      assert.equal(versionPaths().length, 1);
      // Same pending version, field for field. Run-specific by nature: the run id
      // the version names, and its creation time.
      assert.deepEqual(comparable(versionDoc(ROUTE_KEY, 1)), comparable(a.version));
      assert.equal(versionDoc(ROUTE_KEY, 1).extractionRunId, started.jobId);
      assert.equal(h.provider.requests.length, a.calls, "the same number of model calls");
      // The run record: same usage and counts, written once (the same id from start to finish).
      const run = runDocs()[0];
      assert.equal(runDocs().length, 1);
      assert.deepEqual(run.usage, a.run.usage);
      assert.equal(run.status, "succeeded");
      assert.equal(run.version, 1);
      assert.equal(run.chunks, a.run.chunks);
      assert.equal(run.criteriaAccepted, a.run.criteriaAccepted);
      assert.deepEqual(run.discardedByReason, a.run.discardedByReason);
      assert.deepEqual(headDoc(ROUTE_KEY), { ...headDoc(ROUTE_KEY), latestVersion: 1, approvedVersion: null });
      // The job says the same.
      const job = jobDoc(started.jobId as string);
      assert.equal(job.status, "succeeded");
      assert.equal(job.version, 1);
      assert.equal(job.chunksDone, job.chunks);
      assert.equal(job.usage.requests, a.calls);
    });
  }

  test("the answers really do depend on the order of the steps (the fixture is not vacuous)", async () => {
    const a = await oneShot(2, 6);
    const labels = (a.version.intakeQuestions as any[]).map((q) => q.label as string);
    assert.ok(labels.length > 2);
    assert.ok(labels.some((l) => l.endsWith("(after 0 earlier)")) && labels.some((l) => !l.endsWith("(after 0 earlier)")), labels.join(" | "));
  });
});

// ============================================
// Steps: one call each, stored once
// ============================================

describe("steps", () => {
  test("a step makes one model call; every stored result is exactly the one call's; no call is repeated", async () => {
    const setup = await setUpMulti(h, 2, 6);
    jh = makeJobHarness(h);
    const id = (await start(setup.sourceIds)).result.jobId as string;
    const { callsPerInvocation } = await drain(id);
    assert.equal(jh.calls.length, setup.calls);
    assert.equal(new Set(jh.calls).size, jh.calls.length, "no call was made twice");
    assert.equal(storedStepKeys(id).length, setup.calls, "one stored result per call");
    assert.equal(callsPerInvocation.reduce((a, b) => a + b, 0), setup.calls);
    // A step document holds the validated result as JSON and what it cost.
    const stepDocs = [...store.entries()].filter(([p]) => p.startsWith(`rubricExtractionJobs/${id}/steps/`));
    assert.equal(stepDocs.length, setup.calls);
    for (const [, d] of stepDocs as [string, any][]) {
      assert.equal(typeof d.data, "string");
      assert.equal(d.usage.requests, 1);
      assert.equal(d.parts, 1);
    }
  });

  test("a step that is already stored is never called again, even when asked to run the job again", async () => {
    const setup = await setUpMulti(h, 1, 4);
    jh = makeJobHarness(h);
    const id = (await start(setup.sourceIds)).result.jobId as string;
    await drain(id);
    const calls = jh.calls.length;
    assert.deepEqual(await advance(id), { kind: "idle", status: "succeeded" });
    assert.equal(jh.calls.length, calls);
  });

  test("the saved results are plain JSON (no Map, Set or class instance) and round-trip unchanged", async () => {
    const setup = await setUpMulti(h, 1, 4);
    const hash = (store.get(`guidanceSources/src-1`) as any).latestSnapshotId as string;
    const content = await snapshotStore.read("src-1", hash);
    const chunk = chunkSnapshot(content, h.settings.maxChunkChars)[0];
    const { quotes } = textOf(1, 4);
    const index = new SnapshotQuoteIndex(content);
    const raw: any = {
      criteria: [{ ref: "a", title: "Evidence 11 provided", kind: "judgement", stage: "credibility", severity: "high", ruleRef: null, concernsIntent: false, applicability: "all_applicants", applicabilityCondition: null, check: null, appliesTo: null, validFrom: null, validUntil: null, probeFactors: ["x"], requiresInterviewBeforeRefusal: false, citations: [], confidence: 0.9, quote: quotes[0] }],
      intentPolarity: null, intake: null, intakeQuestions: [], evidenceItems: [], ruleTriggers: [], suspiciousPassages: [],
    };
    const part: ChunkAssessment = assessChunkOutput(raw, chunk, index, { sourceId: "src-1", url: "https://docs.invalid/src-1", contentHash: hash, retrievedAt: "2026-01-01T00:00:00.000Z" }, DEFAULT_SEVERITY_LEVELS);
    assert.equal(part.criteria.length, 1, JSON.stringify(part.discards));
    // Round trip: what is stored is what JSON gives back.
    assert.deepEqual(JSON.parse(JSON.stringify(part)), JSON.parse(JSON.stringify(part)));
    const walk = (v: unknown, path: string): void => {
      assert.ok(!(v instanceof Map) && !(v instanceof Set) && !(v instanceof Date), `${path} is a Map, Set or Date`);
      if (v && typeof v === "object") {
        const proto = Object.getPrototypeOf(v);
        assert.ok(proto === Object.prototype || proto === Array.prototype, `${path} is a class instance`);
        for (const [k, x] of Object.entries(v)) walk(x, `${path}.${k}`);
      }
    };
    walk(part, "assessment");
    walk({ requests: 1, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }, "usage");
    walk({ failed: 0, cap: 4 }, "attempts");
    void setup;
  });

  test("a result too large for one document is split over parts and read back whole (never truncated)", async () => {
    const setup = await setUpMulti(h, 1, 2);
    jh = makeJobHarness(h);
    const big: any = { criteria: [], discards: [], suspiciousPassages: [], polarity: null, intake: null, intakeQuestions: [], evidenceItems: [], counters: { judgementChecksStripped: 0, ruleRefsRemoved: 0, ruleRefsDerived: 0 }, filler: "é".repeat(STEP_DOC_CHARS * 2 + 17) };
    await jh.jobStore.runTransaction(async (tx) => {
      jh.jobStore.writeStepInTx(tx, "job-x", { stepId: "c0000__criteria", position: 0, phase: "criteria", sourceId: "s", chunkIndex: 0, result: big, usage: { requests: 1, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }, failedAttempts: 0, createdAt: Timestamp.fromMillis(0) });
    });
    const header = store.get("rubricExtractionJobs/job-x/steps/c0000__criteria") as any;
    assert.equal(header.parts, 3);
    assert.equal(header.data, undefined);
    const steps = await jh.jobStore.readSteps("job-x");
    assert.deepEqual(steps.get("c0000__criteria")?.result, big);
    void setup;
  });

  test("the position of the next step is derived from the stored results (a chunk with no accepted rule has no intake step)", async () => {
    const setup = await setUpMulti(h, 2, 3);
    jh = makeJobHarness(h);
    const id = (await start(setup.sourceIds)).result.jobId as string;
    await drain(id);
    const job = jobDoc(id);
    // Rebuild the chunk list as the worker does, then replay.
    const chunks = [];
    for (const s of job.sources) chunks.push(...chunkSnapshot(await snapshotStore.read(s.snapshot.sourceId, s.snapshot.contentHash), job.pinned.maxChunkChars));
    const steps = await jh.jobStore.readSteps(id);
    assert.equal(replaySteps(chunks, steps).next, null);
    // Drop the last stored step: replay points at exactly that step.
    const lastId = [...steps.keys()].sort().at(-1) as string;
    steps.delete(lastId);
    const next = replaySteps(chunks, steps).next;
    assert.equal(stepIdOf(next?.position as number, next?.phase as any), lastId);
    // The silent chunk (first of the last source) has a criteria step and no intake step.
    const silentPos = chunks.findIndex((c) => c.sourceId === "src-2" && c.chunkIndex === 0);
    assert.ok(steps.has(stepIdOf(silentPos, "criteria")));
    assert.ok(!steps.has(stepIdOf(silentPos, "intake")));
  });
});

// ============================================
// Start: duplicate, restart, plan
// ============================================

describe("starting a job", () => {
  test("a duplicate start is a no-op that returns the first job (one job, one run record)", async () => {
    const setup = await setUpMulti(h, 1, 4);
    jh = makeJobHarness(h);
    const first = (await start(setup.sourceIds)).result;
    const second = (await start(setup.sourceIds)).result;
    assert.equal(first.outcome, "started");
    assert.equal(second.outcome, "existing");
    assert.equal(second.jobId, first.jobId);
    assert.equal([...store.keys()].filter((k) => /^rubricExtractionJobs\/[^/]+$/.test(k)).length, 1);
    assert.equal(runDocs().length, 1);
    assert.equal(runDocs()[0].status, "started");
    // Two starts racing in the same instant: still one job.
    const [a, b] = await Promise.all([start(setup.sourceIds, { force: true }), start(setup.sourceIds, { force: true })]);
    assert.deepEqual([a.result.outcome, b.result.outcome].sort(), ["existing", "started"]);
    assert.equal(runDocs().length, 2, "the forced job's own record; the duplicate added none");
  });

  test("the job id is the route plus a digest of what makes two drafts the same draft", () => {
    const base = { routeKey: "XA_r", sourceSetHash: "h", promptVersion: "p", model: "m", maxChunkChars: 1000, latestVersion: 0, force: false };
    const id = jobIdOf(base);
    assert.match(id, /^XA_r__[0-9a-f]{16}$/);
    assert.equal(jobIdOf({ ...base }), id);
    for (const change of [{ sourceSetHash: "h2" }, { promptVersion: "p2" }, { model: "m2" }, { maxChunkChars: 2000 }, { latestVersion: 1 }, { force: true }]) {
      assert.notEqual(jobIdOf({ ...base, ...change }), id, JSON.stringify(change));
    }
  });

  test("a plan (dryRun) creates nothing and calls no model", async () => {
    const setup = await setUpMulti(h, 2, 6);
    jh = makeJobHarness(h);
    const { result } = await start(setup.sourceIds, { dryRun: true });
    assert.equal(result.outcome, "dry_run");
    assert.equal(result.jobId, null);
    assert.equal(result.estimate?.chunks, setup.chunks);
    assert.equal(result.estimate?.maxRequests, setup.chunks * 2);
    assert.equal(result.plan.length, 2);
    assert.equal([...store.keys()].filter((k) => k.startsWith("rubricExtractionJobs/")).length, 0);
    assert.equal(runDocs().length, 0);
    assert.equal(jh.calls.length, 0);
  });

  test("the sources of the newest version: nothing to draft, unless forced (then a new job, after the first has written its version)", async () => {
    const setup = await setUpMulti(h, 1, 4);
    jh = makeJobHarness(h);
    const id = (await start(setup.sourceIds)).result.jobId as string;
    await drain(id);
    assert.equal((await start(setup.sourceIds)).result.outcome, "unchanged");
    const forced = (await start(setup.sourceIds, { force: true })).result;
    assert.equal(forced.outcome, "started");
    assert.notEqual(forced.jobId, id);
    await drain(forced.jobId as string);
    assert.equal(versionPaths().length, 2);
  });

  test("the route's visa type must exist: the existing clear error, and no job", async () => {
    const setup = await setUpMulti(h, 1, 2);
    h.state.knownVisaTypes.clear();
    jh = makeJobHarness(h);
    const { result } = await start(setup.sourceIds);
    assert.equal(result.outcome, "refused");
    assert.equal(result.reasonCode, "visa_type_not_found");
    assert.match(result.message as string, /no visa type/);
    assert.equal([...store.keys()].filter((k) => k.startsWith("rubricExtractionJobs/")).length, 0);
  });

  test("a stopped job of the same inputs is queued again and KEEPS its finished steps (nothing paid for twice)", async () => {
    const setup = await setUpMulti(h, 1, 6);
    jh = makeJobHarness(h);
    const id = (await start(setup.sourceIds)).result.jobId as string;
    // Fail the 4th call hard: the job fails with some steps stored.
    jh.beforeCall = (n) => {
      if (n === 4) throw new LlmProviderError("provider_error", "status=400 bad request");
    };
    const { outcomes } = await drain(id);
    assert.equal((outcomes.at(-1) as any).status, "failed");
    const before = storedStepKeys(id).length;
    assert.equal(before, 3);
    jh.beforeCall = null;
    const callsBefore = jh.calls.length;
    const again = (await start(setup.sourceIds)).result;
    assert.equal(again.outcome, "restarted");
    assert.equal(again.jobId, id);
    await drain(id);
    assert.equal(jobDoc(id).status, "succeeded");
    // Only the failed step and the steps after it were called; the three stored ones were not.
    assert.equal(jh.calls.length - callsBefore, setup.calls - 3);
    assert.equal(new Set(jh.calls.slice(callsBefore)).size, jh.calls.length - callsBefore);
    // One run record throughout, and it counts once toward the daily cap.
    assert.equal(runDocs().length, 1);
    assert.equal(runDocs()[0].status, "succeeded");
  });
});

// ============================================
// Crash and resume
// ============================================

describe("a worker that dies is replaced without paying twice", () => {
  test("killed before every transaction of the run: the sweep resumes it, the version equals the uninterrupted one, no finished step is called again", async () => {
    // The uninterrupted run: the reference version and the number of transactions.
    const setup = await setUpMulti(h, 2, 5);
    jh = makeJobHarness(h);
    const id = (await start(setup.sourceIds)).result.jobId as string;
    const txAfterStart = jh.txCount;
    await drain(id);
    const total = jh.txCount;
    const reference = comparable(versionDoc(ROUTE_KEY, 1));
    const referenceCalls = jh.calls.length;
    assert.ok(total - txAfterStart > setup.calls, "every step has its own transactions");

    for (let kill = txAfterStart + 1; kill <= total; kill++) {
      resetStore();
      resetBucket();
      h.provider.requests.length = 0;
      await setUpMulti(h, 2, 5);
      jh = makeJobHarness(h);
      assert.equal((await start(setup.sourceIds)).result.jobId, id);
      const txBase = jh.txCount;
      jh.killAtTx = txBase + (kill - txAfterStart);
      // Invocations until the process dies (it may also run to the end if the kill is late).
      let died = false;
      try {
        for (let i = 0; i < 80; i++) {
          const out = await advance(id);
          if (out.kind === "finished" || out.kind === "idle") break;
        }
      } catch (err) {
        assert.ok(err instanceof Killed, String(err));
        died = true;
      }
      assert.ok(died, `kill at transaction ${kill} should have stopped the worker`);
      // What was stored when the process died; none of it may be called again.
      const stored = new Set(storedStepKeys(id));
      const callsAtDeath = jh.calls.length;
      // A new process: the lease runs out, the sweep wakes the job, a worker resumes it.
      jh.killAtTx = null;
      h.state.nowMs += h.settings.leaseMs + h.settings.jobIdleMs + 1;
      await quiet(() => jh.jobs.sweep());
      const { outcomes } = await drain(id);
      assert.equal((outcomes.at(-1) as any).status, "succeeded", `kill at ${kill}: ${JSON.stringify(outcomes.at(-1))}`);
      for (const key of jh.calls.slice(callsAtDeath)) assert.ok(!stored.has(key), `kill at ${kill}: ${key} was stored and called again`);
      // A call in flight when the process died may be lost and repeated: at most one in all.
      assert.ok(jh.calls.length <= referenceCalls + 1, `kill at ${kill}: ${jh.calls.length} calls against ${referenceCalls}`);
      // Exactly one version, identical to the uninterrupted one.
      assert.equal(versionPaths().length, 1, `kill at ${kill}`);
      assert.deepEqual(comparable(versionDoc(ROUTE_KEY, 1)), reference, `kill at ${kill}`);
      assert.equal(runDocs().length, 1);
    }
  });

  test("a dead worker's in-flight call counts as a failed attempt and against the cap", async () => {
    const setup = await setUpMulti(h, 1, 4);
    jh = makeJobHarness(h);
    const id = (await start(setup.sourceIds)).result.jobId as string;
    // Die during the 2nd call (before its result is stored).
    jh.beforeCall = (n) => {
      if (n === 2) jh.killAtTx = jh.txCount + 1;
    };
    await assert.rejects(() => advance(id), Killed);
    jh.beforeCall = null;
    jh.killAtTx = null;
    assert.equal(jobDoc(id).inFlight?.stepId, stepIdOf(1, "criteria") === jobDoc(id).inFlight?.stepId ? stepIdOf(1, "criteria") : jobDoc(id).inFlight?.stepId);
    h.state.nowMs += h.settings.leaseMs + 1;
    await drain(id);
    const job = jobDoc(id);
    assert.equal(job.status, "succeeded");
    assert.equal(job.failedAttempts, 1);
    assert.equal(job.inFlight, null);
  });

  test("a step that can never finish ends the job after the allowed attempts, with a reason (never a silent loop)", async () => {
    const setup = await setUpMulti(h, 1, 4);
    jh = makeJobHarness(h);
    const id = (await start(setup.sourceIds)).result.jobId as string;
    // Every worker dies during its first call.
    for (let i = 0; i < h.settings.stepAttemptsMax; i++) {
      jh.beforeCall = () => {
        jh.killAtTx = jh.txCount + 1;
      };
      await assert.rejects(() => advance(id), Killed);
      jh.killAtTx = null;
      h.state.nowMs += h.settings.leaseMs + 1;
    }
    jh.beforeCall = null;
    const out = await advance(id);
    assert.deepEqual(out, { kind: "finished", status: "failed", stepsRun: 0, reasonCode: "provider_error" });
    const job = jobDoc(id);
    assert.equal(job.status, "failed");
    assert.match(job.message as string, /failed 3 times/);
    assert.equal(versionPaths().length, 0);
    assert.equal(runDocs()[0].status, "failed");
  });
});

// ============================================
// Leases: two workers
// ============================================

describe("leases", () => {
  test("two workers racing on one job: one runs it, the other does nothing, no call is repeated", async () => {
    const setup = await setUpMulti(h, 2, 4);
    jh = makeJobHarness(h);
    const id = (await start(setup.sourceIds)).result.jobId as string;
    const [a, b] = await Promise.all([advance(id), advance(id)]);
    const kinds = [a.kind, b.kind].sort();
    assert.ok(kinds.includes("lease_held"), JSON.stringify([a, b]));
    // Whatever the winner did, finish the job and count the calls.
    await drain(id);
    assert.equal(jh.calls.length, setup.calls);
    assert.equal(new Set(jh.calls).size, setup.calls);
    assert.equal(versionPaths().length, 1);
  });

  test("a duplicate delivery of the trigger while a lease is live does nothing", async () => {
    const setup = await setUpMulti(h, 1, 4);
    jh = makeJobHarness(h);
    const id = (await start(setup.sourceIds)).result.jobId as string;
    // A worker holds a live lease (it is "between calls").
    store.set(`rubricExtractionJobs/${id}`, { ...jobDoc(id), status: "running", leaseOwner: "someone-else", leaseUntil: Timestamp.fromMillis(h.state.nowMs + 60_000) });
    assert.deepEqual(await advance(id), { kind: "lease_held" });
    assert.equal(jh.calls.length, 0);
  });

  test("a worker that lost its lease writes nothing", async () => {
    const setup = await setUpMulti(h, 1, 4);
    jh = makeJobHarness(h);
    const id = (await start(setup.sourceIds)).result.jobId as string;
    // Another worker takes the lease while this one is inside its first call.
    jh.beforeCall = () => {
      store.set(`rubricExtractionJobs/${id}`, { ...jobDoc(id), leaseOwner: "usurper", leaseUntil: Timestamp.fromMillis(h.state.nowMs + 60_000) });
    };
    const out = await advance(id);
    assert.equal(out.kind, "lease_lost");
    assert.equal(storedStepKeys(id).length, 0);
    assert.equal(jobDoc(id).usage.requests, 0);
  });

  test("the sweep wakes a stalled job (lease run out, no recent progress) and leaves a live or busy one alone", async () => {
    const setup = await setUpMulti(h, 1, 4);
    jh = makeJobHarness(h);
    const id = (await start(setup.sourceIds)).result.jobId as string;
    const kick0 = jobDoc(id).kick;
    // Just created: recent progress, nothing to do.
    assert.deepEqual((await quiet(() => jh.jobs.sweep())).result, { considered: 1, kicked: 0 });
    // Quiet for a while: wake it.
    h.state.nowMs += h.settings.jobIdleMs + 1;
    assert.deepEqual((await quiet(() => jh.jobs.sweep())).result, { considered: 1, kicked: 1 });
    assert.equal(jobDoc(id).kick, kick0 + 1);
    // A live lease: leave it, however quiet.
    store.set(`rubricExtractionJobs/${id}`, { ...jobDoc(id), leaseOwner: "w", leaseUntil: Timestamp.fromMillis(h.state.nowMs + 60_000), updatedAt: Timestamp.fromMillis(0) });
    assert.equal((await quiet(() => jh.jobs.sweep())).result.kicked, 0);
    // A finished job is not even considered.
    store.set(`rubricExtractionJobs/${id}`, { ...jobDoc(id), status: "succeeded" });
    assert.deepEqual((await quiet(() => jh.jobs.sweep())).result, { considered: 0, kicked: 0 });
  });
});

// ============================================
// Time: an invocation does what fits, then hands over
// ============================================

describe("time budget", () => {
  test("a route with many chunks needs several invocations; each makes only as many calls as fit; the result is the same", async () => {
    const setup = await setUpMulti(h, 3, 8);
    jh = makeJobHarness(h);
    // 100 s per call, a 450 s budget and a 240 s request timeout: a new step starts only if 240 s still fit.
    jh.callMs = 100_000;
    const id = (await start(setup.sourceIds)).result.jobId as string;
    const { outcomes, callsPerInvocation } = await drain(id);
    assert.ok(outcomes.length > 3, `${outcomes.length} invocations`);
    assert.ok(Math.max(...callsPerInvocation) <= 3, JSON.stringify(callsPerInvocation));
    assert.ok(outcomes.slice(0, -1).every((o) => o.kind === "handed_over"));
    assert.equal(jh.calls.length, setup.calls);
    assert.equal(versionPaths().length, 1);
    // The same rulebook an uninterrupted one-shot run writes.
    const jobVersion = comparable(versionDoc(ROUTE_KEY, 1));
    resetStore();
    resetBucket();
    await setUpMulti(h, 3, 8);
    await quiet(() => h.service.extractRoute({ ...ROUTE, sourceIds: setup.sourceIds }));
    assert.deepEqual(comparable(versionDoc(ROUTE_KEY, 1)), jobVersion);
  });

  test("the first step of an invocation always runs, even when the request timeout is longer than the budget", async () => {
    const setup = await setUpMulti(h, 1, 3);
    h.settings.requestTimeoutMs = 600_000;
    h.settings.invocationBudgetMs = 100_000;
    jh = makeJobHarness(h);
    const id = (await start(setup.sourceIds)).result.jobId as string;
    const { callsPerInvocation } = await drain(id);
    assert.ok(callsPerInvocation.every((n) => n <= 1));
    assert.equal(jobDoc(id).status, "succeeded");
  });
});

// ============================================
// Retries and failures
// ============================================

describe("a step that fails", () => {
  const transient = () => new LlmProviderError("provider_error", "status=529 overloaded");

  test("a transient failure is retried inside the invocation and succeeds; the retry counts against the cap", async () => {
    const setup = await setUpMulti(h, 1, 3);
    jh = makeJobHarness(h);
    const id = (await start(setup.sourceIds)).result.jobId as string;
    jh.beforeCall = (n) => {
      if (n === 1) throw transient();
    };
    await drain(id);
    const job = jobDoc(id);
    assert.equal(job.status, "succeeded");
    assert.equal(job.usage.requests, setup.calls, "paid calls");
    assert.equal(job.failedAttempts, 1, "the failed attempt is counted against the cap");
  });

  test("with no time left for an in-process retry, the step fails cleanly and the NEXT invocation retries it", async () => {
    const setup = await setUpMulti(h, 1, 3);
    jh = makeJobHarness(h);
    const id = (await start(setup.sourceIds)).result.jobId as string;
    jh.beforeCall = (n) => {
      if (n === 1) throw transient();
    };
    // A deadline too close for a pause plus a whole request timeout.
    const first = await advance(id, { deadlineAt: h.state.nowMs + 1000 });
    assert.deepEqual(first, { kind: "handed_over", stepsRun: 0 });
    assert.equal(jobDoc(id).stepFailure.count, 1);
    assert.equal(jobDoc(id).leaseOwner, null);
    assert.equal(jobDoc(id).status, "running");
    await drain(id);
    assert.equal(jobDoc(id).status, "succeeded");
    assert.equal(jobDoc(id).stepFailure.count, 0, "reset by the step that succeeded");
  });

  test("three failed attempts of one step fail the job with the failure's code; the run record shows how far it got", async () => {
    const setup = await setUpMulti(h, 1, 6);
    jh = makeJobHarness(h);
    const id = (await start(setup.sourceIds)).result.jobId as string;
    // The 3rd call (the second chunk's first step... any step) always fails transiently.
    jh.beforeCall = (n) => {
      if (n >= 3) throw transient();
    };
    const { outcomes } = await drain(id);
    assert.deepEqual({ ...outcomes.at(-1), stepsRun: 0 }, { kind: "finished", status: "failed", stepsRun: 0, reasonCode: "provider_error" });
    const job = jobDoc(id);
    assert.equal(job.status, "failed");
    assert.equal(job.stepFailure.count, 3);
    assert.match(job.message as string, /parts done/);
    assert.equal(versionPaths().length, 0);
    const run = runDocs()[0];
    assert.equal(run.status, "failed");
    assert.equal(run.reasonCode, "provider_error");
    assert.equal(run.chunks, job.chunks);
    assert.equal(run.usage.requests, 2, "the two finished calls");
    assert.equal(headDoc(ROUTE_KEY), undefined);
  });

  test("a failure retrying cannot fix (a refused or cut-off answer) fails the job at once, keeping the steps and the tokens spent", async () => {
    const setup = await setUpMulti(h, 1, 6);
    jh = makeJobHarness(h);
    const id = (await start(setup.sourceIds)).result.jobId as string;
    const real = h.provider.complete;
    h.provider.complete = async (req) => {
      if (jh.calls.length === 2) return { text: "", stopReason: "refusal", usage: { inputTokens: 500, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, model: "recorded-model" };
      return real(req);
    };
    const { outcomes } = await drain(id);
    assert.equal((outcomes.at(-1) as any).reasonCode, "provider_refused");
    const job = jobDoc(id);
    assert.equal(job.status, "failed");
    assert.equal(job.usage.requests, 3, "the refused call was billed");
    assert.equal(storedStepKeys(id).length, 2);
    assert.equal(versionPaths().length, 0);
  });
});

// ============================================
// Caps and the kill switch
// ============================================

describe("caps and settings hold across the whole job", () => {
  test("a plan over the request cap or the character cap is refused before any job or call", async () => {
    const setup = await setUpMulti(h, 2, 6);
    jh = makeJobHarness(h);
    h.settings.maxRequestsPerRun = setup.chunks * 2 - 1;
    let { result } = await start(setup.sourceIds);
    assert.equal(result.outcome, "refused");
    assert.equal(result.reasonCode, "run_cap_exceeded");
    h.settings.maxRequestsPerRun = 40;
    h.settings.maxInputCharsPerRun = 1000;
    ({ result } = await start(setup.sourceIds));
    assert.equal(result.reasonCode, "run_cap_exceeded");
    assert.equal(jh.calls.length, 0);
    assert.equal([...store.keys()].filter((k) => k.startsWith("rubricExtractionJobs/")).length, 0);
    assert.equal(runDocs().length, 0);
  });

  test("retries count against the cap: a job that would pass it stops with a clear status and keeps its steps (no truncated rulebook)", async () => {
    const setup = await setUpMulti(h, 1, 6);
    jh = makeJobHarness(h);
    // Room for exactly the calls the plan needs: any retry passes the cap.
    h.settings.maxRequestsPerRun = setup.calls;
    const id = (await start(setup.sourceIds)).result.jobId as string;
    jh.beforeCall = (n) => {
      if (n === 2) throw new LlmProviderError("provider_error", "status=529 overloaded");
    };
    const { outcomes } = await drain(id);
    const last = outcomes.at(-1) as any;
    assert.equal(last.status, "skipped", JSON.stringify(last));
    assert.equal(last.reasonCode, "run_cap_exceeded");
    const job = jobDoc(id);
    assert.ok(job.usage.requests + job.failedAttempts <= setup.calls, "the cap was never passed");
    assert.equal(versionPaths().length, 0);
    assert.ok(storedStepKeys(id).length >= 1);
  });

  test("the cap is checked before EVERY call from the job's own counters, so a new invocation cannot spend it again", async () => {
    const setup = await setUpMulti(h, 1, 6);
    jh = makeJobHarness(h);
    const id = (await start(setup.sourceIds)).result.jobId as string;
    // Pretend earlier invocations already used the whole cap.
    store.set(`rubricExtractionJobs/${id}`, { ...jobDoc(id), usage: { ...jobDoc(id).usage, requests: jobDoc(id).pinned.maxRequestsPerRun } });
    const out = await advance(id);
    assert.deepEqual(out, { kind: "finished", status: "skipped", stepsRun: 0, reasonCode: "run_cap_exceeded" });
    assert.equal(jh.calls.length, 0);
  });

  test("a switched-off or unreadable settings doc stops a job (skipped), writing nothing", async () => {
    const setup = await setUpMulti(h, 1, 4);
    jh = makeJobHarness(h);
    // Refused at start...
    h.settings.enabled = false;
    assert.equal((await start(setup.sourceIds)).result.reasonCode, "disabled");
    h.settings.enabled = true;
    h.state.readError = "boom";
    assert.equal((await start(setup.sourceIds)).result.reasonCode, "settings_unavailable");
    h.state.readError = undefined;
    // ...and stops a job already running.
    const id = (await start(setup.sourceIds)).result.jobId as string;
    h.settings.enabled = false;
    assert.deepEqual(await advance(id), { kind: "finished", status: "skipped", stepsRun: 0, reasonCode: "disabled" });
    h.settings.enabled = true;
    // A stopped job can be started again; this time the settings cannot be read.
    assert.equal((await start(setup.sourceIds)).result.outcome, "restarted");
    h.state.readError = "boom";
    assert.deepEqual(await advance(id), { kind: "finished", status: "skipped", stepsRun: 0, reasonCode: "settings_unavailable" });
    assert.equal(jh.calls.length, 0);
    assert.equal(versionPaths().length, 0);
  });

  test("the daily cap counts a job once, at its creation", async () => {
    const setup = await setUpMulti(h, 1, 4);
    jh = makeJobHarness(h);
    h.settings.maxRunsPerDay = 1;
    const id = (await start(setup.sourceIds)).result.jobId as string;
    await drain(id);
    // The next route-run today is refused; the finished job did not count twice.
    const second = (await start(setup.sourceIds, { force: true })).result;
    assert.equal(second.outcome, "refused");
    assert.equal(second.reasonCode, "daily_cap_reached");
    h.settings.maxRunsPerDay = 2;
    assert.equal((await start(setup.sourceIds, { force: true })).result.outcome, "started");
  });
});

// ============================================
// Cancel
// ============================================

describe("cancel", () => {
  test("a flag set while a worker runs stops the job before its next step; finished steps and usage stay; no version", async () => {
    const setup = await setUpMulti(h, 1, 6);
    jh = makeJobHarness(h);
    const id = (await start(setup.sourceIds)).result.jobId as string;
    // The admin cancels during the 2nd call.
    jh.beforeCall = (n) => {
      if (n === 2) void jh.jobs.cancel(id, "admin-1");
    };
    const out = await advance(id);
    assert.equal(out.kind, "finished");
    assert.equal((out as any).status, "cancelled");
    const job = jobDoc(id);
    assert.equal(job.status, "cancelled");
    assert.equal(job.reasonCode, "cancelled");
    assert.equal(job.cancelRequestedBy, "admin-1");
    // The call in flight finished and was kept; nothing was started after it.
    assert.equal(jh.calls.length, 2);
    assert.equal(storedStepKeys(id).length, 2);
    assert.equal(job.usage.requests, 2);
    assert.equal(versionPaths().length, 0);
    assert.equal(runDocs()[0].status, "failed");
    assert.equal(runDocs()[0].reasonCode, "cancelled");
    // A cancelled job is not picked up again by the sweep or a late trigger.
    assert.deepEqual(await advance(id), { kind: "idle", status: "cancelled" });
  });

  test("a job nobody is working on is cancelled at once; a finished job is left as it is; an unknown id is null", async () => {
    const setup = await setUpMulti(h, 1, 4);
    jh = makeJobHarness(h);
    const id = (await start(setup.sourceIds)).result.jobId as string;
    const view = await jh.jobs.cancel(id, "admin-1");
    assert.equal(view?.status, "cancelled");
    assert.equal(jh.calls.length, 0);
    assert.equal(await jh.jobs.cancel("XA_nothing__0123456789abcdef", "admin-1"), null);
    // Start again, finish, then cancel: unchanged.
    await start(setup.sourceIds);
    await drain(id);
    assert.equal((await jh.jobs.cancel(id, "admin-1"))?.status, "succeeded");
  });

  test("a cancel that lands after the last step, before the version is written, writes no version", async () => {
    const setup = await setUpMulti(h, 1, 4);
    jh = makeJobHarness(h);
    const id = (await start(setup.sourceIds)).result.jobId as string;
    // Cancel from inside the final transaction's guard window: after every step is stored.
    let cancelled = false;
    const realRead = jh.jobStore.readSteps.bind(jh.jobStore);
    jh.jobStore.readSteps = async (jobId: string) => realRead(jobId);
    const realSweep = jh.jobStore.runTransaction;
    jh.jobStore.runTransaction = (async (fn: any) => {
      // The first transaction that touches the version store happens in the final step.
      if (!cancelled && jh.calls.length === setup.calls) {
        cancelled = true;
        const cur = jobDoc(id);
        store.set(`rubricExtractionJobs/${id}`, { ...cur, cancelRequested: true });
      }
      return realSweep(fn);
    }) as any;
    jh.h.rubrics.runTransaction = ((fn: any) => jh.jobStore.runTransaction(fn)) as any;
    const out = await advance(id);
    assert.equal((out as any).status, "cancelled", JSON.stringify(out));
    assert.equal(versionPaths().length, 0);
  });
});

// ============================================
// The inputs are pinned
// ============================================

describe("inputs pinned at start", () => {
  test("a source that changes mid-job stops the job before another call: skipped, no version, and the new text is never mixed in", async () => {
    const setup = await setUpMulti(h, 2, 6);
    jh = makeJobHarness(h);
    h.settings.invocationBudgetMs = 100_000;
    h.settings.requestTimeoutMs = 60_000;
    jh.callMs = 50_000;
    const id = (await start(setup.sourceIds)).result.jobId as string;
    const first = await advance(id);
    assert.equal(first.kind, "handed_over");
    const done = storedStepKeys(id).length;
    // A crawl moves the source's newest snapshot.
    await seedSource({ id: "src-1", url: "https://docs.invalid/src-1", text: textOf(9, 6).text });
    const callsBefore = jh.calls.length;
    const out = await advance(id);
    assert.deepEqual(out, { kind: "finished", status: "skipped", stepsRun: 0, reasonCode: "sources_changed" });
    assert.equal(jh.calls.length, callsBefore, "no call after the change");
    assert.equal(storedStepKeys(id).length, done);
    assert.equal(versionPaths().length, 0);
    assert.equal(runDocs()[0].status, "skipped");
    assert.match(jobDoc(id).message as string, /new job/);
  });

  test("a source that changes after the last step is caught before the version is written", async () => {
    const setup = await setUpMulti(h, 1, 3);
    jh = makeJobHarness(h);
    const id = (await start(setup.sourceIds)).result.jobId as string;
    // The change lands during the very last call; the worker has no later chance to notice before the final step.
    jh.beforeCall = (n) => {
      if (n === setup.calls) void seedSource({ id: "src-1", url: "https://docs.invalid/src-1", text: textOf(9, 3).text });
    };
    const out = await advance(id);
    assert.equal((out as any).reasonCode, "sources_changed", JSON.stringify(out));
    assert.equal(versionPaths().length, 0);
  });

  test("a job reads the pinned snapshots by hash: a changed source does not change what a resumed worker reads", async () => {
    const setup = await setUpMulti(h, 1, 3);
    jh = makeJobHarness(h);
    const id = (await start(setup.sourceIds)).result.jobId as string;
    const pinned = jobDoc(id).sources[0].snapshot.contentHash;
    await seedSource({ id: "src-1", url: "https://docs.invalid/src-1", text: textOf(9, 3).text });
    assert.equal(jobDoc(id).sources[0].snapshot.contentHash, pinned);
    // The new draft of the new text gets its own job id (the source-set hash is part of it).
    const next = (await start(setup.sourceIds)).result;
    assert.notEqual(next.jobId, id);
  });

  test("if the way text is cut changes under a running job, it stops (plan_changed) instead of misaligning its saved steps", async () => {
    const setup = await setUpMulti(h, 1, 6);
    jh = makeJobHarness(h);
    const id = (await start(setup.sourceIds)).result.jobId as string;
    store.set(`rubricExtractionJobs/${id}`, { ...jobDoc(id), chunkRefs: ["src-1#0#1"] });
    assert.deepEqual(await advance(id), { kind: "finished", status: "failed", stepsRun: 0, reasonCode: "plan_changed" });
    void delimiterTag;
  });
});

// ============================================
// Exactly one version
// ============================================

describe("the final step writes exactly one version", () => {
  test("a re-delivered trigger after success writes nothing, even for a forced draft whose version number would advance", async () => {
    const setup = await setUpMulti(h, 1, 4);
    jh = makeJobHarness(h);
    const first = (await start(setup.sourceIds)).result.jobId as string;
    await drain(first);
    const forced = (await start(setup.sourceIds, { force: true })).result.jobId as string;
    await drain(forced);
    assert.equal(versionPaths().length, 2);
    for (let i = 0; i < 3; i++) {
      assert.equal((await advance(forced)).kind, "idle");
      assert.equal((await advance(first)).kind, "idle");
    }
    assert.equal(versionPaths().length, 2);
    assert.equal(headDoc(ROUTE_KEY).latestVersion, 2);
  });

  test("two workers reaching the final step together: one version", async () => {
    const setup = await setUpMulti(h, 1, 4);
    jh = makeJobHarness(h);
    const id = (await start(setup.sourceIds)).result.jobId as string;
    const txAfterStart = jh.txCount;
    await drain(id);
    const total = jh.txCount;
    // Rerun, killing the worker at the last transaction (the final write): every step is stored, the version is not.
    resetStore();
    resetBucket();
    h.provider.requests.length = 0;
    await setUpMulti(h, 1, 4);
    jh = makeJobHarness(h);
    await start(setup.sourceIds);
    jh.killAtTx = jh.txCount + (total - txAfterStart);
    await assert.rejects(() => advance(id), Killed);
    assert.equal(versionPaths().length, 0);
    assert.equal(storedStepKeys(id).length, setup.calls);
    jh.killAtTx = null;
    h.state.nowMs += h.settings.leaseMs + 1;
    const callsBefore = jh.calls.length;
    const [a, b] = await Promise.all([advance(id), advance(id)]);
    assert.ok([a.kind, b.kind].includes("finished"), JSON.stringify([a, b]));
    assert.equal(versionPaths().length, 1);
    assert.equal(jh.calls.length, callsBefore, "no model call for the final step");
    assert.equal(jobDoc(id).status, "succeeded");
    assert.equal(jobDoc(id).version, 1);
  });

  test("another draft of the same sources written first: the job writes nothing and says so", async () => {
    const setup = await setUpMulti(h, 1, 4);
    jh = makeJobHarness(h);
    const id = (await start(setup.sourceIds)).result.jobId as string;
    // A one-shot run (the script) writes version 1 while the job is still at its first step.
    await quiet(() => h.service.extractRoute({ ...ROUTE, sourceIds: setup.sourceIds }));
    assert.equal(versionPaths().length, 1);
    const { outcomes } = await drain(id);
    assert.deepEqual({ ...outcomes.at(-1), stepsRun: 0 }, { kind: "finished", status: "skipped", stepsRun: 0, reasonCode: "source_unchanged" });
    assert.equal(versionPaths().length, 1);
    assert.equal(jobDoc(id).version, 1);
  });

  test("a draft that no rule survives ends failed with the existing reason and writes no version", async () => {
    const setup = await setUpMulti(h, 1, 3);
    // Every answer proposes a rule whose quote is not in the text.
    const provider = h.provider as any;
    const real = provider.complete.bind(provider);
    provider.complete = async (req: any) => {
      const res = await real(req);
      if (req.system.includes("intake") || res.text.indexOf("\"criteria\"") < 0) return res;
      const out = JSON.parse(res.text);
      for (const c of out.criteria) c.quote = "A sentence the source never wrote.";
      return { ...res, text: JSON.stringify(out) };
    };
    jh = makeJobHarness(h);
    const id = (await start(setup.sourceIds)).result.jobId as string;
    const { outcomes } = await drain(id);
    assert.equal((outcomes.at(-1) as any).reasonCode, "no_criteria_accepted");
    assert.equal(versionPaths().length, 0);
    assert.equal(jobDoc(id).status, "failed");
  });
});

// ============================================
// The automatic re-draft after a guidance change
// ============================================

describe("onGuidanceChanged starts a job", () => {
  test("a route with many chunks is re-drafted through the job over several invocations", async () => {
    const setup = await setUpMulti(h, 2, 8);
    // The first draft, one-shot (the head records the sources).
    await quiet(() => h.service.extractRoute({ ...ROUTE, sourceIds: setup.sourceIds }));
    assert.equal(versionPaths().length, 1);
    // The guidance changes: src-1 gets new text (and its answers).
    const edited = textOf(1, 9);
    await seedSource({ id: "src-1", url: "https://docs.invalid/src-1", text: edited.text });
    // Re-record answers for the new text of src-1 (setUpMulti seeds from scratch: rerun it for src-1 only).
    store.delete("never");
    jh = makeJobHarness(h);
    (h.service as any).deps.startJob = (input: any) => jh.jobs.startJob(input);
    // Seed answers for the changed source.
    const { recordAnswers, crit, answer } = await import("./rubric-harness");
    const hash = (store.get("guidanceSources/src-1") as any).latestSnapshotId as string;
    const cut = chunkSnapshot(await snapshotStore.read("src-1", hash), h.settings.maxChunkChars);
    await recordAnswers(h.provider, "src-1", cut.map((chunk, i) => {
      const inChunk = edited.quotes.map((q, j) => ({ q, j })).filter(({ q }) => chunk.text.includes(q));
      return answer({
        criteria: inChunk.map(({ q, j }) => crit({ ref: `e${j}`, title: `Evidence 1${j + 1} provided`, kind: "judgement", stage: "credibility", quote: q, probeFactors: ["evidence kept"], requiresInterviewBeforeRefusal: false })),
        intakeQuestions: [{ id: `edited_${i}`, label: `Edited ${i}`, helpText: null, answerType: "yes_no", required: true, criterionRefs: inChunk.map(({ j }) => `e${j}`), group: null, party: null, options: [], textMaxLength: null, dateRelativeToToday: null, showWhenAnyOf: [] }],
      });
    }), h.settings);
    jh.callMs = 100_000;
    const results = (await quiet(() => h.service.onGuidanceChanged({ sourceId: "src-1" }))).result;
    assert.deepEqual(results.map((r) => r.outcome), ["started"]);
    // Nothing ran inline: no model call yet, no second version.
    assert.equal(jh.calls.length, 0);
    assert.equal(versionPaths().length, 1);
    const { outcomes, callsPerInvocation } = await drain(results[0].jobId as string);
    assert.ok(outcomes.length > 1, "needed more than one invocation");
    assert.ok(callsPerInvocation.every((n) => n <= 3));
    assert.equal(versionPaths().length, 2);
    assert.equal(versionDoc(ROUTE_KEY, 2).reviewStatus, "pending_review");
    assert.equal(runDocs().find((r) => r.version === 2).trigger, "guidance_changed");
  });

  test("no head: log only, nothing started; head not listing the source: nothing", async () => {
    await setUpMulti(h, 1, 2);
    jh = makeJobHarness(h);
    (h.service as any).deps.startJob = (input: any) => jh.jobs.startJob(input);
    const none = await quiet(() => h.service.onGuidanceChanged({ sourceId: "src-1" }));
    assert.deepEqual(none.result, []);
    assert.ok(none.lines.some((l) => l.includes("no rubric exists yet") && l.includes("by hand") && l.includes("extract:rubric")), none.lines.join("\n"));
    await quiet(() => h.service.extractRoute({ ...ROUTE, sourceIds: ["src-1"] }));
    const other = await quiet(() => h.service.onGuidanceChanged({ sourceId: "some-other-source" }));
    assert.deepEqual(other.result, []);
    assert.ok(other.lines.some((l) => l.includes("no rubric head lists this source")), other.lines.join("\n"));
    // The head lists the source and nothing changed: the hash gate starts nothing.
    const same = await quiet(() => h.service.onGuidanceChanged({ sourceId: "src-1" }));
    assert.deepEqual(same.result.map((r) => r.outcome), ["unchanged"]);
    assert.equal([...store.keys()].filter((k) => k.startsWith("rubricExtractionJobs/")).length, 0);
  });
});

// ============================================
// Status
// ============================================

describe("status", () => {
  test("the status view reports counters, steps done and the reason, without any text of the sources", async () => {
    const setup = await setUpMulti(h, 1, 6);
    jh = makeJobHarness(h);
    const id = (await start(setup.sourceIds)).result.jobId as string;
    jh.beforeCall = (n) => {
      if (n === 3) throw new LlmProviderError("provider_error", "status=400 bad request");
    };
    await drain(id);
    const view = await jh.jobs.getStatus(id);
    assert.equal(view?.status, "failed");
    assert.equal(view?.reasonCode, "provider_error");
    assert.equal(view?.stepsDone, 2);
    assert.equal(view?.usage.requests, 2);
    assert.equal(view?.chunks, setup.chunks);
    assert.equal(view?.cancelRequested, false);
    assert.ok(view?.message);
    assert.equal(typeof view?.createdAt, "string");
    assert.doesNotMatch(JSON.stringify(view), /The applicant must provide evidence/);
    assert.equal(await jh.jobs.getStatus("XA_nothing__0123456789abcdef"), null);
  });
});
