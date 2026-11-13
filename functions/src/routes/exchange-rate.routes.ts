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
  default:
    return 400;
  }
}

/** Typed error -> JSON; anything else -> 500 without leaking details. */
function sendMoneyError(res: Response, err: unknown): void {
  if (isMoneyError(err)) {
    res.status(statusFor(err)).json({ success: false, error: err.code, message: err.message });
    return;
  }
  console.error("exchange-rate route failed:", err);
  res.status(500).json({ success: false, error: "INTERNAL_ERROR", message: "An unexpected error occurred" });
}

/**
 * Public rates. Exposes ONLY: base currency, per currency the rate (local
 * units per 1 USD), its asOf, the minor-unit exponent for display and an
 * `available` flag. NOT exposed: margin, source (it would reveal a manual
 * override), override reason/author, audit, errors, or anything per-agency or
 * per-user. No auth, and a short public cache so mobile/web can show local
 * amounts without hammering the API.
 */
export function createPublicRatesRouter(service: RateService): Router {
  const router = Router();
  router.get("/", async (_req: Request, res: Response) => {
    try {
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
      res.set("Cache-Control", "public, max-age=300, s-maxage=300");
      sendSuccess(res, { base: "USD", currencies });
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
