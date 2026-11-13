import type { CurrenciesConfig, CurrencyCode, ExchangeRate } from "../types/money";
import { assertChargeable, parseCurrenciesConfig, type ConfigStore } from "./config";
import { MAX_RATE, scaleRate } from "./money";
import { MoneyError } from "./errors";
import { normalizeCurrencyCode } from "./currencies";
import { selectProviders } from "./providers/select";
import type { ProviderId, RateProvider } from "./providers/types";
import type { RateAuditEntry, RateStore, StoredRate } from "./rate.types";

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

/** Hours -> milliseconds. */
const HOUR_MS = 60 * 60 * 1000;
/** An override can last at most a week, however it is asked for. */
const MAX_OVERRIDE_TTL_HOURS = 168;
const MIN_REASON = 5;
const MAX_REASON = 500;

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
}

export class RateService {
  private readonly now: () => Date;

  constructor(private readonly deps: RateServiceDeps) {
    this.now = deps.now ?? (() => new Date());
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
      if (ageMs <= config.freshnessHours * HOUR_MS) {
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
        `The ${currency} exchange rate is older than ${config.freshnessHours} hours`,
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
      outcomes.push(await this.refreshOne(currency, config));
    }
    return outcomes;
  }

  /** Try each provider in order; save the first rate that passes validation. */
  private async refreshOne(currency: CurrencyCode, config: CurrenciesConfig): Promise<RefreshOutcome> {
    const reasons: string[] = [];
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
      try {
        scaleRate(result.rate); // positive, finite, bounded
      } catch {
        reasons.push(`${provider.id}: returned an invalid rate`);
        continue;
      }
      await this.deps.rates.saveProvider(currency, {
        rate: result.rate,
        asOf: result.asOf,
        fetchedAt: this.now(),
        source: provider.id,
      });
      return { currency, ok: true, source: provider.id, rate: result.rate };
    }
    const reason = reasons.join("; ").slice(0, 500) || "no provider available";
    await this.deps.rates.saveError(currency, { at: this.now(), message: reason });
    return { currency, ok: false, reason };
  }

  // ---------- admin override ----------

  /**
   * Set a manual rate. Validated: reason 5-500 chars; rate positive, finite,
   * and within `overrideBandPercent` of the last PROVIDER rate (compared with
   * integer maths on the scaled rates). When no provider rate has ever been
   * stored there is nothing to compare with: the rate then only has to pass
   * the absolute bounds, and the audit entry is flagged `unreferenced`.
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
    const scaled = scaleRate(rate); // throws for <= 0, NaN, Infinity, > MAX_RATE
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

    const stored = await this.deps.rates.get(currency);
    let unreferenced = false;
    if (stored?.provider) {
      // |new - ref| * 100 <= ref * band%   (all integers; band in 1/1000 %)
      const ref = scaleRate(stored.provider.rate);
      const diff = scaled > ref ? scaled - ref : ref - scaled;
      const bandMilli = BigInt(Math.round(config.overrideBandPercent * 1000));
      if (diff * 100_000n > ref * bandMilli) {
        throw new MoneyError(
          "INVALID_INPUT",
          `rate is more than ${config.overrideBandPercent}% away from the last provider rate`,
          currency
        );
      }
    } else {
      unreferenced = true;
    }

    const now = this.now();
    const override = {
      rate,
      reason,
      setBy: adminUid,
      setAt: now,
      expiresAt: new Date(now.getTime() + ttlHours * HOUR_MS),
    };
    const audit: RateAuditEntry = {
      currency,
      action: "override_set",
      by: adminUid,
      at: now,
      reason,
      old: this.describeEffective(stored),
      new: { rate, source: "manual" },
      ...(unreferenced ? { unreferenced: true } : {}),
    };
    await this.deps.rates.saveOverride(currency, override, audit);
    return { ...(stored ?? { currency, provider: null, lastError: null }), currency, override };
  }

  /** Remove an override (the provider rate, if fresh, serves again). Audited. */
  async clearOverride(currencyInput: string, reasonInput: unknown, adminUid: string): Promise<void> {
    const currency = normalizeCurrencyCode(currencyInput);
    if (!currency) throw new MoneyError("CURRENCY_UNSUPPORTED", "Unknown currency");
    const reason = typeof reasonInput === "string" ? reasonInput.trim() : "";
    if (reason.length < MIN_REASON || reason.length > MAX_REASON) {
      throw new MoneyError("INVALID_INPUT", `reason must be ${MIN_REASON}-${MAX_REASON} characters`);
    }
    const stored = await this.deps.rates.get(currency);
    if (!stored?.override) throw new MoneyError("INVALID_INPUT", "There is no override to clear", currency);
    const now = this.now();
    await this.deps.rates.saveOverride(currency, null, {
      currency,
      action: "override_cleared",
      by: adminUid,
      at: now,
      reason,
      old: { rate: stored.override.rate, source: "manual" },
      new: stored.provider ? { rate: stored.provider.rate, source: stored.provider.source } : null,
    });
  }

  /** What the currency was priced with, for the audit "old" value (ignores freshness). */
  private describeEffective(stored: StoredRate | null): RateAuditEntry["old"] {
    if (stored?.override && stored.override.expiresAt.getTime() > this.now().getTime()) {
      return { rate: stored.override.rate, source: "manual" };
    }
    if (stored?.provider) return { rate: stored.provider.rate, source: stored.provider.source };
    return null;
  }

  // ---------- admin read ----------

  /** For GET /admin/exchange-rates: each configured currency's stored state plus audit history. */
  async adminOverview(auditLimit = 25): Promise<
    {
      currency: CurrencyCode;
      enabled: boolean;
      effective: ExchangeRate | null;
      effectiveError: string | null;
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
        stored,
        audit: await this.deps.rates.listAudit(currency, auditLimit),
      });
    }
    return rows;
  }
}
