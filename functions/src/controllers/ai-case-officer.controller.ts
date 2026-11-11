import { Response } from "express";
import { AuthenticatedRequest } from "../middleware/auth";
import { paymentRequired } from "../middleware/authz";
import { collections } from "../utils/firebase";
import { checkApplicationAccessForRequest } from "../utils/access";
import { sendError, sendSuccess, sendNotFound, sendForbidden } from "../utils/response";
import type { Application } from "../types";
import type { ApplicationAssessment } from "../types/assessment";
import { aiCaseOfficerService } from "../services/ai-case-officer.service";
import { envelope, tierFor } from "../services/ai/tier-serializer";

// ============================================
// AI CASE-OFFICER — HANDLERS (issue #42)
// ============================================
//
// Three routes, mounted at /ai (routes/ai.routes.ts). Every one is behind
// verifyAuth. Each handler does three things in this order:
//
//   1. load the object and check access with the shared `checkApplicationAccess`
//      (utils/access.ts). A cross-agency agent gets FORBIDDEN here;
//   2. decide the TIER from the caller's entitlement (services/ai/tier-serializer.ts).
//      There is no blanket requireFeature in front of the free response: a free
//      caller gets the band and the top three, not a 402;
//   3. answer through the tier serializer, the only path to a response body.
//
// The tier is decided here, in the handler, and not in middleware, so that the
// unresolved-entitlement rule (fail closed to the free response) applies to these
// handlers only. middleware/authz.ts is unchanged for every other route.

/** The application for a path id, or null. */
async function loadApplication(id: string): Promise<Application | null> {
  const snap = await collections.applications.doc(id).get();
  return snap.exists ? ({ id: snap.id, ...snap.data() } as Application) : null;
}

export class AiCaseOfficerController {
  /**
   * POST /ai/applications/:id/assess
   * 202 { assessmentId, status } when a job is queued or already running;
   * 200 with the stored result (in the caller's tier) when the inputs are unchanged;
   * 402 UPGRADE_REQUIRED for a free caller re-running changed inputs;
   * 404 NO_APPROVED_RUBRIC when the route has no approved rubric.
   */
  async assess(req: AuthenticatedRequest, res: Response): Promise<void> {
    const app = await loadApplication(req.params.id);
    if (!app) return sendNotFound(res, "Application not found");
    // Starting a paid job is a write-level act: a read-only colleague may not start one.
    if (!checkApplicationAccessForRequest(req, app, "update")) return sendForbidden(res);

    const tier = tierFor(req.authz?.role, req.entitlements);
    const outcome = await aiCaseOfficerService.requestAssessment(app, {
      tier,
      trigger: "manual",
      requestedBy: req.authz?.uid ?? "unknown",
    });

    switch (outcome.kind) {
    case "no_rubric":
      return sendError(
        res,
        "NO_APPROVED_RUBRIC",
        `There is no approved rubric for the route ${outcome.routeKey}, so no assessment can be made.`,
        404
      );
    case "upgrade_required":
      return paymentRequired(res, "A new assessment for changed information needs the case-officer plan.");
    case "stored": {
      const stored = await aiCaseOfficerService.getById(outcome.assessmentId);
      if (!stored) return sendNotFound(res, "Assessment not found");
      return sendSuccess(res, await this.envelopeFor(stored, tier, req));
    }
    case "running":
    case "queued":
    case "created":
      return sendSuccess(res, { assessmentId: outcome.assessmentId, status: outcome.status }, undefined, 202);
    }
  }

  /** GET /ai/applications/:id/assessment: the latest assessment for the application. */
  async latest(req: AuthenticatedRequest, res: Response): Promise<void> {
    const app = await loadApplication(req.params.id);
    if (!app) return sendNotFound(res, "Application not found");
    if (!checkApplicationAccessForRequest(req, app, "read")) return sendForbidden(res);

    const latest = await aiCaseOfficerService.latestFor(app.id);
    if (!latest) return sendError(res, "NO_ASSESSMENT", "This application has no assessment yet.", 404);
    const tier = tierFor(req.authz?.role, req.entitlements);
    return sendSuccess(res, await this.envelopeFor(latest, tier, req));
  }

  /** GET /ai/assessments/:id: one assessment, access checked on its application. */
  async byId(req: AuthenticatedRequest, res: Response): Promise<void> {
    const assessment = await aiCaseOfficerService.getById(req.params.id);
    if (!assessment) return sendNotFound(res, "Assessment not found");
    const app = await loadApplication(assessment.applicationId);
    // The check is on the parent application, never on the assessment id alone.
    if (!app || !checkApplicationAccessForRequest(req, app, "read")) return sendForbidden(res);
    const tier = tierFor(req.authz?.role, req.entitlements);
    return sendSuccess(res, await this.envelopeFor(assessment, tier, req));
  }

  /** The envelope for one assessment, with the stale flag from the approved version. */
  private async envelopeFor(assessment: ApplicationAssessment, tier: "free" | "full", req: AuthenticatedRequest) {
    const approved = await aiCaseOfficerService.approvedVersionOf(assessment.countryCode, assessment.visaTypeId);
    return envelope(assessment, tier, req.authz?.role, approved);
  }
}

export const aiCaseOfficerController = new AiCaseOfficerController();
