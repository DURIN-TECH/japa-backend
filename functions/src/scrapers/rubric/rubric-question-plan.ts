import { DECISION_STAGES, type AssessmentCriterion, type EvidenceItem, type IntakeCondition, type IntakeQuestion, type QuestionPlan, type VisaRubric } from "../../types/rubric";

// ============================================
// RUBRIC — QUESTION PLAN, PURE PART (issue #203, part of #200)
// ============================================
//
// The owner's decision (2026-11-13): rules stay in no matter the length, and
// nothing is cut because a rulebook is long. So this module never REMOVES a
// question. It does three things to the applicant question set:
//
//   1. MERGES exact duplicates: two questions with the same normalised
//      wording, answer type, options, party, required flag and limits become
//      one (the earlier survives). Every rule, `showWhen` and document-item
//      `when` that named a merged question is re-pointed. Decided in code.
//   2. PROPOSES a missing condition, only when it can be derived in code from
//      the rules' own validated trigger data (never invented): a question
//      that is asked of everyone although every rule it serves applies only
//      when some earlier answer holds gets that same condition.
//   3. ORDERS the survivors, deterministically: the questions that decide
//      what else is asked first, then by decision stage, then source order,
//      grouped under their own heading, and never before a question whose
//      answer its own condition reads (the intake service evaluates in order).
//
// It also SIZES the result: how many questions an applicant sees in the best,
// a typical and the worst case, computed by simulating answers against the
// conditions (the same evaluation the intake service uses).
//
// The removal of questions the wording check found wrong is NOT here: it goes
// through the existing dependency logic in rubric-exclusions.ts, so it follows
// `showWhen` / `when` exactly like an excluded rule does.
//
// Pure and dependency-free: no Firebase, no model, no clock, no randomness
// beyond a fixed-seed generator. It knows no country, route, nationality or
// publisher: everything is read as data. Same input, same output.

/** Version of this algorithm. Recorded on every plan. */
export const QUESTION_PLAN_ALGORITHM_VERSION = "question-plan-2026-11-13.1";

/** The parts of a rubric these functions read and rewrite. */
export type PlanView = Pick<VisaRubric, "criteria" | "intakeQuestions" | "evidenceItems">;

// ============================================
// Small helpers
// ============================================

