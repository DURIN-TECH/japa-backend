// ============================================
// Consultation refund engine (issue #317, part 1 of 4)
// ============================================
//
// When a PAID consultation is cancelled, this decides the refund by the
// product rule, writes it as its own `refund` Transaction, and sends it back
// through Paystack's refund API (the amount charged, minus Paystack's fee
// when the client caused it: issue #390, below). Admins can issue
// or retry one by hand (`POST /consultations/:id/refund`).
//
// THE RULE (paid bookings only; see `decideCancellationRefund`)
//
//   who / what                                  | refund
//   --------------------------------------------|-------------------------
//   agent side cancels (agent, owner, admin)    | full (`agent_cancelled`)
//   client cancels, slot starts >= 24 h from now| full (`client_cancelled`)
//   client cancels, slot starts < 24 h from now | none, the agent keeps it
//   agent marks the client no_show / completed  | none
//   agent did not show                          | admin refund (`admin_agent_no_show`)
//   free, or unpaid pending_payment             | nothing to refund
//
// "Slot start" is `slotStartsAt` (consultations/slot-time.ts); exactly 24 h
// before counts as "24 hours or more"; the server clock decides.
//
// WHO PAYS (orchestrator change "hold consultation fees", #351 reversal)
//
// Seli never funds a refund an agent can trigger. A paid fee is HELD until
// the meeting has happened (money/fee-hold.ts). A refund of a held fee is
// paid out of that hold (`refundFundedFrom: "hold"`): the agent's available
// balance does not move. Once the fee is released the agent side can no
// longer cancel (409 FEE_RELEASED); only an admin can still refund it, and
// that refund comes off the agent's AVAILABLE balance
// (`refundFundedFrom: "available"`), which may go below zero; the shortfall
// is recorded on the row (`balanceShortfallMinor`) and withdrawals are
// refused until the balance is positive again.
//
// MONEY AND IDEMPOTENCY (must hold)
//
//  - The refund row copies `currency` from the fee Transaction (minor units
//    of the charged currency, FX markup included); its `amount` is the fee's
//    `amount`, or (issue #390, client-caused) that minus Paystack's own fee.
//    Paystack is called with exactly the row's amount and currency, never a
//    converted figure.
//  - The row's doc id is `refund_<sha256 of the fee's Paystack reference>` (`refundDocId`):
//    one charge can only ever have ONE refund row. A second cancel, a client
//    retry or two admins at once find it and create nothing.
//  - The row, the booking update and the fee's hold update are written in
//    ONE Firestore transaction that also reads and writes the agent's
//    `withdrawalLocks/{agentUid}` lock (#287), so a withdrawal can never
//    spend money that is being refunded.
//  - The Paystack call happens AFTER that commit (`processRefund`). Before
//    any REPEAT call (retry job, admin retry, a crash after the call) the
//    engine first looks the charge's refunds up at Paystack and adopts one if
//    found; a refused create is followed by the same lookup, never by
//    another create.
//  - Status only moves forward (`advanceRefundStatus`): pending ->
//    processing -> completed (final) or failed. Repeated or out-of-order
//    webhooks write nothing. Only an admin retry moves failed -> pending,
//    on the SAME row.
//
// PAYMENTS THAT CANNOT BE APPLIED (issue #354)
//
// A payment `settlePayment` cannot apply to its booking (a second charge, a
// payment after a cancel, a payment on a checkout retired by a reschedule)
// is recorded in `consultationPaymentExceptions` AND gets a refund row in the
// same Firestore transaction (`buildUnappliedPaymentRefund`, same
// deterministic id `refundDocId(reference)`). That row goes through THIS
// engine unchanged (processRefund, the retry job, the webhook), with three
// differences, all keyed on `paymentExceptionId`:
//  - its status is mirrored onto the EXCEPTION (`refunded` /
//    `refund_failed`), never onto the booking, whose `refundId` /
//    `refundStatus` belong to the booking's own fee;
//  - it has no agentId and `refundFundedFrom: "unapplied_payment"`: no
//    agent balance, no withdrawal lock, no revenue effect;
//  - an admin retries a failed one by naming it (`adminRetryExceptionRefund`).
//
// PAYSTACK'S FEE ON THOSE REFUNDS (decision 2026-11-16; the rule itself is
// `planUnappliedRefund` in consultation-charge.service.ts). Seli never
// carries it: a client-caused refund gives back the charge minus Paystack's
// fee (`paystackFeeKeptMinor` on the row); an agent-caused one gives back
// everything and debits the booking's agent the fee (`paystack_fee_debit`).
// When Paystack's fee is unknown (or leaves nothing to refund) NO row is
// written and the exception is HELD (`refund_failed`, `refundFailureReason`).
// Admins list held and failed exceptions with `listExceptionRefundsNeedingAdmin`
// (`GET /consultations/payment-exceptions`), and retry a held one with the
// same `{ refundId }` call: Paystack is asked for the fee again first.
//
// PAYSTACK'S FEE ON CANCEL REFUNDS (issue #390, decision 2026-11-16;
// interaction with #395, where the agent is credited A - F at settle)
//
// Paystack keeps its processing fee F when a charge A is refunded. Seli
// never carries it: whoever caused the refund does (`planCancellationRefund`).
//
//   refund reason                         | fee borne by | client gets | agent's total for the reference
//   --------------------------------------|--------------|-------------|--------------------------------
//   client_cancelled                      | client       | A - F       | 0
//   agent_cancelled, admin_agent_no_show  | agent        | A           | -F (the fee once, never 2F)
//   admin_goodwill, admin_other           | `feeBorneBy` (required, no default): as the row above
//
// The agent's total is reached whether the refund is paid out of the hold
// or from the available balance. The refund row records what it takes off
// the agent (`agentReversalMinor`), and the agent is debited F
// (`paystack_fee_debit`, doc id `feeDebitDocId(reference)`, `tx.create`, in
// the SAME transaction as the refund row, the booking and the agent's
// withdrawal lock) ONLY when the funding path did not already take F:
//  - out of the hold, the fee's whole credit leaves (agent at 0): an
//    agent-caused refund writes the one debit of F;
//  - from available on a net-credited fee (A - F): the agent-caused refund
//    takes A off (agent already at -F): NO debit;
//  - an older full-credit fee (credited A, before #395) from available,
//    client-caused: the agent gives back the FULL A (user decision
//    2026-11-17) while the client gets A - F; agent-caused: A off A, so the
//    debit of F is written.
// F is read from the fee Transaction (`paystackFeeMinor`) first; only when it
// is not stored there (an older row, or #395 "unknown") is Paystack asked for
// the reference, OUTSIDE the Firestore transaction. Never estimated: when no
// well-formed fee is found, or a client-caused fee is not less than A, the
// booking still cancels but the refund is HELD (a `failed` row of amount 0
// with `refundHeldReason`, no Paystack call, no debit), listed in
// `GET /transactions?role=admin&type=refund&status=failed`. An admin retry
// (`POST /consultations/:id/refund`) re-reads the fee: known, it proceeds
// once under the rule; still unknown, 409 PAYSTACK_FEE_UNKNOWN, nothing written.
//
// Out of scope here: the mobile and portal screens (#356, #357).

import { FieldValue, Timestamp } from "firebase-admin/firestore";
import type { Transaction as FirestoreTransaction } from "firebase-admin/firestore";
import type {
  Consultation,
  ConsultationPaymentException,
  // Issue #390: who carries Paystack's fee, and why a refund is held.
  PaystackFeeBorneBy,
  RefundFundedFrom,
  RefundHeldReason,
  RefundReason,
  RefundStatus,
  Transaction,
} from "../types";
import type { Money } from "../types/money";
import { collections } from "../utils/firebase";
import { chargeRuntime } from "./charge-checkout.service";
import {
  expectedCharge,
  feeDebitAgentFor,
  // Issue #354: who carries Paystack's fee on an unapplied payment's refund.
  feeForException,
  planUnappliedRefund,
  readUnappliedRefund,
  isAgentCausedException,
  UnappliedRefundWrite,
  writeUnappliedRefund,
} from "./consultation-charge.service";
import { availableBalanceIn, transactionService } from "./transaction.service";
// Issue #390 / #395: Paystack's fee on the refunded charge.
import { consultationFeeCredit, isUnresolvedFeeStatus, isWellFormedFee } from "../money/paystack-fee";
import { resolvedFeeFields } from "./paystack-fee.service";
import type { PaystackTransactionLookup } from "./billing/paystack.provider";
import { notificationService } from "./notification.service";
import { PaystackApiError, PaystackRefund, paystackProvider } from "./billing/paystack.provider";
import { feeHoldStatusAt, FeeHoldStatus, refundFundableFromHold } from "../money/fee-hold";
import { formatWithCode } from "../money/money";
import { slotStartsAt } from "../consultations/slot-time";
import { feeDebitDocId, refundDocId } from "../money/refund-id";

// ============================================
// Constants
// ============================================

/** A client cancelling at least this many hours before the slot gets the fee back. */
export const CLIENT_REFUND_WINDOW_HOURS = 24;
/** How many times the engine tries a Paystack refund before the row is `failed`. */
export const MAX_REFUND_ATTEMPTS = 5;
/** Wait before a pending row is tried again, in minutes (the job runs every 15). */
export const REFUND_RETRY_MINUTES = 15;
/** How long one worker holds a row while it talks to Paystack, in minutes. */
export const REFUND_LEASE_MINUTES = 2;
/** The most rows one run of the retry job looks at. */
export const REFUND_RETRY_BATCH_SIZE = 100;
/** Longest admin note stored, in characters. */
export const MAX_REFUND_NOTE_LENGTH = 1000;
/**
 * Issue #381: how long a row may sit in `processing` (Paystack accepted it,
 * no final webhook yet) before the poll asks Paystack, in minutes.
 */
export const REFUND_PROCESSING_POLL_AFTER_MINUTES = 60;
/** Issue #381: the most rows one run of the processing poll looks at. */
export const REFUND_PROCESSING_POLL_BATCH_SIZE = 100;

/** Milliseconds in a minute and an hour. */
const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

/** The two parties of a booking, as the status route names them (see consultation.service.ts). */
export type RefundActor = "client" | "agent_side";

/** Statuses a client may cancel from (the client row of STATUS_TRANSITIONS). */
const CLIENT_CANCELLABLE = ["pending_payment", "scheduled", "confirmed"];

// ============================================
// Pure helpers
// ============================================

/**
 * The refund row's doc id for one charge (`refund_<sha256 of the reference>`).
 * Defined in money/refund-id.ts since issue #354 (so the charge path can use
 * it without a circular import) and re-exported here, where #317 put it.
 */
export { refundDocId } from "../money/refund-id";

/**
 * True when a booking carries money that could be refunded: marked paid AND
 * charged something (a Paystack reference, a positive local charge, a
 * positive dollar price, or a legacy naira fee). A FREE booking is stored
 * `paymentStatus: "paid"` with `priceUsdCents: 0` and no reference: not
 * refundable. Pure. (Same idea as `bookingHasPayment` in
 * consultation.service.ts, restricted to PAID bookings; kept here so this
 * module does not import the booking service, which imports it.)
 */
export function isPaidWithMoney(
  c: Pick<Consultation, "paymentStatus" | "transactionId" | "chargedAmountMinor" | "priceUsdCents" | "fee">
): boolean {
  if (c.paymentStatus !== "paid") return false;
  /** A stored amount that is a real, positive number. */
  const positive = (v: unknown): boolean => typeof v === "number" && v > 0;
  return !!c.transactionId || positive(c.chargedAmountMinor) || positive(c.priceUsdCents) || positive(c.fee);
}

/** What a cancel means for the money. */
export type CancellationRefundDecision =
  /** Free or unpaid: nothing was charged. */
  | { kind: "nothing" }
  /** Full refund of the fee, for this reason. */
  | { kind: "full"; reason: Extract<RefundReason, "agent_cancelled" | "client_cancelled"> }
  /** The client cancelled less than 24 h before the slot: the agent keeps the fee. */
  | { kind: "late_client_cancel" };

/**
 * When the client's 24-hour refund window is measured FROM (issue #317
 * review fix): the LATER of the booking's current slot start and the fee
 * hold's `slotStartAt`. The hold's time is set when the client pays and only
 * ever moves later (`rescheduledFeeHold`), so an agent who moves a paid
 * booking EARLIER (to an hour from now, or into the past) can never turn a
 * client's refundable cancel into a late one. A later move gives the client
 * more time, as it should. Pure.
 *
 * @returns null when neither time can be read
 */
export function refundWindowStartsAt(booking: Consultation, fee: Pick<Transaction, "feeHold"> | null): Date | null {
  const candidates: number[] = [];
  try {
    candidates.push(slotStartsAt(booking).getTime());
  } catch {
    // An unreadable current slot: the paid slot alone decides.
  }
  const held = fee?.feeHold?.slotStartAt as unknown as { toMillis?: () => number } | undefined;
  if (held && typeof held.toMillis === "function") candidates.push(held.toMillis());
  return candidates.length ? new Date(Math.max(...candidates)) : null;
}

/**
 * The refund a cancel gives (the rule table in the header). Pure.
 *
 * The client's 24 hours are counted back from `refundWindowStartsAt` (the
 * later of the current slot and the slot the client paid for), never from a
 * slot the agent moved earlier.
 *
 * A client booking whose slot cannot be read (bad stored data) is treated as
 * refundable: the fee is held at that point, so the refund costs neither the
 * agent's earned money nor Seli anything, and the client is not penalised
 * for our data.
 *
 * @param actor which party cancels
 * @param booking the booking as it is before the cancel
 * @param at the server clock
 */
export function decideCancellationRefund(
  actor: RefundActor,
  booking: Consultation,
  at: Date,
  fee: Pick<Transaction, "feeHold"> | null = null
): CancellationRefundDecision {
  if (!isPaidWithMoney(booking)) return { kind: "nothing" };
  if (actor === "agent_side") return { kind: "full", reason: "agent_cancelled" };
  const start = refundWindowStartsAt(booking, fee);
  if (!start) return { kind: "full", reason: "client_cancelled" };
  const startMs = start.getTime();
  // Exactly 24 hours before the slot still counts as "24 hours or more".
  return startMs - at.getTime() >= CLIENT_REFUND_WINDOW_HOURS * HOUR_MS
    ? { kind: "full", reason: "client_cancelled" }
    : { kind: "late_client_cancel" };
}

// ============================================
// Issue #390: who carries Paystack's fee, and how much moves
// ============================================

