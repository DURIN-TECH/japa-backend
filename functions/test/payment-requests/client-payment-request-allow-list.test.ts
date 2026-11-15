// ============================================
// Unit tests — issue #332: a client's view of a payment request is an allow-list
// ============================================
//
// #329 closed the leak on GET /transactions. The payment-request endpoints
// still answered the request's client with the whole stored document:
// Seli's exchange-rate markup (`fxMarginBps`), the raw rate it is added to
// (`fxRate`, `fxRateAsOf`, `fxRateSource`) and `supersededCheckouts` (every
// replaced checkout, each with its own raw rate and markup).
//
// The contract checked here:
//  - a client gets `ClientPaymentRequest`, whose keys are ONLY the ones in
//    CLIENT_PAYMENT_REQUEST_FIELDS, from every payment-request route that
//    can answer a client: list, detail, approve, checkout, verify, reject,
//    and the 409 bodies that carry `data.paymentRequest`
//    (PAYMENT_IN_PROGRESS, CHECKOUT_REPLACED, QUOTE_EXPIRED);
//  - nothing hidden reaches a response, by key OR by value (each response
//    is searched for a marker value planted in every hidden field);
//  - the client gets the EFFECTIVE rate instead (`effectiveRate` = amount
//    charged ÷ dollar price, markup included);
//  - the guard against future leaks, in three layers (as in #329):
//      1. `FULL_REQUEST` is typed `Required<PaymentRequest>`, so a field
//         added to the `PaymentRequest` type does not COMPILE here until it
//         is added to the fixture;
//      2. every key of that fixture must then be classified, as shown to
//         clients (SHOWN_FROM) or hidden (HIDDEN_FIELDS);
//      3. a field nobody declared at all (written straight to Firestore)
//         still cannot leak, because the mapper copies named fields only;
//  - agents, owners and admins still get the full stored document.
//
// Runs on the in-memory Firestore of the payment-request harness: no
// emulator, no network, no Paystack.
import { test, describe, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Timestamp } from "firebase-admin/firestore";
import { ROLES } from "@durin-tech/authz";
import type { AuthzSubject } from "@durin-tech/authz";

import {
  usePaymentRequestHarness,
  resetPaymentRequests,
  reqFor,
  agentA,
  ownerA,
  clientNg,
  clientGh,
  APP_A,
  harness,
  paystackPaidRequest,
  paystackRequestStatus,
} from "./helpers";
import { captureRes, seed, HARNESS_CONFIG, NOW_ISO } from "../consultations/harness";
import { store } from "../helpers/fake-firestore";
import { makeService } from "../money/helpers";
import { paymentRequestController, presentPaymentRequest } from "../../src/controllers/payment-request.controller";
import { consultationCharging } from "../../src/services/consultation-charge.service";
import { messagingService } from "../../src/services/messaging.service";
import {
  CLIENT_PAYMENT_REQUEST_FIELDS,
  seesFullPaymentRequest,
  toClientPaymentRequest,
} from "../../src/payment-requests/client-payment-request";
import { convertUsdToLocal, makeMoney } from "../../src/money/money";
import type { PaymentRequest } from "../../src/types";

/* eslint-disable @typescript-eslint/no-explicit-any */

/** A platform admin (no agency). */
const admin: AuthzSubject = { uid: "uid-admin", role: ROLES.ADMIN, agencyId: null };

/** A timestamp `minutes` after the harness clock. */
const at = (minutes: number) => Timestamp.fromMillis(new Date(NOW_ISO).getTime() + minutes * 60_000);

// ============================================
// The charge used throughout: $6.00 at a raw rate of ₦1,320.95 + 2.5% markup
// ============================================

/** The dollar price, in US cents ($6.00). */
const PRICE_USD_CENTS = 600;
/** The raw (mid-market) rate: naira per dollar, BEFORE the markup. Hidden. */
const RAW_RATE = 1320.95;
/** Seli's markup in basis points (2.5%). Hidden. */
const MARGIN_BPS = 250;
/** What the client is charged, in kobo, worked out by the real conversion. */
const CHARGED_KOBO = convertUsdToLocal(makeMoney(PRICE_USD_CENTS, "USD"), RAW_RATE, "NGN", MARGIN_BPS).amountMinor;
/** The rate the client effectively pays: naira charged ÷ dollars, to 6 decimals. */
const EFFECTIVE_RATE = Math.round((CHARGED_KOBO / PRICE_USD_CENTS) * 1e6) / 1e6;

