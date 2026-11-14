import type { VisaScrapeMeta } from "./types";

// ============================================
// MISSING-ITEMS ACKNOWLEDGEMENT GATE (issue #212)
// ============================================
//
// A scraped visa (or a re-crawl proposal) whose `scrapeMeta.missingFromExtraction`
// is non-empty had page items the extractor missed. Code appended them
// (kindReview), but a person must SEE that before the checklist goes live: the
// approve request has to carry `acknowledgeMissingItems: true`, otherwise it is
// refused with the coded 409 MISSING_ITEMS_UNACKNOWLEDGED and nothing is written.
// A visa with `[]` or no field (any non-GB adapter) approves as before.
//
// PURE: no Firebase. Shared by the visa review path and the visa-changes path.

/** The error both approve paths throw; controllers map it to HTTP 409 with `code`. */
export class MissingItemsUnacknowledgedError extends Error {
  readonly code = "MISSING_ITEMS_UNACKNOWLEDGED";
  readonly httpStatus = 409;
  constructor(count: number) {
    super(
      `${count} item(s) the official page lists were missing from the extraction. ` +
        "Review them, then approve again with acknowledgeMissingItems set to true."
    );
    this.name = "MissingItemsUnacknowledgedError";
  }
}

/** How many missing items a scrapeMeta records (0 when absent or []). */
export function missingItemCount(meta: Pick<VisaScrapeMeta, "missingFromExtraction"> | undefined): number {
  return Array.isArray(meta?.missingFromExtraction) ? meta!.missingFromExtraction!.length : 0;
}

/**
 * Throw MissingItemsUnacknowledgedError when `meta` records missing items and the
 * request did not acknowledge them. Returns true when the approval IS
 * acknowledging a non-empty list (the caller then stamps who and when), false
 * when there was nothing to acknowledge.
 */
export function assertMissingItemsAcknowledged(
  meta: Pick<VisaScrapeMeta, "missingFromExtraction"> | undefined,
  acknowledged: boolean | undefined
): boolean {
  const n = missingItemCount(meta);
  if (n === 0) return false;
  if (acknowledged !== true) throw new MissingItemsUnacknowledgedError(n);
  return true;
}
