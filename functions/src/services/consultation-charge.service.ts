import { Timestamp } from "firebase-admin/firestore";
import type { CurrencyCode, Money } from "../types/money";
import type { Consultation, ConsultationPaymentException, Transaction } from "../types";
import { collections } from "../utils/firebase";
import { MAX_PRICE_USD_CENTS, readStoredUsd } from "../money/usd-price";
import { fromMajor } from "../money/money";
import { PaystackTransactionLookup } from "./billing/paystack.provider";
import { transactionService } from "./transaction.service";
// Issue #181: the charge machinery (pricing + lock, Paystack states, the
// exact-match check, the race-safe checkout) now lives in a module shared with
// payment requests. Everything this file used to export is still exported
// from here with the same behaviour.
import {
  awaitRecordCheckoutState,
  chargeCurrencyForPayer,
  chargeRuntime,
  checkAgainst,
  CheckoutTarget,
  hasChargeSnapshot,
  issueRecordCheckout,
  LockedCharge,
  lockQuote,
  matchPaidCheckout,
  newPrefixedReference,
  RecordCheckoutState,
  snapshotOf,
  supersededSwap,
} from "./charge-checkout.service";

export {
  CHECKOUT_WAIT_ATTEMPTS,
  ChargeCheck,
  checkAgainst,
  hasChargeSnapshot,
  isPricingFailure,
  isQuoteExpired,
  LockedCharge,
  lockQuote,
  PaystackState,
  paystackState,
  QUOTE_LOCK_MINUTES,
  reportedAskedAmount,
  snapshotOf,
} from "./charge-checkout.service";

// ============================================
// CONSULTATION CHARGING (issue #180, folds #166)
// ============================================
//
// How a consultation booking is priced, charged and confirmed. Shared by the
// guest booking (POST /agencies/public/:slug/consultations), the signed-in
// booking (POST /consultations), the retry (POST /consultations/:id/checkout)
// and the verify-on-return (POST /consultations/public/verify).
//
// THE RULES
//  1. The SERVER decides the price. It is read from the agency / agent record
//     (`consultationFeeUsd`, US dollars, issue #179). Any `fee`, `amount`,
//     `rate` or `currency` in a request body is never read.
//  2. Free ONLY when the stored fee is missing or a valid $0. Any other shape
//     (a string amount, a lower-case "usd", a leftover naira `consultationFee`
//     of any type, an amount over the price cap) is MALFORMED and the booking
//     is refused with 503: never booked free, never guessed.
//  3. A paid booking is priced with the #178 `quote()` at the current
//     effective rate in the client's charge currency (resolved on the server:
//     the signed-in client's profile country, or the default currency for an
//     anonymous guest). RATE_STALE / RATE_UNAVAILABLE / an unsupported or
//     disabled currency / a price that converts to zero all fail with a typed
//     MoneyError, which the controller answers 503 PRICING_UNAVAILABLE BEFORE
//     any Paystack call.
//  4. The quote is LOCKED on the booking: the ChargeSnapshot plus
//     `quoteLockedAt` and `quoteExpiresAt` (QUOTE_LOCK_MINUTES later). Inside
//     the lock a retry returns the same checkout. After it, a verify or retry
//     re-prices with a FRESH quote and opens a new checkout; a stale snapshot
//     is never charged again. Review fixes: the re-price is decided and
//     stored inside a Firestore transaction under a reference WE generate
//     (section 3), never while Paystack reports the current checkout as in
//     progress (409 PAYMENT_IN_PROGRESS), and the replaced reference is kept
//     with its own snapshot in `supersededCheckouts`.
//  5. Paystack receives `amount = chargedAmountMinor` and `currency =
//     chargedCurrency` exactly as stored. On return, what Paystack reports it
//     charged must equal the stored amount AND currency, or nothing is
//     confirmed or recorded. An exact payment on the booking's CURRENT
//     reference is honoured even when it lands after the lock, and flagged
//     `paidAfterQuoteExpiry` for review: the lock governs ISSUING a checkout,
//     not honouring one we already issued. An exact payment on a SUPERSEDED
//     reference settles a still-unpaid booking at that reference's own
//     snapshot (`paidOnSupersededReference`); on an already-paid booking it is
//     recorded in `consultationPaymentExceptions` for refund, never as a
//     second Transaction. The amount compared is Paystack's
//     `requested_amount` when reported (fees passed to the customer inflate
//     `amount`), else `amount`.
//  6. Confirmation is ONE Firestore transaction (settlePayment): re-read the
//     booking, and if it is not paid yet flip it to paid/scheduled and write
//     the fee Transaction in the same commit. A second verify finds it paid
//     and writes nothing.
//  7. LEGACY bookings (before #180: `fee` in whole naira, no snapshot) are
//     never re-priced: they verify against `fee` read as NGN through the
//     currency table, and display as naira.



