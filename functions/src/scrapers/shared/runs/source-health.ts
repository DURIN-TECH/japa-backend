import type { Timestamp } from "firebase-admin/firestore";

// ============================================
// SOURCE HEALTH — auto-pause rules shared by both scrapers (issue #107)
// ============================================
//
// Both scrapers count `consecutiveFailures` on the source doc (visaSources /
// newsSources). Before #107 each one set `status: "broken"` at a hard-coded
// 5 failures, the re-seed reset the counters, and nothing said WHY a source
// stopped. This module is the ONE place that decides what a run's outcome
// does to a source's status, so the visa and news crawlers cannot drift:
//
//   outcome  | stored status       | result
//   ---------+---------------------+------------------------------------------
//   success  | active              | failures -> 0, stays active
//   success  | broken (auto-pause) | failures -> 0, back to active, auto-pause
//            |                     | flags cleared (admin "Run now" recovery)
//   failure  | active / broken     | failures + 1; at >= limit -> broken with
//            |                     | autoPaused/autoPausedAt/autoPausedReason
//   deferred | any                 | nothing changes (visa "deferred only")
//   any      | paused / retired    | status NEVER changed (an admin or the
//            |                     | registry chose it); counters still move
//
// "Auto-paused" = status `broken` + `autoPaused: true`. `broken` is the
// crawler-only status: neither scheduled ticks nor a whole-scraper "Run now"
// select it (both due queries are `status == "active"`), only a single-source
// "Run now" does. That is how one dead source stops marking every run
// `partial`: it is not attempted, so it produces no error line.
//
// The limit is the admin setting `<kind>.consecutiveFailureLimit`
// (appConfig/scraperSettings, default 5 = the old constant). It is compared
// with the streak on each FAILED crawl only: lowering it below a source's
// streak pauses that source on its next failure; raising it never un-pauses
// anything (only a success, `resetFailures` or an admin status change does).

/** Default `consecutiveFailureLimit` (the hard-coded value before #107). */
export const DEFAULT_CONSECUTIVE_FAILURE_LIMIT = 5;

// ---- Infrastructure-error cap (issue #143, guidance crawl) ----
//
// An INFRASTRUCTURE error (our Cloud Storage / Firestore failed while handling
// a source) says nothing about the source, so it never moves the failure
// streak above and never turns a source `failing`. It does need a brake: a
// source that hits one on every run would otherwise be re-fetched from the
// publisher on every tick for as long as the outage lasts. After
// `DEFAULT_CONSECUTIVE_INFRA_ERROR_LIMIT` runs in a row that ended in an
// infrastructure error on the same source, the crawler stops requesting it
// until `DEFAULT_INFRA_BACKOFF_MS` has passed (or an admin retries it by id).

/** Consecutive runs with an infrastructure error on one source before it is backed off. */
export const DEFAULT_CONSECUTIVE_INFRA_ERROR_LIMIT = 3;

/** How long a capped source is left alone: 6 hours, in milliseconds. */
export const DEFAULT_INFRA_BACKOFF_MS = 6 * 60 * 60 * 1000;

/**
 * Why the crawler paused a source:
 *  - failure_limit: `consecutiveFailures` reached the limit (status `broken`);
 *  - missing_api_key: a `news_api` source whose provider key secret is not
 *    set (status `paused`, see news-scraper.service.ts). Not a failure: the
 *    source was never requested.
 */
export type AutoPauseCause = "failure_limit" | "missing_api_key";

/** The auto-pause fields the crawler writes on a source doc. */
export interface AutoPauseFields {
  autoPaused: boolean; // true while the crawler holds the source
  autoPausedAt: Timestamp | null; // when it was auto-paused (first time in this streak)
  autoPausedReason: string | null; // the last error (or "missing API key")
  autoPauseCause: AutoPauseCause | null;
}

/** The auto-pause field names (re-seeds keep them as crawl state). */
export const AUTO_PAUSE_FIELDS = ["autoPaused", "autoPausedAt", "autoPausedReason", "autoPauseCause"] as const;

/** Longest stored auto-pause reason (it is an error message, already redacted by the caller). */
export const MAX_AUTO_PAUSE_REASON_CHARS = 500;

/** What one crawl of one source amounted to. */
export type SourceRunOutcome = "success" | "failure" | "deferred";

