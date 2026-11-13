import { createHash } from "crypto";
import type { AssessmentCriterion, RubricPublishGateResult, RubricPublishLeftOut } from "../../types/rubric";
import { EXCLUSION_NOTE_MAX } from "./rubric-exclusions";
import type { RubricPublishSettings } from "./rubric-publish-settings";

// ============================================
// RUBRIC AUTOMATIC PUBLISHING — THE CODE GATES (issue #201)
// ============================================
//
// PURE: no Firebase, no clock, no model. Given what is known about a draft
// (its rules, the flags extraction raised, the structural validator's errors,
// how big the serving version is, which sources are primary) this decides:
//
//   - which rules are LEFT OUT of the served rulebook (the existing exclusion
//     mechanism: `excludedCriterionIds`; a rule is never edited or reworded);
//   - whether the draft is HELD (a gate failed, so a person is alerted and the
//     serving version keeps serving) with a reason code per failure;
//   - which flags the run has "a recorded gate result" for, so the
//     orchestrator may acknowledge exactly those (never "acknowledge all").
//
// The service (services/rubric-auto-publish.service.ts) gathers the facts and
// acts on the verdict; nothing here reads or writes anything.
//
// ---- The flag table (every code extraction or the validator can raise) ----
//   HOLD the draft:        no_criteria, intent_polarity_conflict,
//                          intent_criteria_without_polarity, suspicious_passages
//   LEAVE THE RULE OUT:    quote_starts_mid_sentence, quote_ends_mid_sentence,
//                          combined_sub_conditions, multiple_dates_in_quote,
//                          and possible_duplicate (only if the partner is kept,
//                          applied LAST so a pair never disappears). Code cannot
//                          cure these without editing a rule, which it never does.
//   INFORMATIONAL only:    rule_ref_removed, rule_ref_derived,
//                          judgement_check_stripped, evidence_trigger_simplified,
//                          specialist_criteria_dropped, multiple_chunks,
//                          page_ends_mid_sentence, intake_answer_type_unknown
//   RESOLVED BY THE CHECK: nationality_codes_model_proposed,
//                          nationality_code_name_mismatch, title_wording_uncited,
//                          intake_wording_uncited (part B, #202, and part C,
//                          #203). If the check did not run, they stay unresolved.
//   ANY OTHER CODE:        HOLD (`unknown_flag:<code>`), mirroring the review
//                          service's "an unknown flag must be acknowledged".
//
// PROTECTED RULES are every mandatory bar and every rule with `appliesTo`
// (a named group): decided by code with no model, so a wrong one wrongly bars
// people. They are never silently left out: a leave-out flag on one HOLDS the
// draft, and a protected id is never in `excludedCriterionIds`.
//
// Generic: nothing here names a country, route, nationality or publisher.

// ============================================
// Flag tables
// ============================================

/** Flags that hold the whole draft. */
export const HOLD_FLAG_CODES: readonly string[] = ["no_criteria", "intent_polarity_conflict", "intent_criteria_without_polarity", "suspicious_passages"];
/** Flags that leave the flagged rule out (the rule is `target`). */
export const LEAVE_OUT_FLAG_CODES: readonly string[] = ["quote_starts_mid_sentence", "quote_ends_mid_sentence", "combined_sub_conditions", "multiple_dates_in_quote"];
/** The duplicate flag: leaves `target` out only when the other rule of the pair is kept. */
export const DUPLICATE_FLAG_CODE = "possible_duplicate";
/** Flags that are recorded and counted but never block. */
export const INFORMATIONAL_FLAG_CODES: readonly string[] = [
  "rule_ref_removed",
  "rule_ref_derived",
  "judgement_check_stripped",
  "evidence_trigger_simplified",
  "specialist_criteria_dropped",
  "multiple_chunks",
  "page_ends_mid_sentence",
  "intake_answer_type_unknown",
];
/** Flags only the independent check (part B) / question check (part C) can resolve. */
export const CHECKER_RESOLVED_FLAG_CODES: readonly string[] = ["nationality_codes_model_proposed", "nationality_code_name_mismatch", "title_wording_uncited", "intake_wording_uncited"];

