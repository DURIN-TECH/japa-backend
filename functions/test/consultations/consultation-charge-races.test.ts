// ============================================
// Unit tests — consultation charging review fixes (issue #180, fix round 1)
// ============================================
//
// Hermetic, same harness as consultation-charge.test.ts: in-memory Firestore
// (transactions run one at a time, like Firestore's serializable ones), an
// in-memory rate service, Paystack stubbed. No real charge, no network.
//
// What is covered, by review finding:
//  - BLOCKING 1, re-pricing races: the re-price is decided inside a Firestore
//    transaction under a reference we generate.
//     * a verify confirming the booking while a retry re-prices: no new
//       checkout on the paid booking, no `requiresPayment: true`;
//     * the same while a verify re-prices;
//     * two concurrent re-prices (retry + retry, verify + verify, verify +
//       retry): exactly ONE new checkout survives and both callers get it;
//  - BLOCKING 2, in-flight payments: no re-price while Paystack reports the
//    current reference as non-final (`ongoing`, `pending`, `processing`,
//    `queued`, an unknown status): 409 PAYMENT_IN_PROGRESS with the current
//    checkout, on verify and on the retry route; the transfer then completes
//    on that reference and settles the booking. `failed` does re-price;
//  - superseded references keep their snapshot: an exact payment on one
//    after the booking was paid is recorded in consultationPaymentExceptions
//    for refund (error log, no second Transaction, idempotent); a short
//    payment on one is a mismatch; an abandoned one points at the current
//    checkout (409 CHECKOUT_REPLACED); a payment on a cancelled booking is
//    recorded too;
//  - exact match against what we ASKED: `requested_amount` when Paystack
//    reports it (fees passed to the customer inflate `amount`), else `amount`;
//  - a Paystack failure inside a verify re-price is 502 BILLING_PROVIDER_ERROR
//    (not 500), and the guest can recover by verifying again.
import { test, describe, before, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  useHarness,
  harness,
  captureRes,
  docsIn,
  seed,
  setRate,
  paystackPaid,
  paystackAbandoned,
  paystackStatus,
  T0,
  NGN_RATE,
} from "./harness";
import { consultationController } from "../../src/controllers/consultation.controller";
import { paystackState } from "../../src/services/consultation-charge.service";

/* eslint-disable @typescript-eslint/no-explicit-any */

before(async () => {
  await useHarness();
});
beforeEach(() => {
  harness.reset();
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  console.log = () => {};
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  console.error = () => {};
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  console.warn = () => {};
});

// ============================================
// Fixtures (as in consultation-charge.test.ts)
// ============================================

/** $100.00 at ₦1,500/$ = 15,000,000 kobo (guest, agency fee). */
const AGENCY_FEE_KOBO = 15_000_000;
/** $10.00 at ₦1,500/$ = 1,500,000 kobo (signed-in, agent fee). */
const AGENT_FEE_KOBO = 1_500_000;

/** A guest booking on an approved agency with a $100 fee: its id and first reference. */
async function bookGuest(): Promise<{ id: string; reference: string; url: string }> {
  await seed("agencies", "ag1", {
    name: "Acme Visas", slug: "acme", status: "approved", ownerId: "owner-ag1", ownerName: "Ola Owner",
    services: [], consultationFeeUsd: { amountMinor: 10_000, currency: "USD" }, createdAt: T0,
  });
  const { out, res } = captureRes();
  await consultationController.createPublicConsultation(
    {
      params: { slug: "acme" },
      body: {
        clientName: "Gina Guest", clientEmail: "delivered+guest@resend.dev",
        scheduledDate: "2026-12-01", scheduledTime: "10:00",
      },
    } as any,
    res
  );
  assert.equal(out.status, 201, JSON.stringify(out.body));
  return { id: out.body.data.consultationId, reference: out.body.data.reference, url: out.body.data.authorizationUrl };
}

