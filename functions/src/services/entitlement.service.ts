import { collections } from "../utils/firebase";
import { Timestamp } from "firebase-admin/firestore";
import {
  AuthzSubject,
  Entitlements,
  Plan,
  Subscription,
  SubscriberType,
  SubscriptionStatus,
  entitlementsFromPlan,
} from "@durin-tech/authz";

/**
 * Entitlement service — resolves the feature/limit set a principal is entitled to
 * from their subscription's plan, and maintains the denormalized
 * `entitlements/{subscriberId}` cache that enforcement reads.
 *
 * Two layers, deliberately separate:
 *   - RBAC (role/ownership) lives in claims + the CASL ability factory.
 *   - Entitlements (what the plan unlocks) live here, in Firestore.
 */
class EntitlementService {
  /**
   * Resolve which subscriber entity a principal draws entitlements from:
   *   - owner/agent in an agency → the agency's subscription
   *   - independent agent (no agency) → their own
   *   - client → their own
   *   - admin → none (admin bypasses gating)
   */
  resolveSubscriber(
    subject: AuthzSubject
  ): { type: SubscriberType; id: string } | null {
    switch (subject.role) {
    case "admin":
      return null;
    case "owner":
    case "agent":
      return subject.agencyId
        ? { type: "agency", id: subject.agencyId }
        : { type: "agent", id: subject.uid };
    case "client":
      return { type: "client", id: subject.uid };
    default:
      return null;
    }
  }

  /** Read the resolved entitlements cache for a subscriber (null if none). */
  async getEntitlements(subscriberId: string): Promise<Entitlements | null> {
    const doc = await collections.entitlements.doc(subscriberId).get();
    return doc.exists ? (doc.data() as Entitlements) : null;
  }

  /** Convenience: resolve entitlements for a principal (null for admin / none). */
  async getEntitlementsForSubject(
    subject: AuthzSubject
  ): Promise<Entitlements | null> {
    const subscriber = this.resolveSubscriber(subject);
    if (!subscriber) return null;
    const existing = await this.getEntitlements(subscriber.id);
    if (existing) return existing;
    // No cache yet — fall back to the default plan for this audience so brand-new
    // subscribers still get baseline access without a migration step.
    return this.recomputeEntitlements(subscriber.type, subscriber.id);
  }

  async getPlan(planId: string): Promise<Plan | null> {
    const doc = await collections.plans.doc(planId).get();
    return doc.exists ? (doc.data() as Plan) : null;
  }

  /** The free default plan for an audience (used when none is assigned). */
  async getDefaultPlan(audience: SubscriberType): Promise<Plan | null> {
    const snap = await collections.plans
      .where("audience", "==", audience)
      .where("isDefault", "==", true)
      .limit(1)
      .get();
    return snap.empty ? null : (snap.docs[0].data() as Plan);
  }

  async getActiveSubscription(subscriberId: string): Promise<Subscription | null> {
    const doc = await collections.subscriptions.doc(subscriberId).get();
    return doc.exists ? (doc.data() as Subscription) : null;
  }

  /**
   * Recompute and cache the entitlements for a subscriber from their active
   * subscription's plan (falling back to the audience's default free plan).
   * Call this whenever a subscription changes (manual assignment or, later, a
   * billing webhook).
   */
  async recomputeEntitlements(
    subscriberType: SubscriberType,
    subscriberId: string
  ): Promise<Entitlements | null> {
    const subscription = await this.getActiveSubscription(subscriberId);
    let plan: Plan | null = null;
    let status: SubscriptionStatus = "active";

    if (subscription) {
      plan = await this.getPlan(subscription.planId);
      status = subscription.status;
    }
    if (!plan) {
      plan = await this.getDefaultPlan(subscriberType);
      status = "active"; // default free plan is always active
    }
    if (!plan) return null; // no plans seeded yet

    const entitlements = entitlementsFromPlan(plan, subscriberType, subscriberId, status);

    // Seat-based billing for agencies: the owner pays for a number of agent seats.
    // A purchased seat count on the subscription overrides the plan's base
    // `max_agents`, so agents can only be added up to the paid-for seats.
    const paidSeats = (subscription as { paidSeats?: number } | null)?.paidSeats;
    if (subscriberType === "agency" && typeof paidSeats === "number") {
      entitlements.limits = { ...entitlements.limits, max_agents: paidSeats };
    }

    await collections.entitlements.doc(subscriberId).set({
      ...entitlements,
      updatedAt: Timestamp.now(),
    });
    return entitlements;
  }

  /**
   * Seat check for adding agents to an agency. Returns whether another agent can
   * be added given the agency's paid seats (entitlement `max_agents`), and the
   * resolved limit. `currentAgentCount` should exclude the owner.
   */
  async canAddAgent(
    agencyId: string,
    currentAgentCount: number
  ): Promise<{ allowed: boolean; limit: number; used: number }> {
    let entitlements = await this.getEntitlements(agencyId);
    if (!entitlements) {
      entitlements = await this.recomputeEntitlements("agency", agencyId);
    }
    // No entitlements resolvable (no plans seeded) → don't block (RBAC-only rollout).
    if (!entitlements) return { allowed: true, limit: -1, used: currentAgentCount };
    const limit = entitlements.limits.max_agents ?? 0;
    if (limit === -1) return { allowed: true, limit, used: currentAgentCount };
    return { allowed: currentAgentCount < limit, limit, used: currentAgentCount };
  }

  /**
   * Set the number of paid agent seats on an agency's subscription (called after a
   * successful seat purchase, or by an admin) and recompute entitlements.
   */
  async setPaidSeats(agencyId: string, seats: number): Promise<Entitlements | null> {
    await collections.subscriptions.doc(agencyId).set(
      { subscriberType: "agency", subscriberId: agencyId, paidSeats: seats },
      { merge: true }
    );
    return this.recomputeEntitlements("agency", agencyId);
  }

  /**
   * Manually assign a plan to a subscriber (admin path, pre-billing). Upserts the
   * subscription and recomputes the entitlement cache.
   */
  async assignPlan(
    subscriberType: SubscriberType,
    subscriberId: string,
    planId: string
  ): Promise<Entitlements | null> {
    const plan = await this.getPlan(planId);
    if (!plan) throw new Error("Plan not found");
    if (plan.audience !== subscriberType) {
      throw new Error(`Plan "${planId}" is for ${plan.audience}, not ${subscriberType}`);
    }

    const now = Timestamp.now();
    const subscription: Subscription = {
      id: subscriberId,
      subscriberType,
      subscriberId,
      planId,
      status: "active",
      currentPeriodEnd: null,
      provider: "manual",
      providerRef: null,
      updatedAt: now.toDate().toISOString(),
    };
    await collections.subscriptions.doc(subscriberId).set(subscription, { merge: true });
    return this.recomputeEntitlements(subscriberType, subscriberId);
  }
}

export const entitlementService = new EntitlementService();
