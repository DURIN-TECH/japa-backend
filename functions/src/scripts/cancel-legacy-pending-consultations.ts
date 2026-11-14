/**
 * One-off cleanup (issue #180): cancel the pending, unpaid consultation
 * bookings made through `POST /consultations` BEFORE #180, which carry a
 * CLIENT-SUPPLIED `fee` (the #166 bug, #148 observation).
 *
 * WHY: before #180 the signed-in booking stored whatever `fee` the caller
 * sent and never opened a Paystack checkout, so these rows sit in
 * `pending_payment` with a price nobody can trust and no way to pay. #180
 * never re-prices a legacy row, so they are closed instead; the client books
 * again and gets a server-priced, payable booking.
 *
 * WHAT IS CANCELLED (all must hold, decided by the pure `planLegacyPending`):
 *   - `status === "pending_payment"` and `paymentStatus` is not "paid";
 *   - NO #180 charge snapshot (`chargedAmountMinor` / `priceUsdCents` absent);
 *   - NO Paystack reference (`transactionId` absent or empty): a legacy GUEST
 *     booking with a reference may still be paid through its checkout, and
 *     verify still honours it as naira, so it is left alone;
 *   - a `fee` is present (the client-supplied value).
 * The write: `status: "cancelled"`, `cancelledAt`, `cancelledBy: "system"`,
 * `cancellationReason` (a plain sentence the client can read), and an audit
 * map `legacyCancellation: { issue: 180, previousStatus, fee, at }`. The
 * `fee` is kept as it was (never rewritten). Paid legacy rows are never
 * touched: they keep their naira `fee` and display as naira.
 *
 * SAFETY (same guards as `migrate-prices-to-usd.ts`):
 *   1. `--project` is mandatory and checked by the shared target guard
 *      (prints the resolved project, aborts on mismatch).
 *   2. A set FIRESTORE_EMULATOR_HOST aborts unless `--emulator` is passed.
 *   3. DRY RUN by default: nothing is written without `--apply`; the dry run
 *      prints every booking it would cancel.
 *   4. IDEMPOTENT: a cancelled booking no longer matches, so a second run
 *      changes nothing.
 *   5. NEVER GUESSES: a pending row with no snapshot, no reference and NO
 *      fee is not something the old code wrote; it is listed for manual
 *      review and left as it is.
 *   6. NO STALE WRITES: each booking is cancelled in its own transaction that
 *      re-reads it and re-decides on the fresh data (a booking paid or
 *      re-priced since the listing is left alone).
 *
 * Run (dry run):  npm run cancel:legacy-consultations -- --project <id>
 *      (apply):   npm run cancel:legacy-consultations -- --project <id> --apply
 *   Emulator:     FIRESTORE_EMULATOR_HOST=127.0.0.1:<port> npm run cancel:legacy-consultations -- --project <demo-id> --emulator [--apply]
 */
import { Timestamp } from "firebase-admin/firestore";
import { enforceBackfillTarget } from "./backfill-news-expire-at-guard";

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Who the cancellation is recorded as (no user did it). */
export const SYSTEM_ACTOR = "system";

/** The reason stored on each cancelled booking (shown to the client). */
export const LEGACY_CANCELLATION_REASON =
  "Cancelled by Seli: this booking was made before consultation prices moved to US dollars and could not be paid. Please book again.";

// ============================================
// Pure decision
// ============================================

/** Why a booking is left alone. */
export type LegacySkipReason =
  | "not-pending" // status is not pending_payment
  | "already-paid" // paymentStatus is paid
  | "has-snapshot" // priced by #180: not legacy
  | "has-paystack-reference"; // a legacy guest checkout that may still be paid

/** The decision for one booking. */
export type LegacyPlan =
  | { action: "cancel"; fee: unknown }
  | { action: "skip"; reason: LegacySkipReason }
  | { action: "review"; reason: "no-fee" };

/**
 * Decide one consultation doc (see the header). Pure.
 *
 * @param d the booking as stored
 */
export function planLegacyPending(d: Record<string, any> | undefined): LegacyPlan {
  if (!d || d.status !== "pending_payment") return { action: "skip", reason: "not-pending" };
  if (d.paymentStatus === "paid") return { action: "skip", reason: "already-paid" };
  if (d.chargedAmountMinor !== undefined || d.priceUsdCents !== undefined) return { action: "skip", reason: "has-snapshot" };
  if (typeof d.transactionId === "string" && d.transactionId.trim() !== "") {
    return { action: "skip", reason: "has-paystack-reference" };
  }
  if (d.fee === undefined || d.fee === null) return { action: "review", reason: "no-fee" };
  return { action: "cancel", fee: d.fee };
}

