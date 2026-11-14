import type { AssessmentCriterion, CompetenceBlock, EvidenceItem, IntakeQuestion, IntentPolarity, RulebookStackLayer, VisaRubric } from "../../types/rubric";
import type { RouteLayer } from "../../types/shared-route";
import { keyFieldsOf, rulebookTargetOfKey } from "./rubric-key";
import { planStack, type StackPlanProblem } from "./rubric-question-plan";
// (P4b) The same code guards the layer check applied, re-checked at merge time against the twin as served now.
import { linkRefusal } from "./rubric-layer-check";
import { rubricStore } from "./rubric.store";

// ============================================
// RULEBOOK STACKS — THE MERGED READ MODEL (issue #233, P4a of #228)
// ============================================
//
// An application on a visa that inherits a shared route (types/shared-route.ts)
// is assessed against a STACK of rulebooks: the shared layer(s) of the bloc or
// treaty first, the country's own layer last (shared-routes/route-stack.ts
// builds the order). BOTH ALWAYS APPLY. Each layer is drafted, checked and
// published on its own; this module only READS: it loads the approved version
// of every layer and merges them into ONE rubric-shaped view, so every
// consumer (intake, assessment, bulk re-assessment, checklist, document check,
// chat) keeps its existing logic and simply reads the stack.
//
//   loadRulebookStack(routeStack)  -> RulebookStack   (I/O: one approved read per layer)
//   mergeRulebookStack(reads)      -> VisaRubric      (pure)
//
// THE GUARANTEES
//
//  1. A SINGLE-LAYER STACK IS THE RULEBOOK ITSELF. A route with no inheritance
//     (every route today) has one layer, and the merged view is exactly the
//     approved rubric the store returns: same object, same ids, no extra field.
//     Nothing about those routes changes.
//  2. EACH LAYER KEEPS ITS SAFEGUARDS. Every layer is read through
//     `rubricStore.getApprovedRubricByKey`: approved only, its own status
//     re-checked, its own exclusions, plan, repairs and dropped triggers
//     applied (`applyExclusions`). The merge never re-filters and never drops
//     a rule, a question or a document item (owner's rule: nothing is cut for
//     size). Every rule keeps its own verbatim quote and URL.
//  3. A MISSING LAYER IS REPORTED, NEVER IGNORED. A layer with no approved
//     version is `missing` in `layers` (and in the merged view's
//     `stackLayers`). The stack is USABLE when at least one layer is approved;
//     consumers store the layer list so the application shows which is missing.
//  4. IDS NEVER COLLIDE. Each layer's ids are generated for that layer alone,
//     so two layers could both have a question `q1`. In a stack of more than
//     one layer every id of a SHARED layer (rule, question, document item, and
//     every reference to them) is scoped as `{rulebookKey}::{id}`; the
//     country's OWN layer keeps its ids exactly. The scoping depends only on
//     the layer's key and role, never on what else is in the stack, so a saved
//     intake answer keeps its key when another layer publishes or goes missing.
//  5. A TRIGGER ONLY READS ITS OWN LAYER. Scoping makes that true by
//     construction; a layer whose data names another layer's question is
//     refused by the stack plan (rubric-question-plan.ts `planStack`), and an
//     unusable stack is reported with the problems.
//
// P4b (this file's part): THE LAYER CHECK'S RESULTS ARE HONOURED HERE
//  - `restates` (rubric-layer-check.ts): a national rule the layer check linked
//    to a shared twin is FOLDED into it in the merged view: the national rule
//    leaves `criteria` and is listed on its twin's `restatedBy` with its own
//    verbatim quote and URL; references to it (questions, document items,
//    evidence helps) point at the twin; a question that only the folded rule
//    asked, and that nothing else reads, is not asked again. So the applicant
//    is asked and assessed ONCE, under the shared rule. The stored national
//    version is never changed. A link is honoured only while the twin is still
//    served with exactly the quote that was compared AND the code guards still
//    hold against the twin as served now (`linkRefusal`); otherwise the two
//    rules simply both appear (duplicated: harmless but visible). No link (the
//    check did not run, or found no repeat) = both appear, as before.
//  - `layerConflicts`: both rules of a disagreeing pair stay in the merged view
//    and are both assessed, so a failure of EITHER fails the application (the
//    stricter result decides). Each is tagged `layerConflictWith` (the other's
//    served id) so a reader can show both together. Nothing decides on it.
//  - Fan-out when a shared layer publishes (bulk re-assessment queue and
//    rule-change alerts) is in services/ai-bulk-reassessment.service.ts and
//    services/rule-change-alerts.service.ts.
//
// Nothing here names a country, bloc, treaty or nationality: ids are data.

