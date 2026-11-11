import { Response } from "express";
import { AuthenticatedRequest } from "../middleware/auth";
import { agencyService } from "../services/agency.service";
import {
  complianceService,
  ComplianceDocumentSlot,
  ComplianceLockedError,
  ComplianceIncompleteError,
} from "../services/compliance.service";
import { storageService } from "../services/storage.service";
import { notificationService } from "../services/notification.service";
import { claimsService } from "../services/claims.service";
import { sendSuccess, sendError, ErrorMessages } from "../utils/response";
import { validateStoragePath } from "../utils/storage-paths";

// Content types accepted for compliance documents. Kept aligned with the agent
// verification flow (PDF + common image formats).
const ALLOWED_CONTENT_TYPES = [
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/heic",
];

// The document slots an owner may upload to. Validated on the way in so a
// client can't invent an arbitrary storage prefix.
const VALID_SLOTS: ComplianceDocumentSlot[] = [
  "idDocument",
  "proofOfAddress",
  "cacDocument",
];

/**
 * Controller for the agency compliance (KYC/KYB/payout) flow.
 *
 * Owner-facing endpoints resolve the caller's agency from their ownerId (only
 * the owner may edit compliance). Admin endpoints operate on an agency by id.
 */
export class ComplianceController {
  /**
   * Resolve the agency the caller OWNS, or send a 403 and return null. Editing
   * compliance is strictly an owner action.
   */
  private async requireOwnedAgency(req: AuthenticatedRequest, res: Response) {
    const userId = req.userId!;
    const agency = await agencyService.getAgencyByOwnerId(userId);
    if (!agency) {
      sendError(res, "FORBIDDEN", "Only agency owners can manage compliance", 403);
      return null;
    }
    return agency;
  }

  /** Translate service-layer domain errors into HTTP responses. */
  private handleDomainError(res: Response, error: unknown): boolean {
    if (error instanceof ComplianceLockedError) {
      // 409 Conflict — the file is in a state that forbids the change.
      sendError(res, "CONFLICT", error.message, 409);
      return true;
    }
    if (error instanceof ComplianceIncompleteError) {
      sendError(res, "VALIDATION_ERROR", error.message, 400);
      return true;
    }
    return false;
  }

