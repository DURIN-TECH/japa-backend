// ============================================
// Unit tests — issue #345: earned money on a lapsed (read-only) plan
// ============================================
//
// Product owner decision (2026-11-15): an agent or agency owner whose plan
// has lapsed can still (1) withdraw the balance they already earned and
// (2) cancel their own unpaid payment request. `verifyAuth` exempts exactly
// those two writes from its read-only block; everything else stays
// 402 UPGRADE_REQUIRED, and every check INSIDE the two handlers still runs.
//
// Two layers are tested here:
//
//  A. The matcher (`isEarnedMoneyWrite`, pure): every allowed
//     method / path / body, and the near misses that must NOT be exempt.
//
//  B. The routes, through the REAL express app (`src/app.ts`: real
//     `express.json()`, real routers, real `verifyAuth`, real controllers)
//     listening on an ephemeral local port. Only the Firebase ID-token check
//     is stubbed (the bearer token names a test principal), and Firestore is
//     the in-memory fake of the payment-request harness. The plan comes from
//     the `entitlements/{subscriberId}` document exactly as in production
//     (`entitlementService.getEntitlements`), so a lapsed plan here is a
//     lapsed document, not a hand-set flag on the request.
//
// No emulator, no network beyond 127.0.0.1, no real Paystack call.
import { test, describe, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { ROLES } from "@durin-tech/authz";
import type { AuthzSubject } from "@durin-tech/authz";

import {
  usePaymentRequestHarness,
  resetPaymentRequests,
  reqFor,
  agentA,
  colleagueA,
  ownerA,
  agentB,
  clientNg,
  APP_A,
  paystackPaidRequest,
  paystackRequestStatus,
} from "../payment-requests/helpers";
import { captureRes, docsIn, seed, T0 } from "../consultations/harness";
import { fakeCollection, fakeRunTransaction, store } from "../helpers/fake-firestore";
import { isEarnedMoneyWrite } from "../../src/middleware/auth";
import { paymentRequestController } from "../../src/controllers/payment-request.controller";
import {
  transactionService,
  availableBalanceIn,
  WITHDRAWAL_CURRENCY,
} from "../../src/services/transaction.service";

/* eslint-disable @typescript-eslint/no-explicit-any */

// ============================================
// A. The exemption matcher
// ============================================

describe("isEarnedMoneyWrite: the two exempt writes (#345)", () => {
  /** A body that asks for the cancel. */
  const CANCEL = { status: "cancelled" };

  test("POST /bank-accounts/withdraw is exempt (optional /api prefix, trailing slash, any method case)", () => {
    for (const path of [
      "/bank-accounts/withdraw",
      "/bank-accounts/withdraw/",
      "/api/bank-accounts/withdraw",
      "/api/bank-accounts/withdraw/",
    ]) {
      assert.equal(isEarnedMoneyWrite("POST", path, { bankAccountId: "b", amount: 1 }), true, path);
      assert.equal(isEarnedMoneyWrite("post", path, undefined), true, `${path} (lower-case method, no body)`);
    }
  });

  test("PUT /payment-requests/<id>/status with status exactly \"cancelled\" is exempt", () => {
    for (const path of [
      "/payment-requests/abc123/status",
      "/payment-requests/abc123/status/",
      "/api/payment-requests/abc123/status",
      "/api/payment-requests/abc123/status/",
    ]) {
      assert.equal(isEarnedMoneyWrite("PUT", path, CANCEL), true, path);
      assert.equal(isEarnedMoneyWrite("put", path, CANCEL), true, `${path} (lower-case method)`);
    }
    // Extra body fields do not matter (the controller reads only `status`).
    assert.equal(isEarnedMoneyWrite("PUT", "/payment-requests/abc123/status", { status: "cancelled", note: "x" }), true);
  });

  test("the withdraw path under any other method is NOT exempt", () => {
    for (const method of ["PUT", "PATCH", "DELETE", "GET", "HEAD", "OPTIONS"]) {
      assert.equal(isEarnedMoneyWrite(method, "/bank-accounts/withdraw", {}), false, method);
    }
  });

  test("the cancel path under any other method is NOT exempt, even with the cancel body", () => {
    for (const method of ["POST", "PATCH", "DELETE", "GET"]) {
      assert.equal(isEarnedMoneyWrite(method, "/payment-requests/abc123/status", CANCEL), false, method);
    }
  });

  test("any other or missing status on the cancel path is NOT exempt", () => {
    const path = "/payment-requests/abc123/status";
    const bodies: Array<[string, unknown]> = [
      ["status paid", { status: "paid" }],
      ["status pending", { status: "pending" }],
      ["status approved", { status: "approved" }],
      ["status rejected", { status: "rejected" }],
      ["upper-case CANCELLED", { status: "CANCELLED" }],
      ["American spelling", { status: "canceled" }],
      ["padded", { status: " cancelled" }],
      ["trailing space", { status: "cancelled " }],
      ["array status", { status: ["cancelled"] }],
      ["object status", { status: { value: "cancelled" } }],
      ["String object", { status: new String("cancelled") }],
      ["true", { status: true }],
      ["null status", { status: null }],
      ["no status key", {}],
      ["status under another key", { Status: "cancelled" }],
      ["nested", { data: { status: "cancelled" } }],
      ["undefined body", undefined],
      ["null body", null],
      ["string body", "cancelled"],
      ["JSON string body", "{\"status\":\"cancelled\"}"],
      ["array body", ["cancelled"]],
      ["array of objects body", [{ status: "cancelled" }]],
      ["number body", 1],
    ];
    for (const [label, body] of bodies) {
      assert.equal(isEarnedMoneyWrite("PUT", path, body), false, label);
    }
  });

  test("bank-account writes other than withdraw are NOT exempt (#359 is a separate decision)", () => {
    const cases: Array<[string, string]> = [
      ["POST", "/bank-accounts"],
      ["POST", "/bank-accounts/"],
      ["PUT", "/bank-accounts/bank-1/main"],
      ["DELETE", "/bank-accounts/bank-1"],
      ["DELETE", "/bank-accounts/withdraw"],
      ["POST", "/bank-accounts/bank-1/withdraw"],
      ["POST", "/bank-accounts/withdraw/again"],
      ["POST", "/bank-accounts/withdrawals"],
      ["POST", "/bank-accounts/withdraw-all"],
    ];
    for (const [method, path] of cases) {
      assert.equal(isEarnedMoneyWrite(method, path, { status: "cancelled" }), false, `${method} ${path}`);
    }
  });

  test("payment-request writes other than the cancel are NOT exempt", () => {
    const cases: Array<[string, string]> = [
      ["POST", "/payment-requests"],
      ["DELETE", "/payment-requests/abc123"],
      ["PUT", "/payment-requests/abc123"],
      ["PUT", "/payment-requests/abc123/approve"],
      ["PUT", "/payment-requests/abc123/reject"],
      ["POST", "/payment-requests/abc123/checkout"],
      ["POST", "/payment-requests/abc123/verify"],
      // The id must be exactly one non-empty segment.
      ["PUT", "/payment-requests/status"],
      ["PUT", "/payment-requests//status"],
      ["PUT", "/payment-requests/abc/def/status"],
      ["PUT", "/payment-requests/abc123/status/extra"],
      ["PUT", "/payment-requests/abc123/statuses"],
      ["PUT", "/payment-requests/abc123/status//"],
    ];
    for (const [method, path] of cases) {
      assert.equal(isEarnedMoneyWrite(method, path, { status: "cancelled" }), false, `${method} ${path}`);
    }
  });

  test("another path that merely ENDS in /withdraw or /status is NOT exempt (anchored, not endsWith)", () => {
    const cases: Array<[string, string]> = [
      ["PUT", "/applications/app-1/status"],
      ["POST", "/applications/app-1/withdraw"],
      ["PUT", "/consultations/c-1/status"],
      ["PUT", "/agents/a-1/status"],
      ["PUT", "/documents/d-1/status"],
      ["POST", "/admin/risk-signals/r-1/status"],
      // A longer path that only ends with an exempt path.
      ["POST", "/x/bank-accounts/withdraw"],
      ["POST", "/applications/bank-accounts/withdraw"],
      ["PUT", "/x/payment-requests/abc123/status"],
      ["PUT", "/applications/payment-requests/abc123/status"],
      // Only ONE optional /api prefix, and only that prefix.
      ["POST", "/api/api/bank-accounts/withdraw"],
      ["POST", "/v1/bank-accounts/withdraw"],
      ["POST", "/apibank-accounts/withdraw"],
      ["POST", "bank-accounts/withdraw"],
      // Case-sensitive: a differently-cased URL fails closed.
      ["POST", "/Bank-Accounts/Withdraw"],
      ["PUT", "/Payment-Requests/abc123/Status"],
      // The query string is stripped by the caller; one left in is not exempt.
      ["POST", "/bank-accounts/withdraw?x=1"],
      ["PUT", "/payment-requests/abc123/status?status=cancelled"],
      // Encoded separators / whitespace are not the exact path.
      ["POST", "/bank-accounts%2Fwithdraw"],
      ["POST", "/bank-accounts/withdraw%2F"],
      ["POST", "/bank-accounts/withdraw\n"],
      ["POST", " /bank-accounts/withdraw"],
    ];
    for (const [method, path] of cases) {
      assert.equal(isEarnedMoneyWrite(method, path, { status: "cancelled" }), false, `${method} ${JSON.stringify(path)}`);
    }
  });
});

// ============================================
// B. The routes, through the real app
// ============================================

// ---- Principals --------------------------------------------------------

/** A platform admin (never read-only: admins have no plan). */
const admin: AuthzSubject = { uid: "uid-admin", role: ROLES.ADMIN, agencyId: null };

/** Bearer token -> principal. The stubbed token check reads its claims from here. */
const PRINCIPALS: Record<string, AuthzSubject> = Object.fromEntries(
  [agentA, colleagueA, ownerA, agentB, clientNg, admin].map((p) => [p.uid, p])
);

// ---- Plans -------------------------------------------------------------

/** Subscriber ids: an agency member draws from the agency, a client from themself. */
const SUBSCRIBERS = ["agency-a", "agency-b", clientNg.uid];

/** The three plan states of the "unchanged elsewhere" criterion. */
type PlanState = "lapsed" | "active" | "none";

/**
 * Put every subscriber on `state`:
 *  - "lapsed": an `entitlements` doc with status `past_due` (read-only);
 *  - "active": the same doc with status `active`;
 *  - "none":   no doc at all (no resolved plan: RBAC only, never read-only).
 */
function setPlan(state: PlanState): void {
  for (const id of SUBSCRIBERS) {
    if (state === "none") {
      store.delete(`entitlements/${id}`);
      continue;
    }
    store.set(`entitlements/${id}`, {
      subscriberType: id.startsWith("agency-") ? "agency" : "client",
      subscriberId: id,
      planId: "plan-test",
      status: state === "lapsed" ? "past_due" : "active",
      features: [],
      limits: {},
    });
  }
}

// ---- Money fixtures (same shapes as test/transactions/withdrawal-checks) ----

/** Every agent's NGN balance at the start of a test: 500,000 kobo (5,000 naira). */
const BALANCE = 500_000;

/** Bank account ids, one per principal. */
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

/** Seed a settled NGN payment to `agentUid` (what gives them a balance). */
async function seedEarning(id: string, agentUid: string): Promise<void> {
  await seed("transactions", id, {
    userId: "uid-some-client",
    agentId: agentUid,
    type: "escrow_release",
    amount: BALANCE,
    currency: "NGN",
    status: "released",
    isEscrow: false,
    paymentProvider: "paystack",
    description: "fixture",
    createdAt: T0,
    updatedAt: T0,
  });
}

/**
 * Everyone gets a bank account and an earning row (the client and the admin
 * too, so their 403 is proven to come from the ROLE, not an empty balance).
 */
async function seedMoney(): Promise<void> {
  await seedAccount(ACCOUNT.agentA, agentA.uid);
  await seedAccount(ACCOUNT.ownerA, ownerA.uid);
  await seedAccount(ACCOUNT.agentB, agentB.uid);
  await seedAccount(ACCOUNT.client, clientNg.uid);
  await seedAccount(ACCOUNT.admin, admin.uid);
  await seedEarning("earn-agent-a", agentA.uid);
  await seedEarning("earn-owner-a", ownerA.uid);
  await seedEarning("earn-client", clientNg.uid);
  await seedEarning("earn-admin", admin.uid);
}

/** Every stored withdrawal row, as [id, data]. */
const withdrawals = () => docsIn("transactions").filter(([, data]) => data.type === "withdrawal");

/** Agent A's NGN available balance, as the withdrawal check computes it. */
async function balanceOf(p: AuthzSubject): Promise<number> {
  return availableBalanceIn(await transactionService.getStatsForAgent(p.uid), WITHDRAWAL_CURRENCY);
}

// ---- Payment-request fixtures ---------------------------------------------

/** $150.00 at NGN 1,500/$ = 22,500,000 kobo (the harness rate). */
const NGN_KOBO = 22_500_000;

const stored = (id: string) => store.get(`paymentRequests/${id}`) as any;

/**
 * Create a $150 request on agency A's case as agent A, calling the controller
 * directly (no `verifyAuth`): the request was made while the plan was still
 * active; the tests then act on it over HTTP on a lapsed plan.
 */
async function createRequest(): Promise<string> {
  const { out, res } = captureRes();
  await paymentRequestController.createPaymentRequest(
    reqFor(agentA, { body: { applicationId: APP_A, amount: "150.00", description: "Visa Processing Fee" } }),
    res
  );
  assert.equal(out.status, 201, JSON.stringify(out.body));
  return out.body.data.id;
}

/** The client approves `id` (controller call); returns the checkout reference. */
async function approveRef(id: string): Promise<string> {
  const { out, res } = captureRes();
  await paymentRequestController.approvePaymentRequest(reqFor(clientNg, { params: { id } }), res);
  assert.equal(out.status, 200, JSON.stringify(out.body));
  return out.body.data.paystackReference;
}

// ---- HTTP ---------------------------------------------------------------

let server: Server;
let baseUrl = "";
let restoreVerify: (() => void) | undefined;

/**
 * Send `method path` to the real app as `who`.
 * `body`: an object is sent as JSON; `undefined` sends no body at all; a
 * `{ raw, contentType }` pair sends those bytes as is (non-JSON bodies).
 */
async function call(
  who: AuthzSubject,
  method: string,
  path: string,
  body?: unknown
): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = { Authorization: `Bearer ${who.uid}` };
  let payload: string | undefined;
  if (body && typeof body === "object" && "raw" in (body as any)) {
    payload = (body as any).raw;
    headers["Content-Type"] = (body as any).contentType;
  } else if (body !== undefined) {
    payload = JSON.stringify(body);
    headers["Content-Type"] = "application/json";
  }
  const res = await fetch(`${baseUrl}${path}`, { method, headers, body: payload });
  const text = await res.text();
  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  return { status: res.status, body: parsed };
}

