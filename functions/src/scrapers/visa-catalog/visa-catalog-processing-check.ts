// ============================================
// VISA CATALOG — PROCESSING RANGE vs CITED DURATIONS (pure, issue #87)
// ============================================
//
// The extractor returns `processingDaysMin` / `processingDaysMax` (days) plus
// verbatim `citations` quoting the page. Issue #87: on `gb-standard-visitor`
// a crawl stored max 56 while the processing citation the reviewer saw said
// "within 3 weeks". The 56 itself was the agreed full-range value (the
// "extend your stay ... within 8 weeks" sentence, user decision on #60), but
// nothing tied the NUMBER to its QUOTE: a range whose ends are not stated in
// any cited text was stored silently.
//
// This module is the code check for that: it parses every duration out of
// the processing citations ("3 weeks", "3-8 weeks", "15 working days",
// "12 months") and reports each end of the range that is not within a
// tolerance of ANY cited duration. The extractor validator turns a report
// into a flag + lowered confidence (never a rejection: the value may still be
// right, a human reviewer decides); the eval gate (src/scrapers/visa-catalog/eval/score.ts) fails the
// run on it.
//
// Pure and dependency-free on purpose: the eval scorer imports it, and the
// scorer must not load Firebase or the LLM client.
//
// Scope note (kept separate from #86): a value with NO cited duration at all
// is not judged here. Uncited numerics are #86's rule (omit, never write 0).
// This check only fires when the citations DO state durations and the number
// disagrees with all of them.
//
// Fail-safe rule (review of #87): a field is flagged ONLY when EVERY citation
// relevant to it parsed to at least one duration and none supports the value.
// One unparsable quote (a non-English page: "15 jours", "Wochen", "días
// hábiles"; or wording the parser does not know) means the check cannot tell,
// so that field is not judged. False flags cost reviewer trust; a missed flag
// only leaves things as they were before #87.
//
// Known false negative (accepted): every duration in a processing quote
// counts, including ones that are not processing times ("stay up to 6
// months" inside a processingTime quote). That can hide a wrong figure; it
// never flags a right one.

/** Allowed relative deviation from a cited duration (20%, same as the eval's numeric tolerance). */
export const PROCESSING_CITATION_TOLERANCE = 0.2;

/** …but never less than this many days (so "1 day" vs 2 is not flagged on rounding). */
export const PROCESSING_CITATION_MIN_TOLERANCE_DAYS = 1;

/**
 * Confidence ceiling applied by the validator when the range disagrees with
 * its citations. Low enough to stand out in the review queue, without
 * pretending the extraction is worthless.
 */
export const PROCESSING_UNVERIFIED_CONFIDENCE_CAP = 0.5;

/**
 * Citation key PREFIXES whose quotes count as processing text. Matched by
 * prefix because the model also writes suffixed keys
 * ("processingTime.inside", "processingDaysMax.outside"); the v4 Standard
 * Visitor result cites the 8 weeks only under "processingTime.inside".
 * Shared constant: the extractor (and #86's uncited-numeric rule) should use
 * this one rather than a second copy.
 */
export const PROCESSING_CITATION_PREFIXES = ["processingTime", "processingDays"] as const;

/** True when a citation key is processing text (any PROCESSING_CITATION_PREFIXES prefix). */
export function isProcessingCitationKey(key: string): boolean {
  return PROCESSING_CITATION_PREFIXES.some((p) => key.startsWith(p));
}

// ----- Number words -----

// Units and teens (teens listed separately so "eighteen" is never read as "eight").
const SMALL_NUMBERS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  seventeen: 17, eighteen: 18, nineteen: 19,
};
// Tens, combinable with a unit word: "forty-five", "twenty one".
const TENS: Record<string, number> = {
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};
// Unit words only (one..nine), the ones a tens word can take.
const DIGIT_WORDS = ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];

