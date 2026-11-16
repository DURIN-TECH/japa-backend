// ============================================
// Consultation refund engine (issue #317, part 1 of 4)
// ============================================
//
// When a PAID consultation is cancelled, this decides the refund by the
// product rule, writes it as its own `refund` Transaction, and sends it back
// through Paystack's refund API for the full amount charged. Admins can issue
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
//  - The refund row copies `amount` + `currency` from the fee Transaction
//    (minor units of the charged currency, FX markup included). Paystack is
//    called with exactly those, never a recomputed or converted figure.
//  - The row's doc id is `refund_<fee Paystack reference>` (`refundDocId`):
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
// Out of scope here: payments that cannot be applied to a booking
// (`consultationPaymentExceptions`, #354), the mobile and portal screens
// (#356, #357).

import { FieldValue, Timestamp } from "firebase-admin/firestore";
import type { Transaction as FirestoreTransaction } from "firebase-admin/firestore";
import type {
  Consultation,
  RefundFundedFrom,
  RefundReason,
  RefundStatus,
  Transaction,
} from "../types";
import type { Money } from "../types/money";
import { collections } from "../utils/firebase";
import { chargeRuntime } from "./charge-checkout.service";
import { expectedCharge } from "./consultation-charge.service";
import { availableBalanceIn, transactionService } from "./transaction.service";
import { notificationService } from "./notification.service";
import { PaystackApiError, PaystackRefund, paystackProvider } from "./billing/paystack.provider";
import { feeHoldStatusAt, FeeHoldStatus } from "../money/fee-hold";
import { formatWithCode } from "../money/money";
import { slotStartsAt } from "../consultations/slot-time";

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
 * The refund row's doc id for one charge (issue #317): `refund_<reference>`.
 * Deterministic, so one Paystack charge can only ever have one refund row.
 * A "/" (impossible in our own `cons-<id>-<uuid>` references, but a doc id
 * must never contain one) is replaced, so the id is always one document.
 */
export function refundDocId(reference: string): string {
  return `refund_${reference.replace(/\//g, "_")}`;
}

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
 * The refund a cancel gives (the rule table in the header). Pure.
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
  at: Date
): CancellationRefundDecision {
  if (!isPaidWithMoney(booking)) return { kind: "nothing" };
  if (actor === "agent_side") return { kind: "full", reason: "agent_cancelled" };
  let startMs: number;
  try {
    startMs = slotStartsAt(booking).getTime();
  } catch {
    return { kind: "full", reason: "client_cancelled" };
  }
  // Exactly 24 hours before the slot still counts as "24 hours or more".
  return startMs - at.getTime() >= CLIENT_REFUND_WINDOW_HOURS * HOUR_MS
    ? { kind: "full", reason: "client_cancelled" }
    : { kind: "late_client_cancel" };
}

/** What `GET /consultations/:id` tells the client before they cancel. */
export interface CancellationRefundPreview {
  /** Whether cancelling NOW gives the fee back. */
  refundable: boolean;
  /** The full amount charged, in minor units of the charged currency. */
  amount: Money;
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
 */
export function cancellationRefundPreview(booking: Consultation, at: Date): CancellationRefundPreview | null {
  if (booking.status === "cancelled" || !isPaidWithMoney(booking)) return null;
  const amount = expectedCharge(booking);
  if (!amount) return null;
  let until: Date;
  try {
    until = new Date(slotStartsAt(booking).getTime() - CLIENT_REFUND_WINDOW_HOURS * HOUR_MS);
  } catch {
    return null;
  }
  const refundable =
    CLIENT_CANCELLABLE.includes(booking.status) && !booking.refundId && at.getTime() <= until.getTime();
  return { refundable, amount, refundableUntil: until.toISOString() };
}

/** The refund outcome a cancel (and the admin endpoint) answers with. */
export interface RefundSummary {
  status: RefundStatus;
  amount: Money;
}

/** A refund row as the API summarises it: its status and its money. Pure. */
export function refundSummary(row: Transaction): RefundSummary {
  return {
    status: row.status as RefundStatus,
    amount: { amountMinor: row.amount, currency: row.currency },
  };
}

/** Order of refund statuses: a row only ever moves to a HIGHER rank (completed is final). */
const STATUS_RANK: Record<RefundStatus, number> = { pending: 0, processing: 1, failed: 2, completed: 3 };

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
  /** The deterministic refund row (exists when this charge was refunded already). */
  refundRef: FirebaseFirestore.DocumentReference | null;
  /** That row, when it exists. */
  existingRefund: Transaction | null;
  /** The agent's withdrawal lock (#287). */
  lockRef: FirebaseFirestore.DocumentReference;
  /** Whether the lock doc exists (for its counter). */
  lockData: Record<string, unknown> | null;
  /** The agent's available balance in the fee's currency, read ONLY when the fee is released. */
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
 * balance and its shortfall matter).
 */
