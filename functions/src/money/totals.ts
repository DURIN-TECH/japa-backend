import type { CurrencyCode } from "../types/money";
import type { Transaction, TransactionStatus } from "../types";
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

// ============================================
// SHARED REVENUE RULE (issue #282)
// ============================================
//
// ONE rule for what a transaction does to revenue, used by BOTH
// GET /transactions/stats (TransactionService.computeStats) and the analytics
// revenue figures (KPIs, trends), so the two can never disagree:
//
//  - a SETTLED transaction (status completed or released) of an incoming type
//    adds its amount to revenue. "released" is how a paid payment request is
//    stored (escrow_release), "completed" a consultation fee, and so on;
//  - a SETTLED transaction of type "refund" SUBTRACTS its amount from the
//    revenue of its own currency (money given back to a client). Revenue is
//    not clamped: a period with more refunds than charges shows a negative
//    figure. Only the available balance keeps its floor of 0;
//  - a charge whose own status is "refunded" is not settled, so it simply
//    drops out of revenue (that is how a refund is recorded today when no
//    separate refund transaction is written); a separate "refund"
//    transaction is a different record, so nothing is subtracted twice;
//  - a "withdrawal" is a payout to the agent, never revenue: it only reduces
//    the available balance of its own currency (see computeStats).

/** Statuses at which a transaction's money has actually moved. */
export const SETTLED_STATUSES: readonly TransactionStatus[] = ["completed", "released"];

/** Statuses of an incoming payment that is still on its way. */
export const PENDING_STATUSES: readonly TransactionStatus[] = [
  "pending",
  "processing",
  "held_in_escrow",
];

/** Whether a transaction's money has moved (completed or released). */
export function isSettled(txn: Pick<Transaction, "status">): boolean {
  return SETTLED_STATUSES.includes(txn.status);
}

/**
 * Signed effect of one transaction on revenue, in minor units of the
 * transaction's own currency: +amount for a settled incoming payment,
 * -amount for a settled refund, 0 otherwise (unsettled rows, withdrawals).
 */
export function revenueEffect(txn: Pick<Transaction, "type" | "status" | "amount">): number {
  if (txn.type === "withdrawal" || !isSettled(txn)) return 0;
  return txn.type === "refund" ? -txn.amount : txn.amount;
}

/**
 * Whether a transaction is an incoming payment still pending (counts toward
 * `pendingPayments` and the pending-clients count). Refunds and withdrawals
 * are outflows, so they are never pending payments.
 */
export function isPendingIncoming(txn: Pick<Transaction, "type" | "status">): boolean {
  if (txn.type === "withdrawal" || txn.type === "refund") return false;
  return PENDING_STATUSES.includes(txn.status);
}

/** The bucket currency of a transaction (a legacy row with no code = NGN). */
export function transactionCurrency(txn: Pick<Transaction, "currency">): CurrencyCode {
  return currencyOrDefault(txn.currency, LEGACY_TRANSACTION_CURRENCY);
}
