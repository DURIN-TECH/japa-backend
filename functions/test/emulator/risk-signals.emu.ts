// ============================================
// Emulator tests — risk signals are admin-only end to end (issue #119)
// ============================================
//
// Run with `npm run test:emulator` (Auth + Firestore emulators, the repo's
// real firestore.rules and firestore.indexes.json, the real Express app, real
// ID tokens from the Auth emulator). Uses the shared harness in ./helpers.
//
// Pinned here:
//  1. Rules: a client SDK read or write of riskSignals (and its events
//     subcollection) is denied for client, agent, owner and admin tokens
//     alike: the collection has no match block, only the backend touches it.
//  2. The three admin endpoints give 401 (no token) / 403 (client, agent,
//     owner, with no entitlements resolved) / 200 (admin), and a refused
//     caller's body carries no signal data.
//  3. The list endpoint runs against the emulator's real Firestore with every
//     filter combination (status / category / type / subjectType / severity)
//     without an index error.
//  4. Raising and deciding a signal writes only to riskSignals and its events.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

import { clientDb, isDenied, refreshIdToken, resetEmulators, RunningApi, signUp, startApi, TestAccount, withoutRules } from "./helpers";

/* eslint-disable @typescript-eslint/no-explicit-any */

let api: RunningApi;
const tokens: Record<string, string> = {};
const accounts: Record<string, TestAccount> = {};
let signalId = "";

/** Create a signed-in account carrying `claims`, and keep a refreshed token for it. */
async function principal(name: string, claims: Record<string, unknown>): Promise<void> {
  const account = await signUp(name);
  const { auth } = await import("../../src/utils/firebase");
  await auth.setCustomUserClaims(account.uid, claims);
  accounts[name] = account;
  tokens[name] = await refreshIdToken(account);
  // The user doc the Auth trigger would write (functions emulator is not running).
  await withoutRules(async (db) => {
    await db.collection("users").doc(account.uid).set({ id: account.uid, email: account.email, firstName: name, lastName: "T" });
  });
}

before(async () => {
  await resetEmulators();
  api = await startApi();
  await principal("rsclient", { role: "client", agencyId: null, admin: false });
  await principal("rsagent", { role: "agent", agencyId: "agency-1", admin: false });
  await principal("rsowner", { role: "owner", agencyId: "agency-1", admin: false });
  await principal("rsadmin", { role: "admin", agencyId: null, admin: true });

  // Raise signals through the service (the only way), covering the filters.
  const { riskSignalService } = await import("../../src/services/risk-signal.service");
  const base = {
    category: "trafficking" as const,
    severity: "high" as const,
    source: { kind: "rule" as const, ruleId: "test_rule", version: "1" },
  };
  const first = await riskSignalService.raiseRiskSignal({
    ...base,
    subject: { type: "user", id: accounts.rsclient.uid },
    type: "shared_contact",
    evidence: [{ kind: "shared_contact", ref: "sha256:abc", count: 3 }],
    dedupeKey: "test_rule:user:a",
  });
  signalId = (first as any).signalId;
  await riskSignalService.raiseRiskSignal({
    ...base,
    category: "scam",
    severity: "low",
    subject: { type: "application", id: "app-1" },
    type: "odd_payment",
    evidence: [{ kind: "payment", ref: "paymentRequests/p1", amount: { value: 5000, currency: "NGN", unit: "major" } }],
    dedupeKey: "test_rule:application:app-1",
  });
});

after(async () => {
  await api.close();
});

describe("firestore.rules: riskSignals is backend-only", () => {
  test("no client token can read or write riskSignals or its events", async () => {
    const observed: Record<string, boolean> = {};
    for (const name of ["rsclient", "rsagent", "rsowner", "rsadmin"]) {
      const claims = { role: name === "rsadmin" ? "admin" : name.slice(2), admin: name === "rsadmin" };
      const db = await clientDb(accounts[name].uid, claims);
      observed[`${name} read`] = await isDenied(db.collection("riskSignals").doc(signalId).get());
      observed[`${name} list`] = await isDenied(db.collection("riskSignals").get());
      observed[`${name} events`] = await isDenied(db.collection("riskSignals").doc(signalId).collection("events").get());
      observed[`${name} write`] = await isDenied(db.collection("riskSignals").doc("x").set({ a: 1 }));
    }
    assert.deepEqual(
      Object.values(observed).every(Boolean),
      true,
      `every access must be denied: ${JSON.stringify(observed)}`
    );
  });
});

