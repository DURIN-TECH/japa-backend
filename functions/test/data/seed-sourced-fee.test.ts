// ============================================
// Unit tests — the seed's sourced fee of a shared route (issue #299)
// ============================================
// Pure: no Firestore. The data is the made-up fixture (user-assigned country
// codes, made-up ids, a placeholder fee and quote): no real bloc or fee.
// The expected figures are computed with `computeFee`, the conversion the
// production code must use, never typed by hand.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { Timestamp } from "firebase-admin/firestore";

import { loadSharedVisaData, routeFeesFor } from "../../src/data/shared-visa-data-format";
import { effectiveSeedCost, planSourcedFee, seedFeeProblems, sourcedFeeFields } from "../../src/data/seed-sourced-fee";
import { computeFee } from "../../src/scrapers";
import type { FxRatesDoc } from "../../src/types";
import { FIXTURE_DATA, FIXTURE_FEE, fixtureDataWithFee } from "../helpers/shared-visa-fixture";

/* eslint-disable @typescript-eslint/no-explicit-any */

const NOW = Timestamp.fromMillis(Date.parse("2026-11-14T10:00:00Z"));
/** The name the stored rate document gives its source (any text: it is copied onto the fee). */
const FX_SOURCE_ECB = "placeholder rate source";
const DAY_MS = 24 * 60 * 60 * 1000;
/** A usable rate document: fetched today, rate date yesterday. */
const FRESH_FX: FxRatesDoc = { base: "USD", rates: { SEK: 9.4321, CHF: 0.8 }, fetchedAt: NOW, rateDate: "2026-11-13", source: FX_SOURCE_ECB };
/** The same rates, fetched ten days ago (older than the 7-day limit). */
const STALE_FX: FxRatesDoc = { ...FRESH_FX, fetchedAt: Timestamp.fromMillis(NOW.toMillis() - 10 * DAY_MS), rateDate: "2026-11-03" };

const DATA = loadSharedVisaData(fixtureDataWithFee());
const ROUTE_FEES = routeFeesFor(DATA, "XA", "xa-visitor");
const sourceExists = () => true;
/** What `computeFee` gives for the fixture fee at a rate document. */
const expected = (fx: FxRatesDoc | undefined) =>
  computeFee([{ kind: "application", label: FIXTURE_FEE.label, amount: FIXTURE_FEE.amount, currency: FIXTURE_FEE.currency, per: "application" }], fx, NOW);

/** Plan for XA/xa-visitor with the given stored doc and rates. */
const plan = (existing: Record<string, unknown> | undefined, fx: FxRatesDoc | undefined, routeFees = ROUTE_FEES, exists: (id: string) => boolean = sourceExists) =>
  planSourcedFee({ routeFees, existing, fx, now: NOW, guidanceSourceExists: exists });

/** The stored fields a fresh run writes (what a later run finds on the record). */
function storedAfterFreshRun(): Record<string, unknown> {
  const d = plan(undefined, FRESH_FX);
  assert.equal(d.action, "write");
  return { ...sourcedFeeFields(d)!, inheritsFrom: [{ sharedRouteId: "example-short-stay" }] } as Record<string, unknown>;
}

