// ============================================
// Listing comparison rules (issue #120)
// ============================================
//
// CODE ONLY, no model. Each rule compares ONE field of an agency's visa
// listing with the verified scraped record for the same route, and answers
// match / mismatch / not_compared. Every function here is PURE: no Firestore,
// no clock, no network. The service (agency-visas/agency-visa-screening.service.ts)
// loads the verified record and raises the signals.
//
// Shape follows `RiskRule` (./types.ts) with ONE difference: a RiskRule has a
// fixed published source, whereas these rules ground themselves in the
// VERIFIED RECORD's own source URL and verbatim citation, which differ per
// record. So these rules are not in RISK_RULES (the static registry check
// does not apply to dynamic sources); instead `compare` refuses to judge a
// field unless the verified record gives a non-empty citation and an http(s)
// URL, and the field is then `not_compared` (reason `no_citation`).
//
// Generic: no country, nationality, visa id or route name. Everything comes
// from the two records handed in.

import type { RiskRule } from "./types";
import type { ComparedField, ComparisonVerdict, NotComparedReason, ScreeningComparison } from "../../types/listing-screening";

// ============================================
// Constants
// ============================================

/**
 * Fee tolerance, as a percentage of the verified fee.
 *
 * SCREENING NOISE THRESHOLD ONLY, NOT AN IMMIGRATION FACT. The verified fee is
 * a whole-USD value converted at a stored rate that may be up to
 * FX_MAX_AGE_DAYS (7) old, so an honest agency typing today's rate can differ
 * a little. An exact match would flag honest agencies on every FX move.
 * Rule: |listing - verified| <= max(LISTING_FEE_TOLERANCE_MIN_USD,
 * ceil(LISTING_FEE_TOLERANCE_PCT% of verified)).
 */
export const LISTING_FEE_TOLERANCE_PCT = 5;
/** The tolerance never goes below this many whole US dollars (screening noise only). */
export const LISTING_FEE_TOLERANCE_MIN_USD = 1;

/** Version of the comparison logic, on every signal these rules raise. */
export const LISTING_COMPARISON_VERSION = "1";

/** Signal `type` raised for every mismatch (neutral wording: a pattern for review). */
export const LISTING_MISMATCH_SIGNAL_TYPE = "listing_contradicts_verified_record";

/** Unit label stored on the fee comparison and stated on its signal. */
export const FEE_UNIT_LABEL = "USD whole dollars";

/** Longest source quote a signal can carry (risk-signal validation caps it at 500). */
export const SIGNAL_QUOTE_MAX = 500;

// ============================================
// Inputs
// ============================================

/** The listing fields the rules read (a subset of the agency visa content). */
export interface ComparableListing {
  baseCostUsd?: number | null;
  category?: string | null;
  isExtendable?: boolean | null;
  processingDaysMin?: number | null;
  processingDaysMax?: number | null;
}

/**
 * The verified scraped record, already reduced by the service to what the
 * rules need. `feeVerified` is decided in code by `isFeeVerified`.
 */
export interface VerifiedRecord {
  id: string;
  /** `scrapeMeta.sourceUrl`: the official page the record was read from. */
  sourceUrl: string;
  /** `scrapeMeta.citations`: field -> verbatim quote from that page. */
  citations: Record<string, string>;
  baseCostUsd?: number | null;
  /** True only when scrapeMeta.fee has none of the unverified flags and baseCostUsd is finite. */
  feeVerified: boolean;
  category?: string | null;
  isExtendable?: boolean | null;
  processingDaysMin?: number | null;
  processingDaysMax?: number | null;
  /** `scrapeMeta.processingUnknown` */
  processingUnknown: boolean;
}

/** What `evaluate` receives. */
export interface ComparisonInput {
  listing: ComparableListing;
  verified: VerifiedRecord;
}

/** The outcome of one comparison, ready to store; for a mismatch it carries its source. */
export interface ComparisonResult extends ScreeningComparison {
  /** Present only on a mismatch: the verified record's own source for the signal. */
  source?: { sourceUrl: string; sourceQuote: string };
}

/** A comparison rule: a RiskRule minus the static source (see the file header). */
export interface ComparisonRule
  extends Omit<RiskRule<ComparisonInput, ComparisonResult>, "sourceUrl" | "sourceQuote" | "evaluate"> {
  /** The listing field this rule is about. */
  field: ComparedField;
  /** Key of the verified record's citation that backs this field. */
  citationKey: string;
  /** Full answer: match, mismatch or not_compared. Pure. */
  compare(input: ComparisonInput): ComparisonResult;
  /** RiskRule contract: the result only when it is a mismatch, else null. */
  evaluate(input: ComparisonInput): ComparisonResult | null;
}

