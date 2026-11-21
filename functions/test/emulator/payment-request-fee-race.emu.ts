// ============================================
// Emulator test: Paystack's fee on paid payment requests under REAL
// Firestore transactions (issue #393)
// ============================================
//
// Run with `npm run test:emulator` (Auth + Firestore + Storage emulators, a
// `demo-` project, the real Express app, real ID tokens). Paystack is the
// in-process stub below (a recorder on `paystackProvider.getTransactionMetadata`):
// no real charge is ever made.
//
// The unit tests (test/payment-requests/payment-request-paystack-fee.test.ts)
// run transactions one at a time on an in-memory store. Only real Firestore
// transactions show that requests sent AT THE SAME TIME still leave, per
// Paystack reference:
//  1. ONE `escrow_release` Transaction with ONE stored fee, and the case's
//     `amountPaid` moved once, when verify on return (twice) and webhook-style
//     `settlePaymentRequest` calls (twice, with different fees) settle
//     together; the agent credited A - F of the fee that was stored;
//  2. ONE stored fee when several admin refreshes run together on an
//     unknown-fee row, with the admin routes refusing agents and clients
//     (403) and no token (401), the admin list showing the row, and 409
//     PAYSTACK_FEE_UNKNOWN while Paystack still reports no fee.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { Timestamp } from "firebase-admin/firestore";

import { refreshIdToken, resetEmulators, RunningApi, rulesEnv, signUp, startApi, TestAccount } from "./helpers";

/* eslint-disable @typescript-eslint/no-explicit-any */

let api: RunningApi;
const accounts: Record<string, TestAccount> = {};
const tokens: Record<string, string> = {};
/** reference -> what the stubbed Paystack verify reports. */
const reports = new Map<string, any>();
let restore: () => void = () => undefined;

/** The request's dollar price, $150.00 in US cents. */
const PRICE_CENTS = 15_000;
/** A: what Paystack charged, ₦225,000.00 in kobo ($150 at ₦1,500/$). */
const A = 22_500_000;
/** F: Paystack's processing fee on that charge, ₦2,000.00 in kobo. */
const F = 200_000;
/** The agent's profile doc id (a request's `agentId` is the PROFILE id). */
const AGENT_PROFILE = "prof-pr-fee-agent";

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
 * An APPROVED $150 request `id` of the client on the agent's case
 * `app-<id>`, with its checkout `pr-<id>-ref` open (quote locked for the next
 * half hour), which Paystack reports PAID exactly, with `fees` as Paystack's
 * raw fee (undefined = Paystack reported none).
 */
async function seedApproved(id: string, fees: unknown): Promise<string> {
  const { collections } = await import("../../src/utils/firebase");
  const { toTransactionLookup } = await import("../../src/services/billing/paystack.provider");
  const now = Date.now();
  const reference = `pr-${id}-ref`;
  const applicationId = `app-${id}`;
  await collections.applications.doc(applicationId).set({
    id: applicationId, userId: accounts.pclient.uid, agentId: accounts.pagent.uid, status: "in_progress",
    paymentStatus: "pending", amountPaid: 0, totalCost: 150_000, costCurrency: "USD",
    createdAt: Timestamp.fromMillis(now - 60_000),
  });
  await collections.paymentRequests.doc(id).set({
    id, applicationId, agentId: AGENT_PROFILE, agencyId: null, clientId: accounts.pclient.uid,
    clientName: "pclient", clientEmail: accounts.pclient.email, description: "Visa Processing Fee", category: "other",
    status: "approved", priceUsd: { amountMinor: PRICE_CENTS, currency: "USD" },
    priceUsdCents: PRICE_CENTS, chargedCurrency: "NGN", chargedAmountMinor: A, fxRate: 1500,
    fxRateAsOf: Timestamp.fromMillis(now - 60_000), fxRateSource: "cbn", fxMarginBps: 0,
    quoteLockedAt: Timestamp.fromMillis(now - 60_000), quoteExpiresAt: Timestamp.fromMillis(now + 29 * 60_000),
    paystackReference: reference,
    createdAt: Timestamp.fromMillis(now - 120_000), updatedAt: Timestamp.fromMillis(now - 60_000),
  });
  reports.set(reference, toTransactionLookup({
    status: "success", metadata: { purpose: "payment_request", paymentRequestId: id },
    amount: A, currency: "NGN", paid_at: new Date().toISOString(), fees,
  }));
  return reference;
}

