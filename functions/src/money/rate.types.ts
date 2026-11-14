import type { CurrencyCode, FxRateSource } from "../types/money";

// ============================================
// RATE STORAGE SHAPES (issue #178)
// ============================================
//
// One stored document per currency: `exchangeRates/{CURRENCY}`. It keeps the
// PROVIDER's last rate and an optional admin OVERRIDE side by side, so an
// override never destroys the provider reference it is checked against.
// Domain objects use Date; the Firestore store converts to Timestamp.

/** The last rate a provider returned for a currency. */
export interface StoredProviderRate {
  rate: number;
  /** When the source published it (CBN: the rate's date). */
  asOf: Date;
  /**
   * When we last saw the provider confirm this as its latest rate. Freshness
   * is measured from here, so a Friday rate re-confirmed on Saturday stays
   * fresh, while a provider that stops answering ages out.
   */
  fetchedAt: Date;
  /** Only a provider writes this map, so it never says "manual" or "hold". */
  source: Exclude<FxRateSource, "manual" | "hold">;
}

/** An admin-entered rate, valid until `expiresAt`. */
export interface StoredOverride {
  rate: number;
  reason: string;
  setBy: string;
  setAt: Date;
  expiresAt: Date;
  /**
   * True when it was set while NO provider rate existed to check it against
   * (issue #214). Such an override lasts 24h at most and is flagged in the
   * admin overview while active.
   */
  unreferenced?: boolean;
  /**
   * The provider rate the override's band was checked against when it was
   * set (issue #229). Written on every REFERENCED override from #229 on, so
   * an override carrying neither this nor `unreferenced` is one stored before
   * #214/#229 whose reference is unknown: it is then treated like an
   * unreferenced one (see `isUnreferencedOverride`), which fails safe.
   */
  referenceRate?: number;
}

/**
 * An admin HOLD (pin) of a currency's rate (issue #241), valid until
 * `expiresAt` (1-168h after `setAt`).
 *
 * Why it exists: CBN is always in the provider chain, so when CBN lags a real
 * devaluation by more than the 10% band (and OANDA has no key) an override of
 * the true rate is superseded at CBN's next refresh. A hold is the explicit
 * "price at this rate for now" switch: while it is active it IS the effective
 * rate (source `hold`), ahead of any override and whatever the provider says
 * or however fresh it is. Refreshes still fetch and store the provider rate
 * behind it (same guards), so the admin overview can show the gap and normal
 * rules resume the moment the hold expires or is cleared.
 */
export interface StoredHold {
  rate: number;
  reason: string;
  setBy: string;
  setAt: Date;
  expiresAt: Date;
}

/**
 * Issue #229: true when an override was NOT checked against a provider rate
 * when it was set, or when that can no longer be told:
 *  - `unreferenced: true` (set with no provider rate, #214 onwards); or
 *  - a legacy override with neither `unreferenced` nor `referenceRate`
 *    (written before #229, where a referenced and an unreferenced override
 *    looked the same). Treating those as unreferenced is the safe reading:
 *    they only lose to a FRESH provider rate they are far away from.
 */
export function isUnreferencedOverride(override: StoredOverride): boolean {
  return override.unreferenced === true || override.referenceRate === undefined;
}

/**
 * Issue #229: true when two provider states are the same, i.e. the doc's
 * provider part has not changed between a read and a later re-read. Compares
 * every field of the provider map (rate, both dates, source) and the
 * "corrupt" flag. Two missing providers are equal. Used by the conditional
 * provider write in refreshOne, so a reset-reference (provider -> null) or
 * another refresh landing in between is detected.
 */
export function sameProviderState(
  a: Pick<StoredRate, "provider" | "providerCorrupt"> | null,
  b: Pick<StoredRate, "provider" | "providerCorrupt"> | null
): boolean {
  const pa = a?.provider ?? null;
  const pb = b?.provider ?? null;
  // A corrupt map and a missing map are different states (reset clears one).
  if (!!a?.providerCorrupt !== !!b?.providerCorrupt) return false;
  if (pa === null || pb === null) return pa === pb;
  return (
    pa.rate === pb.rate &&
    pa.source === pb.source &&
    pa.asOf.getTime() === pb.asOf.getTime() &&
    pa.fetchedAt.getTime() === pb.fetchedAt.getTime()
  );
}

/** The whole per-currency document. */
export interface StoredRate {
  currency: CurrencyCode;
  provider: StoredProviderRate | null;
  override: StoredOverride | null;
  /**
   * Issue #241: an admin hold (see StoredHold), or null/absent when none.
   * Optional so docs and test fixtures written before #241 still type-check;
   * absent and null mean the same thing.
   */
  hold?: StoredHold | null;
  /** Last failed provider attempt (message only, never a secret). */
  lastError: { at: Date; message: string } | null;
  /**
   * True when a `provider` map exists in storage but cannot be read. It is
   * NOT the same as "no provider rate": an override must not take the
   * unreferenced path over a damaged reference.
   */
  providerCorrupt?: boolean;
  /**
   * When an admin last asked for a refresh now (issue #214). Used only to
   * rate-limit POST /admin/exchange-rates/:currency/refresh.
   */
  manualRefreshAt?: Date | null;
}

