import { Timestamp, type Transaction } from "firebase-admin/firestore";
import { collections, db } from "../utils/firebase";
import type { ScrapeRunDoc, ScrapeRunKind } from "../types/scrape-run";
import { SCRAPE_RUN_KINDS } from "../types/scrape-run";
import type {
  CostTotals,
  KindCostTotals,
  LlmModelPrice,
  LlmPricingDoc,
  PricingOrigin,
  RequestPrice,
  ScrapeBudgetDoc,
  ScrapeCostMonthDoc,
  ScrapeCostMonthToDate,
} from "../types/scrape-cost";
import {
  DEFAULT_LLM_PRICING,
  addMonths,
  addTotals,
  addTotalsMap,
  averageUsageOf,
  emptyTotals,
  monthKeyUtc,
  monthsBetween,
  normalizeTotals,
  roundUsd,
  type AverageUsage,
} from "./scrape-cost-pricing";
import { safeErrorMessage, scrapeRunService, type ScrapeRunService } from "./scrape-run.service";

// ============================================
// SCRAPE COST — price table, budget, monthly rollup, admin report (issue #82)
// ============================================
//
// Firestore side of cost tracking (pure maths: scrape-cost-pricing.ts).
//
//   appConfig/llmPricing    price table (LlmPricingDoc). Seeded from
//                           DEFAULT_LLM_PRICING by seed-all when absent (never
//                           overwritten there); edited by hand when the
//                           provider's page changes. Read once per run.
//   appConfig/scrapeBudget  { monthlyUsd } (ScrapeBudgetDoc). Separate doc:
//                           the provider's prices and our budget change for
//                           different reasons and by different people.
//   scrapeCosts/{YYYY-MM}   monthly rollup (ScrapeCostMonthDoc), UTC month of
//                           the run's startedAt.
//   scrapeCosts/{YYYY-MM}/runs/{runId}
//                           marker: this run is already in the rollup.
//
// Rollup: a scrapeRunService finalize hook (installed at module load, below)
// adds each finalised run in ONE transaction that reads the marker + month
// doc, and writes both. A replay of the same run (a late finalize after a
// stale sweep, a retried hook) finds the marker and adds nothing, so the
// rollup is idempotent per runId. Runs swept as stale never call hooks: their
// usage lived in the crashed process's memory and is lost (they rarely
// reached the API, but a crash mid-crawl under-reports; see the doc).
//
// Backfill (#82 review): if the hook's transaction fails, the run doc keeps
// `costRolledUp: false`; backfillRecent() (start of every visa orchestrator
// tick, later #83's hourly check) re-applies such runs of the current and
// previous month, bounded, idempotent through the marker.
//
// Errors never reach a scraper: the hook is isolated by the run service and
// loadPricing() falls back to the default table on a read failure.

/** Doc ids under appConfig. */
export const LLM_PRICING_DOC_ID = "llmPricing";
export const SCRAPE_BUDGET_DOC_ID = "scrapeBudget";

/** Most months one /admin/scrape-costs call may span. */
export const SCRAPE_COST_MAX_MONTHS = 24;
/** Default span (months, incl. the `to` month) when `from` is omitted. */
export const SCRAPE_COST_DEFAULT_MONTHS = 6;
/**
 * Most un-rolled-up runs one backfill pass re-applies (#82 review). Normally
 * zero: the finalize hook handles every run; this only catches runs whose
 * hook failed (e.g. a transient Firestore error).
 */
export const ROLLUP_BACKFILL_MAX_RUNS = 50;
/** Visa runs read to average usage per extraction (the re-extract estimate). */
export const ESTIMATE_HISTORY_RUNS = 50;

/** Group keys of GET /admin/scrape-costs. */
export type ScrapeCostGroupBy = "month" | "country" | "model" | "kind";
export const SCRAPE_COST_GROUP_BYS: readonly ScrapeCostGroupBy[] = ["month", "country", "model", "kind"];

