// ============================================
// Consultation fee hold (issue #317, "hold consultation fees")
// ============================================
//
// WHY: without a hold an agent could book a paid consultation, withdraw the
// fee straight away, then cancel; the client is owed a full refund, and the
// money to pay it would have to come from Seli. So a paid consultation fee is
// HELD (counted in the agent's `heldBalance`, never in `availableBalance`,
// never withdrawable) until the meeting has happened:
//
//   released when EITHER
//    - the clock passes `releaseAt` (slot end + FEE_HOLD_AFTER_SLOT_HOURS), or
//    - the agent side marked the booking `completed` / `no_show`
//      (`meetingClosedAt`) AND the clock has passed the slot start (a booking
//      marked complete before its slot started keeps its hold until then);
//   never released when the held fee was refunded (`state: "refunded"`).
//
// A refund while the fee is held is paid OUT OF THE HOLD: the agent's
// available balance does not move (they never had the money). Only an admin
// can refund a fee that was already released; that refund comes off the
// agent's available balance, which may then go below zero (#351 reversal):
// the shortfall is carried forward and withdrawals are blocked until the
// balance is positive again. Seli never absorbs it.
//
// The clock rule is ONE pure function, `feeHoldStatusAt`, used by the stats
// (GET /transactions/stats), the withdrawal check, the cancel path (an agent
// may not cancel once the fee is released) and the admin refund path.

import { Timestamp } from "firebase-admin/firestore";
import type { Consultation, FeeHold, Transaction } from "../types";
import { hoursAfter, slotEndsAt, slotStartsAt } from "../consultations/slot-time";

/** How long after the slot ENDS a fee releases by itself, in hours. */
export const FEE_HOLD_AFTER_SLOT_HOURS = 24;

/** Where a consultation fee stands at one moment. */
export type FeeHoldStatus =
  /** Not withdrawable: counted in `heldBalance`. */
  | "held"
  /** Withdrawable: counted in `availableBalance`. */
  | "released"
  /** Given back to the client out of the hold: counted nowhere. */
  | "refunded";

/** Milliseconds of a stored Timestamp, or null when the value is not one. */
function millisOf(value: unknown): number | null {
  return value && typeof (value as Timestamp).toMillis === "function" ? (value as Timestamp).toMillis() : null;
}

/**
 * Where a consultation fee Transaction stands at time `at`. Pure.
 *
 *  - (issue #390) frozen by a refund HELD for an admin
 *    (`feeHoldFrozenByRefundId`): HELD, unless it was already refunded;
 *  - (issue #382) frozen by an open no-show report (`feeHoldFrozenByReportId`):
 *    HELD, unless it was already refunded;
 *  - no `feeHold` (a fee written before #317 and not yet backfilled): HELD.
 *    The safe reading: it can be refunded from the hold, never withdrawn
 *    then cancelled. `npm run backfill:fee-holds` stamps every such fee
 *    (released when its meeting is over, held otherwise);
 *  - `state: "refunded"` / `"released"`: as stored (final);
 *  - `state: "held"`: released once `at` reaches `releaseAt`, or once the
 *    meeting was closed (`meetingClosedAt`) and `at` has reached
 *    `slotStartAt`; held otherwise. A hold with an unreadable time is held.
 *
 * @param fee the stored fee Transaction (only `feeHold` and `feeHoldFrozenByRefundId` are read)
 * @param at the server clock
 */
