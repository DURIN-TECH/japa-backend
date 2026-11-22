// ============================================
// Emulator test: the refund-service chain under REAL Firestore transactions
// (issues #413, #383, #381, #382)
// ============================================
//
// Run with `npm run test:emulator` (Auth + Firestore + Storage emulators, a
// `demo-` project, the real Express app, real ID tokens). Paystack is the
// in-process stub below (recorders on `paystackProvider`): no real charge or
// refund is ever made, and nothing reaches the network.
//
// The unit tests run their transactions one at a time on an in-memory store.
// Only real Firestore transactions show that requests sent AT THE SAME TIME
// still leave the money right:
//  1. (#382) a no-show report and a cancel at once: exactly one commits;
//  2. (#382) two admins deciding one report at once (refund vs release): one
//     wins, at most one refund row, the other is 409 NO_SHOW_REPORT_RESOLVED;
//  3. (#382) a report freezes the fee: past `releaseAt` a withdrawal of it
//     is still refused; a release decision makes it withdrawable;
//  4. (#413 B) two admins closing a held refund at once: closed once;
//  5. (#383 / #381) the webhook, the processing poll and an admin retry at
//     once on one refund row: forward-only, never two Paystack refunds, and a
//     late refund.failed for a retired attempt never fails the new one.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { Timestamp } from "firebase-admin/firestore";

import { refreshIdToken, resetEmulators, RunningApi, rulesEnv, signUp, startApi, TestAccount } from "./helpers";

/* eslint-disable @typescript-eslint/no-explicit-any */

let api: RunningApi;
const accounts: Record<string, TestAccount> = {};
const tokens: Record<string, string> = {};
/** Every stubbed Paystack create-refund call (the charge reference). */
const refundCalls: string[] = [];
/** reference -> refunds the stub "Paystack" holds. */
const paystackRefunds = new Map<string, any[]>();
let restore: () => void = () => undefined;

/** A: ₦9,000.00 in kobo; F: Paystack's fee, ₦150.00. */
const A = 900_000;
const F = 15_000;

/** A signed-in account with role claims and a user doc. */
async function principal(name: string, claims: Record<string, unknown>): Promise<void> {
  const account = await signUp(name);
  const { auth, collections } = await import("../../src/utils/firebase");
  await auth.setCustomUserClaims(account.uid, claims);
  accounts[name] = account;
  tokens[name] = await refreshIdToken(account);
  await collections.users.doc(account.uid).set({ id: account.uid, email: account.email, firstName: name, lastName: "T" });
}

/**
 * A PAID booking of `client` with `agent` whose slot STARTED `startedAgoMin`
 * minutes ago (Africa/Lagos, UTC+1), its fee Transaction (fee F known, still
 * held: release = slot end + 24 h) and the agent's bank account, written as
 * the backend writes them.
 */
async function seedStartedBooking(id: string, agentName: string, clientName: string, opts: { fee?: number; startedAgoMin?: number } = {}): Promise<void> {
  const { collections } = await import("../../src/utils/firebase");
  const now = Timestamp.now();
  const fee = opts.fee ?? F;
  const start = new Date(Date.now() - (opts.startedAgoMin ?? 60) * 60_000);
  start.setUTCSeconds(0, 0);
  // The booking's local (Lagos) date and HH:mm that give exactly `start`.
  const lagos = new Date(start.getTime() + 3_600_000);
  const day = Timestamp.fromDate(new Date(Date.UTC(lagos.getUTCFullYear(), lagos.getUTCMonth(), lagos.getUTCDate())));
  const time = `${String(lagos.getUTCHours()).padStart(2, "0")}:${String(lagos.getUTCMinutes()).padStart(2, "0")}`;
  const reference = `cons-${id}-ref`;
  const agentUid = accounts[agentName].uid;
  await collections.consultations.doc(id).set({
    id, userId: accounts[clientName].uid, agentId: agentUid, agencyId: "agency-emu", clientName, clientEmail: accounts[clientName].email,
    agentName, type: "initial", scheduledDate: day, scheduledTime: time, durationMinutes: 30,
    timezone: "Africa/Lagos", status: "scheduled", paymentStatus: "paid",
    priceUsdCents: 600, chargedCurrency: "NGN", chargedAmountMinor: A, transactionId: reference,
    bookedVia: "client", createdAt: now, updatedAt: now,
  });
  const known = fee < A;
  await collections.transactions.doc(`fee-${id}`).set({
    id: `fee-${id}`, userId: accounts[clientName].uid, agentId: agentUid, consultationId: id,
    type: "consultation_fee", amount: A, currency: "NGN", status: "completed", isEscrow: false,
    paymentProvider: "paystack", providerTransactionId: reference, description: "Consultation fee",
    paystackFeeStatus: known ? "known" : "fee_not_less_than_amount", paystackFeeMinor: fee,
    ...(known ? { agentCreditMinor: A - fee } : {}),
    feeHold: {
      state: "held",
      slotStartAt: Timestamp.fromDate(start),
      releaseAt: Timestamp.fromMillis(start.getTime() + 30 * 60_000 + 24 * 3_600_000),
    },
    createdAt: now, updatedAt: now,
  });
  await collections.bankAccounts.doc(`bank-${agentName}`).set({
    id: `bank-${agentName}`, userId: agentUid, accountName: "Holder", bankName: "Test Bank",
    accountNumber: "0123456789", isMain: true, createdAt: now, updatedAt: now,
  });
}

