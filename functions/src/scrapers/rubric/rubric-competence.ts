import type { AssessmentCriterion, CompetenceBlock, CompetenceStep, IntakeCondition, IntakeQuestion, VisaRubric } from "../../types/rubric";
import { isCountryCode } from "../../authorities/authority-ids";
import { normalizeForQuoteMatch } from "../shared/fetch/pdf-text";
import { containsTokenBounded } from "./rubric-quote";

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
//  - The words it applies (`restsOn`) are in that quote, verbatim, or (#335)
//    verbatim in ONE of that rule's stored list lines (`source.listItems`).
//    A rule whose quote is a lead-in ("... shall be:") holds its cases in the
//    list under it ("(a) ... the sole destination ..."); those lines are
//    attached by CODE from the stored snapshot (rubric-list-items.ts) and
//    re-proved verbatim by the independent check, so they are the official
//    words just as much as the quote is. The words must still sit inside one
//    line (the quote or one item): never stitched across two.
//  - (#335, fix round 1) The words name EXACTLY ONE of those lines. A lead-in
//    rule's steps are told apart only by the line each rests on, and that line
//    is what the applicant is shown as the official words for the proposal.
//    Words that are in two or more lines ("the Member State", which every
//    case of such a rule repeats) do not say which case the step applies, so
//    the step is refused with its own code (`competence_rests_on_ambiguous`)
//    and, like any failing step, takes the whole block with it. The first
//    matching line is never picked for it. The match is on TOKEN BOUNDARIES
//    (`containsTokenBounded`, rubric-quote.ts): words cut out of the middle of
//    longer words do not count; and the words must be at least
//    MIN_RESTS_ON_CHARS long, so "the" or "or" can never be a step's basis.
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
/**
 * Shortest `restsOn` accepted, in characters after whitespace normalisation.
 * (#335, fix round 1: raised from 3.) Eight is the length the quote code
 * already uses for "the shortest part of a condition that can be located"
 * (`MIN_CONDITION_PART_CHARS`): anything shorter is a stray word ("the",
 * "stay", "border") that matches almost anywhere and says nothing about which
 * case of the rule a step applies.
 */
export const MIN_RESTS_ON_CHARS = 8;

/** One problem with a block (code + plain words, and the step it is about, -1 for the block). */
export interface CompetenceProblem {
  code: string;
  message: string;
  stepIndex: number;
}

/** The answer types a step's question may have (the answer must name countries from a list). */
const CHOICE_TYPES: readonly string[] = ["single_choice", "multi_choice"];

/**
 * Does a line (a quote or one list line) contain these words? Verbatim,
 * whitespace-normalised, case-sensitive, and (#335, fix round 1) on TOKEN
 * BOUNDARIES: the words may not begin or end inside a longer word or number
 * ("destination" is not in "destinations"; see `containsTokenBounded`). Words
 * shorter than MIN_RESTS_ON_CHARS are never contained.
 */
export function quoteContains(quote: string, words: string): boolean {
  return normalizeForQuoteMatch(words).length >= MIN_RESTS_ON_CHARS && containsTokenBounded(quote, words);
}

/** Where a step's words can sit: the rule's quote, or one of its list lines (by position). */
export type RestsOnSite = "quote" | number;

/**
 * (#335, fix round 1) EVERY place a step's words are found among its rule's
 * official lines: "quote" for the quote itself, and the index of each list
 * line (`source.listItems`) that holds them. Empty: the words are not the
 * rule's. One entry: the step names that line. Two or more: the words do not
 * tell the rule's cases apart (ambiguous).
 */
export function restsOnSites(source: { quote: string; listItems?: readonly string[] }, words: string): RestsOnSite[] {
  const sites: RestsOnSite[] = [];
  if (typeof source.quote === "string" && quoteContains(source.quote, words)) sites.push("quote");
  const items = Array.isArray(source.listItems) ? source.listItems : [];
  items.forEach((item, at) => {
    if (typeof item === "string" && quoteContains(item, words)) sites.push(at);
  });
  return sites;
}

/**
 * (#335) THE one place a step's words are: "quote", or the index of the one
 * list line that holds them. Undefined when they are nowhere in the rule's
 * official words, AND when they are in two or more places (fix round 1: the
 * first match is never taken; see the header). Callers that need to tell the
 * two apart use `restsOnSites`.
 */
export function restsOnSite(source: { quote: string; listItems?: readonly string[] }, words: string): RestsOnSite | undefined {
  const sites = restsOnSites(source, words);
  return sites.length === 1 ? sites[0] : undefined;
}

/**
 * (#335) The official words SHOWN for a step: its rule's quote, followed by
 * the list line the step rests on when its words are in a list line (the
 * lead-in alone, "... shall be:", says nothing about the case). Every line is
 * a stored verbatim line of the rule (quote or `listItems`), joined by a line
 * break, the same way `quoteWithItems` joins the whole list. Nothing is
 * reworded. When the words are in the quote, the quote alone. A step whose
 * words name no single line never reaches an applicant (`competenceProblems`
 * refuses it and the block is not served); for such a step this returns the
 * quote alone, never a guessed line.
 */
export function stepQuoteShown(source: { quote: string; listItems?: readonly string[] }, words: string): string {
  const site = restsOnSite(source, words);
  return typeof site === "number" ? `${source.quote}\n${(source.listItems as readonly string[])[site]}` : source.quote;
}

/** Same stored list lines (both absent counts as the same)? */
function sameListItems(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
  const x = a ?? [];
  const y = b ?? [];
  return x.length === y.length && x.every((line, i) => line === y[i]);
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
    // (#335) Its list lines too: a step may rest on a list line, so the lines it
    // carries must be exactly the rule's (which the independent check re-proves
    // against the snapshot), never others.
    if (s.source.quote !== rule.source?.quote || s.source.url !== rule.source?.url || !sameListItems(s.source.listItems, rule.source?.listItems)) {
      return add("competence_source_mismatch", "a step's quote, list lines and URL must be exactly those of the rule it rests on", i);
    }
    // (#335) The words are in the quote, or in one of its list lines, verbatim
    // and on token boundaries, and at least MIN_RESTS_ON_CHARS long.
    const sites = typeof s.restsOn === "string" ? restsOnSites(s.source, s.restsOn) : [];
    if (sites.length === 0) {
      return add("competence_rests_on_not_in_quote", `the words a step applies must be in its quote or one of its list lines, verbatim, as whole words, and at least ${MIN_RESTS_ON_CHARS} characters long`, i);
    }
    // (#335, fix round 1) ... and in exactly ONE of them. Words found in two
    // or more lines do not say which case the step applies; the applicant
    // would be shown a line picked by position. Refused, never resolved.
    if (sites.length > 1) {
      return add("competence_rests_on_ambiguous", `the words a step applies are in ${sites.length} lines of its rule (its quote and list lines); they must be in exactly one, so the step names one case`, i);
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
