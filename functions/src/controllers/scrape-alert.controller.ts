import { Response } from "express";
import { AuthenticatedRequest } from "../middleware/auth";
import { asSubject, can, forbidden } from "../middleware/authz";
import { sendError, sendSuccess, ErrorMessages } from "../utils/response";
import {
  InvalidAlertCursorError,
  SCRAPE_ALERT_LIST_DEFAULT_LIMIT,
  SCRAPE_ALERT_LIST_MAX_LIMIT,
  scrapeAlertService,
  type AlertMutationResult,
  type ListAlertsQuery,
} from "../services/scrape-alert.service";
import { SCRAPE_ALERT_STATUSES, type ScrapeAlertStatus } from "../types/scrape-alert";

// ============================================
// ADMIN — SCRAPE ALERTS (issue #83)
// ============================================
//
// Mounted at /admin/scrape-alerts (routes/scrape-alert.routes.ts). Every
// route runs `verifyAuth` first (no token -> 401), then the shared CASL
// ability, BEFORE any validation or Firestore read:
//   - list / get:            `read ScrapeRun`
//   - acknowledge / resolve: `update ScrapeRun`
// Alerts are part of the scraper-monitoring surface, so they reuse the #81
// `ScrapeRun` subject. Only admins hold it (via `manage all` in
// @durin-tech/authz; no other role is granted ScrapeRun), so no authz
// package change is needed.
//
// All dates in responses are ISO-8601 strings.

/** Alert ids are Firestore auto ids. */
const ALERT_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

class ScrapeAlertController {
  /** CASL gate: 403 and false when not allowed. */
  private allowed(req: AuthenticatedRequest, res: Response, action: "read" | "update", id?: string): boolean {
    if (can(req, action, asSubject("ScrapeRun", id ? { id } : {}))) return true;
    forbidden(res, action === "read" ? "Only admins can view scraper alerts" : "Only admins can change scraper alerts");
    return false;
  }

  /**
   * GET /admin/scrape-alerts?status=open|acknowledged|resolved&limit=&cursor=
   *  - status: optional; `open` includes acknowledged (the active alerts);
   *    omitted = every status;
   *  - limit: default 25, capped at 100; cursor: previous page's nextCursor.
   * -> { items: Alert[], nextCursor: string | null }, lastSeen newest first.
   */
  async list(req: AuthenticatedRequest, res: Response): Promise<void> {
    if (!this.allowed(req, res, "read")) return;
    // A repeated param arrives as an array: reject instead of picking one.
    for (const key of ["status", "limit", "cursor"]) {
      const v = req.query[key];
      if (v !== undefined && typeof v !== "string") {
        sendError(res, "VALIDATION_ERROR", `${key} must be given once, as a single value`, 400);
        return;
      }
    }
    const { status, limit, cursor } = req.query as Record<string, string | undefined>;
    const q: ListAlertsQuery = { limit: SCRAPE_ALERT_LIST_DEFAULT_LIMIT };
    if (status !== undefined) {
      if (!SCRAPE_ALERT_STATUSES.includes(status as ScrapeAlertStatus)) {
        sendError(res, "VALIDATION_ERROR", `status must be one of: ${SCRAPE_ALERT_STATUSES.join(", ")}`, 400);
        return;
      }
      q.status = status as ScrapeAlertStatus;
    }
    if (limit !== undefined) {
      const n = Number(limit);
      if (!Number.isInteger(n) || n < 1) {
        sendError(res, "VALIDATION_ERROR", "limit must be a positive integer", 400);
        return;
      }
      q.limit = Math.min(n, SCRAPE_ALERT_LIST_MAX_LIMIT);
    }
    if (cursor !== undefined) {
      if (!ALERT_ID_RE.test(cursor)) {
        sendError(res, "INVALID_CURSOR", "cursor is not valid", 400);
        return;
      }
      q.cursor = cursor;
    }
    try {
      sendSuccess(res, await scrapeAlertService.listAlerts(q));
    } catch (error) {
      if (error instanceof InvalidAlertCursorError) {
        sendError(res, "INVALID_CURSOR", error.message, 400);
        return;
      }
      console.error("Error listing scrape alerts:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  /** GET /admin/scrape-alerts/:id -> the alert, or 404. */
  async get(req: AuthenticatedRequest, res: Response): Promise<void> {
    const { id } = req.params;
    if (!this.allowed(req, res, "read", id)) return;
    if (!ALERT_ID_RE.test(id)) {
      sendError(res, "NOT_FOUND", "Scrape alert not found", 404);
      return;
    }
    try {
      const alert = await scrapeAlertService.getAlert(id);
      if (!alert) {
        sendError(res, "NOT_FOUND", "Scrape alert not found", 404);
        return;
      }
      sendSuccess(res, alert);
    } catch (error) {
      console.error("Error getting scrape alert:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  /**
   * POST /admin/scrape-alerts/:id/acknowledge -> 200 the alert
   * (acknowledgedBy = caller uid). Already acknowledged: 200 unchanged.
   * Resolved: 409 ALERT_RESOLVED. Unknown: 404.
   */
  async acknowledge(req: AuthenticatedRequest, res: Response): Promise<void> {
    await this.mutate(req, res, "acknowledge");
  }

  /**
   * POST /admin/scrape-alerts/:id/resolve -> 200 the alert (resolvedBy =
   * caller uid, autoResolved false). Already resolved: 200 unchanged.
   * Unknown: 404.
   */
  async resolve(req: AuthenticatedRequest, res: Response): Promise<void> {
    await this.mutate(req, res, "resolve");
  }

  /** Shared body of acknowledge / resolve. */
  private async mutate(req: AuthenticatedRequest, res: Response, op: "acknowledge" | "resolve"): Promise<void> {
    const { id } = req.params;
    if (!this.allowed(req, res, "update", id)) return;
    if (!ALERT_ID_RE.test(id)) {
      sendError(res, "NOT_FOUND", "Scrape alert not found", 404);
      return;
    }
    // verifyAuth always sets userId; guard anyway so the audit field is never blank.
    const uid = req.userId;
    if (!uid) {
      sendError(res, "UNAUTHORIZED", ErrorMessages.UNAUTHORIZED, 401);
      return;
    }
    try {
      const result: AlertMutationResult =
        op === "acknowledge" ? await scrapeAlertService.acknowledge(id, uid) : await scrapeAlertService.resolve(id, uid);
      if (result.outcome === "not_found") {
        sendError(res, "NOT_FOUND", "Scrape alert not found", 404);
        return;
      }
      if (result.outcome === "already_resolved") {
        if (op === "acknowledge") {
          sendError(res, "ALERT_RESOLVED", "This alert is already resolved", 409);
          return;
        }
        sendSuccess(res, result.alert, "Alert was already resolved");
        return;
      }
      sendSuccess(res, result.alert, op === "acknowledge" ? "Alert acknowledged" : "Alert resolved");
    } catch (error) {
      console.error(`Error trying to ${op} scrape alert:`, error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }
}

export const scrapeAlertController = new ScrapeAlertController();
