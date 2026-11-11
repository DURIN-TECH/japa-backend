import type { AiModelRole } from "./ai-models";
import type { LlmUsage } from "./llm-provider";

// ============================================
// AI PRICE TABLE — empty by default (issue #40)
// ============================================
//
// Token usage is always recorded exactly as the API reports it. A COST is
// only ever computed from this table, and the table ships EMPTY: no price is
// written in code until someone has confirmed it against the provider's
// published pricing and recorded the date here. A role with no entry has no
// cost (`null`), the same rule the scraper's price table follows for an
// unpriced model. Never guess a price to fill a gap.
//
// Keyed by ROLE (ai-models.ts), not by model id, so no model id is written
// outside that one module. When a role's model changes, re-confirm its entry.

/** Prices for one role's model, in USD per million tokens. */
export interface AiTokenPrices {
  inputPerMTok: number;
  outputPerMTok: number;
  cacheReadPerMTok: number;
  cacheWritePerMTok: number;
  // The date (YYYY-MM-DD) the figures were checked against the published
  // price list. Required: a price with no check date must not be added.
  checkedOn: string;
}

/** Role -> prices. Deliberately empty (see the header). */
export const AI_PRICES: Partial<Record<AiModelRole, AiTokenPrices>> = {};

/**
 * Cost of a usage record in USD, or null when the role has no price entry.
 *
 * @param prices the table to use (tests pass their own; default: AI_PRICES)
 */
export function costOfUsage(
  role: AiModelRole,
  usage: LlmUsage,
  prices: Partial<Record<AiModelRole, AiTokenPrices>> = AI_PRICES
): number | null {
  const p = prices[role];
  if (!p) return null;
  const usd =
    (usage.inputTokens * p.inputPerMTok +
      usage.outputTokens * p.outputPerMTok +
      usage.cacheReadTokens * p.cacheReadPerMTok +
      usage.cacheWriteTokens * p.cacheWritePerMTok) /
    1_000_000;
  // Six decimals: enough for sub-cent calls, no float noise in stored docs.
  return Math.round(usd * 1e6) / 1e6;
}
