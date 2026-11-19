// ============================================
// Emulator test: Paystack's fee on consultation payments and cancel refunds
// under REAL Firestore transactions (issues #395 and #390)
// ============================================
//
// Run with `npm run test:emulator` (Auth + Firestore + Storage emulators, a
// `demo-` project, the real Express app, real ID tokens). Paystack is the
// in-process stub below (recorders on `paystackProvider`): no real charge or
// refund is ever made.
//
// The unit tests (test/consultations/consultation-paystack-fee.test.ts and
// consultation-refund-fee-rule.test.ts) run transactions one at a time on an
// in-memory store. Only real Firestore transactions show that requests sent
// AT THE SAME TIME still leave, per Paystack reference:
//  1. (#395) one fee Transaction with one stored fee, when verify on return
//     and the webhook (direct `settlePayment` calls stand in for it, as in
//     unapplied-refund-race.emu.ts) settle together;
//  2. (#395) one stored fee when several admin refreshes run together, and
//     the admin routes refusing agents and clients (403) and no token (401);
//  3. (#390) one refund row and ONE fee debit when an agent-caused cancel and
//     admin refunds race, and the agent's balance at -F, never -2F;
//  4. (#390) a HELD refund retried by several admins at once proceeds once.

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

/** A: the charge of every booking here, ₦9,000.00 in kobo. */
const A = 900_000;
/** F: Paystack's processing fee on that charge, ₦150.00 in kobo, as Paystack reports it. */
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
 * An UNPAID booking `id` of the client with the agent, a week away, whose
 * checkout `cons-<id>-ref` Paystack reports PAID exactly, with `fees` as
 * Paystack's raw fee (undefined = Paystack reported none).
 */
async function seedPending(id: string, fees: unknown): Promise<string> {
  const { collections } = await import("../../src/utils/firebase");
  const { toTransactionLookup } = await import("../../src/services/billing/paystack.provider");
  const now = Date.now();
  const day = new Date(now + 7 * 86_400_000);
  const dayUtc = Timestamp.fromDate(new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate())));
  const reference = `cons-${id}-ref`;
  await collections.consultations.doc(id).set({
    id, userId: accounts.fclient.uid, agentId: accounts.fagent.uid, clientName: "fclient",
    clientEmail: accounts.fclient.email, agentName: "fagent", type: "initial", scheduledDate: dayUtc,
    scheduledTime: "10:00", durationMinutes: 30, timezone: "Africa/Lagos", status: "pending_payment",
    paymentStatus: "pending", priceUsdCents: 600, chargedCurrency: "NGN", chargedAmountMinor: A,
    fxRate: 1500, fxRateAsOf: Timestamp.fromMillis(now - 60_000), fxRateSource: "cbn", fxMarginBps: 0,
    quoteLockedAt: Timestamp.fromMillis(now - 60_000), quoteExpiresAt: Timestamp.fromMillis(now + 29 * 60_000),
    transactionId: reference, checkoutUrl: `https://checkout.paystack.test/${reference}`, bookedVia: "client",
    createdAt: Timestamp.fromMillis(now - 60_000), updatedAt: Timestamp.fromMillis(now - 60_000),
  });
  reports.set(reference, toTransactionLookup({
    status: "success", metadata: { purpose: "consultation", consultationId: id },
    amount: A, currency: "NGN", paid_at: new Date().toISOString(), fees,
  }));
  return reference;
}

/** Booking `id`'s stored rows. */
async function stateOf(id: string): Promise<{ booking: any; fees: any[]; refunds: any[]; debits: any[] }> {
  const { collections } = await import("../../src/utils/firebase");
  const booking = (await collections.consultations.doc(id).get()).data();
  const txs = (await collections.transactions.where("consultationId", "==", id).get()).docs.map((d) => d.data());
  return {
    booking,
    fees: txs.filter((t) => t.type === "consultation_fee"),
    refunds: txs.filter((t) => t.type === "refund"),
    debits: txs.filter((t) => t.type === "paystack_fee_debit"),
  };
}

