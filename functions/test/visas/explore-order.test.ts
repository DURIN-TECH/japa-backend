/**
 * #258: `GET /visas` lists scraped visas first, before pagination.
 * Covers the pure ordering helper and getAllVisaTypes (per-country reads
 * stubbed on the service instance, so no Firestore is needed).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { sortVisasForExplore, visaService } from "../../src/services/visa.service";

// Minimal visa/country builders; only the fields the ordering reads.
const v = (id: string, countryCode: string, category: string, source?: string) =>
  ({ id, countryCode, category, source }) as any;
const countries = [
  { code: "US", popularityRank: 1 },
  { code: "CA", popularityRank: 2 },
  { code: "GB", popularityRank: 3 },
] as any[];

// Mixed fixture: scraped visas live in the LOW-ranked country (GB).
const fixture = () => [
  v("us-seed-work", "US", "work"),
  v("us-agent-study", "US", "study", "agent"),
  v("ca-agency-visit", "CA", "visit", "agency"),
  v("gb-scraped-work", "GB", "work", "scraped"),
  v("gb-scraped-visit", "GB", "visit", "scraped"),
  v("us-scraped-visit", "US", "visit", "scraped"),
];

describe("sortVisasForExplore", () => {
  it("puts scraped first across countries, keeping rank then category inside each group", () => {
    const ids = sortVisasForExplore(fixture(), countries).map((x) => x.id);
    assert.deepEqual(ids, [
      // scraped group: US(1) before GB(3); GB by category visit < work
      "us-scraped-visit",
      "gb-scraped-visit",
      "gb-scraped-work",
      // everything else: seed, agent, agency in the old order
      "us-agent-study",
      "us-seed-work",
      "ca-agency-visit",
    ]);
  });

  it("is a no-op for the old order when nothing is scraped", () => {
    const rows = fixture().filter((x) => x.source !== "scraped");
    const ids = sortVisasForExplore(rows, countries).map((x) => x.id);
    assert.deepEqual(ids, ["us-agent-study", "us-seed-work", "ca-agency-visit"]);
  });

  it("treats a country with no rank as last (999)", () => {
    const rows = [v("zz", "ZZ", "work"), v("ca", "CA", "work")];
    assert.deepEqual(sortVisasForExplore(rows, countries).map((x) => x.id), ["ca", "zz"]);
  });
});

describe("visaService.getAllVisaTypes ordering + paging (#258)", () => {
  // Stub the three reads getAllVisaTypes uses; restore afterwards.
  const svc = visaService as any;
  const orig = {
    getCountries: svc.getCountries,
    getVisaTypesByCountry: svc.getVisaTypesByCountry,
    getVisaTypesByCategory: svc.getVisaTypesByCategory,
  };
  const stub = () => {
    svc.getCountries = async () => countries;
    svc.getVisaTypesByCountry = async (code: string) =>
      fixture().filter((x) => x.countryCode === code);
    svc.getVisaTypesByCategory = async (code: string, cat: string) =>
      fixture().filter((x) => x.countryCode === code && x.category === cat);
  };
  const restore = () => Object.assign(svc, orig);

  it("orders before the slice: page 1 holds scraped visas from the low-ranked country", async () => {
    stub();
    try {
      const p1 = await visaService.getAllVisaTypes({ limit: 3, offset: 0 });
      assert.deepEqual(p1.visaTypes.map((x) => x.id), [
        "us-scraped-visit",
        "gb-scraped-visit",
        "gb-scraped-work",
      ]);
      assert.equal(p1.total, 6); // total unchanged by ordering
    } finally {
      restore();
    }
  });

  it("pages are consistent: no duplicates or gaps", async () => {
    stub();
    try {
      const p1 = await visaService.getAllVisaTypes({ limit: 4, offset: 0 });
      const p2 = await visaService.getAllVisaTypes({ limit: 4, offset: 4 });
      const all = await visaService.getAllVisaTypes({ limit: 100 });
      assert.deepEqual(
        [...p1.visaTypes, ...p2.visaTypes].map((x) => x.id),
        all.visaTypes.map((x) => x.id)
      );
    } finally {
      restore();
    }
  });

  it("applies the same ordering inside a category", async () => {
    stub();
    try {
      const r = await visaService.getAllVisaTypes({ category: "visit" as any, limit: 10 });
      assert.deepEqual(r.visaTypes.map((x) => x.id), [
        "us-scraped-visit",
        "gb-scraped-visit",
        "ca-agency-visit",
      ]);
      assert.equal(r.total, 3);
    } finally {
      restore();
    }
  });
});