/**
 * Who carries Paystack's fee for a refund reason (issue #390). Pure.
 *  - `client_cancelled`: the client;
 *  - `agent_cancelled`, `admin_agent_no_show`: the agent side;
 *  - `admin_goodwill`, `admin_other`: whatever the admin chose
 *    (`feeBorneBy`, required: null when it is missing, so the caller refuses).
 * Any other reason (an unapplied payment, #354): null.
 */
export function feeBorneByFor(reason: RefundReason, chosen?: PaystackFeeBorneBy | null): PaystackFeeBorneBy | null {
  if (reason === "client_cancelled") return "client";
  if (reason === "agent_cancelled" || reason === "admin_agent_no_show") return "agent";
  if (reason === "admin_goodwill" || reason === "admin_other") return chosen === "client" || chosen === "agent" ? chosen : null;
  return null;
}

/** What one consultation refund does with the money (issue #390). */
export type CancellationRefundPlan =
  /** Nothing is refunded or debited: an admin must look (no figure is guessed). */
  | { kind: "hold"; reason: RefundHeldReason; feeMinor?: number }
  /**
   * Refund `refundAmountMinor` to the client, take `agentReversalMinor` off
   * the agent with the refund row, and debit `debitMinor` (0 = no debit row),
   * all in the fee's currency. `feeKeptMinor`: client-caused only.
   */
  | {
      kind: "refund";
      feeMinor: number;
      refundAmountMinor: number;
      feeKeptMinor?: number;
      agentReversalMinor: number;
      debitMinor: number;
    };

/**
 * Decide the money of one consultation refund (issue #390, the rule table in
 * the header). Pure.
 *
 * Inputs: A = the fee Transaction's `amount`; C = what that fee credits the
 * agent (`consultationFeeCredit`: A - F since #395, A on an older row, 0 when
 * it credits nothing); F = Paystack's fee (unknown unless well-formed).
 *
 *  - client gets P: A - F (client-caused; held when F >= A) or A (agent-caused);
 *  - the refund row takes R off the agent: out of the hold, the whole credit
 *    (R = C); from available, R = max(P, C) (a net-credited fee gives back
 *    what the client gets; an older full-credit one the whole A);
 *  - the agent's total must end at T = 0 (client-caused) or -F
 *    (agent-caused), so the debit is D = C - R - T, which is always 0 or F.
 *
 * Invariants (thrown on violation, never written): D is 0 or F; Seli's net
 * (A - F) - P - (C - R - D) is 0; client-caused, P + F = A.
 *
 * @param input.fundedFrom "hold" or "available", as the engine decided it
 */
export function planCancellationRefund(input: {
  amountMinor: number;
  creditMinor: number;
  feeMinor: unknown;
  feeBorneBy: PaystackFeeBorneBy;
  fundedFrom: Extract<RefundFundedFrom, "hold" | "available">;
}): CancellationRefundPlan {
  const { amountMinor: A, creditMinor: C, feeBorneBy, fundedFrom } = input;
  if (!isWellFormedFee(input.feeMinor)) return { kind: "hold", reason: "paystack_fee_unknown" };
  const F = input.feeMinor;
  // Client-caused: nothing left to give back when Paystack kept it all.
  if (feeBorneBy === "client" && F >= A) return { kind: "hold", reason: "fee_not_less_than_amount", feeMinor: F };
  const P = feeBorneBy === "client" ? A - F : A;
  const R = fundedFrom === "hold" ? C : Math.max(P, C);
  const T = feeBorneBy === "client" ? 0 : -F;
  const D = C - R - T;
  if (D !== 0 && D !== F) {
    throw new Error(`planCancellationRefund: debit ${D} is neither 0 nor the fee ${F} (A ${A}, C ${C}, ${fundedFrom})`);
  }
  if (A - F - P - (C - R - D) !== 0) {
    throw new Error(`planCancellationRefund: Seli's net is not 0 (A ${A}, F ${F}, P ${P}, C ${C}, R ${R}, D ${D})`);
  }
  return {
    kind: "refund",
    feeMinor: F,
    refundAmountMinor: P,
    ...(feeBorneBy === "client" ? { feeKeptMinor: F } : {}),
    agentReversalMinor: R,
    debitMinor: D,
  };
}

/**
 * Paystack's fee for a refund of `fee` (issue #390), or undefined when it is
 * unknown. Pure. The fee Transaction's STORED fee first (#395 "known" or
 * "fee_not_less_than_amount"); only when none is stored (an older row, or
 * #395 "unknown") the fresh Paystack report of the reference, and only in
 * the fee's own currency. Never estimated.
 */
export function feeForRefund(
  fee: Pick<Transaction, "currency"> & Partial<Pick<Transaction, "paystackFeeMinor" | "paystackFeeStatus">>,
  lookup: Pick<PaystackTransactionLookup, "fees" | "currency"> | null
): number | undefined {
  // (#413 D: a "set_aside" row is as unknown as an "unknown" one.)
  if (!isUnresolvedFeeStatus(fee.paystackFeeStatus) && isWellFormedFee(fee.paystackFeeMinor)) return fee.paystackFeeMinor;
  if (lookup && lookup.currency === fee.currency && isWellFormedFee(lookup.fees)) return lookup.fees;
  return undefined;
}

/**
 * Whether a refund of `fee` has to ask Paystack for the fee first (issue
 * #390): no well-formed fee is stored on it. Pure.
 */
export function refundNeedsFeeLookup(fee: Transaction | null): boolean {
  if (!fee) return false;
  return isUnresolvedFeeStatus(fee.paystackFeeStatus) || !isWellFormedFee(fee.paystackFeeMinor);
}

/**
 * Ask Paystack for the fee of `fee`'s reference, when the fee is not stored
 * (issue #390). Called OUTSIDE any Firestore transaction. Never throws:
 * `unavailable` says Paystack could not be reached (the cancel then holds the
 * refund; an admin call answers 502).
 */
export async function lookUpRefundFee(
  fee: Transaction | null
): Promise<{ lookup: PaystackTransactionLookup | null; unavailable: boolean }> {
  if (!refundNeedsFeeLookup(fee) || !fee?.providerTransactionId) return { lookup: null, unavailable: false };
  try {
    return { lookup: await paystackProvider.getTransactionMetadata(fee.providerTransactionId), unavailable: false };
  } catch (error) {
    console.error(`[refund] Paystack lookup of ${fee.id}'s fee failed:`, error);
    return { lookup: null, unavailable: true };
  }
}

/** What `GET /consultations/:id` tells the client before they cancel. */
export interface CancellationRefundPreview {
  /** Whether cancelling NOW gives the fee back. */
  refundable: boolean;
  /**
   * What cancelling now would give back, in minor units of the charged
   * currency: the amount charged minus Paystack's fee (issue #390). Null
   * when Paystack's fee is not known yet (or leaves nothing to give back):
   * never the full amount as a guess.
   */
  amount: Money | null;
  /** Issue #390: Paystack's processing fee the client would not get back, or null while unknown. */
  processingFee: Money | null;
  /** ISO time: slot start minus 24 hours (cancel by then for a refund). */
  refundableUntil: string;
}

/**
 * The refund preview for the client's view of a booking (issue #317), or
 * null when there is nothing to show: a free or unpaid booking, a cancelled
 * one, or one whose charge or slot cannot be read. Pure. The mobile cancel
 * screen (#356) reads this and never computes the rule itself.
 *
 * `refundable` is true only when the client may still cancel (scheduled /
 * confirmed), no refund was written yet, and `at` is no later than
 * `refundableUntil`.
 *
 * Issue #390: a client cancel is client-caused, so the amount is the charge
 * minus Paystack's fee STORED on the fee Transaction (no Paystack call on a
 * read). Not stored yet (or not less than the charge): `amount: null`
 * (and `processingFee: null` while unknown).
 */
export function cancellationRefundPreview(
  booking: Consultation,
  at: Date,
  fee: Transaction | null = null
): CancellationRefundPreview | null {
  if (booking.status === "cancelled" || !isPaidWithMoney(booking)) return null;
  const charged = expectedCharge(booking);
  if (!charged) return null;
  // Same start as the cancel itself uses (review fix): never a slot the agent moved earlier.
  const start = refundWindowStartsAt(booking, fee);
  if (!start) return null;
  const until = new Date(start.getTime() - CLIENT_REFUND_WINDOW_HOURS * HOUR_MS);
  const refundable =
    CLIENT_CANCELLABLE.includes(booking.status) && !booking.refundId && at.getTime() <= until.getTime();
  // The fee Transaction's own money when there is one (what a refund would copy).
  const base: Money = fee ? { amountMinor: fee.amount, currency: fee.currency as Money["currency"] } : charged;
  const feeMinor = fee ? feeForRefund(fee, null) : undefined;
  const processingFee = feeMinor !== undefined ? { amountMinor: feeMinor, currency: base.currency } : null;
  const amount =
    feeMinor !== undefined && feeMinor < base.amountMinor
      ? { amountMinor: base.amountMinor - feeMinor, currency: base.currency }
      : null;
  return { refundable, amount, processingFee, refundableUntil: until.toISOString() };
}

/** The refund outcome a cancel (and the admin endpoint) answers with. */
export interface RefundSummary {
  status: RefundStatus;
  /** What the client gets back; null while the refund is HELD (issue #390). */
  amount: Money | null;
  /**
   * Issue #390: on a client-caused refund, Paystack's processing fee kept
   * out of the charge (`{ amountMinor, currency }`); null when the agent
   * carries it, or while held.
   */
  processingFee: Money | null;
  /** Issue #390: why the refund is held for an admin (only while it is). */
  heldReason?: RefundHeldReason;
}

/** A refund row as the API summarises it: its status and its money. Pure. */
export function refundSummary(row: Transaction): RefundSummary {
  const currency = row.currency as Money["currency"];
  if (row.refundHeldReason) {
    return { status: row.status as RefundStatus, amount: null, processingFee: null, heldReason: row.refundHeldReason };
  }
  const kept = row.paystackFeeKeptMinor;
  return {
    status: row.status as RefundStatus,
    amount: { amountMinor: row.amount, currency },
    processingFee: typeof kept === "number" ? { amountMinor: kept, currency } : null,
  };
}

/**
 * Order of refund statuses: a row only ever moves to a HIGHER rank
 * (completed is final). Issue #413 (B): `closed` (a held row an admin closed
 * with nothing to refund) ranks above everything, so no event can ever move it.
 */
const STATUS_RANK: Record<RefundStatus, number> = { pending: 0, processing: 1, failed: 2, completed: 3, closed: 4 };

/**
 * Issue #383: whether a refund webhook naming Paystack refund `id` is about
 * the row's CURRENT attempt. Pure.
 *  - the id is one of the row's earlier attempts: no;
 *  - the row has a current id: only that id;
 *  - the row has none yet: yes (applied as before #383), unless the event
 *    names no id at all while the row has one.
 */
export function isCurrentAttempt(
  row: Pick<Transaction, "providerRefundId" | "previousProviderRefundIds">,
  id: string | undefined
): boolean {
  if (id && (row.previousProviderRefundIds ?? []).includes(id)) return false;
  if (row.providerRefundId) return id === row.providerRefundId;
  return true;
}

/**
 * Issue #383: the update that retires a failed row's current Paystack
 * attempt on an admin retry: its id moves to `previousProviderRefundIds`
 * (still recognised as ours, never applied) and the row has no current
 * attempt until the engine records the next one. Empty when there is none.
 */
function retireAttempt(row: Pick<Transaction, "providerRefundId" | "previousProviderRefundIds">): Record<string, unknown> {
  if (!row.providerRefundId) return {};
  return {
    providerRefundId: FieldValue.delete(),
    providerRefundStatus: FieldValue.delete(),
    // The whole list, written from the row read in the same transaction
    // (so it is exact without needing arrayUnion).
    previousProviderRefundIds: withPreviousId(row, row.providerRefundId),
  };
}

/** The row's earlier attempt ids plus `id`, once, in order. Pure. */
function withPreviousId(row: Pick<Transaction, "previousProviderRefundIds">, id: string): string[] {
  return [...(row.previousProviderRefundIds ?? []).filter((x) => x !== id), id];
}

/** `retireAttempt` applied to the row in memory (for the answer). */
function retiredInMemory(row: Transaction): Transaction {
  if (!row.providerRefundId) return row;
  const next: Transaction = {
    ...row,
    previousProviderRefundIds: withPreviousId(row, row.providerRefundId),
  };
  delete next.providerRefundId;
  delete next.providerRefundStatus;
  return next;
}

/** How a Paystack refund for a charge compares with our row (issue #413 A, see `matchProviderRefund`). */
export type ProviderRefundMatch =
  /** No refund of the charge that did not fail: nothing to adopt. */
  | { kind: "none" }
  /** Exactly one live refund, of exactly the row's amount AND currency: adopt it. */
  | { kind: "match"; refund: PaystackRefund }
  /**
   * A live refund that is not exactly ours (another amount or currency, one
   * missing, or more than one live refund): never adopted, never followed by
   * a create; the row is flagged for an admin.
   */
  | { kind: "mismatch"; refund: PaystackRefund };

/**
 * Compare the refunds Paystack holds for a charge with our refund row
 * (issue #413 A). Pure. Shared by the engine (`processRefund`, both the
 * lookup-first path and the lookup after a refused create) and the
 * processing poll (#381).
 *
 *  - refunds Paystack reports `failed` are ignored (as before);
 *  - none left: `none` (the engine may create one);
 *  - exactly one left whose `amount` equals the row's `amount` AND whose
 *    `currency` equals the row's `currency` (both REQUIRED: a missing one is
 *    never taken as a match): `match`;
 *  - anything else: `mismatch`, naming the first refund that is not exactly
 *    ours (or, with two exact ones, the second: two live refunds of one charge
 *    are never ours to pick between).
 *
 * @param row the refund row (`amount`, `currency`: minor units of that currency)
 * @param refunds what Paystack reported for the charge's reference
 */
export function matchProviderRefund(
  row: Pick<Transaction, "amount" | "currency">,
  refunds: PaystackRefund[]
): ProviderRefundMatch {
  const live = refunds.filter((r) => r.status !== "failed");
  if (live.length === 0) return { kind: "none" };
  /** Exactly the row's money: both fields reported and equal. */
  const exact = (r: PaystackRefund): boolean =>
    typeof r.amount === "number" && r.amount === row.amount && typeof r.currency === "string" && r.currency === row.currency;
  const notOurs = live.find((r) => !exact(r));
  if (notOurs) return { kind: "mismatch", refund: notOurs };
  if (live.length > 1) return { kind: "mismatch", refund: live[1] };
  return { kind: "match", refund: live[0] };
}

