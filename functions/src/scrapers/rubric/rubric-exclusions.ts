import type { AssessmentCriterion, CompetenceBlock, EvidenceItem, IntakeQuestion, VisaRubric } from "../../types/rubric";
// (#235) The one code check of a competence block (also used by drafting and the validator).
import { servableCompetence } from "./rubric-competence";
import { applyPlanShape } from "./rubric-question-plan";
import { applyRuleRepairs } from "./rubric-repair";

// ============================================
// RUBRIC — CRITERION EXCLUSIONS (issue #161)
// ============================================
//
// An admin may exclude individual criteria of a PENDING version at approval,
// to prune a large extracted draft without re-running extraction. The
// extracted content is never edited: the choice is stored as the admin-set
// review fields `excludedCriterionIds` (+ `exclusionNote`) and applied on the
// READ side by `applyExclusions`, which `rubricStore.getApprovedRubric` runs
// on every approved rubric. That is the single filter every consumer goes
// through, so none of them needs to know exclusions exist.
//
// What "excluded" removes, in order:
//   1. the excluded criteria (a mandatory bar is NEVER removed, even if its id
//      were listed: the validator refuses such a list, and this function
//      refuses to act on one, so the guarantee does not rest on one layer);
//   2. every intake question whose EVERY linked criterion is excluded (a
//      question that keeps at least one criterion stays, with only the kept
//      ids in `criterionIds`);
//   3. every evidence item whose EVERY linked criterion is excluded (likewise
//      trimmed otherwise; its `when` may name a dropped question: see below);
//   4. dangling references: `intakeQuestionIds` of kept criteria,
//      `evidenceHelpsCriterionIds`, and the `showWhen` / `when` conditions that
//      point at a question that no longer exists.
//
// How a condition on a dropped question is handled: a condition reads the
// answer to ITS question, and a dropped question is never asked, so that
// condition can never be true. A `showWhen.anyOf` therefore loses its dead
// conditions; if none is left the question is unreachable and is dropped too
// (and so, in turn, are the questions that depended on it: this repeats until
// nothing changes). An evidence item whose single `when` names a dropped
// question is unreachable the same way and is dropped. Nothing is ever left
// pointing at a missing question.
//
// (#248) Dropped triggers: an ordinary rule only loses its trigger (as before).
// A MANDATORY BAR whose trigger is dropped is also marked `notCodeDecided` (the
// assessment engine never decides it in code, it judges it in full), and the
// removed trigger's question stops linking to it when the question serves
// another rule. The mark is derived here on every read and never trusted from
// storage. See `isJudgedBarShape` for the two-direction safety argument.
//
// Pure and dependency-free: no Firebase, no clock, no I/O. It knows nothing
// about any route, country or source.

/** Most criteria one exclusion list may name. The first real draft has 276 criteria; this is generous headroom, not a design limit. */
export const MAX_EXCLUDED_CRITERIA = 1000;
/** Longest exclusion note, in characters after trimming. */
export const EXCLUSION_NOTE_MAX = 1000;

/** What an exclusion set would remove, counted by the same function that applies it. */
export interface ExclusionPreview {
  criteriaKept: number;
  criteriaExcluded: number;
  intakeQuestionsKept: number;
  intakeQuestionsDropped: number;
  evidenceItemsKept: number;
  evidenceItemsDropped: number;
  droppedIntakeQuestionIds: string[];
  droppedEvidenceItemKeys: string[];
  // (#169) WHICH questions / evidence items are dropped, and why. Additive:
  // the counts and id lists above are unchanged. Computed by the same
  // analysis `applyExclusions` filters with, so they cannot disagree.
  droppedIntakeQuestions: DroppedIntakeQuestion[];
  droppedEvidenceItems: DroppedEvidenceItem[];
}

/**
 * Why an item is dropped: every criterion it is linked to is excluded
 * (`no_kept_criterion`), or the question its condition reads is itself dropped
 * so the condition can never be true (`depends_on_dropped_question`).
 */
