import type { PageListItem } from "./adapters/govuk-list-items";
import { classifyNeed, itemKey, type RequiredDocumentMeta } from "./required-document-meta";
import { normForQuote } from "./visa-catalog-extract.service";
import type { ExtractedVisa, MissingFromExtractionItem } from "./types";

// ============================================
// ITEM COVERAGE — match the page's items against the extraction (issue #212)
// ============================================
//
// The adapter's collector (adapters/govuk-list-items.ts) lists every item the
// page asks the applicant to provide. This module answers two questions, in
// pure code:
//   1. Which of those items did the extraction NOT return? (`findMissingItems`)
//   2. Make the checklist complete: APPEND each missing item, verbatim, flagged
//      for review (`applyItemCoverage`). The item is grounded in the page (its
//      own <li> text), so this does not break the domain rule that code never
//      invents a document; it is still recorded in `missingFromExtraction`
//      (`appended: true`) so an admin sees what the model missed.
//
// Matching uses the citation validator's own `normForQuote` (exported from the
// extractor, not copied): a page item is MATCHED when some surviving extracted
// item's verbatim citation quote CONTAINS the page item's normalised text.

/** Citation key of the item at `index` (same shape as requiredDocumentCitationKey). */
const citationKey = (index: number) => `requiredDocuments.${index}`;

/**
 * The page items no extracted item's citation quote contains, in page order,
 * de-duplicated by normalised text. Items in `requiredDocumentsDropped` never
 * count as matched (they have no surviving quote).
 *
 * @param extracted the validated extraction (items + citations re-keyed to kept items)
 * @param pageItems what the collector found on the page
 */
export function findMissingItems(
  extracted: Pick<ExtractedVisa, "requiredDocuments" | "citations">,
  pageItems: PageListItem[]
): PageListItem[] {
  // Normalised quote of every kept item.
  const quotes = (extracted.requiredDocuments ?? []).map((_, i) => {
    const q = extracted.citations?.[citationKey(i)];
    return typeof q === "string" ? normForQuote(q) : "";
  });
  const seen = new Set<string>();
  const missing: PageListItem[] = [];
  for (const item of pageItems) {
    const key = normForQuote(item.text);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    if (quotes.some((q) => q.length > 0 && q.includes(key))) continue; // matched
    missing.push(item);
  }
  return missing;
}

/**
 * Meta of an APPENDED item. It is a `document` with `kindReview` (the page does
 * not say whether it is something to upload or type in, and code does not guess;
 * the admin reviews it). `need` comes from the #187 rules applied to the
 * verbatim text and its lead-in. An information `answerType` is not set: it
 * applies to information items only, and this one is kept as a document.
 * `kindQuote` is the lead-in (verbatim page text) or, for a prose requirement
 * with no lead-in, the sentence itself.
 */
function appendedItemMeta(item: PageListItem): RequiredDocumentMeta {
  const kindQuote = item.leadIn || item.text;
  const { need, appliesWhen } = classifyNeed(item.text, item.leadIn || undefined, item.text);
  return {
    item: item.text,
    kind: "document",
    kindReview: true,
    kindQuote,
    need,
    ...(appliesWhen ? { appliesWhen } : {}),
  };
}

/**
 * Apply the coverage check to a validated extraction. Returns a NEW extraction:
 *  - `missingFromExtraction` set (to [] when nothing is missing);
 *  - every missing item appended to `requiredDocuments` (verbatim text, its own
 *    text as the citation quote, which is contiguous page text), with meta
 *    aligned by index, unless an item with the same text is already listed
 *    (then it is only recorded, `appended` false: the model has it, its quote
 *    just does not contain the whole page item).
 * `pageItems` undefined = the adapter did not check: the extraction is returned
 * untouched (no `missingFromExtraction` field at all).
 */
export function applyItemCoverage(extracted: ExtractedVisa, pageItems: PageListItem[] | undefined): ExtractedVisa {
  if (!pageItems) return extracted;
  const missing = findMissingItems(extracted, pageItems);
  // `?? []`: a stub / legacy extraction may omit the field entirely.
  const docs = [...(extracted.requiredDocuments ?? [])];
  const citations = { ...extracted.citations };
  // Meta is index-aligned with items. The validator writes it for every kept
  // item, so it is only ever absent when there are no items yet.
  const metaList: RequiredDocumentMeta[] | undefined = extracted.requiredDocumentMeta
    ? [...extracted.requiredDocumentMeta]
    : docs.length === 0
      ? []
      : undefined;
  const have = new Set(docs.map(itemKey));
  const recorded: MissingFromExtractionItem[] = [];
  for (const item of missing) {
    const base = { text: item.text, leadIn: item.leadIn, section: item.section };
    if (have.has(itemKey(item.text))) {
      recorded.push(base); // already listed: recorded, not duplicated
      continue;
    }
    const at = docs.length;
    docs.push(item.text);
    citations[citationKey(at)] = item.text;
    have.add(itemKey(item.text));
    if (metaList) metaList.push(appendedItemMeta(item));
    recorded.push({ ...base, appended: true });
  }
  return {
    ...extracted,
    requiredDocuments: docs,
    citations,
    ...(metaList ? { requiredDocumentMeta: metaList } : {}),
    missingFromExtraction: recorded,
  };
}
