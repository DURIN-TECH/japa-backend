// ============================================
// Unit tests — Paystack receives the stored amount AND currency (issue #180)
// ============================================
//
// The provider's HTTP client is replaced by a recorder, so no request leaves
// the process and no secret key is needed. Shows:
//  - initializeCharge sends `amount = amountMinor` and `currency` exactly as
//    given (a second, non-naira currency, GHS, is passed through);
//  - it refuses a zero / non-integer amount before calling Paystack;
//  - the legacy initializeOneOffCharge (payment requests, until #181) still
//    sends NGN;
//  - getTransactionMetadata returns Paystack's charged amount, currency and
//    paid time, and leaves malformed values undefined (never a match).
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { PaystackProvider } from "../../src/services/billing/paystack.provider";

/* eslint-disable @typescript-eslint/no-explicit-any */

/** A provider whose HTTP client records calls and answers `reply`. */
function recordingProvider(reply: unknown = { data: { authorization_url: "https://pay/x", access_code: "a", reference: "r1" } }) {
  const calls: Array<{ method: string; url: string; payload?: any }> = [];
  const provider = new PaystackProvider();
  (provider as any).client = () => ({
    post: async (url: string, payload: unknown) => (calls.push({ method: "post", url, payload }), { data: reply }),
    get: async (url: string) => (calls.push({ method: "get", url }), { data: reply }),
  });
  return { provider, calls };
}

describe("initializeCharge", () => {
  test("passes a second currency (GHS) and the minor-unit amount through unchanged", async () => {
    const { provider, calls } = recordingProvider();
    const out = await provider.initializeCharge({
      email: "delivered+ghana@resend.dev",
      amount: { amountMinor: 15_000, currency: "GHS" },
      metadata: { purpose: "consultation", consultationId: "c1" },
      callbackUrl: "https://app.test/consultations/confirm",
    });
    assert.deepEqual(out, { authorizationUrl: "https://pay/x", reference: "r1" });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "/transaction/initialize");
    assert.equal(calls[0].payload.amount, 15_000);
    assert.equal(calls[0].payload.currency, "GHS");
    assert.equal(calls[0].payload.callback_url, "https://app.test/consultations/confirm");
    assert.deepEqual(calls[0].payload.metadata, { purpose: "consultation", consultationId: "c1" });
  });

  test("sends OUR reference when one is given (issue #180 review fix), and none otherwise", async () => {
    const { provider, calls } = recordingProvider({ data: { authorization_url: "https://pay/x", access_code: "a", reference: "cons-c1-abc" } });
    const out = await provider.initializeCharge({
      email: "delivered+x@resend.dev",
      amount: { amountMinor: 15_000, currency: "NGN" },
      reference: "cons-c1-abc",
    });
    assert.equal(calls[0].payload.reference, "cons-c1-abc");
    assert.equal(out.reference, "cons-c1-abc");
    await provider.initializeCharge({ email: "delivered+x@resend.dev", amount: { amountMinor: 15_000, currency: "NGN" } });
    assert.equal("reference" in calls[1].payload, false);
  });

  test("refuses a zero, negative or fractional amount without calling Paystack", async () => {
    const { provider, calls } = recordingProvider();
    for (const amountMinor of [0, -5, 10.5]) {
      await assert.rejects(
        provider.initializeCharge({ email: "delivered+x@resend.dev", amount: { amountMinor, currency: "NGN" } }),
        /PAYSTACK_ERROR/
      );
    }
    assert.equal(calls.length, 0);
  });

  test("the legacy naira one-off charge (payment requests) still sends NGN", async () => {
    const { provider, calls } = recordingProvider();
    await provider.initializeOneOffCharge({ email: "delivered+x@resend.dev", amountKobo: 500_000 });
    assert.equal(calls[0].payload.amount, 500_000);
    assert.equal(calls[0].payload.currency, "NGN");
  });
});

describe("getTransactionMetadata", () => {
  test("returns the charged amount, currency (upper case) and paid time", async () => {
    const { provider } = recordingProvider({
      data: { status: "success", metadata: { purpose: "consultation" }, amount: 15_000, currency: "ghs", paid_at: "2026-11-13T09:05:00Z" },
    });
    const r = await provider.getTransactionMetadata("r1");
    assert.deepEqual(r, {
      status: "success",
      metadata: { purpose: "consultation" },
      amount: 15_000,
      currency: "GHS",
      paidAt: "2026-11-13T09:05:00Z",
    });
  });

  test("returns requested_amount (what we asked, before fees passed to the customer) when Paystack reports it", async () => {
    const { provider } = recordingProvider({
      data: { status: "success", metadata: {}, amount: 15_225, requested_amount: 15_000, currency: "NGN" },
    });
    const r = await provider.getTransactionMetadata("r1");
    assert.equal(r?.amount, 15_225);
    assert.equal(r?.requestedAmount, 15_000);
  });

  test("a malformed requested_amount is left out (the check falls back to amount)", async () => {
    const { provider } = recordingProvider({ data: { status: "success", amount: 15_000, requested_amount: "15000", currency: "NGN" } });
    const r = await provider.getTransactionMetadata("r1");
    assert.equal(r?.requestedAmount, undefined);
    assert.equal("requestedAmount" in (r as object), false);
  });

  test("malformed amount / currency come back undefined", async () => {
    const { provider } = recordingProvider({ data: { status: "success", amount: "15000", currency: 566 } });
    const r = await provider.getTransactionMetadata("r1");
    assert.equal(r?.amount, undefined);
    assert.equal(r?.currency, undefined);
    assert.equal(r?.paidAt, undefined);
  });
});
