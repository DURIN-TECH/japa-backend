// Unit tests for the answer types of information items (issue #187 regroom):
// the deterministic classification on the REAL UK items, the extractor
// validator's fallback rules, the carry-through (derive, checklist, diff) and
// the backfill plan. Pure: no Firestore, no network.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  ANSWER_TYPES,
  answerTypeOf,
  classifyAnswerType,
  normaliseStoredMeta,
  type RequiredDocumentMeta,
} from "../../../src/scrapers/visa-catalog/required-document-meta";
import { answerTypeQuoteOk, validateExtractedVisa, EXTRACTOR_PROMPT_VERSION } from "../../../src/scrapers/visa-catalog/visa-catalog-extract.service";
import { deriveRequirementsFromScrape } from "../../../src/services/visa-requirements-derive";
import { buildChecklist } from "../../../src/services/ai/checklist-builder";
import { planAnswerTypeBackfill } from "../../../src/scripts/backfill-answer-types";
import { diffVisa } from "../../../src/scrapers/visa-catalog/visa-catalog-diff";

// Every information item of the five UK routes that have any, with the type
// the regroom's table gives it (curly apostrophes as on GOV.UK).
const REAL_ITEMS: Array<[string, string]> = [
  // standard visitor
  ["the dates you’re planning to travel to the UK", "date_range"],
  ["where you’ll be staying during your visit", "address"],
  ["how much you think your trip will cost", "money"],
  ["your current home address and how long you’ve lived there", "address"],
  ["your parents’ names and dates of birth (if known)", "list"],
  ["how much you earn in a year (if you have an income)", "money"],
  ["details of any criminal, civil or immigration offences you may have committed", "list"],
  ["details of your travel history for the past 10 years", "list"],
  ["your employer’s address and telephone number", "address"],
  ["your partner’s name, date of birth and passport number", "text"],
  ["the name and address of anyone paying for your trip", "list"],
  ["the name, address and passport number of any family members you have in the UK", "list"],
  // uk family
  ["all your names", "list"],
  ["your date of birth", "date"],
  ["details of any previous immigration applications you’ve made", "list"],
  ["details of any criminal convictions", "list"],
  ["your national insurance number, if you have one", "text"],
  ["your parents’ date of birth and nationality if you’re applying from outside the UK", "text"],
  // skilled worker / health care worker / graduate
  ["your certificate of sponsorship reference number", "text"],
  ["your job title and annual salary", "text"],
  ["your job’s occupation code", "text"],
  ["the name of your employer and their sponsor licence number", "text"],
  ["your Confirmation of Acceptance for Studies (CAS) reference number", "text"],
];

describe("classifyAnswerType on the real UK items", () => {
  for (const [item, type] of REAL_ITEMS) {
    test(`${type}: ${item}`, () => assert.equal(classifyAnswerType(item).type, type));
  }
  test("text is the last resort and is reported as unmatched; a rule match is matched", () => {
    assert.deepEqual(classifyAnswerType("your job title and annual salary"), { type: "text", matched: false });
    assert.deepEqual(classifyAnswerType("a favourite colour"), { type: "text", matched: false });
    assert.deepEqual(classifyAnswerType("your date of birth"), { type: "date", matched: true });
  });
  test("a mixed item never gets a structured type even with a money / date cue", () => {
    assert.equal(classifyAnswerType("your job title and annual salary").type, "text");
    assert.equal(classifyAnswerType("your partner’s name, date of birth and passport number").type, "text");
  });
  test("the type set is exactly the six the regroom names", () => {
    assert.deepEqual([...ANSWER_TYPES], ["date", "date_range", "money", "address", "list", "text"]);
  });
});

