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
  source: Exclude<FxRateSource, "manual">;
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
}

/** The whole per-currency document. */
export interface StoredRate {
  currency: CurrencyCode;
  provider: StoredProviderRate | null;
  override: StoredOverride | null;
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
  action: "override_set" | "override_cleared" | "provider_reset" | "provider_refresh";
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
}

/**
 * What an admin change does to a currency doc, decided from the doc as read
 * INSIDE the transaction (issue #214). Fields left undefined are unchanged.
 */
export interface RateMutation {
  /** New override, or null to clear it; undefined leaves it as is. */
  override?: StoredOverride | null;
  /** True drops the stored provider rate (and any "corrupt" flag with it). */
  clearProvider?: boolean;
  /** The audit record; written in the same transaction as the change. */
  audit: RateAuditEntry;
}

/** Persistence for rate docs and the audit trail. */
export interface RateStore {
  get(currency: CurrencyCode): Promise<StoredRate | null>;
  /** Replace/merge the provider part (or lastError) of a currency doc. */
  saveProvider(currency: CurrencyCode, provider: StoredProviderRate): Promise<void>;
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
  /** Newest-first audit history for one currency. */
  listAudit(currency: CurrencyCode, limit: number): Promise<RateAuditEntry[]>;
}
