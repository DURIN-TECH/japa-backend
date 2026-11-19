// ============================================
// Unit tests: CBN parser (recorded fixture), CBN and OANDA providers (issue #178)
// ============================================
//
// The fixture test/money/fixtures/cbn-nfem-rates.json is the first six rows of
// the real response of https://www.cbn.gov.ng/api/GetAllNFEM_Rates recorded on
// 2026-11-13. No network here: providers get a fake axios-like client.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AxiosInstance } from "axios";
import {
  CbnRateProvider,
  CBN_NFEM_URL,
  CBN_ROBOTS_URL,
  isPathDisallowed,
  parseCbnDate,
  parseCbnNfemRates,
} from "../../src/money/providers/cbn.provider";
import { OandaRateProvider, parseOandaSpot } from "../../src/money/providers/oanda.provider";

const fixture = JSON.parse(readFileSync(join(__dirname, "fixtures", "cbn-nfem-rates.json"), "utf8"));

/** Fake client: routes by URL, records calls and headers. */
function fakeHttp(routes: Record<string, { status: number; data: unknown } | Error>) {
  const calls: { url: string; headers?: unknown; params?: unknown }[] = [];
  const http = {
    get: async (url: string, cfg?: { headers?: unknown; params?: unknown }) => {
      calls.push({ url, headers: cfg?.headers, params: cfg?.params });
      const r = routes[url.split("?")[0]];
      if (!r) throw new Error(`unexpected url ${url}`);
      if (r instanceof Error) throw r;
      return r;
    },
  } as unknown as AxiosInstance;
  return { http, calls };
}

const ROBOTS_OK = "User-agent: *\nAllow: /\nDisallow: /footer.html\nDisallow: /museum/\nDisallow: /*.asp$\nDisallow: /appsettings.json\n";

describe("CBN parser", () => {
  test("parses the latest day's weighted-average (NFEM) rate from the fixture", () => {
    const r = parseCbnNfemRates(fixture);
    assert.ok(r);
    assert.equal(r.rate, 1353.9741);
    // Lagos midnight of 13 November 2026 = 12 November 23:00 UTC
    assert.equal(r.asOf.toISOString(), "2026-11-12T23:00:00.000Z");
  });
  test("does not depend on row order", () => {
    assert.equal(parseCbnNfemRates([...fixture].reverse())?.rate, 1353.9741);
  });
  test("skips rows with blank, junk or implausible rates and bad dates", () => {
    const rows = [
      { ratedate: "November-13-2026", weightedAvgRate: "" },
      { ratedate: "November-12-2026", weightedAvgRate: "abc" },
      { ratedate: "November-11-2026", weightedAvgRate: "3" }, // below sanity floor
      { ratedate: "not-a-date", weightedAvgRate: "1500" },
      { ratedate: "February-31-2026", weightedAvgRate: "1500" },
      { ratedate: "November-10-2026", weightedAvgRate: "1,364.0000" },
    ];
    const r = parseCbnNfemRates(rows);
    assert.equal(r?.rate, 1364);
  });
  test("returns null for anything that is not a usable array", () => {
    for (const bad of [null, {}, "x", [], [{}], [{ ratedate: "November-13-2026" }]]) {
      assert.equal(parseCbnNfemRates(bad), null);
    }
  });
  test("parseCbnDate", () => {
    assert.equal(parseCbnDate("December-02-2024")?.toISOString(), "2024-12-01T23:00:00.000Z");
    assert.equal(parseCbnDate("Smarch-02-2024"), null);
    assert.equal(parseCbnDate(5), null);
  });
});

describe("robots matching", () => {
  test("the real CBN rules do not block /api/GetAllNFEM_Rates but do block its listed paths", () => {
    const rules = ["/footer.html", "/header.html", "/museum/", "/*.asp$", "/appsettings.json"];
    assert.equal(isPathDisallowed(rules, "/api/GetAllNFEM_Rates"), false);
    assert.equal(isPathDisallowed(rules, "/museum/x"), true);
    assert.equal(isPathDisallowed(rules, "/rates/page.asp"), true);
    assert.equal(isPathDisallowed(rules, "/rates/page.aspx"), false);
    assert.equal(isPathDisallowed([""], "/anything"), false);
    assert.equal(isPathDisallowed(["/api/"], "/api/GetAllNFEM_Rates"), true);
  });
});

