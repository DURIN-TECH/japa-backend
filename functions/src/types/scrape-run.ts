import { Timestamp } from "firebase-admin/firestore";
// Issue #82: usage / cost shapes shared with the monthly rollup.
import type { CostTotals, LlmUsage, RunCostBreakdown } from "./scrape-cost";

// ============================================
// SCRAPE RUNS — one record per scraper run (issue #81)
// ============================================
//
// Top-level `scrapeRuns/{runId}` collection: one doc per visa-catalog or news
// scraper run (scheduled tick, admin-triggered run, or manual CLI script).
// Written as `running` when the run starts and finalised when it ends (see
// services/scrape-run.service.ts). A run that crashes before finalising stays
// `running`; the next run marks it `failed` once it is older than an hour.
//
// The same collection ID is ALSO used by the legacy per-source news log
// `newsSources/{id}/scrapeRuns/{id}` (ScrapeRun in types/news.ts). Firestore
// collection-group queries / TTL policies on "scrapeRuns" therefore span both;
// see the notes in news.service.ts (cleanupOldScrapeRuns) and docs/scrape-runs.md.
//
// Forward compatibility (#82 cost, #83 alerting): every field below that a
// later issue may add to is optional or a plain map, and readers must ignore
// unknown fields. #82 fills `usage` / `costUsd` / `costBreakdown` (and the
// per-page usage below); #83 hangs its alert rules off the finalize hook
// (scrapeRunService.registerFinalizeHook).

/** Which scraper produced the run. */
export type ScrapeRunKind = "visa" | "news";

/**
 * What started the run:
 *  - scheduled: the Cloud Scheduler tick (crawlVisaCatalogOrchestrator /
 *    scrapeNewsOrchestrator);
 *  - manual: an admin-triggered run through the API (reserved for a future
 *    "Run now" endpoint, #84; nothing writes it yet);
 *  - script: a CLI run (`src/scripts/crawl-visa-catalog.ts`).
 */
export type ScrapeRunTrigger = "scheduled" | "manual" | "script";

/**
 * Run lifecycle:
 *  - running: started, not finalised yet (or crashed — swept to failed after 1h);
 *  - succeeded: finished with no errors;
 *  - partial: finished with errors, but some work succeeded;
 *  - failed: finished with errors and nothing succeeded, threw, or went stale.
 */
export type ScrapeRunStatus = "running" | "succeeded" | "partial" | "failed";

/** Every kind / trigger / status value, for validating API query params. */
export const SCRAPE_RUN_KINDS: readonly ScrapeRunKind[] = ["visa", "news"];
export const SCRAPE_RUN_TRIGGERS: readonly ScrapeRunTrigger[] = ["scheduled", "manual", "script"];
export const SCRAPE_RUN_STATUSES: readonly ScrapeRunStatus[] = ["running", "succeeded", "partial", "failed"];

/**
 * One recorded error (the first MAX_RECORDED_ERRORS of a run). The message
 * is ALWAYS passed through redactSecrets() before it is stored.
 */
export interface ScrapeRunError {
  sourceId?: string; // visa: country code ("GB"); news: newsSources doc id
  url?: string; // the page / feed / API URL involved, when known (redacted)
  message: string; // redacted, capped at 500 chars
  at: Timestamp; // when it was recorded (run clock)
}

/**
 * Outcome of one source within a run.
 *  - succeeded / partial / failed: as for the run, scoped to the source;
 *  - empty: no page attempted (the source has no pages, or the run's
 *    extraction cap was used up before it); not an error;
 *  - deferred: nothing requested, every page's host was under a stored
 *    429/503 backoff (visa, #64) or the host backed off earlier this run (news).
 */
export type ScrapeRunSourceStatus = "succeeded" | "partial" | "failed" | "deferred" | "empty";

/** Per-source line of a run (the run detail's "sources" table). */
export interface ScrapeRunSourceEntry {
  sourceId: string; // visa: country code; news: newsSources doc id
  name: string; // country name / news source name
  status: ScrapeRunSourceStatus;
  pagesAttempted: number; // pages the run tried for this source (incl. deferred)
  pagesFetched: number; // pages fetched OK
  errors: number;
  // The per-source log doc this run wrote, for drill-down:
  // visa -> visaSources/{sourceId}/crawlRuns/{sourceRunId},
  // news -> newsSources/{sourceId}/scrapeRuns/{sourceRunId}.
  sourceRunId?: string;
  // Kind-specific counters (visa: created/updated/proposed/...; news:
  // articlesFound/New/Duplicate/Failed). Open map so later issues can add.
  counts?: Record<string, number>;
  error?: string; // redacted message when the source failed outright
}

