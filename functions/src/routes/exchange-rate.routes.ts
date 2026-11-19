import { Router, Request, Response } from "express";
import { verifyAdmin, verifyAuth, type AuthenticatedRequest } from "../middleware/auth";
import { sendSuccess } from "../utils/response";
import { isMoneyError, MoneyError, rateService } from "../money";
import type { RateService } from "../money";
import { getCurrencyInfo } from "../money/currencies";

// ============================================
// EXCHANGE RATE ROUTES (issue #178)
// ============================================
//
//   GET    /rates                         PUBLIC. Current rate per supported currency.
//   GET    /admin/exchange-rates          admin: stored state + override history
//   PUT    /admin/exchange-rates/:currency    admin: set a manual rate { rate, reason, ttlHours? }
//   DELETE /admin/exchange-rates/:currency    admin: clear it { reason }
//   POST   /admin/exchange-rates/:currency/reset-reference  admin: accept a large provider move { reason }
//   POST   /admin/exchange-rates/:currency/refresh          admin: refresh from the provider now { reason? }
//                                                           (issue #214; audited; 1 per currency per 5 min, else 429)
//   PUT    /admin/exchange-rates/:currency/hold   admin: hold (pin) the rate { rate, reason, ttlHours } (issue #241)
//   DELETE /admin/exchange-rates/:currency/hold   admin: clear the hold { reason } (issue #241)
//
// The factories take the RateService so tests can mount them on a fake.

/** HTTP status for each typed money error. */
function statusFor(err: MoneyError): number {
  switch (err.code) {
  case "RATE_UNAVAILABLE":
  case "RATE_STALE":
    return 503;
  case "CURRENCY_UNSUPPORTED":
    return 404;
  case "RATE_LIMITED":
    return 429;
  default:
    return 400;
  }
}

/** Typed error -> JSON; anything else -> 500 without leaking details. */
function sendMoneyError(res: Response, err: unknown): void {
  if (isMoneyError(err)) {
    // A rate-limited caller is told when to come back.
    if (err.code === "RATE_LIMITED" && err.retryAfterSeconds) res.set("Retry-After", String(err.retryAfterSeconds));
    res.status(statusFor(err)).json({ success: false, error: err.code, message: err.message });
    return;
  }
  console.error("exchange-rate route failed:", err);
  res.status(500).json({ success: false, error: "INTERNAL_ERROR", message: "An unexpected error occurred" });
}

/** How long one instance reuses a built GET /rates body (issue #214). */
export const PUBLIC_RATES_CACHE_MS = 60_000;

/** Options for the public router; tests pass a fake clock or a cache length. */
export interface PublicRatesRouterOptions {
  /** Cache lifetime in ms (default PUBLIC_RATES_CACHE_MS; 0 turns the cache off). */
  cacheMs?: number;
  /** Clock in epoch ms (default Date.now). */
  now?: () => number;
}

/**
 * Public rates. Exposes ONLY: base currency, per currency the rate (local
 * units per 1 USD), its asOf, the minor-unit exponent for display and an
 * `available` flag. NOT exposed: margin, source (it would reveal a manual
 * override), override reason/author, audit, errors, or anything per-agency or
 * per-user. A held rate (issue #241) is shown simply as the rate: nothing says
 * it is held. No auth, and a short public cache so mobile/web can show local
 * amounts without hammering the API.
 */
export function createPublicRatesRouter(service: RateService, opts: PublicRatesRouterOptions = {}): Router {
  const router = Router();
  const cacheMs = opts.cacheMs ?? PUBLIC_RATES_CACHE_MS;
  const now = opts.now ?? Date.now;
  // ---------- in-process cache (issue #214) ----------
  // The route is unauthenticated and each uncached request costs one config
  // read plus one read per currency, so the built body is kept for `cacheMs`.
  // It is dropped at once when THIS instance changes a rate (override set or
  // cleared, hold set or cleared (#241), reference reset, refresh):
  // `service.changeVersion` moves on.
  // Other instances pick the change up when their cache expires (60s at most).
  // Only successful bodies are cached; an error is never served from cache.
  let cached: { at: number; version: number; body: { base: string; currencies: unknown[] } } | null = null;

  router.get("/", async (_req: Request, res: Response) => {
    try {
      const t = now();
      if (cached && cached.version === service.changeVersion && t - cached.at < cacheMs) {
        res.set("Cache-Control", "public, max-age=300, s-maxage=300");
        sendSuccess(res, cached.body);
        return;
      }
      const version = service.changeVersion;
      const config = await service.getConfig();
      const currencies = [];
      for (const [code, entry] of Object.entries(config.currencies)) {
        if (!entry.enabled) continue; // a disabled currency is not offered
        const exponent = getCurrencyInfo(code)?.exponent ?? 2;
        try {
          const r = await service.getRate(code, config);
          currencies.push({ currency: code, exponent, available: true, rate: r.rate, asOf: r.asOf });
        } catch (err) {
          if (!isMoneyError(err)) throw err;
          // Stale or missing: say so, never show a number.
          currencies.push({ currency: code, exponent, available: false, rate: null, asOf: null });
        }
      }
      const body = { base: "USD", currencies };
      // Stamped with the version read BEFORE building, so a change made while
      // building makes this entry stale at once rather than hiding the change.
      if (cacheMs > 0) cached = { at: t, version, body };
      res.set("Cache-Control", "public, max-age=300, s-maxage=300");
      sendSuccess(res, body);
    } catch (err) {
      sendMoneyError(res, err);
    }
  });
  return router;
}

