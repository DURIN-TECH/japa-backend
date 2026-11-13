import { Response } from "express";
import { AuthenticatedRequest } from "../middleware/auth";
import { sendSuccess, sendError, sendForbidden } from "../utils/response";
import {
  aiMessageAccessService,
  AiMessageAccessError,
} from "../services/ai-message-access.service";

// ============================================
// AI message access: the signed-in user's own approval and settings (#172)
// ============================================
//
// All routes are under /users/me/..., so the subject is ALWAYS the caller
// (`req.userId`). As a second line of defence, a request that names ANOTHER user
// id (body or query `userId`) is refused with 403 and changes nothing: a client
// bug or a crafted request cannot be read as "act on someone else".

/**
 * True (after sending 403) when the request names a user id other than the caller's.
 * Checked on `userId` / `uid` in the body and the query string.
 */
function refusedForeignUser(req: AuthenticatedRequest, res: Response): boolean {
  const named = [
    (req.body as Record<string, unknown> | undefined)?.userId,
    (req.body as Record<string, unknown> | undefined)?.uid,
    req.query?.userId,
    req.query?.uid,
  ].filter((v) => v !== undefined);
  if (named.some((v) => v !== req.userId)) {
    sendForbidden(res, "You can only read or change your own AI message access");
    return true;
  }
  return false;
}

/** Load the caller's state for a response. */
async function respondWithState(req: AuthenticatedRequest, res: Response, message?: string, status = 200) {
  const state = await aiMessageAccessService.getUserState(req.userId!, req.authz!);
  sendSuccess(res, state, message, status);
}

/** Map a failure to a response. */
function fail(res: Response, error: unknown, fallback: string): void {
  if (error instanceof AiMessageAccessError && error.code === "WORDING_VERSION_MISMATCH") {
    sendError(res, "WORDING_VERSION_MISMATCH", error.message, 409);
    return;
  }
  console.error(`[ai-message-access] ${fallback}:`, (error as Error)?.message);
  sendError(res, "INTERNAL_ERROR", fallback, 500);
}

export const aiMessageAccessController = {
  /**
   * GET /users/me/ai-message-access
   * The caller's own state plus the wording an approval would record now.
   */
  async getState(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      if (refusedForeignUser(req, res)) return;
      await respondWithState(req, res);
    } catch (error) {
      fail(res, error, "Failed to load AI message access");
    }
  },

  /**
   * POST /users/me/ai-message-access/approval   body: { wordingVersion: string }
   * Records express approval. The server stores the exact wording for that
   * version (client text is never trusted). 409 WORDING_VERSION_MISMATCH when the
   * version is not the current one. Idempotent while already approved.
   */
  async approve(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      if (refusedForeignUser(req, res)) return;
      const { wordingVersion } = (req.body ?? {}) as { wordingVersion?: unknown };
      if (typeof wordingVersion !== "string" || !wordingVersion) {
        sendError(res, "VALIDATION_ERROR", "`wordingVersion` is required", 400);
        return;
      }
      await aiMessageAccessService.approve(req.userId!, wordingVersion, req.ip);
      await respondWithState(req, res, "AI message access approved");
    } catch (error) {
      fail(res, error, "Failed to save approval");
    }
  },

  /**
   * DELETE /users/me/ai-message-access/approval
   * Withdraws the approval from this moment. Idempotent.
   */
  async revoke(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      if (refusedForeignUser(req, res)) return;
      await aiMessageAccessService.revoke(req.userId!);
      await respondWithState(req, res, "Approval withdrawn");
    } catch (error) {
      fail(res, error, "Failed to withdraw approval");
    }
  },

  /**
   * PUT /users/me/ai-message-access/account-wide-off   body: { off: boolean }
   * Turns AI access off (or back on) for ALL the caller's chats, existing and new.
   */
  async setAccountWideOff(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      if (refusedForeignUser(req, res)) return;
      const { off } = (req.body ?? {}) as { off?: unknown };
      if (typeof off !== "boolean") {
        sendError(res, "VALIDATION_ERROR", "`off` must be a boolean", 400);
        return;
      }
      await aiMessageAccessService.setAccountWideOff(req.userId!, off);
      await respondWithState(req, res, "AI message access updated");
    } catch (error) {
      fail(res, error, "Failed to update AI message access");
    }
  },

  /**
   * POST /users/me/ai-message-access/notice-dismissed
   * Records, on the server, that the caller dismissed the one-time notice.
   */
  async dismissNotice(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      if (refusedForeignUser(req, res)) return;
      await aiMessageAccessService.dismissNotice(req.userId!);
      await respondWithState(req, res, "Notice dismissed");
    } catch (error) {
      fail(res, error, "Failed to record the dismissal");
    }
  },

  /**
   * GET /admin/users/:uid/ai-message-access-audit?limit=
   * ADMIN ONLY (route is behind verifyAdmin). Newest-first audit rows for one
   * person. Read-only: the API has no way to edit or delete audit records.
   */
  async listAudit(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const limit = parseInt(String(req.query.limit ?? ""), 10);
      const rows = await aiMessageAccessService.listAudit(req.params.uid, Number.isFinite(limit) ? limit : 100);
      sendSuccess(res, rows);
    } catch (error) {
      fail(res, error, "Failed to load the audit trail");
    }
  },
};
