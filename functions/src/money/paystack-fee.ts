// ============================================
// Paystack's fee on a consultation payment (issue #395)
// ============================================
//
// Decision (user, 2026-11-17): on a normal paid consultation the AGENT pays
// Paystack's processing fee. The client still pays the listed price (the
// Paystack account does not pass fees on), so for one Paystack reference:
//
//   A = what the client was charged (the fee Transaction's `amount`)
//   F = Paystack's own `fees` for that reference, in the SAME currency
//   the agent is credited A - F; Seli's total for the reference is 0.
//
// THE RULES (all pure, shared by the settle path, the balances, revenue,
// the scheduled lookup, the admin refresh and the refund engine):
//  - F comes ONLY from Paystack's report for that reference (`fees`), and
//    only when it is a safe integer >= 0 (`isWellFormedFee`) AND the report's
//    currency is the charge currency. Anything else is UNKNOWN: never
//    estimated, never a computed rate, never a default of 0;
//  - unknown F: the booking is still confirmed (the client paid), the fee
//    Transaction is written with A and `paystackFeeStatus: "unknown"`, and it
//    is credited NOWHERE (held, available and revenue all ignore it) until a
//    later lookup finds F;
//  - F >= A: the credit would be zero or negative, so it is treated like
//    unknown for crediting (stored, credited nowhere, listed for an admin),
//    with status "fee_not_less_than_amount";
//  - a LEGACY row (written before #395: no `paystackFeeStatus`) keeps
//    counting as A. No backfill (no real-money bookings yet).
//
// Kept free of service imports so the money modules (totals.ts) and the
// services can all use it without a load-time cycle.

import type { PaystackFeeStatus, Transaction } from "../types";

/**
 * Issue #354: whether a reported Paystack fee can be used as money: a safe
 * integer of minor units, zero or more. `null`, a negative number, a
 * fraction, NaN, a numeric string ("150") are all NOT usable. Pure.
 *
 * Defined here since #395 (so money/ code can use it with no service
 * import) and re-exported from services/billing/paystack.provider.ts, where
 * #354 put it.
 */
export function isWellFormedFee(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** What Paystack's report says about the fee of one charge (issue #395). */
export type PaystackFeeClassification =
  /** A usable fee below the charge: the agent is credited A - F. */
  | { status: "known"; feeMinor: number }
  /** No usable fee in the charge currency: credited nowhere until known. */
  | { status: "unknown" }
  /** A usable fee of the whole charge or more: stored, credited nowhere. */
  | { status: "fee_not_less_than_amount"; feeMinor: number };

/**
 * Classify Paystack's fee for one charge of `amountMinor` in `currency`
 * (issue #395). Pure.
 *
 * @param amountMinor A, what the client was charged (minor units)
 * @param currency the charge currency (upper-case ISO code)
 * @param reported Paystack's report for the reference (`fees` and
 *   `currency`, as `toTransactionLookup` parses them), or null when there is
 *   none. A fee reported in another currency cannot be this charge's: unknown.
 */
export function classifyPaystackFee(
  amountMinor: number,
  currency: string,
  reported: { fees?: unknown; currency?: unknown } | null | undefined
): PaystackFeeClassification {
  if (!reported || reported.currency !== currency || !isWellFormedFee(reported.fees)) return { status: "unknown" };
  const feeMinor = reported.fees;
  return feeMinor < amountMinor ? { status: "known", feeMinor } : { status: "fee_not_less_than_amount", feeMinor };
}

/**
 * The fee fields to store on a consultation fee Transaction for a
 * classification (issue #395). Pure. "known" also stores the agent's credit
 * (A - F) for the agent-side views; "unknown" stores no fee at all.
 */
export function paystackFeeFields(
  amountMinor: number,
  classification: PaystackFeeClassification
): Pick<Transaction, "paystackFeeStatus" | "paystackFeeMinor" | "agentCreditMinor"> {
  switch (classification.status) {
  case "known":
    return {
      paystackFeeStatus: "known",
      paystackFeeMinor: classification.feeMinor,
      agentCreditMinor: amountMinor - classification.feeMinor,
    };
  case "fee_not_less_than_amount":
    return { paystackFeeStatus: "fee_not_less_than_amount", paystackFeeMinor: classification.feeMinor };
  case "unknown":
  default:
    return { paystackFeeStatus: "unknown" };
  }
}

/**
 * What a consultation fee Transaction credits the agent, in minor units of
 * its currency, or null when it credits NOTHING (issue #395). Pure. The ONE
 * rule the held / available balances (computeStats), revenue
 * (`revenueEffect`, so analytics too) and the refund engine use:
 *  - legacy row (no `paystackFeeStatus`, written before #395): A;
 *  - "known" with a well-formed fee below A: A - F;
 *  - anything else ("unknown", "fee_not_less_than_amount", or a "known" row
 *    whose stored fee is not usable, i.e. bad data): null. Failing closed:
 *    money we cannot work out is never credited.
 *
 * @param txn the stored fee Transaction (only `amount`, `paystackFeeStatus`
 *   and `paystackFeeMinor` are read)
 */
export function consultationFeeCredit(
  txn: Pick<Transaction, "amount"> & Partial<Pick<Transaction, "paystackFeeStatus" | "paystackFeeMinor">>
): number | null {
  const status: PaystackFeeStatus | undefined = txn.paystackFeeStatus;
  if (status === undefined) return txn.amount;
  if (status === "known" && isWellFormedFee(txn.paystackFeeMinor) && txn.paystackFeeMinor < txn.amount) {
    return txn.amount - txn.paystackFeeMinor;
  }
  return null;
}

/**
 * Issue #413 (D): whether a fee status means "Paystack's fee is not known
 * yet": "unknown", or "set_aside" (an unknown row the scheduled job stopped
 * picking). Both count EXACTLY alike everywhere (credited nowhere, nothing
 * guessed); only the job's query tells them apart. Pure.
 */
export function isUnresolvedFeeStatus(status: PaystackFeeStatus | undefined): boolean {
  return status === "unknown" || status === "set_aside";
}

/**
 * Whether a consultation fee Transaction is waiting for Paystack's fee, so a
 * lookup (the scheduled job, an admin refresh, a refund) may store it
 * (issue #395). Only "unknown" rows (and, issue #413 D, "set_aside" ones,
 * which the admin refresh and a refund still resolve): a known fee is never
 * overwritten, and a legacy row keeps counting as A. Pure.
 */
export function awaitsPaystackFee(txn: Pick<Transaction, "type"> & Partial<Pick<Transaction, "paystackFeeStatus">>): boolean {
  return txn.type === "consultation_fee" && isUnresolvedFeeStatus(txn.paystackFeeStatus);
}
