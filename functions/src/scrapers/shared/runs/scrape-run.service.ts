import { FieldValue, Timestamp, type Transaction } from "firebase-admin/firestore";
import { collections, db } from "../../../utils/firebase";
import { redactSecrets } from "../fetch/redact";
import {
  ScrapeRunDoc,
  ScrapeRunError,
  ScrapeRunKind,
  ScrapeRunPageEntry,
  ScrapeRunSourceEntry,
  ScrapeRunStatus,
  ScrapeRunTrigger,
} from "./types";
import type { VisaSource } from "../../visa-catalog/types";
import type { NewsSource } from "../../../types/news";
import { hostBackoffEntriesFromSource } from "../etiquette/visa-crawl-host-backoff-store";
// Issue #82: per-run usage / cost accumulation (pure helpers, no Firestore).
import {
  addPricedUsage,
  emptyBreakdown,
  emptyTotals,
  isFiniteCost,
  roundUsd,
  type PricedUsage,
} from "../cost/scrape-cost-pricing";
import type { CostTotals, RunCostBreakdown } from "../cost/types";
// Issue #107: the consecutiveFailureLimit in force, for the health rows.
// (The store module only imports utils/firebase + types: no cycle.)
import { loadScraperSettings } from "../settings/scraper-settings.store";

// ============================================
// SCRAPE RUNS — recorder + admin reads (issue #81)
// ============================================
//
// Every visa-catalog and news scraper run leaves one `scrapeRuns/{runId}`
// doc (shape: scrapers/shared/runs/types.ts):
//
//   1. start()    -> writes the doc as `running` (startedAt, kind, trigger,
//                    options, expireAt) and returns a ScrapeRunRecorder.
//   2. the scraper notes sources / pages / errors on the recorder (in memory,
//                    no writes — a run is at most a few hundred pages).
//   3. finalize() -> ONE update with status, finishedAt, durationMs, the full
//                    summary, sources, pages and the first N errors, plus the
//                    run's LLM usage / cost / news request counts (#82); then
//                    the registered finalize hooks run (#82 rollup, #83 alerts).
//      fail()     -> same, for a run that threw: status `failed` + fatalError.
//
// Crash safety: a run that dies between 1 and 3 (function timeout, OOM, a
// killed script) stays `running`. sweepStaleRuns(), called at the start of
// every scheduled tick, marks any `running` doc older than STALE_RUN_MS as
// `failed` with fatalError "stale: ...".
//
// Recording must NEVER break a crawl: every Firestore write here is
// try/caught and logged. If the start write fails, the recorder is
// "detached" (keeps counting, writes nothing) and the run goes on.
//
// Clock: the run's startedAt is the scraper's tick clock (the visa
// orchestrator's injectable `now`), and finishedAt = startedAt + REAL elapsed
// time — the same convention as the per-source crawlRuns log, so an injected
// `now` (tests / emulator checks) stays consistent while durationMs is real.

/** Runs are deleted by the Firestore TTL policy this many days after startedAt. */
export const SCRAPE_RUN_RETENTION_DAYS = 180;
/** A `running` run older than this is considered crashed and swept to `failed`. */
export const STALE_RUN_MS = 60 * 60 * 1000;
/** Errors stored on the run doc (all are counted in `errorCount`). */
export const MAX_RECORDED_ERRORS = 20;
/** Page lines stored on the run doc (keeps the doc well under Firestore's 1 MiB). */
export const MAX_RECORDED_PAGES = 300;
/** Source lines stored on the run doc. */
export const MAX_RECORDED_SOURCES = 100;
/** Run-level warnings stored on the run doc (e.g. a failed fee re-convert). */
export const MAX_RECORDED_WARNINGS = 10;
/** fatalError written by the stale sweep. */
export const STALE_RUN_MESSAGE =
  "stale: run did not finish within 1h (crashed or timed out); marked failed by a later run";
/** Longest stored error message (after redaction). */
const MAX_ERROR_CHARS = 500;

/** Admin list defaults (GET /admin/scrape-runs). */
export const SCRAPE_RUN_LIST_DEFAULT_LIMIT = 25;
export const SCRAPE_RUN_LIST_MAX_LIMIT = 100;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Called once per run, AFTER its final write, with the final doc. Hook point
 * for later issues: #82 (aggregate cost / monthly rollup) and #83 (evaluate
 * alert rules). A hook that throws is logged and ignored — it can never fail
 * the run or block another hook.
 */
export type ScrapeRunFinalizeHook = (run: ScrapeRunDoc) => Promise<void> | void;

/** Redact + cap an error message for storage. */
export function safeErrorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return redactSecrets(raw).slice(0, MAX_ERROR_CHARS);
}

