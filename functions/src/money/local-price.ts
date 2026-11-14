import type { CurrencyCode, ExchangeRate, LocalPriceQuote, Money } from "../types/money";
import { DEFAULT_CURRENCIES_CONFIG, resolveChargeCurrency } from "./config";
import { convertUsdToLocal } from "./money";
import { isMoneyError } from "./errors";
import type { RateService } from "./rate.service";
import { collections } from "../utils/firebase";

// ============================================
// LOCAL PRICE NEXT TO A DOLLAR PRICE, FOR READS (issue #179)
// ============================================
//
// Public reads (GET /agents, /agents/:id, /agencies/browse*, /agencies/public/
// :slug, the visa-price lists) return each stored dollar price together with
// what it costs in the viewer's local currency right now. This module builds
// that local figure.
//
// One rate lookup per REQUEST (not per agent / service): `loadLocalPricer`
// reads the config and the effective rate once, then `pricer.price(usd)` is a
// pure, synchronous conversion for every price in the response.
//
// NEVER FAILS A READ: if the rate is missing or stale (RATE_UNAVAILABLE /
// RATE_STALE), the currency is disabled, the config cannot be read, or the
// viewer's profile cannot be read, every quote comes back
// `{ available: false, amountMinor: null, rate: null, asOf: null }` and the
// dollar price is still returned by the caller. Typed money errors are
// expected states and are not logged; anything else is logged once.
//
// The maths is the same as the charge path (`convertUsdToLocal` with the
// effective rate and margin, rounded half up once), so the figure a client
// sees is the figure quote() would charge at that rate. A zero-dollar price
// shows as zero local (quote() refuses zero because it is for charging; a
// read only displays).
//
// Which currency: the viewer's, resolved on the SERVER from their stored
// profile country when the request is signed in (`uid`), else the config's
// default currency (NGN). Never from a query string or body.

/** Converts dollar prices for one response. */
export interface LocalPricer {
  /** The local currency every quote is in. */
  readonly currency: CurrencyCode;
  /** The local figure for `usd`, or an "unavailable" quote. Pure, never throws. */
  price(usd: Money): LocalPriceQuote;
}

/**
 * A pricer over an already-chosen rate (or none). Pure: the unit tests drive
 * it with fixed rates.
 *
 * @param currency the local currency the quotes are in
 * @param rate the effective rate for `currency`, or null when there is none
 */
export function pricerFromRate(currency: CurrencyCode, rate: ExchangeRate | null): LocalPricer {
  /** The one "unavailable" answer (dollar price only). */
  const unavailable = (): LocalPriceQuote => ({ amountMinor: null, currency, rate: null, asOf: null, available: false });
  return {
    currency,
    price(usd: Money): LocalPriceQuote {
      if (!rate) return unavailable();
      try {
        const local = convertUsdToLocal(usd, rate.rate, rate.currency, rate.marginBps);
        return { amountMinor: local.amountMinor, currency: local.currency, rate: rate.rate, asOf: rate.asOf, available: true };
      } catch {
        // A malformed stored amount (should never pass readStoredUsd) or an
        // overflow: show the dollar price only rather than fail the read.
        return unavailable();
      }
    },
  };
}

/**
 * Where `loadLocalPricer` gets the rate service and the viewer's country.
 * Swappable so unit tests run with in-memory rates and no Firestore.
 */
export const localPricing: {
  /** The rate service (the production one, wired to Firestore, by default). */
  rates: () => Promise<RateService>;
  /** The viewer's stored profile country, or undefined. */
  profileCountry: (uid: string) => Promise<string | undefined>;
} = {
  rates: async () => (await import("./index")).rateService,
  profileCountry: async (uid) => {
    const snap = await collections.users.doc(uid).get();
    return snap.exists ? (snap.data() as { residentialCountry?: string }).residentialCountry : undefined;
  },
};

/**
 * Load the rate once for this request and return a pricer. Never throws (see
 * the header): any failure gives a pricer whose quotes are all "unavailable".
 *
 * @param opts.uid the signed-in viewer, when there is one (their profile
 *   country picks the currency); omitted on anonymous routes
 */
export async function loadLocalPricer(opts: { uid?: string } = {}): Promise<LocalPricer> {
  let currency: CurrencyCode = DEFAULT_CURRENCIES_CONFIG.defaultCurrency;
  try {
    const service = await localPricing.rates();
    const config = await service.getConfig();
    currency = config.defaultCurrency;
    if (opts.uid) {
      // A profile read failure must not hide the price: fall back to the default.
      const country = await localPricing.profileCountry(opts.uid).catch(() => undefined);
      currency = resolveChargeCurrency(country, config);
    }
    const rate = await service.getRate(currency, config);
    return pricerFromRate(currency, rate);
  } catch (err) {
    if (!isMoneyError(err)) console.error("Local price lookup failed (dollar prices still served):", err);
    return pricerFromRate(currency, null);
  }
}
