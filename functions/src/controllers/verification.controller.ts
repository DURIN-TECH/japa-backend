import { Response } from "express";
import { AuthenticatedRequest } from "../middleware/auth";
import { agentService } from "../services/agent.service";
import { storageService } from "../services/storage.service";
import {
  sendSuccess,
  sendError,
  sendNotFound,
  ErrorMessages,
} from "../utils/response";

const ALLOWED_CONTENT_TYPES = [
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/heic",
];

class VerificationController {
  /**
   * POST /agents/me/verification/upload-url
   * Get a signed upload URL for a verification document
   */
  async getUploadUrl(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const userId = req.userId!;
      const { fileName, contentType } = req.body;

      if (!fileName || !contentType) {
        sendError(res, "VALIDATION_ERROR", "fileName and contentType are required");
        return;
      }

      if (!ALLOWED_CONTENT_TYPES.includes(contentType)) {
        sendError(
          res,
          "VALIDATION_ERROR",
          `Invalid content type. Allowed: ${ALLOWED_CONTENT_TYPES.join(", ")}`
        );
        return;
      }

      const result = await storageService.getSignedVerificationUploadUrl(
        userId,
        fileName,
        contentType
      );

      sendSuccess(res, result);
    } catch (error) {
      console.error("Error getting verification upload URL:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  /**
   * POST /agents/me/verification/documents
   * Register an uploaded verification document
   */
  async registerDocument(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const userId = req.userId!;
      const { storagePath } = req.body;

      if (!storagePath) {
        sendError(res, "VALIDATION_ERROR", "storagePath is required");
        return;
      }

      // Verify file exists in storage
      const exists = await storageService.fileExists(storagePath);
      if (!exists) {
        sendError(res, "VALIDATION_ERROR", "File not found at the specified path");
        return;
      }

      // Get agent profile
      const agent = await agentService.getAgentByUserId(userId);
      if (!agent) {
        sendNotFound(res, "Agent profile not found");
        return;
      }

      await agentService.addVerificationDocument(agent.id, storagePath);

      sendSuccess(res, { storagePath }, "Document registered successfully");
    } catch (error) {
      console.error("Error registering verification document:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  /**
   * GET /agents/me/verification/documents
   * List verification documents with download URLs
   */
  async listDocuments(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const userId = req.userId!;

      const agent = await agentService.getAgentByUserId(userId);
      if (!agent) {
        sendNotFound(res, "Agent profile not found");
        return;
      }

      const documents = agent.verificationDocuments || [];
      const result = await Promise.all(
        documents.map(async (storagePath) => {
          try {
            const downloadUrl = await storageService.getSignedDownloadUrl(storagePath);
            return { storagePath, downloadUrl };
          } catch {
            return { storagePath, downloadUrl: null };
          }
        })
      );

      sendSuccess(res, result);
    } catch (error) {
      console.error("Error listing verification documents:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  /**
   * DELETE /agents/me/verification/documents
   * Remove a verification document
   */
  async removeDocument(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const userId = req.userId!;
      const storagePath = req.query.storagePath as string;

      if (!storagePath) {
        sendError(res, "VALIDATION_ERROR", "storagePath query parameter is required");
        return;
      }

      const agent = await agentService.getAgentByUserId(userId);
      if (!agent) {
        sendNotFound(res, "Agent profile not found");
        return;
      }

      // Delete from storage
      await storageService.deleteFile(storagePath);

      // Remove from agent profile
      await agentService.removeVerificationDocument(agent.id, storagePath);

      sendSuccess(res, null, "Document removed successfully");
    } catch (error) {
      console.error("Error removing verification document:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }
}

export const verificationController = new VerificationController();