/** What a flag is resolved as, recorded per flag key (`code:target`) in the run. */
export type FlagResolution = "left_out" | "kept_partner_left_out" | "informational" | "resolved_by_checker";

// ============================================
// Input and output
// ============================================

/** A flag as the gates need it: the review service's `ReviewFlag` satisfies this. */
export interface GateFlag {
  key: string;
  code: string;
  target: string;
  message: string;
}

/** What the independent check (part B) reports back to the gates. Absent / null = it did not run. */
export interface GateCheckerResult {
  // Rules the check says to leave out, with the aspect that failed (`checker:<aspect>`).
  leftOut: readonly { criterionId: string; reason: string }[];
  // Flag CODES the check has fully resolved: a code is listed only when EVERY
  // flag of that code was verified (every title, every group mapping, ...).
  resolvedFlagCodes: readonly string[];
}

/** Everything the gates are decided from. */
export interface GateInput {
  criteria: readonly AssessmentCriterion[];
  // The flags of the version under the proposal (`reviewFlagsFor(rubric, null)`).
  flags: readonly GateFlag[];
  suspiciousPassageCount: number;
  // Codes of the structural validator's errors for the rubric as it would be approved.
  structuralErrorCodes: readonly string[];
  // Sources treated as PRIMARY (a primary role, or one whose role cannot be established).
  primarySourceIds: ReadonlySet<string>;
  // Every source the version was extracted from.
  allSourceIds: readonly string[];
  // Kept rules of the serving version (after its own exclusions); null when none serves.
  servingKeptCount: number | null;
  settings: Pick<RubricPublishSettings, "maxLeftOutShare" | "maxPrimaryLeftOutShare" | "minKeptShareOfServing">;
  checker?: GateCheckerResult | null;
}

/** The verdict of the gates. */
export interface GateReport {
  gates: RubricPublishGateResult[];
  // Empty = every gate passed. Sorted in the order the gates ran.
  reasonCodes: string[];
  leftOut: RubricPublishLeftOut[];
  keptCriterionIds: string[];
  // Ids to write as `excludedCriterionIds`, in rulebook order.
  excludedCriterionIds: string[];
  // Left-out rules whose source is primary (listed in the alert).
  primaryLeftOutIds: string[];
  // Rules that made the draft hold (protected rules that failed a gate).
  heldRuleIds: string[];
  protectedHold: boolean;
  informationalFlags: Record<string, number>;
  // flag key -> how this run resolved it. Only these may be acknowledged.
  flagResolutions: Record<string, FlagResolution>;
  counts: { rules: number; kept: number; leftOut: number; leftOutByReason: Record<string, number>; primaryRules: number };
}

/** Protected = a mandatory bar, or any rule scoped to a named group. */
export function isProtectedRule(c: Pick<AssessmentCriterion, "kind" | "appliesTo">): boolean {
  return c.kind === "mandatory_bar" || c.appliesTo !== undefined;
}

/** The other rule of a `possible_duplicate` flag, read from its code-written message; null when it cannot be read. */
export function duplicatePartnerOf(flag: Pick<GateFlag, "message">): string | null {
  const m = /nearly the same as that of (\S+?)\. Decide/.exec(flag.message);
  return m ? m[1] : null;
}

// ============================================
// The gates
// ============================================

/**
 * Run every code gate over a draft. Order of the steps matters:
 *   1. structural validity, suspicious passages, hold flags, unknown flags;
 *   2. per-rule leave-outs from flags (a protected rule holds instead);
 *   3. the checker's leave-outs, when it ran;
 *   4. duplicate flags LAST, so a pair never vanishes;
 *   5. the shrink guard and the leave-out budget over the final kept set.
 */
