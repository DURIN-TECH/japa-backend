import { Timestamp } from "firebase-admin/firestore";
import { collections, subcollections } from "../utils/firebase";
// The scrapers module is reached through its public entry point only (the
// ESLint boundary rule of issue #91).
import {
  acknowledgementsFor,
  applyExclusions,
  applyRuleRepairs,
  buildExclusionNote,
  evaluateGates,
  evaluateRubricAutoPublished,
  evaluateRubricDraftHeld,
  evaluateRubricHeldCleared,
  // (#248) The repair detail of a replacement bar served without its unconfirmed trigger.
  JUDGED_BAR_DETAIL,
  loadPublishSettings,
  loadRegistrySettings,
  productLanguageCode,
  reasonInWords,
  RubricQuestionPlanner,
  // (#233 P4b) The layer check of an own layer against its shared layer(s).
  RubricLayerChecker,
  notCheckedRecord,
  rubricStore,
  routeAllowed,
  rubricChecker,
  ruleHashOf,
  sampleAudit,
  scrapeAlertService,
} from "../scrapers";
import type { GateReport, LayerCheckInput, LayerCheckOutcome, LoadedPublishSettings, RubricAlertRule, RubricPublishAlertFacts, RuleEvaluation, ScrapeAlertsConfig, SharedLayerRules } from "../scrapers";
// (#233 P4b) The route's stack, read live (the resolver itself, not the module index, which also loads admin routes).
import { resolveRouteStack } from "../shared-routes/route-stack";
import { EMAIL_BRANDING } from "./email/branding";
import {
  RubricReviewError,
  parseRubricVersionId,
  reviewFlagsFor,
  rubricReviewService,
  rubricVersionId,
  sourceNeedsExclusionConfirmation,
  structuralErrors,
  type RubricDecisionResult,
  type RubricReviewService,
} from "./rubric-review.service";
import {
  JUDGED_BAR_NOTE,
  RUBRIC_ACTOR_KIND,
  RUBRIC_SYSTEM_ACTOR_ID,
  type IntentPolarity,
  type LayerCheckRecord,
  type RubricJudgedBar,
  type RubricHead,
  type RubricProtectedFailure,
  type RubricPublishGateResult,
  type RubricPublishLeftOut,
  type RubricPublishRun,
  type RubricPublishTrigger,
  type RubricReviewActor,
  type RubricOrdinaryRepair,
  type RubricOrdinaryRepairCounts,
  type RubricRuleRepair,
  type VisaRubric,
} from "../types/rubric";

// ============================================
// AUTOMATIC RUBRIC PUBLISHING — THE PIPELINE (issue #201, part of #200)
// ============================================
//
// There is NO human sign-off any more: when `appConfig/rubricPublishSettings`
// says `mode: "auto"`, a freshly written `pending_review` rulebook version is
// run through automatic safeguards and, if every one passes, published by the
// named system actor. A draft that fails is HELD: the serving version keeps
// serving, nothing changes for applicants, admins are alerted. An admin can
// still reject, roll back (part D) or publish a held draft by hand.
//
// ---- What happens, in order (one `run`) ----
//   1. Settings (fail closed): missing doc -> manual; unreadable -> manual and
//      the run records `settings_unreadable`. `manual` does nothing at all: no
//      record, no check, no alert (today's behaviour).
//   2. Idempotency: one record per version, `rubricPublishRuns/{routeKey}__v{n}`
//      (deterministic id, written with `create()`). A re-delivered trigger on a
//      decided version returns at once.
//   3. The pure code gates (scrapers/rubric/rubric-gates.ts): structure,
//      suspicious passages, flags, shrink guard, leave-out budget, protected
//      rules. They decide which rules are LEFT OUT (the existing exclusion
//      mechanism; a rule is never edited) or HOLD the draft.
//   4. The two plug-in points. Part B (#202) supplies the INDEPENDENT AI CHECK
//      (`RubricChecker`), part C (#203) the QUESTION PLAN (`QuestionPlanner`).
//      Until both exist, `auto` HOLDS every draft (`checker_not_configured`,
//      `question_plan_missing`), so nothing can go live from part A alone.
//   5. Publish: the SAME approval transaction a human approval uses
//      (`RubricReviewService.decideAs`) with the system actor. Every existing
//      invariant (newest version only, sources unchanged, stale citations,
//      structural validation, flags acknowledged, primary leave-outs
//      confirmed, pending only) is enforced there, not here. This file has no
//      second path that writes `reviewStatus: "approved"` or moves the head.
//   6. After a publish: older pending versions of the route are rejected by the
//      system (`superseded_by_newer_version`); one alert per publish; held
//      alerts of the route are resolved. After a hold: one alert.
//
// ---- Fail closed everywhere ----
// Any error leaves the draft pending and the serving version untouched, is
// recorded (`pipeline_error`) and alerted. Nothing here throws into the
// extraction that wrote the draft or into a Firestore trigger. An alert
// failure never fails or undoes a publish (`scrapeAlertService.raise` never
// throws, and every call is wrapped again).
//
// Generic: nothing here names a country, route, nationality or publisher.

// ============================================
// Plug-in points (parts B and C)
// ============================================

/** What the independent check is given. It must never edit or add a rule. */
export interface RubricCheckInput {
  routeKey: string;
  version: number;
  // The run record id (`{routeKey}__v{version}`): the key the checker stores its verdicts under.
  runId: string;
  // The draft exactly as stored (UNFILTERED: every extracted rule).
  rubric: VisaRubric;
  // Rules the code gates already leave out; the check need not look at them.
  codeLeftOutIds: readonly string[];
}

/**
 * What the independent check returns (part B, #202). It can only SUBTRACT or
 * HOLD: it never changes a rule and never adds one.
 *  - `ok: true`   the check ran. `leftOut` are ordinary rules to leave out with
 *                 the failed aspect (`checker:<aspect>`); `resolvedFlagCodes`
 *                 are the flag codes it has fully verified (every title, every
 *                 group mapping); `intentPolarity` is the verified reading on
 *                 an intention to stay, or null when it could not be verified
 *                 (the draft is then held `polarity_unverified`);
 *                 `droppedTriggerIds` are kept rules whose `trigger` (the link to
 *                 the intake answer that makes them apply, #207) the check could not
 *                 confirm: the rule stays, its trigger is ignored (never a leave-out).
 *  - `ok: false`  the draft is held with these reason codes
 *                 (`checker_unavailable`, `checker_capped`,
 *                 `checker_output_invalid`, `protected_rule_failed:<id>`, ...).
 *                 `protectedRuleIds` lists protected rules that failed (critical alert).
 * A checker must not throw; if it does the draft is held `checker_unavailable`.
 */
export type RubricCheckOutcome =
  | {
    ok: true;
    leftOut: { criterionId: string; reason: string }[];
    resolvedFlagCodes: string[];
    intentPolarity: IntentPolarity | null;
    droppedTriggerIds?: string[];
    // (#223) Failed protected rules that were re-drafted once and confirmed by both models: the
    // replacements to record on the version (`ruleRepairs`), and the record of every attempt.
    repairs?: RubricRuleRepair[];
    protectedFailures?: RubricProtectedFailure[];
    // (#244) The automatic re-draft of ordinary rules the check found wrong: counts and a line per eligible
    // rule. The replacements that passed are in `repairs` (the same record as the bars').
    ordinaryRepairs?: { counts: RubricOrdinaryRepairCounts; records: RubricOrdinaryRepair[] };
    // (#248) Bars served without their unconfirmed trigger: judged, never code-decided. Their ids are also
    // in `droppedTriggerIds` (the plan records them; the read side marks them `notCodeDecided`).
    judgedBars?: RubricJudgedBar[];
    requests?: { total: number; repair: number };
  }
  | {
    ok: false;
    reasonCodes: string[];
    protectedRuleIds?: string[];
    // (#223) The complete held report: each protected failure (per-aspect verdicts and the repair
    // attempt), the ordinary rules the check would have left out, and the spend.
    protectedFailures?: RubricProtectedFailure[];
    leftOut?: { criterionId: string; reason: string }[];
    // (#248) On a draft held for ANOTHER reason: the bars that would be served without their trigger.
    judgedBars?: RubricJudgedBar[];
    requests?: { total: number; repair: number };
  };

/** The independent check (part B registers its implementation: see `registerChecker`). */
export interface RubricChecker {
  check(input: RubricCheckInput): Promise<RubricCheckOutcome>;
}

/** What the question planner is given (part C, #203). */
export interface QuestionPlanInput {
  routeKey: string;
  version: number;
  runId: string;
  rubric: VisaRubric;
  // The rules left out so far (code gates plus the check): what the plan is built on.
  excludedCriterionIds: readonly string[];
  // The checker's rule-level leave-outs, so a plan can tell code leave-outs from check ones.
  checkerLeftOut: readonly { criterionId: string; reason: string }[];
  // Rules whose trigger the check could not confirm: the plan records them and ignores their triggers.
  droppedTriggerIds: readonly string[];
}

