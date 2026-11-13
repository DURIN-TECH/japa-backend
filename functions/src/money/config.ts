import type { CurrenciesConfig, CurrencyCode, CurrencyConfigEntry } from "../types/money";
import { getCurrencyInfo, normalizeCurrencyCode } from "./currencies";
import { MoneyError } from "./errors";

// ============================================
// CURRENCY CONFIG: appConfig/currencies (issue #178)
// ============================================
//
// A backend-only document (no firestore.rules match, so clients are denied)
// that says which charge currencies are on, how fresh a rate must be, and the
// default margin. Adding a currency is an edit to this document, not code.
// When the document is missing the defaults below apply: NGN only, margin 0.

/** Defaults used for a missing document and for any missing field. */
export const DEFAULT_CURRENCIES_CONFIG: CurrenciesConfig = {
  defaultCurrency: "NGN",
  currencies: {
    NGN: { enabled: true, countries: ["NG", "Nigeria"] },
  },
  // CBN does not publish at weekends; a Friday rate confirmed on Friday must
  // still price on Sunday night. 72h covers a long weekend gap on top of the
  // 6-hourly refresh without serving a rate that is days old.
  freshnessHours: 72,
  defaultMarginBps: 0,
  provider: "cbn",
  overrideBandPercent: 10,
  overrideTtlHours: 24,
};

/** Where the config document is read from (Firestore in production, a fake in tests). */
export interface ConfigStore {
  /** The raw stored document, or null when it does not exist. */
  read(): Promise<Record<string, unknown> | null>;
}

/** Positive finite number from unknown, else the fallback. */
function positive(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * Merge a stored document over the defaults, dropping anything malformed
 * (a bad entry is ignored rather than trusted). Pure.
 */
export function parseCurrenciesConfig(raw: Record<string, unknown> | null): CurrenciesConfig {
  const d = DEFAULT_CURRENCIES_CONFIG;
  if (!raw) return { ...d, currencies: { ...d.currencies } };

  // Currency entries: keep only well-formed ones for codes in the table.
  const currencies: Record<CurrencyCode, CurrencyConfigEntry> = {};
  const storedCurrencies = raw.currencies;
  if (storedCurrencies && typeof storedCurrencies === "object") {
    for (const [key, value] of Object.entries(storedCurrencies as Record<string, unknown>)) {
      const code = normalizeCurrencyCode(key);
      if (!code || !getCurrencyInfo(code) || !value || typeof value !== "object") continue;
      const v = value as Record<string, unknown>;
      const marginBps = v.marginBps;
      currencies[code] = {
        enabled: v.enabled === true,
        countries: Array.isArray(v.countries) ? v.countries.filter((c): c is string => typeof c === "string") : [],
        ...(typeof marginBps === "number" && Number.isInteger(marginBps) && marginBps >= 0 && marginBps <= 10_000
          ? { marginBps }
          : {}),
      };
    }
  }

  const margin = raw.defaultMarginBps;
  return {
    defaultCurrency: normalizeCurrencyCode(raw.defaultCurrency) ?? d.defaultCurrency,
    // A stored doc with no valid entries must not silently turn every currency off or on:
    // fall back to the default entries.
    currencies: Object.keys(currencies).length > 0 ? currencies : { ...d.currencies },
    freshnessHours: positive(raw.freshnessHours, d.freshnessHours),
    defaultMarginBps:
      typeof margin === "number" && Number.isInteger(margin) && margin >= 0 && margin <= 10_000
        ? margin
        : d.defaultMarginBps,
    provider: raw.provider === "oanda" ? "oanda" : "cbn",
    overrideBandPercent: positive(raw.overrideBandPercent, d.overrideBandPercent),
    overrideTtlHours: positive(raw.overrideTtlHours, d.overrideTtlHours),
  };
}

/**
 * Which charge currency a client is billed in. Resolved on the SERVER from
 * the profile country only: a currency sent by the client is never an input
 * to this function. A country the config maps to a currency picks it (even
 * when that currency is disabled: the caller then gets CURRENCY_DISABLED
 * rather than a silent switch to naira). No country, or an unmapped one, gets
 * the config's default currency (NGN).
 */
export function resolveChargeCurrency(profileCountry: string | undefined | null, config: CurrenciesConfig): CurrencyCode {
  const wanted = typeof profileCountry === "string" ? profileCountry.trim().toLowerCase() : "";
  if (wanted) {
    for (const [code, entry] of Object.entries(config.currencies)) {
      if (entry.countries.some((c) => c.trim().toLowerCase() === wanted)) return code;
    }
  }
  return config.defaultCurrency;
}

/**
 * Throw the typed error unless `code` is a known, configured, ENABLED currency.
 * Returns the normalised code and its config entry.
 */
export function assertChargeable(
  code: unknown,
  config: CurrenciesConfig
): { currency: CurrencyCode; entry: CurrencyConfigEntry } {
  const currency = normalizeCurrencyCode(code);
  if (!currency || !getCurrencyInfo(currency)) {
    throw new MoneyError("CURRENCY_UNSUPPORTED", `Currency "${String(code)}" is not supported`);
  }
  const entry = config.currencies[currency];
  if (!entry) throw new MoneyError("CURRENCY_UNSUPPORTED", `Currency ${currency} is not supported`, currency);
  if (!entry.enabled) throw new MoneyError("CURRENCY_DISABLED", `Currency ${currency} is not enabled`, currency);
  return { currency, entry };
}
