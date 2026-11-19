// ============================================
// Unit tests: whoever caused a cancel refund carries Paystack's fee
// (issue #390, with the #395 interaction: the agent is credited A - F)
// ============================================
//
// Hermetic (test/consultations/harness.ts): in-memory Firestore, every
// Paystack call stubbed (lookups and refunds are recorders; no real money
// moves), a fixed clock the tests move.
//
// The rule table under test, per Paystack reference (A charged, F Paystack's
// fee in the same currency), for refunds out of the HOLD and from the
// AVAILABLE balance:
//
//   what happened                         | client gets | agent's total | Seli's total
//   --------------------------------------|-------------|---------------|-------------
//   refunded, client caused               | A - F       | 0             | 0
//   refunded, agent caused                | A           | -F (once)     | 0
//
// plus: an older full-credit fee row (credited A) refunded on the client's
// fault gives back the full A (user decision 2026-11-17); F comes from the
// fee row first, else a fresh Paystack lookup; unknown F (or a client-caused
// F >= A) holds the refund for an admin with no Paystack call and no debit;
// one refund and at most one debit per reference, across #354 and #390.

import { test, describe, before, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { Timestamp } from "firebase-admin/firestore";

import { useHarness, harness, docsIn, seed, T0 } from "./harness";
import {
  admin, adminRefund, agent, balanceOf, bookAndPay, bookingOf, client, feeOf, getBooking, listTransactions,
  ownerA, refOf, refundRows, setStatus, withdraw, webhook, refundEvent, TEST_PAYSTACK_SECRET,
} from "./refund-fixtures";
import { notificationService } from "../../src/services/notification.service";
import {
  consultationRefundService, feeBorneByFor, feeForRefund, planCancellationRefund, refundDocId,
} from "../../src/services/consultation-refund.service";
import { feeDebitDocId } from "../../src/money/refund-id";
import { toTransactionLookup } from "../../src/services/billing/paystack.provider";
import { transactionService } from "../../src/services/transaction.service";
import type { Transaction } from "../../src/types";

/* eslint-disable @typescript-eslint/no-explicit-any */

// ============================================
// Setup: record notifications, silence logs
// ============================================

/** Every notification sent during a test. */
const notified: Array<{ userId: string; type: string; body: string }> = [];
const realError = console.error;
const realWarn = console.warn;
const realSecret = process.env.PAYSTACK_SECRET_KEY;

before(async () => {
  await useHarness();
  (notificationService as any).notifyUser = async (n: { userId: string; type: string; body: string }) => {
    notified.push({ userId: n.userId, type: n.type, body: n.body });
  };
});
beforeEach(() => {
  harness.reset();
  notified.length = 0;
  process.env.PAYSTACK_SECRET_KEY = TEST_PAYSTACK_SECRET;
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  console.error = () => {};
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  console.warn = () => {};
});
afterEach(() => {
  console.error = realError;
  console.warn = realWarn;
  if (realSecret === undefined) delete process.env.PAYSTACK_SECRET_KEY;
  else process.env.PAYSTACK_SECRET_KEY = realSecret;
});

// ============================================
// Helpers
// ============================================

/** A: ₦9,000.00 in kobo. */
const A = 900_000;
/** F: Paystack's fee, ₦150.00 in kobo. */
const F = 15_000;

/** Every stored Paystack-fee debit. */
function debitRows(): Record<string, any>[] {
  return docsIn("transactions").map(([, d]) => d).filter((d) => d.type === "paystack_fee_debit");
}

/** Move the clock past the fee's release (slot end + 24 h; the slot is 168 h away). */
function releaseHold(): void {
  harness.clock.advanceHours(168 + 1 + 25);
}

/** The agent's whole balance in `currency`: held + available (what they are owed). */
async function agentTotal(currency = "NGN"): Promise<number> {
  const b = await balanceOf(agent, currency);
  return b.heldBalance + b.availableBalance;
}

/**
 * Seli's net for one reference: what reached Seli's Paystack balance
 * (A - F), minus what went back to the client, minus what Seli owes the
 * agent for it. Must be 0 for every row of the rule table.
 */
async function seliNet(refundAmount: number, currency = "NGN", charged = A, fee = F): Promise<number> {
  return charged - fee - refundAmount - (await agentTotal(currency));
}

/** Settle every refund row at Paystack (as `refund.processed` would). */
async function completeRefunds(): Promise<void> {
  for (const r of refundRows()) await consultationRefundService.advanceRefundStatus(r.id, "completed");
}

/** Seed a consultation fee written BEFORE #395 (credited A, no fee stored) on a paid booking `id`. */
async function seedLegacyPaid(id: string, opts: { released?: boolean; currency?: string; amount?: number } = {}) {
  const fee = await bookAndPay(id, { fees: F, ...(opts.currency ? { charge: { amountMinor: opts.amount!, currency: opts.currency as any } } : {}) });
  // Strip the #395 fields, as a row written before #395 has none.
  const stored = docsIn("transactions").find(([docId]) => docId === fee.id)![1];
  for (const k of ["paystackFeeMinor", "paystackFeeStatus", "agentCreditMinor", "paystackFeeResolvedAt", "paystackFeeResolvedBy"]) {
    delete stored[k];
  }
  if (opts.released) {
    stored.feeHold = { ...stored.feeHold, state: "released", endedAt: T0, endedBy: "legacy_backfill" };
  }
  return stored;
}

/** Make Paystack report `fees` (raw) for booking `id`'s reference from now on. */
function paystackNowReports(id: string, fees: unknown): void {
  const reference = refOf(id);
  const seen = harness.paystack.get(reference)!;
  harness.paystack.set(reference, toTransactionLookup({ ...seen, paid_at: seen.paidAt, fees }));
}

/** The notification bodies sent to `uid`. */
function bodiesFor(uid: string): string[] {
  return notified.filter((n) => n.userId === uid).map((n) => n.body);
}

// ============================================
// The pure rule
// ============================================

describe("planCancellationRefund (pure)", () => {
  test("net-credited fee (C = A - F): client 0, agent -F, debit only out of the hold", () => {
    const C = A - F;
    const plan = (feeBorneBy: "client" | "agent", fundedFrom: "hold" | "available") =>
      planCancellationRefund({ amountMinor: A, creditMinor: C, feeMinor: F, feeBorneBy, fundedFrom });
    assert.deepEqual(plan("client", "hold"), { kind: "refund", feeMinor: F, refundAmountMinor: A - F, feeKeptMinor: F, agentReversalMinor: C, debitMinor: 0 });
    assert.deepEqual(plan("client", "available"), { kind: "refund", feeMinor: F, refundAmountMinor: A - F, feeKeptMinor: F, agentReversalMinor: A - F, debitMinor: 0 });
    assert.deepEqual(plan("agent", "hold"), { kind: "refund", feeMinor: F, refundAmountMinor: A, agentReversalMinor: C, debitMinor: F });
    // From available the refund of A already takes F off the agent: no debit.
    assert.deepEqual(plan("agent", "available"), { kind: "refund", feeMinor: F, refundAmountMinor: A, agentReversalMinor: A, debitMinor: 0 });
  });

  test("legacy full-credit fee (C = A): the agent gives back A on the client's fault; agent-caused debits F", () => {
    const plan = (feeBorneBy: "client" | "agent", fundedFrom: "hold" | "available") =>
      planCancellationRefund({ amountMinor: A, creditMinor: A, feeMinor: F, feeBorneBy, fundedFrom });
    assert.deepEqual(plan("client", "available"), { kind: "refund", feeMinor: F, refundAmountMinor: A - F, feeKeptMinor: F, agentReversalMinor: A, debitMinor: 0 });
    assert.deepEqual(plan("client", "hold"), { kind: "refund", feeMinor: F, refundAmountMinor: A - F, feeKeptMinor: F, agentReversalMinor: A, debitMinor: 0 });
    assert.deepEqual(plan("agent", "available"), { kind: "refund", feeMinor: F, refundAmountMinor: A, agentReversalMinor: A, debitMinor: F });
    assert.deepEqual(plan("agent", "hold"), { kind: "refund", feeMinor: F, refundAmountMinor: A, agentReversalMinor: A, debitMinor: F });
  });

  test("unknown fee holds; client-caused fee >= A holds; agent-caused fee >= A debits the fee", () => {
    for (const fee of [undefined, null, -1, "150", 1.5, NaN]) {
      for (const feeBorneBy of ["client", "agent"] as const) {
        assert.deepEqual(
          planCancellationRefund({ amountMinor: A, creditMinor: A - F, feeMinor: fee, feeBorneBy, fundedFrom: "hold" }),
          { kind: "hold", reason: "paystack_fee_unknown" }
        );
      }
    }
    assert.deepEqual(planCancellationRefund({ amountMinor: A, creditMinor: 0, feeMinor: A, feeBorneBy: "client", fundedFrom: "hold" }), {
      kind: "hold", reason: "fee_not_less_than_amount", feeMinor: A,
    });
    // A fee row credited nowhere (fee >= A): the agent caused it, pays the whole fee.
    assert.deepEqual(planCancellationRefund({ amountMinor: A, creditMinor: 0, feeMinor: A, feeBorneBy: "agent", fundedFrom: "hold" }), {
      kind: "refund", feeMinor: A, refundAmountMinor: A, agentReversalMinor: 0, debitMinor: A,
    });
  });

  test("feeBorneByFor: the reason decides, goodwill / other need a choice (no default)", () => {
    assert.equal(feeBorneByFor("client_cancelled"), "client");
    assert.equal(feeBorneByFor("agent_cancelled"), "agent");
    assert.equal(feeBorneByFor("admin_agent_no_show", "client"), "agent");
    assert.equal(feeBorneByFor("admin_goodwill"), null);
    assert.equal(feeBorneByFor("admin_other", "client"), "client");
    assert.equal(feeBorneByFor("admin_goodwill", "x" as any), null);
  });

  test("feeForRefund: the stored fee first; the lookup only when none is stored, in the same currency", () => {
    assert.equal(feeForRefund({ currency: "NGN", paystackFeeStatus: "known", paystackFeeMinor: F }, { fees: 1, currency: "NGN" }), F);
    assert.equal(feeForRefund({ currency: "NGN" }, { fees: F, currency: "NGN" }), F);
    assert.equal(feeForRefund({ currency: "NGN", paystackFeeStatus: "unknown" }, { fees: F, currency: "NGN" }), F);
    assert.equal(feeForRefund({ currency: "GHS" }, { fees: F, currency: "NGN" }), undefined);
    assert.equal(feeForRefund({ currency: "NGN" }, null), undefined);
  });
});

// ============================================
// The rule table on a net-credited fee: {client, agent} x {hold, available}
// ============================================

describe("the refund matrix on a net-credited fee (A - F)", () => {
  test("client caused, out of the hold (client cancels 24 h+ before): client A - F, agent 0, no debit, Seli 0", async () => {
    await bookAndPay("c1", { fees: F });
    // The preview says it before the client confirms.
    const preview = (await getBooking(client)).body.data.cancellationRefund;
    assert.deepEqual(preview.amount, { amountMinor: A - F, currency: "NGN" });
    assert.deepEqual(preview.processingFee, { amountMinor: F, currency: "NGN" });

    const out = await setStatus(client, "cancelled");
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.deepEqual(out.body.data.refund, {
      status: "processing", amount: { amountMinor: A - F, currency: "NGN" }, processingFee: { amountMinor: F, currency: "NGN" },
    });
    const [row] = refundRows();
    assert.equal(row.amount, A - F);
    assert.equal(row.paystackFeeKeptMinor, F);
    assert.equal(row.paystackFeeMinor, F);
    assert.equal(row.feeBorneBy, "client");
    assert.equal(row.refundFundedFrom, "hold");
    assert.deepEqual(harness.refundCalls.map((c) => [c.reference, c.amount]), [[refOf("c1"), { amountMinor: A - F, currency: "NGN" }]]);
    assert.equal(debitRows().length, 0);
    const bal = await balanceOf(agent);
    assert.equal(bal.heldBalance, 0);
    assert.equal(bal.availableBalance, 0);
    assert.equal(await seliNet(A - F), 0);
    // Revenue agrees once the refund settles.
    await completeRefunds();
    assert.equal((await balanceOf(agent)).totalRevenue, 0);
    // The client is told both figures.
    assert.ok(
      bodiesFor(client.uid).includes(
        "Your refund of NGN 8,850.00 is on its way. The payment provider kept a processing fee of NGN 150.00."
      ),
      JSON.stringify(bodiesFor(client.uid))
    );
    // The agent: no fee debit sentence.
    assert.ok(bodiesFor(agent.uid).every((b) => !b.includes("payment processing fee was taken")));
  });

  test("agent caused, out of the hold (agent cancels): client A, agent -F (one debit), Seli 0", async () => {
    await bookAndPay("c1", { fees: F });
    const out = await setStatus(agent, "cancelled");
    assert.equal(out.status, 200);
    assert.deepEqual(out.body.data.refund, { status: "processing", amount: { amountMinor: A, currency: "NGN" }, processingFee: null });
    const [row] = refundRows();
    assert.equal(row.amount, A);
    assert.equal(row.feeBorneBy, "agent");
    assert.equal(row.refundFundedFrom, "hold");
    assert.equal(row.agentReversalMinor, A - F);
    assert.deepEqual(harness.refundCalls.map((c) => c.amount), [{ amountMinor: A, currency: "NGN" }]);
    const debits = debitRows();
    assert.equal(debits.length, 1);
    const [d] = debits;
    assert.equal(d.id, feeDebitDocId(refOf("c1")));
    assert.equal(d.agentId, agent.uid);
    assert.equal(d.consultationId, "c1");
    assert.equal(d.amount, F);
    assert.equal(d.currency, "NGN");
    assert.equal(d.status, "completed");
    assert.equal(d.refundId, row.id);
    assert.equal(row.feeDebitId, d.id);
    assert.equal(d.description, "Payment processing fee on a refunded consultation");
    // The debit is under the agent's withdrawal lock.
    const lock = docsIn("withdrawalLocks").find(([id]) => id === agent.uid)![1];
    assert.equal(lock.lastFeeDebitId, d.id);

    // Below zero: -F, held untouched, withdrawals refused.
    const bal = await balanceOf(agent);
    assert.equal(bal.heldBalance, 0);
    assert.equal(bal.availableBalance, -F);
    assert.equal(bal.totalRevenue, A - F - F, "while the refund is still processing at Paystack");
    assert.equal(await seliNet(A), 0);
    assert.equal((await withdraw(1)).status, 400);
    await completeRefunds();
    assert.equal((await balanceOf(agent)).totalRevenue, -F, "revenue agrees once settled");

    // The agent sees the debit; the client never does.
    const agentList = await listTransactions(agent);
    assert.ok(agentList.body.data.some((t: any) => t.type === "paystack_fee_debit"));
    const clientList = await listTransactions(client);
    assert.equal(clientList.body.data.some((t: any) => t.type === "paystack_fee_debit" || t.id === d.id), false);
    // The agent's notification names the fee.
    assert.ok(bodiesFor(agent.uid).some((b) => b.endsWith("The NGN 150.00 payment processing fee was taken from your balance.")));
    // The client gets everything back: no processing-fee sentence.
    assert.ok(bodiesFor(client.uid).includes("Your refund of NGN 9,000.00 is on its way."));
  });

  test("agent caused, from available (admin agent_no_show after release): A off A - F leaves -F, NO debit", async () => {
    await bookAndPay("c1", { fees: F });
    releaseHold();
    assert.equal((await balanceOf(agent)).availableBalance, A - F);
    const out = await adminRefund(admin, { reason: "agent_no_show" });
    assert.equal(out.status, 201, JSON.stringify(out.body));
    const [row] = refundRows();
    assert.equal(row.amount, A);
    assert.equal(row.refundFundedFrom, "available");
    assert.equal(row.agentReversalMinor, A);
    assert.equal(debitRows().length, 0, "no paystack_fee_debit on top");
    assert.equal((await balanceOf(agent)).availableBalance, -F);
    assert.equal(await seliNet(A), 0);
    await completeRefunds();
    assert.equal((await balanceOf(agent)).totalRevenue, -F);
  });

  test("client caused, from available (admin goodwill, feeBorneBy client): A - F off A - F leaves 0", async () => {
    await bookAndPay("c1", { fees: F });
    releaseHold();
    const out = await adminRefund(admin, { reason: "goodwill", feeBorneBy: "client" });
    assert.equal(out.status, 201, JSON.stringify(out.body));
    assert.deepEqual(out.body.data.refund.amount, { amountMinor: A - F, currency: "NGN" });
    assert.deepEqual(out.body.data.refund.processingFee, { amountMinor: F, currency: "NGN" });
    const [row] = refundRows();
    assert.equal(row.refundFundedFrom, "available");
    assert.equal(row.agentReversalMinor, A - F);
    assert.equal(debitRows().length, 0);
    assert.equal((await balanceOf(agent)).availableBalance, 0);
    assert.equal(await seliNet(A - F), 0);
    assert.deepEqual(harness.refundCalls.map((c) => c.amount), [{ amountMinor: A - F, currency: "NGN" }]);
  });

  test("admin goodwill while held: feeBorneBy agent debits F once; feeBorneBy client does not", async () => {
    await bookAndPay("c1", { fees: F });
    await bookAndPay("c2", { fees: F });
    assert.equal((await adminRefund(admin, { reason: "goodwill", feeBorneBy: "agent" }, "c1")).status, 201);
    assert.equal((await adminRefund(admin, { reason: "other", note: "Asked to", feeBorneBy: "client" }, "c2")).status, 201);
    const byBooking = Object.fromEntries(refundRows().map((r) => [r.consultationId, r]));
    assert.equal(byBooking.c1.amount, A);
    assert.equal(byBooking.c1.refundFundedFrom, "hold");
    assert.equal(byBooking.c2.amount, A - F);
    assert.equal(byBooking.c2.feeBorneBy, "client");
    assert.deepEqual(debitRows().map((d) => d.consultationId), ["c1"]);
    // c1: -F; c2: 0.
    assert.equal(await agentTotal(), -F);
  });

  test("an owner cancelling is agent-caused too", async () => {
    await bookAndPay("c1", { fees: F });
    assert.equal((await setStatus(ownerA, "cancelled")).status, 200);
    assert.equal(refundRows()[0].amount, A);
    assert.equal(debitRows().length, 1);
  });

  test("a fee of 0: client refund in full, no debit, no processing-fee sentence", async () => {
    await bookAndPay("c1", { fees: 0 });
    await bookAndPay("c2", { fees: 0 });
    await setStatus(client, "cancelled", "c1");
    await setStatus(agent, "cancelled", "c2");
    assert.deepEqual(refundRows().map((r) => r.amount).sort(), [A, A]);
    assert.equal(debitRows().length, 0);
    assert.ok(bodiesFor(client.uid).includes("Your refund of NGN 9,000.00 is on its way."));
  });
});

// ============================================
// Non-NGN charges
// ============================================

describe("a GHS charge", () => {
  test("refund and debit in GHS minor units; the NGN balance never moves", async () => {
    const charge = { amountMinor: 9_000, currency: "GHS" as const };
    await bookAndPay("g1", { charge, fees: 180 });
    await bookAndPay("g2", { charge, fees: 180 });
    await setStatus(client, "cancelled", "g1");
    await setStatus(agent, "cancelled", "g2");
    const byBooking = Object.fromEntries(refundRows().map((r) => [r.consultationId, r]));
    assert.equal(byBooking.g1.amount, 8_820);
    assert.equal(byBooking.g1.currency, "GHS");
    assert.equal(byBooking.g2.amount, 9_000);
    const [d] = debitRows();
    assert.equal(d.amount, 180);
    assert.equal(d.currency, "GHS");
    assert.deepEqual(harness.refundCalls.map((c) => c.amount).sort((a, b) => a.amountMinor - b.amountMinor), [
      { amountMinor: 8_820, currency: "GHS" }, { amountMinor: 9_000, currency: "GHS" },
    ]);
    assert.equal(await agentTotal("GHS"), -180);
    const ngn = await balanceOf(agent, "NGN");
    assert.deepEqual([ngn.heldBalance, ngn.availableBalance], [0, 0]);
  });
});

// ============================================
// Older fee rows (credited A, no fee stored): user decision 2026-11-17
// ============================================

describe("older full-credit fee rows", () => {
  test("client cancel: F looked up at Paystack, client A - F, the agent gives back the whole A (ends at 0)", async () => {
    const fee = await seedLegacyPaid("c1");
    assert.equal(await agentTotal(), A, "credited the full A before the refund");
    const lookupsBefore = harness.paystack.size;
    const out = await setStatus(client, "cancelled");
    assert.equal(out.status, 200);
    const [row] = refundRows();
    assert.equal(row.amount, A - F);
    assert.equal(row.paystackFeeMinor, F, "the fee found is stored on the refund row");
    assert.equal(row.agentReversalMinor, A);
    assert.equal(await agentTotal(), 0);
    assert.equal(await seliNet(A - F), 0);
    // The fee row is left as it was (it keeps counting as A until refunded).
    assert.equal(feeOf("c1")!.paystackFeeStatus, undefined);
    assert.equal(feeOf("c1")!.id, fee.id);
    assert.equal(harness.paystack.size, lookupsBefore);
  });

  test("admin goodwill, client-borne, from available: the agent gives back A, client A - F, Seli 0", async () => {
    await seedLegacyPaid("c1", { released: true });
    assert.equal((await balanceOf(agent)).availableBalance, A);
    const out = await adminRefund(admin, { reason: "goodwill", feeBorneBy: "client" });
    assert.equal(out.status, 201, JSON.stringify(out.body));
    const [row] = refundRows();
    assert.equal(row.amount, A - F);
    assert.equal(row.agentReversalMinor, A);
    assert.equal(debitRows().length, 0);
    assert.equal((await balanceOf(agent)).availableBalance, 0);
    assert.equal(await seliNet(A - F), 0);
  });

  test("agent caused from available: refund A off A, and the one debit of F (agent -F)", async () => {
    await seedLegacyPaid("c1", { released: true });
    assert.equal((await adminRefund(admin, { reason: "agent_no_show" })).status, 201);
    assert.equal(refundRows()[0].amount, A);
    assert.equal(debitRows().length, 1);
    assert.equal((await balanceOf(agent)).availableBalance, -F);
    assert.equal(await seliNet(A), 0);
  });

  test("agent caused out of the hold: refund A, debit F", async () => {
    await seedLegacyPaid("c1");
    await setStatus(agent, "cancelled");
    assert.equal(refundRows()[0].amount, A);
    assert.equal(debitRows()[0].amount, F);
    assert.equal(await agentTotal(), -F);
  });

  for (const [label, fees] of [["missing", undefined], ["null", null], ["negative", -1], ["a string", "15000"], ["a fraction", 150.5]] as Array<[string, unknown]>) {
    test(`Paystack fee ${label}: cancelled, refund HELD (no Paystack call, no debit), retry with the fee proceeds once; still missing 409`, async () => {
      await seedLegacyPaid("c1");
      paystackNowReports("c1", fees);
      const out = await setStatus(client, "cancelled");
      assert.equal(out.status, 200);
      assert.equal(bookingOf("c1")!.status, "cancelled", "the booking still cancels");
      assert.deepEqual(out.body.data.refund, { status: "failed", amount: null, processingFee: null, heldReason: "paystack_fee_unknown" });
      const [held] = refundRows();
      assert.equal(held.id, refundDocId(refOf("c1")));
      assert.equal(held.status, "failed");
      assert.equal(held.amount, 0, "no guessed amount");
      assert.equal(held.refundHeldReason, "paystack_fee_unknown");
      assert.equal(held.refundLastError, "paystack_fee_unknown");
      assert.equal(held.refundFundedFrom, undefined);
      assert.equal(bookingOf("c1")!.refundStatus, "failed", "the booking mirrors it");
      assert.equal(harness.refundCalls.length, 0);
      assert.equal(debitRows().length, 0);
      // The fee was not refunded out of its hold: nothing moved.
      assert.equal(feeOf("c1")!.feeHold.state, "held");
      // The client hears it is delayed.
      assert.ok(bodiesFor(client.uid).includes("Your refund is delayed. We're on it."));
      // Listed for admins.
      const failed = await listTransactions(admin, { role: "admin", type: "refund", status: "failed" });
      assert.deepEqual(failed.body.data.map((t: any) => t.id), [held.id]);
      // The retry job never sends it.
      await consultationRefundService.retryDueRefunds();
      assert.equal(harness.refundCalls.length, 0);

      // Admin retry, Paystack still has nothing: 409, nothing written.
      const before = JSON.stringify(refundRows());
      const still = await adminRefund(admin, { reason: "goodwill", feeBorneBy: "agent" });
      assert.equal(still.status, 409);
      assert.equal(still.body.error, "PAYSTACK_FEE_UNKNOWN");
      assert.equal(JSON.stringify(refundRows()), before);
      assert.equal(harness.refundCalls.length, 0);

      // Paystack reports it: the retry proceeds ONCE, under the stored (client) cause.
      paystackNowReports("c1", F);
      const go = await adminRefund(admin, { reason: "goodwill", feeBorneBy: "agent" });
      assert.equal(go.status, 200, JSON.stringify(go.body));
      assert.equal(go.body.data.retried, true);
      const [row] = refundRows();
      assert.equal(row.id, held.id, "the same row, rewritten");
      assert.equal(row.amount, A - F);
      assert.equal(row.feeBorneBy, "client");
      assert.equal(row.reason, "client_cancelled");
      assert.equal(row.refundHeldReason, undefined);
      assert.equal(row.createdAt.toMillis(), held.createdAt.toMillis());
      assert.deepEqual(harness.refundCalls.map((c) => c.amount), [{ amountMinor: A - F, currency: "NGN" }]);
      assert.equal(debitRows().length, 0);
      assert.equal(await agentTotal(), 0);
      // A second retry: already refunded, nothing more.
      const again = await adminRefund(admin, { reason: "goodwill", feeBorneBy: "agent" });
      assert.equal(again.body.error, "ALREADY_REFUNDED");
      assert.equal(harness.refundCalls.length, 1);
    });
  }

  test("a held agent-caused refund retried with the fee: refund A and the one debit", async () => {
    await seedLegacyPaid("c1");
    paystackNowReports("c1", undefined);
    await setStatus(agent, "cancelled");
    assert.equal(refundRows()[0].refundHeldReason, "paystack_fee_unknown");
    assert.equal(debitRows().length, 0);
    paystackNowReports("c1", F);
    const go = await adminRefund(admin, { reason: "goodwill", feeBorneBy: "client" });
    assert.equal(go.status, 200, JSON.stringify(go.body));
    assert.equal(refundRows()[0].amount, A, "the stored agent cause wins over the body");
    assert.equal(debitRows().length, 1);
    assert.equal(await agentTotal(), -F);
    assert.ok(bodiesFor(agent.uid).some((b) => b.includes("payment processing fee was taken from your balance")));
  });

  test("a Paystack outage during the cancel's lookup: cancelled, refund held", async () => {
    await seedLegacyPaid("c1");
    harness.failNextLookup = true;
    const out = await setStatus(client, "cancelled");
    assert.equal(out.status, 200);
    assert.equal(refundRows()[0].refundHeldReason, "paystack_fee_unknown");
    // An admin retry while Paystack is down answers 502, nothing written.
    harness.failNextLookup = true;
    const retry = await adminRefund(admin, { reason: "goodwill", feeBorneBy: "agent" });
    assert.equal(retry.status, 502);
  });
});

// ============================================
// #395 fee rows whose fee is unknown, or not less than A
// ============================================

describe("refunds of a fee whose Paystack fee is unknown or >= A", () => {
  test("unknown at settle and still unknown at cancel: held, no Paystack call, no debit", async () => {
    await bookAndPay("c1", { fees: undefined });
    const preview = (await getBooking(client)).body.data.cancellationRefund;
    assert.equal(preview.amount, null, "never the full amount as a guess");
    assert.equal(preview.processingFee, null);
    await setStatus(agent, "cancelled");
    assert.equal(refundRows()[0].refundHeldReason, "paystack_fee_unknown");
    assert.equal(harness.refundCalls.length, 0);
    assert.equal(debitRows().length, 0);
  });

  test("unknown at settle, known by cancel time: the fee row is resolved in the same commit and the refund proceeds", async () => {
    await bookAndPay("c1", { fees: undefined });
    paystackNowReports("c1", F);
    await setStatus(agent, "cancelled");
    const fee = feeOf("c1")!;
    assert.equal(fee.paystackFeeStatus, "known");
    assert.equal(fee.paystackFeeMinor, F);
    assert.equal(fee.paystackFeeResolvedBy, "refund");
    assert.equal(fee.feeHold.state, "refunded");
    assert.equal(refundRows()[0].amount, A);
    assert.equal(debitRows().length, 1);
    assert.equal(await agentTotal(), -F);
    assert.equal(await seliNet(A), 0);
  });

  test("the job resolves the fee, then an admin retry of the held refund uses the stored fee (no lookup needed)", async () => {
    await bookAndPay("c1", { fees: undefined });
    await setStatus(client, "cancelled");
    assert.equal(refundRows()[0].refundHeldReason, "paystack_fee_unknown");
    paystackNowReports("c1", F);
    const { paystackFeeService } = await import("../../src/services/paystack-fee.service");
    await paystackFeeService.resolveUnknownFees();
    assert.equal(feeOf("c1")!.paystackFeeMinor, F);
    // Paystack goes away: the stored fee is enough.
    paystackNowReports("c1", undefined);
    const go = await adminRefund(admin, { reason: "goodwill", feeBorneBy: "agent" });
    assert.equal(go.status, 200, JSON.stringify(go.body));
    assert.equal(refundRows()[0].amount, A - F);
    assert.equal(await agentTotal(), 0);
  });

  test("client cancel with F >= A: held fee_not_less_than_amount, no Paystack call", async () => {
    await bookAndPay("c1", { fees: A });
    const out = await setStatus(client, "cancelled");
    assert.equal(out.body.data.refund.heldReason, "fee_not_less_than_amount");
    const [row] = refundRows();
    assert.equal(row.refundHeldReason, "fee_not_less_than_amount");
    assert.equal(row.paystackFeeMinor, A);
    assert.equal(harness.refundCalls.length, 0);
    // An admin retry: still nothing to give back, 409, nothing written.
    const retry = await adminRefund(admin, { reason: "goodwill", feeBorneBy: "client" });
    assert.equal(retry.status, 409);
    assert.equal(retry.body.error, "FEE_NOT_LESS_THAN_AMOUNT");
  });

  test("agent cancel with F >= A: the client gets A, the agent carries the whole fee", async () => {
    await bookAndPay("c1", { fees: A });
    await setStatus(agent, "cancelled");
    assert.equal(refundRows()[0].amount, A);
    assert.equal(debitRows()[0].amount, A);
    assert.equal(await agentTotal(), -A);
  });

  test("admin refund with the fee unknown writes nothing (409), never a held row", async () => {
    await bookAndPay("c1", { fees: undefined });
    const out = await adminRefund(admin, { reason: "agent_no_show" });
    assert.equal(out.status, 409);
    assert.equal(out.body.error, "PAYSTACK_FEE_UNKNOWN");
    assert.equal(refundRows().length, 0);
  });

  test("a status webhook for a held row is ignored", async () => {
    await bookAndPay("c1", { fees: undefined });
    await setStatus(client, "cancelled");
    const out = await webhook(refundEvent("refund.processed", refOf("c1")));
    assert.equal(out.status, 200);
    assert.equal(refundRows()[0].status, "failed");
    assert.equal(refundRows()[0].refundHeldReason, "paystack_fee_unknown");
  });
});

// ============================================
// feeBorneBy validation on admin refunds
// ============================================

describe("POST /consultations/:id/refund feeBorneBy", () => {
  test("goodwill / other: required, client or agent only, no default; nothing written on a 400", async () => {
    await bookAndPay("c1", { fees: F });
    for (const body of [
      { reason: "goodwill" }, { reason: "goodwill", feeBorneBy: "seli" }, { reason: "goodwill", feeBorneBy: null },
      { reason: "other", note: "x" }, { reason: "other", note: "x", feeBorneBy: "Client" },
    ]) {
      const out = await adminRefund(admin, body);
      assert.equal(out.status, 400, JSON.stringify(body));
      assert.equal(out.body.error, "VALIDATION_ERROR");
    }
    assert.equal(refundRows().length, 0);
  });

  test("agent_no_show: always the agent; feeBorneBy agent accepted, client refused", async () => {
    await bookAndPay("c1", { fees: F });
    assert.equal((await adminRefund(admin, { reason: "agent_no_show", feeBorneBy: "client" })).status, 400);
    assert.equal(refundRows().length, 0);
    assert.equal((await adminRefund(admin, { reason: "agent_no_show", feeBorneBy: "agent" })).status, 201);
    assert.equal(refundRows()[0].feeBorneBy, "agent");
  });

  test("non-admins: 403 before anything is read", async () => {
    await bookAndPay("c1", { fees: F });
    for (const p of [agent, ownerA, client]) {
      assert.equal((await adminRefund(p, { reason: "goodwill", feeBorneBy: "client" })).status, 403);
    }
  });
});

// ============================================
// Idempotency: one refund and at most one debit per reference
// ============================================

describe("idempotency", () => {
  test("double cancel: one refund, one debit", async () => {
    await bookAndPay("c1", { fees: F });
    assert.equal((await setStatus(agent, "cancelled")).status, 200);
    const second = await setStatus(agent, "cancelled");
    assert.notEqual(second.status, 500);
    assert.equal(refundRows().length, 1);
    assert.equal(debitRows().length, 1);
    assert.equal(harness.refundCalls.length, 1);
  });

  test("concurrent admin refunds and a cancel: one refund, one debit, one Paystack call", async () => {
    await bookAndPay("c1", { fees: F });
    const outs = await Promise.all([
      adminRefund(admin, { reason: "agent_no_show" }),
      adminRefund(admin, { reason: "goodwill", feeBorneBy: "agent" }),
      setStatus(agent, "cancelled"),
    ]);
    assert.ok(outs.every((o) => o.status !== 500), JSON.stringify(outs.map((o) => o.status)));
    assert.equal(refundRows().length, 1);
    assert.equal(debitRows().length, 1);
    assert.equal(harness.refundCalls.length, 1);
    assert.equal(await agentTotal(), -F);
  });

  test("concurrent retries of a held refund: proceeds once", async () => {
    await seedLegacyPaid("c1");
    paystackNowReports("c1", undefined);
    await setStatus(agent, "cancelled");
    paystackNowReports("c1", F);
    const outs = await Promise.all([0, 1, 2].map(() => adminRefund(admin, { reason: "goodwill", feeBorneBy: "agent" })));
    assert.deepEqual(outs.map((o) => o.status).sort(), [200, 409, 409]);
    assert.equal(refundRows().length, 1);
    assert.equal(debitRows().length, 1);
    assert.equal(harness.refundCalls.length, 1);
  });

  test("a reference that already has a #354 debit: an agent-caused cancel never writes a second one", async () => {
    await bookAndPay("c1", { fees: F });
    const debitId = feeDebitDocId(refOf("c1"));
    await seed("transactions", debitId, transactionService.buildPaystackFeeDebit(debitId, T0, {
      agentUserId: agent.uid, consultationId: "c1", reference: refOf("c1"), feeMinor: F, currency: "NGN", exceptionId: refOf("c1"),
    }) as unknown as Record<string, unknown>);
    await setStatus(agent, "cancelled");
    assert.equal(debitRows().length, 1, "still the one debit");
    assert.equal(refundRows()[0].feeDebitId, debitId);
    assert.equal(await agentTotal(), -F, "the fee charged once, never 2F");
  });
});

// ============================================
// Rows written before #390 keep their meaning
// ============================================

describe("older refund rows", () => {
  test("a refund row with no agentReversalMinor takes its amount off, as before", () => {
    const rows = [
      { id: "f", type: "consultation_fee", amount: A, currency: "NGN", status: "completed", feeHold: { state: "released" } },
      { id: "r", type: "refund", amount: A, currency: "NGN", status: "completed", refundFundedFrom: "available" },
    ] as unknown as Transaction[];
    const [ngn] = transactionService.computeStats(rows, new Date()).byCurrency;
    assert.equal(ngn.availableBalance, 0);
    assert.equal(ngn.totalRevenue, 0);
  });

  test("the stored fee time of a refund-resolved fee is a Timestamp", async () => {
    await bookAndPay("c1", { fees: undefined });
    paystackNowReports("c1", F);
    await setStatus(client, "cancelled");
    assert.ok(feeOf("c1")!.paystackFeeResolvedAt instanceof Timestamp);
  });
});

// ============================================
// A held refund FREEZES its fee (orchestrator decision 2026-11-19)
// ============================================
//
// While a refund is held for an admin (Paystack's fee unknown), the fee it
// would give back must not release by the clock, nor by a closed meeting,
// nor count as available or withdrawable, nor be stamped released by the
// legacy hold backfill, until the admin retry works the refund out.

describe("a held refund freezes the fee", () => {
  test("older row, fee unknown: frozen past its release time; the retry refunds it out of the hold and unfreezes it", async () => {
    await seedLegacyPaid("c1");
    paystackNowReports("c1", undefined);
    await setStatus(client, "cancelled");
    const [held] = refundRows();
    assert.equal(held.refundHeldReason, "paystack_fee_unknown");
    const frozen = feeOf("c1")!;
    assert.equal(frozen.feeHoldFrozenByRefundId, held.id);
    assert.ok(frozen.feeHoldFrozenAt instanceof Timestamp);

    // Long past the slot end + 24 h, and with the meeting marked closed: still held.
    releaseHold();
    const stored = docsIn("transactions").find(([id]) => id === frozen.id)![1];
    stored.feeHold = { ...stored.feeHold, meetingClosedAt: T0 };
    const bal = await balanceOf(agent);
    assert.equal(bal.heldBalance, A, "counted held, not available");
    assert.equal(bal.availableBalance, 0);
    assert.equal((await withdraw(1)).status, 400, "never withdrawable");

    // The admin retry, once Paystack reports the fee: out of the hold, unfrozen.
    paystackNowReports("c1", F);
    const go = await adminRefund(admin, { reason: "goodwill", feeBorneBy: "agent" });
    assert.equal(go.status, 200, JSON.stringify(go.body));
    const [row] = refundRows();
    assert.equal(row.refundFundedFrom, "hold");
    assert.equal(row.amount, A - F);
    assert.equal(row.agentReversalMinor, A);
    const after = feeOf("c1")!;
    assert.equal(after.feeHoldFrozenByRefundId, undefined);
    assert.equal(after.feeHoldFrozenAt, undefined);
    assert.equal(after.feeHold.state, "refunded");
    assert.equal(await agentTotal(), 0);
    assert.equal(await seliNet(A - F), 0);
  });

  test("a retry that is still 409 leaves the fee frozen", async () => {
    await seedLegacyPaid("c1");
    paystackNowReports("c1", null);
    await setStatus(client, "cancelled");
    releaseHold();
    assert.equal((await adminRefund(admin, { reason: "goodwill", feeBorneBy: "agent" })).status, 409);
    assert.ok(feeOf("c1")!.feeHoldFrozenByRefundId);
    assert.equal((await balanceOf(agent)).availableBalance, 0);
  });

  test("feeHoldStatusAt: frozen is held whatever the clock says; a refunded fee stays refunded", async () => {
    const { feeHoldStatusAt } = await import("../../src/money/fee-hold");
    const past = Timestamp.fromMillis(T0.toMillis() - 86_400_000);
    const hold = { state: "held" as const, slotStartAt: past, releaseAt: past, meetingClosedAt: past };
    assert.equal(feeHoldStatusAt({ feeHold: hold }, new Date()), "released");
    assert.equal(feeHoldStatusAt({ feeHold: hold, feeHoldFrozenByRefundId: "r" }, new Date()), "held");
    assert.equal(feeHoldStatusAt({ feeHold: { ...hold, state: "released" }, feeHoldFrozenByRefundId: "r" }, new Date()), "held");
    assert.equal(feeHoldStatusAt({ feeHold: { ...hold, state: "refunded" }, feeHoldFrozenByRefundId: "r" }, new Date()), "refunded");
    assert.equal(feeHoldStatusAt({ feeHoldFrozenByRefundId: "r" } as any, new Date()), "held");
  });

  test("the hold backfill (release job) skips a frozen fee, even one with no hold yet", async () => {
    const { decideFeeHoldBackfill } = await import("../../src/scripts/backfill-fee-holds");
    await seedLegacyPaid("c1");
    paystackNowReports("c1", undefined);
    await setStatus(client, "cancelled");
    const fee = { ...feeOf("c1")! } as any;
    delete fee.feeHold; // a pre-#317 row: the backfill would otherwise stamp it
    const booking = { ...bookingOf("c1")!, status: "completed" } as any;
    const later = new Date(T0.toMillis() + 400 * 3_600_000);
    assert.deepEqual(decideFeeHoldBackfill(fee, booking, later), { kind: "skip_frozen" });
    // Without the freeze (and no refund row) it would have been released.
    delete fee.feeHoldFrozenByRefundId;
    assert.equal(decideFeeHoldBackfill(fee, booking, later).kind, "stamp");
  });
});
