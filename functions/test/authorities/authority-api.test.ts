// ============================================
// Authorities API (issue #230, P1 of #228) — over the REAL router
// ============================================
//
// Hermetic: in-memory Firestore, fake Auth tokens per role, no network. Covers
// the authorization matrix (401 / 403 before anything is read), id rules over
// HTTP, idempotent create and 409, member writes refused without a quote or a
// confirmed official URL, the audit entries, members on a date, unknown id 404,
// empty list, and expandDestinations. Codes are ISO user-assigned ones (XA..XC)
// and bloc ids are made up: no real country or bloc is named.

import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { Timestamp } from "firebase-admin/firestore";
import { fakeCollection, fakeRunTransaction, installFakes, resetStore, store } from "../helpers/fake-firestore";
import { ROLES } from "@durin-tech/authz";

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Decoded ID tokens by bearer token: one per role (same set as the registry tests). */
const TOKENS: Record<string, any> = {
  "t-admin": { uid: "admin-uid", role: ROLES.ADMIN },
  "t-client": { uid: "client-uid", role: ROLES.CLIENT },
  "t-agent": { uid: "agent-uid", role: ROLES.AGENT, agencyId: "agency-1" },
  "t-owner": { uid: "owner-uid", role: ROLES.OWNER, agencyId: "agency-1" },
};
const NON_ADMIN_TOKENS = ["t-client", "t-agent", "t-owner"];

/** One HTTP call with the console muted (controllers log refusals). `token` null sends no header. */
async function call(base: string, method: string, path: string, token: string | null, payload?: unknown): Promise<{ status: number; body: any }> {
  const saved = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = () => undefined;
  try {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json" },
      ...(payload !== undefined ? { body: JSON.stringify(payload) } : {}),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  } finally {
    Object.assign(console, saved);
  }
}

let server: http.Server;
let baseUrl = "";
let nowMs = Date.parse("2026-11-14T12:00:00Z");
let svc: any;
let expandDestinations: (id: string, date?: string) => Promise<string[]>;

