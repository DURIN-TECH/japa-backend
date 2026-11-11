import { normalizeForQuoteMatch } from "../shared/fetch/pdf-text";
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
//  - A match must START AND END ON A TOKEN BOUNDARY: it may not begin or end
//    in the middle of a word or of a number. Otherwise "eligible ..." could
//    be quoted out of "ineligible ...", and "28 days" out of "128 days".
//  - A quote must be ONE passage: within one page of a PDF (a running header
//    sits between two pages, and a citation needs one page number), and
//    within one line of a web page's cleaned text (one line is one block of
//    the page: a paragraph, a list item, a heading).
//  - A number, duration, unit, date or group name the model states must be in
//    the words of the criterion's OWN quote. A threshold with no number in
//    its quote is an invented one.
//
// What it cannot do: tell whether a verbatim, token-bounded quote still
// MEANS what the source means. A quote that starts just after a negation
// ("required to ..." taken from "is not required to ...") passes every check
// here. A human reviewer must read each quote in its source context (see the
// module README).
//
// Pure functions over text: no Firebase, no model, no logging. Nothing here
// knows what any document is about.

/** Shortest quote accepted, in normalised characters. A two-word "quote"
 *  matches almost any document and so proves nothing. */
export const MIN_QUOTE_CHARS = 15;

/** How far before a quote (same PDF page) its rule reference may sit. */
export const RULE_REF_WINDOW_CHARS = 300;

/** Shortest group name accepted in `appliesTo.asWritten`. */
export const MIN_GROUP_NAME_CHARS = 3;

/** Outcome of looking a quote up in a snapshot. */
export type QuoteLookup =
  | {
      ok: true;
      // 1-based page, for a PDF.
      page?: number;
      // The passage AS THE SOURCE HAS IT (normalised form): what gets stored,
      // so nothing invisible in the model's copy can ride along.
      matched: string;
      // Where it was found: index of the unit (page or line) and the offset
      // of the match inside that unit's normalised text.
      unit: number;
      at: number;
    }
  | { ok: false; reason: Extract<RubricDiscardReason, "quote_empty" | "quote_too_short" | "quote_not_found" | "quote_spans_pages" | "quote_spans_paragraphs"> };

// ============================================
// Token-bounded search
// ============================================

/** True for a letter or a digit in any script. */
function isWordChar(ch: string | undefined): boolean {
  return ch !== undefined && /[\p{L}\p{N}]/u.test(ch);
}

/**
 * Characters that continue one written token across a boundary: a hyphen, an
 * apostrophe (both the ASCII and the typographic form), a percent sign, a
 * plus sign and a slash. They join the parts of one token
 * ("non-Bordurian", "applicant's", "20%", "+44", "and/or"), so a match may
 * not start or end inside one. Without this, "Bordurian" is quoted out of
 * "non-Bordurian" (the inverse of the rule), "eight days" out of
 * "twenty-eight days" (a false threshold), and "applicant" out of
 * "applicant's" (code review round 2, B1/B4/B6).
 */
const TOKEN_JOINERS = new Set(["-", "'", "’", "%", "+", "/"]);

/** True for a character that is part of a token: a word character or a joiner. */
function isTokenChar(ch: string | undefined): boolean {
  return isWordChar(ch) || (ch !== undefined && TOKEN_JOINERS.has(ch));
}

/** True for an ASCII digit. */
function isDigit(ch: string | undefined): boolean {
  return ch !== undefined && ch >= "0" && ch <= "9";
}

/**
 * True when the occurrence of `needle` at `at` in `hay` starts and ends on a
 * token boundary:
 *  - if the needle starts (ends) with a token character, the character before
 *    (after) it must not be one either. A token runs through letters, digits
 *    and the joiners hyphen, apostrophe, `%`, `+` and `/`, so a match cannot
 *    begin or end inside "non-Bordurian", "applicant's", "20%", "+44" or
 *    "and/or";
 *  - if it starts (ends) with a digit, it must not continue a number through
 *    a separator either ("028" out of "1,028", "1" out of "1.5"), and it may
 *    not start (end) with that separator between two digits.
 */
