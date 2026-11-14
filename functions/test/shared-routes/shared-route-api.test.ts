// ============================================
// Shared routes API, resolver and application stack (issue #231, P2 of #228)
// ============================================
//
// Hermetic: the real admin router over an in-memory Firestore, fake Auth
// tokens per role, no network, no emulators. Covers: the authorization matrix
// (401 / 403 before anything is read), creating shared routes and their
// refusals, setting `inheritsFrom` (country in destinations on the day, ended
// membership, retired route), the resolver with zero / one / two shared
// layers, the stack fixed on a new application, the 409 rules with open
// applications, and that an agency can still price a member's visa.
// Everything is made up: codes XA..XD (ISO user-assigned), bloc ids, visa ids.

import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { Timestamp } from "firebase-admin/firestore";
import { ROLES } from "@durin-tech/authz";
import { fakeCollection, fakeRunTransaction, installFakes, resetStore, store } from "../helpers/fake-firestore";

/* eslint-disable @typescript-eslint/no-explicit-any */

const TOKENS: Record<string, any> = {
  "t-admin": { uid: "admin-uid", role: ROLES.ADMIN },
  "t-client": { uid: "client-uid", role: ROLES.CLIENT },
  "t-agent": { uid: "agent-uid", role: ROLES.AGENT, agencyId: "agency-1" },
  "t-owner": { uid: "owner-uid", role: ROLES.OWNER, agencyId: "agency-1" },
};
const NON_ADMIN_TOKENS = ["t-client", "t-agent", "t-owner"];

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

/** A tiny collection-group fake over the store: where(==, array-contains) + get. */
function groupFake(collectionId: string, filters: Array<[string, string, unknown]> = []): any {
  return {
    where: (f: string, op: string, v: unknown) => groupFake(collectionId, [...filters, [f, op, v]]),
    async get() {
      const { fakeDoc, clone } = await import("../helpers/fake-firestore");
      const docs = [...store.entries()]
        .filter(([p]) => {
          const parts = p.split("/");
          return parts.length % 2 === 0 && parts[parts.length - 2] === collectionId;
        })
        .filter(([, d]: [string, any]) =>
          filters.every(([f, op, v]) =>
            op === "==" ? d[f] === v : Array.isArray(d[f]) && d[f].some((x: unknown) => JSON.stringify(x) === JSON.stringify(v))
          )
        )
        .map(([p, d]) => ({ id: fakeDoc(p).id, exists: true, ref: fakeDoc(p), data: () => clone(d) }));
      return { docs, empty: docs.length === 0, size: docs.length };
    },
  };
}

let server: http.Server;
let baseUrl = "";
let nowMs = Date.parse("2026-11-14T12:00:00Z");
let sharedSvc: any;
let resolver: any;
let appSvc: any;
let priceSvc: any;

