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
    // Plausible naira per dollar: it has traded ~1,350-1,700 in 2024-26; the
    // range is wide enough to survive a real devaluation yet catches a
    // decimal slip (135.39) or an extra digit (13,539). Editable in config.
    NGN: { enabled: true, countries: ["NG", "Nigeria"], minRate: 200, maxRate: 5000 },
  },
  // CBN does not publish at weekends; a Friday rate confirmed on Friday must
  // still price on Sunday night. 72h covers a long weekend gap on top of the
  // 6-hourly refresh without serving a rate that is days old.
  freshnessHours: 72,
  // 5 days of rate age: Friday's rate still prices through a weekend + Monday holiday.
  maxRateAgeHours: 120,
  // Daily naira moves are normally a few percent; 10% catches a slipped
  // decimal or garbage while leaving room for a volatile day.
  maxProviderJumpPercent: 10,
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

/** Positive finite number from unknown clamped to `max`; else the fallback. A typo cannot exceed the cap. */
function bounded(value: unknown, fallback: number, max: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.min(value, max) : fallback;
}

/** Hard caps so a typo in the config doc cannot switch a protection off. */
export const MAX_FRESHNESS_HOURS = 168;
export const MAX_RATE_AGE_HOURS = 240;
export const MAX_BAND_PERCENT = 25;
export const MAX_JUMP_PERCENT = 50;
export const MAX_OVERRIDE_TTL_HOURS_CAP = 168;

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
      const minRate = v.minRate;
      const maxRate = v.maxRate;
      const rangeOk =
        typeof minRate === "number" && typeof maxRate === "number" &&
        Number.isFinite(minRate) && Number.isFinite(maxRate) && minRate > 0 && maxRate > minRate;
      currencies[code] = {
        ...(rangeOk ? { minRate, maxRate } : {}),
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
    freshnessHours: bounded(raw.freshnessHours, d.freshnessHours, MAX_FRESHNESS_HOURS),
    maxRateAgeHours: bounded(raw.maxRateAgeHours, d.maxRateAgeHours, MAX_RATE_AGE_HOURS),
    maxProviderJumpPercent: bounded(raw.maxProviderJumpPercent, d.maxProviderJumpPercent, MAX_JUMP_PERCENT),
    defaultMarginBps:
      typeof margin === "number" && Number.isInteger(margin) && margin >= 0 && margin <= 10_000
        ? margin
        : d.defaultMarginBps,
    provider: raw.provider === "oanda" ? "oanda" : "cbn",
    overrideBandPercent: bounded(raw.overrideBandPercent, d.overrideBandPercent, MAX_BAND_PERCENT),
    overrideTtlHours: bounded(raw.overrideTtlHours, d.overrideTtlHours, MAX_OVERRIDE_TTL_HOURS_CAP),
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
