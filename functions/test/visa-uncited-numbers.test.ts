// ============================================
// Unit tests — uncited numeric fields + supplementary pages (issue #86)
// ============================================
//
// Run with `npm test` (node:test via tsx). No Firestore / emulator needed: the
// modules under test are importable without Firebase Admin init.
//
// Covers issue #86's acceptance criteria:
//  - AC1: numeric fields with no citation are left out / flagged, never
//    written as 0 (processing days, maxExtensions, a 0 fee) — all countries;
//  - AC2: the KR source pins the Korea Visa Portal fee table as a
//    supplement-only row and attaches it to the C-3 route;
//  - the supplementary-page mechanics (text, hash gate, fail-closed checks).

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { FieldValue, Timestamp } from "firebase-admin/firestore";

import {
  PROCESSING_TIME_UNKNOWN_LABEL,
  hasCitationWithPrefix,
  validateExtractedVisa,
} from "../src/services/visa-catalog-extract.service";
import {
  REFRESH_DELETABLE_FIELDS,
  absentFieldDeletes,
  buildScrapeMeta,
  extractedToVisaFields,
  finiteMin,
} from "../src/services/visa-catalog-meta";
import { computeFee } from "../src/services/visa-catalog-fx";
import {
  SupplementaryPageCache,
  SupplementaryPageError,
  combineSupplementaryText,
  supplementaryGateHash,
  supplementaryHeader,
  supplementaryPagesMeta,
} from "../src/services/visa-catalog-supplementary";
import { applyVisaSourcePins } from "../src/services/visa-catalog-ids";
import {
  KR_TEMPORARY_VISIT_URL,
  KR_VISA_FEE_TABLE_URL,
  VISA_SOURCE_OVERRIDES,
  parseVisaSourcesMarkdown,
} from "../src/data/seed-visa-sources";
import type { SourceDocument } from "../src/services/visa-source-adapters/types";
import type { VisaSourcePage } from "../src/types/visa-catalog";

// ----- Fixtures -----

/**
 * A raw LLM payload shaped like the live KR C-3 extraction that #86 reported:
 * processing days 0/0 with NO processing citation, no fee, and a model
 * processing string it could not quote. `over` replaces / adds keys.
 */
function thinKrPayload(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "Temporary visit (C-3)",
    code: "C-3",
    description: "Short-term stay for travel or transit.",
    category: "tourist",
    processingTime: "Not specified",
    processingDaysMin: 0,
    processingDaysMax: 0,
    validityPeriod: "less than 90 days",
    isExtendable: true,
    eligibilityCriteria: ["Short term stay for travel/transit"],
    confidence: 0.4,
    feeComponents: [],
    citations: { name: "Temporary visit (C-3)" },
    ...over,
  };
}

/** A minimal SourceDocument for supplementary-page tests. */
function doc(url: string, text: string, extra: Partial<SourceDocument> = {}): SourceDocument {
  return {
    url,
    canonicalUrl: url,
    sourceProvider: "generic-html",
    withdrawn: false,
    sections: [],
    text,
    contentHash: `hash-of-${text.length}`,
    ...extra,
  };
}

/** The two KR registry rows as the seed stores them (markdown + pins). */
const krRoute: VisaSourcePage = {
  url: KR_TEMPORARY_VISIT_URL,
  routeName: "Temporary Visit (C-3)",
  validation: "text_verified",
  supplementaryPages: [KR_VISA_FEE_TABLE_URL],
};
const krFeeTable: VisaSourcePage = {
  url: KR_VISA_FEE_TABLE_URL,
  routeName: "Visa application fees",
  validation: "text_verified",
  supplementOnly: true,
};

// ----- AC1: processing days -----

