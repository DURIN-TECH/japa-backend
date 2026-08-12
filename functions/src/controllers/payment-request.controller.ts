/**
 * Payment Request Controller
 *
 * Handles all HTTP endpoints related to payment requests in the Seli platform.
 * Payment requests are created by agents to request funds from clients for
 * visa application services. Clients can approve (releasing escrow funds)
 * or reject (triggering a conversation) these requests.
 *
 * Endpoints:
 *  - GET    /payment-requests          — List payment requests (filtered by role)
 *  - POST   /payment-requests          — Create a new payment request
 *  - GET    /payment-requests/:id      — Get a single payment request
 *  - PUT    /payment-requests/:id/status  — Update payment request status
 *  - PUT    /payment-requests/:id/approve — Client approves and releases escrow
 *  - PUT    /payment-requests/:id/reject  — Client rejects with reason + auto-chat
 *  - DELETE /payment-requests/:id      — Delete a payment request
 */

import { Response } from "express";
import { AuthenticatedRequest } from "../middleware/auth";
import { paymentRequestService } from "../services/payment-request.service";
import { transactionService } from "../services/transaction.service";
import { applicationService } from "../services/application.service";
import { messagingService } from "../services/messaging.service";
import { notificationService } from "../services/notification.service";
import { paystackProvider } from "../services/billing/paystack.provider";
import { EMAIL_BRANDING } from "../services/email/branding";
import { collections } from "../utils/firebase";
import { PaymentRequestStatus } from "../types";
import { ROLES } from "@durin-tech/authz";
import { sendSuccess, sendError, sendNotFound, sendForbidden } from "../utils/response";

/**
 * PaymentRequestController
 *
 * Controller class encapsulating all payment request route handlers.
 * Each method corresponds to a REST endpoint and handles authentication checks,
 * authorization (role-based access), validation, and delegation to services.
 */
/**
 * Format a minor-unit amount (kobo/cents) for human-facing copy.
 *
 * PaymentRequest.amount is stored in the smallest currency unit — the portal
 * divides by 100 on display — so notification copy must do the same or it reads
 * 100x too high.
 */
function formatAmountForDisplay(minorUnits: number, currency: string): string {
  const symbol = currency?.toUpperCase() === "NGN" ? "₦" : "";
  const major = (minorUnits ?? 0) / 100;
  const formatted = major.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return symbol ? `${symbol}${formatted}` : `${formatted} ${currency}`;
}

