// ============================================
// Emulator test: consultation refunds under REAL Firestore transactions (issue #317)
// ============================================
//
// Run with `npm run test:emulator` (Auth + Firestore + Storage emulators,
// a `demo-` project, the real Express app, real ID tokens). Paystack is the
// in-process stub below (recorders on `paystackProvider`): no real charge or
// refund is ever made.
//
// The unit tests (test/consultations/consultation-refunds.test.ts) run their
// transactions one at a time on an in-memory store. Only real Firestore
// transactions can show that requests sent AT THE SAME TIME still leave:
//  1. exactly one refund row for one charge (two admins at once, a client
//     and the agent cancelling at once), and one Paystack refund call;
//  2. a held fee never withdrawable, even with a withdrawal racing the
//     agent's own cancel;
//  3. a refund of a RELEASED fee and a withdrawal of that fee serialised by
//     the agent's `withdrawalLocks/{uid}` lock: either the withdrawal went
//     first and the refund records the whole shortfall (balance negative),
//     or the refund went first and the withdrawal is refused. Never both
//     with a shortfall of 0.

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
let restore: () => void = () => undefined;

/** The fee of every booking here: ₦9,000.00 in kobo. */
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
 * A PAID booking of `client` with `agent`, its fee Transaction and the
 * agent's bank account, written as the backend writes them. `released`
 * puts the fee's release time in the past (the meeting has happened).
 */