before(async () => {
  await installFakes();
  const firebase: any = await import("../../src/utils/firebase");
  firebase.collections.authorities = fakeCollection("authorities");
  firebase.collections.sharedRoutes = fakeCollection("sharedRoutes");
  firebase.collections.agencies = fakeCollection("agencies");
  firebase.collectionGroups.visaTypes = () => groupFake("visaTypes");
  firebase.subcollections.authorityMembers = (id: string) => fakeCollection(`authorities/${id}/members`);
  firebase.subcollections.requirements = (cc: string, v: string) => fakeCollection(`countries/${cc}/visaTypes/${v}/requirements`);
  firebase.subcollections.timeline = (id: string) => fakeCollection(`applications/${id}/timeline`);
  firebase.subcollections.agencyVisaPrices = (id: string) => fakeCollection(`agencies/${id}/visaPrices`);
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

  const authorities: any = await import("../../src/authorities");
  authorities.authorityService.runTransaction = fakeRunTransaction;
  authorities.authorityService.clock = () => nowMs;
  const mod: any = await import("../../src/shared-routes");
  sharedSvc = mod.sharedRouteService;
  sharedSvc.runTransaction = fakeRunTransaction;
  sharedSvc.clock = () => nowMs;
  resolver = mod;
  appSvc = (await import("../../src/services/application.service") as any).applicationService;
  priceSvc = (await import("../../src/agency-visa-prices/agency-visa-price.service") as any).agencyVisaPriceService;
  priceSvc.runTransaction = fakeRunTransaction;

  const app = express();
  app.use(express.json());
  app.use("/admin/shared-routes", mod.adminSharedRouteRoutes);
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => new Promise((resolve) => server.close(resolve)));

const T0 = Timestamp.fromMillis(1_700_000_000_000);

/** Authorities, countries and one visa record per country; made up. */
beforeEach(() => {
  resetStore();
  nowMs = Date.parse("2026-11-14T12:00:00Z");
  for (const cc of ["XA", "XB", "XC", "XD"]) {
    store.set(`countries/${cc}`, { code: cc, name: `Country ${cc}`, isSupported: true, createdAt: T0, updatedAt: T0 });
    seedVisa(cc, `${cc.toLowerCase()}-visitor`);
  }
  for (const [id, kind] of [["test-bloc", "bloc"], ["other-bloc", "treaty"]] as const) {
    store.set(`authorities/${id}`, { id, kind, name: id, status: "active", createdBy: "a", createdAt: T0, updatedBy: "a", updatedAt: T0 });
  }
  store.set("authorities/XA", { id: "XA", kind: "country", name: "Country XA", status: "active", createdBy: "a", createdAt: T0, updatedBy: "a", updatedAt: T0 });
  // test-bloc: XA and XB are members now, XC left before today, XD joins in the future.
  member("test-bloc", "XA", "2020-01-01");
  member("test-bloc", "XB", "2020-01-01");
  member("test-bloc", "XC", "2019-01-01", "2024-01-01");
  member("test-bloc", "XD", "2030-01-01");
});

function member(authorityId: string, cc: string, joinedOn: string, leftOn?: string): void {
  store.set(`authorities/${authorityId}/members/${cc}`, { countryCode: cc, joinedOn, ...(leftOn ? { leftOn } : {}), sourceQuote: "q", sourceUrl: "https://x.example.org/", createdBy: "a", createdAt: T0, updatedBy: "a", updatedAt: T0 });
}

function seedVisa(cc: string, id: string, over: Record<string, unknown> = {}): void {
  store.set(`countries/${cc}/visaTypes/${id}`, {
    id, countryCode: cc, name: `Visa ${id}`, code: id.toUpperCase(), description: "d", category: "tourist", processingTime: "1 week",
    processingDaysMin: 5, processingDaysMax: 7, baseCostUsd: 100, validityPeriod: "90 days", isExtendable: false, eligibilityCriteria: [],
    agentIds: [], isActive: true, createdAt: T0, updatedAt: T0, ...over,
  });
}

const api = (method: string, path: string, token: string | null, body?: unknown) => call(baseUrl, method, `/admin/shared-routes${path}`, token, body);
const admin = (method: string, path: string, body?: unknown) => api(method, path, "t-admin", body);
const auditDocs = () => [...store.entries()].filter(([p]) => p.startsWith("sourceRegistryAudit/")).map(([, d]) => d as any);
const routeDocs = () => [...store.keys()].filter((p) => p.startsWith("sharedRoutes/"));

const ROUTE = { id: "route-one", name: "Route One", category: "tourist", issuingAuthorityId: "test-bloc", destinations: { mode: "members_of", authorityId: "test-bloc" } };
const route2 = { id: "route-two", name: "Route Two", category: "business", issuingAuthorityId: "other-bloc", destinations: { mode: "listed", countryCodes: ["XA", "XB"] } };
const inherit = (cc: string, vid: string, ids: string[]) => admin("PUT", `/inheritance/${cc}/${vid}`, { inheritsFrom: ids.map((sharedRouteId) => ({ sharedRouteId })) });
const visaDoc = (cc: string, id: string): any => store.get(`countries/${cc}/visaTypes/${id}`);
function seedApp(id: string, over: Record<string, unknown> = {}): void {
  store.set(`applications/${id}`, { id, userId: "u", countryCode: "XA", visaTypeId: "xa-visitor", status: "draft", ...over });
}

// ============================================
// Authorization
// ============================================

describe("authorization", () => {
  const ENDPOINTS: Array<[string, string, unknown]> = [
    ["GET", "", undefined],
    ["POST", "", ROUTE],
    ["GET", "/route-one", undefined],
    ["PATCH", "/route-one", { name: "x" }],
    ["PUT", "/inheritance/XA/xa-visitor", { inheritsFrom: [] }],
    ["GET", "/resolve/XA/xa-visitor", undefined],
  ];
  for (const [method, path, body] of ENDPOINTS) {
    test(`${method} ${path || "/"}: 401 without a token, 403 for client / agent / owner, nothing written`, async () => {
      assert.equal((await api(method, path, null, body)).status, 401);
      assert.equal((await api(method, path, "bad-token", body)).status, 401);
      for (const t of NON_ADMIN_TOKENS) {
        const r = await api(method, path, t, body);
        assert.equal(r.status, 403, t);
      }
      assert.deepEqual(routeDocs(), []);
      assert.deepEqual(auditDocs(), []);
      assert.equal(visaDoc("XA", "xa-visitor").inheritsFrom, undefined);
    });
  }
});

// ============================================
// Creating and editing shared routes
// ============================================

describe("create", () => {
  test("creates active, audited; same body again is a no-op; a different body is 409", async () => {
    const r = await admin("POST", "", ROUTE);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.data.sharedRoute.status, "active");
    assert.equal(r.body.data.sharedRoute.createdBy, "admin-uid");
    assert.equal(auditDocs().length, 1);
    assert.equal(auditDocs()[0].action, "shared_route_created");
    assert.equal((await admin("POST", "", ROUTE)).status, 200);
    assert.equal(auditDocs().length, 1);
    const clash = await admin("POST", "", { ...ROUTE, name: "Other" });
    assert.equal(clash.status, 409);
    assert.equal(clash.body.error, "SHARED_ROUTE_EXISTS");
  });

  test("refusals write nothing: underscore id, unknown field, missing name, bad category, unknown / country / retired issuer, bad destinations", async () => {
    store.set("authorities/old-bloc", { id: "old-bloc", kind: "bloc", name: "o", status: "retired" });
    const cases: Array<[Record<string, unknown>, number, string]> = [
      [{ ...ROUTE, id: "a_b_c" }, 400, "INVALID_SHARED_ROUTE_ID"],
      [{ ...ROUTE, surprise: 1 }, 400, "VALIDATION_ERROR"],
      [{ ...ROUTE, name: " " }, 400, "NAME_REQUIRED"],
      [{ ...ROUTE, category: "party" }, 400, "INVALID_CATEGORY"],
      [{ ...ROUTE, issuingAuthorityId: "nope-bloc" }, 422, "AUTHORITY_NOT_FOUND"],
      [{ ...ROUTE, issuingAuthorityId: "XA" }, 422, "AUTHORITY_NOT_SHARED"],
      [{ ...ROUTE, issuingAuthorityId: "old-bloc" }, 422, "AUTHORITY_RETIRED"],
      [{ ...ROUTE, destinations: { mode: "listed", countryCodes: ["XZ"] } }, 422, "COUNTRY_NOT_FOUND"],
      [{ ...ROUTE, destinations: { mode: "members_of", authorityId: "XA" } }, 422, "AUTHORITY_HAS_NO_MEMBERS"],
      [{ ...ROUTE, destinations: { mode: "members_of", authorityId: "nope-bloc" } }, 422, "AUTHORITY_NOT_FOUND"],
      [{ ...ROUTE, destinations: { mode: "everywhere" } }, 400, "INVALID_DESTINATIONS"],
    ];
    for (const [body, status, code] of cases) {
      const r = await admin("POST", "", body);
      assert.equal(r.status, status, `${code}: ${JSON.stringify(r.body)}`);
      assert.equal(r.body.error, code);
    }
    assert.deepEqual(routeDocs(), []);
    assert.deepEqual(auditDocs(), []);
  });

  test("get shows the countries covered on a date; list; unknown id is 404", async () => {
    await admin("POST", "", ROUTE);
    const today = await admin("GET", "/route-one");
    assert.deepEqual(today.body.data.coveredCountryCodes, ["XA", "XB"]);
    const early = await admin("GET", "/route-one?on=2023-06-01");
    assert.deepEqual(early.body.data.coveredCountryCodes, ["XA", "XB", "XC"]);
    assert.equal((await admin("GET", "/route-one?on=2023-02-30")).status, 400);
    assert.equal((await admin("GET", "/no-such-route")).status, 404);
    assert.equal((await admin("GET", "")).body.data.total, 1);
  });

  test("an empty list is an empty list", async () => {
    assert.deepEqual((await admin("GET", "")).body.data, { sharedRoutes: [], total: 0 });
  });
});

