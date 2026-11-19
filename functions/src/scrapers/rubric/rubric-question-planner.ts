import type { QuestionPlan, VisaRubric } from "../../types/rubric";
import { AnthropicLlmProvider, type LlmProvider } from "../../services/ai/llm-provider";
import { applyExclusions } from "./rubric-exclusions";
import { buildPlanShape, duplicateKey, type CheckOmissions } from "./rubric-question-plan";
import { DEFAULT_QUESTION_CHECK_LIMITS, QUESTION_CHECK_PROMPT_VERSION, QuestionCheckError, runQuestionCheck, type QuestionCheckLimits } from "./rubric-question-check";

// ============================================
// RUBRIC — THE QUESTION PLANNER (issue #203, part of #200)
// ============================================
//
// Part A's pipeline calls `plan(input)` once every earlier gate and the
// independent rule check have passed. The planner
//   1. takes the draft as it will be served (the leave-outs applied),
//   2. has the wording of every question and document item checked against its
//      rule's quoted sentence (rubric-question-check.ts),
//   3. removes what failed, WITH its dependents, through the exclusion
//      dependency logic (the linked rules stay),
//   4. merges exact duplicates, derives conditions the rules' own trigger data
//      supports, orders and sizes the rest (rubric-question-plan.ts),
//   5. returns the result as the `questionPlan` review field the approval
//      writes, and resolves the `intake_wording_uncited` flag when every
//      question that is served passed the check.
//
// A rule never loses a question for any reason but a failed check. Nothing is
// reworded and nothing is added. Anything unusable (provider failure, an
// invalid answer, a cap, a plan that leaves no question at all) returns
// `ok: false`, and the draft is held.
//
// Generic: no country, nationality, route or publisher is named here.

/** The reason codes this planner can hold a draft with. */
export const QUESTION_PLAN_REASONS = { unusable: "question_plan_unusable", capped: "question_check_capped" } as const;

/** Structurally the same as the pipeline's `QuestionPlanInput` (kept local: scrapers do not import services). */
export interface PlannerInput {
  routeKey: string;
  version: number;
  runId: string;
  rubric: VisaRubric;
  excludedCriterionIds: readonly string[];
  checkerLeftOut: readonly { criterionId: string; reason: string }[];
  // INTEGRATION: rules whose trigger the independent check could not confirm. Optional so an older caller still works.
  droppedTriggerIds?: readonly string[];
}

/** Structurally the same as the pipeline's `QuestionPlanOutcome`. */
export type PlannerOutcome = { ok: true; reviewFields?: Record<string, unknown>; resolvedFlagCodes?: string[] } | { ok: false; reasonCodes: string[] };

/**
 * Build the plan for a draft given what the wording check failed. PURE (no
 * model): the offline report and the tests use it with no failures.
 *
 * `check` is the record of the check run (null for an offline plan).
 */