/**
 * What the planner returns. `reviewFields` are review fields written with the
 * approval (e.g. `questionPlan`); only keys in `PLANNER_WRITABLE_FIELDS`
 * (rubric-review.service.ts) are accepted. `resolvedFlagCodes` carries
 * `intake_wording_uncited` once every question was verified.
 */
export type QuestionPlanOutcome =
  | { ok: true; reviewFields?: Record<string, unknown>; resolvedFlagCodes?: string[] }
  | { ok: false; reasonCodes: string[] };

/** The question planner (part C registers its implementation: see `registerPlanner`). */
export interface QuestionPlanner {
  plan(input: QuestionPlanInput): Promise<QuestionPlanOutcome>;
}

/**
 * (#233 P4b) The layer check (scrapers/rubric/rubric-layer-check.ts): an own
 * layer's rules against the shared layer(s) its route inherits. It NEVER
 * blocks and never throws: what it found (or `not_checked`) is written with
 * the approval as `layerCheck` + `layerConflicts`.
 */
export interface LayerChecker {
  check(input: LayerCheckInput, settingsCaps?: { maxRequests?: number; timeoutMs?: number }): Promise<LayerCheckOutcome>;
}

/**
 * (#233 P4b) The shared layers an OWN layer's route inherits, each with its
 * approved version's served rules (a layer with none approved has
 * `version: null`). Null when the version is not a country's own layer on a
 * route with a shared layer: nothing to check, nothing written (every route
 * without inheritance is exactly as before).
 */
export type SharedLayersReader = (rubric: VisaRubric) => Promise<(Omit<SharedLayerRules, "version"> & { version: number | null })[] | null>;

/** The default reader: the route's stack, read live; each shared layer's approved read. */
export const defaultSharedLayers: SharedLayersReader = async (rubric) => {
  if (!rubric.countryCode || !rubric.visaTypeId) return null; // a shared layer itself: nothing to compare against
  const stack = await resolveRouteStack(rubric.countryCode, rubric.visaTypeId);
  const shared = stack.filter((l) => l.role === "shared");
  if (shared.length === 0) return null;
  return Promise.all(
    shared.map(async (l) => {
      const served = await rubricStore.getApprovedRubricByKey(l.rulebookKey);
      return { rulebookKey: l.rulebookKey, version: served ? served.version : null, criteria: served ? served.criteria : [] };
    })
  );
};

// ============================================
// Types
// ============================================

/** What started a run, and how it behaves. */
export interface RunOptions {
  trigger: RubricPublishTrigger;
  // Report only: write nothing, publish nothing, call no check.
  dryRun?: boolean;
  // Report the code gates only and state the check has not run. Never publishes
  // (publishing without the check would defeat it), so it implies `dryRun`.
  skipChecker?: boolean;
}

/** (#223) What the independent check reports beyond keep / leave out / hold, carried to the record and the alert. */
interface RunExtras {
  protectedFailures?: RubricProtectedFailure[];
  checkerRequests?: { total: number; repair: number };
  // (#244) The ordinary re-draft's counts and per-rule lines, and how it ended when a cap or the clock cut it short.
  ordinaryRepairs?: { counts: RubricOrdinaryRepairCounts; records: RubricOrdinaryRepair[] };
  // (#248) Bars served (or, on a hold, that would be served) without their unconfirmed trigger.
  judgedBars?: RubricJudgedBar[];
  // (#233 P4b) The layer check's record (an own layer on a route with a shared layer): a gate line of the run.
  layerCheck?: LayerCheckRecord;
}

/** The report of one run (also what the admin endpoint and the script return). */
export interface RubricPublishReport {
  runId: string;
  routeKey: string;
  version: number;
  // `skipped` is returned for a manual-mode no-op and for an already decided version.
  outcome: RubricPublishRun["outcome"];
  reasonCodes: string[];
  // The reasons in words (what the alert shows).
  reasons: string[];
  gates: RubricPublishGateResult[];
  counts: RubricPublishRun["counts"];
  leftOut: RubricPublishLeftOut[];
  // The ids that would be / were written as `excludedCriterionIds`.
  plannedExcludedCriterionIds: string[];
  mode: "manual" | "auto";
  trigger: RubricPublishTrigger;
  attempts: number;
  checker: RubricPublishRun["checker"];
  questionPlan: RubricPublishRun["questionPlan"];
  // True when every CODE gate passed (a dry run can show "yes" and still be held for the check).
  codeGatesPassed: boolean;
  dryRun: boolean;
  // True when a run record was written.
  recorded: boolean;
  // INTEGRATION: rules whose trigger the independent check could not confirm (kept, trigger ignored).
  droppedTriggerIds?: string[];
  // (#223) Protected rules the check did not confirm, with the repair attempt of each (also on the run record).
  protectedFailures?: RubricProtectedFailure[];
  // (#244) One line per ordinary rule eligible for the automatic re-draft, with how it ended.
  ordinaryRepairs?: RubricOrdinaryRepair[];
  // (#248) Bars served without their unconfirmed trigger, assessed by judgement (also on the run record).
  barsJudgedWithoutTrigger?: RubricJudgedBar[];
  // (#223) Model requests the check made, repair requests shown apart.
  checkerRequests?: { total: number; repair: number };
  // The audit entry of a publish.
  auditId: string | null;
  previousApprovedVersion: number | null;
}

/** Firestore `create()` on an existing document. */
function isAlreadyExists(err: unknown): boolean {
  const code = (err as { code?: number | string } | null)?.code;
  return code === 6 || code === "already-exists";
}

/** A safe description of an error for the log: its code, else its class. Never the message (it can carry a path). */
function errorClass(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === "string" || typeof code === "number") return `code ${code}`;
  return (err as { constructor?: { name?: string } } | null)?.constructor?.name ?? "unknown error";
}

/** The unresolved-flag reason the question plan (not the rule check) is able to clear (#203). */
const PLAN_RESOLVED_FLAG_REASON = "flag_unresolved:intake_wording_uncited";

/** The repair statuses in plain words (for the alert). */
const REPAIR_IN_WORDS: Record<string, string> = {
  repaired: "re-drafted once from its own source passage and confirmed by both checks",
  failed_check: "re-drafted once, but the checks still did not confirm it",
  cannot_be_repaired: "the re-draft said the passage cannot be drafted into this rule",
  invalid_redraft: "the re-draft did not pass the code checks (its quote or group was not in the official text)",
  not_attempted: "no repair was tried",
  attempt_unfinished: "the repair could not finish (the check will be retried)",
};

/** One failed bar as a line of plain words: its title, reference, the aspects that failed and what the repair did. */
function findingInWords(f: RubricProtectedFailure): string {
  const aspects = f.failedAspects.length > 0 ? `failed ${f.failedAspects.join(", ")}` : "not confirmed";
  // (#248) "Confirmed by both checks" must not be read as covering the trigger: say what happened to it.
  const detail = f.repair.detail === JUDGED_BAR_DETAIL ? `; the rule was confirmed, but ${JUDGED_BAR_NOTE}` : f.repair.detail ? ` (${f.repair.detail})` : "";
  return `${f.title}${f.ruleRef ? ` [${f.ruleRef}]` : ""}: ${aspects}; ${REPAIR_IN_WORDS[f.repair.status] ?? f.repair.status}${detail}. Rule id ${f.criterionId}.`;
}

/**
 * (#248) One bar served without its unconfirmed trigger as a line of plain words: its title, reference,
 * whether it is the re-draft, and the fixed note that it is assessed by judgement, never by code.
 */
export function judgedBarInWords(b: RubricJudgedBar): string {
  return `${b.title}${b.ruleRef ? ` [${b.ruleRef}]` : ""}${b.replaced ? " (its one automatic re-draft)" : ""}: ${JUDGED_BAR_NOTE}. Rule id ${b.criterionId}.`;
}

/** (#248) The run record's gate line naming the bars served without their trigger. Never blocks. */
function judgedBarGate(bars: readonly RubricJudgedBar[]): RubricPublishGateResult {
  return { gate: "bars_judged_without_trigger", passed: true, detail: `${bars.length} bar(s) served without their unconfirmed trigger, assessed by judgement, never decided by code: ${bars.map((b) => b.criterionId).join(", ")}` };
}

/** (#233 P4b) The run record's gate line for the layer check. Never blocks (`passed: true`). */
function layerCheckGate(r: LayerCheckRecord): RubricPublishGateResult {
  if (r.status === "not_checked") return { gate: "layer_check", passed: true, detail: `not_checked:${r.reason ?? "unknown"} (nothing linked; repeated rules stay duplicated; ${r.calls} call(s))` };
  return { gate: "layer_check", passed: true, detail: `${r.ownRulesChecked} own rule(s) against ${r.sharedRulesChecked} shared rule(s): ${r.restates.length} linked as restating, ${r.refusedLinks.length} link(s) refused, ${r.unsure.length} unsure, ${r.conflictCount} conflict(s); ${r.calls} call(s), prompt ${r.promptVersion}` };
}

