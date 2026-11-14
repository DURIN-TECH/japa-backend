import type { CurrencyCode, Money } from "../types/money";
import { getCurrencyInfo, minorUnitFactor, normalizeCurrencyCode } from "./currencies";
import { MoneyError } from "./errors";

// ============================================
// MONEY HELPERS (issue #178)
// ============================================
//
// All money arithmetic is integer arithmetic (BigInt inside, safe integers at
// the edges). No floating-point number ever holds an amount. The only floats
// are RATES, and a rate is turned into a scaled integer before it is used.
//
// ROUNDING RULE (one place, one function: `convertUsdToLocal`):
//   local minor units = USD cents x rate x (10000 + marginBps) / 10000,
//   expressed in the target currency's minor unit, ROUNDED HALF UP (a result
//   exactly halfway between two minor units goes to the higher one) ONCE, at
//   the end. There is no intermediate rounding. Amounts are never negative
//   here, so half-up needs no sign rule.

/** Rates are held as integers scaled by 10^RATE_SCALE (6 decimals of rate). */
export const RATE_SCALE = 6;
const RATE_SCALE_FACTOR = 10n ** BigInt(RATE_SCALE);
/** Basis points per 100% (10000 bps = 1.0). */
const BPS_DENOMINATOR = 10_000n;
/** Largest rate accepted anywhere (sanity bound; 1 USD never buys 1e9 units). */
export const MAX_RATE = 1_000_000_000;

// ---------- construction ----------

/** Build a Money, checking the currency is known and the amount a safe integer >= 0. */
export function makeMoney(amountMinor: number, currency: CurrencyCode): Money {
  const code = normalizeCurrencyCode(currency);
  if (!code || !getCurrencyInfo(code)) {
    throw new MoneyError("CURRENCY_UNSUPPORTED", `Unknown currency "${String(currency)}"`);
  }
  if (!Number.isSafeInteger(amountMinor) || amountMinor < 0) {
    throw new MoneyError("INVALID_INPUT", "Amount must be a non-negative integer number of minor units");
  }
  return { amountMinor, currency: code };
}

/**
 * Parse a decimal amount in MAJOR units ("12.50", or the number 12.5) into
 * Money. Strict: more decimals than the currency has is an error (never a
 * silent round), and a number whose text form is not a plain decimal
 * (1e21, NaN) is refused. The factor comes from the currency table.
 */
export function fromMajor(major: string | number, currency: CurrencyCode): Money {
  const code = normalizeCurrencyCode(currency);
  const info = code ? getCurrencyInfo(code) : undefined;
  if (!code || !info) {
    throw new MoneyError("CURRENCY_UNSUPPORTED", `Unknown currency "${String(currency)}"`);
  }
  const text = typeof major === "number" ? (Number.isFinite(major) ? String(major) : "") : String(major).trim();
  const m = /^(\d+)(?:\.(\d+))?$/.exec(text);
  if (!m) throw new MoneyError("INVALID_INPUT", "Amount must be a plain decimal number");
  const whole = m[1];
  const fraction = m[2] ?? "";
  if (fraction.length > info.exponent) {
    throw new MoneyError("INVALID_INPUT", `${code} has ${info.exponent} decimal places`);
  }
  // Pad the fraction to the currency's exponent, then the digits ARE the minor units.
  const minor = BigInt(whole + fraction.padEnd(info.exponent, "0"));
  return makeMoney(bigToSafeNumber(minor), code);
}

// ---------- reading ----------

/** Money -> decimal string in major units ("1234.56"; "1234" for a zero-exponent currency). */
export function toMajor(money: Money): string {
  const info = getCurrencyInfo(money.currency);
  if (!info) throw new MoneyError("CURRENCY_UNSUPPORTED", `Unknown currency "${money.currency}"`);
  if (!Number.isSafeInteger(money.amountMinor)) {
    throw new MoneyError("INVALID_INPUT", "Amount must be an integer number of minor units");
  }
  const negative = money.amountMinor < 0;
  const abs = BigInt(Math.abs(money.amountMinor));
  const factor = minorUnitFactor(money.currency);
  const whole = abs / factor;
  const fraction = (abs % factor).toString().padStart(info.exponent, "0");
  const body = info.exponent === 0 ? whole.toString() : `${whole}.${fraction}`;
  return negative ? `-${body}` : body;
}

