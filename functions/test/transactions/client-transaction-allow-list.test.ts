// ============================================
// Unit tests — issue #329: the client view of GET /transactions is an allow-list
// ============================================
//
// #292 made GET /transactions return a client's own payments, but as the
// whole stored document: Seli's exchange-rate markup (`fxMarginBps`), the raw
// rate, internal agent ids and Paystack references went to the payer.
//
// The contract checked here:
//  - a client gets `ClientTransaction` rows whose keys are ONLY the ones in
//    CLIENT_TRANSACTION_FIELDS, for every `role` value they can send;
//  - nothing hidden reaches the response, by key OR by value (the response is
//    searched for a marker value planted in every hidden field);
//  - the guard against future leaks, in three layers:
//      1. `FULL_ROW` is typed `Required<Transaction>`, so a field added to
//         the `Transaction` type does not COMPILE here until it is added to
//         the fixture (`npm test` type-checks the tests first);
//      2. every key of that fixture must then be classified, as shown to
//         clients (SHOWN_FROM) or hidden (HIDDEN_FIELDS); an unclassified
//         key fails "every stored field is classified";
//      3. a field nobody declared at all (written straight to Firestore)
//         still cannot leak, because the mapper copies named fields only;
//  - the receipt's effective rate (amount charged ÷ dollar price, markup
//    included) can still be worked out from the client view;
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
} from "../payment-requests/helpers";
import { captureRes, seed, NOW_ISO } from "../consultations/harness";
import { transactionController } from "../../src/controllers/transaction.controller";
import {
  CLIENT_TRANSACTION_FIELDS,
  toClientTransaction,
} from "../../src/transactions/client-transaction";
import { convertUsdToLocal, makeMoney } from "../../src/money/money";
import type { Transaction } from "../../src/types";

/* eslint-disable @typescript-eslint/no-explicit-any */

/** A platform admin (no agency). */
const admin: AuthzSubject = { uid: "uid-admin", role: ROLES.ADMIN, agencyId: null };

/** A timestamp `minutes` after the harness clock. */
const at = (minutes: number) =>
  Timestamp.fromMillis(new Date(NOW_ISO).getTime() + minutes * 60_000);

// ============================================
// The charge used throughout: $6.00 at a raw rate of ₦1,320.95 + 2.5% markup
// ============================================

/** The dollar price, in US cents ($6.00). */
const PRICE_USD_CENTS = 600;
/** The raw (mid-market) rate: naira per dollar, BEFORE the markup. Hidden. */
const RAW_RATE = 1320.95;
/** Seli's markup in basis points (2.5%). Hidden. */
const MARGIN_BPS = 250;
/** What the client was charged, in kobo, worked out by the real conversion. */
const CHARGED_KOBO = convertUsdToLocal(
  makeMoney(PRICE_USD_CENTS, "USD"), RAW_RATE, "NGN", MARGIN_BPS
).amountMinor;

// ============================================
// A stored row with EVERY Transaction field set
// ============================================
//
// `Required<Transaction>`: adding a field to the Transaction type breaks the
// build of this file until the field is added here, and then the
// classification test below makes the author say whether clients see it.
// Hidden fields hold marker values ("HIDDEN-...", odd numbers) that appear
// nowhere else, so the response can be searched for them.

const FULL_ROW_ID = "tx-full";