/** A loaded price table and where it came from. */
export interface LoadedPricing {
  pricing: LlmPricingDoc;
  origin: PricingOrigin; // "config" = appConfig/llmPricing; "default" = DEFAULT_LLM_PRICING
}

/** One row of the report: the group key + its totals. */
export type ScrapeCostGroup = { key: string } & CostTotals;

/** GET /admin/scrape-costs response body (`data`). */
export interface ScrapeCostReport {
  from: string; // first month, "YYYY-MM"
  to: string; // last month, inclusive
  groupBy: ScrapeCostGroupBy;
  kind: ScrapeRunKind | null; // the kind filter applied, null = all kinds
  currency: "USD";
  // groupBy=month: every month from..to, oldest first, zero-filled.
  // Otherwise: one row per key seen in range, highest costUsd first.
  groups: ScrapeCostGroup[];
  totals: CostTotals; // the whole range (kind-filtered)
  // The CURRENT month's spend against the budget (all kinds: the budget
  // covers all scraping). monthlyUsd null = no budget configured.
  budget: {
    monthlyUsd: number | null;
    month: string;
    monthToDateUsd: number;
    usedFraction: number | null;
    configPath: string; // where to set it
  };
  // The price table costs are computed with, with its provenance.
  pricing: {
    origin: PricingOrigin;
    configPath: string;
    verifiedAt: string;
    models: Array<{ model: string } & LlmModelPrice>;
    requestPricing: Array<{ provider: string } & RequestPrice>;
  };
}

/** Report query, validated by the controller. */
export interface ScrapeCostQuery {
  from: string; // "YYYY-MM"
  to: string; // "YYYY-MM"
  groupBy: ScrapeCostGroupBy;
  kind?: ScrapeRunKind;
}

/** Duck-typed Timestamp check (survives a second SDK copy). */
function isTs(v: unknown): v is { toMillis(): number } {
  return Boolean(v) && typeof (v as { toMillis?: unknown }).toMillis === "function";
}

/** A finite, non-negative price. */
function isPrice(v: unknown): boolean {
  return typeof v === "number" && Number.isFinite(v) && v >= 0;
}

/** The three token prices of a rate, all usable. */
function isTokenPrices(v: unknown): boolean {
  const p = v as Record<string, unknown> | null;
  return Boolean(p) && typeof p === "object" && isPrice(p!.inputPer1M) && isPrice(p!.cachedInputPer1M) && isPrice(p!.outputPer1M);
}

/** An integer in [min, max]. */
function isIntIn(v: unknown, min: number, max: number): boolean {
  return typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;
}

/** One peak window: 0 <= startHour < endHour <= 24, ISO weekdays 1..7 (non-empty). */
function isHourWindow(v: unknown): boolean {
  const w = v as Record<string, unknown> | null;
  if (!w || typeof w !== "object") return false;
  return (
    isIntIn(w.startHour, 0, 23) &&
    isIntIn(w.endHour, 1, 24) &&
    (w.startHour as number) < (w.endHour as number) &&
    Array.isArray(w.isoWeekdays) &&
    w.isoWeekdays.length > 0 &&
    w.isoWeekdays.every((d) => isIntIn(d, 1, 7))
  );
}

/**
 * Shape check of a stored price table (#82 review: strict). Every model needs
 * finite, non-negative peak prices, a sourceUrl and an effectiveFrom; an
 * `offPeak` rate (when present) needs the same three prices, and then
 * `peakWindowsUtc` must be a valid window list (else nothing would ever be
 * peak); `aliases` must be strings. requestPricing entries need a finite
 * perRequestUsd. A doc that fails is NOT used: loadPricing falls back to
 * DEFAULT_LLM_PRICING with a console.error, so a bad edit can never turn
 * into NaN -> a silent $0.
 */
