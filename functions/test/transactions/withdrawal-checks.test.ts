// ============================================
// Unit tests — issue #287: withdrawal checks on POST /bank-accounts/withdraw
// ============================================
//
// Before #287 the endpoint:
//  - stored whatever `amount` it was sent (`{ amount: "abc" }` was saved, and
//    turned the agent's NGN balance into NaN, after which EVERY withdrawal
//    passed, because `amount > NaN` is always false);
//  - let any signed-in user withdraw (clients, admins);
//  - read the balance, then wrote the withdrawal in a separate step, so two
//    requests at once could both be paid from the same balance.
//
// The contract checked here:
//  - `amount` must be a safe positive integer (kobo), else 400
//    VALIDATION_ERROR and nothing written (string, fraction, negative, zero,
//    missing, too large);
//  - `bankAccountId` must be a non-empty string, else 400; one that is not
//    the caller's own stays 404;
//  - only an agent or an agency owner may withdraw: a client or an admin
//    gets 403 FORBIDDEN, nothing written;
//  - more than the NGN balance: 400 "Insufficient balance", nothing written;
//    exactly the balance: 201;
//  - a successful withdrawal is otherwise unchanged (pending, NGN, manual);
//  - `computeStats` skips and logs a stored row whose amount is not a safe
//    integer, so no figure is ever NaN / null.
//
// Runs on the in-memory Firestore of the payment-request harness
// (test/payment-requests/helpers.ts): no emulator, no network. The fake
// transaction runner is run one at a time, as real Firestore serialises
// conflicting transactions; the REAL race is proven against the Firestore
// emulator in test/emulator/withdrawal-race.emu.ts.
import { test, describe, before, beforeEach, afterEach } from "node:test";
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
  agentB,
  clientNg,
} from "../payment-requests/helpers";
import { captureRes, docsIn, seed, T0 } from "../consultations/harness";
import { fakeCollection, fakeRunTransaction } from "../helpers/fake-firestore";
import { bankAccountController } from "../../src/controllers/bank-account.controller";
import { transactionController } from "../../src/controllers/transaction.controller";
import {
  transactionService,
  availableBalanceIn,
  isUsableAmount,
  WITHDRAWAL_CURRENCY,
} from "../../src/services/transaction.service";
import type { Transaction } from "../../src/types";

/* eslint-disable @typescript-eslint/no-explicit-any */

// ============================================
// Principals and fixtures
// ============================================

/** A platform admin (no agency, no payout balance of their own). */
const admin: AuthzSubject = { uid: "uid-admin", role: ROLES.ADMIN, agencyId: null };

/** Agent A's NGN balance in every test: 500,000 kobo (5,000 naira). */
const BALANCE = 500_000;

/** Bank account ids (see `seedMoney`). */
const ACCOUNT = {
  agentA: "bank-agent-a",
  ownerA: "bank-owner-a",
  agentB: "bank-agent-b",
  client: "bank-client",
  admin: "bank-admin",
};

/** Seed a bank account owned by `uid`. */
async function seedAccount(id: string, uid: string): Promise<void> {
  await seed("bankAccounts", id, {
    userId: uid,
    accountName: "Test Holder",
    bankName: "Test Bank",
    accountNumber: "0123456789",
    isMain: true,
    createdAt: T0,
    updatedAt: T0,
  });
}

/** Seed a settled incoming payment to `agentUid` (what gives them a balance). */
async function seedEarning(id: string, agentUid: string, amount: unknown, currency = "NGN"): Promise<void> {
  await seed("transactions", id, {
    userId: "uid-some-client",
    agentId: agentUid,
    type: "escrow_release",
    amount,
    currency,
    status: "released",
    isEscrow: false,
    paymentProvider: "paystack",
    description: "fixture",
    createdAt: T0,
    updatedAt: T0,
  });
}

/**
 * The money every test starts from: agent A and owner A each have BALANCE
 * kobo settled in NGN, everyone has a bank account. The client and the admin
 * are given a (meaningless) earning row and an account too, so a 403 for
 * them is proven to come from the ROLE and not from an empty balance or a
 * missing account.
 */
