// ============================================
// Unit tests: resolving a mismatch-flagged refund (issue #413, decision 2026-11-21)
// ============================================
//
// Hermetic (test/consultations/harness.ts): in-memory Firestore, Paystack
// stubbed (refund create / list / fetch are recorders; nothing reaches the
// network), a fixed clock the tests move.
//
// A refund row is flagged `provider_refund_mismatch` when Paystack holds a
// refund for the charge that is not exactly the row's (a manual dashboard
// refund, say). `POST /consultations/:id/refund/resolve-mismatch { refundId,
// carriedBy }` settles it: X (what Paystack refunded) is read from Paystack,
// only once `processed`; no default; Seli's net per reference stays 0.

import { test, describe, before, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { useHarness, harness, docsIn, captureRes } from "./harness";
import {
  admin, agent, balanceOf, bookAndPay, bookingOf, client, ownerA, refOf, refundRows, reqFor, setStatus,
  webhook, refundEvent, TEST_PAYSTACK_SECRET,
} from "./refund-fixtures";
import { notificationService } from "../../src/services/notification.service";
import { consultationController } from "../../src/controllers/consultation.controller";
import { consultationRoutes } from "../../src/routes/consultation.routes";
import { consultationRefundService, planMismatchResolution } from "../../src/services/consultation-refund.service";
import { mismatchAdjustmentDocId, mismatchTopUpDocId } from "../../src/money/refund-id";
import { transactionService } from "../../src/services/transaction.service";
import { toClientTransaction } from "../../src/transactions/client-transaction";
import type { Transaction } from "../../src/types";

/* eslint-disable @typescript-eslint/no-explicit-any */

// ============================================
// Setup
// ============================================

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
 * A paid booking `id` whose refund is flagged as a mismatch: the first
 * create got no answer, then Paystack showed a refund of `X` (a manual one,
 * id "manual-1") that is not the row's. `cause` decides who cancelled:
 * the agent (P = A) or the client 24 h+ ahead (P = A - F).
 */
async function flagged(opts: { cause: "agent" | "client"; X: number; status?: string; currency?: string; id?: string }) {
  const id = opts.id ?? "c1";
  await bookAndPay(id, { fees: F });
  harness.refundBehaviour.push("network");
  assert.equal((await setStatus(opts.cause === "agent" ? agent : client, "cancelled", id)).status, 200);
  harness.paystackRefunds.set(refOf(id), [
    { id: `manual-${id}`, status: opts.status ?? "processed", transactionReference: refOf(id), amount: opts.X, currency: opts.currency ?? "NGN" },
  ]);
  harness.clock.advanceHours(0.25);
  await consultationRefundService.retryDueRefunds();
  const row = refundRows().find((r) => r.consultationId === id && !r.refundTopUpOf)!;
  assert.equal(row.refundFailureReason, "provider_refund_mismatch");
  return row;
}

/** POST /consultations/:id/refund/resolve-mismatch as `p`. */
async function resolveMismatch(p: any, body: Record<string, unknown>, id = "c1") {
  const { out, res } = captureRes();
  await consultationController.resolveRefundMismatch(reqFor(p, { params: { id }, body }), res);
  return out;
}

/** The agent's whole balance in NGN (held + available). */
async function agentTotal(): Promise<number> {
  const b = await balanceOf(agent);
  return b.heldBalance + b.availableBalance;
}

/**
 * Seli's net for booking `id`'s charge: what reached Seli (A - F), minus
 * every live refund Paystack holds for it, minus what Seli owes the agent.
 */
async function seliNet(id = "c1"): Promise<number> {
  const refunded = (harness.paystackRefunds.get(refOf(id)) ?? [])
    .filter((r) => r.status !== "failed")
    .reduce((sum, r) => sum + (r.amount ?? 0), 0);
  return A - F - refunded - (await agentTotal());
}

/** The stored doc `id` of transactions. */
function txOf(id: string): Record<string, any> | undefined {
  return docsIn("transactions").find(([docId]) => docId === id)?.[1];
}

/** Everything stored (for "nothing written" checks). */
function snapshot(): string {
  return JSON.stringify([docsIn("transactions"), docsIn("consultations")]);
}

// ============================================
// The rule, pure
// ============================================

describe("planMismatchResolution (pure): every case, and Seli's net is asserted 0", () => {
  // Agent-caused out of the hold: C = A - F, R = C, D = F (the agent at -F), P = A.
  const agentCaused = { amountMinor: A, paystackFeeMinor: F, creditMinor: A - F, plannedMinor: A, reversalMinor: A - F, debitMinor: F, agentCaused: true };
  // Client-caused out of the hold: P = A - F, R = C, no debit (the agent at 0).
  const clientCaused = { amountMinor: A, paystackFeeMinor: F, creditMinor: A - F, plannedMinor: A - F, reversalMinor: A - F, debitMinor: 0, agentCaused: false };

  test("X < P, agent carries: a top-up of P - X, no agent adjustment (the agent already gave P back)", () => {
    assert.deepEqual(planMismatchResolution({ ...agentCaused, refundedMinor: 500_000, carriedBy: "agent" }), {
      kind: "resolve", topUpMinor: A - 500_000, agentAdjustmentMinor: 0,
    });
  });
  test("X < P, client carries: no top-up; the agent is credited P - X (agent total A - F - X)", () => {
    assert.deepEqual(planMismatchResolution({ ...clientCaused, refundedMinor: 500_000, carriedBy: "client" }), {
      kind: "resolve", topUpMinor: 0, agentAdjustmentMinor: A - F - 500_000,
    });
  });
  test("X > P, agent caused: only the agent; debited X - P", () => {
    // A consistent agent-caused row with P below the charge (the rule's own numbers).
    const row = { amountMinor: 1_000, paystackFeeMinor: 10, creditMinor: 990, plannedMinor: 1_000, reversalMinor: 990, debitMinor: 10, agentCaused: true };
    assert.deepEqual(planMismatchResolution({ ...row, refundedMinor: 1_100, carriedBy: "agent" }), {
      kind: "resolve", topUpMinor: 0, agentAdjustmentMinor: -100,
    });
    assert.deepEqual(planMismatchResolution({ ...row, refundedMinor: 1_100, carriedBy: "client" }), {
      kind: "refuse", code: "CARRIED_BY_NOT_ALLOWED",
    });
  });
  test("X > P, client caused: refused for a person, whoever is named", () => {
    for (const carriedBy of ["agent", "client"] as const) {
      assert.deepEqual(planMismatchResolution({ ...clientCaused, refundedMinor: A, carriedBy }), {
        kind: "refuse", code: "NEEDS_MANUAL_RESOLUTION",
      });
    }
  });
  test("X = P: nothing to move", () => {
    assert.deepEqual(planMismatchResolution({ ...agentCaused, refundedMinor: A, carriedBy: "client" }), {
      kind: "resolve", topUpMinor: 0, agentAdjustmentMinor: 0,
    });
  });
  test("figures that do not net to 0 for Seli throw (never written)", () => {
    assert.throws(
      () => planMismatchResolution({ ...agentCaused, debitMinor: 0, refundedMinor: 500_000, carriedBy: "agent" }),
      /Seli's net would be/
    );
    assert.throws(() => planMismatchResolution({ ...agentCaused, refundedMinor: 1.5, carriedBy: "agent" }), /safe integer/);
  });
});

// ============================================
// Through the route
// ============================================

describe("POST /consultations/:id/refund/resolve-mismatch", () => {
  test("X < P, carriedBy agent: one top-up refund of G is sent; the agent stays at -F; Seli 0; the top-up's webhook completes it", async () => {
    const row = await flagged({ cause: "agent", X: 500_000 });
    const G = A - 500_000;
    assert.equal(await seliNet(), G, "before: Seli is holding the client's G");
    const out = await resolveMismatch(admin, { refundId: row.id, carriedBy: "agent" });
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.equal(out.body.data.alreadyResolved, false);
    const resolved = txOf(row.id)!;
    assert.equal(resolved.status, "completed");
    assert.equal(resolved.amount, 500_000, "the row says what Paystack refunded");
    assert.equal(resolved.plannedAmountMinor, A);
    assert.equal(resolved.providerRefundId, "manual-c1");
    assert.equal(resolved.refundFailureReason, undefined);
    assert.equal(resolved.refundMismatchResolution.carriedBy, "agent");
    assert.equal(resolved.refundMismatchResolution.refundedMinor, 500_000);
    const topUp = txOf(mismatchTopUpDocId(refOf("c1")))!;
    assert.equal(topUp.amount, G);
    assert.equal(topUp.refundFundedFrom, "mismatch_top_up");
    assert.equal(topUp.status, "processing");
    assert.deepEqual(harness.refundCalls.map((c) => c.amount), [{ amountMinor: G, currency: "NGN" }], "exactly one Paystack call: the top-up");
    assert.equal(txOf(mismatchAdjustmentDocId(refOf("c1"))), undefined, "no agent adjustment");
    assert.equal(await agentTotal(), -F, "the agent: the fee once, as planned");
    assert.equal(await seliNet(), 0);
    assert.equal(bookingOf("c1")!.refundStatus, "processing", "the booking follows the top-up");
    // The top-up's webhook (named by the charge's reference) moves the TOP-UP row.
    await webhook(refundEvent("refund.processed", refOf("c1"), { id: topUp.providerRefundId }));
    assert.equal(txOf(topUp.id)!.status, "completed");
    assert.equal(txOf(row.id)!.status, "completed");
    assert.equal(bookingOf("c1")!.refundStatus, "completed");
    // The client's history: what came back, in two rows; nothing internal.
    const views = [txOf(row.id), txOf(topUp.id)].map((t) => toClientTransaction(t as Transaction));
    assert.deepEqual(views.map((v) => [v.amount, v.refundState]), [[500_000, "refunded"], [G, "refunded"]]);
  });

  test("X < P, carriedBy client: the client keeps X, no top-up; the agent is credited so their total is A - F - X; Seli 0", async () => {
    const row = await flagged({ cause: "client", X: 500_000 });
    const out = await resolveMismatch(admin, { refundId: row.id, carriedBy: "client" });
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.equal(txOf(mismatchTopUpDocId(refOf("c1"))), undefined);
    assert.equal(harness.refundCalls.length, 0, "nothing more is sent");
    const adj = txOf(mismatchAdjustmentDocId(refOf("c1")))!;
    assert.equal(adj.type, "refund_adjustment");
    assert.equal(adj.adjustmentDirection, "credit");
    assert.equal(adj.amount, A - F - 500_000);
    assert.deepEqual(out.body.data.adjustment.amount, { amountMinor: A - F - 500_000, currency: "NGN" });
    assert.equal(await agentTotal(), A - F - 500_000);
    assert.equal(await seliNet(), 0);
    assert.equal(bookingOf("c1")!.refundStatus, "completed");
    // The adjustment is never in the client's history.
    const { out: list, res } = captureRes();
    const { transactionController } = await import("../../src/controllers/transaction.controller");
    await transactionController.getTransactions(reqFor(client), res);
    assert.ok(!(list.body.data as any[]).some((t) => t.type === "refund_adjustment"));
  });

  test("X > P on a client-caused refund: 409 NEEDS_MANUAL_RESOLUTION; stays frozen, flagged and listed; nothing written", async () => {
    // A full dashboard refund of a client-caused cancel (planned A - F).
    const row = await flagged({ cause: "client", X: A });
    const before = snapshot();
    for (const carriedBy of ["agent", "client"]) {
      const out = await resolveMismatch(admin, { refundId: row.id, carriedBy });
      assert.equal(out.status, 409, JSON.stringify(out.body));
      assert.equal(out.body.error, "NEEDS_MANUAL_RESOLUTION");
    }
    assert.equal(snapshot(), before);
    const { out, res } = captureRes();
    const { transactionController } = await import("../../src/controllers/transaction.controller");
    await transactionController.getTransactions(reqFor(admin, { query: { role: "admin", type: "refund", status: "failed" } }), res);
    assert.deepEqual(out.body.data.map((t: any) => t.id), [row.id], "still listed for admins");
  });

  test("Paystack's refund not processed yet: 409 PROVIDER_REFUND_NOT_PROCESSED, nothing written", async () => {
    const row = await flagged({ cause: "agent", X: 500_000, status: "pending" });
    const before = snapshot();
    const out = await resolveMismatch(admin, { refundId: row.id, carriedBy: "agent" });
    assert.equal(out.status, 409);
    assert.equal(out.body.error, "PROVIDER_REFUND_NOT_PROCESSED");
    assert.equal(out.body.data.providerStatus, "pending");
    assert.equal(snapshot(), before);
  });

  test("another currency, or more than one live refund at Paystack: 409 NEEDS_MANUAL_RESOLUTION", async () => {
    let row = await flagged({ cause: "agent", X: 600, currency: "USD" });
    assert.equal((await resolveMismatch(admin, { refundId: row.id, carriedBy: "agent" })).body.error, "NEEDS_MANUAL_RESOLUTION");
    harness.reset();
    row = await flagged({ cause: "agent", X: 500_000 });
    harness.paystackRefunds.get(refOf("c1"))!.push({ id: "manual-2", status: "processed", transactionReference: refOf("c1"), amount: 100_000, currency: "NGN" });
    assert.equal((await resolveMismatch(admin, { refundId: row.id, carriedBy: "agent" })).body.error, "NEEDS_MANUAL_RESOLUTION");
  });

  test("concurrent resolves: one resolves, the other is already resolved; one top-up, one Paystack call", async () => {
    const row = await flagged({ cause: "agent", X: 500_000 });
    const [one, two] = await Promise.all([
      resolveMismatch(admin, { refundId: row.id, carriedBy: "agent" }),
      resolveMismatch(admin, { refundId: row.id, carriedBy: "client" }),
    ]);
    assert.deepEqual([one.status, two.status], [200, 200]);
    assert.deepEqual([one.body.data.alreadyResolved, two.body.data.alreadyResolved].sort(), [false, true]);
    const topUps = refundRows().filter((r) => r.refundTopUpOf);
    const adjustments = docsIn("transactions").filter(([, d]) => d.type === "refund_adjustment");
    // Exactly one of the two outcomes was written, never both.
    assert.equal(topUps.length + adjustments.length, 1);
    assert.ok(harness.refundCalls.length <= 1);
    assert.equal(await seliNet(), 0);
  });

  test("a retry after a top-up failure never sends a second top-up", async () => {
    const row = await flagged({ cause: "agent", X: 500_000 });
    // Paystack CREATES the top-up, but our answer is lost.
    harness.refundBehaviour.push("reached_then_network");
    assert.equal((await resolveMismatch(admin, { refundId: row.id, carriedBy: "agent" })).status, 200);
    const topUpId = mismatchTopUpDocId(refOf("c1"));
    assert.equal(txOf(topUpId)!.status, "pending");
    // The admin asks again, and the retry job runs: the existing top-up is adopted.
    const again = await resolveMismatch(admin, { refundId: row.id, carriedBy: "agent" });
    assert.equal(again.status, 200);
    assert.equal(again.body.data.alreadyResolved, true);
    harness.clock.advanceHours(0.25);
    await consultationRefundService.retryDueRefunds();
    assert.equal(txOf(topUpId)!.status, "processing");
    const liveTopUps = harness.paystackRefunds.get(refOf("c1"))!.filter((r) => r.id !== "manual-c1" && r.status !== "failed");
    assert.equal(liveTopUps.length, 1, "one top-up at Paystack");
    assert.equal(harness.refundCalls.length, 1, "one create call ever");
    assert.equal(await seliNet(), 0);

    // The top-up then FAILS at Paystack: asking again re-sends on the SAME row (one live top-up).
    liveTopUps[0].status = "failed";
    await webhook(refundEvent("refund.failed", refOf("c1"), { id: liveTopUps[0].id }));
    assert.equal(txOf(topUpId)!.status, "failed");
    const third = await resolveMismatch(admin, { refundId: row.id, carriedBy: "agent" });
    assert.equal(third.status, 200);
    const live = harness.paystackRefunds.get(refOf("c1"))!.filter((r) => r.id !== "manual-c1" && r.status !== "failed");
    assert.equal(live.length, 1, "still one live top-up");
    assert.equal(refundRows().filter((r) => r.refundTopUpOf).length, 1, "one top-up row ever");
  });

  test("authz and validation: 403 non-admins, 400 bad body (no default), 404 another booking, 409 not a mismatch, 502 Paystack down, 401 at the route", async () => {
    const row = await flagged({ cause: "agent", X: 500_000 });
    for (const p of [agent, ownerA, client]) {
      assert.equal((await resolveMismatch(p, { refundId: row.id, carriedBy: "agent" })).status, 403);
    }
    assert.equal((await resolveMismatch(admin, { refundId: row.id })).status, 400, "carriedBy is required");
    assert.equal((await resolveMismatch(admin, { refundId: row.id, carriedBy: "seli" })).status, 400);
    assert.equal((await resolveMismatch(admin, { refundId: "nope", carriedBy: "agent" })).status, 400);
    assert.equal((await resolveMismatch(admin, { refundId: row.id, carriedBy: "agent" }, "c2")).status, 404);
    harness.failNextRefundLookup = true;
    assert.equal((await resolveMismatch(admin, { refundId: row.id, carriedBy: "agent" })).status, 502);
    assert.equal(txOf(row.id)!.status, "failed", "nothing written by a refusal");
    // A refund that is not flagged.
    await bookAndPay("c3", { fees: F });
    await setStatus(agent, "cancelled", "c3");
    const live = refundRows().find((r) => r.consultationId === "c3")!;
    assert.equal((await resolveMismatch(admin, { refundId: live.id, carriedBy: "agent" }, "c3")).body.error, "NOT_MISMATCH");
    const layer = (consultationRoutes as any).stack.find((l: any) => l.route?.path === "/:id/refund/resolve-mismatch");
    assert.ok(layer);
    assert.equal(layer.route.stack[0].name, "verifyAuth");
  });

  test("the admin's figures: a credit and a top-up count once, Seli's net 0 in the admin stats too", async () => {
    await flagged({ cause: "client", X: 500_000 });
    const row = refundRows()[0];
    await resolveMismatch(admin, { refundId: row.id, carriedBy: "client" });
    const rows = docsIn("transactions").map(([, d]) => d as Transaction);
    const s = transactionService.computeStats(rows, harness.clock.now(), { feeBreakdown: true }).byCurrency[0];
    // Net revenue = what Seli owes the agent for the reference = A - F - X.
    assert.equal(s.totalRevenue, A - F - 500_000);
  });
});
