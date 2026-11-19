import { Timestamp, type Transaction } from "firebase-admin/firestore";
import { collections, db } from "../../../utils/firebase";
import { toJson } from "../runs/scrape-run.service";
import type { ScraperSettingsKind } from "../runs/types";
import { loadScraperSettingsResult, type LoadedScraperSettings } from "./scraper-settings.store";
// Issue #96 review: a source run is refused while another run holds the
// source's crawl lease (scheduled tick, whole-scraper run, ...).
import { sourceLeaseService } from "../runs/source-lease";
import type { ScrapeRunLockDoc, ScrapeRunRequestDoc, ScrapeRunRequestScope } from "./types";

// ============================================
// MANUAL "RUN NOW" — request creation (issue #96)
// ============================================
//
// POST /admin/scrape-sources/:kind/:id/run and POST /admin/scrapers/:kind/run
// do NOT crawl in the API request (a crawl takes minutes; the API function
// has the default timeout). They write a `scrapeRunRequests/{id}` doc and
// return at once; the Firestore onCreate function `processScrapeRunRequest`
// (scrape-run-worker.ts) runs the crawl.
//
// One in flight per scope + cooldown, enforced in ONE transaction on the
// scope's lock doc `scrapeRunLocks/{kind}__{sourceId | _all}`:
//   1. a queued / running request younger than STALE_REQUEST_MS -> 409
//      RUN_IN_PROGRESS (an older one died with its function: ignored);
//   2. the last request less than `manualRuns.cooldownMinutes` ago -> 409
//      RUN_COOLDOWN with retryAfter;
//   3. scope "source" only (review): the source's crawl lease is held by
//      another run (a scheduled tick, a whole-scraper run crawling it) or a
//      whole-scraper request of the same kind is in flight -> 409
//      RUN_IN_PROGRESS (with runId / requestId when known);
//   4. else the request is created `queued` and the lock points at it.
// A queued / running request found past its deadline (STALE_REQUEST_MS
// after it was requested / started) is marked `failed` ("timed out") on the
// way, here, on GET, and by the worker's sweep (review item 2).
// The worker clears `activeRequestId` when it finishes. A lock doc (not a
// query for "active requests of this source") because a transaction can
// lock one doc, even a missing one, but not "no doc matches this query".

/** Requests are TTL-deleted this many days after requestedAt (`expireAt`). */
export const RUN_REQUEST_RETENTION_DAYS = 30;

/**
 * A queued / running request older than this is treated as dead (its
 * function timed out or crashed without finishing): 540s timeout + margin.
 */
export const STALE_REQUEST_MS = 15 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Why a request was refused (the controller maps each to a 4xx). */
export type RunRequestRefusal =
  | "NOT_FOUND"
  | "SOURCE_NOT_ACTIVE"
  | "SCRAPER_DISABLED"
  | "RUN_IN_PROGRESS"
  | "RUN_COOLDOWN"
  // The settings doc could not be read: refuse (fail closed) rather than
  // guess whether the scraper is switched off. -> 503.
  | "SETTINGS_UNAVAILABLE";

/** The error stored on a request that passed its deadline. */
export const TIMED_OUT_ERROR = "timed out: the run did not finish within its deadline (function timeout or crash)";

/**
 * When a queued / running request is past its deadline: STALE_REQUEST_MS
 * after it started (running) or was requested (queued, never picked up).
 * Pure.
 */
export function isStaleRequest(doc: Pick<ScrapeRunRequestDoc, "status" | "requestedAt" | "startedAt">, nowMs: number): boolean {
  if (doc.status !== "queued" && doc.status !== "running") return false;
  const since = (doc.status === "running" ? doc.startedAt : null) ?? doc.requestedAt;
  const ms = since?.toMillis?.();
  return ms !== undefined && nowMs - ms >= STALE_REQUEST_MS;
}

/** The update that closes a timed-out request. */
function timedOutUpdate(nowMs: number): Partial<ScrapeRunRequestDoc> {
  return { status: "failed", error: TIMED_OUT_ERROR, finishedAt: Timestamp.fromMillis(nowMs) };
}

/** A refused request: 404 for NOT_FOUND, 503 for SETTINGS_UNAVAILABLE, 409 otherwise. */
export class RunRequestError extends Error {
  constructor(
    readonly code: RunRequestRefusal,
    message: string,
    /** Extra response fields (requestId of the run in progress, retryAfter ISO). */
    readonly extra: Record<string, string> = {}
  ) {
    super(message);
  }
}

/** What the API returns on 202. */
export interface CreatedRunRequest {
  requestId: string;
  runId: string | null;
  status: "queued";
}

