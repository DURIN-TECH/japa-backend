import type { Timestamp } from "firebase-admin/firestore";

// ============================================
// MONEY TYPES (issue #178)
// ============================================
//
// Product rule: prices are SET and STORED in US dollars; a client SEES the
// price in their local currency at the current rate and PAYS that local
// amount. These are the shared shapes for that. The behaviour lives in
// `src/money/` (helpers, rate service, quote()).
//
// Hard rules every consumer relies on:
//  - Currency is always an explicit field next to the amount. A bare number
//    is never money.
//  - Amounts are INTEGER minor units (cents, kobo). No floating-point money.
//  - The client never supplies an amount, a currency or a rate.

/** ISO 4217 alphabetic code, upper case ("NGN", "USD"). */
export type CurrencyCode = string;

/**
 * An amount of money. `amountMinor` is an integer count of the currency's
 * minor unit (USD cents, NGN kobo); how many minor units make one major unit
 * is the currency's exponent in `money/currencies.ts` (the ONLY place a
 * minor-unit factor is applied).
 */
export interface Money {
  amountMinor: number;
  currency: CurrencyCode;
}

/**
 * Where an exchange rate came from. `manual` = an admin-entered override.
 * `hold` (issue #241) = an admin-held (pinned) rate that outranks the provider
 * and any override until it expires; a charge snapshot priced with it records
 * `fxRateSource: "hold"`, so the charge shows the rate was held.
 */
export type FxRateSource = "cbn" | "oanda" | "manual" | "hold";

/**
 * A usable exchange rate: how many units of `currency` equal 1 US dollar
 * (naira per dollar for NGN), as published at `asOf`.
 */
export interface ExchangeRate {
  currency: CurrencyCode;
  /** Local units per 1 USD. A rate, not money: it may carry decimals. */
  rate: number;
  /** When the source published this rate (ISO 8601). */
  asOf: string;
  source: FxRateSource;
  /** Basis points added on top of the rate when charging (0 at first). */
  marginBps: number;
}

/** The result of pricing a dollar amount in a local currency. */
export interface Quote {
  usd: Money;
  local: Money;
  rate: number;
  asOf: string;
  source: FxRateSource;
  marginBps: number;
}

/**
 * THE snapshot of a charge, stored on a booking, payment request and
 * transaction so a past payment never changes when the rate moves. These
 * field names are the contract the child issues (#179-#183) rely on: do not
 * rename them.
 *
 * `Transaction.amount` keeps meaning "minor units of `Transaction.currency`";
 * `chargedAmountMinor` / `chargedCurrency` repeat that on the records that
 * are not themselves a Transaction.
 *
 * Re-deriving an amount from `priceUsdCents` and `fxRate` MUST go through
 * `scaleRate` / `convertUsdToLocal` (the rate is held to 6 decimals; a raw
 * float multiply can differ by a kobo). Prefer the stored `chargedAmountMinor`.
 * The quote-lock / expiry time (how long a quote may be charged) is the
 * separate `QuoteLock` below (issue #180), stored next to the snapshot on a
 * booking; this snapshot only records what was (to be) charged.
 */
export interface ChargeSnapshot {
  /** The price as set by the agent, in US cents. */
  priceUsdCents: number;
  /** The currency the client was actually charged in. */
  chargedCurrency: CurrencyCode;
  /** The amount charged, in minor units of `chargedCurrency`. */
  chargedAmountMinor: number;
  /** Local units per 1 USD used for this charge (margin NOT included). */
  fxRate: number;
  /** When the source published `fxRate`. */
  fxRateAsOf: Timestamp;
  fxRateSource: FxRateSource;
  /** Margin applied on top of `fxRate`, in basis points. */
  fxMarginBps: number;
}

/**
 * The quote lock stored next to a ChargeSnapshot on a record that is charged
 * LATER than it is priced (issue #180: a consultation booking that waits for
 * a Paystack checkout).
 *
 * The snapshot is priced when the booking is created (`quoteLockedAt`) and
 * may be charged until `quoteExpiresAt` (30 minutes later, see
 * `QUOTE_LOCK_MINUTES` in services/consultation-charge.service.ts). After
 * that a verify or a retry re-prices with a FRESH quote; a stale snapshot is
 * never charged again.
 */