// ============================================
// A stored request with EVERY PaymentRequest field set
// ============================================
//
// `Required<PaymentRequest>`: adding a field to the type breaks the build of
// this file until the field is added here, and then the classification test
// below makes the author say whether clients see it. Hidden fields hold
// marker values that appear nowhere else, so a response can be searched.

const FULL_ID = "pr-full";
/** The current checkout's reference (ours: `preq-<id>-...`). */
const CURRENT_REF = "preq-pr-full-current";

const FULL_REQUEST: Required<PaymentRequest> = {
  id: FULL_ID,
  // ---- Shown to the client ----
  applicationId: APP_A,
  agentId: "prof-agent-a",
  agencyId: "agency-a",
  clientId: clientNg.uid,
  clientName: "Ngozi Client",
  clientEmail: "delivered+client-ng@resend.dev",
  priceUsd: { amountMinor: PRICE_USD_CENTS, currency: "USD" },
  amount: PRICE_USD_CENTS,
  currency: "USD",
  description: "Visa Processing Fee",
  category: "visa_fee",
  status: "approved",
  priceUsdCents: PRICE_USD_CENTS,
  chargedCurrency: "NGN",
  chargedAmountMinor: CHARGED_KOBO,
  quoteLockedAt: at(0),
  quoteExpiresAt: at(30),
  paystackReference: CURRENT_REF,
  checkoutUrl: `https://checkout.paystack.test/${CURRENT_REF}`,
  paidAt: at(3),
  cancelledAt: at(4),
  expiresAt: at(5),
  approvedAt: at(6),
  rejectedAt: at(7),
  rejectionReason: "Too much",
  createdAt: at(1),
  updatedAt: at(2),
  // ---- Hidden from the client ----
  fxRate: RAW_RATE,
  fxRateAsOf: Timestamp.fromMillis(1_711_111_111_000),
  fxRateSource: "hold",
  fxMarginBps: MARGIN_BPS,
  checkoutCallbackUrl: "https://HIDDEN-callback.example.test/return",
  paystackPaidAt: Timestamp.fromMillis(1_722_222_222_000),
  paidAfterQuoteExpiry: true,
  paidOnSupersededReference: true,
  paymentTransactionId: "HIDDEN-payment-transaction-id",
  supersededCheckouts: [
    {
      reference: "preq-pr-full-HIDDEN-superseded",
      supersededAt: Timestamp.fromMillis(1_733_333_333_000),
      priceUsdCents: PRICE_USD_CENTS,
      chargedCurrency: "NGN",
      chargedAmountMinor: 811_111,
      // A second raw rate and markup, inside the array.
      fxRate: 1318.47,
      fxRateAsOf: Timestamp.fromMillis(1_744_444_444_000),
      fxRateSource: "hold",
      fxMarginBps: 275,
    },
  ],
};

/**
 * Stored fields a client is shown, and the response key(s) each one feeds.
 * Every response key in CLIENT_PAYMENT_REQUEST_FIELDS must be fed by one of
 * them (`effectiveRate`, `charge`, `legacy` and `amountDisplay` are built
 * from the dollar price and the amount charged).
 */
