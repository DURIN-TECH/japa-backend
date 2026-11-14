// ============================================
// Unit tests — agency per-visa service price (issue #103)
// ============================================
//
// Run with `npm test`. Hermetic: NO network and NO emulator. Firestore refs
// in utils/firebase are swapped for the in-memory fake
// (test/helpers/fake-firestore.ts + fake-collection-group.ts), the
// transaction runner for the in-memory one, and the controller handlers are
// called directly with a minimal req / res carrying a REAL CASL ability from
// @durin-tech/authz (defineAbilitiesFor). One suite mounts the real router on
// a local HTTP server to check the 401s.
//
// Two agencies, A and B. Covers:
//  - validation (issue #179): a US-dollar price `{ priceUsd: { amount,
//    currency? } }` only: finite, >= 0, whole cents, capped, USD only; a
//    bare number, the old naira `price`, another currency, a fraction of a
//    cent, negative, too large, missing, unknown key -> 400, nothing
//    written; path params;
//  - set / change / clear (DELETE and PUT null, idempotent);
//  - which visas: global seed visa, own approved agency visa OK; own
//    draft / pending / rejected -> 400; B on A's agency-only visa -> 404;
//    unknown visa -> 404; hidden global (pending scraped) -> 404;
//  - per agency: a visa made global gets independent prices from A and B;
//  - authz: owner + agent OK; admin, client, client with agencyId, agent
//    without agency -> 403; unauthenticated -> 401;
//  - reads: own approved + priced visas, include=global, stale prices hidden;
//  - public agency page: `visaPrices` only with this agency's prices, `[]`
//    when none, no auth;
//  - the government fee (baseCostUsd) is never written;
//  - PUT /agents/me drops the legacy `serviceFees`.

