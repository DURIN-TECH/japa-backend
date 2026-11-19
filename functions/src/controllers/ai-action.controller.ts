import { NextFunction, Response } from "express";
import { ROLES } from "@durin-tech/authz";
import { AuthenticatedRequest } from "../middleware/auth";
import { paymentRequired } from "../middleware/authz";
import { collections } from "../utils/firebase";
import { checkApplicationAccessForRequest } from "../utils/access";
import { sendError, sendForbidden, sendNotFound, sendSuccess } from "../utils/response";
import type { Application } from "../types";
import type { ApplicationAssessment, ProposedAction } from "../types/assessment";
import { aiActionService, serializeProposedAction } from "../services/ai-action.service";
import { userService } from "../services/user.service";
import { tierFor } from "../services/ai/tier-serializer";

// ============================================
// AI PROPOSED ACTIONS — HANDLERS (issue #44)
// ============================================
//
// Mounted under /ai (routes/ai.routes.ts):
//
//   GET  /ai/assessments/:id/actions                      list the proposals
//   POST /ai/assessments/:id/actions/:actionId/accept     accept (may create a DocumentRequest)
//   POST /ai/assessments/:id/actions/:actionId/reject     reject, with an optional reason
//
// Order in every handler: plan gate (route middleware) -> load the assessment
// and its application -> the shared access check (`checkApplicationAccess`) ->
// who-may-act rules -> the service.

/**
 * Route guard: the caller's plan must include `ai.case_officer`. FAILS CLOSED:
 * unlike `requireFeature` (which lets a caller through when entitlements are not
 * resolved), a caller whose entitlements cannot be resolved is refused here, as in
 * #42. Admins pass. Reuses `tierFor`, so the rule is the same one that decides the
 * full assessment: "full" tier = may use actions.
 */
export function requireCaseOfficerPlanFailClosed(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
  if (tierFor(req.authz?.role, req.entitlements) === "full") return next();
  paymentRequired(res, "Proposed actions need the case-officer plan.");
}

/** The application for an id, or null. */
async function loadApplication(id: string): Promise<Application | null> {
  const snap = await collections.applications.doc(id).get();
  return snap.exists ? ({ id: snap.id, ...snap.data() } as Application) : null;
}

/** The assessment for an id, or null. */
async function loadAssessment(id: string): Promise<ApplicationAssessment | null> {
  const snap = await collections.applicationAssessments.doc(id).get();
  return snap.exists ? (snap.data() as ApplicationAssessment) : null;
}

/**
 * A self-service application: no agent and no agency on it. Only then may the
 * applicant decide on actions themselves. Once an agent or agency is on the case,
 * the agent side decides and the client only sees the result (the DocumentRequest).
 */
function isSelfService(app: Application): boolean {
  return !app.agentId && !app.agencyId;
}

/** May this caller act on this action? A client may act on client-owned actions of a self-service case only. */
function clientMayAct(req: AuthenticatedRequest, app: Application, action: ProposedAction): boolean {
  if (req.authz?.role !== ROLES.CLIENT) return true; // agent-side access was decided by the shared check
  return app.userId === req.authz?.uid && isSelfService(app) && action.ownerRole === "client";
}

export class AiActionController {
  /** GET /ai/assessments/:id/actions: the proposals, whitelisted per caller. */
  async list(req: AuthenticatedRequest, res: Response): Promise<void> {
    const assessment = await loadAssessment(req.params.id);
    if (!assessment) return sendNotFound(res, "Assessment not found");
    const app = await loadApplication(assessment.applicationId);
    // The check is on the parent application, never on the assessment id alone.
    if (!app || !checkApplicationAccessForRequest(req, app, "read")) return sendForbidden(res);

    const all = await aiActionService.listForAssessment(assessment.id);
    // A client-role caller sees only client-owned actions (agent tasks are internal).
    const visible = req.authz?.role === ROLES.CLIENT ? all.filter((a) => a.ownerRole === "client") : all;
    return sendSuccess(res, { assessmentId: assessment.id, actions: visible.map((a) => serializeProposedAction(a, req.authz?.role)) });
  }

