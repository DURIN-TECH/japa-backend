// ============================================
// Unit tests: refund payments that can't be applied to a consultation (issue #354)
// ============================================
//
// Hermetic (test/consultations/harness.ts): in-memory Firestore, every
// Paystack call stubbed (charges, lookups AND refunds are recorders; no real
// money moves), a fixed clock the tests move. The consultation webhook
// (#247) is not merged yet, so "verify and webhook arriving together" is
// covered by two `settlePayment` calls on the same reference at once (the
// webhook settles through that same function), and by verify racing a
// direct `settlePayment`.
//
// What is covered, by acceptance criterion:
//  - LATE PAYMENT AFTER A RESCHEDULE: a post-lock reschedule of a
//    pending_payment booking retires its checkout (and older superseded
//    ones) in the same write; an exact payment on the retired reference does
//    not confirm the booking, is recorded `paid_for_rescheduled_slot` and
//    refunded in full; the booking stays pending_payment; the client is told
//    with the exact copy; POST /consultations/:id/checkout then opens a
//    fresh checkout priced NOW; a reschedule INSIDE the lock is still 409
//    PAYMENT_IN_PROGRESS (and that checkout still confirms normally);
//  - EXISTING EXCEPTIONS: a payment after a cancel (`booking_not_payable`)
//    and a second charge (`paid_on_superseded_reference_after_booking_paid`)
//    are refunded automatically in full;
//  - THE EXCEPTION RECORD: `refundId` links the row; `status` open ->
//    refunded on completion (webhook) / refund_failed after the retries run
//    out (listed for admins, retried with `{ refundId }`, back to open);
//  - MONEY: exact amountMinor + currency (GHS too: never re-converted), one
//    refund ever per reference (double verify, concurrent settles, verify vs
//    settle), refund doc id derived from the reference, the agent's balance
//    unchanged, revenue unchanged;
//  - ABUSE: a payment that DID confirm a booking never gets an extra refund
//    through these paths (re-verify, verify after a paid reschedule, an
//    admin retry naming another booking's refund or a fee refund).

