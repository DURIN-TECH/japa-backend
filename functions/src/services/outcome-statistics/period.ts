import type { OutcomePeriod, PeriodQuarter } from "../../types/outcome-statistics";

// ============================================
// OUTCOME STATISTICS: QUARTER / PERIOD HELPERS (issue #116)
// ============================================
//
// Pure helpers, no I/O. Publishers label quarters like "2026 Q2"; an adapter
// turns its own labels into PeriodQuarter, and everything after that works on
// the structured form. Quarters are CALENDAR quarters (Q1 = Jan-Mar).
// Nothing here names a destination.

/** Sortable integer for a quarter: later quarters are larger. */
export function quarterIndex(q: PeriodQuarter): number {
  return q.year * 4 + (q.quarter - 1);
}

/** Inverse of quarterIndex. */
export function quarterFromIndex(index: number): PeriodQuarter {
  return { year: Math.floor(index / 4), quarter: (index % 4) + 1 };
}

/** "2026 Q2" for a quarter (the form publishers use and we store). */
export function formatQuarter(q: PeriodQuarter): string {
  return `${q.year} Q${q.quarter}`;
}

/**
 * Parse "2026 Q2" (any spacing, optional "Q"/"q"). Returns null for anything
 * else, including out-of-range quarters: callers treat null as a schema
 * problem and fail the import rather than guess.
 */
export function parseQuarterLabel(text: string): PeriodQuarter | null {
  const m = /^\s*(\d{4})\s*Q\s*([1-4])\s*$/i.exec(text);
  if (!m) return null;
  return { year: Number(m[1]), quarter: Number(m[2]) };
}

/** First day (ISO date) of a calendar quarter. */
export function quarterStartDate(q: PeriodQuarter): string {
  const month = (q.quarter - 1) * 3 + 1;
  return `${q.year}-${String(month).padStart(2, "0")}-01`;
}

/** Last day (ISO date) of a calendar quarter. */
export function quarterEndDate(q: PeriodQuarter): string {
  // Day 0 of the month after the quarter's last month = that month's last day.
  const lastMonth = q.quarter * 3; // 3, 6, 9, 12
  const lastDay = new Date(Date.UTC(q.year, lastMonth, 0)).getUTCDate();
  return `${q.year}-${String(lastMonth).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
}

/**
 * Build the OutcomePeriod for a set of quarter indexes (any order, distinct).
 * Label: "year ending 2026 Q2" for exactly four quarters (the window the note
 * uses), otherwise "<n> quarters ending 2026 Q2" so the label is never wrong
 * if the window length is changed.
 */
export function buildPeriod(indexes: number[]): OutcomePeriod {
  if (indexes.length === 0) throw new Error("buildPeriod: no quarters");
  const sorted = [...new Set(indexes)].sort((a, b) => a - b);
  const first = quarterFromIndex(sorted[0]);
  const last = quarterFromIndex(sorted[sorted.length - 1]);
  const lastLabel = formatQuarter(last);
  return {
    start: quarterStartDate(first),
    end: quarterEndDate(last),
    quarters: sorted.map((i) => formatQuarter(quarterFromIndex(i))),
    label: sorted.length === 4 ? `year ending ${lastLabel}` : `${sorted.length} quarters ending ${lastLabel}`,
  };
}
