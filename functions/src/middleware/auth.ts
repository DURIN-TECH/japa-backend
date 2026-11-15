import { Request, Response, NextFunction } from "express";
import { auth } from "../utils/firebase";
import { DecodedIdToken } from "firebase-admin/auth";
import {
  AppAbility,
  AuthzSubject,
  Entitlements,
  Role,
  ROLES,
  SubscriberType,
  defineAbilitiesFor,
  isReadOnly,
} from "@durin-tech/authz";
import { claimsService } from "../services/claims.service";
import { entitlementService } from "../services/entitlement.service";

// Extend Express Request to include authenticated user + resolved authorization.
export interface AuthenticatedRequest extends Request {
  user?: DecodedIdToken;
  userId?: string;
  /** Resolved principal (role + agencyId) built from custom claims. */
  authz?: AuthzSubject;
  /** CASL ability for this principal (RBAC + subscription entitlements). */
  ability?: AppAbility;
  /** Resolved entitlements for this principal (null for admin / pre-seed). */
  entitlements?: Entitlements | null;
}

/**
 * True when a stored entitlements record under an independent agent's id is
 * the leftover of the lazy client default (issue #311) and must therefore not
 * gate the agent.
 *
 * Why this can happen: a client and an independent agent are both keyed by
 * their own uid in `entitlements`. Every account is a client until agent
 * onboarding completes, so the client record that #311 saves on a new user's
 * first request is still there, under the same id, once that user becomes an
 * independent agent. Honouring it would put the agent on the free client
 * plan's features and limits. Agents with no record of their own are out of
 * scope here (#315) and must stay as they were: ungated.
 *
 * But a client-type record under an agent's uid can ALSO be one somebody chose:
 * an admin assigned a client plan, or the person bought one while still a
 * client. Those gated (or unlocked paid AI for) the agent before #311 and must
 * keep doing so. The two are told apart by `subscriptions/{uid}`:
 *
 *  - the lazy path writes the entitlements record ONLY, never a subscription;
 *  - every assigned or bought plan writes `subscriptions/{uid}` before its
 *    entitlements record (`assignPlan`, the billing webhook, the subscription
 *    seed), and nothing deletes a subscription document.
 *
 * So: client-type record + no subscription document = lazily created = ignore.
 * Any subscription document = somebody's decision = honour the record, as
 * before #311.
 *
 * Cost: most callers return before any read (not an agent subscriber, or the
 * record is the agent's own). An independent agent who still carries a
 * client-type record pays one extra read on EVERY request. That is not a rare
 * case going forward: every new account gets the lazy client record on its
 * first request, so every future independent agent pays this read until they
 * have a record of their own (agents with no record: issue #315).
 *
 * If the subscription read fails we cannot tell which kind it is. The record
 * is then honoured: that is what happened to every such record before #311,
 * and it is the choice that never removes a gate.
 *
 * Deliberately narrow: only "agent subscriber, client record". An agency is
 * keyed by its agency id, so it cannot collide with a user's record.
 */
async function isLeftoverLazyClientRecord(
  subscriber: { type: SubscriberType; id: string },
  stored: Entitlements
): Promise<boolean> {
  if (subscriber.type !== "agent" || stored.subscriberType !== "client") return false;
  try {
    const subscription = await entitlementService.getActiveSubscription(subscriber.id);
    return subscription === null;
  } catch (error) {
    console.error(
      "attachAuthz: could not read the subscription behind a client record on an agent; honouring the record:",
      error
    );
    return false;
  }
}

/**
 * Build `req.authz` + `req.ability` from the token's custom claims. When the role
 * claim isn't present yet (pre-migration user), fall back to resolving from the DB
 * and lazily backfill the claims so subsequent tokens carry them. Fail-safe: on
 * any error, default to least-privilege `client` rather than blocking the request.
 *
 * Also loads the principal's entitlements. A client with no stored record gets
 * the default client plan resolved and saved here, once (issue #311).
 */