/**
 * The run status from what happened. Shared by both scrapers so "partial"
 * means the same thing everywhere:
 *  - no errors                      -> succeeded (incl. a run that only deferred);
 *  - errors, but something worked   -> partial;
 *  - errors and nothing worked      -> failed.
 */
export function deriveRunStatus(errorCount: number, anySuccess: boolean): Exclude<ScrapeRunStatus, "running"> {
  if (errorCount === 0) return "succeeded";
  return anySuccess ? "partial" : "failed";
}

/** Options for scrapeRunService.start(). */
export interface StartRunOptions {
  kind: ScrapeRunKind;
  trigger: ScrapeRunTrigger;
  /** Run clock start (epoch ms). Defaults to the real clock. */
  startedAtMs?: number;
  /** The run's knobs, stored as `options` (see ScrapeRunDoc). */
  options?: Record<string, string | number | boolean | undefined>;
}

/** What finalize() needs from the scraper. */
export interface FinalizeRunInput {
  /** The scraper's summary object, stored verbatim as `summary`. */
  summary: object;
  /** Did any of the run's work succeed (see deriveRunStatus). */
  anySuccess: boolean;
  /** Override the derived status (rarely needed). */
  status?: Exclude<ScrapeRunStatus, "running">;
}

// ============================================
// RECORDER — one per run
// ============================================

/**
 * Accumulates one run's sources / pages / errors in memory and writes the
 * final doc. Obtain via scrapeRunService.start(); not constructed directly by
 * scrapers.
 */
export class ScrapeRunRecorder {
  private readonly sources: ScrapeRunSourceEntry[] = [];
  private readonly pages: ScrapeRunPageEntry[] = [];
  private readonly errors: ScrapeRunError[] = [];
  // Run-level problems that are NOT errors: they never count in errorCount
  // and never change the status (e.g. the FX fee re-convert failing, #59).
  private readonly warnings: string[] = [];
  private sourcesAttempted = 0;
  private pagesAttempted = 0;
  private errorCount = 0;
  // True once a page line was dropped for MAX_RECORDED_PAGES (-> pagesTruncated).
  private pagesDropped = false;
  private finished = false;
  // ---- Issue #82: usage + cost, summed in memory, written at finalize ----
  // Every LLM call (recordUsage) and news API request (recordRequests).
  // `runs` stays 0 here and is set to 1 in the written doc (see write()).
  private readonly usage: CostTotals = emptyTotals();
  // The same per country (visa sourceId) and per model (requested model).
  private readonly breakdown: RunCostBreakdown = emptyBreakdown();
  // Real clock at start, to measure durationMs (see the header on clocks).
  private readonly realStartMs: number;

  constructor(
    private readonly service: ScrapeRunService,
    /** The `scrapeRuns` doc id (also when detached, for logging/linking). */
    readonly id: string,
    readonly kind: ScrapeRunKind,
    readonly trigger: ScrapeRunTrigger,
    private readonly startedAtMs: number,
    private readonly options: Record<string, string | number | boolean>,
    /** false when the start write failed: count, but never write. */
    readonly persisted: boolean
  ) {
    this.realStartMs = service.realClock();
  }

  /** Note one source's outcome (counted even past MAX_RECORDED_SOURCES). */
  recordSource(entry: ScrapeRunSourceEntry): void {
    this.sourcesAttempted++;
    if (this.sources.length < MAX_RECORDED_SOURCES) {
      this.sources.push({ ...entry, error: entry.error ? redactSecrets(entry.error).slice(0, MAX_ERROR_CHARS) : undefined });
    }
  }

  /**
   * Note one page's outcome (counted even past MAX_RECORDED_PAGES).
   * "supplement" rows (#86) are listed but not counted as attempted pages:
   * they are fetched as part of the routes that use them.
   */
  recordPage(entry: ScrapeRunPageEntry): void {
    if (entry.outcome !== "supplement") this.pagesAttempted++;
    if (this.pages.length >= MAX_RECORDED_PAGES) {
      this.pagesDropped = true; // counted above, not stored
    } else {
      this.pages.push({ ...entry, error: entry.error ? redactSecrets(entry.error).slice(0, MAX_ERROR_CHARS) : undefined });
    }
  }

  /**
   * Count pages without per-page lines (news: listing / feed / API / article
   * requests are counted, not itemised).
   */
  addPagesAttempted(n: number): void {
    this.pagesAttempted += n;
  }

  /** Note one error; the first MAX_RECORDED_ERRORS are stored, redacted. */
  recordError(e: { sourceId?: string; url?: string; error: unknown }): void {
    this.errorCount++;
    if (this.errors.length < MAX_RECORDED_ERRORS) {
      this.errors.push({
        sourceId: e.sourceId,
        url: e.url ? redactSecrets(e.url) : undefined,
        message: safeErrorMessage(e.error),
        at: Timestamp.fromMillis(this.startedAtMs + (this.service.realClock() - this.realStartMs)),
      });
    }
  }

