// ============================================
// Agency per-visa service price: HTTP handlers (issue #103)
// ============================================
//
// Mounted at `/agency/visa-prices` (./agency-visa-price.routes.ts; contract
// ./agency-visa-prices.md). Every route runs `verifyAuth` first: 401 without
// a valid token, 402 for writes on a read-only (lapsed) plan. Then:
//
//  1. Gate the CALLER (403): they must belong to an agency (`agencyId`
//     claim) AND their shared CASL ability must allow `action` on that
//     agency's visas, probed with a TAGGED subject
//     `asSubject("Visa", { ownerAgencyId, source: AGENCY_VISA_SOURCE })`.
//     Pricing is part of managing the agency's visa offering, so it uses the
//     same #98 grant as the agency visa endpoints: owner and agent of the
//     agency pass; an agent with no agency, a client (even one whose token
//     carries an agencyId) and an admin (no agency) get 403. No role
//     literals here: who may price comes from the ability only.
//  2. The agency always comes from the TOKEN, never from the URL or body, so
//     agency A can never read or write agency B's prices: B's prices live
//     under `agencies/B/...`, which no request from A can address.
//  3. Validate path + body (400 naming the field), then call the service.

import { Response } from "express";
import { AGENCY_VISA_SOURCE, Action } from "@durin-tech/authz";
import { AuthenticatedRequest } from "../middleware/auth";
import { asSubject, can, forbidden } from "../middleware/authz";
import { sendError, sendSuccess, ErrorMessages } from "../utils/response";
import { AgencyVisaError } from "../agency-visas/agency-visa.validation";
import { agencyVisaPriceService } from "./agency-visa-price.service";
import { parseVisaPriceBody, parseVisaPriceTarget } from "./agency-visa-price.validation";

// ============================================
// Helpers
// ============================================

/** The caller once gated: their agency (from the token) and uid. */
interface PriceActor {
  agencyId: string;
  uid: string;
}

/**
 * Step 1: the caller gate. Returns the actor when the caller belongs to an
 * agency and may `action` that agency's visas; otherwise answers 403 and
 * returns null.
 */
function gate(req: AuthenticatedRequest, res: Response, action: Action): PriceActor | null {
  const agencyId = req.authz?.agencyId;
  const uid = req.userId ?? req.authz?.uid;
  if (!agencyId || !uid) {
    forbidden(res, "Only members of an agency can manage its visa prices");
    return null;
  }
  // Tagged probe: the rule conditions (ownerAgencyId, source) are matched.
  const probe = asSubject("Visa", { ownerAgencyId: agencyId, source: AGENCY_VISA_SOURCE });
  if (!can(req, action, probe)) {
    forbidden(res, "You do not have access to this agency's visa prices");
    return null;
  }
  return { agencyId, uid };
}

/** Send an AgencyVisaError with its status, or a 500 for anything else. */
function sendFailure(res: Response, error: unknown, what: string): void {
  if (error instanceof AgencyVisaError) {
    res.status(error.httpStatus).json({
      success: false,
      error: error.code,
      message: error.message,
      ...(error.field ? { field: error.field } : {}),
    });
    return;
  }
  console.error(`Error ${what} agency visa price:`, error);
  sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
}

// ============================================
// Handlers
// ============================================

export class AgencyVisaPriceController {
  /**
   * GET /agency/visa-prices[?include=global]
   *
   * Every visa this agency offers with its price (or null): its own approved
   * visas plus every other visa it has priced. `include=global` also lists
   * every public (global) visa it has not priced yet, for the portal picker.
   */
  async list(req: AuthenticatedRequest, res: Response): Promise<void> {
    const actor = gate(req, res, "read");
    if (!actor) return;
    try {
      const includeGlobal = req.query?.include === "global";
      const visas = await agencyVisaPriceService.listOffered(actor.agencyId, { includeGlobal });
      sendSuccess(res, visas);
    } catch (error) {
      sendFailure(res, error, "listing");
    }
  }

  /**
   * PUT /agency/visa-prices/:countryCode/:visaTypeId  body `{ price }`
   *
   * Set or change the price (whole naira). `{ price: null }` clears it, the
   * same as DELETE. 400 on a bad value, 404 on a visa this agency can't
   * price (unknown / another agency's agency-only), 400 VISA_NOT_APPROVED on
   * its own unapproved visa. Nothing is written on any error.
   */
  async set(req: AuthenticatedRequest, res: Response): Promise<void> {
    const actor = gate(req, res, "update");
    if (!actor) return;
    try {
      const target = parseVisaPriceTarget(req.params ?? {});
      const { price } = parseVisaPriceBody(req.body);
      if (price === null) {
        await agencyVisaPriceService.clearPrice(actor.agencyId, target);
        sendSuccess(res, { ...target, price: null }, "Price cleared");
        return;
      }
      const view = await agencyVisaPriceService.setPrice(actor.agencyId, actor.uid, target, price);
      sendSuccess(res, view, "Price saved");
    } catch (error) {
      sendFailure(res, error, "setting");
    }
  }

  /**
   * DELETE /agency/visa-prices/:countryCode/:visaTypeId
   *
   * Clear the price (idempotent: 200 even when none was set).
   */
  async clear(req: AuthenticatedRequest, res: Response): Promise<void> {
    const actor = gate(req, res, "update");
    if (!actor) return;
    try {
      const target = parseVisaPriceTarget(req.params ?? {});
      await agencyVisaPriceService.clearPrice(actor.agencyId, target);
      sendSuccess(res, { ...target, price: null }, "Price cleared");
    } catch (error) {
      sendFailure(res, error, "clearing");
    }
  }
}

export const agencyVisaPriceController = new AgencyVisaPriceController();