async function attachAuthz(req: AuthenticatedRequest): Promise<void> {
  const decoded = req.user;
  if (!decoded) return;
  const uid = decoded.uid;
  try {
    let role = decoded.role as Role | undefined;
    let agencyId = (decoded.agencyId as string | null | undefined) ?? null;

    if (!role) {
      const resolved = await claimsService.resolveRoleFromDb(uid);
      role = resolved.role;
      agencyId = resolved.agencyId;
      // Best-effort backfill so the next token carries the claims (no await).
      void claimsService.setRoleClaims(uid, role, agencyId).catch(() => undefined);
    }

    const authz: AuthzSubject = { uid, role, agencyId };
    req.authz = authz;

    // ============================================
    // Entitlements (what the subscriber's plan unlocks)
    // ============================================
    //
    // Hot path: ONE read of the stored `entitlements/{subscriberId}` record.
    // Whoever has a record (free or paid) is served from it and nothing is
    // written, except a client whose saved default plan has changed since
    // (rewritten once, see below). Admins have no subscriber and are never
    // gated.
    //
    // `null` entitlements mean "no plan resolved": `requireFeature` and
    // `checkWithinLimit` then let the request through (RBAC only). That is
    // still the outcome for agencies and agents with no record (issue #315),
    // and for anyone when the lookup fails.
    let entitlements: Entitlements | undefined;
    if (role !== ROLES.ADMIN) {
      const subscriber = entitlementService.resolveSubscriber(authz);
      if (subscriber) {
        // A failed read must stay distinguishable from "no record": only a
        // confirmed absence may trigger the default-plan write below.
        let lookupFailed = false;
        const stored = await entitlementService
          .getEntitlements(subscriber.id)
          .catch(() => {
            lookupFailed = true;
            return null;
          });

        if (stored && (await isLeftoverLazyClientRecord(subscriber, stored))) {
          // The lazy client default left under an independent agent's uid
          // (see isLeftoverLazyClientRecord): treated as "no record", which
          // for an agent means ungated, as before #311.
        } else if (stored && role === ROLES.CLIENT) {
          // A client's record. If it is one this middleware saved from the
          // default client plan (no subscription behind it), keep it in step
          // with that plan as it is NOW: a later edit to the plan, or another
          // plan becoming the default, would otherwise never reach it (#311,
          // see entitlementService.followDefaultPlan). Normally this costs no
          // read (the default plan is memoized) and returns `stored` as is.
          // An assigned or bought record is returned untouched.
          //
          // Fail-safe: if the check or the refresh fails, the stored record is
          // used as it is. That is the plan the client was last resolved to,
          // so no gate is dropped and nothing new is granted.
          entitlements = await entitlementService
            .followDefaultPlan(subscriber.type, subscriber.id, stored)
            .catch((error) => {
              console.error(
                "attachAuthz: could not check the stored record against the default client plan; using it as stored:",
                error
              );
              return stored;
            });
        } else if (stored) {
          entitlements = stored;
        } else if (!lookupFailed && role === ROLES.CLIENT) {
          // Issue #311: a CLIENT with no record is on the free client plan
          // from this request on. Resolve it and save it once; the next
          // request takes the single-read branch above. Clients only: agents
          // and agencies with no record stay ungated (#315).
          //
          // Fail-safe: if this throws (plan read or write failed), or there is
          // no default client plan, entitlements stay unresolved exactly as
          // before this change. Nothing is granted on top of that, and the
          // AI chat gate still answers 403 ENTITLEMENTS_UNAVAILABLE.
          try {
            const resolved = await entitlementService.resolveMissingEntitlements(
              subscriber.type,
              subscriber.id
            );
            if (resolved) entitlements = resolved;
          } catch (error) {
            console.error(
              "attachAuthz: could not resolve the default client plan; entitlements stay unresolved:",
              error
            );
          }
        }
      }
    }
    req.entitlements = entitlements ?? null;
    req.ability = defineAbilitiesFor(authz, entitlements);
  } catch (error) {
    console.error("attachAuthz failed; defaulting to least-privilege:", error);
    const authz: AuthzSubject = { uid, role: ROLES.CLIENT, agencyId: null };
    req.authz = authz;
    req.entitlements = null;
    req.ability = defineAbilitiesFor(authz);
  }
}