/**
 * Our status for a Paystack refund status. Pure. `processed` is done;
 * `failed` failed; anything else (pending, processing, needs-attention) is
 * on its way.
 */
export function refundStatusFromPaystack(status: string): RefundStatus {
  if (status === "processed") return "completed";
  if (status === "failed") return "failed";
  return "processing";
}

/**
 * Issue #354: what a refund status means for the exception it refunds, or
 * null when the exception keeps its status (`pending` / `processing`: the
 * money is still on its way, the exception stays `open`). Pure.
 */
export function exceptionStatusFor(status: RefundStatus): ConsultationPaymentException["status"] | null {
  if (status === "completed") return "refunded";
  if (status === "failed") return "refund_failed";
  return null;
}

/**
 * Where a refund row's status is mirrored (issue #354): the exception doc for
 * the refund of an unapplied payment, else the booking (issue #317). Either
 * may be absent (bad data): then nothing is mirrored.
 */
function mirrorTarget(row: Transaction): { kind: "exception" | "booking"; ref: FirebaseFirestore.DocumentReference } | null {
  if (row.paymentExceptionId) {
    return { kind: "exception", ref: collections.consultationPaymentExceptions.doc(row.paymentExceptionId) };
  }
  return row.consultationId ? { kind: "booking", ref: collections.consultations.doc(row.consultationId) } : null;
}

/**
 * The mirror update for `target` (issue #354 / #317), or null when there is
 * nothing to write: a booking takes `refundStatus`; an exception takes its
 * own status only on a final outcome (see `exceptionStatusFor`).
 */
function mirrorUpdate(
  kind: "exception" | "booking",
  status: RefundStatus,
  now: Timestamp
): Record<string, unknown> | null {
  if (kind === "booking") return { refundStatus: status, updatedAt: now };
  const exceptionStatus = exceptionStatusFor(status);
  return exceptionStatus ? { status: exceptionStatus, updatedAt: now } : null;
}

/**
 * The client's copy for a payment refunded because the booking moved (issue
 * #354 `paid_for_rescheduled_slot`; wording issue #413 C, decision
 * 2026-11-21, plus the guest variant from the coordinator the same day).
 * Shared by the verify 409 `CONSULTATION_RESCHEDULED` message and the
 * refund notification, so the two can never drift apart. Pure.
 *
 * "we're refunding ... on its way", never "we've refunded": the refund may
 * still be pending, or held for an admin (#392 design).
 *
 *  - app client: "... Please pay again for the new time.";
 *  - guest (`bookedVia: "public_page"`): "... We've emailed you a link to
 *    pay for the new time." (#391 sends that email);
 *  - when the booking no longer awaits payment (paid through a fresh
 *    checkout, or cancelled: #354 fix round) the last sentence is left out.
 *
 * @param opts.guestBooking the booking was made by a guest on a public page
 * @param opts.bookingAwaitingPayment the booking still awaits payment (default true)
 */
export function rescheduledRefundMessage(opts: { guestBooking?: boolean; bookingAwaitingPayment?: boolean } = {}): string {
  const base = "Your consultation moved, so we're refunding your payment in full. Your refund is on its way.";
  if (opts.bookingAwaitingPayment === false) return base;
  return opts.guestBooking
    ? `${base} We've emailed you a link to pay for the new time.`
    : `${base} Please pay again for the new time.`;
}

/** A money amount for notification copy, with its ISO code ("NGN 15,000.00"). */
function describe(amount: Money): string {
  try {
    return formatWithCode(amount);
  } catch {
    return `${amount.amountMinor} ${amount.currency} (minor units)`;
  }
}

// ============================================
// Inside a Firestore transaction: read, then write
// ============================================

/**
 * Everything the refund write needs, read through one Firestore transaction
 * BEFORE any write (Firestore requires reads first).
 */
export interface RefundContext {
  /** The booking's settled Paystack consultation_fee Transaction, or null (legacy data). */
  fee: Transaction | null;
  /** The fee's hold at the server clock. */
  feeHold: FeeHoldStatus | null;
  /**
   * Issue #383: whether a refund written now may be paid OUT OF THE HOLD
   * (`refundFundableFromHold`: clearly held, not within the skew margin of
   * `releaseAt`, and no withdrawal of the agent's at or after that margin).
   * False: it is planned from the available balance, exactly as a released
   * fee. The agent side's cancel refusal still reads `feeHold`.
   */
  fundFromHold: boolean;
  /** The deterministic refund row (exists when this charge was refunded already). */
  refundRef: FirebaseFirestore.DocumentReference | null;
  /** That row, when it exists. */
  existingRefund: Transaction | null;
  /** Issue #390: the ONE fee-debit row this charge can have (`feeDebitDocId(reference)`). */
  debitRef: FirebaseFirestore.DocumentReference | null;
  /** Issue #390: whether that debit already exists (never written twice, across #354 and #390). */
  debitExists: boolean;
  /** The agent's withdrawal lock (#287). */
  lockRef: FirebaseFirestore.DocumentReference;
  /** Whether the lock doc exists (for its counter). */
  lockData: Record<string, unknown> | null;
  /**
   * The agent's available balance in the fee's currency, read whenever a
   * refund may be written now (no row yet, or a HELD one). Issue #413 (F):
   * also when the fee is still held, because the agent's Paystack-fee debit
   * (written in the same commit) comes off the AVAILABLE balance too.
   */
  availableInFeeCurrency: number | null;
}

/**
 * Pick the booking's fee Transaction out of its rows: a `consultation_fee`
 * that is `completed`, paid through Paystack with a reference, preferring
 * the one on the booking's own reference. Pure.
 */
function pickFee(rows: Transaction[], booking: Consultation): Transaction | null {
  const fees = rows.filter(
    (t) =>
      t.type === "consultation_fee" &&
      t.status === "completed" &&
      t.paymentProvider === "paystack" &&
      typeof t.providerTransactionId === "string" &&
      t.providerTransactionId !== ""
  );
  return fees.find((t) => t.providerTransactionId === booking.transactionId) ?? fees[0] ?? null;
}

/**
 * Read the booking's fee Transaction OUTSIDE a transaction, or null (the
 * client's refund preview on GET /consultations/:id, and, issue #390, the
 * check whether Paystack must be asked for the fee before a refund). Same
 * query and pick as `readFeeTransaction`.
 */
export async function findFeeTransaction(booking: Consultation): Promise<Transaction | null> {
  const snap = await collections.transactions.where("consultationId", "==", booking.id).get();
  return pickFee(snap.docs.map((d) => d.data() as Transaction), booking);
}

/**
 * Read the booking's fee Transaction through `tx`, or null (issue #317).
 * Query: transactions where consultationId == id (single equality; the type
 * is checked in memory). Also used for the hold updates on complete /
 * no_show and on a reschedule.
 */
export async function readFeeTransaction(tx: FirestoreTransaction, booking: Consultation): Promise<Transaction | null> {
  const snap = await tx.get(collections.transactions.where("consultationId", "==", booking.id));
  return pickFee(snap.docs.map((d) => d.data() as Transaction), booking);
}

/**
 * Read everything a refund of `booking` needs, through `tx` (issue #317).
 * Takes the agent's withdrawal lock READ here (it is written by
 * `writeRefund`), so a concurrent withdrawal of the same agent conflicts and
 * is retried on fresh data. The agent's transactions are read only when the
 * fee is already released (only then does the refund touch the available
 * balance and its shortfall matter). Issue #390: also reads the charge's ONE
 * possible fee debit, so it is never written twice.
 */
export async function readRefundContext(
  tx: FirestoreTransaction,
  booking: Consultation,
  at: Date
): Promise<RefundContext> {
  const fee = await readFeeTransaction(tx, booking);
  const lockRef = collections.withdrawalLocks.doc(booking.agentId);
  if (!fee) {
    return {
      fee: null, feeHold: null, fundFromHold: false, refundRef: null, existingRefund: null, debitRef: null, debitExists: false,
      lockRef, lockData: null, availableInFeeCurrency: null,
    };
  }
  const refundRef = collections.transactions.doc(refundDocId(fee.providerTransactionId!));
  const debitRef = collections.transactions.doc(feeDebitDocId(fee.providerTransactionId!));
  const refundSnap = await tx.get(refundRef);
  const debitSnap = await tx.get(debitRef);
  const lockSnap = await tx.get(lockRef);
  const feeHold = feeHoldStatusAt(fee, at);
  const existingRefund = refundSnap.exists ? (refundSnap.data() as Transaction) : null;
  const lockData = lockSnap.exists ? (lockSnap.data() as Record<string, unknown>) : null;
  // Issue #383: one clock (`at`, read once by the caller's transaction) and
  // the agent's last withdrawal from the lock read just above.
  const lastWithdrawal = lockData?.lastWithdrawalAt as { toMillis?: () => number } | undefined;
  const lastWithdrawalAt =
    lastWithdrawal && typeof lastWithdrawal.toMillis === "function" ? new Date(lastWithdrawal.toMillis()) : null;
  const fundFromHold = refundFundableFromHold(fee, at, lastWithdrawalAt);
  let availableInFeeCurrency: number | null = null;
  // A row HELD for an admin (#390) is still to be worked out: it may come
  // off the available balance when it goes ahead, so read it then too.
  // Issue #413 (F): read whatever the hold says. A refund out of the hold
  // does not touch the available balance, but the agent's fee debit written
  // with it does, and its shortfall is recorded on the row. A CLOSED row
  // (#413 B) is final: never worked out again, nothing to read for it.
  if (!existingRefund || (existingRefund.refundHeldReason && existingRefund.status !== "closed")) {
    // Same query as the withdrawal check, read through this transaction.
    const agentRows = await tx.get(
      collections.transactions.where("agentId", "==", booking.agentId).orderBy("createdAt", "desc")
    );
    const stats = transactionService.computeStats(agentRows.docs.map((d) => d.data() as Transaction), at);
    availableInFeeCurrency = availableBalanceIn(stats, fee.currency as Money["currency"]);
  }
  return {
    fee,
    feeHold,
    fundFromHold,
    refundRef,
    existingRefund,
    debitRef,
    debitExists: debitSnap.exists,
    lockRef,
    lockData,
    availableInFeeCurrency,
  };
}

/** What `planRefund` decided for one refund (issue #390), before anything is written. */
export interface PlannedRefund {
  plan: CancellationRefundPlan;
  feeBorneBy: PaystackFeeBorneBy;
  /** Out of the hold, or from the available balance. */
  fundedFrom: Extract<RefundFundedFrom, "hold" | "available">;
  /**
   * The fee fields to store on the fee Transaction in the same commit: a #395
   * "unknown" fee whose Paystack fee the refund's lookup just found (stored
   * once, like the job would). Null when nothing changes.
   */
  resolveFee: Partial<Transaction> | null;
}

/**
 * Work out a refund of `ctx.fee` (issue #390), without writing: who carries
 * Paystack's fee, where the money comes from, and the plan. Pure (given the
 * context read in the transaction and the lookup made before it).
 *
 *  - Paystack's fee: stored on the fee row first, else the lookup
 *    (`feeForRefund`). A #395 "unknown" row the lookup resolves is credited
 *    A - F from now on (`resolveFee`), and planned on that credit;
 *  - funded from "available" only when the fee is not CLEARLY held (released,
 *    or, issue #383, within the skew margin of its release) AND credits the
 *    agent something; a fee credited nowhere (#395 fee >= A) is refunded as
 *    "hold" (nothing of it reached the agent);
 *  - C (the credit) is `consultationFeeCredit` of the fee row as it will be.
 *
 * @throws when the reason has no `feeBorneBy` (a goodwill / other refund
 *   without one; the controller refuses that first)
 */
export function planRefund(
  ctx: RefundContext,
  input: { reason: RefundReason; feeBorneBy?: PaystackFeeBorneBy | null; lookup: PaystackTransactionLookup | null; at: Date }
): PlannedRefund {
  const fee = ctx.fee!;
  const feeBorneBy = feeBorneByFor(input.reason, input.feeBorneBy);
  if (!feeBorneBy) throw new Error(`planRefund: no feeBorneBy for reason ${input.reason}`);
  // A #395 "unknown" fee the lookup now knows: stored in this same commit.
  const resolveFee =
    // (#413 D: a set-aside row is resolved by a refund's lookup too.)
    isUnresolvedFeeStatus(fee.paystackFeeStatus)
      ? resolvedFeeFields(fee, input.lookup, "refund", Timestamp.fromDate(input.at))
      : null;
  const effective = { ...fee, ...(resolveFee ?? {}) } as Transaction;
  const credit = consultationFeeCredit(effective);
  // Issue #383: from the hold only when it is CLEARLY held (`fundFromHold`);
  // a fee at or near its release, or one a withdrawal may have seen
  // released, is planned from available exactly as a released one.
  const fundedFrom = !ctx.fundFromHold && credit !== null ? "available" : "hold";
  const plan = planCancellationRefund({
    amountMinor: fee.amount,
    creditMinor: credit ?? 0,
    feeMinor: feeForRefund(effective, input.lookup),
    feeBorneBy,
    fundedFrom,
  });
  return { plan, feeBorneBy, fundedFrom, resolveFee };
}

/** What `writeRefund` wrote (issue #390). */
export interface RefundWrite {
  /** The refund row as written: live (`pending`), or HELD (`failed`, `refundHeldReason`). */
  row: Transaction;
  /** The agent's fee debit written now (null when none). */
  debit: Transaction | null;
}

/**
 * Write a refund of `ctx.fee` through `tx` (issue #317), together with the
 * fee's hold update and the agent's withdrawal lock. The caller writes the
 * booking in the SAME transaction, with `bookingRefundFields(row)`.
 *
 * Call only after `readRefundContext` found a fee and either no row, or a
 * row HELD for an admin (which is then rewritten in place, keeping its
 * `createdAt`).
 *
 * Issue #390: the money follows `planned` (see `planRefund`):
 *  - HOLD: a `failed` row of amount 0 with `refundHeldReason` (no Paystack
 *    call, no debit); the fee row is FROZEN (`feeHoldFrozenByRefundId`:
 *    counted held, never released or withdrawable) until the retry; the fee
 *    found, if any, is on the row. Only a cancel writes this (an admin call answers instead);
 *  - REFUND: the row with what the client gets (`amount`), what it takes off
 *    the agent (`agentReversalMinor`) and Paystack's fee; out of the hold the
 *    fee's hold becomes "refunded"; a #395 unknown fee just found is stored
 *    on the fee row in the same update; and the agent's fee debit (`tx.create`
 *    at `feeDebitDocId(reference)`) when the plan needs one and the charge
 *    has none yet.
 *
 * @returns the row (and the debit) as written
 */
