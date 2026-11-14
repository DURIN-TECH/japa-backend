import * as cheerio from "cheerio";
import { htmlFragmentToText, type FragmentTextOptions } from "../../shared/fetch/visa-catalog-fetch.service";
import { itemKey } from "../required-document-meta";

// ============================================
// GOV.UK GUIDE PARTS — DETERMINISTIC ITEM COLLECTOR (issue #212)
// ============================================
//
// The adapter's plain text has no list structure (items are just blank-line
// paragraphs), so the checklist coverage check reads the page's own HTML:
// every `<li>` that sits under a recognised "you'll need to provide:" lead-in
// is one item the applicant is asked to provide. The extractor (a model) can
// silently skip some of them; this collector is what proves it.
//
// Two shapes are collected, both verbatim from the page and both only inside
// a part that HAS a document list (so a sentence in an unrelated part is
// never mistaken for a requirement):
//   1. LIST items: a `<p>` whose text is a recognised lead-in (ends with ":")
//      directly followed by a `<ul>` / `<ol>`; one entry per `<li>`.
//   2. PROSE requirements (orchestrator decision on #212): a sentence stated
//      as "You must have ..." in a `<p>` of such a part,
//      e.g. Standard Visitor's "You must have a passport or travel document
//      that is valid for the whole of your stay in the UK."
//   3. REQUIREMENT-WITH-EXCEPTIONS sentences (issue #276): a `<p>` that states
//      the requirement itself and then lists only the EXCEPTIONS,
//      "<who> will need to provide <X>, unless both of the following are true:"
//      followed by a `<ul>` / `<ol>`. The item is <X>, a verbatim span of the
//      sentence (BN(O)'s "evidence that their home address is the same as
//      yours"); the sentence travels with it as `quote`. The listed exceptions
//      are conditions, not items, and are never collected.
//
// PURE: no Firebase, no network (adapter modules must stay importable without
// Admin init, see adapters/types.ts).

/** One item the page lists for the applicant to provide. */
export interface PageListItem {
  /** The item's text exactly as the page shows it (apply links as `text (url)`), whitespace collapsed. */
  text: string;
  /** The lead-in it sits under, verbatim; "" for a prose requirement (it has no lead-in). */
  leadIn: string;
  /** The part slug it was found in (e.g. "documents-you-must-provide"). */
  section: string;
  /**
   * Issue #276: the whole verbatim sentence, set only when `text` is a SPAN of
   * a sentence (shape 3). Used as the appended item's citation quote and kind
   * quote, so its "unless ..." condition is kept. Absent for shapes 1 and 2
   * (there the item text is the whole `<li>` / sentence).
   */
  quote?: string;
}

/** One guide part as the collector needs it: slug + HTML body. */
export interface CollectorPart {
  slug: string;
  html: string;
}

// ----- Lead-in recognition -----

/**
 * A lead-in is recognised when its NORMALISED text (curly quotes unified,
 * whitespace collapsed, lower-case) matches this. The rule: the clause must END
 * right after `provide` (optionally `either`, or `the following information in
 * your online application`); a leading "When you apply ..." and/or
 * "Depending on your circumstances, ..." clause is allowed. The eight lead-ins
 * on the recorded golden guides all match; the long ones that only CONTAIN the
 * word ("You'll need to provide a criminal record certificate if ... work in:",
 * "You'll need to provide evidence of their address, such as:") do not, and
 * neither do "You'll also need to:" / "... give details of:" (see #212).
 */
