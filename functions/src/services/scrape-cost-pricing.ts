import type {
  CostTotals,
  LlmModelPrice,
  LlmPricingDoc,
  LlmTokenPrices,
  LlmUsage,
  LlmUsageReport,
  RunCostBreakdown,
} from "../types/scrape-cost";

// ============================================
// SCRAPE COST — pure pricing + aggregation helpers (issue #82)
// ============================================
//
// No Firestore here (the eval runner and unit tests import it without
// Firebase). The Firestore side (loading appConfig/llmPricing, the monthly
// rollup, the admin report) is scrape-cost.service.ts.
//
// Rules:
//  - Usage is ALWAYS the provider's own numbers (parseDeepSeekUsage reads the
//    API response's `usage` object). Nothing here estimates tokens, except
//    estimateReextractCost, which is explicitly an estimate from the average
//    of RECORDED usage.
//  - A price is NEVER guessed: a model with no entry in the price table
//    (by name or alias) gets no cost (`costUsd` undefined) and is counted as
//    `unpricedExtractions`, so a missing price is visible, not silently $0.
//  - cost = cacheMissTokens x inputPer1M + cacheHitTokens x cachedInputPer1M
//           + completionTokens x outputPer1M, all / 1,000,000.

/** DeepSeek's official "Models & Pricing" page (the source of every number below). */
export const DEEPSEEK_PRICING_URL = "https://api-docs.deepseek.com/quick_start/pricing";
/** DeepSeek's change log (model-name aliases and price-change dates). */
export const DEEPSEEK_UPDATES_URL = "https://api-docs.deepseek.com/updates";

/**
 * DeepSeek peak hours, quoted from DEEPSEEK_PRICING_URL (checked 2026-11-10):
 * "Peak hours are 01:00–04:00 and 06:00–10:00 UTC, Monday through Friday,
 * excluding Chinese public holidays." Off-peak rates are half the peak rates.
 * We do not keep a Chinese holiday calendar, so a call on such a holiday is
 * costed at the PEAK rate (an over-estimate, never an under-estimate).
 */
const DEEPSEEK_PEAK_WINDOWS = [
  { startHour: 1, endHour: 4, isoWeekdays: [1, 2, 3, 4, 5] },
  { startHour: 6, endHour: 10, isoWeekdays: [1, 2, 3, 4, 5] },
];

/**
 * The seed / fallback price table (written to `appConfig/llmPricing` by
 * seed-all when the doc is absent, and used when the doc cannot be read).
 * Every number is COPIED from DeepSeek's pricing page, not estimated:
 *
 *   https://api-docs.deepseek.com/quick_start/pricing (checked 2026-11-10)
 *   deepseek-flash (DeepSeek-V4.1-Flash-1017), USD per 1M tokens, peak / off-peak:
 *     input (cache hit)  $0.006 / $0.003
 *     input (cache miss) $0.30  / $0.15
 *     output             $1.20  / $0.60
 *
 * effectiveFrom 2026-09-10: the change log entry for V4.1 Flash says "API
 * prices have been reduced accordingly"; the 2026-10-17 entry (V4.1-Flash-1017)
 * says "The API calling method and pricing remain unchanged".
 *
 * Aliases: our extractor requests `deepseek-chat`. The change log (2026-04-24)
 * says "these two model names [deepseek-chat / deepseek-reasoner] point to the
 * non-thinking mode and thinking mode of deepseek-v4-flash", and the pricing
 * page says the legacy deepseek-v4-flash name is "served by
 * DeepSeek-V4.1-Flash-1017 and billed at the Flash price". So deepseek-chat
 * is billed at the deepseek-flash price.
 *
 * deepseek-v4-pro is NOT listed: we do not call it, and the page gives no
 * effective date for its current price. Add it (with its source) before
 * switching the extractor to it; until then a call to it is "unpriced".
 */
export const DEFAULT_LLM_PRICING: LlmPricingDoc = {
  currency: "USD",
  verifiedAt: "2026-11-10",
  models: {
    "deepseek-flash": {
      inputPer1M: 0.3,
      cachedInputPer1M: 0.006,
      outputPer1M: 1.2,
      offPeak: { inputPer1M: 0.15, cachedInputPer1M: 0.003, outputPer1M: 0.6 },
      peakWindowsUtc: DEEPSEEK_PEAK_WINDOWS,
      aliases: ["deepseek-chat", "deepseek-reasoner", "deepseek-v4-flash"],
      effectiveFrom: "2026-09-10",
      sourceUrl: DEEPSEEK_PRICING_URL,
      note:
        "Top-level prices are the peak rate; offPeak applies outside peakWindowsUtc. Chinese public " +
        "holidays (off-peak at DeepSeek) are costed at the peak rate. deepseek-chat -> deepseek-flash per " +
        DEEPSEEK_UPDATES_URL,
    },
  },
  // NewsData.io / NewsAPI: our plans have no per-call price, so requests are
  // counted only. Add an entry here (with its source) for a per-call plan.
  requestPricing: {},
};

