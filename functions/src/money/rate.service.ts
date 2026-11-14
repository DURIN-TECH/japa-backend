import type { CurrenciesConfig, CurrencyCode, ExchangeRate } from "../types/money";
import { assertChargeable, MAX_OVERRIDE_TTL_HOURS, parseCurrenciesConfig, type ConfigStore } from "./config";
import { MAX_RATE, scaleRate } from "./money";
import { MoneyError } from "./errors";
import { normalizeCurrencyCode } from "./currencies";
import { selectProviders } from "./providers/select";
import type { ProviderId, RateProvider } from "./providers/types";
import type { RateAuditEntry, RateStore, StoredOverride, StoredRate } from "./rate.types";

// ============================================
// RATE SERVICE (issue #178)
// ============================================
//
// Serves the exchange rate quote() prices with, refreshes it from a provider,
// and lets an admin override it.
//
// Which rate is "effective" for a currency, in order:
//  1. an admin override that has not expired (source "manual");
//  2. the provider's last rate, if the provider confirmed it within the
//     freshness limit (`config.freshnessHours`);
//  3. otherwise the call FAILS: RATE_STALE (a rate exists but is too old) or
//     RATE_UNAVAILABLE (none ever stored). A rate is never invented, and an
//     expired rate is never served.
//
// Issue #214 safeguards on top of that:
//  - an override set with no provider rate to check it against
//    ("unreferenced") lasts 24h at most, and is flagged in the admin overview
//    while active;
//  - when a refresh stores a provider rate and an active override sits
//    outside `overrideBandPercent` of it, that is logged at error level and
//    flagged in the admin overview (a typo made after reset-reference cannot
//    quietly price low for days);
//  - every admin change (override set/clear, reset) is read, checked and
//    written with its audit entry in ONE transaction;
//  - an admin can ask for a refresh now (rate-limited, audited), so a
//    mistaken reset-reference does not stop pricing until the next 6-hourly run.

/** Hours -> milliseconds. */
const HOUR_MS = 60 * 60 * 1000;
/**
 * An unreferenced override (set while no provider rate existed) lasts at most
 * this long (issue #214), whatever TTL was asked for: with nothing to check it
 * against, a typo must not price for days.
 */
export const MAX_UNREFERENCED_OVERRIDE_TTL_HOURS = 24;
/** One admin "refresh now" per currency per this many minutes (issue #214). */
export const MANUAL_REFRESH_COOLDOWN_MINUTES = 5;
/** Reason recorded when an admin asks for a refresh without giving one. */
const DEFAULT_REFRESH_REASON = "Manual refresh requested";
/** A rate dated this far ahead of our clock is refused (clock skew / bad upstream row). */
const FUTURE_TOLERANCE_MS = 6 * HOUR_MS;
const MIN_REASON = 5;
const MAX_REASON = 500;

/**
 * True when `candidate` differs from `reference` by more than `percent`
 * percent. Integer maths on the 6-decimal scaled rates (no float compare).
 */
export function exceedsBand(candidate: number, reference: number, percent: number): boolean {
  const c = scaleRate(candidate);
  const r = scaleRate(reference);
  const diff = c > r ? c - r : r - c;
  return diff * 100_000n > r * BigInt(Math.round(percent * 1000));
}

export interface RateServiceDeps {
  config: ConfigStore;
  rates: RateStore;
  providers: { cbn: RateProvider; oanda: RateProvider };
  /** Clock, injectable for tests. */
  now?: () => Date;
}

/** One line per currency from a scheduled refresh. */
export interface RefreshOutcome {
  currency: CurrencyCode;
  ok: boolean;
  source?: ProviderId;
  rate?: number;
  reason?: string;
  /**
   * Set when the new provider rate was stored but an active admin override
   * now sits outside the override band of it (issue #214).
   */
  warning?: string;
}

/** A problem with a currency's active override, shown in the admin overview (issue #214). */
export interface RateWarning {
  code: "OVERRIDE_OUTSIDE_PROVIDER_BAND" | "OVERRIDE_UNREFERENCED";
  message: string;
}

