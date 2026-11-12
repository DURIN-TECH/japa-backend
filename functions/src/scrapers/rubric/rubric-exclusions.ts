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

  // ---- 2. questions whose every linked criterion is excluded ----
  const dropped = new Set<string>();
  for (const q of questions) if (allExcluded(q.criterionIds, excluded)) dropped.add(q.id);

  // ---- 4a. dead conditions: repeat until no further question becomes unreachable ----
  for (let changed = true; changed; ) {
    changed = false;
    for (const q of questions) {
      if (dropped.has(q.id) || !q.showWhen) continue;
      const anyOf = Array.isArray(q.showWhen.anyOf) ? q.showWhen.anyOf : [];
      // Only a condition that names a dropped question is dead. A question
      // with no conditions left to satisfy is unreachable.
      if (anyOf.length > 0 && anyOf.every((cond) => dropped.has(cond.questionId))) {
        dropped.add(q.id);
        changed = true;
      }
    }
  }

  const keptQuestions: IntakeQuestion[] = questions
    .filter((q) => !dropped.has(q.id))
    .map((q) => {
      const next: IntakeQuestion = { ...q, criterionIds: (q.criterionIds ?? []).filter((id) => !excluded.has(id)) };
      if (q.showWhen) next.showWhen = { ...q.showWhen, anyOf: (q.showWhen.anyOf ?? []).filter((cond) => !dropped.has(cond.questionId)) };
      return next;
    });

  // ---- 3. evidence items ----
  const keptEvidence: EvidenceItem[] = evidence
    .filter((e) => !allExcluded(e.criterionIds, excluded) && !(e.when && dropped.has(e.when.questionId)))
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
  return {
    criteriaKept,
    criteriaExcluded: (before.criteria ?? []).length - criteriaKept,
    intakeQuestionsKept: keptQuestionIds.size,
    intakeQuestionsDropped: droppedIntakeQuestionIds.length,
    evidenceItemsKept: keptEvidenceKeys.size,
    evidenceItemsDropped: droppedEvidenceItemKeys.length,
    droppedIntakeQuestionIds,
    droppedEvidenceItemKeys,
  };
}