/** Admin override routes. Every route is verifyAuth (401) + verifyAdmin (403 for every other role). */
export function createAdminExchangeRateRouter(service: RateService): Router {
  const router = Router();

  router.get("/", verifyAuth, verifyAdmin, async (_req: Request, res: Response) => {
    try {
      sendSuccess(res, { currencies: await service.adminOverview() });
    } catch (err) {
      sendMoneyError(res, err);
    }
  });

  router.put("/:currency", verifyAuth, verifyAdmin, async (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const uid = (req as AuthenticatedRequest).userId as string;
      const stored = await service.setOverride(
        req.params.currency,
        { rate: body.rate, reason: body.reason, ttlHours: body.ttlHours },
        uid
      );
      sendSuccess(res, stored, "Override saved");
    } catch (err) {
      sendMoneyError(res, err);
    }
  });

  // Accept a genuine large move: drops the stored provider rate (audited).
  router.post("/:currency/reset-reference", verifyAuth, verifyAdmin, async (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const uid = (req as AuthenticatedRequest).userId as string;
      await service.resetReference(req.params.currency, body.reason, uid);
      sendSuccess(res, { reset: true }, "Provider rate reset; the next refresh sets the new level");
    } catch (err) {
      sendMoneyError(res, err);
    }
  });

  // Issue #214: refresh from the provider now (way back from a mistaken
  // reset-reference). Same gate as every admin route; the service audits it
  // and rate-limits it (429 with Retry-After).
  router.post("/:currency/refresh", verifyAuth, verifyAdmin, async (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const uid = (req as AuthenticatedRequest).userId as string;
      const outcome = await service.refreshNow(req.params.currency, body.reason, uid);
      sendSuccess(res, outcome, outcome.ok ? "Rate refreshed" : "Refresh failed; the stored rate is unchanged");
    } catch (err) {
      sendMoneyError(res, err);
    }
  });

  // ---------- hold (issue #241) ----------
  // Pin a currency's rate while the provider lags (e.g. CBN behind a real
  // devaluation). Same gate as every admin route; the service validates
  // (plausible range, reason 5-500, ttlHours 1-168, no corrupt provider map)
  // and writes the hold with its audit entry in one transaction. Registered
  // as `/:currency/hold`, which `/:currency` never matches (a param stops at
  // a slash), so the override routes are unaffected.
  router.put("/:currency/hold", verifyAuth, verifyAdmin, async (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const uid = (req as AuthenticatedRequest).userId as string;
      const hold = await service.setHold(
        req.params.currency,
        { rate: body.rate, reason: body.reason, ttlHours: body.ttlHours },
        uid
      );
      sendSuccess(res, hold, "Rate held");
    } catch (err) {
      sendMoneyError(res, err);
    }
  });

  router.delete("/:currency/hold", verifyAuth, verifyAdmin, async (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const uid = (req as AuthenticatedRequest).userId as string;
      await service.clearHold(req.params.currency, body.reason, uid);
      sendSuccess(res, { cleared: true }, "Hold cleared; normal rate rules apply again");
    } catch (err) {
      sendMoneyError(res, err);
    }
  });

  router.delete("/:currency", verifyAuth, verifyAdmin, async (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const uid = (req as AuthenticatedRequest).userId as string;
      await service.clearOverride(req.params.currency, body.reason, uid);
      sendSuccess(res, { cleared: true }, "Override cleared");
    } catch (err) {
      sendMoneyError(res, err);
    }
  });

  return router;
}

export const publicRatesRoutes = createPublicRatesRouter(rateService);
export const adminExchangeRateRoutes = createAdminExchangeRateRouter(rateService);