export type DropReason = "no_kept_criterion" | "depends_on_dropped_question" | "failed_check";

export interface DroppedIntakeQuestion {
  id: string;
  label: string;
  reason: DropReason;
  /** The dropped question whose answer this one was waiting on (reason `depends_on_dropped_question`). */
  dependsOn?: string;
  /**
   * Criteria that are KEPT yet still link to this question. Non-empty exactly
   * when the question is dropped only because of its dependency: a kept
   * criterion loses a question it names, which a reviewer should look at.
   * Always empty for `no_kept_criterion`.
   */
  keptCriterionIds: string[];
}

export interface DroppedEvidenceItem {
  key: string;
  title: string;
  reason: DropReason;
  dependsOn?: string;
}

/** The parts of a rubric the filter reads and rewrites. */
type Filterable = Pick<VisaRubric, "criteria" | "intakeQuestions" | "evidenceItems"> &
  Partial<Pick<VisaRubric, "excludedCriterionIds" | "exclusionNote" | "evidenceHelpsCriterionIds" | "questionPlan" | "ruleRepairs">>;

/**
 * (#203) The wording check's omissions stored in the question plan. A question
 * or document item the automatic check found wrong is dropped through the SAME
 * dependency analysis as an excluded rule's questions, so its dependents go
 * with it. This is a correctness removal; the linked rules stay.
 */
function planOmissions(rubric: Filterable): { questions: Set<string>; evidence: Set<string> } {
  const plan = rubric.questionPlan;
  const questions = new Set<string>();
  const evidence = new Set<string>();
  if (plan && typeof plan === "object") {
    for (const o of Array.isArray(plan.omittedQuestions) ? plan.omittedQuestions : []) if (o && typeof o.id === "string") questions.add(o.id);
    for (const o of Array.isArray(plan.omittedEvidence) ? plan.omittedEvidence : []) if (o && typeof o.key === "string") evidence.add(o.key);
  }
  return { questions, evidence };
}

/** The ids actually excluded: listed, present in the rubric, and not a mandatory bar. */
function effectiveExcluded(rubric: Filterable): Set<string> {
  const listed = new Set(Array.isArray(rubric.excludedCriterionIds) ? rubric.excludedCriterionIds : []);
  const out = new Set<string>();
  for (const c of rubric.criteria ?? []) {
    // Defence in depth: a bar stays in force whatever the stored list says.
    if (listed.has(c.criterionId) && c.kind !== "mandatory_bar") out.add(c.criterionId);
  }
  return out;
}

/** True when the list is non-empty and every id in it is excluded. */
const allExcluded = (ids: readonly string[] | undefined, excluded: ReadonlySet<string>): boolean =>
  Array.isArray(ids) && ids.length > 0 && ids.every((id) => excluded.has(id));

/** The outcome of the drop analysis: the dropped ids with their reasons, in rubric order. */
interface DropAnalysis {
  questions: Map<string, { reason: DropReason; dependsOn?: string }>;
  evidence: Map<string, { reason: DropReason; dependsOn?: string }>;
}

/**
 * The ONE place that decides which questions and evidence items an excluded
 * set drops, and why. `applyExclusions` filters with its result and
 * `previewExclusions` reports it, so what is applied and what is shown are the
 * same decision.
 */