/** A signed-in client's booking of a verified agent with a $10 fee. */
async function bookSignedIn(): Promise<{ id: string; reference: string; url: string }> {
  await seed("users", "uid-client1", { email: "delivered+client1@resend.dev", firstName: "Chi", lastName: "Client", createdAt: T0 });
  await seed("agents", "agent1", {
    userId: "uid-agent1", displayName: "Ada Agent", verificationStatus: "verified", isAvailable: true,
    consultationFeeUsd: { amountMinor: 1_000, currency: "USD" }, createdAt: T0,
  });
  const { out, res } = captureRes();
  await consultationController.createConsultation(
    { userId: "uid-client1", body: { type: "initial", scheduledDate: "2026-12-01", scheduledTime: "10:00", agentId: "agent1" } } as any,
    res
  );
  assert.equal(out.status, 201, JSON.stringify(out.body));
  return { id: out.body.data.id, reference: out.body.data.reference, url: out.body.data.authorizationUrl };
}

/** POST /consultations/public/verify. */
async function verify(reference: string) {
  const { out, res } = captureRes();
  await consultationController.verifyPublicConsultation({ body: { reference } } as any, res);
  return out;
}

/** POST /consultations/:id/checkout as the booking's client. */
async function retry(id: string, uid = "uid-client1") {
  const { out, res } = captureRes();
  await consultationController.checkoutConsultation({ params: { id }, userId: uid } as any, res);
  return out;
}

/** The one consultation in the store. */
function onlyBooking(): Record<string, any> {
  const all = docsIn("consultations");
  assert.equal(all.length, 1, "exactly one booking");
  return all[0][1];
}

/** sendSuccess writes `{ success, data }` without calling status() for 200. */
const okStatus = (s: number) => s === 0 || s === 200 || s === 201;

/** Move past the 30-minute quote lock. */
const pastTheLock = () => harness.clock.advanceHours(1);

/**
 * Run `during` once, the first time Paystack is asked about `reference`,
 * AFTER the caller's answer was taken: the caller acts on a view that
 * `during` then makes stale (the race window).
 */
function onFirstLookup(reference: string, during: () => Promise<unknown>): void {
  harness.onLookup = async (ref) => {
    if (ref !== reference) return undefined;
    harness.onLookup = undefined; // once; `during` may look up too
    await during();
    return undefined;
  };
}

// ============================================
// BLOCKING 1: re-pricing races
// ============================================

