import { Timestamp } from "firebase-admin/firestore";
import { collections, subcollections } from "../utils/firebase";
// The scrapers module is reached through its public entry point only (the
// ESLint boundary rule of issue #91).
import {
  acknowledgementsFor,
  applyExclusions,
  buildExclusionNote,
  evaluateGates,
  evaluateRubricAutoPublished,
  evaluateRubricDraftHeld,
  evaluateRubricHeldCleared,
  loadPublishSettings,
  reasonInWords,
  RubricQuestionPlanner,
  rubricStore,
  routeAllowed,
  sampleAudit,
  scrapeAlertService,
} from "../scrapers";
import type { GateReport, LoadedPublishSettings, RubricAlertRule, RubricPublishAlertFacts, RuleEvaluation, ScrapeAlertsConfig } from "../scrapers";
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
  RUBRIC_ACTOR_KIND,
  RUBRIC_SYSTEM_ACTOR_ID,
  type IntentPolarity,
  type RubricHead,
  type RubricPublishGateResult,
  type RubricPublishLeftOut,
  type RubricPublishRun,
  type RubricPublishTrigger,
  type RubricReviewActor,
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
 *                 (the draft is then held `polarity_unverified`).
 *  - `ok: false`  the draft is held with these reason codes
 *                 (`checker_unavailable`, `checker_capped`,
 *                 `checker_output_invalid`, `protected_rule_failed:<id>`, ...).
 *                 `protectedRuleIds` lists protected rules that failed (critical alert).
 * A checker must not throw; if it does the draft is held `checker_unavailable`.
 */
export type RubricCheckOutcome =
  | { ok: true; leftOut: { criterionId: string; reason: string }[]; resolvedFlagCodes: string[]; intentPolarity: IntentPolarity | null }
  | { ok: false; reasonCodes: string[]; protectedRuleIds?: string[] };

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

/** The system actor, as the review service takes it. */
const SYSTEM_ACTOR: RubricReviewActor = { kind: RUBRIC_ACTOR_KIND.SYSTEM, id: RUBRIC_SYSTEM_ACTOR_ID };

/** Reason of the system's rejection of an older pending version (at least the 10 characters a reject needs). */
export const SUPERSEDED_REASON = "superseded_by_newer_version";