/** The lock doc id of a scope: `visa__GB`, `news__cic-news`, `visa___all`. */
export function lockIdFor(kind: ScraperSettingsKind, sourceId: string | null): string {
  return `${kind}__${sourceId ?? "_all"}`;
}

/** Statuses that hold the lock. */
const IN_FLIGHT = new Set(["queued", "running"]);

export class ScrapeRunRequestService {
  /** Transaction runner. Swapped for the in-memory one in tests. */
  runTransaction: <T>(fn: (tx: Transaction) => Promise<T>) => Promise<T> = (fn) => db.runTransaction(fn);

  /** Clock (ms). Swappable in tests. */
  clock: () => number = Date.now;

  /**
   * Settings loader (the cooldown + blockManualWhenOff). Swappable in tests.
   * A wrapper, so the imported binding is read at call time, not at load.
   */
  loadSettings: () => Promise<LoadedScraperSettings> = () => loadScraperSettingsResult();

  /** Lease clock (ms) for the lease check; the lease service's real clock. */
  leaseClock: () => number = () => sourceLeaseService.clock();

  /**
   * Create a Run now request, or throw RunRequestError. `sourceId` null =
   * the whole scraper (scope "scraper").
   */
  async create(input: {
    kind: ScraperSettingsKind;
    sourceId: string | null;
    force: boolean;
    uid: string;
    nowMs?: number;
  }): Promise<CreatedRunRequest> {
    const nowMs = input.nowMs ?? this.clock();
    const loaded = await this.loadSettings();
    if (loaded.readError) {
      throw new RunRequestError("SETTINGS_UNAVAILABLE", "Scraper settings could not be read; try again shortly");
    }
    const settings = loaded.settings;
    const sw = settings[input.kind];

    // ---- Scraper switched off AND manual runs blocked ----
    if (!sw.enabled && sw.blockManualWhenOff) {
      throw new RunRequestError(
        "SCRAPER_DISABLED",
        `The ${input.kind} scraper is switched off and manual runs are blocked (blockManualWhenOff)`
      );
    }

    // ---- The source must exist and be runnable (paused / retired: never) ----
    if (input.sourceId !== null) {
      const snap = await (input.kind === "visa" ? collections.visaSources : collections.newsSources).doc(input.sourceId).get();
      if (!snap.exists) throw new RunRequestError("NOT_FOUND", `${input.kind} source ${input.sourceId} not found`);
      const status = (snap.data() as { status?: string } | undefined)?.status;
      if (status !== "active" && status !== "broken") {
        throw new RunRequestError(
          "SOURCE_NOT_ACTIVE",
          `${input.kind} source ${input.sourceId} is ${status ?? "not active"}; set it active before running it`
        );
      }
    }

    const scope: ScrapeRunRequestScope = input.sourceId === null ? "scraper" : "source";
    const lockId = lockIdFor(input.kind, input.sourceId);
    const lockRef = collections.scrapeRunLocks.doc(lockId);
    const cooldownMs = settings.manualRuns.cooldownMinutes * 60 * 1000;

    const leaseNowMs = this.leaseClock();
    return this.runTransaction(async (tx) => {
      // ---- Reads first (Firestore: all reads before any write) ----
      const lockSnap = await tx.get(lockRef);
      const lock = lockSnap.exists ? (lockSnap.data() as ScrapeRunLockDoc) : undefined;
      const activeRef = lock?.activeRequestId ? collections.scrapeRunRequests.doc(lock.activeRequestId) : undefined;
      const activeSnap = activeRef ? await tx.get(activeRef) : undefined;
      const active = activeSnap?.exists ? (activeSnap.data() as ScrapeRunRequestDoc) : undefined;
      // Scope "source": the scraper-wide request of this kind + the lease.
      let allActive: ScrapeRunRequestDoc | undefined;
      let lease: Awaited<ReturnType<typeof sourceLeaseService.heldIn>> = null;
      if (input.sourceId !== null) {
        const allSnap = await tx.get(collections.scrapeRunLocks.doc(lockIdFor(input.kind, null)));
        const allLock = allSnap.exists ? (allSnap.data() as ScrapeRunLockDoc) : undefined;
        if (allLock?.activeRequestId) {
          const s = await tx.get(collections.scrapeRunRequests.doc(allLock.activeRequestId));
          allActive = s.exists ? (s.data() as ScrapeRunRequestDoc) : undefined;
        }
        lease = await sourceLeaseService.heldIn(tx, input.kind, input.sourceId, leaseNowMs);
      }

      // ---- 1. One in flight (a request past its deadline is closed as failed) ----
      if (active && IN_FLIGHT.has(active.status)) {
        if (isStaleRequest(active, nowMs)) {
          tx.update(activeRef!, timedOutUpdate(nowMs));
        } else {
          throw new RunRequestError("RUN_IN_PROGRESS", "A manual run of this scope is already queued or running", {
            requestId: active.id,
          });
        }
      }

      // ---- 3 (checked before the cooldown: the more useful answer) ----
      if (allActive && IN_FLIGHT.has(allActive.status) && !isStaleRequest(allActive, nowMs)) {
        throw new RunRequestError(
          "RUN_IN_PROGRESS",
          `A whole-scraper ${input.kind} run is queued or running and will crawl this source if it is due`,
          { requestId: allActive.id }
        );
      }
      if (lease) {
        throw new RunRequestError("RUN_IN_PROGRESS", `This source is being crawled by a ${lease.holder.trigger} run`, {
          ...(lease.holder.runId ? { runId: lease.holder.runId } : {}),
          leaseExpiresAt: lease.holder.expiresAt,
        });
      }

      // ---- 2. Cooldown since the last request ----
      const lastMs = lock?.lastRequestedAt?.toMillis?.();
      if (lastMs !== undefined && nowMs - lastMs < cooldownMs) {
        const retryAfter = new Date(lastMs + cooldownMs).toISOString();
        throw new RunRequestError(
          "RUN_COOLDOWN",
          `A manual run was requested less than ${settings.manualRuns.cooldownMinutes} minute(s) ago; retry after ${retryAfter}`,
          { retryAfter }
        );
      }

      // ---- 4. Create the request + take the lock ----
      const ref = collections.scrapeRunRequests.doc();
      const at = Timestamp.fromMillis(nowMs);
      const doc: ScrapeRunRequestDoc = {
        id: ref.id,
        kind: input.kind,
        scope,
        sourceId: input.sourceId,
        force: input.force,
        status: "queued",
        runId: null,
        requestedBy: input.uid,
        requestedAt: at,
        startedAt: null,
        finishedAt: null,
        summary: null,
        skipReason: null,
        error: null,
        lockId,
        expireAt: Timestamp.fromMillis(nowMs + RUN_REQUEST_RETENTION_DAYS * DAY_MS),
      };
      tx.set(ref, doc);
      const nextLock: ScrapeRunLockDoc = { activeRequestId: ref.id, activeSince: at, lastRequestedAt: at };
      tx.set(lockRef, nextLock);
      return { requestId: ref.id, runId: null, status: "queued" as const };
    });
  }