// Regex alternation for a number WORD. Order matters inside an alternation:
// tens (with optional unit) first, then teens, then units, then "a"/"an"
// ("a week" = 1 week). Every alternative is closed by a word boundary.
const WORD_NUM =
  `(?:(?:${Object.keys(TENS).join("|")})(?:[-\\s](?:${DIGIT_WORDS.join("|")}))?` +
  `|${["thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen", "eleven", "twelve", "ten"].join("|")}` +
  `|${["zero", ...DIGIT_WORDS].join("|")}|an|a)\\b`;

// One number: digits (optionally decimal) or a number word / phrase.
const NUM = `(\\d+(?:\\.\\d+)?|${WORD_NUM})`;

// Range separators: "3-8", "3 – 8", "3 to 8", "between 2 and 4", "2 or 3".
const SEP = "\\s*(?:-|–|—|\\bto\\b|\\band\\b|\\bor\\b)\\s*";

// Units, full and abbreviated (longest first inside each family). UNIT_ALT is
// non-capturing (used inside QUAL's lookahead); UNIT captures it.
const UNIT_ALT = "(?:hours?|hrs?|days?|weeks?|wks?|wk|months?|mths?|mos?|years?|yrs?)";
const UNIT = `(${UNIT_ALT})`;

// Optional ONE qualifier word between the number and the unit ("15 calendar
// days", "10 working days", "3 full weeks"). Never a unit itself, so
// "2 years and 9 months" stays two durations rather than a 2-9 month range.
const QUAL = `(?:(?!${UNIT_ALT}\\b)([a-z]+)\\s+)?`;

// A duration: NUM [SEP NUM] [qualifier] UNIT.
// Groups: 1 = first number, 2 = optional range end, 3 = qualifier, 4 = unit.
// (WORD_NUM, SEP and QUAL's lookahead are all non-capturing.)
const DURATION_RE = new RegExp(`\\b${NUM}(?:${SEP}${NUM})?[\\s-]*${QUAL}${UNIT}\\b`, "gi");

// Days per unit family (first letter of the unit). A month is 30 days and a
// year 365: close enough for a 20% tolerance ("3 months" = 90 vs "12 weeks" = 84).
const UNIT_DAYS: Record<string, number> = { h: 1 / 24, d: 1, w: 7, m: 30, y: 365 };

// Qualifiers meaning working days (5 per calendar week).
const WORKING_QUALIFIERS = new Set(["working", "business"]);

/** Parse "45" / "forty-five" / "twenty one" / "a" → number; undefined when not a number. */
export function parseNumberToken(token: string | undefined): number | undefined {
  if (token === undefined) return undefined;
  const t = token.toLowerCase().trim();
  if (/^\d/.test(t)) {
    const n = Number(t);
    return Number.isFinite(n) ? n : undefined;
  }
  if (t === "a" || t === "an") return 1;
  if (t in SMALL_NUMBERS) return SMALL_NUMBERS[t];
  // Tens with an optional unit word: "forty-five" = 40 + 5 (never a 40-5 range).
  const [tens, unit] = t.split(/[-\s]+/);
  if (!(tens in TENS)) return undefined;
  if (unit === undefined) return TENS[tens];
  return DIGIT_WORDS.includes(unit) ? TENS[tens] + SMALL_NUMBERS[unit] : undefined;
}

/**
 * Every duration stated in `text`, in days. A range ("3-8 weeks", "between
 * 2 and 4 months", "2 or 3 weeks") yields both ends. Working/business days
 * yield both the plain count and its calendar equivalent (x 7/5), since the
 * model may report either.
 *
 * @example processingDurationsInDays("within 3 weeks") -> [21]
 * @example processingDurationsInDays("between one and three months") -> [30, 90]
 */
