import { Request, Response } from "express";
import { AuthenticatedRequest } from "../middleware/auth";
import { agentService } from "../services/agent.service";
import { agencyService } from "../services/agency.service";
import {
  sendSuccess,
  sendError,
  sendCreated,
  sendNotFound,
  sendForbidden,
  ErrorMessages,
} from "../utils/response";

export class AgentController {
  // ============================================
  // PUBLIC ENDPOINTS
  // ============================================

  /**
   * GET /agents
   * Get all verified agents with optional filters
   */
  async getAgents(req: Request, res: Response): Promise<void> {
    try {
      const { specialization, language, visaType, minRating, available } =
        req.query;

      const filters = {
        specialization: specialization as string | undefined,
        language: language as string | undefined,
        visaType: visaType as string | undefined,
        minRating: minRating ? parseFloat(minRating as string) : undefined,
        isAvailable: available === "true" ? true : undefined,
      };

      const agents = await agentService.getAgents(filters);
      sendSuccess(res, agents);
    } catch (error) {
      console.error("Error getting agents:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  /**
   * GET /agents/top
   * Get top-rated agents
   */
  async getTopAgents(req: Request, res: Response): Promise<void> {
    try {
      const limit = parseInt(req.query.limit as string) || 10;
      const agents = await agentService.getTopAgents(limit);

      sendSuccess(res, agents);
    } catch (error) {
      console.error("Error getting top agents:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  /**
   * GET /agents/:id
   * Get agent by ID
   */
  async getAgent(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const agent = await agentService.getAgentById(id);

      if (!agent) {
        sendError(res, "NOT_FOUND", "Agent not found", 404);
        return;
      }

      // Only return verified agents publicly
      if (agent.verificationStatus !== "verified") {
        sendError(res, "NOT_FOUND", "Agent not found", 404);
        return;
      }

      sendSuccess(res, agent);
    } catch (error) {
      console.error("Error getting agent:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  /**
   * GET /agents/:id/reviews
   * Get reviews for an agent
   */
  async getAgentReviews(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const limit = parseInt(req.query.limit as string) || 20;

      const reviews = await agentService.getAgentReviews(id, limit);
      sendSuccess(res, reviews);
    } catch (error) {
      console.error("Error getting agent reviews:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  /**
   * GET /agents/visa/:visaTypeId
   * Get agents for a specific visa type
   */
  async getAgentsForVisaType(req: Request, res: Response): Promise<void> {
    try {
      const { visaTypeId } = req.params;
      const agents = await agentService.getAgentsForVisaType(visaTypeId);

      sendSuccess(res, agents);
    } catch (error) {
      console.error("Error getting agents for visa type:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  // ============================================
  // AUTHENTICATED ENDPOINTS
  // ============================================

  /**
   * POST /agents
   * Create agent profile (become an agent)
   */
  async createAgent(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const userId = req.userId!;
      const input = req.body;

      // Validate required fields
      const requiredFields = [
        "displayName",
        "bio",
        "yearsOfExperience",
        "specializations",
        "languages",
        "consultationFee",
      ];

      const missing = requiredFields.filter((f) => !input[f]);
      if (missing.length > 0) {
        sendError(
          res,
          "VALIDATION_ERROR",
          `Missing required fields: ${missing.join(", ")}`,
          400
        );
        return;
      }

      const agent = await agentService.createAgent({
        ...input,
        userId,
      });

      sendCreated(
        res,
        agent,
        "Agent profile created. Pending verification."
      );
    } catch (error) {
      console.error("Error creating agent:", error);
      if (
        (error as Error).message ===
        "Agent profile already exists for this user"
      ) {
        sendError(
          res,
          "DUPLICATE",
          "You already have an agent profile",
          409
        );
        return;
      }
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  /**
   * GET /agents/me
   * Get current user's agent profile
   */
  async getMyAgentProfile(
    req: AuthenticatedRequest,
    res: Response
  ): Promise<void> {
    try {
      const userId = req.userId!;
      const agent = await agentService.getAgentByUserId(userId);

      if (!agent) {
        sendError(res, "NOT_FOUND", "Agent profile not found", 404);
        return;
      }

      sendSuccess(res, agent);
    } catch (error) {
      console.error("Error getting agent profile:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  /**
   * PUT /agents/me
   * Update current user's agent profile
   */
  async updateMyAgentProfile(
    req: AuthenticatedRequest,
    res: Response
  ): Promise<void> {
    try {
      const userId = req.userId!;
      const updates = req.body;

      // Get agent by user ID
      const agent = await agentService.getAgentByUserId(userId);
      if (!agent) {
        sendError(res, "NOT_FOUND", "Agent profile not found", 404);
        return;
      }

      const updatedAgent = await agentService.updateAgent(agent.id, updates);
      sendSuccess(res, updatedAgent, "Profile updated successfully");
    } catch (error) {
      console.error("Error updating agent profile:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  /**
   * PUT /agents/me/availability
   * Update agent availability status
   */
  async updateAvailability(
    req: AuthenticatedRequest,
    res: Response
  ): Promise<void> {
    try {
      const userId = req.userId!;
      const { isAvailable } = req.body;

      if (typeof isAvailable !== "boolean") {
        sendError(
          res,
          "VALIDATION_ERROR",
          "isAvailable must be a boolean",
          400
        );
        return;
      }

      const agent = await agentService.getAgentByUserId(userId);
      if (!agent) {
        sendError(res, "NOT_FOUND", "Agent profile not found", 404);
        return;
      }

      const updated = await agentService.setAvailability(
        agent.id,
        isAvailable
      );
      sendSuccess(res, updated, "Availability updated");
    } catch (error) {
      console.error("Error updating availability:", error);
      if (
        (error as Error).message === "Agent must be verified to be available"
      ) {
        sendError(
          res,
          "FORBIDDEN",
          "Agent must be verified before becoming available",
          403
        );
        return;
      }
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  /**
   * PUT /agents/me/slots
   * Update agent's available time slots
   */
  async updateAvailableSlots(
    req: AuthenticatedRequest,
    res: Response
  ): Promise<void> {
    try {
      const userId = req.userId!;
      const { slots } = req.body;

      if (!Array.isArray(slots)) {
        sendError(res, "VALIDATION_ERROR", "slots must be an array", 400);
        return;
      }

      const agent = await agentService.getAgentByUserId(userId);
      if (!agent) {
        sendError(res, "NOT_FOUND", "Agent profile not found", 404);
        return;
      }

      const updated = await agentService.updateAvailableSlots(agent.id, slots);
      sendSuccess(res, updated, "Available slots updated");
    } catch (error) {
      console.error("Error updating available slots:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  /**
   * POST /agents/:id/reviews
   * Add a review for an agent
   */
  async addReview(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const userId = req.userId!;
      const { id: agentId } = req.params;
      const { rating, title, comment, applicationId } = req.body;

      // Validate
      if (!rating || !comment) {
        sendError(
          res,
          "VALIDATION_ERROR",
          "rating and comment are required",
          400
        );
        return;
      }

      if (rating < 1 || rating > 5) {
        sendError(
          res,
          "VALIDATION_ERROR",
          "rating must be between 1 and 5",
          400
        );
        return;
      }

      const review = await agentService.addReview(agentId, {
        userId,
        applicationId,
        rating,
        title,
        comment,
      });

      sendCreated(res, review, "Review added successfully");
    } catch (error) {
      console.error("Error adding review:", error);
      if (
        (error as Error).message === "User has already reviewed this agent"
      ) {
        sendError(
          res,
          "DUPLICATE",
          "You have already reviewed this agent",
          409
        );
        return;
      }
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  // ============================================
  // ADMIN ENDPOINTS
  // ============================================

  /**
   * PUT /agents/:id/verification (admin only)
   * Update agent verification status
   */
  async updateVerificationStatus(
    req: AuthenticatedRequest,
    res: Response
  ): Promise<void> {
    try {
      const adminUserId = req.userId!;
      const { id: agentId } = req.params;
      const { status } = req.body;

      const validStatuses = [
        "pending",
        "under_review",
        "verified",
        "rejected",
        "suspended",
      ];

      if (!validStatuses.includes(status)) {
        sendError(
          res,
          "VALIDATION_ERROR",
          `status must be one of: ${validStatuses.join(", ")}`,
          400
        );
        return;
      }

      const agent = await agentService.updateVerificationStatus(
        agentId,
        status,
        adminUserId
      );

      sendSuccess(res, agent, `Agent ${status}`);
    } catch (error) {
      console.error("Error updating verification status:", error);
      if ((error as Error).message === "Agent not found") {
        sendError(res, "NOT_FOUND", "Agent not found", 404);
        return;
      }
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  // ============================================
  // AGENCY OWNER ENDPOINTS
  // ============================================

  /**
   * PUT /agents/:id/status
   * Agency owner can suspend or deactivate agents in their agency
   */
  async updateAgentStatus(
    req: AuthenticatedRequest,
    res: Response
  ): Promise<void> {
    try {
      const ownerUserId = req.userId!;
      const { id: agentId } = req.params;
      const { status } = req.body;

      const validStatuses = ["suspended", "deactivated"];
      if (!validStatuses.includes(status)) {
        sendError(
          res,
          "VALIDATION_ERROR",
          `status must be one of: ${validStatuses.join(", ")}`,
          400
        );
        return;
      }

      // Verify the caller owns an agency
      const agency = await agencyService.getAgencyByOwnerId(ownerUserId);
      if (!agency) {
        sendForbidden(res, "Only agency owners can manage agent status");
        return;
      }

      // Verify the target agent belongs to the caller's agency
      const agent = await agentService.getAgentById(agentId);
      if (!agent) {
        sendNotFound(res, "Agent not found");
        return;
      }

      if (agent.agencyId !== agency.id) {
        sendForbidden(res, "Agent does not belong to your agency");
        return;
      }

      // Update the agent's verification status
      const verificationStatus = status === "deactivated" ? "rejected" : "suspended";
      const updated = await agentService.updateVerificationStatus(
        agentId,
        verificationStatus,
        ownerUserId
      );

      sendSuccess(res, updated, `Agent ${status}`);
    } catch (error) {
      console.error("Error updating agent status:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }
}

export const agentController = new AgentController();
