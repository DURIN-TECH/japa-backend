import { Request, Response, NextFunction } from "express";
import { auth } from "../utils/firebase";
import { DecodedIdToken } from "firebase-admin/auth";
import {
  AppAbility,
  AuthzSubject,
  Entitlements,
  Role,
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
 * Build `req.authz` + `req.ability` from the token's custom claims. When the role
 * claim isn't present yet (pre-migration user), fall back to resolving from the DB
 * and lazily backfill the claims so subsequent tokens carry them. Fail-safe: on
 * any error, default to least-privilege `client` rather than blocking the request.
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

    // Load the subscriber's entitlements cache (read-only hot path; no writes).
    // Gating only activates once the cache is populated (admin plan assignment /
    // migration / billing webhook) — until then `undefined` keeps it RBAC-only.
    let entitlements: Entitlements | undefined;
    if (role !== "admin") {
      const subscriber = entitlementService.resolveSubscriber(authz);
      if (subscriber) {
        const ent = await entitlementService
          .getEntitlements(subscriber.id)
          .catch(() => null);
        if (ent) entitlements = ent;
      }
    }
    req.entitlements = entitlements ?? null;
    req.ability = defineAbilitiesFor(authz, entitlements);
  } catch (error) {
    console.error("attachAuthz failed; defaulting to least-privilege:", error);
    const authz: AuthzSubject = { uid, role: "client", agencyId: null };
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
      req.authz?.role !== "admin" &&
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
