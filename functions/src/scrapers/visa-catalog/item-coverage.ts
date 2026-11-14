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
// Two conservative "head" rules (prose: #212, list: #276) also count an item as
// matched when a kept item clearly covers it; they can only STOP an append,
// never add one.

/** Citation key of the item at `index` (same shape as requiredDocumentCitationKey). */
const citationKey = (index: number) => `requiredDocuments.${index}`;

/** `normForQuote` minus trailing punctuation: "...in the uk." and "...in the uk" are the same item. */
function matchKey(text: string): string {
  return normForQuote(text).replace(/[\s.,;:]+$/, "");
}

/**
 * The "head" of a prose requirement ("You must have a passport or travel
 * document that is valid ..." -> "you must have a passport or travel document"):
 * the normalised sentence up to its first clause boundary (a comma, semicolon or
 * full stop, or the words " that ", " to ", " which ", " and ", " or if "). Null
 * for a list item (it has a lead-in) and for a sentence whose head is shorter than
 * "you must have " plus one word, so a bare "You must have a" can never match.
 * Conservative on purpose: the head is only used to say "a kept item already
 * covers THIS requirement", never to add anything.
 */
export function proseHead(item: Pick<PageListItem, "text" | "leadIn">): string | null {
  if (item.leadIn) return null;
  const key = matchKey(item.text);
  if (!key.startsWith("you must have ")) return null;
  const cut = key.search(/[,;.]| that | to | which | and | or if /);
  const head = (cut === -1 ? key : key.slice(0, cut)).trim();
  return head.length > "you must have ".length + 1 ? head : null;
}

// ----- List-item head (issue #276) -----

/**
 * Where a list item's "aside" starts: " - " (GOV.UK's explanatory dash, e.g.
 * "your certificate of sponsorship reference number - your employer will give
 * you this") or " (" (a parenthetical, e.g. "your parent's current or expired
 * passport (or a photocopy)"). Commas are deliberately NOT a boundary: in a
 * list item a comma can separate several different things ("your passport,
 * visa and BRP"), so cutting there could let one extracted thing cover others.
 * `normForQuote` has already turned en/em dashes into "-".
 */
