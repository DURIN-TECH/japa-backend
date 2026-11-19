import { collections } from "../../utils/firebase";
import { AnthropicNotConfiguredError } from "../../services/ai/anthropic-client";
import { AnthropicLlmProvider, LlmProviderError, emptyLlmUsage, llmRequestHash, type LlmProvider, type LlmRequest, type LlmUsage } from "../../services/ai/llm-provider";
import type { AssessmentCriterion, IntentPolarity, LeaveOutBasis, RubricJudgedBar, RubricOrdinaryRepair, RubricOrdinaryRepairCounts, RubricProtectedFailure, RubricRepairStatus, RubricRuleRepair, VisaRubric } from "../../types/rubric";
import { isValidTrigger } from "../../utils/rubric-trigger";
import { guidanceSnapshotStore } from "../guidance/guidance-snapshot.store";
import type { GuidanceSnapshotContent } from "../guidance/types";
import { isProtectedRule, sameScope } from "./rubric-gates";
// (#248) The ONE test of "a protected rule that may be served without its unconfirmed trigger": the
// read side (`applyExclusions`) marks exactly these `notCodeDecided`, so the check and what is served agree.
import { isJudgedBarShape } from "./rubric-exclusions";
import {
  CHECKER_ASPECTS,
  CHECKER_BATCH_SIZE,
  CHECKER_CONDITION_LINE_CHARS,
  CHECKER_HEADING_CHARS,
  CHECKER_LEAD_IN_CHARS,
  CHECKER_MAX_HEADINGS,
  CHECKER_PROMPT_VERSION,
  CHECKER_TRIGGER_BATCH_SIZE,
  CHECKER_WINDOW_CHARS,
  CheckerAnswerError,
  CheckerPromptError,
  buildBatchRequest,
  buildPolarityRequest,
  buildTriggerRequest,
  decodeRow,
  encodeRow,
  handleFor,
  parsePolarityAnswer,
  parseTriggerVerdicts,
  parseVerdicts,
  selectedAnswerLabels,
  type CheckerAspect,
  type CheckerRuleView,
  type PolarityAnswer,
  type TriggerCheckView,
  type TriggerVerdict,
  type VerdictRow,
} from "./rubric-checker-prompt";
import { loadPublishSettings, type LoadedPublishSettings, type RubricPublishSettings } from "./rubric-publish-settings";
import { lexiconFor } from "../language/language-lexicon";
import { SnapshotQuoteIndex, type QuoteLookup } from "./rubric-quote";
import { quoteIsLeadIn, verifyListItems } from "./rubric-list-items";
import { RubricExtractionService, RunStop, isTransientProviderError, possibleDuplicateFlags, type RedraftOutcome } from "./rubric-extraction.service";
import { RUBRIC_REPAIR_PROMPT_VERSION, RUBRIC_SYSTEM_PROMPT } from "./rubric-prompt";
import { REDRAFT_DUPLICATE_REASON, REPAIR_WINDOW_CHARS, ruleHashOf } from "./rubric-repair";

// ============================================
// INDEPENDENT RULE CHECK — VERDICTS TO ACTIONS, AND THE RUN (issue #202, part of #200)
// ============================================
//
// Part B of the automatic rulebook publisher (#200). The pipeline
// (services/rubric-auto-publish.service.ts) calls `check` only after every code
// gate passed and never in a dry run. This module reads every rule of the draft
// against its own quoted sentence with a second model and returns what code
// decides from the closed verdicts:
//
//   keep      every applicable aspect is `yes`;
//   leave out an ordinary rule with any aspect that is not `yes` (the pipeline
//             records it as `checker:<aspect>`); NEVER for size or length, only
//             when a correctness verdict fails (owner decision 2026-11-13);
//   hold      a PROTECTED rule (a mandatory bar, or any rule scoped to named
//             countries) with any aspect not `yes` from EITHER of two different
//             models, or a missing verdict, or a disagreement: the whole draft
//             is held (`protected_rule_failed:<id>`), the rule is never left out;
//   hold      an answer that is not exactly what was asked (`checker_output_invalid`),
//             a provider failure after one retry or a missing key or unreadable
//             settings (`checker_unavailable`), a spend cap (`checker_capped`).
//
// THE TABLE (`judgeRule`, tested row by row):
//   ordinary, all applicable aspects yes, others na/yes        -> keep
//   ordinary, an applicable aspect no / unsure / na            -> leave out `checker:<first failing aspect>`
//   ordinary, a not-applicable aspect no / unsure              -> leave out `checker:<that aspect>`
//   a mandatory_bar, `stage_right` whatever the answer (#226)  -> not judged: cannot hold, cannot pass for it
//   a judgement rule, `stage_right` whatever the answer (#240)  -> not judged, likewise (ordinary AND protected)
//   an ORDINARY judgement rule, `kind_right` = unsure (#240)    -> passes (`no` still leaves it out; `na` still fails)
//   an objective rule, stage or kind `unsure`                    -> leaves out, as before (both still matter, see below)
//   ordinary, its quote cannot be found in its cited snapshot  -> leave out `checker:source_text`
//   protected, both models pass every aspect                   -> keep
//   protected, either model fails an aspect / disagrees        -> HOLD
//   protected, its quote cannot be found                       -> HOLD
//   any batch: missing / extra / repeated id, extra key, bad enum, cut-off -> HOLD `checker_output_invalid`
//
// THE TRIGGER CHECK (INTEGRATION of #202 and #207): a rule kept as specialist or
// conditional carries `trigger = { questionId, anyOf }`, the link that decides
// which applicants it is applied to. The six aspects above judge what the rule
// SAYS, not that link, so a small separate call (same module, same fail-closed
// rules, own prompt version) asks whether "an applicant who gives one of these
// answers is exactly an applicant the quote describes". Code maps:
//   ordinary rule, verdict `yes`                        -> keep the trigger
//   ordinary rule, `no` / `unsure` (or a wrong link)    -> DROP THE TRIGGER, keep the rule
//   protected rule, both models `yes`                   -> keep
//   protected rule, anything else                       -> HOLD `protected_rule_failed:<id>`
// A wrong trigger must never REMOVE a rule: a dropped trigger leaves the rule
// kept, and it is then read as "could not tell whether this applies" (specialist)
// or by the pre-#207 rule that a conditional rule without a trigger applies to
// everyone (counted in the run record). The dropped ids are written on the
// version's question plan and applied on the read side, so the stored rule is
// never edited. Only rules whose trigger is usable against the draft's own
// questions are asked about (an unusable trigger is already ignored by every
// consumer). A dropped trigger never counts toward the leave-out budget.
//
// WHAT THE CHECK NEVER DOES: write, edit or add a rule; return a free-text
// field; assume "faithful" when an answer is incomplete. It can only subtract
// or hold. Its output is never stored as rule content.
//
// INDEPENDENCE: its own prompt (rubric-checker-prompt.ts, sharing no text with
// extraction) and model role `verification`, which is NOT the extractor's role
// (`judgement`). Protected rules are read by both `verification` and
// `judgement`. Honest limit: the second reading of a protected rule uses the
// extractor's model (a different prompt, the same model), which is what the
// issue prescribes; the first is a different model.
//
// ORDER OF WORK (to spend nothing on a draft that is held anyway):
//   1. protected rules, both models, and the intention-to-stay reading (both
//      models; they see ONLY the proposal's quote): any failure holds now;
//   2. every ordinary rule, in rulebook order, batches of CHECKER_BATCH_SIZE.
// EVERY rule of the draft is checked, however many there are, including rules
// the code gates already left out: a `possible_duplicate` rule left out
// because its partner stays comes back if that partner then fails here, so it
// needs a verdict.
//
// REUSE AND DETERMINISM: batches are cut by position in rulebook order; a
// request is a pure function of the rules and their windows, so it replays.
// Every answer is stored under the request's hash in `rubricCheckerRuns`; a
// re-run of the same version finds them and calls no model (and a run cut off
// by the clock resumes from the batches already done).
//
// SPEND: caps are checked BEFORE the first call (rules per draft, requests, input
// characters, runs per UTC day) and the request cap also bounds retries; a
// draft over a cap is held, never trimmed. One retry, with a pause, for a
// transient provider failure only.
//
// Logging: counts and codes only; never a rule, a quote, source text or an answer.
//
// Generic: nothing here names a country, nationality, route or publisher.

// ============================================
// Verdict -> action (pure)
// ============================================

/** What code does with one rule. */
export type RuleAction = { action: "keep" } | { action: "leave_out"; aspect: CheckerAspect } | { action: "hold"; aspect: CheckerAspect };

/**
 * The aspects that APPLY to a rule: the ones the model must answer `yes` to.
 * Title, kind and stage always apply; the others only when the rule has the
 * field they judge.
 */
export function applicableAspects(rule: RuleShape): ReadonlySet<CheckerAspect> {
  const set = new Set<CheckerAspect>(["title_faithful", "kind_right", "stage_right"]);
  if (rule.applicability !== undefined || rule.applicabilityCondition !== undefined) set.add("condition_faithful");
  if (rule.check !== undefined) set.add("check_faithful");
  if (rule.appliesTo !== undefined) set.add("group_matches_codes");
  // (#226) A mandatory bar's stage is not judged: see `unjudgedAspects`.
  for (const a of unjudgedAspects(rule)) set.delete(a);
  return set;
}

/** The rule fields the aspect tables read. `kind` is optional so a bare field list still works. */
type RuleShape = Pick<AssessmentCriterion, "applicability" | "applicabilityCondition" | "check" | "appliesTo"> & { kind?: AssessmentCriterion["kind"] };

/**
 * (#226, #240) Aspects that are NEVER judged for a rule: whatever a model answers
 * there (yes, no, unsure, na) can neither pass nor fail the rule.
 *
 * `stage_right` is not judged for a `mandatory_bar` (#226) and, since #240, not
 * for a `judgement` rule either. Why it harms nobody on those two kinds:
 *  - a bar is decided by code from the applicant's group whatever its stage;
 *  - a judgement rule is never decided by code: `planJudgementBatches` only uses
 *    the stage to SORT and batch the assessment model's reading (`stageRank` only
 *    orders the intake questions), and the portal reads the stage only on a
 *    code-decided REFUSAL GROUND (CaseAssessmentCard: "rejected as invalid" vs "a
 *    refusal ground"), which a judgement rule can never be (it can only raise a
 *    concern). So a wrong stage on a judgement rule changes an order and a label.
 * A sentence that fits no stage definition made careful models honestly answer
 * `unsure`, and that `unsure` held a real rulebook over a label (77 of the 213
 * leave-outs of the first automatic run).
 *
 * Deliberately narrow: stage is STILL judged for an `objective` rule (its stage
 * decides the portal's "invalid" vs "refusal ground" note on a code-decided
 * refusal), and every other aspect of every rule is judged. `unsure` still fails
 * everywhere it is judged. Applies to ordinary AND protected rules alike.
 */
export function unjudgedAspects(rule: { kind?: AssessmentCriterion["kind"] }): ReadonlySet<CheckerAspect> {
  return rule.kind === "mandatory_bar" || rule.kind === "judgement" ? new Set<CheckerAspect>(["stage_right"]) : new Set<CheckerAspect>();
}

/**
 * (#240) True when `kind_right = unsure` does NOT fail the rule: an ORDINARY rule
 * already drafted as `judgement`. That is the safest handling there is at
 * assessment: the rule is shown in full to the assessment model, never decided by
 * code, and can only raise a concern. If the checker is unsure the kind is
 * right, the worst outcome is the rule staying in that safest handling, so the
 * doubt changes nothing for an applicant. Everything else keeps `unsure` = fail:
 *  - `kind_right = no` still leaves the rule out (the checker is sure it is wrong);
 *  - an `objective` rule (code decides: a wrong kind is a wrong code refusal);
 *  - a PROTECTED rule (bar, or scoped to named groups): both models must say `yes`.
 */
function kindUnsureTolerated(rule: RuleShape): boolean {
  return rule.kind === "judgement" && !isProtectedRule({ kind: rule.kind, appliesTo: rule.appliesTo });
}

/**
 * The ONE place that says whether one verdict fails one aspect of a rule. Used by
 * `failedAspect`, `failedAspectsOf` and `leaveOutBasis`, so they cannot disagree.
 *  - never-judged aspect: never fails;
 *  - ordinary judgement rule, `kind_right = unsure`: does not fail (#240);
 *  - applicable aspect: only `yes` passes (`na` there is "not verified");
 *  - not-applicable aspect: `na` and `yes` pass; `no` and `unsure` fail.
 */
function aspectFails(rule: RuleShape, aspect: CheckerAspect, verdict: VerdictRow[CheckerAspect], applicable: ReadonlySet<CheckerAspect>, unjudged: ReadonlySet<CheckerAspect>): boolean {
  if (unjudged.has(aspect)) return false;
  if (aspect === "kind_right" && verdict === "unsure" && kindUnsureTolerated(rule)) return false;
  return applicable.has(aspect) ? verdict !== "yes" : verdict === "no" || verdict === "unsure";
}

/**
 * The first aspect (in fixed order) a row fails for a rule, or null when it
 * passes. Applicable: only `yes` passes (`na` there is "not verified" and
 * fails like `unsure`). Not applicable: `na` and `yes` pass; `no` and `unsure`
 * fail (a doubt the model raised is never ignored). Never judged (#226): skipped.
 */
export function failedAspect(rule: RuleShape, row: VerdictRow): CheckerAspect | null {
  const applicable = applicableAspects(rule);
  const unjudged = unjudgedAspects(rule);
  for (const a of CHECKER_ASPECTS) if (aspectFails(rule, a, row[a], applicable, unjudged)) return a;
  return null;
}