const FULL_ROW: Required<Transaction> = {
  id: FULL_ROW_ID,
  // ---- Shown to the client ----
  type: "escrow_release",
  status: "released",
  description: "Escrow release for: Visa Processing Fee",
  visaTypeName: "Skilled Worker visa",
  amount: CHARGED_KOBO,
  currency: "NGN",
  priceUsdCents: PRICE_USD_CENTS,
  paymentProvider: "paystack",
  applicationId: APP_A,
  consultationId: "consult-full",
  createdAt: at(1),
  paystackPaidAt: at(2),
  // ---- Hidden from the client ----
  userId: clientNg.uid,
  agentId: "HIDDEN-agent-user-uid",
  paymentRequestId: "HIDDEN-payment-request-id",
  chargedCurrency: "NGN",
  chargedAmountMinor: CHARGED_KOBO,
  fxRate: RAW_RATE,
  fxRateAsOf: Timestamp.fromMillis(1_711_111_111_000),
  fxRateSource: "hold",
  fxMarginBps: MARGIN_BPS,
  paidAfterQuoteExpiry: true,
  paidOnSupersededReference: true,
  isEscrow: true,
  escrowReleaseCondition: "HIDDEN-escrow-condition",
  escrowReleasedAt: Timestamp.fromMillis(1_722_222_222_000),
  providerTransactionId: "HIDDEN-paystack-reference",
  metadata: {
    reference: "HIDDEN-metadata-reference",
    agentProfileId: "HIDDEN-agent-profile-id",
    paymentRequestId: "HIDDEN-metadata-request-id",
    category: "HIDDEN-category",
  },
  clientName: "HIDDEN Client Name",
  clientEmail: "delivered+hidden-client@resend.dev",
  updatedAt: Timestamp.fromMillis(1_733_333_333_000),
  // ---- Issue #317: fee hold and refund bookkeeping (hidden) ----
  feeHold: {
    state: "held",
    slotStartAt: Timestamp.fromMillis(1_755_555_555_000),
    releaseAt: Timestamp.fromMillis(1_755_555_556_000),
  },
  refundOf: "HIDDEN-refunded-fee-id",
  // Issue #354: the exception an unapplied-payment refund gives back (= a Paystack reference). Hidden.
  paymentExceptionId: "HIDDEN-payment-exception-reference",
  reason: "admin_other",
  initiatedBy: "HIDDEN-initiating-uid",
  refundNote: "HIDDEN-admin-note",
  refundFundedFrom: "available",
  balanceShortfallMinor: 13_579,
  // Issue #354: Paystack's fee kept out of a client-caused refund. Not on the
  // client allow-list (the client is told it in the refund notification).
  paystackFeeKeptMinor: 24_680,
  providerRefundId: "HIDDEN-paystack-refund-id",
  providerRefundStatus: "HIDDEN-paystack-refund-status",
  refundAttempts: 3,
  refundProviderCalls: 3,
  refundNextAttemptAt: Timestamp.fromMillis(1_755_555_557_000),
  refundLeaseUntil: Timestamp.fromMillis(1_755_555_558_000),
  refundLastError: "HIDDEN-paystack-error",
  refundedAt: Timestamp.fromMillis(1_755_555_559_000),
  refundFailedAt: Timestamp.fromMillis(1_755_555_560_000),
};

/**
 * Stored fields a client is shown, and the response key(s) each one feeds.
 * Every response key in CLIENT_TRANSACTION_FIELDS must be fed by one of them.
 */
const SHOWN_FROM: Partial<Record<keyof Transaction, readonly string[]>> = {
  id: ["id"],
  type: ["type"],
  status: ["status"],
  description: ["description"],
  visaTypeName: ["visaTypeName"],
  amount: ["amount", "amountCharged"],
  currency: ["currency", "amountCharged"],
  priceUsdCents: ["priceUsdCents", "priceUsd"],
  paymentProvider: ["paymentProvider"],
  applicationId: ["applicationId"],
  consultationId: ["consultationId"],
  createdAt: ["createdAt"],
  paystackPaidAt: ["paidAt"],
};

/**
 * Stored fields a client must NEVER receive. A new Transaction field goes
 * here unless there is a decision to show it (then: SHOWN_FROM, the mapper
 * and CLIENT_TRANSACTION_FIELDS, all three).
 */