before(async () => {
  await installFakes();
  const firebase: any = await import("../../src/utils/firebase");
  firebase.collections.authorities = fakeCollection("authorities");
  firebase.auth.verifyIdToken = async (token: string) => {
    const d = TOKENS[token];
    if (!d) throw new Error("invalid token");
    return d;
  };
  const { entitlementService }: any = await import("../../src/services/entitlement.service");
  entitlementService.getEntitlements = async () => null;
  const { claimsService }: any = await import("../../src/services/claims.service");
  claimsService.resolveRoleFromDb = async () => ({ role: ROLES.CLIENT, agencyId: null });
  claimsService.setRoleClaims = async () => undefined;

  const mod: any = await import("../../src/authorities");
  svc = mod.authorityService;
  svc.runTransaction = fakeRunTransaction;
  svc.clock = () => nowMs;
  expandDestinations = mod.expandDestinations;

  const app = express();
  app.use(express.json());
  app.use("/admin/authorities", mod.adminAuthorityRoutes);
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => new Promise((resolve) => server.close(resolve)));

/** A confirmed official host and three registered (made-up) countries. */
const HOST = "www.gov.example.org";
const URL_OK = `https://${HOST}/members`;
beforeEach(() => {
  resetStore();
  nowMs = Date.parse("2026-11-14T12:00:00Z");
  for (const cc of ["XA", "XB", "XC"]) store.set(`countries/${cc}`, { code: cc, isSupported: false });
  store.set(`officialDomains/${HOST}`, { host: HOST, countryCode: "XA", status: "confirmed" });
  store.set("officialDomains/revoked.example.org", { host: "revoked.example.org", countryCode: "XA", status: "revoked" });
});

const api = (method: string, path: string, token: string | null, body?: unknown) => call(baseUrl, method, `/admin/authorities${path}`, token, body);
const admin = (method: string, path: string, body?: unknown) => api(method, path, "t-admin", body);
const auditDocs = () => [...store.entries()].filter(([p]) => p.startsWith("sourceRegistryAudit/")).map(([, d]) => d as any);
const authorityDocs = () => [...store.keys()].filter((p) => p.startsWith("authorities/"));

const BLOC = { id: "test-bloc", kind: "bloc", name: "Test Bloc" };
const member = (over: Record<string, unknown> = {}) => ({ joinedOn: "2020-01-01", sourceQuote: "The member states are listed below.", sourceUrl: URL_OK, ...over });

// ============================================
// Authorization
// ============================================

describe("authorization", () => {
  const ENDPOINTS: Array<[string, string, unknown]> = [
    ["GET", "", undefined],
    ["POST", "", BLOC],
    ["GET", "/test-bloc", undefined],
    ["PATCH", "/test-bloc", { name: "x" }],
    ["GET", "/test-bloc/members", undefined],
    ["PUT", "/test-bloc/members/XA", member()],
  ];
  for (const [method, path, body] of ENDPOINTS) {
    test(`${method} ${path || "/"}: 401 without a token, 403 for client / agent / owner, nothing written`, async () => {
      assert.equal((await api(method, path, null, body)).status, 401);
      assert.equal((await api(method, path, "bad-token", body)).status, 401);
      for (const t of NON_ADMIN_TOKENS) {
        const r = await api(method, path, t, body);
        assert.equal(r.status, 403, `${t}`);
        assert.equal(r.body.success, false);
      }
      assert.deepEqual(authorityDocs(), []);
      assert.deepEqual(auditDocs(), []);
    });
  }
});

// ============================================
// Creating authorities
// ============================================

describe("create", () => {
  test("a bloc is created active, audited, and listed", async () => {
    const r = await admin("POST", "", BLOC);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.data.created, true);
    assert.deepEqual({ ...r.body.data.authority, createdAt: undefined, updatedAt: undefined }, {
      id: "test-bloc",
      kind: "bloc",
      name: "Test Bloc",
      status: "active",
      createdBy: "admin-uid",
      updatedBy: "admin-uid",
      createdAt: undefined,
      updatedAt: undefined,
    });
    assert.equal(r.body.data.authority.createdAt, "2026-11-14T12:00:00.000Z");
    const audit = auditDocs();
    assert.equal(audit.length, 1);
    assert.equal(audit[0].action, "authority_created");
    assert.equal(audit[0].targetType, "authority");
    assert.equal(audit[0].targetId, "test-bloc");
    assert.equal(audit[0].before, null);
    const list = await admin("GET", "");
    assert.equal(list.body.data.total, 1);
  });

  test("the same body twice changes nothing; a different body is 409", async () => {
    await admin("POST", "", BLOC);
    const before = JSON.stringify([...store.entries()]);
    const again = await admin("POST", "", BLOC);
    assert.equal(again.status, 200);
    assert.equal(again.body.data.created, false);
    assert.equal(JSON.stringify([...store.entries()]), before);
    const other = await admin("POST", "", { ...BLOC, name: "Another Name" });
    assert.equal(other.status, 409);
    assert.equal(other.body.error, "AUTHORITY_EXISTS");
    const kind = await admin("POST", "", { ...BLOC, kind: "treaty" });
    assert.equal(kind.status, 409);
    assert.equal(auditDocs().length, 1);
  });

  test("a country authority's id must be a registered country", async () => {
    assert.equal((await admin("POST", "", { id: "XA", kind: "country", name: "Country A" })).status, 201);
    const missing = await admin("POST", "", { id: "XZ", kind: "country", name: "Country Z" });
    assert.equal(missing.status, 400);
    assert.equal(missing.body.error, "COUNTRY_NOT_FOUND");
  });

  test("bad ids, kinds and names are 400 with a plain-words message", async () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ ...BLOC, id: "my_bloc" }, "INVALID_AUTHORITY_ID"],
      [{ ...BLOC, id: "ab" }, "INVALID_AUTHORITY_ID"],
      [{ ...BLOC, id: "XA" }, "INVALID_AUTHORITY_ID"],
      [{ ...BLOC, id: "Test-Bloc" }, "INVALID_AUTHORITY_ID"],
      [{ id: "xa", kind: "country", name: "x" }, "INVALID_AUTHORITY_ID"],
      [{ id: "test-bloc", kind: "country", name: "x" }, "INVALID_AUTHORITY_ID"],
      [{ ...BLOC, kind: "union" }, "INVALID_KIND"],
      [{ ...BLOC, name: "  " }, "NAME_REQUIRED"],
      [{ ...BLOC, status: "retired" }, "VALIDATION_ERROR"],
    ];
    for (const [body, code] of cases) {
      const r = await admin("POST", "", body);
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.equal(r.body.error, code, JSON.stringify(body));
      assert.ok(typeof r.body.message === "string" && r.body.message.length > 10);
    }
    assert.deepEqual(authorityDocs(), []);
  });
});

// ============================================
// Editing
// ============================================

