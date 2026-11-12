import type { OutcomeCounts, OutcomeScope } from "../../types/outcome-statistics";
import type { OutcomeObservation } from "./outcome-source-adapter";

// ============================================
// OUTCOME STATISTICS: AGGREGATION (issue #116)
// ============================================
//
// Pure, generic maths over the adapter's normalised observations. No I/O, no
// destination, route or nationality knowledge.
//
// Grant rate = granted / (granted + refused), over the decisions in the period.
// Other published outcomes (withdrawn, lapsed, ...) are counted and reported
// but EXCLUDED from the rate. The definition is the product's own, not a
// publisher's, and the note says so.

/** Fixed nationality key for the all-nationality aggregate of a category. */
export const ALL_NATIONALITIES_KEY = "ALL";

/** One aggregated figure set before it becomes a stored doc. */
export interface AggregatedStatistic {
  categoryKey: string;
  categoryLabel: string;
  scope: OutcomeScope;
  nationalityKey: string;
  nationalityName: string | null;
  nationalityCode: string | null;
  counts: OutcomeCounts;
  otherBreakdown: Record<string, number>;
  decisions: number;
  grantRate: number | null;
}

/** granted / (granted + refused); null when there are no such decisions. */
export function computeGrantRate(granted: number, refused: number): number | null {
  const decisions = granted + refused;
  return decisions > 0 ? granted / decisions : null;
}

/** Lowercase, alphanumerics only, other runs -> "-". For ids and keys. */
export function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Lookup key for a nationality: its code when mapped, else a slug of the published name. */
export function nationalityKeyFor(name: string, code: string | null): string {
  return code ? code.toUpperCase() : `name:${slug(name)}`;
}

/** Mutable running totals while summing. */
interface Acc {
  categoryLabel: string;
  nationalityName: string | null;
  nationalityCode: string | null;
  granted: number;
  refused: number;
  other: number;
  otherBreakdown: Record<string, number>;
}

/** Add one observation into an accumulator. */
function add(acc: Acc, o: OutcomeObservation): void {
  if (o.outcome === "granted") acc.granted += o.decisions;
  else if (o.outcome === "refused") acc.refused += o.decisions;
  else {
    acc.other += o.decisions;
    const label = o.otherLabel ?? "Other";
    acc.otherBreakdown[label] = (acc.otherBreakdown[label] ?? 0) + o.decisions;
  }
}

/**
 * Sum observations (already limited to the window) into one statistic per
 * (category, nationality) plus one all-nationality statistic per category,
 * computed with exactly the same arithmetic. Combinations with no decisions
 * at all are not emitted.
 */
export function aggregateObservations(observations: OutcomeObservation[]): AggregatedStatistic[] {
  const byNationality = new Map<string, Acc & { categoryKey: string; nationalityKey: string }>();
  const byCategory = new Map<string, Acc & { categoryKey: string }>();

  for (const o of observations) {
    // ---- per nationality ----
    const nKey = nationalityKeyFor(o.nationalityName, o.nationalityCode);
    const mapKey = `${o.categoryKey}\u0000${nKey}`;
    let n = byNationality.get(mapKey);
    if (!n) {
      n = {
        categoryKey: o.categoryKey,
        nationalityKey: nKey,
        categoryLabel: o.categoryLabel,
        nationalityName: o.nationalityName,
        nationalityCode: o.nationalityCode ? o.nationalityCode.toUpperCase() : null,
        granted: 0,
        refused: 0,
        other: 0,
        otherBreakdown: {},
      };
      byNationality.set(mapKey, n);
    }
    add(n, o);

    // ---- all nationalities for the category ----
    let c = byCategory.get(o.categoryKey);
    if (!c) {
      c = {
        categoryKey: o.categoryKey,
        categoryLabel: o.categoryLabel,
        nationalityName: null,
        nationalityCode: null,
        granted: 0,
        refused: 0,
        other: 0,
        otherBreakdown: {},
      };
      byCategory.set(o.categoryKey, c);
    }
    add(c, o);
  }

  const toStat = (a: Acc & { categoryKey: string }, scope: OutcomeScope, nationalityKey: string): AggregatedStatistic => ({
    categoryKey: a.categoryKey,
    categoryLabel: a.categoryLabel,
    scope,
    nationalityKey,
    nationalityName: a.nationalityName,
    nationalityCode: a.nationalityCode,
    counts: { granted: a.granted, refused: a.refused, other: a.other },
    otherBreakdown: a.otherBreakdown,
    decisions: a.granted + a.refused,
    grantRate: computeGrantRate(a.granted, a.refused),
  });

  const out: AggregatedStatistic[] = [];
  for (const n of byNationality.values()) {
    if (n.granted + n.refused + n.other > 0) out.push(toStat(n, "nationality", n.nationalityKey));
  }
  for (const c of byCategory.values()) {
    if (c.granted + c.refused + c.other > 0) out.push(toStat(c, "all", ALL_NATIONALITIES_KEY));
  }
  return out;
}
