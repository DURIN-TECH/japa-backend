// ============================================
// Unit tests — cleanup of abandoned bookings (issue #288)
// ============================================
//
// Hermetic, same harness as the other consultation suites: in-memory
// Firestore, an in-memory rate service, Paystack STUBBED (the harness
// recorders: no real lookup, no network). The clock is the harness clock the
// charge path reads (`chargeRuntime.now`), moved by hand, so nothing waits a
// day.
//
// What is covered, by acceptance criterion:
//  - the decision is a pure function (`decideAbandonedBooking`), with the
//    24-hour boundary;
//  - the sweep cancels `pending_payment` bookings whose quote lock ended more
//    than 24 hours ago, at most 200 per run, guest bookings included;
//  - Paystack first: paid is SETTLED (confirmed, never cancelled), in
//    progress is left alone, final unpaid or no `transactionId` is cancelled;
//  - the cancel writes exactly status / cancelledAt / cancelledBy "system" /
//    cancellationReason (+ updatedAt), in its own transaction that re-reads
//    the booking: a payment or a re-price landing meanwhile wins;
//  - legacy rows (no `quoteExpiresAt`) are not touched;
//  - nobody is notified;
//  - a payment landing later on a cancelled booking is recorded as
//    `booking_not_payable` in consultationPaymentExceptions;
//  - the query's composite index is in firestore.indexes.json and the
//    function is exported from index.ts.
import { test, describe, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import { Timestamp } from "firebase-admin/firestore";

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
import { notificationService } from "../../src/services/notification.service";
import {
  consultationService,
  abandonedCutoff,
  decideAbandonedBooking,
  decideAbandonedCheckouts,
  decideAfterSweepSettles,
  sweepCheckoutReferences,
  isAbandonedBooking,
  ABANDONED_BOOKING_GRACE_HOURS,
  ABANDONED_SWEEP_BATCH_SIZE,
  SYSTEM_CANCEL_ACTOR,
  SYSTEM_CANCELLATION_REASON,
} from "../../src/services/consultation.service";

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Every `notifyUser` call made during a test (the sweep must make none). */
let notifications: unknown[] = [];

before(async () => {
  await useHarness();
});
beforeEach(() => {
  harness.reset();
  notifications = [];
  (notificationService as any).notifyUser = async (input: unknown) => {
    notifications.push(input);
  };
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
 * hours before the harness clock's "now".
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
    ...overrides,
  });
}

/** A stored booking by id. */
function booking(id: string): Record<string, any> {
  const found = docsIn("consultations").find(([docId]) => docId === id);
  assert.ok(found, `booking ${id} exists`);
  return found[1];
}

/** Assert booking `id` was closed by the system at the harness clock's "now". */
function assertSystemCancelled(id: string): void {
  const b = booking(id);
  const now = harness.clock.now().getTime();
  assert.equal(b.status, "cancelled");
  assert.equal(b.cancelledBy, "system");
  assert.equal(b.cancellationReason, "Cancelled by Seli: this booking wasn't paid in time. Please book again.");
  assert.equal(b.cancelledAt.toMillis(), now);
  assert.equal(b.updatedAt.toMillis(), now);
  // Nothing about the payment is rewritten.
  assert.equal(b.paymentStatus, "pending");
}

/** POST /consultations/public/verify. */
async function verify(reference: string) {
  const { out, res } = captureRes();
  await consultationController.verifyPublicConsultation({ body: { reference } } as any, res);
  return out;
}

// ============================================
// The pure decision
// ============================================

describe("decideAbandonedBooking (pure)", () => {
  const at = new Date("2026-11-20T12:00:00Z");
  /** A pending booking whose lock ended `ms` before `at`. */
  const row = (msAgo: number, overrides: Record<string, unknown> = {}): any => ({
    status: "pending_payment", paymentStatus: "pending",
    quoteExpiresAt: Timestamp.fromMillis(at.getTime() - msAgo), transactionId: "cons-x", ...overrides,
  });
  const DAY = ABANDONED_BOOKING_GRACE_HOURS * HOUR_MS;

  test("the constants are the ones the issue names", () => {
    assert.equal(ABANDONED_BOOKING_GRACE_HOURS, 24);
    assert.equal(ABANDONED_SWEEP_BATCH_SIZE, 200);
    assert.equal(SYSTEM_CANCEL_ACTOR, "system");
    assert.equal(SYSTEM_CANCELLATION_REASON, "Cancelled by Seli: this booking wasn't paid in time. Please book again.");
    assert.equal(abandonedCutoff(at).getTime(), at.getTime() - DAY);
  });

  test("abandoned only once the lock ended MORE than 24 hours ago", () => {
    assert.equal(isAbandonedBooking(row(DAY - 1), at), false);
    assert.equal(isAbandonedBooking(row(DAY), at), false, "exactly 24 hours is not yet past");
    assert.equal(isAbandonedBooking(row(DAY + 1), at), true);
    // Inside the lock (expiry in the future).
    assert.equal(isAbandonedBooking(row(-HOUR_MS), at), false);
  });

  test("never abandoned: paid, another status, or a legacy row with no quoteExpiresAt", () => {
    assert.equal(isAbandonedBooking(row(DAY * 3, { paymentStatus: "paid" }), at), false);
    for (const status of ["scheduled", "confirmed", "in_progress", "completed", "cancelled", "no_show"]) {
      assert.equal(isAbandonedBooking(row(DAY * 3, { status }), at), false, status);
    }
    assert.equal(isAbandonedBooking(row(0, { quoteExpiresAt: undefined }), at), false);
    assert.equal(isAbandonedBooking(row(0, { quoteExpiresAt: null }), at), false);
  });

  test("the decision table", () => {
    const old = row(DAY * 2);
    assert.equal(decideAbandonedBooking(old, "paid", at), "settle");
    assert.equal(decideAbandonedBooking(old, "in_progress", at), "leave");
    assert.equal(decideAbandonedBooking(old, "final_unpaid", at), "cancel");
    // A reference that was not looked up: fail closed.
    assert.equal(decideAbandonedBooking(old, null, at), "leave");
    // No checkout was ever claimed: nothing to ask Paystack, cancel.
    assert.equal(decideAbandonedBooking(row(DAY * 2, { transactionId: undefined }), null, at), "cancel");
    // Not abandoned: skipped whatever Paystack says.
    for (const state of ["paid", "in_progress", "final_unpaid", null] as const) {
      assert.equal(decideAbandonedBooking(row(HOUR_MS), state, at), "skip");
      assert.equal(decideAbandonedBooking(row(DAY * 2, { status: "cancelled" }), state, at), "skip");
    }
  });
});

