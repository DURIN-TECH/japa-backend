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
  citedProcessingDurations,
  processingDurationsInDays,
  PROCESSING_UNVERIFIED_CONFIDENCE_CAP,
} from "../src/services/visa-catalog-processing-check";
import { buildSystemPrompt, validateExtractedVisa } from "../src/services/visa-catalog-extract.service";
import { buildScrapeMeta } from "../src/services/visa-catalog-meta";

// The two Standard Visitor sentences (eval/golden/standard-visitor/guide.json).
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

  test("the union of processingTime / Min / Max citations is used", () => {
    assert.deepEqual(
      citedProcessingDurations({ processingTime: "3-8 weeks", processingDaysMax: "within 12 weeks", other: "5 years" }),
      [21, 56, 84]
    );
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