describe("re-pricing races (review blocking 1)", () => {
  test("a verify confirms the booking while a retry re-prices: no new checkout, no requiresPayment: true", async () => {
    const { id, reference } = await bookSignedIn();
    pastTheLock();
    // The retry's lookup sees the checkout abandoned; meanwhile the payer
    // completes it and the return leg's verify confirms the booking.
    paystackAbandoned(reference, id);
    let confirmed: any;
    onFirstLookup(reference, async () => {
      paystackPaid(reference, id, { amountMinor: AGENT_FEE_KOBO, currency: "NGN" });
      confirmed = await verify(reference);
    });
    const out = await retry(id);
    assert.ok(okStatus(confirmed.status), JSON.stringify(confirmed.body));
    assert.equal(confirmed.body.data.verified, true);

    assert.ok(okStatus(out.status), JSON.stringify(out.body));
    assert.equal(out.body.data.requiresPayment, false);
    assert.equal(out.body.data.authorizationUrl, undefined);
    assert.equal(harness.charges.length, 1, "no second checkout opened");
    const b = onlyBooking();
    assert.equal(b.paymentStatus, "paid");
    assert.equal(b.transactionId, reference, "still the reference that paid it");
    assert.equal(b.chargedAmountMinor, AGENT_FEE_KOBO, "snapshot matches the Transaction");
    assert.equal(b.supersededCheckouts, undefined);
    assert.equal(docsIn("transactions").length, 1);
  });

  test("a verify confirms the booking while another verify re-prices: the re-pricer answers verified", async () => {
    const { id, reference } = await bookGuest();
    pastTheLock();
    paystackAbandoned(reference, id, { agencySlug: "acme" });
    onFirstLookup(reference, async () => {
      paystackPaid(reference, id, { amountMinor: AGENCY_FEE_KOBO, currency: "NGN" });
      await verify(reference);
    });
    const out = await verify(reference);
    assert.ok(okStatus(out.status), JSON.stringify(out.body));
    assert.equal(out.body.data.verified, true);
    assert.equal(harness.charges.length, 1);
    assert.equal(onlyBooking().paymentStatus, "paid");
    assert.equal(docsIn("transactions").length, 1);
  });

  test("two concurrent retries after the lock: exactly one new checkout, both callers get it", async () => {
    const { id, reference } = await bookSignedIn();
    pastTheLock();
    setRate("NGN", 1550);
    paystackAbandoned(reference, id);
    const [a, b] = await Promise.all([retry(id), retry(id)]);
    for (const out of [a, b]) {
      assert.ok(okStatus(out.status), JSON.stringify(out.body));
      assert.equal(out.body.data.requiresPayment, true);
    }
    assert.equal(a.body.data.reference, b.body.data.reference);
    assert.equal(a.body.data.authorizationUrl, b.body.data.authorizationUrl);
    assert.notEqual(a.body.data.reference, reference);
    assert.equal(harness.charges.length, 2, "the first checkout plus ONE re-price");
    assert.deepEqual(harness.charges[1].amount, { amountMinor: 1_550_000, currency: "NGN" });
    const booking = onlyBooking();
    assert.equal(booking.transactionId, a.body.data.reference, "the surviving checkout is the stored one");
    assert.equal(booking.checkoutUrl, a.body.data.authorizationUrl);
    assert.equal(booking.supersededCheckouts.length, 1);
    assert.equal(booking.supersededCheckouts[0].reference, reference);
  });

  test("two concurrent verifies after the lock: both 409 QUOTE_EXPIRED with the SAME new checkout", async () => {
    const { id, reference } = await bookGuest();
    pastTheLock();
    paystackAbandoned(reference, id, { agencySlug: "acme" });
    const [a, b] = await Promise.all([verify(reference), verify(reference)]);
    for (const out of [a, b]) {
      assert.equal(out.status, 409, JSON.stringify(out.body));
      assert.equal(out.body.error, "QUOTE_EXPIRED");
    }
    assert.equal(a.body.data.reference, b.body.data.reference);
    assert.equal(a.body.data.authorizationUrl, b.body.data.authorizationUrl);
    assert.equal(harness.charges.length, 2);
    assert.equal(onlyBooking().transactionId, a.body.data.reference);
  });

  test("a verify and a retry re-pricing at once: one new checkout, both get it", async () => {
    const { id, reference } = await bookSignedIn();
    pastTheLock();
    paystackAbandoned(reference, id);
    const [v, r] = await Promise.all([verify(reference), retry(id)]);
    assert.equal(v.status, 409, JSON.stringify(v.body));
    assert.ok(okStatus(r.status), JSON.stringify(r.body));
    assert.equal(v.body.data.reference, r.body.data.reference);
    assert.equal(v.body.data.authorizationUrl, r.body.data.authorizationUrl);
    assert.equal(harness.charges.length, 2);
    assert.equal(onlyBooking().transactionId, r.body.data.reference);
  });

  test("the reference sent to Paystack is ours, stored on the booking before the checkout opens", async () => {
    const { id, reference } = await bookGuest();
    assert.match(reference, /^cons-[A-Za-z0-9]+-[0-9a-f-]{36}$/);
    assert.equal(harness.charges[0].reference, reference);
    assert.equal(onlyBooking().transactionId, reference);
    assert.equal(harness.charges[0].metadata?.consultationId, id);
  });
});

// ============================================
// BLOCKING 2: payments in flight
// ============================================

