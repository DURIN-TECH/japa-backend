// ============================================
// Processing range vs cited durations (issue #87)
// ============================================
//
// Covers:
//  - processingDurationsInDays(): the duration parser (units, ranges, number
//    words, working days);
//  - checkProcessingRangeCitations(): the Standard Visitor regression (max 56
//    with only "within 3 weeks" cited) and the cases it must NOT judge
//    (no cited duration, missing / 0 values: #86's rule);
//  - validateExtractedVisa(): a disagreement is FLAGGED (reasons + capped
//    confidence), never rejected, and absent when the range agrees;
//  - buildScrapeMeta(): the flag reaches the stored scrapeMeta;
//  - the v5 prompt rule tying each end of the range to its quote.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { Timestamp } from "firebase-admin/firestore";

import {
  checkProcessingRangeCitations,
  isProcessingCitationKey,
  parseNumberToken,
  processingDurationsInDays,
  relevantProcessingQuotes,
  PROCESSING_UNVERIFIED_CONFIDENCE_CAP,
} from "../../../src/scrapers/visa-catalog/visa-catalog-processing-check";
import { buildSystemPrompt, validateExtractedVisa } from "../../../src/scrapers/visa-catalog/visa-catalog-extract.service";
import { buildScrapeMeta } from "../../../src/scrapers/visa-catalog/visa-catalog-meta";
import { readFileSync } from "fs";
import * as path from "path";

// The two Standard Visitor sentences (src/scrapers/visa-catalog/eval/golden/standard-visitor/guide.json).
const OUTSIDE_3_WEEKS = "you’ll usually get a decision on your visa within 3 weeks.";
const EXTEND_8_WEEKS =
  "If you use the standard service, a decision will usually be made within 8 weeks of providing your supporting documents and proving your identity.";

/** A minimal valid raw extraction (Standard Visitor-like), overridable. */
function rawVisitor(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "Standard Visitor visa",
    code: "STANDARD_VISITOR",
    description: "Visit the UK for tourism or business.",
    category: "tourist",
    processingTime: "3-8 weeks",
    processingDaysMin: 21,
    processingDaysMax: 56,
    validityPeriod: "6 months",
    isExtendable: true,
    eligibilityCriteria: ["You will leave the UK at the end of your visit"],
    confidence: 0.95,
    feeComponents: [{ kind: "application", label: "Standard Visitor visa", amount: 135, currency: "GBP", per: "application" }],
    citations: {
      "fee.application": "A Standard Visitor visa costs £135 for up to 6 months.",
      processingDaysMin: OUTSIDE_3_WEEKS,
      processingDaysMax: EXTEND_8_WEEKS,
    },
    ...over,
  };
}

// ----- Parser -----