// ============================================
// Pure helpers
// ============================================

/** True for a finite number. */
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** True for an absolute http(s) URL (same test the signal validator applies). */
export function isHttpSourceUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const u = new URL(value);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Make a citation fit a signal's `sourceQuote`: one line (whitespace runs
 * collapse to one space) and at most SIGNAL_QUOTE_MAX characters (a prefix, so
 * it is still a verbatim stretch of the page). Empty in, empty out.
 */
export function signalQuote(citation: unknown): string {
  if (typeof citation !== "string") return "";
  // eslint-disable-next-line no-control-regex
  const oneLine = citation.replace(/[\u0000-\u001f\u007f\s]+/g, " ").trim();
  return oneLine.length > SIGNAL_QUOTE_MAX ? oneLine.slice(0, SIGNAL_QUOTE_MAX).trim() : oneLine;
}

/** Fee flags on `scrapeMeta.fee` that make a fee unusable for comparison. */
const FEE_BLOCKING_FLAGS = ["feeUnverified", "fxMissing", "fxStale", "noPublishedFee"] as const;

/**
 * Is the verified record's fee usable? `scrapeMeta.fee` must carry none of the
 * blocking flags AND `baseCostUsd` must be finite. (A record with no fee
 * block at all has no flags, so only the finite cost decides.)
 */
export function isFeeVerified(fee: Record<string, unknown> | undefined | null, baseCostUsd: unknown): boolean {
  if (!isNum(baseCostUsd)) return false;
  if (!fee) return true;
  return FEE_BLOCKING_FLAGS.every((flag) => !fee[flag]);
}

/** Allowed difference in whole USD for a verified fee: max(1, ceil(5% of verified)). */
export function feeToleranceUsd(verifiedUsd: number): number {
  return Math.max(LISTING_FEE_TOLERANCE_MIN_USD, Math.ceil((Math.abs(verifiedUsd) * LISTING_FEE_TOLERANCE_PCT) / 100));
}

/** Do the ranges [aMin, aMax] and [bMin, bMax] share at least one day? */
export function rangesOverlap(aMin: number, aMax: number, bMin: number, bMax: number): boolean {
  return aMin <= bMax && bMin <= aMax;
}

/** A not_compared result. */
function skipped(
  field: ComparedField,
  reason: NotComparedReason,
  listingValue: unknown,
  verifiedValue: unknown,
  unit?: string
): ComparisonResult {
  return {
    field,
    listingValue: listingValue ?? null,
    verifiedValue: verifiedValue ?? null,
    ...(unit ? { unit } : {}),
    verdict: "not_compared",
    reason,
  };
}

/**
 * Finish a comparison with its verdict. A MISMATCH is only returned when the
 * verified record supplies a non-empty citation and an http(s) URL; without
 * them the field is skipped (`no_citation`) rather than judged.
 */
function decided(
  rule: { field: ComparedField; citationKey: string },
  verdict: Exclude<ComparisonVerdict, "not_compared">,
  verified: VerifiedRecord,
  listingValue: unknown,
  verifiedValue: unknown,
  unit?: string
): ComparisonResult {
  const quote = signalQuote(verified.citations?.[rule.citationKey]);
  if (!quote || !isHttpSourceUrl(verified.sourceUrl)) {
    return skipped(rule.field, "no_citation", listingValue, verifiedValue, unit);
  }
  return {
    field: rule.field,
    listingValue,
    verifiedValue,
    ...(unit ? { unit } : {}),
    verdict,
    ...(verdict === "mismatch" ? { source: { sourceUrl: verified.sourceUrl, sourceQuote: quote } } : {}),
  };
}

/** Build a rule from its field, its citation key and its pure comparison. */
function makeRule(
  ruleId: string,
  field: ComparedField,
  citationKey: string,
  compare: (input: ComparisonInput) => ComparisonResult
): ComparisonRule {
  return {
    ruleId,
    version: LISTING_COMPARISON_VERSION,
    category: "scam",
    field,
    citationKey,
    compare,
    evaluate(input) {
      const r = compare(input);
      return r.verdict === "mismatch" ? r : null;
    },
  };
}

// ============================================
// The four rules
// ============================================

