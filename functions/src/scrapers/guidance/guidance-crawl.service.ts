import { Timestamp, type Transaction } from "firebase-admin/firestore";
import { collections, db, subcollections } from "../../utils/firebase";
// The ONE fetch path every crawler uses (robots.txt, per-host gap, 429/503
// backoff, PDF reading). The guidance crawl calls it directly: it is not
// forked, wrapped in another HTTP client, or given its own etiquette.
import { HtmlTextTooLongError, visaCatalogFetchService, type FetchedPage } from "../shared/fetch/visa-catalog-fetch.service";
import { DEFAULT_PDF_LIMITS, isPdfFetchError } from "../shared/fetch/pdf-text";
import { describeError } from "../shared/fetch/redact";
import { HostBackoffTracker, backoffMessage, hostOf, isHostBackoffError } from "../shared/etiquette/visa-crawl-host-state";
// Failure streak -> auto-pause rules shared with the visa and news crawlers.
import { DEFAULT_CONSECUTIVE_FAILURE_LIMIT, nextSourceHealth, type NextSourceHealth } from "../shared/runs/source-health";
import { extractPublishedDate } from "./guidance-published-date";
import { GUIDANCE_SOURCE_ID_RE, guidanceSnapshotStore, type GuidanceSnapshotStore } from "./guidance-snapshot.store";
import type { GuidanceSnapshotMeta, GuidanceSource, GuidanceSourceStatus } from "./types";

// ============================================
// GUIDANCE — CRAWL ORCHESTRATOR (issue #39)
// ============================================
//
// Reads the `guidanceSources` registry and, for each source that is due:
//
//   1. fetches it through the shared fetch service (robots.txt checked,
//      per-host gap and 429/503 backoff applied, PDFs read per page);
//   2. compares the sha256 of its cleaned text with the stored
//      `lastContentHash` (the same hash gate the visa crawler uses);
//   3. UNCHANGED -> stamps `lastFetchedAt` and stops: no snapshot, no Storage
//      write, no downstream call;
//      CHANGED   -> stores the text in Cloud Storage under its hash, adds an
//      immutable snapshot doc, records the change on the source, and only
//      then tells the optional `onChanged` listener.
//
// What it never does:
//  - crawl an `unverified` source: those are skipped and REPORTED (a source
//    nobody managed to retrieve by hand must not feed a possibly truncated
//    page into extraction);
//  - throw out of `runOrchestrator` because one source failed: a failure is
//    counted on that source, and after N in a row the source becomes
//    `failing` and is reported;
//  - branch on a jurisdiction, route or publisher: a source is data;
//  - send anything to a model, or log document text. A fetched document is
//    untrusted data; this module only stores and hashes it.
//
// Not here (follow-ups): a scheduled function, run records in `scrapeRuns`
// and per-source crawl leases. Those are typed to the "visa" | "news" scraper
// kinds today; two overlapping guidance runs are still safe (snapshots are
// keyed by hash and created only if absent, and every source write is a
// transaction), they would merely fetch a source twice.

/**
 * Longest cleaned text accepted from a web page, in characters: the same
 * ceiling a PDF has. A longer page FAILS the fetch; guidance text is never
 * sliced (the visa-page cap of 24,000 characters would cut most of a long
 * guidance page off without saying so).
 */
export const GUIDANCE_MAX_HTML_TEXT_CHARS = DEFAULT_PDF_LIMITS.maxTextChars;

/** Longest error message stored on a source doc. */
export const MAX_STORED_ERROR_CHARS = 500;

/** Why a crawl of one source failed (stored as `lastErrorKind`). */
export type GuidanceFailureKind =
  | "http_error" // non-2xx response (404, 410, 500, ...)
  | "content_type_changed" // registry says html, got a PDF (or the reverse)
  | "redirect_changed" // the URL now ends at a different document
  | "robots_blocked" // robots.txt disallows the URL
  | "host_backoff" // the host answered 429/503
  | "pdf_unreadable" // a PDF the reader refused (encrypted, scanned, too big, ...)
  | "text_too_long" // a web page over GUIDANCE_MAX_HTML_TEXT_CHARS
  | "storage_error" // the snapshot text could not be stored
  | "fetch_error"; // anything else (network, timeout, too little content)