export interface QuoteLock {
  /** When the snapshot was priced. */
  quoteLockedAt: Timestamp;
  /** After this, the snapshot may no longer be charged (fresh quote needed). */
  quoteExpiresAt: Timestamp;
}

// ============================================
// CONFIG: appConfig/currencies (backend-only)
// ============================================

/** One supported charge currency. */
export interface CurrencyConfigEntry {
  /** Disabled currencies are known but cannot be charged. */
  enabled: boolean;
  /**
   * Profile countries that map to this currency, matched case-insensitively
   * against `User.residentialCountry` (list both the code and the name,
   * e.g. ["NG", "Nigeria"]).
   */
  countries: string[];
  /** Optional per-currency margin; falls back to `defaultMarginBps`. */
  marginBps?: number;
  /**
   * Plausible range for the rate (local units per USD). A provider rate or an
   * unreferenced admin override outside it is refused. When a currency has no
   * range, a first-run rate and an unreferenced override are refused outright
   * (there is nothing to judge them against).
   */
  minRate?: number;
  maxRate?: number;
}

/** `appConfig/currencies`: supported currencies and rate rules. */
export interface CurrenciesConfig {
  /** Charge currency for a client with no profile country or an unmapped one. */
  defaultCurrency: CurrencyCode;
  currencies: Record<CurrencyCode, CurrencyConfigEntry>;
  /**
   * How long a provider rate may be served after the provider last confirmed
   * it, in hours. Past this a quote fails instead of using an old rate.
   */
  freshnessHours: number;
  /** Margin in basis points when a currency sets none (default 0). */
  defaultMarginBps: number;
  /**
   * Oldest a provider rate's OWN date (`asOf`) may be and still price, in
   * hours (default 144 = 6 days, issue #214: covers a four-day bank closure
   * such as Good Friday to Easter Monday plus a day). Unlike `freshnessHours`
   * this cannot be refreshed by re-reading the same old row. Capped at 240.
   */
  maxRateAgeHours: number;
  /**
   * A new provider rate that differs from the stored one by more than this
   * percent is rejected (default 10, capped at 50). A genuine large move is
   * accepted by an admin through POST /admin/exchange-rates/:currency/reset-reference.
   */
  maxProviderJumpPercent: number;
  /** Which provider is preferred. `oanda` is used only when its key exists. */
  provider: "cbn" | "oanda";
  /** An admin override must be within this percent of the last provider rate. */
  overrideBandPercent: number;
  /** How long an admin override stays active by default, in hours. */
  overrideTtlHours: number;
}

// ============================================
// DOLLAR PRICES ON AGENTS AND AGENCIES (issue #179)
// ============================================

/**
 * A dollar price shown with its local-currency equivalent (issue #179).
 *
 * Returned by the public reads (agents, agencies, visa prices) NEXT TO the
 * stored dollar `Money`; never stored. Built from the #178 effective rate by
 * `money/local-price.ts`. When the rate is missing or stale the read still
 * succeeds: `available` is false and the amount, rate and asOf are null (the
 * client shows the dollar price only). `currency` is always set, so a client
 * can still say which currency is unavailable.
 */
export interface LocalPriceQuote {
  /** Minor units of `currency` (kobo for NGN); null when unavailable. */
  amountMinor: number | null;
  currency: CurrencyCode;
  /** Local units per 1 USD used for this figure; null when unavailable. */
  rate: number | null;
  /** When the rate was published (ISO 8601); null when unavailable. */
  asOf: string | null;
  available: boolean;
}

/**
 * Audit trail of one price converted from naira by the #179 migration
 * (`scripts/migrate-prices-to-usd.ts`). Stored next to the dollar price under
 * the doc's `migratedFrom` map, keyed by the OLD field name, so the original
 * value can always be traced and, if the rate was wrong, recomputed.
 */
export interface PriceMigrationRecord {
  /** The old price in WHOLE NAIRA (major units), whatever unit it was stored in. */
  amount: number;
  currency: "NGN";
  /** Naira per 1 USD the conversion used (the script's required `--rate`). */
  rate: number;
  /** The raw number that was stored before the migration. */
  storedValue: number;
  /** How `storedValue` was read: whole naira, or pre-#148 kobo (agent fees only). */
  storedUnit: "naira" | "kobo";
  migratedAt: Timestamp;
}
