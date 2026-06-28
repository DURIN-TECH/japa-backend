/**
 * Core authorization types shared across backend, portal, and mobile.
 */
import { FeatureKey, LimitKey } from "./catalog";
/** The four user types. `client` is mobile-only; the others are portal/admin. */
export type Role = "admin" | "owner" | "agent" | "client";
/**
 * Named role constants. **Always reference roles through this object** (e.g.
 * `ROLES.OWNER`) instead of hardcoding `"owner"` so role names live in one place.
 */
export declare const ROLES: {
    readonly ADMIN: "admin";
    readonly OWNER: "owner";
    readonly AGENT: "agent";
    readonly CLIENT: "client";
};
/** Roles that operate the portal / act on the agency side (not clients). */
export declare const AGENT_SIDE_ROLES: Role[];
/** Roles that can hold/manage a subscription directly (admins are unlimited). */
export declare const SUBSCRIBER_ROLES: Role[];
/** Entities that can hold a subscription/plan. */
export type SubscriberType = "agency" | "agent" | "client";
/**
 * CASL subject (resource) types that abilities are defined over. `"all"` is the
 * CASL wildcard used for admin.
 */
export type SubjectType = "Application" | "Document" | "Consultation" | "PaymentRequest" | "Transaction" | "Note" | "Conversation" | "Agency" | "Agent" | "User" | "Analytics" | "Plan" | "Subscription" | "all";
/** CASL actions. Kept as a string union plus open `string` for forward-compat. */
export type Action = "manage" | "create" | "read" | "update" | "delete" | "assign" | "approve" | (string & {});
/**
 * The authenticated principal that abilities are built from. Derived entirely
 * from the Firebase custom claims (`role`, `agencyId`) plus the uid — no DB read
 * required to construct it.
 */
export interface AuthzSubject {
    uid: string;
    role: Role;
    /** Present for owner/agent who belong to an agency. */
    agencyId?: string | null;
    /** Optional agent document id (distinct from uid). */
    agentDocId?: string | null;
}
export type PlanInterval = "month" | "year" | "none";
export type SubscriptionStatus = "active" | "trialing" | "past_due" | "canceled" | "inactive";
/** Statuses that grant access to a plan's features. */
export declare const ACTIVE_SUBSCRIPTION_STATUSES: SubscriptionStatus[];
/** A plan definition (config; stored in the `plans` collection). */
export interface Plan {
    id: string;
    name: string;
    audience: SubscriberType;
    priceKobo: number;
    interval: PlanInterval;
    features: FeatureKey[];
    limits: Partial<Record<LimitKey, number>>;
    /** The free default plan for its audience (assigned when none is chosen). */
    isDefault?: boolean;
}
/** A subscriber's subscription record (`subscriptions` collection). */
export interface Subscription {
    id: string;
    subscriberType: SubscriberType;
    subscriberId: string;
    planId: string;
    status: SubscriptionStatus;
    currentPeriodEnd?: string | null;
    provider?: string;
    providerRef?: string | null;
    createdAt?: string;
    updatedAt?: string;
}
/**
 * Resolved entitlements — the flattened feature/limit set derived from the active
 * plan (`entitlements/{subscriberId}` cache). This is what enforcement reads.
 */
export interface Entitlements {
    subscriberType: SubscriberType;
    subscriberId: string;
    planId: string;
    status: SubscriptionStatus;
    features: FeatureKey[];
    limits: Partial<Record<LimitKey, number>>;
}
/** True if the entitlements are in an access-granting state and include `key`. */
export declare function hasFeature(entitlements: Entitlements | null | undefined, key: FeatureKey): boolean;
/** The numeric limit for `key` (0 if absent, -1/UNLIMITED if uncapped). */
export declare function getLimit(entitlements: Entitlements | null | undefined, key: LimitKey): number;
/** True if `currentCount` is below the limit for `key` (UNLIMITED always passes). */
export declare function isWithinLimit(entitlements: Entitlements | null | undefined, key: LimitKey, currentCount: number): boolean;
/** Flatten a plan into resolved entitlements for a subscriber. */
export declare function entitlementsFromPlan(plan: Plan, subscriberType: SubscriberType, subscriberId: string, status: SubscriptionStatus): Entitlements;
