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
// Agency drafts can't be reviewed (issue #100).
import { VisaIsDraftError } from "../services/visa.service";
// Typed error from the approval guard (fee not converted to USD, issue #59).
import { MissingItemsUnacknowledgedError, VisaFeeNotConvertibleError } from "../scrapers";
// Manual USD cost (issue #70): CASL gate, body validation, typed errors.
import { asSubject, can, forbidden } from "../middleware/authz";
import { ManualCostError, parseManualCostInput } from "../scrapers";
import { isValidDocId } from "../scrapers";
// Agency visas, admin side (issue #101): list enrichment + filters, the
// stricter agency review, make-global. AgencyVisaError carries code + status.
import { AGENCY_VISA_SOURCE } from "@durin-tech/authz";
import { VISA_VISIBILITY, VisaVisibility } from "../types";
// Who may read an agency-only visa, and its applicant-safe view (issue #102).
// Imported from its file (not the module index) to keep the import graph flat.
import { agencyVisaAccessService } from "../agency-visas/agency-visa-access";
import {
  ADMIN_VISA_SOURCE_FILTERS,
  AdminVisaFilters,
  AdminVisaSourceFilter,
  AgencyVisaError,
  agencyVisaReviewService,
  agencyVisaScreeningService,
  parseExpectedTimestamp,
} from "../agency-visas";

/**
 * Admin gate for the visa review routes (issue #101), on top of the routes'
 * `verifyAdmin`: the caller's shared CASL ability must allow writing
 * `field` (`reviewStatus` for review / the review list, `visibility` for
 * make-global) of the visa. The subject is always TAGGED (`asSubject`),
 * never the "Visa" string: a string-subject check ignores conditions, so an
 * agency owner's conditional #98 grant would wrongly pass it.
 *
 *  - Before any read, `visa` is a tagged empty probe: only an unconditional
 *    grant (admins' `manage all`) matches it, so non-admins get 403 without
 *    learning whether the visa exists.
 *  - On the real doc (inside the service transaction) it is re-checked with
 *    the doc's fields: an agency owner of the visa matches the conditional
 *    grant but is refused by the field-level `cannot` on review and
 *    visibility fields (VISA_PROTECTED_FIELDS).
 */
function canAdminWriteVisa(
  req: AuthenticatedRequest,
  field: "reviewStatus" | "visibility",
  visa: Record<string, unknown> = {}
): boolean {
  // A copy, so the CASL tag never ends up on an object that gets written.
  return req.ability?.can("update", asSubject("Visa", { ...visa }) as never, field) ?? false;
}

/**
 * What the single-visa public endpoints (`GET /countries/:code/visas/:visaId`,
 * `/full` and `/requirements`) serve to this request, or null for a 404.
 *
 * Issue #99 introduced the rule (public visa: anyone; otherwise only a
 * principal whose shared CASL ability allows `read` on THIS visa, checked on
 * a tagged subject, never the "Visa" string). Issue #102 extends it in ONE
 * place, `agencyVisaAccessService.visaForCaller`:
 *  - admins and the owning agency's members: the doc as stored;
 *  - a public visa: everyone (an agency-created one projected to its
 *    applicant-safe fields, so the sponsor licence number / contact,
 *    `createdBy` and review fields never leave the server);
 *  - an approved agency-only visa: the applicant-safe fields, to a caller
 *    with an application at the owning agency or on this visa;
 *  - anything else: null, so the caller answers the same 404 as an unknown
 *    id and a hidden visa's existence never leaks.
 *
 * The routes use `optionalAuth`, so `req.ability` / `req.userId` are only set
 * when a valid token was sent. No role literals: the decision comes from the
 * ability and the caller's applications.
 */