async function seedMoney(): Promise<void> {
  await seedAccount(ACCOUNT.agentA, agentA.uid);
  await seedAccount(ACCOUNT.ownerA, ownerA.uid);
  await seedAccount(ACCOUNT.agentB, agentB.uid);
  await seedAccount(ACCOUNT.client, clientNg.uid);
  await seedAccount(ACCOUNT.admin, admin.uid);
  await seedEarning("earn-agent-a", agentA.uid, BALANCE);
  await seedEarning("earn-owner-a", ownerA.uid, BALANCE);
  await seedEarning("earn-client", clientNg.uid, BALANCE);
  await seedEarning("earn-admin", admin.uid, BALANCE);
}

/** Every stored withdrawal row, as [id, data]. */
function withdrawals(): Array<[string, Record<string, any>]> {
  return docsIn("transactions").filter(([, data]) => data.type === "withdrawal");
}

/** Call POST /bank-accounts/withdraw as `who` with `body`. */
async function withdraw(who: AuthzSubject, body: unknown): Promise<{ status: number; body: any }> {
  const { out, res } = captureRes();
  await bankAccountController.withdraw(reqFor(who, { body }), res);
  return out;
}

/**
 * Assert a refusal: the status, the error code, and that NOTHING was written
 * (no withdrawal row, no lock document, and the same number of transactions
 * as before the call).
 */
function assertRefused(
  out: { status: number; body: any },
  status: number,
  error: string,
  transactionsBefore: number
): void {
  assert.equal(out.status, status);
  assert.equal(out.body.success, false);
  assert.equal(out.body.error, error);
  assert.equal(withdrawals().length, 0, "no withdrawal row may be written");
  assert.equal(docsIn("withdrawalLocks").length, 0, "no lock document may be written");
  assert.equal(docsIn("transactions").length, transactionsBefore, "no transaction may be written");
}

// ============================================
// Harness
// ============================================

/** console.warn calls captured during a test (computeStats logs skipped rows). */
let warnings: string[] = [];
const realWarn = console.warn;

before(async () => {
  await usePaymentRequestHarness();
  const firebase: any = await import("../../src/utils/firebase");
  // Collections the withdrawal path touches that the shared harness does not fake.
  firebase.collections.bankAccounts = fakeCollection("bankAccounts");
  firebase.collections.withdrawalLocks = fakeCollection("withdrawalLocks");
  // The in-memory transaction neither isolates nor retries. Real Firestore
  // serialises conflicting transactions, so run ours one at a time (same
  // approach as test/consultations/harness.ts).
  let chain: Promise<unknown> = Promise.resolve();
  (transactionService as any).runTransaction = (fn: any) => {
    const run = chain.then(() => fakeRunTransaction(fn));
    chain = run.catch(() => undefined);
    return run;
  };
});

beforeEach(async () => {
  await resetPaymentRequests();
  await seedMoney();
  warnings = [];
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  };
});

afterEach(() => {
  console.warn = realWarn;
});

// ============================================
// Amount validation
// ============================================

describe("POST /bank-accounts/withdraw: amount validation (#287)", () => {
  /** Every amount that must be refused, with a label for the test name. */
  const BAD_AMOUNTS: Array<[string, unknown]> = [
    ["a non-numeric string", "abc"],
    ["a numeric string", "5000"],
    ["a fraction", 12.5],
    ["a negative number", -100],
    ["zero", 0],
    ["null", null],
    ["true", true],
    ["an object", { value: 5000 }],
    ["an array", [5000]],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["an integer too large to be safe", Number.MAX_SAFE_INTEGER + 1],
  ];

  for (const [label, amount] of BAD_AMOUNTS) {
    test(`${label} is refused with 400 VALIDATION_ERROR and nothing is written`, async () => {
      const count = docsIn("transactions").length;
      const out = await withdraw(agentA, { bankAccountId: ACCOUNT.agentA, amount });
      assertRefused(out, 400, "VALIDATION_ERROR", count);
    });
  }

  test("a missing amount is refused with 400 VALIDATION_ERROR and nothing is written", async () => {
    const count = docsIn("transactions").length;
    const out = await withdraw(agentA, { bankAccountId: ACCOUNT.agentA });
    assertRefused(out, 400, "VALIDATION_ERROR", count);
  });

  test("a request with no body at all is a 400, not a 500", async () => {
    const count = docsIn("transactions").length;
    const out = await withdraw(agentA, undefined);
    assertRefused(out, 400, "VALIDATION_ERROR", count);
  });

  test("the balance is untouched after a refused string amount (it was NaN before #287)", async () => {
    await withdraw(agentA, { bankAccountId: ACCOUNT.agentA, amount: "abc" });
    const stats = await transactionService.getStatsForAgent(agentA.uid);
    assert.equal(availableBalanceIn(stats, WITHDRAWAL_CURRENCY), BALANCE);
  });
});

