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
import { notificationService } from "../notification.service";
import { StoredPlan } from "../../types/billing";
import { NotificationType } from "../../types";

/**
 * Result of a checkout request that required no payment (a free-plan switch).
 * Distinguished from a `CheckoutSession` by the `applied` flag so the caller
 * knows the plan is already live and there is no URL to redirect to.
 */
export interface AppliedSwitch {
  applied: true;
  planId: string;
  provider: string;
}

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
   *
   * Free plans (priceKobo ≤ 0) are a special case: there is nothing to charge, and
   * Paystack rejects a zero-amount transaction with "Invalid Amount Sent". So a
   * move to a free plan (e.g. downgrading from a paid tier) is applied directly —
   * no checkout redirect — and the caller gets `{ applied: true }` instead of a
   * hosted checkout URL.
   */
  async createCheckout(
    subscriberType: SubscriberType,
    subscriberId: string,
    planId: string,
    email: string
  ): Promise<CheckoutSession | AppliedSwitch> {
    const planDoc = await collections.plans.doc(planId).get();
    if (!planDoc.exists) throw new Error("Plan not found");
    const plan = planDoc.data() as StoredPlan;
    if (plan.audience !== subscriberType) {
      throw new Error(`Plan "${planId}" is for ${plan.audience}, not ${subscriberType}`);
    }

    // ── Free plan: no payment step ────────────────────────────────────────
    // Cancel any active paid subscription at the provider (so recurring billing
    // stops), then apply the free plan + recompute entitlements immediately.
    if (!plan.priceKobo || plan.priceKobo <= 0) {
      await this.cancelExistingProviderSubscription(subscriberId);
      await this.applyEvent({
        type: "updated",
        subscriberType,
        subscriberId,
        planId,
        status: "active",
        currentPeriodEnd: null,
        provider: "manual",
        providerRef: null,
      });
      return { applied: true, planId, provider: "manual" };
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
   * Best-effort cancellation of a subscriber's existing paid subscription at the
   * provider — used when they switch to a free plan so recurring charges stop.
   * Never throws: the local plan switch must succeed even if the remote cancel
   * fails (e.g. already canceled, or no provider ref on record).
   */
  private async cancelExistingProviderSubscription(subscriberId: string): Promise<void> {
    try {
      const snap = await collections.subscriptions.doc(subscriberId).get();
      const sub = snap.data() as Subscription | undefined;
      if (sub?.providerRef && sub.provider === this.provider.name) {
        await this.provider.cancelSubscription(sub.providerRef);
      }
    } catch (e) {
      console.error("[billing] provider cancel on downgrade failed (continuing):", e);
    }
  }

  /**
   * Apply a normalized provider event: upsert the subscription and recompute the
   * entitlement cache so access flips immediately. This is the single place access
   * is granted/revoked — never on a redirect alone.
   */
  async applyEvent(event: NormalizedSubscriptionEvent): Promise<void> {
    const now = Timestamp.now();

    // Renewal date shown in the plan summary. Prefer the provider-supplied date; on an
    // activation/renewal that arrives without one (e.g. the post-redirect verify, which
    // has no next_payment_date), estimate it from the plan's billing interval so a date
    // shows immediately. A later webhook carrying the real next_payment_date overwrites
    // this — we only estimate when the event itself has no date.
    let currentPeriodEnd = event.currentPeriodEnd ?? null;
    if (!currentPeriodEnd && (event.type === "activated" || event.type === "renewed")) {
      const planSnap = await collections.plans.doc(event.planId).get();
      const interval = (planSnap.data() as StoredPlan | undefined)?.interval;
      currentPeriodEnd = this.estimatePeriodEnd(interval, now.toDate());
    }

    const subscription: Subscription = {
      id: event.subscriberId,
      subscriberType: event.subscriberType,
      subscriberId: event.subscriberId,
      planId: event.planId,
      status: event.status,
      currentPeriodEnd,
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

    // Notify the subscriber (best-effort) — activation/renewal receipt, payment
    // failure (action needed), cancellation, or plan change.
    await this.notifySubscriber(event).catch((e) =>
      console.error("[billing] subscriber notification failed:", e)
    );
  }

  /**
   * Estimate the next renewal date by advancing `from` by one billing interval.
   * Returns an ISO string, or null when the plan has no real cadence ("none"/free)
   * or the interval is unknown. Used only as a fallback until the provider webhook
   * supplies the exact next_payment_date.
   */
  private estimatePeriodEnd(
    interval: string | undefined,
    from: Date
  ): string | null {
    const next = new Date(from);
    if (interval === "month") next.setMonth(next.getMonth() + 1);
    else if (interval === "year") next.setFullYear(next.getFullYear() + 1);
    else return null; // "none" / unknown — no renewal date
    return next.toISOString();
  }

  /**
   * Resolve a subscriber to the user who should receive billing emails: the agency
   * OWNER for agency subscriptions; the user themselves for agent/client.
   */
  private async resolveRecipientUserId(
    subscriberType: SubscriberType,
    subscriberId: string
  ): Promise<string | null> {
    if (subscriberType === "agency") {
      const doc = await collections.agencies.doc(subscriberId).get();
      return (doc.data()?.ownerId as string | undefined) ?? null;
    }
    return subscriberId; // agent / client → the user uid is the subscriber id
  }

  /** Map a normalized billing event to a subscriber notification + send it. */
  private async notifySubscriber(event: NormalizedSubscriptionEvent): Promise<void> {
    const map: Partial<
      Record<
        NormalizedSubscriptionEvent["type"],
        { type: NotificationType; title: string; body: (plan: string) => string }
      >
    > = {
      activated: {
        type: "subscription_activated",
        title: "Your subscription is active",
        body: (p) => `Your subscription to ${p} is now active. Enjoy your upgraded features.`,
      },
      renewed: {
        type: "subscription_renewed",
        title: "Your subscription renewed",
        body: (p) => `Your ${p} subscription has renewed for another period.`,
      },
      past_due: {
        type: "subscription_payment_failed",
        title: "Payment failed",
        body: (p) =>
          `We couldn't process your payment for ${p}. Please update your payment method to keep your subscription active.`,
      },
      canceled: {
        type: "subscription_canceled",
        title: "Subscription canceled",
        body: (p) => `Your subscription to ${p} has been canceled. You can resubscribe anytime.`,
      },
      updated: {
        type: "plan_changed",
        title: "Your plan was updated",
        body: (p) => `Your subscription plan is now ${p}.`,
      },
    };
    const entry = map[event.type];
    if (!entry) return;

    const userId = await this.resolveRecipientUserId(event.subscriberType, event.subscriberId);
    if (!userId) return;

    const planDoc = await collections.plans.doc(event.planId).get();
    const planName = (planDoc.data() as StoredPlan | undefined)?.name ?? "your plan";

    await notificationService.notifyUser({
      userId,
      type: entry.type,
      title: entry.title,
      body: entry.body(planName),
      relatedEntityType: "subscription",
      relatedEntityId: event.subscriberId,
    });
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

    // Notify the agency owner that seats were added (best-effort).
    const ownerId = (await collections.agencies.doc(agencyId).get()).data()?.ownerId as
      | string
      | undefined;
    if (ownerId) {
      await notificationService
        .notifyUser({
          userId: ownerId,
          type: "seats_added",
          title: "Agent seats added",
          body: `Your plan now includes ${newTotal} agent seats.`,
          relatedEntityType: "agency",
          relatedEntityId: agencyId,
        })
        .catch((e) => console.error("[billing] seats notification failed:", e));
    }
    return newTotal;
  }
}

export const billingService = new BillingService();
