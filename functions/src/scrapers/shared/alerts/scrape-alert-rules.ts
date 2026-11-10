import type { ScrapeRunDoc, ScrapeRunKind } from "../runs/types";
import type { CrawlWindow } from "../../visa-catalog/types";
import {
  SCRAPE_ALERT_RULES,
  SCRAPE_ALERT_SEVERITIES,
  type ScrapeAlertDetails,
  type ScrapeAlertRule,
  type ScrapeAlertSeverity,
  type ScrapeAlertSubject,
  type ScrapeAlertsConfig,
  type ScrapeAlertThresholds,
} from "./types";
import { nextWindowOpening } from "../etiquette/visa-crawl-window";

// ============================================
// SCRAPE ALERTS — pure rule logic (issue #83)
// ============================================
//
// NO Firebase imports: every function here takes plain data (run docs,
// source docs, config) and returns RuleEvaluations, so the rules are unit
// tested without Firestore. scrapers/shared/alerts/scrape-alert.service.ts does the reads,
// then hands the evaluations to its store (upsert / auto-resolve / email /
// log).
//
// A RuleEvaluation says two things about one rule:
//   signals — the alerts that are ACTIVE right now (created or bumped);
//   scope   — which of the rule's existing active alerts this evaluation
//             KNOWS about, so any of them not in `signals` has cleared and is
//             auto-resolved:
//               "all"            every active alert of the rule (a full check,
//                                e.g. the hourly look at all sources);
//               { keys }         just these dedupe keys (e.g. a run only
//                                tells us about its own scraper);
//               { keyPrefix }    keys starting with this (e.g. only the visa
//                                sources, "source_broken:visa:").

/** One active alert condition, as found by a rule. */
export interface AlertSignal {
  rule: ScrapeAlertRule;
  key: string; // dedupe key
  severity: ScrapeAlertSeverity;
  level?: number; // escalation step (llm_budget: % reached)
  kind: ScrapeRunKind | null;
  subject: ScrapeAlertSubject;
  message: string;
  details?: ScrapeAlertDetails;
  // Occurrence id: re-seeing the same occurrence does not bump the count.
  eventId?: string;
  runId?: string; // the run behind it, when there is one
}

/** Which existing active alerts of a rule an evaluation covers (see header). */
export type RuleScope = "all" | { keys: string[] } | { keyPrefix: string };

/** One rule's verdict. */
export interface RuleEvaluation {
  rule: ScrapeAlertRule;
  signals: AlertSignal[];
  scope: RuleScope;
}

// ============================================
// CONFIG DEFAULTS + VALIDATION
// ============================================

/** Default thresholds (used for any missing / invalid config value). */
export const DEFAULT_THRESHOLDS: ScrapeAlertThresholds = {
  stuckRunMinutes: 60,
  errorRatePct: 20,
  errorRateMinPages: 5,
  backoffConsecutiveRuns: 2,
  linkedSurchargeErrors: 1,
  fxFailingHours: 48,
  budgetPcts: [50, 80, 100],
  reviewQueueMaxAgeDays: 7,
  missedWindowGraceHours: 2,
};

/** The config written to `appConfig/scrapeAlerts` when none exists yet. */
export const DEFAULT_CONFIG: ScrapeAlertsConfig = {
  enabled: true,
  recipientUserIds: [],
  extraRecipientEmails: [],
  email: {
    immediate: true,
    immediateMinSeverity: "warning",
    digest: false,
    digestHourUtc: 7,
    digestMinSeverity: "info",
  },
  thresholds: DEFAULT_THRESHOLDS,
  rules: {},
};

/** Each rule's default severity (llm_budget: see budgetSeverity). */
export const DEFAULT_SEVERITY: Record<ScrapeAlertRule, ScrapeAlertSeverity> = {
  run_failed: "critical",
  run_stuck: "critical",
  missed_window: "warning",
  source_broken: "critical",
  error_rate: "warning",
  host_backoff: "warning",
  linked_surcharge: "warning",
  fx_refresh_failing: "warning",
  llm_budget: "warning",
  review_queue_stale: "info",
  // Issue #96: extraction has stopped, so new visa changes are not reaching review.
  budget_hard_stop: "critical",
};

/** Issue #96: most extra alert recipient addresses (extraRecipientEmails). */
export const MAX_EXTRA_RECIPIENT_EMAILS = 20;

/**
 * A plausible email address: one "@", no spaces, a dot in the domain, at
 * most 254 chars. Deliberately simple (the provider does the real check);
 * it only keeps typos and junk out of the config.
 */
export function isPlausibleEmail(v: unknown): v is string {
  return typeof v === "string" && v.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
}

/** A finite number >= min (and <= max), else undefined. */
function num(v: unknown, min: number, max = Number.POSITIVE_INFINITY): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v >= min && v <= max ? v : undefined;
}

/** A known severity, else undefined. */
function sev(v: unknown): ScrapeAlertSeverity | undefined {
  return SCRAPE_ALERT_SEVERITIES.includes(v as ScrapeAlertSeverity) ? (v as ScrapeAlertSeverity) : undefined;
}