describe("no re-price while a payment is in flight (review blocking 2)", () => {
  const IN_FLIGHT = ["ongoing", "pending", "processing", "queued", "some_new_status"];

  test("paystackState: only failed / abandoned are replaceable; everything else but success is in progress", () => {
    assert.equal(paystackState({ status: "success", metadata: {} }), "paid");
    assert.equal(paystackState({ status: "failed", metadata: {} }), "final_unpaid");
    assert.equal(paystackState({ status: "abandoned", metadata: {} }), "final_unpaid");
    for (const status of [...IN_FLIGHT, "reversed"]) {
      assert.equal(paystackState({ status, metadata: {} }), "in_progress", status);
    }
  });

  for (const status of IN_FLIGHT) {
    test(`verify after the lock, Paystack "${status}": 409 PAYMENT_IN_PROGRESS, current checkout kept`, async () => {
      const { id, reference, url } = await bookGuest();
      const before = onlyBooking();
      pastTheLock();
      setRate("NGN", 1600);
      paystackStatus(reference, id, status);
      const out = await verify(reference);
      assert.equal(out.status, 409, JSON.stringify(out.body));
      assert.equal(out.body.error, "PAYMENT_IN_PROGRESS");
      assert.equal(out.body.data.reference, reference);
      assert.equal(out.body.data.authorizationUrl, url);
      assert.equal(harness.charges.length, 1, "no new checkout");
      const b = onlyBooking();
      assert.equal(b.transactionId, reference);
      assert.equal(b.chargedAmountMinor, before.chargedAmountMinor, "not re-priced");
      assert.equal(b.supersededCheckouts, undefined);
    });

    test(`retry after the lock, Paystack "${status}": 409 PAYMENT_IN_PROGRESS, current checkout kept`, async () => {
      const { id, reference, url } = await bookSignedIn();
      pastTheLock();
      paystackStatus(reference, id, status);
      const out = await retry(id);
      assert.equal(out.status, 409, JSON.stringify(out.body));
      assert.equal(out.body.error, "PAYMENT_IN_PROGRESS");
      assert.equal(out.body.data.reference, reference);
      assert.equal(out.body.data.authorizationUrl, url);
      assert.equal(harness.charges.length, 1);
      assert.equal(onlyBooking().transactionId, reference);
    });
  }

  test("retry INSIDE the lock while a payment is in flight is also 409 (never a second payment on top)", async () => {
    const { id, reference } = await bookSignedIn();
    paystackStatus(reference, id, "ongoing");
    const out = await retry(id);
    assert.equal(out.status, 409);
    assert.equal(out.body.error, "PAYMENT_IN_PROGRESS");
    assert.equal(harness.charges.length, 1);
  });

  test("the reviewer's scenario: a bank transfer started at minute 28 completes after the lock and settles the booking", async () => {
    const { id, reference } = await bookGuest();
    pastTheLock();
    paystackStatus(reference, id, "ongoing");
    assert.equal((await verify(reference)).body.error, "PAYMENT_IN_PROGRESS");
    // The transfer lands on the SAME reference for the exact amount.
    paystackPaid(reference, id, { amountMinor: AGENCY_FEE_KOBO, currency: "NGN" });
    const out = await verify(reference);
    assert.ok(okStatus(out.status), JSON.stringify(out.body));
    const b = onlyBooking();
    assert.equal(b.paymentStatus, "paid");
    assert.equal(b.paidAfterQuoteExpiry, true);
    assert.equal(docsIn("transactions").length, 1);
    assert.equal(harness.charges.length, 1);
  });

  test("a FAILED checkout after the lock is re-priced (failed is final)", async () => {
    const { id, reference } = await bookGuest();
    pastTheLock();
    paystackStatus(reference, id, "failed");
    const out = await verify(reference);
    assert.equal(out.status, 409);
    assert.equal(out.body.error, "QUOTE_EXPIRED");
    assert.equal(harness.charges.length, 2);
  });
});

// ============================================
// Superseded references: kept, settled, or recorded for refund
// ============================================

