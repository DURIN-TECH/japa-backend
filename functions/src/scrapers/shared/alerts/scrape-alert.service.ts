import { createHash } from "crypto";
import { logger } from "firebase-functions";
import type { LogEntry } from "firebase-functions/logger";
import { Timestamp, type Transaction } from "firebase-admin/firestore";
import { collections, db, subcollections } from "../../../utils/firebase";
import { notificationService, type NotifyUserInput } from "../../../services/notification.service";
import { claimsService } from "../../../services/claims.service";
import { EMAIL_BRANDING } from "../../../services/email/branding";
// Issue #96: alert emails to the extra (non-user) addresses go straight
// through the branded email service (notifyUser needs a user id).
import { emailService } from "../../../services/email/email.service";
import type { EmailResult } from "../../../services/email/email.types";
// Issue #96 review: the hourly check reads the scraper settings (readable?
// hard stop on?) for settings_unreadable and the budget_hard_stop clear.
import { loadScraperSettingsResult, type LoadedScraperSettings } from "../settings/scraper-settings.store";
import { safeErrorMessage, toJson } from "../runs/scrape-run.service";
import { scrapeCostMonthToDateSource, type MonthToDateCostSource } from "./scrape-alert-cost";
import {
  DEFAULT_CONFIG,
  evaluateBrokenSources,
  evaluateNoYieldSources,
  evaluateBudget,
  evaluateBudgetHardStop,
  evaluateBudgetHardStopClears,
  evaluateSettingsReadable,
  evaluateErrorRate,
  evaluateFx,
  evaluateHostBackoff,
  evaluateHostBackoffClears,
  evaluateInfrastructureErrors,
  evaluateLinkedSurcharge,
  evaluateMissedWindows,
  evaluateReviewQueue,
  evaluateRunFailed,
  evaluateRunNoLongerStuck,
  evaluateStuckRuns,
  msOf,
  resolveConfig,
  ruleEnabled,
  type AlertSignal,
  type NewsSourceFacts,
  type ReviewQueueItem,
  type RuleEvaluation,
  type VisaSourceFacts,
} from "./scrape-alert-rules";
import {
  SEVERITY_RANK,
  type ScrapeAlertDoc,
  type ScrapeAlertKeyDoc,
  type ScrapeAlertRule,
  type ScrapeAlertSeverity,
  type ScrapeAlertStatus,
  type ScrapeAlertsConfig,
  type ScrapeAlertsState,
} from "./types";
import { SCRAPE_RUN_KINDS, type ScrapeRunDoc, type ScrapeRunKind } from "../runs/types";
import type { DocumentData, UpdateData } from "firebase-admin/firestore";
// Transaction.update() wants UpdateData<DocumentData>; the field maps built here are
// Record<string, unknown> (dotted paths + FieldValue sentinels), which tsc rejects.
type FsUpdate = UpdateData<DocumentData>;

// ============================================
// SCRAPE ALERTS — store, email, checks, admin reads (issue #83)
// ============================================
//
// Two entry points evaluate the rules (scrapers/shared/alerts/scrape-alert-rules.ts):
//
//   onRunFinalized(run)  — the #81 finalize hook (registered in index.ts),
//                          after EVERY visa / news run: run_failed,
//                          run_stuck (clears), error_rate, linked_surcharge,
//                          host_backoff, source_broken (that kind).
//   runHourlyCheck()     — the `checkScrapeAlerts` scheduled function
//                          (hourly, :45 UTC): run_stuck, run_failed (latest
//                          finished run per scraper — catches the runs the
//                          #81 stale sweep marks failed, which fire no hook),
//                          missed_window, source_broken, fx_refresh_failing,
//                          llm_budget, review_queue_stale; then the daily
//                          digest when due.
//
// Both hand their RuleEvaluations to applyEvaluations(), which for each:
//   - upserts every signal: one ACTIVE alert per dedupe key (pointer doc in
//     `scrapeAlertKeys`, read in the same transaction). Existing active
//     alert -> bumped (lastSeen, count+1 unless the same occurrence) or
//     escalated (severity / level went up; re-opens an acknowledged alert);
//     none -> a new alert is created;
//   - auto-resolves the active alerts in the evaluation's scope that were
//     not signalled (resolvedBy "system", autoResolved true);
//   - writes ONE structured JSON log line per action (event "scrape_alert",
//     the Cloud Monitoring backstop filters on it);
//   - emails new + escalated alerts (>= immediateMinSeverity) to the admin
//     recipients through notifyUser (Resend, branded template) — ONE email
//     per check listing them, not one per alert.
//
// Nothing here may break a scraper run: onRunFinalized never throws (the
// hook runner would swallow it anyway), every rule's reads are isolated so
// one failing read skips only that rule (and never resolves its alerts),
// and email failures are logged and ignored.

/** Alerts are TTL-deleted this many days after lastSeen / resolvedAt. */
export const SCRAPE_ALERT_RETENTION_DAYS = 180;
/** Occurrence ids kept per alert (see ScrapeAlertDoc.eventIds). */
const MAX_EVENT_IDS = 20;
/** Earlier runs read for the host-backoff streak. */
const BACKOFF_LOOKBACK_RUNS = 20;
/** Runs read per scraper to find its latest finished one (hourly run_failed). */
const LATEST_RUN_LOOKBACK = 10;
/** Open review-queue changes read at most (they are counted, not listed). */
const REVIEW_QUEUE_MAX_CHANGES = 500;
/** Admin list defaults (GET /admin/scrape-alerts). */
export const SCRAPE_ALERT_LIST_DEFAULT_LIMIT = 25;
export const SCRAPE_ALERT_LIST_MAX_LIMIT = 100;
/**
 * Post-run hook time budget (review fix). The scraper functions have a 540s
 * timeout and the hook runs after the crawl, inside it. `run.durationMs` is
 * the run's real elapsed time (≈ time since the function started), so:
 *  - past HOOK_SKIP_AFTER_MS the hook does nothing (the hourly check still
 *    catches run_failed; that run's per-run rules are lost);
 *  - past HOOK_NO_EMAIL_AFTER_MS alerts are stored but not emailed; they are
 *    flagged `emailPending` and the hourly check emails them.
 */
export const SCRAPER_FUNCTION_TIMEOUT_MS = 540_000;
export const HOOK_SKIP_AFTER_MS = 500_000;
export const HOOK_NO_EMAIL_AFTER_MS = 450_000;
/** Most alerts listed in one email. */
const MAX_ALERTS_PER_EMAIL = 25;
/**
 * Portal page the emails link to. TODO(#84): the scraper dashboard's real
 * alerts route once it exists.
 */
