import { findPdfQuote, normalizeForQuoteMatch } from "../shared/fetch/pdf-text";
import type { GuidanceSnapshotContent } from "../guidance/types";
import type { RubricDiscardReason } from "../../types/rubric";

// ============================================
// RUBRIC — QUOTE AND NUMBER VALIDATION (issue #40)
// ============================================
//
// The rule this file enforces: NOTHING THE MODEL SAYS ABOUT THE SOURCE IS
// TRUSTED UNTIL CODE HAS FOUND IT IN THE STORED SNAPSHOT.
//
//  - A quote must appear VERBATIM in the snapshot of its own source. The only
//    tolerance is whitespace and the character normalisation the PDF reader
//    already applies to the stored text (ligatures, soft hyphens, exotic
//    spaces): `normalizeForQuoteMatch` from #33, applied to both sides. No
//    fuzzy matching, no case folding, no punctuation folding. A hyphen at a
//    line end is kept, exactly as #33 keeps it.
//  - In a PDF a quote must sit WITHIN ONE PAGE. A running header or footer
//    sits between two pages, so text "across" a break is not text the
//    publisher wrote as one passage, and a citation needs one page number.
//  - A number, duration or date the model states must be in the words it
//    quotes. A threshold with no number in its quote is an invented one.
//
// Pure functions over text: no Firebase, no model, no logging. Nothing here
// knows what any document is about.

/** Shortest quote accepted, in normalised characters. A two-word "quote"
 *  matches almost any document and so proves nothing. */
export const MIN_QUOTE_CHARS = 15;

/** Outcome of looking a quote up in a snapshot. */
export type QuoteLookup =
  | { ok: true; page?: number } // `page` for a PDF (1-based)
  | { ok: false; reason: Extract<RubricDiscardReason, "quote_empty" | "quote_too_short" | "quote_not_found" | "quote_spans_pages"> };

/**
 * One snapshot prepared for quote lookups: its text normalised once, so
 * checking many quotes against a long document does not re-normalise it.
 */
export class SnapshotQuoteIndex {
  /** Whole document, normalised (web page; also used for rule references). */
  private readonly normText: string;
  /** Per page, normalised, with its 1-based number (PDF only). */
  private readonly normPages: { page: number; text: string }[] | null;

  /** @param snapshot the stored snapshot (already hash-verified by the store). */
  constructor(readonly snapshot: GuidanceSnapshotContent) {
    this.normText = normalizeForQuoteMatch(snapshot.text);
    this.normPages = snapshot.pages ? snapshot.pages.map((p) => ({ page: p.page, text: normalizeForQuoteMatch(p.text) })) : null;
  }

  /**
   * Find a verbatim quote. For a PDF the quote must be inside a single page,
   * and the page number is returned; a quote that only matches across a page
   * break is reported as `quote_spans_pages`.
   */
  locate(quote: unknown): QuoteLookup {
    if (typeof quote !== "string") return { ok: false, reason: "quote_empty" };
    const needle = normalizeForQuoteMatch(quote);
    if (!needle) return { ok: false, reason: "quote_empty" };
    if (needle.length < MIN_QUOTE_CHARS) return { ok: false, reason: "quote_too_short" };

    if (!this.normPages) {
      return this.normText.includes(needle) ? { ok: true } : { ok: false, reason: "quote_not_found" };
    }
    // First page that holds the whole quote.
    for (const p of this.normPages) {
      if (p.text.includes(needle)) return { ok: true, page: p.page };
    }
    // Not within any one page. Tell "runs across a break" from "not there":
    // the #33 helper matches across pages and reports both ends.
    const across = findPdfQuote({ pages: (this.snapshot.pages ?? []).map((p) => p.text) }, quote);
    return { ok: false, reason: across ? "quote_spans_pages" : "quote_not_found" };
  }

  /** True when a short literal (a rule reference) appears in the document. */
  containsLiteral(literal: string): boolean {
    const needle = normalizeForQuoteMatch(literal);
    return needle.length > 0 && this.normText.includes(needle);
  }
}

/**
 * True when two passages overlap as text: one contains the other after
 * normalisation. Used to keep criteria from quoting a passage that was
 * flagged as addressed to the model.
 */
export function passagesOverlap(a: string, b: string): boolean {
  const x = normalizeForQuoteMatch(a);
  const y = normalizeForQuoteMatch(b);
  if (!x || !y) return false;
  return x.includes(y) || y.includes(x);
}

// ============================================
// Numbers
// ============================================

/**
 * Number words recognised next to digits, so "twenty-eight days" supports
 * the value 28. English only, on purpose: a number written as a word in
 * another language is simply not recognised, which REJECTS the criterion
 * (fails closed) rather than accepting an unverified number.
 */
const UNITS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
};
const TENS: Record<string, number> = {
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};

/** Canonical text of a number, so "1,000", "1000" and "1000.0" compare equal. */
function canonical(n: number): string {
  return String(n);
}

/**
 * Every number a text states, canonicalised: digit runs (thousands commas
 * dropped, decimals kept, the digits of an ordinal such as "28th") and
 * number words up to ninety-nine ("twenty-eight" yields 28, and also 20 and 8,
 * so either spelling of the claim is supported).
 */
export function numbersIn(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(/\d[\d,]*(?:\.\d+)?/g)) {
    const n = Number(m[0].replace(/,/g, ""));
    if (Number.isFinite(n)) out.add(canonical(n));
  }
  const words = text.toLowerCase().match(/[a-z]+/g) ?? [];
  words.forEach((w, i) => {
    if (w in UNITS) out.add(canonical(UNITS[w]));
    if (w in TENS) {
      out.add(canonical(TENS[w]));
      // "twenty eight" / "twenty-eight": the hyphen is not a letter, so the
      // two words are adjacent in `words`.
      const next = words[i + 1];
      if (next && next in UNITS && UNITS[next] >= 1 && UNITS[next] <= 9) out.add(canonical(TENS[w] + UNITS[next]));
    }
  });
  return out;
}

/**
 * The numbers `claim` states that `support` does not. Empty = every number
 * in the claim is backed by the supporting text.
 */
export function unsupportedNumbers(claim: string | number, support: string): string[] {
  const have = numbersIn(support);
  const want = typeof claim === "number" ? new Set([canonical(claim)]) : numbersIn(claim);
  return [...want].filter((n) => !have.has(n));
}

/**
 * True when an ISO date (YYYY-MM-DD) is backed by the supporting text: its
 * year and its day of the month both appear there as numbers. The month is
 * not checked (it is usually written as a word, in the source's language), so
 * this is a necessary test, not a sufficient one; the reviewer sees the quote.
 */
export function dateSupported(isoDate: string, support: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!m) return false;
  const have = numbersIn(support);
  return have.has(canonical(Number(m[1]))) && have.has(canonical(Number(m[3])));
}

/**
 * True when a duration unit ("days", "weeks", "months", "years") is written
 * in the supporting text, singular or plural. A unit that is not a duration
 * (a currency code, say) is not checked here and returns true.
 */
export function unitSupported(unit: string, support: string): boolean {
  const stem = /^(day|week|month|year)s?$/i.exec(unit.trim())?.[1];
  if (!stem) return true;
  return new RegExp(`\\b${stem}s?\\b`, "i").test(support);
}
