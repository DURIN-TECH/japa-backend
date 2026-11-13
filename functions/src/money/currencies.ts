import type { CurrencyCode } from "../types/money";

// ============================================
// CURRENCY TABLE (issue #178)
// ============================================
//
// The ONE place that knows how many minor units make a major unit. Every
// conversion between "12.50" and 1250 goes through `minorUnitFactor`, so no
// other file may divide or multiply by a literal 100. Adding a currency the
// code understands is a row here; ENABLING it for charging is a config change
// (`appConfig/currencies`), not a code change.

/** One row of the table. */
export interface CurrencyInfo {
  code: CurrencyCode;
  /** Decimal places of the major unit (USD 2 => 100 cents). */
  exponent: number;
  /** Symbol used by `format`. */
  symbol: string;
  name: string;
}

/** ISO 4217 currencies Seli can price or charge in. NGN and USD are required. */
const TABLE: CurrencyInfo[] = [
  { code: "USD", exponent: 2, symbol: "$", name: "US dollar" },
  { code: "NGN", exponent: 2, symbol: "₦", name: "Nigerian naira" },
  { code: "GBP", exponent: 2, symbol: "£", name: "Pound sterling" },
  { code: "EUR", exponent: 2, symbol: "€", name: "Euro" },
  { code: "CAD", exponent: 2, symbol: "CA$", name: "Canadian dollar" },
  { code: "GHS", exponent: 2, symbol: "GH₵", name: "Ghanaian cedi" },
  { code: "KES", exponent: 2, symbol: "KSh", name: "Kenyan shilling" },
  { code: "ZAR", exponent: 2, symbol: "R", name: "South African rand" },
  // Zero-exponent examples: the minor unit IS the major unit.
  { code: "UGX", exponent: 0, symbol: "USh", name: "Ugandan shilling" },
  { code: "XOF", exponent: 0, symbol: "CFA", name: "West African CFA franc" },
];

const BY_CODE = new Map<string, CurrencyInfo>(TABLE.map((c) => [c.code, c]));

/** Normalise user/config input to a code ("ngn " -> "NGN"); undefined if not a 3-letter code. */
export function normalizeCurrencyCode(input: unknown): CurrencyCode | undefined {
  if (typeof input !== "string") return undefined;
  const code = input.trim().toUpperCase();
  return /^[A-Z]{3}$/.test(code) ? code : undefined;
}

/** The table row for a code, or undefined when the code is not in the table. */
export function getCurrencyInfo(code: CurrencyCode): CurrencyInfo | undefined {
  return BY_CODE.get(code);
}

/** Every code in the table (used by tests and validation). */
export function knownCurrencyCodes(): CurrencyCode[] {
  return TABLE.map((c) => c.code);
}

/**
 * Minor units per major unit as a BigInt (10 ** exponent). BigInt so callers
 * can multiply without a float ever appearing. Throws for an unknown code:
 * callers check support first and report a typed error.
 */
export function minorUnitFactor(code: CurrencyCode): bigint {
  const info = BY_CODE.get(code);
  if (!info) throw new Error(`Unknown currency "${code}"`);
  return 10n ** BigInt(info.exponent);
}