describe("edit and retire", () => {
  beforeEach(async () => {
    await admin("POST", "", ROUTE);
  });

  test("edit name and destinations, audited; unchanged edit writes nothing; empty edit 400", async () => {
    const r = await admin("PATCH", "/route-one", { name: "Renamed", destinations: { mode: "listed", countryCodes: ["XB"] } });
    assert.equal(r.status, 200);
    assert.equal(r.body.data.changed, true);
    assert.equal(r.body.data.sharedRoute.issuingAuthorityId, "test-bloc");
    assert.equal(auditDocs().filter((a) => a.action === "shared_route_changed").length, 1);
    assert.equal((await admin("PATCH", "/route-one", { name: "Renamed" })).body.data.changed, false);
    assert.equal(auditDocs().length, 2);
    assert.equal((await admin("PATCH", "/route-one", {})).status, 400);
    assert.equal((await admin("PATCH", "/route-one", { issuingAuthorityId: "other-bloc" })).status, 400);
    assert.equal((await admin("PATCH", "/nope-route", { name: "x" })).status, 404);
  });

  test("retiring with open applications is 409 with the count; closed ones do not count; then it retires", async () => {
    assert.equal((await inherit("XA", "xa-visitor", ["route-one"])).status, 200);
    seedApp("a1", { routeStack: ["test-bloc_route-one", "XA_xa-visitor"] }); // open, stacked
    seedApp("a2"); // open, no stored stack: resolves live, so uses it
    seedApp("a3", { status: "approved", routeStack: ["test-bloc_route-one", "XA_xa-visitor"] }); // closed
    seedApp("a4", { routeStack: ["XA_xa-visitor"] }); // open, started before the inheritance: does not use it
    const refused = await admin("PATCH", "/route-one", { status: "retired" });
    assert.equal(refused.status, 409);
    assert.equal(refused.body.error, "OPEN_APPLICATIONS");
    assert.equal(refused.body.openApplications, 2);
    assert.match(refused.body.message, /2 open applications/);
    assert.equal(store.get("sharedRoutes/route-one")?.status, "active");
    store.set("applications/a1", { ...store.get("applications/a1"), status: "withdrawn" });
    store.set("applications/a2", { ...store.get("applications/a2"), status: "rejected" });
    const ok = await admin("PATCH", "/route-one", { status: "retired" });
    assert.equal(ok.status, 200);
    assert.equal(store.get("sharedRoutes/route-one")?.status, "retired");
  });
});

