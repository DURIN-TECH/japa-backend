import { scrapeCostService, type ScrapeCostService } from "../cost/scrape-cost.service";

// ============================================
// SCRAPE ALERTS — month-to-date LLM cost source (issue #83 over #82)
// ============================================
//
// The llm_budget rule (#83) needs this month's LLM spend and the budget. #82
// keeps both: the monthly rollup `scrapeCosts/{YYYY-MM}` (written by its
// finalize hook) and the budget `appConfig/scrapeBudget.monthlyUsd`, read
// together by `scrapeCostService.monthToDate()` (its stable #83 reader,
// returning { costUsd, budgetUsd, ... }). This file adapts that shape to the
// small interface the rule codes against, so the rule's tests can swap in a
// fake source.
//
// With no budget set (`budgetUsd: null`) evaluateBudget() skips the rule
// entirely (nothing raised or resolved).

/** This month's LLM spend and its budget (both USD). */
export interface MonthToDateCost {
  monthUsd: number; // spend since the 1st of the current UTC month
  budgetUsd: number | null; // null = no budget configured: the rule is skipped
}

/** Anything that can report month-to-date LLM cost. */
export interface MonthToDateCostSource {
  /**
   * @param nowMs the check's clock (picks the UTC month); defaults to now.
   *   Throws on a read failure (the hourly check then skips the rule).
   */
  getMonthToDateCost(nowMs?: number): Promise<MonthToDateCost>;
  /**
   * Catch the rollup up before reading it (#82 backfillRecent: runs whose
   * finalize-hook rollup did not happen, e.g. a crash). Optional; never throws.
   */
  catchUp?(nowMs?: number): Promise<void>;
}

/** Adapter over #82's scrapeCostService (the production source). */
export function scrapeCostMonthToDateSource(costs: ScrapeCostService = scrapeCostService): MonthToDateCostSource {
  return {
    async getMonthToDateCost(nowMs?: number): Promise<MonthToDateCost> {
      const mtd = await costs.monthToDate(nowMs);
      // #82 names it costUsd; the rule calls it monthUsd.
      return { monthUsd: mtd.costUsd, budgetUsd: mtd.budgetUsd };
    },
    async catchUp(nowMs?: number): Promise<void> {
      // backfillRecent never throws (documented by #82); guard anyway.
      try {
        await costs.backfillRecent(nowMs);
      } catch (err) {
        console.error(`Scrape alerts: cost backfill failed: ${(err as Error)?.message ?? err}`);
      }
    },
  };
}
