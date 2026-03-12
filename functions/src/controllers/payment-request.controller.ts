import { Response } from "express";
import { AuthenticatedRequest } from "../middleware/auth";
import { paymentRequestService } from "../services/payment-request.service";
import { transactionService } from "../services/transaction.service";
import { applicationService } from "../services/application.service";
import { messagingService } from "../services/messaging.service";
import { collections, messaging } from "../utils/firebase";
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
      } else if (role === "client") {
        // Client sees their own payment requests
        requests = await paymentRequestService.getClientPaymentRequests(userId, filters);
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
      const { applicationId, amount, currency, description, category } = req.body;

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
        category: category || "other",
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
   * PUT /payment-requests/:id/approve
   * Client approves an agent's payment request, releasing escrow funds.
   */
  async approvePaymentRequest(req: AuthenticatedRequest, res: Response) {
    try {
      const { id } = req.params;
      const userId = req.user!.uid;

      const request = await paymentRequestService.getPaymentRequestById(id);
      if (!request) {
        return sendNotFound(res, "Payment request not found");
      }

      // Auth: only the client on the request or admin can approve
      const userDoc = await collections.users.doc(userId).get();
      const isAdmin = userDoc.exists && (userDoc.data() as any).admin;
      if (!isAdmin && request.clientId !== userId) {
        return sendForbidden(res, "Only the client or admin can approve payment requests");
      }

      if (request.status !== "pending") {
        return sendError(res, "VALIDATION_ERROR", "Only pending payment requests can be approved", 400);
      }

      // 1. Approve the payment request
      const approved = await paymentRequestService.approvePaymentRequest(id);

      // 2. Create escrow release transaction
      await transactionService.createEscrowRelease(approved);

      // 3. Increment amountPaid on the application
      await applicationService.incrementAmountPaid(request.applicationId, request.amount);

      // 4. Create notification for the agent
      const agentDoc = await collections.agents.doc(request.agentId).get();
      const agent = agentDoc.data();
      if (agent) {
        const agentUserDoc = await collections.users.doc(agent.userId).get();
        const agentUser = agentUserDoc.data();

        // Create notification record
        await collections.notifications.add({
          userId: agent.userId,
          type: "payment_received",
          title: "Payment Approved",
          body: `Client approved payment of ₦${(request.amount / 100).toLocaleString()} for ${request.description}`,
          relatedEntityType: "payment_request",
          relatedEntityId: id,
          isRead: false,
          createdAt: new Date(),
        });

        // Send FCM push notification
        if (agentUser?.fcmTokens?.length) {
          try {
            await messaging.sendEachForMulticast({
              tokens: agentUser.fcmTokens,
              notification: {
                title: "Payment Approved",
                body: `Client approved ₦${(request.amount / 100).toLocaleString()} for ${request.description}`,
              },
              data: {
                type: "payment_received",
                paymentRequestId: id,
                applicationId: request.applicationId,
              },
            });
          } catch (pushError) {
            console.error("Error sending push notification:", pushError);
          }
        }
      }

      return sendSuccess(res, approved, "Payment request approved");
    } catch (error: any) {
      return sendError(res, "INTERNAL_ERROR", error.message, 500);
    }
  }

  /**
   * PUT /payment-requests/:id/reject
   * Client rejects an agent's payment request and auto-creates a chat conversation.
   */
  async rejectPaymentRequest(req: AuthenticatedRequest, res: Response) {
    try {
      const { id } = req.params;
      const { reason } = req.body;
      const userId = req.user!.uid;

      if (!reason) {
        return sendError(res, "VALIDATION_ERROR", "reason is required", 400);
      }

      const request = await paymentRequestService.getPaymentRequestById(id);
      if (!request) {
        return sendNotFound(res, "Payment request not found");
      }

      // Auth: only the client on the request or admin can reject
      const userDoc = await collections.users.doc(userId).get();
      const isAdmin = userDoc.exists && (userDoc.data() as any).admin;
      if (!isAdmin && request.clientId !== userId) {
        return sendForbidden(res, "Only the client or admin can reject payment requests");
      }

      if (request.status !== "pending") {
        return sendError(res, "VALIDATION_ERROR", "Only pending payment requests can be rejected", 400);
      }

      // 1. Reject the payment request
      const rejected = await paymentRequestService.rejectPaymentRequest(id, reason);

      // 2. Get agent info for notifications and messaging
      const agentDoc = await collections.agents.doc(request.agentId).get();
      const agent = agentDoc.data();

      if (agent) {
        const agentUserDoc = await collections.users.doc(agent.userId).get();
        const agentUser = agentUserDoc.data();

        // 3. Create notification record for the agent
        await collections.notifications.add({
          userId: agent.userId,
          type: "payment_request_rejected",
          title: "Payment Request Rejected",
          body: `Client rejected payment of ₦${(request.amount / 100).toLocaleString()} for ${request.description}. Reason: ${reason}`,
          relatedEntityType: "payment_request",
          relatedEntityId: id,
          isRead: false,
          createdAt: new Date(),
        });

        // 4. Send FCM push notification
        if (agentUser?.fcmTokens?.length) {
          try {
            await messaging.sendEachForMulticast({
              tokens: agentUser.fcmTokens,
              notification: {
                title: "Payment Request Rejected",
                body: `Client rejected ₦${(request.amount / 100).toLocaleString()} for ${request.description}`,
              },
              data: {
                type: "payment_request_rejected",
                paymentRequestId: id,
                applicationId: request.applicationId,
              },
            });
          } catch (pushError) {
            console.error("Error sending push notification:", pushError);
          }
        }

        // 5. Auto-create conversation with rejection reason as first message
        const conversation = await messagingService.getOrCreateConversation(
          request.clientId,
          request.agentId,
          request.applicationId
        );

        await messagingService.sendMessage(
          conversation.id,
          request.clientId,
          "user",
          `Payment request rejected: ${request.description}\n\nReason: ${reason}`
        );

        return sendSuccess(res, { ...rejected, conversationId: conversation.id }, "Payment request rejected");
      }

      return sendSuccess(res, rejected, "Payment request rejected");
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
