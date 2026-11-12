import { NextFunction, Response } from "express";
import { ROLES } from "@durin-tech/authz";
import { AuthenticatedRequest } from "../middleware/auth";
import { can, forbidden } from "../middleware/authz";
import { ErrorMessages, sendError, sendSuccess } from "../utils/response";
import type { RubricReviewStatus } from "../types/rubric";
import {
  RUBRIC_LIST_DEFAULT_LIMIT,
  RUBRIC_LIST_MAX_LIMIT,
  RUBRIC_REVIEW_STATUSES,
  RubricReviewError,
  parseExcludedIds,
  parseRubricDecision,
  rubricReviewService,
} from "../services/rubric-review.service";

// ============================================
// ADMIN — RUBRIC REVIEW (issue #125)
// ============================================
//
// Mounted at /admin/rubrics (routes/rubric-review.routes.ts):
//
//   GET   /admin/rubrics?reviewStatus=pending_review|approved|rejected&limit=
//   GET   /admin/rubrics/:id
//   PATCH /admin/rubrics/:id/review
//   POST  /admin/rubrics/:id/exclusion-preview   (read-only; #161)
//
// `:id` is `{countryCode}_{visaTypeId}__v{version}`.
//
// Thin on purpose: the handlers parse the request and map errors; every rule
// (what blocks an approval, the transaction, the audit entry) lives in
// services/rubric-review.service.ts.
//
// ADMIN ONLY. The gate is `requireRubricAdmin` below, run by the router
// before every handler, so a non-admin gets 403 `FORBIDDEN` before any
// validation or Firestore read and learns nothing about the queue.

/**
 * Route guard: admins only, answered with the standard `FORBIDDEN` code.
 *
 * Two conditions, both from the verified token (`verifyAuth` builds
 * `req.authz` and `req.ability` from its claims):
 *  - the principal's role is admin (`ROLES.ADMIN`, no literal), and
 *  - the shared CASL ability grants `manage all`, which only the admin
 *    branch of `defineAbilitiesFor` does. @durin-tech/authz has no subject of
 *    its own for rubrics yet; when one is added, check it here.
 *
 * Entitlements play no part: a client, agent or agency owner is refused
 * whether their plan is resolved, unresolved or read-only. A request with no
 * principal at all (the guard used without `verifyAuth`) is refused too.
 *
 * It runs BEFORE `verifyAdmin` in the router so the response carries
 * `FORBIDDEN` (what the rest of the admin API and the portal use) rather
 * than `verifyAdmin`'s older "Forbidden" body.
 */
export function requireRubricAdmin(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
  if (req.authz?.role === ROLES.ADMIN && can(req, "manage", "all")) {
    next();
    return;
  }
  forbidden(res, "Only admins can review rubrics");
}

class RubricReviewController {
  /**
   * Map a thrown error onto HTTP: a `RubricReviewError` carries its own code
   * and status (400 / 404 / 409); anything else is a 500 with no detail.
   */
  private sendServiceError(res: Response, error: unknown, what: string): void {
    if (error instanceof RubricReviewError) {
      sendError(res, error.code, error.message, error.httpStatus);
      return;
    }
    // The message only: never a request body or a rubric.
    console.error(`Error ${what}: ${(error as Error)?.message ?? error}`);
    sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
  }