describe("payments on superseded references", () => {
  /** A guest booking re-priced once: [old reference, new reference]. */
  async function repriced(): Promise<{ id: string; oldRef: string; newRef: string; newUrl: string }> {
    const { id, reference } = await bookGuest();
    pastTheLock();
    setRate("NGN", 1600);
    paystackAbandoned(reference, id, { agencySlug: "acme" });
    const out = await verify(reference);
    assert.equal(out.status, 409);
    return { id, oldRef: reference, newRef: out.body.data.reference, newUrl: out.body.data.authorizationUrl };
  }

  test("the booking already paid on the new reference: the old one's exact payment is recorded for refund, never a second Transaction", async () => {
    const { id, oldRef, newRef } = await repriced();
    paystackPaid(newRef, id, { amountMinor: 16_000_000, currency: "NGN" });
    assert.ok(okStatus((await verify(newRef)).status));
    assert.equal(docsIn("transactions").length, 1);

    // Then the abandoned old checkout is completed too, at its exact old price.
    const paidAt = new Date(harness.clock.now().getTime() + 60_000);
    paystackPaid(oldRef, id, { amountMinor: AGENCY_FEE_KOBO, currency: "NGN" }, paidAt);
    let logged = "";
    console.error = (m: string) => void (logged += m);
    const out = await verify(oldRef);
    assert.ok(okStatus(out.status), JSON.stringify(out.body));
    assert.equal(out.body.data.verified, true);
    assert.equal(out.body.data.refundPending, true);
    assert.match(logged, /cannot be applied.*recorded in consultationPaymentExceptions/);

    const exceptions = docsIn("consultationPaymentExceptions");
    assert.equal(exceptions.length, 1);
    const [exId, ex] = exceptions[0];
    assert.equal(exId, oldRef);
    assert.equal(ex.consultationId, id);
    assert.equal(ex.reference, oldRef);
    assert.equal(ex.amountMinor, AGENCY_FEE_KOBO);
    assert.equal(ex.currency, "NGN");
    assert.equal(ex.paystackPaidAt.toMillis(), paidAt.getTime());
    assert.equal(ex.reason, "paid_on_superseded_reference_after_booking_paid");
    assert.equal(ex.status, "open");
    assert.equal(docsIn("transactions").length, 1, "no second Transaction");
    const b = onlyBooking();
    assert.equal(b.transactionId, newRef, "the booking keeps the payment that settled it");
    assert.equal(b.chargedAmountMinor, 16_000_000);

    // A second verify of the same payment records nothing new.
    await verify(oldRef);
    assert.equal(docsIn("consultationPaymentExceptions").length, 1);
    assert.equal(docsIn("transactions").length, 1);
  });

  test("a short payment on a superseded reference is a mismatch: nothing recorded", async () => {
    const { id, oldRef } = await repriced();
    paystackPaid(oldRef, id, { amountMinor: AGENCY_FEE_KOBO - 1, currency: "NGN" });
    const out = await verify(oldRef);
    assert.equal(out.status, 400);
    assert.equal(out.body.error, "PAYMENT_MISMATCH");
    assert.equal(onlyBooking().paymentStatus, "pending");
    assert.equal(docsIn("transactions").length, 0);
    assert.equal(docsIn("consultationPaymentExceptions").length, 0);
  });

  test("a superseded reference paid at the NEW amount is a mismatch (judged against its own snapshot)", async () => {
    const { id, oldRef } = await repriced();
    paystackPaid(oldRef, id, { amountMinor: 16_000_000, currency: "NGN" });
    const out = await verify(oldRef);
    assert.equal(out.status, 400);
    assert.equal(out.body.error, "PAYMENT_MISMATCH");
  });

  test("an abandoned superseded reference points the payer at the current checkout (409 CHECKOUT_REPLACED)", async () => {
    const { oldRef, newRef, newUrl } = await repriced();
    const out = await verify(oldRef);
    assert.equal(out.status, 409);
    assert.equal(out.body.error, "CHECKOUT_REPLACED");
    assert.equal(out.body.data.reference, newRef);
    assert.equal(out.body.data.authorizationUrl, newUrl);
    assert.equal(harness.charges.length, 2, "nothing new opened");
  });

  test("a superseded reference still in flight is 409 PAYMENT_IN_PROGRESS", async () => {
    const { id, oldRef } = await repriced();
    paystackStatus(oldRef, id, "pending");
    const out = await verify(oldRef);
    assert.equal(out.status, 409);
    assert.equal(out.body.error, "PAYMENT_IN_PROGRESS");
  });

  test("a payment on a booking cancelled meanwhile is recorded for refund (409, no Transaction)", async () => {
    const { id, reference } = await bookGuest();
    await seed("consultations", id, { ...onlyBooking(), status: "cancelled" });
    paystackPaid(reference, id, { amountMinor: AGENCY_FEE_KOBO, currency: "NGN" });
    const out = await verify(reference);
    assert.equal(out.status, 409);
    assert.equal(out.body.error, "BOOKING_NOT_PAYABLE");
    assert.equal(docsIn("transactions").length, 0);
    const ex = docsIn("consultationPaymentExceptions");
    assert.equal(ex.length, 1);
    assert.equal(ex[0][1].reason, "booking_not_payable");
  });
});

