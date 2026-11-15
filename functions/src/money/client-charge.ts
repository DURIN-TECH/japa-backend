// ============================================
// The charge as its PAYER may see it (issue #332)
// ============================================
//
// A booking and a payment request store a `ChargeSnapshot` (types/money.ts):
// the dollar price, the amount charged, and HOW that amount was reached:
//  - `fxRate` / `fxRateAsOf` / `fxRateSource`: the raw (mid-market) rate;
//  - `fxMarginBps`: Seli's exchange-rate markup added on top of it.
//
// The payer must not receive the markup, and not the raw rate either:
// together with the amount charged the raw rate gives the markup away.
//
// What a payer gets instead is built here, field by field (an ALLOW-LIST,
// like `toClientTransaction` of issue #329):
//  - `priceUsdCents`:      the dollar price, in US cents;
//  - `chargedCurrency`,
//    `chargedAmountMinor`: what they pay / paid;
//  - `effectiveRate`:      amount charged ÷ dollar price, in local units per
//                          1 USD. It already INCLUDES the markup, so the app
//                          can show "$6.00 at ₦1,353.97 per $1" without
//                          knowing how the rate is made up;
//  - `quoteLockedAt`,
//    `quoteExpiresAt`:     the quote lock (how long the price holds).
//
// Do not add a snapshot field here without deciding that clients may see it.
// test/consultations/client-consultation-allow-list.test.ts and
// test/payment-requests/client-payment-request-allow-list.test.ts pin the
// output and search every client response for the hidden values.

import type { Timestamp } from "firebase-admin/firestore";
import type { ChargeSnapshot, CurrencyCode, QuoteLock } from "../types/money";
import { getCurrencyInfo, minorUnitFactor } from "./currencies";
import { RATE_SCALE } from "./money";
import { PRICE_CURRENCY } from "./usd-price";

/**
 * The charge fields a payer may see, in the order they are written. Exported
 * so the allow-list tests assert against the same list.
 */
export const CLIENT_CHARGE_FIELDS = [
  "priceUsdCents",
  "chargedCurrency",
  "chargedAmountMinor",
  "effectiveRate",
  "quoteLockedAt",
  "quoteExpiresAt",
] as const;

/** The payer's view of a charge. Every field is present only when stored (or, for the rate, computable). */
export interface ClientChargeFields {
  /** The price as set by the agent, in US cents (0 = a free booking). */
  priceUsdCents?: number;
  /** The currency the client is (to be) charged in. */
  chargedCurrency?: CurrencyCode;
  /** The amount charged, in minor units of `chargedCurrency`. */
  chargedAmountMinor?: number;
  /**
   * Local MAJOR units per 1 USD that the client actually pays: amount
   * charged ÷ dollar price, markup included, rounded half up to 6 decimals
   * (the precision rates are held to). 1 when the charge is in USD. Absent
   * when there is no complete, positive charge to divide.
   */
  effectiveRate?: number;
  /** When the price was locked (server clock). */
  quoteLockedAt?: Timestamp;
  /** After this the locked price may no longer be charged. */
  quoteExpiresAt?: Timestamp;
}

/** A positive safe integer (minor units that can be divided). */
function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/**
 * The rate the payer effectively pays: local major units per 1 USD.
 *
 *   effectiveRate = (chargedAmountMinor / 10^localExp) / (priceUsdCents / 10^usdExp)
 *
 * Worked out with integers (BigInt) from the two STORED amounts only, then
 * rounded half up to `RATE_SCALE` (6) decimals, once. The raw rate and the
 * margin are never read, so nothing here can leak them. Because the stored
 * amount charged was itself rounded to a minor unit, this is the rate that
 * reproduces the charge, not the exact "raw rate x (1 + margin)".
 *
 * @param c - A record carrying a charge snapshot (booking, payment request)
 * @returns The rate, or undefined when the record has no complete, positive
 *   charge in a currency the money table knows
 */
export function effectiveRateOf(c: Partial<ChargeSnapshot>): number | undefined {
  // Both amounts must be whole, positive minor units: no free booking (0),
  // no corrupt value, nothing to divide by zero.
  if (!isPositiveInteger(c.chargedAmountMinor) || !isPositiveInteger(c.priceUsdCents)) return undefined;
  // The exponent of the charged currency comes from the ONE currency table.
  if (typeof c.chargedCurrency !== "string" || !getCurrencyInfo(c.chargedCurrency)) return undefined;

  const scale = 10n ** BigInt(RATE_SCALE);
  // charged major / usd major, scaled by 10^6:
  //   (chargedMinor / localFactor) / (usdCents / usdFactor) * 10^6
  const numerator = BigInt(c.chargedAmountMinor) * minorUnitFactor(PRICE_CURRENCY) * scale;
  const denominator = BigInt(c.priceUsdCents) * minorUnitFactor(c.chargedCurrency);
  // Half up: add half the denominator, then floor-divide (all values > 0).
  const scaled = (numerator * 2n + denominator) / (denominator * 2n);
  const rate = Number(scaled) / Number(scale);
  // An absurd stored pair must not become a rate (Number() of a huge BigInt).
  return Number.isFinite(rate) && rate > 0 ? rate : undefined;
}

/**
 * Project a record's stored charge onto what its payer may see.
 *
 * Every output field is named and copied one by one; nothing is spread from
 * the record, so the raw rate, its date and source, and the margin cannot
 * reach the result (nor can a snapshot field added later). A field is only
 * set when the record has it, so absent stays absent in JSON.
 *
 * @param c - A record carrying a charge snapshot and, maybe, a quote lock
 * @returns The payer-safe charge fields
 */
export function clientChargeFields(c: Partial<ChargeSnapshot> & Partial<QuoteLock>): ClientChargeFields {
  const out: ClientChargeFields = {};
  // The dollar price (also on a free booking, as 0).
  if (c.priceUsdCents !== undefined) out.priceUsdCents = c.priceUsdCents;
  // What is charged, in its own currency.
  if (c.chargedCurrency !== undefined) out.chargedCurrency = c.chargedCurrency;
  if (c.chargedAmountMinor !== undefined) out.chargedAmountMinor = c.chargedAmountMinor;
  // The ONLY rate a payer sees: derived from the two amounts above.
  const effectiveRate = effectiveRateOf(c);
  if (effectiveRate !== undefined) out.effectiveRate = effectiveRate;
  // The quote lock: when it was priced and until when the price holds.
  if (c.quoteLockedAt !== undefined) out.quoteLockedAt = c.quoteLockedAt;
  if (c.quoteExpiresAt !== undefined) out.quoteExpiresAt = c.quoteExpiresAt;
  return out;
}
