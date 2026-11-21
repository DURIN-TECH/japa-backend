// ============================================
// Unit tests: refund edge cases left from #317 (issue #383)
// ============================================
//
// Hermetic (test/consultations/harness.ts): in-memory Firestore, Paystack
// stubbed (refund create / list are recorders, webhooks are signed with a
// dummy test key), a fixed clock the tests move. Nothing reaches the network.
//
//  1. Late `refund.failed`: every Paystack refund the engine creates or
//     adopts is the row's CURRENT attempt (`providerRefundId`); earlier ids
//     are kept (`previousProviderRefundIds`). A webhook that is not about the
//     current attempt changes nothing.
//  2. Clock skew at release: a refund is funded from the hold only when the
//     fee is CLEARLY held: the transaction's clock is more than
//     RELEASE_SKEW_MARGIN_MS before `releaseAt`, and the agent's last
//     withdrawal is not at or after that point. Otherwise it is planned from
//     the available balance, exactly as a released fee (the agent carries it).

import { test, describe, before, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { Timestamp } from "firebase-admin/firestore";

import { useHarness, harness, docsIn, seed, T0 } from "./harness";
import {
  admin, adminRefund, agent, balanceOf, bookAndPay, bookingOf, client, feeOf, refOf, refundRows, seedEarned,
  setStatus, withdraw, webhook, refundEvent, TEST_PAYSTACK_SECRET,
} from "./refund-fixtures";
import { notificationService } from "../../src/services/notification.service";
import {
  consultationRefundService, isCurrentAttempt, MAX_REFUND_ATTEMPTS,
} from "../../src/services/consultation-refund.service";
import { refundFundableFromHold, RELEASE_SKEW_MARGIN_MS } from "../../src/money/fee-hold";
import { transactionService } from "../../src/services/transaction.service";
import { toTransactionLookup } from "../../src/services/billing/paystack.provider";

/* eslint-disable @typescript-eslint/no-explicit-any */

// ============================================
// Setup
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

/** A: ₦9,000.00 in kobo; F: Paystack's fee, ₦150.00. */
const A = 900_000;
const F = 15_000;

/**
 * The fee's release time for every booking here: the slot (2026-11-20
 * 09:00Z, 30 minutes) ends 09:30Z, plus 24 hours.
 */
const RELEASE_AT_MS = new Date("2026-11-21T09:30:00Z").getTime();

/** Move the harness clock (the refund transaction's clock) to `ms`. */
function clockTo(ms: number): void {
  harness.clock.advanceHours((ms - harness.clock.now().getTime()) / 3_600_000);
}

/** The "refund delayed" notices the client got. */
function delayedNotices(): number {
  return notified.filter((n) => n.userId === client.uid && n.type === "consultation_refund_delayed").length;
}

/** A refund webhook for booking `id`'s charge, naming Paystack refund `refundId`. */
function eventFor(event: string, refundId: string, id = "c1") {
  return refundEvent(event, refOf(id), { id: refundId });
}

// ============================================
// 1. Late refund.failed
// ============================================

describe("late refund.failed: only the row's current attempt moves it", () => {
  test("attempt 1 fails, the admin retry creates attempt 2; a late refund.failed for attempt 1 changes nothing; attempt 2's processed completes it", async () => {
    await bookAndPay("c1", { fees: F });
    await setStatus(agent, "cancelled", "c1");
    let [row] = refundRows();
    assert.equal(row.providerRefundId, "1", "attempt 1");
    // Attempt 1 fails at Paystack: the row fails, the client is told once.
    assert.equal((await webhook(eventFor("refund.failed", "1"))).status, 200);
    assert.equal(refundRows()[0].status, "failed");
    assert.equal(delayedNotices(), 1);
    harness.paystackRefunds.get(refOf("c1"))![0].status = "failed";

    // The admin retries: attempt 2, on the same row.
    const out = await adminRefund(admin, { refundId: row.id });
    assert.equal(out.status, 200, JSON.stringify(out.body));
    [row] = refundRows();
    assert.equal(row.status, "processing");
    assert.equal(row.providerRefundId, "2", "the current attempt is attempt 2");
    assert.deepEqual(row.previousProviderRefundIds, ["1"], "attempt 1 is kept");
    assert.equal(bookingOf("c1")!.refundStatus, "processing");

    // A late (repeated) refund.failed for attempt 1.
    assert.equal((await webhook(eventFor("refund.failed", "1"))).status, 200);
    assert.equal(refundRows()[0].status, "processing", "stays processing");
    assert.equal(bookingOf("c1")!.refundStatus, "processing");
    assert.equal(delayedNotices(), 1, "no second delayed notice");
    // An event naming attempt 1 by id only (no reference) is found and ignored too.
    assert.equal(
      await consultationRefundService.handleWebhook({ event: "refund.failed", data: { id: "1", status: "failed" } }),
      "unchanged"
    );

    // Attempt 2 is processed.
    await webhook(eventFor("refund.processed", "2"));
    assert.equal(refundRows()[0].status, "completed");
    assert.equal(bookingOf("c1")!.refundStatus, "completed");
    assert.equal(harness.refundCalls.length, 2, "two attempts in all, never a third");
  });

  test("a refund.failed for the CURRENT attempt still fails the row and notifies once", async () => {
    await bookAndPay("c1", { fees: F });
    await setStatus(agent, "cancelled", "c1");
    await webhook(eventFor("refund.failed", "1"));
    await webhook(eventFor("refund.failed", "1"));
    assert.equal(refundRows()[0].status, "failed");
    assert.equal(bookingOf("c1")!.refundStatus, "failed");
    assert.equal(delayedNotices(), 1);
  });

  test("an event for a refund id that is not the current attempt changes nothing", async () => {
    await bookAndPay("c1", { fees: F });
    await setStatus(agent, "cancelled", "c1");
    assert.equal(
      await consultationRefundService.handleWebhook(eventFor("refund.processed", "999")),
      "unchanged"
    );
    assert.equal(refundRows()[0].status, "processing");
  });

  test("a row with no Paystack id yet takes an event of exactly its money (and stores its id)", async () => {
    await bookAndPay("c1", { fees: F });
    harness.refundBehaviour.push("network");
    await setStatus(agent, "cancelled", "c1");
    assert.equal(refundRows()[0].providerRefundId, undefined);
    assert.equal(await consultationRefundService.handleWebhook(eventFor("refund.processing", "55")), "applied");
    const [row] = refundRows();
    assert.equal(row.status, "processing");
    assert.equal(row.providerRefundId, "55");
  });

  test("the engine's newer attempt replaces the current id and keeps the older one", async () => {
    await bookAndPay("c1", { fees: F });
    await setStatus(agent, "cancelled", "c1");
    const id = refundRows()[0].id;
    await consultationRefundService.advanceRefundStatus(id, "processing", { providerRefundId: "7", source: "engine" });
    const [row] = refundRows();
    assert.equal(row.providerRefundId, "7");
    assert.deepEqual(row.previousProviderRefundIds, ["1"]);
  });

  test("isCurrentAttempt: earlier ids never; the current id only; no id yet: any id", () => {
    assert.equal(isCurrentAttempt({ providerRefundId: "2", previousProviderRefundIds: ["1"] }, "1"), false);
    assert.equal(isCurrentAttempt({ providerRefundId: "2", previousProviderRefundIds: ["1"] }, "2"), true);
    assert.equal(isCurrentAttempt({ providerRefundId: "2" }, "3"), false);
    assert.equal(isCurrentAttempt({ providerRefundId: "2" }, undefined), false);
    assert.equal(isCurrentAttempt({}, "9"), true);
    assert.equal(isCurrentAttempt({ previousProviderRefundIds: ["1"] }, "1"), false, "retired, then late");
  });

  test("concurrency: a late failed for attempt 1 and attempt 2's processed at once always end completed", async () => {
    await bookAndPay("c1", { fees: F });
    await setStatus(agent, "cancelled", "c1");
    await webhook(eventFor("refund.failed", "1"));
    harness.paystackRefunds.get(refOf("c1"))![0].status = "failed";
    await adminRefund(admin, { refundId: refundRows()[0].id });
    notified.length = 0;
    await Promise.all([webhook(eventFor("refund.failed", "1")), webhook(eventFor("refund.processed", "2"))]);
    assert.equal(refundRows()[0].status, "completed");
    assert.equal(delayedNotices(), 0);
  });

  test("concurrency: an admin retry racing a late failed for the retired attempt: attempt 2 is never failed by it", async () => {
    await bookAndPay("c1", { fees: F });
    for (let i = 0; i < MAX_REFUND_ATTEMPTS; i++) harness.refundBehaviour.push("network");
    await setStatus(agent, "cancelled", "c1");
    // Give the row a failed attempt 1 by hand-off: Paystack's create answered, then failed.
    const id = refundRows()[0].id;
    harness.refundBehaviour.length = 0;
    await consultationRefundService.advanceRefundStatus(id, "processing", { providerRefundId: "1", source: "engine" });
    harness.paystackRefunds.set(refOf("c1"), [{ id: "1", status: "failed", transactionReference: refOf("c1"), amount: A, currency: "NGN" }]);
    // The stub numbers Paystack's refunds; "1" is taken by the one above.
    harness.refundCounter = 1;
    await webhook(eventFor("refund.failed", "1"));
    assert.equal(refundRows()[0].status, "failed");
    await Promise.all([adminRefund(admin, { refundId: id }), webhook(eventFor("refund.failed", "1"))]);
    const [row] = refundRows();
    assert.equal(row.status, "processing", "attempt 2 on its way");
    assert.notEqual(row.providerRefundId, "1");
  });
});

// ============================================
// 2. Clock skew at release
// ============================================

describe("clock skew at release: from the hold only when the fee is clearly held", () => {
  test("refundFundableFromHold: well before, inside the margin, at release, after a late withdrawal, frozen early", () => {
    const fee = {
      feeHold: {
        state: "held" as const,
        slotStartAt: Timestamp.fromMillis(RELEASE_AT_MS - 25 * 3_600_000),
        releaseAt: Timestamp.fromMillis(RELEASE_AT_MS),
      },
    };
    const before = new Date(RELEASE_AT_MS - RELEASE_SKEW_MARGIN_MS - 1);
    assert.equal(refundFundableFromHold(fee, new Date(RELEASE_AT_MS - 3_600_000), null), true);
    assert.equal(refundFundableFromHold(fee, before, null), true, "just outside the margin");
    assert.equal(refundFundableFromHold(fee, new Date(RELEASE_AT_MS - RELEASE_SKEW_MARGIN_MS), null), false, "at the margin");
    assert.equal(refundFundableFromHold(fee, new Date(RELEASE_AT_MS - 1), null), false, "1 ms before release");
    assert.equal(refundFundableFromHold(fee, new Date(RELEASE_AT_MS), null), false, "released");
    assert.equal(
      refundFundableFromHold(fee, before, new Date(RELEASE_AT_MS - RELEASE_SKEW_MARGIN_MS)),
      false,
      "a withdrawal at the margin"
    );
    assert.equal(refundFundableFromHold(fee, before, new Date(RELEASE_AT_MS - 3_600_000)), true, "an older withdrawal");
    // Frozen (a held refund) since well before the margin: held ever since.
    const frozen = { ...fee, feeHoldFrozenByRefundId: "r", feeHoldFrozenAt: Timestamp.fromMillis(RELEASE_AT_MS - 3_600_000) };
    assert.equal(refundFundableFromHold(frozen, new Date(RELEASE_AT_MS + 3_600_000), null), true);
    // Frozen only inside the margin: not clearly held.
    const late = { ...fee, feeHoldFrozenByRefundId: "r", feeHoldFrozenAt: Timestamp.fromMillis(RELEASE_AT_MS - 1_000) };
    assert.equal(refundFundableFromHold(late, new Date(RELEASE_AT_MS + 3_600_000), null), false);
    // Review round 1 (from #382 QA): frozen early, but the agent's last
    // withdrawal is at or after the cutoff (a clock running ahead, maybe
    // before the freeze): never from the hold. An older withdrawal: still the hold.
    for (const frozenFee of [
      frozen,
      { ...fee, feeHoldFrozenByReportId: "rep", feeHoldFrozenByReportAt: Timestamp.fromMillis(RELEASE_AT_MS - 3_600_000) },
    ]) {
      assert.equal(refundFundableFromHold(frozenFee, before, new Date(RELEASE_AT_MS - RELEASE_SKEW_MARGIN_MS)), false);
      assert.equal(refundFundableFromHold(frozenFee, new Date(RELEASE_AT_MS + 3_600_000), new Date(RELEASE_AT_MS + 60_000)), false);
      assert.equal(refundFundableFromHold(frozenFee, new Date(RELEASE_AT_MS + 3_600_000), new Date(RELEASE_AT_MS - 3_600_000)), true);
    }
  });

  test("review round 1: lastWithdrawalAt keeps the LATER time (a slow instance never stamps over a fast one), and the lock is merged", async () => {
    await seedEarned("earned1", 200_000);
    clockTo(RELEASE_AT_MS - 10 * 60_000);
    const real = transactionService.now;
    // A fast instance (11 min ahead) withdraws first ...
    transactionService.now = () => new Date(harness.clock.now().getTime() + 11 * 60_000);
    try {
      assert.equal((await withdraw(50_000)).status, 201);
    } finally {
      transactionService.now = real;
    }
    // ... a refund path's counter on the same lock ...
    const lockDoc = docsIn("withdrawalLocks").find(([uid]) => uid === agent.uid)![1];
    lockDoc.refundCount = 3;
    // ... then an instance with the right clock withdraws.
    assert.equal((await withdraw(10_000)).status, 201);
    const lock = docsIn("withdrawalLocks").find(([uid]) => uid === agent.uid)![1];
    assert.equal(lock.lastWithdrawalAt.toMillis(), RELEASE_AT_MS + 60_000, "the later stamp is kept");
    assert.equal(lock.withdrawalCount, 2);
    assert.equal(lock.refundCount, 3, "merged: the refund counters survive a withdrawal");
    // A later withdrawal on a correct clock moves it forward.
    clockTo(RELEASE_AT_MS + 3_600_000);
    assert.equal((await withdraw(10_000)).status, 201);
    assert.equal(docsIn("withdrawalLocks").find(([uid]) => uid === agent.uid)![1].lastWithdrawalAt.toMillis(), RELEASE_AT_MS + 3_600_000);
  });

  test("an agent cancel 1 ms before releaseAt is funded from available (the agent carries it, -F)", async () => {
    await bookAndPay("c1", { fees: F });
    clockTo(RELEASE_AT_MS - 1);
    assert.equal((await setStatus(agent, "cancelled", "c1")).status, 200);
    const [row] = refundRows();
    assert.equal(row.refundFundedFrom, "available");
    assert.equal(row.amount, A);
    assert.equal(row.agentReversalMinor, A, "A off the agent's A - F");
    assert.equal(feeOf("c1")!.feeHold.state, "held", "the fee itself is not marked refunded out of the hold");
    // Once it releases the agent's total is -F, the fee once: Seli carries nothing.
    clockTo(RELEASE_AT_MS + 1);
    const b = await balanceOf(agent);
    assert.equal(b.heldBalance + b.availableBalance, -F);
  });

  test("an agent cancel well before release is still funded from the hold", async () => {
    await bookAndPay("c1", { fees: F });
    clockTo(RELEASE_AT_MS - 3_600_000);
    await setStatus(agent, "cancelled", "c1");
    assert.equal(refundRows()[0].refundFundedFrom, "hold");
    assert.equal(feeOf("c1")!.feeHold.state, "refunded");
  });

  test("a withdrawal on an instance whose clock is ahead (at or after releaseAt - margin) makes the refund come from available", async () => {
    await bookAndPay("c1", { fees: F });
    await seedEarned("earned1", 100_000);
    // The refund's clock: 10 minutes before release (clearly held by it).
    clockTo(RELEASE_AT_MS - 10 * 60_000);
    // The withdrawal's instance runs 11 minutes ahead: it saw the fee released.
    const real = transactionService.now;
    transactionService.now = () => new Date(harness.clock.now().getTime() + 11 * 60_000);
    try {
      assert.equal((await withdraw(50_000)).status, 201);
    } finally {
      transactionService.now = real;
    }
    const lock = docsIn("withdrawalLocks").find(([uid]) => uid === agent.uid)![1];
    assert.equal(lock.lastWithdrawalAt.toMillis(), RELEASE_AT_MS + 60_000, "the withdrawal's own clock is recorded");
    await setStatus(agent, "cancelled", "c1");
    const [row] = refundRows();
    assert.equal(row.refundFundedFrom, "available", "never from a hold the withdrawal may have paid out");
  });

  test("an older withdrawal (well before the margin) does not change a clearly held refund", async () => {
    await bookAndPay("c1", { fees: F });
    await seedEarned("earned1", 100_000);
    assert.equal((await withdraw(50_000)).status, 201);
    clockTo(RELEASE_AT_MS - 3_600_000);
    await setStatus(agent, "cancelled", "c1");
    assert.equal(refundRows()[0].refundFundedFrom, "hold");
  });

  test("a fee frozen by a held refund long before release is still refunded from the hold after release", async () => {
    await bookAndPay("c1", { fees: undefined });
    await setStatus(agent, "cancelled", "c1");
    assert.equal(refundRows()[0].refundHeldReason, "paystack_fee_unknown");
    clockTo(RELEASE_AT_MS + 48 * 3_600_000);
    const reference = refOf("c1");
    const seen = harness.paystack.get(reference)!;
    harness.paystack.set(reference, toTransactionLookup({ ...seen, paid_at: seen.paidAt, fees: F }));
    const out = await adminRefund(admin, { refundId: refundRows()[0].id });
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.equal(refundRows()[0].refundFundedFrom, "hold");
  });

  test("one clock per transaction: the refund reads its time once (the stored times all agree)", async () => {
    await bookAndPay("c1", { fees: F });
    clockTo(RELEASE_AT_MS - 1);
    await setStatus(agent, "cancelled", "c1");
    const [row] = refundRows();
    assert.equal(row.createdAt.toMillis(), RELEASE_AT_MS - 1);
    assert.equal(bookingOf("c1")!.cancelledAt.toMillis(), RELEASE_AT_MS - 1);
  });

  test("unchanged for clearly held and clearly released fees (admin refund after release: from available)", async () => {
    await bookAndPay("c1", { fees: F });
    await seed("bankAccounts", "unused", { userId: "x", createdAt: T0, updatedAt: T0 });
    clockTo(RELEASE_AT_MS + 3_600_000);
    const out = await adminRefund(admin, { reason: "agent_no_show" });
    assert.equal(out.status, 201, JSON.stringify(out.body));
    assert.equal(refundRows()[0].refundFundedFrom, "available");
  });
});