  /**
   * Note a run-level warning (first MAX_RECORDED_WARNINGS stored, redacted).
   * Not an error: errorCount and the derived status are unaffected.
   */
  recordWarning(message: string): void {
    if (this.warnings.length < MAX_RECORDED_WARNINGS) {
      this.warnings.push(redactSecrets(message).slice(0, MAX_ERROR_CHARS));
    }
  }

  /**
   * Note one LLM call's usage + cost (issue #82). Call it for EVERY call that
   * reached the API, including one whose output then failed validation (it
   * was billed). `sourceId` (visa: the country code) feeds the per-country
   * split; the per-model split uses the requested model. An unpriced model
   * adds tokens and `unpricedExtractions`, never a made-up cost.
   */
  recordUsage(p: PricedUsage & { sourceId?: string }): void {
    addPricedUsage(this.usage, p);
    if (p.sourceId) {
      const c = (this.breakdown.byCountry[p.sourceId] ??= emptyTotals());
      addPricedUsage(c, p);
    }
    const m = (this.breakdown.byModel[p.model] ??= emptyTotals());
    addPricedUsage(m, p);
  }

  /**
   * Note `n` API requests to a news provider ("newsdata" / "newsapi",
   * issue #82). `costUsd` only when the provider's plan has a per-call price
   * (appConfig/llmPricing.requestPricing); otherwise requests are counted only.
   */
  recordRequests(provider: string, n: number, costUsd?: number): void {
    if (!(n > 0)) return;
    this.usage.requests[provider] = (this.usage.requests[provider] ?? 0) + n;
    // A non-finite cost (bad price) is ignored: the requests stay counted.
    if (isFiniteCost(costUsd) && costUsd > 0) this.usage.costUsd = roundUsd(this.usage.costUsd + costUsd);
  }

  /** The run's usage so far (a copy; for logging, e.g. the script's summary line). */
  get usageSoFar(): CostTotals {
    return { ...this.usage, requests: { ...this.usage.requests } };
  }

  /** Recorded errors so far (callers use it to reconcile counters). */
  get recordedErrorCount(): number {
    return this.errorCount;
  }

  /**
   * Finish the run normally. `summary.errors` (when the scraper has one) wins
   * over the recorder's own count, so the doc's `errorCount` always equals
   * the summary the scraper logged. Never throws. Idempotent: a second
   * finalize/fail is ignored.
   */
  async finalize(input: FinalizeRunInput): Promise<ScrapeRunDoc | undefined> {
    const summaryErrors = (input.summary as { errors?: unknown }).errors;
    const errorCount = typeof summaryErrors === "number" ? Math.max(summaryErrors, this.errorCount) : this.errorCount;
    const status = input.status ?? deriveRunStatus(errorCount, input.anySuccess);
    return this.write(status, input.summary, errorCount);
  }

  /** Finish a run that threw: `failed` + redacted fatalError. Never throws. */
  async fail(error: unknown, summary: object = {}): Promise<ScrapeRunDoc | undefined> {
    this.recordError({ error });
    return this.write("failed", summary, this.errorCount, safeErrorMessage(error));
  }

  /** The single final write + hooks. */
  private async write(
    status: Exclude<ScrapeRunStatus, "running">,
    summary: object,
    errorCount: number,
    fatalError?: string
  ): Promise<ScrapeRunDoc | undefined> {
    if (this.finished) return undefined;
    this.finished = true;
    const durationMs = Math.max(0, this.service.realClock() - this.realStartMs);
    const startedAt = Timestamp.fromMillis(this.startedAtMs);
    const finishedAt = Timestamp.fromMillis(this.startedAtMs + durationMs);
    // Issue #82: the run's usage (runs: 1, so monthly sums count runs) and
    // its per-country / per-model split (each entry also runs: 1).
    const usage: CostTotals = { ...this.usage, runs: 1, requests: { ...this.usage.requests } };
    const withRun = (map: Record<string, CostTotals>) =>
      Object.fromEntries(Object.entries(map).map(([k, t]) => [k, { ...t, runs: 1 }]));
    const costBreakdown: RunCostBreakdown = {
      byCountry: withRun(this.breakdown.byCountry),
      byModel: withRun(this.breakdown.byModel),
    };
    const final = {
      status,
      finishedAt,
      durationMs,
      summary: { ...(summary as Record<string, number | boolean>) },
      sourcesAttempted: this.sourcesAttempted,
      pagesAttempted: this.pagesAttempted,
      sources: this.sources,
      pages: this.pages,
      pagesTruncated: this.pagesDropped,
      errorCount,
      errors: this.errors,
      warnings: this.warnings,
      usage,
      costUsd: usage.costUsd,
      costBreakdown,
      // #82 review: the rollup hook flips this to true (see backfillRecent).
      costRolledUp: false,
      updatedAt: finishedAt,
    };
    // fatalError: set by fail(). Otherwise CLEARED, so a run the stale sweep
    // wrongly marked failed (it finalised late) does not keep the "stale"
    // message next to its real status.
    const finalWrite = { ...final, fatalError: fatalError ?? FieldValue.delete() };
    // The full doc as it now stands (what hooks receive).
    const doc: ScrapeRunDoc = {
      id: this.id,
      kind: this.kind,
      trigger: this.trigger,
      startedAt,
      options: this.options,
      expireAt: expireAtFor(this.startedAtMs),
      createdAt: startedAt,
      ...final,
      ...(fatalError ? { fatalError } : {}),
    };
    if (!this.persisted) return doc;
    try {
      await collections.scrapeRuns.doc(this.id).update(finalWrite);
    } catch (err) {
      console.error(`Scrape run ${this.id}: final write failed: ${safeErrorMessage(err)}`);
      return doc;
    }
    await this.service.runFinalizeHooks(doc);
    return doc;
  }
}

