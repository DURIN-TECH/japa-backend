// ============================================
// SCRAPE ALERTS — month-to-date LLM cost source (issue #83 -> #82)
// ============================================
//
// The llm_budget rule (#83) needs this month's LLM spend and the budget.
// Both come from the cost tracking issue (#82), built in parallel, so the
// rule codes against this small interface and ships with a STUB that has no
// budget: evaluateBudget() then skips the rule entirely (no alert is ever
// raised or resolved by it).
//
// TODO(#82): replace `stubMonthToDateCostSource` with #82's monthly rollup
// (month-to-date `costUsd` summed over scrapeRuns + the configured budget)
// and assign it as `scrapeAlertService.costSource` (or make it the default
// below). Nothing else in #83 changes.

/** This month's LLM spend and its budget (both USD). */
export interface MonthToDateCost {
  monthUsd: number; // spend since the 1st of the current UTC month
  budgetUsd: number | null; // null = no budget configured: the rule is skipped
}

/** Anything that can report month-to-date LLM cost (#82 implements it). */
export interface MonthToDateCostSource {
  getMonthToDateCost(): Promise<MonthToDateCost>;
}

/** Placeholder until #82 lands: no budget, so llm_budget never fires. */
export const stubMonthToDateCostSource: MonthToDateCostSource = {
  async getMonthToDateCost(): Promise<MonthToDateCost> {
    // TODO(#82): read the real monthly rollup + budget.
    return { monthUsd: 0, budgetUsd: null };
  },
};
