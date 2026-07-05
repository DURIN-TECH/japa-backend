"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ACTIVE_SUBSCRIPTION_STATUSES = exports.SUBSCRIBER_ROLES = exports.AGENT_SIDE_ROLES = exports.ROLES = void 0;
exports.hasFeature = hasFeature;
exports.getLimit = getLimit;
exports.isWithinLimit = isWithinLimit;
exports.isReadOnly = isReadOnly;
exports.entitlementsFromPlan = entitlementsFromPlan;
/**
 * Core authorization types shared across backend, portal, and mobile.
 */
const catalog_1 = require("./catalog");
/**
 * Named role constants. **Always reference roles through this object** (e.g.
 * `ROLES.OWNER`) instead of hardcoding `"owner"` so role names live in one place.
 */
exports.ROLES = {
    ADMIN: "admin",
    OWNER: "owner",
    AGENT: "agent",
    CLIENT: "client",
};
/** Roles that operate the portal / act on the agency side (not clients). */
exports.AGENT_SIDE_ROLES = [exports.ROLES.ADMIN, exports.ROLES.OWNER, exports.ROLES.AGENT];
/** Roles that can hold/manage a subscription directly (admins are unlimited). */
exports.SUBSCRIBER_ROLES = [exports.ROLES.OWNER, exports.ROLES.AGENT, exports.ROLES.CLIENT];
/** Statuses that grant access to a plan's features. */
exports.ACTIVE_SUBSCRIPTION_STATUSES = ["active", "trialing"];
/** True if the entitlements are in an access-granting state and include `key`. */
function hasFeature(entitlements, key) {
    if (!entitlements)
        return false;
    if (!exports.ACTIVE_SUBSCRIPTION_STATUSES.includes(entitlements.status))
        return false;
    return entitlements.features.includes(key);
}
/** The numeric limit for `key` (0 if absent, -1/UNLIMITED if uncapped). */
function getLimit(entitlements, key) {
    if (!entitlements)
        return 0;
    const value = entitlements.limits[key];
    return value === undefined ? 0 : value;
}
/** True if `currentCount` is below the limit for `key` (UNLIMITED always passes). */
function isWithinLimit(entitlements, key, currentCount) {
    const limit = getLimit(entitlements, key);
    if (limit === catalog_1.UNLIMITED)
        return true;
    return currentCount < limit;
}
/**
 * True when a subscription is in a non-access-granting (unpaid/expired) state —
 * reads stay allowed, writes should be gated. `null`/`undefined` entitlements are
 * NOT read-only: no resolved plan means grant-all (the default before billing).
 */
function isReadOnly(entitlements) {
    if (!entitlements)
        return false;
    return !exports.ACTIVE_SUBSCRIPTION_STATUSES.includes(entitlements.status);
}
/** Flatten a plan into resolved entitlements for a subscriber. */
function entitlementsFromPlan(plan, subscriberType, subscriberId, status) {
    return {
        subscriberType,
        subscriberId,
        planId: plan.id,
        status,
        features: [...plan.features],
        limits: { ...plan.limits },
    };
}