// ============================================
// Bank account id validation
// ============================================

describe("POST /bank-accounts/withdraw: bankAccountId validation (#287)", () => {
  /** Every bankAccountId that is not a non-empty string. */
  const BAD_IDS: Array<[string, unknown]> = [
    ["an empty string", ""],
    ["only spaces", "   "],
    ["a number", 123],
    ["null", null],
    ["an object", { id: ACCOUNT.agentA }],
    ["an array", [ACCOUNT.agentA]],
  ];

  for (const [label, bankAccountId] of BAD_IDS) {
    test(`${label} is refused with 400 VALIDATION_ERROR and nothing is written`, async () => {
      const count = docsIn("transactions").length;
      const out = await withdraw(agentA, { bankAccountId, amount: 1_000 });
      assertRefused(out, 400, "VALIDATION_ERROR", count);
    });
  }

  test("a missing bankAccountId is refused with 400 VALIDATION_ERROR", async () => {
    const count = docsIn("transactions").length;
    const out = await withdraw(agentA, { amount: 1_000 });
    assertRefused(out, 400, "VALIDATION_ERROR", count);
  });

  test("an id that does not exist stays 404, nothing written", async () => {
    const count = docsIn("transactions").length;
    const out = await withdraw(agentA, { bankAccountId: "bank-nope", amount: 1_000 });
    assertRefused(out, 404, "NOT_FOUND", count);
  });

  test("ANOTHER user's bank account stays 404, nothing written", async () => {
    const count = docsIn("transactions").length;
    const out = await withdraw(agentA, { bankAccountId: ACCOUNT.agentB, amount: 1_000 });
    assertRefused(out, 404, "NOT_FOUND", count);
  });
});

// ============================================
// Role gate
// ============================================

describe("POST /bank-accounts/withdraw: only agents and owners (#287)", () => {
  test("a client is refused with 403 FORBIDDEN, nothing written", async () => {
    const count = docsIn("transactions").length;
    const out = await withdraw(clientNg, { bankAccountId: ACCOUNT.client, amount: 1_000 });
    assertRefused(out, 403, "FORBIDDEN", count);
  });

  test("an admin is refused with 403 FORBIDDEN, nothing written", async () => {
    const count = docsIn("transactions").length;
    const out = await withdraw(admin, { bankAccountId: ACCOUNT.admin, amount: 1_000 });
    assertRefused(out, 403, "FORBIDDEN", count);
  });

  test("a request with no resolved role is refused with 403 (fail closed)", async () => {
    const count = docsIn("transactions").length;
    const { out, res } = captureRes();
    const req = reqFor(agentA, { body: { bankAccountId: ACCOUNT.agentA, amount: 1_000 } });
    delete req.authz;
    await bankAccountController.withdraw(req, res);
    assertRefused(out, 403, "FORBIDDEN", count);
  });

  test("the role is checked BEFORE the body: a client with a bad amount still gets 403", async () => {
    const count = docsIn("transactions").length;
    const out = await withdraw(clientNg, { bankAccountId: ACCOUNT.client, amount: "abc" });
    assertRefused(out, 403, "FORBIDDEN", count);
  });

  test("an agency owner can withdraw from their own balance", async () => {
    const out = await withdraw(ownerA, { bankAccountId: ACCOUNT.ownerA, amount: 1_000 });
    assert.equal(out.status, 201);
    assert.equal(out.body.data.agentId, ownerA.uid);
  });
});

// ============================================
// Balance check
// ============================================

