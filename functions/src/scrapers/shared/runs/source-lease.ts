import { randomUUID } from "crypto";
import { Timestamp, type Transaction } from "firebase-admin/firestore";
import { collections, db } from "../../../utils/firebase";
import type { ScrapeRunKind, ScrapeRunTrigger } from "./types";

// ============================================
// SOURCE CRAWL LEASES — one crawl of a source at a time (issue #96 review)
// ============================================
//
// Every crawl of a source (a scheduled tick, a single-source manual run, a
// whole-scraper manual run) takes the source's lease
// `scrapeSourceLeases/{kind}__{sourceId}` in a transaction BEFORE it touches
// the source, and releases it when it is done. A source whose lease is held
// by another run (and not expired) is not crawled: the tick records it as a
// `deferred` source with the reason, and the Run now API answers 409
// RUN_IN_PROGRESS. Without this, two runs could crawl the same source at
// once: each does a read-modify-write of the source doc's `pages` (hashes,
// crawl times) outside a transaction, so one run's update was lost, and each
// spent its own maxExtractionsPerRun on the same pages.
//
// Crash safety: a lease expires LEASE_TTL_MS after it was taken (the
// scraper functions' 540s timeout plus a margin), so a run killed before
// releasing it blocks the source for at most that long; the next crawl after
// that reclaims it. Release only deletes a lease that still carries THIS
// acquisition's token, so a late release can never free a newer holder's
// lease. Leases use the REAL clock (not a tick's injected `now`), so every
// process compares expiries on the same clock.

/** How long a lease holds without a release: 540s function timeout + margin. */
export const LEASE_TTL_MS = 15 * 60 * 1000;

/** The `scrapeSourceLeases/{id}` doc. */
export interface SourceLeaseDoc {
  kind: ScrapeRunKind;
  sourceId: string;
  token: string; // random per acquisition; release must present it
  trigger: ScrapeRunTrigger; // what holds it: scheduled | manual | script
  runId: string | null; // the scrapeRuns doc of the holder, when known
  acquiredAt: Timestamp;
  expiresAt: Timestamp;
}

/** A granted lease (keep it to release). */
export interface HeldLease {
  ok: true;
  id: string;
  kind: ScrapeRunKind;
  sourceId: string;
  token: string;
}

/** A refused lease: who holds it. */
export interface RefusedLease {
  ok: false;
  holder: { trigger: ScrapeRunTrigger; runId: string | null; expiresAt: string };
}

/** `visa__GB`, `news__cic-news`. */
export function leaseIdFor(kind: ScrapeRunKind, sourceId: string): string {
  return `${kind}__${sourceId}`;
}

/** Human reason for a source skipped because of a held lease (run line). */
export function leaseHeldReason(r: RefusedLease): string {
  return (
    `source is being crawled by another ${r.holder.trigger} run` +
    (r.holder.runId ? ` (${r.holder.runId})` : "") +
    `; its lease expires at ${r.holder.expiresAt}`
  );
}

export class SourceLeaseService {
  /** Transaction runner. Swapped for the in-memory one in tests. */
  runTransaction: <T>(fn: (tx: Transaction) => Promise<T>) => Promise<T> = (fn) => db.runTransaction(fn);

  /** Real clock (ms). Swappable in tests (expiry). */
  clock: () => number = Date.now;

  /**
   * Take the lease of one source, or learn who holds it. Free, expired, or
   * missing -> taken (overwritten). Throws only on a Firestore failure (the
   * caller then does not crawl the source).
   */
  async acquire(
    kind: ScrapeRunKind,
    sourceId: string,
    holder: { trigger: ScrapeRunTrigger; runId?: string | null }
  ): Promise<HeldLease | RefusedLease> {
    const id = leaseIdFor(kind, sourceId);
    const ref = collections.scrapeSourceLeases.doc(id);
    const nowMs = this.clock();
    return this.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const cur = snap.exists ? (snap.data() as SourceLeaseDoc) : undefined;
      const expMs = cur?.expiresAt?.toMillis?.();
      if (cur && expMs !== undefined && expMs > nowMs) {
        return {
          ok: false as const,
          holder: { trigger: cur.trigger, runId: cur.runId ?? null, expiresAt: new Date(expMs).toISOString() },
        };
      }
      const token = randomUUID();
      const doc: SourceLeaseDoc = {
        kind,
        sourceId,
        token,
        trigger: holder.trigger,
        runId: holder.runId ?? null,
        acquiredAt: Timestamp.fromMillis(nowMs),
        expiresAt: Timestamp.fromMillis(nowMs + LEASE_TTL_MS),
      };
      tx.set(ref, doc);
      return { ok: true as const, id, kind, sourceId, token };
    });
  }

  /**
   * Release a lease this run holds (deletes it only while it still carries
   * our token). Never throws: on failure the lease simply expires.
   */
  async release(lease: HeldLease): Promise<void> {
    const ref = collections.scrapeSourceLeases.doc(lease.id);
    try {
      await this.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        if (snap.exists && (snap.data() as SourceLeaseDoc).token === lease.token) tx.delete(ref);
      });
    } catch (err) {
      console.error(`Source lease ${lease.id}: release failed (it expires on its own): ${(err as Error)?.message ?? err}`);
    }
  }

  /**
   * The current, unexpired holder of a source's lease, or null. Read inside
   * the caller's transaction (the Run now API) so the check and the request
   * write are atomic with respect to other requests.
   */
  async heldIn(tx: Transaction, kind: ScrapeRunKind, sourceId: string, nowMs: number = this.clock()): Promise<RefusedLease | null> {
    const snap = await tx.get(collections.scrapeSourceLeases.doc(leaseIdFor(kind, sourceId)));
    if (!snap.exists) return null;
    const cur = snap.data() as SourceLeaseDoc;
    const expMs = cur.expiresAt?.toMillis?.();
    if (expMs === undefined || expMs <= nowMs) return null;
    return { ok: false, holder: { trigger: cur.trigger, runId: cur.runId ?? null, expiresAt: new Date(expMs).toISOString() } };
  }
}

export const sourceLeaseService = new SourceLeaseService();