describe("CbnRateProvider", () => {
  test("reads robots.txt then the endpoint and returns the rate; supports only NGN", async () => {
    const { http, calls } = fakeHttp({
      [CBN_ROBOTS_URL]: { status: 200, data: ROBOTS_OK },
      [CBN_NFEM_URL]: { status: 200, data: fixture },
    });
    const p = new CbnRateProvider(http);
    assert.equal(p.isConfigured(), true);
    assert.equal(p.supports("NGN"), true);
    assert.equal(p.supports("GHS"), false);
    const r = await p.fetchRate("NGN");
    assert.deepEqual(r.ok && r.rate, 1353.9741);
    assert.deepEqual(calls.map((c) => c.url), [CBN_ROBOTS_URL, CBN_NFEM_URL]); // robots first
    assert.deepEqual(await p.fetchRate("GHS"), { ok: false, reason: "CBN does not publish GHS" });
  });
  test("robots disallow -> unavailable and the data endpoint is NOT requested", async () => {
    const { http, calls } = fakeHttp({
      [CBN_ROBOTS_URL]: { status: 200, data: "User-agent: *\nDisallow: /api/\n" },
      [CBN_NFEM_URL]: { status: 200, data: fixture },
    });
    const r = await new CbnRateProvider(http).fetchRate("NGN");
    assert.equal(r.ok, false);
    assert.equal(calls.length, 1);
  });
  test("robots 5xx -> unavailable; robots 404 -> no rules, proceeds", async () => {
    const down = fakeHttp({ [CBN_ROBOTS_URL]: { status: 503, data: "" }, [CBN_NFEM_URL]: { status: 200, data: fixture } });
    assert.equal((await new CbnRateProvider(down.http).fetchRate("NGN")).ok, false);
    const none = fakeHttp({ [CBN_ROBOTS_URL]: { status: 404, data: "" }, [CBN_NFEM_URL]: { status: 200, data: fixture } });
    assert.equal((await new CbnRateProvider(none.http).fetchRate("NGN")).ok, true);
  });
  test("robots 403 or 429 -> unavailable and the data endpoint is NOT requested", async () => {
    for (const status of [403, 429]) {
      const { http, calls } = fakeHttp({ [CBN_ROBOTS_URL]: { status, data: "" }, [CBN_NFEM_URL]: { status: 200, data: fixture } });
      const r = await new CbnRateProvider(http).fetchRate("NGN");
      assert.equal(r.ok, false, String(status));
      assert.equal(calls.length, 1);
    }
  });
  test("a future-dated row is ignored, never 'the latest'", () => {
    const now = new Date("2026-11-13T09:00:00Z");
    const rows = [
      { ratedate: "December-30-2026", weightedAvgRate: "135.3974" },
      { ratedate: "November-13-2026", weightedAvgRate: "1353.9741" },
    ];
    assert.equal(parseCbnNfemRates(rows, now)?.rate, 1353.9741);
    assert.equal(parseCbnNfemRates([rows[0]], now), null);
  });
  test("a block (403/429), bad JSON or a network error is 'unavailable', never a throw or a guess", async () => {
    for (const data of [{ status: 403, data: "" }, { status: 429, data: "" }, { status: 200, data: { oops: true } }]) {
      const { http } = fakeHttp({ [CBN_ROBOTS_URL]: { status: 200, data: ROBOTS_OK }, [CBN_NFEM_URL]: data });
      assert.equal((await new CbnRateProvider(http).fetchRate("NGN")).ok, false);
    }
    const boom = fakeHttp({ [CBN_ROBOTS_URL]: new Error("ECONNRESET") });
    const r = await new CbnRateProvider(boom.http).fetchRate("NGN");
    assert.equal(r.ok, false);
  });
});

describe("OandaRateProvider", () => {
  test("is inactive without a key and makes no request", async () => {
    const { http, calls } = fakeHttp({});
    const p = new OandaRateProvider(http, () => undefined);
    assert.equal(p.isConfigured(), false);
    assert.equal((await p.fetchRate("NGN")).ok, false);
    assert.equal(calls.length, 0);
    assert.equal(new OandaRateProvider(http, () => "   ").isConfigured(), false);
  });
  test("with a key it sends it as a Bearer header only, and parses the midpoint", async () => {
    const { http, calls } = fakeHttp({
      "https://exchange-rates-api.oanda.com/v2/rates/spot.json": {
        status: 200,
        data: { quotes: [{ base_currency: "USD", quote_currency: "NGN", midpoint: "1500.25", end_time: "2026-11-13T09:00:00+00:00" }] },
      },
    });
    const p = new OandaRateProvider(http, () => "test-key-not-real");
    assert.equal(p.isConfigured(), true);
    const r = await p.fetchRate("NGN");
    assert.deepEqual(r.ok && r.rate, 1500.25);
    assert.deepEqual(calls[0].headers, { Authorization: "Bearer test-key-not-real" });
    assert.deepEqual(calls[0].params, { base: "USD", quote: "NGN" });
  });
  test("an error message never contains the key", async () => {
    const { http } = fakeHttp({ "https://exchange-rates-api.oanda.com/v2/rates/spot.json": new Error("boom") });
    const r = await new OandaRateProvider(http, () => "SECRET-VALUE").fetchRate("NGN");
    assert.equal(r.ok, false);
    assert.ok(!JSON.stringify(r).includes("SECRET-VALUE"));
  });
  test("parseOandaSpot rejects shapes it does not understand", () => {
    for (const bad of [null, {}, { quotes: [] }, { quotes: [{ midpoint: "x" }] }]) assert.equal(parseOandaSpot(bad, "NGN"), null);
  });
  test("parseOandaSpot checks the returned pair and requires a real timestamp", () => {
    const q = { base_currency: "USD", quote_currency: "NGN", midpoint: "1500", end_time: "2026-11-13T09:00:00+00:00" };
    assert.equal(parseOandaSpot({ quotes: [q] }, "NGN")?.rate, 1500);
    assert.equal(parseOandaSpot({ quotes: [q] }, "GHS"), null); // wrong pair
    assert.equal(parseOandaSpot({ quotes: [{ ...q, base_currency: "EUR" }] }, "NGN"), null);
    assert.equal(parseOandaSpot({ quotes: [{ ...q, end_time: undefined }] }, "NGN"), null); // no now() fallback
    assert.equal(parseOandaSpot({ quotes: [{ ...q, end_time: "garbage" }] }, "NGN"), null);
  });
});
