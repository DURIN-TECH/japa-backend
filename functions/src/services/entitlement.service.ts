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
// ============================================
// Lazy default plan (issue #311)
// ============================================

/**
 * How long one instance remembers that an audience has NO default plan.
 *
 * The lazy first-request path (`resolveMissingEntitlements`) runs for every
 * request of a subscriber with no record. In an environment where no default
 * plan is seeded nothing can ever be written, so without this memo each of
 * those requests would repeat the `plans` query for the same empty answer.
 * Short on purpose: once a default plan is seeded, every instance picks it up
 * within this window with no redeploy.
 */
const MISSING_DEFAULT_PLAN_TTL_MS = 60_000;

/** gRPC status code Firestore's `create()` rejects with when the doc exists. */
const GRPC_ALREADY_EXISTS = 6;

/** True when `error` is Firestore's "document already exists" rejection. */
function isAlreadyExists(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === GRPC_ALREADY_EXISTS;
}

/** Options for `recomputeEntitlements`. */
interface RecomputeOptions {
  /**
   * Lazy mode (issue #311): only ever CREATE the cache document, never
   * overwrite one. Used on the request path for a subscriber with no record.
   * See `resolveMissingEntitlements` for why an overwrite would be wrong there.
   */
  createOnly?: boolean;
}

class EntitlementService {
  /**
   * Per-audience "no default plan until <epoch ms>" memo for the lazy path
   * (see MISSING_DEFAULT_PLAN_TTL_MS). Instance state, never persisted.
   * Public so a test can clear it between cases.
   */
  missingDefaultPlanUntil: Partial<Record<SubscriberType, number>> = {};

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

  /**
   * Lazy first-request resolution (issue #311): give a subscriber who has NO
   * `entitlements/{id}` record the entitlements of their plan (in practice the
   * audience's default free plan) and save them, so every later request finds
   * the stored record with a single read.
   *
   * The caller (the sign-in middleware) has ALREADY read the cache and found
   * nothing; this does not read it again. It differs from a plain
   * `recomputeEntitlements` in two ways, both about running on the hot path:
   *
   *  1. The write is create-only. Two first requests can arrive together, and
   *     a plan change (admin assignment, billing webhook) can land between
   *     this call's reads and its write. A plain `set()` here could then put
   *     the free plan back OVER a paid record that was written a moment
   *     earlier. With `create()` exactly one writer wins; everyone else gets
   *     "already exists" and returns the stored record instead. So concurrent
   *     first requests all succeed and leave one document, and this path can
   *     never downgrade or otherwise replace an existing record.
   *  2. "This audience has no default plan" is remembered for a short time
   *     (MISSING_DEFAULT_PLAN_TTL_MS), so an environment with no default plan
   *     does not re-run the `plans` query on every request.
   *
   * Returns null, and writes nothing, when no plan can be resolved (no
   * subscription plan and no default plan). Errors are NOT swallowed: the
   * caller decides what an outage means (the middleware keeps today's
   * behaviour, entitlements unresolved).
   */
  async resolveMissingEntitlements(
    subscriberType: SubscriberType,
    subscriberId: string
  ): Promise<Entitlements | null> {
    return this.recomputeEntitlements(subscriberType, subscriberId, { createOnly: true });
  }

  /**
   * `getDefaultPlan` for the lazy path, with the short negative memo. Only a
   * MISSING plan is remembered: a plan that exists is read fresh every time
   * (that read happens once per subscriber, since the record is then saved),
   * and a failed read is not remembered at all (it throws).
   */
  private async getDefaultPlanForLazyPath(audience: SubscriberType): Promise<Plan | null> {
    const until = this.missingDefaultPlanUntil[audience];
    if (until !== undefined && Date.now() < until) return null;
    const plan = await this.getDefaultPlan(audience);
    if (plan) delete this.missingDefaultPlanUntil[audience];
    else this.missingDefaultPlanUntil[audience] = Date.now() + MISSING_DEFAULT_PLAN_TTL_MS;
    return plan;
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
   *
   * `options.createOnly` (issue #311) is the lazy request-path mode: the same
   * plan resolution, but the cache document is only created, never replaced,
   * and when it turns out to exist already the STORED record is returned. Use
   * it through `resolveMissingEntitlements`, which explains why.
   */
  async recomputeEntitlements(
    subscriberType: SubscriberType,
    subscriberId: string,
    options: RecomputeOptions = {}
  ): Promise<Entitlements | null> {
    const subscription = await this.getActiveSubscription(subscriberId);
    let plan: Plan | null = null;
    let status: SubscriptionStatus = "active";

    if (subscription) {
      plan = await this.getPlan(subscription.planId);
      status = subscription.status;
    }
    if (!plan) {
      // Lazy mode remembers a missing default plan briefly (hot path); the
      // normal mode always reads it fresh.
      plan = options.createOnly
        ? await this.getDefaultPlanForLazyPath(subscriberType)
        : await this.getDefaultPlan(subscriberType);
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

    const ref = collections.entitlements.doc(subscriberId);
    const record = { ...entitlements, updatedAt: Timestamp.now() };

    if (options.createOnly) {
      // Lazy mode (#311): create, never overwrite. Losing the race is not an
      // error: someone else (a parallel first request, or a plan change) has
      // just written the record, and theirs is the one to use.
      try {
        await ref.create(record);
      } catch (error) {
        if (!isAlreadyExists(error)) throw error;
        // Fall back to what we computed only if the record vanished again
        // between the failed create and this read (not expected).
        return (await this.getEntitlements(subscriberId)) ?? entitlements;
      }
      return entitlements;
    }

    await ref.set(record);
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