/**
 * Middleware to verify Firebase ID token from Authorization header
 * Expects: Authorization: Bearer <token>
 */
export async function verifyAuth(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  const authHeader = req.headers.authorization;

  if (!authHeader?.startsWith("Bearer ")) {
    res.status(401).json({
      success: false,
      error: "Unauthorized",
      message: "Missing or invalid Authorization header",
    });
    return;
  }

  const token = authHeader.split("Bearer ")[1];

  try {
    // checkRevoked=true so a suspended/rejected agent (whose refresh tokens were
    // revoked) is rejected on their very next request — an immediate force-logout
    // rather than waiting up to an hour for their ID token to expire.
    const decodedToken = await auth.verifyIdToken(token, true);
    req.user = decodedToken;
    req.userId = decodedToken.uid;

    // Hard block for disabled accounts (agent suspended or rejected). The claim
    // rides in the token, so no DB read is needed; combined with the token
    // revocation above, a re-issued token still carries `disabled` and is
    // blocked here. The distinct code lets the portal show a suspended screen.
    if (decodedToken.disabled === true) {
      res.status(403).json({
        success: false,
        error: "ACCOUNT_SUSPENDED",
        message: "Your access has been suspended. Please contact your agency owner.",
      });
      return;
    }

    await attachAuthz(req);

    // Read-only enforcement: a lapsed/unpaid plan may read but not write. Block
    // mutating methods for non-admin read-only principals; reads pass through.
    // Single chokepoint for every authenticated route (admins + unresolved
    // entitlements are never read-only, so nothing blocks before billing exists).
    const isWrite = !["GET", "HEAD", "OPTIONS"].includes(req.method.toUpperCase());

    // Exemption: self-service SECURITY / data-rights actions must NEVER be plan-
    // gated. A user with a lapsed (read-only) plan must still be able to secure
    // their account (change password / email) or exercise their right to delete
    // it. `originalUrl` is the app-root path (query stripped); `endsWith` tolerates
    // any mount prefix. Keep this list tiny and security-scoped.
    const path = req.originalUrl.split("?")[0];
    const method = req.method.toUpperCase();
    // Feedback (#257): a tester on a lapsed plan can still report a bug, and a
    // bug about the lapsed plan itself is exactly what we want to hear. EXACTLY
    // `POST /feedback` and `POST /feedback/screenshot-url` (optional `/api`
    // function prefix, trailing slash tolerated); no other path ending in
    // "/feedback" is exempt. Both endpoints are rate limited per user.
    const isFeedbackWrite =
      method === "POST" && /^(\/api)?\/feedback(\/screenshot-url)?\/?$/.test(path);
    const isAccountSecurityWrite =
      isFeedbackWrite ||
      path.endsWith("/users/me/password-changed") ||
      path.endsWith("/users/me/change-email") ||
      (method === "DELETE" && path.endsWith("/users/me")) ||
      // AI message access (#172): withdrawing approval, the account-wide off
      // setting and the notice dismissal are privacy
      // controls over a person's own messages. A lapsed plan must not stop them.
      // Listed route by route and method (granting approval stays plan-gated).
      (method === "DELETE" && path.endsWith("/users/me/ai-message-access/approval")) ||
      (method === "PUT" && path.endsWith("/users/me/ai-message-access/account-wide-off")) ||
      (method === "POST" && path.endsWith("/users/me/ai-message-access/notice-dismissed"));

    if (
      isWrite &&
      !isAccountSecurityWrite &&
      req.authz?.role !== ROLES.ADMIN &&
      isReadOnly(req.entitlements)
    ) {
      res.status(402).json({
        success: false,
        error: "UPGRADE_REQUIRED",
        message: "Your plan is read-only. Renew your subscription to make changes.",
      });
      return;
    }

    next();
  } catch (error) {
    console.error("Token verification failed:", error);
    res.status(401).json({
      success: false,
      error: "Unauthorized",
      message: "Invalid or expired token",
    });
  }
}

