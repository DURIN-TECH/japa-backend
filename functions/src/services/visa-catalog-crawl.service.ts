import { collections } from "../utils/firebase";
import { Timestamp } from "firebase-admin/firestore";
import { VisaSource, VisaSourcePage } from "../types/visa-catalog";
import { visaCatalogFetchService } from "./visa-catalog-fetch.service";
import { visaCatalogExtractor } from "./visa-catalog-extract.service";
import { visaCatalogService } from "./visa-catalog.service";

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
  errors: number;
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
      errors: 0,
    };

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
          const fetched = await visaCatalogFetchService.fetchAndClean(page.url, {
            checkRobots: true,
          });
          fetchedOk++;
          summary.pagesFetched++;

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
          const extracted = await visaCatalogExtractor.extract(fetched.cleanText, {
            url: page.url,
            countryName: source.countryName,
            routeName: page.routeName,
          });
          extractionsUsed++;
          pages[i] = { ...pages[i], lastExtractedAt: now };

          const { outcome } = await visaCatalogService.ingestExtraction({
            countryCode: source.countryCode,
            sourceUrl: page.url,
            routeName: page.routeName,
            contentHash: fetched.contentHash,
            extracted,
            model: visaCatalogExtractor.model,
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
