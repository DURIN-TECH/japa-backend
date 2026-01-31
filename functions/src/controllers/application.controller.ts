import { Response } from "express";
import { AuthenticatedRequest } from "../middleware/auth";
import { applicationService } from "../services/application.service";
import {
  sendSuccess,
  sendError,
  sendCreated,
  sendNoContent,
  ErrorMessages,
} from "../utils/response";
import { ApplicationStatus } from "../types";

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
   * Get all applications for the current user
   */
  async getApplications(
    req: AuthenticatedRequest,
    res: Response
  ): Promise<void> {
    try {
      const userId = req.userId!;
      const { status } = req.query;

      let applications;
      if (status && typeof status === "string") {
        applications = await applicationService.getApplicationsByStatus(
          userId,
          status as ApplicationStatus
        );
      } else {
        applications = await applicationService.getUserApplications(userId);
      }

      sendSuccess(res, applications);
    } catch (error) {
      console.error("Error getting applications:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  /**
   * GET /applications/:id
   * Get a specific application
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

      // Check ownership
      if (application.userId !== userId) {
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
   * Update an application
   */
  async updateApplication(
    req: AuthenticatedRequest,
    res: Response
  ): Promise<void> {
    try {
      const userId = req.userId!;
      const { id } = req.params;
      const { userNotes } = req.body;

      const application = await applicationService.getApplicationById(id);

      if (!application) {
        sendError(res, "NOT_FOUND", "Application not found", 404);
        return;
      }

      // Check ownership
      if (application.userId !== userId) {
        sendError(res, "FORBIDDEN", ErrorMessages.FORBIDDEN, 403);
        return;
      }

      const updated = await applicationService.updateApplication(id, {
        userNotes,
      });

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

      // Check ownership
      if (application.userId !== userId) {
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
   * Update application status (admin/agent only for most statuses)
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

      // Check ownership or agent/admin permissions
      const isOwner = application.userId === userId;
      const isAgent = application.agentId === userId;

      // Users can only withdraw their own applications
      if (!isOwner && !isAgent) {
        sendError(res, "FORBIDDEN", ErrorMessages.FORBIDDEN, 403);
        return;
      }

      // Users can only set status to 'withdrawn'
      if (isOwner && !isAgent && status !== "withdrawn") {
        sendError(
          res,
          "FORBIDDEN",
          "You can only withdraw your application",
          403
        );
        return;
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

      // Check ownership
      if (application.userId !== userId && application.agentId !== userId) {
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
}

export const applicationController = new ApplicationController();