function visaForCaller(req: AuthenticatedRequest, visa: VisaType) {
  return agencyVisaAccessService.visaForCaller(req, visa);
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
   * Issue #99: 404 for a visa the caller may not read (visaForCaller, #102) — the
   * same answer as an unknown id, so a hidden visa's existence never leaks.
   * Internal callers keep the unfiltered visaService.getVisaType.
   */
  async getVisaType(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { code, visaId } = req.params;

      const stored = await visaService.getVisaType(code, visaId);
      // Issue #102: the view this caller may see (full, applicant-safe, or
      // null). Unknown and hidden ids get the same 404 body.
      const visaType = stored ? await visaForCaller(req, stored) : null;

      if (!visaType) {
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

      const stored = await visaService.getVisaType(code, visaId);
      // Issue #102: same access decision and projection as getVisaType.
      const visaType = stored ? await visaForCaller(req, stored) : null;

      if (!visaType) {
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
   * Get all requirements for a visa type.
   *
   * Issue #102 (from the #99 review): before, this returned the requirements
   * of ANY visa id, hidden or not. It now applies the same visibility and
   * ability gate as the detail and `/full` routes: the visa is read and
   * checked FIRST, and an unknown or hidden visa gets the same 404 as the
   * detail route (no requirements query is made for it).
   */
  async getRequirements(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { code, visaId } = req.params;

      // ---- Gate: the visa must be readable by this caller ----
      const stored = await visaService.getVisaType(code, visaId);
      const visaType = stored ? await visaForCaller(req, stored) : null;
      if (!visaType) {
        sendError(res, "NOT_FOUND", "Visa type not found", 404);
        return;
      }

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
   * Every reviewable visa for the admin review list (drafts excluded).
   *
   * Issue #101: agency visas (`source: "agency"`) carry `agencyName` (looked
   * up on the server) and `pendingRevision` (a pending edit of an approved
   * visa, or null). Optional query filters:
   *   ?source=scraped|agency   only that source
   *   ?agencyId=<id>           only that agency's visas
   * With no filters the list is a superset of the pre-#101 one; scraped and
   * seed rows are unchanged. 400 on a bad filter value, 403 for non-admins
   * (CASL gate, on top of the route's verifyAdmin).
   */
  async getAdminVisas(req: AuthenticatedRequest, res: Response): Promise<void> {
    // ---- CASL gate (review rights) ----
    if (!canAdminWriteVisa(req, "reviewStatus")) {
      forbidden(res, "Only Seli admins can review visas");
      return;
    }
    try {
      // ---- Filters ----
      const filters: AdminVisaFilters = {};
      const { source, agencyId } = req.query ?? {};
      if (source !== undefined) {
        if (typeof source !== "string" || !(ADMIN_VISA_SOURCE_FILTERS as readonly string[]).includes(source)) {
          sendError(res, "VALIDATION_ERROR", `source must be one of: ${ADMIN_VISA_SOURCE_FILTERS.join(", ")}`, 400);
          return;
        }
        filters.source = source as AdminVisaSourceFilter;
      }
      if (agencyId !== undefined) {
        if (typeof agencyId !== "string" || !isValidDocId(agencyId)) {
          sendError(res, "VALIDATION_ERROR", "agencyId must be an agency id", 400);
          return;
        }
        filters.agencyId = agencyId;
      }

      const visas = await agencyVisaReviewService.listForAdmin(filters);
      sendSuccess(res, visas);
    } catch (error) {
      console.error("Error getting admin visas:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  /**
   * PATCH /admin/visas/:id/review
   * Approve or reject a visa type.
   *
   * Body: { action: "approve" | "reject", countryCode, reason? (required on
   * reject), revisionUpdatedAt? }.
   *
   * Issue #101: an agency visa (`source: "agency"`) goes through
   * agencyVisaReviewService.review (pending_review only, revisions with an
   * `updatedAt` check, VISA_COST_MISSING, owner emails); `revisionUpdatedAt`
   * is required there when the visa has a pending revision. Every other
   * visa keeps the existing path (visaService.updateVisaReviewStatus).
   */
  async reviewVisa(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const { action, reason, countryCode } = req.body ?? {};

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

      // ---- Agency visas (issue #101) ----
      // Unaddressable ids are left to the existing path (it answers 404).
      if (isValidDocId(id) && typeof countryCode === "string" && isValidDocId(countryCode.toUpperCase())) {
        const existing = await visaService.getVisaType(countryCode, id);
        if (existing && existing.source === AGENCY_VISA_SOURCE) {
          await this.reviewAgencyVisa(req, res, { id, action, reason, countryCode });
          return;
        }
      }

      // Issue #212: `acknowledgeMissingItems: true` approves past the page items
      // the extractor missed. Only a boolean is accepted (anything else is a 400).
      const ackMissing = req.body?.acknowledgeMissingItems;
      if (ackMissing !== undefined && typeof ackMissing !== "boolean") {
        sendError(res, "VALIDATION_ERROR", "acknowledgeMissingItems must be true or false", 400);
        return;
      }

      const updatedVisa = await visaService.updateVisaReviewStatus(
        countryCode,
        id,
        action,
        req.userId!,
        reason,
        ackMissing === true
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
      // Issue #212: page items the extractor missed were not acknowledged.
      if (error instanceof MissingItemsUnacknowledgedError) {
        sendError(res, error.code, error.message, error.httpStatus);
        return;
      }
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  /**
   * The agency branch of reviewVisa (issue #101). CASL-gated (403 before
   * the write, and again on the doc in the transaction), then one
   * transaction in agencyVisaReviewService.review. Errors are mapped to
   * their status here; the caller's catch handles nothing from this path.
   */
  private async reviewAgencyVisa(
    req: AuthenticatedRequest,
    res: Response,
    body: { id: string; action: "approve" | "reject"; reason?: string; countryCode: string }
  ): Promise<void> {
    // ---- CASL gate (probe: no existence leak beyond the route's admin gate) ----
    if (!canAdminWriteVisa(req, "reviewStatus")) {
      forbidden(res, "Only Seli admins can review agency visas");
      return;
    }
    try {
      // `revisionUpdatedAt`: optional here; the service requires it only
      // when a pending revision is being reviewed. A value that can't be
      // parsed is a 400 rather than a silent mismatch.
      const raw = req.body?.revisionUpdatedAt;
      const millis = parseExpectedTimestamp(raw);
      if (raw !== undefined && raw !== null && millis === null) {
        sendError(
          res,
          "VALIDATION_ERROR",
          "revisionUpdatedAt must be an ISO 8601 date or a Timestamp ({ _seconds, _nanoseconds })",
          400
        );
        return;
      }

      // Issue #120: `acknowledgeScreening: true` approves past an open
      // screening result. Only a boolean is accepted (anything else is a 400).
      const ack = req.body?.acknowledgeScreening;
      if (ack !== undefined && typeof ack !== "boolean") {
        sendError(res, "VALIDATION_ERROR", "acknowledgeScreening must be true or false", 400);
        return;
      }

      const { outcome, visa } = await agencyVisaReviewService.review(
        {
          countryCode: body.countryCode,
          visaId: body.id,
          action: body.action,
          reviewedBy: req.userId!,
          rejectionReason: body.reason,
          revisionUpdatedAtMillis: millis ?? undefined,
          acknowledgeScreening: ack === true,
        },
        (doc, field) => canAdminWriteVisa(req, field, { ...doc })
      );

      // Message per outcome (the portal may show it as a toast).
      const messages: Record<typeof outcome, string> = {
        approved: "Visa approved successfully",
        rejected: "Visa rejected successfully",
        revision_approved: "Visa changes approved successfully",
        revision_rejected: "Visa changes rejected successfully",
        unchanged: "Visa is already approved",
      };
      sendSuccess(res, { ...visa, reviewOutcome: outcome }, messages[outcome]);
    } catch (error) {
      if (error instanceof AgencyVisaError) {
        sendError(res, error.code, error.message, error.httpStatus);
        return;
      }
      if (error instanceof VisaFeeNotConvertibleError || error instanceof VisaIsDraftError) {
        sendError(res, error.code, error.message, 409);
        return;
      }
      console.error("Error reviewing agency visa:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  /**
   * POST /admin/visas/:id/screening/rerun (issue #120)
   *
   * Body: { countryCode }. Re-runs listing screening on the visa's current
   * target (a submitted visa, or the pending revision of an approved one).
   * The recovery path after a model outage; same idempotency rule as the
   * automatic run and it counts against the daily caps.
   * 200 -> { screening, openScreeningSignals, status } where status is
   * "screened" or "unchanged". 400 VALIDATION_ERROR, 403 FORBIDDEN (CASL
   * probe on `reviewStatus`, after the route's verifyAdmin), 404 NOT_FOUND
   * (unknown or non-agency visa), 409 NO_SCREENING_TARGET.
   */
  async rerunScreening(req: AuthenticatedRequest, res: Response): Promise<void> {
    // ---- CASL gate (tagged probe, like the review routes) ----
    if (!canAdminWriteVisa(req, "reviewStatus")) {
      forbidden(res, "Only Seli admins can rerun listing screening");
      return;
    }
    try {
      const { id } = req.params;
      const { countryCode } = req.body ?? {};
      if (typeof countryCode !== "string" || !countryCode) {
        sendError(res, "VALIDATION_ERROR", "countryCode is required", 400);
        return;
      }
      // An unaddressable id or country would make Firestore throw -> 404.
      if (!isValidDocId(id) || !isValidDocId(countryCode.toUpperCase())) {
        sendError(res, "NOT_FOUND", "Visa type not found", 404);
        return;
      }
      const { result, openScreeningSignals } = await agencyVisaScreeningService.rerun(countryCode, id);
      sendSuccess(
        res,
        { screening: result.screening, openScreeningSignals, status: result.status },
        result.status === "unchanged" ? "Screening is already up to date" : "Screening re-run"
      );
    } catch (error) {
      if (error instanceof AgencyVisaError) {
        sendError(res, error.code, error.message, error.httpStatus);
        return;
      }
      console.error("Error re-running listing screening:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  /**
   * PATCH /admin/visas/:id/visibility (issue #101)
   *
   * Make an approved agency visa global, or take it back to agency-only.
   * Body: { countryCode, visibility: "global" | "agency" }.
   * 200 -> the visa as stored, plus `visibilityOutcome`
   * ("made_global" | "made_agency_only" | "unchanged"; unchanged = same
   * value, nothing written, no email). 400 VALIDATION_ERROR, 403 FORBIDDEN,
   * 404 NOT_FOUND, 409 NOT_AN_AGENCY_VISA / VISA_NOT_APPROVED.
   *
   * Authz: the route's verifyAuth + verifyAdmin, then the CASL gate on the
   * `visibility` field (probe first, then the real doc in the transaction).
   */
  async setVisibility(req: AuthenticatedRequest, res: Response): Promise<void> {
    // ---- CASL gate ----
    if (!canAdminWriteVisa(req, "visibility")) {
      forbidden(res, "Only Seli admins can change a visa's visibility");
      return;
    }
    try {
      const { id } = req.params;
      const { countryCode, visibility } = req.body ?? {};

      // ---- Validate ----
      const allowed: string[] = [VISA_VISIBILITY.GLOBAL, VISA_VISIBILITY.AGENCY];
      if (typeof visibility !== "string" || !allowed.includes(visibility)) {
        sendError(res, "VALIDATION_ERROR", `visibility must be one of: ${allowed.join(", ")}`, 400);
        return;
      }
      if (typeof countryCode !== "string" || !countryCode) {
        sendError(res, "VALIDATION_ERROR", "countryCode is required", 400);
        return;
      }
      // An unaddressable id or country would make Firestore throw -> 404.
      if (!isValidDocId(id) || !isValidDocId(countryCode.toUpperCase())) {
        sendError(res, "NOT_FOUND", "Visa type not found", 404);
        return;
      }

      // ---- Write (one transaction) ----
      const { outcome, visa } = await agencyVisaReviewService.setVisibility(
        { countryCode, visaId: id, visibility: visibility as VisaVisibility, changedBy: req.userId! },
        (doc, field) => canAdminWriteVisa(req, field, { ...doc })
      );
      const messages: Record<typeof outcome, string> = {
        made_global: "Visa is now global",
        made_agency_only: "Visa is now agency-only",
        unchanged: "Visa visibility unchanged",
      };
      sendSuccess(res, { ...visa, visibilityOutcome: outcome }, messages[outcome]);
    } catch (error) {
      if (error instanceof AgencyVisaError) {
        sendError(res, error.code, error.message, error.httpStatus);
        return;
      }
      console.error("Error setting visa visibility:", error);
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
