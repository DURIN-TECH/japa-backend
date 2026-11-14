import { Response } from "express";
import { AuthenticatedRequest } from "../middleware/auth";
import { ErrorMessages, sendError, sendSuccess } from "../utils/response";
import { applicationService } from "../services/application.service";
import { CompetenceError, competenceService } from "../services/competence.service";
import { IntakeValidationError } from "../services/intake.service";

// ============================================
// APPLY THROUGH — APPLICANT API (issue #235, P6 of #228)
// ============================================
//
//   GET  /shared-routes/:id/apply-through?agentId=...   the step with no answers yet
//   POST /shared-routes/:id/apply-through               { answers?, agentId? }: the proposal
//
// Read-only: nothing is written (the choice is recorded when the application
// is created, POST /applications with `sharedRouteId` + `throughCountryCode`).
// Any signed-in user (`verifyAuth`): it shows only what the applicant may see,
// the member countries whose record is usable for the case (public records;
// an agency-only record only for a case of that agency, from `agentId`,
// exactly as case creation decides), and rules data (quotes and URLs).
//
// Errors: 404 NOT_FOUND (unknown or retired route), 400 VALIDATION_ERROR (an
// answer that is not allowed; the message names the question).

/** The case's agency, from the agent the applicant names (same rule as POST /applications in agent mode). */
async function caseAgencyOf(agentId: unknown): Promise<string | undefined> {
  return typeof agentId === "string" && agentId ? applicationService.resolveAgentAgencyId(agentId) : undefined;
}

/** Send a refusal in the shared `{ success:false, error, message }` shape. */
function fail(res: Response, err: unknown): void {
  if (err instanceof CompetenceError) {
    sendError(res, err.code, err.message, err.status);
    return;
  }
  if (err instanceof IntakeValidationError) {
    sendError(res, "VALIDATION_ERROR", err.message, 400);
    return;
  }
  // Never log answers: they are personal data.
  console.error("ApplyThrough: error:", err instanceof Error ? err.message : "unknown");
  sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
}

class ApplyThroughController {
  /** GET: the member countries offered, the questions and the rule, before any answer. */
  async get(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const agencyId = await caseAgencyOf((req.query as Record<string, unknown>).agentId);
      sendSuccess(res, await competenceService.propose(req.params.id, undefined, agencyId));
    } catch (err) {
      fail(res, err);
    }
  }

  /** POST: the same, with the applicant's answers, so the proposal (if any) is worked out. */
  async propose(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const body = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? (req.body as Record<string, unknown>) : {};
      const extra = Object.keys(body).find((k) => k !== "answers" && k !== "agentId");
      if (extra) {
        sendError(res, "VALIDATION_ERROR", `"${extra}" is not a known field`, 400);
        return;
      }
      const agencyId = await caseAgencyOf(body.agentId);
      sendSuccess(res, await competenceService.propose(req.params.id, body.answers, agencyId));
    } catch (err) {
      fail(res, err);
    }
  }
}

export const applyThroughController = new ApplyThroughController();