// ============================================
// The sweep
// ============================================

describe("sweepAbandonedBookings", () => {
  test("cancels an unpaid booking a day past its lock (Paystack: abandoned); nobody is notified", async () => {
    await seedPending("b1", 25, { transactionId: "ref-b1", checkoutUrl: "https://checkout.paystack.test/ref-b1" });
    paystackAbandoned("ref-b1", "b1");

    const result = await consultationService.sweepAbandonedBookings();
    assert.deepEqual(result, { scanned: 1, cancelled: 1, settled: 0, leftInProgress: 0, skipped: 0, errors: 0 });
    assertSystemCancelled("b1");
    // The checkout fields are kept (a late payment is matched against them).
    assert.equal(booking("b1").transactionId, "ref-b1");
    assert.equal(notifications.length, 0, "no notification for a system cancel");
    assert.equal(docsIn("notifications").length, 0);
    assert.equal(docsIn("transactions").length, 0);
  });

  test("Paystack 'failed' is final unpaid too: cancelled", async () => {
    await seedPending("b1", 30, { transactionId: "ref-b1", checkoutUrl: "https://checkout.paystack.test/ref-b1" });
    paystackStatus("ref-b1", "b1", "failed");
    const result = await consultationService.sweepAbandonedBookings();
    assert.equal(result.cancelled, 1);
    assertSystemCancelled("b1");
  });

  test("a booking with no transactionId is cancelled without asking Paystack", async () => {
    await seedPending("no-checkout", 48);
    let lookups = 0;
    harness.onLookup = async () => {
      lookups++;
      return undefined;
    };
    const result = await consultationService.sweepAbandonedBookings();
    assert.equal(result.cancelled, 1);
    assert.equal(lookups, 0);
    assertSystemCancelled("no-checkout");
  });

  test("a checkout we claimed but Paystack never opened ('reference not found') is cancelled", async () => {
    harness.realisticNotFound = true;
    const reference = "cons-b1-123e4567-e89b-42d3-a456-426614174000"; // one of OUR references
    await seedPending("b1", 26, { transactionId: reference });
    const result = await consultationService.sweepAbandonedBookings();
    assert.equal(result.cancelled, 1);
    assertSystemCancelled("b1");
  });

  test("PAID at Paystack: settled through settlePayment (confirmed, never cancelled)", async () => {
    await seedPending("b1", 40, { transactionId: "ref-b1", checkoutUrl: "https://checkout.paystack.test/ref-b1" });
    paystackPaid("ref-b1", "b1", { amountMinor: FEE_KOBO, currency: "NGN" });

    const result = await consultationService.sweepAbandonedBookings();
    assert.deepEqual(result, { scanned: 1, cancelled: 0, settled: 1, leftInProgress: 0, skipped: 0, errors: 0 });
    const b = booking("b1");
    assert.equal(b.status, "scheduled");
    assert.equal(b.paymentStatus, "paid");
    assert.equal(b.cancelledBy, undefined);
    assert.equal(b.cancelledAt, undefined);
    // The fee Transaction is written, as on any settled payment.
    const transactions = docsIn("transactions");
    assert.equal(transactions.length, 1);
    assert.equal(transactions[0][1].amount, FEE_KOBO);
    assert.equal(notifications.length, 0);
  });

  test("paid, but not what the checkout asked (underpaid): neither settled nor cancelled", async () => {
    await seedPending("b1", 40, { transactionId: "ref-b1", checkoutUrl: "https://checkout.paystack.test/ref-b1" });
    paystackPaid("ref-b1", "b1", { amountMinor: FEE_KOBO - 1, currency: "NGN" });
    const before = JSON.stringify(booking("b1"));
    const result = await consultationService.sweepAbandonedBookings();
    assert.deepEqual(result, { scanned: 1, cancelled: 0, settled: 0, leftInProgress: 0, skipped: 1, errors: 0 });
    assert.equal(JSON.stringify(booking("b1")), before);
    assert.equal(docsIn("transactions").length, 0);
  });

  for (const status of ["ongoing", "pending", "processing", "queued", "something-new"]) {
    test(`IN PROGRESS at Paystack ('${status}'): left alone`, async () => {
      await seedPending("b1", 100, { transactionId: "ref-b1", checkoutUrl: "https://checkout.paystack.test/ref-b1" });
      paystackStatus("ref-b1", "b1", status);
      const before = JSON.stringify(booking("b1"));
      const result = await consultationService.sweepAbandonedBookings();
      assert.deepEqual(result, { scanned: 1, cancelled: 0, settled: 0, leftInProgress: 1, skipped: 0, errors: 0 });
      assert.equal(JSON.stringify(booking("b1")), before);
    });
  }

  test("not yet 24 hours past the lock: not even scanned; one clock hour later it is cancelled", async () => {
    await seedPending("recent", 23.5);
    await seedPending("inside-lock", -0.25); // its lock is still open
    const before = { a: JSON.stringify(booking("recent")), b: JSON.stringify(booking("inside-lock")) };

    const first = await consultationService.sweepAbandonedBookings();
    assert.deepEqual(first, { scanned: 0, cancelled: 0, settled: 0, leftInProgress: 0, skipped: 0, errors: 0 });
    assert.equal(JSON.stringify(booking("recent")), before.a);
    assert.equal(JSON.stringify(booking("inside-lock")), before.b);

    // The sweep reads the charge path's clock: move it, no waiting.
    harness.clock.advanceHours(1);
    const second = await consultationService.sweepAbandonedBookings();
    assert.equal(second.scanned, 1);
    assert.equal(second.cancelled, 1);
    assertSystemCancelled("recent");
    assert.equal(JSON.stringify(booking("inside-lock")), before.b);
  });

  test("legacy rows (no quoteExpiresAt), paid, free and already-cancelled bookings are not touched", async () => {
    await seed("consultations", "legacy", {
      userId: "uid-client1", agentId: "uid-agent1", clientName: "Chi Client",
      clientEmail: "delivered+client1@resend.dev", agentName: "Ada Agent", type: "initial",
      scheduledDate: Timestamp.fromDate(new Date("2026-12-01")), scheduledTime: "10:00",
      durationMinutes: 30, timezone: "Africa/Lagos", status: "pending_payment", paymentStatus: "pending",
      fee: 25_000, createdAt: T0, updatedAt: T0,
    });
    await seedPending("paid", 72, { status: "scheduled", paymentStatus: "paid", transactionId: "ref-paid", paidAt: T0 });
    await seedPending("cancelled", 72, { status: "cancelled", cancelledBy: "uid-client1", cancelledAt: T0 });
    const before = ["legacy", "paid", "cancelled"].map((id) => JSON.stringify(booking(id)));

    const result = await consultationService.sweepAbandonedBookings();
    assert.deepEqual(result, { scanned: 0, cancelled: 0, settled: 0, leftInProgress: 0, skipped: 0, errors: 0 });
    assert.deepEqual(["legacy", "paid", "cancelled"].map((id) => JSON.stringify(booking(id))), before);
  });

  test("guest bookings are swept like any other", async () => {
    // Made through the real guest route, then abandoned.
    await seed("agencies", "ag1", {
      name: "Acme Visas", slug: "acme", status: "approved", ownerId: "owner-ag1", ownerName: "Ola Owner",
      services: [], consultationFeeUsd: { amountMinor: 10_000, currency: "USD" }, createdAt: T0,
    });
    const { out, res } = captureRes();
    await consultationController.createPublicConsultation(
      {
        params: { slug: "acme" },
        body: {
          clientName: "Gina Guest", clientEmail: "delivered+guest@resend.dev",
          scheduledDate: "2026-12-01", scheduledTime: "10:00",
        },
      } as any,
      res
    );
    assert.equal(out.status, 201, JSON.stringify(out.body));
    const { consultationId, reference } = out.body.data;
    assert.equal(booking(consultationId).bookedVia, "public_page");
    notifications = []; // the guest route itself tells the agency owner

    // 30 minutes of lock + 24 hours + a little.
    harness.clock.advanceHours(25);
    paystackAbandoned(reference, consultationId);
    const result = await consultationService.sweepAbandonedBookings();
    assert.equal(result.cancelled, 1);
    assertSystemCancelled(consultationId);
    assert.equal(notifications.length, 0);
  });

  test("a Paystack outage on one booking: that one is left, the others still run", async () => {
    await seedPending("first", 50, { transactionId: "ref-first", checkoutUrl: "https://checkout.paystack.test/ref-first" });
    await seedPending("second", 40, { transactionId: "ref-second", checkoutUrl: "https://checkout.paystack.test/ref-second" });
    paystackAbandoned("ref-first", "first");
    paystackAbandoned("ref-second", "second");
    harness.failNextLookup = true; // the oldest lock is looked up first
    const before = JSON.stringify(booking("first"));

    const result = await consultationService.sweepAbandonedBookings();
    assert.deepEqual(result, { scanned: 2, cancelled: 1, settled: 0, leftInProgress: 0, skipped: 0, errors: 1 });
    assert.equal(JSON.stringify(booking("first")), before, "not cancelled without Paystack's answer");
    assertSystemCancelled("second");

    // The next run picks the first one up again.
    const next = await consultationService.sweepAbandonedBookings();
    assert.equal(next.cancelled, 1);
    assertSystemCancelled("first");
  });

  test("at most 200 bookings per run, oldest lock first; the next run takes the rest", async () => {
    const total = ABANDONED_SWEEP_BATCH_SIZE + 5;
    for (let i = 0; i < total; i++) {
      // b0 has the oldest lock, the last ones the most recent.
      await seedPending(`b${i}`, 25 + (total - i));
    }
    const first = await consultationService.sweepAbandonedBookings();
    assert.equal(first.scanned, 200);
    assert.equal(first.cancelled, 200);
    const stillPending = docsIn("consultations").filter(([, d]) => d.status === "pending_payment").map(([id]) => id);
    assert.deepEqual(stillPending.sort(), ["b200", "b201", "b202", "b203", "b204"]);

    const second = await consultationService.sweepAbandonedBookings();
    assert.equal(second.scanned, 5);
    assert.equal(second.cancelled, 5);
    assert.equal(docsIn("consultations").filter(([, d]) => d.status === "pending_payment").length, 0);
  });
});

