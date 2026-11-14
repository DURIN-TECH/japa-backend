// ============================================
// Agency per-visa service price: HTTP handlers (issue #103)
// ============================================
//
// Mounted at `/agency/visa-prices` (./agency-visa-price.routes.ts; contract
// ./agency-visa-prices.md). Every route runs `verifyAuth` first: 401 without
// a valid token, 402 for writes on a read-only (lapsed) plan. Then:
//
//  1. Gate the CALLER (`gate()` below). Who may do what (issue #227):
//
//     | Caller                               | GET (read) | PUT / DELETE (write) |
//     | ------------------------------------ | ---------- | -------------------- |
//     | owner of the agency                  | 200        | 200                  |
//     | admin (names the agency, ?agencyId=) | 200        | 200                  |
//     | member agent of the agency           | 200        | 403, nothing written |
//     | owner / agent of another agency      | 403        | 403                  |
//     | client, agent with no agency         | 403        | 403                  |
//
//     - Member-or-better is still the shared CASL ability on a TAGGED probe
//       `asSubject("Visa", { ownerAgencyId, source: AGENCY_VISA_SOURCE })`
//       (the #98 grant the agency visa endpoints use). That rule is NOT
//       changed here: agents keep creating / editing agency visas (#106).
//     - Writes then add a PRICING-ONLY owner check on top
//       (`agencyService.getOwnedAgencyForPrincipal`, the same check
//       `PUT /agencies/me` uses): the resolved principal must be the owner
//       of exactly this agency AND the agency record must name them.
//       Product decision 2026-11-14: "only owners and admin" set prices.
//     - Reads stay open to member agents: the agency side's start-case
//       picker shows the agency's price next to each visa (see "For #106"
//       in the contract), so agents need to read the list.
//     - Admins (by claim, the same two signals `verifyAdmin` accepts) have
//       no agency in their token, so they name it with `?agencyId=` (400
//       when missing, 404 when no such agency).
//  2. For everyone but an admin the agency always comes from the TOKEN,
//     never from the URL or body, so agency A can never read or write agency
//     B's prices. A non-admin who sends `?agencyId=` for another agency is a
//     403, never a silent switch to their own agency.
//  3. Validate path + body (400 naming the field), then call the service.

import { Response } from "express";
import { AGENCY_VISA_SOURCE, ROLES } from "@durin-tech/authz";
import { AuthenticatedRequest } from "../middleware/auth";
import { asSubject, can, forbidden } from "../middleware/authz";
import { sendError, sendSuccess, ErrorMessages } from "../utils/response";
import { agencyService } from "../services/agency.service";
import { AgencyVisaError } from "../agency-visas/agency-visa.validation";
import { agencyVisaPriceService } from "./agency-visa-price.service";
import { parseVisaPriceBody, parseVisaPriceTarget } from "./agency-visa-price.validation";

// ============================================
// Helpers
// ============================================

/** The caller once gated: the agency acted on and the caller's uid. */
interface PriceActor {
  agencyId: string;
  uid: string;
}

/**
 * What the request does to the price list:
 *  - "read":  GET, the list (owner, member agent, admin);
 *  - "write": PUT / DELETE, set or clear a price (owner, admin only; #227).
 */
type PriceAccess = "read" | "write";

/**
 * True when the caller is a platform admin BY CLAIM: the canonical `role`
 * claim or the legacy `admin: true` boolean (the same two signals
 * `verifyAdmin` and AgencyController.isAdmin accept). Never a document field.
 */
function isAdmin(req: AuthenticatedRequest): boolean {
  return req.authz?.role === ROLES.ADMIN || req.user?.admin === true;
}

/**
 * The `?agencyId=` query value, or undefined when it was not sent. Only a
 * single plain string counts; an array (`?agencyId=a&agencyId=b`) or an
 * object is treated as a bad value (empty string) so it can never match.
 */
function queryAgencyId(req: AuthenticatedRequest): string | undefined {
  const raw = req.query?.agencyId;
  if (raw === undefined) return undefined;
  return typeof raw === "string" ? raw : "";
}

/**
 * Step 1: the caller gate (see the table at the top of this file).
 *
 * Returns the actor when the caller may `access` the price list, otherwise
 * sends the error response (400 / 403 / 404) and returns null. Runs before
 * any validation or service call, so a refused caller never writes.
 */
