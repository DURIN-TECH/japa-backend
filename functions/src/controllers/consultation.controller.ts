import { Response } from "express";
import { AuthenticatedRequest } from "../middleware/auth";
import { consultationService, ConsultationFilters } from "../services/consultation.service";
import { collections } from "../utils/firebase";
import { Agent, Consultation, ConsultationStatus } from "../types";
import {
  sendSuccess,
  sendCreated,
  sendError,
  sendNoContent,
  ErrorMessages,
} from "../utils/response";

export class ConsultationController {
  /**
   * GET /consultations?role=agent|owner|admin&status=...&type=...&startDate=...&endDate=...
   */
  async getConsultations(
    req: AuthenticatedRequest,
    res: Response
  ): Promise<void> {
    try {
      const userId = req.userId!;
      const role = (req.query.role as string) || "agent";

      const filters: ConsultationFilters = {
        status: req.query.status as ConsultationFilters["status"],
        applicationId: req.query.applicationId as string,
        type: req.query.type as string,
        startDate: req.query.startDate as string,
        endDate: req.query.endDate as string,
      };

      let consultations;

      switch (role) {
        case "admin": {
          if (!req.user?.admin) {
            sendError(res, "FORBIDDEN", ErrorMessages.FORBIDDEN, 403);
            return;
          }
          consultations = await consultationService.getAllConsultations(filters);
          break;
        }
        case "owner": {
          const agent = await this.getAgentForUser(userId);
          if (!agent?.agencyId || agent.agencyRole !== "owner") {
            sendError(
              res,
              "FORBIDDEN",
              "Only agency owners can view agency consultations",
              403
            );
            return;
          }
          consultations = await consultationService.getConsultationsForAgency(
            agent.agencyId,
            filters
          );
          break;
        }
        case "client": {
          // Mobile clients query their own consultations by userId
          consultations = await consultationService.getConsultationsForClient(
            userId,
            filters
          );
          break;
        }
        case "agent":
        default: {
          consultations = await consultationService.getConsultationsForAgent(
            userId,
            filters
          );
          break;
        }
      }

      sendSuccess(res, consultations);
    } catch (error) {
      console.error("Error getting consultations:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  /**
   * GET /consultations/stats?role=agent|owner|admin
   */
  async getStats(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const userId = req.userId!;
      const role = (req.query.role as string) || "agent";

      let consultations;

      switch (role) {
        case "admin": {
          if (!req.user?.admin) {
            sendError(res, "FORBIDDEN", ErrorMessages.FORBIDDEN, 403);
            return;
          }
          consultations = await consultationService.getAllConsultations();
          break;
        }
        case "owner": {
          const agent = await this.getAgentForUser(userId);
          if (!agent?.agencyId || agent.agencyRole !== "owner") {
            sendError(
              res,
              "FORBIDDEN",
              "Only agency owners can view agency stats",
              403
            );
            return;
          }
          consultations = await consultationService.getConsultationsForAgency(
            agent.agencyId
          );
          break;
        }
        case "agent":
        default: {
          consultations = await consultationService.getConsultationsForAgent(
            userId
          );
          break;
        }
      }

      const stats = consultationService.computeStats(consultations);
      sendSuccess(res, stats);
    } catch (error) {
      console.error("Error getting consultation stats:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  /**
   * GET /consultations/:id
   */
  async getConsultation(
    req: AuthenticatedRequest,
    res: Response
  ): Promise<void> {
    try {
      const userId = req.userId!;
      const { id } = req.params;

      const consultation = await consultationService.getConsultationById(id);
      if (!consultation) {
        sendError(res, "NOT_FOUND", ErrorMessages.NOT_FOUND, 404);
        return;
      }

      const hasAccess = await this.checkAccess(userId, consultation, !!req.user?.admin);
      if (!hasAccess) {
        sendError(res, "FORBIDDEN", ErrorMessages.FORBIDDEN, 403);
        return;
      }

      sendSuccess(res, consultation);
    } catch (error) {
      console.error("Error getting consultation:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  /**
   * POST /consultations
   *
   * Supports two flows:
   *   1. Agent-initiated: auth'd user is the agent, body contains `userId` (client ID)
   *   2. Client-initiated: auth'd user is the client, body contains `agentId`
   *
   * The controller detects which flow by checking if the auth'd user has an agent profile.
   * If not, the auth'd user is treated as the client and `agentId` from the body is used.
   */
  async createConsultation(
    req: AuthenticatedRequest,
    res: Response
  ): Promise<void> {
    try {
      const authUserId = req.userId!;
      const {
        userId: bodyClientId,
        agentId: bodyAgentId,
        applicationId,
        type,
        scheduledDate,
        scheduledTime,
        durationMinutes,
        timezone,
        fee,
        meetingPlatform,
        meetingLink,
      } = req.body;

      if (!type || !scheduledDate || !scheduledTime) {
        sendError(
          res,
          "VALIDATION_ERROR",
          "type, scheduledDate, and scheduledTime are required"
        );
        return;
      }

      // Determine if auth'd user is an agent or a client
      const agentProfile = await this.getAgentForUser(authUserId);

      let resolvedClientId: string;
      let resolvedAgentUserId: string;
      let agentAgencyId: string | undefined;
      let agentDisplayName: string;

      if (agentProfile) {
        // Agent-initiated flow: auth'd user is the agent, body has client userId
        if (!bodyClientId) {
          sendError(res, "VALIDATION_ERROR", "userId (client) is required when booking as agent");
          return;
        }
        resolvedClientId = bodyClientId;
        resolvedAgentUserId = authUserId;
        agentAgencyId = agentProfile.agencyId;
        agentDisplayName = agentProfile.displayName;
      } else {
        // Client-initiated flow: auth'd user is the client, body has agentId
        if (!bodyAgentId) {
          sendError(res, "VALIDATION_ERROR", "agentId is required when booking as client");
          return;
        }
        resolvedClientId = authUserId;

        // Look up the agent by agent doc ID (not userId)
        const agentDoc = await collections.agents.doc(bodyAgentId).get();
        if (!agentDoc.exists) {
          sendError(res, "NOT_FOUND", "Agent not found", 404);
          return;
        }
        const agent = agentDoc.data()!;
        resolvedAgentUserId = agent.userId;
        agentAgencyId = agent.agencyId;
        agentDisplayName = agent.displayName;
      }

      // Get client user for denormalized fields
      const clientDoc = await collections.users.doc(resolvedClientId).get();
      if (!clientDoc.exists) {
        sendError(res, "NOT_FOUND", "Client user not found", 404);
        return;
      }
      const client = clientDoc.data()!;

      const { Timestamp } = await import("firebase-admin/firestore");

      const consultation = await consultationService.createConsultation({
        userId: resolvedClientId,
        agentId: resolvedAgentUserId,
        agencyId: agentAgencyId,
        applicationId: applicationId || undefined,
        clientName: `${client.firstName || ""} ${client.lastName || ""}`.trim(),
        clientEmail: client.email,
        agentName: agentDisplayName,
        type,
        scheduledDate: Timestamp.fromDate(new Date(scheduledDate)),
        scheduledTime,
        durationMinutes: durationMinutes || 30,
        timezone: timezone || "Africa/Lagos",
        status: fee ? "pending_payment" : "scheduled",
        fee: fee || 0,
        paymentStatus: fee ? "pending" : "paid",
        meetingPlatform: meetingPlatform || undefined,
        meetingLink: meetingLink || undefined,
      });

      sendCreated(res, consultation);
    } catch (error) {
      console.error("Error creating consultation:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  /**
   * PUT /consultations/:id
   */
  async updateConsultation(
    req: AuthenticatedRequest,
    res: Response
  ): Promise<void> {
    try {
      const userId = req.userId!;
      const { id } = req.params;

      const existing = await consultationService.getConsultationById(id);
      if (!existing) {
        sendError(res, "NOT_FOUND", ErrorMessages.NOT_FOUND, 404);
        return;
      }

      const hasAccess = await this.checkAccess(userId, existing, !!req.user?.admin);
      if (!hasAccess) {
        sendError(res, "FORBIDDEN", ErrorMessages.FORBIDDEN, 403);
        return;
      }

      // Only allow updating certain fields
      const allowedFields = [
        "scheduledDate", "scheduledTime", "durationMinutes", "timezone",
        "meetingLink", "meetingPlatform", "type", "summary",
      ];
      const updates: Record<string, unknown> = {};
      for (const field of allowedFields) {
        if (req.body[field] !== undefined) {
          updates[field] = req.body[field];
        }
      }

      // Convert scheduledDate string to Timestamp
      if (updates.scheduledDate && typeof updates.scheduledDate === "string") {
        const { Timestamp } = await import("firebase-admin/firestore");
        updates.scheduledDate = Timestamp.fromDate(new Date(updates.scheduledDate as string));
      }

      const updated = await consultationService.updateConsultation(id, updates as Partial<Consultation>);
      sendSuccess(res, updated);
    } catch (error) {
      console.error("Error updating consultation:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  /**
   * PUT /consultations/:id/status
   */
  async updateStatus(
    req: AuthenticatedRequest,
    res: Response
  ): Promise<void> {
    try {
      const userId = req.userId!;
      const { id } = req.params;
      const { status, cancellationReason, summary } = req.body;

      if (!status) {
        sendError(res, "VALIDATION_ERROR", "status is required");
        return;
      }

      const validStatuses: ConsultationStatus[] = [
        "pending_payment", "scheduled", "confirmed", "in_progress",
        "completed", "cancelled", "no_show",
      ];
      if (!validStatuses.includes(status)) {
        sendError(res, "VALIDATION_ERROR", `Invalid status: ${status}`);
        return;
      }

      const existing = await consultationService.getConsultationById(id);
      if (!existing) {
        sendError(res, "NOT_FOUND", ErrorMessages.NOT_FOUND, 404);
        return;
      }

      const hasAccess = await this.checkAccess(userId, existing, !!req.user?.admin);
      if (!hasAccess) {
        sendError(res, "FORBIDDEN", ErrorMessages.FORBIDDEN, 403);
        return;
      }

      const updated = await consultationService.updateStatus(id, status, {
        cancelledBy: status === "cancelled" ? userId : undefined,
        cancellationReason,
        summary,
      });
      sendSuccess(res, updated);
    } catch (error) {
      console.error("Error updating consultation status:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  /**
   * DELETE /consultations/:id
   */
  async deleteConsultation(
    req: AuthenticatedRequest,
    res: Response
  ): Promise<void> {
    try {
      const userId = req.userId!;
      const { id } = req.params;

      const existing = await consultationService.getConsultationById(id);
      if (!existing) {
        sendError(res, "NOT_FOUND", ErrorMessages.NOT_FOUND, 404);
        return;
      }

      const hasAccess = await this.checkAccess(userId, existing, !!req.user?.admin);
      if (!hasAccess) {
        sendError(res, "FORBIDDEN", ErrorMessages.FORBIDDEN, 403);
        return;
      }

      await consultationService.deleteConsultation(id);
      sendNoContent(res);
    } catch (error) {
      console.error("Error deleting consultation:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  // ============================================
  // HELPERS
  // ============================================

  private async checkAccess(
    userId: string,
    consultation: Consultation,
    isAdmin: boolean
  ): Promise<boolean> {
    if (isAdmin) return true;
    if (consultation.userId === userId) return true;
    if (consultation.agentId === userId) return true;

    // Check same agency
    if (consultation.agencyId) {
      const agent = await this.getAgentForUser(userId);
      if (agent?.agencyId === consultation.agencyId) return true;
    }

    return false;
  }

  private async getAgentForUser(userId: string): Promise<Agent | null> {
    const snapshot = await collections.agents
      .where("userId", "==", userId)
      .limit(1)
      .get();

    if (snapshot.empty) return null;
    return snapshot.docs[0].data() as Agent;
  }
}

export const consultationController = new ConsultationController();