import { test, describe, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { Timestamp } from "firebase-admin/firestore";
import { ROLES, defineAbilitiesFor } from "@durin-tech/authz";

import { clone, fakeCollection, fakeRunTransaction, installFakes, resetStore, store, writes } from "../helpers/fake-firestore";
import type { Data } from "../helpers/fake-firestore";
import { fakeCollectionGroup } from "../helpers/fake-collection-group";
import { toMajor } from "../../src/money/money";
import { useFixedRate } from "../helpers/local-pricing";
import { agencyVisaPriceController } from "../../src/agency-visa-prices/agency-visa-price.controller";
import { agencyVisaPriceService } from "../../src/agency-visa-prices/agency-visa-price.service";
import {
  MAX_VISA_SERVICE_PRICE_USD_CENTS,
  parseVisaPriceBody,
  parseVisaPriceTarget,
} from "../../src/agency-visa-prices/agency-visa-price.validation";
import { AgencyVisaError } from "../../src/agency-visas/agency-visa.validation";
import { agencyController } from "../../src/controllers/agency.controller";
import { agentController } from "../../src/controllers/agent.controller";
import { agentService } from "../../src/services/agent.service";

/* eslint-disable @typescript-eslint/no-explicit-any */

// ============================================
// Fixtures
// ============================================

/** Country of every visa here. */
const CC = "GB";
/** Fixed timestamps: seeded docs, then the service clock. */
const T0 = Timestamp.fromMillis(1_700_000_000_000);
const T1 = Timestamp.fromMillis(1_700_000_100_000);
const AGENCY_A = "agency-a";
const AGENCY_B = "agency-b";

/** Store path of a visa doc. */
const visaPath = (id: string) => `countries/${CC}/visaTypes/${id}`;
/** A PUT body with a dollar price given in US cents (issue #179). */
const usdBody = (cents: number) => ({ priceUsd: { amount: toMajor({ amountMinor: cents, currency: "USD" }), currency: "USD" } });
/** A stored / returned dollar price as US cents, or null. */
const cents = (m: any): number | null => (m ? m.amountMinor : null);
/** USD Money from cents. */
const usd = (c: number) => ({ amountMinor: c, currency: "USD" });

/** Store path of an agency's price doc for a GB visa. */
const pricePath = (agencyId: string, id: string) => `agencies/${agencyId}/visaPrices/${CC}__${id}`;

/** A global seed visa (no visibility / reviewStatus fields: public). */
function seedGlobal(id: string, over: Data = {}): string {
  store.set(visaPath(id), {
    id,
    countryCode: CC,
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
    agentIds: [],
    isActive: true,
    createdAt: T0,
    updatedAt: T0,
    ...over,
  });
  return id;
}

/** An agency visa owned by `agencyId` (approved + agency-only by default). */
function seedAgencyVisa(id: string, agencyId = AGENCY_A, over: Data = {}): string {
  seedGlobal(id, {
    name: `Agency ${id}`,
    source: "agency",
    ownerAgencyId: agencyId,
    createdBy: `uid-owner-${agencyId}`,
    visibility: "agency",
    reviewStatus: "approved",
    isActive: true,
    ...over,
  });
  return id;
}

/** The two agency docs (approved, with slugs) + the supported GB country. */
function seedBase(): void {
  store.set(`countries/${CC}`, {
    code: CC,
    name: "United Kingdom",
    isSupported: true,
    popularityRank: 1,
    visaTypesCount: 0,
    minProcessingDays: 0,
    minCostUsd: 0,
    createdAt: T0,
    updatedAt: T0,
  });
  for (const [id, slug] of [[AGENCY_A, "acme"], [AGENCY_B, "bravo"]]) {
    store.set(`agencies/${id}`, {
      id,
      slug,
      name: `Agency ${slug}`,
      ownerId: `uid-owner-${id}`,
      ownerName: "Owner",
      services: [],
      totalAgents: 1,
      totalCases: 0,
      activeCases: 0,
      status: "approved",
      createdAt: T0,
      updatedAt: T0,
    });
  }
}

/** Writes made to any visa doc (must stay empty: pricing never edits a visa). */
const visaWrites = () => writes.filter((w) => w.path.startsWith("countries/"));

// ============================================
// Principals (real CASL abilities)
// ============================================

/** An authenticated principal: what verifyAuth puts on the request. */
interface Principal {
  userId: string;
  authz: { uid: string; role: string; agencyId: string | null };
  ability: unknown;
}

/** Build a principal for a role + agency. */
function principal(uid: string, role: (typeof ROLES)[keyof typeof ROLES], agencyId: string | null): Principal {
  const authz = { uid, role, agencyId };
  return { userId: uid, authz, ability: defineAbilitiesFor(authz as any) };
}

const ownerA = () => principal("uid-owner-a", ROLES.OWNER, AGENCY_A);
const agentA = () => principal("uid-agent-a", ROLES.AGENT, AGENCY_A);
const ownerB = () => principal("uid-owner-b", ROLES.OWNER, AGENCY_B);
const agentNoAgency = () => principal("uid-solo", ROLES.AGENT, null);
const client = () => principal("uid-client", ROLES.CLIENT, null);
const admin = () => principal("uid-admin", ROLES.ADMIN, null);

// ============================================
// Minimal Express req / res
// ============================================

/** Captured response of one handler call. */
interface Captured {
  status: number;
  body: any;
}

/** Call a handler as `who` with params / query / body; return status + body. */
async function call(
  handler: (req: any, res: any) => Promise<void>,
  who: Principal | null,
  req: { params?: Data; query?: Data; body?: unknown } = {}
): Promise<Captured> {
  const out: Captured = { status: 0, body: undefined };
  const res = {
    status(code: number) {
      out.status = code;
      return res;
    },
    json(body: unknown) {
      out.body = body;
      return res;
    },
  };
  await handler({ params: {}, query: {}, body: {}, headers: {}, ...(who ?? {}), ...req }, res);
  return out;
}

/** Bound handler shorthands. */
const C = agencyVisaPriceController;
const list = (who: Principal, query: Data = {}) => call(C.list.bind(C), who, { query });
const setPrice = (who: Principal, id: string, body: unknown, cc = CC) =>
  call(C.set.bind(C), who, { params: { countryCode: cc, visaTypeId: id }, body });
const clearPrice = (who: Principal, id: string) =>
  call(C.clear.bind(C), who, { params: { countryCode: CC, visaTypeId: id } });
const publicAgency = (slug: string) =>
  call(agencyController.getPublicAgency.bind(agencyController), null, { params: { slug } });

// ============================================
// Setup
// ============================================

before(async () => {
  await installFakes();
  const firebase: any = await import("../../src/utils/firebase");
  firebase.collections.agencies = fakeCollection("agencies");
  firebase.collectionGroups.visaTypes = () => fakeCollectionGroup("visaTypes");
  firebase.subcollections.agencyVisaPrices = (agencyId: string) => fakeCollection(`agencies/${agencyId}/visaPrices`);
  agencyVisaPriceService.runTransaction = fakeRunTransaction;
  agencyVisaPriceService.now = () => T1;
  // Issue #179: public reads price at a fixed ₦1,500 per dollar. The suite's
  // process ends after this file, so the wiring is not restored.
  useFixedRate(1500);
});

beforeEach(() => {
  resetStore();
  seedBase();
});

// ============================================
// Validation (pure)
// ============================================

describe("parseVisaPriceBody", () => {
  /** Expect a 400 AgencyVisaError naming `field`. */
  function expect400(body: unknown, field = "priceUsd", code = "VALIDATION_ERROR") {
    assert.throws(
      () => parseVisaPriceBody(body),
      (e: unknown) => e instanceof AgencyVisaError && e.httpStatus === 400 && e.field === field && e.code === code,
      JSON.stringify(body)
    );
  }

  test("dollars from $0 to the cap become US cents (issue #179)", () => {
    assert.deepEqual(parseVisaPriceBody({ priceUsd: { amount: "125.00", currency: "USD" } }), { priceUsd: usd(12500) });
    assert.deepEqual(parseVisaPriceBody({ priceUsd: { amount: 125.5 } }), { priceUsd: usd(12550) });
    assert.deepEqual(parseVisaPriceBody({ priceUsd: { amount: "0" } }), { priceUsd: usd(0) });
    assert.deepEqual(parseVisaPriceBody({ priceUsd: { amount: "100000.00", currency: "usd" } }), {
      priceUsd: usd(MAX_VISA_SERVICE_PRICE_USD_CENTS),
    });
  });

  test("null clears", () => {
    assert.deepEqual(parseVisaPriceBody({ priceUsd: null }), { priceUsd: null });
  });

  test("negative, non-numeric, sub-cent, other-currency and absurdly large values are 400 on `priceUsd`", () => {
    for (const priceUsd of [
      125, "125", true, {}, [], { amount: -1 }, { amount: "-1" }, { amount: "abc" }, { amount: true },
      { amount: Number.NaN }, { amount: Infinity }, { amount: 12.345 }, { amount: "0.001" }, { amount: "1e3" },
      { amount: "100000.01" }, { amount: 1e20 }, { amount: 10, currency: "NGN" }, { amount: 10, currency: 1 },
      { amountMinor: 1000, currency: "USD" }, { amount: 10, rate: 1500 },
    ]) {
      expect400({ priceUsd });
    }
  });

  test("a missing price, a non-object body, the old naira `price` and unknown keys are refused", () => {
    expect400({});
    expect400(null);
    expect400("12500");
    expect400([12500]);
    expect400({ price: 12500 }, "price", "UNKNOWN_FIELD");
    expect400({ ...usdBody(100), baseCostUsd: 5 }, "baseCostUsd", "UNKNOWN_FIELD");
    expect400({ ...usdBody(100), agencyId: AGENCY_B }, "agencyId", "UNKNOWN_FIELD");
  });
});

describe("parseVisaPriceTarget", () => {
  test("the country code is upper-cased", () => {
    assert.deepEqual(parseVisaPriceTarget({ countryCode: "gb", visaTypeId: "uk-student" }), {
      countryCode: "GB",
      visaTypeId: "uk-student",
    });
  });

  test("bad country codes and visa ids are 400", () => {
    for (const [countryCode, visaTypeId, field] of [
      ["GBR", "x", "countryCode"],
      ["", "x", "countryCode"],
      ["G1", "x", "countryCode"],
      ["GB", "", "visaTypeId"],
      ["GB", "..", "visaTypeId"],
      ["GB", "a/b", "visaTypeId"],
      ["GB", "x".repeat(201), "visaTypeId"],
    ]) {
      assert.throws(
        () => parseVisaPriceTarget({ countryCode, visaTypeId }),
        (e: unknown) => e instanceof AgencyVisaError && e.httpStatus === 400 && e.field === field
      );
    }
  });
});

// ============================================
// Set / change / clear
// ============================================

describe("set, change and clear", () => {
  test("the owner prices a global seed visa: stored in US dollars under their agency, visa untouched", async () => {
    const id = seedGlobal("uk-skilled-worker");
    const before = clone(store.get(visaPath(id)));
    const r = await setPrice(ownerA(), id, usdBody(12500));
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.data.priceUsd, usd(12500));
    assert.equal(r.body.data.baseCostUsd, 719); // government fee reported, separate
    assert.equal(r.body.data.visibility, "global");
    assert.equal(r.body.data.isOwnVisa, false);
    const stored = store.get(pricePath(AGENCY_A, id)) as any;
    assert.deepEqual(stored.priceUsd, usd(12500));
    assert.equal("price" in stored, false);
    assert.equal(stored.agencyId, AGENCY_A);
    assert.equal(stored.visaTypeId, id);
    assert.equal(stored.countryCode, CC);
    assert.equal(stored.updatedBy, "uid-owner-a");
    // Pricing never writes the visa (baseCostUsd unchanged).
    assert.deepEqual(visaWrites(), []);
    assert.deepEqual(store.get(visaPath(id)), before);
  });

  test("an agent of the agency can set and change the price; createdAt is kept", async () => {
    const id = seedGlobal("uk-student");
    store.set(pricePath(AGENCY_A, id), {
      id: `${CC}__${id}`, agencyId: AGENCY_A, visaTypeId: id, countryCode: CC,
      // A doc still holding an old naira `price` plus its migration audit.
      price: 1000, migratedFrom: { price: { amount: 1000, currency: "NGN", rate: 1500 } },
      updatedBy: "uid-owner-a", createdAt: T0, updatedAt: T0,
    });
    const r = await setPrice(agentA(), id, usdBody(2000));
    assert.equal(r.status, 200);
    const stored = store.get(pricePath(AGENCY_A, id)) as any;
    assert.deepEqual(stored.priceUsd, usd(2000));
    // Replace, not shadow: the naira price is gone, the audit kept.
    assert.equal("price" in stored, false);
    assert.equal(stored.migratedFrom.price.amount, 1000);
    assert.equal(stored.updatedBy, "uid-agent-a");
    assert.equal(stored.createdAt.toMillis(), T0.toMillis());
    assert.equal(stored.updatedAt.toMillis(), T1.toMillis());
  });

  test("a price of 0 is stored (it is a price, not 'unset')", async () => {
    const id = seedGlobal("uk-visitor");
    assert.equal((await setPrice(ownerA(), id, usdBody(0))).status, 200);
    assert.deepEqual((store.get(pricePath(AGENCY_A, id)) as any).priceUsd, usd(0));
  });

  test("DELETE clears the entry; PUT { priceUsd: null } clears too; clearing twice writes nothing", async () => {
    const id = seedGlobal("uk-student");
    await setPrice(ownerA(), id, usdBody(5000));
    const r = await clearPrice(ownerA(), id);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.data, { countryCode: CC, visaTypeId: id, priceUsd: null });
    assert.equal(store.has(pricePath(AGENCY_A, id)), false);

    await setPrice(ownerA(), id, usdBody(5000));
    const viaPut = await setPrice(ownerA(), id, { priceUsd: null });
    assert.equal(viaPut.status, 200);
    assert.equal(viaPut.body.data.priceUsd, null);
    assert.equal(store.has(pricePath(AGENCY_A, id)), false);

    writes.length = 0;
    assert.equal((await clearPrice(ownerA(), id)).status, 200);
    assert.deepEqual(writes, []);
  });

  test("an invalid price is 400 with a message and nothing is saved", async () => {
    const id = seedGlobal("uk-student");
    for (const priceUsd of [{ amount: -5 }, 500, { amount: 99.555 }, { amount: "100000.01" }, { amount: 5, currency: "NGN" }]) {
      const r = await setPrice(ownerA(), id, { priceUsd });
      assert.equal(r.status, 400, JSON.stringify(priceUsd));
      assert.equal(r.body.error, "VALIDATION_ERROR");
      assert.equal(r.body.field, "priceUsd");
      assert.match(r.body.message, /priceUsd/);
    }
    // The old naira field is refused too.
    const old = await setPrice(ownerA(), id, { price: 500 });
    assert.equal(old.status, 400);
    assert.equal(old.body.field, "price");
    assert.deepEqual(writes, []);
  });
});

