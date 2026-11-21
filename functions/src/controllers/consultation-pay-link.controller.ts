// ============================================
// Public pay-link routes (issue #391) — NO AUTH
// ============================================
//
//   POST /consultations/public/pay-links/lookup    { token }  the booking summary + today's price
//   POST /consultations/public/pay-links/checkout  { token }  open (or reuse) a checkout on it
//
// THE TOKEN IS IN THE BODY, NEVER IN A URL (orchestrator decision
// 2026-11-21): a path or query string lands in Cloud Run and hosting request
// logs; a JSON body does not, and nothing here logs a request body. The
// email links to the portal with the token in the URL fragment
// (`/a/<slug>/pay#t=<token>`), which the browser never sends anywhere.
//
// A guest whose payment was refunded after the agent moved the booking
// (#354, `paid_for_rescheduled_slot`) gets a one-time link by email
// (services/consultation-pay-link.service.ts). These two routes are the only
// things the link's token can do. It never signs anyone in: no session
// cookie, no Firebase token, no claim; every other route refuses it (it is
// not a Firebase ID token).
//
// ANSWERS (in the order they are checked, both routes)
//  - 429 RATE_LIMITED: too many requests from this IP (routes file);
//  - 400 VALIDATION_ERROR: `body.token` is missing, not a string, or not 43
//    base64url characters. No Firestore read at all;
//  - 410 PAY_LINK_INVALID, ONE body for every dead case (unknown, expired,
//    used, superseded, or the booking is no longer `pending_payment`): never
//    says which, and nothing is written;
//  - 503 PRICING_UNAVAILABLE: no usable rate (no Paystack call);
//  - 502 BILLING_PROVIDER_ERROR: Paystack failed (checkout only).
//
// WHAT A CALLER SEES: the allow-listed summary below. No client email or
// phone, no ids of people, no Paystack reference, no other booking.

import { Request, Response } from "express";
import type { Consultation } from "../types";
import type { Money } from "../types/money";
import { sendError, sendSuccess } from "../utils/response";
import { EMAIL_BRANDING } from "../services/email/branding";
import { clientChargeFields } from "../money/client-charge";
import { lookupCheckoutState } from "../services/charge-checkout.service";
import {
  CheckoutState,
  isPricingFailure,
  isQuoteExpired,
  lockQuote,
  reissueCheckout,
  settlePayment,
} from "../services/consultation-charge.service";
import {
  isWellFormedPayLinkToken,
  PAY_LINK_INVALID,
  PAY_LINK_INVALID_MESSAGE,
  resolvePayLink,
  ResolvedPayLink,
} from "../services/consultation-pay-link.service";
import { slotStartsAt } from "../consultations/slot-time";

// ============================================
// Answer helpers (pure)
// ============================================

/** A stored Timestamp as an ISO string (null when absent or not a Timestamp). */
function iso(value: unknown): string | null {
  const t = value as { toDate?: () => Date } | null | undefined;
  return t && typeof t.toDate === "function" ? t.toDate().toISOString() : null;
}

/**
 * The payer-safe price fields of a charge (the #332 allow-list,
 * `clientChargeFields`), with the lock times as ISO strings. These are the
 * exact fields the portal shows, and the amount Paystack is asked for is
 * `chargedAmountMinor` in `chargedCurrency`, nothing else.
 */
export function payLinkPrice(charge: Parameters<typeof clientChargeFields>[0]): {
  priceUsdCents: number | null;
  chargedCurrency: string | null;
  chargedAmountMinor: number | null;
  effectiveRate: number | null;
  quoteLockedAt: string | null;
  quoteExpiresAt: string | null;
} {
  const f = clientChargeFields(charge);
  return {
    priceUsdCents: f.priceUsdCents ?? null,
    chargedCurrency: f.chargedCurrency ?? null,
    chargedAmountMinor: f.chargedAmountMinor ?? null,
    effectiveRate: f.effectiveRate ?? null,
    quoteLockedAt: iso(f.quoteLockedAt),
    quoteExpiresAt: iso(f.quoteExpiresAt),
  };
}

/**
 * The booking summary a live link may read (allow-listed field by field):
 * the agency's name and slug, the consultation type, the NEW time, and when
 * the link expires. Nothing else from the booking is copied.
 */
