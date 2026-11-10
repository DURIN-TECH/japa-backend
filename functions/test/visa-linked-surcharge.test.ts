// ============================================
// Unit tests — surcharges published on a linked page (issue #69)
// ============================================
//
// Run with `npm test`. Pure: no network, no Firebase. The linked page is the
// REAL recorded GOV.UK IHS guide (eval/golden/_linked/…), served to the real
// GovukContentApiAdapter through the eval's stub fetch service.
//
// Covers:
//  - parseLinkedSurchargeRates: real page -> standard £1,035 + student £776
//    with verbatim citations; a missing rate / withdrawn page throws
//  - LinkedSurchargeCache: one fetch per id per run (failures cached too);
//    an unmarked page needs no fetch
//  - linkedGateHash: identity for unmarked pages; changes with the linked page
//  - applyLinkedSurcharges: assumed / extracted length, no double count when
//    the page states a surcharge, no fee -> not added, months / no length ->
//    unverified, a dropped IHS reason is superseded
//  - wholeYearsFromValidity
//  - computeFee / planFeeReconvert keep the provenance
//  - registry: only Student + Child Student are marked; pins copy the markers

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import * as path from "path";
import { Timestamp } from "firebase-admin/firestore";

import { fixtureFetchService, loadGuide } from "../eval/golden";
import { GovukContentApiAdapter } from "../src/services/visa-source-adapters";
import {
  GB_IHS_ID,
  LINKED_SURCHARGE_SOURCES,
  LinkedSurchargeCache,
  LinkedSurchargeError,
  applyLinkedSurcharges,
  linkedGateHash,
  linkedSurchargePage,
  parseLinkedSurchargeRates,
  wholeYearsFromValidity,
  type PageLinkedSurcharge,
} from "../src/services/visa-catalog-linked-surcharge";
import { computeFee, planFeeReconvert } from "../src/services/visa-catalog-fx";
import { applyVisaSourcePins } from "../src/services/visa-catalog-ids";
import { VISA_SOURCE_OVERRIDES } from "../src/data/seed-visa-sources";
import type { ExtractedFeeComponent, LinkedSurchargeRef } from "../src/types/visa-catalog";
import type { SourceDocument } from "../src/services/visa-source-adapters";

// ----- Fixtures -----

const IHS = LINKED_SURCHARGE_SOURCES[GB_IHS_ID];
const LINKED_DIR = path.join(__dirname, "..", "eval", "golden", "_linked");

/** The real IHS page as the crawl would fetch it (selected "how-much-pay" part). */
async function ihsDoc(): Promise<SourceDocument> {
  const guide = loadGuide("healthcare-immigration-application", LINKED_DIR);
  return new GovukContentApiAdapter(fixtureFetchService(IHS.url, guide)).fetch(linkedSurchargePage(IHS));
}

/** A doc with replaced text (for wording-change tests). */
const withText = (d: SourceDocument, text: string): SourceDocument => ({ ...d, text });

const APP: ExtractedFeeComponent = { kind: "application", label: "Application fee", amount: 558, currency: "GBP", per: "application" };
const ASSUMED: LinkedSurchargeRef = { id: GB_IHS_ID, rate: "student", length: { mode: "assumed", years: 1, note: "1 year assumed: test" } };
const EXTRACTED: LinkedSurchargeRef = { id: GB_IHS_ID, rate: "standard", length: { mode: "extracted" } };

/** Resolved linked IHS paired with a marker. */
async function linkedWith(ref: LinkedSurchargeRef): Promise<PageLinkedSurcharge[]> {
  return [{ ref, resolved: parseLinkedSurchargeRates(IHS, await ihsDoc()) }];
}

// ----- Parsing the real page -----

describe("parseLinkedSurchargeRates (real GOV.UK IHS page)", () => {
  test("reads standard £1,035 and student £776 with the verbatim lines as citations", async () => {
    const r = parseLinkedSurchargeRates(IHS, await ihsDoc());
    assert.deepEqual(r.rates.standard, {
      amount: 1035,
      currency: "GBP",
      citation: "£1,035 per year for all other visa and immigration applications, for example £3,105 for a 3-year visa",
    });
    assert.deepEqual(r.rates.student, {
      amount: 776,
      currency: "GBP",
      citation:
        "£776 per year for students, their dependants, and those on a Youth Mobility Scheme visa, for example £1,552 for a 2-year visa",
    });
    assert.equal(r.sourceUrl, "https://www.gov.uk/healthcare-immigration-application");
    assert.ok(r.sourceUpdatedAt);
    assert.match(r.contentHash, /^[0-9a-f]{64}$/);
  });

  test("a rate that is no longer on the page throws (never a remembered amount)", async () => {
    const d = await ihsDoc();
    const broken = withText(d, d.text.replace("per year for all other", "a year for any other"));
    assert.throws(() => parseLinkedSurchargeRates(IHS, broken), (e: Error) => e instanceof LinkedSurchargeError && /"standard" rate/.test(e.message));
  });

  test("a withdrawn linked page throws", async () => {
    const d = await ihsDoc();
    assert.throws(() => parseLinkedSurchargeRates(IHS, { ...d, withdrawn: true }), /withdrawn/);
  });
});

