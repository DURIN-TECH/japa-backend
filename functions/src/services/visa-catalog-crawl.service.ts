import { collections } from "../utils/firebase";
import { Timestamp } from "firebase-admin/firestore";
import { VisaSource, VisaSourcePage } from "../types/visa-catalog";
import { visaCatalogExtractor } from "./visa-catalog-extract.service";
import { visaCatalogService } from "./visa-catalog.service";
import type { FxFetcher } from "./visa-catalog-fx";
// Fetching goes through the source adapter picked from `source.adapter`
// (govuk-content-api for GB, generic-html — today's fetch service — otherwise).
import { pickSourceAdapter, sourceMetaFromDocument } from "./visa-source-adapters";
// Pure weekly-night-window helpers (issue #63): which due sources may run on
// this tick, and when each runs next.
import { isInCrawlWindow, nextWindowOpening } from "./visa-crawl-window";

// ============================================
// VISA CATALOG — CRAWL ORCHESTRATOR (Step 5)
// ============================================
//
// Ties the pipeline together: pick DUE country sources, and for each page
// fetch → hash-gate → extract → stage. Mirrors the news orchestrator's shape
// (bounded batch per invocation, per-source health + rescheduling) so cost and
// runtime stay predictable.
//
// Cadence (issue #63): the scheduled function ticks HOURLY at :15 UTC. Each
// source with a `crawlWindow` is crawled once a week, on its own local night
// (e.g. GB: Monday 02:00-05:00 Europe/London -> ticks 02:15, 03:15, 04:15).
// A source runs on a tick only when it is due (`nextCrawlAt <= now`) AND the
// tick is inside its local window; after the run `nextCrawlAt` is set to the
// window's next opening (next week, on the local grid, so no drift).
//
// Catch-up rule (no extra state): a source stays due until it runs. Skipped
// on one tick (maxSources cap, outage) -> picked up on a later tick of the
// same night. Whole night missed -> stays due but filtered out until next
// week's window (never run mid-week). It never runs twice in one night: a
// successful OR failed run moves `nextCrawlAt` to next week.
//
// A source WITHOUT a `crawlWindow` keeps the legacy behaviour: no window
// filter, re-crawled every `crawlIntervalHours` (`now + interval`).

// Recorded as the page's lastError when the source says the page is withdrawn
// (whether or not a scraped doc was deactivated), so it shows in source health.
export const WITHDRAWN_PAGE_ERROR = "Withdrawn on GOV.UK";

// Safety bounds per invocation — keep any single run cheap + within the function
// timeout even on the first pass when every source is due.
const DEFAULT_MAX_SOURCES = 3; // countries per run
const DEFAULT_MAX_EXTRACTIONS = 15; // LLM calls per run (cost cap)

export interface CrawlSummary {
  sourcesProcessed: number;
  pagesFetched: number;
  pagesChanged: number; // content hash differed → sent to extraction
  created: number; // new pending-review scraped visas written
  updated: number; // existing pending scraped visas refreshed
  skipped: number; // existing approved/agent visa left untouched
  withdrawn: number; // source said withdrawn → no extraction (scraped doc deactivated if present)
  errors: number;
  // FX (issue #59): whether appConfig/fx was refreshed this run, and how many
  // flagged pending visas were re-converted (cost written) from stored fee
  // components with no LLM call.
  fxRefreshed: boolean;
  feesReconverted: number;
}