describe("POST /bank-accounts/withdraw: balance check (#287)", () => {
  test("one kobo more than the balance: 400 'Insufficient balance', nothing written", async () => {
    const count = docsIn("transactions").length;
    const out = await withdraw(agentA, { bankAccountId: ACCOUNT.agentA, amount: BALANCE + 1 });
    assertRefused(out, 400, "VALIDATION_ERROR", count);
    assert.equal(out.body.message, "Insufficient balance");
  });

  test("exactly the balance: 201, and the transaction is a pending manual NGN withdrawal", async () => {
    const out = await withdraw(agentA, { bankAccountId: ACCOUNT.agentA, amount: BALANCE });
    assert.equal(out.status, 201);
    assert.equal(out.body.success, true);
    const txn = out.body.data as Transaction;
    assert.equal(txn.type, "withdrawal");
    assert.equal(txn.status, "pending");
    assert.equal(txn.currency, "NGN");
    assert.equal(txn.paymentProvider, "manual");
    assert.equal(txn.amount, BALANCE);
    assert.equal(txn.userId, agentA.uid);
    assert.equal(txn.agentId, agentA.uid);
    assert.equal(txn.isEscrow, false);
    assert.equal((txn.metadata as any).bankAccountId, ACCOUNT.agentA);

    // Exactly one row stored, the one returned, and the lock names it.
    const rows = withdrawals();
    assert.equal(rows.length, 1);
    assert.equal(rows[0][0], txn.id);
    assert.equal(rows[0][1].amount, BALANCE);
    const locks = docsIn("withdrawalLocks");
    assert.deepEqual(locks.map(([id]) => id), [agentA.uid]);
    assert.equal(locks[0][1].lastWithdrawalId, txn.id);
  });

  test("a pending withdrawal is held: a second one for the same money is refused", async () => {
    const first = await withdraw(agentA, { bankAccountId: ACCOUNT.agentA, amount: BALANCE });
    assert.equal(first.status, 201);
    const second = await withdraw(agentA, { bankAccountId: ACCOUNT.agentA, amount: 1 });
    assert.equal(second.status, 400);
    assert.equal(second.body.message, "Insufficient balance");
    assert.equal(withdrawals().length, 1);
  });

  test("two withdrawals that fit together both succeed, a third that does not is refused", async () => {
    const half = BALANCE / 2;
    assert.equal((await withdraw(agentA, { bankAccountId: ACCOUNT.agentA, amount: half })).status, 201);
    assert.equal((await withdraw(agentA, { bankAccountId: ACCOUNT.agentA, amount: half })).status, 201);
    assert.equal((await withdraw(agentA, { bankAccountId: ACCOUNT.agentA, amount: 1 })).status, 400);
    assert.equal(withdrawals().length, 2);
    assert.equal(docsIn("withdrawalLocks")[0][1].withdrawalCount, 2);
  });

  test("two full-balance withdrawals sent together: one 201, one 400, one row", async () => {
    const body = { bankAccountId: ACCOUNT.agentA, amount: BALANCE };
    const results = await Promise.all([withdraw(agentA, body), withdraw(agentA, body)]);
    assert.deepEqual(results.map((r) => r.status).sort(), [201, 400]);
    assert.equal(results.find((r) => r.status === 400)?.body.message, "Insufficient balance");
    assert.equal(withdrawals().length, 1);
  });

  test("one agent's withdrawal does not touch another agent's balance", async () => {
    assert.equal((await withdraw(agentA, { bankAccountId: ACCOUNT.agentA, amount: BALANCE })).status, 201);
    assert.equal((await withdraw(ownerA, { bankAccountId: ACCOUNT.ownerA, amount: BALANCE })).status, 201);
  });

  test("revenue in another currency never makes a naira withdrawal possible (#282)", async () => {
    // Agent B has only US dollars: no NGN balance at all.
    await seedEarning("earn-agent-b-usd", agentB.uid, 9_000_000, "USD");
    const count = docsIn("transactions").length;
    const out = await withdraw(agentB, { bankAccountId: ACCOUNT.agentB, amount: 1 });
    assertRefused(out, 400, "VALIDATION_ERROR", count);
    assert.equal(out.body.message, "Insufficient balance");
  });
});

// ============================================
// Stored rows with an unusable amount
// ============================================

