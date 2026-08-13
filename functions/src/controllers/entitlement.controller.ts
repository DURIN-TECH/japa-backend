import { Response, Request } from "express";
import { AuthenticatedRequest } from "../middleware/auth";
import { entitlementService } from "../services/entitlement.service";
import { billingService } from "../services/billing/billing.service";
import { paystackProvider } from "../services/billing/paystack.provider";
import { settlePaymentRequest } from "../services/payment-request-settlement.service";
import { collections } from "../utils/firebase";
import { Timestamp } from "firebase-admin/firestore";
import {
  Plan,
  SubscriberType,
  FEATURE_KEYS,
  LIMIT_KEYS,
  FeatureKey,
  LimitKey,
  PlanInterval,
} from "@durin-tech/authz";
import { StoredPlan } from "../types/billing";
import { sendSuccess, sendError, ErrorMessages } from "../utils/response";

const SUBSCRIBER_TYPES: SubscriberType[] = ["agency", "agent", "client"];
const INTERVALS: PlanInterval[] = ["month", "year", "none"];

/**
 * Validate + normalize an admin plan payload against the shared feature/limit
 * catalog so packages can be freely configured without ever referencing unknown
 * feature keys.
 */
function validatePlanInput(body: Record<string, unknown>): { plan?: Omit<StoredPlan, "id">; error?: string } {
  const { name, audience, priceKobo, interval, features, limits } = body as {
    name?: string;
    audience?: SubscriberType;
    priceKobo?: number;
    interval?: PlanInterval;
    features?: string[];
    limits?: Record<string, number>;
  };

  if (!name || typeof name !== "string") return { error: "name is required" };
  if (!audience || !SUBSCRIBER_TYPES.includes(audience)) {
    return { error: `audience must be one of: ${SUBSCRIBER_TYPES.join(", ")}` };
  }
  if (typeof priceKobo !== "number" || priceKobo < 0) return { error: "priceKobo must be >= 0" };
  if (!interval || !INTERVALS.includes(interval)) {
    return { error: `interval must be one of: ${INTERVALS.join(", ")}` };
  }
  const featureList = Array.isArray(features) ? features : [];
  const badFeature = featureList.find((f) => !(FEATURE_KEYS as readonly string[]).includes(f));
  if (badFeature) return { error: `Unknown feature: ${badFeature}` };

  const limitObj = (limits ?? {}) as Record<string, number>;
  const badLimit = Object.keys(limitObj).find((k) => !(LIMIT_KEYS as readonly string[]).includes(k));
  if (badLimit) return { error: `Unknown limit: ${badLimit}` };

  return {
    plan: {
      name,
      audience,
      priceKobo,
      interval,
      features: featureList as FeatureKey[],
      limits: limitObj as Partial<Record<LimitKey, number>>,
      isDefault: body.isDefault === true,
      isActive: body.isActive !== false,
      description: typeof body.description === "string" ? body.description : undefined,
      paystackPlanCode:
        typeof body.paystackPlanCode === "string" ? body.paystackPlanCode : null,
      seatPriceKobo:
        typeof body.seatPriceKobo === "number" ? body.seatPriceKobo : undefined,
      sortOrder: typeof body.sortOrder === "number" ? body.sortOrder : 0,
      // Pairs monthly/yearly variants of the same tier for the upgrade UI. Optional;
      // omitted (undefined) when the admin leaves it blank so we don't store empties.
      billingGroup:
        typeof body.billingGroup === "string" && body.billingGroup.trim()
          ? body.billingGroup.trim()
          : undefined,
    },
  };
}