export function processingDurationsInDays(text: string): number[] {
  const out: number[] = [];
  for (const m of text.toLowerCase().matchAll(DURATION_RE)) {
    const unit = m[4];
    const unitDays = UNIT_DAYS[unit[0]];
    const working = WORKING_QUALIFIERS.has(m[3] ?? "");
    for (const token of [m[1], m[2]]) {
      const n = parseNumberToken(token);
      if (n === undefined) continue;
      out.push(n * unitDays);
      // "15 working days" ≈ 3 calendar weeks.
      if (working) out.push((n * 7) / 5);
    }
  }
  return out;
}

/** The value field a citation key may speak to, beyond the shared processingTime* keys. */
type ProcessingField = "processingDaysMin" | "processingDaysMax";

/**
 * The processing quotes RELEVANT to one field: every `processingTime*` key
 * (the range as a whole) plus the field's own `processingDaysMin*` /
 * `processingDaysMax*` keys (suffixes such as ".outside" included).
 */
export function relevantProcessingQuotes(
  citations: Record<string, string> | undefined,
  field: ProcessingField
): string[] {
  const out: string[] = [];
  for (const [key, quote] of Object.entries(citations ?? {})) {
    if (typeof quote !== "string" || !quote.trim()) continue;
    if (key.startsWith("processingTime") || key.startsWith(field)) out.push(quote);
  }
  return out;
}

/** True when `days` is within tolerance of the cited duration `cited`. */
function agrees(days: number, cited: number, tolerance: number, minToleranceDays: number): boolean {
  return Math.abs(days - cited) <= Math.max(minToleranceDays, cited * tolerance);
}

/** Options (the eval passes its own configured tolerance). */
export interface ProcessingCheckOptions {
  tolerance?: number; // relative, default PROCESSING_CITATION_TOLERANCE
  minToleranceDays?: number; // absolute floor, default PROCESSING_CITATION_MIN_TOLERANCE_DAYS
}

/**
 * Compare processingDaysMin/Max with the durations in their relevant
 * processing citations. Returns one human-readable reason per end that is
 * more than the tolerance away from EVERY relevant cited duration; [] when
 * both agree (or the check does not apply).
 *
 * Not judged (no reason for that field):
 *  - a missing / non-finite / <= 0 value (uncited or "0" values are #86's
 *    rule; a min of 0 is also never a claim the page made);
 *  - no relevant processing citation (likewise #86's rule);
 *  - ANY relevant citation with no parsable duration (fail-safe: a
 *    non-English or unusual quote may state the figure in a way we can't read).
 *
 * @example Standard Visitor, max 56 but only "within 3 weeks" cited ->
 *   ['processingDaysMax 56 is more than 20% from every cited duration (21 days)']
 */
export function checkProcessingRangeCitations(
  values: { processingDaysMin?: unknown; processingDaysMax?: unknown },
  citations: Record<string, string> | undefined,
  options: ProcessingCheckOptions = {}
): string[] {
  const tolerance = options.tolerance ?? PROCESSING_CITATION_TOLERANCE;
  const minTol = options.minToleranceDays ?? PROCESSING_CITATION_MIN_TOLERANCE_DAYS;
  const reasons: string[] = [];
  for (const field of ["processingDaysMin", "processingDaysMax"] as const) {
    const v = values[field];
    if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) continue;
    const parsed = relevantProcessingQuotes(citations, field).map(processingDurationsInDays);
    // Fail-safe: judge only when there is evidence and ALL of it parsed.
    if (parsed.length === 0 || parsed.some((d) => d.length === 0)) continue;
    const cited = parsed.flat();
    if (!cited.some((d) => agrees(v, d, tolerance, minTol))) {
      // Rounded, de-duplicated list for the message ("21, 56 days").
      const citedLabel = [...new Set(cited.map((d) => Number(d.toFixed(1))))].join(", ");
      reasons.push(
        `${field} ${v} is more than ${Math.round(tolerance * 100)}% from every cited duration (${citedLabel} days)`
      );
    }
  }
  return reasons;
}