describe("computeStats skips stored rows whose amount is not a safe integer (#287)", () => {
  /** A minimal stored transaction with any `amount` (as bad data would be). */
  function row(id: string, amount: unknown, over: Record<string, unknown> = {}): Transaction {
    return {
      id,
      userId: "uid-some-client",
      agentId: agentA.uid,
      type: "escrow_release",
      amount,
      currency: "NGN",
      status: "released",
      isEscrow: false,
      paymentProvider: "paystack",
      description: "fixture",
      createdAt: Timestamp.fromMillis(0),
      updatedAt: Timestamp.fromMillis(0),
      ...over,
    } as unknown as Transaction;
  }

  test("isUsableAmount: safe integers only", () => {
    for (const ok of [0, 1, -5, 500_000, Number.MAX_SAFE_INTEGER]) assert.equal(isUsableAmount(ok), true);
    for (const bad of ["abc", "5000", 12.5, Number.NaN, Number.POSITIVE_INFINITY, null, undefined, {}, Number.MAX_SAFE_INTEGER + 1]) {
      assert.equal(isUsableAmount(bad), false, `${String(bad)} must not be usable`);
    }
  });

  test("a withdrawal stored with amount 'abc' is skipped and logged with its id; no figure is NaN", () => {
    const stats = transactionService.computeStats([
      row("good-1", 500_000),
      row("bad-withdrawal", "abc", { type: "withdrawal", status: "pending", userId: agentA.uid }),
    ]);
    assert.deepEqual(stats, {
      byCurrency: [
        { currency: "NGN", totalRevenue: 500_000, pendingPayments: 0, availableBalance: 500_000, heldBalance: 0 },
      ],
      pendingClientsCount: 0,
    });
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /bad-withdrawal/);
  });

  test("bad rows of every kind (revenue, pending, refund) are skipped: figures stay finite integers", () => {
    const stats = transactionService.computeStats([
      row("good-1", 300_000),
      row("good-pending", 40_000, { status: "pending", userId: "client-ok" }),
      row("bad-revenue", "5000"),
      row("bad-fraction", 12.5),
      row("bad-pending", "abc", { status: "pending", userId: "client-bad" }),
      row("bad-refund", Number.NaN, { type: "refund", status: "completed" }),
      row("bad-missing", undefined),
    ]);
    assert.deepEqual(stats, {
      byCurrency: [
        { currency: "NGN", totalRevenue: 300_000, pendingPayments: 40_000, availableBalance: 300_000, heldBalance: 0 },
      ],
      // The client whose only pending row was unusable is not counted.
      pendingClientsCount: 1,
    });
    // Survives JSON (NaN would become null on the wire).
    for (const figure of Object.values(JSON.parse(JSON.stringify(stats)).byCurrency[0])) {
      assert.notEqual(figure, null);
    }
    // One log line per skipped row, each naming its id.
    assert.equal(warnings.length, 5);
    for (const id of ["bad-revenue", "bad-fraction", "bad-pending", "bad-refund", "bad-missing"]) {
      assert.ok(warnings.some((w) => w.includes(id)), `${id} must be logged`);
    }
  });

  test("a currency whose only row is unusable gets no row of its own", () => {
    const stats = transactionService.computeStats([row("bad-usd", "abc", { currency: "USD" })]);
    assert.deepEqual(stats, { byCurrency: [], pendingClientsCount: 0 });
  });

  test("GET /transactions/stats never returns NaN or null with a stored 'abc' withdrawal", async () => {
    // The exact row the old endpoint stored for `{ amount: "abc" }`.
    await seed("transactions", "legacy-bad-withdrawal", {
      userId: agentA.uid,
      agentId: agentA.uid,
      type: "withdrawal",
      amount: "abc",
      currency: "NGN",
      status: "pending",
      isEscrow: false,
      paymentProvider: "manual",
      description: "Withdrawal to Test Bank 0123456789",
      createdAt: T0,
      updatedAt: T0,
    });
    const { out, res } = captureRes();
    await transactionController.getStats(reqFor(agentA), res);
    assert.equal(out.status, 200);
    // Through JSON, as the client receives it.
    const ngn = JSON.parse(JSON.stringify(out.body)).data.byCurrency.find((r: any) => r.currency === "NGN");
    assert.deepEqual(ngn, {
      currency: "NGN",
      totalRevenue: BALANCE,
      pendingPayments: 0,
      availableBalance: BALANCE,
      heldBalance: 0,
    });
  });

  test("with a stored 'abc' withdrawal the balance check still works (it let everything through before #287)", async () => {
    await seed("transactions", "legacy-bad-withdrawal", {
      userId: agentA.uid,
      agentId: agentA.uid,
      type: "withdrawal",
      amount: "abc",
      currency: "NGN",
      status: "pending",
      isEscrow: false,
      paymentProvider: "manual",
      description: "Withdrawal to Test Bank 0123456789",
      createdAt: T0,
      updatedAt: T0,
    });
    // Over the balance: refused (NaN used to make `amount > balance` false).
    const over = await withdraw(agentA, { bankAccountId: ACCOUNT.agentA, amount: BALANCE + 1 });
    assert.equal(over.status, 400);
    assert.equal(over.body.message, "Insufficient balance");
    // Exactly the balance: allowed.
    const exact = await withdraw(agentA, { bankAccountId: ACCOUNT.agentA, amount: BALANCE });
    assert.equal(exact.status, 201);
  });
});
