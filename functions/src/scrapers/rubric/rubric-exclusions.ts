import type { AssessmentCriterion, EvidenceItem, IntakeQuestion, VisaRubric } from "../../types/rubric";

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
export type DropReason = "no_kept_criterion" | "depends_on_dropped_question";

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
  Partial<Pick<VisaRubric, "excludedCriterionIds" | "exclusionNote" | "evidenceHelpsCriterionIds">>;

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
export function applyExclusions<T extends Filterable>(rubric: T): T {
  const excluded = effectiveExcluded(rubric);
  if (excluded.size === 0) {
    // Nothing to remove. Still strip a stored-but-empty list so the shape is
    // the same either way for the consumer.
    if (rubric.excludedCriterionIds === undefined && rubric.exclusionNote === undefined) return rubric;
    const { excludedCriterionIds: _ids, exclusionNote: _note, ...rest } = rubric;
    void _ids;
    void _note;
    return rest as unknown as T;
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

  const { excludedCriterionIds: _ids, exclusionNote: _note, ...rest } = rubric;
  void _ids;
  void _note;
  const out = { ...rest, criteria: keptCriteria, intakeQuestions: keptQuestions, evidenceItems: keptEvidence } as unknown as T & Filterable;
  // ---- 4c. admin tag of criteria where extra evidence helps ----
  if (Array.isArray(rubric.evidenceHelpsCriterionIds)) out.evidenceHelpsCriterionIds = rubric.evidenceHelpsCriterionIds.filter((id) => !excluded.has(id));
  return out;
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
