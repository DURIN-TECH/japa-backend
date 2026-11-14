import type { AssessmentCriterion, IntentPolarity, VisaRubric } from "../types/rubric";

// ============================================
// RUBRIC REVIEW — DIFF OF TWO VERSIONS (issue #125)
// ============================================
//
// What a reviewer needs before approving version N+1 of a route's rubric:
// what changed against the version that is serving today.
//
// How criteria are matched:
//
//  1. BY `criterionId`. The id is derived in code from the source, the
//     normalised quote, the kind and the checked field (#40), so the same
//     rule text read the same way has the same id in every version. Two
//     criteria with the same id can still differ (severity, title, stage, a
//     check's value, the rule reference): those are "changed".
//  2. BY `ruleRef`, for what is left. A rule whose TEXT changed gets a new id,
//     so by id alone it shows as one removed and one added criterion. Where a
//     removed and an added criterion carry the same publisher reference
//     (paragraph number), they are paired and shown as ONE changed rule, with
//     the old and new quote side by side. A reference shared by several
//     criteria is paired only where the pairing is unambiguous (same kind and
//     same checked field, or exactly one candidate left on each side);
//     anything else stays "added" / "removed" rather than being guessed.
//
// Pure functions over two rubric objects: no Firebase, no clock, no I/O. It
// knows nothing about any route, country or nationality: everything is data.

/**
 * The criterion fields a change is reported on, in the order they are shown.
 * Dotted names reach into `source`. `criterionId` is not listed: it is the
 * key, and a pair matched by `ruleRef` reports both ids on the row itself.
 */
export const RUBRIC_DIFF_FIELDS = [
  "title",
  "kind",
  "stage",
  "severity",
  "ruleRef",
  "source.quote",
  "source.url",
  "source.page",
  // (#222) the list lines attached to a lead-in quote
  "source.listItems",
  "check",
  "appliesTo",
  "validFrom",
  "validUntil",
  "probeFactors",
  "requiresInterviewBeforeRefusal",
  "concernsIntent",
] as const;
export type RubricDiffField = (typeof RUBRIC_DIFF_FIELDS)[number];

/** One field that differs between the two versions of a criterion. */
export interface CriterionFieldChange {
  field: RubricDiffField;
  // null stands for "absent" on that side (JSON has no undefined).
  before: unknown;
  after: unknown;
}

/** One criterion present in both versions, with what differs. */
export interface ChangedCriterion {
  // Id in the version under review.
  criterionId: string;
  // Id in the baseline. Differs from `criterionId` only for a `ruleRef` pair.
  previousCriterionId: string;
  // How the two were matched (see the file header).
  matchedBy: "criterionId" | "ruleRef";
  // The shared rule reference of a `ruleRef` pair, else the current one.
  ruleRef: string | null;
  changes: CriterionFieldChange[];
  // The baseline's criterion in full (the current one is in the version's
  // own `criteria` list, under `criterionId`).
  before: AssessmentCriterion;
}

/** How the intent polarity moved between the two versions. */
export interface IntentPolarityDiff {
  // PROMINENT FLAG: the extractor now proposes a different polarity than it
  // did for the baseline. A general-purpose model gets this backwards often,
  // so a flip must never be approved without being read.
  proposalChanged: boolean;
  previousProposal: IntentPolarity | null;
  currentProposal: IntentPolarity | null;
  // What the baseline is scored by today (the admin's decision on it).
  previousDecision: IntentPolarity | null;
  // The new proposal disagrees with the decision currently in force.
  proposalDiffersFromPreviousDecision: boolean;
}