function onTokenBoundary(hay: string, at: number, needle: string): boolean {
  const end = at + needle.length;
  const first = needle[0];
  const last = needle[needle.length - 1];
  if (isTokenChar(first) && isTokenChar(hay[at - 1])) return false;
  if (isTokenChar(last) && isTokenChar(hay[end])) return false;
  if (isDigit(first) && (hay[at - 1] === "," || hay[at - 1] === ".") && isDigit(hay[at - 2])) return false;
  if (isDigit(last) && (hay[end] === "," || hay[end] === ".") && isDigit(hay[end + 1])) return false;
  // The same cut made one character over: a needle that starts (ends) with
  // the separator itself, between two digits (".2" out of "3.2").
  const sep = (ch: string | undefined) => ch === "," || ch === ".";
  if (sep(first) && isDigit(needle[1]) && isDigit(hay[at - 1])) return false;
  if (sep(last) && isDigit(needle[needle.length - 2]) && isDigit(hay[end])) return false;
  return true;
}

/**
 * Every position where `needle` occurs in `hay` on token boundaries. Both
 * must already be in the same normalised form. Exact, case-sensitive.
 */
export function tokenBoundedPositions(hay: string, needle: string): number[] {
  const out: number[] = [];
  if (!needle) return out;
  for (let at = hay.indexOf(needle); at >= 0; at = hay.indexOf(needle, at + 1)) {
    if (onTokenBoundary(hay, at, needle)) out.push(at);
  }
  return out;
}

/**
 * True when `literal` occurs in `text` verbatim and on token boundaries
 * (whitespace-normalised on both sides, case-sensitive).
 */
export function containsTokenBounded(text: string, literal: string): boolean {
  return tokenBoundedPositions(normalizeForQuoteMatch(text), normalizeForQuoteMatch(literal)).length > 0;
}

// ============================================
// Snapshot index
// ============================================

/**
 * One snapshot prepared for quote lookups: its text normalised once, so
 * checking many quotes against a long document does not re-normalise it.
 */
export class SnapshotQuoteIndex {
  /**
   * The units a quote must fit inside, normalised: the pages of a PDF, or
   * the lines of a web page's cleaned text.
   */
  private readonly units: { page?: number; text: string }[];
  /** All units joined with one space (to tell "spans a boundary" from "absent"). */
  private readonly joined: string;
  /** True for a PDF snapshot. */
  private readonly paginated: boolean;

  /** @param snapshot the stored snapshot (already hash-verified by the store). */
  constructor(readonly snapshot: GuidanceSnapshotContent) {
    this.paginated = Array.isArray(snapshot.pages);
    this.units = snapshot.pages
      ? snapshot.pages.map((p) => ({ page: p.page, text: normalizeForQuoteMatch(p.text) }))
      : snapshot.text.split(/\n+/).map((line) => ({ text: normalizeForQuoteMatch(line) }));
    this.joined = this.units.map((u) => u.text).filter(Boolean).join(" ");
  }

  /**
   * Find a verbatim, token-bounded quote inside ONE unit (page or line). The
   * first unit holding it wins. A quote that only matches across a boundary
   * is reported as `quote_spans_pages` / `quote_spans_paragraphs`.
   */
  locate(quote: unknown): QuoteLookup {
    if (typeof quote !== "string") return { ok: false, reason: "quote_empty" };
    const needle = normalizeForQuoteMatch(quote);
    if (!needle) return { ok: false, reason: "quote_empty" };
    if (needle.length < MIN_QUOTE_CHARS) return { ok: false, reason: "quote_too_short" };

    for (let unit = 0; unit < this.units.length; unit++) {
      const u = this.units[unit];
      const [at] = tokenBoundedPositions(u.text, needle);
      if (at !== undefined) {
        // `matched` is cut from the SOURCE's normalised text. It equals the
        // normalised needle (the match is exact), but taking it from the
        // source makes the provenance of the stored quote unarguable.
        return { ok: true, ...(u.page !== undefined ? { page: u.page } : {}), matched: u.text.slice(at, at + needle.length), unit, at };
      }
    }
    // Not within any one unit: does it run across a boundary, or is it absent?
    if (tokenBoundedPositions(this.joined, needle).length > 0) {
      return { ok: false, reason: this.paginated ? "quote_spans_pages" : "quote_spans_paragraphs" };
    }
    return { ok: false, reason: "quote_not_found" };
  }

