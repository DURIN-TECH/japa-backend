import { Response } from "express";
import { AuthenticatedRequest } from "../middleware/auth";
import { paymentRequired } from "../middleware/authz";
import { collections } from "../utils/firebase";
import { checkApplicationAccessForRequest } from "../utils/access";
import { sendError, sendSuccess, sendNotFound, sendForbidden } from "../utils/response";
import type { Application } from "../types";
import { stackLayersField } from "../shared-routes/stack-layers-view";
import type { ApplicationAssessment } from "../types/assessment";
import { rubricRouteKey } from "../scrapers";
import { aiCaseOfficerService, type ReviewMissingPart } from "../services/ai-case-officer.service";
import { ROLES } from "@durin-tech/authz";
import { envelope, tierFor, workingFor } from "../services/ai/tier-serializer";

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
//      (#384) Beside the tier it decides the WORKING (`workingFor`): whether
//      `data` carries the rule-by-rule findings. A client-role caller needs
//      `ai.case_officer` AND `ai.review_working` for it; staff keep it on the
//      full tier. Without it a client gets the reading body (band, blocking
//      rule, top issues, narrative, country context). `meta.working` says which.
//
// The tier is decided here, in the handler, and not in middleware, so that the
// unresolved-entitlement rule (fail closed to the free response) applies to these
// handlers only. middleware/authz.ts is unchanged for every other route.

/** The application for a path id, or null. */
async function loadApplication(id: string): Promise<Application | null> {
  const snap = await collections.applications.doc(id).get();
  return snap.exists ? ({ id: snap.id, ...snap.data() } as Application) : null;
}

/**
 * (#309) 422 NOT_ENOUGH_TO_REVIEW. The usual error envelope plus two
 * machine-readable fields at the top level (as other error bodies with extra
 * fields do), so the app can show one "still needed" line per part:
 *
 *   { success: false, error: "NOT_ENOUGH_TO_REVIEW", message,
 *     missing: ("intake" | "documents")[],   // in this order, never empty
 *     openRequiredCount: number }            // open required questions; 0 when "intake" is not missing
 */
function notEnoughToReview(res: Response, missing: ReviewMissingPart[], openRequiredCount: number): void {
  // A plain sentence built from the parts, for clients that show the message as is.
  const parts: string[] = [];
  if (missing.includes("intake")) {
    parts.push(openRequiredCount === 1 ? "answer the 1 required question" : `answer the ${openRequiredCount} required questions`);
  }
  if (missing.includes("documents")) parts.push("upload at least one document");
  res.status(422).json({
    success: false,
    error: "NOT_ENOUGH_TO_REVIEW",
    message: `Your application needs a little more before it can be reviewed: ${parts.join(" and ")}.`,
    missing,
    openRequiredCount,
  });
}

export class AiCaseOfficerController {
  /**
   * POST /ai/applications/:id/assess
   * 202 { assessmentId, status } when a job is queued or already running;
   * 200 with the stored result (in the caller's tier) when the inputs are unchanged;
   * 402 UPGRADE_REQUIRED for a free caller re-running changed inputs;
   * 404 NO_APPROVED_RUBRIC when the route has no approved rubric;
   * (#309) 422 NOT_ENOUGH_TO_REVIEW when the application has not enough in it
   * to review (see notEnoughToReview below for the body);
   * 500 INTERNAL_ERROR on an unexpected failure (never a hung request).
   *
   * Order: 404 missing application, 403 access, 404 no rubric, 422 not enough,
   * then the tier / free re-run decision. A caller who may not update the
   * application never learns what it contains.
   */
  async assess(req: AuthenticatedRequest, res: Response): Promise<void> {
    // (#309) Express 4 does not catch a rejected async handler: without this
    // the request would hang. Only this handler is wrapped (scope of #309).
    try {
      const app = await loadApplication(req.params.id);
      if (!app) return sendNotFound(res, "Application not found");
      // Starting a paid job is a write-level act: a read-only colleague may not start one.
      if (!checkApplicationAccessForRequest(req, app, "update")) return sendForbidden(res);

      const tier = tierFor(req.authz?.role, req.entitlements);
      const outcome = await aiCaseOfficerService.requestAssessment(app, {
        tier,
        trigger: "manual",
        requestedBy: req.authz?.uid ?? "unknown",
        // (#309) Manual requests only: refuse an application with nothing to review.
        requireContent: true,
      });
      return await this.answerAssess(outcome, tier, req, res, app);
    } catch (error) {
      console.error("[ai-case-officer] assess failed:", (error as Error)?.name ?? "error");
      return sendError(res, "INTERNAL_ERROR", "The review could not be started. Please try again.", 500);
    }
  }