export function payLinkSummary(resolved: ResolvedPayLink): Record<string, unknown> {
  const b = resolved.booking;
  let startsAt: string | null = null;
  try {
    startsAt = slotStartsAt(b).toISOString();
  } catch {
    startsAt = null;
  }
  return {
    agencyName: resolved.agency.name,
    agencySlug: resolved.link.agencySlug,
    consultationType: b.type,
    scheduledDate: iso(b.scheduledDate),
    scheduledTime: b.scheduledTime,
    timezone: b.timezone,
    durationMinutes: b.durationMinutes,
    startsAt,
    linkExpiresAt: iso(resolved.link.expiresAt),
  };
}

/** The token from a JSON body (`{ token }`); anything else is undefined. Never logged. */
function tokenFrom(req: Request): unknown {
  const body = req.body as { token?: unknown } | undefined;
  return body && typeof body === "object" ? body.token : undefined;
}

/** True when the booking carries a checkout the guest can still use as is. */
function hasLiveCheckout(c: Consultation): boolean {
  return !!c.transactionId && !!c.checkoutUrl && !isQuoteExpired(c);
}

/** The ONE dead-link answer (identical body for every case). */
function sendInvalid(res: Response): void {
  sendError(res, PAY_LINK_INVALID, PAY_LINK_INVALID_MESSAGE, 410);
}

/** 400 for a token of the wrong shape (no Firestore read happened). */
function sendMalformed(res: Response): void {
  sendError(res, "VALIDATION_ERROR", "This payment link is not valid.", 400);
}

/** 503: no usable rate (same code and wording as the other checkout routes). */
function sendPricingUnavailable(res: Response): void {
  sendError(res, "PRICING_UNAVAILABLE", "Paid consultation booking is temporarily unavailable. Please try again later.", 503);
}

/** 502 when Paystack failed (same answer as the other checkout routes); false when it is not Paystack's. */
function sendIfProviderError(res: Response, error: unknown): boolean {
  const message = (error as Error)?.message || "";
  if (!message.startsWith("PAYSTACK_ERROR")) return false;
  console.error("[pay-link] Paystack failed:", message);
  sendError(res, "BILLING_PROVIDER_ERROR", "Payment provider is temporarily unavailable. Please try again shortly.", 502);
  return true;
}

// ============================================
// Controller
// ============================================

export class ConsultationPayLinkController {
  /**
   * POST /consultations/public/pay-links/lookup  `{ token }`
   *
   * 200 `{ ...summary, price: { ...payLinkPrice, locked } }`:
   *  - a checkout opened from the link is still inside its quote lock: the
   *    price IS that checkout's (`locked: true`, the lock times set);
   *  - otherwise the price is quoted NOW, by the same `lockQuote` the
   *    checkout uses, in the booking's charge currency (the default currency
   *    for a guest), and NOT stored (`locked: false`, lock times null). The
   *    checkout route locks a fresh quote when it is called.
   * Writes nothing and calls no Paystack API.
   */
  async getPayLink(req: Request, res: Response): Promise<void> {
    try {
      const token = tokenFrom(req);
      if (!isWellFormedPayLinkToken(token)) {
        sendMalformed(res);
        return;
      }
      const resolved = await resolvePayLink(token);
      if (!resolved) {
        sendInvalid(res);
        return;
      }
      const b = resolved.booking;
      let price: ReturnType<typeof payLinkPrice> & { locked: boolean };
      if (hasLiveCheckout(b)) {
        price = { ...payLinkPrice(b), locked: true };
      } else {
        try {
          const usd: Money = { amountMinor: b.priceUsdCents!, currency: "USD" };
          const quoted = await lockQuote(usd, b.chargedCurrency!);
          // Not stored: shown without lock times (nothing is held for the guest yet).
          price = { ...payLinkPrice(quoted), quoteLockedAt: null, quoteExpiresAt: null, locked: false };
        } catch (err) {
          if (!isPricingFailure(err)) throw err;
          sendPricingUnavailable(res);
          return;
        }
      }
      sendSuccess(res, { ...payLinkSummary(resolved), price });
    } catch (error) {
      console.error("[pay-link] error reading a pay link:", error);
      sendError(res, "INTERNAL_ERROR", "An unexpected error occurred", 500);
    }
  }

