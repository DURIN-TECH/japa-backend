/**
 * One-time backfill (issue #317): stamp a `feeHold` on every consultation
 * fee Transaction written before fees were held.
 *
 * WHY: from #317 on a paid consultation fee is HELD (not withdrawable) until
 * the meeting has happened, so an agent cannot withdraw a fee and then cancel
 * the booking (the client's refund would otherwise have to come from Seli).
 * New payments get their hold when they are settled. A fee written BEFORE
 * this change has no `feeHold`, and the balance code counts such a fee as
 * HELD (the safe reading), so until this runs those agents see the money as
 * held.
 *
 * THE DECISION FOR EXISTING BALANCES (`legacyFeeHold`, money/fee-hold.ts):
 *  - the booking is `completed` or `no_show`, or its slot ended more than
 *    24 hours ago: RELEASED (the meeting has happened, the agent keeps it);
 *  - otherwise (still to come, or cancelled less than a day after its slot):
 *    HELD, releasing 24 hours after the slot ends, exactly like a new payment.
 * A fee whose booking is missing, or whose slot cannot be read, is left
 * unstamped (so it stays held) and reported for a human.
 *
 * Idempotent: a fee that already has `feeHold`, or a refund row, is skipped.
 * Each fee is re-read and stamped in its own Firestore transaction, so a
 * refund written while the run is going is never overwritten. The first line
 * of output names the target project (dry run and apply alike).
 *
 * Run (dry run by default; add --apply to write):
 *   npm run backfill:fee-holds -- --apply
 *   (dev: npm run backfill:fee-holds:dev -- --apply)
 */
import { Timestamp } from "firebase-admin/firestore";
import { collections } from "../utils/firebase";
import type { Consultation, FeeHold, Transaction } from "../types";
import { legacyFeeHold } from "../money/fee-hold";
// Review fix: each stamp is its own Firestore transaction (the charge path's
// runner, which the tests swap for the in-memory one), and a fee that already
// has a refund row is never stamped.
import { chargeRuntime } from "../services/charge-checkout.service";
import { refundDocId } from "../services/consultation-refund.service";

/**
 * The project this run talks to, for the first line of its output (review
 * fix: a dry run must say where it would write, so a prod run is never by
 * accident). The emulator is named as such.
 */
export function targetProjectLabel(): string {
  const project = process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || "(project from the default credentials)";
  return process.env.FIRESTORE_EMULATOR_HOST ? `${project} (Firestore emulator ${process.env.FIRESTORE_EMULATOR_HOST})` : project;
}

/** What one fee came to. */
export type FeeHoldBackfillAction =
  | { kind: "skip_has_hold" }
  | { kind: "skip_no_booking" }
  | { kind: "skip_bad_slot" }
  /** Review fix: the fee was already refunded (a refund row exists): never stamped. */
  | { kind: "skip_refunded" }
  /** Issue #390: frozen by a refund held for an admin: never stamped (never released). */
  | { kind: "skip_frozen" }
  | { kind: "stamp"; hold: FeeHold };

/**
 * Decide one fee's backfill. Pure.
 *
 * @param fee the stored consultation_fee Transaction
 * @param booking its booking, or null when it is gone
 * @param at the clock of the run
 */
export function decideFeeHoldBackfill(
  fee: Transaction,
  booking: Consultation | null,
  at: Date,
  hasRefundRow = false
): FeeHoldBackfillAction {
  // Issue #390: a fee frozen by a held refund must never be released here.
  if (fee.feeHoldFrozenByRefundId) return { kind: "skip_frozen" };
  if (fee.feeHold) return { kind: "skip_has_hold" };
  // A refund was written against this fee: its hold belongs to the refund.
  if (hasRefundRow) return { kind: "skip_refunded" };
  if (!booking) return { kind: "skip_no_booking" };
  try {
    return { kind: "stamp", hold: legacyFeeHold(booking, at) };
  } catch {
    return { kind: "skip_bad_slot" };
  }
}

/** Counts of one run. */
export interface FeeHoldBackfillResult {
  scanned: number;
  released: number;
  held: number;
  skipped: number;
  unresolved: number;
}

/**
 * Stamp every unstamped consultation fee (see the header).
 *
 * @param opts.apply write the holds (false: report only)
 * @param opts.at the clock (defaults to now)
 */
export async function backfillFeeHolds(opts: { apply: boolean; at?: Date }): Promise<FeeHoldBackfillResult> {
  const at = opts.at ?? new Date();
  const result: FeeHoldBackfillResult = { scanned: 0, released: 0, held: 0, skipped: 0, unresolved: 0 };
  console.log(`Fee hold backfill against ${targetProjectLabel()}${opts.apply ? " (APPLY: writing)" : " (DRY RUN)"}`);
  // Single-field equality query (no composite index needed).
  const snapshot = await collections.transactions.where("type", "==", "consultation_fee").get();
  for (const doc of snapshot.docs) {
    result.scanned++;
    // Read, decide and write in ONE transaction per fee (review fix): the
    // fee is re-read, so a refund that stamped it between the list query and
    // this write (or another run) wins, and the write never replaces a hold.
    const action = await chargeRuntime.runTransaction<FeeHoldBackfillAction & { consultationId?: string }>(async (tx) => {
      const feeSnap = await tx.get(doc.ref);
      if (!feeSnap.exists) return { kind: "skip_no_booking" };
      const fee = feeSnap.data() as Transaction;
      const bookingSnap = fee.consultationId ? await tx.get(collections.consultations.doc(fee.consultationId)) : null;
      const booking = bookingSnap?.exists ? (bookingSnap.data() as Consultation) : null;
      const refundSnap = fee.providerTransactionId
        ? await tx.get(collections.transactions.doc(refundDocId(fee.providerTransactionId)))
        : null;
      const decided = decideFeeHoldBackfill(fee, booking, at, !!refundSnap?.exists);
      if (decided.kind === "stamp" && opts.apply) {
        tx.update(doc.ref, { feeHold: decided.hold, updatedAt: Timestamp.fromDate(at) });
      }
      return { ...decided, consultationId: fee.consultationId };
    });
    if (action.kind === "skip_has_hold" || action.kind === "skip_refunded") {
      result.skipped++;
      continue;
    }
    if (action.kind !== "stamp") {
      result.unresolved++;
      console.warn(`  ! ${doc.id}: ${action.kind} (booking ${action.consultationId ?? "-"}); left held`);
      continue;
    }
    if (action.hold.state === "released") result.released++;
    else result.held++;
    console.log(`  ${opts.apply ? "✓" : "·"} ${doc.id}: ${action.hold.state}`);
  }
  console.log(
    `\nDone${opts.apply ? "" : " (DRY RUN, nothing written; add --apply)"}. ${result.scanned} fees: ` +
      `${result.released} released, ${result.held} held, ${result.skipped} already stamped, ${result.unresolved} unresolved.`
  );
  return result;
}

// `node lib/scripts/backfill-fee-holds.js [--apply]`
if (require.main === module) {
  backfillFeeHolds({ apply: process.argv.includes("--apply") })
    .then(() => process.exit(0))
    .catch((error) => {
      console.error("Fee hold backfill failed:", error);
      process.exit(1);
    });
}
