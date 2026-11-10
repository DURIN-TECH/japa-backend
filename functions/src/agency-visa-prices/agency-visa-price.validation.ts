// ============================================
// Agency per-visa service price: input validation (issue #103)
// ============================================
//
// Pure functions (no I/O), unit-tested in test/agency-visa-prices/.
//
// MONEY UNIT: prices are WHOLE NAIRA. ₦12,500 is sent and stored as 12500.
// There is no kobo / cents conversion anywhere in this module, and there must
// never be one (the old `Agent.serviceFees` comment said "cents" and was
// never used; see the gotcha on `consultationFee`).
//
// Errors reuse `AgencyVisaError` from the agency visa module (#100), so every
// `/agency/...` endpoint answers with the same envelope:
// `{ success: false, error, message, field? }`.

import { AgencyVisaError } from "../agency-visas/agency-visa.validation";

// ============================================
// Limits
// ============================================

/**
 * Largest price an agency can set, in naira (₦100,000,000). Anything above it
 * is treated as a typo ("absurdly large" in the issue) and refused with 400.
 * Well inside Number.MAX_SAFE_INTEGER, so integer checks stay exact.
 */
export const MAX_VISA_SERVICE_PRICE_NAIRA = 100_000_000;

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
  /** Whole naira, 0..MAX_VISA_SERVICE_PRICE_NAIRA; null = clear the price. */
  price: number | null;
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
 * Accepts exactly `{ price }`:
 *  - a JSON number that is an integer, >= 0 and <= MAX_VISA_SERVICE_PRICE_NAIRA;
 *  - or `null`, which clears the price (same as DELETE).
 * Refused with 400 (field "price", nothing saved): a missing price, a string
 * (even "12500": the client must send a number), a boolean, NaN / Infinity,
 * a fraction (no kobo), a negative or a too-large value. Any other key is a
 * 400 UNKNOWN_FIELD, so tampering is visible instead of silently dropped.
 *
 * @param body the raw request body
 * @returns the parsed price (or null to clear)
 * @throws AgencyVisaError 400
 */
export function parseVisaPriceBody(body: unknown): ParsedVisaPriceBody {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw invalid("price", "send a JSON object like { \"price\": 12500 }");
  }
  const record = body as Record<string, unknown>;

  // ---- Only `price` is accepted ----
  for (const key of Object.keys(record)) {
    if (key !== "price") {
      throw new AgencyVisaError("UNKNOWN_FIELD", `${key}: is not a field you can set here`, 400, key);
    }
  }
  if (!("price" in record)) throw invalid("price", "is required (send null to clear it)");

  const price = record.price;

  // ---- null clears ----
  if (price === null) return { price: null };

  // ---- A whole, non-negative, bounded number of naira ----
  if (typeof price !== "number" || !Number.isFinite(price)) {
    throw invalid("price", "must be a number of naira");
  }
  if (!Number.isInteger(price)) {
    throw invalid("price", "must be a whole number of naira (no kobo)");
  }
  if (price < 0) throw invalid("price", "must be 0 or more");
  if (price > MAX_VISA_SERVICE_PRICE_NAIRA) {
    throw invalid("price", `must be at most ${MAX_VISA_SERVICE_PRICE_NAIRA} naira`);
  }
  return { price };
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
