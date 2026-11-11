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
 * Agency visas (#98): grant an agency role (owner or agent) the right to
 * create, read, update and delete the visas its own agency created, and
 * nothing more. Shared by the owner and agent branches so the two roles can
 * never drift apart. See the `Visa` entry of `SubjectType` for the contract.
 *
 * @param builder  the `can` / `cannot` pair of the ability being built
 * @param agencyId the principal's agency, possibly undefined/null/empty
 */
function grantAgencyVisas(builder, agencyId) {
    // No agency, no visa grant. Without this guard the condition would be
    // `{ ownerAgencyId: undefined }`, which matches any visa document that
    // lacks `ownerAgencyId` (undefined === undefined), i.e. every scraped visa.
    if (!agencyId)
        return;
    // Both conditions are required: the visa belongs to this agency AND it is
    // an agency-created visa. A scraped or legacy "agent" visa that happens to
    // carry a matching `ownerAgencyId` is still off-limits.
    builder.can([...types_1.AGENCY_VISA_ACTIONS], "Visa", {
        ownerAgencyId: agencyId,
        source: types_1.AGENCY_VISA_SOURCE,
    });
    // Field-level denial, layered after the grant so it wins: agencies edit a
    // visa's content but never its review state, visibility (make-global),
    // activation or ownership. CASL only applies a field-scoped `cannot` when
    // the caller passes a field, so callers check each field they write:
    //   ability.can("update", subject("Visa", doc), "visibility") === false
    builder.cannot("update", "Visa", [...types_1.VISA_PROTECTED_FIELDS]);
}
/**
 * True when the principal really belongs to an agency: `agencyId` is a
 * non-empty string. Absent, `null`, the empty string and any non-string value
 * (a number, an array, an object that CASL would read as a Mongo operator)
 * all count as "no agency".
 *
 * @param agencyId the principal's `agencyId`, as resolved from its claims
 */
function hasAgency(agencyId) {
    return typeof agencyId === "string" && agencyId.length > 0;
}
/**
 * Agency grant on applications (fix for DURIN-TECH/japa#131): what a
 * principal may do with the cases of its OWN agency, i.e. applications whose
 * `agencyId` equals the principal's `agencyId`.
 *   - owner: `manage` (every action) on the agency's cases;
 *   - agent: `read` only (writes come from the assigned-agent grant, which
 *     is keyed on `agentId` and is NOT touched here).
 *
 * The grant is added ONLY when the principal has an agency. Without this
 * guard the condition would be `{ agencyId: undefined }`, and CASL matches
 * that against any application that has NO `agencyId` field
 * (undefined === undefined). Self-serve applications are stored without the
 * field, so before the fix an independent agent could read every client's
 * self-serve application, and an owner-role user with no agency could read,
 * update and delete them (plus the cases of independent agents, which carry
 * an `agentId` but no `agencyId`).
 *
 * Same idea as the guard in `grantAgencyVisas` above.
 *
 * @param can      the `can` of the ability being built
 * @param actions  the action(s) the role holds on its agency's applications
 * @param agencyId the principal's agency, possibly undefined/null/empty
 */
function grantAgencyApplications(can, actions, agencyId) {
    // No agency, no agency grant: the principal must never match an
    // application through `agencyId`, whatever the document does or does not
    // carry in that field.
    if (!hasAgency(agencyId))
        return;
    can(actions, "Application", { agencyId });
}
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
            // `VisaChange` (pending scraped-visa edits) is deliberately admin-only via
            // `manage all`; never grant it to another role (ability.test.ts guards this).
            // `Visa` (catalog visa types, #70) is admin-wide via `manage all` too:
            // admins edit the live catalog, approve/reject any visa and make agency
            // visas global. Agency roles only get a narrow, condition- and
            // field-restricted grant on their own agency's visas (#98, see
            // `grantAgencyVisas`); clients get none.
            // Likewise `ScrapeRun` (scraper run records + source health, #81): an
            // operational view for admins only, never granted to another role.
            break;
        case "owner":
            // Agency owners manage everything scoped to their agency.
            can(["read", "update"], "Agency", { id: agencyId });
            can("manage", "Agent", { agencyId });
            // Applications of the owner's own agency: every action. Guarded (#131):
            // an owner with no agency gets NO application grant at all.
            grantAgencyApplications(can, "manage", agencyId);
            // The other case resources keep their agency grant exactly as it was.
            // Split from the Application grant above only because that one is now
            // guarded. NOTE: these (and the Agency / Agent / Transaction / Analytics
            // grants in this branch) still become `{ agencyId: undefined }` for an
            // owner with no agency; #131 fixes Application only ("any other rule
            // change" is out of its scope) and the rest is reported as a follow-up.
            can("manage", ["Document", "Consultation", "PaymentRequest", "Note", "Conversation"], { agencyId });
            can("read", "Transaction", { agencyId });
            can("read", "Analytics", { agencyId });
            can(["read", "update"], "User", { id: uid });
            // Own agency's agency-created visas (#98): create/read/update/delete,
            // with review, visibility and ownership fields locked.
            grantAgencyVisas({ can, cannot }, agencyId);
            break;
        case "agent":
            // Agents manage resources assigned to them; read their agency's cases.
            // The agency read grant is guarded (#131): an independent agent (no
            // agency) gets none, so it cannot read applications that merely lack an
            // `agencyId` (self-serve applications).
            grantAgencyApplications(can, "read", agencyId);
            // Assigned-agent grant, keyed on `agentId`: unchanged by #131. An
            // independent agent keeps full access to the cases assigned to them.
            can("manage", ["Application", "Document", "Consultation", "PaymentRequest", "Note", "Conversation"], { agentId: uid });
            can("read", "Agent", { agencyId });
            can(["read", "update"], "Agent", { userId: uid });
            can(["read", "update"], "User", { id: uid });
            // Agents get the same agency-visa grant as owners (#98), scoped to the
            // agent's own `agencyId`; an independent agent (no agency) gets none.
            grantAgencyVisas({ can, cannot }, agencyId);
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
        // Read-only gating: a resolved-but-lapsed subscription (unpaid/expired — any
        // status outside ACTIVE_SUBSCRIPTION_STATUSES) keeps read access but loses
        // all writes. Layered last so these `cannot` rules override the role grants.
        // Skipped when entitlements are omitted/null (RBAC-only / grant-all default).
        if (entitlements && !types_1.ACTIVE_SUBSCRIPTION_STATUSES.includes(entitlements.status)) {
            // `reject` is a write like `approve` (e.g. rejecting a pending change), so
            // a lapsed plan blocks it too.
            cannot(["create", "update", "delete", "assign", "approve", "reject"], "all");
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
