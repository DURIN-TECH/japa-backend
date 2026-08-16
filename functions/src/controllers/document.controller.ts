import { Response } from "express";
import { AuthenticatedRequest } from "../middleware/auth";
import { documentService, UploadActor } from "../services/document.service";
import { documentRequestService } from "../services/document-request.service";
import { notificationService } from "../services/notification.service";
import { userService } from "../services/user.service";
import { subcollections } from "../utils/firebase";
import { checkWithinLimit, paymentRequired, can, asSubject } from "../middleware/authz";
import { LIMITS, Action, ROLES } from "@durin-tech/authz";
import { Application, DocumentUploaderRole, DocumentUploadSource } from "../types";
import {
  sendSuccess,
  sendError,
  sendCreated,
  sendNoContent,
  ErrorMessages,
} from "../utils/response";

/** Values accepted for a document's `uploadSource`, mirrored in the portal form. */
const VALID_UPLOAD_SOURCES: DocumentUploadSource[] = [
  "email",
  "whatsapp",
  "in_person",
  "postal",
  "third_party",
  "other",
];

export class DocumentController {
  /**
   * Load an application and ask the shared CASL ability whether this caller may
   * act on it.
   *
   * WHY: document access used to be re-derived ad-hoc in each handler by
   * comparing uids to `application.userId` / `application.agentId`. That locked
   * out agency owners and admins entirely, and made "agent uploads for a client"
   * impossible. `req.ability` already encodes the full rule set (client → own,
   * agent → assigned, owner → agency-scoped, admin → all), so we defer to it —
   * matching how application.controller authorizes the same resource.
   */
  private async authorizeForApplication(
    req: AuthenticatedRequest,
    applicationId: string,
    action: Action = "read"
  ): Promise<{ application: Application | null; allowed: boolean }> {
    const application = await import("../services/application.service").then((m) =>
      m.applicationService.getApplicationById(applicationId)
    );

    if (!application) return { application: null, allowed: false };

    const allowed = can(
      req,
      action,
      asSubject("Application", application as unknown as Record<string, unknown>)
    );

    return { application, allowed };
  }

  /**
   * Build the `UploadActor` describing who is performing an upload, resolving a
   * display name for the audit trail. `onBehalfAuthorized` is what lets the
   * service accept an upload from someone who is not the application's client.
   */
  private async buildUploadActor(
    req: AuthenticatedRequest,
    onBehalfAuthorized: boolean
  ): Promise<UploadActor> {
    const userId = req.userId!;
    // `req.authz.role` is the authoritative principal role from the token
    // claims; default to client for the (fail-safe) case where it's absent.
    const role = (req.authz?.role ?? ROLES.CLIENT) as DocumentUploaderRole;
    // Resolved for EVERY upload, not just on-behalf ones: the portal's
    // "Uploaded by" column reads this name, so omitting it for self-uploads
    // would leave a client's own document showing no uploader at all. One extra
    // read per upload, which is not a hot path.
    const name = await userService.getDisplayName(userId).catch(() => "");

    return { userId, role, name: name || undefined, onBehalfAuthorized };
  }