// ============================================
// Swappable dependencies (tests inject in-memory ones)
// ============================================

/**
 * Where the charge path gets its rate service, the client's profile country,
 * the clock and the Firestore transaction runner. Since issue #181 this IS
 * the shared `chargeRuntime` (charge-checkout.service.ts): the same object,
 * so a test that stubs `consultationCharging` (test/consultations/harness.ts)
 * stubs every charge path, payment requests included.
 */
export const consultationCharging = chargeRuntime;

// ============================================
// 1. The stored fee: free, paid, or malformed
// ============================================

/** What a stored agency / agent fee means for a booking. */
export type StoredFee =
  /** No fee set, or a valid $0: book without Paystack. */
  | { kind: "free" }
  /** A valid positive dollar fee: price it and charge it. */
  | { kind: "paid"; usd: Money }
  /** Anything else: refuse the booking (503), never book it free. */
  | { kind: "malformed"; reason: string };

/**
 * Classify the fee stored on an agency or agent doc (rule 2 in the header).
 * Pure.
 *
 * @param doc the agency or agent record as read from Firestore. Only
 *   `consultationFeeUsd` (the #179 dollar Money) and the old naira
 *   `consultationFee` are looked at.
 */
export function classifyStoredFee(doc: { consultationFeeUsd?: unknown; consultationFee?: unknown }): StoredFee {
  // A leftover naira fee of ANY type (number, string, map) means the doc was
  // never migrated, or was edited by hand: we cannot know the dollar price.
  // `null` is treated as absent, matching the #179 migration.
  if (doc.consultationFee !== undefined && doc.consultationFee !== null) {
    return { kind: "malformed", reason: "leftover naira consultationFee" };
  }
  const raw = doc.consultationFeeUsd;
  // Missing (or cleared with null) = no fee set = free.
  if (raw === undefined || raw === null) return { kind: "free" };
  // readStoredUsd accepts ONLY { amountMinor: safe integer >= 0, currency: "USD" }.
  const usd = readStoredUsd(raw);
  if (!usd) return { kind: "malformed", reason: "consultationFeeUsd is not a valid USD amount" };
  // Above the cap no API could have written it: a hand edit or corruption.
  if (usd.amountMinor > MAX_PRICE_USD_CENTS) {
    return { kind: "malformed", reason: "consultationFeeUsd is above the price cap" };
  }
  return usd.amountMinor === 0 ? { kind: "free" } : { kind: "paid", usd };
}


// ============================================
// 2. Pricing: quote + lock (shared since #181)
// ============================================

/**
 * The charge currency for a booking, resolved on the SERVER only:
 *  - a signed-in client (`uid`): their stored profile country (the #178
 *    `resolveChargeCurrency` rules; an unmapped country gets the default);
 *  - an anonymous guest (no `uid`): the config's default currency. A guest's
 *    typed email is NOT used to look up a country: that would tell an
 *    anonymous caller which country an account holder lives in, and the
 *    public page already shows the price in the default currency.
 */
