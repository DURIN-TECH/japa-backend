import { collections, db } from "../../../utils/firebase";
import { Timestamp, type Transaction } from "firebase-admin/firestore";

// ============================================
// SOURCE REGISTRY — PER-ADMIN HOURLY RATE LIMITS (issue #215)
// ============================================
//
// Address checks and route registrations each make the server fetch pages from
// other people's websites. A counter doc per (admin, kind, clock hour) bounds
// that: `sourceRegistryRateLimits/{uid}__{kind}__{hour}`. The count is read and
// incremented in ONE transaction, so two parallel calls cannot both slip under
// the limit. The limits themselves are settings (registry-settings.ts).

/** What is being limited. */
export type RateLimitKind = "preview" | "registration";

/** Result of trying to use one unit of the allowance. */
export interface RateLimitResult {
  allowed: boolean;
  // Seconds until the current hour ends (only when refused).
  retryAfterSeconds?: number;
}

const HOUR_MS = 60 * 60 * 1000;

class RegistryRateLimiter {
  /** Transaction runner (tests swap in the in-memory one). */
  runTransaction: <T>(fn: (tx: Transaction) => Promise<T>) => Promise<T> = (fn) => db.runTransaction(fn);
  /** Clock in epoch ms (tests fix it). */
  clock: () => number = Date.now;

  /**
   * Count one use for `uid`. Refused (no write) when the hour's count has
   * already reached `limit`; otherwise the counter is incremented.
   */
  async consume(uid: string, kind: RateLimitKind, limit: number): Promise<RateLimitResult> {
    const now = this.clock();
    const hour = Math.floor(now / HOUR_MS);
    const ref = collections.sourceRegistryRateLimits.doc(`${uid}__${kind}__${hour}`);
    return this.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const count = snap.exists ? Number((snap.data() as { count?: number }).count ?? 0) : 0;
      if (count >= limit) return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(((hour + 1) * HOUR_MS - now) / 1000)) };
      tx.set(ref, { uid, kind, hour, count: count + 1, updatedAt: Timestamp.fromMillis(now) });
      return { allowed: true };
    });
  }
}

export const registryRateLimiter = new RegistryRateLimiter();
