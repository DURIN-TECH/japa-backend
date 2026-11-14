// ============================================
// Agency per-visa service price: input validation (issue #103)
// ============================================
//
// Pure functions (no I/O), unit-tested in test/agency-visa-prices/.
//
// MONEY UNIT (issue #179): prices are US DOLLARS. The body sends
// `{ "priceUsd": { "amount": "125.00", "currency": "USD" } }` and the doc
// stores the Money `{ amountMinor: 12500, currency: "USD" }`. The dollar ->
// cents step happens in `parseUsdPriceInput` (money/usd-price.ts, currency
// table), never with a literal 100 here. The old whole-naira `price` number
// is gone; sending it is a 400.
//
// Errors reuse `AgencyVisaError` from the agency visa module (#100), so every
// `/agency/...` endpoint answers with the same envelope:
// `{ success: false, error, message, field? }`.

import { AgencyVisaError } from "../agency-visas/agency-visa.validation";
import type { Money } from "../types/money";
import { isPriceInputError, MAX_PRICE_USD_CENTS, parseUsdPriceInput } from "../money/usd-price";

// ============================================
// Limits
// ============================================

/**
 * Largest price an agency can set, in US cents: the one cap every dollar
 * price shares (MAX_PRICE_USD_CENTS, $100,000.00, issue #179). Anything above
 * it is treated as a typo and refused with 400.
 */
export const MAX_VISA_SERVICE_PRICE_USD_CENTS = MAX_PRICE_USD_CENTS;

/** The one body key this endpoint accepts. */
const PRICE_FIELD = "priceUsd";

/** Longest visa id accepted in the path (Firestore ids are far shorter in practice). */
const MAX_VISA_ID_LENGTH = 200;

// ============================================
// Helpers
// ============================================

/** Shorthand for a 400 VALIDATION_ERROR naming `field`. */
function invalid(field: string, message: string): AgencyVisaError {
  return new AgencyVisaError("VALIDATION_ERROR", `${field}: ${message}`, 400, field);
}

/** A parsed `PUT` body: a price to store, or `null` to clear it. */
export interface ParsedVisaPriceBody {
  /** A validated dollar price (0..MAX_VISA_SERVICE_PRICE_USD_CENTS cents); null = clear it. */
  priceUsd: Money | null;
}

/** The visa a request targets: `countries/{countryCode}/visaTypes/{visaTypeId}`. */
export interface VisaPriceTarget {
  /** Upper-cased ISO 3166-1 alpha-2 code. */
  countryCode: string;
  visaTypeId: string;
}

// ============================================
// Body
// ============================================

/**
 * Validate the body of `PUT /agency/visa-prices/:countryCode/:visaTypeId`.
 *
 * Accepts exactly `{ priceUsd }` (issue #179):
 *  - a dollar price `{ amount: "125.00" | 125, currency?: "USD" }`, checked by
 *    `parseUsdPriceInput`: finite, >= 0, whole cents, at most the cap, USD
 *    only;
 *  - or `null`, which clears the price (same as DELETE).
 * Refused with 400 (field "priceUsd", nothing saved): a missing price, a
 * bare number, a string, a fraction of a cent, a negative, a too-large value
 * or another currency. Any other key (the old naira `price` included) is a
 * 400 UNKNOWN_FIELD, so tampering or a stale client is visible instead of
 * silently dropped.
 *
 * @param body the raw request body
 * @returns the parsed price (or null to clear)
 * @throws AgencyVisaError 400
 */
export function parseVisaPriceBody(body: unknown): ParsedVisaPriceBody {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw invalid(PRICE_FIELD, "send a JSON object like { \"priceUsd\": { \"amount\": \"125.00\", \"currency\": \"USD\" } }");
  }
  const record = body as Record<string, unknown>;

  // ---- Only `priceUsd` is accepted ----
  for (const key of Object.keys(record)) {
    if (key === "price") {
      // The retired naira field: say where it went.
      throw new AgencyVisaError(
        "UNKNOWN_FIELD",
        "price: was replaced by priceUsd (US dollars), e.g. { \"amount\": \"125.00\", \"currency\": \"USD\" }",
        400,
        key
      );
    }
    if (key !== PRICE_FIELD) {
      throw new AgencyVisaError("UNKNOWN_FIELD", `${key}: is not a field you can set here`, 400, key);
    }
  }
  if (!(PRICE_FIELD in record)) throw invalid(PRICE_FIELD, "is required (send null to clear it)");

  // ---- null clears ----
  if (record.priceUsd === null) return { priceUsd: null };

  // ---- A dollar price, validated in the one shared place ----
  try {
    return { priceUsd: parseUsdPriceInput(record.priceUsd, PRICE_FIELD) };
  } catch (error) {
    if (isPriceInputError(error)) {
      throw new AgencyVisaError("VALIDATION_ERROR", error.message, 400, PRICE_FIELD);
    }
    throw error;
  }
}

// ============================================
// Path
// ============================================

/**
 * Validate the `:countryCode/:visaTypeId` path params.
 *
 * @throws AgencyVisaError 400 (field "countryCode" or "visaTypeId")
 */
export function parseVisaPriceTarget(params: { countryCode?: unknown; visaTypeId?: unknown }): VisaPriceTarget {
  const cc = typeof params.countryCode === "string" ? params.countryCode.trim().toUpperCase() : "";
  if (!/^[A-Z]{2}$/.test(cc)) throw invalid("countryCode", "must be a 2-letter country code");

  const id = typeof params.visaTypeId === "string" ? params.visaTypeId.trim() : "";
  // A "/" would change the doc path; ".." / "." are not valid Firestore ids.
  if (!id || id.length > MAX_VISA_ID_LENGTH || id.includes("/") || id === "." || id === "..") {
    throw invalid("visaTypeId", "is not a valid visa id");
  }
  return { countryCode: cc, visaTypeId: id };
}
