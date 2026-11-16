// ============================================
// Unit tests: consultation refunds and the fee hold (issue #317, part 1 of 4)
// ============================================
//
// Hermetic (test/consultations/harness.ts): in-memory Firestore, every
// Paystack call stubbed (charges AND refunds are recorders), a fixed clock
// the tests move. Requests carry a real CASL ability.
//
// What is covered, by acceptance criterion:
//  - HOLD (orchestrator "hold consultation fees"): book -> pay -> the agent
//    tries to withdraw the fee (refused: held) -> the agent cancels -> the
//    client is refunded FROM THE HOLD and the agent's available balance is
//    unchanged; release after completion (once the slot started) and 24 h
//    after the slot ends -> withdraw allowed; a completion before the slot
//    does not release; a reschedule never releases sooner; the agent side
//    cannot cancel once the fee is released (409 FEE_RELEASED);
//  - the RULE TABLE: agent side (agent, owner, admin) cancels -> full;
//    client 24 h+ before (and exactly 24 h) -> full; client 23 h 59 m before
//    -> none, the agent keeps the fee; completed / no_show -> none; free and
//    unpaid -> none; paid with no fee Transaction (legacy) -> cancels, no
//    row, an error log naming the booking;
//  - the cancel answer's `refund`, and the client's `cancellationRefund`
//    preview on GET /consultations/:id;
//  - RECORDS: the row's fields, minor units of the fee's currency, the fee
//    stays `completed`, the booking stays `paid` with `refundId` /
//    `refundStatus`, the client's GET /transactions shows the refund through
//    the allow-list;
//  - BALANCES: per currency; revenue drops once completed; a released fee
//    refunded by an admin takes the agent negative and blocks withdrawals;
//  - IDEMPOTENCY: double cancel, concurrent admin refunds, a crash between
//    the commit and Paystack, Paystack "already reversed", repeated and
//    out-of-order webhooks, an unknown refund; the retry job and its cap;
//  - the WITHDRAWAL LOCK is written with the refund row;
//  - the ADMIN endpoint's answers; NOTIFICATIONS.
import { test, describe, before, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { writes } from "../helpers/fake-firestore";
import { useHarness, harness, docsIn } from "./harness";
import {
  admin, adminRefund, agent, balanceOf, bookAndPay, bookFree, bookingOf, client, edit, FEE_NGN, feeOf,
  getBooking, HOURS_TO_SLOT, listTransactions, ownerA, refOf, refundEvent, refundRows, seedEarned,
  setStatus, SLOT_START_ISO, TEST_PAYSTACK_SECRET, webhook, withdraw,
} from "./refund-fixtures";
import { notificationService } from "../../src/services/notification.service";
import {
  consultationRefundService,
  MAX_REFUND_ATTEMPTS,
  refundDocId,
} from "../../src/services/consultation-refund.service";

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Every notification sent during a test. */
const notified: Array<{ userId: string; type: string; body: string }> = [];
/** Every console.error line during a test (the legacy-data log is asserted). */
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
  // A dummy key, tests only: the webhook signature is checked with it.
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
// The abuse path the hold closes
// ============================================

describe("fee hold: Seli never funds a refund an agent can trigger", () => {
  test("book -> pay -> withdraw the fee (refused: held) -> agent cancels -> refunded from the hold, available unchanged", async () => {
    // The agent has ₦1,000 they really earned elsewhere.
    await seedEarned("earned1", 100_000);
    const fee = await bookAndPay("c1");
    assert.equal(fee.status, "completed");
    assert.equal(fee.feeHold.state, "held", "a new fee is held");

    // Held: in heldBalance, NOT in availableBalance.
    let bal = await balanceOf(agent);
    assert.equal(bal.heldBalance, 900_000);
    assert.equal(bal.availableBalance, 100_000);

    // The agent tries to withdraw the fee: refused, nothing written.
    writes.length = 0;
    const refused = await withdraw(1_000_000);
    assert.equal(refused.status, 400);
    assert.equal(refused.body.message, "Insufficient balance");
    assert.ok(!docsIn("transactions").some(([, d]) => d.type === "withdrawal"), "no withdrawal written");
    // Even just the fee alone over the earned money is refused.
    assert.equal((await withdraw(100_001)).status, 400);

    // The agent cancels: a full refund, out of the hold.
    const out = await setStatus(agent, "cancelled", "c1", { cancellationReason: "Something came up" });
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.equal(out.body.data.status, "cancelled");
    assert.deepEqual(out.body.data.refund, { status: "processing", amount: FEE_NGN });

    const [row] = refundRows();
    assert.equal(row.id, refundDocId(refOf("c1")), "deterministic id from the Paystack reference");
    assert.equal(row.refundFundedFrom, "hold");
    assert.equal(row.balanceShortfallMinor, 0);
    // Paystack was asked once, for exactly the fee, in its currency.
    assert.deepEqual(harness.refundCalls.map((c) => [c.reference, c.amount]), [[refOf("c1"), FEE_NGN]]);

    // The agent's available balance did not move; the hold is gone.
    bal = await balanceOf(agent);
    assert.equal(bal.availableBalance, 100_000, "available balance unchanged");
    assert.equal(bal.heldBalance, 0, "the held fee paid the refund");
    // They can still withdraw what they really earned, and no more.
    assert.equal((await withdraw(100_001)).status, 400);
    assert.equal((await withdraw(100_000)).status, 201);
  });

  test("released after completion (once the slot started): the fee can be withdrawn", async () => {
    await bookAndPay("c1");
    harness.clock.advanceHours(HOURS_TO_SLOT + 0.25); // inside the meeting
    assert.equal((await withdraw(900_000)).status, 400, "still held during the meeting");
    const done = await setStatus(agent, "completed", "c1");
    assert.equal(done.status, 200);
    assert.equal(done.body.data.refund, null, "completing gives no refund");
    assert.equal(refundRows().length, 0);
    const bal = await balanceOf(agent);
    assert.equal(bal.availableBalance, 900_000);
    assert.equal(bal.heldBalance, 0);
    assert.equal((await withdraw(900_000)).status, 201);
  });

  test("released 24 hours after the slot ends, with nothing done: withdraw allowed, agent cancel refused", async () => {
    await bookAndPay("c1");
    // Slot end (start + 30 min) + 24 h, minus a minute: still held.
    harness.clock.advanceHours(HOURS_TO_SLOT + 0.5 + 24 - 1 / 60);
    assert.equal((await balanceOf(agent)).heldBalance, 900_000);
    harness.clock.advanceHours(1 / 60);
    const bal = await balanceOf(agent);
    assert.equal(bal.heldBalance, 0);
    assert.equal(bal.availableBalance, 900_000);

    // Once released the meeting has happened: the agent side cannot cancel.
    writes.length = 0;
    const out = await setStatus(agent, "cancelled", "c1");
    assert.equal(out.status, 409);
    assert.equal(out.body.error, "FEE_RELEASED");
    assert.deepEqual(writes, [], "nothing written");
    assert.equal(bookingOf("c1")!.status, "scheduled");

    assert.equal((await withdraw(900_000)).status, 201);
  });

  // Review fix (round 1): the agent side cannot mark a meeting under way,
  // done or missed before its slot has started (that used to stop the
  // client from cancelling and start the fee's release).
  for (const target of ["in_progress", "completed", "no_show"]) {
    test(`agent side cannot set ${target} before the slot starts: 409 SLOT_NOT_STARTED, nothing written`, async () => {
      await bookAndPay("c1");
      harness.clock.advanceHours(HOURS_TO_SLOT - 1 / 60); // one minute before the slot
      writes.length = 0;
      for (const who of [agent, ownerA, admin]) {
        const out = await setStatus(who, target, "c1");
        assert.equal(out.status, 409);
        assert.equal(out.body.error, "SLOT_NOT_STARTED");
      }
      assert.deepEqual(writes, [], "nothing written");
      assert.equal(bookingOf("c1")!.status, "scheduled");
      assert.equal((await balanceOf(agent)).heldBalance, 900_000, "still held");
      // From the slot start it is allowed.
      harness.clock.advanceHours(1 / 60);
      assert.equal((await setStatus(agent, target, "c1")).status, 200);
    });
  }

  test("a client whose meeting was not marked early can still cancel 24 h+ before and is refunded", async () => {
    await bookAndPay("c1");
    assert.equal((await setStatus(agent, "completed", "c1")).body.error, "SLOT_NOT_STARTED");
    const out = await setStatus(client, "cancelled", "c1");
    assert.equal(out.status, 200);
    assert.equal(out.body.data.refund.status, "processing");
  });

  test("review fix: released by the clock -> withdraw -> reschedule refused -> cancel refused (never a refund 'from the hold')", async () => {
    await bookAndPay("c1");
    harness.clock.advanceHours(HOURS_TO_SLOT + 0.5 + 24);
    assert.equal((await withdraw(900_000)).status, 201, "the released fee is withdrawn");
    const holdBefore = feeOf("c1")!.feeHold;

    writes.length = 0;
    const moved = await edit(agent, { scheduledDate: "2026-12-04" });
    assert.equal(moved.status, 409);
    assert.equal(moved.body.error, "FEE_RELEASED");
    assert.deepEqual(writes, [], "the reschedule wrote nothing");
    assert.deepEqual(feeOf("c1")!.feeHold, holdBefore, "the hold did not move");

    const cancel = await setStatus(agent, "cancelled", "c1");
    assert.equal(cancel.status, 409);
    assert.equal(cancel.body.error, "FEE_RELEASED");
    assert.equal(refundRows().length, 0, "no refund row at all");
    assert.equal(harness.refundCalls.length, 0, "Paystack never asked");
    assert.equal((await balanceOf(agent)).availableBalance, 0);
  });

  test("review fix: a meeting-only edit of a released booking is still allowed", async () => {
    await bookAndPay("c1");
    harness.clock.advanceHours(HOURS_TO_SLOT + 0.5 + 24);
    assert.equal((await edit(agent, { meetingLink: "https://meet.example.test/x" })).status, 200);
  });

  test("a client no_show releases the fee like a completion (the agent keeps it)", async () => {
    await bookAndPay("c1");
    harness.clock.advanceHours(HOURS_TO_SLOT + 1);
    const out = await setStatus(agent, "no_show", "c1");
    assert.equal(out.status, 200);
    assert.equal(refundRows().length, 0, "no refund for a client no-show (#350)");
    assert.equal((await balanceOf(agent)).availableBalance, 900_000);
  });

  test("a reschedule never releases the fee sooner (earlier or past dates keep the hold); a later one extends it", async () => {
    const fee = await bookAndPay("c1");
    const releaseAt = fee.feeHold.releaseAt.toMillis();
    // Moved into the past: the hold does not move.
    assert.equal((await edit(agent, { scheduledDate: "2026-11-01" })).status, 200);
    assert.equal(feeOf("c1")!.feeHold.releaseAt.toMillis(), releaseAt);
    assert.equal((await balanceOf(agent)).heldBalance, 900_000);
    // Moved a week later: the hold moves with it.
    assert.equal((await edit(agent, { scheduledDate: "2026-11-27" })).status, 200);
    assert.equal(feeOf("c1")!.feeHold.releaseAt.toMillis(), releaseAt + 7 * 86_400_000);
  });
});

// ============================================
// The rule table
// ============================================

describe("refund on cancel: the rule table", () => {
  for (const [label, who] of [["the booking's agent", agent], ["the agency owner", ownerA], ["an admin", admin]] as const) {
    test(`${label} cancels a paid booking: full refund (agent_cancelled)`, async () => {
      await bookAndPay("c1");
      const out = await setStatus(who, "cancelled", "c1");
      assert.equal(out.status, 200, JSON.stringify(out.body));
      assert.deepEqual(out.body.data.refund, { status: "processing", amount: FEE_NGN });
      const [row] = refundRows();
      assert.equal(row.reason, "agent_cancelled");
      assert.equal(row.initiatedBy, who.uid);
    });
  }

  test("client cancels 24 hours or more before the slot: full refund (client_cancelled)", async () => {
    await bookAndPay("c1");
    const out = await setStatus(client, "cancelled", "c1");
    assert.equal(out.status, 200);
    assert.deepEqual(out.body.data.refund, { status: "processing", amount: FEE_NGN });
    assert.equal(refundRows()[0].reason, "client_cancelled");
  });

  test("boundary: EXACTLY 24 hours before the slot counts as 24 hours or more", async () => {
    await bookAndPay("c1");
    harness.clock.advanceHours(HOURS_TO_SLOT - 24);
    const out = await setStatus(client, "cancelled", "c1");
    assert.equal(out.body.data.refund?.status, "processing");
    assert.equal(refundRows().length, 1);
  });

  test("boundary: 23 h 59 m before the slot: no refund, no row, the agent keeps the (still held) fee", async () => {
    await bookAndPay("c1");
    harness.clock.advanceHours(HOURS_TO_SLOT - 24 + 1 / 60);
    const before = await balanceOf(agent);
    const out = await setStatus(client, "cancelled", "c1");
    assert.equal(out.status, 200);
    assert.equal(out.body.data.status, "cancelled");
    assert.equal(out.body.data.refund, null);
    assert.equal(refundRows().length, 0);
    assert.deepEqual(await balanceOf(agent), before, "agent balance unchanged");
    assert.equal(harness.refundCalls.length, 0);
    // The kept fee releases on the normal schedule (slot end + 24 h).
    // From 23 h 59 m before the slot to past slot end (+30 min) + 24 h.
    harness.clock.advanceHours(24 + 0.5 + 24 + 1);
    assert.equal((await balanceOf(agent)).availableBalance, 900_000);
    // Only the existing cancel notice: no refund messages.
    assert.deepEqual(notified.map((n) => n.type), ["consultation_cancelled"]);
  });

  test("agent side marks completed or no_show: no refund row", async () => {
    await bookAndPay("c1");
    await bookAndPay("c2");
    harness.clock.advanceHours(HOURS_TO_SLOT);
    assert.equal((await setStatus(agent, "completed", "c1")).body.data.refund, null);
    assert.equal((await setStatus(agent, "no_show", "c2")).body.data.refund, null);
    assert.equal(refundRows().length, 0);
  });

  test("a free booking cancels exactly as before: no refund row", async () => {
    await bookFree("free1");
    const out = await setStatus(client, "cancelled", "free1");
    assert.equal(out.status, 200);
    assert.equal(out.body.data.refund, null);
    assert.equal(refundRows().length, 0);
    assert.equal(harness.refundCalls.length, 0);
  });

  test("an unpaid pending_payment booking (no checkout) cancels with no refund row", async () => {
    await bookFree("p1", { status: "pending_payment", paymentStatus: "pending", priceUsdCents: 600, chargedCurrency: "NGN", chargedAmountMinor: 900_000 });
    const out = await setStatus(agent, "cancelled", "p1");
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.equal(out.body.data.refund, null);
    assert.equal(refundRows().length, 0);
  });

  test("legacy: a paid booking with no settled Paystack fee Transaction still cancels; no row; error log names it", async () => {
    await bookFree("legacy1", { priceUsdCents: 600, chargedCurrency: "NGN", chargedAmountMinor: 900_000, transactionId: "cons-legacy1-ref" });
    const out = await setStatus(agent, "cancelled", "legacy1");
    assert.equal(out.status, 200);
    assert.equal(out.body.data.status, "cancelled");
    assert.equal(out.body.data.refund, null);
    assert.equal(refundRows().length, 0);
    assert.ok(errors.some((e) => e.includes("legacy1")), "an error-level log names the booking");
  });
});

// ============================================
// Review fix: the client's window is measured from the slot they paid for
// ============================================

describe("an agent moving a paid booking earlier never costs the client their refund", () => {
  test("rescheduled to 2 hours from now: the client cancels and is fully refunded", async () => {
    await bookAndPay("c1");
    // 12:00 Lagos today = 11:00Z, two hours after the harness's now.
    assert.equal((await edit(agent, { scheduledDate: "2026-11-13", scheduledTime: "12:00" })).status, 200);
    const preview = (await getBooking(client)).body.data.cancellationRefund;
    assert.equal(preview.refundable, true, "the preview still says refundable");
    assert.equal(preview.refundableUntil, new Date(new Date(SLOT_START_ISO).getTime() - 24 * 3_600_000).toISOString());
    const out = await setStatus(client, "cancelled", "c1");
    assert.equal(out.status, 200);
    assert.deepEqual(out.body.data.refund, { status: "processing", amount: FEE_NGN });
    assert.equal(refundRows()[0].reason, "client_cancelled");
  });

  test("rescheduled into the past: the client cancels and is fully refunded", async () => {
    await bookAndPay("c1");
    assert.equal((await edit(agent, { scheduledDate: "2026-11-01" })).status, 200);
    const out = await setStatus(client, "cancelled", "c1");
    assert.equal(out.status, 200);
    assert.equal(out.body.data.refund?.status, "processing");
  });

  test("still late inside the last 24 h of the slot they paid for", async () => {
    await bookAndPay("c1");
    assert.equal((await edit(agent, { scheduledDate: "2026-11-13", scheduledTime: "12:00" })).status, 200);
    harness.clock.advanceHours(HOURS_TO_SLOT - 23);
    const out = await setStatus(client, "cancelled", "c1");
    assert.equal(out.body.data.refund, null);
  });
});

// ============================================
// Before the client cancels
// ============================================

describe("GET /consultations/:id: the client's cancellationRefund preview", () => {
  test("a paid booking 24 h+ away: refundable, the full amount, until slot start minus 24 h", async () => {
    await bookAndPay("c1");
    const out = await getBooking(client);
    assert.equal(out.status, 200);
    assert.deepEqual(out.body.data.cancellationRefund, {
      refundable: true,
      amount: FEE_NGN,
      refundableUntil: new Date(new Date(SLOT_START_ISO).getTime() - 24 * 3_600_000).toISOString(),
    });
  });

  test("inside the last 24 hours: not refundable", async () => {
    await bookAndPay("c1");
    harness.clock.advanceHours(HOURS_TO_SLOT - 23);
    assert.equal((await getBooking(client)).body.data.cancellationRefund.refundable, false);
  });

  test("absent on free, unpaid and cancelled bookings, and on the agent-side view", async () => {
    await bookFree("free1");
    assert.equal((await getBooking(client, "free1")).body.data.cancellationRefund, undefined);
    await bookFree("p1", { status: "pending_payment", paymentStatus: "pending", priceUsdCents: 600 });
    assert.equal((await getBooking(client, "p1")).body.data.cancellationRefund, undefined);
    await bookAndPay("c1");
    assert.equal((await getBooking(agent, "c1")).body.data.cancellationRefund, undefined, "agent view has none");
    await setStatus(client, "cancelled", "c1");
    assert.equal((await getBooking(client, "c1")).body.data.cancellationRefund, undefined);
  });
});

// ============================================
// Records
// ============================================

describe("the refund record", () => {
  test("its fields; the fee stays completed; the booking stays paid and mirrors the refund", async () => {
    const fee = await bookAndPay("c1");
    await setStatus(client, "cancelled", "c1");
    const [row] = refundRows();
    assert.equal(row.type, "refund");
    assert.equal(row.consultationId, "c1");
    assert.equal(row.userId, client.uid);
    assert.equal(row.agentId, agent.uid);
    assert.equal(row.amount, fee.amount);
    assert.equal(row.currency, fee.currency);
    assert.equal(row.refundOf, fee.id);
    assert.equal(row.reason, "client_cancelled");
    assert.equal(row.initiatedBy, client.uid);
    assert.equal(row.paymentProvider, "paystack");
    assert.equal(row.providerRefundId, "1", "Paystack's refund id once known");
    assert.equal(row.status, "processing");

    const feeAfter = feeOf("c1")!;
    assert.equal(feeAfter.status, "completed", "the fee is not flipped to refunded");
    assert.equal(feeAfter.feeHold.state, "refunded");
    const booking = bookingOf("c1")!;
    assert.equal(booking.paymentStatus, "paid");
    assert.equal(booking.refundId, row.id);
    assert.equal(booking.refundStatus, "processing");
  });

  test("the client's GET /transactions shows the refund through the allow-list (no Paystack ids)", async () => {
    await bookAndPay("c1");
    await setStatus(client, "cancelled", "c1");
    const out = await listTransactions(client);
    assert.equal(out.status, 200);
    const refund = (out.body.data as any[]).find((t) => t.type === "refund");
    assert.ok(refund, "the refund is in the client's history");
    assert.deepEqual(refund.amountCharged, FEE_NGN);
    assert.equal(refund.status, "processing");
    const json = JSON.stringify(refund);
    for (const key of ["providerTransactionId", "providerRefundId", "refundOf", "agentId", "metadata", "refundFundedFrom"]) {
      assert.ok(!json.includes(`"${key}":`), `no ${key}`);
    }
    assert.ok(!json.includes(refOf("c1")), "no Paystack reference");
  });

  test("the withdrawal lock is written with the refund row (#287)", async () => {
    await bookAndPay("c1");
    await setStatus(agent, "cancelled", "c1");
    const lock = docsIn("withdrawalLocks").find(([id]) => id === agent.uid)?.[1];
    assert.ok(lock, "lock document written");
    assert.equal(lock!.lastRefundId, refundDocId(refOf("c1")));
    assert.equal(lock!.refundCount, 1);
    // A later withdrawal keeps working on the same lock.
    await seedEarned("earned1", 50_000);
    assert.equal((await withdraw(50_000)).status, 201);
  });
});

// ============================================
// Balances
// ============================================

describe("agent balance effect", () => {
  test("revenue drops by the refund only once Paystack reports it processed", async () => {
    await bookAndPay("c1");
    await setStatus(agent, "cancelled", "c1");
    assert.equal((await balanceOf(agent)).totalRevenue, 900_000, "processing: revenue unchanged");
    await webhook(refundEvent("refund.processed", refOf("c1")));
    assert.equal((await balanceOf(agent)).totalRevenue, 0, "completed: revenue lower by the refund");
  });

  test("admin refund of a RELEASED fee takes the agent negative (carried forward); withdrawals blocked", async () => {
    await bookAndPay("c1");
    harness.clock.advanceHours(HOURS_TO_SLOT + 1);
    await setStatus(agent, "completed", "c1");
    assert.equal((await withdraw(900_000)).status, 201, "the agent withdrew the released fee");

    const out = await adminRefund(admin, { reason: "agent_no_show" });
    assert.equal(out.status, 201, JSON.stringify(out.body));
    const [row] = refundRows();
    assert.equal(row.reason, "admin_agent_no_show");
    assert.equal(row.refundFundedFrom, "available");
    assert.equal(row.balanceShortfallMinor, 900_000, "the shortfall is logged on the row");
    assert.equal(bookingOf("c1")!.status, "completed", "the booking's status is not changed");

    const bal = await balanceOf(agent);
    assert.equal(bal.availableBalance, -900_000, "negative, not floored, Seli does not absorb it");
    // Withdrawals are blocked while negative, even after new earnings below the debt.
    await seedEarned("earned1", 400_000);
    assert.equal((await balanceOf(agent)).availableBalance, -500_000);
    assert.equal((await withdraw(1)).status, 400);
  });

  test("per currency: a GHS refund never touches the NGN balance", async () => {
    await seedEarned("earned-ngn", 300_000, "NGN");
    await bookAndPay("g1", { charge: { amountMinor: 9_000, currency: "GHS" } });
    harness.clock.advanceHours(HOURS_TO_SLOT + 0.5 + 25);
    assert.equal((await balanceOf(agent, "GHS")).availableBalance, 9_000);
    const out = await adminRefund(admin, { reason: "goodwill" }, "g1");
    assert.equal(out.status, 201);
    assert.deepEqual(out.body.data.refund.amount, { amountMinor: 9_000, currency: "GHS" });
    assert.deepEqual(harness.refundCalls[0].amount, { amountMinor: 9_000, currency: "GHS" }, "Paystack gets GHS minor units");
    assert.equal((await balanceOf(agent, "GHS")).availableBalance, 0);
    assert.equal((await balanceOf(agent, "NGN")).availableBalance, 300_000, "NGN unchanged");
  });
});

// ============================================
// Idempotency
// ============================================

describe("idempotency: one charge, at most one refund", () => {
  test("double cancel: the second is refused and creates nothing", async () => {
    await bookAndPay("c1");
    assert.equal((await setStatus(client, "cancelled", "c1")).status, 200);
    const again = await setStatus(client, "cancelled", "c1");
    assert.equal(again.status, 409);
    assert.equal(refundRows().length, 1);
    assert.equal(harness.refundCalls.length, 1);
  });

  test("two admins refund at once: one refund, one 409 ALREADY_REFUNDED, one Paystack call", async () => {
    await bookAndPay("c1");
    const [a, b] = await Promise.all([
      adminRefund(admin, { reason: "goodwill" }),
      adminRefund(admin, { reason: "other", note: "Client complained" }),
    ]);
    assert.deepEqual([a.status, b.status].sort(), [201, 409]);
    assert.equal([a, b].find((o) => o.status === 409)!.body.error, "ALREADY_REFUNDED");
    assert.equal(refundRows().length, 1);
    assert.equal(harness.refundCalls.length, 1);
  });

  test("cancel after an admin refund: the cancel goes through and reuses the existing refund", async () => {
    await bookAndPay("c1");
    assert.equal((await adminRefund(admin, { reason: "goodwill" })).status, 201);
    const out = await setStatus(client, "cancelled", "c1");
    assert.equal(out.status, 200);
    assert.equal(out.body.data.refund.status, "processing");
    assert.equal(refundRows().length, 1);
    assert.equal(harness.refundCalls.length, 1);
  });

  test("Paystack unreachable on cancel: the cancel still answers 200; the row waits as pending", async () => {
    await bookAndPay("c1");
    harness.refundBehaviour.push("network");
    const out = await setStatus(client, "cancelled", "c1");
    assert.equal(out.status, 200);
    assert.deepEqual(out.body.data.refund, { status: "pending", amount: FEE_NGN });
    const [row] = refundRows();
    assert.equal(row.status, "pending");
    assert.match(row.refundLastError, /ETIMEDOUT/);
    assert.equal(bookingOf("c1")!.refundStatus, "pending");
  });

  test("a crash between the commit and Paystack's answer: the retry LOOKS UP and adopts, never refunds twice", async () => {
    await bookAndPay("c1");
    // Paystack created the refund, but its answer was lost.
    harness.refundBehaviour.push("reached_then_network");
    await setStatus(client, "cancelled", "c1");
    assert.equal(refundRows()[0].status, "pending");
    assert.equal(harness.refundCalls.length, 1);

    // Not due yet: the job does nothing.
    let run = await consultationRefundService.retryDueRefunds();
    assert.equal(run.scanned, 0);
    harness.clock.advanceHours(0.25);
    run = await consultationRefundService.retryDueRefunds();
    assert.equal(run.processing, 1);
    assert.deepEqual(harness.refundLookups, [refOf("c1")], "looked up before any repeat call");
    assert.equal(harness.refundCalls.length, 1, "no second refund at Paystack");
    const [row] = refundRows();
    assert.equal(row.status, "processing");
    assert.equal(row.providerRefundId, "1");
  });

  test("Paystack answers 'already reversed': looked up and adopted, never called again", async () => {
    await bookAndPay("c1");
    harness.paystackRefunds.set(refOf("c1"), [
      { id: "77", status: "processed", transactionReference: refOf("c1"), amount: 900_000, currency: "NGN" },
    ]);
    harness.refundBehaviour.push("already_reversed");
    const out = await setStatus(client, "cancelled", "c1");
    assert.equal(out.body.data.refund.status, "completed");
    assert.equal(refundRows()[0].providerRefundId, "77");
    assert.equal(harness.refundCalls.length, 0);
  });

  test("retries are capped: after the last attempt the row is failed, the client told, admins can list it", async () => {
    await bookAndPay("c1");
    for (let i = 0; i < MAX_REFUND_ATTEMPTS; i++) harness.refundBehaviour.push("network");
    await setStatus(client, "cancelled", "c1"); // attempt 1
    for (let i = 1; i < MAX_REFUND_ATTEMPTS; i++) {
      harness.clock.advanceHours(0.25);
      await consultationRefundService.retryDueRefunds();
    }
    const [row] = refundRows();
    assert.equal(row.status, "failed");
    assert.equal(row.refundAttempts, MAX_REFUND_ATTEMPTS);
    assert.equal(bookingOf("c1")!.refundStatus, "failed");
    assert.ok(notified.some((n) => n.userId === client.uid && n.type === "consultation_refund_delayed" && n.body === "Your refund is delayed. We're on it."));
    // A failed row is not retried by the job any more.
    harness.clock.advanceHours(1);
    assert.equal((await consultationRefundService.retryDueRefunds()).scanned, 0);

    // Admins list failed refunds.
    const list = await listTransactions(admin, { role: "admin", type: "refund", status: "failed" });
    assert.equal(list.status, 200);
    assert.deepEqual((list.body.data as any[]).map((t) => t.id), [row.id]);

    // An admin retry re-attempts THAT row (looked up first), not a new one.
    const retry = await adminRefund(admin, { reason: "goodwill" });
    assert.equal(retry.status, 200, JSON.stringify(retry.body));
    assert.equal(retry.body.data.retried, true);
    assert.equal(retry.body.data.refund.status, "processing");
    assert.equal(refundRows().length, 1);
    assert.ok(harness.refundLookups.length >= 1);
    assert.equal(harness.refundCalls.length, 1);
  });
});

// ============================================
// Webhooks
// ============================================

describe("refund webhooks on POST /webhooks/paystack", () => {
  /** Cancel booking c1 so a refund row exists in `processing`. */
  async function processingRefund(): Promise<void> {
    await bookAndPay("c1");
    await setStatus(client, "cancelled", "c1");
    assert.equal(refundRows()[0].status, "processing");
  }

  test("refund.processed -> completed (row and booking); repeated -> nothing written", async () => {
    await processingRefund();
    const out = await webhook(refundEvent("refund.processed", refOf("c1")));
    assert.equal(out.status, 200);
    assert.equal(out.body.applied, true);
    assert.equal(refundRows()[0].status, "completed");
    assert.equal(bookingOf("c1")!.refundStatus, "completed");
    writes.length = 0;
    const again = await webhook(refundEvent("refund.processed", refOf("c1")));
    assert.equal(again.status, 200);
    assert.equal(again.body.applied, false);
    assert.deepEqual(writes, []);
  });

  test("out of order: refund.pending / processing / failed after completed write nothing", async () => {
    await processingRefund();
    await webhook(refundEvent("refund.processed", refOf("c1")));
    writes.length = 0;
    for (const event of ["refund.pending", "refund.processing", "refund.failed"]) {
      const out = await webhook(refundEvent(event, refOf("c1")));
      assert.equal(out.status, 200);
    }
    assert.deepEqual(writes, [], "completed is final");
    assert.equal(refundRows()[0].status, "completed");
  });

  test("refund.failed -> failed, and the client is told it is delayed", async () => {
    await processingRefund();
    await webhook(refundEvent("refund.failed", refOf("c1")));
    assert.equal(refundRows()[0].status, "failed");
    assert.ok(notified.some((n) => n.type === "consultation_refund_delayed"));
  });

  test("matched by Paystack's refund id when the reference is missing", async () => {
    await processingRefund();
    await webhook({ event: "refund.processed", data: { status: "processed", id: 1 } });
    assert.equal(refundRows()[0].status, "completed");
  });

  test("an event for an unknown refund answers 200 and writes nothing", async () => {
    await processingRefund();
    writes.length = 0;
    const out = await webhook(refundEvent("refund.processed", "cons-nobody-ref", { id: "999" }));
    assert.equal(out.status, 200);
    assert.deepEqual(writes, []);
  });

  test("a forged signature is not applied", async () => {
    await processingRefund();
    writes.length = 0;
    await webhook(refundEvent("refund.processed", refOf("c1")), "sk_test_wrong");
    assert.equal(refundRows()[0].status, "processing");
    assert.ok(!writes.some((w) => w.path.startsWith("transactions/")));
  });
});

// ============================================
// Admin endpoint
// ============================================

describe("POST /consultations/:id/refund (admin)", () => {
  test("403 for anyone but an admin, before anything is read or written", async () => {
    await bookAndPay("c1");
    writes.length = 0;
    for (const who of [client, agent, ownerA]) {
      const out = await adminRefund(who, { reason: "goodwill" });
      assert.equal(out.status, 403);
    }
    assert.deepEqual(writes, []);
  });

  test("400 for a bad reason, and for reason other without a note", async () => {
    await bookAndPay("c1");
    assert.equal((await adminRefund(admin, {})).status, 400);
    assert.equal((await adminRefund(admin, { reason: "admin_goodwill" })).status, 400);
    assert.equal((await adminRefund(admin, { reason: "toString" })).status, 400);
    assert.equal((await adminRefund(admin, { reason: "other" })).status, 400);
    assert.equal((await adminRefund(admin, { reason: "other", note: "  " })).status, 400);
    assert.equal(refundRows().length, 0);
  });

  test("404 unknown id; 409 NOTHING_TO_REFUND on free and unpaid bookings", async () => {
    assert.equal((await adminRefund(admin, { reason: "goodwill" }, "nope")).status, 404);
    await bookFree("free1");
    const free = await adminRefund(admin, { reason: "goodwill" }, "free1");
    assert.equal(free.status, 409);
    assert.equal(free.body.error, "NOTHING_TO_REFUND");
    await bookFree("p1", { status: "pending_payment", paymentStatus: "pending", priceUsdCents: 600 });
    assert.equal((await adminRefund(admin, { reason: "goodwill" }, "p1")).body.error, "NOTHING_TO_REFUND");
  });

  test("a held fee: full refund out of the hold, status unchanged, note stored", async () => {
    await bookAndPay("c1");
    const out = await adminRefund(admin, { reason: "other", note: "Client could not join" });
    assert.equal(out.status, 201);
    assert.deepEqual(out.body.data.refund, { status: "processing", amount: FEE_NGN });
    const [row] = refundRows();
    assert.equal(row.reason, "admin_other");
    assert.equal(row.refundNote, "Client could not join");
    assert.equal(row.refundFundedFrom, "hold");
    assert.equal(bookingOf("c1")!.status, "scheduled");
    // Pending / processing / completed: ALREADY_REFUNDED.
    assert.equal((await adminRefund(admin, { reason: "goodwill" })).body.error, "ALREADY_REFUNDED");
  });
});

// ============================================
// Notifications
// ============================================

describe("refund notifications", () => {
  test("a refund tells the client it is on its way and the agent the fee was refunded", async () => {
    await bookAndPay("c1");
    await setStatus(client, "cancelled", "c1");
    const toClient = notified.find((n) => n.userId === client.uid && n.type === "consultation_refunded");
    const toAgent = notified.find((n) => n.userId === agent.uid && n.type === "consultation_refunded");
    assert.equal(toClient?.body, "Your refund of NGN 9,000.00 is on its way.");
    assert.match(toAgent!.body, /refunded/);
    assert.match(toAgent!.body, /held balance/);
  });
});