/** TTL instant for a run started at `startedAtMs`. */
function expireAtFor(startedAtMs: number): Timestamp {
  return Timestamp.fromMillis(startedAtMs + SCRAPE_RUN_RETENTION_DAYS * DAY_MS);
}

// ============================================
// ADMIN READ SHAPES (JSON; Timestamps -> ISO strings)
// ============================================

/** Filters for listRuns (validated by the controller). */
export interface ListRunsQuery {
  kind?: ScrapeRunKind;
  status?: ScrapeRunStatus;
  fromMs?: number; // startedAt >= from
  toMs?: number; // startedAt <= to
  limit: number;
  cursor?: string; // a run id from a previous page's nextCursor
}

/** Thrown for a cursor that names no run (→ 400). */
export class InvalidCursorError extends Error {
  constructor() {
    super("cursor does not match a scrape run");
  }
}

/** Stats query (GET /admin/scrape-runs/stats), validated by the controller. */
export interface RunStatsQuery {
  fromMs: number; // inclusive, startedAt >= from
  toMs: number; // inclusive, startedAt <= to
  kind?: ScrapeRunKind;
}

/** Longest stats range (days). */
export const RUN_STATS_MAX_DAYS = 90;
/** Default stats range when `from` is omitted (days back from `to`). */
export const RUN_STATS_DEFAULT_DAYS = 30;
/**
 * Most run docs one stats call reads. ~55 runs/day (48 news + a few visa
 * ticks) x 90 days ≈ 5,000, so this leaves 2x headroom; past it the answer
 * is marked `truncated` instead of reading without bound.
 */
export const RUN_STATS_MAX_SCAN = 10_000;

/** Per-status run counts for one kind in one bucket. */
export interface RunStatusCounts {
  succeeded: number;
  partial: number;
  failed: number;
  running: number;
  total: number;
}

/** GET /admin/scrape-runs/stats response. */
export interface RunStats {
  from: string; // ISO, as applied
  to: string; // ISO, as applied
  bucket: "day"; // UTC calendar days
  kinds: ScrapeRunKind[]; // the kinds counted (one when `kind` was given)
  // One entry per UTC day from `from` to `to` (inclusive), oldest first,
  // zero-filled; each has a counts object per kind in `kinds`.
  buckets: Array<{ date: string } & Partial<Record<ScrapeRunKind, RunStatusCounts>>>;
  totals: Partial<Record<ScrapeRunKind, RunStatusCounts>>;
  scanned: number; // run docs read
  truncated: boolean; // true when RUN_STATS_MAX_SCAN was hit (oldest days undercounted)
}

/** A zeroed counts object. */
function zeroCounts(): RunStatusCounts {
  return { succeeded: 0, partial: 0, failed: 0, running: 0, total: 0 };
}