describe("processingDurationsInDays", () => {
  test("weeks, days, months, years and hours convert to days", () => {
    assert.deepEqual(processingDurationsInDays(OUTSIDE_3_WEEKS), [21]);
    assert.deepEqual(processingDurationsInDays(EXTEND_8_WEEKS), [56]);
    assert.deepEqual(processingDurationsInDays("within 10 days"), [10]);
    assert.deepEqual(processingDurationsInDays("about 12 months"), [360]);
    assert.deepEqual(processingDurationsInDays("within 1 year"), [365]);
    assert.deepEqual(processingDurationsInDays("within 24 hours"), [1]);
  });

  test("a range sharing one unit yields both ends", () => {
    assert.deepEqual(processingDurationsInDays("3-8 weeks"), [21, 56]);
    assert.deepEqual(processingDurationsInDays("3 – 8 weeks"), [21, 56]);
    assert.deepEqual(processingDurationsInDays("3 to 8 weeks"), [21, 56]);
    assert.deepEqual(processingDurationsInDays("3 weeks / 8 weeks"), [21, 56]);
  });

  test("number words, hyphenated units and working days", () => {
    assert.deepEqual(processingDurationsInDays("within three weeks"), [21]);
    assert.deepEqual(processingDurationsInDays("a 12-week wait"), [84]);
    // Plain count AND calendar equivalent (x 7/5).
    assert.deepEqual(processingDurationsInDays("15 working days"), [15, 21]);
  });

  test("text with no duration yields nothing", () => {
    assert.deepEqual(processingDurationsInDays("You must apply online."), []);
    assert.deepEqual(processingDurationsInDays("several weeks"), []);
  });

  // Review round 1 (#87): phrasing the first parser missed, one row each.
  // [phrase, expected days]
  const TABLE: [string, number[]][] = [
    // qualifier word between number and unit
    ["within 15 calendar days", [15]],
    ["within 15 calendar days … extended to 45 days", [15, 45]],
    ["10 working days", [10, 14]], // plain count + calendar equivalent (x 7/5)
    ["10 business days", [10, 14]],
    ["3 full weeks", [21]],
    // "and" / "or" range separators
    ["between 2 and 4 months", [60, 120]],
    ["between one and three months", [30, 90]],
    ["2 or 3 weeks", [14, 21]],
    // number words: tens, hyphenated and spaced compounds (never a range)
    ["forty-five days", [45]],
    ["twenty-one days", [21]],
    ["twenty one days", [21]],
    ["sixty days", [60]],
    ["ninety days", [90]],
    ["eighteen weeks", [126]], // a teen is not read as its unit ("eight")
    ["seventy days", [70]],
    // "a" / "an" = 1
    ["within a month", [30]],
    ["about a week", [7]],
    // abbreviations
    ["1-2 wks", [7, 14]],
    ["2 wk", [14]],
    ["3 mos", [90]],
    ["6 mths", [180]],
    ["24 hrs", [1]],
    ["1 yr", [365]],
    // a compound stay length stays two durations, not a 2-9 month range
    ["2 years and 9 months", [730, 270]],
    // non-English: nothing parses (the check then fails safe)
    ["15 jours", []],
    ["drei Wochen", []],
    ["10 días hábiles", []],
  ];
  for (const [phrase, days] of TABLE) {
    test(`parses ${JSON.stringify(phrase)} -> [${days.join(", ")}]`, () => {
      assert.deepEqual(processingDurationsInDays(phrase), days);
    });
  }

  test("parseNumberToken: digits, words, compounds, a/an; unknown words are not numbers", () => {
    assert.equal(parseNumberToken("45"), 45);
    assert.equal(parseNumberToken("forty-five"), 45);
    assert.equal(parseNumberToken("ninety"), 90);
    assert.equal(parseNumberToken("an"), 1);
    assert.equal(parseNumberToken("several"), undefined);
    assert.equal(parseNumberToken("forty-several"), undefined);
  });
});

// ----- Citation keys -----

describe("processing citation keys (prefix match)", () => {
  test("suffixed keys count; other keys do not", () => {
    for (const k of ["processingTime", "processingTime.inside", "processingDaysMin", "processingDaysMax.outside"]) {
      assert.equal(isProcessingCitationKey(k), true, k);
    }
    for (const k of ["fee.application", "validityPeriod", "eligibilityCriteria"]) {
      assert.equal(isProcessingCitationKey(k), false, k);
    }
  });

  test("a field's relevant quotes = processingTime* plus its own processingDays<Field>*", () => {
    const c = {
      processingTime: "3-8 weeks",
      "processingTime.inside": "within 8 weeks",
      "processingDaysMax.outside": "within 12 weeks",
      processingDaysMin: "within 3 weeks",
      validityPeriod: "5 years",
    };
    assert.deepEqual(relevantProcessingQuotes(c, "processingDaysMax"), ["3-8 weeks", "within 8 weeks", "within 12 weeks"]);
    assert.deepEqual(relevantProcessingQuotes(c, "processingDaysMin"), ["3-8 weeks", "within 8 weeks", "within 3 weeks"]);
  });

  test("real v4 Standard Visitor output (8 weeks cited only as processingTime.inside) is NOT flagged", () => {
    // src/scrapers/visa-catalog/eval/results/2026-11-surcharge-total-v4__deepseek-chat__20261109T214642Z.json
    const file = path.join(__dirname, "../../../src/scrapers/visa-catalog", "eval", "results", "2026-11-surcharge-total-v4__deepseek-chat__20261109T214642Z.json");
    const res = JSON.parse(readFileSync(file, "utf8")) as {
      routes: { route: string; extracted: { processingDaysMin: number; processingDaysMax: number; citations: Record<string, string> } }[];
    };
    const visitor = res.routes.find((r) => r.route === "standard-visitor");
    assert.ok(visitor);
    assert.ok("processingTime.inside" in visitor.extracted.citations);
    assert.deepEqual(checkProcessingRangeCitations(visitor.extracted, visitor.extracted.citations), []);
  });
});

