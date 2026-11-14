// ============================================
// RUBRIC — THE MEANING OF EACH RULE KIND (issue #242, part of #240)
// ============================================
//
// ONE wording of what `objective`, `mandatory_bar` and `judgement` mean, used by
// the independent check's prompt. It is written to say the same thing as the
// drafting prompt (`rubric-prompt.ts`: "no fixed figure, use judgement"):
// before this, the check defined `judgement` as "weigh evidence or be
// satisfied" while the drafter was told "everything with no fixed figure", so
// every requirement the applicant must show, every permitted activity and every
// definition drafted as `judgement` was answered "unsure" by the check (70 of
// 70 `kind_right = unsure` rules in the first real run).
//
// (#243) This file is the ONE source of truth. BOTH the drafting prompt
// (`rubric-prompt.ts`, "Kinds") and the check's prompt (`rubric-checker-prompt.ts`,
// `kind_right`) embed `KIND_WORDING_SENTENCE`, so the drafter and the checker can
// never again disagree on what a kind means; a test pins that both prompts carry
// that exact sentence.
//
// Nothing here is a standard: it defines words, it never says what to answer
// when in doubt (the check's "Never guess yes" is in the check's own prompt).
// Generic: no country, route or publisher.

/** `objective`: what a program can compare. */
export const KIND_OBJECTIVE = "a fixed figure or a plain fact that a program can compare (a number, a date, a duration, an amount, whether something exists)";

/** `mandatory_bar`: a bar on a stated group. */
export const KIND_MANDATORY_BAR = "a bar on a stated group of applicants, whatever else is true";

/**
 * `judgement`: everything else a decision maker decides without a fixed figure.
 * The examples are the ones the drafting prompt routes to `judgement` and the
 * first real run showed the check doubting.
 */
export const KIND_JUDGEMENT =
  "everything else that a decision maker decides without such a fixed figure, including a requirement the applicant must show, a permitted activity, a definition, a method of calculation and an instruction to the decision maker";

/**
 * (#243) The three meanings as ONE sentence, embedded word for word in the drafting prompt and in the
 * check's `kind_right` line. Change the wording above and both prompts change (bump both versions).
 */
export const KIND_WORDING_SENTENCE = `\`objective\` means the quote sets ${KIND_OBJECTIVE}; \`mandatory_bar\` means the quote sets ${KIND_MANDATORY_BAR}; \`judgement\` covers ${KIND_JUDGEMENT}.`;