/**
 * (#240) Why an ORDINARY rule is left out, for the run record: `found_wrong` when
 * any failing verdict is a `no` (a model said the rule is wrong), `not_confirmed`
 * when every failing verdict is `unsure` or `na` (nobody said it is wrong; the
 * check could not confirm it), or when there was no verdict row to read. Only
 * FAILING verdicts count: a tolerated `unsure` (stage of a judgement rule, kind of
 * an ordinary judgement rule) is not one. Both still count against the budget.
 */
export function leaveOutBasis(rule: RuleShape, row: VerdictRow | undefined): LeaveOutBasis {
  if (!row) return "not_confirmed";
  const applicable = applicableAspects(rule);
  const unjudged = unjudgedAspects(rule);
  return CHECKER_ASPECTS.some((a) => aspectFails(rule, a, row[a], applicable, unjudged) && row[a] === "no") ? "found_wrong" : "not_confirmed";
}

/**
 * (#244) The aspects whose `no` makes an ORDINARY rule eligible for the one automatic re-draft: the four
 * that say the rule's own words are wrong (title, kind, condition, check). `stage_right` is not here (it is
 * not judged for judgement rules and a re-draft would not fix it), and neither is `group_matches_codes`
 * (only bars have a group).
 */
export const ORDINARY_REPAIR_ASPECTS: readonly CheckerAspect[] = ["title_faithful", "kind_right", "condition_faithful", "check_faithful"];

/**
 * (#244) Whether an ordinary rule the check LEFT OUT is eligible for its one re-draft, and what it is told.
 * Returns every aspect the rule failed (the re-draft is told all of them, in the checker's order) when at
 * least one FAILING verdict is a `no` on `ORDINARY_REPAIR_ASPECTS`; null otherwise: a rule that passes, a
 * protected rule (its own path), a rule with no verdict, and a rule with only `unsure` / `na` verdicts (the
 * check could not confirm it; a re-draft cannot add the context it lacked). Uses `aspectFails`, the one test
 * of what counts as a failure, so it cannot disagree with the leave-out itself.
 */
export function ordinaryRepairAspects(rule: AssessmentCriterion, row: VerdictRow | undefined): CheckerAspect[] | null {
  if (!row || isProtectedRule(rule)) return null;
  const applicable = applicableAspects(rule);
  const unjudged = unjudgedAspects(rule);
  const wrong = ORDINARY_REPAIR_ASPECTS.some((a) => row[a] === "no" && aspectFails(rule, a, row[a], applicable, unjudged));
  return wrong ? failedAspectsOf(rule, row) : null;
}

/**
 * (#223) EVERY aspect a rule failed, from either model's row, in the checker's
 * fixed order (the held report and the re-draft are told all of them, not just
 * the first). A missing row fails the first aspect, like `judgeRule` treats it.
 */
export function failedAspectsOf(rule: RuleShape, ...rows: (VerdictRow | undefined)[]): CheckerAspect[] {
  const failed = new Set<CheckerAspect>();
  const unjudged = unjudgedAspects(rule);
  for (const row of rows) {
    if (!row) {
      failed.add(CHECKER_ASPECTS[0]);
      continue;
    }
    const applicable = applicableAspects(rule);
    for (const a of CHECKER_ASPECTS) if (aspectFails(rule, a, row[a], applicable, unjudged)) failed.add(a);
  }
  return CHECKER_ASPECTS.filter((a) => failed.has(a));
}

/**
 * The table: verdicts -> keep / leave out / hold. `verification` is the first
 * model's row, `judgement` the second model's (protected rules only). A missing
 * row on a protected rule holds; a missing row on an ordinary rule is the
 * caller's invalid batch (it never gets here), so it is treated as a failure
 * of the first aspect rather than as "faithful".
 */
export function judgeRule(rule: AssessmentCriterion, rows: { verification?: VerdictRow; judgement?: VerdictRow }): RuleAction {
  if (isProtectedRule(rule)) {
    for (const row of [rows.verification, rows.judgement]) {
      if (!row) return { action: "hold", aspect: CHECKER_ASPECTS[0] };
      const failed = failedAspect(rule, row);
      if (failed) return { action: "hold", aspect: failed };
    }
    return { action: "keep" };
  }
  if (!rows.verification) return { action: "leave_out", aspect: CHECKER_ASPECTS[0] };
  const failed = failedAspect(rule, rows.verification);
  return failed ? { action: "leave_out", aspect: failed } : { action: "keep" };
}

/**
 * The reading on an intention to stay, decided from the two models' answers.
 * Only when the proposal is a stated value AND both models chose exactly it.
 * Returns the proposal's value, or null (the draft is then held
 * `polarity_unverified`). `not_assessed` is handled by the caller (it needs
 * the rules, not an answer).
 */
export function decidePolarity(proposal: Exclude<IntentPolarity, "not_assessed">, answers: readonly PolarityAnswer[]): IntentPolarity | null {
  return answers.length === 2 && answers.every((a) => a === proposal) ? proposal : null;
}

/**
 * The trigger table (pure, tested row by row). `verification` is the first
 * model's verdict, `judgement` the second model's (protected rules only).
 *   protected: both `yes` -> keep; anything else, or a missing verdict -> hold
 *   ordinary:  `yes` -> keep; `no`, `unsure` or missing -> drop the trigger
 */
export function judgeTrigger(rule: Pick<AssessmentCriterion, "kind" | "appliesTo">, verdicts: { verification?: TriggerVerdict; judgement?: TriggerVerdict }): "keep" | "drop" | "hold" {
  if (isProtectedRule(rule)) return verdicts.verification === "yes" && verdicts.judgement === "yes" ? "keep" : "hold";
  return verdicts.verification === "yes" ? "keep" : "drop";
}

/**
 * (#248) What a protected rule's "hold" on its trigger ALONE becomes: true for a mandatory bar
 * (served without the trigger and judged, never code-decided; see `isJudgedBarShape` in
 * rubric-exclusions.ts for the two-direction argument), false for any other protected rule (it
 * still holds: an objective rule scoped to a group is decided by code, and widening it could
 * fail applicants it does not cover). The trigger table itself (`judgeTrigger`) is unchanged.
 */
export function servableWithoutTrigger(rule: Pick<AssessmentCriterion, "kind">): boolean {
  return isJudgedBarShape(rule);
}

// ============================================
// Expected load (for the cost statement)
// ============================================

/** Rough tokens per rule sent (rule fields, quote, window) and in the constant system prompt, and per verdict answered. */
const EST_INPUT_TOKENS_PER_RULE = 450;
const EST_SYSTEM_PROMPT_TOKENS = 1_900;
const EST_OUTPUT_TOKENS_PER_RULE = 100;

/**
 * Expected size of one check of a draft, before any thinking tokens. Requests:
 * ordinary rules once, protected rules twice (two models), plus the two
 * intention-to-stay readings when the proposal states a value. Tokens are an
 * estimate (the real figures are on the run record); the system prompt is
 * counted on every request although it is cached after the first.
 */
export function estimateCheckerLoad(ruleCount: number, protectedCount = 0, polarityRequests = 2, triggerRules = 0): { requests: number; inputTokens: number; outputTokens: number } {
  const ordinary = Math.max(0, ruleCount - protectedCount);
  // INTEGRATION: the trigger check is one small request per CHECKER_TRIGGER_BATCH_SIZE rules that carry a
  // usable trigger (about 220 input tokens and 12 output tokens per rule: no source window, one verdict).
  const triggerRequests = Math.ceil(triggerRules / CHECKER_TRIGGER_BATCH_SIZE);
  const requests = Math.ceil(ordinary / CHECKER_BATCH_SIZE) + 2 * Math.ceil(protectedCount / CHECKER_BATCH_SIZE) + polarityRequests + triggerRequests;
  const inputTokens = (ordinary + 2 * protectedCount) * EST_INPUT_TOKENS_PER_RULE + requests * EST_SYSTEM_PROMPT_TOKENS + triggerRules * 220;
  const outputTokens = (ordinary + 2 * protectedCount) * EST_OUTPUT_TOKENS_PER_RULE + polarityRequests * 20 + triggerRules * 12;
  return { requests, inputTokens, outputTokens };
}

// ============================================
// Types (the plug-in contract is the pipeline's)
// ============================================

// The contract lives with the pipeline; re-declared structurally here so this
// module (inside the scrapers boundary) does not import from services.
export interface RubricCheckInputShape {
  routeKey: string;
  version: number;
  runId: string;
  rubric: VisaRubric;
  codeLeftOutIds: readonly string[];
}
export type RubricCheckOutcomeShape =
  | {
    ok: true;
    leftOut: { criterionId: string; reason: string; basis?: LeaveOutBasis }[];
    resolvedFlagCodes: string[];
    intentPolarity: IntentPolarity | null;
    droppedTriggerIds?: string[];
    // (#223) Protected rules that failed the check and were REPAIRED: the replacements the pipeline
    // records on the version (`ruleRepairs`), and the record of each attempt for the run record.
    repairs?: RubricRuleRepair[];
    protectedFailures?: RubricProtectedFailure[];
    // (#244) The automatic re-draft of ordinary rules the check found wrong: the counts and a line per
    // eligible rule. Their replacements that passed are in `repairs` above (the same record as the bars').
    ordinaryRepairs?: { counts: RubricOrdinaryRepairCounts; records: RubricOrdinaryRepair[] };
    // (#248) Bars served without their unconfirmed trigger (judged, never code-decided). Their ids are
    // also in `droppedTriggerIds`.
    judgedBars?: RubricJudgedBar[];
    requests?: { total: number; repair: number };
  }
  | {
    ok: false;
    reasonCodes: string[];
    protectedRuleIds?: string[];
    // (#223) The complete held report: every protected failure with its per-aspect verdicts and its
    // repair attempt, the ordinary rules the check would have left out, and the spend.
    protectedFailures?: RubricProtectedFailure[];
    leftOut?: { criterionId: string; reason: string; basis?: LeaveOutBasis }[];
    // (#248) On a draft held for ANOTHER bar: the bars that would have been served without their trigger.
    judgedBars?: RubricJudgedBar[];
    requests?: { total: number; repair: number };
  };

/** What one stored answer holds: closed verdicts only. */
export interface StoredResponse {
  role: "verification" | "judgement";
  // The model id that answered (a stored answer is reused only for the same model).
  model: string;
  // Rule batches: handle -> six verdict letters.
  rows?: Record<string, string>;
  // Polarity readings: the closed choice.
  answer?: string;
  // Trigger batches: handle -> `yes` | `no` | `unsure`.
  triggers?: Record<string, string>;
}

/** Token and request counts. */
export interface CheckerUsage extends LlmUsage {
  requests: number;
  // Characters of prompt sent (system + user), the figure the input cap counts.
  inputChars: number;
}

/** `rubricCheckerRuns/{routeKey}__v{version}`: the check's record of one version. */
export interface RubricCheckerRun {
  runId: string;
  routeKey: string;
  version: number;
  promptVersion: string;
  models: { verification: string; judgement: string };
  // UTC day of the latest run that reached the model (the daily cap counts these).
  day: string;
  reachedModel: boolean;
  status: "completed" | "failed";
  reasonCodes: string[];
  // request hash -> closed answer (what makes a re-run free).
  responses: Record<string, StoredResponse>;
  // criterionId -> six letters per model (an audit trail, never rule content).
  ruleVerdicts: Record<string, { verification?: string; judgement?: string }>;
  rules: number;
  usage: CheckerUsage;
  // Summed over every run of this version (a retry adds to it).
  lifetimeUsage: CheckerUsage;
  // (#223) The ONE re-draft of each failed protected rule, keyed by rule id (the entry holds the rule's
  // hash: an entry for a different hash is ignored). A re-delivered trigger, a sweep retry or an admin
  // re-run finds the answer here and never asks the model to re-draft that rule again. Optional: older
  // records have none.
  repairs?: Record<string, StoredRedraft>;
  updatedAtMs: number;
}

/**
 * (#223) What one finished re-draft attempt stored. Only a FINISHED attempt is
 * stored (a replacement, the model's "cannot be repaired", or a refusal by the
 * code validation); a provider that could not be reached stores nothing, so
 * that is not counted as the rule's one attempt.
 */
export interface StoredRedraft {
  // sha256 of the original rule this attempt was made for.
  ruleHash: string;
  kind: "replacement" | "cannot_be_repaired" | "invalid";
  // Code (never model text) for `invalid`.
  detail?: string;
  // The validated replacement (kind `replacement`); the check of it is replayed from the stored answers.
  replacement?: AssessmentCriterion;
  // Requests the re-draft used (its transient retry included).
  requests: number;
  promptVersion: string;
  // (#244) True when the replacement quotes the same line as the original (ordinary rules only; see `redraftRule`).
  sameLine?: boolean;
  // (#244) The verification model's reading of an ORDINARY rule's replacement, stored the moment it is known:
  // the six verdict letters (and the trigger verdict, when the replacement carries a usable trigger), the
  // model that gave them and the checker prompt version. A later run reuses it WITHOUT asking again, whatever
  // batch the replacement would now fall into (a request is a function of its batch, so batching alone could
  // not make a replay free). Reused only for the same model and checker prompt version.
  ordinaryCheck?: { model: string; checkerPromptVersion: string; row: string; trigger?: string };
}

/** Where the check keeps its record. A property of the deps so tests use memory. */
export interface CheckerLedger {
  load(runId: string): Promise<RubricCheckerRun | null>;
  save(record: RubricCheckerRun): Promise<void>;
  // Checker runs that reached the model on a UTC day, not counting `exceptRunId` (the run being decided).
  countRunsOnDay(day: string, exceptRunId: string): Promise<number>;
}