describe("planSourcedFee: a usable rate", () => {
  test("writes computeFee's whole-USD figure and its fee block, with the source beside it", () => {
    const d = plan(undefined, FRESH_FX);
    const want = expected(FRESH_FX);
    assert.equal(d.action, "write");
    if (d.action !== "write") return;
    assert.equal(d.baseCostUsd, want.baseCostUsd);
    assert.equal(d.baseCostUsd, Math.round(FIXTURE_FEE.amount / FRESH_FX.rates.SEK));
    assert.deepEqual(d.sourcedFee, {
      sharedRouteId: "example-short-stay",
      quote: FIXTURE_FEE.quote,
      url: FIXTURE_FEE.url,
      guidanceSourceId: FIXTURE_FEE.guidanceSourceId,
      ruleRef: FIXTURE_FEE.ruleRef,
      fee: want.feeMeta,
    });
    // The dated rate is stored with the figure.
    assert.equal(typeof d.sourcedFee.fee.totalUsd, "number");
    assert.equal(d.sourcedFee.fee.fxRateToUsd?.SEK, 1 / FRESH_FX.rates.SEK);
    assert.equal(d.sourcedFee.fee.fxDate, "2026-11-13");
    assert.equal(d.sourcedFee.fee.fxSource, expected(FRESH_FX).feeMeta.fxSource);
    assert.ok(d.sourcedFee.fee.fxSource);
  });

  test("a second run with the same data and rate gives the same values (nothing drifts or doubles)", () => {
    const first = plan(undefined, FRESH_FX);
    const second = plan(storedAfterFreshRun(), FRESH_FX);
    assert.deepEqual(second, first);
  });

  test("a fee with no rule reference has no ruleRef key (no undefined for Firestore)", () => {
    const raw: any = fixtureDataWithFee();
    delete raw.sharedRoutes[0].fee.ruleRef;
    const d = plan(undefined, FRESH_FX, routeFeesFor(loadSharedVisaData(raw), "XA", "xa-visitor"));
    assert.equal(d.action, "write");
    if (d.action === "write") assert.equal("ruleRef" in d.sourcedFee, false);
  });

  test("a changed amount is re-converted, never left at the old figure", () => {
    const raw: any = fixtureDataWithFee();
    raw.sharedRoutes[0].fee.amount = 300;
    raw.sharedRoutes[0].fee.quote = "Placeholder sentence stating that the fee is SEK 300.";
    const d = plan(storedAfterFreshRun(), FRESH_FX, routeFeesFor(loadSharedVisaData(raw), "XA", "xa-visitor"));
    assert.equal(d.action, "write");
    if (d.action === "write") assert.equal(d.baseCostUsd, Math.round(300 / FRESH_FX.rates.SEK));
  });
});

describe("planSourcedFee: no usable rate", () => {
  const noRateCases: Array<[string, FxRatesDoc | undefined, RegExp]> = [
    ["missing", undefined, /appConfig\/fx is missing/],
    ["stale", STALE_FX, /stale/],
    ["without the currency", { ...FRESH_FX, rates: { CHF: 0.8 } }, /no SEK rate/],
  ];

  for (const [name, fx, why] of noRateCases) {
    test(`rates ${name} + a matching stored fee: the stored figure and block are kept unchanged`, () => {
      const stored = storedAfterFreshRun();
      const d = plan(stored, fx);
      assert.equal(d.action, "keep");
      if (d.action !== "keep") return;
      assert.equal(d.baseCostUsd, stored.baseCostUsd);
      assert.deepEqual(d.sourcedFee, stored.sourcedFee);
      assert.match(d.reason, why);
    });

    test(`rates ${name} + no stored fee: no figure at all (not a guess, not 0)`, () => {
      for (const existing of [undefined, { inheritsFrom: [{ sharedRouteId: "example-short-stay" }] }, { baseCostUsd: 90 }]) {
        const d = plan(existing, fx);
        assert.equal(d.action, "omit");
        assert.equal(sourcedFeeFields(d), undefined);
        if (d.action === "omit") assert.match(d.reason, why);
      }
    });
  }

  test("stale rates + a stored fee for a different amount, currency, quote or route: no figure (the old one is not kept)", () => {
    const changes: Array<(fee: any) => void> = [
      (fee) => { fee.amount = 300; fee.quote = "Placeholder sentence stating that the fee is SEK 300."; },
      (fee) => { fee.currency = "CHF"; fee.quote = "Placeholder sentence stating that the fee is CHF 250."; },
      (fee) => { fee.quote = "Another placeholder sentence: the fee is SEK 250."; },
    ];
    for (const change of changes) {
      const raw: any = fixtureDataWithFee();
      change(raw.sharedRoutes[0].fee);
      // CHF has a rate in STALE_FX too, so every case here is "stale", not "missing".
      const d = plan(storedAfterFreshRun(), STALE_FX, routeFeesFor(loadSharedVisaData(raw), "XA", "xa-visitor"));
      assert.equal(d.action, "omit");
    }
    // The same fee, stored for another route.
    const other = storedAfterFreshRun();
    (other.sourcedFee as any).sharedRouteId = "another-route";
    assert.equal(plan(other, STALE_FX).action, "omit");
    // A stored block with no usable figure beside it.
    const noCost = storedAfterFreshRun();
    delete noCost.baseCostUsd;
    assert.equal(plan(noCost, STALE_FX).action, "omit");
  });
});

