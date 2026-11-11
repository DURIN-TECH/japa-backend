// ============================================
// Application access check — shared, request-free (issue #29)
// ============================================
//
// "May this principal read / update / delete this application?" as ONE
// function that REST handlers, the AI case-officer routes (#42) and Firestore
// triggers (#44) all call, so they cannot drift apart.
//
// THE RULE (unchanged by #29; this file only moved it out of
// ApplicationController), in order of precedence:
//
//   1. admin              — every action on every application.
//   2. applicant          — the user who owns the application
//                           (`application.userId === principal.uid`):
//                           every action on their own applications.
//   3. assigned agent     — `application.agentId === principal.uid`:
//                           every action on the cases assigned to them.
//   4. same agency        — `application.agencyId === principal.agencyId`:
//                           an agency OWNER gets every action on the agency's
//                           cases; an AGENT colleague gets READ only.
//   Anything else is denied. A lapsed subscription (entitlements resolved,
//   status not active) keeps `read` and strips `update` / `delete`.
//
// WHERE IT IS ENCODED: this file holds no rule of its own. The decision is
// the shared CASL ability from `@durin-tech/authz`, built by
// `defineAbilitiesFor` in `seli-authz/src/ability.ts` (vendored here under
// `functions/vendor/authz`). Change the rule THERE, never here.
//
// Two things about that encoding that the precedence list above glosses over
// (both pinned by test/access/, both pre-date #29):
//   - Grants hang off the principal's ROLE, one branch per role. So step 2
//     applies to `client`-role principals only: an agent-role user who is the
//     applicant of an application gets nothing from being its applicant.
//   - KNOWN DEFECT: a no-agency `agent` / `owner` principal is granted on
//     `{ agencyId: undefined }`, which CASL matches against any application
//     that has NO `agencyId` field (self-serve applications). See
//     KNOWN_DEFECT_CELLS in test/access/fixtures.ts. Tracked as
//     DURIN-TECH/japa#131, to be fixed in `@durin-tech/authz`; deliberately
//     not patched here.
//
// WHO CAN CALL IT: anything. Nothing in this file imports Express or reads a
// request. Callers pass either
//   - an already-built `AppAbility` (REST handlers: `req.ability`), or
//   - a narrow principal: the `AuthzSubject` (`uid`, `role`, `agencyId`) plus
//     optional resolved entitlements (triggers, jobs), or
//   - build the ability once with `buildAbilityForPrincipal` /
//     `resolveAbilityForUid` and reuse it for many applications.
//
// FAIL CLOSED: a missing or malformed principal, a missing application, and
// (in `resolveAbilityForUid`) a principal or entitlements lookup that throws
// all end in DENY, for every role including admin.
//
// NOT HERE: "which fields may this principal see" (field-level filtering).
// That lives with the assessment engine (#42). This is the boolean only.

import {
  AppAbility,
  AuthzSubject,
  Entitlements,
  ROLES,
  Role,
  abilityFromPackedRules,
  defineAbilitiesFor,
  subject as caslSubject,
} from "@durin-tech/authz";
import { Application } from "../types";

// ============================================
// Types
// ============================================

/**
 * The actions the check accepts. `read` is the default and what all five REST
 * call sites use today.
 */
export type ApplicationAccessAction = "read" | "update" | "delete";

/**
 * The narrow principal a non-request caller passes: who is asking, plus the
 * subscription state that may make them read-only.
 *
 * Field names mirror `AuthenticatedRequest` (`req.authz`, `req.entitlements`)
 * on purpose, but this is NOT a request and never should be one.
 */
export interface ApplicationAccessPrincipal {
  /** The resolved principal: `uid`, `role`, `agencyId` (null when none). */
  authz: AuthzSubject;
  /**
   * The principal's resolved entitlements, if any.
   *  - an `Entitlements` object: applied (a lapsed plan becomes read-only);
   *  - `null` or omitted: NO plan resolved, role/ownership rules only. This is
   *    exactly what `attachAuthz` (middleware/auth.ts) does on the request
   *    path when the entitlements cache has no entry.
   * "Could not look the entitlements up" is a different thing from "there are
   * none": for that, deny (see `resolveAbilityForUid`).
   */
  entitlements?: Entitlements | null;
}

/**
 * Anything that carries a built ability the way `AuthenticatedRequest` does.
 * Declared structurally so this file needs no Express import.
 */
export interface AbilityCarrier {
  /** The CASL ability `attachAuthz` built for the request, if it ran. */
  ability?: AppAbility;
}

/**
 * How `resolveAbilityForUid` looks a principal up. Injected, so this file
 * stays free of Firestore and the caller decides where the truth comes from.
 */