/** Display string with symbol and thousands separators ("₦1,500,000.00", "$12.50"). */
export function format(money: Money): string {
  const info = getCurrencyInfo(money.currency);
  if (!info) throw new MoneyError("CURRENCY_UNSUPPORTED", `Unknown currency "${money.currency}"`);
  const major = toMajor(money);
  const negative = major.startsWith("-");
  const [whole, fraction] = (negative ? major.slice(1) : major).split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${negative ? "-" : ""}${info.symbol}${grouped}${fraction !== undefined ? `.${fraction}` : ""}`;
}

// ---------- rates ----------

/**
 * A rate as an integer scaled by 10^6. Rounds the rate itself to 6 decimals
 * (a rate is a published quotation, not money). Refuses non-positive,
 * non-finite or absurdly large values.
 */
export function scaleRate(rate: number): bigint {
  if (typeof rate !== "number" || !Number.isFinite(rate) || rate <= 0 || rate > MAX_RATE) {
    throw new MoneyError("INVALID_INPUT", "Rate must be a positive, finite number");
  }
  const scaled = BigInt(rate.toFixed(RATE_SCALE).replace(".", ""));
  if (scaled <= 0n) throw new MoneyError("INVALID_INPUT", "Rate is too small");
  return scaled;
}

/**
 * THE conversion: USD -> a local currency, rounded half up to the local
 * currency's minor unit, once. See the rounding rule at the top of the file.
 *
 *   local = usdCents / 10^usdExp  x  rate  x  (10000+bps)/10000  x  10^localExp
 */
export function convertUsdToLocal(usd: Money, rate: number, localCurrency: CurrencyCode, marginBps = 0): Money {
  if (usd.currency !== "USD") throw new MoneyError("INVALID_INPUT", "convertUsdToLocal needs a USD amount");
  if (!Number.isSafeInteger(usd.amountMinor) || usd.amountMinor < 0) {
    throw new MoneyError("INVALID_INPUT", "Amount must be a non-negative integer number of minor units");
  }
  if (!Number.isInteger(marginBps) || marginBps < 0 || marginBps > 10_000) {
    throw new MoneyError("INVALID_INPUT", "Margin must be a whole number of basis points between 0 and 10000");
  }
  const local = normalizeCurrencyCode(localCurrency);
  if (!local || !getCurrencyInfo(local)) {
    throw new MoneyError("CURRENCY_UNSUPPORTED", `Unknown currency "${String(localCurrency)}"`);
  }

  const numerator =
    BigInt(usd.amountMinor) * scaleRate(rate) * (BPS_DENOMINATOR + BigInt(marginBps)) * minorUnitFactor(local);
  const denominator = minorUnitFactor("USD") * RATE_SCALE_FACTOR * BPS_DENOMINATOR;

  // Half up: add half the denominator, then floor-divide (all values >= 0).
  const rounded = (numerator * 2n + denominator) / (denominator * 2n);
  return { amountMinor: bigToSafeNumber(rounded), currency: local };
}

/**
 * The reverse conversion: a LOCAL amount -> US cents at `rate` (local units
 * per 1 USD), rounded HALF UP to a whole cent, once, at the end (issue #179).
 *
 *   usdCents = localMinor / 10^localExp  /  rate  x  10^usdExp
 *
 * Used ONLY by the one-off price migration (naira prices -> dollars at the
 * owner-chosen rate). No margin: a migration restates a price, it does not
 * charge anyone. Same integer-only maths as `convertUsdToLocal` (the rate is
 * scaled to 6 decimals first), and the minor-unit factors come from the
 * currency table, never from a literal 100.
 */
export function convertLocalToUsd(local: Money, rate: number): Money {
  const code = normalizeCurrencyCode(local.currency);
  if (!code || !getCurrencyInfo(code)) {
    throw new MoneyError("CURRENCY_UNSUPPORTED", `Unknown currency "${String(local.currency)}"`);
  }
  if (!Number.isSafeInteger(local.amountMinor) || local.amountMinor < 0) {
    throw new MoneyError("INVALID_INPUT", "Amount must be a non-negative integer number of minor units");
  }
  // localMinor x 10^usdExp x 10^6  /  (10^localExp x rate x 10^6)
  const numerator = BigInt(local.amountMinor) * minorUnitFactor("USD") * RATE_SCALE_FACTOR;
  const denominator = minorUnitFactor(code) * scaleRate(rate);

  // Half up: add half the denominator, then floor-divide (all values >= 0).
  const rounded = (numerator * 2n + denominator) / (denominator * 2n);
  return { amountMinor: bigToSafeNumber(rounded), currency: "USD" };
}

/** BigInt -> number, refusing anything past Number.MAX_SAFE_INTEGER. */
function bigToSafeNumber(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new MoneyError("INVALID_INPUT", "Amount is too large");
  }
  return Number(value);
}
