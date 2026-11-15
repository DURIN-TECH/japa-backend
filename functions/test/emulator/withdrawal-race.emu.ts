// ============================================
// Emulator test — withdrawals: the balance check and the write are atomic (issue #287)
// ============================================
//
// Run with `npm run test:emulator` (Auth + Firestore + Storage emulators on the
// alternate ports of ../firebase.emulator-test.json, project `demo-...`, the
// real Express app, real ID tokens).
//
// Why an emulator test: the unit tests (test/transactions/
// withdrawal-checks.test.ts) run on an in-memory Firestore whose transactions
// are simply run one at a time. Only a real Firestore transaction can prove
// that two withdrawals sent AT THE SAME TIME cannot both pass the balance
// check. Before #287 the balance was read, then the withdrawal written in a
// separate step: both requests read the same balance and both were paid.
//
// What is checked, through POST /bank-accounts/withdraw and
// GET /transactions/stats:
//  1. two concurrent withdrawals, each for the FULL balance: exactly one 201,
//     the other 400 "Insufficient balance", and exactly one `withdrawal` row
//     in `transactions`. Repeated over several fresh agents, and once with a
//     larger burst, so a lucky ordering cannot pass it;
//  2. a `withdrawal` stored with `amount: "abc"` (what the old endpoint
//     accepted): the stats never contain NaN / null, and the balance check
//     still refuses a withdrawal over the real balance;
//  3. the role gate and the body validation on the real route (real tokens);
//  4. a client token is denied by firestore.rules on `withdrawalLocks`.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

import { clientDb, isDenied, refreshIdToken, resetEmulators, RunningApi, rulesEnv, signUp, startApi, TestAccount, withoutRules } from "./helpers";

/* eslint-disable @typescript-eslint/no-explicit-any */

/** The balance every agent in this file starts with: 500,000 kobo (5,000 naira). */
const BALANCE = 500_000;

let api: RunningApi;
/** name -> signed-in account / fresh ID token (carrying the role claims). */
const accounts: Record<string, TestAccount> = {};
const tokens: Record<string, string> = {};

/** A signed-in account with claims (what the backend sets) and a user doc. */
async function principal(name: string, claims: Record<string, unknown>): Promise<void> {
  const account = await signUp(name);
  const { auth } = await import("../../src/utils/firebase");
  await auth.setCustomUserClaims(account.uid, claims);
  accounts[name] = account;
  tokens[name] = await refreshIdToken(account);
  await withoutRules(async (db) => {
    await db.collection("users").doc(account.uid).set({ id: account.uid, email: account.email, firstName: name, lastName: "T" });
  });
}

/** The bank account id seeded for `name`. */
const bankId = (name: string) => `bank-${name}`;

/**
 * Give `name` a bank account and one settled NGN payment of BALANCE kobo,
 * written the way the backend would have (rules off).
 */
async function seedMoney(name: string): Promise<void> {
  const uid = accounts[name].uid;
  const now = new Date();
  await withoutRules(async (db) => {
    await db.collection("bankAccounts").doc(bankId(name)).set({
      id: bankId(name), userId: uid, accountName: "Test Holder", bankName: "Test Bank",
      accountNumber: "0123456789", isMain: true, createdAt: now, updatedAt: now,
    });
    await db.collection("transactions").doc(`earn-${name}`).set({
      id: `earn-${name}`, userId: "some-client", agentId: uid, type: "escrow_release",
      amount: BALANCE, currency: "NGN", status: "released", isEscrow: false,
      paymentProvider: "paystack", description: "fixture", createdAt: now, updatedAt: now,
    });
  });
}

/** Every `withdrawal` row stored for `name` (read with rules off). */
async function withdrawalsOf(name: string): Promise<any[]> {
  const rows: any[] = [];
  await withoutRules(async (db) => {
    const snap = await db.collection("transactions").where("agentId", "==", accounts[name].uid).get();
    snap.forEach((doc: any) => {
      if (doc.data().type === "withdrawal") rows.push(doc.data());
    });
  });
  return rows;
}

/** POST /bank-accounts/withdraw as `name`. */
const withdraw = (name: string, body: unknown) => api.call("POST", "/bank-accounts/withdraw", tokens[name], body);

/** Agents used by the repeated race (a fresh one per round, so each starts from BALANCE). */
const RACERS = ["racer1", "racer2", "racer3", "racer4", "racer5"];

