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
// applied when the original and the replacement are BOTH protected (or, since
// #244, BOTH ordinary), with the same id. Anything else is ignored (the original
// stays in force), so a corrupt record can never remove a bar or turn an
// ordinary rule into one.
//
// (#244) The same record now also carries the ONE automatic re-draft of an
// ORDINARY rule the check found wrong (`checker.ts`, `repairOrdinary`): checked
// once by the verification model (not two: it is not a bar), served only when it
// passes. Several originals can come back as the same replacement; one is served
// (`alsoReplaced`, see `applyRuleRepairs`).
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
 * (#244) The reason a rule is left out when its ordinary replacement was CONFIRMED by the check but another
 * served rule (or the first of several replacements) already says the same: one rule is served, never two
 * copies. The leave-out is NOT counted against the budget (like `possible_duplicate`: the rule that stays says
 * the same, so no information is lost); the run record names which rule covers it.
 */
export const REDRAFT_DUPLICATE_REASON = "checker:redraft_duplicate";

/**
 * The rubric with every recorded replacement swapped in for its original, in
 * the original's position. Pure. The `ruleRepairs` field itself is dropped from
 * the result (it describes a decision about content that is no longer there,
 * like the exclusion fields). A repair is applied only when:
 *   - its `criterionId` is in the rubric and its replacement carries that id;
 *   - the original and the replacement are BOTH protected (a bar is never
 *     swapped for a rule that is not one, so it cannot be repaired away), or
 *     BOTH ordinary (#244: an ordinary rule is never swapped for a protected one,
 *     which would change what code refuses on without the two-model check).
 * Anything else is skipped and the original stays in force.
 *
 * (#244) A replacement may also stand for other originals (`alsoReplaced`: several items of one definition
 * that all came back as the same lead-in). Those originals are left out by the publish run, so the question
 * and evidence links that named them are re-pointed to the one served rule (de-duplicated, order kept), and
 * the served rule also carries their `intakeQuestionIds`: nothing that pointed at them is left dangling.
 * Re-pointing needs the original to be an ordinary rule and to exist; anything else is skipped.
 */
export function applyRuleRepairs<T extends { criteria: AssessmentCriterion[]; ruleRepairs?: RubricRuleRepair[]; intakeQuestions?: { criterionIds?: string[] }[]; evidenceItems?: { criterionIds?: string[] }[] }>(rubric: T): T {
  const repairs = Array.isArray(rubric.ruleRepairs) ? rubric.ruleRepairs : [];
  if (rubric.ruleRepairs === undefined) return rubric;
  const { ruleRepairs: _recorded, ...rest } = rubric;
  void _recorded;
  if (repairs.length === 0) return rest as unknown as T;
  const byId = new Map<string, AssessmentCriterion>();
  const repairById = new Map<string, RubricRuleRepair>();
  for (const r of repairs) {
    if (r && r.replacement && r.replacement.criterionId === r.criterionId) {
      byId.set(r.criterionId, r.replacement);
      repairById.set(r.criterionId, r);
    }
  }
  const originals = new Map((rubric.criteria ?? []).map((c) => [c.criterionId, c]));
  // Which original ids were APPLIED (a skipped repair re-points nothing), and the covered id -> surviving id map.
  const applied = new Set<string>();
  const covered = new Map<string, string>();
  let criteria = (rubric.criteria ?? []).map((c) => {
    const replacement = byId.get(c.criterionId);
    // Both protected, or both ordinary: a rule never changes class through a repair.
    if (replacement && isBar(c) === isBar(replacement)) {
      applied.add(c.criterionId);
      return replacement;
    }
    return c;
  });
  for (const id of applied) {
    for (const other of repairById.get(id)?.alsoReplaced ?? []) {
      const o = originals.get(other);
      // Only an ORDINARY, existing, different original can be covered: a bar is never absorbed.
      if (o && other !== id && !isBar(o) && !covered.has(other)) covered.set(other, id);
    }
  }
  if (covered.size === 0) return { ...(rest as unknown as T), criteria };
  // The surviving rule also carries the covered originals' question links (union, order kept).
  criteria = criteria.map((c) => {
    const absorbed = [...covered].filter(([, into]) => into === c.criterionId).map(([from]) => originals.get(from) as AssessmentCriterion);
    if (absorbed.length === 0) return c;
    const ids = [...new Set([...(c.intakeQuestionIds ?? []), ...absorbed.flatMap((a) => a.intakeQuestionIds ?? [])])];
    return ids.length > 0 ? { ...c, intakeQuestionIds: ids } : c;
  });
  // Re-point a link list: covered ids become the surviving id; nothing is repeated.
  const repoint = (ids: string[] | undefined): string[] | undefined => (ids === undefined ? ids : [...new Set(ids.map((id) => covered.get(id) ?? id))]);
  const out = { ...(rest as unknown as T), criteria } as T;
  if (Array.isArray(out.intakeQuestions)) out.intakeQuestions = out.intakeQuestions.map((q) => (q.criterionIds ? { ...q, criterionIds: repoint(q.criterionIds) } : q)) as T["intakeQuestions"];
  if (Array.isArray(out.evidenceItems)) out.evidenceItems = out.evidenceItems.map((e) => (e.criterionIds ? { ...e, criterionIds: repoint(e.criterionIds) } : e)) as T["evidenceItems"];
  return out;
}
