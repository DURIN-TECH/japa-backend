import type { CurrenciesConfig, CurrencyCode, ExchangeRate } from "../types/money";
import { assertChargeable, MAX_OVERRIDE_TTL_HOURS, parseCurrenciesConfig, type ConfigStore } from "./config";
import { MAX_RATE, scaleRate } from "./money";
import { MoneyError } from "./errors";
import { normalizeCurrencyCode } from "./currencies";
import { selectProviders } from "./providers/select";
import type { ProviderId, RateProvider } from "./providers/types";
import {
  isUnreferencedOverride,
  type RateAuditEntry,
  type RateStore,
  type StoredOverride,
  type StoredProviderRate,
  type StoredRate,
} from "./rate.types";

// ============================================
// RATE SERVICE (issue #178)
// ============================================
//
// Serves the exchange rate quote() prices with, refreshes it from a provider,
// and lets an admin override it.
//
// Which rate is "effective" for a currency, in order:
//  1. an admin override that has not expired (source "manual"), unless it
//     is unreferenced and a fresh provider rate is out of its band (#229);
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
//
// Issue #229 closes the gaps left after #214:
//  - an UNREFERENCED override (or a legacy one whose reference is unknown)
//    stops winning as soon as a fresh provider rate exists and the override
//    sits outside `overrideBandPercent` of it: the provider rate prices, and
//    the admin overview flags OVERRIDE_SUPERSEDED. (Before, the typo
//    "reset -> override 1050 -> provider 1500" priced ~30% low for up to 24h.)
//    A referenced override keeps winning as before, flagged when it drifts.
//  - refreshOne writes the provider rate conditionally on the doc as it read
//    it, so a reset-reference landing mid-refresh is not undone;
//  - refreshNow audits every outcome (try/finally), including store errors,
//    and gives the 5-minute slot back when it failed before the provider was
//    contacted.

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