/** The diff of a version against a baseline (or against nothing). */
export interface RubricDiff {
  // Version number of the baseline, or null when the route has no approved
  // version to compare with.
  baselineVersion: number | null;
  // True when there is no baseline: every criterion is new. Not an error.
  allNew: boolean;
  added: AssessmentCriterion[];
  removed: AssessmentCriterion[];
  changed: ChangedCriterion[];
  // Criteria identical in both versions (count only).
  unchangedCount: number;
  intentPolarity: IntentPolarityDiff;
  // The two ADMIN-SET fields (#116): never extracted, so a change here is
  // always a human's. `before` is the baseline's value, `after` this version's
  // stored value (absent until an approval sets it), null for absent.
  adminSet: {
    outcomeStatistics: AdminSetChange<NonNullable<VisaRubric["outcomeStatistics"]>>;
    evidenceHelpsCriterionIds: AdminSetChange<string[]>;
    // (#161) the criteria the reviewer excluded; the baseline's own list is
    // `before`. Order of ids is not significant to a reader but is to the
    // comparison, and the lists are written in the order the admin sent.
    excludedCriterionIds: AdminSetChange<string[]>;
  };
}

/** One admin-set field compared across two versions. */
export interface AdminSetChange<T> {
  before: T | null;
  after: T | null;
  // True when the two differ (key order and absence vs null do not count).
  changed: boolean;
}

/** Read a diff field from a criterion; absent values become null. */
function fieldValue(c: AssessmentCriterion, field: RubricDiffField): unknown {
  const value = field.startsWith("source.")
    ? (c.source as unknown as Record<string, unknown> | undefined)?.[field.slice("source.".length)]
    : (c as unknown as Record<string, unknown>)[field];
  return value === undefined ? null : value;
}

/**
 * JSON text of a value with object keys sorted, so two objects holding the
 * same data compare equal whatever order Firestore returned their keys in.
 */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

/** The fields that differ between two versions of one criterion. */
export function diffCriterionFields(before: AssessmentCriterion, after: AssessmentCriterion): CriterionFieldChange[] {
  const changes: CriterionFieldChange[] = [];
  for (const field of RUBRIC_DIFF_FIELDS) {
    const b = fieldValue(before, field);
    const a = fieldValue(after, field);
    if (stableJson(b) !== stableJson(a)) changes.push({ field, before: b, after: a });
  }
  return changes;
}

/** A filled rule reference, or null. */
const refOf = (c: AssessmentCriterion): string | null => (typeof c.ruleRef === "string" && c.ruleRef.trim() ? c.ruleRef.trim() : null);

/**
 * Pair removed and added criteria that carry the same rule reference.
 * Returns the pairs; the criteria it paired are removed from the two input
 * lists (which keep their order).
 */
function pairByRuleRef(removed: AssessmentCriterion[], added: AssessmentCriterion[]): { before: AssessmentCriterion; after: AssessmentCriterion }[] {
  const pairs: { before: AssessmentCriterion; after: AssessmentCriterion }[] = [];
  const refs = [...new Set(removed.map(refOf).filter((r): r is string => r !== null))];
  for (const ref of refs) {
    let olds = removed.filter((c) => refOf(c) === ref);
    let news = added.filter((c) => refOf(c) === ref);
    if (news.length === 0) continue;
    const take = (before: AssessmentCriterion, after: AssessmentCriterion) => {
      pairs.push({ before, after });
      olds = olds.filter((c) => c !== before);
      news = news.filter((c) => c !== after);
    };
    // Pass 1: within the reference, the same kind reading the same field is
    // the same rule, as long as only one candidate fits on each side.
    for (const before of [...olds]) {
      const sameShape = (c: AssessmentCriterion) => c.kind === before.kind && (c.check?.field ?? "") === (before.check?.field ?? "");
      const candidates = news.filter(sameShape);
      if (candidates.length === 1 && olds.filter(sameShape).length === 1) take(before, candidates[0]);
    }
    // Pass 2: exactly one left on each side: nothing else it could be.
    if (olds.length === 1 && news.length === 1) take(olds[0], news[0]);
    // Anything still unpaired is ambiguous: left as removed / added.
  }
  for (const { before, after } of pairs) {
    removed.splice(removed.indexOf(before), 1);
    added.splice(added.indexOf(after), 1);
  }
  return pairs;
}