describe("planSourcedFee: when no fee applies", () => {
  test("the official source is not on record: no fee, even with fresh rates and a stored fee", () => {
    const asked: string[] = [];
    const d = plan(storedAfterFreshRun(), FRESH_FX, ROUTE_FEES, (id) => { asked.push(id); return false; });
    assert.equal(d.action, "omit");
    if (d.action === "omit") assert.match(d.reason, /guidanceSources\/example-area-fee-source does not exist/);
    assert.deepEqual(asked, [FIXTURE_FEE.guidanceSourceId]);
  });

  test("a route with no fee, and a record the data file does not list: untouched", () => {
    const noFee = loadSharedVisaData(FIXTURE_DATA);
    assert.deepEqual(plan(storedAfterFreshRun(), FRESH_FX, routeFeesFor(noFee, "XA", "xa-visitor")), { action: "none" });
    // Not under `inheritedBy`: another visa of the member, another country, and a
    // record that inherits the route only through the admin API (stored inheritsFrom).
    assert.deepEqual(plan(undefined, FRESH_FX, routeFeesFor(DATA, "XA", "xa-work")), { action: "none" });
    assert.deepEqual(plan({ inheritsFrom: [{ sharedRouteId: "example-short-stay" }], baseCostUsd: 40 }, FRESH_FX, routeFeesFor(DATA, "XB", "xb-visitor")), { action: "none" });
  });

  test("a stored inheritsFrom that no longer names the route: not priced from it", () => {
    const d = plan({ inheritsFrom: [{ sharedRouteId: "another-route" }] }, FRESH_FX);
    assert.equal(d.action, "omit");
  });
});

describe("seedFeeProblems: a record cannot have two fee sources", () => {
  test("an entry with its own baseCostUsd that inherits a route with a fee is a problem", () => {
    const problems = seedFeeProblems([{ id: "xa-visitor", countryCode: "XA", baseCostUsd: 40 }, { id: "xa-work", countryCode: "XA", baseCostUsd: 99 }], DATA);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /XA\/xa-visitor/);
    assert.match(problems[0], /two fee sources/);
  });

  test("no problem without its own fee, or when the route has no fee", () => {
    assert.deepEqual(seedFeeProblems([{ id: "xa-visitor", countryCode: "XA" }], DATA), []);
    assert.deepEqual(seedFeeProblems([{ id: "xa-visitor", countryCode: "XA", baseCostUsd: 40 }], loadSharedVisaData(FIXTURE_DATA)), []);
  });

  test("a record that takes a fee from two routes is a problem too", () => {
    const raw: any = fixtureDataWithFee();
    raw.sharedRoutes.push({ ...JSON.parse(JSON.stringify(raw.sharedRoutes[0])), id: "example-second-route" });
    const problems = seedFeeProblems([{ id: "xa-visitor", countryCode: "XA" }], loadSharedVisaData(raw));
    assert.equal(problems.length, 1);
    assert.match(problems[0], /more than one shared route/);
  });
});

describe("effectiveSeedCost: what the country minimum counts", () => {
  test("the sourced figure when there is one, else the entry's own fee, else nothing", () => {
    const write = plan(undefined, FRESH_FX);
    assert.equal(effectiveSeedCost({ id: "xa-visitor", countryCode: "XA" }, write), expected(FRESH_FX).baseCostUsd);
    assert.equal(effectiveSeedCost({ id: "xa-visitor", countryCode: "XA" }, plan(storedAfterFreshRun(), STALE_FX)), expected(FRESH_FX).baseCostUsd);
    assert.equal(effectiveSeedCost({ id: "xa-visitor", countryCode: "XA" }, plan(undefined, undefined)), undefined);
    assert.equal(effectiveSeedCost({ id: "xa-work", countryCode: "XA", baseCostUsd: 99 }, { action: "none" }), 99);
    assert.equal(effectiveSeedCost({ id: "xa-work", countryCode: "XA", baseCostUsd: 99 }, undefined), 99);
  });
});