/**
 * Merge a stored `appConfig/scrapeAlerts` doc over the defaults. Every field
 * is validated on its own: a bad value (wrong type, out of range) falls back
 * to its default and is reported in `problems` (logged by the service), so a
 * typo in one threshold never disables the whole alerting.
 */
export function resolveConfig(raw: unknown): { config: ScrapeAlertsConfig; problems: string[] } {
  const problems: string[] = [];
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const email = (r.email && typeof r.email === "object" ? r.email : {}) as Record<string, unknown>;
  const th = (r.thresholds && typeof r.thresholds === "object" ? r.thresholds : {}) as Record<string, unknown>;

  /** Use `v` when valid, else the default (noting a problem when `v` was set). */
  const pick = <T>(path: string, given: unknown, valid: T | undefined, fallback: T): T => {
    if (given === undefined) return fallback;
    if (valid === undefined) {
      problems.push(`${path}: invalid value ${JSON.stringify(given)}, using default`);
      return fallback;
    }
    return valid;
  };
  const bool = (v: unknown) => (typeof v === "boolean" ? v : undefined);

  // ---- Thresholds ----
  const d = DEFAULT_THRESHOLDS;
  const pcts = Array.isArray(th.budgetPcts) && th.budgetPcts.length > 0 && th.budgetPcts.every((p) => num(p, 1, 1000) !== undefined)
    ? [...(th.budgetPcts as number[])].sort((a, b) => a - b)
    : undefined;
  const thresholds: ScrapeAlertThresholds = {
    stuckRunMinutes: pick("thresholds.stuckRunMinutes", th.stuckRunMinutes, num(th.stuckRunMinutes, 5), d.stuckRunMinutes),
    errorRatePct: pick("thresholds.errorRatePct", th.errorRatePct, num(th.errorRatePct, 0, 100), d.errorRatePct),
    errorRateMinPages: pick("thresholds.errorRateMinPages", th.errorRateMinPages, num(th.errorRateMinPages, 1), d.errorRateMinPages),
    backoffConsecutiveRuns: pick(
      "thresholds.backoffConsecutiveRuns",
      th.backoffConsecutiveRuns,
      Number.isInteger(th.backoffConsecutiveRuns) ? num(th.backoffConsecutiveRuns, 1, 20) : undefined,
      d.backoffConsecutiveRuns
    ),
    linkedSurchargeErrors: pick("thresholds.linkedSurchargeErrors", th.linkedSurchargeErrors, num(th.linkedSurchargeErrors, 1), d.linkedSurchargeErrors),
    fxFailingHours: pick("thresholds.fxFailingHours", th.fxFailingHours, num(th.fxFailingHours, 1), d.fxFailingHours),
    budgetPcts: pick("thresholds.budgetPcts", th.budgetPcts, pcts, d.budgetPcts),
    reviewQueueMaxAgeDays: pick("thresholds.reviewQueueMaxAgeDays", th.reviewQueueMaxAgeDays, num(th.reviewQueueMaxAgeDays, 0.5), d.reviewQueueMaxAgeDays),
    missedWindowGraceHours: pick("thresholds.missedWindowGraceHours", th.missedWindowGraceHours, num(th.missedWindowGraceHours, 0, 72), d.missedWindowGraceHours),
  };

  // ---- Email ----
  const de = DEFAULT_CONFIG.email;
  const emailCfg = {
    immediate: pick("email.immediate", email.immediate, bool(email.immediate), de.immediate),
    immediateMinSeverity: pick("email.immediateMinSeverity", email.immediateMinSeverity, sev(email.immediateMinSeverity), de.immediateMinSeverity),
    digest: pick("email.digest", email.digest, bool(email.digest), de.digest),
    digestHourUtc: pick(
      "email.digestHourUtc",
      email.digestHourUtc,
      Number.isInteger(email.digestHourUtc) ? num(email.digestHourUtc, 0, 23) : undefined,
      de.digestHourUtc
    ),
    digestMinSeverity: pick("email.digestMinSeverity", email.digestMinSeverity, sev(email.digestMinSeverity), de.digestMinSeverity),
  };

  // ---- Recipients: strings only ----
  const ids = Array.isArray(r.recipientUserIds) && r.recipientUserIds.every((x) => typeof x === "string" && x !== "")
    ? [...(r.recipientUserIds as string[])]
    : undefined;
  const recipientUserIds = pick("recipientUserIds", r.recipientUserIds, ids, [] as string[]);

  // ---- Extra recipient addresses (issue #96): plausible emails, max 20 ----
  const emails =
    Array.isArray(r.extraRecipientEmails) &&
    r.extraRecipientEmails.length <= MAX_EXTRA_RECIPIENT_EMAILS &&
    r.extraRecipientEmails.every(isPlausibleEmail)
      ? [...new Set((r.extraRecipientEmails as string[]).map((e) => e.trim().toLowerCase()))]
      : undefined;
  const extraRecipientEmails = pick("extraRecipientEmails", r.extraRecipientEmails, emails, [] as string[]);

  // ---- Per-rule overrides: known rules only ----
  const rules: ScrapeAlertsConfig["rules"] = {};
  if (r.rules && typeof r.rules === "object") {
    for (const [rule, v] of Object.entries(r.rules as Record<string, unknown>)) {
      if (!SCRAPE_ALERT_RULES.includes(rule as ScrapeAlertRule) || !v || typeof v !== "object") {
        problems.push(`rules.${rule}: unknown rule or not an object, ignored`);
        continue;
      }
      const o = v as Record<string, unknown>;
      rules[rule as ScrapeAlertRule] = {
        enabled: pick(`rules.${rule}.enabled`, o.enabled, bool(o.enabled), undefined),
        severity: pick(`rules.${rule}.severity`, o.severity, sev(o.severity), undefined),
      };
    }
  }

  return {
    config: {
      enabled: pick("enabled", r.enabled, bool(r.enabled), true),
      recipientUserIds,
      extraRecipientEmails,
      email: emailCfg,
      thresholds,
      rules,
    },
    problems,
  };
}