export function feeHoldStatusAt(
  fee: Pick<Transaction, "feeHold"> & Partial<Pick<Transaction, "feeHoldFrozenByRefundId" | "feeHoldFrozenByReportId">>,
  at: Date
): FeeHoldStatus {
  const hold = fee.feeHold;
  if (hold?.state === "refunded") return "refunded";
  // Issue #390: a fee whose refund is HELD for an admin is frozen: held,
  // whatever the clock or a closed meeting say, until the refund is worked out.
  if (fee.feeHoldFrozenByRefundId) return "held";
  // Issue #382: so is a fee whose client reported the meeting did not
  // happen: frozen until an admin decides (the freeze wins over any release
  // rule, the clock's and a closed meeting's alike).
  if (fee.feeHoldFrozenByReportId) return "held";
  if (!hold) return "held";
  if (hold.state === "released") return "released";
  const now = at.getTime();
  const releaseAt = millisOf(hold.releaseAt);
  if (releaseAt !== null && now >= releaseAt) return "released";
  const slotStart = millisOf(hold.slotStartAt);
  if (millisOf(hold.meetingClosedAt) !== null && slotStart !== null && now >= slotStart) return "released";
  return "held";
}

// ============================================
// Issue #383: clock skew at release
// ============================================
//
// Two server instances' clocks can disagree by a little. A cancel on an
// instance whose clock is a minute BEHIND could see a fee still "held" that a
// withdrawal on an instance a minute AHEAD already saw "released" and paid
// out. Funding that refund "from the hold" would then give back money that
// is no longer there (Seli would carry it). So a refund is funded from the
// hold only when the fee is clearly held: the transaction's own clock is
// more than a margin before `releaseAt`, AND the agent's last withdrawal
// (stamped on `withdrawalLocks/{agentUid}`, read in the same transaction) is
// not at or after `releaseAt - margin`. Otherwise it is planned exactly as a
// released fee: from the agent's available balance (#351, the agent carries
// it; never Seli).

/** Issue #383: how close to `releaseAt` a held fee stops funding a refund from the hold, in ms. */
export const RELEASE_SKEW_MARGIN_MS = 2 * 60 * 1000;

/**
 * Whether a refund of `fee` at time `at` may be paid OUT OF THE HOLD (issue
 * #383). Pure. One clock: `at` is the time read once by the transaction.
 *
 *  - not held at `at` (released, refunded): false;
 *  - frozen (by a held refund, #390, or an open no-show report, #382) since
 *    before `releaseAt - margin`: true, unless the agent's last withdrawal
 *    is at or after `releaseAt - margin` (review round 1: a withdrawal on a
 *    clock running ahead, made before the freeze, may have taken it);
 *  - no readable `releaseAt` (a pre-#317 fee not backfilled): true (held,
 *    the safe reading, as `feeHoldStatusAt`);
 *  - otherwise true only when `at < releaseAt - margin` AND the agent's last
 *    withdrawal is not at or after `releaseAt - margin`.
 *
 * @param fee the stored fee Transaction
 * @param at the transaction's clock
 * @param lastWithdrawalAt when the agent last withdrew (from their withdrawal lock), or null
 */
export function refundFundableFromHold(
  fee: Pick<Transaction, "feeHold"> &
    Partial<Pick<Transaction, "feeHoldFrozenByRefundId" | "feeHoldFrozenAt" | "feeHoldFrozenByReportId" | "feeHoldFrozenByReportAt">>,
  at: Date,
  lastWithdrawalAt: Date | null
): boolean {
  if (feeHoldStatusAt(fee, at) !== "held") return false;
  const releaseAt = millisOf(fee.feeHold?.releaseAt);
  if (releaseAt === null) return true;
  const cutoff = releaseAt - RELEASE_SKEW_MARGIN_MS;
  const frozenAt = [
    fee.feeHoldFrozenByRefundId ? millisOf(fee.feeHoldFrozenAt) : null,
    // Issue #382: an open no-show report freezes the fee too.
    fee.feeHoldFrozenByReportId ? millisOf(fee.feeHoldFrozenByReportAt) : null,
  ].filter((v): v is number => v !== null);
  // The agent's last withdrawal, at or after the cutoff: it may have seen
  // the fee released (on a clock running ahead) and paid it out, even when
  // the fee was frozen before the cutoff on this one (review round 1, from
  // #382 QA: a freeze only stops withdrawals AFTER it; it cannot tell a
  // withdrawal stamped late by a fast clock from one made later). Planned
  // from available then: the agent carries it, never Seli.
  const withdrewNearRelease = !!lastWithdrawalAt && lastWithdrawalAt.getTime() >= cutoff;
  // Frozen before the cutoff: held ever since, whatever this clock says.
  if (frozenAt.some((ms) => ms < cutoff)) return !withdrewNearRelease;
  if (at.getTime() >= cutoff) return false;
  return !withdrewNearRelease;
}

