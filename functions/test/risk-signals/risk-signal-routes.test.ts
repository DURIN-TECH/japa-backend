// ============================================
// Unit tests — /admin/risk-signals routes, role matrix and no leaks (issue #119)
// ============================================
//
// Run with `npm test`. Hermetic: NO network and NO emulator. The real Express
// app (src/app.ts) is started on an ephemeral localhost port; Firestore refs
// are the in-memory fake and `auth.verifyIdToken` is stubbed to map a test
// token to a token payload. `attachAuthz` then builds the CASL ability the
// same way production does.
//
// Covers:
//  - the mounted route table: only list, get and status are exposed, and there
//    is no POST / (a signal cannot be created over HTTP);
//  - 401 without a token, 403 for client / agent / agency owner, 200 for an
//    admin, on all three endpoints, with no signal data in a refused body;
//  - no non-admin-readable response (applications, users/me, agency pages,
//    conversations, notifications, document requests) contains a signal id,
//    or the keys riskSignal / riskSignals / dedupeKey — searched recursively
//    over the serialised JSON, for client, agent and owner callers.

import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { Timestamp } from "firebase-admin/firestore";

import { app } from "../../src/app";
import { auth } from "../../src/utils/firebase";
import { adminRiskSignalRoutes } from "../../src/routes/risk-signal.routes";
import { riskSignalService } from "../../src/services/risk-signal.service";
import { installFakes, resetStore, store } from "../helpers/fake-firestore";
import type { RaiseRiskSignalInput } from "../../src/types/risk-signal";

/* eslint-disable @typescript-eslint/no-explicit-any */

// ============================================
// Principals
// ============================================

/** Test token -> the payload verifyIdToken would return. */
const PRINCIPALS = {
  admin: { uid: "uid-admin", role: "admin" },
  client: { uid: "uid-client", role: "client" },
  agent: { uid: "uid-agent", role: "agent", agencyId: "agency-1" },
  owner: { uid: "uid-owner", role: "owner", agencyId: "agency-1" },
} as const;

type Principal = keyof typeof PRINCIPALS;

const AGENCY = "agency-1";
const APPLICATION = "app-1";

// ============================================
// Harness
// ============================================

let server: Server;
let base = "";
let originalVerify: typeof auth.verifyIdToken;

/** A raise input for `subject` under a unique dedupe key. */
function signalInput(subject: RaiseRiskSignalInput["subject"]): RaiseRiskSignalInput {
  return {
    subject,
    category: "trafficking",
    type: "shared_contact",
    severity: "high",
    evidence: [{ kind: "shared_phone_hash", ref: `sha256:${subject.type}-${subject.id}`, count: 3 }],
    source: { kind: "rule", ruleId: "shared_contact_v1", version: "1.0.0" },
    dedupeKey: `rule:shared_contact:${subject.type}:${subject.id}`,
  };
}

interface CallResult {
  status: number;
  json: any;
  text: string;
}

/** Call the local app. `token` omitted -> no Authorization header. */
async function call(
  path: string,
  opts: { token?: Principal; method?: string; body?: unknown } = {}
): Promise<CallResult> {
  const headers: Record<string, string> = {};
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(`${base}${path}`, {
    method: opts.method ?? "GET",
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: res.status, json, text };
}

/** Every key at any depth of a parsed JSON value. */
function allKeys(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) allKeys(item, out);
  } else if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      out.push(key);
      allKeys(child, out);
    }
  }
  return out;
}

/** Assert a response holds no trace of a risk signal. */
function assertNoSignalLeak(result: CallResult, signalIds: string[], where: string): void {
  for (const id of signalIds) {
    assert.equal(result.text.includes(id), false, `${where}: leaked signal id ${id}`);
  }
  const keys = allKeys(result.json);
  for (const forbidden of ["riskSignal", "riskSignals", "dedupeKey"]) {
    assert.equal(keys.includes(forbidden), false, `${where}: leaked key ${forbidden}`);
  }
  assert.equal(result.text.includes("dedupeKey"), false, `${where}: serialised body mentions dedupeKey`);
}