/** UTC day key ("2026-11-10") of an epoch-ms instant. */
function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** One source's health, normalised across kinds (GET /admin/scrape-sources). */
export interface ScrapeSourceHealth {
  kind: ScrapeRunKind;
  sourceId: string;
  name: string;
  countryCodes: string[];
  status: string; // visa: active|paused|broken; news: active|paused|broken|retired
  reliabilityScore: number | null;
  consecutiveFailures: number;
  lastCrawledAt: string | null;
  nextCrawlAt: string | null;
  // Visa only (#63): the weekly local-night window; null for news / legacy.
  crawlWindow: Record<string, unknown> | null;
  // Visa: legacy interval hours; news: scrapeIntervalMinutes / 60.
  intervalHours: number | null;
  // Still-active 429/503 backoffs (visa, #64). News keeps none on the source.
  hostBackoffs: { host: string; until: string; status: number; recordedAt: string }[];
  lastError: { message: string; at: string | null; url?: string } | null;
  pageCount: number | null; // visa: registry pages; news: null
  pagesWithErrors: number | null; // visa: pages whose lastError is set
  // Issue #96: the admin's per-source edits (status + reason, crawl window,
  // who / when; ISO dates), or null when none were made.
  adminOverrides: Record<string, unknown> | null;
  // ---- Issue #107 (additive) ----
  // True while the CRAWLER holds the source: `broken` after
  // `consecutiveFailureLimit` consecutive failures (cause "failure_limit"),
  // or `paused` because a news_api key is missing (cause "missing_api_key").
  // An admin pause has autoPaused false (its reason is in adminOverrides).
  autoPaused: boolean;
  autoPausedAt: string | null;
  autoPausedReason: string | null; // the last error at the pause (redacted)
  autoPauseCause: string | null; // "failure_limit" | "missing_api_key"
  // `<kind>.consecutiveFailureLimit` in force (appConfig/scraperSettings).
  consecutiveFailureLimit: number;
  // Why the registry seed ships the source paused / retired (news), or null.
  statusReason: string | null;
}

/** Per-kind failure limits passed to the row builders. */
type FailureLimits = Record<ScrapeRunKind, number>;

/** Read the limits in force (settings read never throws: defaults on error). */
async function loadFailureLimits(): Promise<FailureLimits> {
  const settings = await loadScraperSettings();
  return { visa: settings.visa.consecutiveFailureLimit, news: settings.news.consecutiveFailureLimit };
}

/** Issue #107: the auto-pause fields of a stored source doc, as JSON. */
function autoPauseJson(s: Record<string, unknown>): Pick<
  ScrapeSourceHealth,
  "autoPaused" | "autoPausedAt" | "autoPausedReason" | "autoPauseCause" | "statusReason"
> {
  return {
    // A legacy `broken` doc (auto-paused before #107, no flag) is auto-paused too.
    autoPaused: s.autoPaused === true || s.status === "broken",
    autoPausedAt: iso(s.autoPausedAt),
    autoPausedReason: typeof s.autoPausedReason === "string" ? redactSecrets(s.autoPausedReason) : null,
    autoPauseCause:
      typeof s.autoPauseCause === "string" ? s.autoPauseCause : s.status === "broken" ? "failure_limit" : null,
    statusReason: typeof s.statusReason === "string" ? s.statusReason : null,
  };
}

/** Timestamp-like (duck-typed, survives a second SDK copy). */
function isTs(v: unknown): v is { toMillis(): number } {
  return Boolean(v) && typeof (v as { toMillis?: unknown }).toMillis === "function";
}

/** Timestamp -> ISO string (null when absent / malformed). */
function iso(v: unknown): string | null {
  return isTs(v) ? new Date(v.toMillis()).toISOString() : null;
}

/** Deep-convert every Timestamp in a stored doc to an ISO string. */
export function toJson(value: unknown): unknown {
  if (isTs(value)) return new Date(value.toMillis()).toISOString();
  if (Array.isArray(value)) return value.map(toJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, toJson(v)]));
  }
  return value;
}

/** A stored run as the API returns it (ISO dates). */
export type ScrapeRunJson = Record<string, unknown> & { id: string };

// ============================================
// SERVICE
// ============================================

export class ScrapeRunService {
  private readonly hooks: ScrapeRunFinalizeHook[] = [];

  /** Transaction runner (the stale sweep). Swapped for the in-memory one in tests. */
  runTransaction: <T>(fn: (tx: Transaction) => Promise<T>) => Promise<T> = (fn) => db.runTransaction(fn);

  /** Real clock (ms). Swappable in tests to make durationMs deterministic. */
  realClock: () => number = Date.now;

  /**
   * Register a finalize hook (#82 / #83). Hooks run in registration order
   * after every run's final write. Returns an unregister function (tests).
   */
  registerFinalizeHook(hook: ScrapeRunFinalizeHook): () => void {
    this.hooks.push(hook);
    return () => {
      const i = this.hooks.indexOf(hook);
      if (i >= 0) this.hooks.splice(i, 1);
    };
  }

  /** Run every hook, isolating failures. */
  async runFinalizeHooks(run: ScrapeRunDoc): Promise<void> {
    for (const hook of [...this.hooks]) {
      try {
        await hook(run);
      } catch (err) {
        console.error(`Scrape run ${run.id}: finalize hook failed: ${safeErrorMessage(err)}`);
      }
    }
  }