// ============================================
// Shapes
// ============================================

/** What one layer read returned: the layer and its approved (served) rubric, or null when it has none. */
export interface StackLayerRead {
  layer: RouteLayer;
  rubric: VisaRubric | null;
}

/** Why a stack cannot be used. */
export type StackUnusableReason = "no_layer_approved" | "plan_rejected" | "empty_stack";

/** The merged read of a route's stack. */
export interface RulebookStack {
  // Every layer in stack order (shared first, own last), approved or missing.
  layers: RulebookStackLayer[];
  // The layers with no approved version (also in `layers`), in stack order.
  missing: RulebookStackLayer[];
  // True when at least one layer is approved and the stack plan accepts it.
  usable: boolean;
  // Null when usable; else why not.
  unusableReason: StackUnusableReason | null;
  // The merged view consumers read; null when the stack is not usable.
  rubric: VisaRubric | null;
  // The stack plan's refusals (empty unless `unusableReason` is `plan_rejected`).
  problems: StackPlanProblem[];
}

// ============================================
// Ids: scoping a shared layer
// ============================================

/** Separator between a layer key and a scoped id. `::` occurs in no rulebook key and no extracted id. */
export const STACK_ID_SEPARATOR = "::";

/** A shared layer's id as it appears in the merged view. */
export function scopedId(rulebookKey: string, id: string): string {
  return `${rulebookKey}${STACK_ID_SEPARATOR}${id}`;
}

/**
 * Rewrite every id (and every reference to one) of a SHARED layer's rubric to
 * its scoped form, and tag every item with its layer. The OWN layer is only
 * tagged (its ids are kept). Pure; the input is never mutated.
 */
function layerView(read: StackLayerRead & { rubric: VisaRubric }): VisaRubric {
  const key = read.layer.rulebookKey;
  const scope = read.layer.role === "shared" ? (id: string) => scopedId(key, id) : (id: string) => id;
  const r = read.rubric;

  const criteria: AssessmentCriterion[] = (r.criteria ?? []).map((c) => ({
    ...c,
    criterionId: scope(c.criterionId),
    ...(c.trigger ? { trigger: { ...c.trigger, questionId: scope(c.trigger.questionId) } } : {}),
    ...(c.intakeQuestionIds ? { intakeQuestionIds: c.intakeQuestionIds.map(scope) } : {}),
    // `eligibilityQuestionId` names a GLOBAL eligibility question (not a layer's): kept as it is.
    layerKey: key,
  }));
  const intakeQuestions: IntakeQuestion[] = (Array.isArray(r.intakeQuestions) ? r.intakeQuestions : []).map((q) => ({
    ...q,
    id: scope(q.id),
    criterionIds: (q.criterionIds ?? []).map(scope),
    ...(q.showWhen ? { showWhen: { ...q.showWhen, anyOf: (q.showWhen.anyOf ?? []).map((cond) => ({ ...cond, questionId: scope(cond.questionId) })) } } : {}),
    layerKey: key,
  }));
  const evidenceItems: EvidenceItem[] = (Array.isArray(r.evidenceItems) ? r.evidenceItems : []).map((e) => ({
    ...e,
    key: scope(e.key),
    criterionIds: (e.criterionIds ?? []).map(scope),
    ...(e.when ? { when: { ...e.when, questionId: scope(e.when.questionId) } } : {}),
    layerKey: key,
  }));
  // (#235) A shared layer's competence steps point at its own rule and
  // questions: scope those references the same way, and tag each step.
  const competence: CompetenceBlock | undefined = r.competence
    ? {
      steps: r.competence.steps.map((st) => ({
        ...st,
        criterionId: scope(st.criterionId),
        questionId: scope(st.questionId),
        ...(st.when ? { when: st.when.map((cond) => ({ ...cond, questionId: scope(cond.questionId) })) } : {}),
        layerKey: key,
      })),
    }
    : undefined;
  return {
    ...r,
    criteria,
    intakeQuestions,
    evidenceItems,
    ...(r.evidenceHelpsCriterionIds ? { evidenceHelpsCriterionIds: r.evidenceHelpsCriterionIds.map(scope) } : {}),
    ...(competence ? { competence } : {}),
  };
}

