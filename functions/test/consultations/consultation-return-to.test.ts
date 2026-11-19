// ============================================
// Unit tests — consultation checkout returns to the app (issue #285)
// ============================================
//
// #252 gave subscription checkout and payment-request approve an optional
// `returnTo: "app"` so Paystack sends the payer to the API's app return page
// (which bounces into the mobile app) instead of a web page. #285 adds the
// same opt-in to the signed-in consultation routes:
//  - POST /consultations with `returnTo: "app"` → Paystack's `callbackUrl`
//    is the app return page, and it is stored on the booking
//    (`checkoutCallbackUrl`);
//  - no `returnTo` → today's web confirm page (`/consultations/confirm`);
//  - any other value → 400 VALIDATION_ERROR before anything is written;
//  - an app return URL that cannot be built (no project id) → 500 with
//    nothing booked;
//  - a re-priced checkout keeps the stored choice: POST /:id/checkout after
//    the quote lock, and the re-issue from POST /consultations/public/verify;
//  - POST /:id/checkout with `returnTo: "app"` sets the return URL of the new
//    checkout it issues (and stores it); inside the lock the SAME checkout
//    comes back and nothing new is opened; a bad value is 400, nothing done;
//  - guest (public) bookings keep their `/a/<slug>/confirm` page, whatever
//    the body says.
//
// Hermetic: in-memory Firestore, in-memory rates, Paystack stubbed
// (test/consultations/harness.ts). No network, no real charge.
import { test, describe, before, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { writes } from "../helpers/fake-firestore";
import {
  useHarness,
  harness,
  captureRes,
  docsIn,
  seed,
  setRate,
  paystackAbandoned,
  T0,
} from "./harness";
import { consultationController } from "../../src/controllers/consultation.controller";
import { EMAIL_BRANDING } from "../../src/services/email/branding";

/* eslint-disable @typescript-eslint/no-explicit-any */

// ============================================
// Environment (the app return URL is built from the project id)
// ============================================

/** The env vars the return URL is built from (restored after each test). */
const ENV_KEYS = ["GCLOUD_PROJECT", "GOOGLE_CLOUD_PROJECT", "API_PUBLIC_URL", "FUNCTIONS_EMULATOR"] as const;
let envSnapshot: Record<string, string | undefined> = {};

/** The app return page for the deployed `japa-platform` project. */
const APP_RETURN = "https://us-central1-japa-platform.cloudfunctions.net/api/payments/return";
/** Today's web return page for a signed-in payer (no `returnTo`). */
const WEB_RETURN = `${EMAIL_BRANDING.appUrl}/consultations/confirm`;

before(async () => {
  await useHarness();
});
beforeEach(() => {
  harness.reset();
  envSnapshot = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  delete process.env.API_PUBLIC_URL;
  delete process.env.FUNCTIONS_EMULATOR;
  delete process.env.GOOGLE_CLOUD_PROJECT;
  process.env.GCLOUD_PROJECT = "japa-platform";
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  console.log = () => {};
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  console.error = () => {};
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (envSnapshot[k] === undefined) delete process.env[k];
    else process.env[k] = envSnapshot[k];
  }
});

// ============================================
// Fixtures and calls
// ============================================

/** A verified, available agent charging $10.00. */
async function seedAgent(): Promise<void> {
  await seed("agents", "agent1", {
    userId: "uid-agent1", displayName: "Ada Agent", verificationStatus: "verified", isAvailable: true,
    consultationFeeUsd: { amountMinor: 1_000, currency: "USD" }, createdAt: T0,
  });
}

/** A client account. */
async function seedClient(): Promise<void> {
  await seed("users", "uid-client1", { email: "delivered+client1@resend.dev", firstName: "Chi", lastName: "Client", createdAt: T0 });
}

/** An approved agency with a $100.00 fee, for the guest flow. */
async function seedAgency(): Promise<void> {
  await seed("agencies", "ag1", {
    name: "Acme Visas", slug: "acme", status: "approved", ownerId: "owner-ag1", ownerName: "Ola Owner",
    services: [], consultationFeeUsd: { amountMinor: 10_000, currency: "USD" }, createdAt: T0,
  });
}