  /**
   * Start a run: write `scrapeRuns/{id}` as `running`. Never throws — on a
   * failed write the recorder is detached (counts, writes nothing).
   */
  async start(opts: StartRunOptions): Promise<ScrapeRunRecorder> {
    const startedAtMs = opts.startedAtMs ?? this.realClock();
    // Drop undefined knobs (Firestore is configured to ignore them, but the
    // fake in tests and readers are simpler with a clean map).
    const options = Object.fromEntries(
      Object.entries(opts.options ?? {}).filter(([, v]) => v !== undefined)
    ) as Record<string, string | number | boolean>;
    const ref = collections.scrapeRuns.doc();
    const startedAt = Timestamp.fromMillis(startedAtMs);
    const doc: ScrapeRunDoc = {
      id: ref.id,
      kind: opts.kind,
      trigger: opts.trigger,
      status: "running",
      startedAt,
      finishedAt: null,
      durationMs: null,
      summary: {},
      sourcesAttempted: 0,
      pagesAttempted: 0,
      sources: [],
      pages: [],
      pagesTruncated: false,
      errorCount: 0,
      errors: [],
      options,
      expireAt: expireAtFor(startedAtMs),
      createdAt: startedAt,
      updatedAt: startedAt,
    };
    let persisted = true;
    try {
      await ref.set(doc);
    } catch (err) {
      persisted = false;
      console.error(`Scrape run (${opts.kind}): start write failed, run not recorded: ${safeErrorMessage(err)}`);
    }
    return new ScrapeRunRecorder(this, ref.id, opts.kind, opts.trigger, startedAtMs, options, persisted);
  }

  /**
   * Mark every `running` run that started more than STALE_RUN_MS before
   * `nowMs` as `failed` (it crashed without finalising). Called at the start
   * of each scheduled tick of either scraper (so within ~1.5h of a crash).
   * Equality-only query (no composite index): running runs are a handful at
   * most, so the age filter is done in code. Never throws; returns the
   * number swept.
   */
  async sweepStaleRuns(nowMs: number = this.realClock()): Promise<number> {
    try {
      const snap = await collections.scrapeRuns.where("status", "==", "running").get();
      let swept = 0;
      for (const d of snap.docs) {
        const listed = d.data() as ScrapeRunDoc;
        if (!isTs(listed.startedAt) || nowMs - listed.startedAt.toMillis() <= STALE_RUN_MS) continue;
        // Re-read inside a transaction and only flip a run that is STILL
        // `running`: a slow run that finalised between the query and this
        // write (or another tick sweeping concurrently) is left alone.
        const flipped = await this.runTransaction(async (tx) => {
          const fresh = await tx.get(d.ref);
          const run = fresh.data() as ScrapeRunDoc | undefined;
          if (!fresh.exists || !run || run.status !== "running" || !isTs(run.startedAt)) return false;
          const now = Timestamp.fromMillis(nowMs);
          tx.update(d.ref, {
            status: "failed",
            finishedAt: now,
            // Unknown real duration: report the time until it was found stale.
            durationMs: nowMs - run.startedAt.toMillis(),
            fatalError: STALE_RUN_MESSAGE,
            errorCount: (run.errorCount ?? 0) + 1,
            updatedAt: now,
          });
          return true;
        });
        if (!flipped) continue;
        swept++;
        console.warn(`Scrape run ${d.id} (${listed.kind}) was stale, marked failed`);
      }
      return swept;
    } catch (err) {
      console.error(`Scrape runs: stale sweep failed: ${safeErrorMessage(err)}`);
      return 0;
    }
  }

  // ---------- Admin reads ----------