describe("validateExtractedVisa — uncited processing days (issue #86)", () => {
  // The exact #86 failure: 0/0 with no quote must not survive as "0 days".
  test("drops uncited 0/0 processing days, flags processingUnknown and records them", () => {
    const v = validateExtractedVisa(thinKrPayload());
    assert.equal("processingDaysMin" in v, false);
    assert.equal("processingDaysMax" in v, false);
    assert.equal(v.processingUnknown, true);
    assert.deepEqual(v.uncitedFieldsDropped, ["processingDaysMin", "processingDaysMax"]);
    // The uncited model string is replaced by the display label.
    assert.equal(v.processingTime, PROCESSING_TIME_UNKNOWN_LABEL);
  });

  // General rule (all countries): a NON-zero value without a quote goes too.
  test("drops uncited non-zero processing days as well", () => {
    const v = validateExtractedVisa(thinKrPayload({ processingDaysMin: 14, processingDaysMax: 21 }));
    assert.equal(v.processingUnknown, true);
    assert.equal(v.processingDaysMin, undefined);
    assert.deepEqual(v.uncitedFieldsDropped, ["processingDaysMin", "processingDaysMax"]);
  });

  // Each citation key the model is known to use counts (prefix match).
  for (const key of ["processingTime", "processingTime.inside", "processingDaysMin", "processingDaysMax"]) {
    test(`keeps cited processing days (citation key "${key}")`, () => {
      const v = validateExtractedVisa(
        thinKrPayload({
          processingTime: "3-8 weeks",
          processingDaysMin: 21,
          processingDaysMax: 56,
          citations: { [key]: "We'll usually tell you within 3 weeks" },
        })
      );
      assert.equal(v.processingDaysMin, 21);
      assert.equal(v.processingDaysMax, 56);
      assert.equal("processingUnknown" in v, false);
      assert.equal("uncitedFieldsDropped" in v, false);
      assert.equal(v.processingTime, "3-8 weeks");
    });
  }

  // A 0-day upper bound is the prompt's zero default even with some quote.
  test("treats a cited 0-day maximum as unknown but keeps the cited string", () => {
    const v = validateExtractedVisa(
      thinKrPayload({
        processingTime: "Varies by embassy",
        citations: { processingTime: "processing time varies by embassy" },
      })
    );
    assert.equal(v.processingUnknown, true);
    assert.equal(v.processingDaysMin, undefined);
    // Cited string kept as the page says it (no display label).
    assert.equal(v.processingTime, "Varies by embassy");
  });

  // null / absent values are "not stated", no longer a hard error.
  test("accepts null / missing processing days as unknown (no validation error)", () => {
    const v = validateExtractedVisa(thinKrPayload({ processingDaysMin: null, processingDaysMax: undefined }));
    assert.equal(v.processingUnknown, true);
    // Nothing was returned, so nothing is listed as dropped.
    assert.equal("uncitedFieldsDropped" in v, false);
  });

  // Only one of the pair: both are omitted (never half a range).
  test("omits both when only one value is given", () => {
    const v = validateExtractedVisa(
      thinKrPayload({ processingDaysMax: undefined, processingDaysMin: 10, citations: { processingTime: "10 days" } })
    );
    assert.equal(v.processingUnknown, true);
    assert.equal(v.processingDaysMin, undefined);
    assert.deepEqual(v.uncitedFieldsDropped, ["processingDaysMin"]);
  });

  // Garbage is still a hard error (not silently "unknown").
  test("still rejects a non-numeric processing value", () => {
    assert.throws(() => validateExtractedVisa(thinKrPayload({ processingDaysMin: "three weeks" })), /must be a number/);
  });

  // Range checks still apply to kept values.
  test("still rejects min > max when both are cited", () => {
    assert.throws(
      () =>
        validateExtractedVisa(
          thinKrPayload({ processingDaysMin: 30, processingDaysMax: 10, citations: { processingTime: "x" } })
        ),
      /processingDaysMin must be <= processingDaysMax/
    );
  });
});

// ----- AC1: maxExtensions -----

describe("validateExtractedVisa — uncited maxExtensions (issue #86)", () => {
  test("drops an uncited maxExtensions (including 0)", () => {
    for (const n of [0, 2]) {
      const v = validateExtractedVisa(thinKrPayload({ maxExtensions: n }));
      assert.equal("maxExtensions" in v, false);
      assert.ok(v.uncitedFieldsDropped?.includes("maxExtensions"));
    }
  });

  test("keeps a cited maxExtensions", () => {
    const v = validateExtractedVisa(
      thinKrPayload({ maxExtensions: 1, citations: { maxExtensions: "You can extend once" } })
    );
    assert.equal(v.maxExtensions, 1);
  });
});

// ----- AC1: a 0 fee needs a citation -----

