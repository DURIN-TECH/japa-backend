// ============================================
// Unit tests — payment-request approve `returnTo: "app"` (issue #252) on the
// dollar charge path (issue #181)
// ============================================
//
// #252 added an optional `returnTo: "app"` to PUT /payment-requests/:id/approve
// so Paystack sends the payer to the app return page instead of the portal.
// #181 replaced the old naira-only one-off init with the shared charge path
// (our own `preq-` references, `initializeCharge({ amount: Money, reference })`).
// These tests pin that #252's behaviour survives on that path:
//  - `returnTo: "app"` → the app return page is Paystack's `callbackUrl`, for
//    a dollar request AND a legacy naira request;
//  - no `returnTo` → the portal `/client/payments` callback, as before;
//  - the choice is stored on the request (`checkoutCallbackUrl`), so a
//    re-issued checkout (POST /:id/checkout after the lock) returns to the
//    same place;
//  - a bad value (400) or an unbuildable return URL (500) is refused BEFORE
//    the request is approved: still pending, nothing sent to Paystack.
//
// Paystack is stubbed (test/consultations/harness.ts): no network.
import { test, describe, before, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

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
import { captureRes, setRate } from "../consultations/harness";
import { store } from "../helpers/fake-firestore";
import { paymentRequestController } from "../../src/controllers/payment-request.controller";
import { EMAIL_BRANDING } from "../../src/services/email/branding";

/* eslint-disable @typescript-eslint/no-explicit-any */

/** The env vars the return URL is built from (restored after each test). */
const ENV_KEYS = ["GCLOUD_PROJECT", "GOOGLE_CLOUD_PROJECT", "API_PUBLIC_URL", "FUNCTIONS_EMULATOR"] as const;
let envSnapshot: Record<string, string | undefined> = {};

/** The app return page for the deployed `japa-platform` project. */
const APP_RETURN = "https://us-central1-japa-platform.cloudfunctions.net/api/payments/return";
/** The portal callback used without `returnTo`. */
const PORTAL_RETURN = `${EMAIL_BRANDING.appUrl}/client/payments?reference={reference}`;

before(async () => {
  await usePaymentRequestHarness();
});
beforeEach(async () => {
  await resetPaymentRequests();
  envSnapshot = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  delete process.env.API_PUBLIC_URL;
  delete process.env.FUNCTIONS_EMULATOR;
  delete process.env.GOOGLE_CLOUD_PROJECT;
  process.env.GCLOUD_PROJECT = "japa-platform";
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  console.log = () => {};
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  console.error = () => {};
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  console.warn = () => {};
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (envSnapshot[k] === undefined) delete process.env[k];
    else process.env[k] = envSnapshot[k];
  }
});

// ============================================
// Calls
// ============================================

/** The stored request doc. */
const stored = (id: string) => store.get(`paymentRequests/${id}`) as any;

/** Create a $150 request on agency A's Nigerian case; returns its id. */
async function createRequest(): Promise<string> {
  const { out, res } = captureRes();
  await paymentRequestController.createPaymentRequest(
    reqFor(agentA, { body: { applicationId: APP_A, amount: "150.00", description: "Visa Processing Fee" } }),
    res
  );
  assert.equal(out.status, 201, JSON.stringify(out.body));
  return out.body.data.id;
}

/** PUT /:id/approve as the Nigerian client with `body`. */
async function approve(id: string, body: unknown) {
  const { out, res } = captureRes();
  await paymentRequestController.approvePaymentRequest(reqFor(clientNg, { params: { id }, body }), res);
  return out;
}

/** POST /:id/checkout as the Nigerian client. */
async function checkout(id: string) {
  const { out, res } = captureRes();
  await paymentRequestController.checkoutPaymentRequest(reqFor(clientNg, { params: { id } }), res);
  return out;
}

// ============================================
// Dollar request (#181 charge path)
// ============================================

describe("approve returnTo on a dollar request", () => {
  test("returnTo: 'app' sends the app return page as Paystack's callback, under our reference", async () => {
    const id = await createRequest();
    const out = await approve(id, { returnTo: "app" });
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.equal(harness.charges.length, 1);
    assert.equal(harness.charges[0].callbackUrl, APP_RETURN);
    assert.match(harness.charges[0].reference!, /^preq-/);
    assert.equal(stored(id).checkoutCallbackUrl, APP_RETURN);
  });

  test("no returnTo (and no body) keeps the portal /client/payments callback", async () => {
    const id = await createRequest();
    const out = await approve(id, undefined);
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.equal(harness.charges[0].callbackUrl, PORTAL_RETURN);
    assert.equal(stored(id).checkoutCallbackUrl, PORTAL_RETURN);
  });

  test("a re-issued checkout after the lock returns to the app too", async () => {
    const id = await createRequest();
    const first = (await approve(id, { returnTo: "app" })).body.data;
    paystackRequestStatus(first.paystackReference, id, "abandoned");
    harness.clock.advanceHours(1);
    setRate("NGN", 1600);
    const out = await checkout(id);
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.equal(harness.charges.length, 2);
    assert.equal(harness.charges[1].callbackUrl, APP_RETURN);
  });

  test("returnTo: 'app' with no project id → 500 BEFORE the request is approved", async () => {
    const id = await createRequest();
    delete process.env.GCLOUD_PROJECT;
    delete process.env.GOOGLE_CLOUD_PROJECT;
    const out = await approve(id, { returnTo: "app" });
    assert.equal(out.status, 500);
    assert.equal(stored(id).status, "pending");
    assert.equal(harness.charges.length, 0);
  });

  test("an unknown returnTo is refused (400) BEFORE the request is approved", async () => {
    const id = await createRequest();
    const out = await approve(id, { returnTo: "web" });
    assert.equal(out.status, 400);
    assert.equal(stored(id).status, "pending");
    assert.equal(harness.charges.length, 0);
  });
});

// ============================================
// Legacy naira request (charged its own stored kobo amount)
// ============================================

describe("approve returnTo on a legacy naira request", () => {
  test("returnTo: 'app' sends the app return page; the kobo amount is unchanged", async () => {
    await seedLegacyRequest("legacy-app");
    const out = await approve("legacy-app", { returnTo: "app" });
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.equal(harness.charges.length, 1);
    assert.equal(harness.charges[0].callbackUrl, APP_RETURN);
    assert.deepEqual(harness.charges[0].amount, { amountMinor: 2_500_000, currency: "NGN" });
    assert.equal(stored("legacy-app").checkoutCallbackUrl, APP_RETURN);
  });

  test("no returnTo keeps the portal callback", async () => {
    await seedLegacyRequest("legacy-portal");
    const out = await approve("legacy-portal", {});
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.equal(harness.charges[0].callbackUrl, PORTAL_RETURN);
  });
});