// ============================================
// Which visas can be priced
// ============================================

describe("which visas", () => {
  test("the agency's own approved agency-only visa can be priced", async () => {
    const id = seedAgencyVisa("own-approved");
    const r = await setPrice(ownerA(), id, usdBody(250000));
    assert.equal(r.status, 200);
    assert.equal(r.body.data.isOwnVisa, true);
    assert.equal(r.body.data.visibility, "agency");
  });

  test("its own draft / pending / rejected / inactive visa is 400 VISA_NOT_APPROVED, nothing written", async () => {
    seedAgencyVisa("draft", AGENCY_A, { reviewStatus: "draft", isActive: false });
    seedAgencyVisa("pending", AGENCY_A, { reviewStatus: "pending_review", isActive: false });
    seedAgencyVisa("rejected", AGENCY_A, { reviewStatus: "rejected", isActive: false });
    seedAgencyVisa("inactive", AGENCY_A, { isActive: false });
    for (const id of ["draft", "pending", "rejected", "inactive"]) {
      const r = await setPrice(ownerA(), id, usdBody(100));
      assert.equal(r.status, 400, id);
      assert.equal(r.body.error, "VISA_NOT_APPROVED");
    }
    assert.deepEqual(writes, []);
  });

  test("agency B can't price agency A's agency-only visa: 404 (same body as unknown), nothing written", async () => {
    const id = seedAgencyVisa("a-only");
    const cross = await setPrice(ownerB(), id, usdBody(100));
    const unknown = await setPrice(ownerB(), "does-not-exist", usdBody(100));
    assert.equal(cross.status, 404);
    assert.deepEqual(cross.body, unknown.body);
    assert.deepEqual(cross.body, { success: false, error: "NOT_FOUND", message: "Visa not found" });
    assert.deepEqual(writes, []);
    assert.equal(store.has(pricePath(AGENCY_B, id)), false);
  });

  test("B can't price A's unapproved visa either (404, not 400: no leak)", async () => {
    const id = seedAgencyVisa("a-pending", AGENCY_A, { reviewStatus: "pending_review", isActive: false });
    const r = await setPrice(ownerB(), id, usdBody(100));
    assert.equal(r.status, 404);
    assert.deepEqual(writes, []);
  });

  test("a hidden non-agency visa (pending scraped) and a wrong country are 404", async () => {
    seedGlobal("scraped-pending", { source: "scraped", reviewStatus: "pending_review", isActive: false });
    const id = seedGlobal("uk-student");
    assert.equal((await setPrice(ownerA(), "scraped-pending", usdBody(1))).status, 404);
    assert.equal((await setPrice(ownerA(), id, usdBody(1), "CA")).status, 404);
    assert.deepEqual(writes, []);
  });
});