// ----- Usage parsing -----

/** A non-negative integer from an unknown value, or undefined. */
function count(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.round(v) : undefined;
}

/**
 * Read the `usage` object of a DeepSeek (OpenAI-compatible) chat completion:
 *   { prompt_tokens, completion_tokens, total_tokens,
 *     prompt_cache_hit_tokens, prompt_cache_miss_tokens }
 * Returns undefined when there is no usable `prompt_tokens` /
 * `completion_tokens` (then nothing is recorded, rather than a made-up 0).
 * Missing cache fields: hit = 0, miss = prompt - hit (all input at the
 * cache-miss price, the higher one).
 */
export function parseDeepSeekUsage(raw: unknown): LlmUsage | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const u = raw as Record<string, unknown>;
  const promptTokens = count(u.prompt_tokens);
  const completionTokens = count(u.completion_tokens);
  if (promptTokens === undefined || completionTokens === undefined) return undefined;
  const cacheHitTokens = Math.min(count(u.prompt_cache_hit_tokens) ?? 0, promptTokens);
  const cacheMissTokens = count(u.prompt_cache_miss_tokens) ?? promptTokens - cacheHitTokens;
  const totalTokens = count(u.total_tokens) ?? promptTokens + completionTokens;
  return { promptTokens, completionTokens, cacheHitTokens, cacheMissTokens, totalTokens };
}

// ----- Price lookup -----

/** A model's price entry, found by name or alias (case-insensitive). */
export interface ResolvedModelPrice {
  priceKey: string; // the price-table key that matched ("deepseek-flash")
  price: LlmModelPrice;
}

/** Look up `model` in the price table (exact key, then aliases). undefined = unpriced. */
export function findModelPrice(pricing: LlmPricingDoc | undefined, model: string): ResolvedModelPrice | undefined {
  if (!pricing?.models || !model) return undefined;
  const want = model.trim().toLowerCase();
  for (const [key, price] of Object.entries(pricing.models)) {
    if (key.toLowerCase() === want) return { priceKey: key, price };
  }
  for (const [key, price] of Object.entries(pricing.models)) {
    if ((price.aliases ?? []).some((a) => a.toLowerCase() === want)) return { priceKey: key, price };
  }
  return undefined;
}

/** ISO weekday (1 = Monday ... 7 = Sunday) of a UTC instant. */
function isoWeekdayUtc(ms: number): number {
  const d = new Date(ms).getUTCDay(); // 0 = Sunday
  return d === 0 ? 7 : d;
}

/**
 * True when `atMs` is inside one of the price's peak windows (UTC). A price
 * without `offPeak` is flat: always "peak" (its only rate).
 */
export function isPeakAt(price: LlmModelPrice, atMs: number): boolean {
  if (!price.offPeak) return true;
  const windows = price.peakWindowsUtc ?? [];
  const hour = new Date(atMs).getUTCHours();
  const weekday = isoWeekdayUtc(atMs);
  return windows.some((w) => w.isoWeekdays.includes(weekday) && hour >= w.startHour && hour < w.endHour);
}

/** The token prices that apply at `atMs` (peak or off-peak). */
export function pricesAt(price: LlmModelPrice, atMs: number): LlmTokenPrices {
  return isPeakAt(price, atMs) || !price.offPeak ? price : price.offPeak;
}

/** Round a USD amount for storage (1e-8 USD; avoids float noise in sums). */
export function roundUsd(v: number): number {
  return Math.round(v * 1e8) / 1e8;
}

/** USD cost of `usage` at the given token prices. */
export function costAtPrices(usage: Pick<LlmUsage, "cacheHitTokens" | "cacheMissTokens" | "completionTokens">, p: LlmTokenPrices): number {
  return roundUsd(
    (usage.cacheMissTokens * p.inputPer1M + usage.cacheHitTokens * p.cachedInputPer1M + usage.completionTokens * p.outputPer1M) /
      1_000_000
  );
}

/** One call's usage with its cost (undefined when the model is unpriced). */
export interface PricedUsage {
  usage: LlmUsage;
  model: string; // requested model
  responseModel?: string;
  costUsd?: number; // undefined = no price for this model
  priceKey?: string; // the price-table entry used
  peak?: boolean; // which rate applied (only when priced)
}

