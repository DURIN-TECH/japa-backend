// ============================================
// Unit tests: fee-rule hardening and money correctness (issue #413)
// ============================================
//
// Hermetic (test/consultations/harness.ts): in-memory Firestore, every
// Paystack call stubbed (transaction lookups, refund create and refund list
// are recorders; nothing reaches the network, no real money moves), a fixed
// clock the tests move.
//
// One describe per acceptance criterion of #413:
//  A. a Paystack refund is adopted only on an EXACT amount + currency match;
//     anything else is flagged for an admin, and never followed by a create;
//  B. an admin closes a held client-cancel refund whose Paystack fee >= the
//     charge as nothing_to_refund (nobody gets anything);
//  C. (copy: tested in consultation-unapplied-refunds.test.ts);
//  D. the fee lookup job goes oldest first and sets permanently unknown rows aside;
//  E. admin filter combinations: indexed or 400 (admin-filter-indexes.test.ts);
//  F. the shortfall counts the fee debit written in the same commit;
//  G. the admin refund answers 409 before asking Paystack anything;
//  H. the client's view of a held / delayed / closed refund;
//  I. admin gross counts every settled fee at its charge;
//  J. no A - 2F revenue lag while an agent-caused refund is on its way;
//  K. one `agentReversalOf`;
// plus the portal-design additions: retry ANY failed refund by its id, the
// agent view's `processingFee`, and the booking's `refundHeldReason` mirror.

