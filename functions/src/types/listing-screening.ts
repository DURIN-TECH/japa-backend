// ============================================
// Listing screening: stored shapes (issue #120)
// ============================================
//
// When an agency submits a visa listing (or edits an approved one), Seli
// screens it for an admin: a code comparison against the verified scraped
// record for the same visa, plus a model that only LOCATES recruitment-fraud
// wording. The result is one document per listing:
//
//   listingScreenings/{countryCode}__{visaId}     (same key as `visaRevisions`)
//
// Visibility: ADMINS ONLY, through `GET /admin/visas` (the `screening` field
// of an agency row) and the rerun route. The collection is backend-only: no
// firestore.rules match, so every client is denied. No agency or applicant
// serializer may include this document, a count or a flag derived from it.
//
// The quote of a flag is the listing's own wording and is shown only to
// admins on this document. It never goes into a risk signal.
//
// Nothing here names a country, a nationality or a visa route.

import type { Timestamp } from "firebase-admin/firestore";

/** What was screened: the visa itself (a submit) or a pending edit of an approved visa. */
export type ScreeningTarget = "visa" | "revision";

/** The listing fields a comparison can be about. `processingDays` is the min/max pair. */
export const COMPARED_FIELDS = ["baseCostUsd", "category", "isExtendable", "processingDays"] as const;
export type ComparedField = (typeof COMPARED_FIELDS)[number];

/** Result of comparing one field with the verified record. */
export type ComparisonVerdict = "match" | "mismatch" | "not_compared";

/**
 * Why a field was NOT compared. Plain keys, shown to admins as a reason:
 *  - no_verified_record:        no verified scraped record for this route
 *  - multiple_verified_records: more than one matches, so none is trusted
 *  - listing_has_no_value:      the listing leaves this field empty
 *  - verified_has_no_value:     the verified record lacks this field
 *  - fee_not_verified:          the verified fee is flagged unverified / stale / missing
 *  - processing_unknown:        the verified record says processing time is unknown
 *  - no_citation:               the verified record has no verbatim citation / source URL for this field
 */
export type NotComparedReason =
  | "no_verified_record"
  | "multiple_verified_records"
  | "listing_has_no_value"
  | "verified_has_no_value"
  | "fee_not_verified"
  | "processing_unknown"
  | "no_citation";

/** One comparison, as stored on the screening document. */
export interface ScreeningComparison {
  field: ComparedField;
  /** The listing's value (null when it has none). Numbers, booleans, a category key or a {min,max} pair. */
  listingValue: unknown;
  /** The verified record's value (null when none). */
  verifiedValue: unknown;
  /** Unit of a numeric value, e.g. "USD whole dollars" or "days". */
  unit?: string;
  verdict: ComparisonVerdict;
  /** Set only on `not_compared`. */
  reason?: NotComparedReason;
}

/** Why the language check did not run. */
export type LanguageNotRunReason = "ai_disabled" | "settings_unavailable" | "cap_reached" | "model_failed";

/** One accepted model flag: a registered indicator, an allowed field and an exact quote of it. */
export interface ListingLanguageFlag {
  indicator: string;
  field: string;
  quote: string;
}

/** A `listingScreenings/{countryCode}__{visaId}` document. */
export interface ListingScreening {
  /** Which content was screened. */
  target: ScreeningTarget;
  /** sha256 of the screened content (see screeningContentHash). */
  contentHash: string;
  ranAt: Timestamp;
  /** Doc-key parts, kept so a row can be matched without parsing the id. */
  countryCode: string;
  visaId: string;
  ownerAgencyId: string;
  comparisons: ScreeningComparison[];
  /** The verified record compared with, or null when none was found. */
  verifiedVisaId: string | null;
  languageCheck: "done" | "not_run";
  /** Present only when languageCheck is "not_run". */
  notRunReason?: LanguageNotRunReason;
  flags: ListingLanguageFlag[];
  /** Model flags that failed validation (unknown indicator, bad field, quote not found, over the cap...). */
  droppedFlags: number;
  /** True when the listing text addresses a model. Never changes the outcome. */
  injectionSuspected: boolean;
  /** Ids of the risk signals this screening raised or merged into. */
  signalIds: string[];
}
