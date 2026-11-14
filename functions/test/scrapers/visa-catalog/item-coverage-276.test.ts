// ============================================
// Unit tests: item coverage follow-ups (issue #276)
// ============================================
// No network, no key, no emulator. Two real GOV.UK pages, recorded read-only
// from the Content API on 2026-11-14 with our bot User-Agent (same trimming as
// `eval:record`), served back to the REAL adapter:
//   fixtures/govuk-health-care-worker-visa.json
//   fixtures/govuk-british-national-overseas-bno-visa.json
// The extractions below are the ones the 2026-11-14 GB re-crawl actually kept
// (run scrapeRuns/HIQuspIXL3nWF5AAzSDz, proposals on durin-seli-dev), copied
// verbatim (items, quotes, kinds) BEFORE the coverage step ran.
//
// What is pinned:
//   1. Health and Care Worker: the short extracted CoS / sponsor-licence items
//      cover the page items with a " - ..." aside (list-item head match), so
//      they are not appended again; the 5 genuine misses still are.
//   2. BN(O): "evidence that their home address is the same as yours" (a span of
//      a "will need to provide X, unless both of the following are true:"
//      sentence) is collected and put back when the extractor drops it.
//   3. The head rules stay conservative (short heads, word boundaries, commas,
//      items without an aside, different items).
// The six golden guides' pinned counts and the v10 replay gate live in
// item-coverage.test.ts and are unchanged by #276.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";

import { GovukContentApiAdapter } from "../../../src/scrapers/visa-catalog/adapters";
import {
  collectPageItems,
  requirementWithExceptions,
  type PageListItem,
} from "../../../src/scrapers/visa-catalog/adapters/govuk-list-items";
import { fixtureFetchService, type GuideFixture } from "../../../src/scrapers/visa-catalog/eval/golden";
import { applyItemCoverage, findMissingItems, listHead } from "../../../src/scrapers/visa-catalog/item-coverage";
import { itemKey } from "../../../src/scrapers/visa-catalog/required-document-meta";
import { ITEM_COVERAGE_VERSION, normForQuote } from "../../../src/scrapers/visa-catalog/visa-catalog-extract.service";
import type { ExtractedVisa } from "../../../src/scrapers/visa-catalog/types";

// ----- Helpers -----

const FIXTURES = path.join(__dirname, "fixtures");

/** Run a recorded GOV.UK page through the REAL adapter (section selection + collector). */
async function fetchRecorded(slug: string) {
  const fx = JSON.parse(fs.readFileSync(path.join(FIXTURES, `govuk-${slug}.json`), "utf8")) as GuideFixture;
  const url = `https://www.gov.uk/${slug}`;
  return new GovukContentApiAdapter(fixtureFetchService(url, fx)).fetch({
    url,
    routeName: slug,
    validation: "text_verified",
  });
}

/** One kept extracted item: text, its verbatim citation quote, and its kind. */
type Kept = { item: string; quote: string; kind: "document" | "information" };

/** A validated extraction (items, citations re-keyed by index, meta aligned). */
function extraction(kept: Kept[]): ExtractedVisa {
  return {
    requiredDocuments: kept.map((k) => k.item),
    citations: Object.fromEntries(kept.map((k, i) => [`requiredDocuments.${i}`, k.quote])),
    requiredDocumentMeta: kept.map((k) => ({ item: k.item, kind: k.kind, need: "required" })),
  } as unknown as ExtractedVisa;
}

/** No two checklist rows may be the same item (same text, or same aside-head). */
function assertNoDuplicateRows(docs: string[]) {
  const keys = docs.map((d) => itemKey(d).replace(/[\s.,;:]+$/, ""));
  for (let i = 0; i < keys.length; i++) {
    for (let j = 0; j < keys.length; j++) {
      if (i === j) continue;
      // "X" and "X - aside" (or "X (aside)") are the same row twice.
      const dup = keys[j] === keys[i] || keys[j].startsWith(`${keys[i]} - `) || keys[j].startsWith(`${keys[i]} (`);
      assert.ok(!dup, `duplicate rows: "${docs[i]}" / "${docs[j]}"`);
    }
  }
}

