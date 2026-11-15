// ============================================
// Emulator tests — the countries/visas seeder keeps runtime fields (issue #191)
// ============================================
//
// Run with `npm run test:emulator` (Firestore emulator, Admin SDK).
//
// seedCountriesAndVisas runs on every dev deploy. It must refresh the
// seed-owned content of a visa that already exists but NOT undo what admins
// and scripts did to it: isActive (deactivate:uk-seeds, #175), agentIds and
// createdAt. A visa that does not exist yet is created as before.

import { test, describe, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { FieldValue, Timestamp } from "firebase-admin/firestore";

import { resetEmulators } from "./helpers";

/* eslint-disable @typescript-eslint/no-explicit-any */

let db: any;
// #299: the seed takes options (made-up countries / visas / data for the fee tests).
let seed: (options?: any) => Promise<any>;
/** Firestore's "delete this field" marker. */
const FieldValueDelete = () => FieldValue.delete();

const visaRef = (id: string) => db.collection("countries").doc("GB").collection("visaTypes").doc(id);

before(async () => {
  // Lazy import: the emulator env (checked by setup.ts) must be in place first.
  ({ db } = await import("../../src/utils/firebase"));
  ({ seedCountriesAndVisas: seed } = await import("../../src/data/seed-countries-visas"));
});

beforeEach(async () => {
  await resetEmulators();
});

after(async () => {
  await resetEmulators();
});

describe("seedCountriesAndVisas on existing docs", () => {
  test("a fresh seed creates uk-visitor active, with no agents", async () => {
    await seed();
    const d = (await visaRef("uk-visitor").get()).data();
    assert.equal(d.isActive, true);
    assert.deepEqual(d.agentIds, []);
    assert.ok(d.createdAt instanceof Timestamp);
  });

  test("reseed keeps isActive, agentIds and createdAt; refreshes seed-owned fields", async () => {
    await seed();
    const oldCreated = Timestamp.fromMillis(1_000_000);
    // Admin / script changes, plus a stale seed-owned field to prove refresh.
    await visaRef("uk-visitor").update({
      isActive: false,
      agentIds: ["agent-1", "agent-2"],
      createdAt: oldCreated,
      name: "stale name",
    });

    await seed();

    const d = (await visaRef("uk-visitor").get()).data();
    assert.equal(d.isActive, false);
    assert.deepEqual(d.agentIds, ["agent-1", "agent-2"]);
    assert.ok(d.createdAt.isEqual(oldCreated));
    assert.notEqual(d.name, "stale name");
  });

  test("a doc deleted between seeds is recreated as new", async () => {
    await seed();
    await visaRef("uk-visitor").delete();
    await seed();
    const d = (await visaRef("uk-visitor").get()).data();
    assert.equal(d.isActive, true);
    assert.deepEqual(d.agentIds, []);
  });

  test("seeding twice changes nothing but updatedAt", async () => {
    await seed();
    const strip = (x: any) => {
      const { updatedAt, ...rest } = x;
      void updatedAt;
      return rest;
    };
    const a = strip((await visaRef("uk-visitor").get()).data());
    await seed();
    const b = strip((await visaRef("uk-visitor").get()).data());
    assert.deepEqual(b, a);
  });
});

// ============================================
// Issue #299: the sourced fee of a shared route, written by the seed
// ============================================
//
// The seed is given MADE-UP countries, visas and shared visa data (its
// options), so no real bloc, member or fee appears here. What is real is the
// wiring under test: the stored `appConfig/fx` and `guidanceSources/{id}`
// reads, the whole-document write, and the country's minimum cost.
describe("seedCountriesAndVisas: the sourced fee of a shared route (#299)", () => {
  const NOW = Timestamp.fromMillis(Date.parse("2026-11-14T10:00:00Z"));
  const DAY_MS = 24 * 60 * 60 * 1000;
  const SEK_PER_USD = 9.4321;
  let fixtureDataWithFee: () => any;
  let FIXTURE_DATA: any;
  let FIXTURE_FEE: any;

  /** Two made-up countries: XA (the member whose visitor record inherits the route) and XB. */
  const countries = [
    { code: "XA", name: "Country XA", flagUrl: "https://flags.example.org/xa.png", isSupported: true, popularityRank: 1 },
    { code: "XB", name: "Country XB", flagUrl: "https://flags.example.org/xb.png", isSupported: true, popularityRank: 2 },
  ];
  const visaBase = { name: "Visa", code: "V", description: "d", category: "tourist", processingTime: "1 week", processingDaysMin: 5, processingDaysMax: 7, isExtendable: false, eligibilityCriteria: [] };
  /** xa-visitor has NO fee of its own (it takes the route's); the other two have their own. */
  const visaTypes = [
    { ...visaBase, id: "xa-visitor", countryCode: "XA" },
    { ...visaBase, id: "xa-work", countryCode: "XA", baseCostUsd: 400 },
    { ...visaBase, id: "xb-visitor", countryCode: "XB", baseCostUsd: 55 },
  ];
  const run = (over: Record<string, unknown> = {}) => seed({ countries, visaTypes, sharedVisaData: fixtureDataWithFee(), now: NOW, ...over } as any);
  const visa = async (cc: string, id: string) => (await db.collection("countries").doc(cc).collection("visaTypes").doc(id).get()).data();
  const country = async (cc: string) => (await db.collection("countries").doc(cc).get()).data();
  /** Store the rate document, fetched `ageDays` ago. */
  const writeFx = (ageDays = 0, rates: Record<string, number> = { SEK: SEK_PER_USD }) =>
    db.collection("appConfig").doc("fx").set({
      base: "USD",
      rates,
      fetchedAt: Timestamp.fromMillis(NOW.toMillis() - ageDays * DAY_MS),
      rateDate: new Date(NOW.toMillis() - (ageDays + 1) * DAY_MS).toISOString().slice(0, 10),
      source: "frankfurter.dev (ECB reference rates)",
    });
  const writeSource = () => db.collection("guidanceSources").doc(FIXTURE_FEE.guidanceSourceId).set({ title: "Placeholder source", url: FIXTURE_FEE.url });

  before(async () => {
    ({ fixtureDataWithFee, FIXTURE_DATA, FIXTURE_FEE } = await import("../helpers/shared-visa-fixture"));
  });

  test("fresh rate + source on record: baseCostUsd, sourcedFee and the country minimum; other records untouched", async () => {
    await writeFx();
    await writeSource();
    await run();
    const d = await visa("XA", "xa-visitor");
    const want = Math.round(FIXTURE_FEE.amount / SEK_PER_USD);
    assert.equal(d.baseCostUsd, want);
    assert.equal(d.sourcedFee.sharedRouteId, "example-short-stay");
    assert.equal(d.sourcedFee.quote, FIXTURE_FEE.quote);
    assert.equal(d.sourcedFee.url, FIXTURE_FEE.url);
    assert.equal(d.sourcedFee.guidanceSourceId, FIXTURE_FEE.guidanceSourceId);
    assert.deepEqual(d.sourcedFee.ruleRef, FIXTURE_FEE.ruleRef);
    assert.equal(d.sourcedFee.fee.totalUsd, FIXTURE_FEE.amount / SEK_PER_USD);
    assert.equal(d.sourcedFee.fee.fxRateToUsd.SEK, 1 / SEK_PER_USD);
    assert.equal(d.sourcedFee.fee.fxDate, "2026-11-13");
    assert.ok(d.sourcedFee.fee.fxSource);
    assert.deepEqual(d.inheritsFrom, [{ sharedRouteId: "example-short-stay" }]);
    // The minimum counts the sourced figure like any seed fee (it is below xa-work's 400).
    assert.equal((await country("XA")).minCostUsd, want);
    // Records the data file does not list are exactly as before.
    assert.equal((await visa("XA", "xa-work")).baseCostUsd, 400);
    assert.equal("sourcedFee" in (await visa("XA", "xa-work")), false);
    assert.equal((await visa("XB", "xb-visitor")).baseCostUsd, 55);
    assert.equal((await country("XB")).minCostUsd, 55);
  });

  test("a second run with the same data and rate changes nothing but updatedAt", async () => {
    await writeFx();
    await writeSource();
    await run();
    const a = await visa("XA", "xa-visitor");
    await run();
    const b = await visa("XA", "xa-visitor");
    assert.deepEqual({ ...b, updatedAt: null }, { ...a, updatedAt: null });
  });

  test("a stale rate keeps the stored fee; without a stored fee it writes none", async () => {
    await writeFx();
    await writeSource();
    await run();
    const fresh = await visa("XA", "xa-visitor");
    // Ten days old: past the freshness limit.
    await writeFx(10, { SEK: 5 });
    await run();
    const kept = await visa("XA", "xa-visitor");
    assert.equal(kept.baseCostUsd, fresh.baseCostUsd);
    assert.deepEqual(kept.sourcedFee, fresh.sourcedFee);
    assert.equal((await country("XA")).minCostUsd, fresh.baseCostUsd);
    // The stored block is gone: nothing to keep, so no figure at all.
    await db.collection("countries").doc("XA").collection("visaTypes").doc("xa-visitor").update({ sourcedFee: FieldValueDelete() });
    await run();
    const none = await visa("XA", "xa-visitor");
    assert.equal("baseCostUsd" in none, false);
    assert.equal("sourcedFee" in none, false);
    // With no fee on xa-visitor the minimum is xa-work's own 400.
    assert.equal((await country("XA")).minCostUsd, 400);
  });

  test("no rate document, or no rate for the currency: no figure (never 0)", async () => {
    await writeSource();
    await run();
    assert.equal("baseCostUsd" in (await visa("XA", "xa-visitor")), false);
    await writeFx(0, { CHF: 0.8 });
    await run();
    const d = await visa("XA", "xa-visitor");
    assert.equal("baseCostUsd" in d, false);
    assert.equal("sourcedFee" in d, false);
  });

  test("the official source is not on record: no fee for the route", async () => {
    await writeFx();
    await run();
    const d = await visa("XA", "xa-visitor");
    assert.equal("baseCostUsd" in d, false);
    assert.equal("sourcedFee" in d, false);
  });

  test("removing the fee from the data file removes baseCostUsd and sourcedFee on the next run", async () => {
    await writeFx();
    await writeSource();
    await run();
    assert.ok((await visa("XA", "xa-visitor")).sourcedFee);
    await run({ sharedVisaData: FIXTURE_DATA });
    const d = await visa("XA", "xa-visitor");
    assert.equal("baseCostUsd" in d, false);
    assert.equal("sourcedFee" in d, false);
    assert.deepEqual(d.inheritsFrom, [{ sharedRouteId: "example-short-stay" }]);
  });

  // ---- #306: an entry that states no processing time and no extension flag ----
  // Like the real short-stay records #306 adds, but made up: xa-visitor here
  // has no processingTime / processingDaysMin / processingDaysMax /
  // isExtendable, and is the ONLY visa of country XA.
  test("#306: an entry with no processing fields or isExtendable is stored without them, and still gets the route fee", async () => {
    await writeFx();
    await writeSource();
    const { processingTime, processingDaysMin, processingDaysMax, isExtendable, ...bare } = visaBase;
    void processingTime; void processingDaysMin; void processingDaysMax; void isExtendable;
    const onlyBare = [
      { ...bare, id: "xa-visitor", countryCode: "XA" },
      { ...visaBase, id: "xb-visitor", countryCode: "XB", baseCostUsd: 55 },
    ];
    await run({ visaTypes: onlyBare });
    const d = await visa("XA", "xa-visitor");
    for (const key of ["processingTime", "processingDaysMin", "processingDaysMax", "isExtendable"]) {
      assert.equal(key in d, false, `${key} is not stored`);
    }
    // The route's fee is written as for any inheriting record.
    assert.equal(d.baseCostUsd, Math.round(FIXTURE_FEE.amount / SEK_PER_USD));
    assert.equal(d.sourcedFee.quote, FIXTURE_FEE.quote);
    assert.deepEqual(d.inheritsFrom, [{ sharedRouteId: "example-short-stay" }]);
    // The country minimum is a number (0: no visa of XA states one), never NaN.
    const xa = await country("XA");
    assert.equal(typeof xa.minProcessingDays, "number");
    assert.equal(Number.isNaN(xa.minProcessingDays), false);
    assert.equal(xa.minProcessingDays, 0);
    // A country whose visas state one keeps the old rule.
    assert.equal((await country("XB")).minProcessingDays, 5);
  });

  test("#306: the minimum processing time counts only the visas that state one", async () => {
    const { processingTime, processingDaysMin, processingDaysMax, ...noProcessing } = visaBase;
    void processingTime; void processingDaysMin; void processingDaysMax;
    await run({
      visaTypes: [
        { ...noProcessing, id: "xa-visitor", countryCode: "XA" },
        { ...visaBase, id: "xa-work", countryCode: "XA", baseCostUsd: 400, processingDaysMin: 12 },
      ],
    });
    assert.equal((await country("XA")).minProcessingDays, 12);
  });

  test("an entry with its own baseCostUsd that inherits a route with a fee stops the seed before any write", async () => {
    await writeFx();
    await writeSource();
    const conflicting = visaTypes.map((v) => (v.id === "xa-visitor" ? { ...v, baseCostUsd: 40 } : v));
    await assert.rejects(run({ visaTypes: conflicting }), /XA\/xa-visitor.*two fee sources/s);
    assert.equal((await db.collection("countries").doc("XA").get()).exists, false);
  });
});

// ============================================
// Issue #339: the sourced processing time and stay limit of a shared route
// ============================================
//
// Same approach as #299 above: MADE-UP countries, visas and shared visa data
// (no real bloc, quote or figure). What is real is the wiring under test: the
// `guidanceSources/{id}` reads, the whole-document write, the stored
// `inheritsFrom` rule, the two-sources guard and the country's minimum.
describe("seedCountriesAndVisas: the sourced processing time and stay limit (#339)", () => {
  let fixtureDataWithFacts: () => any;
  let FIXTURE_DATA: any;
  let FIXTURE_PROCESSING: any;
  let FIXTURE_VALIDITY: any;

  const countries = [
    { code: "XA", name: "Country XA", flagUrl: "https://flags.example.org/xa.png", isSupported: true, popularityRank: 1 },
    { code: "XB", name: "Country XB", flagUrl: "https://flags.example.org/xb.png", isSupported: true, popularityRank: 2 },
  ];
  /** xa-visitor inherits the route and states no processing time or validity of its own; xb-visitor has its own. */
  const visaTypes = [
    { id: "xa-visitor", countryCode: "XA", name: "Visa", code: "V", description: "d", category: "tourist", eligibilityCriteria: [] },
    { id: "xb-visitor", countryCode: "XB", name: "Visa", code: "V", description: "d", category: "tourist", processingTime: "1 week", processingDaysMin: 5, processingDaysMax: 7, validityPeriod: "30 days", isExtendable: false, eligibilityCriteria: [] },
  ];
  const run = (over: Record<string, unknown> = {}) => seed({ countries, visaTypes, sharedVisaData: fixtureDataWithFacts(), ...over } as any);
  const ref = (cc: string, id: string) => db.collection("countries").doc(cc).collection("visaTypes").doc(id);
  const visa = async (cc: string, id: string) => (await ref(cc, id).get()).data();
  const writeSources = () =>
    Promise.all([
      db.collection("guidanceSources").doc(FIXTURE_PROCESSING.guidanceSourceId).set({ title: "Placeholder processing source", url: FIXTURE_PROCESSING.url }),
      db.collection("guidanceSources").doc(FIXTURE_VALIDITY.guidanceSourceId).set({ title: "Placeholder stay source", url: FIXTURE_VALIDITY.url }),
    ]);

  before(async () => {
    ({ fixtureDataWithFacts, FIXTURE_DATA, FIXTURE_PROCESSING, FIXTURE_VALIDITY } = await import("../helpers/shared-visa-fixture"));
  });

  test("writes the route's values and one citation per fact; no unstated minimum; other records untouched", async () => {
    await writeSources();
    await run();
    const d = await visa("XA", "xa-visitor");
    assert.equal(d.processingTime, FIXTURE_PROCESSING.processingTime);
    assert.equal(d.processingDaysMax, FIXTURE_PROCESSING.processingDaysMax);
    assert.equal("processingDaysMin" in d, false);
    assert.equal(d.validityPeriod, FIXTURE_VALIDITY.validityPeriod);
    assert.equal("isExtendable" in d, false);
    assert.equal("maxExtensions" in d, false);
    assert.deepEqual(d.sourcedFacts, {
      processing: { sharedRouteId: "example-short-stay", quote: FIXTURE_PROCESSING.quote, url: FIXTURE_PROCESSING.url, guidanceSourceId: FIXTURE_PROCESSING.guidanceSourceId },
      validity: { sharedRouteId: "example-short-stay", quote: FIXTURE_VALIDITY.quote, url: FIXTURE_VALIDITY.url, guidanceSourceId: FIXTURE_VALIDITY.guidanceSourceId },
    });
    // XA's only visa states no minimum: the country's minimum is the existing
    // "none" value 0, not a figure taken from the route.
    assert.equal((await db.collection("countries").doc("XA").get()).data().minProcessingDays, 0);
    // A record the data file does not list is exactly as its seed entry says.
    const b = await visa("XB", "xb-visitor");
    assert.equal(b.processingTime, "1 week");
    assert.equal(b.validityPeriod, "30 days");
    assert.equal("sourcedFacts" in b, false);
  });

  test("a second run changes nothing but updatedAt", async () => {
    await writeSources();
    await run();
    const a = await visa("XA", "xa-visitor");
    await run();
    const b = await visa("XA", "xa-visitor");
    assert.deepEqual({ ...b, updatedAt: null }, { ...a, updatedAt: null });
  });

  test("the stored inheritsFrom wins: a record pointed at another route gets no route facts", async () => {
    await writeSources();
    await run();
    await ref("XA", "xa-visitor").update({ inheritsFrom: [{ sharedRouteId: "another-route" }] });
    await run();
    const d = await visa("XA", "xa-visitor");
    for (const k of ["processingTime", "processingDaysMax", "validityPeriod", "sourcedFacts"]) assert.equal(k in d, false, `${k} is not stored`);
    assert.deepEqual(d.inheritsFrom, [{ sharedRouteId: "another-route" }]);
  });

  test("a fact whose official source is not on record is not written", async () => {
    await db.collection("guidanceSources").doc(FIXTURE_VALIDITY.guidanceSourceId).set({ title: "Placeholder stay source" });
    await run();
    const d = await visa("XA", "xa-visitor");
    assert.equal("processingTime" in d, false);
    assert.equal(d.validityPeriod, FIXTURE_VALIDITY.validityPeriod);
    assert.deepEqual(Object.keys(d.sourcedFacts), ["validity"]);
  });

  test("removing the blocks from the data file removes the facts on the next run", async () => {
    await writeSources();
    await run();
    await run({ sharedVisaData: FIXTURE_DATA });
    const d = await visa("XA", "xa-visitor");
    for (const k of ["processingTime", "processingDaysMax", "validityPeriod", "sourcedFacts"]) assert.equal(k in d, false, `${k} is not stored`);
  });

  test("an inheriting entry with its own processing time or validity stops the seed before any write", async () => {
    await writeSources();
    const conflicting = visaTypes.map((v) => (v.id === "xa-visitor" ? { ...v, processingTime: "2 weeks", validityPeriod: "60 days" } : v));
    await assert.rejects(run({ visaTypes: conflicting }), /XA\/xa-visitor has its own processingTime.*XA\/xa-visitor has its own validityPeriod/s);
    assert.equal((await db.collection("countries").doc("XA").get()).exists, false);
  });
});

// ============================================
// Issue #339: the SHIPPED data file, end to end through the public visa read
// ============================================
//
// The deploy seed (no options: the repo's countries, visas and data file),
// then `GET /countries/:code/visas/:visaId` for every record the data file
// lists under a route with a processing time and stay limit. The values
// asserted are the issue's acceptance criteria; the codes, ids, quotes and
// source ids are read from the data file, never typed here.
describe("seedCountriesAndVisas: the shipped route facts through GET /countries/:code/visas/:visaId (#339)", () => {
  test("every inheriting record serves the issue's values and its citations, twice in a row", async () => {
    const { loadSharedVisaData } = await import("../../src/data/shared-visa-data-format");
    const { startApi } = await import("./helpers");
    const data = loadSharedVisaData();
    const routes = data.sharedRoutes.filter((r) => r.processing && r.validity);
    assert.equal(routes.length, 1, "one shipped route records both facts");
    const route = routes[0];
    // The cited official source is on record (as on dev, where the fee needs it too).
    await db.collection("guidanceSources").doc(route.processing!.guidanceSourceId).set({ title: "Visa Code (test copy of the id only)", url: route.processing!.url });

    await seed();
    await seed(); // idempotent: the second run writes the same values

    const api = await startApi();
    try {
      assert.equal(route.inheritedBy.length, 29);
      for (const x of route.inheritedBy) {
        const { status, body } = await api.call("GET", `/countries/${x.countryCode}/visas/${x.visaTypeId}`);
        assert.equal(status, 200, `${x.visaTypeId}: ${JSON.stringify(body)}`);
        const v = body.data;
        assert.equal(v.processingTime, "Up to 15 calendar days (up to 45 in individual cases)", x.visaTypeId);
        assert.equal(v.processingDaysMax, 45, x.visaTypeId);
        assert.equal(v.validityPeriod, "Stays of up to 90 days in any 180-day period", x.visaTypeId);
        for (const k of ["processingDaysMin", "isExtendable", "maxExtensions"]) assert.equal(k in v, false, `${x.visaTypeId} has no ${k}`);
        assert.deepEqual(v.eligibilityCriteria, [], x.visaTypeId);
        assert.deepEqual(v.sourcedFacts.processing, { sharedRouteId: route.id, quote: route.processing!.quote, url: route.processing!.url, guidanceSourceId: route.processing!.guidanceSourceId });
        assert.deepEqual(v.sourcedFacts.validity, { sharedRouteId: route.id, quote: route.validity!.quote, url: route.validity!.url, guidanceSourceId: route.validity!.guidanceSourceId });
      }
    } finally {
      await api.close();
    }
  });
});