import { test, describe, before, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { Timestamp } from "firebase-admin/firestore";

import { useHarness, harness, docsIn, seed, paystackPaid, paystackAbandoned, captureRes, setRate, T0 } from "./harness";
import {
  admin, adminRefund, agent, balanceOf, bookAndPay, bookingOf, client, edit, FEE_NGN, listTransactions,
  refOf, refundEvent, refundRows, reqFor, setStatus, SLOT_DAY, SLOT_TIME, SLOT_ZONE, TEST_PAYSTACK_SECRET, webhook,
} from "./refund-fixtures";
import { notificationService } from "../../src/services/notification.service";
import { consultationController } from "../../src/controllers/consultation.controller";
import { settlePayment } from "../../src/services/consultation-charge.service";
import { consultationRefundService, MAX_REFUND_ATTEMPTS, refundDocId } from "../../src/services/consultation-refund.service";
import { retireCheckoutsForReschedule } from "../../src/services/consultation.service";
import { transactionService } from "../../src/services/transaction.service";
import { revenueEffect } from "../../src/money/totals";
import type { Money } from "../../src/types/money";

/* eslint-disable @typescript-eslint/no-explicit-any */

// ============================================
// Setup: record notifications, silence logs
// ============================================

/** Every notification sent during a test. */
const notified: Array<{ userId: string; type: string; body: string }> = [];
/** Every console.error line during a test. */
const errors: string[] = [];
const realError = console.error;
const realWarn = console.warn;
const realKey = process.env.PAYSTACK_SECRET_KEY;

before(async () => {
  await useHarness();
  (notificationService as any).notifyUser = async (n: { userId: string; type: string; body: string }) => {
    notified.push({ userId: n.userId, type: n.type, body: n.body });
  };
});
beforeEach(() => {
  harness.reset();
  notified.length = 0;
  errors.length = 0;
  // A dummy key, tests only: the refund webhook signature is checked with it.
  process.env.PAYSTACK_SECRET_KEY = TEST_PAYSTACK_SECRET;
  console.error = (...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  };
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  console.warn = () => {};
});
afterEach(() => {
  console.error = realError;
  console.warn = realWarn;
  if (realKey === undefined) delete process.env.PAYSTACK_SECRET_KEY;
  else process.env.PAYSTACK_SECRET_KEY = realKey;
});

// ============================================
// Helpers
// ============================================

/** The copy the client gets when their payment was for a slot that moved. */
const RESCHEDULED_COPY = "Your consultation moved, so we're refunding your payment in full. Your refund is on its way. Please pay again for the new time.";

/**
 * Seed an UNPAID, priced booking `id` with an OPEN checkout (`refOf(id)`,
 * URL published), locked for 30 minutes from the harness's "now".
 */
async function seedPending(id = "c1", charge: Money = FEE_NGN, over: Record<string, unknown> = {}): Promise<string> {
  const reference = refOf(id);
  await seed("consultations", id, {
    userId: client.uid, agentId: agent.uid, agencyId: "agency-a",
    clientName: "Chi Client", clientEmail: "delivered+client1@resend.dev", agentName: "Ada Agent",
    type: "initial", scheduledDate: SLOT_DAY, scheduledTime: SLOT_TIME, durationMinutes: 30, timezone: SLOT_ZONE,
    status: "pending_payment", paymentStatus: "pending",
    priceUsdCents: 600, chargedCurrency: charge.currency, chargedAmountMinor: charge.amountMinor,
    fxRate: 1500, fxRateAsOf: T0, fxRateSource: "cbn", fxMarginBps: 0,
    quoteLockedAt: T0, quoteExpiresAt: Timestamp.fromMillis(T0.toMillis() + 30 * 60_000),
    transactionId: reference, checkoutUrl: `https://checkout.paystack.test/${reference}`,
    createdAt: T0, updatedAt: T0,
    ...over,
  });
  return reference;
}

/** POST /consultations/public/verify with `reference`. */
async function verify(reference: string) {
  const { out, res } = captureRes();
  await consultationController.verifyPublicConsultation({ body: { reference } } as any, res);
  return out;
}

/** POST /consultations/:id/checkout as the client. */
async function checkout(id = "c1") {
  const { out, res } = captureRes();
  await consultationController.checkoutConsultation(reqFor(client, { params: { id } }), res);
  return out;
}

/** Every stored consultation_fee Transaction. */
function feeRows(): Record<string, any>[] {
  return docsIn("transactions").map(([, d]) => d).filter((d) => d.type === "consultation_fee");
}

/** The stored exception of `reference`. */
function exceptionOf(reference: string): Record<string, any> | undefined {
  return docsIn("consultationPaymentExceptions").find(([id]) => id === reference)?.[1];
}

/** Move the clock past the 30-minute quote lock. */
function pastTheLock(): void {
  harness.clock.advanceHours(1);
}

/** Reschedule booking `id` as its agent (a schedule-field edit). */
async function reschedule(id = "c1") {
  return edit(agent, { scheduledDate: "2026-11-27", scheduledTime: "11:00" }, id);
}

/** Assert the refund row of `reference` gives back exactly `charged`, and nothing of the agent's. */
function assertUnappliedRefund(reference: string, charged: Money): Record<string, any> {
  const rows = refundRows();
  assert.equal(rows.length, 1, "exactly one refund row");
  const row = rows[0];
  assert.equal(row.id, refundDocId(reference), "doc id derived from the reference");
  assert.equal(row.providerTransactionId, reference);
  assert.equal(row.amount, charged.amountMinor, "the exact minor-unit amount charged");
  assert.equal(row.currency, charged.currency, "the charged currency, never re-converted");
  assert.equal(row.paymentExceptionId, reference);
  assert.equal(row.refundFundedFrom, "unapplied_payment");
  assert.equal(row.reason, "payment_not_applied");
  assert.equal(row.userId, client.uid);
  assert.equal(row.agentId, undefined, "never in the agent's balance");
  assert.equal(row.refundOf, undefined, "no fee Transaction to refund");
  return row;
}

// ============================================
// Late payment after a reschedule
// ============================================

describe("late payment after a reschedule (paid_for_rescheduled_slot)", () => {
  test("a post-lock reschedule retires the open checkout in the same write", async () => {
    const reference = await seedPending();
    pastTheLock();
    const out = await reschedule();
    assert.equal(out.status, 200, JSON.stringify(out.body));
    const b = bookingOf("c1")!;
    assert.equal(b.status, "pending_payment");
    assert.equal(b.transactionId, undefined, "no current checkout");
    assert.equal(b.checkoutUrl, undefined, "no checkout page for the old slot");
    assert.equal(b.supersededCheckouts.length, 1);
    assert.equal(b.supersededCheckouts[0].reference, reference);
    assert.equal(b.supersededCheckouts[0].retiredBy, "reschedule");
    // The retired entry keeps that checkout's own price, to judge a late payment against.
    assert.equal(b.supersededCheckouts[0].chargedAmountMinor, FEE_NGN.amountMinor);
    assert.equal(b.scheduledTime, "11:00");
  });

  // ---- Issue #413 (C): the copy says "we're refunding ... on its way" ----
  // (decision 2026-11-21), with a guest variant (coordinator 2026-11-21): a
  // public-page guest is emailed a pay link (#391) instead of "pay again".
  const COPY_VARIANTS: Array<[string, Record<string, unknown>, string]> = [
    ["an app client", { bookedVia: "client" }, RESCHEDULED_COPY],
    // Review round 1 of #391: this guest's agency has no public page (no
    // slug), so no pay link can be emailed: neither the 409 nor the notice
    // may claim one (the emailed-link variant is covered in consultation-pay-link.test.ts).
    [
      "a guest (public page) whose link could not be emailed",
      { bookedVia: "public_page" },
      "Your consultation moved, so we're refunding your payment in full. Your refund is on its way.",
    ],
  ];
  for (const [who, over, copy] of COPY_VARIANTS) {
    test(`#413 copy for ${who}: the verify 409 message and the refund notice say the same, in the new words`, async () => {
      const reference = await seedPending("c1", FEE_NGN, over);
      pastTheLock();
      assert.equal((await reschedule()).status, 200);
      paystackPaid(reference, "c1", FEE_NGN);
      const out = await verify(reference);
      assert.equal(out.status, 409, JSON.stringify(out.body));
      assert.equal(out.body.error, "CONSULTATION_RESCHEDULED");
      assert.equal(out.body.message, copy);
      const toClient = notified.filter((n) => n.userId === client.uid).map((n) => n.body);
      assert.ok(toClient.includes(copy), JSON.stringify(toClient));
      // Never the old past-tense promise.
      assert.ok(!JSON.stringify([out.body, toClient]).includes("we've refunded"));
    });
  }

  test("an exact payment on the retired checkout is refunded in full, never confirms; the client pays again at today's price", async () => {
    const reference = await seedPending();
    pastTheLock();
    assert.equal((await reschedule()).status, 200);
    const agentBefore = await balanceOf(agent);

    // The client completes the OLD checkout anyway.
    paystackPaid(reference, "c1", FEE_NGN);
    const out = await verify(reference);
    assert.equal(out.status, 409, JSON.stringify(out.body));
    assert.equal(out.body.error, "CONSULTATION_RESCHEDULED");
    assert.equal(out.body.message, RESCHEDULED_COPY);
    assert.equal(out.body.data.refundPending, true);

    // Not confirmed.
    const b = bookingOf("c1")!;
    assert.equal(b.status, "pending_payment");
    assert.equal(b.paymentStatus, "pending");
    assert.equal(b.refundId, undefined, "the booking's own refund fields are untouched");
    assert.equal(feeRows().length, 0, "no fee Transaction");

    // Recorded and refunded.
    const ex = exceptionOf(reference)!;
    assert.equal(ex.reason, "paid_for_rescheduled_slot");
    assert.equal(ex.amountMinor, FEE_NGN.amountMinor);
    assert.equal(ex.currency, "NGN");
    assert.equal(ex.refundId, refundDocId(reference));
    assert.equal(ex.status, "open", "on its way, not yet completed");
    const row = assertUnappliedRefund(reference, FEE_NGN);
    assert.equal(row.status, "processing", "Paystack accepted it");
    assert.deepEqual(harness.refundCalls.map((c) => [c.reference, c.amount]), [[reference, FEE_NGN]]);

    // The client is told; the agent is not (it was never their money).
    assert.ok(notified.some((n) => n.userId === client.uid && n.body === RESCHEDULED_COPY));
    assert.equal(notified.filter((n) => n.userId === agent.uid).length, 0);
    assert.deepEqual(await balanceOf(agent), agentBefore, "agent balance unchanged");

    // A fresh checkout, priced NOW (the rate moved).
    setRate("NGN", 1600);
    const chargesBefore = harness.charges.length;
    const fresh = await checkout();
    assert.equal(fresh.status, 200, JSON.stringify(fresh.body));
    assert.equal(fresh.body.data.requiresPayment, true);
    assert.notEqual(fresh.body.data.reference, reference, "a new reference");
    assert.equal(harness.charges.length, chargesBefore + 1, "one new Paystack checkout");
    const repriced = bookingOf("c1")!;
    assert.equal(repriced.fxRate, 1600, "priced at today's rate");
    assert.ok(repriced.chargedAmountMinor > FEE_NGN.amountMinor);
    assert.equal(harness.charges.at(-1)!.amount.amountMinor, repriced.chargedAmountMinor);
    assert.ok(repriced.quoteExpiresAt.toMillis() > harness.clock.now().getTime(), "a new lock");

    // Paying the new checkout confirms the booking at the new price.
    const newRef = fresh.body.data.reference;
    paystackPaid(newRef, "c1", { amountMinor: repriced.chargedAmountMinor, currency: "NGN" });
    const paid = await verify(newRef);
    assert.equal(paid.status, 200, JSON.stringify(paid.body));
    assert.equal(bookingOf("c1")!.paymentStatus, "paid");
    assert.equal(feeRows().length, 1);
    assert.equal(feeRows()[0].amount, repriced.chargedAmountMinor);
    assert.equal(refundRows().length, 1, "the old refund only; nothing for the new payment");
  });

  test("older superseded checkouts (earlier re-prices, same old slot) are retired too", async () => {
    const older = {
      reference: "cons-c1-older", supersededAt: T0, priceUsdCents: 600, chargedCurrency: "NGN",
      chargedAmountMinor: 850_000, fxRate: 1416.67, fxRateAsOf: T0, fxRateSource: "cbn", fxMarginBps: 0,
      quoteLockedAt: T0, quoteExpiresAt: T0,
    };
    await seedPending("c1", FEE_NGN, { supersededCheckouts: [older] });
    pastTheLock();
    assert.equal((await reschedule()).status, 200);
    const b = bookingOf("c1")!;
    assert.deepEqual(b.supersededCheckouts.map((s: any) => [s.reference, s.retiredBy]), [
      ["cons-c1-older", "reschedule"],
      [refOf("c1"), "reschedule"],
    ]);
    // A late payment on the OLDER one does not settle the booking at its old price either.
    paystackPaid("cons-c1-older", "c1", { amountMinor: 850_000, currency: "NGN" });
    const out = await verify("cons-c1-older");
    assert.equal(out.body.error, "CONSULTATION_RESCHEDULED");
    assert.equal(bookingOf("c1")!.paymentStatus, "pending");
    assertUnappliedRefund("cons-c1-older", { amountMinor: 850_000, currency: "NGN" });
  });

  test("a checkout that never opened (no URL) is retired on reschedule as well", async () => {
    await seedPending("c1", FEE_NGN, { checkoutUrl: undefined });
    // Inside the lock, but nobody was ever shown a page: not in flight (#321).
    const out = await reschedule();
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.equal(bookingOf("c1")!.transactionId, undefined);
    assert.equal(bookingOf("c1")!.supersededCheckouts[0].retiredBy, "reschedule");
  });

  test("a payment in another currency is refunded in THAT currency and amount (never re-converted)", async () => {
    const ghs: Money = { amountMinor: 9_000, currency: "GHS" };
    const reference = await seedPending("c1", ghs);
    pastTheLock();
    await reschedule();
    paystackPaid(reference, "c1", ghs);
    await verify(reference);
    assertUnappliedRefund(reference, ghs);
    assert.deepEqual(harness.refundCalls.map((c) => c.amount), [ghs]);
  });

  test("a short payment on a retired checkout is a mismatch: nothing recorded, nothing refunded", async () => {
    const reference = await seedPending();
    pastTheLock();
    await reschedule();
    paystackPaid(reference, "c1", { amountMinor: FEE_NGN.amountMinor - 1, currency: "NGN" });
    const out = await verify(reference);
    assert.equal(out.status, 400);
    assert.equal(out.body.error, "PAYMENT_MISMATCH");
    assert.equal(docsIn("consultationPaymentExceptions").length, 0);
    assert.equal(refundRows().length, 0);
    assert.equal(harness.refundCalls.length, 0);
  });

  test("an abandoned retired checkout just opens a fresh one (nothing refunded)", async () => {
    const reference = await seedPending();
    pastTheLock();
    await reschedule();
    paystackAbandoned(reference, "c1");
    const out = await verify(reference);
    assert.equal(out.status, 409);
    assert.equal(out.body.error, "QUOTE_EXPIRED");
    assert.notEqual(out.body.data.reference, reference);
    assert.equal(refundRows().length, 0);
  });
});

describe("reschedule INSIDE the quote lock is unchanged", () => {
  test("409 PAYMENT_IN_PROGRESS, nothing written, and the checkout still confirms the booking", async () => {
    const reference = await seedPending();
    const before = bookingOf("c1")!;
    const out = await reschedule();
    assert.equal(out.status, 409);
    assert.equal(out.body.error, "PAYMENT_IN_PROGRESS");
    assert.deepEqual(bookingOf("c1"), before, "nothing written");

    paystackPaid(reference, "c1", FEE_NGN);
    const paid = await verify(reference);
    assert.equal(paid.status, 200, JSON.stringify(paid.body));
    assert.equal(bookingOf("c1")!.paymentStatus, "paid");
    assert.equal(feeRows().length, 1);
    assert.equal(refundRows().length, 0);
    assert.equal(docsIn("consultationPaymentExceptions").length, 0);
  });

  test("retireCheckoutsForReschedule leaves paid, non-pending and legacy bookings alone (pure)", () => {
    const at = harness.clock.now();
    const base: any = { status: "pending_payment", paymentStatus: "pending", transactionId: "r", priceUsdCents: 600, chargedCurrency: "NGN", chargedAmountMinor: 1, fxRate: 1, fxRateAsOf: T0, fxRateSource: "cbn", fxMarginBps: 0 };
    assert.ok(retireCheckoutsForReschedule(base, at));
    assert.equal(retireCheckoutsForReschedule({ ...base, paymentStatus: "paid", status: "scheduled" }, at), null);
    assert.equal(retireCheckoutsForReschedule({ ...base, status: "cancelled" }, at), null);
    assert.equal(retireCheckoutsForReschedule({ ...base, transactionId: undefined }, at), null, "nothing to retire");
    // Legacy naira row: no snapshot, never re-priced, so its checkout is kept.
    assert.equal(retireCheckoutsForReschedule({ status: "pending_payment", paymentStatus: "pending", transactionId: "r", fee: 9000 } as any, at), null);
  });
});

// ============================================
// Existing exceptions, now refunded automatically
// ============================================

describe("existing exceptions are refunded automatically", () => {
  test("paid after the booking was cancelled (booking_not_payable): full refund, booking stays cancelled, agent untouched", async () => {
    const reference = await seedPending();
    pastTheLock();
    assert.equal((await setStatus(agent, "cancelled")).status, 200);
    const agentBefore = await balanceOf(agent);
    paystackPaid(reference, "c1", FEE_NGN);
    const out = await verify(reference);
    assert.equal(out.status, 409);
    assert.equal(out.body.error, "BOOKING_NOT_PAYABLE");
    assert.equal(bookingOf("c1")!.status, "cancelled");
    assert.equal(bookingOf("c1")!.refundId, undefined);
    assert.equal(feeRows().length, 0);
    assert.equal(exceptionOf(reference)!.reason, "booking_not_payable");
    assert.equal(exceptionOf(reference)!.refundId, refundDocId(reference));
    assertUnappliedRefund(reference, FEE_NGN);
    assert.equal(harness.refundCalls.length, 1);
    assert.ok(notified.some((n) => n.userId === client.uid && n.type === "consultation_refunded"));
    assert.deepEqual(await balanceOf(agent), agentBefore);
  });

  test("a second charge on a paid booking (paid_on_superseded_reference_after_booking_paid): only the extra payment is refunded", async () => {
    // A booking re-priced once: an older checkout is in the superseded list.
    const older = {
      reference: "cons-c1-older", supersededAt: T0, priceUsdCents: 600, chargedCurrency: "NGN",
      chargedAmountMinor: 850_000, fxRate: 1416.67, fxRateAsOf: T0, fxRateSource: "cbn", fxMarginBps: 0,
      quoteLockedAt: T0, quoteExpiresAt: T0,
    };
    const reference = await seedPending("c1", FEE_NGN, { supersededCheckouts: [older] });
    paystackPaid(reference, "c1", FEE_NGN);
    assert.equal((await verify(reference)).status, 200);
    const fee = feeRows()[0];
    const agentBefore = await balanceOf(agent);

    // The client also completes the old checkout.
    paystackPaid("cons-c1-older", "c1", { amountMinor: 850_000, currency: "NGN" });
    const out = await verify("cons-c1-older");
    assert.equal(out.status, 200);
    assert.equal(out.body.data.refundPending, true);
    assert.equal(exceptionOf("cons-c1-older")!.reason, "paid_on_superseded_reference_after_booking_paid");
    assertUnappliedRefund("cons-c1-older", { amountMinor: 850_000, currency: "NGN" });
    assert.deepEqual(harness.refundCalls.map((c) => c.reference), ["cons-c1-older"], "never the booking's own payment");

    // The booking and its fee are untouched; the agent's balance too.
    const b = bookingOf("c1")!;
    assert.equal(b.paymentStatus, "paid");
    assert.equal(b.transactionId, reference);
    assert.equal(b.refundId, undefined);
    assert.equal(b.refundStatus, undefined);
    assert.deepEqual(feeRows(), [fee]);
    assert.deepEqual(await balanceOf(agent), agentBefore);
  });

  test("an exception recorded before #354 (no refund yet) is refunded on the next settle, once", async () => {
    const reference = await seedPending();
    pastTheLock();
    await setStatus(agent, "cancelled");
    await seed("consultationPaymentExceptions", reference, {
      consultationId: "c1", reference, amountMinor: FEE_NGN.amountMinor, currency: "NGN",
      paystackPaidAt: null, reason: "booking_not_payable", status: "open", createdAt: T0,
    });
    paystackPaid(reference, "c1", FEE_NGN);
    await verify(reference);
    await verify(reference);
    assertUnappliedRefund(reference, FEE_NGN);
    assert.equal(exceptionOf(reference)!.refundId, refundDocId(reference));
    assert.equal(exceptionOf(reference)!.reason, "booking_not_payable", "the stored reason is kept");
    assert.equal(harness.refundCalls.length, 1);
  });
});

// ============================================
// One refund ever per Paystack reference
// ============================================

describe("idempotency: one refund per reference", () => {
  /** A booking rescheduled after its lock, with its old checkout paid at Paystack. */
  async function paidRetired(): Promise<string> {
    const reference = await seedPending();
    pastTheLock();
    await reschedule();
    paystackPaid(reference, "c1", FEE_NGN);
    return reference;
  }

  test("a second verify creates nothing and calls Paystack refund no more", async () => {
    const reference = await paidRetired();
    await verify(reference);
    const second = await verify(reference);
    assert.equal(second.body.error, "CONSULTATION_RESCHEDULED");
    assert.equal(refundRows().length, 1);
    assert.equal(docsIn("consultationPaymentExceptions").length, 1);
    assert.equal(harness.refundCalls.length, 1);
    assert.equal(notified.filter((n) => n.body === RESCHEDULED_COPY).length, 1, "told once");
  });

  test("two settles at once on the same reference (verify + webhook stand-in): one exception, one refund, one Paystack call", async () => {
    const reference = await paidRetired();
    const report = harness.paystack.get(reference)!;
    const outcomes = await Promise.all([settlePayment("c1", reference, report), settlePayment("c1", reference, report)]);
    assert.deepEqual(outcomes.map((o) => o?.kind), ["rescheduled_refund_recorded", "rescheduled_refund_recorded"]);
    assertUnappliedRefund(reference, FEE_NGN);
    assert.equal(docsIn("consultationPaymentExceptions").length, 1);
    assert.equal(harness.refundCalls.length, 1);
    assert.equal(bookingOf("c1")!.paymentStatus, "pending");
  });

  test("verify racing a direct settle (the webhook path) also refunds once", async () => {
    const reference = await seedPending();
    pastTheLock();
    await setStatus(agent, "cancelled");
    paystackPaid(reference, "c1", FEE_NGN);
    const report = harness.paystack.get(reference)!;
    await Promise.all([verify(reference), settlePayment("c1", reference, report), verify(reference)]);
    assertUnappliedRefund(reference, FEE_NGN);
    assert.equal(harness.refundCalls.length, 1);
  });

  test("the refund row is created inside the settle transaction (create, never set)", async () => {
    const reference = await paidRetired();
    // A stray row already holding the id: the settle links it, never overwrites it.
    const id = refundDocId(reference);
    await seed("transactions", id, { type: "refund", status: "completed", amount: FEE_NGN.amountMinor, currency: "NGN", userId: client.uid, paymentExceptionId: reference, createdAt: T0, updatedAt: T0 });
    await verify(reference);
    const rows = refundRows();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, "completed", "untouched");
    assert.equal(exceptionOf(reference)!.refundId, id);
    assert.equal(harness.refundCalls.length, 0, "no second refund at Paystack");
  });
});