/** A crawl failure this module raises itself (the rest come from the fetcher). */
export class GuidanceCrawlError extends Error {
  constructor(readonly kind: GuidanceFailureKind, message: string) {
    super(message);
    this.name = "GuidanceCrawlError";
  }
}

/** What happened to one source in a run. */
export type GuidanceSourceOutcome =
  | "changed" // new content: a snapshot was recorded
  | "unchanged" // same hash: nothing written but the fetch time
  | "failed" // the fetch (or store) failed; counted on the source
  | "deferred" // its host is backing off; not requested
  | "skipped_unverified" // verificationStatus "unverified": never fetched
  | "skipped_inactive" // paused / retired, or failing and not asked for by id
  | "not_due"; // checked recently enough

/** One source's line in the run summary. */
export interface GuidanceSourceResult {
  sourceId: string;
  outcome: GuidanceSourceOutcome;
  // Present for changed / unchanged.
  contentHash?: string;
  // Present for failed / deferred.
  error?: string;
  errorKind?: GuidanceFailureKind;
  // Status after this run (changed / unchanged / failed).
  status?: GuidanceSourceStatus;
}

/** Sent to `onChanged` once a changed source's snapshot is committed. */
export interface GuidanceChangeEvent {
  sourceId: string;
  contentHash: string;
  previousContentHash: string | null;
  storagePath: string;
}

/** Counters and per-source lines for one run. */
export interface GuidanceCrawlSummary {
  sourcesConsidered: number; // registry entries looked at
  sourcesFetched: number; // requests that returned a usable document
  unchanged: number;
  changed: number;
  failed: number;
  deferred: number;
  notDue: number;
  skippedInactive: number;
  // Downstream work actually done: all three stay 0 when nothing changed.
  snapshotsWritten: number; // snapshot docs created in Firestore
  storageObjectsWritten: number; // text objects created in Cloud Storage
  downstreamCalls: number; // onChanged invocations
  // Ids of `unverified` sources that were skipped (the report the issue asks for).
  skippedUnverified: string[];
  // Ids that became `failing` in this run, and ids that are failing after it.
  newlyFailing: string[];
  failing: string[];
  // Non-fatal problems (a listener that threw, an unreadable registry entry).
  warnings: string[];
  results: GuidanceSourceResult[];
}

/** The fetch surface the crawl needs (the shared service satisfies it). */
export interface GuidanceFetcher {
  fetchAndClean(
    url: string,
    options?: { checkRobots?: boolean; acceptPdf?: boolean; maxHtmlTextChars?: number }
  ): Promise<FetchedPage>;
}

/** Options for one run. All optional. */
export interface GuidanceCrawlOptions {
  // The run's tick time (tests). Default: now.
  now?: Timestamp;
  // Crawl only these sources, due or not, and including `failing` ones (an
  // operator retrying a source by hand). `unverified`, `paused` and `retired`
  // sources are still skipped.
  sourceIds?: string[];
  // Consecutive failures at which a source becomes `failing`. Default 5.
  failureLimit?: number;
  // Called once per CHANGED source, after its snapshot is committed. This is
  // the hook the rubric extraction (#40) attaches to. It is never called for
  // an unchanged source. A listener that throws is recorded as a warning.
  onChanged?: (event: GuidanceChangeEvent) => Promise<void> | void;
}

/**
 * Compare two URLs as documents: fragment ignored, a trailing slash on the
 * path ignored, host case-insensitive. Unparseable input compares as text.
 */
export function sameDocumentUrl(a: string, b: string): boolean {
  const norm = (raw: string): string => {
    try {
      const u = new URL(raw);
      u.hash = "";
      u.pathname = u.pathname.replace(/\/+$/, "") || "/";
      return u.toString();
    } catch {
      return raw.trim();
    }
  };
  return norm(a) === norm(b);
}

/** Classify a thrown error into a failure kind. */
export function failureKindOf(err: unknown): GuidanceFailureKind {
  if (err instanceof GuidanceCrawlError) return err.kind;
  if (isHostBackoffError(err)) return "host_backoff";
  if (isPdfFetchError(err)) {
    // "not-accepted" = the registry says web page but the URL served a PDF.
    return err.reason === "not-accepted" ? "content_type_changed" : "pdf_unreadable";
  }
  if (err instanceof HtmlTextTooLongError) return "text_too_long";
  const message = err instanceof Error ? err.message : String(err);
  if (/^Blocked by robots\.txt/.test(message)) return "robots_blocked";
  if (/\(HTTP \d{3}\)/.test(message)) return "http_error";
  return "fetch_error";
}

