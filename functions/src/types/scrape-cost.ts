import type { Timestamp } from "firebase-admin/firestore";
import type { ScrapeRunKind } from "./scrape-run";

// ============================================
// SCRAPE COST — LLM token usage, prices, budget, monthly rollup (issue #82)
// ============================================
//
// Shapes for what scraping costs:
//
//   - LlmUsage           : the token counts ONE LLM call reported (copied from
//                          the provider's `usage` object, never estimated).
//   - LlmPricingDoc      : `appConfig/llmPricing`, the price table (per model,
//                          USD per 1M tokens, quoted from the provider's
//                          published pricing page, with its URL + effectiveFrom).
//   - ScrapeBudgetDoc    : `appConfig/scrapeBudget`, our monthly budget (a
//                          policy, kept apart from the provider's facts).
//   - CostTotals         : one bucket of summed usage + cost (per run, kind,
//                          country, model, month).
//   - ScrapeCostMonthDoc : `scrapeCosts/{YYYY-MM}`, the monthly rollup the
//                          finalize hook keeps (idempotent per runId).
//   - ScrapeCostMonthToDate : the stable shape #83 (budget alerts) reads via
//                          scrapeCostService.monthToDate(). DO NOT change it
//                          without telling #83's owner.
//
// Everything is backend-only: firestore.rules has no match for appConfig or
// scrapeCosts, so clients are denied; admins read through /admin/scrape-costs.

// ----- Per-call usage -----

/**
 * Token usage of ONE LLM call, as the provider returned it (DeepSeek's
 * OpenAI-compatible `usage` object, see parseDeepSeekUsage). Counts only:
 * cost is computed separately from the price table.
 */
export interface LlmUsage {
  promptTokens: number; // usage.prompt_tokens (input, cache hit + miss)
  completionTokens: number; // usage.completion_tokens (output)
  cacheHitTokens: number; // usage.prompt_cache_hit_tokens (billed at the cached-input price)
  cacheMissTokens: number; // usage.prompt_cache_miss_tokens (or prompt - hit when absent)
  totalTokens: number; // usage.total_tokens (or prompt + completion)
}

/**
 * What an extractor reports through ExtractContext.onUsage after each API
 * call (successful or not: a call whose output then fails validation was
 * still billed).
 */
export interface LlmUsageReport {
  usage: LlmUsage;
  model: string; // the model name we REQUESTED (e.g. "deepseek-chat")
  responseModel?: string; // the model the API says served it, when given
  atMs: number; // when the response arrived (prices can depend on the hour)
}

// ----- Price table: appConfig/llmPricing -----

/** USD prices per 1M tokens for one rate (peak, or off-peak). */
export interface LlmTokenPrices {
  inputPer1M: number; // input, cache MISS
  cachedInputPer1M: number; // input, cache HIT
  outputPer1M: number; // output
}

/**
 * A daily UTC hour window [startHour, endHour) on the given ISO weekdays
 * (1 = Monday ... 7 = Sunday). Used for DeepSeek's peak hours.
 */
export interface UtcHourWindow {
  startHour: number; // 0..23, inclusive
  endHour: number; // 1..24, exclusive
  isoWeekdays: number[]; // 1 = Monday ... 7 = Sunday
}

/**
 * One model's prices. The top-level prices are the STANDARD (peak) rate.
 * When the provider has a cheaper off-peak rate, `offPeak` holds it and
 * `peakWindowsUtc` says when the standard rate applies; a call outside every
 * peak window is billed at `offPeak`. Without `offPeak`, one flat rate.
 */
export interface LlmModelPrice extends LlmTokenPrices {
  // Other model names billed at this price (e.g. "deepseek-chat" is served
  // by, and billed as, deepseek-flash). Looked up case-insensitively.
  aliases?: string[];
  offPeak?: LlmTokenPrices;
  peakWindowsUtc?: UtcHourWindow[];
  // ISO date (or date-time) the provider's current prices took effect.
  effectiveFrom: string;
  // The provider's published pricing page the numbers were copied from.
  sourceUrl: string;
  // Free text: anything about the quote a reader needs (exclusions, holidays).
  note?: string;
}