// ============================================
// The exception's status follows its refund
// ============================================

describe("exception status: open -> refunded / refund_failed", () => {
  test("Paystack refund.processed: the row completes and the exception is refunded; the booking's refund fields stay empty", async () => {
    const reference = await seedPending();
    pastTheLock();
    await reschedule();
    paystackPaid(reference, "c1", FEE_NGN);
    await verify(reference);
    const out = await webhook(refundEvent("refund.processed", reference));
    assert.equal(out.status, 200);
    assert.equal(refundRows()[0].status, "completed");
    assert.equal(exceptionOf(reference)!.status, "refunded");
    assert.equal(bookingOf("c1")!.refundStatus, undefined);
    assert.equal(bookingOf("c1")!.status, "pending_payment");
  });

  test("retries run out: refund_failed, listed for admins; an admin retry re-sends THAT row and the exception reopens", async () => {
    const reference = await seedPending();
    pastTheLock();
    await setStatus(agent, "cancelled");
    for (let i = 0; i < MAX_REFUND_ATTEMPTS; i++) harness.refundBehaviour.push("network");
    paystackPaid(reference, "c1", FEE_NGN);
    await verify(reference); // attempt 1, inside the settle
    assert.equal(refundRows()[0].status, "pending", "left for the retry job");
    for (let i = 1; i < MAX_REFUND_ATTEMPTS; i++) {
      harness.clock.advanceHours(0.25);
      await consultationRefundService.retryDueRefunds();
    }
    const [row] = refundRows();
    assert.equal(row.status, "failed");
    assert.equal(exceptionOf(reference)!.status, "refund_failed");
    assert.equal(bookingOf("c1")!.refundStatus, undefined, "never mirrored onto the booking");
    assert.ok(notified.some((n) => n.userId === client.uid && n.type === "consultation_refund_delayed"));

    // Listed for admins.
    const list = await listTransactions(admin, { role: "admin", type: "refund", status: "failed" });
    assert.equal(list.status, 200);
    assert.deepEqual((list.body.data as any[]).map((t) => t.id), [row.id]);

    // The booking-level refund has nothing to give (never paid): the admin names the row.
    assert.equal((await adminRefund(admin, { reason: "goodwill", feeBorneBy: "agent" })).body.error, "NOTHING_TO_REFUND");
    assert.equal((await adminRefund(agent, { refundId: row.id })).status, 403, "admins only");
    const retry = await adminRefund(admin, { refundId: row.id });
    assert.equal(retry.status, 200, JSON.stringify(retry.body));
    assert.equal(retry.body.data.retried, true);
    assert.equal(retry.body.data.refund.status, "processing");
    assert.equal(retry.body.data.refund.amount.amountMinor, FEE_NGN.amountMinor);
    assert.equal(refundRows().length, 1, "the same row, never a new one");
    assert.equal(exceptionOf(reference)!.status, "open");
    assert.ok(harness.refundLookups.includes(reference), "looked up at Paystack before any repeat call");
    assert.equal(harness.refundCalls.length, 1, "one accepted Paystack refund in all");

    // A second retry is refused: it is no longer failed.
    assert.equal((await adminRefund(admin, { refundId: row.id })).body.error, "ALREADY_REFUNDED");
    await webhook(refundEvent("refund.processed", reference));
    assert.equal(exceptionOf(reference)!.status, "refunded");
  });

  test("refund.failed from Paystack marks the exception refund_failed", async () => {
    const reference = await seedPending();
    pastTheLock();
    await setStatus(agent, "cancelled");
    paystackPaid(reference, "c1", FEE_NGN);
    await verify(reference);
    await webhook(refundEvent("refund.failed", reference));
    assert.equal(exceptionOf(reference)!.status, "refund_failed");
  });
});