describe("extractor validator: answerType + answerTypeQuote", () => {
  const base = {
    name: "Test", code: "TV", description: "d", category: "tourist", processingDaysMin: 15, processingDaysMax: 21, feeComponents: [],
    validityPeriod: "6 months", isExtendable: true, eligibilityCriteria: ["x"], confidence: 0.9,
  };
  const LEAD = "You’ll need to provide the following information in your online application";
  const ITEM = "the dates you’re planning to travel to the UK";
  const COST = "how much you think your trip will cost";
  const page = `${LEAD}: ${ITEM}; ${COST}; where you’ll be staying during your visit.`;
  const run = (meta: Record<string, unknown>[]) =>
    validateExtractedVisa(
      {
        ...base,
        requiredDocuments: [ITEM, COST],
        citations: { "requiredDocuments.0": ITEM, "requiredDocuments.1": COST },
        requiredDocumentMeta: meta,
      },
      { pageText: page }
    ).requiredDocumentMeta!;

  test("prompt version is v9", () => assert.equal(EXTRACTOR_PROMPT_VERSION, "2026-11-answer-types-v9"));

  test("a valid type with a verbatim quote is kept with its quote", () => {
    const m = run([
      { kind: "information", kindQuote: LEAD, need: "required", answerType: "date_range", answerTypeQuote: ITEM },
      { kind: "information", kindQuote: LEAD, need: "required", answerType: "money", answerTypeQuote: COST },
    ]);
    assert.equal(m[0].answerType, "date_range");
    assert.equal(m[0].answerTypeQuote, ITEM);
    assert.equal(m[1].answerType, "money");
  });

  test("a type outside the set, or a quote not on the page, falls back to the rule from the item's words", () => {
    const m = run([
      { kind: "information", kindQuote: LEAD, need: "required", answerType: "phone", answerTypeQuote: ITEM },
      { kind: "information", kindQuote: LEAD, need: "required", answerType: "list", answerTypeQuote: "an invented sentence" },
    ]);
    assert.equal(m[0].answerType, "date_range"); // rule on "the dates ..."
    assert.equal(m[0].answerTypeQuote, undefined);
    assert.equal(m[1].answerType, "money"); // the model's list is dropped, the rule says money
    assert.equal(m[1].answerTypeQuote, undefined);
  });

  test("no type returned: rule; the model's text is treated as unsure and the rule decides, text last", () => {
    const m = run([
      { kind: "information", kindQuote: LEAD, need: "required" },
      { kind: "information", kindQuote: LEAD, need: "required", answerType: "text", answerTypeQuote: COST },
    ]);
    assert.equal(m[0].answerType, "date_range");
    assert.equal(m[1].answerType, "money");
  });

  test("documents carry no answer type, even when the model sends one", () => {
    const m = run([
      { kind: "document", kindQuote: LEAD, need: "required", answerType: "date", answerTypeQuote: ITEM },
      { kind: "document", kindQuote: LEAD, need: "required" },
    ]);
    assert.equal(m[0].answerType, undefined);
    assert.equal(m[1].answerType, undefined);
  });

  test("answerTypeQuoteOk: verbatim on the page and about this item", () => {
    // The page is passed normalised, as the validator does (straight quotes, lower case).
    const n = (s: string) => s.replace(/[\u2018\u2019]/g, "'").toLowerCase();
    assert.equal(answerTypeQuoteOk(ITEM, n(page), ITEM), true);
    assert.equal(answerTypeQuoteOk("", n(page), ITEM), false);
    assert.equal(answerTypeQuoteOk(COST, n(page), ITEM), false); // on the page but another item's words
    assert.equal(answerTypeQuoteOk(ITEM, undefined, ITEM), true); // no page: non-emptiness only
  });
});

describe("carry-through", () => {
  const INFO = "where you’ll be staying during your visit";
  const DOC = "a valid passport";
  const visa: any = {
    id: "gb-x", source: "scraped", requiredDocuments: [INFO, DOC, "an old item"],
    scrapeMeta: {
      sourceUrl: "https://www.gov.uk/x",
      citations: { "requiredDocuments.0": INFO, "requiredDocuments.1": "You must have a passport", "requiredDocuments.2": "an old item" },
      requiredDocumentMeta: [
        { item: INFO, kind: "information", kindQuote: "lead", need: "required", answerType: "address", answerTypeQuote: INFO },
        { item: DOC, kind: "document", kindQuote: "You must have a passport", need: "required", answerType: "date" },
        { item: "an old item", kind: "information", kindQuote: "lead", need: "required" },
      ],
    },
  };

  test("normaliseStoredMeta keeps the type on information items only, drops unknown types", () => {
    assert.equal(normaliseStoredMeta(visa.scrapeMeta.requiredDocumentMeta[0], INFO, INFO).answerType, "address");
    assert.equal(normaliseStoredMeta(visa.scrapeMeta.requiredDocumentMeta[1], "q", DOC).answerType, undefined);
    assert.equal(normaliseStoredMeta({ kind: "information", need: "required", answerType: "phone" }, "q", "x").answerType, undefined);
  });

  test("answerTypeOf: documents none, untyped information reads as text", () => {
    assert.equal(answerTypeOf({ kind: "document" }), undefined);
    assert.equal(answerTypeOf({ kind: "information" }), "text");
    assert.equal(answerTypeOf({ kind: "information", answerType: "list" }), "list");
  });

  test("deriveRequirementsFromScrape", () => {
    const docs = deriveRequirementsFromScrape(visa)[0].requiredDocuments;
    assert.equal(docs[0].answerType, "address");
    assert.equal(docs[0].answerTypeQuote, INFO);
    assert.equal(docs[1].answerType, undefined);
    assert.equal(docs[2].answerType, "text");
  });

  test("buildChecklist", () => {
    const r = buildChecklist({ rubric: null, visaRecord: visa, intakeAnswers: null });
    const by = (t: string) => r.items.find((i) => i.title === t)!;
    assert.equal(by(INFO).answerType, "address");
    assert.equal(by(INFO).answerTypeQuote, INFO);
    assert.equal(by(DOC).answerType, undefined);
    assert.equal(by("an old item").answerType, "text");
  });
});