// ============================================
// 1. Health and Care Worker (no duplicate appends)
// ============================================

/** The 6 items the re-crawl kept for gb-health-care-worker-visa, verbatim. */
const HCW_KEPT: Kept[] = [
  { item: "your certificate of sponsorship reference number", quote: "your certificate of sponsorship reference number", kind: "information" },
  { item: "proof of your knowledge of English", quote: "proof of your knowledge of English", kind: "document" },
  {
    item: "a valid passport or other document that shows your identity and nationality",
    quote: "a valid passport or other document that shows your identity and nationality",
    kind: "document",
  },
  { item: "your job title and annual salary", quote: "your job title and annual salary", kind: "information" },
  { item: "your job’s occupation code", quote: "your job’s occupation code", kind: "information" },
  {
    item: "the name of your employer and their sponsor licence number",
    quote: "the name of your employer and their sponsor licence number",
    kind: "information",
  },
];

/** The page's "Depending on your circumstances" items: none of them was extracted (genuine misses). */
const HCW_GENUINE_MISSES = [
  "evidence that you have enough personal savings to support yourself in the UK, for example bank statements (unless your certificate of sponsorship shows your employer can support you)",
  "proof of your relationship with your partner or children if they’re applying with you",
  "your tuberculosis test results if you’re from a listed country",
  "a criminal record certificate - if you’re working in certain jobs",
  "your UK PhD certificate or your unique Ecctis reference number if your qualification is from outside the UK - you’ll need to apply through Ecctis",
];

describe("#276 Health and Care Worker: short extracted items cover the page items with an aside", () => {
  test("the real page yields 11 items, including the two with a ' - ...' aside", async () => {
    const items = (await fetchRecorded("health-care-worker-visa")).listItems!;
    assert.equal(items.length, 11);
    assert.ok(items.some((i) => i.text === "your certificate of sponsorship reference number - your employer will give you this"));
    assert.ok(
      items.some((i) => i.text === "the name of your employer and their sponsor licence number - this will be on your certificate of sponsorship")
    );
  });

  test("the re-crawl's extraction: CoS and sponsor-licence are matched; exactly the 5 genuine misses remain", async () => {
    const items = (await fetchRecorded("health-care-worker-visa")).listItems!;
    const missing = findMissingItems(extraction(HCW_KEPT), items).map((m) => m.text);
    assert.deepEqual(missing, HCW_GENUINE_MISSES);
  });

  test("applying coverage gives 11 distinct rows (was 13 with 2 duplicates), all 5 misses appended verbatim", async () => {
    const doc = await fetchRecorded("health-care-worker-visa");
    const out = applyItemCoverage(extraction(HCW_KEPT), doc.listItems);
    assert.equal(out.requiredDocuments.length, 11);
    assertNoDuplicateRows(out.requiredDocuments);
    assert.deepEqual(out.requiredDocuments.slice(6), HCW_GENUINE_MISSES);
    assert.deepEqual(out.missingFromExtraction!.map((m) => m.text), HCW_GENUINE_MISSES);
    assert.ok(out.missingFromExtraction!.every((m) => m.appended === true));
    // Every appended citation is contiguous page text.
    const page = normForQuote(doc.text);
    for (let i = 6; i < 11; i++) assert.ok(page.includes(normForQuote(out.citations[`requiredDocuments.${i}`])));
  });

  test("a genuine miss is still appended: no CoS item at all -> the full page item is appended", async () => {
    const items = (await fetchRecorded("health-care-worker-visa")).listItems!;
    const out = applyItemCoverage(extraction(HCW_KEPT.slice(1)), items);
    assert.ok(out.requiredDocuments.includes("your certificate of sponsorship reference number - your employer will give you this"));
    assert.equal(out.missingFromExtraction!.length, 6);
  });

  test("the full page text extracted (Skilled Worker style) still matches", async () => {
    const items = (await fetchRecorded("health-care-worker-visa")).listItems!;
    const full = items.map((i) => ({ item: i.text, quote: i.text, kind: "document" as const }));
    assert.deepEqual(findMissingItems(extraction(full), items), []);
  });
});