  /**
   * True when a rule reference is printed WITH the located quote: inside the
   * quote itself, or shortly before it in the same unit (earlier on the same
   * line of a web page; within RULE_REF_WINDOW_CHARS before it on a PDF
   * page). A reference that merely exists somewhere else in the document
   * belongs to another rule and is refused.
   */
  ruleRefNear(found: Extract<QuoteLookup, { ok: true }>, ruleRef: string): boolean {
    const needle = normalizeForQuoteMatch(ruleRef);
    // A reference must have something to it: one stray character matches anywhere.
    if (needle.length < 2 || !/[\p{L}\p{N}]/u.test(needle)) return false;
    const text = this.units[found.unit].text;
    const quoteEnd = found.at + found.matched.length;
    const earliest = this.paginated ? found.at - RULE_REF_WINDOW_CHARS : 0;
    return tokenBoundedPositions(text, needle).some((p) => p >= earliest && p + needle.length <= quoteEnd);
  }

  /**
   * True when the located quote begins PART-WAY THROUGH A SENTENCE of the
   * source: there are ordinary words between the previous sentence end (or
   * the start of the line / page) and the quote. Words before a quote can
   * turn its meaning round ("is not" before "required to ..."), and code
   * cannot judge that, so the caller raises a reviewer flag. A paragraph
   * number or list label in front of the quote ("3.2", "(a)") is not
   * "words" and does not count.
   */
  startsMidSentence(found: Extract<QuoteLookup, { ok: true }>): boolean {
    const before = this.units[found.unit].text.slice(0, found.at);
    // What follows the last sentence-ending mark that is followed by a space.
    const lead = before.split(/[.!?:;]\s/u).pop() ?? "";
    // "Ordinary words": a run of two or more lower-case letters.
    return /\p{Ll}{2,}/u.test(lead);
  }

  /**
   * The source text just before and just after a located quote, for a
   * reviewer to read the quote in context (issue #125): a quote that begins
   * after a negation cannot be caught in code, so a person must see the words
   * around it. BOUNDED twice over: it never leaves the quote's own unit (the
   * line of a web page, the page of a PDF) and never returns more than
   * `maxChars` on either side. It can therefore never return a whole
   * snapshot. `truncated*` say whether the unit holds more text that way.
   */
  contextAround(found: Extract<QuoteLookup, { ok: true }>, maxChars: number): { before: string; after: string; truncatedBefore: boolean; truncatedAfter: boolean } {
    const text = this.units[found.unit].text;
    const quoteEnd = found.at + found.matched.length;
    const from = Math.max(0, found.at - Math.max(0, maxChars));
    const to = Math.min(text.length, quoteEnd + Math.max(0, maxChars));
    return { before: text.slice(from, found.at), after: text.slice(quoteEnd, to), truncatedBefore: from > 0, truncatedAfter: to < text.length };
  }

  /** True when a literal appears in the document, verbatim and token-bounded. */
  containsLiteral(literal: string): boolean {
    return tokenBoundedPositions(this.joined, normalizeForQuoteMatch(literal)).length > 0;
  }
}

