import type { CurrenciesConfig, CurrencyCode, CurrencyConfigEntry } from "../types/money";
import { getCurrencyInfo, normalizeCurrencyCode } from "./currencies";
import { MoneyError } from "./errors";
import { MAX_RATE } from "./money";

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
  // 6 days of rate age (issue #214). A CBN row is dated at the START of its
  // Lagos day (23:00Z the day before). Over a four-day closure (Easter: Good
  // Friday to Easter Monday) Thursday's row is 120h old at Monday 23:00Z and
  // Tuesday's row lands some hours into Tuesday, so 120h left a gap of up to
  // ~18h with no price. 144h covers that closure plus a day; the 240h cap
  // below still stops a typo from serving a rate that is weeks old.
  maxRateAgeHours: 144,
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
/**
 * The longest an admin override may last, however it is asked for (config
 * default or request). THE one 168h constant (issue #214): the config cap and
 * the request bound in rate.service.ts both use it, so they cannot drift.
 */
export const MAX_OVERRIDE_TTL_HOURS = 168;
/**
 * The longest an admin HOLD may last (issue #241), checked on every request
 * (a hold has no default life: its ttlHours is required, 1 to this). Kept
 * equal to the override cap: a week covers a lagging Central Bank feed while
 * forcing a fresh, audited decision at least weekly.
 */
export const MAX_HOLD_TTL_HOURS = MAX_OVERRIDE_TTL_HOURS;
/**
 * Widest plausible range allowed in config, as maxRate / minRate (issue #214).
 * NGN's default 200-5000 is 25x. A typo like maxRate 1e9 would make the range
 * meaningless, so a stored range wider than 50x is ignored and the currency
 * has no range (fails closed). Since issue #229 this only matters for a
 * currency with NO default range: one that has a default may only narrow it.
 */
export const MAX_RATE_RANGE_RATIO = 50;

/**
 * A valid plausible range, or null. Both ends positive and finite, min < max,
 * max no higher than the money module's absolute MAX_RATE, and the ratio
 * max/min no wider than MAX_RATE_RANGE_RATIO.
 */
function validRange(minRate: unknown, maxRate: unknown): { minRate: number; maxRate: number } | null {
  if (typeof minRate !== "number" || typeof maxRate !== "number") return null;
  if (!Number.isFinite(minRate) || !Number.isFinite(maxRate)) return null;
  if (minRate <= 0 || maxRate <= minRate || maxRate > MAX_RATE) return null;
  if (maxRate > minRate * MAX_RATE_RANGE_RATIO) return null;
  return { minRate, maxRate };
}

/** A positive finite number, or undefined. */
function positiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * Issue #229: the plausible range for a currency that HAS a default range.
 * A stored range may only NARROW the default, never widen it:
 *  - stored minRate is used only when it is >= the default minRate,
 *  - stored maxRate is used only when it is <= the default maxRate,
 * and each bound that is missing, malformed or wider falls back to the
 * default's bound on its own. If the result is not a valid range (e.g. a
 * narrowed min at or above a narrowed max) the default pair is kept.
 * Before #229 a stored 100-5000 for NGN (inside the 50x ratio cap) widened
 * the default 200-5000, so a decimal slip of ~150 passed as a first rate.
 */
function narrowedRange(
  stored: Record<string, unknown>,
  fallback: { minRate: number; maxRate: number }
): { minRate: number; maxRate: number } {
  const storedMin = positiveNumber(stored.minRate);
  const storedMax = positiveNumber(stored.maxRate);
  const minRate = storedMin !== undefined && storedMin >= fallback.minRate ? storedMin : fallback.minRate;
  const maxRate = storedMax !== undefined && storedMax <= fallback.maxRate ? storedMax : fallback.maxRate;
  return validRange(minRate, maxRate) ?? fallback;
}

/** A margin in basis points (integer 0-10000), or undefined. */
function validMarginBps(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 10_000 ? value : undefined;
}