/** `failing` (this registry) <-> `broken` (the shared health rules' word). */
const toSharedStatus = (s: string | undefined): string | undefined => (s === "failing" ? "broken" : s);
const fromSharedStatus = (s: string): GuidanceSourceStatus => (s === "broken" ? "failing" : (s as GuidanceSourceStatus));

/** A blank summary. */
function emptySummary(): GuidanceCrawlSummary {
  return {
    sourcesConsidered: 0,
    sourcesFetched: 0,
    unchanged: 0,
    changed: 0,
    failed: 0,
    deferred: 0,
    notDue: 0,
    skippedInactive: 0,
    snapshotsWritten: 0,
    storageObjectsWritten: 0,
    downstreamCalls: 0,
    skippedUnverified: [],
    newlyFailing: [],
    failing: [],
    warnings: [],
    results: [],
  };
}

export class GuidanceCrawlService {
  // Transaction runner; a property so tests can swap in an in-memory one.
  runTransaction: <T>(fn: (tx: Transaction) => Promise<T>) => Promise<T> = (fn) => db.runTransaction(fn);

  /**
   * @param fetcher the fetch service (default: the shared singleton, so the
   *   per-host gap and robots cache are shared with the other crawlers
   *   running in the same instance)
   * @param store   where snapshot text goes (default: the project's bucket)
   */
  constructor(
    private readonly injectedFetcher?: GuidanceFetcher,
    private readonly injectedStore?: GuidanceSnapshotStore
  ) {}

  // The defaults are read at CALL time, not in the constructor: this module
  // is loaded through scrapers/index.ts, whose import-cycle rule forbids
  // using another module's binding while modules are still loading.
  /** The fetch service in use. */
  private get fetcher(): GuidanceFetcher {
    return this.injectedFetcher ?? visaCatalogFetchService;
  }
  /** The snapshot text store in use. */
  private get store(): GuidanceSnapshotStore {
    return this.injectedStore ?? guidanceSnapshotStore;
  }