export async function chargeCurrencyFor(uid: string | undefined): Promise<CurrencyCode> {
  return chargeCurrencyForPayer(uid);
}

/**
 * What Paystack must report it charged for this booking, or null when the
 * booking has nothing chargeable:
 *  - a #180 booking: exactly the stored `chargedAmountMinor` in `chargedCurrency`;
 *  - a LEGACY booking: its whole-naira `fee` as NGN, converted through the
 *    currency table (never `* 100` by hand), never re-priced.
 */
export function expectedCharge(c: Partial<Consultation>): Money | null {
  if (hasChargeSnapshot(c)) return { amountMinor: c.chargedAmountMinor!, currency: c.chargedCurrency! };
  if (typeof c.fee === "number" && c.fee > 0) {
    try {
      return fromMajor(c.fee, "NGN");
    } catch {
      return null; // a fractional / corrupt legacy fee: nothing we can verify against
    }
  }
  return null;
}

// ============================================
// 3. Opening a checkout (race-safe, issue #180 review fix)
// ============================================
//
// The claim -> open -> publish machinery is shared (charge-checkout.service.ts,
// section 4). This is the consultation side of it: where a booking lives,
// that its reference is `transactionId`, that "awaiting payment" means
// `status === "pending_payment"`, and that only a #180-priced booking (a
// well-formed snapshot) can be charged.

/**
 * A new Paystack reference for one checkout of a booking (`cons-<id>-<uuid>`).
 * Ours, not Paystack's, so it can be stored BEFORE the checkout is opened.
 */
export function newCheckoutReference(consultationId: string): string {
  return newPrefixedReference("cons", consultationId);
}

/** How a consultation booking is charged (see CheckoutTarget). */
const consultationTarget: CheckoutTarget<Consultation> = {
  doc: (id) => collections.consultations.doc(id),
  referenceField: "transactionId",
  currentReference: (c) => c.transactionId ?? null,
  isPaid: (c) => c.paymentStatus === "paid",
  isAwaitingPayment: (c) => c.status === "pending_payment",
  // A booking is charged from its own stored snapshot (also on a re-price,
  // which only ever starts from a priced booking).
  isChargeable: (c) => hasChargeSnapshot(c),
  newReference: newCheckoutReference,
  metadata: (id) => ({ purpose: "consultation", consultationId: id }),
};

/** Where a booking's checkout stands, as answered to a caller. */
export type CheckoutState =
  /** A checkout the payer can use (`opened`: this caller opened it; else another caller did). */
  | { kind: "checkout"; authorizationUrl: string; reference: string; consultation: Consultation; opened: boolean }
  /** The booking is paid: nothing to charge. */
  | { kind: "paid"; consultation: Consultation }
  /** The booking is gone, cancelled, or not a #180 charge. */
  | { kind: "not_payable"; consultation: Consultation | null }
  /** Another caller is still opening the checkout: try again in a moment. */
  | { kind: "opening"; consultation: Consultation };

/** The shared state shape, with the record under the name the consultation code uses. */
function asConsultationState(s: RecordCheckoutState<Consultation>): CheckoutState {
  switch (s.kind) {
  case "checkout":
    return { kind: "checkout", authorizationUrl: s.authorizationUrl, reference: s.reference, consultation: s.record, opened: s.opened };
  case "paid":
    return { kind: "paid", consultation: s.record };
  case "opening":
    return { kind: "opening", consultation: s.record };
  case "not_payable":
  default:
    return { kind: "not_payable", consultation: s.record };
  }
}

/**
 * Re-read the booking until it shows a usable state (a caller that lost a
 * checkout race lands here). Waits up to CHECKOUT_WAIT_ATTEMPTS reads for
 * the winner to publish its checkout URL.
 */
export async function awaitCheckoutState(consultationId: string): Promise<CheckoutState> {
  return asConsultationState(await awaitRecordCheckoutState(consultationTarget, consultationId));
}