// ============================================
// The cancel re-reads the booking in its own transaction
// ============================================

describe("sweepAbandonedBookings: a change between the Paystack check and the cancel wins", () => {
  test("the payment is confirmed meanwhile: the booking stays paid, not cancelled", async () => {
    await seedPending("b1", 30, { transactionId: "ref-b1", checkoutUrl: "https://checkout.paystack.test/ref-b1" });
    paystackAbandoned("ref-b1", "b1"); // what the sweep's lookup sees
    harness.onLookup = async () => {
      // "While" the sweep is mid-flight the payer completes the checkout and
      // the return page verifies it.
      harness.onLookup = undefined;
      paystackPaid("ref-b1", "b1", { amountMinor: FEE_KOBO, currency: "NGN" });
      const out = await verify("ref-b1");
      assert.equal(out.status, 200, JSON.stringify(out.body));
      return undefined; // the sweep still gets the "abandoned" answer it asked for
    };

    const result = await consultationService.sweepAbandonedBookings();
    assert.deepEqual(result, { scanned: 1, cancelled: 0, settled: 0, leftInProgress: 0, skipped: 1, errors: 0 });
    const b = booking("b1");
    assert.equal(b.status, "scheduled");
    assert.equal(b.paymentStatus, "paid");
    assert.equal(b.cancelledBy, undefined);
  });

  test("the checkout is replaced meanwhile (another transactionId): not cancelled", async () => {
    await seedPending("b1", 30, { transactionId: "ref-b1", checkoutUrl: "https://checkout.paystack.test/ref-b1" });
    paystackAbandoned("ref-b1", "b1");
    harness.onLookup = async () => {
      harness.onLookup = undefined;
      // A retry claimed a new reference (its new lock is written a moment later).
      await fakeCollection("consultations").doc("b1").update({ transactionId: "ref-b1-new", checkoutUrl: null });
      return undefined;
    };
    const result = await consultationService.sweepAbandonedBookings();
    assert.equal(result.cancelled, 0);
    assert.equal(result.skipped, 1);
    assert.equal(booking("b1").status, "pending_payment");
    assert.equal(booking("b1").transactionId, "ref-b1-new");
  });

  test("the booking is re-priced meanwhile (a fresh quote lock): not cancelled", async () => {
    await seedPending("b1", 30);
    // No transactionId, so no lookup hook: move the lock between the query
    // and the cancel by wrapping the transaction runner once.
    const { consultationCharging } = await import("../../src/services/consultation-charge.service");
    const original = consultationCharging.runTransaction;
    consultationCharging.runTransaction = (async (fn: any) => {
      consultationCharging.runTransaction = original;
      await fakeCollection("consultations").doc("b1").update({
        quoteExpiresAt: Timestamp.fromMillis(harness.clock.now().getTime() + 30 * 60_000),
      });
      return original(fn);
    }) as any;
    try {
      const result = await consultationService.sweepAbandonedBookings();
      assert.equal(result.cancelled, 0);
      assert.equal(result.skipped, 1);
      assert.equal(booking("b1").status, "pending_payment");
    } finally {
      consultationCharging.runTransaction = original;
    }
  });
});