export function writeRefund(
  tx: FirestoreTransaction,
  ctx: RefundContext,
  input: {
    booking: Consultation;
    reason: RefundReason;
    initiatedBy: string;
    note?: string;
    at: Date;
    planned: PlannedRefund;
  }
): RefundWrite {
  const fee = ctx.fee!;
  const now = Timestamp.fromDate(input.at);
  const { plan, feeBorneBy, fundedFrom, resolveFee } = input.planned;
  const replacing = ctx.existingRefund?.refundHeldReason ? ctx.existingRefund : null;

  // ---- HELD for an admin: nothing is guessed, nothing moves ----
  if (plan.kind === "hold") {
    const row = transactionService.buildHeldConsultationRefund(ctx.refundRef!.id, now, {
      fee,
      agentUserId: input.booking.agentId,
      consultationId: input.booking.id,
      reason: input.reason,
      initiatedBy: input.initiatedBy,
      feeBorneBy,
      heldReason: plan.reason,
      ...(plan.feeMinor !== undefined ? { paystackFeeMinor: plan.feeMinor } : {}),
      note: input.note,
    });
    tx.set(ctx.refundRef!, row);
    // Orchestrator decision 2026-11-19: the fee is FROZEN while its refund is
    // held, so it can never release by the clock or be withdrawn before the
    // admin retry (`feeHoldStatusAt` counts it held). In the same update, a
    // #395 unknown fee found but not less than the charge is stored.
    tx.update(collections.transactions.doc(fee.id), {
      ...(resolveFee ?? {}),
      feeHoldFrozenByRefundId: row.id,
      feeHoldFrozenAt: now,
      updatedAt: now,
    });
    console.error(
      `[refund] ${row.id} of ${input.booking.id} HELD for an admin (${plan.reason}): no Paystack call, no agent debit`
    );
    return { row, debit: null };
  }

  // ---- The refund, under the fee rule ----
  const reversal = plan.agentReversalMinor;
  // The agent's fee debit: only when the plan needs one and this charge was
  // never debited (one per reference, across #354 and #390).
  const debit =
    plan.debitMinor > 0 && !ctx.debitExists
      ? transactionService.buildPaystackFeeDebit(ctx.debitRef!.id, now, {
        agentUserId: input.booking.agentId,
        consultationId: input.booking.id,
        reference: fee.providerTransactionId!,
        feeMinor: plan.debitMinor,
        currency: fee.currency,
        refundId: ctx.refundRef!.id,
      })
      : null;
  if (plan.debitMinor > 0 && ctx.debitExists) {
    console.warn(`[refund] ${ctx.refundRef!.id}: the charge's fee debit already exists; not written again`);
  }
  // #351 / issue #413 (F): how far below zero THIS commit takes the agent's
  // available balance: everything it takes off it, i.e. the reversal when
  // the refund is paid from available, plus the fee debit when one is
  // written now (from the hold too: a debit always comes off available).
  const shortfall = refundShortfall({
    availableMinor: ctx.availableInFeeCurrency ?? 0,
    reversalMinor: fundedFrom === "available" ? reversal : 0,
    debitMinor: debit ? debit.amount : 0,
  });
  const built = transactionService.buildConsultationRefund(ctx.refundRef!.id, now, {
    fee,
    agentUserId: input.booking.agentId,
    consultationId: input.booking.id,
    reason: input.reason,
    initiatedBy: input.initiatedBy,
    fundedFrom,
    balanceShortfallMinor: shortfall,
    note: input.note,
    refundAmountMinor: plan.refundAmountMinor,
    feeBorneBy,
    paystackFeeMinor: plan.feeMinor,
    ...(plan.feeKeptMinor !== undefined ? { paystackFeeKeptMinor: plan.feeKeptMinor } : {}),
    agentReversalMinor: reversal,
    ...(debit || (plan.debitMinor > 0 && ctx.debitExists) ? { feeDebitId: ctx.debitRef!.id } : {}),
  });
  // A held row rewritten keeps when it was first written.
  const row: Transaction = replacing ? { ...built, createdAt: replacing.createdAt } : built;
  if (replacing) tx.set(ctx.refundRef!, row);
  else tx.create(ctx.refundRef!, row);
  if (debit) tx.create(ctx.debitRef!, debit);

  // The fee row: a held fee is now refunded out of its hold (never released),
  // and a #395 unknown fee just found is stored, in ONE update.
  const feeUpdate: Record<string, unknown> = { ...(resolveFee ?? {}) };
  // A fee frozen by this refund's held row is unfrozen now that it is worked
  // out (frozen means held, so it is refunded out of the hold just below).
  if (fee.feeHoldFrozenByRefundId) {
    Object.assign(feeUpdate, { feeHoldFrozenByRefundId: FieldValue.delete(), feeHoldFrozenAt: FieldValue.delete(), updatedAt: now });
  }
  if (fundedFrom === "hold") {
    Object.assign(feeUpdate, {
      "feeHold.state": "refunded",
      "feeHold.endedAt": now,
      "feeHold.endedBy": "refund",
      updatedAt: now,
    });
  }
  if (Object.keys(feeUpdate).length > 0) tx.update(collections.transactions.doc(fee.id), feeUpdate);
  if (shortfall > 0) {
    console.error(
      `[refund] ${row.id}: refund (and any fee debit) takes agent ${input.booking.agentId} ` +
        `${shortfall} ${fee.currency} (minor units) below zero; carried forward, withdrawals blocked until positive`
    );
  }

  // The #287 lock: merged, so the withdrawal's own fields are kept.
  const refundCount = Number(ctx.lockData?.refundCount) || 0;
  const debitCount = Number(ctx.lockData?.feeDebitCount) || 0;
  tx.set(
    ctx.lockRef,
    {
      agentUserId: input.booking.agentId,
      lastRefundId: row.id,
      refundCount: refundCount + 1,
      ...(debit ? { lastFeeDebitId: debit.id, feeDebitCount: debitCount + 1 } : {}),
      updatedAt: now,
    },
    { merge: true }
  );
  return { row, debit };
}

/**
 * #351 / issue #413 (F): how far below zero one commit takes the agent's
 * available balance X, given everything it takes off it (the reversal R
 * when the refund is paid from available, 0 otherwise; the fee debit D
 * written in the same commit, 0 when none is written). Pure:
 *   shortfall = max(0, min(R + D, R + D - X))
 * so X >= R + D gives 0, X <= 0 gives R + D (all of it is below zero), and in
 * between only the part X does not cover.
 */
export function refundShortfall(input: { availableMinor: number; reversalMinor: number; debitMinor: number }): number {
  const out = input.reversalMinor + input.debitMinor;
  return Math.max(0, Math.min(out, out - input.availableMinor));
}

/**
 * The booking fields that mirror a refund row. Issue #413 (portal design):
 * a HELD row also mirrors its `refundHeldReason`, so the booking does not read
 * as a plain failed refund. (A caller replacing a held row clears the
 * booking's copy itself: see `adminRefund`.)
 */
export function bookingRefundFields(row: Transaction): Pick<Consultation, "refundId" | "refundStatus" | "refundHeldReason"> {
  return {
    refundId: row.id,
    refundStatus: row.status as RefundStatus,
    ...(row.refundHeldReason && row.status !== "closed" ? { refundHeldReason: row.refundHeldReason } : {}),
  };
}

// ============================================
// The service
// ============================================

/** What the admin endpoint did. */
export type AdminRefundOutcome =
  | { kind: "not_found" }
  | { kind: "nothing_to_refund"; message: string }
  | { kind: "already_refunded"; refund: Transaction }
  /** A new refund row (and, issue #390, the agent's fee debit when one was written). */
  | { kind: "created"; refund: Transaction; booking: Consultation; debit: Transaction | null }
  /**
   * A failed row back to pending, or (issue #390, `fromHeld`) a HELD row now
   * worked out under the fee rule and rewritten (with its debit, if any).
   */
  | { kind: "retried"; refund: Transaction; booking: Consultation; debit: Transaction | null; fromHeld: boolean }
  /** Issue #390: Paystack's fee is still unknown: nothing written (409 PAYSTACK_FEE_UNKNOWN). */
  | { kind: "fee_unknown" }
  /** Issue #390: a client-borne fee >= the charge: nothing to give back, nothing written (409). */
  | { kind: "fee_not_less_than_amount" }
  /** Issue #390: Paystack could not be asked for the fee: nothing written (502). */
  | { kind: "paystack_unavailable" }
  /** Issue #413 (B): the refund was closed by an admin with nothing to refund: final (409 REFUND_CLOSED). */
  | { kind: "closed"; refund: Transaction };

/**
 * What closing a HELD client-cancel refund as `nothing_to_refund` did
 * (issue #413 B, `closeHeldRefundNothingToRefund`).
 */
export type CloseHeldRefundOutcome =
  /** Unknown booking, no settled fee, or no refund row for it: 404. */
  | { kind: "not_found" }
  /** Closed now. */
  | { kind: "closed"; refund: Transaction; booking: Consultation }
  /** Already closed: nothing written (a repeat, or two admins at once): 200. */
  | { kind: "already_closed"; refund: Transaction }
  /** Not a case the client is owed nothing on: 409 NOT_CLOSABLE, nothing written. */
  | {
      kind: "not_closable";
      why: "agent_caused" | "not_held_fee_not_less_than_amount" | "fee_less_than_amount" | "not_consultation_refund";
    };

/** The admin reasons the endpoint takes, and the row reason each one is stored as. */
export const ADMIN_REFUND_REASONS: Record<string, RefundReason> = {
  agent_no_show: "admin_agent_no_show",
  goodwill: "admin_goodwill",
  other: "admin_other",
};

/** What one run of the processing poll did (issue #381). */
export interface RefundPollResult {
  /** Rows looked at. */
  scanned: number;
  /** Rows Paystack reported processed: now `completed`. */
  completed: number;
  /** Rows Paystack reported failed: now `failed` (client told once). */
  failed: number;
  /** Rows still on their way, not found, or whose refund did not match: nothing written. */
  unchanged: number;
  /** Rows whose Paystack lookup failed (logged; the others still ran). */
  errors: number;
}

/** What one run of the retry job did. */
export interface RefundRetryResult {
  scanned: number;
  processing: number;
  completed: number;
  stillPending: number;
  failed: number;
  errors: number;
}

/** What an admin retry of an unapplied payment's refund did (issue #354). */
export type ExceptionRetryOutcome =
  /** No such refund (or held refund) of THIS booking: 404. */
  | { kind: "not_found" }
  /** The row exists and is not failed: nothing to retry (409 ALREADY_REFUNDED). */
  | { kind: "already_refunded"; refund: Transaction }
  /** The failed row is back to pending, to be sent now. */
  | { kind: "retried"; refund: Transaction }
  /** A held refund was started now: its row (and any agent debit) written. */
  | { kind: "started"; written: UnappliedRefundWrite }
  /** Paystack still reports no well-formed fee: nothing written (409 PAYSTACK_FEE_UNKNOWN). */
  | { kind: "fee_unknown" }
  /** A client-caused fee >= the charge: still held, nothing to refund (409). */
  | { kind: "fee_not_less_than_amount" }
  /** Paystack could not be asked for the fee: nothing written (502). */
  | { kind: "paystack_unavailable" }
  /** Issue #354 fix round: an admin closed it as nothing_to_refund; nothing to retry (409). */
  | { kind: "closed" };

/**
 * What closing an unapplied-payment exception as `nothing_to_refund` did
 * (issue #354 fix round, `closeExceptionNothingToRefund`).
 */
export type CloseExceptionOutcome =
  /** No such exception of THIS booking: 404 (never another booking's record). */
  | { kind: "not_found" }
  /** Closed now: status `nothing_to_refund`. */
  | { kind: "closed"; exception: ConsultationPaymentException }
  /** It was already closed: nothing written (a repeat is a no-op, 200). */
  | { kind: "already_closed"; exception: ConsultationPaymentException }
  /**
   * Not a case the client is owed nothing on: 409 NOT_CLOSABLE, nothing
   * written. `why` names the first rule that failed.
   */
  | { kind: "not_closable"; why: "agent_caused" | "not_held_fee_not_less_than_amount" | "refund_exists" };

/** What a refund webhook did. */
export type RefundWebhookOutcome = "not_refund_event" | "unknown_refund" | "unchanged" | "applied";