/**
 * Forget everything a request may have learned about a caller, so it is
 * served as an anonymous guest. Used by `optionalAuth` when a token cannot be
 * trusted (issue #286): no half-set identity may leak to the handler.
 */
function clearIdentity(req: AuthenticatedRequest): void {
  delete req.user;
  delete req.userId;
  delete req.authz;
  delete req.ability;
  delete req.entitlements;
}

/**
 * Optional auth for PUBLIC routes: a valid Firebase ID token identifies the
 * caller (`req.user`, `req.userId`, `req.authz`, `req.ability`), but nothing
 * here ever blocks the request.
 *
 * Security (issue #286): anything short of a valid token is a GUEST, never an
 * error and never trusted:
 *  - no `Authorization` header, or not `Bearer <token>`: guest;
 *  - a token that fails verification (bad signature, expired, wrong project,
 *    garbage): guest, with no identity set at all (`clearIdentity`);
 *  - a token carrying the `disabled` claim (a suspended / rejected account,
 *    which `verifyAuth` answers 403): guest too, so a public read never
 *    serves a disabled account as signed in.
 * The handler therefore only ever sees a `userId` taken from a verified,
 * enabled token. Used by the public visa, news, agent and agency reads.
 */
export async function optionalAuth(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  const authHeader = req.headers.authorization;

  if (authHeader?.startsWith("Bearer ")) {
    const token = authHeader.split("Bearer ")[1];
    try {
      const decodedToken = await auth.verifyIdToken(token);
      if (decodedToken.disabled === true) {
        // A disabled account is not served as signed in (see above).
        clearIdentity(req);
      } else {
        req.user = decodedToken;
        req.userId = decodedToken.uid;
        await attachAuthz(req);
      }
    } catch {
      // Token invalid: serve the request as a guest, with no identity set.
      clearIdentity(req);
      console.log("Optional auth: invalid token provided");
    }
  }

  next();
}

/**
 * True when the caller is agent-side (agent, owner or admin). Same rule as
 * `verifyAgent`, exposed as a predicate so a handler that is open to applicants
 * as well can branch to the (much narrower) applicant path (#43).
 */
export function isAgentSideRequest(req: AuthenticatedRequest): boolean {
  const role = req.authz?.role ?? (req.user?.role as string | undefined);
  return role === "agent" || role === "owner" || role === "admin" || !!req.user?.agent || !!req.user?.admin;
}

/**
 * Middleware to check if user is an agent
 */
export async function verifyAgent(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  if (!req.user) {
    res.status(401).json({
      success: false,
      error: "Unauthorized",
      message: "Authentication required",
    });
    return;
  }

  // Agent-side roles: agent, owner, or admin (driven by the role claim, with the
  // legacy `agent` claim kept as a fallback). req.authz is populated by verifyAuth,
  // but verifyAgent may be used standalone, so resolve defensively.
  const role = req.authz?.role ?? (req.user.role as string | undefined);
  const isAgentSide = role === "agent" || role === "owner" || role === "admin";
  if (!isAgentSide && !req.user.agent && !req.user.admin) {
    res.status(403).json({
      success: false,
      error: "Forbidden",
      message: "Agent access required",
    });
    return;
  }

  next();
}

/**
 * Middleware to check if user is an admin
 */
export async function verifyAdmin(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  if (!req.user) {
    res.status(401).json({
      success: false,
      error: "Unauthorized",
      message: "Authentication required",
    });
    return;
  }

  // Admin via the new role claim or the legacy `admin` boolean claim.
  const isAdmin = req.authz?.role === "admin" || req.user.admin === true;
  if (!isAdmin) {
    res.status(403).json({
      success: false,
      error: "Forbidden",
      message: "Admin access required",
    });
    return;
  }

  next();
}
