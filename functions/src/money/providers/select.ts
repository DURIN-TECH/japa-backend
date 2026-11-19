import type { CurrenciesConfig } from "../../types/money";
import type { RateProvider } from "./types";

// ============================================
// PROVIDER SELECTION AND FALLBACK (issue #178)
// ============================================
//
// The order providers are tried in for one refresh:
//  - config.provider "oanda" AND the OANDA key exists  -> [oanda, cbn]
//    (cbn is the fallback when OANDA is down or does not cover the currency);
//  - anything else (the default "cbn", or "oanda" without a key) -> [cbn].
// An unconfigured provider is never in the list, so a missing key can never
// cause a request.

export function selectProviders(
  config: Pick<CurrenciesConfig, "provider">,
  providers: { cbn: RateProvider; oanda: RateProvider }
): RateProvider[] {
  const chain: RateProvider[] = [];
  if (config.provider === "oanda" && providers.oanda.isConfigured()) chain.push(providers.oanda);
  chain.push(providers.cbn);
  return chain.filter((p) => p.isConfigured());
}