export function evaluateGates(input: GateInput): GateReport {
  const gates: RubricPublishGateResult[] = [];
  const reasons: string[] = [];
  const byId = new Map(input.criteria.map((c) => [c.criterionId, c]));
  const total = input.criteria.length;
  const leftOut: RubricPublishLeftOut[] = [];
  const leftOutIds = new Set<string>();
  const heldRuleIds: string[] = [];
  const flagResolutions: Record<string, FlagResolution> = {};
  const informationalFlags: Record<string, number> = {};

  /** Record a gate result; a failed one also adds its reason code(s). */
  const gate = (name: string, failures: string[], detail?: string): void => {
    gates.push({ gate: name, passed: failures.length === 0, ...(detail ? { detail } : failures.length > 0 ? { detail: failures.join(", ") } : {}) });
    for (const f of failures) if (!reasons.includes(f)) reasons.push(f);
  };
  /** Leave a rule out once (the first reason wins). */
  const leaveOut = (criterionId: string, reason: string, flagCode: string | null): void => {
    if (leftOutIds.has(criterionId)) return;
    leftOutIds.add(criterionId);
    leftOut.push({ criterionId, reason, flagCode });
  };

  // ---- 1a. structural validity (the same validator a human approval runs) ----
  gate("structural_validity", input.structuralErrorCodes.length > 0 ? ["rubric_invalid"] : [], input.structuralErrorCodes.length > 0 ? [...new Set(input.structuralErrorCodes)].join(", ") : undefined);

  // ---- 1b. passages addressed to a reader model: the injection signal ----
  const suspicious = input.suspiciousPassageCount > 0 || input.flags.some((f) => f.code === "suspicious_passages");
  gate("suspicious_passages", suspicious ? ["suspicious_passages"] : []);

  // ---- 1c. flags that hold the draft ----
  const holdFailures: string[] = [];
  if (total === 0) holdFailures.push("no_criteria");
  for (const f of input.flags) {
    if (HOLD_FLAG_CODES.includes(f.code) && f.code !== "suspicious_passages" && !holdFailures.includes(f.code)) holdFailures.push(f.code);
  }
  gate("hold_flags", holdFailures);

  // ---- 1d. a flag code nobody has heard of fails closed ----
  const known = new Set<string>([...HOLD_FLAG_CODES, ...LEAVE_OUT_FLAG_CODES, DUPLICATE_FLAG_CODE, ...INFORMATIONAL_FLAG_CODES, ...CHECKER_RESOLVED_FLAG_CODES]);
  const unknownCodes = [...new Set(input.flags.map((f) => f.code).filter((c) => !known.has(c)))];
  gate("known_flags", unknownCodes.map((c) => `unknown_flag:${c}`));

  // ---- 2. per-rule leave-outs from flags; a protected rule holds instead ----
  const flagFailures: string[] = [];
  for (const f of input.flags) {
    if (!LEAVE_OUT_FLAG_CODES.includes(f.code)) continue;
    const rule = byId.get(f.target);
    if (!rule) {
      // A leave-out flag that names no rule of this version cannot be acted on.
      flagFailures.push(`flag_target_unknown:${f.code}`);
      continue;
    }
    if (isProtectedRule(rule)) {
      flagFailures.push(`protected_rule_flagged:${rule.criterionId}`);
      if (!heldRuleIds.includes(rule.criterionId)) heldRuleIds.push(rule.criterionId);
      continue;
    }
    leaveOut(rule.criterionId, f.code, f.code);
    flagResolutions[f.key] = "left_out";
  }

  // ---- 3. the independent check's leave-outs (part B). A protected rule is never left out: it holds. ----
  const checkerFailures: string[] = [];
  for (const l of input.checker?.leftOut ?? []) {
    const rule = byId.get(l.criterionId);
    if (!rule) {
      checkerFailures.push(`checker_unknown_rule:${l.criterionId}`);
      continue;
    }
    if (isProtectedRule(rule)) {
      checkerFailures.push(`protected_rule_flagged:${rule.criterionId}`);
      if (!heldRuleIds.includes(rule.criterionId)) heldRuleIds.push(rule.criterionId);
      continue;
    }
    leaveOut(rule.criterionId, l.reason, null);
  }
  flagFailures.push(...checkerFailures);

  // ---- 4. duplicates LAST: leave the flagged rule out only if its partner is still kept ----
  for (const f of input.flags) {
    if (f.code !== DUPLICATE_FLAG_CODE) continue;
    const rule = byId.get(f.target);
    const partnerId = duplicatePartnerOf(f);
    const partner = partnerId ? byId.get(partnerId) : undefined;
    if (!rule || !partner) {
      // The pair cannot be established, so code cannot prove one of them stays.
      flagFailures.push("duplicate_partner_unknown");
      continue;
    }
    if (isProtectedRule(rule)) {
      flagFailures.push(`protected_rule_flagged:${rule.criterionId}`);
      if (!heldRuleIds.includes(rule.criterionId)) heldRuleIds.push(rule.criterionId);
      continue;
    }
    if (leftOutIds.has(rule.criterionId)) {
      flagResolutions[f.key] = "left_out";
    } else if (!leftOutIds.has(partner.criterionId)) {
      leaveOut(rule.criterionId, DUPLICATE_FLAG_CODE, DUPLICATE_FLAG_CODE);
      flagResolutions[f.key] = "left_out";
    } else {
      // The partner is already out: this rule is the one that stays.
      flagResolutions[f.key] = "kept_partner_left_out";
    }
  }
  gate("rule_flags", [...new Set(flagFailures)], flagFailures.length === 0 ? `${leftOut.length} rule(s) left out` : undefined);

  // ---- informational flags: counted, never block ----
  for (const f of input.flags) {
    if (!INFORMATIONAL_FLAG_CODES.includes(f.code)) continue;
    informationalFlags[f.code] = (informationalFlags[f.code] ?? 0) + 1;
    flagResolutions[f.key] = "informational";
  }
  gates.push({ gate: "informational_flags", passed: true, detail: `${Object.values(informationalFlags).reduce((a, b) => a + b, 0)} flag(s), never blocking` });

  // ---- flags only the checks can resolve ----
  const resolved = new Set(input.checker?.resolvedFlagCodes ?? []);
  const unresolvedCodes: string[] = [];
  for (const f of input.flags) {
    if (!CHECKER_RESOLVED_FLAG_CODES.includes(f.code)) continue;
    if (resolved.has(f.code)) flagResolutions[f.key] = "resolved_by_checker";
    else if (!unresolvedCodes.includes(f.code)) unresolvedCodes.push(f.code);
  }
  // With no check at all the orchestrator already holds (`checker_not_configured`):
  // the gate shows the gap but adds no second reason. With a check that ran, an
  // unresolved code is its own reason.
  const ran = input.checker !== undefined && input.checker !== null;
  gates.push({
    gate: "checker_resolved_flags",
    passed: unresolvedCodes.length === 0,
    ...(unresolvedCodes.length > 0 ? { detail: ran ? unresolvedCodes.join(", ") : `${unresolvedCodes.join(", ")} (the independent check has not run)` } : {}),
  });
  if (ran) for (const c of unresolvedCodes) if (!reasons.includes(`flag_unresolved:${c}`)) reasons.push(`flag_unresolved:${c}`);

  // ---- 5a. shrink guard over the final kept set ----
  const kept = input.criteria.filter((c) => !leftOutIds.has(c.criterionId));
  const shrinkFailures: string[] = [];
  if (input.servingKeptCount !== null && input.servingKeptCount > 0 && kept.length < input.servingKeptCount * input.settings.minKeptShareOfServing) {
    shrinkFailures.push("shrink_below_floor");
  }
  for (const sourceId of input.allSourceIds) {
    if (!input.primarySourceIds.has(sourceId)) continue;
    if (!kept.some((c) => c.source?.sourceId === sourceId)) shrinkFailures.push(`primary_source_empty:${sourceId}`);
  }
  gate("shrink_guard", shrinkFailures, `${kept.length} kept${input.servingKeptCount !== null ? ` against ${input.servingKeptCount} serving` : ""}`);

  // ---- 5b. leave-out budget ----
  const primaryRules = input.criteria.filter((c) => input.primarySourceIds.has(c.source?.sourceId));
  const primaryLeftOut = leftOut.filter((l) => input.primarySourceIds.has(byId.get(l.criterionId)?.source?.sourceId as string));
  const budgetFailures: string[] = [];
  if (total > 0 && leftOut.length / total > input.settings.maxLeftOutShare) budgetFailures.push("leave_out_budget_exceeded");
  if (primaryRules.length > 0 && primaryLeftOut.length / primaryRules.length > input.settings.maxPrimaryLeftOutShare) budgetFailures.push("primary_leave_out_budget_exceeded");
  gate("leave_out_budget", budgetFailures, `${leftOut.length} of ${total} left out, ${primaryLeftOut.length} of ${primaryRules.length} primary`);

  const leftOutByReason: Record<string, number> = {};
  for (const l of leftOut) leftOutByReason[l.reason] = (leftOutByReason[l.reason] ?? 0) + 1;
  return {
    gates,
    reasonCodes: reasons,
    leftOut,
    keptCriterionIds: kept.map((c) => c.criterionId),
    excludedCriterionIds: input.criteria.filter((c) => leftOutIds.has(c.criterionId)).map((c) => c.criterionId),
    primaryLeftOutIds: primaryLeftOut.map((l) => l.criterionId),
    heldRuleIds,
    protectedHold: heldRuleIds.length > 0,
    informationalFlags,
    flagResolutions,
    counts: { rules: total, kept: kept.length, leftOut: leftOut.length, leftOutByReason, primaryRules: primaryRules.length },
  };
}

