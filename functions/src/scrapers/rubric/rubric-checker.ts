import { collections } from "../../utils/firebase";
import { AnthropicNotConfiguredError } from "../../services/ai/anthropic-client";
import { AnthropicLlmProvider, LlmProviderError, emptyLlmUsage, llmRequestHash, type LlmProvider, type LlmRequest, type LlmUsage } from "../../services/ai/llm-provider";
import type { AssessmentCriterion, IntentPolarity, LeaveOutBasis, RubricProtectedFailure, RubricRepairStatus, RubricRuleRepair, VisaRubric } from "../../types/rubric";
import { isValidTrigger } from "../../utils/rubric-trigger";
import { guidanceSnapshotStore } from "../guidance/guidance-snapshot.store";
import type { GuidanceSnapshotContent } from "../guidance/types";
import { isProtectedRule } from "./rubric-gates";
import {
  CHECKER_ASPECTS,
  CHECKER_BATCH_SIZE,
  CHECKER_LEAD_IN_CHARS,
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
  type CheckerAspect,
  type CheckerRuleView,
  type PolarityAnswer,
  type TriggerCheckView,
  type TriggerVerdict,
  type VerdictRow,
} from "./rubric-checker-prompt";
import { loadPublishSettings, type LoadedPublishSettings, type RubricPublishSettings } from "./rubric-publish-settings";
import { lexiconFor } from "../language/language-lexicon";
import { SnapshotQuoteIndex } from "./rubric-quote";
import { quoteIsLeadIn, verifyListItems } from "./rubric-list-items";
import { RubricExtractionService, RunStop, isTransientProviderError, type RedraftOutcome } from "./rubric-extraction.service";
import { RUBRIC_REPAIR_PROMPT_VERSION, RUBRIC_SYSTEM_PROMPT } from "./rubric-prompt";
import { REPAIR_WINDOW_CHARS, ruleHashOf } from "./rubric-repair";

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
      reusable,
    };
    const stop = async (reasonCodes: string[], extra: { protectedRuleIds?: string[]; protectedFailures?: RubricProtectedFailure[]; leftOut?: { criterionId: string; reason: string; basis?: LeaveOutBasis }[] } = {}): Promise<RubricCheckOutcomeShape> => {
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
    for (const r of protectedTriggered) {
      const verdict = judgeTrigger(r, { verification: protectedTriggerVerdicts.verification.get(r.criterionId), judgement: protectedTriggerVerdicts.judgement.get(r.criterionId) });
      if (verdict === "hold" && !failedIds.includes(r.criterionId)) failedIds.push(r.criterionId);
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
    const decided = new Map<string, { reason: string; basis: LeaveOutBasis }>();
    for (const r of unreadableOrdinary) decided.set(r.criterionId, { reason: "checker:source_text", basis: "not_confirmed" });
    for (const r of readableOrdinary) {
      const row = ordinaryVerdicts.get(r.criterionId);
      const action = judgeRule(r, { verification: row });
      if (action.action !== "keep") decided.set(r.criterionId, { reason: `checker:${action.aspect}`, basis: leaveOutBasis(r, row) });
    }
    // Rulebook order, so the result is stable.
    const leftOut = rules.filter((r) => decided.has(r.criterionId)).map((r) => ({ criterionId: r.criterionId, ...(decided.get(r.criterionId) as { reason: string; basis: LeaveOutBasis }) }));

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

    if (failedIds.length === 0) {
      await this.persist(ctx, "completed", []);
      // (no `requests` here: with no failed bar there was no repair, and the checker's own record holds the spend)
      return { ok: true, leftOut, resolvedFlagCodes, intentPolarity, droppedTriggerIds };
    }

    // ---- (#223) a protected rule failed: ONE bounded repair of each, then hold unless every bar was repaired ----
    const rulesById = new Map(protectedRules.map((r) => [r.criterionId, r]));
    const repaired = await this.repairFailed(ctx, { failedIds, aspectFailures, rulesById, questions, routeName: rubric.routeKey });
    const unrepaired = repaired.failures.filter((f) => f.repair.status !== "repaired");
    if (unrepaired.length === 0 && extraHoldReasons.length === 0) {
      // Every failed bar has a replacement that BOTH models confirmed and code validated: the run goes on.
      await this.persist(ctx, "completed", []);
      return { ok: true, leftOut, resolvedFlagCodes, intentPolarity, droppedTriggerIds, repairs: repaired.repairs, protectedFailures: repaired.failures, requests: this.requestsOf(ctx) };
    }
    // Held. When a repair could not FINISH (the provider, or a cap) the reason is that retryable one, so the
    // sweep may finish the job (the stored attempts are reused, nothing is paid for twice); otherwise each
    // bar that is still not confirmed is named. The held report carries everything either way.
    const reasons = repaired.infra ? [reasonOf(repaired.infra)] : unrepaired.map((f) => `protected_rule_failed:${f.criterionId}`);
    for (const r of extraHoldReasons) if (!reasons.includes(r)) reasons.push(r);
    return stop(reasons, { protectedRuleIds: unrepaired.map((f) => f.criterionId), protectedFailures: repaired.failures, leftOut });
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
  ): Promise<{ failures: RubricProtectedFailure[]; repairs: RubricRuleRepair[]; infra: JobFailure | null }> {
    const failures = new Map<string, RubricProtectedFailure>();
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
          const base = this.failureRecord(ctx, rule(r.criterionId), p.aspectFailures.get(r.criterionId) ?? [], aspectsFailed.length === 0 && !triggerFailed ? "repaired" : "failed_check", triggerFailed && aspectsFailed.length === 0 ? "trigger_not_confirmed" : undefined, redraftRequests.get(r.criterionId) ?? 0);
          failures.set(r.criterionId, { ...base, repair: { ...base.repair, replacementFailedAspects: aspectsFailed, replacementVerdicts: { ...(v ? { verification: encodeRow(v) } : {}), ...(j ? { judgement: encodeRow(j) } : {}) } } });
          if (base.repair.status === "repaired") repairs.push({ criterionId: r.criterionId, replacement: r, originalRuleHash: ruleHashOf(rule(r.criterionId)), runId: ctx.input.runId });
        }
      }
    }
    // Rulebook order, like every other list of this run.
    return { failures: p.failedIds.map((id) => failures.get(id) as RubricProtectedFailure), repairs, infra };
  }

  /**
   * ONE re-draft request of one bar, with every guard the checker's own requests
   * have: the run clock, the request cap (retries count), the input cap (an
   * estimate before, the real figure after). Returns the finished attempt to
   * store, or the infrastructure failure that stopped it (nothing is stored then).
   */
  private async redraftOnce(ctx: RunContext, rule: AssessmentCriterion, aspects: readonly CheckerAspect[], routeName: string): Promise<{ kind: "done"; stored: StoredRedraft } | { kind: "infra"; failure: JobFailure; requests: number }> {
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

  // ---------- windows ----------

  /**
   * For every rule: its quote and the bounded words around it, read from the
   * snapshot it was cited to. A rule whose quote is not in that snapshot is
   * absent from the result (it cannot be verified). A snapshot that cannot be
   * READ throws: the official text is unavailable, not the rule unfaithful.
   */
  private async buildViews(rules: readonly AssessmentCriterion[], indexes: Map<string, Promise<SnapshotQuoteIndex>> = new Map(), rubric?: Pick<VisaRubric, "sourceSnapshots">): Promise<Map<string, CheckerRuleView>> {
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
      const around = index.contextAround(found, CHECKER_WINDOW_CHARS);
      views.set(rule.criterionId, { rule, listLeadIn: index.listLeadIn(found, CHECKER_LEAD_IN_CHARS), textBefore: around.before, textAfter: around.after });
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
  // The stored answers of an earlier run of this version that may be reused (same prompt version).
  reusable: Record<string, StoredResponse>;
}

/** The check, over Firestore, the snapshot store and the Anthropic provider. */
export const rubricChecker = new RubricCheckerService();