/** The health fields read from the stored source doc. */
export interface StoredSourceHealth {
  status?: string;
  consecutiveFailures?: number;
  autoPaused?: boolean;
  autoPausedAt?: Timestamp | null;
}

/** The health fields to write back (status + streak + auto-pause flags). */
export interface NextSourceHealth {
  status: string;
  consecutiveFailures: number;
  // Fields to SET on the doc. Present only when the auto-pause state changes
  // (or its reason is refreshed); absent = leave the stored flags alone.
  autoPause?: AutoPauseFields;
  // True when THIS outcome auto-paused the source (it was not broken before).
  newlyAutoPaused: boolean;
  // True when the source is auto-paused after this outcome.
  autoPaused: boolean;
}

/** The cleared auto-pause block (a recovered / reset source). */
export function clearedAutoPause(): AutoPauseFields {
  return { autoPaused: false, autoPausedAt: null, autoPausedReason: null, autoPauseCause: null };
}

/**
 * Clamp a limit to a usable integer (>= 1). The settings store already
 * validates 1..50; this only guards direct callers (scripts, tests).
 */
export function effectiveFailureLimit(limit: number | undefined): number {
  return typeof limit === "number" && Number.isInteger(limit) && limit >= 1 ? limit : DEFAULT_CONSECUTIVE_FAILURE_LIMIT;
}

/**
 * Pure: the source's next status / streak / auto-pause flags after one run.
 * See the table at the top of this file.
 *
 * @param stored   the source doc as read (inside the write's transaction)
 * @param outcome  what this crawl amounted to
 * @param ctx.limit      `<kind>.consecutiveFailureLimit` in force
 * @param ctx.errorMessage the (redacted) error of a failed crawl
 * @param ctx.now        the timestamp to stamp on a new auto-pause
 */
export function nextSourceHealth(
  stored: StoredSourceHealth,
  outcome: SourceRunOutcome,
  ctx: { limit: number; errorMessage?: string; now: Timestamp }
): NextSourceHealth {
  const status = stored.status ?? "active";
  const failures = typeof stored.consecutiveFailures === "number" ? stored.consecutiveFailures : 0;
  const limit = effectiveFailureLimit(ctx.limit);
  const wasAutoPaused = status === "broken";
  // An admin (or the registry) chose paused / retired: the crawler never
  // changes that status, whatever the outcome. The counters still move so
  // the health row stays truthful.
  const heldByAdmin = status === "paused" || status === "retired";

  // ---- deferred: nothing was requested, nothing changes ----
  if (outcome === "deferred") {
    return { status, consecutiveFailures: failures, newlyAutoPaused: false, autoPaused: wasAutoPaused };
  }

  // ---- success: the streak resets; an auto-paused source recovers ----
  if (outcome === "success") {
    if (heldByAdmin) return { status, consecutiveFailures: 0, newlyAutoPaused: false, autoPaused: false };
    return {
      status: "active",
      consecutiveFailures: 0,
      // Only rewrite the flags when there is something to clear.
      ...(wasAutoPaused || stored.autoPaused ? { autoPause: clearedAutoPause() } : {}),
      newlyAutoPaused: false,
      autoPaused: false,
    };
  }

  // ---- failure: count it; pause at the limit ----
  const next = failures + 1;
  if (heldByAdmin) return { status, consecutiveFailures: next, newlyAutoPaused: false, autoPaused: false };
  if (next < limit) {
    // Below the limit: still active (a `broken` source retried by hand that
    // fails again stays broken: it is at/over the limit by definition, unless
    // the limit was raised meanwhile — raising never un-pauses).
    return wasAutoPaused
      ? { status: "broken", consecutiveFailures: next, newlyAutoPaused: false, autoPaused: true }
      : { status, consecutiveFailures: next, newlyAutoPaused: false, autoPaused: false };
  }
  const reason = (ctx.errorMessage ?? "").slice(0, MAX_AUTO_PAUSE_REASON_CHARS) || null;
  return {
    status: "broken",
    consecutiveFailures: next,
    autoPause: {
      autoPaused: true,
      // Keep the first auto-pause instant of this streak (a manual retry
      // that fails again does not move it).
      autoPausedAt: wasAutoPaused && stored.autoPausedAt ? stored.autoPausedAt : ctx.now,
      autoPausedReason: reason,
      autoPauseCause: "failure_limit",
    },
    newlyAutoPaused: !wasAutoPaused,
    autoPaused: true,
  };
}
