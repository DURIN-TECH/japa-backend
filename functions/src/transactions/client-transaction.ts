// ============================================
// Client transaction projection (issue #329)
// ============================================
//
// GET /transactions answers a CLIENT (the payer) with `ClientTransaction`,
// never with the raw Firestore `Transaction` document. The stored document is
// the shape agents, owners and admins work with, and it carries things a
// paying client must not see:
//  - `fxMarginBps`: Seli's exchange-rate markup;
//  - `fxRate` / `fxRateAsOf` / `fxRateSource`: the raw (mid-market) rate the
//    markup was added to. Together with the charged amount it gives the
//    markup away, so it is hidden too;
//  - `agentId`, `metadata.agentProfileId`: internal agent ids;
//  - `providerTransactionId`, `metadata.reference`: Paystack references;
//  - settlement bookkeeping (`paidAfterQuoteExpiry`,
//    `paidOnSupersededReference`, `isEscrow`, ...).
//
// `toClientTransaction` is a field-by-field ALLOW-LIST, like
// `toPublicAgent` (agents/public-agent.ts). Do not rewrite it as
// `{ ...txn }` or "omit these keys": a new `Transaction` field must stay
// hidden from clients until it is added here deliberately.
// test/transactions/client-transaction-allow-list.test.ts pins the key set
// and fails when a stored field (known or brand new) reaches the response.
//
// What a receipt needs is all here: what was charged (`amountCharged`), the
// dollar price behind it (`priceUsd`) and so the client's EFFECTIVE rate
// ("$6.00 at ₦1,353.97 per $1" = amount charged ÷ dollar price). That rate
// already includes the markup; showing it is fine, splitting it is not.

import type { Timestamp } from "firebase-admin/firestore";
import type { Transaction, TransactionStatus, TransactionType } from "../types";
import type { CurrencyCode, Money } from "../types/money";
import { transactionCurrency } from "../money/totals";
import { PRICE_CURRENCY } from "../money/usd-price";

/**
 * The exact key set of a client transaction response. Exported so tests
 * assert against the same list. Keys marked optional on `ClientTransaction`
 * appear only when the stored row has them.
 */
export const CLIENT_TRANSACTION_FIELDS = [
  "id",
  "type",
  "status",
  "description",
  "visaTypeName",
  "amountCharged",
  "priceUsd",
  "amount",
  "currency",
  "priceUsdCents",
  "paymentProvider",
  "applicationId",
  "consultationId",
  "createdAt",
  "paidAt",
] as const;

/**
 * One payment as its payer may see it (GET /transactions, client scope).
 * Timestamps are passed through as stored, so they serialize exactly as they
 * did before #329.
 */
export interface ClientTransaction {
  /** The transaction's document id. */
  id: string;
  /** What kind of payment this is (consultation fee, payment-request charge, refund...). */
  type: TransactionType;
  /** Where the payment stands. */
  status: TransactionStatus;
  /** Human-readable label ("Consultation fee", "Escrow release for: ..."). */
  description: string;
  /** The visa / service name, when the row carries one. */
  visaTypeName?: string;

  /** The amount actually charged, in minor units of its own currency. */
  amountCharged: Money;
  /**
   * The dollar price behind the charge (`currency: "USD"`, US cents). Absent
   * on a legacy row that was never priced in dollars. Amount charged ÷ this
   * is the client's effective rate (markup included).
   */
  priceUsd?: Money;

  // ---- Flat copies of the two figures above ----
  // The mobile Payments screen (seli-mobile liveTransactions.ts) reads
  // `amount` + `currency` and `priceUsdCents` directly, as it did when the
  // whole document was returned. They repeat `amountCharged` / `priceUsd`
  // and add nothing a client could not already see there.
  /** Same as `amountCharged.amountMinor`. */
  amount: number;
  /** Same as `amountCharged.currency`. */
  currency: CurrencyCode;
  /** Same as `priceUsd.amountMinor`; absent when `priceUsd` is. */
  priceUsdCents?: number;

  /**
   * Which processor took the payment ("paystack", "manual"...). The app
   * turns it into the payment-method label. The provider's name only: no
   * reference, id or other provider data is returned.
   */
  paymentProvider: Transaction["paymentProvider"];

  /** The client's case (application) this payment belongs to, if any. */
  applicationId?: string;
  /** The consultation booking this payment is the fee of, if any. */
  consultationId?: string;

  /** When the transaction was recorded. */
  createdAt: Timestamp;
  /** When the processor took the payment (consultation fees record it). */
  paidAt?: Timestamp;
}

/**
 * Whether a stored `priceUsdCents` is a usable dollar price: a safe integer
 * of US cents, zero or more. Anything else (absent, a string, a fraction,
 * NaN) is treated as "no dollar price" rather than passed on.
 */
function isUsableUsdCents(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Project a stored transaction onto the client allow-list.
 *
 * Every output field is named and copied one by one. Nothing is spread from
 * the stored document, so a field that is not written below (existing or
 * added later, top-level or inside `metadata`) cannot reach a client.
 * Optional fields are only set when present, so absent stays absent in JSON.
 *
 * Money is not converted or recomputed: `amountCharged` is the stored
 * `amount` in the row's own `currency` (a legacy row with no code counts as
 * NGN, the same rule the stats use), and `priceUsd` is the stored
 * `priceUsdCents`.
 *
 * @param txn - The full stored transaction (the caller's own row)
 * @returns The payer-safe view of that transaction
 */
export function toClientTransaction(txn: Transaction): ClientTransaction {
  // The row's currency, with the legacy "no code = NGN" rule applied once so
  // the Money and its flat copy can never disagree.
  const currency = transactionCurrency(txn);

  const out: ClientTransaction = {
    id: txn.id,
    type: txn.type,
    status: txn.status,
    description: txn.description,
    amountCharged: { amountMinor: txn.amount, currency },
    amount: txn.amount,
    currency,
    paymentProvider: txn.paymentProvider,
    createdAt: txn.createdAt,
  };

  // Service name, when denormalized onto the row.
  if (txn.visaTypeName !== undefined) out.visaTypeName = txn.visaTypeName;

  // The dollar price. Only this one figure is taken from the charge
  // snapshot: the rate, its source and date, and the margin stay behind.
  if (isUsableUsdCents(txn.priceUsdCents)) {
    out.priceUsd = { amountMinor: txn.priceUsdCents, currency: PRICE_CURRENCY };
    out.priceUsdCents = txn.priceUsdCents;
  }

  // What the payment was for: the client's own case or booking.
  if (txn.applicationId !== undefined) out.applicationId = txn.applicationId;
  if (txn.consultationId !== undefined) out.consultationId = txn.consultationId;

  // Paystack's payment time (recorded on consultation fees, issue #180).
  if (txn.paystackPaidAt !== undefined) out.paidAt = txn.paystackPaidAt;

  return out;
}