  /** The response for one request outcome (the switch `assess` used to hold inline). */
  private async answerAssess(
    outcome: Awaited<ReturnType<typeof aiCaseOfficerService.requestAssessment>>,
    tier: "free" | "full",
    req: AuthenticatedRequest,
    res: Response,
    app: Application
  ): Promise<void> {
    switch (outcome.kind) {
    case "no_rubric":
      return sendError(
        res,
        "NO_APPROVED_RUBRIC",
        `There is no approved rubric for the route ${outcome.routeKey}, so no assessment can be made.`,
        404
      );
    case "not_enough":
      return notEnoughToReview(res, outcome.missing, outcome.openRequiredCount);
    case "attempts_exhausted":
      // Never returned here (only the #117 auto-run sets maxAttempts); kept so
      // the switch covers every outcome instead of falling through silently.
      return sendError(res, "INTERNAL_ERROR", "The review could not be started. Please try again.", 500);
    case "upgrade_required":
      return paymentRequired(res, "A new assessment for changed information needs the case-officer plan.");
    case "stored": {
      const stored = await aiCaseOfficerService.getById(outcome.assessmentId);
      if (!stored) return sendNotFound(res, "Assessment not found");
      return sendSuccess(res, await this.envelopeFor(stored, tier, req, app));
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
    if (!latest) {
      // Two different empty states, told apart: the route has no approved rubric
      // (nothing can be assessed yet), or it has one and no review has been run.
      // (#233) For a route on a rulebook stack: "assessable" means at least one
      // layer approved (single-layer routes: the old head check, unchanged).
      if (!(await aiCaseOfficerService.hasApprovedRulebook(app))) {
        return sendError(
          res,
          "NO_APPROVED_RUBRIC",
          `There is no approved rubric for the route ${rubricRouteKey(app.countryCode, app.visaTypeId)}, so no assessment can be made.`,
          404
        );
      }
      return sendError(res, "NO_ASSESSMENT", "This application has no assessment yet.", 404);
    }
    const tier = tierFor(req.authz?.role, req.entitlements);
    return sendSuccess(res, await this.envelopeFor(latest, tier, req, app));
  }

  /** GET /ai/assessments/:id: one assessment, access checked on its application. */
  async byId(req: AuthenticatedRequest, res: Response): Promise<void> {
    const assessment = await aiCaseOfficerService.getById(req.params.id);
    if (!assessment) return sendNotFound(res, "Assessment not found");
    const app = await loadApplication(assessment.applicationId);
    // The check is on the parent application, never on the assessment id alone.
    if (!app || !checkApplicationAccessForRequest(req, app, "read")) return sendForbidden(res);
    const tier = tierFor(req.authz?.role, req.entitlements);
    return sendSuccess(res, await this.envelopeFor(assessment, tier, req, app));
  }

  /** The envelope for one assessment, with the stale reason computed here, server-side. */
  private async envelopeFor(assessment: ApplicationAssessment, tier: "free" | "full", req: AuthenticatedRequest, app: Application) {
    const staleReason = await aiCaseOfficerService.staleReasonOf(app, assessment);
    // Staff only (#43): a display name for who asked, never the uid. Applicants
    // get nothing, so the lookup is skipped for them.
    const requestedByName = await this.requesterNameFor(assessment, tier, req.authz?.role);
    // (#384) The working is decided here, from the same role and entitlements as the tier.
    const working = workingFor(req.authz?.role, req.entitlements, tier);
    const env = envelope(assessment, tier, req.authz?.role, staleReason, requestedByName, working);
    // (#237) Which layers of the rulebook stack the assessment ran on (keys =
    // the findings' `layerKey`), with names and ready / missing. Layer names
    // and status only, so it is served on every tier. Omitted on one layer.
    return { ...env, meta: { ...env.meta, ...(await stackLayersField(assessment.rulebookLayers)) } };
  }

  /**
   * Display string for `requestedBy`, for staff roles on the full tier only.
   * "System" for any non-manual trigger (or a "system" requester); otherwise the
   * requester's agent display name, else their user name, else a generic label.
   * Returns null for everyone else, so no key is serialised.
   */
  private async requesterNameFor(assessment: ApplicationAssessment, tier: "free" | "full", role: string | undefined): Promise<string | null> {
    if (tier !== "full" || assessment.status !== "succeeded") return null;
    if (role !== ROLES.AGENT && role !== ROLES.OWNER && role !== ROLES.ADMIN) return null;
    if (assessment.trigger !== "manual" || !assessment.requestedBy || assessment.requestedBy === "system") return "System";
    try {
      const agentSnap = await collections.agents.where("userId", "==", assessment.requestedBy).limit(1).get();
      if (!agentSnap.empty) {
        const name = (agentSnap.docs[0].data() as { displayName?: string }).displayName;
        if (name) return name;
      }
      const userDoc = await collections.users.doc(assessment.requestedBy).get();
      if (userDoc.exists) {
        const u = userDoc.data() as { firstName?: string; lastName?: string };
        const name = `${u.firstName || ""} ${u.lastName || ""}`.trim();
        if (name) return name;
      }
    } catch (error) {
      // A display-name lookup must never fail the read.
      console.error("[ai-case-officer] requester name lookup failed:", error);
    }
    return "Unknown user";
  }
}

export const aiCaseOfficerController = new AiCaseOfficerController();