/** The agent's NGN stats row (zeros when absent). */
async function agentNgn(): Promise<any> {
  const stats = await api.call("GET", "/transactions/stats", tokens.fagent);
  assert.equal(stats.status, 200, JSON.stringify(stats.body));
  return (stats.body.data.byCurrency as any[]).find((r) => r.currency === "NGN") ?? { heldBalance: 0, availableBalance: 0 };
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
  ps.getTransactionMetadata = async (reference: string) => {
    await new Promise((resolve) => setTimeout(resolve, 10));
    return reports.get(reference) ?? null;
  };
  restore = () => {
    ps.createRefund = saved.createRefund;
    ps.findRefundsForTransaction = saved.findRefundsForTransaction;
    ps.getTransactionMetadata = saved.getTransactionMetadata;
  };

  await principal("fagent", { role: "agent", agencyId: null, admin: false });
  await principal("fclient", { role: "client", agencyId: null, admin: false });
  await principal("fadmin", { role: "admin", agencyId: null, admin: true });
});

after(async () => {
  restore();
  await api.close();
  await (await rulesEnv()).cleanup();
});

describe("Paystack's fee on settle (#395)", () => {
  test("verify x2 and settle x2 at once: one fee Transaction, one stored fee, credited A - F", async () => {
    const reference = await seedPending("pf1", F);
    const { settlePayment } = await import("../../src/services/consultation-charge.service");
    const results = await Promise.all([
      api.call("POST", "/consultations/public/verify", undefined, { reference }),
      api.call("POST", "/consultations/public/verify", undefined, { reference }),
      settlePayment("pf1", reference, reports.get(reference)),
      settlePayment("pf1", reference, { ...reports.get(reference), fees: F + 1 }),
    ]);
    for (const r of results.slice(0, 2) as any[]) assert.equal(r.status, 200, JSON.stringify(r.body));
    const s = await stateOf("pf1");
    assert.equal(s.booking.paymentStatus, "paid");
    assert.equal(s.fees.length, 1, "one fee Transaction");
    assert.equal(s.fees[0].amount, A);
    assert.ok([F, F + 1].includes(s.fees[0].paystackFeeMinor), "the fee of whichever settle won, written once");
    assert.equal(s.fees[0].agentCreditMinor, A - s.fees[0].paystackFeeMinor);
    const ngn = await agentNgn();
    assert.equal(ngn.heldBalance, A - s.fees[0].paystackFeeMinor);
  });

  test("unknown fee: admin refreshes x3 at once store it once; agents / clients 403, no token 401", async () => {
    const reference = await seedPending("pf2", undefined);
    const { settlePayment } = await import("../../src/services/consultation-charge.service");
    assert.equal((await settlePayment("pf2", reference, reports.get(reference)))?.kind, "confirmed");
    const [fee] = (await stateOf("pf2")).fees;
    assert.equal(fee.paystackFeeStatus, "unknown");
    const path = `/transactions/${fee.id}/paystack-fee/refresh`;

    // Authz first.
    assert.equal((await api.call("POST", path)).status, 401);
    assert.equal((await api.call("POST", path, tokens.fagent)).status, 403);
    assert.equal((await api.call("POST", path, tokens.fclient)).status, 403);
    const listPath = "/transactions?role=admin&type=consultation_fee&paystackFeeStatus=unknown";
    assert.equal((await api.call("GET", listPath)).status, 401);
    assert.equal((await api.call("GET", listPath, tokens.fagent)).status, 403);
    assert.equal((await api.call("GET", listPath, tokens.fclient)).status, 403);
    const listed = await api.call("GET", listPath, tokens.fadmin);
    assert.equal(listed.status, 200, JSON.stringify(listed.body));
    assert.ok((listed.body.data as any[]).some((t) => t.id === fee.id));

    // Still unknown at Paystack: 409, nothing written.
    const still = await api.call("POST", path, tokens.fadmin);
    assert.equal(still.status, 409);
    assert.equal(still.body.error, "PAYSTACK_FEE_UNKNOWN");

    // Paystack reports it: three refreshes at once store it once.
    reports.set(reference, { ...reports.get(reference), fees: F });
    const outs = await Promise.all([0, 1, 2].map(() => api.call("POST", path, tokens.fadmin)));
    for (const o of outs) assert.equal(o.status, 200, JSON.stringify(o.body));
    assert.equal(outs.filter((o) => o.body.data.refreshed === true).length, 1, "stored by exactly one refresh");
    const [stored] = (await stateOf("pf2")).fees;
    assert.equal(stored.paystackFeeMinor, F);
    assert.equal(stored.paystackFeeStatus, "known");
  });
});

