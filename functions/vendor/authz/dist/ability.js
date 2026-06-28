"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.subject = void 0;
exports.defineAbilitiesFor = defineAbilitiesFor;
exports.packAbility = packAbility;
exports.abilityFromPackedRules = abilityFromPackedRules;
/**
 * CASL ability factory — encodes every authorization rule once, reused on the
 * backend (enforcement) and the portal/mobile (UI gating).
 *
 * Two inputs combine into one decision:
 *   1. RBAC: role + ownership (admin/owner/agent/client + agencyId/uid conditions)
 *   2. Entitlements: subscription-gated feature on/off (locked features become
 *      `cannot` rules layered over the role grants).
 *
 * Numeric LIMITS are NOT expressed here (CASL can't count) — enforce those with
 * `isWithinLimit` + the backend `requireWithinLimit` guard.
 */
const ability_1 = require("@casl/ability");
const extra_1 = require("@casl/ability/extra");
const types_1 = require("./types");
/** Re-export CASL's `subject` helper so callers tag plain objects consistently. */
exports.subject = ability_1.subject;
/**
 * Maps a feature to the (action, subjectType) capabilities it unlocks. When a
 * subscriber lacks the feature, these become `cannot` rules — overriding the
 * role grant so the action is paywalled even on owned resources.
 */
const FEATURE_CAPABILITIES = {
    "applications.create": [["create", "Application"]],
    messaging: [["create", "Conversation"]],
    "consultations.book": [["create", "Consultation"]],
    "documents.upload": [["create", "Document"]],
    "analytics.view": [["read", "Analytics"]],
    "agency.invite_agents": [["create", "Agent"]],
    "payments.request": [["create", "PaymentRequest"]],
};
/**
 * Build the ability for a principal. Pass resolved `entitlements` to apply
 * subscription gating; omit them to get role/ownership-only rules (Phase 1).
 */
function defineAbilitiesFor(principal, entitlements) {
    const { can, cannot, build } = new ability_1.AbilityBuilder(ability_1.createMongoAbility);
    const uid = principal.uid;
    const agencyId = principal.agencyId ?? undefined;
    switch (principal.role) {
        case "admin":
            // Admins can perform every operation on everything.
            can("manage", "all");
            break;
        case "owner":
            // Agency owners manage everything scoped to their agency.
            can(["read", "update"], "Agency", { id: agencyId });
            can("manage", "Agent", { agencyId });
            can("manage", ["Application", "Document", "Consultation", "PaymentRequest", "Note", "Conversation"], { agencyId });
            can("read", "Transaction", { agencyId });
            can("read", "Analytics", { agencyId });
            can(["read", "update"], "User", { id: uid });
            break;
        case "agent":
            // Agents manage resources assigned to them; read their agency's cases.
            can("read", "Application", { agencyId });
            can("manage", ["Application", "Document", "Consultation", "PaymentRequest", "Note", "Conversation"], { agentId: uid });
            can("read", "Agent", { agencyId });
            can(["read", "update"], "Agent", { userId: uid });
            can(["read", "update"], "User", { id: uid });
            break;
        case "client":
            // Clients manage only their own resources (mobile).
            can("manage", ["Application", "Document", "Consultation", "Conversation", "Note"], { userId: uid });
            can(["read", "update", "approve"], "PaymentRequest", { userId: uid });
            can(["read", "update"], "User", { id: uid });
            break;
    }
    // Entitlement gating: for non-admins, remove capabilities whose feature the
    // subscriber's plan does not include. Admin bypasses all gating.
    if (principal.role !== "admin") {
        for (const [feature, caps] of Object.entries(FEATURE_CAPABILITIES)) {
            // When entitlements are omitted entirely (Phase 1: RBAC-only), do not gate.
            if (entitlements === undefined)
                continue;
            if (!(0, types_1.hasFeature)(entitlements, feature)) {
                for (const [action, subjectType] of caps) {
                    cannot(action, subjectType);
                }
            }
        }
    }
    return build();
}
/** Serialize an ability's rules for transport to the client (`/me/authorization`). */
function packAbility(ability) {
    return (0, extra_1.packRules)(ability.rules);
}
/** Rebuild an ability on the client from packed rules. */
function abilityFromPackedRules(packed) {
    const rules = (0, extra_1.unpackRules)(packed);
    return (0, ability_1.createMongoAbility)(rules);
}