// ----- Once-per-run cache -----

describe("LinkedSurchargeCache", () => {
  test("fetches each linked page once per run, however many routes use it", async () => {
    const doc = await ihsDoc();
    let fetches = 0;
    const cache = new LinkedSurchargeCache(async () => {
      fetches++;
      return doc;
    });
    const page = { linkedSurcharges: [ASSUMED] };
    const [a, b] = await Promise.all([cache.forPage(page), cache.forPage(page)]);
    await cache.forPage(page);
    assert.equal(fetches, 1);
    assert.equal(a[0].resolved.rates.student.amount, 776);
    assert.equal(b[0].resolved, a[0].resolved);
  });

  test("a failure is cached for the run too (no second request), and rethrown", async () => {
    let fetches = 0;
    const cache = new LinkedSurchargeCache(async () => {
      fetches++;
      throw new Error("HTTP 429");
    });
    await assert.rejects(cache.forPage({ linkedSurcharges: [ASSUMED] }), /429/);
    await assert.rejects(cache.forPage({ linkedSurcharges: [ASSUMED] }), /429/);
    assert.equal(fetches, 1);
  });

  test("an unmarked page needs no fetch; an unknown id rejects", async () => {
    const cache = new LinkedSurchargeCache(async () => {
      throw new Error("must not fetch");
    });
    assert.deepEqual(await cache.forPage({}), []);
    await assert.rejects(
      cache.forPage({ linkedSurcharges: [{ ...ASSUMED, id: "nope" }] }),
      /unknown linked surcharge "nope"/
    );
  });
});

// ----- Hash gate -----

describe("linkedGateHash", () => {
  test("is the page hash itself for an unmarked page (no change for other routes)", () => {
    assert.equal(linkedGateHash("abc", []), "abc");
  });

  test("changes when the linked page or the marker changes", async () => {
    const linked = await linkedWith(ASSUMED);
    const h = linkedGateHash("abc", linked);
    assert.notEqual(h, "abc");
    assert.equal(linkedGateHash("abc", linked), h); // deterministic
    const otherPage = [{ ...linked[0], resolved: { ...linked[0].resolved, contentHash: "x" } }];
    assert.notEqual(linkedGateHash("abc", otherPage), h);
    const otherRef = [{ ...linked[0], ref: { ...ASSUMED, rate: "standard" } }];
    assert.notEqual(linkedGateHash("abc", otherRef), h);
  });
});

// ----- Applying to an extraction -----

describe("applyLinkedSurcharges", () => {
  test("assumed length (Student): adds the student rate x 1 year, with provenance", async () => {
    const r = applyLinkedSurcharges({ feeComponents: [APP], validityPeriod: "up to 5 years" }, await linkedWith(ASSUMED));
    assert.deepEqual(r.feeComponents[1], {
      kind: "surcharge", label: "Immigration Health Surcharge", amount: 776, currency: "GBP", per: "year", years: 1,
    });
    assert.deepEqual(r.unverifiedReasons, []);
    assert.equal(r.meta[0].applied, true);
    assert.equal(r.meta[0].years, 1);
    assert.equal(r.meta[0].lengthBasis, "assumed");
    assert.equal(r.meta[0].lengthNote, "1 year assumed: test");
    assert.match(r.meta[0].citation ?? "", /^£776 per year for students/);
  });

  test("extracted length: whole years from validityPeriod", async () => {
    const r = applyLinkedSurcharges({ feeComponents: [APP], validityPeriod: "up to 3 years" }, await linkedWith(EXTRACTED));
    assert.equal(r.feeComponents[1].amount, 1035);
    assert.equal(r.feeComponents[1].years, 3);
    assert.equal(r.meta[0].lengthBasis, "extracted");
    assert.equal(r.meta[0].lengthNote, undefined);
  });

  test("extracted length with months (or none): NOT added, fee unverified", async () => {
    for (const v of ["2 years and 9 months", "the length of your course"]) {
      const r = applyLinkedSurcharges({ feeComponents: [APP], validityPeriod: v }, await linkedWith(EXTRACTED));
      assert.equal(r.feeComponents.length, 1, v);
      assert.match(r.unverifiedReasons[0], /not added: no whole-year visa length/);
      assert.equal(r.meta[0].applied, false);
    }
  });

  test("no double count (#73): a page that already states a surcharge gets nothing added", async () => {
    const own: ExtractedFeeComponent = { kind: "surcharge", label: "Healthcare surcharge", amount: 1035, currency: "GBP", per: "year", years: 5 };
    const r = applyLinkedSurcharges({ feeComponents: [APP, own], validityPeriod: "up to 5 years" }, await linkedWith(ASSUMED));
    assert.deepEqual(r.feeComponents, [APP, own]);
    assert.equal(r.meta[0].applied, false);
    assert.match(r.meta[0].skippedReason ?? "", /already states a surcharge/);
  });

  test("a page with no fee at all ([]) stays [] (IHS alone would hide the missing application fee)", async () => {
    const r = applyLinkedSurcharges({ feeComponents: [], validityPeriod: "1 year" }, await linkedWith(ASSUMED));
    assert.deepEqual(r.feeComponents, []);
    assert.match(r.meta[0].skippedReason ?? "", /states no fee/);
  });

  test("a validator-dropped IHS line is superseded by the linked rate; other reasons stay", async () => {
    const r = applyLinkedSurcharges(
      {
        feeComponents: [APP],
        validityPeriod: "up to 5 years",
        feeUnverifiedReasons: ['dropped surcharge "Healthcare surcharge": years', 'dropped surcharge "Other levy": years'],
      },
      await linkedWith(ASSUMED)
    );
    assert.deepEqual(r.unverifiedReasons, ['dropped surcharge "Other levy": years']);
  });

  test("an unknown rate key is unverified, not guessed", async () => {
    const r = applyLinkedSurcharges({ feeComponents: [APP], validityPeriod: "1 year" }, await linkedWith({ ...ASSUMED, rate: "nope" }));
    assert.equal(r.feeComponents.length, 1);
    assert.match(r.unverifiedReasons[0], /unknown rate "nope"/);
  });

  test("no markers: the extraction is passed through unchanged", () => {
    const r = applyLinkedSurcharges({ feeComponents: [APP], validityPeriod: "x", feeUnverifiedReasons: ["r"] }, []);
    assert.deepEqual(r, { feeComponents: [APP], unverifiedReasons: ["r"], meta: [] });
  });
});

