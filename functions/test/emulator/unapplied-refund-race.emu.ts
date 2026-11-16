// ============================================
// Emulator test: refunds of unapplied payments under REAL Firestore transactions (issue #354)
// ============================================
//
// Run with `npm run test:emulator` (Auth + Firestore + Storage emulators, a
// `demo-` project, the real Express app, real ID tokens). Paystack is the
// in-process stub below (recorders on `paystackProvider`): no real charge or
// refund is ever made.
//
// The unit tests (test/consultations/consultation-unapplied-refunds.test.ts)
// run transactions one at a time on an in-memory store. Only real Firestore
// transactions show that payments settled AT THE SAME TIME (verify on return
// and the Paystack webhook, which settles through the same `settlePayment`;
// #247 is not merged, so direct `settlePayment` calls stand in for it) still
// leave ONE exception, ONE refund row and ONE Paystack refund call per
// reference, and never confirm a booking from a checkout retired by a
// reschedule.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { Timestamp } from "firebase-admin/firestore";

import { refreshIdToken, resetEmulators, RunningApi, rulesEnv, signUp, startApi, TestAccount } from "./helpers";

/* eslint-disable @typescript-eslint/no-explicit-any */

let api: RunningApi;
const accounts: Record<string, TestAccount> = {};
const tokens: Record<string, string> = {};
/** Every stubbed Paystack create-refund call: [reference, amountMinor, currency]. */
const refundCalls: Array<[string, number, string]> = [];
/** reference -> what the stubbed Paystack verify reports. */
const reports = new Map<string, any>();
let restore: () => void = () => undefined;

/** The charge of every booking here: ₦9,000.00 in kobo. */
const FEE = 900_000;

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
 * An UNPAID booking of `uclient` with `uagent` whose checkout `cons-<id>-ref`
 * was opened and whose quote lock passed an hour ago (so the agent may
 * reschedule it). Paystack reports that checkout PAID, exactly.
 */
async function seedPendingPastLock(id: string): Promise<string> {
  const { collections } = await import("../../src/utils/firebase");
  const now = Date.now();
  const day = new Date(now + 7 * 86_400_000);
  const dayUtc = Timestamp.fromDate(new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate())));
  const reference = `cons-${id}-ref`;
  await collections.consultations.doc(id).set({
    id, userId: accounts.uclient.uid, agentId: accounts.uagent.uid, clientName: "uclient",
    clientEmail: accounts.uclient.email, agentName: "uagent", type: "initial", scheduledDate: dayUtc,
    scheduledTime: "10:00", durationMinutes: 30, timezone: "Africa/Lagos", status: "pending_payment",
    paymentStatus: "pending", priceUsdCents: 600, chargedCurrency: "NGN", chargedAmountMinor: FEE,
    fxRate: 1500, fxRateAsOf: Timestamp.fromMillis(now - 7_200_000), fxRateSource: "cbn", fxMarginBps: 0,
    quoteLockedAt: Timestamp.fromMillis(now - 5_400_000), quoteExpiresAt: Timestamp.fromMillis(now - 3_600_000),
    transactionId: reference, checkoutUrl: `https://checkout.paystack.test/${reference}`, bookedVia: "client",
    createdAt: Timestamp.fromMillis(now - 7_200_000), updatedAt: Timestamp.fromMillis(now - 7_200_000),
  });
  reports.set(reference, {
    status: "success", metadata: { purpose: "consultation", consultationId: id },
    amount: FEE, currency: "NGN", paidAt: new Date().toISOString(),
  });
  return reference;
}

