// ============================================
// Unit tests — issue #181 code-review fix round 3
// ============================================
//
// The round-2 blocker: a payment request whose checkout was CLAIMED (our
// `preq-<id>-<uuid>` reference stored) but never OPENED at Paystack (the
// transaction/initialize call threw after the claim, so `checkoutUrl` is
// null). Paystack has never seen that reference, so its verify answers HTTP
// 400 "Transaction reference not found". Before this fix that answer was a
// PAYSTACK_ERROR, every cancel was 502, and the request was stuck for good.
//
// Covered here:
//  - the provider classifies Paystack's precise "not found" answer, and
//    nothing else, as `isPaystackReferenceNotFound` (real PaystackProvider,
//    axios answered by a local adapter: no network);
//  - only OUR references (`preq-` / `cons-` + uuid) count as "never opened";
//  - (1) initialize throws after the claim, then the agent's cancel is 200
//    and the request is cancelled (dollar and legacy naira requests);
//  - (2) a later checkout after such a failure works (fresh checkout, the
//    unopened reference kept in `supersededCheckouts`);
//  - (3) a genuine Paystack outage on the lookup is still 502 and changes
//    nothing (cancel and checkout), and "not found" for a reference Paystack
//    itself generated still fails closed.
//
// Paystack is otherwise stubbed by the shared harness
// (test/consultations/harness.ts) with `realisticNotFound` on: a reference
// it never saw is answered the way real Paystack answers it (a thrown
// PaystackApiError, HTTP 400, code `transaction_not_found`).
import { test, describe, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import axios, { AxiosError } from "axios";

import {
  usePaymentRequestHarness,
  resetPaymentRequests,
  reqFor,
  agentA,
  clientNg,
  APP_A,
  harness,
  paystackRequestStatus,
  seedLegacyRequest,
} from "./helpers";
import { captureRes } from "../consultations/harness";
import { store } from "../helpers/fake-firestore";
import { paymentRequestController } from "../../src/controllers/payment-request.controller";
import { isOwnCheckoutReference } from "../../src/services/charge-checkout.service";
import { newPaymentRequestReference } from "../../src/services/payment-request-charge.service";
import {
  isPaystackReferenceNotFound,
  PaystackApiError,
  PaystackProvider,
} from "../../src/services/billing/paystack.provider";
import type { AuthzSubject } from "@durin-tech/authz";

/* eslint-disable @typescript-eslint/no-explicit-any */

before(async () => {
  await usePaymentRequestHarness();
});
beforeEach(async () => {
  await resetPaymentRequests();
  // Answer unknown references the way real Paystack does (see the header).
  harness.realisticNotFound = true;
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

const stored = (id: string) => store.get(`paymentRequests/${id}`) as any;

/** Create a $150 request on agency A's Nigerian case as agent A; returns its id. */
async function createRequest(): Promise<string> {
  const { out, res } = captureRes();
  await paymentRequestController.createPaymentRequest(
    reqFor(agentA, { body: { applicationId: APP_A, amount: "150.00", description: "Visa Processing Fee" } }),
    res
  );
  assert.equal(out.status, 201, JSON.stringify(out.body));
  return out.body.data.id;
}

/** PUT /:id/approve as the Nigerian client. */
async function approve(id: string) {
  const { out, res } = captureRes();
  await paymentRequestController.approvePaymentRequest(reqFor(clientNg, { params: { id } }), res);
  return out;
}

/** POST /:id/checkout as the Nigerian client. */
async function checkout(id: string) {
  const { out, res } = captureRes();
  await paymentRequestController.checkoutPaymentRequest(reqFor(clientNg, { params: { id } }), res);
  return out;
}

/** PUT /:id/status { status: "cancelled" } as `who` (default agent A, the creator). */
async function cancel(id: string, who: AuthzSubject = agentA) {
  const { out, res } = captureRes();
  await paymentRequestController.updatePaymentRequestStatus(
    reqFor(who, { params: { id }, body: { status: "cancelled" } }),
    res
  );
  return out;
}

/**
 * Approve with Paystack's initialize failing AFTER the claim: the request
 * ends `approved`, carrying our claimed reference and no checkout URL.
 * Returns the claimed (never opened) reference.
 */
async function approveWithFailedOpen(id: string): Promise<string> {
  harness.failNextCharge = true;
  const out = await approve(id);
  assert.equal(out.status, 502, JSON.stringify(out.body));
  assert.equal(out.body.error, "BILLING_PROVIDER_ERROR");
  const pr = stored(id);
  assert.equal(pr.status, "approved");
  assert.match(pr.paystackReference, /^preq-/);
  assert.equal(pr.checkoutUrl, null);
  assert.equal(harness.charges.length, 0, "Paystack opened nothing");
  return pr.paystackReference;
}

/** Status 200 as the controller writes it (sendSuccess may not call status()). */
const ok = (s: number) => s === 0 || s === 200;

// ============================================
// The provider's classification (real PaystackProvider, no network)
// ============================================

describe("isPaystackReferenceNotFound: only Paystack's precise answer", () => {
  // Answer every axios call of the real provider from here: `reply` decides.
  const realAdapter = axios.defaults.adapter;
  let reply: (config: any) => Promise<any>;
  before(() => {
    process.env.PAYSTACK_SECRET_KEY = "test-only-not-a-real-key";
    axios.defaults.adapter = (config: any) => reply(config);
  });
  // Restore axios for anything that runs after this block in the same file.
  after(() => {
    axios.defaults.adapter = realAdapter;
  });

  /** A Paystack HTTP error response, as axios's own adapters reject it. */
  const httpError = (status: number, data: unknown) => (config: any) =>
    Promise.reject(
      new AxiosError("Request failed", "ERR_BAD_REQUEST", config, null, {
        status,
        statusText: "",
        headers: {},
        config,
        data,
      } as any)
    );

  /** What the real provider throws for a lookup answered by `r`. */
  async function lookupError(r: (config: any) => Promise<any>): Promise<unknown> {
    reply = r;
    try {
      await new PaystackProvider().getTransactionMetadata("preq-abc-00000000-0000-0000-0000-000000000000");
    } catch (err) {
      return err;
    }
    assert.fail("the lookup should have thrown");
  }

  test("HTTP 400 'Transaction reference not found' is not-found, and still a PAYSTACK_ERROR", async () => {
    const err = await lookupError(
      httpError(400, { status: false, message: "Transaction reference not found", code: "transaction_not_found" })
    );
    assert.ok(err instanceof PaystackApiError);
    assert.equal(isPaystackReferenceNotFound(err), true);
    // Every existing controller check still maps it to 502 if not handled.
    assert.match((err as Error).message, /^PAYSTACK_ERROR: Transaction reference not found \(HTTP 400\)$/);
  });

  test("the message alone (no code) and HTTP 404 also count", async () => {
    assert.equal(
      isPaystackReferenceNotFound(await lookupError(httpError(400, { status: false, message: "Transaction reference not found" }))),
      true
    );
    assert.equal(
      isPaystackReferenceNotFound(await lookupError(httpError(404, { status: false, message: "Transaction not found" }))),
      true
    );
  });

  test("a network failure, a 5xx, a 401 and any other 400 are NOT not-found", async () => {
    // No response at all (timeout / DNS / connection refused).
    const network = await lookupError((config: any) =>
      Promise.reject(new AxiosError("connect ETIMEDOUT", "ETIMEDOUT", config, null, undefined))
    );
    assert.ok(network instanceof PaystackApiError);
    assert.equal((network as PaystackApiError).httpStatus, undefined);
    assert.equal(isPaystackReferenceNotFound(network), false);
    // A Paystack outage, even if its body happened to say "not found".
    assert.equal(
      isPaystackReferenceNotFound(await lookupError(httpError(503, { message: "Transaction reference not found" }))),
      false
    );
    // A bad secret key.
    assert.equal(isPaystackReferenceNotFound(await lookupError(httpError(401, { status: false, message: "Invalid key" }))), false);
    // Some other validation failure.
    assert.equal(
      isPaystackReferenceNotFound(await lookupError(httpError(400, { status: false, message: "Invalid transaction reference" }))),
      false
    );
    // A plain Error carrying the same text is not Paystack's answer.
    assert.equal(isPaystackReferenceNotFound(new Error("PAYSTACK_ERROR: Transaction reference not found (HTTP 400)")), false);
  });
});

describe("isOwnCheckoutReference: only references we generated", () => {
  test("ours (preq- / cons- + uuid) match; Paystack's own and look-alikes do not", () => {
    assert.equal(isOwnCheckoutReference(newPaymentRequestReference("req123")), true);
    assert.equal(isOwnCheckoutReference("cons-abc123-0a1b2c3d-4e5f-6a7b-8c9d-0e1f2a3b4c5d"), true);
    assert.equal(isOwnCheckoutReference("T123456789012345"), false);
    assert.equal(isOwnCheckoutReference("preq-legacy"), false);
    assert.equal(isOwnCheckoutReference("xpreq-abc-0a1b2c3d-4e5f-6a7b-8c9d-0e1f2a3b4c5d"), false);
  });
});

// ============================================
// (1) Cancel after a checkout that never opened
// ============================================

describe("PUT /:id/status: a claimed checkout Paystack never opened", () => {
  test("dollar request: initialize throws after the claim, then the agent's cancel is 200 and it is cancelled", async () => {
    const id = await createRequest();
    await approveWithFailedOpen(id);
    const out = await cancel(id);
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.equal(out.body.data.status, "cancelled");
    assert.equal(stored(id).status, "cancelled");
    assert.ok(stored(id).cancelledAt);
    // And it stays closed: no checkout is ever opened for it afterwards.
    const again = await checkout(id);
    assert.equal(again.status, 409);
    assert.equal(harness.charges.length, 0);
  });

  test("legacy naira request: the same failure is cancellable too (it had no other way out)", async () => {
    await seedLegacyRequest("legacy-unopened");
    const id = "legacy-unopened";
    await approveWithFailedOpen(id);
    const out = await cancel(id);
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.equal(stored(id).status, "cancelled");
  });

  test("a cancel retried after a first outage goes through once Paystack answers", async () => {
    const id = await createRequest();
    await approveWithFailedOpen(id);
    harness.failNextLookup = true;
    assert.equal((await cancel(id)).status, 502);
    assert.equal(stored(id).status, "approved");
    const out = await cancel(id);
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.equal(stored(id).status, "cancelled");
  });
});

// ============================================
// (2) A later checkout after such a failure
// ============================================

describe("POST /:id/checkout: after a checkout that never opened", () => {
  test("opens a fresh checkout; the unopened reference is kept as superseded", async () => {
    const id = await createRequest();
    const unopened = await approveWithFailedOpen(id);
    const out = await checkout(id);
    assert.ok(ok(out.status), JSON.stringify(out.body));
    assert.equal(out.body.data.requiresPayment, true);
    const pr = stored(id);
    // A new reference of ours, opened at Paystack and published.
    assert.match(pr.paystackReference, /^preq-/);
    assert.notEqual(pr.paystackReference, unopened);
    assert.equal(out.body.data.reference, pr.paystackReference);
    assert.equal(pr.checkoutUrl, out.body.data.authorizationUrl);
    assert.equal(harness.charges.length, 1);
    assert.equal(harness.charges[0].reference, pr.paystackReference);
    // Kept, so even an impossible late payment on it would still be found.
    assert.ok((pr.supersededCheckouts ?? []).some((s: any) => s.reference === unopened));
  });

  test("a checkout that opened but whose URL never got published is still checked for a payment first", async () => {
    // The claimed reference IS known to Paystack (opened), and is in flight:
    // it must not be replaced under the payer even though no URL was stored.
    const id = await createRequest();
    const unopened = await approveWithFailedOpen(id);
    paystackRequestStatus(unopened, id, "ongoing");
    const out = await checkout(id);
    assert.equal(out.status, 409, JSON.stringify(out.body));
    assert.equal(out.body.error, "PAYMENT_IN_PROGRESS");
    assert.equal(stored(id).paystackReference, unopened);
    assert.equal(harness.charges.length, 0);
  });
});

// ============================================
// (3) A genuine Paystack outage still fails closed
// ============================================

describe("a Paystack outage on the lookup is still 502 and changes nothing", () => {
  test("cancel: 502 BILLING_PROVIDER_ERROR, the request untouched", async () => {
    const id = await createRequest();
    await approveWithFailedOpen(id);
    const before = JSON.stringify(stored(id));
    harness.failNextLookup = true;
    const out = await cancel(id);
    assert.equal(out.status, 502, JSON.stringify(out.body));
    assert.equal(out.body.error, "BILLING_PROVIDER_ERROR");
    assert.equal(JSON.stringify(stored(id)), before);
  });

  test("checkout: 502 BILLING_PROVIDER_ERROR, no new checkout, the request untouched", async () => {
    const id = await createRequest();
    await approveWithFailedOpen(id);
    const before = JSON.stringify(stored(id));
    harness.failNextLookup = true;
    const out = await checkout(id);
    assert.equal(out.status, 502, JSON.stringify(out.body));
    assert.equal(out.body.error, "BILLING_PROVIDER_ERROR");
    assert.equal(JSON.stringify(stored(id)), before);
    assert.equal(harness.charges.length, 0);
  });

  test("'not found' for a reference Paystack generated (a pre-#181 row) still fails closed", async () => {
    // Paystack issued this reference itself, so "not found" is an anomaly,
    // not proof that nobody paid: keep refusing rather than cancel.
    await seedLegacyRequest("legacy-paystack-ref", {
      status: "approved",
      paystackReference: "T123456789012345",
    });
    const out = await cancel("legacy-paystack-ref");
    assert.equal(out.status, 502, JSON.stringify(out.body));
    assert.equal(stored("legacy-paystack-ref").status, "approved");
  });
});
