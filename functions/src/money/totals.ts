import type { CurrencyCode } from "../types/money";
import { normalizeCurrencyCode } from "./currencies";

// ============================================
// PER-CURRENCY TOTALS (issue #282)
// ============================================
//
// Money totals (transaction stats, analytics revenue) are reported PER
// CURRENCY. Amounts in different currencies are never added together: a
// kobo amount and a US-cent amount summed into one number means nothing.
// These helpers are the one place that buckets amounts by currency, so every
// total in the API follows the same rules:
//  - every amount is an integer in MINOR units of its own currency
//    (kobo for NGN, cents for USD);
//  - a currency code is normalised ("ngn " -> "NGN") before bucketing, so
//    two spellings of one code never become two buckets;
//  - output lists are sorted by currency code, so responses are stable and
//    tests can compare them exactly.

/**
 * Currency assumed for a transaction stored WITHOUT a usable currency code.
 * Every transaction written before the dollar pricing work (#178) was a
 * naira charge (Paystack NGN in kobo), so a missing code means NGN. Every
 * transaction written today carries an explicit code.
 */
export const LEGACY_TRANSACTION_CURRENCY: CurrencyCode = "NGN";

/**
 * Currency assumed for an application's `amountPaid` when the application has
 * no `costCurrency`. See the `Application.totalCost` comment in types/index.ts:
 * an application stored before #181 was always priced from `baseCostUsd`, so
 * its amounts are US cents.
 */
export const LEGACY_APPLICATION_CURRENCY: CurrencyCode = "USD";

/** One amount in one currency, in minor units of that currency. */
export interface CurrencyAmount {
  /** ISO 4217 code, upper case ("NGN", "USD"). */
  currency: CurrencyCode;
  /** Integer minor units of `currency`. */
  amount: number;
}

/**
 * Normalise a stored currency code, falling back to `fallback` when the value
 * is missing or not a 3-letter code (legacy rows).
 */
export function currencyOrDefault(input: unknown, fallback: CurrencyCode): CurrencyCode {
  return normalizeCurrencyCode(input) ?? fallback;
}

/**
 * A running set of per-currency sums. `add` puts an amount in its currency's
 * bucket only; nothing ever crosses buckets.
 */
export class CurrencyBuckets {
  /** currency code -> running sum in minor units of that currency. */
  private readonly sums = new Map<CurrencyCode, number>();

  /**
   * Add `amount` (minor units) to the bucket of `currency`. Creates the
   * bucket at 0 first, so a currency that only ever saw 0 still appears.
   */
  add(currency: CurrencyCode, amount: number): void {
    this.sums.set(currency, (this.sums.get(currency) ?? 0) + amount);
  }

  /** Make sure `currency` has a bucket (at 0 when new) without adding to it. */
  touch(currency: CurrencyCode): void {
    if (!this.sums.has(currency)) this.sums.set(currency, 0);
  }

  /** The sum for one currency (0 when the currency has no bucket). */
  get(currency: CurrencyCode): number {
    return this.sums.get(currency) ?? 0;
  }

  /** Every currency that has a bucket, sorted by code. */
  currencies(): CurrencyCode[] {
    return Array.from(this.sums.keys()).sort();
  }

  /** The buckets as a list sorted by currency code. */
  toList(): CurrencyAmount[] {
    return this.currencies().map((currency) => ({ currency, amount: this.get(currency) }));
  }
}

/**
 * Sorted union of the currencies of several bucket sets (for example the
 * current and the previous period of a KPI), so a currency that only appears
 * in one of them still gets a row.
 */
export function unionCurrencies(...sets: CurrencyBuckets[]): CurrencyCode[] {
  const all = new Set<CurrencyCode>();
  for (const set of sets) for (const c of set.currencies()) all.add(c);
  return Array.from(all).sort();
}