export function isValidPricingDoc(raw: unknown): raw is LlmPricingDoc {
  if (!raw || typeof raw !== "object") return false;
  const doc = raw as { models?: unknown; requestPricing?: unknown };
  if (!doc.models || typeof doc.models !== "object") return false;
  const modelsOk = Object.values(doc.models as Record<string, unknown>).every((m) => {
    const p = m as Record<string, unknown> | null;
    if (!p || typeof p !== "object" || !isTokenPrices(p)) return false;
    if (typeof p.sourceUrl !== "string" || typeof p.effectiveFrom !== "string") return false;
    if (p.aliases !== undefined && !(Array.isArray(p.aliases) && p.aliases.every((a) => typeof a === "string"))) return false;
    if (p.offPeak !== undefined) {
      if (!isTokenPrices(p.offPeak)) return false;
      if (!Array.isArray(p.peakWindowsUtc) || !p.peakWindowsUtc.every(isHourWindow)) return false;
    } else if (p.peakWindowsUtc !== undefined && !(Array.isArray(p.peakWindowsUtc) && p.peakWindowsUtc.every(isHourWindow))) {
      return false;
    }
    return true;
  });
  if (!modelsOk) return false;
  if (doc.requestPricing !== undefined) {
    if (!doc.requestPricing || typeof doc.requestPricing !== "object") return false;
    const ok = Object.values(doc.requestPricing as Record<string, unknown>).every(
      (r) => Boolean(r) && typeof r === "object" && isPrice((r as Record<string, unknown>).perRequestUsd)
    );
    if (!ok) return false;
  }
  return true;
}

/**
 * Add one finalised run into a month doc (pure; `existing` is the stored doc
 * or undefined). Adds the run's `usage` to `totals` and `byKind[kind]`, and
 * its `costBreakdown` maps to the overall and per-kind country / model maps.
 */
export function mergeRunIntoMonth(
  existing: unknown,
  run: Pick<ScrapeRunDoc, "kind" | "usage" | "costBreakdown">,
  month: string,
  updatedAt: Timestamp
): ScrapeCostMonthDoc {
  const prev = (existing ?? {}) as Partial<ScrapeCostMonthDoc>;
  const runTotals = normalizeTotals(run.usage);
  const doc: ScrapeCostMonthDoc = {
    month,
    totals: addTotals(normalizeTotals(prev.totals), runTotals),
    byKind: {},
    byCountry: addTotalsMap(normalizeMap(prev.byCountry), run.costBreakdown?.byCountry),
    byModel: addTotalsMap(normalizeMap(prev.byModel), run.costBreakdown?.byModel),
    updatedAt,
  };
  // Carry every stored kind over unchanged, then add this run to its own.
  for (const k of SCRAPE_RUN_KINDS) {
    const stored = prev.byKind?.[k];
    if (stored) doc.byKind[k] = normalizeKind(stored);
  }
  const mine = doc.byKind[run.kind] ?? normalizeKind(undefined);
  addTotals(mine, runTotals);
  addTotalsMap(mine.byCountry, run.costBreakdown?.byCountry);
  addTotalsMap(mine.byModel, run.costBreakdown?.byModel);
  doc.byKind[run.kind] = mine;
  return doc;
}

/** Normalise a stored totals map (drops malformed entries' bad fields). */
function normalizeMap(raw: unknown): Record<string, CostTotals> {
  if (!raw || typeof raw !== "object") return {};
  return Object.fromEntries(Object.entries(raw as Record<string, unknown>).map(([k, v]) => [k, normalizeTotals(v)]));
}

/** Normalise a stored per-kind bucket. */
function normalizeKind(raw: unknown): KindCostTotals {
  const r = (raw ?? {}) as Partial<KindCostTotals>;
  return { ...normalizeTotals(r), byCountry: normalizeMap(r.byCountry), byModel: normalizeMap(r.byModel) };
}

/** Totals of a month doc for `kind` (all kinds when undefined). */
function monthTotals(doc: Partial<ScrapeCostMonthDoc> | undefined, kind?: ScrapeRunKind): CostTotals {
  if (!doc) return emptyTotals();
  return normalizeTotals(kind ? doc.byKind?.[kind] : doc.totals);
}

export class ScrapeCostService {
  /** Transaction runner (the rollup). Swapped for the in-memory one in tests. */
  runTransaction: <T>(fn: (tx: Transaction) => Promise<T>) => Promise<T> = (fn) => db.runTransaction(fn);