/** Per-request price of a non-LLM API (news providers), when the plan has one. */
export interface RequestPrice {
  perRequestUsd: number;
  effectiveFrom: string;
  sourceUrl: string;
  note?: string;
}

/** The `appConfig/llmPricing` document. */
export interface LlmPricingDoc {
  currency: "USD";
  // Model name (as requested from the API) -> its prices.
  models: Record<string, LlmModelPrice>;
  // News API provider ("newsdata" / "newsapi") -> per-request price. Only
  // for a plan that actually charges per call; absent => requests are
  // counted, not costed.
  requestPricing?: Record<string, RequestPrice>;
  // When someone last checked the numbers against the provider's page.
  verifiedAt: string;
  updatedAt?: Timestamp;
}

/** Where a loaded price table came from. */
export type PricingOrigin = "config" | "default";

// ----- Budget: appConfig/scrapeBudget -----

/**
 * The `appConfig/scrapeBudget` document: our monthly spend budget for
 * scraping (LLM + priced API calls), in USD. Absent doc or null => no budget.
 * Kept OUT of llmPricing on purpose: prices are the provider's facts (copied
 * from its page), the budget is our policy (set by an admin), and they change
 * for different reasons.
 */
export interface ScrapeBudgetDoc {
  monthlyUsd: number | null;
  updatedAt?: Timestamp;
  updatedBy?: string;
}

// ----- Aggregates -----

/**
 * One bucket of summed usage and cost. Used per run (`costBreakdown`), per
 * kind / country / model inside a month, and as API group rows.
 */
export interface CostTotals {
  runs: number; // runs contributing (0 inside a per-run breakdown)
  extractions: number; // LLM calls (each reported usage)
  unpricedExtractions: number; // calls whose model had no price: tokens counted, cost not
  promptTokens: number;
  completionTokens: number;
  cacheHitTokens: number;
  cacheMissTokens: number;
  costUsd: number; // LLM cost + priced API requests
  requests: Record<string, number>; // news API requests per provider
}

/** Per-run cost split by country (visa sourceId) and model (run doc `costBreakdown`). */
export interface RunCostBreakdown {
  byCountry: Record<string, CostTotals>;
  byModel: Record<string, CostTotals>;
}

/** One kind inside a month: its totals plus its own country / model split. */
export type KindCostTotals = CostTotals & RunCostBreakdown;

/**
 * The `scrapeCosts/{YYYY-MM}` document (UTC month of each run's startedAt).
 * Each finalised run is added ONCE (marker doc `scrapeCosts/{month}/runs/{runId}`
 * written in the same transaction). `byCountry` / `byModel` sum every kind;
 * `byKind[kind].byCountry` / `.byModel` are per kind (the API's `kind` filter).
 */
export interface ScrapeCostMonthDoc {
  month: string; // "2026-11"
  totals: CostTotals;
  byKind: Partial<Record<ScrapeRunKind, KindCostTotals>>;
  byCountry: Record<string, CostTotals>;
  byModel: Record<string, CostTotals>;
  updatedAt: Timestamp;
}

/**
 * STABLE reader shape for #83 (budget alerts): scrapeCostService.monthToDate().
 * Plain JSON (ISO dates), safe to log or return from an API.
 */
export interface ScrapeCostMonthToDate {
  month: string; // UTC month, "2026-11"
  costUsd: number; // month-to-date spend (0 when nothing ran yet)
  budgetUsd: number | null; // appConfig/scrapeBudget.monthlyUsd; null = no budget set
  budgetUsedFraction: number | null; // costUsd / budgetUsd (null without a budget, or budget 0)
  totals: CostTotals;
  byKind: Partial<Record<ScrapeRunKind, CostTotals>>;
  updatedAt: string | null; // last rollup write (ISO), null when no doc yet
}