export const SCRAPE_ALERTS_PORTAL_PATH = "/admin/scrapers?tab=alerts";
/** `appConfig` doc ids. */
export const SCRAPE_ALERTS_CONFIG_DOC = "scrapeAlerts";
export const SCRAPE_ALERTS_STATE_DOC = "scrapeAlertsState";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Statuses that count as "active" (one per dedupe key). */
const ACTIVE_STATUSES: ScrapeAlertStatus[] = ["open", "acknowledged"];

/** Short rule names for email subjects / log messages. */
export const RULE_TITLES: Record<ScrapeAlertRule, string> = {
  run_failed: "run failed",
  run_stuck: "run stuck",
  missed_window: "missed crawl window",
  source_broken: "source auto-paused",
  error_rate: "high error rate",
  host_backoff: "host backing off",
  linked_surcharge: "linked surcharge errors",
  fx_refresh_failing: "FX refresh failing",
  llm_budget: "LLM budget",
  review_queue_stale: "review queue waiting",
  budget_hard_stop: "LLM budget hard stop",
  source_no_yield: "source returns no articles",
  settings_unreadable: "scraper settings unreadable",
  infrastructure_error: "guidance crawl infrastructure error",
  rubric_auto_published: "rulebook published automatically",
  rubric_draft_held: "rulebook draft held",
};

/** Cloud Logging severity per alert severity (resolutions log as INFO). */
const LOG_SEVERITY: Record<ScrapeAlertSeverity, LogEntry["severity"]> = {
  critical: "CRITICAL",
  warning: "WARNING",
  info: "INFO",
};

/** What happened to one alert in a check. */
export type AlertActionKind = "created" | "bumped" | "escalated" | "resolved" | "acknowledged";

/** One alert action (the alert as it stands AFTER the action). */
export interface AlertAction {
  action: AlertActionKind;
  alert: ScrapeAlertDoc;
}

/** Result of a check (logged by the scheduled function; returned in tests). */
export interface AlertCheckResult {
  actions: AlertAction[];
  emailed: number; // alerts included in the immediate email
  recipients: number; // admins it went to
  digestSent: boolean;
  skippedRules: string[]; // rules whose reads failed this time
}

/** An alert as the API returns it (ISO dates, no internal eventIds). */
export type ScrapeAlertJson = Record<string, unknown> & { id: string };

/** Filters for listAlerts (validated by the controller). */
export interface ListAlertsQuery {
  status?: ScrapeAlertStatus; // "open" includes acknowledged
  limit: number;
  cursor?: string; // an alert id from the previous page's nextCursor
}

/** Thrown for a cursor that names no alert (-> 400). */
export class InvalidAlertCursorError extends Error {
  constructor() {
    super("cursor does not match a scrape alert");
  }
}

/** Outcome of acknowledge / resolve. */
export type AlertMutationResult =
  | { outcome: "ok"; alert: ScrapeAlertJson }
  | { outcome: "not_found" }
  | { outcome: "already_resolved"; alert: ScrapeAlertJson };

/** Pointer doc id for a dedupe key (keys contain ':' and '.', ids must not be paths). */
export function alertKeyId(dedupeKey: string): string {
  return createHash("sha256").update(dedupeKey).digest("hex").slice(0, 40);
}

/** TTL instant `SCRAPE_ALERT_RETENTION_DAYS` after `fromMs`. */
function expireAtFrom(fromMs: number): Timestamp {
  return Timestamp.fromMillis(fromMs + SCRAPE_ALERT_RETENTION_DAYS * DAY_MS);
}

/** An alert doc -> API JSON (ISO dates; eventIds are internal). */
function alertJson(id: string, data: unknown): ScrapeAlertJson {
  const { eventIds: _e, ...rest } = (data ?? {}) as Record<string, unknown>;
  void _e;
  return { ...(toJson(rest) as Record<string, unknown>), id };
}

/** "[Critical]" etc. */
function sevLabel(s: ScrapeAlertSeverity): string {
  return `[${s.charAt(0).toUpperCase()}${s.slice(1)}]`;
}

// ============================================
// SERVICE
// ============================================

export class ScrapeAlertService {
  /** Transaction runner. Swapped for the in-memory one in tests. */
  runTransaction: <T>(fn: (tx: Transaction) => Promise<T>) => Promise<T> = (fn) => db.runTransaction(fn);

  /** Real clock (ms). Swappable in tests. */
  realClock: () => number = Date.now;

  /**
   * Month-to-date LLM cost + budget for the llm_budget rule: #82's rollup
   * via scrapeCostService.monthToDate() (scrape-alert-cost.ts). Swappable in
   * tests.
   */
  costSource: MonthToDateCostSource = scrapeCostMonthToDateSource();

  /**
   * Structured log writer (one JSON line per alert action). firebase-functions'
   * logger writes `jsonPayload` entries with a real `severity` in Cloud
   * Logging, which the Terraform log-based alert filters on. Swappable in tests.
   */
  log: (entry: LogEntry) => void = (entry) => logger.write(entry);

  /** Email delivery: the existing notifyUser path (Resend). Swappable in tests. */
  notify: (input: NotifyUserInput) => Promise<void> = (input) => notificationService.notifyUser(input);

  /** Issue #96 review: scraper settings reader (hourly check). Swappable in tests. */
  loadSettings: () => Promise<LoadedScraperSettings> = () => loadScraperSettingsResult();

  /**
   * Issue #96: email to an extra recipient address (config
   * extraRecipientEmails), via the branded template. Swappable in tests.
   */
  sendEmail: (input: { to: string; subject: string; title: string; body: string; actionUrl: string }) => Promise<EmailResult> = (
    input
  ) =>
    emailService.sendNotification({
      to: input.to,
      subject: input.subject,
      title: input.title,
      body: input.body,
      actionUrl: input.actionUrl,
      actionLabel: "Open the scraper dashboard",
      // No agency co-brand: these are platform (Seli) emails.
      agency: null,
    });

  // ---------- Config ----------

