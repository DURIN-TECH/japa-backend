// ============================================
// Unit tests — public agency directory (issue #144)
// ============================================
//
// Run with `npm test`. Hermetic: NO network and NO emulator. The Firestore
// refs in utils/firebase are swapped for the in-memory fake
// (test/helpers/fake-firestore.ts + fake-collection-group.ts), and the REAL
// agency + agent routers are mounted on a local HTTP server, so every check
// goes through Express routing exactly like a mobile request (no
// Authorization header anywhere unless a test says so).
//
// Covers the #144 acceptance criteria:
//  - routes + shape: GET /agencies/browse, /browse/:id, /browse/:id/agents
//    are 200 with no auth; "browse" is never captured as ":id"; the slug
//    page and its consultations route still route as before; the item key
//    set matches the PublicAgency allow-list (+ visaPrices on the detail);
//  - only approved agencies (pending_review / rejected / suspended absent
//    from the list, 404 on detail + agents; unknown id 404); approved but
//    compliance-unverified agencies listed with verified: false;
//  - ?limit= (cap 100, invalid ignored, applied after ?search=), ?search=
//    (case-insensitive), no match = 200 [];
//  - no leaks: no ownerId / compliance / review fields / activeCases / bank,
//    BVN or NIN data; visaPrices[] without draft / pending / rejected /
//    inactive / other agencies' visas or prices / unpriced globals, and no
//    sponsor licence, createdBy, review fields, ownerAgencyId or agentIds;
//  - agents: only this agency's verified + available agents, same shape as
//    GET /agents;
//  - naira: price 12500 stays 12500; consultationFee + services unchanged;
//    baseCostUsd stays the government fee;
//  - resilience: a visaPrices read failure is logged and served as [];
//  - writes: POST / PUT / PATCH / DELETE on /browse* are 405 and write
//    nothing; POST /agencies and PUT /agencies/me still 401 without a token;
//  - indexes: the two queries match existing composite indexes.