const HIDDEN_FIELDS: readonly (keyof Transaction)[] = [
  // Seli's markup, and the raw rate it is added to.
  "fxMarginBps",
  "fxRate",
  "fxRateAsOf",
  "fxRateSource",
  // Repeats of `amount` / `currency`; not needed twice.
  "chargedCurrency",
  "chargedAmountMinor",
  // Internal ids.
  "userId",
  "agentId",
  "paymentRequestId",
  // Paystack references and the free-form bag that repeats them.
  "providerTransactionId",
  "metadata",
  // Settlement and escrow bookkeeping.
  "paidAfterQuoteExpiry",
  "paidOnSupersededReference",
  "isEscrow",
  "escrowReleaseCondition",
  "escrowReleasedAt",
  // Denormalized for the agent-side lists.
  "clientName",
  "clientEmail",
  "updatedAt",
  // Issue #317: the fee hold and the refund engine's bookkeeping. A refund
  // row reaches the client as type "refund" + status + amount only.
  "feeHold",
  "refundOf",
  // Issue #354: names a Paystack reference, so never shown to the client.
  "paymentExceptionId",
  "reason",
  "initiatedBy",
  "refundNote",
  "refundFundedFrom",
  "balanceShortfallMinor",
  "paystackFeeKeptMinor",
  "providerRefundId",
  "providerRefundStatus",
  "refundAttempts",
  "refundProviderCalls",
  "refundNextAttemptAt",
  "refundLeaseUntil",
  "refundLastError",
  "refundedAt",
  "refundFailedAt",
];

/** Marker values that must not appear anywhere in a client response. */
const HIDDEN_VALUES: readonly string[] = [
  "HIDDEN", // every marker string starts with it
  String(RAW_RATE), // 1320.95, the raw rate
  "1711111111", // fxRateAsOf seconds
  "1722222222", // escrowReleasedAt seconds
  "1733333333", // updatedAt seconds
  "1755555", // the #317 hold / refund timestamps
  "13579", // balanceShortfallMinor
  "24680", // paystackFeeKeptMinor (#354)
  "admin_other", // reason
  "hold", // fxRateSource
  "delivered+hidden-client@resend.dev",
  "NOT-IN-THE-TYPE", // the undeclared fields seeded below
];

/**
 * Fields that exist in NO type: what a future write path might add straight
 * to the document. They must not reach a client either.
 */
const UNDECLARED = {
  platformFeeBps: "NOT-IN-THE-TYPE-fee",
  internalNote: "NOT-IN-THE-TYPE-note",
  ledger: { costRate: "NOT-IN-THE-TYPE-nested" },
};

/** GET /transactions as `who` with the given query string values. */
async function list(who: AuthzSubject, query: Record<string, unknown> = {}) {
  const { out, res } = captureRes();
  await transactionController.getTransactions(reqFor(who, { query }), res);
  assert.equal(out.status, 200, JSON.stringify(out.body));
  return out.body.data as Record<string, unknown>[];
}

/** Assert one client-view row leaks nothing, by key or by value. */
function assertNoLeak(row: Record<string, unknown>): void {
  const allowed = new Set<string>(CLIENT_TRANSACTION_FIELDS);
  // 1. Keys: nothing outside the allow-list.
  for (const key of Object.keys(row)) {
    assert.ok(allowed.has(key), `client response carries a key outside the allow-list: "${key}"`);
  }
  // 2. Hidden key names, at any depth (JSON key = `"name":`).
  const json = JSON.stringify(row);
  for (const key of [...HIDDEN_FIELDS, ...Object.keys(UNDECLARED), "agentProfileId", "reference"]) {
    assert.ok(!json.includes(`"${key}":`), `client response carries the hidden key "${key}"`);
  }
  // 3. Hidden values, at any depth.
  for (const value of HIDDEN_VALUES) {
    assert.ok(!json.includes(value), `client response carries the hidden value "${value}"`);
  }
}

before(async () => {
  await usePaymentRequestHarness();
});
beforeEach(async () => {
  await resetPaymentRequests();
  // The fully populated row plus the undeclared fields, as stored.
  await seed("transactions", FULL_ROW_ID, { ...FULL_ROW, ...UNDECLARED });
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  console.error = () => {};
});

// ============================================
// The allow-list itself
// ============================================

