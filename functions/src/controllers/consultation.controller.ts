import { Response } from "express";
import { AuthenticatedRequest } from "../middleware/auth";
import { consultationService, ConsultationFilters } from "../services/consultation.service";
import { notificationService } from "../services/notification.service";
import { agencyService } from "../services/agency.service";
import { userService } from "../services/user.service";
import { paystackProvider } from "../services/billing/paystack.provider";
import { EMAIL_BRANDING } from "../services/email/branding";
// Issue #180: server-side pricing, quote lock, checkout and confirmation.
import {
  bookingSummary,
  chargeCurrencyFor,
  CheckoutState,
  classifyStoredFee,
  hasChargeSnapshot,
  isPricingFailure,
  isQuoteExpired,
  issueCheckout,
  LockedCharge,
  lockQuote,
  paystackState,
  reissueCheckout,
  settlePayment,
  SettleOutcome,
  snapshotOf,
} from "../services/consultation-charge.service";
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
   *
   * PRICE (issue #180, folds #166): the SERVER decides it. The fee is the
   * booking agent's own `consultationFeeUsd` (US dollars, #179), read from
   * the agent record; any `fee`, `amount`, `rate` or `currency` in the body is
   * NEVER read. A client may only book an agent that is verified and
   * available (and whose agency, if any, is approved), so a client cannot
   * price a booking with an agent that is not open for bookings.
   *
   * A paid fee is quoted in the CLIENT's charge currency (from their stored
   * profile country) at the current rate, locked for 30 minutes on the
   * booking (ChargeSnapshot + QuoteLock), and a Paystack checkout is opened
   * for exactly `chargedAmountMinor` in `chargedCurrency`. The response is the
   * booking plus `requiresPayment`, `authorizationUrl` and `reference`. A
   * missing or $0 fee books free (scheduled/paid, no Paystack). A malformed
   * fee, or no usable rate / an unsupported currency, is 503
   * PRICING_UNAVAILABLE with nothing written and no Paystack call.
   */
  async createConsultation(
    req: AuthenticatedRequest,
    res: Response
  ): Promise<void> {
    try {
      const authUserId = req.userId!;
      // NOTE: `fee`, `amount`, `rate` and `currency` are deliberately NOT read
      // from the body (issue #166): the price is the server's.
      const {
        userId: bodyClientId,
        agentId: bodyAgentId,
        applicationId,
        type,
        scheduledDate,
        scheduledTime,
        durationMinutes,
        timezone,
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
      // The record the price is read from (issue #180): always the booking
      // agent's own doc, as stored.
      let pricingAgent: Agent;

      if (agentProfile) {
        // Agent-initiated flow: auth'd user is the agent, body has client userId
        if (!bodyClientId) {
          sendError(res, "VALIDATION_ERROR", "userId (client) is required when booking as agent");
          return;
        }
        resolvedClientId = bodyClientId;
        resolvedAgentUserId = authUserId;
        // The agency comes from the RESOLVED PRINCIPAL (issue #138), not from
        // the caller's own agent document: the principal is the membership
        // that was checked against the agency's records, and it is the same
        // value the monthly-limit scope below uses. An agent document that
        // names an agency the principal does not belong to must not file a
        // consultation under that agency.
        agentAgencyId = req.authz?.agencyId ?? undefined;
        agentDisplayName = agentProfile.displayName;
        pricingAgent = agentProfile;
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
        const agent = agentDoc.data()! as Agent;
        // Issue #180: only an agent open for bookings can be booked (and so
        // priced): verified AND available. Answered like "not found" so the
        // route does not reveal unlisted agents.
        if (agent.verificationStatus !== "verified" || agent.isAvailable !== true) {
          sendError(res, "NOT_FOUND", "Agent not found", 404);
          return;
        }
        // An agent in an agency books only while that agency is approved.
        if (agent.agencyId) {
          const agencyDoc = await collections.agencies.doc(agent.agencyId).get();
          if (!agencyDoc.exists || (agencyDoc.data() as { status?: string }).status !== "approved") {
            sendError(res, "NOT_FOUND", "Agent not found", 404);
            return;
          }
        }
        resolvedAgentUserId = agent.userId;
        agentAgencyId = agent.agencyId;
        agentDisplayName = agent.displayName;
        pricingAgent = agent;
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

      // --- Price it on the server (issue #180), BEFORE anything is written --
      const fee = classifyStoredFee(pricingAgent as unknown as Record<string, unknown>);
      if (fee.kind === "malformed") {
        console.error(`[consultation] agent ${pricingAgent.id} has a malformed fee (${fee.reason}); refusing to book`);
        this.sendPricingUnavailable(res);
        return;
      }
      let charge: LockedCharge | null = null;
      if (fee.kind === "paid") {
        if (!client.email) {
          sendError(res, "VALIDATION_ERROR", "The client has no email address to pay with", 400);
          return;
        }
        try {
          // The CLIENT's currency, from their stored profile (never the body).
          charge = await lockQuote(fee.usd, await chargeCurrencyFor(resolvedClientId));
        } catch (err) {
          if (!isPricingFailure(err)) throw err;
          this.sendPricingUnavailable(res);
          return;
        }
      }

      const { Timestamp } = await import("firebase-admin/firestore");

      const consultation = await consultationService.createConsultation({
        userId: resolvedClientId,
        agentId: resolvedAgentUserId,
        // Firestore rejects undefined: only set the optional links when known.
        ...(agentAgencyId ? { agencyId: agentAgencyId } : {}),
        ...(applicationId ? { applicationId } : {}),
        clientName: `${client.firstName || ""} ${client.lastName || ""}`.trim(),
        clientEmail: client.email,
        agentName: agentDisplayName,
        type,
        scheduledDate: Timestamp.fromDate(new Date(scheduledDate)),
        scheduledTime,
        durationMinutes: durationMinutes || 30,
        timezone: timezone || "Africa/Lagos",
        ...(meetingPlatform ? { meetingPlatform } : {}),
        ...(meetingLink ? { meetingLink } : {}),
        // Paid: the locked snapshot; free: priceUsdCents 0 and no Paystack.
        ...(charge
          ? { ...charge, status: "pending_payment" as const, paymentStatus: "pending" as const }
          : { priceUsdCents: 0, status: "scheduled" as const, paymentStatus: "paid" as const }),
      });

      if (!charge) {
        sendCreated(res, { ...consultation, requiresPayment: false });
        return;
      }

      // --- Open the Paystack checkout for exactly the stored charge ---------
      // Race-safe (claim our own reference in a transaction, then open it):
      // a client "Pay now" retry racing this create can never leave two
      // checkouts (issue #180 review).
      const state = await issueCheckout({
        consultationId: consultation.id,
        observedReference: null,
        charge: null, // the snapshot was locked a moment ago, at create
        email: client.email,
        callbackUrl: this.signedInCallbackUrl(),
      });
      if (state.kind !== "checkout") {
        this.sendNoCheckout(res, state);
        return;
      }
      const { authorizationUrl, reference } = state;
      sendCreated(res, {
        ...consultation,
        transactionId: reference,
        checkoutUrl: authorizationUrl,
        requiresPayment: true,
        authorizationUrl,
        reference,
      });
    } catch (error) {
      if (this.sendIfProviderError(res, error, "signed-in consultation")) return;
      console.error("Error creating consultation:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  /**
   * POST /consultations/:id/checkout  (signed-in client)
   *
   * Issue #180: resume paying a pending booking (the app's "Pay now" after an
   * abandoned checkout, a failed Paystack start, or an expired quote). Only
   * the booking's own client may call it.
   *
   *  - Already paid: `{ requiresPayment: false }` with the booking.
   *  - The current checkout was in fact paid: settled here, with the same
   *    checks as verify (reference, amount, currency; a late exact payment is
   *    honoured and flagged paidAfterQuoteExpiry).
   *  - Paystack reports the current checkout as still in progress (`ongoing`,
   *    `pending`, `processing`, `queued`, anything but `failed`/`abandoned`):
   *    409 PAYMENT_IN_PROGRESS with the SAME checkout; never re-priced while
   *    a bank transfer or USSD payment may still land on it (review fix).
   *  - Quote lock still open and a checkout exists: the SAME checkout is
   *    returned (no second charge is opened while the first can be paid).
   *  - Lock passed (or no checkout was ever opened): a FRESH quote and a new
   *    checkout, decided inside a Firestore transaction so a concurrent
   *    verify or retry can never produce a second one (review fix): a lost
   *    race answers with the booking's current state instead. No usable rate:
   *    503, no Paystack call.
   */
  async checkoutConsultation(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const consultation = await consultationService.getConsultationById(id);
      if (!consultation) {
        sendError(res, "NOT_FOUND", ErrorMessages.NOT_FOUND, 404);
        return;
      }
      // Only the client being charged pays (agents and other clients cannot).
      if (consultation.userId !== req.userId) {
        sendError(res, "FORBIDDEN", ErrorMessages.FORBIDDEN, 403);
        return;
      }
      if (consultation.paymentStatus === "paid") {
        sendSuccess(res, { requiresPayment: false, consultation: bookingSummary(consultation) });
        return;
      }
      // Only a #180-priced pending booking can be (re)charged; a legacy row
      // is never re-priced and a cancelled one is closed.
      if (consultation.status !== "pending_payment" || !hasChargeSnapshot(consultation)) {
        sendError(res, "BOOKING_NOT_PAYABLE", "This booking cannot be paid", 409);
        return;
      }

      // An opened checkout: what does Paystack say about it?
      if (consultation.transactionId && consultation.checkoutUrl) {
        const result = await paystackProvider.getTransactionMetadata(consultation.transactionId);
        const state = paystackState(result);
        // Paid after all: settle it, never re-charge.
        if (state === "paid") {
          const outcome = await settlePayment(id, consultation.transactionId, result!);
          this.sendSettleOutcome(res, outcome, consultation.transactionId, "retry");
          return;
        }
        // A payment may still land on it: keep it, do not re-price.
        if (state === "in_progress") {
          this.sendPaymentInProgress(res, consultation);
          return;
        }
        // Inside the lock: hand back the same checkout.
        if (!isQuoteExpired(consultation)) {
          sendSuccess(res, {
            requiresPayment: true,
            authorizationUrl: consultation.checkoutUrl,
            reference: consultation.transactionId,
            consultation: bookingSummary(consultation),
          });
          return;
        }
      }

      // Lock passed (or no checkout opened): a fresh quote and a new checkout.
      let state: CheckoutState;
      try {
        state = await reissueCheckout(consultation, { fallbackCallbackUrl: this.signedInCallbackUrl() });
      } catch (err) {
        if (!isPricingFailure(err)) throw err;
        this.sendPricingUnavailable(res);
        return;
      }
      if (state.kind === "checkout") {
        sendSuccess(res, {
          requiresPayment: true,
          authorizationUrl: state.authorizationUrl,
          reference: state.reference,
          consultation: bookingSummary(state.consultation),
        });
        return;
      }
      this.sendNoCheckout(res, state);
    } catch (error) {
      if (this.sendIfProviderError(res, error, "consultation checkout retry")) return;
      console.error("Error resuming consultation checkout:", error);
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
   * body (`fee`, `amount`, `rate`, `currency` there are ignored), so a guest can't
   * set their own price. No per-plan monthly limit applies to guest bookings — the
   * fee itself is the gate.
   *
   * PRICE (issue #180): the agency's `consultationFeeUsd` (US dollars, #179)
   * is quoted in the DEFAULT charge currency (a guest is anonymous: see
   * `chargeCurrencyFor`) at the current rate and locked on the booking for 30
   * minutes; Paystack is asked for exactly `chargedAmountMinor` in
   * `chargedCurrency`. Free only when the fee is missing or a valid $0. A
   * malformed fee, or no usable rate, is 503 PRICING_UNAVAILABLE BEFORE any
   * account, booking or checkout is created.
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

      // --- Price it on the server (issue #180), BEFORE anything is written --
      const fee = classifyStoredFee(agency as unknown as Record<string, unknown>);
      if (fee.kind === "malformed") {
        console.error(`[public consultation] agency ${agency.id} has a malformed fee (${fee.reason}); refusing to book`);
        this.sendPricingUnavailable(res);
        return;
      }
      let charge: LockedCharge | null = null;
      if (fee.kind === "paid") {
        try {
          charge = await lockQuote(fee.usd, await chargeCurrencyFor(undefined));
        } catch (err) {
          if (!isPricingFailure(err)) throw err;
          this.sendPricingUnavailable(res);
          return;
        }
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
        // Paid: the locked snapshot; free: priceUsdCents 0 and no Paystack.
        ...(charge
          ? { ...charge, status: "pending_payment" as const, paymentStatus: "pending" as const }
          : { priceUsdCents: 0, status: "scheduled" as const, paymentStatus: "paid" as const }),
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
      if (charge) {
        // Race-safe checkout under our own reference (issue #180 review).
        const state = await issueCheckout({
          consultationId: consultation.id,
          observedReference: null,
          charge: null, // the snapshot was locked a moment ago, at create
          email: normalizedEmail,
          callbackUrl: `${EMAIL_BRANDING.appUrl}/a/${slug}/confirm`,
          metadata: { agencySlug: slug },
        });
        if (state.kind !== "checkout") {
          this.sendNoCheckout(res, state);
          return;
        }
        const { authorizationUrl, reference } = state;
        sendCreated(res, {
          consultationId: consultation.id,
          requiresPayment: true,
          authorizationUrl,
          reference,
          // What the guest is about to pay, and until when this price holds.
          ...snapshotOf(charge),
          quoteExpiresAt: charge.quoteExpiresAt,
        });
        return;
      }

      sendCreated(res, {
        consultationId: consultation.id,
        requiresPayment: false,
        status: consultation.status,
      });
    } catch (error) {
      if (this.sendIfProviderError(res, error, "public consultation")) return;
      console.error("Error creating public consultation:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  /**
   * POST /consultations/public/verify  (PUBLIC — no auth)
   *
   * Verify-on-return confirmation for a consultation payment (guest page, and
   * the signed-in app until #183 gives it its own screen). After Paystack
   * redirects the payer back, the page posts the `reference` here. We look the
   * transaction up by reference (NOT via the subscription webhook, which only
   * recognizes subscription-shaped metadata).
   *
   * Issue #180 checks, in order:
   *  1. the reference is a consultation payment of an existing booking;
   *  2. PAID at Paystack: settled in ONE Firestore transaction
   *     (settlePayment). The reference must be the booking's current one or a
   *     superseded one; Paystack's amount (`requested_amount` when reported)
   *     and currency must equal what THAT checkout asked, else 400
   *     PAYMENT_MISMATCH and nothing is recorded. A superseded reference
   *     settles a still-unpaid booking at its own snapshot
   *     (`paidOnSupersededReference`); on a booking already paid it is a
   *     second charge, recorded in consultationPaymentExceptions for refund
   *     (200 with `refundPending: true`), never a second Transaction. A late
   *     exact payment is honoured and flagged `paidAfterQuoteExpiry`. A second
   *     verify writes nothing;
   *  3. NOT paid, and Paystack reports it in progress (`ongoing`, `pending`,
   *     `processing`, `queued`, anything but `failed`/`abandoned`): 409
   *     PAYMENT_IN_PROGRESS with the current checkout; never re-priced;
   *  4. NOT paid (failed / abandoned) on the current reference: inside the
   *     lock 400 "not completed"; after it a FRESH quote and a new checkout,
   *     issued race-safely (409 QUOTE_EXPIRED with the new `authorizationUrl`;
   *     a lost race answers with the winner's checkout, or 200 when the
   *     booking was paid meanwhile);
   *  5. NOT paid on a superseded reference: 409 CHECKOUT_REPLACED with the
   *     booking's current checkout (or, when that one never opened, a new
   *     one as in 4).
   * A Paystack failure while re-pricing answers 502 BILLING_PROVIDER_ERROR.
   */
  async verifyPublicConsultation(
    req: AuthenticatedRequest,
    res: Response
  ): Promise<void> {
    try {
      const { reference } = req.body as { reference?: string };
      if (!reference || typeof reference !== "string") {
        sendError(res, "VALIDATION_ERROR", "reference is required", 400);
        return;
      }

      // Reference lookup returns { status, metadata, amount, requestedAmount,
      // currency, paidAt } — the generic (non-subscription) verify path.
      const result = await paystackProvider.getTransactionMetadata(reference);
      if (!result) {
        sendError(res, "NOT_FOUND", "Transaction not found", 404);
        return;
      }

      // (1) A consultation payment of an existing booking.
      const consultationId = result.metadata?.consultationId as string | undefined;
      if (result.metadata?.purpose !== "consultation" || !consultationId || typeof consultationId !== "string") {
        sendError(res, "VALIDATION_ERROR", "Reference is not a consultation payment", 400);
        return;
      }
      const consultation = await consultationService.getConsultationById(consultationId);
      if (!consultation) {
        sendError(res, "NOT_FOUND", "Consultation not found", 404);
        return;
      }

      // (2) Paid: settle it (all checks re-done on the fresh booking, atomically).
      const state = paystackState(result);
      if (state === "paid") {
        const outcome = await settlePayment(consultationId, reference, result);
        this.sendSettleOutcome(res, outcome, reference, "verify");
        return;
      }

      // Not paid. Only this booking's current or superseded checkouts count.
      const isCurrent = consultation.transactionId === reference;
      const isSuperseded = (consultation.supersededCheckouts ?? []).some((s) => s.reference === reference);
      if (!isCurrent && !isSuperseded) {
        sendError(res, "VALIDATION_ERROR", "This payment reference does not belong to this booking", 400);
        return;
      }
      if (consultation.paymentStatus === "paid") {
        sendSuccess(res, { verified: true, consultation: bookingSummary(consultation) });
        return;
      }
      if (consultation.status !== "pending_payment") {
        sendError(res, "BOOKING_NOT_PAYABLE", "This booking is no longer awaiting payment", 409);
        return;
      }

      // (3) A payment may still land on this reference: keep everything as is.
      if (state === "in_progress") {
        this.sendPaymentInProgress(res, consultation);
        return;
      }

      // Guest checkouts return to the agency page; keep that on a re-price.
      const slug = typeof result.metadata?.agencySlug === "string" ? result.metadata.agencySlug : undefined;
      const reissue = () =>
        reissueCheckout(consultation, {
          fallbackCallbackUrl: slug ? `${EMAIL_BRANDING.appUrl}/a/${slug}/confirm` : this.signedInCallbackUrl(),
          ...(slug ? { metadata: { agencySlug: slug } } : {}),
        });

      // (4) Failed / abandoned on the CURRENT checkout.
      if (isCurrent) {
        if (!hasChargeSnapshot(consultation) || !isQuoteExpired(consultation)) {
          sendError(res, "VALIDATION_ERROR", "Payment has not been completed", 400);
          return;
        }
        await this.answerReissue(res, reissue, "QUOTE_EXPIRED");
        return;
      }

      // (5) Failed / abandoned on a SUPERSEDED checkout: point at the current one.
      if (consultation.transactionId && consultation.checkoutUrl) {
        this.sendCheckoutConflict(res, "CHECKOUT_REPLACED", "This checkout was replaced by a newer one.", {
          authorizationUrl: consultation.checkoutUrl,
          reference: consultation.transactionId,
          consultation,
        });
        return;
      }
      // The current checkout never opened (a Paystack outage): issue one.
      await this.answerReissue(res, reissue, "QUOTE_EXPIRED");
    } catch (error) {
      // A Paystack failure while re-pricing (or looking up) is the provider's.
      if (this.sendIfProviderError(res, error, "consultation verify")) return;
      console.error("Error verifying public consultation:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  // ============================================
  // HELPERS
  // ============================================

  /**
   * Re-price on verify (issue #180) and answer: a checkout (new, or the
   * winner's after a lost race) is 409 `code` with it; a booking paid
   * meanwhile is 200 verified; anything else as sendNoCheckout. No usable
   * rate: 503 before any Paystack call.
   */
  private async answerReissue(
    res: Response,
    reissue: () => Promise<CheckoutState>,
    code: "QUOTE_EXPIRED"
  ): Promise<void> {
    let state: CheckoutState;
    try {
      state = await reissue();
    } catch (err) {
      if (!isPricingFailure(err)) throw err;
      this.sendPricingUnavailable(res);
      return;
    }
    if (state.kind === "checkout") {
      this.sendCheckoutConflict(
        res,
        code,
        "The price quote expired, so it was refreshed. Please pay the new amount.",
        state
      );
      return;
    }
    if (state.kind === "paid") {
      sendSuccess(res, { verified: true, consultation: bookingSummary(state.consultation) });
      return;
    }
    this.sendNoCheckout(res, state);
  }

  /** A 409 that carries a checkout the payer should use instead (QUOTE_EXPIRED, CHECKOUT_REPLACED, PAYMENT_IN_PROGRESS). */
  private sendCheckoutConflict(
    res: Response,
    code: string,
    message: string,
    checkout: { authorizationUrl?: string | null; reference?: string | null; consultation: Consultation }
  ): void {
    res.status(409).json({
      success: false,
      error: code,
      message,
      data: {
        authorizationUrl: checkout.authorizationUrl ?? null,
        reference: checkout.reference ?? null,
        consultation: bookingSummary(checkout.consultation),
      },
    });
  }

  /**
   * 409 PAYMENT_IN_PROGRESS (issue #180 review): Paystack reports the
   * current checkout as not final (a bank transfer or USSD payment may
   * still complete on it). Nothing is re-priced; the current checkout is
   * returned unchanged.
   */
  private sendPaymentInProgress(res: Response, c: Consultation): void {
    this.sendCheckoutConflict(
      res,
      "PAYMENT_IN_PROGRESS",
      "A payment for this booking is still being processed. Please wait a few minutes and check again.",
      { authorizationUrl: c.checkoutUrl, reference: c.transactionId, consultation: c }
    );
  }

  /** Answer a checkout state that is not a usable checkout (paid, closed, or still opening). */
  private sendNoCheckout(res: Response, state: Exclude<CheckoutState, { kind: "checkout" }>): void {
    switch (state.kind) {
    case "paid":
      sendSuccess(res, { requiresPayment: false, consultation: bookingSummary(state.consultation) });
      return;
    case "opening":
      // Another request is opening the checkout right now.
      sendError(res, "CHECKOUT_OPENING", "Your checkout is being prepared. Please try again in a moment.", 409);
      return;
    case "not_payable":
    default:
      sendError(res, "BOOKING_NOT_PAYABLE", "This booking cannot be paid", 409);
      return;
    }
  }

  /**
   * Answer the result of settling a successful Paystack payment (issue
   * #180). `mode` picks the success shape: verify answers `{ verified }`,
   * the retry route `{ requiresPayment: false }`.
   */
  private sendSettleOutcome(
    res: Response,
    outcome: SettleOutcome | null,
    reference: string,
    mode: "verify" | "retry"
  ): void {
    const ok = (c: Consultation, extra: Record<string, unknown> = {}) =>
      sendSuccess(res, {
        ...(mode === "verify" ? { verified: true } : { requiresPayment: false }),
        ...extra,
        consultation: bookingSummary(c),
      });
    if (!outcome) {
      sendError(res, "NOT_FOUND", "Consultation not found", 404);
      return;
    }
    switch (outcome.kind) {
    case "confirmed":
    case "already_paid":
      ok(outcome.consultation);
      return;
    case "refund_recorded":
      // The booking is paid; this extra payment is held for a refund.
      ok(outcome.consultation, { refundPending: true });
      return;
    case "not_payable_recorded":
      sendError(res, "BOOKING_NOT_PAYABLE", "This booking is no longer awaiting payment", 409);
      return;
    case "mismatch":
      this.sendChargeRefused(res, "mismatch", reference);
      return;
    case "not_chargeable":
      this.sendChargeRefused(res, "not_chargeable", reference);
      return;
    case "unknown_reference":
    default:
      // Paid, but never a checkout of this booking: money we cannot place.
      console.error(
        `[consultation] Paystack charge ${reference} is paid but is not a checkout of its booking; ` +
          "not confirmed, needs manual review"
      );
      sendError(res, "VALIDATION_ERROR", "This payment reference does not belong to this booking", 400);
      return;
    }
  }

  /** 503 PRICING_UNAVAILABLE: no usable rate, an unsupported currency, or a malformed stored fee (issue #180). */
  private sendPricingUnavailable(res: Response): void {
    sendError(
      res,
      "PRICING_UNAVAILABLE",
      "Paid consultation booking is temporarily unavailable. Please try again later.",
      503
    );
  }

  /**
   * Answer a successful Paystack charge we will not accept (issue #180).
   * Nothing is written in any of these cases; the booking stays pending.
   */
  private sendChargeRefused(
    res: Response,
    reason: "mismatch" | "not_chargeable",
    reference: string
  ): void {
    if (reason === "mismatch") {
      // Underpayment or wrong currency: log for reconciliation, record nothing.
      console.error(`[consultation] Paystack charge ${reference} does not match the stored charge; not confirmed`);
      sendError(res, "PAYMENT_MISMATCH", "The payment does not match the booking's price", 400);
      return;
    }
    sendError(res, "BOOKING_NOT_PAYABLE", "This booking has nothing to pay", 409);
  }

  /** Map the provider's `PAYSTACK_ERROR: ...` to a clean 502. Returns true when it answered. */
  private sendIfProviderError(res: Response, error: unknown, what: string): boolean {
    const message = (error as Error)?.message || "";
    if (!message.startsWith("PAYSTACK_ERROR")) return false;
    console.error(`Paystack init failed for ${what}:`, message);
    sendError(
      res,
      "BILLING_PROVIDER_ERROR",
      "Payment provider is temporarily unavailable. Please try again shortly.",
      502
    );
    return true;
  }

  /**
   * Where Paystack returns a signed-in payer. The app's pay screen (#183)
   * intercepts this URL and posts the reference to /consultations/public/verify.
   */
  private signedInCallbackUrl(): string {
    return `${EMAIL_BRANDING.appUrl}/consultations/confirm`;
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
