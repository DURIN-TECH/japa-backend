import { VerificationCheckResult, VerificationCheckType } from "./verification.types";

// ============================================
// VERIFICATION DECISION POLICY (pure)
// ============================================
//
// A single, side-effect-free function that turns a set of check results into a
// suggested decision. Kept pure so it's trivially unit-testable and reusable by
// both the agency-compliance and (future) client-KYC orchestrators.
//
// IMPORTANT: this only *suggests*. By default (`autoApprove: false`) the platform
// surfaces the suggestion to an admin who still clicks approve/reject — the
// assisted-review posture. `auto_verify` is only ever returned when the caller
// explicitly opts in (VERIFICATION_AUTO_APPROVE), and even then only for an
// all-passed, high-confidence set.

/** Confidence at/above which a passed check is considered "high-confidence". */
export const HIGH_CONFIDENCE_THRESHOLD = 0.9;

/**
 * The policy's recommendation:
 *   - `wait`         — at least one async check is still `pending`; do nothing yet.
 *   - `reject`       — at least one check `failed`; suggest rejection.
 *   - `auto_verify`  — every check passed at high confidence AND auto-approve is on.
 *   - `needs_review` — the safe default: a human should look (mixed / low-confidence).
 */
export type SuggestedDecision = "wait" | "reject" | "auto_verify" | "needs_review";

/** A compliance/KYC record's per-check results, keyed by check type. */
export type VerificationChecksMap = Partial<
  Record<VerificationCheckType, VerificationCheckResult>
>;

/**
 * Derive the suggested decision from the current set of check results.
 *
 * Precedence is intentional: a still-running check (`wait`) blocks any decision;
 * any hard failure (`reject`) dominates passes; auto-verify requires a clean,
 * high-confidence sweep AND explicit opt-in; everything else defers to a human.
 */
export function suggestDecision(
  checks: VerificationChecksMap,
  opts: { autoApprove: boolean }
): SuggestedDecision {
  const results = Object.values(checks).filter(
    (r): r is VerificationCheckResult => r != null
  );

  // No checks ran (e.g. provider unconfigured) — nothing to suggest; defer to human.
  if (results.length === 0) return "needs_review";

  // Any async check still outstanding — don't decide until it lands.
  if (results.some((r) => r.status === "pending")) return "wait";

  // Any hard failure short-circuits to a rejection suggestion.
  if (results.some((r) => r.status === "failed")) return "reject";

  // A clean sweep: every check passed at/above the confidence threshold.
  const allPassedHighConfidence = results.every(
    (r) => r.status === "passed" && (r.confidence ?? 1) >= HIGH_CONFIDENCE_THRESHOLD
  );
  if (opts.autoApprove && allPassedHighConfidence) return "auto_verify";

  // Default: mixed / low-confidence / needs_review — a human decides.
  return "needs_review";
}