class ConsultationRefundService {
  /**
   * Admin manual refund / retry (issue #317), `POST /consultations/:id/refund`.
   * WHO may call it (admins only) is the controller's check, made before
   * this is called.
   *
   * Issue #390: Paystack's fee. Before the transaction, when the fee
   * Transaction has no stored fee, Paystack is asked for the reference
   * (`lookUpRefundFee`, never inside a transaction; unreachable: 502, nothing
   * written). Then one Firestore transaction:
   *  - unknown booking: not_found (404);
   *  - free / unpaid, or no settled Paystack fee (legacy): nothing_to_refund (409);
   *  - a refund row exists and is `failed`: THAT row goes back to `pending`
   *    (attempts reset, due now), never a new row (`retried`);
   *  - (issue #390) a row exists HELD for an admin (fee was unknown): it is
   *    worked out again with the fee now found, under the STORED reason and
   *    `feeBorneBy` (what the cancel decided), and rewritten in place with at
   *    most one fee debit (`retried`, `fromHeld`);
   *  - a row exists in any other status: already_refunded (409);
   *  - otherwise a refund is written exactly as a cancel writes it
   *    (`writeRefund`, under the agent's lock), with `feeBorneBy` deciding
   *    who carries Paystack's fee (`agent_no_show`: always the agent). The
   *    booking's STATUS is not changed (any status may be refunded: an
   *    agent no-show is usually `scheduled` or `completed`).
   * Fee still unknown (or, client-borne, not less than the charge): NOTHING
   * is written (`fee_unknown` / `fee_not_less_than_amount`, 409): an admin
   * call never leaves a held row behind.
   * The Paystack call follows the commit (`processRefund`), started by the
   * controller.
   */
  async adminRefund(input: {
    consultationId: string;
    adminUid: string;
    reason: RefundReason;
    note?: string;
    /** Issue #390: who carries Paystack's fee (required for goodwill / other; agent for no-show). */
    feeBorneBy?: PaystackFeeBorneBy;
    /**
     * Issue #413 (portal design #357): retry mode. Only the EXISTING refund
     * row with this id may be retried (failed -> pending, or a held one
     * worked out again); no new refund is ever created in this mode (no row,
     * or another id: not_found).
     */
    onlyRefundId?: string;
  }): Promise<AdminRefundOutcome> {
    const ref = collections.consultations.doc(input.consultationId);

    // ---- Reads outside any transaction (the Paystack call is slow) ----
    const pre = await ref.get();
    const preBooking = pre.exists ? (pre.data() as Consultation) : null;
    const preFee = preBooking && isPaidWithMoney(preBooking) ? await findFeeTransaction(preBooking) : null;
    // Issue #413 (G): the charge's ONE possible refund row, read BEFORE
    // Paystack is asked anything. A row that is live (pending, processing,
    // completed) answers 409 ALREADY_REFUNDED with no Paystack call at all,
    // so a Paystack outage can no longer turn it into a 502. The
    // transaction below still re-checks (a row written in between is still
    // refused there).
    const preRefundSnap = preFee?.providerTransactionId
      ? await collections.transactions.doc(refundDocId(preFee.providerTransactionId)).get()
      : null;
    const preRefund = preRefundSnap?.exists ? (preRefundSnap.data() as Transaction) : null;
    if (preRefund && preRefund.status === "closed") return { kind: "closed", refund: preRefund };
    if (preRefund && !preRefund.refundHeldReason && preRefund.status !== "failed") {
      return { kind: "already_refunded", refund: preRefund };
    }
    // Retry mode names one row: it must be this booking's row.
    if (input.onlyRefundId !== undefined && preRefund?.id !== input.onlyRefundId) return { kind: "not_found" };

    // ---- Issue #390: ask Paystack for the fee, outside any transaction ----
    // Only when a refund is to be WORKED OUT now (no row, or a held one). A
    // failed live row is only sent again: its money is already decided.
    const needsFee = !preRefund || !!preRefund.refundHeldReason;
    const { lookup, unavailable } = needsFee ? await lookUpRefundFee(preFee) : { lookup: null, unavailable: false };
    if (unavailable) return { kind: "paystack_unavailable" };

    return chargeRuntime.runTransaction<AdminRefundOutcome>(async (tx) => {
      // ---- Reads ----
      const snap = await tx.get(ref);
      if (!snap.exists) return { kind: "not_found" };
      const booking = snap.data() as Consultation;
      const at = chargeRuntime.now();
      if (!isPaidWithMoney(booking)) {
        return { kind: "nothing_to_refund", message: "This consultation was not paid for: there is nothing to refund." };
      }
      const ctx = await readRefundContext(tx, booking, at);
      if (!ctx.fee) {
        console.error(`[refund] admin refund of ${booking.id}: paid, but no settled Paystack consultation_fee Transaction`);
        return {
          kind: "nothing_to_refund",
          message: "No settled Paystack payment is recorded for this consultation, so it cannot be refunded here.",
        };
      }
      const now = Timestamp.fromDate(at);
      // The lookup was made for this fee row; a different row (bad data) gets none.
      const feeLookup = preFee?.id === ctx.fee.id ? lookup : null;

      // ---- An existing row: retry a failed one, else refuse ----
      const existing = ctx.existingRefund;
      // Retry mode: never a new refund, only the named row.
      if (input.onlyRefundId !== undefined && existing?.id !== input.onlyRefundId) return { kind: "not_found" };
      // Issue #413 (B): closed by an admin with nothing to refund: final.
      if (existing && existing.status === "closed") return { kind: "closed", refund: existing };
      if (existing && !existing.refundHeldReason) {
        if (existing.status !== "failed") return { kind: "already_refunded", refund: existing };
        // The ONE backward move: an admin retry of a failed row (same row).
        // Issue #413 (A): a row flagged for a Paystack refund that did not
        // match loses the flag here; `processRefund` looks the charge up
        // FIRST (the row has made a Paystack call before) and flags it again,
        // creating nothing, while that refund is still live at Paystack.
        const retry = {
          status: "pending" as const,
          refundAttempts: 0,
          refundNextAttemptAt: now,
          refundLeaseUntil: FieldValue.delete(),
          refundFailedAt: FieldValue.delete(),
          refundFailureReason: FieldValue.delete(),
          // Issue #383: the failed attempt is over; its id is kept as an
          // earlier attempt, so its late webhooks change nothing.
          ...retireAttempt(existing),
          // Issue #381: set again when the next attempt enters processing.
          processingSince: FieldValue.delete(),
          updatedAt: now,
        };
        tx.update(ctx.refundRef!, retry);
        tx.update(ref, { refundStatus: "pending", updatedAt: now });
        const row = { ...retiredInMemory(existing), status: "pending", refundAttempts: 0, refundNextAttemptAt: now, updatedAt: now } as Transaction;
        delete row.refundLeaseUntil;
        delete row.refundFailedAt;
        delete row.refundFailureReason;
        return {
          kind: "retried", refund: row, booking: { ...booking, refundStatus: "pending", updatedAt: now }, debit: null, fromHeld: false,
        };
      }

      // ---- A new refund, or a HELD one worked out again (issue #390) ----
      // A held row keeps what the cancel decided: its reason, who carries
      // the fee, who started it and its note.
      const reason = existing?.reason ?? input.reason;
      const planned = planRefund(ctx, {
        reason,
        feeBorneBy: existing?.feeBorneBy ?? input.feeBorneBy,
        lookup: feeLookup,
        at,
      });
      if (planned.plan.kind === "hold") {
        // Nothing is written: no guessed figure, no new held row.
        console.warn(`[refund] admin refund of ${booking.id}: ${planned.plan.reason}; nothing written`);
        return planned.plan.reason === "paystack_fee_unknown" ? { kind: "fee_unknown" } : { kind: "fee_not_less_than_amount" };
      }
      const written = writeRefund(tx, ctx, {
        booking,
        reason,
        initiatedBy: existing?.initiatedBy ?? input.adminUid,
        note: existing ? existing.refundNote : input.note,
        at,
        planned,
      });
      const fields = bookingRefundFields(written.row);
      // Issue #413: the booking's copy of a held reason goes when the held
      // row is worked out (the live row has none).
      tx.update(ref, { ...fields, ...(booking.refundHeldReason ? { refundHeldReason: FieldValue.delete() } : {}), updatedAt: now });
      const updated = { ...booking, ...fields, updatedAt: now };
      delete updated.refundHeldReason;
      return existing
        ? { kind: "retried", refund: written.row, booking: updated, debit: written.debit, fromHeld: true }
        : { kind: "created", refund: written.row, booking: updated, debit: written.debit };
    });
  }

  /**
   * Issue #413 (portal design #357): `POST /consultations/:id/refund
   * { refundId }` retries ANY failed refund of the booking by its row id, as
   * stored. WHO may call it (admins only) is the controller's check.
   *
   *  - the row is the booking's OWN consultation refund (an agent or client
   *    cancel, or an admin refund): it is retried by `adminRefund` in retry
   *    mode, under its STORED reason and `feeBorneBy` (a failed row back to
   *    pending, the same row; a HELD row re-reads Paystack's fee first, as
   *    #390 does; a live row: 409; a closed one: 409);
   *  - anything else (the refund of an unapplied payment, #354, or a held
   *    one of those with no row yet): `adminRetryExceptionRefund`, as before.
   * Idempotent: a second call finds the row no longer failed (409).
   */
  async adminRetryRefundById(input: {
    consultationId: string;
    refundId: string;
    adminUid: string;
  }): Promise<{ kind: "booking"; outcome: AdminRefundOutcome } | { kind: "exception"; outcome: ExceptionRetryOutcome }> {
    const snap = await collections.transactions.doc(input.refundId).get();
    const row = snap.exists ? (snap.data() as Transaction) : null;
    if (row && row.type === "refund" && !row.paymentExceptionId && row.consultationId === input.consultationId) {
      const outcome = await this.adminRefund({
        consultationId: input.consultationId,
        adminUid: input.adminUid,
        // Only read for a NEW refund, which retry mode never writes: the
        // stored reason and feeBorneBy of the row are what is used.
        reason: row.reason ?? "admin_other",
        feeBorneBy: row.feeBorneBy,
        onlyRefundId: input.refundId,
      });
      return { kind: "booking", outcome };
    }
    return { kind: "exception", outcome: await this.adminRetryExceptionRefund(input) };
  }

  /**
   * Close a HELD client-cancel refund as `nothing_to_refund` (issue #413 B,
   * decision 2026-11-21), for `POST /consultations/:id/refund/close`. WHO may
   * call it (admins only) is the controller's check. Follows
   * `closeExceptionNothingToRefund`.
   *
   * A client cancel whose Paystack fee F is the whole charge A or more is
   * planned `{ kind: "hold", reason: "fee_not_less_than_amount" }`: a held
   * row (amount 0) and a FROZEN fee row, with no way out. Under the fee rule
   * the client is owed A - F <= 0, i.e. nothing; the agent was credited
   * nothing for that fee (#395: credit = A - F, null when F >= A); Seli's
   * total for the booking is 0. Decision: nobody gets anything.
   *
   * One Firestore transaction re-reads the booking, its fee and its refund row:
   *  - unknown booking, no settled fee, or no refund row: not_found (404);
   *  - already closed: already_closed (200, nothing written);
   *  - closable only when ALL hold: a consultation refund of this booking's
   *    fee (not an unapplied payment's), HELD with reason
   *    `fee_not_less_than_amount`, client-caused (`feeBorneBy: "client"`),
   *    and the STORED Paystack fee on the fee row still gives that hold under
   *    `planCancellationRefund` (no fresh lookup, no estimate). Otherwise
   *    not_closable with the first rule that failed (409).
   * Closing makes NO Paystack call and writes no money: the refund row keeps
   * amount 0 and becomes `closed` (`refundClosedAt`, `refundClosedBy`,
   * `refundClosedOutcome`), so it leaves the admin failed list; the fee row
   * loses its freeze in the same commit; no fee debit is written; the
   * booking mirrors `refundStatus: "closed"` and loses `refundHeldReason`.
   */
  async closeHeldRefundNothingToRefund(input: { consultationId: string; adminUid: string }): Promise<CloseHeldRefundOutcome> {
    const ref = collections.consultations.doc(input.consultationId);
    return chargeRuntime.runTransaction<CloseHeldRefundOutcome>(async (tx) => {
      // ---- Reads (all before any write) ----
      const snap = await tx.get(ref);
      if (!snap.exists) return { kind: "not_found" };
      const booking = snap.data() as Consultation;
      const fee = await readFeeTransaction(tx, booking);
      if (!fee) return { kind: "not_found" };
      const refundRef = collections.transactions.doc(refundDocId(fee.providerTransactionId!));
      const refundSnap = await tx.get(refundRef);
      if (!refundSnap.exists) return { kind: "not_found" };
      const row = refundSnap.data() as Transaction;

      // ---- Idempotent: closed is final, a repeat writes nothing ----
      if (row.status === "closed") return { kind: "already_closed", refund: row };

      // ---- Only a client-caused hold where the client is owed nothing ----
      if (row.type !== "refund" || row.paymentExceptionId || row.consultationId !== booking.id) {
        return { kind: "not_closable", why: "not_consultation_refund" };
      }
      if (row.refundHeldReason !== "fee_not_less_than_amount" || row.status !== "failed") {
        return { kind: "not_closable", why: "not_held_fee_not_less_than_amount" };
      }
      if (row.feeBorneBy !== "client") return { kind: "not_closable", why: "agent_caused" };
      // The STORED fee only (no lookup, never estimated), re-checked by the rule.
      const plan = planCancellationRefund({
        amountMinor: fee.amount,
        creditMinor: consultationFeeCredit(fee) ?? 0,
        feeMinor: fee.paystackFeeMinor,
        feeBorneBy: "client",
        fundedFrom: "hold",
      });
      if (plan.kind !== "hold" || plan.reason !== "fee_not_less_than_amount") {
        return { kind: "not_closable", why: "fee_less_than_amount" };
      }

      // ---- Close: no Paystack call, no money row ----
      const now = Timestamp.fromDate(chargeRuntime.now());
      const rowUpdate = {
        status: "closed" as const,
        refundClosedAt: now,
        refundClosedBy: input.adminUid,
        refundClosedOutcome: "nothing_to_refund" as const,
        updatedAt: now,
      };
      tx.update(refundRef, rowUpdate);
      // The fee is unfrozen in the SAME commit. It still credits nobody
      // (F >= A: `consultationFeeCredit` is null), so nothing becomes
      // available or withdrawable by this.
      if (fee.feeHoldFrozenByRefundId) {
        tx.update(collections.transactions.doc(fee.id), {
          feeHoldFrozenByRefundId: FieldValue.delete(),
          feeHoldFrozenAt: FieldValue.delete(),
          updatedAt: now,
        });
      }
      tx.update(ref, { refundStatus: "closed", refundHeldReason: FieldValue.delete(), updatedAt: now });
      console.warn(
        `[refund] held refund ${row.id} of ${booking.id} closed as nothing_to_refund by admin ${input.adminUid}: ` +
          `Paystack fee ${fee.paystackFeeMinor} >= charge ${fee.amount} ${fee.currency}; no Paystack call, no money`
      );
      const updated = { ...booking, refundStatus: "closed" as const, updatedAt: now };
      delete updated.refundHeldReason;
      return { kind: "closed", refund: { ...row, ...rowUpdate }, booking: updated };
    });
  }