const SHOWN_FROM: Partial<Record<keyof PaymentRequest, readonly string[]>> = {
  id: ["id"],
  applicationId: ["applicationId"],
  agentId: ["agentId"],
  agencyId: ["agencyId"],
  clientId: ["clientId"],
  clientName: ["clientName"],
  clientEmail: ["clientEmail"],
  priceUsd: ["priceUsd", "legacy", "amountDisplay"],
  amount: ["amount"],
  currency: ["currency"],
  description: ["description"],
  category: ["category"],
  status: ["status"],
  priceUsdCents: ["priceUsdCents", "effectiveRate"],
  chargedCurrency: ["chargedCurrency", "effectiveRate", "charge", "amountDisplay"],
  chargedAmountMinor: ["chargedAmountMinor", "effectiveRate", "charge", "amountDisplay"],
  quoteLockedAt: ["quoteLockedAt"],
  quoteExpiresAt: ["quoteExpiresAt"],
  paystackReference: ["paystackReference"],
  checkoutUrl: ["checkoutUrl"],
  paidAt: ["paidAt"],
  cancelledAt: ["cancelledAt"],
  expiresAt: ["expiresAt"],
  approvedAt: ["approvedAt"],
  rejectedAt: ["rejectedAt"],
  rejectionReason: ["rejectionReason"],
  createdAt: ["createdAt"],
  updatedAt: ["updatedAt"],
};

/**
 * Stored fields a client must NEVER receive. A new PaymentRequest field goes
 * here unless there is a decision to show it (then: SHOWN_FROM, the mapper
 * and CLIENT_PAYMENT_REQUEST_FIELDS, all three).
 */
const HIDDEN_FIELDS: readonly (keyof PaymentRequest)[] = [
  // Seli's markup, and the raw rate it is added to.
  "fxMarginBps",
  "fxRate",
  "fxRateAsOf",
  "fxRateSource",
  // Replaced checkouts: each carries a full snapshot (rate and markup again).
  "supersededCheckouts",
  // Checkout and settlement bookkeeping.
  "checkoutCallbackUrl",
  "paystackPaidAt",
  "paidAfterQuoteExpiry",
  "paidOnSupersededReference",
  "paymentTransactionId",
];

/** Marker values that must not appear anywhere in a client response. */
const HIDDEN_VALUES: readonly string[] = [
  "HIDDEN", // every marker string starts with or contains it
  String(RAW_RATE), // 1320.95, the raw rate
  "1318.47", // the superseded checkout's raw rate
  "811111", // the superseded checkout's amount
  "1711111111", // fxRateAsOf seconds
  "1722222222", // paystackPaidAt seconds
  "1733333333", // supersededAt seconds
  "1744444444", // the superseded checkout's fxRateAsOf seconds
  "hold", // fxRateSource
  "NOT-IN-THE-TYPE", // the undeclared fields seeded below
];

/**
 * Fields that exist in NO type: what a future write path might add straight
 * to the document. They must not reach a client either.
 */
const UNDECLARED = {
  platformFeeBps: "NOT-IN-THE-TYPE-fee",
  internalNote: "NOT-IN-THE-TYPE-note",
  pricing: { costRate: "NOT-IN-THE-TYPE-nested" },
};

/** The request as stored: every declared field plus the undeclared ones. */
const STORED = { ...FULL_REQUEST, ...UNDECLARED };

/**
 * Assert a client-facing value leaks nothing, by key name or by value, at
 * any depth. `allowed` (when given) is the exact set of top-level keys.
 */
function assertNoLeak(value: unknown, allowed?: readonly string[]): void {
  if (allowed) {
    const set = new Set<string>(allowed);
    for (const key of Object.keys(value as Record<string, unknown>)) {
      assert.ok(set.has(key), `client response carries a key outside the allow-list: "${key}"`);
    }
  }
  const json = JSON.stringify(value);
  // Hidden key names, at any depth (JSON key = `"name":`).
  for (const key of [...HIDDEN_FIELDS, ...Object.keys(UNDECLARED), "supersededAt", "costRate"]) {
    assert.ok(!json.includes(`"${key}":`), `client response carries the hidden key "${key}"`);
  }
  // Hidden values, at any depth.
  for (const hidden of HIDDEN_VALUES) {
    assert.ok(!json.includes(hidden), `client response carries the hidden value "${hidden}"`);
  }
}

/** The stored request doc. */
const storedDoc = (id: string) => store.get(`paymentRequests/${id}`) as any;

