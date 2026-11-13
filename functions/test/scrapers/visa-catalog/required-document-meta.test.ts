// Unit tests for issue #187: kind + need classification of required-document
// items (rules, extractor validator, derive, checklist builder, backfill, and
// the shared edit window). Pure: no Firestore, no network.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { Timestamp } from "firebase-admin/firestore";

import {
  classifyNeed,
  extractLeadIn,
  metaFromQuoteOnly,
} from "../../../src/scrapers/visa-catalog/required-document-meta";
import { validateExtractedVisa } from "../../../src/scrapers/visa-catalog/visa-catalog-extract.service";
import { deriveRequirementsFromScrape } from "../../../src/services/visa-requirements-derive";
import { buildChecklist } from "../../../src/services/ai/checklist-builder";
import { planItemKindBackfill } from "../../../src/scripts/backfill-item-kinds";
import { isWithinApplicantEditWindow } from "../../../src/utils/editable-window";
import { validateAnswerText, MAX_ANSWER_LENGTH } from "../../../src/services/answers.service";

// The Standard Visitor page's own wording (golden fixture).
const TB = "a certificate proving that you’ve had a tuberculosis (TB) test if you’re visiting for more than 6 months";
const INCOME = "how much you earn in a year (if you have an income)";
const PARENTS = "your parents’ names and dates of birth (if known)";
const OFFENCES = "details of any criminal, civil or immigration offences you may have committed";
const LEAD_IN = "Depending on your circumstances, you might also need to provide:";

describe("classifyNeed", () => {
  test("the three Standard Visitor conditional examples carry their verbatim clause", () => {
    assert.deepEqual(classifyNeed(TB), { need: "conditional", appliesWhen: "if you’re visiting for more than 6 months" });
    assert.deepEqual(classifyNeed(INCOME), { need: "conditional", appliesWhen: "if you have an income" });
    assert.deepEqual(classifyNeed(PARENTS), { need: "conditional", appliesWhen: "if known" });
  });
  test("\"may\" never counts: offences you may have committed stays required", () => {
    assert.deepEqual(classifyNeed(OFFENCES), { need: "required" });
    assert.deepEqual(classifyNeed("Passport issued after 1 May 2020"), { need: "required" });
  });
  test("unless / depending on / optional", () => {
    assert.equal(classifyNeed("a form, unless you are under 18").appliesWhen, "unless you are under 18");
    assert.equal(classifyNeed("proof of funds depending on your nationality").need, "conditional");
    assert.deepEqual(classifyNeed("bank statements are optional"), { need: "optional" });
  });
  test("the lead-in makes an item conditional even without an inline if; inline wins", () => {
    assert.deepEqual(classifyNeed("your employer’s address and telephone number", LEAD_IN), {
      need: "conditional",
      appliesWhen: "Depending on your circumstances, you might also need to provide",
    });
    assert.equal(extractLeadIn("Documents you need"), null);
    assert.equal(classifyNeed(TB, LEAD_IN).appliesWhen, "if you’re visiting for more than 6 months");
  });
  test("no quote = required, quote-only meta stays document + kindReview", () => {
    assert.deepEqual(classifyNeed(undefined), { need: "required" });
    assert.deepEqual(metaFromQuoteOnly("a passport"), { kind: "document", kindReview: true, need: "required" });
  });
});

describe("extractor validator (kind + need)", () => {
  const base = {
    name: "Standard Visitor", code: "SV", description: "d", category: "tourist", processingTime: "3 weeks",
    processingDaysMin: 15, processingDaysMax: 21, feeComponents: [], validityPeriod: "6 months", isExtendable: true,
    eligibilityCriteria: ["x"], confidence: 0.9,
  };
  const INFO_LEAD = "You’ll need to provide the following information in your online application";
  const page = `${INFO_LEAD}: where you’ll be staying during your visit; ${INCOME}; ${OFFENCES}. ${LEAD_IN} ${TB}. You must have a passport.`;
  const docs = ["where you’ll be staying during your visit", "how much you earn in a year", "a certificate proving", "a passport"];
  const cites = {
    "requiredDocuments.0": "where you’ll be staying during your visit",
    "requiredDocuments.1": INCOME,
    "requiredDocuments.2": TB,
    "requiredDocuments.3": "You must have a passport",
  };

  test("keeps a verified kind, derives need in code (the model's need is ignored)", () => {
    const v = validateExtractedVisa(
      {
        ...base, requiredDocuments: docs, citations: cites,
        requiredDocumentMeta: [
          { kind: "information", kindQuote: INFO_LEAD, need: "required" },
          { kind: "information", kindQuote: INFO_LEAD, need: "required" }, // model wrong: the quote has "if"
          { kind: "document", kindQuote: LEAD_IN, need: "conditional", appliesWhen: "if you’re visiting for more than 6 months" },
          { kind: "document", kindQuote: "You must have a passport", need: "required" },
        ],
      },
      { pageText: page }
    );
    const m = v.requiredDocumentMeta!;
    assert.deepEqual(m[0], { kind: "information", kindQuote: INFO_LEAD, need: "required" });
    assert.equal(m[1].need, "conditional");
    assert.equal(m[1].appliesWhen, "if you have an income");
    assert.equal(m[2].appliesWhen, "if you’re visiting for more than 6 months");
    assert.equal(m[2].kindQuote, LEAD_IN); // lead-in kept as kindQuote
    assert.deepEqual(m[3], { kind: "document", kindQuote: "You must have a passport", need: "required" });
  });

  test("a kind whose quote is not on the page becomes document + kindReview", () => {
    const v = validateExtractedVisa(
      {
        ...base, requiredDocuments: ["a passport"], citations: { "requiredDocuments.0": "You must have a passport" },
        requiredDocumentMeta: [{ kind: "information", kindQuote: "an invented sentence", need: "required" }],
      },
      { pageText: page }
    );
    assert.deepEqual(v.requiredDocumentMeta![0], { kind: "document", kindReview: true, need: "required" });
  });

  test("missing meta list, or an invented appliesWhen, degrade safely; meta follows dedupe/drops", () => {
    const v = validateExtractedVisa(
      {
        ...base, requiredDocuments: ["Gone", "a passport", "A PASSPORT"],
        citations: { "requiredDocuments.1": "You must have a passport", "requiredDocuments.2": "You must have a passport" },
        requiredDocumentMeta: [
          { kind: "document", kindQuote: "You must have a passport", need: "conditional", appliesWhen: "if the moon is full" },
          { kind: "document", kindQuote: "You must have a passport", need: "conditional", appliesWhen: "if the moon is full" },
        ],
      },
      { pageText: page }
    );
    assert.deepEqual(v.requiredDocuments, ["a passport"]);
    assert.equal(v.requiredDocumentMeta!.length, 1);
    assert.deepEqual(v.requiredDocumentMeta![0], { kind: "document", kindQuote: "You must have a passport", need: "required" });
    const none = validateExtractedVisa({ ...base, requiredDocuments: ["a passport"], citations: { "requiredDocuments.0": "You must have a passport" } }, { pageText: page });
    assert.equal(none.requiredDocumentMeta![0].kindReview, true);
  });
});