// ----- The check -----

describe("checkProcessingRangeCitations", () => {
  test("#87 regression: max 56 with only 'within 3 weeks' cited is reported", () => {
    const reasons = checkProcessingRangeCitations(
      { processingDaysMin: 21, processingDaysMax: 56 },
      { processingTime: OUTSIDE_3_WEEKS, processingDaysMax: OUTSIDE_3_WEEKS }
    );
    assert.deepEqual(reasons, ["processingDaysMax 56 is more than 20% from every cited duration (21 days)"]);
  });

  test("agrees when each end is cited, or within 20% (at least 1 day)", () => {
    assert.deepEqual(
      checkProcessingRangeCitations(
        { processingDaysMin: 21, processingDaysMax: 56 },
        { processingDaysMin: OUTSIDE_3_WEEKS, processingDaysMax: EXTEND_8_WEEKS }
      ),
      []
    );
    // 67 is within 20% of 56 (<= 67.2); 68 is not.
    const at = (max: number) =>
      checkProcessingRangeCitations({ processingDaysMin: 21, processingDaysMax: max }, { processingTime: "3-8 weeks" });
    assert.deepEqual(at(67), []);
    assert.equal(at(68).length, 1);
    // Tiny figures get a 1-day floor: 2 days vs "1 day" agrees.
    assert.deepEqual(checkProcessingRangeCitations({ processingDaysMax: 2 }, { processingTime: "1 day" }), []);
  });

  test("fail-safe: one relevant quote with no parsable duration -> that field is not judged", () => {
    // Non-English quote next to an English one: the max would otherwise be flagged.
    assert.deepEqual(
      checkProcessingRangeCitations(
        { processingDaysMin: 15, processingDaysMax: 45 },
        { processingTime: "within 15 calendar days", "processingTime.extended": "jusqu'à 45 jours" }
      ),
      []
    );
    // Only the field whose relevant quotes are all parsable is judged:
    // processingDaysMax.note is relevant to the max only.
    const reasons = checkProcessingRangeCitations(
      { processingDaysMin: 5, processingDaysMax: 99 },
      { processingTime: "within 3 weeks", "processingDaysMax.note": "voir le site" }
    );
    assert.deepEqual(reasons, ["processingDaysMin 5 is more than 20% from every cited duration (21 days)"]);
  });

  test("review phrasings agree with correct values (no false flags)", () => {
    const ok = (min: number, max: number, quote: string) =>
      assert.deepEqual(checkProcessingRangeCitations({ processingDaysMin: min, processingDaysMax: max }, { processingTime: quote }), [], quote);
    ok(15, 45, "within 15 calendar days, which may be extended to 45 days");
    ok(60, 120, "between 2 and 4 months");
    ok(30, 90, "between one and three months");
    ok(14, 21, "2 or 3 weeks");
    ok(45, 45, "forty-five days");
  });

  test("checks the min too", () => {
    const reasons = checkProcessingRangeCitations(
      { processingDaysMin: 5, processingDaysMax: 56 },
      { processingTime: "3-8 weeks" }
    );
    assert.equal(reasons.length, 1);
    assert.match(reasons[0], /^processingDaysMin 5 /);
  });

  test("not judged: no cited duration, missing / non-finite / 0 values (#86's rule)", () => {
    assert.deepEqual(checkProcessingRangeCitations({ processingDaysMin: 21, processingDaysMax: 56 }, {}), []);
    assert.deepEqual(checkProcessingRangeCitations({ processingDaysMax: 56 }, undefined), []);
    assert.deepEqual(
      checkProcessingRangeCitations({ processingDaysMin: 21, processingDaysMax: 56 }, { processingTime: "Apply online" }),
      []
    );
    assert.deepEqual(
      checkProcessingRangeCitations({ processingDaysMin: 0, processingDaysMax: NaN }, { processingTime: "within 3 weeks" }),
      []
    );
  });

  test("a custom tolerance is honoured (the eval passes its own)", () => {
    const values = { processingDaysMax: 25 };
    const citations = { processingTime: "within 3 weeks" };
    assert.deepEqual(checkProcessingRangeCitations(values, citations), []); // 25 <= 21 + 4.2
    assert.equal(checkProcessingRangeCitations(values, citations, { tolerance: 0.1 }).length, 1);
  });
});

