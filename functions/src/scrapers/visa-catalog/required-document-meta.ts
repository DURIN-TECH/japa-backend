// ============================================
// Required-document item meta: kind + need (issue #187)
// ============================================
//
// A scraped visa's `requiredDocuments` is a list of strings, one per item the
// official page asks the applicant to provide. Two things about each item are
// NOT in the string and are stored next to it (index-aligned, under
// `scrapeMeta.requiredDocumentMeta`), so a client can treat them properly:
//
//   kind  "document"    something the applicant uploads (a passport, a certificate);
//         "information" something the applicant types in ("the dates you're planning
//                       to travel", "your current home address").
//   need  "required"    the default;
//         "conditional" the item's own wording makes it depend on something
//                       ("if you're visiting for more than 6 months", "unless ...",
//                       "depending on ...") or it sits under the page's
//                       "Depending on your circumstances, you might also need to
//                       provide:" lead-in;
//         "optional"    the wording says "optional".
//
// DOMAIN RULES (every one traceable to the page's wording, none invented):
//  - `kind` comes from the page's own wording and is backed by a verbatim
//    `kindQuote`. A kind whose quote is not on the page is never kept: the item
//    falls back to "document" with `kindReview: true` ("could not classify").
//  - `need` is decided HERE, by code, from the item's own quote (and the
//    lead-in quote), never by the model alone. The only cues are the three the
//    issue names: "if", "unless", "depending on" (conditional) and "optional".
//  - "may" never counts: "details of any offences you may have committed" stays
//    required (QA on #175).
//  - `appliesWhen` is always a verbatim slice of the quote it came from.
//
// This module is PURE (no Firebase, no model call, no I/O) so the extractor's
// validator, the read-time derivation, the checklist builder and the backfill
// script all apply the same rules.

// ----- Types -----

/** What the applicant does with the item. */
export type DocumentKind = "document" | "information";

/** How firmly the page asks for the item. */
export type DocumentNeed = "required" | "conditional" | "optional";

/** The stored classification of ONE required-document item. */
export interface RequiredDocumentMeta {
  // The item's own text (as in `requiredDocuments`). Meta is matched to items
  // BY THIS TEXT, never by position alone, so a reordered list cannot hand an
  // item its neighbour's classification (review fix on #187).
  item?: string;
  kind: DocumentKind;
  // True when the item could not be classified from the page's wording (no
  // verifiable kind quote). The item stays "document".
  kindReview?: true;
  // Verbatim page text that backs `kind` (or the lead-in an item sits under).
  kindQuote?: string;
  need: DocumentNeed;
  // Verbatim "if ..." / "unless ..." / "depending on ..." clause, or the
  // "Depending on your circumstances ..." lead-in. Only when need is conditional.
  appliesWhen?: string;
}

/** The defaults for a document with nothing said about it (seeded / admin visas). */
export const DEFAULT_DOCUMENT_META: Readonly<RequiredDocumentMeta> = Object.freeze({
  kind: "document",
  need: "required",
});

// ----- Matching meta to items by text -----

/**
 * Comparison key of an item's text: curly quotes/dashes unified, whitespace
 * collapsed, lower-cased. Characters only; never fuzzy word matching.
 */
export function itemKey(text: string): string {
  return text
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, "\"")
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * The stored meta entry for the item `name` at `index` of `requiredDocuments`.
 *  - an entry whose `item` text equals the item's text wins (the reliable key);
 *  - otherwise the entry at `index` is used ONLY for a legacy list where no
 *    entry carries an `item` and the lengths match (nothing to contradict it);
 *  - otherwise undefined: the caller falls back to "document + kindReview",
 *    never to a neighbour's classification.
 */
export function findMetaForItem(
  list: RequiredDocumentMeta[] | undefined,
  index: number,
  name: string,
  itemCount: number
): RequiredDocumentMeta | undefined {
  if (!Array.isArray(list) || list.length === 0) return undefined;
  const key = itemKey(name);
  const byText = list.find((m) => typeof m?.item === "string" && itemKey(m.item) === key);
  if (byText) return byText;
  const legacy = list.every((m) => !m || typeof m.item !== "string");
  return legacy && list.length === itemCount ? list[index] : undefined;
}

// ----- The rules -----

// "optional" as a whole word, any case. The only optional cue.
const OPTIONAL_CUE = /\boptional\b/i;

// The inline conditional cues: "if", "unless", "depending on" (whole words).
// Deliberately NOT "may" ("offences you may have committed" is required).
const CONDITIONAL_CUE = /\b(?:if|unless|depending on)\b/i;

// The page's lead-in for conditional items: "Depending on your circumstances,
// you might also need to provide:". Matched through the colon / sentence end.
const LEAD_IN = /depending on your circumstances[^:.\n]*[:.]?/i;

/**
 * The clause that starts at the first conditional cue in `text`, verbatim:
 * it runs to the closing bracket, semicolon, line end or sentence end, whichever
 * comes first ("(if you have an income)" -> "if you have an income"). Null when
 * `text` has no cue. Commas do NOT end it (the clause may contain one).
 */