export async function readRefundContext(
  tx: FirestoreTransaction,
  booking: Consultation,
  at: Date
): Promise<RefundContext> {
  const fee = await readFeeTransaction(tx, booking);
  const lockRef = collections.withdrawalLocks.doc(booking.agentId);
  if (!fee) {
    return { fee: null, feeHold: null, refundRef: null, existingRefund: null, lockRef, lockData: null, availableInFeeCurrency: null };
  }
  const refundRef = collections.transactions.doc(refundDocId(fee.providerTransactionId!));
  const refundSnap = await tx.get(refundRef);
  const lockSnap = await tx.get(lockRef);
  const feeHold = feeHoldStatusAt(fee, at);
  let availableInFeeCurrency: number | null = null;
  if (feeHold === "released" && !refundSnap.exists) {
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
    refundRef,
    existingRefund: refundSnap.exists ? (refundSnap.data() as Transaction) : null,
    lockRef,
    lockData: lockSnap.exists ? (lockSnap.data() as Record<string, unknown>) : null,
    availableInFeeCurrency,
  };
}

/**
 * Write a refund row for `ctx.fee` through `tx` (issue #317), together with
 * the fee's hold update and the agent's withdrawal lock. The caller writes
 * the booking in the SAME transaction, with `bookingRefundFields(row)`.
 *
 * Call only after `readRefundContext` found a fee and no existing row.
 *
 * @returns the row as written
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
  }
): Transaction {
  const fee = ctx.fee!;
  const now = Timestamp.fromDate(input.at);
  // A held fee pays its own refund; a released one comes off the balance.
  const fundedFrom: RefundFundedFrom = ctx.feeHold === "released" ? "available" : "hold";
  // #351: how far below zero this refund takes the available balance.
  const available = ctx.availableInFeeCurrency ?? 0;
  const shortfall = fundedFrom === "available" ? Math.max(0, Math.min(fee.amount, fee.amount - available)) : 0;
  const row = transactionService.buildConsultationRefund(ctx.refundRef!.id, now, {
    fee,
    agentUserId: input.booking.agentId,
    consultationId: input.booking.id,
    reason: input.reason,
    initiatedBy: input.initiatedBy,
    fundedFrom,
    balanceShortfallMinor: shortfall,
    note: input.note,
  });
  tx.set(ctx.refundRef!, row);

  // A held fee is now refunded out of its hold: it is never released.
  if (fundedFrom === "hold") {
    tx.update(collections.transactions.doc(fee.id), {
      "feeHold.state": "refunded",
      "feeHold.endedAt": now,
      "feeHold.endedBy": "refund",
      updatedAt: now,
    });
  }
  if (shortfall > 0) {
    console.error(
      `[refund] ${row.id}: refund of a released fee takes agent ${input.booking.agentId} ` +
        `${shortfall} ${fee.currency} (minor units) below zero; carried forward, withdrawals blocked until positive`
    );
  }

  // The #287 lock: merged, so the withdrawal's own fields are kept.
  const refundCount = Number(ctx.lockData?.refundCount) || 0;
  tx.set(
    ctx.lockRef,
    { agentUserId: input.booking.agentId, lastRefundId: row.id, refundCount: refundCount + 1, updatedAt: now },
    { merge: true }
  );
  return row;
}

/** The booking fields that mirror a refund row. */
export function bookingRefundFields(row: Transaction): Pick<Consultation, "refundId" | "refundStatus"> {
  return { refundId: row.id, refundStatus: row.status as RefundStatus };
}

// ============================================
// The service
// ============================================