// ============================================
// Acknowledgements, note, sample, wording
// ============================================

/**
 * Which blocking flags the run may acknowledge, and which it may not. Only a
 * flag with a RECORDED gate result is acknowledged; any other blocking flag is
 * returned as `unresolved` and the approval transaction then refuses with
 * `FLAGS_NOT_ACKNOWLEDGED`, which holds the draft. Never "acknowledge all".
 */
export function acknowledgementsFor(blockingFlagKeys: readonly string[], resolutions: Readonly<Record<string, FlagResolution>>): { acknowledged: string[]; unresolved: string[] } {
  const acknowledged: string[] = [];
  const unresolved: string[] = [];
  for (const key of blockingFlagKeys) (resolutions[key] !== undefined ? acknowledged : unresolved).push(key);
  return { acknowledged, unresolved };
}

/**
 * The exclusion note the automatic path writes: code-written from the run id
 * and counts by reason, NEVER model text. Cut to the stored limit.
 */
export function buildExclusionNote(runId: string, totalRules: number, leftOutByReason: Readonly<Record<string, number>>): string {
  const parts = Object.entries(leftOutByReason)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([reason, n]) => `${reason}: ${n}`);
  const n = Object.values(leftOutByReason).reduce((a, b) => a + b, 0);
  return `Automatic publish ${runId}: ${n} of ${totalRules} rules left out (${parts.join("; ")}).`.slice(0, EXCLUSION_NOTE_MAX);
}