/** One append-only audit record per admin change (who, when, old, new). */
export interface RateAuditEntry {
  currency: CurrencyCode;
  /** `hold_set` / `hold_cleared` added by issue #241. */
  action: "override_set" | "override_cleared" | "provider_reset" | "provider_refresh" | "hold_set" | "hold_cleared";
  by: string;
  at: Date;
  reason: string;
  /** The effective rate before the change (null when none existed). */
  old: { rate: number; source: FxRateSource } | null;
  /** The effective rate after the change (null when none). */
  new: { rate: number; source: FxRateSource } | null;
  /** True when no provider rate existed to check the band against. */
  unreferenced?: boolean;
  /** provider_refresh only: what the refresh did ("ok: cbn 1500" or "failed: ..."). */
  outcome?: string;
  /** hold_set only (issue #241): when the new hold expires. */
  holdExpiresAt?: Date;
}

/**
 * What an admin change does to a currency doc, decided from the doc as read
 * INSIDE the transaction (issue #214). Fields left undefined are unchanged.
 */
export interface RateMutation {
  /** New override, or null to clear it; undefined leaves it as is. */
  override?: StoredOverride | null;
  /** Issue #241: new hold, or null to clear it; undefined leaves it as is. */
  hold?: StoredHold | null;
  /** True drops the stored provider rate (and any "corrupt" flag with it). */
  clearProvider?: boolean;
  /** The audit record; written in the same transaction as the change. */
  audit: RateAuditEntry;
  /**
   * Issue #241: further audit records for the same change, written in the
   * same transaction (e.g. a reset-reference that also clears a superseded
   * override writes `provider_reset` AND `override_cleared`).
   */
  extraAudits?: RateAuditEntry[];
}

/**
 * Result of RateStore.saveProvider (issue #229). `saved: false` = the provider
 * part changed since the caller read it, nothing written. `saved: true`
 * carries the doc's override as re-read in the same transaction as the
 * write (null when there is none), i.e. the override that now sits in front
 * of the rate just stored.
 */
export type SaveProviderResult =
  | { saved: false }
  /** Issue #241: `hold` is the doc's hold as re-read in the same transaction (null when none). */
  | { saved: true; override: StoredOverride | null; hold: StoredHold | null };

/** Persistence for rate docs and the audit trail. */
export interface RateStore {
  get(currency: CurrencyCode): Promise<StoredRate | null>;
  /**
   * Store a new provider rate (merge: the override and other fields stay),
   * but ONLY if the doc's provider part is still `expected`, the state the
   * caller read before it fetched the rate (issue #229). Read, compare and
   * write run in one transaction. Returns false, writing nothing, when the
   * provider part changed in between (typically an admin reset-reference),
   * so a rate judged against a reference that was just dropped is never
   * stored over the reset. The provider fetch itself must happen BEFORE this
   * call, never inside the transaction (it may be retried).
   *
   * On success it also returns the override as read INSIDE that transaction,
   * so the caller judges the override as it is now, not as it was before the
   * fetch (an admin may have set or cleared one meanwhile; #229 review).
   */
  saveProvider(
    currency: CurrencyCode,
    provider: StoredProviderRate,
    expected: Pick<StoredRate, "provider" | "providerCorrupt"> | null
  ): Promise<SaveProviderResult>;
  saveError(currency: CurrencyCode, error: { at: Date; message: string }): Promise<void>;
  /**
   * Read the doc, let `decide` check it and say what to change, then write the
   * change AND its audit entry, all in ONE transaction (issue #214). `decide`
   * may throw (e.g. a MoneyError for a rate outside the band): nothing is
   * written then. Under contention Firestore may call `decide` more than
   * once, so it must be free of side effects other than its return value.
   */
  transact(currency: CurrencyCode, decide: (stored: StoredRate | null) => RateMutation): Promise<void>;
  /** Append one audit entry on its own (used by the admin "refresh now"). */
  appendAudit(audit: RateAuditEntry): Promise<void>;
  /**
   * Claim the admin "refresh now" slot for a currency (issue #214): allowed
   * (and `manualRefreshAt` set to `at`) unless the last claim was less than
   * `cooldownMs` ago. Read and write in one transaction, so two admins
   * clicking at once cannot both get through.
   */
  claimManualRefresh(
    currency: CurrencyCode,
    at: Date,
    cooldownMs: number
  ): Promise<{ allowed: boolean; retryAfterSeconds?: number }>;
  /**
   * Give back a "refresh now" slot claimed at `claimedAt` (issue #229), used
   * when the refresh failed before the provider was contacted (e.g. a
   * Firestore read error): no outbound request was made, so the admin may
   * retry at once. Clears `manualRefreshAt` only while it still equals
   * `claimedAt`, in a transaction, so a later claim is never released.
   */
  releaseManualRefresh(currency: CurrencyCode, claimedAt: Date): Promise<void>;
  /** Newest-first audit history for one currency. */
  listAudit(currency: CurrencyCode, limit: number): Promise<RateAuditEntry[]>;
}
