/**
 * One-time backfill (issue #411): give every unpaid booking made before #411
 * the `sweepSetAside: false` field the abandoned-booking sweep selects on.
 *
 * WHY: from #411 on the hourly sweep (`sweepAbandonedConsultations`) leaves
 * out bookings it SET ASIDE with `where("sweepSetAside", "==", false)`, so a
 * set-aside booking stops taking one of its 200 batch slots. Firestore never
 * matches a MISSING field with an equality filter, so a `pending_payment`
 * booking created before #411 (no field) is not swept at all until this
 * runs: it is never cancelled by mistake, it just waits. New bookings get
 * the field at creation (POST /consultations, the public guest route), and
 * an agent-side reschedule writes it too.
 *
 * What it writes: `sweepSetAside: false` and nothing else (not `updatedAt`:
 * this is sweep bookkeeping, not a change of the booking), only on a
 * `pending_payment` booking that has no `sweepSetAside` at all. Each booking
 * is re-read and written in its own Firestore transaction, so a payment or a
 * cancel landing meanwhile is never overwritten, and a booking the sweep has
 * already marked is never touched. Idempotent: a second run finds nothing.
 * The first line of output names the target project (dry run and apply alike).
 *
 * Run (dry run by default; add --apply to write):
 *   npm run backfill:sweep-lane -- --apply
 *   (dev: npm run backfill:sweep-lane:dev -- --apply)
 */
import { collections } from "../utils/firebase";
import type { Consultation } from "../types";
// The charge path's transaction runner (tests swap it for the in-memory one).
import { chargeRuntime } from "../services/charge-checkout.service";
// The same project label the other backfills print first.
import { targetProjectLabel } from "./backfill-fee-holds";

/**
 * Whether one booking needs the field. Pure: only a `pending_payment`
 * booking with no `sweepSetAside` at all (true or false both mean "already
 * there").
 */
export function needsSweepLane(booking: Pick<Consultation, "status" | "sweepSetAside"> | null): boolean {
  return !!booking && booking.status === "pending_payment" && booking.sweepSetAside === undefined;
}

/** Counts of one run. */
export interface SweepLaneBackfillResult {
  /** `pending_payment` bookings read. */
  scanned: number;
  /** Given the field (or, in a dry run, would be). */
  stamped: number;
  /** Already had it (or changed meanwhile). */
  skipped: number;
}

/**
 * Stamp every unpaid booking that lacks the field (see the header).
 *
 * @param opts.apply write (false: report only)
 */
export async function backfillSweepLane(opts: { apply: boolean }): Promise<SweepLaneBackfillResult> {
  const result: SweepLaneBackfillResult = { scanned: 0, stamped: 0, skipped: 0 };
  console.log(`Sweep lane backfill against ${targetProjectLabel()}${opts.apply ? " (APPLY: writing)" : " (DRY RUN)"}`);
  // Single-field equality query: no composite index needed.
  const snapshot = await collections.consultations.where("status", "==", "pending_payment").get();
  for (const doc of snapshot.docs) {
    result.scanned++;
    // Re-read and decide in ONE transaction per booking (see the header).
    const stamped = await chargeRuntime.runTransaction<boolean>(async (tx) => {
      const snap = await tx.get(doc.ref);
      const booking = snap.exists ? (snap.data() as Consultation) : null;
      if (!needsSweepLane(booking)) return false;
      if (opts.apply) tx.update(doc.ref, { sweepSetAside: false });
      return true;
    });
    if (stamped) {
      result.stamped++;
      console.log(`  ${opts.apply ? "✓" : "·"} ${doc.id}`);
    } else {
      result.skipped++;
    }
  }
  console.log(
    `\nDone${opts.apply ? "" : " (DRY RUN, nothing written; add --apply)"}. ${result.scanned} unpaid bookings: ` +
      `${result.stamped} ${opts.apply ? "stamped" : "to stamp"}, ${result.skipped} already had the field.`
  );
  return result;
}

// `node lib/scripts/backfill-sweep-lane.js [--apply]`
if (require.main === module) {
  backfillSweepLane({ apply: process.argv.includes("--apply") })
    .then(() => process.exit(0))
    .catch((error) => {
      console.error("Sweep lane backfill failed:", error);
      process.exit(1);
    });
}
