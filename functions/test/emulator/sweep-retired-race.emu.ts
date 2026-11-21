// ============================================
// Emulator test: the abandoned-booking sweep vs verify on a RETIRED checkout (issue #397)
// ============================================
//
// Run with `npm run test:emulator` (Auth + Firestore + Storage emulators, a
// `demo-` project, the real Express app). Paystack is the in-process stub
// below (recorders on `paystackProvider`): no real lookup, charge or refund.
//
// The unit tests (test/consultations/consultation-abandoned-sweep.test.ts)
// run one transaction at a time on an in-memory store. Only real Firestore
// transactions show that the hourly sweep and the payer's return-page verify
// (`POST /consultations/public/verify`) settling the SAME paid retired
// checkout at the same time still leave ONE exception, ONE refund row and at
// most ONE fee debit: the sweep never writes money rows itself, everything
// goes through `settlePayment`, which is idempotent per reference.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { Timestamp } from "firebase-admin/firestore";

import { refreshIdToken, resetEmulators, RunningApi, rulesEnv, signUp, startApi, TestAccount } from "./helpers";

/* eslint-disable @typescript-eslint/no-explicit-any */

let api: RunningApi;
const accounts: Record<string, TestAccount> = {};
/** Every stubbed Paystack create-refund call: [reference, amountMinor, currency]. */
const refundCalls: Array<[string, number, string]> = [];
/** reference -> what the stubbed Paystack verify reports. */
const reports = new Map<string, any>();
/** Restores the real Paystack provider methods after the suite. */
let restore: () => void = () => undefined;

/** The charge of the booking here: ₦9,000.00 in kobo. */
const FEE = 900_000;
/** Paystack's processing fee on that charge, as Paystack reports it. */
const PAYSTACK_FEE = 15_000;
const HOUR_MS = 3_600_000;

/** A signed-in account with role claims and a user doc. */
async function principal(name: string, claims: Record<string, unknown>): Promise<void> {
  const account = await signUp(name);
  const { auth, collections } = await import("../../src/utils/firebase");
  await auth.setCustomUserClaims(account.uid, claims);
  accounts[name] = account;
  await refreshIdToken(account);
  await collections.users.doc(account.uid).set({ id: account.uid, email: account.email, firstName: name, lastName: "T" });
}

/**
 * An UNPAID booking whose only checkout was RETIRED by an agent-side
 * reschedule (#354: no `transactionId`, one `supersededCheckouts` entry
 * with `retiredBy: "reschedule"`), and whose quote lock ended 30 hours ago
 * (so the sweep picks it up). Paystack reports the retired checkout PAID.
 */
async function seedRetiredPaid(id: string): Promise<string> {
  const { collections } = await import("../../src/utils/firebase");
  const now = Date.now();
  const day = new Date(now + 7 * 86_400_000);
  const dayUtc = Timestamp.fromDate(new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate())));
  const reference = `cons-${id}-retired`;
  // The one charge snapshot both the booking and the retired entry carry.
  const snapshot = {
    priceUsdCents: 600, chargedCurrency: "NGN", chargedAmountMinor: FEE,
    fxRate: 1500, fxRateAsOf: Timestamp.fromMillis(now - 31 * HOUR_MS), fxRateSource: "cbn", fxMarginBps: 0,
    quoteLockedAt: Timestamp.fromMillis(now - 30.5 * HOUR_MS), quoteExpiresAt: Timestamp.fromMillis(now - 30 * HOUR_MS),
  };
  await collections.consultations.doc(id).set({
    id, userId: accounts.uclient.uid, agentId: accounts.uagent.uid, clientName: "uclient",
    clientEmail: accounts.uclient.email, agentName: "uagent", type: "initial", scheduledDate: dayUtc,
    scheduledTime: "12:00", durationMinutes: 30, timezone: "Africa/Lagos", status: "pending_payment",
    paymentStatus: "pending", bookedVia: "client", ...snapshot,
    // Issue #411: what booking creation writes (the sweep selects on it).
    sweepSetAside: false,
    supersededCheckouts: [{
      ...snapshot, reference, supersededAt: Timestamp.fromMillis(now - 29 * HOUR_MS),
      retiredBy: "reschedule", retiredByAgentId: accounts.uagent.uid,
    }],
    createdAt: Timestamp.fromMillis(now - 31 * HOUR_MS), updatedAt: Timestamp.fromMillis(now - 29 * HOUR_MS),
  });
  reports.set(reference, {
    status: "success", metadata: { purpose: "consultation", consultationId: id },
    amount: FEE, currency: "NGN", paidAt: new Date().toISOString(), fees: PAYSTACK_FEE,
  });
  return reference;
}

