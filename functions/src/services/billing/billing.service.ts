import { collections } from "../../utils/firebase";
import { Timestamp } from "firebase-admin/firestore";
import {
  BillingProvider,
  CheckoutSession,
  NormalizedSubscriptionEvent,
  Subscription,
  SubscriberType,
} from "@durin-tech/authz";
import { entitlementService } from "../entitlement.service";
import { paystackProvider } from "./paystack.provider";
import { StoredPlan } from "../../types/billing";

/**
 * Billing service — the bridge between a payment provider and the entitlement
 * layer. Providers are pluggable (default: Paystack); everything downstream only
 * deals with normalized events, so provider details never leak into the rest of
 * the app.
 */
class BillingService {
  private providers: Record<string, BillingProvider> = {
    paystack: paystackProvider,
  };

  /** The currently active billing provider (env-overridable). */
  get provider(): BillingProvider {
    const name = process.env.BILLING_PROVIDER || "paystack";
    const provider = this.providers[name];
    if (!provider) throw new Error(`Unknown billing provider: ${name}`);
    return provider;
  }

  /**
   * Start a checkout for a subscriber + plan. Looks up the plan to get the amount
   * and (optionally) its provider plan code, then delegates to the provider.
   */
  async createCheckout(
    subscriberType: SubscriberType,
    subscriberId: string,
    planId: string,
    email: string
  ): Promise<CheckoutSession> {
    const planDoc = await collections.plans.doc(planId).get();
    if (!planDoc.exists) throw new Error("Plan not found");
    const plan = planDoc.data() as StoredPlan;
    if (plan.audience !== subscriberType) {
      throw new Error(`Plan "${planId}" is for ${plan.audience}, not ${subscriberType}`);
    }

    return this.provider.createCheckout({
      subscriberType,
      subscriberId,
      planId,
      email,
      amountKobo: plan.priceKobo,
      metadata: plan.paystackPlanCode ? { paystackPlanCode: plan.paystackPlanCode } : undefined,
    });
  }

  /**
   * Apply a normalized provider event: upsert the subscription and recompute the
   * entitlement cache so access flips immediately. This is the single place access
   * is granted/revoked — never on a redirect alone.
   */
  async applyEvent(event: NormalizedSubscriptionEvent): Promise<void> {
    const now = Timestamp.now();
    const subscription: Subscription = {
      id: event.subscriberId,
      subscriberType: event.subscriberType,
      subscriberId: event.subscriberId,
      planId: event.planId,
      status: event.status,
      currentPeriodEnd: event.currentPeriodEnd ?? null,
      provider: event.provider,
      providerRef: event.providerRef ?? null,
      updatedAt: now.toDate().toISOString(),
    };
    await collections.subscriptions.doc(event.subscriberId).set(subscription, { merge: true });

    // Audit the raw provider payload.
    await collections.billingEvents.add({
      ...event,
      receivedAt: now,
    });

    await entitlementService.recomputeEntitlements(event.subscriberType, event.subscriberId);
  }

  /** Verify + parse a provider webhook (raw body) and apply it if valid. */
  async handleWebhook(
    headers: Record<string, string | undefined>,
    rawBody: string
  ): Promise<boolean> {
    const event = this.provider.parseWebhook(headers, rawBody);
    if (!event) return false;
    await this.applyEvent(event);
    return true;
  }

  /**
   * Confirm a checkout by reference (post-redirect) and apply it. This is the
   * primary, environment-agnostic way access is granted — it works without a public
   * webhook (essential for local dev), with the webhook serving as a backup.
   *
   * `expectedSubscriberId`, when provided, guards against a caller confirming a
   * reference that belongs to a different subscriber (the metadata's subscriberId
   * was stamped by our own `createCheckout`, so it must match the caller).
   */
  async verifyAndApply(reference: string, expectedSubscriberId?: string): Promise<boolean> {
    const event = await this.provider.verifyTransaction(reference);
    if (!event) return false;
    if (expectedSubscriberId && event.subscriberId !== expectedSubscriberId) return false;
    await this.applyEvent(event);
    return true;
  }

  // ── Agent seats (agency owner pays per seat) ──────────────────────────────

  /**
   * Start a checkout to buy `quantity` additional agent seats. Amount =
   * quantity × the agency plan's `seatPriceKobo`. The new seat total is stamped
   * into the transaction metadata so it can be applied on confirmation.
   */
  async startSeatCheckout(
    agencyId: string,
    email: string,
    quantity: number
  ): Promise<CheckoutSession> {
    if (!Number.isInteger(quantity) || quantity < 1) {
      throw new Error("quantity must be a positive integer");
    }
    const subscription = await entitlementService.getActiveSubscription(agencyId);
    const plan =
      (subscription
        ? ((await collections.plans.doc(subscription.planId).get()).data() as StoredPlan | undefined)
        : undefined) ?? ((await entitlementService.getDefaultPlan("agency")) as StoredPlan | null);
    if (!plan) throw new Error("Plan not found");
    if (!plan.seatPriceKobo || plan.seatPriceKobo <= 0) {
      throw new Error("This plan does not support per-seat purchases");
    }

    const entitlements = await entitlementService.getEntitlements(agencyId);
    const currentSeats = entitlements?.limits.max_agents ?? plan.limits.max_agents ?? 0;
    if (currentSeats === -1) throw new Error("This plan already includes unlimited agents");
    const newTotal = currentSeats + quantity;

    return this.provider.createCheckout({
      subscriberType: "agency",
      subscriberId: agencyId,
      planId: plan.id,
      email,
      amountKobo: quantity * plan.seatPriceKobo,
      metadata: {
        kind: "seats",
        subscriberId: agencyId,
        addSeats: String(quantity),
        newTotal: String(newTotal),
      },
    });
  }

  /**
   * Confirm a seat purchase server-side by verifying the transaction reference with
   * the provider, then set the agency's paid seats. Returns the new seat total or
   * null if the transaction isn't a successful seat purchase for this agency.
   */
  async confirmSeatPurchase(reference: string, agencyId: string): Promise<number | null> {
    const result = await paystackProvider.getTransactionMetadata(reference);
    if (!result || result.status !== "success") return null;
    const meta = result.metadata;
    if (meta.kind !== "seats" || meta.subscriberId !== agencyId) return null;
    const newTotal = Number(meta.newTotal);
    if (!Number.isFinite(newTotal)) return null;
    await entitlementService.setPaidSeats(agencyId, newTotal);
    return newTotal;
  }
}

export const billingService = new BillingService();