/** The parts of a rubric version the diff reads. */
export type DiffableRubric = Pick<VisaRubric, "version" | "criteria" | "intentPolarity" | "intentPolarityProposal"> &
  Partial<Pick<VisaRubric, "outcomeStatistics" | "evidenceHelpsCriterionIds" | "excludedCriterionIds">>;

/** Compare one admin-set field of two versions (stable JSON, so key order is ignored). */
function adminSetChange<T>(before: T | undefined, after: T | undefined): AdminSetChange<T> {
  return { before: before ?? null, after: after ?? null, changed: stableJson(before ?? null) !== stableJson(after ?? null) };
}

/** A copy of an id list in a stable order (undefined stays undefined), so only a real change in the SET reads as changed. */
const sortedIds = (ids: string[] | undefined): string[] | undefined => (ids ? [...ids].sort() : undefined);

/** Both admin-set fields. A missing baseline compares against nothing. */
function adminSetDiff(current: DiffableRubric, baseline: DiffableRubric | null): RubricDiff["adminSet"] {
  return {
    outcomeStatistics: adminSetChange(baseline?.outcomeStatistics, current.outcomeStatistics),
    evidenceHelpsCriterionIds: adminSetChange(baseline?.evidenceHelpsCriterionIds, current.evidenceHelpsCriterionIds),
    excludedCriterionIds: adminSetChange(sortedIds(baseline?.excludedCriterionIds), sortedIds(current.excludedCriterionIds)),
  };
}

/**
 * Diff `current` against `baseline`.
 *
 * @param current  the version under review
 * @param baseline the approved version to compare with, or null when the
 *   route has none: everything is then reported as added (`allNew`).
 */
export function diffRubricVersions(current: DiffableRubric, baseline: DiffableRubric | null): RubricDiff {
  const currentProposal = current.intentPolarityProposal?.value ?? null;
  if (!baseline) {
    return {
      baselineVersion: null,
      allNew: true,
      added: [...current.criteria],
      removed: [],
      changed: [],
      unchangedCount: 0,
      intentPolarity: {
        proposalChanged: false,
        previousProposal: null,
        currentProposal,
        previousDecision: null,
        proposalDiffersFromPreviousDecision: false,
      },
      adminSet: adminSetDiff(current, null),
    };
  }

  const baseById = new Map(baseline.criteria.map((c) => [c.criterionId, c]));
  const currentIds = new Set(current.criteria.map((c) => c.criterionId));

  const changed: ChangedCriterion[] = [];
  const added: AssessmentCriterion[] = [];
  let unchangedCount = 0;

  // ---- 1. match by id (current order is kept) ----
  for (const c of current.criteria) {
    const before = baseById.get(c.criterionId);
    if (!before) {
      added.push(c);
      continue;
    }
    const changes = diffCriterionFields(before, c);
    if (changes.length === 0) unchangedCount++;
    else changed.push({ criterionId: c.criterionId, previousCriterionId: before.criterionId, matchedBy: "criterionId", ruleRef: refOf(c), changes, before });
  }
  const removed = baseline.criteria.filter((c) => !currentIds.has(c.criterionId));

  // ---- 2. pair what is left by rule reference ----
  for (const { before, after } of pairByRuleRef(removed, added)) {
    changed.push({
      criterionId: after.criterionId,
      previousCriterionId: before.criterionId,
      matchedBy: "ruleRef",
      ruleRef: refOf(after),
      // Always non-empty: a different id means a different quote, kind or field.
      changes: diffCriterionFields(before, after),
      before,
    });
  }

  const previousProposal = baseline.intentPolarityProposal?.value ?? null;
  const previousDecision = baseline.intentPolarity ?? null;
  return {
    baselineVersion: baseline.version,
    allNew: false,
    added,
    removed,
    changed,
    unchangedCount,
    intentPolarity: {
      proposalChanged: previousProposal !== currentProposal,
      previousProposal,
      currentProposal,
      previousDecision,
      proposalDiffersFromPreviousDecision: previousDecision !== null && currentProposal !== previousDecision,
    },
    adminSet: adminSetDiff(current, baseline),
  };
}