import { test, describe, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { Timestamp } from "firebase-admin/firestore";

import { fakeCollection, installFakes, resetStore, store, writes } from "../helpers/fake-firestore";
import type { Data } from "../helpers/fake-firestore";
import { fakeCollectionGroup } from "../helpers/fake-collection-group";
import { agencyVisaPriceService } from "../../src/agency-visa-prices/agency-visa-price.service";
import { consultationController } from "../../src/controllers/consultation.controller";
import { parseBrowseLimit, parseBrowseSearch } from "../../src/controllers/agency.controller";
import { toPublicAgency, isAgencyPubliclyVisible } from "../../src/services/agency.service";
import type { Agency } from "../../src/types";

/* eslint-disable @typescript-eslint/no-explicit-any */

// ============================================
// Fixtures
// ============================================

/** Country of the visas here (plus one Canadian visa for agency B). */
const CC = "GB";
/** Agency ids: A approved + verified, B approved + unverified, then hidden ones. */
const A = "agency-a";
const B = "agency-b";
const PENDING = "agency-pending";
const REJECTED = "agency-rejected";
const SUSPENDED = "agency-suspended";

/** createdAt of agency number `n` (larger = newer). */
const at = (n: number) => Timestamp.fromMillis(1_700_000_000_000 + n * 1000);

/**
 * The PublicAgency allow-list: every key a /browse item may (and, apart
 * from the optional profile fields, must) have. /browse/:id adds visaPrices.
 */
const PUBLIC_AGENCY_KEYS = [
  "id",
  "name",
  "slug",
  "ownerName",
  "state",
  "address",
  "description",
  "logoUrl",
  "consultationFee",
  "services",
  "agentCount",
  "totalCases",
  "status",
  "verified",
  "createdAt",
].sort();

/** Strings that must never appear anywhere in a public response. */
const FORBIDDEN = [
  "\"ownerId\"",
  "\"compliance\"",
  "\"reviewedBy\"",
  "\"reviewedAt\"",
  "\"rejectionReason\"",
  "\"activeCases\"",
  "bvn",
  "nin",
  "accountNumber",
  "settlement",
  "22233344455", // the seeded BVN value
  "secret-internal",
];

/** Seed one agency doc, full of private fields the projection must drop. */
function seedAgency(id: string, over: Data = {}): void {
  store.set(`agencies/${id}`, {
    id,
    slug: id.replace("agency-", ""),
    name: `Agency ${id}`,
    ownerId: `uid-owner-${id}`,
    ownerName: "Ada Owner",
    state: "Lagos",
    address: "1 Marina, Lagos",
    description: "We help with UK visas",
    logoUrl: "https://example.invalid/logo.png",
    // Whole naira, as the portal stores them.
    consultationFee: 15000,
    services: [{ id: "svc-1", name: "CV review", price: 25000, internalNote: "secret-internal" }],
    totalAgents: 3,
    totalCases: 12,
    activeCases: 4,
    status: "approved",
    reviewedBy: "uid-admin",
    reviewedAt: at(0),
    rejectionReason: "",
    compliance: {
      status: "not_started",
      bvn: "22233344455",
      nin: "12345678901",
      settlement: { accountNumber: "0123456789", bankCode: "058" },
    },
    createdAt: at(1),
    updatedAt: at(1),
    ...over,
  });
}

/** Seed one agent doc. */
function seedAgent(id: string, agencyId: string | undefined, over: Data = {}): void {
  store.set(`agents/${id}`, {
    id,
    userId: `uid-${id}`,
    agencyId,
    agencyRole: "member",
    displayName: `Agent ${id}`,
    bio: "Bio",
    yearsOfExperience: 5,
    specializations: ["Work Visa"],
    languages: ["English"],
    featuredVisas: [],
    verificationStatus: "verified",
    rating: 4.5,
    totalReviews: 2,
    totalApplications: 3,
    successRate: 90,
    responseTime: "24 hours",
    consultationFee: 5000,
    isAvailable: true,
    createdAt: at(1),
    updatedAt: at(1),
    ...over,
  });
}

/** Store path of a visa doc. */
const visaPath = (cc: string, id: string) => `countries/${cc}/visaTypes/${id}`;

/** A global visa (no visibility / reviewStatus fields: public seed visa). */
function seedGlobal(id: string, over: Data = {}, cc = CC): void {
  store.set(visaPath(cc, id), {
    id,
    countryCode: cc,
    name: `Global ${id}`,
    code: id.toUpperCase(),
    description: "seed",
    category: "work",
    processingTime: "3 weeks",
    processingDaysMin: 15,
    processingDaysMax: 21,
    baseCostUsd: 719,
    validityPeriod: "5 years",
    isExtendable: true,
    eligibilityCriteria: [],
    agentIds: ["agent-x"],
    isActive: true,
    createdAt: at(1),
    updatedAt: at(1),
    ...over,
  });
}

/** An agency visa owned by `agencyId` (approved + agency-only by default). */
function seedAgencyVisa(id: string, agencyId: string, over: Data = {}, cc = CC): void {
  seedGlobal(
    id,
    {
      name: `Agency ${id}`,
      source: "agency",
      ownerAgencyId: agencyId,
      createdBy: `uid-owner-${agencyId}`,
      visibility: "agency",
      reviewStatus: "approved",
      reviewedBy: "uid-admin",
      isActive: true,
      sponsor: {
        organisationName: "Acme Ltd",
        website: "https://acme.invalid",
        licenceNumber: "LIC-SECRET-1",
        contactEmail: "sponsor-secret@acme.invalid",
      },
      ...over,
    },
    cc
  );
}

/** Seed an agency's price doc (whole naira, or null). */
function seedPrice(agencyId: string, visaTypeId: string, price: number | null, cc = CC): void {
  const id = `${cc}__${visaTypeId}`;
  store.set(`agencies/${agencyId}/visaPrices/${id}`, {
    id,
    agencyId,
    visaTypeId,
    countryCode: cc,
    price,
    updatedBy: `uid-owner-${agencyId}`,
    createdAt: at(1),
    updatedAt: at(1),
  });
}

/** The standard world: five agencies, their agents, visas and prices. */
function seedWorld(): void {
  // ---- Agencies ----
  seedAgency(A, { name: "Acme Visas", compliance: { status: "verified", bvn: "22233344455" }, createdAt: at(5) });
  seedAgency(B, { name: "Bravo Travel", consultationFee: undefined, createdAt: at(4) });
  seedAgency(PENDING, { name: "Pending Acme", status: "pending_review", createdAt: at(9) });
  seedAgency(REJECTED, { name: "Rejected Acme", status: "rejected", rejectionReason: "fake docs", createdAt: at(8) });
  seedAgency(SUSPENDED, { name: "Suspended Acme", status: "suspended", createdAt: at(7) });

  // ---- Agents ----
  seedAgent("a-ok-2", A, { displayName: "Zara" });
  seedAgent("a-ok-1", A, { displayName: "Bola" });
  seedAgent("a-busy", A, { isAvailable: false });
  seedAgent("a-unverified", A, { verificationStatus: "pending" });
  seedAgent("b-ok", B);
  seedAgent("suspended-ok", SUSPENDED);
  seedAgent("solo", undefined);

  // ---- Visas ----
  // A's own visas: one approved (listed), one of each hidden state.
  seedAgencyVisa("a-own", A);
  seedAgencyVisa("a-draft", A, { reviewStatus: "draft", isActive: false });
  seedAgencyVisa("a-pending", A, { reviewStatus: "pending", isActive: false });
  seedAgencyVisa("a-rejected", A, { reviewStatus: "rejected", isActive: false });
  seedAgencyVisa("a-inactive", A, { isActive: false });
  // B's agency-only visa, in another country under the same visaTypeId as
  // A's own visa, plus B's own GB visa.
  seedAgencyVisa("a-own", B, {}, "CA");
  seedAgencyVisa("b-own", B);
  // Global visas: one A priced, one nobody priced, one only B priced.
  seedGlobal("uk-student");
  seedGlobal("uk-visitor");
  seedGlobal("uk-graduate");

  // ---- Prices (whole naira) ----
  seedPrice(A, "uk-student", 12500);
  // A also has (stale) prices on its own hidden visas: never shown.
  seedPrice(A, "a-draft", 100);
  seedPrice(A, "a-inactive", 200);
  // B's prices, never on A's page.
  seedPrice(B, "uk-graduate", 99999);
  seedPrice(B, "a-own", 77777, "CA");
}

// ============================================
// HTTP harness (the real routers)
// ============================================

let server: http.Server;
let base: string;

/** Fetch `path` with no Authorization header; parse the JSON body. */
async function req(pathname: string, init: RequestInit = {}): Promise<{ status: number; body: any; text: string; headers: Headers }> {
  const r = await fetch(`${base}${pathname}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
  const text = await r.text();
  let body: any;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = undefined;
  }
  return { status: r.status, body, text, headers: r.headers };
}

/** Queries recorded by the recording agencies / agents collections. */
const queryLog: { col: string; calls: [string, ...unknown[]][] }[] = [];

/**
 * Wrap a fake collection so every query chain built from it is recorded
 * (where / orderBy / limit, in order) when it runs. Used to prove which
 * composite index each query needs.
 */
function recording(col: any, name: string, calls: [string, ...unknown[]][] = []): any {
  return {
    ...col,
    doc: col.doc,
    where: (...args: unknown[]) => recording(col.where(...args), name, [...calls, ["where", ...args]]),
    orderBy: (...args: unknown[]) => recording(col.orderBy(...args), name, [...calls, ["orderBy", ...args]]),
    limit: (...args: unknown[]) => recording(col.limit(...args), name, [...calls, ["limit", ...args]]),
    async get() {
      if (calls.length) queryLog.push({ col: name, calls });
      return col.get();
    },
  };
}

before(async () => {
  await installFakes();
  const firebase: any = await import("../../src/utils/firebase");
  firebase.collections.agencies = recording(fakeCollection("agencies"), "agencies");
  firebase.collections.agents = recording(fakeCollection("agents"), "agents");
  firebase.collectionGroups.visaTypes = () => fakeCollectionGroup("visaTypes");
  firebase.subcollections.agencyVisaPrices = (agencyId: string) => fakeCollection(`agencies/${agencyId}/visaPrices`);

  // Mount the real routers, as app.ts does.
  const { agencyRoutes } = await import("../../src/routes/agency.routes");
  const { agentRoutes } = await import("../../src/routes/agent.routes");
  const app = express();
  app.use(express.json());
  app.use("/agents", agentRoutes);
  app.use("/agencies", agencyRoutes);
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server.close();
});

beforeEach(() => {
  resetStore();
  queryLog.length = 0;
  seedWorld();
});

// ============================================
// Query param parsing (pure)
// ============================================

describe("?limit= and ?search= parsing", () => {
  test("limit: plain positive integers only, capped at 100; anything else ignored", () => {
    assert.equal(parseBrowseLimit("10"), 10);
    assert.equal(parseBrowseLimit(" 7 "), 7);
    assert.equal(parseBrowseLimit("100"), 100);
    assert.equal(parseBrowseLimit("101"), 100);
    assert.equal(parseBrowseLimit("99999999999999999999"), undefined);
    for (const bad of ["abc", "0", "-1", "1.5", "10abc", "", undefined, ["1", "2"], 5]) {
      assert.equal(parseBrowseLimit(bad), undefined, String(bad));
    }
  });

  test("search: trimmed string, blank or non-string ignored", () => {
    assert.equal(parseBrowseSearch("  acme "), "acme");
    assert.equal(parseBrowseSearch("   "), undefined);
    assert.equal(parseBrowseSearch(["a", "b"]), undefined);
    assert.equal(parseBrowseSearch(undefined), undefined);
  });
});

// ============================================
// Projection (pure)
// ============================================

describe("toPublicAgency", () => {
  test("copies only allow-listed fields; slug null when the agency has none", () => {
    const agency = { ...(store.get(`agencies/${A}`) as any), slug: undefined } as Agency;
    const p = toPublicAgency(agency);
    assert.deepEqual(Object.keys(p).sort(), PUBLIC_AGENCY_KEYS);
    assert.equal(p.slug, null);
    assert.equal(p.verified, true);
    assert.equal(p.agentCount, 3);
    assert.deepEqual(p.services, [{ id: "svc-1", name: "CV review", price: 25000 }]);
  });

  test("only approved agencies are publicly visible", () => {
    assert.equal(isAgencyPubliclyVisible({ status: "approved" }), true);
    for (const status of ["pending_review", "rejected", "suspended"] as const) {
      assert.equal(isAgencyPubliclyVisible({ status }), false, status);
    }
    assert.equal(isAgencyPubliclyVisible(null), false);
  });
});

// ============================================
// GET /agencies/browse
// ============================================

describe("GET /agencies/browse", () => {
  test("200 with no auth: approved agencies only, newest first, no visaPrices", async () => {
    const r = await req("/agencies/browse");
    assert.equal(r.status, 200);
    assert.equal(r.body.success, true);
    assert.deepEqual(
      r.body.data.map((a: any) => a.id),
      [A, B]
    );
    for (const item of r.body.data) {
      assert.equal(item.status, "approved");
      assert.equal("visaPrices" in item, false);
      // Every key is on the allow-list (optional profile fields may be absent).
      for (const k of Object.keys(item)) assert.ok(PUBLIC_AGENCY_KEYS.includes(k), `unexpected key ${k}`);
    }
    for (const bad of FORBIDDEN) assert.ok(!r.text.includes(bad), bad);
  });

  test("the mobile ApiAgency fields: full key set, verified badge, naira unchanged", async () => {
    const r = await req("/agencies/browse");
    const [a, b] = r.body.data;
    assert.deepEqual(Object.keys(a).sort(), PUBLIC_AGENCY_KEYS);
    assert.equal(a.slug, "a");
    assert.equal(a.ownerName, "Ada Owner");
    assert.equal(a.consultationFee, 15000);
    assert.deepEqual(a.services, [{ id: "svc-1", name: "CV review", price: 25000 }]);
    assert.equal(a.agentCount, 3);
    assert.equal(a.totalCases, 12);
    assert.equal(a.verified, true);
    // Timestamp over JSON.
    assert.equal(a.createdAt._seconds, at(5).seconds);
    // Approved but compliance not verified: still listed, with verified false.
    assert.equal(b.id, B);
    assert.equal(b.verified, false);
    // An unset fee is simply absent (mobile: optional).
    assert.equal("consultationFee" in b, false);
  });

  test("?search= is a case-insensitive name match; no match is 200 []", async () => {
    assert.deepEqual(
      (await req("/agencies/browse?search=aCmE")).body.data.map((a: any) => a.id),
      [A]
    );
    const none = await req("/agencies/browse?search=nothing-like-this");
    assert.equal(none.status, 200);
    assert.deepEqual(none.body.data, []);
  });

  test("?limit= caps results; it applies AFTER the search filter", async () => {
    assert.deepEqual(
      (await req("/agencies/browse?limit=1")).body.data.map((a: any) => a.id),
      [A]
    );
    // Newer non-matching agencies would fill a pushed-down limit of 1.
    seedAgency("agency-new-1", { name: "Zulu One", createdAt: at(20) });
    seedAgency("agency-new-2", { name: "Zulu Two", createdAt: at(21) });
    assert.deepEqual(
      (await req("/agencies/browse?search=bravo&limit=1")).body.data.map((a: any) => a.id),
      [B]
    );
  });

  test("an invalid ?limit= (abc, 0, -1) is ignored and never 500s", async () => {
    for (const bad of ["abc", "0", "-1", "", "1e3"]) {
      const r = await req(`/agencies/browse?limit=${bad}`);
      assert.equal(r.status, 200, bad);
      assert.equal(r.body.data.length, 2, bad);
    }
    // A repeated param is an array in Express: ignored too.
    assert.equal((await req("/agencies/browse?limit=1&limit=2&search=a&search=b")).status, 200);
  });

  test("?limit= above 100 (and no limit) return at most 100", async () => {
    for (let i = 0; i < 105; i++) seedAgency(`agency-bulk-${i}`, { name: `Bulk ${i}`, createdAt: at(100 + i) });
    assert.equal((await req("/agencies/browse?limit=500")).body.data.length, 100);
    assert.equal((await req("/agencies/browse")).body.data.length, 100);
  });

  test("uses the agencies (status ASC, createdAt DESC) index", async () => {
    await req("/agencies/browse");
    const q = queryLog.find((l) => l.col === "agencies");
    assert.deepEqual(q?.calls, [
      ["where", "status", "==", "approved"],
      ["orderBy", "createdAt", "desc"],
      ["limit", 100],
    ]);
    assert.ok(hasIndex("agencies", [["status", "ASCENDING"], ["createdAt", "DESCENDING"]]));
  });
});

// ============================================
// GET /agencies/browse/:id
// ============================================

describe("GET /agencies/browse/:id", () => {
  test("200 with no auth: the PublicAgency projection plus visaPrices", async () => {
    const r = await req(`/agencies/browse/${A}`);
    assert.equal(r.status, 200);
    assert.deepEqual(Object.keys(r.body.data).sort(), [...PUBLIC_AGENCY_KEYS, "visaPrices"].sort());
    assert.equal(r.body.data.id, A);
    assert.equal(r.body.data.slug, "a");
    assert.equal(r.body.data.status, "approved");
    for (const bad of FORBIDDEN) assert.ok(!r.text.includes(bad), bad);
  });

  test("visaPrices: own approved visa + priced global only; whole naira; no hidden or foreign visas", async () => {
    const r = await req(`/agencies/browse/${A}`);
    const prices = r.body.data.visaPrices;
    assert.deepEqual(
      prices.map((v: any) => [v.countryCode, v.visaTypeId, v.price]),
      [
        [CC, "a-own", null],
        [CC, "uk-student", 12500],
      ]
    );
    // Government fee untouched and separate from the agency price.
    const student = prices.find((v: any) => v.visaTypeId === "uk-student");
    assert.equal(student.baseCostUsd, 719);
    assert.notEqual(student.price, 1250000);
    assert.notEqual(student.price, 125);
    // Not listed: A's draft / pending / rejected / inactive visas, B's visas
    // (incl. B's CA "a-own" with the same id), B's prices, unpriced globals.
    const json = JSON.stringify(prices);
    for (const hidden of ["a-draft", "a-pending", "a-rejected", "a-inactive", "b-own", "uk-visitor", "uk-graduate", "\"CA\"", "99999", "77777"]) {
      assert.ok(!json.includes(hidden), hidden);
    }
    // No owner, review, sponsor-licence or agent fields.
    for (const key of ["ownerAgencyId", "createdBy", "reviewStatus", "reviewedBy", "agentIds", "licenceNumber", "contactEmail"]) {
      assert.ok(!json.includes(`"${key}"`), key);
    }
    assert.ok(!json.includes("LIC-SECRET-1") && !json.includes("sponsor-secret"));
    // The sponsor is the applicant-safe part only.
    assert.deepEqual(prices[0].sponsor, { organisationName: "Acme Ltd", website: "https://acme.invalid" });
  });

  test("visaPrices entries are identical to GET /agencies/public/:slug's", async () => {
    const byId = await req(`/agencies/browse/${A}`);
    const bySlug = await req("/agencies/public/a");
    assert.equal(bySlug.status, 200);
    assert.ok(byId.body.data.visaPrices.length > 0);
    assert.deepEqual(byId.body.data.visaPrices, bySlug.body.data.visaPrices);
    // Same verified badge and services on both.
    assert.equal(byId.body.data.verified, bySlug.body.data.verified);
    assert.deepEqual(byId.body.data.services, bySlug.body.data.services);
  });

  test("visaPrices is built by agencyVisaPriceService.listPublic(agency.id)", async () => {
    const svc: any = agencyVisaPriceService;
    const original = svc.listPublic;
    const seen: string[] = [];
    svc.listPublic = async (id: string) => {
      seen.push(id);
      return original.call(svc, id);
    };
    try {
      await req(`/agencies/browse/${A}`);
      assert.deepEqual(seen, [A]);
    } finally {
      svc.listPublic = original;
    }
  });

  test("an agency with no offered visas gets visaPrices: []", async () => {
    store.delete(`agencies/${B}/visaPrices/${CC}__uk-graduate`);
    store.delete(`agencies/${B}/visaPrices/CA__a-own`);
    (store.get(visaPath(CC, "b-own")) as any).reviewStatus = "draft";
    (store.get(visaPath("CA", "a-own")) as any).reviewStatus = "draft";
    const r = await req(`/agencies/browse/${B}`);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.data.visaPrices, []);
  });

  test("a visaPrices read failure is logged and served as [] with 200", async () => {
    const svc: any = agencyVisaPriceService;
    const original = svc.listPublic;
    const originalError = console.error;
    const logged: unknown[][] = [];
    svc.listPublic = async () => {
      throw new Error("boom");
    };
    console.error = (...args: unknown[]) => {
      logged.push(args);
    };
    try {
      const r = await req(`/agencies/browse/${A}`);
      assert.equal(r.status, 200);
      assert.deepEqual(r.body.data.visaPrices, []);
      assert.equal(r.body.data.name, "Acme Visas");
      assert.ok(logged.some((a) => String(a[0]).includes("visa prices")));
    } finally {
      svc.listPublic = original;
      console.error = originalError;
    }
  });

  test("404 NOT_FOUND for an unknown id and every non-approved agency (same body)", async () => {
    const bodies = new Set<string>();
    for (const id of ["nope", PENDING, REJECTED, SUSPENDED]) {
      const r = await req(`/agencies/browse/${id}`);
      assert.equal(r.status, 404, id);
      assert.equal(r.body.error, "NOT_FOUND", id);
      bodies.add(r.text);
    }
    assert.equal(bodies.size, 1);
  });
});

// ============================================
// GET /agencies/browse/:id/agents
// ============================================

describe("GET /agencies/browse/:id/agents", () => {
  test("200 with no auth: this agency's verified + available agents, by name", async () => {
    const r = await req(`/agencies/browse/${A}/agents`);
    assert.equal(r.status, 200);
    assert.deepEqual(
      r.body.data.map((a: any) => a.id),
      ["a-ok-1", "a-ok-2"]
    );
    for (const a of r.body.data) assert.equal(a.agencyId, A);
  });

  test("same shape as the public GET /agents (nothing extra)", async () => {
    const mine = (await req(`/agencies/browse/${A}/agents`)).body.data;
    const all = (await req("/agents")).body.data;
    for (const a of mine) {
      assert.deepEqual(a, all.find((x: any) => x.id === a.id));
    }
    const json = JSON.stringify(mine);
    for (const key of ["\"email\"", "\"phone\"", "\"phoneNumber\""]) assert.ok(!json.includes(key), key);
  });

  test("other agencies' agents never appear", async () => {
    const ids = (await req(`/agencies/browse/${B}/agents`)).body.data.map((a: any) => a.id);
    assert.deepEqual(ids, ["b-ok"]);
  });

  test("404 (not 200 []) for an unknown or non-approved agency", async () => {
    for (const id of ["nope", PENDING, REJECTED, SUSPENDED]) {
      const r = await req(`/agencies/browse/${id}/agents`);
      assert.equal(r.status, 404, id);
      assert.equal(r.body.error, "NOT_FOUND", id);
    }
  });

  test("uses the agents (agencyId ASC, displayName ASC) index", async () => {
    await req(`/agencies/browse/${A}/agents`);
    const q = queryLog.find((l) => l.col === "agents");
    assert.deepEqual(q?.calls, [
      ["where", "agencyId", "==", A],
      ["orderBy", "displayName", "asc"],
    ]);
    assert.ok(hasIndex("agents", [["agencyId", "ASCENDING"], ["displayName", "ASCENDING"]]));
  });
});

// ============================================
// Routing and writes
// ============================================

describe("routing and writes", () => {
  test("'browse' is never captured as :id; the slug page still works", async () => {
    // /browse/agents is "agency 'agents'" (unknown -> 404), not a members list.
    assert.equal((await req("/agencies/browse/agents")).status, 404);
    const slug = await req("/agencies/public/a");
    assert.equal(slug.status, 200);
    assert.equal(slug.body.data.name, "Acme Visas");
    // The slug page's own shape is unchanged (it has no id / status).
    assert.equal("id" in slug.body.data, false);
    assert.equal(slug.body.data.totalAgents, 3);
    assert.equal((await req("/agencies/public/pending")).status, 404);
  });

  test("POST /agencies/public/:slug/consultations still reaches its handler", async () => {
    const c: any = consultationController;
    const original = c.createPublicConsultation;
    let slug: string | undefined;
    c.createPublicConsultation = async (rq: any, rs: any) => {
      slug = rq.params.slug;
      rs.status(201).json({ success: true });
    };
    try {
      const r = await req("/agencies/public/a/consultations", { method: "POST", body: "{}" });
      assert.equal(r.status, 201);
      assert.equal(slug, "a");
    } finally {
      c.createPublicConsultation = original;
    }
  });

  test("POST / PUT / PATCH / DELETE on /agencies/browse* are 405 and write nothing", async () => {
    writes.length = 0;
    const paths = ["/agencies/browse", `/agencies/browse/${A}`, `/agencies/browse/${A}/agents`, "/agencies/browse/approval", "/agencies/browse/members"];
    for (const p of paths) {
      for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
        const r = await req(p, { method, body: JSON.stringify({ status: "approved" }) });
        assert.equal(r.status, 405, `${method} ${p}`);
        assert.equal(r.body.error, "METHOD_NOT_ALLOWED");
        assert.match(r.headers.get("allow") ?? "", /GET/);
      }
    }
    assert.deepEqual(writes, []);
  });

  test("POST /agencies and PUT /agencies/me still answer 401 without a token", async () => {
    assert.equal((await req("/agencies", { method: "POST", body: "{}" })).status, 401);
    assert.equal((await req("/agencies/me", { method: "PUT", body: "{}" })).status, 401);
    assert.deepEqual(writes, []);
  });
});

// ============================================
// Helpers
// ============================================

/** Does firestore.indexes.json have this exact COLLECTION index? */
function hasIndex(collectionGroup: string, fields: [string, string][]): boolean {
  const file = path.resolve(__dirname, "../../../firestore.indexes.json");
  const { indexes } = JSON.parse(fs.readFileSync(file, "utf8"));
  return indexes.some(
    (i: any) =>
      i.collectionGroup === collectionGroup &&
      i.queryScope === "COLLECTION" &&
      JSON.stringify(i.fields.map((f: any) => [f.fieldPath, f.order])) === JSON.stringify(fields)
  );
}
