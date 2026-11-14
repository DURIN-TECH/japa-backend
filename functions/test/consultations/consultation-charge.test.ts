// ============================================
// Unit tests — consultation bookings charged in local currency (issue #180, folds #166)
// ============================================
//
// Hermetic: in-memory Firestore, in-memory rate service, Paystack stubbed
// (test/consultations/harness.ts). No real charge, no network.
//
// What is covered, by acceptance criterion:
//  - the server decides the amount: body `fee` / `amount` / `rate` /
//    `currency` are ignored on both booking routes; the price comes from the
//    agency / agent record; only a verified, available agent (approved
//    agency) can be booked;
//  - the booking stores the ChargeSnapshot + quote lock; changing the rate
//    afterwards leaves bookings and transactions unchanged;
//  - Transaction.amount = chargedAmountMinor in chargedCurrency, with
//    priceUsdCents and the rate snapshot;
//  - Paystack gets amount = chargedAmountMinor and currency = chargedCurrency
//    (a second currency, GHS, is passed through);
//  - verify compares Paystack's amount AND currency; a mismatch leaves the
//    booking pending, answers 400 and records nothing; a second verify
//    writes no second transaction;
//  - free only for a missing or valid $0 fee; every malformed stored shape
//    is 503 with nothing written (the #179 review rule);
//  - missing / stale rate, unsupported or disabled currency: 503
//    PRICING_UNAVAILABLE, no Paystack call;
//  - quote lock: verify / retry after expiry re-prices with a fresh quote;
//    inside the lock a retry returns the same checkout;
//  - legacy `fee`-only bookings still verify as naira and are never re-priced.
import { test, describe, before, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { writes } from "../helpers/fake-firestore";
import {
  useHarness,
  harness,
  captureRes,
  docsIn,
  seed,
  setRate,
  dropRate,
  paystackPaid,
  paystackAbandoned,
  T0,
  NGN_RATE,
} from "./harness";
import { consultationController } from "../../src/controllers/consultation.controller";
import { classifyStoredFee, QUOTE_LOCK_MINUTES } from "../../src/services/consultation-charge.service";

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
});

// ============================================
// Fixtures
// ============================================

/** $100.00 = 10,000 US cents; at ₦1,500/$ that is ₦150,000 = 15,000,000 kobo. */
const AGENCY_FEE = { amountMinor: 10_000, currency: "USD" };
const AGENCY_FEE_KOBO = 15_000_000;

/** An approved agency with the given stored fee fields. */
async function seedAgency(fee: Record<string, unknown> = { consultationFeeUsd: AGENCY_FEE }, id = "ag1", slug = "acme") {
  await seed("agencies", id, {
    name: "Acme Visas", slug, status: "approved", ownerId: `owner-${id}`, ownerName: "Ola Owner",
    services: [], ...fee, createdAt: T0,
  });
}

/** A verified, available agent (doc id `id`, account uid `userId`). */
async function seedAgent(over: Record<string, unknown> = {}, id = "agent1", userId = "uid-agent1") {
  await seed("agents", id, {
    userId, displayName: "Ada Agent", verificationStatus: "verified", isAvailable: true,
    consultationFeeUsd: { amountMinor: 1_000, currency: "USD" }, createdAt: T0, ...over,
  });
}

/** A client account. */
async function seedClient(uid = "uid-client1", email = "delivered+client1@resend.dev") {
  await seed("users", uid, { email, firstName: "Chi", lastName: "Client", createdAt: T0 });
}

/** POST /agencies/public/:slug/consultations with a body. */
async function guestBook(body: Record<string, unknown> = {}, slug = "acme") {
  const { out, res } = captureRes();
  await consultationController.createPublicConsultation(
    {
      params: { slug },
      body: {
        clientName: "Gina Guest", clientEmail: "delivered+guest@resend.dev",
        scheduledDate: "2026-12-01", scheduledTime: "10:00", ...body,
      },
    } as any,
    res
  );
  return out;
}

/** POST /consultations as `uid` (a client unless an agent doc has that userId). */
async function signedInBook(uid: string, body: Record<string, unknown>) {
  const { out, res } = captureRes();
  await consultationController.createConsultation(
    { userId: uid, body: { type: "initial", scheduledDate: "2026-12-01", scheduledTime: "10:00", ...body } } as any,
    res
  );
  return out;
}