/**
 * One stored currency entry merged OVER its default entry (issue #214).
 *
 * Before #214 a stored entry replaced the default outright, so writing
 * `{ NGN: { marginBps: 50 } }` silently dropped NGN's plausible range (and
 * its enabled flag and countries). Now each field falls back to the default
 * entry's value when the stored one is missing or malformed:
 *  - `enabled`: a stored boolean wins, else the default (else false);
 *  - `countries`: a stored array of strings wins, else the default (else []);
 *  - `marginBps`: a valid stored margin wins, else the default's (if any);
 *  - `minRate`/`maxRate`, when the currency HAS a default range (issue
 *    #229): a stored range may only narrow it (see narrowedRange); a wider
 *    bound falls back to the default's bound.
 *  - `minRate`/`maxRate`, for a currency with NO default range (a new
 *    currency): judged as a PAIR by validRange (ratio cap included); with
 *    no valid pair the currency has no range, which fails closed (a
 *    first-run rate or an unreferenced override is then refused).
 */
function mergeCurrencyEntry(stored: Record<string, unknown>, fallback: CurrencyConfigEntry | undefined): CurrencyConfigEntry {
  const enabled = typeof stored.enabled === "boolean" ? stored.enabled : fallback?.enabled ?? false;
  const countries = Array.isArray(stored.countries)
    ? stored.countries.filter((c): c is string => typeof c === "string")
    : [...(fallback?.countries ?? [])];
  const marginBps = validMarginBps(stored.marginBps) ?? fallback?.marginBps;
  const defaultRange = validRange(fallback?.minRate, fallback?.maxRate);
  const range = defaultRange ? narrowedRange(stored, defaultRange) : validRange(stored.minRate, stored.maxRate);
  return {
    enabled,
    countries,
    ...(marginBps !== undefined ? { marginBps } : {}),
    ...(range ?? {}),
  };
}

/**
 * Merge a stored document over the defaults, dropping anything malformed
 * (a bad entry is ignored rather than trusted). Pure.
 */
export function parseCurrenciesConfig(raw: Record<string, unknown> | null): CurrenciesConfig {
  const d = DEFAULT_CURRENCIES_CONFIG;
  if (!raw) return { ...d, currencies: { ...d.currencies } };

  // Currency entries (issue #214): start from the default entries and lay
  // each well-formed stored entry OVER its default (see mergeCurrencyEntry).
  // A stored code with no default entry (a new currency) merges over nothing.
  // Codes not in the currency table, and non-object values, are ignored. To
  // switch a default currency off, store `{ enabled: false }` for it.
  const currencies: Record<CurrencyCode, CurrencyConfigEntry> = {};
  for (const [code, entry] of Object.entries(d.currencies)) {
    currencies[code] = { ...entry, countries: [...entry.countries] };
  }
  const storedCurrencies = raw.currencies;
  if (storedCurrencies && typeof storedCurrencies === "object") {
    for (const [key, value] of Object.entries(storedCurrencies as Record<string, unknown>)) {
      const code = normalizeCurrencyCode(key);
      if (!code || !getCurrencyInfo(code) || !value || typeof value !== "object") continue;
      currencies[code] = mergeCurrencyEntry(value as Record<string, unknown>, d.currencies[code]);
    }
  }

  const margin = raw.defaultMarginBps;
  return {
    defaultCurrency: normalizeCurrencyCode(raw.defaultCurrency) ?? d.defaultCurrency,
    // Always at least the default entries (merged above), so a stored doc
    // with no valid entries cannot silently turn every currency off.
    currencies,
    freshnessHours: bounded(raw.freshnessHours, d.freshnessHours, MAX_FRESHNESS_HOURS),
    maxRateAgeHours: bounded(raw.maxRateAgeHours, d.maxRateAgeHours, MAX_RATE_AGE_HOURS),
    maxProviderJumpPercent: bounded(raw.maxProviderJumpPercent, d.maxProviderJumpPercent, MAX_JUMP_PERCENT),
    defaultMarginBps: validMarginBps(margin) ?? d.defaultMarginBps,
    provider: raw.provider === "oanda" ? "oanda" : "cbn",
    overrideBandPercent: bounded(raw.overrideBandPercent, d.overrideBandPercent, MAX_BAND_PERCENT),
    overrideTtlHours: bounded(raw.overrideTtlHours, d.overrideTtlHours, MAX_OVERRIDE_TTL_HOURS),
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
