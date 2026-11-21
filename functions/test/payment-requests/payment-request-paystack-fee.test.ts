// ============================================
// Unit tests: the agent pays Paystack's fee on a paid payment request (issue #393)
// ============================================
//
// Hermetic (test/consultations/harness.ts via ./helpers): in-memory
// Firestore with transactions run one at a time, every Paystack call stubbed
// (no real money moves), a fixed clock. Paystack's fee is the RAW `data.fees`
// of the stubbed report, parsed by the real `toTransactionLookup`, exactly as
// the verify lookup and the webhook parse it.
//
// The rule under test (decision 2026-11-17, the same as consultations #395),
// per Paystack reference with A = amount charged, F = Paystack's `fees` in
// the same currency:
//  - the `escrow_release` Transaction's `amount` stays A, it stores F, and
//    the agent is credited A - F in `availableBalance` (no meeting hold) and
//    in `totalRevenue`; the case's `amountPaid` moves by the FULL price; the
//    client's history shows A only; the agent's notification is unchanged;
//  - F unknown (missing, null, negative, a string, a fraction, another
//    currency later) or F >= A: request paid, row credited NOWHERE (never
//    withdrawable), listed for an admin; the scheduled job or an admin
//    refresh stores F once when Paystack reports it (409 while it does not);
//  - one Transaction and one stored fee per reference, whatever settles it
//    (verify, webhook, both at once), never overwritten; no fee debit row;
//  - a payment that cannot be applied records F on its exception;
//  - a legacy row (no fee status) keeps counting as A.