/** Every refund row stored for booking `id`. */
async function refundsOf(id: string): Promise<any[]> {
  const { collections } = await import("../../src/utils/firebase");
  const snap = await collections.transactions.where("consultationId", "==", id).get();
  return snap.docs.map((d) => d.data()).filter((d) => d.type === "refund");
}

/** The stored no-show report of booking `id`, or undefined. */
async function reportOf(id: string): Promise<any> {
  const { collections } = await import("../../src/utils/firebase");
  return (await collections.noShowReports.doc(id).get()).data();
}

before(async () => {
  await rulesEnv();
  await resetEmulators();
  api = await startApi();

  // ---- Paystack: in-process recorders, never the network ----
  const { paystackProvider } = await import("../../src/services/billing/paystack.provider");
  const ps = paystackProvider as any;
  const saved = {
    createRefund: ps.createRefund,
    findRefundsForTransaction: ps.findRefundsForTransaction,
    fetchRefund: ps.fetchRefund,
    getTransactionMetadata: ps.getTransactionMetadata,
  };
  let counter = 0;
  ps.createRefund = async (input: { reference: string; amount: { amountMinor: number; currency: string } }) => {
    refundCalls.push(input.reference);
    // A little latency, so parallel requests really overlap.
    await new Promise((resolve) => setTimeout(resolve, 20));
    const refund = { id: String(++counter), status: "pending", transactionReference: input.reference, amount: input.amount.amountMinor, currency: input.amount.currency };
    paystackRefunds.set(input.reference, [...(paystackRefunds.get(input.reference) ?? []), refund]);
    return { ...refund };
  };
  ps.findRefundsForTransaction = async (reference: string) => (paystackRefunds.get(reference) ?? []).map((r) => ({ ...r }));
  ps.fetchRefund = async (refundId: string) => {
    await new Promise((resolve) => setTimeout(resolve, 10));
    for (const list of paystackRefunds.values()) {
      const found = list.find((r) => r.id === refundId);
      if (found) return { ...found };
    }
    return null;
  };
  // Every fee is stored on the fee row here: a lookup is never needed.
  ps.getTransactionMetadata = async () => null;
  restore = () => Object.assign(ps, saved);

  for (const n of ["hagent1", "hagent2", "hagent3", "hagent4", "hagent5"]) await principal(n, { role: "agent", agencyId: null, admin: false });
  await principal("hclient", { role: "client", agencyId: null, admin: false });
  await principal("hadmin", { role: "admin", agencyId: null, admin: true });
});

after(async () => {
  restore();
  await api.close();
  await (await rulesEnv()).cleanup();
});

