// ============================================
// Unit tests — paying a dollar payment request in local currency (issue #181)
// ============================================
//
// Paystack is stubbed throughout (test/consultations/harness.ts): no real
// charge, no network. Covers:
//  - approve: quote at checkout start in the client's currency, the snapshot
//    on the request, Paystack gets exactly the stored amount/currency under
//    OUR reference; no rate -> 503 and nothing written;
//  - the re-issue route (#152): same checkout inside the lock, fresh quote
//    after it, never while a payment is in flight, superseded references
//    kept;
//  - settlement (verify AND webhook): exact amount and currency, a mismatch
//    never settles, ONE Transaction ever (charged minor units + priceUsdCents
//    + the rate snapshot), the case's amountPaid in US cents;
//  - immutability once paid (re-issue, re-verify, the status route);
//  - races: verify vs re-issue, re-issue vs re-issue, verify vs webhook;
//  - legacy kobo requests: list, display and settle as before, never
//    rewritten;
//  - the copy: explicit currency codes, dollar price plus local amount.
import { test, describe, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as crypto from "crypto";

import {
  usePaymentRequestHarness,
  resetPaymentRequests,
  reqFor,
  sent,
  agentA,
  clientNg,
  clientGh,
  APP_A,
  APP_A_GH,
  harness,
  seed,
  T0,
  paystackPaidRequest,
  paystackRequestStatus,
  seedLegacyRequest,
} from "./helpers";
import { captureRes, docsIn, setRate, dropRate } from "../consultations/harness";
import { store } from "../helpers/fake-firestore";
import { paymentRequestController } from "../../src/controllers/payment-request.controller";
import { entitlementController } from "../../src/controllers/entitlement.controller";
import { applicationPaymentUpdate } from "../../src/services/payment-request-settlement.service";
import { describeRequestAmount } from "../../src/services/payment-request-charge.service";
import { formatWithCode } from "../../src/money/money";
import { messagingService } from "../../src/services/messaging.service";

/* eslint-disable @typescript-eslint/no-explicit-any */

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

/** $150.00 at ₦1,500/$ = ₦225,000.00 = 22,500,000 kobo. */
const PRICE_CENTS = 15_000;
const NGN_KOBO = 22_500_000;

/** The stored request doc. */
const stored = (id: string) => store.get(`paymentRequests/${id}`) as any;
/** The stored case doc. */
const app = (id: string) => store.get(`applications/${id}`) as any;

/** Create a $150 request on agency A's Nigerian case; returns its id. */
async function createRequest(applicationId = APP_A, amount = "150.00"): Promise<string> {
  const { out, res } = captureRes();
  await paymentRequestController.createPaymentRequest(
    reqFor(agentA, { body: { applicationId, amount, description: "Visa Processing Fee" } }),
    res
  );
  assert.equal(out.status, 201, JSON.stringify(out.body));
  return out.body.data.id;
}

/** PUT /:id/approve as `who` (default the Nigerian client). */
async function approve(id: string, who: any = clientNg) {
  const { out, res } = captureRes();
  await paymentRequestController.approvePaymentRequest(reqFor(who, { params: { id } }), res);
  return out;
}

/** POST /:id/checkout as `who`. */
async function checkout(id: string, who: any = clientNg) {
  const { out, res } = captureRes();
  await paymentRequestController.checkoutPaymentRequest(reqFor(who, { params: { id } }), res);
  return out;
}

/** POST /:id/verify as `who`. */
async function verify(id: string, reference: string, who: any = clientNg) {
  const { out, res } = captureRes();
  await paymentRequestController.verifyPayment(reqFor(who, { params: { id }, body: { reference } }), res);
  return out;
}

/** A signed Paystack charge.success webhook for a payment request. */
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

/** Move the clock past the quote lock and publish a new rate (so a re-quote differs). */
function expireLockAndMoveRate(rate = 1600): void {
  harness.clock.advanceHours(1);
  setRate("NGN", rate);
  setRate("GHS", 16);
}

/** Every payment-request Transaction. */
const paymentTxns = () => docsIn("transactions").filter(([, t]) => t.paymentRequestId);

// ============================================
// Approve: quote at checkout start
// ============================================

describe("approve: the server quotes at checkout start", () => {
  test("stores the snapshot and lock on the request; Paystack gets exactly that, under our reference", async () => {
    const id = await createRequest();
    const out = await approve(id);
    assert.equal(out.status, 200, JSON.stringify(out.body));
    const pr = stored(id);
    assert.equal(pr.status, "approved");
    assert.equal(pr.priceUsdCents, PRICE_CENTS);
    assert.equal(pr.chargedCurrency, "NGN");
    assert.equal(pr.chargedAmountMinor, NGN_KOBO);
    assert.equal(pr.fxRate, 1500);
    assert.equal(pr.fxRateSource, "cbn");
    assert.equal(pr.fxMarginBps, 0);
    assert.ok(pr.fxRateAsOf);
    assert.equal(pr.quoteExpiresAt.toMillis() - pr.quoteLockedAt.toMillis(), 30 * 60_000);
    assert.match(pr.paystackReference, /^preq-/);
    assert.equal(pr.checkoutUrl, `https://checkout.paystack.test/${pr.paystackReference}`);
    // Paystack: exactly the stored amount and currency, our reference, our metadata.
    assert.equal(harness.charges.length, 1);
    assert.deepEqual(harness.charges[0].amount, { amountMinor: NGN_KOBO, currency: "NGN" });
    assert.equal(harness.charges[0].reference, pr.paystackReference);
    assert.equal(harness.charges[0].email, "delivered+client-ng@resend.dev");
    assert.equal(harness.charges[0].metadata?.purpose, "payment_request");
    assert.equal(harness.charges[0].metadata?.paymentRequestId, id);
    // Response: the checkout plus the display string with both amounts.
    assert.equal(out.body.data.authorizationUrl, pr.checkoutUrl);
    assert.equal(out.body.data.paystackReference, pr.paystackReference);
    assert.equal(out.body.data.amountDisplay, "USD 150.00 (NGN 225,000.00)");
  });

  test("a client in Ghana is charged in cedis", async () => {
    const id = await createRequest(APP_A_GH);
    const out = await approve(id, clientGh);
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.equal(stored(id).chargedCurrency, "GHS");
    assert.equal(stored(id).chargedAmountMinor, 225_000); // $150 x 15 = GH₵2,250.00
    assert.deepEqual(harness.charges[0].amount, { amountMinor: 225_000, currency: "GHS" });
  });

  test("no rate: 503 PRICING_UNAVAILABLE, the request stays pending, no Paystack call", async () => {
    const id = await createRequest();
    dropRate("NGN");
    const out = await approve(id);
    assert.equal(out.status, 503);
    assert.equal(out.body.error, "PRICING_UNAVAILABLE");
    assert.equal(stored(id).status, "pending");
    assert.equal(stored(id).chargedAmountMinor, undefined);
    assert.equal(harness.charges.length, 0);
  });

  test("a stale rate is 503 too", async () => {
    const id = await createRequest();
    harness.clock.advanceHours(24 * 30);
    assert.equal((await approve(id)).status, 503);
    assert.equal(harness.charges.length, 0);
  });

  test("only the client (or an admin) can approve; only a pending request", async () => {
    const id = await createRequest();
    assert.equal((await approve(id, clientGh)).status, 403);
    assert.equal((await approve(id, agentA)).status, 403);
    assert.equal((await approve(id)).status, 200);
    assert.equal((await approve(id)).status, 400);
    assert.equal(harness.charges.length, 1);
  });

  test("a Paystack outage is 502; the re-issue route then opens a checkout", async () => {
    const id = await createRequest();
    harness.failNextCharge = true;
    const out = await approve(id);
    assert.equal(out.status, 502);
    assert.equal(out.body.error, "BILLING_PROVIDER_ERROR");
    assert.equal(stored(id).status, "approved");
    assert.equal(stored(id).checkoutUrl, null);
    const again = await checkout(id);
    assert.equal(again.status, 200, JSON.stringify(again.body));
    assert.equal(again.body.data.requiresPayment, true);
    assert.equal(stored(id).checkoutUrl, again.body.data.authorizationUrl);
  });
});

// ============================================
// Re-issue (#152): lock, re-quote, in flight, superseded
// ============================================

describe("re-issuing the checkout (POST /:id/checkout)", () => {
  test("inside the lock: the same checkout, no new Paystack call", async () => {
    const id = await createRequest();
    const first = (await approve(id)).body.data;
    paystackRequestStatus(first.paystackReference, id, "abandoned");
    const out = await checkout(id);
    assert.equal(out.status, 200);
    assert.equal(out.body.data.reference, first.paystackReference);
    assert.equal(out.body.data.authorizationUrl, first.authorizationUrl);
    assert.equal(harness.charges.length, 1);
  });

  test("after the lock: a fresh quote of the same dollar price, the old reference superseded with its snapshot", async () => {
    const id = await createRequest();
    const first = (await approve(id)).body.data;
    paystackRequestStatus(first.paystackReference, id, "abandoned");
    expireLockAndMoveRate(1600);
    const out = await checkout(id);
    assert.equal(out.status, 200, JSON.stringify(out.body));
    const pr = stored(id);
    assert.notEqual(pr.paystackReference, first.paystackReference);
    assert.equal(pr.priceUsdCents, PRICE_CENTS);
    assert.equal(pr.fxRate, 1600);
    assert.equal(pr.chargedAmountMinor, 24_000_000);
    assert.equal(pr.supersededCheckouts.length, 1);
    assert.equal(pr.supersededCheckouts[0].reference, first.paystackReference);
    assert.equal(pr.supersededCheckouts[0].chargedAmountMinor, NGN_KOBO);
    assert.equal(harness.charges.length, 2);
    assert.deepEqual(harness.charges[1].amount, { amountMinor: 24_000_000, currency: "NGN" });
  });

  for (const status of ["ongoing", "pending", "processing", "queued", "reversed"]) {
    test(`never re-quoted while Paystack reports "${status}": 409 PAYMENT_IN_PROGRESS, same checkout`, async () => {
      const id = await createRequest();
      const first = (await approve(id)).body.data;
      paystackRequestStatus(first.paystackReference, id, status);
      expireLockAndMoveRate();
      const out = await checkout(id);
      assert.equal(out.status, 409);
      assert.equal(out.body.error, "PAYMENT_IN_PROGRESS");
      assert.equal(out.body.data.reference, first.paystackReference);
      assert.equal(stored(id).chargedAmountMinor, NGN_KOBO);
      assert.equal(harness.charges.length, 1);
    });
  }

  test("no rate after the lock: 503, nothing re-quoted", async () => {
    const id = await createRequest();
    const first = (await approve(id)).body.data;
    paystackRequestStatus(first.paystackReference, id, "failed");
    harness.clock.advanceHours(1);
    dropRate("NGN");
    const out = await checkout(id);
    assert.equal(out.status, 503);
    assert.equal(stored(id).paystackReference, first.paystackReference);
    assert.equal(stored(id).fxRate, 1500);
  });

  test("only the request's client; a pending or legacy request is not payable here", async () => {
    const id = await createRequest();
    assert.equal((await checkout(id)).status, 409); // still pending
    await approve(id);
    assert.equal((await checkout(id, clientGh)).status, 403);
    await seedLegacyRequest("legacy-approved", { status: "approved", paystackReference: "ps-legacy-1" });
    const legacy = await checkout("legacy-approved");
    assert.equal(legacy.status, 409);
    assert.equal(legacy.body.error, "REQUEST_NOT_PAYABLE");
  });

  test("the current checkout was in fact paid: settled here, no new checkout", async () => {
    const id = await createRequest();
    const first = (await approve(id)).body.data;
    paystackPaidRequest(first.paystackReference, id, { amountMinor: NGN_KOBO, currency: "NGN" });
    expireLockAndMoveRate();
    const out = await checkout(id);
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.equal(out.body.data.requiresPayment, false);
    assert.equal(stored(id).status, "paid");
    assert.equal(paymentTxns().length, 1);
    assert.equal(harness.charges.length, 1);
  });
});

// ============================================
// Settlement: exact match, one Transaction, the case's totals
// ============================================

describe("settlement (verify)", () => {
  test("an exact payment settles: ONE Transaction in the charged currency with priceUsdCents; amountPaid += US cents", async () => {
    const id = await createRequest();
    const ref = (await approve(id)).body.data.paystackReference;
    paystackPaidRequest(ref, id, { amountMinor: NGN_KOBO, currency: "NGN" });
    const out = await verify(id, ref);
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.equal(out.body.message, "Payment completed");
    const pr = stored(id);
    assert.equal(pr.status, "paid");
    assert.ok(pr.paidAt);
    const txns = paymentTxns();
    assert.equal(txns.length, 1);
    const [txId, t] = txns[0];
    assert.equal(pr.paymentTransactionId, txId);
    assert.equal(t.amount, NGN_KOBO);
    assert.equal(t.currency, "NGN");
    assert.equal(t.priceUsdCents, PRICE_CENTS);
    assert.equal(t.chargedAmountMinor, NGN_KOBO);
    assert.equal(t.chargedCurrency, "NGN");
    assert.equal(t.fxRate, 1500);
    assert.equal(t.fxRateSource, "cbn");
    assert.equal(t.paymentProvider, "paystack");
    assert.equal(t.providerTransactionId, ref);
    // The agent's USER uid, so the agent's GET /transactions finds it.
    assert.equal(t.agentId, agentA.uid);
    assert.equal(t.userId, clientNg.uid);
    // The case: US cents, matching its US-cent total.
    assert.equal(app(APP_A).amountPaid, PRICE_CENTS);
    assert.equal(app(APP_A).costCurrency, "USD");
    assert.equal(app(APP_A).paymentStatus, "partial");
    // The agent hears about it with both amounts and explicit codes.
    const note = sent.find((n) => n.type === "payment_received");
    assert.ok(note);
    assert.match(note!.body, /USD 150\.00 \(NGN 225,000\.00\)/);
  });

  test("a second verify writes nothing more", async () => {
    const id = await createRequest();
    const ref = (await approve(id)).body.data.paystackReference;
    paystackPaidRequest(ref, id, { amountMinor: NGN_KOBO, currency: "NGN" });
    await verify(id, ref);
    const again = await verify(id, ref);
    assert.equal(again.status, 200);
    assert.equal(again.body.message, "Payment already completed");
    assert.equal(paymentTxns().length, 1);
    assert.equal(app(APP_A).amountPaid, PRICE_CENTS);
  });

  for (const [label, reported] of [
    ["one kobo short", { amount: NGN_KOBO - 1, currency: "NGN" }],
    ["the dollar figure in kobo", { amount: PRICE_CENTS, currency: "NGN" }],
    ["the right number in the wrong currency", { amount: NGN_KOBO, currency: "GHS" }],
    ["no amount reported", { amount: undefined, currency: "NGN" }],
    ["no currency reported", { amount: NGN_KOBO, currency: undefined }],
    ["requested_amount short (amount inflated by fees)", { amount: NGN_KOBO + 50_000, requestedAmount: NGN_KOBO - 100, currency: "NGN" }],
  ] as Array<[string, Record<string, unknown>]>) {
    test(`mismatch (${label}): 400 PAYMENT_MISMATCH, not paid, nothing written`, async () => {
      const id = await createRequest();
      const ref = (await approve(id)).body.data.paystackReference;
      harness.paystack.set(ref, {
        status: "success",
        metadata: { purpose: "payment_request", paymentRequestId: id },
        ...reported,
      } as any);
      const out = await verify(id, ref);
      assert.equal(out.status, 400);
      assert.equal(out.body.error, "PAYMENT_MISMATCH");
      assert.equal(stored(id).status, "approved");
      assert.equal(paymentTxns().length, 0);
      assert.equal(app(APP_A).amountPaid, 0);
    });
  }

  test("requested_amount exact with amount inflated by fees settles at the requested amount", async () => {
    const id = await createRequest();
    const ref = (await approve(id)).body.data.paystackReference;
    paystackPaidRequest(ref, id, { amountMinor: NGN_KOBO + 50_000, currency: "NGN" }, { requestedAmount: NGN_KOBO });
    assert.equal((await verify(id, ref)).status, 200);
    assert.equal(paymentTxns()[0][1].amount, NGN_KOBO);
  });

  test("a reference that is not one of this request's checkouts is refused", async () => {
    const id = await createRequest();
    await approve(id);
    paystackPaidRequest("someone-elses-ref", id, { amountMinor: NGN_KOBO, currency: "NGN" });
    const out = await verify(id, "someone-elses-ref");
    assert.equal(out.status, 400);
    assert.equal(stored(id).status, "approved");
  });

  test("metadata naming another request is refused", async () => {
    const id = await createRequest();
    const ref = (await approve(id)).body.data.paystackReference;
    paystackPaidRequest(ref, "other-request", { amountMinor: NGN_KOBO, currency: "NGN" });
    assert.equal((await verify(id, ref)).status, 400);
    assert.equal(stored(id).status, "approved");
  });

  test("only the request's client (or an admin) may verify", async () => {
    const id = await createRequest();
    const ref = (await approve(id)).body.data.paystackReference;
    paystackPaidRequest(ref, id, { amountMinor: NGN_KOBO, currency: "NGN" });
    assert.equal((await verify(id, ref, clientGh)).status, 403);
    assert.equal(stored(id).status, "approved");
  });

  test("not paid inside the lock: 200 'Payment not completed', as before", async () => {
    const id = await createRequest();
    const ref = (await approve(id)).body.data.paystackReference;
    paystackRequestStatus(ref, id, "abandoned");
    const out = await verify(id, ref);
    assert.equal(out.status, 200);
    assert.equal(out.body.message, "Payment not completed");
    assert.equal(out.body.data.paymentStatus, "abandoned");
  });

  test("not paid after the lock: 409 QUOTE_EXPIRED with a fresh checkout", async () => {
    const id = await createRequest();
    const ref = (await approve(id)).body.data.paystackReference;
    paystackRequestStatus(ref, id, "abandoned");
    expireLockAndMoveRate(1600);
    const out = await verify(id, ref);
    assert.equal(out.status, 409);
    assert.equal(out.body.error, "QUOTE_EXPIRED");
    assert.equal(out.body.data.reference, stored(id).paystackReference);
    assert.equal(stored(id).chargedAmountMinor, 24_000_000);
  });

  test("an exact payment on a SUPERSEDED reference settles a still-unpaid request at that checkout's own price", async () => {
    const id = await createRequest();
    const old = (await approve(id)).body.data.paystackReference;
    paystackRequestStatus(old, id, "abandoned");
    expireLockAndMoveRate(1600);
    await checkout(id);
    const newRef = stored(id).paystackReference;
    // The payer completes the OLD checkout after all, for the old amount.
    paystackPaidRequest(old, id, { amountMinor: NGN_KOBO, currency: "NGN" });
    const out = await verify(id, old);
    assert.equal(out.status, 200, JSON.stringify(out.body));
    const pr = stored(id);
    assert.equal(pr.status, "paid");
    assert.equal(pr.paystackReference, old);
    assert.equal(pr.chargedAmountMinor, NGN_KOBO);
    assert.equal(pr.fxRate, 1500);
    assert.equal(pr.paidOnSupersededReference, true);
    assert.ok(pr.supersededCheckouts.some((s: any) => s.reference === newRef));
    const txns = paymentTxns();
    assert.equal(txns.length, 1);
    assert.equal(txns[0][1].amount, NGN_KOBO);
    assert.equal(txns[0][1].paidOnSupersededReference, true);
  });

  test("a second payment on a superseded reference of a PAID request is held for refund, no second Transaction", async () => {
    const id = await createRequest();
    const old = (await approve(id)).body.data.paystackReference;
    paystackRequestStatus(old, id, "abandoned");
    expireLockAndMoveRate(1600);
    await checkout(id);
    const newRef = stored(id).paystackReference;
    paystackPaidRequest(newRef, id, { amountMinor: 24_000_000, currency: "NGN" });
    assert.equal((await verify(id, newRef)).status, 200);
    paystackPaidRequest(old, id, { amountMinor: NGN_KOBO, currency: "NGN" });
    const out = await verify(id, old);
    assert.equal(out.status, 200);
    assert.equal(out.body.data.refundPending, true);
    assert.equal(paymentTxns().length, 1);
    const exceptions = docsIn("paymentRequestExceptions");
    assert.equal(exceptions.length, 1);
    assert.equal(exceptions[0][1].reason, "paid_on_superseded_reference_after_request_paid");
    assert.equal(exceptions[0][1].amountMinor, NGN_KOBO);
    // Idempotent.
    await verify(id, old);
    assert.equal(docsIn("paymentRequestExceptions").length, 1);
    assert.equal(app(APP_A).amountPaid, PRICE_CENTS);
  });

  test("a payment on a request cancelled meanwhile is held for refund, not settled", async () => {
    const id = await createRequest();
    const ref = (await approve(id)).body.data.paystackReference;
    store.set(`paymentRequests/${id}`, { ...stored(id), status: "cancelled" });
    paystackPaidRequest(ref, id, { amountMinor: NGN_KOBO, currency: "NGN" });
    const out = await verify(id, ref);
    assert.equal(out.status, 409);
    assert.equal(stored(id).status, "cancelled");
    assert.equal(paymentTxns().length, 0);
    assert.equal(docsIn("paymentRequestExceptions")[0][1].reason, "request_not_payable");
  });

  test("an exact payment that lands after the lock is honoured and flagged", async () => {
    const id = await createRequest();
    const ref = (await approve(id)).body.data.paystackReference;
    harness.clock.advanceHours(1);
    paystackPaidRequest(ref, id, { amountMinor: NGN_KOBO, currency: "NGN" });
    assert.equal((await verify(id, ref)).status, 200);
    assert.equal(stored(id).paidAfterQuoteExpiry, true);
    assert.equal(paymentTxns()[0][1].paidAfterQuoteExpiry, true);
  });
});

describe("settlement (webhook)", () => {
  test("a signed charge.success with the exact amount settles once; a later verify writes nothing", async () => {
    const id = await createRequest();
    const ref = (await approve(id)).body.data.paystackReference;
    const out = await webhook(id, ref, { amount: NGN_KOBO, currency: "NGN" });
    assert.equal(out.body.applied, true);
    assert.equal(stored(id).status, "paid");
    assert.equal(paymentTxns().length, 1);
    paystackPaidRequest(ref, id, { amountMinor: NGN_KOBO, currency: "NGN" });
    assert.equal((await verify(id, ref)).status, 200);
    await webhook(id, ref, { amount: NGN_KOBO, currency: "NGN" });
    assert.equal(paymentTxns().length, 1);
    assert.equal(app(APP_A).amountPaid, PRICE_CENTS);
  });

  test("a webhook with a short amount, the wrong currency or no amount does not settle", async () => {
    const id = await createRequest();
    const ref = (await approve(id)).body.data.paystackReference;
    await webhook(id, ref, { amount: NGN_KOBO - 1, currency: "NGN" });
    await webhook(id, ref, { amount: NGN_KOBO, currency: "USD" });
    await webhook(id, ref, { currency: "NGN" });
    assert.equal(stored(id).status, "approved");
    assert.equal(paymentTxns().length, 0);
  });

  test("an unsigned (forged) webhook is never applied to a request", async () => {
    const id = await createRequest();
    const ref = (await approve(id)).body.data.paystackReference;
    process.env.PAYSTACK_SECRET_KEY = "test-only-not-a-real-key";
    const raw = JSON.stringify({
      event: "charge.success",
      data: { reference: ref, status: "success", amount: NGN_KOBO, currency: "NGN", metadata: { purpose: "payment_request", paymentRequestId: id } },
    });
    const { res } = captureRes();
    await entitlementController.handlePaystackWebhook({ body: Buffer.from(raw), headers: { "x-paystack-signature": "forged" } } as any, res).catch(() => undefined);
    assert.equal(stored(id).status, "approved");
  });
});

// ============================================
// Immutable once paid
// ============================================

describe("once paid, the snapshot is immutable", () => {
  async function paidRequest(): Promise<{ id: string; ref: string; snapshot: any }> {
    const id = await createRequest();
    const ref = (await approve(id)).body.data.paystackReference;
    paystackPaidRequest(ref, id, { amountMinor: NGN_KOBO, currency: "NGN" });
    await verify(id, ref);
    const pr = stored(id);
    return { id, ref, snapshot: { ...pr } };
  }

  test("re-issuing after the lock on a paid request returns requiresPayment:false and changes nothing", async () => {
    const { id, snapshot } = await paidRequest();
    expireLockAndMoveRate(1800);
    const out = await checkout(id);
    assert.equal(out.status, 200);
    assert.equal(out.body.data.requiresPayment, false);
    const pr = stored(id);
    for (const k of ["paystackReference", "chargedAmountMinor", "chargedCurrency", "fxRate", "priceUsdCents", "quoteExpiresAt"]) {
      assert.deepEqual(pr[k], snapshot[k], k);
    }
    assert.equal(harness.charges.length, 1);
  });

  test("approve on a paid request is refused and changes nothing", async () => {
    const { id, snapshot } = await paidRequest();
    expireLockAndMoveRate(1800);
    assert.equal((await approve(id)).status, 400);
    assert.equal(stored(id).fxRate, snapshot.fxRate);
  });

  test("the status route cannot set 'paid' by hand or move a paid request back", async () => {
    const id = await createRequest();
    const status = async (s: string) => {
      const { out, res } = captureRes();
      await paymentRequestController.updatePaymentRequestStatus(reqFor(agentA, { params: { id }, body: { status: s } }), res);
      return out;
    };
    assert.equal((await status("paid")).status, 400);
    assert.equal(stored(id).status, "pending");
    const ref = (await approve(id)).body.data.paystackReference;
    paystackPaidRequest(ref, id, { amountMinor: NGN_KOBO, currency: "NGN" });
    await verify(id, ref);
    const back = await status("approved");
    assert.equal(back.status, 409);
    assert.equal(stored(id).status, "paid");
  });
});

// ============================================
// Races (the #180 harness approach: transactions one at a time, a lookup hook)
// ============================================

describe("races", () => {
  test("a verify confirms the request while a re-issue is re-quoting: no new checkout, one Transaction", async () => {
    const id = await createRequest();
    const ref = (await approve(id)).body.data.paystackReference;
    paystackRequestStatus(ref, id, "abandoned");
    expireLockAndMoveRate(1600);
    // While the re-issue asks Paystack about the current reference, the
    // payment completes and a verify settles it.
    let fired = false;
    harness.onLookup = async (reference) => {
      if (fired) return undefined;
      fired = true;
      paystackPaidRequest(ref, id, { amountMinor: NGN_KOBO, currency: "NGN" });
      harness.onLookup = undefined;
      const v = await verify(id, ref);
      assert.equal(v.status, 200, JSON.stringify(v.body));
      return reference === ref ? { status: "abandoned", metadata: { purpose: "payment_request", paymentRequestId: id } } : undefined;
    };
    const out = await checkout(id);
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.equal(out.body.data.requiresPayment, false);
    assert.equal(stored(id).status, "paid");
    assert.equal(stored(id).paystackReference, ref);
    assert.equal(stored(id).fxRate, 1500);
    assert.equal(paymentTxns().length, 1);
    assert.equal(harness.charges.length, 1);
  });

  test("two re-issues at once after the lock open exactly ONE new checkout, and both get it", async () => {
    const id = await createRequest();
    const ref = (await approve(id)).body.data.paystackReference;
    paystackRequestStatus(ref, id, "failed");
    expireLockAndMoveRate(1600);
    const [a, b] = await Promise.all([checkout(id), checkout(id)]);
    assert.equal(a.status, 200, JSON.stringify(a.body));
    assert.equal(b.status, 200, JSON.stringify(b.body));
    assert.equal(a.body.data.reference, b.body.data.reference);
    assert.equal(harness.charges.length, 2); // the approve + exactly one re-issue
    assert.equal(stored(id).supersededCheckouts.length, 1);
  });

  test("two approvals at once open one checkout", async () => {
    const id = await createRequest();
    const [a, b] = await Promise.all([approve(id), approve(id)]);
    const ok = [a, b].filter((o) => o.status === 200);
    assert.ok(ok.length >= 1);
    for (const o of ok) assert.equal(o.body.data.paystackReference, stored(id).paystackReference);
    assert.equal(harness.charges.length, 1);
  });

  test("verify and webhook at once: one Transaction, amountPaid moved once", async () => {
    const id = await createRequest();
    const ref = (await approve(id)).body.data.paystackReference;
    paystackPaidRequest(ref, id, { amountMinor: NGN_KOBO, currency: "NGN" });
    await Promise.all([verify(id, ref), webhook(id, ref, { amount: NGN_KOBO, currency: "NGN" })]);
    assert.equal(paymentTxns().length, 1);
    assert.equal(app(APP_A).amountPaid, PRICE_CENTS);
  });
});

// ============================================
// Legacy kobo requests
// ============================================

describe("legacy naira requests (kobo, NGN, no snapshot)", () => {
  test("list and get display them as before, flagged legacy, with an explicit code", async () => {
    await seedLegacyRequest("legacy-1");
    const { out, res } = captureRes();
    await paymentRequestController.getPaymentRequest(reqFor(clientNg, { params: { id: "legacy-1" } }), res);
    assert.equal(out.body.data.amount, 2_500_000);
    assert.equal(out.body.data.currency, "NGN");
    assert.equal(out.body.data.legacy, true);
    assert.equal(out.body.data.amountDisplay, "NGN 25,000.00");
    assert.deepEqual(out.body.data.charge, { amountMinor: 2_500_000, currency: "NGN" });
  });

  test("approve opens a naira checkout for its own stored amount, never quoted or rewritten", async () => {
    await seedLegacyRequest("legacy-2");
    const out = await approve("legacy-2");
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.deepEqual(harness.charges[0].amount, { amountMinor: 2_500_000, currency: "NGN" });
    const pr = stored("legacy-2");
    assert.equal(pr.amount, 2_500_000);
    assert.equal(pr.currency, "NGN");
    assert.equal(pr.priceUsd, undefined);
    assert.equal(pr.chargedAmountMinor, undefined);
    assert.equal(pr.fxRate, undefined);
  });

  test("settles against its own kobo amount; the dollar case records it separately (no cents + kobo mixing)", async () => {
    await seedLegacyRequest("legacy-3", { status: "approved", paystackReference: "ps-legacy-3" });
    paystackPaidRequest("ps-legacy-3", "legacy-3", { amountMinor: 2_500_000, currency: "NGN" });
    const out = await verify("legacy-3", "ps-legacy-3");
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.equal(stored("legacy-3").status, "paid");
    const [, t] = paymentTxns()[0];
    assert.equal(t.amount, 2_500_000);
    assert.equal(t.currency, "NGN");
    assert.equal(t.priceUsdCents, undefined);
    // APP_A's total is US cents: the kobo goes to amountPaidOtherCurrencies.
    assert.equal(app(APP_A).amountPaid, 0);
    assert.deepEqual(app(APP_A).amountPaidOtherCurrencies, { NGN: 2_500_000 });
    assert.equal(app(APP_A).costCurrency, "USD");
  });

  test("on a case with no dollar total yet, it settles into amountPaid at its own amount, marked NGN", async () => {
    await seed("applications", "app-legacy", {
      userId: clientNg.uid, agentId: agentA.uid, agencyId: "agency-a", totalCost: 0, amountPaid: 0,
      paymentStatus: "pending", createdAt: T0,
    });
    await seedLegacyRequest("legacy-4", { applicationId: "app-legacy", status: "approved", paystackReference: "ps-legacy-4" });
    paystackPaidRequest("ps-legacy-4", "legacy-4", { amountMinor: 2_500_000, currency: "NGN" });
    assert.equal((await verify("legacy-4", "ps-legacy-4")).status, 200);
    assert.equal(app("app-legacy").amountPaid, 2_500_000);
    assert.equal(app("app-legacy").costCurrency, "NGN");
  });

  test("a short legacy payment is not settled", async () => {
    await seedLegacyRequest("legacy-5", { status: "approved", paystackReference: "ps-legacy-5" });
    paystackPaidRequest("ps-legacy-5", "legacy-5", { amountMinor: 2_499_999, currency: "NGN" });
    assert.equal((await verify("legacy-5", "ps-legacy-5")).status, 400);
    assert.equal(stored("legacy-5").status, "approved");
  });

  test("a legacy request with no stored reference still settles on a reference whose metadata names it (as before)", async () => {
    await seedLegacyRequest("legacy-6", { status: "approved" });
    paystackPaidRequest("ps-unbound", "legacy-6", { amountMinor: 2_500_000, currency: "NGN" });
    assert.equal((await verify("legacy-6", "ps-unbound")).status, 200);
    assert.equal(stored("legacy-6").paystackReference, "ps-unbound");
  });

  test("the legacy webhook path settles too", async () => {
    await seedLegacyRequest("legacy-7", { status: "approved", paystackReference: "ps-legacy-7" });
    await webhook("legacy-7", "ps-legacy-7", { amount: 2_500_000, currency: "NGN" });
    assert.equal(stored("legacy-7").status, "paid");
  });
});

// ============================================
// The case's totals rule and the copy (pure)
// ============================================

describe("applicationPaymentUpdate (the case's totals in one currency)", () => {
  test("same currency: amountPaid moves and the status is recomputed", () => {
    assert.deepEqual(applicationPaymentUpdate({ totalCost: 20_000, amountPaid: 5_000, costCurrency: "USD" }, { amountMinor: 15_000, currency: "USD" }), {
      amountPaid: 20_000, costCurrency: "USD", paymentStatus: "paid",
    });
  });
  test("an old case with a positive total and no currency counts as US cents", () => {
    assert.equal(applicationPaymentUpdate({ totalCost: 20_000, amountPaid: 0 }, { amountMinor: 100, currency: "USD" }).amountPaid, 100);
    assert.deepEqual(applicationPaymentUpdate({ totalCost: 20_000, amountPaid: 0 }, { amountMinor: 100, currency: "NGN" }), {
      amountPaidOtherCurrencies: { NGN: 100 },
    });
  });
  test("a USD payment on a case already counted in NGN is recorded separately too", () => {
    assert.deepEqual(
      applicationPaymentUpdate({ totalCost: 0, amountPaid: 2_500_000, costCurrency: "NGN", amountPaidOtherCurrencies: { USD: 10 } }, { amountMinor: 15_000, currency: "USD" }),
      { amountPaidOtherCurrencies: { USD: 15_010 } }
    );
  });
});

describe("copy", () => {
  test("formatWithCode names the currency", () => {
    assert.equal(formatWithCode({ amountMinor: 22_500_000, currency: "NGN" }), "NGN 225,000.00");
    assert.equal(formatWithCode({ amountMinor: 1_250, currency: "USD" }), "USD 12.50");
    assert.equal(formatWithCode({ amountMinor: 1_500, currency: "UGX" }), "UGX 1,500");
  });

  test("a priced request in cedis never shows a naira sign", () => {
    const text = describeRequestAmount({
      priceUsd: { amountMinor: 15_000, currency: "USD" }, amount: 15_000, currency: "USD",
      priceUsdCents: 15_000, chargedCurrency: "GHS", chargedAmountMinor: 225_000,
    });
    assert.equal(text, "USD 150.00 (GHS 2,250.00)");
    assert.doesNotMatch(text, /₦/);
  });

  test("the rejection message names the dollar price with its code", async () => {
    // The auto-chat is not under test: stub the messaging calls.
    (messagingService as any).getOrCreateConversation = async () => ({ id: "conv-1" });
    (messagingService as any).sendMessage = async () => undefined;
    const id = await createRequest();
    const { out, res } = captureRes();
    await paymentRequestController.rejectPaymentRequest(reqFor(clientNg, { params: { id }, body: { reason: "Too much" } }), res);
    assert.equal(out.status, 200, JSON.stringify(out.body));
    const note = sent.find((n) => n.type === "payment_request_rejected");
    assert.ok(note);
    assert.match(note!.body, /USD 150\.00/);
    assert.doesNotMatch(note!.body, /₦/);
  });
});
