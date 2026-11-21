// ============================================
// Unit tests: poll refunds stuck in processing (issue #381)
// ============================================
//
// Hermetic (test/consultations/harness.ts): in-memory Firestore, Paystack
// stubbed (refund create / list / fetch-by-id are recorders; nothing reaches
// the network), a fixed clock the tests move.
//
// A refund Paystack accepted whose webhook never arrives must not sit in
// `processing` for ever: `pollProcessingRefunds` looks it up at Paystack and
// moves it FORWARD under the webhook's rules, never creating a refund and
// never writing money.

import { test, describe, before, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { Timestamp } from "firebase-admin/firestore";

import { useHarness, harness, docsIn, seed, T0 } from "./harness";
import {
  agent, bookAndPay, bookingOf, client, refOf, refundRows, setStatus, webhook, refundEvent, TEST_PAYSTACK_SECRET,
} from "./refund-fixtures";
import { notificationService } from "../../src/services/notification.service";
import {
  consultationRefundService, REFUND_PROCESSING_POLL_AFTER_MINUTES, REFUND_PROCESSING_POLL_BATCH_SIZE,
} from "../../src/services/consultation-refund.service";

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

/** A: ₦9,000.00 in kobo. */
const A = 900_000;

/** A paid booking `id`, cancelled by its agent: its refund row is `processing` at Paystack (refund id = its number). */
async function processingRefund(id = "c1"): Promise<Record<string, any>> {
  await bookAndPay(id, { fees: 0 });
  await setStatus(agent, "cancelled", id);
  const row = refundRows().find((r) => r.consultationId === id)!;
  assert.equal(row.status, "processing");
  return row;
}

/** Paystack's own status for booking `id`'s refund (the one the stub holds). */
function paystackSays(id: string, status: string, over: Record<string, unknown> = {}): void {
  const list = harness.paystackRefunds.get(refOf(id))!;
  Object.assign(list[list.length - 1], { status, ...over });
}

/** Move past the poll's age threshold. */
function ageOut(): void {
  harness.clock.advanceHours(REFUND_PROCESSING_POLL_AFTER_MINUTES / 60 + 0.1);
}

/** Everything stored, for "wrote nothing" checks. */
function snapshot(): string {
  return JSON.stringify(docsIn("transactions").concat(docsIn("consultations")));
}

/** The "refund delayed" notices the client got. */
function delayedNotices(): number {
  return notified.filter((n) => n.userId === client.uid && n.type === "consultation_refund_delayed").length;
}

// ============================================
// Tests
// ============================================

describe("pollProcessingRefunds (issue #381)", () => {
  test("entering processing stamps processingSince; a young row is not picked", async () => {
    const row = await processingRefund();
    assert.ok(row.processingSince instanceof Timestamp);
    paystackSays("c1", "processed");
    const run = await consultationRefundService.pollProcessingRefunds();
    assert.equal(run.scanned, 0, "not older than the threshold yet");
    assert.equal(refundRows()[0].status, "processing");
  });

  test("processed: completed (row and booking), by the row's current refund id; a second run writes nothing", async () => {
    await processingRefund();
    paystackSays("c1", "processed");
    ageOut();
    const calls = harness.refundCalls.length;
    const run = await consultationRefundService.pollProcessingRefunds();
    assert.deepEqual(run, { scanned: 1, completed: 1, failed: 0, unchanged: 0, errors: 0 });
    assert.deepEqual(harness.refundFetches, ["1"], "looked up by providerRefundId");
    assert.equal(refundRows()[0].status, "completed");
    assert.equal(bookingOf("c1")!.refundStatus, "completed");
    assert.equal(harness.refundCalls.length, calls, "never createRefund");
    const before = snapshot();
    const again = await consultationRefundService.pollProcessingRefunds();
    assert.equal(again.scanned, 0, "no longer processing");
    assert.equal(snapshot(), before, "nothing written the second time");
  });

  test("failed: failed, and the client is told it is delayed once", async () => {
    await processingRefund();
    paystackSays("c1", "failed");
    ageOut();
    const run = await consultationRefundService.pollProcessingRefunds();
    assert.equal(run.failed, 1);
    assert.equal(refundRows()[0].status, "failed");
    assert.equal(bookingOf("c1")!.refundStatus, "failed");
    assert.equal(delayedNotices(), 1);
    await consultationRefundService.pollProcessingRefunds();
    assert.equal(delayedNotices(), 1);
  });

  test("still processing at Paystack: unchanged, nothing written, twice in a row", async () => {
    await processingRefund();
    paystackSays("c1", "processing");
    ageOut();
    const before = snapshot();
    for (let i = 0; i < 2; i++) {
      const run = await consultationRefundService.pollProcessingRefunds();
      assert.deepEqual(run, { scanned: 1, completed: 0, failed: 0, unchanged: 1, errors: 0 });
    }
    assert.equal(snapshot(), before);
  });

  test("Paystack down on one row: logged and counted; the other rows still run", async () => {
    await processingRefund("c1");
    await processingRefund("c2");
    paystackSays("c1", "processed");
    paystackSays("c2", "processed");
    ageOut();
    harness.failNextRefundLookup = true;
    const run = await consultationRefundService.pollProcessingRefunds();
    assert.equal(run.scanned, 2);
    assert.equal(run.errors, 1);
    assert.equal(run.completed, 1);
    assert.equal(refundRows().filter((r) => r.status === "completed").length, 1);
  });

  test("no providerRefundId: found among the charge's refunds with the exact match, adopted as the current attempt", async () => {
    const row = await processingRefund();
    // As a row of an older build: processing, no Paystack id, no age field.
    const stored = docsIn("transactions").find(([id]) => id === row.id)![1];
    delete stored.providerRefundId;
    delete stored.processingSince;
    paystackSays("c1", "processed");
    ageOut();
    const run = await consultationRefundService.pollProcessingRefunds();
    assert.equal(run.completed, 1, "picked by updatedAt (no processingSince)");
    const [after] = refundRows();
    assert.equal(after.status, "completed");
    assert.equal(after.providerRefundId, "1");
    assert.deepEqual(harness.refundLookups.slice(-1), [refOf("c1")]);
  });

  test("mismatched amount (or currency): not applied, by id or by the charge's list", async () => {
    // By the current id: Paystack's refund is not of the row's amount.
    const row = await processingRefund("c1");
    paystackSays("c1", "processed", { amount: A - 100 });
    // By the list: no id, and the charge's refund is in another currency.
    const row2 = await processingRefund("c2");
    const stored = docsIn("transactions").find(([id]) => id === row2.id)![1];
    delete stored.providerRefundId;
    paystackSays("c2", "processed", { currency: "USD" });
    ageOut();
    const run = await consultationRefundService.pollProcessingRefunds();
    assert.deepEqual(run, { scanned: 2, completed: 0, failed: 0, unchanged: 2, errors: 0 });
    assert.equal(refundRows().find((r) => r.id === row.id)!.status, "processing");
    assert.equal(refundRows().find((r) => r.id === row2.id)!.status, "processing");
  });

  test("held rows and rows of other types are never touched", async () => {
    // A held refund (failed, amount 0) and a processing withdrawal.
    await bookAndPay("c1", { fees: undefined });
    await setStatus(agent, "cancelled", "c1");
    assert.equal(refundRows()[0].refundHeldReason, "paystack_fee_unknown");
    await seed("transactions", "w1", {
      userId: agent.uid, agentId: agent.uid, type: "withdrawal", amount: 1_000, currency: "NGN", status: "processing",
      isEscrow: false, paymentProvider: "manual", description: "w", createdAt: T0, updatedAt: T0,
    });
    ageOut();
    const before = snapshot();
    const run = await consultationRefundService.pollProcessingRefunds();
    assert.equal(run.scanned, 0);
    assert.equal(snapshot(), before);
    assert.equal(harness.refundFetches.length + harness.refundLookups.length, 0, "no Paystack call");
  });

  test("concurrency: the poll and the webhook at once complete the row once (forward-only)", async () => {
    await processingRefund();
    paystackSays("c1", "processed");
    ageOut();
    const [run] = await Promise.all([
      consultationRefundService.pollProcessingRefunds(),
      webhook(refundEvent("refund.processed", refOf("c1"), { id: "1" })),
    ]);
    assert.equal(refundRows()[0].status, "completed");
    assert.ok(run.completed + run.unchanged === 1);
  });

  test("concurrency: poll vs a late failed of a retired attempt and the retry job: never moves backward, never creates", async () => {
    await processingRefund();
    paystackSays("c1", "failed");
    ageOut();
    const calls = harness.refundCalls.length;
    await Promise.all([
      consultationRefundService.pollProcessingRefunds(),
      consultationRefundService.retryDueRefunds(),
      webhook(refundEvent("refund.failed", refOf("c1"), { id: "1" })),
    ]);
    assert.equal(refundRows()[0].status, "failed");
    assert.equal(delayedNotices(), 1, "told once whoever got there first");
    assert.equal(harness.refundCalls.length, calls);
  });

  test("oldest first: rows are looked up in the order they entered processing, rows with the age field before older ones without", async () => {
    assert.ok(REFUND_PROCESSING_POLL_BATCH_SIZE > 0 && Number.isSafeInteger(REFUND_PROCESSING_POLL_BATCH_SIZE));
    await processingRefund("c1");
    harness.clock.advanceHours(0.2);
    await processingRefund("c2");
    // c0: entered processing before #381 (no age field), its refund id "9".
    const legacy = await processingRefund("c0");
    const stored = docsIn("transactions").find(([id]) => id === legacy.id)![1];
    delete stored.processingSince;
    stored.providerRefundId = "9";
    harness.paystackRefunds.get(refOf("c0"))![0].id = "9";
    ageOut();
    await consultationRefundService.pollProcessingRefunds();
    assert.deepEqual(harness.refundFetches, ["1", "2", "9"]);
  });
});
