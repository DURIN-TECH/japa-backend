import { Response } from "express";
import { AuthenticatedRequest } from "../middleware/auth";
import {
  consultationService,
  ConsultationFilters,
  // Issue #151: the parties of a booking and the status rules they act under.
  ConsultationActor,
  CONSULTATION_ACTORS,
  CONSULTATION_STATUSES,
  SYSTEM_ONLY_STATUSES,
  // Issue #316: the value checks and the "did it really move" test of the edit route.
  parseEditBody,
  scheduleChanged,
  // Issues #316 / #288: a booking's time is stored as 24-hour `HH:mm`, on
  // create as well as on edit, so "the same slot" compares like with like.
  normalizeScheduledTime,
} from "../services/consultation.service";
import { notificationService } from "../services/notification.service";
import { agencyService } from "../services/agency.service";
import { userService } from "../services/user.service";
import { paystackProvider } from "../services/billing/paystack.provider";
import { EMAIL_BRANDING } from "../services/email/branding";
// Issue #285: the mobile app's `returnTo: "app"` opt-in (shared with #252's
// subscription checkout and payment-request approve).
import { parseReturnTo, selectCallbackUrl } from "../services/billing/payment-return";
// Issue #181 review round 2: the shared Paystack lookup that treats a
// never-opened checkout of ours as final unpaid (see lookupCheckoutState).
import { lookupCheckoutState } from "../services/charge-checkout.service";
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
  // Issue #354: start a held refund once an admin retry finds Paystack's fee.
  startUnappliedRefund,
} from "../services/consultation-charge.service";
// Issue #332: what a booking's CLIENT may see of it (no FX markup, no raw
// rate), and the one rule for who gets that view.
import { consultationFor, seesFullConsultation, toClientConsultation } from "../consultations/client-consultation";
// Issue #317: the refund engine (rule preview, admin refund, Paystack call).
import {
  ADMIN_REFUND_REASONS,
  cancellationRefundPreview,
  consultationRefundService,
  findFeeTransaction,
  isPaidWithMoney,
  MAX_REFUND_NOTE_LENGTH,
  refundSummary,
  // Issue #413 (C): the one copy of the "your consultation moved" refund message.
  rescheduledRefundMessage,
  // Issue #413: the admin refund answers, and the agent view's processing fee.
  AdminRefundOutcome,
  feeForRefund,
} from "../services/consultation-refund.service";
import { chargeRuntime } from "../services/charge-checkout.service";
import { clientChargeFields } from "../money/client-charge";
// Used to invite a freshly-provisioned client to set a password (claim their account).
import { authController } from "./auth.controller";
// Issue #321: `subcollections.messages` is read by the relationship check
// (has the client written in a conversation with this agent?).
import { collections, subcollections, auth } from "../utils/firebase";
import {
  Agent,
  Application,
  Consultation,
  ConsultationType,
  NotificationType,
  // Issue #390: who carries Paystack's fee on an admin refund.
  PaystackFeeBorneBy,
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

/**
 * Issue #321: true when `id` can be used as ONE Firestore document id. The
 * Firestore client throws (which would be a 500) on an empty id, an id with a
 * "/", "." and "..", a reserved `__x__` id, and an id over 1500 bytes. Such a
 * value can never name a user or an application, so the agent flow of
 * `POST /consultations` answers 400 VALIDATION_ERROR before any read.
 */
function isUsableDocId(id: unknown): id is string {
  return (
    typeof id === "string" &&
    id.length > 0 &&
    !id.includes("/") &&
    id !== "." &&
    id !== ".." &&
    !/^__.*__$/.test(id) &&
    Buffer.byteLength(id, "utf8") <= 1500
  );
}

/**
 * Issue #321: how many conversations of one client with one agent the
 * relationship check looks through for a message the client sent. There is
 * one conversation per application the two share (plus one general chat), so
 * a real pair has a handful. The cap only bounds the reads: past it the check
 * answers "no relationship through conversations" (it fails closed).
 */
const CONVERSATIONS_CHECKED = 20;

/**
 * Issue #288: the two body shapes a pending booking's checkout is answered in
 * (see `answerPendingCheckout`):
 *  - "checkout": `POST /consultations/:id/checkout`: the checkout fields next
 *    to a payer-safe `consultation` summary;
 *  - "create": a RESUMED `POST /consultations`: the booking's own fields at
 *    the top level, as a fresh create answers, plus `resumed: true`.
 */
type PendingCheckoutShape = "checkout" | "create";

/** The 400 message for a `scheduledTime` that is neither accepted form (same wording as the edit route, #316). */
const BAD_SCHEDULED_TIME = "scheduledTime must be a 24-hour HH:mm or a 12-hour h:mm AM/PM time";

export class ConsultationController {
  /**
   * GET /consultations?role=agent|owner|admin|client&status=...&type=...&startDate=...&endDate=...
   *
   * Response shape (issue #332), decided PER BOOKING by `bookingFor`:
   *  - a client (and anyone listing bookings they are the client of, e.g.
   *    `role=client`) gets the allow-listed client view
   *    (consultations/client-consultation.ts): no `fxMarginBps`, no raw
   *    `fxRate` / `fxRateAsOf` / `fxRateSource`, no `supersededCheckouts`;
   *    the charge comes with `effectiveRate` (amount charged ÷ dollar price);
   *  - agents, owners and admins get the full stored booking, as before.
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

      // (#332) Never the stored documents for a client: each booking is
      // answered in the shape this caller may see.
      sendSuccess(res, consultations.map((c) => this.bookingFor(req, c)));
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
   *
   * Issue #332: the booking's client gets the allow-listed client view (no
   * FX markup, no raw rate; see `bookingFor`); the agent side gets the full
   * stored booking, as before.
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

      // (#332) The shape depends on who is asking.
      const view = this.bookingFor(req, consultation);
      // Issue #413 (portal design #357): the agent side's view of a paid
      // booking names Paystack's processing fee when it is STORED on the fee
      // Transaction (never looked up on a read, never estimated), so the
      // agent's cancel confirm can say what an agent-caused refund costs
      // them. Null while it is not stored.
      if (seesFullConsultation({ uid: req.userId, role: req.authz?.role }, consultation) && isPaidWithMoney(consultation)) {
        const fee = await findFeeTransaction(consultation);
        const feeMinor = fee ? feeForRefund(fee, null) : undefined;
        sendSuccess(res, {
          ...view,
          processingFee: fee && feeMinor !== undefined ? { amountMinor: feeMinor, currency: fee.currency } : null,
        });
        return;
      }
      // (#317) The client view of a paid, not cancelled booking says what
      // cancelling would give back (the mobile cancel screen reads this and
      // never computes the rule itself). Server clock.
      if (!seesFullConsultation({ uid: req.userId, role: req.authz?.role }, consultation)) {
        // The fee's hold holds the slot the client PAID for (review fix:
        // the window is never measured from a slot the agent moved earlier).
        const fee = isPaidWithMoney(consultation) ? await findFeeTransaction(consultation) : null;
        const preview = cancellationRefundPreview(consultation, chargeRuntime.now(), fee);
        if (preview) {
          sendSuccess(res, { ...view, cancellationRefund: preview });
          return;
        }
      }
      sendSuccess(res, view);
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
   * Issue #246 (agent-initiated only): the client must ALREADY be a client of
   * the caller or the caller's agency (an application, a conversation or an
   * earlier consultation: see `isClientOfAgent`), and a sent `applicationId`
   * must be that client's application with this agent or agency. Otherwise
   * 403 FORBIDDEN with nothing written, no quote, no checkout and no email;
   * a `userId` that does not exist gets the same 403. The client-initiated
   * flow is unchanged.
   *
   * Issue #321: only a link the agent could NOT have made alone counts (a
   * conversation the client started or wrote in; a consultation the client
   * booked themselves or paid for: see `isClientOfAgent`). Every booking
   * stores how it was made (`bookedVia`: "agent" here for the agent flow,
   * "client" for the client flow). A `userId` or `applicationId` that cannot
   * be a Firestore document id (`.`, `..`, `__x__`, a "/", over 1500 bytes)
   * is 400 VALIDATION_ERROR before any read.
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
   *
   * Issue #285: optional body `returnTo`. `"app"` (sent by the mobile app)
   * makes Paystack return to the API's app return page (#252), which hands
   * the payer back to the app; no value keeps the web confirm page; any other
   * value is 400 VALIDATION_ERROR before anything is read or written. The
   * choice is stored on the booking (`checkoutCallbackUrl`) and kept by every
   * re-priced checkout.
   *
   * Issue #288 (both flows): `scheduledTime` may be 24-hour `HH:mm` or
   * 12-hour `h:mm AM/PM` and is always STORED as `HH:mm`; anything else, or a
   * `scheduledDate` that is not a date, is 400 VALIDATION_ERROR before any
   * read or write.
   *
   * Issue #288, RESUME (client-initiated flow only): when the caller already
   * has an unpaid (`pending_payment`) booking with the same agent, the same
   * `scheduledDate` (same instant) and the same `scheduledTime`, NO new
   * booking is written. The newest such booking is answered exactly as
   * `POST /consultations/:id/checkout` would answer it (`answerPendingCheckout`):
   *  - 200 (not 201) with the booking's fields, `requiresPayment`,
   *    `authorizationUrl`, `reference` and `resumed: true`: the SAME checkout
   *    inside the quote lock, a fresh quote and checkout after it;
   *  - 200 with `requiresPayment: false` and `resumed: true` when Paystack
   *    says that checkout was in fact paid (it is settled here);
   *  - 409 PAYMENT_IN_PROGRESS (with `data.consultation.id`) when Paystack
   *    reports it in progress: nothing written, nothing re-priced;
   *  - 409 CHECKOUT_OPENING (with `data.consultation.id`) when another
   *    request is opening the checkout right now.
   * A resume is not a new booking, so it is decided BEFORE the monthly limit
   * and the pricing and counts against neither. `returnTo: "app"` applies to
   * any NEW checkout a resume issues. A booking of that slot that is paid,
   * free or cancelled is not resumed: a new one is created as before. The
   * find-or-create is one Firestore transaction
   * (`createOrResumePendingBooking`), so two requests that arrive together
   * leave exactly one booking. The agent-initiated flow never resumes.
   *
   * Issue #332, RESPONSE SHAPE: a client who books (201, and the resumed
   * 200) gets the allow-listed client view of the booking
   * (consultations/client-consultation.ts) plus the checkout fields: no
   * `fxMarginBps`, no raw `fxRate` / `fxRateAsOf` / `fxRateSource`; the
   * charge comes with `effectiveRate` (amount charged ÷ dollar price, markup
   * included). An agent or owner who books for a client still gets the full
   * stored booking.
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
        returnTo: rawReturnTo,
      } = req.body;

      // Issue #285: `returnTo: "app"` (the mobile app) sends Paystack back to
      // the app return page; no value keeps the web confirm page. Checked
      // FIRST, before any read or write, so a bad value is a plain 400 with
      // nothing booked and nothing sent to Paystack.
      const returnTo = parseReturnTo(rawReturnTo);
      if (!returnTo.ok) {
        sendError(res, "VALIDATION_ERROR", "returnTo must be \"app\" when given", 400);
        return;
      }

      if (!type || !scheduledDate || !scheduledTime) {
        sendError(
          res,
          "VALIDATION_ERROR",
          "type, scheduledDate, and scheduledTime are required"
        );
        return;
      }

      // Issue #288 (add-on from #316): the time is stored as 24-hour `HH:mm`
      // whichever accepted form was sent, so a later request for "the same
      // slot" matches it. A value that is neither form is a plain 400.
      const normalizedTime = normalizeScheduledTime(scheduledTime);
      if (normalizedTime === null) {
        sendError(res, "VALIDATION_ERROR", BAD_SCHEDULED_TIME);
        return;
      }
      // The day, parsed once: it is stored below and compared (as an instant)
      // with the client's unpaid bookings. An unparseable value used to throw
      // inside Timestamp.fromDate and answer 500.
      const scheduledAt = new Date(scheduledDate);
      if (Number.isNaN(scheduledAt.getTime())) {
        sendError(res, "VALIDATION_ERROR", "scheduledDate must be a valid date");
        return;
      }
      const { Timestamp } = await import("firebase-admin/firestore");
      const scheduledTimestamp = Timestamp.fromDate(scheduledAt);

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
        // Issue #246: the ids are used in queries and as a document id below,
        // so they must be plain non-empty strings.
        // Issue #321: and they must be USABLE document ids. Firestore throws
        // on `doc(".")`, `doc("..")`, a reserved `__x__` id and an id over
        // 1500 bytes, which used to surface as a 500; such an id can never
        // name a user or an application, so it is a plain 400 before any read.
        if (typeof bodyClientId !== "string" || !bodyClientId.trim() || !isUsableDocId(bodyClientId)) {
          sendError(res, "VALIDATION_ERROR", "userId (client) must be a user id");
          return;
        }
        if (
          applicationId !== undefined && applicationId !== null && applicationId !== "" &&
          !isUsableDocId(applicationId)
        ) {
          sendError(res, "VALIDATION_ERROR", "applicationId must be an application id");
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

        // Issue #246: an agent (or agency owner) may book only for a client
        // they or their agency ALREADY work with. Without this, any agent
        // could name any uid: the booking would send a real Paystack checkout
        // to a stranger's email and the response would hand back that
        // person's name and email.
        //
        // This runs BEFORE the client's user document is read, and a stranger
        // and a uid that does not exist get the SAME 403, so the route never
        // tells the caller which users exist. Nothing has been written, no
        // quote locked, no checkout opened and no email sent at this point.
        const related = await this.isClientOfAgent(
          resolvedClientId,
          authUserId,
          agentProfile.id,
          agentAgencyId
        );
        // A linked application must be one of THIS client's with this agent
        // or agency (same 403: a foreign id must not be told apart either).
        const applicationOk =
          !related || !applicationId
            ? true
            : await this.isApplicationOfClientWithAgent(applicationId, resolvedClientId, authUserId, agentAgencyId);
        if (!related || !applicationOk) {
          sendError(res, "FORBIDDEN", ErrorMessages.FORBIDDEN, 403);
          return;
        }
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

      // --- Issue #288: resume the client's unpaid booking of this slot ------
      // Client flow only. Done BEFORE the monthly limit and the pricing: a
      // resume writes no new booking, so it neither counts against the limit
      // nor needs a rate (inside the quote lock the same checkout is simply
      // handed back). `returnTo` is passed on as on POST /:id/checkout: it
      // sets the return URL of a NEW checkout only.
      if (!agentProfile) {
        const pending = await consultationService.findResumableBooking({
          userId: resolvedClientId,
          agentId: resolvedAgentUserId,
          scheduledDate: scheduledTimestamp,
          scheduledTime: normalizedTime,
        });
        if (pending) {
          await this.answerPendingCheckout(res, pending, {
            requestedCallbackUrl: selectCallbackUrl(returnTo.value),
            shape: "create",
          });
          return;
        }
      }

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

      // Issue #285: resolve the Paystack return URL BEFORE the booking is
      // written. With `returnTo: "app"` it is built from the running
      // project's API base, which throws when that cannot be built (no
      // project id / a bad API_PUBLIC_URL); that must fail the request with
      // nothing written rather than leave a pending booking with no
      // checkout. The issued checkout stores it as `checkoutCallbackUrl`, so
      // a re-priced checkout later (POST /:id/checkout after the lock, or the
      // re-issue from POST /consultations/public/verify) returns to the same
      // place. (`selectCallbackUrl` types its fallback as optional; `??`
      // only narrows the type, the fallback is always given here.)
      const callbackUrl = charge
        ? selectCallbackUrl(returnTo.value, this.signedInCallbackUrl()) ?? this.signedInCallbackUrl()
        : undefined;

      // The booking to store (the same fields for a plain create and for the
      // find-or-create below).
      const booking = {
        userId: resolvedClientId,
        agentId: resolvedAgentUserId,
        // Firestore rejects undefined: only set the optional links when known.
        ...(agentAgencyId ? { agencyId: agentAgencyId } : {}),
        ...(applicationId ? { applicationId } : {}),
        // Issue #321: how the booking was made, fixed at creation. An
        // agent-made booking is a relationship only once paid; one the
        // signed-in client made themselves is one straight away.
        bookedVia: agentProfile ? ("agent" as const) : ("client" as const),
        clientName: `${client.firstName || ""} ${client.lastName || ""}`.trim(),
        clientEmail: client.email,
        agentName: agentDisplayName,
        type,
        scheduledDate: scheduledTimestamp,
        // #288: always the normalised 24-hour `HH:mm`.
        scheduledTime: normalizedTime,
        durationMinutes: durationMinutes || 30,
        timezone: timezone || "Africa/Lagos",
        ...(meetingPlatform ? { meetingPlatform } : {}),
        ...(meetingLink ? { meetingLink } : {}),
        // Paid: the locked snapshot; free: priceUsdCents 0 and no Paystack.
        ...(charge
          ? { ...charge, status: "pending_payment" as const, paymentStatus: "pending" as const }
          : { priceUsdCents: 0, status: "scheduled" as const, paymentStatus: "paid" as const }),
      };

      let consultation: Consultation;
      if (charge && !agentProfile) {
        // Issue #288: a client's PAID booking is find-or-create in ONE
        // transaction. The early look above found nothing, but a second
        // request for the same slot (a double tap, two devices) may have
        // written its booking since; then that one is resumed here and
        // nothing is written, so the two requests leave exactly one booking.
        const outcome = await consultationService.createOrResumePendingBooking(booking);
        if (outcome.kind === "existing") {
          await this.answerPendingCheckout(res, outcome.consultation, {
            requestedCallbackUrl: selectCallbackUrl(returnTo.value),
            shape: "create",
          });
          return;
        }
        consultation = outcome.consultation;
      } else {
        // A free booking, or one an agent makes: created as before (#288
        // leaves the agent flow unchanged; a free booking is never pending).
        consultation = await consultationService.createConsultation(booking);
      }

      // (#332) The booking in the shape this caller may see: the client view
      // for a client booking for themselves, the stored document for an
      // agent or owner booking for a client.
      const answered = this.bookingFor(req, consultation);

      if (!charge) {
        sendCreated(res, { ...answered, requiresPayment: false });
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
        // #285: the app return page on `returnTo: "app"`, else the web page.
        callbackUrl: callbackUrl!,
      });
      if (state.kind !== "checkout") {
        this.sendNoCheckout(res, state);
        return;
      }
      const { authorizationUrl, reference } = state;
      sendCreated(res, {
        ...answered,
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
   *
   * Issue #285: optional body `returnTo` (`"app"` only, else 400 before
   * anything happens). It sets the return URL of a NEW checkout issued here
   * (and stores it on the booking); without it the stored one is kept.
   */
  async checkoutConsultation(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;

      // Issue #285: optional `returnTo: "app"`, validated before anything is
      // read or written (a bad value is 400; nothing re-priced, no Paystack).
      // The URL itself is resolved here too, so an unbuildable app return
      // URL fails (500) before any settle or re-price. It only applies to a
      // NEW checkout issued below: a checkout still live inside its quote
      // lock was opened at Paystack with its own return URL, and handing
      // back that same checkout (never a second one) wins. Without
      // `returnTo`, a new checkout keeps the booking's stored return URL.
      const returnTo = parseReturnTo((req.body as { returnTo?: unknown } | undefined)?.returnTo);
      if (!returnTo.ok) {
        sendError(res, "VALIDATION_ERROR", "returnTo must be \"app\" when given", 400);
        return;
      }
      const requestedCallbackUrl = selectCallbackUrl(returnTo.value);

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
      // Everything from here on is shared with a resumed POST /consultations
      // (issue #288): see `answerPendingCheckout`.
      await this.answerPendingCheckout(res, consultation, { requestedCallbackUrl, shape: "checkout" });
    } catch (error) {
      if (this.sendIfProviderError(res, error, "consultation checkout retry")) return;
      console.error("Error resuming consultation checkout:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  /**
   * PUT /consultations/:id
   *
   * Issue #316: an edit is allowed only for the AGENT SIDE of the booking,
   * and only for the fields that make sense in the booking's status. (It
   * used to need only READ access, so the client, or anyone else who could
   * read the booking, could move its time or rewrite its meeting link, and a
   * booking could be rescheduled while its checkout was open.)
   *
   * Parties (see `consultationActor`): the AGENT SIDE is the booking's
   * `agentId`, the owner of its agency, or an admin. The CLIENT (`userId`)
   * edits nothing here: clients cancel through `PUT /consultations/:id/status`.
   * An agent of the same agency who is not the booking's agent is not a party.
   *
   * Editable fields (anything else in the body is ignored):
   *  - schedule: `scheduledDate`, `scheduledTime`, `durationMinutes`, `timezone`
   *  - meeting:  `meetingLink`, `meetingPlatform`, `type`
   *  - `summary`
   *
   * The rules live in ONE helper, `decideEdit` (consultation.service.ts):
   *
   *   status           | schedule fields          | meeting fields | summary
   *   -----------------|--------------------------|----------------|--------
   *   pending_payment  | yes, unless a payment is | yes            | yes
   *                    | in flight (409           |                |
   *                    | PAYMENT_IN_PROGRESS)     |                |
   *   scheduled        | yes                      | yes            | yes
   *   confirmed        | yes                      | yes            | yes
   *   in_progress      | 409                      | yes            | yes
   *   completed        | 409                      | 409            | yes
   *   cancelled        | 409                      | 409            | 409
   *   no_show          | 409                      | 409            | 409
   *
   * Answers, in the order they are checked:
   *  - 400 VALIDATION_ERROR: no editable field in the body, or a bad value
   *    (see `parseEditBody` for the rule per field), whoever asks.
   *    `scheduledTime` may be 24-hour `HH:mm` or 12-hour `h:mm AM/PM` (what
   *    the portal's time picker sends); it is always stored as `HH:mm`;
   *  - 404: unknown id;
   *  - 403 FORBIDDEN: the caller is the client, or not a party at all;
   *  - 409 BOOKING_NOT_EDITABLE: a field that is closed in the booking's
   *    status (a plain "409" in the table);
   *  - 409 PAYMENT_IN_PROGRESS: a schedule field on a `pending_payment`
   *    booking whose checkout (`transactionId`) is still inside its quote
   *    lock (`quoteExpiresAt` in the future). Meeting fields and `summary`
   *    are still saved then.
   *
   * One body is all or nothing: a single refused field refuses the whole
   * edit. EVERY refusal writes nothing and notifies nobody. A saved edit
   * answers the updated booking; when a stored schedule value really changed
   * the client is told (`consultation_rescheduled`), and so is the booking's
   * agent when the agency's owner or an admin made the change. Resending the
   * values the booking already holds saves without notifying anyone.
   */
  async updateConsultation(
    req: AuthenticatedRequest,
    res: Response
  ): Promise<void> {
    try {
      const userId = req.userId!;
      const { id } = req.params;

      // 400 first, before the booking is read: the body must name at least
      // one editable field and every value must be well formed.
      const parsed = parseEditBody(req.body);
      if (!parsed.ok) {
        sendError(res, "VALIDATION_ERROR", parsed.message);
        return;
      }

      // Decide and write in one transaction (see editConsultation): the
      // caller's party and the field table are judged on the freshly read
      // booking, so a payment cannot land between the check and the write.
      const outcome = await consultationService.editConsultation(
        id,
        (booking) => this.consultationActor(req, booking),
        parsed.updates
      );

      if (outcome.kind === "not_found") {
        sendError(res, "NOT_FOUND", ErrorMessages.NOT_FOUND, 404);
        return;
      }
      if (outcome.kind === "refused") {
        // Nothing was written; no notification is sent for a refusal.
        const { code, httpStatus, message } = outcome.refusal;
        sendError(res, code, code === "FORBIDDEN" ? ErrorMessages.FORBIDDEN : message, httpStatus);
        return;
      }

      const existing = outcome.before;

      // A saved schedule change: tell the client, and also the booking's
      // agent when someone else on the agent side (owner, admin) made it.
      // The person who made the change is never told about their own edit.
      // Only a stored value that really changed counts: resending the time
      // a booking already has saves, but is not a reschedule.
      if (scheduleChanged(existing, outcome.consultation)) {
        const recipients = [...new Set([existing.userId, existing.agentId])].filter(
          (uid): uid is string => !!uid && uid !== userId
        );
        for (const recipient of recipients) {
          await notificationService
            .notifyUser({
              userId: recipient,
              type: "consultation_rescheduled",
              title: "Consultation rescheduled",
              body:
                recipient === existing.userId
                  ? "Your consultation has been rescheduled — check the new time."
                  : "A consultation with your client has been rescheduled — check the new time.",
              relatedEntityType: "consultation",
              relatedEntityId: id,
            })
            // A failed notification must not fail the edit that was saved.
            .catch((e) => console.error("[consultation] reschedule notify failed:", e));
        }
      }

      sendSuccess(res, outcome.consultation);
    } catch (error) {
      console.error("Error updating consultation:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  /**
   * PUT /consultations/:id/status
   *
   * Issue #151: a status change is allowed only for the party and the
   * starting status it makes sense for (it used to need only READ access, so
   * either party could mark an unpaid booking scheduled/confirmed, a client
   * could mark one completed, and a booking could be cancelled mid-payment).
   *
   * Parties (see `consultationActor`): the CLIENT is the booking's `userId`;
   * the AGENT SIDE is its `agentId`, the owner of its agency, or an admin.
   * The rules live in ONE helper, `decideStatusChange`
   * (consultation.service.ts):
   *
   *   target       | client from                 | agent side from
   *   -------------|-----------------------------|--------------------------------------
   *   confirmed    | never (403)                 | scheduled
   *   in_progress  | never (403)                 | scheduled, confirmed
   *   completed    | never (403)                 | scheduled, confirmed, in_progress
   *   no_show      | never (403)                 | scheduled, confirmed, in_progress
   *   cancelled    | pending_payment, scheduled, | pending_payment, scheduled, confirmed
   *                | confirmed                   |
   *
   * Answers, in the order they are checked:
   *  - 400 VALIDATION_ERROR: no `status`, an unknown one, or `pending_payment`
   *    / `scheduled` as the target (only booking creation and payment verify
   *    write those), whoever asks;
   *  - 404: unknown id;
   *  - 403 FORBIDDEN: the caller is not a party, or is the client asking for
   *    anything but `cancelled`;
   *  - 409 INVALID_STATUS_TRANSITION: a move not in the table (wrong starting
   *    status, out of a terminal `completed` / `cancelled` / `no_show`, or an
   *    unpaid `pending_payment` booking to anything but `cancelled`);
   *  - 409 PAYMENT_IN_PROGRESS: cancelling a `pending_payment` booking whose
   *    checkout (`transactionId`) is still inside its quote lock
   *    (`quoteExpiresAt` in the future). After the lock (or with no checkout)
   *    the cancel goes through; a payment that still lands on the cancelled
   *    booking is recorded for refund by `settlePayment`
   *    (`consultationPaymentExceptions`, reason `booking_not_payable`).
   *
   *  - 409 FEE_RELEASED (issue #317): the agent side cancelling a PAID
   *    booking whose fee was already released (the meeting has happened).
   *
   * EVERY refusal writes nothing and notifies nobody. An allowed change
   * answers as before (the updated booking) and notifies the other party.
   *
   * Issue #317, REFUNDS on a cancel of a PAID booking (rule in
   * services/consultation-refund.service.ts): the agent side, or the client
   * 24 h or more before the slot, gets a full refund: a `refund` Transaction
   * is written in the same Firestore transaction as the cancel (under the
   * agent's withdrawal lock), then sent to Paystack. A client cancelling less
   * than 24 h before gets none. Every allowed answer carries `refund`:
   * `{ status, amount: { amountMinor, currency } }`, or null.
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

      if (!CONSULTATION_STATUSES.includes(status)) {
        sendError(res, "VALIDATION_ERROR", `Invalid status: ${status}`);
        return;
      }

      // Issue #151: `pending_payment` and `scheduled` are never accepted from
      // a caller. Answered here, before the booking is read, so it is a plain
      // 400 for anyone (the helper refuses them too, as a second line).
      if (SYSTEM_ONLY_STATUSES.includes(status)) {
        sendError(
          res,
          "VALIDATION_ERROR",
          `A consultation cannot be set to ${status}: that status is set when it is booked or paid`
        );
        return;
      }

      // Decide and write in one transaction (see changeStatus): the caller's
      // party and the transition are judged on the freshly read booking.
      const outcome = await consultationService.changeStatus(
        id,
        (booking) => this.consultationActor(req, booking),
        status,
        {
          cancelledBy: status === "cancelled" ? userId : undefined,
          cancellationReason,
          summary,
        }
      );

      if (outcome.kind === "not_found") {
        sendError(res, "NOT_FOUND", ErrorMessages.NOT_FOUND, 404);
        return;
      }
      if (outcome.kind === "refused") {
        // Nothing was written; no notification is sent for a refusal.
        const { code, httpStatus, message } = outcome.refusal;
        sendError(res, code, code === "FORBIDDEN" ? ErrorMessages.FORBIDDEN : message, httpStatus);
        return;
      }

      const existing = outcome.before;
      let updated = outcome.consultation;

      // ---- Issue #317: send a new refund to Paystack (after the commit) ----
      // A Paystack failure never fails the cancel: the row stays `pending`
      // and the 15-minute job retries it.
      let refund = outcome.refund;
      if (outcome.refundCreated && refund) {
        try {
          refund = (await consultationRefundService.processRefund(refund.id)) ?? refund;
        } catch (e) {
          console.error(`[consultation] refund ${refund.id} could not be sent yet; the retry job will:`, e);
        }
        // The booking mirrors the row's latest status.
        updated = { ...updated, refundStatus: refund.status as typeof updated.refundStatus };
        // (#390) With the agent's Paystack-fee debit, when one was written.
        await consultationRefundService.notifyCreated(refund, updated, outcome.feeDebit);
      }

      // Notify the OTHER party of a meaningful status transition.
      const typeByStatus: Record<string, NotificationType> = {
        confirmed: "consultation_confirmed",
        completed: "consultation_completed",
        cancelled: "consultation_cancelled",
      };
      const notifType = typeByStatus[status];
      // The client acting: tell the agent. Anyone on the agent side (the
      // agent, the agency's owner, an admin): tell the client.
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

      // (#332) A client cancelling their own booking gets the client view
      // (no FX markup, no raw rate); the agent side the full booking.
      // (#317) Plus the refund outcome: a summary, or null.
      sendSuccess(res, { ...this.bookingFor(req, updated), refund: refund ? refundSummary(refund) : null });
    } catch (error) {
      console.error("Error updating consultation status:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  /**
   * GET /consultations/payment-exceptions (issue #354), ADMIN only.
   *
   * Refunds of payments that could not be applied to a booking and need an
   * admin: every `consultationPaymentExceptions` record with status
   * `refund_failed`, newest first. That is both
   *  - HELD refunds, with no refund row (`refundFailureReason`:
   *    `paystack_fee_unknown` = Paystack reported no well-formed fee;
   *    `fee_not_less_than_amount` = a client-caused fee leaves nothing to
   *    refund), and
   *  - refunds whose row failed at Paystack (also listed in
   *    `GET /transactions?role=admin&type=refund&status=failed`).
   * Each item carries `retryRefundId`: retry it with
   * `POST /consultations/:consultationId/refund { "refundId": retryRefundId }`.
   * Amounts are minor units of each item's own `currency`.
   */
  async listPaymentExceptions(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      // Admins only: these records name Paystack references and clients' money.
      if (req.authz?.role !== ROLES.ADMIN) {
        sendError(res, "FORBIDDEN", ErrorMessages.FORBIDDEN, 403);
        return;
      }
      const items = await consultationRefundService.listExceptionRefundsNeedingAdmin();
      sendSuccess(res, items);
    } catch (error) {
      console.error("Error listing consultation payment exceptions:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  /**
   * POST /consultations/:id/payment-exceptions/:exceptionId/close
   * (issue #354 fix round, ADMIN only; decision 2026-11-17).
   *
   * Closes a CLIENT-caused unapplied-payment exception as `nothing_to_refund`
   * when Paystack's fee on that charge is the whole charge or more
   * (`refundFailureReason: "fee_not_less_than_amount"`): under the fee rule
   * the client is owed nothing. No Paystack call, no refund row, no
   * Transaction; the exception leaves `GET /consultations/payment-exceptions`.
   * `exceptionId` is the exception's `id` from that list (its Paystack
   * reference).
   *
   *  - no token: 401 (verifyAuth, before this runs);
   *  - not an admin: 403 FORBIDDEN, before anything is read;
   *  - a malformed id: 400 VALIDATION_ERROR;
   *  - no such exception of THIS booking: 404;
   *  - already closed: 200 with `alreadyClosed: true`, nothing written
   *    (idempotent: a repeat is a no-op);
   *  - agent-caused, not held as `fee_not_less_than_amount`, or a refund
   *    already exists: 409 NOT_CLOSABLE, nothing written;
   *  - otherwise: 200 with the closed exception.
   */
  async closePaymentException(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      // Admins only, checked first: no read for anyone else.
      if (req.authz?.role !== ROLES.ADMIN) {
        sendError(res, "FORBIDDEN", ErrorMessages.FORBIDDEN, 403);
        return;
      }
      const exceptionId = req.params.exceptionId;
      // A Paystack reference as we issue them: a bounded run of safe
      // characters (and never a path: Firestore ids cannot hold "/").
      if (typeof exceptionId !== "string" || !/^[A-Za-z0-9_.:=-]{1,200}$/.test(exceptionId)) {
        sendError(res, "VALIDATION_ERROR", "exceptionId must be a payment exception id");
        return;
      }
      const outcome = await consultationRefundService.closeExceptionNothingToRefund({
        consultationId: req.params.id,
        exceptionId,
        adminUid: req.userId!,
      });
      if (outcome.kind === "not_found") {
        sendError(res, "NOT_FOUND", ErrorMessages.NOT_FOUND, 404);
        return;
      }
      if (outcome.kind === "not_closable") {
        const message =
          outcome.why === "agent_caused"
            ? "The client is owed this payment in full, so it cannot be closed without a refund."
            : outcome.why === "refund_exists"
              ? "A refund already exists for this payment, so it cannot be closed."
              : "Only a payment whose processing fee is not less than the amount charged can be closed with nothing to refund.";
        sendError(res, "NOT_CLOSABLE", message, 409);
        return;
      }
      sendSuccess(res, { exception: outcome.exception, closed: true, alreadyClosed: outcome.kind === "already_closed" });
    } catch (error) {
      console.error("Error closing consultation payment exception:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  /**
   * POST /consultations/:id/refund/close (issue #413 B, ADMIN only;
   * decision 2026-11-21).
   *
   * Closes the booking's HELD client-cancel refund as `nothing_to_refund`
   * when Paystack's STORED fee on the charge is the whole charge or more:
   * the client is owed nothing, the agent's credit for that fee is 0, Seli's
   * total is 0. No Paystack call, no money row; the refund row becomes
   * `closed` (it leaves the admin failed list), the fee is unfrozen, and the
   * booking mirrors `refundStatus: "closed"`.
   *
   *  - no token: 401 (verifyAuth, before this runs);
   *  - not an admin: 403 FORBIDDEN, before anything is read;
   *  - unknown booking, or no held refund row for it: 404;
   *  - already closed: 200 with `alreadyClosed: true`, nothing written;
   *  - agent-caused, not held for this reason, or the fee is no longer
   *    >= the charge: 409 NOT_CLOSABLE with the reason, nothing written;
   *  - otherwise: 200 with the refund summary and the booking.
   */
  async closeHeldRefund(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      // Admins only, checked first: no read for anyone else.
      if (req.authz?.role !== ROLES.ADMIN) {
        sendError(res, "FORBIDDEN", ErrorMessages.FORBIDDEN, 403);
        return;
      }
      const outcome = await consultationRefundService.closeHeldRefundNothingToRefund({
        consultationId: req.params.id,
        adminUid: req.userId!,
      });
      if (outcome.kind === "not_found") {
        sendError(res, "NOT_FOUND", ErrorMessages.NOT_FOUND, 404);
        return;
      }
      if (outcome.kind === "not_closable") {
        /** One plain sentence per rule that failed. */
        const messages: Record<typeof outcome.why, string> = {
          agent_caused: "The agent side caused this refund, so the client is owed the payment in full: it cannot be closed.",
          not_held_fee_not_less_than_amount:
            "Only a refund held because the processing fee is not less than the amount charged can be closed.",
          fee_less_than_amount: "The processing fee is now less than the amount charged, so the client is owed a refund.",
          not_consultation_refund: "This refund is not the consultation's own refund, so it cannot be closed here.",
        };
        // The rule that failed is named in `data.reason` for the portal.
        res.status(409).json({ success: false, error: "NOT_CLOSABLE", message: messages[outcome.why], data: { reason: outcome.why } });
        return;
      }
      if (outcome.kind === "already_closed") {
        sendSuccess(res, { refund: refundSummary(outcome.refund), refundId: outcome.refund.id, closed: true, alreadyClosed: true });
        return;
      }
      sendSuccess(res, {
        refund: refundSummary(outcome.refund),
        refundId: outcome.refund.id,
        closed: true,
        alreadyClosed: false,
        consultation: outcome.booking,
      });
    } catch (error) {
      console.error("Error closing held consultation refund:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  /**
   * POST /consultations/:id/refund  (issue #317, admins only)
   *
   * Body `{ reason: "agent_no_show" | "goodwill" | "other", note? }`; `note`
   * is required for "other" (at most 1000 characters).
   *
   *  - not an admin: 403 FORBIDDEN, before the booking is read;
   *  - a bad body: 400 VALIDATION_ERROR, before the booking is read;
   *  - unknown id: 404;
   *  - free or unpaid (or paid with no settled Paystack fee): 409 NOTHING_TO_REFUND;
   *  - a refund that is pending / processing / completed: 409 ALREADY_REFUNDED;
   *  - a refund that FAILED: that same row is retried (back to pending,
   *    then sent to Paystack, which is first asked whether it already holds
   *    one): 200 with `refund` and `retried: true`;
   *  - otherwise a full refund through the same path as a cancel: 201 with
   *    `refund` and the booking. The booking's status is not changed.
   * The refund of a fee still held comes out of the hold; of a released fee,
   * off the agent's available balance (may go negative, #351).
   *
   * Issue #354: body `{ refundId }` instead retries a FAILED refund of a
   * payment that could not be applied to this booking (a
   * `consultationPaymentExceptions` record): that same row goes back to
   * pending and is sent to Paystack (200, `retried: true`). Not failed: 409
   * ALREADY_REFUNDED; not such a refund of THIS booking: 404. Such refunds
   * are never created here (settlePayment creates them) and never touch the
   * agent's balance.
   *
   * Issue #390 (whoever caused the refund carries Paystack's fee): body
   * `feeBorneBy: "client" | "agent"` is REQUIRED for goodwill / other (400
   * when missing or anything else; no default). `agent_no_show` is always
   * agent-caused: `feeBorneBy` may be omitted or "agent"; "client" (or any
   * other value) is refused with 400. Client-borne: the client gets the
   * amount charged minus Paystack's fee; agent-borne: everything, and the
   * agent is debited the fee once when the funding path did not already take
   * it. Paystack's fee unknown: 409 PAYSTACK_FEE_UNKNOWN, nothing written
   * (also when retrying a refund a cancel HELD for that reason: the held row
   * is worked out again under the reason and `feeBorneBy` it was held with).
   * Client-borne fee >= the charge: 409 FEE_NOT_LESS_THAN_AMOUNT. Paystack
   * unreachable while asking for the fee: 502 PAYSTACK_ERROR.
   */
  async refundConsultation(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      // Admins only, checked first: no read for anyone else.
      if (req.authz?.role !== ROLES.ADMIN) {
        sendError(res, "FORBIDDEN", ErrorMessages.FORBIDDEN, 403);
        return;
      }
      const body = (req.body ?? {}) as { reason?: unknown; note?: unknown; refundId?: unknown; feeBorneBy?: unknown };

      // ---- Issue #354: retry a FAILED refund of an unapplied payment ----
      // Those refunds are created automatically (settlePayment); an admin
      // only retries one, by its row id (from the admin refund list). No
      // reason is asked for: the reason is fixed (`payment_not_applied`).
      if (body.refundId !== undefined) {
        if (typeof body.refundId !== "string" || !/^refund_[0-9a-f]{64}$/.test(body.refundId)) {
          sendError(res, "VALIDATION_ERROR", "refundId must be a refund id");
          return;
        }
        // Issue #413 (portal design #357): ANY failed refund of this
        // booking may be retried by its id, as stored. The booking's own
        // refund (agent / client cancel, admin) goes through the admin
        // refund path in retry mode, under its stored reason and
        // feeBorneBy; an unapplied payment's (#354) as before.
        const byId = await consultationRefundService.adminRetryRefundById({
          consultationId: req.params.id,
          refundId: body.refundId,
          adminUid: req.userId!,
        });
        if (byId.kind === "booking") {
          await this.sendAdminRefundOutcome(res, byId.outcome);
          return;
        }
        const retry = byId.outcome;
        if (retry.kind === "not_found") {
          sendError(res, "NOT_FOUND", ErrorMessages.NOT_FOUND, 404);
          return;
        }
        if (retry.kind === "already_refunded") {
          sendError(res, "ALREADY_REFUNDED", "This refund is not failed, so there is nothing to retry.", 409);
          return;
        }
        // Issue #354 (Paystack's fee): a HELD refund whose fee Paystack
        // still does not report. Nothing was written; nothing is guessed.
        if (retry.kind === "fee_unknown") {
          sendError(
            res,
            "PAYSTACK_FEE_UNKNOWN",
            "Paystack still reports no processing fee for this payment, so the refund cannot be worked out yet.",
            409
          );
          return;
        }
        if (retry.kind === "fee_not_less_than_amount") {
          sendError(
            res,
            "FEE_NOT_LESS_THAN_AMOUNT",
            "Paystack's processing fee is not less than the amount charged, so there is nothing left to refund.",
            409
          );
          return;
        }
        // Issue #354 fix round: an admin closed it as nothing_to_refund.
        if (retry.kind === "closed") {
          sendError(res, "EXCEPTION_CLOSED", "This payment was closed with nothing to refund, so there is nothing to retry.", 409);
          return;
        }
        if (retry.kind === "paystack_unavailable") {
          sendError(res, "PAYSTACK_ERROR", "Paystack could not be reached. Try again in a moment.", 502);
          return;
        }
        // A held refund started now: send it, tell the client (and a debited agent).
        if (retry.kind === "started") {
          const started = await startUnappliedRefund(retry.written);
          sendSuccess(res, { refund: refundSummary(started), refundId: started.id, retried: true });
          return;
        }
        // Send it to Paystack now (a lookup comes first); a failure leaves it for the retry job.
        let refund = retry.refund;
        try {
          refund = (await consultationRefundService.processRefund(refund.id)) ?? refund;
        } catch (e) {
          console.error(`[consultation] admin retry of ${refund.id} could not be sent yet; the retry job will:`, e);
        }
        sendSuccess(res, { refund: refundSummary(refund), refundId: refund.id, retried: true });
        return;
      }

      const reason = typeof body.reason === "string" ? ADMIN_REFUND_REASONS[body.reason] : undefined;
      if (!reason || !Object.prototype.hasOwnProperty.call(ADMIN_REFUND_REASONS, body.reason as string)) {
        sendError(res, "VALIDATION_ERROR", `reason must be one of: ${Object.keys(ADMIN_REFUND_REASONS).join(", ")}`);
        return;
      }
      if (body.note !== undefined && (typeof body.note !== "string" || body.note.length > MAX_REFUND_NOTE_LENGTH)) {
        sendError(res, "VALIDATION_ERROR", `note must be text of at most ${MAX_REFUND_NOTE_LENGTH} characters`);
        return;
      }
      const note = typeof body.note === "string" && body.note.trim() ? body.note.trim() : undefined;
      if (body.reason === "other" && !note) {
        sendError(res, "VALIDATION_ERROR", "note is required when reason is other");
        return;
      }
      // ---- Issue #390: who carries Paystack's fee on this refund ----
      // goodwill / other: the admin MUST choose ("client" | "agent"), no
      // default. agent_no_show: always the agent; "agent" is accepted, any
      // other value is refused (400) rather than silently ignored.
      let feeBorneBy: PaystackFeeBorneBy;
      if (body.reason === "agent_no_show") {
        if (body.feeBorneBy !== undefined && body.feeBorneBy !== "agent") {
          sendError(res, "VALIDATION_ERROR", "feeBorneBy cannot be set for agent_no_show: the agent always carries Paystack's fee");
          return;
        }
        feeBorneBy = "agent";
      } else {
        if (body.feeBorneBy !== "client" && body.feeBorneBy !== "agent") {
          sendError(res, "VALIDATION_ERROR", "feeBorneBy is required and must be client or agent");
          return;
        }
        feeBorneBy = body.feeBorneBy;
      }

      const outcome = await consultationRefundService.adminRefund({
        consultationId: req.params.id,
        adminUid: req.userId!,
        reason,
        note,
        feeBorneBy,
      });
      await this.sendAdminRefundOutcome(res, outcome);
    } catch (error) {
      console.error("Error refunding consultation:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  /**
   * Answer one admin refund outcome (issue #317 / #390), shared by
   * `POST /consultations/:id/refund` with a reason and (issue #413) with
   * `{ refundId }` naming the booking's own refund row. A new or retried row
   * is sent to Paystack now; a failure leaves it for the retry job.
   * Issue #413 (B): a refund an admin closed with nothing to refund is final:
   * 409 REFUND_CLOSED.
   */
  private async sendAdminRefundOutcome(res: Response, outcome: AdminRefundOutcome): Promise<void> {
    switch (outcome.kind) {
    case "not_found":
      sendError(res, "NOT_FOUND", ErrorMessages.NOT_FOUND, 404);
      return;
    case "nothing_to_refund":
      sendError(res, "NOTHING_TO_REFUND", outcome.message, 409);
      return;
    case "already_refunded":
      sendError(res, "ALREADY_REFUNDED", "This consultation already has a refund.", 409);
      return;
    // ---- Issue #390: Paystack's fee could not be used: nothing written ----
    case "fee_unknown":
      sendError(
        res,
        "PAYSTACK_FEE_UNKNOWN",
        "Paystack still reports no processing fee for this payment, so the refund cannot be worked out yet.",
        409
      );
      return;
    case "fee_not_less_than_amount":
      sendError(
        res,
        "FEE_NOT_LESS_THAN_AMOUNT",
        "Paystack's processing fee is not less than the amount charged, so there is nothing left to refund.",
        409
      );
      return;
    case "paystack_unavailable":
      sendError(res, "PAYSTACK_ERROR", "Paystack could not be reached. Try again in a moment.", 502);
      return;
    case "closed":
      sendError(res, "REFUND_CLOSED", "This refund was closed with nothing to refund, so there is nothing to retry.", 409);
      return;
    case "retried":
    case "created": {
      // Send it to Paystack now; a failure leaves it for the retry job.
      let refund = outcome.refund;
      try {
        refund = (await consultationRefundService.processRefund(refund.id)) ?? refund;
      } catch (e) {
        console.error(`[consultation] admin refund ${refund.id} could not be sent yet; the retry job will:`, e);
      }
      const booking = { ...outcome.booking, refundStatus: refund.status as typeof outcome.booking.refundStatus };
      // (#390) A new refund, or a held one now worked out: both sides told
      // (with the agent's Paystack-fee debit, when one was written).
      if (outcome.kind === "created" || outcome.fromHeld) {
        await consultationRefundService.notifyCreated(refund, booking, outcome.debit);
      }
      if (outcome.kind === "created") {
        sendCreated(res, { refund: refundSummary(refund), refundId: refund.id, consultation: booking }, "Refund started");
        return;
      }
      sendSuccess(res, { refund: refundSummary(refund), refundId: refund.id, retried: true, consultation: booking });
      return;
    }
    }
  }

  /**
   * DELETE /consultations/:id
   *
   * Issue #151: a hard delete is for ADMINS ONLY. It used to need only read
   * access, so either party could remove a booking, even one being paid for.
   * The client and the agent side cancel instead
   * (`PUT /consultations/:id/status { status: "cancelled" }`), which keeps
   * the record. Neither the portal nor the mobile app calls this route.
   *
   *  - not an admin: 403 FORBIDDEN, before the booking is even read (so the
   *    route does not tell a non-admin which ids exist);
   *  - unknown id: 404;
   *  - the booking carries a payment (a `transactionId`, or
   *    `paymentStatus: "paid"` with a non-zero charge; a FREE booking, paid
   *    at $0 with no transaction, does not and can be deleted):
   *    409 BOOKING_HAS_PAYMENT, nothing removed, even for an admin. A
   *    payment landing on a deleted booking could not be recorded at all
   *    (`settlePayment` returns null for a missing booking).
   *
   * A refusal removes nothing and notifies nobody. A delete answers 204 and
   * tells the client the consultation was cancelled, as before.
   */
  async deleteConsultation(
    req: AuthenticatedRequest,
    res: Response
  ): Promise<void> {
    try {
      const userId = req.userId!;
      const { id } = req.params;

      // Admins only. Checked first: no read, no write for anyone else.
      if (req.authz?.role !== ROLES.ADMIN) {
        sendError(res, "FORBIDDEN", ErrorMessages.FORBIDDEN, 403);
        return;
      }

      // The payment check and the delete are one transaction (see the service).
      const outcome = await consultationService.deleteUnpaidConsultation(id);
      if (outcome.kind === "not_found") {
        sendError(res, "NOT_FOUND", ErrorMessages.NOT_FOUND, 404);
        return;
      }
      if (outcome.kind === "has_payment") {
        sendError(
          res,
          "BOOKING_HAS_PAYMENT",
          "This consultation has a payment or an open checkout and cannot be deleted. Cancel it instead.",
          409
        );
        return;
      }
      const existing = outcome.consultation;

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
   *
   * Issue #288: `scheduledTime` is stored as 24-hour `HH:mm` (12-hour
   * `h:mm AM/PM` is converted; anything else is 400). A guest booking is
   * NEVER resumed here (each submit makes its own booking); an unpaid one is
   * closed by the hourly cleanup like any other.
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
      // Issue #288 (add-on from #316): the time is stored as 24-hour `HH:mm`
      // on this path too (the page's time input already sends that; 12-hour
      // `h:mm AM/PM` is converted). Anything else is a 400 before the agency
      // is read, an account is made or a price is locked.
      const normalizedTime = normalizeScheduledTime(scheduledTime);
      if (normalizedTime === null) {
        sendError(res, "VALIDATION_ERROR", BAD_SCHEDULED_TIME, 400);
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
        // Issue #321: a guest typed this email on the public page. Anyone can
        // type anyone's email, so this booking is a relationship with the
        // agency only once it is paid (see `isClientOfAgent`).
        bookedVia: "public_page" as const,
        clientName: clientName.trim(),
        clientEmail: normalizedEmail,
        agentName: agency.ownerName,
        type: consultType,
        scheduledDate: Timestamp.fromDate(new Date(scheduledDate)),
        // #288: always the normalised 24-hour `HH:mm`.
        scheduledTime: normalizedTime,
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
          // (#332) Only the payer-safe charge fields: the dollar price, the
          // amount charged, the effective rate and the lock times. Never
          // the raw rate or the margin (a guest is a client too).
          ...clientChargeFields(charge),
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
   * Answer where a client's own booking stands with its payment, issuing a
   * checkout when one is needed. The ONE implementation behind both
   * `POST /consultations/:id/checkout` (issue #180) and a resumed
   * `POST /consultations` (issue #288), so the two can never disagree. The
   * caller has already checked that the booking is the caller's own.
   *
   *  - Already paid: `requiresPayment: false` with the booking.
   *  - Not `pending_payment`, or a legacy row with no charge snapshot (never
   *    re-priced): 409 BOOKING_NOT_PAYABLE.
   *  - The current checkout (`transactionId`) is asked about at Paystack:
   *     * paid after all: settled here (`settlePayment`), never re-charged;
   *     * in progress: 409 PAYMENT_IN_PROGRESS with the SAME checkout;
   *       nothing written, nothing re-priced;
   *     * otherwise, inside the quote lock with a published URL: the SAME
   *       checkout is handed back (no second charge is opened).
   *  - Lock passed, or no checkout was ever opened: a FRESH quote and a new
   *    checkout (`reissueCheckout`, race-safe). No usable rate: 503. A lost
   *    race answers with the booking's current state (`sendNoCheckout`; 409
   *    CHECKOUT_OPENING carries `data.consultation.id`).
   *
   * Provider failures throw (`PAYSTACK_ERROR: ...`); the calling route's
   * catch answers 502.
   *
   * @param opts.requestedCallbackUrl issue #285: the return URL asked for on
   *   THIS call (`returnTo: "app"`), applied to a NEW checkout only;
   *   undefined keeps the booking's stored one
   * @param opts.shape the body shape of the answer (see PendingCheckoutShape)
   */
  private async answerPendingCheckout(
    res: Response,
    consultation: Consultation,
    opts: { requestedCallbackUrl?: string; shape: PendingCheckoutShape }
  ): Promise<void> {
    const { shape } = opts;
    const id = consultation.id;

    if (consultation.paymentStatus === "paid") {
      this.sendBooking(res, shape, consultation, { requiresPayment: false });
      return;
    }
    // Only a #180-priced pending booking can be (re)charged; a legacy row
    // is never re-priced and a cancelled one is closed.
    if (consultation.status !== "pending_payment" || !hasChargeSnapshot(consultation)) {
      sendError(res, "BOOKING_NOT_PAYABLE", "This booking cannot be paid", 409);
      return;
    }

    // A current checkout: what does Paystack say about it?
    //
    // Issue #181 review round 2 (shared with payment requests): asked
    // whenever the booking carries a reference, not only when a URL was
    // published, so a checkout that opened at Paystack but whose publish
    // never landed is still checked for a payment before it is replaced.
    // A `cons-` reference we claimed that Paystack never opened (initialize
    // failed after the claim) answers `final_unpaid` (lookupCheckoutState)
    // instead of a 502 on every retry; an outage is still 502.
    if (consultation.transactionId) {
      const { state, result } = await lookupCheckoutState(consultation.transactionId);
      // Paid after all: settle it, never re-charge.
      if (state === "paid") {
        const outcome = await settlePayment(id, consultation.transactionId, result!);
        this.sendSettleOutcome(res, outcome, consultation.transactionId, shape === "create" ? "resume" : "retry");
        return;
      }
      // A payment may still land on it: keep it, do not re-price.
      if (state === "in_progress") {
        this.sendPaymentInProgress(res, consultation);
        return;
      }
      // Inside the lock, with a published URL: hand back the same checkout.
      if (consultation.checkoutUrl && !isQuoteExpired(consultation)) {
        this.sendBooking(res, shape, consultation, {
          requiresPayment: true,
          authorizationUrl: consultation.checkoutUrl,
          reference: consultation.transactionId,
        });
        return;
      }
    }

    // Lock passed (or no checkout opened): a fresh quote and a new checkout.
    let state: CheckoutState;
    try {
      state = await reissueCheckout(consultation, {
        fallbackCallbackUrl: this.signedInCallbackUrl(),
        // #285: the app return page when asked for on this call; else
        // (undefined) the booking's stored return URL is kept.
        callbackUrl: opts.requestedCallbackUrl,
      });
    } catch (err) {
      if (!isPricingFailure(err)) throw err;
      this.sendPricingUnavailable(res);
      return;
    }
    if (state.kind === "checkout") {
      this.sendBooking(res, shape, state.consultation, {
        requiresPayment: true,
        authorizationUrl: state.authorizationUrl,
        reference: state.reference,
      });
      return;
    }
    this.sendNoCheckout(res, state, shape);
  }

  /**
   * 200 with a booking and its payment fields, in the asked shape (issue
   * #288, see PendingCheckoutShape):
   *  - "checkout": `{ ...fields, consultation: <payer-safe summary> }`;
   *  - "create": `{ ...<the booking>, ...fields, resumed: true }`, the shape
   *    of a fresh create (which answers 201), so the app handles both alike.
   *    The booking is the caller's own, as on a fresh create, so it is
   *    ALWAYS the client view (issue #332: `toClientConsultation`, no FX
   *    markup and no raw rate). Only the client-initiated flow resumes.
   */
  private sendBooking(
    res: Response,
    shape: PendingCheckoutShape,
    c: Consultation,
    fields: Record<string, unknown>
  ): void {
    if (shape === "create") {
      sendSuccess(res, { ...toClientConsultation(c), ...fields, resumed: true });
      return;
    }
    sendSuccess(res, { ...fields, consultation: bookingSummary(c) });
  }

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

  /**
   * Answer a checkout state that is not a usable checkout (paid, closed, or
   * still opening).
   *
   * Issue #288: EVERY 409 CHECKOUT_OPENING (fresh create, resumed create,
   * `/:id/checkout`, the guest booking) names the booking in
   * `data.consultation` (the payer-safe `bookingSummary`, so
   * `data.consultation.id` is the booking). The app keeps that id and retries
   * through `POST /consultations/:id/checkout` instead of creating again.
   *
   * @param shape how a `paid` state is answered (see PendingCheckoutShape);
   *   only a resumed create passes "create"
   */
  private sendNoCheckout(
    res: Response,
    state: Exclude<CheckoutState, { kind: "checkout" }>,
    shape: PendingCheckoutShape = "checkout"
  ): void {
    switch (state.kind) {
    case "paid":
      this.sendBooking(res, shape, state.consultation, { requiresPayment: false });
      return;
    case "opening":
      // Another request is opening the checkout right now. No checkout to
      // hand out yet, only which booking it is for.
      res.status(409).json({
        success: false,
        error: "CHECKOUT_OPENING",
        message: "Your checkout is being prepared. Please try again in a moment.",
        data: { consultation: bookingSummary(state.consultation) },
      });
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
   * the retry route `{ requiresPayment: false }`, both next to a payer-safe
   * `consultation` summary. Issue #288: `resume` (a resumed
   * `POST /consultations` that found its checkout paid) answers in the create
   * shape: the booking's own fields, `requiresPayment: false`, `resumed: true`.
   */
  private sendSettleOutcome(
    res: Response,
    outcome: SettleOutcome | null,
    reference: string,
    mode: "verify" | "retry" | "resume"
  ): void {
    const ok = (c: Consultation, extra: Record<string, unknown> = {}) =>
      mode === "resume"
        ? this.sendBooking(res, "create", c, { requiresPayment: false, ...extra })
        : sendSuccess(res, {
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
      // Issue #354: that payment is being refunded in full, automatically.
      sendError(res, "BOOKING_NOT_PAYABLE", "This booking is no longer awaiting payment", 409);
      return;
    case "rescheduled_refund_recorded":
      // Issue #354: paid on a checkout retired by a reschedule. The booking
      // is NOT confirmed (still pending_payment); the payment is refunded in
      // full and the client pays again for the new time
      // (POST /consultations/:id/checkout opens a checkout priced now).
      res.status(409).json({
        success: false,
        error: "CONSULTATION_RESCHEDULED",
        // Issue #413 (C): shared copy ("we're refunding ... on its way"),
        // with the guest variant for a public-page booking (emailed pay link).
        message: rescheduledRefundMessage({ guestBooking: outcome.consultation.bookedVia === "public_page" }),
        data: { refundPending: true, consultation: bookingSummary(outcome.consultation) },
      });
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
   * Issue #332: `booking` in the shape THIS caller may receive. The agent
   * side (an agent, owner or admin who is not the booking's own client) gets
   * the full stored document; everyone else, first of all the booking's
   * client, gets the allow-listed client view, which carries no
   * `fxMarginBps` and no raw rate. The rule itself lives in
   * `seesFullConsultation` (consultations/client-consultation.ts). It only
   * picks the shape: each route has already decided the caller may read it.
   */
  private bookingFor(req: AuthenticatedRequest, booking: Consultation) {
    return consultationFor({ uid: req.userId, role: req.authz?.role }, booking);
  }

  /**
   * Where Paystack returns a signed-in payer. The app's pay screen (#183)
   * intercepts this URL and posts the reference to /consultations/public/verify.
   */
  private signedInCallbackUrl(): string {
    return `${EMAIL_BRANDING.appUrl}/consultations/confirm`;
  }

  /**
   * Issue #151: which party of `booking` the caller is, or null when neither.
   *
   *  - AGENT SIDE: the booking's agent (`agentId` is a user uid) WHILE their
   *    current role is `agent` or `owner`, the OWNER whose resolved agency
   *    (`req.authz.agencyId`) is the booking's agency, or an admin. Checked
   *    first: it may do everything a client may.
   *  - CLIENT: the booking's `userId`.
   *
   * An agent of the same agency who is not the booking's own agent is NOT a
   * party (they may read it, not change its status).
   *
   * Issue #321 (former agents): `booking.agentId` is written once and never
   * cleared, so on its own it would keep giving agent-side rights to a user
   * who has since been removed as an agent (their role is back to `client`).
   * The booking's agent is therefore agent side only while the role resolved
   * for THIS request (`req.authz.role`) is `agent` or `owner`. A former agent
   * is no party of their old bookings (403), unless they are also the
   * booking's `userId`, in which case they are its CLIENT and nothing more.
   * Admins and the owner of the booking's agency are unchanged.
   *
   * Used by BOTH `PUT /consultations/:id/status` (#151) and
   * `PUT /consultations/:id` (#316, `decideEdit`), so the two routes always
   * agree on who the agent side is.
   */
  private consultationActor(req: AuthenticatedRequest, booking: Consultation): ConsultationActor | null {
    const uid = req.userId;
    if (!uid) return null;
    const role = req.authz?.role;
    const isAdmin = role === ROLES.ADMIN;
    // #321: named on the booking AND still on the agent side today.
    const isBookingAgent = booking.agentId === uid && (role === ROLES.AGENT || role === ROLES.OWNER);
    // Both sides must NAME an agency: an owner with none must never match a
    // booking that merely has no `agencyId`.
    const isAgencyOwner =
      role === ROLES.OWNER &&
      !!req.authz?.agencyId &&
      !!booking.agencyId &&
      booking.agencyId === req.authz.agencyId;
    if (isAdmin || isBookingAgent || isAgencyOwner) return CONSULTATION_ACTORS.AGENT_SIDE;
    if (booking.userId === uid) return CONSULTATION_ACTORS.CLIENT;
    return null;
  }

  /**
   * Issues #246 and #321: does the calling agent (or their agency) already
   * work with this client? The link must be one the agent could NOT have
   * made alone from a typed email or a uid (#321). True when at least one of
   * these exists:
   *
   *  - an APPLICATION of the client that is assigned to the caller
   *    (`agentId` = the caller's uid) or belongs to the caller's agency;
   *  - a CONVERSATION between the client and the caller that the client
   *    STARTED (`startedBy: "user"`) or has SENT A MESSAGE in (a message with
   *    `senderType: "user"` and `senderId` = the client). An agent can open a
   *    conversation with any uid and write in it, so the agent's own side of
   *    a chat proves nothing. NOTE: on conversations `agentId` is the agent
   *    DOCUMENT id, not a user uid;
   *  - an earlier CONSULTATION of the client with the caller (`agentId` = the
   *    caller's uid) or with the caller's agency, in any status, that the
   *    client BOOKED THEMSELVES while signed in (`bookedVia: "client"`, free
   *    or not) or that was PAID through Paystack (`paymentStatus: "paid"`
   *    with `paidAt`, which only `settlePayment` writes). A guest booking
   *    from the public page and a booking an agent made count only once
   *    paid: both can be made for anyone's email or uid, and a FREE one is
   *    stored `paymentStatus: "paid"` with no `paidAt`, so it never counts.
   *
   * Rows from before #321 have neither `bookedVia` nor `startedBy`: they
   * count only through the paid check or the client-message check (no
   * backfill; nothing had been released to real users).
   *
   * QUERIES. Every relationship query is equality filters with `limit(1)`:
   *  - applications, the `bookedVia` consultations and the `startedBy`
   *    conversations: equality filters only, no composite index;
   *  - the PAID consultations: equality filters plus `orderBy("paidAt")`.
   *    Firestore leaves a document that lacks the ordered field out of the
   *    result, so the `limit(1)` answer is always a booking that really has
   *    `paidAt` (a free booking next to a paid one cannot hide it). This one
   *    needs a composite index: see `firestore.indexes.json` (consultations:
   *    userId, agentId | agencyId, paymentStatus, paidAt);
   *  - the client-message check: the conversations of the pair are read
   *    (bounded, see CONVERSATIONS_CHECKED), then one two-equality `limit(1)`
   *    query on each one's `messages`.
   *
   * None of them reads the client's user document, so the answer is the same
   * for a stranger and for a uid that does not exist.
   *
   * @param agentUid the caller's user uid
   * @param agentDocId the caller's agent document id
   * @param agencyId the caller's RESOLVED agency (`req.authz.agencyId`), if any
   */
  private async isClientOfAgent(
    clientId: string,
    agentUid: string,
    agentDocId: string,
    agencyId: string | undefined
  ): Promise<boolean> {
    /** "Does a doc of this client exist with ALL of these field values?" */
    const exists = async (
      collection: FirebaseFirestore.CollectionReference,
      equals: Record<string, string>
    ): Promise<boolean> => {
      let query = collection.where("userId", "==", clientId);
      for (const [field, value] of Object.entries(equals)) query = query.where(field, "==", value);
      return !(await query.limit(1).get()).empty;
    };

    /**
     * An earlier consultation that counts (#321), with the caller
     * (`agentId`) or the caller's agency (`agencyId`): one the client booked
     * themselves, or one that was paid through Paystack.
     */
    const consultationCounts = async (field: "agentId" | "agencyId", value: string): Promise<boolean> => {
      const [bookedByClient, paid] = await Promise.all([
        exists(collections.consultations, { [field]: value, bookedVia: "client" }),
        // `orderBy("paidAt")` keeps only bookings that HAVE `paidAt` (see the
        // QUERIES note above); the in-memory check below is a second guard.
        collections.consultations
          .where("userId", "==", clientId)
          .where(field, "==", value)
          .where("paymentStatus", "==", "paid")
          .orderBy("paidAt", "desc")
          .limit(1)
          .get()
          .then((snap) => snap.docs.some((d) => !!(d.data() as Consultation).paidAt)),
      ]);
      return bookedByClient || paid;
    };

    /**
     * A conversation with the caller that counts (#321): one the client
     * started, or one the client has sent at least one message in.
     */
    const conversationCounts = async (): Promise<boolean> => {
      if (await exists(collections.conversations, { agentId: agentDocId, startedBy: "user" })) return true;
      // Not client-started (or made before #321): look for a message the
      // CLIENT sent. `senderId` cannot be forged by the agent: the API writes
      // the caller's own uid, and the Firestore rules allow a client-side
      // message only with `senderId == request.auth.uid`.
      const pair = await collections.conversations
        .where("userId", "==", clientId)
        .where("agentId", "==", agentDocId)
        .limit(CONVERSATIONS_CHECKED)
        .get();
      const clientWrote = await Promise.all(
        pair.docs.map(async (conversation) =>
          !(
            await subcollections
              .messages(conversation.id)
              .where("senderType", "==", "user")
              .where("senderId", "==", clientId)
              .limit(1)
              .get()
          ).empty
        )
      );
      return clientWrote.some(Boolean);
    };

    const checks: Promise<boolean>[] = [
      exists(collections.applications, { agentId: agentUid }),
      conversationCounts(),
      consultationCounts("agentId", agentUid),
    ];
    // The agency-wide links apply only to a caller who is in an agency.
    if (agencyId) {
      checks.push(
        exists(collections.applications, { agencyId }),
        consultationCounts("agencyId", agencyId)
      );
    }
    return (await Promise.all(checks)).some(Boolean);
  }

  /**
   * Issue #246: is `applicationId` an application of THIS client with the
   * calling agent or their agency? False for an unknown id, another client's
   * application, or one that belongs to a different agent / agency.
   */
  private async isApplicationOfClientWithAgent(
    applicationId: string,
    clientId: string,
    agentUid: string,
    agencyId: string | undefined
  ): Promise<boolean> {
    const doc = await collections.applications.doc(applicationId).get();
    if (!doc.exists) return false;
    const application = doc.data() as Application;
    if (application.userId !== clientId) return false;
    return application.agentId === agentUid || (!!agencyId && application.agencyId === agencyId);
  }

  /**
   * The caller's agent profile, or null when they have none (a client).
   * `id` is always the agent DOCUMENT id (issue #246 matches conversations
   * on it), taken from the snapshot in case the stored data lacks it.
   */
  private async getAgentForUser(userId: string): Promise<Agent | null> {
    const snapshot = await collections.agents
      .where("userId", "==", userId)
      .limit(1)
      .get();

    if (snapshot.empty) return null;
    const doc = snapshot.docs[0];
    return { ...(doc.data() as Agent), id: doc.id };
  }
}

export const consultationController = new ConsultationController();
