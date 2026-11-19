// ============================================
// Unit tests: who carries Paystack's fee on refunds of unapplied payments
// (issue #354, decision 2026-11-16)
// ============================================
//
// Hermetic (test/consultations/harness.ts): in-memory Firestore, every
// Paystack call stubbed (lookups and refunds are recorders; no real money
// moves), a fixed clock the tests move. Paystack's fee is the `fees` field
// of the stubbed lookup (`paystackPaid(..., { fees })`).
//
// The rule under test (Seli never carries any part of Paystack's fee):
//  - client-caused (`booking_not_payable`, `paid_on_superseded_...`): the
//    refund is the charge minus Paystack's fee; the agent's balance does not
//    move; the client is told both figures;
//  - agent-caused (`paid_for_rescheduled_slot`): the refund is the whole
//    charge, and the booking's agent is debited Paystack's fee as a
//    `paystack_fee_debit` row (one per reference, same transaction, under the
//    withdrawal lock), which may take the balance below zero;
//  - a fee Paystack did not report well-formed: nothing is guessed, the
//    refund is HELD for an admin (no refund row, no Paystack call, no debit),
//    and an admin retry re-reads the reference first;
//  - a client-caused fee >= the charge: held (`fee_not_less_than_amount`);
//  - a negative balance in ANY currency blocks every withdrawal.