import { test, describe, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as crypto from "crypto";
import { ROLES } from "@durin-tech/authz";
import type { AuthzSubject } from "@durin-tech/authz";

import {
  usePaymentRequestHarness,
  resetPaymentRequests,
  reqFor,
  sent,
  agentA,
  ownerA,
  clientNg,
  clientGh,
  APP_A,
  APP_A_GH,
  harness,
  seed,
  T0,
  paystackRequestStatus,
} from "./helpers";
import { captureRes, docsIn, setRate } from "../consultations/harness";
import { store } from "../helpers/fake-firestore";
import { paymentRequestController } from "../../src/controllers/payment-request.controller";
import { entitlementController } from "../../src/controllers/entitlement.controller";
import { transactionController } from "../../src/controllers/transaction.controller";
import { bankAccountController } from "../../src/controllers/bank-account.controller";
import { settlePaymentRequest } from "../../src/services/payment-request-settlement.service";
import { toTransactionLookup } from "../../src/services/billing/paystack.provider";
import { paystackFeeService } from "../../src/services/paystack-fee.service";
import { transactionService } from "../../src/services/transaction.service";
import { awaitsPaystackFee, isPaystackFeeTracked } from "../../src/money/paystack-fee";
import { revenueEffect } from "../../src/money/totals";
import { sumRevenueByCurrency } from "../../src/services/analytics.service";
import type { Transaction } from "../../src/types";

/* eslint-disable @typescript-eslint/no-explicit-any */

// ============================================
// Setup: the payment-request harness, logs silenced
// ============================================

before(async () => {
  await usePaymentRequestHarness();
});
beforeEach(async () => {
  await resetPaymentRequests();
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  console.log = () => {};
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  console.error = () => {};
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  console.warn = () => {};
});

// ============================================
// Fixtures and calls
// ============================================

/** The request's dollar price: $150.00 in US cents. */
const PRICE_CENTS = 15_000;
/** A in naira: $150 at ₦1,500/$ = ₦225,000.00 = 22,500,000 kobo. */
const A = 22_500_000;
/** F in naira: Paystack's fee, ₦2,000.00 in kobo (Paystack's NGN cap). */
const F = 200_000;
/** A in cedis: $150 at GHS 15/$ = GHS 2,250.00 = 225,000 pesewas. */
const A_GHS = 225_000;
/** F in cedis: Paystack's fee, GHS 43.88 in pesewas. */
const F_GHS = 4_388;

/** An admin as verifyAuth leaves one. */
const admin: AuthzSubject = { uid: "uid-admin", role: ROLES.ADMIN, agencyId: null };

/** The stored request doc. */
const stored = (id: string) => store.get(`paymentRequests/${id}`) as any;
/** The stored case doc. */
const app = (id: string) => store.get(`applications/${id}`) as any;
/** Every payment-request Transaction (the `escrow_release` rows). */
const paymentTxns = (): any[] => docsIn("transactions").map(([, t]) => t).filter((t) => t.paymentRequestId);
/** Request `id`'s one Transaction (asserts there is exactly one). */
function rowOf(id: string): any {
  const rows = paymentTxns().filter((t) => t.paymentRequestId === id);
  assert.equal(rows.length, 1, `exactly one Transaction for ${id}`);
  return rows[0];
}

/** Create a $150 request on `applicationId` as agent A; returns its id. */
async function createRequest(applicationId = APP_A): Promise<string> {
  const { out, res } = captureRes();
  await paymentRequestController.createPaymentRequest(
    reqFor(agentA, { body: { applicationId, amount: "150.00", description: "Visa Processing Fee" } }),
    res
  );
  assert.equal(out.status, 201, JSON.stringify(out.body));
  return out.body.data.id;
}

/** PUT /:id/approve as `who`; returns the checkout's Paystack reference. */
async function approve(id: string, who: AuthzSubject = clientNg): Promise<string> {
  const { out, res } = captureRes();
  await paymentRequestController.approvePaymentRequest(reqFor(who, { params: { id } }), res);
  assert.equal(out.status, 200, JSON.stringify(out.body));
  return out.body.data.paystackReference;
}

/** POST /:id/verify as `who`. */
async function verify(id: string, reference: string, who: AuthzSubject = clientNg) {
  const { out, res } = captureRes();
  await paymentRequestController.verifyPayment(reqFor(who, { params: { id }, body: { reference } }), res);
  return out;
}

/**
 * Make Paystack report `reference` (request `id`) PAID with `amountMinor` in
 * `currency` and `fees` as its RAW fee (undefined = no fee reported), parsed
 * by the real `toTransactionLookup` as the verify lookup does.
 */
function paystackReports(reference: string, id: string, amountMinor: number, currency: string, fees: unknown): void {
  harness.paystack.set(reference, toTransactionLookup({
    status: "success",
    metadata: { purpose: "payment_request", paymentRequestId: id },
    amount: amountMinor,
    currency,
    paid_at: harness.clock.now().toISOString(),
    fees,
  }));
}

/** A signed Paystack charge.success webhook for a request (raw `data` as Paystack sends it). */
async function webhook(id: string, reference: string, data: Record<string, unknown>) {
  process.env.PAYSTACK_SECRET_KEY = "test-only-not-a-real-key";
  const raw = JSON.stringify({
    event: "charge.success",
    data: { reference, status: "success", metadata: { purpose: "payment_request", paymentRequestId: id }, ...data },
  });
  const signature = crypto.createHmac("sha512", process.env.PAYSTACK_SECRET_KEY).update(raw).digest("hex");
  const { out, res } = captureRes();
  await entitlementController.handlePaystackWebhook(
    { body: Buffer.from(raw), headers: { "x-paystack-signature": signature } } as any,
    res
  );
  return out;
}

/** A naira request on agency A's case, paid and verified with Paystack fee `fees` (raw). */
async function paidNgn(fees: unknown): Promise<{ id: string; ref: string; row: any }> {
  const id = await createRequest();
  const ref = await approve(id);
  paystackReports(ref, id, A, "NGN", fees);
  const out = await verify(id, ref);
  assert.equal(out.status, 200, JSON.stringify(out.body));
  return { id, ref, row: rowOf(id) };
}

/** GET /transactions/stats as `p`; the `currency` row (zeros when absent). */
async function balanceOf(p: AuthzSubject, currency = "NGN", query: Record<string, unknown> = {}) {
  const { out, res } = captureRes();
  await transactionController.getStats(reqFor(p, { query }), res);
  assert.equal(out.status, 200, JSON.stringify(out.body));
  const row = (out.body.data.byCurrency as any[]).find((r) => r.currency === currency);
  return row ?? { currency, totalRevenue: 0, pendingPayments: 0, availableBalance: 0, heldBalance: 0 };
}

/** GET /transactions with `query`, as `p`. */
async function listTransactions(p: AuthzSubject, query: Record<string, unknown> = {}) {
  const { out, res } = captureRes();
  await transactionController.getTransactions(reqFor(p, { query }), res);
  return out;
}

/** POST /transactions/:id/paystack-fee/refresh as `p`. */
async function refresh(p: AuthzSubject, id: string) {
  const { out, res } = captureRes();
  await transactionController.refreshPaystackFee(reqFor(p, { params: { id } }), res);
  return out;
}

/** POST /bank-accounts/withdraw as agent A, for `amount` kobo (seeds the account once). */
async function withdraw(amount: number) {
  if (!docsIn("bankAccounts").some(([docId]) => docId === "bank-agent-a")) {
    await seed("bankAccounts", "bank-agent-a", {
      userId: agentA.uid, accountName: "Ada Agent", bankName: "Test Bank", accountNumber: "0123456789",
      isMain: true, createdAt: T0, updatedAt: T0,
    });
  }
  const { out, res } = captureRes();
  await bankAccountController.withdraw(reqFor(agentA, { body: { bankAccountId: "bank-agent-a", amount } }), res);
  return out;
}

/** The fields the client must never see on their own history. */
const FEE_FIELDS = ["paystackFeeMinor", "agentCreditMinor", "paystackFeeStatus", "paystackFeeResolvedAt", "paystackFeeResolvedBy"];

// ============================================
// The pure rules, extended to payment requests
// ============================================

describe("fee-tracked types (pure)", () => {
  test("escrow_release is tracked like consultation_fee; other types are not", () => {
    assert.equal(isPaystackFeeTracked("escrow_release"), true);
    assert.equal(isPaystackFeeTracked("consultation_fee"), true);
    for (const type of ["refund", "withdrawal", "service_fee", "government_fee", "paystack_fee_debit"] as Transaction["type"][]) {
      assert.equal(isPaystackFeeTracked(type), false, type);
    }
    assert.equal(awaitsPaystackFee({ type: "escrow_release", paystackFeeStatus: "unknown" }), true);
    assert.equal(awaitsPaystackFee({ type: "escrow_release", paystackFeeStatus: "known" }), false);
    assert.equal(awaitsPaystackFee({ type: "escrow_release" }), false, "legacy rows are never looked up");
  });

  test("revenueEffect: A - F known, 0 unknown or not-less, A legacy", () => {
    const base = { type: "escrow_release" as const, status: "released" as const, amount: A };
    assert.equal(revenueEffect({ ...base, paystackFeeStatus: "known", paystackFeeMinor: F }), A - F);
    assert.equal(revenueEffect({ ...base, paystackFeeStatus: "unknown" }), 0);
    assert.equal(revenueEffect({ ...base, paystackFeeStatus: "fee_not_less_than_amount", paystackFeeMinor: A }), 0);
    assert.equal(revenueEffect(base), A);
  });
});

// ============================================
// Recording the fee at settlement
// ============================================

describe("settle with a known fee", () => {
  test("NGN: amount A, fee F stored, available and revenue A - F, amountPaid the full price, client sees A only", async () => {
    const { id, ref, row } = await paidNgn(F);
    assert.equal(stored(id).status, "paid");
    assert.equal(row.type, "escrow_release");
    assert.equal(row.amount, A);
    assert.equal(row.currency, "NGN");
    assert.equal(row.paystackFeeStatus, "known");
    assert.equal(row.paystackFeeMinor, F);
    assert.equal(row.agentCreditMinor, A - F);
    assert.equal(row.paystackFeeResolvedBy, "settle");
    assert.ok(row.paystackFeeResolvedAt);
    assert.equal(row.providerTransactionId, ref);

    // The agent: available at once (no meeting hold), net of the fee.
    const bal = await balanceOf(agentA);
    assert.equal(bal.availableBalance, A - F);
    assert.equal(bal.heldBalance, 0);
    assert.equal(bal.totalRevenue, A - F);

    // The case: the client paid the full dollar price.
    assert.equal(app(APP_A).amountPaid, PRICE_CENTS);
    assert.equal(app(APP_A).costCurrency, "USD");

    // The client's history: A, never the fee or the net.
    const mine = await listTransactions(clientNg, { role: "client" });
    assert.equal(mine.status, 200);
    const clientRow = mine.body.data.find((t: any) => t.id === row.id);
    assert.equal(clientRow.amount, A);
    for (const hidden of FEE_FIELDS) assert.equal(hidden in clientRow, false, `${hidden} is hidden from the client`);

    // The agent's notification is unchanged: what the client paid.
    const note = sent.find((n) => n.type === "payment_received");
    assert.ok(note);
    assert.match(note!.body, /USD 150\.00 \(NGN 225,000\.00\)/);

    // No fee debit is ever written for a payment-request reference.
    assert.equal(docsIn("transactions").filter(([, t]) => t.type === "paystack_fee_debit").length, 0);
  });

  test("GHS: fee and credit in pesewas, nothing converted, nothing in naira", async () => {
    const id = await createRequest(APP_A_GH);
    const ref = await approve(id, clientGh);
    paystackReports(ref, id, A_GHS, "GHS", F_GHS);
    assert.equal((await verify(id, ref, clientGh)).status, 200);
    const row = rowOf(id);
    assert.equal(row.amount, A_GHS);
    assert.equal(row.currency, "GHS");
    assert.equal(row.paystackFeeMinor, F_GHS);
    assert.equal(row.agentCreditMinor, A_GHS - F_GHS);
    const ghs = await balanceOf(agentA, "GHS");
    assert.equal(ghs.availableBalance, A_GHS - F_GHS);
    assert.equal(ghs.totalRevenue, A_GHS - F_GHS);
    assert.equal((await balanceOf(agentA, "NGN")).availableBalance, 0);
    assert.equal(app(APP_A_GH).amountPaid, PRICE_CENTS);
  });

  test("the webhook path stores the fee too (raw data.fees, signature-verified payload)", async () => {
    const id = await createRequest();
    const ref = await approve(id);
    const out = await webhook(id, ref, { amount: A, currency: "NGN", fees: F, paid_at: harness.clock.now().toISOString() });
    assert.equal(out.status, 200);
    const row = rowOf(id);
    assert.equal(row.paystackFeeStatus, "known");
    assert.equal(row.paystackFeeMinor, F);
    assert.equal((await balanceOf(agentA)).availableBalance, A - F);
  });

  test("the agent and owner scopes see the fee and the net; admin stats show gross, fee and net", async () => {
    const { row } = await paidNgn(F);
    for (const [p, query] of [[agentA, {}], [ownerA, { role: "owner" }]] as Array<[AuthzSubject, Record<string, unknown>]>) {
      const out = await listTransactions(p, query);
      assert.equal(out.status, 200, JSON.stringify(out.body));
      const seen = out.body.data.find((t: any) => t.id === row.id);
      assert.ok(seen, `${p.role} sees the row`);
      assert.equal(seen.amount, A);
      assert.equal(seen.paystackFeeMinor, F);
      assert.equal(seen.agentCreditMinor, A - F);
      assert.equal(seen.currency, "NGN");
    }
    const ngn = await balanceOf(admin, "NGN", { role: "admin" });
    assert.equal(ngn.totalRevenue, A - F);
    assert.equal(ngn.paystackFees, F);
    assert.equal(ngn.grossRevenue, A);
  });

  test("stats and analytics revenue agree (shared revenueEffect)", async () => {
    await paidNgn(F);
    await paidNgn(undefined);
    const rows = paymentTxns() as Transaction[];
    assert.equal(sumRevenueByCurrency(rows).get("NGN"), A - F, "the unknown-fee row adds nothing to analytics revenue");
    assert.equal(transactionService.computeStats(rows).byCurrency[0].totalRevenue, A - F);
  });

  test("a fee of 0 credits A and shows 0", async () => {
    const { row } = await paidNgn(0);
    assert.equal(row.paystackFeeStatus, "known");
    assert.equal(row.paystackFeeMinor, 0);
    assert.equal(row.agentCreditMinor, A);
    assert.equal((await balanceOf(agentA)).availableBalance, A);
  });
});

// ============================================
// Fee unknown or too large
// ============================================

describe("fee unknown at settle", () => {
  for (const [label, fees] of [
    ["missing", undefined], ["null", null], ["negative", -1], ["a string", "200000"], ["a fraction", 150.5],
  ] as Array<[string, unknown]>) {
    test(`${label}: request paid, amountPaid moved, counted nowhere, listed; refresh with the fee credits A - F once`, async () => {
      const { id, ref, row } = await paidNgn(fees);
      // The client paid.
      assert.equal(stored(id).status, "paid");
      assert.equal(app(APP_A).amountPaid, PRICE_CENTS);
      // Written with A and the unknown status, no fee.
      assert.equal(row.amount, A);
      assert.equal(row.paystackFeeStatus, "unknown");
      assert.equal("paystackFeeMinor" in row, false);
      assert.equal("agentCreditMinor" in row, false);
      assert.equal("paystackFeeResolvedAt" in row, false);

      // Counted nowhere, so never withdrawable.
      const bal = await balanceOf(agentA);
      assert.deepEqual([bal.heldBalance, bal.availableBalance, bal.totalRevenue], [0, 0, 0]);
      assert.equal((await withdraw(1)).status, 400);
      // The agent sees it waiting for the payment provider's fee.
      const agentRow = (await listTransactions(agentA)).body.data.find((t: any) => t.id === row.id);
      assert.equal(agentRow.paystackFeeStatus, "unknown");

      // Listed for admins.
      const listed = await listTransactions(admin, { role: "admin", type: "escrow_release", paystackFeeStatus: "unknown" });
      assert.equal(listed.status, 200);
      assert.deepEqual(listed.body.data.map((t: any) => t.id), [row.id]);

      // Still unknown at Paystack: 409, nothing written.
      const before = JSON.stringify(rowOf(id));
      const still = await refresh(admin, row.id);
      assert.equal(still.status, 409);
      assert.equal(still.body.error, "PAYSTACK_FEE_UNKNOWN");
      assert.equal(JSON.stringify(rowOf(id)), before, "nothing written");

      // Paystack now reports it: stored once, credited A - F.
      paystackReports(ref, id, A, "NGN", F);
      const done = await refresh(admin, row.id);
      assert.equal(done.status, 200);
      assert.equal(done.body.data.refreshed, true);
      const resolved = rowOf(id);
      assert.equal(resolved.paystackFeeStatus, "known");
      assert.equal(resolved.paystackFeeMinor, F);
      assert.equal(resolved.agentCreditMinor, A - F);
      assert.equal(resolved.paystackFeeResolvedBy, "admin_refresh");
      const after = await balanceOf(agentA);
      assert.equal(after.availableBalance, A - F);
      assert.equal(after.totalRevenue, A - F);

      // A second refresh with another figure writes nothing.
      paystackReports(ref, id, A, "NGN", F + 1);
      const again = await refresh(admin, row.id);
      assert.equal(again.status, 200);
      assert.equal(again.body.data.refreshed, false);
      assert.equal(rowOf(id).paystackFeeMinor, F);
      // No longer listed.
      const none = await listTransactions(admin, { role: "admin", type: "escrow_release", paystackFeeStatus: "unknown" });
      assert.deepEqual(none.body.data, []);
    });
  }

  test("the scheduled job stores the fee once Paystack reports it; still missing it writes nothing", async () => {
    const first = await paidNgn(undefined);
    const second = await paidNgn(null);
    let run = await paystackFeeService.resolveUnknownFees();
    assert.deepEqual(run, { scanned: 2, resolved: 0, stillUnknown: 2, errors: 0 });
    assert.equal(rowOf(first.id).paystackFeeStatus, "unknown");

    paystackReports(first.ref, first.id, A, "NGN", F);
    run = await paystackFeeService.resolveUnknownFees();
    assert.deepEqual(run, { scanned: 2, resolved: 1, stillUnknown: 1, errors: 0 });
    const resolved = rowOf(first.id);
    assert.equal(resolved.paystackFeeMinor, F);
    assert.equal(resolved.paystackFeeResolvedBy, "job");
    assert.equal((await balanceOf(agentA)).availableBalance, A - F, "from now on it counts as A - F");
    assert.equal(rowOf(second.id).paystackFeeStatus, "unknown");

    // A Paystack outage counts as still unknown and does not stop the run.
    harness.failNextLookup = true;
    run = await paystackFeeService.resolveUnknownFees();
    assert.deepEqual(run, { scanned: 1, resolved: 0, stillUnknown: 1, errors: 0 });
  });

  test("a fee reported later in ANOTHER currency stays unknown (409)", async () => {
    // At settle Paystack's currency must equal the charge's (else a mismatch,
    // nothing written), so a foreign fee can only come from a later lookup.
    const { id, ref, row } = await paidNgn(undefined);
    paystackReports(ref, id, A, "GHS", F);
    const out = await refresh(admin, row.id);
    assert.equal(out.status, 409);
    assert.equal(rowOf(id).paystackFeeStatus, "unknown");
  });

  test("F >= A at settle: counted nowhere, listed with the reason, never overwritten", async () => {
    for (const fees of [A, A + 1]) {
      await resetPaymentRequests();
      const { id, ref, row } = await paidNgn(fees);
      assert.equal(row.paystackFeeStatus, "fee_not_less_than_amount");
      assert.equal(row.paystackFeeMinor, fees);
      assert.equal("agentCreditMinor" in row, false);
      const bal = await balanceOf(agentA);
      assert.deepEqual([bal.heldBalance, bal.availableBalance, bal.totalRevenue], [0, 0, 0]);
      assert.equal((await withdraw(1)).status, 400);
      const listed = await listTransactions(admin, {
        role: "admin", type: "escrow_release", paystackFeeStatus: "fee_not_less_than_amount",
      });
      assert.deepEqual(listed.body.data.map((t: any) => t.id), [row.id]);
      // A refresh never overwrites a stored fee.
      paystackReports(ref, id, A, "NGN", F);
      const out = await refresh(admin, row.id);
      assert.equal(out.body.data.refreshed, false);
      assert.equal(rowOf(id).paystackFeeMinor, fees);
    }
  });

  test("F >= A found later by the job: stored with the reason, still credited nowhere", async () => {
    const { id, ref } = await paidNgn(undefined);
    paystackReports(ref, id, A, "NGN", A);
    await paystackFeeService.resolveUnknownFees();
    const row = rowOf(id);
    assert.equal(row.paystackFeeStatus, "fee_not_less_than_amount");
    assert.equal(row.paystackFeeMinor, A);
    assert.equal((await balanceOf(agentA)).availableBalance, 0);
  });
});

// ============================================
// Authz of the admin routes on payment-request rows
// ============================================

describe("admin-only fee routes on payment-request rows", () => {
  test("refresh: agent, owner and client 403 before anything is read; nothing written", async () => {
    const { id, ref, row } = await paidNgn(undefined);
    paystackReports(ref, id, A, "NGN", F);
    for (const p of [agentA, ownerA, clientNg]) {
      const out = await refresh(p, row.id);
      assert.equal(out.status, 403, `role ${p.role}`);
    }
    assert.equal(rowOf(id).paystackFeeStatus, "unknown");
  });

  test("the unknown-fee list filter is admin only", async () => {
    await paidNgn(undefined);
    for (const [p, query] of [
      [clientNg, { role: "admin" }], [agentA, { role: "admin" }], [agentA, {}], [ownerA, { role: "owner" }],
    ] as Array<[AuthzSubject, Record<string, unknown>]>) {
      const out = await listTransactions(p, { ...query, type: "escrow_release", paystackFeeStatus: "unknown" });
      assert.equal(out.status, 403, `${p.role} ${JSON.stringify(query)}`);
    }
  });
});

// ============================================
// Idempotency and concurrency
// ============================================

describe("one Transaction and one stored fee per reference", () => {
  test("verify x2, webhook and a direct settle at once: one Transaction, one fee, amountPaid moved once", async () => {
    const id = await createRequest();
    const ref = await approve(id);
    paystackReports(ref, id, A, "NGN", F);
    const reported = harness.paystack.get(ref)!;
    const results = await Promise.all([
      verify(id, ref),
      webhook(id, ref, { amount: A, currency: "NGN", fees: F + 7 }),
      settlePaymentRequest(id, ref, { ...reported, fees: F + 9 }),
      verify(id, ref),
    ]);
    assert.equal((results[0] as any).status, 200);
    const row = rowOf(id);
    assert.ok([F, F + 7, F + 9].includes(row.paystackFeeMinor), "the fee of whichever settled first");
    assert.equal(row.agentCreditMinor, A - row.paystackFeeMinor);
    assert.equal(app(APP_A).amountPaid, PRICE_CENTS, "amountPaid moved once");
    assert.equal((await balanceOf(agentA)).availableBalance, A - row.paystackFeeMinor);

    // A later webhook and a direct settle with other fees change nothing.
    const storedFee = row.paystackFeeMinor;
    await webhook(id, ref, { amount: A, currency: "NGN", fees: F + 100 });
    const later = await settlePaymentRequest(id, ref, { ...reported, fees: F + 200 });
    assert.equal(later?.kind, "already_paid");
    assert.equal(rowOf(id).paystackFeeMinor, storedFee);
    assert.equal(app(APP_A).amountPaid, PRICE_CENTS);
  });

  test("an unknown fee then a webhook WITH the fee: the stored row is not rewritten by settlement", async () => {
    const { id, ref } = await paidNgn(undefined);
    await webhook(id, ref, { amount: A, currency: "NGN", fees: F });
    const row = rowOf(id);
    assert.equal(row.paystackFeeStatus, "unknown", "a second settle is already_paid and writes nothing");
    // The job is what stores it.
    paystackReports(ref, id, A, "NGN", F);
    await paystackFeeService.resolveUnknownFees();
    assert.equal(rowOf(id).paystackFeeMinor, F);
  });

  test("two refreshes and the job at once store the fee once", async () => {
    const { id, ref, row } = await paidNgn(undefined);
    paystackReports(ref, id, A, "NGN", F);
    const [r1, r2, job] = await Promise.all([refresh(admin, row.id), refresh(admin, row.id), paystackFeeService.resolveUnknownFees()]);
    assert.equal(r1.status, 200);
    assert.equal(r2.status, 200);
    // At most one refresh can be the writer; the job counts an already-stored fee as resolved too.
    assert.ok([r1, r2].filter((r) => r.body.data.refreshed === true).length <= 1);
    assert.equal(job.errors, 0);
    const resolved = rowOf(id);
    assert.equal(resolved.paystackFeeMinor, F);
    assert.equal((await balanceOf(agentA)).availableBalance, A - F, "counted once");
  });

  test("a refresh racing the job: the second writer re-checks in its transaction and writes nothing", async () => {
    const { id, ref, row } = await paidNgn(undefined);
    paystackReports(ref, id, A, "NGN", F);
    let raced = false;
    harness.onLookup = async () => {
      if (raced) return undefined;
      raced = true;
      await paystackFeeService.resolveOne(row.id, "job");
      // Paystack would now report another figure: must never overwrite F.
      return toTransactionLookup({ status: "success", amount: A, currency: "NGN", fees: F + 999 });
    };
    const out = await refresh(admin, row.id);
    assert.equal(out.status, 200);
    assert.equal(out.body.data.refreshed, false);
    assert.equal(rowOf(id).paystackFeeMinor, F);
    assert.equal(rowOf(id).paystackFeeResolvedBy, "job");
  });
});

// ============================================
// Withdrawals
// ============================================

describe("withdrawal (withdrawWithBalanceCheck)", () => {
  test("a known-fee row allows withdrawing A - F and no more", async () => {
    await paidNgn(F);
    assert.equal((await withdraw(A - F + 1)).status, 400);
    assert.equal((await withdraw(A)).status, 400);
    assert.equal((await withdraw(A - F)).status, 201);
    assert.equal((await withdraw(1)).status, 400, "nothing left");
  });

  test("an unknown-fee row is not withdrawable until the fee is stored", async () => {
    const { id, ref, row } = await paidNgn(undefined);
    assert.equal((await withdraw(1)).status, 400);
    paystackReports(ref, id, A, "NGN", F);
    assert.equal((await refresh(admin, row.id)).status, 200);
    assert.equal((await withdraw(A - F + 1)).status, 400);
    assert.equal((await withdraw(A - F)).status, 201);
  });
});

// ============================================
// Payments that cannot be applied
// ============================================

describe("paymentRequestExceptions record Paystack's fee", () => {
  test("a payment on a request cancelled meanwhile: fee stored on the exception, no Transaction, no balance", async () => {
    const id = await createRequest();
    const ref = await approve(id);
    store.set(`paymentRequests/${id}`, { ...stored(id), status: "cancelled" });
    paystackReports(ref, id, A, "NGN", F);
    assert.equal((await verify(id, ref)).status, 409);
    const [[exId, exception]] = docsIn("paymentRequestExceptions");
    assert.equal(exId, ref);
    assert.equal(exception.reason, "request_not_payable");
    assert.equal(exception.amountMinor, A);
    assert.equal(exception.currency, "NGN");
    assert.equal(exception.paystackFeeMinor, F);
    assert.equal(paymentTxns().length, 0);
    const bal = await balanceOf(agentA);
    assert.deepEqual([bal.availableBalance, bal.totalRevenue], [0, 0]);

    // Idempotent: a webhook with another fee never changes the record.
    await webhook(id, ref, { amount: A, currency: "NGN", fees: F + 1 });
    assert.equal(docsIn("paymentRequestExceptions").length, 1);
    assert.equal(docsIn("paymentRequestExceptions")[0][1].paystackFeeMinor, F);
  });

  test("a second payment on a superseded reference of a paid request records its fee", async () => {
    const id = await createRequest();
    const old = await approve(id);
    paystackRequestStatus(old, id, "abandoned");
    // Past the quote lock, at a new rate, re-issue the checkout.
    harness.clock.advanceHours(1);
    setRate("NGN", 1600);
    const { out, res } = captureRes();
    await paymentRequestController.checkoutPaymentRequest(reqFor(clientNg, { params: { id } }), res);
    assert.equal(out.status, 200, JSON.stringify(out.body));
    const newRef = stored(id).paystackReference;
    paystackReports(newRef, id, 24_000_000, "NGN", F);
    assert.equal((await verify(id, newRef)).status, 200);
    // The old checkout is paid too: held for refund, with ITS fee.
    paystackReports(old, id, A, "NGN", 180_000);
    assert.equal((await verify(id, old)).status, 200);
    const [[, exception]] = docsIn("paymentRequestExceptions");
    assert.equal(exception.reason, "paid_on_superseded_reference_after_request_paid");
    assert.equal(exception.paystackFeeMinor, 180_000);
    assert.equal(paymentTxns().length, 1);
    assert.equal(rowOf(id).paystackFeeMinor, F, "the settled row keeps its own fee");
  });

  test("no well-formed fee: the exception stores none (never 0 by default)", async () => {
    for (const fees of [undefined, null, -5, "100", 1.5]) {
      await resetPaymentRequests();
      const id = await createRequest();
      const ref = await approve(id);
      store.set(`paymentRequests/${id}`, { ...stored(id), status: "rejected" });
      paystackReports(ref, id, A, "NGN", fees);
      await verify(id, ref);
      const [[, exception]] = docsIn("paymentRequestExceptions");
      assert.equal("paystackFeeMinor" in exception, false, String(fees));
    }
  });

  test("the webhook path records the fee on an exception too", async () => {
    const id = await createRequest();
    const ref = await approve(id);
    store.set(`paymentRequests/${id}`, { ...stored(id), status: "expired" });
    await webhook(id, ref, { amount: A, currency: "NGN", fees: F });
    const [[, exception]] = docsIn("paymentRequestExceptions");
    assert.equal(exception.paystackFeeMinor, F);
  });
});

// ============================================
// Legacy rows
// ============================================

describe("legacy escrow_release rows (written before #393)", () => {
  test("keep counting as A, are never looked up, and a refresh says FEE_NOT_TRACKED", async () => {
    await seed("transactions", "legacy-pr", {
      id: "legacy-pr", userId: clientNg.uid, agentId: agentA.uid, applicationId: APP_A, paymentRequestId: "pr-old",
      type: "escrow_release", amount: A, currency: "NGN", status: "released", isEscrow: false,
      paymentProvider: "paystack", providerTransactionId: "ps-old-ref", description: "Escrow release for: old",
      createdAt: T0, updatedAt: T0,
    });
    const bal = await balanceOf(agentA);
    assert.equal(bal.availableBalance, A);
    assert.equal(bal.totalRevenue, A);
    const out = await refresh(admin, "legacy-pr");
    assert.equal(out.status, 409);
    assert.equal(out.body.error, "FEE_NOT_TRACKED");
    assert.equal((await paystackFeeService.resolveUnknownFees()).scanned, 0);
    assert.equal((await withdraw(A)).status, 201);
  });
});