/**
 * True when two passages overlap as text: one contains the other after
 * normalisation. Used to keep criteria from quoting a passage that was
 * flagged as addressed to the model. Deliberately NOT token-bounded: any
 * overlap with a flagged passage is enough to refuse.
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
//
// What is recognised as a number, on BOTH sides of a comparison (the claim
// and the quote that must support it):
//  - ASCII digit runs: a plain integer, an integer with thousands commas
//    ("1,270"), either with a decimal point ("1,270.50"). Compatibility forms
//    (full-width digits and the like) are folded to ASCII first (NFKC).
//  - English number words, read as ONE number per run: "twenty-eight" is 28
//    (not also 20 and 8), "two hundred and fifty" is 250, "5 thousand" is
//    5000.
//
// What is NOT recognised, and what then happens:
//  - a digit run in any other shape ("1.000,50", "10,20") yields no number;
//  - digits of another script that NFKC does not fold yield no number, and a
//    CLAIM containing them is reported as unsupported outright;
//  - number words in other languages yield no number;
//  - a lone "one" is a number only before a duration unit ("one month"),
//    because it is usually a pronoun ("no one may apply").
// An unrecognised number in the QUOTE can never support a claim, and a claim
// whose number is unrecognised is rejected by the callers' rules (a
// threshold must be a JSON number; see rubric-validate.ts). So every gap
// above ends in a rejection, never in an accepted, unverified number.

/** Number words below one hundred. */
const UNITS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
};
const TENS: Record<string, number> = {
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};
/** Multiplier words. */
const SCALES: Record<string, number> = { hundred: 100, thousand: 1_000, million: 1_000_000, billion: 1_000_000_000 };
/** Words after which a lone "one" is a quantity. */
const DURATION_WORD_RE = /^(day|week|month|year)s?$/;

/** Marker returned by `unsupportedNumbers` for a claim with unreadable digits. */
export const UNREADABLE_DIGITS = "unreadable-digits";

/** The form numbers and dates are read from: compatibility-folded, lower case. */
function readable(text: string): string {
  return text.normalize("NFKC").toLowerCase();
}

/** True when a text still holds a decimal digit that is not ASCII after folding. */
export function hasUnreadableDigits(text: string): boolean {
  return /(?![0-9])\p{Nd}/u.test(text.normalize("NFKC"));
}

/** Canonical text of a number, so "1,000", "1000" and "1000.0" compare equal. */
function canonical(n: number): string {
  return String(n);
}

/** Value of a digit run, or undefined when it is not in a recognised shape. */
function parseDigitRun(run: string): number | undefined {
  if (!/^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/.test(run)) return undefined;
  const n = Number(run.replace(/,/g, ""));
  return Number.isFinite(n) ? n : undefined;
}

/** One number found in a text, with where it is (offsets in the folded text). */
interface NumberToken {
  value: number;
  start: number;
  end: number;
}

/** Every number a text states, in order (see the section header for the rules). */
function numberTokens(text: string): NumberToken[] {
  const folded = readable(text);
  // Words and digit runs, with their positions. A digit run ends on a digit,
  // so sentence punctuation after it is not part of it.
  const raw = [...folded.matchAll(/\p{L}+|\d[\d.,]*\d|\d/gu)].map((m) => ({ text: m[0], start: m.index as number, end: (m.index as number) + m[0].length }));
  /** True when only spaces / hyphens separate token i from token i+1. */
  const adjacent = (i: number) => i + 1 < raw.length && /^[\s-]*$/.test(folded.slice(raw[i].end, raw[i + 1].start));
  const out: NumberToken[] = [];

  let i = 0;
  while (i < raw.length) {
    const tok = raw[i];
    // ---- digits, optionally scaled by following words ("5 thousand") ----
    if (isDigit(tok.text[0])) {
      let value = parseDigitRun(tok.text);
      let end = tok.end;
      let j = i;
      while (value !== undefined && adjacent(j) && raw[j + 1].text in SCALES) {
        value *= SCALES[raw[j + 1].text];
        end = raw[j + 1].end;
        j++;
      }
      if (value !== undefined) out.push({ value, start: tok.start, end });
      i = j + 1;
      continue;
    }
    // ---- a run of number words, read as one number ----
    if (!(tok.text in UNITS) && !(tok.text in TENS) && !(tok.text in SCALES)) {
      i++;
      continue;
    }
    let total = 0; // completed thousands / millions groups
    let current = 0; // the group being built (below one thousand)
    let lastUsed = i; // last token that is part of this number
    let j = i;
    while (j < raw.length) {
      const w = raw[j].text;
      if (w in SCALES) {
        if (SCALES[w] === 100) current = (current || 1) * 100;
        else {
          total += (current || 1) * SCALES[w];
          current = 0;
        }
      } else if (w in UNITS || w in TENS) {
        const v = w in UNITS ? UNITS[w] : TENS[w];
        const low = current % 100;
        // A small number may open a group, or a unit may complete a tens
        // word ("twenty" + "eight"). Anything else ("one two", "eight
        // twenty") starts a NEW number: stop this one before it.
        const fits = low === 0 || (v >= 1 && v <= 9 && low >= 20 && low % 10 === 0);
        if (!fits) break;
        current += v;
      } else {
        break; // not a number word: the run is over
      }
      lastUsed = j;
      if (!adjacent(j)) break;
      // Step over "and" only inside a number ("two hundred and fifty").
      const afterAnd = raw[j + 2]?.text;
      if (raw[j + 1].text === "and" && total + current >= 100 && adjacent(j + 1) && afterAnd !== undefined && (afterAnd in UNITS || afterAnd in TENS)) j += 2;
      else j++;
    }
    // A lone "one" is usually a pronoun: a quantity only before a duration.
    const loneOne = lastUsed === i && tok.text === "one";
    const beforeDuration = adjacent(i) && DURATION_WORD_RE.test(raw[i + 1].text);
    if (!loneOne || beforeDuration) out.push({ value: total + current, start: tok.start, end: raw[lastUsed].end });
    i = lastUsed + 1;
  }
  return out;
}