  /**
   * Admin retry of the refund of an unapplied payment (issue #354),
   * `POST /consultations/:id/refund` with `{ refundId }`. WHO may call it
   * (admins only) is the controller's check.
   *
   * `refundId` is the refund row's id, `refundDocId(reference)`; for a HELD
   * refund (no row yet) it is the id the row WILL take, as listed by
   * `listExceptionRefundsNeedingAdmin`. These refunds are created
   * automatically by `settlePayment`; an admin never invents one, only
   * retries one the engine gave up on or held.
   *
   * A refund ROW exists (one Firestore transaction):
   *  - not a refund of an unapplied payment, or one of another booking:
   *    not_found (404; never another booking's money);
   *  - the row is not `failed`: already_refunded (409);
   *  - otherwise THAT row goes back to `pending` (attempts reset, due now),
   *    never a new row, and its exception back to `open` (`retried`).
   *
   * No row: the refund is HELD (Paystack's fee unknown, or not less than the
   * charge). Paystack is asked for the reference again FIRST (outside any
   * transaction); then:
   *  - still no well-formed fee: fee_unknown (409 PAYSTACK_FEE_UNKNOWN),
   *    NOTHING written;
   *  - Paystack cannot be reached: paystack_unavailable (502), nothing written;
   *  - the fee is known: one Firestore transaction re-reads the exception,
   *    the booking, the refund row, the debit and (agent-caused) the agent's
   *    withdrawal lock, and applies the fee rule exactly as settlePayment does
   *    (`writeUnappliedRefund`: one refund row, at most one debit, both with
   *    `tx.create`). A row found by then (a concurrent retry won):
   *    already_refunded. A client-caused fee >= the charge stays held:
   *    fee_not_less_than_amount (409), with the fee now stored.
   * The Paystack refund call follows the commit, started by the controller
   * (`processRefund` for `retried`, `startUnappliedRefund` for `started`).
   */
  async adminRetryExceptionRefund(input: {
    consultationId: string;
    refundId: string;
  }): Promise<ExceptionRetryOutcome> {
    const ref = collections.transactions.doc(input.refundId);

    // ---- A held refund has no row: handled on its own path ----
    const rowSnap = await ref.get();
    if (!rowSnap.exists) return this.startHeldExceptionRefund(input);

    return chargeRuntime.runTransaction<ExceptionRetryOutcome>(async (tx) => {
      // ---- Reads ----
      const snap = await tx.get(ref);
      if (!snap.exists) return { kind: "not_found" as const };
      const row = snap.data() as Transaction;
      if (row.type !== "refund" || !row.paymentExceptionId || row.consultationId !== input.consultationId) {
        return { kind: "not_found" as const };
      }
      const exceptionRef = collections.consultationPaymentExceptions.doc(row.paymentExceptionId);
      const exceptionSnap = await tx.get(exceptionRef);
      if (row.status !== "failed") return { kind: "already_refunded" as const, refund: row };

      // ---- The ONE backward move: failed -> pending, on the same row ----
      const now = Timestamp.fromDate(chargeRuntime.now());
      tx.update(ref, {
        status: "pending",
        refundAttempts: 0,
        refundNextAttemptAt: now,
        refundLeaseUntil: FieldValue.delete(),
        refundFailedAt: FieldValue.delete(),
        // Issue #413 (A) / #383: as for a booking's refund.
        refundFailureReason: FieldValue.delete(),
        ...retireAttempt(row),
        processingSince: FieldValue.delete(),
        updatedAt: now,
      });
      if (exceptionSnap.exists) tx.update(exceptionRef, { status: "open", updatedAt: now });
      const next = { ...retiredInMemory(row), status: "pending", refundAttempts: 0, refundNextAttemptAt: now, updatedAt: now } as Transaction;
      delete next.refundFailureReason;
      delete next.refundLeaseUntil;
      delete next.refundFailedAt;
      return { kind: "retried" as const, refund: next };
    });
  }

  /**
   * The no-row half of `adminRetryExceptionRefund` (issue #354): start the
   * refund of a HELD exception once Paystack reports its fee. See there.
   */
  private async startHeldExceptionRefund(input: { consultationId: string; refundId: string }): Promise<ExceptionRetryOutcome> {
    // ---- Which exception of THIS booking would get this row id ----
    // Single-equality query (no composite index); the id is matched in memory.
    const listed = await collections.consultationPaymentExceptions.where("consultationId", "==", input.consultationId).get();
    const found = listed.docs
      .map((d) => d.data() as ConsultationPaymentException)
      .find((ex) => ex.consultationId === input.consultationId && refundDocId(ex.reference) === input.refundId);
    if (!found) return { kind: "not_found" };
    // Issue #354 fix round: closed as nothing_to_refund is final.
    if (found.status === "nothing_to_refund") return { kind: "closed" };

    // ---- Ask Paystack again, FIRST (never inside a transaction) ----
    let lookup: Awaited<ReturnType<typeof paystackProvider.getTransactionMetadata>>;
    try {
      lookup = await paystackProvider.getTransactionMetadata(found.reference);
    } catch (error) {
      console.error(`[refund] admin retry of ${input.refundId}: Paystack lookup of the charge failed:`, error);
      return { kind: "paystack_unavailable" };
    }
    const fee = feeForException(found, lookup);
    if (fee === undefined) {
      // Still unknown: nothing is guessed and nothing is written.
      console.warn(`[refund] admin retry of ${input.refundId}: Paystack still reports no well-formed fee; held`);
      return { kind: "fee_unknown" };
    }

    // ---- One transaction: re-read everything, then apply the fee rule ----
    const exceptionRef = collections.consultationPaymentExceptions.doc(found.id);
    const bookingRef = collections.consultations.doc(input.consultationId);
    return chargeRuntime.runTransaction<ExceptionRetryOutcome>(async (tx) => {
      const exceptionSnap = await tx.get(exceptionRef);
      const bookingSnap = await tx.get(bookingRef);
      if (!exceptionSnap.exists || !bookingSnap.exists) return { kind: "not_found" };
      const exception = exceptionSnap.data() as ConsultationPaymentException;
      const booking = bookingSnap.data() as Consultation;
      // Closed between the read above and this transaction: still final.
      if (exception.status === "nothing_to_refund") return { kind: "closed" };
      // Issue #354 fix round: the lock (and the debit) is the agent who
      // CAUSED it (moved the booking), not the booking's agent now.
      const reads = await readUnappliedRefund(
        tx,
        exception.reference,
        isAgentCausedException(exception.reason) ? feeDebitAgentFor(exception, booking) : null
      );
      // A concurrent retry (or a settle) wrote the row first: never a second one.
      if (reads.existingRefund) return { kind: "already_refunded", refund: reads.existingRefund };
      const plan = planUnappliedRefund(exception, feeForException(exception, lookup));
      if (plan.kind === "hold" && plan.reason === "paystack_fee_unknown") return { kind: "fee_unknown" };
      const now = Timestamp.fromDate(chargeRuntime.now());
      const written = writeUnappliedRefund(tx, reads, { exception, exceptionExisted: true, plan, booking, now });
      if (!written.refund) return { kind: "fee_not_less_than_amount" };
      return { kind: "started", written };
    });
  }

  /**
   * Close a client-caused exception as `nothing_to_refund` (issue #354 fix
   * round, orchestrator decision 2026-11-17), for
   * `POST /consultations/:id/payment-exceptions/:exceptionId/close`. WHO may
   * call it (admins only) is the controller's check.
   *
   * Under the fee rule a client-caused refund is the charge minus Paystack's
   * fee. When that fee is the whole charge or more, the client is owed
   * nothing and Paystack would refuse a non-positive refund, so the exception
   * sits `refund_failed` / `fee_not_less_than_amount` for ever. This lets an
   * admin close it, so it leaves `GET /consultations/payment-exceptions`.
   *
   * NO money moves: no Paystack call, no refund row, no Transaction of any
   * kind. Only the exception doc changes (status, closedAt, closedBy). Seli
   * carries nothing: the client paid X, Paystack kept a fee >= X.
   *
   * One Firestore transaction re-reads the exception and its ONE possible
   * refund row (`refundDocId(reference)`), then:
   *  - not an exception of THIS booking: not_found (404);
   *  - already `nothing_to_refund`: already_closed (200, nothing written:
   *    a repeat, or two admins at once, is a no-op);
   *  - agent-caused (`paid_for_rescheduled_slot`): not_closable. The client
   *    is owed the whole charge there whatever the fee;
   *  - not held as `fee_not_less_than_amount`, or the STORED Paystack fee
   *    (the only fee ever used: never estimated, no fresh lookup) does not
   *    give that hold again under `planUnappliedRefund`: not_closable;
   *  - a refund row exists for the reference: not_closable (money is already
   *    on its way; never closed over it);
   *  - otherwise: closed.
   *
   * @param input.exceptionId the exception's id (= its Paystack reference)
   * @param input.adminUid the admin closing it (stored as `closedBy`)
   */
  async closeExceptionNothingToRefund(input: {
    consultationId: string;
    exceptionId: string;
    adminUid: string;
  }): Promise<CloseExceptionOutcome> {
    const exceptionRef = collections.consultationPaymentExceptions.doc(input.exceptionId);
    return chargeRuntime.runTransaction<CloseExceptionOutcome>(async (tx) => {
      // ---- Reads (all before the one write) ----
      const exceptionSnap = await tx.get(exceptionRef);
      if (!exceptionSnap.exists) return { kind: "not_found" };
      const exception = exceptionSnap.data() as ConsultationPaymentException;
      // Scoped to the booking in the path: never another booking's record.
      if (exception.consultationId !== input.consultationId) return { kind: "not_found" };
      const refundSnap = await tx.get(collections.transactions.doc(refundDocId(exception.reference)));

      // ---- Idempotent: closed is final, a repeat writes nothing ----
      if (exception.status === "nothing_to_refund") return { kind: "already_closed", exception };

      // ---- Only a client-caused case where the client is owed nothing ----
      if (isAgentCausedException(exception.reason)) return { kind: "not_closable", why: "agent_caused" };
      const plan = planUnappliedRefund(exception, exception.paystackFeeMinor);
      if (
        exception.status !== "refund_failed" ||
        exception.refundFailureReason !== "fee_not_less_than_amount" ||
        plan.kind !== "hold" ||
        plan.reason !== "fee_not_less_than_amount"
      ) {
        return { kind: "not_closable", why: "not_held_fee_not_less_than_amount" };
      }
      if (refundSnap.exists || exception.refundId) return { kind: "not_closable", why: "refund_exists" };

      // ---- Close: the exception doc only, no money ----
      const now = Timestamp.fromDate(chargeRuntime.now());
      const closed: ConsultationPaymentException = {
        ...exception,
        status: "nothing_to_refund",
        closedAt: now,
        closedBy: input.adminUid,
        updatedAt: now,
      };
      tx.update(exceptionRef, { status: closed.status, closedAt: now, closedBy: input.adminUid, updatedAt: now });
      console.warn(
        `[refund] exception ${exception.reference} on ${exception.consultationId} closed as nothing_to_refund by ` +
          `admin ${input.adminUid}: Paystack fee ${exception.paystackFeeMinor} >= charge ${exception.amountMinor} ` +
          `${exception.currency}; no refund, no Transaction`
      );
      return { kind: "closed", exception: closed };
    });
  }

  /**
   * Refunds of unapplied payments that need an admin (issue #354), for
   * `GET /consultations/payment-exceptions`: every exception whose status is
   * `refund_failed`, newest first. Each comes with `retryRefundId`, the id
   * to pass to `POST /consultations/:id/refund { refundId }`:
   *  - HELD (no row; `refundFailureReason` says why): the id the refund row
   *    will take;
   *  - the row failed at Paystack: that row's id (it is also in
   *    `GET /transactions?role=admin&type=refund&status=failed`).
   * Single-equality query (no composite index); sorted in memory. An
   * exception closed as `nothing_to_refund` (fix round) is no longer
   * `refund_failed`, so it drops out of this list.
   */
  async listExceptionRefundsNeedingAdmin(): Promise<Array<ConsultationPaymentException & { retryRefundId: string }>> {
    const snap = await collections.consultationPaymentExceptions.where("status", "==", "refund_failed").get();
    return snap.docs
      .map((d) => d.data() as ConsultationPaymentException)
      .filter((ex) => ex.status === "refund_failed")
      .map((ex) => ({ ...ex, retryRefundId: ex.refundId ?? refundDocId(ex.reference) }))
      .sort((a, b) => (b.createdAt?.toMillis?.() ?? 0) - (a.createdAt?.toMillis?.() ?? 0));
  }

  /**
   * Send one refund row to Paystack (issue #317). Safe to call any number of
   * times, from anywhere (the cancel handler, the admin endpoint, the retry
   * job): only a `pending` row whose lease is free is worked on, and only one
   * worker at a time.
   *
   *  1. CLAIM (a transaction): the row must be `pending` and not leased;
   *     its lease is taken, `refundAttempts` and `refundProviderCalls` go up.
   *     Whether to LOOK UP first is decided from the calls made BEFORE this
   *     claim: any earlier call may have reached Paystack (a timeout, a crash
   *     after the call), so it is looked up, never blindly repeated.
   *  2. LOOK UP (repeat tries only): a Paystack refund of this charge that
   *     did not fail is ADOPTED (status mapped, id stored). None: go on.
   *  3. CREATE: Paystack POST /refund with the charge's reference and the
   *     row's own `amount` / `currency`. Accepted: `processing` (or
   *     `completed` when Paystack already says processed). Refused by
   *     Paystack (a 4xx, e.g. "already reversed"): look up and adopt; never a
   *     second create in this run.
   *  4. A try that got no refund leaves the row `pending`, due again in
   *     REFUND_RETRY_MINUTES, with the error; after MAX_REFUND_ATTEMPTS it is
   *     `failed`, the client is told it is delayed, and admins see it in the
   *     refund list.
   *
   * @returns the row after this run, or null when it does not exist
   */
  async processRefund(refundId: string): Promise<Transaction | null> {
    const ref = collections.transactions.doc(refundId);
    // ---- 1. Claim ----
    const claim = await chargeRuntime.runTransaction<
      { kind: "skip"; row: Transaction | null } | { kind: "go"; row: Transaction; lookUpFirst: boolean }
    >(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return { kind: "skip", row: null };
      const row = snap.data() as Transaction;
      const at = chargeRuntime.now();
      if (row.type !== "refund" || row.status !== "pending") return { kind: "skip", row };
      const leaseMs = row.refundLeaseUntil?.toMillis?.() ?? 0;
      if (leaseMs > at.getTime()) return { kind: "skip", row };
      const calls = Number(row.refundProviderCalls) || 0;
      const update = {
        refundLeaseUntil: Timestamp.fromMillis(at.getTime() + REFUND_LEASE_MINUTES * MINUTE_MS),
        refundAttempts: (Number(row.refundAttempts) || 0) + 1,
        refundProviderCalls: calls + 1,
        updatedAt: Timestamp.fromDate(at),
      };
      tx.update(ref, update);
      return { kind: "go", row: { ...row, ...update }, lookUpFirst: calls > 0 };
    });
    if (claim.kind === "skip") return claim.row;
    const row = claim.row;
    const reference = row.providerTransactionId ?? "";

