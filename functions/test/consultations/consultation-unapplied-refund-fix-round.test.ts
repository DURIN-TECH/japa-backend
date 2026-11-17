// ============================================
// Unit tests: issue #354 fix round (code review 2026-11-17)
// ============================================
//
// Hermetic (test/consultations/harness.ts): in-memory Firestore, every
// Paystack call stubbed (lookups and refunds are recorders; no real money
// moves), a fixed clock the tests move.
//
// What is covered, by orchestrator decision for the fix round:
//  1. ORDER OF CHECKS (blocking): a payment on a checkout RETIRED by a
//     reschedule is ALWAYS `paid_for_rescheduled_slot` (agent-caused: full
//     refund, Paystack's fee debited from the agent), also when the booking
//     was paid since through a fresh checkout, or cancelled since. A stored
//     reason still wins on a re-settle;
//  2. RETIRE ONLY ON A REAL MOVE: a schedule field sent with the value it
//     already has does not retire the checkout; a changed date, time,
//     duration or zone does;
//  3. REASSIGNMENT: the fee is debited from the agent who MOVED the booking
//     (`retiredByAgentId` on the retired entry, fixed on the exception as
//     `causedByAgentId`), not from whoever holds it when the payment lands.
//     A checkout retired before that field existed falls back to the
//     booking's agent at settle time;
//  4. CLOSE AS nothing_to_refund: an admin closes a client-caused exception
//     whose Paystack fee is not less than the charge. No Paystack call, no
//     Transaction; it leaves the admin list; a repeat is a no-op; anyone but
//     an admin gets 403, no token 401.

