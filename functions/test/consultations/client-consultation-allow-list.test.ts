// ============================================
// Unit tests — issue #332: a client's view of a consultation is an allow-list
// ============================================
//
// #329 closed the leak on GET /transactions. The consultation endpoints
// still answered the booking's client with the whole stored document:
// Seli's exchange-rate markup (`fxMarginBps`), the raw rate it is added to
// (`fxRate`, `fxRateAsOf`, `fxRateSource`) and `supersededCheckouts` (every
// replaced checkout, each with its own raw rate and markup).
//
// The contract checked here:
//  - a client gets `ClientConsultation`, whose keys are ONLY the ones in
//    CLIENT_CONSULTATION_FIELDS, from every consultation route that can
//    answer a client: list, detail, create (201 and the resumed 200), status
//    change, checkout, verify, the guest booking, and the 409 bodies that
//    carry `data.consultation` (PAYMENT_IN_PROGRESS, CHECKOUT_REPLACED,
//    CHECKOUT_OPENING all use the same `bookingSummary`);
//  - nothing hidden reaches a response, by key OR by value (each response
//    is searched for a marker value planted in every hidden field);
//  - the client gets the EFFECTIVE rate instead (`effectiveRate` = amount
//    charged ÷ dollar price, markup included): "$6.00 at ₦1,353.97 per $1";
//  - the guard against future leaks, in three layers (as in #329):
//      1. `FULL_BOOKING` is typed `Required<Consultation>`, so a field added
//         to the `Consultation` type does not COMPILE here until it is added
//         to the fixture (`npm test` type-checks the tests first);
//      2. every key of that fixture must then be classified, as shown to
//         clients (SHOWN_FROM) or hidden (HIDDEN_FIELDS); an unclassified
//         key fails "every stored field is classified";
//      3. a field nobody declared at all (written straight to Firestore)
//         still cannot leak, because the mapper copies named fields only;
//  - agents, owners and admins still get the full stored document.
//
// Runs on the in-memory Firestore of the consultation harness: no emulator,
// no network, no Paystack.
import { test, describe, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Timestamp } from "firebase-admin/firestore";
import { defineAbilitiesFor, ROLES } from "@durin-tech/authz";
import type { AuthzSubject } from "@durin-tech/authz";

import {
  useHarness,
  harness,
  captureRes,
  docsIn,
  seed,
  paystackPaid,
  paystackStatus,
  HARNESS_CONFIG,
  NOW_ISO,
  T0,
} from "./harness";
import { makeService } from "../money/helpers";
import { consultationController } from "../../src/controllers/consultation.controller";
import { bookingSummary, consultationCharging } from "../../src/services/consultation-charge.service";
import {
  CLIENT_CONSULTATION_FIELDS,
  consultationFor,
  seesFullConsultation,
  toClientConsultation,
} from "../../src/consultations/client-consultation";
import { CLIENT_CHARGE_FIELDS, clientChargeFields, effectiveRateOf } from "../../src/money/client-charge";
import { convertUsdToLocal, makeMoney } from "../../src/money/money";
import type { Consultation } from "../../src/types";

/* eslint-disable @typescript-eslint/no-explicit-any */

// ============================================
// Principals (as verifyAuth leaves them)
// ============================================

/** The booking's client. */
const client: AuthzSubject = { uid: "uid-client1", role: ROLES.CLIENT, agencyId: null };
/** Another client (no part in the booking). */
const otherClient: AuthzSubject = { uid: "uid-client2", role: ROLES.CLIENT, agencyId: null };
/** The booking's agent (a member of agency A). */
const agent: AuthzSubject = { uid: "uid-agent1", role: ROLES.AGENT, agencyId: "agency-a" };
/** The owner of the booking's agency. */
const ownerA: AuthzSubject = { uid: "uid-owner-a", role: ROLES.OWNER, agencyId: "agency-a" };
/** A platform admin. */
const admin: AuthzSubject = { uid: "uid-admin", role: ROLES.ADMIN, agencyId: null };

/** A request for `p`, as the auth middleware leaves it. */
function reqFor(p: AuthzSubject, extra: Record<string, unknown> = {}): any {
  return { userId: p.uid, authz: p, ability: defineAbilitiesFor(p), entitlements: null, query: {}, params: {}, body: {}, ...extra };
}

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
// A stored booking with EVERY Consultation field set
// ============================================
//
// `Required<Consultation>`: adding a field to the Consultation type breaks
// the build of this file until the field is added here, and then the
// classification test below makes the author say whether clients see it.
// Hidden fields hold marker values ("HIDDEN-...", odd numbers) that appear
// nowhere else, so a response can be searched for them.

