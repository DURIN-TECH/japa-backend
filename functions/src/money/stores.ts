import { Timestamp } from "firebase-admin/firestore";
import { collections } from "../utils/firebase";
import type { FxRateSource } from "../types/money";
import type { ConfigStore } from "./config";
import type { RateAuditEntry, RateStore, StoredOverride, StoredProviderRate, StoredRate } from "./rate.types";

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

export const firestoreRateStore: RateStore = {
  async get(currency) {
    const snap = await collections.exchangeRates.doc(currency).get();
    if (!snap.exists) return null;
    const d = snap.data() as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    const asOf = toDate(d.provider?.asOf);
    const fetchedAt = toDate(d.provider?.fetchedAt);
    const setAt = toDate(d.override?.setAt);
    const expiresAt = toDate(d.override?.expiresAt);
    const errAt = toDate(d.lastError?.at);
    return {
      currency,
      provider:
        d.provider && asOf && fetchedAt && typeof d.provider.rate === "number"
          ? { rate: d.provider.rate, asOf, fetchedAt, source: d.provider.source as StoredProviderRate["source"] }
          : null,
      override:
        d.override && setAt && expiresAt && typeof d.override.rate === "number"
          ? { rate: d.override.rate, reason: String(d.override.reason ?? ""), setBy: String(d.override.setBy ?? ""), setAt, expiresAt }
          : null,
      lastError: d.lastError && errAt ? { at: errAt, message: String(d.lastError.message ?? "") } : null,
    } satisfies StoredRate;
  },

  async saveProvider(currency, provider) {
    // merge: an existing override must survive a provider refresh.
    await collections.exchangeRates.doc(currency).set(
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
  },

  async saveError(currency, error) {
    // Only lastError changes; the stored rate keeps serving.
    await collections.exchangeRates
      .doc(currency)
      .set({ currency, lastError: { at: Timestamp.fromDate(error.at), message: error.message } }, { merge: true });
  },

  async saveOverride(currency, override: StoredOverride | null, audit: RateAuditEntry) {
    // The override change and its audit record commit together or not at all.
    const batch = collections.exchangeRates.firestore.batch();
    batch.set(
      collections.exchangeRates.doc(currency),
      {
        currency,
        override: override
          ? {
              rate: override.rate,
              reason: override.reason,
              setBy: override.setBy,
              setAt: Timestamp.fromDate(override.setAt),
              expiresAt: Timestamp.fromDate(override.expiresAt),
            }
          : null,
      },
      { merge: true }
    );
    batch.set(collections.exchangeRateAudit.doc(), {
      ...audit,
      at: Timestamp.fromDate(audit.at),
    });
    await batch.commit();
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
      } satisfies RateAuditEntry;
    });
  },
};