/** POST /consultations/public/verify. */
async function verify(reference: string) {
  const { out, res } = captureRes();
  await consultationController.verifyPublicConsultation({ body: { reference } } as any, res);
  return out;
}

/** POST /consultations/:id/checkout as `uid`. */
async function retry(id: string, uid: string) {
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

/** Express sendSuccess/sendCreated write `{ success, data }` without calling status() for 200. */
const okStatus = (s: number) => s === 0 || s === 200 || s === 201;

// ============================================
// The stored fee: free / paid / malformed (#179 review rule)
// ============================================

describe("classifyStoredFee", () => {
  test("missing, null and a valid $0 are free; a valid positive dollar fee is paid", () => {
    assert.deepEqual(classifyStoredFee({}), { kind: "free" });
    assert.deepEqual(classifyStoredFee({ consultationFeeUsd: null }), { kind: "free" });
    assert.deepEqual(classifyStoredFee({ consultationFeeUsd: { amountMinor: 0, currency: "USD" } }), { kind: "free" });
    assert.deepEqual(classifyStoredFee({ consultationFeeUsd: AGENCY_FEE }), { kind: "paid", usd: AGENCY_FEE });
  });

  /** Every malformed shape the #179 review listed, plus corruption. */
  const MALFORMED: Array<[string, Record<string, unknown>]> = [
    ["string amount", { consultationFeeUsd: { amountMinor: "10000", currency: "USD" } }],
    ["lower-case currency", { consultationFeeUsd: { amountMinor: 10000, currency: "usd" } }],
    ["naira currency", { consultationFeeUsd: { amountMinor: 10000, currency: "NGN" } }],
    ["fractional cents", { consultationFeeUsd: { amountMinor: 10.5, currency: "USD" } }],
    ["negative", { consultationFeeUsd: { amountMinor: -1, currency: "USD" } }],
    ["bare number", { consultationFeeUsd: 100 }],
    ["string", { consultationFeeUsd: "100" }],
    ["above the price cap", { consultationFeeUsd: { amountMinor: 10_000_001, currency: "USD" } }],
    ["leftover naira number", { consultationFee: 50000 }],
    ["leftover naira zero", { consultationFee: 0 }],
    ["leftover naira string", { consultationFee: "50000" }],
    ["leftover naira map", { consultationFee: { amount: 50000 } }],
    ["naira next to a valid dollar fee", { consultationFee: 50000, consultationFeeUsd: AGENCY_FEE }],
  ];
  for (const [name, doc] of MALFORMED) {
    test(`malformed: ${name}`, () => {
      assert.equal(classifyStoredFee(doc).kind, "malformed");
    });
  }

  test("guest booking with each malformed agency fee: 503, nothing written, no Paystack call", async () => {
    for (const [name, doc] of MALFORMED) {
      harness.reset();
      await seedAgency(doc);
      writes.length = 0;
      const out = await guestBook();
      assert.equal(out.status, 503, name);
      assert.equal(out.body.error, "PRICING_UNAVAILABLE", name);
      assert.deepEqual(writes, [], name);
      assert.equal(harness.charges.length, 0, name);
    }
  });

  test("signed-in booking with each malformed agent fee: 503, nothing written, no Paystack call", async () => {
    for (const [name, doc] of MALFORMED) {
      harness.reset();
      await seedClient();
      await seedAgent({ consultationFeeUsd: undefined, ...doc });
      writes.length = 0;
      const out = await signedInBook("uid-client1", { agentId: "agent1" });
      assert.equal(out.status, 503, name);
      assert.equal(out.body.error, "PRICING_UNAVAILABLE", name);
      assert.deepEqual(writes, [], name);
      assert.equal(harness.charges.length, 0, name);
    }
  });
});

// ============================================
// Guest booking (public agency page)
// ============================================

describe("guest booking: the server decides the amount", () => {
  test("a tiny body fee, a fake rate and a currency are ignored; the agency's dollar fee is quoted, locked and charged", async () => {
    await seedAgency();
    const out = await guestBook({ fee: 1, amount: 1, rate: 0.0001, currency: "USD", chargedAmountMinor: 1 });
    assert.equal(out.status, 201);
    assert.equal(out.body.data.requiresPayment, true);
    assert.equal(out.body.data.chargedAmountMinor, AGENCY_FEE_KOBO);
    assert.equal(out.body.data.chargedCurrency, "NGN");

    const b = onlyBooking();
    // The snapshot (#178 field names) and the lock.
    assert.equal(b.priceUsdCents, 10_000);
    assert.equal(b.chargedCurrency, "NGN");
    assert.equal(b.chargedAmountMinor, AGENCY_FEE_KOBO);
    assert.equal(b.fxRate, NGN_RATE);
    assert.equal(b.fxRateSource, "cbn");
    assert.equal(b.fxMarginBps, 0);
    assert.ok(typeof b.fxRateAsOf?.toMillis === "function");
    assert.equal(b.quoteExpiresAt.toMillis() - b.quoteLockedAt.toMillis(), QUOTE_LOCK_MINUTES * 60_000);
    assert.equal(b.status, "pending_payment");
    assert.equal(b.paymentStatus, "pending");
    // No legacy naira fee is written any more.
    assert.equal("fee" in b, false);

    // Paystack got exactly the stored amount and currency.
    assert.equal(harness.charges.length, 1);
    assert.deepEqual(harness.charges[0].amount, { amountMinor: AGENCY_FEE_KOBO, currency: "NGN" });
    assert.equal(harness.charges[0].email, "delivered+guest@resend.dev");
    assert.equal(harness.charges[0].metadata?.consultationId, b.id);
    assert.equal(b.transactionId, out.body.data.reference);
  });

  test("a missing fee or a valid $0 books free: scheduled/paid, no Paystack", async () => {
    for (const fee of [{}, { consultationFeeUsd: { amountMinor: 0, currency: "USD" } }]) {
      harness.reset();
      await seedAgency(fee);
      const out = await guestBook({ fee: 5000 });
      assert.equal(out.status, 201);
      assert.equal(out.body.data.requiresPayment, false);
      const b = onlyBooking();
      assert.equal(b.status, "scheduled");
      assert.equal(b.paymentStatus, "paid");
      assert.equal(b.priceUsdCents, 0);
      assert.equal(harness.charges.length, 0);
    }
  });

  test("no stored rate: 503 PRICING_UNAVAILABLE, nothing written, no Paystack call", async () => {
    await seedAgency();
    dropRate("NGN");
    writes.length = 0;
    const out = await guestBook();
    assert.equal(out.status, 503);
    assert.equal(out.body.error, "PRICING_UNAVAILABLE");
    assert.deepEqual(writes, []);
    assert.equal(harness.charges.length, 0);
  });

  test("a stale rate (older than the freshness limit): 503, nothing written, no Paystack call", async () => {
    await seedAgency();
    harness.clock.advanceHours(24 * 7); // past the 72h freshness limit
    writes.length = 0;
    const out = await guestBook();
    assert.equal(out.status, 503);
    assert.equal(out.body.error, "PRICING_UNAVAILABLE");
    assert.deepEqual(writes, []);
    assert.equal(harness.charges.length, 0);
  });

  test("a Paystack outage is 502 and leaves the booking pending with no reference", async () => {
    await seedAgency();
    harness.failNextCharge = true;
    const out = await guestBook();
    assert.equal(out.status, 502);
    assert.equal(out.body.error, "BILLING_PROVIDER_ERROR");
    const b = onlyBooking();
    assert.equal(b.paymentStatus, "pending");
    assert.equal(b.transactionId, undefined);
  });

  test("an unapproved agency is 404", async () => {
    await seed("agencies", "ag2", { slug: "pending-co", status: "pending", ownerId: "o2", consultationFeeUsd: AGENCY_FEE });
    const out = await guestBook({}, "pending-co");
    assert.equal(out.status, 404);
  });
});

// ============================================
// Signed-in booking (POST /consultations)
// ============================================

describe("signed-in booking: server price, client's own currency, real checkout", () => {
  test("a Ghana client is quoted in GHS from the agent's dollar fee; body price fields are ignored", async () => {
    await seedClient();
    harness.countries["uid-client1"] = "GH";
    await seedAgent(); // $10.00
    const out = await signedInBook("uid-client1", {
      agentId: "agent1", fee: 1, amount: 1, rate: 0.01, currency: "NGN", chargedCurrency: "USD",
    });
    assert.equal(out.status, 201);
    assert.equal(out.body.data.requiresPayment, true);
    assert.ok(out.body.data.authorizationUrl);

    const b = onlyBooking();
    // $10.00 at GH₵15/$ = GH₵150.00 = 15,000 pesewas.
    assert.equal(b.priceUsdCents, 1_000);
    assert.equal(b.chargedCurrency, "GHS");
    assert.equal(b.chargedAmountMinor, 15_000);
    assert.equal(b.fxRate, 15);
    assert.equal(b.agentId, "uid-agent1");
    assert.equal("fee" in b, false);
    // The currency is passed through to Paystack, not hard-coded naira.
    assert.deepEqual(harness.charges[0].amount, { amountMinor: 15_000, currency: "GHS" });
    assert.equal(harness.charges[0].email, "delivered+client1@resend.dev");
  });

  test("a client with no mapped country is charged in the default currency (NGN)", async () => {
    await seedClient();
    await seedAgent();
    const out = await signedInBook("uid-client1", { agentId: "agent1" });
    assert.equal(out.status, 201);
    assert.equal(onlyBooking().chargedCurrency, "NGN");
    assert.equal(onlyBooking().chargedAmountMinor, 1_500_000); // $10 x 1500 = ₦15,000
  });

  test("a disabled charge currency (Kenya -> KES off): 503, nothing written, no Paystack call", async () => {
    await seedClient();
    harness.countries["uid-client1"] = "KE";
    await seedAgent();
    writes.length = 0;
    const out = await signedInBook("uid-client1", { agentId: "agent1" });
    assert.equal(out.status, 503);
    assert.equal(out.body.error, "PRICING_UNAVAILABLE");
    assert.deepEqual(writes, []);
    assert.equal(harness.charges.length, 0);
  });

  test("an agent at $0 books free: scheduled/paid, no Paystack, even with a body fee", async () => {
    await seedClient();
    await seedAgent({ consultationFeeUsd: { amountMinor: 0, currency: "USD" } });
    const out = await signedInBook("uid-client1", { agentId: "agent1", fee: 50000 });
    assert.equal(out.status, 201);
    assert.equal(out.body.data.requiresPayment, false);
    assert.equal(onlyBooking().status, "scheduled");
    assert.equal(onlyBooking().paymentStatus, "paid");
    assert.equal(harness.charges.length, 0);
  });

  test("only a verified, available agent in an approved agency can be booked (404, nothing written)", async () => {
    await seedClient();
    await seedAgent({ verificationStatus: "pending" }, "a-unverified");
    await seedAgent({ isAvailable: false }, "a-away");
    await seed("agencies", "ag-pending", { status: "pending", ownerId: "o" });
    await seedAgent({ agencyId: "ag-pending" }, "a-pending-agency");
    await seedAgent({ agencyId: "ag-missing" }, "a-no-agency-doc");
    for (const agentId of ["a-unverified", "a-away", "a-pending-agency", "a-no-agency-doc", "a-does-not-exist"]) {
      writes.length = 0;
      const out = await signedInBook("uid-client1", { agentId });
      assert.equal(out.status, 404, agentId);
      assert.deepEqual(writes, [], agentId);
    }
    assert.equal(harness.charges.length, 0);
  });

  test("agent-initiated: priced from the agent's OWN record, not the body", async () => {
    await seedClient();
    await seedAgent({ consultationFeeUsd: { amountMinor: 2_000, currency: "USD" } }, "agent1", "uid-agent1");
    const out = await signedInBook("uid-agent1", { userId: "uid-client1", fee: 1 });
    assert.equal(out.status, 201);
    const b = onlyBooking();
    assert.equal(b.priceUsdCents, 2_000);
    assert.equal(b.chargedAmountMinor, 3_000_000); // $20 x 1500 = ₦30,000
    assert.equal(b.userId, "uid-client1");
    // The checkout is for the client, who pays.
    assert.equal(harness.charges[0].email, "delivered+client1@resend.dev");
  });
});

// ============================================
// Verify-on-return
// ============================================

describe("verify: Paystack's amount and currency must match the stored charge", () => {
  /** Book a paid guest consultation and return its id + reference. */
  async function bookPaid(): Promise<{ id: string; reference: string }> {
    await seedAgency();
    const out = await guestBook();
    return { id: out.body.data.consultationId, reference: out.body.data.reference };
  }

  test("a matching payment confirms the booking and records ONE transaction with the snapshot", async () => {
    const { id, reference } = await bookPaid();
    paystackPaid(reference, id, { amountMinor: AGENCY_FEE_KOBO, currency: "NGN" });
    const out = await verify(reference);
    assert.ok(okStatus(out.status), JSON.stringify(out.body));
    assert.equal(out.body.data.verified, true);
    assert.equal(out.body.data.consultation.paymentStatus, "paid");
    assert.equal(out.body.data.consultation.chargedAmountMinor, AGENCY_FEE_KOBO);

    const b = onlyBooking();
    assert.equal(b.status, "scheduled");
    assert.equal(b.paymentStatus, "paid");
    const txs = docsIn("transactions");
    assert.equal(txs.length, 1);
    const tx = txs[0][1];
    assert.equal(tx.type, "consultation_fee");
    assert.equal(tx.amount, AGENCY_FEE_KOBO);
    assert.equal(tx.currency, "NGN");
    assert.equal(tx.priceUsdCents, 10_000);
    assert.equal(tx.chargedAmountMinor, AGENCY_FEE_KOBO);
    assert.equal(tx.chargedCurrency, "NGN");
    assert.equal(tx.fxRate, NGN_RATE);
    assert.equal(tx.fxRateSource, "cbn");
    assert.equal(tx.fxMarginBps, 0);
    assert.equal(tx.providerTransactionId, reference);
    assert.equal(tx.consultationId, id);

    // A second verify is a no-op: no second transaction.
    const again = await verify(reference);
    assert.ok(okStatus(again.status));
    assert.equal(again.body.data.verified, true);
    assert.equal(docsIn("transactions").length, 1);
  });

  test("an underpayment is 400 PAYMENT_MISMATCH: booking stays pending, nothing recorded", async () => {
    const { id, reference } = await bookPaid();
    paystackPaid(reference, id, { amountMinor: AGENCY_FEE_KOBO - 1, currency: "NGN" });
    writes.length = 0;
    const out = await verify(reference);
    assert.equal(out.status, 400);
    assert.equal(out.body.error, "PAYMENT_MISMATCH");
    assert.equal(onlyBooking().paymentStatus, "pending");
    assert.equal(onlyBooking().status, "pending_payment");
    assert.equal(docsIn("transactions").length, 0);
    assert.deepEqual(writes, []);
  });

  test("the right number in the wrong currency is 400 PAYMENT_MISMATCH, nothing recorded", async () => {
    const { id, reference } = await bookPaid();
    paystackPaid(reference, id, { amountMinor: AGENCY_FEE_KOBO, currency: "USD" });
    writes.length = 0;
    const out = await verify(reference);
    assert.equal(out.status, 400);
    assert.equal(out.body.error, "PAYMENT_MISMATCH");
    assert.equal(onlyBooking().paymentStatus, "pending");
    assert.deepEqual(writes, []);
  });

  test("a report with no amount or currency is a mismatch, never a match", async () => {
    const { id, reference } = await bookPaid();
    harness.paystack.set(reference, { status: "success", metadata: { purpose: "consultation", consultationId: id } });
    const out = await verify(reference);
    assert.equal(out.status, 400);
    assert.equal(out.body.error, "PAYMENT_MISMATCH");
    assert.equal(docsIn("transactions").length, 0);
  });

  test("a reference that is not the one stored on the booking is refused", async () => {
    const { id } = await bookPaid();
    paystackPaid("someone-elses-ref", id, { amountMinor: AGENCY_FEE_KOBO, currency: "NGN" });
    const out = await verify("someone-elses-ref");
    assert.equal(out.status, 400);
    assert.equal(onlyBooking().paymentStatus, "pending");
    assert.equal(docsIn("transactions").length, 0);
  });

  test("changing the stored rate after booking leaves the booking and its transaction unchanged", async () => {
    const { id, reference } = await bookPaid();
    const before = { ...onlyBooking() };
    setRate("NGN", 1700); // the rate moves
    paystackPaid(reference, id, { amountMinor: AGENCY_FEE_KOBO, currency: "NGN" });
    const out = await verify(reference);
    assert.ok(okStatus(out.status));
    const b = onlyBooking();
    for (const f of ["priceUsdCents", "chargedCurrency", "chargedAmountMinor", "fxRate", "fxRateSource", "fxMarginBps"]) {
      assert.deepEqual(b[f], before[f], f);
    }
    const tx = docsIn("transactions")[0][1];
    assert.equal(tx.amount, AGENCY_FEE_KOBO);
    assert.equal(tx.fxRate, NGN_RATE);
    // And after the transaction exists, another rate move changes nothing either.
    setRate("NGN", 1900);
    await verify(reference);
    assert.equal(docsIn("transactions")[0][1].amount, AGENCY_FEE_KOBO);
    assert.equal(onlyBooking().chargedAmountMinor, AGENCY_FEE_KOBO);
  });

  test("not paid, inside the lock: 400 not completed, nothing re-priced", async () => {
    const { id, reference } = await bookPaid();
    paystackAbandoned(reference, id);
    const out = await verify(reference);
    assert.equal(out.status, 400);
    assert.equal(harness.charges.length, 1);
    assert.equal(onlyBooking().transactionId, reference);
  });

  test("not paid, after the lock: a FRESH quote at the new rate and a new checkout (409 QUOTE_EXPIRED)", async () => {
    const { id, reference } = await bookPaid();
    harness.clock.advanceHours(1); // past the 30-minute lock
    setRate("NGN", 1600);
    paystackAbandoned(reference, id, { agencySlug: "acme" });
    const out = await verify(reference);
    assert.equal(out.status, 409);
    assert.equal(out.body.error, "QUOTE_EXPIRED");
    const fresh = out.body.data;
    assert.notEqual(fresh.reference, reference);
    // $100 x 1600 = ₦160,000 = 16,000,000 kobo, never the stale 15,000,000.
    assert.equal(fresh.consultation.chargedAmountMinor, 16_000_000);
    assert.deepEqual(harness.charges[1].amount, { amountMinor: 16_000_000, currency: "NGN" });
    const b = onlyBooking();
    assert.equal(b.chargedAmountMinor, 16_000_000);
    assert.equal(b.fxRate, 1600);
    assert.equal(b.transactionId, fresh.reference);
    assert.ok(b.quoteExpiresAt.toMillis() > harness.clock.now().getTime());
    // The old reference can no longer settle the booking.
    paystackPaid(reference, id, { amountMinor: AGENCY_FEE_KOBO, currency: "NGN" });
    const stale = await verify(reference);
    assert.equal(stale.status, 400);
    assert.equal(docsIn("transactions").length, 0);
  });

  test("after the lock with no usable rate: 503 and no new checkout", async () => {
    const { id, reference } = await bookPaid();
    harness.clock.advanceHours(1);
    dropRate("NGN");
    paystackAbandoned(reference, id);
    const out = await verify(reference);
    assert.equal(out.status, 503);
    assert.equal(out.body.error, "PRICING_UNAVAILABLE");
    assert.equal(harness.charges.length, 1);
  });

  test("paid at the right amount but after the lock: 409, not confirmed, nothing recorded", async () => {
    const { id, reference } = await bookPaid();
    harness.clock.advanceHours(1);
    paystackPaid(reference, id, { amountMinor: AGENCY_FEE_KOBO, currency: "NGN" });
    const out = await verify(reference);
    assert.equal(out.status, 409);
    assert.equal(out.body.error, "QUOTE_EXPIRED");
    assert.equal(onlyBooking().paymentStatus, "pending");
    assert.equal(docsIn("transactions").length, 0);
    assert.equal(harness.charges.length, 1); // no second checkout opened
  });

  test("a cancelled booking is not confirmed", async () => {
    const { id, reference } = await bookPaid();
    await seed("consultations", id, { ...onlyBooking(), status: "cancelled" });
    paystackPaid(reference, id, { amountMinor: AGENCY_FEE_KOBO, currency: "NGN" });
    const out = await verify(reference);
    assert.equal(out.status, 409);
    assert.equal(docsIn("transactions").length, 0);
  });
});

// ============================================
// Legacy bookings (fee only, no snapshot)
// ============================================

describe("legacy naira bookings keep working and are never re-priced", () => {
  test("a ₦50,000 legacy booking verifies against its fee and records 5,000,000 kobo NGN with no snapshot", async () => {
    await seed("consultations", "c-legacy", {
      userId: "guest1", agentId: "owner1", clientName: "G", clientEmail: "delivered+g@resend.dev",
      agentName: "A", type: "initial", scheduledTime: "10:00", timezone: "Africa/Lagos",
      status: "pending_payment", paymentStatus: "pending", fee: 50000, transactionId: "ref-legacy", createdAt: T0,
    });
    setRate("NGN", 1700); // a rate move must not matter for a legacy row
    paystackPaid("ref-legacy", "c-legacy", { amountMinor: 5_000_000, currency: "NGN" });
    const out = await verify("ref-legacy");
    assert.ok(okStatus(out.status), JSON.stringify(out.body));
    // Displayed as naira.
    assert.equal(out.body.data.consultation.fee, 50000);
    assert.equal(out.body.data.consultation.feeCurrency, "NGN");
    const tx = docsIn("transactions")[0][1];
    assert.equal(tx.amount, 5_000_000);
    assert.equal(tx.currency, "NGN");
    assert.equal("priceUsdCents" in tx, false);
    assert.equal("fxRate" in tx, false);
    // The booking was not re-priced.
    const b = onlyBooking();
    assert.equal(b.fee, 50000);
    assert.equal("chargedAmountMinor" in b, false);
  });

  test("a legacy booking paid short is still a mismatch", async () => {
    await seed("consultations", "c-legacy", {
      userId: "guest1", agentId: "owner1", status: "pending_payment", paymentStatus: "pending",
      fee: 50000, transactionId: "ref-legacy",
    });
    paystackPaid("ref-legacy", "c-legacy", { amountMinor: 50_000, currency: "NGN" }); // the old "forgot the *100" bug
    const out = await verify("ref-legacy");
    assert.equal(out.status, 400);
    assert.equal(docsIn("transactions").length, 0);
  });

  test("a legacy booking is never re-charged through the retry route", async () => {
    await seed("consultations", "c-legacy", {
      userId: "uid-client1", agentId: "owner1", status: "pending_payment", paymentStatus: "pending", fee: 50000,
    });
    const out = await retry("c-legacy", "uid-client1");
    assert.equal(out.status, 409);
    assert.equal(harness.charges.length, 0);
  });
});

// ============================================
// Retry: POST /consultations/:id/checkout
// ============================================

describe("retry an abandoned checkout", () => {
  /** A signed-in client's paid booking. */
  async function bookSignedIn(): Promise<{ id: string; reference: string; url: string }> {
    await seedClient();
    await seedAgent();
    const out = await signedInBook("uid-client1", { agentId: "agent1" });
    return { id: out.body.data.id, reference: out.body.data.reference, url: out.body.data.authorizationUrl };
  }

  test("inside the lock the SAME checkout comes back (no second charge opened)", async () => {
    const { id, reference, url } = await bookSignedIn();
    paystackAbandoned(reference, id);
    const out = await retry(id, "uid-client1");
    assert.ok(okStatus(out.status));
    assert.equal(out.body.data.reference, reference);
    assert.equal(out.body.data.authorizationUrl, url);
    assert.equal(harness.charges.length, 1);
  });

  test("after the lock a fresh quote and a new checkout", async () => {
    const { id, reference } = await bookSignedIn();
    paystackAbandoned(reference, id);
    harness.clock.advanceHours(2);
    setRate("NGN", 1550);
    const out = await retry(id, "uid-client1");
    assert.ok(okStatus(out.status));
    assert.notEqual(out.body.data.reference, reference);
    assert.equal(out.body.data.consultation.chargedAmountMinor, 1_550_000); // $10 x 1550
    assert.equal(harness.charges.length, 2);
    assert.equal(onlyBooking().transactionId, out.body.data.reference);
  });

  test("when the old checkout was in fact paid, it is confirmed, not charged again", async () => {
    const { id, reference } = await bookSignedIn();
    paystackPaid(reference, id, { amountMinor: 1_500_000, currency: "NGN" });
    const out = await retry(id, "uid-client1");
    assert.ok(okStatus(out.status));
    assert.equal(out.body.data.requiresPayment, false);
    assert.equal(onlyBooking().paymentStatus, "paid");
    assert.equal(docsIn("transactions").length, 1);
    assert.equal(harness.charges.length, 1);
  });

  test("a Paystack outage on the first checkout can be retried", async () => {
    await seedClient();
    await seedAgent();
    harness.failNextCharge = true;
    const first = await signedInBook("uid-client1", { agentId: "agent1" });
    assert.equal(first.status, 502);
    const id = onlyBooking().id;
    const out = await retry(id, "uid-client1");
    assert.ok(okStatus(out.status));
    assert.ok(out.body.data.authorizationUrl);
    assert.equal(onlyBooking().transactionId, out.body.data.reference);
  });

  test("only the booking's own client can pay it (403 for anyone else, nothing opened)", async () => {
    const { id } = await bookSignedIn();
    for (const uid of ["uid-client2", "uid-agent1"]) {
      const out = await retry(id, uid);
      assert.equal(out.status, 403, uid);
    }
    assert.equal(harness.charges.length, 1);
  });
});
