// ============================================
// Test helper — fixed local-currency pricing for reads (issue #179). Not a test file.
// ============================================
//
// Public reads call `loadLocalPricer()` (src/money/local-price.ts), which by
// default asks the production rate service (Firestore). Suites that exercise
// those controllers call `useFixedRate(1500)` to price with an in-memory
// RateService at a known NGN rate, or `useFixedRate(null)` for "no rate
// stored" (every local figure must then be `available: false`). The returned
// `restore()` puts the production wiring back.

import { localPricing } from "../../src/money/local-price";
import { makeService } from "../money/helpers";

/** The clock every fixed-rate service runs at (the rate is dated the same day). */
export const FIXED_RATE_NOW = "2026-11-13T09:00:00Z";

/**
 * Price reads with an in-memory NGN rate.
 *
 * @param rate naira per USD, or null for "no rate stored" (RATE_UNAVAILABLE)
 * @param opts.countries uid -> profile country, for signed-in viewers
 * @returns restore() to undo
 */
export function useFixedRate(rate: number | null, opts: { countries?: Record<string, string> } = {}): () => void {
  const saved = { rates: localPricing.rates, profileCountry: localPricing.profileCountry };
  const { service, store } = makeService();
  if (rate !== null) {
    const at = new Date(FIXED_RATE_NOW);
    store.docs.set("NGN", {
      currency: "NGN",
      provider: { rate, asOf: at, fetchedAt: at, source: "cbn" },
      override: null,
      lastError: null,
    });
  }
  localPricing.rates = async () => service;
  localPricing.profileCountry = async (uid) => opts.countries?.[uid];
  return () => {
    localPricing.rates = saved.rates;
    localPricing.profileCountry = saved.profileCountry;
  };
}