/** Is a rule switched on (config `rules.<rule>.enabled`, default true)? */
export function ruleEnabled(config: ScrapeAlertsConfig, rule: ScrapeAlertRule): boolean {
  return config.rules[rule]?.enabled !== false;
}

/** A rule's severity: the config override, else its default. */
export function ruleSeverity(config: ScrapeAlertsConfig, rule: ScrapeAlertRule): ScrapeAlertSeverity {
  return config.rules[rule]?.severity ?? DEFAULT_SEVERITY[rule];
}

// ============================================
// SMALL HELPERS
// ============================================

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** "Visa scraper" / "News scraper". */
export function scraperLabel(kind: ScrapeRunKind): string {
  return kind === "visa" ? "Visa scraper" : "News scraper";
}

/** Subject for a whole scraper. */
function scraperSubject(kind: ScrapeRunKind): ScrapeAlertSubject {
  return { type: "scraper", id: kind, label: scraperLabel(kind) };
}

/** Timestamp-like (duck-typed: survives a second SDK copy / the test fake). */
function isTs(v: unknown): v is { toMillis(): number } {
  return Boolean(v) && typeof (v as { toMillis?: unknown }).toMillis === "function";
}

/** Millis of a Timestamp-like value, else undefined. */
export function msOf(v: unknown): number | undefined {
  return isTs(v) ? v.toMillis() : undefined;
}

/** ISO string of an epoch-ms instant. */
function isoOf(ms: number): string {
  return new Date(ms).toISOString();
}

/** Whole hours (rounded down) for messages. */
function hours(ms: number): number {
  return Math.floor(ms / HOUR_MS);
}