export function extractConditionalClause(text: string): string | null {
  const m = CONDITIONAL_CUE.exec(text);
  if (!m) return null;
  let end = text.length;
  for (let i = m.index; i < text.length; i++) {
    const c = text[i];
    const sentenceEnd = c === "." && (i + 1 >= text.length || /\s/.test(text[i + 1]));
    // A colon also ends the clause: after it comes the item list, not the condition.
    if (c === ")" || c === "]" || c === ";" || c === ":" || c === "\n" || sentenceEnd) {
      end = i;
      break;
    }
  }
  const clause = text.slice(m.index, end).replace(/[\s,:;.]+$/, "");
  return clause.length > 0 ? clause : null;
}

/**
 * The verbatim lead-in ("Depending on your circumstances, you might also need
 * to provide") inside `quote`, or null when the quote is not that lead-in.
 */
export function extractLeadIn(quote: string): string | null {
  const m = LEAD_IN.exec(quote);
  if (!m) return null;
  const lead = m[0].replace(/[\s,;:.]+$/, "");
  return lead.length > 0 ? lead : null;
}

/**
 * The part of an item's quote that speaks about THIS item: from the item's own
 * text to the end of its sentence. A quote may run on into the next sentence
 * ("a passport. If you're under 18 ...") or start with a lead-in; neither says
 * anything about this item. When the item text is not found in the quote (or
 * not given) the whole quote is used.
 */
function ownText(quote: string, itemText?: string): string {
  if (!itemText || !itemText.trim()) return quote;
  // Same-length folding (curly -> straight apostrophe, lower case) keeps indices valid.
  const fold = (t: string) => t.replace(/[\u2018\u2019]/g, "'").replace(/[\u201C\u201D]/g, "\"").toLowerCase();
  const at = fold(quote).indexOf(fold(itemText.trim()));
  if (at < 0) return quote;
  const rest = quote.slice(at);
  // End at the first sentence end (". " or a line break) after the item text.
  const after = rest.slice(itemText.trim().length);
  const m = /\.(?:\s|$)|\n/.exec(after);
  return m ? rest.slice(0, itemText.trim().length + m.index) : rest;
}

/**
 * Decide `need` (+ `appliesWhen`) for one item.
 *
 * Order: "optional" wins; then an inline "if / unless / depending on" clause in
 * the item's OWN text (see ownText; the most specific statement); then the
 * page's lead-in (the item sits under "Depending on your circumstances ...");
 * otherwise required. No quote at all is "required" (the item default), never
 * a guess.
 *
 * @param itemQuote the verbatim quote that cites the item
 * @param kindQuote the stored kind quote, which may be the lead-in
 * @param itemText  the item's own text, to ignore what the quote says around it
 */
export function classifyNeed(
  itemQuote: string | undefined,
  kindQuote?: string,
  itemText?: string
): { need: DocumentNeed; appliesWhen?: string } {
  const quote = ownText((itemQuote ?? "").trim(), itemText);
  if (OPTIONAL_CUE.test(quote)) return { need: "optional" };
  const clause = extractConditionalClause(quote);
  if (clause) return { need: "conditional", appliesWhen: clause };
  // The lead-in: from the stored kind quote, else from the item's own FULL
  // citation quote (it may carry "Depending on your circumstances ...:" in
  // front of the item, e.g. every backfilled or kindReview item, which has no
  // kind quote). ownText cut that part off for the inline-cue scan above.
  const lead = (kindQuote ? extractLeadIn(kindQuote) : null) ?? extractLeadIn((itemQuote ?? "").trim());
  if (lead) return { need: "conditional", appliesWhen: lead };
  return { need: "required" };
}

/**
 * Meta for an item that has no stored classification (a scraped visa crawled
 * before #187, or one the backfill has not reached): kind is NOT known, so it
 * stays "document" with `kindReview`, and `need` is still derived from the
 * stored quote with the same rules. Nothing is invented.
 */
export function metaFromQuoteOnly(itemQuote: string | undefined, itemText?: string): RequiredDocumentMeta {
  const { need, appliesWhen } = classifyNeed(itemQuote, undefined, itemText);
  return {
    ...(itemText ? { item: itemText } : {}),
    kind: "document",
    kindReview: true,
    need,
    ...(appliesWhen ? { appliesWhen } : {}),
  };
}

/**
 * Normalise a stored meta value read from Firestore into a well-formed one.
 * Anything malformed falls back to `metaFromQuoteOnly` (never throws).
 */
export function normaliseStoredMeta(
  stored: unknown,
  itemQuote: string | undefined,
  itemText?: string
): RequiredDocumentMeta {
  if (!stored || typeof stored !== "object") return metaFromQuoteOnly(itemQuote, itemText);
  const s = stored as Record<string, unknown>;
  const kind: DocumentKind = s.kind === "information" ? "information" : "document";
  const need: DocumentNeed =
    s.need === "conditional" || s.need === "optional" || s.need === "required" ? s.need : "required";
  const out: RequiredDocumentMeta = { kind, need };
  if (s.kindReview === true) out.kindReview = true;
  if (typeof s.kindQuote === "string" && s.kindQuote.trim()) out.kindQuote = s.kindQuote.trim();
  if (need === "conditional" && typeof s.appliesWhen === "string" && s.appliesWhen.trim()) {
    out.appliesWhen = s.appliesWhen.trim();
  }
  return out;
}