class VisaCatalogCrawlService {
  /**
   * Process a bounded batch of due sources. Returns a run summary. Never throws
   * on per-page failures — those are recorded against the page/source so a bad
   * page can't abort the whole run.
   */
  async runOrchestrator(opts?: {
    maxSources?: number;
    maxExtractions?: number;
    // Injectable FX fetcher (tests / manual runs); defaults to Frankfurter.
    fetchFxRates?: FxFetcher;
    // Injectable "tick time" (tests / emulator checks), like fetchFxRates.
    // Drives the due query, the window filter, nextCrawlAt and the crawl
    // timestamps. Defaults to the real clock.
    now?: Date | number;
  }): Promise<CrawlSummary> {
    const maxSources = opts?.maxSources ?? DEFAULT_MAX_SOURCES;
    const maxExtractions = opts?.maxExtractions ?? DEFAULT_MAX_EXTRACTIONS;

    // The tick's instant. Every scheduling decision AND every timestamp
    // written below (lastCrawledAt, page crawl times, updatedAt, the
    // crawlRuns log) is on THIS clock, not the run's end time, so a long run
    // never shifts the weekly grid and an injected `now` is consistent.
    const now =
      opts?.now === undefined
        ? Timestamp.now()
        : Timestamp.fromMillis(typeof opts.now === "number" ? opts.now : opts.now.getTime());
    const summary: CrawlSummary = {
      sourcesProcessed: 0,
      pagesFetched: 0,
      pagesChanged: 0,
      created: 0,
      updated: 0,
      skipped: 0,
      withdrawn: 0,
      errors: 0,
      fxRefreshed: false,
      feesReconverted: 0,
    };

    // Due = active AND nextCrawlAt <= now, oldest first (needs the composite
    // index status+nextCrawlAt — already in firestore.indexes.json).
    // DO NOT add a plain .limit() back here to bound reads: it is applied
    // before the in-code window filter, so due-but-out-of-window sources
    // (missed nights sort first) would fill it and starve the in-window ones.
    // If the registry grows past a handful of docs, query on a STORED window
    // key instead (e.g. a denormalised `crawlWindowDay` / UTC opening field
    // in the where clause) so the limit applies after the window filter —
    // see the Cloud Tasks fan-out, #13.
    // NO .limit() here (issue #63): a limit applied BEFORE the window filter
    // would let due-but-out-of-window sources (e.g. a missed night, oldest
    // nextCrawlAt) fill the batch and starve the in-window ones. The registry
    // is a handful of docs (26), so reading all due ones is cheap.
    // ("broken" / "paused" sources never match the status filter.)
    const dueSnap = await collections.visaSources
      .where("status", "==", "active")
      .where("nextCrawlAt", "<=", now)
      .orderBy("nextCrawlAt", "asc")
      .get();

    // ---- Window filter, THEN the per-run cap ----
    // Keep a due source if the tick is inside its local window, or if it has
    // no window (legacy). An out-of-window source is left completely
    // untouched: no fetch, no write, its nextCrawlAt unchanged — so it is
    // still due when its window opens. A stored window that fails validation
    // (should never happen: the seed validates) is logged and skipped rather
    // than aborting the tick for every other source.
    const runnable = dueSnap.docs
      .filter((doc) => {
        const source = doc.data() as VisaSource;
        if (!source.crawlWindow) return true;
        try {
          return isInCrawlWindow(source.crawlWindow, now.toMillis());
        } catch (err) {
          console.error(`Visa catalog: source ${doc.id} has an invalid crawlWindow, skipped:`, err);
          return false;
        }
      })
      .slice(0, maxSources);

    // Nothing to crawl on this tick (the common case: most hourly ticks fall
    // outside every window) -> stop here, BEFORE any FX work: no Frankfurter
    // call and no pending-visa scan. fxRefreshed stays false. FX freshness is
    // not at risk: every night of the week has sources, so a refresh happens
    // at least daily, well within FX_MAX_AGE_DAYS (7).
    if (runnable.length === 0) return summary;

    // ---- FX: refresh appConfig/fx ONCE per run, before any extraction ----
    // Only on a tick that crawls something. Never throws: on failure the
    // previous doc is kept and used if still within FX_MAX_AGE_DAYS. Then
    // re-convert pending scraped visas whose fee was flagged stale/missing,
    // from their stored components (no LLM call).
    const fxRefresh = await visaCatalogService.refreshFx(opts?.fetchFxRates);
    const fx = fxRefresh.fx;
    summary.fxRefreshed = fxRefresh.refreshed;
    try {
      summary.feesReconverted = (await visaCatalogService.reconvertFlaggedFees(fx)).reconverted;
    } catch (err) {
      // A failed re-convert must not abort the crawl; it retries next run.
      console.error("Visa catalog: re-converting flagged fees failed:", err);
    }

    // Running count of LLM calls this tick, against maxExtractions.
    let extractionsUsed = 0;

    for (const doc of runnable) {
      const source = doc.data() as VisaSource;
      // Real clock, only to measure this source's run duration for the log;
      // the logged times themselves are on the tick clock (`now`).
      const runStartReal = Date.now();
      const pages: VisaSourcePage[] = [...source.pages];
      let fetchedOk = 0;
      let pageErrors = 0;
      let ingested = 0;

      for (let i = 0; i < pages.length; i++) {
        // Respect the per-run extraction cap. The source is still rescheduled
        // below, so its remaining pages are picked up at its NEXT window
        // (their stored hash is unchanged, so they re-extract then).
        if (extractionsUsed >= maxExtractions) break;

        const page = pages[i];
        try {
          // ---- Resolve the record id FIRST (registry-owned identity) ----
          // From the page's pinned `visaId`, else its URL path — never from
          // extraction output, so it can be known before any LLM call. Doing it
          // before the fetch means a page whose id can't be derived (e.g. KR's
          // `https://www.visa.go.kr/?LANG_TYPE=EN`: empty path) throws here and
          // is recorded as a page error by the catch below WITHOUT spending a
          // fetch, an LLM call or a maxExtractions slot. (Resolving after the
          // fetch would also store its content hash, so the next crawl's hash
          // gate would skip the page and silently clear the error.)
          const visaId = visaCatalogService.buildVisaId(source.countryCode, page.url, {
            visaId: page.visaId,
          });

          // ---- Fetch via the source's adapter ----
          // Throws on robots block / HTTP error / bad payload / nothing
          // selected → recorded as a page error below, no extraction.
          const adapter = pickSourceAdapter(source.adapter, page.url);
          const fetched = await adapter.fetch(page);
          fetchedOk++;
          summary.pagesFetched++;

          // ---- Withdrawn at source: never extract ----
          // No LLM call and no maxExtractions slot. A SCRAPED doc at the
          // resolved id is deactivated (isActive:false + staleSince set once);
          // seeded/agent docs are untouched; nothing is created. The stored
          // content hash is left as it was. No auto-reactivation if the guide
          // returns later (see VisaCatalogService.markWithdrawn).
          if (fetched.withdrawn) {
            await visaCatalogService.markWithdrawn(source.countryCode, visaId);
            summary.withdrawn++;
            pages[i] = { ...page, lastCrawledAt: now, lastError: WITHDRAWN_PAGE_ERROR };
            continue;
          }

          // Hash is over the exact text the extractor would see (selected +
          // capped sections for GOV.UK; the cleaned page for generic-html).
          const changed = fetched.contentHash !== page.lastContentHash;
          // Record crawl metadata regardless of change.
          pages[i] = {
            ...page,
            lastContentHash: fetched.contentHash,
            lastCrawledAt: now,
            lastError: undefined,
          };
          if (!changed) continue; // hash gate — nothing new, skip the LLM

          summary.pagesChanged++;
          // Count the LLM call BEFORE making it: a failed call (API error,
          // validation error) costs money too and must use up a
          // maxExtractions slot, or a systematic failure could exceed the cap.
          extractionsUsed++;
          const extracted = await visaCatalogExtractor.extract(fetched.text, {
            url: page.url,
            countryName: source.countryName,
            routeName: page.routeName,
          });
          pages[i] = { ...pages[i], lastExtractedAt: now };

          const { outcome } = await visaCatalogService.ingestExtraction({
            countryCode: source.countryCode,
            sourceUrl: page.url,
            routeName: page.routeName,
            contentHash: fetched.contentHash,
            extracted,
            model: visaCatalogExtractor.model,
            // Registry-owned identity: the id resolved above (used verbatim by
            // ingest, not recomputed) + the pinned code, if any.
            visaId,
            visaCode: page.visaCode,
            // Adapter provenance (provider, content_id, updated_at, sections, truncated).
            sourceMeta: sourceMetaFromDocument(fetched),
            // This run's rate doc: fee converted in code (issue #59).
            fx,
          });
          if (outcome === "created") summary.created++;
          else if (outcome === "updated") summary.updated++;
          else if (outcome === "skipped") summary.skipped++;
          if (outcome !== "unchanged") ingested++;
        } catch (err) {
          pageErrors++;
          summary.errors++;
          pages[i] = {
            ...page,
            lastCrawledAt: now,
            lastError: (err as Error).message?.slice(0, 300),
          };
        }
      }

      // ---- Source health + reschedule ----
      // A source "succeeds" this run if at least one page fetched. Consecutive
      // whole-source failures auto-pause it at 5 (self-healing, like news).
      const anySuccess = fetchedOk > 0;
      const consecutiveFailures = anySuccess ? 0 : (source.consecutiveFailures || 0) + 1;
      const status = consecutiveFailures >= 5 ? "broken" : "active";
      // Simple reliability signal: this run's fetch success ratio.
      const attempted = fetchedOk + pageErrors;
      const reliabilityScore = attempted > 0 ? Math.round((fetchedOk / attempted) * 100) : source.reliabilityScore;
      // Reschedule (success OR failure, so a source never runs twice in one
      // night): with a window -> its next opening strictly after this tick
      // (next week's local startHour; DST-correct; no drift however long the
      // run took, since it is computed from the tick's `now`). Without a
      // window -> legacy `now + crawlIntervalHours`.
      const nextCrawlAt = source.crawlWindow
        ? Timestamp.fromDate(nextWindowOpening(source.crawlWindow, now.toMillis()))
        : Timestamp.fromMillis(now.toMillis() + source.crawlIntervalHours * 60 * 60 * 1000);

      await doc.ref.update({
        pages,
        lastCrawledAt: now,
        nextCrawlAt,
        consecutiveFailures,
        status,
        reliabilityScore,
        updatedAt: now,
      });

      // Per-run log (subcollection) for observability + admin debugging.
      await doc.ref.collection("crawlRuns").add({
        // Tick clock: startedAt = the tick's `now`; completedAt = `now` plus
        // the real elapsed time, so the log keeps the run's duration while
        // staying consistent with an injected `now` (tests / emulator runs).
        startedAt: now,
        completedAt: Timestamp.fromMillis(now.toMillis() + (Date.now() - runStartReal)),
        pagesFetched: fetchedOk,
        pageErrors,
        visasIngested: ingested,
        status,
      });

      summary.sourcesProcessed++;
    }

    return summary;
  }
}

export const visaCatalogCrawlService = new VisaCatalogCrawlService();
