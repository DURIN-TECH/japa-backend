/**
 * ChecklistController (issue #114): `GET /applications/:id/checklist` and
 * `POST /applications/:id/checklist/refresh`.
 *
 * Authorization (every route):
 *  - both: `checkApplicationAccess` ("read") on the application, so another
 *    agency's user or a different applicant gets FORBIDDEN;
 *  - refresh (writes): additionally only the APPLICANT of a self-service
 *    (`mode: "self"`) application, with "update" access. Agents and owners may
 *    read, not generate.
 * Not gated by `ai.case_officer`: the list contains no model decision.
 * This is a separate server-side path; `POST /document-requests` still bars
 * the applicant from raising requests for themselves.
 */
import { Response } from "express";
import { AuthenticatedRequest } from "../middleware/auth";
import { applicationService } from "../services/application.service";
import { checklistService } from "../services/ai/checklist.service";
import { checkApplicationAccessForRequest } from "../utils/access";
import { sendSuccess, sendError, ErrorMessages } from "../utils/response";

export class ChecklistController {
  /** GET /applications/:id/checklist — read the list, no writes. */
  async get(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const application = await applicationService.getApplicationById(req.params.id);
      if (!application) {
        sendError(res, "NOT_FOUND", "Application not found", 404);
        return;
      }
      if (!checkApplicationAccessForRequest(req, application, "read")) {
        sendError(res, "FORBIDDEN", ErrorMessages.FORBIDDEN, 403);
        return;
      }
      sendSuccess(res, await checklistService.getChecklist(application));
    } catch (error) {
      console.error("Error reading checklist:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  /** POST /applications/:id/checklist/refresh — build + store, applicant only. */
  async refresh(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const application = await applicationService.getApplicationById(req.params.id);
      if (!application) {
        sendError(res, "NOT_FOUND", "Application not found", 404);
        return;
      }
      const isApplicant = application.userId === req.userId;
      if (
        !isApplicant ||
        application.mode !== "self" ||
        !checkApplicationAccessForRequest(req, application, "update")
      ) {
        sendError(res, "FORBIDDEN", ErrorMessages.FORBIDDEN, 403);
        return;
      }
      sendSuccess(res, await checklistService.refreshChecklist(application));
    } catch (error) {
      console.error("Error refreshing checklist:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }
}

export const checklistController = new ChecklistController();