// ============================================
// inheritsFrom on a country's visa record
// ============================================

describe("setting inheritsFrom", () => {
  beforeEach(async () => {
    await admin("POST", "", ROUTE);
    await admin("POST", "", route2);
  });

  test("a member inherits: stored, audited, same list again writes nothing", async () => {
    const r = await inherit("XA", "xa-visitor", ["route-one"]);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(visaDoc("XA", "xa-visitor").inheritsFrom, [{ sharedRouteId: "route-one" }]);
    const n = auditDocs().length;
    assert.equal(auditDocs().filter((a) => a.action === "visa_inheritance_changed").length, 1);
    assert.equal((await inherit("XA", "xa-visitor", ["route-one"])).body.data.changed, false);
    assert.equal(auditDocs().length, n);
  });

  test("a country that is not covered is 422 'that country is not covered by this shared route'", async () => {
    // XC left the bloc before today; XD joins in 2030; neither is covered today.
    for (const cc of ["XC", "XD"]) {
      const r = await inherit(cc, `${cc.toLowerCase()}-visitor`, ["route-one"]);
      assert.equal(r.status, 422, cc);
      assert.equal(r.body.message, "that country is not covered by this shared route");
      assert.equal(visaDoc(cc, `${cc.toLowerCase()}-visitor`).inheritsFrom, undefined);
    }
    // A listed route covers only what is listed.
    assert.equal((await inherit("XC", "xc-visitor", ["route-two"])).status, 422);
  });

  test("membership is judged on the day it is set (service date)", async () => {
    const before = await sharedSvc.setInheritance("XC", "xc-visitor", [{ sharedRouteId: "route-one" }], "admin-uid", "2023-06-01");
    assert.equal(before.changed, true); // XC was a member in 2023
    await assert.rejects(sharedSvc.setInheritance("XD", "xd-visitor", [{ sharedRouteId: "route-one" }], "admin-uid", "2029-12-31"), /not covered/);
    assert.equal((await sharedSvc.setInheritance("XD", "xd-visitor", [{ sharedRouteId: "route-one" }], "admin-uid", "2030-01-01")).changed, true);
  });

  test("refusals: unknown record 404, unknown route 422, retired route 422, bad shapes 400; nothing written", async () => {
    await admin("PATCH", "/route-two", { status: "retired" });
    const n = auditDocs().length;
    assert.equal((await inherit("XA", "missing-visa", ["route-one"])).status, 404);
    assert.equal((await inherit("XA", "xa-visitor", ["no-such-route"])).body.error, "SHARED_ROUTE_NOT_FOUND");
    assert.equal((await inherit("XA", "xa-visitor", ["route-two"])).body.error, "SHARED_ROUTE_RETIRED");
    assert.equal((await inherit("XA", "xa-visitor", ["route-one", "route-one"])).status, 400);
    assert.equal((await inherit("xa", "xa-visitor", [])).status, 400);
    assert.equal((await admin("PUT", "/inheritance/XA/xa-visitor", { inheritsFrom: "route-one" })).status, 400);
    assert.equal((await admin("PUT", "/inheritance/XA/xa-visitor", { inheritsFrom: [], extra: 1 })).status, 400);
    assert.equal(visaDoc("XA", "xa-visitor").inheritsFrom, undefined);
    assert.equal(auditDocs().length, n);
  });

  test("removing is 409 with the count while open applications use it; allowed once they close", async () => {
    await inherit("XA", "xa-visitor", ["route-one"]);
    seedApp("a1", { routeStack: ["test-bloc_route-one", "XA_xa-visitor"] });
    seedApp("a2"); // no stored stack: live
    seedApp("a3", { visaTypeId: "other-visa" }); // another record: not counted
    const refused = await inherit("XA", "xa-visitor", []);
    assert.equal(refused.status, 409);
    assert.equal(refused.body.openApplications, 2);
    assert.match(refused.body.message, /2 open applications/);
    assert.deepEqual(visaDoc("XA", "xa-visitor").inheritsFrom, [{ sharedRouteId: "route-one" }]);
    store.set("applications/a1", { ...store.get("applications/a1"), status: "approved" });
    store.set("applications/a2", { ...store.get("applications/a2"), status: "expired" });
    const ok = await inherit("XA", "xa-visitor", []);
    assert.equal(ok.status, 200);
    assert.equal("inheritsFrom" in visaDoc("XA", "xa-visitor"), false);
  });
});

