import { Response } from "express";
import { AuthenticatedRequest } from "../middleware/auth";
import { consultationService, ConsultationFilters } from "../services/consultation.service";
import { notificationService } from "../services/notification.service";
import { agencyService } from "../services/agency.service";
import { userService } from "../services/user.service";
import { transactionService } from "../services/transaction.service";
import { paystackProvider } from "../services/billing/paystack.provider";
import { EMAIL_BRANDING } from "../services/email/branding";
// Used to invite a freshly-provisioned client to set a password (claim their account).
import { authController } from "./auth.controller";
import { collections, auth } from "../utils/firebase";
import {
  Agent,
  Consultation,
  ConsultationStatus,
  ConsultationType,
  NotificationType,
} from "../types";
import {
  can,
  asSubject,
  checkWithinLimit,
  paymentRequired,
} from "../middleware/authz";
import { ROLES, LIMITS } from "@durin-tech/authz";
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
      case ROLES.ADMIN: {
        if (req.authz?.role !== ROLES.ADMIN) {
          sendError(res, "FORBIDDEN", ErrorMessages.FORBIDDEN, 403);
          return;
        }
        consultations = await consultationService.getAllConsultations(filters);
        break;
      }
      case ROLES.OWNER: {
        if (req.authz?.role !== ROLES.OWNER || !req.authz.agencyId) {
          sendError(
            res,
            "FORBIDDEN",
            "Only agency owners can view agency consultations",
            403
          );
          return;
        }
        consultations = await consultationService.getConsultationsForAgency(
          req.authz.agencyId,
          filters
        );
        break;
      }
      case ROLES.CLIENT: {
        // Mobile clients query their own consultations by userId
        consultations = await consultationService.getConsultationsForClient(
          userId,
          filters
        );
        break;
      }
      case ROLES.AGENT:
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
      case ROLES.ADMIN: {
        if (req.authz?.role !== ROLES.ADMIN) {
          sendError(res, "FORBIDDEN", ErrorMessages.FORBIDDEN, 403);
          return;
        }
        consultations = await consultationService.getAllConsultations();
        break;
      }
      case ROLES.OWNER: {
        if (req.authz?.role !== ROLES.OWNER || !req.authz.agencyId) {
          sendError(
            res,
            "FORBIDDEN",
            "Only agency owners can view agency stats",
            403
          );
          return;
        }
        consultations = await consultationService.getConsultationsForAgency(
          req.authz.agencyId
        );
        break;
      }
      case ROLES.AGENT:
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
      const { id } = req.params;

      const consultation = await consultationService.getConsultationById(id);
      if (!consultation) {
        sendError(res, "NOT_FOUND", ErrorMessages.NOT_FOUND, 404);
        return;
      }

      const hasAccess = can(
        req,
        "read",
        asSubject("Consultation", consultation as unknown as Record<string, unknown>)
      );
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

      // Enforce the per-plan monthly consultation limit for the booking subscriber
      // (agency / independent agent / client — matches whose entitlements loaded).
      // No-op until a plan with this limit is assigned.
      const monthScope = agentProfile
        ? req.authz?.agencyId
          ? { field: "agencyId" as const, value: req.authz.agencyId }
          : { field: "agentId" as const, value: authUserId }
        : { field: "userId" as const, value: authUserId };
      const scopeSnap = await collections.consultations
        .where(monthScope.field, "==", monthScope.value)
        .get();
      const now = new Date();
      const monthCount = scopeSnap.docs.filter((d) => {
        const createdAt = (
          d.data().createdAt as { toDate?: () => Date } | undefined
        )?.toDate?.();
        return (
          !!createdAt &&
          createdAt.getUTCFullYear() === now.getUTCFullYear() &&
          createdAt.getUTCMonth() === now.getUTCMonth()
        );
      }).length;
      if (!checkWithinLimit(req, LIMITS.MAX_CONSULTATIONS_PER_MONTH, monthCount)) {
        paymentRequired(
          res,
          "You've reached your plan's monthly consultation limit. Upgrade to book more."
        );
        return;
      }

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

      const hasAccess = can(
        req,
        "read",
        asSubject("Consultation", existing as unknown as Record<string, unknown>)
      );
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

      // If the time changed, notify the other party it was rescheduled.
      const rescheduled =
        req.body.scheduledDate !== undefined || req.body.scheduledTime !== undefined;
      const recipient = userId === existing.userId ? existing.agentId : existing.userId;
      if (rescheduled && recipient) {
        await notificationService
          .notifyUser({
            userId: recipient,
            type: "consultation_rescheduled",
            title: "Consultation rescheduled",
            body: "Your consultation has been rescheduled — check the new time.",
            relatedEntityType: "consultation",
            relatedEntityId: id,
          })
          .catch((e) => console.error("[consultation] reschedule notify failed:", e));
      }

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

      const hasAccess = can(
        req,
        "read",
        asSubject("Consultation", existing as unknown as Record<string, unknown>)
      );
      if (!hasAccess) {
        sendError(res, "FORBIDDEN", ErrorMessages.FORBIDDEN, 403);
        return;
      }

      const updated = await consultationService.updateStatus(id, status, {
        cancelledBy: status === "cancelled" ? userId : undefined,
        cancellationReason,
        summary,
      });

      // Notify the OTHER party of a meaningful status transition.
      const typeByStatus: Record<string, NotificationType> = {
        confirmed: "consultation_confirmed",
        completed: "consultation_completed",
        cancelled: "consultation_cancelled",
      };
      const notifType = typeByStatus[status];
      const recipient = userId === existing.userId ? existing.agentId : existing.userId;
      if (notifType && recipient) {
        const copy: Record<string, { title: string; body: string }> = {
          confirmed: { title: "Consultation confirmed", body: "Your consultation has been confirmed." },
          completed: { title: "Consultation complete", body: "Your consultation has been marked complete." },
          cancelled: {
            title: "Consultation cancelled",
            body: `Your consultation was cancelled${cancellationReason ? `: ${cancellationReason}` : "."}`,
          },
        };
        await notificationService
          .notifyUser({
            userId: recipient,
            type: notifType,
            title: copy[status].title,
            body: copy[status].body,
            relatedEntityType: "consultation",
            relatedEntityId: id,
          })
          .catch((e) => console.error("[consultation] status notify failed:", e));
      }

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

      const hasAccess = can(
        req,
        "read",
        asSubject("Consultation", existing as unknown as Record<string, unknown>)
      );
      if (!hasAccess) {
        sendError(res, "FORBIDDEN", ErrorMessages.FORBIDDEN, 403);
        return;
      }

      await consultationService.deleteConsultation(id);

      // Notify the other party that the consultation was cancelled.
      const recipient = userId === existing.userId ? existing.agentId : existing.userId;
      if (recipient) {
        await notificationService
          .notifyUser({
            userId: recipient,
            type: "consultation_cancelled",
            title: "Consultation cancelled",
            body: "A consultation was cancelled.",
            relatedEntityType: "consultation",
            relatedEntityId: id,
          })
          .catch((e) => console.error("[consultation] delete notify failed:", e));
      }

      sendNoContent(res);
    } catch (error) {
      console.error("Error deleting consultation:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  /**
   * POST /agencies/public/:slug/consultations  (PUBLIC — no auth)
   *
   * Guest booking entry point for the shareable agency page. A visitor without an
   * account books a consultation with an agency. We resolve/provision a client
   * account from the email (same pattern as agent-created applications,
   * application.controller.ts), create the consultation against the agency owner
   * (who acts as the booking agent), and — when the agency charges a consultation
   * fee — start a one-off Paystack checkout that must be paid before the booking
   * confirms.
   *
   * SECURITY: the fee is ALWAYS read from the agency record, never from the request
   * body, so a guest can't set their own price. No per-plan monthly limit applies
   * to guest bookings — the fee itself is the gate.
   *
   * UNITS: `agency.consultationFee` is stored in whole Naira by the portal (raw
   * value from a ₦ input, displayed with no /100). Paystack expects kobo, so the
   * charge is `fee * 100`. The consultation/transaction `amount` fields keep the
   * same Naira unit as the source for display consistency.
   */
  async createPublicConsultation(
    req: AuthenticatedRequest,
    res: Response
  ): Promise<void> {
    try {
      const { slug } = req.params;
      const {
        clientName,
        clientEmail,
        clientPhone,
        type,
        scheduledDate,
        scheduledTime,
        timezone,
      } = req.body as {
        clientName?: string;
        clientEmail?: string;
        clientPhone?: string;
        type?: string;
        scheduledDate?: string;
        scheduledTime?: string;
        timezone?: string;
      };

      // --- Validate inputs ---------------------------------------------------
      if (!clientName || !clientEmail) {
        sendError(res, "VALIDATION_ERROR", "clientName and clientEmail are required", 400);
        return;
      }
      if (!scheduledDate || !scheduledTime) {
        sendError(res, "VALIDATION_ERROR", "scheduledDate and scheduledTime are required", 400);
        return;
      }
      const normalizedEmail = clientEmail.trim().toLowerCase();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(normalizedEmail)) {
        sendError(res, "VALIDATION_ERROR", "A valid clientEmail is required", 400);
        return;
      }
      // Constrain the free-text type to the known set; default to "initial".
      const allowedTypes: ConsultationType[] = [
        "initial",
        "document_review",
        "interview_prep",
        "follow_up",
        "general",
      ];
      const consultType: ConsultationType = allowedTypes.includes(type as ConsultationType)
        ? (type as ConsultationType)
        : "initial";

      // --- Resolve the agency (must be an admitted/approved agency) ----------
      const agency = await agencyService.getAgencyBySlug(slug);
      if (!agency || agency.status !== "approved") {
        sendError(res, "NOT_FOUND", "Agency not found", 404);
        return;
      }

      // --- Resolve or provision the client by email --------------------------
      // Mirrors application.controller.ts:269-321 so a guest booking links to a
      // real (claimable) account the client can later sign into with this email.
      const [firstName, ...rest] = clientName.trim().split(/\s+/);
      const lastName = rest.join(" ");

      let clientUid: string;
      const existingUser = await userService.getUserByEmail(normalizedEmail);
      if (existingUser) {
        clientUid = existingUser.id;
      } else {
        try {
          const authUser = await auth.createUser({
            email: normalizedEmail,
            displayName: clientName.trim(),
          });
          clientUid = authUser.uid;
          await userService.createUser(clientUid, {
            email: normalizedEmail,
            firstName: firstName || clientName.trim(),
            lastName,
            phone: clientPhone,
          });
          // Provisional = created for the client, not yet self-claimed.
          await collections.users.doc(clientUid).update({ isProvisional: true });
          // Invite them to set a password. Without this the account exists but is
          // unreachable — the client can't sign in to see the booking they just
          // made. Best-effort: an email failure must not fail a paid booking.
          void authController
            .sendClaimEmail(normalizedEmail, firstName, agency.name, agency.id)
            .catch((e) =>
              console.error("[consultation] claim-account invite failed:", e)
            );
        } catch (err) {
          // Auth record already exists (race / pre-existing) → link to it.
          if ((err as { code?: string }).code === "auth/email-already-exists") {
            const authUser = await auth.getUserByEmail(normalizedEmail);
            clientUid = authUser.uid;
          } else {
            throw err;
          }
        }
      }

      // --- Fee is server-authoritative (Naira) -------------------------------
      const feeNaira =
        agency.consultationFee && agency.consultationFee > 0
          ? agency.consultationFee
          : 0;

      // --- Create the consultation -------------------------------------------
      const { Timestamp } = await import("firebase-admin/firestore");
      const consultation = await consultationService.createConsultation({
        userId: clientUid,
        agentId: agency.ownerId, // owner acts as the booking agent for guest flow
        agencyId: agency.id,
        clientName: clientName.trim(),
        clientEmail: normalizedEmail,
        agentName: agency.ownerName,
        type: consultType,
        scheduledDate: Timestamp.fromDate(new Date(scheduledDate)),
        scheduledTime,
        durationMinutes: 30,
        timezone: timezone || "Africa/Lagos",
        status: feeNaira > 0 ? "pending_payment" : "scheduled",
        fee: feeNaira,
        paymentStatus: feeNaira > 0 ? "pending" : "paid",
      });

      // Notify the owner directly. The onConsultationCreated trigger resolves the
      // agent by agent DOC id, which never matches an owner's user uid, so it
      // would silently no-op for guest bookings — notify here instead.
      await notificationService
        .notifyUser({
          userId: agency.ownerId,
          type: "consultation_booking" as NotificationType,
          title: "New consultation booking",
          body: `${clientName.trim()} booked a consultation via your public page.`,
          relatedEntityType: "consultation",
          relatedEntityId: consultation.id,
        })
        .catch((e) => console.error("[public consultation] notify failed:", e));

      // --- Payment: paid agencies must checkout before the booking confirms --
      if (feeNaira > 0) {
        const callbackUrl = `${EMAIL_BRANDING.appUrl}/a/${slug}/confirm`;
        const { authorizationUrl, reference } = await paystackProvider.initializeOneOffCharge({
          email: normalizedEmail,
          amountKobo: feeNaira * 100, // Naira → kobo for Paystack
          metadata: {
            purpose: "consultation",
            consultationId: consultation.id,
            agencySlug: slug,
          },
          callbackUrl,
        });
        // Stash the pending reference so verify-on-return can match it.
        await consultationService.updateConsultation(consultation.id, {
          transactionId: reference,
        });
        sendCreated(res, {
          consultationId: consultation.id,
          requiresPayment: true,
          authorizationUrl,
          reference,
        });
        return;
      }

      sendCreated(res, {
        consultationId: consultation.id,
        requiresPayment: false,
        status: consultation.status,
      });
    } catch (error) {
      const message = (error as Error).message || "";
      if (message.startsWith("PAYSTACK_ERROR")) {
        console.error("Paystack init failed for public consultation:", message);
        sendError(
          res,
          "BILLING_PROVIDER_ERROR",
          "Payment provider is temporarily unavailable. Please try again shortly.",
          502
        );
        return;
      }
      console.error("Error creating public consultation:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  /**
   * POST /consultations/public/verify  (PUBLIC — no auth)
   *
   * Verify-on-return confirmation for a guest consultation payment. After Paystack
   * redirects the payer back to the public confirm page, that page posts the
   * `reference` here. We look the transaction up by reference (NOT via the
   * subscription webhook, which only recognizes subscription-shaped metadata),
   * and on success flip the consultation to paid/scheduled and record the fee
   * transaction. Idempotent: a re-post for an already-paid consultation is a no-op
   * that still returns the booking summary.
   */
  async verifyPublicConsultation(
    req: AuthenticatedRequest,
    res: Response
  ): Promise<void> {
    try {
      const { reference } = req.body as { reference?: string };
      if (!reference) {
        sendError(res, "VALIDATION_ERROR", "reference is required", 400);
        return;
      }

      // Reference lookup returns raw { status, metadata } — the generic
      // (non-subscription) verify path.
      const result = await paystackProvider.getTransactionMetadata(reference);
      if (!result) {
        sendError(res, "NOT_FOUND", "Transaction not found", 404);
        return;
      }

      const consultationId = result.metadata?.consultationId as string | undefined;
      if (result.metadata?.purpose !== "consultation" || !consultationId) {
        sendError(res, "VALIDATION_ERROR", "Reference is not a consultation payment", 400);
        return;
      }

      const consultation = await consultationService.getConsultationById(consultationId);
      if (!consultation) {
        sendError(res, "NOT_FOUND", "Consultation not found", 404);
        return;
      }

      // Build the payer-safe booking summary once (reused across branches).
      const summaryOf = (c: Consultation) => ({
        id: c.id,
        agentName: c.agentName,
        type: c.type,
        scheduledDate: c.scheduledDate,
        scheduledTime: c.scheduledTime,
        timezone: c.timezone,
        status: c.status,
        fee: c.fee,
        paymentStatus: c.paymentStatus,
      });

      // Idempotent short-circuit: already confirmed.
      if (consultation.paymentStatus === "paid") {
        sendSuccess(res, { verified: true, consultation: summaryOf(consultation) });
        return;
      }

      if (result.status !== "success") {
        sendError(res, "VALIDATION_ERROR", "Payment has not been completed", 400);
        return;
      }

      // Confirm: flip to paid/scheduled and record the fee transaction.
      const updated = await consultationService.updateConsultation(consultationId, {
        paymentStatus: "paid",
        status: "scheduled",
        transactionId: reference,
      });
      await transactionService
        .createConsultationFee({
          consultationId,
          clientUserId: consultation.userId,
          agentUserId: consultation.agentId,
          amount: consultation.fee,
          reference,
          clientName: consultation.clientName,
          clientEmail: consultation.clientEmail,
        })
        .catch((e) => console.error("[public consultation] tx record failed:", e));

      sendSuccess(res, {
        verified: true,
        consultation: summaryOf(updated || consultation),
      });
    } catch (error) {
      console.error("Error verifying public consultation:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  // ============================================
  // HELPERS
  // ============================================

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