/** Call one controller method as `who` and return the recorded answer. */
async function call(
  method: "getPaymentRequests" | "getPaymentRequest" | "approvePaymentRequest" | "checkoutPaymentRequest" | "verifyPayment" | "rejectPaymentRequest",
  who: AuthzSubject,
  extra: Record<string, unknown> = {}
) {
  const { out, res } = captureRes();
  await (paymentRequestController as any)[method](reqFor(who, extra), res);
  return out;
}

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
  // The fully populated request plus the undeclared fields, as stored.
  await seed("paymentRequests", FULL_ID, STORED);
});

// ============================================
// The allow-list itself
// ============================================

describe("client payment-request allow-list (issue #332)", () => {
  test("every stored field is classified as shown or hidden (a new field must be decided)", () => {
    const shown = Object.keys(SHOWN_FROM);
    const hidden = HIDDEN_FIELDS as readonly string[];
    for (const key of Object.keys(FULL_REQUEST)) {
      assert.ok(
        shown.includes(key) !== hidden.includes(key),
        `PaymentRequest.${key} must be in exactly one of SHOWN_FROM or HIDDEN_FIELDS. ` +
          "A new field is hidden from clients unless it is deliberately added to toClientPaymentRequest."
      );
    }
    // And nothing is classified that the type no longer has.
    for (const key of [...shown, ...hidden]) assert.ok(key in FULL_REQUEST, `${key} is not a PaymentRequest field`);
  });

  test("the response keys are exactly the allow-list, each fed by a field marked as shown", () => {
    const fed = new Set(Object.values(SHOWN_FROM).flat());
    assert.deepEqual([...fed].sort(), [...CLIENT_PAYMENT_REQUEST_FIELDS].sort());
    // A fully populated request produces every allow-listed key and no other.
    assert.deepEqual(Object.keys(toClientPaymentRequest(FULL_REQUEST)).sort(), [...CLIENT_PAYMENT_REQUEST_FIELDS].sort());
  });

  test("the mapper output is exactly the documented client view", () => {
    assert.deepEqual(toClientPaymentRequest(STORED as PaymentRequest), {
      id: FULL_ID,
      applicationId: APP_A,
      agentId: "prof-agent-a",
      agencyId: "agency-a",
      clientId: clientNg.uid,
      clientName: "Ngozi Client",
      clientEmail: "delivered+client-ng@resend.dev",
      amount: PRICE_USD_CENTS,
      currency: "USD",
      description: "Visa Processing Fee",
      category: "visa_fee",
      status: "approved",
      priceUsdCents: PRICE_USD_CENTS,
      chargedCurrency: "NGN",
      chargedAmountMinor: CHARGED_KOBO,
      effectiveRate: EFFECTIVE_RATE,
      quoteLockedAt: at(0),
      quoteExpiresAt: at(30),
      legacy: false,
      priceUsd: { amountMinor: PRICE_USD_CENTS, currency: "USD" },
      charge: { amountMinor: CHARGED_KOBO, currency: "NGN" },
      amountDisplay: `USD 6.00 (NGN ${(CHARGED_KOBO / 100).toLocaleString("en-US", { minimumFractionDigits: 2 })})`,
      paystackReference: CURRENT_REF,
      checkoutUrl: `https://checkout.paystack.test/${CURRENT_REF}`,
      paidAt: at(3),
      cancelledAt: at(4),
      expiresAt: at(5),
      approvedAt: at(6),
      rejectedAt: at(7),
      rejectionReason: "Too much",
      createdAt: at(1),
      updatedAt: at(2),
    });
  });

  test("no hidden field, nested field, undeclared field or marker value is in the mapper output", () => {
    assertNoLeak(toClientPaymentRequest(STORED as PaymentRequest), CLIENT_PAYMENT_REQUEST_FIELDS);
  });

  test("the effective rate is the amount charged ÷ the dollar price, markup included", () => {
    const view = toClientPaymentRequest(STORED as PaymentRequest);
    // ₦1,320.95 raw + 2.5% = ₦1,353.97 per $1 (to the kobo).
    assert.equal(view.effectiveRate!.toFixed(2), "1353.97");
    assert.equal(view.effectiveRate!.toFixed(2), (RAW_RATE * (1 + MARGIN_BPS / 10_000)).toFixed(2));
    assert.notEqual(view.effectiveRate!.toFixed(2), RAW_RATE.toFixed(2));
    // The same figure the client can work out from `charge` and `priceUsd`.
    assert.equal(view.effectiveRate, Math.round((view.charge!.amountMinor / view.priceUsd!.amountMinor) * 1e6) / 1e6);
  });

  test("the display fields are the same ones every caller gets (requestChargeSummary)", () => {
    const client = toClientPaymentRequest(STORED as PaymentRequest) as any;
    const full = presentPaymentRequest(STORED as PaymentRequest) as any;
    for (const key of ["legacy", "priceUsd", "charge", "amountDisplay"]) {
      assert.deepEqual(client[key], full[key], key);
    }
  });

  test("the fields the mobile app reads are all still there (seli-mobile PaymentRequest)", () => {
    const view = toClientPaymentRequest(STORED as PaymentRequest) as any;
    for (const key of [
      "id", "applicationId", "agentId", "agencyId", "clientId", "clientName", "clientEmail", "amount", "currency",
      "priceUsd", "legacy", "charge", "amountDisplay", "priceUsdCents", "chargedCurrency", "chargedAmountMinor",
      "description", "category", "status", "paidAt", "cancelledAt", "expiresAt", "approvedAt", "rejectedAt",
      "rejectionReason", "paystackReference", "createdAt", "updatedAt",
    ]) {
      assert.notEqual(view[key], undefined, `${key} is missing from the client view`);
    }
  });

  test("a pending dollar request (not priced yet) and a legacy naira request map without a rate", () => {
    const pending = {
      id: "pr-pending", applicationId: APP_A, agentId: "prof-agent-a", clientId: clientNg.uid,
      clientName: "Ngozi Client", clientEmail: "delivered+client-ng@resend.dev",
      priceUsd: { amountMinor: 15_000, currency: "USD" }, amount: 15_000, currency: "USD",
      description: "Visa Processing Fee", category: "other", status: "pending", createdAt: at(1), updatedAt: at(1),
    } as unknown as PaymentRequest;
    const { priceUsd, ...rest } = pending as any;
    assert.deepEqual(toClientPaymentRequest(pending), {
      ...rest, legacy: false, priceUsd, charge: null, amountDisplay: "USD 150.00",
    });

    const legacy = {
      id: "pr-legacy", applicationId: APP_A, agentId: "prof-agent-a", clientId: clientNg.uid,
      clientName: "Ngozi Client", clientEmail: "delivered+client-ng@resend.dev",
      amount: 2_500_000, currency: "NGN", description: "Document Authentication Fee", category: "other",
      status: "pending", createdAt: at(1), updatedAt: at(1),
    } as unknown as PaymentRequest;
    assert.deepEqual(toClientPaymentRequest(legacy), {
      ...legacy, legacy: true, priceUsd: null,
      charge: { amountMinor: 2_500_000, currency: "NGN" }, amountDisplay: "NGN 25,000.00",
    });
  });
});