/**
 * Price one usage report. The REQUESTED model is looked up first (that is
 * what we chose and what the table is keyed by), then the model the API says
 * served the call.
 */
export function priceUsageReport(report: LlmUsageReport, pricing: LlmPricingDoc | undefined): PricedUsage {
  const found =
    findModelPrice(pricing, report.model) ?? (report.responseModel ? findModelPrice(pricing, report.responseModel) : undefined);
  const out: PricedUsage = { usage: report.usage, model: report.model };
  if (report.responseModel) out.responseModel = report.responseModel;
  if (!found) return out;
  const peak = isPeakAt(found.price, report.atMs);
  out.costUsd = costAtPrices(report.usage, pricesAt(found.price, report.atMs));
  out.priceKey = found.priceKey;
  out.peak = peak;
  return out;
}

// ----- Totals -----

/** A zeroed CostTotals. */
export function emptyTotals(): CostTotals {
  return {
    runs: 0,
    extractions: 0,
    unpricedExtractions: 0,
    promptTokens: 0,
    completionTokens: 0,
    cacheHitTokens: 0,
    cacheMissTokens: 0,
    costUsd: 0,
    requests: {},
  };
}

/** Coerce a stored (possibly partial / older) totals map to a full CostTotals. */
export function normalizeTotals(raw: unknown): CostTotals {
  const t = emptyTotals();
  if (!raw || typeof raw !== "object") return t;
  const r = raw as Record<string, unknown>;
  const num = (k: keyof Omit<CostTotals, "requests">) => (typeof r[k] === "number" && Number.isFinite(r[k]) ? (r[k] as number) : 0);
  t.runs = num("runs");
  t.extractions = num("extractions");
  t.unpricedExtractions = num("unpricedExtractions");
  t.promptTokens = num("promptTokens");
  t.completionTokens = num("completionTokens");
  t.cacheHitTokens = num("cacheHitTokens");
  t.cacheMissTokens = num("cacheMissTokens");
  t.costUsd = num("costUsd");
  if (r.requests && typeof r.requests === "object") {
    for (const [k, v] of Object.entries(r.requests as Record<string, unknown>)) {
      if (typeof v === "number" && Number.isFinite(v)) t.requests[k] = v;
    }
  }
  return t;
}

/** Add `b` into `a` (mutates and returns `a`). */
export function addTotals(a: CostTotals, b: CostTotals): CostTotals {
  a.runs += b.runs;
  a.extractions += b.extractions;
  a.unpricedExtractions += b.unpricedExtractions;
  a.promptTokens += b.promptTokens;
  a.completionTokens += b.completionTokens;
  a.cacheHitTokens += b.cacheHitTokens;
  a.cacheMissTokens += b.cacheMissTokens;
  a.costUsd = roundUsd(a.costUsd + b.costUsd);
  for (const [k, v] of Object.entries(b.requests)) a.requests[k] = (a.requests[k] ?? 0) + v;
  return a;
}

/** Add one priced call into `t` (mutates). */
export function addPricedUsage(t: CostTotals, p: PricedUsage): CostTotals {
  t.extractions++;
  if (p.costUsd === undefined) t.unpricedExtractions++;
  t.promptTokens += p.usage.promptTokens;
  t.completionTokens += p.usage.completionTokens;
  t.cacheHitTokens += p.usage.cacheHitTokens;
  t.cacheMissTokens += p.usage.cacheMissTokens;
  t.costUsd = roundUsd(t.costUsd + (p.costUsd ?? 0));
  return t;
}

/** Add `b`'s map entries into `a`'s (mutates `a`). */
export function addTotalsMap(a: Record<string, CostTotals>, b: Record<string, CostTotals> | undefined): Record<string, CostTotals> {
  for (const [k, v] of Object.entries(b ?? {})) a[k] = addTotals(normalizeTotals(a[k]), normalizeTotals(v));
  return a;
}

/** An empty per-run breakdown. */
export function emptyBreakdown(): RunCostBreakdown {
  return { byCountry: {}, byModel: {} };
}

// ----- Months -----

/** UTC month key ("2026-11") of an epoch-ms instant. */
export function monthKeyUtc(ms: number): string {
  return new Date(ms).toISOString().slice(0, 7);
}

/** True for a "YYYY-MM" month key. */
export function isMonthKey(s: string): boolean {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(s);
}

