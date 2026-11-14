// ============================================
// Unit tests: item coverage (issue #212)
// ============================================
// No network, no key, no emulator. Covers the HTML collector (real adapter over
// the recorded golden guides), the matcher / appender, the eval hard gate on the
// committed v10 result, and the pipeline version stamp.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";

import { GovukContentApiAdapter } from "../../../src/scrapers/visa-catalog/adapters";
import { collectPageItems, isRecognisedLeadIn } from "../../../src/scrapers/visa-catalog/adapters/govuk-list-items";
import { EVAL_ROUTES, RESULTS_DIR } from "../../../src/scrapers/visa-catalog/eval/config";
import { fixtureFetchService, loadGuide } from "../../../src/scrapers/visa-catalog/eval/golden";
import { evalPage, main, type EvalResultFile } from "../../../src/scrapers/visa-catalog/eval/run";
import { applyItemCoverage, findMissingItems } from "../../../src/scrapers/visa-catalog/item-coverage";
import {
  EXTRACTION_PIPELINE_VERSION,
  EXTRACTOR_PROMPT_VERSION,
  ITEM_COVERAGE_VERSION,
  extractionVersionFor,
  normForQuote,
} from "../../../src/scrapers/visa-catalog/visa-catalog-extract.service";
import { isPendingPromptStale } from "../../../src/scrapers/visa-catalog/visa-catalog-diff";
import { buildScrapeMeta } from "../../../src/scrapers/visa-catalog/visa-catalog-meta";
import type { ExtractedVisa } from "../../../src/scrapers/visa-catalog/types";
import { Timestamp } from "firebase-admin/firestore";

/** The committed v10 eval result (pinned real miss counts come from this file). */
const V10 = "2026-11-answer-types-v10__deepseek-flash__20261114T070207Z.json";
const v10: EvalResultFile = JSON.parse(fs.readFileSync(path.join(RESULTS_DIR, V10), "utf8"));

/** Collected items of a golden route through the REAL adapter + registry section selection. */
async function collect(route: string) {
  const r = EVAL_ROUTES.find((x) => x.route === route)!;
  const doc = await new GovukContentApiAdapter(fixtureFetchService(r.url, loadGuide(route))).fetch(evalPage(r));
  return doc;
}

describe("lead-in recognition", () => {
  test("the eight 'provide' lead-ins from the golden guides are recognised (curly or straight quotes)", () => {
    for (const l of [
      "You’ll need to provide:",
      "You’ll also need to provide either:",
      "When you apply you’ll need to provide:",
      "Depending on your circumstances, you might be asked to provide:",
      "Depending on your circumstances, you might also need to provide:",
      "You’ll need to provide the following information in your online application:",
      "When you apply for your Student visa you must provide:",
      "You may also need to provide:",
      "you'll need to provide:",
    ]) {
      assert.ok(isRecognisedLeadIn(l), l);
    }
  });
  test("lists that only CONTAIN 'provide', or are other kinds of list, are not lead-ins", () => {
    for (const l of [
      "You’ll also need to:",
      "You’ll also need to give details of:",
      "You’ll need to provide a criminal record certificate if you’re applying from outside the UK and you work in:",
      "You need to provide additional documents if you’re visiting the UK:",
      "If you or your family member are employed, you could include:",
      "The employer’s letter should confirm:",
      "You’ll need to provide evidence of their address, such as:",
    ]) {
      assert.equal(isRecognisedLeadIn(l), false, l);
    }
  });
});

