import { VerificationCheckStatus } from "./verification.types";

// ============================================
// IDENTITY MATCH SCORING (pure, provider-independent)
// ============================================
//
// Government-ID lookups (BVN/NIN) return the authority's record for a number; the
// platform still has to decide whether that record actually belongs to the person
// who claimed it. This module compares the CLAIMED identity (what the owner typed)
// against the RETURNED record (what NIMC/NIBSS holds) and produces a normalized
// verdict + confidence, so a returned record with a mismatched name doesn't count
// as a pass. Kept pure so it's trivially unit-testable and reused across checks.

export interface ClaimedIdentity {
  firstName?: string;
  lastName?: string;
  dateOfBirth?: string; // ISO or any parseable date string
}

export interface RecordIdentity {
  firstName?: string;
  lastName?: string;
  dateOfBirth?: string; // provider format (e.g. "DD-MM-YYYY" or ISO)
}

export interface IdentityMatch {
  status: VerificationCheckStatus; // passed | failed | needs_review
  confidence: number; // 0..1 = fraction of comparable fields that matched
  reason: string;
  /** Per-field match booleans (undefined when not comparable). */
  fields: {
    firstName?: boolean;
    lastName?: boolean;
    dateOfBirth?: boolean;
  };
}

/** Uppercase + strip everything but letters/digits, so "O'Brien" ~ "obrien". */
export function normalizeName(v?: string): string {
  return (v ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/** Two names "match" if equal after normalization, or one contains the other
 *  (tolerates middle names / ordering like "ADAOBI" vs "ADAOBI GRACE"). */
function namesMatch(a?: string, b?: string): boolean {
  const x = normalizeName(a);
  const y = normalizeName(b);
  if (!x || !y) return false;
  return x === y || x.includes(y) || y.includes(x);
}

/** Canonicalize a date to YYYY-MM-DD, or "" if unparseable. Handles ISO and the
 *  common Nigerian "DD-MM-YYYY" / "DD/MM/YYYY" provider formats. */
function canonicalDate(v?: string): string {
  if (!v) return "";
  const s = v.trim();
  // DD-MM-YYYY or DD/MM/YYYY
  const dmy = s.match(/^(\d{2})[-/](\d{2})[-/](\d{4})$/);
  if (dmy) return `${dmy[3]}-${dmy[2]}-${dmy[1]}`;
  // Anything Date can parse (ISO, etc.) -> take the date part.
  const t = Date.parse(s);
  if (!Number.isNaN(t)) return new Date(t).toISOString().slice(0, 10);
  return "";
}

/**
 * Score a claimed identity against a returned authority record.
 *
 * Rules (name mismatch is the strongest negative signal — a wrong name means the
 * number probably isn't the claimant's):
 *   - No comparable fields         -> needs_review (can't score).
 *   - Any provided name MISMATCHES -> failed.
 *   - All comparable fields match   -> passed (confidence 1).
 *   - Names match but DOB mismatch  -> needs_review.
 */
export function scoreIdentityMatch(
  claimed: ClaimedIdentity,
  record: RecordIdentity
): IdentityMatch {
  const fields: IdentityMatch["fields"] = {};
  let comparable = 0;
  let matched = 0;

  // First name
  if (claimed.firstName && record.firstName) {
    comparable++;
    fields.firstName = namesMatch(claimed.firstName, record.firstName);
    if (fields.firstName) matched++;
  }
  // Last name
  if (claimed.lastName && record.lastName) {
    comparable++;
    fields.lastName = namesMatch(claimed.lastName, record.lastName);
    if (fields.lastName) matched++;
  }
  // Date of birth
  const claimedDob = canonicalDate(claimed.dateOfBirth);
  const recordDob = canonicalDate(record.dateOfBirth);
  if (claimedDob && recordDob) {
    comparable++;
    fields.dateOfBirth = claimedDob === recordDob;
    if (fields.dateOfBirth) matched++;
  }

  if (comparable === 0) {
    return {
      status: "needs_review",
      confidence: 0,
      reason: "Not enough overlapping fields to compare — manual review.",
      fields,
    };
  }

  const confidence = matched / comparable;
  const nameMismatch =
    fields.firstName === false || fields.lastName === false;

  if (nameMismatch) {
    return {
      status: "failed",
      confidence,
      reason: "The name on record does not match the details provided.",
      fields,
    };
  }
  if (matched === comparable) {
    return {
      status: "passed",
      confidence: 1,
      reason: "Provided details match the government record.",
      fields,
    };
  }
  // Names matched but a non-name field (DOB) didn't.
  return {
    status: "needs_review",
    confidence,
    reason: "Names match but the date of birth differs — manual review.",
    fields,
  };
}