describe("client transaction allow-list (issue #329)", () => {
  test("every stored field is classified as shown or hidden (a new field must be decided)", () => {
    const shown = Object.keys(SHOWN_FROM);
    const hidden = HIDDEN_FIELDS as readonly string[];
    for (const key of Object.keys(FULL_ROW)) {
      assert.ok(
        shown.includes(key) !== hidden.includes(key),
        `Transaction.${key} must be in exactly one of SHOWN_FROM or HIDDEN_FIELDS. ` +
          "A new field is hidden from clients unless it is deliberately added to toClientTransaction."
      );
    }
    // And nothing is classified that the type no longer has.
    for (const key of [...shown, ...hidden]) assert.ok(key in FULL_ROW, `${key} is not a Transaction field`);
  });

  test("the response keys are exactly the allow-list, each fed by a field marked as shown", () => {
    const fed = new Set(Object.values(SHOWN_FROM).flat());
    assert.deepEqual([...fed].sort(), [...CLIENT_TRANSACTION_FIELDS].sort());
    // A fully populated row produces every allow-listed key and no other.
    assert.deepEqual(Object.keys(toClientTransaction(FULL_ROW)).sort(), [...CLIENT_TRANSACTION_FIELDS].sort());
  });

  test("the mapper output is exactly the documented client view", () => {
    assert.deepEqual(toClientTransaction({ ...FULL_ROW, ...UNDECLARED } as Transaction), {
      id: FULL_ROW_ID,
      type: "escrow_release",
      status: "released",
      description: "Escrow release for: Visa Processing Fee",
      visaTypeName: "Skilled Worker visa",
      amountCharged: { amountMinor: CHARGED_KOBO, currency: "NGN" },
      priceUsd: { amountMinor: PRICE_USD_CENTS, currency: "USD" },
      amount: CHARGED_KOBO,
      currency: "NGN",
      priceUsdCents: PRICE_USD_CENTS,
      paymentProvider: "paystack",
      applicationId: APP_A,
      consultationId: "consult-full",
      createdAt: at(1),
      paidAt: at(2),
    });
  });

  test("no hidden field, nested field, undeclared field or marker value is in the mapper output", () => {
    assertNoLeak(toClientTransaction({ ...FULL_ROW, ...UNDECLARED } as Transaction) as any);
  });

  test("a legacy row (no snapshot, no currency code) maps to NGN with no dollar price", () => {
    const legacy = {
      id: "tx-legacy", userId: clientNg.uid, type: "consultation_fee", amount: 5_000_000,
      status: "completed", isEscrow: false, paymentProvider: "paystack",
      description: "Consultation fee", createdAt: at(3), updatedAt: at(3),
    } as unknown as Transaction;
    assert.deepEqual(toClientTransaction(legacy), {
      id: "tx-legacy",
      type: "consultation_fee",
      status: "completed",
      description: "Consultation fee",
      amountCharged: { amountMinor: 5_000_000, currency: "NGN" },
      amount: 5_000_000,
      currency: "NGN",
      paymentProvider: "paystack",
      createdAt: at(3),
    });
  });

  // A corrupt dollar price is dropped, never passed on as money.
  for (const bad of ["600", 6.5, -1, Number.NaN, null]) {
    test(`a stored priceUsdCents of ${JSON.stringify(bad)} gives no dollar price`, () => {
      const out = toClientTransaction({ ...FULL_ROW, priceUsdCents: bad } as unknown as Transaction);
      assert.equal("priceUsd" in out, false);
      assert.equal("priceUsdCents" in out, false);
    });
  }
});

// ============================================
// Through the endpoint, as a client
// ============================================