/** The ledger over Firestore. */
export const firestoreCheckerLedger: CheckerLedger = {
  async load(runId) {
    const snap = await collections.rubricCheckerRuns.doc(runId).get();
    return snap.exists ? (snap.data() as RubricCheckerRun) : null;
  },
  async save(record) {
    await collections.rubricCheckerRuns.doc(record.runId).set(record);
  },
  async countRunsOnDay(day, exceptRunId) {
    const snap = await collections.rubricCheckerRuns.where("day", "==", day).where("reachedModel", "==", true).get();
    return snap.docs.filter((d) => d.id !== exceptRunId).length;
  },
};

/** Dependencies, replaceable in tests. */
export interface RubricCheckerDeps {
  provider: () => LlmProvider;
  readSnapshot: (sourceId: string, contentHash: string) => Promise<GuidanceSnapshotContent>;
  loadSettings: () => Promise<LoadedPublishSettings>;
  ledger: CheckerLedger;
  nowMs: () => number;
  sleep: (ms: number) => Promise<void>;
  // (#223) The one-rule re-draft. Default: the drafting path of `RubricExtractionService` over THIS
  // check's provider (tests inject the scripted provider through `provider`, so they need no override).
  redraft: (provider: LlmProvider, args: RedraftArgs, usage: RubricRunUsageShape, attempts: { failed: number; cap: number }, opts: { deadlineAt: number; nowMs: () => number; sleep: (ms: number) => Promise<void> }) => Promise<RedraftOutcome>;
}

/** The arguments of one re-draft (see `RubricExtractionService.redraftRule`). */
export interface RedraftArgs {
  rule: AssessmentCriterion;
  aspects: readonly string[];
  index: SnapshotQuoteIndex;
  routeName: string;
  limits: { maxOutputTokens: number; timeoutMs: number };
  sent: { chars: number };
}
/** The token and request counts a re-draft call adds up (the drafting path's usage shape). */
export interface RubricRunUsageShape {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/**
 * (#244) Estimates used to decide how many ordinary re-drafts a run can still afford (see `affordableRedrafts`):
 * characters of one re-draft request (the drafting prompt plus a bounded window plus the rule), of one check
 * request, and the requests kept back for a split batch. Estimates, not limits: the run counts what it really sends.
 */
const REDRAFT_EST_CHARS = RUBRIC_SYSTEM_PROMPT.length + 2 * REPAIR_WINDOW_CHARS + 5_000;
const CHECK_REQUEST_EST_CHARS = 20_000;
const ORDINARY_CHECK_RESERVE_SLACK = 2;

/** What the verification model's reading of one replacement amounts to (see `replacementResult`). */
interface ReplacementCheck {
  row: VerdictRow;
  // Aspects the replacement still fails (empty = it passes every aspect).
  aspectsFailed: CheckerAspect[];
  // True when it carries a usable trigger that the trigger check did not confirm.
  triggerFailed: boolean;
}

/** What `repairOrdinary` is given. */
interface OrdinaryRepairInput {
  // Eligible rules in rulebook order, each with every aspect it failed.
  eligible: readonly { rule: AssessmentCriterion; aspects: CheckerAspect[] }[];
  // Rules that stay served exactly as drafted (a bar through its replacement): what a replacement may duplicate.
  servedAsDrafted: readonly AssessmentCriterion[];
  // The verification model's verdicts on the ORIGINAL ordinary rules (the record's audit letters).
  ordinaryVerdicts: ReadonlyMap<string, VerdictRow>;
  questions: NonNullable<VisaRubric["intakeQuestions"]>;
  routeName: string;
}

/** What `repairOrdinary` decides: replacements to serve, originals no longer left out, originals left out as covered, the record. */
interface OrdinaryRepairResult {
  repairs: RubricRuleRepair[];
  repairedIds: string[];
  // Covered original id -> the id of the rule served instead.
  coveredIds: Map<string, string>;
  records: RubricOrdinaryRepair[];
  counts: RubricOrdinaryRepairCounts;
}

/**
 * (#244) Whether a confirmed replacement is the SAME RULE as `other`, which is served too: the duplicate gate's own
 * test (`possibleDuplicateFlags`: at least 80 % of the quote's words in common) and the same scope (`sameScope`).
 * A PROTECTED `other` covers the replacement whatever the scope, because the gate would otherwise hold the whole
 * draft over a pair that includes a bar. Pure.
 */
export function sameRuleAs(replacement: AssessmentCriterion, other: AssessmentCriterion): boolean {
  if (replacement.criterionId === other.criterionId) return false;
  if (possibleDuplicateFlags([replacement, other]).length === 0) return false;
  return isProtectedRule(other) || sameScope(replacement, other);
}

/**
 * (#248) The repair record's `detail` for a replacement bar that both models confirmed on every judged
 * aspect but whose trigger they did not: it is REPAIRED and served without the trigger, judged and
 * never decided by code. A code, never text from a model.
 */
export const JUDGED_BAR_DETAIL = "trigger_not_confirmed_served_judged";

/**
 * (#248) The record of each bar served without its unconfirmed trigger, in rulebook order: the ones
 * drafted that way (`asDrafted`) read from the draft, the ones whose one re-draft passed every aspect
 * (`replaced`) read from their replacement (which carries the original's trigger). Pure.
 */
export function judgedBarRecords(rules: readonly AssessmentCriterion[], asDrafted: readonly string[], replaced: readonly string[], repairs: readonly RubricRuleRepair[]): RubricJudgedBar[] {
  const replacementOf = new Map(repairs.map((r) => [r.criterionId, r.replacement]));
  const out: RubricJudgedBar[] = [];
  for (const original of rules) {
    const isReplaced = replaced.includes(original.criterionId);
    if (!isReplaced && !asDrafted.includes(original.criterionId)) continue;
    const served = (isReplaced ? replacementOf.get(original.criterionId) : undefined) ?? original;
    if (!served.trigger) continue;
    out.push({ criterionId: original.criterionId, ruleRef: served.ruleRef ?? null, title: served.title, replaced: isReplaced, removedTrigger: { questionId: served.trigger.questionId, anyOf: [...served.trigger.anyOf] } });
  }
  return out;
}

/** Requests in flight at once (rule batches are independent of each other). */
export const CHECKER_CONCURRENCY = 6;
/** Pause before the one retry of a transient failure. */
export const CHECKER_RETRY_BACKOFF_MS = 2_000;
/**
 * No NEW request starts after this long into a run: the trigger has 540 s, and
 * a request in flight can still take its timeout. A run cut off here is held
 * `checker_unavailable` with its finished batches stored, and the sweep resumes it.
 */
export const CHECKER_START_DEADLINE_MS = 330_000;

/**
 * Why one job did not produce an answer. The `unavailable_*` forms say WHAT was
 * unreachable (#223), so the hold reason is `checker_unavailable:<what>` rather
 * than a bare code: `provider` (the request failed after its one retry),
 * `provider_refused` (the model declined), `not_configured` (no AI key bound),
 * `deadline` (the run ran out of time; the sweep resumes it).
 */
type JobFailure = "unavailable_provider" | "unavailable_provider_refused" | "unavailable_not_configured" | "unavailable_deadline" | "invalid" | "capped";

/** The hold reason code of a job failure. */
function reasonOf(f: JobFailure): string {
  if (f === "capped") return "checker_capped";
  if (f === "invalid") return "checker_output_invalid";
  return `checker_unavailable:${f.slice("unavailable_".length)}`;
}

/** What the check was doing when something unexpected threw (the `checker_unavailable:<stage>` detail). */
interface StageBox {
  name: "internal" | "settings_read" | "snapshot_read" | "ledger" | "provider";
}

/** One request to make: a rule batch or a polarity reading. */
interface Job {
  request: LlmRequest;
  role: "verification" | "judgement";
  hash: string;
  // Rule batches: the criterion ids behind r1, r2, ... Absent for a polarity reading.
  criterionIds?: string[];
  // True for a trigger batch (INTEGRATION): `criterionIds` then names the rules whose trigger is judged.
  triggerBatch?: boolean;
}

/** UTC day, `YYYY-MM-DD`. */
const utcDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** A safe description of an error for the log: its code or class, never the message. */
function errorClass(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === "string" || typeof code === "number") return `code ${code}`;
  return (err as { constructor?: { name?: string } } | null)?.constructor?.name ?? "unknown error";
}

/** Add a usage record into a total. */
function addUsage(total: CheckerUsage, add: Partial<CheckerUsage>): void {
  for (const k of Object.keys(total) as (keyof CheckerUsage)[]) total[k] += add[k] ?? 0;
}

const emptyUsage = (): CheckerUsage => ({ ...emptyLlmUsage(), requests: 0, inputChars: 0 });

// ============================================
// The service
// ============================================

export class RubricCheckerService {
  private readonly deps: RubricCheckerDeps;

  constructor(deps: Partial<RubricCheckerDeps> = {}) {
    this.deps = {
      // Lazy: no key is read until the first model call.
      provider: () => new AnthropicLlmProvider(),
      readSnapshot: (sourceId, hash) => guidanceSnapshotStore.read(sourceId, hash),
      loadSettings: loadPublishSettings,
      ledger: firestoreCheckerLedger,
      nowMs: () => Date.now(),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      redraft: (provider, args, usage, attempts, opts) => new RubricExtractionService({ provider }).redraftRule(args, usage, attempts, opts),
      ...deps,
    };
  }

  /**
   * The pipeline's entry. NEVER throws: any unexpected error is a held draft
   * (`checker_unavailable:<what was unreachable>`, #223), logged by class only
   * (never the error's text, which can carry a path or a secret).
   */
  async check(input: RubricCheckInputShape): Promise<RubricCheckOutcomeShape> {
    // What the check was doing when something threw: becomes the reason's detail.
    const stage: StageBox = { name: "internal" };
    try {
      return await this.checkInner(input, stage);
    } catch (err) {
      console.error(`Rubric checker: ${input.runId} failed while ${stage.name} (${errorClass(err)})`);
      return { ok: false, reasonCodes: [err instanceof CheckerPromptError ? "checker_output_invalid" : `checker_unavailable:${stage.name}`] };
    }
  }

  /** Run `fn` with the stage named, so an error thrown inside it is reported as that stage. */
  private async at<T>(stage: StageBox, name: StageBox["name"], fn: () => Promise<T>): Promise<T> {
    stage.name = name;
    // Reset only on success: when `fn` throws, `check()`'s catch must still see WHICH stage it was.
    const out = await fn();
    stage.name = "internal";
    return out;
  }

