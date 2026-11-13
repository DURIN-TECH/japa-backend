import { Timestamp } from "firebase-admin/firestore";
import type { ScrapeRunKind } from "../runs/types";

// ============================================
// SCRAPE ALERTS — alert records, rule ids, config (issue #83)
// ============================================
//
// Admins learn about scraper problems without watching a dashboard: rule
// checks run after every scraper run (the #81 finalize hook) and on an hourly
// check, and each problem becomes ONE `scrapeAlerts/{alertId}` doc that is
// bumped (count / lastSeen) while the problem lasts and auto-resolved when it
// clears. New and escalated alerts are emailed to admins (Resend, via
// notifyUser) and each alert action writes one structured JSON log line (the
// Cloud Monitoring backstop in the meta-repo's infra/terraform/).
//
// Code: scrapers/shared/alerts/scrape-alert-rules.ts (pure rule logic),
// scrapers/shared/alerts/scrape-alert.service.ts (store / email / checks / admin reads),
// scrapers/shared/alerts/scrape-alert.controller.ts (admin API). Contract:
// src/scrapers/shared/alerts/scrape-alerts.md.

/**
 * Alert severity, most severe first:
 *  - critical: scraping is broken or stopped (a run failed / is stuck, a
 *    source auto-paused, the monthly LLM budget is spent);
 *  - warning: degraded (error rate, repeated backoff, a missed window, FX
 *    refresh failing, linked-surcharge errors, 80% of budget);
 *  - info: worth knowing (review queue ageing, 50% of budget).
 */
export type ScrapeAlertSeverity = "critical" | "warning" | "info";

/** Every severity, for validating config / query params. */
export const SCRAPE_ALERT_SEVERITIES: readonly ScrapeAlertSeverity[] = ["critical", "warning", "info"];

/** Higher = more severe (escalation compares these). */
export const SEVERITY_RANK: Record<ScrapeAlertSeverity, number> = { info: 1, warning: 2, critical: 3 };

/**
 * Alert lifecycle:
 *  - open: the condition holds and nobody has picked it up;
 *  - acknowledged: an admin has seen it ("I'm on it"). Still bumped while
 *    the condition holds, but no more emails unless it ESCALATES (which
 *    re-opens it);
 *  - resolved: the condition cleared (autoResolved: true) or an admin
 *    resolved it by hand. A resolved alert is never re-opened: if the
 *    problem comes back, a NEW alert is created.
 */
export type ScrapeAlertStatus = "open" | "acknowledged" | "resolved";

/** Every status, for validating the list filter. */
export const SCRAPE_ALERT_STATUSES: readonly ScrapeAlertStatus[] = ["open", "acknowledged", "resolved"];

/**
 * The rules (one per bullet of the issue's first acceptance criterion):
 *  - run_failed: the latest run of a scraper finished `failed` (incl. runs
 *    the #81 stale sweep marked failed);
 *  - run_stuck: a run has been `running` for longer than stuckRunMinutes;
 *  - missed_window: a visa source's last weekly crawl window (#63) closed
 *    without the source being crawled;
 *  - source_broken: a source was auto-paused (`broken`, 5 consecutive failures);
 *  - error_rate: errors above errorRatePct of the pages in a run;
 *  - host_backoff: a host answered 429/503 (#64) on N consecutive runs that
 *    touched it;
 *  - linked_surcharge: a visa run had linkedSurchargeErrors (#69);
 *  - fx_refresh_failing: FX rates (#59) have not refreshed for fxFailingHours
 *    and the latest visa run's refresh failed;
 *  - llm_budget: month-to-date LLM cost past 50/80/100% of the budget (#82);
 *  - review_queue_stale: scraped visas pending review / open
 *    pendingVisaChanges waiting longer than reviewQueueMaxAgeDays;
 *  - budget_hard_stop (issue #96): a visa run skipped LLM extraction because
 *    the monthly budget was spent and the hard stop is on;
 *  - source_no_yield (issue #17): an active news source keeps SUCCEEDING while
 *    returning zero articles (articlesFound 0 for `zeroYieldRuns` runs in a
 *    row): usually a broken selector / feed that moved. A signal only; it
 *    never pauses the source;
 *  - settings_unreadable (issue #96 review): appConfig/scraperSettings could
 *    not be read, so scheduled ticks are skipped (they fail closed);
 *  - infrastructure_error (issue #143): a guidance run could not store its
 *    results (`summary.infrastructureErrors` non-empty: Cloud Storage or
 *    Firestore failed on OUR side). One alert per scraper, bumped by each
 *    run with the problem, resolved by the next run without it;
 *  - guidance_quote_drift (issue #150): after a guidance crawl, a passage a
 *    source must contain verbatim (data/guidance-quote-checks.ts) is missing
 *    from its latest snapshot: the publisher reworded it. One alert per
 *    source, resolved when the passages are found again.
 */