/** A short, safe message from an unknown thrown value (for audit text and logs). */
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message.slice(0, 200) : "unknown error";
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
  /**
   * OVERRIDE_SUPERSEDED (issue #229): an unreferenced or legacy override is
   * being ignored because a fresh provider rate is out of its band.
   */
  code: "OVERRIDE_OUTSIDE_PROVIDER_BAND" | "OVERRIDE_UNREFERENCED" | "OVERRIDE_SUPERSEDED";
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

  /**
   * The stored provider rate if it is usable right now, else null: confirmed
   * within `freshnessHours` (fetchedAt) AND its own date within
   * `maxRateAgeHours` (asOf). Re-reading an old row from a stuck upstream
   * refreshes `fetchedAt` but never `asOf`, hence both checks.
   */
  private freshProvider(stored: StoredRate | null, config: CurrenciesConfig): StoredProviderRate | null {
    if (!stored?.provider) return null;
    const nowMs = this.now().getTime();
    const ageMs = nowMs - stored.provider.fetchedAt.getTime();
    const rateAgeMs = nowMs - stored.provider.asOf.getTime();
    return ageMs <= config.freshnessHours * HOUR_MS && rateAgeMs <= config.maxRateAgeHours * HOUR_MS
      ? stored.provider
      : null;
  }

  /**
   * Issue #229: true when an ACTIVE override must give way to the provider
   * rate: it is unreferenced (or legacy, reference unknown; see
   * isUnreferencedOverride), a FRESH provider rate exists, and the override
   * is more than `overrideBandPercent` away from it (integer maths via
   * exceedsBand). Such an override was never checked against anything, and
   * a fresh rate now says it is wrong, so it must not price for the rest of
   * its 24h. A referenced override is never superseded here: it passed the
   * band when it was set, and a later drift is only flagged.
   */
  private overrideSuperseded(stored: StoredRate | null, config: CurrenciesConfig): boolean {
    const override = stored?.override;
    if (!override || override.expiresAt.getTime() <= this.now().getTime()) return false;
    if (!isUnreferencedOverride(override)) return false;
    const provider = this.freshProvider(stored, config);
    return !!provider && exceedsBand(override.rate, provider.rate, config.overrideBandPercent);
  }

  /** Pure selection of the effective rate from a stored doc (see header). */
  private effectiveRate(
    currency: CurrencyCode,
    stored: StoredRate | null,
    config: CurrenciesConfig,
    marginBps: number
  ): ExchangeRate {
    const nowMs = this.now().getTime();

    // 1. Active admin override, unless it is an unreferenced one that a fresh
    //    provider rate has shown to be out of band (issue #229): then it is
    //    skipped and step 2 prices from the provider instead.
    if (stored?.override && stored.override.expiresAt.getTime() > nowMs && !this.overrideSuperseded(stored, config)) {
      return {
        currency,
        rate: stored.override.rate,
        asOf: stored.override.setAt.toISOString(),
        source: "manual",
        marginBps,
      };
    }

    // 2. Provider rate within the freshness limit (fetchedAt) and the rate-age
    //    limit (its own asOf date).
    const provider = this.freshProvider(stored, config);
    if (provider) {
      return {
        currency,
        rate: provider.rate,
        asOf: provider.asOf.toISOString(),
        source: provider.source,
        marginBps,
      };
    }
    if (stored?.provider) {
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
        const reason = `refresh failed: ${errorMessage(err)}`;
        console.error(`Exchange rate refresh ${currency}: ${reason}`);
        outcomes.push({ currency, ok: false, reason });
      }
    }
    return outcomes;
  }

  /**
   * Try each provider in order; save the first rate that passes validation.
   *
   * Issue #229: the save is CONDITIONAL on the doc's provider part being what
   * was read at the start (`stored`). The provider fetch runs outside any
   * transaction (it is an outbound request and must not be retried); only
   * the final re-read + compare + write is transactional. If an admin's
   * reset-reference (or another refresh) committed in between, nothing is
   * stored and the outcome says so: the rate was judged against a reference
   * that no longer exists, and storing it would silently undo the reset. The
   * next refresh judges it again against the doc as it is then.
   *
   * `progress.contactedProvider` is set just before the first outbound fetch,
   * so refreshNow can tell a failure before any provider was contacted (the
   * slot is then given back) from one after.
   */
  private async refreshOne(
    currency: CurrencyCode,
    config: CurrenciesConfig,
    progress: { contactedProvider: boolean } = { contactedProvider: false }
  ): Promise<RefreshOutcome> {
    const reasons: string[] = [];
    const stored = await this.deps.rates.get(currency);
    for (const provider of selectProviders(config, this.deps.providers)) {
      if (!provider.supports(currency)) {
        reasons.push(`${provider.id}: does not cover ${currency}`);
        continue;
      }
      progress.contactedProvider = true;
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
      const saved = await this.deps.rates.saveProvider(
        currency,
        { rate: result.rate, asOf: result.asOf, fetchedAt: this.now(), source: provider.id },
        stored
      );
      if (!saved) {
        // Issue #229: the provider part changed while we fetched (typically a
        // reset-reference). Keep the admin's change; record nothing on the
        // doc (it is not a provider failure) and say what happened.
        const reason = `${provider.id}: rate ${result.rate} not stored, the stored rate changed during the refresh ` +
          "(e.g. reset-reference); the next refresh will check it again";
        console.warn(`Exchange rate ${currency}: ${reason}`);
        return { currency, ok: false, reason };
      }
      this.changeCounter++;
      // Issue #214: the override beats the provider rate and was only checked
      // when it was set. Re-check it against the rate just accepted; a big gap
      // (typically an override typed after reset-reference) is shouted about
      // here and flagged in the admin overview until it is fixed or expires.
      // Issue #229: if that override is unreferenced it has now stopped
      // pricing (see overrideSuperseded); the warning says so.
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
   * after and what the refresh did, whether it succeeded or not, including a
   * store error mid-refresh (issue #229). A failed audit write is logged and
   * never changes the response. A refresh that fails before any provider was
   * contacted gives its slot back.
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

    // The claim time is kept: releasing the slot later only clears a claim
    // that is still this one (issue #229).
    const claimedAt = this.now();
    const claim = await this.deps.rates.claimManualRefresh(currency, claimedAt, MANUAL_REFRESH_COOLDOWN_MINUTES * 60_000);
    if (!claim.allowed) {
      throw new MoneyError(
        "RATE_LIMITED",
        `A refresh was requested less than ${MANUAL_REFRESH_COOLDOWN_MINUTES} minutes ago; try again shortly`,
        currency,
        claim.retryAfterSeconds
      );
    }

    // Issue #229: EVERY outcome past the claim is audited, in a finally
    // block. Before, only a failed provider fetch was: a Firestore error in
    // a read or write threw past the audit (500, no entry, slot used up), and
    // a failed audit write after a successful refresh turned a real rate
    // change into a 500. The audit stays OUTSIDE any transaction, because
    // the provider fetch inside refreshOne must not run in one.
    const progress = { contactedProvider: false };
    let before: StoredRate | null = null;
    let outcome: RefreshOutcome | null = null;
    let failure: unknown = null;
    let slotReleased = false;
    try {
      before = await this.deps.rates.get(currency);
      outcome = await this.refreshOne(currency, config, progress);
    } catch (err) {
      failure = err;
    } finally {
      // Failed before any provider was contacted (e.g. the first read threw):
      // no outbound request was made, so give the 5-minute slot back and let
      // the admin retry at once. A failure after contact keeps the slot (the
      // limit exists to bound outbound requests). Best effort: a failed
      // release only means waiting out the cooldown.
      if (failure && !progress.contactedProvider) {
        try {
          await this.deps.rates.releaseManualRefresh(currency, claimedAt);
          slotReleased = true;
        } catch (releaseErr) {
          console.error(`Exchange rate ${currency}: could not release the refresh slot:`, releaseErr);
        }
      }

      // The effective rate after the attempt. If this read fails too, `new`
      // is recorded as null and the outcome text says the state is unknown.
      let after: StoredRate | null = null;
      let afterUnread = false;
      try {
        after = await this.deps.rates.get(currency);
      } catch {
        afterUnread = true;
      }

      const outcomeText = failure
        ? `failed: ${errorMessage(failure)}${slotReleased ? " (refresh slot released)" : ""}`
        : outcome?.ok
          ? `ok: ${outcome.source} ${outcome.rate}${outcome.warning ? ` (${outcome.warning})` : ""}`
          : `failed: ${outcome?.reason ?? "unknown"}`;
      try {
        await this.deps.rates.appendAudit({
          currency,
          action: "provider_refresh",
          by: adminUid,
          at: this.now(),
          reason,
          old: this.summarizeEffective(before, config),
          new: afterUnread ? null : this.summarizeEffective(after, config),
          outcome: `${outcomeText}${afterUnread ? " (rate after the refresh could not be read)" : ""}`.slice(0, 500),
        });
      } catch (auditErr) {
        // Never let a failed audit write hide what the refresh did: the rate
        // may already have changed, and the response must say so. Logged at
        // error level so the missing entry is noticed.
        console.error(`Exchange rate ${currency}: refresh-now audit write failed (outcome "${outcomeText}"):`, auditErr);
      }
    }
    // A store error during the refresh still surfaces (HTTP 500); it has
    // been audited above.
    if (failure) throw failure;
    return outcome as RefreshOutcome;
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
        // Issue #229: a referenced override records the provider rate it was
        // checked against, so it can be told apart from a legacy override
        // whose reference is unknown (see isUnreferencedOverride).
        ...(unreferenced ? { unreferenced: true } : { referenceRate: (stored?.provider as StoredProviderRate).rate }),
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
   * exceedsBand. Issue #229: for an unreferenced (or legacy) override the
   * message says it has stopped pricing, since a fresh provider rate that
   * far away supersedes it (see overrideSuperseded).
   */
  private overrideBandWarning(override: StoredOverride | null, providerRate: number, config: CurrenciesConfig): string | null {
    if (!override || override.expiresAt.getTime() <= this.now().getTime()) return null;
    if (!exceedsBand(override.rate, providerRate, config.overrideBandPercent)) return null;
    const head = `active override ${override.rate} is more than ${config.overrideBandPercent}% away from the provider rate ${providerRate}`;
    return isUnreferencedOverride(override)
      ? `${head}; it was never checked against a provider rate, so it no longer prices (the provider rate does); clear or replace it`
      : `${head}; check it and clear or replace it`;
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
    // Issue #229: say plainly when the override is being ignored for pricing.
    if (this.overrideSuperseded(stored, config)) {
      warnings.push({
        code: "OVERRIDE_SUPERSEDED",
        message:
          `This override (${override.rate}) is not used for pricing: it was not checked against a provider rate ` +
          `when set, and the fresh provider rate ${stored?.provider?.rate} is more than ${config.overrideBandPercent}% away`,
      });
    }
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
