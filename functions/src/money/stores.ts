import { Timestamp, type Transaction } from "firebase-admin/firestore";
import { collections, db } from "../utils/firebase";
import type { FxRateSource } from "../types/money";
import type { ConfigStore } from "./config";
import {
  sameProviderState,
  type RateAuditEntry,
  type RateStore,
  type StoredOverride,
  type StoredProviderRate,
  type StoredRate,
} from "./rate.types";

// ============================================
// FIRESTORE STORES (issue #178)
// ============================================
//
//   appConfig/currencies           supported currencies and rate rules
//   exchangeRates/{CURRENCY}       provider rate + override (one doc each)
//   exchangeRateAudit/{auto id}    append-only admin change history
//
// All three are backend-only: firestore.rules has no match for them, so every
// client read and write is denied; only the Admin SDK touches them.

/** Doc -> Date, tolerant of a missing value. */
const toDate = (v: unknown): Date | null => (v instanceof Timestamp ? v.toDate() : null);

export const firestoreConfigStore: ConfigStore = {
  async read() {
    const snap = await collections.appConfig.doc("currencies").get();
    return snap.exists ? (snap.data() as Record<string, unknown>) : null;
  },
};

/**
 * Stored doc data -> domain StoredRate. Shared by plain reads and reads
 * inside a transaction (issue #214), so both see the doc the same way.
 */
function parseRateDoc(currency: string, d: Record<string, any>): StoredRate { // eslint-disable-line @typescript-eslint/no-explicit-any
  const asOf = toDate(d.provider?.asOf);
  const fetchedAt = toDate(d.provider?.fetchedAt);
  const setAt = toDate(d.override?.setAt);
  const expiresAt = toDate(d.override?.expiresAt);
  const errAt = toDate(d.lastError?.at);
  const providerOk =
    !!d.provider && !!asOf && !!fetchedAt && typeof d.provider.rate === "number" &&
    Number.isFinite(d.provider.rate) && d.provider.rate > 0 &&
    (d.provider.source === "cbn" || d.provider.source === "oanda");
  return {
    currency,
    // A present-but-unreadable provider map is flagged, never silently null.
    providerCorrupt: !!d.provider && !providerOk,
    provider: providerOk
      ? { rate: d.provider.rate, asOf: asOf as Date, fetchedAt: fetchedAt as Date, source: d.provider.source as StoredProviderRate["source"] }
      : null,
    override:
      d.override && setAt && expiresAt && typeof d.override.rate === "number"
        ? {
          rate: d.override.rate,
          reason: String(d.override.reason ?? ""),
          setBy: String(d.override.setBy ?? ""),
          setAt,
          expiresAt,
          ...(d.override.unreferenced === true ? { unreferenced: true } : {}),
          // Issue #229: the provider rate the band was checked against. A
          // missing or malformed value reads as "unknown" (legacy override).
          ...(typeof d.override.referenceRate === "number" && Number.isFinite(d.override.referenceRate)
            ? { referenceRate: d.override.referenceRate }
            : {}),
        }
        : null,
    lastError: d.lastError && errAt ? { at: errAt, message: String(d.lastError.message ?? "") } : null,
    manualRefreshAt: toDate(d.manualRefreshAt),
  } satisfies StoredRate;
}

/** Domain override -> stored map (Timestamps), or null to clear. */
function overrideToDoc(override: StoredOverride | null) {
  if (!override) return null;
  return {
    rate: override.rate,
    reason: override.reason,
    setBy: override.setBy,
    setAt: Timestamp.fromDate(override.setAt),
    expiresAt: Timestamp.fromDate(override.expiresAt),
    ...(override.unreferenced ? { unreferenced: true } : {}),
    ...(override.referenceRate !== undefined ? { referenceRate: override.referenceRate } : {}),
  };
}

/** Domain audit entry -> stored doc (Timestamp `at`). */
const auditToDoc = (audit: RateAuditEntry) => ({ ...audit, at: Timestamp.fromDate(audit.at) });

/**
 * The Firestore rate store. `runTransaction` is a field (like the other
 * transactional services) so tests can swap in the in-memory fake.
 */
