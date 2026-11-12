import type { Timestamp } from "firebase-admin/firestore";
import type { CrawlWindow } from "../../visa-catalog/types";
import type { ScraperSettingsKind } from "../runs/types";

// ============================================
// SCRAPER SETTINGS — shapes (issue #96)
// ============================================
//
// `appConfig/scraperSettings` holds the scraper knobs that used to be code
// constants (limits) plus the new switches (kill switch, hard stop, manual
// run cooldown). The budget amount, alert config and price table stay in
// their own docs (#82 / #83) so the engines that read them are unchanged;
// the admin API (scraper-settings.service.ts) fronts all four.
//
// Contract: scraper-settings.md next to this file.

/** Per-scraper switches shared by visa and news. */
export interface ScraperSwitches {
  // Kill switch for SCHEDULED ticks: false = the tick returns at once
  // (no stale sweep, no run doc, no fetch, no LLM call).
  enabled: boolean;
  // When `enabled` is false, also refuse manual "Run now" requests.
  blockManualWhenOff: boolean;
  // Issue #107: consecutive failed crawls after which the crawler auto-pauses
  // a source (status `broken` + `autoPaused`, no longer crawled unattended).
  // Per scraper (visa / news can differ). Integer 1..50, default 5.
  consecutiveFailureLimit: number;
}

/** Visa scraper settings. */
export interface VisaScraperSettings extends ScraperSwitches {
  maxExtractionsPerRun: number; // LLM calls per run (cost cap)
  maxSourcesPerTick: number; // countries per run
}

/** News scraper settings. */
export interface NewsScraperSettings extends ScraperSwitches {
  maxSourcesPerRun: number; // due sources scraped per run
}

/** Manual "Run now" settings. */
export interface ManualRunSettings {
  // Minimum gap between two Run now requests for the same source (or the
  // same whole-scraper run), in minutes.
  cooldownMinutes: number;
}

/** Budget policy kept on scraperSettings (the amount lives in appConfig/scrapeBudget). */
export interface BudgetPolicySettings {
  // Stop visa LLM extraction once month-to-date cost >= the monthly budget.
  hardStop: boolean;
}

/** The resolved runtime settings (every field filled in). */
export interface ScraperSettings {
  visa: VisaScraperSettings;
  news: NewsScraperSettings;
  manualRuns: ManualRunSettings;
  budget: BudgetPolicySettings;
}

/** The stored `appConfig/scraperSettings` doc (every field optional in storage). */
export interface ScraperSettingsDoc {
  visa?: Partial<VisaScraperSettings>;
  news?: Partial<NewsScraperSettings>;
  manualRuns?: Partial<ManualRunSettings>;
  budget?: Partial<BudgetPolicySettings>;
  updatedAt?: Timestamp;
  updatedBy?: string;
}

// ============================================
// AUDIT HISTORY — `scraperSettingsHistory/{id}`
// ============================================

/** One changed leaf field (dotted path) with its old and new value. */
export interface SettingsChange {
  path: string; // e.g. "visa.maxExtractionsPerRun", "alerts.rules.error_rate.enabled"
  before: unknown; // null when the field was absent
  after: unknown; // null when the field was removed
}

/** One history entry: one admin edit (settings PATCH or per-source PATCH). */
export interface SettingsHistoryDoc {
  id: string;
  at: Timestamp;
  by: string; // admin uid
  // "settings" for PATCH /admin/scraper-settings, "source:<kind>:<id>" for a
  // per-source PATCH.
  target: string;
  changes: SettingsChange[];
}

// ============================================
// PER-SOURCE ADMIN OVERRIDES (on visaSources / newsSources docs)
// ============================================

/** Statuses an admin may set (`broken` is set by the crawler only). */
export type AdminSourceStatus = "active" | "paused" | "retired";
export const ADMIN_SOURCE_STATUSES: readonly AdminSourceStatus[] = ["active", "paused", "retired"];

/**
 * `adminOverrides` block on a source doc. Applied to the live fields at once
 * by the admin API, and kept by the seeders on every re-seed (#57 / #78), so
 * an admin's pause or window edit is never undone by a deploy.
 */
export interface SourceAdminOverrides {
  status?: AdminSourceStatus; // the status the admin last set
  reason?: string; // why (required for paused / retired)
  crawlWindow?: CrawlWindow; // visa only: replaces the registry window
  updatedAt?: Timestamp;
  updatedBy?: string;
}

// ============================================
// MANUAL RUN REQUESTS — `scrapeRunRequests/{id}` + `scrapeRunLocks/{key}`
// ============================================

/** A request covers one source, or the whole scraper's due sources. */
export type ScrapeRunRequestScope = "source" | "scraper";

/**
 * Request lifecycle:
 *  - queued: written by the API; the onCreate worker has not picked it up;
 *  - running: the worker claimed it (runId set once the run doc exists);
 *  - succeeded: the orchestrator finished (the run itself may be partial / failed);
 *  - failed: the worker threw;
 *  - skipped: nothing to run (nothing due, source no longer active,
 *    scraper disabled with blockManualWhenOff).
 */
export type ScrapeRunRequestStatus = "queued" | "running" | "succeeded" | "failed" | "skipped";

/** The `scrapeRunRequests/{id}` doc. */
export interface ScrapeRunRequestDoc {
  id: string;
  kind: ScraperSettingsKind;
  scope: ScrapeRunRequestScope;
  sourceId: string | null; // set for scope "source"
  force: boolean; // ignore the content-hash gate (visa only)
  status: ScrapeRunRequestStatus;
  runId: string | null;
  requestedBy: string; // admin uid
  requestedAt: Timestamp;
  startedAt: Timestamp | null;
  finishedAt: Timestamp | null;
  summary: Record<string, number | boolean> | null;
  skipReason: string | null;
  error: string | null; // redacted
  lockId: string; // the scrapeRunLocks doc guarding it
  expireAt: Timestamp; // TTL (requestedAt + 30 days)
}

/** `scrapeRunLocks/{kind}__{sourceId | _all}`: one in flight + cooldown. */
export interface ScrapeRunLockDoc {
  activeRequestId: string | null; // the queued / running request, null when free
  activeSince: Timestamp | null;
  lastRequestedAt: Timestamp; // start of the cooldown
}