/** One rule of the sample-audit list. */
export interface SampleAuditRule {
  criterionId: string;
  title: string;
  ruleRef: string | null;
  quote: string;
  url: string;
}

/** How many kept rules a sample audit lists. */
export const SAMPLE_AUDIT_SIZE = 10;

/**
 * The reproducible sample-audit list: the `n` kept rules with the smallest
 * sha256 of `criterionId:version`, so the same version always yields the same
 * rules, whatever order they are stored in, and a different version samples
 * differently. A person reads these against their quotes.
 */
export function sampleAudit(kept: readonly AssessmentCriterion[], version: number, n: number = SAMPLE_AUDIT_SIZE): SampleAuditRule[] {
  return kept
    .map((c) => ({ c, h: createHash("sha256").update(`${c.criterionId}:${version}`).digest("hex") }))
    .sort((a, b) => (a.h < b.h ? -1 : a.h > b.h ? 1 : a.c.criterionId.localeCompare(b.c.criterionId)))
    .slice(0, n)
    .map(({ c }) => ({ criterionId: c.criterionId, title: c.title, ruleRef: c.ruleRef ?? null, quote: c.source.quote, url: c.source.url }));
}

/** Reason codes in words, for the alert. Unknown codes are shown as they are (never hidden). */
export function reasonInWords(code: string): string {
  const fixed: Record<string, string> = {
    rubric_invalid: "the rulebook failed the structural check a person's approval also runs",
    suspicious_passages: "the source contains text that reads as instructions to an AI reader",
    no_criteria: "the draft has no rules",
    intent_polarity_conflict: "the source gives conflicting passages about an intention to stay",
    intent_criteria_without_polarity: "rules about an intention to stay have no decided reading",
    shrink_below_floor: "the draft keeps far fewer rules than the rulebook now serving",
    leave_out_budget_exceeded: "too many rules would have to be left out",
    primary_leave_out_budget_exceeded: "too many rules from the main official source would have to be left out",
    duplicate_partner_unknown: "a possible duplicate could not be matched to its partner rule",
    checker_not_configured: "the independent AI check is not set up yet",
    question_plan_missing: "the applicant question plan is not set up yet",
    question_plan_unusable: "the automatic check of the applicant questions could not be completed or gave an unusable answer",
    question_check_capped: "the automatic check of the applicant questions would pass its spending limit",
    polarity_unverified: "the reading on an intention to stay was not verified",
    checker_unavailable: "the independent AI check could not be completed (unavailable, timed out or not set up), so nothing was published",
    checker_capped: "the independent AI check would exceed its spend limits, so it was not run",
    checker_output_invalid: "the independent AI check returned an answer that did not match what was asked, so nothing was published",
    settings_unreadable: "the publishing settings could not be read, so nothing was published",
    paused_after_rollback: "automatic publishing for this route is paused after a roll-back",
    route_not_in_allowlist: "this route is not in the automatic publishing allowlist",
    NOT_LATEST_VERSION: "a newer draft of this route exists",
    SOURCE_CHANGED: "an official source changed while the draft was being checked",
    STALE_CITATION: "a quote is no longer in the current official text",
    CITATION_UNVERIFIABLE: "a quote could not be checked against the current official text",
    RUBRIC_INVALID: "the approval check found the rulebook inconsistent",
    FLAGS_NOT_ACKNOWLEDGED: "a remark on the draft was not resolved by any automatic check",
    PRIMARY_EXCLUSION_UNCONFIRMED: "rules from the main official source would be left out without confirmation",
    REVISION_MISMATCH: "the draft changed while it was being checked",
    pipeline_error: "the automatic check failed unexpectedly",
    checker_not_run: "report only: the independent AI check was not run",
    mode_manual: "automatic publishing is off (manual mode)",
    already_decided: "the draft was already decided",
    version_missing: "the draft could not be found",
  };
  if (fixed[code]) return fixed[code];
  const [head, rest] = [code.split(":")[0], code.includes(":") ? code.slice(code.indexOf(":") + 1) : ""];
  const prefixed: Record<string, string> = {
    unknown_flag: "the draft carries a remark this check does not know",
    flag_target_unknown: "a remark names a rule the draft does not have",
    flag_unresolved: "a remark that only the independent check can resolve was not resolved",
    protected_rule_flagged: "a protected rule (a bar on a named group) failed a check",
    primary_source_empty: "a main official source has no rule left",
    protected_rule_failed: "the independent check did not confirm a protected rule (a bar on a named group)",
    checker: "the independent check did not confirm this rule",
  };
  return prefixed[head] ? `${prefixed[head]}${rest ? ` (${rest})` : ""}` : code;
}
