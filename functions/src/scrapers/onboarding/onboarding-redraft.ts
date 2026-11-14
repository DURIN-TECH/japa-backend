import type { Timestamp } from "firebase-admin/firestore";
import type { JobView, StartJobResult } from "../rubric/rubric-extraction-job";
import { isTerminalRun, type RunStatus } from "./onboarding-types";

// ============================================
// THE AUTOMATIC RE-DRAFT DEFERS TO AN ONBOARDING RUN (issue #225)
// ============================================
//
// The problem. When a route already has a rulebook, the Firestore trigger
// `onGuidanceSourceChanged` starts a PAID re-draft (a drafting job) whenever a
// guidance source's stored text changes. An onboarding run reads the route's
// pages again in its `read_rule_pages` step, so without this file the trigger
// could start spending before the admin confirmed the run's estimate.
//
// The decision (made on the issue): while a run for the route is ACTIVE (any
// status before it is published, held, too thin, failed or cancelled), the
// trigger does nothing and records why; the run drafts after the admin
// confirms. With no active run, behaviour is unchanged.
//
// ---- the three guarantees, and how each is kept ----
//
// 1. NO SPEND BEFORE CONFIRMATION. The trigger asks the route's onboarding head
//    (`routeOnboardingRoutes/{routeKey}`) first, in a TRANSACTION that reads the
//    head and its active run. An active run means "defer": the trigger records
//    the deferral on the head and starts nothing.
//
// 2. NO RACE WITH A RUN THAT IS BEING CREATED. A run is created by `start()` in
//    a transaction that reads and writes the SAME head document, so the two
//    transactions are serialised by Firestore:
//      - the run committed first: the trigger's transaction sees it and defers;
//      - the trigger committed first: it left a CLAIM on the head (an id with
//        an expiry, `redraftClaims`) for the few seconds its `startJob` takes
//        (planning the job pins the snapshots it will read). The run's
//        `read_rule_pages` step does not crawl while any claim is live, so the
//        run's own crawl can never change a page under a job the trigger is
//        pinning. Once the run exists, no new claim can be taken (an active
//        run always means "defer"), so the check before each crawl is enough.
//      A claim whose holder died simply expires (`redraftClaimMs`).
//
// 3. A CHANGE IS NOT LOST, AND NOT PAID FOR TWICE. A deferral stays on the head
//    (`deferredRedraft`, flag `redraftDeferredPending`) until a re-draft for
//    the route is SETTLED. When the run ends (any final status) the service
//    re-evaluates it through the SAME guarded path as the trigger (so a new run
//    opened meanwhile defers it again), with the SAME input the trigger uses.
//    The drafting job's own hash gate and deterministic job id then decide:
//      - the run drafted those pages (published / held): `unchanged` or
//        `existing`, nothing new is started, nothing is paid twice;
//      - the run failed or was cancelled before drafting, or the pages moved on
//        again during the run: the normal re-draft starts, exactly as the
//        trigger would have started it;
//      - the run's job is still being cancelled (`existing` but cancel
//        requested): not settled; the 5-minute onboarding sweep tries again
//        until the job has stopped, and then the start queues it again.
//    The deferral is cleared only when the settle saw the SAME deferral
//    (`seq`), so a deferral recorded while a settle was in flight is kept.
//
// Nothing here names a country, route or publisher. Logging: ids and codes only.

/** One deferral of the automatic re-draft, kept on the onboarding head until settled. */
export interface DeferredRedraft {
  // The route, as the trigger would start it (the rulebook head's ids).
  countryCode: string;
  visaTypeId: string;
  // The changed sources the trigger saw while the run was active (deduplicated, in arrival order).
  sourceIds: string[];
  // The active run the trigger deferred to (the latest one, when several runs came and went).
  runId: string;
  // When the first and the latest deferral were recorded.
  firstAt: Timestamp;
  lastAt: Timestamp;
  // Bumped on every deferral: a settle clears the record only if it is still the one it read.
  seq: number;
  // Plain words for the admin and the logs.
  reason: string;
}

/** The fields this feature adds to `routeOnboardingRoutes/{routeKey}` (all optional: older heads lack them). */
export interface RedraftHeadFields {
  // Live claims of a trigger (or a settle) that is starting a drafting job: claim id -> expiry.
  redraftClaims?: Record<string, Timestamp>;
  // The deferral waiting to be settled, or null.
  deferredRedraft?: DeferredRedraft | null;
  // Top-level copy of "a deferral is waiting", so the sweep can query it with one equality filter.
  redraftDeferredPending?: boolean;
}

/** What the guarded re-draft did. */
export type GuardedRedraftOutcome =
  // An onboarding run for the route is active: nothing was started (the deferral is recorded).
  | { kind: "deferred"; runId: string; status: RunStatus }
  // No run was active: the normal start ran; `settled` says whether a pending deferral was cleared by it.
  | { kind: "ran"; result: StartJobResult; settled: boolean };

