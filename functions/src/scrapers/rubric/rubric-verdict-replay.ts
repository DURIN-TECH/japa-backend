// ============================================
// OFFLINE REPLAY OF STORED CHECK VERDICTS (issue #240)
// ============================================
//
// Recomputes, from the verdict letters a run already stored, which rules the
// independent check leaves out TODAY and the shares the leave-out budget sees.
// It calls the PRODUCTION mapping (`judgeRule`, `leaveOutBasis`, `isProtectedRule`,
// `isScopedRule`), never a re-implementation, so a change to the mapping shows up
// here and the fixture test pins the numbers. No model, no network, no Firestore:
// zero requests, because the mapping is pure and the verdicts are data.
//
// Input: one entry per rule with only ids, kinds, applicability, source ids and
// verdict letters (aspect order title, kind, stage, condition, check, group; see
// `decodeRow`). No quote text is needed or read.
//
// What it does NOT replay: the code gates (a code leave-out is taken as stored,
// with its stored reason) and the `possible_duplicate` partner rule (a duplicate
// stays as stored; it is never counted in the budget anyway).
//
// Generic: nothing here names a country, route or publisher; the primary sources are
// passed in by the caller.

import type { AssessmentCriterion } from "../../types/rubric";
import { decodeRow } from "./rubric-checker-prompt";
import { judgeRule, leaveOutBasis } from "./rubric-checker";
import { isProtectedRule, isScopedRule } from "./rubric-gates";

/** The duplicate flag code: a duplicate is left out but never counted against the budget (as in the gates). */
const DUPLICATE_REASON = "possible_duplicate";

/** One stored rule: only what the mapping and the budget read. */
export interface ReplayRule {
  id: string;
  kind: AssessmentCriterion["kind"];
  applicability?: AssessmentCriterion["applicability"];
  applicabilityCondition?: string;
  check?: AssessmentCriterion["check"];
  appliesTo?: AssessmentCriterion["appliesTo"];
  sourceId: string;
  // Verdict letters per model (`yuuyaa`), as the check stored them. Absent for a rule the check never read.
  verdicts?: { verification?: string; judgement?: string } | null;
  // The reason the stored run left the rule out (a code reason, or `checker:<aspect>`); null/absent = kept.
  leftOut?: string | null;
}

/** What the replay found. */
export interface ReplayResult {
  rules: number;
  // Leave-outs counted against the budget (every leave-out except a duplicate).
  counted: number;
  general: { counted: number; of: number };
  scoped: { counted: number; of: number };
  primary: { counted: number; of: number };
  // The check's own leave-outs, split by why (#240).
  foundWrong: number;
  notConfirmed: number;
  // Leave-outs the CODE gates made, taken as stored (reason -> count).
  codeLeftOut: Record<string, number>;
  // Every leave-out by reason (code reasons and `checker:<aspect>`).
  byReason: Record<string, number>;
  // Protected rules the new mapping would HOLD the draft for (a bar with a failing verdict).
  heldProtected: string[];
  // Rules the stored run left out for the check that the new mapping keeps.
  nowKept: number;
  // Per rule: the new reason (absent = kept).
  leftOutIds: Record<string, string>;
}

/** Replay the stored verdicts through the current mapping. */
export function replayVerdicts(rules: readonly ReplayRule[], primarySourceIds: ReadonlySet<string>): ReplayResult {
  const leftOutIds: Record<string, string> = {};
  const basisById = new Map<string, "found_wrong" | "not_confirmed">();
  const heldProtected: string[] = [];
  let nowKept = 0;
  for (const r of rules) {
    // A code leave-out (anything stored that is not a check reason) stays as stored.
    if (r.leftOut && !r.leftOut.startsWith("checker:")) {
      leftOutIds[r.id] = r.leftOut;
      continue;
    }
    const shape = { kind: r.kind, applicability: r.applicability, applicabilityCondition: r.applicabilityCondition, check: r.check, appliesTo: r.appliesTo } as AssessmentCriterion;
    const verification = r.verdicts?.verification ? decodeRow(r.verdicts.verification) ?? undefined : undefined;
    const judgement = r.verdicts?.judgement ? decodeRow(r.verdicts.judgement) ?? undefined : undefined;
    // A rule the check never read (no verdicts at all and not left out by code) is not replayable: skip it as kept.
    if (!verification && !judgement && !isProtectedRule(shape)) {
      if (r.leftOut) leftOutIds[r.id] = r.leftOut;
      continue;
    }
    const action = judgeRule(shape, { verification, judgement });
    if (action.action === "hold") {
      heldProtected.push(r.id);
      continue;
    }
    if (action.action === "leave_out") {
      leftOutIds[r.id] = `checker:${action.aspect}`;
      basisById.set(r.id, leaveOutBasis(shape, verification));
    } else if (r.leftOut) nowKept += 1;
  }

  const byId = new Map(rules.map((r) => [r.id, r]));
  const countedIds = Object.entries(leftOutIds).filter(([, reason]) => reason !== DUPLICATE_REASON).map(([id]) => id);
  const groupOf = (id: string): "scoped" | "general" => (isScopedRule({ applicability: byId.get(id)?.applicability }) ? "scoped" : "general");
  const inGroup = (g: "scoped" | "general") => rules.filter((r) => groupOf(r.id) === g).length;
  const primaryRules = rules.filter((r) => primarySourceIds.has(r.sourceId));
  const byReason: Record<string, number> = {};
  const codeLeftOut: Record<string, number> = {};
  for (const [id, reason] of Object.entries(leftOutIds)) {
    byReason[reason] = (byReason[reason] ?? 0) + 1;
    if (!reason.startsWith("checker:")) codeLeftOut[reason] = (codeLeftOut[reason] ?? 0) + 1;
    void id;
  }
  return {
    rules: rules.length,
    counted: countedIds.length,
    general: { counted: countedIds.filter((id) => groupOf(id) === "general").length, of: inGroup("general") },
    scoped: { counted: countedIds.filter((id) => groupOf(id) === "scoped").length, of: inGroup("scoped") },
    primary: { counted: countedIds.filter((id) => primarySourceIds.has(byId.get(id)?.sourceId as string)).length, of: primaryRules.length },
    foundWrong: [...basisById.values()].filter((b) => b === "found_wrong").length,
    notConfirmed: [...basisById.values()].filter((b) => b === "not_confirmed").length,
    codeLeftOut,
    byReason,
    heldProtected,
    nowKept,
    leftOutIds,
  };
}