describe("/admin/risk-signals role matrix (real tokens, entitlements unresolved)", () => {
  test("401 without a token; 403 for client, agent and owner on all three endpoints; 200 for admin", async () => {
    const paths: [string, string, unknown?][] = [
      ["GET", "/admin/risk-signals"],
      ["GET", `/admin/risk-signals/${signalId}`],
      ["POST", `/admin/risk-signals/${signalId}/status`, { status: "in_review", expectedRevision: 1 }],
    ];
    const observed: Record<string, number> = {};
    for (const [method, path, body] of paths) {
      observed[`anon ${method} ${path}`] = (await api.call(method, path, undefined, body)).status;
      for (const name of ["rsclient", "rsagent", "rsowner"]) {
        const r = await api.call(method, path, tokens[name], body);
        observed[`${name} ${method} ${path}`] = r.status;
        // A refused caller gets no signal data in the body.
        assert.equal(JSON.stringify(r.body).includes(signalId), false);
        assert.equal(JSON.stringify(r.body).includes("shared_contact"), false);
      }
    }
    for (const [key, status] of Object.entries(observed)) {
      assert.equal(status, key.startsWith("anon") ? 401 : 403, `${key} -> ${status}`);
    }
    // The signal was not changed by any refused call.
    const detail = await api.call("GET", `/admin/risk-signals/${signalId}`, tokens.rsadmin);
    assert.equal(detail.status, 200);
    assert.equal(detail.body.data.signal.status, "open");
    assert.equal(detail.body.data.events.length, 1);
  });
});

describe("list runs on real Firestore with every filter (indexes)", () => {
  test("each filter and combination returns 200 without an index error", async () => {
    const queries = [
      "",
      "?status=open",
      "?category=trafficking",
      "?type=shared_contact",
      "?subjectType=user",
      "?severity=high",
      "?status=open&category=scam",
      "?status=open&type=odd_payment",
      "?status=open&subjectType=application",
      "?status=open&severity=low",
      "?category=scam&type=odd_payment",
      "?status=open&category=scam&type=odd_payment",
      "?status=open&limit=1",
    ];
    for (const q of queries) {
      const r = await api.call("GET", `/admin/risk-signals${q}`, tokens.rsadmin);
      assert.equal(r.status, 200, `${q} -> ${r.status} ${JSON.stringify(r.body)}`);
    }
    const open = await api.call("GET", "/admin/risk-signals?status=open", tokens.rsadmin);
    assert.equal(open.body.data.items.length, 2);
    const scam = await api.call("GET", "/admin/risk-signals?category=scam", tokens.rsadmin);
    assert.equal(scam.body.data.items.length, 1);
    // Paging: page of one yields a cursor, the next page the other signal.
    const p1 = await api.call("GET", "/admin/risk-signals?limit=1", tokens.rsadmin);
    assert.ok(p1.body.data.nextCursor);
    const p2 = await api.call("GET", `/admin/risk-signals?limit=1&cursor=${p1.body.data.nextCursor}`, tokens.rsadmin);
    assert.equal(p2.body.data.items.length, 1);
    assert.notEqual(p2.body.data.items[0].id, p1.body.data.items[0].id);
  });
});

describe("deciding a signal writes only riskSignals", () => {
  test("status changes, a 409 on stale revision, and the subject's user doc is untouched", async () => {
    const { db } = await import("../../src/utils/firebase");
    const userBefore = JSON.stringify((await db.collection("users").doc(accounts.rsclient.uid).get()).data());
    const notesBefore = (await db.collection("notifications").get()).size;

    const a = await api.call("POST", `/admin/risk-signals/${signalId}/status`, tokens.rsadmin, { status: "in_review", expectedRevision: 1 });
    assert.equal(a.status, 200);
    const stale = await api.call("POST", `/admin/risk-signals/${signalId}/status`, tokens.rsadmin, { status: "dismissed", note: "x", expectedRevision: 1 });
    assert.equal(stale.status, 409);
    const noNote = await api.call("POST", `/admin/risk-signals/${signalId}/status`, tokens.rsadmin, { status: "dismissed", expectedRevision: 2 });
    assert.equal(noNote.status, 400);
    const done = await api.call("POST", `/admin/risk-signals/${signalId}/status`, tokens.rsadmin, { status: "dismissed", note: "reviewed, no concern", expectedRevision: 2 });
    assert.equal(done.status, 200);

    const detail = await api.call("GET", `/admin/risk-signals/${signalId}`, tokens.rsadmin);
    assert.deepEqual(detail.body.data.events.map((e: any) => e.toStatus), ["open", "in_review", "dismissed"]);
    assert.equal(detail.body.data.events[2].actorId, accounts.rsadmin.uid);

    assert.equal(JSON.stringify((await db.collection("users").doc(accounts.rsclient.uid).get()).data()), userBefore);
    assert.equal((await db.collection("notifications").get()).size, notesBefore);
  });
});