/** Request `id`'s stored rows: the request, its case and its Transactions. */
async function stateOf(id: string): Promise<{ request: any; application: any; rows: any[] }> {
  const { collections } = await import("../../src/utils/firebase");
  const request = (await collections.paymentRequests.doc(id).get()).data();
  const application = (await collections.applications.doc(`app-${id}`).get()).data();
  const rows = (await collections.transactions.where("paymentRequestId", "==", id).get()).docs.map((d) => d.data());
  return { request, application, rows };
}

/** The agent's NGN stats row (zeros when absent). */
async function agentNgn(): Promise<any> {
  const stats = await api.call("GET", "/transactions/stats", tokens.pagent);
  assert.equal(stats.status, 200, JSON.stringify(stats.body));
  return (stats.body.data.byCurrency as any[]).find((r) => r.currency === "NGN") ?? { availableBalance: 0, totalRevenue: 0 };
}

before(async () => {
  await rulesEnv();
  await resetEmulators();
  api = await startApi();

  // ---- Paystack: an in-process recorder, never the network ----
  const { paystackProvider } = await import("../../src/services/billing/paystack.provider");
  const ps = paystackProvider as any;
  const saved = { getTransactionMetadata: ps.getTransactionMetadata };
  ps.getTransactionMetadata = async (reference: string) => {
    // A little latency, so parallel requests really overlap.
    await new Promise((resolve) => setTimeout(resolve, 10));
    return reports.get(reference) ?? null;
  };
  restore = () => {
    ps.getTransactionMetadata = saved.getTransactionMetadata;
  };

  await principal("pagent", { role: "agent", agencyId: null, admin: false });
  await principal("pclient", { role: "client", agencyId: null, admin: false });
  await principal("padmin", { role: "admin", agencyId: null, admin: true });
  const { collections } = await import("../../src/utils/firebase");
  await collections.agents.doc(AGENT_PROFILE).set({ userId: accounts.pagent.uid, displayName: "pagent" });
});

after(async () => {
  restore();
  await api.close();
  await (await rulesEnv()).cleanup();
});