describe("validateExtractedVisa — uncited zero fee (issue #86)", () => {
  // An uncited 0 must not become baseCostUsd 0 ("free").
  test("drops an uncited 0 application fee and marks the fee unverified (no baseCostUsd)", () => {
    const v = validateExtractedVisa(
      thinKrPayload({
        feeComponents: [{ kind: "application", label: "Visa fee", amount: 0, currency: "USD", per: "application" }],
      })
    );
    assert.deepEqual(v.feeComponents, []);
    assert.equal(v.feeUnverifiedReasons?.length, 1);
    assert.match(v.feeUnverifiedReasons![0], /dropped uncited zero application "Visa fee"/);
    // The fee path then writes no cost at all (blocked for approval).
    const { baseCostUsd, feeMeta } = computeFee(v.feeComponents, undefined, Timestamp.now(), {
      unverifiedReasons: v.feeUnverifiedReasons,
    });
    assert.equal(baseCostUsd, undefined);
    assert.equal(feeMeta.noPublishedFee, true);
    assert.equal(feeMeta.feeUnverified, true);
  });

  test("an uncited 0 surcharge next to a cited fee also blocks the cost", () => {
    const v = validateExtractedVisa(
      thinKrPayload({
        feeComponents: [
          { kind: "application", label: "Visa fee", amount: 40, currency: "USD", per: "application" },
          { kind: "surcharge", label: "Levy", amount: 0, currency: "USD", per: "application" },
        ],
        citations: { "fee.application": "90 days or less Single-entry visa USD 40" },
      })
    );
    assert.equal(v.feeComponents.length, 1);
    const { baseCostUsd } = computeFee(v.feeComponents, undefined, Timestamp.now(), {
      unverifiedReasons: v.feeUnverifiedReasons,
    });
    assert.equal(baseCostUsd, undefined);
  });

  // The KR outcome we want once the fee table is appended: a cited USD 40.
  test("a cited USD fee converts without FX (KR fee-table case)", () => {
    const v = validateExtractedVisa(
      thinKrPayload({
        feeComponents: [{ kind: "application", label: "Single-entry visa", amount: 40, currency: "USD", per: "application" }],
        citations: { "fee.application": "90 days or less Single-entry visa USD 40" },
      })
    );
    const { baseCostUsd } = computeFee(v.feeComponents, undefined, Timestamp.now());
    assert.equal(baseCostUsd, 40);
  });
});

describe("hasCitationWithPrefix", () => {
  test("matches by prefix and ignores empty quotes", () => {
    assert.equal(hasCitationWithPrefix({ "processingTime.inside": "8 weeks" }, ["processingTime"]), true);
    assert.equal(hasCitationWithPrefix({ processingTime: "  " }, ["processingTime"]), false);
    assert.equal(hasCitationWithPrefix({ name: "x" }, ["processingTime", "processingDays"]), false);
  });
});

// ----- Ingest mapping: absent stays absent -----

describe("ingest mapping with unknown processing (issue #86)", () => {
  const extracted = validateExtractedVisa(thinKrPayload());

  test("extractedToVisaFields omits processing days (never writes 0)", () => {
    const fields = extractedToVisaFields({ countryCode: "KR", visaId: "kr-x", code: "C-3", extracted });
    assert.equal("processingDaysMin" in fields, false);
    assert.equal("processingDaysMax" in fields, false);
    assert.equal(fields.processingTime, PROCESSING_TIME_UNKNOWN_LABEL);
  });

  test("absentFieldDeletes deletes stale processing days / maxExtensions on refresh", () => {
    const fields = extractedToVisaFields({ countryCode: "KR", visaId: "kr-x", code: "C-3", extracted });
    const deletes = absentFieldDeletes(fields);
    assert.deepEqual(Object.keys(deletes).sort(), [...REFRESH_DELETABLE_FIELDS].sort());
    for (const v of Object.values(deletes)) assert.ok(v.isEqual(FieldValue.delete()));
  });

  test("absentFieldDeletes is empty when every field is present", () => {
    assert.deepEqual(absentFieldDeletes({ processingDaysMin: 1, processingDaysMax: 2, maxExtensions: 1 }), {});
  });

  test("buildScrapeMeta records processingUnknown + uncitedFieldsDropped + supplements", () => {
    const meta = buildScrapeMeta({
      sourceUrl: KR_TEMPORARY_VISIT_URL,
      routeName: "C-3",
      model: "m",
      contentHash: "h",
      extracted,
      extractedAt: Timestamp.now(),
      supplementaryPages: [{ url: KR_VISA_FEE_TABLE_URL, routeName: "fees", contentHash: "f" }],
    });
    assert.equal(meta.processingUnknown, true);
    assert.deepEqual(meta.uncitedFieldsDropped, ["processingDaysMin", "processingDaysMax"]);
    assert.equal(meta.supplementaryPages?.[0].url, KR_VISA_FEE_TABLE_URL);
  });

  test("buildScrapeMeta keeps the old shape when processing is known", () => {
    const known = validateExtractedVisa(
      thinKrPayload({ processingDaysMin: 7, processingDaysMax: 14, citations: { processingTime: "1-2 weeks" } })
    );
    const meta = buildScrapeMeta({
      sourceUrl: "u", routeName: "r", model: "m", contentHash: "h", extracted: known, extractedAt: Timestamp.now(),
    });
    for (const k of ["processingUnknown", "uncitedFieldsDropped", "supplementaryPages"]) assert.equal(k in meta, false);
  });

  // Country stats (visa.service.updateCountryStats) use finiteMin, so a visa
  // with no processing days never turns minProcessingDays into NaN/undefined.
  test("finiteMin ignores absent processing days", () => {
    assert.equal(finiteMin([undefined, 21, undefined]), 21);
    assert.equal(finiteMin([undefined]), 0);
  });
});

// ----- Supplementary pages -----