export class RateService {
  private readonly now: () => Date;
  /**
   * Bumped whenever THIS instance changes what a rate read would return
   * (override set/cleared, reference reset, provider rate stored). The public
   * GET /rates cache compares it to drop a cached body at once (issue #214).
   * Other instances only see the change once their short cache expires.
   */
  private changeCounter = 0;

  constructor(private readonly deps: RateServiceDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  /** See `changeCounter`. */
  get changeVersion(): number {
    return this.changeCounter;
  }

  /** The current config (stored doc over defaults). */
  async getConfig(): Promise<CurrenciesConfig> {
    return parseCurrenciesConfig(await this.deps.config.read());
  }

  // ---------- reading ----------

  /**
   * The rate to price a currency with right now, or a typed MoneyError:
   * CURRENCY_UNSUPPORTED / CURRENCY_DISABLED / RATE_UNAVAILABLE / RATE_STALE.
   */
  async getRate(currencyInput: string, preloadedConfig?: CurrenciesConfig): Promise<ExchangeRate> {
    const config = preloadedConfig ?? (await this.getConfig());
    const { currency, entry } = assertChargeable(currencyInput, config);
    const stored = await this.deps.rates.get(currency);
    const marginBps = entry.marginBps ?? config.defaultMarginBps;
    return this.effectiveRate(currency, stored, config, marginBps);
  }

  /** Pure selection of the effective rate from a stored doc (see header). */
  private effectiveRate(
    currency: CurrencyCode,
    stored: StoredRate | null,
    config: CurrenciesConfig,
    marginBps: number
  ): ExchangeRate {
    const nowMs = this.now().getTime();

    // 1. Active admin override.
    if (stored?.override && stored.override.expiresAt.getTime() > nowMs) {
      return {
        currency,
        rate: stored.override.rate,
        asOf: stored.override.setAt.toISOString(),
        source: "manual",
        marginBps,
      };
    }

    // 2. Provider rate within the freshness limit.
    if (stored?.provider) {
      const ageMs = nowMs - stored.provider.fetchedAt.getTime();
      // The rate's OWN date must also be recent: re-reading an old row from a
      // stuck upstream refreshes `fetchedAt` but never `asOf`.
      const rateAgeMs = nowMs - stored.provider.asOf.getTime();
      if (ageMs <= config.freshnessHours * HOUR_MS && rateAgeMs <= config.maxRateAgeHours * HOUR_MS) {
        return {
          currency,
          rate: stored.provider.rate,
          asOf: stored.provider.asOf.toISOString(),
          source: stored.provider.source,
          marginBps,
        };
      }
      throw new MoneyError(
        "RATE_STALE",
        `The ${currency} exchange rate is out of date`,
        currency
      );
    }

    // 3. Nothing usable. An expired override alone also lands here.
    throw new MoneyError("RATE_UNAVAILABLE", `No ${currency} exchange rate is available`, currency);
  }

  // ---------- refreshing (scheduled function) ----------

  /**
   * Refresh every ENABLED currency from the provider chain. A failed provider
   * never touches the stored rate (it keeps serving until the freshness
   * limit); the failure is recorded on the doc. An active admin override is
   * left alone, but the provider part still updates behind it so the override
   * band and the post-expiry rate stay current.
   */
  async refreshAll(): Promise<RefreshOutcome[]> {
    const config = await this.getConfig();
    const outcomes: RefreshOutcome[] = [];
    for (const [currency, entry] of Object.entries(config.currencies)) {
      if (!entry.enabled) continue;
      // One currency failing (even a store error) must not stop the others.
      try {
        outcomes.push(await this.refreshOne(currency, config));
      } catch (err) {
        const reason = `refresh failed: ${err instanceof Error ? err.message.slice(0, 200) : "unknown error"}`;
        console.error(`Exchange rate refresh ${currency}: ${reason}`);
        outcomes.push({ currency, ok: false, reason });
      }
    }
    return outcomes;
  }

  /** Try each provider in order; save the first rate that passes validation. */
  private async refreshOne(currency: CurrencyCode, config: CurrenciesConfig): Promise<RefreshOutcome> {
    const reasons: string[] = [];
    const stored = await this.deps.rates.get(currency);
    for (const provider of selectProviders(config, this.deps.providers)) {
      if (!provider.supports(currency)) {
        reasons.push(`${provider.id}: does not cover ${currency}`);
        continue;
      }
      const result = await provider.fetchRate(currency);
      if (!result.ok) {
        reasons.push(`${provider.id}: ${result.reason}`);
        continue;
      }
      const rejection = this.rejectProviderRate(result.rate, result.asOf, config.currencies[currency], config, stored);
      if (rejection) {
        // Loud on purpose: a rejected rate means the upstream looks wrong.
        console.error(`Exchange rate ${currency}: ${provider.id} rate ${result.rate} rejected: ${rejection}`);
        reasons.push(`${provider.id}: rejected (${rejection})`);
        continue;
      }
      await this.deps.rates.saveProvider(currency, {
        rate: result.rate,
        asOf: result.asOf,
        fetchedAt: this.now(),
        source: provider.id,
      });
      this.changeCounter++;
      // Issue #214: the override beats the provider rate and was only checked
      // when it was set. Re-check it against the rate just accepted; a big gap
      // (typically an override typed after reset-reference) is shouted about
      // here and flagged in the admin overview until it is fixed or expires.
      const warning = this.overrideBandWarning(stored?.override ?? null, result.rate, config);
      if (warning) console.error(`Exchange rate ${currency}: ${warning}`);
      return { currency, ok: true, source: provider.id, rate: result.rate, ...(warning ? { warning } : {}) };
    }
    const reason = reasons.join("; ").slice(0, 500) || "no provider available";
    console.error(`Exchange rate ${currency}: refresh failed, keeping stored rate: ${reason}`);
    await this.deps.rates.saveError(currency, { at: this.now(), message: reason });
    return { currency, ok: false, reason };
  }

  /**
   * Why a provider rate must NOT be stored, or null when it is acceptable.
   * Applies to every provider. Checks, in order: valid number; its own date
   * is not in the future and not older than `maxRateAgeHours` (so a stuck
   * upstream is recorded as an error instead of re-stamped fresh); inside the
   * currency's plausible range; and not a jump of more than
   * `maxProviderJumpPercent` from the stored provider rate (when one exists).
   * With nothing stored and no configured range there is nothing to judge a
   * first rate by, so it is refused.
   */
  private rejectProviderRate(
    rate: number,
    asOf: Date,
    entry: CurrenciesConfig["currencies"][string] | undefined,
    config: CurrenciesConfig,
    stored: StoredRate | null
  ): string | null {
    try {
      scaleRate(rate);
    } catch {
      return "not a valid rate";
    }
    const nowMs = this.now().getTime();
    if (!(asOf instanceof Date) || Number.isNaN(asOf.getTime())) return "no valid date";
    if (asOf.getTime() > nowMs + FUTURE_TOLERANCE_MS) return "dated in the future";
    if (nowMs - asOf.getTime() > config.maxRateAgeHours * HOUR_MS) {
      return `dated more than ${config.maxRateAgeHours} hours ago`;
    }
    const hasRange = entry?.minRate !== undefined && entry?.maxRate !== undefined;
    if (hasRange && (rate < (entry?.minRate as number) || rate > (entry?.maxRate as number))) {
      return `outside the plausible range ${entry?.minRate}-${entry?.maxRate}`;
    }
    if (stored?.provider) {
      if (exceedsBand(rate, stored.provider.rate, config.maxProviderJumpPercent)) {
        return `more than ${config.maxProviderJumpPercent}% away from the stored rate ${stored.provider.rate}`;
      }
    } else if (!hasRange) {
      return "no stored rate and no plausible range configured to judge it by";
    }
    return null;
  }

  /**
   * Admin accepts a genuine large move: drops the stored provider rate (so
   * the jump guard has no reference) and audits it. The next refresh, or an
   * override in the meantime, then sets the new level; a first rate is still
   * held to the plausible range. This is THE deliberate path for a real
   * devaluation: the override band is relative to the same stale reference
   * and cannot reach a big move.
   */
  async resetReference(currencyInput: string, reasonInput: unknown, adminUid: string): Promise<void> {
    const currency = normalizeCurrencyCode(currencyInput);
    if (!currency) throw new MoneyError("CURRENCY_UNSUPPORTED", "Unknown currency");
    const reason = typeof reasonInput === "string" ? reasonInput.trim() : "";
    if (reason.length < MIN_REASON || reason.length > MAX_REASON) {
      throw new MoneyError("INVALID_INPUT", `reason must be ${MIN_REASON}-${MAX_REASON} characters`);
    }
    // Check and write in one transaction (issue #214), so the audited `old`
    // is the provider rate actually dropped.
    await this.deps.rates.transact(currency, (stored) => {
      if (!stored?.provider && !stored?.providerCorrupt) {
        throw new MoneyError("INVALID_INPUT", "There is no stored provider rate to reset", currency);
      }
      return {
        clearProvider: true,
        audit: {
          currency,
          action: "provider_reset",
          by: adminUid,
          at: this.now(),
          reason,
          old: stored.provider ? { rate: stored.provider.rate, source: stored.provider.source } : null,
          new: null,
        },
      };
    });
    this.changeCounter++;
  }

  // ---------- admin "refresh now" (issue #214) ----------

  /**
   * Refresh one enabled currency from the provider chain right now, exactly
   * as the 6-hourly schedule would (same validation, jump guard and range).
   * This is the way back from a mistaken reset-reference without waiting up
   * to 6 hours with no price.
   *
   * Rate-limited to one call per currency per MANUAL_REFRESH_COOLDOWN_MINUTES
   * (shared by all admins and instances, claimed in a transaction), since
   * each call makes an outbound request to the provider. Refused with
   * RATE_LIMITED (HTTP 429). `reason` is optional (5-500 chars when given).
   * Always audited as `provider_refresh` with the effective rate before and
   * after and what the refresh did, whether it succeeded or not.
   */
  async refreshNow(currencyInput: string, reasonInput: unknown, adminUid: string): Promise<RefreshOutcome> {
    const config = await this.getConfig();
    const { currency } = assertChargeable(currencyInput, config);
    let reason = DEFAULT_REFRESH_REASON;
    if (reasonInput !== undefined && reasonInput !== null) {
      reason = typeof reasonInput === "string" ? reasonInput.trim() : "";
      if (reason.length < MIN_REASON || reason.length > MAX_REASON) {
        throw new MoneyError("INVALID_INPUT", `reason must be ${MIN_REASON}-${MAX_REASON} characters`);
      }
    }

    const claim = await this.deps.rates.claimManualRefresh(currency, this.now(), MANUAL_REFRESH_COOLDOWN_MINUTES * 60_000);
    if (!claim.allowed) {
      throw new MoneyError(
        "RATE_LIMITED",
        `A refresh was requested less than ${MANUAL_REFRESH_COOLDOWN_MINUTES} minutes ago; try again shortly`,
        currency,
        claim.retryAfterSeconds
      );
    }

    const before = await this.deps.rates.get(currency);
    const outcome = await this.refreshOne(currency, config);
    const after = await this.deps.rates.get(currency);
    await this.deps.rates.appendAudit({
      currency,
      action: "provider_refresh",
      by: adminUid,
      at: this.now(),
      reason,
      old: this.summarizeEffective(before, config),
      new: this.summarizeEffective(after, config),
      outcome: (outcome.ok
        ? `ok: ${outcome.source} ${outcome.rate}${outcome.warning ? ` (${outcome.warning})` : ""}`
        : `failed: ${outcome.reason ?? "unknown"}`
      ).slice(0, 500),
    });
    return outcome;
  }

  // ---------- admin override ----------

  /**
   * Set a manual rate. Validated: reason 5-500 chars; rate positive, finite,
   * and within `overrideBandPercent` of the last PROVIDER rate (compared with
   * integer maths on the scaled rates). When no provider rate is stored
   * there is nothing to compare with: the rate must then sit inside the
   * currency's plausible range, the override and its audit entry are flagged
   * `unreferenced`, and it lasts 24h at most (issue #214).
   * Always writes an audit entry (who, when, old, new, why).
   */
  async setOverride(
    currencyInput: string,
    input: { rate: unknown; reason: unknown; ttlHours?: unknown },
    adminUid: string
  ): Promise<StoredRate> {
    const config = await this.getConfig();
    const { currency } = assertChargeable(currencyInput, config);

    if (typeof input.rate !== "number") throw new MoneyError("INVALID_INPUT", "rate must be a number");
    const rate = input.rate;
    scaleRate(rate); // throws for <= 0, NaN, Infinity, > MAX_RATE
    if (rate > MAX_RATE) throw new MoneyError("INVALID_INPUT", "rate is out of range");

    if (typeof input.reason !== "string") throw new MoneyError("INVALID_INPUT", "reason is required");
    const reason = input.reason.trim();
    if (reason.length < MIN_REASON || reason.length > MAX_REASON) {
      throw new MoneyError("INVALID_INPUT", `reason must be ${MIN_REASON}-${MAX_REASON} characters`);
    }

    let ttlHours = config.overrideTtlHours;
    if (input.ttlHours !== undefined) {
      if (
        typeof input.ttlHours !== "number" ||
        !Number.isFinite(input.ttlHours) ||
        input.ttlHours < 1 ||
        input.ttlHours > MAX_OVERRIDE_TTL_HOURS
      ) {
        throw new MoneyError("INVALID_INPUT", `ttlHours must be between 1 and ${MAX_OVERRIDE_TTL_HOURS}`);
      }
      ttlHours = input.ttlHours;
    }

    // Everything below runs inside ONE transaction (issue #214): the band is
    // checked against the provider rate as it is at write time, and the
    // audit `old` is the rate that was really in effect.
    let saved: StoredRate | null = null;
    await this.deps.rates.transact(currency, (stored) => {
      let unreferenced = false;
      if (stored?.providerCorrupt) {
        // A damaged reference must not silently downgrade to "no reference".
        throw new MoneyError("INVALID_INPUT", "The stored provider rate is unreadable; reset it first", currency);
      }
      if (stored?.provider) {
        if (exceedsBand(rate, stored.provider.rate, config.overrideBandPercent)) {
          throw new MoneyError(
            "INVALID_INPUT",
            `rate is more than ${config.overrideBandPercent}% away from the last provider rate`,
            currency
          );
        }
      } else {
        // Nothing to compare with: the rate must sit inside the currency's
        // plausible range; with no range configured it is refused.
        const entry = config.currencies[currency];
        if (entry?.minRate === undefined || entry?.maxRate === undefined) {
          throw new MoneyError("INVALID_INPUT", "No provider rate and no plausible range configured to check against", currency);
        }
        if (rate < entry.minRate || rate > entry.maxRate) {
          throw new MoneyError("INVALID_INPUT", `rate is outside the plausible range ${entry.minRate}-${entry.maxRate}`, currency);
        }
        unreferenced = true;
      }

      // Issue #214: an unreferenced override is capped at 24h, whatever was
      // asked for (the cap is visible to the admin as `expiresAt`).
      const effectiveTtlHours = unreferenced ? Math.min(ttlHours, MAX_UNREFERENCED_OVERRIDE_TTL_HOURS) : ttlHours;
      const now = this.now();
      const override: StoredOverride = {
        rate,
        reason,
        setBy: adminUid,
        setAt: now,
        expiresAt: new Date(now.getTime() + effectiveTtlHours * HOUR_MS),
        ...(unreferenced ? { unreferenced: true } : {}),
      };
      saved = { ...(stored ?? { currency, provider: null, lastError: null }), currency, override };
      return {
        override,
        audit: {
          currency,
          action: "override_set",
          by: adminUid,
          at: now,
          reason,
          old: this.summarizeEffective(stored, config),
          new: { rate, source: "manual" },
          ...(unreferenced ? { unreferenced: true } : {}),
        },
      };
    });
    this.changeCounter++;
    return saved as unknown as StoredRate;
  }

  /** Remove an override (the provider rate, if fresh, serves again). Audited. */
  async clearOverride(currencyInput: string, reasonInput: unknown, adminUid: string): Promise<void> {
    const currency = normalizeCurrencyCode(currencyInput);
    if (!currency) throw new MoneyError("CURRENCY_UNSUPPORTED", "Unknown currency");
    const reason = typeof reasonInput === "string" ? reasonInput.trim() : "";
    if (reason.length < MIN_REASON || reason.length > MAX_REASON) {
      throw new MoneyError("INVALID_INPUT", `reason must be ${MIN_REASON}-${MAX_REASON} characters`);
    }
    const config = await this.getConfig();
    // Issue #214: in a transaction, and `old` / `new` are the rates really in
    // effect before and after, freshness included. Clearing an override that
    // has ALREADY expired records the provider rate (if still fresh) or null
    // as `old`, not the expired manual rate; `new` never names a stale rate.
    await this.deps.rates.transact(currency, (stored) => {
      if (!stored?.override) throw new MoneyError("INVALID_INPUT", "There is no override to clear", currency);
      return {
        override: null,
        audit: {
          currency,
          action: "override_cleared",
          by: adminUid,
          at: this.now(),
          reason,
          old: this.summarizeEffective(stored, config),
          new: this.summarizeEffective({ ...stored, override: null }, config),
        },
      };
    });
    this.changeCounter++;
  }

  /**
   * The rate a currency is priced with for this stored doc (override if
   * active, else the provider rate if fresh), as `{ rate, source }` for an
   * audit record; null when nothing usable. Uses the same rules as quote().
   */
  private summarizeEffective(stored: StoredRate | null, config: CurrenciesConfig): RateAuditEntry["old"] {
    try {
      const r = this.effectiveRate(stored?.currency ?? "", stored, config, 0);
      return { rate: r.rate, source: r.source };
    } catch {
      return null;
    }
  }

  /**
   * Issue #214: a warning when an ACTIVE override is further than
   * `overrideBandPercent` from `providerRate`, else null. Integer maths via
   * exceedsBand.
   */
  private overrideBandWarning(override: StoredOverride | null, providerRate: number, config: CurrenciesConfig): string | null {
    if (!override || override.expiresAt.getTime() <= this.now().getTime()) return null;
    if (!exceedsBand(override.rate, providerRate, config.overrideBandPercent)) return null;
    return (
      `active override ${override.rate} is more than ${config.overrideBandPercent}% away from the provider rate ` +
      `${providerRate}; check it and clear or replace it`
    );
  }

  /** Issue #214: everything wrong with a currency's active override, for the admin overview. */
  private overrideWarnings(stored: StoredRate | null, config: CurrenciesConfig): RateWarning[] {
    const override = stored?.override;
    if (!override || override.expiresAt.getTime() <= this.now().getTime()) return [];
    const warnings: RateWarning[] = [];
    if (override.unreferenced) {
      warnings.push({
        code: "OVERRIDE_UNREFERENCED",
        message: `This override was set with no provider rate to check it against; it expires at ${override.expiresAt.toISOString()}`,
      });
    }
    const band = stored?.provider ? this.overrideBandWarning(override, stored.provider.rate, config) : null;
    if (band) warnings.push({ code: "OVERRIDE_OUTSIDE_PROVIDER_BAND", message: band });
    return warnings;
  }

  // ---------- admin read ----------

  /** For GET /admin/exchange-rates: each configured currency's stored state plus audit history. */
  async adminOverview(auditLimit = 25): Promise<
    {
      currency: CurrencyCode;
      enabled: boolean;
      effective: ExchangeRate | null;
      effectiveError: string | null;
      /** Issue #214: problems with the active override (empty when none). */
      warnings: RateWarning[];
      stored: StoredRate | null;
      audit: RateAuditEntry[];
    }[]
  > {
    const config = await this.getConfig();
    const rows = [];
    for (const [currency, entry] of Object.entries(config.currencies)) {
      const stored = await this.deps.rates.get(currency);
      let effective: ExchangeRate | null = null;
      let effectiveError: string | null = null;
      try {
        effective = this.effectiveRate(currency, stored, config, entry.marginBps ?? config.defaultMarginBps);
      } catch (err) {
        effectiveError = err instanceof MoneyError ? err.code : "ERROR";
      }
      rows.push({
        currency,
        enabled: entry.enabled,
        effective,
        effectiveError,
        warnings: this.overrideWarnings(stored, config),
        stored,
        audit: await this.deps.rates.listAudit(currency, auditLimit),
      });
    }
    return rows;
  }
}