/**
 * The hold to stamp on a fee Transaction when its booking is paid
 * (`settlePayment`). Pure. Starts "held"; releases at slot end + 24 h.
 *
 * @param booking the booking as it is being settled (its slot fields)
 */
export function initialFeeHold(
  booking: Pick<Consultation, "scheduledDate" | "scheduledTime" | "timezone" | "durationMinutes">
): FeeHold {
  return {
    state: "held",
    slotStartAt: Timestamp.fromDate(slotStartsAt(booking)),
    releaseAt: Timestamp.fromDate(hoursAfter(slotEndsAt(booking), FEE_HOLD_AFTER_SLOT_HOURS)),
  };
}

/**
 * The hold after a RESCHEDULE (issue #317). Pure. Both times can only move
 * LATER: moving a booking earlier (or into the past) must never release its
 * fee sooner, or an agent could reschedule a paid booking to yesterday,
 * withdraw the fee, and cancel. Everything else is kept as it was.
 *
 * Review fix (round 1): a hold that is no longer HELD at `at` (released by
 * the clock or by a closed meeting, or refunded) is NEVER moved. The stored
 * `state` stays "held" after a clock release, so checking `state` alone let
 * a reschedule put a released (and maybe withdrawn) fee back on hold, after
 * which the agent could cancel and the refund came "from the hold" that no
 * longer existed. The edit route refuses such a reschedule outright
 * (409 FEE_RELEASED); this is the second line.
 *
 * @param at the server clock
 * @returns the new hold, or null when nothing changes (not held at `at`,
 *   or a move that is not later)
 */
export function rescheduledFeeHold(
  hold: FeeHold,
  booking: Pick<Consultation, "scheduledDate" | "scheduledTime" | "timezone" | "durationMinutes">,
  at: Date
): FeeHold | null {
  if (hold.state !== "held" || feeHoldStatusAt({ feeHold: hold }, at) !== "held") return null;
  const next = initialFeeHold(booking);
  const slotStartAt = next.slotStartAt.toMillis() > (millisOf(hold.slotStartAt) ?? 0) ? next.slotStartAt : hold.slotStartAt;
  const releaseAt = next.releaseAt.toMillis() > (millisOf(hold.releaseAt) ?? 0) ? next.releaseAt : hold.releaseAt;
  if (slotStartAt === hold.slotStartAt && releaseAt === hold.releaseAt) return null;
  return { ...hold, slotStartAt, releaseAt };
}

/**
 * The hold a fee written BEFORE #317 gets from the one-off backfill
 * (`npm run backfill:fee-holds`). Pure. The decision for existing balances:
 *  - the booking is `completed` or `no_show`, or its slot ended more than
 *    24 hours ago: "released" (the meeting has happened, the agent keeps it);
 *  - otherwise (still to come, or cancelled less than a day after its slot):
 *    "held", with the normal release time, exactly as a new payment.
 * A fee whose booking is gone, or has no readable slot, is left alone by the
 * script (it stays held: the safe reading) and is reported.
 *
 * @param booking the fee's booking
 * @param at the clock of the backfill run
 */
export function legacyFeeHold(
  booking: Pick<Consultation, "status" | "scheduledDate" | "scheduledTime" | "timezone" | "durationMinutes">,
  at: Date
): FeeHold {
  const hold = initialFeeHold(booking);
  const meetingOver =
    booking.status === "completed" || booking.status === "no_show" || at.getTime() >= hold.releaseAt.toMillis();
  if (!meetingOver) return hold;
  const now = Timestamp.fromDate(at);
  return { ...hold, state: "released", endedAt: now, endedBy: "legacy_backfill" };
}