/** The two leave-out budget reasons (#201). */
const isBudgetReason = (code: string): boolean => code === "leave_out_budget_exceeded" || code === "primary_leave_out_budget_exceeded";

/**
 * (#244) The retryable hold reason for an ordinary re-draft that a cap, the clock or the provider cut short
 * (see the pipeline). `checker_capped` and `checker_unavailable:*` are in `RETRYABLE_REASONS`, so the hourly
 * sweep runs the version again; the next run reuses every stored attempt and has its own request budget.
 */
function retryReasonOfCutOff(cutOff: RubricOrdinaryRepairCounts["cutOff"] | undefined): string | null {
  if (cutOff === "capped") return "checker_capped";
  if (cutOff === "deadline") return "checker_unavailable:deadline";
  if (cutOff === "provider") return "checker_unavailable:provider";
  return null;
}

/**
 * (#244) The ordinary re-draft as one gate line of the run record, in codes and counts. A guard skip is
 * recorded as `ordinary_repair_skipped:too_many`. Never blocks (`passed: true`): nothing in this step can hold
 * a draft; the leave-out budget judges the result.
 */
function ordinaryRepairGate(c: RubricOrdinaryRepairCounts, rules: number): RubricPublishGateResult {
  const spent = `${c.requests.redraft} re-draft + ${c.requests.check} check requests`;
  if (c.skipped) return { gate: "ordinary_repair", passed: true, detail: `ordinary_repair_skipped:${c.skipped} (${c.eligible} eligible of ${rules} rules; no ordinary rule was re-drafted)` };
  return {
    gate: "ordinary_repair",
    passed: true,
    detail: `${c.eligible} eligible: ${c.repaired} repaired, ${c.mergedDuplicates} covered by another rule, ${c.failedCheck} failed the check, ${c.invalid} refused or unrepairable, ${c.checkPending} check pending, ${c.notAttempted} not attempted${c.cutOff ? ` (cut off: ${c.cutOff})` : ""}; ${spent}`,
  };
}

/** The same counts as one sentence for the alert. */
function ordinaryRepairSummaryInWords(c: RubricOrdinaryRepairCounts): string {
  if (c.skipped) return `Ordinary rules found wrong: ${c.eligible} (too many for an automatic re-draft: none was tried).`;
  return `Ordinary rules found wrong: ${c.eligible}; re-drafted once and confirmed ${c.repaired}, covered by another rule ${c.mergedDuplicates}, not confirmed ${c.failedCheck}, refused or unrepairable ${c.invalid}, not tried ${c.notAttempted + c.checkPending}${c.cutOff ? ` (cut off: ${c.cutOff})` : ""}.`;
}

/** The system actor, as the review service takes it. */
const SYSTEM_ACTOR: RubricReviewActor = { kind: RUBRIC_ACTOR_KIND.SYSTEM, id: RUBRIC_SYSTEM_ACTOR_ID };

/** Hold reasons that can clear by themselves, so the hourly sweep retries them (part B, #202). */
// INTEGRATION (#202 + #203): the question planner's own provider failure surfaces as
// `question_plan_unusable` (its wording check could not finish, or answered unusably), which is just as
// transient as the rule check's. The sweep only retried part B's reasons, so a hiccup in the planner left a
// good draft held until someone ran it by hand. At most MAX_SWEEP_ATTEMPTS runs per version still bounds the
// spend. `question_check_capped` is NOT retryable: the same draft would hit the same cap again.
export const RETRYABLE_REASONS: readonly string[] = ["checker_unavailable", "checker_capped", "checker_output_invalid", "question_plan_unusable"];
/** Most runs of one version (the first and the sweep's retries together) before it stays held with its final reason. */
export const MAX_SWEEP_ATTEMPTS = 3;

/** Reason of the system's rejection of an older pending version (at least the 10 characters a reject needs). */
export const SUPERSEDED_REASON = "superseded_by_newer_version";

/** An empty counts block (no gate ran). */
const emptyCounts = (): RubricPublishRun["counts"] => ({ rules: 0, kept: 0, leftOut: 0, leftOutByReason: {}, leftOutFoundWrong: 0, leftOutNotConfirmed: 0, held: 0, informationalFlags: {} });

// ============================================
// Dependencies (replaceable in tests)
// ============================================

export interface RubricAutoPublishDeps {
  loadSettings: () => Promise<LoadedPublishSettings>;
  review: Pick<RubricReviewService, "decideAs" | "knownEligibilityIds">;
  // Raises evaluations through the alert engine; must never throw.
  raiseAlerts: (evals: RuleEvaluation[], config?: ScrapeAlertsConfig) => Promise<unknown>;
  loadAlertConfig: () => Promise<ScrapeAlertsConfig>;
  now: () => Timestamp;
  // The admin portal's base URL (read at call time so APP_URL set per project is honoured).
  appUrl: () => string;
  // (#220) The languages sources may be in: `appConfig/routeOnboardingSettings.supportedLanguages`
  // (default: the product language only). A failed read gives that default, the strictest list.
  loadSupportedLanguages: () => Promise<string[]>;
  // Part B / part C. null until they exist: `auto` then holds every draft.
  checker: RubricChecker | null;
  planner: QuestionPlanner | null;
  // (#233 P4b) The layer check and the read of the shared layers. A null
  // checker writes nothing (and never holds: the check is informational).
  layerChecker: LayerChecker | null;
  sharedLayersOf: SharedLayersReader;
}

/** The facts of one version a run is decided from. */
interface VersionFacts {
  rubric: VisaRubric;
  head: RubricHead;
}

// ============================================
// The service
// ============================================

export class RubricAutoPublishService {
  private readonly deps: RubricAutoPublishDeps;

  constructor(deps: Partial<RubricAutoPublishDeps> = {}) {
    this.deps = {
      loadSettings: loadPublishSettings,
      review: rubricReviewService,
      raiseAlerts: (evals, config) => scrapeAlertService.raise(evals, config),
      loadAlertConfig: () => scrapeAlertService.loadConfig(),
      now: () => Timestamp.now(),
      loadSupportedLanguages: async () => (await loadRegistrySettings()).settings.supportedLanguages,
      appUrl: () => (process.env.APP_URL || EMAIL_BRANDING.appUrl).replace(/\/+$/, ""),
      // PART B (#202) and PART C (#203): put the implementations here, or call
      // `registerChecker` / `registerPlanner` at start-up. Until then both are
      // null and `auto` holds every draft.
      checker: null,
      planner: null,
      layerChecker: null,
      sharedLayersOf: defaultSharedLayers,
      ...deps,
    };
  }

  /** Part B plugs the independent check in here. */
  registerChecker(checker: RubricChecker | null): void {
    this.deps.checker = checker;
  }

  /** Part C plugs the question planner in here. */
  registerPlanner(planner: QuestionPlanner | null): void {
    this.deps.planner = planner;
  }

  /** (#233 P4b) The layer check plugs in here. */
  registerLayerChecker(layerChecker: LayerChecker | null): void {
    this.deps.layerChecker = layerChecker;
  }

  // ---------- Entry points ----------

  /**
   * The Firestore trigger's entry: a `pending_review` version was just
   * created. NEVER throws (a trigger must not retry into a second publish):
   * every failure is recorded as a hold and alerted, or at worst logged.
   */
  async onVersionCreated(routeKey: string, version: number): Promise<RubricPublishReport | null> {
    try {
      return await this.run(routeKey, version, { trigger: "version_created" });
    } catch (err) {
      console.error(`Rubric auto-publish: ${routeKey} v${version} failed outside the pipeline (${errorClass(err)})`);
      return null;
    }
  }

  /**
   * The admin action (`POST /admin/rubrics/:id/auto-publish`) and the script:
   * run the pipeline on an existing pending draft NOW, whatever `mode` says
   * (an explicit action), but still subject to every gate.
   *
   * @throws RubricReviewError 404 (no such version), 409 ALREADY_DECIDED (not
   *   pending), 409 NOT_LATEST_VERSION.
   */
  async runOnDraft(id: string, opts: { dryRun?: boolean; skipChecker?: boolean; trigger?: "admin_endpoint" | "script" } = {}): Promise<RubricPublishReport> {
    const parsed = parseRubricVersionId(id);
    if (!parsed) throw new RubricReviewError("NOT_FOUND", "Rubric version not found", 404);
    return this.run(parsed.routeKey, parsed.version, { trigger: opts.trigger ?? "admin_endpoint", dryRun: opts.dryRun, skipChecker: opts.skipChecker });
  }