// ============================================
// Per-agency prices on a visa made global
// ============================================

describe("prices are per agency", () => {
  test("a visa A created and the admin made global: A and B each set their own price", async () => {
    const id = seedAgencyVisa("made-global", AGENCY_A, { visibility: "global" });
    assert.equal((await setPrice(ownerA(), id, usdBody(100000))).status, 200);
    assert.equal((await setPrice(ownerB(), id, usdBody(80000))).status, 200);
    assert.equal(cents((store.get(pricePath(AGENCY_A, id)) as any).priceUsd), 100000);
    assert.equal(cents((store.get(pricePath(AGENCY_B, id)) as any).priceUsd), 80000);

    const a = (await list(ownerA())).body.data.find((v: any) => v.visaTypeId === id);
    const b = (await list(ownerB())).body.data.find((v: any) => v.visaTypeId === id);
    assert.equal(cents(a.priceUsd), 100000);
    assert.equal(a.isOwnVisa, true);
    assert.equal(cents(b.priceUsd), 80000);
    assert.equal(b.isOwnVisa, false);

    // Clearing B's price leaves A's alone.
    await clearPrice(ownerB(), id);
    assert.equal(cents((store.get(pricePath(AGENCY_A, id)) as any).priceUsd), 100000);

    // Public pages: each agency shows only its own price.
    const pubA = (await publicAgency("acme")).body.data.visaPrices;
    const pubB = (await publicAgency("bravo")).body.data.visaPrices;
    assert.deepEqual(pubA.map((v: any) => [v.visaTypeId, cents(v.priceUsd)]), [[id, 100000]]);
    assert.deepEqual(pubB, []);
  });
});

