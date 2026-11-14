import type { AssessmentCriterion, CompetenceBlock, CompetenceStep, IntakeCondition, IntakeQuestion, VisaRubric } from "../../types/rubric";
import { isCountryCode } from "../../authorities/authority-ids";
import { normalizeForQuoteMatch } from "../shared/fetch/pdf-text";

// ============================================
// COMPETENCE STEPS — THE CODE CHECK (issue #235, P6 of #228)
// ============================================
//
// A shared (bloc / treaty) rulebook may carry a `competence` block: the
// ordered steps that propose WHICH MEMBER COUNTRY an applicant applies
// through (types/rubric.ts `CompetenceStep`). This module is the ONE code
// check of that block, used in three places so they can never disagree:
//
//   1. drafting (rubric-extraction.service.ts `mergeAssessments`): a drafted
//      block that fails is not stored at all (a reviewer flag says why);
//   2. the structural validator (rubric-validate.ts): a stored block that
//      fails is damaged data, so the version is not stored or approved;
//   3. the READ side (rubric-exclusions.ts `applyExclusions`, which every
//      consumer goes through): a block is served only while every step still
//      passes against the version AS SERVED (a step whose rule the
//      independent check left out, or whose question the wording check
//      omitted or merged away, takes the whole block with it).
//
// The rule behind every check: a step claims only what the guidance says.
//  - It rests on a RULE of the same layer (`criterionId`), and its `source`
//    is exactly that rule's verbatim quote and URL. The rule itself is read by
//    the independent rule check like any other rule, so the quote is checked
//    like any rule's.
//  - The words it applies (`restsOn`) are in that quote, verbatim.
//  - It reads ONE answer: a choice question of the same layer whose options
//    are the route's member countries from membership data at the time of
//    asking (`optionsFrom: "route_destinations"`), so no country is ever typed
//    into the rulebook. The question stores no country option.
//  - `resultFrom` is always "answer": code never works a country out of
//    dates, lengths of stay or anything else (F1: "length or purpose of stay"
//    is the applicant's to say).
//
// WHY THE WHOLE BLOCK GOES WHEN ONE STEP FAILS: the steps are an ORDER
// ("sole destination, then main destination, then first border"). Dropping a
// middle step would let a later step decide cases the guidance gives to the
// earlier one. With no block the applicant simply picks: never a guess.
//
// Pure: no Firebase, no clock. Names no country, bloc or route.

/** Most steps one block may hold (a sanity cap, not a legal rule). */
export const MAX_COMPETENCE_STEPS = 10;
/** Shortest `restsOn` accepted: a word or phrase, never a single letter. */
export const MIN_RESTS_ON_CHARS = 3;

/** One problem with a block (code + plain words, and the step it is about, -1 for the block). */
export interface CompetenceProblem {
  code: string;
  message: string;
  stepIndex: number;
}

/** The answer types a step's question may have (the answer must name countries from a list). */
const CHOICE_TYPES: readonly string[] = ["single_choice", "multi_choice"];

/** Does a quote contain these words (whitespace-normalised, exact otherwise)? */
export function quoteContains(quote: string, words: string): boolean {
  const w = normalizeForQuoteMatch(words);
  return w.length >= MIN_RESTS_ON_CHARS && normalizeForQuoteMatch(quote).includes(w);
}

/** Is this a question whose options come from the route's member countries? */
export function isDestinationQuestion(q: Pick<IntakeQuestion, "answerType" | "optionsFrom"> | undefined): boolean {
  return !!q && q.optionsFrom === "route_destinations" && CHOICE_TYPES.includes(q.answerType);
}

/** Problems with one `when` condition (it must read a question of the same layer). */
function conditionProblem(cond: IntakeCondition, questionIds: ReadonlySet<string>): string | null {
  if (!cond || typeof cond.questionId !== "string" || !questionIds.has(cond.questionId)) return "a step's condition reads a question that is not in the rulebook";
  if (!["eq", "neq", "in"].includes(String(cond.op))) return "a step's condition has an unknown operator";
  if (cond.op === "in" && !Array.isArray(cond.value)) return "an `in` condition needs a list of values";
  return null;
}