  /**
   * Read `appConfig/scrapeAlerts` merged over the defaults. When the doc does
   * not exist yet it is written with the defaults, so admins find every
   * threshold in Firestore to edit (thresholds live in config, not code).
   * Invalid values fall back to defaults and are logged. A failed read uses
   * the defaults (alerting must not stop because config could not load).
   */
  async loadConfig(): Promise<ScrapeAlertsConfig> {
    try {
      const ref = collections.appConfig.doc(SCRAPE_ALERTS_CONFIG_DOC);
      const snap = await ref.get();
      if (!snap.exists) {
        try {
          await ref.set(DEFAULT_CONFIG);
        } catch (err) {
          console.warn(`Scrape alerts: could not write default config: ${safeErrorMessage(err)}`);
        }
        return resolveConfig(DEFAULT_CONFIG).config;
      }
      const { config, problems } = resolveConfig(snap.data());
      for (const p of problems) console.warn(`Scrape alerts config (appConfig/${SCRAPE_ALERTS_CONFIG_DOC}): ${p}`);
      return config;
    } catch (err) {
      this.engineError("config", err);
      return resolveConfig(DEFAULT_CONFIG).config;
    }
  }

  // ---------- Entry point 1: after every run (finalize hook) ----------

  /**
   * The #81 finalize hook: evaluate the run-scoped rules for `run`. Never
   * throws. Script runs (CLI) are ignored: someone is watching those.
   */
  async onRunFinalized(run: ScrapeRunDoc): Promise<AlertCheckResult | undefined> {
    try {
      if (run.trigger === "script") return undefined;
      // ---- Time budget (see HOOK_SKIP_AFTER_MS) ----
      const elapsed = run.durationMs ?? 0;
      if (elapsed >= HOOK_SKIP_AFTER_MS) {
        console.warn(`Scrape alerts: run ${run.id} took ${elapsed}ms, too close to the function timeout; post-run rules skipped (hourly check covers run_failed)`);
        return undefined;
      }
      const deferEmail = elapsed >= HOOK_NO_EMAIL_AFTER_MS;
      const config = await this.loadConfig();
      if (!config.enabled) return undefined;
      const nowMs = this.realClock();
      const skippedRules: string[] = [];
      const evals: RuleEvaluation[] = [
        evaluateRunFailed(run, config),
        evaluateRunNoLongerStuck(run),
        evaluateErrorRate(run, config),
        evaluateLinkedSurcharge(run, config),
        // Issue #96: the hard stop blocked extraction in this run.
        evaluateBudgetHardStop(run, config),
        // Issue #143: a guidance run that could not store its results.
        evaluateInfrastructureErrors(run, config),
      ];
      // Host backoff needs the earlier runs of the same scraper.
      await this.isolated("host_backoff", skippedRules, async () => {
        evals.push(evaluateHostBackoff(run, await this.previousRuns(run), config));
      });
      // The run may just have auto-paused a source: check that kind now
      // rather than waiting for the hourly check.
      await this.isolated("source_broken", skippedRules, async () => {
        evals.push(evaluateBrokenSources(run.kind, await this.sourceFacts(run.kind), config));
      });
      // Issue #17: a news run may just have extended a zero-yield streak.
      if (run.kind === "news") {
        await this.isolated("source_no_yield", skippedRules, async () => {
          evals.push(evaluateNoYieldSources((await this.sourceFacts("news")) as NewsSourceFacts[], config));
        });
      }
      return await this.finish(evals, config, nowMs, skippedRules, false, deferEmail);
    } catch (err) {
      this.engineError("finalize", err, run.id);
      return undefined;
    }
  }

  // ---------- Entry point 2: the hourly check ----------

  /**
   * The hourly check (`checkScrapeAlerts`). Queries what no hook reports:
   * stuck runs, the latest finished run per scraper (the stale sweep marks
   * runs failed without hooks), source state, FX, budget and the review
   * queue; then sends the daily digest when due. Never throws.
   */
  async runHourlyCheck(nowMs: number = this.realClock()): Promise<AlertCheckResult> {
    const empty: AlertCheckResult = { actions: [], emailed: 0, recipients: 0, digestSent: false, skippedRules: [] };
    try {
      const config = await this.loadConfig();
      if (!config.enabled) return empty;
      const skippedRules: string[] = [];
      const evals: RuleEvaluation[] = [];

      // ---- Runs ----
      await this.isolated("run_stuck", skippedRules, async () => {
        const snap = await collections.scrapeRuns.where("status", "==", "running").get();
        evals.push(evaluateStuckRuns(snap.docs.map((d) => d.data() as ScrapeRunDoc), nowMs, config));
      });
      const latest: Partial<Record<ScrapeRunKind, ScrapeRunDoc>> = {};
      // Every kind (visa, news, guidance): SCRAPE_RUN_KINDS, not a literal list.
      for (const kind of SCRAPE_RUN_KINDS) {
        await this.isolated(`run_failed:${kind}`, skippedRules, async () => {
          const run = await this.latestFinishedRun(kind);
          latest[kind] = run;
          if (run) evals.push(evaluateRunFailed(run, config));
        });
      }

      // ---- Sources ----
      await this.isolated("missed_window", skippedRules, async () => {
        evals.push(evaluateMissedWindows((await this.sourceFacts("visa")) as VisaSourceFacts[], nowMs, config));
      });
      for (const kind of SCRAPE_RUN_KINDS) {
        await this.isolated(`source_broken:${kind}`, skippedRules, async () => {
          evals.push(evaluateBrokenSources(kind, await this.sourceFacts(kind), config));
        });
      }
      // Issue #17: zero-yield news sources (next to source_broken).
      await this.isolated("source_no_yield", skippedRules, async () => {
        evals.push(evaluateNoYieldSources((await this.sourceFacts("news")) as NewsSourceFacts[], config));
      });

      // ---- host_backoff clears no run reports (review fix) ----
      // Paused / retired / removed sources, or the host's retry-after passed.
      await this.isolated("host_backoff_clear", skippedRules, async () => {
        const active = await collections.scrapeAlerts
          .where("rule", "==", "host_backoff")
          .where("status", "in", ACTIVE_STATUSES)
          .get();
        if (active.empty) return;
        const sourceStatus: Partial<Record<ScrapeRunKind, Map<string, string>>> = {};
        for (const kind of SCRAPE_RUN_KINDS) {
          sourceStatus[kind] = new Map((await this.sourceFacts(kind)).map((f) => [f.id, String(f.status ?? "")]));
        }
        evals.push(evaluateHostBackoffClears(active.docs.map((d) => d.data() as ScrapeAlertDoc), sourceStatus, nowMs));
      });

      // ---- FX (#59) ----
      // Only when the latest visa run could be read (else we can't tell
      // "failing" from "not tried").
      if (!skippedRules.includes("run_failed:visa")) {
        await this.isolated("fx_refresh_failing", skippedRules, async () => {
          const fx = await collections.appConfig.doc("fx").get();
          evals.push(evaluateFx(fx.exists ? msOf(fx.data()?.fetchedAt) : undefined, latest.visa, nowMs, config));
        });
      }

      // ---- Scraper settings readable? (#96 review: ticks fail closed) ----
      let loadedSettings: LoadedScraperSettings | undefined;
      await this.isolated("settings_unreadable", skippedRules, async () => {
        loadedSettings = await this.loadSettings();
        evals.push(evaluateSettingsReadable(loadedSettings.readError, config));
      });

      // ---- LLM budget (#82; skipped while no budget is set) ----
      await this.isolated("llm_budget", skippedRules, async () => {
        // Catch #82's rollup up first (runs whose post-run rollup was lost),
        // so the spend compared to the budget is complete.
        await this.costSource.catchUp?.(nowMs);
        const cost = await this.costSource.getMonthToDateCost(nowMs);
        const evaluation = evaluateBudget(cost, nowMs, config);
        if (evaluation) evals.push(evaluation);
        // #96 review: budget_hard_stop resolves only on a real check that
        // finds the stop off / no budget / spend under it.
        if (loadedSettings && !loadedSettings.readError) {
          evals.push(evaluateBudgetHardStopClears(loadedSettings.settings.budget.hardStop, cost));
        }
      });

      // ---- Review queue ----
      await this.isolated("review_queue_stale", skippedRules, async () => {
        evals.push(evaluateReviewQueue(await this.reviewQueueItems(nowMs, config), nowMs, config));
      });

      const result = await this.finish(evals, config, nowMs, skippedRules, true);
      return result;
    } catch (err) {
      this.engineError("hourly", err);
      return empty;
    }
  }