export interface AbilityResolvers {
  /**
   * Resolve the principal for a uid, or null/undefined when there is none.
   * May throw: a throw is treated as "unresolvable" and denies.
   *
   * Rules for whoever implements this:
   *  - Take the role and agency from a source the user cannot write: the
   *    Firebase Auth custom claims (`role`, `agencyId`), which is what the
   *    request path trusts. Do NOT wire `claimsService.resolveRoleFromDb`
   *    into a trigger until DURIN-TECH/japa#135 is fixed: it reads documents
   *    a client can write, so a user could resolve themselves a higher role.
   *  - Return null for a disabled / suspended user (the `disabled` claim).
   *    The request path blocks them in `verifyAuth` before any ability is
   *    built; nothing here can see that claim, so the resolver must.
   *  - Do NOT swallow errors (`.catch(() => null)` and the like) to return a
   *    lower-privilege principal: let them throw, so the outcome is deny
   *    rather than a guess.
   */
  resolvePrincipal: (uid: string) => Promise<AuthzSubject | null | undefined>;
  /**
   * Resolve the principal's entitlements: an object, or null/undefined when
   * no plan is resolved for them (role rules only). May throw: a throw is
   * treated as "unresolvable" and denies. Not called for admins.
   * Request-path equivalent: `entitlementService.resolveSubscriber(authz)`
   * then `entitlementService.getEntitlements(subscriber.id)`.
   *
   * Do NOT swallow errors here: `.catch(() => null)` turns an outage into
   * "no plan resolved", i.e. role-only rules, and a lapsed (read-only)
   * subscriber would get their writes back. Let the lookup throw.
   */
  resolveEntitlements: (authz: AuthzSubject) => Promise<Entitlements | null | undefined>;
}

// ============================================
// Deny-all
// ============================================

/**
 * An ability with no rules at all: `can()` is false for every action on
 * every subject. Returned whenever a principal cannot be trusted or resolved,
 * so callers can keep one code path and still fail closed.
 */
export function denyAllAbility(): AppAbility {
  // An empty packed-rule list rebuilds to an empty ability.
  return abilityFromPackedRules([]);
}

/** The roles `defineAbilitiesFor` has a branch for. */
const KNOWN_ROLES: readonly Role[] = Object.values(ROLES);

/**
 * True when `authz` is a usable principal:
 *  - `uid`: a non-empty string;
 *  - `role`: one the ability factory knows (an unknown role happens to
 *    produce no grants today, but that is the factory's accident, not a
 *    guarantee);
 *  - `agencyId`: null, undefined, or a non-empty string.
 * Anything else must not reach the factory.
 *
 * WHY `agencyId` IS CHECKED: the factory copies it straight into CASL
 * conditions (`{ agencyId }`), and CASL reads an OBJECT there as a Mongo
 * query operator. A principal carrying `agencyId: { $ne: null }` (or
 * `{ $exists: true }`, `{ $in: [...] }`) would match every agency's
 * applications. Arrays, numbers and the empty string are refused as well:
 * none of them is an agency id.
 */
function isUsablePrincipal(authz: unknown): authz is AuthzSubject {
  if (!authz || typeof authz !== "object") return false;
  const a = authz as Record<string, unknown>;
  // uid: the factory uses it in conditions too (`userId`, `agentId`), so it
  // must be a plain non-empty string for the same reason as agencyId.
  if (typeof a.uid !== "string" || a.uid.length === 0) return false;
  if (!KNOWN_ROLES.includes(a.role as Role)) return false;
  // agencyId: absent (null / undefined) or a real id. Never an operator.
  const agencyId = a.agencyId;
  if (agencyId === null || agencyId === undefined) return true;
  return typeof agencyId === "string" && agencyId.length > 0;
}

/**
 * The class of every ability `@durin-tech/authz` builds (CASL's
 * `PureAbility`), taken from an ability the package itself made. Not imported
 * from `@casl/ability` on purpose: this package does not declare CASL as a
 * direct dependency, and reading the class off authz's own output guarantees
 * it is the SAME CASL copy authz uses, so `instanceof` cannot be fooled by a
 * second copy in node_modules.
 */
const ABILITY_CLASS = denyAllAbility().constructor as new (...args: never[]) => AppAbility;

/**
 * True when `who` is an already-built ability rather than a principal.
 * A real `instanceof` check, not duck-typing: a principal-shaped object that
 * merely has a `can` function is NOT an ability and goes through
 * `buildAbilityForPrincipal` (and its validation) like any other principal.
 */
function isAbility(who: AppAbility | ApplicationAccessPrincipal): who is AppAbility {
  return who instanceof ABILITY_CLASS;
}

// ============================================
// Building the ability without a request
// ============================================

/**
 * Build the CASL ability for an already-resolved principal. Synchronous and
 * pure: no I/O, no request.
 *
 * Produces the SAME ability `attachAuthz` puts on `req.ability` for the same
 * inputs: `defineAbilitiesFor(authz, entitlements)`, with "no entitlements"
 * passed as `undefined` (role/ownership rules only).
 *
 * Fails closed: a missing principal, an empty uid, an unknown role, an
 * `agencyId` that is not null / undefined / a non-empty string (see
 * `isUsablePrincipal`), or a factory error returns the deny-all ability.
 *
 * @param principal the resolved principal (+ optional entitlements)
 * @returns the principal's ability, or deny-all
 */
