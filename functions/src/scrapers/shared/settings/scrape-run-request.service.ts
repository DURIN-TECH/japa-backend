import { Timestamp, type Transaction } from "firebase-admin/firestore";
import { collections, db } from "../../../utils/firebase";
import { toJson } from "../runs/scrape-run.service";
import type { ScrapeRunKind } from "../runs/types";
import { loadScraperSettings } from "./scraper-settings.store";
import type {
  ScrapeRunLockDoc,
  ScrapeRunRequestDoc,
  ScrapeRunRequestScope,
  ScraperSettings,
} from "./types";

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
//   3. else the request is created `queued` and the lock points at it.
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
export type RunRequestRefusal = "NOT_FOUND" | "SOURCE_NOT_ACTIVE" | "SCRAPER_DISABLED" | "RUN_IN_PROGRESS" | "RUN_COOLDOWN";

/** A refused request: 404 for NOT_FOUND, 409 otherwise. */
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
export function lockIdFor(kind: ScrapeRunKind, sourceId: string | null): string {
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
  loadSettings: () => Promise<ScraperSettings> = () => loadScraperSettings();

  /**
   * Create a Run now request, or throw RunRequestError. `sourceId` null =
   * the whole scraper (scope "scraper").
   */
  async create(input: {
    kind: ScrapeRunKind;
    sourceId: string | null;
    force: boolean;
    uid: string;
    nowMs?: number;
  }): Promise<CreatedRunRequest> {
    const nowMs = input.nowMs ?? this.clock();
    const settings = await this.loadSettings();
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

    return this.runTransaction(async (tx) => {
      const lockSnap = await tx.get(lockRef);
      const lock = lockSnap.exists ? (lockSnap.data() as ScrapeRunLockDoc) : undefined;

      // ---- 1. One in flight ----
      if (lock?.activeRequestId) {
        const activeSnap = await tx.get(collections.scrapeRunRequests.doc(lock.activeRequestId));
        const active = activeSnap.exists ? (activeSnap.data() as ScrapeRunRequestDoc) : undefined;
        const sinceMs = lock.activeSince?.toMillis?.() ?? 0;
        if (active && IN_FLIGHT.has(active.status) && nowMs - sinceMs < STALE_REQUEST_MS) {
          throw new RunRequestError("RUN_IN_PROGRESS", "A manual run of this scope is already queued or running", {
            requestId: lock.activeRequestId,
          });
        }
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

      // ---- 3. Create the request + take the lock ----
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

  /** One request as JSON (ISO dates), or null. */
  async get(id: string): Promise<Record<string, unknown> | null> {
    const snap = await collections.scrapeRunRequests.doc(id).get();
    if (!snap.exists) return null;
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { expireAt: _e, lockId: _l, ...rest } = snap.data() as Record<string, unknown>;
    return { ...(toJson(rest) as Record<string, unknown>), id: snap.id };
  }
}

export const scrapeRunRequestService = new ScrapeRunRequestService();
