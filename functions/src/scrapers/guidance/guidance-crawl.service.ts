import { Timestamp, type Transaction } from "firebase-admin/firestore";
import { collections, db, subcollections } from "../../utils/firebase";
// The ONE fetch path every crawler uses (robots.txt, per-host gap, 429/503
// backoff, PDF reading). The guidance crawl calls it directly: it is not
// forked, wrapped in another HTTP client, or given its own etiquette.
import {
  HtmlTextTooLongError,
  visaCatalogFetchService,
  type FetchedPage,
  type RawResponse,
} from "../shared/fetch/visa-catalog-fetch.service";
import { DEFAULT_PDF_LIMITS, isPdfFetchError } from "../shared/fetch/pdf-text";
import { describeError } from "../shared/fetch/redact";
import { HostBackoffTracker, backoffMessage, hostOf, isHostBackoffError } from "../shared/etiquette/visa-crawl-host-state";
// Failure streak -> auto-pause rules shared with the visa and news crawlers.
import {
  DEFAULT_CONSECUTIVE_FAILURE_LIMIT,
  DEFAULT_CONSECUTIVE_INFRA_ERROR_LIMIT,
  DEFAULT_INFRA_BACKOFF_MS,
  nextSourceHealth,
  type NextSourceHealth,
} from "../shared/runs/source-health";
// Issue #143: run records, per-source crawl leases (the same shared modules
// the visa crawler uses; the guidance crawl has no run / lease code of its
// own). They are only USED at call time, never at module load (see the
// import-cycle note on `fetcher` below).
import { scrapeRunService, type ScrapeRunService } from "../shared/runs/scrape-run.service";
import type { ScrapeRunRecorder } from "../shared/runs/scrape-run.service";
import { leaseHeldReason, sourceLeaseService, type SourceLeaseService } from "../shared/runs/source-lease";
import type { ScrapeRunSourceStatus, ScrapeRunTrigger } from "../shared/runs/types";
import { extractPublishedDate, publishedDateSelectorProblem } from "./guidance-published-date";
import { GuidanceResolveError, linkPatternHost, resolveDocumentUrl } from "./guidance-resolve";
import { GUIDANCE_SOURCE_ID_RE, guidanceSnapshotStore, type GuidanceSnapshotStore } from "./guidance-snapshot.store";
import type { GuidanceSnapshotMeta, GuidanceSource, GuidanceSourceStatus } from "./types";

// ============================================
// GUIDANCE — CRAWL ORCHESTRATOR (issue #39)
// ============================================
//
// Reads the `guidanceSources` registry and, for each source that is due:
//
//   0. (only for a source with `resolveFrom`, issue #111) looks up the
//      document's current address on its stable parent page, through the
//      same fetch service, and requests that address in step 1;
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
//  - blame a source for OUR outage: a Cloud Storage or Firestore error is a
//    run-level `infrastructureErrors` line and never moves a failure streak;
//  - branch on a jurisdiction, route or publisher: a source is data;
//  - send anything to a model, or log document text. A fetched document is
//    untrusted data; this module only stores and hashes it.
//
// Scheduling and records (issue #143): `crawlGuidanceOrchestrator`
// (functions/src/index.ts) calls `runOrchestrator()` once a night. A tick with
// no eligible source returns before anything is recorded (no run doc, no
// alert, one log line). Otherwise the run is a `scrapeRuns` doc of kind
// "guidance", and each source is crawled under its own lease
// (`scrapeSourceLeases/guidance__<sourceId>`), so a tick and an admin retry
// never crawl one source at once. Overlap is also safe by construction:
// snapshots are keyed by hash and created only if absent, and every source
// write is a transaction.
//
// Infrastructure errors are capped (issue #143): a source that ends
// `infra_error` on N runs in a row is not requested again until a backoff
// passes or an admin retries it by id. The cap counts on the source doc and
// never touches the failure streak or the status.

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
  | "resolve_failed" // `resolveFrom`: the parent page gave no single address (#111)
  | "robots_blocked" // robots.txt disallows the URL
  | "host_backoff" // the host answered 429/503
  | "pdf_unreadable" // a PDF the reader refused (encrypted, scanned, too big, ...)
  | "text_too_long" // a web page over GUIDANCE_MAX_HTML_TEXT_CHARS
  | "storage_error" // the snapshot text could not be stored (OUR side)
  | "firestore_error" // a registry / snapshot write failed (OUR side)
  | "fetch_error"; // anything else (network, timeout, too little content)

/** The kinds that are our infrastructure's fault, not the source's. */
export type GuidanceInfraErrorKind = Extract<GuidanceFailureKind, "storage_error" | "firestore_error">;

/** A crawl failure this module raises itself (the rest come from the fetcher). */
export class GuidanceCrawlError extends Error {
  constructor(readonly kind: GuidanceFailureKind, message: string) {
    super(message);
    this.name = "GuidanceCrawlError";
  }
}

/**
 * An INFRASTRUCTURE error while handling a source: Cloud Storage or Firestore
 * failed on our side. It says nothing about the source, so it is NOT counted
 * toward the source's failure streak (a Storage outage must not turn every
 * source `failing`); it is recorded on the run (`infrastructureErrors`) and
 * the source is simply tried again on the next run.
 */