  private async checkInner(input: RubricCheckInputShape, stage: StageBox): Promise<RubricCheckOutcomeShape> {
    const startedMs = this.deps.nowMs();
    const rubric = input.rubric;
    const rules = rubric.criteria;

    // ---- settings: unreadable = unavailable (never a default cap on a read error) ----
    const loaded = await this.at(stage, "settings_read", () => this.deps.loadSettings());
    if (loaded.readError !== undefined) return { ok: false, reasonCodes: ["checker_unavailable:settings_read"] };
    const caps = loaded.settings;
    if (rules.length === 0) return { ok: true, leftOut: [], resolvedFlagCodes: [], intentPolarity: null };
    // A cap, not a trim: a draft over it is held whole.
    if (rules.length > caps.checkerMaxRulesPerDraft) return { ok: false, reasonCodes: ["checker_capped"] };

    stage.name = "provider";
    const provider = this.deps.provider();
    const models = { verification: provider.modelFor("verification"), judgement: provider.modelFor("judgement") };
    stage.name = "internal";
    const limits = { maxOutputTokens: caps.checkerMaxOutputTokensPerRequest, timeoutMs: caps.checkerRequestTimeoutMs };

    // ---- the official text around each quote (its cited snapshot, bounded) ----
    // One cache of prepared snapshots for the whole run (the check and any re-draft read each once).
    const indexes = new Map<string, Promise<SnapshotQuoteIndex>>();
    const views = await this.at(stage, "snapshot_read", () => this.buildViews(rules, indexes, rubric));

    // ---- who is protected, and who cannot be read ----
    const protectedRules = rules.filter(isProtectedRule);
    const ordinaryRules = rules.filter((r) => !isProtectedRule(r));
    const failedProtected = new Set<string>(protectedRules.filter((r) => !views.has(r.criterionId)).map((r) => r.criterionId));
    // A protected rule whose quote cannot be found cannot be verified: hold before spending anything
    // (and a re-draft needs the quote's passage, so there is nothing to repair from).
    if (failedProtected.size > 0) return this.protectedFailure([...failedProtected]);
    const unreadableOrdinary = ordinaryRules.filter((r) => !views.has(r.criterionId));
    const readableOrdinary = ordinaryRules.filter((r) => views.has(r.criterionId));

    // ---- intention to stay ----
    const polarityPlan = await this.at(stage, "snapshot_read", () => this.planPolarity(rubric, input.codeLeftOutIds, limits));
    if (polarityPlan.kind === "unverified") return { ok: false, reasonCodes: ["polarity_unverified"] };

    // ---- the jobs, in a fixed order: protected first, then polarity, then the rest ----
    const protectedJobs: Job[] = [];
    for (const role of ["verification", "judgement"] as const) protectedJobs.push(...this.batchJobs(role, protectedRules, views, limits));
    const polarityJobs: Job[] = polarityPlan.kind === "ask" ? (["verification", "judgement"] as const).map((role) => this.polarityJob(role, polarityPlan.quote, limits)) : [];
    const ordinaryJobs = this.batchJobs("verification", readableOrdinary, views, limits);
    // The trigger check (INTEGRATION): every rule whose trigger is usable against the draft's questions.
    const questions = rubric.intakeQuestions ?? [];
    const triggered = rules.filter((r) => r.trigger !== undefined && isValidTrigger(r.trigger, questions) && views.has(r.criterionId));
    const protectedTriggered = triggered.filter(isProtectedRule);
    const ordinaryTriggered = triggered.filter((r) => !isProtectedRule(r));
    const protectedTriggerJobs: Job[] = [];
    for (const role of ["verification", "judgement"] as const) protectedTriggerJobs.push(...this.triggerJobs(role, protectedTriggered, views, questions, limits));
    const ordinaryTriggerJobs = this.triggerJobs("verification", ordinaryTriggered, views, questions, limits);
    const allJobs = [...protectedJobs, ...protectedTriggerJobs, ...polarityJobs, ...ordinaryJobs, ...ordinaryTriggerJobs];

    // ---- reuse what a previous run of this version already stored ----
    const previous = await this.at(stage, "ledger", () => this.deps.ledger.load(input.runId));
    const reusable = previous && previous.promptVersion === CHECKER_PROMPT_VERSION ? previous.responses : {};
    const responses: Record<string, StoredResponse> = {};
    const needed: Job[] = [];
    for (const job of allJobs) {
      const hit = reusable[job.hash];
      if (hit && hit.model === models[job.role] && hit.role === job.role) responses[job.hash] = hit;
      else needed.push(job);
    }

    // ---- caps, BEFORE the first call ----
    const neededChars = needed.reduce((n, j) => n + j.request.system.length + j.request.user.length, 0);
    if (needed.length > caps.checkerMaxRequestsPerRun || neededChars > caps.checkerMaxInputCharsPerRun) return { ok: false, reasonCodes: ["checker_capped"] };
    const day = utcDay(startedMs);
    if (needed.length > 0 && (await this.at(stage, "ledger", () => this.deps.ledger.countRunsOnDay(day, input.runId))) >= caps.checkerMaxRunsPerDay) return { ok: false, reasonCodes: ["checker_capped"] };

    // ---- run ----
    const usage = emptyUsage();
    const lifetimeBase = emptyUsage();
    if (previous?.lifetimeUsage) addUsage(lifetimeBase, previous.lifetimeUsage);
    const ctx: RunContext = {
      provider, caps, responses, usage, startedMs, models, input, rules, day, verdicts: {}, lifetimeBase, stage, limits, indexes,
      // (#223) Re-drafts stored by an earlier run of this version: reused, never asked for again.
      repairs: { ...(previous?.repairs ?? {}) },
      repairRequests: 0,
      ordinaryRedraftRequests: 0,
      ordinaryCheckRequests: 0,
      reusable,
    };
    const stop = async (reasonCodes: string[], extra: { protectedRuleIds?: string[]; protectedFailures?: RubricProtectedFailure[]; leftOut?: { criterionId: string; reason: string; basis?: LeaveOutBasis }[]; judgedBars?: RubricJudgedBar[] } = {}): Promise<RubricCheckOutcomeShape> => {
      await this.persist(ctx, "failed", reasonCodes);
      // The spend is reported when a repair was involved (a failed bar, or repair requests); the checker's
      // own record holds it for every other run.
      return { ok: false, reasonCodes, ...extra, ...(extra.protectedFailures !== undefined || ctx.repairRequests > 0 ? { requests: this.requestsOf(ctx) } : {}) };
    };

    // Phase 1: protected rules and the polarity readings. A provider/cap/format failure holds now.
    const phase1 = needed.filter((j) => protectedJobs.includes(j) || protectedTriggerJobs.includes(j) || polarityJobs.includes(j));
    const f1 = await this.runJobs(phase1, ctx);
    if (f1) return stop([reasonOf(f1)]);

    const rowsOf = (role: "verification" | "judgement", jobs: Job[]): Map<string, VerdictRow> => this.rowsFrom(role, jobs, responses);
    const protectedVerdicts = { verification: rowsOf("verification", protectedJobs), judgement: rowsOf("judgement", protectedJobs) };
    // The aspects each failing protected rule failed (either model), in the checker's fixed order.
    const aspectFailures = new Map<string, CheckerAspect[]>();
    for (const r of protectedRules) {
      const v = protectedVerdicts.verification.get(r.criterionId);
      const j = protectedVerdicts.judgement.get(r.criterionId);
      if (judgeRule(r, { verification: v, judgement: j }).action !== "keep") aspectFailures.set(r.criterionId, failedAspectsOf(r, v, j));
    }
    const failedIds: string[] = [...aspectFailures.keys()];
    // A protected rule's trigger must be confirmed by BOTH models too, or the draft is held. A rule that
    // fails ONLY its trigger has no failed aspect to hand a re-draft, so it is not repairable.
    const protectedTriggerVerdicts = { verification: this.triggerVerdictsFrom("verification", protectedTriggerJobs, responses), judgement: this.triggerVerdictsFrom("judgement", protectedTriggerJobs, responses) };
    // (#248) A BAR whose every judged aspect BOTH models confirmed but whose trigger they did not is
    // no longer a protected failure: it is served WITHOUT the trigger and is never decided by code
    // (`judgedBarIds`, recorded with the dropped triggers, marked `notCodeDecided` on the read side).
    // Removing a trigger only widens who a rule is put to, so it cannot hide the bar from anyone it
    // covers; not code-deciding it means the wider scope cannot bar anyone wrongly by nationality.
    // Any other protected rule, and a bar that also failed an aspect, are handled exactly as before.
    const judgedBarIds: string[] = [];
    for (const r of protectedTriggered) {
      const verdict = judgeTrigger(r, { verification: protectedTriggerVerdicts.verification.get(r.criterionId), judgement: protectedTriggerVerdicts.judgement.get(r.criterionId) });
      if (verdict !== "hold" || failedIds.includes(r.criterionId)) continue;
      if (servableWithoutTrigger(r)) judgedBarIds.push(r.criterionId);
      else failedIds.push(r.criterionId);
    }
    this.noteVerdicts(ctx, protectedVerdicts.verification, protectedVerdicts.judgement);

    // ---- intention to stay (a failure holds; with a failed bar the report is still completed below) ----
    const extraHoldReasons: string[] = [];
    let intentPolarity: IntentPolarity | null = null;
    if (polarityPlan.kind === "ask") {
      const answers = polarityJobs.map((j) => responses[j.hash]?.answer as PolarityAnswer);
      intentPolarity = decidePolarity(polarityPlan.value, answers);
      if (intentPolarity === null) {
        if (failedIds.length === 0) return stop(["polarity_unverified"]);
        extraHoldReasons.push("polarity_unverified");
      }
    } else intentPolarity = polarityPlan.value;

    // Phase 2: every ordinary rule. (#223) Run EVEN WHEN a protected rule failed, so the held report lists
    // every problem, not just the first. Same code path, same caps, ordinary rules checked once.
    const f2 = await this.runJobs(
      needed.filter((j) => ordinaryJobs.includes(j) || ordinaryTriggerJobs.includes(j)),
      ctx
    );
    if (f2) {
      // The ordinary rules could not be checked: report the failed bars (critical) AND why the run is incomplete.
      if (failedIds.length > 0) return stop([reasonOf(f2)], { protectedRuleIds: failedIds, protectedFailures: this.unrepairedReport(ctx, failedIds, aspectFailures) });
      return stop([reasonOf(f2)]);
    }

    // ---- decide each ordinary rule from its verdicts ----
    const ordinaryVerdicts = rowsOf("verification", ordinaryJobs);
    this.noteVerdicts(ctx, new Map([...protectedVerdicts.verification, ...ordinaryVerdicts]), protectedVerdicts.judgement);
    // (#240) Each leave-out also records WHY: `found_wrong` (a failing verdict is a `no`) or
    // `not_confirmed` (every failing verdict is unsure / na, or there is no verdict to read). A quote
    // that cannot be found in its snapshot was never confirmed by anyone: `not_confirmed`.
    const decided = new Map<string, { reason: string; basis?: LeaveOutBasis }>();
    for (const r of unreadableOrdinary) decided.set(r.criterionId, { reason: "checker:source_text", basis: "not_confirmed" });
    for (const r of readableOrdinary) {
      const row = ordinaryVerdicts.get(r.criterionId);
      const action = judgeRule(r, { verification: row });
      if (action.action !== "keep") decided.set(r.criterionId, { reason: `checker:${action.aspect}`, basis: leaveOutBasis(r, row) });
    }
    // Rulebook order, so the result is stable. (#244) A leave-out has a basis unless it is a covered duplicate.
    const leftOutOf = (map: ReadonlyMap<string, { reason: string; basis?: LeaveOutBasis }>) =>
      rules.filter((r) => map.has(r.criterionId)).map((r) => {
        const d = map.get(r.criterionId) as { reason: string; basis?: LeaveOutBasis };
        return { criterionId: r.criterionId, reason: d.reason, ...(d.basis !== undefined ? { basis: d.basis } : {}) };
      });
    const leftOut = leftOutOf(decided);

    // ---- flag codes this check has fully verified ----
    // Every kept rule's title got `yes` (title always applies), so the title
    // remark is resolved. The two group remarks are resolved when every rule
    // with a group had `yes` on that aspect from BOTH models (a failure held above).
    const resolvedFlagCodes = ["title_wording_uncited", "nationality_codes_model_proposed", "nationality_code_name_mismatch"];
    // ---- triggers to drop (INTEGRATION): ordinary rules still kept whose link was not confirmed ----
    // A rule left out above needs no verdict on its trigger. A dropped trigger never removes the rule.
    const ordinaryTriggerVerdicts = this.triggerVerdictsFrom("verification", ordinaryTriggerJobs, responses);
    const droppedTriggerIds = ordinaryTriggered
      .filter((r) => !decided.has(r.criterionId) && judgeTrigger(r, { verification: ordinaryTriggerVerdicts.get(r.criterionId) }) === "drop")
      .map((r) => r.criterionId);

    // ---- (#223) a protected rule failed: ONE bounded repair of each, then hold unless every bar was repaired ----
    // (#244) PROTECTED repairs run first: a draft held for a bar that could not be repaired spends nothing
    // on the ordinary rules' re-drafts (it is held either way).
    let protectedRepaired: { failures: RubricProtectedFailure[]; repairs: RubricRuleRepair[] } | null = null;
    const replacedJudgedIds: string[] = [];
    // (#248) Every bar served without its trigger, as drafted or as its replacement, in rulebook order: named on the
    // record (held or published) and added to the dropped triggers the question plan records (`droppedTriggerIds`).
    const judgedBarsOf = (): RubricJudgedBar[] => judgedBarRecords(rules, judgedBarIds, replacedJudgedIds, protectedRepaired?.repairs ?? []);
    if (failedIds.length > 0) {
      const rulesById = new Map(protectedRules.map((r) => [r.criterionId, r]));
      const repaired = await this.repairFailed(ctx, { failedIds, aspectFailures, rulesById, questions, routeName: rubric.routeKey });
      // (#248) Replacement bars served without their unconfirmed trigger join the ones drafted that way.
      replacedJudgedIds.push(...repaired.judgedIds);
      const unrepaired = repaired.failures.filter((f) => f.repair.status !== "repaired");
      if (unrepaired.length > 0 || extraHoldReasons.length > 0) {
        // Held. When a repair could not FINISH (the provider, or a cap) the reason is that retryable one, so the
        // sweep may finish the job (the stored attempts are reused, nothing is paid for twice); otherwise each
        // bar that is still not confirmed is named. The held report carries everything either way.
        const reasons = repaired.infra ? [reasonOf(repaired.infra)] : unrepaired.map((f) => `protected_rule_failed:${f.criterionId}`);
        for (const r of extraHoldReasons) if (!reasons.includes(r)) reasons.push(r);
        const judgedBars = judgedBarRecords(rules, judgedBarIds, replacedJudgedIds, repaired.repairs);
        return stop(reasons, { protectedRuleIds: unrepaired.map((f) => f.criterionId), protectedFailures: repaired.failures, leftOut, ...(judgedBars.length > 0 ? { judgedBars } : {}) });
      }
      // Every failed bar has a replacement that BOTH models confirmed and code validated: the run goes on.
      protectedRepaired = { failures: repaired.failures, repairs: repaired.repairs };
    }

    // ---- (#244) the ONE re-draft of each ordinary rule the check found WRONG ----
    // Eligible: a leave-out of the check with at least one `no` on title, kind, condition or check, that code did
    // not already leave out (a code leave-out keeps its own reason). A rule with only `unsure` verdicts is not
    // re-drafted: a re-draft cannot add the context the check lacked.
    const codeLeft = new Set(input.codeLeftOutIds);
    const eligible: { rule: AssessmentCriterion; aspects: CheckerAspect[] }[] = [];
    for (const r of readableOrdinary) {
      if (!decided.has(r.criterionId) || codeLeft.has(r.criterionId)) continue;
      const aspects = ordinaryRepairAspects(r, ordinaryVerdicts.get(r.criterionId));
      if (aspects) eligible.push({ rule: r, aspects });
    }
    // The rules that stay served exactly as drafted: what a replacement is compared with for duplicates (a
    // protected rule counts through its replacement).
    const protectedReplacement = new Map((protectedRepaired?.repairs ?? []).map((x) => [x.criterionId, x.replacement]));
    const eligibleIds = new Set(eligible.map((e) => e.rule.criterionId));
    const servedAsDrafted = rules.filter((r) => !decided.has(r.criterionId) && !codeLeft.has(r.criterionId) && !eligibleIds.has(r.criterionId)).map((r) => protectedReplacement.get(r.criterionId) ?? r);
    const ordinary = await this.repairOrdinary(ctx, { eligible, servedAsDrafted, ordinaryVerdicts, questions, routeName: rubric.routeKey });
    // A repaired rule is no longer left out; a covered one is left out as a (not counted) duplicate.
    for (const id of ordinary.repairedIds) decided.delete(id);
    for (const [id] of ordinary.coveredIds) decided.set(id, { reason: REDRAFT_DUPLICATE_REASON });

    await this.persist(ctx, "completed", []);
    const judgedBars = judgedBarsOf();
    // (#248) The bars' triggers are dropped like an ordinary rule's (the plan records them); the read side
    // tells them apart by kind and marks them `notCodeDecided`. Rulebook order, each id once.
    const judgedIdSet = new Set(judgedBars.map((b) => b.criterionId));
    const allDropped = rules.filter((r) => judgedIdSet.has(r.criterionId) || droppedTriggerIds.includes(r.criterionId)).map((r) => r.criterionId);
    return {
      ok: true,
      leftOut: leftOutOf(decided),
      resolvedFlagCodes,
      intentPolarity,
      droppedTriggerIds: allDropped,
      ...(judgedBars.length > 0 ? { judgedBars } : {}),
      ...(protectedRepaired || ordinary.repairs.length > 0 ? { repairs: [...(protectedRepaired?.repairs ?? []), ...ordinary.repairs] } : {}),
      ...(protectedRepaired ? { protectedFailures: protectedRepaired.failures } : {}),
      ...(eligible.length > 0 ? { ordinaryRepairs: { counts: ordinary.counts, records: ordinary.records } } : {}),
      // (no `requests` when nothing was repaired: the checker's own record holds the spend)
      ...(protectedRepaired || ctx.repairRequests > 0 ? { requests: this.requestsOf(ctx) } : {}),
    };
  }