/** POST /bank-accounts/withdraw as `who`. */
const withdraw = (who: AuthzSubject, body: unknown) => call(who, "POST", "/bank-accounts/withdraw", body);

/** PUT /payment-requests/:id/status as `who` (default: agent A, the creator). */
const setStatus = (id: string, body: unknown, who: AuthzSubject = agentA) =>
  call(who, "PUT", `/payment-requests/${id}/status`, body);

/** Assert the read-only block answered (and with its exact code and message). */
function assertUpgradeRequired(out: { status: number; body: any }, label: string): void {
  assert.equal(out.status, 402, `${label}: ${JSON.stringify(out.body)}`);
  assert.equal(out.body.success, false, label);
  assert.equal(out.body.error, "UPGRADE_REQUIRED", label);
  assert.equal(out.body.message, "Your plan is read-only. Renew your subscription to make changes.", label);
}

/** A snapshot of the whole fake store, to prove a refused call wrote nothing. */
const snapshot = () => JSON.stringify([...store.entries()]);

// ---- Harness ---------------------------------------------------------------

before(async () => {
  await usePaymentRequestHarness();
  const firebase: any = await import("../../src/utils/firebase");
  // Collections these paths touch that the shared harness does not fake:
  // the plan cache `verifyAuth` reads, and the withdrawal path's two.
  firebase.collections.entitlements = fakeCollection("entitlements");
  firebase.collections.bankAccounts = fakeCollection("bankAccounts");
  firebase.collections.withdrawalLocks = fakeCollection("withdrawalLocks");
  // The in-memory transaction neither isolates nor retries; real Firestore
  // serialises conflicting transactions, so run ours one at a time (same
  // approach as test/transactions/withdrawal-checks.test.ts).
  let chain: Promise<unknown> = Promise.resolve();
  (transactionService as any).runTransaction = (fn: any) => {
    const run = chain.then(() => fakeRunTransaction(fn));
    chain = run.catch(() => undefined);
    return run;
  };

  // The ONLY auth stub: the bearer token is a test principal's uid, and its
  // claims (role, agencyId) are that principal's. Everything after the token
  // check in `verifyAuth` (entitlements lookup, read-only block) is real.
  const originalVerify = firebase.auth.verifyIdToken;
  firebase.auth.verifyIdToken = async (token: string) => {
    const p = PRINCIPALS[token];
    if (!p) throw new Error(`unknown test token ${token}`);
    return { uid: p.uid, role: p.role, agencyId: p.agencyId };
  };
  restoreVerify = () => {
    firebase.auth.verifyIdToken = originalVerify;
  };

  const { app } = await import("../../src/app");
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const { port } = server.address() as { port: number };
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  restoreVerify?.();
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(async () => {
  await resetPaymentRequests();
  await seedMoney();
  // Every test starts on a lapsed plan unless it says otherwise.
  setPlan("lapsed");
  // The app logs every request, and the controllers log refusals.
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  console.log = () => {};
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  console.error = () => {};
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  console.warn = () => {};
});

// ============================================
// Withdraw on a lapsed plan
// ============================================

describe("POST /bank-accounts/withdraw on a lapsed plan (#345)", () => {
  test("sanity: the plan really is read-only (another write by the same agent is 402)", async () => {
    assertUpgradeRequired(
      await call(agentA, "POST", "/bank-accounts", { accountName: "A", bankName: "B", accountNumber: "0123456789" }),
      "POST /bank-accounts"
    );
  });

  test("an agent withdraws earned money: 201, a pending NGN withdrawal, the balance drops by the amount", async () => {
    assert.equal(await balanceOf(agentA), BALANCE);
    const out = await withdraw(agentA, { bankAccountId: ACCOUNT.agentA, amount: 120_000 });
    assert.equal(out.status, 201, JSON.stringify(out.body));
    assert.equal(out.body.success, true);
    assert.equal(out.body.data.type, "withdrawal");
    assert.equal(out.body.data.status, "pending");
    assert.equal(out.body.data.currency, "NGN");
    assert.equal(out.body.data.amount, 120_000);
    assert.equal(out.body.data.agentId, agentA.uid);
    // Exactly one row stored, and the balance is down by exactly the amount.
    const rows = withdrawals();
    assert.equal(rows.length, 1);
    assert.equal(rows[0][0], out.body.data.id);
    assert.equal(await balanceOf(agentA), BALANCE - 120_000);
  });

  test("an agency owner withdraws their own earned money too (trailing slash tolerated)", async () => {
    const out = await call(ownerA, "POST", "/bank-accounts/withdraw/", { bankAccountId: ACCOUNT.ownerA, amount: BALANCE });
    assert.equal(out.status, 201, JSON.stringify(out.body));
    assert.equal(await balanceOf(ownerA), 0);
    // Agent A's balance is untouched.
    assert.equal(await balanceOf(agentA), BALANCE);
  });

  // ---- Every existing refusal is unchanged, and writes nothing ----

  /** Assert a refusal by the CONTROLLER (not the plan block) that wrote nothing. */
  async function assertRefused(
    run: () => Promise<{ status: number; body: any }>,
    status: number,
    error: string,
    label: string,
    message?: string
  ): Promise<void> {
    const before = snapshot();
    const out = await run();
    assert.equal(out.status, status, `${label}: ${JSON.stringify(out.body)}`);
    assert.equal(out.body.error, error, label);
    if (message) assert.equal(out.body.message, message, label);
    assert.equal(snapshot(), before, `${label}: nothing may be written`);
    assert.equal(withdrawals().length, 0, label);
  }

  test("a client is still 403 FORBIDDEN, nothing written", async () => {
    await assertRefused(
      () => withdraw(clientNg, { bankAccountId: ACCOUNT.client, amount: 1_000 }),
      403, "FORBIDDEN", "client"
    );
  });

  test("an admin is still 403 FORBIDDEN, nothing written", async () => {
    await assertRefused(
      () => withdraw(admin, { bankAccountId: ACCOUNT.admin, amount: 1_000 }),
      403, "FORBIDDEN", "admin"
    );
  });

  for (const [label, amount] of [
    ["a numeric string \"5000\"", "5000"],
    ["zero", 0],
    ["a negative number", -1],
    ["a fraction", 1.5],
  ] as Array<[string, unknown]>) {
    test(`amount ${label} is still 400 VALIDATION_ERROR, nothing written`, async () => {
      await assertRefused(
        () => withdraw(agentA, { bankAccountId: ACCOUNT.agentA, amount }),
        400, "VALIDATION_ERROR", label
      );
    });
  }

  test("a missing amount, and no body at all, are still 400, nothing written", async () => {
    await assertRefused(() => withdraw(agentA, { bankAccountId: ACCOUNT.agentA }), 400, "VALIDATION_ERROR", "no amount");
    await assertRefused(() => withdraw(agentA, undefined), 400, "VALIDATION_ERROR", "no body");
  });

  test("a missing bankAccountId is still 400 VALIDATION_ERROR, nothing written", async () => {
    await assertRefused(() => withdraw(agentA, { amount: 1_000 }), 400, "VALIDATION_ERROR", "no bankAccountId");
  });

  test("another user's bank account is still 404, nothing written", async () => {
    await assertRefused(
      () => withdraw(agentA, { bankAccountId: ACCOUNT.agentB, amount: 1_000 }),
      404, "NOT_FOUND", "foreign account"
    );
    // A colleague's account in the SAME agency is not the caller's either.
    await assertRefused(
      () => withdraw(agentA, { bankAccountId: ACCOUNT.ownerA, amount: 1_000 }),
      404, "NOT_FOUND", "same-agency account"
    );
  });

  test("more than the NGN balance is still 400 \"Insufficient balance\", nothing written", async () => {
    await assertRefused(
      () => withdraw(agentA, { bankAccountId: ACCOUNT.agentA, amount: BALANCE + 1 }),
      400, "VALIDATION_ERROR", "over balance", "Insufficient balance"
    );
    // An agent with no NGN balance at all (agent B has an account, no earning).
    await assertRefused(
      () => withdraw(agentB, { bankAccountId: ACCOUNT.agentB, amount: 1 }),
      400, "VALIDATION_ERROR", "no balance", "Insufficient balance"
    );
  });

  test("the held balance still counts: a second withdrawal for the same money is refused", async () => {
    assert.equal((await withdraw(agentA, { bankAccountId: ACCOUNT.agentA, amount: BALANCE })).status, 201);
    const second = await withdraw(agentA, { bankAccountId: ACCOUNT.agentA, amount: 1 });
    assert.equal(second.status, 400);
    assert.equal(second.body.message, "Insufficient balance");
    assert.equal(withdrawals().length, 1);
  });
});

// ============================================
// Cancel on a lapsed plan
// ============================================

describe("PUT /payment-requests/:id/status {status:\"cancelled\"} on a lapsed plan (#345)", () => {
  test("the creating agent cancels their own PENDING request: 200, the request is cancelled", async () => {
    const id = await createRequest();
    const out = await setStatus(id, { status: "cancelled" });
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.equal(stored(id).status, "cancelled");
    assert.ok(stored(id).cancelledAt);
  });

  test("the creating agent cancels their own APPROVED, unpaid request: 200, cancelled", async () => {
    for (const final of ["abandoned", "failed"]) {
      const id = await createRequest();
      const ref = await approveRef(id);
      paystackRequestStatus(ref, id, final);
      const out = await setStatus(id, { status: "cancelled" });
      assert.equal(out.status, 200, `${final}: ${JSON.stringify(out.body)}`);
      assert.equal(stored(id).status, "cancelled");
    }
  });

  // ---- Every existing refusal is unchanged ----

  test("a colleague, the agency owner and another agency's agent are still 403; nothing changes", async () => {
    const id = await createRequest();
    for (const who of [colleagueA, ownerA, agentB]) {
      const before = snapshot();
      const out = await setStatus(id, { status: "cancelled" }, who);
      assert.equal(out.status, 403, `${who.uid}: ${JSON.stringify(out.body)}`);
      assert.equal(snapshot(), before, who.uid);
    }
    assert.equal(stored(id).status, "pending");
  });

  test("a paid request is still 409 REQUEST_ALREADY_PAID", async () => {
    const id = await createRequest();
    store.set(`paymentRequests/${id}`, { ...stored(id), status: "paid" });
    const before = snapshot();
    const out = await setStatus(id, { status: "cancelled" });
    assert.equal(out.status, 409, JSON.stringify(out.body));
    assert.equal(out.body.error, "REQUEST_ALREADY_PAID");
    assert.equal(snapshot(), before);
  });

  test("Paystack reporting the checkout paid at cancel time: 409 REQUEST_ALREADY_PAID, settled, never cancelled", async () => {
    const id = await createRequest();
    const ref = await approveRef(id);
    paystackPaidRequest(ref, id, { amountMinor: NGN_KOBO, currency: "NGN" });
    const out = await setStatus(id, { status: "cancelled" });
    assert.equal(out.status, 409, JSON.stringify(out.body));
    assert.equal(out.body.error, "REQUEST_ALREADY_PAID");
    assert.equal(stored(id).status, "paid");
  });

  test("a rejected, cancelled or expired request is still 409 INVALID_STATUS_TRANSITION", async () => {
    for (const s of ["rejected", "cancelled", "expired"]) {
      const id = await createRequest();
      store.set(`paymentRequests/${id}`, { ...stored(id), status: s });
      const before = snapshot();
      const out = await setStatus(id, { status: "cancelled" });
      assert.equal(out.status, 409, `${s}: ${JSON.stringify(out.body)}`);
      assert.equal(out.body.error, "INVALID_STATUS_TRANSITION", s);
      assert.equal(snapshot(), before, s);
    }
  });

  for (const inFlight of ["ongoing", "pending", "processing", "queued"]) {
    test(`a payment in flight (Paystack "${inFlight}") is still 409 PAYMENT_IN_PROGRESS; nothing changes`, async () => {
      const id = await createRequest();
      const ref = await approveRef(id);
      paystackRequestStatus(ref, id, inFlight);
      const before = { ...stored(id) };
      const out = await setStatus(id, { status: "cancelled" });
      assert.equal(out.status, 409, JSON.stringify(out.body));
      assert.equal(out.body.error, "PAYMENT_IN_PROGRESS");
      assert.deepEqual(stored(id), before);
    });
  }

  test("an unknown request id is still 404", async () => {
    const out = await setStatus("no-such-request", { status: "cancelled" });
    assert.equal(out.status, 404, JSON.stringify(out.body));
  });
});

// ============================================
// Everything else stays 402 on a lapsed plan
// ============================================

describe("still 402 UPGRADE_REQUIRED on a lapsed plan (#345)", () => {
  test("PUT /payment-requests/:id/status with any other, missing or malformed status; the request is untouched", async () => {
    const id = await createRequest();
    const before = snapshot();
    const bodies: Array<[string, unknown]> = [
      ["status paid", { status: "paid" }],
      ["status pending", { status: "pending" }],
      ["status approved", { status: "approved" }],
      ["status rejected", { status: "rejected" }],
      ["upper-case CANCELLED", { status: "CANCELLED" }],
      ["American spelling", { status: "canceled" }],
      ["array status", { status: ["cancelled"] }],
      ["object status", { status: { $eq: "cancelled" } }],
      ["empty object", {}],
      ["no body at all", undefined],
      ["JSON array body", ["cancelled"]],
      ["array of objects body", [{ status: "cancelled" }]],
      // Not parsed by express.json(): the body never becomes an object.
      ["text/plain body", { raw: "{\"status\":\"cancelled\"}", contentType: "text/plain" }],
      ["form body", { raw: "status=cancelled", contentType: "application/x-www-form-urlencoded" }],
    ];
    for (const [label, body] of bodies) {
      assertUpgradeRequired(await setStatus(id, body), label);
    }
    // A status in the query string is not the body.
    assertUpgradeRequired(
      await call(agentA, "PUT", `/payment-requests/${id}/status?status=cancelled`, { status: "paid" }),
      "query-string status"
    );
    assert.equal(snapshot(), before, "nothing was written");
    assert.equal(stored(id).status, "pending");
  });

  test("the cancel body under another method or on another payment-request route", async () => {
    const id = await createRequest();
    const before = snapshot();
    const cancel = { status: "cancelled" };
    assertUpgradeRequired(await call(agentA, "POST", "/payment-requests", {
      applicationId: APP_A, amount: "10.00", description: "x", status: "cancelled",
    }), "POST /payment-requests");
    assertUpgradeRequired(await call(agentA, "DELETE", `/payment-requests/${id}`, cancel), "DELETE /payment-requests/:id");
    assertUpgradeRequired(await call(clientNg, "PUT", `/payment-requests/${id}/approve`, cancel), "PUT /:id/approve");
    assertUpgradeRequired(await call(clientNg, "PUT", `/payment-requests/${id}/reject`, cancel), "PUT /:id/reject");
    assertUpgradeRequired(await call(clientNg, "POST", `/payment-requests/${id}/checkout`, cancel), "POST /:id/checkout");
    assertUpgradeRequired(await call(clientNg, "POST", `/payment-requests/${id}/verify`, cancel), "POST /:id/verify");
    assert.equal(snapshot(), before, "nothing was written");
  });

  test("the other bank-account writes: add, set main, remove (#359 is a separate decision)", async () => {
    const before = snapshot();
    assertUpgradeRequired(
      await call(agentA, "POST", "/bank-accounts", { accountName: "A", bankName: "B", accountNumber: "0123456789" }),
      "POST /bank-accounts"
    );
    assertUpgradeRequired(await call(agentA, "PUT", `/bank-accounts/${ACCOUNT.agentA}/main`, {}), "PUT /bank-accounts/:id/main");
    assertUpgradeRequired(await call(agentA, "DELETE", `/bank-accounts/${ACCOUNT.agentA}`), "DELETE /bank-accounts/:id");
    assert.equal(snapshot(), before, "nothing was written");
  });

  test("another route that merely ends in /status, with the cancel body", async () => {
    const before = snapshot();
    const cancel = { status: "cancelled" };
    assertUpgradeRequired(await call(agentA, "PUT", `/applications/${APP_A}/status`, cancel), "PUT /applications/:id/status");
    assertUpgradeRequired(await call(agentA, "PUT", "/consultations/c-1/status", cancel), "PUT /consultations/:id/status");
    assertUpgradeRequired(await call(agentA, "PUT", "/documents/d-1/status", cancel), "PUT /documents/:id/status");
    assert.equal(snapshot(), before, "nothing was written");
  });

  test("a differently-cased withdraw URL reaches the route (express is case-insensitive) but is NOT exempt", async () => {
    const before = snapshot();
    assertUpgradeRequired(
      await call(agentA, "POST", "/Bank-Accounts/Withdraw", { bankAccountId: ACCOUNT.agentA, amount: 1_000 }),
      "POST /Bank-Accounts/Withdraw"
    );
    assert.equal(snapshot(), before, "nothing was written");
  });

  test("no route exists for POST /applications/:id/withdraw: it is never served (404), on any plan", async () => {
    // Not mounted today, so the plan block is never reached; the matcher test
    // above proves it would not be exempt if it were added.
    const out = await call(agentA, "POST", `/applications/${APP_A}/withdraw`, { status: "cancelled" });
    assert.equal(out.status, 404, JSON.stringify(out.body));
  });

  test("reads are untouched: GET /bank-accounts is 200", async () => {
    const out = await call(agentA, "GET", "/bank-accounts");
    assert.equal(out.status, 200, JSON.stringify(out.body));
  });
});

// ============================================
// Active plan / no resolved plan: unchanged
// ============================================

for (const plan of ["active", "none"] as const) {
  describe(`behaviour is unchanged with ${plan === "active" ? "an active plan" : "no resolved plan"} (#345)`, () => {
    beforeEach(() => setPlan(plan));

    test("withdraw: 201 for the agent; the controller's refusals as before", async () => {
      const ok = await withdraw(agentA, { bankAccountId: ACCOUNT.agentA, amount: 1_000 });
      assert.equal(ok.status, 201, JSON.stringify(ok.body));
      assert.equal(await balanceOf(agentA), BALANCE - 1_000);
      assert.equal((await withdraw(clientNg, { bankAccountId: ACCOUNT.client, amount: 1_000 })).status, 403);
      assert.equal((await withdraw(agentA, { bankAccountId: ACCOUNT.agentA, amount: "5000" })).status, 400);
      assert.equal((await withdraw(agentA, { bankAccountId: ACCOUNT.agentB, amount: 1_000 })).status, 404);
      const over = await withdraw(agentA, { bankAccountId: ACCOUNT.agentA, amount: BALANCE });
      assert.equal(over.status, 400);
      assert.equal(over.body.message, "Insufficient balance");
    });

    test("cancel: 200 for the creator, 403 for a colleague", async () => {
      const id = await createRequest();
      assert.equal((await setStatus(id, { status: "cancelled" }, colleagueA)).status, 403);
      const out = await setStatus(id, { status: "cancelled" });
      assert.equal(out.status, 200, JSON.stringify(out.body));
      assert.equal(stored(id).status, "cancelled");
    });

    test("another or missing status reaches the controller's own 400 (never 402)", async () => {
      const id = await createRequest();
      for (const body of [{ status: "paid" }, { status: "pending" }, {}]) {
        const out = await setStatus(id, body);
        assert.equal(out.status, 400, JSON.stringify(out.body));
        assert.equal(out.body.error, "VALIDATION_ERROR");
      }
      assert.equal(stored(id).status, "pending");
    });

    test("the other writes are not plan-blocked (never 402)", async () => {
      const id = await createRequest();
      const outs = [
        await call(agentA, "PUT", `/bank-accounts/${ACCOUNT.agentA}/main`, {}),
        await call(agentA, "DELETE", `/payment-requests/${id}`),
      ];
      for (const out of outs) assert.notEqual(out.status, 402, JSON.stringify(out.body));
    });
  });
}
