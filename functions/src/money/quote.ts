import { Timestamp } from "firebase-admin/firestore";
import type { ChargeSnapshot, ExchangeRate, Money, Quote } from "../types/money";
import { convertUsdToLocal, makeMoney } from "./money";
import { MoneyError } from "./errors";
import { normalizeCurrencyCode } from "./currencies";
import type { RateService } from "./rate.service";

// ============================================
// quote() (issue #178)
// ============================================
//
// "What does this dollar price cost in that currency right now?"
//
// `quoteWithRate` is PURE: same inputs, same output, no clock, no I/O. It is
// what the unit tests with fixed rates exercise. `quote` fetches the rate
// from the rate service and then calls it; when the rate is stale or missing
// the rate service throws a typed MoneyError and quote() propagates it: it
// never returns a number it could not back with a fresh rate.
//
// The caller supplies a USD amount it read from OUR storage and a currency it
// resolved on the server (`resolveChargeCurrency`). Nothing here accepts a
// client-supplied amount, currency or rate.

/** Price `usd` with an already-chosen rate. Pure. */
export function quoteWithRate(usd: Money, rate: ExchangeRate): Quote {
  if (usd.currency !== "USD") throw new MoneyError("INVALID_INPUT", "quote() prices a USD amount");
  const checked = makeMoney(usd.amountMinor, "USD");
  const local = convertUsdToLocal(checked, rate.rate, rate.currency, rate.marginBps);
  return {
    usd: checked,
    local,
    rate: rate.rate,
    asOf: rate.asOf,
    source: rate.source,
    marginBps: rate.marginBps,
  };
}

/** Price `usd` in `currency` at the current effective rate (typed error when none). */
export async function quote(usd: Money, currency: string, rates: RateService): Promise<Quote> {
  const code = normalizeCurrencyCode(currency);
  if (!code) throw new MoneyError("CURRENCY_UNSUPPORTED", `Currency "${String(currency)}" is not supported`);
  const rate = await rates.getRate(code);
  return quoteWithRate(usd, rate);
}

/**
 * The fields to store on a booking, payment request or transaction when a
 * quote is charged (names fixed by issue #178). `fxRate` is the raw rate; the
 * margin is stored separately in `fxMarginBps`.
 */
export function toChargeSnapshot(q: Quote): ChargeSnapshot {
  return {
    priceUsdCents: q.usd.amountMinor,
    chargedCurrency: q.local.currency,
    chargedAmountMinor: q.local.amountMinor,
    fxRate: q.rate,
    fxRateAsOf: Timestamp.fromDate(new Date(q.asOf)),
    fxRateSource: q.source,
    fxMarginBps: q.marginBps,
  };
}