/**
 * Issue a checkout for a booking, race-safely (claim -> open -> publish, see
 * charge-checkout.service.ts). The amount and currency Paystack receives are
 * the STORED `chargedAmountMinor` / `chargedCurrency` after the claim,
 * nothing else.
 *
 * @param input.observedReference the reference the caller read on the
 *   booking (null when it had none). The claim goes on only if the booking
 *   still carries exactly this one.
 * @param input.charge a FRESH locked quote to store with the new reference
 *   (a re-price), or null to keep the snapshot already stored (a brand-new
 *   booking, priced a moment ago).
 * @returns the booking's checkout state: the new checkout, or, when another
 *   caller got there first, whatever the booking now shows.
 * @throws the provider's `PAYSTACK_ERROR: ...` (the controller answers 502).
 */
export async function issueCheckout(input: {
  consultationId: string;
  observedReference: string | null;
  charge: LockedCharge | null;
  email: string;
  callbackUrl: string;
  /** Extra metadata echoed back by Paystack (e.g. the agency slug). */
  metadata?: Record<string, unknown>;
}): Promise<CheckoutState> {
  const state = await issueRecordCheckout(consultationTarget, {
    id: input.consultationId,
    observedReference: input.observedReference,
    charge: input.charge,
    email: input.email,
    callbackUrl: input.callbackUrl,
    metadata: input.metadata,
  });
  return asConsultationState(state);
}

/**
 * Re-price an unpaid #180 booking (rule 4): a FRESH quote of the booking's
 * dollar price (`priceUsdCents`, agreed at booking time) in its charge
 * currency, a new lock, and a new checkout, issued race-safely (see
 * issueCheckout). The caller must already have checked that Paystack
 * reports the current checkout `final_unpaid` (never re-price under a
 * payment in progress).
 *
 * Throws a MoneyError (503) before any write or Paystack call when no rate
 * can price it, and the provider error (502) when Paystack fails.
 */
export async function reissueCheckout(
  c: Consultation,
  opts: { fallbackCallbackUrl: string; metadata?: Record<string, unknown> }
): Promise<CheckoutState> {
  const usd: Money = { amountMinor: c.priceUsdCents!, currency: "USD" };
  const charge = await lockQuote(usd, c.chargedCurrency!);
  return issueCheckout({
    consultationId: c.id,
    observedReference: c.transactionId ?? null,
    charge,
    email: c.clientEmail,
    callbackUrl: c.checkoutCallbackUrl || opts.fallbackCallbackUrl,
    metadata: opts.metadata,
  });
}

// ============================================
// 4. Checking what Paystack reports, and settling
// ============================================

/**
 * The current-checkout form of checkAgainst: compare a report with what the
 * booking's CURRENT checkout asked (the stored snapshot, or a legacy `fee`).
 */
export function checkReportedCharge(c: Consultation, reported: PaystackTransactionLookup, at: Date) {
  const expiresAt = hasChargeSnapshot(c) ? (c.quoteExpiresAt ?? Timestamp.fromMillis(0)) : null;
  return checkAgainst(expectedCharge(c), expiresAt, reported, at);
}

/** What settling a successful Paystack payment did. */
export type SettleOutcome =
  /** The booking is now paid by this payment and its fee Transaction is written. */
  | { kind: "confirmed"; consultation: Consultation; transaction: Transaction; viaSuperseded: boolean }
  /** This very payment already settled the booking: nothing written. */
  | { kind: "already_paid"; consultation: Consultation }
  /**
   * A SECOND payment: the booking was already paid by another reference.
   * Recorded in consultationPaymentExceptions for a refund; no Transaction.
   */
  | { kind: "refund_recorded"; consultation: Consultation; exception: ConsultationPaymentException }
  /** The booking is no longer awaiting payment (cancelled...): recorded for a refund; no Transaction. */
  | { kind: "not_payable_recorded"; consultation: Consultation; exception: ConsultationPaymentException }
  /** Paystack's amount or currency differs from what that checkout asked: nothing written. */
  | { kind: "mismatch" }
  /** Nothing chargeable stored for that checkout: nothing written. */
  | { kind: "not_chargeable" }
  /** The reference was never a checkout of this booking: nothing written. */
  | { kind: "unknown_reference"; consultation: Consultation };

