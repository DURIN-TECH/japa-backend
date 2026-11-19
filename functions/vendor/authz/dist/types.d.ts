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
export type SubjectType = "Application" | "Document" | "Consultation" | "PaymentRequest" | "Transaction" | "Note" | "Conversation" | "Agency" | "Agent" | "User" | "Analytics" | "Plan" | "Subscription"
/**
 * A pending (not yet live) edit to a scraped visa, held in the
 * `pendingVisaChanges` collection until an admin approves or rejects it.
 * Admin-only: no role grant exists for it (see `defineAbilitiesFor`).
 */
 | "VisaChange"
/**
 * A catalog visa type (the live `visas` collection: requirements, fees,
 * processing times). Distinct from `VisaChange`, which is a *proposal* to
 * edit one: admin edits made directly to a visa document (e.g. setting a
 * manual USD cost, #70) are gated on `Visa`, not on `VisaChange`.
 * Public catalog reads are served by unauthenticated routes and do not go
 * through this subject.
 *
 * Agency visas (#98) reuse this same subject; there is no separate
 * "AgencyVisa" subject. The contract for agency roles:
 *
 * - Who: `owner` and `agent` principals with a non-empty `agencyId`.
 *   A principal without an agency gets no `Visa` grant at all.
 * - Actions: `create`, `read`, `update`, `delete`
 *   (`AGENCY_VISA_ACTIONS`). `delete` is meant for drafts only; the
 *   draft-only rule is enforced by the backend (#100), not by CASL.
 * - Conditions (both must match on the tagged visa document):
 *     `ownerAgencyId === principal.agencyId` and
 *     `source === AGENCY_VISA_SOURCE` ("agency").
 *   So the backend must tag the full doc: `subject("Visa", visaDoc)`, with
 *   `ownerAgencyId` and `source` present. Scraped, legacy `"agent"` and
 *   source-less visas never match.
 * - Restricted fields: owner/agent cannot `update` any field in
 *   `VISA_PROTECTED_FIELDS` (review state, visibility, activation and
 *   ownership). Check per field: `can("update", visa, "visibility")`.
 *   A field-less `can("update", visa)` is still true, so the backend must
 *   also check each field it is about to write.
 * - Never granted to them: `approve`, `reject` (and make-global, which is
 *   an `update` of `visibility`): those stay admin-only via `manage all`.
 * - A lapsed subscription strips `create`/`update`/`delete` (read-only).
 */
 | "Visa"
/**
 * A scrape run record (the top-level `scrapeRuns` collection, #81): one doc
 * per visa or news crawl run with its timing, counters and errors, plus the
 * per-source health view served next to it. Admin-only: no role grant
 * exists for it (see `defineAbilitiesFor`). Backend action map:
 * GET /admin/scrape-runs, GET /admin/scrape-runs/:id and
 * GET /admin/scrape-sources = read.
 */
 | "ScrapeRun" | "all";
/** CASL actions. Kept as a string union plus open `string` for forward-compat. */
export type Action = "manage" | "create" | "read" | "update" | "delete" | "assign" | "approve" | "reject" | (string & {});
/**
 * The `VisaType.source` value that marks a visa created by an agency (#98,
 * field added to the backend type in #99). Agency-role `Visa` grants only
 * match documents carrying this source. Use this constant instead of the
 * `"agency"` literal.
 */
export declare const AGENCY_VISA_SOURCE: "agency";
/**
 * The actions agency roles (owner, agent) hold on their own agency's visas.
 * Approve/reject are deliberately absent: review stays admin-only.
 */
export declare const AGENCY_VISA_ACTIONS: readonly ["create", "read", "update", "delete"];
/**
 * `Visa` document fields that only admins (or the server itself) may write.
 * Owner and agent hold field-level `cannot("update", "Visa", ...)` rules on
 * every one of these, so they can edit a visa's content (name, requirements,
 * fees, sponsor, ...) but never its review state, visibility (make-global),
 * activation or ownership. On create the backend sets these fields itself
 * rather than taking them from the request body.
 */
export declare const VISA_PROTECTED_FIELDS: readonly ["reviewStatus", "reviewedBy", "reviewedAt", "rejectionReason", "visibility", "isActive", "ownerAgencyId", "createdBy", "source"];
/** One of the `VISA_PROTECTED_FIELDS`. */
export type VisaProtectedField = (typeof VISA_PROTECTED_FIELDS)[number];
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
/**
 * True when a subscription is in a non-access-granting (unpaid/expired) state —
 * reads stay allowed, writes should be gated. `null`/`undefined` entitlements are
 * NOT read-only: no resolved plan means grant-all (the default before billing).
 */
export declare function isReadOnly(entitlements: Entitlements | null | undefined): boolean;
/** Flatten a plan into resolved entitlements for a subscriber. */
export declare function entitlementsFromPlan(plan: Plan, subscriberType: SubscriberType, subscriberId: string, status: SubscriptionStatus): Entitlements;