export function buildQuestionPlan(rubric: VisaRubric, excludedCriterionIds: readonly string[], failed: CheckOmissions, check: QuestionPlan["check"], droppedTriggerIds: readonly string[] = []): QuestionPlan {
  // INTEGRATION: only ids of this version's own rules that really carry a trigger are recorded
  // (a stale or foreign id is ignored), in rulebook order, so the plan always validates.
  const dropped = new Set(droppedTriggerIds);
  const droppedTriggerCriterionIds = rubric.criteria.filter((c) => c.trigger !== undefined && dropped.has(c.criterionId)).map((c) => c.criterionId);
  // The draft as served without the plan: leave-outs applied, plan stripped.
  const base = applyExclusions({ ...rubric, excludedCriterionIds: [...excludedCriterionIds], questionPlan: undefined });
  const baseQuestionIds = new Set(base.intakeQuestions.map((q) => q.id));
  const baseEvidenceKeys = new Set(base.evidenceItems.map((e) => e.key));
  // Keep only failures that name an item of the view (and in rubric order).
  const omittedQuestions = base.intakeQuestions.filter((q) => failed.questions.some((f) => f.id === q.id)).map((q) => ({ id: q.id, failed: [...(failed.questions.find((f) => f.id === q.id)?.failed ?? [])].sort() }));
  const omittedEvidence = base.evidenceItems.filter((e) => failed.evidence.some((f) => f.key === e.key)).map((e) => ({ key: e.key, failed: [...(failed.evidence.find((f) => f.key === e.key)?.failed ?? [])].sort() }));
  // The same dependency analysis the read side runs, with the failures seeded.
  // The dropped triggers are seeded too, so the conditions derived below never come from a link nobody confirmed.
  const withOmissions = applyExclusions({ ...rubric, excludedCriterionIds: [...excludedCriterionIds], questionPlan: { ...EMPTY_SHAPE, omittedQuestions, omittedEvidence, droppedTriggerCriterionIds } as QuestionPlan });
  const keptQ = new Set(withOmissions.intakeQuestions.map((q) => q.id));
  const keptE = new Set(withOmissions.evidenceItems.map((e) => e.key));
  const direct = new Set(omittedQuestions.map((o) => o.id));
  const directE = new Set(omittedEvidence.map((o) => o.key));
  const droppedWithDependents = {
    questionIds: [...baseQuestionIds].filter((id) => !keptQ.has(id) && !direct.has(id)),
    evidenceKeys: [...baseEvidenceKeys].filter((k) => !keptE.has(k) && !directE.has(k)),
  };
  // Merges, conditions and order, on the view as it is left after the removals.
  const shape = buildPlanShape(withOmissions);
  return { ...shape, omittedQuestions, omittedEvidence, droppedWithDependents, droppedTriggerCriterionIds, check };
}

/** A plan with no content, used to seed the omissions on the way. */
const EMPTY_SHAPE: Omit<QuestionPlan, "omittedQuestions" | "omittedEvidence"> = {
  algorithmVersion: "",
  droppedWithDependents: { questionIds: [], evidenceKeys: [] },
  merges: [],
  proposedConditions: [],
  order: [],
  sizing: { total: 0, unconditional: 0, deciding: 0, best: 0, typical: 0, worst: 0, exact: true, samples: 0 },
  check: null,
};

/** The planner: checks the wording with the model, then builds the plan. */
export class RubricQuestionPlanner {
  private lazyProvider: LlmProvider | null = null;

  constructor(
    private readonly deps: { provider?: LlmProvider; limits?: QuestionCheckLimits } = {}
  ) {}

  /** The provider, built on first use so importing costs nothing. */
  private get provider(): LlmProvider {
    return this.deps.provider ?? (this.lazyProvider ??= new AnthropicLlmProvider());
  }

  async plan(input: PlannerInput): Promise<PlannerOutcome> {
    // What will be served, before the plan: the check sees only these questions and items.
    const view = applyExclusions({ ...input.rubric, excludedCriterionIds: [...input.excludedCriterionIds], questionPlan: undefined });
    let result;
    try {
      result = await runQuestionCheck(view, this.provider, this.deps.limits ?? DEFAULT_QUESTION_CHECK_LIMITS);
    } catch (err) {
      const code = err instanceof QuestionCheckError ? err.code : "provider_error";
      // The class and code only: never a prompt or an answer.
      console.error(`Rubric question plan: the wording check failed for ${input.runId} (${code})`);
      return { ok: false, reasonCodes: [code === "capped" ? QUESTION_PLAN_REASONS.capped : QUESTION_PLAN_REASONS.unusable] };
    }
    const failed: CheckOmissions = {
      questions: [...result.failedQuestions].map(([id, f]) => ({ id, failed: f })),
      evidence: [...result.failedEvidence].map(([key, f]) => ({ key, failed: f })),
    };
    const plan = buildQuestionPlan(input.rubric, input.excludedCriterionIds, failed, {
      promptVersion: QUESTION_CHECK_PROMPT_VERSION,
      model: result.model,
      calls: result.calls,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      questionsChecked: result.questionsChecked,
      evidenceItemsChecked: result.evidenceItemsChecked,
      questionsFailed: result.failedQuestions.size,
      evidenceItemsFailed: result.failedEvidence.size,
    }, input.droppedTriggerIds ?? []);
    // A check that removes EVERY question of a draft that had some is a
    // malfunction, not a verdict: hold rather than serve a rulebook with none.
    if (view.intakeQuestions.length > 0 && plan.order.length === 0) return { ok: false, reasonCodes: [QUESTION_PLAN_REASONS.unusable] };
    // Every question that is SERVED passed the check (the failures are removed),
    // so the wording is verified: the flag about uncited wording is resolved.
    return { ok: true, reviewFields: { questionPlan: plan }, resolvedFlagCodes: ["intake_wording_uncited"] };
  }
}