  /**
   * The hourly sweep (part B, #202): re-run held drafts whose ONLY reasons are
   * ones that can clear by themselves (the check was unavailable, over a daily
   * cap, or got an unreadable answer), at most `MAX_SWEEP_ATTEMPTS` runs per
   * version in all, only while `mode` is `auto` and the route is allowed. A
   * re-run is the same pipeline (same gates, same shared transaction); the
   * check reuses the batches it already stored, so a retry pays only for what
   * is missing. Never throws; stops starting new runs after `budgetMs`.
   */
  async sweepRetryable(budgetMs = 400_000): Promise<{ considered: number; retried: number }> {
    const out = { considered: 0, retried: 0 };
    try {
      const loaded = await this.deps.loadSettings();
      if (loaded.readError !== undefined || loaded.settings.mode !== "auto") return out;
      const started = Date.now();
      const snap = await collections.rubricPublishRuns.where("outcome", "==", "held").get();
      for (const d of snap.docs) {
        const run = d.data() as RubricPublishRun;
        // (#223) A reason may carry a detail after a colon (`checker_unavailable:provider`): the base code decides.
        const retryable = run.reasonCodes.length > 0 && run.reasonCodes.every((c) => RETRYABLE_REASONS.includes(c.split(":")[0]));
        if (!retryable || run.attempts >= MAX_SWEEP_ATTEMPTS || !routeAllowed(loaded.settings, run.routeKey)) continue;
        out.considered += 1;
        if (Date.now() - started > budgetMs) break;
        try {
          await this.run(run.routeKey, run.version, { trigger: "sweep" });
          out.retried += 1;
        } catch (err) {
          // A version decided or superseded since: nothing to retry.
          console.error(`Rubric auto-publish sweep: ${run.runId} not retried (${errorClass(err)})`);
        }
      }
    } catch (err) {
      console.error(`Rubric auto-publish sweep failed (${errorClass(err)})`);
    }
    return out;
  }

  /**
   * After ANY decision committed (the audit entry in `rubricReviewHistory`,
   * seen by the `onRubricDecisionResolveHeldAlerts` trigger): resolve the held
   * alerts that decision settles. An approval settles every held draft of the
   * route (they are all older); a rejection settles that version's. A reject
   * of a version nobody held is a no-op. Never throws.
   */
  async afterDecision(entry: { action: string; routeKey: string; version: number }): Promise<void> {
    try {
      if (entry.action !== "approve" && entry.action !== "reject") return;
      await this.deps.raiseAlerts([evaluateRubricHeldCleared(entry.routeKey, entry.action === "approve" ? null : entry.version)]);
    } catch (err) {
      console.error(`Rubric auto-publish: resolving held alerts for ${entry.routeKey} failed (${errorClass(err)})`);
    }
  }

  // ---------- The pipeline ----------

