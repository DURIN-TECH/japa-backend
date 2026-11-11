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
import { StorageScope, validateStoragePath } from "../utils/storage-paths";

/**
 * The storage scope of an agent's own verification documents:
 * `verification/{userUid}/…`, the folder POST …/verification/upload-url issues
 * into for that user. Every path this controller registers, signs or deletes
 * is validated against it (issue #141), so an agent can only ever reach their
 * own verification uploads.
 */
function verificationScope(userId: string): StorageScope {
  return { purpose: "agent-verification", userId };
}

/** Content types accepted for a verification document upload. */
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
   * Register an uploaded verification document.
   *
   * `storagePath` must be the path the upload-url endpoint returned to THIS
   * user: an issued object directly under `verification/{their uid}/`.
   * Anything else (another user's folder, another kind of upload, a
   * backend-only prefix, a URL, a path with `..`) is refused with 400 before
   * the bucket is consulted, and nothing is stored.
   */
  async registerDocument(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const userId = req.userId!;
      const { storagePath } = req.body;

      if (!storagePath) {
        sendError(res, "VALIDATION_ERROR", "storagePath is required");
        return;
      }

      // Validate the client-supplied path against the caller's own prefix
      // BEFORE any bucket lookup, so the endpoint cannot even be used to probe
      // whether some other object exists.
      const checked = validateStoragePath(storagePath, verificationScope(userId));
      if (!checked.ok) {
        console.warn(`[verification] registration refused for ${userId}: storagePath ${checked.issue}`);
        sendError(
          res,
          "VALIDATION_ERROR",
          "storagePath must be the path returned by the verification upload-url endpoint"
        );
        return;
      }

      // Verify file exists in storage
      const exists = await storageService.fileExists(checked.key);
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

      await agentService.addVerificationDocument(agent.id, checked.key);

      sendSuccess(res, { storagePath: checked.key }, "Document registered successfully");
    } catch (error) {
      console.error("Error registering verification document:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  /**
   * GET /agents/me/verification/documents
   * List verification documents with download URLs.
   *
   * Each STORED path is validated again here, against the agent's own prefix,
   * before it is signed: an entry that does not pass (one registered before
   * registration validated paths) is listed with `downloadUrl: null` and is
   * never signed. The agent can still see and remove such an entry.
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
          // Read-time validation: sign only the agent's own issued uploads.
          const checked = validateStoragePath(storagePath, verificationScope(agent.userId));
          if (!checked.ok) {
            console.warn(
              `[verification] agent ${agent.id}: stored path failed validation (${checked.issue}); not signed`
            );
            return { storagePath, downloadUrl: null };
          }
          try {
            const downloadUrl = await storageService.getSignedDownloadUrl(checked.key);
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
   * Remove a verification document.
   *
   * The object is deleted from storage ONLY when the path is one of the
   * caller's own issued verification uploads. A path that fails validation
   * can still be removed from the caller's own list when it is on that list
   * (so a bad legacy entry can be cleared) — the object it names is left
   * alone. A path that is neither is refused with 400.
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

      const checked = validateStoragePath(storagePath, verificationScope(userId));
      if (checked.ok) {
        // The caller's own upload: delete the object, then drop the entry.
        await storageService.deleteFile(checked.key);
        await agentService.removeVerificationDocument(agent.id, checked.key);
      } else if (typeof storagePath === "string" && (agent.verificationDocuments || []).includes(storagePath)) {
        // Not a valid path for this agent, but it IS an entry on their own
        // record: drop the entry only. The object is not theirs to delete.
        console.warn(
          `[verification] agent ${agent.id}: removing invalid stored path (${checked.issue}) from the record only`
        );
        await agentService.removeVerificationDocument(agent.id, storagePath);
      } else {
        // Neither the caller's upload nor an entry on their record.
        sendError(
          res,
          "VALIDATION_ERROR",
          "storagePath is not one of your verification documents"
        );
        return;
      }

      sendSuccess(res, null, "Document removed successfully");
    } catch (error) {
      console.error("Error removing verification document:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }
}

export const verificationController = new VerificationController();
