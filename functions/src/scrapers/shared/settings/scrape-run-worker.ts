import { Timestamp, type Transaction } from "firebase-admin/firestore";
import { collections, db } from "../../../utils/firebase";
import { safeErrorMessage } from "../runs/scrape-run.service";
import { visaCatalogCrawlService } from "../../visa-catalog/visa-catalog-crawl.service";
import { newsScraperService } from "../../news/news-scraper.service";
import { loadScraperSettings } from "./scraper-settings.store";
import type { ScrapeRunLockDoc, ScrapeRunRequestDoc, ScrapeRunRequestStatus, ScraperSettings } from "./types";

// ============================================
// MANUAL "RUN NOW" — the worker (issue #96)
// ============================================
//
// Called by the Firestore onCreate function `processScrapeRunRequest`
// (src/index.ts) for each new `scrapeRunRequests/{id}` doc. Steps:
//
//   1. claim: queued -> running, in a transaction. Anything else (a
//      duplicate event delivery, a request already handled) -> do nothing,
//      so one request never runs twice;
//   2. re-read the settings: scraper off + blockManualWhenOff -> `skipped`
//      (the switch may have flipped since the API accepted the request);
//   3. run the NORMAL orchestrator with trigger "manual":
//        visa, one source   -> runOrchestrator({ sourceId, force })
//        visa, whole scraper -> runOrchestrator({ ignoreWindow: true, force })
//        news, one source   -> runOrchestrator({ sourceId })
//        news, whole scraper -> runOrchestrator() (due batch; news has no windows)
//      The orchestrator writes its own scrapeRuns record (#81) and calls
//      onRunStarted with its id, which is stored on the request at once.
//      Robots.txt, host backoff (#64), maxExtractionsPerRun and the budget
//      hard stop all apply as on a scheduled tick; only the window (and,
//      for one source, the due check) is skipped;
//   4. finish: succeeded (with the run summary) / skipped (no run started:
//      nothing due, source no longer active) / failed (the orchestrator
//      threw), and release the lock (if it still points at this request).

/** Injectable dependencies (tests swap them; defaults are the real singletons). */
export interface ScrapeRunWorkerDeps {
  visa: Pick<typeof visaCatalogCrawlService, "runOrchestrator">;
  news: Pick<typeof newsScraperService, "runOrchestrator">;
  loadSettings: () => Promise<ScraperSettings>;
}

export class ScrapeRunWorker {
  /** Transaction runner. Swapped for the in-memory one in tests. */
  runTransaction: <T>(fn: (tx: Transaction) => Promise<T>) => Promise<T> = (fn) => db.runTransaction(fn);

  /** Clock (ms). Swappable in tests. */
  clock: () => number = Date.now;

  /**
   * Orchestrators + settings loader. Tests set this; undefined = the real
   * singletons, resolved at CALL time (see deps()). Reading
   * visaCatalogCrawlService at construction would touch the binding while
   * scrapers/index.ts's import cycle is still loading (see its header).
   */
  overrides?: Partial<ScrapeRunWorkerDeps>;

  /** The dependencies in force for this call. */
  private deps(): ScrapeRunWorkerDeps {
    return {
      visa: this.overrides?.visa ?? visaCatalogCrawlService,
      news: this.overrides?.news ?? newsScraperService,
      loadSettings: this.overrides?.loadSettings ?? loadScraperSettings,
    };
  }

  /**
   * Process one request. Never throws (the trigger would only log it, and
   * a gen1 onCreate without retries would not run it again anyway): every
   * outcome is written on the request doc. Returns the final status, or
   * null when the request was not claimed (missing / not queued).
   */
  async process(requestId: string): Promise<ScrapeRunRequestStatus | null> {
    const ref = collections.scrapeRunRequests.doc(requestId);

    // ---- 1. Claim (queued -> running) ----
    let request: ScrapeRunRequestDoc | null;
    try {
      request = await this.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        if (!snap.exists) return null;
        const doc = snap.data() as ScrapeRunRequestDoc;
        if (doc.status !== "queued") return null; // duplicate delivery / already handled
        tx.update(ref, { status: "running", startedAt: Timestamp.fromMillis(this.clock()) });
        return doc;
      });
    } catch (err) {
      console.error(`Scrape run request ${requestId}: claim failed: ${safeErrorMessage(err)}`);
      return null;
    }
    if (!request) {
      console.log(`Scrape run request ${requestId}: not queued (missing or already handled), ignored`);
      return null;
    }

    // ---- 2 + 3. Settings, then the orchestrator ----
    let status: ScrapeRunRequestStatus;
    const result: Record<string, unknown> = {};
    try {
      const deps = this.deps();
      const settings = await deps.loadSettings();
      const sw = settings[request.kind];
      if (!sw.enabled && sw.blockManualWhenOff) {
        status = "skipped";
        result.skipReason = `the ${request.kind} scraper is switched off and manual runs are blocked`;
      } else {
        let runId: string | null = null;
        // Store the run id as soon as the run doc exists (the portal polls it).
        const onRunStarted = async (id: string) => {
          runId = id;
          await ref.update({ runId: id });
        };
        const sourceId = request.scope === "source" && request.sourceId ? request.sourceId : undefined;
        const summary =
          request.kind === "visa"
            ? await deps.visa.runOrchestrator({
              trigger: "manual",
              settings,
              sourceId,
              ignoreWindow: sourceId === undefined ? true : undefined,
              force: request.force || undefined,
              onRunStarted,
            })
            : await deps.news.runOrchestrator({ trigger: "manual", settings, sourceId, onRunStarted });
        result.summary = { ...summary };
        if (runId === null) {
          // The orchestrator found nothing to run, so it wrote no run doc.
          status = "skipped";
          result.skipReason = sourceId
            ? "the source is no longer active (paused, retired or deleted)"
            : "nothing due";
        } else {
          status = "succeeded";
        }
      }
    } catch (err) {
      status = "failed";
      result.error = safeErrorMessage(err);
      console.error(`Scrape run request ${requestId}: run failed: ${result.error}`);
    }

    // ---- 4. Finish + release the lock ----
    try {
      await this.runTransaction(async (tx) => {
        const lockRef = collections.scrapeRunLocks.doc(request!.lockId);
        const lockSnap = await tx.get(lockRef);
        tx.update(ref, {
          status,
          finishedAt: Timestamp.fromMillis(this.clock()),
          summary: (result.summary as Record<string, number | boolean> | undefined) ?? null,
          skipReason: (result.skipReason as string | undefined) ?? null,
          error: (result.error as string | undefined) ?? null,
        });
        // Only release a lock that still points at THIS request (a newer one
        // may have taken over after this request was judged stale).
        const lock = lockSnap.exists ? (lockSnap.data() as ScrapeRunLockDoc) : undefined;
        if (lock?.activeRequestId === requestId) tx.update(lockRef, { activeRequestId: null, activeSince: null });
      });
    } catch (err) {
      // The lock then frees itself after STALE_REQUEST_MS.
      console.error(`Scrape run request ${requestId}: finishing failed: ${safeErrorMessage(err)}`);
    }
    console.log(`Scrape run request ${requestId} (${request.kind} ${request.sourceId ?? "all"}): ${status}`);
    return status;
  }
}

export const scrapeRunWorker = new ScrapeRunWorker();