    // ---- 2 + 3. Look up / create ----
    // Issue #413 (A): a refund Paystack holds for the charge is adopted only
    // when it is EXACTLY this row's (amount and currency, `matchProviderRefund`).
    // One that is not stops the run: nothing adopted, nothing created (a
    // second refund on the same charge could pay the client twice), and the
    // row is flagged for an admin.
    let found: PaystackRefund | null = null;
    let mismatch: PaystackRefund | null = null;
    let lastError: string | null = null;
    /** Look the charge up and sort the answer into `found` / `mismatch`. */
    const lookUp = async (): Promise<void> => {
      const match = await this.findLiveRefund(reference, row);
      if (match.kind === "match") found = match.refund;
      else if (match.kind === "mismatch") mismatch = match.refund;
    };
    try {
      if (claim.lookUpFirst) await lookUp();
      if (!found && !mismatch) {
        try {
          found = await paystackProvider.createRefund({
            reference,
            amount: { amountMinor: row.amount, currency: row.currency as Money["currency"] },
            merchantNote: `Seli consultation ${row.consultationId ?? ""} (${row.reason ?? "refund"})`,
          });
        } catch (error) {
          lastError = (error as Error)?.message ?? String(error);
          // Paystack answered and refused (e.g. "Transaction has been fully
          // reversed"): it may already hold a refund for this charge. Look it
          // up and adopt it; never call create again in this run.
          const refused = error instanceof PaystackApiError && !!error.httpStatus && error.httpStatus < 500;
          if (refused) await lookUp();
        }
      }
    } catch (error) {
      // The lookup itself failed (Paystack unreachable): try again later.
      lastError = (error as Error)?.message ?? String(error);
    }