/** The input of one guarded re-draft. */
export interface GuardedRedraftInput {
  routeKey: string;
  countryCode: string;
  visaTypeId: string;
  // The changed source (the trigger), or null for the re-evaluation after a run ended.
  sourceId: string | null;
}

/**
 * The guard the rubric extraction's `onGuidanceChanged` goes through. Kept as a
 * narrow interface so the extraction module does not import the onboarding
 * service at load time (that would be an import cycle).
 */
export interface RedraftGuard {
  guardedRedraft(input: GuardedRedraftInput, start: () => Promise<StartJobResult>): Promise<GuardedRedraftOutcome>;
}

/** The reason code of a trigger result that deferred (a `refused` result with this code: nothing was started). */
export const DEFERRED_REASON_CODE = "onboarding_run_active";
/** The reason code when the guard itself could not be read: fail CLOSED (money), nothing was started. */
export const GUARD_UNAVAILABLE_REASON_CODE = "redraft_guard_unavailable";

// ---------- pure decisions (unit-tested without any database) ----------

/** True when a run blocks the automatic re-draft: it exists and has not reached a final status. */
export function runBlocksRedraft(run: { status: RunStatus } | null | undefined): boolean {
  return !!run && !isTerminalRun(run.status);
}

/** The claims that have not expired at `nowMs` (the expired ones are dropped on the next write). */
export function liveClaims(claims: Record<string, Timestamp> | undefined | null, nowMs: number): Record<string, Timestamp> {
  const out: Record<string, Timestamp> = {};
  for (const [id, until] of Object.entries(claims ?? {})) {
    if (until && until.toMillis() > nowMs) out[id] = until;
  }
  return out;
}

/** True while some trigger is starting a drafting job for the route (the run must not crawl yet). */
export function hasLiveClaim(claims: Record<string, Timestamp> | undefined | null, nowMs: number): boolean {
  return Object.keys(liveClaims(claims, nowMs)).length > 0;
}

/** The deferral after one more deferred change (a new record, or the previous one extended). */
export function mergeDeferral(
  prev: DeferredRedraft | null | undefined,
  input: { countryCode: string; visaTypeId: string; sourceId: string | null; runId: string },
  now: Timestamp
): DeferredRedraft {
  const sourceIds = [...(prev?.sourceIds ?? [])];
  if (input.sourceId && !sourceIds.includes(input.sourceId)) sourceIds.push(input.sourceId);
  return {
    countryCode: input.countryCode,
    visaTypeId: input.visaTypeId,
    sourceIds,
    runId: input.runId,
    firstAt: prev?.firstAt ?? now,
    lastAt: now,
    seq: (prev?.seq ?? 0) + 1,
    reason: `An onboarding run (${input.runId}) is active for this route, so the automatic re-draft after a page change waits: the run drafts after an admin confirms its estimate. If the run ends without covering the change, the re-draft starts then.`,
  };
}

/** Refusals that may clear by themselves: a deferral that met one stays pending, and the sweep tries again. */
const TRANSIENT_REFUSALS = new Set(["settings_unavailable", "unexpected_error", "daily_cap_reached"]);

/**
 * Whether a start result SETTLES a pending deferral, i.e. the change is now
 * either drafted, being drafted, or refused for a reason that will not clear by
 * itself (exactly what the trigger would have ended with). `job` is the status
 * of the job an `existing` result points at (read by the caller).
 */
export function isSettled(result: StartJobResult, job: Pick<JobView, "status" | "cancelRequested"> | null): boolean {
  switch (result.outcome) {
  case "started":
  case "restarted":
  case "unchanged":
    return true;
  case "existing":
    // A job for these exact inputs exists. It covers the change only if it is
    // not on its way out: a job whose cancel was requested (the cancelled run's
    // own job) will stop, so the change would be lost; try again once it has.
    return !!job && !job.cancelRequested && (job.status === "queued" || job.status === "running" || job.status === "succeeded");
  case "refused":
    return !TRANSIENT_REFUSALS.has(result.reasonCode ?? "");
  default:
    // `dry_run` never comes from a real start; treat anything else as not settled (safe: retried).
    return false;
  }
}

/** A trigger result that says "deferred to the onboarding run" (the trigger's results are StartJobResults). */
export function deferredResult(routeKey: string, runId: string, status: RunStatus): StartJobResult {
  return {
    routeKey,
    outcome: "refused",
    jobId: null,
    jobStatus: null,
    reasonCode: DEFERRED_REASON_CODE,
    message: `onboarding run ${runId} is ${status}; the re-draft waits for it (it drafts after an admin confirms; if it ends without covering the change, the re-draft starts then)`,
    plan: [],
    estimate: null,
  };
}