describe("cancel refunds under the fee rule (#390)", () => {
  test("agent cancel and two admin refunds at once: one refund, ONE debit, agent at -F, one Paystack call", async () => {
    const reference = await seedPending("pf3", F);
    const { settlePayment } = await import("../../src/services/consultation-charge.service");
    assert.equal((await settlePayment("pf3", reference, reports.get(reference)))?.kind, "confirmed");
    const before = refundCalls.length;
    const heldBefore = (await agentNgn()).heldBalance;
    const availableBefore = (await agentNgn()).availableBalance;
    const outs = await Promise.all([
      api.call("PUT", "/consultations/pf3/status", tokens.fagent, { status: "cancelled" }),
      api.call("POST", "/consultations/pf3/refund", tokens.fadmin, { reason: "agent_no_show" }),
      api.call("POST", "/consultations/pf3/refund", tokens.fadmin, { reason: "goodwill", feeBorneBy: "agent" }),
    ]);
    for (const o of outs) assert.ok(o.status < 500, JSON.stringify(o.body));
    const s = await stateOf("pf3");
    assert.equal(s.refunds.length, 1, "one refund row");
    assert.equal(s.refunds[0].amount, A, "agent-caused: refunded in full");
    assert.equal(s.debits.length, 1, "one fee debit");
    assert.equal(s.debits[0].amount, F);
    assert.equal(refundCalls.length - before, 1);
    assert.deepEqual(refundCalls[refundCalls.length - 1], [reference, A, "NGN"]);
    // This booking's net effect on the agent: -F (held A - F left the hold, debit F).
    const ngn = await agentNgn();
    assert.equal(ngn.heldBalance - heldBefore + ngn.availableBalance - availableBefore, -(A - F) - F);
  });

  test("a client cancel with the fee unknown is held; three admin retries at once proceed once", async () => {
    const reference = await seedPending("pf4", undefined);
    const { settlePayment } = await import("../../src/services/consultation-charge.service");
    assert.equal((await settlePayment("pf4", reference, reports.get(reference)))?.kind, "confirmed");
    const cancelled = await api.call("PUT", "/consultations/pf4/status", tokens.fclient, { status: "cancelled" });
    assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
    assert.equal(cancelled.body.data.refund.heldReason, "paystack_fee_unknown");
    let s = await stateOf("pf4");
    assert.equal(s.refunds.length, 1);
    assert.equal(s.refunds[0].status, "failed");
    assert.equal(s.refunds[0].amount, 0);
    assert.equal(s.debits.length, 0);

    const before = refundCalls.length;
    reports.set(reference, { ...reports.get(reference), fees: F });
    const outs = await Promise.all([0, 1, 2].map(() =>
      api.call("POST", "/consultations/pf4/refund", tokens.fadmin, { reason: "goodwill", feeBorneBy: "agent" })
    ));
    assert.deepEqual(outs.map((o) => o.status).sort(), [200, 409, 409], JSON.stringify(outs.map((o) => o.body)));
    s = await stateOf("pf4");
    assert.equal(s.refunds.length, 1);
    assert.equal(s.refunds[0].amount, A - F, "the stored client cause: A - F");
    assert.equal(s.refunds[0].paystackFeeKeptMinor, F);
    assert.equal(s.debits.length, 0);
    assert.equal(refundCalls.length - before, 1);
    assert.deepEqual(refundCalls[refundCalls.length - 1], [reference, A - F, "NGN"]);
  });
});