export type ScrapeAlertRule =
  | "run_failed"
  | "run_stuck"
  | "missed_window"
  | "source_broken"
  | "error_rate"
  | "host_backoff"
  | "linked_surcharge"
  | "fx_refresh_failing"
  | "llm_budget"
  | "review_queue_stale"
  | "budget_hard_stop"
  | "source_no_yield"
  | "settings_unreadable"
  | "infrastructure_error"
  | "guidance_quote_drift";

/** Every rule id (config validation, docs). */
export const SCRAPE_ALERT_RULES: readonly ScrapeAlertRule[] = [
  "run_failed",
  "run_stuck",
  "missed_window",
  "source_broken",
  "error_rate",
  "host_backoff",
  "linked_surcharge",
  "fx_refresh_failing",
  "llm_budget",
  "review_queue_stale",
  "budget_hard_stop",
  "source_no_yield",
  "settings_unreadable",
  "infrastructure_error",
  "guidance_quote_drift",
];

/**
 * What an alert is about (#84 links it):
 *  - scraper: a whole scraper, id = "visa" | "news" | "guidance";
 *  - run: one scrapeRuns doc, id = run id;
 *  - source: a visa source (id = country code) or news source (id = doc id);
 *    the alert's `kind` says which;
 *  - host: a hostname (host_backoff);
 *  - fx: the appConfig/fx rate doc (id "fx");
 *  - budget: a month, id = "YYYY-MM" (UTC);
 *  - review_queue: the visa review queue (id "visa").
 */
export type ScrapeAlertSubjectType = "scraper" | "run" | "source" | "host" | "fx" | "budget" | "review_queue";

/** The alert's subject: what to link to and how to name it. */
export interface ScrapeAlertSubject {
  type: ScrapeAlertSubjectType;
  id: string;
  label: string; // human label, e.g. "United Kingdom (visa source)"
}

/** Small, flat facts behind an alert (shown in the dashboard / email). */
export type ScrapeAlertDetails = Record<string, string | number | boolean | null>;

/** The `scrapeAlerts/{alertId}` document. */
export interface ScrapeAlertDoc {
  id: string; // auto id
  rule: ScrapeAlertRule;
  // Dedupe key: one ACTIVE (open | acknowledged) alert per key, e.g.
  // "run_failed:visa", "missed_window:GB", "host_backoff:visa:www.gov.uk".
  dedupeKey: string;
  severity: ScrapeAlertSeverity; // the highest seen while active
  // Escalation step within a severity ladder (llm_budget: 50 / 80 / 100).
  // Absent for rules without levels.
  level?: number;
  kind: ScrapeRunKind | null; // the scraper concerned, null when not scraper-specific
  subject: ScrapeAlertSubject;
  message: string; // latest description (refreshed on every bump)
  details?: ScrapeAlertDetails;
  lastRunId?: string; // the run that last raised / bumped it, when there is one
  // Review fix: true when the post-run hook stored this alert as new /
  // escalated but skipped the email because the scraper function was near its
  // timeout. The hourly check emails it and clears the flag.
  emailPending?: boolean;

  firstSeen: Timestamp;
  lastSeen: Timestamp;
  count: number; // 1 on create, +1 per new occurrence (see eventIds)
  // Recent occurrence ids (run ids, window openings ...), max 20. A check
  // that sees the SAME occurrence again (the hourly check re-reading the run
  // the finalize hook already reported) does not bump the count.
  eventIds?: string[];
  escalatedAt?: Timestamp; // last time severity / level went up

  status: ScrapeAlertStatus;
  acknowledgedBy?: string | null; // admin uid
  acknowledgedAt?: Timestamp | null;
  resolvedBy?: string | null; // admin uid, or "system" when auto-resolved
  resolvedAt?: Timestamp | null;
  autoResolved?: boolean; // true when the condition cleared on its own