function analyseDrops(rubric: Filterable, excluded: ReadonlySet<string>): DropAnalysis {
  const questions: IntakeQuestion[] = Array.isArray(rubric.intakeQuestions) ? rubric.intakeQuestions : [];
  const evidence: EvidenceItem[] = Array.isArray(rubric.evidenceItems) ? rubric.evidenceItems : [];
  const dq = new Map<string, { reason: DropReason; dependsOn?: string }>();

  // ---- questions whose every linked criterion is excluded ----
  for (const q of questions) if (allExcluded(q.criterionIds, excluded)) dq.set(q.id, { reason: "no_kept_criterion" });
  // ---- (#203) questions the automatic wording check failed: seed the same analysis ----
  const omitted = planOmissions(rubric);
  for (const q of questions) if (!dq.has(q.id) && omitted.questions.has(q.id)) dq.set(q.id, { reason: "failed_check" });

  // ---- dead conditions: repeat until no further question becomes unreachable ----
  for (let changed = true; changed; ) {
    changed = false;
    for (const q of questions) {
      if (dq.has(q.id) || !q.showWhen) continue;
      const anyOf = Array.isArray(q.showWhen.anyOf) ? q.showWhen.anyOf : [];
      // Only a condition that names a dropped question is dead. A question
      // with no conditions left to satisfy is unreachable.
      if (anyOf.length > 0 && anyOf.every((cond) => dq.has(cond.questionId))) {
        // Name the first condition's question as the one it depended on.
        dq.set(q.id, { reason: "depends_on_dropped_question", dependsOn: anyOf[0].questionId });
        changed = true;
      }
    }
  }

  // ---- evidence items ----
  const de = new Map<string, { reason: DropReason; dependsOn?: string }>();
  for (const e of evidence) {
    if (allExcluded(e.criterionIds, excluded)) de.set(e.key, { reason: "no_kept_criterion" });
    else if (omitted.evidence.has(e.key)) de.set(e.key, { reason: "failed_check" });
    else if (e.when && dq.has(e.when.questionId)) de.set(e.key, { reason: "depends_on_dropped_question", dependsOn: e.when.questionId });
  }
  return { questions: dq, evidence: de };
}

/**
 * The rubric as consumers must see it: without its excluded criteria and
 * everything that only they justified (see the file header). Returns the
 * input itself when nothing is excluded; otherwise a new object (the input is
 * never mutated). The exclusion fields are dropped from the result: they
 * describe a decision about content that is no longer there.
 */
export function applyExclusions<T extends Filterable>(input: T): T {
  // (#235) Last of all, the competence block: served only while every step
  // still passes the code check against what is now SERVED (its rule kept and
  // unchanged, its question still asked). Otherwise the whole block is left
  // out and the applicant simply picks (rubric-competence.ts).
  return withServableCompetence(applyExclusionsBase(input));
}

/**
 * (#235) The served view with its competence block only when servable. Identity
 * when there is no block, or when the block passes (so a rubric without one
 * reads exactly as before).
 */
function withServableCompetence<T extends Filterable>(served: T): T {
  const block = (served as { competence?: CompetenceBlock }).competence;
  if (block === undefined) return served;
  if (servableCompetence(served as unknown as Pick<VisaRubric, "competence" | "criteria" | "intakeQuestions">) !== undefined) return served;
  const { competence: _dropped, ...rest } = served as T & { competence?: CompetenceBlock };
  void _dropped;
  return rest as T;
}

/** The read-side filter before the competence check (see `applyExclusions`). */
function applyExclusionsBase<T extends Filterable>(input: T): T {
  // (#223) FIRST swap in the recorded replacements of repaired protected rules
  // (same id, same position), so every step below, and every consumer, only
  // ever sees the rule the independent check actually verified. The original
  // stays in the stored `criteria` as the audit trail.
  const rubric = applyRuleRepairs(input);
  // INTEGRATION (#200 + #207): after the exclusions and the plan's shape, ignore the triggers the
  // independent check could not confirm. Done HERE (the one read-side filter every consumer and
  // the planner itself go through) so intake, assessment, checklist, chat and the background
  // readers cannot disagree. The rules stay; only their `trigger` is removed from what is served.
  const dropped = rubric.questionPlan?.droppedTriggerCriterionIds;
  // (#248) A stored `notCodeDecided` is never trusted: the mark is DERIVED below from the
  // version's own review fields. Stripping any stored one first means the only way a bar stops
  // being code-decided is the one path this file controls (a forged mark would weaken a bar).
  const served = stripStoredMarks(applyExclusionsCore(rubric));
  if (!Array.isArray(dropped) || dropped.length === 0) return served;
  const ids = new Set(dropped);
  if (!served.criteria.some((c) => c.trigger !== undefined && ids.has(c.criterionId))) return served;
  // (#248) Bars whose trigger is dropped: served without it AND never decided by code.
  const judged = served.criteria.filter((c) => c.trigger !== undefined && ids.has(c.criterionId) && isJudgedBarShape(c));
  const criteria = served.criteria.map((c) => {
    if (c.trigger === undefined || !ids.has(c.criterionId)) return c;
    // An ordinary rule: exactly as before #248 (only the trigger is removed).
    if (!isJudgedBarShape(c)) return withoutTrigger(c);
    // A bar: the trigger is removed and the rule is marked `notCodeDecided` (see the type).
    return { ...withoutTrigger(c), notCodeDecided: true as const };
  });
  return unlinkJudgedBars({ ...served, criteria }, judged);
}