export class GuidanceInfraError extends Error {
  constructor(readonly kind: GuidanceInfraErrorKind, message: string) {
    super(message);
    this.name = "GuidanceInfraError";
  }
}

/** What happened to one source in a run. */
export type GuidanceSourceOutcome =
  | "changed" // new content: a snapshot was recorded
  | "unchanged" // same hash: nothing written but the fetch time
  | "failed" // the fetch failed; counted on the source
  | "infra_error" // Storage / Firestore failed on our side; NOT counted on the source
  | "deferred" // its host is backing off; not requested
  | "skipped_unverified" // verificationStatus "unverified": never fetched
  | "skipped_inactive" // paused / retired, or failing and not asked for by id
  | "skipped_infra_backoff" // N infrastructure errors in a row: left alone until the backoff passes (#143)
  | "lease_held" // another run holds this source's crawl lease; not crawled (#143)
  | "not_due"; // checked recently enough

/** One source's line in the run summary. */
export interface GuidanceSourceResult {
  sourceId: string;
  outcome: GuidanceSourceOutcome;
  // Present for changed / unchanged.
  contentHash?: string;
  // Present for failed / deferred / infra_error.
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
  // Sources not completed because Storage / Firestore failed on our side.
  infraErrors: number;
  deferred: number;
  notDue: number;
  skippedInactive: number;
  // Sources left alone because of the infrastructure-error cap (#143).
  skippedInfraBackoff: number;
  // Sources not crawled because another run held their lease (#143).
  leaseHeld: number;
  // Downstream work actually done: all three stay 0 when nothing changed.
  snapshotsWritten: number; // snapshot docs created in Firestore
  storageObjectsWritten: number; // text objects created in Cloud Storage
  downstreamCalls: number; // onChanged invocations
  // Ids of `unverified` sources that were skipped (the report the issue asks for).
  skippedUnverified: string[];
  // Ids that became `failing` in this run, and ids that are failing after it.
  newlyFailing: string[];
  failing: string[];
  // Run-level errors: Storage / Firestore failures, one line each. These
  // never touch a source's failure streak.
  infrastructureErrors: string[];
  // Non-fatal problems (a listener that threw, an unreadable registry entry,
  // an id asked for that is not in the registry).
  warnings: string[];
  results: GuidanceSourceResult[];
}

/** The fetch surface the crawl needs (the shared service satisfies it). */
export interface GuidanceFetcher {
  fetchAndClean(
    url: string,
    options?: { checkRobots?: boolean; acceptPdf?: boolean; maxHtmlTextChars?: number }
  ): Promise<FetchedPage>;
  // Needed only for a source with `resolveFrom` (issue #111): the robots
  // check and the raw GET of the parent page. Optional so a fetcher that
  // serves documents only still satisfies the interface; such a source then
  // fails with `resolve_failed` instead of being requested blind.
  isAllowedByRobots?(url: string): Promise<boolean>;
  getRaw?(url: string): Promise<RawResponse>;
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
  // ---- Issue #143: run records, leases and the infrastructure-error cap ----
  // What started the run (stored on the run doc): "scheduled" for the
  // nightly function, "manual" for the admin retry endpoint, "script" for the
  // CLI (script runs never raise alerts). Default "scheduled".
  trigger?: ScrapeRunTrigger;
  // The run recorder / lease services (tests inject fakes; default: the
  // shared Firestore-backed singletons).
  runs?: ScrapeRunService;
  leases?: SourceLeaseService;
  // Consecutive infrastructure-error runs after which a source is backed off,
  // and for how long (ms). Defaults: the constants in shared/runs/source-health.ts.
  infraErrorLimit?: number;
  infraBackoffMs?: number;
}

/**
 * What a source's registry entry says about this run, BEFORE anything is
 * requested. One function decides it for both the up-front "is anything
 * eligible?" scan and the per-source handling, so the two can never disagree.
 */
type Gate =
  | { verdict: "crawl" }
  | { verdict: "invalid" } // hand-edited / malformed entry
  | { verdict: "unverified" }
  | { verdict: "inactive"; status: string }
  | { verdict: "not_due" }
  | { verdict: "infra_backoff"; untilMs: number };

/** The per-run values `processSource` needs. */
interface SourceRunContext {
  now: Timestamp;
  failureLimit: number;
  summary: GuidanceCrawlSummary;
  // True when the run named its sources (`sourceIds`).
  explicit: boolean;
  hostState: HostBackoffTracker;
  onChanged?: GuidanceCrawlOptions["onChanged"];
  infraErrorLimit: number;
  infraBackoffMs: number;
}

/**
 * Compare two URLs as documents. "Same" means, after parsing both:
 *  - same scheme, same host (case-insensitive) and same port;
 *  - same path, ignoring trailing slashes (`/a/b/` = `/a/b`); the path itself
 *    is case-SENSITIVE, as paths are;
 *  - same query string, character for character (`?v=1` is not `?v=2`);
 *  - the fragment (`#part-2`) is ignored: it never reaches the server.
 * Anything else is a different document: another host (including `www.` vs
 * none), http vs https, another path. Unparseable input compares as text.
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
  if (err instanceof GuidanceCrawlError || err instanceof GuidanceInfraError) return err.kind;
  if (err instanceof GuidanceResolveError) return "resolve_failed";
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

/** Verification statuses the crawl will fetch. Anything else is skipped. */
const CRAWLABLE_VERIFICATION_STATUSES: readonly string[] = ["verified", "partial", "registered"];

