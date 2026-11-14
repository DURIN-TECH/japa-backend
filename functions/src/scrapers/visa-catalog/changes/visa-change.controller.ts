import { Response } from "express";
import { AuthenticatedRequest } from "../../../middleware/auth";
import { asSubject, can, forbidden } from "../../../middleware/authz";
import { sendError, sendSuccess, ErrorMessages } from "../../../utils/response";
import type { PendingVisaChangeStatus } from "../types";
import {
  PENDING_VISA_CHANGE_STATUSES,
  VISA_CHANGE_LIST_DEFAULT_LIMIT,
  VISA_CHANGE_LIST_MAX_LIMIT,
  VisaChangeError,
  visaChangeService,
} from "./visa-catalog-changes.service";
import { VisaFeeNotConvertibleError } from "../visa-catalog-fx";
import { ManualCostError } from "../visa-manual-cost";
import { MissingItemsUnacknowledgedError } from "../missing-items-gate";
import { parseProposalManualCostInput } from "./visa-change-manual-cost";

// ============================================
// ADMIN — PROPOSED VISA CHANGES (issue #61)
// ============================================
//
// Mounted at /admin/visa-changes (scrapers/visa-catalog/changes/visa-change.routes.ts). Every route
// runs `verifyAuth` first (no token → 401), then checks the shared CASL
// ability on the `VisaChange` subject (@durin-tech/authz 0.1.3, admin-only):
//   list / get → "read", approve → "approve", reject → "reject",
//   manual cost (#77) → "update" (it edits the proposal row).
// A principal without the permission gets 403 — before any validation or
// Firestore read, so nothing about the queue leaks to non-admins.

/** The action a route needs on the `VisaChange` subject. */
type VisaChangeAction = "read" | "approve" | "reject" | "update";

/** Two-letter country code (the doc ids under `countries/` are upper-case). */
const COUNTRY_CODE_RE = /^[A-Za-z]{2}$/;

class VisaChangeController {
  /**
   * CASL gate shared by all four handlers. Sends 403 and returns false when
   * the principal may not perform `action` on a VisaChange.
   *
   * @param id the row id when the route has one (tagged into the subject so
   *   condition-based rules could match it; today the rule is admin-only).
   */
  private allowed(req: AuthenticatedRequest, res: Response, action: VisaChangeAction, id?: string): boolean {
    const resource = asSubject("VisaChange", id ? { id } : {});
    if (can(req, action, resource)) return true;
    forbidden(res, "Only admins can review proposed visa changes");
    return false;
  }

  /**
   * Map service errors onto HTTP:
   *  - VisaChangeError → its own code/status (404 NOT_FOUND, 409
   *    ALREADY_RESOLVED / REVISION_MISMATCH / STALE_PROPOSAL /
   *    ELIGIBILITY_REMOVED);
   *  - VisaFeeNotConvertibleError → 409 with its message (same mapping as
   *    PATCH /admin/visas/:id/review);
   *  - anything else → 500.
   */
  private sendServiceError(res: Response, error: unknown, what: string): void {
    if (error instanceof VisaChangeError) {
      sendError(res, error.code, error.message, error.httpStatus);
      return;
    }
    // Manual cost (#77): 400 VALIDATION_ERROR, 409 FEE_ALREADY_CONVERTED.
    if (error instanceof ManualCostError) {
      sendError(res, error.code, error.message, error.httpStatus);
      return;
    }
    if (error instanceof VisaFeeNotConvertibleError) {
      sendError(res, error.code, error.message, 409);
      return;
    }
    // Issue #212: 409 MISSING_ITEMS_UNACKNOWLEDGED.
    if (error instanceof MissingItemsUnacknowledgedError) {
      sendError(res, error.code, error.message, error.httpStatus);
      return;
    }
    console.error(`Error ${what}:`, error);
    sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
  }

  /**
   * GET /admin/visa-changes?status=open&countryCode=GB&limit=50
   * Newest first. `status` defaults to "open" (invalid → 400); `countryCode`
   * optional (2 letters, any case); `limit` default 50, capped at 100
   * (non-numeric or < 1 → 400). An empty queue is 200 with [].
   */
  async list(req: AuthenticatedRequest, res: Response): Promise<void> {
    if (!this.allowed(req, res, "read")) return;
    try {
      // ---- Validate the query ----
      // Each param must be a single string: a repeated param
      // (?status=open&status=approved) arrives as an array → 400, never a
      // silent default.
      for (const key of ["status", "countryCode", "limit"]) {
        const v = req.query[key];
        if (v !== undefined && typeof v !== "string") {
          sendError(res, "VALIDATION_ERROR", `${key} must be given once, as a single value`, 400);
          return;
        }
      }
      const rawStatus = typeof req.query.status === "string" ? req.query.status : "open";
      if (!PENDING_VISA_CHANGE_STATUSES.includes(rawStatus as PendingVisaChangeStatus)) {
        sendError(res, "VALIDATION_ERROR", `status must be one of: ${PENDING_VISA_CHANGE_STATUSES.join(", ")}`, 400);
        return;
      }
      let countryCode: string | undefined;
      if (req.query.countryCode !== undefined) {
        const cc = String(req.query.countryCode).trim();
        if (!COUNTRY_CODE_RE.test(cc)) {
          sendError(res, "VALIDATION_ERROR", "countryCode must be a 2-letter country code", 400);
          return;
        }
        countryCode = cc.toUpperCase();
      }
      let limit = VISA_CHANGE_LIST_DEFAULT_LIMIT;
      if (req.query.limit !== undefined) {
        const n = Number(req.query.limit);
        if (!Number.isInteger(n) || n < 1) {
          sendError(res, "VALIDATION_ERROR", "limit must be a positive integer", 400);
          return;
        }
        limit = Math.min(n, VISA_CHANGE_LIST_MAX_LIMIT);
      }

      const rows = await visaChangeService.listChanges({
        status: rawStatus as PendingVisaChangeStatus,
        countryCode,
        limit,
      });
      sendSuccess(res, rows);
    } catch (error) {
      this.sendServiceError(res, error, "listing visa changes");
    }
  }

