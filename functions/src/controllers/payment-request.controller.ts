/**
 * Payment Request Controller
 *
 * Handles all HTTP endpoints related to payment requests in the Seli platform.
 * Payment requests are created by agents to request funds from clients for
 * visa application services. Clients can approve (and pay) or reject
 * (triggering a conversation) these requests.
 *
 * Issue #181: the agent asks in US DOLLARS; the client pays the local-currency
 * amount worked out on the server at the rate of the moment the checkout
 * starts (services/payment-request-charge.service.ts). Legacy naira requests
 * (kobo, "NGN", no snapshot) list, display and settle as before.
 *
 * Endpoints:
 *  - GET    /payment-requests             — List payment requests (filtered by role)
 *  - POST   /payment-requests             — Create a new payment request (dollars)
 *  - GET    /payment-requests/:id         — Get a single payment request
 *  - PUT    /payment-requests/:id/status  — Update payment request status
 *  - PUT    /payment-requests/:id/approve — Client approves: quote + checkout
 *  - POST   /payment-requests/:id/checkout — Client resumes / re-issues checkout (#152)
 *  - POST   /payment-requests/:id/verify  — Client returns from Paystack: settle
 *  - PUT    /payment-requests/:id/reject  — Client rejects with reason + auto-chat
 *  - DELETE /payment-requests/:id         — Delete a payment request
 */

import { Response } from "express";
import { AuthenticatedRequest } from "../middleware/auth";
import { paymentRequestService, AGENT_STATUS_TRANSITIONS } from "../services/payment-request.service";
import { messagingService } from "../services/messaging.service";
import { notificationService } from "../services/notification.service";
import { paystackProvider } from "../services/billing/paystack.provider";
import {
  PaymentRequestSettleOutcome,
  settlePaymentRequest,
} from "../services/payment-request-settlement.service";
import {
  describeRequestAmount,
  isUsdPaymentRequest,
  issuePaymentRequestCheckout,
  legacyRequestCharge,
  PaymentRequestCheckoutState,
  priceRequestForClient,
  reissuePaymentRequestCheckout,
  requestChargeSummary,
} from "../services/payment-request-charge.service";
import { isPricingFailure, isQuoteExpired, paystackState } from "../services/charge-checkout.service";
import { EMAIL_BRANDING } from "../services/email/branding";
import { collections } from "../utils/firebase";
import { checkApplicationAccess } from "../utils/access";
import { isPriceInputError, parseUsdPriceInput } from "../money/usd-price";
import { Application, PaymentRequest, PaymentRequestCategory, PaymentRequestStatus } from "../types";
import { ROLES } from "@durin-tech/authz";
import { sendSuccess, sendError, sendNotFound, sendForbidden } from "../utils/response";

/** The categories a payment request may carry (body `category`; default "other"). */
const PAYMENT_REQUEST_CATEGORIES: ReadonlySet<PaymentRequestCategory> = new Set<PaymentRequestCategory>([
  "visa_fee",
  "health_check",
  "document_creation",
  "document_review",
  "translation",
  "government_fee",
  "other",
]);

/** Longest description accepted (it is shown in notifications and emails). */
const MAX_DESCRIPTION_LENGTH = 500;

/**
 * A request as the API returns it: the stored fields plus, for display, the
 * dollar price, the charge (once priced) and a ready-made `amountDisplay`
 * with explicit currency codes ("USD 100.00 (NGN 150,000.00)"), and `legacy`
 * for a pre-#181 naira request. Built from stored values only.
 */
export function presentPaymentRequest(r: PaymentRequest): PaymentRequest & Record<string, unknown> {
  return { ...r, ...requestChargeSummary(r) };
}

/** Where Paystack returns the client after paying a request (unchanged by #181). */
function paymentRequestCallbackUrl(): string {
  return `${EMAIL_BRANDING.appUrl}/client/payments?reference={reference}`;
}

/** True for the provider's classified error (`PAYSTACK_ERROR: ...`). */
function isProviderError(error: unknown): boolean {
  return ((error as Error)?.message || "").startsWith("PAYSTACK_ERROR");
}