describe("Paystack's fee on a paid payment request (#393)", () => {
  test("verify x2 and settle x2 at once: one Transaction, one stored fee, amountPaid moved once, credited A - F", async () => {
    const reference = await seedApproved("prf1", F);
    const { settlePaymentRequest } = await import("../../src/services/payment-request-settlement.service");
    const results = await Promise.all([
      api.call("POST", "/payment-requests/prf1/verify", tokens.pclient, { reference }),
      api.call("POST", "/payment-requests/prf1/verify", tokens.pclient, { reference }),
      // Stand-ins for the webhook (it settles through this same function).
      settlePaymentRequest("prf1", reference, reports.get(reference)),
      settlePaymentRequest("prf1", reference, { ...reports.get(reference), fees: F + 1 }),
    ]);
    for (const r of results.slice(0, 2) as any[]) assert.equal(r.status, 200, JSON.stringify(r.body));
    const s = await stateOf("prf1");
    assert.equal(s.request.status, "paid");
    assert.equal(s.rows.length, 1, "one Transaction");
    const [row] = s.rows;
    assert.equal(row.type, "escrow_release");
    assert.equal(row.amount, A);
    assert.equal(row.paystackFeeStatus, "known");
    assert.ok([F, F + 1].includes(row.paystackFeeMinor), "the fee of whichever settle won, written once");
    assert.equal(row.agentCreditMinor, A - row.paystackFeeMinor);
    assert.equal(s.application.amountPaid, PRICE_CENTS, "the full price, moved once");
    const ngn = await agentNgn();
    assert.equal(ngn.availableBalance, A - row.paystackFeeMinor);
    assert.equal(ngn.totalRevenue, A - row.paystackFeeMinor);

    // The client's own history shows A only.
    const mine = await api.call("GET", "/transactions?role=client", tokens.pclient);
    assert.equal(mine.status, 200, JSON.stringify(mine.body));
    const clientRow = (mine.body.data as any[]).find((t) => t.id === row.id);
    assert.equal(clientRow.amount, A);
    assert.equal("paystackFeeMinor" in clientRow, false);
    assert.equal("agentCreditMinor" in clientRow, false);
  });

  test("unknown fee: counted nowhere; admin refreshes x3 at once store it once; agents / clients 403, no token 401", async () => {
    const reference = await seedApproved("prf2", undefined);
    const before = await agentNgn();
    const verified = await api.call("POST", "/payment-requests/prf2/verify", tokens.pclient, { reference });
    assert.equal(verified.status, 200, JSON.stringify(verified.body));
    let s = await stateOf("prf2");
    assert.equal(s.request.status, "paid");
    assert.equal(s.application.amountPaid, PRICE_CENTS);
    const [row] = s.rows;
    assert.equal(row.paystackFeeStatus, "unknown");
    // Counted nowhere: the agent's figures did not move.
    let ngn = await agentNgn();
    assert.equal(ngn.availableBalance, before.availableBalance);
    assert.equal(ngn.totalRevenue, before.totalRevenue);

    const path = `/transactions/${row.id}/paystack-fee/refresh`;
    // Authz first.
    assert.equal((await api.call("POST", path)).status, 401);
    assert.equal((await api.call("POST", path, tokens.pagent)).status, 403);
    assert.equal((await api.call("POST", path, tokens.pclient)).status, 403);
    const listPath = "/transactions?role=admin&type=escrow_release&paystackFeeStatus=unknown";
    assert.equal((await api.call("GET", listPath)).status, 401);
    assert.equal((await api.call("GET", listPath, tokens.pagent)).status, 403);
    assert.equal((await api.call("GET", listPath, tokens.pclient)).status, 403);
    // The admin list. (The emulator does not enforce indexes; production
    // uses the existing transactions(type, paystackFeeStatus, createdAt desc).)
    const listed = await api.call("GET", listPath, tokens.padmin);
    assert.equal(listed.status, 200, JSON.stringify(listed.body));
    assert.ok((listed.body.data as any[]).some((t) => t.id === row.id));

    // Still unknown at Paystack: 409, nothing written.
    const still = await api.call("POST", path, tokens.padmin);
    assert.equal(still.status, 409);
    assert.equal(still.body.error, "PAYSTACK_FEE_UNKNOWN");
    assert.equal((await stateOf("prf2")).rows[0].paystackFeeStatus, "unknown");

    // Paystack reports it: three refreshes at once store it once.
    reports.set(reference, { ...reports.get(reference), fees: F });
    const outs = await Promise.all([0, 1, 2].map(() => api.call("POST", path, tokens.padmin)));
    for (const o of outs) assert.equal(o.status, 200, JSON.stringify(o.body));
    assert.equal(outs.filter((o) => o.body.data.refreshed === true).length, 1, "stored by exactly one refresh");
    s = await stateOf("prf2");
    assert.equal(s.rows.length, 1);
    assert.equal(s.rows[0].paystackFeeMinor, F);
    assert.equal(s.rows[0].paystackFeeStatus, "known");
    assert.equal(s.rows[0].paystackFeeResolvedBy, "admin_refresh");
    ngn = await agentNgn();
    assert.equal(ngn.availableBalance - before.availableBalance, A - F, "credited A - F, once");
  });
});