async function seedPaidBooking(id: string, agentName: string, clientName: string, released = false): Promise<void> {
  const { collections } = await import("../../src/utils/firebase");
  const now = Timestamp.now();
  const day = new Date(Date.now() + (released ? -3 : 7) * 86_400_000);
  const dayUtc = Timestamp.fromDate(new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate())));
  const reference = `cons-${id}-ref`;
  const agentUid = accounts[agentName].uid;
  await collections.consultations.doc(id).set({
    id, userId: accounts[clientName].uid, agentId: agentUid, clientName, clientEmail: accounts[clientName].email,
    agentName, type: "initial", scheduledDate: dayUtc, scheduledTime: "10:00", durationMinutes: 30,
    timezone: "Africa/Lagos", status: released ? "completed" : "scheduled", paymentStatus: "paid",
    priceUsdCents: 600, chargedCurrency: "NGN", chargedAmountMinor: FEE, transactionId: reference,
    bookedVia: "client", createdAt: now, updatedAt: now,
  });
  await collections.transactions.doc(`fee-${id}`).set({
    id: `fee-${id}`, userId: accounts[clientName].uid, agentId: agentUid, consultationId: id,
    type: "consultation_fee", amount: FEE, currency: "NGN", status: "completed", isEscrow: false,
    paymentProvider: "paystack", providerTransactionId: reference, description: "Consultation fee",
    feeHold: {
      state: "held",
      slotStartAt: dayUtc,
      releaseAt: Timestamp.fromMillis(dayUtc.toMillis() + (released ? 1 : 48) * 3_600_000),
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

/** The agent's NGN available balance through the real stats route. */
async function availableOf(name: string): Promise<number> {
  const r = await api.call("GET", "/transactions/stats", tokens[name]);
  return r.body.data.byCurrency.find((row: any) => row.currency === "NGN")?.availableBalance ?? 0;
}

before(async () => {
  await rulesEnv();
  await resetEmulators();
  api = await startApi();

  // ---- Paystack refunds: in-process recorders, never the network ----
  const { paystackProvider } = await import("../../src/services/billing/paystack.provider");
  const ps = paystackProvider as any;
  const saved = { createRefund: ps.createRefund, findRefundsForTransaction: ps.findRefundsForTransaction };
  let counter = 0;
  ps.createRefund = async (input: { reference: string; amount: { amountMinor: number; currency: string } }) => {
    refundCalls.push(input.reference);
    // A little latency, so parallel requests really overlap.
    await new Promise((resolve) => setTimeout(resolve, 20));
    return { id: String(++counter), status: "pending", transactionReference: input.reference, amount: input.amount.amountMinor, currency: input.amount.currency };
  };
  ps.findRefundsForTransaction = async () => [];
  restore = () => {
    ps.createRefund = saved.createRefund;
    ps.findRefundsForTransaction = saved.findRefundsForTransaction;
  };

  for (const n of ["ragent1", "ragent2", "ragent3", "ragent4"]) await principal(n, { role: "agent", agencyId: null, admin: false });
  await principal("rclient", { role: "client", agencyId: null, admin: false });
  await principal("radmin", { role: "admin", agencyId: null, admin: true });
});

after(async () => {
  restore();
  await api.close();
  await (await rulesEnv()).cleanup();
});

describe("refunds under concurrent requests (#317)", () => {
  test("three admins refund at once: one 201, two 409 ALREADY_REFUNDED, one row, one Paystack call", async () => {
    await seedPaidBooking("rb1", "ragent1", "rclient");
    const before = refundCalls.length;
    const results = await Promise.all(
      [0, 1, 2].map(() => api.call("POST", "/consultations/rb1/refund", tokens.radmin, { reason: "goodwill" }))
    );
    assert.deepEqual(results.map((r) => r.status).sort(), [201, 409, 409], JSON.stringify(results.map((r) => r.body)));
    for (const r of results.filter((x) => x.status === 409)) assert.equal(r.body.error, "ALREADY_REFUNDED");
    assert.equal((await refundsOf("rb1")).length, 1);
    assert.equal(refundCalls.length - before, 1);
  });

  test("the client and the agent cancel at once: one 200, one 409, one refund row", async () => {
    await seedPaidBooking("rb2", "ragent2", "rclient");
    const body = { status: "cancelled" };
    const results = await Promise.all([
      api.call("PUT", "/consultations/rb2/status", tokens.rclient, body),
      api.call("PUT", "/consultations/rb2/status", tokens.ragent2, body),
    ]);
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 409], JSON.stringify(results.map((r) => r.body)));
    const rows = await refundsOf("rb2");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].amount, FEE);
    assert.equal(rows[0].refundFundedFrom, "hold");
  });

  test("a withdrawal racing the agent's own cancel can never take the held fee", async () => {
    await seedPaidBooking("rb3", "ragent3", "rclient");
    const [withdrawal, cancel] = await Promise.all([
      api.call("POST", "/bank-accounts/withdraw", tokens.ragent3, { bankAccountId: "bank-ragent3", amount: FEE }),
      api.call("PUT", "/consultations/rb3/status", tokens.ragent3, { status: "cancelled" }),
    ]);
    assert.equal(withdrawal.status, 400, "the held fee is not withdrawable");
    assert.equal(cancel.status, 200);
    assert.equal((await refundsOf("rb3")).length, 1);
    assert.equal(await availableOf("ragent3"), 0, "available unchanged by the refund from the hold");
    const { collections } = await import("../../src/utils/firebase");
    const lock = await collections.withdrawalLocks.doc(accounts.ragent3.uid).get();
    assert.equal(lock.data()?.refundCount, 1, "the refund took the agent's withdrawal lock");
  });

  test("a released fee: refund and withdrawal are serialised by the lock (never both with no shortfall)", async () => {
    await seedPaidBooking("rb4", "ragent4", "rclient", true);
    assert.equal(await availableOf("ragent4"), FEE, "released: available");
    const [withdrawal, refund] = await Promise.all([
      api.call("POST", "/bank-accounts/withdraw", tokens.ragent4, { bankAccountId: "bank-ragent4", amount: FEE }),
      api.call("POST", "/consultations/rb4/refund", tokens.radmin, { reason: "agent_no_show" }),
    ]);
    assert.equal(refund.status, 201, JSON.stringify(refund.body));
    const [row] = await refundsOf("rb4");
    assert.equal(row.refundFundedFrom, "available");
    if (withdrawal.status === 201) {
      // The withdrawal went first: the refund saw a 0 balance.
      assert.equal(row.balanceShortfallMinor, FEE);
      assert.equal(await availableOf("ragent4"), -FEE, "carried forward as money owed");
    } else {
      // The refund went first: nothing was left to withdraw.
      assert.equal(withdrawal.status, 400);
      assert.equal(row.balanceShortfallMinor, 0);
      assert.equal(await availableOf("ragent4"), 0);
    }
  });
});