/** Every number a text states, canonicalised. */
export function numbersIn(text: string): Set<string> {
  return new Set(numberTokens(text).map((t) => canonical(t.value)));
}

/**
 * The numbers a text states OUTSIDE its date expressions. A threshold must
 * not be "supported" by the day or the year of a date in the same sentence.
 */
export function numbersOutsideDates(text: string): Set<string> {
  const dates = dateSpans(text);
  return new Set(
    numberTokens(text)
      .filter((t) => !dates.some((d) => t.start < d.end && t.end > d.start))
      .map((t) => canonical(t.value))
  );
}

/**
 * The numbers `claim` states that `support` does not. Empty = every number
 * in the claim is backed by the supporting text. A claim holding digits that
 * cannot be read is reported as unsupported (UNREADABLE_DIGITS).
 *
 * @param opts.outsideDates ignore numbers that are part of a date in `support`
 *   (used for thresholds; a title may repeat a date's numbers)
 */
export function unsupportedNumbers(claim: string | number, support: string, opts: { outsideDates?: boolean } = {}): string[] {
  const have = opts.outsideDates ? numbersOutsideDates(support) : numbersIn(support);
  if (typeof claim === "number") return Number.isFinite(claim) && have.has(canonical(claim)) ? [] : [canonical(claim)];
  if (hasUnreadableDigits(claim)) return [UNREADABLE_DIGITS];
  return [...numbersIn(claim)].filter((n) => !have.has(n));
}

// ============================================
// Dates
// ============================================

/** English month names and abbreviations -> month number. */
const MONTHS: Record<string, number> = {
  january: 1, jan: 1, february: 2, feb: 2, march: 3, mar: 3, april: 4, apr: 4, may: 5, june: 6, jun: 6, july: 7, jul: 7,
  august: 8, aug: 8, september: 9, sep: 9, sept: 9, october: 10, oct: 10, november: 11, nov: 11, december: 12, dec: 12,
};
/** Alternation of the month words, longest first so "march" wins over "mar". */
const MONTH_ALT = Object.keys(MONTHS).sort((a, b) => b.length - a.length).join("|");

/** `YYYY-MM-DD` for a real calendar date, else null. */
function isoOf(year: number, month: number, day: number): string | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const d = new Date(Date.UTC(year, month - 1, day));
  // An impossible date (31 February) rolls over: refuse it.
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return null;
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** One date expression in a text. `iso` is null when it cannot be read with certainty. */
interface DateSpan {
  iso: string | null;
  start: number;
  end: number;
}