  /**
   * POST /ai/assessments/:id/actions/:actionId/accept
   * Body: { acknowledgeRubricChange?: boolean }
   * 200 { action, documentRequestId, alreadyAccepted }
   * 409 RUBRIC_NOT_CURRENT when the rubric moved on and the caller has not acknowledged.
   */
  async accept(req: AuthenticatedRequest, res: Response): Promise<void> {
    const ctx = await this.loadForDecision(req, res);
    if (!ctx) return;
    const { app, assessment, action } = ctx;

    const body = (req.body ?? {}) as { acknowledgeRubricChange?: unknown };
    const outcome = await aiActionService.accept(
      app,
      assessment,
      action.id,
      await this.actorOf(req),
      // Only a literal `true` acknowledges.
      { acknowledgeRubricChange: body.acknowledgeRubricChange === true }
    );

    switch (outcome.kind) {
    case "not_found":
      return sendNotFound(res, "Action not found");
    case "rejected_already":
      return sendError(res, "ACTION_REJECTED", "This action was rejected and cannot be accepted.", 409);
    case "rubric_not_current":
      return sendError(
        res,
        "RUBRIC_NOT_CURRENT",
        "The rules this assessment used have been updated since. Send acknowledgeRubricChange: true to accept anyway.",
        409
      );
    case "already_accepted":
      return sendSuccess(res, {
        action: serializeProposedAction(outcome.action, req.authz?.role),
        documentRequestId: outcome.documentRequestId,
        alreadyAccepted: true,
      });
    case "accepted":
      return sendSuccess(res, {
        action: serializeProposedAction(outcome.action, req.authz?.role),
        documentRequestId: outcome.documentRequestId,
        alreadyAccepted: false,
      });
    }
  }

  /**
   * POST /ai/assessments/:id/actions/:actionId/reject
   * Body: { reason?: string }
   */
  async reject(req: AuthenticatedRequest, res: Response): Promise<void> {
    const ctx = await this.loadForDecision(req, res);
    if (!ctx) return;
    const { app, assessment, action } = ctx;

    const raw = (req.body ?? {}).reason;
    if (raw !== undefined && raw !== null && typeof raw !== "string") {
      return sendError(res, "VALIDATION_ERROR", "reason must be a string", 400);
    }
    const outcome = await aiActionService.reject(app, assessment.id, action.id, await this.actorOf(req), typeof raw === "string" && raw.trim() ? raw : null);

    switch (outcome.kind) {
    case "not_found":
      return sendNotFound(res, "Action not found");
    case "not_rejectable":
      return sendError(res, "ACTION_NOT_REJECTABLE", `This action is already ${outcome.status}.`, 409);
    case "already_rejected":
    case "rejected":
      return sendSuccess(res, { action: serializeProposedAction(outcome.action, req.authz?.role) });
    }
  }

  /**
   * Shared front half of accept and reject: load, check access (write level), and
   * apply the who-may-act rule. Sends the error itself and returns null on failure.
   * Every refusal for a missing OR forbidden object is the same shape as the rest
   * of /ai: 404 when it does not exist, 403 when the caller has no access.
   */
  private async loadForDecision(
    req: AuthenticatedRequest,
    res: Response
  ): Promise<{ app: Application; assessment: ApplicationAssessment; action: ProposedAction } | null> {
    const assessment = await loadAssessment(req.params.id);
    if (!assessment) {
      sendNotFound(res, "Assessment not found");
      return null;
    }
    const app = await loadApplication(assessment.applicationId);
    // Deciding is a write-level act: a read-only agency colleague may not.
    if (!app || !checkApplicationAccessForRequest(req, app, "update")) {
      sendForbidden(res);
      return null;
    }
    const action = await aiActionService.getAction(assessment.id, req.params.actionId);
    if (!action || action.applicationId !== app.id) {
      sendNotFound(res, "Action not found");
      return null;
    }
    if (!clientMayAct(req, app, action)) {
      sendForbidden(res);
      return null;
    }
    return { app, assessment, action };
  }

  /** The deciding user, with a display name for the request and the note. */
  private async actorOf(req: AuthenticatedRequest): Promise<{ uid: string; name: string }> {
    const uid = req.authz?.uid ?? "unknown";
    return { uid, name: (await userService.getDisplayName(uid)) || "" };
  }
}

export const aiActionController = new AiActionController();
