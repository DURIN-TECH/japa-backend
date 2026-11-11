import { Response } from "express";
import { AuthenticatedRequest } from "../middleware/auth";
import { paymentRequired } from "../middleware/authz";
import { collections } from "../utils/firebase";
import { checkApplicationAccessForRequest } from "../utils/access";
import { sendError, sendNotFound, sendForbidden, sendSuccess } from "../utils/response";
import type { Application, Document } from "../types";
import { refusalLetterService } from "../services/ai/refusal-letter.service";
import { refusalEnvelope } from "../services/ai/refusal-letter-serializer";
import { documentRequestService } from "../services/document-request.service";
import { tierFor } from "../services/ai/tier-serializer";

// ============================================
// REFUSAL-LETTER ANALYSIS — HANDLERS (issue #122)
// ============================================
//
// Two routes, mounted at /ai (routes/ai.routes.ts), both behind verifyAuth:
//
//   POST /ai/refusal-letters      { documentId } -> 202 { analysisId, status }
//   GET  /ai/refusal-letters/:id                 -> { meta, data }
//
// Order in every handler: load the object, check access with the shared
// `checkApplicationAccess` on its APPLICATION (a cross-agency agent gets
// FORBIDDEN), then the entitlement. The entitlement uses `tierFor` from #42:
// admin and resolved `ai.case_officer` are "full", everything else, including a
// caller whose entitlements could not be resolved, is not, and gets 402
// UPGRADE_REQUIRED (fail closed; this is deliberately NOT `requireFeature`,
// which lets unresolved callers through).
//
// Nothing here logs the letter, a quote or an extracted reason.

/** Application statuses in which the applicant may still add to their document list. */
const EDITABLE_STATUSES = new Set<string>(["draft", "pending_payment", "pending_documents"]);

export class RefusalLetterController {
  /** checklistItemId -> status of the applicant's own checklist requests for the application. */
  private async listedMap(applicationId: string): Promise<Map<string, string>> {
    const rows = await documentRequestService.listChecklistForApplication(applicationId);
    return new Map(rows.filter((r) => r.checklistItemId).map((r) => [r.checklistItemId as string, r.status]));
  }

  /** The application a document belongs to, or null. */
  private async loadApplication(id: string): Promise<Application | null> {
    const snap = await collections.applications.doc(id).get();
    return snap.exists ? ({ id: snap.id, ...snap.data() } as Application) : null;
  }

  /** POST /ai/refusal-letters */
  async create(req: AuthenticatedRequest, res: Response): Promise<void> {
    const documentId = (req.body as { documentId?: unknown } | undefined)?.documentId;
    if (typeof documentId !== "string" || documentId.length === 0 || documentId.length > 200) {
      return sendError(res, "VALIDATION_ERROR", "documentId is required", 400);
    }
    const docSnap = await collections.documents.doc(documentId).get();
    if (!docSnap.exists) return sendNotFound(res, "Document not found");
    const document = { id: docSnap.id, ...docSnap.data() } as Document;
    const app = await this.loadApplication(document.applicationId);
    if (!app) return sendNotFound(res, "Application not found");

    // Starting a paid job is a write-level act.
    if (!checkApplicationAccessForRequest(req, app, "update")) return sendForbidden(res);
    if (tierFor(req.authz?.role, req.entitlements) !== "full") {
      return paymentRequired(res, "Reading a refusal letter needs the case-officer plan.");
    }

    const outcome = await refusalLetterService.requestAnalysis({ document, app, requestedBy: req.authz?.uid ?? "unknown" });
    switch (outcome.kind) {
    case "wrong_document":
      return sendError(res, "VALIDATION_ERROR", "This document was not uploaded as a refusal letter.", 400);
    case "unsupported_type":
      return sendError(res, "UNSUPPORTED_FILE", "Upload the letter as a PDF, JPEG or PNG.", 400);
    case "file_too_large":
      return sendError(res, "FILE_TOO_LARGE", "This file is too large to read. Try a smaller file.", 413);
    case "per_user_cap":
      return sendError(res, "RATE_LIMITED", "You have reached today's limit for reading letters. Try again tomorrow.", 429);
    case "disabled":
      return sendError(res, "AI_UNAVAILABLE", "Reading letters is not available right now.", 503);
    case "existing": {
      // The same letter, already read: return the stored result.
      if (outcome.status === "succeeded") {
        const stored = await refusalLetterService.getById(outcome.analysisId);
        if (stored) return sendSuccess(res, refusalEnvelope(stored, await this.listedMap(stored.applicationId)));
      }
      return sendSuccess(res, { analysisId: outcome.analysisId, status: outcome.status }, undefined, 202);
    }
    case "created":
    case "requeued":
      return sendSuccess(res, { analysisId: outcome.analysisId, status: outcome.status }, undefined, 202);
    }
  }