class PaymentRequestController {
  /**
   * GET /payment-requests
   *
   * Retrieves payment requests based on the caller's role.
   * Supports filtering by applicationId and status via query params.
   *
   * Role-based access:
   *  - "admin"  → returns all payment requests (requires admin flag on user doc)
   *  - "client" → returns only requests where the user is the client
   *  - "owner"  → returns requests for the agent's agency
   *  - "agent"  (default) → returns requests created by the agent
   *
   * Query params: ?role=agent|owner|admin|client&applicationId=xxx&status=pending
   */
  async getPaymentRequests(req: AuthenticatedRequest, res: Response) {
    try {
      // Extract and type-cast query parameters with sensible defaults
      const { role = "agent", applicationId, status } = req.query as {
        role?: string;
        applicationId?: string;
        status?: PaymentRequestStatus;
      };

      // The authenticated user's Firebase UID (guaranteed by auth middleware)
      const userId = req.user!.uid;

      // Optional filters passed down to the service layer
      const filters = { applicationId, status };

      let requests;

      if (role === "admin") {
        // Admin role: verify the user document has an admin flag set in Firestore
        if (req.authz?.role !== ROLES.ADMIN) {
          return sendForbidden(res, "Admin access required");
        }
        // Admins can see all payment requests across the platform
        requests = await paymentRequestService.getAllPaymentRequests(filters);
      } else if (role === "client") {
        // Client role: return only payment requests addressed to this user
        requests = await paymentRequestService.getClientPaymentRequests(userId, filters);
      } else if (role === "owner") {
        // Agency owner role: look up the agent profile to find their agency
        const agentSnap = await collections.agents
          .where("userId", "==", userId)
          .limit(1)
          .get();
        if (agentSnap.empty) {
          return sendSuccess(res, []);
        }
        const agent = agentSnap.docs[0].data();
        // If the agent is not part of an agency, return empty
        if (!agent.agencyId) {
          return sendSuccess(res, []);
        }
        // Return all payment requests for the agent's agency
        requests = await paymentRequestService.getAgencyPaymentRequests(agent.agencyId, filters);
      } else {
        // Default "agent" role: return only this agent's own payment requests
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
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Unknown error";
      return sendError(res, "INTERNAL_ERROR", message, 500);
    }
  }

  /**
   * POST /payment-requests
   *
   * Creates a new payment request from an agent to a client.
   * The agent must have an active profile and be associated with
   * the specified application (either directly or via their agency).
   *
   * Required body fields: applicationId, amount, description
   * Optional body fields: currency (defaults to "NGN"), category (defaults to "other")
   */
  async createPaymentRequest(req: AuthenticatedRequest, res: Response) {
    try {
      const userId = req.user!.uid;
      const { applicationId, amount, currency, description, category } = req.body;

      // Validate required fields before proceeding
      if (!applicationId || !amount || !description) {
        return sendError(res, "VALIDATION_ERROR", "applicationId, amount, and description are required", 400);
      }

      // Look up the agent profile linked to the authenticated user
      const agentSnap = await collections.agents
        .where("userId", "==", userId)
        .limit(1)
        .get();
      if (agentSnap.empty) {
        return sendForbidden(res, "Agent profile required");
      }
      const agent = agentSnap.docs[0];

      // Fetch the application document to get client info and verify ownership
      const appDoc = await collections.applications.doc(applicationId).get();
      if (!appDoc.exists) {
        return sendNotFound(res, "Application not found");
      }
      const app = appDoc.data()!;

      // Verify the agent is authorized for this application:
      // either they are the assigned agent or belong to the same agency
      if (app.agentId !== agent.id && app.agencyId !== agent.data().agencyId) {
        return sendForbidden(res, "Not authorized for this application");
      }

      // Delegate creation to the service layer with all required fields
      const request = await paymentRequestService.createPaymentRequest({
        applicationId,
        agentId: agent.id,
        agencyId: agent.data().agencyId,
        clientId: app.userId,
        clientName: app.clientName || "",
        clientEmail: app.clientEmail || "",
        amount: Number(amount), // Ensure numeric type (amount stored in cents)
        currency: currency || "NGN", // Default currency is Nigerian Naira
        description,
        category: category || "other",
      });

      // Tell the CLIENT. Creating a payment request previously notified nobody —
      // the record was written and the flow simply stopped, so a client had no
      // prompt to pay and would only discover it by happening to open their
      // payments page. The `payment_request` type is already configured for full
      // delivery (in-app + email + push) in notification-policy; it was just
      // never emitted.
      //
      // Awaited, not fire-and-forget: work kicked off after the response is sent
      // gets CPU-throttled by Cloud Functions and lands late or not at all.
      // Still fail-soft — a notification problem must not fail a request that
      // was already written.
      try {
        await notificationService.notifyUser({
          userId: app.userId,
          type: "payment_request",
          title: "Payment requested",
          body:
            `Your agent has requested ${formatAmountForDisplay(Number(amount), currency || "NGN")} ` +
            `for ${description}. Open Seli to approve or decline it.`,
          relatedEntityType: "payment_request",
          relatedEntityId: request.id,
          data: { paymentRequestId: request.id, applicationId },
        });
      } catch (e) {
        console.error("[payment-request] client notify failed:", e);
      }

      return sendSuccess(res, request, "Payment request created", 201);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Unknown error";
      return sendError(res, "INTERNAL_ERROR", message, 500);
    }
  }

  /**
   * GET /payment-requests/:id
   *
   * Retrieves a single payment request by its document ID.
   * Access is restricted to:
   *  - Admins (user doc has admin flag)
   *  - The agent who created the request or a member of their agency
   *  - The client associated with the request
   */
  async getPaymentRequest(req: AuthenticatedRequest, res: Response) {
    try {
      const { id } = req.params;
      const request = await paymentRequestService.getPaymentRequestById(id);

      if (!request) {
        return sendNotFound(res, "Payment request not found");
      }

      // Authorization check: try admin first, then agent/agency, then client
      const userId = req.user!.uid;

      // Check if user is an admin
      if (req.authz?.role === ROLES.ADMIN) {
        return sendSuccess(res, request);
      }

      // Check if user is the creating agent or belongs to the same agency
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

      // Check if user is the client on the request
      if (request.clientId === userId) {
        return sendSuccess(res, request);
      }

      // No matching access role found
      return sendForbidden(res, "Not authorized");
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Unknown error";
      return sendError(res, "INTERNAL_ERROR", message, 500);
    }
  }

  /**
   * PUT /payment-requests/:id/status
   *
   * Updates the status of a payment request (e.g., pending → cancelled).
   * Only the creating agent or an admin can update the status.
   *
   * Required body: { status: PaymentRequestStatus }
   */
  async updatePaymentRequestStatus(req: AuthenticatedRequest, res: Response) {
    try {
      const { id } = req.params;
      const { status } = req.body as { status: PaymentRequestStatus };

      if (!status) {
        return sendError(res, "VALIDATION_ERROR", "status is required", 400);
      }

      // Fetch the existing payment request to verify it exists
      const request = await paymentRequestService.getPaymentRequestById(id);
      if (!request) {
        return sendNotFound(res, "Payment request not found");
      }

      // Authorization: only the creating agent or an admin can update status
      const userId = req.user!.uid;
      const isAdmin = req.authz?.role === ROLES.ADMIN;

      if (!isAdmin) {
        // Non-admin: verify the user is the agent who created this request
        const agentSnap = await collections.agents
          .where("userId", "==", userId)
          .limit(1)
          .get();
        if (agentSnap.empty || request.agentId !== agentSnap.docs[0].id) {
          return sendForbidden(res, "Not authorized");
        }
      }

      // Delegate status update to service layer
      const updated = await paymentRequestService.updateStatus(id, status);
      return sendSuccess(res, updated);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Unknown error";
      return sendError(res, "INTERNAL_ERROR", message, 500);
    }
  }

  /**
   * PUT /payment-requests/:id/approve
   *
   * Client approves an agent's payment request and STARTS CHECKOUT. Returns a
   * Paystack `authorizationUrl` for the caller to redirect to.
   *
   * WHAT CHANGED AND WHY: approving used to be treated as payment — it booked an
   * escrow release, incremented the application's `amountPaid`, and told the
   * agent "payment approved", all without a single naira moving. There was no
   * payment provider in this flow at all. Money now actually has to change hands
   * before any of that happens: those side effects moved to `verifyPayment`,
   * which runs only after Paystack confirms the charge succeeded.
   *
   * Only the client on the request or an admin can approve, and only a pending
   * request can be approved.
   */
  async approvePaymentRequest(req: AuthenticatedRequest, res: Response) {
    try {
      const { id } = req.params;
      const userId = req.user!.uid;

      // Fetch the payment request to validate and authorize
      const request = await paymentRequestService.getPaymentRequestById(id);
      if (!request) {
        return sendNotFound(res, "Payment request not found");
      }

      // Authorization: only the client or an admin can approve
      const isAdmin = req.authz?.role === ROLES.ADMIN;
      if (!isAdmin && request.clientId !== userId) {
        return sendForbidden(res, "Only the client or admin can approve payment requests");
      }

      // Only pending requests can be approved
      if (request.status !== "pending") {
        return sendError(res, "VALIDATION_ERROR", "Only pending payment requests can be approved", 400);
      }

      // Mark approved — the client has consented to be charged. The request
      // stays "approved" (not "paid") until Paystack confirms the money landed.
      const approved = await paymentRequestService.approvePaymentRequest(id);

      // Initialize a Paystack charge and hand the client a checkout URL.
      // `purpose` + `paymentRequestId` ride in metadata so the return leg can
      // tie the reference back to THIS request (see verifyPayment).
      const { authorizationUrl, reference } =
        await paystackProvider.initializeOneOffCharge({
          email: request.clientEmail,
          amountKobo: request.amount, // already stored in minor units
          metadata: {
            purpose: "payment_request",
            paymentRequestId: id,
            applicationId: request.applicationId,
          },
          callbackUrl: `${EMAIL_BRANDING.appUrl}/client/payments?reference={reference}`,
        });

      // Persist the reference so a replayed or mismatched one can't be credited
      // to a different request.
      await collections.paymentRequests.doc(id).update({
        paystackReference: reference,
      });

      return sendSuccess(
        res,
        { ...approved, paystackReference: reference, authorizationUrl },
        "Payment request approved — continue to payment"
      );
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Unknown error";
      return sendError(res, "INTERNAL_ERROR", message, 500);
    }
  }


  /**
   * POST /payment-requests/:id/verify
   * Body: { reference: string }
   *
   * Completes a payment after the client returns from Paystack. This is where a
   * payment request actually becomes PAID, and the only place the money-side
   * effects happen — the escrow-release transaction and the application's
   * `amountPaid` — because until Paystack says the charge succeeded, nothing has
   * been paid.
   *
   * Verify-on-return (rather than relying solely on a webhook) matches the guest
   * consultation flow: the client is sitting in front of the result and should
   * see it immediately. Idempotent, so a refresh of the return URL, a retry, or
   * a webhook arriving later cannot double-credit.
   */
  async verifyPayment(req: AuthenticatedRequest, res: Response) {
    try {
      const { id } = req.params;
      const { reference } = req.body as { reference?: string };
      const userId = req.user!.uid;

      if (!reference) {
        return sendError(res, "VALIDATION_ERROR", "reference is required", 400);
      }

      const request = await paymentRequestService.getPaymentRequestById(id);
      if (!request) return sendNotFound(res, "Payment request not found");

      // Only the client being charged (or an admin) may complete it.
      const isAdmin = req.authz?.role === ROLES.ADMIN;
      if (!isAdmin && request.clientId !== userId) {
        return sendForbidden(res, "Only the client or admin can complete this payment");
      }

      // Already settled — return success rather than an error so a refreshed
      // callback URL is harmless.
      if (request.status === "paid") {
        return sendSuccess(res, request, "Payment already completed");
      }

      // The reference must be the one we minted for THIS request. Without this
      // check a valid reference from any other Paystack transaction could be
      // replayed here to mark a request paid for free.
      if (request.paystackReference && request.paystackReference !== reference) {
        return sendError(
          res,
          "VALIDATION_ERROR",
          "This payment reference does not belong to this request",
          400
        );
      }

      const result = await paystackProvider.getTransactionMetadata(reference);
      if (!result) return sendNotFound(res, "Transaction not found");

      // Cross-check the metadata too, for references minted before the field
      // existed or where the update failed.
      const metaRequestId = result.metadata?.paymentRequestId as string | undefined;
      if (result.metadata?.purpose !== "payment_request" || metaRequestId !== id) {
        return sendError(
          res,
          "VALIDATION_ERROR",
          "Reference is not a payment for this request",
          400
        );
      }

      if (result.status !== "success") {
        // Not paid (abandoned/failed). Leave the request approved so the client
        // can retry rather than stranding it in a terminal state.
        return sendSuccess(
          res,
          { ...request, paymentStatus: result.status },
          "Payment not completed"
        );
      }

      // ---- Confirmed paid: NOW do the money-side bookkeeping ----------------
      const paid = await paymentRequestService.updateStatus(id, "paid");
      await transactionService.createEscrowRelease(paid);
      await applicationService.incrementAmountPaid(request.applicationId, request.amount);

      // Tell the agent money actually arrived (previously sent on approval,
      // when nothing had).
      const agentUserId = (
        await collections.agents.doc(request.agentId).get()
      ).data()?.userId;
      if (agentUserId) {
        await notificationService
          .notifyUser({
            userId: agentUserId,
            type: "payment_received",
            title: "Payment received",
            body:
              `${request.clientName || "Your client"} paid ` +
              `${formatAmountForDisplay(request.amount, request.currency)} for ${request.description}.`,
            relatedEntityType: "payment_request",
            relatedEntityId: id,
            data: request.applicationId
              ? { applicationId: request.applicationId }
              : undefined,
          })
          .catch((e) => console.error("[payment-request] agent notify failed:", e));
      }

      return sendSuccess(res, paid, "Payment completed");
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Unknown error";
      return sendError(res, "INTERNAL_ERROR", message, 500);
    }
  }

  /**
   * PUT /payment-requests/:id/reject
   *
   * Client rejects an agent's payment request. This triggers:
   *  1. Marking the payment request as rejected (with reason)
   *  2. Looking up agent info for notifications
   *  3. Creating a notification record for the agent
   *  4. Sending an FCM push notification to the agent's devices
   *  5. Auto-creating a conversation between client and agent with the
   *     rejection reason as the first message, so they can discuss further
   *
   * Only the client on the request or an admin can reject.
   * The request must be in "pending" status.
   *
   * Required body: { reason: string }
   */
  async rejectPaymentRequest(req: AuthenticatedRequest, res: Response) {
    try {
      const { id } = req.params;
      const { reason } = req.body;
      const userId = req.user!.uid;

      // A rejection reason is required so the agent understands why
      if (!reason) {
        return sendError(res, "VALIDATION_ERROR", "reason is required", 400);
      }

      // Fetch the payment request to validate and authorize
      const request = await paymentRequestService.getPaymentRequestById(id);
      if (!request) {
        return sendNotFound(res, "Payment request not found");
      }

      // Authorization: only the client or an admin can reject
      const isAdmin = req.authz?.role === ROLES.ADMIN;
      if (!isAdmin && request.clientId !== userId) {
        return sendForbidden(res, "Only the client or admin can reject payment requests");
      }

      // Only pending requests can be rejected
      if (request.status !== "pending") {
        return sendError(res, "VALIDATION_ERROR", "Only pending payment requests can be rejected", 400);
      }

      // Step 1: Mark payment request as rejected and store the reason
      const rejected = await paymentRequestService.rejectPaymentRequest(id, reason);

      // Step 2: Get agent info for notifications and messaging
      const agentDoc = await collections.agents.doc(request.agentId).get();
      const agent = agentDoc.data();

      if (agent) {
        // Step 3: Notify the agent (in-app + push + email) of the rejection.
        await notificationService.notifyUser({
          userId: agent.userId,
          type: "payment_request_rejected",
          title: "Payment Request Rejected",
          body: `Your client rejected payment of ₦${(request.amount / 100).toLocaleString()} for ${request.description}. Reason: ${reason}`,
          relatedEntityType: "payment_request",
          relatedEntityId: id,
          data: request.applicationId
            ? { applicationId: request.applicationId }
            : undefined,
        });

        // Step 5: Auto-create a conversation so client and agent can discuss
        // the rejection. The rejection reason is sent as the first message.
        const conversation = await messagingService.getOrCreateConversation(
          request.clientId,
          request.agentId,
          request.applicationId
        );

        // Send the rejection details as the opening message in the conversation
        await messagingService.sendMessage(
          conversation.id,
          request.clientId,
          "user",
          `Payment request rejected: ${request.description}\n\nReason: ${reason}`
        );

        // Return the rejected request along with the conversation ID for client navigation
        return sendSuccess(res, { ...rejected, conversationId: conversation.id }, "Payment request rejected");
      }

      return sendSuccess(res, rejected, "Payment request rejected");
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Unknown error";
      return sendError(res, "INTERNAL_ERROR", message, 500);
    }
  }

  /**
   * DELETE /payment-requests/:id
   *
   * Deletes a payment request by its document ID.
   * Only the agent who created the request or an admin can delete it.
   */
  async deletePaymentRequest(req: AuthenticatedRequest, res: Response) {
    try {
      const { id } = req.params;

      // Fetch the payment request to verify existence and check ownership
      const request = await paymentRequestService.getPaymentRequestById(id);
      if (!request) {
        return sendNotFound(res, "Payment request not found");
      }

      // Authorization: only the creating agent or an admin can delete
      const userId = req.user!.uid;
      const isAdmin = req.authz?.role === ROLES.ADMIN;

      if (!isAdmin) {
        // Non-admin: verify the user is the agent who created this request
        const agentSnap = await collections.agents
          .where("userId", "==", userId)
          .limit(1)
          .get();
        if (agentSnap.empty || request.agentId !== agentSnap.docs[0].id) {
          return sendForbidden(res, "Not authorized");
        }
      }

      // Delegate deletion to the service layer
      await paymentRequestService.deletePaymentRequest(id);
      return sendSuccess(res, { message: "Payment request deleted" });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Unknown error";
      return sendError(res, "INTERNAL_ERROR", message, 500);
    }
  }
}

/** Singleton instance of PaymentRequestController exported for use in route definitions */
export const paymentRequestController = new PaymentRequestController();
