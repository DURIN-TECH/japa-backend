import { collections } from "../../utils/firebase";
import { Timestamp } from "firebase-admin/firestore";
import { VisaSource, VisaSourcePage } from "./types";
import { EXTRACTOR_PROMPT_VERSION, visaCatalogExtractor } from "./visa-catalog-extract.service";
import { visaCatalogService } from "./visa-catalog.service";
import type { FxFetcher } from "./visa-catalog-fx";
// Fetching goes through the source adapter picked from `source.adapter`
// (govuk-content-api for GB, generic-html — today's fetch service — otherwise).
import { pickSourceAdapter, sourceMetaFromDocument, type SourceAdapterSet } from "./adapters";
// Pure weekly-night-window helpers (issue #63): which due sources may run on
// this tick, and when each runs next.
import { isInCrawlWindow, nextWindowOpening } from "../shared/etiquette/visa-crawl-window";
// Crawler etiquette (issue #64): per-host 429/503 backoff state for the run.
import {
  HostBackoffTracker,
  backoffMessage,
  hostOf,
  isHostBackoffError,
} from "../shared/etiquette/visa-crawl-host-state";
// Firestore <-> helper mappers for `hostBackoffs`, shared with the manual script.
import { hostBackoffEntriesFromSource, hostBackoffEntriesToSource } from "../shared/etiquette/visa-crawl-host-backoff-store";
// Code fallback for a registry doc seeded before `officialHosts` existed (#74).
import { resolveOfficialHosts } from "./visa-catalog-official-hosts";
// Surcharges published on a linked page (issue #69): fetched once per run.
import { LinkedSurchargeCache, linkedGateHash, linkedSurchargePage } from "./visa-catalog-linked-surcharge";
// Run records (issue #81): one `scrapeRuns/{runId}` doc per run that crawls.
import { scrapeRunService, type ScrapeRunRecorder, type ScrapeRunService } from "../shared/runs/scrape-run.service";
import type { ScrapeRunPageOutcome, ScrapeRunSourceStatus, ScrapeRunTrigger } from "../shared/runs/types";
// Cost tracking (issue #82): the price table (loaded once per run) and the
// pure helpers that price each call's reported usage. Importing the service
// also installs the monthly-rollup finalize hook.
import { scrapeCostService } from "../shared/cost/scrape-cost.service";
import { pageUsageFields, priceUsageReport, type PricedUsage } from "../shared/cost/scrape-cost-pricing";
// Supplementary pages (issue #86): extra official pages appended to a route's text.
import {
  SupplementaryPageCache,
  combineSupplementaryText,
  supplementaryGateHash,
  supplementaryPagesMeta,
} from "./visa-catalog-supplementary";
// Admin settings (issue #96): kill switch + limits (one read per tick) and
// the budget hard stop that gates LLM extraction.
import { loadScraperSettings } from "../shared/settings/scraper-settings.store";
import { loadBudgetGate, type BudgetGate } from "../shared/settings/budget-hard-stop";
import type { ScraperSettings } from "../shared/settings/types";

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
//
// Host backoff (issue #64): a 429/503 from a host (HostBackoffError from the
// fetch service) makes the run stop requesting that host — the page that got
// it records the error, every remaining page on the host is skipped with a
// "host backed off (…)" lastError and NO request. The retry-after instant is
// stored on the source doc (`hostBackoffs`), so later runs skip the host's
// pages until then, and `nextCrawlAt` is pushed past it when every page host
// is backed off. A run that RECEIVED a 429/503 counts as a failure toward
// consecutiveFailures / auto-pause, even if other pages fetched. A run whose
// pages were all merely skipped because of a STORED backoff is a deferral:
// neither success nor failure (consecutiveFailures unchanged), so one long
// Retry-After cannot by itself auto-pause a source.
//
// Run records (issue #81): every tick first sweeps stale `running` run docs
// (crashed runs -> failed). A tick that has something to crawl then writes a
// `scrapeRuns/{runId}` doc as `running` BEFORE any FX / fetch / LLM work,
// notes each page's outcome, each source's outcome and each error on it, and
// finalises it with the full CrawlSummary at the end (or `failed` if the run
// throws). Idle ticks (nothing due in its window — most hourly ticks) write
// NO run doc: they crawl nothing, and recording them would add ~24 empty
// docs a day. Each source's `crawlRuns` log doc carries the `runId`.
//
// Cost (issue #82): the run loads `appConfig/llmPricing` once (after the run
// doc is written), and every LLM call's reported token usage is priced and
// noted on the run record (per country / model), on the page line and in the
// visa's scrapeMeta. A call whose output then fails validation is still
// counted (it was billed). finalize() writes the totals; the finalize hook
// adds them to `scrapeCosts/{YYYY-MM}`.

