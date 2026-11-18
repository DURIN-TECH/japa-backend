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
// Issue #317: a paid fee is held until the meeting has happened.
import { initialFeeHold } from "../money/fee-hold";
import type { FeeHold } from "../types";
// Issue #332: the charge fields a payer may see (no raw rate, no margin).
import { clientChargeFields } from "../money/client-charge";
// Issue #354: the refund row id of a Paystack reference (pure, no cycle:
// refund-id.ts imports nothing from the charge path), and the id of the
// agent's Paystack-fee debit for that reference.
import { feeDebitDocId, refundDocId } from "../money/refund-id";
import type { Transaction as FirestoreTransaction } from "firebase-admin/firestore";
import { isWellFormedFee } from "./billing/paystack.provider";

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
  opts: {
    fallbackCallbackUrl: string;
    /**
     * Issue #285: a return URL the caller asked for explicitly on THIS call
     * (`returnTo: "app"` on POST /consultations/:id/checkout). When given it
     * wins over the stored one and is stored in its place (the claim writes
     * `checkoutCallbackUrl`), so later re-issues keep it too. Omitted, the
     * booking's stored `checkoutCallbackUrl` is kept, else the fallback.
     */
    callbackUrl?: string;
    metadata?: Record<string, unknown>;
  }
): Promise<CheckoutState> {
  const usd: Money = { amountMinor: c.priceUsdCents!, currency: "USD" };
  const charge = await lockQuote(usd, c.chargedCurrency!);
  return issueCheckout({
    consultationId: c.id,
    observedReference: c.transactionId ?? null,
    charge,
    email: c.clientEmail,
    // Explicit choice on this call > the one stored on the booking > default.
    callbackUrl: opts.callbackUrl || c.checkoutCallbackUrl || opts.fallbackCallbackUrl,
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

/**
 * The hold to stamp on a booking's fee Transaction (issue #317), or
 * undefined when the booking's slot cannot be read. A payment must never
 * fail because of a bad date, and a fee with no `feeHold` is counted as
 * HELD anyway (money/fee-hold.ts), so the safe reading still applies; the
 * booking is logged so the data can be fixed.
 */
function holdFor(booking: Consultation, consultationId: string): FeeHold | undefined {
  try {
    return initialFeeHold(booking);
  } catch (error) {
    console.error(`[consultation] ${consultationId}: no readable slot, fee recorded without a hold time (held):`, error);
    return undefined;
  }
}

// ============================================
// 4a. Who carries Paystack's fee on an unapplied payment (issue #354)
// ============================================
//
// Decision (user, 2026-11-16): Paystack keeps its processing fee when a
// charge is refunded. Seli NEVER carries it; whoever caused the refund does.
//
//   exception reason                                  | caused by | client gets back      | agent balance
//   --------------------------------------------------|-----------|-----------------------|----------------------
//   booking_not_payable (paid after a cancel)         | client    | charged - Paystack fee| unchanged
//   paid_on_superseded_reference_after_booking_paid   | client    | charged - Paystack fee| unchanged
//   paid_for_rescheduled_slot (agent side moved it)   | agent     | charged, in full      | debited Paystack fee
//
// "Charged" is the exception's `amountMinor` / `currency`. "Paystack fee" is
// the `fees` Paystack reported for THAT reference (`paystackFeeMinor`), never
// an estimate. When it is unknown nothing is guessed: no refund row, no
// Paystack call, no debit; the exception is held for an admin
// (`refund_failed`, `refundFailureReason: "paystack_fee_unknown"`). A
// client-caused case whose fee is the whole charge or more leaves nothing to
// refund and is held the same way (`fee_not_less_than_amount`).

/** Why a refund of an unapplied payment is held for an admin (see the exception type). */
export type UnappliedRefundHoldReason = NonNullable<ConsultationPaymentException["refundFailureReason"]>;

/**
 * Whether the AGENT side caused this exception (issue #354): only a payment
 * on a checkout retired by the agent side's post-lock reschedule
 * (`paid_for_rescheduled_slot`; an owner or admin making the edit counts as
 * the agent side, orchestrator decision 2026-11-16). Every other reason is
 * the client's (paid after a cancel, paid twice). Pure.
 */
export function isAgentCausedException(reason: ConsultationPaymentException["reason"]): boolean {
  return reason === "paid_for_rescheduled_slot";
}

/**
 * WHICH agent pays Paystack's fee on an agent-caused exception (issue #354
 * fix round, orchestrator decision 2026-11-17: whoever caused it pays). In
 * order:
 *  1. the agent already fixed on the exception (`causedByAgentId`), so a
 *     held refund retried later debits the same agent as first decided;
 *  2. the agent who moved the booking, recorded on the retired checkout that
 *     was paid (`retiredByAgentId` of the `supersededCheckouts` entry with
 *     this reference);
 *  3. FALLBACK for a checkout retired before `retiredByAgentId` existed: the
 *     booking's `agentId` now. If the case was reassigned in between, that
 *     is the new agent; nothing better is recorded for such old entries.
 * Pure.
 */
export function feeDebitAgentFor(
  exception: Pick<ConsultationPaymentException, "reference" | "causedByAgentId">,
  booking: Pick<Consultation, "agentId" | "supersededCheckouts">
): string {
  if (exception.causedByAgentId) return exception.causedByAgentId;
  const retired = (booking.supersededCheckouts ?? []).find((s) => s.reference === exception.reference);
  return retired?.retiredByAgentId ?? booking.agentId;
}

/** What to do with an unapplied payment, money-wise (issue #354). */
export type UnappliedRefundPlan =
  /** Nothing is refunded or debited yet: an admin must look (see the reason). */
  | { kind: "hold"; reason: UnappliedRefundHoldReason; feeMinor?: number }
  /**
   * Refund `refundAmountMinor` to the client and debit `debitMinor` from the
   * agent (0 = no debit row), all in the exception's currency.
   * `feeKeptMinor` is set for a client-caused refund only.
   */
  | { kind: "refund"; feeMinor: number; refundAmountMinor: number; feeKeptMinor?: number; debitMinor: number };

/**
 * Decide the money of one unapplied payment (the table above). Pure.
 *
 * Invariants (Seli never carries any part of the fee):
 *  - client-caused: refundAmountMinor + feeKeptMinor = amountMinor, and
 *    refundAmountMinor > 0 (else held);
 *  - agent-caused: refundAmountMinor = amountMinor and debitMinor = feeMinor.
 *
 * @param exception the exception's charge and reason
 * @param feeMinor Paystack's fee for that reference, or undefined when
 *   Paystack did not report a well-formed one (re-checked here)
 */
export function planUnappliedRefund(
  exception: Pick<ConsultationPaymentException, "amountMinor" | "reason">,
  feeMinor: unknown
): UnappliedRefundPlan {
  if (!isWellFormedFee(feeMinor)) return { kind: "hold", reason: "paystack_fee_unknown" };
  const charged = exception.amountMinor;
  if (isAgentCausedException(exception.reason)) {
    // The agent caused it: the client gets everything back, the agent pays
    // Paystack's fee (even a fee as large as the charge: still the agent's).
    return { kind: "refund", feeMinor, refundAmountMinor: charged, debitMinor: feeMinor };
  }
  // The client caused it: Paystack's fee comes out of their refund. Nothing
  // left (fee >= charge): Paystack refuses a non-positive refund, so hold.
  if (feeMinor >= charged) return { kind: "hold", reason: "fee_not_less_than_amount", feeMinor };
  return { kind: "refund", feeMinor, refundAmountMinor: charged - feeMinor, feeKeptMinor: feeMinor, debitMinor: 0 };
}

/**
 * Paystack's fee for an exception (issue #354): the one already stored on
 * it, else the one in a fresh Paystack report of the same reference, but
 * only when that report is in the exception's own currency (a fee in another
 * currency cannot be this charge's). Undefined = unknown. Pure.
 */
export function feeForException(
  exception: Pick<ConsultationPaymentException, "currency" | "paystackFeeMinor">,
  reported: Pick<PaystackTransactionLookup, "fees" | "currency"> | null
): number | undefined {
  if (isWellFormedFee(exception.paystackFeeMinor)) return exception.paystackFeeMinor;
  if (reported && reported.currency === exception.currency && isWellFormedFee(reported.fees)) return reported.fees;
  return undefined;
}

/** What `readUnappliedRefund` read, through one Firestore transaction. */
export interface UnappliedRefundReads {
  /** The ONE refund row this reference can have (`refundDocId`). */
  refundRef: FirebaseFirestore.DocumentReference;
  /** That row, when it already exists (never written again). */
  existingRefund: Transaction | null;
  /** The ONE fee-debit row this reference can have (`feeDebitDocId`). */
  debitRef: FirebaseFirestore.DocumentReference;
  /** Whether that debit already exists (never written again). */
  debitExists: boolean;
  /** The agent's withdrawal lock (#287): read only for an agent-caused exception. */
  lockRef: FirebaseFirestore.DocumentReference | null;
  /** That lock's data (null when it does not exist or was not read). */
  lockData: Record<string, unknown> | null;
}

/**
 * Read what a refund of an unapplied payment needs, through `tx`, BEFORE any
 * write (Firestore requires reads first). The agent's withdrawal lock is read
 * only when the agent side caused it (`agentUid` given): only then does the
 * write touch the agent's balance, and the lock then orders it against a
 * concurrent withdrawal (#287), which is retried on fresh data.
 */
export async function readUnappliedRefund(
  tx: FirestoreTransaction,
  reference: string,
  agentUid: string | null
): Promise<UnappliedRefundReads> {
  const refundRef = collections.transactions.doc(refundDocId(reference));
  const debitRef = collections.transactions.doc(feeDebitDocId(reference));
  const refundSnap = await tx.get(refundRef);
  const debitSnap = await tx.get(debitRef);
  const lockRef = agentUid ? collections.withdrawalLocks.doc(agentUid) : null;
  const lockSnap = lockRef ? await tx.get(lockRef) : null;
  return {
    refundRef,
    existingRefund: refundSnap.exists ? (refundSnap.data() as Transaction) : null,
    debitRef,
    debitExists: debitSnap.exists,
    lockRef,
    lockData: lockSnap?.exists ? (lockSnap.data() as Record<string, unknown>) : null,
  };
}

/** What `writeUnappliedRefund` wrote. */
export interface UnappliedRefundWrite {
  /** The exception as now stored. */
  exception: ConsultationPaymentException;
  /** The refund row written now (null when held). */
  refund: Transaction | null;
  /** The agent's fee debit written now (null when none). */
  debit: Transaction | null;
  /**
   * Issue #354 fix round: whether the booking was still awaiting payment
   * when this was written. An agent-caused refund on a booking that is still
   * `pending_payment` tells the client to pay again for the new time; on one
   * that was paid since (another checkout) or cancelled, it must not.
   */
  bookingAwaitingPayment: boolean;
}

/**
 * Apply a plan to one exception through `tx` (issue #354), after
 * `readUnappliedRefund`, and only when no refund row exists yet:
 *  - HOLD: the exception is stored `refund_failed` with its
 *    `refundFailureReason` (and the fee, when known). No refund row, no
 *    debit, no Paystack call: no row ever carries a guessed amount;
 *  - REFUND: the refund row (`tx.create`, id `refundDocId(reference)`), the
 *    agent's fee debit when the agent caused it and Paystack's fee is above
 *    0 (`tx.create`, id `feeDebitDocId(reference)`, plus the agent's
 *    withdrawal lock), and the exception linked to both, `open` until the
 *    refund completes.
 * `create()`, not `set()`: should a concurrent writer ever get past the reads,
 * this commit fails instead of writing a second refund or debit.
 */
export function writeUnappliedRefund(
  tx: FirestoreTransaction,
  reads: UnappliedRefundReads,
  input: {
    /** The exception as it should be stored (new, or as read). */
    exception: ConsultationPaymentException;
    /** Whether the exception doc already existed (an update, not a create). */
    exceptionExisted: boolean;
    plan: UnappliedRefundPlan;
    /** The booking's parties and state (as read in this transaction). */
    booking: Pick<
      Consultation,
      "userId" | "agentId" | "clientName" | "clientEmail" | "status" | "paymentStatus" | "supersededCheckouts"
    >;
    now: Timestamp;
  }
): UnappliedRefundWrite {
  const exceptionRef = collections.consultationPaymentExceptions.doc(input.exception.id);
  const { plan, now } = input;
  // Rebuilt without the hold fields, so a refund that goes ahead clears them
  // (tx.set replaces the whole doc).
  const { refundFailureReason: _held, ...rest } = input.exception;
  void _held;
  // Issue #354 fix round: an agent-caused exception names the agent who pays
  // Paystack's fee, fixed now (see feeDebitAgentFor) and stored, so a held
  // refund retried later, or a re-settle after a reassignment, still debits
  // the agent who moved the booking. The lock read in readUnappliedRefund was
  // taken for this same agent.
  const debitAgentId = isAgentCausedException(input.exception.reason)
    ? feeDebitAgentFor(input.exception, input.booking)
    : null;
  const base: ConsultationPaymentException = debitAgentId ? { ...rest, causedByAgentId: debitAgentId } : rest;
  const touched = input.exceptionExisted ? { updatedAt: now } : {};
  // Whether the booking is still waiting to be paid (for the client's copy:
  // only then do they need to "pay again for the new time").
  const bookingAwaitingPayment =
    input.booking.status === "pending_payment" && input.booking.paymentStatus !== "paid";

  if (plan.kind === "hold") {
    const exception: ConsultationPaymentException = {
      ...base,
      ...(plan.feeMinor !== undefined ? { paystackFeeMinor: plan.feeMinor } : {}),
      status: "refund_failed",
      refundFailureReason: plan.reason,
      ...touched,
    };
    tx.set(exceptionRef, exception);
    console.error(
      `[consultation] refund of ${input.exception.reference} on ${input.exception.consultationId} HELD for an admin ` +
        `(${plan.reason}): no refund row, no Paystack call, no agent debit`
    );
    return { exception, refund: null, debit: null, bookingAwaitingPayment };
  }

  const refund = transactionService.buildUnappliedPaymentRefund(reads.refundRef.id, now, {
    exception: input.exception,
    clientUserId: input.booking.userId,
    refundAmountMinor: plan.refundAmountMinor,
    ...(plan.feeKeptMinor !== undefined ? { paystackFeeKeptMinor: plan.feeKeptMinor } : {}),
    clientName: input.booking.clientName,
    clientEmail: input.booking.clientEmail,
  });
  tx.create(reads.refundRef, refund);

  // The agent's fee debit (agent-caused, a fee above 0, not written before).
  let debit: Transaction | null = null;
  if (plan.debitMinor > 0 && !reads.debitExists && debitAgentId) {
    debit = transactionService.buildPaystackFeeDebit(reads.debitRef.id, now, {
      // The agent who CAUSED it (moved the booking), not necessarily the
      // booking's agent now (fix round, reassignment decision).
      agentUserId: debitAgentId,
      consultationId: input.exception.consultationId,
      reference: input.exception.reference,
      feeMinor: plan.debitMinor,
      currency: input.exception.currency,
    });
    tx.create(reads.debitRef, debit);
    // The #287 lock (read in readUnappliedRefund): merged, so the
    // withdrawal's and the refund engine's own fields are kept.
    if (reads.lockRef) {
      const count = Number(reads.lockData?.feeDebitCount) || 0;
      tx.set(
        reads.lockRef,
        { agentUserId: debitAgentId, lastFeeDebitId: debit.id, feeDebitCount: count + 1, updatedAt: now },
        { merge: true }
      );
    }
  }

  const exception: ConsultationPaymentException = {
    ...base,
    paystackFeeMinor: plan.feeMinor,
    refundId: refund.id,
    ...(debit || reads.debitExists ? { feeDebitId: reads.debitRef.id } : {}),
    status: "open",
    ...touched,
  };
  tx.set(exceptionRef, exception);
  console.error(
    `[consultation] Paystack charge ${input.exception.reference} on ${input.exception.consultationId} cannot be applied ` +
      `(${input.exception.reason}): ${input.exception.amountMinor} ${input.exception.currency} charged, ` +
      `recorded in consultationPaymentExceptions; refund ${refund.id} of ${refund.amount} started` +
      (plan.feeKeptMinor !== undefined ? `, Paystack fee ${plan.feeKeptMinor} kept from the client` : "") +
      (debit ? `, Paystack fee ${debit.amount} debited from agent ${debitAgentId} (${debit.id})` : "")
  );
  return { exception, refund, debit, bookingAwaitingPayment };
}

/** What settling a successful Paystack payment did. */
export type SettleOutcome =
  /** The booking is now paid by this payment and its fee Transaction is written. */
  | { kind: "confirmed"; consultation: Consultation; transaction: Transaction; viaSuperseded: boolean }
  /** This very payment already settled the booking: nothing written. */
  | { kind: "already_paid"; consultation: Consultation }
  /**
   * A SECOND payment: the booking was already paid by another reference.
   * Recorded in consultationPaymentExceptions and refunded (issue #354); no
   * fee Transaction.
   */
  | { kind: "refund_recorded"; consultation: Consultation; exception: ConsultationPaymentException; refund: Transaction | null }
  /** The booking is no longer awaiting payment (cancelled...): recorded and refunded (#354); no fee Transaction. */
  | { kind: "not_payable_recorded"; consultation: Consultation; exception: ConsultationPaymentException; refund: Transaction | null }
  /**
   * Issue #354: paid on a checkout RETIRED when the booking was rescheduled
   * after its quote lock (`retiredBy: "reschedule"`). The booking is NOT
   * confirmed and stays `pending_payment`; the payment is recorded and
   * refunded in full. The client pays again for the new time.
   */
  | { kind: "rescheduled_refund_recorded"; consultation: Consultation; exception: ConsultationPaymentException; refund: Transaction | null }
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
 *  4b. (issue #354) Paid on a checkout RETIRED by a reschedule
 *     (`retiredBy: "reschedule"`): the booking is NOT confirmed (it moved
 *     since that checkout was issued); an exception record (reason
 *     `paid_for_rescheduled_slot`), no Transaction, booking unchanged.
 *     Review fix (fix round): such a payment is ALWAYS recorded
 *     `paid_for_rescheduled_slot` (agent-caused), also when (3) or (4)
 *     answers because the booking was paid or cancelled since; only the
 *     outcome kind follows the booking's state.
 *  5. Otherwise confirm: paid/scheduled plus the fee Transaction in the same
 *     commit. Settled on a superseded reference, the booking takes THAT
 *     checkout's snapshot and lock (so booking and Transaction agree), its
 *     then-current checkout moves to the superseded list (a later payment on
 *     it is a second charge, step 3), and both records carry
 *     `paidOnSupersededReference: true`.
 *
 * REFUNDS (issue #354). Every exception (3, 4, 4b) gets its refund row in
 * the SAME transaction, through the #317 engine's row shape
 * (`buildUnappliedPaymentRefund`): doc id `refundDocId(reference)` (one
 * refund ever per Paystack reference), in exactly the exception's currency
 * (what Paystack charged, never re-converted), no agentId. WHO CARRIES
 * PAYSTACK'S FEE (section 4a, decision 2026-11-16), from Paystack's own
 * `fees` for this reference (`reported.fees`, stored on the exception as
 * `paystackFeeMinor`): a client-caused exception (3, 4) refunds the charge
 * minus that fee; an agent-caused one (4b) refunds the charge in full and
 * debits the fee from the agent who moved the booking (`feeDebitAgentFor`;
 * `paystack_fee_debit`, doc id
 * `feeDebitDocId(reference)`, `tx.create`, under the agent's withdrawal
 * lock), all in this same transaction. Fee unknown, or a client-caused fee
 * that leaves nothing to refund: the exception is HELD (`refund_failed` with
 * `refundFailureReason`), with no refund row, no debit and no Paystack call.
 * A second verify, a webhook retry, or two calls at once find the exception
 * (and the row) already there and create nothing. After the commit, the row
 * that THIS call created is sent to Paystack (`processRefund`; on failure the
 * 15-minute retry job picks it up) and the client (and a debited agent) is
 * told.
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
  /**
   * Set inside the transaction when THIS call wrote a new refund row (sent to
   * Paystack after the commit), with the agent's fee debit when one was written.
   */
  let created: UnappliedRefundWrite | null = null;
  const outcome = await consultationCharging.runTransaction<SettleOutcome | null>(async (tx) => {
    // A retried transaction starts again from fresh reads.
    created = null;
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

    /**
     * Record money we hold but cannot apply, and its refund (issue #354).
     * Idempotent: the exception's doc id is the reference, the refund row's
     * `refundDocId(reference)` and the agent's fee debit's
     * `feeDebitDocId(reference)`, all read in THIS transaction before any write.
     *
     *  - no exception yet: it is written now, with its refund (and, when the
     *    agent caused it, the fee debit) or, when Paystack's fee is unknown or
     *    leaves nothing to refund, HELD for an admin (no refund row);
     *  - the exception exists WITH its refund row: nothing is written (a
     *    second verify, a webhook retry, the loser of a concurrent call);
     *  - the exception exists WITHOUT a refund row (recorded before #354, or
     *    held because the fee was unknown): planned again from the STORED
     *    exception's amount and currency, with Paystack's fee from the
     *    exception or from THIS report of the reference.
     * A refund row or a debit that exists is never written again.
     */
    const recordException = async (
      reason: ConsultationPaymentException["reason"]
    ): Promise<{ exception: ConsultationPaymentException; refund: Transaction | null }> => {
      const now = Timestamp.fromDate(at);
      const stored = exceptionSnap.exists ? (exceptionSnap.data() as ConsultationPaymentException) : null;
      // Issue #354 fix round: an exception an admin CLOSED as
      // `nothing_to_refund` is final. A later settle of the same reference
      // (a late verify, a webhook retry) writes nothing and never reopens it.
      if (stored?.status === "nothing_to_refund") return { exception: stored, refund: null };
      // The STORED reason wins: it was decided when the payment first landed.
      const effectiveReason = stored?.reason ?? reason;
      // Reads (still before any write): the refund row, the debit, and the
      // lock of the agent who pays the fee when the agent side caused it
      // (the agent who moved the booking: feeDebitAgentFor).
      const reads = await readUnappliedRefund(
        tx,
        reference,
        isAgentCausedException(effectiveReason)
          ? feeDebitAgentFor(stored ?? { reference, causedByAgentId: undefined }, current)
          : null
      );
      if (reads.existingRefund) {
        if (stored) return { exception: stored, refund: reads.existingRefund };
        // A refund row but no exception (cannot happen through this code):
        // record the exception linked to it, never write a second row.
        const exception = newException(effectiveReason, now, { refundId: reads.refundRef.id });
        tx.set(exceptionRef, exception);
        return { exception, refund: reads.existingRefund };
      }
      const exception = stored ?? newException(effectiveReason, now);
      // Paystack's fee for THIS reference: stored, else from this report.
      const plan = planUnappliedRefund(exception, feeForException(exception, reported));
      const written = writeUnappliedRefund(tx, reads, {
        exception,
        exceptionExisted: !!stored,
        plan,
        booking: current,
        now,
      });
      if (written.refund) created = written;
      return { exception: written.exception, refund: written.refund };
    };

    /** A new exception record for this payment (what Paystack charged on THIS reference). */
    const newException = (
      reason: ConsultationPaymentException["reason"],
      now: Timestamp,
      extra: Partial<ConsultationPaymentException> = {}
    ): ConsultationPaymentException => ({
      id: reference,
      consultationId,
      reference,
      // The exact-match check above guarantees it equals what that checkout asked.
      amountMinor: check.charged.amountMinor,
      currency: check.charged.currency,
      paystackPaidAt: check.providerPaidAt ? Timestamp.fromDate(check.providerPaidAt) : null,
      reason,
      status: "open",
      createdAt: now,
      ...extra,
    });

    // Issue #354 review fix (blocking, fix round 2026-11-17): WHO CAUSED the
    // refund is decided by the checkout that was paid, not by what happened
    // to the booking since. A payment on a checkout RETIRED by a reschedule
    // (the agent side moved the booking after its quote lock) is ALWAYS
    // agent-caused (`paid_for_rescheduled_slot`), even when the booking was
    // paid since through a fresh checkout (3) or cancelled / swept since (4).
    // Without this, those orders recorded it as client-caused and the client
    // paid Paystack's fee for the agent's move. The booking-state outcome
    // still follows (3) / (4) / (4b) below; only the exception's reason (and
    // so who pays the fee) is fixed here. A stored reason still wins on a
    // re-settle (recordException), so idempotency is unchanged.
    const retiredByReschedule = !isCurrent && entry?.retiredBy === "reschedule";

    // (3) Already paid.
    if (current.paymentStatus === "paid") {
      if (isCurrent) return { kind: "already_paid", consultation: current };
      return {
        kind: "refund_recorded",
        consultation: current,
        ...(await recordException(
          retiredByReschedule ? "paid_for_rescheduled_slot" : "paid_on_superseded_reference_after_booking_paid"
        )),
      };
    }
    // (4) No longer awaiting payment.
    if (current.status !== "pending_payment") {
      return {
        kind: "not_payable_recorded",
        consultation: current,
        ...(await recordException(retiredByReschedule ? "paid_for_rescheduled_slot" : "booking_not_payable")),
      };
    }
    // (4b) Issue #354: a checkout retired by a reschedule was for the OLD
    // slot. Never confirm the booking with it: give the money back, and the
    // booking stays pending_payment for a fresh checkout priced now.
    if (retiredByReschedule) {
      return {
        kind: "rescheduled_refund_recorded",
        consultation: current,
        ...(await recordException("paid_for_rescheduled_slot")),
      };
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
      // Issue #317: the fee is HELD until the meeting has happened.
      feeHold: holdFor(settled, consultationId),
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

  // ---- After the commit (issue #354): send the refund THIS call created ----
  // Only the call whose transaction wrote the row does this; every other
  // caller found it existing and created nothing. `created` is reassigned
  // inside the callback, so TypeScript's narrowing is widened back here.
  const fresh = created as UnappliedRefundWrite | null;
  if (fresh?.refund && outcome && "refund" in outcome) {
    const sent = await startUnappliedRefund(fresh);
    return { ...outcome, refund: sent };
  }
  return outcome;
}

/**
 * Send a just-written refund of an unapplied payment to Paystack and tell
 * both sides (issue #354): the client what comes back (and, client-caused,
 * the fee Paystack kept), and, when the agent was debited Paystack's fee,
 * the agent. Called only by the caller whose transaction WROTE the row
 * (`settlePayment`, or an admin retry of a held one). Never throws: a
 * Paystack failure leaves the row `pending` for the 15-minute retry job
 * (`retryConsultationRefunds`), which looks the charge's refunds up before
 * any repeat call.
 *
 * The refund service is loaded lazily: it imports this module
 * (`expectedCharge`), so a top-level import would be circular.
 *
 * @returns the row as it stands after the first Paystack try
 */
export async function startUnappliedRefund(written: UnappliedRefundWrite): Promise<Transaction> {
  const { consultationRefundService } = await import("./consultation-refund.service");
  const refund = written.refund!;
  let row = refund;
  try {
    row = (await consultationRefundService.processRefund(refund.id)) ?? refund;
  } catch (error) {
    console.error(`[consultation] refund ${refund.id} could not be sent yet; the retry job will:`, error);
  }
  await consultationRefundService.notifyUnappliedRefund(row, written.exception, {
    bookingAwaitingPayment: written.bookingAwaitingPayment,
  });
  if (written.debit) await consultationRefundService.notifyFeeDebit(written.debit);
  return row;
}

// ============================================
// 5. The payer-safe booking summary
// ============================================

/**
 * What a payer sees of their booking (checkout and verify answers, and the
 * 409 bodies that name a booking). Allow-listed field by field: no ids of
 * other people, no checkout internals. A #180 booking carries what it is
 * charged and until when the quote holds; a legacy one its naira `fee`.
 *
 * Issue #332: the charge is the PAYER-SAFE one (`clientChargeFields`):
 * `priceUsdCents`, `chargedCurrency`, `chargedAmountMinor` and
 * `effectiveRate` (amount charged ÷ dollar price, markup included). The raw
 * `fxRate`, `fxRateAsOf`, `fxRateSource` and `fxMarginBps` that used to be
 * copied here are no longer sent: every caller of this summary is a payer
 * (a signed-in client or a guest).
 */
export function bookingSummary(c: Consultation): Record<string, unknown> {
  /** The payer-safe charge of a priced booking, with the expiry always named (as before #332). */
  const payerCharge = (b: Consultation): Record<string, unknown> => {
    // `quoteLockedAt` was never part of this summary; it stays out so the
    // summary's keys only lose the raw-rate fields and gain `effectiveRate`.
    const { quoteLockedAt: _lockedAt, ...charge } = clientChargeFields(b);
    void _lockedAt;
    return { ...charge, quoteExpiresAt: b.quoteExpiresAt };
  };
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
      ? payerCharge(c)
      : c.fee !== undefined
        ? { fee: c.fee, feeCurrency: "NGN" }
        : { priceUsdCents: c.priceUsdCents ?? 0 }),
  };
}