describe("derive + checklist carry kind and need", () => {
  const URL = "https://www.gov.uk/standard-visitor";
  const visa: any = {
    id: "gb-sv", countryCode: "GB", source: "scraped", sourceUrl: URL, lastVerifiedAt: Timestamp.fromMillis(1),
    requiredDocuments: ["where you’ll be staying", "a TB certificate", "a passport"],
    scrapeMeta: {
      sourceUrl: URL,
      citations: { "requiredDocuments.0": "where you’ll be staying", "requiredDocuments.1": TB, "requiredDocuments.2": "You must have a passport" },
      requiredDocumentMeta: [
        { kind: "information", kindQuote: "lead", need: "required" },
        { kind: "document", need: "conditional", appliesWhen: "if you’re visiting for more than 6 months" },
        { kind: "document", need: "required" },
      ],
    },
  };

  test("derive: stored meta wins; isRequired only for required", () => {
    const d = deriveRequirementsFromScrape(visa)[0].requiredDocuments;
    assert.deepEqual(d.map((x) => [x.kind, x.need, x.isRequired]), [
      ["information", "required", true], ["document", "conditional", false], ["document", "required", true],
    ]);
    assert.equal(d[1].appliesWhen, "if you’re visiting for more than 6 months");
    assert.equal(d[0].kindQuote, "lead");
  });

  test("checklist builder: same fields, required mirrors need", () => {
    const out = buildChecklist({ rubric: null, visaRecord: visa, intakeAnswers: null });
    assert.deepEqual(out.items.map((i) => [i.kind, i.need, i.required]), [
      ["information", "required", true], ["document", "conditional", false], ["document", "required", true],
    ]);
    assert.equal(out.items[1].appliesWhen, "if you’re visiting for more than 6 months");
  });

  test("checklist builder: no stored meta reads document + kindReview, need from the quote", () => {
    const old = { ...visa, scrapeMeta: { ...visa.scrapeMeta, requiredDocumentMeta: undefined } };
    const out = buildChecklist({ rubric: null, visaRecord: old, intakeAnswers: null });
    assert.deepEqual(out.items.map((i) => [i.kind, i.kindReview, i.need]), [
      ["document", true, "required"], ["document", true, "conditional"], ["document", true, "required"],
    ]);
  });
});

describe("backfill plan", () => {
  const visa: any = {
    requiredDocuments: ["a", "b"],
    scrapeMeta: { citations: { "requiredDocuments.0": "your income (if you have one)", "requiredDocuments.1": "a passport" } },
  };
  test("derives need from the stored quote, kind stays document + kindReview, counts reported", () => {
    const p = planItemKindBackfill(visa);
    assert.equal(p.outcome, "backfill");
    assert.deepEqual(p.counts, { items: 2, required: 1, conditional: 1, optional: 0, kindReview: 2 });
    assert.equal(p.meta[0].appliesWhen, "if you have one");
  });
  test("idempotent: already classified (same length) is left alone; no documents is skipped", () => {
    const done = { ...visa, scrapeMeta: { ...visa.scrapeMeta, requiredDocumentMeta: [{ kind: "information", need: "required" }, { kind: "document", need: "required" }] } };
    assert.equal(planItemKindBackfill(done).outcome, "already_done");
    assert.equal(planItemKindBackfill({ scrapeMeta: {} } as any).outcome, "no_documents");
  });
});

describe("answers validation and the shared edit window", () => {
  test("text rules", () => {
    assert.equal(validateAnswerText("  hi "), "hi");
    assert.equal(validateAnswerText("   "), "");
    assert.throws(() => validateAnswerText(1));
    assert.throws(() => validateAnswerText("x".repeat(MAX_ANSWER_LENGTH + 1)));
    assert.equal(validateAnswerText("x".repeat(MAX_ANSWER_LENGTH)).length, MAX_ANSWER_LENGTH);
  });
  test("edit window = the statement's window", () => {
    for (const s of ["draft", "pending_payment", "pending_documents"]) assert.equal(isWithinApplicantEditWindow(s), true);
    for (const s of ["under_review", "submitted_to_embassy", "approved", "rejected"]) assert.equal(isWithinApplicantEditWindow(s), false);
  });
});
