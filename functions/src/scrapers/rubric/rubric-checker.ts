import { collections } from "../../utils/firebase";
import { AnthropicNotConfiguredError } from "../../services/ai/anthropic-client";
import { AnthropicLlmProvider, LlmProviderError, emptyLlmUsage, llmRequestHash, type LlmProvider, type LlmRequest, type LlmUsage } from "../../services/ai/llm-provider";
import type { AssessmentCriterion, IntentPolarity, VisaRubric } from "../../types/rubric";
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
import { SnapshotQuoteIndex } from "./rubric-quote";
import { quoteIsLeadIn, verifyListItems } from "./rubric-list-items";
import { isTransientProviderError } from "./rubric-extraction.service";

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
export function applicableAspects(rule: Pick<AssessmentCriterion, "applicability" | "applicabilityCondition" | "check" | "appliesTo">): ReadonlySet<CheckerAspect> {
  const set = new Set<CheckerAspect>(["title_faithful", "kind_right", "stage_right"]);
  if (rule.applicability !== undefined || rule.applicabilityCondition !== undefined) set.add("condition_faithful");
  if (rule.check !== undefined) set.add("check_faithful");
  if (rule.appliesTo !== undefined) set.add("group_matches_codes");
  return set;
}

/**
 * The first aspect (in fixed order) a row fails for a rule, or null when it
 * passes. Applicable: only `yes` passes (`na` there is "not verified" and
 * fails like `unsure`). Not applicable: `na` and `yes` pass; `no` and `unsure`
 * fail (a doubt the model raised is never ignored).
 */