/**
 * (#248) The rules a dropped trigger turns into "judged, never code-decided": a MANDATORY BAR.
 *
 * WHY ONLY A BAR (both failure directions):
 *  - A barred applicant told they may apply: removing a trigger only WIDENS who a rule is put to,
 *    so it can never hide the bar from someone its condition covers; the bar is still served.
 *  - An eligible applicant wrongly barred: a bar that code decides from nationality would, with
 *    no trigger, bar EVERY applicant of that nationality. So a bar served without its trigger
 *    is never decided by code; the assessment model reads the condition words instead and can
 *    only raise a concern (never a refusal ground).
 * An ordinary rule with a dropped trigger keeps its pre-#248 handling (#248 changes no ordinary
 * rule). Any other protected rule is never in the list: the check holds it as before.
 */
export function isJudgedBarShape(c: Pick<AssessmentCriterion, "kind">): boolean {
  return c.kind === "mandatory_bar";
}

/**
 * (#248) Ids of the bars a version serves without their trigger, derived exactly as
 * `applyExclusions` derives them (this version's own bars, with a trigger, listed in the
 * question plan's dropped triggers), in rulebook order. For the audit entry and the run record.
 */
export function barsServedWithoutTrigger(rubric: Filterable): string[] {
  const listed = new Set(rubric.questionPlan?.droppedTriggerCriterionIds ?? []);
  if (listed.size === 0) return [];
  return applyRuleRepairs(rubric as Filterable & { criteria: AssessmentCriterion[] }).criteria.filter((c) => c.trigger !== undefined && listed.has(c.criterionId) && isJudgedBarShape(c)).map((c) => c.criterionId);
}

/** (#248) The served criteria with any STORED `notCodeDecided` removed (only this file derives it). Identity when none has one. */
function stripStoredMarks<T extends Filterable>(served: T): T {
  if (!served.criteria.some((c) => c.notCodeDecided !== undefined)) return served;
  return {
    ...served,
    criteria: served.criteria.map((c) => {
      if (c.notCodeDecided === undefined) return c;
      const { notCodeDecided: _mark, ...rest } = c;
      void _mark;
      return rest;
    }),
  };
}

/**
 * (#248) The removed trigger no longer links its question to the bar: the bar's id leaves the
 * question's `criterionIds` and the question's id leaves the bar's `intakeQuestionIds`, but ONLY
 * when the question still serves at least one OTHER rule. A question that served the bar alone
 * keeps the link: it is never orphaned (the structural rule "an intake question must name the
 * criteria that read its answer") and never deleted, so its answer still reaches the assessment
 * model, which needs it to judge the bar's condition. A question that cannot be found as served
 * (merged away, dropped) is left alone. Pure; done after the exclusions so the dependency
 * analysis can never drop a question because of it.
 */