  /**
   * Newest-first page of runs. Filters are ANDed. Indexes
   * (firestore.indexes.json): kind+startedAt, status+startedAt,
   * kind+status+startedAt (all startedAt DESC); startedAt alone uses the
   * automatic single-field index. Pagination: `nextCursor` is the last run's
   * id; pass it back as `cursor` (startAfter that doc). null = last page.
   */
  async listRuns(q: ListRunsQuery): Promise<{ items: ScrapeRunJson[]; nextCursor: string | null }> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let query: any = collections.scrapeRuns;
    if (q.kind) query = query.where("kind", "==", q.kind);
    if (q.status) query = query.where("status", "==", q.status);
    if (q.fromMs !== undefined) query = query.where("startedAt", ">=", Timestamp.fromMillis(q.fromMs));
    if (q.toMs !== undefined) query = query.where("startedAt", "<=", Timestamp.fromMillis(q.toMs));
    query = query.orderBy("startedAt", "desc");
    if (q.cursor) {
      const cursorSnap = await collections.scrapeRuns.doc(q.cursor).get();
      if (!cursorSnap.exists) throw new InvalidCursorError();
      query = query.startAfter(cursorSnap);
    }
    // One extra row tells us whether another page exists.
    const snap = await query.limit(q.limit + 1).get();
    const docs = snap.docs.slice(0, q.limit);
    return {
      items: docs.map((d: { id: string; data: () => unknown }) => listItem(d.id, d.data())),
      nextCursor: snap.docs.length > q.limit ? docs[docs.length - 1].id : null,
    };
  }

  /**
   * Per-UTC-day run counts by status, per kind (the dashboard overview, #84).
   *
   * One bounded scan instead of count() aggregations: a count query per
   * day x kind x status would be up to 90 x 2 x 4 = 720 queries per call.
   * The scan reads only `kind`, `status`, `startedAt` (select projection),
   * newest first (served by the kind+startedAt DESC index, or the
   * single-field startedAt index without `kind`), capped at
   * RUN_STATS_MAX_SCAN docs (then `truncated: true`). The controller caps
   * the range at RUN_STATS_MAX_DAYS.
   */
  async runStats(q: RunStatsQuery): Promise<RunStats> {
    const kinds: ScrapeRunKind[] = q.kind ? [q.kind] : ["visa", "news"];
    // ---- Zero-filled day buckets, oldest first ----
    const buckets: RunStats["buckets"] = [];
    const byDay = new Map<string, RunStats["buckets"][number]>();
    for (let t = Date.parse(`${utcDay(q.fromMs)}T00:00:00Z`); t <= q.toMs; t += DAY_MS) {
      const b: RunStats["buckets"][number] = { date: utcDay(t) };
      for (const k of kinds) b[k] = zeroCounts();
      buckets.push(b);
      byDay.set(b.date, b);
    }
    const totals: RunStats["totals"] = {};
    for (const k of kinds) totals[k] = zeroCounts();

    // ---- Bounded scan ----
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let query: any = collections.scrapeRuns;
    if (q.kind) query = query.where("kind", "==", q.kind);
    query = query
      .where("startedAt", ">=", Timestamp.fromMillis(q.fromMs))
      .where("startedAt", "<=", Timestamp.fromMillis(q.toMs))
      .orderBy("startedAt", "desc")
      .select("kind", "status", "startedAt")
      .limit(RUN_STATS_MAX_SCAN + 1);
    const snap = await query.get();
    const docs = snap.docs.slice(0, RUN_STATS_MAX_SCAN);
    for (const d of docs) {
      const run = d.data() as Pick<ScrapeRunDoc, "kind" | "status" | "startedAt">;
      if (!isTs(run.startedAt) || !kinds.includes(run.kind)) continue;
      const bucket = byDay.get(utcDay(run.startedAt.toMillis()));
      const counts = bucket?.[run.kind];
      const total = totals[run.kind];
      if (!counts || !total) continue;
      // Unknown status values (none today) only count toward `total`.
      if (run.status in counts && run.status !== ("total" as string)) {
        counts[run.status as keyof Omit<RunStatusCounts, "total">]++;
        total[run.status as keyof Omit<RunStatusCounts, "total">]++;
      }
      counts.total++;
      total.total++;
    }
    return {
      from: new Date(q.fromMs).toISOString(),
      to: new Date(q.toMs).toISOString(),
      bucket: "day",
      kinds,
      buckets,
      totals,
      scanned: docs.length,
      truncated: snap.docs.length > RUN_STATS_MAX_SCAN,
    };
  }

  /** One full run (ISO dates), or null. */
  async getRun(id: string): Promise<ScrapeRunJson | null> {
    const snap = await collections.scrapeRuns.doc(id).get();
    if (!snap.exists) return null;
    return { ...(toJson(snap.data()) as Record<string, unknown>), id: snap.id };
  }

  /** Per-source health for one kind, or both when `kind` is omitted. */
  async listSourceHealth(kind: ScrapeRunKind | undefined, nowMs: number = this.realClock()): Promise<ScrapeSourceHealth[]> {
    const out: ScrapeSourceHealth[] = [];
    // Issue #107: one settings read for the limit shown on every row.
    const limits = await loadFailureLimits();
    if (!kind || kind === "visa") {
      const snap = await collections.visaSources.get();
      for (const d of snap.docs) out.push(visaHealth(d.id, d.data() as VisaSource, nowMs, limits.visa));
    }
    if (!kind || kind === "news") {
      const snap = await collections.newsSources.get();
      for (const d of snap.docs) out.push(newsHealth(d.id, d.data() as NewsSource, limits.news));
    }
    return out;
  }

  /**
   * Issue #96: the health row of ONE source (after an admin edit), or null
   * when the doc does not exist. One read.
   */
  async getSourceHealth(kind: ScrapeRunKind, id: string, nowMs: number = this.realClock()): Promise<ScrapeSourceHealth | null> {
    const snap = await (kind === "visa" ? collections.visaSources : collections.newsSources).doc(id).get();
    if (!snap.exists) return null;
    const limits = await loadFailureLimits();
    return kind === "visa"
      ? visaHealth(id, snap.data() as VisaSource, nowMs, limits.visa)
      : newsHealth(id, snap.data() as NewsSource, limits.news);
  }
}