/**
 * Every date expression in a text (offsets in the folded text). Recognised:
 *   "26 March 2026", "26th of Mar 2026"      day, month word, year
 *   "March 26, 2026"                         month word, day, year
 *   "2026-03-26"                             ISO
 *   "26/03/2026", "26.03.2026"               numeric, ONLY when day and month
 *                                            cannot be swapped (one of them
 *                                            is above 12, or they are equal);
 *                                            an ambiguous one is a date span
 *                                            that supports no date
 * Month words are English; a date written otherwise is not recognised, and
 * then supports nothing.
 */
function dateSpans(text: string): DateSpan[] {
  const folded = readable(text);
  const spans: DateSpan[] = [];
  const push = (m: RegExpMatchArray, iso: string | null) => spans.push({ iso, start: m.index as number, end: (m.index as number) + m[0].length });
  for (const m of folded.matchAll(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?(?:\\s+of)?\\s+(${MONTH_ALT})\\b\\.?,?\\s+(\\d{4})\\b`, "g"))) {
    push(m, isoOf(Number(m[3]), MONTHS[m[2]], Number(m[1])));
  }
  for (const m of folded.matchAll(new RegExp(`\\b(${MONTH_ALT})\\b\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})\\b`, "g"))) {
    push(m, isoOf(Number(m[3]), MONTHS[m[1]], Number(m[2])));
  }
  for (const m of folded.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) {
    push(m, isoOf(Number(m[1]), Number(m[2]), Number(m[3])));
  }
  for (const m of folded.matchAll(/\b(\d{1,2})[/.](\d{1,2})[/.](\d{4})\b/g)) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    const year = Number(m[3]);
    // Day-first or month-first? Only decidable when one part cannot be a month.
    if (a > 12 && b <= 12) push(m, isoOf(year, b, a));
    else if (b > 12 && a <= 12) push(m, isoOf(year, a, b));
    else if (a === b) push(m, isoOf(year, a, a));
    else push(m, null);
  }
  return spans;
}

/** The dates (YYYY-MM-DD) a text states unambiguously. */
export function datesIn(text: string): string[] {
  return [...new Set(dateSpans(text).map((d) => d.iso).filter((d): d is string => d !== null))];
}

/**
 * True when an ISO date (YYYY-MM-DD) is a real calendar date AND the
 * supporting text states that same date in ONE date expression (day, month
 * and year together). Scattered numbers that happen to include the day and
 * the year do not count.
 */
export function dateSupported(isoDate: string, support: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!m) return false;
  const iso = isoOf(Number(m[1]), Number(m[2]), Number(m[3]));
  return iso !== null && datesIn(support).includes(iso);
}

// ============================================
// Units and group names
// ============================================

/**
 * True when a unit is written in the supporting text exactly as given
 * (verbatim, token-bounded, case-sensitive). Every unit is checked, not only
 * durations: "days" needs "days" in the quote, a currency code needs that
 * code in the quote.
 */
export function unitSupported(unit: string, support: string): boolean {
  return normalizeForQuoteMatch(unit).length > 0 && containsTokenBounded(support, unit);
}

/**
 * True when a group name (an entry of `appliesTo.asWritten`) is written in
 * the supporting text as a WHOLE name:
 *  - verbatim and token-bounded (so not the first letters of a longer word);
 *  - at least MIN_GROUP_NAME_CHARS long (a single letter matches anything);
 *  - not a part of a longer capitalised name at that position: a capitalised
 *    word directly before or after it (joined by a space or a hyphen) makes
 *    it a different name. This also refuses a real name that happens to
 *    follow a capitalised word (the first word of a sentence, say); that is
 *    the safe direction, and the reviewer sees the discard.
 */
export function groupNameSupported(name: string, support: string): boolean {
  const needle = normalizeForQuoteMatch(name);
  if (needle.length < MIN_GROUP_NAME_CHARS) return false;
  const hay = normalizeForQuoteMatch(support);
  return tokenBoundedPositions(hay, needle).some((at) => {
    const before = /(\p{L}+)[ -]$/u.exec(hay.slice(0, at))?.[1];
    const after = /^[ -](\p{L}+)/u.exec(hay.slice(at + needle.length))?.[1];
    const capitalised = (word: string | undefined) => word !== undefined && /^\p{Lu}/u.test(word);
    return !capitalised(before) && !capitalised(after);
  });
}