describe("collector over the six golden guides (real adapter)", () => {
  // Groomed counts; Standard Visitor is 13 list items + the passport sentence.
  const expected: Record<string, number> = {
    "uk-family-visa": 12,
    "standard-visitor": 14,
    "global-talent": 2,
    "skilled-worker-visa": 12,
    "student-visa": 8,
    "graduate-visa": 4,
  };
  for (const [route, n] of Object.entries(expected)) {
    test(`${route}: ${n} items`, async () => {
      const doc = await collect(route);
      assert.equal(doc.listItems!.length, n);
    });
  }
  test("uk-family-visa: first items are the page's own wording under the lead-in", async () => {
    const items = (await collect("uk-family-visa")).listItems!;
    assert.deepEqual(items.slice(0, 2).map((i) => i.text), ["all your names", "your date of birth"]);
    assert.equal(items[0].leadIn, "You’ll need to provide:");
    assert.equal(items[0].section, "provide-information");
    assert.ok(items.some((i) => i.text === "your national insurance number, if you have one"));
    // None of the sentences in UK Family's document part is a prose requirement.
    assert.equal(items.filter((i) => !i.leadIn).length, 0);
  });
  test("standard-visitor: the passport prose sentence is collected, verbatim, with no lead-in", async () => {
    const items = (await collect("standard-visitor")).listItems!;
    const passport = items.find((i) => !i.leadIn)!;
    assert.equal(passport.text, "You must have a passport or travel document that is valid for the whole of your stay in the UK.");
    assert.equal(passport.section, "apply-standard-visitor-visa");
    // Visit-type list under "You need to provide additional documents if ..." is not collected.
    assert.ok(!items.some((i) => /visiting|business/i.test(i.leadIn)));
  });
  test("an item cut by the text cap is not collected", () => {
    const html = "<p>You’ll need to provide:</p><ul><li>your passport</li><li>your visa</li></ul>";
    const items = collectPageItems([{ slug: "p", html }], {}, "You’ll need to provide:\nyour passport");
    assert.deepEqual(items.map((i) => i.text), ["your passport"]);
  });
});

describe("matcher and appender", () => {
  const base = (docs: string[], quotes: string[]): ExtractedVisa =>
    ({
      requiredDocuments: docs,
      citations: Object.fromEntries(quotes.map((q, i) => [`requiredDocuments.${i}`, q])),
      requiredDocumentMeta: docs.map((d) => ({ item: d, kind: "document", need: "required" })),
    }) as unknown as ExtractedVisa;
  const page = [
    { text: "your date of birth", leadIn: "You’ll need to provide:", section: "s" },
    { text: "your parents’ names", leadIn: "You’ll need to provide:", section: "s" },
  ];

  test("a quote that CONTAINS the page item matches, whatever the apostrophes", () => {
    const ex = base(["a", "b"], ["your date of birth - extra", "your parents' names"]);
    assert.deepEqual(findMissingItems(ex, page), []);
  });
  test("a quote shorter than the page item counts as missing", () => {
    const ex = base(["a", "b"], ["your date", "your parents’ names"]);
    assert.deepEqual(findMissingItems(ex, page).map((m) => m.text), ["your date of birth"]);
  });
  test("an item split over two extracted items counts as missing", () => {
    const ex = base(["your parents", "names"], ["your parents", "names"]);
    assert.equal(findMissingItems(ex, page).length, 2);
  });
  test("a full extraction gives [] and the extraction is otherwise unchanged", () => {
    const ex = base(["your date of birth", "your parents’ names"], ["your date of birth", "your parents’ names"]);
    const out = applyItemCoverage(ex, page);
    assert.deepEqual(out.missingFromExtraction, []);
    assert.deepEqual(out.requiredDocuments, ex.requiredDocuments);
  });
  test("pageItems undefined = not checked: no missingFromExtraction field", () => {
    const ex = base(["a"], ["a"]);
    assert.equal("missingFromExtraction" in applyItemCoverage(ex, undefined), false);
  });
  test("missing items are APPENDED verbatim, index-aligned, kind document + kindReview, need by the #187 rules", () => {
    const ex = base(["your date of birth"], ["your date of birth"]);
    const withCond = [
      ...page,
      { text: "a TB certificate if you’re visiting for more than 6 months", leadIn: "Depending on your circumstances, you might also need to provide:", section: "s" },
    ];
    const out = applyItemCoverage(ex, withCond);
    assert.deepEqual(out.requiredDocuments, [
      "your date of birth",
      "your parents’ names",
      "a TB certificate if you’re visiting for more than 6 months",
    ]);
    assert.equal(out.citations["requiredDocuments.1"], "your parents’ names");
    const meta = out.requiredDocumentMeta!;
    assert.equal(meta.length, 3);
    assert.equal(meta[1].item, "your parents’ names");
    assert.equal(meta[1].kind, "document");
    assert.equal(meta[1].kindReview, true);
    assert.equal(meta[1].need, "required");
    assert.equal(meta[1].kindQuote, "You’ll need to provide:");
    assert.equal(meta[2].need, "conditional");
    assert.match(meta[2].appliesWhen!, /^if you/i);
    assert.deepEqual(out.missingFromExtraction!.map((m) => m.appended), [true, true]);
  });
  test("an item already listed (same text) is recorded but not duplicated", () => {
    const ex = base(["your date of birth"], ["something else entirely"]);
    const out = applyItemCoverage(ex, [page[0]]);
    assert.deepEqual(out.requiredDocuments, ["your date of birth"]);
    assert.equal(out.missingFromExtraction![0].appended, undefined);
  });
  test("every appended citation is contiguous text of the page (normalised)", async () => {
    const doc = await collect("standard-visitor");
    const v = v10.routes.find((r) => r.route === "standard-visitor")!.extracted!;
    const out = applyItemCoverage(v, doc.listItems);
    const pageText = normForQuote(doc.text);
    const i = v.requiredDocuments.length; // the appended passport sentence
    assert.ok(pageText.includes(normForQuote(out.citations[`requiredDocuments.${i}`])));
    assert.equal(out.requiredDocuments.length, v.requiredDocuments.length + 1);
  });
  test("scrapeMeta carries missingFromExtraction, including []", () => {
    const meta = buildScrapeMeta({
      sourceUrl: "u", routeName: "r", model: "m", contentHash: "h", extractedAt: Timestamp.now(),
      extracted: { confidence: 1, citations: {}, missingFromExtraction: [] },
    });
    assert.deepEqual(meta.missingFromExtraction, []);
  });
});