// Recorded as the page's lastError when the source says the page is withdrawn
// (whether or not a scraped doc was deactivated), so it shows in source health.
export const WITHDRAWN_PAGE_ERROR = "Withdrawn on GOV.UK";

// Safety bounds per invocation — keep any single run cheap + within the function
// timeout even on the first pass when every source is due. Issue #96: these
// used to be code constants (3 countries, 15 LLM calls); they now come from
// `appConfig/scraperSettings` (visa.maxSourcesPerTick /
// visa.maxExtractionsPerRun), whose defaults keep those values. See
// scrapers/shared/settings/scraper-settings.store.ts.

// Issue #96: the run-line reason of a changed page whose extraction the
// budget hard stop skipped (outcome "capped": the page waits, not an error).
export const BUDGET_HARD_STOP_REASON =
  "budget hard stop: the monthly LLM budget is spent, so this page was fetched and hashed but not " +
  "extracted; it stays pending and re-extracts once the budget allows";

export interface CrawlSummary {
  sourcesProcessed: number;
  pagesFetched: number;
  pagesChanged: number; // content hash differed → sent to extraction
  // Issue #71: pages with an UNCHANGED hash sent to extraction anyway because
  // their pending scraped doc came from an older extractor prompt version.
  promptReextracts: number;
  created: number; // new pending-review scraped visas written
  updated: number; // existing pending scraped visas refreshed
  skipped: number; // seeded/agent/rejected/withdrawn visa left untouched
  // Approved scraped visa whose page changed: a pendingVisaChanges row was
  // written / replaced for an admin (issue #61). Not counted in `skipped`.
  proposed: number;
  withdrawn: number; // source said withdrawn → no extraction (scraped doc deactivated if present)
  // Issue #68: withdrawn scraped visas whose page is live again, put back in
  // the admin review queue (reviewStatus pending_review; never reactivated).
  restored: number;
  errors: number;
  // FX (issue #59): whether appConfig/fx was refreshed this run, and how many
  // flagged pending visas were re-converted (cost written) from stored fee
  // components with no LLM call.
  fxRefreshed: boolean;
  feesReconverted: number;
  // Host backoff (issue #64): hosts that answered 429/503 this run, and pages
  // skipped without a request because their host was backed off (this run or
  // by a stored retry-after time).
  hostsBackedOff: number;
  pagesDeferred: number;
  // Issue #69: marked pages NOT extracted because their linked surcharge page
  // (e.g. the UK IHS page) could not be fetched or parsed this run. Each is
  // also a page error (in `errors`) and logged with console.error.
  linkedSurchargeErrors: number;
  // Issue #96: true when the budget hard stop blocked extraction at some
  // point in this run, and how many pages (changed, or due a prompt
  // re-extract) were fetched + hashed but NOT extracted because of it.
  budgetHardStop: boolean;
  extractionsSkippedBudget: number;
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
    // Injectable adapter set (tests: adapters over a fetch service with a
    // stubbed HTTP client, e.g. one that answers 429). Defaults to the
    // production adapters over the shared fetch-service singleton.
    adapters?: SourceAdapterSet;
    // Issue #81: what started this run (stored on the run doc). The
    // scheduled function leaves it at "scheduled"; a future admin "Run now"
    // endpoint passes "manual".
    trigger?: ScrapeRunTrigger;
    // Issue #81: the run recorder service (tests may inject one; defaults to
    // the Firestore-backed singleton).
    runs?: ScrapeRunService;
    // ---- Issue #96: admin settings + manual runs ----
    // Resolved settings (tests / the manual-run worker pass the copy they
    // already read); default = ONE read of appConfig/scraperSettings here.
    settings?: ScraperSettings;
    // Run just this country (manual "Run now" on one source): it is crawled
    // whether or not it is due and whatever its window, as long as its
    // status is active or broken (paused / retired are never crawled).
    sourceId?: string;
    // Run every DUE active source, ignoring crawl windows (manual "Run now"
    // on the whole scraper). Robots, backoff and limits still apply.
    ignoreWindow?: boolean;
    // Ignore the content-hash gate: every fetched page goes to extraction
    // (still within maxExtractions and the budget hard stop).
    force?: boolean;
    // Called with the run id as soon as the run doc is written (the manual
    // worker stores it on the request so the portal can follow the run).
    onRunStarted?: (runId: string) => Promise<void> | void;
  }): Promise<CrawlSummary> {
    const trigger: ScrapeRunTrigger = opts?.trigger ?? "scheduled";

    // ---- Settings: ONE read per tick (issue #96) ----
    // Never throws (defaults on a read error). Explicit maxSources /
    // maxExtractions options (tests, scripts) still win over the settings.
    const settings = opts?.settings ?? (await loadScraperSettings());

    // ---- Kill switch (issue #96) ----
    // A SCHEDULED tick with the visa scraper switched off returns before
    // anything else: no stale sweep, no rollup backfill, no due query, no
    // run doc, no fetch, no LLM call. Manual runs are gated by the API /
    // worker (blockManualWhenOff), not here.
    if (trigger === "scheduled" && !settings.visa.enabled) {
      console.log("Visa catalog crawl: the visa scraper is switched off (appConfig/scraperSettings), tick skipped");
      return emptySummary();
    }

    const maxSources = opts?.maxSources ?? settings.visa.maxSourcesPerTick;
    const maxExtractions = opts?.maxExtractions ?? settings.visa.maxExtractionsPerRun;

    // The tick's instant. Every scheduling decision AND every timestamp
    // written below (lastCrawledAt, page crawl times, updatedAt, the
    // crawlRuns log) is on THIS clock, not the run's end time, so a long run
    // never shifts the weekly grid and an injected `now` is consistent.
    const now =
      opts?.now === undefined
        ? Timestamp.now()
        : Timestamp.fromMillis(typeof opts.now === "number" ? opts.now : opts.now.getTime());
    const summary: CrawlSummary = emptySummary();
    const runs = opts?.runs ?? scrapeRunService;

    // ---- Stale run sweep (issue #81) ----
    // On EVERY tick, idle or not: a previous run (visa or news) still
    // `running` after 1h crashed or timed out -> mark it failed. Never throws.
    await runs.sweepStaleRuns(now.toMillis());

    // ---- Cost rollup backfill (issue #82 review) ----
    // Also on EVERY (hourly) tick: re-add finished runs of the current /
    // previous month whose rollup hook failed. An empty indexed query when
    // nothing failed; bounded; never throws. #83's hourly check may call it too.
    await scrapeCostService.backfillRecent(now.toMillis());

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
    // Issue #96 ("Run now" on one source): read just that doc, skipping
    // the due query and the window filter below. Paused / retired sources
    // are never crawled (the API refuses them too); a broken one may be
    // retried by hand (a healthy run makes it active again).
    let runnable: { ref: FirebaseFirestore.DocumentReference; data(): FirebaseFirestore.DocumentData | undefined }[];
    if (opts?.sourceId !== undefined) {
      const snap = await collections.visaSources.doc(opts.sourceId).get();
      const status = (snap.data() as VisaSource | undefined)?.status;
      runnable = snap.exists && (status === "active" || status === "broken") ? [snap] : [];
    } else {
      runnable = await this.dueRunnable(now, maxSources, opts?.ignoreWindow === true);
    }

    // Nothing to crawl on this tick (the common case: most hourly ticks fall
    // outside every window) -> stop here, BEFORE any FX work: no Frankfurter
    // call and no pending-visa scan. fxRefreshed stays false. FX freshness is
    // not at risk: every night of the week has sources, so a refresh happens
    // at least daily, well within FX_MAX_AGE_DAYS (7).
    if (runnable.length === 0) return summary;

    // ---- Start the run record (issue #81) ----
    // Written as `running` before any FX / fetch / LLM work. Never throws.
    // Issue #96: a manual run also records its scope (sourceId / force /
    // ignoreWindow); undefined knobs are dropped, so a scheduled run's
    // options stay { maxSources, maxExtractions } as before.
    const recorder = await runs.start({
      kind: "visa",
      trigger,
      startedAtMs: now.toMillis(),
      options: {
        maxSources,
        maxExtractions,
        sourceId: opts?.sourceId,
        force: opts?.force ? true : undefined,
        ignoreWindow: opts?.ignoreWindow ? true : undefined,
      },
    });
    console.log(`Visa catalog crawl: run ${recorder.id} started (${runnable.length} source(s))`);
    // Issue #96: tell the manual worker the run id at once (best effort: a
    // failing callback must not stop the crawl).
    if (opts?.onRunStarted) {
      try {
        await opts.onRunStarted(recorder.id);
      } catch (err) {
        console.error(`Visa catalog crawl: onRunStarted callback failed: ${(err as Error)?.message ?? err}`);
      }
    }

    try {
      // ---- Budget hard stop (issue #96), read once per run ----
      // null = nothing to enforce (hard stop off, no budget, or the cost
      // could not be read — then a run warning says so).
      const budgetGate = await loadBudgetGate(settings, now.toMillis(), (msg) => recorder.recordWarning(msg));
      await this.crawlRunnable(runnable, {
        now,
        summary,
        recorder,
        maxExtractions,
        opts,
        budgetGate,
        force: opts?.force === true,
      });
      if (summary.budgetHardStop && budgetGate) {
        // A run-level warning (not an error: status unaffected). The post-run
        // alert rule budget_hard_stop (#83 engine) raises the alert from the
        // summary flag.
        recorder.recordWarning(
          `LLM budget hard stop: month-to-date cost reached the $${budgetGate.budgetUsd} budget for ` +
            `${budgetGate.month}; ${summary.extractionsSkippedBudget} page(s) fetched but not extracted`
        );
      }
    } catch (err) {
      // An unexpected throw (e.g. a Firestore write failing) aborts the run:
      // record it as failed with what was counted so far, then rethrow so
      // the scheduled function logs it as before.
      await recorder.fail(err, summary);
      throw err;
    }

    // ---- Finalise the run record (issue #81) ----
    // "Something worked" = at least one page fetched (see deriveRunStatus).
    await recorder.finalize({ summary, anySuccess: summary.pagesFetched > 0 });
    return summary;
  }

  /**
   * The DUE sources a tick may crawl, oldest first, at most `maxSources`.
   * Split out of runOrchestrator in #96 (the single-source manual run skips
   * it). `ignoreWindow` (manual whole-scraper run) keeps every due source
   * whatever its window.
   */
  private async dueRunnable(
    now: Timestamp,
    maxSources: number,
    ignoreWindow: boolean
  ): Promise<FirebaseFirestore.QueryDocumentSnapshot[]> {
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
    return dueSnap.docs
      .filter((doc) => {
        const source = doc.data() as VisaSource;
        // Issue #96: a manual whole-scraper run ignores windows.
        if (ignoreWindow || !source.crawlWindow) return true;
        try {
          return isInCrawlWindow(source.crawlWindow, now.toMillis());
        } catch (err) {
          console.error(`Visa catalog: source ${doc.id} has an invalid crawlWindow, skipped:`, err);
          return false;
        }
      })
      .slice(0, maxSources);
  }

  /**
   * The crawl body for one tick's runnable sources (split out of
   * runOrchestrator in #81 so the run record can wrap it in one try/catch).
   * Mutates `summary` and notes pages / sources / errors on `recorder`.
   */
  private async crawlRunnable(
    // Query snapshots (due sources) or one doc snapshot (manual single-source
    // run, #96): only `ref` and `data()` are used.
    runnable: { ref: FirebaseFirestore.DocumentReference; data(): FirebaseFirestore.DocumentData | undefined }[],
    ctx: {
      now: Timestamp;
      summary: CrawlSummary;
      recorder: ScrapeRunRecorder;
      maxExtractions: number;
      opts?: { fetchFxRates?: FxFetcher; adapters?: SourceAdapterSet };
      // Issue #96: the budget hard stop (null = not enforced) and `force`
      // (ignore the content-hash gate).
      budgetGate: BudgetGate | null;
      force: boolean;
    }
  ): Promise<void> {
    const { now, summary, recorder, maxExtractions, opts, budgetGate, force } = ctx;

    // ---- Price table for this run (issue #82). Never throws: falls back to
    // the default table (quoted from the provider's page) when unreadable.
    const { pricing } = await scrapeCostService.loadPricing();

    // ---- FX: refresh appConfig/fx ONCE per run, before any extraction ----
    // Only on a tick that crawls something. Never throws: on failure the
    // previous doc is kept and used if still within FX_MAX_AGE_DAYS. Then
    // re-convert pending scraped visas whose fee was flagged stale/missing,
    // from their stored components (no LLM call).
    const fxRefresh = await visaCatalogService.refreshFx(opts?.fetchFxRates);
    const fx = fxRefresh.fx;
    summary.fxRefreshed = fxRefresh.refreshed;
    // Issue #81: a failed refresh is a run-level warning (previous rates are
    // used while within FX_MAX_AGE_DAYS) — not an error, status unaffected.
    if (!fxRefresh.refreshed) recorder.recordWarning(`FX refresh failed: ${fxRefresh.error ?? "unknown error"}`);
    try {
      summary.feesReconverted = (await visaCatalogService.reconvertFlaggedFees(fx)).reconverted;
    } catch (err) {
      // A failed re-convert must not abort the crawl; it retries next run.
      console.error("Visa catalog: re-converting flagged fees failed:", err);
      // A run-level WARNING on the run record: not a page error, so it is
      // neither in summary.errors nor in errorCount, and a clean crawl
      // stays `succeeded`.
      recorder.recordWarning(`re-converting flagged fees failed: ${(err as Error)?.message ?? err}`);
    }

    // Running count of LLM calls this tick, against maxExtractions.
    let extractionsUsed = 0;

    // Host backoff state for the WHOLE run (issue #64), shared by every
    // source: a host that throttled us while crawling one source is not
    // requested again by a later source in the same tick either.
    const hostState = new HostBackoffTracker(now.toMillis());

    // Linked surcharge pages (issue #69, e.g. the UK IHS page), fetched at
    // most ONCE per run whatever the number of routes using them, through
    // the normal adapter (robots, rate limit, our UA). A host already backed
    // off in this run is not requested: the marked route records the error.
    const linkedSurcharges = new LinkedSurchargeCache(async (cfg) => {
      const blocked = hostState.blocking(hostOf(cfg.url));
      if (blocked) throw new Error(`linked surcharge page not fetched: ${backoffMessage(blocked)}`);
      return pickSourceAdapter(cfg.adapter, cfg.url, opts?.adapters).fetch(linkedSurchargePage(cfg));
    });

    for (const doc of runnable) {
      const source = doc.data() as VisaSource;
      // Real clock, only to measure this source's run duration for the log;
      // the logged times themselves are on the tick clock (`now`).
      const runStartReal = Date.now();
      const pages: VisaSourcePage[] = [...source.pages];
      let fetchedOk = 0;
      let pageErrors = 0;
      let ingested = 0;
      // Issue #64: did one of THIS source's requests get a 429/503 (a failure),
      // and how many of its pages were skipped because their host was backed off.
      let throttledThisRun = false;
      let deferredPages = 0;
      // Issue #81: this source's page outcomes, for its run-record line.
      const counts = { created: 0, updated: 0, skipped: 0, proposed: 0, withdrawn: 0, unchanged: 0, deferred: 0 };
      // Note one page outcome on the run record (and in the per-source counts).
      const notePage = (
        page: VisaSourcePage,
        outcome: ScrapeRunPageOutcome,
        // Issue #82: the page's LLM usage fields (pageUsageFields) when it made a call.
        extra: { visaId?: string; error?: string; reason?: string } & ReturnType<typeof pageUsageFields> = {}
      ) => {
        if (outcome in counts) counts[outcome as keyof typeof counts]++;
        recorder.recordPage({
          sourceId: source.countryCode,
          url: page.url,
          routeName: page.routeName,
          outcome,
          ...extra,
        });
      };
      // Stored retry-after times from earlier runs (expired ones are ignored).
      hostState.load(hostBackoffEntriesFromSource(source.hostBackoffs));
      // ---- Supplementary pages for this source (issue #86) ----
      // One cache per SOURCE (supplements are rows of the same country and
      // use its adapter); each is fetched at most once, skipped like any page
      // when its host is backed off.
      const supplements = new SupplementaryPageCache(async (suppPage) => {
        const blocked = hostState.blocking(hostOf(suppPage.url));
        if (blocked) throw new Error(`supplementary page not fetched: ${backoffMessage(blocked)}`);
        return pickSourceAdapter(source.adapter, suppPage.url, opts?.adapters).fetch(suppPage);
      });

      for (let i = 0; i < pages.length; i++) {
        // Respect the per-run extraction cap. The source is still rescheduled
        // below, so its remaining pages are picked up at its NEXT window
        // (their stored hash is unchanged, so they re-extract then).
        if (extractionsUsed >= maxExtractions) break;

        const page = pages[i];

        // ---- Supplement-only row (issue #86)? Not a visa: never extracted ----
        // It is fetched (once per run) only for the routes that list it in
        // `supplementaryPages`, below. Its own crawl fields are updated there.
        if (page.supplementOnly) continue;

        // ---- Host backed off? Skip WITHOUT any request (issue #64) ----
        // Blocked if the host answered 429/503 earlier in this run (for the
        // rest of the run), or a stored retry-after time is still ahead. The
        // page keeps its crawl state (hash, lastCrawledAt); only lastError
        // says why it was not crawled.
        const blocking = hostState.blocking(hostOf(page.url));
        if (blocking) {
          deferredPages++;
          summary.pagesDeferred++;
          pages[i] = { ...page, lastError: backoffMessage(blocking) };
          notePage(page, "deferred", { error: backoffMessage(blocking) });
          continue;
        }

        // Issue #82: the priced usage of this page's LLM call, set by the
        // extractor's onUsage callback (stays undefined when no call is made).
        let callUsage: PricedUsage | undefined;
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
          const adapter = pickSourceAdapter(source.adapter, page.url, opts?.adapters);
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
            notePage(page, "withdrawn", { visaId });
            continue;
          }

          // ---- Restored at source: admin review signal (issue #68) ----
          // The page is live. If its scraped doc was deactivated as withdrawn
          // (and was approved), put it back to pending_review so it shows in
          // the admin Visa Review queue. Runs BEFORE the hash gate, so it
          // fires whether or not the text changed; never reactivates.
          // Its read of the doc is reused by the #71 prompt check below.
          const restored = await visaCatalogService.markRestored(source.countryCode, visaId);
          if (restored.outcome === "flagged") summary.restored++;

          // ---- Linked surcharges (issue #69) ----
          // [] for an unmarked page (no request). A failure (fetch error,
          // rate not found on the linked page, 429) throws into the catch
          // below: a page error, no extraction, stored hash untouched.
          let linked;
          try {
            linked = await linkedSurcharges.forPage(page);
          } catch (err) {
            // Visible in the scheduled log + run summary, then handled as a
            // normal page error by the catch below (rethrown).
            summary.linkedSurchargeErrors++;
            console.error(
              `Visa catalog: source ${source.countryCode}, page ${page.url}: linked surcharge unavailable, ` +
                "page not extracted:",
              err
            );
            throw err;
          }
          // Hash is over the exact text the extractor would see (selected +
          // capped sections for GOV.UK; the cleaned page for generic-html),
          // combined with the linked pages' hashes when the page has any.
          // Supplementary pages (issue #86): [] for a route that lists none.
          // A failure throws (route NOT extracted without its fee page) and
          // is recorded on the route like any page error.
          const supps = await supplements.forPage(page, pages);
          // Record the supplements' own crawl state on their rows (they are
          // never visited by this loop): fetched now, with their text hash.
          for (const s of supps) {
            const j = pages.findIndex((p) => p.url === s.page.url);
            if (j >= 0) pages[j] = { ...pages[j], lastCrawledAt: now, lastContentHash: s.doc.contentHash, lastError: undefined };
          }
          // Text the extractor sees: the route text + each supplement.
          const extractText = combineSupplementaryText(fetched.text, supps);
          // Hash gate over route + supplements (+ linked surcharge pages).
          const gateHash = linkedGateHash(supplementaryGateHash(fetched.contentHash, supps), linked);
          // Issue #96: `force` (manual Run now) treats every page as changed.
          const changed = force || gateHash !== page.lastContentHash;
          // Record crawl metadata regardless of change.
          pages[i] = {
            ...page,
            lastContentHash: gateHash,
            lastCrawledAt: now,
            lastError: undefined,
          };
          // ---- Hash gate (+ prompt-version re-extract, issue #71) ----
          // Same text as last crawl → normally skip the LLM. Exception: the
          // doc at `visaId` is a PENDING scraped visa extracted by an older
          // EXTRACTOR_PROMPT_VERSION — re-extract it so a prompt change
          // reaches it without a manual --force. Approved / seeded / agent
          // docs never qualify (approved ones only get a #61 proposal on a
          // real content change). This goes through the same
          // maxExtractions accounting below, so a version bump drains over
          // several runs instead of re-extracting everything at once.
          if (!changed) {
            const promptStale = await visaCatalogService.needsPromptReextract(source.countryCode, visaId, {
              doc: restored.doc, // same doc, already read by markRestored (no second read)
            });
            if (!promptStale) {
              notePage(page, "unchanged", { visaId });
              continue; // nothing new, skip the LLM
            }
            summary.promptReextracts++;
          } else {
            summary.pagesChanged++;
          }

          // ---- Budget hard stop (issue #96) ----
          // The month's spend (rollup at run start + this run's own cost so
          // far) has reached the budget: do NOT call the LLM. The page was
          // fetched and hashed above; put its OLD hash back so the gate
          // still sees it as changed next run (it stays pending), and stamp
          // extractionDeferredAt. No maxExtractions slot is used.
          if (budgetGate && budgetGate.exceeded(recorder.usageSoFar.costUsd)) {
            summary.budgetHardStop = true;
            summary.extractionsSkippedBudget++;
            pages[i] = { ...pages[i], lastContentHash: page.lastContentHash, extractionDeferredAt: now };
            notePage(page, "capped", { visaId, reason: BUDGET_HARD_STOP_REASON });
            continue;
          }

          // Count the LLM call BEFORE making it: a failed call (API error,
          // validation error) costs money too and must use up a
          // maxExtractions slot, or a systematic failure could exceed the cap.
          extractionsUsed++;
          const extracted = await visaCatalogExtractor.extract(extractText, {
            url: page.url,
            countryName: source.countryName,
            routeName: page.routeName,
            // Registry official hosts gate `applicationUrl` (issue #74). The
            // stored field wins only when it is a non-empty string array; a doc
            // seeded before #74 (or a malformed field) falls back to code.
            officialHosts: resolveOfficialHosts(source.officialHosts, source.countryCode),
            // Issue #82: price the call's reported usage and count it on the
            // run (per country / model) as soon as the API answers.
            onUsage: (report) => {
              callUsage = priceUsageReport(report, pricing);
              recorder.recordUsage({ ...callUsage, sourceId: source.countryCode });
            },
          });
          // Issue #96: a page deferred by the budget hard stop is caught up.
          pages[i] = { ...pages[i], lastExtractedAt: now, extractionDeferredAt: undefined };

          const { outcome } = await visaCatalogService.ingestExtraction({
            countryCode: source.countryCode,
            sourceUrl: page.url,
            routeName: page.routeName,
            // The gate hash (= the page hash unless linked surcharges apply).
            contentHash: gateHash,
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
            // Linked-page surcharges for this route (issue #69).
            linkedSurcharges: linked,
            // Supplementary pages used (issue #86), for scrapeMeta.
            supplementaryPages: supplementaryPagesMeta(supps),
            // Issue #82: token usage + cost on scrapeMeta.
            llmUsage: callUsage,
          });
          if (outcome === "created") summary.created++;
          else if (outcome === "updated") summary.updated++;
          else if (outcome === "skipped") summary.skipped++;
          else if (outcome === "proposed") summary.proposed++;
          if (outcome !== "unchanged") ingested++;
          notePage(page, outcome, { visaId, ...pageUsageFields(callUsage, EXTRACTOR_PROMPT_VERSION) });
        } catch (err) {
          pageErrors++;
          summary.errors++;
          // Issue #81: on the run record (redacted there).
          recorder.recordError({ sourceId: source.countryCode, url: page.url, error: err });
          // Usage fields too when the failure came after a billed LLM call (#82).
          notePage(page, "error", {
            error: (err as Error)?.message ?? String(err),
            ...pageUsageFields(callUsage, EXTRACTOR_PROMPT_VERSION),
          });
          // ---- 429/503: back off from the host (issue #64) ----
          // Record it for the rest of the run (and for persisting below)
          // against EVERY host involved (deduplicated by the tracker):
          //  - err.host: the host that actually answered 429/503 (the final
          //    host after any redirect, when the client reports it);
          //  - err.requestedHost: the host we asked (differs only after a
          //    cross-host redirect, or when the adapter requests another host
          //    than the page's, e.g. an API host);
          //  - the page's own host, because the skip check above is by PAGE
          //    host: we cannot know where a page redirects before requesting
          //    it, so blocking only the redirect target would let the next
          //    page on the same origin go out and be redirected straight back
          //    to the host that throttled us.
          if (isHostBackoffError(err)) {
            throttledThisRun = true;
            const entry = err.toEntry(now.toMillis());
            if (!hostState.isFresh(entry.host)) summary.hostsBackedOff++;
            for (const h of new Set([entry.host, err.requestedHost, hostOf(page.url)])) {
              if (h) hostState.record({ ...entry, host: h });
            }
          }
          pages[i] = {
            ...page,
            lastCrawledAt: now,
            lastError: (err as Error).message?.slice(0, 300),
          };
        }
      }

      // ---- Supplement-only rows on the run record (issues #86, #81) ----
      // The page loop skips them (not visas, never extracted); they are
      // fetched through the supplements cache by the routes that list them.
      // Recorded AFTER the loop so the line says whether a route fetched the
      // row this run (its lastCrawledAt was set to this tick above). Outcome
      // "supplement" does not count toward pagesAttempted.
      for (const p of pages) {
        if (!p.supplementOnly) continue;
        const fetchedNow = Boolean(p.lastCrawledAt) && p.lastCrawledAt!.toMillis() === now.toMillis();
        notePage(p, "supplement", {
          reason: fetchedNow
            ? "supplement-only page (fee table): fetched for the routes that use it, never extracted"
            : "supplement-only page (fee table): not fetched this run (no route using it was crawled)",
        });
      }

      // ---- Source health + reschedule ----
      // A source "succeeds" this run if at least one page fetched AND no host
      // throttled it (a 429/503 counts as a failure, issue #64). Consecutive
      // failures auto-pause it at 5 (self-healing, like news).
      // Deferral (issue #64): when no request was made at all because every
      // page's host was under a STORED backoff, we were only respecting the
      // host's own Retry-After — neither success nor failure, so the counter
      // is left as it was (a source with NO pages still counts as a failure,
      // as before).
      const anySuccess = fetchedOk > 0 && !throttledThisRun;
      const deferredOnly =
        deferredPages > 0 && fetchedOk === 0 && pageErrors === 0 && !throttledThisRun;
      let consecutiveFailures: number;
      if (deferredOnly) consecutiveFailures = source.consecutiveFailures || 0; // unchanged
      else if (anySuccess) consecutiveFailures = 0; // healthy run resets the streak
      else consecutiveFailures = (source.consecutiveFailures || 0) + 1; // failure (incl. 429/503)
      const status = consecutiveFailures >= 5 ? "broken" : "active";
      // Simple reliability signal: this run's fetch success ratio.
      const attempted = fetchedOk + pageErrors;
      const reliabilityScore = attempted > 0 ? Math.round((fetchedOk / attempted) * 100) : source.reliabilityScore;
      // Reschedule (success OR failure, so a source never runs twice in one
      // night): with a window -> its next opening strictly after this tick
      // (next week's local startHour; DST-correct; no drift however long the
      // run took, since it is computed from the tick's `now`). Without a
      // window -> legacy `now + crawlIntervalHours`.
      let nextCrawlAt = source.crawlWindow
        ? Timestamp.fromDate(nextWindowOpening(source.crawlWindow, now.toMillis()))
        : Timestamp.fromMillis(now.toMillis() + source.crawlIntervalHours * 60 * 60 * 1000);

      // ---- Host backoffs to persist + defer past them (issue #64) ----
      // Keep only the still-future backoffs for hosts this source's pages use
      // (expired entries are pruned by not being written back).
      const pageHosts = pages.map((p) => hostOf(p.url)).filter(Boolean);
      const backoffs = hostState.entriesFor(pageHosts);
      // If EVERY page host is backed off past the normal next run, that run
      // could request nothing: defer it to when the FIRST host frees up. With
      // a window -> the first window opening at/after that instant (so we
      // never come back early and stay on the local-night grid); without ->
      // that instant itself. If only some hosts are backed off, the normal
      // schedule stands and their pages are skipped per page.
      //
      // INTENTIONAL: a windowed source then waits for the next WEEKLY
      // opening after the retry-after, even if the host frees up minutes
      // later (e.g. Retry-After lands mid-week -> next week's night). We do
      // not add an off-window catch-up run: crawling only in the source's
      // local night (issue #63) is part of being a polite crawler, and a
      // host that just throttled us is the last one to hit at an odd hour.
      const uniqueHosts = new Set(pageHosts);
      if (uniqueHosts.size > 0 && backoffs.length === uniqueHosts.size) {
        const earliestFreeMs = Math.min(...backoffs.map((b) => b.untilMs));
        if (earliestFreeMs > nextCrawlAt.toMillis()) {
          // -1 ms: nextWindowOpening is STRICTLY after its argument, so an
          // opening exactly at earliestFreeMs is still chosen.
          nextCrawlAt = source.crawlWindow
            ? Timestamp.fromDate(nextWindowOpening(source.crawlWindow, earliestFreeMs - 1))
            : Timestamp.fromMillis(earliestFreeMs);
        }
      }

      await doc.ref.update({
        pages,
        lastCrawledAt: now,
        nextCrawlAt,
        consecutiveFailures,
        status,
        reliabilityScore,
        // Always written: an empty array clears expired backoffs.
        hostBackoffs: hostBackoffEntriesToSource(backoffs),
        updatedAt: now,
      });

      // Per-run log (subcollection) for observability + admin debugging.
      // `runId` links it to the run-wide `scrapeRuns/{runId}` doc (#81).
      const crawlRunRef = await doc.ref.collection("crawlRuns").add({
        runId: recorder.id,
        // Tick clock: startedAt = the tick's `now`; completedAt = `now` plus
        // the real elapsed time, so the log keeps the run's duration while
        // staying consistent with an injected `now` (tests / emulator runs).
        startedAt: now,
        completedAt: Timestamp.fromMillis(now.toMillis() + (Date.now() - runStartReal)),
        pagesFetched: fetchedOk,
        pageErrors,
        visasIngested: ingested,
        // Issue #64: whether a host throttled this source, and pages skipped.
        throttled: throttledThisRun,
        pagesDeferred: deferredPages,
        status,
      });

      // ---- Run-record line for this source (issue #81) ----
      // empty = no page attempted at all (a source with no pages, or the
      // run's extraction cap was used up before it) — not an error, even
      // though source health still counts it as a failure; deferred =
      // nothing requested (stored backoffs only); succeeded = some page
      // fetched with no page error and no 429/503; partial = fetched some
      // but had errors / was throttled; failed = attempted, fetched nothing.
      let sourceStatus: ScrapeRunSourceStatus;
      if (fetchedOk + pageErrors + deferredPages === 0) sourceStatus = "empty";
      else if (deferredOnly) sourceStatus = "deferred";
      else if (fetchedOk === 0) sourceStatus = "failed";
      else if (pageErrors === 0 && !throttledThisRun) sourceStatus = "succeeded";
      else sourceStatus = "partial";
      recorder.recordSource({
        sourceId: source.countryCode,
        name: source.countryName,
        status: sourceStatus,
        pagesAttempted: fetchedOk + pageErrors + deferredPages,
        pagesFetched: fetchedOk,
        errors: pageErrors,
        sourceRunId: crawlRunRef.id,
        counts: { ...counts, visasIngested: ingested },
      });

      summary.sourcesProcessed++;
    }
  }
}

/** A zeroed run summary (also what a switched-off or idle tick returns). */
function emptySummary(): CrawlSummary {
  return {
    sourcesProcessed: 0,
    pagesFetched: 0,
    pagesChanged: 0,
    promptReextracts: 0,
    created: 0,
    updated: 0,
    skipped: 0,
    proposed: 0,
    withdrawn: 0,
    restored: 0,
    errors: 0,
    fxRefreshed: false,
    feesReconverted: 0,
    hostsBackedOff: 0,
    pagesDeferred: 0,
    linkedSurchargeErrors: 0,
    budgetHardStop: false,
    extractionsSkippedBudget: 0,
  };
}

export const visaCatalogCrawlService = new VisaCatalogCrawlService();
