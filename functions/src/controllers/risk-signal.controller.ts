// ============================================
// Risk signals: admin HTTP surface (issue #119)
// ============================================
//
// Mounted at /admin/risk-signals (routes/risk-signal.routes.ts). Every route
// runs `verifyAuth` (401 without a valid token) then `verifyAdmin` (403 for
// every non-admin role), so this controller only ever runs for an admin.
//
// What it exposes:
//   GET  /admin/risk-signals          the queue (filters + cursor page)
//   GET  /admin/risk-signals/:id      one signal + its audit trail
//   POST /admin/risk-signals/:id/status  record an admin decision
//
// There is deliberately NO create route: signals are raised by backend code
// through riskSignalService.raiseRiskSignal() only.
//
// Response shape: the usual { success, data } envelope (utils/response). The
// signal JSON is built field by field by the service (a whitelist), and dates
// are ISO-8601 strings.
//
// Error mapping:
//   RiskSignalError  -> its own code + HTTP status (404 / 400 / 409)
//   validation error -> 400 VALIDATION_ERROR
//   anything else    -> 500 INTERNAL_ERROR
// Error messages never repeat the offending input value.

import { Response } from "express";
import { AuthenticatedRequest } from "../middleware/auth";
import { ErrorMessages, sendError, sendSuccess } from "../utils/response";
import {
  RISK_SIGNAL_CATEGORIES,
  RISK_SIGNAL_SEVERITIES,
  RISK_SIGNAL_STATUSES,
  RISK_SIGNAL_SUBJECT_TYPES,
  type RiskSignalCategory,
  type RiskSignalSeverity,
  type RiskSignalStatus,
  type RiskSignalSubjectType,
} from "../types/risk-signal";
import {
  RISK_SIGNAL_LIST_DEFAULT_LIMIT,
  RISK_SIGNAL_LIST_MAX_LIMIT,
  RiskSignalError,
  riskSignalService,
  type ChangeRiskSignalStatusInput,
  type ListRiskSignalsQuery,
} from "../services/risk-signal.service";
import { RiskSignalValidationError } from "../services/risk-signal.validation";

/**
 * Query parameters the list accepts. Each may appear at most once (a repeated
 * param arrives as an array and is refused, never silently defaulted).
 */
const LIST_QUERY_KEYS = ["status", "category", "type", "subjectType", "severity", "limit", "cursor"] as const;

/**
 * A signal-type key: lower-case letters, digits and underscores
 * (`shared_contact`). Types are data, not an enum; this only checks the shape.
 */
const SIGNAL_TYPE_RE = /^[a-z][a-z0-9_]*$/;

/** Characters allowed in a cursor: the signal id is hex + dash. */
const CURSOR_RE = /^[a-f0-9]{32}-[1-9][0-9]{0,2}$/;

/** The admin controllers. One instance is shared through the module. */
class RiskSignalController {
  /**
   * Map service / validation errors onto HTTP. `RiskSignalError` carries the
   * status it wants (400 validation, 404 not found, 409 conflict); anything
   * unknown is a 500. The log line carries the error only, never the body.
   */
  private sendServiceError(res: Response, error: unknown, what: string): void {
    if (error instanceof RiskSignalError) {
      sendError(res, error.code, error.message, error.httpStatus);
      return;
    }
    if (error instanceof RiskSignalValidationError) {
      sendError(res, "VALIDATION_ERROR", error.message, 400);
      return;
    }
    console.error(`Error ${what}:`, error);
    sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
  }