describe("eval hard gate: item coverage", () => {
  test("replaying the committed v10 result FAILS with exactly the real misses (Skilled Worker 6, Standard Visitor 1)", async () => {
    const lines: string[] = [];
    const code = await main(["--replay", path.join(RESULTS_DIR, V10)], { log: (l) => lines.push(l), logError: () => undefined });
    assert.equal(code, 1);
    const out = lines.join("\n");
    const misses = lines.filter((l) => l.includes("item coverage miss on"));
    assert.equal(misses.length, 7);
    assert.equal(misses.filter((l) => l.includes("on skilled-worker-visa")).length, 6);
    assert.equal(misses.filter((l) => l.includes("on standard-visitor")).length, 1);
    // route, section, leadIn, text
    assert.match(out, /standard-visitor, apply-standard-visitor-visa, \(no lead-in\), You must have a passport/);
    assert.match(out, /Item coverage misses \(hard gate\): 7/);
  });
  test("a synthetic output citing every collected item passes the gate", async () => {
    for (const r of EVAL_ROUTES) {
      const doc = await collect(r.route);
      const ex = v10.routes.find((x) => x.route === r.route)!.extracted!;
      const items = doc.listItems!.map((i) => i.text);
      const full = {
        ...ex,
        requiredDocuments: items,
        citations: { ...ex.citations, ...Object.fromEntries(items.map((t, i) => [`requiredDocuments.${i}`, t])) },
      } as ExtractedVisa;
      assert.deepEqual(findMissingItems(full, doc.listItems!), [], r.route);
    }
  });
  test("a listed known gap is printed but never fails", async () => {
    const { scoreRoute, evaluateGate } = await import("../../../src/scrapers/visa-catalog/eval/score");
    const { loadExpected } = await import("../../../src/scrapers/visa-catalog/eval/golden");
    const expected = { ...loadExpected("standard-visitor"), itemCoverageGaps: [{ text: "You must have a passport or travel document that is valid for the whole of your stay in the UK.", ref: "#213", note: "test" }] };
    const doc = await collect("standard-visitor");
    const ex = v10.routes.find((x) => x.route === "standard-visitor")!.extracted!;
    const score = scoreRoute(expected, ex, undefined, findMissingItems(ex, doc.listItems!));
    assert.deepEqual(score.itemCoverageMisses, []);
    assert.ok(score.notes.some((n) => n.includes("known item gap #213")));
    assert.ok(!evaluateGate([score]).failures.some((f) => f.includes("item coverage")));
  });
});