/** POST /consultations as the client, booking agent1, with extra body fields. */
async function book(extra: Record<string, unknown> = {}) {
  const { out, res } = captureRes();
  await consultationController.createConsultation(
    {
      userId: "uid-client1",
      body: { agentId: "agent1", type: "initial", scheduledDate: "2026-12-01", scheduledTime: "10:00", ...extra },
    } as any,
    res
  );
  return out;
}

/** POST /consultations/:id/checkout as the client, with an optional body. */
async function checkout(id: string, body?: unknown) {
  const { out, res } = captureRes();
  await consultationController.checkoutConsultation({ params: { id }, userId: "uid-client1", body } as any, res);
  return out;
}

/** POST /consultations/public/verify. */
async function verify(reference: string) {
  const { out, res } = captureRes();
  await consultationController.verifyPublicConsultation({ body: { reference } } as any, res);
  return out;
}

/** The one booking in the store. */
function onlyBooking(): Record<string, any> {
  const all = docsIn("consultations");
  assert.equal(all.length, 1, "exactly one booking");
  return all[0][1];
}

/** sendSuccess / sendCreated record 200/201 (or no status call at all). */
const ok = (s: number) => s === 0 || s === 200 || s === 201;

// ============================================
// POST /consultations
// ============================================

describe("POST /consultations returnTo", () => {
  beforeEach(async () => {
    await seedClient();
    await seedAgent();
  });

  test("returnTo: 'app' sends the app return page to Paystack and stores it on the booking", async () => {
    const out = await book({ returnTo: "app" });
    assert.ok(ok(out.status), JSON.stringify(out.body));
    assert.equal(harness.charges.length, 1);
    assert.equal(harness.charges[0].callbackUrl, APP_RETURN);
    assert.match(harness.charges[0].reference!, /^cons-/);
    assert.equal(onlyBooking().checkoutCallbackUrl, APP_RETURN);
  });

  test("no returnTo keeps today's web confirm page", async () => {
    const out = await book();
    assert.ok(ok(out.status), JSON.stringify(out.body));
    assert.equal(harness.charges[0].callbackUrl, WEB_RETURN);
    assert.equal(onlyBooking().checkoutCallbackUrl, WEB_RETURN);
  });

  test("returnTo: null counts as not given (web page)", async () => {
    const out = await book({ returnTo: null });
    assert.ok(ok(out.status), JSON.stringify(out.body));
    assert.equal(harness.charges[0].callbackUrl, WEB_RETURN);
  });

  test("any other value is 400 VALIDATION_ERROR with nothing written and nothing sent to Paystack", async () => {
    for (const bad of ["web", "APP", "", "durintech://x", 1, true, ["app"], { to: "app" }]) {
      writes.length = 0;
      const out = await book({ returnTo: bad });
      assert.equal(out.status, 400, JSON.stringify(bad));
      assert.equal(out.body.error, "VALIDATION_ERROR", JSON.stringify(bad));
      assert.deepEqual(writes, [], JSON.stringify(bad));
    }
    assert.equal(docsIn("consultations").length, 0);
    assert.equal(harness.charges.length, 0);
  });

  test("returnTo: 'app' with no project id → 500 and no booking is written", async () => {
    delete process.env.GCLOUD_PROJECT;
    delete process.env.GOOGLE_CLOUD_PROJECT;
    const out = await book({ returnTo: "app" });
    assert.equal(out.status, 500);
    assert.equal(docsIn("consultations").length, 0);
    assert.equal(harness.charges.length, 0);
  });
});

// ============================================
// Re-issued checkouts keep the stored choice
// ============================================

