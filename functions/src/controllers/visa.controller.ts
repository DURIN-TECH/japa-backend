import { Request, Response } from "express";
import { AuthenticatedRequest } from "../middleware/auth";
import { visaService } from "../services/visa.service";
import {
  sendSuccess,
  sendError,
  sendCreated,
  ErrorMessages,
} from "../utils/response";
import { VisaCategory, VisaType } from "../types";
// Public visibility rule for visas (issue #99).
import { isVisaPubliclyVisible } from "../services/visa.service";
// Agency drafts can't be reviewed (issue #100).
import { VisaIsDraftError } from "../services/visa.service";
// Typed error from the approval guard (fee not converted to USD, issue #59).
import { VisaFeeNotConvertibleError } from "../scrapers";
// Manual USD cost (issue #70): CASL gate, body validation, typed errors.
import { asSubject, can, forbidden } from "../middleware/authz";
import { ManualCostError, parseManualCostInput } from "../scrapers";
import { isValidDocId } from "../scrapers";

/**
 * Whether this request may read a visa on the single-visa public endpoints
 * (`GET /countries/:code/visas/:visaId` and `/full`), issue #99.
 *
 *  - A publicly visible visa (isVisaPubliclyVisible): anyone, signed in or not.
 *  - Any other visa (pending, rejected, inactive, agency-only): only a
 *    principal whose shared CASL ability allows `read` on THIS visa. Today
 *    `Visa` is admin-only (`manage all`), so that is admins; the routes use
 *    `optionalAuth`, so `req.ability` is only set when a valid token was sent.
 *    The check is on the concrete visa (asSubject), so any conditional rule a
 *    later authz version adds (e.g. #98's own-agency read) is matched
 *    against the visa's fields, never granted blanket.
 *
 * No role literals: the decision comes from the ability.
 */
function canReadVisa(req: AuthenticatedRequest, visa: VisaType): boolean {
  if (isVisaPubliclyVisible(visa)) return true;
  return can(req, "read", asSubject("Visa", { ...visa }));
}

export class VisaController {
  // ============================================
  // COUNTRY ENDPOINTS
  // ============================================