  /**
   * POST /documents/upload-url
   * Get a signed URL for uploading a document
   */
  async getUploadUrl(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const userId = req.userId!;
      const { applicationId, fileName, contentType } = req.body;

      if (!applicationId || !fileName || !contentType) {
        sendError(
          res,
          "VALIDATION_ERROR",
          "applicationId, fileName, and contentType are required",
          400
        );
        return;
      }

      // Validate content type
      const allowedTypes = [
        "application/pdf",
        "image/jpeg",
        "image/jpg",
        "image/png",
        "image/heic",
      ];
      if (!allowedTypes.includes(contentType)) {
        sendError(
          res,
          "VALIDATION_ERROR",
          `Invalid content type. Allowed: ${allowedTypes.join(", ")}`,
          400
        );
        return;
      }

      // Authorize against the application. A client uploading to their own case
      // and an agent uploading for a client both land here; CASL tells the two
      // apart and the resulting flag is what permits the on-behalf case.
      const { application, allowed } = await this.authorizeForApplication(
        req,
        applicationId,
        "update"
      );
      if (!application) {
        sendError(res, "NOT_FOUND", "Application not found", 404);
        return;
      }
      const isClientsOwn = application.userId === userId;
      if (!isClientsOwn && !allowed) {
        sendError(res, "FORBIDDEN", ErrorMessages.FORBIDDEN, 403);
        return;
      }

      const actor = await this.buildUploadActor(req, !isClientsOwn && allowed);
      const result = await documentService.getUploadUrl(
        actor,
        applicationId,
        fileName,
        contentType
      );

      sendSuccess(res, result, "Upload URL generated successfully");
    } catch (error) {
      console.error("Error generating upload URL:", error);
      if ((error as Error).message === "Application not found") {
        sendError(res, "NOT_FOUND", "Application not found", 404);
        return;
      }
      if ((error as Error).message === "Unauthorized") {
        sendError(res, "FORBIDDEN", ErrorMessages.FORBIDDEN, 403);
        return;
      }
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  /**
   * POST /documents
   * Register a document after successful upload
   */
  async createDocument(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const userId = req.userId!;
      const {
        applicationId,
        requirementId,
        fileName,
        fileType,
        fileSizeMb,
        storagePath,
        // Optional: the durable agent ask this upload satisfies. When present we
        // close that request out automatically (see below) so the client's to-do
        // list clears itself instead of needing the agent to tick it off.
        documentRequestId,
        // Descriptive metadata + audit fields. Supplied by the agency-side
        // "upload for client" form; absent on self-serve client uploads.
        documentType,
        displayName,
        description,
        uploadReason,
        uploadSource,
      } = req.body;

      // `requirementId` ties a document to a visa requirement. An upload made
      // against an ad-hoc agent ask ("send me your bank statement") has no such
      // requirement, so when `documentRequestId` is supplied we synthesize a
      // stable requirement key from it instead of rejecting the upload. Exactly
      // one of the two must be present.
      const resolvedRequirementId: string | undefined =
        requirementId || (documentRequestId ? `docreq:${documentRequestId}` : undefined);

      if (
        !applicationId ||
        !resolvedRequirementId ||
        !fileName ||
        !fileType ||
        fileSizeMb === undefined ||
        !storagePath
      ) {
        sendError(
          res,
          "VALIDATION_ERROR",
          "applicationId, requirementId (or documentRequestId), fileName, fileType, fileSizeMb, and storagePath are required",
          400
        );
        return;
      }

      // Reject an unknown source up front rather than persisting a value the
      // portal can't render.
      if (uploadSource && !VALID_UPLOAD_SOURCES.includes(uploadSource)) {
        sendError(
          res,
          "VALIDATION_ERROR",
          `Invalid uploadSource. Allowed: ${VALID_UPLOAD_SOURCES.join(", ")}`,
          400
        );
        return;
      }

      // Authorize against the application (same rule as upload-url above).
      const { application: targetApp, allowed } = await this.authorizeForApplication(
        req,
        applicationId,
        "update"
      );
      if (!targetApp) {
        sendError(res, "NOT_FOUND", "Application not found", 404);
        return;
      }
      const isClientsOwn = targetApp.userId === userId;
      if (!isClientsOwn && !allowed) {
        sendError(res, "FORBIDDEN", ErrorMessages.FORBIDDEN, 403);
        return;
      }
      const onBehalf = !isClientsOwn && allowed;

      // Staff uploading for a client must record why. Checked here so the
      // caller gets a 400 with a useful message (the service also enforces it).
      if (onBehalf && !uploadReason?.trim()) {
        sendError(
          res,
          "VALIDATION_ERROR",
          "uploadReason is required when uploading on a client's behalf",
          400
        );
        return;
      }

      // Enforce the per-application document limit (no-op until a plan sets it).
      const docCount = (
        await subcollections.documents(applicationId).count().get()
      ).data().count;
      if (!checkWithinLimit(req, LIMITS.MAX_DOCUMENTS_PER_APPLICATION, docCount)) {
        paymentRequired(
          res,
          "You've reached this application's document limit for your plan. Upgrade to add more."
        );
        return;
      }

      const actor = await this.buildUploadActor(req, onBehalf);
      const document = await documentService.createDocument(actor, {
        applicationId,
        requirementId: resolvedRequirementId,
        fileName,
        fileType,
        fileSizeMb,
        storagePath,
        documentType,
        displayName,
        description,
        uploadReason,
        uploadSource,
      });

      // Close out the agent's ask, if this upload was made against one. Guarded
      // so the request must be addressed to the document's OWNER and belong to
      // the same application — otherwise a crafted request id could tick off
      // someone else's item. Matching on the owner rather than the caller is what
      // lets an agent close a request by uploading the file the client emailed
      // them. Best-effort: a failure here must not fail an upload that already
      // succeeded.
      let fulfilledRequestType: string | undefined;
      if (documentRequestId) {
        try {
          const docRequest = await documentRequestService.getById(documentRequestId);
          if (
            docRequest &&
            docRequest.userId === document.userId &&
            docRequest.applicationId === applicationId
          ) {
            const closed = await documentRequestService.markFulfilled(
              documentRequestId,
              document.id
            );
            if (closed) fulfilledRequestType = docRequest.documentType;
          }
        } catch (e) {
          console.error("[document] fulfilling document request failed:", e);
        }
      }

      // Notify the assigned agent that a document was uploaded for review.
      // Skipped when the agent uploaded it themselves (they already know).
      if (targetApp.agentId && targetApp.agentId !== userId) {
        await notificationService
          .notifyUser({
            userId: targetApp.agentId,
            type: "document_uploaded",
            title: "New document uploaded",
            // Name the ask it satisfies when there was one — that's the detail
            // the agent actually cares about ("the bank statement I asked for").
            body: fulfilledRequestType
              ? `${targetApp.clientName || "A client"} uploaded "${fileName}" for your ` +
                `"${fulfilledRequestType}" request.`
              : `${targetApp.clientName || "A client"} uploaded "${fileName}" for review.`,
            relatedEntityType: "application",
            relatedEntityId: applicationId,
          })
          .catch((e) => console.error("[document] upload notify failed:", e));
      }

      // Tell the CLIENT when staff filed a document for them. Transparency is
      // the point: a document should never appear on someone's case without
      // them being told who put it there.
      if (onBehalf) {
        const label = displayName?.trim() || documentType?.trim() || fileName;
        await notificationService
          .notifyUser({
            userId: document.userId,
            type: "document_uploaded",
            title: "A document was added to your application",
            body:
              `${actor.name || "Your agent"} uploaded "${label}" to your application ` +
              "on your behalf.",
            relatedEntityType: "application",
            relatedEntityId: applicationId,
          })
          .catch((e) => console.error("[document] on-behalf client notify failed:", e));
      }

      sendCreated(res, document, "Document registered successfully");
    } catch (error) {
      console.error("Error creating document:", error);
      if ((error as Error).message === "Application not found") {
        sendError(res, "NOT_FOUND", "Application not found", 404);
        return;
      }
      if ((error as Error).message === "Unauthorized") {
        sendError(res, "FORBIDDEN", ErrorMessages.FORBIDDEN, 403);
        return;
      }
      if ((error as Error).message === "File not found in storage") {
        sendError(res, "VALIDATION_ERROR", "File not found in storage", 400);
        return;
      }
      if ((error as Error).message === "Upload reason required") {
        sendError(
          res,
          "VALIDATION_ERROR",
          "uploadReason is required when uploading on a client's behalf",
          400
        );
        return;
      }
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  /**
   * GET /documents/:id
   * Get a document by ID
   */
  async getDocument(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const userId = req.userId!;
      const { id } = req.params;

      const document = await documentService.getDocumentById(id);

      if (!document) {
        sendError(res, "NOT_FOUND", "Document not found", 404);
        return;
      }

      // Owner, or anyone CASL allows to read the parent application (assigned
      // agent, agency owner, admin). Previously owner-only, which 403'd the very
      // agents expected to review these documents.
      if (document.userId !== userId) {
        const { allowed } = await this.authorizeForApplication(
          req,
          document.applicationId,
          "read"
        );
        if (!allowed) {
          sendError(res, "FORBIDDEN", ErrorMessages.FORBIDDEN, 403);
          return;
        }
      }

      sendSuccess(res, document);
    } catch (error) {
      console.error("Error getting document:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  /**
   * GET /documents/:id/download
   * Get a signed download URL for a document
   */
  async getDownloadUrl(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const userId = req.userId!;
      const { id } = req.params;

      // Resolve CASL access to the parent application first, so agency owners
      // and admins (not just the assigned agent) can open the file — including
      // one they uploaded on the client's behalf.
      const document = await documentService.getDocumentById(id);
      if (!document) {
        sendError(res, "NOT_FOUND", "Document not found", 404);
        return;
      }
      const { allowed } = await this.authorizeForApplication(
        req,
        document.applicationId,
        "read"
      );

      const downloadUrl = await documentService.getDownloadUrl(id, userId, allowed);

      // `downloadUrl` is the documented key; `url` is a compatibility alias for
      // clients that read the shorter name.
      sendSuccess(res, { downloadUrl, url: downloadUrl });
    } catch (error) {
      console.error("Error getting download URL:", error);
      if ((error as Error).message === "Document not found") {
        sendError(res, "NOT_FOUND", "Document not found", 404);
        return;
      }
      if ((error as Error).message === "Unauthorized") {
        sendError(res, "FORBIDDEN", ErrorMessages.FORBIDDEN, 403);
        return;
      }
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  /**
   * GET /applications/:applicationId/documents
   * Get all documents for an application
   */
  async getApplicationDocuments(
    req: AuthenticatedRequest,
    res: Response
  ): Promise<void> {
    try {
      const userId = req.userId!;
      const { applicationId } = req.params;
      const { requirementId } = req.query;

      // Verify access to the application. Owner passes directly; everyone else
      // goes through CASL so agency owners and admins can list a case's
      // documents, not only the assigned agent.
      const { application, allowed } = await this.authorizeForApplication(
        req,
        applicationId,
        "read"
      );

      if (!application) {
        sendError(res, "NOT_FOUND", "Application not found", 404);
        return;
      }

      if (application.userId !== userId && !allowed) {
        sendError(res, "FORBIDDEN", ErrorMessages.FORBIDDEN, 403);
        return;
      }

      let documents;
      if (requirementId && typeof requirementId === "string") {
        documents = await documentService.getRequirementDocuments(
          applicationId,
          requirementId
        );
      } else {
        documents = await documentService.getApplicationDocuments(applicationId);
      }

      sendSuccess(res, documents);
    } catch (error) {
      console.error("Error getting application documents:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  /**
   * DELETE /documents/:id
   * Delete a document
   */
  async deleteDocument(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const userId = req.userId!;
      const { id } = req.params;

      await documentService.deleteDocument(id, userId);
      sendNoContent(res);
    } catch (error) {
      console.error("Error deleting document:", error);
      if ((error as Error).message === "Document not found") {
        sendError(res, "NOT_FOUND", "Document not found", 404);
        return;
      }
      if ((error as Error).message === "Unauthorized") {
        sendError(res, "FORBIDDEN", ErrorMessages.FORBIDDEN, 403);
        return;
      }
      if ((error as Error).message === "Cannot delete document in current status") {
        sendError(res, "VALIDATION_ERROR", (error as Error).message, 400);
        return;
      }
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  /**
   * PUT /documents/:id/status
   * Update document status (for agents/admins)
   */
  async updateDocumentStatus(
    req: AuthenticatedRequest,
    res: Response
  ): Promise<void> {
    try {
      const userId = req.userId!;
      const { id } = req.params;
      const { status, rejectionReason, agentComments } = req.body;

      if (!status) {
        sendError(res, "VALIDATION_ERROR", "status is required", 400);
        return;
      }

      const validStatuses = [
        "under_review",
        "verified",
        "rejected",
        "resubmission_required",
      ];
      if (!validStatuses.includes(status)) {
        sendError(
          res,
          "VALIDATION_ERROR",
          `Invalid status. Allowed: ${validStatuses.join(", ")}`,
          400
        );
        return;
      }

      // Get the document to verify agent access
      const document = await documentService.getDocumentById(id);
      if (!document) {
        sendError(res, "NOT_FOUND", "Document not found", 404);
        return;
      }

      // Verify the caller may act on this application. CASL covers the assigned
      // agent plus the agency owner and admins — the owner in particular now
      // needs this, since they can upload documents to a case they don't
      // personally handle and must be able to review them.
      const { application, allowed } = await this.authorizeForApplication(
        req,
        document.applicationId,
        "update"
      );

      if (!application || !allowed) {
        sendError(
          res,
          "FORBIDDEN",
          "You do not have access to review this document",
          403
        );
        return;
      }

      const updated = await documentService.updateDocumentStatus(id, userId, {
        status,
        rejectionReason,
        agentComments,
      });

      // Notify the client of a terminal document decision (approved / needs work).
      if (status === "verified" || status === "rejected" || status === "resubmission_required") {
        const approved = status === "verified";
        await notificationService
          .notifyUser({
            userId: application.userId,
            type: approved ? "document_approved" : "document_rejected",
            title: approved ? "Document approved" : "Document needs attention",
            body: approved
              ? `Your document "${document.fileName}" was approved.`
              : `Your document "${document.fileName}" needs attention${rejectionReason ? `: ${rejectionReason}` : "."}`,
            relatedEntityType: "application",
            relatedEntityId: document.applicationId,
          })
          .catch((e) => console.error("[document] status notify failed:", e));
      }

      sendSuccess(res, updated, "Document status updated successfully");
    } catch (error) {
      console.error("Error updating document status:", error);
      if ((error as Error).message === "Document not found") {
        sendError(res, "NOT_FOUND", "Document not found", 404);
        return;
      }
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }
}

export const documentController = new DocumentController();