function unlinkJudgedBars<T extends Filterable>(served: T, judged: readonly AssessmentCriterion[]): T {
  if (judged.length === 0 || !Array.isArray(served.intakeQuestions)) return served;
  const unlink = new Map<string, Set<string>>(); // question id -> bar ids to remove from it
  for (const bar of judged) {
    const qid = bar.trigger?.questionId;
    const q = served.intakeQuestions.find((x) => x.id === qid);
    if (!q || !(q.criterionIds ?? []).includes(bar.criterionId)) continue;
    const others = (q.criterionIds ?? []).filter((id) => id !== bar.criterionId && !(unlink.get(q.id)?.has(id) ?? false));
    if (others.length === 0) continue;
    unlink.set(q.id, new Set([...(unlink.get(q.id) ?? []), bar.criterionId]));
  }
  if (unlink.size === 0) return served;
  const intakeQuestions = served.intakeQuestions.map((q) => (unlink.has(q.id) ? { ...q, criterionIds: (q.criterionIds ?? []).filter((id) => !unlink.get(q.id)?.has(id)) } : q));
  const criteria = served.criteria.map((c) => {
    if (!c.intakeQuestionIds) return c;
    const gone = c.intakeQuestionIds.filter((qid) => unlink.get(qid)?.has(c.criterionId) ?? false);
    return gone.length === 0 ? c : { ...c, intakeQuestionIds: c.intakeQuestionIds.filter((qid) => !gone.includes(qid)) };
  });
  return { ...served, intakeQuestions, criteria };
}

/** A copy of a rule without its trigger. */
function withoutTrigger(c: AssessmentCriterion): AssessmentCriterion {
  const { trigger: _trigger, ...rest } = c;
  void _trigger;
  return rest;
}

/** The exclusions, merges, conditions and order (everything `applyExclusions` did before the integration). */
function applyExclusionsCore<T extends Filterable>(rubric: T): T {
  const excluded = effectiveExcluded(rubric);
  const omittedByPlan = planOmissions(rubric);
  if (excluded.size === 0 && omittedByPlan.questions.size === 0 && omittedByPlan.evidence.size === 0) {
    // Nothing to remove. Still strip a stored-but-empty list (and the plan,
    // after applying its merges / conditions / order) so the shape is the
    // same either way for the consumer.
    const hasPlan = rubric.questionPlan !== undefined;
    if (rubric.excludedCriterionIds === undefined && rubric.exclusionNote === undefined && !hasPlan) return rubric;
    const { excludedCriterionIds: _ids, exclusionNote: _note, questionPlan: _plan, ...rest } = rubric;
    void _ids;
    void _note;
    void _plan;
    const bare = rest as unknown as T & Filterable;
    return (hasPlan && rubric.questionPlan ? applyPlanShape(bare, rubric.questionPlan) : bare) as unknown as T;
  }

  const questions: IntakeQuestion[] = Array.isArray(rubric.intakeQuestions) ? rubric.intakeQuestions : [];
  const evidence: EvidenceItem[] = Array.isArray(rubric.evidenceItems) ? rubric.evidenceItems : [];

  // ---- 2 + 4a. dropped questions (see `analyseDrops`) ----
  const analysis = analyseDrops(rubric, excluded);
  const dropped = new Set(analysis.questions.keys());

  const keptQuestions: IntakeQuestion[] = questions
    .filter((q) => !dropped.has(q.id))
    .map((q) => {
      const next: IntakeQuestion = { ...q, criterionIds: (q.criterionIds ?? []).filter((id) => !excluded.has(id)) };
      if (q.showWhen) next.showWhen = { ...q.showWhen, anyOf: (q.showWhen.anyOf ?? []).filter((cond) => !dropped.has(cond.questionId)) };
      return next;
    });

  // ---- 3. evidence items ----
  const keptEvidence: EvidenceItem[] = evidence
    .filter((e) => !analysis.evidence.has(e.key))
    .map((e) => ({ ...e, criterionIds: (e.criterionIds ?? []).filter((id) => !excluded.has(id)) }));

  // ---- 1 + 4b. criteria, with references to dropped questions cleaned ----
  const keptCriteria: AssessmentCriterion[] = rubric.criteria
    .filter((c) => !excluded.has(c.criterionId))
    .map((c) => (c.intakeQuestionIds ? { ...c, intakeQuestionIds: c.intakeQuestionIds.filter((id) => !dropped.has(id)) } : c));

  const { excludedCriterionIds: _ids, exclusionNote: _note, questionPlan: _plan, ...rest } = rubric;
  void _ids;
  void _note;
  void _plan;
  let out = { ...rest, criteria: keptCriteria, intakeQuestions: keptQuestions, evidenceItems: keptEvidence } as unknown as T & Filterable;
  // ---- (#203) the plan's merges, conditions and order, on what is left ----
  // After the removals, so a merge or an order never names a dropped question.
  if (rubric.questionPlan) out = applyPlanShape(out, rubric.questionPlan);
  // ---- 4c. admin tag of criteria where extra evidence helps ----
  if (Array.isArray(rubric.evidenceHelpsCriterionIds)) out.evidenceHelpsCriterionIds = rubric.evidenceHelpsCriterionIds.filter((id) => !excluded.has(id));
  return out as T;
}