// ============================================
// A payment that lands after the system cancel
// ============================================

describe("a payment landing on a system-cancelled booking", () => {
  test("is recorded as booking_not_payable in consultationPaymentExceptions (no Transaction, booking stays cancelled)", async () => {
    await seedPending("b1", 30, { transactionId: "ref-b1", checkoutUrl: "https://checkout.paystack.test/ref-b1" });
    paystackAbandoned("ref-b1", "b1");
    await consultationService.sweepAbandonedBookings();
    assertSystemCancelled("b1");

    // "Abandoned" checkouts can still be completed: the payer pays it now.
    paystackPaid("ref-b1", "b1", { amountMinor: FEE_KOBO, currency: "NGN" });
    const out = await verify("ref-b1");
    assert.equal(out.status, 409, JSON.stringify(out.body));
    assert.equal(out.body.error, "BOOKING_NOT_PAYABLE");

    const exceptions = docsIn("consultationPaymentExceptions");
    assert.equal(exceptions.length, 1);
    assert.equal(exceptions[0][0], "ref-b1");
    assert.equal(exceptions[0][1].reason, "booking_not_payable");
    assert.equal(exceptions[0][1].consultationId, "b1");
    assert.equal(exceptions[0][1].amountMinor, FEE_KOBO);
    assert.equal(exceptions[0][1].currency, "NGN");
    assert.equal(exceptions[0][1].status, "open");
    // Issue #354: never a fee Transaction; the payment is refunded automatically (one refund row).
    assert.equal(docsIn("transactions").filter(([, t]) => t.type !== "refund").length, 0, "never a fee Transaction");
    assert.equal(docsIn("transactions").filter(([, t]) => t.type === "refund").length, 1);
    assert.equal(booking("b1").status, "cancelled");
    assert.equal(booking("b1").paymentStatus, "pending");
  });
});

