import { scrapeCostService } from "../cost/scrape-cost.service";
import { roundUsd } from "../cost/scrape-cost-pricing";
import type { ScraperSettings } from "./types";

// ============================================
// BUDGET HARD STOP — visa extraction gate (issue #96)
// ============================================
//
// With `budget.hardStop` on (appConfig/scraperSettings) and a monthly budget
// set (appConfig/scrapeBudget.monthlyUsd, #82), a visa run must not make an
// LLM call once the month's spend has reached the budget. The run still
// fetches and hashes pages (so changes are noticed and stay pending); only
// extraction is skipped.
//
// The month-to-date figure comes from the monthly rollup (scrapeCosts/{month},
// written by the #82 finalize hook AFTER each run), so a run also adds its
// OWN cost so far (recorder.usageSoFar.costUsd) before each call: a run that
// crosses the budget mid-way stops there instead of finishing its batch.

/** The gate for one run: read once at the run's start. */
export interface BudgetGate {
  budgetUsd: number;
  monthToDateUsd: number; // rollup total at the run's start
  month: string; // UTC month, "2026-11"
  /** True when (rollup + this run's cost so far) >= budget: skip extraction. */
  exceeded(runCostSoFarUsd: number): boolean;
}

/** Minimal cost source (the scrapeCostService singleton; tests may inject). */
export type MonthToDateReader = Pick<typeof scrapeCostService, "monthToDate">;

/**
 * Build the run's gate, or null when there is nothing to enforce (hard stop
 * off, or no budget). Only reads Firestore when the hard stop is ON, so the
 * default config costs a tick nothing. Never throws: when the month-to-date
 * figure cannot be read the gate is null (the run extracts as before) and
 * `onReadError` is told, so the caller records a run warning.
 */
export async function loadBudgetGate(
  settings: ScraperSettings,
  nowMs: number,
  onReadError: (message: string) => void,
  costs: MonthToDateReader = scrapeCostService
): Promise<BudgetGate | null> {
  if (!settings.budget.hardStop) return null;
  try {
    const mtd = await costs.monthToDate(nowMs);
    if (mtd.budgetUsd === null) return null; // hard stop on, but no budget set: nothing to stop at
    const budgetUsd = mtd.budgetUsd;
    const monthToDateUsd = mtd.costUsd;
    return {
      budgetUsd,
      monthToDateUsd,
      month: mtd.month,
      exceeded: (runCostSoFarUsd: number) => roundUsd(monthToDateUsd + runCostSoFarUsd) >= budgetUsd,
    };
  } catch (err) {
    onReadError(`budget hard stop not checked (month-to-date cost unreadable): ${(err as Error)?.message ?? String(err)}`);
    return null;
  }
}