describe("pipeline version stamp (re-extract without a paid eval)", () => {
  test("the prompt version is unchanged; the stamp adds the coverage code version", () => {
    assert.equal(EXTRACTOR_PROMPT_VERSION, "2026-11-answer-types-v10");
    assert.equal(EXTRACTION_PIPELINE_VERSION, `${EXTRACTOR_PROMPT_VERSION}+${ITEM_COVERAGE_VERSION}`);
  });
  test("an approved GB visa stamped with the old prompt version is stale; one with the new stamp is not", () => {
    const visa = (v: string) =>
      ({ source: "scraped", reviewStatus: "approved", requiredDocuments: ["x"], scrapeMeta: { extractorPromptVersion: v } }) as never;
    assert.equal(isPendingPromptStale(visa(EXTRACTOR_PROMPT_VERSION), EXTRACTION_PIPELINE_VERSION), true);
    assert.equal(isPendingPromptStale(visa(EXTRACTION_PIPELINE_VERSION), EXTRACTION_PIPELINE_VERSION), false);
  });
});

describe("prose requirements are not appended twice (review fix)", () => {
  const passport = {
    text: "You must have a passport or travel document that is valid for the whole of your stay in the UK.",
    leadIn: "",
    section: "apply-standard-visitor-visa",
  };
  const ex = (doc: string, quote: string) =>
    ({
      requiredDocuments: [doc],
      citations: { "requiredDocuments.0": quote },
      requiredDocumentMeta: [{ item: doc, kind: "document", need: "required" }],
    }) as unknown as ExtractedVisa;

  test("a passport cited from the eligibility sentence: nothing missing, nothing appended", () => {
    const e = ex(
      "a passport or travel document",
      "You must have a passport or travel document to enter the UK. It should be valid for the whole of your stay."
    );
    assert.deepEqual(findMissingItems(e, [passport]), []);
    const out = applyItemCoverage(e, [passport]);
    assert.deepEqual(out.requiredDocuments, e.requiredDocuments);
    assert.deepEqual(out.missingFromExtraction, []);
  });
  test("a quote without the trailing full stop still matches the page sentence", () => {
    const e = ex("a passport", passport.text.replace(/\.$/, ""));
    assert.deepEqual(findMissingItems(e, [passport]), []);
  });
  test("conservative: another requirement, or no passport at all, is still missing", () => {
    assert.equal(findMissingItems(ex("a photo", "a photo"), [passport]).length, 1);
    const other = { ...passport, text: "You must have a job offer before you apply." };
    assert.equal(findMissingItems(ex("a passport", "You must have a passport or travel document to enter the UK."), [other]).length, 1);
  });
  test("a list item is never matched by the PROSE head (only prose has one)", () => {
    const li = { text: "a passport that is valid", leadIn: "You’ll need to provide:", section: "s" };
    assert.equal(findMissingItems(ex("a photo", "a photo"), [li]).length, 1);
  });
});

describe("version stamp is scoped to adapters that run the coverage check (review fix)", () => {
  test("GB (govuk-content-api) carries the +items-vN stamp; everything else keeps the plain prompt version", () => {
    assert.equal(extractionVersionFor("govuk-content-api"), EXTRACTION_PIPELINE_VERSION);
    assert.equal(extractionVersionFor("generic-html"), EXTRACTOR_PROMPT_VERSION);
    assert.equal(extractionVersionFor(undefined), EXTRACTOR_PROMPT_VERSION);
  });
  test("a non-GB visa stamped with the plain prompt version is NOT stale; a GB one is", () => {
    const visa = (v: string) =>
      ({ source: "scraped", reviewStatus: "approved", requiredDocuments: ["x"], scrapeMeta: { extractorPromptVersion: v } }) as never;
    assert.equal(isPendingPromptStale(visa(EXTRACTOR_PROMPT_VERSION), extractionVersionFor("generic-html")), false);
    assert.equal(isPendingPromptStale(visa(EXTRACTOR_PROMPT_VERSION), extractionVersionFor("govuk-content-api")), true);
  });
});