const LEAD_IN_RE =
  /^(?:when you apply(?: for your [^:,]+?)?,? )?(?:depending on your circumstances, )?you(?:'ll| must| may| might)(?: also)?(?: need to| be asked to)? provide(?: either| the following information in your online application)?:$/;

/** True when `text` is a recognised "provide" lead-in (see LEAD_IN_RE). */
export function isRecognisedLeadIn(text: string): boolean {
  return LEAD_IN_RE.test(itemKey(text));
}

// A prose requirement sentence starts "You must have ...". The groomed wording
// also named "You'll need ...", but on the recorded guides every such sentence
// in a document part is NOT a document ("You'll need an email address ...",
// "You'll need to show you can meet the financial requirements ...", "You'll
// need to give details of your children ..."; UK Family alone has five), so only
// "You must have" is collected (Standard Visitor's passport sentence is the case).
const PROSE_CUE_RE = /^you must have /i;

// Shape 3 (issue #276). A sentence that is itself the requirement and ends by
// introducing the EXCEPTIONS list:
//   "Your family members (‘dependants’) will need to provide evidence that their
//    home address is the same as yours, unless both of the following are true:"
// Group 1 is the item, verbatim. Deliberately narrow:
//   - "will need to provide" / "'ll need to provide" (the provide verb the
//     lead-ins use), so "You'll need to show ..." / "must apply ..." never match;
//   - the object ends at ", unless <both|either|all|any|one|each> of the
//     following is/are true:". Sentences whose list is the thing to provide,
//     or whose "unless" names something else ("..., unless your job is in one
//     of the following occupation codes:", Health and Care Worker) do not
//     match: their list is not a set of exceptions of this shape.
// On every recorded guide (the six golden guides, Health and Care Worker and
// BN(O)) only the BN(O) home-address sentence matches.
const REQUIREMENT_UNLESS_RE =
  /^[^.:]*?(?:\bwill|['\u2019]ll) need to provide (.+?), unless (?:both|either|all|any|one|each) of the following (?:is|are) true:$/i;

/**
 * The item a shape-3 sentence asks for (verbatim span), or null when `text`
 * is not that shape. Exported for tests.
 */
export function requirementWithExceptions(text: string): string | null {
  const m = REQUIREMENT_UNLESS_RE.exec(text);
  const item = m?.[1]?.trim();
  return item ? item : null;
}

/** Collapse whitespace in text taken from HTML. */
function collapse(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/**
 * Split a paragraph's text into sentences at ". " boundaries (a full stop
 * followed by whitespace). Good enough for the cue test: the cue only has to
 * find the sentence that starts with "You must have ...".
 */
function sentences(text: string): string[] {
  return text.split(/(?<=\.)\s+/).map((s) => s.trim()).filter(Boolean);
}

/**
 * Collect the page's items from `parts` (the SELECTED parts, in order).
 *
 * @param parts      slug + HTML body of each selected part
 * @param textOpts   the same `htmlFragmentToText` options the adapter used for the
 *                   part text (so apply-service links read `text (url)` exactly as
 *                   the model saw them)
 * @param sentText   the (capped) text handed to the extractor. An item that does not
 *                   occur in it is NOT collected: a truncated document never blames
 *                   the model for text it was not shown.
 * @returns items in page order, de-duplicated by normalised text
 */
export function collectPageItems(
  parts: CollectorPart[],
  textOpts: FragmentTextOptions,
  sentText: string
): PageListItem[] {
  const seenText = itemKey(sentText);
  const out: PageListItem[] = [];
  const seen = new Set<string>();

  /** Add one item unless it was cut from the sent text or is a repeat. */
  const add = (item: PageListItem) => {
    const key = itemKey(item.text);
    if (!key || seen.has(key) || !seenText.includes(key)) return;
    // A span item (shape 3) also needs its whole sentence in the sent text: the
    // sentence is what the appended citation quotes.
    if (item.quote && !seenText.includes(itemKey(item.quote))) return;
    seen.add(key);
    out.push(item);
  };

  for (const part of parts) {
    const $ = cheerio.load(part.html);
    // The part's list items, then (only if there were any) its prose sentences,
    // both in document order so the result reads like the page.
    const listItems: PageListItem[] = [];
    $("p").each((_, p) => {
      const leadIn = collapse(htmlFragmentToText($.html(p), textOpts));
      if (!leadIn.endsWith(":") || !isRecognisedLeadIn(leadIn)) return;
      // The list must DIRECTLY follow the lead-in paragraph.
      const next = $(p).next();
      if (!next.is("ul, ol")) return;
      next.children("li").each((__, li) => {
        const text = collapse(htmlFragmentToText($.html(li), textOpts));
        if (text) listItems.push({ text, leadIn, section: part.slug });
      });
    });
    if (listItems.length === 0) continue; // no document list in this part: no prose rule either
    // Prose requirements, interleaved by document order of the <p>s.
    const prose: PageListItem[] = [];
    $("p").each((_, p) => {
      const text = collapse(htmlFragmentToText($.html(p), textOpts));
      if (text.endsWith(":")) {
        // Shape 3 (issue #276): a requirement sentence that introduces its
        // exceptions list. The list must DIRECTLY follow (same rule as lead-ins);
        // its <li>s are the exceptions and are not collected.
        const item = requirementWithExceptions(text);
        if (item && $(p).next().is("ul, ol")) prose.push({ text: item, leadIn: "", section: part.slug, quote: text });
        return; // otherwise a lead-in line, not a sentence
      }
      for (const s of sentences(text)) {
        if (PROSE_CUE_RE.test(s)) prose.push({ text: s, leadIn: "", section: part.slug });
      }
    });
    // Prose first: a sentence above the lists ("You must have a passport ...")
    // reads before them on the page.
    for (const it of [...prose, ...listItems]) add(it);
  }
  return out;
}