describe("update", () => {
  test("name and status change with an audit entry; no change writes nothing; unknown is 404", async () => {
    await admin("POST", "", BLOC);
    nowMs += 1000;
    const r = await admin("PATCH", "/test-bloc", { status: "retired" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.data.changed, true);
    assert.equal(r.body.data.authority.status, "retired");
    assert.equal(auditDocs().filter((a) => a.action === "authority_changed").length, 1);
    const same = await admin("PATCH", "/test-bloc", { status: "retired" });
    assert.equal(same.body.data.changed, false);
    assert.equal(auditDocs().length, 2);
    assert.equal((await admin("PATCH", "/other-bloc", { name: "x" })).status, 404);
    assert.equal((await admin("PATCH", "/test-bloc", { kind: "treaty" })).status, 400);
    assert.equal((await admin("PATCH", "/test-bloc", {})).status, 400);
    assert.equal((await admin("PATCH", "/test-bloc", { status: "gone" })).body.error, "INVALID_STATUS");
  });
});

// ============================================
// Members
// ============================================

describe("members", () => {
  beforeEach(async () => {
    await admin("POST", "", BLOC);
  });

  test("a member with a quote and a confirmed https URL is saved and audited; same again is a no-op", async () => {
    const r = await admin("PUT", "/test-bloc/members/XA", member());
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.data.member.sourceQuote, "The member states are listed below.");
    assert.equal(r.body.data.member.leftOn, null);
    assert.ok(store.has("authorities/test-bloc/members/XA"));
    const audit = auditDocs().find((a) => a.action === "authority_member_added");
    assert.equal(audit.targetId, "test-bloc/XA");
    assert.equal(audit.after.sourceUrl, URL_OK);
    const again = await admin("PUT", "/test-bloc/members/XA", member());
    assert.equal(again.status, 200);
    assert.equal(again.body.data.changed, false);
    assert.equal(auditDocs().length, 2);
  });

  test("changing a member keeps who created it, audits before and after, and clearing leftOn removes it", async () => {
    await admin("PUT", "/test-bloc/members/XA", member());
    nowMs += 1000;
    const r = await admin("PUT", "/test-bloc/members/XA", member({ leftOn: "2025-01-01" }));
    assert.equal(r.status, 200);
    assert.equal(r.body.data.changed, true);
    assert.equal(r.body.data.member.leftOn, "2025-01-01");
    const changed = auditDocs().find((a) => a.action === "authority_member_changed");
    assert.equal(changed.before.leftOn, undefined);
    assert.equal(changed.after.leftOn, "2025-01-01");
    const stored: any = store.get("authorities/test-bloc/members/XA");
    assert.ok(stored.createdAt instanceof Timestamp);
    assert.notEqual(stored.createdAt.toMillis(), stored.updatedAt.toMillis());
    await admin("PUT", "/test-bloc/members/XA", member({ leftOn: null }));
    assert.equal((store.get("authorities/test-bloc/members/XA") as any).leftOn, undefined);
  });

  test("a member without a quote or an official URL is refused and nothing is written", async () => {
    const cases: Array<[Record<string, unknown>, number, string]> = [
      [member({ sourceQuote: undefined }), 400, "SOURCE_QUOTE_REQUIRED"],
      [member({ sourceQuote: "" }), 400, "SOURCE_QUOTE_REQUIRED"],
      [member({ sourceUrl: undefined }), 400, "SOURCE_URL_REQUIRED"],
      [member({ sourceUrl: "http://www.gov.example.org/members" }), 400, "NOT_HTTPS"],
      [member({ sourceUrl: "https://blog.example.net/members" }), 422, "HOST_NOT_CONFIRMED"],
      [member({ sourceUrl: "https://revoked.example.org/members" }), 422, "HOST_NOT_CONFIRMED"],
      // A confirmed host does not cover its subdomains (exact-host rule).
      [member({ sourceUrl: "https://sub.www.gov.example.org/members" }), 422, "HOST_NOT_CONFIRMED"],
      [member({ joinedOn: "2020-02-30" }), 400, "INVALID_DATE"],
      [member({ leftOn: "2019-01-01" }), 400, "INVALID_DATE_RANGE"],
      [{ ...member(), note: "x" }, 400, "VALIDATION_ERROR"],
    ];
    for (const [body, status, code] of cases) {
      const r = await admin("PUT", "/test-bloc/members/XA", body);
      assert.equal(r.status, status, JSON.stringify(body));
      assert.equal(r.body.error, code, JSON.stringify(body));
    }
    assert.equal(store.has("authorities/test-bloc/members/XA"), false);
    assert.equal(auditDocs().length, 1);
  });

  test("member code, authority and kind are checked", async () => {
    assert.equal((await admin("PUT", "/test-bloc/members/xa", member())).body.error, "INVALID_COUNTRY_CODE");
    assert.equal((await admin("PUT", "/test-bloc/members/XZ", member())).body.error, "COUNTRY_NOT_FOUND");
    assert.equal((await admin("PUT", "/other-bloc/members/XA", member())).status, 404);
    assert.equal((await admin("PUT", "/bad_id/members/XA", member())).status, 400);
    await admin("POST", "", { id: "XB", kind: "country", name: "Country B" });
    assert.equal((await admin("PUT", "/XB/members/XA", member())).body.error, "AUTHORITY_HAS_NO_MEMBERS");
  });

  test("members on a date: before and after a leftOn; default today; empty list; 404; bad date", async () => {
    await admin("PUT", "/test-bloc/members/XA", member({ joinedOn: "2020-01-01", leftOn: "2025-06-01" }));
    await admin("PUT", "/test-bloc/members/XB", member({ joinedOn: "2021-01-01" }));
    const codes = async (q: string) => (await admin("GET", `/test-bloc/members${q}`)).body.data.members.map((m: any) => m.countryCode);
    assert.deepEqual(await codes("?on=2025-05-31"), ["XA", "XB"]);
    assert.deepEqual(await codes("?on=2025-06-01"), ["XB"]);
    assert.deepEqual(await codes("?on=2020-06-01"), ["XA"]);
    assert.deepEqual(await codes("?on=2019-01-01"), []);
    // Default "on" is today (the fixed clock: 2026-11-14).
    const today = await admin("GET", "/test-bloc/members");
    assert.equal(today.body.data.on, "2026-11-14");
    assert.deepEqual(today.body.data.members.map((m: any) => m.countryCode), ["XB"]);

    await admin("POST", "", { id: "empty-bloc", kind: "treaty", name: "Empty" });
    const empty = await admin("GET", "/empty-bloc/members");
    assert.equal(empty.status, 200);
    assert.deepEqual(empty.body.data.members, []);
    assert.equal((await admin("GET", "/unknown-bloc/members")).status, 404);
    assert.equal((await admin("GET", "/test-bloc/members?on=2025-13-01")).body.error, "INVALID_DATE");
    assert.equal((await admin("GET", "/test-bloc/members?on=2025-01-01&on=2025-02-01")).status, 400);
    assert.equal((await admin("GET", "/a_b/members")).status, 400);
  });

  test("GET one: found, 404, 400", async () => {
    assert.equal((await admin("GET", "/test-bloc")).body.data.authority.name, "Test Bloc");
    assert.equal((await admin("GET", "/unknown-bloc")).status, 404);
    assert.equal((await admin("GET", "/x_y")).status, 400);
  });
});