// ============================================
// Wiring: the index and the scheduled export
// ============================================

describe("the sweep's wiring", () => {
  test("firestore.indexes.json has the consultations(status, quoteExpiresAt) index", () => {
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
            { fieldPath: "quoteExpiresAt", order: "ASCENDING" },
          ])
    );
    assert.equal(found, true);
  });

  test("index.ts exports an hourly scheduled function that runs the sweep", () => {
    // Read as text: importing index.ts would load every function's wiring.
    const source = fs.readFileSync(path.resolve(__dirname, "../../src/index.ts"), "utf8");
    const start = source.indexOf("export const sweepAbandonedConsultations");
    assert.notEqual(start, -1, "sweepAbandonedConsultations is exported");
    const body = source.slice(start, start + 600);
    assert.match(body, /\.pubsub\.schedule\("20 \* \* \* \*"\)/, "once an hour");
    assert.match(body, /consultationService\.sweepAbandonedBookings\(\)/);
    assert.match(body, /PAYSTACK_SECRET_KEY/, "the Paystack lookup needs its key");
  });
});

// ============================================
// Issue #397: every checkout is asked about, not just the live one
// ============================================
//
// After a reschedule past the quote lock (#354) the booking has NO live
// `transactionId`, only retired entries in `supersededCheckouts`; a
// re-priced booking also keeps its older checkouts there. A payment can
// still land on any of them, so the sweep looks each one up and decides on
// all the answers. Paystack is the harness stub throughout.

/**
 * A `supersededCheckouts` entry priced exactly like `seedPending`'s booking
 * (so a paid entry matches what it asked), optionally retired by a
 * reschedule by `uid-agent1`.
 */
function entry(reference: string, retired: boolean, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    reference,
    priceUsdCents: 1_000, chargedCurrency: "NGN", chargedAmountMinor: FEE_KOBO,
    fxRate: 1500, fxRateAsOf: T0, fxRateSource: "cbn", fxMarginBps: 0,
    quoteLockedAt: Timestamp.fromMillis(harness.clock.now().getTime() - 80 * HOUR_MS),
    quoteExpiresAt: Timestamp.fromMillis(harness.clock.now().getTime() - 79.5 * HOUR_MS),
    supersededAt: T0,
    ...(retired ? { retiredBy: "reschedule", retiredByAgentId: "uid-agent1" } : {}),
    ...overrides,
  };
}

/** Stored rows of a kind for booking `id`. */
const refundsOf = (id: string) =>
  docsIn("transactions").map(([, t]) => t).filter((t) => t.type === "refund" && t.consultationId === id);
const debitsOf = () => docsIn("transactions").map(([, t]) => t).filter((t) => t.type === "paystack_fee_debit");
const feesOf = () => docsIn("transactions").map(([, t]) => t).filter((t) => t.type === "consultation_fee");

/** Count the Paystack lookups of a run, by reference. */
function countLookups(): string[] {
  const seen: string[] = [];
  harness.onLookup = async (reference: string) => {
    seen.push(reference);
    return undefined;
  };
  return seen;
}