describe("supplementary pages (issue #86)", () => {
  test("combineSupplementaryText appends each page under a header; unchanged without any", () => {
    assert.equal(combineSupplementaryText("route", []), "route");
    const text = combineSupplementaryText("route text", [{ page: krFeeTable, doc: doc(krFeeTable.url, "USD 40") }]);
    assert.equal(text, `route text\n\n${supplementaryHeader(krFeeTable)}\nUSD 40`);
    assert.match(supplementaryHeader(krFeeTable), /SUPPLEMENTARY OFFICIAL PAGE/);
  });

  test("supplementaryGateHash: page hash without supplements, changes with a supplement's hash", () => {
    assert.equal(supplementaryGateHash("p", []), "p");
    const a = supplementaryGateHash("p", [{ page: krFeeTable, doc: doc(krFeeTable.url, "USD 40") }]);
    const b = supplementaryGateHash("p", [{ page: krFeeTable, doc: doc(krFeeTable.url, "USD 400") }]);
    assert.notEqual(a, "p");
    assert.notEqual(a, b);
  });

  test("forPage fetches each supplement once per run, in order", async () => {
    let calls = 0;
    const cache = new SupplementaryPageCache(async (p) => {
      calls++;
      return doc(p.url, "fee table");
    });
    const pages = [krRoute, krFeeTable];
    const first = await cache.forPage(krRoute, pages);
    await cache.forPage(krRoute, pages);
    assert.equal(calls, 1);
    assert.deepEqual(first.map((s) => s.page.url), [KR_VISA_FEE_TABLE_URL]);
    assert.deepEqual(supplementaryPagesMeta(first), [
      { url: KR_VISA_FEE_TABLE_URL, routeName: "Visa application fees", contentHash: "hash-of-9" },
    ]);
  });

  test("forPage returns [] (no request) for a route without supplements", async () => {
    const cache = new SupplementaryPageCache(async () => assert.fail("must not fetch"));
    assert.deepEqual(await cache.forPage({ url: "x" }, []), []);
  });

  test("forPage fails closed: unknown URL, a non-supplement row, or a withdrawn page", async () => {
    const ok = new SupplementaryPageCache(async (p) => doc(p.url, "t"));
    await assert.rejects(ok.forPage(krRoute, [krRoute]), SupplementaryPageError);
    await assert.rejects(
      ok.forPage(krRoute, [krRoute, { ...krFeeTable, supplementOnly: undefined }]),
      /not marked supplementOnly/
    );
    const withdrawn = new SupplementaryPageCache(async (p) => doc(p.url, "", { withdrawn: true }));
    await assert.rejects(withdrawn.forPage(krRoute, [krRoute, krFeeTable]), /withdrawn/);
  });

  test("a failed fetch is cached for the run (not retried)", async () => {
    let calls = 0;
    const cache = new SupplementaryPageCache(async () => {
      calls++;
      throw new Error("429");
    });
    await assert.rejects(cache.forPage(krRoute, [krRoute, krFeeTable]), /429/);
    await assert.rejects(cache.forPage(krRoute, [krRoute, krFeeTable]), /429/);
    assert.equal(calls, 1);
  });
});

// ----- AC2: KR registry pins -----

describe("KR registry pins (issue #86)", () => {
  test("the C-3 route lists the fee table; the fee table is supplement-only", () => {
    assert.deepEqual(VISA_SOURCE_OVERRIDES[KR_TEMPORARY_VISIT_URL].supplementaryPages, [KR_VISA_FEE_TABLE_URL]);
    const fee = VISA_SOURCE_OVERRIDES[KR_VISA_FEE_TABLE_URL];
    assert.equal(fee.supplementOnly, true);
    assert.match(fee.visaId, /^kr-/);
  });

  test("parsing the KR rows + applying pins stores both flags on the pages", () => {
    const md = [
      "## 23. South Korea",
      "",
      "| Visa / route | Official link | Validation | Useful information confirmed |",
      "|---|---|---:|---|",
      `| Temporary Visit (C-3) | ${KR_TEMPORARY_VISIT_URL} | TEXT-VERIFIED | HiKorea page. |`,
      `| Visa application fees | ${KR_VISA_FEE_TABLE_URL} | TEXT-VERIFIED | Fee table. |`,
    ].join("\n");
    const kr = parseVisaSourcesMarkdown(md).find((c) => c.countryCode === "KR");
    assert.ok(kr);
    const { pages, matchedUrls } = applyVisaSourcePins(kr.pages, VISA_SOURCE_OVERRIDES);
    assert.equal(matchedUrls.size, 2);
    assert.deepEqual(pages[0].supplementaryPages, [KR_VISA_FEE_TABLE_URL]);
    assert.equal("supplementOnly" in pages[0], false);
    assert.equal(pages[1].supplementOnly, true);
    assert.equal("supplementaryPages" in pages[1], false);
  });
});