// ============================================
// Money: never the agent's, never Seli's revenue
// ============================================

describe("these refunds never touch the agent's balance or revenue", () => {
  test("agent stats are identical before the payment, after the refund starts, and after it completes", async () => {
    // The agent has a real, paid booking too, so the balance is not trivially zero.
    await bookAndPay("paid1");
    const reference = await seedPending("c1");
    const before = await balanceOf(agent);
    pastTheLock();
    await setStatus(agent, "cancelled", "c1");
    paystackPaid(reference, "c1", FEE_NGN);
    await verify(reference);
    const afterStart = await balanceOf(agent);
    await webhook(refundEvent("refund.processed", reference));
    const afterDone = await balanceOf(agent);
    // Only the clock moved: compare the money.
    for (const s of [afterStart, afterDone]) {
      assert.equal(s.availableBalance, before.availableBalance);
      assert.equal(s.heldBalance, before.heldBalance);
      assert.equal(s.totalRevenue, before.totalRevenue);
      assert.equal(s.pendingPayments, before.pendingPayments);
    }
  });

  test("computeStats and revenueEffect ignore an unapplied-payment refund even when it is counted with everything", () => {
    const row = transactionService.buildUnappliedPaymentRefund("refund_x", T0, {
      exception: { id: "r", consultationId: "c1", reference: "r", amountMinor: 900_000, currency: "NGN" },
      clientUserId: client.uid,
      refundAmountMinor: 900_000,
    });
    const completed = { ...row, status: "completed" as const };
    assert.equal(revenueEffect(completed), 0);
    const stats = transactionService.computeStats([completed]);
    const ngn = stats.byCurrency.find((r) => r.currency === "NGN")!;
    assert.equal(ngn.availableBalance, 0);
    assert.equal(ngn.totalRevenue, 0);
  });
});

