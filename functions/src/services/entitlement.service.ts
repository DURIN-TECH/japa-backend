import { collections, db } from "../utils/firebase";
import { Timestamp, Transaction } from "firebase-admin/firestore";
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
//
// A subscriber with no `entitlements/{id}` record gets the audience's default
// plan saved on their first request (see `resolveMissingEntitlements`). Such a
// record has no subscription behind it, so nothing would ever recompute it:
// it is stamped as a FOLLOWER of the default plan (`resolvedFrom`), and the
// request path keeps it in step with whatever the default plan is NOW (see
// `followDefaultPlan`).

/**
 * How long one instance reuses its answer to "what is this audience's default
 * plan?" (the plan, or the fact that there is none).
 *
 * The request path needs that answer for every client who follows the default
 * plan, on every request. Reading `plans` each time would add a query to every
 * request; with this memo it is one query per audience, per instance, per
 * window. The price is the window itself: an edit to the default plan (or a
 * new default) reaches a given instance at most this long after it is saved.
 * The admin plan endpoints clear the memo on the instance that served them.
 */
const DEFAULT_PLAN_MEMO_TTL_MS = 60_000;

/** Value of `resolvedFrom` on a record saved from the audience's default plan. */
const RESOLVED_FROM_DEFAULT_PLAN = "default_plan";

/**
 * An entitlements record as stored. `resolvedFrom` is present ONLY on a record
 * the lazy path saved from the default plan with no subscription behind it.
 * Every other writer (`assignPlan`, the billing webhook, a plan-edit
 * recompute) replaces the whole document, which drops the stamp.
 */
type StoredEntitlements = Entitlements & { resolvedFrom?: string };

/** One memo entry: the default plan (null = none) and when the answer expires. */
interface DefaultPlanMemoEntry {
  plan: Plan | null;
  until: number;
}

/** gRPC status code Firestore's `create()` rejects with when the doc exists. */
const GRPC_ALREADY_EXISTS = 6;

/** True when `error` is Firestore's "document already exists" rejection. */
function isAlreadyExists(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === GRPC_ALREADY_EXISTS;
}

/** True when the stored record is a follower of the default plan (see above). */
function followsDefaultPlan(stored: Entitlements): boolean {
  return (stored as StoredEntitlements).resolvedFrom === RESOLVED_FROM_DEFAULT_PLAN;
}

/**
 * True when two entitlement sets grant exactly the same thing: same plan, same
 * status, the same features (order ignored) and the same limits. This is what
 * decides whether a follower record is out of date. It compares CONTENT, not a
 * version or timestamp, so it holds however the plan was changed (admin
 * endpoint, seed script, console) and whatever fields that writer set.
 */
function sameGrant(a: Entitlements, b: Entitlements): boolean {
  if (a.planId !== b.planId || a.status !== b.status) return false;
  const featuresA = [...new Set(a.features ?? [])].sort();
  const featuresB = [...new Set(b.features ?? [])].sort();
  if (featuresA.length !== featuresB.length) return false;
  if (featuresA.some((feature, i) => feature !== featuresB[i])) return false;
  const limitsA = (a.limits ?? {}) as Record<string, number | undefined>;
  const limitsB = (b.limits ?? {}) as Record<string, number | undefined>;
  const keys = new Set([...Object.keys(limitsA), ...Object.keys(limitsB)]);
  for (const key of keys) if (limitsA[key] !== limitsB[key]) return false;
  return true;
}

/** Options for `recomputeEntitlements`. */
interface RecomputeOptions {
  /**
   * Request-path modes (issue #311). Both resolve the plan exactly like the
   * normal mode; they differ in how the record is written:
   *  - "create": only ever CREATE the document (subscriber with no record);
   *  - "refresh": replace the document only if it is STILL a follower of the
   *    default plan (follower whose default plan changed).
   * Neither can overwrite a record that was assigned or bought. Use them
   * through `resolveMissingEntitlements` / `followDefaultPlan`.
   */
  lazy?: "create" | "refresh";
}

