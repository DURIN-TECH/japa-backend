import { Response } from "express";
import { AuthenticatedRequest } from "../middleware/auth";
import { paymentRequestService } from "../services/payment-request.service";
import { collections } from "../utils/firebase";
import { PaymentRequestStatus } from "../types";
import { sendSuccess, sendError, sendNotFound, sendForbidden } from "../utils/response";

class PaymentRequestController {
  /**
   * GET /payment-requests
   * Query params: ?role=agent|owner|admin&applicationId=xxx&status=pending
   */
  async getPaymentRequests(req: AuthenticatedRequest, res: Response) {
    try {
      const { role = "agent", applicationId, status } = req.query as {
        role?: string;
        applicationId?: string;
        status?: PaymentRequestStatus;
      };
      const userId = req.user!.uid;
      const filters = { applicationId, status };

      let requests;
      if (role === "admin") {
        // Check admin
        const userDoc = await collections.users.doc(userId).get();
        if (!userDoc.exists || !(userDoc.data() as any).admin) {
          return sendForbidden(res, "Admin access required");
        }
        requests = await paymentRequestService.getAllPaymentRequests(filters);
      } else if (role === "owner") {
        // Get agent profile to find agency
        const agentSnap = await collections.agents
          .where("userId", "==", userId)
          .limit(1)
          .get();
        if (agentSnap.empty) {
          return sendSuccess(res, []);
        }
        const agent = agentSnap.docs[0].data();
        if (!agent.agencyId) {
          return sendSuccess(res, []);
        }
        requests = await paymentRequestService.getAgencyPaymentRequests(agent.agencyId, filters);
      } else {
        // Agent
        const agentSnap = await collections.agents
          .where("userId", "==", userId)
          .limit(1)
          .get();
        if (agentSnap.empty) {
          return sendSuccess(res, []);
        }
        requests = await paymentRequestService.getAgentPaymentRequests(agentSnap.docs[0].id, filters);
      }

      return sendSuccess(res, requests);
    } catch (error: any) {
      return sendError(res, "INTERNAL_ERROR", error.message, 500);
    }
  }

  /**
   * POST /payment-requests
   */
  async createPaymentRequest(req: AuthenticatedRequest, res: Response) {
    try {
      const userId = req.user!.uid;
      const { applicationId, amount, currency, description } = req.body;

      if (!applicationId || !amount || !description) {
        return sendError(res, "VALIDATION_ERROR", "applicationId, amount, and description are required", 400);
      }

      // Get agent profile
      const agentSnap = await collections.agents
        .where("userId", "==", userId)
        .limit(1)
        .get();
      if (agentSnap.empty) {
        return sendForbidden(res, "Agent profile required");
      }
      const agent = agentSnap.docs[0];

      // Get application to find client info
      const appDoc = await collections.applications.doc(applicationId).get();
      if (!appDoc.exists) {
        return sendNotFound(res, "Application not found");
      }
      const app = appDoc.data()!;

      // Verify agent has access to this application
      if (app.agentId !== agent.id && app.agencyId !== agent.data().agencyId) {
        return sendForbidden(res, "Not authorized for this application");
      }

      const request = await paymentRequestService.createPaymentRequest({
        applicationId,
        agentId: agent.id,
        agencyId: agent.data().agencyId,
        clientId: app.userId,
        clientName: app.clientName || "",
        clientEmail: app.clientEmail || "",
        amount: Number(amount),
        currency: currency || "NGN",
        description,
      });

      return sendSuccess(res, request, "Payment request created", 201);
    } catch (error: any) {
      return sendError(res, "INTERNAL_ERROR", error.message, 500);
    }
  }

  /**
   * GET /payment-requests/:id
   */
  async getPaymentRequest(req: AuthenticatedRequest, res: Response) {
    try {
      const { id } = req.params;
      const request = await paymentRequestService.getPaymentRequestById(id);

      if (!request) {
        return sendNotFound(res, "Payment request not found");
      }

      // Check access: agent, agency member, or admin
      const userId = req.user!.uid;
      const userDoc = await collections.users.doc(userId).get();
      if (userDoc.exists && (userDoc.data() as any).admin) {
        return sendSuccess(res, request);
      }

      const agentSnap = await collections.agents
        .where("userId", "==", userId)
        .limit(1)
        .get();
      if (!agentSnap.empty) {
        const agent = agentSnap.docs[0];
        if (request.agentId === agent.id || request.agencyId === agent.data().agencyId) {
          return sendSuccess(res, request);
        }
      }

      // Client can also view
      if (request.clientId === userId) {
        return sendSuccess(res, request);
      }

      return sendForbidden(res, "Not authorized");
    } catch (error: any) {
      return sendError(res, "INTERNAL_ERROR", error.message, 500);
    }
  }

  /**
   * PUT /payment-requests/:id/status
   */
  async updatePaymentRequestStatus(req: AuthenticatedRequest, res: Response) {
    try {
      const { id } = req.params;
      const { status } = req.body as { status: PaymentRequestStatus };

      if (!status) {
        return sendError(res, "VALIDATION_ERROR", "status is required", 400);
      }

      const request = await paymentRequestService.getPaymentRequestById(id);
      if (!request) {
        return sendNotFound(res, "Payment request not found");
      }

      // Only the agent or admin can update status
      const userId = req.user!.uid;
      const userDoc = await collections.users.doc(userId).get();
      const isAdmin = userDoc.exists && (userDoc.data() as any).admin;

      if (!isAdmin) {
        const agentSnap = await collections.agents
          .where("userId", "==", userId)
          .limit(1)
          .get();
        if (agentSnap.empty || request.agentId !== agentSnap.docs[0].id) {
          return sendForbidden(res, "Not authorized");
        }
      }

      const updated = await paymentRequestService.updateStatus(id, status);
      return sendSuccess(res, updated);
    } catch (error: any) {
      return sendError(res, "INTERNAL_ERROR", error.message, 500);
    }
  }

  /**
   * DELETE /payment-requests/:id
   */
  async deletePaymentRequest(req: AuthenticatedRequest, res: Response) {
    try {
      const { id } = req.params;

      const request = await paymentRequestService.getPaymentRequestById(id);
      if (!request) {
        return sendNotFound(res, "Payment request not found");
      }

      // Only the creating agent or admin can delete
      const userId = req.user!.uid;
      const userDoc = await collections.users.doc(userId).get();
      const isAdmin = userDoc.exists && (userDoc.data() as any).admin;

      if (!isAdmin) {
        const agentSnap = await collections.agents
          .where("userId", "==", userId)
          .limit(1)
          .get();
        if (agentSnap.empty || request.agentId !== agentSnap.docs[0].id) {
          return sendForbidden(res, "Not authorized");
        }
      }

      await paymentRequestService.deletePaymentRequest(id);
      return sendSuccess(res, { message: "Payment request deleted" });
    } catch (error: any) {
      return sendError(res, "INTERNAL_ERROR", error.message, 500);
    }
  }
}

export const paymentRequestController = new PaymentRequestController();