export function failedAspect(rule: Parameters<typeof applicableAspects>[0], row: VerdictRow): CheckerAspect | null {
  const applicable = applicableAspects(rule);
  for (const a of CHECKER_ASPECTS) {
    const v = row[a];
    if (applicable.has(a) ? v !== "yes" : v === "no" || v === "unsure") return a;
  }
  return null;
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
  | { ok: true; leftOut: { criterionId: string; reason: string }[]; resolvedFlagCodes: string[]; intentPolarity: IntentPolarity | null; droppedTriggerIds?: string[] }
  | { ok: false; reasonCodes: string[]; protectedRuleIds?: string[] };

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
  updatedAtMs: number;
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

/** Why one job did not produce an answer. */
type JobFailure = "unavailable" | "invalid" | "capped";

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
      ...deps,
    };
  }

  /**
   * The pipeline's entry. NEVER throws: any unexpected error is a held draft
   * (`checker_unavailable`), logged by class only.
   */
  async check(input: RubricCheckInputShape): Promise<RubricCheckOutcomeShape> {
    try {
      return await this.checkInner(input);
    } catch (err) {
      console.error(`Rubric checker: ${input.runId} failed (${errorClass(err)})`);
      return { ok: false, reasonCodes: [err instanceof CheckerPromptError ? "checker_output_invalid" : "checker_unavailable"] };
    }
  }

  private async checkInner(input: RubricCheckInputShape): Promise<RubricCheckOutcomeShape> {
    const startedMs = this.deps.nowMs();
    const rubric = input.rubric;
    const rules = rubric.criteria;

    // ---- settings: unreadable = unavailable (never a default cap on a read error) ----
    const loaded = await this.deps.loadSettings();
    if (loaded.readError !== undefined) return { ok: false, reasonCodes: ["checker_unavailable"] };
    const caps = loaded.settings;
    if (rules.length === 0) return { ok: true, leftOut: [], resolvedFlagCodes: [], intentPolarity: null };
    // A cap, not a trim: a draft over it is held whole.
    if (rules.length > caps.checkerMaxRulesPerDraft) return { ok: false, reasonCodes: ["checker_capped"] };

    const provider = this.deps.provider();
    const models = { verification: provider.modelFor("verification"), judgement: provider.modelFor("judgement") };
    const limits = { maxOutputTokens: caps.checkerMaxOutputTokensPerRequest, timeoutMs: caps.checkerRequestTimeoutMs };

    // ---- the official text around each quote (its cited snapshot, bounded) ----
    const views = await this.buildViews(rules);

    // ---- who is protected, and who cannot be read ----
    const protectedRules = rules.filter(isProtectedRule);
    const ordinaryRules = rules.filter((r) => !isProtectedRule(r));
    const failedProtected = new Set<string>(protectedRules.filter((r) => !views.has(r.criterionId)).map((r) => r.criterionId));
    // A protected rule whose quote cannot be found cannot be verified: hold before spending anything.
    if (failedProtected.size > 0) return this.protectedFailure([...failedProtected]);
    const unreadableOrdinary = ordinaryRules.filter((r) => !views.has(r.criterionId));
    const readableOrdinary = ordinaryRules.filter((r) => views.has(r.criterionId));

    // ---- intention to stay ----
    const polarityPlan = await this.planPolarity(rubric, input.codeLeftOutIds, limits);
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
    const previous = await this.deps.ledger.load(input.runId);
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
    if (needed.length > 0 && (await this.deps.ledger.countRunsOnDay(day, input.runId)) >= caps.checkerMaxRunsPerDay) return { ok: false, reasonCodes: ["checker_capped"] };

    // ---- run ----
    const usage = emptyUsage();
    const lifetimeBase = emptyUsage();
    if (previous?.lifetimeUsage) addUsage(lifetimeBase, previous.lifetimeUsage);
    const ctx: RunContext = { provider, caps, responses, usage, startedMs, models, input, rules, day, verdicts: {}, lifetimeBase };
    const stop = async (reasonCodes: string[], protectedRuleIds?: string[]): Promise<RubricCheckOutcomeShape> => {
      await this.persist(ctx, "failed", reasonCodes);
      return { ok: false, reasonCodes, ...(protectedRuleIds ? { protectedRuleIds } : {}) };
    };

    // Phase 1: protected rules and the polarity readings. Any failure holds now.
    const phase1 = needed.filter((j) => protectedJobs.includes(j) || protectedTriggerJobs.includes(j) || polarityJobs.includes(j));
    const f1 = await this.runJobs(phase1, ctx);
    if (f1) return stop([f1 === "capped" ? "checker_capped" : f1 === "invalid" ? "checker_output_invalid" : "checker_unavailable"]);

    const rowsOf = (role: "verification" | "judgement", jobs: Job[]): Map<string, VerdictRow> => this.rowsFrom(role, jobs, responses);
    const protectedVerdicts = { verification: rowsOf("verification", protectedJobs), judgement: rowsOf("judgement", protectedJobs) };
    const failedIds: string[] = [];
    for (const r of protectedRules) {
      const action = judgeRule(r, { verification: protectedVerdicts.verification.get(r.criterionId), judgement: protectedVerdicts.judgement.get(r.criterionId) });
      if (action.action !== "keep") failedIds.push(r.criterionId);
    }
    // A protected rule's trigger must be confirmed by BOTH models too, or the draft is held.
    const protectedTriggerVerdicts = { verification: this.triggerVerdictsFrom("verification", protectedTriggerJobs, responses), judgement: this.triggerVerdictsFrom("judgement", protectedTriggerJobs, responses) };
    for (const r of protectedTriggered) {
      const verdict = judgeTrigger(r, { verification: protectedTriggerVerdicts.verification.get(r.criterionId), judgement: protectedTriggerVerdicts.judgement.get(r.criterionId) });
      if (verdict === "hold" && !failedIds.includes(r.criterionId)) failedIds.push(r.criterionId);
    }
    if (failedIds.length > 0) {
      this.noteVerdicts(ctx, protectedVerdicts.verification, protectedVerdicts.judgement);
      const out = this.protectedFailure(failedIds);
      await this.persist(ctx, "failed", out.ok ? [] : out.reasonCodes);
      return out;
    }

    let intentPolarity: IntentPolarity | null = null;
    if (polarityPlan.kind === "ask") {
      const answers = polarityJobs.map((j) => responses[j.hash]?.answer as PolarityAnswer);
      intentPolarity = decidePolarity(polarityPlan.value, answers);
      if (intentPolarity === null) {
        this.noteVerdicts(ctx, protectedVerdicts.verification, protectedVerdicts.judgement);
        return stop(["polarity_unverified"]);
      }
    } else intentPolarity = polarityPlan.value;

    // Phase 2: every ordinary rule.
    const f2 = await this.runJobs(
      needed.filter((j) => ordinaryJobs.includes(j) || ordinaryTriggerJobs.includes(j)),
      ctx
    );
    if (f2) return stop([f2 === "capped" ? "checker_capped" : f2 === "invalid" ? "checker_output_invalid" : "checker_unavailable"]);

    // ---- decide each ordinary rule from its verdicts ----
    const ordinaryVerdicts = rowsOf("verification", ordinaryJobs);
    this.noteVerdicts(ctx, new Map([...protectedVerdicts.verification, ...ordinaryVerdicts]), protectedVerdicts.judgement);
    const decided = new Map<string, string>();
    for (const r of unreadableOrdinary) decided.set(r.criterionId, "checker:source_text");
    for (const r of readableOrdinary) {
      const action = judgeRule(r, { verification: ordinaryVerdicts.get(r.criterionId) });
      if (action.action !== "keep") decided.set(r.criterionId, `checker:${action.aspect}`);
    }
    // Rulebook order, so the result is stable.
    const leftOut = rules.filter((r) => decided.has(r.criterionId)).map((r) => ({ criterionId: r.criterionId, reason: decided.get(r.criterionId) as string }));

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
    await this.persist(ctx, "completed", []);
    return { ok: true, leftOut, resolvedFlagCodes, intentPolarity, droppedTriggerIds };
  }

  // ---------- windows ----------

  /**
   * For every rule: its quote and the bounded words around it, read from the
   * snapshot it was cited to. A rule whose quote is not in that snapshot is
   * absent from the result (it cannot be verified). A snapshot that cannot be
   * READ throws: the official text is unavailable, not the rule unfaithful.
   */
  private async buildViews(rules: readonly AssessmentCriterion[]): Promise<Map<string, CheckerRuleView>> {
    const indexes = new Map<string, Promise<SnapshotQuoteIndex>>();
    const indexOf = (sourceId: string, hash: string): Promise<SnapshotQuoteIndex> => {
      const key = `${sourceId}:${hash}`;
      let p = indexes.get(key);
      if (!p) {
        p = this.deps.readSnapshot(sourceId, hash).then((c) => new SnapshotQuoteIndex(c));
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
      if (this.deps.nowMs() - ctx.startedMs > CHECKER_START_DEADLINE_MS) return "unavailable";
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
        if (err instanceof AnthropicNotConfiguredError) return "unavailable";
        const transient = err instanceof LlmProviderError && isTransientProviderError(err.message);
        if (transient && attempt < 2) {
          await this.deps.sleep(CHECKER_RETRY_BACKOFF_MS * attempt);
          continue;
        }
        return "unavailable";
      }
      addUsage(ctx.usage, response.usage);
      // A declined answer is "the check could not run"; a cut-off or odd stop is an incomplete answer.
      if (response.stopReason === "refusal") return "unavailable";
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
    return "unavailable";
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
    await this.deps.ledger.save(record);
  }
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
}

/** The check, over Firestore, the snapshot store and the Anthropic provider. */
export const rubricChecker = new RubricCheckerService();