// ============================================
// Authz
// ============================================

describe("authz", () => {
  test("admin, client, a client whose token carries an agencyId, and an agent without agency: 403", async () => {
    const id = seedGlobal("uk-student");
    for (const who of [admin(), client(), principal("uid-c", ROLES.CLIENT, AGENCY_A), agentNoAgency()]) {
      assert.equal((await list(who)).status, 403, who.authz.role);
      assert.equal((await setPrice(who, id, usdBody(1))).status, 403, who.authz.role);
      assert.equal((await clearPrice(who, id)).status, 403, who.authz.role);
    }
    assert.deepEqual(writes, []);
  });

  test("agency A never sees agency B's prices", async () => {
    const id = seedGlobal("uk-student");
    await setPrice(ownerB(), id, usdBody(777));
    const a = await list(ownerA());
    assert.equal(a.status, 200);
    assert.deepEqual(a.body.data, []);
    const withGlobal = await list(ownerA(), { include: "global" });
    assert.equal(withGlobal.body.data.find((v: any) => v.visaTypeId === id).priceUsd, null);
  });

  describe("unauthenticated (real router over HTTP)", () => {
    let server: http.Server;
    let base: string;

    before(async () => {
      const { agencyVisaPriceRoutes } = await import("../../src/agency-visa-prices");
      const app = express();
      app.use(express.json());
      app.use("/agency/visa-prices", agencyVisaPriceRoutes);
      server = app.listen(0, "127.0.0.1");
      await new Promise<void>((resolve) => server.once("listening", () => resolve()));
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });
    after(() => {
      server.close();
    });

    test("every route answers 401 without a token", async () => {
      for (const [method, path] of [
        ["GET", "/agency/visa-prices"],
        ["PUT", "/agency/visa-prices/GB/uk-student"],
        ["DELETE", "/agency/visa-prices/GB/uk-student"],
      ]) {
        const r = await fetch(`${base}${path}`, {
          method,
          headers: { "content-type": "application/json" },
          body: method === "PUT" ? JSON.stringify(usdBody(1)) : undefined,
        });
        assert.equal(r.status, 401, `${method} ${path}`);
      }
      assert.deepEqual(writes, []);
    });
  });
});