describe("wholeYearsFromValidity", () => {
  test("longest whole-year duration; months or nothing -> undefined", () => {
    assert.equal(wholeYearsFromValidity("up to 5 years"), 5);
    assert.equal(wholeYearsFromValidity("2 years, or 3 years for PhD graduates"), 3);
    assert.equal(wholeYearsFromValidity("five years"), 5);
    assert.equal(wholeYearsFromValidity("2 years and 9 months"), undefined);
    assert.equal(wholeYearsFromValidity("6 months"), undefined);
    assert.equal(wholeYearsFromValidity(undefined), undefined);
  });
});

// ----- Fee block -----

describe("fee block provenance", () => {
  test("computeFee totals the added component like any surcharge; planFeeReconvert keeps linkedSurcharges", async () => {
    const applied = applyLinkedSurcharges({ feeComponents: [APP], validityPeriod: "x" }, await linkedWith(ASSUMED));
    const now = Timestamp.now();
    const stale = computeFee(applied.feeComponents, undefined, now, { linkedSurcharges: applied.meta });
    assert.deepEqual(stale.feeMeta.totals, [{ currency: "GBP", amount: 1334 }]);
    assert.equal(stale.feeMeta.fxMissing, true);
    assert.equal(stale.feeMeta.linkedSurcharges?.[0].id, GB_IHS_ID);

    const plan = planFeeReconvert(
      { source: "scraped", reviewStatus: "pending_review", scrapeMeta: { fee: stale.feeMeta } as never },
      { base: "USD", rates: { GBP: 0.8 }, fetchedAt: now, rateDate: now.toDate().toISOString().slice(0, 10), source: "ecb" },
      now
    );
    assert.equal(plan?.baseCostUsd, Math.round(1334 / 0.8));
    assert.deepEqual(plan?.fee.linkedSurcharges, stale.feeMeta.linkedSurcharges);
  });

  test("no linked surcharges -> no linkedSurcharges key", () => {
    assert.equal("linkedSurcharges" in computeFee([APP], undefined, Timestamp.now()).feeMeta, false);
  });
});

// ----- Registry -----

describe("registry markers", () => {
  test("only Student and Child Student are marked (pages that print their own IHS are not: #73)", () => {
    const marked = Object.entries(VISA_SOURCE_OVERRIDES).filter(([, p]) => p.linkedSurcharges?.length).map(([u]) => u).sort();
    assert.deepEqual(marked, ["https://www.gov.uk/child-study-visa", "https://www.gov.uk/student-visa"]);
    for (const u of marked) {
      const [ref] = VISA_SOURCE_OVERRIDES[u].linkedSurcharges ?? [];
      assert.equal(ref.id, GB_IHS_ID);
      assert.equal(ref.rate, "student");
      assert.deepEqual({ mode: ref.length.mode, years: ref.length.mode === "assumed" ? ref.length.years : 0 }, { mode: "assumed", years: 1 });
      assert.ok(IHS.rates[ref.rate]);
    }
  });

  test("applyVisaSourcePins copies the markers onto the page (fresh objects)", () => {
    const { pages } = applyVisaSourcePins(
      [{ url: "https://www.gov.uk/student-visa", routeName: "Student visa", validation: "text_verified" }],
      VISA_SOURCE_OVERRIDES
    );
    assert.deepEqual(pages[0].linkedSurcharges, VISA_SOURCE_OVERRIDES["https://www.gov.uk/student-visa"].linkedSurcharges);
    assert.notEqual(pages[0].linkedSurcharges?.[0], VISA_SOURCE_OVERRIDES["https://www.gov.uk/student-visa"].linkedSurcharges?.[0]);
  });
});