// ============================================
// Exact match against what we ASKED (requested_amount)
// ============================================

describe("exact match uses requested_amount when Paystack reports it", () => {
  test("fees passed to the customer inflate `amount`; an exact `requested_amount` confirms, recording what we asked", async () => {
    const { id, reference } = await bookGuest();
    paystackPaid(reference, id, { amountMinor: AGENCY_FEE_KOBO + 225_000, currency: "NGN" }, undefined, {
      requestedAmount: AGENCY_FEE_KOBO,
    });
    const out = await verify(reference);
    assert.ok(okStatus(out.status), JSON.stringify(out.body));
    assert.equal(docsIn("transactions")[0][1].amount, AGENCY_FEE_KOBO);
  });

  test("a short `requested_amount` is a mismatch even when `amount` matches", async () => {
    const { id, reference } = await bookGuest();
    paystackPaid(reference, id, { amountMinor: AGENCY_FEE_KOBO, currency: "NGN" }, undefined, {
      requestedAmount: AGENCY_FEE_KOBO - 100,
    });
    const out = await verify(reference);
    assert.equal(out.status, 400);
    assert.equal(out.body.error, "PAYMENT_MISMATCH");
  });

  test("without `requested_amount`, `amount` is compared: exact confirms, fee-inflated is a mismatch", async () => {
    const { id, reference } = await bookGuest();
    paystackPaid(reference, id, { amountMinor: AGENCY_FEE_KOBO + 225_000, currency: "NGN" });
    assert.equal((await verify(reference)).body.error, "PAYMENT_MISMATCH");
    paystackPaid(reference, id, { amountMinor: AGENCY_FEE_KOBO, currency: "NGN" });
    const out = await verify(reference);
    assert.ok(okStatus(out.status), JSON.stringify(out.body));
    assert.equal(docsIn("transactions")[0][1].fxRate, NGN_RATE);
  });
});

// ============================================
// Provider failure inside a verify re-price
// ============================================

describe("a Paystack failure while verify re-prices", () => {
  test("is 502 BILLING_PROVIDER_ERROR, and verifying the old reference again opens the new checkout", async () => {
    const { id, reference } = await bookGuest();
    pastTheLock();
    paystackAbandoned(reference, id, { agencySlug: "acme" });
    harness.failNextCharge = true;
    const out = await verify(reference);
    assert.equal(out.status, 502, JSON.stringify(out.body));
    assert.equal(out.body.error, "BILLING_PROVIDER_ERROR");
    const b = onlyBooking();
    assert.equal(b.paymentStatus, "pending");
    assert.notEqual(b.transactionId, reference, "the claimed reference is stored");
    assert.equal(b.checkoutUrl, null, "but it never opened");
    assert.equal(b.supersededCheckouts[0].reference, reference);

    // The guest's return page posts the old reference again: a new checkout.
    const again = await verify(reference);
    assert.equal(again.status, 409, JSON.stringify(again.body));
    assert.equal(again.body.error, "QUOTE_EXPIRED");
    assert.ok(again.body.data.authorizationUrl);
    assert.equal(onlyBooking().transactionId, again.body.data.reference);
    assert.equal(onlyBooking().checkoutUrl, again.body.data.authorizationUrl);
  });
});
