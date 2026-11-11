// ============================================
// GUIDANCE — PUBLISHER-REPORTED DATE (issue #39)
// ============================================
//
// Guidance documents usually say when they were published or last updated
// ("published for staff on <date>", "Last updated: <date>"). Capturing that
// date makes drift visible: a document whose text and date both moved was
// re-issued; one whose text moved while the date stood still was edited
// quietly.
//
// Where the date sits is DATA, not code: each registry entry may carry a
// `publishedDateSelector`, a regular expression applied to the document's
// cleaned text whose first capture group is the date as written. Nothing here
// knows any publisher's wording. Pure functions, no I/O.

/** Longest selector accepted (a guard against a runaway pattern in the data). */
export const MAX_PUBLISHED_DATE_SELECTOR_CHARS = 300;

/** Longest date text kept from a match (a date is short; anything longer is a bad selector). */
export const MAX_PUBLISHED_DATE_TEXT_CHARS = 80;

/** English month names and their common abbreviations -> month number. */
const MONTHS: Record<string, number> = {
  january: 1, jan: 1,
  february: 2, feb: 2,
  march: 3, mar: 3,
  april: 4, apr: 4,
  may: 5,
  june: 6, jun: 6,
  july: 7, jul: 7,
  august: 8, aug: 8,
  september: 9, sep: 9, sept: 9,
  october: 10, oct: 10,
  november: 11, nov: 11,
  december: 12, dec: 12,
};

/** The publisher's date as found in a document. */
export interface PublishedDate {
  // ISO calendar date (YYYY-MM-DD) when the text could be parsed, else null.
  publishedDate: string | null;
  // The matched text exactly as written (trimmed, whitespace collapsed).
  publishedDateText: string;
}

/**
 * Why a selector is unusable, or undefined when it is fine. Used by the seed
 * validator so a bad pattern is refused at seeding time, not on every crawl.
 */
export function publishedDateSelectorProblem(selector: string): string | undefined {
  if (!selector.trim()) return "publishedDateSelector is empty";
  if (selector.length > MAX_PUBLISHED_DATE_SELECTOR_CHARS) {
    return `publishedDateSelector is longer than ${MAX_PUBLISHED_DATE_SELECTOR_CHARS} characters`;
  }
  let re: RegExp;
  try {
    re = new RegExp(selector, "i");
  } catch (err) {
    return `publishedDateSelector is not a valid regular expression: ${(err as Error).message}`;
  }
  // The date is read from capture group 1, so there must be one. Matching the
  // pattern against "" with an alternative that always succeeds reveals how
  // many groups it declares.
  const groups = (new RegExp(`${re.source}|`).exec("")?.length ?? 1) - 1;
  if (groups < 1) return "publishedDateSelector needs a capture group around the date";
  return undefined;
}

/** True when y-m-d is a real calendar date. */
function isRealDate(y: number, m: number, d: number): boolean {
  if (!(y >= 1900 && y <= 2200 && m >= 1 && m <= 12 && d >= 1 && d <= 31)) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** Format a checked y-m-d as YYYY-MM-DD. */
function iso(y: number, m: number, d: number): string {
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/**
 * Parse a date as a publisher writes it into an ISO calendar date, or null
 * when the form is not recognised. Recognised, in any letter case:
 *  - `2025-11-11` (ISO, optionally followed by a time);
 *  - `11 November 2025`, `11th Nov 2025`, `11 November, 2025`;
 *  - `November 11, 2025`, `Nov 11 2025`.
 * Purely numeric day/month forms such as `11/12/2025` are NOT guessed at:
 * which number is the month depends on the publisher, and a wrong date is
 * worse than none. The raw text is kept either way.
 */
export function parsePublishedDate(text: string): string | null {
  const t = text.trim().replace(/\s+/g, " ");

  // ISO date at the start (a trailing time or zone is ignored).
  let m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ].*)?$/.exec(t);
  if (m) {
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    return isRealDate(y, mo, d) ? iso(y, mo, d) : null;
  }

  // Day Month Year.
  m = /^(\d{1,2})(?:st|nd|rd|th)? ([A-Za-z]+)\.?,? (\d{4})$/.exec(t);
  if (m) {
    const [d, mo, y] = [Number(m[1]), MONTHS[m[2].toLowerCase()], Number(m[3])];
    return mo && isRealDate(y, mo, d) ? iso(y, mo, d) : null;
  }

  // Month Day, Year.
  m = /^([A-Za-z]+)\.? (\d{1,2})(?:st|nd|rd|th)?,? (\d{4})$/.exec(t);
  if (m) {
    const [mo, d, y] = [MONTHS[m[1].toLowerCase()], Number(m[2]), Number(m[3])];
    return mo && isRealDate(y, mo, d) ? iso(y, mo, d) : null;
  }

  return null;
}

/**
 * Find the publisher's date in a document's cleaned text.
 *
 * @param cleanText the document's cleaned text (for a PDF: all pages)
 * @param selector  the registry entry's `publishedDateSelector`, if any
 * @returns the date found, or null when the entry has no selector, the
 *   selector is unusable, or it does not match. Never throws: a missing date
 *   must not fail a crawl.
 */
export function extractPublishedDate(cleanText: string, selector: string | undefined | null): PublishedDate | null {
  if (!selector || publishedDateSelectorProblem(selector)) return null;
  // Case-insensitive: publishers vary the capitalisation of the lead-in.
  const match = new RegExp(selector, "i").exec(cleanText);
  const raw = match?.[1];
  if (!raw) return null;
  const publishedDateText = raw.trim().replace(/\s+/g, " ").slice(0, MAX_PUBLISHED_DATE_TEXT_CHARS);
  if (!publishedDateText) return null;
  return { publishedDate: parsePublishedDate(publishedDateText), publishedDateText };
}