/** Wording as compared for duplicates: Unicode-folded, lower-case, punctuation and spacing ignored. */
export function normaliseWording(text: string): string {
  return String(text ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** Parents of a question: the questions its `showWhen` reads. */
function parentsOf(q: IntakeQuestion): string[] {
  return [...new Set((q.showWhen?.anyOf ?? []).map((c) => c.questionId))];
}

/** A stable key for a condition (op, question, value). */
const conditionKey = (c: IntakeCondition): string => JSON.stringify([c.questionId, c.op, c.value]);

/** The questions whose answers decide what else applies or is asked. */
export function decidingQuestionIds(view: PlanView): Set<string> {
  const ids = new Set<string>();
  for (const q of view.intakeQuestions ?? []) for (const p of parentsOf(q)) ids.add(p);
  for (const e of view.evidenceItems ?? []) if (e.when) ids.add(e.when.questionId);
  for (const c of view.criteria ?? []) {
    const t = ruleTriggerOf(c);
    if (t) ids.add(t.questionId);
  }
  return ids;
}

// ============================================
// A rule's own trigger data (read defensively)
// ============================================

/** "This rule applies when the answer to question `questionId` is one of `anyOf`." */
export interface ReadTrigger {
  questionId: string;
  anyOf: string[];
}

/**
 * The structured trigger of a rule, when it has one. Read defensively and
 * loosely typed on purpose: the field is added by the change that keeps
 * specialist-activity rules (#207), and a rubric stored before it has none.
 * Anything not exactly `{ questionId: string, anyOf: non-empty string[] }` is
 * "no trigger": a condition is never guessed from a free-text description.
 */
export function ruleTriggerOf(c: AssessmentCriterion): ReadTrigger | null {
  const t = (c as unknown as { trigger?: unknown }).trigger;
  if (!t || typeof t !== "object") return null;
  const { questionId, anyOf } = t as { questionId?: unknown; anyOf?: unknown };
  if (typeof questionId !== "string" || !questionId) return null;
  if (!Array.isArray(anyOf) || anyOf.length === 0 || !anyOf.every((v) => typeof v === "string")) return null;
  return { questionId, anyOf: anyOf as string[] };
}

// ============================================
// 1. Exact duplicates
// ============================================

/** What makes two questions exactly the same question. Anything that changes what is asked or how it is answered is in the key. */
export function duplicateKey(q: IntakeQuestion): string {
  const options = (q.options ?? []).map((o) => [String(o.value), normaliseWording(o.label)]).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return JSON.stringify([
    normaliseWording(q.label),
    q.answerType,
    options,
    q.party ?? "",
    q.required === true,
    q.dateLimits ?? null,
    q.textLimits ?? null,
    q.maxLengthDays ?? null,
    [...(q.currencies ?? [])].sort(),
  ]);
}

/** Ancestors of a question through `showWhen` (transitive, the question itself excluded). */
function ancestorsOf(id: string, byId: ReadonlyMap<string, IntakeQuestion>): Set<string> {
  const out = new Set<string>();
  const stack = [id];
  while (stack.length > 0) {
    const q = byId.get(stack.pop() as string);
    if (!q) continue;
    for (const p of parentsOf(q)) {
      if (!out.has(p)) {
        out.add(p);
        stack.push(p);
      }
    }
  }
  return out;
}

/** True when the "depends on" graph of these questions has a cycle. */
function hasCycle(questions: readonly IntakeQuestion[]): boolean {
  const byId = new Map(questions.map((q) => [q.id, q]));
  const state = new Map<string, 1 | 2>(); // 1 = on the stack, 2 = done
  const visit = (id: string): boolean => {
    const s = state.get(id);
    if (s === 2) return false;
    if (s === 1) return true;
    state.set(id, 1);
    const q = byId.get(id);
    if (q) for (const p of parentsOf(q)) if (byId.has(p) && visit(p)) return true;
    state.set(id, 2);
    return false;
  };
  return questions.some((q) => visit(q.id));
}

/**
 * The merges that fold exact duplicates into the earliest of each group.
 * A star (`to` is never a `from`). A merge is skipped when the two questions
 * depend on each other (one is an ancestor of the other, so folding them would
 * make a question wait on itself) and when it would make the dependency graph
 * cyclic. Deterministic: groups are visited in source order.
 */
export function findExactDuplicateMerges(view: PlanView): { from: string; to: string }[] {
  const questions = view.intakeQuestions ?? [];
  const byId = new Map(questions.map((q) => [q.id, q]));
  const groups = new Map<string, IntakeQuestion[]>();
  for (const q of questions) {
    const key = duplicateKey(q);
    const list = groups.get(key);
    if (list) list.push(q);
    else groups.set(key, [q]);
  }
  const merges: { from: string; to: string }[] = [];
  // Candidate merges in source order of the `from` question.
  const candidates: { from: string; to: string }[] = [];
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    const keep = list[0];
    const keepAncestors = ancestorsOf(keep.id, byId);
    for (const dup of list.slice(1)) {
      if (keepAncestors.has(dup.id) || ancestorsOf(dup.id, byId).has(keep.id)) continue;
      candidates.push({ from: dup.id, to: keep.id });
    }
  }
  const index = new Map(questions.map((q, i) => [q.id, i]));
  candidates.sort((a, b) => (index.get(a.from) ?? 0) - (index.get(b.from) ?? 0));
  // Accept each merge only when the merged graph stays acyclic.
  for (const cand of candidates) {
    const trial = applyMerges(view, [...merges, cand]);
    if (!hasCycle(trial.intakeQuestions)) merges.push(cand);
  }
  return merges;
}

/**
 * Fold the merged questions into their survivors and re-point every reference.
 * Pure; the input is not mutated. Merges naming a missing question, or a
 * question into itself, or whose `to` is itself merged away, are ignored.
 *
 *  - the survivor links the union of the criteria (kept in rubric order);
 *  - the survivor is shown when EITHER original would have been shown: if any
 *    of them had no condition it has none, otherwise the conditions are joined;
 *  - `showWhen` conditions, document-item `when` and the criteria's
 *    `intakeQuestionIds` that named a merged question name the survivor.
 */
export function applyMerges<T extends PlanView>(view: T, merges: readonly { from: string; to: string }[]): T {
  const questions = view.intakeQuestions ?? [];
  const present = new Set(questions.map((q) => q.id));
  const target = new Map<string, string>();
  for (const m of merges) if (m.from !== m.to && present.has(m.from) && present.has(m.to)) target.set(m.from, m.to);
  // A `to` that is itself merged away is not a survivor: ignore such a merge.
  for (const [from, to] of [...target]) if (target.has(to)) target.delete(from);
  if (target.size === 0) return view;

  const criterionOrder = new Map((view.criteria ?? []).map((c, i) => [c.criterionId, i]));
  const byId = new Map(questions.map((q) => [q.id, q]));
  const repoint = (id: string): string => target.get(id) ?? id;
  const repointConditions = (conds: IntakeCondition[]): IntakeCondition[] => {
    const seen = new Set<string>();
    const out: IntakeCondition[] = [];
    for (const c of conds) {
      const next = { ...c, questionId: repoint(c.questionId) };
      const k = conditionKey(next);
      if (!seen.has(k)) {
        seen.add(k);
        out.push(next);
      }
    }
    return out;
  };

  const merged: IntakeQuestion[] = [];
  for (const q of questions) {
    if (target.has(q.id)) continue;
    const absorbed = questions.filter((o) => target.get(o.id) === q.id);
    const next: IntakeQuestion = { ...q };
    const ids = new Set(q.criterionIds ?? []);
    for (const o of absorbed) for (const id of o.criterionIds ?? []) ids.add(id);
    next.criterionIds = [...ids].sort((a, b) => (criterionOrder.get(a) ?? 1e9) - (criterionOrder.get(b) ?? 1e9) || (a < b ? -1 : a > b ? 1 : 0));
    const family = [q, ...absorbed];
    if (family.some((m) => !m.showWhen || (m.showWhen.anyOf ?? []).length === 0)) delete next.showWhen;
    else next.showWhen = { ...q.showWhen, anyOf: repointConditions(family.flatMap((m) => m.showWhen?.anyOf ?? [])) };
    merged.push(next);
  }
  // Other questions' conditions name the survivor.
  const repointed = merged.map((q) => (q.showWhen && !q.showWhen.anyOf.every((c) => !target.has(c.questionId)) ? { ...q, showWhen: { ...q.showWhen, anyOf: repointConditions(q.showWhen.anyOf) } } : q));
  void byId;

  const evidence: EvidenceItem[] = (view.evidenceItems ?? []).map((e) => (e.when && target.has(e.when.questionId) ? { ...e, when: { ...e.when, questionId: repoint(e.when.questionId) } } : e));
  const criteria: AssessmentCriterion[] = (view.criteria ?? []).map((c) => {
    if (!c.intakeQuestionIds || !c.intakeQuestionIds.some((id) => target.has(id))) return c;
    return { ...c, intakeQuestionIds: [...new Set(c.intakeQuestionIds.map(repoint))] };
  });
  return { ...view, criteria, intakeQuestions: repointed, evidenceItems: evidence };
}

// ============================================
// 2. A condition derived from the rules' own trigger data
// ============================================

/** One derived condition. */
export interface DerivedCondition {
  questionId: string;
  showWhen: { anyOf: IntakeCondition[] };
  derivedFromCriterionIds: string[];
}

/**
 * Conditions for questions that have none although every rule they serve is
 * conditional with a validated trigger. A condition is derived ONLY when:
 *  - the question has no `showWhen`;
 *  - EVERY criterion that names the question (via its `criterionIds`) has a
 *    structured trigger (`ruleTriggerOf`) and is not an `all_applicants` rule;
 *  - each trigger names a different, existing, single-choice question and
 *    every value is one of that question's options (the intake service can
 *    only evaluate a membership test against a single value);
 *  - the condition would not make a question wait on itself (cycle).
 * Otherwise nothing is proposed: the question stays as it is. The condition
 * text is built from the trigger values, never from free text.
 */
export function deriveConditions(view: PlanView): DerivedCondition[] {
  const questions = view.intakeQuestions ?? [];
  const byId = new Map(questions.map((q) => [q.id, q]));
  const criteria = new Map((view.criteria ?? []).map((c) => [c.criterionId, c]));
  const out: DerivedCondition[] = [];
  let working = questions;
  for (const q of questions) {
    if (q.showWhen && (q.showWhen.anyOf ?? []).length > 0) continue;
    const linked = (q.criterionIds ?? []).map((id) => criteria.get(id));
    if (linked.length === 0 || linked.some((c) => !c || c.applicability === "all_applicants" || c.applicability === undefined)) continue;
    const triggers = linked.map((c) => (c ? ruleTriggerOf(c) : null));
    if (triggers.some((t) => t === null)) continue;
    const conds: IntakeCondition[] = [];
    let ok = true;
    for (const t of triggers as ReadTrigger[]) {
      const parent = byId.get(t.questionId);
      if (!parent || parent.id === q.id || parent.answerType !== "single_choice") {
        ok = false;
        break;
      }
      const options = new Set((parent.options ?? []).map((o) => o.value));
      if (!t.anyOf.every((v) => options.has(v))) {
        ok = false;
        break;
      }
      conds.push(t.anyOf.length === 1 ? { questionId: t.questionId, op: "eq", value: t.anyOf[0] } : { questionId: t.questionId, op: "in", value: [...t.anyOf] });
    }
    if (!ok) continue;
    const seen = new Set<string>();
    const anyOf = conds.filter((c) => {
      const k = conditionKey(c);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    // No cycle: the new parents must not (transitively) wait on this question.
    const trial = working.map((w) => (w.id === q.id ? { ...w, showWhen: { anyOf } } : w));
    if (hasCycle(trial)) continue;
    working = trial;
    out.push({ questionId: q.id, showWhen: { anyOf }, derivedFromCriterionIds: [...(q.criterionIds ?? [])] });
  }
  return out;
}

/** Add derived conditions to the questions that still have none. */
export function applyConditions<T extends PlanView>(view: T, conditions: readonly { questionId: string; showWhen: { anyOf: IntakeCondition[] } }[]): T {
  if (conditions.length === 0) return view;
  const by = new Map(conditions.map((c) => [c.questionId, c.showWhen]));
  const present = new Set((view.intakeQuestions ?? []).map((q) => q.id));
  return {
    ...view,
    intakeQuestions: (view.intakeQuestions ?? []).map((q) => {
      const w = by.get(q.id);
      // Only a question with no condition of its own; every parent must exist.
      if (!w || (q.showWhen && (q.showWhen.anyOf ?? []).length > 0) || !w.anyOf.every((c) => present.has(c.questionId) && c.questionId !== q.id)) return q;
      return { ...q, showWhen: { anyOf: w.anyOf.map((c) => ({ ...c })) } };
    }),
  };
}

// ============================================
// 3. Order and grouping
// ============================================

/** Decision-stage rank of a question: the earliest stage among its rules. */
function stageRank(q: IntakeQuestion, criteria: ReadonlyMap<string, AssessmentCriterion>): number {
  let best: number = DECISION_STAGES.length;
  for (const id of q.criterionIds ?? []) {
    const c = criteria.get(id);
    if (!c) continue;
    const r = (DECISION_STAGES as readonly string[]).indexOf(c.stage);
    if (r >= 0 && r < best) best = r;
  }
  return best;
}

/**
 * The served order of the questions, as ids.
 *   sort key: deciding questions first, then decision stage, then the position
 *   of the question's heading (`group`) in source order so one heading stays
 *   together, then source order;
 *   a question is never placed before a question its condition reads (the
 *   intake service shows a question only if EARLIER answers allow it), so a
 *   parent is emitted first.
 */
export function orderQuestions(view: PlanView): string[] {
  const questions = view.intakeQuestions ?? [];
  const criteria = new Map((view.criteria ?? []).map((c) => [c.criterionId, c]));
  const deciding = decidingQuestionIds(view);
  const firstOfGroup = new Map<string, number>();
  questions.forEach((q, i) => {
    if (q.group && !firstOfGroup.has(q.group)) firstOfGroup.set(q.group, i);
  });
  const keyed = questions.map((q, i) => ({
    q,
    i,
    k: [deciding.has(q.id) ? 0 : 1, stageRank(q, criteria), q.group ? (firstOfGroup.get(q.group) as number) : i, i] as const,
  }));
  keyed.sort((a, b) => a.k[0] - b.k[0] || a.k[1] - b.k[1] || a.k[2] - b.k[2] || a.k[3] - b.k[3]);
  const byId = new Map(questions.map((q) => [q.id, q]));
  const out: string[] = [];
  const done = new Set<string>();
  const visiting = new Set<string>();
  const emit = (q: IntakeQuestion): void => {
    if (done.has(q.id) || visiting.has(q.id)) return;
    visiting.add(q.id);
    // Parents first, in their own sorted order.
    const parents = parentsOf(q)
      .map((id) => byId.get(id))
      .filter((p): p is IntakeQuestion => p !== undefined)
      .sort((a, b) => keyed.findIndex((x) => x.q.id === a.id) - keyed.findIndex((x) => x.q.id === b.id));
    for (const p of parents) emit(p);
    visiting.delete(q.id);
    done.add(q.id);
    out.push(q.id);
  };
  for (const { q } of keyed) emit(q);
  return out;
}

/** The questions in the given order; ids the order does not name follow in source order. */
export function applyOrder<T extends PlanView>(view: T, order: readonly string[]): T {
  const questions = view.intakeQuestions ?? [];
  const rank = new Map(order.map((id, i) => [id, i]));
  const sorted = questions
    .map((q, i) => ({ q, i }))
    .sort((a, b) => (rank.get(a.q.id) ?? 1e9) - (rank.get(b.q.id) ?? 1e9) || a.i - b.i)
    .map((x) => x.q);
  return { ...view, intakeQuestions: sorted };
}

// ============================================
// 4. Sizing
// ============================================

/** Marker answers in the simulation. */
const UNANSWERED = Symbol("unanswered");
const OTHER = Symbol("other");
type Sim = string | number | boolean | typeof UNANSWERED | typeof OTHER;

/** The intake service's condition test (services/intake.service.ts), on simulated answers. */
function conditionHolds(c: IntakeCondition, actual: Sim | undefined): boolean {
  if (actual === undefined || actual === UNANSWERED) return false;
  switch (c.op) {
  case "eq":
    return actual === c.value;
  case "neq":
    return actual !== c.value;
  case "in":
    return Array.isArray(c.value) && typeof actual === "string" && c.value.includes(actual);
  default:
    return false;
  }
}

/** Deterministic generator (fixed seed): the "typical case" must reproduce. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Samples drawn for the typical case. */
export const SIZING_SAMPLES = 2000;
/** Search steps the exact best / worst search may take before it settles for sampled bounds. */
export const SIZING_SEARCH_BUDGET = 200_000;

/**
 * How many questions an applicant sees, given the conditions. A "case" is one
 * complete set of answers to the deciding questions; what is visible follows
 * from the conditions in served order (a hidden question's answer does not
 * count), exactly as the intake service evaluates it.
 *   best    the fewest an applicant can be shown
 *   worst   the most
 *   typical the MEDIAN over SIZING_SAMPLES cases drawn with a fixed seed, each
 *           deciding question answered uniformly from the answers its
 *           conditions and options distinguish
 * best / worst are exact unless the search budget ran out (`exact: false`),
 * in which case they are the extremes of the sampled cases.
 */
export function sizeQuestions(view: PlanView): QuestionPlan["sizing"] {
  const questions = view.intakeQuestions ?? [];
  const deciding = decidingQuestionIds({ ...view, criteria: [] });
  const conditionalIds = new Set(questions.filter((q) => (q.showWhen?.anyOf ?? []).length > 0).map((q) => q.id));
  const unconditional = questions.length - conditionalIds.size;
  const decidingAll = decidingQuestionIds(view);

  // Domain of each deciding question: the answers that change what is visible.
  const domain = new Map<string, Sim[]>();
  for (const q of questions) {
    if (!deciding.has(q.id)) continue;
    const mentioned = new Set<string | number | boolean>();
    for (const o of questions) for (const c of o.showWhen?.anyOf ?? []) if (c.questionId === q.id) for (const v of Array.isArray(c.value) ? c.value : [c.value]) mentioned.add(v);
    for (const e of view.evidenceItems ?? []) if (e.when?.questionId === q.id) for (const v of Array.isArray(e.when.value) ? e.when.value : [e.when.value]) mentioned.add(v);
    const values = new Set<string | number | boolean>(mentioned);
    if (q.answerType === "yes_no") {
      values.add(true);
      values.add(false);
    }
    if (q.answerType === "single_choice") for (const o of q.options ?? []) values.add(o.value);
    domain.set(q.id, [...values, OTHER]);
  }

  /** Visible count for answers drawn per deciding question (UNANSWERED allowed). */
  const countFor = (pick: (id: string, d: Sim[]) => Sim): number => {
    const effective = new Map<string, Sim>();
    let n = 0;
    for (const q of questions) {
      const any = q.showWhen?.anyOf ?? [];
      if (any.length > 0 && !any.some((c) => conditionHolds(c, effective.get(c.questionId)))) continue;
      n++;
      const d = domain.get(q.id);
      if (d) effective.set(q.id, pick(q.id, d));
    }
    return n;
  };

  // ---- typical: seeded sampling ----
  const rand = mulberry32(20261113);
  const counts: number[] = [];
  for (let s = 0; s < SIZING_SAMPLES; s++) counts.push(countFor((_id, d) => d[Math.floor(rand() * d.length)]));
  counts.sort((a, b) => a - b);
  const typical = counts.length > 0 ? counts[Math.floor(counts.length / 2)] : 0;

  // ---- best / worst: exhaustive over the visible deciding questions, with a budget ----
  let steps = 0;
  let exhausted = false;
  const search = (want: "min" | "max"): number => {
    let bestSeen = want === "min" ? Infinity : -Infinity;
    const walk = (i: number, effective: Map<string, Sim>, n: number): void => {
      if (exhausted) return;
      for (; i < questions.length; i++) {
        const q = questions[i];
        const any = q.showWhen?.anyOf ?? [];
        if (any.length > 0 && !any.some((c) => conditionHolds(c, effective.get(c.questionId)))) continue;
        n++;
        const d = domain.get(q.id);
        if (d) {
          const choices: Sim[] = [...d, UNANSWERED];
          for (const v of choices) {
            if (++steps > SIZING_SEARCH_BUDGET) {
              exhausted = true;
              return;
            }
            const next = new Map(effective);
            next.set(q.id, v);
            walk(i + 1, next, n);
            if (exhausted) return;
          }
          return;
        }
      }
      bestSeen = want === "min" ? Math.min(bestSeen, n) : Math.max(bestSeen, n);
    };
    walk(0, new Map(), 0);
    return bestSeen;
  };
  let best = search("min");
  steps = 0;
  let worst = exhausted ? NaN : search("max");
  let exact = !exhausted;
  if (exhausted) {
    // The exhaustive search ran out of budget. Fall back to a seeded local
    // search: start from random cases and keep changing one deciding answer
    // while that lowers (best) or raises (worst) what is shown. What it finds
    // is a REAL case (an applicant can give those answers), so best is at most
    // and worst at least the true extremes; they are exact only when they meet
    // the trivial bounds (the unconditional count and the total).
    const ids = [...domain.keys()];
    const climb = (want: "min" | "max"): number => {
      const better = (a: number, b: number): boolean => (want === "min" ? a < b : a > b);
      let found = want === "min" ? Infinity : -Infinity;
      const rng = mulberry32(want === "min" ? 11 : 13);
      for (let restart = 0; restart < 40; restart++) {
        const profile = new Map<string, Sim>(ids.map((id) => [id, (domain.get(id) as Sim[])[Math.floor(rng() * (domain.get(id) as Sim[]).length)]]));
        const score = (): number => countFor((id) => profile.get(id) as Sim);
        let current = score();
        for (let pass = 0; pass < 30; pass++) {
          let improved = false;
          for (const id of ids) {
            const keep = profile.get(id) as Sim;
            let bestValue = keep;
            const options: Sim[] = [...(domain.get(id) as Sim[]), UNANSWERED];
            for (const v of options) {
              profile.set(id, v);
              const s2 = score();
              if (better(s2, current)) {
                current = s2;
                bestValue = v;
                improved = true;
              }
            }
            profile.set(id, bestValue);
          }
          if (!improved) break;
        }
        if (better(current, found)) found = current;
        if ((want === "min" && found <= unconditional) || (want === "max" && found >= questions.length)) break;
      }
      return found;
    };
    best = climb("min");
    worst = climb("max");
    exact = best <= unconditional && worst >= questions.length;
  }
  return { total: questions.length, unconditional, deciding: decidingAll.size, best, typical, worst, exact, samples: SIZING_SAMPLES };
}

// ============================================
// 5. The whole plan, and applying it
// ============================================

/** What the wording check failed (direct failures only; dependents follow from the dependency logic). */
export interface CheckOmissions {
  questions: { id: string; failed: string[] }[];
  evidence: { key: string; failed: string[] }[];
}

/**
 * Build the plan for a view that ALREADY has the exclusions and the check's
 * omissions applied (with their dependents). `droppedWithDependents` and
 * `check` are filled by the caller, which knows them.
 */
export function buildPlanShape(view: PlanView): Pick<QuestionPlan, "algorithmVersion" | "merges" | "proposedConditions" | "order" | "sizing"> {
  const merges = findExactDuplicateMerges(view);
  const merged = applyMerges(view, merges);
  const proposedConditions = deriveConditions(merged);
  const conditioned = applyConditions(merged, proposedConditions);
  const order = orderQuestions(conditioned);
  const sizing = sizeQuestions(applyOrder(conditioned, order));
  return { algorithmVersion: QUESTION_PLAN_ALGORITHM_VERSION, merges, proposedConditions, order, sizing };
}

/**
 * Apply a stored plan's SHAPE (merges, conditions, order) to a view whose
 * omissions were already applied. Each step ignores an entry that no longer
 * fits (a missing id), so a plan can never make the served rubric dangle.
 */
export function applyPlanShape<T extends PlanView>(view: T, plan: Pick<QuestionPlan, "merges" | "proposedConditions" | "order">): T {
  const merged = applyMerges(view, Array.isArray(plan.merges) ? plan.merges : []);
  const conditioned = applyConditions(merged, Array.isArray(plan.proposedConditions) ? plan.proposedConditions : []);
  return applyOrder(conditioned, Array.isArray(plan.order) ? plan.order : []);
}