describe("no-show reports under concurrent requests (#382)", () => {
  test("a report and the agent's cancel at once: exactly one commits", async () => {
    await seedStartedBooking("nb1", "hagent1", "hclient");
    const [report, cancel] = await Promise.all([
      api.call("POST", "/consultations/nb1/no-show-report", tokens.hclient, { note: "No one joined" }),
      api.call("PUT", "/consultations/nb1/status", tokens.hagent1, { status: "cancelled" }),
    ]);
    const statuses = [report.status, cancel.status];
    assert.ok(
      (report.status === 201 && cancel.status === 409) || (report.status === 409 && cancel.status === 200),
      JSON.stringify({ statuses, report: report.body, cancel: cancel.body })
    );
    if (report.status === 201) {
      assert.equal(cancel.body.error, "NO_SHOW_REPORT_OPEN");
      assert.equal((await refundsOf("nb1")).length, 0);
    } else {
      assert.equal(await reportOf("nb1"), undefined);
      assert.equal((await refundsOf("nb1")).length, 1);
    }
  });

  test("two admins decide at once (refund vs release): one wins, at most one refund row", async () => {
    await seedStartedBooking("nb2", "hagent2", "hclient");
    assert.equal((await api.call("POST", "/consultations/nb2/no-show-report", tokens.hclient, {})).status, 201);
    const before = refundCalls.length;
    const [one, two] = await Promise.all([
      api.call("POST", "/consultations/nb2/no-show-report/resolve", tokens.hadmin, { decision: "agent_no_show" }),
      api.call("POST", "/consultations/nb2/no-show-report/resolve", tokens.hadmin, { decision: "meeting_happened" }),
    ]);
    assert.deepEqual([one.status, two.status].sort(), [200, 409], JSON.stringify([one.body, two.body]));
    const loser = one.status === 409 ? one : two;
    assert.equal(loser.body.error, "NO_SHOW_REPORT_RESOLVED");
    const report = await reportOf("nb2");
    const rows = await refundsOf("nb2");
    if (report.status === "refunded") {
      assert.equal(rows.length, 1);
      assert.equal(rows[0].reason, "admin_agent_no_show");
      assert.equal(rows[0].amount, A);
      assert.equal(refundCalls.length - before, 1);
    } else {
      assert.equal(report.status, "released");
      assert.equal(rows.length, 0);
      assert.equal(refundCalls.length - before, 0);
    }
    const { collections } = await import("../../src/utils/firebase");
    const fee = (await collections.transactions.doc("fee-nb2").get()).data()!;
    assert.equal(fee.feeHoldFrozenByReportId, undefined, "the freeze is lifted either way");
  });

  test("a report freezes the fee past releaseAt (withdrawal refused); meeting_happened makes it withdrawable", async () => {
    await seedStartedBooking("nb3", "hagent3", "hclient");
    assert.equal((await api.call("POST", "/consultations/nb3/no-show-report", tokens.hclient, {})).status, 201);
    // Time passes: the stored release time is now in the past.
    const { collections } = await import("../../src/utils/firebase");
    await collections.transactions.doc("fee-nb3").update({ "feeHold.releaseAt": Timestamp.fromMillis(Date.now() - 60_000) });
    const refused = await api.call("POST", "/bank-accounts/withdraw", tokens.hagent3, { bankAccountId: "bank-hagent3", amount: A - F });
    assert.equal(refused.status, 400, "the frozen fee is not withdrawable");
    assert.equal(
      (await api.call("POST", "/consultations/nb3/no-show-report/resolve", tokens.hadmin, { decision: "meeting_happened" })).status,
      200
    );
    const allowed = await api.call("POST", "/bank-accounts/withdraw", tokens.hagent3, { bankAccountId: "bank-hagent3", amount: A - F });
    assert.equal(allowed.status, 201, JSON.stringify(allowed.body));
  });
});

describe("resolving a refund mismatch under concurrent requests (#413, decision 2026-11-21)", () => {
  test("two admins resolve one flagged refund at once (agent vs client): one outcome written, Seli's net 0", async () => {
    await seedStartedBooking("mb1", "hagent4", "hclient", { startedAgoMin: -7 * 24 * 60 });
    const { collections } = await import("../../src/utils/firebase");
    const { consultationRefundService } = await import("../../src/services/consultation-refund.service");
    // The agent cancels. Then it turns out the only refund Paystack really
    // holds for the charge is a manual dashboard one of ₦5,000 (the stub's
    // own create is dropped), and the engine's next look-up flags the row.
    assert.equal((await api.call("PUT", "/consultations/mb1/status", tokens.hagent4, { status: "cancelled" })).status, 200);
    const [row] = await refundsOf("mb1");
    paystackRefunds.set("cons-mb1-ref", [{ id: "manual-mb1", status: "processed", transactionReference: "cons-mb1-ref", amount: 500_000, currency: "NGN" }]);
    await collections.transactions.doc(row.id).update({ status: "pending", refundProviderCalls: 1, refundLeaseUntil: Timestamp.fromMillis(0) });
    await consultationRefundService.processRefund(row.id);
    const flagged = (await collections.transactions.doc(row.id).get()).data()!;
    assert.equal(flagged.refundFailureReason, "provider_refund_mismatch", JSON.stringify(flagged));
    const callsBefore = refundCalls.length;
    const results = await Promise.all([
      api.call("POST", "/consultations/mb1/refund/resolve-mismatch", tokens.hadmin, { refundId: row.id, carriedBy: "agent" }),
      api.call("POST", "/consultations/mb1/refund/resolve-mismatch", tokens.hadmin, { refundId: row.id, carriedBy: "client" }),
    ]);
    assert.deepEqual(results.map((r) => r.status), [200, 200], JSON.stringify(results.map((r) => r.body)));
    assert.deepEqual(results.map((r) => r.body.data.alreadyResolved).sort(), [false, true]);
    const all = (await collections.transactions.where("consultationId", "==", "mb1").get()).docs.map((d) => d.data());
    const topUps = all.filter((t) => t.refundTopUpOf);
    const adjustments = all.filter((t) => t.type === "refund_adjustment");
    assert.equal(topUps.length + adjustments.length, 1, "exactly one outcome written");
    assert.ok(refundCalls.length - callsBefore <= 1, "at most the one top-up");
    // Seli's net for the reference: A - F - refunded - the agent's total, through the real stats route.
    const refunded = (paystackRefunds.get("cons-mb1-ref") ?? []).filter((r) => r.status !== "failed").reduce((s, r) => s + r.amount, 0);
    const stats = await api.call("GET", "/transactions/stats", tokens.hagent4);
    const ngn = stats.body.data.byCurrency.find((r: any) => r.currency === "NGN");
    assert.equal(A - F - refunded - (ngn.heldBalance + ngn.availableBalance), 0);
  });
});