/**
 * (#235) A SHARED layer's served rubric as it appears inside a stack: every id
 * scoped `{rulebookKey}::{id}` and every item tagged with its layer, exactly
 * as `mergeRulebookStack` shows it. Used before an application exists (the
 * "apply through" step reads the shared layer alone), so the question ids the
 * applicant answers are the very ids the application's intake stores. Pure.
 */
export function sharedLayerView(rulebookKey: string, authorityId: string, rubric: VisaRubric): VisaRubric {
  return layerView({ layer: { rulebookKey, authorityId, role: "shared" }, rubric });
}

/**
 * (#235) The competence block of a merged stack: the block of the ONE approved
 * SHARED layer that has one (already scoped by `layerView`). A country's own
 * layer never decides which member to apply through, and when two shared
 * layers both carry a block the stack cannot say which one applies, so it
 * serves none (the applicant then picks: never a guess). Pure.
 */
export function stackCompetence(reads: readonly StackLayerRead[], views: readonly VisaRubric[]): CompetenceBlock | undefined {
  const approved = reads.filter((r) => r.rubric !== null);
  const blocks = views.filter((v, i) => approved[i]?.layer.role === "shared" && v.competence !== undefined).map((v) => v.competence as CompetenceBlock);
  return blocks.length === 1 ? blocks[0] : undefined;
}

// ============================================
// The merge (pure)
// ============================================

/** A layer's status line, in the shape stored on applications and assessments. */
function layerState(read: StackLayerRead): RulebookStackLayer {
  return {
    rulebookKey: read.layer.rulebookKey,
    authorityId: read.layer.authorityId,
    role: read.layer.role,
    status: read.rubric ? "approved" : "missing",
    version: read.rubric ? read.rubric.version : null,
  };
}

/**
 * The stricter intent polarity of the approved layers: if ANY layer penalises
 * immigrant intent, the merged view does (the assessment only ever raises a
 * concern on an intention rule under that polarity, so this is the stricter
 * reading, D3 "the stricter result decides"). Otherwise the own layer's
 * polarity, else the first approved layer's.
 */
function stricterPolarity(views: readonly VisaRubric[], own: VisaRubric | null): IntentPolarity | null {
  if (views.some((v) => v.intentPolarity === "immigrant_intent_penalised")) return "immigrant_intent_penalised";
  return own?.intentPolarity ?? views[0]?.intentPolarity ?? null;
}

/** Union of lists, in first-seen order. */
function unionOf<T>(lists: readonly (readonly T[] | undefined)[]): T[] {
  const out: T[] = [];
  for (const l of lists) for (const x of l ?? []) if (!out.includes(x)) out.push(x);
  return out;
}

// ============================================
// The layer check's links and conflicts (P4b, pure)
// ============================================

/** The merged lists the layer check's results are applied to. */
interface MergedLists {
  criteria: AssessmentCriterion[];
  intakeQuestions: IntakeQuestion[];
  evidenceItems: EvidenceItem[];
  evidenceHelpsCriterionIds: string[] | undefined;
}

/**
 * The `restates` links of the own layer that can be honoured on THIS stack:
 * the own rule is served, its twin is served by an approved shared layer of the
 * stack with exactly the quote that was compared, and the code guards still
 * hold against the twin as served now. Returns own id -> twin's served id.
 */
export function honouredLinks(own: VisaRubric | null, lists: Pick<MergedLists, "criteria">, ownKey: string): Map<string, string> {
  const out = new Map<string, string>();
  const links = own?.layerCheck?.status === "checked" ? own.layerCheck.restates ?? [] : [];
  if (links.length === 0) return out;
  const byId = new Map(lists.criteria.map((c) => [c.criterionId, c]));
  for (const link of links) {
    const ownRule = byId.get(link.criterionId);
    const twinId = scopedId(link.sharedRulebookKey, link.sharedCriterionId);
    const twin = byId.get(twinId);
    if (!ownRule || ownRule.layerKey !== ownKey || !twin || twin.layerKey !== link.sharedRulebookKey) continue;
    if ((twin.source?.quote ?? "") !== link.sharedQuote) continue; // the twin changed: never fold into a different rule
    if (linkRefusal(ownRule, twin) !== null) continue;
    out.set(link.criterionId, twinId);
  }
  return out;
}