/** Seed the subject records and a normal, signal-free set of readable docs. */
async function seedSubjects(): Promise<void> {
  for (const p of Object.values(PRINCIPALS)) {
    store.set(`users/${p.uid}`, {
      uid: p.uid,
      role: p.role,
      email: `delivered+${p.role}@resend.dev`,
      firstName: p.role,
      lastName: "Test",
      createdAt: Timestamp.fromMillis(1_700_000_000_000),
    });
  }
  // Agent profiles: the agent is assigned to the case; the owner owns the agency.
  store.set("agents/agent-doc-agent", {
    id: "agent-doc-agent",
    userId: PRINCIPALS.agent.uid,
    agencyId: AGENCY,
    agencyRole: "agent",
    displayName: "Agent Test",
  });
  store.set("agents/agent-doc-owner", {
    id: "agent-doc-owner",
    userId: PRINCIPALS.owner.uid,
    agencyId: AGENCY,
    agencyRole: "owner",
    displayName: "Owner Test",
  });

  store.set(`agencies/${AGENCY}`, {
    id: AGENCY,
    name: "Acme Travel",
    slug: "acme-travel",
    ownerId: PRINCIPALS.owner.uid,
    approvalStatus: "approved",
    createdAt: Timestamp.fromMillis(1_700_000_000_000),
  });

  store.set(`applications/${APPLICATION}`, {
    id: APPLICATION,
    userId: PRINCIPALS.client.uid,
    agencyId: AGENCY,
    agentId: PRINCIPALS.agent.uid,
    countryCode: "GB",
    visaTypeId: "gb-standard-visitor",
    status: "submitted",
    createdAt: Timestamp.fromMillis(1_700_000_000_000),
    updatedAt: Timestamp.fromMillis(1_700_000_100_000),
  });

  // A normal conversation, notification and document ask: readable, and
  // carrying nothing derived from a signal.
  store.set("conversations/conv-1", {
    id: "conv-1",
    userId: PRINCIPALS.client.uid,
    agentId: "agent-doc-agent",
    applicationId: APPLICATION,
    lastMessage: "Hello",
    lastMessageAt: Timestamp.fromMillis(1_700_000_200_000),
  });
  store.set("notifications/notif-1", {
    id: "notif-1",
    userId: PRINCIPALS.client.uid,
    type: "application_status_changed",
    title: "Your case moved on",
    body: "Your application is submitted.",
    isRead: false,
    createdAt: Timestamp.fromMillis(1_700_000_300_000),
  });
  store.set("documentRequests/req-1", {
    id: "req-1",
    userId: PRINCIPALS.client.uid,
    requestedBy: PRINCIPALS.agent.uid,
    agencyId: AGENCY,
    applicationId: APPLICATION,
    documentType: "bank_statement",
    status: "pending",
    createdAt: Timestamp.fromMillis(1_700_000_400_000),
  });
}

// ============================================
// Setup / teardown
// ============================================

before(async () => {
  await installFakes();
  originalVerify = auth.verifyIdToken;
  (auth as any).verifyIdToken = async (token: string) => {
    const principal = (PRINCIPALS as Record<string, any>)[token];
    if (!principal) throw new Error("unknown test token");
    return { ...principal, admin: principal.role === "admin" };
  };
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  (auth as any).verifyIdToken = originalVerify;
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  resetStore();
});

// ============================================
// Route table
// ============================================

describe("mounted routes", () => {
  test("only the list, detail and status routes exist; no POST / creates a signal", async () => {
    const routes = adminRiskSignalRoutes.stack
      .filter((layer: any) => layer.route)
      .map((layer: any) => ({
        path: layer.route.path,
        methods: Object.keys(layer.route.methods).filter((m) => layer.route.methods[m]),
      }));

    assert.deepEqual(routes, [
      { path: "/", methods: ["get"] },
      { path: "/:id", methods: ["get"] },
      { path: "/:id/status", methods: ["post"] },
    ]);
    assert.equal(
      routes.some((r: any) => r.path === "/" && r.methods.includes("post")),
      false,
      "no create route"
    );

    // And over HTTP: a POST to the collection is a 404, not a create.
    await seedSubjects();
    const raised = await riskSignalService.raiseRiskSignal(signalInput({ type: "user", id: PRINCIPALS.client.uid }));
    assert.equal(raised.outcome, "created");
    if (raised.outcome !== "created") return;
    const id = raised.signalId;
    const created = await call("/admin/risk-signals", {
      token: "admin",
      method: "POST",
      body: signalInput({ type: "user", id: "other" }),
    });
    assert.equal(created.status, 404);
    // Only the one raised through the service exists.
    const list = await call("/admin/risk-signals", { token: "admin" });
    assert.equal(list.status, 200);
    assert.deepEqual(list.json.data.items.map((s: any) => s.id), [id]);
  });
});

// ============================================
// Role matrix
// ============================================