  // TTL field (180 days): from lastSeen while active, from resolvedAt once
  // resolved. Needs the TTL policy on `scrapeAlerts.expireAt`
  // (firestore.indexes.json fieldOverrides).
  expireAt: Timestamp;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

/**
 * `scrapeAlertKeys/{sha256(dedupeKey)}` — pointer from a dedupe key to its
 * ACTIVE alert. Exists while that alert is open / acknowledged; deleted on
 * auto-resolve. Reading it inside the upsert transaction is what makes "one
 * active alert per key" hold under concurrent checks (a transaction can lock
 * a single doc, even a missing one, but not "no doc matches this query").
 *
 * TOMBSTONE (review fix): a MANUAL resolve of an alert that has occurrence
 * ids (run ids, window openings) keeps the pointer, pointing at the resolved
 * alert, with `suppressEventIds` = those ids. A later check that signals one
 * of the SAME occurrences (the hourly check re-reading the run the admin just
 * resolved) is then skipped instead of opening + emailing a new alert; a NEW
 * occurrence (a new failing run) replaces the tombstone with a new alert, and
 * an auto-resolve (condition cleared) deletes it.
 */
export interface ScrapeAlertKeyDoc {
  dedupeKey: string;
  alertId: string;
  createdAt: Timestamp;
  suppressEventIds?: string[]; // tombstone only: occurrences already resolved by hand
  resolvedAt?: Timestamp; // tombstone only
}

// ============================================
// CONFIG — `appConfig/scrapeAlerts`
// ============================================

/** Per-rule override (config). */
export interface ScrapeAlertRuleConfig {
  enabled?: boolean; // default true; a disabled rule's active alerts are resolved
  severity?: ScrapeAlertSeverity; // replaces the rule's default severity
}

/** Email settings (config). */
export interface ScrapeAlertEmailConfig {
  // Email new + escalated alerts right away (one email per check, listing them).
  immediate: boolean;
  // Lowest severity emailed immediately (lower ones wait for the digest).
  immediateMinSeverity: ScrapeAlertSeverity;
  // Daily digest of active alerts (sent by the hourly check at digestHourUtc).
  digest: boolean;
  digestHourUtc: number; // 0-23
  digestMinSeverity: ScrapeAlertSeverity; // lowest severity listed in the digest
}

/** Numeric thresholds (config). */
export interface ScrapeAlertThresholds {
  stuckRunMinutes: number; // run_stuck: `running` longer than this
  errorRatePct: number; // error_rate: errors / pages above this %
  errorRateMinPages: number; // error_rate: ignore runs with fewer pages
  backoffConsecutiveRuns: number; // host_backoff: streak length
  linkedSurchargeErrors: number; // linked_surcharge: alert at >= this (1 = "> 0")
  fxFailingHours: number; // fx_refresh_failing: last success older than this
  budgetPcts: number[]; // llm_budget: alert levels, % of budget (ascending)
  reviewQueueMaxAgeDays: number; // review_queue_stale: items older than this
  missedWindowGraceHours: number; // missed_window: wait this long after the window closes
  zeroYieldRuns: number; // source_no_yield (#17): alert at >= this many consecutive zero-article successful runs
}

/** The whole `appConfig/scrapeAlerts` doc (every field optional in storage). */
export interface ScrapeAlertsConfig {
  enabled: boolean; // master switch: false = no checks, no emails
  // Who gets the emails: these admin uids, or (empty) every admin user.
  // Non-admin uids are ignored, so a stale list can never leak alerts.
  recipientUserIds: string[];
  // Issue #96: extra email addresses that also receive every alert email
  // (immediate + digest), e.g. an ops mailbox. Set by admins only (the
  // scraper settings API); at most MAX_EXTRA_RECIPIENT_EMAILS.
  extraRecipientEmails: string[];
  email: ScrapeAlertEmailConfig;
  thresholds: ScrapeAlertThresholds;
  rules: Partial<Record<ScrapeAlertRule, ScrapeAlertRuleConfig>>;
}

/** `appConfig/scrapeAlertsState` — engine bookkeeping (not admin config). */
export interface ScrapeAlertsState {
  lastDigestDay?: string; // "YYYY-MM-DD" (UTC) of the last digest sent
  lastDigestAt?: Timestamp;
}