describe("a re-priced checkout keeps the stored return URL", () => {
  beforeEach(async () => {
    await seedClient();
    await seedAgent();
  });

  test("POST /:id/checkout after the lock (no returnTo) returns to the app again", async () => {
    const first = (await book({ returnTo: "app" })).body.data;
    paystackAbandoned(first.reference, first.id);
    harness.clock.advanceHours(1); // past the 30-minute lock
    setRate("NGN", 1600);
    const out = await checkout(first.id);
    assert.ok(ok(out.status), JSON.stringify(out.body));
    assert.equal(harness.charges.length, 2);
    assert.equal(harness.charges[1].callbackUrl, APP_RETURN);
    assert.equal(onlyBooking().checkoutCallbackUrl, APP_RETURN);
  });

  test("the re-issue from POST /consultations/public/verify returns to the app again", async () => {
    const first = (await book({ returnTo: "app" })).body.data;
    paystackAbandoned(first.reference, first.id);
    harness.clock.advanceHours(1);
    const out = await verify(first.reference);
    assert.equal(out.status, 409, JSON.stringify(out.body)); // QUOTE_EXPIRED with the fresh checkout
    assert.equal(out.body.error, "QUOTE_EXPIRED");
    assert.equal(harness.charges.length, 2);
    assert.equal(harness.charges[1].callbackUrl, APP_RETURN);
  });

  test("a web booking re-issued without returnTo keeps the web page", async () => {
    const first = (await book()).body.data;
    paystackAbandoned(first.reference, first.id);
    harness.clock.advanceHours(1);
    const out = await checkout(first.id, {});
    assert.ok(ok(out.status), JSON.stringify(out.body));
    assert.equal(harness.charges[1].callbackUrl, WEB_RETURN);
  });
});

// ============================================
// POST /consultations/:id/checkout returnTo
// ============================================

describe("POST /consultations/:id/checkout returnTo", () => {
  beforeEach(async () => {
    await seedClient();
    await seedAgent();
  });

  test("returnTo: 'app' on a new checkout sends (and stores) the app return page", async () => {
    const first = (await book()).body.data; // booked on the web
    paystackAbandoned(first.reference, first.id);
    harness.clock.advanceHours(1);
    const out = await checkout(first.id, { returnTo: "app" });
    assert.ok(ok(out.status), JSON.stringify(out.body));
    assert.equal(harness.charges.length, 2);
    assert.equal(harness.charges[1].callbackUrl, APP_RETURN);
    assert.equal(onlyBooking().checkoutCallbackUrl, APP_RETURN);
  });

  test("inside the lock the SAME checkout comes back and nothing new is opened", async () => {
    const first = (await book()).body.data;
    paystackAbandoned(first.reference, first.id);
    const out = await checkout(first.id, { returnTo: "app" });
    assert.ok(ok(out.status), JSON.stringify(out.body));
    assert.equal(out.body.data.reference, first.reference);
    assert.equal(harness.charges.length, 1);
  });

  test("a bad value is 400 VALIDATION_ERROR: nothing written, nothing re-priced, no Paystack call", async () => {
    const first = (await book()).body.data;
    paystackAbandoned(first.reference, first.id);
    harness.clock.advanceHours(1);
    for (const bad of ["web", 0, { a: 1 }]) {
      writes.length = 0;
      const out = await checkout(first.id, { returnTo: bad });
      assert.equal(out.status, 400, JSON.stringify(bad));
      assert.equal(out.body.error, "VALIDATION_ERROR");
      assert.deepEqual(writes, [], JSON.stringify(bad));
    }
    assert.equal(harness.charges.length, 1);
    assert.equal(onlyBooking().transactionId, first.reference);
  });
});

// ============================================
// Guest (public) bookings are unchanged
// ============================================

describe("guest bookings keep their public confirm page", () => {
  test("a guest booking ignores returnTo and returns to /a/<slug>/confirm", async () => {
    await seedAgency();
    const { out, res } = captureRes();
    await consultationController.createPublicConsultation(
      {
        params: { slug: "acme" },
        body: {
          clientName: "Gina Guest", clientEmail: "delivered+guest@resend.dev",
          scheduledDate: "2026-12-01", scheduledTime: "10:00", returnTo: "app",
        },
      } as any,
      res
    );
    assert.ok(ok(out.status), JSON.stringify(out.body));
    assert.equal(harness.charges.length, 1);
    assert.equal(harness.charges[0].callbackUrl, `${EMAIL_BRANDING.appUrl}/a/acme/confirm`);
  });
});