export function buildAbilityForPrincipal(
  principal: ApplicationAccessPrincipal | null | undefined
): AppAbility {
  if (!principal || !isUsablePrincipal(principal.authz)) return denyAllAbility();
  try {
    // `null` -> `undefined`: the factory treats the two differently (null
    // means "resolved, plan has no features" and paywalls creates), and the
    // request path only ever passes an object or undefined. Match it.
    return defineAbilitiesFor(principal.authz, principal.entitlements ?? undefined);
  } catch (error) {
    console.error("buildAbilityForPrincipal failed; denying:", error);
    return denyAllAbility();
  }
}

/**
 * Resolve a uid to its ability with NO request object: for Firestore
 * triggers, scheduled jobs and anything else that only has a uid.
 *
 * Fails closed, and is deliberately stricter than the request path here:
 *  - empty uid                                   -> deny-all
 *  - `resolvePrincipal` throws / returns nothing -> deny-all
 *  - the resolved principal is malformed, or is for a different uid -> deny-all
 *  - `resolveEntitlements` throws                -> deny-all
 *    (`attachAuthz` falls back to role-only rules on that error; a background
 *    caller has no user waiting, so it denies instead of guessing)
 *  - `resolveEntitlements` returns null/undefined -> role/ownership rules
 *    only, same as the request path when no plan is resolved.
 * Admins skip the entitlements lookup, as on the request path.
 *
 * Never throws.
 *
 * @param uid       the user to build the ability for
 * @param resolvers how to look up the principal and its entitlements
 * @returns the user's ability, or deny-all
 */
export async function resolveAbilityForUid(
  uid: string | null | undefined,
  resolvers: AbilityResolvers
): Promise<AppAbility> {
  if (typeof uid !== "string" || uid.length === 0) return denyAllAbility();
  try {
    // 1. Who is this? No principal, no access.
    const authz = await resolvers.resolvePrincipal(uid);
    if (!isUsablePrincipal(authz)) return denyAllAbility();
    // A resolver that answers for someone else is a bug; do not act on it.
    if (authz.uid !== uid) return denyAllAbility();

    // 2. Subscription state (admins bypass gating, so nothing to look up).
    let entitlements: Entitlements | null | undefined;
    if (authz.role !== ROLES.ADMIN) {
      entitlements = await resolvers.resolveEntitlements(authz);
    }

    // 3. Same factory call as the request path.
    return buildAbilityForPrincipal({ authz, entitlements });
  } catch (error) {
    // Either lookup failed: unknown is not the same as allowed.
    console.error("resolveAbilityForUid failed; denying:", error);
    return denyAllAbility();
  }
}

// ============================================
// The check
// ============================================

/**
 * True if the principal may perform `action` on `application`.
 *
 * See the rule at the top of this file. The decision is
 * `ability.can(action, <application tagged as "Application">)`, exactly what
 * the private `ApplicationController.checkApplicationAccess` did before #29.
 *
 * @param who         an already-built ability (e.g. `req.ability`), or a
 *                    narrow principal to build one from. Missing -> false.
 * @param application the application document, with `userId`, `agentId` and
 *                    `agencyId` as stored. Missing -> false, for everyone
 *                    (an admin has no access to an application that does not
 *                    exist; handlers answer 404 before they get here).
 * @param action      `read` (default), `update` or `delete`. A caller that
 *                    is about to WRITE must pass `"update"` or `"delete"`,
 *                    never rely on the default: `read` is wider (a
 *                    same-agency colleague and a lapsed subscriber can read
 *                    but not write).
 */
export function checkApplicationAccess(
  who: AppAbility | ApplicationAccessPrincipal | null | undefined,
  application: Application | null | undefined,
  action: ApplicationAccessAction = "read"
): boolean {
  // No principal or nothing to check against: deny.
  if (!who || !application) return false;

  const ability = isAbility(who) ? who : buildAbilityForPrincipal(who);

  // Tag the plain document with its CASL subject type so the ability's
  // conditions (`userId`, `agentId`, `agencyId`) are matched against it.
  return ability.can(
    action,
    caslSubject("Application", application as unknown as Record<PropertyKey, unknown>)
  );
}

/**
 * Thin adapter for REST handlers: run the check with the ability
 * `attachAuthz` already put on the request.
 *
 * Reads `req.ability` ONLY. A request with no ability (auth middleware did
 * not run) is denied, as before #29; it is never rebuilt from other request
 * fields, which could grant more than the middleware decided.
 *
 * @param req         the authenticated request (anything carrying `ability`)
 * @param application the application being accessed
 * @param action      `read` (default), `update` or `delete`
 */
export function checkApplicationAccessForRequest(
  req: AbilityCarrier,
  application: Application | null | undefined,
  action: ApplicationAccessAction = "read"
): boolean {
  return checkApplicationAccess(req.ability, application, action);
}
