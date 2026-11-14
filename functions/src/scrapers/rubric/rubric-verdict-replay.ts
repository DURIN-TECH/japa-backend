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
import { estimateCheckerLoad, judgeRule, leaveOutBasis, ordinaryRepairAspects } from "./rubric-checker";
import { CHECKER_BATCH_SIZE, CHECKER_TRIGGER_BATCH_SIZE } from "./rubric-checker-prompt";
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

// ============================================
// (#244) What the ordinary re-draft would do to a stored run
// ============================================
//
// From the same stored verdicts: which ordinary rules the check found WRONG (a `no` on title, kind, condition or
// check; the PRODUCTION test `ordinaryRepairAspects`), whether the systemic guard would let any be re-drafted, how
// many requests a run would make against the cap, and what the leave-out shares would be if a stated share of the
// re-drafts were repaired and confirmed. Zero requests: nothing is asked of a model, so the "repaired" share is an
// ASSUMPTION the caller states (the live trial repaired 6 of 12), never a measurement.
//
// Simplifications, stated: a repaired rule is assumed to keep its group and source (a replacement may quote another
// line, but it keeps the original's scope); covered duplicates are not modelled (they would only lower the counts);
// repairs are spread over the groups in proportion to each group's eligible rules (expected values, so the shares
// are fractional). The leave-out budget limits are the gates' own, passed in.

/** The settings the estimate reads (the real names; see `RubricPublishSettings`). */
export interface RepairEstimateSettings {
  ordinaryRepairMaxShare: number;
  ordinaryRepairMaxRules: number;
  checkerMaxRequestsPerRun: number;
  maxLeftOutShare: number;
  maxPrimaryLeftOutShare: number;
}

/** Shares of one repair-success assumption. `counted` / `of` are expected values (fractional). */
export interface RepairScenario {
  successRate: number;
  overall: { counted: number; of: number; share: number };
  general: { counted: number; of: number; share: number };
  scoped: { counted: number; of: number; share: number };
  primary: { counted: number; of: number; share: number };
  // True when every share is within its limit (the budget would pass; other gates not modelled).
  withinBudget: boolean;
}

/** The estimate for one stored run. */
export interface RepairEstimate {
  eligible: number;
  eligibleIds: string[];
  // Eligible by group / primary, for reading the scenarios.
  eligibleBy: { general: number; scoped: number; primary: number };
  // "ok": re-drafts would run; "too_many": the guard skips them all (the run records ordinary_repair_skipped:too_many).
  guard: "ok" | "too_many";
  requests: { baseCheck: number; redraft: number; replacementCheck: number; total: number; cap: number; fitsCap: boolean };
  // Left out before any repair, counted against the budget (the replay's own figure).
  before: RepairScenario;
  scenarios: RepairScenario[];
}

/** Estimate the ordinary re-draft for stored verdicts. `rates` are the assumed shares of re-drafts repaired and confirmed. */
export function estimateOrdinaryRepair(rules: readonly ReplayRule[], primarySourceIds: ReadonlySet<string>, settings: RepairEstimateSettings, rates: readonly number[]): RepairEstimate {
  const replay = replayVerdicts(rules, primarySourceIds);
  const byId = new Map(rules.map((r) => [r.id, r]));
  const groupOf = (id: string): "scoped" | "general" => (isScopedRule({ applicability: byId.get(id)?.applicability }) ? "scoped" : "general");
  const isPrimary = (id: string): boolean => primarySourceIds.has(byId.get(id)?.sourceId as string);
  // Eligible: left out by the CHECK (a code leave-out keeps its own reason) with a `no` on one of the four aspects.
  const eligibleIds = Object.entries(replay.leftOutIds)
    .filter(([id, reason]) => {
      if (!reason.startsWith("checker:")) return false;
      const r = byId.get(id) as ReplayRule;
      if (isProtectedRule(r as unknown as AssessmentCriterion)) return false;
      const row = r.verdicts?.verification ? decodeRow(r.verdicts.verification) ?? undefined : undefined;
      return ordinaryRepairAspects(r as unknown as AssessmentCriterion, row) !== null;
    })
    .map(([id]) => id);
  const eligibleBy = { general: eligibleIds.filter((id) => groupOf(id) === "general").length, scoped: eligibleIds.filter((id) => groupOf(id) === "scoped").length, primary: eligibleIds.filter(isPrimary).length };
  const guard = eligibleIds.length > rules.length * settings.ordinaryRepairMaxShare || eligibleIds.length > settings.ordinaryRepairMaxRules ? "too_many" : "ok";
  // Requests: the check of the whole draft (protected rules twice, the polarity readings), then one re-draft per eligible
  // rule and the check of the replacements (one batch per 10, its trigger batches per 10, 2 requests of slack).
  const protectedCount = rules.filter((r) => isProtectedRule(r as unknown as AssessmentCriterion)).length;
  const triggerRules = rules.filter((r) => (r as unknown as { trigger?: unknown }).trigger !== undefined).length;
  const base = estimateCheckerLoad(rules.length, protectedCount, 2, triggerRules).requests;
  const redraft = guard === "ok" ? eligibleIds.length : 0;
  const triggered = eligibleIds.filter((id) => (byId.get(id) as unknown as { trigger?: unknown }).trigger !== undefined).length;
  const recheck = guard === "ok" && redraft > 0 ? Math.ceil(redraft / CHECKER_BATCH_SIZE) + Math.ceil(triggered / CHECKER_TRIGGER_BATCH_SIZE) + 2 : 0;
  const total = base + redraft + recheck;
  const scenario = (rate: number): RepairScenario => {
    // `rate` of the eligible rules (when the guard lets them be re-drafted) stop counting, spread in proportion to the groups.
    const fixed = guard === "ok" ? rate : 0;
    const left = (counted: number, eligible: number): number => counted - fixed * eligible;
    const countedIds = Object.entries(replay.leftOutIds).filter(([, reason]) => reason !== "possible_duplicate").map(([id]) => id);
    const part = (pred: (id: string) => boolean) => ({ counted: left(countedIds.filter(pred).length, eligibleIds.filter(pred).length), of: rules.filter((r) => pred(r.id)).length });
    const overall = part(() => true);
    const general = part((id) => groupOf(id) === "general");
    const scoped = part((id) => groupOf(id) === "scoped");
    const primary = part(isPrimary);
    const share = (x: { counted: number; of: number }) => ({ ...x, share: x.of > 0 ? x.counted / x.of : 0 });
    const out = { successRate: rate, overall: share(overall), general: share(general), scoped: share(scoped), primary: share(primary) };
    const withinBudget = out.overall.share <= settings.maxLeftOutShare && out.general.share <= settings.maxLeftOutShare && out.scoped.share <= settings.maxLeftOutShare && out.primary.share <= settings.maxPrimaryLeftOutShare;
    return { ...out, withinBudget };
  };
  return {
    eligible: eligibleIds.length,
    eligibleIds,
    eligibleBy,
    guard,
    requests: { baseCheck: base, redraft, replacementCheck: recheck, total, cap: settings.checkerMaxRequestsPerRun, fitsCap: total <= settings.checkerMaxRequestsPerRun },
    before: scenario(0),
    scenarios: rates.map(scenario),
  };
}