  /**
   * Mark one request `failed` ("timed out") when it is still queued /
   * running past its deadline (re-checked in a transaction). Returns true
   * when it did.
   */
  async expireIfStale(id: string, nowMs: number = this.clock()): Promise<boolean> {
    const ref = collections.scrapeRunRequests.doc(id);
    return this.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists || !isStaleRequest(snap.data() as ScrapeRunRequestDoc, nowMs)) return false;
      tx.update(ref, timedOutUpdate(nowMs));
      return true;
    });
  }

  /**
   * Close every queued / running request past its deadline (the worker
   * calls this before each run). One `in` query on `status` (single-field
   * index), a handful of docs at most. Never throws; returns how many.
   */
  async sweepStale(nowMs: number = this.clock()): Promise<number> {
    try {
      const snap = await collections.scrapeRunRequests.where("status", "in", ["queued", "running"]).get();
      let n = 0;
      for (const d of snap.docs) {
        if (isStaleRequest(d.data() as ScrapeRunRequestDoc, nowMs) && (await this.expireIfStale(d.id, nowMs))) n++;
      }
      return n;
    } catch (err) {
      console.error(`Scrape run requests: stale sweep failed: ${(err as Error)?.message ?? err}`);
      return 0;
    }
  }

  /** One request as JSON (ISO dates), or null. A request past its deadline is closed first. */
  async get(id: string): Promise<Record<string, unknown> | null> {
    let snap = await collections.scrapeRunRequests.doc(id).get();
    if (!snap.exists) return null;
    if (isStaleRequest(snap.data() as ScrapeRunRequestDoc, this.clock()) && (await this.expireIfStale(id))) {
      snap = await collections.scrapeRunRequests.doc(id).get();
    }
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { expireAt: _e, lockId: _l, ...rest } = snap.data() as Record<string, unknown>;
    return { ...(toJson(rest) as Record<string, unknown>), id: snap.id };
  }
}

export const scrapeRunRequestService = new ScrapeRunRequestService();