  /**
   * One run over one version. See the file header. Throws only the 404 / 409
   * of `runOnDraft` (explicit runs); the trigger entry catches everything.
   */
  async run(routeKey: string, version: number, opts: RunOptions): Promise<RubricPublishReport> {
    const runId = rubricVersionId(routeKey, version);
    const explicit = opts.trigger !== "version_created";
    // `--skip-checker` reports only: it can never publish.
    const dryRun = opts.dryRun === true || opts.skipChecker === true;
    const checkerNotRun = opts.skipChecker === true || dryRun;

    // ---- 1. settings, failing closed ----
    const loaded = await this.deps.loadSettings();
    const settingsUnreadable = loaded.readError !== undefined;
    const mode = loaded.settings.mode;
    if (!explicit && !settingsUnreadable && mode !== "auto") {
      // `manual` (or no settings doc at all): nothing changes from today.
      return this.blankReport(runId, routeKey, version, "skipped", ["mode_manual"], { mode: "manual", trigger: opts.trigger, recorded: false });
    }

    // ---- 2. the version and the route's head ----
    const facts = await this.loadFacts(routeKey, version);
    if (!facts) {
      if (explicit) throw new RubricReviewError("NOT_FOUND", "Rubric version not found", 404);
      return this.blankReport(runId, routeKey, version, "skipped", ["version_missing"], { mode: "manual", trigger: opts.trigger, recorded: false });
    }
    const { rubric, head } = facts;
    if (rubric.reviewStatus !== "pending_review") {
      if (explicit) throw new RubricReviewError("ALREADY_DECIDED", `This rubric version is already ${rubric.reviewStatus}`, 409);
      // A trigger delivered for a version somebody already decided: nothing to do.
      return this.blankReport(runId, routeKey, version, "skipped", ["already_decided"], { mode, trigger: opts.trigger, recorded: false });
    }
    if (head.latestVersion !== version && explicit) {
      throw new RubricReviewError("NOT_LATEST_VERSION", `Version ${head.latestVersion} of this route's rubric is newer than version ${version}. Only the newest version can be published.`, 409);
    }

    // ---- 3. idempotency: one record per version ----
    const existing = await collections.rubricPublishRuns.doc(runId).get();
    const previousRun = existing.exists ? (existing.data() as RubricPublishRun) : null;
    if (previousRun && !explicit) {
      // A re-delivered trigger on a decided version: writes nothing, publishes nothing.
      return { ...this.blankReport(runId, routeKey, version, previousRun.outcome, previousRun.reasonCodes, { mode: previousRun.mode, trigger: opts.trigger, recorded: false }), attempts: previousRun.attempts };
    }
    if (previousRun?.outcome === "published") {
      throw new RubricReviewError("ALREADY_DECIDED", "This rubric version was already published", 409);
    }
    const attempts = (previousRun?.attempts ?? 0) + 1;
    const startedAt = this.deps.now();

    try {
      // ---- not eligible for automatic publishing (trigger path only) ----
      if (!explicit && settingsUnreadable) {
        return await this.finishHeldOrSkipped(rubric, head, opts, { outcome: "skipped", reasonCodes: ["settings_unreadable"], mode: "manual", attempts, startedAt, previousRun, dryRun, settingsUnreadable: true, alert: true });
      }
      if (!explicit && !routeAllowed(loaded.settings, routeKey)) {
        return await this.finishHeldOrSkipped(rubric, head, opts, { outcome: "skipped", reasonCodes: ["route_not_in_allowlist"], mode, attempts, startedAt, previousRun, dryRun, alert: false });
      }

      // ---- 4. the facts the gates need ----
      const flags = reviewFlagsFor(rubric, null);
      const knownIds = await this.deps.review.knownEligibilityIds(rubric);
      const structural = structuralErrors(rubric, rubric.intentPolarityProposal?.value ?? "not_assessed", knownIds);
      const sourceIds = (rubric.sourceSnapshots ?? []).map((s) => s.sourceId);
      const primarySourceIds = await this.primarySources([...new Set([...sourceIds, ...rubric.criteria.map((c) => c.source?.sourceId)].filter((x): x is string => typeof x === "string" && x.length > 0))]);
      const servingKeptCount = await this.servingKeptCount(routeKey, head);
      const gateInput = {
        criteria: rubric.criteria,
        flags,
        suspiciousPassageCount: rubric.suspiciousPassages?.length ?? 0,
        structuralErrorCodes: structural.map((e) => e.code),
        primarySourceIds,
        allSourceIds: sourceIds,
        servingKeptCount,
        settings: loaded.settings,
        // INTEGRATION (#207): lets the gates count kept scoped rules that rest on no usable trigger.
        intakeQuestions: rubric.intakeQuestions ?? [],
        // (#220) A version written before the field has only product-language sources. A read that
        // fails gives the default list (the product language only): never a looser one.
        languages: {
          sourceLanguages: rubric.sourceLanguages ?? [productLanguageCode()],
          supportedLanguages: await this.deps.loadSupportedLanguages().catch(() => [productLanguageCode()]),
        },
      };

      // ---- 5. the code gates ----
      let report = evaluateGates({ ...gateInput, checker: null });
      const reasons: string[] = [...report.reasonCodes];
      if (settingsUnreadable) reasons.push("settings_unreadable");
      // Part D: a route paused after a rollback holds every new draft.
      if (isPaused(head)) reasons.push("paused_after_rollback");
      // A newer draft already exists (the shared transaction would refuse it too; cheaper to stop before any spend).
      if (head.latestVersion !== version) reasons.push("NOT_LATEST_VERSION");

      // ---- 6. the plug-in points ----
      let checker: RubricPublishRun["checker"] = "not_run";
      let questionPlan: RubricPublishRun["questionPlan"] = "not_run";
      let polarity: IntentPolarity | null = null;
      let plannerFields: Record<string, unknown> | undefined;
      let protectedFromChecker: string[] = [];
      let droppedTriggerIds: string[] = [];
      // (#223) What the check says about failed bars and its spend, for the run record and the alert;
      // the replacements of repaired bars; and the rulebook as it will be SERVED with them (what the
      // check verified, what the gates, the planner and the approval validate).
      const extras: RunExtras = {};
      let repairs: RubricRuleRepair[] = [];
      let effective: VisaRubric = rubric;
      let activeGateInput = gateInput;

      if (checkerNotRun) {
        // Report mode: say plainly that the check has not run.
        if (this.deps.checker === null) checker = "not_configured";
        if (this.deps.planner === null) questionPlan = "not_configured";
      } else if (reasons.length === 0) {
        if (this.deps.checker === null) {
          checker = "not_configured";
          reasons.push("checker_not_configured");
        }
        if (this.deps.planner === null) {
          questionPlan = "not_configured";
          reasons.push("question_plan_missing");
        }
        if (this.deps.checker !== null && this.deps.planner !== null) {
          // Both exist: spend on the check only now that every code gate passed.
          const outcome = await this.callChecker(this.deps.checker, { routeKey, version, runId, rubric, codeLeftOutIds: report.excludedCriterionIds });
          extras.checkerRequests = outcome.requests;
          if (!outcome.ok) {
            checker = "failed";
            for (const code of outcome.reasonCodes) if (!reasons.includes(code)) reasons.push(code);
            protectedFromChecker = outcome.protectedRuleIds ?? [];
            // (#248) Named on the held record too (they would be served without their trigger).
            if (outcome.judgedBars && outcome.judgedBars.length > 0) extras.judgedBars = outcome.judgedBars;
            // (#223) The held record lists everything: each failed bar (per-aspect verdicts and the repair
            // attempt), and the ordinary rules the check would have left out with their shares.
            extras.protectedFailures = outcome.protectedFailures ?? (protectedFromChecker.length > 0 ? protectedFromChecker.map((id) => this.bareFailure(rubric, id)) : undefined);
            if (outcome.leftOut) {
              report = evaluateGates({ ...gateInput, checker: { leftOut: outcome.leftOut, resolvedFlagCodes: [] } });
              // The leave-out shares are reasons in their own right (the report shows them either way).
              for (const code of report.reasonCodes) if ((code === "leave_out_budget_exceeded" || code === "primary_leave_out_budget_exceeded") && !reasons.includes(code)) reasons.push(code);
            }
          } else {
            checker = "passed";
            polarity = outcome.intentPolarity;
            // (#244) What the ordinary rules' automatic re-draft did, for the run record and the alert.
            if (outcome.ordinaryRepairs) extras.ordinaryRepairs = outcome.ordinaryRepairs;
            // (#248) Bars served without their unconfirmed trigger, for the run record, the alert and (via the plan) the audit.
            if (outcome.judgedBars && outcome.judgedBars.length > 0) extras.judgedBars = outcome.judgedBars;
            // (#223) A failed bar the check REPAIRED: from here on the rulebook is the one WITH the
            // replacement (what the check verified), for the gates, the planner and the approval.
            if (outcome.repairs && outcome.repairs.length > 0) {
              repairs = outcome.repairs;
              extras.protectedFailures = outcome.protectedFailures;
              effective = applyRuleRepairs({ ...rubric, ruleRepairs: repairs });
              const structuralWithRepairs = structuralErrors(effective, rubric.intentPolarityProposal?.value ?? "not_assessed", knownIds);
              activeGateInput = { ...gateInput, criteria: effective.criteria, flags: reviewFlagsFor(effective, null), structuralErrorCodes: structuralWithRepairs.map((e) => e.code) };
            }
            // Re-run the gates with the check's leave-outs: the budget and the
            // shrink guard must see the FINAL kept set.
            report = evaluateGates({ ...activeGateInput, droppedTriggerIds: outcome.droppedTriggerIds ?? [], checker: { leftOut: outcome.leftOut, resolvedFlagCodes: outcome.resolvedFlagCodes } });
            // (#203) The question plan resolves `intake_wording_uncited` AFTER this
            // point, so that one flag must not hold the draft before the planner
            // has run. It is evaluated again below, once the plan has answered.
            for (const code of report.reasonCodes) if (code !== PLAN_RESOLVED_FLAG_REASON && !reasons.includes(code)) reasons.push(code);
            if (polarity === null && !reasons.includes("polarity_unverified")) reasons.push("polarity_unverified");
            // (#244) The ordinary re-draft was CUT OFF (a cap, the clock or the provider) and the budget fails on
            // its own: the draft is held for the retryable reason instead, so the sweep finishes the job (the
            // stored attempts are reused, nothing is paid for twice, the next run has its own caps) rather than
            // leaving a draft held for a budget that the unfinished repairs might still have met. A run whose
            // budget passes publishes as it is: the rules not yet re-drafted are simply left out, as before #244.
            const retry = retryReasonOfCutOff(outcome.ordinaryRepairs?.counts.cutOff);
            if (retry && reasons.length > 0 && reasons.every(isBudgetReason)) {
              reasons.splice(0, reasons.length, retry);
            }
            if (reasons.length === 0) {
              droppedTriggerIds = outcome.droppedTriggerIds ?? [];
              const plan = await this.callPlanner(this.deps.planner, { routeKey, version, runId, rubric: effective, excludedCriterionIds: report.excludedCriterionIds, checkerLeftOut: outcome.leftOut, droppedTriggerIds });
              if (!plan.ok) {
                questionPlan = "failed";
                for (const code of plan.reasonCodes) if (!reasons.includes(code)) reasons.push(code);
              } else {
                questionPlan = "built";
                // The question plan and (#223) the recorded replacements are written with the approval, together.
                plannerFields = { ...(plan.reviewFields ?? {}), ...(repairs.length > 0 ? { ruleRepairs: repairs } : {}) };
                // The plan may resolve more flag codes (the question wording): gate again.
                // The scoped-rules count is taken over the questions as they will be SERVED (a question the
                // wording check removed can leave a trigger without its question).
                const planned = plan.reviewFields?.questionPlan as VisaRubric["questionPlan"];
                const servedQuestions = applyExclusions({ ...effective, excludedCriterionIds: [...report.excludedCriterionIds], questionPlan: planned }).intakeQuestions ?? [];
                report = evaluateGates({ ...activeGateInput, intakeQuestions: servedQuestions, droppedTriggerIds: outcome.droppedTriggerIds ?? [], checker: { leftOut: outcome.leftOut, resolvedFlagCodes: [...outcome.resolvedFlagCodes, ...(plan.resolvedFlagCodes ?? [])] } });
                for (const code of report.reasonCodes) if (!reasons.includes(code)) reasons.push(code);
                // (#233 P4b) The layer check, LAST: only a draft about to be published spends on it,
                // and it never adds a reason (it cannot hold). Its record and conflicts are written
                // with the approval, together with the plan.
                if (reasons.length === 0) {
                  const layer = await this.layerCheckFor(effective, report.excludedCriterionIds, loaded.settings, runId);
                  if (layer) {
                    plannerFields = { ...plannerFields, layerCheck: layer.record, layerConflicts: layer.conflicts };
                    extras.layerCheck = layer.record;
                  }
                }
              }
            }
          }
        }
      }

      const codeGatesPassed = report.reasonCodes.length === 0;
      if (dryRun) {
        // Report only: nothing is written, nothing published, no check called.
        const pseudo = [...reasons];
        if (checkerNotRun && !pseudo.includes("checker_not_run")) pseudo.push("checker_not_run");
        return this.buildReport(runId, rubric, report, {
          outcome: "held",
          reasonCodes: pseudo,
          mode,
          trigger: opts.trigger,
          attempts,
          checker,
          questionPlan,
          codeGatesPassed,
          dryRun: true,
          recorded: false,
          auditId: null,
          previousApprovedVersion: head.approvedVersion ?? null,
        });
      }

      if (reasons.length > 0) {
        return await this.hold(rubric, head, report, reasons, {
          runId,
          opts,
          mode,
          attempts,
          startedAt,
          previousRun,
          checker,
          questionPlan,
          codeGatesPassed,
          settingsUnreadable,
          protectedHold: report.protectedHold || protectedFromChecker.length > 0,
          droppedTriggerIds,
          extras,
        });
      }

      // ---- 7. publish through the SHARED approval transaction ----
      return await this.publish(rubric, head, report, { runId, opts, mode, attempts, startedAt, previousRun, checker, questionPlan, polarity: polarity as IntentPolarity, plannerFields, droppedTriggerIds, effective, extras });
    } catch (err) {
      // ---- ANY error: the draft stays pending, the serving version untouched ----
      if (err instanceof RubricReviewError && explicit && (err.code === "NOT_FOUND" || err.code === "ALREADY_DECIDED")) throw err;
      console.error(`Rubric auto-publish: ${runId} failed (${errorClass(err)}); the draft stays pending`);
      if (dryRun) throw err;
      return this.hold(rubric, head, this.fallbackReport(rubric), ["pipeline_error"], {
        runId,
        opts,
        mode,
        attempts,
        startedAt,
        previousRun,
        checker: "not_run",
        questionPlan: "not_run",
        codeGatesPassed: false,
        settingsUnreadable,
        protectedHold: false,
      });
    }
  }

  // ---------- Publish ----------