describe("decideAbandonedCheckouts (pure, issue #397)", () => {
  const at = new Date("2026-11-20T12:00:00Z");
  const DAY = ABANDONED_BOOKING_GRACE_HOURS * HOUR_MS;
  /** An abandoned booking with the given live reference and superseded references. */
  const row = (live: string | null, superseded: string[], overrides: Record<string, unknown> = {}): any => ({
    status: "pending_payment", paymentStatus: "pending",
    quoteExpiresAt: Timestamp.fromMillis(at.getTime() - 2 * DAY),
    ...(live ? { transactionId: live } : {}),
    supersededCheckouts: superseded.map((reference) => ({ reference })),
    ...overrides,
  });
  type S = "in_progress" | "final_unpaid" | "paid" | "lookup_failed";
  const SUPERSEDED_STATES: S[] = ["in_progress", "final_unpaid", "paid", "lookup_failed"];
  /** What one superseded state alone (beside an unpaid or absent live checkout) must give. */
  const expectedFor = (state: S): any =>
    state === "lookup_failed" ? { kind: "error" }
      : state === "in_progress" ? { kind: "leave" }
        : state === "paid" ? { kind: "settle", references: ["old"] }
          : { kind: "cancel" };

  test("no live checkout x each superseded state", () => {
    for (const state of SUPERSEDED_STATES) {
      const d = decideAbandonedCheckouts(row(null, ["old"]), new Map([["old", state]]), at);
      assert.deepEqual(d, expectedFor(state), state);
    }
  });

  test("a final-unpaid live checkout x each superseded state", () => {
    for (const state of SUPERSEDED_STATES) {
      const d = decideAbandonedCheckouts(
        row("live", ["old"]), new Map<string, S>([["live", "final_unpaid"], ["old", state]]), at
      );
      assert.deepEqual(d, expectedFor(state), state);
    }
  });

  test("a live checkout in each state x each superseded state: error > in progress > paid > cancel", () => {
    const rank = (s: S) => ["final_unpaid", "paid", "in_progress", "lookup_failed"].indexOf(s);
    for (const live of SUPERSEDED_STATES) {
      for (const old of SUPERSEDED_STATES) {
        const d = decideAbandonedCheckouts(row("live", ["old"]), new Map<string, S>([["live", live], ["old", old]]), at);
        const worst = rank(live) >= rank(old) ? live : old;
        const expected =
          worst === "lookup_failed" ? { kind: "error" }
            : worst === "in_progress" ? { kind: "leave" }
              : worst === "paid"
                ? { kind: "settle", references: [live, old].map((st, i) => (st === "paid" ? ["live", "old"][i] : null)).filter(Boolean) }
                : { kind: "cancel" };
        assert.deepEqual(d, expected, `live ${live}, superseded ${old}`);
      }
    }
  });

  test("two superseded entries in different states (no live checkout)", () => {
    const two = row(null, ["a", "b"]);
    const decide = (a: S, b: S) => decideAbandonedCheckouts(two, new Map<string, S>([["a", a], ["b", b]]), at);
    assert.deepEqual(decide("final_unpaid", "final_unpaid"), { kind: "cancel" });
    assert.deepEqual(decide("paid", "final_unpaid"), { kind: "settle", references: ["a"] });
    assert.deepEqual(decide("final_unpaid", "paid"), { kind: "settle", references: ["b"] });
    assert.deepEqual(decide("paid", "paid"), { kind: "settle", references: ["a", "b"] });
    assert.deepEqual(decide("paid", "in_progress"), { kind: "leave" }, "nothing written while one is in flight");
    assert.deepEqual(decide("final_unpaid", "in_progress"), { kind: "leave" });
    assert.deepEqual(decide("in_progress", "lookup_failed"), { kind: "error" });
    assert.deepEqual(decide("paid", "lookup_failed"), { kind: "error" }, "fail closed");
    assert.deepEqual(decide("lookup_failed", "final_unpaid"), { kind: "error" });
  });

  test("no checkout at all: cancel; a reference not looked up: leave; not abandoned: skip", () => {
    assert.deepEqual(decideAbandonedCheckouts(row(null, []), new Map(), at), { kind: "cancel" });
    assert.deepEqual(decideAbandonedCheckouts(row(null, ["a", "b"]), new Map([["a", "final_unpaid" as S]]), at), { kind: "leave" });
    assert.deepEqual(decideAbandonedCheckouts(row("live", []), new Map(), at), { kind: "leave" });
    for (const over of [{ paymentStatus: "paid" }, { status: "cancelled" }, { quoteExpiresAt: Timestamp.fromMillis(at.getTime() - HOUR_MS) }]) {
      assert.deepEqual(
        decideAbandonedCheckouts(row("live", ["old"], over), new Map<string, S>([["live", "paid"], ["old", "paid"]]), at),
        { kind: "skip" }
      );
    }
  });

  test("sweepCheckoutReferences: live first, then superseded in order, no duplicates", () => {
    assert.deepEqual(sweepCheckoutReferences({ transactionId: "l", supersededCheckouts: [{ reference: "a" }, { reference: "l" }, { reference: "b" }] } as any), ["l", "a", "b"]);
    assert.deepEqual(sweepCheckoutReferences({} as any), []);
  });

  test("decideAfterSweepSettles: confirmed wins, unapplicable is review, recorded-and-refunded cancels", () => {
    const o = (kind: string): any => ({ kind });
    assert.equal(decideAfterSweepSettles([o("confirmed")]), "settled");
    assert.equal(decideAfterSweepSettles([o("already_paid")]), "settled");
    assert.equal(decideAfterSweepSettles([o("rescheduled_refund_recorded"), o("confirmed")]), "settled");
    for (const kind of ["rescheduled_refund_recorded", "refund_recorded", "not_payable_recorded"]) {
      assert.equal(decideAfterSweepSettles([o(kind)]), "cancel", kind);
    }
    assert.equal(decideAfterSweepSettles([o("rescheduled_refund_recorded"), o("not_payable_recorded")]), "cancel");
    for (const bad of [o("mismatch"), o("not_chargeable"), o("unknown_reference"), null]) {
      assert.equal(decideAfterSweepSettles([bad]), "review", String(bad?.kind));
      assert.equal(decideAfterSweepSettles([o("rescheduled_refund_recorded"), bad]), "review");
    }
  });
});