/** Government fee in whole USD, with the 5% / 1 USD noise tolerance. */
export const feeComparisonRule: ComparisonRule = makeRule(
  "listing_fee_differs_from_verified",
  "baseCostUsd",
  "fee.application",
  ({ listing, verified }) => {
    const unit = FEE_UNIT_LABEL;
    // A listing with no fee is not flagged.
    if (!isNum(listing.baseCostUsd)) return skipped("baseCostUsd", "listing_has_no_value", null, verified.baseCostUsd, unit);
    if (!isNum(verified.baseCostUsd)) return skipped("baseCostUsd", "verified_has_no_value", listing.baseCostUsd, null, unit);
    if (!verified.feeVerified) return skipped("baseCostUsd", "fee_not_verified", listing.baseCostUsd, verified.baseCostUsd, unit);
    // Whole dollars on both sides.
    const listingUsd = Math.round(listing.baseCostUsd);
    const verifiedUsd = Math.round(verified.baseCostUsd);
    const withinTolerance = Math.abs(listingUsd - verifiedUsd) <= feeToleranceUsd(verifiedUsd);
    return decided(
      { field: "baseCostUsd", citationKey: "fee.application" },
      withinTolerance ? "match" : "mismatch",
      verified,
      listingUsd,
      verifiedUsd,
      unit
    );
  }
);

/** Visa category: exact match. */
export const categoryComparisonRule: ComparisonRule = makeRule(
  "listing_category_differs_from_verified",
  "category",
  "category",
  ({ listing, verified }) => {
    if (typeof listing.category !== "string" || !listing.category) return skipped("category", "listing_has_no_value", null, verified.category);
    if (typeof verified.category !== "string" || !verified.category) return skipped("category", "verified_has_no_value", listing.category, null);
    return decided(
      { field: "category", citationKey: "category" },
      listing.category === verified.category ? "match" : "mismatch",
      verified,
      listing.category,
      verified.category
    );
  }
);

/** Extendable yes / no: exact boolean. */
export const extendableComparisonRule: ComparisonRule = makeRule(
  "listing_extendable_differs_from_verified",
  "isExtendable",
  "isExtendable",
  ({ listing, verified }) => {
    if (typeof listing.isExtendable !== "boolean") return skipped("isExtendable", "listing_has_no_value", null, verified.isExtendable);
    if (typeof verified.isExtendable !== "boolean") return skipped("isExtendable", "verified_has_no_value", listing.isExtendable, null);
    return decided(
      { field: "isExtendable", citationKey: "isExtendable" },
      listing.isExtendable === verified.isExtendable ? "match" : "mismatch",
      verified,
      listing.isExtendable,
      verified.isExtendable
    );
  }
);

/** Processing time: the two day ranges must overlap. */
export const processingComparisonRule: ComparisonRule = makeRule(
  "listing_processing_differs_from_verified",
  "processingDays",
  "processingTime",
  ({ listing, verified }) => {
    const unit = "days";
    const l = isNum(listing.processingDaysMin) && isNum(listing.processingDaysMax)
      ? { min: listing.processingDaysMin, max: listing.processingDaysMax }
      : null;
    const v = isNum(verified.processingDaysMin) && isNum(verified.processingDaysMax)
      ? { min: verified.processingDaysMin, max: verified.processingDaysMax }
      : null;
    if (!l) return skipped("processingDays", "listing_has_no_value", null, v, unit);
    // The verified record does not know its processing time: nothing to judge by.
    if (verified.processingUnknown) return skipped("processingDays", "processing_unknown", l, v, unit);
    if (!v) return skipped("processingDays", "verified_has_no_value", l, null, unit);
    return decided(
      { field: "processingDays", citationKey: "processingTime" },
      rangesOverlap(l.min, l.max, v.min, v.max) ? "match" : "mismatch",
      verified,
      l,
      v,
      unit
    );
  }
);

/** All comparison rules, in the order their results are stored. */
export const COMPARISON_RULES: readonly ComparisonRule[] = [
  feeComparisonRule,
  categoryComparisonRule,
  extendableComparisonRule,
  processingComparisonRule,
];

/**
 * Compare a listing with the verified record on every field. With no verified
 * record (null) nothing is judged: every field is `not_compared`.
 * `ambiguous` marks "more than one verified record matched".
 */
export function compareListing(
  listing: ComparableListing,
  verified: VerifiedRecord | null,
  ambiguous = false
): ComparisonResult[] {
  if (!verified) {
    const reason: NotComparedReason = ambiguous ? "multiple_verified_records" : "no_verified_record";
    return COMPARISON_RULES.map((r) => skipped(r.field, reason, null, null));
  }
  return COMPARISON_RULES.map((r) => r.compare({ listing, verified }));
}