  /**
   * Crawl every due source once. Never throws for a per-source problem; it
   * only rejects when the registry itself cannot be read.
   */
  async runOrchestrator(opts: GuidanceCrawlOptions = {}): Promise<GuidanceCrawlSummary> {
    const now = opts.now ?? Timestamp.now();
    const nowMs = now.toMillis();
    const failureLimit = opts.failureLimit ?? DEFAULT_CONSECUTIVE_FAILURE_LIMIT;
    const summary = emptySummary();
    const explicit = opts.sourceIds ? new Set(opts.sourceIds) : undefined;

    // The registry is small (a handful of documents per route), so it is read
    // whole and filtered here: no composite index, and every skipped source
    // can be reported with its reason.
    const snap = await collections.guidanceSources.get();
    const docs = snap.docs.filter((d) => !explicit || explicit.has(d.id));

    // Hosts that answered 429/503 in THIS run: not requested again in it.
    const hostState = new HostBackoffTracker(nowMs);

    for (const doc of docs) {
      summary.sourcesConsidered++;
      const source = doc.data() as GuidanceSource;
      const sourceId = doc.id;

      // ---- Selection: every "no" is counted, and the first one reported ----

      // A malformed entry (hand-edited doc) is reported, never requested.
      if (!GUIDANCE_SOURCE_ID_RE.test(sourceId) || typeof source.url !== "string" || !source.url) {
        summary.warnings.push(`source ${sourceId}: not a valid registry entry, skipped`);
        summary.skippedInactive++;
        summary.results.push({ sourceId, outcome: "skipped_inactive" });
        continue;
      }
      // Unverified: skipped and reported, whatever else is true of it, and
      // even when asked for by id.
      if (source.verificationStatus === "unverified") {
        summary.skippedUnverified.push(sourceId);
        summary.results.push({ sourceId, outcome: "skipped_unverified" });
        continue;
      }
      // Paused / retired: never crawled. Failing: only when asked for by id.
      const status = source.status ?? "active";
      if (status === "paused" || status === "retired" || (status === "failing" && !explicit)) {
        summary.skippedInactive++;
        if (status === "failing") summary.failing.push(sourceId);
        summary.results.push({ sourceId, outcome: "skipped_inactive", status });
        continue;
      }
      // Due: one attempt per `checkIntervalHours`, counted from the last
      // attempt (successful or not) so a broken source is not retried on
      // every tick. Skipped for an explicit run.
      if (!explicit) {
        const lastMs = Math.max(source.lastFetchedAt?.toMillis() ?? 0, source.lastAttemptAt?.toMillis() ?? 0);
        const intervalMs = Math.max(1, Number(source.checkIntervalHours) || 24) * 60 * 60 * 1000;
        if (lastMs > 0 && nowMs < lastMs + intervalMs) {
          summary.notDue++;
          summary.results.push({ sourceId, outcome: "not_due" });
          continue;
        }
      }
      // Host backing off: a stored `backoffUntil` from an earlier run, or a
      // 429/503 another source on the same host got a moment ago.
      const host = hostOf(source.url);
      const storedBackoffMs = source.backoffUntil?.toMillis() ?? 0;
      const fresh = hostState.blocking(host);
      if (storedBackoffMs > nowMs || fresh) {
        const untilMs = Math.max(storedBackoffMs, fresh?.untilMs ?? 0);
        const error = fresh ? backoffMessage(fresh) : `host backed off, retry after ${new Date(untilMs).toISOString()}`;
        // Remember the fresh backoff on this source too, so the next run
        // waits as well. Not a failure: nothing was requested.
        if (fresh && untilMs > storedBackoffMs) {
          await doc.ref.update({ backoffUntil: Timestamp.fromMillis(untilMs), updatedAt: now });
        }
        summary.deferred++;
        summary.results.push({ sourceId, outcome: "deferred", error, errorKind: "host_backoff" });
        continue;
      }

      // ---- Crawl ----
      try {
        await this.crawlSource(sourceId, source, { now, failureLimit, summary, onChanged: opts.onChanged });
      } catch (err) {
        // A 429/503: stop requesting this host for the rest of the run.
        if (isHostBackoffError(err)) {
          hostState.record(err.toEntry(nowMs));
          // A cross-host redirect: block the host we asked as well.
          if (err.requestedHost !== err.host) hostState.record({ ...err.toEntry(nowMs), host: err.requestedHost });
        }
        await this.recordFailure(sourceId, err, { now, failureLimit, summary });
      }
    }

    console.log(
      `Guidance crawl: ${summary.sourcesConsidered} source(s), ${summary.changed} changed, ` +
        `${summary.unchanged} unchanged, ${summary.failed} failed, ${summary.deferred} deferred, ` +
        `${summary.skippedUnverified.length} unverified skipped`
    );
    if (summary.skippedUnverified.length > 0) {
      console.warn(`Guidance crawl: unverified source(s) not fetched: ${summary.skippedUnverified.join(", ")}`);
    }
    if (summary.failing.length > 0) {
      console.error(`Guidance crawl: failing source(s): ${summary.failing.join(", ")}`);
    }
    return summary;
  }