// ============================================
// Reads
// ============================================

describe("reads", () => {
  test("list: own approved visas (null when unpriced) first, then priced global; drafts and unpriced global left out", async () => {
    seedAgencyVisa("own-1", AGENCY_A, { createdAt: Timestamp.fromMillis(1), name: "Own one" });
    seedAgencyVisa("own-2", AGENCY_A, { createdAt: Timestamp.fromMillis(2), name: "Own two" });
    seedAgencyVisa("own-draft", AGENCY_A, { reviewStatus: "draft", isActive: false });
    seedAgencyVisa("b-only", AGENCY_B);
    seedGlobal("uk-student");
    seedGlobal("uk-visitor");
    await setPrice(ownerA(), "own-1", usdBody(300));
    await setPrice(ownerA(), "uk-visitor", usdBody(40000));

    const r = await list(agentA());
    assert.equal(r.status, 200);
    assert.deepEqual(
      r.body.data.map((v: any) => [v.visaTypeId, cents(v.priceUsd)]),
      [["own-2", null], ["own-1", 300], ["uk-visitor", 40000]]
    );
    const visitor = r.body.data[2];
    assert.equal(visitor.baseCostUsd, 719);
    assert.equal(visitor.priceUpdatedAt.toMillis(), T1.toMillis());
  });

  test("include=global adds every public visa not yet priced (never another agency's agency-only visa)", async () => {
    seedAgencyVisa("b-only", AGENCY_B);
    seedGlobal("uk-student");
    seedGlobal("uk-visitor");
    await setPrice(ownerA(), "uk-visitor", usdBody(1));
    const r = await list(ownerA(), { include: "global" });
    assert.deepEqual(
      r.body.data.map((v: any) => [v.visaTypeId, cents(v.priceUsd)]),
      // Sorted by country, then visa name.
      [["uk-student", null], ["uk-visitor", 1]]
    );
  });

  test("a stale price (visa deactivated, or taken back to agency-only) is kept but not shown", async () => {
    seedGlobal("uk-student");
    seedAgencyVisa("b-global", AGENCY_B, { visibility: "global" });
    await setPrice(ownerA(), "uk-student", usdBody(1));
    await setPrice(ownerA(), "b-global", usdBody(2));
    (store.get(visaPath("uk-student")) as any).isActive = false;
    (store.get(visaPath("b-global")) as any).visibility = "agency";
    assert.deepEqual((await list(ownerA())).body.data, []);
    assert.deepEqual((await publicAgency("acme")).body.data.visaPrices, []);
    // ... and can still be cleared.
    assert.equal((await clearPrice(ownerA(), "b-global")).status, 200);
    assert.equal(store.has(pricePath(AGENCY_A, "b-global")), false);
  });
});