const LIST_ASIDE_RE = / - | \(/;

/** A cut head must have at least this many words ("a criminal record certificate" = 4). */
const MIN_HEAD_WORDS = 3;

/**
 * The head of a normalised item text: everything before its first aside
 * (LIST_ASIDE_RE), or null when there is no aside or the head is shorter than
 * MIN_HEAD_WORDS words (too generic to say "this is the same item").
 */
function asideHead(key: string): string | null {
  const cut = key.search(LIST_ASIDE_RE);
  if (cut <= 0) return null;
  const head = key.slice(0, cut).replace(/[\s.,;:]+$/, "").trim();
  return head.split(" ").length >= MIN_HEAD_WORDS ? head : null;
}

/**
 * The "head" of a LIST item (one with a lead-in), issue #276: the item's
 * normalised text up to its first aside (" - " or " ("). Null for a prose
 * item, for an item with no aside (then only the whole-text match applies) and
 * for a head of fewer than three words.
 *
 * Why: the Health and Care Worker re-crawl (scrapeRuns/HIQuspIXL3nWF5AAzSDz)
 * kept "your certificate of sponsorship reference number" (quote: exactly that)
 * for the page item "your certificate of sponsorship reference number - your
 * employer will give you this". The quote does not contain the whole page item,
 * so the item counted as missing and was appended: the checklist asked for the
 * reference number twice. Same for "the name of your employer and their sponsor
 * licence number - this will be on your certificate of sponsorship". The aside
 * only says where the applicant gets the thing; the head names it.
 */
export function listHead(item: Pick<PageListItem, "text" | "leadIn">): string | null {
  if (!item.leadIn) return null;
  return asideHead(matchKey(item.text));
}

/**
 * True when `needle` occurs in `hay` on WORD boundaries (both normalised), so
 * the head "your passport number" never matches inside "your passport numbers"
 * and "a visa" never matches inside "a visas officer".
 */
function containsWords(hay: string, needle: string): boolean {
  if (!needle) return false;
  let from = 0;
  for (;;) {
    const at = hay.indexOf(needle, from);
    if (at === -1) return false;
    const before = at === 0 ? "" : hay[at - 1];
    const after = hay[at + needle.length] ?? "";
    if (!/[a-z0-9]/.test(before) && !/[a-z0-9]/.test(after)) return true;
    from = at + 1;
  }
}

/**
 * The page items no extracted item's citation quote contains, in page order,
 * de-duplicated by normalised text. Items in `requiredDocumentsDropped` never
 * count as matched (they have no surviving quote).
 *
 * Matching (issue #212): trailing punctuation is ignored on both sides. A PROSE
 * requirement ("You must have a passport or travel document that is valid for the
 * whole of your stay in the UK.") is also matched when a kept item's quote or
 * text contains its head (proseHead): the model usually cites the passport from
 * the eligibility sentence ("You must have a passport or travel document to enter
 * the UK. It should be valid ..."), and appending the page sentence as well would
 * ask for the passport twice.
 *
 * A LIST item with an aside (issue #276) is also matched when a kept item's quote
 * or text contains its head (listHead) on word boundaries: "your certificate of
 * sponsorship reference number" covers "your certificate of sponsorship reference
 * number - your employer will give you this".
 *
 * @param extracted the validated extraction (items + citations re-keyed to kept items)
 * @param pageItems what the collector found on the page
 */
export function findMissingItems(
  extracted: Pick<ExtractedVisa, "requiredDocuments" | "citations">,
  pageItems: PageListItem[]
): PageListItem[] {
  const docs = extracted.requiredDocuments ?? [];
  // Matching keys of every kept item: its quote and its own text.
  const quotes = docs.map((_, i) => {
    const q = extracted.citations?.[citationKey(i)];
    return typeof q === "string" ? matchKey(q) : "";
  });
  const texts = docs.map((d) => matchKey(d));
  const seen = new Set<string>();
  const missing: PageListItem[] = [];
  for (const item of pageItems) {
    const key = matchKey(item.text);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    if (quotes.some((q) => q.length > 0 && q.includes(key))) continue; // matched
    const head = proseHead(item);
    if (head && (quotes.some((q) => q.includes(head)) || texts.some((t) => t.includes(head)))) continue;
    // Issue #276: a list item whose head (text before " - " / " (") a kept item covers.
    const lHead = listHead(item);
    if (lHead && (quotes.some((q) => containsWords(q, lHead)) || texts.some((t) => containsWords(t, lHead)))) continue;
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
 * with no lead-in, the sentence itself (`quote` when the item is only part of it).
 */
function appendedItemMeta(item: PageListItem): RequiredDocumentMeta {
  // Issue #276: an item taken from INSIDE a sentence carries that sentence as
  // `quote`; it is the kind quote and the need source, so "..., unless both of
  // the following are true:" makes the item conditional.
  const kindQuote = item.quote ?? (item.leadIn || item.text);
  const { need, appliesWhen } = classifyNeed(item.quote ?? item.text, item.leadIn || undefined, item.text);
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
 *    text as the citation quote, or its sentence `quote` when it is part of
 *    one; both are contiguous page text), with meta aligned by index, unless
 *    an item with the same text OR the same head is already listed (then it is
 *    only recorded, `appended` false: the model has it, its quote just does
 *    not contain the whole page item).
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
  // Issue #276 (belt and braces): the normalised text AND the aside-head of every
  // listed item. A missing item whose own head is one of these is the same thing
  // the checklist already asks for (it only adds where to get it), so it is
  // recorded, never appended. findMissingItems should already have matched it;
  // this guards the append step on its own (e.g. an item whose quote is absent).
  const haveHeads = new Set<string>();
  const addHeads = (text: string) => {
    const k = matchKey(text);
    haveHeads.add(k);
    const h = asideHead(k);
    if (h) haveHeads.add(h);
  };
  docs.forEach(addHeads);
  const recorded: MissingFromExtractionItem[] = [];
  for (const item of missing) {
    const base = { text: item.text, leadIn: item.leadIn, section: item.section };
    const head = listHead(item) ?? proseHead(item) ?? matchKey(item.text);
    if (have.has(itemKey(item.text)) || haveHeads.has(head)) {
      recorded.push(base); // already listed: recorded, not duplicated
      continue;
    }
    const at = docs.length;
    docs.push(item.text);
    citations[citationKey(at)] = item.quote ?? item.text;
    have.add(itemKey(item.text));
    addHeads(item.text);
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