/**
 * What excluding `excludedIds` from `rubric` would remove, by running the very
 * function that will apply it. Ids that are not criteria of the rubric, and
 * mandatory bars, have no effect here (the validator refuses them before
 * anything is stored; the preview endpoint refuses them before calling this).
 */
export function previewExclusions(rubric: Filterable, excludedIds: readonly string[]): ExclusionPreview {
  const before = rubric;
  const after = applyExclusions({ ...rubric, excludedCriterionIds: [...excludedIds] });
  const keptQuestionIds = new Set((after.intakeQuestions ?? []).map((q) => q.id));
  const keptEvidenceKeys = new Set((after.evidenceItems ?? []).map((e) => e.key));
  const droppedIntakeQuestionIds = (before.intakeQuestions ?? []).map((q) => q.id).filter((id) => !keptQuestionIds.has(id));
  const droppedEvidenceItemKeys = (before.evidenceItems ?? []).map((e) => e.key).filter((key) => !keptEvidenceKeys.has(key));
  const criteriaKept = (after.criteria ?? []).length;
  // (#169) The reasons, from the same analysis the filter used.
  const excludedSet = effectiveExcluded({ ...rubric, excludedCriterionIds: [...excludedIds] });
  const analysis = analyseDrops(rubric, excludedSet);
  const droppedIntakeQuestions: DroppedIntakeQuestion[] = (before.intakeQuestions ?? [])
    .filter((q) => analysis.questions.has(q.id))
    .map((q) => {
      const why = analysis.questions.get(q.id)!;
      const out: DroppedIntakeQuestion = {
        id: q.id,
        label: q.label,
        reason: why.reason,
        // Kept criteria still linking to it: only possible for a dependency drop.
        keptCriterionIds: why.reason === "depends_on_dropped_question" ? (q.criterionIds ?? []).filter((id) => !excludedSet.has(id)) : [],
      };
      if (why.dependsOn !== undefined) out.dependsOn = why.dependsOn;
      return out;
    });
  const droppedEvidenceItems: DroppedEvidenceItem[] = (before.evidenceItems ?? [])
    .filter((e) => analysis.evidence.has(e.key))
    .map((e) => {
      const why = analysis.evidence.get(e.key)!;
      const out: DroppedEvidenceItem = { key: e.key, title: e.title, reason: why.reason };
      if (why.dependsOn !== undefined) out.dependsOn = why.dependsOn;
      return out;
    });
  return {
    criteriaKept,
    criteriaExcluded: (before.criteria ?? []).length - criteriaKept,
    intakeQuestionsKept: keptQuestionIds.size,
    intakeQuestionsDropped: droppedIntakeQuestionIds.length,
    evidenceItemsKept: keptEvidenceKeys.size,
    evidenceItemsDropped: droppedEvidenceItemKeys.length,
    droppedIntakeQuestionIds,
    droppedEvidenceItemKeys,
    droppedIntakeQuestions,
    droppedEvidenceItems,
  };
}