/** Lowercased hostname of a URL, or "" when it does not parse. */
export function hostOfUrl(url: string | undefined): string {
  if (!url) return "";
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

/**
 * Does this stored error text describe a 429/503 backoff (#64)? The crawlers
 * store HostBackoffError messages ("host backed off (429), retry after ...",
 * visa-crawl-host-state.ts backoffMessage) and the news scraper's
 * describeError() adds "status=429" for raw axios errors.
 */
export function isBackoffMessage(message: string | undefined): boolean {
  return typeof message === "string" && /host backed off \((429|503)\)|status=(429|503)\b/.test(message);
}

// ============================================
// RUN RULES (finalize hook; run_failed also hourly)
// ============================================

/**
 * run_failed for one finished run: a `failed` run raises
 * `run_failed:<kind>` (eventId = run id, so the hourly re-read of the same
 * run is not a second occurrence); any other finished status clears it.
 * A `running` run says nothing (empty key scope).
 */
export function evaluateRunFailed(run: ScrapeRunDoc, config: ScrapeAlertsConfig): RuleEvaluation {
  const key = `run_failed:${run.kind}`;
  if (run.status === "running") return { rule: "run_failed", signals: [], scope: { keys: [] } };
  if (run.status !== "failed") return { rule: "run_failed", signals: [], scope: { keys: [key] } };
  const why = run.fatalError ? `: ${run.fatalError}` : ` with ${run.errorCount} error(s) and nothing fetched`;
  return {
    rule: "run_failed",
    scope: { keys: [key] },
    signals: [
      {
        rule: "run_failed",
        key,
        severity: ruleSeverity(config, "run_failed"),
        kind: run.kind,
        subject: scraperSubject(run.kind),
        message: `${scraperLabel(run.kind)} run ${run.id} failed${why}`.slice(0, 600),
        details: {
          runId: run.id,
          startedAt: msOf(run.startedAt) !== undefined ? isoOf(msOf(run.startedAt)!) : null,
          errorCount: run.errorCount ?? 0,
          fatalError: run.fatalError ?? null,
        },
        eventId: run.id,
        runId: run.id,
      },
    ],
  };
}

/**
 * The finished run clears its own `run_stuck:<id>` alert (it was stuck and
 * has now ended, or was never stuck).
 */
export function evaluateRunNoLongerStuck(run: ScrapeRunDoc): RuleEvaluation {
  return { rule: "run_stuck", signals: [], scope: { keys: run.status === "running" ? [] : [`run_stuck:${run.id}`] } };
}

/**
 * error_rate: errors above errorRatePct of the run's pages raises
 * `error_rate:<kind>`; a run with at least errorRateMinPages pages under the
 * threshold clears it. A run with fewer pages (an idle-ish run, or one that
 * threw before fetching) says nothing either way.
 */
export function evaluateErrorRate(run: ScrapeRunDoc, config: ScrapeAlertsConfig): RuleEvaluation {
  const key = `error_rate:${run.kind}`;
  const t = config.thresholds;
  const pages = run.pagesAttempted ?? 0;
  if (run.status === "running" || pages < t.errorRateMinPages) {
    return { rule: "error_rate", signals: [], scope: { keys: [] } };
  }
  const errors = run.errorCount ?? 0;
  const pct = (errors / pages) * 100;
  if (pct <= t.errorRatePct) return { rule: "error_rate", signals: [], scope: { keys: [key] } };
  return {
    rule: "error_rate",
    scope: { keys: [key] },
    signals: [
      {
        rule: "error_rate",
        key,
        severity: ruleSeverity(config, "error_rate"),
        kind: run.kind,
        subject: scraperSubject(run.kind),
        message: `${scraperLabel(run.kind)} run ${run.id}: ${errors} of ${pages} pages failed (${Math.round(pct)}%, threshold ${t.errorRatePct}%)`,
        details: { runId: run.id, errors, pages, errorRatePct: Math.round(pct * 10) / 10, thresholdPct: t.errorRatePct },
        eventId: run.id,
        runId: run.id,
      },
    ],
  };
}

/**
 * linked_surcharge (visa only, #69): `summary.linkedSurchargeErrors` at or
 * above the threshold raises `linked_surcharge:visa`; a visa run below it
 * clears it. News runs say nothing.
 */
export function evaluateLinkedSurcharge(run: ScrapeRunDoc, config: ScrapeAlertsConfig): RuleEvaluation {
  const key = "linked_surcharge:visa";
  if (run.kind !== "visa" || run.status === "running") return { rule: "linked_surcharge", signals: [], scope: { keys: [] } };
  const n = typeof run.summary?.linkedSurchargeErrors === "number" ? (run.summary.linkedSurchargeErrors as number) : 0;
  if (n < config.thresholds.linkedSurchargeErrors) return { rule: "linked_surcharge", signals: [], scope: { keys: [key] } };
  return {
    rule: "linked_surcharge",
    scope: { keys: [key] },
    signals: [
      {
        rule: "linked_surcharge",
        key,
        severity: ruleSeverity(config, "linked_surcharge"),
        kind: "visa",
        subject: scraperSubject("visa"),
        message: `Visa scraper run ${run.id}: ${n} page(s) not extracted because their linked surcharge page (e.g. the UK IHS page) could not be fetched or parsed`,
        details: { runId: run.id, linkedSurchargeErrors: n },
        eventId: run.id,
        runId: run.id,
      },
    ],
  };
}

// ============================================
// BUDGET HARD STOP (finalize hook, issue #96)
// ============================================

/**
 * budget_hard_stop (visa only): the run's summary says the hard stop
 * blocked extraction (`summary.budgetHardStop === true`) -> raise
 * `budget_hard_stop:visa`; a finished visa run without it clears the alert
 * (the budget was raised, the month rolled over or the stop was switched
 * off). News runs say nothing (they make no LLM calls).
 */
export function evaluateBudgetHardStop(run: ScrapeRunDoc, config: ScrapeAlertsConfig): RuleEvaluation {
  const key = "budget_hard_stop:visa";
  if (run.kind !== "visa" || run.status === "running") return { rule: "budget_hard_stop", signals: [], scope: { keys: [] } };
  if (run.summary?.budgetHardStop !== true) return { rule: "budget_hard_stop", signals: [], scope: { keys: [key] } };
  const skipped = typeof run.summary?.extractionsSkippedBudget === "number" ? (run.summary.extractionsSkippedBudget as number) : 0;
  return {
    rule: "budget_hard_stop",
    scope: { keys: [key] },
    signals: [
      {
        rule: "budget_hard_stop",
        key,
        severity: ruleSeverity(config, "budget_hard_stop"),
        kind: "visa",
        subject: scraperSubject("visa"),
        message:
          `Visa scraper run ${run.id}: the monthly LLM budget is spent and the hard stop is on, so ` +
          `${skipped} changed page(s) were fetched but not extracted. Raise the budget or switch the hard stop off to resume.`,
        details: { runId: run.id, extractionsSkippedBudget: skipped },
        eventId: run.id,
        runId: run.id,
      },
    ],
  };
}

// ============================================
// HOST BACKOFF (finalize hook)
// ============================================

/** Hosts that backed us off (429/503) in a run, and which sources they belong to. */
export interface RunHostFacts {
  backedOff: Set<string>;
  // Hosts the run demonstrably requested or skipped (visa page lines, error urls).
  touched: Set<string>;
  // host -> source ids seen with it (to tell whether a later run touched it).
  sourcesByHost: Map<string, Set<string>>;
  // host -> latest "retry after" instant (ms) in its backoff messages, when given.
  untilByHost: Map<string, number>;
}

/**
 * The "retry after <ISO>" instant of a backoff message (backoffMessage in
 * visa-crawl-host-state.ts), or undefined (e.g. a bare "status=429").
 */
export function backoffUntilMs(message: string | undefined): number | undefined {
  const m = typeof message === "string" ? /retry after (\d{4}-\d{2}-\d{2}T[0-9:.]+Z)/.exec(message) : null;
  const ms = m ? Date.parse(m[1]) : NaN;
  return Number.isNaN(ms) ? undefined : ms;
}

/**
 * Per-host facts of one run, from what #81 stores:
 *  - visa page lines (`pages[]`): every line's host is touched; an `error`
 *    or `deferred` line whose error text is a backoff marks its host;
 *  - `errors[]` (first 20, both kinds): a backoff message marks the url's host.
 * News runs have no page lines, so their touched hosts are only the errored
 * ones; see runTouchesHost for how a later news run counts as touching a host.
 */
export function runHostFacts(run: ScrapeRunDoc): RunHostFacts {
  const backedOff = new Set<string>();
  const touched = new Set<string>();
  const sourcesByHost = new Map<string, Set<string>>();
  const untilByHost = new Map<string, number>();
  const note = (host: string, sourceId: string | undefined, backoff: boolean, message?: string) => {
    if (!host) return;
    touched.add(host);
    if (backoff) {
      backedOff.add(host);
      const until = backoffUntilMs(message);
      if (until !== undefined && until > (untilByHost.get(host) ?? 0)) untilByHost.set(host, until);
    }
    if (sourceId) {
      if (!sourcesByHost.has(host)) sourcesByHost.set(host, new Set());
      sourcesByHost.get(host)!.add(sourceId);
    }
  };
  for (const p of run.pages ?? []) {
    if (p.outcome === "supplement") continue; // not necessarily requested this run
    note(hostOfUrl(p.url), p.sourceId, (p.outcome === "error" || p.outcome === "deferred") && isBackoffMessage(p.error), p.error);
  }
  for (const e of run.errors ?? []) {
    note(hostOfUrl(e.url), e.sourceId, isBackoffMessage(e.message), e.message);
  }
  return { backedOff, touched, sourcesByHost, untilByHost };
}

/**
 * Did `run` touch `host`? Yes when the host is in its page lines / error
 * urls, or when the run processed (any status but `empty`) a source that the
 * host was seen with — that is how a news run, which keeps no page lines,
 * counts as "the next run that hit this host".
 */
function runTouchesHost(run: ScrapeRunDoc, facts: RunHostFacts, host: string, hostSources: Set<string>): boolean {
  if (facts.touched.has(host)) return true;
  return (run.sources ?? []).some((s) => s.status !== "empty" && hostSources.has(s.sourceId));
}

/**
 * host_backoff: a host that backed off in `run` AND in each of the previous
 * (backoffConsecutiveRuns - 1) runs of the same kind that touched it raises
 * `host_backoff:<kind>:<host>`. Runs that never touched the host (another
 * country's weekly window, a news tick for other sources) do not break the
 * streak. A host the run touched without a backoff clears its alert.
 *
 * @param previous earlier finished runs of the same kind, NEWEST first.
 */
export function evaluateHostBackoff(run: ScrapeRunDoc, previous: ScrapeRunDoc[], config: ScrapeAlertsConfig): RuleEvaluation {
  if (run.status === "running") return { rule: "host_backoff", signals: [], scope: { keys: [] } };
  const need = config.thresholds.backoffConsecutiveRuns;
  const facts = runHostFacts(run);
  const prevFacts = previous.map((r) => ({ run: r, facts: runHostFacts(r) }));
  const signals: AlertSignal[] = [];
  const clearKeys: string[] = [];

  // ---- Hosts backed off now: count the streak backwards ----
  for (const host of facts.backedOff) {
    // Every source this host was seen with, in this run or the earlier ones.
    const hostSources = new Set<string>(facts.sourcesByHost.get(host) ?? []);
    for (const p of prevFacts) for (const s of p.facts.sourcesByHost.get(host) ?? []) hostSources.add(s);
    let streak = 1;
    for (const p of prevFacts) {
      if (streak >= need) break;
      if (!runTouchesHost(p.run, p.facts, host, hostSources)) continue; // didn't hit the host
      if (!p.facts.backedOff.has(host)) break; // hit it fine: streak over
      streak++;
    }
    if (streak < need) continue;
    signals.push({
      rule: "host_backoff",
      key: `host_backoff:${run.kind}:${host}`,
      severity: ruleSeverity(config, "host_backoff"),
      kind: run.kind,
      subject: { type: "host", id: host, label: host },
      message: `${host} answered 429/503 on ${streak} consecutive ${run.kind} runs (latest ${run.id}); the scraper is backing off`,
      details: {
        runId: run.id,
        host,
        consecutiveRuns: streak,
        // Read back by evaluateHostBackoffClears (hourly): which sources use
        // the host, and when the host said we may come back.
        sources: [...hostSources].sort().join(",") || null,
        backoffUntil: facts.untilByHost.has(host) ? isoOf(facts.untilByHost.get(host)!) : null,
      },
      eventId: run.id,
      runId: run.id,
    });
  }

  // ---- Hosts touched cleanly now: their alerts clear ----
  for (const host of facts.touched) {
    if (!facts.backedOff.has(host)) clearKeys.push(`host_backoff:${run.kind}:${host}`);
  }
  return { rule: "host_backoff", signals, scope: { keys: clearKeys } };
}

/** An active host_backoff alert, as the hourly clear check reads it. */
export interface ActiveHostBackoffAlert {
  dedupeKey: string; // "host_backoff:<kind>:<host>"
  kind: ScrapeRunKind | null;
  details?: ScrapeAlertDetails; // sources (comma list), backoffUntil (ISO)
}

/**
 * host_backoff clears that no run reports (review fix; hourly): a backoff
 * alert normally clears when a later run touches the host cleanly, but that
 * run may never come. Clear it when
 *  - every source it was seen with is no longer crawled (status other than
 *    `active`: paused / broken / retired, or the source doc is gone); or
 *  - the host's last "retry after" has passed: the backoff is over, and no
 *    run since has backed off again (that run would have bumped it with a
 *    later backoffUntil, or cleared it).
 * Signals nothing; scope = the keys it decided are clear.
 *
 * @param sourceStatus kind -> (source id -> status); a missing id = removed.
 */
export function evaluateHostBackoffClears(
  alerts: ActiveHostBackoffAlert[],
  sourceStatus: Partial<Record<ScrapeRunKind, Map<string, string>>>,
  nowMs: number
): RuleEvaluation {
  const keys: string[] = [];
  for (const a of alerts) {
    // ---- Backoff expired ----
    const untilIso = typeof a.details?.backoffUntil === "string" ? a.details.backoffUntil : undefined;
    const until = untilIso ? Date.parse(untilIso) : NaN;
    if (!Number.isNaN(until) && until <= nowMs) {
      keys.push(a.dedupeKey);
      continue;
    }
    // ---- Every source it belongs to stopped (or vanished) ----
    const statuses = a.kind ? sourceStatus[a.kind] : undefined;
    const ids = typeof a.details?.sources === "string" ? a.details.sources.split(",").filter(Boolean) : [];
    if (statuses && ids.length > 0 && ids.every((id) => (statuses.get(id) ?? "removed") !== "active")) {
      keys.push(a.dedupeKey);
    }
  }
  return { rule: "host_backoff", signals: [], scope: { keys } };
}

// ============================================
// HOURLY STATE RULES
// ============================================

/** Running runs (status == running) for the stuck check. */
export function evaluateStuckRuns(running: ScrapeRunDoc[], nowMs: number, config: ScrapeAlertsConfig): RuleEvaluation {
  const limitMs = config.thresholds.stuckRunMinutes * 60 * 1000;
  const signals: AlertSignal[] = [];
  for (const run of running) {
    const started = msOf(run.startedAt);
    if (run.status !== "running" || started === undefined || nowMs - started <= limitMs) continue;
    signals.push({
      rule: "run_stuck",
      key: `run_stuck:${run.id}`,
      severity: ruleSeverity(config, "run_stuck"),
      kind: run.kind,
      subject: { type: "run", id: run.id, label: `${scraperLabel(run.kind)} run ${run.id}` },
      message: `${scraperLabel(run.kind)} run ${run.id} has been running for ${Math.floor((nowMs - started) / 60000)} min (started ${isoOf(started)}); it probably crashed or timed out`,
      details: { runId: run.id, startedAt: isoOf(started), runningMinutes: Math.floor((nowMs - started) / 60000) },
      // Same run = same occurrence: hourly re-checks do not inflate count.
      eventId: run.id,
      runId: run.id,
    });
  }
  return { rule: "run_stuck", signals, scope: "all" };
}

/** The visa-source fields the window / broken rules read. */
export interface VisaSourceFacts {
  id: string;
  countryName?: string;
  status?: string;
  consecutiveFailures?: number;
  crawlWindow?: CrawlWindow;
  lastCrawledAt?: unknown; // Timestamp
  createdAt?: unknown; // Timestamp
}

/** The news-source fields the broken rule reads. */
export interface NewsSourceFacts {
  id: string;
  name?: string;
  status?: string;
  consecutiveFailures?: number;
  lastErrorMessage?: string;
}

/**
 * The latest opening of `window` whose window (plus `graceMs`) has fully
 * closed by `nowMs`, or null. Walks openings forward from two weeks back
 * with nextWindowOpening (#63), so DST is handled by the same code that
 * schedules the crawl. The window's length is endHour - startHour hours.
 */
export function lastClosedWindowOpening(window: CrawlWindow, nowMs: number, graceMs: number): number | null {
  const lengthMs = (window.endHour - window.startHour) * HOUR_MS;
  let best: number | null = null;
  let opening = nextWindowOpening(window, nowMs - 15 * DAY_MS).getTime();
  // At most 3 iterations (two weeks of weekly openings).
  while (opening + lengthMs + graceMs <= nowMs) {
    best = opening;
    opening = nextWindowOpening(window, opening).getTime();
  }
  return best;
}

/**
 * missed_window: an ACTIVE visa source with a weekly window whose last
 * closed window (+ grace) passed without the source being crawled
 * (lastCrawledAt before that opening) raises `missed_window:<cc>`.
 * Sources created after that opening, without a window (legacy interval)
 * or not active (paused / broken: source_broken's job) are skipped and
 * their alerts clear (scope "all").
 */
export function evaluateMissedWindows(sources: VisaSourceFacts[], nowMs: number, config: ScrapeAlertsConfig): RuleEvaluation {
  const graceMs = config.thresholds.missedWindowGraceHours * HOUR_MS;
  const signals: AlertSignal[] = [];
  for (const s of sources) {
    if (s.status !== "active" || !s.crawlWindow) continue;
    let opening: number | null;
    try {
      opening = lastClosedWindowOpening(s.crawlWindow, nowMs, graceMs);
    } catch {
      continue; // invalid window: the crawler rejects it too; not this rule's call
    }
    if (opening === null) continue;
    const created = msOf(s.createdAt);
    if (created !== undefined && created > opening) continue; // did not exist yet
    const last = msOf(s.lastCrawledAt);
    if (last !== undefined && last >= opening) continue; // crawled in (or after) the window
    const w = s.crawlWindow;
    const name = s.countryName ?? s.id;
    signals.push({
      rule: "missed_window",
      key: `missed_window:${s.id}`,
      severity: ruleSeverity(config, "missed_window"),
      kind: "visa",
      subject: { type: "source", id: s.id, label: `${name} (visa source)` },
      message:
        `${name}: no visa crawl in its weekly window opening ${isoOf(opening)} ` +
        `(${w.timeZone}, day ${w.dayOfWeek}, ${w.startHour}:00-${w.endHour}:00); last crawled ${last !== undefined ? isoOf(last) : "never"}`,
      details: { sourceId: s.id, windowOpenedAt: isoOf(opening), lastCrawledAt: last !== undefined ? isoOf(last) : null },
      // One occurrence per missed window (hourly re-checks of the same one don't count).
      eventId: `window:${opening}`,
    });
  }
  return { rule: "missed_window", signals, scope: "all" };
}

/**
 * source_broken: a source auto-paused by its scraper (`broken`, set at 5
 * consecutive failures by both scrapers) raises
 * `source_broken:<kind>:<id>`. A manually `paused` source is left alone
 * (someone chose that) — unless its failure streak is at the auto-pause
 * level too. `scope` covers the given kind(s) only (keyPrefix), so the
 * finalize hook of a visa run never resolves news alerts.
 */
export function evaluateBrokenSources(
  kind: ScrapeRunKind,
  sources: Array<VisaSourceFacts | NewsSourceFacts>,
  config: ScrapeAlertsConfig
): RuleEvaluation {
  const signals: AlertSignal[] = [];
  for (const s of sources) {
    const failures = s.consecutiveFailures ?? 0;
    const autoPaused = s.status === "broken" || (s.status === "paused" && failures >= 5);
    if (!autoPaused) continue;
    const name = ("countryName" in s ? s.countryName : undefined) ?? ("name" in s ? s.name : undefined) ?? s.id;
    const lastError = "lastErrorMessage" in s && s.lastErrorMessage ? `; last error: ${s.lastErrorMessage}` : "";
    signals.push({
      rule: "source_broken",
      key: `source_broken:${kind}:${s.id}`,
      severity: ruleSeverity(config, "source_broken"),
      kind,
      subject: { type: "source", id: s.id, label: `${name} (${kind} source)` },
      message: `${name} (${kind} source) was auto-paused after ${failures} consecutive failed runs and is no longer scraped${lastError}`.slice(0, 600),
      details: { sourceId: s.id, status: s.status ?? null, consecutiveFailures: failures },
    });
  }
  return { rule: "source_broken", signals, scope: { keyPrefix: `source_broken:${kind}:` } };
}

/**
 * fx_refresh_failing (#59): the rates in appConfig/fx were last fetched
 * more than fxFailingHours ago AND the latest finished visa run tried to
 * refresh them and failed (`summary.fxRefreshed === false`). Rates merely
 * ageing between visa runs (no run tried) is not a failure. Clears once a
 * refresh succeeds.
 *
 * @param fxFetchedAtMs appConfig/fx.fetchedAt (undefined: no rates stored yet)
 * @param latestVisaRun latest finished, non-script visa run (undefined: none)
 */
export function evaluateFx(
  fxFetchedAtMs: number | undefined,
  latestVisaRun: ScrapeRunDoc | undefined,
  nowMs: number,
  config: ScrapeAlertsConfig
): RuleEvaluation {
  const signals: AlertSignal[] = [];
  const limitMs = config.thresholds.fxFailingHours * HOUR_MS;
  const lastFailed = latestVisaRun?.summary?.fxRefreshed === false;
  const stale = fxFetchedAtMs === undefined || nowMs - fxFetchedAtMs > limitMs;
  if (lastFailed && stale && latestVisaRun) {
    const age = fxFetchedAtMs === undefined ? "never fetched" : `last refreshed ${isoOf(fxFetchedAtMs)} (${hours(nowMs - fxFetchedAtMs)}h ago)`;
    const warning = (latestVisaRun.warnings ?? []).find((w) => w.startsWith("FX refresh failed"));
    signals.push({
      rule: "fx_refresh_failing",
      key: "fx_refresh_failing:fx",
      severity: ruleSeverity(config, "fx_refresh_failing"),
      kind: "visa",
      subject: { type: "fx", id: "fx", label: "FX rates (appConfig/fx)" },
      message: `FX rates are failing to refresh: ${age}; the latest visa run (${latestVisaRun.id}) could not refresh them${warning ? ` (${warning})` : ""}`.slice(0, 600),
      details: {
        fetchedAt: fxFetchedAtMs !== undefined ? isoOf(fxFetchedAtMs) : null,
        hoursSinceRefresh: fxFetchedAtMs !== undefined ? hours(nowMs - fxFetchedAtMs) : null,
        runId: latestVisaRun.id,
      },
      runId: latestVisaRun.id,
    });
  }
  return { rule: "fx_refresh_failing", signals, scope: "all" };
}

/** Severity for a budget level: >= 100% critical, >= 80% warning, else info. */
export function budgetSeverity(pct: number): ScrapeAlertSeverity {
  if (pct >= 100) return "critical";
  if (pct >= 80) return "warning";
  return "info";
}

/**
 * llm_budget (#82): month-to-date LLM cost at or past a configured % of the
 * budget raises `llm_budget:<YYYY-MM>` with `level` = the highest % reached
 * (so 50 -> 80 -> 100 escalates the same alert). A month with no level
 * reached, or a new month, resolves old months' alerts (scope "all").
 * With no budget configured (null / <= 0) the rule is SKIPPED: returns null
 * and touches nothing.
 */
export function evaluateBudget(
  cost: { monthUsd: number; budgetUsd: number | null },
  nowMs: number,
  config: ScrapeAlertsConfig
): RuleEvaluation | null {
  if (cost.budgetUsd === null || !(cost.budgetUsd > 0) || !Number.isFinite(cost.monthUsd)) return null;
  const month = isoOf(nowMs).slice(0, 7);
  const spentPct = (cost.monthUsd / cost.budgetUsd) * 100;
  const reached = config.thresholds.budgetPcts.filter((p) => spentPct >= p);
  if (reached.length === 0) return { rule: "llm_budget", signals: [], scope: "all" };
  const level = reached[reached.length - 1];
  const override = config.rules.llm_budget?.severity;
  return {
    rule: "llm_budget",
    scope: "all",
    signals: [
      {
        rule: "llm_budget",
        key: `llm_budget:${month}`,
        severity: override ?? budgetSeverity(level),
        level,
        kind: null,
        subject: { type: "budget", id: month, label: `LLM budget ${month}` },
        message: `LLM cost this month is $${cost.monthUsd.toFixed(2)}, ${Math.round(spentPct)}% of the $${cost.budgetUsd.toFixed(2)} budget (passed ${level}%)`,
        details: { month, monthUsd: Math.round(cost.monthUsd * 100) / 100, budgetUsd: cost.budgetUsd, spentPct: Math.round(spentPct), levelPct: level },
      },
    ],
  };
}

/** One item waiting in the review queue. */
export interface ReviewQueueItem {
  kind: "visa" | "change"; // scraped visa pending review | open pendingVisaChanges row
  id: string;
  queuedAtMs: number; // when it entered the queue
}

/**
 * review_queue_stale: any scraped visa pending review or open
 * pendingVisaChanges row waiting longer than reviewQueueMaxAgeDays raises
 * `review_queue_stale:visa` (one alert for the queue; the message counts
 * them). Clears when nothing is that old.
 */
export function evaluateReviewQueue(items: ReviewQueueItem[], nowMs: number, config: ScrapeAlertsConfig): RuleEvaluation {
  const maxAgeMs = config.thresholds.reviewQueueMaxAgeDays * DAY_MS;
  const stale = items.filter((i) => nowMs - i.queuedAtMs > maxAgeMs);
  if (stale.length === 0) return { rule: "review_queue_stale", signals: [], scope: "all" };
  const visas = stale.filter((i) => i.kind === "visa").length;
  const changes = stale.length - visas;
  const oldest = Math.min(...stale.map((i) => i.queuedAtMs));
  const oldestDays = Math.floor((nowMs - oldest) / DAY_MS);
  return {
    rule: "review_queue_stale",
    scope: "all",
    signals: [
      {
        rule: "review_queue_stale",
        key: "review_queue_stale:visa",
        severity: ruleSeverity(config, "review_queue_stale"),
        kind: "visa",
        subject: { type: "review_queue", id: "visa", label: "Visa review queue" },
        message:
          `${stale.length} item(s) have waited more than ${config.thresholds.reviewQueueMaxAgeDays} days for review ` +
          `(${visas} scraped visa(s), ${changes} proposed change(s)); the oldest has waited ${oldestDays} days`,
        details: { staleItems: stale.length, scrapedVisas: visas, proposedChanges: changes, oldestDays, maxAgeDays: config.thresholds.reviewQueueMaxAgeDays },
      },
    ],
  };
}