// ============================================
// Resolver
// ============================================

describe("resolveRouteStack", () => {
  beforeEach(async () => {
    await admin("POST", "", ROUTE);
    await admin("POST", "", route2);
  });

  test("zero shared layers: only the own layer, key unchanged (also for a record that does not exist)", async () => {
    const own = [{ authorityId: "XA", rulebookKey: "XA_xa-visitor", role: "own" }];
    assert.deepEqual(await resolver.resolveRouteStack("XA", "xa-visitor"), own);
    assert.deepEqual(await resolver.resolveRouteStack("XA", "xa-visitor"), own);
    assert.deepEqual(await resolver.resolveRouteStack("XA", "gone"), [{ authorityId: "XA", rulebookKey: "XA_gone", role: "own" }]);
  });

  test("one and two shared layers, in inheritsFrom order, own last", async () => {
    await inherit("XA", "xa-visitor", ["route-one"]);
    assert.deepEqual(resolver.routeStackKeys(await resolver.resolveRouteStack("XA", "xa-visitor")), ["test-bloc_route-one", "XA_xa-visitor"]);
    await inherit("XA", "xa-visitor", ["route-two", "route-one"]);
    const stack = await resolver.resolveRouteStack("XA", "xa-visitor");
    assert.deepEqual(resolver.routeStackKeys(stack), ["other-bloc_route-two", "test-bloc_route-one", "XA_xa-visitor"]);
    assert.deepEqual(stack.map((l: any) => l.role), ["shared", "shared", "own"]);
    // The admin read gives the same answer.
    const viaApi = await admin("GET", "/resolve/XA/xa-visitor");
    assert.deepEqual(viaApi.body.data.stack, stack);
  });

  test("a retired shared route no longer contributes a layer", async () => {
    await inherit("XA", "xa-visitor", ["route-two"]);
    await admin("PATCH", "/route-two", { status: "retired" }); // no open applications: allowed
    assert.deepEqual(resolver.routeStackKeys(await resolver.resolveRouteStack("XA", "xa-visitor")), ["XA_xa-visitor"]);
  });

  test("an application keeps its stored stack; one without a stack resolves live", async () => {
    await inherit("XA", "xa-visitor", ["route-one"]);
    const stored = { countryCode: "XA", visaTypeId: "xa-visitor", routeStack: ["XA_xa-visitor"] };
    assert.deepEqual(resolver.routeStackKeys(await resolver.resolveApplicationStack(stored)), ["XA_xa-visitor"]);
    assert.deepEqual(resolver.routeStackKeys(await resolver.resolveApplicationStack({ countryCode: "XA", visaTypeId: "xa-visitor" })), ["test-bloc_route-one", "XA_xa-visitor"]);
  });
});