/**
 * Fold the honoured links and tag the conflicts (see the file header). PURE.
 * Returns the lists unchanged (same arrays) when there is nothing to apply.
 */
function applyLayerResults(own: VisaRubric | null, lists: MergedLists, ownKey: string): MergedLists {
  const fold = honouredLinks(own, lists, ownKey);
  const conflicts = (own?.layerConflicts ?? []).filter((c) => !fold.has(c.criterionId));
  if (fold.size === 0 && conflicts.length === 0) return lists;
  const mapId = (id: string): string => fold.get(id) ?? id;
  const mapIds = (ids: readonly string[]): string[] => [...new Set(ids.map(mapId))];

  // ---- criteria: the folded rules leave; their twins list them; conflicts tagged ----
  const folded = new Map(lists.criteria.filter((c) => fold.has(c.criterionId)).map((c) => [c.criterionId, c]));
  const servedIds = new Set(lists.criteria.map((c) => c.criterionId));
  const conflictWith = new Map<string, string[]>();
  for (const c of conflicts) {
    const sharedId = scopedId(c.sharedRulebookKey, c.sharedCriterionId);
    if (!servedIds.has(c.criterionId) || !servedIds.has(sharedId)) continue;
    conflictWith.set(c.criterionId, [...(conflictWith.get(c.criterionId) ?? []), sharedId]);
    conflictWith.set(sharedId, [...(conflictWith.get(sharedId) ?? []), c.criterionId]);
  }
  const criteria: AssessmentCriterion[] = lists.criteria
    .filter((c) => !fold.has(c.criterionId))
    .map((c) => {
      const restated = [...folded.values()].filter((r) => fold.get(r.criterionId) === c.criterionId);
      const others = conflictWith.get(c.criterionId);
      if (restated.length === 0 && !others) return c;
      return {
        ...c,
        ...(restated.length > 0 ? { restatedBy: restated.map((r) => ({ rulebookKey: ownKey, criterionId: r.criterionId, title: r.title, quote: r.source?.quote ?? "", url: r.source?.url ?? "" })) } : {}),
        ...(others ? { layerConflictWith: [...new Set(others)] } : {}),
      };
    });
  if (fold.size === 0) return { ...lists, criteria };

  // ---- questions: point at the twin; a question only folded rules asked, and nothing else reads, goes ----
  const foldedIds = new Set(fold.keys());
  // What the rules that STAY, the questions and the document items read: such a question is still asked.
  const reads = new Set<string>();
  for (const c of criteria) {
    if (c.trigger) reads.add(c.trigger.questionId);
    for (const q of c.intakeQuestionIds ?? []) reads.add(q);
  }
  for (const q of lists.intakeQuestions) for (const cond of q.showWhen?.anyOf ?? []) reads.add(cond.questionId);
  for (const e of lists.evidenceItems) if (e.when) reads.add(e.when.questionId);
  const intakeQuestions = lists.intakeQuestions
    .filter((q) => {
      const linked = q.criterionIds ?? [];
      const onlyFolded = linked.length > 0 && linked.every((id) => foldedIds.has(id));
      return !(onlyFolded && !reads.has(q.id));
    })
    .map((q) => (q.criterionIds ?? []).some((id) => foldedIds.has(id)) ? { ...q, criterionIds: mapIds(q.criterionIds) } : q);
  // ---- document items: kept (a national document item is never dropped), pointed at the twin ----
  const evidenceItems = lists.evidenceItems.map((e) => ((e.criterionIds ?? []).some((id) => foldedIds.has(id)) ? { ...e, criterionIds: mapIds(e.criterionIds) } : e));
  const evidenceHelpsCriterionIds = lists.evidenceHelpsCriterionIds ? mapIds(lists.evidenceHelpsCriterionIds) : undefined;
  return { criteria, intakeQuestions, evidenceItems, evidenceHelpsCriterionIds };
}

/**
 * Merge the reads of a stack into one served rubric. `reads` are in stack
 * order (shared first, own last) and must include EVERY layer, approved or not
 * (the layer list is part of the result). Returns null when no layer is
 * approved.
 *
 * One layer in the stack: the approved rubric itself is returned UNCHANGED
 * (guarantee 1). More than one: the union, as described in the file header,
 * keyed as the country's own layer (the application's route), with
 * `stackLayers` listing every layer.
 */