/**
 * PaymentRequestController
 *
 * Controller class encapsulating all payment request route handlers.
 * Each method corresponds to a REST endpoint and handles authentication checks,
 * authorization (role-based access), validation, and delegation to services.
 */
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
        // Agency owner role: the owner role AND the agency come from the
        // resolved principal (req.authz, built from custom claims), never from
        // the caller's agent document (issue #135). Anyone who is not an
        // agency owner is refused, as on GET /transactions?role=owner; a
        // member uses the default "agent" view below.
        if (req.authz?.role !== ROLES.OWNER || !req.authz.agencyId) {
          return sendForbidden(res, "Agency owner access required");
        }
        // Return all payment requests for the owner's agency
        requests = await paymentRequestService.getAgencyPaymentRequests(req.authz.agencyId, filters);
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

      // Issue #181: each with its dollar price / charge and an explicit-currency display string.
      return sendSuccess(res, requests.map(presentPaymentRequest));
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Unknown error";
      return sendError(res, "INTERNAL_ERROR", message, 500);
    }
  }

  /**
   * POST /payment-requests
   *
   * Creates a new payment request from an agent to a client, in US DOLLARS
   * (issue #181).
   *
   * Body:
   *   applicationId  string, required
   *   amount         the price in US dollars: "150.00" or 150 (whole cents,
   *                  more than 0, at most the #179 price cap), required
   *   currency       "USD" or absent; anything else is a 400
   *   description    string, required
   *   category       one of PAYMENT_REQUEST_CATEGORIES (default "other")
   *
   * Stored: `priceUsd` ({ amountMinor: cents, currency: "USD" }) mirrored in
   * `amount` (cents) + `currency: "USD"`, with the agent, agency, client and
   * application ids. No rate is read here: the client's local amount is
   * worked out when they start checkout.
   *
   * Access (route middleware first): the "payments.request" entitlement and a
   * compliance-`verified` agency (`requireAgencyVerified`). Here: an agent
   * profile, and `checkApplicationAccess(..., "update")` on the case: the
   * case's assigned agent or its agency's owner. Another agency's agent gets
   * 403 and nothing is written.
   */
  async createPaymentRequest(req: AuthenticatedRequest, res: Response) {
    try {
      const userId = req.user!.uid;
      const { applicationId, amount, currency, description, category } = (req.body ?? {}) as Record<string, unknown>;

      // ---- Validate the body before any lookup ------------------------------
      if (typeof applicationId !== "string" || !applicationId) {
        return sendError(res, "VALIDATION_ERROR", "applicationId is required", 400);
      }
      if (typeof description !== "string" || !description.trim()) {
        return sendError(res, "VALIDATION_ERROR", "description is required", 400);
      }
      if (description.length > MAX_DESCRIPTION_LENGTH) {
        return sendError(res, "VALIDATION_ERROR", `description must be at most ${MAX_DESCRIPTION_LENGTH} characters`, 400);
      }
      if (category !== undefined && !PAYMENT_REQUEST_CATEGORIES.has(category as PaymentRequestCategory)) {
        return sendError(res, "VALIDATION_ERROR", "category is not a known payment request category", 400);
      }
      // The dollar price, read exactly like every other dollar price (#179):
      // whole cents, USD or no currency, at most the cap. `currency` is only
      // passed on when the body sent one, so an absent currency means USD.
      let priceUsd;
      try {
        priceUsd = parseUsdPriceInput(
          { amount, ...(currency !== undefined ? { currency } : {}) },
          "amount"
        );
      } catch (err) {
        if (isPriceInputError(err)) return sendError(res, "VALIDATION_ERROR", err.message, 400);
        throw err;
      }
      if (priceUsd.amountMinor <= 0) {
        return sendError(res, "VALIDATION_ERROR", "amount must be more than 0 US dollars", 400);
      }

      // ---- Who is asking, and may they bill this case? -----------------------
      // Look up the agent profile linked to the authenticated user
      const agentSnap = await collections.agents
        .where("userId", "==", userId)
        .limit(1)
        .get();
      if (agentSnap.empty) {
        return sendForbidden(res, "Agent profile required");
      }
      const agent = agentSnap.docs[0];

      // Fetch the application document to get client info and verify access
      const appDoc = await collections.applications.doc(applicationId).get();
      if (!appDoc.exists) {
        return sendNotFound(res, "Application not found");
      }
      const app = appDoc.data() as Application;

      // The shared application rule (utils/access.ts): asking a client for
      // money changes the case, so "update" (assigned agent, or the owner of
      // the case's agency). Before #181 this compared `app.agentId` (a USER
      // uid) with the agent PROFILE id and `app.agencyId` with the agent's
      // agency, which let an independent agent through on any case with no
      // agency.
      if (!checkApplicationAccess(req.ability, { ...app, id: appDoc.id }, "update")) {
        return sendForbidden(res, "Not authorized for this application");
      }

      // ---- Which agency is billing? -------------------------------------------
      // Issue #181 review fix: the CASE's agency (`app.agencyId`), never the
      // caller's current one. Whose payout and compliance a request is
      // follows the case. Decision: a caller whose current agency is not the
      // case's agency is REFUSED (403), even when still the assigned agent.
      // `requireAgencyVerified` checked the CALLER's agency, so an agent who
      // has moved to agency B would otherwise bill agency A's client without
      // A's compliance ever being checked, or under B. A case with no agency
      // has nobody to bill under (the route already needs a verified
      // agency), so it is refused the same way. Admins bill under the case's
      // agency as they find it.
      const agencyId = app.agencyId || undefined;
      const isAdmin = req.authz?.role === ROLES.ADMIN;
      if (!isAdmin && (!agencyId || agencyId !== req.authz?.agencyId)) {
        return sendForbidden(res, "This case belongs to another agency, so you cannot request payment on it");
      }

      // ---- Store it ----------------------------------------------------------
      const request = await paymentRequestService.createPaymentRequest({
        applicationId,
        agentId: agent.id,
        ...(agencyId ? { agencyId } : {}),
        clientId: app.userId,
        clientName: app.clientName || "",
        clientEmail: app.clientEmail || "",
        priceUsd,
        description: description.trim(),
        category: (category as PaymentRequestCategory | undefined) ?? "other",
      });

      // Tell the CLIENT. The `payment_request` type is configured for full
      // delivery (in-app + email + push) in notification-policy.
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
            `Your agent has requested ${describeRequestAmount(request)} for ${request.description}. ` +
            "You will see the amount in your local currency when you pay. Open Seli to approve or decline it.",
          relatedEntityType: "payment_request",
          relatedEntityId: request.id,
          data: { paymentRequestId: request.id, applicationId },
        });
      } catch (e) {
        console.error("[payment-request] client notify failed:", e);
      }

      return sendSuccess(res, presentPaymentRequest(request), "Payment request created", 201);
    } catch (error: unknown) {
      console.error("[payment-request] create failed:", error);
      return sendError(res, "INTERNAL_ERROR", "Could not create the payment request", 500);
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
        return sendSuccess(res, presentPaymentRequest(request));
      }

      // Check if user is the creating agent or belongs to the same agency
      const agentSnap = await collections.agents
        .where("userId", "==", userId)
        .limit(1)
        .get();
      if (!agentSnap.empty) {
        const agent = agentSnap.docs[0];
        const callerAgencyId = agent.data().agencyId as string | undefined;
        // Issue #181 review fix: every comparison is on a DEFINED owner id.
        // Before, `request.agencyId === agent.agencyId` was
        // `undefined === undefined` for two independent agents, so any
        // independent agent could read any other's request (client name,
        // email, checkout URL, rate snapshot).
        //  1. the agent who created it (profile ids are doc ids: always set);
        if (request.agentId && request.agentId === agent.id) {
          return sendSuccess(res, presentPaymentRequest(request));
        }
        //  2. a member of the agency it is billed under (both ids present);
        if (request.agencyId && callerAgencyId && request.agencyId === callerAgencyId) {
          return sendSuccess(res, presentPaymentRequest(request));
        }
        //  3. the case's current assignee (`Application.agentId` is the
        //     agent's USER uid), e.g. after the case was reassigned.
        if (request.applicationId) {
          const appSnap = await collections.applications.doc(request.applicationId).get();
          const assignee = appSnap.exists ? (appSnap.data() as Application).agentId : undefined;
          if (assignee && assignee === userId) {
            return sendSuccess(res, presentPaymentRequest(request));
          }
        }
      }

      // Check if user is the client on the request
      if (request.clientId === userId) {
        return sendSuccess(res, presentPaymentRequest(request));
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
   * An agent (the one who created the request) or an admin WITHDRAWS a
   * request the client has not paid.
   *
   * Issue #181 review fix. Allowed by hand: `pending -> cancelled` and
   * `approved -> cancelled`, nothing else:
   *  - any other target status is 400 (`paid` is the settlement's,
   *    `approved` / `rejected` are the client's decision, and `pending`
   *    would let a client re-approve and pay a second time);
   *  - an approved request with a checkout: Paystack is asked about the
   *    CURRENT checkout first (the shared `paystackState`). In flight (a
   *    bank transfer or USSD payment still completing) is 409
   *    PAYMENT_IN_PROGRESS and nothing changes. Paid at Paystack: it is
   *    settled here (never cancelled under the client) and the answer is 409
   *    REQUEST_ALREADY_PAID;
   *  - the check and the write then happen in ONE transaction that re-reads
   *    the request (`cancelByAgent`). A settlement that committed meanwhile
   *    wins: 409 REQUEST_ALREADY_PAID, nothing written. A checkout replaced
   *    meanwhile: 409 CHECKOUT_CHANGED (the Paystack check is stale; retry).
   *
   * A payment that still lands on the cancelled checkout later (an
   * `abandoned` checkout can be completed) is caught by the settlement and
   * held for refund in `paymentRequestExceptions`, as for a cancel before.
   *
   * Required body: { status: "cancelled" }
   */
  async updatePaymentRequestStatus(req: AuthenticatedRequest, res: Response) {
    try {
      const { id } = req.params;
      const { status } = (req.body ?? {}) as { status?: unknown };

      if (!status) {
        return sendError(res, "VALIDATION_ERROR", "status is required", 400);
      }
      // ---- Only one target status exists for an agent ------------------------
      if (status === "paid") {
        return sendError(res, "VALIDATION_ERROR", "A payment request is marked paid only when the payment is confirmed", 400);
      }
      if (status !== "cancelled") {
        return sendError(
          res,
          "VALIDATION_ERROR",
          "A payment request can only be cancelled here; the client approves or declines it",
          400
        );
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

      // Cheap early answers from the read (the transaction below re-checks
      // both; these only spare a Paystack call).
      if (request.status === "paid") {
        return sendError(res, "REQUEST_ALREADY_PAID", "A paid payment request cannot be changed", 409);
      }
      if (!(AGENT_STATUS_TRANSITIONS[request.status] ?? []).includes("cancelled")) {
        return sendError(res, "INVALID_STATUS_TRANSITION", `A ${request.status} payment request cannot be cancelled`, 409);
      }

      // ---- Is a payment in flight on the current checkout? -------------------
      // Asked OUTSIDE the transaction (a network call); the transaction then
      // refuses if the checkout changed since (`checkedReference`).
      const checkedReference = request.paystackReference ?? null;
      // (Any request carrying a reference is checked, not only `approved`
      // ones: a pre-fix request may have been moved back to `pending` with
      // its checkout still open.)
      if (checkedReference) {
        const result = await paystackProvider.getTransactionMetadata(checkedReference);
        const state = paystackState(result);
        if (state === "in_progress") return this.sendPaymentInProgress(res, request);
        if (state === "paid") {
          // The client has paid: record it (the settlement checks the exact
          // amount; a mismatch is logged and left for a human), never cancel.
          const outcome = await settlePaymentRequest(id, checkedReference, result!);
          if (outcome && (outcome.kind === "mismatch" || outcome.kind === "not_chargeable" || outcome.kind === "unknown_reference")) {
            console.error(
              `[payment-request] cancel refused: Paystack reports ${checkedReference} paid but it did not settle (${outcome.kind}); needs manual review`
            );
          }
          return sendError(res, "REQUEST_ALREADY_PAID", "The client has already paid this request, so it cannot be cancelled", 409);
        }
      }

      // ---- Check and write in ONE transaction --------------------------------
      const outcome = await paymentRequestService.cancelByAgent(id, checkedReference);
      switch (outcome.kind) {
      case "cancelled":
        return sendSuccess(res, presentPaymentRequest(outcome.request));
      case "not_found":
        return sendNotFound(res, "Payment request not found");
      case "already_paid":
        return sendError(res, "REQUEST_ALREADY_PAID", "A paid payment request cannot be changed", 409);
      case "checkout_changed":
        return sendError(res, "CHECKOUT_CHANGED", "The payment for this request changed just now. Please try again.", 409);
      case "not_allowed":
      default:
        return sendError(
          res,
          "INVALID_STATUS_TRANSITION",
          `A ${outcome.request.status} payment request cannot be cancelled`,
          409
        );
      }
    } catch (error: unknown) {
      if (this.sendIfProviderError(res, error, "payment request cancel")) return;
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
   * Approving is not paying: the escrow-release Transaction, the case's
   * `amountPaid` and "payment received" only happen in the settlement, after
   * Paystack confirms the charge (see verifyPayment and the webhook).
   *
   * Issue #181, a dollar request:
   *  1. QUOTE first: its dollar price in the client's charge currency (from
   *     their stored profile country) at the current rate, locked for
   *     QUOTE_LOCK_MINUTES. No usable rate: 503 PRICING_UNAVAILABLE and the
   *     request stays pending; nothing is written, Paystack is not called.
   *  2. Mark it approved (the client consented to be charged).
   *  3. Open the checkout race-safely under our own reference, storing the
   *     snapshot (`priceUsdCents`, `chargedCurrency`, `chargedAmountMinor`,
   *     `fxRate`, `fxRateAsOf`, `fxRateSource`, `fxMarginBps`) and the lock on
   *     the request in the claim's transaction. Paystack receives exactly
   *     `chargedAmountMinor` in `chargedCurrency`. A Paystack failure is 502;
   *     the request stays approved and POST /:id/checkout opens a new one.
   * A LEGACY request opens a naira checkout for its own stored kobo amount,
   * as before (never quoted).
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

      // ---- Legacy naira request: charge its own stored amount, as before ----
      if (!isUsdPaymentRequest(request)) {
        const legacyCharge = legacyRequestCharge(request);
        if (!legacyCharge) {
          return sendError(res, "REQUEST_NOT_PAYABLE", "This payment request cannot be paid", 409);
        }
        const approved = await this.approveOrNull(id);
        if (!approved) return sendError(res, "VALIDATION_ERROR", "Only pending payment requests can be approved", 400);
        const { authorizationUrl, reference } = await paystackProvider.initializeCharge({
          email: request.clientEmail,
          amount: legacyCharge,
          metadata: { purpose: "payment_request", paymentRequestId: id, applicationId: request.applicationId },
          callbackUrl: paymentRequestCallbackUrl(),
        });
        // Persist the reference so a replayed or mismatched one can't be
        // credited to a different request.
        await collections.paymentRequests.doc(id).update({ paystackReference: reference });
        return sendSuccess(
          res,
          { ...presentPaymentRequest({ ...approved, paystackReference: reference }), authorizationUrl },
          "Payment request approved — continue to payment"
        );
      }

      // ---- (1) Quote BEFORE anything is written ------------------------------
      let charge;
      try {
        charge = await priceRequestForClient(request);
      } catch (err) {
        if (!isPricingFailure(err)) throw err;
        return this.sendPricingUnavailable(res);
      }

      // ---- (2) Approve -------------------------------------------------------
      const approved = await this.approveOrNull(id);
      if (!approved) return sendError(res, "VALIDATION_ERROR", "Only pending payment requests can be approved", 400);

      // ---- (3) Open the checkout, race-safely --------------------------------
      const state = await issuePaymentRequestCheckout({
        request: approved,
        observedReference: approved.paystackReference ?? null,
        charge,
        callbackUrl: paymentRequestCallbackUrl(),
      });
      if (state.kind === "checkout") {
        return sendSuccess(
          res,
          {
            ...presentPaymentRequest(state.paymentRequest),
            paystackReference: state.reference,
            authorizationUrl: state.authorizationUrl,
          },
          "Payment request approved — continue to payment"
        );
      }
      return this.sendNoCheckout(res, state);
    } catch (error: unknown) {
      if (this.sendIfProviderError(res, error, "payment request approve")) return;
      console.error("[payment-request] approve failed:", error);
      return sendError(res, "INTERNAL_ERROR", "Could not start the payment", 500);
    }
  }

  /**
   * POST /payment-requests/:id/checkout  (issue #152, priced by #181)
   *
   * The client resumes payment of an APPROVED, unpaid dollar request (e.g.
   * after losing the checkout page). Same rules as the consultation retry
   * (#180):
   *  - Already paid: `{ requiresPayment: false }` with the request.
   *  - The current checkout was in fact paid: settled here, with the same
   *    checks as verify (reference, exact amount and currency).
   *  - Paystack reports it still in progress (`ongoing`, `pending`,
   *    `processing`, `queued`, anything but `failed`/`abandoned`): 409
   *    PAYMENT_IN_PROGRESS with the SAME checkout; never re-quoted.
   *  - Inside the quote lock with an open checkout: the SAME checkout.
   *  - Lock passed (or no checkout ever opened): a FRESH quote of the same
   *    dollar price, a new lock and a new checkout; the old reference is kept
   *    in `supersededCheckouts`. Decided in a Firestore transaction that only
   *    goes on while the request is unpaid, so a paid request's snapshot is
   *    never overwritten. No usable rate: 503, nothing written.
   * A legacy request, or one that is not `approved`, is 409
   * REQUEST_NOT_PAYABLE (legacy requests are never re-priced).
   *
   * Response 200: `{ requiresPayment, authorizationUrl?, reference?, paymentRequest }`.
   */
  async checkoutPaymentRequest(req: AuthenticatedRequest, res: Response) {
    try {
      const { id } = req.params;
      const request = await paymentRequestService.getPaymentRequestById(id);
      if (!request) return sendNotFound(res, "Payment request not found");

      // Only the client being charged (or an admin) may resume it.
      const isAdmin = req.authz?.role === ROLES.ADMIN;
      if (!isAdmin && request.clientId !== req.user!.uid) {
        return sendForbidden(res, "Only the client or admin can pay this request");
      }
      if (request.status === "paid") {
        return sendSuccess(res, { requiresPayment: false, paymentRequest: presentPaymentRequest(request) });
      }
      if (request.status !== "approved" || !isUsdPaymentRequest(request)) {
        return sendError(res, "REQUEST_NOT_PAYABLE", "This payment request cannot be paid", 409);
      }

      // An opened checkout: what does Paystack say about it?
      if (request.paystackReference && request.checkoutUrl) {
        const result = await paystackProvider.getTransactionMetadata(request.paystackReference);
        const state = paystackState(result);
        // Paid after all: settle it, never re-charge.
        if (state === "paid") {
          const outcome = await settlePaymentRequest(id, request.paystackReference, result!);
          return this.sendSettleOutcome(res, outcome, request.paystackReference, "retry");
        }
        // A payment may still land on it: keep it, do not re-quote.
        if (state === "in_progress") return this.sendPaymentInProgress(res, request);
        // Inside the lock: hand back the same checkout.
        if (!isQuoteExpired(request)) {
          return sendSuccess(res, {
            requiresPayment: true,
            authorizationUrl: request.checkoutUrl,
            reference: request.paystackReference,
            paymentRequest: presentPaymentRequest(request),
          });
        }
      }

      // Lock passed (or no checkout opened): a fresh quote and a new checkout.
      let state: PaymentRequestCheckoutState;
      try {
        state = await reissuePaymentRequestCheckout(request, paymentRequestCallbackUrl());
      } catch (err) {
        if (!isPricingFailure(err)) throw err;
        return this.sendPricingUnavailable(res);
      }
      if (state.kind === "checkout") {
        return sendSuccess(res, {
          requiresPayment: true,
          authorizationUrl: state.authorizationUrl,
          reference: state.reference,
          paymentRequest: presentPaymentRequest(state.paymentRequest),
        });
      }
      return this.sendNoCheckout(res, state);
    } catch (error: unknown) {
      if (this.sendIfProviderError(res, error, "payment request checkout")) return;
      console.error("[payment-request] checkout failed:", error);
      return sendError(res, "INTERNAL_ERROR", "Could not resume the payment", 500);
    }
  }

  /**
   * POST /payment-requests/:id/verify
   * Body: { reference: string }
   *
   * Completes a payment after the client returns from Paystack. This is where a
   * payment request becomes PAID (shared with the Paystack webhook through
   * `settlePaymentRequest`), and the only place the money-side effects happen.
   * Idempotent: a refresh of the return URL, a retry, or a webhook arriving
   * later cannot double-credit.
   *
   * Issue #181 checks, in order:
   *  1. the reference is this request's current checkout or a superseded
   *     one (a legacy request with no stored reference: any reference whose
   *     Paystack metadata names this request, as before), and Paystack's
   *     metadata names this request;
   *  2. PAID at Paystack: settled in ONE Firestore transaction. Paystack's
   *     amount (`requested_amount` when reported) and currency must equal
   *     what THAT checkout asked, else 400 PAYMENT_MISMATCH and nothing is
   *     written (the request is not marked paid). A second payment on an
   *     already-paid request is held for refund (200 `refundPending: true`);
   *  3. not paid, in progress: 409 PAYMENT_IN_PROGRESS, nothing re-quoted;
   *  4. not paid (failed / abandoned) on the current checkout: inside the
   *     lock (or a legacy request) 200 "Payment not completed" with
   *     `paymentStatus`, as before; after the lock a FRESH quote and a new
   *     checkout (409 QUOTE_EXPIRED with the new `authorizationUrl`);
   *  5. not paid on a superseded checkout: 409 CHECKOUT_REPLACED with the
   *     current one.
   */
  async verifyPayment(req: AuthenticatedRequest, res: Response) {
    try {
      const { id } = req.params;
      const { reference } = (req.body ?? {}) as { reference?: unknown };
      const userId = req.user!.uid;

      if (!reference || typeof reference !== "string") {
        return sendError(res, "VALIDATION_ERROR", "reference is required", 400);
      }

      const request = await paymentRequestService.getPaymentRequestById(id);
      if (!request) return sendNotFound(res, "Payment request not found");

      // Only the client being charged (or an admin) may complete it.
      const isAdmin = req.authz?.role === ROLES.ADMIN;
      if (!isAdmin && request.clientId !== userId) {
        return sendForbidden(res, "Only the client or admin can complete this payment");
      }

      // Already settled by this very reference — a refreshed callback URL is harmless.
      if (request.status === "paid" && request.paystackReference === reference) {
        return sendSuccess(res, presentPaymentRequest(request), "Payment already completed");
      }

      // ---- (1) The reference must be one WE issued for THIS request --------
      // Without this a valid reference from any other Paystack transaction
      // could be replayed here to mark a request paid for free.
      const isCurrent = request.paystackReference === reference;
      const isSuperseded = (request.supersededCheckouts ?? []).some((s) => s.reference === reference);
      const legacyUnbound = !request.paystackReference && !isUsdPaymentRequest(request);
      if (!isCurrent && !isSuperseded && !legacyUnbound) {
        return sendError(res, "VALIDATION_ERROR", "This payment reference does not belong to this request", 400);
      }

      const result = await paystackProvider.getTransactionMetadata(reference);
      if (!result) return sendNotFound(res, "Transaction not found");

      // Cross-check the metadata too, for references minted before the field
      // existed or where the update failed.
      const metaRequestId = result.metadata?.paymentRequestId as string | undefined;
      if (result.metadata?.purpose !== "payment_request" || metaRequestId !== id) {
        return sendError(res, "VALIDATION_ERROR", "Reference is not a payment for this request", 400);
      }

      // ---- (2) Paid: settle (every check re-done on the fresh request) ------
      const state = paystackState(result);
      if (state === "paid") {
        const outcome = await settlePaymentRequest(id, reference, result);
        return this.sendSettleOutcome(res, outcome, reference, "verify");
      }

      // Not paid.
      if (request.status === "paid") {
        return sendSuccess(res, presentPaymentRequest(request), "Payment already completed");
      }
      const awaiting = request.status === "approved" || (!isUsdPaymentRequest(request) && request.status === "pending");
      if (!awaiting) {
        return sendError(res, "REQUEST_NOT_PAYABLE", "This payment request is no longer awaiting payment", 409);
      }

      // ---- (3) A payment may still land on this reference -------------------
      if (state === "in_progress") return this.sendPaymentInProgress(res, request);

      // ---- (4) Failed / abandoned on the CURRENT checkout -------------------
      if (isCurrent || legacyUnbound) {
        if (!isUsdPaymentRequest(request) || !isQuoteExpired(request)) {
          // Not paid. Leave the request approved so the client can retry
          // rather than stranding it in a terminal state (as before #181).
          return sendSuccess(
            res,
            { ...presentPaymentRequest(request), paymentStatus: result.status },
            "Payment not completed"
          );
        }
        return this.answerReissue(res, request);
      }

      // ---- (5) Failed / abandoned on a SUPERSEDED checkout -------------------
      if (request.paystackReference && request.checkoutUrl) {
        return this.sendCheckoutConflict(res, "CHECKOUT_REPLACED", "This checkout was replaced by a newer one.", {
          authorizationUrl: request.checkoutUrl,
          reference: request.paystackReference,
          paymentRequest: request,
        });
      }
      // The current checkout never opened (a Paystack outage): issue one.
      return this.answerReissue(res, request);
    } catch (error: unknown) {
      if (this.sendIfProviderError(res, error, "payment request verify")) return;
      console.error("[payment-request] verify failed:", error);
      return sendError(res, "INTERNAL_ERROR", "Could not verify the payment", 500);
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
          // Issue #181: explicit currency codes, never a hard-coded naira sign.
          body: `Your client rejected payment of ${describeRequestAmount(request)} for ${request.description}. Reason: ${reason}`,
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
        return sendSuccess(res, { ...presentPaymentRequest(rejected), conversationId: conversation.id }, "Payment request rejected");
      }

      return sendSuccess(res, presentPaymentRequest(rejected), "Payment request rejected");
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

      // Issue #181 review fix: decided in one transaction (the service).
      // Only a PENDING request that never had a checkout can be deleted. A
      // paid one, or one with a checkout (where a payment may still land),
      // is 409: deleting it would leave a later payment untracked, because
      // the settlement finds no request and records nothing. Cancel instead.
      const outcome = await paymentRequestService.deletePaymentRequest(id);
      switch (outcome.kind) {
      case "deleted":
        return sendSuccess(res, { message: "Payment request deleted" });
      case "not_found":
        return sendNotFound(res, "Payment request not found");
      case "already_paid":
        return sendError(res, "REQUEST_ALREADY_PAID", "A paid payment request cannot be deleted", 409);
      case "checkout_open":
        return sendError(
          res,
          "CHECKOUT_OPEN",
          "The client has started paying this request, so it cannot be deleted. Cancel it instead.",
          409
        );
      case "not_pending":
      default:
        return sendError(res, "REQUEST_NOT_DELETABLE", "Only a pending payment request can be deleted", 409);
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Unknown error";
      return sendError(res, "INTERNAL_ERROR", message, 500);
    }
  }
  // ============================================
  // HELPERS (issue #181: the same answers as the consultation charge path)
  // ============================================

  /**
   * Approve a pending request, or null when it is no longer pending (another
   * approval or a rejection won the race; the service throws then).
   */
  private async approveOrNull(id: string): Promise<PaymentRequest | null> {
    try {
      return await paymentRequestService.approvePaymentRequest(id);
    } catch (err) {
      if ((err as Error)?.message === "Only pending payment requests can be approved") return null;
      throw err;
    }
  }

  /**
   * Re-quote on verify after the lock passed and answer: a checkout (new,
   * or the winner's after a lost race) is 409 QUOTE_EXPIRED with it; a
   * request paid meanwhile is 200; anything else as sendNoCheckout. No usable
   * rate: 503 before any Paystack call.
   */
  private async answerReissue(res: Response, request: PaymentRequest): Promise<void> {
    let state: PaymentRequestCheckoutState;
    try {
      state = await reissuePaymentRequestCheckout(request, paymentRequestCallbackUrl());
    } catch (err) {
      if (!isPricingFailure(err)) throw err;
      return this.sendPricingUnavailable(res);
    }
    if (state.kind === "checkout") {
      return this.sendCheckoutConflict(
        res,
        "QUOTE_EXPIRED",
        "The price quote expired, so it was refreshed. Please pay the new amount.",
        state
      );
    }
    if (state.kind === "paid") {
      return sendSuccess(res, presentPaymentRequest(state.paymentRequest), "Payment already completed");
    }
    return this.sendNoCheckout(res, state);
  }

  /** A 409 that carries a checkout the payer should use instead (QUOTE_EXPIRED, CHECKOUT_REPLACED, PAYMENT_IN_PROGRESS). */
  private sendCheckoutConflict(
    res: Response,
    code: string,
    message: string,
    checkout: { authorizationUrl?: string | null; reference?: string | null; paymentRequest: PaymentRequest }
  ): void {
    res.status(409).json({
      success: false,
      error: code,
      message,
      data: {
        authorizationUrl: checkout.authorizationUrl ?? null,
        reference: checkout.reference ?? null,
        paymentRequest: presentPaymentRequest(checkout.paymentRequest),
      },
    });
  }

  /**
   * 409 PAYMENT_IN_PROGRESS: Paystack reports the current checkout as not
   * final (a bank transfer or USSD payment may still complete on it).
   * Nothing is re-quoted; the current checkout is returned unchanged.
   */
  private sendPaymentInProgress(res: Response, r: PaymentRequest): void {
    this.sendCheckoutConflict(
      res,
      "PAYMENT_IN_PROGRESS",
      "A payment for this request is still being processed. Please wait a few minutes and check again.",
      { authorizationUrl: r.checkoutUrl, reference: r.paystackReference, paymentRequest: r }
    );
  }

  /** Answer a checkout state that is not a usable checkout (paid, closed, or still opening). */
  private sendNoCheckout(res: Response, state: Exclude<PaymentRequestCheckoutState, { kind: "checkout" }>): void {
    switch (state.kind) {
    case "paid":
      sendSuccess(res, { requiresPayment: false, paymentRequest: presentPaymentRequest(state.paymentRequest) });
      return;
    case "opening":
      // Another request is opening the checkout right now.
      sendError(res, "CHECKOUT_OPENING", "Your checkout is being prepared. Please try again in a moment.", 409);
      return;
    case "not_payable":
    default:
      sendError(res, "REQUEST_NOT_PAYABLE", "This payment request cannot be paid", 409);
      return;
    }
  }

  /**
   * Answer the result of settling a successful Paystack payment. `mode`
   * picks the success shape: verify answers the request itself (as before
   * #181), the checkout route `{ requiresPayment: false, paymentRequest }`.
   */
  private sendSettleOutcome(
    res: Response,
    outcome: PaymentRequestSettleOutcome | null,
    reference: string,
    mode: "verify" | "retry"
  ): void {
    const ok = (r: PaymentRequest, message: string, extra: Record<string, unknown> = {}) =>
      mode === "verify"
        ? sendSuccess(res, { ...presentPaymentRequest(r), ...extra }, message)
        : sendSuccess(res, { requiresPayment: false, ...extra, paymentRequest: presentPaymentRequest(r) }, message);
    if (!outcome) return sendNotFound(res, "Payment request not found");
    switch (outcome.kind) {
    case "confirmed":
      return ok(outcome.request, "Payment completed");
    case "already_paid":
      return ok(outcome.request, "Payment already completed");
    case "refund_recorded":
      // The request is paid; this extra payment is held for a refund.
      return ok(outcome.request, "Payment already completed", { refundPending: true });
    case "not_payable_recorded":
      return sendError(res, "REQUEST_NOT_PAYABLE", "This payment request is no longer awaiting payment", 409);
    case "mismatch":
    case "not_chargeable":
      // Never settled, never marked paid; logged for a human.
      console.error(
        `[payment-request] Paystack charge ${reference} does not match what its checkout asked (${outcome.kind}); ` +
          "not settled, needs manual review"
      );
      return sendError(
        res,
        "PAYMENT_MISMATCH",
        "The amount paid does not match this request, so it was not recorded. Please contact support.",
        400
      );
    case "unknown_reference":
    default:
      console.error(
        `[payment-request] Paystack charge ${reference} is paid but is not a checkout of its request; ` +
          "not settled, needs manual review"
      );
      return sendError(res, "VALIDATION_ERROR", "This payment reference does not belong to this request", 400);
    }
  }

  /** 503 PRICING_UNAVAILABLE: no usable rate, or the client's currency cannot be charged (issue #181). */
  private sendPricingUnavailable(res: Response): void {
    sendError(
      res,
      "PRICING_UNAVAILABLE",
      "Paying this request is temporarily unavailable. Please try again later.",
      503
    );
  }

  /** A Paystack failure is the provider's: 502 with a generic body (no provider text). */
  private sendIfProviderError(res: Response, error: unknown, what: string): boolean {
    if (!isProviderError(error)) return false;
    console.error(`Paystack failed for ${what}:`, (error as Error).message);
    sendError(res, "BILLING_PROVIDER_ERROR", "Payment provider is temporarily unavailable. Please try again shortly.", 502);
    return true;
  }

}

/** Singleton instance of PaymentRequestController exported for use in route definitions */
export const paymentRequestController = new PaymentRequestController();