before(async () => {
  await resetEmulators();
  api = await startApi();

  for (const name of RACERS) await principal(name, { role: "agent", agencyId: null, admin: false });
  await principal("burst", { role: "agent", agencyId: null, admin: false });
  await principal("wowner", { role: "owner", agencyId: "agency-w", admin: false });
  await principal("badrow", { role: "agent", agencyId: null, admin: false });
  await principal("plain", { role: "agent", agencyId: null, admin: false });
  await principal("wclient", { role: "client", agencyId: null, admin: false });
  await principal("wadmin", { role: "admin", agencyId: null, admin: true });

  for (const name of [...RACERS, "burst", "wowner", "badrow", "plain", "wclient", "wadmin"]) await seedMoney(name);
});

after(async () => {
  await api.close();
  await (await rulesEnv()).cleanup();
});

// ============================================
// 1. The race
// ============================================

describe("two withdrawals at the same time cannot both be paid (#287)", () => {
  for (const name of RACERS) {
    test(`${name}: two concurrent full-balance withdrawals give one 201, one 400, one row`, async () => {
      const body = { bankAccountId: bankId(name), amount: BALANCE };
      // Sent together: neither waits for the other.
      const results = await Promise.all([withdraw(name, body), withdraw(name, body)]);

      assert.deepEqual(results.map((r) => r.status).sort(), [201, 400], JSON.stringify(results));
      const refused = results.find((r) => r.status === 400)!;
      assert.equal(refused.body.error, "VALIDATION_ERROR");
      assert.equal(refused.body.message, "Insufficient balance");

      // The winner is an unchanged, pending, manual NGN withdrawal.
      const won = results.find((r) => r.status === 201)!.body.data;
      assert.equal(won.type, "withdrawal");
      assert.equal(won.status, "pending");
      assert.equal(won.currency, "NGN");
      assert.equal(won.paymentProvider, "manual");
      assert.equal(won.amount, BALANCE);

      // Exactly one withdrawal row exists, the one that was returned.
      const rows = await withdrawalsOf(name);
      assert.equal(rows.length, 1, `expected one withdrawal row, got ${rows.length}`);
      assert.equal(rows[0].id, won.id);

      // And the balance is now 0, not negative-clamped from a double payout.
      const stats = await api.call("GET", "/transactions/stats", tokens[name]);
      const ngn = stats.body.data.byCurrency.find((r: any) => r.currency === "NGN");
      assert.equal(ngn.availableBalance, 0);
    });
  }

  test("a burst of six full-balance withdrawals: one 201, five 400, one row", async () => {
    const body = { bankAccountId: bankId("burst"), amount: BALANCE };
    const results = await Promise.all(Array.from({ length: 6 }, () => withdraw("burst", body)));
    const statuses = results.map((r) => r.status).sort();
    assert.deepEqual(statuses, [201, 400, 400, 400, 400, 400], JSON.stringify(results.map((r) => r.body)));
    for (const r of results.filter((x) => x.status === 400)) {
      assert.equal(r.body.message, "Insufficient balance");
    }
    assert.equal((await withdrawalsOf("burst")).length, 1);
  });

  test("an owner: concurrent halves both fit, a concurrent third does not (never more than the balance)", async () => {
    const body = { bankAccountId: bankId("wowner"), amount: BALANCE / 2 };
    const results = await Promise.all([withdraw("wowner", body), withdraw("wowner", body), withdraw("wowner", body)]);
    assert.deepEqual(results.map((r) => r.status).sort(), [201, 201, 400], JSON.stringify(results.map((r) => r.body)));
    const rows = await withdrawalsOf("wowner");
    assert.equal(rows.length, 2);
    assert.equal(rows.reduce((sum, r) => sum + r.amount, 0), BALANCE);
  });
});

// ============================================
// 2. A stored row with a non-numeric amount
// ============================================