  /**
   * POST /consultations/public/pay-links/checkout  `{ token }`
   *
   * Opens a checkout on the link's booking by the SAME rules as
   * `POST /consultations/:id/checkout` (issue #180), with the same shared
   * pieces (`lookupCheckoutState`, `settlePayment`, `reissueCheckout`):
   *  - the current checkout is in fact paid at Paystack: settled here
   *    (`settlePayment`, which also uses up the link): 200
   *    `{ requiresPayment: false, status }`;
   *  - Paystack reports it in progress: 409 PAYMENT_IN_PROGRESS with the SAME
   *    checkout in `data` (never re-priced while a payment may land);
   *  - inside its quote lock with a published URL: 200 with the SAME checkout
   *    (`reused: true`), never a second one;
   *  - otherwise a FRESH quote with a new QUOTE_LOCK_MINUTES lock and a new
   *    checkout, race-safe (two calls at once give one checkout). Paystack
   *    returns the guest to `<APP_URL>/a/<slug>/confirm`, which verifies as
   *    today. 200 `{ requiresPayment: true, authorizationUrl, reused: false,
   *    ...price }`.
   * Opening a checkout does NOT use up the link.
   */
  async checkout(req: Request, res: Response): Promise<void> {
    try {
      const token = tokenFrom(req);
      if (!isWellFormedPayLinkToken(token)) {
        sendMalformed(res);
        return;
      }
      const resolved = await resolvePayLink(token);
      if (!resolved) {
        sendInvalid(res);
        return;
      }
      const booking = resolved.booking;
      const slug = resolved.link.agencySlug;

      // ---- The booking's current checkout: what does Paystack say? ----
      if (booking.transactionId) {
        const { state, result } = await lookupCheckoutState(booking.transactionId);
        if (state === "paid") {
          // Paid after all: settle it (never re-charge). Only a confirmation
          // is a success here; anything else means the link is done with.
          const outcome = await settlePayment(booking.id, booking.transactionId, result!);
          if (outcome?.kind === "confirmed" || outcome?.kind === "already_paid") {
            sendSuccess(res, { requiresPayment: false, status: outcome.consultation.status });
            return;
          }
          sendInvalid(res);
          return;
        }
        if (state === "in_progress") {
          res.status(409).json({
            success: false,
            error: "PAYMENT_IN_PROGRESS",
            message: "A payment for this booking is still being processed. Please wait a few minutes and check again.",
            data: { authorizationUrl: booking.checkoutUrl ?? null, ...payLinkPrice(booking) },
          });
          return;
        }
        if (hasLiveCheckout(booking)) {
          sendSuccess(res, {
            requiresPayment: true,
            authorizationUrl: booking.checkoutUrl,
            reused: true,
            ...payLinkPrice(booking),
          });
          return;
        }
      }

      // ---- Lock passed (or no checkout): a fresh quote and a new checkout ----
      let state: CheckoutState;
      try {
        state = await reissueCheckout(booking, {
          fallbackCallbackUrl: `${EMAIL_BRANDING.appUrl}/a/${slug}/confirm`,
          // Explicit, so the guest always returns to the agency's confirm page.
          callbackUrl: `${EMAIL_BRANDING.appUrl}/a/${slug}/confirm`,
          metadata: { agencySlug: slug },
        });
      } catch (err) {
        if (!isPricingFailure(err)) throw err;
        sendPricingUnavailable(res);
        return;
      }
      switch (state.kind) {
      case "checkout":
        sendSuccess(res, {
          requiresPayment: true,
          authorizationUrl: state.authorizationUrl,
          reused: !state.opened,
          ...payLinkPrice(state.consultation),
        });
        return;
      case "opening":
        // Another request is opening it right now: try again in a moment.
        sendError(res, "CHECKOUT_OPENING", "Your checkout is being prepared. Please try again in a moment.", 409);
        return;
      default:
        // Paid or closed meanwhile: the link is dead.
        sendInvalid(res);
        return;
      }
    } catch (error) {
      if (sendIfProviderError(res, error)) return;
      console.error("[pay-link] error opening a pay-link checkout:", error);
      sendError(res, "INTERNAL_ERROR", "An unexpected error occurred", 500);
    }
  }
}

export const consultationPayLinkController = new ConsultationPayLinkController();
