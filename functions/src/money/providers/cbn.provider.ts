import type { AxiosInstance } from "axios";
import { createGuardedHttpClient, VISA_CATALOG_USER_AGENT, parseRobotsDisallows } from "../../scrapers";
import type { CurrencyCode } from "../../types/money";
import type { ProviderResult, RateProvider } from "./types";

// ============================================
// CBN PROVIDER (issue #178): official NFEM rate, naira per US dollar
// ============================================
//
// Source. The Central Bank of Nigeria publishes the daily NFEM rate at
// https://www.cbn.gov.ng/rates/ExchRateByCurrency.html. That page's static
// HTML has no rows; its own script (https://www.cbn.gov.ng/rates/script1.js)
// fills its NFEM table from this JSON endpoint, which is what we read:
//
//     GET https://www.cbn.gov.ng/api/GetAllNFEM_Rates
//
// It returns an array of daily rows, newest first today (we do not rely on
// the order), e.g.
//   { "ratedate": "November-13-2026", "weightedAvgRate": "1353.9741",
//     "closingrate": "1353.5000", "highestrate": "1359.0000", ... }
// We use `weightedAvgRate`: the page's footnote says "NFEM rate is derived at
// Volume Weighted Average and stands as the official exchange rate for the
// day". Values are strings with 4 decimals; `ratedate` is "Month-DD-YYYY".
// A recorded copy of the response shape is the test fixture.
//
// robots.txt (https://www.cbn.gov.ng/robots.txt, read 2026-11-13) says
// "User-agent: *  Allow: /" plus Disallow for /footer.html, /header.html,
// /museum/, /*.asp$ and /appsettings.json. /api/ is not disallowed. The
// provider still re-reads robots.txt on every fetch and refuses ("unavailable")
// if the path is ever disallowed or robots.txt answers 5xx. 4xx = no rules.
//
// Manners. Honest SeliBot user agent (the one the visa scrapers use), the
// guarded HTTP client from #159 (no private addresses, no proxy, redirects
// re-checked), one request per refresh. No evasion of any block: a 403, 429
// or 5xx simply makes the provider "unavailable" and the stored rate keeps
// serving until the freshness limit.

/** The endpoint the official page itself reads. */
export const CBN_NFEM_URL = "https://www.cbn.gov.ng/api/GetAllNFEM_Rates";
export const CBN_ROBOTS_URL = "https://www.cbn.gov.ng/robots.txt";
const CBN_NFEM_PATH = "/api/GetAllNFEM_Rates";

/** The only currency this provider prices. */
const SUPPORTED = "NGN";

/** Sanity bounds for naira per dollar: a parse slip must not become a price. */
const MIN_PLAUSIBLE_NGN_PER_USD = 50;
const MAX_PLAUSIBLE_NGN_PER_USD = 100_000;

const MONTHS = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
];

/**
 * "November-13-2026" -> the instant that day starts in Lagos (WAT = UTC+1,
 * no DST), i.e. 23:00 UTC the day before. Null when the text is not that shape.
 */
export function parseCbnDate(text: unknown): Date | null {
  if (typeof text !== "string") return null;
  const m = /^([A-Za-z]+)-(\d{1,2})-(\d{4})$/.exec(text.trim());
  if (!m) return null;
  const month = MONTHS.indexOf(m[1].toLowerCase());
  const day = Number(m[2]);
  const year = Number(m[3]);
  if (month < 0 || day < 1 || day > 31) return null;
  const d = new Date(Date.UTC(year, month, day, 0, 0, 0) - 60 * 60 * 1000);
  // Reject overflow dates like February-31 (Date would roll them into March).
  const check = new Date(d.getTime() + 60 * 60 * 1000);
  if (check.getUTCMonth() !== month || check.getUTCDate() !== day) return null;
  return d;
}

/**
 * Pick the latest usable NFEM rate from the endpoint's JSON. Pure: the whole
 * format guess lives here and is tested against the recorded fixture. Rows
 * with a missing/invalid date or rate, or a rate outside the sanity band, are
 * skipped; if none is usable the result is null (provider "unavailable").
 */
export function parseCbnNfemRates(json: unknown): { rate: number; asOf: Date } | null {
  if (!Array.isArray(json)) return null;
  let best: { rate: number; asOf: Date } | null = null;
  for (const row of json) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    const asOf = parseCbnDate(r.ratedate);
    const rate = typeof r.weightedAvgRate === "string" || typeof r.weightedAvgRate === "number"
      ? Number(String(r.weightedAvgRate).replace(/,/g, "").trim())
      : NaN;
    if (!asOf || !Number.isFinite(rate)) continue;
    if (rate < MIN_PLAUSIBLE_NGN_PER_USD || rate > MAX_PLAUSIBLE_NGN_PER_USD) continue;
    if (!best || asOf.getTime() > best.asOf.getTime()) best = { rate, asOf };
  }
  return best;
}

/**
 * True when robots.txt disallow rules block `path`. Supports plain prefixes
 * and the `*` / `$` wildcards RFC 9309 defines. Pure.
 */
export function isPathDisallowed(disallows: string[], path: string): boolean {
  return disallows.some((rule) => {
    if (!rule) return false; // "Disallow:" with no value allows everything
    const pattern = rule
      .replace(/[.+?^{}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, ".*"); // a trailing "$" is left as the regex end anchor
    return new RegExp(`^${pattern}`).test(path);
  });
}

export class CbnRateProvider implements RateProvider {
  readonly id = "cbn" as const;
  private readonly http: AxiosInstance;

  /** `http` is injectable for tests; production uses the guarded client. */
  constructor(http?: AxiosInstance) {
    this.http =
      http ??
      createGuardedHttpClient({
        timeout: 15_000,
        maxContentLength: 5 * 1024 * 1024,
        headers: { "User-Agent": VISA_CATALOG_USER_AGENT, Accept: "application/json" },
        // We judge status ourselves (a 4xx on robots.txt means "no rules").
        validateStatus: () => true,
      });
  }

  /** Public data, no credential. */
  isConfigured(): boolean {
    return true;
  }

  supports(currency: CurrencyCode): boolean {
    return currency === SUPPORTED;
  }

  async fetchRate(currency: CurrencyCode): Promise<ProviderResult> {
    if (!this.supports(currency)) return { ok: false, reason: `CBN does not publish ${currency}` };
    try {
      // 1. robots.txt first.
      const robots = await this.http.get(CBN_ROBOTS_URL, { responseType: "text", transformResponse: (d) => d });
      if (robots.status >= 500) return { ok: false, reason: `robots.txt answered ${robots.status}` };
      if (robots.status === 200 && typeof robots.data === "string") {
        if (isPathDisallowed(parseRobotsDisallows(robots.data), CBN_NFEM_PATH)) {
          return { ok: false, reason: "robots.txt disallows the CBN rates endpoint" };
        }
      }
      // 2. The data.
      const res = await this.http.get(CBN_NFEM_URL);
      if (res.status !== 200) return { ok: false, reason: `CBN answered ${res.status}` };
      const parsed = parseCbnNfemRates(res.data);
      if (!parsed) return { ok: false, reason: "CBN response had no usable NFEM rate" };
      return { ok: true, rate: parsed.rate, asOf: parsed.asOf };
    } catch (err) {
      // Network error, timeout, or the address guard refusing: all "unavailable".
      return { ok: false, reason: `CBN request failed: ${err instanceof Error ? err.message : "unknown error"}` };
    }
  }
}