import { test, describe, before, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { Timestamp } from "firebase-admin/firestore";

import { useHarness, harness, docsIn, seed, paystackPaid, captureRes, T0 } from "./harness";
import {
  admin, adminRefund, agent, balanceOf, bookingOf, client, edit, FEE_NGN, listTransactions, ownerA,
  refOf, refundRows, reqFor, seedEarned, setStatus, SLOT_DAY, SLOT_TIME, SLOT_ZONE, withdraw,
} from "./refund-fixtures";
import { notificationService } from "../../src/services/notification.service";
import { consultationController } from "../../src/controllers/consultation.controller";
import { planUnappliedRefund, settlePayment } from "../../src/services/consultation-charge.service";
import { refundDocId } from "../../src/services/consultation-refund.service";
import { feeDebitDocId } from "../../src/money/refund-id";
import { toTransactionLookup } from "../../src/services/billing/paystack.provider";
import { transactionService } from "../../src/services/transaction.service";
import { revenueEffect } from "../../src/money/totals";
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

/** GET /consultations/payment-exceptions as `p`. */
async function listExceptions(p = admin) {
  const { out, res } = captureRes();
  await consultationController.listPaymentExceptions(reqFor(p), res);
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

/** A booking rescheduled by its agent after the lock, then paid on the old checkout with `fees`. */
async function paidAfterReschedule(charge: Money = FEE_NGN, extra: Record<string, unknown> = { fees: FEE_KOBO }): Promise<string> {
  const reference = await seedPending("c1", charge);
  harness.clock.advanceHours(1);
  const moved = await edit(agent, { scheduledDate: "2026-11-27", scheduledTime: "11:00" });
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  paystackPaid(reference, "c1", charge, harness.clock.now(), extra as any);
  return reference;
}

/** A booking cancelled by its agent, then paid on its checkout with `fees` (client-caused). */
async function paidAfterCancel(charge: Money = FEE_NGN, extra: Record<string, unknown> = { fees: FEE_KOBO }): Promise<string> {
  const reference = await seedPending("c1", charge);
  harness.clock.advanceHours(1);
  assert.equal((await setStatus(agent, "cancelled")).status, 200);
  paystackPaid(reference, "c1", charge, harness.clock.now(), extra as any);
  return reference;
}

/** Assert nothing went out: no refund row, no debit, no Paystack refund call. */
function assertNothingRefunded(): void {
  assert.equal(refundRows().length, 0, "no refund row");
  assert.equal(debitRows().length, 0, "no agent debit");
  assert.equal(harness.refundCalls.length, 0, "no Paystack refund call");
}

// ============================================
// The pure rule
// ============================================

describe("planUnappliedRefund (pure)", () => {
  test("client-caused: charge minus fee, fee kept, no debit; agent-caused: full, fee debited", () => {
    for (const reason of ["booking_not_payable", "paid_on_superseded_reference_after_booking_paid"] as const) {
      assert.deepEqual(planUnappliedRefund({ amountMinor: 900_000, reason }, FEE_KOBO), {
        kind: "refund", feeMinor: FEE_KOBO, refundAmountMinor: 885_000, feeKeptMinor: FEE_KOBO, debitMinor: 0,
      });
    }
    assert.deepEqual(planUnappliedRefund({ amountMinor: 900_000, reason: "paid_for_rescheduled_slot" }, FEE_KOBO), {
      kind: "refund", feeMinor: FEE_KOBO, refundAmountMinor: 900_000, debitMinor: FEE_KOBO,
    });
  });

  test("unknown fee holds every reason; fee >= charge holds a client-caused one only", () => {
    for (const fee of [undefined, null, -1, "150", 1.5, NaN, Infinity]) {
      for (const reason of ["booking_not_payable", "paid_for_rescheduled_slot"] as const) {
        assert.deepEqual(planUnappliedRefund({ amountMinor: 900_000, reason }, fee), { kind: "hold", reason: "paystack_fee_unknown" });
      }
    }
    assert.deepEqual(planUnappliedRefund({ amountMinor: 900_000, reason: "booking_not_payable" }, 900_000), {
      kind: "hold", reason: "fee_not_less_than_amount", feeMinor: 900_000,
    });
    // The agent caused it: still refunded in full, the agent pays the fee.
    assert.equal(planUnappliedRefund({ amountMinor: 900_000, reason: "paid_for_rescheduled_slot" }, 900_000).kind, "refund");
  });

  test("toTransactionLookup carries fees only when it is a safe integer >= 0", () => {
    assert.equal(toTransactionLookup({ status: "success", fees: 15_000 }).fees, 15_000);
    assert.equal(toTransactionLookup({ status: "success", fees: 0 }).fees, 0);
    for (const bad of [undefined, null, -1, "15000", 150.5, NaN]) {
      assert.equal("fees" in toTransactionLookup({ status: "success", fees: bad }), false, `fees ${String(bad)} is unknown`);
    }
  });
});

// ============================================
// Client-caused: the fee comes out of the refund
// ============================================

describe("client-caused refunds keep Paystack's fee", () => {
  test("paid after a cancel: refund = charge - fee, Paystack called with exactly that, agent untouched, both figures told", async () => {
    const reference = await paidAfterCancel();
    const agentBefore = await balanceOf(agent);
    const out = await verify(reference);
    assert.equal(out.body.error, "BOOKING_NOT_PAYABLE");

    const [row] = refundRows();
    assert.equal(row.id, refundDocId(reference));
    assert.equal(row.amount, 885_000);
    assert.equal(row.currency, "NGN");
    assert.equal(row.paystackFeeKeptMinor, FEE_KOBO);
    assert.equal(row.amount + row.paystackFeeKeptMinor, FEE_NGN.amountMinor, "refunded + kept = charged");
    assert.equal(row.agentId, undefined);
    assert.equal(row.refundFundedFrom, "unapplied_payment");
    assert.deepEqual(harness.refundCalls.map((c) => [c.reference, c.amount]), [[reference, { amountMinor: 885_000, currency: "NGN" }]]);
    assert.equal(exceptionOf(reference)!.paystackFeeMinor, FEE_KOBO);
    assert.equal(exceptionOf(reference)!.status, "open");
    assert.equal(debitRows().length, 0);
    assert.deepEqual(await balanceOf(agent), agentBefore);
    assert.ok(
      notified.some(
        (n) =>
          n.userId === client.uid &&
          n.body ===
            "This consultation was no longer awaiting payment, so we've refunded NGN 8,850.00. " +
              "The payment provider kept a processing fee of NGN 150.00."
      ),
      JSON.stringify(notified)
    );
    assert.equal(notified.filter((n) => n.userId === agent.uid).length, 0, "the agent is not told: nothing of theirs moved");
  });

  test("paid twice: only the extra payment, minus its fee, comes back", async () => {
    const older = {
      reference: "cons-c1-older", supersededAt: T0, priceUsdCents: 600, chargedCurrency: "NGN",
      chargedAmountMinor: 850_000, fxRate: 1416.67, fxRateAsOf: T0, fxRateSource: "cbn", fxMarginBps: 0,
      quoteLockedAt: T0, quoteExpiresAt: T0,
    };
    const reference = await seedPending("c1", FEE_NGN, { supersededCheckouts: [older] });
    paystackPaid(reference, "c1", FEE_NGN);
    assert.equal((await verify(reference)).status, 200);
    const agentBefore = await balanceOf(agent);

    paystackPaid("cons-c1-older", "c1", { amountMinor: 850_000, currency: "NGN" }, harness.clock.now(), { fees: 12_750 });
    const out = await verify("cons-c1-older");
    assert.equal(out.status, 200);
    const [row] = refundRows();
    assert.equal(row.amount, 837_250);
    assert.equal(row.paystackFeeKeptMinor, 12_750);
    assert.deepEqual(harness.refundCalls.map((c) => c.amount), [{ amountMinor: 837_250, currency: "NGN" }]);
    assert.deepEqual(await balanceOf(agent), agentBefore);
    assert.ok(
      notified.some(
        (n) =>
          n.body ===
          "This consultation was already paid for, so we've refunded your extra payment of NGN 8,372.50. " +
            "The payment provider kept a processing fee of NGN 127.50."
      ),
      JSON.stringify(notified)
    );
  });

  test("fee >= the charge: nothing to refund, no Paystack call, held as fee_not_less_than_amount and listed", async () => {
    const reference = await paidAfterCancel(FEE_NGN, { fees: FEE_NGN.amountMinor });
    await verify(reference);
    assertNothingRefunded();
    const ex = exceptionOf(reference)!;
    assert.equal(ex.status, "refund_failed");
    assert.equal(ex.refundFailureReason, "fee_not_less_than_amount");
    assert.equal(ex.paystackFeeMinor, FEE_NGN.amountMinor);
    const listed = await listExceptions();
    assert.deepEqual(listed.body.data.map((e: any) => e.retryRefundId), [refundDocId(reference)]);
    // An admin retry keeps it held and writes no refund.
    const retry = await adminRefund(admin, { refundId: refundDocId(reference) });
    assert.equal(retry.status, 409);
    assert.equal(retry.body.error, "FEE_NOT_LESS_THAN_AMOUNT");
    assertNothingRefunded();
  });
});

// ============================================
// Agent-caused: full refund, the fee is debited from the agent
// ============================================

describe("agent-caused refunds debit the agent Paystack's fee", () => {
  test("rescheduled then paid: full refund, one fee debit, balance and revenue down by the fee, held untouched", async () => {
    await seedEarned("earned1", 5_000);
    await seed("agents", "agent-doc-1", { userId: agent.uid, agencyId: "agency-a" });
    const before = await balanceOf(agent);
    const reference = await paidAfterReschedule();
    const out = await verify(reference);
    assert.equal(out.status, 409);
    assert.equal(out.body.error, "CONSULTATION_RESCHEDULED");
    assert.equal(out.body.message, "Your consultation moved, so we've refunded your payment in full. Please pay again for the new time.");

    // The client: everything back.
    const [row] = refundRows();
    assert.equal(row.amount, FEE_NGN.amountMinor);
    assert.equal(row.paystackFeeKeptMinor, undefined);
    assert.deepEqual(harness.refundCalls.map((c) => c.amount), [FEE_NGN]);

    // The agent: one debit of exactly Paystack's fee.
    const debits = debitRows();
    assert.equal(debits.length, 1);
    const d = debits[0];
    assert.equal(d.id, feeDebitDocId(reference));
    assert.equal(d.agentId, agent.uid);
    assert.equal(d.userId, agent.uid);
    assert.equal(d.consultationId, "c1");
    assert.equal(d.amount, FEE_KOBO);
    assert.equal(d.currency, "NGN");
    assert.equal(d.paymentExceptionId, reference);
    assert.equal(d.status, "completed");
    assert.equal(d.description, "Payment processing fee on a refunded payment (consultation rescheduled)");
    const ex = exceptionOf(reference)!;
    assert.equal(ex.feeDebitId, d.id);
    assert.equal(ex.paystackFeeMinor, FEE_KOBO);
    // The #287 lock was written in the same commit.
    const lock = docsIn("withdrawalLocks").find(([id]) => id === agent.uid)?.[1];
    assert.equal(lock?.lastFeeDebitId, d.id);

    const after = await balanceOf(agent);
    assert.equal(after.availableBalance, before.availableBalance - FEE_KOBO);
    assert.equal(after.totalRevenue, before.totalRevenue - FEE_KOBO);
    assert.equal(after.heldBalance, before.heldBalance);
    assert.equal(revenueEffect(d as any), -FEE_KOBO, "analytics agree with stats");

    // Notices.
    assert.ok(notified.some((n) => n.userId === client.uid && n.body.includes("refunded your payment in full")));
    assert.ok(
      notified.some(
        (n) =>
          n.userId === agent.uid &&
          n.body ===
            "A client paid the old checkout after you moved their consultation, so we refunded them in full. " +
              "The NGN 150.00 payment processing fee was taken from your balance."
      ),
      JSON.stringify(notified)
    );

    // Visible to the agent and the owner, never to the client.
    const agentList = await listTransactions(agent);
    assert.ok(agentList.body.data.some((t: any) => t.id === d.id));
    const ownerList = await listTransactions(ownerA, { role: "owner" });
    assert.ok(ownerList.body.data.some((t: any) => t.id === d.id), JSON.stringify(ownerList.body));
    const clientList = await listTransactions(client);
    assert.equal(clientList.body.data.some((t: any) => t.type === "paystack_fee_debit" || t.id === d.id), false);
  });

  test("an owner's reschedule debits the booking's agent (not the owner)", async () => {
    const reference = await seedPending("c1");
    harness.clock.advanceHours(1);
    await seed("agents", "agent-doc-1", { userId: agent.uid, agencyId: "agency-a" });
    const moved = await edit(ownerA, { scheduledDate: "2026-11-27", scheduledTime: "11:00" });
    assert.equal(moved.status, 200, JSON.stringify(moved.body));
    paystackPaid(reference, "c1", FEE_NGN, harness.clock.now(), { fees: FEE_KOBO });
    await verify(reference);
    assert.deepEqual(debitRows().map((d) => d.agentId), [agent.uid]);
  });

  test("a GHS charge: refund and debit both in GHS minor units, nothing converted", async () => {
    const ghs: Money = { amountMinor: 7_345, currency: "GHS" };
    const reference = await paidAfterReschedule(ghs, { fees: 145 });
    await verify(reference);
    const [row] = refundRows();
    assert.deepEqual([row.amount, row.currency], [7_345, "GHS"]);
    assert.deepEqual(harness.refundCalls.map((c) => c.amount), [ghs]);
    const [d] = debitRows();
    assert.deepEqual([d.amount, d.currency], [145, "GHS"]);
    const ghsStats = await balanceOf(agent, "GHS");
    assert.equal(ghsStats.availableBalance, -145, "below zero in GHS");
    assert.equal(ghsStats.totalRevenue, -145);
    assert.equal(ghsStats.heldBalance, 0);
  });

  test("the debit can take the balance below zero, and a negative balance in ANY currency blocks an NGN withdrawal", async () => {
    // Plenty of naira to withdraw...
    await seedEarned("earned-ngn", 5_000_000, "NGN");
    assert.equal((await withdraw(1_000)).status, 201);
    // ...then a GHS fee debit with no GHS earnings.
    const reference = await paidAfterReschedule({ amountMinor: 7_345, currency: "GHS" }, { fees: 145 });
    await verify(reference);
    assert.equal((await balanceOf(agent, "GHS")).availableBalance, -145);
    const blocked = await withdraw(1_000);
    assert.equal(blocked.status, 400);
    assert.match(blocked.body.message ?? blocked.body.error?.message ?? JSON.stringify(blocked.body), /GHS balance is below zero/);
    assert.equal(docsIn("transactions").filter(([, t]) => t.type === "withdrawal").length, 1, "no second withdrawal");
  });

  test("an NGN debit beyond the balance makes availableBalance negative", async () => {
    await seedEarned("earned-small", 5_000, "NGN");
    const reference = await paidAfterReschedule();
    await verify(reference);
    assert.equal((await balanceOf(agent)).availableBalance, 5_000 - FEE_KOBO);
  });

  test("a fee of 0: full refund and no debit row", async () => {
    const reference = await paidAfterReschedule(FEE_NGN, { fees: 0 });
    await verify(reference);
    assert.equal(refundRows()[0].amount, FEE_NGN.amountMinor);
    assert.equal(debitRows().length, 0);
  });
});

// ============================================
// Fee unknown: held, never guessed
// ============================================

describe("fee unknown: the refund is held for an admin", () => {
  for (const [label, extra] of [
    ["missing", { fees: undefined }],
    ["null", { fees: null }],
    ["negative", { fees: -1 }],
    ["a string", { fees: "15000" }],
    ["a fraction", { fees: 150.5 }],
  ] as const) {
    test(`fee ${label}: no refund call, no debit, exception refund_failed / paystack_fee_unknown`, async () => {
      const reference = await paidAfterReschedule(FEE_NGN, extra as any);
      const out = await verify(reference);
      assert.equal(out.body.error, "CONSULTATION_RESCHEDULED", "the booking is still not confirmed");
      assert.equal(bookingOf("c1")!.status, "pending_payment");
      assertNothingRefunded();
      const ex = exceptionOf(reference)!;
      assert.equal(ex.status, "refund_failed");
      assert.equal(ex.refundFailureReason, "paystack_fee_unknown");
      assert.equal(ex.refundId, undefined);
      assert.equal(ex.paystackFeeMinor, undefined);
    });
  }

  test("listed for admins (agents get 403); retry while still unknown is 409 PAYSTACK_FEE_UNKNOWN and writes nothing; once known it proceeds once", async () => {
    const reference = await paidAfterReschedule(FEE_NGN, { fees: undefined });
    await verify(reference);
    const listed = await listExceptions();
    assert.equal(listed.status, 200);
    assert.equal(listed.body.data.length, 1);
    assert.equal(listed.body.data[0].refundFailureReason, "paystack_fee_unknown");
    const refundId = listed.body.data[0].retryRefundId;
    assert.equal(refundId, refundDocId(reference));
    assert.equal((await listExceptions(agent)).status, 403);

    // Still unknown at Paystack.
    const before = JSON.stringify(docsIn("consultationPaymentExceptions"));
    const lookupsBefore = harness.paystack.get(reference);
    const stillUnknown = await adminRefund(admin, { refundId });
    assert.equal(stillUnknown.status, 409);
    assert.equal(stillUnknown.body.error, "PAYSTACK_FEE_UNKNOWN");
    assert.equal(JSON.stringify(docsIn("consultationPaymentExceptions")), before, "nothing written");
    assert.equal(harness.paystack.get(reference), lookupsBefore);
    assertNothingRefunded();

    // Paystack now reports the fee.
    paystackPaid(reference, "c1", FEE_NGN, harness.clock.now(), { fees: FEE_KOBO });
    const retried = await adminRefund(admin, { refundId });
    assert.equal(retried.status, 200, JSON.stringify(retried.body));
    assert.equal(retried.body.data.retried, true);
    assert.equal(refundRows().length, 1);
    assert.equal(refundRows()[0].amount, FEE_NGN.amountMinor);
    assert.equal(debitRows().length, 1);
    assert.equal(debitRows()[0].amount, FEE_KOBO);
    assert.equal(harness.refundCalls.length, 1);
    const ex = exceptionOf(reference)!;
    assert.equal(ex.status, "open");
    assert.equal(ex.refundFailureReason, undefined, "the hold is cleared");
    assert.equal(ex.refundId, refundId);
    assert.ok(notified.some((n) => n.userId === agent.uid && n.body.includes("NGN 150.00")));

    // Again: the row exists and is not failed.
    const again = await adminRefund(admin, { refundId });
    assert.equal(again.status, 409);
    assert.equal(again.body.error, "ALREADY_REFUNDED");
    assert.equal(refundRows().length, 1);
    assert.equal(debitRows().length, 1);
    assert.equal(harness.refundCalls.length, 1);
  });

  test("a held client-caused refund retried once the fee is known: charge minus fee, no debit", async () => {
    const reference = await paidAfterCancel(FEE_NGN, { fees: null });
    await verify(reference);
    assertNothingRefunded();
    paystackPaid(reference, "c1", FEE_NGN, harness.clock.now(), { fees: FEE_KOBO });
    const retried = await adminRefund(admin, { refundId: refundDocId(reference) });
    assert.equal(retried.status, 200, JSON.stringify(retried.body));
    assert.equal(refundRows()[0].amount, 885_000);
    assert.equal(debitRows().length, 0);
    assert.deepEqual(harness.refundCalls.map((c) => c.amount), [{ amountMinor: 885_000, currency: "NGN" }]);
  });

  test("a retry naming a held refund of ANOTHER booking is 404", async () => {
    const reference = await paidAfterReschedule(FEE_NGN, { fees: undefined });
    await verify(reference);
    paystackPaid(reference, "c1", FEE_NGN, harness.clock.now(), { fees: FEE_KOBO });
    const crossed = await adminRefund(admin, { refundId: refundDocId(reference) }, "c-other");
    assert.equal(crossed.status, 404);
    assertNothingRefunded();
  });

  test("a later settle that sees a well-formed fee starts the held refund, once", async () => {
    const reference = await paidAfterReschedule(FEE_NGN, { fees: undefined });
    await verify(reference);
    assertNothingRefunded();
    paystackPaid(reference, "c1", FEE_NGN, harness.clock.now(), { fees: FEE_KOBO });
    await verify(reference);
    await verify(reference);
    assert.equal(refundRows().length, 1);
    assert.equal(debitRows().length, 1);
    assert.equal(harness.refundCalls.length, 1);
  });
});

// ============================================
// Concurrency and pre-#354 exceptions
// ============================================

describe("one refund and at most one debit per reference", () => {
  test("two settles at once (verify + webhook stand-in) on a rescheduled payment: one exception, one refund, one debit", async () => {
    const reference = await paidAfterReschedule();
    const report = harness.paystack.get(reference)!;
    await Promise.all([settlePayment("c1", reference, report), settlePayment("c1", reference, report), verify(reference)]);
    assert.equal(docsIn("consultationPaymentExceptions").length, 1);
    assert.equal(refundRows().length, 1);
    assert.equal(debitRows().length, 1);
    assert.equal(harness.refundCalls.length, 1);
    assert.equal(notified.filter((n) => n.userId === agent.uid).length, 1, "the agent is told once");
  });

  test("an exception recorded before #354 (no fee stored) settled again: one refund under the fee rule", async () => {
    const reference = await seedPending();
    harness.clock.advanceHours(1);
    await setStatus(agent, "cancelled");
    await seed("consultationPaymentExceptions", reference, {
      consultationId: "c1", reference, amountMinor: FEE_NGN.amountMinor, currency: "NGN",
      paystackPaidAt: null, reason: "booking_not_payable", status: "open", createdAt: T0,
    });
    paystackPaid(reference, "c1", FEE_NGN, harness.clock.now(), { fees: FEE_KOBO });
    await verify(reference);
    await verify(reference);
    assert.equal(refundRows().length, 1);
    assert.equal(refundRows()[0].amount, 885_000);
    assert.equal(exceptionOf(reference)!.paystackFeeMinor, FEE_KOBO);
    assert.equal(harness.refundCalls.length, 1);
  });

  test("a pre-#354 exception whose fee Paystack does not report is held, not guessed", async () => {
    const reference = await seedPending();
    harness.clock.advanceHours(1);
    await setStatus(agent, "cancelled");
    await seed("consultationPaymentExceptions", reference, {
      consultationId: "c1", reference, amountMinor: FEE_NGN.amountMinor, currency: "NGN",
      paystackPaidAt: null, reason: "booking_not_payable", status: "open", createdAt: T0,
    });
    paystackPaid(reference, "c1", FEE_NGN, harness.clock.now(), { fees: undefined });
    await verify(reference);
    assertNothingRefunded();
    assert.equal(exceptionOf(reference)!.refundFailureReason, "paystack_fee_unknown");
  });

  test("buildPaystackFeeDebit refuses a zero, negative or fractional fee", () => {
    for (const feeMinor of [0, -1, 1.5]) {
      assert.throws(() =>
        transactionService.buildPaystackFeeDebit("x", T0, {
          agentUserId: agent.uid, consultationId: "c1", reference: "r", feeMinor, currency: "NGN",
        })
      );
    }
  });
});
