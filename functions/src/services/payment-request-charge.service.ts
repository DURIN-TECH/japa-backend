import type { Money } from "../types/money";
import type { PaymentRequest } from "../types";
import { collections } from "../utils/firebase";
import { readStoredUsd } from "../money/usd-price";
import { formatWithCode, makeMoney } from "../money/money";
import { isMoneyError } from "../money/errors";
import {
  awaitRecordCheckoutState,
  chargeCurrencyForPayer,
  CheckoutTarget,
  hasChargeSnapshot,
  issueRecordCheckout,
  LockedCharge,
  lockQuote,
  newPrefixedReference,
  RecordCheckoutState,
} from "./charge-checkout.service";

// ============================================
// PAYMENT REQUEST CHARGING (issue #181)
// ============================================
//
// An agent asks a client for a payment in US DOLLARS; the client pays the
// local-currency amount worked out on the SERVER at the rate of the moment
// the checkout starts. This file is the payment-request side of the shared
// charge machinery (charge-checkout.service.ts, built for consultations in
// #180):
//
//  1. CREATE (POST /payment-requests): the dollar price is stored as
//     `priceUsd` (Money, USD) and mirrored in `amount` (US cents) +
//     `currency: "USD"`. Nothing is quoted yet.
//  2. APPROVE (PUT /payment-requests/:id/approve, the client): the price is
//     quoted with the #178 `quote()` in the client's charge currency (from
//     their profile country, never the request) and LOCKED for
//     QUOTE_LOCK_MINUTES. No usable rate -> 503 before anything is written.
//     The checkout then opens race-safely (claim -> open -> publish) under a
//     reference WE generate (`preq-<id>-<uuid>`), and the snapshot is stored
//     on the request in the claim's transaction.
//  3. RE-ISSUE (POST /payment-requests/:id/checkout, issue #152): inside the
//     lock the same checkout is returned; after it a FRESH quote of the same
//     dollar price in the same charge currency, a new lock, a new checkout.
//     Never while Paystack reports the current checkout in progress (409
//     PAYMENT_IN_PROGRESS), and the replaced reference is kept with its own
//     snapshot in `supersededCheckouts`. Only an UNPAID (`approved`) request
//     can be re-quoted: the claim refuses a paid one, so once paid the
//     snapshot is immutable.
//  4. SETTLE (payment-request-settlement.service.ts): exact amount and
//     currency against what the paid checkout asked; one Transaction ever.
//
// LEGACY requests (before #181: `amount` in kobo, `currency: "NGN"`, no
// `priceUsd`, no snapshot) are never quoted or rewritten: approve opens a
// naira checkout for their own stored amount, as before, and they settle
// against that amount.

// ============================================
// 1. What kind of request is this, and what does it charge?
// ============================================

/** True for a request created from #181 on: it carries a valid dollar `priceUsd`. */
export function isUsdPaymentRequest(r: Partial<PaymentRequest>): boolean {
  const usd = readStoredUsd(r.priceUsd);
  return !!usd && usd.amountMinor > 0;
}

/** The dollar price of a #181 request, or null for a legacy one. */
export function requestPriceUsd(r: Partial<PaymentRequest>): Money | null {
  const usd = readStoredUsd(r.priceUsd);
  return usd && usd.amountMinor > 0 ? usd : null;
}

/**
 * What a LEGACY request charges: its own stored `amount` in its own stored
 * `currency` (kobo / "NGN" for every legacy row), checked through the
 * currency table. Null when the stored values are not valid money.
 */
export function legacyRequestCharge(r: Partial<PaymentRequest>): Money | null {
  if (typeof r.amount !== "number" || r.amount <= 0) return null;
  try {
    // A legacy row with no currency was always naira (the old default).
    return makeMoney(r.amount, typeof r.currency === "string" && r.currency ? r.currency : "NGN");
  } catch (err) {
    if (isMoneyError(err)) return null;
    throw err;
  }
}

/**
 * What Paystack must report it charged for the request's CURRENT checkout:
 *  - a #181 request: exactly the stored `chargedAmountMinor` in `chargedCurrency`
 *    (null until a checkout has priced it);
 *  - a legacy request: its own stored `amount` / `currency`, never re-priced.
 */
export function expectedRequestCharge(r: Partial<PaymentRequest>): Money | null {
  if (isUsdPaymentRequest(r)) {
    return hasChargeSnapshot(r) ? { amountMinor: r.chargedAmountMinor!, currency: r.chargedCurrency! } : null;
  }
  return legacyRequestCharge(r);
}

// ============================================
// 2. Copy: the amount in words, with explicit currency codes
// ============================================

/**
 * The amount of a request for notifications, emails and messages, always
 * with ISO codes (never a bare "₦" or "$"):
 *  - a #181 request: the dollar price, plus the local amount once a checkout
 *    has priced it: "USD 100.00 (NGN 150,000.00)";
 *  - a legacy request: its own amount in its own currency: "NGN 25,000.00".
 * Falls back to the bare stored number and currency if the stored values are
 * not valid money, so copy never throws.
 */
export function describeRequestAmount(r: Partial<PaymentRequest>): string {
  const usd = requestPriceUsd(r);
  if (usd) {
    const price = formatWithCode(usd);
    if (hasChargeSnapshot(r) && r.chargedCurrency !== "USD") {
      return `${price} (${formatWithCode({ amountMinor: r.chargedAmountMinor!, currency: r.chargedCurrency! })})`;
    }
    return price;
  }
  const legacy = legacyRequestCharge(r);
  if (legacy) return formatWithCode(legacy);
  return `${r.amount ?? 0} ${r.currency ?? ""}`.trim();
}

