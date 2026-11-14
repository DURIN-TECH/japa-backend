// ============================================
// Unit tests — issue #181 code-review fix round 3, consultation side
// ============================================
//
// Consultations (#180) share the claim -> open -> publish machinery with
// payment requests, so they share the round-2 blocker too: a booking whose
// checkout was claimed (our `cons-<id>-<uuid>` reference stored as
// `transactionId`) but never opened at Paystack (initialize threw). Real
// Paystack answers a lookup of that reference with HTTP 400 "Transaction
// reference not found"; the retry (POST /consultations/:id/checkout) must
// treat it as final unpaid and open a fresh checkout, while a genuine
// Paystack outage on the lookup must still be 502 with nothing changed.
//
// Paystack is stubbed (./harness.ts) with `realisticNotFound` on: a
// reference it never saw throws the provider's PaystackApiError, exactly as
// the real client does. No network.
import { test, describe, before, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { useHarness, harness, captureRes, docsIn, seed, T0 } from "./harness";
import { consultationController } from "../../src/controllers/consultation.controller";

/* eslint-disable @typescript-eslint/no-explicit-any */

before(async () => {
  await useHarness();
});
beforeEach(() => {
  harness.reset();
  harness.realisticNotFound = true;
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  console.log = () => {};
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  console.error = () => {};
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  console.warn = () => {};
});

// ============================================
// Fixtures and calls (as in consultation-charge.test.ts)
// ============================================

/** A verified, available agent charging $10.00. */
async function seedAgent() {
  await seed("agents", "agent1", {
    userId: "uid-agent1", displayName: "Ada Agent", verificationStatus: "verified", isAvailable: true,
    consultationFeeUsd: { amountMinor: 1_000, currency: "USD" }, createdAt: T0,
  });
}

/** A client account. */
async function seedClient() {
  await seed("users", "uid-client1", {
    email: "delivered+client1@resend.dev", firstName: "Chi", lastName: "Client", createdAt: T0,
  });
}

/** POST /consultations as the client, booking agent1. */
async function book() {
  const { out, res } = captureRes();
  await consultationController.createConsultation(
    {
      userId: "uid-client1",
      body: { type: "initial", scheduledDate: "2026-12-01", scheduledTime: "10:00", agentId: "agent1" },
    } as any,
    res
  );
  return out;
}

/** POST /consultations/:id/checkout as the client. */
async function retry(id: string) {
  const { out, res } = captureRes();
  await consultationController.checkoutConsultation({ params: { id }, userId: "uid-client1" } as any, res);
  return out;
}

/** The one consultation in the store, with its id. */
function onlyBooking(): Record<string, any> {
  const all = docsIn("consultations");
  assert.equal(all.length, 1, "exactly one booking");
  return { ...all[0][1], id: all[0][0] };
}

/** sendSuccess/sendCreated may not call status() for a 2xx. */
const okStatus = (s: number) => s === 0 || s === 200 || s === 201;

/** Book with Paystack's initialize failing after the claim; returns the booking. */
async function bookWithFailedOpen(): Promise<Record<string, any>> {
  await seedClient();
  await seedAgent();
  harness.failNextCharge = true;
  const first = await book();
  assert.equal(first.status, 502, JSON.stringify(first.body));
  const b = onlyBooking();
  assert.match(b.transactionId, /^cons-/);
  assert.equal(b.checkoutUrl, null);
  assert.equal(harness.charges.length, 0);
  return b;
}

// ============================================
// Tests
// ============================================

describe("consultation retry after a checkout Paystack never opened", () => {
  test("Paystack's 'reference not found' is final unpaid: a fresh checkout opens", async () => {
    const b = await bookWithFailedOpen();
    const out = await retry(b.id);
    assert.ok(okStatus(out.status), JSON.stringify(out.body));
    assert.ok(out.body.data.authorizationUrl);
    const after = onlyBooking();
    assert.notEqual(after.transactionId, b.transactionId);
    assert.equal(after.transactionId, out.body.data.reference);
    assert.equal(after.checkoutUrl, out.body.data.authorizationUrl);
    assert.equal(harness.charges.length, 1);
    // The unopened reference is kept, like any replaced checkout.
    assert.ok((after.supersededCheckouts ?? []).some((s: any) => s.reference === b.transactionId));
  });

  test("a genuine Paystack outage on the lookup is 502 and changes nothing", async () => {
    const b = await bookWithFailedOpen();
    const before = JSON.stringify(onlyBooking());
    harness.failNextLookup = true;
    const out = await retry(b.id);
    assert.equal(out.status, 502, JSON.stringify(out.body));
    assert.equal(out.body.error, "BILLING_PROVIDER_ERROR");
    assert.equal(JSON.stringify(onlyBooking()), before);
    assert.equal(harness.charges.length, 0);
  });
});
