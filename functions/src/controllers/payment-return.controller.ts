// ============================================
// Payment return page controller (issue #252)
// ============================================
//
// `GET /payments/return` — PUBLIC (no `verifyAuth`): Paystack's browser
// redirect carries no Firebase token. The handler grants nothing and reads
// nothing from the database: it only bounces the in-app browser back into the
// mobile app at the FIXED deep link `durintech://payment-return`, forwarding
// the validated Paystack reference. Payment is confirmed afterwards by the
// app through the authenticated verify endpoints, never by this redirect.
// See src/services/billing/payment-return.ts for the security model.

import { Request, Response } from "express";
import { buildAppReturnUrl, renderReturnPage } from "../services/billing/payment-return";

export class PaymentReturnController {
  /**
   * Send the browser to the app deep link. Review fix (#252): a 200 page with
   * a meta refresh + a visible "Return to Seli" link instead of a 302, because
   * some Android Custom Tabs ignore a server redirect to a custom scheme.
   */
  handleReturn(req: Request, res: Response): void {
    // Target built ONLY from the fixed app URL + the validated reference.
    const target = buildAppReturnUrl(req.query as Record<string, unknown>);

    // Never cache (each return is one-off), never leak the reference to a
    // third party through the Referer header, and lock the fallback page
    // down: no scripts, styles beyond inline, frames or external loads.
    res.set("Cache-Control", "no-store");
    res.set("Referrer-Policy", "no-referrer");
    res.set("X-Content-Type-Options", "nosniff");
    res.set(
      "Content-Security-Policy",
      "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'"
    );
    res.status(200).type("html").send(renderReturnPage(target));
  }
}

/** Shared singleton, matching the other controllers. */
export const paymentReturnController = new PaymentReturnController();
