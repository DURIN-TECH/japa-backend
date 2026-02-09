import { Response } from "express";
import { AuthenticatedRequest } from "../middleware/auth";
import { agencyService } from "../services/agency.service";
import { collections } from "../utils/firebase";
import { Agent } from "../types";
import {
  sendSuccess,
  sendError,
  sendCreated,
  ErrorMessages,
} from "../utils/response";

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
   * GET /agencies/:id/members
   * List all agents in an agency
   */
  async getMembers(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const userId = req.userId!;
      const { id } = req.params;

      // Verify the user belongs to this agency
      const userAgent = await this.getAgentForUser(userId);
      if (!userAgent || (userAgent.agencyId !== id && !req.user?.admin)) {
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

      await agencyService.removeAgentFromAgency(agentId);
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

      sendCreated(res, invitation, "Invitation sent successfully");
    } catch (error) {
      console.error("Error inviting agent:", error);
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
   * POST /invitations/:id/accept
   * Accept an agency invitation
   */
  async acceptInvitation(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const userId = req.userId!;
      const { id } = req.params;

      await agencyService.acceptInvitation(id, userId);
      sendSuccess(res, { accepted: true }, "Invitation accepted");
    } catch (error) {
      console.error("Error accepting invitation:", error);
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

      await agencyService.declineInvitation(id);
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

  // Helper: get agent document for a userId
  private async getAgentForUser(userId: string): Promise<Agent | null> {
    const snapshot = await collections.agents
      .where("userId", "==", userId)
      .limit(1)
      .get();

    if (snapshot.empty) return null;
    return snapshot.docs[0].data() as Agent;
  }
}

export const agencyController = new AgencyController();