class EntitlementService {
  /**
   * Per-audience memo of the default plan for the request path (see
   * DEFAULT_PLAN_MEMO_TTL_MS). Instance state, never persisted. Public so the
   * admin plan endpoints and tests can clear it (`clearDefaultPlanMemo`).
   */
  defaultPlanMemo: Partial<Record<SubscriberType, DefaultPlanMemoEntry>> = {};

  /**
   * Default-plan reads in flight, per audience, so that requests arriving
   * together when the memo has just expired share ONE `plans` query instead
   * of each running their own.
   */
  private defaultPlanReads: Partial<Record<SubscriberType, Promise<Plan | null>>> = {};

  /** Transaction runner as a property so a hermetic test can swap in an in-memory one. */
  runTransaction: <T>(fn: (tx: Transaction) => Promise<T>) => Promise<T> = (fn) => db.runTransaction(fn);

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
   *  2. The default plan comes from the short memo (DEFAULT_PLAN_MEMO_TTL_MS),
   *     and when the memo says the audience has NO default plan the call
   *     returns before reading anything. An environment with no default plan
   *     therefore pays no read here at all (one `plans` query per window).
   *
   * A record saved from the default plan is stamped as a follower of it, so
   * later edits to that plan reach it (`followDefaultPlan`).
   *
   * Returns null, and writes nothing, when no plan can be resolved. Errors are
   * NOT swallowed: the caller decides what an outage means (the middleware
   * keeps today's behaviour, entitlements unresolved).
   */
  async resolveMissingEntitlements(
    subscriberType: SubscriberType,
    subscriberId: string
  ): Promise<Entitlements | null> {
    // No default plan for this audience: nothing to put the subscriber on, as
    // before #311. Checked first so this case costs no Firestore read. (A
    // subscriber who has a subscription but no record, which only a failed
    // earlier recompute can leave behind, stays unresolved in such an
    // environment, exactly as before #311.)
    if (!(await this.getDefaultPlanMemoized(subscriberType))) return null;
    return this.recomputeEntitlements(subscriberType, subscriberId, { lazy: "create" });
  }

  /**
   * Keep a FOLLOWER record in step with the audience's default plan (issue
   * #311, review round 2). Called by the sign-in middleware with the record it
   * has just read; returns the entitlements the request should use.
   *
   * Why it exists: a plan edit recomputes the subscribers found through
   * `subscriptions`. A record saved by the lazy path has no subscription, so
   * without this it would stay a copy of the default plan as it was on that
   * person's first request, for ever: a limit added later would not bind, a
   * feature added later would stay locked, and moving `isDefault` to another
   * plan would change nothing for them.
   *
   * How: the record carries `resolvedFrom: "default_plan"`. For such a record
   * the CURRENT default plan (from the memo, so normally no read) is flattened
   * and compared with what is stored. Same grant: return the stored record,
   * nothing else happens. Different (limits or features edited, or another
   * plan is now the default): re-resolve and save, once; the next request
   * compares equal again.
   *
   * What it never does:
   *  - touch a record without the stamp. An assigned or bought plan follows
   *    its own plan through `subscriptions`, exactly as before;
   *  - replace a record that stopped being a follower in the meantime (the
   *    write is a transaction that re-checks the stamp, see
   *    `recomputeEntitlements` "refresh");
   *  - remove a record. If the audience has NO default plan any more, the
   *    stored record is kept as it is: dropping it would un-gate the client.
   *
   * Errors are not swallowed; the middleware falls back to the stored record.
   */
  async followDefaultPlan(
    subscriberType: SubscriberType,
    subscriberId: string,
    stored: Entitlements
  ): Promise<Entitlements> {
    if (!followsDefaultPlan(stored)) return stored;
    const plan = await this.getDefaultPlanMemoized(subscriberType);
    if (!plan) return stored;
    const current = entitlementsFromPlan(plan, subscriberType, subscriberId, "active");
    if (sameGrant(stored, current)) return stored;
    const refreshed = await this.recomputeEntitlements(subscriberType, subscriberId, { lazy: "refresh" });
    return refreshed ?? stored;
  }

  /** Forget the memoized default plans (after a plan was created, edited or deleted). */
  clearDefaultPlanMemo(): void {
    this.defaultPlanMemo = {};
  }

  /**
   * `getDefaultPlan` through the short per-instance memo. Both answers are
   * remembered (a plan, or "none"); a failed read is not (it throws, and the
   * next call tries again). Concurrent callers share one read.
   */
  private async getDefaultPlanMemoized(audience: SubscriberType): Promise<Plan | null> {
    const memo = this.defaultPlanMemo[audience];
    if (memo && Date.now() < memo.until) return memo.plan;

    const inFlight = this.defaultPlanReads[audience];
    if (inFlight) return inFlight;

    const read = this.getDefaultPlan(audience)
      .then((plan) => {
        this.defaultPlanMemo[audience] = { plan, until: Date.now() + DEFAULT_PLAN_MEMO_TTL_MS };
        return plan;
      })
      .finally(() => {
        delete this.defaultPlanReads[audience];
      });
    this.defaultPlanReads[audience] = read;
    return read;
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
   * `options.lazy` (issue #311) selects a request-path mode: the same plan
   * resolution, but a write that cannot replace an assigned or bought record.
   * See `resolveMissingEntitlements` ("create") and `followDefaultPlan`
   * ("refresh"), which are the only callers that pass it.
   */
  async recomputeEntitlements(
    subscriberType: SubscriberType,
    subscriberId: string,
    options: RecomputeOptions = {}
  ): Promise<Entitlements | null> {
    const subscription = await this.getActiveSubscription(subscriberId);
    let plan: Plan | null = null;
    let status: SubscriptionStatus = "active";
    // True when the plan below is the audience default, i.e. the subscriber
    // has no (resolvable) plan of their own.
    let fromDefaultPlan = false;

    if (subscription) {
      plan = await this.getPlan(subscription.planId);
      status = subscription.status;
    }
    if (!plan) {
      // The request-path modes use the memoized default plan (hot path, and
      // the same answer `followDefaultPlan` compared against); the normal
      // mode always reads it fresh.
      plan = options.lazy
        ? await this.getDefaultPlanMemoized(subscriberType)
        : await this.getDefaultPlan(subscriberType);
      status = "active"; // default free plan is always active
      fromDefaultPlan = true;
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

    if (options.lazy) {
      // Request-path write (#311). Stamp the record as a follower of the
      // default plan ONLY when that is where it came from and no subscription
      // exists: a subscriber with a subscription is recomputed through it.
      const lazyRecord: StoredEntitlements & { updatedAt: Timestamp } =
        fromDefaultPlan && !subscription
          ? { ...record, resolvedFrom: RESOLVED_FROM_DEFAULT_PLAN }
          : record;

      if (options.lazy === "create") {
        // Create, never overwrite. Losing the race is not an error: someone
        // else (a parallel first request, or a plan change) has just written
        // the record, and theirs is the one to use.
        try {
          await ref.create(lazyRecord);
        } catch (error) {
          if (!isAlreadyExists(error)) throw error;
          // Fall back to what we computed only if the record vanished again
          // between the failed create and this read (not expected).
          return (await this.getEntitlements(subscriberId)) ?? entitlements;
        }
        return lazyRecord;
      }

      // "refresh": replace the record only if it is STILL a follower of the
      // default plan. Read and write are one transaction, so a plan change
      // (assignment, billing webhook) that lands in between makes Firestore
      // re-run this, the stamp is then gone, and that record is returned
      // untouched. If it lands after, its own `set()` replaces ours. Either
      // way the assigned or bought record wins; the free plan is never put
      // back over it. Parallel refreshes of one record just write the same
      // content one after the other.
      return this.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        if (!snap.exists) {
          // The record was removed meanwhile: start again as a new one.
          tx.create(ref, lazyRecord);
          return lazyRecord;
        }
        const current = snap.data() as Entitlements;
        if (!followsDefaultPlan(current)) return current;
        tx.set(ref, lazyRecord);
        return lazyRecord;
      });
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
