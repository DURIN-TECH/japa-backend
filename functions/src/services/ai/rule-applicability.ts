/**
 * Rule applicability (issue #207): the PURE half that decides, in code, whether
 * a rubric criterion applies to ONE applicant, from the applicant's saved
 * intake answers. No Firebase, no model, no clock.
 *
 * WHY THIS EXISTS. A rulebook now keeps every rule the guidance states for a
 * route, including rules that apply only to a specialist activity or
 * sub-category (`applicability: "specialist"`) or only in some circumstances
 * (`"conditional"`). Such a rule must only be assessed for applicants its
 * condition covers. Extraction links each one to the intake answer(s) that
 * trigger it (`criterion.trigger = { questionId, anyOf }`, validated in code
 * against the rubric's own questions and options). Every consumer (assessment,
 * checklist, intake, chat, upload check, proposed actions) asks this module.
 *
 * THREE OUTCOMES, and no fourth:
 *   - `applies`         assess it.
 *   - `not_applicable`  the applicant's answer is not one the rule is
 *                       triggered by: no finding, no question, no document
 *                       item, no proposed action. It is not a pass either.
 *   - `unknown`         "could not tell whether this applies": the trigger
 *                       question is unanswered, or a specialist rule has no
 *                       valid trigger. Reported as not assessable ("we need to
 *                       know X"), never as a failed rule and never as applying
 *                       to everyone.
 *
 * Generic by design: nothing here names a country, route, activity or
 * nationality. Triggers are data in the rubric.
 */
import type { AssessmentCriterion, IntakeCondition, IntakeQuestion, RuleTrigger, VisaRubric } from "../../types/rubric";

// ============================================
// Answers
// ============================================

/** True when an intake answer counts as "not answered". */
export function isUnanswered(answer: unknown): boolean {
  if (answer === undefined || answer === null) return true;
  if (typeof answer === "string") return answer.trim() === "";
  if (Array.isArray(answer)) return answer.length === 0;
  return false;
}

/**
 * The string forms of an answer that a trigger's `anyOf` is compared with. A
 * multi-choice answer is an array (any selected option counts); a yes/no answer
 * is the boolean, compared as "true" / "false"; a number as its digits.
 */
function answerTokens(answer: unknown): string[] {
  const list = Array.isArray(answer) ? answer : [answer];
  return list.filter((v) => typeof v === "string" || typeof v === "boolean" || typeof v === "number").map((v) => String(v));
}

/** Does the answer include any of the wanted option values? */
export function answerIncludesAny(answer: unknown, wanted: readonly string[]): boolean {
  const tokens = answerTokens(answer);
  return tokens.some((t) => wanted.includes(t));
}

// ============================================
// Trigger validity (shared by extraction and every consumer)
// ============================================

/**
 * The answer values a question can be answered with, as strings; null when a
 * trigger cannot be checked against the question (free text, dates, amounts:
 * a rule cannot be "triggered" by a value nobody can enumerate).
 */
export function triggerValuesOf(question: Pick<IntakeQuestion, "answerType" | "options">): string[] | null {
  if (question.answerType === "single_choice" || question.answerType === "multi_choice") {
    const opts = (question.options ?? []).map((o) => o.value);
    return opts.length > 0 ? opts : null;
  }
  if (question.answerType === "yes_no") return ["true", "false"];
  return null;
}

/**
 * Is the trigger usable against these questions? The question must exist, be
 * of a type whose answers can be enumerated, and every wanted value must be
 * one of them. A trigger that fails this is treated as ABSENT by consumers
 * (so a damaged link can never make a rule apply to everyone: a specialist
 * rule without a valid trigger is "could not tell").
 */
export function isValidTrigger(trigger: RuleTrigger | undefined, questions: readonly Pick<IntakeQuestion, "id" | "answerType" | "options">[]): trigger is RuleTrigger {
  if (!trigger || typeof trigger.questionId !== "string" || !Array.isArray(trigger.anyOf) || trigger.anyOf.length === 0) return false;
  const q = questions.find((x) => x.id === trigger.questionId);
  if (!q) return false;
  const allowed = triggerValuesOf(q);
  return allowed !== null && trigger.anyOf.every((v) => typeof v === "string" && allowed.includes(v));
}