// ============================================
// Who gets which view
// ============================================

describe("seesFullPaymentRequest: only the agent side gets the stored request (issue #332)", () => {
  const request = { clientId: clientNg.uid };

  test("the request's client, any client and an unresolved caller get the client view", () => {
    assert.equal(seesFullPaymentRequest({ uid: clientNg.uid, role: ROLES.CLIENT }, request), false);
    assert.equal(seesFullPaymentRequest({ uid: clientGh.uid, role: ROLES.CLIENT }, request), false);
    assert.equal(seesFullPaymentRequest({ uid: "uid-x", role: undefined }, request), false);
    assert.equal(seesFullPaymentRequest({ uid: undefined, role: ROLES.ADMIN }, request), false);
    assert.equal(seesFullPaymentRequest({ uid: "uid-x", role: "superuser" }, request), false);
  });

  test("an agent, owner or admin who IS the request's client is answered as its client", () => {
    for (const role of [ROLES.AGENT, ROLES.OWNER, ROLES.ADMIN]) {
      assert.equal(seesFullPaymentRequest({ uid: clientNg.uid, role }, request), false, role);
    }
  });

  test("an agent, owner or admin looking at someone else's request gets the stored document", () => {
    for (const p of [agentA, ownerA, admin]) {
      assert.equal(seesFullPaymentRequest({ uid: p.uid, role: p.role }, request), true, p.uid);
    }
  });
});