describe("admin-only role matrix", () => {
  test("401 / 403 / 200 across clients, agents, owners and admins on all three endpoints", async () => {
    await seedSubjects();
    const onUser = await riskSignalService.raiseRiskSignal(signalInput({ type: "user", id: PRINCIPALS.client.uid }));
    const onApplication = await riskSignalService.raiseRiskSignal(signalInput({ type: "application", id: APPLICATION }));
    assert.equal(onUser.outcome, "created");
    assert.equal(onApplication.outcome, "created");
    const ids = [onUser.signalId, onApplication.signalId];
    const first = ids[0];

    const endpoints: { path: string; method?: string; body?: unknown }[] = [
      { path: "/admin/risk-signals" },
      { path: `/admin/risk-signals/${first}` },
      { path: `/admin/risk-signals/${first}/status`, method: "POST", body: { status: "in_review", expectedRevision: 1 } },
    ];

    // Unauthenticated: 401 from verifyAuth, before any Firestore read.
    for (const endpoint of endpoints) {
      const res = await call(endpoint.path, { method: endpoint.method, body: endpoint.body });
      assert.equal(res.status, 401, `unauthenticated ${endpoint.method ?? "GET"} ${endpoint.path}`);
      assert.equal(res.json.data, undefined);
      assertNoSignalLeak(res, ids, `unauthenticated ${endpoint.path}`);
    }

    // Client, agent and agency owner: 403 from verifyAdmin, empty data.
    for (const token of ["client", "agent", "owner"] as const) {
      for (const endpoint of endpoints) {
        const res = await call(endpoint.path, { token, method: endpoint.method, body: endpoint.body });
        assert.equal(res.status, 403, `${token} ${endpoint.method ?? "GET"} ${endpoint.path}`);
        assert.equal(res.json.data, undefined);
        assertNoSignalLeak(res, ids, `${token} ${endpoint.path}`);
      }
    }

    // Admin: 200 on all three, and the data is there.
    const list = await call("/admin/risk-signals", { token: "admin" });
    assert.equal(list.status, 200);
    assert.deepEqual(list.json.data.items.map((s: any) => s.id).sort(), [...ids].sort());

    const detail = await call(`/admin/risk-signals/${first}`, { token: "admin" });
    assert.equal(detail.status, 200);
    assert.equal(detail.json.data.signal.id, first);
    assert.ok(Array.isArray(detail.json.data.events));

    const changed = await call(`/admin/risk-signals/${first}/status`, {
      token: "admin",
      method: "POST",
      body: { status: "in_review", expectedRevision: 1 },
    });
    assert.equal(changed.status, 200);
    assert.equal(changed.json.data.status, "in_review");

    // A client can never change a signal status either (the write is gated
    // before the body is even validated).
    const refused = await call(`/admin/risk-signals/${first}/status`, {
      token: "client",
      method: "POST",
      body: { status: "dismissed", note: "nope", expectedRevision: 2 },
    });
    assert.equal(refused.status, 403);
  });
});

// ============================================
// No leaks into non-admin responses
// ============================================

describe("no signal data on any non-admin response", () => {
  test("applications, users/me, agency pages, conversations, notifications and document requests stay clean", async () => {
    await seedSubjects();
    const raised = [
      await riskSignalService.raiseRiskSignal(signalInput({ type: "user", id: PRINCIPALS.client.uid })),
      await riskSignalService.raiseRiskSignal(signalInput({ type: "application", id: APPLICATION })),
      await riskSignalService.raiseRiskSignal(signalInput({ type: "agency", id: AGENCY })),
    ];
    for (const r of raised) assert.equal(r.outcome, "created");
    const ids = raised.map((r) => r.signalId);

    /** Endpoints each principal may read (the status only matters for 200 vs 403). */
    const readable: Record<"client" | "agent" | "owner", { path: string; expect: number }[]> = {
      client: [
        { path: `/applications/${APPLICATION}`, expect: 200 },
        { path: "/applications", expect: 200 },
        { path: "/users/me", expect: 200 },
        { path: "/agencies/me", expect: 404 }, // not in an agency: still no data
        { path: `/agencies/${AGENCY}/members`, expect: 403 },
        { path: "/conversations", expect: 200 },
        { path: "/notifications", expect: 200 },
        { path: "/document-requests", expect: 200 },
      ],
      agent: [
        { path: `/applications/${APPLICATION}`, expect: 200 },
        { path: "/applications?role=agent", expect: 200 },
        { path: "/users/me", expect: 200 },
        { path: "/agencies/me", expect: 200 },
        { path: `/agencies/${AGENCY}/members`, expect: 200 },
        { path: "/conversations", expect: 200 },
        { path: "/notifications", expect: 200 },
        { path: "/document-requests", expect: 200 },
      ],
      owner: [
        { path: `/applications/${APPLICATION}`, expect: 200 },
        { path: "/applications?role=owner", expect: 200 },
        { path: "/users/me", expect: 200 },
        { path: "/agencies/me", expect: 200 },
        { path: `/agencies/${AGENCY}/members`, expect: 200 },
        { path: "/conversations", expect: 200 },
        { path: "/notifications", expect: 200 },
        { path: "/document-requests", expect: 200 },
      ],
    };

    for (const token of ["client", "agent", "owner"] as const) {
      for (const endpoint of readable[token]) {
        const res = await call(endpoint.path, { token });
        assert.equal(res.status, endpoint.expect, `${token} GET ${endpoint.path}`);
        assertNoSignalLeak(res, ids, `${token} GET ${endpoint.path}`);
      }
    }
  });
});
