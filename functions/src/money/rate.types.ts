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
}

/** The whole per-currency document. */
export interface StoredRate {
  currency: CurrencyCode;
  provider: StoredProviderRate | null;
  override: StoredOverride | null;
  /** Last failed provider attempt (message only, never a secret). */
  lastError: { at: Date; message: string } | null;
}

/** One append-only audit record per admin change (who, when, old, new). */
export interface RateAuditEntry {
  currency: CurrencyCode;
  action: "override_set" | "override_cleared";
  by: string;
  at: Date;
  reason: string;
  /** The effective rate before the change (null when none existed). */
  old: { rate: number; source: FxRateSource } | null;
  /** The effective rate after the change (null when none). */
  new: { rate: number; source: FxRateSource } | null;
  /** True when no provider rate existed to check the band against. */
  unreferenced?: boolean;
}

/** Persistence for rate docs and the audit trail. */
export interface RateStore {
  get(currency: CurrencyCode): Promise<StoredRate | null>;
  /** Replace/merge the provider part (or lastError) of a currency doc. */
  saveProvider(currency: CurrencyCode, provider: StoredProviderRate): Promise<void>;
  saveError(currency: CurrencyCode, error: { at: Date; message: string }): Promise<void>;
  /** Write the override (or null to clear) AND the audit entry together. */
  saveOverride(currency: CurrencyCode, override: StoredOverride | null, audit: RateAuditEntry): Promise<void>;
  /** Newest-first audit history for one currency. */
  listAudit(currency: CurrencyCode, limit: number): Promise<RateAuditEntry[]>;
}