export const firestoreRateStore: RateStore & {
  runTransaction: <T>(fn: (tx: Transaction) => Promise<T>) => Promise<T>;
} = {
  runTransaction: (fn) => db.runTransaction(fn),

  async get(currency) {
    const snap = await collections.exchangeRates.doc(currency).get();
    if (!snap.exists) return null;
    return parseRateDoc(currency, snap.data() as Record<string, unknown>);
  },

  async saveProvider(currency, provider, expected) {
    // Issue #229: a CONDITIONAL write. Before, the scheduled refresh read the
    // doc, fetched from the provider, then merged the new rate in blind: a
    // reset-reference committed in between was silently undone (the rate
    // stored had been judged against the reference just dropped). Now the
    // doc is re-read inside a transaction and the rate is written only when
    // the provider part is exactly what the caller read before its fetch.
    // The provider fetch is NOT in here: it ran before, so a transaction
    // retry never repeats an outbound request.
    // Comparing the provider fields (not the doc's update time) on purpose:
    // the admin "refresh now" claim writes `manualRefreshAt` into the same
    // doc just before its refresh, and that must not count as a conflict.
    const ref = collections.exchangeRates.doc(currency);
    return this.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const current = snap.exists ? parseRateDoc(currency, snap.data() as Record<string, unknown>) : null;
      if (!sameProviderState(current, expected)) return false;
      // merge: an existing override must survive a provider refresh.
      tx.set(
        ref,
        {
          currency,
          provider: {
            rate: provider.rate,
            asOf: Timestamp.fromDate(provider.asOf),
            fetchedAt: Timestamp.fromDate(provider.fetchedAt),
            source: provider.source,
          },
          lastError: null,
        },
        { merge: true }
      );
      return true;
    });
  },

  async saveError(currency, error) {
    // Only lastError changes; the stored rate keeps serving.
    await collections.exchangeRates
      .doc(currency)
      .set({ currency, lastError: { at: Timestamp.fromDate(error.at), message: error.message } }, { merge: true });
  },

  async transact(currency, decide) {
    // Issue #214: read, check and write in ONE transaction. Before, the
    // override was read, checked, then written in a batch, so a second admin
    // (or a refresh) landing in between could leave an audit `old` that was
    // not the effective rate, or a band checked against a rate that had just
    // changed. A throw from `decide` aborts the transaction: nothing written.
    const ref = collections.exchangeRates.doc(currency);
    await this.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const stored = snap.exists ? parseRateDoc(currency, snap.data() as Record<string, unknown>) : null;
      const mutation = decide(stored);
      const patch: Record<string, unknown> = { currency };
      if (mutation.override !== undefined) patch.override = overrideToDoc(mutation.override);
      // Dropping the provider map also drops the "corrupt" state, since that
      // flag is derived from the map being present but unreadable.
      if (mutation.clearProvider) patch.provider = null;
      tx.set(ref, patch, { merge: true });
      tx.set(collections.exchangeRateAudit.doc(), auditToDoc(mutation.audit));
    });
  },

  async appendAudit(audit) {
    await collections.exchangeRateAudit.doc().set(auditToDoc(audit));
  },

  async claimManualRefresh(currency, at, cooldownMs) {
    const ref = collections.exchangeRates.doc(currency);
    return this.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const last = snap.exists ? toDate((snap.data() as Record<string, unknown>).manualRefreshAt) : null;
      const waitMs = last ? last.getTime() + cooldownMs - at.getTime() : 0;
      if (waitMs > 0) return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(waitMs / 1000)) };
      tx.set(ref, { currency, manualRefreshAt: Timestamp.fromDate(at) }, { merge: true });
      return { allowed: true };
    });
  },

  async releaseManualRefresh(currency, claimedAt) {
    // Issue #229: give the slot back only if it is still OUR claim.
    const ref = collections.exchangeRates.doc(currency);
    await this.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return;
      const last = toDate((snap.data() as Record<string, unknown>).manualRefreshAt);
      if (!last || last.getTime() !== claimedAt.getTime()) return;
      tx.set(ref, { manualRefreshAt: null }, { merge: true });
    });
  },

  async listAudit(currency, limit) {
    const snap = await collections.exchangeRateAudit
      .where("currency", "==", currency)
      .orderBy("at", "desc")
      .limit(limit)
      .get();
    return snap.docs.map((doc) => {
      const d = doc.data() as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
      return {
        currency,
        action: d.action,
        by: String(d.by ?? ""),
        at: toDate(d.at) ?? new Date(0),
        reason: String(d.reason ?? ""),
        old: (d.old ?? null) as { rate: number; source: FxRateSource } | null,
        new: (d.new ?? null) as { rate: number; source: FxRateSource } | null,
        ...(d.unreferenced ? { unreferenced: true } : {}),
        ...(typeof d.outcome === "string" ? { outcome: d.outcome } : {}),
      } satisfies RateAuditEntry;
    });
  },
};