const FULL_ID = "c-full";

const FULL_BOOKING: Required<Consultation> = {
  id: FULL_ID,
  // ---- Shown to the client ----
  userId: client.uid,
  agentId: agent.uid,
  agencyId: "agency-a",
  applicationId: "app-1",
  clientName: "Chi Client",
  clientEmail: "delivered+client1@resend.dev",
  agentName: "Ada Agent",
  type: "initial",
  scheduledDate: at(24 * 60),
  scheduledTime: "10:00",
  durationMinutes: 30,
  timezone: "Africa/Lagos",
  status: "pending_payment",
  meetingLink: "https://meet.example.test/full",
  meetingPlatform: "google_meet",
  priceUsdCents: PRICE_USD_CENTS,
  chargedCurrency: "NGN",
  chargedAmountMinor: CHARGED_KOBO,
  quoteLockedAt: at(0),
  quoteExpiresAt: at(30),
  fee: 7_777,
  paymentStatus: "pending",
  transactionId: "cons-c-full-current",
  checkoutUrl: "https://checkout.paystack.test/cons-c-full-current",
  paidAt: at(3),
  summary: "We went through the document list.",
  recordingUrl: "https://recordings.example.test/full",
  cancelledAt: at(4),
  cancellationReason: "Travel moved",
  createdAt: at(1),
  updatedAt: at(2),
  // ---- Hidden from the client ----
  fxRate: RAW_RATE,
  fxRateAsOf: Timestamp.fromMillis(1_711_111_111_000),
  fxRateSource: "hold",
  fxMarginBps: MARGIN_BPS,
  bookedVia: "public_page",
  checkoutCallbackUrl: "https://HIDDEN-callback.example.test/return",
  paystackPaidAt: Timestamp.fromMillis(1_722_222_222_000),
  paidAfterQuoteExpiry: true,
  paidOnSupersededReference: true,
  // Issue #405: the sweep's payment-grace clock after a reschedule (internal).
  paymentGraceStartsAt: Timestamp.fromMillis(1_755_555_555_000),
  supersededCheckouts: [
    {
      reference: "HIDDEN-superseded-reference",
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
  cancelledBy: "HIDDEN-cancelling-user-uid",
  // Issue #317: the refund row's id is internal; its status is shown.
  refundId: "HIDDEN-refund-row-id",
  refundStatus: "processing",
  // Issue #413: the booking's mirror of a HELD refund's reason (hidden: the
  // client reads `refundStatus`, and the transaction's `refundState`).
  refundHeldReason: "fee_not_less_than_amount",
};

/**
 * Stored fields a client is shown, and the response key each one feeds.
 * Every response key in CLIENT_CONSULTATION_FIELDS must be fed by one of
 * them (`effectiveRate` is fed by the two amounts it is divided from).
 */
const SHOWN_FROM: Partial<Record<keyof Consultation, readonly string[]>> = {
  id: ["id"],
  userId: ["userId"],
  agentId: ["agentId"],
  agencyId: ["agencyId"],
  applicationId: ["applicationId"],
  clientName: ["clientName"],
  clientEmail: ["clientEmail"],
  agentName: ["agentName"],
  type: ["type"],
  scheduledDate: ["scheduledDate"],
  scheduledTime: ["scheduledTime"],
  durationMinutes: ["durationMinutes"],
  timezone: ["timezone"],
  status: ["status"],
  meetingLink: ["meetingLink"],
  meetingPlatform: ["meetingPlatform"],
  priceUsdCents: ["priceUsdCents", "effectiveRate"],
  chargedCurrency: ["chargedCurrency", "effectiveRate"],
  chargedAmountMinor: ["chargedAmountMinor", "effectiveRate"],
  quoteLockedAt: ["quoteLockedAt"],
  quoteExpiresAt: ["quoteExpiresAt"],
  fee: ["fee"],
  paymentStatus: ["paymentStatus"],
  transactionId: ["transactionId"],
  checkoutUrl: ["checkoutUrl"],
  paidAt: ["paidAt"],
  summary: ["summary"],
  recordingUrl: ["recordingUrl"],
  cancelledAt: ["cancelledAt"],
  cancellationReason: ["cancellationReason"],
  // Issue #317: where the refund stands (no ids).
  refundStatus: ["refundStatus"],
  createdAt: ["createdAt"],
  updatedAt: ["updatedAt"],
};

/**
 * Stored fields a client must NEVER receive. A new Consultation field goes
 * here unless there is a decision to show it (then: SHOWN_FROM, the mapper
 * and CLIENT_CONSULTATION_FIELDS, all three).
 */
const HIDDEN_FIELDS: readonly (keyof Consultation)[] = [
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
  // Issue #405: when the sweep's 24-hour payment grace restarted (internal clock).
  "paymentGraceStartsAt",
  // Internal: how it was booked, and the uid of whoever cancelled it.
  "bookedVia",
  "cancelledBy",
  // Issue #317: the refund row id (`refund_<Paystack reference>`).
  "refundId",
  // Issue #413: internal reason a refund is held for an admin.
  "refundHeldReason",
];

/** Marker values that must not appear anywhere in a client response. */
const HIDDEN_VALUES: readonly string[] = [
  "HIDDEN", // every marker string starts with it
  String(RAW_RATE), // 1320.95, the raw rate
  "1318.47", // the superseded checkout's raw rate
  "811111", // the superseded checkout's amount
  "1711111111", // fxRateAsOf seconds
  "1722222222", // paystackPaidAt seconds
  "1733333333", // supersededAt seconds
  "1744444444", // the superseded checkout's fxRateAsOf seconds
  "hold", // fxRateSource
  "public_page", // bookedVia
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

/** The booking as stored: every declared field plus the undeclared ones. */
const STORED = { ...FULL_BOOKING, ...UNDECLARED };

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

/** The extra keys the create / resume answers add next to the booking. */
const CREATE_EXTRAS = ["requiresPayment", "authorizationUrl", "reference", "resumed"];
/** The keys of the payer-safe `bookingSummary`. */
const SUMMARY_KEYS = [
  "id", "agentName", "type", "scheduledDate", "scheduledTime", "timezone", "status", "paymentStatus",
  "priceUsdCents", "chargedCurrency", "chargedAmountMinor", "effectiveRate", "quoteExpiresAt",
];

before(async () => {
  await useHarness();
});
beforeEach(async () => {
  harness.reset();
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  console.log = () => {};
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  console.error = () => {};
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  console.warn = () => {};
  // The people of the booking, and the fully populated booking as stored.
  await seed("users", client.uid, { email: "delivered+client1@resend.dev", firstName: "Chi", lastName: "Client", createdAt: T0 });
  await seed("agents", "agent1", {
    userId: agent.uid, agencyId: "agency-a", displayName: "Ada Agent", verificationStatus: "verified", isAvailable: true,
    consultationFeeUsd: { amountMinor: PRICE_USD_CENTS, currency: "USD" }, createdAt: T0,
  });
  // The agent's agency must be approved for a client to book them.
  await seed("agencies", "agency-a", { name: "Agency A", status: "approved", ownerId: ownerA.uid, createdAt: T0 });
  await seed("consultations", FULL_ID, STORED);
});

// ============================================
// The effective rate
// ============================================

describe("effectiveRateOf: amount charged ÷ dollar price (issue #332)", () => {
  test("$6.00 charged as naira at ₦1,320.95 + 2.5% is ₦1,353.97 per $1", () => {
    const rate = effectiveRateOf(FULL_BOOKING)!;
    assert.equal(rate, EFFECTIVE_RATE);
    // What the pay screen shows: "$6.00 at ₦1,353.97 per $1".
    assert.equal(rate.toFixed(2), "1353.97");
    // It includes the markup: it is the raw rate x 1.025, to the kobo ...
    assert.equal(rate.toFixed(2), (RAW_RATE * (1 + MARGIN_BPS / 10_000)).toFixed(2));
    // ... and it is NOT the raw rate.
    assert.notEqual(rate.toFixed(2), RAW_RATE.toFixed(2));
  });

  test("it reads only the two stored amounts: the raw rate and the margin change nothing", () => {
    const base = { priceUsdCents: 600, chargedCurrency: "NGN", chargedAmountMinor: 812_382 };
    const withOtherRate = { ...base, fxRate: 9_999, fxMarginBps: 9_999 };
    assert.equal(effectiveRateOf(base), 1353.97);
    assert.equal(effectiveRateOf(withOtherRate), 1353.97);
  });

  test("a charge in dollars is 1; a zero-decimal currency uses its own minor unit", () => {
    assert.equal(effectiveRateOf({ priceUsdCents: 600, chargedCurrency: "USD", chargedAmountMinor: 600 }), 1);
    // USh 22,500 for $6.00: UGX has no minor unit, so 22,500 / 6 = 3,750.
    assert.equal(effectiveRateOf({ priceUsdCents: 600, chargedCurrency: "UGX", chargedAmountMinor: 22_500 }), 3750);
    // GH₵ 92.25 for $6.00 = 15.375 per $1.
    assert.equal(effectiveRateOf({ priceUsdCents: 600, chargedCurrency: "GHS", chargedAmountMinor: 9_225 }), 15.375);
  });

  test("it is rounded half up to 6 decimals", () => {
    // 100,000 kobo / 300 cents = 333.3333333... -> 333.333333
    assert.equal(effectiveRateOf({ priceUsdCents: 300, chargedCurrency: "NGN", chargedAmountMinor: 100_000 }), 333.333333);
    // 200,000 kobo / 300 cents = 666.6666666... -> 666.666667
    assert.equal(effectiveRateOf({ priceUsdCents: 300, chargedCurrency: "NGN", chargedAmountMinor: 200_000 }), 666.666667);
  });

  // Nothing to divide, or not money: no rate at all (never NaN, Infinity or 0).
  const unusable: [string, Record<string, unknown>][] = [
    ["a free booking", { priceUsdCents: 0 }],
    ["a zero dollar price", { priceUsdCents: 0, chargedCurrency: "NGN", chargedAmountMinor: 1_000 }],
    ["a zero charge", { priceUsdCents: 600, chargedCurrency: "NGN", chargedAmountMinor: 0 }],
    ["no currency", { priceUsdCents: 600, chargedAmountMinor: 1_000 }],
    ["an unknown currency", { priceUsdCents: 600, chargedCurrency: "ZZZ", chargedAmountMinor: 1_000 }],
    ["a string amount", { priceUsdCents: 600, chargedCurrency: "NGN", chargedAmountMinor: "1000" }],
    ["a fractional price", { priceUsdCents: 6.5, chargedCurrency: "NGN", chargedAmountMinor: 1_000 }],
    ["a legacy booking", { fee: 5_000 }],
  ];
  for (const [name, record] of unusable) {
    test(`${name} has no effective rate`, () => {
      assert.equal(effectiveRateOf(record as any), undefined);
      assert.equal("effectiveRate" in clientChargeFields(record as any), false);
    });
  }

  test("clientChargeFields gives exactly the payer-safe fields of a full snapshot", () => {
    assert.deepEqual(clientChargeFields(STORED as any), {
      priceUsdCents: PRICE_USD_CENTS,
      chargedCurrency: "NGN",
      chargedAmountMinor: CHARGED_KOBO,
      effectiveRate: EFFECTIVE_RATE,
      quoteLockedAt: at(0),
      quoteExpiresAt: at(30),
    });
    assert.deepEqual(Object.keys(clientChargeFields(STORED as any)), [...CLIENT_CHARGE_FIELDS]);
  });
});

// ============================================
// The allow-list itself
// ============================================

describe("client consultation allow-list (issue #332)", () => {
  test("every stored field is classified as shown or hidden (a new field must be decided)", () => {
    const shown = Object.keys(SHOWN_FROM);
    const hidden = HIDDEN_FIELDS as readonly string[];
    for (const key of Object.keys(FULL_BOOKING)) {
      assert.ok(
        shown.includes(key) !== hidden.includes(key),
        `Consultation.${key} must be in exactly one of SHOWN_FROM or HIDDEN_FIELDS. ` +
          "A new field is hidden from clients unless it is deliberately added to toClientConsultation."
      );
    }
    // And nothing is classified that the type no longer has.
    for (const key of [...shown, ...hidden]) assert.ok(key in FULL_BOOKING, `${key} is not a Consultation field`);
  });

  test("the response keys are exactly the allow-list, each fed by a field marked as shown", () => {
    const fed = new Set(Object.values(SHOWN_FROM).flat());
    assert.deepEqual([...fed].sort(), [...CLIENT_CONSULTATION_FIELDS].sort());
    // A fully populated booking produces every allow-listed key and no other.
    assert.deepEqual(Object.keys(toClientConsultation(FULL_BOOKING)).sort(), [...CLIENT_CONSULTATION_FIELDS].sort());
  });

  test("the mapper output is exactly the documented client view", () => {
    assert.deepEqual(toClientConsultation(STORED as Consultation), {
      id: FULL_ID,
      userId: client.uid,
      agentId: agent.uid,
      agencyId: "agency-a",
      applicationId: "app-1",
      clientName: "Chi Client",
      clientEmail: "delivered+client1@resend.dev",
      agentName: "Ada Agent",
      type: "initial",
      scheduledDate: at(24 * 60),
      scheduledTime: "10:00",
      durationMinutes: 30,
      timezone: "Africa/Lagos",
      status: "pending_payment",
      meetingLink: "https://meet.example.test/full",
      meetingPlatform: "google_meet",
      priceUsdCents: PRICE_USD_CENTS,
      chargedCurrency: "NGN",
      chargedAmountMinor: CHARGED_KOBO,
      effectiveRate: EFFECTIVE_RATE,
      quoteLockedAt: at(0),
      quoteExpiresAt: at(30),
      fee: 7_777,
      paymentStatus: "pending",
      transactionId: "cons-c-full-current",
      checkoutUrl: "https://checkout.paystack.test/cons-c-full-current",
      paidAt: at(3),
      summary: "We went through the document list.",
      recordingUrl: "https://recordings.example.test/full",
      cancelledAt: at(4),
      cancellationReason: "Travel moved",
      // Issue #317: the refund's status (its id stays hidden).
      refundStatus: "processing",
      createdAt: at(1),
      updatedAt: at(2),
    });
  });

  test("no hidden field, nested field, undeclared field or marker value is in the mapper output", () => {
    assertNoLeak(toClientConsultation(STORED as Consultation), CLIENT_CONSULTATION_FIELDS);
  });

  test("the fields the mobile app reads are all still there (seli-mobile ApiConsultation)", () => {
    const view = toClientConsultation(STORED as Consultation) as any;
    for (const key of [
      "id", "userId", "agentId", "agentName", "clientName", "clientEmail", "agencyId", "applicationId", "status",
      "type", "scheduledDate", "scheduledTime", "durationMinutes", "timezone", "priceUsdCents", "chargedCurrency",
      "chargedAmountMinor", "quoteLockedAt", "quoteExpiresAt", "paymentStatus", "summary", "recordingUrl",
      "createdAt", "updatedAt",
    ]) {
      assert.notEqual(view[key], undefined, `${key} is missing from the client view`);
    }
    // The ONE field the app read that is gone: the raw rate. Its replacement:
    assert.equal(view.fxRate, undefined);
    assert.equal(view.effectiveRate, EFFECTIVE_RATE);
  });

  test("a free booking and a legacy booking map without a rate", () => {
    const base = {
      id: "c-x", userId: client.uid, agentId: agent.uid, clientName: "Chi Client",
      clientEmail: "delivered+client1@resend.dev", agentName: "Ada Agent", type: "initial", scheduledDate: at(60),
      scheduledTime: "10:00", durationMinutes: 30, timezone: "Africa/Lagos", status: "scheduled",
      paymentStatus: "paid", createdAt: at(1), updatedAt: at(1),
    };
    // Free: only the zero dollar price.
    assert.deepEqual(toClientConsultation({ ...base, priceUsdCents: 0 } as unknown as Consultation), { ...base, priceUsdCents: 0 });
    // Legacy: only the naira fee.
    assert.deepEqual(toClientConsultation({ ...base, fee: 5_000 } as unknown as Consultation), { ...base, fee: 5_000 });
  });

  test("bookingSummary (checkout, verify and every 409 body) is payer-safe and carries the effective rate", () => {
    const summary = bookingSummary(STORED as Consultation);
    assertNoLeak(summary, SUMMARY_KEYS);
    assert.deepEqual(summary, {
      id: FULL_ID,
      agentName: "Ada Agent",
      type: "initial",
      scheduledDate: at(24 * 60),
      scheduledTime: "10:00",
      timezone: "Africa/Lagos",
      status: "pending_payment",
      paymentStatus: "pending",
      priceUsdCents: PRICE_USD_CENTS,
      chargedCurrency: "NGN",
      chargedAmountMinor: CHARGED_KOBO,
      effectiveRate: EFFECTIVE_RATE,
      quoteExpiresAt: at(30),
    });
  });
});

// ============================================
// Who gets which view
// ============================================

describe("seesFullConsultation: only the agent side gets the stored booking (issue #332)", () => {
  const booking = { userId: client.uid };

  test("the booking's client, any client and an unresolved caller get the client view", () => {
    assert.equal(seesFullConsultation({ uid: client.uid, role: ROLES.CLIENT }, booking), false);
    assert.equal(seesFullConsultation({ uid: otherClient.uid, role: ROLES.CLIENT }, booking), false);
    assert.equal(seesFullConsultation({ uid: "uid-x", role: undefined }, booking), false);
    assert.equal(seesFullConsultation({ uid: undefined, role: ROLES.ADMIN }, booking), false);
    assert.equal(seesFullConsultation({ uid: "uid-x", role: "superuser" }, booking), false);
  });

  test("an agent, owner or admin who IS the booking's client is answered as its client", () => {
    for (const role of [ROLES.AGENT, ROLES.OWNER, ROLES.ADMIN]) {
      assert.equal(seesFullConsultation({ uid: client.uid, role }, booking), false, role);
      assertNoLeak(consultationFor({ uid: client.uid, role }, STORED as Consultation), CLIENT_CONSULTATION_FIELDS);
    }
  });

  test("an agent, owner or admin looking at someone else's booking gets the stored document", () => {
    for (const p of [agent, ownerA, admin]) {
      assert.equal(seesFullConsultation({ uid: p.uid, role: p.role }, booking), true, p.uid);
      assert.equal(consultationFor({ uid: p.uid, role: p.role }, STORED as Consultation), STORED);
    }
  });
});

// ============================================
// Through the endpoints, as the booking's client
// ============================================

describe("consultation endpoints answer the client with the allow-list only (issue #332)", () => {
  // Every `role` a client can send: the rows that come back are client views.
  const roleValues: unknown[] = [ROLES.CLIENT, undefined, ROLES.AGENT, "superuser"];
  for (const role of roleValues) {
    test(`GET /consultations role=${JSON.stringify(role)}: nothing hidden in any row`, async () => {
      const { out, res } = captureRes();
      await consultationController.getConsultations(reqFor(client, { query: role === undefined ? {} : { role } }), res);
      assert.equal(out.status, 200, JSON.stringify(out.body));
      for (const row of out.body.data) assertNoLeak(row, CLIENT_CONSULTATION_FIELDS);
      // `role=client` is the client's own list: the booking is in it.
      if (role === ROLES.CLIENT) {
        assert.deepEqual(out.body.data, [toClientConsultation(FULL_BOOKING)]);
      }
    });
  }

  test("GET /consultations with a caller that has no resolved principal still leaks nothing", async () => {
    const { out, res } = captureRes();
    const req = reqFor(client, { query: { role: ROLES.CLIENT } });
    delete req.authz;
    await consultationController.getConsultations(req, res);
    assert.equal(out.body.data.length, 1);
    assertNoLeak(out.body.data[0], CLIENT_CONSULTATION_FIELDS);
  });

  test("GET /consultations/:id: the client view, with the effective rate", async () => {
    const { out, res } = captureRes();
    await consultationController.getConsultation(reqFor(client, { params: { id: FULL_ID } }), res);
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assertNoLeak(out.body.data, CLIENT_CONSULTATION_FIELDS);
    assert.deepEqual(out.body.data, toClientConsultation(FULL_BOOKING));
    assert.equal(out.body.data.effectiveRate.toFixed(2), "1353.97");
  });

  test("PUT /consultations/:id/status: a client cancelling gets the client view back", async () => {
    await seed("consultations", FULL_ID, { ...STORED, status: "scheduled", paymentStatus: "paid" });
    const { out, res } = captureRes();
    await consultationController.updateStatus(
      reqFor(client, { params: { id: FULL_ID }, body: { status: "cancelled", cancellationReason: "Plans changed" } }),
      res
    );
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.equal(out.body.data.status, "cancelled");
    // Issue #317: every cancel answer also carries the refund outcome
    // (`{ status, amount }` or null). Here there is no fee Transaction
    // (legacy data), so there is no refund.
    assert.equal(out.body.data.refund, null);
    assertNoLeak(out.body.data, [...CLIENT_CONSULTATION_FIELDS, "refund"]);
  });

  test("POST /consultations/:id/checkout inside the lock: the same checkout and a payer-safe summary", async () => {
    const { out, res } = captureRes();
    await consultationController.checkoutConsultation(reqFor(client, { params: { id: FULL_ID } }), res);
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.equal(out.body.data.requiresPayment, true);
    assert.equal(out.body.data.reference, "cons-c-full-current");
    assertNoLeak(out.body.data);
    assertNoLeak(out.body.data.consultation, SUMMARY_KEYS);
    assert.equal(out.body.data.consultation.effectiveRate, EFFECTIVE_RATE);
  });

  test("409 PAYMENT_IN_PROGRESS: `data.consultation` is the payer-safe summary", async () => {
    paystackStatus("cons-c-full-current", FULL_ID, "ongoing");
    const { out, res } = captureRes();
    await consultationController.checkoutConsultation(reqFor(client, { params: { id: FULL_ID } }), res);
    assert.equal(out.status, 409, JSON.stringify(out.body));
    assert.equal(out.body.error, "PAYMENT_IN_PROGRESS");
    assertNoLeak(out.body);
    assertNoLeak(out.body.data.consultation, SUMMARY_KEYS);
    assert.equal(out.body.data.consultation.effectiveRate, EFFECTIVE_RATE);
  });

  test("409 CHECKOUT_REPLACED on verify of a superseded checkout: payer-safe too", async () => {
    // The superseded reference is abandoned at Paystack; the current checkout stands.
    harness.paystack.set("HIDDEN-superseded-reference", {
      status: "abandoned",
      metadata: { purpose: "consultation", consultationId: FULL_ID },
    });
    const { out, res } = captureRes();
    await consultationController.verifyPublicConsultation({ body: { reference: "HIDDEN-superseded-reference" } } as any, res);
    assert.equal(out.status, 409, JSON.stringify(out.body));
    assert.equal(out.body.error, "CHECKOUT_REPLACED");
    assertNoLeak(out.body);
    assertNoLeak(out.body.data.consultation, SUMMARY_KEYS);
  });

  test("POST /consultations/public/verify (paid): verified, with a payer-safe summary", async () => {
    paystackPaid("cons-c-full-current", FULL_ID, { amountMinor: CHARGED_KOBO, currency: "NGN" });
    const { out, res } = captureRes();
    await consultationController.verifyPublicConsultation({ body: { reference: "cons-c-full-current" } } as any, res);
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.equal(out.body.data.verified, true);
    assert.equal(out.body.data.consultation.paymentStatus, "paid");
    assertNoLeak(out.body.data);
    assertNoLeak(out.body.data.consultation, SUMMARY_KEYS);
    assert.equal(out.body.data.consultation.effectiveRate, EFFECTIVE_RATE);
  });

  test("POST /consultations resumed (200): the booking's client view plus the checkout fields", async () => {
    const { out, res } = captureRes();
    await consultationController.createConsultation(
      reqFor(client, {
        body: {
          agentId: "agent1", type: "initial", scheduledTime: "10:00",
          // The same instant as the stored booking's slot.
          scheduledDate: at(24 * 60).toDate().toISOString(),
        },
      }),
      res
    );
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.equal(out.body.data.resumed, true);
    assert.equal(out.body.data.id, FULL_ID);
    assertNoLeak(out.body.data, [...CLIENT_CONSULTATION_FIELDS, ...CREATE_EXTRAS]);
    assert.equal(out.body.data.effectiveRate, EFFECTIVE_RATE);
    // What the mobile pay screen builds its quote from is all there.
    assert.equal(out.body.data.chargedAmountMinor, CHARGED_KOBO);
    assert.equal(out.body.data.chargedCurrency, "NGN");
    assert.equal(out.body.data.priceUsdCents, PRICE_USD_CENTS);
    assert.deepEqual(out.body.data.quoteExpiresAt, at(30));
    assert.equal(out.body.data.authorizationUrl, "https://checkout.paystack.test/cons-c-full-current");
    assert.equal(docsIn("consultations").length, 1, "no second booking");
  });
});

// ============================================
// A fresh booking priced with a real markup
// ============================================

describe("a booking priced with a 2.5% markup never shows it to the client (issue #332)", () => {
  /** Re-make the harness rate service with a 2.5% default margin and the raw rate. */
  function useMarkup(): void {
    const { service, store } = makeService({
      config: { ...HARNESS_CONFIG, defaultMarginBps: MARGIN_BPS },
      clock: harness.clock,
    });
    harness.rateStore = store;
    const now = harness.clock.now();
    store.docs.set("NGN", {
      currency: "NGN",
      provider: { rate: RAW_RATE, asOf: now, fetchedAt: now, source: "cbn" },
      override: null,
      lastError: null,
    } as any);
    consultationCharging.rates = async () => service;
  }

  /** The keys a fresh create adds next to the booking. */
  const FRESH_EXTRAS = [...CREATE_EXTRAS, "checkoutUrl", "transactionId"];

  test("POST /consultations (201): charged with the markup, answered without it", async () => {
    useMarkup();
    const { out, res } = captureRes();
    await consultationController.createConsultation(
      reqFor(client, { body: { agentId: "agent1", type: "initial", scheduledDate: "2026-12-05", scheduledTime: "11:00" } }),
      res
    );
    assert.equal(out.status, 201, JSON.stringify(out.body));
    const data = out.body.data;
    // The stored booking really carries the markup and the raw rate ...
    const stored = docsIn("consultations").find(([id]) => id === data.id)![1];
    assert.equal(stored.fxMarginBps, MARGIN_BPS);
    assert.equal(stored.fxRate, RAW_RATE);
    assert.equal(stored.chargedAmountMinor, CHARGED_KOBO);
    // ... and the answer carries neither, by key or by value.
    assertNoLeak(data, [...CLIENT_CONSULTATION_FIELDS, ...FRESH_EXTRAS]);
    for (const key of ["fxRate", "fxRateAsOf", "fxRateSource", "fxMarginBps", "supersededCheckouts"]) {
      assert.equal(key in data, false, key);
    }
    // The client gets the effective rate: "$6.00 at ₦1,353.97 per $1".
    assert.equal(data.priceUsdCents, PRICE_USD_CENTS);
    assert.equal(data.chargedAmountMinor, CHARGED_KOBO);
    assert.equal(data.effectiveRate, EFFECTIVE_RATE);
    assert.equal(data.effectiveRate.toFixed(2), "1353.97");
    assert.equal(data.requiresPayment, true);
    assert.ok(data.authorizationUrl && data.reference);
  });

  test("the guest booking (public page) answer carries the effective rate, not the raw one", async () => {
    useMarkup();
    await seed("agencies", "ag1", {
      name: "Acme Visas", slug: "acme", status: "approved", ownerId: "owner-ag1", ownerName: "Ola Owner",
      services: [], consultationFeeUsd: { amountMinor: PRICE_USD_CENTS, currency: "USD" }, createdAt: T0,
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
    const data = out.body.data;
    assertNoLeak(data, ["consultationId", "requiresPayment", "authorizationUrl", "reference", ...CLIENT_CHARGE_FIELDS]);
    assert.equal(data.chargedAmountMinor, CHARGED_KOBO);
    assert.equal(data.effectiveRate, EFFECTIVE_RATE);
    assert.ok(data.quoteExpiresAt);
  });
});

// ============================================
// Agents, owners and admins: the full document, as before
// ============================================

describe("consultation endpoints still answer the agent side with the full document (issue #332)", () => {
  for (const [name, who] of [["the booking's agent", agent], ["its agency's owner", ownerA], ["an admin", admin]] as const) {
    test(`GET /consultations/:id as ${name}: every stored field, unchanged`, async () => {
      const { out, res } = captureRes();
      await consultationController.getConsultation(reqFor(who, { params: { id: FULL_ID } }), res);
      assert.equal(out.status, 200, JSON.stringify(out.body));
      assert.deepEqual(out.body.data, STORED);
      // Spot checks on what the client view drops.
      assert.equal(out.body.data.fxMarginBps, MARGIN_BPS);
      assert.equal(out.body.data.fxRate, RAW_RATE);
      assert.equal(out.body.data.supersededCheckouts[0].fxMarginBps, 275);
      // And nothing was added to it.
      assert.equal("effectiveRate" in out.body.data, false);
    });
  }

  const scopes: [string, AuthzSubject, Record<string, unknown>][] = [
    ["agent, no role", agent, {}],
    ["agent, role=agent", agent, { role: ROLES.AGENT }],
    ["owner, role=owner", ownerA, { role: ROLES.OWNER }],
    ["admin, role=admin", admin, { role: ROLES.ADMIN }],
  ];
  for (const [name, who, query] of scopes) {
    test(`GET /consultations as ${name}: the stored rows, unchanged`, async () => {
      const { out, res } = captureRes();
      await consultationController.getConsultations(reqFor(who, { query }), res);
      assert.equal(out.status, 200, JSON.stringify(out.body));
      assert.deepEqual(out.body.data, [STORED]);
    });
  }

  test("PUT /consultations/:id/status as the agent: the full updated booking", async () => {
    await seed("consultations", FULL_ID, { ...STORED, status: "scheduled", paymentStatus: "paid" });
    const { out, res } = captureRes();
    await consultationController.updateStatus(reqFor(agent, { params: { id: FULL_ID }, body: { status: "confirmed" } }), res);
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.equal(out.body.data.status, "confirmed");
    assert.equal(out.body.data.fxMarginBps, MARGIN_BPS);
    assert.equal(out.body.data.fxRate, RAW_RATE);
    assert.equal(out.body.data.supersededCheckouts.length, 1);
  });

  test("POST /consultations by an agent for their client: the full stored booking, snapshot included", async () => {
    // The client is already the agent's client (an application assigned to the agent).
    await seed("applications", "app-rel", { userId: client.uid, agentId: agent.uid, createdAt: T0 });
    const { out, res } = captureRes();
    await consultationController.createConsultation(
      reqFor(agent, { body: { userId: client.uid, type: "initial", scheduledDate: "2026-12-07", scheduledTime: "09:00" } }),
      res
    );
    assert.equal(out.status, 201, JSON.stringify(out.body));
    // Priced at the harness rate (₦1,500, no margin): the agent sees how.
    assert.equal(out.body.data.fxRate, 1500);
    assert.equal(out.body.data.fxMarginBps, 0);
    assert.equal(out.body.data.bookedVia, "agent");
    assert.equal("effectiveRate" in out.body.data, false);
  });
});