async function gate(
  req: AuthenticatedRequest,
  res: Response,
  access: PriceAccess
): Promise<PriceActor | null> {
  const uid = req.userId ?? req.authz?.uid;
  if (!uid) {
    forbidden(res, "Only members of an agency can manage its visa prices");
    return null;
  }

  // ---- Admin: acts on the agency named in `?agencyId=` (issue #227) ----
  if (isAdmin(req)) {
    const agencyId = queryAgencyId(req);
    // A usable document id only (never let doc() throw on "a/b").
    if (!agencyId || agencyId.includes("/")) {
      sendError(res, "VALIDATION_ERROR", "agencyId: name the agency whose visa prices to manage", 400);
      return null;
    }
    const agency = await agencyService.getAgencyById(agencyId);
    if (!agency) {
      sendError(res, "NOT_FOUND", "Agency not found", 404);
      return null;
    }
    return { agencyId, uid };
  }

  // ---- Everyone else: the agency comes from the token ----
  const agencyId = req.authz?.agencyId;
  if (!agencyId) {
    forbidden(res, "Only members of an agency can manage its visa prices");
    return null;
  }
  // A non-admin can't address another agency through the query.
  const named = queryAgencyId(req);
  if (named !== undefined && named !== agencyId) {
    forbidden(res, "You do not have access to this agency's visa prices");
    return null;
  }

  // Member-or-better: the shared #98 CASL grant on the agency's visas.
  // Tagged probe: the rule conditions (ownerAgencyId, source) are matched.
  // A client whose token carries an agencyId fails here.
  const probe = asSubject("Visa", { ownerAgencyId: agencyId, source: AGENCY_VISA_SOURCE });
  if (!can(req, access === "read" ? "read" : "update", probe)) {
    forbidden(res, "You do not have access to this agency's visa prices");
    return null;
  }

  // Writes: owner only (issue #227). The shared owner check, also used by
  // PUT /agencies/me: owner role on this agency AND the agency record names
  // the caller. A member agent passes the CASL probe above but stops here.
  if (access === "write") {
    const owned = await agencyService.getOwnedAgencyForPrincipal(req.authz);
    if (!owned || owned.id !== agencyId) {
      forbidden(res, "Only the agency owner or an admin can set visa prices");
      return null;
    }
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
    try {
      // Inside the try: the gate reads Firestore (owner / agency lookup),
      // and a failed read must answer 500, not hang the request.
      const actor = await gate(req, res, "read");
      if (!actor) return;
      const includeGlobal = req.query?.include === "global";
      const visas = await agencyVisaPriceService.listOffered(actor.agencyId, { includeGlobal });
      sendSuccess(res, visas);
    } catch (error) {
      sendFailure(res, error, "listing");
    }
  }

  /**
   * PUT /agency/visa-prices/:countryCode/:visaTypeId  body `{ priceUsd }`
   *
   * Set or change the price, in US dollars (issue #179):
   * `{ priceUsd: { amount: "125.00", currency: "USD" } }`. `{ priceUsd: null }` clears it, the
   * same as DELETE. 400 on a bad value, 404 on a visa this agency can't
   * price (unknown / another agency's agency-only), 400 VISA_NOT_APPROVED on
   * its own unapproved visa. Nothing is written on any error.
   */
  async set(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      // Inside the try: the gate reads Firestore (owner / agency lookup),
      // and a failed read must answer 500, not hang the request.
      const actor = await gate(req, res, "write");
      if (!actor) return;
      const target = parseVisaPriceTarget(req.params ?? {});
      const { priceUsd } = parseVisaPriceBody(req.body);
      if (priceUsd === null) {
        await agencyVisaPriceService.clearPrice(actor.agencyId, target);
        sendSuccess(res, { ...target, priceUsd: null }, "Price cleared");
        return;
      }
      const view = await agencyVisaPriceService.setPrice(actor.agencyId, actor.uid, target, priceUsd);
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
    try {
      // Inside the try: the gate reads Firestore (owner / agency lookup),
      // and a failed read must answer 500, not hang the request.
      const actor = await gate(req, res, "write");
      if (!actor) return;
      const target = parseVisaPriceTarget(req.params ?? {});
      await agencyVisaPriceService.clearPrice(actor.agencyId, target);
      sendSuccess(res, { ...target, priceUsd: null }, "Price cleared");
    } catch (error) {
      sendFailure(res, error, "clearing");
    }
  }
}

export const agencyVisaPriceController = new AgencyVisaPriceController();
