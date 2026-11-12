import { Timestamp, type Transaction } from "firebase-admin/firestore";
import { collections, db } from "../../utils/firebase";
import type { NewsSource } from "../../types/news";
import {
  clearedAutoPause,
  DEFAULT_CONSECUTIVE_FAILURE_LIMIT,
  nextSourceHealth,
  type AutoPauseFields,
  type SourceRunOutcome,
} from "../shared/runs/source-health";

// ============================================
// NEWS SOURCE HEALTH — the per-run write on newsSources/{id} (issue #107)
// ============================================
//
// Moved out of services/news.service.ts (it was `updateSourceAfterScrape`)
// so the news scraper's auto-pause rules live in the scrapers module next to
// the visa crawler's, and both go through the ONE pure rule set in
// shared/runs/source-health.ts.
//
// What changed in #107:
//  - the auto-pause threshold is `news.consecutiveFailureLimit` (admin
//    setting, default 5) instead of a hard-coded 5;
//  - an auto-pause also writes `autoPaused`, `autoPausedAt`,
//    `autoPausedReason` (the last error) and `autoPauseCause`, so the health
//    rows and the `source_broken` alert can tell it from an admin pause;
//  - a success on a `broken` source (a single-source "Run now" retry)
//    returns it to `active` and clears those flags;
//  - an admin `paused` / `retired` status is never overwritten. The write is
//    a TRANSACTION (read + write), so an admin PATCH that lands while a crawl
//    is in flight is not undone by the crawl's write;
//  - counters are computed from the doc read in the transaction (no
//    FieldValue.increment needed any more).
// Missing-API-key pauses (cause `missing_api_key`) are written by
// pauseForMissingApiKey() below, not counted as failures.

/** What the per-run write decided (the orchestrator puts it on the run line). */
export interface NewsSourceHealthResult {
  status: string;
  consecutiveFailures: number;
  consecutiveFailureLimit: number;
  autoPaused: boolean;
  newlyAutoPaused: boolean;
}

/** Options of one per-run health write. */
export interface NewsSourceHealthWriteOptions {
  // `news.consecutiveFailureLimit` in force for this run (issue #107).
  failureLimit?: number;
  // Clock for the timestamps (tests); default Date.now.
  nowMs?: number;
  // Issue #17: the run's raw article count (`rawArticles.length`, before the
  // maxArticlesPerRun slice). Drives the zero-yield streak. Omitted = the
  // streak is left untouched (older callers / tests).
  articlesFound?: number;
}

/** The reason stored on a news_api source paused for a missing key. */
export const MISSING_API_KEY_REASON = "missing API key";

export class NewsSourceHealthService {
  /** Transaction runner (tests swap in the in-memory one). */
  runTransaction: <T>(fn: (tx: Transaction) => Promise<T>) => Promise<T> = (fn) => db.runTransaction(fn);