// ============================================
// Resolution
// ============================================

/** Why a rule's applicability is unknown. */
export type UnknownReason = "unanswered" | "no_trigger";

/** What `resolveApplicability` says about one rule for one applicant. */
export type RuleApplicability =
  | { status: "applies" }
  | { status: "not_applicable" }
  | { status: "unknown"; reason: UnknownReason; questionId?: string; need: string };

/** The slice of a rubric the resolver reads. */
export type ApplicabilityRubric = Pick<VisaRubric, "criteria" | "intakeQuestions">;

/** True for a rule whose scope is conditional on the applicant (not "everyone"). */
function isScoped(c: AssessmentCriterion): boolean {
  return c.applicability === "specialist" || c.applicability === "conditional";
}

/**
 * Decide whether one criterion applies to an applicant with these answers.
 *
 *  - `all_applicants` (or no applicability: a rubric that predates the field):
 *    applies.
 *  - `specialist` / `conditional` WITH a valid trigger: applies when the
 *    applicant's answer includes one of the trigger's values; not applicable
 *    when answered otherwise; unknown when the trigger question is unanswered.
 *  - `specialist` WITHOUT a valid trigger: unknown (`no_trigger`).
 *  - `conditional` WITHOUT a valid trigger: applies, as every conditional rule
 *    did before #207 (rubrics approved earlier carry no triggers, and a
 *    conditional rule's evidence and questions already have their own
 *    conditions). Re-extraction links them.
 *  - `other_route` is never stored by extraction; if one is met anyway it does
 *    not apply (it is about a different route).
 */
export function resolveApplicability(
  criterion: AssessmentCriterion,
  questions: readonly IntakeQuestion[],
  answers: Record<string, unknown> | null | undefined
): RuleApplicability {
  if (criterion.applicability === "other_route") return { status: "not_applicable" };
  if (!isScoped(criterion)) return { status: "applies" };

  if (!isValidTrigger(criterion.trigger, questions)) {
    if (criterion.applicability === "conditional") return { status: "applies" };
    return { status: "unknown", reason: "no_trigger", need: "whether this rule applies to your application" };
  }
  const trigger = criterion.trigger;
  const q = questions.find((x) => x.id === trigger.questionId) as IntakeQuestion;
  const answer = (answers ?? {})[trigger.questionId];
  if (isUnanswered(answer)) {
    return { status: "unknown", reason: "unanswered", questionId: q.id, need: q.label };
  }
  return answerIncludesAny(answer, trigger.anyOf) ? { status: "applies" } : { status: "not_applicable" };
}

/** The split of a rubric's criteria for one applicant. */
export interface ApplicabilitySplit {
  // Criteria to assess, in rubric order.
  applicable: AssessmentCriterion[];
  // Ids of criteria the applicant's answers rule out (nothing is produced for them).
  notApplicableIds: string[];
  // Criteria that could not be decided either way, with what is needed.
  unknown: Array<{ criterion: AssessmentCriterion; reason: UnknownReason; questionId?: string; need: string }>;
}

/**
 * Split every criterion of a rubric by applicability for one applicant. Every
 * criterion lands in exactly ONE of the three lists, so nothing is silently
 * lost (a test asserts the three counts add up to the rubric's).
 */
export function splitByApplicability(rubric: ApplicabilityRubric, answers: Record<string, unknown> | null | undefined): ApplicabilitySplit {
  const questions = Array.isArray(rubric.intakeQuestions) ? rubric.intakeQuestions : [];
  const out: ApplicabilitySplit = { applicable: [], notApplicableIds: [], unknown: [] };
  for (const c of rubric.criteria) {
    const r = resolveApplicability(c, questions, answers);
    if (r.status === "applies") out.applicable.push(c);
    else if (r.status === "not_applicable") out.notApplicableIds.push(c.criterionId);
    else out.unknown.push({ criterion: c, reason: r.reason, ...(r.questionId ? { questionId: r.questionId } : {}), need: r.need });
  }
  return out;
}

/**
 * The "could not be assessed" items of an assessment: one per rule whose
 * applicability is unknown, in rubric order, in the existing insufficient-
 * information shape. Plain words, no verdict.
 */