  /** GET /ai/refusal-letters/:id */
  async byId(req: AuthenticatedRequest, res: Response): Promise<void> {
    const analysis = await refusalLetterService.getById(req.params.id);
    if (!analysis) return sendNotFound(res, "Analysis not found");
    // The check is on the parent application, never on the analysis id alone.
    const app = await this.loadApplication(analysis.applicationId);
    if (!app || !checkApplicationAccessForRequest(req, app, "read")) return sendForbidden(res);
    if (tierFor(req.authz?.role, req.entitlements) !== "full") {
      return paymentRequired(res, "Reading a refusal letter needs the case-officer plan.");
    }
    return sendSuccess(res, refusalEnvelope(analysis, await this.listedMap(analysis.applicationId)));
  }

  /**
   * POST /ai/refusal-letters/:id/checklist/confirm  { checklistItemIds: string[] }
   * The applicant (and only the applicant) puts chosen items on their document
   * list. Access: `update` on the application, applicant uid, full tier, and an
   * editable application status. Ids only: items are read from the stored analysis.
   */
  async confirmChecklist(req: AuthenticatedRequest, res: Response): Promise<void> {
    const ids = (req.body as { checklistItemIds?: unknown } | undefined)?.checklistItemIds;
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > 50 || !ids.every((x) => typeof x === "string" && x.length > 0 && x.length < 200)) {
      return sendError(res, "VALIDATION_ERROR", "checklistItemIds must be a non-empty list of ids", 400);
    }
    const analysis = await refusalLetterService.getById(req.params.id);
    if (!analysis) return sendNotFound(res, "Analysis not found");
    const app = await this.loadApplication(analysis.applicationId);
    if (!app || !checkApplicationAccessForRequest(req, app, "update")) return sendForbidden(res);
    // Only the applicant adds to their own list: staff access is not enough.
    if (!req.authz?.uid || req.authz.uid !== app.userId) return sendForbidden(res, "Only the applicant can add these to their document list.");
    if (tierFor(req.authz?.role, req.entitlements) !== "full") {
      return paymentRequired(res, "Reading a refusal letter needs the case-officer plan.");
    }
    // Editable = not yet with a decision maker or closed.
    if (!EDITABLE_STATUSES.has(app.status)) {
      return sendError(res, "APPLICATION_LOCKED", "This application can no longer be changed.", 409);
    }

    const outcome = await refusalLetterService.confirmChecklist({
      analysis,
      app,
      checklistItemIds: ids as string[],
      confirmedBy: req.authz.uid,
    });
    if (outcome.kind === "not_ready") return sendError(res, "NOT_READY", "This letter has not been analysed yet.", 409);
    if (outcome.kind === "unknown_ids") return sendError(res, "VALIDATION_ERROR", "One or more items are not on this letter's checklist.", 400);
    return sendSuccess(res, { added: outcome.added, alreadyListed: outcome.alreadyListed });
  }
}

export const refusalLetterController = new RefusalLetterController();