describe("a stored withdrawal with amount 'abc' no longer breaks the balance (#287)", () => {
  before(async () => {
    // The exact row the old endpoint stored for `{ amount: "abc" }`.
    const now = new Date();
    await withoutRules(async (db) => {
      await db.collection("transactions").doc("legacy-abc").set({
        id: "legacy-abc", userId: accounts.badrow.uid, agentId: accounts.badrow.uid, type: "withdrawal",
        amount: "abc", currency: "NGN", status: "pending", isEscrow: false,
        paymentProvider: "manual", description: "Withdrawal to Test Bank 0123456789", createdAt: now, updatedAt: now,
      });
    });
  });

  test("GET /transactions/stats returns numbers, never NaN or null", async () => {
    const r = await api.call("GET", "/transactions/stats", tokens.badrow);
    assert.equal(r.status, 200);
    const ngn = r.body.data.byCurrency.find((row: any) => row.currency === "NGN");
    assert.deepEqual(ngn, { currency: "NGN", totalRevenue: BALANCE, pendingPayments: 0, availableBalance: BALANCE });
    for (const key of ["totalRevenue", "pendingPayments", "availableBalance"]) {
      assert.equal(Number.isSafeInteger(ngn[key]), true, `${key} must be an integer, got ${ngn[key]}`);
    }
  });

  test("a withdrawal over the real balance is refused (it passed before #287), the exact balance succeeds", async () => {
    const over = await withdraw("badrow", { bankAccountId: bankId("badrow"), amount: BALANCE + 1 });
    assert.equal(over.status, 400);
    assert.equal(over.body.message, "Insufficient balance");
    // Only the seeded bad row is a withdrawal so far.
    assert.deepEqual((await withdrawalsOf("badrow")).map((r) => r.id), ["legacy-abc"]);

    const exact = await withdraw("badrow", { bankAccountId: bankId("badrow"), amount: BALANCE });
    assert.equal(exact.status, 201);
  });
});

// ============================================
// 3. Role gate and validation on the real route
// ============================================

describe("POST /bank-accounts/withdraw refusals write nothing (#287)", () => {
  test("no token: 401", async () => {
    const r = await api.call("POST", "/bank-accounts/withdraw", undefined, { bankAccountId: bankId("plain"), amount: 1 });
    assert.equal(r.status, 401);
  });

  test("a client and an admin get 403 FORBIDDEN even with money and an account of their own", async () => {
    for (const name of ["wclient", "wadmin"]) {
      const r = await withdraw(name, { bankAccountId: bankId(name), amount: 1_000 });
      assert.equal(r.status, 403, `${name}: ${JSON.stringify(r.body)}`);
      assert.equal(r.body.error, "FORBIDDEN");
      assert.equal((await withdrawalsOf(name)).length, 0);
    }
  });

  test("bad amounts and bank account ids get 400 VALIDATION_ERROR; an unknown account 404", async () => {
    const good = bankId("plain");
    const bodies: unknown[] = [
      { bankAccountId: good, amount: "abc" },
      { bankAccountId: good, amount: "5000" },
      { bankAccountId: good, amount: 12.5 },
      { bankAccountId: good, amount: -100 },
      { bankAccountId: good, amount: 0 },
      { bankAccountId: good },
      { amount: 1_000 },
      { bankAccountId: "", amount: 1_000 },
      { bankAccountId: 42, amount: 1_000 },
    ];
    for (const body of bodies) {
      const r = await withdraw("plain", body);
      assert.equal(r.status, 400, `${JSON.stringify(body)} -> ${JSON.stringify(r.body)}`);
      assert.equal(r.body.error, "VALIDATION_ERROR");
    }
    // Someone else's account is "not found" for this caller.
    const other = await withdraw("plain", { bankAccountId: bankId("wclient"), amount: 1_000 });
    assert.equal(other.status, 404);

    // Nothing was written by any of the refusals: no row, no lock, and the
    // balance is still whole.
    assert.equal((await withdrawalsOf("plain")).length, 0);
    await withoutRules(async (db) => {
      assert.equal((await db.collection("withdrawalLocks").doc(accounts.plain.uid).get()).exists, false);
    });
    const stats = await api.call("GET", "/transactions/stats", tokens.plain);
    assert.equal(stats.body.data.byCurrency.find((r: any) => r.currency === "NGN").availableBalance, BALANCE);
  });
});

// ============================================
// 4. The lock collection is backend-only
// ============================================

describe("withdrawalLocks is closed to clients (#287)", () => {
  test("the agent the lock belongs to can neither read nor write it", async () => {
    // racer1 withdrew above, so its lock document exists.
    const uid = accounts.racer1.uid;
    await withoutRules(async (db) => {
      assert.equal((await db.collection("withdrawalLocks").doc(uid).get()).exists, true, "the lock must exist after a withdrawal");
    });
    const db = await clientDb(uid, { role: "agent", agencyId: null, admin: false });
    assert.equal(await isDenied(db.collection("withdrawalLocks").doc(uid).get()), true);
    assert.equal(await isDenied(db.collection("withdrawalLocks").doc(uid).set({ a: 1 })), true);
    assert.equal(await isDenied(db.collection("withdrawalLocks").doc(uid).delete()), true);
  });
});