/**
 * Settle a SUCCESSFUL Paystack payment on a booking, atomically and once
 * (rules 5 and 6, and the review fix for superseded references). Everything
 * is decided on the FRESH booking inside ONE Firestore transaction, so a
 * concurrent re-price or confirmation can never slip between the check and
 * the write:
 *
 *  1. Which checkout was paid? The booking's current reference, or one in
 *     `supersededCheckouts`. Neither: `unknown_reference`.
 *  2. Does Paystack's amount (its `requested_amount` when reported) and
 *     currency equal what THAT checkout asked? No: `mismatch`.
 *     (Steps 1 and 2 are the shared `matchPaidCheckout`.)
 *  3. Booking already paid: by this reference, `already_paid`; by another
 *     one, this is a second charge: a `consultationPaymentExceptions` record
 *     (reason `paid_on_superseded_reference_after_booking_paid`), an
 *     error-level log, and NEVER a second Transaction.
 *  4. Booking no longer awaiting payment (cancelled while paying): an
 *     exception record (reason `booking_not_payable`), no Transaction.
 *  5. Otherwise confirm: paid/scheduled plus the fee Transaction in the same
 *     commit. Settled on a superseded reference, the booking takes THAT
 *     checkout's snapshot and lock (so booking and Transaction agree), its
 *     then-current checkout moves to the superseded list (a later payment on
 *     it is a second charge, step 3), and both records carry
 *     `paidOnSupersededReference: true`.
 *
 * A late exact payment is honoured and flagged `paidAfterQuoteExpiry`
 * against the lock of the checkout that was paid; Paystack's `paid_at` is
 * stored as `paystackPaidAt` whenever reported.
 *
 * @returns null when the booking does not exist
 */