describe("planAnswerTypeBackfill", () => {
  const mk = (): any => ({
    requiredDocuments: ["your date of birth", "a valid passport", "your job title and annual salary", "details of any criminal convictions"],
    scrapeMeta: {
      requiredDocumentMeta: [
        { item: "your date of birth", kind: "information", need: "required" },
        { item: "a valid passport", kind: "document", need: "required" },
        { item: "your job title and annual salary", kind: "information", need: "required" },
        { item: "details of any criminal convictions", kind: "information", need: "required", answerType: "text" },
      ],
    },
  });

  test("types information items by the rule, logs the text fallbacks, leaves documents and typed items alone", () => {
    const plan = planAnswerTypeBackfill(mk());
    assert.equal(plan.outcome, "backfill");
    assert.equal(plan.changed, 2);
    assert.deepEqual(plan.meta.map((m) => m.answerType), ["date", undefined, "text", "text"]);
    assert.deepEqual(plan.fellBack, [{ item: "your job title and annual salary" }]);
    assert.equal(plan.counts.date, 1);
    assert.equal(plan.counts.text, 2); // the fallback + the already-typed one
  });

  test("idempotent: a second run over its own output changes nothing", () => {
    const first = planAnswerTypeBackfill(mk());
    const again = planAnswerTypeBackfill({ ...mk(), scrapeMeta: { requiredDocumentMeta: first.meta } });
    assert.equal(again.outcome, "already_done");
    assert.equal(again.changed, 0);
    assert.deepEqual(again.meta, first.meta);
  });

  test("a visa with no information items, or no meta, is left alone", () => {
    assert.equal(planAnswerTypeBackfill({ requiredDocuments: ["a"], scrapeMeta: { requiredDocumentMeta: [{ item: "a", kind: "document", need: "required" }] } } as any).outcome, "no_information_items");
    assert.equal(planAnswerTypeBackfill({ requiredDocuments: ["a"] } as any).outcome, "no_information_items");
  });
});

describe("proposals / meta diff", () => {
  const ITEM = "your date of birth";
  const fee = { components: [] } as any;
  const live = (answerType?: string): any => ({
    requiredDocuments: [ITEM],
    scrapeMeta: { citations: { "requiredDocuments.0": ITEM }, requiredDocumentMeta: [{ item: ITEM, kind: "information", need: "required", ...(answerType ? { answerType } : {}) }] },
  });
  const proposed = (answerType: string): RequiredDocumentMeta[] => [{ item: ITEM, kind: "information", need: "required", answerType: answerType as any }];

  test("a changed answer type on an item that stays is reported (an untyped live item reads as text)", () => {
    const r = diffVisa({ live: live(), proposedFields: { requiredDocuments: [ITEM] } as any, proposedFee: fee, proposedMeta: proposed("date") });
    const d = r.diff.find((x) => x.field === "requiredDocumentMeta") as any;
    assert.equal(d.changes[0].before.answerType, "text");
    assert.equal(d.changes[0].after.answerType, "date");
  });

  test("the same type is not a change", () => {
    const r = diffVisa({ live: live("date"), proposedFields: { requiredDocuments: [ITEM] } as any, proposedFee: fee, proposedMeta: proposed("date") });
    assert.equal(r.diff.find((x) => x.field === "requiredDocumentMeta"), undefined);
  });
});
