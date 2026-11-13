// ============================================
// Risk rules: shared shapes (issue #121)
// ============================================
//
// A "risk rule" is a small piece of CODE that looks at data we already store
// and decides whether a pattern is worth a person's attention. It never calls
// a model, never reads message content, and never acts on anyone: its only
// possible effect is a signal raised through riskSignalService (#119).
//
// Every rule is grounded in a published source. The quote is carried on the
// rule, copied verbatim, and lands on every signal the rule raises.

import type { RiskSignalCategory } from "../../types/risk-signal";

/**
 * Registry entry for one rule. `evaluate` is PURE: same input, same output,
 * no Firestore, no clock, no network. Loading the data and raising the signal
 * happen elsewhere (see the runner next to each rule).
 */
export interface RiskRule<Input, Finding> {
  /** Stable key, lower case with underscores. Goes on `source.ruleId`. */
  ruleId: string;
  /** Bumped whenever the rule's logic changes. Goes on `source.version`. */
  version: string;
  /** The broad harm the rule relates to. */
  category: RiskSignalCategory;
  /** Published guidance the rule is based on (http/https). */
  sourceUrl: string;
  /** Verbatim quote from that guidance. A rule without one is not registered. */
  sourceQuote: string;
  /** Pure decision over already-loaded data. `null` = nothing to raise. */
  evaluate(input: Input): Finding | null;
}

/** The registry stores rules of different input types side by side. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyRiskRule = RiskRule<any, any>;