describe("sweepAbandonedBookings: retired and superseded checkouts (issue #397)", () => {
  test("every checkout is looked up once: the live one and each superseded entry", async () => {
    await seedPending("b1", 30, {
      transactionId: "live-1",
      supersededCheckouts: [entry("old-1", false), entry("old-2", true)],
    });
    paystackAbandoned("live-1", "b1");
    paystackAbandoned("old-1", "b1");
    paystackStatus("old-2", "b1", "failed");
    const seen = countLookups();
    const result = await consultationService.sweepAbandonedBookings();
    assert.deepEqual(seen, ["live-1", "old-1", "old-2"]);
    assert.deepEqual(result, { scanned: 1, cancelled: 1, settled: 0, leftInProgress: 0, skipped: 0, errors: 0 });
    assertSystemCancelled("b1");
  });

  test("a retired checkout IN PROGRESS: left (nothing written, leftInProgress 1)", async () => {
    await seedPending("b1", 30, { supersededCheckouts: [entry("old-1", true)] });
    paystackStatus("old-1", "b1", "ongoing");
    const before = JSON.stringify(booking("b1"));
    const result = await consultationService.sweepAbandonedBookings();
    assert.deepEqual(result, { scanned: 1, cancelled: 0, settled: 0, leftInProgress: 1, skipped: 0, errors: 0 });
    assert.equal(JSON.stringify(booking("b1")), before);
    assert.equal(docsIn("transactions").length, 0);
    assert.equal(docsIn("consultationPaymentExceptions").length, 0);
  });

  test("an older re-priced checkout in progress beside a final live one: left too", async () => {
    await seedPending("b1", 30, { transactionId: "live-1", supersededCheckouts: [entry("old-1", false)] });
    paystackAbandoned("live-1", "b1");
    paystackStatus("old-1", "b1", "pending");
    const result = await consultationService.sweepAbandonedBookings();
    assert.equal(result.leftInProgress, 1);
    assert.equal(booking("b1").status, "pending_payment");
  });

  test("a retired checkout PAID: one settlePayment, one exception, one refund (full), one fee debit, then cancelled; a second run adds nothing", async () => {
    await seedPending("b1", 30, { supersededCheckouts: [entry("old-1", true)] });
    paystackPaid("old-1", "b1", { amountMinor: FEE_KOBO, currency: "NGN" }, harness.clock.now(), { fees: 20_000 });

    const result = await consultationService.sweepAbandonedBookings();
    assert.deepEqual(result, { scanned: 1, cancelled: 1, settled: 0, leftInProgress: 0, skipped: 0, errors: 0 });
    assertSystemCancelled("b1");

    const exceptions = docsIn("consultationPaymentExceptions");
    assert.equal(exceptions.length, 1);
    assert.equal(exceptions[0][0], "old-1");
    assert.equal(exceptions[0][1].reason, "paid_for_rescheduled_slot", "agent-caused, as #354 decided");
    const refunds = refundsOf("b1");
    assert.equal(refunds.length, 1);
    assert.equal(refunds[0].amount, FEE_KOBO, "refunded in full");
    const debits = debitsOf();
    assert.equal(debits.length, 1);
    assert.equal(debits[0].amount, 20_000);
    assert.equal(debits[0].agentId, "uid-agent1", "debited from retiredByAgentId");
    assert.equal(feesOf().length, 0, "never a fee Transaction");
    assert.equal(harness.refundCalls.length, 1, "one Paystack refund");

    // Second run: the booking is cancelled, so not scanned; nothing new.
    const again = await consultationService.sweepAbandonedBookings();
    assert.equal(again.scanned, 0);
    assert.equal(refundsOf("b1").length, 1, "no second refund");
    assert.equal(debitsOf().length, 1, "no second debit");
    assert.equal(harness.refundCalls.length, 1);
    assert.equal(booking("b1").status, "cancelled");
  });

  test("a paid retired checkout recorded on an EARLIER run is cancelled once the other checkout is final", async () => {
    await seedPending("b1", 30, { supersededCheckouts: [entry("old-1", true), entry("old-2", true)] });
    paystackPaid("old-1", "b1", { amountMinor: FEE_KOBO, currency: "NGN" });
    paystackStatus("old-2", "b1", "ongoing");

    // Run 1: old-2 is in flight, so nothing at all is written.
    const first = await consultationService.sweepAbandonedBookings();
    assert.equal(first.leftInProgress, 1);
    assert.equal(docsIn("consultationPaymentExceptions").length, 0);

    // Meanwhile the payer's verify records old-1 (exception + refund).
    const out = await verify("old-1");
    assert.equal(out.status, 409, JSON.stringify(out.body));
    assert.equal(docsIn("consultationPaymentExceptions").length, 1);
    assert.equal(refundsOf("b1").length, 1);

    // Run 2: old-2 failed for good. old-1 is paid again at Paystack, settled
    // again (idempotent: nothing new), and no longer keeps the booking alive.
    paystackStatus("old-2", "b1", "abandoned");
    const second = await consultationService.sweepAbandonedBookings();
    assert.deepEqual(second, { scanned: 1, cancelled: 1, settled: 0, leftInProgress: 0, skipped: 0, errors: 0 });
    assertSystemCancelled("b1");
    assert.equal(docsIn("consultationPaymentExceptions").length, 1);
    assert.equal(refundsOf("b1").length, 1, "still one refund");
  });

  test("an ordinary re-priced superseded checkout PAID on a pending booking: confirmed at its price, not cancelled", async () => {
    await seedPending("b1", 30, { transactionId: "live-1", supersededCheckouts: [entry("old-1", false)] });
    paystackAbandoned("live-1", "b1");
    paystackPaid("old-1", "b1", { amountMinor: FEE_KOBO, currency: "NGN" });
    const result = await consultationService.sweepAbandonedBookings();
    assert.deepEqual(result, { scanned: 1, cancelled: 0, settled: 1, leftInProgress: 0, skipped: 0, errors: 0 });
    const b = booking("b1");
    assert.equal(b.status, "scheduled");
    assert.equal(b.paymentStatus, "paid");
    assert.equal(b.transactionId, "old-1");
    assert.equal(b.paidOnSupersededReference, true);
    assert.equal(feesOf().length, 1);
    assert.equal(docsIn("consultationPaymentExceptions").length, 0);
  });

  test("a superseded checkout paid with the WRONG amount: left for review (skipped), never cancelled", async () => {
    await seedPending("b1", 30, { supersededCheckouts: [entry("old-1", true)] });
    paystackPaid("old-1", "b1", { amountMinor: FEE_KOBO - 1, currency: "NGN" });
    const before = JSON.stringify(booking("b1"));
    const result = await consultationService.sweepAbandonedBookings();
    assert.deepEqual(result, { scanned: 1, cancelled: 0, settled: 0, leftInProgress: 0, skipped: 1, errors: 0 });
    assert.equal(JSON.stringify(booking("b1")), before);
    assert.equal(docsIn("transactions").length, 0);
  });

  test("a lookup error on a superseded checkout: not cancelled, errors 1, nothing written", async () => {
    await seedPending("b1", 30, { transactionId: "live-1", supersededCheckouts: [entry("old-1", true)] });
    paystackAbandoned("live-1", "b1");
    paystackAbandoned("old-1", "b1");
    // The live one answers, then the superseded one fails.
    let calls = 0;
    harness.onLookup = async (reference: string) => {
      calls++;
      if (reference === "old-1") throw new Error("PAYSTACK_ERROR: 502 Bad Gateway");
      return undefined;
    };
    const before = JSON.stringify(booking("b1"));
    const result = await consultationService.sweepAbandonedBookings();
    assert.deepEqual(result, { scanned: 1, cancelled: 0, settled: 0, leftInProgress: 0, skipped: 0, errors: 1 });
    assert.equal(JSON.stringify(booking("b1")), before);
    assert.equal(calls, 2);
  });

  test("a superseded reference of OURS that Paystack never saw counts as final unpaid", async () => {
    harness.realisticNotFound = true;
    const ours = "cons-b1-123e4567-e89b-42d3-a456-426614174000";
    await seedPending("b1", 30, { supersededCheckouts: [entry(ours, true)] });
    const result = await consultationService.sweepAbandonedBookings();
    assert.equal(result.cancelled, 1);
    assertSystemCancelled("b1");
  });

  test("a superseded reference Paystack generated and answers 'not found': fail closed (errors 1)", async () => {
    harness.realisticNotFound = true;
    await seedPending("b1", 30, { supersededCheckouts: [entry("T123paystackmade", false)] });
    const result = await consultationService.sweepAbandonedBookings();
    assert.equal(result.errors, 1);
    assert.equal(booking("b1").status, "pending_payment");
  });

  test("the superseded list changes between the lookups and the cancel: not cancelled (skipped)", async () => {
    await seedPending("b1", 30, { supersededCheckouts: [entry("old-1", true)] });
    paystackAbandoned("old-1", "b1");
    harness.onLookup = async () => {
      harness.onLookup = undefined;
      // A re-price / retire meanwhile appends another (unchecked) checkout.
      await fakeCollection("consultations").doc("b1").update({
        supersededCheckouts: [entry("old-1", true), entry("old-2", true)],
      });
      return undefined;
    };
    const result = await consultationService.sweepAbandonedBookings();
    assert.deepEqual(result, { scanned: 1, cancelled: 0, settled: 0, leftInProgress: 0, skipped: 1, errors: 0 });
    assert.equal(booking("b1").status, "pending_payment");
  });

  test("a booking that is not abandoned costs no Paystack call at all", async () => {
    await seedPending("paid", 72, {
      paymentStatus: "paid", transactionId: "live-p", supersededCheckouts: [entry("old-p", true)],
    });
    const seen = countLookups();
    const result = await consultationService.sweepAbandonedBookings();
    assert.equal(result.scanned, 1);
    assert.equal(result.skipped, 1);
    assert.deepEqual(seen, []);
  });
});
