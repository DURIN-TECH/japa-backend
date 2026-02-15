import { Response } from "express";
import { AuthenticatedRequest } from "../middleware/auth";
import { applicationService } from "../services/application.service";
import { collections } from "../utils/firebase";
import {
  sendSuccess,
  sendError,
  sendCreated,
  sendNoContent,
  ErrorMessages,
} from "../utils/response";
import { Application, ApplicationStatus, Agent } from "../types";

export class ApplicationController {
  /**
   * POST /applications
   * Create a new application
   */
  async createApplication(
    req: AuthenticatedRequest,
    res: Response
  ): Promise<void> {
    try {
      const userId = req.userId!;
      const { visaTypeId, countryCode, mode, agentId, userNotes } = req.body;

      // Validate required fields
      if (!visaTypeId || !countryCode || !mode) {
        sendError(
          res,
          "VALIDATION_ERROR",
          "visaTypeId, countryCode, and mode are required",
          400
        );
        return;
      }

      // Validate mode
      if (mode !== "self" && mode !== "agent") {
        sendError(
          res,
          "VALIDATION_ERROR",
          "mode must be 'self' or 'agent'",
          400
        );
        return;
      }

      // If agent mode, agentId is required
      if (mode === "agent" && !agentId) {
        sendError(
          res,
          "VALIDATION_ERROR",
          "agentId is required when mode is 'agent'",
          400
        );
        return;
      }

      const application = await applicationService.createApplication(userId, {
        visaTypeId,
        countryCode,
        mode,
        agentId,
        userNotes,
      });

      sendCreated(res, application, "Application created successfully");
    } catch (error) {
      console.error("Error creating application:", error);
      if ((error as Error).message === "Visa type not found") {
        sendError(res, "NOT_FOUND", "Visa type not found", 404);
        return;
      }
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  /**
   * GET /applications
   * Get applications based on role:
   *   ?role=agent  → cases assigned to this agent
   *   ?role=owner  → all cases in the agent's agency
   *   ?role=admin  → all cases (admin only)
   *   (default)    → cases owned by this user (applicant view)
   */
  async getApplications(
    req: AuthenticatedRequest,
    res: Response
  ): Promise<void> {
    try {
      const userId = req.userId!;
      const { status, role, mode } = req.query;

      let applications: Application[];

      if (role === "admin") {
        // Admin: see everything
        if (!req.user?.admin) {
          sendError(res, "FORBIDDEN", "Admin access required", 403);
          return;
        }
        applications = await applicationService.getAllApplications();
      } else if (role === "owner") {
        // Agency owner: see all agency cases
        const agent = await this.getAgentForUser(userId);
        if (!agent?.agencyId || agent.agencyRole !== "owner") {
          sendError(res, "FORBIDDEN", "Agency owner access required", 403);
          return;
        }
        applications = await applicationService.getAgencyApplications(agent.agencyId);
      } else if (role === "agent") {
        // Agent: see cases assigned to them
        applications = await applicationService.getAgentApplications(userId);
      } else {
        // Default: applicant's own applications
        if (status && typeof status === "string") {
          applications = await applicationService.getApplicationsByStatus(
            userId,
            status as ApplicationStatus
          );
        } else {
          applications = await applicationService.getUserApplications(userId);
        }
      }

      // Filter by mode if specified (e.g., ?mode=self for self-service clients)
      if (mode && typeof mode === "string") {
        applications = applications.filter((app) => app.mode === mode);
      }

      sendSuccess(res, applications);
    } catch (error) {
      console.error("Error getting applications:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  /**
   * GET /applications/:id
   * Get a specific application.
   * Access: owner, assigned agent, same-agency member, or admin.
   */
  async getApplication(
    req: AuthenticatedRequest,
    res: Response
  ): Promise<void> {
    try {
      const userId = req.userId!;
      const { id } = req.params;

      const application = await applicationService.getApplicationById(id);

      if (!application) {
        sendError(res, "NOT_FOUND", "Application not found", 404);
        return;
      }

      const hasAccess = await this.checkApplicationAccess(userId, application, req.user?.admin);
      if (!hasAccess) {
        sendError(res, "FORBIDDEN", ErrorMessages.FORBIDDEN, 403);
        return;
      }

      sendSuccess(res, application);
    } catch (error) {
      console.error("Error getting application:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  /**
   * PUT /applications/:id
   * Update an application.
   * Owner can update userNotes. Agent/owner can update agentNotes.
   */
  async updateApplication(
    req: AuthenticatedRequest,
    res: Response
  ): Promise<void> {
    try {
      const userId = req.userId!;
      const { id } = req.params;
      const { userNotes, agentNotes, agentId, agencyId, mode } = req.body;

      const application = await applicationService.getApplicationById(id);

      if (!application) {
        sendError(res, "NOT_FOUND", "Application not found", 404);
        return;
      }

      const hasAccess = await this.checkApplicationAccess(userId, application, req.user?.admin);
      if (!hasAccess) {
        sendError(res, "FORBIDDEN", ErrorMessages.FORBIDDEN, 403);
        return;
      }

      const isOwner = application.userId === userId;
      const updates: { userNotes?: string; agentNotes?: string; agentId?: string; agencyId?: string; mode?: "self" | "agent" } = {};

      // Only the applicant can update userNotes
      if (userNotes !== undefined && isOwner) {
        updates.userNotes = userNotes;
      }
      // Agents/agency members can update agentNotes
      if (agentNotes !== undefined && !isOwner) {
        updates.agentNotes = agentNotes;
      }
      // Agent/owner/admin can reassign agent or transfer self-service
      if (!isOwner || req.user?.admin) {
        if (agentId !== undefined) updates.agentId = agentId;
        if (agencyId !== undefined) updates.agencyId = agencyId;
        if (mode !== undefined) updates.mode = mode;
      }

      const updated = await applicationService.updateApplication(id, updates);
      sendSuccess(res, updated, "Application updated successfully");
    } catch (error) {
      console.error("Error updating application:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  /**
   * DELETE /applications/:id
   * Delete a draft application
   */
  async deleteApplication(
    req: AuthenticatedRequest,
    res: Response
  ): Promise<void> {
    try {
      const userId = req.userId!;
      const { id } = req.params;

      const application = await applicationService.getApplicationById(id);

      if (!application) {
        sendError(res, "NOT_FOUND", "Application not found", 404);
        return;
      }

      // Only the applicant or admin can delete
      if (application.userId !== userId && !req.user?.admin) {
        sendError(res, "FORBIDDEN", ErrorMessages.FORBIDDEN, 403);
        return;
      }

      await applicationService.deleteApplication(id);
      sendNoContent(res);
    } catch (error) {
      console.error("Error deleting application:", error);
      if ((error as Error).message === "Only draft applications can be deleted") {
        sendError(res, "VALIDATION_ERROR", (error as Error).message, 400);
        return;
      }
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  /**
   * PUT /applications/:id/status
   * Update application status.
   * Owner can only withdraw. Agent/admin can set any status.
   */
  async updateStatus(
    req: AuthenticatedRequest,
    res: Response
  ): Promise<void> {
    try {
      const userId = req.userId!;
      const { id } = req.params;
      const { status, currentStep, nextStep, rejectionReason } = req.body;

      if (!status) {
        sendError(res, "VALIDATION_ERROR", "status is required", 400);
        return;
      }

      const application = await applicationService.getApplicationById(id);

      if (!application) {
        sendError(res, "NOT_FOUND", "Application not found", 404);
        return;
      }

      const isApplicant = application.userId === userId;
      const isAdmin = !!req.user?.admin;
      const hasAccess = await this.checkApplicationAccess(userId, application, isAdmin);

      if (!hasAccess) {
        sendError(res, "FORBIDDEN", ErrorMessages.FORBIDDEN, 403);
        return;
      }

      // Applicants can only withdraw their own applications
      if (isApplicant && !isAdmin && status !== "withdrawn") {
        const isAgentToo = application.agentId === userId;
        if (!isAgentToo) {
          sendError(
            res,
            "FORBIDDEN",
            "You can only withdraw your application",
            403
          );
          return;
        }
      }

      const updated = await applicationService.updateStatus(id, status, {
        currentStep,
        nextStep,
        rejectionReason,
      });

      sendSuccess(res, updated, "Status updated successfully");
    } catch (error) {
      console.error("Error updating status:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  /**
   * GET /applications/:id/timeline
   * Get application timeline
   */
  async getTimeline(
    req: AuthenticatedRequest,
    res: Response
  ): Promise<void> {
    try {
      const userId = req.userId!;
      const { id } = req.params;

      const application = await applicationService.getApplicationById(id);

      if (!application) {
        sendError(res, "NOT_FOUND", "Application not found", 404);
        return;
      }

      const hasAccess = await this.checkApplicationAccess(userId, application, req.user?.admin);
      if (!hasAccess) {
        sendError(res, "FORBIDDEN", ErrorMessages.FORBIDDEN, 403);
        return;
      }

      const timeline = await applicationService.getTimeline(id);
      sendSuccess(res, timeline);
    } catch (error) {
      console.error("Error getting timeline:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  // ============================================
  // HELPER METHODS
  // ============================================

  /**
   * Check if a user has access to an application.
   * Access is granted if:
   * - User is the applicant (userId)
   * - User is the assigned agent (agentId)
   * - User belongs to the same agency (agencyId)
   * - User is an admin
   */
  private async checkApplicationAccess(
    userId: string,
    application: Application,
    isAdmin?: boolean
  ): Promise<boolean> {
    if (isAdmin) return true;
    if (application.userId === userId) return true;
    if (application.agentId === userId) return true;

    // Check if user belongs to the same agency
    if (application.agencyId) {
      const agent = await this.getAgentForUser(userId);
      if (agent?.agencyId === application.agencyId) return true;
    }

    return false;
  }

  /**
   * Get agent document for a userId
   */
  private async getAgentForUser(userId: string): Promise<Agent | null> {
    const snapshot = await collections.agents
      .where("userId", "==", userId)
      .limit(1)
      .get();

    if (snapshot.empty) return null;
    return snapshot.docs[0].data() as Agent;
  }
}

export const applicationController = new ApplicationController();
