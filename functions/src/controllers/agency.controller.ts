import { Response } from "express";
import { AuthenticatedRequest } from "../middleware/auth";
import { agencyService, SeatLimitError } from "../services/agency.service";
import { storageService } from "../services/storage.service";
import { notificationService } from "../services/notification.service";
import { emailService } from "../services/email/email.service";
import { resolveEventEmail } from "../services/email/event-templates";
import { collections } from "../utils/firebase";
import { ROLES } from "@durin-tech/authz";
import {
  sendSuccess,
  sendError,
  sendCreated,
  ErrorMessages,
} from "../utils/response";

// Image MIME types accepted for an agency's white-label logo. Kept narrow on
// purpose — these are the formats that render reliably in <Image>/<img> and
// avoid the XSS surface of arbitrary uploads.
const ALLOWED_LOGO_CONTENT_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/svg+xml",
];

export class AgencyController {
  /**
   * POST /agencies
   * Create a new agency. Caller must have an agent profile.
   */
  async createAgency(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const userId = req.userId!;
      const { name, address, state, description, logoUrl, consultationFee, services } = req.body;

      if (!name) {
        sendError(res, "VALIDATION_ERROR", "Agency name is required", 400);
        return;
      }

      // Get the user's display name for denormalization
      const userDoc = await collections.users.doc(userId).get();
      const ownerName = userDoc.exists
        ? `${userDoc.data()?.firstName || ""} ${userDoc.data()?.lastName || ""}`.trim()
        : "Unknown";

      const agency = await agencyService.createAgency(userId, ownerName, {
        name,
        address,
        state,
        description,
        logoUrl,
        consultationFee,
        services,
      });

      sendCreated(res, agency, "Agency created successfully");
    } catch (error) {
      console.error("Error creating agency:", error);
      const message = (error as Error).message;
      if (
        message === "User already owns an agency" ||
        message === "User must have an agent profile to create an agency" ||
        message === "Agent is already part of an agency. Leave first."
      ) {
        sendError(res, "VALIDATION_ERROR", message, 400);
        return;
      }
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  /**
   * GET /agencies/me
   * Get the agency the current user belongs to (as owner or agent)
   */
  async getMyAgency(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const userId = req.userId!;

      const agency = await agencyService.getAgencyForAgent(userId);
      if (!agency) {
        sendError(res, "NOT_FOUND", "You are not part of any agency", 404);
        return;
      }

      sendSuccess(res, agency);
    } catch (error) {
      console.error("Error getting agency:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  /**
   * PUT /agencies/me
   * Update the agency the current user owns
   */
  async updateMyAgency(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const userId = req.userId!;

      // Verify the user is an agency owner
      const agency = await agencyService.getAgencyByOwnerId(userId);
      if (!agency) {
        sendError(res, "FORBIDDEN", "Only agency owners can update agency settings", 403);
        return;
      }

      const { name, address, state, description, logoUrl, consultationFee, services } = req.body;

      const updated = await agencyService.updateAgency(agency.id, {
        name,
        address,
        state,
        description,
        logoUrl,
        consultationFee,
        services,
      });

      sendSuccess(res, updated, "Agency updated successfully");
    } catch (error) {
      console.error("Error updating agency:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  /**
   * POST /agencies/me/logo/upload-url
   * Owner-only. Mint a short-lived signed URL the client uses to PUT the logo
   * file directly to Cloud Storage. The file is registered (and made public)
   * via POST /agencies/me/logo afterwards.
   */
  async getLogoUploadUrl(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const userId = req.userId!;
      const { fileName, contentType } = req.body;

      if (!fileName || !contentType) {
        sendError(res, "VALIDATION_ERROR", "fileName and contentType are required", 400);
        return;
      }

      // Reject anything that isn't an allowed image type before we mint a URL.
      if (!ALLOWED_LOGO_CONTENT_TYPES.includes(contentType)) {
        sendError(
          res,
          "VALIDATION_ERROR",
          `Invalid content type. Allowed: ${ALLOWED_LOGO_CONTENT_TYPES.join(", ")}`,
          400
        );
        return;
      }

      // Only the agency owner may change branding.
      const agency = await agencyService.getAgencyByOwnerId(userId);
      if (!agency) {
        sendError(res, "FORBIDDEN", "Only agency owners can update the agency logo", 403);
        return;
      }

      const result = await storageService.getSignedAgencyLogoUploadUrl(
        agency.id,
        fileName,
        contentType
      );

      sendSuccess(res, result);
    } catch (error) {
      console.error("Error getting agency logo upload URL:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  /**
   * POST /agencies/me/logo
   * Owner-only. Finalize a logo upload: verify the file exists, confirm it
   * belongs to this agency's storage prefix, make it publicly readable, and
   * persist the durable public URL onto the agency. Returns the updated agency.
   */
  async setLogo(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const userId = req.userId!;
      const { storagePath } = req.body;

      if (!storagePath) {
        sendError(res, "VALIDATION_ERROR", "storagePath is required", 400);
        return;
      }

      // Only the agency owner may change branding.
      const agency = await agencyService.getAgencyByOwnerId(userId);
      if (!agency) {
        sendError(res, "FORBIDDEN", "Only agency owners can update the agency logo", 403);
        return;
      }

      // Guard against a caller registering a path that isn't theirs — the path
      // must live under this agency's own logo prefix.
      if (!storagePath.startsWith(`agency-logos/${agency.id}/`)) {
        sendError(res, "VALIDATION_ERROR", "storagePath does not belong to this agency", 400);
        return;
      }

      // Confirm the client actually completed the upload.
      const exists = await storageService.fileExists(storagePath);
      if (!exists) {
        sendError(res, "VALIDATION_ERROR", "File not found at the specified path", 400);
        return;
      }

      // Make the object public and capture its stable URL for persistent rendering.
      const logoUrl = await storageService.makeFilePublic(storagePath);

      const updated = await agencyService.updateAgency(agency.id, { logoUrl });

      sendSuccess(res, updated, "Agency logo updated successfully");
    } catch (error) {
      console.error("Error setting agency logo:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  /**
   * GET /agencies/:id/members
   * List all agents in an agency
   */
  async getMembers(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;

      // Only admins or members of this agency may view its members (role claim).
      if (req.authz?.role !== ROLES.ADMIN && req.authz?.agencyId !== id) {
        sendError(res, "FORBIDDEN", ErrorMessages.FORBIDDEN, 403);
        return;
      }

      const members = await agencyService.getAgencyMembers(id);
      sendSuccess(res, members);
    } catch (error) {
      console.error("Error getting members:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  /**
   * POST /agencies/:id/members
   * Add an existing agent to the agency (owner only)
   */
  async addMember(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const userId = req.userId!;
      const { id } = req.params;
      const { agentId } = req.body;

      if (!agentId) {
        sendError(res, "VALIDATION_ERROR", "agentId is required", 400);
        return;
      }

      // Verify the user is the owner of this agency
      const agency = await agencyService.getAgencyById(id);
      if (!agency || agency.ownerId !== userId) {
        sendError(res, "FORBIDDEN", "Only agency owners can add members", 403);
        return;
      }

      await agencyService.addAgentToAgency(id, agentId);
      sendSuccess(res, { added: true }, "Agent added to agency");
    } catch (error) {
      console.error("Error adding member:", error);
      const message = (error as Error).message;
      if (message === "Agent is already part of an agency" || message === "Agent not found") {
        sendError(res, "VALIDATION_ERROR", message, 400);
        return;
      }
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  /**
   * DELETE /agencies/:id/members/:agentId
   * Remove an agent from the agency (owner only)
   */
  async removeMember(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const userId = req.userId!;
      const { id, agentId } = req.params;

      // Verify the user is the owner of this agency
      const agency = await agencyService.getAgencyById(id);
      if (!agency || agency.ownerId !== userId) {
        sendError(res, "FORBIDDEN", "Only agency owners can remove members", 403);
        return;
      }

      // Capture the agent's user id before removal so we can notify them.
      const removedUserId = (await collections.agents.doc(agentId).get()).data()
        ?.userId as string | undefined;
      await agencyService.removeAgentFromAgency(agentId);
      if (removedUserId) {
        await notificationService
          .notifyUser({
            userId: removedUserId,
            type: "agency_member_removed",
            title: "Removed from agency",
            body: `You've been removed from ${agency.name}.`,
            relatedEntityType: "agency",
            relatedEntityId: id,
          })
          .catch((e) => console.error("[agency] remove notify failed:", e));
      }
      sendSuccess(res, { removed: true }, "Agent removed from agency");
    } catch (error) {
      console.error("Error removing member:", error);
      const message = (error as Error).message;
      if (
        message === "Agent is not part of any agency" ||
        message === "Agency owner cannot be removed. Transfer ownership or delete the agency."
      ) {
        sendError(res, "VALIDATION_ERROR", message, 400);
        return;
      }
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  /**
   * POST /agencies/:id/invitations
   * Invite an agent by email (owner only)
   */
  async inviteAgent(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const userId = req.userId!;
      const { id } = req.params;
      const { email } = req.body;

      if (!email) {
        sendError(res, "VALIDATION_ERROR", "Email is required", 400);
        return;
      }

      // Verify the user is the owner of this agency
      const agency = await agencyService.getAgencyById(id);
      if (!agency || agency.ownerId !== userId) {
        sendError(res, "FORBIDDEN", "Only agency owners can invite agents", 403);
        return;
      }

      // Get inviter's name for denormalization
      const userDoc = await collections.users.doc(userId).get();
      const inviterName = userDoc.exists
        ? `${userDoc.data()?.firstName || ""} ${userDoc.data()?.lastName || ""}`.trim()
        : "Unknown";

      const invitation = await agencyService.inviteAgent(
        id,
        agency.name,
        userId,
        inviterName,
        email
      );

      // Email the invited address directly — the invitee may not have an account
      // yet, so this bypasses notifyUser (which is keyed by an existing userId).
      const ev = resolveEventEmail("agent_invited", {
        title: "Agency invitation",
        body: "",
        relatedEntityType: "agency",
        relatedEntityId: id,
      });
      await emailService
        .sendNotification({
          to: email,
          subject: ev.subject,
          title: `${inviterName} invited you to join ${agency.name}`,
          body: `${inviterName} has invited you to join ${agency.name} on Seli as an agent.\n\nSign in (or create your account with this email) to accept the invitation.`,
          actionUrl: ev.actionUrl,
          actionLabel: ev.actionLabel,
        })
        .catch((e) => console.error("[invite] email failed:", e));

      sendCreated(res, invitation, "Invitation sent successfully");
    } catch (error) {
      console.error("Error inviting agent:", error);
      if (error instanceof SeatLimitError) {
        sendError(res, "UPGRADE_REQUIRED", error.message, 402);
        return;
      }
      const message = (error as Error).message;
      if (message === "An invitation has already been sent to this email") {
        sendError(res, "DUPLICATE", message, 409);
        return;
      }
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  /**
   * GET /agencies/:id/invitations
   * List invitations for an agency (owner only)
   */
  async getInvitations(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const userId = req.userId!;
      const { id } = req.params;

      // Verify the user is the owner of this agency
      const agency = await agencyService.getAgencyById(id);
      if (!agency || agency.ownerId !== userId) {
        sendError(res, "FORBIDDEN", "Only agency owners can view invitations", 403);
        return;
      }

      const invitations = await agencyService.getAgencyInvitations(id);
      sendSuccess(res, invitations);
    } catch (error) {
      console.error("Error getting invitations:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  /**
   * GET /invitations/pending
   * Get pending invitations for the authenticated user (by email)
   */
  async getMyPendingInvitations(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const email = req.user?.email;
      if (!email) {
        sendError(res, "VALIDATION_ERROR", "User email not available", 400);
        return;
      }

      const invitations = await agencyService.getPendingInvitationsForEmail(email);
      sendSuccess(res, invitations);
    } catch (error) {
      console.error("Error getting pending invitations:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  /**
   * POST /invitations/:id/accept
   * Accept an agency invitation
   */
  async acceptInvitation(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const userId = req.userId!;
      const { id } = req.params;

      await agencyService.acceptInvitation(id, userId);

      // Notify the inviting owner that the agent accepted.
      const invite = (await collections.agencyInvitations.doc(id).get()).data();
      if (invite?.invitedBy) {
        await notificationService
          .notifyUser({
            userId: invite.invitedBy,
            type: "invitation_accepted",
            title: "Invitation accepted",
            body: `${invite.invitedEmail} accepted your invitation to join ${invite.agencyName}.`,
            relatedEntityType: "agency",
            relatedEntityId: invite.agencyId,
          })
          .catch((e) => console.error("[invitation] accept notify failed:", e));
      }

      sendSuccess(res, { accepted: true }, "Invitation accepted");
    } catch (error) {
      console.error("Error accepting invitation:", error);
      if (error instanceof SeatLimitError) {
        sendError(res, "UPGRADE_REQUIRED", error.message, 402);
        return;
      }
      const message = (error as Error).message;
      if (
        message === "Invitation not found" ||
        message === "Invitation is no longer pending" ||
        message === "Invitation has expired" ||
        message === "Agent profile not found" ||
        message === "Agent is already part of an agency. Leave first."
      ) {
        sendError(res, "VALIDATION_ERROR", message, 400);
        return;
      }
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  /**
   * POST /invitations/:id/decline
   * Decline an agency invitation
   */
  async declineInvitation(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;

      // Capture the invitation before declining so we can notify the owner.
      const invite = (await collections.agencyInvitations.doc(id).get()).data();
      await agencyService.declineInvitation(id);
      if (invite?.invitedBy) {
        await notificationService
          .notifyUser({
            userId: invite.invitedBy,
            type: "invitation_declined",
            title: "Invitation declined",
            body: `${invite.invitedEmail} declined your invitation to join ${invite.agencyName}.`,
            relatedEntityType: "agency",
            relatedEntityId: invite.agencyId,
          })
          .catch((e) => console.error("[invitation] decline notify failed:", e));
      }

      sendSuccess(res, { declined: true }, "Invitation declined");
    } catch (error) {
      console.error("Error declining invitation:", error);
      const message = (error as Error).message;
      if (message === "Invitation not found" || message === "Invitation is no longer pending") {
        sendError(res, "VALIDATION_ERROR", message, 400);
        return;
      }
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  /**
   * GET /agencies/:id/review (admin only)
   * Get agency + owner details for admin review
   */
  async getAgencyReview(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const data = await agencyService.getAgencyReviewData(id);
      if (!data) {
        sendError(res, "NOT_FOUND", "Agency not found", 404);
        return;
      }
      sendSuccess(res, data);
    } catch (error) {
      console.error("Error getting agency review data:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  /**
   * GET /agencies/pending (admin only)
   * List agencies with status "pending_review"
   */
  async getPendingAgencies(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const agencies = await agencyService.getAgenciesByStatus("pending_review");
      sendSuccess(res, agencies);
    } catch (error) {
      console.error("Error getting pending agencies:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  /**
   * PUT /agencies/:id/approval (admin only)
   * Approve or reject an agency
   * Body: { action: "approve" | "reject", reason?: string }
   */
  async updateAgencyApproval(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const adminUserId = req.userId!;
      const { id } = req.params;
      const { action, reason } = req.body;

      if (!action || !["approve", "reject"].includes(action)) {
        sendError(res, "VALIDATION_ERROR", "Action must be 'approve' or 'reject'", 400);
        return;
      }

      const agency = await agencyService.updateAgencyApproval(id, action, adminUserId, reason);

      // Notify the agency owner of the admin decision.
      if (agency?.ownerId) {
        const approved = action === "approve";
        await notificationService
          .notifyUser({
            userId: agency.ownerId,
            type: approved ? "agency_approved" : "agency_rejected",
            title: approved ? "Your agency was approved" : "Update on your agency application",
            body: approved
              ? `Your agency "${agency.name}" has been approved. You can now operate on Seli.`
              : `Your agency "${agency.name}" application was not approved${reason ? `: ${reason}` : "."}`,
            relatedEntityType: "agency",
            relatedEntityId: id,
          })
          .catch((e) => console.error("[agency] approval notify failed:", e));
      }

      sendSuccess(res, agency, `Agency ${action === "approve" ? "approved" : "rejected"} successfully`);
    } catch (error) {
      console.error("Error updating agency approval:", error);
      const message = (error as Error).message;
      if (message === "Agency not found") {
        sendError(res, "NOT_FOUND", message, 404);
        return;
      }
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  /**
   * GET /agencies (admin only)
   * List all agencies
   */
  async getAllAgencies(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const agencies = await agencyService.getAllAgencies();
      sendSuccess(res, agencies);
    } catch (error) {
      console.error("Error getting all agencies:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

}

export const agencyController = new AgencyController();
