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
import { MongoAbility, RawRuleOf, subject as caslSubject } from "@casl/ability";
import { Action, AuthzSubject, Entitlements, SubjectType } from "./types";
/** The application ability type. Subjects are type strings or tagged objects. */
export type AppAbility = MongoAbility<[Action, SubjectType | Record<PropertyKey, unknown>]>;
/** Re-export CASL's `subject` helper so callers tag plain objects consistently. */
export declare const subject: typeof caslSubject;
/**
 * Build the ability for a principal. Pass resolved `entitlements` to apply
 * subscription gating; omit them to get role/ownership-only rules (Phase 1).
 */
export declare function defineAbilitiesFor(principal: AuthzSubject, entitlements?: Entitlements | null): AppAbility;
/** Serialize an ability's rules for transport to the client (`/me/authorization`). */
export declare function packAbility(ability: AppAbility): RawRuleOf<AppAbility>[];
/** Rebuild an ability on the client from packed rules. */
export declare function abilityFromPackedRules(packed: unknown): AppAbility;