/**
 * Epoch ms of a stored Timestamp field, or 0 when it is absent or is not a
 * Timestamp (a hand-edited doc may hold a string or a number there; that
 * must not throw out of the run).
 */
function millisOf(value: unknown): number {
  const ts = value as { toMillis?: unknown } | null | undefined;
  if (ts && typeof ts.toMillis === "function") {
    const ms = Number((ts as { toMillis: () => number }).toMillis());
    return Number.isFinite(ms) ? ms : 0;
  }
  return 0;
}

/** A blank summary. */
function emptySummary(): GuidanceCrawlSummary {
  return {
    sourcesConsidered: 0,
    sourcesFetched: 0,
    unchanged: 0,
    changed: 0,
    failed: 0,
    infraErrors: 0,
    deferred: 0,
    notDue: 0,
    skippedInactive: 0,
    skippedInfraBackoff: 0,
    leaseHeld: 0,
    snapshotsWritten: 0,
    storageObjectsWritten: 0,
    downstreamCalls: 0,
    skippedUnverified: [],
    newlyFailing: [],
    failing: [],
    infrastructureErrors: [],
    warnings: [],
    results: [],
  };
}

/**
 * The summary as stored on the run doc: every counter and id list verbatim
 * (changed, unchanged, failed, infraErrors, deferred, notDue, skippedInactive,
 * snapshotsWritten, storageObjectsWritten, skippedUnverified, newlyFailing,
 * failing, infrastructureErrors, ...), WITHOUT the two bulky free-text
 * members: the per-source `results` become the run's source lines and the
 * `warnings` become the run's warnings (see runOrchestrator).
 */
