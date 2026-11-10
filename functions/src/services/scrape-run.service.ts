import { Timestamp } from "firebase-admin/firestore";
import { collections } from "../utils/firebase";
import { redactSecrets } from "../utils/redact";
import {
  ScrapeRunDoc,
  ScrapeRunError,
  ScrapeRunKind,
  ScrapeRunPageEntry,
  ScrapeRunSourceEntry,
  ScrapeRunStatus,
  ScrapeRunTrigger,
} from "../types/scrape-run";
import type { VisaSource } from "../types/visa-catalog";
import type { NewsSource } from "../types/news";
import { hostBackoffEntriesFromSource } from "./visa-crawl-host-backoff-store";

// ============================================
// SCRAPE RUNS — recorder + admin reads (issue #81)
// ============================================
//
// Every visa-catalog and news scraper run leaves one `scrapeRuns/{runId}`
// doc (shape: types/scrape-run.ts):
//
//   1. start()    -> writes the doc as `running` (startedAt, kind, trigger,
//                    options, expireAt) and returns a ScrapeRunRecorder.
//   2. the scraper notes sources / pages / errors on the recorder (in memory,
//                    no writes — a run is at most a few hundred pages).
//   3. finalize() -> ONE update with status, finishedAt, durationMs, the full
//                    summary, sources, pages and the first N errors; then the
//                    registered finalize hooks run (#82 cost, #83 alerts).
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
  private sourcesAttempted = 0;
  private pagesAttempted = 0;
  private errorCount = 0;
  private finished = false;
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

  /** Note one page's outcome (counted even past MAX_RECORDED_PAGES). */
  recordPage(entry: ScrapeRunPageEntry): void {
    this.pagesAttempted++;
    if (this.pages.length < MAX_RECORDED_PAGES) {
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
    const final = {
      status,
      finishedAt,
      durationMs,
      summary: { ...(summary as Record<string, number | boolean>) },
      sourcesAttempted: this.sourcesAttempted,
      pagesAttempted: this.pagesAttempted,
      sources: this.sources,
      pages: this.pages,
      pagesTruncated: this.pagesAttempted > this.pages.length && this.pages.length >= MAX_RECORDED_PAGES,
      errorCount,
      errors: this.errors,
      ...(fatalError ? { fatalError } : {}),
      updatedAt: finishedAt,
    };
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
    };
    if (!this.persisted) return doc;
    try {
      await collections.scrapeRuns.doc(this.id).update(final);
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
        const run = d.data() as ScrapeRunDoc;
        if (!isTs(run.startedAt) || nowMs - run.startedAt.toMillis() <= STALE_RUN_MS) continue;
        const now = Timestamp.fromMillis(nowMs);
        await d.ref.update({
          status: "failed",
          finishedAt: now,
          // Unknown real duration: report the time until it was found stale.
          durationMs: nowMs - run.startedAt.toMillis(),
          fatalError: "stale: run did not finish within 1h (crashed or timed out); marked failed by a later run",
          errorCount: (run.errorCount ?? 0) + 1,
          updatedAt: now,
        });
        swept++;
        console.warn(`Scrape run ${d.id} (${run.kind}) was stale, marked failed`);
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

  /** One full run (ISO dates), or null. */
  async getRun(id: string): Promise<ScrapeRunJson | null> {
    const snap = await collections.scrapeRuns.doc(id).get();
    if (!snap.exists) return null;
    return { ...(toJson(snap.data()) as Record<string, unknown>), id: snap.id };
  }

  /** Per-source health for one kind, or both when `kind` is omitted. */
  async listSourceHealth(kind: ScrapeRunKind | undefined, nowMs: number = this.realClock()): Promise<ScrapeSourceHealth[]> {
    const out: ScrapeSourceHealth[] = [];
    if (!kind || kind === "visa") {
      const snap = await collections.visaSources.get();
      for (const d of snap.docs) out.push(visaHealth(d.id, d.data() as VisaSource, nowMs));
    }
    if (!kind || kind === "news") {
      const snap = await collections.newsSources.get();
      for (const d of snap.docs) out.push(newsHealth(d.id, d.data() as NewsSource));
    }
    return out;
  }
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
function visaHealth(id: string, s: VisaSource, nowMs: number): ScrapeSourceHealth {
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
  };
}

/** News source -> health row. */
function newsHealth(id: string, s: NewsSource): ScrapeSourceHealth {
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
  };
}

export const scrapeRunService = new ScrapeRunService();
