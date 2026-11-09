import { collections } from "../utils/firebase";
import { Timestamp } from "firebase-admin/firestore";
import { VisaSource, VisaSourcePage } from "../types/visa-catalog";
import { visaCatalogExtractor } from "./visa-catalog-extract.service";
import { visaCatalogService } from "./visa-catalog.service";
import type { FxFetcher } from "./visa-catalog-fx";
// Fetching goes through the source adapter picked from `source.adapter`
// (govuk-content-api for GB, generic-html — today's fetch service — otherwise).
import { pickSourceAdapter, sourceMetaFromDocument } from "./visa-source-adapters";

// ============================================
// VISA CATALOG — CRAWL ORCHESTRATOR (Step 5)
// ============================================
//
// Ties the pipeline together: pick DUE country sources, and for each page
// fetch → hash-gate → extract → stage. Mirrors the news orchestrator's shape
// (bounded batch per invocation, per-source health + rescheduling) so cost and
// runtime stay predictable.
//
// Cadence: each source is re-crawled every `crawlIntervalHours` (168 = weekly).
// The scheduled function ticks more often than weekly and processes only sources
// whose `nextCrawlAt` is due, so the 26 seeded countries self-stagger across the
// week instead of all firing at once.

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
  skipped: number; // seeded/agent/rejected/withdrawn visa left untouched
  // Approved scraped visa whose page changed: a pendingVisaChanges row was
  // written / replaced for an admin (issue #61). Not counted in `skipped`.
  proposed: number;
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
  }): Promise<CrawlSummary> {
    const maxSources = opts?.maxSources ?? DEFAULT_MAX_SOURCES;
    const maxExtractions = opts?.maxExtractions ?? DEFAULT_MAX_EXTRACTIONS;

    const now = Timestamp.now();
    const summary: CrawlSummary = {
      sourcesProcessed: 0,
      pagesFetched: 0,
      pagesChanged: 0,
      created: 0,
      updated: 0,
      skipped: 0,
      proposed: 0,
      withdrawn: 0,
      errors: 0,
      fxRefreshed: false,
      feesReconverted: 0,
    };

    // ---- FX: refresh appConfig/fx ONCE per run, before any extraction ----
    // Never throws: on failure the previous doc is kept and used if still
    // within FX_MAX_AGE_DAYS. Then re-convert pending scraped visas whose fee
    // was flagged stale/missing, from their stored components (no LLM call).
    const fxRefresh = await visaCatalogService.refreshFx(opts?.fetchFxRates);
    const fx = fxRefresh.fx;
    summary.fxRefreshed = fxRefresh.refreshed;
    try {
      summary.feesReconverted = (await visaCatalogService.reconvertFlaggedFees(fx)).reconverted;
    } catch (err) {
      // A failed re-convert must not abort the crawl; it retries next run.
      console.error("Visa catalog: re-converting flagged fees failed:", err);
    }

    // Due = active AND nextCrawlAt <= now, oldest first (needs the composite
    // index status+nextCrawlAt — added to firestore.indexes.json).
    const dueSnap = await collections.visaSources
      .where("status", "==", "active")
      .where("nextCrawlAt", "<=", now)
      .orderBy("nextCrawlAt", "asc")
      .limit(maxSources)
      .get();

    let extractionsUsed = 0;

    for (const doc of dueSnap.docs) {
      const source = doc.data() as VisaSource;
      const runStart = Timestamp.now();
      const pages: VisaSourcePage[] = [...source.pages];
      let fetchedOk = 0;
      let pageErrors = 0;
      let ingested = 0;

      for (let i = 0; i < pages.length; i++) {
        // Respect the per-run extraction cap; remaining pages are picked up next
        // tick (their hash is unchanged so they re-check cheaply).
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
          else if (outcome === "proposed") summary.proposed++;
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
      const nextCrawlAt = Timestamp.fromMillis(
        now.toMillis() + source.crawlIntervalHours * 60 * 60 * 1000
      );

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
        startedAt: runStart,
        completedAt: Timestamp.now(),
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
