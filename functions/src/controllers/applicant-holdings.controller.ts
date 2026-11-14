import { Response } from "express";
import { AuthenticatedRequest } from "../middleware/auth";
import { applicantHoldingsService, HoldingsValidationError, type ApplicantHoldingsService } from "../services/applicant-holdings.service";
import { sendError, sendSuccess, sendCreated, ErrorMessages } from "../utils/response";

// ============================================
// WHAT THE APPLICANT HOLDS — CONTROLLER (issue #234, P5 of #228)
// ============================================
//
// Every handler acts on `req.userId` (the signed-in caller) and nothing else:
// no path or body field can name another user, so only the user reads or
// changes their own holdings. Refusals name the FIELD, never the value; errors
// are logged without the request body (holdings are personal data).

/** Answer a service refusal (400 / 404), or a plain 500 without logging any value. */
function fail(res: Response, error: unknown, what: string): void {
  if (error instanceof HoldingsValidationError) {
    sendError(res, error.status === 404 ? "NOT_FOUND" : "VALIDATION_ERROR", error.message, error.status);
    return;
  }
  // Only the error's name: never the body or the stored values.
  console.error(`[holdings] ${what} failed:`, error instanceof Error ? error.name : "unknown error");
  sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
}

export class ApplicantHoldingsController {
  constructor(private readonly service: ApplicantHoldingsService = applicantHoldingsService) {}

  /** GET /users/me/holdings */
  async get(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      sendSuccess(res, await this.service.get(req.userId!));
    } catch (error) {
      fail(res, error, "read");
    }
  }

  /** PUT /users/me/holdings  body: { nationalities?, residentialCountry?, heldDocuments? } */
  async update(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      sendSuccess(res, await this.service.update(req.userId!, req.body), "What you hold is saved");
    } catch (error) {
      fail(res, error, "update");
    }
  }

  /** POST /users/me/holdings/documents  body: one held document */
  async addDocument(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      sendCreated(res, await this.service.addDocument(req.userId!, req.body), "Document added");
    } catch (error) {
      fail(res, error, "add document");
    }
  }

  /** DELETE /users/me/holdings/documents/:documentId */
  async removeDocument(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      sendSuccess(res, await this.service.removeDocument(req.userId!, String(req.params.documentId ?? "")), "Document removed");
    } catch (error) {
      fail(res, error, "remove document");
    }
  }
}

export const applicantHoldingsController = new ApplicantHoldingsController();