// ============================================
// Through the endpoints, as the request's client
// ============================================

describe("payment-request endpoints answer the client with the allow-list only (issue #332)", () => {
  test("GET /payment-requests?role=client: the row is the client view, nothing hidden", async () => {
    const out = await call("getPaymentRequests", clientNg, { query: { role: ROLES.CLIENT } });
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.equal(out.body.data.length, 1);
    assertNoLeak(out.body.data[0], CLIENT_PAYMENT_REQUEST_FIELDS);
    assert.deepEqual(out.body.data[0], toClientPaymentRequest(FULL_REQUEST));
    assert.equal(out.body.data[0].effectiveRate, EFFECTIVE_RATE);
  });

  // No other `role` value gives a client the stored document.
  for (const role of [undefined, ROLES.AGENT, ROLES.OWNER, ROLES.ADMIN, "superuser"]) {
    test(`GET /payment-requests role=${JSON.stringify(role)} as a client: no stored document comes back`, async () => {
      const out = await call("getPaymentRequests", clientNg, { query: role === undefined ? {} : { role } });
      // Owner / admin scopes are refused; the agent scope finds no agent profile.
      if (out.status === 200) {
        for (const row of out.body.data) assertNoLeak(row, CLIENT_PAYMENT_REQUEST_FIELDS);
      } else {
        assert.equal(out.status, 403, JSON.stringify(out.body));
        assertNoLeak(out.body);
      }
    });
  }

  test("GET /payment-requests/:id: the client view, with the effective rate", async () => {
    const out = await call("getPaymentRequest", clientNg, { params: { id: FULL_ID } });
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assertNoLeak(out.body.data, CLIENT_PAYMENT_REQUEST_FIELDS);
    assert.deepEqual(out.body.data, toClientPaymentRequest(FULL_REQUEST));
  });

  test("another client still cannot read it at all", async () => {
    const out = await call("getPaymentRequest", clientGh, { params: { id: FULL_ID } });
    assert.equal(out.status, 403);
    assert.equal(out.body.data, undefined);
  });

  test("POST /:id/checkout inside the lock: the same checkout and the client view", async () => {
    const out = await call("checkoutPaymentRequest", clientNg, { params: { id: FULL_ID } });
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.equal(out.body.data.requiresPayment, true);
    assert.equal(out.body.data.reference, CURRENT_REF);
    assertNoLeak(out.body.data);
    assertNoLeak(out.body.data.paymentRequest, CLIENT_PAYMENT_REQUEST_FIELDS);
    assert.equal(out.body.data.paymentRequest.effectiveRate, EFFECTIVE_RATE);
  });

  test("409 PAYMENT_IN_PROGRESS: `data.paymentRequest` is the client view", async () => {
    paystackRequestStatus(CURRENT_REF, FULL_ID, "ongoing");
    const out = await call("checkoutPaymentRequest", clientNg, { params: { id: FULL_ID } });
    assert.equal(out.status, 409, JSON.stringify(out.body));
    assert.equal(out.body.error, "PAYMENT_IN_PROGRESS");
    assertNoLeak(out.body);
    assertNoLeak(out.body.data.paymentRequest, CLIENT_PAYMENT_REQUEST_FIELDS);
  });

  test("409 CHECKOUT_REPLACED on verify of a superseded checkout: the client view too", async () => {
    const oldRef = FULL_REQUEST.supersededCheckouts[0].reference;
    paystackRequestStatus(oldRef, FULL_ID, "abandoned");
    const out = await call("verifyPayment", clientNg, { params: { id: FULL_ID }, body: { reference: oldRef } });
    assert.equal(out.status, 409, JSON.stringify(out.body));
    assert.equal(out.body.error, "CHECKOUT_REPLACED");
    // (The client sent this reference themselves; it is not echoed back.)
    assertNoLeak(out.body);
    assertNoLeak(out.body.data.paymentRequest, CLIENT_PAYMENT_REQUEST_FIELDS);
  });

  test("409 QUOTE_EXPIRED on verify after the lock: re-priced, and the new request is the client view", async () => {
    harness.clock.advanceHours(1); // past the 30-minute lock
    paystackRequestStatus(CURRENT_REF, FULL_ID, "abandoned");
    const out = await call("verifyPayment", clientNg, { params: { id: FULL_ID }, body: { reference: CURRENT_REF } });
    assert.equal(out.status, 409, JSON.stringify(out.body));
    assert.equal(out.body.error, "QUOTE_EXPIRED");
    assertNoLeak(out.body.data.paymentRequest, CLIENT_PAYMENT_REQUEST_FIELDS);
    // The stored request now has TWO superseded checkouts; none reaches the client.
    assert.equal(storedDoc(FULL_ID).supersededCheckouts.length, 2);
    assert.equal(JSON.stringify(out.body).includes("supersededCheckouts"), false);
    assert.equal(JSON.stringify(out.body).includes("fxMarginBps"), false);
    assert.equal(JSON.stringify(out.body).includes("fxRate"), false);
  });

  test("POST /:id/verify (paid): the settled request as the client view", async () => {
    paystackPaidRequest(CURRENT_REF, FULL_ID, { amountMinor: CHARGED_KOBO, currency: "NGN" });
    const out = await call("verifyPayment", clientNg, { params: { id: FULL_ID }, body: { reference: CURRENT_REF } });
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.equal(out.body.data.status, "paid");
    assertNoLeak(out.body.data, CLIENT_PAYMENT_REQUEST_FIELDS);
    assert.equal(out.body.data.effectiveRate, EFFECTIVE_RATE);
    // A second verify of the same reference ("already completed") too.
    const again = await call("verifyPayment", clientNg, { params: { id: FULL_ID }, body: { reference: CURRENT_REF } });
    assert.equal(again.status, 200, JSON.stringify(again.body));
    assertNoLeak(again.body.data, CLIENT_PAYMENT_REQUEST_FIELDS);
  });

  test("POST /:id/verify (not paid, inside the lock): the client view plus Paystack's status", async () => {
    paystackRequestStatus(CURRENT_REF, FULL_ID, "abandoned");
    const out = await call("verifyPayment", clientNg, { params: { id: FULL_ID }, body: { reference: CURRENT_REF } });
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.equal(out.body.data.paymentStatus, "abandoned");
    assertNoLeak(out.body.data, [...CLIENT_PAYMENT_REQUEST_FIELDS, "paymentStatus"]);
  });

  test("PUT /:id/reject: the rejected request as the client view", async () => {
    (messagingService as any).getOrCreateConversation = async () => ({ id: "conv-1" });
    (messagingService as any).sendMessage = async () => undefined;
    await seed("paymentRequests", FULL_ID, { ...STORED, status: "pending" });
    const out = await call("rejectPaymentRequest", clientNg, { params: { id: FULL_ID }, body: { reason: "Not now" } });
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.equal(out.body.data.status, "rejected");
    assertNoLeak(out.body.data, [...CLIENT_PAYMENT_REQUEST_FIELDS, "conversationId"]);
  });
});