// ============================================
// expandDestinations (for later parts)
// ============================================

describe("expandDestinations", () => {
  test("a bloc expands to its current members; a country to itself; unknown throws 404", async () => {
    await admin("POST", "", BLOC);
    await admin("PUT", "/test-bloc/members/XA", member({ leftOn: "2025-06-01" }));
    await admin("PUT", "/test-bloc/members/XC", member({ joinedOn: "2022-01-01" }));
    assert.deepEqual(await expandDestinations("test-bloc", "2024-01-01"), ["XA", "XC"]);
    assert.deepEqual(await expandDestinations("test-bloc", "2025-06-01"), ["XC"]);
    assert.deepEqual(await expandDestinations("test-bloc"), ["XC"]);
    assert.deepEqual(await expandDestinations("test-bloc", "2019-01-01"), []);
    await admin("POST", "", { id: "XB", kind: "country", name: "Country B" });
    assert.deepEqual(await expandDestinations("XB", "2024-01-01"), ["XB"]);
    await assert.rejects(() => expandDestinations("unknown-bloc", "2024-01-01"), (err: any) => err.status === 404);
    await assert.rejects(() => expandDestinations("bad_id", "2024-01-01"), (err: any) => err.status === 400);
    assert.equal(await svc.exists("test-bloc"), true);
    assert.equal(await svc.exists("unknown-bloc"), false);
  });
});

// ============================================
// No names in code
// ============================================

describe("generic code", () => {
  test("the authorities module names no country code literal in its logic", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const dir = path.join(__dirname, "..", "..", "src", "authorities");
    for (const f of fs.readdirSync(dir)) {
      // Code only: comment lines (which may show placeholder ids) are dropped.
      const code = fs
        .readFileSync(path.join(dir, f), "utf8")
        .split("\n")
        .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
        .join("\n");
      // A quoted two-capital-letter string would be a hard-coded country.
      assert.doesNotMatch(code, /["'`][A-Z]{2}["'`]/, f);
    }
  });
});
