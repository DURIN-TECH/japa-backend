import { firestoreConfigStore, firestoreRateStore } from "./stores";
import { RateService } from "./rate.service";
import { CbnRateProvider } from "./providers/cbn.provider";
import { OandaRateProvider } from "./providers/oanda.provider";

// ============================================
// MONEY MODULE ENTRY (issue #178)
// ============================================

export * from "./currencies";
export * from "./errors";
export * from "./money";
export * from "./config";
export * from "./quote";
export { RateService } from "./rate.service";
// Issue #179: dollar price input/stored reading and the local figure on reads.
export * from "./usd-price";
export * from "./local-price";
// Issue #286: the one quote/charge currency rule (replaces the unused
// `resolveChargeCurrencyForUser`, a third copy of it).
export * from "./payer-currency";

/**
 * Secrets the scheduled rate refresh binds. EMPTY on purpose: the default
 * provider (CBN) needs none, and binding a secret that does not exist in
 * Secret Manager fails the whole deploy. If the owner buys an OANDA plan:
 * `firebase functions:secrets:set OANDA_API_KEY` first, then add
 * "OANDA_API_KEY" here (and set `provider: "oanda"` in appConfig/currencies).
 * Never put a key value in git or in an .env example.
 */
export const FX_RATE_SECRETS: string[] = [];

/** The production rate service, wired to Firestore and the real providers. */
export const rateService = new RateService({
  config: firestoreConfigStore,
  rates: firestoreRateStore,
  providers: { cbn: new CbnRateProvider(), oanda: new OandaRateProvider() },
});