  /** `{total, repair}` requests of this run (the request counter includes repair requests). */
  private requestsOf(ctx: RunContext): { total: number; repair: number } {
    return { total: ctx.usage.requests, repair: ctx.repairRequests };
  }

  /**
   * The held report's entry for each failed bar when NO repair was tried
   * (the run could not finish checking the ordinary rules): the verdicts of both
   * models, and why nothing was attempted.
   */
  private unrepairedReport(ctx: RunContext, failedIds: readonly string[], aspectFailures: ReadonlyMap<string, CheckerAspect[]>): RubricProtectedFailure[] {
    return failedIds.map((id) => this.failureRecord(ctx, ctx.rules.find((r) => r.criterionId === id) as AssessmentCriterion, aspectFailures.get(id) ?? [], "not_attempted", "check_incomplete", 0));
  }

  /** One protected failure's record (see RubricProtectedFailure). */
  private failureRecord(ctx: RunContext, rule: AssessmentCriterion, aspects: readonly CheckerAspect[], status: RubricRepairStatus, detail: string | undefined, requests: number): RubricProtectedFailure {
    return {
      criterionId: rule.criterionId,
      ruleRef: rule.ruleRef ?? null,
      title: rule.title,
      failedAspects: [...aspects],
      verdicts: { ...(ctx.verdicts[rule.criterionId] ?? {}) },
      repair: { status, ...(detail !== undefined ? { detail } : {}), ruleHash: ruleHashOf(rule), requests },
    };
  }

  // ---------- (#223) the one repair of each failed protected rule ----------

  /**
   * Repair each failed protected rule ONCE, then check only the replacements.
   *
   *  1. More failed bars than `repairMaxRulesPerRun` (or the cap is 0): something
   *     systemic. No re-draft is attempted; every bar is reported not-attempted.
   *  2. A bar that failed ONLY the trigger check has no failed aspect to give a
   *     re-draft, and an "unsure" on something a re-draft cannot change stays a
   *     failure: not attempted, held.
   *  3. For each other failed bar, in rulebook order, ONE re-draft request
   *     (`redraftRule`: the drafting path, the rule's own source passage). A stored
   *     result for the same rule hash is reused (idempotent: a re-delivered trigger,
   *     a sweep retry and an admin re-run never re-draft twice). Only a FINISHED
   *     attempt is stored; a provider failure or a cap stores nothing and is not
   *     counted as the rule's attempt.
   *  4. The replacements that passed code validation are checked by BOTH models
   *     (and their trigger, when they carry one), in batches. They are judged by
   *     the SAME `judgeRule` / `judgeTrigger` as the original. The checker's
   *     standards, thresholds and the meaning of "unsure" are untouched.
   *
   * Every request counts in the run's counters and against its caps.
   */
  private async repairFailed(
    ctx: RunContext,
    p: { failedIds: readonly string[]; aspectFailures: ReadonlyMap<string, CheckerAspect[]>; rulesById: ReadonlyMap<string, AssessmentCriterion>; questions: NonNullable<VisaRubric["intakeQuestions"]>; routeName: string }
  ): Promise<{ failures: RubricProtectedFailure[]; repairs: RubricRuleRepair[]; infra: JobFailure | null; judgedIds: string[] }> {
    const failures = new Map<string, RubricProtectedFailure>();
    // (#248) Replacement bars served without their unconfirmed trigger (judged, never code-decided).
    const judgedIds: string[] = [];
    const redraftRequests = new Map<string, number>();
    const rule = (id: string): AssessmentCriterion => p.rulesById.get(id) as AssessmentCriterion;
    const setFailure = (id: string, status: RubricRepairStatus, detail?: string): void => {
      failures.set(id, this.failureRecord(ctx, rule(id), p.aspectFailures.get(id) ?? [], status, detail, redraftRequests.get(id) ?? 0));
    };
    let infra: JobFailure | null = null;

    // ---- 1 + 2. which failed bars may be repaired at all ----
    const tooMany = p.failedIds.length > ctx.caps.repairMaxRulesPerRun;
    const eligible: string[] = [];
    for (const id of p.failedIds) {
      if (tooMany) setFailure(id, "not_attempted", ctx.caps.repairMaxRulesPerRun === 0 ? "repair_disabled" : "cap_exceeded");
      else if ((p.aspectFailures.get(id) ?? []).length === 0) setFailure(id, "not_attempted", "trigger_not_repairable");
      else eligible.push(id);
    }

    // ---- 3. the one re-draft of each eligible bar ----
    const pendingCheck: AssessmentCriterion[] = [];
    // (#240) Replacements drafted in THIS run, apart from the ones replayed from an earlier run. A request is
    // a pure function of its batch, so batching a replay together with a new replacement would change the
    // replay's request hash and pay for its check again. Each group is batched on its own.
    const freshIds = new Set<string>();
    for (const id of eligible) {
      if (infra) {
        setFailure(id, "attempt_unfinished", "earlier_attempt_unfinished");
        continue;
      }
      const original = rule(id);
      const hash = ruleHashOf(original);
      let stored = ctx.repairs[id];
      // (#240) A stored attempt is reused for the same rule hash under the CURRENT repair prompt version.
      // An attempt made under an OLDER version that did not produce a replacement (the model said it
      // cannot be repaired, or code refused the re-draft: the guard and the prompt have changed since)
      // gets ONE more try; the new attempt is stored with the current version, so a rule is never
      // re-drafted twice under one version. A stored REPLACEMENT is always replayed (its check comes
      // from the stored answers, zero requests) whatever its version: a bar already repaired and
      // confirmed must not be re-drafted just because the prompt text moved on.
      const staleAttempt = stored !== undefined && stored.promptVersion !== RUBRIC_REPAIR_PROMPT_VERSION && stored.kind !== "replacement";
      if (!stored || stored.ruleHash !== hash || staleAttempt) {
        const result = await this.redraftOnce(ctx, original, p.aspectFailures.get(id) ?? [], p.routeName);
        if (result.kind === "infra") {
          infra = result.failure;
          redraftRequests.set(id, result.requests);
          setFailure(id, "attempt_unfinished", result.failure);
          continue;
        }
        stored = result.stored;
        freshIds.add(id);
        ctx.repairs[id] = stored;
        // The finished attempt is stored NOW: a crash after this line still never re-drafts this rule again.
        await this.persist(ctx, "failed", []);
      }
      redraftRequests.set(id, stored.requests);
      if (stored.kind === "cannot_be_repaired") setFailure(id, "cannot_be_repaired");
      else if (stored.kind === "invalid") setFailure(id, "invalid_redraft", stored.detail);
      else pendingCheck.push(stored.replacement as AssessmentCriterion);
    }

    // ---- 4. the replacements are checked by both models, and judged by the same table ----
    const repairs: RubricRuleRepair[] = [];
    if (pendingCheck.length > 0 && !infra) {
      const views = await this.at(ctx.stage, "snapshot_read", () => this.buildViews(pendingCheck, ctx.indexes, ctx.input.rubric));
      const checkable = pendingCheck.filter((r) => views.has(r.criterionId));
      for (const r of pendingCheck) if (!views.has(r.criterionId)) setFailure(r.criterionId, "invalid_redraft", "quote_unverifiable");
      const triggered = checkable.filter((r) => r.trigger !== undefined && isValidTrigger(r.trigger, p.questions));
      const jobs: Job[] = [];
      const replayed = (r: AssessmentCriterion) => !freshIds.has(r.criterionId);
      for (const role of ["verification", "judgement"] as const) {
        for (const group of [checkable.filter(replayed), checkable.filter((r) => !replayed(r))]) {
          jobs.push(...this.batchJobs(role, group, views, ctx.limits));
          jobs.push(...this.triggerJobs(role, triggered.filter((r) => group.includes(r)), views, p.questions, ctx.limits));
        }
      }
      // A replacement's check made by an earlier run of this version is replayed from its stored answers
      // (same request hash, same model), never asked for again.
      for (const j of jobs) {
        const hit = ctx.reusable[j.hash];
        if (!ctx.responses[j.hash] && hit && hit.model === ctx.models[j.role] && hit.role === j.role) ctx.responses[j.hash] = hit;
      }
      const need = jobs.filter((j) => !ctx.responses[j.hash]);
      const before = ctx.usage.requests;
      const failure = await this.runJobs(need, ctx);
      ctx.repairRequests += ctx.usage.requests - before;
      if (failure) {
        infra = failure;
        for (const r of checkable) setFailure(r.criterionId, "attempt_unfinished", failure);
      } else {
        const rowsV = (role: "verification" | "judgement") => this.rowsFrom(role, jobs, ctx.responses);
        const verification = rowsV("verification");
        const judgement = rowsV("judgement");
        const trigV = this.triggerVerdictsFrom("verification", jobs, ctx.responses);
        const trigJ = this.triggerVerdictsFrom("judgement", jobs, ctx.responses);
        for (const r of checkable) {
          const v = verification.get(r.criterionId);
          const j = judgement.get(r.criterionId);
          const aspectsFailed = judgeRule(r, { verification: v, judgement: j }).action === "keep" ? [] : failedAspectsOf(r, v, j);
          const triggerFailed = triggered.includes(r) && judgeTrigger(r, { verification: trigV.get(r.criterionId), judgement: trigJ.get(r.criterionId) }) === "hold";
          // (#248) A replacement BAR that passed every judged aspect with both models but whose trigger was
          // not confirmed is REPAIRED and served without the trigger, judged and never code-decided (the
          // same reasoning as a bar drafted that way, in `checkInner`). The detail says so on the record.
          // Any other replacement whose trigger failed is `failed_check` / `trigger_not_confirmed` as before.
          const judgedWithoutTrigger = triggerFailed && aspectsFailed.length === 0 && servableWithoutTrigger(r);
          const status: RubricRepairStatus = aspectsFailed.length === 0 && (!triggerFailed || judgedWithoutTrigger) ? "repaired" : "failed_check";
          const detail = judgedWithoutTrigger ? JUDGED_BAR_DETAIL : triggerFailed && aspectsFailed.length === 0 ? "trigger_not_confirmed" : undefined;
          const base = this.failureRecord(ctx, rule(r.criterionId), p.aspectFailures.get(r.criterionId) ?? [], status, detail, redraftRequests.get(r.criterionId) ?? 0);
          failures.set(r.criterionId, { ...base, repair: { ...base.repair, replacementFailedAspects: aspectsFailed, replacementVerdicts: { ...(v ? { verification: encodeRow(v) } : {}), ...(j ? { judgement: encodeRow(j) } : {}) } } });
          if (base.repair.status === "repaired") repairs.push({ criterionId: r.criterionId, replacement: r, originalRuleHash: ruleHashOf(rule(r.criterionId)), runId: ctx.input.runId });
          if (judgedWithoutTrigger) judgedIds.push(r.criterionId);
        }
      }
    }
    // Rulebook order, like every other list of this run.
    return { failures: p.failedIds.map((id) => failures.get(id) as RubricProtectedFailure), repairs, infra, judgedIds };
  }

