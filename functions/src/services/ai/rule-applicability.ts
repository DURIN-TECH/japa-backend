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
import { answerIncludesAny, conditionsForTriggers, isUnanswered, isValidTrigger } from "../../utils/rubric-trigger";

// ============================================
// Answers and trigger validity: ONE implementation (INTEGRATION, #200)
// ============================================
//
// "Does this answer satisfy this trigger" and "is this trigger usable" live in
// utils/rubric-trigger.ts, a pure module the scrapers' question plan also uses
// (it may not import from services). They are re-exported here so every
// consumer keeps importing them from this file.
export { answerIncludesAny, conditionsForTriggers, isUnanswered, isValidTrigger, triggerValuesOf } from "../../utils/rubric-trigger";

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
  // (#248) A mandatory bar served WITHOUT its unconfirmed trigger (`notCodeDecided`, set only by
  // the read-side filter) is put to EVERY applicant, and only ever judged, never code-decided.
  // Reading it as "could not tell" (a specialist rule with no trigger) would keep it from the
  // applicant it covers, so a barred applicant would hear nothing about the bar. Putting it to
  // everyone cannot wrongly bar anyone: the assessment model reads its condition words and can
  // only raise a concern; code never refuses on it (see `mandatoryBarHits`).
  if (criterion.kind === "mandatory_bar" && criterion.notCodeDecided === true) return { status: "applies" };

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
export function notAssessedItems(split: ApplicabilitySplit): Array<{ criterionId: string; title: string; reason: string; notAssessed: UnknownReason; layerKey?: string }> {
  // (#233) The rule's layer rides along on a multi-layer stack (absent otherwise).
  return split.unknown.map((u) => ({ criterionId: u.criterion.criterionId, title: u.criterion.title, reason: couldNotAssessReason(u), notAssessed: u.reason, ...(u.criterion.layerKey ? { layerKey: u.criterion.layerKey } : {}) }));
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
    // (#248) A bar served without its unconfirmed trigger (`notCodeDecided`) is NOT hopeless: it is put to
    // every applicant (see `resolveApplicability`), so a question it reads must stay asked. Counting it as
    // hopeless would drop a question that only such a bar reads, and with it an answer the assessment
    // model needs to weigh the bar's condition.
    const hopeless = relevant.filter((c) => c.applicability === "specialist" && !isValidTrigger(c.trigger, questions) && !(c.kind === "mandatory_bar" && c.notCodeDecided === true));
    if (gated.length + hopeless.length < relevant.length) {
      out.push(q);
      continue;
    }
    if (gated.length === 0) continue; // only unassessable specialist rules read it
    // One `in` condition per trigger question, values joined (shared with the question plan).
    const anyOf: IntakeCondition[] = conditionsForTriggers(gated.map((c) => c.trigger as RuleTrigger));
    out.push({ ...q, showWhen: { anyOf } });
  }
  return out;
}