  /**
   * GET /admin/rubrics?reviewStatus=pending_review&limit=50
   * Rubric versions of every route with that review status, newest first.
   * `reviewStatus` defaults to pending_review (unknown value -> 400);
   * `limit` defaults to 50 and is capped at 100 (not a positive integer ->
   * 400). 200 -> `{ items, total }`; an empty queue is `{ items: [], total: 0 }`.
   */
  async list(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      // A repeated param (?reviewStatus=a&reviewStatus=b) arrives as an
      // array: refuse it rather than pick one.
      for (const key of ["reviewStatus", "limit"]) {
        const v = req.query[key];
        if (v !== undefined && typeof v !== "string") {
          sendError(res, "VALIDATION_ERROR", `${key} must be given once, as a single value`, 400);
          return;
        }
      }
      const rawStatus = typeof req.query.reviewStatus === "string" ? req.query.reviewStatus : "pending_review";
      if (!(RUBRIC_REVIEW_STATUSES as readonly string[]).includes(rawStatus)) {
        sendError(res, "VALIDATION_ERROR", `reviewStatus must be one of: ${RUBRIC_REVIEW_STATUSES.join(", ")}`, 400);
        return;
      }
      let limit = RUBRIC_LIST_DEFAULT_LIMIT;
      if (req.query.limit !== undefined) {
        const n = Number(req.query.limit);
        if (!Number.isInteger(n) || n < 1) {
          sendError(res, "VALIDATION_ERROR", "limit must be a positive integer", 400);
          return;
        }
        limit = Math.min(n, RUBRIC_LIST_MAX_LIMIT);
      }
      const items = await rubricReviewService.listVersions({ reviewStatus: rawStatus as RubricReviewStatus, limit });
      sendSuccess(res, { items, total: items.length });
    } catch (error) {
      this.sendServiceError(res, error, "listing rubric versions");
    }
  }

  /**
   * GET /admin/rubrics/:id
   * One version in full: criteria (each with `staleCitation`), the diff
   * against the serving version, flags, discards, suspicious passages and
   * what an approval would take. 404 when the id names no version.
   * Optional `?previewExcluded=id1,id2` (#161): the criteria a reviewer is
   * thinking of excluding; the detail's `exclusionPreview` then counts what
   * that would remove. Validated like the approve body (400 on an unknown id,
   * a mandatory bar or too many ids); for a long list use the POST route.
   */
  async get(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      let previewExcluded: string[] | undefined;
      const raw = req.query.previewExcluded;
      if (raw !== undefined) {
        if (typeof raw !== "string") {
          sendError(res, "VALIDATION_ERROR", "previewExcluded must be given once, as a comma-separated list", 400);
          return;
        }
        // An empty value means "nothing proposed": the stored set (if any) is counted.
        previewExcluded = raw.trim() === "" ? undefined : parseExcludedIds(raw.split(","), "previewExcluded");
      }
      const detail = await rubricReviewService.getVersion(req.params.id, { previewExcluded });
      if (!detail) {
        sendError(res, "NOT_FOUND", "Rubric version not found", 404);
        return;
      }
      sendSuccess(res, detail);
    } catch (error) {
      this.sendServiceError(res, error, "getting a rubric version");
    }
  }

  /**
   * POST /admin/rubrics/:id/exclusion-preview   body `{ excludedCriterionIds: string[] }`
   * Read-only twin of `?previewExcluded=` for long lists. 200 ->
   * `{ exclusionPreview, primaryExclusionIds }`; 400 for an unknown id, a
   * mandatory bar or a malformed list; 404 for an unknown version. Writes nothing.
   */
  async exclusionPreview(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const body = req.body as Record<string, unknown> | undefined;
      if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some((k) => k !== "excludedCriterionIds")) {
        sendError(res, "VALIDATION_ERROR", "the body must be { excludedCriterionIds: string[] }", 400);
        return;
      }
      const ids = parseExcludedIds(body.excludedCriterionIds, "excludedCriterionIds");
      const result = await rubricReviewService.previewExclusion(req.params.id, ids);
      if (!result) {
        sendError(res, "NOT_FOUND", "Rubric version not found", 404);
        return;
      }
      sendSuccess(res, result);
    } catch (error) {
      this.sendServiceError(res, error, "previewing rubric exclusions");
    }
  }

  /**
   * PATCH /admin/rubrics/:id/review
   * Body, approve: `{ action: "approve", revision, intentPolarity,
   *                   acknowledgedFlags?: string[], reason?: string,
   *                   excludedCriterionIds?: string[], exclusionNote?: string,
   *                   confirmPrimaryExclusions?: boolean }` (#161)
   * Body, reject:  `{ action: "reject", revision, reason }` (reason >= 10 chars)
   * 200 -> the decision (new revision, serving version, audit id).
   * 400 VALIDATION_ERROR; 404 NOT_FOUND; 409 ALREADY_DECIDED /
   * REVISION_MISMATCH / NOT_LATEST_VERSION / STALE_CITATION /
   * CITATION_UNVERIFIABLE / SOURCE_CHANGED / RUBRIC_INVALID /
   * FLAGS_NOT_ACKNOWLEDGED / PRIMARY_EXCLUSION_UNCONFIRMED. Nothing is written on any error.
   */
  async review(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      // The reviewer is the verified caller; a body can never name one.
      if (!req.userId) {
        forbidden(res, "Only admins can review rubrics");
        return;
      }
      const input = parseRubricDecision(req.body);
      const result = await rubricReviewService.decide(req.params.id, input, req.userId);
      sendSuccess(res, result, `Rubric version ${result.action === "approve" ? "approved" : "rejected"}`);
    } catch (error) {
      this.sendServiceError(res, error, "reviewing a rubric version");
    }
  }
}

export const rubricReviewController = new RubricReviewController();