export async function settlePayment(
  consultationId: string,
  reference: string,
  reported: PaystackTransactionLookup
): Promise<SettleOutcome | null> {
  const ref = collections.consultations.doc(consultationId);
  const exceptionRef = collections.consultationPaymentExceptions.doc(reference);
  const txRef = collections.transactions.doc();
  return consultationCharging.runTransaction(async (tx) => {
    // All reads first (Firestore transactions require reads before writes).
    const snap = await tx.get(ref);
    if (!snap.exists) return null;
    const exceptionSnap = await tx.get(exceptionRef);
    const current = snap.data() as Consultation;
    const at = consultationCharging.now();

    // (1) + (2) Which checkout was paid, and did Paystack charge exactly what it asked?
    const match = matchPaidCheckout({
      reference,
      currentReference: current.transactionId ?? null,
      currentExpected: expectedCharge(current),
      currentExpiresAt: hasChargeSnapshot(current) ? (current.quoteExpiresAt ?? Timestamp.fromMillis(0)) : null,
      superseded: current.supersededCheckouts,
      reported,
      at,
    });
    if (match.kind === "unknown_reference") return { kind: "unknown_reference", consultation: current };
    const { isCurrent, entry, check } = match;
    if (!check.ok) return { kind: check.reason };

    /** Record money we hold but cannot apply (idempotent: doc id = reference). */
    const recordException = (reason: ConsultationPaymentException["reason"]): ConsultationPaymentException => {
      if (exceptionSnap.exists) return exceptionSnap.data() as ConsultationPaymentException;
      const exception: ConsultationPaymentException = {
        id: reference,
        consultationId,
        reference,
        amountMinor: check.charged.amountMinor,
        currency: check.charged.currency,
        paystackPaidAt: check.providerPaidAt ? Timestamp.fromDate(check.providerPaidAt) : null,
        reason,
        status: "open",
        createdAt: Timestamp.fromDate(at),
      };
      tx.set(exceptionRef, exception);
      console.error(
        `[consultation] Paystack charge ${reference} on ${consultationId} cannot be applied (${reason}): ` +
          `${check.charged.amountMinor} ${check.charged.currency} recorded in consultationPaymentExceptions for refund`
      );
      return exception;
    };

    // (3) Already paid.
    if (current.paymentStatus === "paid") {
      if (isCurrent) return { kind: "already_paid", consultation: current };
      return {
        kind: "refund_recorded",
        consultation: current,
        exception: recordException("paid_on_superseded_reference_after_booking_paid"),
      };
    }
    // (4) No longer awaiting payment.
    if (current.status !== "pending_payment") {
      return { kind: "not_payable_recorded", consultation: current, exception: recordException("booking_not_payable") };
    }

    // (5) Confirm + record, in this same commit.
    const now = Timestamp.fromDate(at);
    const review: { paidAfterQuoteExpiry?: true; paystackPaidAt?: Timestamp; paidOnSupersededReference?: true } = {
      ...(check.paidAfterQuoteExpiry ? { paidAfterQuoteExpiry: true as const } : {}),
      ...(check.providerPaidAt ? { paystackPaidAt: Timestamp.fromDate(check.providerPaidAt) } : {}),
      ...(entry ? { paidOnSupersededReference: true as const } : {}),
    };
    // Settled on a superseded checkout: the booking takes THAT price, and its
    // then-current checkout becomes superseded in turn.
    const swap = supersededSwap(current, current.transactionId ?? null, entry, at) as Partial<Consultation>;
    const updates = {
      ...swap,
      paymentStatus: "paid" as const,
      status: "scheduled" as const,
      transactionId: reference,
      paidAt: now,
      ...review,
      updatedAt: now,
    };
    const settled = { ...current, ...updates } as Consultation;
    const transaction = transactionService.buildConsultationFee(txRef.id, now, {
      consultationId,
      clientUserId: current.userId,
      agentUserId: current.agentId,
      amount: check.charged.amountMinor,
      currency: check.charged.currency,
      reference,
      clientName: current.clientName,
      clientEmail: current.clientEmail,
      snapshot: snapshotOf(settled),
    });
    // The review fields ride on the Transaction too.
    const recorded: Transaction = { ...transaction, ...review };
    if (check.paidAfterQuoteExpiry) {
      // Honoured, but flagged: the FX exposure is small, a human checks it.
      console.warn(
        `[consultation] ${consultationId} paid after its quote expired (reference ${reference}, ` +
          `paid ${check.providerPaidAt?.toISOString() ?? "time not reported"}); confirmed and flagged paidAfterQuoteExpiry`
      );
    }
    if (entry) {
      console.warn(
        `[consultation] ${consultationId} settled on superseded reference ${reference} at that checkout's own price; ` +
          "flagged paidOnSupersededReference"
      );
    }
    tx.update(ref, updates);
    tx.set(txRef, recorded);
    return { kind: "confirmed", consultation: settled, transaction: recorded, viaSuperseded: !!entry };
  });
}

// ============================================
// 5. The payer-safe booking summary
// ============================================

/**
 * What a payer sees of their booking (verify response). Allow-listed field by
 * field: no ids of other people, no checkout internals. A #180 booking
 * carries its snapshot (the amount charged, the rate and when the quote
 * expires); a legacy one carries its naira `fee`.
 */
export function bookingSummary(c: Consultation): Record<string, unknown> {
  return {
    id: c.id,
    agentName: c.agentName,
    type: c.type,
    scheduledDate: c.scheduledDate,
    scheduledTime: c.scheduledTime,
    timezone: c.timezone,
    status: c.status,
    paymentStatus: c.paymentStatus,
    ...(hasChargeSnapshot(c)
      ? { ...snapshotOf(c), quoteExpiresAt: c.quoteExpiresAt }
      : c.fee !== undefined
        ? { fee: c.fee, feeCurrency: "NGN" }
        : { priceUsdCents: c.priceUsdCents ?? 0 }),
  };
}
