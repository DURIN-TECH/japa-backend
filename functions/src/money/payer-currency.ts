import type { CurrenciesConfig, CurrencyCode } from "../types/money";
import { resolveChargeCurrency } from "./config";
import { collections } from "../utils/firebase";

// ============================================
// WHICH CURRENCY A PERSON IS QUOTED AND CHARGED IN (issue #286)
// ============================================
//
// ONE rule for both sides of a price:
//  - the reads that SHOW a local price (GET /agents*, /agencies/browse*,
//    /agencies/public/:slug: `loadLocalPricer` in local-price.ts), and
//  - the charge paths that CHARGE it (POST /consultations, payment requests:
//    `chargeCurrencyForPayer` in services/charge-checkout.service.ts).
// Before #286 each side carried its own copy of this logic; a change to one
// copy could quote a client in one currency and charge them in another.
//
// The rule:
//  - a signed-in person (`uid`): the currency mapped from their STORED
//    profile country (`resolveChargeCurrency`; an unmapped or missing
//    country gets the config's default currency);
//  - nobody signed in (no `uid`): the config's default currency (NGN).
// Never from a query string, header or body. A guest's typed email is never
// used to look a country up (that would tell an anonymous caller where an
// account holder lives).

/**
 * The stored profile country of a user (`users/<uid>.residentialCountry`),
 * or undefined when the user or the field does not exist. The production
 * reader both pricing runtimes default to; tests swap the runtime hook
 * instead of this function.
 *
 * @param uid the user's id (from a VERIFIED token, never from the request body)
 */
export async function readProfileCountry(uid: string): Promise<string | undefined> {
  const snap = await collections.users.doc(uid).get();
  return snap.exists ? (snap.data() as { residentialCountry?: string }).residentialCountry : undefined;
}

/**
 * The currency a person is quoted and charged in (the rule in the header).
 *
 * @param uid the signed-in person, or undefined for a guest
 * @param config the parsed currencies config (appConfig/currencies)
 * @param profileCountry how to read a user's stored country (injected so each
 *   caller keeps its own test hook; both default to `readProfileCountry`)
 * @throws whatever `profileCountry` throws; the caller decides (a read falls
 *   back to the default, a charge fails rather than guess)
 */
export async function payerCurrency(
  uid: string | undefined,
  config: CurrenciesConfig,
  profileCountry: (uid: string) => Promise<string | undefined>
): Promise<CurrencyCode> {
  if (!uid) return config.defaultCurrency;
  return resolveChargeCurrency(await profileCountry(uid), config);
}