// ----- Validator integration -----

describe("validateExtractedVisa — processing range vs citations (#87)", () => {
  test("agreeing range: no flag, confidence untouched", () => {
    const v = validateExtractedVisa(rawVisitor());
    assert.equal("processingUnverifiedReasons" in v, false);
    assert.equal(v.confidence, 0.95);
  });

  test("disagreeing range: kept but flagged, confidence capped", () => {
    const v = validateExtractedVisa(
      rawVisitor({
        citations: {
          "fee.application": "A Standard Visitor visa costs £135 for up to 6 months.",
          processingTime: OUTSIDE_3_WEEKS,
        },
      })
    );
    // The values are NOT changed or dropped: a reviewer decides.
    assert.equal(v.processingDaysMin, 21);
    assert.equal(v.processingDaysMax, 56);
    assert.deepEqual(v.processingUnverifiedReasons, [
      "processingDaysMax 56 is more than 20% from every cited duration (21 days)",
    ]);
    assert.equal(v.confidence, PROCESSING_UNVERIFIED_CONFIDENCE_CAP);
  });

  test("the cap never raises a confidence that was already lower", () => {
    const v = validateExtractedVisa(
      rawVisitor({
        confidence: 0.3,
        citations: { "fee.application": "A Standard Visitor visa costs £135 for up to 6 months.", processingTime: OUTSIDE_3_WEEKS },
      })
    );
    assert.equal(v.confidence, 0.3);
    assert.ok(v.processingUnverifiedReasons);
  });
});

// ----- Stored scrapeMeta -----

describe("buildScrapeMeta — processingUnverifiedReasons (#87)", () => {
  const base = {
    sourceUrl: "https://www.gov.uk/standard-visitor",
    routeName: "Standard Visitor",
    model: "deepseek-chat",
    contentHash: "h",
    extractedAt: Timestamp.fromMillis(0),
  };

  test("copied when set", () => {
    const meta = buildScrapeMeta({
      ...base,
      extracted: { confidence: 0.5, citations: {}, processingUnverifiedReasons: ["processingDaysMax 56 …"] },
    });
    assert.deepEqual(meta.processingUnverifiedReasons, ["processingDaysMax 56 …"]);
  });

  test("absent (no key) when not set or empty", () => {
    assert.equal("processingUnverifiedReasons" in buildScrapeMeta({ ...base, extracted: { confidence: 1, citations: {} } }), false);
    assert.equal(
      "processingUnverifiedReasons" in
        buildScrapeMeta({ ...base, extracted: { confidence: 1, citations: {}, processingUnverifiedReasons: [] } }),
      false
    );
  });
});

// ----- Prompt -----

describe("extractor prompt — processing citations (#87)", () => {
  const prompt = buildSystemPrompt();

  test("each end of the range is tied to the quote that states it", () => {
    assert.match(prompt, /citations\['processingDaysMin'\] = the sentence stating the SHORTER time/);
    assert.match(prompt, /citations\['processingDaysMax'\] = the sentence stating the LONGER time/);
    assert.match(prompt, /citations\['processingTime'\] = the quote\(s\) stating every duration in the range/);
    assert.match(prompt, /Never report a processing figure that no quote in these citations states/);
  });

  test("the full-range value rule (user decision on #60) is unchanged", () => {
    assert.match(prompt, /processingDaysMin = the SHORTER of the two, processingDaysMax = the LONGER/);
    assert.match(prompt, /a visitor extending their stay/);
  });
});
