import { Response } from "express";
import { AuthenticatedRequest } from "../middleware/auth";
import { documentService } from "../services/document.service";
import { notificationService } from "../services/notification.service";
import { subcollections } from "../utils/firebase";
import { checkWithinLimit, paymentRequired } from "../middleware/authz";
import { LIMITS } from "@durin-tech/authz";
import {
  sendSuccess,
  sendError,
  sendCreated,
  sendNoContent,
  ErrorMessages,
} from "../utils/response";

export class DocumentController {
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

      const result = await documentService.getUploadUrl(
        userId,
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
      } = req.body;

      if (
        !applicationId ||
        !requirementId ||
        !fileName ||
        !fileType ||
        fileSizeMb === undefined ||
        !storagePath
      ) {
        sendError(
          res,
          "VALIDATION_ERROR",
          "applicationId, requirementId, fileName, fileType, fileSizeMb, and storagePath are required",
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

      const document = await documentService.createDocument(userId, {
        applicationId,
        requirementId,
        fileName,
        fileType,
        fileSizeMb,
        storagePath,
      });

      // Notify the assigned agent that a document was uploaded for review.
      const uploadApp = await import("../services/application.service").then((m) =>
        m.applicationService.getApplicationById(applicationId)
      );
      if (uploadApp?.agentId && uploadApp.agentId !== userId) {
        await notificationService
          .notifyUser({
            userId: uploadApp.agentId,
            type: "document_uploaded",
            title: "New document uploaded",
            body: `${uploadApp.clientName || "A client"} uploaded "${fileName}" for review.`,
            relatedEntityType: "application",
            relatedEntityId: applicationId,
          })
          .catch((e) => console.error("[document] upload notify failed:", e));
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

      // Check ownership or agent access
      if (document.userId !== userId) {
        sendError(res, "FORBIDDEN", ErrorMessages.FORBIDDEN, 403);
        return;
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

      const downloadUrl = await documentService.getDownloadUrl(id, userId);

      sendSuccess(res, { downloadUrl });
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

      // Verify application ownership
      const application = await import("../services/application.service").then(
        (m) => m.applicationService.getApplicationById(applicationId)
      );

      if (!application) {
        sendError(res, "NOT_FOUND", "Application not found", 404);
        return;
      }

      if (application.userId !== userId && application.agentId !== userId) {
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

      // Verify the user is the agent for this application
      const application = await import("../services/application.service").then(
        (m) => m.applicationService.getApplicationById(document.applicationId)
      );

      if (!application || application.agentId !== userId) {
        sendError(res, "FORBIDDEN", "Only the assigned agent can update document status", 403);
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