  /**
   * ONE re-draft request of one bar, with every guard the checker's own requests
   * have: the run clock, the request cap (retries count), the input cap (an
   * estimate before, the real figure after). Returns the finished attempt to
   * store, or the infrastructure failure that stopped it (nothing is stored then).
   */
  private async redraftOnce(ctx: RunContext, rule: AssessmentCriterion, aspects: readonly CheckerAspect[], routeName: string, tally?: { n: number }): Promise<{ kind: "done"; stored: StoredRedraft } | { kind: "infra"; failure: JobFailure; requests: number }> {
    if (this.deps.nowMs() - ctx.startedMs > CHECKER_START_DEADLINE_MS) return { kind: "infra", failure: "unavailable_deadline", requests: 0 };
    // The request cap counts the re-draft; so does the input cap (the prompt is the drafting prompt plus a bounded window).
    const estimateChars = RUBRIC_SYSTEM_PROMPT.length + 2 * REPAIR_WINDOW_CHARS + 5_000;
    if (ctx.usage.requests >= ctx.caps.checkerMaxRequestsPerRun || ctx.usage.inputChars + estimateChars > ctx.caps.checkerMaxInputCharsPerRun) return { kind: "infra", failure: "capped", requests: 0 };

    const index = await this.at(ctx.stage, "snapshot_read", async () => {
      const key = `${rule.source.sourceId}:${rule.source.contentHash}`;
      let ready = ctx.indexes.get(key);
      if (!ready) {
        ready = this.deps.readSnapshot(rule.source.sourceId, rule.source.contentHash).then((c) => indexInItsLanguage(c, ctx.input.rubric, rule.source.sourceId));
        ctx.indexes.set(key, ready);
      }
      return ready;
    });
    const used: RubricRunUsageShape = { requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    // The drafting call's own transient retry counts against what is left of the run's request cap.
    const attempts = { failed: 0, cap: ctx.caps.checkerMaxRequestsPerRun - ctx.usage.requests };
    const args: RedraftArgs = { rule, aspects, index, routeName, limits: ctx.limits, sent: { chars: 0 } };
    const account = (lastFailed = false): number => {
      // Every request, answered or failed, is a request; its tokens were billed. The drafting call counts
      // an answered request and each RETRIED failure, but not the final failure it throws: `lastFailed` adds it.
      const n = used.requests + attempts.failed + (lastFailed ? 1 : 0);
      ctx.usage.requests += n;
      ctx.repairRequests += n;
      if (tally) tally.n += n;
      ctx.usage.inputChars += args.sent.chars;
      addUsage(ctx.usage, { inputTokens: used.inputTokens, outputTokens: used.outputTokens, cacheReadTokens: used.cacheReadTokens, cacheWriteTokens: used.cacheWriteTokens });
      return n;
    };
    const finish = (outcome: RedraftOutcome, requests: number): { kind: "done"; stored: StoredRedraft } => ({
      kind: "done",
      stored: {
        ruleHash: ruleHashOf(rule),
        kind: outcome.kind === "replacement" ? "replacement" : outcome.kind,
        ...(outcome.kind === "invalid" ? { detail: outcome.detail } : {}),
        ...(outcome.kind === "replacement" ? { replacement: outcome.criterion } : {}),
        requests,
        promptVersion: RUBRIC_REPAIR_PROMPT_VERSION,
        // (#244) Whether the replacement quotes the original's own line (only an ordinary rule can differ).
        ...(outcome.kind === "replacement" && outcome.sameLine !== undefined ? { sameLine: outcome.sameLine } : {}),
      },
    });
    try {
      const outcome = await this.deps.redraft(ctx.provider, args, used, attempts, { deadlineAt: ctx.startedMs + 540_000, nowMs: this.deps.nowMs, sleep: this.deps.sleep });
      return finish(outcome, account());
    } catch (err) {
      const requests = account(err instanceof RunStop && err.reasonCode === "provider_error");
      if (err instanceof RunStop) {
        // No key, or the provider could not be reached: not an attempt (nothing is stored; a retry may try).
        if (err.reasonCode === "ai_not_configured") return { kind: "infra", failure: "unavailable_not_configured", requests };
        if (err.reasonCode === "provider_error") return { kind: "infra", failure: "unavailable_provider", requests };
        // The model answered but not usably (declined, cut off, wrong shape): that WAS the one attempt.
        return finish({ kind: "invalid", detail: err.reasonCode }, requests);
      }
      throw err;
    }
  }

  // ---------- (#244) the one repair of each ordinary rule the check found wrong ----------

  /**
   * Re-draft each eligible ordinary rule ONCE, check only the replacements, serve the ones that pass.
   *
   * The same machinery as a bar's repair (the drafting path of `redraftRule`, the stored-attempt ledger, the
   * same `judgeRule` / `judgeTrigger` tables) with three differences, all because an ordinary rule is not a bar:
   *   - ONE model reads the replacement (the verification model, as it read the original), not two;
   *   - a replacement may quote the lead-in of the list its original was one item of (`redraftRule` allows it
   *     for ordinary rules, never for bars), so replacements can COINCIDE: see "duplicates" below;
   *   - nothing here can HOLD the draft. Whatever goes wrong (a refused re-draft, a failed re-check, a cap, the
   *     clock, the provider) the original stays left out EXACTLY as before this step existed: never served,
   *     still counted against the budget. A run never fails because of this step; it only keeps fewer rules.
   *
   * STAGES, in an order chosen so that nothing is paid for twice and the check of replacements always has room:
   *   0. guard: eligible rules over `ordinaryRepairMaxShare` of the draft, or over `ordinaryRepairMaxRules`,
   *      are a systemic fault, not single wrong rules: NO ordinary rule is re-drafted (`skipped: too_many`).
   *   1. a stored attempt of this version (same rule hash, same repair prompt version) is REUSED: a stored
   *      refusal is not asked again, a stored replacement is checked from its stored verdicts (or, when those
   *      were never stored, checked now). A re-delivered trigger, a sweep retry and an admin re-run therefore
   *      never re-draft a rule twice. Only a FINISHED attempt is stored; a provider that could not be reached
   *      stores nothing, so it is not the rule's one attempt.
   *   2. fresh re-drafts, in waves of `CHECKER_CONCURRENCY`, only as many as the request cap and the input cap
   *      leave room for INCLUDING the check of their replacements (`affordableRedrafts`); each wave is stored
   *      before the next starts, and no wave starts after `CHECKER_START_DEADLINE_MS`. The rest are
   *      `notAttempted`, with `cutOff` saying why; the sweep resumes them (see the pipeline).
   *   3. the fresh replacements are checked, in batches, by the verification model, and their triggers by the
   *      trigger check; each result is stored on the attempt the moment it is known.
   *   4. duplicates (below), then the verdict of each rule.
   *
   * DUPLICATES. Several items of one definition can all come back as the same lead-in rule, and a replacement
   * can say what a rule that is already served says. A confirmed replacement that is the SAME RULE as another
   * served rule is NOT served twice: "the same rule" is the duplicate gate's own test (`possibleDuplicateFlags`:
   * quotes with at least 80 % of their words in common) AND the same scope (`sameScope`: the same applicability,
   * trigger or condition; a rule that applies to other applicants is another rule). A PROTECTED rule covers a
   * replacement whatever its scope (the gate would otherwise hold the draft over the pair). Candidates are
   * taken in rulebook order, the first one is served, every later one is covered by it:
   *   - covered by a rule served as drafted: its original is left out as `checker:redraft_duplicate`;
   *   - covered by an earlier replacement: same, and the surviving repair records `alsoReplaced` (the question
   *     and evidence links of the covered original are re-pointed by `applyRuleRepairs`).
   * A covered original is NOT counted against the leave-out budget (like `possible_duplicate`: the rule that
   * stays says the same, so no information is lost). Never silently merged: each is a line of the run record.
   *
   * Returns what to change in the check's decisions; mutates nothing but the context's counters and ledger.
   */
  private async repairOrdinary(ctx: RunContext, p: OrdinaryRepairInput): Promise<OrdinaryRepairResult> {
    const counts: RubricOrdinaryRepairCounts = { eligible: p.eligible.length, attempted: 0, repaired: 0, failedCheck: 0, invalid: 0, mergedDuplicates: 0, checkPending: 0, notAttempted: 0, requests: { redraft: 0, check: 0 } };
    const records = new Map<string, RubricOrdinaryRepair>();
    if (p.eligible.length === 0) return { repairs: [], repairedIds: [], coveredIds: new Map(), records: [], counts };

    const aspectsOf = new Map(p.eligible.map((e) => [e.rule.criterionId, e.aspects]));
    const ruleOf = new Map(p.eligible.map((e) => [e.rule.criterionId, e.rule]));
    /** One rule's line of the run record (the last write for a rule wins). */
    const note = (id: string, status: RubricOrdinaryRepair["repair"]["status"], extra: Partial<RubricOrdinaryRepair["repair"]> = {}): void => {
      records.set(id, this.ordinaryLine(ctx, p, id, status, extra));
    };
    /** The cause of a cut-off, from the job failure that stopped the work (the first one stays). */
    const cut = (f: JobFailure): void => {
      counts.cutOff ??= f === "capped" ? "capped" : f === "unavailable_deadline" ? "deadline" : "provider";
    };
    /** Rules without a finished re-draft: recorded as not attempted, with the reason. */
    const skipRest = (ids: readonly string[], detail: string): void => {
      for (const id of ids) note(id, "not_attempted", { detail });
    };

    // ---- 0. the systemic guard ----
    if (p.eligible.length > ctx.rules.length * ctx.caps.ordinaryRepairMaxShare || p.eligible.length > ctx.caps.ordinaryRepairMaxRules) {
      counts.skipped = "too_many";
      skipRest([...ruleOf.keys()], "too_many");
      return this.finishOrdinary(ctx, p, records, counts, [], new Map());
    }

    // ---- 1. stored attempts of this version ----
    const replacements = new Map<string, AssessmentCriterion>();
    const fresh: string[] = [];
    for (const { rule } of p.eligible) {
      const id = rule.criterionId;
      const stored = ctx.repairs[id];
      // A stored attempt is reused for the same rule hash under the CURRENT repair prompt version. One made
      // under an OLDER version that gave no replacement (the guard and the prompt have changed since) gets
      // ONE more try, stored with the current version. A stored REPLACEMENT is always reused: its check is
      // stored with it, and a rule must not be re-drafted just because the prompt text moved on.
      const stale = stored !== undefined && stored.promptVersion !== RUBRIC_REPAIR_PROMPT_VERSION && stored.kind !== "replacement";
      if (!stored || stored.ruleHash !== ruleHashOf(rule) || stale) {
        fresh.push(id);
        continue;
      }
      if (stored.kind === "cannot_be_repaired") note(id, "cannot_be_repaired");
      else if (stored.kind === "invalid") note(id, "invalid_redraft", { detail: stored.detail });
      else replacements.set(id, stored.replacement as AssessmentCriterion);
    }

    // ---- the check of replacements an earlier run stored (free when their verdicts are stored with them) ----
    const checked = new Map<string, ReplacementCheck>();
    if (replacements.size > 0) {
      const done = await this.checkReplacements(ctx, [...replacements.values()], p.questions);
      for (const [id, c] of done.results) checked.set(id, c);
      for (const id of done.unverifiable) note(id, "invalid_redraft", { detail: "quote_unverifiable" });
      if (done.failure) cut(done.failure);
    }

    // ---- 2. fresh re-drafts, in waves, within what the caps and the clock leave ----
    const allowed = Math.min(fresh.length, this.affordableRedrafts(ctx, fresh.length));
    const queue = fresh.slice(0, allowed);
    if (allowed < fresh.length) {
      cut("capped");
      skipRest(fresh.slice(allowed), "cap_exceeded");
    }
    const drafted = new Set<string>();
    const tally = { n: 0 };
    let stopped = false;
    for (let i = 0; i < queue.length && !stopped; i += CHECKER_CONCURRENCY) {
      if (this.deps.nowMs() - ctx.startedMs > CHECKER_START_DEADLINE_MS) {
        cut("unavailable_deadline");
        skipRest(queue.slice(i), "deadline");
        break;
      }
      const wave = queue.slice(i, i + CHECKER_CONCURRENCY);
      const results = await Promise.all(wave.map((id) => this.redraftOnce(ctx, ruleOf.get(id) as AssessmentCriterion, aspectsOf.get(id) ?? [], p.routeName, tally)));
      wave.forEach((id, k) => {
        const result = results[k];
        if (result.kind === "infra") {
          // Nothing is stored for a provider failure or a cap: it was not the rule's one attempt.
          cut(result.failure);
          stopped = true;
          note(id, "not_attempted", { detail: result.failure });
          return;
        }
        ctx.repairs[id] = result.stored;
        drafted.add(id);
        if (result.stored.kind === "cannot_be_repaired") note(id, "cannot_be_repaired");
        else if (result.stored.kind === "invalid") note(id, "invalid_redraft", { detail: result.stored.detail });
        else replacements.set(id, result.stored.replacement as AssessmentCriterion);
      });
      // The finished attempts are stored NOW (a crash after this line never re-drafts these rules again).
      await this.persist(ctx, "failed", []);
      // The rest of the queue was never started.
      if (stopped) skipRest(queue.slice(i + CHECKER_CONCURRENCY), "provider");
    }
    ctx.ordinaryRedraftRequests += tally.n;
    counts.requests.redraft = tally.n;

    // ---- 3. the check of the fresh replacements ----
    const freshReplacements = [...replacements].filter(([id]) => drafted.has(id)).map(([, r]) => r);
    if (freshReplacements.length > 0) {
      const done = await this.checkReplacements(ctx, freshReplacements, p.questions);
      for (const [id, c] of done.results) checked.set(id, c);
      for (const id of done.unverifiable) note(id, "invalid_redraft", { detail: "quote_unverifiable" });
      if (done.failure) cut(done.failure);
      await this.persist(ctx, "failed", []);
    }

    return this.finishOrdinary(ctx, p, records, counts, [...replacements], checked);
  }

  /** One rule's line of the ordinary-repair record (see `RubricOrdinaryRepair`). */
  private ordinaryLine(ctx: RunContext, p: OrdinaryRepairInput, id: string, status: RubricOrdinaryRepair["repair"]["status"], extra: Partial<RubricOrdinaryRepair["repair"]> = {}): RubricOrdinaryRepair {
    const entry = p.eligible.find((e) => e.rule.criterionId === id) as { rule: AssessmentCriterion; aspects: CheckerAspect[] };
    const row = p.ordinaryVerdicts.get(id);
    const sameLine = ctx.repairs[id]?.sameLine;
    return {
      criterionId: id,
      ruleRef: entry.rule.ruleRef ?? null,
      title: entry.rule.title,
      failedAspects: [...entry.aspects],
      verdicts: { ...(row ? { verification: encodeRow(row) } : {}) },
      repair: { status, ruleHash: ruleHashOf(entry.rule), requests: ctx.repairs[id]?.requests ?? 0, ...(sameLine !== undefined && status !== "not_attempted" ? { sameLine } : {}), ...extra },
    };
  }

  /**
   * Stage 4 of `repairOrdinary`: decide each replacement from its check, apply the duplicate rule, fill in the
   * counts. A replacement with no check result yet is `attempt_unfinished` (a stored attempt, a rule that stays
   * left out for now).
   */
  private finishOrdinary(
    ctx: RunContext,
    p: OrdinaryRepairInput,
    records: Map<string, RubricOrdinaryRepair>,
    counts: RubricOrdinaryRepairCounts,
    replacementEntries: readonly (readonly [string, AssessmentCriterion])[],
    checked: ReadonlyMap<string, ReplacementCheck>
  ): OrdinaryRepairResult {
    const repairs: RubricRuleRepair[] = [];
    const repairedIds: string[] = [];
    const coveredIds = new Map<string, string>();
    const put = (id: string, status: RubricOrdinaryRepair["repair"]["status"], extra: Partial<RubricOrdinaryRepair["repair"]> = {}): void => {
      records.set(id, this.ordinaryLine(ctx, p, id, status, extra));
    };
    // The rules a confirmed replacement may duplicate: rules served as drafted first, then earlier replacements.
    const served: AssessmentCriterion[] = [...p.servedAsDrafted];
    const surviving = new Map<string, RubricRuleRepair>();
    // Rulebook order: the first of several coinciding replacements is the one served.
    const order = new Map(ctx.rules.map((r, i) => [r.criterionId, i]));
    const entries = [...replacementEntries].sort((a, b) => (order.get(a[0]) ?? 0) - (order.get(b[0]) ?? 0));
    for (const [id, replacement] of entries) {
      // A replacement that turned protected, or that does not keep its id, is never served (defence in depth:
      // `redraftRule` already refuses both for an ordinary original).
      if (isProtectedRule(replacement) || replacement.criterionId !== id) {
        put(id, "invalid_redraft", { detail: "became_protected" });
        continue;
      }
      const c = checked.get(id);
      if (!c) {
        put(id, "attempt_unfinished", { detail: "check_unfinished" });
        continue;
      }
      const replacementVerdicts = { verification: encodeRow(c.row) };
      if (c.aspectsFailed.length > 0 || c.triggerFailed) {
        put(id, "failed_check", { replacementFailedAspects: c.aspectsFailed, replacementVerdicts, ...(c.aspectsFailed.length === 0 ? { detail: "trigger_not_confirmed" } : {}) });
        continue;
      }
      // ---- confirmed: is it the same rule as one that is already served? ----
      const twin = served.find((other) => sameRuleAs(replacement, other));
      if (twin) {
        coveredIds.set(id, twin.criterionId);
        // Covered by an earlier replacement: that one stands for this original too.
        const keeper = surviving.get(twin.criterionId);
        if (keeper) keeper.alsoReplaced = [...(keeper.alsoReplaced ?? []), id];
        put(id, "merged_duplicate", { coveredBy: twin.criterionId, replacementVerdicts });
        continue;
      }
      served.push(replacement);
      const original = p.eligible.find((e) => e.rule.criterionId === id)?.rule as AssessmentCriterion;
      const repair: RubricRuleRepair = { criterionId: id, replacement, originalRuleHash: ruleHashOf(original), runId: ctx.input.runId };
      repairs.push(repair);
      repairedIds.push(id);
      surviving.set(id, repair);
      put(id, "repaired", { replacementVerdicts });
    }
    // A rule the run never reached has no line yet (a wave cut short): record it, so every eligible rule has one.
    for (const { rule } of p.eligible) if (!records.has(rule.criterionId)) records.set(rule.criterionId, this.ordinaryLine(ctx, p, rule.criterionId, "not_attempted"));
    // ---- the counts, from the records (the one source) ----
    const lines = [...records.values()];
    const n = (...s: RubricOrdinaryRepair["repair"]["status"][]): number => lines.filter((l) => s.includes(l.repair.status)).length;
    counts.repaired = n("repaired");
    counts.failedCheck = n("failed_check");
    counts.invalid = n("invalid_redraft", "cannot_be_repaired");
    counts.mergedDuplicates = n("merged_duplicate");
    counts.checkPending = n("attempt_unfinished");
    counts.attempted = counts.repaired + counts.failedCheck + counts.invalid + counts.mergedDuplicates + counts.checkPending;
    counts.notAttempted = counts.eligible - counts.attempted;
    counts.requests.check = ctx.ordinaryCheckRequests;
    // Rulebook order, like every other list of this run.
    return { repairs, repairedIds, coveredIds, records: p.eligible.map((e) => records.get(e.rule.criterionId) as RubricOrdinaryRepair), counts };
  }

  /**
   * How many fresh re-drafts this run can still afford: each needs one request, and the replacements they
   * produce need their check (one batch per `CHECKER_BATCH_SIZE`, one trigger batch per
   * `CHECKER_TRIGGER_BATCH_SIZE`, plus a little slack for a batch split), all inside the request cap; the
   * same in prompt characters inside the input cap. Reserving the check's share up front is what keeps a run
   * from spending its whole budget on re-drafts it then cannot check (the replacement would be stored but
   * unused until a later run).
   */
  private affordableRedrafts(ctx: RunContext, wanted: number): number {
    const capRequests = ctx.caps.checkerMaxRequestsPerRun;
    const capChars = ctx.caps.checkerMaxInputCharsPerRun;
    for (let n = wanted; n > 0; n--) {
      const checkRequests = Math.ceil(n / CHECKER_BATCH_SIZE) + Math.ceil(n / CHECKER_TRIGGER_BATCH_SIZE) + ORDINARY_CHECK_RESERVE_SLACK;
      const requestsOk = ctx.usage.requests + n + checkRequests <= capRequests;
      const charsOk = ctx.usage.inputChars + n * REDRAFT_EST_CHARS + checkRequests * CHECK_REQUEST_EST_CHARS <= capChars;
      if (requestsOk && charsOk) return n;
    }
    return 0;
  }

  /**
   * The verification model's reading of ordinary replacements (and of their triggers), with every guard the
   * checker's own requests have. A reading stored on the attempt (same model, same checker prompt version) is
   * used WITHOUT a request; the rest are asked in batches of `CHECKER_BATCH_SIZE` in rulebook order, reusing
   * any answer of this version already stored under the same request hash. Returns each replacement's result,
   * the replacements whose quote cannot be found again (`unverifiable`), and the first failure that stopped
   * the asking. A replacement whose answer did not arrive has no result (the caller records it unfinished).
   */
  private async checkReplacements(
    ctx: RunContext,
    replacements: readonly AssessmentCriterion[],
    questions: NonNullable<VisaRubric["intakeQuestions"]>
  ): Promise<{ results: Map<string, ReplacementCheck>; unverifiable: string[]; failure: JobFailure | null }> {
    const results = new Map<string, ReplacementCheck>();
    const unverifiable: string[] = [];
    // ---- readings already stored on the attempt ----
    const needed: AssessmentCriterion[] = [];
    for (const r of replacements) {
      const stored = ctx.repairs[r.criterionId]?.ordinaryCheck;
      const row = stored && stored.model === ctx.models.verification && stored.checkerPromptVersion === CHECKER_PROMPT_VERSION ? decodeRow(stored.row) : null;
      if (stored && row) {
        const trig = stored.trigger === "yes" || stored.trigger === "no" || stored.trigger === "unsure" ? stored.trigger : undefined;
        results.set(r.criterionId, this.replacementResult(r, row, trig, trig !== undefined));
      } else needed.push(r);
    }
    if (needed.length === 0) return { results, unverifiable, failure: null };

    const views = await this.at(ctx.stage, "snapshot_read", () => this.buildViews(needed, ctx.indexes, ctx.input.rubric));
    const checkable = needed.filter((r) => views.has(r.criterionId));
    for (const r of needed) if (!views.has(r.criterionId)) unverifiable.push(r.criterionId);
    const triggered = checkable.filter((r) => r.trigger !== undefined && isValidTrigger(r.trigger, questions));
    const jobs: Job[] = [...this.batchJobs("verification", checkable, views, ctx.limits), ...this.triggerJobs("verification", triggered, views, questions, ctx.limits)];
    // An answer of an earlier run of this version under the same request hash is reused, never asked again.
    for (const j of jobs) {
      const hit = ctx.reusable[j.hash];
      if (!ctx.responses[j.hash] && hit && hit.model === ctx.models[j.role] && hit.role === j.role) ctx.responses[j.hash] = hit;
    }
    const before = ctx.usage.requests;
    const failure = await this.runJobs(
      jobs.filter((j) => !ctx.responses[j.hash]),
      ctx
    );
    const spent = ctx.usage.requests - before;
    ctx.repairRequests += spent;
    ctx.ordinaryCheckRequests += spent;
    // Whatever answered is used, even when a later batch failed.
    const rows = this.rowsFrom("verification", jobs, ctx.responses);
    const trig = this.triggerVerdictsFrom("verification", jobs, ctx.responses);
    for (const r of checkable) {
      const row = rows.get(r.criterionId);
      const isTriggered = triggered.includes(r);
      const tv = trig.get(r.criterionId);
      if (!row || (isTriggered && tv === undefined)) continue;
      results.set(r.criterionId, this.replacementResult(r, row, tv, isTriggered));
      // Stored on the attempt now: the next run reads it without asking.
      const attempt = ctx.repairs[r.criterionId];
      if (attempt) attempt.ordinaryCheck = { model: ctx.models.verification, checkerPromptVersion: CHECKER_PROMPT_VERSION, row: encodeRow(row), ...(tv !== undefined ? { trigger: tv } : {}) };
    }
    return { results, unverifiable, failure };
  }

  /** What the checker's table says about one replacement: the aspects it still fails, and whether its trigger was not confirmed. */
  private replacementResult(r: AssessmentCriterion, row: VerdictRow, trigger: TriggerVerdict | undefined, triggered: boolean): ReplacementCheck {
    const aspectsFailed = judgeRule(r, { verification: row }).action === "keep" ? [] : failedAspectsOf(r, row);
    // A replacement with a usable trigger must have it confirmed too (`judgeTrigger`: ordinary rule, `yes` only).
    const triggerFailed = triggered && judgeTrigger(r, { verification: trigger }) !== "keep";
    return { row, aspectsFailed, triggerFailed };
  }

  // ---------- windows ----------

  /**
   * For every rule: its quote and the bounded words around it, read from the
   * snapshot it was cited to. A rule whose quote is not in that snapshot is
   * absent from the result (it cannot be verified). A snapshot that cannot be
   * READ throws: the official text is unavailable, not the rule unfaithful.
   */
  private async buildViews(rules: readonly AssessmentCriterion[], indexes: Map<string, Promise<SnapshotQuoteIndex>> = new Map(), rubric?: Pick<VisaRubric, "sourceSnapshots" | "intakeQuestions">): Promise<Map<string, CheckerRuleView>> {
    const indexOf = (sourceId: string, hash: string): Promise<SnapshotQuoteIndex> => {
      const key = `${sourceId}:${hash}`;
      let p = indexes.get(key);
      if (!p) {
        p = this.deps.readSnapshot(sourceId, hash).then((c) => indexInItsLanguage(c, rubric, sourceId));
        indexes.set(key, p);
      }
      return p;
    };
    const views = new Map<string, CheckerRuleView>();
    for (const rule of rules) {
      const index = await indexOf(rule.source.sourceId, rule.source.contentHash);
      const found = index.locate(rule.source.quote);
      if (!found.ok) continue;
      // (#222) A quote that ends with a lead-in is only shown with its list:
      // the stored items must be exactly the lines the snapshot has after it.
      // A lead-in without verified items (or items that no longer match the
      // snapshot) has no view, so it cannot pass: a protected rule holds, an
      // ordinary rule is left out (`checker:source_text`).
      if (rule.source.listItems !== undefined ? !verifyListItems(index, found, rule.source.listItems).ok : quoteIsLeadIn(index, found)) continue;
      views.set(rule.criterionId, viewOf(rule, index, found, rubric?.intakeQuestions ?? []));
    }
    return views;
  }

  // ---------- jobs ----------

  /** Batches of CHECKER_BATCH_SIZE in rulebook order, for one model role. */
  private batchJobs(role: "verification" | "judgement", rules: readonly AssessmentCriterion[], views: Map<string, CheckerRuleView>, limits: { maxOutputTokens: number; timeoutMs: number }): Job[] {
    const jobs: Job[] = [];
    for (let i = 0; i < rules.length; i += CHECKER_BATCH_SIZE) {
      const batch = rules.slice(i, i + CHECKER_BATCH_SIZE);
      const request = buildBatchRequest(role, batch.map((r) => views.get(r.criterionId) as CheckerRuleView), limits);
      jobs.push({ request, role, hash: llmRequestHash(request), criterionIds: batch.map((r) => r.criterionId) });
    }
    return jobs;
  }

  /** Batches of CHECKER_TRIGGER_BATCH_SIZE rules with a usable trigger, in rulebook order, for one model role. */
  private triggerJobs(role: "verification" | "judgement", rules: readonly AssessmentCriterion[], views: Map<string, CheckerRuleView>, questions: NonNullable<VisaRubric["intakeQuestions"]>, limits: { maxOutputTokens: number; timeoutMs: number }): Job[] {
    const jobs: Job[] = [];
    for (let i = 0; i < rules.length; i += CHECKER_TRIGGER_BATCH_SIZE) {
      const batch = rules.slice(i, i + CHECKER_TRIGGER_BATCH_SIZE);
      const triggerViews: TriggerCheckView[] = batch.map((r) => {
        const q = questions.find((x) => x.id === r.trigger?.questionId);
        return { rule: r, listLeadIn: views.get(r.criterionId)?.listLeadIn ?? "", question: { label: q?.label ?? "", options: (q?.options ?? []).map((o) => ({ value: o.value, label: o.label })) } };
      });
      const request = buildTriggerRequest(role, triggerViews, limits);
      jobs.push({ request, role, hash: llmRequestHash(request), criterionIds: batch.map((r) => r.criterionId), triggerBatch: true });
    }
    return jobs;
  }

  /** One polarity reading job. */
  private polarityJob(role: "verification" | "judgement", quote: string, limits: { maxOutputTokens: number; timeoutMs: number }): Job {
    const request = buildPolarityRequest(role, quote, limits);
    return { request, role, hash: llmRequestHash(request) };
  }

  /**
   * Decide what to do about the route's intention-to-stay reading.
   *  - a stated value: its quote must be in its cited snapshot, and both
   *    models are asked about that quote ALONE;
   *  - no proposal (extraction drops `not_assessed`) or `not_assessed`:
   *    accepted only when no rule that could be kept is about an intention;
   *  - anything else is unverified.
   */
  private async planPolarity(
    rubric: VisaRubric,
    codeLeftOutIds: readonly string[],
    _limits: { maxOutputTokens: number; timeoutMs: number }
  ): Promise<{ kind: "ask"; value: Exclude<IntentPolarity, "not_assessed">; quote: string } | { kind: "fixed"; value: IntentPolarity } | { kind: "unverified" }> {
    const proposal = rubric.intentPolarityProposal;
    if (!proposal || proposal.value === "not_assessed") {
      const left = new Set(codeLeftOutIds);
      const concerned = rubric.criteria.some((c) => c.concernsIntent === true && !left.has(c.criterionId));
      return concerned ? { kind: "unverified" } : { kind: "fixed", value: "not_assessed" };
    }
    const cite = proposal.source;
    if (!cite) return { kind: "unverified" };
    const index = new SnapshotQuoteIndex(await this.deps.readSnapshot(cite.sourceId, cite.contentHash));
    if (!index.locate(cite.quote).ok) return { kind: "unverified" };
    return { kind: "ask", value: proposal.value, quote: cite.quote };
  }

  /**
   * Run jobs in waves of CHECKER_CONCURRENCY. After each wave the answers so
   * far are stored (a cut-off run resumes). Returns the failure of the FIRST
   * job (in job order) that failed, or null when all answered.
   */
  private async runJobs(jobs: Job[], ctx: RunContext): Promise<JobFailure | null> {
    for (let i = 0; i < jobs.length; i += CHECKER_CONCURRENCY) {
      // The clock: no new wave once the run has used its start budget.
      if (this.deps.nowMs() - ctx.startedMs > CHECKER_START_DEADLINE_MS) return "unavailable_deadline";
      const wave = jobs.slice(i, i + CHECKER_CONCURRENCY);
      const results = await Promise.all(wave.map((j) => this.execute(j, ctx)));
      // Progress first (even a failed wave's good answers), then the verdict on the wave.
      await this.persist(ctx, "failed", []);
      const failed = results.find((r) => r !== null);
      if (failed) return failed;
    }
    return null;
  }

  /** One request with the one retry. Stores a closed answer under its hash. */
  private async execute(job: Job, ctx: RunContext): Promise<JobFailure | null> {
    for (let attempt = 1; attempt <= 2; attempt++) {
      // The request cap counts retries too.
      if (ctx.usage.requests >= ctx.caps.checkerMaxRequestsPerRun) return "capped";
      ctx.usage.requests += 1;
      ctx.usage.inputChars += job.request.system.length + job.request.user.length;
      let response;
      try {
        response = await ctx.provider.complete(job.request);
      } catch (err) {
        if (err instanceof AnthropicNotConfiguredError) return "unavailable_not_configured";
        const transient = err instanceof LlmProviderError && isTransientProviderError(err.message);
        if (transient && attempt < 2) {
          await this.deps.sleep(CHECKER_RETRY_BACKOFF_MS * attempt);
          continue;
        }
        return "unavailable_provider";
      }
      addUsage(ctx.usage, response.usage);
      // A declined answer is "the check could not run"; a cut-off or odd stop is an incomplete answer.
      if (response.stopReason === "refusal") return "unavailable_provider_refused";
      if (response.stopReason !== "end_turn") return "invalid";
      try {
        if (job.triggerBatch && job.criterionIds) {
          const handles = job.criterionIds.map((_, k) => handleFor(k));
          const verdicts = parseTriggerVerdicts(response.text, handles);
          const stored: Record<string, string> = {};
          for (const [h, v] of verdicts) stored[h] = v;
          ctx.responses[job.hash] = { role: job.role, model: ctx.models[job.role], triggers: stored };
        } else if (job.criterionIds) {
          const handles = job.criterionIds.map((_, k) => handleFor(k));
          const rows = parseVerdicts(response.text, handles);
          const stored: Record<string, string> = {};
          for (const [h, row] of rows) stored[h] = encodeRow(row);
          ctx.responses[job.hash] = { role: job.role, model: ctx.models[job.role], rows: stored };
        } else {
          ctx.responses[job.hash] = { role: job.role, model: ctx.models[job.role], answer: parsePolarityAnswer(response.text) };
        }
        return null;
      } catch (err) {
        if (err instanceof CheckerAnswerError) return "invalid";
        throw err;
      }
    }
    return "unavailable_provider";
  }

  /** The verdict rows of one role's rule batches, keyed by criterion id, from the stored answers. */
  private rowsFrom(role: "verification" | "judgement", jobs: Job[], responses: Record<string, StoredResponse>): Map<string, VerdictRow> {
    const out = new Map<string, VerdictRow>();
    for (const job of jobs) {
      if (job.role !== role || !job.criterionIds || job.triggerBatch) continue;
      const stored = responses[job.hash]?.rows;
      job.criterionIds.forEach((id, k) => {
        const row = decodeRow(stored?.[handleFor(k)]);
        if (row) out.set(id, row);
      });
    }
    return out;
  }

  /** The trigger verdicts of one role's trigger batches, keyed by criterion id; a missing or odd stored value is absent. */
  private triggerVerdictsFrom(role: "verification" | "judgement", jobs: Job[], responses: Record<string, StoredResponse>): Map<string, TriggerVerdict> {
    const out = new Map<string, TriggerVerdict>();
    for (const job of jobs) {
      if (job.role !== role || !job.criterionIds || !job.triggerBatch) continue;
      const stored = responses[job.hash]?.triggers;
      job.criterionIds.forEach((id, k) => {
        const v = stored?.[handleFor(k)];
        if (v === "yes" || v === "no" || v === "unsure") out.set(id, v);
      });
    }
    return out;
  }

  // ---------- results ----------

  /** A protected rule failed: the draft is held, never left out. */
  private protectedFailure(ids: string[]): RubricCheckOutcomeShape {
    return { ok: false, reasonCodes: ids.map((id) => `protected_rule_failed:${id}`), protectedRuleIds: ids };
  }

  /** Remember the per-rule verdicts for the record. */
  private noteVerdicts(ctx: RunContext, verification: Map<string, VerdictRow>, judgement: Map<string, VerdictRow>): void {
    for (const [id, row] of verification) ctx.verdicts[id] = { ...ctx.verdicts[id], verification: encodeRow(row) };
    for (const [id, row] of judgement) ctx.verdicts[id] = { ...ctx.verdicts[id], judgement: encodeRow(row) };
  }

  /** Write the record: answers (reuse), verdicts, spend. Skipped when nothing was sent and nothing is stored yet. */
  private async persist(ctx: RunContext, status: "completed" | "failed", reasonCodes: string[]): Promise<void> {
    // Nothing was sent this run: whatever is stored (a full set of answers) stays untouched.
    if (ctx.usage.requests === 0) return;
    // `lifetimeBase` is what earlier runs spent; this run's spend so far is added on top.
    const total = { ...ctx.lifetimeBase };
    addUsage(total, ctx.usage);
    const record: RubricCheckerRun = {
      repairs: ctx.repairs,
      runId: ctx.input.runId,
      routeKey: ctx.input.routeKey,
      version: ctx.input.version,
      promptVersion: CHECKER_PROMPT_VERSION,
      models: ctx.models,
      day: ctx.day,
      reachedModel: true,
      status,
      reasonCodes,
      responses: ctx.responses,
      ruleVerdicts: ctx.verdicts,
      rules: ctx.rules.length,
      usage: { ...ctx.usage },
      lifetimeUsage: total,
      updatedAtMs: this.deps.nowMs(),
    };
    await this.at(ctx.stage, "ledger", () => this.deps.ledger.save(record));
  }
}

/**
 * (#242) What the check is shown for ONE rule whose quote was found: the words
 * around the quote, plus where the applicability condition comes from, all read
 * by CODE from the stored snapshot (never written by a model): the headings above
 * the quote, and where the condition's own words are written. A rule with no
 * condition has none to place. The trigger's question and the labels of the
 * selected answers are those the trigger check shows; a rule with no usable
 * trigger gets none. Pure (no I/O): the offline preview script calls it too, so
 * what it prints is exactly what a run sends.
 */
export function viewOf(rule: AssessmentCriterion, index: SnapshotQuoteIndex, found: Extract<QuoteLookup, { ok: true }>, questions: NonNullable<VisaRubric["intakeQuestions"]>): CheckerRuleView {
  const around = index.contextAround(found, CHECKER_WINDOW_CHARS);
  const sectionHeadings = index.headingsAbove(found, CHECKER_MAX_HEADINGS, CHECKER_HEADING_CHARS);
  const scoped = rule.applicability !== undefined && rule.applicability !== "all_applicants" && rule.applicabilityCondition !== undefined;
  const site = scoped ? index.conditionSite(found, rule.applicabilityCondition as string, sectionHeadings, CHECKER_CONDITION_LINE_CHARS) : undefined;
  const question = rule.trigger !== undefined && isValidTrigger(rule.trigger, questions) ? questions.find((q) => q.id === rule.trigger?.questionId) : undefined;
  return {
    rule,
    listLeadIn: index.listLeadIn(found, CHECKER_LEAD_IN_CHARS),
    textBefore: around.before,
    textAfter: around.after,
    sectionHeadings,
    ...(site ? { conditionFoundAt: site.at } : {}),
    ...(site?.line !== undefined ? { conditionLine: site.line } : {}),
    ...(question && rule.trigger ? { trigger: { question: question.label, answers: selectedAnswerLabels(question.options ?? [], rule.trigger.anyOf) } } : {}),
  };
}

/**
 * (#220) A snapshot prepared for lookups, read in the language its source was
 * registered in (recorded on the version's `sourceSnapshots`). The language
 * decides how numbers and dates in a quote are read, which the one-rule
 * re-draft validates with; locating a quote is language neutral.
 */
function indexInItsLanguage(content: GuidanceSnapshotContent, rubric: Pick<VisaRubric, "sourceSnapshots"> | undefined, sourceId: string): SnapshotQuoteIndex {
  return new SnapshotQuoteIndex(content, lexiconFor(rubric?.sourceSnapshots?.find((s) => s.sourceId === sourceId)?.language));
}

/** Everything one run shares. */
interface RunContext {
  provider: LlmProvider;
  caps: RubricPublishSettings;
  responses: Record<string, StoredResponse>;
  usage: CheckerUsage;
  startedMs: number;
  models: { verification: string; judgement: string };
  input: RubricCheckInputShape;
  rules: readonly AssessmentCriterion[];
  day: string;
  verdicts: Record<string, { verification?: string; judgement?: string }>;
  lifetimeBase: CheckerUsage;
  // What the check is doing now (the detail of `checker_unavailable:<what>`).
  stage: StageBox;
  // The per-request limits of this run (the re-draft uses the same).
  limits: { maxOutputTokens: number; timeoutMs: number };
  // Prepared snapshots of this run, shared by the check and the re-draft.
  indexes: Map<string, Promise<SnapshotQuoteIndex>>;
  // (#223) Finished re-drafts by rule id (loaded from the ledger, written back by `persist`).
  repairs: Record<string, StoredRedraft>;
  // Model requests of this run spent on repair (re-drafts and the check of replacements).
  repairRequests: number;
  // (#244) Of those, the ordinary rules' re-drafts and the check of their replacements (the run record shows them).
  ordinaryRedraftRequests: number;
  ordinaryCheckRequests: number;
  // The stored answers of an earlier run of this version that may be reused (same prompt version).
  reusable: Record<string, StoredResponse>;
}

/** The check, over Firestore, the snapshot store and the Anthropic provider. */
export const rubricChecker = new RubricCheckerService();
