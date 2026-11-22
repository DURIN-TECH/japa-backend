// ============================================
// Unit tests — abandoned-booking sweep robustness (issue #411)
// ============================================
//
// Hermetic, same harness as consultation-abandoned-sweep.test.ts: in-memory
// Firestore (transactions run one at a time, like serializable Firestore),
// Paystack STUBBED by the harness recorders (no network), the charge path's
// clock moved by hand.
//
// What is covered, by acceptance criterion of #411:
//  1. stuck bookings: the per-booking counter, last outcome and time for each
//     unresolved kind (in progress, review, lookup failure, "not found"); the
//     set-aside after SWEEP_SET_ASIDE_AFTER_RUNS runs; 200 set-aside bookings
//     no longer starve a new one; a reschedule / re-price / payment takes a
//     booking out of set-aside; a set-aside booking is never cancelled by
//     the sweep; the admin list (403, [], its fields);
//  2. bounded lookups: final references recorded and not looked up again;
//     retired before live; stop at the first in progress; the run cap
//     (left for the next run, not errors, not counted toward set-aside);
//  3. a paid retired checkout is settled (exception + refund) even while the
//     booking is left; a second run writes nothing new;
//  4. one handled-outcome helper (no inline list);
//  5. the grace-restart counter (and it shows on the admin list);
//  plus the orchestrator decisions of 2026-11-21: the admin re-check and
//  cancel (fail closed, raced against verify), and a guest's live pay link
//  keeping the booking (`payLinkExpiresAt`, #391), the index, the backfill.
import { test, describe, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import { Timestamp } from "firebase-admin/firestore";
import { ROLES } from "@durin-tech/authz";

import {
  useHarness,
  harness,
  captureRes,
  docsIn,
  seed,
  paystackPaid,
  paystackAbandoned,
  paystackStatus,
  T0,
} from "./harness";
import { fakeCollection } from "../helpers/fake-firestore";
import { consultationController } from "../../src/controllers/consultation.controller";
import {
  consultationService,
  CONSULTATION_ACTORS,
  SWEEP_SET_ASIDE_AFTER_RUNS,
  SWEEP_MAX_LOOKUPS_PER_RUN,
  ABANDONED_SWEEP_BATCH_SIZE,
  SYSTEM_CANCELLATION_REASON,
  sweepLookupOrder,
  sweepFingerprint,
  nextSweepCount,
  mergeSweepRecords,
  recordedFinalStates,
  isHandledSweepSettle,
  isConfirmingSweepSettle,
  isAbandonedBooking,
  guestPayLinkStillLive,
  decideAbandonedCheckouts,
  sweepRuntime,
  SWEEP_TIME_BUDGET_MS,
} from "../../src/services/consultation.service";
import { PAYSTACK_LOOKUP_TIMEOUT_MS } from "../../src/services/billing/paystack.provider";
import { notificationService } from "../../src/services/notification.service";
import { consultationCharging } from "../../src/services/consultation-charge.service";
import { backfillSweepLane, needsSweepLane } from "../../src/scripts/backfill-sweep-lane";

/* eslint-disable @typescript-eslint/no-explicit-any */

before(async () => {
  await useHarness();
});
beforeEach(() => {
  harness.reset();
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  console.log = () => {};
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  console.error = () => {};
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  console.warn = () => {};
});

// ============================================
// Fixtures
// ============================================

/** $10.00 at ₦1,500/$ = 1,500,000 kobo. */
const FEE_KOBO = 1_500_000;
const HOUR_MS = 3_600_000;

/**
 * Seed an unpaid, #180-priced booking whose quote lock ended `hoursAgo`
 * hours before the harness clock's "now" (with `sweepSetAside: false`, as
 * booking creation writes it).
 */
async function seedPending(id: string, hoursAgo: number, overrides: Record<string, unknown> = {}): Promise<void> {
  const expiresAt = harness.clock.now().getTime() - hoursAgo * HOUR_MS;
  await seed("consultations", id, {
    userId: "uid-client1", agentId: "uid-agent1", bookedVia: "client",
    clientName: "Chi Client", clientEmail: "delivered+client1@resend.dev", agentName: "Ada Agent",
    type: "initial", scheduledDate: Timestamp.fromDate(new Date("2026-12-01")), scheduledTime: "10:00",
    durationMinutes: 30, timezone: "Africa/Lagos",
    status: "pending_payment", paymentStatus: "pending",
    priceUsdCents: 1_000, chargedCurrency: "NGN", chargedAmountMinor: FEE_KOBO,
    fxRate: 1500, fxRateAsOf: T0, fxRateSource: "cbn", fxMarginBps: 0,
    quoteLockedAt: Timestamp.fromMillis(expiresAt - 30 * 60_000),
    quoteExpiresAt: Timestamp.fromMillis(expiresAt),
    createdAt: T0, updatedAt: T0,
    sweepSetAside: false,
    ...overrides,
  });
}

/**
 * A `supersededCheckouts` entry priced like `seedPending`'s booking, retired
 * by a reschedule (#354) unless `retired` is false (an ordinary re-price).
 */
function entry(reference: string, retired = true): Record<string, unknown> {
  return {
    reference,
    priceUsdCents: 1_000, chargedCurrency: "NGN", chargedAmountMinor: FEE_KOBO,
    fxRate: 1500, fxRateAsOf: T0, fxRateSource: "cbn", fxMarginBps: 0,
    quoteLockedAt: Timestamp.fromMillis(harness.clock.now().getTime() - 80 * HOUR_MS),
    quoteExpiresAt: Timestamp.fromMillis(harness.clock.now().getTime() - 79.5 * HOUR_MS),
    supersededAt: T0,
    ...(retired ? { retiredBy: "reschedule", retiredByAgentId: "uid-agent1" } : {}),
  };
}

/** A stored booking by id. */
function booking(id: string): Record<string, any> {
  const found = docsIn("consultations").find(([docId]) => docId === id);
  assert.ok(found, `booking ${id} exists`);
  return found[1];
}

/** Record every Paystack lookup of the test (references, in order). */
function countLookups(): string[] {
  const seen: string[] = [];
  harness.onLookup = async (reference: string) => {
    seen.push(reference);
    return undefined;
  };
  return seen;
}

/** Refund rows of booking `id`. */
const refundsOf = (id: string) =>
  docsIn("transactions").map(([, t]) => t).filter((t) => t.type === "refund" && t.consultationId === id);

/** Run the sweep `n` times, an hour apart (as the scheduled job does). */
async function runSweeps(n: number) {
  let last: any;
  for (let i = 0; i < n; i++) {
    last = await consultationService.sweepAbandonedBookings();
    harness.clock.advanceHours(1);
  }
  return last;
}

/** Call a controller handler as `role` (uid `uid-<role>`). */
async function call(
  handler: "listSweepReview" | "recheckSweepReview" | "cancelSweepReview",
  role: string,
  id?: string
) {
  const { out, res } = captureRes();
  await (consultationController as any)[handler](
    { params: id ? { id } : {}, body: {}, userId: `uid-${role}`, authz: { role } } as any,
    res
  );
  return out;
}

/** POST /consultations/public/verify. */
async function verify(reference: string) {
  const { out, res } = captureRes();
  await consultationController.verifyPublicConsultation({ body: { reference } } as any, res);
  return out;
}

// ============================================
// Pure helpers
// ============================================

describe("sweep bookkeeping helpers (pure, issue #411)", () => {
  test("the named constants", () => {
    assert.equal(SWEEP_SET_ASIDE_AFTER_RUNS, 24);
    assert.equal(SWEEP_MAX_LOOKUPS_PER_RUN, 300);
    assert.ok(SWEEP_MAX_LOOKUPS_PER_RUN >= ABANDONED_SWEEP_BATCH_SIZE, "a full batch of one-checkout bookings fits");
  });

  test("sweepLookupOrder: superseded in stored order, then the live one, no duplicates", () => {
    assert.deepEqual(
      sweepLookupOrder({ transactionId: "l", supersededCheckouts: [{ reference: "a" }, { reference: "l" }, { reference: "b" }] } as any),
      ["a", "l", "b"],
      "a live reference also in the superseded list is asked once, at its superseded place"
    );
    assert.deepEqual(sweepLookupOrder({ transactionId: "l", supersededCheckouts: [{ reference: "a" }, { reference: "b" }] } as any), ["a", "b", "l"]);
    assert.deepEqual(sweepLookupOrder({ transactionId: "l" } as any), ["l"]);
    assert.deepEqual(sweepLookupOrder({} as any), []);
  });

  test("sweepFingerprint changes with the checkouts, the lock, the grace and a pay link; not with the superseded order", () => {
    const base: any = {
      status: "pending_payment", paymentStatus: "pending", transactionId: "l",
      supersededCheckouts: [{ reference: "a" }, { reference: "b" }],
      quoteExpiresAt: Timestamp.fromMillis(1000),
    };
    const fp = sweepFingerprint(base);
    assert.equal(sweepFingerprint({ ...base, supersededCheckouts: [{ reference: "b" }, { reference: "a" }] }), fp);
    for (const change of [
      { transactionId: "l2" },
      { supersededCheckouts: [{ reference: "a" }] },
      { quoteExpiresAt: Timestamp.fromMillis(2000) },
      { paymentGraceStartsAt: Timestamp.fromMillis(3000) },
      { payLinkExpiresAt: Timestamp.fromMillis(4000) },
      { paymentStatus: "paid" },
    ]) {
      assert.notEqual(sweepFingerprint({ ...base, ...change }), fp, JSON.stringify(Object.keys(change)));
    }
  });

  test("nextSweepCount: grows on the same fingerprint, starts over on a new one, sets aside at N", () => {
    const stored: any = { unresolvedRuns: 5, fingerprint: "F", checkouts: [] };
    assert.deepEqual(nextSweepCount(stored, "F", "F", "in_progress"), { unresolvedRuns: 6, setAside: false });
    assert.deepEqual(nextSweepCount(stored, "G", "G", "in_progress"), { unresolvedRuns: 1, setAside: false }, "booking changed since the last count");
    assert.deepEqual(nextSweepCount(stored, "F", "H", "in_progress"), { unresolvedRuns: 0, setAside: false }, "changed during the run");
    assert.deepEqual(nextSweepCount(stored, "F", "F", null), { unresolvedRuns: 5, setAside: false }, "not counted (cap)");
    assert.deepEqual(nextSweepCount(undefined, "F", "F", "review"), { unresolvedRuns: 1, setAside: false });
    const almost: any = { unresolvedRuns: SWEEP_SET_ASIDE_AFTER_RUNS - 1, fingerprint: "F", checkouts: [] };
    assert.deepEqual(nextSweepCount(almost, "F", "F", "lookup_failed"), { unresolvedRuns: SWEEP_SET_ASIDE_AFTER_RUNS, setAside: true });
  });

  test("mergeSweepRecords and recordedFinalStates: newest wins; only final states are reused", () => {
    const at = T0;
    const merged = mergeSweepRecords(
      [{ reference: "a", state: "in_progress", final: false, checkedAt: at }, { reference: "b", state: "final_unpaid", final: true, checkedAt: at }],
      [{ reference: "a", state: "final_unpaid", final: true, checkedAt: at }, { reference: "c", state: "paid_handled", final: true, checkedAt: at }]
    );
    assert.deepEqual(merged.map((r) => [r.reference, r.state]), [["a", "final_unpaid"], ["b", "final_unpaid"], ["c", "paid_handled"]]);
    const finals = recordedFinalStates({
      sweepReview: {
        unresolvedRuns: 0, fingerprint: "",
        checkouts: [
          ...merged,
          { reference: "d", state: "paid_review", final: false, checkedAt: at },
          { reference: "e", state: "lookup_failed", final: false, checkedAt: at },
        ],
      },
    } as any);
    assert.deepEqual([...finals.entries()], [["a", "final_unpaid"], ["b", "final_unpaid"], ["c", "handled"]]);
  });

  test("a handled reference never blocks the cancel; a paid or in-progress one still does", () => {
    const at = new Date("2026-11-20T12:00:00Z");
    const row: any = {
      status: "pending_payment", paymentStatus: "pending",
      quoteExpiresAt: Timestamp.fromMillis(at.getTime() - 72 * HOUR_MS),
      transactionId: "live", supersededCheckouts: [{ reference: "old" }],
    };
    assert.deepEqual(decideAbandonedCheckouts(row, new Map<string, any>([["old", "handled"], ["live", "final_unpaid"]]), at), { kind: "cancel" });
    assert.deepEqual(decideAbandonedCheckouts(row, new Map<string, any>([["old", "handled"], ["live", "in_progress"]]), at), { kind: "leave" });
    assert.deepEqual(decideAbandonedCheckouts(row, new Map<string, any>([["old", "handled"], ["live", "paid"]]), at), { kind: "settle", references: ["live"] });
  });

  test("criterion 4: one handled helper; SWEEP_HANDLED_SETTLES is read in exactly one place", () => {
    const o = (kind: string): any => ({ kind });
    for (const kind of ["rescheduled_refund_recorded", "refund_recorded", "not_payable_recorded"]) {
      assert.equal(isHandledSweepSettle(o(kind)), true, kind);
    }
    for (const kind of ["confirmed", "already_paid", "mismatch", "not_chargeable", "unknown_reference"]) {
      assert.equal(isHandledSweepSettle(o(kind)), false, kind);
    }
    assert.equal(isHandledSweepSettle(null), false);
    assert.equal(isConfirmingSweepSettle(o("confirmed")), true);
    assert.equal(isConfirmingSweepSettle(o("already_paid")), true);
    assert.equal(isConfirmingSweepSettle(o("refund_recorded")), false);
    // Read as text: the set is used once (in the helper), never spread inline.
    const source = fs.readFileSync(path.resolve(__dirname, "../../src/services/consultation.service.ts"), "utf8");
    assert.equal(source.match(/SWEEP_HANDLED_SETTLES\.has\(/g)?.length, 1);
    assert.equal(source.includes("...SWEEP_HANDLED_SETTLES"), false);
  });
});

// ============================================
// 1. Stuck bookings are counted and set aside
// ============================================

describe("stuck bookings are counted and set aside (criterion 1)", () => {
  test("each unresolved run (in progress) counts, with the last outcome and time; set aside at N, then never selected", async () => {
    await seedPending("b1", 30, { transactionId: "live-1" });
    paystackStatus("live-1", "b1", "ongoing");

    const first = await consultationService.sweepAbandonedBookings();
    assert.equal(first.leftInProgress, 1);
    let review = booking("b1").sweepReview;
    assert.equal(review.unresolvedRuns, 1);
    assert.equal(review.lastOutcome, "in_progress");
    assert.equal(review.lastRunAt.toMillis(), harness.clock.now().getTime());
    assert.deepEqual(review.checkouts.map((r: any) => [r.reference, r.state, r.final]), [["live-1", "in_progress", false]]);
    assert.equal(booking("b1").sweepSetAside, false);
    // The booking itself is untouched (no updatedAt, no status change).
    assert.equal(booking("b1").updatedAt.toMillis(), T0.toMillis());

    harness.clock.advanceHours(1);
    const last = await runSweeps(SWEEP_SET_ASIDE_AFTER_RUNS - 1);
    assert.equal(last.setAside, 1, "the Nth run sets it aside");
    review = booking("b1").sweepReview;
    assert.equal(review.unresolvedRuns, SWEEP_SET_ASIDE_AFTER_RUNS);
    assert.ok(review.setAsideAt);
    assert.equal(booking("b1").sweepSetAside, true);

    // Later runs no longer select it: no slot, no Paystack call, never cancelled.
    paystackAbandoned("live-1", "b1"); // even once nothing could land any more
    const seen = countLookups();
    const later = await consultationService.sweepAbandonedBookings();
    assert.equal(later.scanned, 0);
    assert.deepEqual(seen, []);
    assert.equal(booking("b1").status, "pending_payment");
  });

  test("review, lookup failure and 'not found' are unresolved outcomes too", async () => {
    // review: paid with the wrong amount.
    await seedPending("rev", 30, { transactionId: "live-rev" });
    paystackPaid("live-rev", "rev", { amountMinor: FEE_KOBO - 1, currency: "NGN" });
    // not found: a reference Paystack generated itself.
    await seedPending("nf", 29, { transactionId: "T999paystackmade" });
    // lookup failure: a network error.
    await seedPending("fail", 28, { transactionId: "live-fail" });
    // Known to Paystack, so the realistic "not found" does not answer first.
    paystackStatus("live-fail", "fail", "ongoing");
    harness.realisticNotFound = true;
    const realOnLookup = async (reference: string) => {
      if (reference === "live-fail") throw new Error("PAYSTACK_ERROR: 502 Bad Gateway");
      return undefined;
    };
    harness.onLookup = realOnLookup;

    const result = await consultationService.sweepAbandonedBookings();
    assert.equal(result.skipped, 1, "review");
    assert.equal(result.errors, 2, "not found + lookup failure");
    assert.equal(booking("rev").sweepReview.lastOutcome, "review");
    assert.equal(booking("rev").sweepReview.checkouts[0].state, "paid_review");
    assert.equal(booking("rev").sweepReview.checkouts[0].settleOutcome, "mismatch");
    assert.equal(booking("nf").sweepReview.lastOutcome, "not_found");
    assert.equal(booking("fail").sweepReview.lastOutcome, "lookup_failed");
    for (const id of ["rev", "nf"]) {
      assert.equal(booking(id).sweepReview.unresolvedRuns, 1, id);
      assert.equal(booking(id).status, "pending_payment", id);
    }
    // Review round 1: Paystack not answering is recorded, but not counted.
    assert.equal(booking("fail").sweepReview.unresolvedRuns, 0, "an outage is not counted");
    assert.equal(booking("fail").status, "pending_payment");
    // A paid-but-unapplied reference is not final: asked again next run.
    harness.clock.advanceHours(1);
    const seen: string[] = [];
    harness.onLookup = async (reference: string) => {
      seen.push(reference);
      return realOnLookup(reference);
    };
    await consultationService.sweepAbandonedBookings();
    assert.ok(seen.includes("live-rev"));
    assert.equal(booking("rev").sweepReview.unresolvedRuns, 2);
  });

  test("200 set-aside bookings older than one new abandoned booking: the next run processes the new one", async () => {
    for (let i = 0; i < ABANDONED_SWEEP_BATCH_SIZE; i++) {
      await seedPending(`stuck${i}`, 500 - i, {
        transactionId: `stuck-ref-${i}`, sweepSetAside: true,
      });
      // Their stored fingerprint must match, or the release pass frees them.
      await fakeCollection("consultations").doc(`stuck${i}`).update({
        sweepReview: {
          unresolvedRuns: SWEEP_SET_ASIDE_AFTER_RUNS, fingerprint: sweepFingerprint(booking(`stuck${i}`) as any),
          setAsideAt: T0, checkouts: [],
        },
      });
    }
    await seedPending("fresh", 25, { transactionId: "fresh-ref" });
    paystackAbandoned("fresh-ref", "fresh");

    const seen = countLookups();
    const result = await consultationService.sweepAbandonedBookings();
    assert.equal(result.scanned, 1);
    assert.equal(result.cancelled, 1);
    assert.equal(result.released, 0);
    assert.deepEqual(seen, ["fresh-ref"]);
    assert.equal(booking("fresh").status, "cancelled");
    assert.equal(booking("stuck0").status, "pending_payment");
  });

  test("a set-aside booking is never cancelled by the sweep, even if it was set aside between the lookups and the cancel", async () => {
    await seedPending("b1", 30, { transactionId: "live-1" });
    paystackAbandoned("live-1", "b1");
    harness.onLookup = async () => {
      harness.onLookup = undefined;
      await fakeCollection("consultations").doc("b1").update({ sweepSetAside: true });
      return undefined;
    };
    const result = await consultationService.sweepAbandonedBookings();
    assert.equal(result.cancelled, 0);
    assert.equal(result.skipped, 1);
    assert.equal(booking("b1").status, "pending_payment");
  });

  test("a reschedule takes it out of set-aside; a re-price is released by the next run's release pass", async () => {
    // Rescheduled.
    await seedPending("moved", 30, { transactionId: "live-m" });
    paystackStatus("live-m", "moved", "ongoing");
    await runSweeps(SWEEP_SET_ASIDE_AFTER_RUNS);
    assert.equal(booking("moved").sweepSetAside, true);
    // (decideEdit refuses a move while a payment may be in flight only inside the lock; this is long past it.)
    const edited = await consultationService.editConsultation("moved", () => CONSULTATION_ACTORS.AGENT_SIDE, { scheduledTime: "15:00" } as any);
    assert.equal(edited.kind, "edited");
    assert.equal(booking("moved").sweepSetAside, false, "the move clears the marker in its own write");
    assert.equal(booking("moved").graceRestartCount, 1);

    // Re-priced: the charge path writes a new transactionId (code the sweep does not own).
    await seedPending("repriced", 30, { transactionId: "live-r" });
    paystackStatus("live-r", "repriced", "ongoing");
    await runSweeps(SWEEP_SET_ASIDE_AFTER_RUNS);
    assert.equal(booking("repriced").sweepSetAside, true);
    await fakeCollection("consultations").doc("repriced").update({
      transactionId: "live-r2",
      quoteExpiresAt: Timestamp.fromMillis(harness.clock.now().getTime() - 25 * HOUR_MS),
    });
    paystackAbandoned("live-r2", "repriced");
    const result = await consultationService.sweepAbandonedBookings();
    assert.equal(result.released, 1);
    assert.equal(booking("repriced").sweepReview.unresolvedRuns, 0);
    // Released before the main query: swept in the same run.
    assert.equal(booking("repriced").status, "cancelled");
  });

  test("a set-aside booking that gets paid leaves the admin list", async () => {
    await seedPending("b1", 30, { transactionId: "live-1" });
    paystackStatus("live-1", "b1", "ongoing");
    await runSweeps(SWEEP_SET_ASIDE_AFTER_RUNS);
    assert.equal((await call("listSweepReview", ROLES.ADMIN)).body.data.length, 1);
    paystackPaid("live-1", "b1", { amountMinor: FEE_KOBO, currency: "NGN" });
    const out = await verify("live-1");
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.equal(booking("b1").status, "scheduled");
    assert.deepEqual((await call("listSweepReview", ROLES.ADMIN)).body.data, []);
  });

  test("a change during the run does not count toward set-aside", async () => {
    await seedPending("b1", 30, { transactionId: "live-1" });
    paystackStatus("live-1", "b1", "ongoing");
    await runSweeps(3);
    assert.equal(booking("b1").sweepReview.unresolvedRuns, 3);
    harness.onLookup = async () => {
      harness.onLookup = undefined;
      // A re-price lands while the sweep is asking Paystack.
      await fakeCollection("consultations").doc("b1").update({ transactionId: "live-2" });
      return undefined;
    };
    await consultationService.sweepAbandonedBookings();
    assert.equal(booking("b1").sweepReview.unresolvedRuns, 0);
  });
});

// ============================================
// 1. The admin list
// ============================================

describe("GET /consultations/sweep-review (criterion 1, admin only)", () => {
  test("403 for a client, an agent and an owner, before anything is read", async () => {
    for (const role of [ROLES.CLIENT, ROLES.AGENT, ROLES.OWNER]) {
      const out = await call("listSweepReview", role);
      assert.equal(out.status, 403, role);
      assert.equal(out.body.error, "FORBIDDEN");
    }
  });

  test("an empty list is 200 with []", async () => {
    const out = await call("listSweepReview", ROLES.ADMIN);
    assert.equal(out.status, 200);
    assert.deepEqual(out.body.data, []);
  });

  test("each set-aside booking with client, agent, status, counter, last outcome and time, checkouts and grace restarts", async () => {
    await seedPending("b1", 30, {
      transactionId: "live-1", supersededCheckouts: [entry("old-1"), entry("old-2", false)],
      graceRestartCount: 2, agencyId: "ag1",
    });
    paystackAbandoned("old-1", "b1");
    paystackAbandoned("old-2", "b1");
    paystackStatus("live-1", "b1", "ongoing");
    await runSweeps(SWEEP_SET_ASIDE_AFTER_RUNS);
    // Not set aside: not listed.
    await seedPending("other", 30);

    const out = await call("listSweepReview", ROLES.ADMIN);
    assert.equal(out.status, 200);
    assert.equal(out.body.data.length, 1);
    const item = out.body.data[0];
    assert.equal(item.consultationId, "b1");
    assert.equal(item.status, "pending_payment");
    assert.equal(item.userId, "uid-client1");
    assert.equal(item.clientName, "Chi Client");
    assert.equal(item.clientEmail, "delivered+client1@resend.dev");
    assert.equal(item.agentId, "uid-agent1");
    assert.equal(item.agentName, "Ada Agent");
    assert.equal(item.agencyId, "ag1");
    assert.equal(item.unresolvedRuns, SWEEP_SET_ASIDE_AFTER_RUNS);
    assert.equal(item.lastOutcome, "in_progress");
    assert.equal(typeof item.lastRunAt, "string");
    assert.equal(typeof item.setAsideAt, "string");
    assert.equal(item.graceRestartCount, 2);
    assert.deepEqual(
      item.checkouts.map((c: any) => [c.reference, c.kind, c.state, c.final]),
      [["old-1", "retired", "final_unpaid", true], ["old-2", "superseded", "final_unpaid", true], ["live-1", "live", "in_progress", false]]
    );
  });
});

// ============================================
// 2. Bounded Paystack lookups
// ============================================

describe("bounded Paystack lookups (criterion 2)", () => {
  test("K retired checkouts reopened after the lock: final ones are looked up once, then only the not-yet-final ones", async () => {
    // Three retired checkouts (final unpaid) and a live one still in progress.
    await seedPending("b1", 30, {
      transactionId: "live-1", supersededCheckouts: [entry("old-1"), entry("old-2"), entry("old-3")],
    });
    for (const ref of ["old-1", "old-2", "old-3"]) paystackAbandoned(ref, "b1");
    paystackStatus("live-1", "b1", "pending");
    const seen = countLookups();

    const first = await consultationService.sweepAbandonedBookings();
    assert.deepEqual(seen, ["old-1", "old-2", "old-3", "live-1"]);
    assert.equal(first.lookups, 4);
    harness.clock.advanceHours(1);
    seen.length = 0;
    const second = await consultationService.sweepAbandonedBookings();
    assert.deepEqual(seen, ["live-1"], "only the one that is not final yet");
    assert.equal(second.lookups, 1);

    // The live one fails for good. Before the cancel (decision 2026-11-21)
    // the recorded ones are asked about once more, then it is cancelled.
    paystackAbandoned("live-1", "b1");
    harness.clock.advanceHours(1);
    seen.length = 0;
    const third = await consultationService.sweepAbandonedBookings();
    assert.deepEqual(seen, ["live-1", "old-1", "old-2", "old-3"]);
    assert.equal(third.lookups, 4);
    assert.equal(third.cancelled, 1);
    assert.equal(booking("b1").status, "cancelled");
  });

  test("lookups stop at the first checkout still in progress, but the live checkout is still asked (review round 1)", async () => {
    await seedPending("b1", 30, {
      transactionId: "live-1", supersededCheckouts: [entry("old-1"), entry("old-2"), entry("old-3")],
    });
    paystackAbandoned("old-1", "b1");
    paystackStatus("old-2", "b1", "ongoing");
    paystackAbandoned("old-3", "b1");
    paystackAbandoned("live-1", "b1");
    const seen = countLookups();
    const result = await consultationService.sweepAbandonedBookings();
    assert.deepEqual(seen, ["old-1", "old-2", "live-1"], "old-3 is skipped; the live one never is");
    assert.equal(result.leftInProgress, 1);
    const states = Object.fromEntries(booking("b1").sweepReview.checkouts.map((r: any) => [r.reference, r.state]));
    assert.deepEqual(states, { "old-1": "final_unpaid", "old-2": "in_progress", "live-1": "final_unpaid" });
  });

  test("the run cap: at most SWEEP_MAX_LOOKUPS_PER_RUN calls; the rest is left for the next run, not errors, not counted", async () => {
    const perBooking = 150; // two bookings use the whole budget
    for (const [id, hours] of [["a", 60], ["b", 50], ["c", 40]] as const) {
      const refs = Array.from({ length: perBooking }, (_, i) => `${id}-old-${i}`);
      await seedPending(id, hours, { supersededCheckouts: refs.map((r) => entry(r)) });
      for (const r of refs) paystackAbandoned(r, id);
    }
    const seen = countLookups();
    const first = await consultationService.sweepAbandonedBookings();
    assert.equal(seen.length, SWEEP_MAX_LOOKUPS_PER_RUN);
    assert.equal(first.lookups, SWEEP_MAX_LOOKUPS_PER_RUN);
    assert.equal(first.cancelled, 2);
    assert.equal(first.leftForCap, 1);
    assert.equal(first.errors, 0);
    assert.equal(booking("c").status, "pending_payment");
    assert.equal(booking("c").sweepReview, undefined, "nothing counted for a booking the run never reached");

    harness.clock.advanceHours(1);
    seen.length = 0;
    const second = await consultationService.sweepAbandonedBookings();
    assert.equal(seen.length, perBooking);
    assert.equal(second.cancelled, 1);
    assert.equal(booking("c").status, "cancelled");
  });

  test("the cap in the middle of a booking: what it learned is kept; the next run asks the rest, then the recorded ones again before the cancel", async () => {
    // "first" uses 250 of the 300 lookups; "big" (100 checkouts) gets 50.
    const firstRefs = Array.from({ length: 250 }, (_, i) => `f-${i}`);
    await seedPending("first", 40, { supersededCheckouts: firstRefs.map((r) => entry(r)) });
    for (const r of firstRefs) paystackAbandoned(r, "first");
    const refs = Array.from({ length: 100 }, (_, i) => `old-${i}`);
    await seedPending("big", 30, { supersededCheckouts: refs.map((r) => entry(r)) });
    for (const r of refs) paystackAbandoned(r, "big");
    const seen = countLookups();
    const first = await consultationService.sweepAbandonedBookings();
    assert.equal(seen.length, SWEEP_MAX_LOOKUPS_PER_RUN);
    assert.equal(first.cancelled, 1);
    assert.equal(first.leftForCap, 1);
    assert.equal(booking("big").sweepReview.unresolvedRuns, 0, "the cap is not counted toward set-aside");
    assert.equal(booking("big").sweepReview.checkouts.length, 50);
    harness.clock.advanceHours(1);
    seen.length = 0;
    const second = await consultationService.sweepAbandonedBookings();
    // The 50 not asked yet, then the 50 recorded ones once more before the cancel.
    assert.deepEqual(seen, [...refs.slice(50), ...refs.slice(0, 50)]);
    assert.equal(second.cancelled, 1);
  });

  test("more checkouts than a whole run may look up: never cancelled by the sweep; counted, so it reaches an admin", async () => {
    const refs = Array.from({ length: SWEEP_MAX_LOOKUPS_PER_RUN + 1 }, (_, i) => `old-${i}`);
    await seedPending("huge", 30, { supersededCheckouts: refs.map((r) => entry(r)) });
    for (const r of refs) paystackAbandoned(r, "huge");
    const first = await consultationService.sweepAbandonedBookings();
    assert.equal(first.leftForCap, 1);
    assert.equal(booking("huge").sweepReview.lastOutcome, "too_many_checkouts");
    assert.equal(booking("huge").sweepReview.unresolvedRuns, 1);
    // Every later run re-asks before a cancel and runs out again: set aside at N.
    await runSweeps(SWEEP_SET_ASIDE_AFTER_RUNS);
    assert.equal(booking("huge").status, "pending_payment");
    assert.equal(booking("huge").sweepSetAside, true);
    // The admin cancel has no run budget: it checks all 301 and cancels.
    const out = await call("cancelSweepReview", ROLES.ADMIN, "huge");
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.equal(booking("huge").status, "cancelled");
  });
});

// ============================================
// 2b. Every reference is asked again before a cancel (decision 2026-11-21)
// ============================================

describe("before a cancel the sweep asks about the recorded references again (decision 2026-11-21)", () => {
  /**
   * Run 1 records `old-1` final unpaid (Paystack "abandoned") while the live
   * checkout is in progress; then `old-1` is paid and the live one fails.
   */
  async function recordedThenPaid(retired: boolean): Promise<void> {
    await seedPending("b1", 30, { transactionId: "live-1", supersededCheckouts: [entry("old-1", retired)] });
    paystackAbandoned("old-1", "b1");
    paystackStatus("live-1", "b1", "ongoing");
    const first = await consultationService.sweepAbandonedBookings();
    assert.equal(first.leftInProgress, 1);
    const recorded = booking("b1").sweepReview.checkouts.find((r: any) => r.reference === "old-1");
    assert.equal(recorded.state, "final_unpaid");
    assert.equal(recorded.final, true);
    // The "abandoned" checkout is completed after all; the live one fails.
    paystackPaid("old-1", "b1", { amountMinor: FEE_KOBO, currency: "NGN" }, harness.clock.now(), { fees: 20_000 });
    paystackAbandoned("live-1", "b1");
    harness.clock.advanceHours(1);
  }

  test("a re-priced checkout marked final unpaid but paid since: settled (the booking confirmed), not cancelled", async () => {
    await recordedThenPaid(false);
    const seen = countLookups();
    const result = await consultationService.sweepAbandonedBookings();
    assert.deepEqual(seen, ["live-1", "old-1"], "the recorded one is asked again before the cancel");
    assert.equal(result.cancelled, 0);
    assert.equal(result.settled, 1);
    const b = booking("b1");
    assert.equal(b.status, "scheduled");
    assert.equal(b.paymentStatus, "paid");
    assert.equal(b.transactionId, "old-1");
    assert.equal(docsIn("consultationPaymentExceptions").length, 0, "no refund: the client's payment confirmed the booking");
  });

  test("a retired checkout marked final unpaid but paid since: settled through settlePayment as the agent-caused refund, never cancelled under it", async () => {
    await recordedThenPaid(true);
    const result = await consultationService.sweepAbandonedBookings();
    // settlePayment records it (paid_for_rescheduled_slot, full refund, agent
    // debit) BEFORE the cancel, never as a client-caused booking_not_payable.
    const exceptions = docsIn("consultationPaymentExceptions");
    assert.equal(exceptions.length, 1);
    assert.equal(exceptions[0][1].reason, "paid_for_rescheduled_slot");
    assert.equal(refundsOf("b1").length, 1);
    assert.equal(refundsOf("b1")[0].amount, FEE_KOBO, "refunded in full");
    assert.equal(docsIn("transactions").filter(([, t]) => t.type === "paystack_fee_debit").length, 1);
    assert.equal(result.cancelled, 1, "then cancelled: nothing else can land");
    assert.equal(booking("b1").status, "cancelled");
  });

  test("the re-check fails (Paystack down): not cancelled (fail closed), counted as a lookup failure", async () => {
    await recordedThenPaid(false);
    harness.onLookup = async (reference: string) => {
      if (reference === "old-1") throw new Error("PAYSTACK_ERROR: 503");
      return undefined;
    };
    const result = await consultationService.sweepAbandonedBookings();
    assert.equal(result.cancelled, 0);
    assert.equal(result.errors, 1);
    assert.equal(booking("b1").status, "pending_payment");
    assert.equal(booking("b1").sweepReview.lastOutcome, "lookup_failed");
  });

  test("the re-check finds a recorded checkout in progress again: left, not cancelled", async () => {
    await recordedThenPaid(false);
    paystackStatus("old-1", "b1", "ongoing");
    const result = await consultationService.sweepAbandonedBookings();
    assert.equal(result.cancelled, 0);
    assert.equal(result.leftInProgress, 1);
    assert.equal(booking("b1").status, "pending_payment");
  });

  test("the re-check counts toward the run cap: when it runs out, the booking is left for the next run, not cancelled", async () => {
    // "first" uses 299 lookups, leaving one: enough for b1's live checkout, not for the re-check.
    const firstRefs = Array.from({ length: SWEEP_MAX_LOOKUPS_PER_RUN - 1 }, (_, i) => `f-${i}`);
    await recordedThenPaid(false);
    paystackAbandoned("old-1", "b1"); // (not paid in this test)
    await seedPending("first", 40, { supersededCheckouts: firstRefs.map((r) => entry(r)) });
    for (const r of firstRefs) paystackStatus(r, "first", "failed");
    const result = await consultationService.sweepAbandonedBookings();
    assert.equal(result.lookups, SWEEP_MAX_LOOKUPS_PER_RUN);
    assert.equal(result.leftForCap, 1);
    assert.equal(booking("b1").status, "pending_payment", "not cancelled without re-asking about old-1");
    // Next run (budget fresh): re-asked, then cancelled.
    harness.clock.advanceHours(1);
    const next = await consultationService.sweepAbandonedBookings();
    assert.equal(next.cancelled, 1);
    assert.equal(booking("b1").status, "cancelled");
  });
});

// ============================================
// 3. Paid retired checkouts are settled while the booking waits
// ============================================

describe("paid retired checkouts are settled even when the booking is left (criterion 3)", () => {
  test("live in progress + one paid retired: exception and refund after the run, still pending_payment; a second run writes nothing new", async () => {
    await seedPending("b1", 30, { transactionId: "live-1", supersededCheckouts: [entry("old-1")] });
    paystackPaid("old-1", "b1", { amountMinor: FEE_KOBO, currency: "NGN" }, harness.clock.now(), { fees: 20_000 });
    paystackStatus("live-1", "b1", "ongoing");

    const first = await consultationService.sweepAbandonedBookings();
    assert.equal(first.leftInProgress, 1);
    assert.equal(first.cancelled, 0);
    const exceptions = docsIn("consultationPaymentExceptions");
    assert.equal(exceptions.length, 1);
    assert.equal(exceptions[0][0], "old-1");
    assert.equal(exceptions[0][1].reason, "paid_for_rescheduled_slot");
    assert.equal(refundsOf("b1").length, 1);
    assert.equal(refundsOf("b1")[0].amount, FEE_KOBO, "refunded in full (#354: agent-caused)");
    const debits = docsIn("transactions").filter(([, t]) => t.type === "paystack_fee_debit");
    assert.equal(debits.length, 1, "one fee debit");
    assert.equal(docsIn("transactions").filter(([, t]) => t.type === "consultation_fee").length, 0, "never a fee Transaction");
    assert.equal(booking("b1").status, "pending_payment");
    assert.equal(booking("b1").paymentStatus, "pending");
    const recorded = booking("b1").sweepReview.checkouts.find((r: any) => r.reference === "old-1");
    assert.equal(recorded.state, "paid_handled");
    assert.equal(recorded.final, true);

    const txCount = docsIn("transactions").length;
    const refundCalls = harness.refundCalls.length;
    harness.clock.advanceHours(1);
    const seen = countLookups();
    const second = await consultationService.sweepAbandonedBookings();
    assert.deepEqual(seen, ["live-1"], "the handled retired checkout is not asked about again");
    assert.equal(second.leftInProgress, 1);
    assert.equal(docsIn("consultationPaymentExceptions").length, 1);
    assert.equal(docsIn("transactions").length, txCount, "no new money row");
    assert.equal(harness.refundCalls.length, refundCalls, "no second Paystack refund");
  });

  test("a paid retired checkout before a failed lookup is settled too; the booking is not cancelled", async () => {
    await seedPending("b1", 30, { transactionId: "live-1", supersededCheckouts: [entry("old-1")] });
    paystackPaid("old-1", "b1", { amountMinor: FEE_KOBO, currency: "NGN" });
    harness.onLookup = async (reference: string) => {
      if (reference === "live-1") throw new Error("PAYSTACK_ERROR: 503");
      return undefined;
    };
    const result = await consultationService.sweepAbandonedBookings();
    assert.equal(result.errors, 1);
    assert.equal(docsIn("consultationPaymentExceptions").length, 1);
    assert.equal(refundsOf("b1").length, 1);
    assert.equal(booking("b1").status, "pending_payment");
  });

  test("a paid LIVE checkout still confirms the booking (unchanged)", async () => {
    await seedPending("b1", 30, { transactionId: "live-1", supersededCheckouts: [entry("old-1")] });
    paystackAbandoned("old-1", "b1");
    paystackPaid("live-1", "b1", { amountMinor: FEE_KOBO, currency: "NGN" });
    const result = await consultationService.sweepAbandonedBookings();
    assert.equal(result.settled, 1);
    assert.equal(booking("b1").status, "scheduled");
    assert.equal(booking("b1").paymentStatus, "paid");
  });
});

// ============================================
// 5. Grace restarts are counted
// ============================================

describe("grace restarts are counted (criterion 5)", () => {
  test("each real move of an unpaid booking counts one; no cap; a same-slot edit does not count", async () => {
    await seedPending("b1", 30);
    const edit = (updates: Record<string, unknown>) =>
      consultationService.editConsultation("b1", () => CONSULTATION_ACTORS.AGENT_SIDE, updates as any);
    const first = await edit({ scheduledTime: "11:00" });
    assert.equal(first.kind, "edited");
    assert.equal((first as any).consultation.graceRestartCount, 1, "the returned copy carries the count");
    await edit({ scheduledTime: "11:00" }); // the same slot: not a move
    assert.equal(booking("b1").graceRestartCount, 1);
    for (let i = 0; i < 5; i++) await edit({ scheduledTime: `1${i}:30` });
    assert.equal(booking("b1").graceRestartCount, 6, "no cap");
    assert.equal(booking("b1").status, "pending_payment");
  });
});

// ============================================
// Admin: check again / cancel (decision 2026-11-21)
// ============================================

/** Seed booking `id` and run the sweep until it is set aside (live checkout in progress). */
async function setAside(id: string, overrides: Record<string, unknown> = {}): Promise<void> {
  await seedPending(id, 30, { transactionId: `live-${id}`, ...overrides });
  paystackStatus(`live-${id}`, id, "ongoing");
  await runSweeps(SWEEP_SET_ASIDE_AFTER_RUNS);
  assert.equal(booking(id).sweepSetAside, true);
}

describe("POST /consultations/:id/sweep-review/check (admin only)", () => {
  test("403 for non-admins; 404 unknown; 409 NOT_SET_ASIDE", async () => {
    await seedPending("plain", 30);
    for (const role of [ROLES.CLIENT, ROLES.AGENT, ROLES.OWNER]) {
      assert.equal((await call("recheckSweepReview", role, "plain")).status, 403, role);
    }
    assert.equal((await call("recheckSweepReview", ROLES.ADMIN, "nope")).status, 404);
    const out = await call("recheckSweepReview", ROLES.ADMIN, "plain");
    assert.equal(out.status, 409);
    assert.equal(out.body.error, "NOT_SET_ASIDE");
  });

  test("still in progress: still_unresolved, stays set aside; once final: released and the next run closes it", async () => {
    await setAside("b1");
    const seen = countLookups();
    const out = await call("recheckSweepReview", ROLES.ADMIN, "b1");
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.equal(out.body.data.result, "still_unresolved");
    assert.equal(out.body.data.reason, "in_progress");
    assert.deepEqual(seen, ["live-b1"]);
    assert.equal(booking("b1").sweepSetAside, true);
    const runs = booking("b1").sweepReview.unresolvedRuns;

    paystackAbandoned("live-b1", "b1");
    const again = await call("recheckSweepReview", ROLES.ADMIN, "b1");
    assert.equal(again.body.data.result, "released");
    assert.equal(booking("b1").sweepSetAside, false);
    assert.equal(booking("b1").sweepReview.unresolvedRuns, 0);
    assert.ok(runs >= SWEEP_SET_ASIDE_AFTER_RUNS);
    assert.equal(booking("b1").status, "pending_payment", "the check itself never cancels");
    const swept = await consultationService.sweepAbandonedBookings();
    assert.equal(swept.cancelled, 1);
    assert.equal(booking("b1").cancelledBy, "system");
  });

  test("paid at Paystack now: settled through settlePayment (confirmed)", async () => {
    await setAside("b1");
    paystackPaid("live-b1", "b1", { amountMinor: FEE_KOBO, currency: "NGN" });
    const out = await call("recheckSweepReview", ROLES.ADMIN, "b1");
    assert.equal(out.body.data.result, "settled");
    assert.equal(booking("b1").status, "scheduled");
    assert.equal(docsIn("transactions").filter(([, t]) => t.type === "consultation_fee").length, 1);
  });

  test("a recorded final reference is asked about again by an admin check (fresh look)", async () => {
    await seedPending("b1", 30, { transactionId: "live-b1", supersededCheckouts: [entry("old-1")] });
    paystackAbandoned("old-1", "b1");
    paystackStatus("live-b1", "b1", "ongoing");
    await runSweeps(SWEEP_SET_ASIDE_AFTER_RUNS);
    assert.equal(booking("b1").sweepSetAside, true);
    const recorded = booking("b1").sweepReview.checkouts.find((r: any) => r.reference === "old-1");
    assert.equal(recorded.state, "final_unpaid");
    const seen = countLookups();
    await call("recheckSweepReview", ROLES.ADMIN, "b1");
    assert.deepEqual(seen, ["old-1", "live-b1"]);
  });

  test("raced against verify: the payer's verify confirms during the check; the answer is settled and nothing is released over it", async () => {
    await setAside("b1");
    paystackAbandoned("live-b1", "b1"); // what the check's lookup sees
    harness.onLookup = async () => {
      harness.onLookup = undefined;
      paystackPaid("live-b1", "b1", { amountMinor: FEE_KOBO, currency: "NGN" });
      const out = await verify("live-b1");
      assert.equal(out.status, 200, JSON.stringify(out.body));
      return undefined;
    };
    const out = await call("recheckSweepReview", ROLES.ADMIN, "b1");
    assert.equal(out.body.data.result, "settled");
    assert.equal(booking("b1").status, "scheduled");
    assert.equal(booking("b1").sweepSetAside, true, "the paid booking was not rewritten by the release");
  });
});

describe("POST /consultations/:id/sweep-review/cancel (admin only)", () => {
  test("403 for non-admins, before anything is read; 404 unknown", async () => {
    await setAside("b1");
    for (const role of [ROLES.CLIENT, ROLES.AGENT, ROLES.OWNER]) {
      assert.equal((await call("cancelSweepReview", role, "b1")).status, 403, role);
    }
    assert.equal(booking("b1").status, "pending_payment");
    assert.equal((await call("cancelSweepReview", ROLES.ADMIN, "nope")).status, 404);
  });

  test("a checkout still in progress: 409 PAYMENT_IN_PROGRESS, not cancelled", async () => {
    await setAside("b1");
    const out = await call("cancelSweepReview", ROLES.ADMIN, "b1");
    assert.equal(out.status, 409);
    assert.equal(out.body.error, "PAYMENT_IN_PROGRESS");
    assert.equal(booking("b1").status, "pending_payment");
  });

  test("Paystack failing: 502 PAYSTACK_ERROR, not cancelled (fail closed)", async () => {
    await setAside("b1");
    harness.failNextLookup = true;
    const out = await call("cancelSweepReview", ROLES.ADMIN, "b1");
    assert.equal(out.status, 502);
    assert.equal(out.body.error, "PAYSTACK_ERROR");
    assert.equal(booking("b1").status, "pending_payment");
  });

  test("paid with the wrong amount: 409 PAYMENT_NEEDS_REVIEW; paid exactly: 409 BOOKING_PAID (confirmed)", async () => {
    await setAside("b1");
    paystackPaid("live-b1", "b1", { amountMinor: FEE_KOBO - 1, currency: "NGN" });
    const review = await call("cancelSweepReview", ROLES.ADMIN, "b1");
    assert.equal(review.status, 409);
    assert.equal(review.body.error, "PAYMENT_NEEDS_REVIEW");
    paystackPaid("live-b1", "b1", { amountMinor: FEE_KOBO, currency: "NGN" });
    const paid = await call("cancelSweepReview", ROLES.ADMIN, "b1");
    assert.equal(paid.status, 409);
    assert.equal(paid.body.error, "BOOKING_PAID");
    assert.equal(booking("b1").status, "scheduled");
    // Then: not pending any more.
    const after = await call("cancelSweepReview", ROLES.ADMIN, "b1");
    assert.equal(after.body.error, "NOT_PENDING");
  });

  test("everything final: cancelled by the admin (their uid), with the sweep's sentence; no money row written", async () => {
    await setAside("b1", { supersededCheckouts: [entry("old-1")] });
    paystackAbandoned("old-1", "b1");
    paystackAbandoned("live-b1", "b1");
    const seen = countLookups();
    const out = await call("cancelSweepReview", ROLES.ADMIN, "b1");
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.equal(out.body.data.cancelled, true);
    assert.deepEqual(seen, ["old-1", "live-b1"], "every checkout asked about again");
    const b = booking("b1");
    assert.equal(b.status, "cancelled");
    assert.equal(b.cancelledBy, `uid-${ROLES.ADMIN}`);
    assert.equal(b.cancellationReason, SYSTEM_CANCELLATION_REASON);
    assert.equal(docsIn("transactions").length, 0);
  });

  test("a retired checkout recorded final unpaid but PAID since: the fresh look refunds it through settlePayment, then cancels", async () => {
    await setAside("b1", { supersededCheckouts: [entry("old-1")] });
    // The sweep saw old-1 as final unpaid (Paystack had nothing for it)...
    assert.equal(booking("b1").sweepReview.checkouts.find((r: any) => r.reference === "old-1").state, "final_unpaid");
    // ...but an "abandoned" checkout can still be completed later.
    paystackPaid("old-1", "b1", { amountMinor: FEE_KOBO, currency: "NGN" });
    paystackAbandoned("live-b1", "b1");
    assert.equal(refundsOf("b1").length, 0);
    const out = await call("cancelSweepReview", ROLES.ADMIN, "b1");
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.equal(refundsOf("b1").length, 1, "one refund, written by settlePayment");
    assert.equal(docsIn("consultationPaymentExceptions").length, 1);
    assert.equal(docsIn("consultationPaymentExceptions")[0][1].reason, "paid_for_rescheduled_slot");
    assert.equal(booking("b1").status, "cancelled");
  });

  test("grace still running (a guest's live pay link): 409 GRACE_RUNNING", async () => {
    await setAside("g1", { bookedVia: "public_page" });
    await fakeCollection("consultations").doc("g1").update({
      payLinkExpiresAt: Timestamp.fromMillis(harness.clock.now().getTime() + 48 * HOUR_MS),
      scheduledDate: Timestamp.fromDate(new Date("2027-01-10")),
    });
    const out = await call("cancelSweepReview", ROLES.ADMIN, "g1");
    assert.equal(out.status, 409);
    assert.equal(out.body.error, "GRACE_RUNNING");
  });

  test("raced against verify: a payment confirmed between the checks and the cancel wins (409 BOOKING_CHANGED, booking paid)", async () => {
    await setAside("b1");
    paystackAbandoned("live-b1", "b1"); // what the admin's lookup sees
    harness.onLookup = async () => {
      harness.onLookup = undefined;
      paystackPaid("live-b1", "b1", { amountMinor: FEE_KOBO, currency: "NGN" });
      const out = await verify("live-b1");
      assert.equal(out.status, 200, JSON.stringify(out.body));
      return undefined;
    };
    const out = await call("cancelSweepReview", ROLES.ADMIN, "b1");
    assert.equal(out.status, 409);
    assert.equal(out.body.error, "BOOKING_CHANGED");
    assert.equal(booking("b1").status, "scheduled");
    assert.equal(booking("b1").paymentStatus, "paid");
  });

  test("raced against verify the other way: a verify after the admin cancel is recorded and refunded by settlePayment", async () => {
    await setAside("b1");
    paystackAbandoned("live-b1", "b1");
    const out = await call("cancelSweepReview", ROLES.ADMIN, "b1");
    assert.equal(out.status, 200);
    paystackPaid("live-b1", "b1", { amountMinor: FEE_KOBO, currency: "NGN" });
    const late = await verify("live-b1");
    assert.equal(late.status, 409);
    assert.equal(late.body.error, "BOOKING_NOT_PAYABLE");
    assert.equal(docsIn("consultationPaymentExceptions")[0][1].reason, "booking_not_payable");
    assert.equal(refundsOf("b1").length, 1);
    assert.equal(booking("b1").status, "cancelled");
  });
});

// ============================================
// A guest's live pay link keeps the booking (decision 2026-11-21, #391)
// ============================================

describe("guest pay link (payLinkExpiresAt)", () => {
  const at = new Date("2026-11-20T12:00:00Z");
  /** A guest booking long past its normal grace, slot on `slot`, link expiring `linkMs` from `at`. */
  const row = (linkMs: number | null, slot = "2026-11-25", overrides: Record<string, unknown> = {}): any => ({
    status: "pending_payment", paymentStatus: "pending", bookedVia: "public_page",
    quoteExpiresAt: Timestamp.fromMillis(at.getTime() - 72 * HOUR_MS),
    scheduledDate: Timestamp.fromDate(new Date(slot)), scheduledTime: "10:00", timezone: "Africa/Lagos",
    ...(linkMs === null ? {} : { payLinkExpiresAt: Timestamp.fromMillis(at.getTime() + linkMs) }),
    ...overrides,
  });

  test("the grace runs until the later of the normal grace and the link's expiry, never past the slot start", () => {
    assert.equal(isAbandonedBooking(row(null), at), true, "no link: as before");
    assert.equal(isAbandonedBooking(row(HOUR_MS), at), false, "a live link keeps it");
    assert.equal(isAbandonedBooking(row(-1), at), true, "an expired link does not");
    assert.equal(isAbandonedBooking(row(0), at), true, "expires exactly now: no longer live");
    // A link stored past the slot start counts only until the slot starts (10:00 Lagos = 09:00 UTC).
    const slotToday = row(48 * HOUR_MS, "2026-11-20");
    assert.equal(guestPayLinkStillLive(slotToday, at), false, "the slot started at 09:00 UTC, before `at`");
    assert.equal(guestPayLinkStillLive(slotToday, new Date("2026-11-20T08:59:00Z")), true);
    // Only guest bookings.
    assert.equal(isAbandonedBooking(row(HOUR_MS, "2026-11-25", { bookedVia: "client" }), at), true);
    // Never shortens the normal grace.
    const recentLock = row(-HOUR_MS, "2026-11-25", { quoteExpiresAt: Timestamp.fromMillis(at.getTime() - HOUR_MS) });
    assert.equal(isAbandonedBooking(recentLock, at), false);
  });

  test("the sweep leaves a guest booking with a live link (no Paystack call), and sweeps it once the link expired", async () => {
    await seedPending("g1", 30, {
      bookedVia: "public_page", transactionId: "live-g1",
      scheduledDate: Timestamp.fromDate(new Date("2027-01-10")),
      payLinkExpiresAt: Timestamp.fromMillis(harness.clock.now().getTime() + 10 * HOUR_MS),
    });
    paystackAbandoned("live-g1", "g1");
    const seen = countLookups();
    const first = await consultationService.sweepAbandonedBookings();
    assert.equal(first.skipped, 1);
    assert.deepEqual(seen, []);
    assert.equal(booking("g1").status, "pending_payment");
    harness.clock.advanceHours(11);
    const after = await consultationService.sweepAbandonedBookings();
    assert.equal(after.cancelled, 1);
  });

  test("a link issued between the sweep's lookups and its cancel wins", async () => {
    await seedPending("g1", 30, {
      bookedVia: "public_page", transactionId: "live-g1", scheduledDate: Timestamp.fromDate(new Date("2027-01-10")),
    });
    paystackAbandoned("live-g1", "g1");
    harness.onLookup = async () => {
      harness.onLookup = undefined;
      await fakeCollection("consultations").doc("g1").update({
        payLinkExpiresAt: Timestamp.fromMillis(harness.clock.now().getTime() + 72 * HOUR_MS),
      });
      return undefined;
    };
    const result = await consultationService.sweepAbandonedBookings();
    assert.equal(result.cancelled, 0);
    assert.equal(booking("g1").status, "pending_payment");
  });
});

// ============================================
// Wiring: index, routes, creation, backfill
// ============================================

describe("wiring (issue #411)", () => {
  test("firestore.indexes.json has consultations(status, sweepSetAside, quoteExpiresAt) (the emulator does not enforce indexes)", () => {
    const file = path.resolve(__dirname, "../../../firestore.indexes.json");
    const { indexes } = JSON.parse(fs.readFileSync(file, "utf8")) as {
      indexes: { collectionGroup: string; queryScope: string; fields: { fieldPath: string; order?: string }[] }[];
    };
    const found = indexes.some(
      (index) =>
        index.collectionGroup === "consultations" &&
        index.queryScope === "COLLECTION" &&
        JSON.stringify(index.fields) ===
          JSON.stringify([
            { fieldPath: "status", order: "ASCENDING" },
            { fieldPath: "sweepSetAside", order: "ASCENDING" },
            { fieldPath: "quoteExpiresAt", order: "ASCENDING" },
          ])
    );
    assert.equal(found, true);
    // The queries are the ones that index serves.
    const source = fs.readFileSync(path.resolve(__dirname, "../../src/services/consultation.service.ts"), "utf8");
    assert.match(source, /\.where\("status", "==", "pending_payment"\)\s*\/\/[^\n]*\n\s*\.where\("sweepSetAside", "==", false\)\s*\.where\("quoteExpiresAt", "<", cutoff\)\s*\.orderBy\("quoteExpiresAt", "asc"\)/);
    assert.match(source, /\.where\("status", "==", "pending_payment"\)\s*\.where\("sweepSetAside", "==", true\)\s*\.orderBy\("quoteExpiresAt", "asc"\)/);
  });

  test("the admin routes are registered with verifyAuth, /sweep-review before /:id", () => {
    const source = fs.readFileSync(path.resolve(__dirname, "../../src/routes/consultation.routes.ts"), "utf8");
    const list = source.indexOf("router.get(\"/sweep-review\", verifyAuth");
    const byId = source.indexOf("router.get(\"/:id\", verifyAuth");
    assert.notEqual(list, -1);
    assert.ok(list < byId, "/sweep-review is matched before /:id");
    assert.match(source, /router\.post\("\/:id\/sweep-review\/check", verifyAuth/);
    assert.match(source, /router\.post\("\/:id\/sweep-review\/cancel", verifyAuth/);
  });

  test("a new unpaid booking is created with sweepSetAside: false (through the real guest route)", async () => {
    await seed("agencies", "ag1", {
      name: "Acme Visas", slug: "acme", status: "approved", ownerId: "owner-ag1", ownerName: "Ola Owner",
      services: [], consultationFeeUsd: { amountMinor: 10_000, currency: "USD" }, createdAt: T0,
    });
    const { out, res } = captureRes();
    await consultationController.createPublicConsultation(
      {
        params: { slug: "acme" },
        body: { clientName: "Gina Guest", clientEmail: "delivered+guest@resend.dev", scheduledDate: "2026-12-01", scheduledTime: "10:00" },
      } as any,
      res
    );
    assert.equal(out.status, 201, JSON.stringify(out.body));
    assert.equal(booking(out.body.data.consultationId).sweepSetAside, false);
  });

  test("backfill:sweep-lane stamps only unpaid bookings that lack the field; dry run writes nothing; idempotent", async () => {
    assert.equal(needsSweepLane({ status: "pending_payment" } as any), true);
    assert.equal(needsSweepLane({ status: "pending_payment", sweepSetAside: true } as any), false);
    assert.equal(needsSweepLane({ status: "scheduled" } as any), false);
    assert.equal(needsSweepLane(null), false);

    await seedPending("old", 30, { sweepSetAside: undefined });
    // Already has the field (and is too recent to be swept).
    await seedPending("marked", 1, { sweepSetAside: false });
    await seedPending("paid", 30, { status: "scheduled", paymentStatus: "paid", sweepSetAside: undefined });
    // Not swept before the backfill (Firestore never matches a missing field).
    assert.equal((await consultationService.sweepAbandonedBookings()).scanned, 0);

    const dry = await backfillSweepLane({ apply: false });
    assert.deepEqual(dry, { scanned: 2, stamped: 1, skipped: 1 });
    assert.equal(booking("old").sweepSetAside, undefined);
    const applied = await backfillSweepLane({ apply: true });
    assert.equal(applied.stamped, 1);
    assert.equal(booking("old").sweepSetAside, false);
    assert.equal(booking("old").updatedAt.toMillis(), T0.toMillis(), "updatedAt untouched");
    assert.equal(booking("marked").sweepSetAside, false);
    assert.equal(booking("paid").sweepSetAside, undefined);
    assert.equal((await backfillSweepLane({ apply: true })).stamped, 0);
    // Now swept.
    assert.equal((await consultationService.sweepAbandonedBookings()).cancelled, 1);
  });
});

// ============================================
// Review round 1 (orchestrator notes 1, 2, 3 and 5)
// ============================================

describe("review round 1: the live checkout, outages, the time budget, the cancelled wording", () => {
  /** Every notification of the test. */
  const notified: Array<{ userId: string; type: string; body: string }> = [];
  beforeEach(() => {
    notified.length = 0;
    (notificationService as any).notifyUser = async (n: { userId: string; type: string; body: string }) => {
      notified.push({ userId: n.userId, type: n.type, body: n.body });
    };
    sweepRuntime.wallClockMs = realWallClock;
  });
  const realWallClock = sweepRuntime.wallClockMs;

  test("note 1: a PAID live checkout is settled even while an older retired one is still in progress", async () => {
    await seedPending("b1", 30, { transactionId: "live-1", supersededCheckouts: [entry("old-1")] });
    paystackStatus("old-1", "b1", "ongoing");
    paystackPaid("live-1", "b1", { amountMinor: FEE_KOBO, currency: "NGN" });
    const seen = countLookups();
    const result = await consultationService.sweepAbandonedBookings();
    assert.deepEqual(seen, ["old-1", "live-1"]);
    assert.equal(result.settled, 1);
    assert.equal(result.cancelled, 0);
    assert.equal(booking("b1").status, "scheduled");
    assert.equal(booking("b1").paymentStatus, "paid");
    assert.equal(booking("b1").transactionId, "live-1");
  });

  test("note 1: the same while an older checkout keeps failing (Paystack's own 'not found')", async () => {
    await seedPending("b1", 30, { transactionId: "live-1", supersededCheckouts: [entry("T999paystackmade")] });
    harness.realisticNotFound = true;
    paystackPaid("live-1", "b1", { amountMinor: FEE_KOBO, currency: "NGN" });
    const result = await consultationService.sweepAbandonedBookings();
    assert.equal(result.settled, 1);
    assert.equal(booking("b1").status, "scheduled");
  });

  test("note 1: the admin check never stops early: a set-aside booking whose live checkout is paid is settled", async () => {
    await seedPending("b1", 30, { transactionId: "live-1", supersededCheckouts: [entry("old-1"), entry("old-2")] });
    paystackStatus("old-1", "b1", "ongoing");
    paystackAbandoned("old-2", "b1");
    paystackAbandoned("live-1", "b1");
    await runSweeps(SWEEP_SET_ASIDE_AFTER_RUNS);
    assert.equal(booking("b1").sweepSetAside, true);
    // The client paid the live checkout after all (webhook missed).
    paystackPaid("live-1", "b1", { amountMinor: FEE_KOBO, currency: "NGN" });
    const seen = countLookups();
    const out = await call("recheckSweepReview", ROLES.ADMIN, "b1");
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.equal(out.body.data.result, "settled");
    assert.deepEqual(seen, ["old-1", "old-2", "live-1"], "every checkout asked, none skipped");
    assert.equal(booking("b1").status, "scheduled");
  });

  test("note 2: a Paystack outage never sets bookings aside, however long it lasts", async () => {
    await seedPending("b1", 30, { transactionId: "live-1" });
    paystackStatus("live-1", "b1", "ongoing");
    harness.onLookup = async () => {
      throw new Error("PAYSTACK_ERROR: Invalid key (HTTP 401)");
    };
    await runSweeps(SWEEP_SET_ASIDE_AFTER_RUNS + 2);
    const b = booking("b1");
    assert.equal(b.sweepSetAside, false);
    assert.equal(b.sweepReview.unresolvedRuns, 0);
    assert.equal(b.sweepReview.lastOutcome, "lookup_failed", "the reason is still recorded");
    assert.equal(b.status, "pending_payment");
  });

  test("note 3: once the run's time budget is spent, the remaining bookings wait for the next run (left, untouched)", async () => {
    await seedPending("a", 32, { transactionId: "live-a" });
    await seedPending("b", 31, { transactionId: "live-b" });
    await seedPending("c", 30, { transactionId: "live-c" });
    let ms = 0;
    sweepRuntime.wallClockMs = () => ms;
    // The first booking takes the whole budget.
    harness.onLookup = async () => {
      ms += SWEEP_TIME_BUDGET_MS;
      return undefined;
    };
    for (const id of ["a", "b", "c"]) paystackAbandoned(`live-${id}`, id);
    const before = JSON.stringify([booking("b"), booking("c")]);
    const result = await consultationService.sweepAbandonedBookings();
    assert.equal(result.leftForCap, 2);
    assert.equal(JSON.stringify([booking("b"), booking("c")]), before);
  });

  test("note 3: Paystack lookups carry a 10 s timeout", () => {
    assert.equal(PAYSTACK_LOOKUP_TIMEOUT_MS, 10_000);
    const source = fs.readFileSync(path.join(__dirname, "../../src/services/billing/paystack.provider.ts"), "utf8");
    // verify (twice: metadata and the refund list's id), the refund list, and fetch refund.
    assert.equal((source.match(/timeout: PAYSTACK_LOOKUP_TIMEOUT_MS/g) ?? []).length, 4);
  });

  test("note 5: a retired checkout paid late, refunded and then cancelled in the same run: the client is told it was cancelled, never 'pay again'", async () => {
    await recordedThenPaidRetired();
    const result = await consultationService.sweepAbandonedBookings();
    assert.equal(result.cancelled, 1);
    const notices = notified.filter((n) => n.type === "consultation_refunded" && n.userId === "uid-client1");
    assert.equal(notices.length, 1, "told once");
    assert.equal(
      notices[0].body,
      "Your consultation was cancelled, so we're refunding your payment in full. Your refund is on its way."
    );
    assert.ok(!/pay again/i.test(notices[0].body));
  });

  test("note 5: the same through the admin sweep cancel", async () => {
    await recordedThenPaidRetired();
    const out = await call("cancelSweepReview", ROLES.ADMIN, "b1");
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.equal(booking("b1").status, "cancelled");
    const notices = notified.filter((n) => n.type === "consultation_refunded" && n.userId === "uid-client1");
    assert.equal(notices.length, 1);
    assert.match(notices[0].body, /^Your consultation was cancelled/);
  });

  test("note 5: when the cancel does not happen (the booking changed), the usual wording is sent, once", async () => {
    await recordedThenPaidRetired();
    const real = (consultationService as any).cancelAbandonedBooking;
    (consultationService as any).cancelAbandonedBooking = async () => false;
    try {
      await consultationService.sweepAbandonedBookings();
    } finally {
      (consultationService as any).cancelAbandonedBooking = real;
    }
    const notices = notified.filter((n) => n.type === "consultation_refunded" && n.userId === "uid-client1");
    assert.equal(notices.length, 1);
    assert.match(notices[0].body, /Please pay again for the new time\.$/);
  });

  /** A retired checkout recorded as final unpaid, then paid; the live one now final unpaid too. */
  async function recordedThenPaidRetired(): Promise<void> {
    await seedPending("b1", 30, { transactionId: "live-1", supersededCheckouts: [entry("old-1", true)] });
    paystackAbandoned("old-1", "b1");
    paystackStatus("live-1", "b1", "ongoing");
    await consultationService.sweepAbandonedBookings();
    paystackPaid("old-1", "b1", { amountMinor: FEE_KOBO, currency: "NGN" }, harness.clock.now(), { fees: 20_000 });
    paystackAbandoned("live-1", "b1");
    harness.clock.advanceHours(1);
    notified.length = 0;
  }
});

// ============================================
// Review round 2: a settle that throws never loses the notices deferred
// before it
// ============================================

describe("review round 2: deferred refund notices survive a later settle failing", () => {
  const notified: Array<{ userId: string; type: string; body: string }> = [];
  beforeEach(() => {
    notified.length = 0;
    (notificationService as any).notifyUser = async (n: { userId: string; type: string; body: string }) => {
      notified.push({ userId: n.userId, type: n.type, body: n.body });
    };
  });

  /** Make every transaction that reads the exception of `reference` throw (a Firestore ABORTED, say). */
  function failSettleOf(reference: string): () => void {
    const real = consultationCharging.runTransaction;
    consultationCharging.runTransaction = ((fn: any) =>
      real((tx: any) =>
        fn(
          new Proxy(tx, {
            get(target, key) {
              if (key === "get") {
                return async (ref: any) => {
                  if (ref?.id === reference) throw new Error("10 ABORTED: too much contention");
                  return target.get(ref);
                };
              }
              const value = target[key];
              return typeof value === "function" ? value.bind(target) : value;
            },
          })
        )
      )) as any;
    return () => {
      consultationCharging.runTransaction = real;
    };
  }

  /** A booking with two paid RETIRED checkouts (the client paid both old slots); the live one final unpaid. */
  async function twoPaidRetired(): Promise<void> {
    await seedPending("b1", 30, { transactionId: "live-1", supersededCheckouts: [entry("old-1"), entry("old-2")] });
    paystackPaid("old-1", "b1", { amountMinor: FEE_KOBO, currency: "NGN" }, harness.clock.now(), { fees: 20_000 });
    paystackPaid("old-2", "b1", { amountMinor: FEE_KOBO, currency: "NGN" }, harness.clock.now(), { fees: 20_000 });
    paystackAbandoned("live-1", "b1");
  }

  const clientNotices = () => notified.filter((n) => n.userId === "uid-client1" && n.type === "consultation_refunded");
  const agentDebitNotices = () =>
    notified.filter((n) => n.userId === "uid-agent1" && /Processing fee taken from your balance|payment processing fee/.test(n.body));

  test("the sweep: the second settle throws; the first refund's notice and the agent's fee-debit notice are still sent, once", async () => {
    await twoPaidRetired();
    const restore = failSettleOf("old-2");
    let result;
    try {
      result = await consultationService.sweepAbandonedBookings();
    } finally {
      restore();
    }
    assert.equal(result.errors, 1, "the failed booking is counted");
    assert.equal(booking("b1").status, "pending_payment", "never cancelled on a failure");
    assert.equal(refundsOf("b1").length, 1, "the first refund was written");
    assert.equal(clientNotices().length, 1, "the client is told about it once");
    assert.match(clientNotices()[0].body, /^Your consultation moved/, "the usual wording: no cancel followed");
    assert.equal(agentDebitNotices().length, 1, "the agent's fee-debit notice too");

    // The next run settles the second one; the first is not announced again.
    harness.clock.advanceHours(1);
    await consultationService.sweepAbandonedBookings();
    assert.equal(refundsOf("b1").length, 2);
    assert.equal(clientNotices().length, 2, "one notice per refund, never two for the first");
    assert.equal(agentDebitNotices().length, 2);
  });

  test("the admin cancel: the same failure still sends the collected notices once", async () => {
    await twoPaidRetired();
    const restore = failSettleOf("old-2");
    try {
      // The controller answers 500; nothing is cancelled.
      await call("cancelSweepReview", ROLES.ADMIN, "b1");
    } finally {
      restore();
    }
    assert.equal(booking("b1").status, "pending_payment");
    assert.equal(refundsOf("b1").length, 1);
    assert.equal(clientNotices().length, 1);
    assert.equal(agentDebitNotices().length, 1);
  });

  test("the time budget also stops lookups inside a booking (the rest waits for the next run)", async () => {
    await seedPending("b1", 30, { transactionId: "live-1", supersededCheckouts: [entry("old-1"), entry("old-2")] });
    for (const r of ["old-1", "old-2", "live-1"]) paystackAbandoned(r, "b1");
    let ms = 0;
    const real = sweepRuntime.wallClockMs;
    sweepRuntime.wallClockMs = () => ms;
    const seen: string[] = [];
    harness.onLookup = async (reference: string) => {
      seen.push(reference);
      ms += SWEEP_TIME_BUDGET_MS; // the first lookup spends the whole budget
      return undefined;
    };
    try {
      const result = await consultationService.sweepAbandonedBookings();
      assert.deepEqual(seen, ["old-1"]);
      assert.equal(result.leftForCap, 1);
      assert.equal(result.cancelled, 0);
      assert.equal(booking("b1").status, "pending_payment");
    } finally {
      sweepRuntime.wallClockMs = real;
    }
  });
});
