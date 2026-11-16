import { Response } from "express";
import { AuthenticatedRequest } from "../middleware/auth";
import {
  parseSavedDestinationKey,
  SavedDestinationError,
  savedDestinationsService,
  type SavedDestinationsService,
} from "../services/saved-destinations.service";
import { sendError, sendSuccess, ErrorMessages } from "../utils/response";

// ============================================
// SAVED DESTINATIONS — CONTROLLER (issue #146)
// ============================================
//
// Every handler acts on `req.userId` (the uid of the verified token, set by
// verifyAuth) and nothing else: no path, query or body field names a user, so
// a caller can only ever read or change their OWN saved list. The request
// body is never read.
//
// Error codes (the mobile app keys its copy on the code, never the message):
//   401                        no / invalid token (verifyAuth)
//   402 UPGRADE_REQUIRED       read-only plan on PUT / DELETE (verifyAuth)
//   404 NOT_FOUND              PUT for a visa that does not exist or is not
//                              publicly visible (same answer for both)
//   409 SAVED_LIMIT_REACHED    PUT when the user already holds the maximum
//   500 INTERNAL_ERROR         anything unexpected

/** Message for a visa that cannot be saved (unknown, hidden, or an id that cannot name one). */
const NOT_AVAILABLE = "This destination is not available to save";

/** Answer a service refusal with its status, or a plain 500. */
function fail(res: Response, error: unknown, what: string): void {
  if (error instanceof SavedDestinationError) {
    // NOT_FOUND -> 404; SAVED_LIMIT_REACHED -> 409 (decided on the issue).
    sendError(res, error.code, error.message, error.code === "NOT_FOUND" ? 404 : 409);
    return;
  }
  console.error(`[saved-destinations] ${what} failed:`, error);
  sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
}

export class SavedDestinationsController {
  constructor(private readonly service: SavedDestinationsService = savedDestinationsService) {}

  /** GET /users/me/saved-destinations -> SavedDestinationItem[] (newest first) */
  async list(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      sendSuccess(res, await this.service.list(req.userId!));
    } catch (error) {
      fail(res, error, "list");
    }
  }

  /** PUT /users/me/saved-destinations/:countryCode/:visaId -> SavedDestinationItem */
  async save(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const key = parseSavedDestinationKey(req.params.countryCode, req.params.visaId);
      // Parameters that cannot name a visa: the same 404 as an unknown visa.
      if (!key) {
        sendError(res, "NOT_FOUND", NOT_AVAILABLE, 404);
        return;
      }
      sendSuccess(res, await this.service.save(req.userId!, key), "Destination saved");
    } catch (error) {
      fail(res, error, "save");
    }
  }

  /** DELETE /users/me/saved-destinations/:countryCode/:visaId -> { countryCode, visaId, saved: false } */
  async remove(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const key = parseSavedDestinationKey(req.params.countryCode, req.params.visaId);
      // Parameters that cannot name a visa can never have been saved, so the
      // idempotent answer is the same success, without touching the database.
      if (key) await this.service.remove(req.userId!, key);
      sendSuccess(
        res,
        {
          countryCode: key?.countryCode ?? String(req.params.countryCode ?? "").toUpperCase(),
          visaId: key?.visaId ?? String(req.params.visaId ?? ""),
          saved: false,
        },
        "Destination removed"
      );
    } catch (error) {
      fail(res, error, "remove");
    }
  }
}

export const savedDestinationsController = new SavedDestinationsController();
