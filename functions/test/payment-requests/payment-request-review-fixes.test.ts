// ============================================
// Unit tests — issue #181 code-review fix round 1
// ============================================
//
// Paystack is stubbed throughout (test/consultations/harness.ts): no real
// charge, no network. Covers the review's findings:
//  - BLOCKING: `PUT /:id/status` checks and writes in ONE transaction. A
//    settlement committing between the guard's read and the write wins (the
//    request stays paid, one Transaction). Only `pending|approved ->
//    cancelled` is allowed; every other target status is 400; a cancel while
//    Paystack reports the current checkout in flight is 409
//    PAYMENT_IN_PROGRESS;
//  - `GET /:id`: two independent agents (no agency) cannot read each
//    other's requests (the old `undefined === undefined` match);
//  - `DELETE /:id`: a paid request, or one with a checkout, is 409; only a
//    pending request with no checkout is deleted;
//  - create: the request's `agencyId` is the CASE's; an agent whose current
//    agency is not the case's is refused;
//  - the Paystack webhook signature compare (constant time) still refuses a
//    wrong signature.
import { test, describe, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as crypto from "crypto";

import {
  usePaymentRequestHarness,
  resetPaymentRequests,
  reqFor,
  agentA,
  colleagueA,
  agentB,
  independent,
  clientNg,
  APP_A,
  harness,
  seed,
  T0,
  paystackPaidRequest,
  paystackRequestStatus,
  seedLegacyRequest,
} from "./helpers";
import { captureRes, docsIn } from "../consultations/harness";
import { store } from "../helpers/fake-firestore";
import { paymentRequestController } from "../../src/controllers/payment-request.controller";
import { chargeRuntime } from "../../src/services/charge-checkout.service";
import { PaystackProvider } from "../../src/services/billing/paystack.provider";
import type { AuthzSubject } from "@durin-tech/authz";
import { ROLES } from "@durin-tech/authz";

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

/** $150.00 at NGN 1,500/$ = 22,500,000 kobo. */
const NGN_KOBO = 22_500_000;
const PRICE_CENTS = 15_000;

const stored = (id: string) => store.get(`paymentRequests/${id}`) as any;
const app = (id: string) => store.get(`applications/${id}`) as any;
const paymentTxns = () => docsIn("transactions").filter(([, t]) => t.paymentRequestId);

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

/** PUT /:id/approve as the Nigerian client; returns the checkout reference. */
async function approveRef(id: string): Promise<string> {
  const { out, res } = captureRes();
  await paymentRequestController.approvePaymentRequest(reqFor(clientNg, { params: { id } }), res);
  assert.equal(out.status, 200, JSON.stringify(out.body));
  return out.body.data.paystackReference;
}

/** POST /:id/verify as the Nigerian client. */
async function verify(id: string, reference: string) {
  const { out, res } = captureRes();
  await paymentRequestController.verifyPayment(reqFor(clientNg, { params: { id }, body: { reference } }), res);
  return out;
}

/** PUT /:id/status as `who` (default agent A, the creator). */
async function setStatus(id: string, status: unknown, who: AuthzSubject = agentA) {
  const { out, res } = captureRes();
  await paymentRequestController.updatePaymentRequestStatus(reqFor(who, { params: { id }, body: { status } }), res);
  return out;
}

/** GET /:id as `who`. */
async function getOne(id: string, who: AuthzSubject) {
  const { out, res } = captureRes();
  await paymentRequestController.getPaymentRequest(reqFor(who, { params: { id } }), res);
  return out;
}

/** DELETE /:id as `who` (default agent A). */
async function del(id: string, who: AuthzSubject = agentA) {
  const { out, res } = captureRes();
  await paymentRequestController.deletePaymentRequest(reqFor(who, { params: { id } }), res);
  return out;
}

// ============================================
// BLOCKING: PUT /:id/status, check and write in one transaction
// ============================================

describe("PUT /:id/status: a settlement racing an agent's cancel", () => {
  test("a settlement committing between the guard's read and the write wins: still paid, one Transaction", async () => {
    const id = await createRequest();
    const ref = await approveRef(id);
    // Paystack: the checkout was abandoned, so the in-flight check lets the
    // cancel through to its transaction...
    paystackRequestStatus(ref, id, "abandoned");
    // ...and right before that transaction runs, the client completes the
    // payment and verify settles it (an abandoned checkout can still be
    // paid). This is exactly the gap between the controller's read (status
    // `approved`) and the write.
    const original = chargeRuntime.runTransaction;
    let fired = false;
    chargeRuntime.runTransaction = (async (fn: any) => {
      if (!fired) {
        fired = true;
        chargeRuntime.runTransaction = original;
        paystackPaidRequest(ref, id, { amountMinor: NGN_KOBO, currency: "NGN" });
        const v = await verify(id, ref);
        assert.equal(v.status, 200, JSON.stringify(v.body));
      }
      return original(fn);
    }) as any;
    try {
      const out = await setStatus(id, "cancelled");
      assert.equal(out.status, 409, JSON.stringify(out.body));
      assert.equal(out.body.error, "REQUEST_ALREADY_PAID");
    } finally {
      chargeRuntime.runTransaction = original;
    }
    assert.equal(fired, true);
    assert.equal(stored(id).status, "paid");
    assert.equal(paymentTxns().length, 1);
    assert.equal(app(APP_A).amountPaid, PRICE_CENTS);
  });

  test("a payment completing while the cancel asks Paystack: settled, not cancelled, 409", async () => {
    const id = await createRequest();
    const ref = await approveRef(id);
    // While the cancel is looking the checkout up, the payment lands and a
    // verify settles it; the lookup itself still answered "abandoned".
    let fired = false;
    harness.onLookup = async (reference) => {
      if (fired) return undefined;
      fired = true;
      harness.onLookup = undefined;
      paystackPaidRequest(ref, id, { amountMinor: NGN_KOBO, currency: "NGN" });
      const v = await verify(id, ref);
      assert.equal(v.status, 200, JSON.stringify(v.body));
      return reference === ref ? { status: "abandoned", metadata: { purpose: "payment_request", paymentRequestId: id } } : undefined;
    };
    const out = await setStatus(id, "cancelled");
    assert.equal(fired, true);
    assert.equal(out.status, 409, JSON.stringify(out.body));
    assert.equal(stored(id).status, "paid");
    assert.equal(paymentTxns().length, 1);
  });

  test("Paystack reports the checkout paid at cancel time: settled here, never cancelled", async () => {
    const id = await createRequest();
    const ref = await approveRef(id);
    paystackPaidRequest(ref, id, { amountMinor: NGN_KOBO, currency: "NGN" });
    const out = await setStatus(id, "cancelled");
    assert.equal(out.status, 409);
    assert.equal(out.body.error, "REQUEST_ALREADY_PAID");
    assert.equal(stored(id).status, "paid");
    assert.equal(paymentTxns().length, 1);
  });

  for (const status of ["ongoing", "pending", "processing", "queued"]) {
    test(`cancel while Paystack reports "${status}": 409 PAYMENT_IN_PROGRESS, nothing changes`, async () => {
      const id = await createRequest();
      const ref = await approveRef(id);
      paystackRequestStatus(ref, id, status);
      const before = { ...stored(id) };
      const out = await setStatus(id, "cancelled");
      assert.equal(out.status, 409, JSON.stringify(out.body));
      assert.equal(out.body.error, "PAYMENT_IN_PROGRESS");
      assert.deepEqual(stored(id), before);
    });
  }

  test("a checkout replaced between the Paystack check and the write: 409 CHECKOUT_CHANGED, nothing written", async () => {
    const id = await createRequest();
    const ref = await approveRef(id);
    paystackRequestStatus(ref, id, "failed");
    harness.onLookup = async () => {
      harness.onLookup = undefined;
      // A re-issue swapped the reference in the meantime.
      store.set(`paymentRequests/${id}`, { ...stored(id), paystackReference: "preq-other" });
      return undefined;
    };
    const out = await setStatus(id, "cancelled");
    assert.equal(out.status, 409, JSON.stringify(out.body));
    assert.equal(out.body.error, "CHECKOUT_CHANGED");
    assert.equal(stored(id).status, "approved");
  });
});

describe("PUT /:id/status: only pending|approved -> cancelled", () => {
  test("pending -> cancelled is allowed", async () => {
    const id = await createRequest();
    const out = await setStatus(id, "cancelled");
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.equal(stored(id).status, "cancelled");
    assert.ok(stored(id).cancelledAt);
  });

  test("approved -> cancelled is allowed when the checkout is final unpaid (abandoned / failed)", async () => {
    for (const s of ["abandoned", "failed"]) {
      const id = await createRequest();
      const ref = await approveRef(id);
      paystackRequestStatus(ref, id, s);
      const out = await setStatus(id, "cancelled");
      assert.equal(out.status, 200, `${s}: ${JSON.stringify(out.body)}`);
      assert.equal(stored(id).status, "cancelled");
    }
  });

  test("a late payment on the cancelled checkout is held for refund, not settled", async () => {
    const id = await createRequest();
    const ref = await approveRef(id);
    paystackRequestStatus(ref, id, "abandoned");
    assert.equal((await setStatus(id, "cancelled")).status, 200);
    paystackPaidRequest(ref, id, { amountMinor: NGN_KOBO, currency: "NGN" });
    const v = await verify(id, ref);
    assert.equal(v.status, 409);
    assert.equal(stored(id).status, "cancelled");
    assert.equal(paymentTxns().length, 0);
    assert.ok(store.get(`paymentRequestExceptions/${ref}`));
  });

  // Every target status other than `cancelled` is a 400, from either
  // starting status, and changes nothing (this also stops an agent setting
  // `approved` without the client, or `pending` to re-open approval).
  for (const target of ["pending", "approved", "rejected", "paid", "expired", "bogus"]) {
    test(`target "${target}" is 400 from pending and from approved; nothing changes`, async () => {
      const pendingId = await createRequest();
      const a = await setStatus(pendingId, target);
      assert.equal(a.status, 400, JSON.stringify(a.body));
      assert.equal(stored(pendingId).status, "pending");

      const approvedId = await createRequest();
      const ref = await approveRef(approvedId);
      paystackRequestStatus(ref, approvedId, "abandoned");
      const before = { ...stored(approvedId) };
      const b = await setStatus(approvedId, target);
      assert.equal(b.status, 400, JSON.stringify(b.body));
      assert.deepEqual(stored(approvedId), before);
    });
  }

  test("a non-string status is 400", async () => {
    const id = await createRequest();
    assert.equal((await setStatus(id, { $ne: "x" })).status, 400);
    assert.equal(stored(id).status, "pending");
  });

  test("cancelling a cancelled, rejected or expired request is 409 and changes nothing", async () => {
    for (const s of ["cancelled", "rejected", "expired"]) {
      const id = await createRequest();
      store.set(`paymentRequests/${id}`, { ...stored(id), status: s });
      const out = await setStatus(id, "cancelled");
      assert.equal(out.status, 409, `${s}: ${JSON.stringify(out.body)}`);
      assert.equal(out.body.error, "INVALID_STATUS_TRANSITION");
      assert.equal(stored(id).status, s);
    }
  });

  test("only the creating agent may cancel (a colleague and another agency's agent get 403)", async () => {
    const id = await createRequest();
    assert.equal((await setStatus(id, "cancelled", colleagueA)).status, 403);
    assert.equal((await setStatus(id, "cancelled", agentB)).status, 403);
    assert.equal(stored(id).status, "pending");
  });
});

// ============================================
// GET /:id: independent agents
// ============================================

describe("GET /:id: no match on absent ids", () => {
  const otherIndependent: AuthzSubject = { uid: "uid-indie-2", role: ROLES.AGENT, agencyId: null };

  async function seedIndependentRequest(): Promise<string> {
    // An independent agent's request on their own case: no agency anywhere.
    await seed("applications", "app-indie", {
      userId: clientNg.uid, agentId: independent.uid, status: "in_progress", amountPaid: 0, totalCost: 0, createdAt: T0,
    });
    await seed("paymentRequests", "pr-indie", {
      applicationId: "app-indie", agentId: "prof-indie", clientId: clientNg.uid,
      clientName: "Ngozi Client", clientEmail: "delivered+client-ng@resend.dev",
      amount: 10_000, currency: "USD", priceUsd: { amountMinor: 10_000, currency: "USD" },
      description: "Visa Processing Fee", category: "other", status: "approved",
      checkoutUrl: "https://checkout.paystack.test/preq-x", paystackReference: "preq-x",
      createdAt: T0, updatedAt: T0,
    });
    await seed("agents", "prof-indie-2", { userId: otherIndependent.uid, displayName: "Ini Independent" });
    return "pr-indie";
  }

  test("another independent agent cannot read an independent agent's request", async () => {
    const id = await seedIndependentRequest();
    const out = await getOne(id, otherIndependent);
    assert.equal(out.status, 403, JSON.stringify(out.body));
    assert.equal(out.body.data, undefined);
  });

  test("the creating independent agent, the client and the case's assignee still can", async () => {
    const id = await seedIndependentRequest();
    assert.equal((await getOne(id, independent)).status, 200);
    assert.equal((await getOne(id, clientNg)).status, 200);
  });

  test("a case's current assignee can read it after reassignment; an agency member can read their agency's", async () => {
    const id = await createRequest();
    // Reassigned to agent A's colleague: the colleague now reads it as the assignee.
    store.set(`applications/${APP_A}`, { ...app(APP_A), agentId: colleagueA.uid });
    assert.equal((await getOne(id, colleagueA)).status, 200);
    // Agency B's agent never does.
    assert.equal((await getOne(id, agentB)).status, 403);
  });
});

// ============================================
// DELETE /:id
// ============================================

describe("DELETE /:id: only a pending request with no checkout", () => {
  test("a pending request with no checkout is deleted", async () => {
    const id = await createRequest();
    const out = await del(id);
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.equal(stored(id), undefined);
  });

  test("an approved request with an open checkout is 409 CHECKOUT_OPEN and stays", async () => {
    const id = await createRequest();
    const ref = await approveRef(id);
    paystackRequestStatus(ref, id, "ongoing");
    const out = await del(id);
    assert.equal(out.status, 409, JSON.stringify(out.body));
    assert.equal(out.body.error, "CHECKOUT_OPEN");
    assert.ok(stored(id));
  });

  test("a paid request is 409 REQUEST_ALREADY_PAID and stays", async () => {
    const id = await createRequest();
    const ref = await approveRef(id);
    paystackPaidRequest(ref, id, { amountMinor: NGN_KOBO, currency: "NGN" });
    await verify(id, ref);
    const out = await del(id);
    assert.equal(out.status, 409);
    assert.equal(out.body.error, "REQUEST_ALREADY_PAID");
    assert.equal(stored(id).status, "paid");
  });

  test("a cancelled request that had a checkout is 409 (a late payment must still find it)", async () => {
    const id = await createRequest();
    const ref = await approveRef(id);
    paystackRequestStatus(ref, id, "abandoned");
    assert.equal((await setStatus(id, "cancelled")).status, 200);
    const out = await del(id);
    assert.equal(out.status, 409);
    assert.equal(out.body.error, "CHECKOUT_OPEN");
    assert.ok(stored(id));
  });

  test("a pending legacy request that carries a Paystack reference is 409 too", async () => {
    await seedLegacyRequest("legacy-ref", { paystackReference: "T123456" });
    const out = await del("legacy-ref");
    assert.equal(out.status, 409);
    assert.ok(stored("legacy-ref"));
  });

  test("a cancelled request with no checkout is 409 REQUEST_NOT_DELETABLE (pending only, as before)", async () => {
    const id = await createRequest();
    assert.equal((await setStatus(id, "cancelled")).status, 200);
    const out = await del(id);
    assert.equal(out.status, 409);
    assert.equal(out.body.error, "REQUEST_NOT_DELETABLE");
  });

  test("only the creating agent may delete", async () => {
    const id = await createRequest();
    assert.equal((await del(id, colleagueA)).status, 403);
    assert.ok(stored(id));
  });
});

// ============================================
// Create: billed under the CASE's agency
// ============================================

describe("POST /payment-requests: the agency comes from the case", () => {
  async function create(who: AuthzSubject) {
    const { out, res } = captureRes();
    await paymentRequestController.createPaymentRequest(
      reqFor(who, { body: { applicationId: APP_A, amount: "150.00", description: "Visa Processing Fee" } }),
      res
    );
    return out;
  }

  test("the stored agencyId is the case's, even when the agent profile says otherwise", async () => {
    // A stale profile (agency field not yet updated) must not decide whose request this is.
    store.set("agents/prof-agent-a", { ...(store.get("agents/prof-agent-a") as any), agencyId: "agency-b" });
    const out = await create(agentA);
    assert.equal(out.status, 201, JSON.stringify(out.body));
    assert.equal(stored(out.body.data.id).agencyId, "agency-a");
  });

  test("an assigned agent who has moved to another agency is refused (403), nothing written", async () => {
    // Agent A now belongs to agency B (the verified agency the middleware
    // checked) but is still the assignee of agency A's case.
    const moved: AuthzSubject = { ...agentA, agencyId: "agency-b" };
    store.set("agents/prof-agent-a", { ...(store.get("agents/prof-agent-a") as any), agencyId: "agency-b" });
    const out = await create(moved);
    assert.equal(out.status, 403, JSON.stringify(out.body));
    assert.equal(docsIn("paymentRequests").length, 0);
  });
});

// ============================================
// Webhook signature: constant-time compare
// ============================================

describe("Paystack webhook signature", () => {
  const KEY = "test-only-not-a-real-key";
  const body = JSON.stringify({ event: "charge.success", data: { reference: "preq-x" } });
  const sign = (raw: string, key = KEY) => crypto.createHmac("sha512", key).update(raw).digest("hex");

  test("the right signature is accepted; a wrong one of the same length, a short one, a missing one are refused", () => {
    process.env.PAYSTACK_SECRET_KEY = KEY;
    const provider = new PaystackProvider();
    const good = sign(body);
    assert.equal(provider.verifyWebhookSignature({ "x-paystack-signature": good }, body), true);
    // Same length, different key.
    const wrong = sign(body, "another-key");
    assert.equal(wrong.length, good.length);
    assert.equal(provider.verifyWebhookSignature({ "x-paystack-signature": wrong }, body), false);
    // One character off.
    const flipped = (good[0] === "a" ? "b" : "a") + good.slice(1);
    assert.equal(provider.verifyWebhookSignature({ "x-paystack-signature": flipped }, body), false);
    // Wrong length (must not throw from timingSafeEqual).
    assert.equal(provider.verifyWebhookSignature({ "x-paystack-signature": good.slice(0, 10) }, body), false);
    assert.equal(provider.verifyWebhookSignature({ "x-paystack-signature": good + "00" }, body), false);
    // Missing, and a tampered body with the old signature.
    assert.equal(provider.verifyWebhookSignature({}, body), false);
    assert.equal(provider.verifyWebhookSignature({ "x-paystack-signature": good }, body + " "), false);
  });
});
