// ============================================
// Risk rule registry (issue #121)
// ============================================
//
// Later rules are added as data plus code: write a pure rule with its source
// and quote, append it here. Nothing else in this folder needs to change.
// Indicators that lack a published quote or need new data are NOT added (they
// are tracked in #127).

import type { AnyRiskRule } from "./types";
import { sharedContactRule } from "./shared-contact.rule";
import { LISTING_LANGUAGE_RULES } from "./listing-language.rules";

// Issue #120 adds the three listing language indicators. The listing COMPARISON
// rules are deliberately not here: their source is the verified record's own
// citation, which is dynamic (see listing-comparison.rules.ts).
export const RISK_RULES: readonly AnyRiskRule[] = [sharedContactRule, ...LISTING_LANGUAGE_RULES];

/**
 * Problems with the registry, as readable strings (empty = fine). A rule
 * without a non-empty quote and an http(s) URL must never ship; a test calls
 * this and asserts the list is empty. Also catches duplicate ids.
 */
export function registryProblems(rules: readonly AnyRiskRule[] = RISK_RULES): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const r of rules) {
    if (!r.ruleId || !/^[a-z][a-z0-9_]*$/.test(r.ruleId)) problems.push(`rule "${r.ruleId}": bad ruleId`);
    if (seen.has(r.ruleId)) problems.push(`rule "${r.ruleId}": duplicate ruleId`);
    seen.add(r.ruleId);
    if (!r.version) problems.push(`rule "${r.ruleId}": missing version`);
    if (!r.sourceQuote || !r.sourceQuote.trim()) problems.push(`rule "${r.ruleId}": missing sourceQuote`);
    if (!/^https?:\/\/\S+$/.test(r.sourceUrl ?? "")) problems.push(`rule "${r.ruleId}": sourceUrl is not http(s)`);
  }
  return problems;
}

/** Fail fast at startup / in the runner if a rule is not grounded in a source. */
export function assertRegistryValid(): void {
  const problems = registryProblems();
  if (problems.length > 0) throw new Error(`Invalid risk rule registry: ${problems.join("; ")}`);
}