import { test, describe, before, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { Timestamp } from "firebase-admin/firestore";

import { useHarness, harness, docsIn, captureRes, T0 } from "./harness";
import {
  admin, adminRefund, agent, balanceOf, bookAndPay, bookingOf, client, feeOf, getBooking, listTransactions,
  ownerA, refOf, refundEvent, refundRows, reqFor, seedEarned, setStatus, TEST_PAYSTACK_SECRET, webhook,
} from "./refund-fixtures";
import { notificationService } from "../../src/services/notification.service";
import {
  consultationRefundService, matchProviderRefund, MAX_REFUND_ATTEMPTS, refundShortfall,
} from "../../src/services/consultation-refund.service";
import { consultationController } from "../../src/controllers/consultation.controller";
import { transactionController } from "../../src/controllers/transaction.controller";
import { consultationRoutes } from "../../src/routes/consultation.routes";
import { agentReversalOf as reversalFromService, transactionService } from "../../src/services/transaction.service";
import { agentReversalOf as reversalFromTotals } from "../../src/money/totals";
import { paystackFeeJobConfig, paystackFeeService, PAYSTACK_FEE_LOOKUP_BATCH_SIZE, PAYSTACK_FEE_MAX_JOB_LOOKUPS } from "../../src/services/paystack-fee.service";
import { toTransactionLookup, PaystackRefund, paystackProvider } from "../../src/services/billing/paystack.provider";
import { toClientTransaction } from "../../src/transactions/client-transaction";
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
  // The job's real tunables, unless a test narrows them.
  paystackFeeJobConfig.batchSize = PAYSTACK_FEE_LOOKUP_BATCH_SIZE;
  paystackFeeJobConfig.maxJobLookups = PAYSTACK_FEE_MAX_JOB_LOOKUPS;
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

/** A: ₦9,000.00 in kobo (what every booking here is charged). */
const A = 900_000;
/** F: Paystack's fee, ₦150.00 in kobo. */
const F = 15_000;

/** A Paystack refund of booking `id`'s charge, as Paystack's list would show it. */
function paystackRefund(id: string, over: Partial<PaystackRefund> = {}): PaystackRefund {
  return { id: "manual-1", status: "processed", transactionReference: refOf(id), amount: A, currency: "NGN", ...over };
}

/** Make Paystack hold exactly these refunds for booking `id`'s charge (e.g. a manual dashboard refund). */
function paystackHolds(id: string, refunds: PaystackRefund[]): void {
  harness.paystackRefunds.set(refOf(id), refunds);
}

/** Make Paystack report `fees` (raw) for booking `id`'s reference from now on. */
function paystackNowReports(id: string, fees: unknown): void {
  const reference = refOf(id);
  const seen = harness.paystack.get(reference)!;
  harness.paystack.set(reference, toTransactionLookup({ ...seen, paid_at: seen.paidAt, fees }));
}

/** The "refund delayed" notices the client got. */
function delayedNotices(): number {
  return notified.filter((n) => n.userId === client.uid && n.type === "consultation_refund_delayed").length;
}

/** Every stored Paystack-fee debit. */
function debitRows(): Record<string, any>[] {
  return docsIn("transactions").map(([, d]) => d).filter((d) => d.type === "paystack_fee_debit");
}

/** Every stored Transaction, as the admin stats read them. */
function allRows(): Transaction[] {
  return docsIn("transactions").map(([, d]) => d as Transaction);
}

/** The admin's figures (all rows, gross / fee / net) in NGN. */
function adminStats() {
  const stats = transactionService.computeStats(allRows(), harness.clock.now(), { feeBreakdown: true });
  return stats.byCurrency.find((r) => r.currency === "NGN")!;
}

/** The agent's whole balance in NGN: held + available. */
async function agentTotal(): Promise<number> {
  const b = await balanceOf(agent);
  return b.heldBalance + b.availableBalance;
}

/** POST /consultations/:id/refund/close as `p`. */
async function closeHeld(p: any, id = "c1") {
  const { out, res } = captureRes();
  await consultationController.closeHeldRefund(reqFor(p, { params: { id } }), res);
  return out;
}

/** Run the refund retry job after the retry wait. */
async function runRetryJob(): Promise<void> {
  harness.clock.advanceHours(0.25);
  await consultationRefundService.retryDueRefunds();
}

/** Mutate a stored doc in place (tests only: stands for data written by an older build). */
function patchDoc(collection: string, id: string, patch: Record<string, unknown>): void {
  const doc = docsIn(collection).find(([docId]) => docId === id)![1];
  Object.assign(doc, patch);
}

// ============================================
// A. Only adopt a Paystack refund that matches the row
// ============================================

describe("A: a Paystack refund is adopted only on an exact amount and currency match", () => {
  const row = { amount: A, currency: "NGN" };
  const cases: Array<[string, PaystackRefund[], string]> = [
    ["exact match", [{ id: "1", status: "pending", transactionReference: "r", amount: A, currency: "NGN" }], "match"],
    ["amount differs", [{ id: "1", status: "processed", transactionReference: "r", amount: A - 1, currency: "NGN" }], "mismatch"],
    ["currency differs", [{ id: "1", status: "processed", transactionReference: "r", amount: A, currency: "GHS" }], "mismatch"],
    ["amount missing", [{ id: "1", status: "processed", transactionReference: "r", currency: "NGN" }], "mismatch"],
    ["currency missing", [{ id: "1", status: "processed", transactionReference: "r", amount: A }], "mismatch"],
    ["a failed refund is still ignored", [{ id: "1", status: "failed", transactionReference: "r", amount: 1, currency: "USD" }], "none"],
    ["a failed refund next to an exact one", [
      { id: "1", status: "failed", transactionReference: "r", amount: A, currency: "NGN" },
      { id: "2", status: "processing", transactionReference: "r", amount: A, currency: "NGN" },
    ], "match"],
    ["two live exact refunds are never ours to pick between", [
      { id: "1", status: "processed", transactionReference: "r", amount: A, currency: "NGN" },
      { id: "2", status: "processed", transactionReference: "r", amount: A, currency: "NGN" },
    ], "mismatch"],
    ["no refund at all", [], "none"],
  ];
  for (const [name, refunds, kind] of cases) {
    test(`matchProviderRefund: ${name} -> ${kind}`, () => {
      const out = matchProviderRefund(row, refunds);
      assert.equal(out.kind, kind);
      if (kind === "match") assert.equal((out as any).refund.amount, A);
    });
  }

  test("lookup-first path: a mismatched refund is not adopted, none is created, the row is flagged and listed, the client told once", async () => {
    await bookAndPay("c1");
    // The first create never got an answer (the call MAY have gone through).
    harness.refundBehaviour.push("network");
    assert.equal((await setStatus(agent, "cancelled", "c1")).status, 200);
    assert.equal(refundRows()[0].status, "pending");
    // Meanwhile someone refunded part of it by hand in the Paystack dashboard.
    paystackHolds("c1", [paystackRefund("c1", { amount: 500_000 })]);
    await runRetryJob();

    const [row] = refundRows();
    assert.equal(row.status, "failed");
    assert.equal(row.refundFailureReason, "provider_refund_mismatch");
    assert.equal(row.providerRefundId, undefined, "no Paystack id adopted from it");
    assert.equal(row.providerRefundMismatch.id, "manual-1");
    assert.equal(row.providerRefundMismatch.amountMinor, 500_000);
    assert.equal(row.providerRefundMismatch.currency, "NGN");
    assert.equal(harness.refundCalls.length, 0, "no new createRefund call in that run");
    assert.equal(bookingOf("c1")!.refundStatus, "failed");
    const listed = await listTransactions(admin, { role: "admin", type: "refund", status: "failed" });
    assert.deepEqual(listed.body.data.map((t: any) => t.id), [row.id]);
    assert.equal(delayedNotices(), 1);
  });

  test("a refund in another currency already at Paystack: the first try's lookup flags it; no create is made", async () => {
    await bookAndPay("c1");
    // A refund in ANOTHER currency is already there (review round 1: the
    // first try looks it up before any create, so Paystack is never asked).
    paystackHolds("c1", [paystackRefund("c1", { currency: "USD", amount: 600 })]);
    harness.refundBehaviour.push("already_reversed");
    assert.equal((await setStatus(agent, "cancelled", "c1")).status, 200);
    const [row] = refundRows();
    assert.equal(row.status, "failed");
    assert.equal(row.refundFailureReason, "provider_refund_mismatch");
    assert.equal(row.providerRefundMismatch.currency, "USD");
    assert.equal(harness.refundCalls.length, 0);
    assert.equal(harness.refundLookups.length, 1, "looked up once, before any create");
    assert.equal(delayedNotices(), 1);
  });

  test("an exact refund found after a refused create is adopted as before", async () => {
    await bookAndPay("c1");
    paystackHolds("c1", [paystackRefund("c1", { id: "77", status: "processing" })]);
    harness.refundBehaviour.push("already_reversed");
    await setStatus(agent, "cancelled", "c1");
    const [row] = refundRows();
    assert.equal(row.status, "processing");
    assert.equal(row.providerRefundId, "77");
    assert.equal(row.refundFailureReason, undefined);
  });

  test("an admin retry runs the same check: while the mismatched refund is live it stays flagged, creates nothing, and does not notify again", async () => {
    await bookAndPay("c1");
    harness.refundBehaviour.push("network");
    await setStatus(agent, "cancelled", "c1");
    paystackHolds("c1", [paystackRefund("c1", { amount: undefined })]);
    await runRetryJob();
    const flagged = refundRows()[0];
    assert.equal(flagged.refundFailureReason, "provider_refund_mismatch");

    for (const body of [{ reason: "agent_no_show" }, { refundId: flagged.id }]) {
      const out = await adminRefund(admin, body);
      assert.equal(out.status, 200, JSON.stringify(out.body));
      const [row] = refundRows();
      assert.equal(row.status, "failed", "still flagged");
      assert.equal(row.refundFailureReason, "provider_refund_mismatch");
      assert.equal(harness.refundCalls.length, 0, "no refund created while the mismatched one is live");
    }
    assert.equal(delayedNotices(), 1, "the client was told once");

    // Paystack's refund failed in the end: a retry may now create ours.
    paystackHolds("c1", [paystackRefund("c1", { amount: undefined, status: "failed" })]);
    const out = await adminRefund(admin, { refundId: flagged.id });
    assert.equal(out.status, 200);
    const [row] = refundRows();
    assert.equal(row.status, "processing");
    assert.equal(row.refundFailureReason, undefined);
    assert.deepEqual(harness.refundCalls.map((c) => c.amount), [{ amountMinor: A, currency: "NGN" }]);
  });
});

// ============================================
// A on the webhook path (review round 1): a webhook adopts only an exact
// refund, and never moves a mismatch-flagged row
// ============================================

describe("A (webhook path, review round 1): a refund webhook adopts only an exact match and never moves a flagged row", () => {
  /** The signed webhook for Paystack refund `refund` of booking `id`'s charge. */
  async function refundHook(event: string, refund: PaystackRefund, id = "c1") {
    const out = await webhook(refundEvent(event, refOf(id), { id: refund.id, amount: refund.amount, currency: refund.currency }));
    assert.equal(out.status, 200, "Paystack always gets 200");
  }

  test("QA repro (A5): P = ₦9,000, a manual ₦5,000 dashboard refund flags the row; its signed refund.processed changes nothing and the resolve still runs", async () => {
    await bookAndPay("c1", { fees: F });
    const manual = paystackRefund("c1", { amount: 500_000, status: "pending" });
    paystackHolds("c1", [manual]);
    // Every try looks up first, the first one too: flagged, nothing created.
    assert.equal((await setStatus(agent, "cancelled", "c1")).status, 200);
    let [row] = refundRows();
    assert.equal(row.refundFailureReason, "provider_refund_mismatch");
    assert.equal(harness.refundCalls.length, 0);
    const before = JSON.stringify(row);

    // Paystack finishes the manual refund and tells us.
    manual.status = "processed";
    await refundHook("refund.processed", manual);
    [row] = refundRows();
    assert.equal(JSON.stringify(row), before, "the flagged row is untouched");
    assert.equal(row.status, "failed");
    assert.equal(row.providerRefundId, undefined);
    assert.equal(bookingOf("c1")!.refundStatus, "failed");
    // Other events for it change nothing either.
    for (const event of ["refund.pending", "refund.failed"]) await refundHook(event, manual);
    assert.equal(JSON.stringify(refundRows()[0]), before);
    assert.equal(delayedNotices(), 1, "told once");

    // The resolve can still run (it was pre-empted before this fix).
    const { out, res } = captureRes();
    await consultationController.resolveRefundMismatch(
      reqFor(admin, { params: { id: "c1" }, body: { refundId: row.id, carriedBy: "agent" } }),
      res
    );
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.equal(refundRows().find((r) => r.id === row.id)!.amount, 500_000, "the row says what Paystack refunded");
  });

  test("QA repro (A6): the manual refund's webhook reaches a PENDING row with no id: flagged, never completed at the planned amount", async () => {
    await bookAndPay("c1", { fees: F });
    harness.refundBehaviour.push("network");
    await setStatus(agent, "cancelled", "c1");
    assert.equal(refundRows()[0].status, "pending");
    assert.equal(refundRows()[0].providerRefundId, undefined);

    const manual = paystackRefund("c1", { amount: 500_000 });
    paystackHolds("c1", [manual]);
    await refundHook("refund.processed", manual);
    const [row] = refundRows();
    assert.equal(row.status, "failed");
    assert.equal(row.refundFailureReason, "provider_refund_mismatch");
    assert.equal(row.providerRefundMismatch.id, "manual-1");
    assert.equal(row.providerRefundMismatch.amountMinor, 500_000);
    assert.equal(row.providerRefundId, undefined);
    assert.equal(row.amount, A, "the planned figure is left as it was");
    assert.equal(bookingOf("c1")!.refundStatus, "failed");
    assert.equal(delayedNotices(), 1);
    const listed = await listTransactions(admin, { role: "admin", type: "refund", status: "failed" });
    assert.deepEqual(listed.body.data.map((t: any) => t.id), [row.id]);
    // The engine's next run creates nothing while it is flagged.
    await runRetryJob();
    assert.equal(harness.refundCalls.length, 0);
  });

  test("after an admin retry clears the flag (Paystack unreachable for its lookup), the manual refund's webhook flags it again; nothing completes", async () => {
    await bookAndPay("c1", { fees: F });
    const manual = paystackRefund("c1", { amount: 500_000 });
    paystackHolds("c1", [manual]);
    await setStatus(agent, "cancelled", "c1");
    const flagged = refundRows()[0];
    assert.equal(flagged.refundFailureReason, "provider_refund_mismatch");
    // The retry's lookup fails: the row is left pending, with no id and no flag.
    harness.failNextRefundLookup = true;
    assert.equal((await adminRefund(admin, { refundId: flagged.id })).status, 200);
    assert.equal(refundRows()[0].status, "pending");
    assert.equal(refundRows()[0].refundFailureReason, undefined);
    assert.equal(harness.refundCalls.length, 0, "no create after a failed lookup");

    await refundHook("refund.processed", manual);
    const [row] = refundRows();
    assert.equal(row.status, "failed");
    assert.equal(row.refundFailureReason, "provider_refund_mismatch");
    assert.equal(row.providerRefundId, undefined);
    assert.equal(delayedNotices(), 1, "the same Paystack refund is not announced twice");
  });

  test("a webhook of EXACTLY the row's money still adopts on a row with no id (the lost-answer case)", async () => {
    await bookAndPay("c1", { fees: F });
    harness.refundBehaviour.push("reached_then_network");
    await setStatus(agent, "cancelled", "c1");
    const ours = harness.paystackRefunds.get(refOf("c1"))![0];
    assert.equal(refundRows()[0].providerRefundId, undefined);
    await refundHook("refund.processed", { ...ours, status: "processed" });
    const [row] = refundRows();
    assert.equal(row.status, "completed");
    assert.equal(row.providerRefundId, ours.id);
  });

  test("on a row with no id: another currency, a missing amount, no refund id, or a failed refund: nothing adopted", async () => {
    await bookAndPay("c1", { fees: F });
    harness.refundBehaviour.push("network");
    await setStatus(agent, "cancelled", "c1");
    const id = refundRows()[0].id;
    // A refund Paystack reports failed: not adopted, the row stays pending.
    assert.equal(
      await consultationRefundService.handleWebhook(refundEvent("refund.failed", refOf("c1"), { id: "x1", amount: A })),
      "unchanged"
    );
    // No refund id at all.
    assert.equal(
      await consultationRefundService.handleWebhook({ event: "refund.processed", data: { transaction_reference: refOf("c1"), amount: A, currency: "NGN", status: "processed" } }),
      "unchanged"
    );
    assert.equal(refundRows()[0].status, "pending");
    assert.equal(refundRows()[0].providerRefundId, undefined);
    // Another currency / no amount: flagged (a pending row), never adopted.
    assert.equal(
      await consultationRefundService.handleWebhook(refundEvent("refund.processed", refOf("c1"), { id: "x2", currency: "USD" })),
      "applied"
    );
    const row = refundRows().find((r) => r.id === id)!;
    assert.equal(row.refundFailureReason, "provider_refund_mismatch");
    assert.equal(row.providerRefundMismatch.currency, "USD");
    assert.equal(row.providerRefundId, undefined);
  });

  test("a webhook for a refund that is not exactly ours never moves a row that is already processing with its own id", async () => {
    await bookAndPay("c1", { fees: F });
    await setStatus(agent, "cancelled", "c1");
    const [row] = refundRows();
    assert.equal(row.status, "processing");
    await refundHook("refund.processed", paystackRefund("c1", { id: "manual-9", amount: 500_000 }));
    assert.equal(refundRows()[0].status, "processing");
    assert.equal(refundRows()[0].providerRefundId, row.providerRefundId);
  });
});

// ============================================
// Review round 1: the first try looks up before it creates (money leak)
// ============================================

describe("review round 1: the first try looks Paystack up before it creates a refund", () => {
  test("an earlier dashboard refund (X <= F) on a client-caused refund is never followed by a second refund to the client", async () => {
    await bookAndPay("c1", { fees: F });
    // A small manual refund someone made BEFORE the cancel.
    paystackHolds("c1", [paystackRefund("c1", { amount: F })]);
    assert.equal((await setStatus(client, "cancelled", "c1")).status, 200);
    const [row] = refundRows();
    assert.equal(harness.refundCalls.length, 0, "no second refund");
    assert.equal(harness.refundLookups.length, 1, "looked up on the first try");
    assert.equal(row.status, "failed");
    assert.equal(row.refundFailureReason, "provider_refund_mismatch");
  });

  test("an exact refund already at Paystack on the first try is adopted, not created again", async () => {
    await bookAndPay("c1", { fees: F });
    paystackHolds("c1", [paystackRefund("c1", { id: "77", status: "processing" })]);
    await setStatus(agent, "cancelled", "c1");
    const [row] = refundRows();
    assert.equal(row.providerRefundId, "77");
    assert.equal(harness.refundCalls.length, 0);
  });

  test("refused path still works: the first lookup sees nothing, Paystack refuses the create, the lookup after it flags a mismatch (no second create)", async () => {
    await bookAndPay("c1", { fees: F });
    const ps = paystackProvider as any;
    const real = ps.findRefundsForTransaction;
    let lookups = 0;
    // The manual refund lands between our first lookup and our create.
    ps.findRefundsForTransaction = async (reference: string) => (lookups++ === 0 ? [] : real(reference));
    try {
      paystackHolds("c1", [paystackRefund("c1", { currency: "USD", amount: 600 })]);
      harness.refundBehaviour.push("already_reversed");
      await setStatus(agent, "cancelled", "c1");
    } finally {
      ps.findRefundsForTransaction = real;
    }
    const [row] = refundRows();
    assert.equal(lookups, 2, "before the create, and after the refusal");
    assert.equal(row.refundFailureReason, "provider_refund_mismatch");
    assert.equal(row.providerRefundMismatch.currency, "USD");
    assert.equal(harness.refundCalls.length, 0);
  });

  test("a first-try lookup that fails creates nothing and leaves the row due again", async () => {
    await bookAndPay("c1", { fees: F });
    harness.failNextRefundLookup = true;
    await setStatus(agent, "cancelled", "c1");
    const [row] = refundRows();
    assert.equal(row.status, "pending");
    assert.equal(harness.refundCalls.length, 0);
    await runRetryJob();
    assert.equal(refundRows()[0].status, "processing");
    assert.equal(harness.refundCalls.length, 1);
  });
});

// ============================================
// Review round 1: a re-adopted id leaves previousProviderRefundIds
// ============================================

describe("review round 1: an attempt id the engine adopts again is current, and no longer an earlier attempt", () => {
  test("retired by a retry, found live again by the lookup: adopted; its webhooks move the row", async () => {
    await bookAndPay("c1", { fees: F });
    await setStatus(agent, "cancelled", "c1");
    const first = refundRows()[0];
    const id = first.providerRefundId;
    // Paystack says it failed; the admin retries (the id is retired) ...
    await webhook(refundEvent("refund.failed", refOf("c1"), { id }));
    const live = harness.paystackRefunds.get(refOf("c1"))![0];
    live.status = "failed";
    harness.failNextRefundLookup = true;
    await adminRefund(admin, { refundId: first.id });
    assert.deepEqual(refundRows()[0].previousProviderRefundIds, [id]);
    // ... and Paystack later reports the SAME refund live again.
    live.status = "processing";
    await runRetryJob();
    const row = refundRows()[0];
    assert.equal(row.providerRefundId, id);
    assert.deepEqual(row.previousProviderRefundIds ?? [], [], "no longer listed as an earlier attempt");
    await webhook(refundEvent("refund.processed", refOf("c1"), { id }));
    assert.equal(refundRows()[0].status, "completed");
  });
});

// ============================================
// Review round 1: small fixes (closed copy, bad dates)
// ============================================

describe("review round 1: a closed refund never reads 'held'; a bad date filter is a 400", () => {
  test("the client's view of a closed refund says nothing to refund", () => {
    const view = toClientTransaction({
      id: "r", userId: client.uid, type: "refund", amount: 0, currency: "NGN", status: "closed", isEscrow: false,
      paymentProvider: "paystack", description: "Refund: consultation fee (held: Paystack's fee needed)",
      createdAt: T0, updatedAt: T0,
    } as unknown as Transaction);
    assert.equal(view.description, "Refund: consultation fee (nothing to refund)");
  });

  test("GET /transactions?role=admin&startDate=not-a-date (or endDate) is 400 VALIDATION_ERROR, never 500", async () => {
    for (const query of [{ startDate: "not-a-date" }, { endDate: "nope" }, { startDate: "" }]) {
      const out = await listTransactions(admin, { role: "admin", ...query });
      assert.equal(out.status, 400, JSON.stringify(query));
      assert.equal(out.body.error, "VALIDATION_ERROR");
    }
    const agentOut = await listTransactions(agent, { startDate: "not-a-date" });
    assert.equal(agentOut.status, 400);
    assert.equal((await listTransactions(admin, { role: "admin", startDate: "2026-11-01" })).status, 200);
  });
});

// ============================================
// B. Admin close of a held client-caused refund where Paystack's fee >= the charge
// ============================================

describe("B: an admin closes a held client-cancel refund (fee >= charge) as nothing_to_refund", () => {
  /** A paid booking whose Paystack fee is the whole charge, cancelled by the client 24 h+ ahead: HELD. */
  async function heldFeeNotLess(): Promise<Record<string, any>> {
    await bookAndPay("c1", { fees: A });
    assert.equal((await setStatus(client, "cancelled", "c1")).status, 200);
    const [row] = refundRows();
    assert.equal(row.refundHeldReason, "fee_not_less_than_amount");
    assert.equal(feeOf("c1")!.feeHoldFrozenByRefundId, row.id);
    return row;
  }

  test("the booking mirrors the held reason, so it does not read as a plain failed refund", async () => {
    await heldFeeNotLess();
    assert.equal(bookingOf("c1")!.refundStatus, "failed");
    assert.equal(bookingOf("c1")!.refundHeldReason, "fee_not_less_than_amount");
  });

  test("closing: no Paystack call, no money; the row is closed and leaves the failed list; the fee unfreezes; nobody gets anything", async () => {
    const held = await heldFeeNotLess();
    const before = { client: 0, agent: await agentTotal(), admin: adminStats() };
    assert.equal(before.agent, 0, "the agent was credited nothing for this fee");
    assert.equal(before.admin.totalRevenue, 0, "Seli's total for the booking is 0");
    const callsBefore = { refunds: harness.refundCalls.length, lookups: harness.refundLookups.length };

    const out = await closeHeld(admin);
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.equal(out.body.data.closed, true);
    assert.equal(out.body.data.alreadyClosed, false);

    const [row] = refundRows();
    assert.equal(row.id, held.id);
    assert.equal(row.status, "closed");
    assert.equal(row.amount, 0, "still 0");
    assert.equal(row.refundClosedOutcome, "nothing_to_refund");
    // Review round 1: no longer reads "held" once closed.
    assert.equal(row.description, "Refund: consultation fee (nothing to refund)");
    assert.equal(row.refundClosedBy, admin.uid);
    assert.ok(row.refundClosedAt instanceof Timestamp);
    const fee = feeOf("c1")!;
    assert.equal(fee.feeHoldFrozenByRefundId, undefined);
    assert.equal(fee.feeHoldFrozenAt, undefined);
    assert.equal(debitRows().length, 0, "no fee debit");
    assert.deepEqual(
      { refunds: harness.refundCalls.length, lookups: harness.refundLookups.length },
      callsBefore,
      "no Paystack call"
    );
    const booking = bookingOf("c1")!;
    assert.equal(booking.refundStatus, "closed", "the booking shows the closed outcome, not failed");
    assert.equal(booking.refundHeldReason, undefined);
    const failed = await listTransactions(admin, { role: "admin", type: "refund", status: "failed" });
    assert.deepEqual(failed.body.data, [], "left the admin held/failed list");

    // The three figures after: client 0, agent 0 (available + held), admin revenue 0.
    const refunded = refundRows().filter((r) => r.status === "completed").reduce((sum, r) => sum + r.amount, 0);
    assert.equal(refunded, before.client);
    assert.equal(await agentTotal(), 0);
    // ... and still 0 once the hold would have released by the clock.
    harness.clock.advanceHours(24 * 10);
    assert.equal(await agentTotal(), 0);
    const after = adminStats();
    assert.equal(after.totalRevenue, 0);
    assert.equal(after.grossRevenue, A, "gross is the charge; Paystack kept all of it");
    assert.equal(after.paystackFees, A);

    // The client reads it as nothing due, never as a failed refund of ₦0.00.
    const clientView = toClientTransaction(row as Transaction);
    assert.equal(clientView.refundState, "none_due");
  });

  test("idempotent: a repeat, or two admins at once, write nothing more (200 already_closed)", async () => {
    await heldFeeNotLess();
    const [one, two] = await Promise.all([closeHeld(admin), closeHeld(admin)]);
    assert.deepEqual([one.status, two.status], [200, 200]);
    assert.deepEqual([one.body.data.alreadyClosed, two.body.data.alreadyClosed].sort(), [false, true]);
    const closedAt = refundRows()[0].refundClosedAt.toMillis();
    harness.clock.advanceHours(1);
    const again = await closeHeld(admin);
    assert.equal(again.status, 200);
    assert.equal(again.body.data.alreadyClosed, true);
    assert.equal(refundRows()[0].refundClosedAt.toMillis(), closedAt, "nothing rewritten");
  });

  test("a closed refund is final: an admin refund or a retry by id answers 409 REFUND_CLOSED", async () => {
    const held = await heldFeeNotLess();
    await closeHeld(admin);
    for (const body of [{ refundId: held.id }, { reason: "goodwill", feeBorneBy: "agent" }]) {
      const out = await adminRefund(admin, body);
      assert.equal(out.status, 409, JSON.stringify(out.body));
      assert.equal(out.body.error, "REFUND_CLOSED");
    }
    assert.equal(refundRows()[0].status, "closed");
    assert.equal(harness.refundCalls.length, 0);
  });

  test("not closable (409 NOT_CLOSABLE with the reason): agent-caused, held for another reason, fee no longer >= charge", async () => {
    // Held because Paystack's fee is unknown.
    await bookAndPay("c1", { fees: undefined });
    await setStatus(client, "cancelled", "c1");
    let out = await closeHeld(admin);
    assert.equal(out.status, 409);
    assert.equal(out.body.error, "NOT_CLOSABLE");
    assert.equal(out.body.data.reason, "not_held_fee_not_less_than_amount");

    // Held for the right reason, but the stored fee is now below the charge.
    harness.reset();
    const held = await heldFeeNotLess();
    patchDoc("transactions", feeOf("c1")!.id, { paystackFeeStatus: "known", paystackFeeMinor: F, agentCreditMinor: A - F });
    out = await closeHeld(admin);
    assert.equal(out.status, 409);
    assert.equal(out.body.data.reason, "fee_less_than_amount");

    // Agent-caused (the agent carries the fee: the client is owed A in full).
    patchDoc("transactions", feeOf("c1")!.id, { paystackFeeStatus: "fee_not_less_than_amount", paystackFeeMinor: A });
    patchDoc("transactions", held.id, { feeBorneBy: "agent" });
    out = await closeHeld(admin);
    assert.equal(out.status, 409);
    assert.equal(out.body.data.reason, "agent_caused");
    assert.equal(refundRows()[0].status, "failed", "nothing written by a refusal");
    assert.equal(feeOf("c1")!.feeHoldFrozenByRefundId, held.id, "still frozen");
  });

  test("authz: agent, owner and client get 403 before anything is read; unknown booking or no refund row: 404", async () => {
    await heldFeeNotLess();
    for (const p of [agent, ownerA, client]) {
      const out = await closeHeld(p);
      assert.equal(out.status, 403, String(p.role));
    }
    assert.equal(refundRows()[0].status, "failed");
    assert.equal((await closeHeld(admin, "nope")).status, 404);
    await bookAndPay("c2");
    assert.equal((await closeHeld(admin, "c2")).status, 404, "paid, but no refund row");
  });

  test("route: POST /consultations/:id/refund/close is registered behind verifyAuth (401 without a token)", () => {
    const layer = (consultationRoutes as any).stack.find((l: any) => l.route?.path === "/:id/refund/close");
    assert.ok(layer, "route registered");
    assert.equal(layer.route.methods.post, true);
    const names = layer.route.stack.map((s: any) => s.name);
    assert.equal(names[0], "verifyAuth", "the token check runs first");
  });
});

// ============================================
// D. Fee lookup job: oldest first, permanently unknown rows set aside
// ============================================

describe("D: the fee lookup job goes oldest first and sets permanently unknown rows aside", () => {
  test("with more than a batch of permanently unknown rows, a newer row is still resolved within N + 1 runs", async () => {
    paystackFeeJobConfig.batchSize = 3;
    paystackFeeJobConfig.maxJobLookups = 2;
    // Four rows Paystack never gives a fee for, then a newer one it will.
    for (const id of ["c1", "c2", "c3", "c4", "c5"]) {
      await bookAndPay(id, { fees: undefined });
      harness.clock.advanceHours(0.1);
    }
    paystackNowReports("c5", F);
    const N = paystackFeeJobConfig.maxJobLookups;
    let runs = 0;
    while (feeOf("c5")!.paystackFeeStatus !== "known" && runs < N + 1) {
      await paystackFeeService.resolveUnknownFees();
      runs++;
    }
    assert.equal(feeOf("c5")!.paystackFeeStatus, "known", `resolved within ${N + 1} runs`);
    assert.equal(runs, N + 1, "it waited behind the older rows exactly until they were set aside");
    for (const id of ["c1", "c2", "c3"]) {
      assert.equal(feeOf(id)!.paystackFeeStatus, "set_aside", id);
      assert.equal(feeOf(id)!.paystackFeeLookupAttempts, N);
    }
    assert.equal(feeOf("c4")!.paystackFeeStatus, "unknown", "c4 had one lookup so far");
  });

  test("a set-aside row counts exactly as unknown, is listed for admins, and the admin refresh still resolves it", async () => {
    paystackFeeJobConfig.maxJobLookups = 1;
    await bookAndPay("c1", { fees: undefined });
    const unknownBalance = await balanceOf(agent);
    const unknownStats = adminStats();
    const run = await paystackFeeService.resolveUnknownFees();
    assert.equal(run.setAside, 1);
    assert.equal(feeOf("c1")!.paystackFeeStatus, "set_aside");
    assert.deepEqual(await balanceOf(agent), unknownBalance, "credited nowhere, as unknown");
    assert.deepEqual(adminStats(), unknownStats, "admin figures as unknown");
    // The job no longer picks it.
    assert.equal((await paystackFeeService.resolveUnknownFees()).scanned, 0);
    // Listed for admins.
    const listed = await listTransactions(admin, { role: "admin", type: "consultation_fee", paystackFeeStatus: "set_aside" });
    assert.equal(listed.status, 200);
    assert.deepEqual(listed.body.data.map((t: any) => t.id), [feeOf("c1")!.id]);
    // The manual refresh resolves it.
    paystackNowReports("c1", F);
    const { out, res } = captureRes();
    await transactionController.refreshPaystackFee(reqFor(admin, { params: { id: feeOf("c1")!.id } }), res);
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.equal(feeOf("c1")!.paystackFeeStatus, "known");
    assert.equal((await balanceOf(agent)).heldBalance, A - F);
  });

  test("a Paystack outage does not count toward setting a row aside", async () => {
    paystackFeeJobConfig.maxJobLookups = 1;
    await bookAndPay("c1", { fees: undefined });
    harness.failNextLookup = true;
    await paystackFeeService.resolveUnknownFees();
    assert.equal(feeOf("c1")!.paystackFeeStatus, "unknown");
    assert.equal(feeOf("c1")!.paystackFeeLookupAttempts, undefined);
  });

  test("a set-aside fee is still resolved by a refund's own lookup (the cancel reads Paystack, as for unknown)", async () => {
    paystackFeeJobConfig.maxJobLookups = 1;
    await bookAndPay("c1", { fees: undefined });
    await paystackFeeService.resolveUnknownFees();
    paystackNowReports("c1", F);
    await setStatus(client, "cancelled", "c1");
    const [row] = refundRows();
    assert.equal(row.refundHeldReason, undefined, "not held: the fee was found");
    assert.equal(row.amount, A - F);
    assert.equal(feeOf("c1")!.paystackFeeStatus, "known");
  });
});

// ============================================
// F. The shortfall counts the fee debit
// ============================================

describe("F: balanceShortfallMinor covers the reversal AND the fee debit of the same commit", () => {
  test("refundShortfall: X >= R + D gives 0; R <= X < R + D gives the debit's part; X <= 0 gives everything", () => {
    assert.equal(refundShortfall({ availableMinor: 100, reversalMinor: 60, debitMinor: 40 }), 0);
    assert.equal(refundShortfall({ availableMinor: 70, reversalMinor: 60, debitMinor: 40 }), 30);
    assert.equal(refundShortfall({ availableMinor: 0, reversalMinor: 60, debitMinor: 40 }), 100);
    assert.equal(refundShortfall({ availableMinor: -25, reversalMinor: 60, debitMinor: 40 }), 100);
    // No debit written: as before.
    assert.equal(refundShortfall({ availableMinor: 50, reversalMinor: 60, debitMinor: 0 }), 10);
  });

  test("an agent cancel out of the hold with X < F available records the debit's shortfall on the row", async () => {
    await bookAndPay("c1", { fees: F });
    await seedEarned("earned1", 5_000);
    await setStatus(agent, "cancelled", "c1");
    const [row] = refundRows();
    assert.equal(row.refundFundedFrom, "hold");
    assert.equal(debitRows().length, 1);
    assert.equal(row.balanceShortfallMinor, F - 5_000, "the debit takes available 5,000 below zero by F - 5,000");
    assert.equal((await balanceOf(agent)).availableBalance, 5_000 - F);
  });

  test("with enough available, the same cancel has no shortfall", async () => {
    await bookAndPay("c1", { fees: F });
    await seedEarned("earned1", 100_000);
    await setStatus(agent, "cancelled", "c1");
    assert.equal(refundRows()[0].balanceShortfallMinor, 0);
  });
});

// ============================================
// G. adminRefund answers 409 before calling Paystack
// ============================================

describe("G: an admin refund of a booking that already has a live refund is 409 before any Paystack call", () => {
  test("existing refund + Paystack down: 409 ALREADY_REFUNDED, and no Paystack call is made", async () => {
    await bookAndPay("c1", { fees: F });
    await setStatus(agent, "cancelled", "c1");
    assert.equal(refundRows()[0].status, "processing");
    // The fee row now has no stored fee (so a lookup would be needed), and Paystack is down.
    patchDoc("transactions", feeOf("c1")!.id, { paystackFeeStatus: "unknown", paystackFeeMinor: undefined });
    let lookups = 0;
    harness.onLookup = async () => {
      lookups++;
      throw new Error("PAYSTACK_ERROR: connect ETIMEDOUT");
    };
    const before = { refunds: harness.refundCalls.length, refundLookups: harness.refundLookups.length };
    const out = await adminRefund(admin, { reason: "goodwill", feeBorneBy: "agent" });
    assert.equal(out.status, 409, JSON.stringify(out.body));
    assert.equal(out.body.error, "ALREADY_REFUNDED");
    assert.equal(lookups, 0, "no fee lookup");
    assert.deepEqual({ refunds: harness.refundCalls.length, refundLookups: harness.refundLookups.length }, before);
  });

  test("the transaction still re-checks: a row written between the pre-read and the write is refused", async () => {
    await bookAndPay("c1", { fees: F });
    // Two admins at once: exactly one refund row, the other refused.
    const [one, two] = await Promise.all([
      adminRefund(admin, { reason: "goodwill", feeBorneBy: "agent" }),
      adminRefund(admin, { reason: "goodwill", feeBorneBy: "agent" }),
    ]);
    assert.deepEqual([one.status, two.status].sort(), [201, 409]);
    assert.equal(refundRows().length, 1);
    assert.equal(debitRows().length, 1, "one debit");
  });
});

// ============================================
// I. Admin gross revenue
// ============================================

describe("I: admin gross counts every settled consultation fee at its charge A", () => {
  test("one row of each kind: known fee, older full-credit row, unknown fee", () => {
    const base = { userId: "u", agentId: "a", status: "completed", isEscrow: false, paymentProvider: "paystack", currency: "NGN", description: "x", createdAt: T0, updatedAt: T0 };
    const rows = [
      { ...base, id: "known", type: "consultation_fee", amount: 100_000, paystackFeeStatus: "known", paystackFeeMinor: 2_000, agentCreditMinor: 98_000 },
      { ...base, id: "legacy", type: "consultation_fee", amount: 50_000 },
      { ...base, id: "unknown", type: "consultation_fee", amount: 30_000, paystackFeeStatus: "unknown" },
      { ...base, id: "aside", type: "consultation_fee", amount: 7_000, paystackFeeStatus: "set_aside" },
    ] as unknown as Transaction[];
    const s = transactionService.computeStats(rows, harness.clock.now(), { feeBreakdown: true }).byCurrency[0];
    assert.equal(s.totalRevenue, 98_000 + 50_000, "net: known credit + legacy full credit");
    assert.equal(s.paystackFees, 2_000);
    assert.equal(s.unknownFeeAmount, 30_000 + 7_000);
    assert.equal(s.grossRevenue, 100_000 + 50_000 + 30_000 + 7_000, "every charge A");
    assert.equal(s.grossRevenue, s.totalRevenue + s.paystackFees! + s.unknownFeeAmount!);
  });
});

// ============================================
// J. No A - 2F revenue lag
// ============================================

describe("J: an agent-caused refund out of the hold reads -F for the agent and the admin at every status", () => {
  test("pending, processing, completed: the fee once, never 2F", async () => {
    await bookAndPay("c1", { fees: F });
    // The first create gets no answer: the row stays pending.
    harness.refundBehaviour.push("network");
    await setStatus(agent, "cancelled", "c1");
    const id = refundRows()[0].id;
    for (const status of ["pending", "processing", "completed"] as const) {
      if (status !== "pending") await consultationRefundService.advanceRefundStatus(id, status);
      assert.equal(refundRows()[0].status, status);
      assert.equal((await balanceOf(agent)).totalRevenue, -F, `agent at ${status}`);
      assert.equal(adminStats().totalRevenue, -F, `admin at ${status}`);
    }
  });

  test("a failed refund awaiting an admin retry still counts (the money is still owed back)", async () => {
    await bookAndPay("c1", { fees: F });
    for (let i = 0; i < MAX_REFUND_ATTEMPTS; i++) harness.refundBehaviour.push("network");
    await setStatus(agent, "cancelled", "c1");
    for (let i = 1; i < MAX_REFUND_ATTEMPTS; i++) await runRetryJob();
    assert.equal(refundRows()[0].status, "failed");
    assert.equal((await balanceOf(agent)).totalRevenue, -F);
  });
});

// ============================================
// K. One agentReversalOf
// ============================================

describe("K: one agentReversalOf", () => {
  test("transaction.service re-exports the money/totals rule (the same function)", () => {
    assert.equal(reversalFromService, reversalFromTotals);
    assert.equal(reversalFromTotals({ amount: 10, agentReversalMinor: 7 }), 7);
    assert.equal(reversalFromTotals({ amount: 10 }), 10);
    assert.equal(reversalFromTotals({ amount: 10, agentReversalMinor: 1.5 }), 10, "not a safe integer: amount");
  });
});

// ============================================
// Portal design additions (#357)
// ============================================

describe("portal additions: retry any failed refund by id, the agent's processingFee, the held mirror", () => {
  test("retry by id of a booking's failed cancel refund: same row, stored reason and feeBorneBy, idempotent", async () => {
    await bookAndPay("c1", { fees: F });
    for (let i = 0; i < MAX_REFUND_ATTEMPTS; i++) harness.refundBehaviour.push("network");
    await setStatus(client, "cancelled", "c1");
    for (let i = 1; i < MAX_REFUND_ATTEMPTS; i++) await runRetryJob();
    const failed = refundRows()[0];
    assert.equal(failed.status, "failed");
    const out = await adminRefund(admin, { refundId: failed.id });
    assert.equal(out.status, 200, JSON.stringify(out.body));
    const [row] = refundRows();
    assert.equal(row.id, failed.id);
    assert.equal(row.reason, "client_cancelled");
    assert.equal(row.feeBorneBy, "client");
    assert.equal(row.amount, A - F);
    assert.equal(row.status, "processing");
    // A repeat: no longer failed, nothing to retry.
    const again = await adminRefund(admin, { refundId: failed.id });
    assert.equal(again.status, 409);
    assert.equal(again.body.error, "ALREADY_REFUNDED");
    assert.equal(harness.refundCalls.length, 1);
  });

  test("retry by id of a HELD refund re-reads the fee first; the booking's held mirror goes when it is worked out", async () => {
    await bookAndPay("c1", { fees: undefined });
    await setStatus(agent, "cancelled", "c1");
    const held = refundRows()[0];
    assert.equal(held.refundHeldReason, "paystack_fee_unknown");
    assert.equal(bookingOf("c1")!.refundHeldReason, "paystack_fee_unknown");
    // Still unknown: 409, nothing written.
    let out = await adminRefund(admin, { refundId: held.id });
    assert.equal(out.status, 409);
    assert.equal(out.body.error, "PAYSTACK_FEE_UNKNOWN");
    // Paystack down: 502.
    harness.failNextLookup = true;
    out = await adminRefund(admin, { refundId: held.id });
    assert.equal(out.status, 502);
    // Known now: worked out under the stored reason (agent-caused: A, one debit).
    paystackNowReports("c1", F);
    out = await adminRefund(admin, { refundId: held.id });
    assert.equal(out.status, 200, JSON.stringify(out.body));
    const [row] = refundRows();
    assert.equal(row.reason, "agent_cancelled");
    assert.equal(row.amount, A);
    assert.equal(row.refundHeldReason, undefined);
    assert.equal(debitRows().length, 1);
    assert.equal(bookingOf("c1")!.refundHeldReason, undefined, "the mirror is cleared");
    assert.equal(bookingOf("c1")!.refundStatus, "processing");
  });

  test("retry by id: non-admins 403; a refund of another booking 404", async () => {
    await bookAndPay("c1", { fees: undefined });
    await setStatus(agent, "cancelled", "c1");
    const held = refundRows()[0];
    for (const p of [agent, ownerA, client]) assert.equal((await adminRefund(p, { refundId: held.id })).status, 403);
    await bookAndPay("c2");
    assert.equal((await adminRefund(admin, { refundId: held.id }, "c2")).status, 404);
  });

  test("the agent's booking view names Paystack's processing fee when it is stored, null otherwise; the client's never", async () => {
    await bookAndPay("c1", { fees: F });
    await bookAndPay("c2", { fees: undefined });
    let out = await getBooking(agent, "c1");
    assert.equal(out.status, 200);
    assert.deepEqual(out.body.data.processingFee, { amountMinor: F, currency: "NGN" });
    out = await getBooking(agent, "c2");
    assert.equal(out.body.data.processingFee, null, "not stored: never looked up on a read, never estimated");
    out = await getBooking(admin, "c1");
    assert.deepEqual(out.body.data.processingFee, { amountMinor: F, currency: "NGN" });
    out = await getBooking(client, "c1");
    assert.equal("processingFee" in out.body.data, false, "not on the client view (its refund preview says it)");
  });
});