  // ---------- Shared: apply + email ----------

  /** Apply the evaluations, email new / escalated ones, and (hourly) the digest. */
  private async finish(
    evals: RuleEvaluation[],
    config: ScrapeAlertsConfig,
    nowMs: number,
    skippedRules: string[],
    hourly: boolean,
    deferEmail = false
  ): Promise<AlertCheckResult> {
    const actions = await this.applyEvaluations(evals, config, nowMs, { deferEmail });
    if (deferEmail) {
      // Stored with emailPending: the hourly check sends them.
      return { actions, emailed: 0, recipients: 0, digestSent: false, skippedRules };
    }
    // Hourly: also email what a post-run hook stored but could not send.
    const toEmail = hourly ? [...actions, ...(await this.pendingEmailActions(actions))] : actions;
    const { emailed, recipients } = await this.emailImmediate(toEmail, config);
    if (hourly) await this.clearEmailPending(toEmail);
    const digestSent = hourly ? await this.sendDigestIfDue(config, nowMs) : false;
    return { actions, emailed, recipients, digestSent, skippedRules };
  }

  /**
   * Apply evaluations raised by ANOTHER pipeline (issue #201: the rubric
   * publish pipeline hands the facts of one run to the rubric rules) and email
   * the new / escalated ones like any other alert. NEVER throws: an alert
   * failure must not fail or undo a publish. Returns the actions taken (empty
   * when alerting is switched off or failed).
   */
  async raise(evals: RuleEvaluation[], config?: ScrapeAlertsConfig): Promise<AlertAction[]> {
    try {
      const cfg = config ?? (await this.loadConfig());
      if (!cfg.enabled) return [];
      const result = await this.finish(evals, cfg, this.realClock(), [], false);
      return result.actions;
    } catch (err) {
      this.engineError("raise", err);
      return [];
    }
  }