  /** Publish through the shared transaction; map its refusals to holds. */
  private async publish(
    rubric: VisaRubric,
    head: RubricHead,
    report: GateReport,
    ctx: { runId: string; opts: RunOptions; mode: "manual" | "auto"; attempts: number; startedAt: Timestamp; previousRun: RubricPublishRun | null; checker: RubricPublishRun["checker"]; questionPlan: RubricPublishRun["questionPlan"]; polarity: IntentPolarity; plannerFields?: Record<string, unknown>; droppedTriggerIds?: string[]; effective: VisaRubric; extras?: RunExtras }
  ): Promise<RubricPublishReport> {
    // The flags the version has under the decided polarity: only those with a
    // recorded gate result are acknowledged. Anything else the transaction
    // refuses (FLAGS_NOT_ACKNOWLEDGED) and the draft is held.
    // (#223) The flags of the rulebook AS SERVED (with any repaired bar swapped in): the approval computes them the same way.
    const proposedKeys = reviewFlagsFor(ctx.effective, null).map((f) => f.key);
    const acknowledgedFlags = acknowledgementsFor(proposedKeys, report.flagResolutions).acknowledged;
    const excluded = report.excludedCriterionIds;
    // Primary-source rules left out need the explicit confirmation: only the
    // system's OWN leave-out list can trigger it, and the transaction re-checks.
    const confirmPrimaryExclusions = report.primaryLeftOutIds.length > 0;

    let result: RubricDecisionResult;
    try {
      result = await this.deps.review.decideAs(
        ctx.runId,
        {
          action: "approve",
          revision: rubric.revision,
          intentPolarity: ctx.polarity,
          acknowledgedFlags,
          reason: `Automatic publish ${ctx.runId}`,
          ...(excluded.length > 0 ? { excludedCriterionIds: excluded, exclusionNote: buildExclusionNote(ctx.runId, report.counts.rules, report.counts.leftOutByReason) } : {}),
          ...(confirmPrimaryExclusions ? { confirmPrimaryExclusions: true } : {}),
        },
        SYSTEM_ACTOR,
        { publishRunId: ctx.runId, extraReviewFields: ctx.plannerFields }
      );
    } catch (err) {
      if (err instanceof RubricReviewError) {
        // Somebody decided it first (a re-delivery, an admin): not ours to record or alert.
        if (err.code === "ALREADY_DECIDED") {
          return this.buildReport(ctx.runId, rubric, report, { outcome: "skipped", reasonCodes: ["already_decided"], mode: ctx.mode, trigger: ctx.opts.trigger, attempts: ctx.attempts, checker: ctx.checker, questionPlan: ctx.questionPlan, codeGatesPassed: true, dryRun: false, recorded: false, auditId: null, previousApprovedVersion: head.approvedVersion ?? null });
        }
        // The shared transaction refused: held with ITS code (a newer draft will supersede it).
        return this.hold(rubric, head, report, [err.code], { runId: ctx.runId, opts: ctx.opts, mode: ctx.mode, attempts: ctx.attempts, startedAt: ctx.startedAt, previousRun: ctx.previousRun, checker: ctx.checker, questionPlan: ctx.questionPlan, codeGatesPassed: true, settingsUnreadable: false, protectedHold: false, extras: ctx.extras });
      }
      throw err;
    }

    // ---- committed: from here on nothing may undo or fail the publish ----
    const finished = this.buildReport(ctx.runId, rubric, report, {
      outcome: "published",
      reasonCodes: [],
      mode: ctx.mode,
      trigger: ctx.opts.trigger,
      attempts: ctx.attempts,
      checker: ctx.checker,
      questionPlan: ctx.questionPlan,
      codeGatesPassed: true,
      dryRun: false,
      recorded: false,
      auditId: result.auditId,
      previousApprovedVersion: result.previousApprovedVersion,
    });
    finished.droppedTriggerIds = ctx.droppedTriggerIds ?? [];
    this.applyExtras(finished, ctx.extras);
    finished.recorded = await this.writeRecord(rubric, finished, ctx.startedAt, ctx.previousRun !== null);
    await this.supersedeOlderPending(rubric.routeKey, rubric.version, ctx.runId);
    await this.alertPublished(rubric, report, finished);
    return finished;
  }

  // ---------- Hold ----------

  /** Record a hold and alert. The serving version is not touched. */
  private async hold(
    rubric: VisaRubric,
    head: RubricHead,
    report: GateReport,
    reasons: string[],
    ctx: { runId: string; opts: RunOptions; mode: "manual" | "auto"; attempts: number; startedAt: Timestamp; previousRun: RubricPublishRun | null; checker: RubricPublishRun["checker"]; questionPlan: RubricPublishRun["questionPlan"]; codeGatesPassed: boolean; settingsUnreadable: boolean; protectedHold: boolean; droppedTriggerIds?: string[]; extras?: RunExtras }
  ): Promise<RubricPublishReport> {
    const finished = this.buildReport(ctx.runId, rubric, report, {
      outcome: "held",
      reasonCodes: reasons,
      mode: ctx.mode,
      trigger: ctx.opts.trigger,
      attempts: ctx.attempts,
      checker: ctx.checker,
      questionPlan: ctx.questionPlan,
      codeGatesPassed: ctx.codeGatesPassed,
      dryRun: false,
      recorded: false,
      auditId: null,
      previousApprovedVersion: head.approvedVersion ?? null,
    });
    finished.droppedTriggerIds = ctx.droppedTriggerIds ?? [];
    this.applyExtras(finished, ctx.extras);
    finished.recorded = await this.writeRecord(rubric, finished, ctx.startedAt, ctx.previousRun !== null);
    await this.alertHeld(rubric, report, finished, { protectedHold: ctx.protectedHold, settingsUnreadable: ctx.settingsUnreadable });
    return finished;
  }

  /** A skipped run that is recorded (settings unreadable, route not allowed); optionally alerts. */
  private async finishHeldOrSkipped(
    rubric: VisaRubric,
    head: RubricHead,
    opts: RunOptions,
    ctx: { outcome: "skipped"; reasonCodes: string[]; mode: "manual" | "auto"; attempts: number; startedAt: Timestamp; previousRun: RubricPublishRun | null; dryRun: boolean; settingsUnreadable?: boolean; alert: boolean }
  ): Promise<RubricPublishReport> {
    const report = this.fallbackReport(rubric);
    const finished = this.buildReport(rubricVersionId(rubric.routeKey, rubric.version), rubric, report, {
      outcome: ctx.outcome,
      reasonCodes: ctx.reasonCodes,
      mode: ctx.mode,
      trigger: opts.trigger,
      attempts: ctx.attempts,
      checker: "not_run",
      questionPlan: "not_run",
      codeGatesPassed: false,
      dryRun: ctx.dryRun,
      recorded: false,
      auditId: null,
      previousApprovedVersion: head.approvedVersion ?? null,
    });
    if (ctx.dryRun) return finished;
    finished.recorded = await this.writeRecord(rubric, finished, ctx.startedAt, ctx.previousRun !== null);
    // Unreadable settings: nobody can tell whether `auto` is meant to be on, so say so (critical).
    if (ctx.alert) await this.alertHeld(rubric, report, finished, { protectedHold: false, settingsUnreadable: ctx.settingsUnreadable === true });
    return finished;
  }

  // ---------- Supersede ----------

  /**
   * After version `version` published: older versions still `pending_review`
   * are rejected by the system with reason `superseded_by_newer_version`
   * (through the same decision code), and their held alerts resolve with the
   * route-wide clear in `alertPublished`. One failing rejection never stops
   * the others or the publish.
   */
  private async supersedeOlderPending(routeKey: string, version: number, runId: string): Promise<void> {
    try {
      const snap = await subcollections.rubricVersions(routeKey).where("reviewStatus", "==", "pending_review").get();
      for (const d of snap.docs) {
        const older = d.data() as VisaRubric;
        if (older.version >= version) continue;
        try {
          await this.deps.review.decideAs(rubricVersionId(routeKey, older.version), { action: "reject", revision: older.revision, reason: SUPERSEDED_REASON }, SYSTEM_ACTOR, { publishRunId: runId });
        } catch (err) {
          console.error(`Rubric auto-publish: could not supersede ${routeKey} v${older.version} (${errorClass(err)})`);
        }
      }
    } catch (err) {
      console.error(`Rubric auto-publish: listing older pending versions of ${routeKey} failed (${errorClass(err)})`);
    }
  }

  // ---------- Alerts ----------

  /** The admin Rubrics tab link of a version. */
  private linkFor(routeKey: string, version: number): string {
    return `${this.deps.appUrl()}/admin/visa-review?tab=rubrics&rubric=${encodeURIComponent(rubricVersionId(routeKey, version))}`;
  }

