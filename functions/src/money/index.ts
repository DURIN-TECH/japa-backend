import { firestoreConfigStore, firestoreRateStore } from "./stores";
import { RateService } from "./rate.service";
import { CbnRateProvider } from "./providers/cbn.provider";
import { OandaRateProvider } from "./providers/oanda.provider";
import { collections } from "../utils/firebase";
import { resolveChargeCurrency } from "./config";

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

/**
 * The charge currency for a user: from their stored profile country, never
 * from a request. See `resolveChargeCurrency` for the rules.
 */
export async function resolveChargeCurrencyForUser(uid: string): Promise<string> {
  const [config, snap] = await Promise.all([rateService.getConfig(), collections.users.doc(uid).get()]);
  const country = snap.exists ? (snap.data() as { residentialCountry?: string }).residentialCountry : undefined;
  return resolveChargeCurrency(country, config);
}