  /** Real clock (ms). Swappable in tests. */
  clock: () => number = Date.now;

  // ---------- Config ----------

  /**
   * The price table for this run: `appConfig/llmPricing` when it exists and
   * is well-formed, else DEFAULT_LLM_PRICING (logged). Never throws.
   */
  async loadPricing(): Promise<LoadedPricing> {
    try {
      const snap = await collections.appConfig.doc(LLM_PRICING_DOC_ID).get();
      if (snap.exists) {
        const data = snap.data();
        if (isValidPricingDoc(data)) return { pricing: data, origin: "config" };
        console.error("Scrape cost: appConfig/llmPricing is malformed; using the default price table");
      }
    } catch (err) {
      console.error(`Scrape cost: reading appConfig/llmPricing failed; using the default price table: ${safeErrorMessage(err)}`);
    }
    return { pricing: DEFAULT_LLM_PRICING, origin: "default" };
  }

  /**
   * Write DEFAULT_LLM_PRICING to `appConfig/llmPricing` when the doc is
   * absent (seed-all). Never overwrites an existing table. Returns true when
   * it wrote.
   */
  async seedPricingIfAbsent(): Promise<boolean> {
    const ref = collections.appConfig.doc(LLM_PRICING_DOC_ID);
    const snap = await ref.get();
    if (snap.exists) return false;
    await ref.set({ ...DEFAULT_LLM_PRICING, updatedAt: Timestamp.fromMillis(this.clock()) });
    return true;
  }

  /** `appConfig/scrapeBudget.monthlyUsd`, or null (absent / not a number / unreadable). */
  async loadBudgetUsd(): Promise<number | null> {
    try {
      const snap = await collections.appConfig.doc(SCRAPE_BUDGET_DOC_ID).get();
      const v = (snap.data() as Partial<ScrapeBudgetDoc> | undefined)?.monthlyUsd;
      return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
    } catch (err) {
      console.error(`Scrape cost: reading appConfig/scrapeBudget failed: ${safeErrorMessage(err)}`);
      return null;
    }
  }

  // ---------- Rollup ----------

  /**
   * Add a finalised run to `scrapeCosts/{month of startedAt}` once.
   * Returns true when it was added, false when it was already there or the
   * run carries no usage (a doc written before #82).
   */
  async applyRun(run: ScrapeRunDoc): Promise<boolean> {
    if (!run.usage || !isTs(run.startedAt)) return false;
    const month = monthKeyUtc(run.startedAt.toMillis());
    const monthRef = collections.scrapeCosts.doc(month);
    const markerRef = monthRef.collection("runs").doc(run.id);
    const runRef = collections.scrapeRuns.doc(run.id);
    return this.runTransaction(async (tx) => {
      // Reads first (Firestore transactions: all reads before writes).
      const marker = await tx.get(markerRef);
      const runSnap = await tx.get(runRef);
      // Flag the run doc as rolled up (#82 review: the backfill's query key),
      // in the SAME transaction as the marker, so the two never disagree.
      const flagRun = () => {
        if (runSnap.exists && (runSnap.data() as Partial<ScrapeRunDoc>).costRolledUp !== true) {
          tx.update(runRef, { costRolledUp: true });
        }
      };
      if (marker.exists) {
        // Already counted (idempotent per runId). Still flag the run, e.g. a
        // late finalize after a stale sweep rewrote costRolledUp: false.
        flagRun();
        return false;
      }
      const current = await tx.get(monthRef);
      const now = Timestamp.fromMillis(this.clock());
      const merged = mergeRunIntoMonth(current.exists ? current.data() : undefined, run, month, now);
      tx.set(monthRef, merged);
      tx.set(markerRef, { runId: run.id, kind: run.kind, costUsd: run.costUsd ?? 0, appliedAt: now });
      flagRun();
      return true;
    });
  }