    if (mismatch) return this.flagProviderMismatch(refundId, mismatch);
    if (found) {
      // Issue #383: whatever was created or adopted is the row's CURRENT
      // attempt; an older id is kept in `previousProviderRefundIds`.
      const outcome = await this.advanceRefundStatus(refundId, refundStatusFromPaystack(found.status), {
        providerRefundId: found.id,
        providerRefundStatus: found.status,
        source: "engine",
      });
      return outcome.row;
    }
    return this.recordFailedAttempt(refundId, lastError ?? "Paystack returned no refund");
  }

  /**
   * The Paystack refunds of this charge, compared with the row (issue #413
   * A, `matchProviderRefund`). Throws when Paystack cannot be reached (the
   * caller then tries again later).
   */
  private async findLiveRefund(reference: string, row: Pick<Transaction, "amount" | "currency">): Promise<ProviderRefundMatch> {
    if (!reference) return { kind: "none" };
    const refunds = await paystackProvider.findRefundsForTransaction(reference);
    return matchProviderRefund(row, refunds);
  }

  /**
   * Flag a row whose charge already has a Paystack refund that is not
   * exactly ours (issue #413 A). One transaction; only a row still `pending`
   * (this worker holds its lease) is touched:
   *  - `failed`, `refundFailureReason: "provider_refund_mismatch"`, the
   *    Paystack refund's id, amount and currency as found
   *    (`providerRefundMismatch`); NO `providerRefundId` is written from it
   *    and no status is taken from it;
   *  - its booking (or #354 exception) mirrors `failed`;
   *  - listed for admins by `GET /transactions?role=admin&type=refund&status=failed`.
   * The client is told the refund is delayed ONCE per such Paystack refund:
   * an admin retry that finds the same one again flags the row again but
   * does not notify again. No money moves here: what the refund took off
   * the agent stays as it was (frozen) until an admin decides.
   */
  private async flagProviderMismatch(refundId: string, refund: PaystackRefund): Promise<Transaction | null> {
    const ref = collections.transactions.doc(refundId);
    const result = await chargeRuntime.runTransaction<{ row: Transaction | null; notify: boolean }>(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return { row: null, notify: false };
      const row = snap.data() as Transaction;
      if (row.status !== "pending") return { row, notify: false };
      const mirror = mirrorTarget(row);
      const mirrorSnap = mirror ? await tx.get(mirror.ref) : null;
      const now = Timestamp.fromDate(chargeRuntime.now());
      const seen = {
        id: refund.id,
        amountMinor: typeof refund.amount === "number" ? refund.amount : null,
        currency: typeof refund.currency === "string" ? refund.currency : null,
        status: refund.status,
        seenAt: now,
      };
      const update = {
        status: "failed" as const,
        refundFailureReason: "provider_refund_mismatch" as const,
        providerRefundMismatch: seen,
        refundFailedAt: now,
        refundLastError: "provider_refund_mismatch",
        refundLeaseUntil: FieldValue.delete(),
        updatedAt: now,
      };
      tx.update(ref, update);
      const mirrored = mirror ? mirrorUpdate(mirror.kind, "failed", now) : null;
      if (mirror && mirrorSnap?.exists && mirrored) tx.update(mirror.ref, mirrored);
      console.error(
        `[refund] ${refundId}: Paystack refund ${refund.id} (${seen.amountMinor ?? "?"} ${seen.currency ?? "?"}, ` +
          `${refund.status}) does not match the row (${row.amount} ${row.currency}); not adopted, none created, flagged for an admin`
      );
      const next = { ...row, ...update } as unknown as Transaction;
      delete next.refundLeaseUntil;
      // Told once per Paystack refund: a re-flag of the same one is silent.
      return { row: next, notify: row.providerRefundMismatch?.id !== refund.id };
    });
    if (result.notify && result.row) await this.notifyDelayed(result.row);
    return result.row;
  }

  /**
   * Record a try that got no refund (issue #317): the row stays `pending`
   * and is due again later, or becomes `failed` once MAX_REFUND_ATTEMPTS
   * tries were made. Only a row still `pending` is touched (a webhook may
   * have moved it meanwhile).
   */
  private async recordFailedAttempt(refundId: string, error: string): Promise<Transaction | null> {
    const ref = collections.transactions.doc(refundId);
    const result = await chargeRuntime.runTransaction<{ row: Transaction | null; becameFailed: boolean }>(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return { row: null, becameFailed: false };
      const row = snap.data() as Transaction;
      if (row.status !== "pending") return { row, becameFailed: false };
      const at = chargeRuntime.now();
      const now = Timestamp.fromDate(at);
      const message = error.slice(0, 500);
      if ((Number(row.refundAttempts) || 0) >= MAX_REFUND_ATTEMPTS) {
        // Out of tries: failed, listed for admins, booking (or, for an
        // unapplied payment, its exception: #354) mirrored. Read first.
        const mirror = mirrorTarget(row);
        const mirrorSnap = mirror ? await tx.get(mirror.ref) : null;
        const update = { status: "failed" as const, refundFailedAt: now, refundLastError: message, refundLeaseUntil: FieldValue.delete(), updatedAt: now };
        tx.update(ref, update);
        const mirrored = mirror ? mirrorUpdate(mirror.kind, "failed", now) : null;
        if (mirror && mirrorSnap?.exists && mirrored) tx.update(mirror.ref, mirrored);
        console.error(`[refund] ${refundId} failed after ${row.refundAttempts} attempts: ${message}`);
        const next = { ...row, status: "failed", refundFailedAt: now, refundLastError: message, updatedAt: now } as Transaction;
        delete next.refundLeaseUntil;
        return { row: next, becameFailed: true };
      }
      const update = {
        refundNextAttemptAt: Timestamp.fromMillis(at.getTime() + REFUND_RETRY_MINUTES * MINUTE_MS),
        refundLastError: message,
        refundLeaseUntil: FieldValue.delete(),
        updatedAt: now,
      };
      tx.update(ref, update);
      console.warn(`[refund] ${refundId}: attempt ${row.refundAttempts} got no refund (${message}); retrying later`);
      const next = { ...row, ...update } as unknown as Transaction;
      delete next.refundLeaseUntil;
      return { row: next, becameFailed: false };
    });
    if (result.becameFailed && result.row) await this.notifyDelayed(result.row);
    return result.row;
  }

  /**
   * Move a refund row (and its booking's mirror) FORWARD to `target`
   * (issue #317). Shared by the engine and the webhook. In one transaction:
   *  - a target of the same or a LOWER rank than the row's status writes
   *    nothing (`completed` is final; a repeated or out-of-order event is a
   *    no-op), except that a Paystack refund id the row does not have yet
   *    is stored;
   *  - otherwise the row and the booking's `refundStatus` are updated.
   * Becoming `failed` tells the client the refund is delayed.
   */
  async advanceRefundStatus(
    refundId: string,
    target: RefundStatus,
    extra: {
      providerRefundId?: string;
      providerRefundStatus?: string;
      /**
       * Issue #383: who reports it.
       *  - "engine": a refund `processRefund` just created or adopted: it
       *    becomes the row's CURRENT attempt (`providerRefundId` replaced, the
       *    older id kept in `previousProviderRefundIds`);
       *  - "webhook": a Paystack event. It moves the row only when its refund
       *    id IS the current attempt (or the row has none yet and the id is
       *    not an earlier attempt's); anything else changes nothing;
       *  - omitted (internal callers, tests): as before #383.
       */
      source?: "engine" | "webhook";
    } = {}
  ): Promise<{ changed: boolean; row: Transaction | null }> {
    const ref = collections.transactions.doc(refundId);
    const result = await chargeRuntime.runTransaction<{ changed: boolean; row: Transaction | null }>(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return { changed: false, row: null };
      const row = snap.data() as Transaction;
      // Issue #390: a row HELD for an admin was never sent to Paystack and
      // has no figure yet; no event may move it (only an admin retry does).
      if (row.refundHeldReason) {
        console.warn(`[refund] ${refundId} is held for an admin (${row.refundHeldReason}); status event ignored`);
        return { changed: false, row };
      }
      // Issue #383: a webhook for an EARLIER attempt of this row (or for a
      // refund that is not the current one) is ours, but changes nothing:
      // a late `refund.failed` of attempt 1 must not fail attempt 2.
      if (extra.source === "webhook" && !isCurrentAttempt(row, extra.providerRefundId)) {
        console.warn(
          `[refund] ${refundId}: webhook for Paystack refund ${extra.providerRefundId ?? "(no id)"} is not the current ` +
            `attempt (${row.providerRefundId ?? "none"}); unchanged`
        );
        return { changed: false, row };
      }
      // The booking (#317), or the exception of an unapplied payment (#354).
      const mirror = mirrorTarget(row);
      const mirrorSnap = mirror ? await tx.get(mirror.ref) : null;
      const current = row.status as RefundStatus;
      const now = Timestamp.fromDate(chargeRuntime.now());
      const forward = (STATUS_RANK[target] ?? -1) > (STATUS_RANK[current] ?? 0);
      // A refund id to store: one we never had, or (issue #383) the engine's
      // new current attempt replacing an older one, which is kept.
      const replacing =
        extra.source === "engine" && !!extra.providerRefundId && !!row.providerRefundId && row.providerRefundId !== extra.providerRefundId;
      const newId = !!extra.providerRefundId && row.providerRefundId !== extra.providerRefundId && (!row.providerRefundId || replacing);
      const idFields: Record<string, unknown> = newId
        ? {
          providerRefundId: extra.providerRefundId,
          ...(replacing ? { previousProviderRefundIds: withPreviousId(row, row.providerRefundId!) } : {}),
        }
        : {};
      /** The row in memory with the id fields applied. */
      const withId = (base: Transaction): Transaction =>
        newId
          ? {
            ...base,
            providerRefundId: extra.providerRefundId,
            ...(replacing ? { previousProviderRefundIds: withPreviousId(row, row.providerRefundId!) } : {}),
          }
          : base;

      if (!forward) {
        // Nothing moves backward. Only store a refund id (see above).
        if (!newId) return { changed: false, row };
        tx.update(ref, { ...idFields, updatedAt: now });
        return { changed: false, row: withId({ ...row, updatedAt: now }) };
      }

      const update: Record<string, unknown> = {
        status: target,
        refundLeaseUntil: FieldValue.delete(),
        updatedAt: now,
        ...idFields,
        ...(extra.providerRefundStatus ? { providerRefundStatus: extra.providerRefundStatus } : {}),
        ...(target === "completed" ? { refundedAt: now } : {}),
        ...(target === "failed" ? { refundFailedAt: now } : {}),
        // Issue #381: when it entered processing (the poll's age field).
        ...(target === "processing" ? { processingSince: now } : {}),
      };
      tx.update(ref, update);
      const mirrored = mirror ? mirrorUpdate(mirror.kind, target, now) : null;
      if (mirror && mirrorSnap?.exists && mirrored) tx.update(mirror.ref, mirrored);
      const next = { ...row, ...update } as unknown as Transaction;
      delete next.refundLeaseUntil;
      return { changed: true, row: next };
    });
    if (result.changed && result.row?.status === "failed") await this.notifyDelayed(result.row);
    return result;
  }

  /**
   * Refund webhooks (issue #317): `refund.pending` / `refund.processing` ->
   * processing, `refund.processed` -> completed, `refund.failed` -> failed.
   * The caller has ALREADY verified Paystack's signature.
   *
   * Matched by the charge's reference (`data.transaction_reference` -> our
   * deterministic row id), else by Paystack's refund id (`data.id`). An event
   * for a refund we do not know writes nothing (`unknown_refund`; the HTTP
   * answer is still 200). A repeated or out-of-order event writes nothing
   * (`advanceRefundStatus`).
   *
   * @param body the parsed webhook body
   */
  async handleWebhook(body: { event?: unknown; data?: unknown }): Promise<RefundWebhookOutcome> {
    const event = typeof body.event === "string" ? body.event : "";
    const targets: Record<string, RefundStatus> = {
      "refund.pending": "processing",
      "refund.processing": "processing",
      "refund.processed": "completed",
      "refund.failed": "failed",
    };
    if (!event.startsWith("refund.")) return "not_refund_event";
    const target = targets[event];
    const refund = (body.data && typeof body.data === "object" ? body.data : {}) as Record<string, unknown>;
    const reference = typeof refund.transaction_reference === "string" ? refund.transaction_reference : "";
    const providerId = refund.id !== undefined && refund.id !== null ? String(refund.id) : "";
    if (!target) return "unchanged"; // a refund event we do not act on

    // Find our row: by the charge's reference first, then by Paystack's refund id.
    let rowId: string | null = null;
    if (reference) {
      const snap = await collections.transactions.doc(refundDocId(reference)).get();
      if (snap.exists && (snap.data() as Transaction).type === "refund") rowId = snap.id;
    }
    if (!rowId && providerId) {
      const q = await collections.transactions.where("providerRefundId", "==", providerId).limit(1).get();
      if (!q.empty) rowId = q.docs[0].id;
    }
    // Issue #383: an earlier attempt's id is still ours (it changes nothing).
    if (!rowId && providerId) {
      const q = await collections.transactions.where("previousProviderRefundIds", "array-contains", providerId).limit(1).get();
      if (!q.empty) rowId = q.docs[0].id;
    }
    if (!rowId) {
      console.warn(`[refund webhook] ${event} for an unknown refund (reference ${reference || "-"}, id ${providerId || "-"}); ignored`);
      return "unknown_refund";
    }
    const status = typeof refund.status === "string" ? refund.status.toLowerCase() : event.slice("refund.".length);
    // Issue #383: only the row's CURRENT attempt moves it (checked inside
    // the transaction, so a retry that just started attempt 2 always wins).
    const outcome = await this.advanceRefundStatus(rowId, target, {
      ...(providerId ? { providerRefundId: providerId } : {}),
      providerRefundStatus: status,
      source: "webhook",
    });
    return outcome.changed ? "applied" : "unchanged";
  }

  /**
   * The processing poll (issue #381), run every 30 minutes
   * (`pollProcessingConsultationRefunds` in index.ts). A refund Paystack
   * accepted whose final webhook never arrives would sit in `processing`
   * for ever; this asks Paystack and moves it forward under the SAME rules
   * as the webhook.
   *
   * Picks `refund` rows in `processing` for more than
   * REFUND_PROCESSING_POLL_AFTER_MINUTES, oldest first, at most
   * REFUND_PROCESSING_POLL_BATCH_SIZE per run: by `processingSince` (index
   * transactions(type, status, processingSince)), then, for rows that
   * entered processing before #381 and have no such field, by `updatedAt`
   * (index transactions(type, status, updatedAt)).
   *
   * Each row is looked up at Paystack:
   *  - by its CURRENT attempt (`providerRefundId`, `fetchRefund`): that
   *    refund must be of the row's charge and of exactly its amount and
   *    currency, else nothing is applied;
   *  - with no id yet, among the charge's refunds
   *    (`findRefundsForTransaction`) with the #413 exact match
   *    (`matchProviderRefund`): only a `match` is applied (it then becomes
   *    the current attempt); a mismatch is left for the engine / an admin.
   * The answer goes through `advanceRefundStatus` only (forward-only:
   * processed -> completed, failed -> failed and the client told once,
   * still pending / processing -> nothing written). The poll never calls
   * `createRefund` and never writes a money row; a second run right after
   * writes nothing. A held row, a non-refund row, a row no longer
   * `processing` is skipped. One row's Paystack error is logged and counted;
   * the others still run.
   */
  async pollProcessingRefunds(): Promise<RefundPollResult> {
    const result: RefundPollResult = { scanned: 0, completed: 0, failed: 0, unchanged: 0, errors: 0 };
    const cutoff = Timestamp.fromMillis(chargeRuntime.now().getTime() - REFUND_PROCESSING_POLL_AFTER_MINUTES * MINUTE_MS);
    // ---- Pick: rows with the age field first, then older rows by updatedAt ----
    const bySince = await collections.transactions
      .where("type", "==", "refund")
      .where("status", "==", "processing")
      .where("processingSince", "<=", cutoff)
      .orderBy("processingSince", "asc")
      .limit(REFUND_PROCESSING_POLL_BATCH_SIZE)
      .get();
    const picked = new Map<string, Transaction>();
    for (const doc of bySince.docs) picked.set(doc.id, doc.data() as Transaction);
    if (picked.size < REFUND_PROCESSING_POLL_BATCH_SIZE) {
      const byUpdated = await collections.transactions
        .where("type", "==", "refund")
        .where("status", "==", "processing")
        .where("updatedAt", "<=", cutoff)
        .orderBy("updatedAt", "asc")
        .limit(REFUND_PROCESSING_POLL_BATCH_SIZE)
        .get();
      for (const doc of byUpdated.docs) {
        const row = doc.data() as Transaction;
        // Only the rows the first query cannot see (no age field yet).
        if (row.processingSince || picked.has(doc.id)) continue;
        if (picked.size >= REFUND_PROCESSING_POLL_BATCH_SIZE) break;
        picked.set(doc.id, row);
      }
    }

    for (const [id, row] of picked) {
      // Belt and braces: never a held row, a row of another type, or one
      // that is no longer processing.
      if (row.type !== "refund" || row.status !== "processing" || row.refundHeldReason) continue;
      result.scanned++;
      try {
        const answer = await this.lookUpForPoll(row);
        if (!answer) {
          result.unchanged++;
          continue;
        }
        const outcome = await this.advanceRefundStatus(id, refundStatusFromPaystack(answer.refund.status), {
          providerRefundId: answer.refund.id,
          providerRefundStatus: answer.refund.status,
          // The current attempt's own answer is checked like a webhook; a
          // matched refund on a row with no id yet becomes its current one.
          source: answer.byId ? "webhook" : "engine",
        });
        if (outcome.changed && outcome.row?.status === "completed") result.completed++;
        else if (outcome.changed && outcome.row?.status === "failed") result.failed++;
        else result.unchanged++;
      } catch (error) {
        // One row must not stop the run.
        console.error(`[refund poll] ${id}: Paystack lookup failed:`, error);
        result.errors++;
      }
    }
    return result;
  }

  /**
   * What Paystack says about one processing row, for the poll (issue #381),
   * or null when nothing may be applied (no such refund, another charge's,
   * not exactly the row's money, or a mismatch among the charge's refunds).
   * Throws on a Paystack error (counted by the caller).
   */
  private async lookUpForPoll(row: Transaction): Promise<{ refund: PaystackRefund; byId: boolean } | null> {
    const reference = row.providerTransactionId ?? "";
    if (row.providerRefundId) {
      const refund = await paystackProvider.fetchRefund(row.providerRefundId);
      if (!refund || refund.id !== row.providerRefundId) return null;
      // The refund must be this row's charge's (when Paystack names it) and
      // exactly the row's money (#413): else it is not ours to apply.
      if (refund.transactionReference && reference && refund.transactionReference !== reference) {
        console.error(`[refund poll] ${row.id}: Paystack refund ${refund.id} names another charge; not applied`);
        return null;
      }
      if (matchProviderRefund(row, [{ ...refund, status: "processing" }]).kind !== "match") {
        console.error(`[refund poll] ${row.id}: Paystack refund ${refund.id} does not match the row's amount/currency; not applied`);
        return null;
      }
      return { refund, byId: true };
    }
    if (!reference) return null;
    const match = matchProviderRefund(row, await paystackProvider.findRefundsForTransaction(reference));
    if (match.kind !== "match") {
      if (match.kind === "mismatch") {
        console.error(`[refund poll] ${row.id}: Paystack refund ${match.refund.id} does not match the row; not applied`);
      }
      return null;
    }
    return { refund: match.refund, byId: false };
  }

  /**
   * The retry job (issue #317), run every 15 minutes (`retryConsultationRefunds`
   * in index.ts): every `pending` row whose next try is due is sent to
   * `processRefund`, at most REFUND_RETRY_BATCH_SIZE per run, oldest due
   * first. A row whose Paystack call failed or timed out is therefore
   * retried, with a lookup first, until it succeeds or runs out of tries.
   *
   * Index: transactions(status, refundNextAttemptAt) in firestore.indexes.json.
   * Only refund rows carry `refundNextAttemptAt`, so no other row is returned.
   */
  async retryDueRefunds(): Promise<RefundRetryResult> {
    const result: RefundRetryResult = { scanned: 0, processing: 0, completed: 0, stillPending: 0, failed: 0, errors: 0 };
    const due = Timestamp.fromDate(chargeRuntime.now());
    const snap = await collections.transactions
      .where("status", "==", "pending")
      .where("refundNextAttemptAt", "<=", due)
      .orderBy("refundNextAttemptAt", "asc")
      .limit(REFUND_RETRY_BATCH_SIZE)
      .get();
    result.scanned = snap.size;
    for (const doc of snap.docs) {
      if ((doc.data() as Transaction).type !== "refund") continue;
      try {
        const row = await this.processRefund(doc.id);
        if (row?.status === "processing") result.processing++;
        else if (row?.status === "completed") result.completed++;
        else if (row?.status === "failed") result.failed++;
        else result.stillPending++;
      } catch (error) {
        // One row must not stop the run.
        console.error(`[refund retry] ${doc.id} failed:`, error);
        result.errors++;
      }
    }
    return result;
  }

  // ============================================
  // Notifications
  // ============================================

  /**
   * Tell both sides a refund was written (issue #317): the client that it is
   * on its way, the agent that the fee was refunded (and from where). A
   * failed notification never fails the refund.
   *
   * Issue #390 copy:
   *  - client-caused, Paystack kept a fee above 0: "Your refund of <refund>
   *    is on its way. The payment provider kept a processing fee of <fee>.";
   *  - the agent was debited Paystack's fee (`debit`): the agent's message
   *    adds "The <fee> payment processing fee was taken from your balance.";
   *  - a refund HELD for an admin (fee unknown): the client is told it is
   *    delayed; the agent is told nothing has moved yet.
   */
  async notifyCreated(row: Transaction, booking: Consultation, debit: Transaction | null = null): Promise<void> {
    const currency = row.currency as Money["currency"];
    const common = { type: "consultation_refunded" as const, relatedEntityType: "consultation" as const, relatedEntityId: booking.id };
    if (row.refundHeldReason) {
      await this.notifyDelayed(row);
      return;
    }
    const amount = describe({ amountMinor: row.amount, currency });
    const kept = Number(row.paystackFeeKeptMinor) || 0;
    const keptLine = kept > 0 ? ` The payment provider kept a processing fee of ${describe({ amountMinor: kept, currency })}.` : "";
    await notificationService
      .notifyUser({ ...common, userId: booking.userId, title: "Refund on its way", body: `Your refund of ${amount} is on its way.${keptLine}` })
      .catch((e) => console.error("[refund] client notify failed:", e));
    const debitLine = debit
      ? ` The ${describe({ amountMinor: debit.amount, currency: debit.currency as Money["currency"] })} payment processing fee was taken from your balance.`
      : "";
    // The agent is told about the CHARGE (refund + any fee kept = what the client paid).
    const charged = describe({ amountMinor: row.amount + kept, currency });
    const client = booking.clientName || "your client";
    const agentBody =
      row.refundFundedFrom === "available"
        ? `The ${charged} consultation fee from ${client} was refunded to them and taken off your balance.${debitLine}`
        : `The ${charged} consultation fee from ${client} was refunded to them. ` +
          "It was still held until your meeting, so it came off your held balance." +
          (debit ? debitLine : " Your available balance is unchanged.");
    await notificationService
      .notifyUser({ ...common, userId: booking.agentId, title: "Consultation fee refunded", body: agentBody })
      .catch((e) => console.error("[refund] agent notify failed:", e));
  }

  /**
   * Tell the client a payment we could not apply is being given back (issue
   * #354). A failed notification never fails the refund. Copy (decision
   * 2026-11-16: it says who carries Paystack's fee):
   *
   *  - paid on a checkout retired by a reschedule (agent-caused): refunded
   *    IN FULL, and the client is asked to pay again for the new time;
   *  - client-caused (paid after a cancel / paid twice): the amount refunded
   *    AND the processing fee Paystack kept, both in the charge currency
   *    (refunded + kept = charged). With a fee of 0 the second sentence is
   *    left out (nothing was kept).
   */
  async notifyUnappliedRefund(
    row: Transaction,
    exception: ConsultationPaymentException,
    /**
     * Issue #354 fix round: whether the booking still awaits payment. An
     * agent-caused refund only asks the client to pay again when it does;
     * after the booking was paid through a fresh checkout, or cancelled, the
     * "pay again" sentence would be wrong. Defaults to true (the #354 copy).
     */
    opts: {
      bookingAwaitingPayment?: boolean;
      /** Issue #413 (C): the booking was made by a guest on a public page (emailed pay link). */
      guestBooking?: boolean;
    } = {}
  ): Promise<void> {
    const currency = row.currency as Money["currency"];
    const amount = describe({ amountMinor: row.amount, currency });
    const kept = Number(row.paystackFeeKeptMinor) || 0;
    const keptLine = kept > 0 ? ` The payment provider kept a processing fee of ${describe({ amountMinor: kept, currency })}.` : "";
    // Issue #413 (C): "we're refunding", not "we've refunded": the refund
    // may still be pending at Paystack, or held for an admin.
    const body =
      exception.reason === "paid_for_rescheduled_slot"
        ? rescheduledRefundMessage(opts)
        : exception.reason === "booking_not_payable"
          ? `This consultation was no longer awaiting payment, so we're refunding ${amount}. Your refund is on its way.${keptLine}`
          : `This consultation was already paid for, so we're refunding your extra payment of ${amount}. Your refund is on its way.${keptLine}`;
    await notificationService
      .notifyUser({
        userId: row.userId,
        type: "consultation_refunded",
        title: "Payment refunded",
        body,
        relatedEntityType: "consultation",
        relatedEntityId: exception.consultationId,
      })
      .catch((e) => console.error("[refund] unapplied-payment notify failed:", e));
  }

  /**
   * Tell the agent Paystack's fee on a refunded payment was taken from their
   * balance (issue #354, agent-caused: they moved the consultation after the
   * quote lock and the client paid the old checkout). A failed notification
   * never fails the refund or the debit.
   */
  async notifyFeeDebit(debit: Transaction): Promise<void> {
    const fee = describe({ amountMinor: debit.amount, currency: debit.currency as Money["currency"] });
    await notificationService
      .notifyUser({
        userId: debit.agentId ?? debit.userId,
        type: "consultation_refunded",
        title: "Processing fee taken from your balance",
        body:
          "A client paid the old checkout after you moved their consultation, so we refunded them in full. " +
          `The ${fee} payment processing fee was taken from your balance.`,
        relatedEntityType: "consultation",
        relatedEntityId: debit.consultationId ?? debit.id,
      })
      .catch((e) => console.error("[refund] fee-debit notify failed:", e));
  }

  /** Tell the client their refund is delayed (a row became `failed`). */
  private async notifyDelayed(row: Transaction): Promise<void> {
    await notificationService
      .notifyUser({
        userId: row.userId,
        type: "consultation_refund_delayed",
        title: "Refund delayed",
        body: "Your refund is delayed. We're on it.",
        relatedEntityType: "consultation",
        relatedEntityId: row.consultationId ?? row.id,
      })
      .catch((e) => console.error("[refund] delayed notify failed:", e));
  }
}

export const consultationRefundService = new ConsultationRefundService();
