import type { Money } from "../types/money";
import { normalizeCurrencyCode } from "./currencies";
import { fromMajor, toMajor } from "./money";
import { isMoneyError } from "./errors";

// ============================================
// DOLLAR PRICE INPUT + STORED-VALUE READING (issue #179)
// ============================================
//
// Agents and agency owners set prices in US DOLLARS ONLY (owner decision on
// #178). Every API that writes a price (PUT /agents/me, POST /agents,
// POST/PUT /agencies[/me] fee + services, PUT /agency/visa-prices/...) reads
// it with `parseUsdPriceInput`, so the rules are one function:
//
//   body value:  { "amount": "12.50" }               (a decimal string), or
//                { "amount": 12.5 }                  (a JSON number), and
//                optionally "currency": "USD"        (anything else is a 400)
//
//   - finite and not negative;
//   - whole cents: at most 2 decimals (the USD exponent from the currency
//     table; "12.505" is refused, never rounded);
//   - at most MAX_PRICE_USD_CENTS ($100,000.00): a bigger number is a typo;
//   - no other keys (an `amountMinor` or `rate` sent by a client is refused
//     rather than silently dropped, so a confused client sees a 400).
//
// The result is the stored shape, a `Money` `{ amountMinor, currency: "USD" }`.
// Major -> minor conversion happens in `fromMajor` (currency table), never
// with a literal 100 here.
//
// `readStoredUsd` is the tolerant READER of that stored shape: anything that
// is not a valid USD Money (missing, an old naira number from before the
// migration, a corrupt map) reads as null = "no price set", never as a guess.

/**
 * Largest price any agent or agency can set, in US cents ($100,000.00).
 * Documented in functions/docs/database-architecture.md and api.http.
 * Far inside Number.MAX_SAFE_INTEGER, so the integer checks stay exact.
 */
export const MAX_PRICE_USD_CENTS = 10_000_000;

/** The one stored currency for prices set by agents and agencies. */
export const PRICE_CURRENCY = "USD";

/** A refused price input. `field` names the body key for the 400 response. */
export class PriceInputError extends Error {
  constructor(
    readonly field: string,
    message: string
  ) {
    super(`${field}: ${message}`);
    this.name = "PriceInputError";
  }
}

/** Type guard that survives module duplication in tests. */
export function isPriceInputError(err: unknown): err is PriceInputError {
  return err instanceof PriceInputError || (err as { name?: string } | null)?.name === "PriceInputError";
}

/** The keys a price object may carry in a request body. */
const ALLOWED_INPUT_KEYS = new Set(["amount", "currency"]);

/**
 * Validate one dollar price from an untrusted request body (see the header).
 *
 * @param value the raw body value, e.g. `req.body.consultationFeeUsd`
 * @param field the body key, used in the error message
 * @returns the price as stored: `{ amountMinor, currency: "USD" }`
 * @throws PriceInputError for anything that is not a valid dollar price
 */
export function parseUsdPriceInput(value: unknown, field: string): Money {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PriceInputError(field, "send an object like { \"amount\": \"12.50\", \"currency\": \"USD\" }");
  }
  const record = value as Record<string, unknown>;

  // ---- No stray keys (amountMinor / rate / ... from a confused client) ----
  for (const key of Object.keys(record)) {
    if (!ALLOWED_INPUT_KEYS.has(key)) {
      throw new PriceInputError(field, `"${key}" is not accepted; send "amount" in US dollars`);
    }
  }

  // ---- Currency: optional, and US dollars only ----
  if (record.currency !== undefined && normalizeCurrencyCode(record.currency) !== PRICE_CURRENCY) {
    throw new PriceInputError(field, "prices are set in US dollars only (currency must be USD)");
  }

  // ---- Amount: a finite, non-negative decimal in whole cents ----
  const amount = record.amount;
  if (typeof amount === "number") {
    if (!Number.isFinite(amount)) throw new PriceInputError(field, "amount must be a finite number");
    if (amount < 0) throw new PriceInputError(field, "amount must be 0 or more");
  } else if (typeof amount === "string") {
    if (amount.trim().startsWith("-")) throw new PriceInputError(field, "amount must be 0 or more");
  } else {
    throw new PriceInputError(field, "amount is required, in US dollars (e.g. \"12.50\")");
  }

  let money: Money;
  try {
    // Strict: more decimals than USD has is an error, not a silent round.
    money = fromMajor(amount, PRICE_CURRENCY);
  } catch (err) {
    if (isMoneyError(err)) {
      throw new PriceInputError(field, "amount must be a dollar amount with at most 2 decimals (whole cents)");
    }
    throw err;
  }

  // ---- Cap ----
  if (money.amountMinor > MAX_PRICE_USD_CENTS) {
    const cap = toMajor({ amountMinor: MAX_PRICE_USD_CENTS, currency: PRICE_CURRENCY });
    throw new PriceInputError(field, `amount must be at most ${cap} US dollars`);
  }
  return money;
}

/**
 * Read a stored dollar price. Returns the Money only when the value is a
 * well-formed USD amount (`currency === "USD"`, a safe integer >= 0 of
 * cents); anything else (absent, a pre-migration naira number, another
 * currency, a corrupt map) is null. A copy is returned, so extra keys a doc
 * might carry never ride along to a response.
 */
export function readStoredUsd(value: unknown): Money | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (v.currency !== PRICE_CURRENCY) return null;
  if (typeof v.amountMinor !== "number" || !Number.isSafeInteger(v.amountMinor) || v.amountMinor < 0) return null;
  return { amountMinor: v.amountMinor, currency: PRICE_CURRENCY };
}

/** The zero-dollar price new agents start with (issue #179). */
export function zeroUsd(): Money {
  return { amountMinor: 0, currency: PRICE_CURRENCY };
}