// ============================================
// 2. BN(O): the dependants' home-address sentence
// ============================================

const BNO_SENTENCE =
  "Your family members (‘dependants’) will need to provide evidence that their home address is the same as yours, unless both of the following are true:";
const BNO_ITEM = "evidence that their home address is the same as yours";

/** What the 2026-11-14 re-crawl kept for gb-british-national-overseas-bno-visa (the home-address item dropped). */
const BNO_KEPT: Kept[] = [
  {
    item: "a valid passport or other travel document that shows your identity and nationality",
    quote: "When you apply you’ll need to provide a valid passport or other travel document that shows your identity and nationality.",
    kind: "document",
  },
  {
    item: "a certified translation of any documents that are not in English",
    quote: "You must provide a certified translation of any documents that are not in English.",
    kind: "document",
  },
  { item: "your parent's current or expired passport (or a photocopy)", quote: "your parent’s current or expired passport (or a photocopy)", kind: "document" },
  { item: "a birth or adoption certificate that proves your relationship", quote: "a birth or adoption certificate that proves your relationship", kind: "document" },
  {
    item: "up to 3 documents that show your home address",
    quote: "You’ll need to provide up to 3 documents that show your home address.",
    kind: "document",
  },
];

describe("#276 BN(O): 'will need to provide X, unless both of the following are true:'", () => {
  test("the collector takes the item verbatim, with its sentence as quote and no lead-in", async () => {
    const items = (await fetchRecorded("british-national-overseas-bno-visa")).listItems!;
    const home = items.find((i) => i.text === BNO_ITEM)!;
    assert.ok(home, "home-address item collected");
    assert.equal(home.leadIn, "");
    assert.equal(home.quote, BNO_SENTENCE);
    assert.equal(home.section, "documents-youll-need-to-apply");
    // The exceptions list under it is NOT collected as items.
    assert.ok(!items.some((i) => /adult dependent relative|already moved to the UK/i.test(i.text)));
    assert.equal(items.length, 3); // + the two "You’ll need to provide:" list items
  });

  test("the re-crawl's extraction (item dropped): the item is appended, cited by its sentence, conditional", async () => {
    const doc = await fetchRecorded("british-national-overseas-bno-visa");
    const out = applyItemCoverage(extraction(BNO_KEPT), doc.listItems);
    assert.equal(out.requiredDocuments.length, 6);
    assert.equal(out.requiredDocuments[5], BNO_ITEM);
    assert.equal(out.citations["requiredDocuments.5"], BNO_SENTENCE);
    assert.ok(normForQuote(doc.text).includes(normForQuote(BNO_SENTENCE)), "citation is contiguous page text");
    const meta = out.requiredDocumentMeta![5];
    assert.equal(meta.kind, "document");
    assert.equal(meta.kindReview, true);
    assert.equal(meta.kindQuote, BNO_SENTENCE);
    assert.equal(meta.need, "conditional");
    assert.equal(meta.appliesWhen, "unless both of the following are true");
    assert.deepEqual(out.missingFromExtraction, [
      { text: BNO_ITEM, leadIn: "", section: "documents-youll-need-to-apply", appended: true },
    ]);
  });

  test("the earlier live extraction (quoting the sentence) has nothing missing", async () => {
    const items = (await fetchRecorded("british-national-overseas-bno-visa")).listItems!;
    const live = extraction([...BNO_KEPT, { item: BNO_ITEM, quote: BNO_SENTENCE, kind: "document" }]);
    assert.deepEqual(findMissingItems(live, items), []);
  });

  test("the sentence shape is narrow", () => {
    assert.equal(requirementWithExceptions(BNO_SENTENCE), BNO_ITEM);
    assert.equal(requirementWithExceptions("You’ll need to provide X, unless either of the following is true:"), "X");
    for (const s of [
      // Health and Care Worker: "unless" names something else, its list is occupation codes.
      "You’ll need to provide a criminal record certificate if you’re applying from outside the UK, unless your job is in one of the following occupation codes:",
      "You’ll need to provide:",
      "You’ll also need to provide evidence:",
      "You’ll usually need to show proof of this when you apply, unless either:",
      "They must usually apply at the same time as you, unless they’re one of the following:",
      "In most cases, children under 18 need to apply to extend with both parents who have BNO visas, unless:",
    ]) {
      assert.equal(requirementWithExceptions(s), null, s);
    }
  });

  test("the sentence must introduce a list, and must have been sent to the model", () => {
    const html = `<p>You’ll need to provide:</p><ul><li>your passport</li></ul><p>${BNO_SENTENCE}</p>`;
    assert.ok(!collectPageItems([{ slug: "p", html }], {}, `You’ll need to provide:\nyour passport\n${BNO_SENTENCE}`).some((i) => i.text === BNO_ITEM));
    const withList = `${html}<ul><li>they’re your partner</li></ul>`;
    const sent = `You’ll need to provide:\nyour passport\n${BNO_SENTENCE}\nthey’re your partner`;
    assert.ok(collectPageItems([{ slug: "p", html: withList }], {}, sent).some((i) => i.text === BNO_ITEM));
    // Item text present but the sentence cut by the cap: not collected.
    assert.ok(!collectPageItems([{ slug: "p", html: withList }], {}, `You’ll need to provide:\nyour passport\n${BNO_ITEM}`).some((i) => i.text === BNO_ITEM));
  });
});