  /**
   * GET /countries
   * Get all supported countries
   */
  async getCountries(req: Request, res: Response): Promise<void> {
    try {
      const includeUnsupported = req.query.includeUnsupported === "true";
      const countries = await visaService.getCountries(!includeUnsupported);

      sendSuccess(res, countries);
    } catch (error) {
      console.error("Error getting countries:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  /**
   * GET /countries/:code
   * Get country by code
   */
  async getCountry(req: Request, res: Response): Promise<void> {
    try {
      const { code } = req.params;
      const country = await visaService.getCountryByCode(code);

      if (!country) {
        sendError(res, "NOT_FOUND", "Country not found", 404);
        return;
      }

      sendSuccess(res, country);
    } catch (error) {
      console.error("Error getting country:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  /**
   * POST /countries (admin only)
   * Create a new country
   */
  async createCountry(
    req: AuthenticatedRequest,
    res: Response
  ): Promise<void> {
    try {
      const { code, name, flagUrl, isSupported } = req.body;

      if (!code || !name) {
        sendError(
          res,
          "VALIDATION_ERROR",
          "code and name are required",
          400
        );
        return;
      }

      const country = await visaService.createCountry({
        code,
        name,
        flagUrl,
        isSupported,
      });

      sendCreated(res, country, "Country created successfully");
    } catch (error) {
      console.error("Error creating country:", error);
      if ((error as Error).message === "Country already exists") {
        sendError(res, "DUPLICATE", "Country already exists", 409);
        return;
      }
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  // ============================================
  // VISA TYPE ENDPOINTS
  // ============================================

  /**
   * GET /countries/:code/visas
   * Get all visa types for a country. Public: only publicly visible visas
   * (both service reads apply isVisaPubliclyVisible, issue #99).
   */
  async getVisaTypes(req: Request, res: Response): Promise<void> {
    try {
      const { code } = req.params;
      const { category } = req.query;

      // Check country exists
      const country = await visaService.getCountryByCode(code);
      if (!country) {
        sendError(res, "NOT_FOUND", "Country not found", 404);
        return;
      }

      let visaTypes;
      if (category) {
        visaTypes = await visaService.getVisaTypesByCategory(
          code,
          category as VisaCategory
        );
      } else {
        visaTypes = await visaService.getVisaTypesByCountry(code);
      }

      sendSuccess(res, visaTypes);
    } catch (error) {
      console.error("Error getting visa types:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  /**
   * GET /countries/:code/visas/:visaId
   * Get visa type details.
   *
   * Issue #99: 404 for a visa the caller may not read (canReadVisa) — the
   * same answer as an unknown id, so a hidden visa's existence never leaks.
   * Internal callers keep the unfiltered visaService.getVisaType.
   */
  async getVisaType(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { code, visaId } = req.params;

      const visaType = await visaService.getVisaType(code, visaId);

      if (!visaType || !canReadVisa(req, visaType)) {
        sendError(res, "NOT_FOUND", "Visa type not found", 404);
        return;
      }

      sendSuccess(res, visaType);
    } catch (error) {
      console.error("Error getting visa type:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  /**
   * GET /countries/:code/visas/:visaId/full
   * Get visa type with requirements.
   *
   * Issue #99: same rule as getVisaType — 404 unless the visa is publicly
   * visible or the caller's ability allows reading it (admins). The visa is
   * checked BEFORE its requirements are read, so a hidden visa costs no
   * requirements query.
   */
  async getVisaTypeWithRequirements(
    req: AuthenticatedRequest,
    res: Response
  ): Promise<void> {
    try {
      const { code, visaId } = req.params;

      const visaType = await visaService.getVisaType(code, visaId);

      if (!visaType || !canReadVisa(req, visaType)) {
        sendError(res, "NOT_FOUND", "Visa type not found", 404);
        return;
      }

      const requirements = await visaService.getRequirements(code, visaId);

      sendSuccess(res, { visaType, requirements });
    } catch (error) {
      console.error("Error getting visa type with requirements:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  /**
   * POST /countries/:code/visas (admin only)
   * Create a new visa type
   */
  async createVisaType(
    req: AuthenticatedRequest,
    res: Response
  ): Promise<void> {
    try {
      const { code } = req.params;
      const input = req.body;

      // Validate required fields
      const requiredFields = [
        "name",
        "code",
        "description",
        "category",
        "processingTime",
        "processingDaysMin",
        "processingDaysMax",
        "baseCostUsd",
        "validityPeriod",
        "eligibilityCriteria",
      ];

      const missing = requiredFields.filter((f) => !input[f]);
      if (missing.length > 0) {
        sendError(
          res,
          "VALIDATION_ERROR",
          `Missing required fields: ${missing.join(", ")}`,
          400
        );
        return;
      }

      // Issue #99: created pending + hidden (isActive false, agency-only);
      // the admin's uid is recorded as `createdBy`.
      const visaType = await visaService.createVisaType(
        {
          ...input,
          countryCode: code,
        },
        req.userId
      );

      sendCreated(res, visaType, "Visa type created successfully");
    } catch (error) {
      console.error("Error creating visa type:", error);
      if ((error as Error).message === "Country not found") {
        sendError(res, "NOT_FOUND", "Country not found", 404);
        return;
      }
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  // ============================================
  // REQUIREMENT ENDPOINTS
  // ============================================

  /**
   * GET /countries/:code/visas/:visaId/requirements
   * Get all requirements for a visa type
   */
  async getRequirements(req: Request, res: Response): Promise<void> {
    try {
      const { code, visaId } = req.params;

      const requirements = await visaService.getRequirements(code, visaId);
      sendSuccess(res, requirements);
    } catch (error) {
      console.error("Error getting requirements:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  /**
   * POST /countries/:code/visas/:visaId/requirements (admin only)
   * Create a new requirement
   */
  async createRequirement(
    req: AuthenticatedRequest,
    res: Response
  ): Promise<void> {
    try {
      const { code, visaId } = req.params;
      const input = req.body;

      // Validate required fields
      if (
        !input.title ||
        !input.description ||
        !input.estimatedTime ||
        input.orderIndex === undefined
      ) {
        sendError(
          res,
          "VALIDATION_ERROR",
          "title, description, estimatedTime, and orderIndex are required",
          400
        );
        return;
      }

      const requirement = await visaService.createRequirement(
        code,
        visaId,
        input
      );

      sendCreated(res, requirement, "Requirement created successfully");
    } catch (error) {
      console.error("Error creating requirement:", error);
      if ((error as Error).message === "Visa type not found") {
        sendError(res, "NOT_FOUND", "Visa type not found", 404);
        return;
      }
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  // ============================================
  // ADMIN ENDPOINTS
  // ============================================

  /**
   * GET /admin/visas
   * Get all visa types for admin review
   */
  async getAdminVisas(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const visas = await visaService.getAllVisaTypesForAdmin();
      sendSuccess(res, visas);
    } catch (error) {
      console.error("Error getting admin visas:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  /**
   * PATCH /admin/visas/:id/review
   * Approve or reject a visa type
   */
  async reviewVisa(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const { action, reason, countryCode } = req.body;

      if (!action || !["approve", "reject"].includes(action)) {
        sendError(res, "VALIDATION_ERROR", "action must be 'approve' or 'reject'", 400);
        return;
      }

      if (action === "reject" && !reason) {
        sendError(res, "VALIDATION_ERROR", "reason is required when rejecting", 400);
        return;
      }

      if (!countryCode) {
        sendError(res, "VALIDATION_ERROR", "countryCode is required", 400);
        return;
      }

      const updatedVisa = await visaService.updateVisaReviewStatus(
        countryCode,
        id,
        action,
        req.userId!,
        reason
      );

      sendSuccess(res, updatedVisa, `Visa ${action === "approve" ? "approved" : "rejected"} successfully`);
    } catch (error) {
      console.error("Error reviewing visa:", error);
      if ((error as Error).message === "Visa type not found") {
        sendError(res, "NOT_FOUND", "Visa type not found", 404);
        return;
      }
      // Approval refused: no usable USD cost (stale/missing FX rate,
      // unverified fee, or no/mismatched baseCostUsd). 409 Conflict — the
      // visa's state blocks approval until the crawl re-runs (or reject it).
      if (error instanceof VisaFeeNotConvertibleError) {
        sendError(res, error.code, error.message, 409);
        return;
      }
      // Issue #100: an unsubmitted agency draft is not reviewable.
      if (error instanceof VisaIsDraftError) {
        sendError(res, error.code, error.message, 409);
        return;
      }
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  /**
   * PUT /admin/visas/:id/manual-cost (issue #70)
   *
   * Set the USD cost of a PENDING scraped visa by hand, when the scraper
   * could not convert its fee (no rate for the currency, unverified fee, no
   * published fee). Body:
   *   { countryCode: "TW", amountUsd: 52, reason: "<10-500 chars>",
   *     rates: [{ currency: "TWD", usdPerUnit: 0.031 }],   // one per non-USD fee currency
   *     expectedContentHash?: "<scrapeMeta.contentHash the admin saw>",
   *     expectedExtractedAt?: "<scrapeMeta.extractedAt as ISO 8601>" }
   * amountUsd: finite, 0 <= x <= 100000 (0 = confirmed free visa).
   * 200 → the updated visa. 400 VALIDATION_ERROR, 403 FORBIDDEN, 404
   * NOT_FOUND, 409 NOT_PENDING_SCRAPED / FEE_ALREADY_CONVERTED / STALE_VISA.
   *
   * Authz: the shared CASL ability, `update` on the `Visa` subject
   * (@durin-tech/authz >= 0.1.4: a catalog visa type, admin-only via
   * `manage all`). This writes the visa document itself, so it is gated on
   * `Visa`, NOT on `VisaChange` (that subject is a pending edit *proposal*
   * in `pendingVisaChanges`, a different resource). Checked FIRST, before
   * validation or any read, so nothing about the visa leaks to non-admins.
   * No role literals.
   */
  async setManualCost(req: AuthenticatedRequest, res: Response): Promise<void> {
    const { id } = req.params;
    // ---- CASL gate ----
    // `update Visa`: an admin edit to the visa document itself (see above).
    if (!can(req, "update", asSubject("Visa", { id }))) {
      forbidden(res, "Only admins can set a visa's cost by hand");
      return;
    }
    try {
      // ---- Validate ----
      // An unaddressable id (e.g. "__x__") would make Firestore throw → 404.
      if (!isValidDocId(id)) {
        sendError(res, "NOT_FOUND", "Visa type not found", 404);
        return;
      }
      const input = parseManualCostInput(req.body);

      // ---- Write (one transaction) ----
      const updated = await visaService.setManualCost(id, input, req.userId!);
      sendSuccess(res, updated, "Manual cost set");
    } catch (error) {
      if (error instanceof ManualCostError) {
        sendError(res, error.code, error.message, error.httpStatus);
        return;
      }
      console.error("Error setting manual visa cost:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  // ============================================
  // SEARCH ENDPOINTS
  // ============================================

  /**
   * GET /visas
   * Get all visa types across all countries with optional filtering
   */
  async getAllVisaTypes(req: Request, res: Response): Promise<void> {
    try {
      const { category, limit, offset } = req.query;

      const result = await visaService.getAllVisaTypes({
        category: category as VisaCategory | undefined,
        limit: limit ? parseInt(limit as string) : undefined,
        offset: offset ? parseInt(offset as string) : undefined,
      });

      sendSuccess(res, result);
    } catch (error) {
      console.error("Error getting all visa types:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  /**
   * GET /visas/search
   * Search visa types across all countries
   */
  async searchVisaTypes(req: Request, res: Response): Promise<void> {
    try {
      const { q } = req.query;

      if (!q || typeof q !== "string") {
        sendError(res, "VALIDATION_ERROR", "Search query is required", 400);
        return;
      }

      const results = await visaService.searchVisaTypes(q);
      sendSuccess(res, results);
    } catch (error) {
      console.error("Error searching visa types:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  /**
   * GET /visas/popular
   * Get popular visa types
   */
  async getPopularVisaTypes(req: Request, res: Response): Promise<void> {
    try {
      const limit = parseInt(req.query.limit as string) || 10;
      const visaTypes = await visaService.getPopularVisaTypes(limit);

      sendSuccess(res, visaTypes);
    } catch (error) {
      console.error("Error getting popular visa types:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }
}

export const visaController = new VisaController();