  /**
   * GET /admin/risk-signals
   * Query: status, category, type, subjectType, severity, limit, cursor.
   * Newest first. Every filter is optional; `limit` defaults to 25 and is
   * capped at 100. `cursor` is the `nextCursor` of the previous page.
   *
   * 200 with { items: [], nextCursor: null } for an empty queue.
   * 400 VALIDATION_ERROR for an unknown enum value, a repeated param, a bad
   * limit / type / cursor; 400 INVALID_CURSOR when the cursor names a signal
   * that no longer exists.
   */
  async list(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      // ---- Each param must be a single string ----
      for (const key of LIST_QUERY_KEYS) {
        const value = req.query[key];
        if (value !== undefined && typeof value !== "string") {
          sendError(res, "VALIDATION_ERROR", `${key} must be given once, as a single value`, 400);
          return;
        }
      }

      // ---- Filters (all optional; unknown values are refused) ----
      const query: ListRiskSignalsQuery = { limit: RISK_SIGNAL_LIST_DEFAULT_LIMIT };

      const rawStatus = req.query.status as string | undefined;
      if (rawStatus !== undefined) {
        if (!RISK_SIGNAL_STATUSES.includes(rawStatus as RiskSignalStatus)) {
          sendError(res, "VALIDATION_ERROR", `status must be one of: ${RISK_SIGNAL_STATUSES.join(", ")}`, 400);
          return;
        }
        query.status = rawStatus as RiskSignalStatus;
      }

      const rawCategory = req.query.category as string | undefined;
      if (rawCategory !== undefined) {
        if (!RISK_SIGNAL_CATEGORIES.includes(rawCategory as RiskSignalCategory)) {
          sendError(res, "VALIDATION_ERROR", `category must be one of: ${RISK_SIGNAL_CATEGORIES.join(", ")}`, 400);
          return;
        }
        query.category = rawCategory as RiskSignalCategory;
      }

      const rawSubjectType = req.query.subjectType as string | undefined;
      if (rawSubjectType !== undefined) {
        if (!RISK_SIGNAL_SUBJECT_TYPES.includes(rawSubjectType as RiskSignalSubjectType)) {
          sendError(
            res,
            "VALIDATION_ERROR",
            `subjectType must be one of: ${RISK_SIGNAL_SUBJECT_TYPES.join(", ")}`,
            400
          );
          return;
        }
        query.subjectType = rawSubjectType as RiskSignalSubjectType;
      }

      const rawSeverity = req.query.severity as string | undefined;
      if (rawSeverity !== undefined) {
        if (!RISK_SIGNAL_SEVERITIES.includes(rawSeverity as RiskSignalSeverity)) {
          sendError(res, "VALIDATION_ERROR", `severity must be one of: ${RISK_SIGNAL_SEVERITIES.join(", ")}`, 400);
          return;
        }
        query.severity = rawSeverity as RiskSignalSeverity;
      }

      const rawType = req.query.type as string | undefined;
      if (rawType !== undefined) {
        if (!SIGNAL_TYPE_RE.test(rawType)) {
          sendError(res, "VALIDATION_ERROR", "type must be a lower-case key (letters, digits, underscores)", 400);
          return;
        }
        query.type = rawType;
      }

      // ---- Page size ----
      const rawLimit = req.query.limit as string | undefined;
      if (rawLimit !== undefined) {
        const n = Number(rawLimit);
        if (!Number.isInteger(n) || n < 1) {
          sendError(res, "VALIDATION_ERROR", "limit must be a positive integer", 400);
          return;
        }
        query.limit = Math.min(n, RISK_SIGNAL_LIST_MAX_LIMIT);
      }

      // ---- Cursor ----
      const rawCursor = req.query.cursor as string | undefined;
      if (rawCursor !== undefined) {
        if (!CURSOR_RE.test(rawCursor)) {
          sendError(res, "VALIDATION_ERROR", "cursor is not a valid signal cursor", 400);
          return;
        }
        query.cursor = rawCursor;
      }

      const page = await riskSignalService.listSignals(query);
      sendSuccess(res, page);
    } catch (error) {
      this.sendServiceError(res, error, "listing risk signals");
    }
  }

  /**
   * GET /admin/risk-signals/:id → { signal, events }, newest signal state and
   * its audit trail (oldest event first). 404 NOT_FOUND when the id is unknown.
   */
  async get(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const result = await riskSignalService.getSignal(id);
      if (!result) {
        sendError(res, "NOT_FOUND", "Risk signal not found", 404);
        return;
      }
      sendSuccess(res, result);
    } catch (error) {
      this.sendServiceError(res, error, "getting a risk signal");
    }
  }

  /**
   * POST /admin/risk-signals/:id/status
   * Body: { status, note?, expectedRevision, reopen? }
   *
   * - `expectedRevision` (positive integer) is the revision the admin saw;
   *   a stale value → 409 REVISION_MISMATCH and nothing is written.
   * - note is required for `actioned` and `dismissed`, and for a reopen.
   * - Only open -> in_review and open|in_review -> actioned|dismissed are
   *   allowed. A resolved signal returns to open only with `reopen: true`
   *   (audited as a `reopened` event).
   * - Every success writes exactly one audit event with the admin's uid.
   * - This records a decision only: nothing is sent to the subject and no
   *   other document is written.
   *
   * 200 with the updated signal; 400 VALIDATION_ERROR / NOTE_REQUIRED /
   * INVALID_TRANSITION; 404 NOT_FOUND; 409 REVISION_MISMATCH / SUPERSEDED.
   */
  async changeStatus(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;

      // ---- Body ----
      const rawStatus = req.body?.status;
      if (typeof rawStatus !== "string" || !RISK_SIGNAL_STATUSES.includes(rawStatus as RiskSignalStatus)) {
        sendError(res, "VALIDATION_ERROR", `status must be one of: ${RISK_SIGNAL_STATUSES.join(", ")}`, 400);
        return;
      }
      const expectedRevision = req.body?.expectedRevision;
      if (!Number.isInteger(expectedRevision) || expectedRevision < 1) {
        sendError(res, "VALIDATION_ERROR", "expectedRevision must be a positive integer", 400);
        return;
      }
      const reopen = req.body?.reopen;
      if (reopen !== undefined && typeof reopen !== "boolean") {
        sendError(res, "VALIDATION_ERROR", "reopen must be true or false", 400);
        return;
      }

      const input: ChangeRiskSignalStatusInput = {
        status: rawStatus as RiskSignalStatus,
        note: req.body?.note,
        expectedRevision,
        reopen,
      };
      // The actor comes from the verified token, never the body.
      const actor = {
        uid: req.userId ?? req.user?.uid ?? "",
        role: req.authz?.role ?? (req.user?.role as string | undefined) ?? "admin",
      };
      const signal = await riskSignalService.changeStatus(id, input, actor);
      sendSuccess(res, signal, "Risk signal updated");
    } catch (error) {
      this.sendServiceError(res, error, "changing a risk signal status");
    }
  }
}

export const riskSignalController = new RiskSignalController();
