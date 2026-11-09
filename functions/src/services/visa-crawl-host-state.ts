// ============================================
// VISA CATALOG — HOST BACKOFF STATE (issue #64)
// ============================================
//
// Crawler etiquette: when a host answers 429 (Too Many Requests) or 503
// (Service Unavailable) we BACK OFF from it:
//
//   1. honour its `Retry-After` header (delta-seconds or an HTTP-date),
//      clamped to MAX_BACKOFF_MS; a missing/garbage header gets
//      DEFAULT_BACKOFF_MS;
//   2. stop requesting that host for the REST OF THE RUN (remaining pages on
//      it are skipped with a clear `lastError`, no request is sent);
//   3. remember the retry-after time so the NEXT scheduled run does not hit
//      the host before it (persisted by the orchestrator on the source doc as
//      `hostBackoffs`).
//
// This module is deliberately small, PURE (no Firebase import, times in epoch
// ms) and isolated, so issue #15 (Firestore-backed per-host state shared by
// every source/run) can swap the storage without touching the crawl logic:
// today the entries are loaded from / saved to `visaSources/{cc}.hostBackoffs`;
// later they can come from a `hostState/{host}` doc instead — the
// `HostBackoffTracker` API (load entries, record a backoff, ask "is this host
// blocked?", export entries to persist) stays the same.
//
// We NEVER rotate IPs or use proxies to get around a block — see the policy
// comment in visa-catalog-fetch.service.ts.

/** HTTP statuses that mean "slow down / come back later" for this host. */
export const BACKOFF_STATUSES: readonly number[] = [429, 503];

/** Backoff applied when a 429/503 has no usable `Retry-After` header: 1 hour. */
export const DEFAULT_BACKOFF_MS = 60 * 60 * 1000;

/**
 * Upper bound on any backoff: 30 days. Guards against absurd values (a
 * `Retry-After` of a billion seconds, a date in 2099) parking a source
 * forever. A host that keeps asking for longer is a conversation with the
 * site owner, not something to encode here.
 */
export const MAX_BACKOFF_MS = 30 * 24 * 60 * 60 * 1000;

/** True when `status` is one we back off on (429 / 503). */
export function isBackoffStatus(status: number): boolean {
  return BACKOFF_STATUSES.includes(status);
}

/** Host of a URL, lowercased ("" if unparseable). Same rule as the fetch service. */
export function hostOf(url: string): string {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return "";
  }
}

/**
 * Parse a `Retry-After` header value into a delay in ms from `nowMs`.
 *
 *  - delta-seconds ("120")          -> 120_000
 *  - HTTP-date ("Wed, 21 Oct 2026 07:28:00 GMT") -> date - now (a date in the
 *    past -> 0: "retry now", we still stop for the rest of this run)
 *  - missing / empty / garbage ("soon", "-5", "1.5") -> undefined, so the
 *    caller applies DEFAULT_BACKOFF_MS
 *
 * The result is clamped to [0, MAX_BACKOFF_MS]. Accepts `unknown` because
 * headers arrive untyped (axios may give a string or a string[]).
 */
export function parseRetryAfter(value: unknown, nowMs: number): number | undefined {
  // Some clients hand repeated headers as an array; take the first.
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== "string" && typeof raw !== "number") return undefined;
  const text = String(raw).trim();
  if (!text) return undefined;

  // delta-seconds: a non-negative integer only (RFC 9110 §10.2.3). Anything
  // with a sign or decimal point is not valid delta-seconds -> garbage.
  if (/^\d+$/.test(text)) {
    return clampDelay(Number(text) * 1000);
  }

  // HTTP-date. A purely numeric-looking string was handled above, so here we
  // require at least one letter (day/month names) before trusting Date.parse,
  // which otherwise accepts odd inputs like "1-2".
  if (/[a-z]/i.test(text)) {
    const at = Date.parse(text);
    if (!Number.isNaN(at)) return clampDelay(at - nowMs);
  }
  return undefined;
}

/** Clamp a delay to [0, MAX_BACKOFF_MS]. */
function clampDelay(ms: number): number {
  if (!Number.isFinite(ms)) return MAX_BACKOFF_MS;
  return Math.min(Math.max(ms, 0), MAX_BACKOFF_MS);
}

/**
 * The delay to apply for a 429/503: the parsed `Retry-After`, or
 * DEFAULT_BACKOFF_MS when the header is missing or unusable.
 */
export function backoffDelayMs(retryAfter: unknown, nowMs: number): number {
  return parseRetryAfter(retryAfter, nowMs) ?? DEFAULT_BACKOFF_MS;
}

/**
 * One host's backoff, in plain epoch ms (storage-agnostic). The orchestrator
 * maps it to/from Firestore Timestamps on the source doc.
 */
