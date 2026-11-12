// ============================================
// Scrapers module: public API (issue #91)
// ============================================
//
// The ONLY runtime entry point into src/scrapers/ for code outside the module
// (src/index.ts, app.ts, the seeders, the app-facing visa service and
// controller). Everything under scrapers/<area>/ is internal: an ESLint
// `no-restricted-imports` rule (.eslintrc.js) refuses deep imports of it from
// outside src/scrapers/ (tests under test/scrapers/ are exempt). Types live in
// the sibling `scrapers/types.ts` barrel, which carries no runtime code.
//
// Import cycle: visa.service -> scrapers -> visa-catalog.service ->
// visa.service. It is safe because no module in that cycle uses an imported
// binding at load time (only inside functions/methods, at call time), so a
// partially loaded module is never read. Keep it that way: no top-level use
// of an import (e.g. `const x = imported.y`, `class A extends Imported`) in
// modules on the cycle, and no module-load side effects such as a top-level
// getFirestore() in anything this file pulls in.
//
// See README.md next to this file for the module map and its boundaries.

// ---- Scheduled-run entry points (src/index.ts) ----
/** Visa-catalog crawl orchestrator (crawlVisaCatalogOrchestrator). */
export { visaCatalogCrawlService } from "./visa-catalog/visa-catalog-crawl.service";
/** News scraper orchestrator (scrapeNewsOrchestrator). */
export { newsScraperService } from "./news/news-scraper.service";
/** Run records (#81); src/index.ts registers the alert finalize hook on it. */
export { scrapeRunService } from "./shared/runs/scrape-run.service";
/** Scraper alerts (#83): post-run hook + hourly check (checkScrapeAlerts). */
export { scrapeAlertService } from "./shared/alerts/scrape-alert.service";
/** Manual "Run now" worker (#96): src/index.ts's processScrapeRunRequest trigger. */
export { scrapeRunWorker } from "./shared/settings/scrape-run-worker";

// ---- Admin routers (app.ts) ----
/** Proposed edits to approved scraped visas (pendingVisaChanges, #61). */
export { adminVisaChangeRoutes } from "./visa-catalog/changes/visa-change.routes";
/** Run records, source health and monthly cost (#81, #82). */
export { adminScrapeCostRoutes, adminScrapeRunRoutes, adminScrapeSourceRoutes } from "./shared/runs/scrape-run.routes";
/** Scraper alerts: list / acknowledge / resolve (#83). */
export { adminScrapeAlertRoutes } from "./shared/alerts/scrape-alert.routes";
/** Scraper settings, per-source controls, Run now + request polling (#96). */
export {
  adminScrapeRunRequestRoutes,
  adminScrapeSourceControlRoutes,
  adminScraperRunRoutes,
  adminScraperSettingsRoutes,
} from "./shared/settings/scraper-settings.routes";

// ---- Seeders (scripts/seed-all.ts, scripts/seed-prod-bootstrap.ts) ----
/** News source registry seed. */
export { seedNewsSources } from "./news/seed-news-sources";
/** Visa source registry seed (reads the vendored markdown, #78). */
export { seedVisaSources } from "./visa-catalog/data/seed-visa-sources";
/** LLM price table seed (#82), via scrapeCostService.seedPricingIfAbsent. */
export { scrapeCostService } from "./shared/cost/scrape-cost.service";

// ---- Catalog rules used by the app-facing visa service / controller ----
/** Approval guard + typed error for a fee with no USD conversion (#59). */
export { assertVisaApprovable, VisaFeeNotConvertibleError } from "./visa-catalog/visa-catalog-fx";
/** Finite-only min for the denormalized country stats. */
export { finiteMin } from "./visa-catalog/visa-catalog-meta";
/** Manual USD cost on a pending scraped visa (#70). */
export { ManualCostError, parseManualCostInput, planManualCost } from "./visa-catalog/visa-manual-cost";
export type { ManualCostInput } from "./visa-catalog/visa-manual-cost";
/** Firestore doc-id check shared with the visa change routes. */
export { isValidDocId } from "./visa-catalog/changes/visa-catalog-changes.service";

// ---- Caseworker-guidance registry (issue #39) ----
/** Admin list of guidance sources (GET /admin/guidance-sources). */
export { adminGuidanceSourceRoutes } from "./guidance/guidance-source.routes";
/** Guidance crawl orchestrator (fetch, hash gate, snapshots). */
export { guidanceCrawlService } from "./guidance/guidance-crawl.service";
/** Snapshot text store, for backend quote validation only (never an API response). */
export { guidanceSnapshotStore } from "./guidance/guidance-snapshot.store";
/** Guidance source registry seed. */
export { seedGuidanceSources } from "./guidance/data/seed-guidance-sources";

// ---- Visa rubrics (issue #40) ----
/** Rubric extraction from guidance snapshots (always writes `pending_review`). */
export { rubricExtractionService } from "./rubric/rubric-extraction.service";
/**
 * Rubric store. Consumers use `getApprovedRubric` ONLY (an unapproved version
 * is never returned by it); the `...ForReview` reads are for the admin review
 * API (#125).
 */
export { rubricStore, rubricRouteKey } from "./rubric/rubric.store";
/** Structural rubric validator (the review API re-runs it before approving). */
export { validateVisaRubric } from "./rubric/rubric-validate";
/** Criterion exclusions (#161): the pure read-side filter, the preview and the limits. */
export { applyExclusions, previewExclusions, MAX_EXCLUDED_CRITERIA, EXCLUSION_NOTE_MAX } from "./rubric/rubric-exclusions";
export type { ExclusionPreview } from "./rubric/rubric-exclusions";
/** Validator issue shape (type-only; the review API reports it). */
export type { RubricIssue } from "./rubric/rubric-validate";
/** Verbatim-quote lookup in a stored snapshot (the review API's stale-citation check). */
export { SnapshotQuoteIndex } from "./rubric/rubric-quote";
/** Rubric types for consumers (the assessment engine, #42). Type-only. */
export type {
  AssessmentCriterion,
  CriterionAppliesTo,
  CriterionCheck,
  CriterionKind,
  DecisionStage,
  IntentPolarity,
  RubricCitation,
  VisaRubric,
} from "../types/rubric";
// ---- Published outcome statistics importer (issue #116) ----
/** Import orchestrator (quarterly schedule + manual runs). */
export { outcomeImportService, ImportAlreadyRunningError } from "./outcome-statistics/outcome-import.service";
/** "Run now" worker: src/index.ts's processOutcomeStatisticsRunRequest trigger. */
export { outcomeRunWorker } from "./outcome-statistics/outcome-run-worker";
/** Admin routes: list import runs, request a manual run (admin-only). */
export { adminOutcomeStatisticsRoutes } from "./outcome-statistics/outcome-statistics.routes";
/** Destinations with an outcome data source adapter. */
export { registeredDestinations } from "./outcome-statistics/registry";