/**
 * What happened to one page in a visa run (the run detail's per-page table,
 * #84 links `visaId` to Visa Review / the proposal).
 *  - created / updated / proposed / skipped: ingest outcomes (see
 *    visaCatalogService.ingestExtraction);
 *  - unchanged: hash gate, no extraction (or extraction produced no change);
 *  - withdrawn: source says withdrawn, never extracted;
 *  - deferred: host backed off, not requested;
 *  - capped: not attempted, the run's extraction cap was reached (script only;
 *    the orchestrator simply stops and the page waits for the next window);
 *  - supplement: a supplement-only registry row (#86, e.g. the KR fee
 *    table): never extracted, its text is appended to the routes that list
 *    it; `reason` says whether a route fetched it this run. Not counted in
 *    pagesAttempted;
 *  - error: fetch / extract / ingest failed (see `error`).
 */
export type ScrapeRunPageOutcome =
  | "created"
  | "updated"
  | "proposed"
  | "skipped"
  | "unchanged"
  | "withdrawn"
  | "deferred"
  | "capped"
  | "supplement"
  | "error";

/** Per-page line of a run. News runs record none (their unit is the source). */
export interface ScrapeRunPageEntry {
  sourceId: string;
  url: string;
  routeName?: string;
  outcome: ScrapeRunPageOutcome;
  visaId?: string; // resolved catalog id (countries/{sourceId}/visaTypes/{visaId})
  error?: string; // redacted, capped
  reason?: string; // why a non-error outcome happened (e.g. supplement rows)
  // ---- Issue #82: the LLM call made for this page, when one was made ----
  // Present on any page whose extraction reached the API (also on an `error`
  // page whose output then failed validation: that call was billed too).
  usage?: LlmUsage; // the provider's token counts for the call
  costUsd?: number; // from appConfig/llmPricing; absent when the model is unpriced
  model?: string; // the model requested ("deepseek-chat")
  promptVersion?: string; // EXTRACTOR_PROMPT_VERSION used
}

/**
 * Usage + cost aggregate of a run (issue #82): summed token counts of every
 * LLM call, the run's cost and its news API request counts per provider.
 * Same shape as the monthly rollup's buckets (CostTotals); `runs` is 1 on a
 * run doc so rollups can simply add.
 */
export type ScrapeRunUsage = CostTotals;

/** The `scrapeRuns/{runId}` document. */
export interface ScrapeRunDoc {
  id: string;
  kind: ScrapeRunKind;
  trigger: ScrapeRunTrigger;
  status: ScrapeRunStatus;

  // ---- Timing (run clock; see ScrapeRunRecorder) ----
  startedAt: Timestamp;
  finishedAt: Timestamp | null; // null while running
  durationMs: number | null; // null while running

  // ---- Counters ----
  // The scraper's full run summary, verbatim: visa = CrawlSummary
  // (visa-catalog-crawl.service.ts), news = OrchestratorResult (types/news.ts).
  // A map (not typed per kind) so a counter added to either summary lands
  // here with no schema change. Empty `{}` while running.
  summary: Record<string, number | boolean>;
  sourcesAttempted: number;
  pagesAttempted: number;
  sources: ScrapeRunSourceEntry[]; // capped at MAX_RECORDED_SOURCES
  pages: ScrapeRunPageEntry[]; // capped at MAX_RECORDED_PAGES
  pagesTruncated: boolean; // true when more pages ran than `pages` holds

  // ---- Errors ----
  errorCount: number; // every error in the run (not just the stored ones)
  errors: ScrapeRunError[]; // the first MAX_RECORDED_ERRORS, redacted
  // Set when the run itself threw (or was swept as stale): redacted message.
  // Cleared by a normal finalize (a late finalize after a stale sweep).
  fatalError?: string;
  // Run-level warnings (max 10, redacted): problems that are not errors and
  // do not affect `status` / `errorCount`, e.g. the FX fee re-convert failing.
  warnings?: string[];

  // ---- Context ----
  // The run's knobs, for reading a run later (e.g. maxSources,
  // maxExtractions; for a script run: country / visa / limit / force).
  options?: Record<string, string | number | boolean>;

  // ---- Cost (issue #82) — written by finalize()/fail(); absent on older docs ----
  usage?: ScrapeRunUsage; // tokens, extractions, request counts (see CostTotals)
  costUsd?: number; // = usage.costUsd (top-level so list views and #83 read it directly)
  // The same split by country (visa sourceId) and model. Feeds the monthly
  // rollup `scrapeCosts/{YYYY-MM}`. Runs with no LLM call have empty maps.
  costBreakdown?: RunCostBreakdown;

  // ---- Retention ----
  // TTL field: Firestore deletes the doc after this instant (startedAt +
  // SCRAPE_RUN_RETENTION_DAYS). Needs the TTL policy on collection group
  // `scrapeRuns`, field `expireAt` (firestore.indexes.json fieldOverrides).
  expireAt: Timestamp;

  createdAt: Timestamp;
  updatedAt: Timestamp;
}
