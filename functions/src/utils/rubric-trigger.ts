import type { IntakeCondition, IntakeQuestion, RuleTrigger } from "../types/rubric";

// ============================================
// RUBRIC RULE TRIGGERS: THE ONE IMPLEMENTATION (INTEGRATION of #200 and #207)
// ============================================
//
// A conditional / specialist rule carries `trigger = { questionId, anyOf }`:
// "this rule applies when the answer to that question is one of these option
// values" (#207). Three places need to agree on what that means:
//   - the consumers (assessment, checklist, chat, upload check) through
//     services/ai/rule-applicability.ts,
//   - the intake service, which shows a question only when a rule's trigger
//     holds (`effectiveIntakeQuestions` builds a `showWhen` from the triggers),
//   - the question plan (scrapers/rubric/rubric-question-plan.ts), which
//     derives the same `showWhen` and simulates what an applicant is shown,
//   - the independent check (scrapers/rubric/rubric-checker.ts), which asks
//     whether a trigger matches its rule's quoted condition.
// Before this module the plan had its own (narrower) copy: it accepted only
// single-choice parents and wrote `eq` conditions, which never hold for a
// yes/no answer (a boolean) or a multi-choice answer (an array). Pure, no
// Firebase, no model, no country, route or publisher.

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

/**
 * THE test "does this answer satisfy a trigger (or an `in` condition)":
 * does the answer include any of the wanted option values? Used by the
 * consumers, the intake service's `in` condition and the plan's simulation.
 */
export function answerIncludesAny(answer: unknown, wanted: readonly string[]): boolean {
  const tokens = answerTokens(answer);
  return tokens.some((t) => wanted.includes(t));
}

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

/**
 * The `showWhen` conditions that show a question when ANY of these rule
 * triggers holds: one `in` condition per trigger question, with the values of
 * all triggers on the same question joined. Always `in` with string values,
 * because that is the form the intake service evaluates with
 * `answerIncludesAny` (so a boolean and an array answer both work); `eq`
 * would not hold for either.
 */
export function conditionsForTriggers(triggers: readonly RuleTrigger[]): IntakeCondition[] {
  const byQuestion = new Map<string, Set<string>>();
  for (const t of triggers) {
    const set = byQuestion.get(t.questionId) ?? new Set<string>();
    for (const v of t.anyOf) set.add(v);
    byQuestion.set(t.questionId, set);
  }
  return [...byQuestion.entries()].map(([questionId, values]) => ({ questionId, op: "in" as const, value: [...values] }));
}