  /** Facts shared by both alerts. */
  private factsFor(rubric: VisaRubric, report: GateReport, finished: RubricPublishReport): RubricPublishAlertFacts {
    const byId = new Map(rubric.criteria.map((c) => [c.criterionId, c]));
    const ruleOf = (id: string): RubricAlertRule => {
      const c = byId.get(id);
      return { title: c?.title ?? id, ruleRef: c?.ruleRef ?? null };
    };
    const kept = new Set(report.keptCriterionIds);
    return {
      routeKey: rubric.routeKey,
      version: rubric.version,
      previousVersion: finished.previousApprovedVersion,
      link: this.linkFor(rubric.routeKey, rubric.version),
      rules: report.counts.rules,
      kept: report.counts.kept,
      leftOutByReason: report.counts.leftOutByReason,
      leftOutFoundWrong: report.counts.leftOutFoundWrong,
      leftOutNotConfirmed: report.counts.leftOutNotConfirmed,
      held: report.heldRuleIds.length,
      primaryLeftOut: report.primaryLeftOutIds.map(ruleOf),
      informationalFlags: report.informationalFlags,
      sample: sampleAudit(rubric.criteria.filter((c) => kept.has(c.criterionId)), rubric.version).map((r) => ({ title: r.title, ruleRef: r.ruleRef, quote: r.quote, url: r.url })),
      reasons: this.reasonsInWords(rubric, finished.reasonCodes),
      protectedHold: false,
      settingsUnreadable: false,
      attempt: finished.attempts,
      ...(finished.protectedFailures && finished.protectedFailures.length > 0 ? { protectedFindings: finished.protectedFailures.map(findingInWords) } : {}),
      // (#244) What the ordinary rules' automatic re-draft did; the rules now served as their replacement are listed by title.
      ...(finished.counts.ordinaryRepairs ? { ordinaryRepairSummary: ordinaryRepairSummaryInWords(finished.counts.ordinaryRepairs) } : {}),
      ...(finished.ordinaryRepairs && finished.ordinaryRepairs.some((r) => r.repair.status === "repaired")
        ? { ordinaryRepairedRules: finished.ordinaryRepairs.filter((r) => r.repair.status === "repaired").map((r) => `${r.title}${r.ruleRef ? ` [${r.ruleRef}]` : ""} (rule id ${r.criterionId}, failed ${r.failedAspects.join(", ")})`) }
        : {}),
      // (#248) Each bar served without its unconfirmed trigger, named, with the fixed note (assessed by judgement).
      ...(finished.barsJudgedWithoutTrigger && finished.barsJudgedWithoutTrigger.length > 0 ? { judgedBars: finished.barsJudgedWithoutTrigger.map(judgedBarInWords) } : {}),
    };
  }

  /** One alert for an automatic publish; resolves every held alert of the route. Never throws. */
  private async alertPublished(rubric: VisaRubric, report: GateReport, finished: RubricPublishReport): Promise<void> {
    try {
      const config = await this.deps.loadAlertConfig();
      await this.deps.raiseAlerts([evaluateRubricAutoPublished(this.factsFor(rubric, report, finished), config), evaluateRubricHeldCleared(rubric.routeKey, null)], config);
    } catch (err) {
      console.error(`Rubric auto-publish: the alert for ${rubric.routeKey} v${rubric.version} failed (${errorClass(err)}); the publish stands`);
    }
  }

  /** One alert for a hold. Never throws. */
  private async alertHeld(rubric: VisaRubric, report: GateReport, finished: RubricPublishReport, extra: { protectedHold: boolean; settingsUnreadable: boolean }): Promise<void> {
    try {
      const config = await this.deps.loadAlertConfig();
      const facts = { ...this.factsFor(rubric, report, finished), protectedHold: extra.protectedHold, settingsUnreadable: extra.settingsUnreadable };
      await this.deps.raiseAlerts([evaluateRubricDraftHeld(facts, config)], config);
    } catch (err) {
      console.error(`Rubric auto-publish: the alert for ${rubric.routeKey} v${rubric.version} failed (${errorClass(err)})`);
    }
  }

  // ---------- Words (#223) ----------

  /**
   * Hold reasons in words. A reason that names a rule by id (`protected_rule_failed:<id>`) also names it
   * by TITLE, read from the draft (data, never code), so the alert says which bar failed.
   */
  private reasonsInWords(rubric: VisaRubric, codes: readonly string[]): string[] {
    const titleOf = new Map(rubric.criteria.map((c) => [c.criterionId, c.title]));
    return codes.map((code) => {
      const m = /^protected_rule_failed:(.+)$/.exec(code);
      const title = m ? titleOf.get(m[1]) : undefined;
      return title ? `${reasonInWords(code)}: "${title}"` : reasonInWords(code);
    });
  }

  /** Copy the check's report onto a run report (the record is written from the report). */
  private applyExtras(finished: RubricPublishReport, extras: RunExtras | undefined): void {
    if (!extras) return;
    if (extras.protectedFailures !== undefined) finished.protectedFailures = extras.protectedFailures;
    if (extras.checkerRequests !== undefined) finished.checkerRequests = extras.checkerRequests;
    // (#244) The ordinary re-draft: counts on the run's counts, a line per eligible rule, and a gate line.
    if (extras.ordinaryRepairs !== undefined) {
      finished.counts = { ...finished.counts, ordinaryRepairs: extras.ordinaryRepairs.counts };
      finished.ordinaryRepairs = extras.ordinaryRepairs.records;
      finished.gates = [...finished.gates, ordinaryRepairGate(extras.ordinaryRepairs.counts, finished.counts.rules)];
    }
    // (#248) The bars served without their trigger: a line each on the record, and a gate line.
    if (extras.judgedBars !== undefined && extras.judgedBars.length > 0) {
      finished.barsJudgedWithoutTrigger = extras.judgedBars;
      finished.gates = [...finished.gates, judgedBarGate(extras.judgedBars)];
    }
    // (#233 P4b) The layer check: one gate line, never blocking.
    if (extras.layerCheck !== undefined) finished.gates = [...finished.gates, layerCheckGate(extras.layerCheck)];
  }

  /** A failed bar with no check detail (an older checker, or a hold before any spend): id, title and ref only. */
  private bareFailure(rubric: VisaRubric, id: string): RubricProtectedFailure {
    const c = rubric.criteria.find((x) => x.criterionId === id);
    return { criterionId: id, ruleRef: c?.ruleRef ?? null, title: c?.title ?? id, failedAspects: [], verdicts: {}, repair: { status: "not_attempted", detail: "not_checked", ruleHash: c ? ruleHashOf(c) : "", requests: 0 } };
  }

  // ---------- Reads ----------

  /** The version and its head; null when either is missing. */
  private async loadFacts(routeKey: string, version: number): Promise<VersionFacts | null> {
    const [rubric, head] = await Promise.all([rubricStore.getVersionForReview(routeKey, version), rubricStore.getHead(routeKey)]);
    if (!rubric || !head || !Array.isArray(rubric.criteria)) return null;
    return { rubric, head };
  }

  /**
   * The sources treated as PRIMARY: a primary role, or one whose role cannot be
   * established (missing, unreadable, unknown). The same rule the approval
   * uses for its confirmation (`sourceNeedsExclusionConfirmation`): fail closed.
   */
  private async primarySources(sourceIds: string[]): Promise<Set<string>> {
    const primary = new Set<string>();
    await Promise.all(
      sourceIds.map(async (id) => {
        let needs = true;
        try {
          const snap = await collections.guidanceSources.doc(id).get();
          needs = sourceNeedsExclusionConfirmation({ exists: snap.exists, role: snap.exists ? (snap.data() as { role?: unknown }).role : undefined });
        } catch (err) {
          console.error(`Rubric auto-publish: guidance source ${id} unreadable (${errorClass(err)}); treated as primary`);
        }
        if (needs) primary.add(id);
      })
    );
    return primary;
  }

  /**
   * Kept rules of the version now serving (after ITS exclusions), or null when
   * none serves. A serving version that cannot be read throws: an unknown
   * floor must not become "no floor" (the run is held `pipeline_error`).
   */
  private async servingKeptCount(routeKey: string, head: RubricHead): Promise<number | null> {
    if (head.approvedVersion === null || head.approvedVersion === undefined) return null;
    const serving = await rubricStore.getVersionForReview(routeKey, head.approvedVersion);
    if (!serving || serving.reviewStatus !== "approved" || !Array.isArray(serving.criteria)) {
      throw new Error("the serving version could not be read");
    }
    return applyExclusions(serving).criteria.length;
  }

  // ---------- The plug-ins, called defensively ----------

  /** Call the check; a throw is a held draft (`checker_unavailable`), never an escape. */
  private async callChecker(checker: RubricChecker, input: RubricCheckInput): Promise<RubricCheckOutcome> {
    try {
      return await checker.check(input);
    } catch (err) {
      console.error(`Rubric auto-publish: the independent check threw for ${input.runId} (${errorClass(err)})`);
      return { ok: false, reasonCodes: ["checker_unavailable:internal"] };
    }
  }

  /** Call the planner; a throw is a held draft (`question_plan_unusable`). */
  private async callPlanner(planner: QuestionPlanner, input: QuestionPlanInput): Promise<QuestionPlanOutcome> {
    try {
      return await planner.plan(input);
    } catch (err) {
      console.error(`Rubric auto-publish: the question planner threw for ${input.runId} (${errorClass(err)})`);
      return { ok: false, reasonCodes: ["question_plan_unusable"] };
    }
  }