  /**
   * Fetch one source and record the result. Throws on any failure (the
   * caller counts it); returns normally for changed and unchanged.
   */
  private async crawlSource(
    sourceId: string,
    source: GuidanceSource,
    ctx: {
      now: Timestamp;
      failureLimit: number;
      summary: GuidanceCrawlSummary;
      onChanged?: GuidanceCrawlOptions["onChanged"];
    }
  ): Promise<void> {
    const { now, summary } = ctx;

    // 1. Fetch through the shared path. `acceptPdf: false` for a web-page
    //    source refuses a PDF on its headers, before downloading it.
    const page = await this.fetcher.fetchAndClean(source.url, {
      checkRobots: true,
      acceptPdf: source.docType === "pdf",
      maxHtmlTextChars: GUIDANCE_MAX_HTML_TEXT_CHARS,
    });

    // 2. The document must still be the kind the registry says it is.
    if (source.docType === "pdf" && !page.pdf) {
      throw new GuidanceCrawlError(
        "content_type_changed",
        `Content type changed for ${source.url}: the registry says PDF but the response was not a PDF`
      );
    }

    // 3. It must still be the same document. A redirect in itself is fine
    //    (both URLs are recorded); a redirect to somewhere NEW is not: the
    //    text behind it may be another document entirely, so it is not
    //    ingested until a human re-checks the entry.
    const baseline = source.expectedFinalUrl || source.finalUrl;
    if (baseline && !sameDocumentUrl(baseline, page.finalUrl)) {
      throw new GuidanceCrawlError(
        "redirect_changed",
        `Redirect target changed for ${source.url}: expected ${baseline}, got ${page.finalUrl}`
      );
    }
    summary.sourcesFetched++;

    const sourceRef = collections.guidanceSources.doc(sourceId);
    const fetchedAt = Timestamp.fromMillis(page.fetchedAt);
    // Fields every successful fetch writes: the streak resets, errors clear.
    const success = {
      lastFetchedAt: fetchedAt,
      lastAttemptAt: now,
      finalUrl: page.finalUrl,
      lastError: null,
      lastErrorKind: null,
      lastErrorAt: null,
      backoffUntil: null,
      updatedAt: now,
    };

    // 4. Hash gate. Same hash as last time = nothing downstream to do.
    if (page.contentHash === source.lastContentHash) {
      const health = await this.runTransaction(async (tx) => {
        const fresh = await tx.get(sourceRef);
        if (!fresh.exists) return undefined; // deleted mid-run: nothing to stamp
        const h = this.health(fresh.data() as GuidanceSource, "success", { now, limit: ctx.failureLimit });
        tx.update(sourceRef, { ...success, consecutiveFailures: h.consecutiveFailures, status: fromSharedStatus(h.status), ...(h.autoPause ?? {}) });
        return h;
      });
      summary.unchanged++;
      summary.results.push({
        sourceId,
        outcome: "unchanged",
        contentHash: page.contentHash,
        status: health ? fromSharedStatus(health.status) : undefined,
      });
      return;
    }

    // 5. Changed (or first fetch). Text to Storage first: if the Firestore
    //    write below then fails, the next run finds the object already there
    //    (same hash) and simply completes the record.
    const published = extractPublishedDate(page.cleanText, source.publishedDateSelector);
    let written;
    try {
      written = await this.store.write({
        sourceId,
        docType: source.docType,
        url: source.url,
        finalUrl: page.finalUrl,
        fetchedAtMs: page.fetchedAt,
        text: page.cleanText,
        pages: page.pdf?.pages,
      });
    } catch (err) {
      throw new GuidanceCrawlError("storage_error", `Could not store the snapshot text: ${describeError(err)}`);
    }
    // The store hashes the text itself; it must agree with the fetch service.
    if (written.contentHash !== page.contentHash) {
      throw new GuidanceCrawlError("storage_error", "Snapshot hash does not match the fetched content hash");
    }
    if (written.created) summary.storageObjectsWritten++;

    const previousContentHash = source.lastContentHash ?? null;
    const meta: GuidanceSnapshotMeta = {
      sourceId,
      contentHash: page.contentHash,
      docType: source.docType,
      url: source.url,
      finalUrl: page.finalUrl,
      httpStatus: page.httpStatus,
      fetchedAt,
      publishedDate: published?.publishedDate ?? null,
      publishedDateText: published?.publishedDateText ?? null,
      pageCount: page.pdf ? page.pdf.pageCount : null,
      pagesWithoutText: page.pdf ? page.pdf.pagesWithoutText : [],
      charCount: page.cleanText.length,
      byteLength: written.byteLength,
      sourceByteLength: page.pdf ? page.pdf.byteLength : null,
      storagePath: written.storagePath,
      previousContentHash,
      createdAt: now,
    };

    // 6. Snapshot doc + source update in ONE transaction: the source never
    //    points at a snapshot that does not exist. The snapshot is created
    //    only if absent (content that returns to an earlier version reuses
    //    that version's snapshot untouched).
    const metaRef = subcollections.guidanceSnapshots(sourceId).doc(page.contentHash);
    const committed = await this.runTransaction(async (tx) => {
      const fresh = await tx.get(sourceRef);
      if (!fresh.exists) return undefined; // deleted mid-run
      const existing = await tx.get(metaRef);
      const h = this.health(fresh.data() as GuidanceSource, "success", { now, limit: ctx.failureLimit });
      if (!existing.exists) tx.set(metaRef, meta as unknown as Record<string, unknown>);
      tx.update(sourceRef, {
        ...success,
        lastContentHash: page.contentHash,
        latestSnapshotId: page.contentHash,
        lastChangedAt: now,
        publishedDate: meta.publishedDate,
        publishedDateText: meta.publishedDateText,
        consecutiveFailures: h.consecutiveFailures,
        status: fromSharedStatus(h.status),
        ...(h.autoPause ?? {}),
      });
      return { health: h, snapshotCreated: !existing.exists };
    });
    if (!committed) return;
    if (committed.snapshotCreated) summary.snapshotsWritten++;
    summary.changed++;
    summary.results.push({
      sourceId,
      outcome: "changed",
      contentHash: page.contentHash,
      status: fromSharedStatus(committed.health.status),
    });

    // 7. Tell the listener, now that the snapshot is durable. Its failure
    //    does not undo the snapshot and does not fail the source.
    if (ctx.onChanged) {
      summary.downstreamCalls++;
      try {
        await ctx.onChanged({ sourceId, contentHash: page.contentHash, previousContentHash, storagePath: written.storagePath });
      } catch (err) {
        summary.warnings.push(`source ${sourceId}: change listener failed: ${describeError(err).slice(0, MAX_STORED_ERROR_CHARS)}`);
      }
    }
  }