// ============================================
// Offline report (no model): what the plan does to a draft
// ============================================

/** Figures for one draft, computed in code by the same functions the planner uses. */
export interface QuestionPlanReport {
  rules: number;
  ruleKinds: Record<string, number>;
  questionsBefore: number;
  questionsWithoutCondition: number;
  exactDuplicateGroups: number;
  exactDuplicateQuestions: number;
  merges: number;
  proposedConditions: number;
  questionsAfterMerge: number;
  unconditionalAfterPlan: number;
  decidingQuestions: number;
  sizing: QuestionPlan["sizing"];
  rulesWithQuestion: Record<string, number>;
  rulesWithoutQuestion: Record<string, number>;
  evidenceItems: number;
  evidenceItemsGatedByQuestion: number;
}

/**
 * The offline report for a draft (the wording check cannot run offline, so no
 * question is omitted: the figures are an UPPER bound on what an applicant
 * sees). `excludedCriterionIds` are the leave-outs to apply first (none by default).
 */
export function questionPlanReport(rubric: VisaRubric, excludedCriterionIds: readonly string[] = []): QuestionPlanReport {
  const view = applyExclusions({ ...rubric, excludedCriterionIds: [...excludedCriterionIds], questionPlan: undefined });
  const plan = buildQuestionPlan(rubric, excludedCriterionIds, { questions: [], evidence: [] }, null);
  const served = applyExclusions({ ...rubric, excludedCriterionIds: [...excludedCriterionIds], questionPlan: plan });
  const groups = new Map<string, number>();
  for (const q of view.intakeQuestions) groups.set(duplicateKey(q), (groups.get(duplicateKey(q)) ?? 0) + 1);
  const dupGroups = [...groups.values()].filter((n) => n > 1);
  const kinds: Record<string, number> = {};
  const withQ: Record<string, number> = {};
  const withoutQ: Record<string, number> = {};
  const linked = new Set(served.intakeQuestions.flatMap((q) => q.criterionIds));
  for (const c of served.criteria) {
    kinds[c.kind] = (kinds[c.kind] ?? 0) + 1;
    const bucket = linked.has(c.criterionId) ? withQ : withoutQ;
    bucket[c.kind] = (bucket[c.kind] ?? 0) + 1;
  }
  return {
    rules: served.criteria.length,
    ruleKinds: kinds,
    questionsBefore: view.intakeQuestions.length,
    questionsWithoutCondition: view.intakeQuestions.filter((q) => (q.showWhen?.anyOf ?? []).length === 0).length,
    exactDuplicateGroups: dupGroups.length,
    exactDuplicateQuestions: dupGroups.reduce((n, k) => n + k - 1, 0),
    merges: plan.merges.length,
    proposedConditions: plan.proposedConditions.length,
    questionsAfterMerge: served.intakeQuestions.length,
    unconditionalAfterPlan: plan.sizing.unconditional,
    decidingQuestions: plan.sizing.deciding,
    sizing: plan.sizing,
    rulesWithQuestion: withQ,
    rulesWithoutQuestion: withoutQ,
    evidenceItems: served.evidenceItems.length,
    evidenceItemsGatedByQuestion: served.evidenceItems.filter((e) => e.when).length,
  };
}