export function notAssessedItems(split: ApplicabilitySplit): Array<{ criterionId: string; title: string; reason: string; notAssessed: UnknownReason }> {
  return split.unknown.map((u) => ({ criterionId: u.criterion.criterionId, title: u.criterion.title, reason: couldNotAssessReason(u), notAssessed: u.reason }));
}

/**
 * The reason text stored on a "could not be assessed" item. Plain words; the
 * `need` is the rubric question's own label or a fixed phrase.
 */
export function couldNotAssessReason(u: { reason: UnknownReason; need: string }): string {
  return u.reason === "unanswered"
    ? `could not be assessed: we need to know ${u.need}`
    : `could not be assessed: we need to know ${u.need} (the guidance does not say which answer this rule depends on)`;
}

// ============================================
// Which criteria an applicant's answers leave "in play" (documents, chat, checks)
// ============================================

/**
 * Ids of the criteria that apply to the applicant. Used by consumers that only
 * need a membership test (the checklist and upload check).
 */
export function applicableCriterionIds(rubric: ApplicabilityRubric, answers: Record<string, unknown> | null | undefined): Set<string> {
  return new Set(splitByApplicability(rubric, answers).applicable.map((c) => c.criterionId));
}

// ============================================
// Intake: which questions a rule's trigger shows
// ============================================

/**
 * The intake questions as an applicant should see them: a question that only
 * triggered rules read is shown only once an answer triggers one of them.
 *
 * For each question (that has no condition of its own) look at the criteria
 * that read it, ignoring criteria triggered BY this very question (the
 * activity question is read by the rules it triggers, and must always be
 * asked):
 *   - none left                              -> unchanged (always shown);
 *   - any is not scoped, or a conditional
 *     rule without a valid trigger           -> unchanged (always shown);
 *   - all are scoped with a valid trigger    -> `showWhen` = ANY of their
 *     trigger conditions (values on the same question are joined into one);
 *   - all are specialist without a valid trigger (or mixed with those)
 *     and none can ever be assessed          -> the question is left out:
 *     asking would serve no rule.
 *
 * A question that already has its own `showWhen` keeps it (the model's or the
 * reviewer's decision wins).
 */
export function effectiveIntakeQuestions(rubric: ApplicabilityRubric): IntakeQuestion[] {
  const questions = Array.isArray(rubric.intakeQuestions) ? rubric.intakeQuestions : [];
  const byId = new Map(rubric.criteria.map((c) => [c.criterionId, c]));
  const out: IntakeQuestion[] = [];
  for (const q of questions) {
    if (q.showWhen && q.showWhen.anyOf?.length > 0) {
      out.push(q);
      continue;
    }
    const linked = (q.criterionIds ?? []).map((id) => byId.get(id)).filter((c): c is AssessmentCriterion => c !== undefined);
    const relevant = linked.filter((c) => !(isValidTrigger(c.trigger, questions) && c.trigger.questionId === q.id));
    if (relevant.length === 0) {
      out.push(q);
      continue;
    }
    // A rule that always applies (or a conditional one we cannot gate) keeps the question visible.
    const gated = relevant.filter((c) => isScoped(c) && isValidTrigger(c.trigger, questions));
    const hopeless = relevant.filter((c) => c.applicability === "specialist" && !isValidTrigger(c.trigger, questions));
    if (gated.length + hopeless.length < relevant.length) {
      out.push(q);
      continue;
    }
    if (gated.length === 0) continue; // only unassessable specialist rules read it
    // Join the trigger values per question into one condition each.
    const byQuestion = new Map<string, Set<string>>();
    for (const c of gated) {
      const t = c.trigger as RuleTrigger;
      const set = byQuestion.get(t.questionId) ?? new Set<string>();
      for (const v of t.anyOf) set.add(v);
      byQuestion.set(t.questionId, set);
    }
    const anyOf: IntakeCondition[] = [...byQuestion.entries()].map(([questionId, values]) => ({ questionId, op: "in" as const, value: [...values] }));
    out.push({ ...q, showWhen: { anyOf } });
  }
  return out;
}