describe("GET /transactions as a client returns only the allow-list (issue #329)", () => {
  // Every `role` a client can send lands in the same client view.
  const roleValues: unknown[] = [
    undefined, ROLES.CLIENT, ROLES.AGENT, ROLES.OWNER, ROLES.ADMIN, "superuser", ["admin", "client"],
  ];
  for (const role of roleValues) {
    test(`role=${JSON.stringify(role)}: the row is the client view, nothing hidden`, async () => {
      const rows = await list(clientNg, role === undefined ? {} : { role });
      assert.equal(rows.length, 1);
      assert.equal(rows[0].id, FULL_ROW_ID);
      assertNoLeak(rows[0]);
      // Exactly what the mapper gives for the stored row.
      assert.deepEqual(rows[0], toClientTransaction(FULL_ROW));
    });
  }

  test("a caller with no resolved principal also gets the client view", async () => {
    const { out, res } = captureRes();
    const req = reqFor(clientNg, { query: { role: ROLES.ADMIN } });
    delete req.authz;
    await transactionController.getTransactions(req, res);
    assert.equal(out.status, 200);
    assert.equal(out.body.data.length, 1);
    assertNoLeak(out.body.data[0]);
  });

  test("an agent asking for role=client (their own payments) gets the client view too", async () => {
    // Agent A paid this one as a customer of someone else.
    await seed("transactions", "tx-agent-paid", { ...FULL_ROW, ...UNDECLARED, id: "tx-agent-paid", userId: agentA.uid });
    const rows = await list(agentA, { role: ROLES.CLIENT });
    assert.deepEqual(rows.map((r) => r.id), ["tx-agent-paid"]);
    assertNoLeak(rows[0]);
  });

  test("the fields the mobile Payments screen reads are all present", async () => {
    // seli-mobile liveTransactions.ts `mapTransaction` reads exactly these.
    const [row] = await list(clientNg);
    assert.equal(row.id, FULL_ROW_ID);
    assert.equal(row.description, "Escrow release for: Visa Processing Fee");
    assert.equal(row.type, "escrow_release");
    assert.equal(row.visaTypeName, "Skilled Worker visa");
    assert.equal(row.amount, CHARGED_KOBO);
    assert.equal(row.currency, "NGN");
    assert.equal(row.priceUsdCents, PRICE_USD_CENTS);
    assert.deepEqual(row.createdAt, at(1));
    assert.equal(row.status, "released");
    assert.equal(row.paymentProvider, "paystack");
  });

  test("the receipt's effective rate still works: amount charged ÷ dollar price, markup included", async () => {
    const [row] = (await list(clientNg)) as any[];
    // Major units: kobo / 100 and cents / 100, so the factors cancel.
    const effective = row.amountCharged.amountMinor / row.priceUsd.amountMinor;
    // ₦1,320.95 raw + 2.5% = ₦1,353.97 per $1 (to the kobo): what the receipt shows.
    assert.equal(effective.toFixed(2), "1353.97");
    assert.equal(effective.toFixed(2), (RAW_RATE * (1 + MARGIN_BPS / 10_000)).toFixed(2));
    // It is NOT the raw rate, and neither the raw rate nor the markup is sent.
    assert.notEqual(effective.toFixed(2), RAW_RATE.toFixed(2));
    assert.equal("fxRate" in row, false);
    assert.equal("fxMarginBps" in row, false);
  });

  test("another client gets nothing of this row", async () => {
    assert.deepEqual(await list(clientGh), []);
  });
});

// ============================================
// Agents, owners and admins: the full document, as before
// ============================================

describe("GET /transactions for agent-side callers still returns the full document (issue #329)", () => {
  /** The row as stored, with agent A as its agent so every scope finds it. */
  const stored = { ...FULL_ROW, ...UNDECLARED, agentId: agentA.uid };

  beforeEach(async () => {
    await seed("transactions", FULL_ROW_ID, stored);
  });

  const scopes: [string, AuthzSubject, Record<string, unknown>][] = [
    ["agent, no role", agentA, {}],
    ["agent, role=agent", agentA, { role: ROLES.AGENT }],
    ["owner, role=owner", ownerA, { role: ROLES.OWNER }],
    ["admin, role=admin", admin, { role: ROLES.ADMIN }],
  ];
  for (const [name, who, query] of scopes) {
    test(`${name}: every stored field is returned unchanged`, async () => {
      const rows = await list(who, query);
      assert.equal(rows.length, 1);
      assert.deepEqual(rows[0], stored);
      // Spot checks on the fields the client view drops.
      assert.equal(rows[0].fxMarginBps, MARGIN_BPS);
      assert.equal(rows[0].fxRate, RAW_RATE);
      assert.equal(rows[0].providerTransactionId, "HIDDEN-paystack-reference");
    });
  }
});