// ============================================
// A request priced with a real markup, through approve
// ============================================

describe("a request priced with a 2.5% markup never shows it to the client (issue #332)", () => {
  /** Re-make the harness rate service with a 2.5% default margin and the raw rate. */
  function useMarkup(): void {
    const { service, store: rates } = makeService({
      config: { ...HARNESS_CONFIG, defaultMarginBps: MARGIN_BPS },
      clock: harness.clock,
    });
    harness.rateStore = rates;
    const now = harness.clock.now();
    rates.docs.set("NGN", {
      currency: "NGN",
      provider: { rate: RAW_RATE, asOf: now, fetchedAt: now, source: "cbn" },
      override: null,
      lastError: null,
    } as any);
    consultationCharging.rates = async () => service;
  }

  test("PUT /:id/approve: charged with the markup, answered without it", async () => {
    useMarkup();
    // The agent asks for $6.00.
    const created = captureRes();
    await paymentRequestController.createPaymentRequest(
      reqFor(agentA, { body: { applicationId: APP_A, amount: "6.00", description: "Courier Fee" } }),
      created.res
    );
    assert.equal(created.out.status, 201, JSON.stringify(created.out.body));
    const id = created.out.body.data.id;

    const out = await call("approvePaymentRequest", clientNg, { params: { id } });
    assert.equal(out.status, 200, JSON.stringify(out.body));
    const data = out.body.data;
    // The stored request really carries the markup and the raw rate ...
    assert.equal(storedDoc(id).fxMarginBps, MARGIN_BPS);
    assert.equal(storedDoc(id).fxRate, RAW_RATE);
    assert.equal(storedDoc(id).chargedAmountMinor, CHARGED_KOBO);
    // ... and the answer carries neither, by key or by value.
    assertNoLeak(data, [...CLIENT_PAYMENT_REQUEST_FIELDS, "authorizationUrl"]);
    for (const key of ["fxRate", "fxRateAsOf", "fxRateSource", "fxMarginBps", "supersededCheckouts"]) {
      assert.equal(key in data, false, key);
    }
    // The client gets the effective rate: "$6.00 at ₦1,353.97 per $1".
    assert.deepEqual(data.charge, { amountMinor: CHARGED_KOBO, currency: "NGN" });
    assert.equal(data.effectiveRate, EFFECTIVE_RATE);
    assert.equal(data.effectiveRate.toFixed(2), "1353.97");
    assert.ok(data.authorizationUrl && data.paystackReference);
  });
});