/** The stored booking and every money row / exception for booking `id`. */
async function stateOf(id: string) {
  const { collections } = await import("../../src/utils/firebase");
  const booking = (await collections.consultations.doc(id).get()).data() as any;
  const txs = (await collections.transactions.where("consultationId", "==", id).get()).docs.map((d) => d.data() as any);
  const exceptions = (await collections.consultationPaymentExceptions.where("consultationId", "==", id).get()).docs.map((d) => d.data());
  // Every agent fee debit in the store (this suite writes only one booking's worth).
  const debits = (await collections.transactions.where("type", "==", "paystack_fee_debit").get()).docs.map((d) => d.data() as any);
  return {
    booking,
    refunds: txs.filter((t) => t.type === "refund"),
    fees: txs.filter((t) => t.type === "consultation_fee"),
    debits,
    exceptions: exceptions as any[],
  };
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
    // A little latency, so the parallel calls really overlap.
    await new Promise((resolve) => setTimeout(resolve, 20));
    return { id: String(++counter), status: "pending", transactionReference: input.reference, amount: input.amount.amountMinor, currency: input.amount.currency };
  };
  ps.findRefundsForTransaction = async () => [];
  ps.getTransactionMetadata = async (reference: string) => {
    // Latency here too, so the sweep's lookup and verify's lookup interleave.
    await new Promise((resolve) => setTimeout(resolve, 10));
    return reports.get(reference) ?? null;
  };
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

describe("the sweep and verify settling one paid retired checkout at once (#397)", () => {
  test("one exception, one refund row, at most one fee debit; the booking ends cancelled, never confirmed", async () => {
    const reference = await seedRetiredPaid("sr1");
    const { consultationService } = await import("../../src/services/consultation.service");

    const before = refundCalls.length;
    const [sweep, ...verifies] = await Promise.all([
      consultationService.sweepAbandonedBookings(),
      api.call("POST", "/consultations/public/verify", undefined, { reference }),
      api.call("POST", "/consultations/public/verify", undefined, { reference }),
    ]);
    // Verify never confirms a retired checkout (#354).
    for (const r of verifies as any[]) {
      assert.equal(r.status, 409, JSON.stringify(r.body));
    }
    // The sweep found the retired payment recorded (by itself or by a verify)
    // and, every checkout being handled, cancelled the booking.
    assert.equal(sweep.errors, 0, JSON.stringify(sweep));
    assert.equal(sweep.cancelled, 1, JSON.stringify(sweep));

    const s = await stateOf("sr1");
    assert.equal(s.booking.status, "cancelled");
    assert.equal(s.booking.cancelledBy, "system");
    assert.equal(s.booking.paymentStatus, "pending");
    assert.equal(s.fees.length, 0, "never a fee Transaction");
    assert.equal(s.exceptions.length, 1, "one exception");
    assert.equal(s.exceptions[0].reason, "paid_for_rescheduled_slot");
    assert.equal(s.refunds.length, 1, "one refund row");
    assert.equal(s.refunds[0].amount, FEE, "refunded in full (agent-caused)");
    assert.ok(s.debits.length <= 1, "at most one fee debit");
    assert.equal(s.debits.length, 1, "the agent who moved the booking is debited Paystack's fee once");
    assert.equal(s.debits[0].agentId, accounts.uagent.uid);
    assert.equal(s.debits[0].amount, PAYSTACK_FEE);
    assert.deepEqual(refundCalls.slice(before), [[reference, FEE, "NGN"]], "one Paystack refund, in full");

    // A second sweep run: nothing new (the booking is no longer pending).
    const again = await consultationService.sweepAbandonedBookings();
    assert.equal(again.cancelled, 0);
    const s2 = await stateOf("sr1");
    assert.equal(s2.refunds.length, 1);
    assert.equal(s2.debits.length, 1);
  });
});