  /** GET /admin/visa-changes/:id → the full row, or 404. */
  async get(req: AuthenticatedRequest, res: Response): Promise<void> {
    const { id } = req.params;
    if (!this.allowed(req, res, "read", id)) return;
    try {
      const row = await visaChangeService.getChange(id);
      if (!row) {
        sendError(res, "NOT_FOUND", "Visa change not found", 404);
        return;
      }
      sendSuccess(res, row);
    } catch (error) {
      this.sendServiceError(res, error, "getting visa change");
    }
  }

  /**
   * POST /admin/visa-changes/:id/approve, optional body { expectedRevision }
   * → the updated visa doc. `expectedRevision` (integer >= 1, else 400) is
   * the row revision the admin reviewed; a different current revision →
   * 409 REVISION_MISMATCH. Also 404 (row or visa missing), 409
   * ALREADY_RESOLVED / STALE_PROPOSAL / FEE_NOT_CONVERTED /
   * ELIGIBILITY_REMOVED. Applied in one transaction (see visaChangeService).
   */
  async approve(req: AuthenticatedRequest, res: Response): Promise<void> {
    const { id } = req.params;
    if (!this.allowed(req, res, "approve", id)) return;
    const expectedRevision = req.body?.expectedRevision;
    if (expectedRevision !== undefined && (!Number.isInteger(expectedRevision) || expectedRevision < 1)) {
      sendError(res, "VALIDATION_ERROR", "expectedRevision must be a positive integer", 400);
      return;
    }
    // Issue #212: `acknowledgeMissingItems: true` approves past the page items the
    // extraction missed; only a boolean is accepted.
    const ack = req.body?.acknowledgeMissingItems;
    if (ack !== undefined && typeof ack !== "boolean") {
      sendError(res, "VALIDATION_ERROR", "acknowledgeMissingItems must be true or false", 400);
      return;
    }
    try {
      const visa = await visaChangeService.approveChange(id, req.userId!, expectedRevision, ack === true);
      sendSuccess(res, visa, "Visa change approved");
    } catch (error) {
      this.sendServiceError(res, error, "approving visa change");
    }
  }

  /**
   * PUT /admin/visa-changes/:id/manual-cost (issue #77)
   * Body: { amountUsd: number, reason: string,
   *         rates: [{ currency, usdPerUnit }], expectedRevision: number }
   * Same cost rules as PUT /admin/visas/:id/manual-cost (#70): amountUsd
   * 0..100000 (0 = free), reason 10..500 chars trimmed, rates exactly one per
   * non-USD currency of the PROPOSED fee. 200 → the updated row (its
   * proposed fee carries the manual cost; `approvable` recomputed; `revision`
   * + 1, which the next approve must send as expectedRevision).
   * 400 VALIDATION_ERROR, 403 FORBIDDEN, 404 NOT_FOUND, 409 ALREADY_RESOLVED /
   * REVISION_MISMATCH / STALE_PROPOSAL / FEE_ALREADY_CONVERTED.
   *
   * Authz: CASL `update` on `VisaChange` (admin-only), checked FIRST, before
   * validation or any read, like the other handlers.
   */
  async setManualCost(req: AuthenticatedRequest, res: Response): Promise<void> {
    const { id } = req.params;
    if (!this.allowed(req, res, "update", id)) return;
    try {
      // ---- Validate (throws ManualCostError 400) ----
      const input = parseProposalManualCostInput(req.body);
      // ---- Write (one transaction) ----
      const row = await visaChangeService.setManualCost(id, input, req.userId!);
      sendSuccess(res, row, "Manual cost set");
    } catch (error) {
      this.sendServiceError(res, error, "setting a manual cost on a visa change");
    }
  }

  /**
   * POST /admin/visa-changes/:id/reject, body { reason } → the updated row.
   * 400 VALIDATION_ERROR when `reason` is missing / blank; 404; 409
   * ALREADY_RESOLVED. Never blocked by fee flags; the live visa is untouched.
   */
  async reject(req: AuthenticatedRequest, res: Response): Promise<void> {
    const { id } = req.params;
    if (!this.allowed(req, res, "reject", id)) return;
    const reason = typeof req.body?.reason === "string" ? req.body.reason.trim() : "";
    if (!reason) {
      sendError(res, "VALIDATION_ERROR", "reason is required when rejecting", 400);
      return;
    }
    try {
      const row = await visaChangeService.rejectChange(id, req.userId!, reason);
      sendSuccess(res, row, "Visa change rejected");
    } catch (error) {
      this.sendServiceError(res, error, "rejecting visa change");
    }
  }
}

export const visaChangeController = new VisaChangeController();