  /**
   * Backfill one UTC month (#82 review): re-apply FINISHED runs whose rollup
   * failed. Finalize writes `costRolledUp: false` and applyRun sets it true,
   * so the query `costRolledUp == false AND startedAt in month` finds only
   * runs whose hook failed (normally none: an empty, indexed query). Each is
   * re-applied through applyRun, whose marker keeps it idempotent. Bounded
   * at `max` runs per call (oldest first); the rest wait for the next call.
   * Index: scrapeRuns (costRolledUp ASC, startedAt ASC). Never throws;
   * returns how many runs were added.
   */
  async backfillMonth(month: string, max: number = ROLLUP_BACKFILL_MAX_RUNS): Promise<number> {
    try {
      const startMs = Date.parse(`${month}-01T00:00:00Z`);
      const endMs = Date.parse(`${addMonths(month, 1)}-01T00:00:00Z`);
      const snap = await collections.scrapeRuns
        .where("costRolledUp", "==", false)
        .where("startedAt", ">=", Timestamp.fromMillis(startMs))
        .where("startedAt", "<", Timestamp.fromMillis(endMs))
        .orderBy("startedAt", "asc")
        .limit(max)
        .get();
      let added = 0;
      for (const d of snap.docs) {
        const run = { ...(d.data() as ScrapeRunDoc), id: d.id };
        // Only finalised runs (finalize is what sets costRolledUp at all).
        if (run.status === "running") continue;
        try {
          if (await this.applyRun(run)) added++;
        } catch (err) {
          console.error(`Scrape cost: backfill of run ${d.id} failed (retried next pass): ${safeErrorMessage(err)}`);
        }
      }
      if (added > 0) console.warn(`Scrape cost: backfilled ${added} run(s) into scrapeCosts/${month}`);
      return added;
    } catch (err) {
      console.error(`Scrape cost: backfill of ${month} failed: ${safeErrorMessage(err)}`);
      return 0;
    }
  }

  /**
   * Backfill the current and the previous UTC month (a run finalised just
   * after midnight on the 1st belongs to the previous month). Called at the
   * start of every hourly visa orchestrator tick (and, later, by #83's hourly
   * check). Never throws; returns the number of runs added.
   */
  async backfillRecent(nowMs: number = this.clock()): Promise<number> {
    const current = monthKeyUtc(nowMs);
    return (await this.backfillMonth(addMonths(current, -1))) + (await this.backfillMonth(current));
  }

  // ---------- #83 reader (STABLE SHAPE) ----------

  /**
   * Month-to-date spend for the UTC month containing `nowMs`, with the
   * budget. For #83's budget alert. Reads 2 docs. Throws on a Firestore read
   * failure (the caller decides whether to alert on that).
   */
  async monthToDate(nowMs: number = this.clock()): Promise<ScrapeCostMonthToDate> {
    const month = monthKeyUtc(nowMs);
    const [snap, budgetUsd] = await Promise.all([collections.scrapeCosts.doc(month).get(), this.loadBudgetUsd()]);
    const doc = snap.exists ? (snap.data() as Partial<ScrapeCostMonthDoc>) : undefined;
    const totals = monthTotals(doc);
    const byKind: ScrapeCostMonthToDate["byKind"] = {};
    for (const k of SCRAPE_RUN_KINDS) {
      if (doc?.byKind?.[k]) byKind[k] = monthTotals(doc, k);
    }
    return {
      month,
      costUsd: totals.costUsd,
      budgetUsd,
      budgetUsedFraction: budgetUsd && budgetUsd > 0 ? roundUsd(totals.costUsd / budgetUsd) : null,
      totals,
      byKind,
      updatedAt: isTs(doc?.updatedAt) ? new Date(doc!.updatedAt!.toMillis()).toISOString() : null,
    };
  }

  // ---------- Admin report ----------