/** The Firestore update that cancels one booking. */
export function cancellationUpdate(d: Record<string, any>, at: Timestamp): Record<string, unknown> {
  return {
    status: "cancelled",
    cancelledAt: at,
    cancelledBy: SYSTEM_ACTOR,
    cancellationReason: LEGACY_CANCELLATION_REASON,
    // Audit: what it was, so the cancellation can be traced (and undone by hand).
    legacyCancellation: { issue: 180, previousStatus: d.status, fee: d.fee, at },
    updatedAt: at,
  };
}

// ============================================
// The run
// ============================================

/** Totals printed at the end. */
export interface LegacyCleanupCounts {
  /** Pending bookings scanned. */
  scanned: number;
  /** Cancelled (or, in a dry run, that would be). */
  cancelled: number;
  /** Skip reasons -> count. */
  skipped: Record<string, number>;
  /** Left alone for a human (path + reason). */
  review: Array<{ path: string; reason: string }>;
}

/** A doc listing as the cleanup needs it (Admin SDK or the test fake). */
interface DocList {
  get(): Promise<{ docs: Array<{ id: string; ref: any; data(): any }> }>;
}

/** The Firestore pieces the cleanup needs; injectable so tests use the in-memory fake. */
export interface LegacyCleanupDeps {
  /** The pending bookings (`consultations where status == pending_payment`). */
  pending: DocList;
  runTransaction<T>(fn: (tx: any) => Promise<T>): Promise<T>;
}

/**
 * List pending bookings, print the plan, and (only with `apply`) cancel each
 * matching one in its own transaction that re-reads and re-decides.
 */
export async function cancelLegacyPendingConsultations(
  opts: { apply: boolean; now?: () => Timestamp },
  injected?: LegacyCleanupDeps
): Promise<LegacyCleanupCounts> {
  let deps = injected;
  if (!deps) {
    // Lazy import: initialises the Admin SDK, which must happen AFTER the target guard.
    const { db, collections } = await import("../utils/firebase");
    deps = {
      pending: collections.consultations.where("status", "==", "pending_payment") as unknown as DocList,
      runTransaction: (fn) => db.runTransaction(fn),
    };
  }
  const at = (opts.now ?? (() => Timestamp.now()))();
  const counts: LegacyCleanupCounts = { scanned: 0, cancelled: 0, skipped: {}, review: [] };
  const skip = (reason: string) => (counts.skipped[reason] = (counts.skipped[reason] ?? 0) + 1);

  const snap = await deps.pending.get();
  for (const doc of snap.docs) {
    counts.scanned++;
    const path = `consultations/${doc.id}`;
    const plan = planLegacyPending(doc.data());
    if (plan.action === "skip") {
      skip(plan.reason);
      continue;
    }
    if (plan.action === "review") {
      counts.review.push({ path, reason: plan.reason });
      continue;
    }
    if (!opts.apply) {
      counts.cancelled++;
      console.log(`  would cancel ${path} (client-supplied fee ${JSON.stringify(plan.fee)})`);
      continue;
    }
    // Apply: re-read and decide again on the FRESH doc.
    const done = await deps.runTransaction(async (tx) => {
      const fresh = await tx.get(doc.ref);
      const data = fresh.exists ? fresh.data() : undefined;
      if (planLegacyPending(data).action !== "cancel") return false;
      tx.update(doc.ref, cancellationUpdate(data, at));
      return true;
    });
    if (done) {
      counts.cancelled++;
      console.log(`  cancelled ${path} (client-supplied fee ${JSON.stringify(plan.fee)})`);
    } else {
      skip("changed-during-run");
      console.log(`  ${path} changed during the run; left as the fresh data says`);
    }
  }
  return counts;
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  const apply = argv.includes("--apply");
  // A stale FIRESTORE_EMULATOR_HOST would make a "real project" run hit the emulator and report success.
  if (process.env.FIRESTORE_EMULATOR_HOST && !argv.includes("--emulator")) {
    console.error(
      `legacy consultation cleanup ABORTED. FIRESTORE_EMULATOR_HOST=${process.env.FIRESTORE_EMULATOR_HOST} is set, so this ` +
        "run would use the emulator, not the project you name. Unset it, or pass --emulator to confirm that is what you want."
    );
    process.exit(1);
  }
  // Guard first: prints the resolved project and exits 1 on mismatch.
  enforceBackfillTarget(argv, process.env, {
    label: "legacy consultation cleanup",
    example: "`npm run cancel:legacy-consultations -- --project <id>`",
  });
  console.log(apply ? "APPLY mode: writing changes." : "DRY RUN: nothing is written (pass --apply to write).");
  cancelLegacyPendingConsultations({ apply })
    .then((c) => {
      console.log(`\nscanned: ${c.scanned} pending booking(s); ${c.cancelled} ${apply ? "cancelled" : "to cancel"}`);
      console.log(`skipped: ${JSON.stringify(c.skipped)}`);
      if (c.review.length) console.log(`NEEDS MANUAL REVIEW (not touched): ${JSON.stringify(c.review)}`);
      process.exit(0);
    })
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