/** Issue #96: a source doc's `adminOverrides` block as JSON (ISO dates), or null. */
function adminOverridesJson(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" ? (toJson(v) as Record<string, unknown>) : null;
}

/**
 * The list view of a run: everything except the bulky `pages` / `sources` /
 * `errors` arrays (fetch GET /admin/scrape-runs/:id for those). Keeps a
 * 100-row page small.
 */
function listItem(id: string, data: unknown): ScrapeRunJson {
  const { pages: _p, sources: _s, errors: _e, ...rest } = (data ?? {}) as Record<string, unknown>;
  void _p;
  void _s;
  void _e;
  return { ...(toJson(rest) as Record<string, unknown>), id };
}

/** Visa source -> health row. */
function visaHealth(id: string, s: VisaSource, nowMs: number, failureLimit: number): ScrapeSourceHealth {
  const pages = Array.isArray(s.pages) ? s.pages : [];
  // Most recent page error = the source's last error (sources store errors per page).
  const errored = pages
    .filter((p) => typeof p.lastError === "string" && p.lastError !== "")
    .sort((a, b) => (isTs(b.lastCrawledAt) ? b.lastCrawledAt.toMillis() : 0) - (isTs(a.lastCrawledAt) ? a.lastCrawledAt.toMillis() : 0));
  const last = errored[0];
  return {
    kind: "visa",
    sourceId: id,
    name: s.countryName ?? id,
    countryCodes: [s.countryCode ?? id],
    status: s.status,
    reliabilityScore: typeof s.reliabilityScore === "number" ? s.reliabilityScore : null,
    consecutiveFailures: s.consecutiveFailures ?? 0,
    lastCrawledAt: iso(s.lastCrawledAt),
    nextCrawlAt: iso(s.nextCrawlAt),
    crawlWindow: s.crawlWindow ? { ...s.crawlWindow } : null,
    intervalHours: typeof s.crawlIntervalHours === "number" ? s.crawlIntervalHours : null,
    // Only backoffs still in force (expired ones are pruned on the next run anyway).
    hostBackoffs: hostBackoffEntriesFromSource(s.hostBackoffs)
      .filter((b) => b.untilMs > nowMs)
      .map((b) => ({
        host: b.host,
        until: new Date(b.untilMs).toISOString(),
        status: b.status,
        recordedAt: new Date(b.recordedAtMs).toISOString(),
      })),
    lastError: last
      ? { message: redactSecrets(String(last.lastError)), at: iso(last.lastCrawledAt), url: last.url }
      : null,
    pageCount: pages.length,
    pagesWithErrors: errored.length,
    adminOverrides: adminOverridesJson((s as { adminOverrides?: unknown }).adminOverrides),
    ...autoPauseJson(s as unknown as Record<string, unknown>),
    consecutiveFailureLimit: failureLimit,
  };
}

/** News source -> health row. */
function newsHealth(id: string, s: NewsSource, failureLimit: number): ScrapeSourceHealth {
  return {
    kind: "news",
    sourceId: id,
    name: s.name ?? id,
    countryCodes: Array.isArray(s.countryCodes) ? [...s.countryCodes] : [],
    status: s.status,
    reliabilityScore: typeof s.reliabilityScore === "number" ? Math.round(s.reliabilityScore) : null,
    consecutiveFailures: s.consecutiveFailures ?? 0,
    lastCrawledAt: iso(s.lastScrapedAt),
    nextCrawlAt: iso(s.nextScrapeAt),
    crawlWindow: null,
    intervalHours: typeof s.scrapeIntervalMinutes === "number" ? s.scrapeIntervalMinutes / 60 : null,
    hostBackoffs: [],
    lastError: s.lastErrorMessage ? { message: redactSecrets(s.lastErrorMessage), at: iso(s.lastErrorAt) } : null,
    pageCount: null,
    pagesWithErrors: null,
    adminOverrides: adminOverridesJson((s as { adminOverrides?: unknown }).adminOverrides),
    ...autoPauseJson(s as unknown as Record<string, unknown>),
    consecutiveFailureLimit: failureLimit,
  };
}

export const scrapeRunService = new ScrapeRunService();