  /**
   * (#233 P4b) The layer check of an own layer, or null when there is nothing
   * to check (no layer checker, or not an own layer on a route with a shared
   * layer). Never throws and never holds: a failure to read the shared layers
   * or to run the check is a visible `not_checked` record, and nothing is
   * linked (the rules simply stay duplicated).
   *
   * Compared: the own rules AS THEY WILL BE SERVED (the repaired rules swapped
   * in, the leave-outs taken out) against each shared layer's APPROVED served
   * rules. The spend is capped by the check's own hard caps and by the publish
   * settings' `checkerMaxRequestsPerRun` / `checkerRequestTimeoutMs`.
   */
  private async layerCheckFor(effective: VisaRubric, excludedCriterionIds: readonly string[], settings: LoadedPublishSettings["settings"], runId: string): Promise<LayerCheckOutcome | null> {
    if (this.deps.layerChecker === null) return null;
    const ownCriteria = applyExclusions({ ...effective, excludedCriterionIds: [...excludedCriterionIds], questionPlan: undefined }).criteria;
    let layers: Awaited<ReturnType<SharedLayersReader>>;
    try {
      layers = await this.deps.sharedLayersOf(effective);
    } catch (err) {
      console.error(`Rubric auto-publish: the shared layers of ${runId} could not be read (${errorClass(err)}); layer check not run`);
      return { record: notCheckedRecord({ ownCriteria, shared: [] }, "shared_layers_unreadable"), conflicts: [] };
    }
    if (layers === null) return null;
    const approved = layers.filter((l): l is SharedLayerRules => l.version !== null);
    if (approved.length === 0) return { record: notCheckedRecord({ ownCriteria, shared: [] }, "shared_layer_not_approved"), conflicts: [] };
    try {
      const out = await this.deps.layerChecker.check(
        { ownRulebookKey: effective.routeKey, ownCriteria, shared: approved },
        { maxRequests: settings.checkerMaxRequestsPerRun, timeoutMs: settings.checkerRequestTimeoutMs }
      );
      console.log(`Rubric auto-publish: layer check of ${runId}: ${out.record.status}${out.record.reason ? ` (${out.record.reason})` : ""}, ${out.record.restates.length} link(s), ${out.conflicts.length} conflict(s), ${out.record.calls} call(s)`);
      return out;
    } catch (err) {
      console.error(`Rubric auto-publish: the layer check threw for ${runId} (${errorClass(err)}); nothing linked`);
      return { record: notCheckedRecord({ ownCriteria, shared: approved }, "provider_error"), conflicts: [] };
    }
  }

  // ---------- Records and reports ----------

  /**
   * Write the run record. First run of a version: `create()` (a concurrent
   * duplicate loses with ALREADY_EXISTS and is ignored). A re-run (admin /
   * script) replaces the record with `attempts` + 1. Never throws; false when
   * nothing was written.
   */
  private async writeRecord(rubric: VisaRubric, report: RubricPublishReport, startedAt: Timestamp, replace: boolean): Promise<boolean> {
    const record: RubricPublishRun = {
      runId: report.runId,
      routeKey: rubric.routeKey,
      // (#233) Every publish run carries the rulebook's authorityId + routeSlug
      // (the store fills them in for a version written before #233); the
      // country pair stays for a country's rulebook and is absent on a bloc /
      // treaty layer. The gates are the same for both.
      authorityId: rubric.authorityId,
      routeSlug: rubric.routeSlug,
      countryCode: rubric.countryCode,
      visaTypeId: rubric.visaTypeId,
      version: rubric.version,
      outcome: report.outcome,
      reasonCodes: report.reasonCodes,
      gates: report.gates,
      counts: report.counts,
      leftOut: report.leftOut,
      mode: report.mode,
      trigger: report.trigger,
      attempts: report.attempts,
      checker: report.checker,
      questionPlan: report.questionPlan,
      ...(report.droppedTriggerIds !== undefined ? { droppedTriggerIds: report.droppedTriggerIds } : {}),
      ...(report.protectedFailures !== undefined ? { protectedFailures: report.protectedFailures } : {}),
      ...(report.ordinaryRepairs !== undefined ? { ordinaryRepairs: report.ordinaryRepairs } : {}),
      ...(report.barsJudgedWithoutTrigger !== undefined ? { barsJudgedWithoutTrigger: report.barsJudgedWithoutTrigger } : {}),
      ...(report.checkerRequests !== undefined ? { checkerRequests: report.checkerRequests } : {}),
      auditId: report.auditId,
      previousApprovedVersion: report.previousApprovedVersion,
      startedAt,
      finishedAt: this.deps.now(),
    };
    try {
      const ref = collections.rubricPublishRuns.doc(report.runId);
      if (replace) await ref.set(record as unknown as Record<string, unknown>);
      else await ref.create(record as unknown as Record<string, unknown>);
      return true;
    } catch (err) {
      if (!isAlreadyExists(err)) console.error(`Rubric auto-publish: could not write the run record ${report.runId} (${errorClass(err)})`);
      return false;
    }
  }

  /** A report with nothing evaluated (a no-op). */
  private blankReport(runId: string, routeKey: string, version: number, outcome: RubricPublishRun["outcome"], reasonCodes: string[], extra: { mode: "manual" | "auto"; trigger: RubricPublishTrigger; recorded: boolean }): RubricPublishReport {
    return {
      runId,
      routeKey,
      version,
      outcome,
      reasonCodes,
      reasons: reasonCodes.map(reasonInWords),
      gates: [],
      counts: emptyCounts(),
      leftOut: [],
      plannedExcludedCriterionIds: [],
      mode: extra.mode,
      trigger: extra.trigger,
      attempts: 0,
      checker: "not_run",
      questionPlan: "not_run",
      codeGatesPassed: false,
      dryRun: false,
      recorded: extra.recorded,
      auditId: null,
      previousApprovedVersion: null,
    };
  }

  /** A gate report for a run that never reached the gates (counts only). */
  private fallbackReport(rubric: VisaRubric): GateReport {
    return {
      gates: [],
      reasonCodes: [],
      leftOut: [],
      keptCriterionIds: rubric.criteria.map((c) => c.criterionId),
      excludedCriterionIds: [],
      primaryLeftOutIds: [],
      heldRuleIds: [],
      protectedHold: false,
      informationalFlags: {},
      flagResolutions: {},
      counts: { rules: rubric.criteria.length, kept: rubric.criteria.length, leftOut: 0, leftOutByReason: {}, primaryRules: 0, leftOutFoundWrong: 0, leftOutNotConfirmed: 0 },
    };
  }

  /** The run's report from the gate report and the outcome. */
  private buildReport(
    runId: string,
    rubric: VisaRubric,
    report: GateReport,
    f: Pick<RubricPublishReport, "outcome" | "reasonCodes" | "mode" | "trigger" | "attempts" | "checker" | "questionPlan" | "codeGatesPassed" | "dryRun" | "recorded" | "auditId" | "previousApprovedVersion">
  ): RubricPublishReport {
    return {
      runId,
      routeKey: rubric.routeKey,
      version: rubric.version,
      ...f,
      reasons: this.reasonsInWords(rubric, f.reasonCodes),
      gates: report.gates,
      counts: {
        rules: report.counts.rules,
        kept: report.counts.kept,
        leftOut: report.counts.leftOut,
        leftOutByReason: report.counts.leftOutByReason,
        leftOutFoundWrong: report.counts.leftOutFoundWrong,
        leftOutNotConfirmed: report.counts.leftOutNotConfirmed,
        held: report.heldRuleIds.length,
        informationalFlags: report.informationalFlags,
      },
      leftOut: report.leftOut,
      plannedExcludedCriterionIds: report.excludedCriterionIds,
    };
  }
}

/**
 * True when the route's head records that automatic publishing is paused
 * (part D, #204: after a rollback the head carries `autoPublish: "paused"`).
 * Read loosely because part D adds the field to `RubricHead`.
 */
function isPaused(head: RubricHead): boolean {
  return (head as unknown as { autoPublish?: unknown }).autoPublish === "paused";
}

/** Singleton over the project's Firestore. Parts B and C register their implementations on it. */
export const rubricAutoPublishService = new RubricAutoPublishService();
// Part B (#202): the independent check plugs in here, so every entry point
// (the version-created trigger, the admin endpoint, the script, the sweep)
// has it.
rubricAutoPublishService.registerChecker(rubricChecker);
// Part C (#203): the question planner (wording check, plan) is registered the same way.
rubricAutoPublishService.registerPlanner(new RubricQuestionPlanner());
// (#233 P4b) The layer check of an own layer against its shared layer(s): informational, never holds.
rubricAutoPublishService.registerLayerChecker(new RubricLayerChecker());