describe("the held refund close and the refund attempts under concurrent requests (#413, #383, #381)", () => {
  test("two admins close one held client-cancel refund (fee >= charge) at once: closed once", async () => {
    // A future slot (the client may cancel 24 h+ ahead), and Paystack's fee is the whole charge.
    await seedStartedBooking("hb1", "hagent4", "hclient", { fee: A, startedAgoMin: -7 * 24 * 60 });
    assert.equal((await api.call("PUT", "/consultations/hb1/status", tokens.hclient, { status: "cancelled" })).status, 200);
    const [held] = await refundsOf("hb1");
    assert.equal(held.refundHeldReason, "fee_not_less_than_amount");
    const results = await Promise.all([0, 1].map(() => api.call("POST", "/consultations/hb1/refund/close", tokens.hadmin, {})));
    assert.deepEqual(results.map((r) => r.status), [200, 200], JSON.stringify(results.map((r) => r.body)));
    assert.deepEqual(results.map((r) => r.body.data.alreadyClosed).sort(), [false, true]);
    const [row] = await refundsOf("hb1");
    assert.equal(row.status, "closed");
    assert.equal(row.amount, 0);
    assert.equal(refundCalls.filter((r) => r === "cons-hb1-ref").length, 0, "no Paystack call");
  });

  test("webhook, poll and admin retry at once: forward-only, one new Paystack refund, a late failed of the retired attempt changes nothing", async () => {
    await seedStartedBooking("hb2", "hagent5", "hclient", { startedAgoMin: -7 * 24 * 60 });
    assert.equal((await api.call("PUT", "/consultations/hb2/status", tokens.hagent5, { status: "cancelled" })).status, 200);
    const [first] = await refundsOf("hb2");
    const { consultationRefundService } = await import("../../src/services/consultation-refund.service");
    // Attempt 1 fails at Paystack (its webhook arrives).
    paystackRefunds.get("cons-hb2-ref")![0].status = "failed";
    await consultationRefundService.handleWebhook({ event: "refund.failed", data: { id: first.providerRefundId, transaction_reference: "cons-hb2-ref", status: "failed" } });
    assert.equal((await refundsOf("hb2"))[0].status, "failed");
    const callsBefore = refundCalls.length;

    // The admin retry, the poll and a late refund.failed for attempt 1, all at once.
    const [retry] = await Promise.all([
      api.call("POST", "/consultations/hb2/refund", tokens.hadmin, { refundId: first.id }),
      consultationRefundService.pollProcessingRefunds(),
      consultationRefundService.handleWebhook({ event: "refund.failed", data: { id: first.providerRefundId, transaction_reference: "cons-hb2-ref", status: "failed" } }),
    ]);
    assert.equal(retry.status, 200, JSON.stringify(retry.body));
    let [row] = await refundsOf("hb2");
    assert.equal(row.status, "processing", "attempt 2 is on its way");
    assert.notEqual(row.providerRefundId, first.providerRefundId);
    assert.deepEqual(row.previousProviderRefundIds, [first.providerRefundId]);
    assert.equal(refundCalls.length - callsBefore, 1, "exactly one new Paystack refund");

    // Attempt 2 is processed; its webhook and the poll arrive at once.
    const current = paystackRefunds.get("cons-hb2-ref")!.find((r) => r.id === row.providerRefundId)!;
    current.status = "processed";
    const { collections } = await import("../../src/utils/firebase");
    await collections.transactions.doc(row.id).update({ processingSince: Timestamp.fromMillis(Date.now() - 2 * 3_600_000) });
    await Promise.all([
      consultationRefundService.pollProcessingRefunds(),
      consultationRefundService.handleWebhook({ event: "refund.processed", data: { id: row.providerRefundId, transaction_reference: "cons-hb2-ref", status: "processed" } }),
      consultationRefundService.handleWebhook({ event: "refund.failed", data: { id: first.providerRefundId, transaction_reference: "cons-hb2-ref", status: "failed" } }),
    ]);
    [row] = await refundsOf("hb2");
    assert.equal(row.status, "completed");
    const booking = (await collections.consultations.doc("hb2").get()).data()!;
    assert.equal(booking.refundStatus, "completed");
    assert.equal(refundCalls.length - callsBefore, 1, "still one: the poll never creates");
  });
});