  /** Run one rule's reads; on failure log, note the rule as skipped, go on. */
  private async isolated(rule: string, skipped: string[], fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      skipped.push(rule);
      this.engineError(`rule:${rule}`, err);
    }
  }

  /**
   * Apply evaluations: upsert signals, auto-resolve cleared alerts in scope.
   * A disabled rule (config) has its active alerts resolved and raises none.
   * Each alert write is its own transaction; one failing write is logged and
   * the rest go on.
   */
  async applyEvaluations(
    evals: RuleEvaluation[],
    config: ScrapeAlertsConfig,
    nowMs: number,
    opts: { deferEmail?: boolean } = {}
  ): Promise<AlertAction[]> {
    const actions: AlertAction[] = [];
    for (const raw of evals) {
      const evaluation: RuleEvaluation = ruleEnabled(config, raw.rule) ? raw : { rule: raw.rule, signals: [], scope: "all" };
      const signalled = new Set(evaluation.signals.map((s) => s.key));

      // ---- Signals ----
      for (const signal of evaluation.signals) {
        try {
          const action = await this.upsert(signal, nowMs, opts.deferEmail === true);
          if (action) actions.push(action);
        } catch (err) {
          this.engineError(`upsert:${signal.key}`, err);
        }
      }

      // ---- Auto-resolve what this evaluation covers but did not signal ----
      let keys: string[] = [];
      try {
        if (evaluation.scope === "all" || "keyPrefix" in evaluation.scope) {
          const prefix = evaluation.scope === "all" ? "" : evaluation.scope.keyPrefix;
          const snap = await collections.scrapeAlerts
            .where("rule", "==", evaluation.rule)
            .where("status", "in", ACTIVE_STATUSES)
            .get();
          keys = snap.docs.map((d) => (d.data() as ScrapeAlertDoc).dedupeKey).filter((k) => k.startsWith(prefix));
        } else {
          keys = evaluation.scope.keys;
        }
      } catch (err) {
        this.engineError(`scope:${evaluation.rule}`, err);
      }
      for (const key of new Set(keys)) {
        if (signalled.has(key)) continue;
        try {
          const action = await this.resolveKey(key, nowMs);
          if (action) actions.push(action);
        } catch (err) {
          this.engineError(`resolve:${key}`, err);
        }
      }
    }
    for (const a of actions) this.logAction(a);
    return actions;
  }

  /**
   * Create or bump the ACTIVE alert for `signal.key`, in one transaction
   * guarded by the key's pointer doc. Returns null when nothing changed (the
   * same occurrence seen again, no escalation).
   */
  private async upsert(signal: AlertSignal, nowMs: number, deferEmail: boolean): Promise<AlertAction | null> {
    const pointerRef = collections.scrapeAlertKeys.doc(alertKeyId(signal.key));
    const now = Timestamp.fromMillis(nowMs);
    return this.runTransaction(async (tx) => {
      // ---- Reads (all before writes, as Firestore requires) ----
      const pointer = await tx.get(pointerRef);
      const pointed = pointer.exists ? (pointer.data() as ScrapeAlertKeyDoc) : undefined;
      const alertRef = pointed ? collections.scrapeAlerts.doc(pointed.alertId) : undefined;
      const existingSnap = alertRef ? await tx.get(alertRef) : undefined;
      const existing = existingSnap?.exists ? (existingSnap.data() as ScrapeAlertDoc) : undefined;

      // ---- Tombstone of a manual resolve: same occurrence -> skip ----
      // (see ScrapeAlertKeyDoc). Without this, the hourly check would re-read
      // the run an admin just resolved and open + email a new alert for it.
      if (
        existing?.status === "resolved" &&
        signal.eventId !== undefined &&
        (pointed?.suppressEventIds ?? []).includes(signal.eventId)
      ) {
        return null;
      }

      // ---- Bump / escalate the active alert ----
      if (existing && alertRef && existing.status !== "resolved") {
        const eventIds = existing.eventIds ?? [];
        const sameEvent = signal.eventId !== undefined && eventIds.includes(signal.eventId);
        const escalated =
          SEVERITY_RANK[signal.severity] > SEVERITY_RANK[existing.severity] ||
          (signal.level ?? 0) > (existing.level ?? 0);
        if (sameEvent && !escalated) return null;
        const update: Record<string, unknown> = {
          message: signal.message,
          details: signal.details ?? {},
          lastSeen: now,
          count: sameEvent ? existing.count : (existing.count ?? 1) + 1,
          updatedAt: now,
          expireAt: expireAtFrom(nowMs),
        };
        if (signal.eventId !== undefined && !sameEvent) update.eventIds = [...eventIds, signal.eventId].slice(-MAX_EVENT_IDS);
        if (signal.runId) update.lastRunId = signal.runId;
        if (escalated) {
          // Keep the highest severity / level seen; an escalation re-opens an
          // acknowledged alert (the admin acknowledged something milder).
          if (SEVERITY_RANK[signal.severity] > SEVERITY_RANK[existing.severity]) update.severity = signal.severity;
          if ((signal.level ?? 0) > (existing.level ?? 0)) update.level = signal.level;
          update.escalatedAt = now;
          if (deferEmail) update.emailPending = true;
          if (existing.status === "acknowledged") {
            update.status = "open";
            update.acknowledgedBy = null;
            update.acknowledgedAt = null;
          }
        }
        tx.update(alertRef, update as FsUpdate);
        return { action: escalated ? "escalated" : "bumped", alert: { ...existing, ...update } as ScrapeAlertDoc };
      }

      // ---- No active alert: create one (and point the key at it) ----
      const ref = collections.scrapeAlerts.doc();
      const doc: ScrapeAlertDoc = {
        id: ref.id,
        rule: signal.rule,
        dedupeKey: signal.key,
        severity: signal.severity,
        ...(signal.level !== undefined ? { level: signal.level } : {}),
        kind: signal.kind,
        subject: signal.subject,
        message: signal.message,
        details: signal.details ?? {},
        ...(signal.runId ? { lastRunId: signal.runId } : {}),
        firstSeen: now,
        lastSeen: now,
        count: 1,
        ...(deferEmail ? { emailPending: true } : {}),
        eventIds: signal.eventId !== undefined ? [signal.eventId] : [],
        status: "open",
        acknowledgedBy: null,
        acknowledgedAt: null,
        resolvedBy: null,
        resolvedAt: null,
        autoResolved: false,
        expireAt: expireAtFrom(nowMs),
        createdAt: now,
        updatedAt: now,
      };
      tx.set(ref, doc);
      tx.set(pointerRef, { dedupeKey: signal.key, alertId: ref.id, createdAt: now } satisfies ScrapeAlertKeyDoc);
      return { action: "created", alert: doc };
    });
  }

  /**
   * Auto-resolve the active alert for `key` (the condition cleared). Also
   * removes a stale pointer (its alert gone / already resolved, incl. a
   * manual-resolve tombstone). Returns null when there was nothing active, or
   * when the alert was seen after `nowMs` (the evaluation's start: see the
   * race guard below).
   */
  private async resolveKey(key: string, nowMs: number): Promise<AlertAction | null> {
    const pointerRef = collections.scrapeAlertKeys.doc(alertKeyId(key));
    const now = Timestamp.fromMillis(nowMs);
    return this.runTransaction(async (tx) => {
      const pointer = await tx.get(pointerRef);
      if (!pointer.exists) return null;
      const alertRef = collections.scrapeAlerts.doc((pointer.data() as ScrapeAlertKeyDoc).alertId);
      const snap = await tx.get(alertRef);
      const alert = snap.exists ? (snap.data() as ScrapeAlertDoc) : undefined;
      // Race guard (review fix): another check (a finalize hook running
      // alongside the hourly check) re-raised this alert AFTER this
      // evaluation read its data. Its sighting is newer than our "clear"
      // verdict, so leave the alert (and its pointer) alone.
      if (alert && alert.status !== "resolved" && (msOf(alert.lastSeen) ?? 0) > nowMs) return null;
      tx.delete(pointerRef);
      if (!alert || alert.status === "resolved") return null;
      const update = {
        status: "resolved" as const,
        resolvedBy: "system",
        resolvedAt: now,
        autoResolved: true,
        updatedAt: now,
        expireAt: expireAtFrom(nowMs),
      };
      tx.update(alertRef, update as FsUpdate);
      return { action: "resolved", alert: { ...alert, ...update } };
    });
  }

  /** One structured JSON log line per alert action (Terraform backstop). */
  private logAction(a: AlertAction): void {
    const { alert } = a;
    try {
      this.log({
        severity: a.action === "resolved" || a.action === "acknowledged" ? "INFO" : LOG_SEVERITY[alert.severity],
        message: `scrape alert ${a.action}: ${sevLabel(alert.severity)} ${alert.message}`.slice(0, 1000),
        // Stable fields the log-based alert policy filters on:
        event: "scrape_alert",
        action: a.action,
        alert: {
          id: alert.id,
          rule: alert.rule,
          dedupeKey: alert.dedupeKey,
          severity: alert.severity,
          status: alert.status,
          kind: alert.kind,
          subject: alert.subject,
          count: alert.count,
          firstSeen: new Date(msOf(alert.firstSeen) ?? 0).toISOString(),
          lastSeen: new Date(msOf(alert.lastSeen) ?? 0).toISOString(),
          lastRunId: alert.lastRunId ?? null,
        },
      });
    } catch (err) {
      console.error(`Scrape alerts: log write failed: ${safeErrorMessage(err)}`);
    }
  }

  /**
   * Engine failure (a read, a write, the config): an ERROR log line with its
   * own event name, so the Terraform backstop can also page when alerting
   * itself is broken.
   */
  private engineError(stage: string, err: unknown, runId?: string): void {
    try {
      this.log({
        severity: "ERROR",
        message: `scrape alert engine error (${stage}): ${safeErrorMessage(err)}`,
        event: "scrape_alert_engine_error",
        stage,
        ...(runId ? { runId } : {}),
      });
    } catch {
      console.error(`Scrape alerts: engine error (${stage}): ${safeErrorMessage(err)}`);
    }
  }

  // ---------- Email ----------

  /**
   * Admin uids to email: `recipientUserIds` (config) filtered to users that
   * really are admins, or every admin when the list is empty. "Admin" means
   * the account holds the admin custom claim (issue #135): the
   * `users/{uid}.admin` document field is not an authority and is not read.
   */
  async recipients(config: ScrapeAlertsConfig): Promise<string[]> {
    if (config.recipientUserIds.length === 0) {
      return claimsService.listAdminUids();
    }
    const out: string[] = [];
    for (const uid of new Set(config.recipientUserIds)) {
      if (await claimsService.isAdmin(uid)) out.push(uid);
      else console.warn(`Scrape alerts: recipient ${uid} is not an admin user, skipped`);
    }
    return out;
  }

  /**
   * Email new + escalated alerts at or above immediateMinSeverity: one email
   * per check (listing them, most severe first) to each recipient. Best
   * effort: never throws.
   */
  private async emailImmediate(actions: AlertAction[], config: ScrapeAlertsConfig): Promise<{ emailed: number; recipients: number }> {
    if (!config.email.immediate) return { emailed: 0, recipients: 0 };
    const min = SEVERITY_RANK[config.email.immediateMinSeverity];
    const alerts = actions
      .filter((a) => (a.action === "created" || a.action === "escalated") && SEVERITY_RANK[a.alert.severity] >= min)
      .map((a) => ({ ...a.alert, _escalated: a.action === "escalated" }));
    if (alerts.length === 0) return { emailed: 0, recipients: 0 };
    alerts.sort((x, y) => SEVERITY_RANK[y.severity] - SEVERITY_RANK[x.severity]);

    // ---- Copy ----
    const top = alerts[0];
    const title =
      alerts.length === 1
        ? `${sevLabel(top.severity)} ${top.subject.label}: ${RULE_TITLES[top.rule]}${top._escalated ? " (escalated)" : ""}`
        : `${sevLabel(top.severity)} ${alerts.length} new scraper alerts`;
    const lines = alerts
      .slice(0, MAX_ALERTS_PER_EMAIL)
      .map((a) => `${sevLabel(a.severity)} ${a.subject.label}: ${a.message}${a._escalated ? " (escalated)" : ""}`);
    if (alerts.length > MAX_ALERTS_PER_EMAIL) lines.push(`...and ${alerts.length - MAX_ALERTS_PER_EMAIL} more.`);
    const body =
      `${alerts.length === 1 ? "A scraper alert needs attention." : `${alerts.length} scraper alerts need attention.`}\n\n` +
      `${lines.join("\n\n")}\n\n` +
      "Acknowledge or resolve them on the scraper dashboard. You get one email when an alert opens or gets worse, not on every check.";

    // A critical alert reaches admins even if they turned email off.
    const sent = await this.sendToAdmins(config, title, body, alerts.some((a) => a.severity === "critical"));
    return { emailed: sent > 0 ? alerts.length : 0, recipients: sent };
  }

  /**
   * Daily digest (config email.digest): at digestHourUtc, once per UTC day
   * (claimed in a transaction on appConfig/scrapeAlertsState so a retried or
   * overlapping check never sends twice), email the active alerts at or
   * above digestMinSeverity. Nothing active -> no email (the day is still
   * claimed). Returns true when an email went out.
   */
  async sendDigestIfDue(config: ScrapeAlertsConfig, nowMs: number): Promise<boolean> {
    try {
      if (!config.email.digest || new Date(nowMs).getUTCHours() !== config.email.digestHourUtc) return false;
      const day = new Date(nowMs).toISOString().slice(0, 10);
      const stateRef = collections.appConfig.doc(SCRAPE_ALERTS_STATE_DOC);
      const claimed = await this.runTransaction(async (tx) => {
        const snap = await tx.get(stateRef);
        const state = (snap.exists ? snap.data() : {}) as ScrapeAlertsState;
        if (state.lastDigestDay === day) return false;
        tx.set(stateRef, { lastDigestDay: day, lastDigestAt: Timestamp.fromMillis(nowMs) }, { merge: true });
        return true;
      });
      if (!claimed) return false;

      const min = SEVERITY_RANK[config.email.digestMinSeverity];
      const snap = await collections.scrapeAlerts.where("status", "in", ACTIVE_STATUSES).get();
      const alerts = snap.docs
        .map((d) => d.data() as ScrapeAlertDoc)
        .filter((a) => SEVERITY_RANK[a.severity] >= min)
        .sort((x, y) => SEVERITY_RANK[y.severity] - SEVERITY_RANK[x.severity] || (msOf(y.lastSeen) ?? 0) - (msOf(x.lastSeen) ?? 0));
      if (alerts.length === 0) return false;

      const open = alerts.filter((a) => a.status === "open").length;
      const title = `Scraper alerts digest for ${day}: ${alerts.length} active`;
      const lines = alerts.slice(0, MAX_ALERTS_PER_EMAIL).map((a) => {
        const since = new Date(msOf(a.firstSeen) ?? nowMs).toISOString().slice(0, 16).replace("T", " ");
        return `${sevLabel(a.severity)} ${a.subject.label}: ${a.message} (since ${since} UTC, seen ${a.count}x${a.status === "acknowledged" ? ", acknowledged" : ""})`;
      });
      if (alerts.length > MAX_ALERTS_PER_EMAIL) lines.push(`...and ${alerts.length - MAX_ALERTS_PER_EMAIL} more.`);
      const body =
        `${alerts.length} scraper alert(s) are active (${open} open, ${alerts.length - open} acknowledged).\n\n` +
        lines.join("\n\n");
      return (await this.sendToAdmins(config, title, body, alerts.some((a) => a.severity === "critical"))) > 0;
    } catch (err) {
      this.engineError("digest", err);
      return false;
    }
  }

  /**
   * One branded email per admin recipient via notifyUser (EMAIL ONLY,
   * type `scrape_alert`: no event template, so the subject is `title`).
   * `critical` bypasses the recipient's email opt-out (notifyUser).
   * Returns how many recipients it was sent to (attempted).
   */
  private async sendToAdmins(config: ScrapeAlertsConfig, title: string, body: string, critical: boolean): Promise<number> {
    let uids: string[];
    try {
      uids = await this.recipients(config);
    } catch (err) {
      this.engineError("recipients", err);
      uids = [];
    }
    // Issue #96: the extra addresses get the same email (no user, so no
    // per-user opt-out applies). Sent even when no admin recipient exists.
    let sent = await this.sendToExtraEmails(config, title, body);
    if (uids.length === 0) {
      if (sent === 0) console.warn("Scrape alerts: no admin recipients, email not sent");
      return sent;
    }
    for (const userId of uids) {
      try {
        await this.notify({
          userId,
          type: "scrape_alert",
          title,
          body,
          channels: ["email"],
          // notifyUser's existing override: a `critical` notification keeps
          // its email even when the user switched email off. Set when the
          // email lists a CRITICAL alert, so an opted-out admin is not left
          // unaware that scraping is down. Warnings / info respect the opt-out.
          critical,
          actionUrl: `${EMAIL_BRANDING.appUrl}${SCRAPE_ALERTS_PORTAL_PATH}`,
        });
        sent++;
      } catch (err) {
        this.engineError("email", err);
      }
    }
    return sent;
  }

  /**
   * Issue #96: email every `extraRecipientEmails` address (branded template,
   * same subject / body as the admins' email). Best effort: a failure is
   * logged as an engine error and that address is not counted. Returns how
   * many addresses the provider accepted (or skipped while unconfigured).
   */
  private async sendToExtraEmails(config: ScrapeAlertsConfig, title: string, body: string): Promise<number> {
    let sent = 0;
    for (const to of config.extraRecipientEmails ?? []) {
      try {
        const result = await this.sendEmail({
          to,
          subject: title,
          title,
          body,
          actionUrl: `${EMAIL_BRANDING.appUrl}${SCRAPE_ALERTS_PORTAL_PATH}`,
        });
        if (result.status === "failed") this.engineError("email", new Error(result.error ?? "extra recipient email failed"));
        else sent++;
      } catch (err) {
        this.engineError("email", err);
      }
    }
    return sent;
  }

  /**
   * Alerts a post-run hook stored without emailing (near the function
   * timeout), as created / escalated actions for emailImmediate. Skips ones
   * already in `actions` and ones resolved since.
   */
  private async pendingEmailActions(actions: AlertAction[]): Promise<AlertAction[]> {
    try {
      const seen = new Set(actions.map((a) => a.alert.id));
      const snap = await collections.scrapeAlerts.where("emailPending", "==", true).get();
      return snap.docs
        .map((d) => d.data() as ScrapeAlertDoc)
        .filter((a) => !seen.has(a.id) && a.status !== "resolved")
        .map((alert) => ({ action: alert.escalatedAt ? ("escalated" as const) : ("created" as const), alert }));
    } catch (err) {
      this.engineError("pending_email", err);
      return [];
    }
  }

  /** Clear `emailPending` on the alerts just emailed (or no longer emailable). */
  private async clearEmailPending(actions: AlertAction[]): Promise<void> {
    for (const a of actions) {
      if (!a.alert.emailPending) continue;
      try {
        await collections.scrapeAlerts.doc(a.alert.id).update({ emailPending: false });
      } catch (err) {
        this.engineError("pending_email_clear", err);
      }
    }
  }

  // ---------- Reads behind the rules ----------

  /** Earlier finished, non-script runs of the same scraper, newest first. */
  private async previousRuns(run: ScrapeRunDoc): Promise<ScrapeRunDoc[]> {
    const snap = await collections.scrapeRuns
      .where("kind", "==", run.kind)
      .where("startedAt", "<", run.startedAt)
      .orderBy("startedAt", "desc")
      .limit(BACKOFF_LOOKBACK_RUNS)
      .get();
    return snap.docs
      .map((d) => d.data() as ScrapeRunDoc)
      .filter((r) => r.id !== run.id && r.status !== "running" && r.trigger !== "script");
  }

  /** The latest finished, non-script run of a scraper (kind+startedAt index). */
  private async latestFinishedRun(kind: ScrapeRunKind): Promise<ScrapeRunDoc | undefined> {
    const snap = await collections.scrapeRuns
      .where("kind", "==", kind)
      .orderBy("startedAt", "desc")
      .limit(LATEST_RUN_LOOKBACK)
      .get();
    return snap.docs.map((d) => d.data() as ScrapeRunDoc).find((r) => r.status !== "running" && r.trigger !== "script");
  }

  /** Source facts for one scraper's registry (a few dozen docs at most). */
  private async sourceFacts(kind: ScrapeRunKind): Promise<Array<VisaSourceFacts | NewsSourceFacts>> {
    // Issue #143: the guidance registry. Its "failing" status (the crawler
    // stopped after N consecutive failures) is the same thing the other
    // registries call "broken", so it is mapped to that word here and
    // source_broken needs no second code path; the source title is its name
    // and the stored last error is the auto-pause reason.
    if (kind === "guidance") {
      const g = await collections.guidanceSources.get();
      return g.docs.map((d) => {
        const data = d.data() as Record<string, unknown>;
        return {
          id: d.id,
          name: typeof data.title === "string" && data.title ? data.title : d.id,
          status: data.status === "failing" ? "broken" : (data.status as string | undefined),
          consecutiveFailures: typeof data.consecutiveFailures === "number" ? data.consecutiveFailures : 0,
          autoPausedReason:
            (typeof data.autoPausedReason === "string" && data.autoPausedReason) ||
            (typeof data.lastError === "string" ? data.lastError : null),
        } as NewsSourceFacts;
      });
    }
    const snap = await (kind === "visa" ? collections.visaSources : collections.newsSources).get();
    return snap.docs.map((d) => ({ ...(d.data() as Record<string, unknown>), id: d.id }) as VisaSourceFacts | NewsSourceFacts);
  }

  /**
   * The review queue's ageing items:
   *  - scraped visas pending review, per registry country (equality query,
   *    no index); queued at max(createdAt, restoredAt) — a #68 restore puts
   *    an old doc back in the queue, its wait starts then;
   *  - open pendingVisaChanges created on/before the age cutoff (served by
   *    the existing status+createdAt DESC index), capped.
   */
  private async reviewQueueItems(nowMs: number, config: ScrapeAlertsConfig): Promise<ReviewQueueItem[]> {
    const items: ReviewQueueItem[] = [];
    const sources = await collections.visaSources.get();
    for (const src of sources.docs) {
      const cc = ((src.data().countryCode as string) || src.id).toUpperCase();
      const pending = await subcollections.visaTypes(cc).where("reviewStatus", "==", "pending_review").get();
      for (const d of pending.docs) {
        const v = d.data() as { source?: string; createdAt?: unknown; restoredAt?: unknown };
        if (v.source !== "scraped") continue;
        const queuedAt = Math.max(msOf(v.createdAt) ?? 0, msOf(v.restoredAt) ?? 0);
        if (queuedAt > 0) items.push({ kind: "visa", id: `${cc}/${d.id}`, queuedAtMs: queuedAt });
      }
    }
    const cutoff = Timestamp.fromMillis(nowMs - config.thresholds.reviewQueueMaxAgeDays * DAY_MS);
    const changes = await collections.pendingVisaChanges
      .where("status", "==", "open")
      .where("createdAt", "<=", cutoff)
      .orderBy("createdAt", "desc")
      .limit(REVIEW_QUEUE_MAX_CHANGES)
      .get();
    for (const d of changes.docs) {
      const created = msOf(d.data().createdAt);
      if (created !== undefined) items.push({ kind: "change", id: d.id, queuedAtMs: created });
    }
    return items;
  }

  // ---------- Admin API ----------

  /**
   * Newest-activity-first page of alerts (lastSeen desc). `status=open`
   * includes acknowledged alerts (both are "active"); no status = all.
   * Indexes: status+lastSeen DESC (also serves `in`), lastSeen alone is the
   * single-field index. Cursor = the last alert id of the previous page.
   */
  async listAlerts(q: ListAlertsQuery): Promise<{ items: ScrapeAlertJson[]; nextCursor: string | null }> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let query: any = collections.scrapeAlerts;
    if (q.status === "open") query = query.where("status", "in", ACTIVE_STATUSES);
    else if (q.status) query = query.where("status", "==", q.status);
    query = query.orderBy("lastSeen", "desc");
    if (q.cursor) {
      const cursorSnap = await collections.scrapeAlerts.doc(q.cursor).get();
      if (!cursorSnap.exists) throw new InvalidAlertCursorError();
      query = query.startAfter(cursorSnap);
    }
    const snap = await query.limit(q.limit + 1).get();
    const docs = snap.docs.slice(0, q.limit);
    return {
      items: docs.map((d: { id: string; data: () => unknown }) => alertJson(d.id, d.data())),
      nextCursor: snap.docs.length > q.limit ? docs[docs.length - 1].id : null,
    };
  }

  /** One alert (ISO dates), or null. */
  async getAlert(id: string): Promise<ScrapeAlertJson | null> {
    const snap = await collections.scrapeAlerts.doc(id).get();
    return snap.exists ? alertJson(snap.id, snap.data()) : null;
  }

  /**
   * Acknowledge an active alert (an admin is on it). Idempotent for an
   * already acknowledged alert (returned unchanged); refused for a resolved
   * one. It keeps being bumped while the condition holds, but is not emailed
   * again unless it escalates.
   */
  async acknowledge(id: string, uid: string, nowMs: number = this.realClock()): Promise<AlertMutationResult> {
    const ref = collections.scrapeAlerts.doc(id);
    const now = Timestamp.fromMillis(nowMs);
    const result = await this.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return { outcome: "not_found" as const };
      const alert = snap.data() as ScrapeAlertDoc;
      if (alert.status === "resolved") return { outcome: "already_resolved" as const, alert };
      if (alert.status === "acknowledged") return { outcome: "ok" as const, alert, changed: false };
      const update = { status: "acknowledged" as const, acknowledgedBy: uid, acknowledgedAt: now, updatedAt: now };
      tx.update(ref, update);
      return { outcome: "ok" as const, alert: { ...alert, ...update }, changed: true };
    });
    if (result.outcome === "not_found") return result;
    if (result.outcome === "ok" && result.changed) this.logAction({ action: "acknowledged", alert: result.alert });
    return { outcome: result.outcome, alert: alertJson(id, result.alert) };
  }

  /**
   * Resolve an alert by hand (autoResolved false). Idempotent: an already
   * resolved alert comes back as `already_resolved` (controller: 200,
   * unchanged). Frees the dedupe key, so if the condition still holds the
   * next check opens a NEW alert (and emails it).
   */
  async resolve(id: string, uid: string, nowMs: number = this.realClock()): Promise<AlertMutationResult> {
    const ref = collections.scrapeAlerts.doc(id);
    const now = Timestamp.fromMillis(nowMs);
    const result = await this.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return { outcome: "not_found" as const };
      const alert = snap.data() as ScrapeAlertDoc;
      if (alert.status === "resolved") return { outcome: "already_resolved" as const, alert };
      const pointerRef = collections.scrapeAlertKeys.doc(alertKeyId(alert.dedupeKey));
      const pointer = await tx.get(pointerRef);
      const update = {
        status: "resolved" as const,
        resolvedBy: uid,
        resolvedAt: now,
        autoResolved: false,
        updatedAt: now,
        expireAt: expireAtFrom(nowMs),
      };
      tx.update(ref, update);
      // Only touch the pointer when it points at THIS alert. With occurrence
      // ids, keep it as a tombstone so the SAME occurrence is not re-opened by
      // the next check (ScrapeAlertKeyDoc); without, free the key.
      if (pointer.exists && (pointer.data() as ScrapeAlertKeyDoc).alertId === id) {
        const eventIds = alert.eventIds ?? [];
        if (eventIds.length > 0) {
          tx.set(pointerRef, {
            dedupeKey: alert.dedupeKey,
            alertId: id,
            createdAt: (pointer.data() as ScrapeAlertKeyDoc).createdAt ?? now,
            suppressEventIds: eventIds.slice(-MAX_EVENT_IDS),
            resolvedAt: now,
          } satisfies ScrapeAlertKeyDoc);
        } else {
          tx.delete(pointerRef);
        }
      }
      return { outcome: "ok" as const, alert: { ...alert, ...update } };
    });
    if (result.outcome === "not_found") return result;
    if (result.outcome === "ok") this.logAction({ action: "resolved", alert: result.alert });
    return { outcome: result.outcome, alert: alertJson(id, result.alert) };
  }
}

export const scrapeAlertService = new ScrapeAlertService();
