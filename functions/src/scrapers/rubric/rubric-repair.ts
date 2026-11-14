import { createHash } from "crypto";
import type { AssessmentCriterion, RubricRuleRepair } from "../../types/rubric";

// ============================================
// PROTECTED-RULE REPAIR — PURE HELPERS (issue #223, follow-up of #222)
// ============================================
//
// A "protected" rule is a mandatory bar on a named group (or any rule scoped
// to named countries). When the independent check does not confirm one, the
// run no longer stops at once: the failed rule gets ONE automatic re-draft from
// its own source passage, which is checked again by both models (see
// rubric-checker.ts). This file holds the parts of that flow that need no
// model, no clock and no I/O, so they are cheap to test and safe to import from
// the read side (`applyExclusions`):
//
//   - `ruleHashOf`          the stable hash of a rule: with the rule id it is the
//                           key that makes "one attempt per rule" survive a
//                           re-delivered trigger or a sweep retry;
//   - `applyRuleRepairs`    the read-side swap of a recorded replacement for the
//                           original rule;
//   - `repairWindowLimits`  how much source text a re-draft is shown.
//
// WHERE A REPAIRED RULE LIVES (the design decision): rulebook versions are
// immutable drafts (a rule is never edited in place), so the replacement is NOT
// written into `criteria`. It is recorded on the version as the review field
// `ruleRepairs` WHEN the version is published (the same write that records the
// question plan), and `applyExclusions` (the one filter every consumer reads
// through) swaps it in. The check verified exactly the replacement, the
// publish gates and the approval transaction's structural validation run on the
// rubric WITH the replacement applied, and what is served is the replacement,
// so the three agree by construction. The original rule stays in `criteria`
// (the audit trail), and the publish run record holds the attempt, its verdicts
// and both rule hashes.
//
// A protected rule can never vanish through this path: a replacement is only
// applied for an original that is protected AND only when the replacement is
// itself protected, with the same id. Anything else is ignored (the original
// stays in force), so a corrupt record can never remove a bar.
//
// Generic: nothing here names a country, nationality, route or publisher.

/** Lines of source text shown above / below the quote in a re-draft window (HTML: lines; PDF: the page, see `passageWindow`). */
export const REPAIR_WINDOW_LINES_BEFORE = 6;
export const REPAIR_WINDOW_LINES_AFTER = 40;
/** Most characters of source text a re-draft window holds (per line and overall). */
export const REPAIR_WINDOW_CHARS = 6_000;

/**
 * A rule is protected when it is a mandatory bar or is scoped to named groups.
 * The same test as `isProtectedRule` in rubric-gates.ts, repeated here because
 * rubric-gates imports rubric-exclusions, which imports this file (an import
 * cycle otherwise). Both are two comparisons; the tests pin them together.
 */
export function isBar(c: Pick<AssessmentCriterion, "kind" | "appliesTo">): boolean {
  return c.kind === "mandatory_bar" || c.appliesTo !== undefined;
}

/** JSON with object keys sorted at every level, so equal rules always serialise equally. */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableJson(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/** sha256 hex of a rule's content (key order and undefined fields do not matter). */
export function ruleHashOf(rule: AssessmentCriterion): string {
  return createHash("sha256").update(stableJson(rule)).digest("hex");
}

/**
 * The rubric with every recorded replacement swapped in for its original, in
 * the original's position. Pure. The `ruleRepairs` field itself is dropped from
 * the result (it describes a decision about content that is no longer there,
 * like the exclusion fields). A repair is applied only when:
 *   - its `criterionId` is in the rubric and its replacement carries that id;
 *   - the original is protected AND the replacement is protected (a bar is
 *     never swapped for a rule that is not one, so it cannot be repaired away).
 * Anything else is skipped and the original stays in force.
 */
export function applyRuleRepairs<T extends { criteria: AssessmentCriterion[]; ruleRepairs?: RubricRuleRepair[] }>(rubric: T): T {
  const repairs = Array.isArray(rubric.ruleRepairs) ? rubric.ruleRepairs : [];
  if (rubric.ruleRepairs === undefined) return rubric;
  const { ruleRepairs: _recorded, ...rest } = rubric;
  void _recorded;
  if (repairs.length === 0) return rest as unknown as T;
  const byId = new Map<string, AssessmentCriterion>();
  for (const r of repairs) {
    if (r && r.replacement && r.replacement.criterionId === r.criterionId) byId.set(r.criterionId, r.replacement);
  }
  const criteria = (rubric.criteria ?? []).map((c) => {
    const replacement = byId.get(c.criterionId);
    return replacement && isBar(c) && isBar(replacement) ? replacement : c;
  });
  return { ...(rest as unknown as T), criteria };
}