/**
 * Every problem with a rubric's competence block, checked against the
 * rubric's OWN criteria and questions (pass the served view to check what is
 * served). Empty when there is no block, or when the block is sound.
 *
 * @param rubric the version (or its served view)
 * @param opts.sharedRulebook false when the rulebook is a COUNTRY's own: such
 *   a rulebook has no members to choose between, so a block on it is refused.
 */
export function competenceProblems(
  rubric: Pick<VisaRubric, "competence" | "criteria" | "intakeQuestions">,
  opts: { sharedRulebook?: boolean } = {}
): CompetenceProblem[] {
  const block = rubric.competence;
  if (block === undefined) return [];
  const out: CompetenceProblem[] = [];
  const add = (code: string, message: string, stepIndex = -1) => out.push({ code, message, stepIndex });
  if (opts.sharedRulebook === false) add("competence_not_shared", "only a shared (bloc or treaty) rulebook can say which member country examines an application");
  if (!block || typeof block !== "object" || !Array.isArray(block.steps) || block.steps.length === 0) {
    add("competence_empty", "a competence block needs at least one step");
    return out;
  }
  if (block.steps.length > MAX_COMPETENCE_STEPS) add("competence_too_long", `a competence block holds at most ${MAX_COMPETENCE_STEPS} steps`);

  const criteria = new Map<string, AssessmentCriterion>((Array.isArray(rubric.criteria) ? rubric.criteria : []).map((c) => [c.criterionId, c]));
  const questions = new Map<string, IntakeQuestion>((Array.isArray(rubric.intakeQuestions) ? rubric.intakeQuestions : []).map((q) => [q.id, q]));
  const questionIds = new Set(questions.keys());

  block.steps.forEach((s: CompetenceStep, i) => {
    if (!s || typeof s !== "object") return add("competence_step_invalid", "each step must be an object", i);
    // ---- the rule it rests on, and its quote ----
    const rule = criteria.get(s.criterionId);
    if (!rule) return add("competence_rule_unknown", "a step rests on a rule that is not in the rulebook", i);
    if (!s.source || typeof s.source.quote !== "string" || !s.source.quote.trim() || typeof s.source.url !== "string" || !s.source.url) {
      return add("competence_source_missing", "a step needs the quote and URL of the rule it rests on", i);
    }
    // The step's quote IS its rule's quote (copied by code), never different words.
    if (s.source.quote !== rule.source?.quote || s.source.url !== rule.source?.url) {
      return add("competence_source_mismatch", "a step's quote and URL must be exactly those of the rule it rests on", i);
    }
    if (typeof s.restsOn !== "string" || !quoteContains(s.source.quote, s.restsOn)) {
      return add("competence_rests_on_not_in_quote", "the words a step applies must be in its quote, verbatim", i);
    }
    // ---- where the result comes from: the answer, never anything else ----
    if (s.resultFrom !== "answer") return add("competence_result_from_invalid", "a step's result comes from the applicant's answer", i);
    // ---- the question it reads ----
    const q = questions.get(s.questionId);
    if (!q) return add("competence_question_unknown", "a step reads a question that is not in the rulebook", i);
    if (!isDestinationQuestion(q)) return add("competence_question_not_destinations", "a step reads a choice question whose options are the route's member countries", i);
    // ---- its conditions ----
    for (const cond of s.when ?? []) {
      const p = conditionProblem(cond, questionIds);
      if (p) return add("competence_condition_invalid", p, i);
    }
    return undefined;
  });
  return out;
}

/**
 * A destination question must never STORE a country option: the countries
 * come from membership data when it is asked. Returns the stored option
 * values that look like a country code (empty when none).
 */
export function storedCountryOptions(q: Pick<IntakeQuestion, "optionsFrom" | "options">): string[] {
  if (q.optionsFrom !== "route_destinations") return [];
  return (q.options ?? []).map((o) => o.value).filter((v) => isCountryCode(v) || isCountryCode(String(v).toUpperCase()));
}

/**
 * The block as it may be SERVED from this (served) view: the block itself
 * when every step passes, else undefined (the whole block, see the header).
 */
export function servableCompetence(rubric: Pick<VisaRubric, "competence" | "criteria" | "intakeQuestions">): CompetenceBlock | undefined {
  if (rubric.competence === undefined) return undefined;
  return competenceProblems(rubric).length === 0 ? rubric.competence : undefined;
}