/**
 * What the agent and the client see of a request's charge (the API
 * response adds this next to the stored fields): the dollar price and, once
 * priced, the local amount charged and the rate. Built from stored values
 * only.
 */
export function requestChargeSummary(r: PaymentRequest): Record<string, unknown> {
  return {
    legacy: !isUsdPaymentRequest(r),
    priceUsd: requestPriceUsd(r),
    charge: expectedRequestCharge(r),
    amountDisplay: describeRequestAmount(r),
  };
}

// ============================================
// 3. Pricing and opening a checkout
// ============================================

/**
 * A new Paystack reference for one checkout of a request
 * (`preq-<id>-<uuid>`). Ours, so it is stored BEFORE the checkout opens.
 */
export function newPaymentRequestReference(paymentRequestId: string): string {
  return newPrefixedReference("preq", paymentRequestId);
}

/**
 * How a payment request is charged (see CheckoutTarget in
 * charge-checkout.service.ts): its reference is `paystackReference`,
 * "awaiting payment" is `approved`, and only a #181 dollar request is ever
 * quoted (a legacy one is not chargeable through this path). A first pricing
 * passes a fresh quote; a request with no quote and none passed is not
 * chargeable.
 */
export const paymentRequestTarget: CheckoutTarget<PaymentRequest> = {
  doc: (id) => collections.paymentRequests.doc(id),
  referenceField: "paystackReference",
  currentReference: (r) => r.paystackReference ?? null,
  isPaid: (r) => r.status === "paid",
  isAwaitingPayment: (r) => r.status === "approved",
  isChargeable: (r, charge) => isUsdPaymentRequest(r) && (charge !== null || hasChargeSnapshot(r)),
  newReference: newPaymentRequestReference,
  metadata: (id) => ({ purpose: "payment_request", paymentRequestId: id }),
};

/** Where a request's checkout stands (the shared state, with the record named `paymentRequest`). */
export type PaymentRequestCheckoutState =
  | { kind: "checkout"; authorizationUrl: string; reference: string; paymentRequest: PaymentRequest; opened: boolean }
  | { kind: "paid"; paymentRequest: PaymentRequest }
  | { kind: "not_payable"; paymentRequest: PaymentRequest | null }
  | { kind: "opening"; paymentRequest: PaymentRequest };

/** Rename the shared state's `record` to `paymentRequest`. */
function asRequestState(s: RecordCheckoutState<PaymentRequest>): PaymentRequestCheckoutState {
  switch (s.kind) {
  case "checkout":
    return { kind: "checkout", authorizationUrl: s.authorizationUrl, reference: s.reference, paymentRequest: s.record, opened: s.opened };
  case "paid":
    return { kind: "paid", paymentRequest: s.record };
  case "opening":
    return { kind: "opening", paymentRequest: s.record };
  case "not_payable":
  default:
    return { kind: "not_payable", paymentRequest: s.record };
  }
}

/** Re-read a request until its checkout is usable (a caller that lost a checkout race). */
export async function awaitPaymentRequestCheckoutState(id: string): Promise<PaymentRequestCheckoutState> {
  return asRequestState(await awaitRecordCheckoutState(paymentRequestTarget, id));
}

/**
 * Price a #181 request for its client: a fresh quote of its dollar price
 * in the client's charge currency (from their stored profile country), with
 * a QUOTE_LOCK_MINUTES lock. Throws a MoneyError (the caller answers 503)
 * when no rate can price it; nothing is written here.
 */
export async function priceRequestForClient(r: PaymentRequest): Promise<LockedCharge> {
  const usd = requestPriceUsd(r);
  if (!usd) throw new Error("priceRequestForClient called on a legacy payment request");
  return lockQuote(usd, await chargeCurrencyForPayer(r.clientId));
}

/**
 * Open (or join) the checkout for a request, race-safely. `charge` is the
 * fresh quote to store with the new reference; the claim only goes on while
 * the request is still `approved`, unpaid, and carries `observedReference`.
 *
 * @throws the provider's `PAYSTACK_ERROR: ...` (the controller answers 502)
 */
export async function issuePaymentRequestCheckout(input: {
  request: PaymentRequest;
  observedReference: string | null;
  charge: LockedCharge;
  callbackUrl: string;
}): Promise<PaymentRequestCheckoutState> {
  const state = await issueRecordCheckout(paymentRequestTarget, {
    id: input.request.id,
    observedReference: input.observedReference,
    charge: input.charge,
    email: input.request.clientEmail,
    callbackUrl: input.request.checkoutCallbackUrl || input.callbackUrl,
    metadata: { applicationId: input.request.applicationId },
  });
  return asRequestState(state);
}

/**
 * Re-quote an unpaid #181 request after its lock passed (or after a checkout
 * that never opened): a FRESH quote of the SAME dollar price in the SAME
 * charge currency it was first priced in (the client is not re-resolved
 * mid-payment), a new lock and a new checkout. The caller must already know
 * Paystack reports the current checkout as `final_unpaid`.
 *
 * Throws a MoneyError (503) before any write or Paystack call when no rate
 * can price it, and the provider error (502) when Paystack fails.
 */
export async function reissuePaymentRequestCheckout(
  r: PaymentRequest,
  fallbackCallbackUrl: string
): Promise<PaymentRequestCheckoutState> {
  const usd = requestPriceUsd(r);
  if (!usd) return { kind: "not_payable", paymentRequest: r };
  const charge = r.chargedCurrency
    ? await lockQuote(usd, r.chargedCurrency)
    : await priceRequestForClient(r);
  return issuePaymentRequestCheckout({
    request: r,
    observedReference: r.paystackReference ?? null,
    charge,
    callbackUrl: fallbackCallbackUrl,
  });
}