// ============================================
// A new application fixes its stack; country-keyed money keeps working
// ============================================

describe("applications and prices", () => {
  beforeEach(async () => {
    await admin("POST", "", ROUTE);
    store.set("users/u1", { firstName: "T", lastName: "U", email: "delivered+u1@resend.dev" });
  });

  test("a new application stores routeStack; changing inheritsFrom later does not rewrite it", async () => {
    await inherit("XA", "xa-visitor", ["route-one"]);
    const app = await appSvc.createApplication("u1", { countryCode: "XA", visaTypeId: "xa-visitor", mode: "self" });
    assert.deepEqual(app.routeStack, ["test-bloc_route-one", "XA_xa-visitor"]);
    assert.deepEqual((store.get(`applications/${app.id}`) as any).routeStack, ["test-bloc_route-one", "XA_xa-visitor"]);
    // Removing is refused while it is open; close it, remove, and the stored stack is untouched.
    assert.equal((await inherit("XA", "xa-visitor", [])).status, 409);
    store.set(`applications/${app.id}`, { ...store.get(`applications/${app.id}`), status: "under_review" });
    assert.equal((await inherit("XA", "xa-visitor", [])).status, 409);
    store.set(`applications/${app.id}`, { ...store.get(`applications/${app.id}`), status: "approved" });
    assert.equal((await inherit("XA", "xa-visitor", [])).status, 200);
    assert.deepEqual((store.get(`applications/${app.id}`) as any).routeStack, ["test-bloc_route-one", "XA_xa-visitor"]);
  });

  test("a visa with no inheritsFrom starts an application whose stack is just its own key (behaviour as before)", async () => {
    const app = await appSvc.createApplication("u1", { countryCode: "XB", visaTypeId: "xb-visitor", mode: "self" });
    assert.deepEqual(app.routeStack, ["XB_xb-visitor"]);
    assert.equal(app.visaTypeId, "xb-visitor");
    assert.equal(app.countryCode, "XB");
  });

  test("an agency prices a member's visa, keyed by the member's record; the record is not changed", async () => {
    // An approved agency-owned visa that inherits a shared route (agency visas are
    // the ones an agency prices without a global approval step).
    store.set("agencies/ag1", { id: "ag1", status: "approved", ownerId: "o1", slug: "ag1" });
    seedVisa("XA", "ag-visa", { source: "agency", ownerAgencyId: "ag1", visibility: "agency", reviewStatus: "approved", createdBy: "o1" });
    assert.equal((await inherit("XA", "ag-visa", ["route-one"])).status, 200);
    const before = JSON.stringify(visaDoc("XA", "ag-visa"));
    const view = await priceSvc.setPrice("ag1", "o1", { countryCode: "XA", visaTypeId: "ag-visa" }, { amountMinor: 12_500, currency: "USD" });
    assert.equal(view.visaTypeId ?? view.id, "ag-visa");
    const priceDoc: any = store.get("agencies/ag1/visaPrices/XA__ag-visa");
    assert.equal(priceDoc.countryCode, "XA");
    assert.equal(priceDoc.visaTypeId, "ag-visa");
    assert.equal(priceDoc.priceUsd.amountMinor, 12_500);
    assert.equal(JSON.stringify(visaDoc("XA", "ag-visa")), before);
    // A public (seed) member visa is priced the same way.
    assert.equal((await inherit("XB", "xb-visitor", ["route-one"])).status, 200);
    await priceSvc.setPrice("ag1", "o1", { countryCode: "XB", visaTypeId: "xb-visitor" }, { amountMinor: 9_000, currency: "USD" });
    assert.ok(store.get("agencies/ag1/visaPrices/XB__xb-visitor"));
  });
});