  /**
   * GET /agencies/me/compliance
   * Owner-only. Returns the compliance file plus the computed requirement
   * checklist (so the portal renders the exact same list the backend enforces).
   */
  async getMyCompliance(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const agency = await this.requireOwnedAgency(req, res);
      if (!agency) return;

      const compliance = await complianceService.getCompliance(agency.id);
      const requirements = complianceService.getRequirements(compliance);
      sendSuccess(res, { compliance, requirements });
    } catch (error) {
      console.error("Error getting compliance:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  /**
   * PUT /agencies/me/compliance
   * Owner-only. Merge scalar KYC/KYB/payout fields into the compliance file.
   */
  async updateMyCompliance(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const agency = await this.requireOwnedAgency(req, res);
      if (!agency) return;

      // Only known fields are copied through by the service; unknown keys are
      // ignored. We pass the raw body and let the service pick what it needs.
      const compliance = await complianceService.updateFields(agency.id, req.body ?? {});
      const requirements = complianceService.getRequirements(compliance);
      sendSuccess(res, { compliance, requirements }, "Compliance information saved");
    } catch (error) {
      if (this.handleDomainError(res, error)) return;
      console.error("Error updating compliance:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  /**
   * POST /agencies/me/compliance/upload-url
   * Owner-only. Mint a signed URL for a specific document slot.
   * Body: { slot, fileName, contentType }
   */
  async getUploadUrl(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const agency = await this.requireOwnedAgency(req, res);
      if (!agency) return;

      const { slot, fileName, contentType } = req.body;
      if (!slot || !fileName || !contentType) {
        sendError(res, "VALIDATION_ERROR", "slot, fileName and contentType are required", 400);
        return;
      }
      if (!VALID_SLOTS.includes(slot)) {
        sendError(res, "VALIDATION_ERROR", `Invalid slot. Allowed: ${VALID_SLOTS.join(", ")}`, 400);
        return;
      }
      if (!ALLOWED_CONTENT_TYPES.includes(contentType)) {
        sendError(
          res,
          "VALIDATION_ERROR",
          `Invalid content type. Allowed: ${ALLOWED_CONTENT_TYPES.join(", ")}`,
          400
        );
        return;
      }

      const result = await storageService.getSignedComplianceUploadUrl(
        agency.id,
        slot,
        fileName,
        contentType
      );
      sendSuccess(res, result);
    } catch (error) {
      console.error("Error getting compliance upload URL:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  /**
   * POST /agencies/me/compliance/documents
   * Owner-only. Register an uploaded document against its slot.
   * Body: { slot, storagePath }
   */
  async registerDocument(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const agency = await this.requireOwnedAgency(req, res);
      if (!agency) return;

      const { slot, storagePath } = req.body;
      if (!slot || !storagePath) {
        sendError(res, "VALIDATION_ERROR", "slot and storagePath are required", 400);
        return;
      }
      if (!VALID_SLOTS.includes(slot)) {
        sendError(res, "VALIDATION_ERROR", `Invalid slot. Allowed: ${VALID_SLOTS.join(", ")}`, 400);
        return;
      }
      // The path must be an issued object in this agency's own folder for THIS
      // slot (`compliance/{agency.id}/{slot}/`) — shared validator, issue #141.
      const checked = validateStoragePath(storagePath, {
        purpose: "compliance-document",
        agencyId: agency.id,
        slots: [slot],
      });
      if (!checked.ok) {
        sendError(res, "VALIDATION_ERROR", "storagePath does not belong to this agency", 400);
        return;
      }
      // Confirm the client actually completed the upload.
      const exists = await storageService.fileExists(checked.key);
      if (!exists) {
        sendError(res, "VALIDATION_ERROR", "File not found at the specified path", 400);
        return;
      }

      const compliance = await complianceService.registerDocument(agency.id, slot, checked.key);
      const requirements = complianceService.getRequirements(compliance);
      sendSuccess(res, { compliance, requirements }, "Document uploaded");
    } catch (error) {
      if (this.handleDomainError(res, error)) return;
      console.error("Error registering compliance document:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  /**
   * POST /agencies/me/compliance/submit
   * Owner-only. Submit the completed file for admin review and notify admins.
   */
  async submitForReview(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const agency = await this.requireOwnedAgency(req, res);
      if (!agency) return;

      const compliance = await complianceService.submitForReview(agency.id);

      // Notify all admins that a new compliance file awaits review. Best-effort.
      await this.notifyAdmins(
        "compliance_submitted",
        "Agency compliance submitted",
        `${agency.name} submitted KYC/KYB information for review.`,
        agency.id
      ).catch((e) => console.error("[compliance] admin notify failed:", e));

      const requirements = complianceService.getRequirements(compliance);
      sendSuccess(res, { compliance, requirements }, "Compliance submitted for review");
    } catch (error) {
      if (this.handleDomainError(res, error)) return;
      console.error("Error submitting compliance:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  /**
   * GET /agencies/:id/compliance (admin only)
   * Full compliance file for review, with signed download URLs for each doc.
   */
  async getComplianceForReview(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const compliance = await complianceService.getCompliance(id);
      const requirements = complianceService.getRequirements(compliance);

      // Mint short-lived download URLs for each uploaded document so an admin
      // can inspect them without the raw storage paths.
      const documents = await this.resolveDocumentUrls(id, compliance);

      sendSuccess(res, { compliance, requirements, documents });
    } catch (error) {
      if ((error as Error).message === "Agency not found") {
        sendError(res, "NOT_FOUND", "Agency not found", 404);
        return;
      }
      console.error("Error getting compliance for review:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  /**
   * PUT /agencies/:id/compliance/decision (admin only)
   * Approve or reject compliance. Body: { action: "approve" | "reject", reason? }
   */
  async decide(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const adminUserId = req.userId!;
      const { id } = req.params;
      const { action, reason } = req.body;

      if (!action || !["approve", "reject"].includes(action)) {
        sendError(res, "VALIDATION_ERROR", "Action must be 'approve' or 'reject'", 400);
        return;
      }

      const compliance = await complianceService.review(id, adminUserId, action, reason);

      // Notify the agency owner of the decision. Best-effort.
      const agency = await agencyService.getAgencyById(id);
      if (agency?.ownerId) {
        const approved = action === "approve";
        await notificationService
          .notifyUser({
            userId: agency.ownerId,
            type: approved ? "compliance_approved" : "compliance_rejected",
            title: approved
              ? "Your agency is verified"
              : "Action needed on your compliance",
            body: approved
              ? `${agency.name} is verified. You can now make and receive payments and take on Seli clients.`
              : `Your compliance information for ${agency.name} needs attention${reason ? `: ${reason}` : "."}`,
            relatedEntityType: "agency",
            relatedEntityId: id,
          })
          .catch((e) => console.error("[compliance] owner notify failed:", e));
      }

      sendSuccess(res, compliance, `Compliance ${action === "approve" ? "verified" : "rejected"}`);
    } catch (error) {
      if ((error as Error).message === "Agency not found") {
        sendError(res, "NOT_FOUND", "Agency not found", 404);
        return;
      }
      console.error("Error deciding compliance:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  // ---- helpers ----

  /**
   * Resolve signed download URLs for whichever document slots are populated.
   *
   * Each stored path is validated again before it is signed (issue #141): it
   * must be an issued object in THIS agency's compliance folder, in one of the
   * known slots. (Any known slot, not only the field's own: registration did
   * not always tie a path to its slot, and such a record is still the
   * agency's own file.) A path that fails gets `null`, like an empty slot,
   * and is never signed.
   *
   * @param agencyId The agency whose compliance file this is (from the route).
   */
  private async resolveDocumentUrls(
    agencyId: string,
    compliance: { idDocumentPath?: string; proofOfAddressPath?: string; cacDocumentPath?: string }
  ): Promise<Record<string, string | null>> {
    const slots: Array<[string, string | undefined]> = [
      ["idDocument", compliance.idDocumentPath],
      ["proofOfAddress", compliance.proofOfAddressPath],
      ["cacDocument", compliance.cacDocumentPath],
    ];
    const entries = await Promise.all(
      slots.map(async ([key, path]) => {
        if (!path) return [key, null] as const;
        const checked = validateStoragePath(path, {
          purpose: "compliance-document",
          agencyId,
          slots: VALID_SLOTS,
        });
        if (!checked.ok) {
          console.warn(
            `[compliance] agency ${agencyId}: stored ${key} path failed validation (${checked.issue}); not signed`
          );
          return [key, null] as const;
        }
        try {
          return [key, await storageService.getSignedDownloadUrl(checked.key)] as const;
        } catch {
          return [key, null] as const;
        }
      })
    );
    return Object.fromEntries(entries);
  }

  /** Fan out an in-app notification to every admin user. */
  private async notifyAdmins(
    type: "compliance_submitted",
    title: string,
    body: string,
    agencyId: string
  ): Promise<void> {
    // Admins are the accounts holding the admin custom claim (issue #135).
    // The `users/{uid}.admin` document field is deliberately NOT used: it is
    // not an authority, and a stray flag must not receive admin notifications.
    const adminUids = await claimsService.listAdminUids();
    await Promise.all(
      adminUids.map((adminUid) =>
        notificationService.notifyUser({
          userId: adminUid,
          type,
          title,
          body,
          relatedEntityType: "agency",
          relatedEntityId: agencyId,
        })
      )
    );
  }
}

export const complianceController = new ComplianceController();