// ============================================
// Agents, owners and admins: the full document, as before
// ============================================

describe("payment-request endpoints still answer the agent side with the full document (issue #332)", () => {
  /** What every caller got before #332: the stored fields plus the display fields. */
  const full = presentPaymentRequest(STORED as PaymentRequest);

  const scopes: [string, AuthzSubject, Record<string, unknown>][] = [
    ["agent, no role", agentA, {}],
    ["agent, role=agent", agentA, { role: ROLES.AGENT }],
    ["owner, role=owner", ownerA, { role: ROLES.OWNER }],
    ["admin, role=admin", admin, { role: ROLES.ADMIN }],
  ];
  for (const [name, who, query] of scopes) {
    test(`GET /payment-requests as ${name}: every stored field is returned unchanged`, async () => {
      const out = await call("getPaymentRequests", who, { query });
      assert.equal(out.status, 200, JSON.stringify(out.body));
      assert.deepEqual(out.body.data, [full]);
      // Spot checks on what the client view drops.
      assert.equal(out.body.data[0].fxMarginBps, MARGIN_BPS);
      assert.equal(out.body.data[0].fxRate, RAW_RATE);
      assert.equal(out.body.data[0].supersededCheckouts[0].fxMarginBps, 275);
      // And nothing was added to it.
      assert.equal("effectiveRate" in out.body.data[0], false);
    });
  }

  for (const [name, who] of [["the requesting agent", agentA], ["the agency's owner", ownerA], ["an admin", admin]] as const) {
    test(`GET /payment-requests/:id as ${name}: the full document`, async () => {
      const out = await call("getPaymentRequest", who, { params: { id: FULL_ID } });
      assert.equal(out.status, 200, JSON.stringify(out.body));
      assert.deepEqual(out.body.data, full);
    });
  }

  test("an admin resuming the checkout for the client still gets the full document", async () => {
    const out = await call("checkoutPaymentRequest", admin, { params: { id: FULL_ID } });
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.deepEqual(out.body.data.paymentRequest, full);
  });

  test("POST /payment-requests by the agent: the created request as before (no client-only field)", async () => {
    const { out, res } = captureRes();
    await paymentRequestController.createPaymentRequest(
      reqFor(agentA, { body: { applicationId: APP_A, amount: "150.00", description: "Visa Processing Fee" } }),
      res
    );
    assert.equal(out.status, 201, JSON.stringify(out.body));
    assert.deepEqual(out.body.data, presentPaymentRequest(storedDoc(out.body.data.id)));
    assert.equal("effectiveRate" in out.body.data, false);
  });
});