/** The stored booking, every refund row and every exception for booking `id`. */
async function stateOf(id: string): Promise<{ booking: any; refunds: any[]; fees: any[]; exceptions: any[] }> {
  const { collections } = await import("../../src/utils/firebase");
  const booking = (await collections.consultations.doc(id).get()).data();
  const txs = (await collections.transactions.where("consultationId", "==", id).get()).docs.map((d) => d.data());
  const exceptions = (await collections.consultationPaymentExceptions.where("consultationId", "==", id).get()).docs.map((d) => d.data());
  return { booking, refunds: txs.filter((t) => t.type === "refund"), fees: txs.filter((t) => t.type === "consultation_fee"), exceptions };
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
    getTransactionMetadata: ps.getTransactionMetadata,
  };
  let counter = 0;
  ps.createRefund = async (input: { reference: string; amount: { amountMinor: number; currency: string } }) => {
    refundCalls.push([input.reference, input.amount.amountMinor, input.amount.currency]);
    // A little latency, so parallel requests really overlap.
    await new Promise((resolve) => setTimeout(resolve, 20));
    return { id: String(++counter), status: "pending", transactionReference: input.reference, amount: input.amount.amountMinor, currency: input.amount.currency };
  };
  ps.findRefundsForTransaction = async () => [];
  ps.getTransactionMetadata = async (reference: string) => reports.get(reference) ?? null;
  restore = () => {
    ps.createRefund = saved.createRefund;
    ps.findRefundsForTransaction = saved.findRefundsForTransaction;
    ps.getTransactionMetadata = saved.getTransactionMetadata;
  };

  await principal("uagent", { role: "agent", agencyId: null, admin: false });
  await principal("uclient", { role: "client", agencyId: null, admin: false });
});

after(async () => {
  restore();
  await api.close();
  await (await rulesEnv()).cleanup();
});

describe("unapplied payments under concurrent settles (#354)", () => {
  test("reschedule after the lock, then verify x2 and settle x3 at once on the old checkout: one refund, booking not confirmed", async () => {
    const reference = await seedPendingPastLock("ub1");
    const moved = await api.call("PUT", "/consultations/ub1", tokens.uagent, { scheduledTime: "12:00" });
    assert.equal(moved.status, 200, JSON.stringify(moved.body));

    const { settlePayment } = await import("../../src/services/consultation-charge.service");
    const before = refundCalls.length;
    const results = await Promise.all([
      api.call("POST", "/consultations/public/verify", undefined, { reference }),
      api.call("POST", "/consultations/public/verify", undefined, { reference }),
      settlePayment("ub1", reference, reports.get(reference)),
      settlePayment("ub1", reference, reports.get(reference)),
      settlePayment("ub1", reference, reports.get(reference)),
    ]);
    for (const r of results.slice(0, 2) as any[]) {
      assert.equal(r.status, 409, JSON.stringify(r.body));
      assert.equal(r.body.error, "CONSULTATION_RESCHEDULED");
    }
    for (const o of results.slice(2) as any[]) assert.equal(o.kind, "rescheduled_refund_recorded");

    const s = await stateOf("ub1");
    assert.equal(s.booking.status, "pending_payment");
    assert.equal(s.booking.paymentStatus, "pending");
    assert.equal(s.booking.transactionId, undefined);
    assert.equal(s.fees.length, 0, "never a fee Transaction");
    assert.equal(s.exceptions.length, 1);
    assert.equal(s.exceptions[0].reason, "paid_for_rescheduled_slot");
    assert.equal(s.refunds.length, 1, "one refund row");
    assert.equal(s.refunds[0].amount, FEE);
    assert.equal(s.refunds[0].agentId, undefined);
    assert.equal(s.exceptions[0].refundId, s.refunds[0].id);
    assert.deepEqual(refundCalls.slice(before), [[reference, FEE, "NGN"]], "one Paystack refund, of exactly what was charged");
  });

  test("a payment after a cancel, settled 4 times at once: one refund row and one Paystack call", async () => {
    const reference = await seedPendingPastLock("ub2");
    const cancelled = await api.call("PUT", "/consultations/ub2/status", tokens.uagent, { status: "cancelled" });
    assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
    const { settlePayment } = await import("../../src/services/consultation-charge.service");
    const before = refundCalls.length;
    await Promise.all([0, 1, 2, 3].map(() => settlePayment("ub2", reference, reports.get(reference))));
    const s = await stateOf("ub2");
    assert.equal(s.booking.status, "cancelled");
    assert.equal(s.exceptions.length, 1);
    assert.equal(s.exceptions[0].reason, "booking_not_payable");
    assert.equal(s.refunds.length, 1);
    assert.equal(refundCalls.length - before, 1);
  });
});
