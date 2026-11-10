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
// right, a human reviewer decides); the eval gate (eval/score.ts) fails the
// run on it.
//
// Pure and dependency-free on purpose: the eval scorer imports it, and the
// scorer must not load Firebase or the LLM client.
//
// Scope note (kept separate from #86): a value with NO cited duration at all
// is not judged here. Uncited numerics are #86's rule (omit, never write 0).
// This check only fires when the citations DO state durations and the number
// disagrees with all of them.

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
 * Citation keys whose quotes count as "cited processing text". The union is
 * used: the model often cites the whole range under `processingTime` and each
 * end under its own key, and either is evidence for a figure.
 */
export const PROCESSING_CITATION_KEYS = ["processingTime", "processingDaysMin", "processingDaysMax"] as const;

// Number words GOV.UK (and the model) use instead of digits ("three weeks").
const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, fifteen: 15, twenty: 20, thirty: 30,
};

// Days per unit. A month is 30 days and a year 365: close enough for a 20%
// tolerance ("3 months" = 90 vs "12 weeks" = 84 still agree).
const UNIT_DAYS: Record<string, number> = { hour: 1 / 24, day: 1, week: 7, month: 30, year: 365 };

// One number: digits (optionally decimal) or a number word.
const NUM = String.raw`(\d+(?:\.\d+)?|[a-z]+)`;

// A duration, optionally a range sharing one unit:
//   "3 weeks", "3-8 weeks", "3 to 8 weeks", "12-week", "15 working days".
// Groups: 1 = first number, 2 = optional second number (range end),
//         3 = optional working/business qualifier, 4 = unit.
const DURATION_RE = new RegExp(
  String.raw`\b${NUM}(?:\s*(?:-|–|—|to)\s*${NUM})?[\s-]*(working\s+|business\s+)?(hours?|days?|weeks?|months?|years?)\b`,
  "gi"
);

/** Parse "3" / "three" → 3; undefined when it is not a number. */
function parseNumber(token: string | undefined): number | undefined {
  if (token === undefined) return undefined;
  const n = /^\d/.test(token) ? Number(token) : NUMBER_WORDS[token.toLowerCase()];
  return n !== undefined && Number.isFinite(n) ? n : undefined;
}

/**
 * Every duration stated in `text`, in days. A range ("3-8 weeks") yields both
 * ends. Working/business days yield both the plain count and its calendar
 * equivalent (x 7/5), since the model may report either.
 *
 * @example processingDurationsInDays("within 3 weeks") -> [21]
 * @example processingDurationsInDays("3-8 weeks") -> [21, 56]
 */
export function processingDurationsInDays(text: string): number[] {
  const out: number[] = [];
  for (const m of text.toLowerCase().matchAll(DURATION_RE)) {
    const unitDays = UNIT_DAYS[m[4].replace(/s$/, "")];
    const working = Boolean(m[3]);
    for (const token of [m[1], m[2]]) {
      const n = parseNumber(token);
      if (n === undefined) continue;
      out.push(n * unitDays);
      // "15 working days" ≈ 3 calendar weeks.
      if (working) out.push((n * 7) / 5);
    }
  }
  return out;
}

/** Every duration (days) in the processing citations of an extraction. */
export function citedProcessingDurations(citations: Record<string, string> | undefined): number[] {
  const out: number[] = [];
  for (const key of PROCESSING_CITATION_KEYS) {
    const quote = citations?.[key];
    if (typeof quote === "string") out.push(...processingDurationsInDays(quote));
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
 * Compare processingDaysMin/Max with the durations in the processing
 * citations. Returns one human-readable reason per end that is more than the
 * tolerance away from EVERY cited duration; [] when both agree (or when the
 * check does not apply, see below).
 *
 * Not judged (returns no reason for that end):
 *  - a missing / non-finite / <= 0 value (uncited or "0" values are #86's rule;
 *    a min of 0 is also never a claim the page made);
 *  - citations that state no duration at all (likewise #86's rule).
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
  const cited = citedProcessingDurations(citations);
  if (cited.length === 0) return [];

  // Rounded, de-duplicated list for the message ("21, 56 days").
  const citedLabel = [...new Set(cited.map((d) => Number(d.toFixed(1))))].join(", ");
  const reasons: string[] = [];
  for (const field of ["processingDaysMin", "processingDaysMax"] as const) {
    const v = values[field];
    if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) continue;
    if (!cited.some((d) => agrees(v, d, tolerance, minTol))) {
      reasons.push(
        `${field} ${v} is more than ${Math.round(tolerance * 100)}% from every cited duration (${citedLabel} days)`
      );
    }
  }
  return reasons;
}