export function mergeRulebookStack(reads: readonly StackLayerRead[]): VisaRubric | null {
  const approved = reads.filter((r): r is StackLayerRead & { rubric: VisaRubric } => r.rubric !== null);
  if (approved.length === 0) return null;
  // Guarantee 1: a single-layer stack is the rulebook itself.
  if (reads.length === 1) return approved[0].rubric;

  const ownRead = reads[reads.length - 1];
  const ownRubric = ownRead.layer.role === "own" ? ownRead.rubric : null;
  const views = approved.map(layerView);
  const ownView = ownRubric ? views[views.length - 1] : null;
  // Metadata the merged view needs a value for (schema, model, timestamps)
  // comes from the own layer when it is approved, else the first approved one.
  const base = ownView ?? views[0];
  // The merged view is keyed as the APPLICATION's route: the own layer's key
  // (a country's `{countryCode}_{visaTypeId}`), so consumers that need a
  // country (country statistics, routing) always have one.
  const ownKey = keyFieldsOf(rulebookTargetOfKey(ownRead.layer.rulebookKey));

  // The merged view is BUILT field by field (never a copy of one layer), so a
  // per-version drafting or review artefact of one layer can never pose as the
  // stack's: each layer's question plan, rule repairs, exclusions and dropped
  // triggers were already applied by its own approved read, and its unofficial
  // quote translations stay with the layer (the admin review shows them per
  // version; no consumer reads them, and they are never evidence).
  const evidenceHelpsRaw = views.some((v) => v.evidenceHelpsCriterionIds !== undefined) ? views.flatMap((v) => v.evidenceHelpsCriterionIds ?? []) : undefined;
  const languages = unionOf(views.map((v) => v.sourceLanguages));
  const intake = ownView?.intake ?? views[0].intake;
  // (P4b) EVERY rule, question and document item of every approved layer, in
  // stack order; then the own layer's layer-check results: `restates` links
  // folded (a repeat asked and assessed once, its quote kept on `restatedBy`)
  // and conflicts tagged. No link = everything appears, as before.
  const lists = applyLayerResults(
    ownRubric,
    {
      criteria: views.flatMap((v) => v.criteria),
      intakeQuestions: views.flatMap((v) => v.intakeQuestions),
      evidenceItems: views.flatMap((v) => v.evidenceItems),
      evidenceHelpsCriterionIds: evidenceHelpsRaw,
    },
    ownRead.layer.rulebookKey
  );
  const evidenceHelps = lists.evidenceHelpsCriterionIds;
  const competence = stackCompetence(reads, views);

  return {
    schemaVersion: base.schemaVersion,
    ...ownKey,
    // The own layer's version (0 when it has none approved). The full set of
    // versions is in `stackLayers`; consumers compare those (layerVersionsOf).
    version: ownRubric ? ownRubric.version : 0,
    reviewStatus: "approved",
    intentPolarity: stricterPolarity(views, ownView),
    reviewedBy: base.reviewedBy,
    reviewedAt: base.reviewedAt,
    rejectReason: null,
    revision: base.revision,
    supersededAt: null,
    // A proposal is a per-version drafting note, not something served.
    intentPolarityProposal: null,
    severityLevels: unionOf(views.map((v) => v.severityLevels)),
    // EVERY rule, question and document item of every approved layer, in
    // stack order. Nothing is dropped; a linked repeat is folded (see above).
    criteria: lists.criteria,
    ...(intake ? { intake } : {}),
    intakeQuestions: lists.intakeQuestions,
    evidenceItems: lists.evidenceItems,
    // (#235) Which member to apply through: the one shared layer's block, if any.
    ...(competence ? { competence } : {}),
    // Outcome statistics are per destination country: only the own layer's.
    ...(ownView?.outcomeStatistics ? { outcomeStatistics: ownView.outcomeStatistics } : {}),
    ...(evidenceHelps ? { evidenceHelpsCriterionIds: evidenceHelps } : {}),
    sourceSnapshots: views.flatMap((v) => v.sourceSnapshots ?? []),
    ...(languages.length > 0 ? { sourceLanguages: languages } : {}),
    // Provenance of the view: the layers' own hashes and runs, joined in stack order.
    sourceSetHash: views.map((v) => v.sourceSetHash).join("+"),
    extractorModel: base.extractorModel,
    extractorPromptVersion: base.extractorPromptVersion,
    extractionRunId: views.map((v) => v.extractionRunId).join("+"),
    discardedCount: views.reduce((n, v) => n + (v.discardedCount ?? 0), 0),
    discarded: views.flatMap((v) => v.discarded ?? []),
    suspiciousPassages: views.flatMap((v) => v.suspiciousPassages ?? []),
    flags: views.flatMap((v) => v.flags ?? []),
    createdAt: base.createdAt,
    stackLayers: reads.map(layerState),
  };
}