export interface HostBackoffEntry {
  host: string; // lowercased host, e.g. "www.gov.uk"
  untilMs: number; // do not request this host before this instant
  status: number; // the status that triggered it (429 | 503)
  recordedAtMs: number; // when we recorded it
}

/** The `lastError` text for a page that hit, or was skipped by, a backoff. */
export function backoffMessage(entry: Pick<HostBackoffEntry, "status" | "untilMs">): string {
  return `host backed off (${entry.status}), retry after ${new Date(entry.untilMs).toISOString()}`;
}

/**
 * Thrown by the fetch service when a host answers 429/503. Carries the host,
 * status and the computed retry-after instant, so the orchestrator can stop
 * requesting the host and persist the backoff. Adapters let it propagate (they
 * never catch errors), so it reaches the crawl's per-page catch unchanged.
 */
export class HostBackoffError extends Error {
  // The host that ANSWERED 429/503: the final host after redirects when the
  // HTTP client reports it, else the requested host.
  readonly host: string;
  // The host we sent the request to (same as `host` unless a cross-host
  // redirect happened). Callers record both — see the orchestrator.
  readonly requestedHost: string;
  readonly status: number;
  readonly untilMs: number;

  constructor(params: { host: string; status: number; untilMs: number; requestedHost?: string }) {
    super(backoffMessage(params));
    this.name = "HostBackoffError";
    this.host = params.host;
    this.requestedHost = params.requestedHost ?? params.host;
    this.status = params.status;
    this.untilMs = params.untilMs;
  }

  /** This error as a storable entry, stamped at `recordedAtMs`. */
  toEntry(recordedAtMs: number): HostBackoffEntry {
    return { host: this.host, untilMs: this.untilMs, status: this.status, recordedAtMs };
  }
}

/** Type guard (instanceof, plus a name check in case of duplicate module copies). */
export function isHostBackoffError(err: unknown): err is HostBackoffError {
  return (
    err instanceof HostBackoffError ||
    (err instanceof Error && err.name === "HostBackoffError" && "untilMs" in err && "host" in err)
  );
}

/**
 * Per-run host backoff state. One instance per crawl run (orchestrator tick
 * or manual script run), shared by every source processed in it.
 *
 * Two kinds of entries:
 *  - STORED (loaded from a previous run): block the host only while
 *    `untilMs > now`; once expired the host may be crawled again.
 *  - FRESH (a 429/503 seen in THIS run): block the host for the rest of the
 *    run REGARDLESS of `untilMs` — even `Retry-After: 0` means we stop for
 *    this run (we only ever retry on a later scheduled run).
 */
export class HostBackoffTracker {
  // host -> the entry blocking it (the later `untilMs` wins on merge).
  private readonly entries = new Map<string, HostBackoffEntry>();
  // Hosts that answered 429/503 during this run.
  private readonly freshHosts = new Set<string>();

  /** @param nowMs the run's tick time (stored entries are compared to it). */
  constructor(private readonly nowMs: number) {}

  /** Merge an entry, keeping the later `untilMs` for the host. */
  private merge(entry: HostBackoffEntry): void {
    const host = entry.host.toLowerCase();
    const cur = this.entries.get(host);
    if (!cur || entry.untilMs > cur.untilMs) this.entries.set(host, { ...entry, host });
  }

  /** Load stored entries (e.g. a source doc's `hostBackoffs`). Expired ones are ignored. */
  load(entries: readonly HostBackoffEntry[] | undefined): void {
    for (const e of entries ?? []) {
      if (e && typeof e.host === "string" && e.host && e.untilMs > this.nowMs) this.merge(e);
    }
  }

  /** Record a 429/503 seen in this run: the host is blocked for the rest of it. */
  record(entry: HostBackoffEntry): void {
    this.freshHosts.add(entry.host.toLowerCase());
    this.merge(entry);
  }

  /**
   * The entry blocking `host` right now, or undefined if it may be requested.
   * Fresh (this-run) entries always block; stored ones only until `untilMs`.
   */
  blocking(host: string): HostBackoffEntry | undefined {
    const key = host.toLowerCase();
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (this.freshHosts.has(key) || entry.untilMs > this.nowMs) return entry;
    return undefined;
  }

  /** True if `host` answered 429/503 during this run. */
  isFresh(host: string): boolean {
    return this.freshHosts.has(host.toLowerCase());
  }

  /**
   * Entries worth persisting for the given hosts (a source's page hosts):
   * only those still in the future (an expired / `Retry-After: 0` entry has
   * nothing left to defer). Sorted by host for stable writes.
   */
  entriesFor(hosts: Iterable<string>): HostBackoffEntry[] {
    const out: HostBackoffEntry[] = [];
    for (const h of new Set([...hosts].map((x) => x.toLowerCase()))) {
      const e = this.entries.get(h);
      if (e && e.untilMs > this.nowMs) out.push({ ...e });
    }
    return out.sort((a, b) => a.host.localeCompare(b.host));
  }
}