// ============================================
// Abuse: a payment that DID confirm a booking gets nothing extra
// ============================================

describe("a confirmed payment is never refunded through these paths", () => {
  test("re-verifying the payment that confirmed the booking writes nothing", async () => {
    await bookAndPay("c1");
    const out = await verify(refOf("c1"));
    assert.equal(out.status, 200);
    assert.equal(refundRows().length, 0);
    assert.equal(docsIn("consultationPaymentExceptions").length, 0);
    assert.equal(harness.refundCalls.length, 0);
  });

  test("a PAID booking that is rescheduled keeps its checkout; verifying it again refunds nothing", async () => {
    await bookAndPay("c1");
    assert.equal((await reschedule()).status, 200);
    const b = bookingOf("c1")!;
    assert.equal(b.transactionId, refOf("c1"), "a paid booking's reference is never retired");
    assert.equal(b.supersededCheckouts, undefined);
    await verify(refOf("c1"));
    assert.equal(refundRows().length, 0);
    assert.equal(harness.refundCalls.length, 0);
  });

  test("a confirmed payment settled concurrently with itself is confirmed once and never refunded", async () => {
    const reference = await seedPending();
    paystackPaid(reference, "c1", FEE_NGN);
    const report = harness.paystack.get(reference)!;
    const outcomes = await Promise.all([settlePayment("c1", reference, report), settlePayment("c1", reference, report)]);
    assert.deepEqual(outcomes.map((o) => o?.kind).sort(), ["already_paid", "confirmed"]);
    assert.equal(feeRows().length, 1);
    assert.equal(refundRows().length, 0);
  });

  // Issue #413 (portal design #357): `{ refundId }` now retries ANY failed
  // refund of the booking, its own fee refund included (it used to 404);
  // another booking's refund is still 404.
  test("an admin retry naming this booking's fee refund retries it; another booking's refund is 404", async () => {
    // Booking c2: a real fee refund (failed), and an exception refund (failed).
    await bookAndPay("c2");
    for (let i = 0; i < MAX_REFUND_ATTEMPTS; i++) harness.refundBehaviour.push("network");
    await setStatus(agent, "cancelled", "c2");
    for (let i = 1; i < MAX_REFUND_ATTEMPTS; i++) {
      harness.clock.advanceHours(0.25);
      await consultationRefundService.retryDueRefunds();
    }
    const feeRefund = refundRows()[0];
    assert.equal(feeRefund.status, "failed");
    // Naming the booking's own FEE refund: retried as stored, the same row.
    const asOwn = await adminRefund(admin, { refundId: feeRefund.id }, "c2");
    assert.equal(asOwn.status, 200, JSON.stringify(asOwn.body));
    assert.equal(asOwn.body.data.retried, true);
    assert.equal(asOwn.body.data.refundId, feeRefund.id);
    // Naming it under ANOTHER booking: not that booking's refund.
    assert.equal((await adminRefund(admin, { refundId: feeRefund.id }, "c1")).status, 404);
    // Booking c3's exception refund, named under booking c2: not this booking's.
    const reference = await seedPending("c3");
    harness.clock.advanceHours(1);
    await setStatus(agent, "cancelled", "c3");
    for (let i = 0; i < MAX_REFUND_ATTEMPTS; i++) harness.refundBehaviour.push("network");
    paystackPaid(reference, "c3", FEE_NGN);
    await verify(reference);
    const exRefund = refundRows().find((r) => r.paymentExceptionId === reference)!;
    const crossed = await adminRefund(admin, { refundId: exRefund.id }, "c2");
    assert.equal(crossed.status, 404);
    // A malformed id is 400 before anything is read.
    assert.equal((await adminRefund(admin, { refundId: "../x" }, "c2")).status, 400);
    assert.equal(refundRows().length, 2, "nothing new");
  });
});