  /** GET /admin/scrape-costs (query validated by the controller). Reads <= 24 + 3 docs. */
  async report(q: ScrapeCostQuery): Promise<ScrapeCostReport> {
    const months = monthsBetween(q.from, q.to);
    const [snaps, loaded, mtd] = await Promise.all([
      Promise.all(months.map((m) => collections.scrapeCosts.doc(m).get())),
      this.loadPricing(),
      this.monthToDate(),
    ]);
    const docs = snaps.map((s) => (s.exists ? (s.data() as Partial<ScrapeCostMonthDoc>) : undefined));

    // ---- Groups ----
    const totals = emptyTotals();
    for (const d of docs) addTotals(totals, monthTotals(d, q.kind));
    let groups: ScrapeCostGroup[];
    if (q.groupBy === "month") {
      groups = months.map((m, i) => ({ key: m, ...monthTotals(docs[i], q.kind) }));
    } else {
      const acc: Record<string, CostTotals> = {};
      for (const d of docs) {
        if (!d) continue;
        if (q.groupBy === "kind") {
          for (const k of q.kind ? [q.kind] : SCRAPE_RUN_KINDS) {
            if (d.byKind?.[k]) acc[k] = addTotals(acc[k] ?? emptyTotals(), monthTotals(d, k));
          }
        } else {
          // country / model: per kind when filtered, else the all-kinds maps.
          const source = q.kind ? d.byKind?.[q.kind] : d;
          const map = q.groupBy === "country" ? source?.byCountry : source?.byModel;
          addTotalsMap(acc, map);
        }
      }
      groups = Object.entries(acc)
        .map(([key, t]) => ({ key, ...t }))
        .sort((a, b) => b.costUsd - a.costUsd || a.key.localeCompare(b.key));
    }

    return {
      from: q.from,
      to: q.to,
      groupBy: q.groupBy,
      kind: q.kind ?? null,
      currency: "USD",
      groups,
      totals,
      budget: {
        monthlyUsd: mtd.budgetUsd,
        month: mtd.month,
        monthToDateUsd: mtd.costUsd,
        usedFraction: mtd.budgetUsedFraction,
        configPath: `appConfig/${SCRAPE_BUDGET_DOC_ID}.monthlyUsd`,
      },
      pricing: {
        origin: loaded.origin,
        configPath: `appConfig/${LLM_PRICING_DOC_ID}`,
        verifiedAt: loaded.pricing.verifiedAt,
        models: Object.entries(loaded.pricing.models).map(([model, p]) => ({ model, ...p })),
        requestPricing: Object.entries(loaded.pricing.requestPricing ?? {}).map(([provider, p]) => ({ provider, ...p })),
      },
    };
  }

  // ---------- Estimate basis ----------

  /**
   * Average recorded usage per extraction over the newest
   * ESTIMATE_HISTORY_RUNS visa runs (kind+startedAt index). null when none
   * recorded usage yet.
   */
  async averageVisaUsage(limitRuns = ESTIMATE_HISTORY_RUNS): Promise<AverageUsage | null> {
    const snap = await collections.scrapeRuns
      .where("kind", "==", "visa")
      .orderBy("startedAt", "desc")
      .limit(limitRuns)
      .get();
    return averageUsageOf(snap.docs.map((d) => (d.data() as Partial<ScrapeRunDoc>).usage));
  }
}

export const scrapeCostService = new ScrapeCostService();

// ============================================
// FINALIZE HOOK (installed at module load)
// ============================================

/** Run services that already have the rollup hook (idempotent install). */
const hooked = new WeakSet<ScrapeRunService>();

/**
 * Register the monthly-rollup hook on `runs` (once per service instance).
 * Installed below for the singleton; every scraper path that records cost
 * (visa crawl, news scraper, the crawl script) imports this module, so the
 * hook is in place whenever a run is finalised. Returns an unregister
 * function (tests), or a no-op when already installed.
 */
export function installScrapeCostHook(
  runs: ScrapeRunService = scrapeRunService,
  costs: ScrapeCostService = scrapeCostService
): () => void {
  if (hooked.has(runs)) return () => undefined;
  hooked.add(runs);
  const off = runs.registerFinalizeHook(async (run) => {
    await costs.applyRun(run);
  });
  return () => {
    off();
    hooked.delete(runs);
  };
}

installScrapeCostHook();