  /**
   * Count a failed crawl on the source: streak + 1, the error recorded, and
   * `failing` once the streak reaches the limit. Never throws (a source whose
   * failure cannot even be recorded becomes a warning).
   */
  private async recordFailure(
    sourceId: string,
    err: unknown,
    ctx: { now: Timestamp; failureLimit: number; summary: GuidanceCrawlSummary }
  ): Promise<void> {
    const { now, summary } = ctx;
    const errorKind = failureKindOf(err);
    // Redacted and bounded: an error message may echo a URL or a header.
    const error = describeError(err).slice(0, MAX_STORED_ERROR_CHARS);
    summary.failed++;

    let health: NextSourceHealth | undefined;
    try {
      const sourceRef = collections.guidanceSources.doc(sourceId);
      health = await this.runTransaction(async (tx) => {
        const fresh = await tx.get(sourceRef);
        if (!fresh.exists) return undefined;
        const h = this.health(fresh.data() as GuidanceSource, "failure", { now, limit: ctx.failureLimit, errorMessage: error });
        tx.update(sourceRef, {
          lastAttemptAt: now,
          lastError: error,
          lastErrorKind: errorKind,
          lastErrorAt: now,
          consecutiveFailures: h.consecutiveFailures,
          status: fromSharedStatus(h.status),
          // A throttling host: do not ask again before it said we may.
          ...(isHostBackoffError(err) ? { backoffUntil: Timestamp.fromMillis(err.untilMs) } : {}),
          updatedAt: now,
          ...(h.autoPause ?? {}),
        });
        return h;
      });
    } catch (writeErr) {
      summary.warnings.push(`source ${sourceId}: could not record the failure: ${describeError(writeErr).slice(0, MAX_STORED_ERROR_CHARS)}`);
    }

    const status = health ? fromSharedStatus(health.status) : undefined;
    if (status === "failing") summary.failing.push(sourceId);
    if (health?.newlyAutoPaused) {
      summary.newlyFailing.push(sourceId);
      console.error(
        `Guidance crawl: source ${sourceId} is now failing after ${health.consecutiveFailures} consecutive failures ` +
          `(limit ${ctx.failureLimit}): ${error}`
      );
    } else {
      console.warn(`Guidance crawl: source ${sourceId} failed (${errorKind}): ${error}`);
    }
    summary.results.push({ sourceId, outcome: "failed", error, errorKind, status });
  }

  /**
   * The shared health rules (source-health.ts), with this registry's word
   * for an auto-paused source (`failing`) mapped to theirs (`broken`).
   */
  private health(
    stored: GuidanceSource,
    outcome: "success" | "failure",
    ctx: { now: Timestamp; limit: number; errorMessage?: string }
  ): NextSourceHealth {
    return nextSourceHealth(
      {
        status: toSharedStatus(stored.status),
        consecutiveFailures: stored.consecutiveFailures,
        autoPaused: stored.autoPaused,
        autoPausedAt: stored.autoPausedAt,
      },
      outcome,
      ctx
    );
  }
}

/** Singleton over the shared fetch service and the project's bucket. */
export const guidanceCrawlService = new GuidanceCrawlService();