/** An empty counts block (no gate ran). */
const emptyCounts = (): RubricPublishRun["counts"] => ({ rules: 0, kept: 0, leftOut: 0, leftOutByReason: {}, held: 0, informationalFlags: {} });

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
  // Part B / part C. null until they exist: `auto` then holds every draft.
  checker: RubricChecker | null;
  planner: QuestionPlanner | null;
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
      appUrl: () => (process.env.APP_URL || EMAIL_BRANDING.appUrl).replace(/\/+$/, ""),
      // PART B (#202) and PART C (#203): put the implementations here, or call
      // `registerChecker` / `registerPlanner` at start-up. Until then both are
      // null and `auto` holds every draft.
      checker: null,
      planner: null,
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
          if (!outcome.ok) {
            checker = "failed";
            for (const code of outcome.reasonCodes) if (!reasons.includes(code)) reasons.push(code);
            protectedFromChecker = outcome.protectedRuleIds ?? [];
          } else {
            checker = "passed";
            polarity = outcome.intentPolarity;
            // Re-run the gates with the check's leave-outs: the budget and the
            // shrink guard must see the FINAL kept set.
            report = evaluateGates({ ...gateInput, checker: { leftOut: outcome.leftOut, resolvedFlagCodes: outcome.resolvedFlagCodes } });
            // (#203) The question plan resolves `intake_wording_uncited` AFTER this
            // point, so that one flag must not hold the draft before the planner
            // has run. It is evaluated again below, once the plan has answered.
            for (const code of report.reasonCodes) if (code !== PLAN_RESOLVED_FLAG_REASON && !reasons.includes(code)) reasons.push(code);
            if (polarity === null && !reasons.includes("polarity_unverified")) reasons.push("polarity_unverified");
            if (reasons.length === 0) {
              const plan = await this.callPlanner(this.deps.planner, { routeKey, version, runId, rubric, excludedCriterionIds: report.excludedCriterionIds, checkerLeftOut: outcome.leftOut });
              if (!plan.ok) {
                questionPlan = "failed";
                for (const code of plan.reasonCodes) if (!reasons.includes(code)) reasons.push(code);
              } else {
                questionPlan = "built";
                plannerFields = plan.reviewFields;
                // The plan may resolve more flag codes (the question wording): gate again.
                report = evaluateGates({ ...gateInput, checker: { leftOut: outcome.leftOut, resolvedFlagCodes: [...outcome.resolvedFlagCodes, ...(plan.resolvedFlagCodes ?? [])] } });
                for (const code of report.reasonCodes) if (!reasons.includes(code)) reasons.push(code);
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
        });
      }

      // ---- 7. publish through the SHARED approval transaction ----
      return await this.publish(rubric, head, report, { runId, opts, mode, attempts, startedAt, previousRun, checker, questionPlan, polarity: polarity as IntentPolarity, plannerFields });
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
    ctx: { runId: string; opts: RunOptions; mode: "manual" | "auto"; attempts: number; startedAt: Timestamp; previousRun: RubricPublishRun | null; checker: RubricPublishRun["checker"]; questionPlan: RubricPublishRun["questionPlan"]; polarity: IntentPolarity; plannerFields?: Record<string, unknown> }
  ): Promise<RubricPublishReport> {
    // The flags the version has under the decided polarity: only those with a
    // recorded gate result are acknowledged. Anything else the transaction
    // refuses (FLAGS_NOT_ACKNOWLEDGED) and the draft is held.
    const proposedKeys = reviewFlagsFor(rubric, null).map((f) => f.key);
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
        return this.hold(rubric, head, report, [err.code], { runId: ctx.runId, opts: ctx.opts, mode: ctx.mode, attempts: ctx.attempts, startedAt: ctx.startedAt, previousRun: ctx.previousRun, checker: ctx.checker, questionPlan: ctx.questionPlan, codeGatesPassed: true, settingsUnreadable: false, protectedHold: false });
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
    ctx: { runId: string; opts: RunOptions; mode: "manual" | "auto"; attempts: number; startedAt: Timestamp; previousRun: RubricPublishRun | null; checker: RubricPublishRun["checker"]; questionPlan: RubricPublishRun["questionPlan"]; codeGatesPassed: boolean; settingsUnreadable: boolean; protectedHold: boolean }
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
      held: report.heldRuleIds.length,
      primaryLeftOut: report.primaryLeftOutIds.map(ruleOf),
      informationalFlags: report.informationalFlags,
      sample: sampleAudit(rubric.criteria.filter((c) => kept.has(c.criterionId)), rubric.version).map((r) => ({ title: r.title, ruleRef: r.ruleRef, quote: r.quote, url: r.url })),
      reasons: finished.reasonCodes.map(reasonInWords),
      protectedHold: false,
      settingsUnreadable: false,
      attempt: finished.attempts,
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
      return { ok: false, reasonCodes: ["checker_unavailable"] };
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
      counts: { rules: rubric.criteria.length, kept: rubric.criteria.length, leftOut: 0, leftOutByReason: {}, primaryRules: 0 },
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
      reasons: f.reasonCodes.map(reasonInWords),
      gates: report.gates,
      counts: {
        rules: report.counts.rules,
        kept: report.counts.kept,
        leftOut: report.counts.leftOut,
        leftOutByReason: report.counts.leftOutByReason,
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
// Part C (#203): the question planner (wording check, plan) is registered here.
rubricAutoPublishService.registerPlanner(new RubricQuestionPlanner());