  /**
   * Record one scrape outcome on the source and schedule its next visit.
   * Returns what was written, or null when the source doc does not exist.
   *
   * @param sourceId     newsSources doc id
   * @param success      true = the scrape succeeded (streak resets)
   * @param errorMessage the redacted error of a failed scrape
   * @param notBeforeMs  epoch ms the next visit must not precede — the
   *   host's Retry-After time after a 429/503 (issue #76). The next visit is
   *   the LATER of `now + scrapeIntervalMinutes` and this. (Kept positional:
   *   same signature as the old newsService method.)
   * @param opts         see NewsSourceHealthWriteOptions
   */
  async updateSourceAfterScrape(
    sourceId: string,
    success: boolean,
    errorMessage?: string,
    notBeforeMs?: number,
    opts: NewsSourceHealthWriteOptions = {}
  ): Promise<NewsSourceHealthResult | null> {
    const ref = collections.newsSources.doc(sourceId);
    const nowMs = opts.nowMs ?? Date.now();
    const now = Timestamp.fromMillis(nowMs);
    const limit = opts.failureLimit ?? DEFAULT_CONSECUTIVE_FAILURE_LIMIT;
    return this.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return null;
      const source = snap.data() as NewsSource & Partial<AutoPauseFields>;

      // ---- Schedule: interval from now, never before Retry-After ----
      const intervalMs = (source.scrapeIntervalMinutes ?? 0) * 60 * 1000;
      const nextScrapeAt = Timestamp.fromMillis(Math.max(nowMs + intervalMs, notBeforeMs ?? 0));

      // ---- Run counters (computed from the transactional read) ----
      const totalRuns = (source.totalRuns ?? 0) + 1;
      const successfulRuns = (source.successfulRuns ?? 0) + (success ? 1 : 0);
      const outcome: SourceRunOutcome = success ? "success" : "failure";
      const health = nextSourceHealth(source, outcome, { limit, errorMessage, now });

      const updates: Record<string, unknown> = {
        lastScrapedAt: now,
        nextScrapeAt,
        totalRuns,
        successfulRuns,
        consecutiveFailures: health.consecutiveFailures,
        status: health.status,
        // Same maths as before #107: successfulRuns / totalRuns, as a percentage.
        reliabilityScore: Math.min(100, (successfulRuns / totalRuns) * 100),
        updatedAt: now,
        ...(health.autoPause ?? {}),
      };
      // ---- Issue #17: zero-yield streak ----
      // Signal is articlesFound, never articlesNew (an all-duplicates run is
      // healthy). Success + 0 found: streak +1 (zeroYieldSince set when it
      // starts). Success + found > 0: reset. A failed run, or a call without
      // articlesFound, leaves both fields alone (failures are source_broken's).
      if (success && opts.articlesFound !== undefined) {
        if (opts.articlesFound === 0) {
          const streak = (source.zeroYieldRuns ?? 0) + 1;
          updates.zeroYieldRuns = streak;
          if (streak === 1 || !source.zeroYieldSince) updates.zeroYieldSince = now;
        } else if ((source.zeroYieldRuns ?? 0) !== 0 || source.zeroYieldSince) {
          updates.zeroYieldRuns = 0;
          updates.zeroYieldSince = null;
        }
      }
      if (!success) {
        updates.lastErrorMessage = errorMessage ?? null;
        updates.lastErrorAt = now;
      }
      if (health.newlyAutoPaused) {
        console.warn(`Source ${source.name ?? sourceId} auto-paused after ${health.consecutiveFailures} consecutive failures (limit ${limit})`);
      }
      tx.update(ref, updates);
      return {
        status: health.status,
        consecutiveFailures: health.consecutiveFailures,
        consecutiveFailureLimit: limit,
        autoPaused: health.autoPaused,
        newlyAutoPaused: health.newlyAutoPaused,
      };
    });
  }

  /**
   * Issue #107: pause a `news_api` source whose provider key secret is not
   * set (`NEWS_API_KEY_<PROVIDER>` absent). Not a failure (no request was
   * made): the streak and run counters are left alone. Written only while
   * the source is still `active` or `broken`, so an admin pause / retire is
   * never touched. Returns true when it paused the source.
   *
   * Un-pausing is an admin step once the secret is set: `PATCH
   * /admin/scrape-sources/news/<id>` with `{ "resetFailures": true }` (or
   * `{ "status": "active" }`).
   */
  async pauseForMissingApiKey(sourceId: string, provider: string, nowMs: number = Date.now()): Promise<boolean> {
    const ref = collections.newsSources.doc(sourceId);
    const now = Timestamp.fromMillis(nowMs);
    return this.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return false;
      const status = (snap.data() as NewsSource).status;
      if (status !== "active" && status !== "broken") return false;
      tx.update(ref, {
        status: "paused",
        autoPaused: true,
        autoPausedAt: now,
        autoPausedReason: `${MISSING_API_KEY_REASON} (secret NEWS_API_KEY_${provider.toUpperCase()} is not set)`,
        autoPauseCause: "missing_api_key",
        updatedAt: now,
      });
      return true;
    });
  }
}

/** Re-exported so callers clearing the flags use the same shape. */
export { clearedAutoPause };

/** The Firestore-backed singleton (the scraper's default). */
export const newsSourceHealthService = new NewsSourceHealthService();