import { test, describe, before, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { Timestamp } from "firebase-admin/firestore";
import { ROLES } from "@durin-tech/authz";
import type { AuthzSubject } from "@durin-tech/authz";

import { useHarness, harness, docsIn, seed, paystackPaid, captureRes, T0 } from "./harness";
import {
  admin, adminRefund, agent, bookingOf, client, edit, FEE_NGN, ownerA, refOf, refundRows, reqFor, setStatus,
  SLOT_DAY, SLOT_TIME, SLOT_ZONE,
} from "./refund-fixtures";
import { notificationService } from "../../src/services/notification.service";
import { consultationController } from "../../src/controllers/consultation.controller";
import { feeDebitAgentFor, settlePayment } from "../../src/services/consultation-charge.service";
import { refundDocId } from "../../src/services/consultation-refund.service";
import { slotChanges } from "../../src/services/consultation.service";
import { feeDebitDocId } from "../../src/money/refund-id";
import type { Money } from "../../src/types/money";

/* eslint-disable @typescript-eslint/no-explicit-any */

// ============================================
// Setup: record notifications, silence logs
// ============================================

/** Every notification sent during a test. */
const notified: Array<{ userId: string; type: string; body: string }> = [];
const realError = console.error;
const realWarn = console.warn;

before(async () => {
  await useHarness();
  (notificationService as any).notifyUser = async (n: { userId: string; type: string; body: string }) => {
    notified.push({ userId: n.userId, type: n.type, body: n.body });
  };
});
beforeEach(() => {
  harness.reset();
  notified.length = 0;
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  console.error = () => {};
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  console.warn = () => {};
});
afterEach(() => {
  console.error = realError;
  console.warn = realWarn;
});

// ============================================
// Helpers
// ============================================

/** Paystack's fee in these tests: ₦150.00 in kobo. */
const FEE_KOBO = 15_000;

/** A second agent of the same agency, who takes the case over after the move. */
const agent2: AuthzSubject = { uid: "uid-agent2", role: ROLES.AGENT, agencyId: "agency-a" };

/** The client's copy for an agent-caused refund while the booking still awaits payment. */
const RESCHEDULED_COPY = "Your consultation moved, so we've refunded your payment in full. Please pay again for the new time.";

/** Seed an UNPAID, priced booking `id` with an open checkout locked for 30 minutes. */
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

/** GET /consultations/payment-exceptions as `p`. */
async function listExceptions(p = admin) {
  const { out, res } = captureRes();
  await consultationController.listPaymentExceptions(reqFor(p), res);
  return out;
}

/** POST /consultations/:id/payment-exceptions/:exceptionId/close as `p`. */
async function closeException(p: AuthzSubject, exceptionId: string, id = "c1") {
  const { out, res } = captureRes();
  await consultationController.closePaymentException(reqFor(p, { params: { id, exceptionId } }), res);
  return out;
}

/** The stored exception of `reference`. */
function exceptionOf(reference: string): Record<string, any> | undefined {
  return docsIn("consultationPaymentExceptions").find(([id]) => id === reference)?.[1];
}

/** Every stored Paystack-fee debit. */
function debitRows(): Record<string, any>[] {
  return docsIn("transactions").map(([, d]) => d).filter((d) => d.type === "paystack_fee_debit");
}

/** Every stored consultation_fee Transaction. */
function feeRows(): Record<string, any>[] {
  return docsIn("transactions").map(([, d]) => d).filter((d) => d.type === "consultation_fee");
}

/** Move the clock past the 30-minute quote lock. */
function pastTheLock(): void {
  harness.clock.advanceHours(1);
}

/** Reschedule booking `id` as `p` to a NEW slot (a real move). */
async function reschedule(p: AuthzSubject = agent, id = "c1") {
  const out = await edit(p, { scheduledDate: "2026-11-27", scheduledTime: "11:00" }, id);
  assert.equal(out.status, 200, JSON.stringify(out.body));
  return out;
}

/** Hand booking `id` to another agent (a reassignment), keeping everything else. */
async function reassign(to: AuthzSubject, id = "c1"): Promise<void> {
  const b = bookingOf(id)!;
  await seed("consultations", id, { ...b, agentId: to.uid });
}

/** Assert the agent-caused money of `reference`: one full refund, one fee debit from `payer`. */
function assertAgentCaused(reference: string, payer: AuthzSubject, charged: Money = FEE_NGN): void {
  const ex = exceptionOf(reference)!;
  assert.equal(ex.reason, "paid_for_rescheduled_slot", "agent-caused");
  assert.equal(ex.causedByAgentId, payer.uid, "the agent who caused it is fixed on the exception");
  const rows = refundRows();
  assert.equal(rows.length, 1, "exactly one refund row");
  assert.equal(rows[0].id, refundDocId(reference));
  assert.equal(rows[0].amount, charged.amountMinor, "refunded in full");
  assert.equal(rows[0].currency, charged.currency);
  assert.equal(rows[0].paystackFeeKeptMinor, undefined, "nothing kept from the client");
  assert.deepEqual(harness.refundCalls.map((c) => [c.reference, c.amount]), [[reference, charged]]);
  const debits = debitRows();
  assert.equal(debits.length, 1, "exactly one fee debit");
  assert.equal(debits[0].id, feeDebitDocId(reference));
  assert.equal(debits[0].agentId, payer.uid, "debited from the agent who moved the booking");
  assert.equal(debits[0].amount, FEE_KOBO);
  assert.equal(debits[0].currency, charged.currency);
  assert.equal(ex.feeDebitId, debits[0].id);
  // The withdrawal lock (#287) of THAT agent was written in the same commit.
  const lock = docsIn("withdrawalLocks").find(([id]) => id === payer.uid)?.[1];
  assert.equal(lock?.lastFeeDebitId, debits[0].id);
}

// ============================================
// 1. Order of checks (blocking finding)
// ============================================

describe("a payment on a checkout retired by a reschedule is always agent-caused", () => {
  test("rescheduled, then the booking was PAID through a fresh checkout, then the old checkout's payment lands", async () => {
    const r1 = await seedPending();
    pastTheLock();
    await reschedule();

    // The client pays the FRESH checkout: the booking is confirmed.
    const fresh = await checkout();
    assert.equal(fresh.status, 200, JSON.stringify(fresh.body));
    const r2 = fresh.body.data.reference as string;
    const repriced = bookingOf("c1")!;
    paystackPaid(r2, "c1", { amountMinor: repriced.chargedAmountMinor, currency: "NGN" });
    assert.equal((await verify(r2)).status, 200);
    assert.equal(bookingOf("c1")!.paymentStatus, "paid");

    // Then R1 (the old slot's checkout) settles late.
    paystackPaid(r1, "c1", FEE_NGN, harness.clock.now(), { fees: FEE_KOBO });
    notified.length = 0;
    const out = await verify(r1);
    // The booking is paid: answered as before (an extra payment being refunded).
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.equal(out.body.data.refundPending, true);

    // ...but recorded as the AGENT's doing: full refund, fee debited.
    assertAgentCaused(r1, agent);
    assert.equal(feeRows().length, 1, "only R2's fee Transaction");
    // The client is not asked to pay again: the booking is already paid.
    assert.ok(
      notified.some((n) => n.userId === client.uid && n.body === "Your consultation moved, so we've refunded your payment in full."),
      JSON.stringify(notified)
    );
    assert.equal(notified.some((n) => n.body.includes("Please pay again")), false);
  });

  test("rescheduled, then the booking was CANCELLED, then the old checkout's payment lands", async () => {
    const r1 = await seedPending();
    pastTheLock();
    await reschedule();
    assert.equal((await setStatus(agent, "cancelled")).status, 200);

    paystackPaid(r1, "c1", FEE_NGN, harness.clock.now(), { fees: FEE_KOBO });
    const out = await verify(r1);
    // The booking is cancelled: answered as before.
    assert.equal(out.status, 409);
    assert.equal(out.body.error, "BOOKING_NOT_PAYABLE");

    // ...but the client is refunded IN FULL and the agent pays the fee.
    assertAgentCaused(r1, agent);
    assert.equal(bookingOf("c1")!.status, "cancelled");
    assert.equal(notified.some((n) => n.body.includes("Please pay again")), false);
  });

  test("still pending: unchanged (409 CONSULTATION_RESCHEDULED, the client is asked to pay again)", async () => {
    const r1 = await seedPending();
    pastTheLock();
    await reschedule();
    paystackPaid(r1, "c1", FEE_NGN, harness.clock.now(), { fees: FEE_KOBO });
    const out = await verify(r1);
    assert.equal(out.body.error, "CONSULTATION_RESCHEDULED");
    assertAgentCaused(r1, agent);
    assert.ok(notified.some((n) => n.userId === client.uid && n.body === RESCHEDULED_COPY));
  });

  test("a second settle after either order writes nothing more (one refund, one debit)", async () => {
    const r1 = await seedPending();
    pastTheLock();
    await reschedule();
    assert.equal((await setStatus(agent, "cancelled")).status, 200);
    paystackPaid(r1, "c1", FEE_NGN, harness.clock.now(), { fees: FEE_KOBO });
    await Promise.all([verify(r1), settlePayment("c1", r1, harness.paystack.get(r1) as any)]);
    await verify(r1);
    assertAgentCaused(r1, agent);
  });

  test("a STORED reason still wins on a re-settle (an exception recorded before the fix keeps its reason)", async () => {
    const r1 = await seedPending();
    pastTheLock();
    await reschedule();
    assert.equal((await setStatus(agent, "cancelled")).status, 200);
    // As the code before this fix recorded it: client-caused, held (no fee).
    await seed("consultationPaymentExceptions", r1, {
      consultationId: "c1", reference: r1, amountMinor: FEE_NGN.amountMinor, currency: "NGN",
      paystackPaidAt: null, reason: "booking_not_payable", status: "refund_failed",
      refundFailureReason: "paystack_fee_unknown", createdAt: T0,
    });
    paystackPaid(r1, "c1", FEE_NGN, harness.clock.now(), { fees: FEE_KOBO });
    await verify(r1);
    const ex = exceptionOf(r1)!;
    assert.equal(ex.reason, "booking_not_payable", "the stored reason is never rewritten");
    assert.equal(refundRows().length, 1);
    assert.equal(refundRows()[0].amount, FEE_NGN.amountMinor - FEE_KOBO, "planned under the stored reason");
    assert.equal(debitRows().length, 0);
  });
});

// ============================================
// 2. Retire only on a real move
// ============================================

describe("only a real move retires the checkout", () => {
  test("slotChanges (pure): same values are not a move; date, time, duration or zone changes are", () => {
    const b = { scheduledDate: SLOT_DAY, scheduledTime: "10:00", durationMinutes: 30, timezone: SLOT_ZONE } as any;
    assert.equal(slotChanges(b, { scheduledDate: Timestamp.fromMillis(SLOT_DAY.toMillis()), scheduledTime: "10:00" }), false);
    assert.equal(slotChanges(b, { durationMinutes: 30, timezone: SLOT_ZONE }), false);
    assert.equal(slotChanges(b, { meetingLink: "https://meet.test/x" }), false, "no schedule field at all");
    assert.equal(slotChanges(b, { scheduledDate: Timestamp.fromDate(new Date("2026-11-21T00:00:00Z")) }), true);
    assert.equal(slotChanges(b, { scheduledTime: "11:00" }), true);
    assert.equal(slotChanges(b, { durationMinutes: 45 }), true);
    assert.equal(slotChanges(b, { timezone: "Europe/London" }), true);
    // A stored date in its serialized form still compares by its instant.
    const serialized = { ...b, scheduledDate: { _seconds: SLOT_DAY.seconds, _nanoseconds: 0 } };
    assert.equal(slotChanges(serialized, { scheduledDate: SLOT_DAY }), false);
  });

  test("a post-lock edit naming the schedule with the SAME values keeps the checkout open, and its payment confirms", async () => {
    const reference = await seedPending();
    pastTheLock();
    const out = await edit(agent, {
      scheduledDate: "2026-11-20T00:00:00.000Z", scheduledTime: SLOT_TIME, durationMinutes: 30, timezone: SLOT_ZONE,
    });
    assert.equal(out.status, 200, JSON.stringify(out.body));
    const b = bookingOf("c1")!;
    assert.equal(b.transactionId, reference, "the checkout is not retired");
    assert.equal(b.supersededCheckouts, undefined);

    // The client pays it: confirmed, no refund, no debit.
    paystackPaid(reference, "c1", FEE_NGN, harness.clock.now(), { fees: FEE_KOBO });
    const paid = await verify(reference);
    assert.equal(paid.status, 200, JSON.stringify(paid.body));
    assert.equal(bookingOf("c1")!.paymentStatus, "paid");
    assert.equal(refundRows().length, 0);
    assert.equal(debitRows().length, 0);
  });

  test("a duration-only change and a zone-only change ARE moves: the checkout is retired", async () => {
    for (const body of [{ durationMinutes: 45 }, { timezone: "Europe/London" }]) {
      harness.reset();
      await seedPending();
      pastTheLock();
      const out = await edit(agent, body);
      assert.equal(out.status, 200, JSON.stringify(out.body));
      const b = bookingOf("c1")!;
      assert.equal(b.transactionId, undefined, `${JSON.stringify(body)} retires the checkout`);
      assert.equal(b.supersededCheckouts[0].retiredBy, "reschedule");
    }
  });
});

// ============================================
// 3. Reassignment: the agent who moved it pays
// ============================================

describe("the fee is debited from the agent who rescheduled, not the booking's agent when it lands", () => {
  test("the retired entry records the agent at the time of the move", async () => {
    await seedPending();
    pastTheLock();
    await reschedule(ownerA);
    // The owner made the edit; the booking's agent at the time is what is recorded
    // (the agent side's booking agent, as in #317's "agent side").
    assert.equal(bookingOf("c1")!.supersededCheckouts[0].retiredByAgentId, agent.uid);
  });

  test("moved by agent 1, reassigned to agent 2, then paid: agent 1 is debited", async () => {
    const r1 = await seedPending();
    pastTheLock();
    await reschedule();
    await reassign(agent2);
    paystackPaid(r1, "c1", FEE_NGN, harness.clock.now(), { fees: FEE_KOBO });
    await verify(r1);
    assertAgentCaused(r1, agent);
    assert.equal(docsIn("withdrawalLocks").some(([id]) => id === agent2.uid), false, "agent 2's lock untouched");
    assert.ok(notified.some((n) => n.userId === agent.uid && n.body.includes("payment processing fee")));
    assert.equal(notified.some((n) => n.userId === agent2.uid), false, "agent 2 is not told: nothing of theirs moved");
  });

  test("held (fee unknown), reassigned, then retried by an admin: still agent 1", async () => {
    const r1 = await seedPending();
    pastTheLock();
    await reschedule();
    paystackPaid(r1, "c1", FEE_NGN, harness.clock.now(), { fees: undefined });
    await verify(r1);
    assert.equal(exceptionOf(r1)!.refundFailureReason, "paystack_fee_unknown");
    assert.equal(exceptionOf(r1)!.causedByAgentId, agent.uid, "fixed when first planned, even held");

    await reassign(agent2);
    paystackPaid(r1, "c1", FEE_NGN, harness.clock.now(), { fees: FEE_KOBO });
    const retry = await adminRefund(admin, { refundId: refundDocId(r1) });
    assert.equal(retry.status, 200, JSON.stringify(retry.body));
    assertAgentCaused(r1, agent);
  });

  test("a checkout retired BEFORE retiredByAgentId existed falls back to the booking's agent at settle time", async () => {
    const r1 = refOf("c1");
    // A booking retired by the earlier #354 code: the entry has no retiredByAgentId.
    await seedPending("c1", FEE_NGN, {
      agentId: agent2.uid,
      transactionId: undefined,
      checkoutUrl: undefined,
      supersededCheckouts: [{
        reference: r1, supersededAt: T0, retiredBy: "reschedule", priceUsdCents: 600, chargedCurrency: "NGN",
        chargedAmountMinor: FEE_NGN.amountMinor, fxRate: 1500, fxRateAsOf: T0, fxRateSource: "cbn", fxMarginBps: 0,
        quoteLockedAt: T0, quoteExpiresAt: Timestamp.fromMillis(T0.toMillis() + 30 * 60_000),
      }],
    });
    pastTheLock();
    paystackPaid(r1, "c1", FEE_NGN, harness.clock.now(), { fees: FEE_KOBO });
    await verify(r1);
    assertAgentCaused(r1, agent2);
  });

  test("feeDebitAgentFor (pure): stored > retired entry > booking's agent", () => {
    const booking = { agentId: "now", supersededCheckouts: [{ reference: "r", retiredByAgentId: "mover" }] } as any;
    assert.equal(feeDebitAgentFor({ reference: "r", causedByAgentId: "stored" }, booking), "stored");
    assert.equal(feeDebitAgentFor({ reference: "r" }, booking), "mover");
    assert.equal(feeDebitAgentFor({ reference: "other" }, booking), "now");
    assert.equal(feeDebitAgentFor({ reference: "r" }, { agentId: "now" } as any), "now");
  });
});

// ============================================
// 4. Close a client-caused exception as nothing_to_refund
// ============================================

describe("an admin closes a fee >= charge exception as nothing_to_refund", () => {
  /** A client-caused exception held as fee_not_less_than_amount (paid after a cancel, fee = the charge). */
  async function heldNothingLeft(): Promise<string> {
    const reference = await seedPending();
    pastTheLock();
    assert.equal((await setStatus(agent, "cancelled")).status, 200);
    paystackPaid(reference, "c1", FEE_NGN, harness.clock.now(), { fees: FEE_NGN.amountMinor });
    await verify(reference);
    assert.equal(exceptionOf(reference)!.refundFailureReason, "fee_not_less_than_amount");
    return reference;
  }

  test("closed: no Paystack call, no Transaction, it leaves the admin list, and a repeat is a no-op", async () => {
    const reference = await heldNothingLeft();
    assert.equal((await listExceptions()).body.data.length, 1);
    const txBefore = docsIn("transactions").length;

    const out = await closeException(admin, reference);
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.equal(out.body.data.closed, true);
    assert.equal(out.body.data.alreadyClosed, false);
    const ex = exceptionOf(reference)!;
    assert.equal(ex.status, "nothing_to_refund");
    assert.equal(ex.closedBy, admin.uid);
    assert.ok(ex.closedAt);
    assert.equal(ex.paystackFeeMinor, FEE_NGN.amountMinor, "the Paystack-reported fee is kept as the record");
    assert.equal(docsIn("transactions").length, txBefore, "no Transaction of any kind");
    assert.equal(harness.refundCalls.length, 0, "no Paystack call");
    assert.deepEqual((await listExceptions()).body.data, [], "gone from the admin list");

    // A repeat: 200, nothing written.
    const snapshot = JSON.stringify(exceptionOf(reference));
    const again = await closeException(admin, reference);
    assert.equal(again.status, 200);
    assert.equal(again.body.data.alreadyClosed, true);
    assert.equal(JSON.stringify(exceptionOf(reference)), snapshot, "unchanged");

    // Final: a late verify of the same payment, and an admin retry, change nothing.
    await verify(reference);
    assert.equal(exceptionOf(reference)!.status, "nothing_to_refund");
    const retry = await adminRefund(admin, { refundId: refundDocId(reference) });
    assert.equal(retry.status, 409);
    assert.equal(retry.body.error, "EXCEPTION_CLOSED");
    assert.equal(refundRows().length, 0);
    assert.equal(harness.refundCalls.length, 0);
  });

  test("two admins closing at once: closed once, both answered 200", async () => {
    const reference = await heldNothingLeft();
    const [a, b] = await Promise.all([closeException(admin, reference), closeException(admin, reference)]);
    assert.deepEqual([a.status, b.status], [200, 200]);
    assert.deepEqual([a.body.data.alreadyClosed, b.body.data.alreadyClosed].sort(), [false, true]);
  });

  test("not an admin: 403 and nothing read or written (agent, owner, client)", async () => {
    const reference = await heldNothingLeft();
    const snapshot = JSON.stringify(exceptionOf(reference));
    for (const p of [agent, ownerA, client]) {
      const out = await closeException(p, reference);
      assert.equal(out.status, 403, `${p.role} is refused`);
      assert.equal(out.body.error, "FORBIDDEN");
    }
    assert.equal(JSON.stringify(exceptionOf(reference)), snapshot);
  });

  test("no token: 401 (the real router over HTTP)", async () => {
    const { consultationRoutes } = await import("../../src/routes/consultation.routes");
    const app = express();
    app.use(express.json());
    app.use("/consultations", consultationRoutes);
    const server: http.Server = app.listen(0, "127.0.0.1");
    try {
      await new Promise<void>((resolve) => server.once("listening", () => resolve()));
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const r = await fetch(`${base}/consultations/c1/payment-exceptions/${refOf("c1")}/close`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      assert.equal(r.status, 401);
    } finally {
      server.close();
    }
  });

  test("not closable: agent-caused, fee unknown, or a refund already on its way (409, nothing written)", async () => {
    // Agent-caused, held because the fee is unknown: the client is owed it all.
    const r1 = await seedPending();
    pastTheLock();
    await reschedule();
    paystackPaid(r1, "c1", FEE_NGN, harness.clock.now(), { fees: undefined });
    await verify(r1);
    let out = await closeException(admin, r1);
    assert.equal(out.status, 409);
    assert.equal(out.body.error, "NOT_CLOSABLE");
    assert.equal(exceptionOf(r1)!.status, "refund_failed");

    // Client-caused, fee unknown: not "nothing to refund" (the fee is not known).
    harness.reset();
    const r2 = await seedPending();
    pastTheLock();
    assert.equal((await setStatus(agent, "cancelled")).status, 200);
    paystackPaid(r2, "c1", FEE_NGN, harness.clock.now(), { fees: undefined });
    await verify(r2);
    out = await closeException(admin, r2);
    assert.equal(out.status, 409);
    assert.equal(exceptionOf(r2)!.status, "refund_failed");

    // Client-caused with a normal fee: refunded, so not closable.
    harness.reset();
    const r3 = await seedPending();
    pastTheLock();
    assert.equal((await setStatus(agent, "cancelled")).status, 200);
    paystackPaid(r3, "c1", FEE_NGN, harness.clock.now(), { fees: FEE_KOBO });
    await verify(r3);
    out = await closeException(admin, r3);
    assert.equal(out.status, 409);
    assert.equal(exceptionOf(r3)!.status, "open");
  });

  test("scoped to the booking: another booking's id is 404; a malformed id is 400", async () => {
    const reference = await heldNothingLeft();
    await seedPending("c2");
    const other = await closeException(admin, reference, "c2");
    assert.equal(other.status, 404);
    assert.equal(exceptionOf(reference)!.status, "refund_failed");
    assert.equal((await closeException(admin, "nope", "c1")).status, 404);
    assert.equal((await closeException(admin, "bad/id", "c1")).status, 400);
  });
});