// ============================================
// 3. The list-item head rule stays conservative
// ============================================

describe("#276 list-item head rule: conservative", () => {
  const li = (text: string): PageListItem => ({ text, leadIn: "You’ll need to provide:", section: "s" });
  const one = (item: string, quote = item) => extraction([{ item, quote, kind: "document" }]);

  test("head = text before ' - ' or ' (' (3+ words); none for prose, no aside, or a short head", () => {
    assert.equal(listHead(li("your certificate of sponsorship reference number - your employer will give you this")), "your certificate of sponsorship reference number");
    assert.equal(listHead(li("your parent’s current or expired passport (or a photocopy)")), "your parent's current or expired passport");
    assert.equal(listHead(li("a birth or adoption certificate that proves your relationship")), null);
    assert.equal(listHead(li("your passport - the one you travel on")), null); // 2 words: too generic
    assert.equal(listHead({ text: "your certificate of sponsorship reference number - x", leadIn: "" }), null);
  });

  test("a comma is not a boundary: one extracted thing never covers a multi-thing item", () => {
    assert.equal(findMissingItems(one("your passport number"), [li("your passport number, visa and BRP")]).length, 1);
  });

  test("the head must match on word boundaries", () => {
    assert.equal(findMissingItems(one("your bank statements"), [li("your bank statement - from the last 6 months")]).length, 1);
  });

  test("a different item with a shared opening is still missing", () => {
    assert.equal(findMissingItems(one("your certificate of sponsorship"), [li("your certificate of sponsorship reference number - your employer will give you this")]).length, 1);
  });

  test("a quote that contains the head (e.g. under its lead-in) also matches", () => {
    const e = one("a criminal record certificate", "Depending on your circumstances, you might be asked to provide: a criminal record certificate");
    assert.deepEqual(findMissingItems(e, [li("a criminal record certificate - if you’re working in certain jobs")]), []);
  });

  test("two missing page items with the same head are appended once (append-step head guard)", () => {
    const out = applyItemCoverage(one("a photo"), [
      li("a criminal record certificate - if you’re working in certain jobs"),
      { ...li("a criminal record certificate (from each country you’ve lived in)"), leadIn: "You may also need to provide:" },
    ]);
    assert.deepEqual(out.requiredDocuments, ["a photo", "a criminal record certificate - if you’re working in certain jobs"]);
    assert.deepEqual(out.missingFromExtraction!.map((m) => m.appended), [true, undefined]);
  });
});

describe("#276 pipeline stamp", () => {
  test("ITEM_COVERAGE_VERSION is bumped so GB proposals built with items-v1 re-extract once", () => {
    assert.equal(ITEM_COVERAGE_VERSION, "items-v2");
  });
});