function storedSummary(summary: GuidanceCrawlSummary): Record<string, unknown> {
  const { results: _results, warnings: _warnings, ...counters } = summary;
  void _results;
  void _warnings;
  return counters;
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
   * only rejects when the registry itself cannot be read (or the run record
   * machinery throws unexpectedly, which fails the run record and rethrows).
   *
   * Issue #143 flow:
   *  1. read the registry and decide, per source, whether it would be
   *     requested (`gate`);
   *  2. NOTHING eligible -> handle the skips (counters only, no network),
   *     log one line and return: no run doc, no alert;
   *  3. otherwise start a `scrapeRuns` doc (kind "guidance"), and crawl each
   *     eligible source under its lease, one at a time. A source whose lease
   *     another run holds is reported `lease_held`, not crawled;
   *  4. finalise the run record; the shared finalize hook then evaluates the
   *     alert rules (it never throws).
   */
  async runOrchestrator(opts: GuidanceCrawlOptions = {}): Promise<GuidanceCrawlSummary> {
    const now = opts.now ?? Timestamp.now();
    const nowMs = now.toMillis();
    const failureLimit = opts.failureLimit ?? DEFAULT_CONSECUTIVE_FAILURE_LIMIT;
    const trigger: ScrapeRunTrigger = opts.trigger ?? "scheduled";
    const summary = emptySummary();
    const explicit = opts.sourceIds ? new Set(opts.sourceIds) : undefined;

    // The registry is small (a handful of documents per route), so it is read
    // whole and filtered here: no composite index, and every skipped source
    // can be reported with its reason.
    const snap = await collections.guidanceSources.get();
    const docs = snap.docs.filter((d) => !explicit || explicit.has(d.id));

    // An id asked for that is not in the registry is a typo or a stale
    // script: say so rather than report a clean run that did nothing.
    if (explicit) {
      const known = new Set(snap.docs.map((d) => d.id));
      for (const id of explicit) {
        if (!known.has(id)) summary.warnings.push(`source ${id}: asked for by id but not in the registry`);
      }
    }

    // Hosts that answered 429/503 in THIS run: not requested again in it.
    const hostState = new HostBackoffTracker(nowMs);
    const ctx: SourceRunContext = {
      now,
      failureLimit,
      summary,
      explicit: !!explicit,
      hostState,
      onChanged: opts.onChanged,
      infraErrorLimit: opts.infraErrorLimit ?? DEFAULT_CONSECUTIVE_INFRA_ERROR_LIMIT,
      infraBackoffMs: opts.infraBackoffMs ?? DEFAULT_INFRA_BACKOFF_MS,
    };

    // ---- 1. Which sources will actually be requested? ----
    // `d.data()` can throw for a hand-edited / corrupt doc; such a doc is
    // never eligible here and is reported by processSafely() below instead.
    const eligible = new Set(
      docs
        .filter((d) => {
          try {
            return this.gate(d.id, (d.data() ?? {}) as GuidanceSource, ctx.explicit, nowMs).verdict === "crawl";
          } catch {
            return false;
          }
        })
        .map((d) => d.id)
    );

    // ---- 2. Nothing eligible: no run doc, no alert (the visa precedent) ----
    // An empty or all-inactive registry, or a tick where every source was
    // crawled recently, ends here. The skips are still counted (no request
    // is made for any of them), so the summary the caller sees is complete.
    if (eligible.size === 0) {
      for (const doc of docs) {
        summary.sourcesConsidered++;
        await this.processSafely(doc, ctx);
      }
      console.log(
        `Guidance crawl: no source is due (${summary.sourcesConsidered} in the registry, ${summary.notDue} not due, ` +
          `${summary.skippedInactive} inactive or failing, ${summary.skippedInfraBackoff} in infrastructure backoff, ` +
          `${summary.skippedUnverified.length} unverified); no run recorded`
      );
      return summary;
    }

    // ---- 3. Start the run record (never throws: a failed write detaches it) ----
    const runs = opts.runs ?? scrapeRunService;
    const leases = opts.leases ?? sourceLeaseService;
    const recorder = await runs.start({
      kind: "guidance",
      trigger,
      startedAtMs: nowMs,
      options: {
        sourcesDue: eligible.size,
        // An admin retry names its source; a nightly tick has no such knob.
        sourceId: explicit && explicit.size === 1 ? [...explicit][0] : undefined,
        byId: explicit ? true : undefined,
      },
    });
    console.log(`Guidance crawl: run ${recorder.id} started (${eligible.size} source(s) eligible, trigger ${trigger})`);

    try {
      for (const doc of docs) {
        summary.sourcesConsidered++;
        // Not eligible: counted, never requested, no lease needed.
        if (!eligible.has(doc.id)) {
          await this.processSafely(doc, ctx);
          continue;
        }
        const title = typeof (doc.data() as Partial<GuidanceSource>)?.title === "string" ? (doc.data() as GuidanceSource).title : doc.id;
        await this.crawlUnderLease(doc, title, ctx, { leases, recorder, trigger });
      }
    } catch (err) {
      // An unexpected throw aborts the run: record it as failed with what was
      // counted so far, then rethrow so the scheduled function logs it.
      await recorder.fail(err, storedSummary(summary));
      throw err;
    }

    console.log(
      `Guidance crawl: ${summary.sourcesConsidered} source(s), ${summary.changed} changed, ` +
        `${summary.unchanged} unchanged, ${summary.failed} failed, ${summary.infraErrors} infrastructure error(s), ` +
        `${summary.deferred} deferred, ${summary.leaseHeld} lease held, ${summary.skippedInfraBackoff} in infrastructure backoff, ` +
        `${summary.skippedUnverified.length} unverified skipped`
    );
    if (summary.skippedUnverified.length > 0) {
      console.warn(`Guidance crawl: unverified source(s) not fetched: ${summary.skippedUnverified.join(", ")}`);
    }
    if (summary.failing.length > 0) {
      console.error(`Guidance crawl: failing source(s): ${summary.failing.join(", ")}`);
    }

    // ---- 4. Finalise the run record ----
    // Warnings (a refused date selector, a listener that threw, ...) are
    // run-level warnings: they never change `errorCount` or the status.
    for (const w of summary.warnings) recorder.recordWarning(w);
    // "Something worked" = at least one document was fetched (the shared
    // derivation: no errors -> succeeded; errors but a fetch -> partial;
    // errors and no fetch -> failed).
    await recorder.finalize({ summary: storedSummary(summary), anySuccess: summary.sourcesFetched > 0 });
    return summary;
  }

  /**
   * Take one source's crawl lease, re-read the doc under it, crawl, record the
   * source on the run, and release the lease (also when the crawl threw).
   */
  private async crawlUnderLease(
    doc: { id: string; data(): unknown; ref: { update(data: Record<string, unknown>): Promise<unknown>; get(): Promise<{ id: string; exists: boolean; data(): unknown; ref: { update(data: Record<string, unknown>): Promise<unknown> } }> } },
    title: string,
    ctx: SourceRunContext,
    deps: { leases: SourceLeaseService; recorder: ScrapeRunRecorder; trigger: ScrapeRunTrigger }
  ): Promise<void> {
    const { summary } = ctx;
    const sourceId = doc.id;
    const before = summary.results.length;

    // A lease that cannot be taken (Firestore error) is OUR failure: reported
    // as an infrastructure error for the source, never against its streak.
    let lease;
    try {
      lease = await deps.leases.acquire("guidance", sourceId, { trigger: deps.trigger, runId: deps.recorder.id });
    } catch (err) {
      const error = this.noteInfraError(summary, sourceId, "firestore_error", `could not take the crawl lease: ${describeError(err)}`);
      summary.infraErrors++;
      summary.results.push({ sourceId, outcome: "infra_error", error, errorKind: "firestore_error" });
      this.recordOnRun(deps.recorder, sourceId, title, summary.results.slice(before));
      return;
    }
    // Another run is crawling it: not an error, just not this run's job.
    if (!lease.ok) {
      summary.leaseHeld++;
      summary.results.push({ sourceId, outcome: "lease_held", error: leaseHeldReason(lease) });
      this.recordOnRun(deps.recorder, sourceId, title, summary.results.slice(before));
      return;
    }

    try {
      // The lease is held: crawl this source. We deliberately use the doc as
      // it was read at the start of the run (carrying its ref, so a test that
      // swaps the ref's update still sees the failure) rather than re-reading
      // it here; the gate was already applied to decide eligibility, and a
      // source another run crawled in the meantime is simply `not_due` on the
      // next tick.
      await this.processSafely(doc, ctx);
    } finally {
      await deps.leases.release(lease);
    }
    this.recordOnRun(deps.recorder, sourceId, title, summary.results.slice(before));
  }

  /**
   * Put one source's result line(s) on the run record: the source line, and
   * one error per failed / infrastructure-error outcome (redacted by the
   * recorder). `deferred` covers every "not requested" outcome.
   */
  private recordOnRun(
    recorder: ScrapeRunRecorder,
    sourceId: string,
    title: string,
    results: GuidanceSourceResult[]
  ): void {
    for (const r of results) {
      const status: ScrapeRunSourceStatus =
        r.outcome === "changed" || r.outcome === "unchanged"
          ? "succeeded"
          : r.outcome === "failed" || r.outcome === "infra_error"
            ? "failed"
            : "deferred";
      const isError = r.outcome === "failed" || r.outcome === "infra_error";
      recorder.recordSource({
        sourceId,
        name: title,
        status,
        pagesAttempted: status === "deferred" ? 0 : 1,
        pagesFetched: status === "succeeded" ? 1 : 0,
        errors: isError ? 1 : 0,
        counts: r.outcome === "changed" ? { changed: 1 } : r.outcome === "unchanged" ? { unchanged: 1 } : undefined,
        error: r.error,
      });
      if (isError) recorder.recordError({ sourceId, error: r.error ?? r.outcome });
    }
  }

  /**
   * `processSource` with the per-source safety net: whatever goes wrong while
   * handling ONE source (a hand-edited doc with a field of the wrong type, a
   * write that fails) becomes a warning line in the summary; the run goes on
   * to the next source.
   */
  private async processSafely(
    doc: { id: string; data(): unknown; ref: { update(data: Record<string, unknown>): Promise<unknown> } },
    ctx: SourceRunContext
  ): Promise<void> {
    try {
      await this.processSource(doc, ctx);
    } catch (err) {
      ctx.summary.warnings.push(`source ${doc.id}: skipped after an unexpected error: ${describeError(err).slice(0, MAX_STORED_ERROR_CHARS)}`);
    }
  }

  /**
   * The registry entry's verdict for this run (see Gate). Pure: no writes, no
   * requests. Order matters and is the order the crawl has always applied:
   * well-formed, verified, status, due, then the infrastructure-error cap.
   */
  private gate(sourceId: string, source: GuidanceSource, explicit: boolean, nowMs: number): Gate {
    // A malformed entry (hand-edited doc) is reported, never requested.
    if (!GUIDANCE_SOURCE_ID_RE.test(sourceId) || typeof source.url !== "string" || !source.url) return { verdict: "invalid" };
    // Verification: ONLY a source marked exactly `verified` or `partial` is
    // fetched. `unverified` is skipped and reported, and so is anything else
    // (a missing or misspelt value). This holds even when asked for by id.
    if (!CRAWLABLE_VERIFICATION_STATUSES.includes(source.verificationStatus as string)) return { verdict: "unverified" };
    // Paused / retired: never crawled. Failing: only when asked for by id.
    const status = source.status ?? "active";
    if (status === "paused" || status === "retired" || (status === "failing" && !explicit)) return { verdict: "inactive", status };
    if (!explicit) {
      // Due: one attempt per `checkIntervalHours`, counted from the last
      // attempt (successful or not) so a broken source is not retried on
      // every tick. Skipped for an explicit run. Both stamps are written
      // from the RUN's clock (`now`), the same clock compared against here.
      const lastMs = Math.max(millisOf(source.lastFetchedAt), millisOf(source.lastAttemptAt));
      const intervalMs = Math.max(1, Number(source.checkIntervalHours) || 24) * 60 * 60 * 1000;
      if (lastMs > 0 && nowMs < lastMs + intervalMs) return { verdict: "not_due" };
      // Infrastructure-error cap (#143): left alone until the backoff passes.
      // An explicit run (an admin retrying by id) ignores it.
      const infraUntilMs = millisOf(source.infraBackoffUntil);
      if (infraUntilMs > nowMs) return { verdict: "infra_backoff", untilMs: infraUntilMs };
    }
    return { verdict: "crawl" };
  }

  /**
   * Decide whether one registry entry is crawled in this run and, if so,
   * crawl it and record the outcome. Every "no" is counted and reported.
   */
  private async processSource(
    doc: { id: string; data(): unknown; ref: { update(data: Record<string, unknown>): Promise<unknown> } },
    ctx: SourceRunContext
  ): Promise<void> {
    const { now, failureLimit, summary, explicit, hostState } = ctx;
    const nowMs = now.toMillis();
    const source = (doc.data() ?? {}) as GuidanceSource;
    const sourceId = doc.id;

    // The gate (see `gate`) decides whether the source is requested at all;
    // every "no" is counted and reported here.
    const verdict = this.gate(sourceId, source, explicit, nowMs);
    switch (verdict.verdict) {
    case "invalid":
      summary.warnings.push(`source ${sourceId}: not a valid registry entry, skipped`);
      summary.skippedInactive++;
      summary.results.push({ sourceId, outcome: "skipped_inactive" });
      return;
    case "unverified":
      // An unknown value is reported: the admin list shows such an entry
      // as "unverified", and the crawl must not treat it as better.
      if (source.verificationStatus !== "unverified") {
        summary.warnings.push(
          `source ${sourceId}: verificationStatus ${JSON.stringify(source.verificationStatus ?? null)} is not a known value, treated as unverified`
        );
      }
      summary.skippedUnverified.push(sourceId);
      summary.results.push({ sourceId, outcome: "skipped_unverified" });
      return;
    case "inactive":
      summary.skippedInactive++;
      if (verdict.status === "failing") summary.failing.push(sourceId);
      summary.results.push({ sourceId, outcome: "skipped_inactive", status: verdict.status as GuidanceSourceStatus });
      return;
    case "not_due":
      summary.notDue++;
      summary.results.push({ sourceId, outcome: "not_due" });
      return;
    case "infra_backoff": {
      // N runs in a row ended in an infrastructure error: not requested
      // until the backoff passes (or an admin retries it by id). The source
      // stays `active` with its failure streak untouched.
      const streak = typeof source.consecutiveInfraErrors === "number" ? source.consecutiveInfraErrors : 0;
      const error = `infrastructure backoff: ${streak} consecutive run(s) ended in an infrastructure error; not requested until ${new Date(verdict.untilMs).toISOString()} (an admin retry by id ignores this)`;
      summary.skippedInfraBackoff++;
      summary.results.push({ sourceId, outcome: "skipped_infra_backoff", error, status: (source.status ?? "active") as GuidanceSourceStatus });
      return;
    }
    case "crawl":
      break;
    }
    // Host backing off: a stored `backoffUntil` from an earlier run, or a
    // 429/503 another source on the same host got a moment ago.
    // A source with `resolveFrom` asks TWO hosts: the parent page's, and the
    // one its link pattern is pinned to (where the document will be
    // requested). A fresh backoff on any host it would ask defers it. The
    // seed validator makes `url` and the pattern name the same host, but a
    // stored doc may have been edited by hand, so all three are checked.
    const storedBackoffMs = millisOf(source.backoffUntil);
    const hosts = [hostOf(source.url)];
    if (typeof source.resolveFrom?.pageUrl === "string") hosts.push(hostOf(source.resolveFrom.pageUrl));
    if (typeof source.resolveFrom?.linkPattern === "string") hosts.push(linkPatternHost(source.resolveFrom.linkPattern) ?? "");
    let fresh: ReturnType<HostBackoffTracker["blocking"]>;
    for (const h of hosts) {
      if (h && !fresh) fresh = hostState.blocking(h);
    }
    if (storedBackoffMs > nowMs || fresh) {
      const untilMs = Math.max(storedBackoffMs, fresh?.untilMs ?? 0);
      const error = fresh ? backoffMessage(fresh) : `host backed off, retry after ${new Date(untilMs).toISOString()}`;
      // Remember the fresh backoff on this source too, so the next run
      // waits as well. Not a failure: nothing was requested. If the write
      // fails the source is still deferred for this run; only the reminder
      // for the next run is lost, which is reported.
      if (fresh && untilMs > storedBackoffMs) {
        try {
          await doc.ref.update({ backoffUntil: Timestamp.fromMillis(untilMs), updatedAt: now });
        } catch (err) {
          this.noteInfraError(summary, sourceId, "firestore_error", `could not store the host backoff: ${describeError(err)}`);
        }
      }
      summary.deferred++;
      summary.results.push({ sourceId, outcome: "deferred", error, errorKind: "host_backoff" });
      return;
    }

    // ---- Crawl ----
    try {
      await this.crawlSource(sourceId, source, { now, failureLimit, summary, onChanged: ctx.onChanged });
    } catch (err) {
      // Our own infrastructure failed: a run-level error, not the source's
      // fault. The failure streak and status are left exactly as they were
      // (and no attempt stamp is written), so the next run tries it again,
      // UNLESS the infrastructure-error cap engages (issue #143): the source
      // doc keeps its own infra counter, and after N runs in a row it is
      // backed off (see recordInfraError).
      if (err instanceof GuidanceInfraError) {
        const error = this.noteInfraError(summary, sourceId, err.kind, err.message);
        summary.infraErrors++;
        summary.results.push({ sourceId, outcome: "infra_error", error, errorKind: err.kind });
        await this.recordInfraError(sourceId, error, ctx);
        return;
      }
      // A 429/503: stop requesting this host for the rest of the run.
      if (isHostBackoffError(err)) {
        hostState.record(err.toEntry(nowMs));
        // A cross-host redirect: block the host we asked as well.
        if (err.requestedHost !== err.host) hostState.record({ ...err.toEntry(nowMs), host: err.requestedHost });
      }
      await this.recordFailure(sourceId, err, { now, failureLimit, summary });
    }
  }

  /**
   * Count an infrastructure error on the SOURCE doc (issue #143):
   * `consecutiveInfraErrors` + 1, the (redacted, capped) error and its time
   * for the admin list, and once the streak reaches the cap
   * `infraBackoffUntil` = now + the backoff. It never touches
   * `consecutiveFailures`, `status` or the auto-pause flags: an outage on our
   * side must not turn a source `failing`.
   *
   * Best effort: if this write fails too (Firestore is the outage) the run
   * says so as one more infrastructure-error line, and the source is simply
   * tried again next run. Never throws.
   */
  private async recordInfraError(sourceId: string, error: string, ctx: SourceRunContext): Promise<void> {
    const { now, summary } = ctx;
    try {
      const sourceRef = collections.guidanceSources.doc(sourceId);
      const result = await this.runTransaction(async (tx) => {
        const fresh = await tx.get(sourceRef);
        if (!fresh.exists) return undefined; // deleted mid-run
        const stored = fresh.data() as GuidanceSource;
        const streak = (typeof stored.consecutiveInfraErrors === "number" ? stored.consecutiveInfraErrors : 0) + 1;
        const capped = streak >= ctx.infraErrorLimit;
        const untilMs = now.toMillis() + ctx.infraBackoffMs;
        tx.update(sourceRef, {
          consecutiveInfraErrors: streak,
          lastInfrastructureError: error.slice(0, MAX_STORED_ERROR_CHARS),
          lastInfrastructureErrorAt: now,
          // Set only when the cap engages; below it the field is left alone.
          ...(capped ? { infraBackoffUntil: Timestamp.fromMillis(untilMs) } : {}),
          updatedAt: now,
        });
        return { streak, capped, untilMs };
      });
      if (result?.capped) {
        summary.warnings.push(
          `source ${sourceId}: ${result.streak} consecutive infrastructure errors; not requested again until ${new Date(result.untilMs).toISOString()} ` +
            "(an admin retry by id ignores this)"
        );
      }
    } catch (writeErr) {
      // Best effort only: the primary infrastructure error is already
      // reported on the run, so a failure to *record* it on the source doc
      // (most likely the same outage) must not inflate the run's counters.
      console.error(`Guidance crawl: could not record the infrastructure error on source ${sourceId}: ${describeError(writeErr)}`);
    }
  }

  /**
   * Record a run-level infrastructure error (and log it). Returns the
   * bounded, redacted message that was recorded.
   */
  private noteInfraError(summary: GuidanceCrawlSummary, sourceId: string, kind: GuidanceInfraErrorKind, message: string): string {
    const error = message.slice(0, MAX_STORED_ERROR_CHARS);
    summary.infrastructureErrors.push(`source ${sourceId}: ${kind}: ${error}`);
    console.error(`Guidance crawl: infrastructure error on source ${sourceId} (${kind}): ${error}`);
    return error;
  }

  /**
   * Run a Firestore transaction; a failure becomes a GuidanceInfraError so it
   * is reported on the run and never counted against the source.
   */
  private async inTransaction<T>(what: string, fn: (tx: Transaction) => Promise<T>): Promise<T> {
    try {
      return await this.runTransaction(fn);
    } catch (err) {
      throw new GuidanceInfraError("firestore_error", `Could not ${what}: ${describeError(err)}`);
    }
  }

  /**
   * Fetch one source and record the result. Throws on any failure: a
   * GuidanceInfraError when Storage / Firestore failed on our side, anything
   * else when the SOURCE failed (the caller counts only the latter on the
   * source). Returns normally for changed and unchanged.
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

    // 0. Which address to request. Normally the entry's `url`. For a source
    //    with `resolveFrom` (issue #111) the document moves to a new address
    //    with every publication, so the current one is read from its stable
    //    parent page first (robots.txt and the per-host delay apply to that
    //    request too). The parent page must still BE the parent page: if it
    //    redirects elsewhere, the lookup is not trusted.
    let requestUrl = source.url;
    const resolveFrom = source.resolveFrom ?? null;
    if (resolveFrom) {
      const fetcher = this.fetcher;
      if (typeof fetcher.isAllowedByRobots !== "function" || typeof fetcher.getRaw !== "function") {
        throw new GuidanceResolveError("This fetcher cannot read a parent page, so the document's address cannot be resolved");
      }
      const resolved = await resolveDocumentUrl(
        { isAllowedByRobots: (u) => fetcher.isAllowedByRobots!(u), getRaw: (u) => fetcher.getRaw!(u) },
        resolveFrom
      );
      if (!sameDocumentUrl(resolveFrom.pageUrl, resolved.pageFinalUrl)) {
        throw new GuidanceCrawlError(
          "redirect_changed",
          `Unexpected redirect for the parent page ${resolveFrom.pageUrl}: got ${resolved.pageFinalUrl}; the document's address was not read from it`
        );
      }
      requestUrl = resolved.resolvedUrl;
    }

    // 1. Fetch through the shared path. `acceptPdf: false` for a web-page
    //    source refuses a PDF on its headers, before downloading it.
    const page = await this.fetcher.fetchAndClean(requestUrl, {
      checkRobots: true,
      acceptPdf: source.docType === "pdf",
      maxHtmlTextChars: GUIDANCE_MAX_HTML_TEXT_CHARS,
    });

    // 2. The document must still be the kind the registry says it is.
    if (source.docType === "pdf" && !page.pdf) {
      throw new GuidanceCrawlError(
        "content_type_changed",
        `Content type changed for ${requestUrl}: the registry says PDF but the response was not a PDF`
      );
    }

    // 3. It must be the document the registry names. The request has to
    //    end at a KNOWN address, from the very first fetch (no trust on
    //    first use: otherwise whatever a URL happened to redirect to on day
    //    one would be snapshotted and become the trusted baseline):
    //      - the seed's `expectedFinalUrl`, for a source known to redirect;
    //      - else the final URL of the last good fetch;
    //      - else (first fetch, or after a re-seed changed `url`) the
    //        requested `url` itself.
    //    For a source with `resolveFrom` the known address is the one just
    //    read from the parent page (the previous fetch's final URL belongs to
    //    the previous publication, and the seed validator forbids
    //    `expectedFinalUrl` there): the request must end where it was sent.
    //    A redirect anywhere else fails with `redirect_changed` and nothing
    //    is ingested until a human re-checks the entry and declares the
    //    target. Both URLs are always recorded. See sameDocumentUrl() for
    //    what counts as the same address.
    const baseline = resolveFrom ? requestUrl : source.expectedFinalUrl || source.finalUrl || source.url;
    if (!sameDocumentUrl(baseline, page.finalUrl)) {
      throw new GuidanceCrawlError(
        "redirect_changed",
        `Unexpected redirect for ${requestUrl}: expected to end at ${baseline}, got ${page.finalUrl}` +
          (source.expectedFinalUrl || resolveFrom ? "" : " (declare expectedFinalUrl in the seed if this redirect is intended)")
      );
    }
    summary.sourcesFetched++;

    const sourceRef = collections.guidanceSources.doc(sourceId);
    // Fields every successful fetch writes: the streak resets, errors clear.
    // ONE clock: `lastFetchedAt` and `lastAttemptAt` are both the run's
    // `now`, the value the due check compares against. The fetch service's
    // own wall-clock reading (`page.fetchedAt`) is kept only on the snapshot
    // (metadata and stored object), as the record of when the bytes arrived.
    const success = {
      lastFetchedAt: now,
      lastAttemptAt: now,
      finalUrl: page.finalUrl,
      // The address read from the parent page (issue #111); null for a
      // source requested directly. Written on unchanged fetches too: the
      // same text can come back under a new address.
      resolvedUrl: resolveFrom ? requestUrl : null,
      lastError: null,
      lastErrorKind: null,
      lastErrorAt: null,
      backoffUntil: null,
      // Issue #143: a successful crawl (including an admin retry) clears the
      // infrastructure-error counter, backoff and last error: the source is
      // healthy and requested normally again.
      consecutiveInfraErrors: 0,
      infraBackoffUntil: null,
      lastInfrastructureError: null,
      lastInfrastructureErrorAt: null,
      updatedAt: now,
    };

    // 4. Hash gate. Same hash as last time = nothing downstream to do.
    if (page.contentHash === source.lastContentHash) {
      const health = await this.inTransaction("stamp the fetch on the source", async (tx) => {
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
    // A selector the validator refuses (a pattern that could backtrack badly)
    // is never run; extractPublishedDate then returns null. Say so in the run
    // record's warnings instead of leaving `publishedDate` null silently
    // (issue #143).
    if (source.publishedDateSelector) {
      const selectorProblem = publishedDateSelectorProblem(source.publishedDateSelector);
      if (selectorProblem) {
        summary.warnings.push(`source ${sourceId}: publishedDateSelector refused at crawl time, publishedDate left empty: ${selectorProblem}`.slice(0, MAX_STORED_ERROR_CHARS));
      }
    }
    const published = extractPublishedDate(page.cleanText, source.publishedDateSelector);
    let written;
    try {
      written = await this.store.write({
        sourceId,
        docType: source.docType,
        // What was REQUESTED: the resolved address for a `resolveFrom` source.
        url: requestUrl,
        finalUrl: page.finalUrl,
        fetchedAtMs: page.fetchedAt,
        text: page.cleanText,
        pages: page.pdf?.pages,
      });
    } catch (err) {
      throw new GuidanceInfraError("storage_error", `Could not store the snapshot text: ${describeError(err)}`);
    }
    // The store hashes the text itself; it must agree with the fetch service.
    if (written.contentHash !== page.contentHash) {
      throw new GuidanceInfraError("storage_error", "Snapshot hash does not match the fetched content hash");
    }
    if (written.created) summary.storageObjectsWritten++;

    const previousContentHash = source.lastContentHash ?? null;
    const meta: GuidanceSnapshotMeta = {
      sourceId,
      contentHash: page.contentHash,
      docType: source.docType,
      // The address requested (see step 0), and the parent page it was read
      // from when there was one.
      url: requestUrl,
      finalUrl: page.finalUrl,
      resolvedFromUrl: resolveFrom ? resolveFrom.pageUrl : null,
      httpStatus: page.httpStatus,
      // When the bytes arrived, by the fetch service's clock (see above).
      fetchedAt: Timestamp.fromMillis(page.fetchedAt),
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
    //    points at a snapshot that does not exist.
    //
    //    REVERTED CONTENT: a snapshot is created only if absent. When a
    //    document goes A -> B -> A, the third fetch hashes to A again, whose
    //    snapshot (doc and Storage object) already exists: it is REUSED
    //    untouched, with its original `fetchedAt` and `previousContentHash`.
    //    The move back is still recorded on the source (`lastContentHash`,
    //    `latestSnapshotId` -> A, `lastChangedAt` -> now) and the listener
    //    is still told (previousContentHash = B). So there is one snapshot
    //    per distinct text, not one per change.
    const metaRef = subcollections.guidanceSnapshots(sourceId).doc(page.contentHash);
    const committed = await this.inTransaction("record the snapshot", async (tx) => {
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
   * `failing` once the streak reaches the limit. Never throws (a failure
   * that cannot even be recorded becomes a run-level infrastructure error).
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
      this.noteInfraError(summary, sourceId, "firestore_error", `could not record the failure: ${describeError(writeErr)}`);
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