export class EntitlementController {
  /**
   * GET /plans?audience=agency|agent|client
   * List available plans (for an upgrade screen). Auth required.
   */
  async listPlans(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { audience } = req.query as { audience?: string };
      // where() must precede orderBy() on a different field — Firestore requires a
      // composite index for this and the index must exist in firestore.indexes.json.
      const query = audience
        ? collections.plans.where("audience", "==", audience).orderBy("priceKobo", "asc")
        : collections.plans.orderBy("priceKobo", "asc");
      const snap = await (query as FirebaseFirestore.Query).get();
      sendSuccess(res, snap.docs.map((d) => d.data() as Plan));
    } catch (error) {
      console.error("Error listing plans:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  /**
   * GET /subscriptions/me
   * The principal's current subscription + resolved entitlements.
   */
  async getMySubscription(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      if (!req.authz) {
        sendError(res, "UNAUTHORIZED", "Not authenticated", 401);
        return;
      }
      const subscriber = entitlementService.resolveSubscriber(req.authz);
      if (!subscriber) {
        // admin — unlimited, no subscription
        sendSuccess(res, { subscription: null, entitlements: null, unlimited: true });
        return;
      }
      const [subscription, entitlements] = await Promise.all([
        entitlementService.getActiveSubscription(subscriber.id),
        entitlementService.getEntitlements(subscriber.id),
      ]);
      sendSuccess(res, { subscriberType: subscriber.type, subscription, entitlements });
    } catch (error) {
      console.error("Error getting subscription:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  /**
   * POST /subscriptions/assign  (admin only)
   * Manually assign a plan to a subscriber (pre-billing). Body:
   * { subscriberType, subscriberId, planId }.
   */
  async assignPlan(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { subscriberType, subscriberId, planId } = req.body as {
        subscriberType?: SubscriberType;
        subscriberId?: string;
        planId?: string;
      };
      if (!subscriberType || !SUBSCRIBER_TYPES.includes(subscriberType) || !subscriberId || !planId) {
        sendError(
          res,
          "VALIDATION_ERROR",
          "subscriberType (agency|agent|client), subscriberId and planId are required",
          400
        );
        return;
      }
      const entitlements = await entitlementService.assignPlan(subscriberType, subscriberId, planId);
      sendSuccess(res, { entitlements }, "Plan assigned");
    } catch (error) {
      const message = (error as Error).message;
      if (message === "Plan not found" || message.startsWith("Plan ")) {
        sendError(res, "VALIDATION_ERROR", message, 400);
        return;
      }
      console.error("Error assigning plan:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  // ── Admin: configurable package (plan) management ─────────────────────────

  /** GET /admin/plans — list ALL plans (incl. inactive, every audience). */
  async listAllPlans(_req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const snap = await collections.plans.get();
      const plans = snap.docs
        .map((d) => d.data() as StoredPlan)
        .sort((a, b) =>
          a.audience === b.audience
            ? (a.sortOrder ?? 0) - (b.sortOrder ?? 0)
            : a.audience.localeCompare(b.audience)
        );
      sendSuccess(res, plans);
    } catch (error) {
      console.error("Error listing all plans:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  /** POST /admin/plans — create a package. Body: full plan config. */
  async createPlan(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { plan, error } = validatePlanInput(req.body);
      if (error || !plan) {
        sendError(res, "VALIDATION_ERROR", error || "Invalid plan", 400);
        return;
      }
      const id = (req.body.id as string)?.trim() || collections.plans.doc().id;
      const now = Timestamp.now().toDate().toISOString();
      const stored: StoredPlan = { id, ...plan, createdAt: now, updatedAt: now };
      await collections.plans.doc(id).set(stored);
      sendSuccess(res, stored, "Plan created");
    } catch (error) {
      console.error("Error creating plan:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  /** PUT /admin/plans/:id — update a package + recompute affected entitlements. */
  async updatePlan(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const ref = collections.plans.doc(id);
      if (!(await ref.get()).exists) {
        sendError(res, "NOT_FOUND", "Plan not found", 404);
        return;
      }
      const { plan, error } = validatePlanInput(req.body);
      if (error || !plan) {
        sendError(res, "VALIDATION_ERROR", error || "Invalid plan", 400);
        return;
      }
      const updated: StoredPlan = {
        id,
        ...plan,
        updatedAt: Timestamp.now().toDate().toISOString(),
      };
      await ref.set(updated, { merge: true });

      // Re-resolve entitlements for everyone currently on this plan so edits apply.
      const subs = await collections.subscriptions.where("planId", "==", id).get();
      await Promise.all(
        subs.docs.map((d) => {
          const sub = d.data();
          return entitlementService.recomputeEntitlements(sub.subscriberType, sub.subscriberId);
        })
      );
      sendSuccess(res, updated, "Plan updated");
    } catch (error) {
      console.error("Error updating plan:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  /** DELETE /admin/plans/:id — remove a package (blocked if in use). */
  async deletePlan(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const inUse = await collections.subscriptions.where("planId", "==", id).limit(1).get();
      if (!inUse.empty) {
        sendError(res, "CONFLICT", "Plan is in use by active subscriptions", 409);
        return;
      }
      await collections.plans.doc(id).delete();
      sendSuccess(res, { id }, "Plan deleted");
    } catch (error) {
      console.error("Error deleting plan:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  // ── Checkout + webhook (Paystack) ─────────────────────────────────────────

  /**
   * POST /subscriptions/checkout — start a subscription purchase. Owners/agents/
   * clients buy for their own subscriber entity; the resolved checkout URL is
   * returned for redirect (web) / linking (app-to-web on mobile).
   */
  async createCheckout(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      if (!req.authz) {
        sendError(res, "UNAUTHORIZED", "Not authenticated", 401);
        return;
      }
      const { planId } = req.body as { planId?: string };
      if (!planId) {
        sendError(res, "VALIDATION_ERROR", "planId is required", 400);
        return;
      }
      const subscriber = entitlementService.resolveSubscriber(req.authz);
      if (!subscriber) {
        sendError(res, "VALIDATION_ERROR", "Admins do not subscribe", 400);
        return;
      }
      const email = req.user?.email;
      if (!email) {
        sendError(res, "VALIDATION_ERROR", "A billing email is required", 400);
        return;
      }
      const session = await billingService.createCheckout(
        subscriber.type,
        subscriber.id,
        planId,
        email
      );
      // A free-plan switch is applied immediately (no redirect); a paid plan
      // returns a hosted checkout URL to send the user to.
      const applied = (session as { applied?: boolean }).applied === true;
      sendSuccess(res, session, applied ? "Plan changed" : "Checkout started");
    } catch (error) {
      const message = (error as Error).message;
      // Client-fixable problems (missing/invalid plan) → 400.
      if (message === "Plan not found" || message.startsWith("Plan ")) {
        sendError(res, "VALIDATION_ERROR", message, 400);
        return;
      }
      // Upstream billing-provider failure (bad/misconfigured key, Paystack down,
      // charge rejected). The full provider detail goes to logs; the client gets a
      // safe message + 502 (Bad Gateway) rather than a misleading 400 or naked 500.
      if (message.startsWith("PAYSTACK_ERROR") || message.includes("PAYSTACK")) {
        console.error("Paystack checkout failed:", message);
        sendError(
          res,
          "BILLING_PROVIDER_ERROR",
          "Payment provider is temporarily unavailable. Please try again shortly.",
          502
        );
        return;
      }
      console.error("Error creating checkout:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  /**
   * POST /subscriptions/verify — confirm a subscription checkout after Paystack
   * redirects back. Body: { reference }. Verifies the transaction with the provider
   * and applies it (upserts subscription + recomputes entitlements). This is what
   * flips the plan locally where webhooks can't reach; in prod the webhook also
   * applies it (both are idempotent).
   */
  async verifyCheckout(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      if (!req.authz) {
        sendError(res, "UNAUTHORIZED", "Not authenticated", 401);
        return;
      }
      const reference = (req.body as { reference?: string }).reference;
      if (!reference) {
        sendError(res, "VALIDATION_ERROR", "reference is required", 400);
        return;
      }
      const subscriber = entitlementService.resolveSubscriber(req.authz);
      if (!subscriber) {
        sendError(res, "VALIDATION_ERROR", "Admins do not subscribe", 400);
        return;
      }
      // Guard: the reference's metadata subscriberId must match the caller's.
      const ok = await billingService.verifyAndApply(reference, subscriber.id);
      if (!ok) {
        sendError(res, "VALIDATION_ERROR", "Could not verify payment", 400);
        return;
      }
      sendSuccess(res, { verified: true }, "Subscription updated");
    } catch (error) {
      console.error("Error verifying checkout:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  // ── Agent seats (agency owner pays per seat) ──────────────────────────────

  /** POST /subscriptions/seats/checkout — owner buys N agent seats. Body: { quantity }. */
  async startSeatCheckout(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      if (!req.authz) {
        sendError(res, "UNAUTHORIZED", "Not authenticated", 401);
        return;
      }
      const isAdmin = req.authz.role === "admin";
      if (req.authz.role !== "owner" && !isAdmin) {
        sendError(res, "FORBIDDEN", "Only agency owners can purchase agent seats", 403);
        return;
      }
      const agencyId = (isAdmin && (req.body.agencyId as string)) || req.authz.agencyId;
      const email = req.user?.email;
      const quantity = Number(req.body.quantity);
      if (!agencyId) {
        sendError(res, "VALIDATION_ERROR", "No agency to buy seats for", 400);
        return;
      }
      if (!email) {
        sendError(res, "VALIDATION_ERROR", "A billing email is required", 400);
        return;
      }
      const result = await billingService.startSeatCheckout(agencyId, email, quantity);
      // Two shapes: seats charged inline against the saved card ({ applied: true, ... }),
      // or a hosted checkout to redirect to ({ url } fallback when we hold no card yet).
      const applied = (result as { applied?: boolean }).applied === true;
      sendSuccess(res, result, applied ? "Seats added" : "Seat checkout started");
    } catch (error) {
      const message = (error as Error).message;
      if (
        message.includes("quantity") ||
        message.includes("seat") ||
        message === "Plan not found" ||
        message.includes("PAYSTACK")
      ) {
        sendError(res, "VALIDATION_ERROR", message, 400);
        return;
      }
      console.error("Error starting seat checkout:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  /** POST /subscriptions/seats/confirm — confirm a seat purchase. Body: { reference }. */
  async confirmSeats(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      if (!req.authz) {
        sendError(res, "UNAUTHORIZED", "Not authenticated", 401);
        return;
      }
      const isAdmin = req.authz.role === "admin";
      const agencyId = (isAdmin && (req.body.agencyId as string)) || req.authz.agencyId;
      const reference = req.body.reference as string;
      if (!agencyId || !reference) {
        sendError(res, "VALIDATION_ERROR", "agencyId and reference are required", 400);
        return;
      }
      const seats = await billingService.confirmSeatPurchase(reference, agencyId);
      if (seats === null) {
        sendError(res, "VALIDATION_ERROR", "Could not verify seat purchase", 400);
        return;
      }
      sendSuccess(res, { seats }, "Seats added");
    } catch (error) {
      console.error("Error confirming seats:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  /** POST /subscriptions/seats — admin sets an agency's paid seats directly. */
  async setSeats(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { agencyId, seats } = req.body as { agencyId?: string; seats?: number };
      if (!agencyId || typeof seats !== "number" || seats < 0) {
        sendError(res, "VALIDATION_ERROR", "agencyId and a non-negative seats count are required", 400);
        return;
      }
      const entitlements = await entitlementService.setPaidSeats(agencyId, seats);
      sendSuccess(res, { entitlements }, "Seats updated");
    } catch (error) {
      console.error("Error setting seats:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  /**
   * POST /webhooks/paystack — provider webhook. Mounted with a RAW body parser so
   * the HMAC signature can be verified. Always 200s quickly (provider retries on
   * non-2xx) while only applying verified events.
   */

  /**
   * Settle a payment request from a (already signature-verified) webhook body.
   *
   * Returns true when this event was a payment-request charge we handled, so the
   * caller can skip the subscription path. Returns false for anything else —
   * including a payment-request charge that wasn't successful, which we ignore
   * rather than acting on.
   *
   * Never throws: a webhook must always be answered 200 or Paystack will retry
   * indefinitely, and a retry storm is worse than a missed settlement we can
   * repair from logs.
   */
  private async settlePaymentRequestFromWebhook(rawBody: string): Promise<boolean> {
    try {
      const body = JSON.parse(rawBody) as {
        event?: string;
        data?: {
          reference?: string;
          status?: string;
          metadata?: Record<string, unknown>;
        };
      };

      if (body.event !== "charge.success") return false;

      const metadata = body.data?.metadata ?? {};
      if (metadata.purpose !== "payment_request") return false;

      const paymentRequestId = metadata.paymentRequestId as string | undefined;
      const reference = body.data?.reference;
      if (!paymentRequestId || !reference) {
        console.error(
          "[webhook] payment_request charge missing paymentRequestId/reference:",
          { paymentRequestId, reference }
        );
        // Ours by purpose, but unusable — claim it so we don't hand a malformed
        // payment-request event to the subscription path.
        return true;
      }

      // Paystack sends charge.success only for successful charges, but the
      // status is checked anyway rather than trusting the event name alone.
      if (body.data?.status && body.data.status !== "success") return false;

      const outcome = await settlePaymentRequest(paymentRequestId, reference);
      if (outcome.alreadySettled) {
        // Expected whenever the client DID return — verify-on-return got there
        // first. Not an error.
        console.log(
          `[webhook] payment request ${paymentRequestId} already settled; ignoring.`
        );
      } else if (!outcome.request) {
        console.error(
          `[webhook] payment request ${paymentRequestId} not found for reference ${reference}.`
        );
      }
      return true;
    } catch (error) {
      console.error("[webhook] payment-request settlement failed:", error);
      // Claimed: a malformed payment-request event must not fall through to the
      // subscription handler.
      return true;
    }
  }

  async handlePaystackWebhook(req: Request, res: Response): Promise<void> {
    try {
      const raw = Buffer.isBuffer(req.body) ? req.body.toString("utf8") : JSON.stringify(req.body);
      const headers = req.headers as Record<string, string | undefined>;

      // ── Payment requests ────────────────────────────────────────────────
      // Handled BEFORE the subscription path because both arrive as
      // `charge.success` and only the metadata tells them apart.
      //
      // This is the fallback for a client who paid but never returned to the
      // site — closed the tab, lost signal, killed the browser. Without it the
      // charge succeeds at Paystack and the request sits "approved" forever
      // while the client believes (correctly) that they have paid.
      //
      // Signature is verified explicitly: `parseWebhook` returns null both for a
      // forged payload AND for a valid non-subscription charge, so its null
      // cannot be treated as "unauthentic" here.
      if (paystackProvider.verifyWebhookSignature(headers, raw)) {
        const settled = await this.settlePaymentRequestFromWebhook(raw);
        if (settled) {
          res.status(200).json({ received: true, applied: true });
          return;
        }
      }

      const applied = await billingService.handleWebhook(headers, raw);
      res.status(200).json({ received: true, applied });
    } catch (error) {
      console.error("Error handling Paystack webhook:", error);
      // Still 200 so the provider doesn't hammer retries on our internal errors.
      res.status(200).json({ received: true, applied: false });
    }
  }
}

export const entitlementController = new EntitlementController();