// ============================================
// Public agency page
// ============================================

describe("public agency page (/agencies/public/:slug)", () => {
  test("no auth: lists offered visas with this agency's price or null", async () => {
    seedAgencyVisa("own-1");
    seedGlobal("uk-student");
    await setPrice(ownerA(), "uk-student", usdBody(12500));
    const r = await publicAgency("acme");
    assert.equal(r.status, 200);
    // The #103 keys of each entry (#102 adds applicant-safe visa detail to
    // the same entries; that part is covered in agency-visa-access.test.ts).
    const pick = ({ visaTypeId, countryCode, visaName, category, priceUsd, priceLocal }: any) => ({
      visaTypeId,
      countryCode,
      visaName,
      category,
      priceUsd,
      priceLocal,
    });
    assert.deepEqual(r.body.data.visaPrices.map(pick), [
      { visaTypeId: "own-1", countryCode: CC, visaName: "Agency own-1", category: "work", priceUsd: null, priceLocal: null },
      {
        visaTypeId: "uk-student", countryCode: CC, visaName: "Global uk-student", category: "work",
        // Issue #179: $125.00, and ₦187,500.00 (18,750,000 kobo) at ₦1,500/$.
        priceUsd: usd(12500),
        priceLocal: { amountMinor: 18_750_000, currency: "NGN", rate: 1500, asOf: "2026-11-13T09:00:00.000Z", available: true },
      },
    ]);
    assert.equal("price" in r.body.data.visaPrices[1], false);
    // No owner or review fields on the public page.
    for (const key of ["ownerAgencyId", "createdBy", "reviewStatus", "agentIds"]) {
      assert.ok(!JSON.stringify(r.body.data.visaPrices).includes(`"${key}"`), key);
    }
  });

  test("an agency with no priced visas gets `visaPrices: []` and the rest of the page", async () => {
    const r = await publicAgency("bravo");
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.data.visaPrices, []);
    assert.equal(r.body.data.name, "Agency bravo");
  });
});

// ============================================
// Legacy Agent.serviceFees
// ============================================

describe("legacy Agent.serviceFees", () => {
  test("PUT /agents/me drops serviceFees from the body", async () => {
    const svc: any = agentService;
    const originalGet = svc.getAgentByUserId;
    const originalUpdate = svc.updateAgent;
    let written: Data | undefined;
    svc.getAgentByUserId = async () => ({ id: "agent-1" });
    svc.updateAgent = async (_id: string, input: Data) => {
      written = input;
      return { id: "agent-1", ...input };
    };
    try {
      const r = await call(agentController.updateMyAgentProfile.bind(agentController), agentA(), {
        body: { bio: "hello", serviceFees: { "uk-student": 5000_00 } },
      });
      assert.equal(r.status, 200);
      assert.deepEqual(written, { bio: "hello" });
    } finally {
      svc.getAgentByUserId = originalGet;
      svc.updateAgent = originalUpdate;
    }
  });
});