/** What the admin endpoint did. */
export type AdminRefundOutcome =
  | { kind: "not_found" }
  | { kind: "nothing_to_refund"; message: string }
  | { kind: "already_refunded"; refund: Transaction }
  | { kind: "created"; refund: Transaction; booking: Consultation }
  | { kind: "retried"; refund: Transaction; booking: Consultation };

/** The admin reasons the endpoint takes, and the row reason each one is stored as. */
export const ADMIN_REFUND_REASONS: Record<string, RefundReason> = {
  agent_no_show: "admin_agent_no_show",
  goodwill: "admin_goodwill",
  other: "admin_other",
};

/** What one run of the retry job did. */
export interface RefundRetryResult {
  scanned: number;
  processing: number;
  completed: number;
  stillPending: number;
  failed: number;
  errors: number;
}

/** What a refund webhook did. */
export type RefundWebhookOutcome = "not_refund_event" | "unknown_refund" | "unchanged" | "applied";

class ConsultationRefundService {
  /**
   * Admin manual refund / retry (issue #317), `POST /consultations/:id/refund`.
   * WHO may call it (admins only) is the controller's check, made before
   * this is called.
   *
   * One Firestore transaction:
   *  - unknown booking: not_found (404);
   *  - free / unpaid, or no settled Paystack fee (legacy): nothing_to_refund (409);
   *  - a refund row exists and is `failed`: THAT row goes back to `pending`
   *    (attempts reset, due now), never a new row (`retried`);
   *  - a row exists in any other status: already_refunded (409);
   *  - otherwise a full refund is written exactly as a cancel writes it
   *    (`writeRefund`, under the agent's lock). The booking's STATUS is not
   *    changed (any status may be refunded: an agent no-show is usually
   *    `scheduled` or `completed`).
   * The Paystack call follows the commit (`processRefund`), started by the
   * controller.
   */
  async adminRefund(input: {
    consultationId: string;
    adminUid: string;
    reason: RefundReason;
    note?: string;
  }): Promise<AdminRefundOutcome> {
    const ref = collections.consultations.doc(input.consultationId);
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

      // ---- An existing row: retry a failed one, else refuse ----
      if (ctx.existingRefund) {
        const existing = ctx.existingRefund;
        if (existing.status !== "failed") return { kind: "already_refunded", refund: existing };
        // The ONE backward move: an admin retry of a failed row (same row).
        const retry = {
          status: "pending" as const,
          refundAttempts: 0,
          refundNextAttemptAt: now,
          refundLeaseUntil: FieldValue.delete(),
          refundFailedAt: FieldValue.delete(),
          updatedAt: now,
        };
        tx.update(ctx.refundRef!, retry);
        tx.update(ref, { refundStatus: "pending", updatedAt: now });
        const row = { ...existing, status: "pending", refundAttempts: 0, refundNextAttemptAt: now, updatedAt: now } as Transaction;
        delete row.refundLeaseUntil;
        delete row.refundFailedAt;
        return { kind: "retried", refund: row, booking: { ...booking, refundStatus: "pending", updatedAt: now } };
      }

      // ---- A new full refund ----
      const row = writeRefund(tx, ctx, {
        booking,
        reason: input.reason,
        initiatedBy: input.adminUid,
        note: input.note,
        at,
      });
      const fields = bookingRefundFields(row);
      tx.update(ref, { ...fields, updatedAt: now });
      return { kind: "created", refund: row, booking: { ...booking, ...fields, updatedAt: now } };
    });
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
    let found: PaystackRefund | null = null;
    let lastError: string | null = null;
    try {
      if (claim.lookUpFirst) found = await this.findLiveRefund(reference);
      if (!found) {
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
          if (refused) found = await this.findLiveRefund(reference);
        }
      }
    } catch (error) {
      // The lookup itself failed (Paystack unreachable): try again later.
      lastError = (error as Error)?.message ?? String(error);
    }

    if (found) {
      const outcome = await this.advanceRefundStatus(refundId, refundStatusFromPaystack(found.status), {
        providerRefundId: found.id,
        providerRefundStatus: found.status,
      });
      return outcome.row;
    }
    return this.recordFailedAttempt(refundId, lastError ?? "Paystack returned no refund");
  }

  /** A Paystack refund of this charge that did not fail, or null. */
  private async findLiveRefund(reference: string): Promise<PaystackRefund | null> {
    if (!reference) return null;
    const refunds = await paystackProvider.findRefundsForTransaction(reference);
    return refunds.find((r) => r.status !== "failed") ?? null;
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
        // Out of tries: failed, listed for admins, booking mirrored.
        const bookingRef = row.consultationId ? collections.consultations.doc(row.consultationId) : null;
        const bookingSnap = bookingRef ? await tx.get(bookingRef) : null;
        const update = { status: "failed" as const, refundFailedAt: now, refundLastError: message, refundLeaseUntil: FieldValue.delete(), updatedAt: now };
        tx.update(ref, update);
        if (bookingRef && bookingSnap?.exists) tx.update(bookingRef, { refundStatus: "failed", updatedAt: now });
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
    extra: { providerRefundId?: string; providerRefundStatus?: string } = {}
  ): Promise<{ changed: boolean; row: Transaction | null }> {
    const ref = collections.transactions.doc(refundId);
    const result = await chargeRuntime.runTransaction<{ changed: boolean; row: Transaction | null }>(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return { changed: false, row: null };
      const row = snap.data() as Transaction;
      const bookingRef = row.consultationId ? collections.consultations.doc(row.consultationId) : null;
      const bookingSnap = bookingRef ? await tx.get(bookingRef) : null;
      const current = row.status as RefundStatus;
      const now = Timestamp.fromDate(chargeRuntime.now());
      const forward = (STATUS_RANK[target] ?? -1) > (STATUS_RANK[current] ?? 0);
      const newId = !!extra.providerRefundId && row.providerRefundId !== extra.providerRefundId && !row.providerRefundId;

      if (!forward) {
        // Nothing moves backward. Only fill in a refund id we never had.
        if (!newId) return { changed: false, row };
        tx.update(ref, { providerRefundId: extra.providerRefundId, updatedAt: now });
        return { changed: false, row: { ...row, providerRefundId: extra.providerRefundId, updatedAt: now } };
      }

      const update: Record<string, unknown> = {
        status: target,
        refundLeaseUntil: FieldValue.delete(),
        updatedAt: now,
        ...(newId ? { providerRefundId: extra.providerRefundId } : {}),
        ...(extra.providerRefundStatus ? { providerRefundStatus: extra.providerRefundStatus } : {}),
        ...(target === "completed" ? { refundedAt: now } : {}),
        ...(target === "failed" ? { refundFailedAt: now } : {}),
      };
      tx.update(ref, update);
      if (bookingRef && bookingSnap?.exists) tx.update(bookingRef, { refundStatus: target, updatedAt: now });
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
    if (!rowId) {
      console.warn(`[refund webhook] ${event} for an unknown refund (reference ${reference || "-"}, id ${providerId || "-"}); ignored`);
      return "unknown_refund";
    }
    const status = typeof refund.status === "string" ? refund.status.toLowerCase() : event.slice("refund.".length);
    const outcome = await this.advanceRefundStatus(rowId, target, {
      ...(providerId ? { providerRefundId: providerId } : {}),
      providerRefundStatus: status,
    });
    return outcome.changed ? "applied" : "unchanged";
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
   */
  async notifyCreated(row: Transaction, booking: Consultation): Promise<void> {
    const amount = describe({ amountMinor: row.amount, currency: row.currency as Money["currency"] });
    const common = { type: "consultation_refunded" as const, relatedEntityType: "consultation" as const, relatedEntityId: booking.id };
    await notificationService
      .notifyUser({ ...common, userId: booking.userId, title: "Refund on its way", body: `Your refund of ${amount} is on its way.` })
      .catch((e) => console.error("[refund] client notify failed:", e));
    const agentBody =
      row.refundFundedFrom === "available"
        ? `The ${amount} consultation fee from ${booking.clientName || "your client"} was refunded to them and taken off your balance.`
        : `The ${amount} consultation fee from ${booking.clientName || "your client"} was refunded to them. ` +
          "It was still held until your meeting, so it came off your held balance; your available balance is unchanged.";
    await notificationService
      .notifyUser({ ...common, userId: booking.agentId, title: "Consultation fee refunded", body: agentBody })
      .catch((e) => console.error("[refund] agent notify failed:", e));
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