/** Every month key from `from` to `to` inclusive, oldest first ([] when from > to). */
export function monthsBetween(from: string, to: string): string[] {
  const out: string[] = [];
  let [y, m] = from.split("-").map(Number);
  const [ty, tm] = to.split("-").map(Number);
  while (y < ty || (y === ty && m <= tm)) {
    out.push(`${y}-${String(m).padStart(2, "0")}`);
    m++;
    if (m > 12) {
      m = 1;
      y++;
    }
  }
  return out;
}

/** `month` shifted by `delta` months ("2026-01", -1 -> "2025-12"). */
export function addMonths(month: string, delta: number): string {
  const [y, m] = month.split("-").map(Number);
  const idx = y * 12 + (m - 1) + delta;
  return `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, "0")}`;
}

// ----- Re-extract estimate (prompt bump, #71) -----

/** Average recorded usage per extraction (from past runs' `usage`). */
export interface AverageUsage {
  extractions: number; // how many recorded calls the average is over
  promptTokens: number;
  completionTokens: number;
  cacheHitTokens: number;
  cacheMissTokens: number;
}

/** The estimate for re-extracting `pages` pages. */
export interface ReextractEstimate {
  pages: number;
  model: string;
  priceKey: string | null; // null = the model has no price (no USD estimate)
  basis: AverageUsage | null; // null = no recorded usage yet (no estimate)
  // USD, when both a price and a basis exist; otherwise null.
  perExtractionUsd: { peak: number; offPeak: number } | null;
  totalUsd: { peak: number; offPeak: number } | null;
  // Tokens the queue would use (pages x average), when a basis exists.
  estimatedTokens: { prompt: number; completion: number } | null;
  sourceUrl: string | null;
  effectiveFrom: string | null;
}

/**
 * "pages queued x average tokens x price": the cost of re-extracting `pages`
 * pages with `model`, from the average RECORDED usage per extraction. Gives a
 * peak and an off-peak figure (which applies depends on the hour of each
 * call; the scheduled visa crawl runs at local night, which can fall in
 * DeepSeek's UTC peak hours). Returns nulls instead of a guess when there is
 * no price or no recorded usage yet.
 */
export function estimateReextractCost(params: {
  pages: number;
  model: string;
  pricing: LlmPricingDoc | undefined;
  average: AverageUsage | null;
}): ReextractEstimate {
  const found = findModelPrice(params.pricing, params.model);
  const avg = params.average && params.average.extractions > 0 ? params.average : null;
  const est: ReextractEstimate = {
    pages: params.pages,
    model: params.model,
    priceKey: found?.priceKey ?? null,
    basis: avg,
    perExtractionUsd: null,
    totalUsd: null,
    estimatedTokens: avg
      ? { prompt: Math.round(avg.promptTokens * params.pages), completion: Math.round(avg.completionTokens * params.pages) }
      : null,
    sourceUrl: found?.price.sourceUrl ?? null,
    effectiveFrom: found?.price.effectiveFrom ?? null,
  };
  if (!found || !avg) return est;
  const peak = costAtPrices(avg, found.price);
  const offPeak = costAtPrices(avg, found.price.offPeak ?? found.price);
  est.perExtractionUsd = { peak, offPeak };
  est.totalUsd = { peak: roundUsd(peak * params.pages), offPeak: roundUsd(offPeak * params.pages) };
  return est;
}

/**
 * The average usage per extraction over recorded run usages (each the
 * `usage` map of a run doc). Runs without extractions are ignored; null when
 * no run recorded any.
 */
export function averageUsageOf(usages: Array<Partial<CostTotals> | undefined>): AverageUsage | null {
  const sum = emptyTotals();
  for (const u of usages) {
    const t = normalizeTotals(u);
    if (t.extractions <= 0) continue;
    addTotals(sum, t);
  }
  if (sum.extractions === 0) return null;
  const n = sum.extractions;
  return {
    extractions: n,
    promptTokens: sum.promptTokens / n,
    completionTokens: sum.completionTokens / n,
    cacheHitTokens: sum.cacheHitTokens / n,
    cacheMissTokens: sum.cacheMissTokens / n,
  };
}

// ----- Page-line fields -----

/**
 * The run record's per-page usage fields (ScrapeRunPageEntry.usage /
 * costUsd / model / promptVersion) for one priced call; {} when the page
 * made no LLM call. Only defined values (Firestore never sees `undefined`).
 */
export function pageUsageFields(
  p: PricedUsage | undefined,
  promptVersion: string
): { usage?: LlmUsage; costUsd?: number; model?: string; promptVersion?: string } {
  if (!p) return {};
  return {
    usage: { ...p.usage },
    ...(p.costUsd !== undefined ? { costUsd: p.costUsd } : {}),
    model: p.model,
    promptVersion,
  };
}
