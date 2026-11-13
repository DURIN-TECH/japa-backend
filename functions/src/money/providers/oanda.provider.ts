import type { AxiosInstance } from "axios";
import { createGuardedHttpClient, VISA_CATALOG_USER_AGENT } from "../../scrapers";
import type { CurrencyCode } from "../../types/money";
import type { ProviderResult, RateProvider } from "./types";

// ============================================
// OANDA PROVIDER (issue #178): paid, active only with an API key
// ============================================
//
// OANDA Exchange Rates API (paid). The provider is INACTIVE unless the
// OANDA_API_KEY secret exists: `isConfigured()` is false without it, so the
// selector never picks it and no request is made.
//
// IMPORTANT: the request and response shapes below come from OANDA's public
// documentation as recalled when this was written (spot endpoint with a Bearer
// key; a `quotes[]` array with a `midpoint` string); they were NOT verified
// against a live key because the owner has not bought a plan, and naira
// coverage is unconfirmed. Whoever buys a key must verify one real response
// (and update the fixture) before setting `provider: "oanda"` in
// appConfig/currencies. Until then a wrong shape just yields "unavailable" and
// the selector falls back to CBN.
//
// Secret handling: the key is read lazily from process.env.OANDA_API_KEY at
// call time, only ever placed in the Authorization header, never logged and
// never stored. It is NOT bound to any function today (binding a secret that
// does not exist would fail the deploy); see money/index.ts for how to bind it.

export const OANDA_SPOT_URL = "https://exchange-rates-api.oanda.com/v2/rates/spot.json";

/** Pure parse of the OANDA spot response (midpoint of the first quote). */
export function parseOandaSpot(json: unknown): { rate: number; asOf: Date } | null {
  const quotes = (json as { quotes?: unknown } | null)?.quotes;
  if (!Array.isArray(quotes) || quotes.length === 0) return null;
  const q = quotes[0] as Record<string, unknown>;
  const rate = Number(q.midpoint);
  if (!Number.isFinite(rate) || rate <= 0) return null;
  const time = typeof q.end_time === "string" ? new Date(q.end_time) : new Date(NaN);
  return { rate, asOf: Number.isNaN(time.getTime()) ? new Date() : time };
}

export class OandaRateProvider implements RateProvider {
  readonly id = "oanda" as const;
  private readonly http: AxiosInstance;

  constructor(
    http?: AxiosInstance,
    /** Reads the key; injectable so tests never touch process.env. */
    private readonly readKey: () => string | undefined = () => process.env.OANDA_API_KEY
  ) {
    this.http =
      http ??
      createGuardedHttpClient({
        timeout: 15_000,
        maxContentLength: 1024 * 1024,
        headers: { "User-Agent": VISA_CATALOG_USER_AGENT, Accept: "application/json" },
        validateStatus: () => true,
      });
  }

  /** True only when a non-empty key is present. */
  isConfigured(): boolean {
    const key = this.readKey();
    return typeof key === "string" && key.trim().length > 0;
  }

  /** OANDA quotes many currencies; whether it covers one is the vendor's call at request time. */
  supports(currency: CurrencyCode): boolean {
    return /^[A-Z]{3}$/.test(currency) && currency !== "USD";
  }

  async fetchRate(currency: CurrencyCode): Promise<ProviderResult> {
    const key = this.readKey();
    if (!this.isConfigured() || !key) return { ok: false, reason: "OANDA key not configured" };
    try {
      const res = await this.http.get(OANDA_SPOT_URL, {
        params: { base: "USD", quote: currency },
        headers: { Authorization: `Bearer ${key.trim()}` },
      });
      if (res.status !== 200) return { ok: false, reason: `OANDA answered ${res.status}` };
      const parsed = parseOandaSpot(res.data);
      if (!parsed) return { ok: false, reason: "OANDA response had no usable rate" };
      return { ok: true, rate: parsed.rate, asOf: parsed.asOf };
    } catch (err) {
      // Never include the request config (it holds the key) in the message.
      return { ok: false, reason: `OANDA request failed: ${err instanceof Error ? err.message.slice(0, 120) : "unknown error"}` };
    }
  }
}