// ============================================
// The loader
// ============================================

/** Reads ONE layer's approved rubric. Injected so tests can use fixtures. */
export type StackLayerReader = (layer: RouteLayer) => Promise<VisaRubric | null>;

/** The default reader: the store's approved read by key (all of its guarantees). */
const defaultReader: StackLayerReader = (layer) => rubricStore.getApprovedRubricByKey(layer.rulebookKey);

/**
 * Build the stack result from reads already made (pure). Shared by the loader
 * and by consumers that read their one layer through an older reader.
 */
export function stackFromReads(reads: readonly StackLayerRead[]): RulebookStack {
  const layers = reads.map(layerState);
  const missing = layers.filter((l) => l.status === "missing");
  const unusable = (unusableReason: StackUnusableReason, problems: StackPlanProblem[] = []): RulebookStack => ({ layers, missing, usable: false, unusableReason, rubric: null, problems });
  if (reads.length === 0) return unusable("empty_stack");
  const rubric = mergeRulebookStack(reads);
  if (!rubric) return unusable("no_layer_approved");
  // A stack of more than one layer must pass the stack plan (guarantee 5).
  // A single layer was planned when it was published; nothing new to check.
  if (reads.length > 1) {
    const planLayers = reads.filter((r) => r.rubric !== null).map((r) => ({ rulebookKey: r.layer.rulebookKey, role: r.layer.role, view: r.rubric as VisaRubric }));
    const plan = planStack(planLayers, rubric);
    if (!plan.ok) return unusable("plan_rejected", plan.problems);
  }
  return { layers, missing, usable: true, unusableReason: null, rubric, problems: [] };
}

/**
 * Load a route's rulebook stack: the APPROVED version of every layer, in stack
 * order, merged into one served view (see the file header for the rules).
 *
 * @param routeStack the layers, from `resolveRouteStack` / `resolveApplicationStack`
 *                   (shared-routes): shared first, own last.
 * @param read       one layer's approved read (default: the store).
 * A read that throws (a database error) is not swallowed: the caller fails
 * the way it did before (no partial rulebook is ever served from an error).
 */
export async function loadRulebookStack(routeStack: readonly RouteLayer[], read: StackLayerReader = defaultReader): Promise<RulebookStack> {
  const rubrics = await Promise.all(routeStack.map((layer) => read(layer)));
  return stackFromReads(routeStack.map((layer, i) => ({ layer, rubric: rubrics[i] })));
}

/**
 * Rulebook key -> approved version of every layer, for a MERGED view of more
 * than one layer; undefined for a single-layer rulebook (its `version` says
 * it all, exactly as before). What assessments and intake saves record.
 */
export function layerVersionsOf(rubric: Pick<VisaRubric, "stackLayers">): Record<string, number | null> | undefined {
  if (!rubric.stackLayers || rubric.stackLayers.length <= 1) return undefined;
  const out: Record<string, number | null> = {};
  for (const l of rubric.stackLayers) out[l.rulebookKey] = l.version;
  return out;
}

/**
 * Do two records name the same rule set? Same `version`, and (for a stack)
 * the same version of every layer. A single-layer record compares exactly as
 * before (`version` alone).
 */
export function sameStackVersions(a: { version: number; layerVersions?: Record<string, number | null> }, b: { version: number; layerVersions?: Record<string, number | null> }): boolean {
  if (a.version !== b.version) return false;
  const ka = a.layerVersions ? Object.keys(a.layerVersions).sort() : [];
  const kb = b.layerVersions ? Object.keys(b.layerVersions).sort() : [];
  if (ka.length !== kb.length || ka.some((k, i) => k !== kb[i])) return false;
  return ka.every((k) => (a.layerVersions as Record<string, number | null>)[k] === (b.layerVersions as Record<string, number | null>)[k]);
}
