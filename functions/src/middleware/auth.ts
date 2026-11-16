import { Request, Response, NextFunction } from "express";
import { auth } from "../utils/firebase";
import { DecodedIdToken } from "firebase-admin/auth";
import {
  AGENT_SIDE_ROLES,
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
 * The two custom claims a principal is built from: the role and the agency
 * the account belongs to. Read either from the ID token (the default, no
 * lookup) or from the account's CURRENT custom claims (`optionalAuthFresh`,
 * issue #289).
 */
interface RoleClaims {
  /** The `role` claim; undefined on an account that was never backfilled. */
  role?: Role;
  /** The `agencyId` claim; null / undefined for no agency. */
  agencyId?: string | null;
}

/**
 * Build `req.authz` + `req.ability` from custom claims. When the role
 * claim isn't present yet (pre-migration user), fall back to resolving from the DB
 * and lazily backfill the claims so subsequent tokens carry them. Fail-safe: on
 * any error, default to least-privilege `client` rather than blocking the request.
 *
 * @param claims where the role comes from. Omitted (every caller but
 *   `optionalAuthFresh`): the ID token's own claims, which can be up to an
 *   hour old. Passed: the account's current custom claims, so a demotion
 *   since the token was issued is honoured (issue #289).
 */
async function attachAuthz(req: AuthenticatedRequest, claims?: RoleClaims): Promise<void> {
  const decoded = req.user;
  if (!decoded) return;
  const uid = decoded.uid;
  try {
    // Role source: the explicit (current) claims when given, else the token.
    const source: RoleClaims = claims ?? {
      role: decoded.role as Role | undefined,
      agencyId: decoded.agencyId as string | null | undefined,
    };
    let role = source.role;
    let agencyId = source.agencyId ?? null;

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
 * Issue #345 (product owner decision, 2026-11-15): money an agent or agency
 * owner EARNED while their plan was active stays theirs after the plan lapses.
 * So two money writes are exempt from the read-only (lapsed plan) write block
 * in `verifyAuth`, the same way password change and account deletion are:
 *
 *  1. `POST /bank-accounts/withdraw`: withdraw the balance already earned.
 *  2. `PUT /payment-requests/<id>/status` with a JSON body whose `status` is
 *     exactly the string `"cancelled"`: cancel (withdraw) one's own unpaid
 *     payment request (noted in the #283 review).
 *
 * The match is deliberately narrow, because anything it lets through skips
 * the plan check:
 *  - method AND the whole path must match (anchored regex, NOT `endsWith`),
 *    so `PUT /applications/<id>/status`, `POST /applications/<id>/withdraw`
 *    or `/x/bank-accounts/withdraw` are NOT exempt. Like the feedback
 *    exemption, only the optional `/api` function prefix and one trailing
 *    slash are tolerated. The match is case-sensitive: a differently-cased
 *    URL is simply not exempt (it fails closed with the usual 402);
 *  - `<id>` is exactly one non-empty path segment (no `/`);
 *  - for the cancel, the body must be a plain JSON object with
 *    `status === "cancelled"`. A missing body, a non-object body (string,
 *    array, null) or any other / missing status (`"paid"`, `"pending"`,
 *    `"CANCELLED"`, `["cancelled"]`...) is NOT exempt. `express.json()` runs
 *    before the routers (`app.ts`), so `req.body` is already parsed here.
 *
 * This only skips the PLAN check. Every check inside the two handlers still
 * runs (role, amount, own bank account, balance; creating agent, unpaid,
 * no payment in flight). Adding / choosing / removing a bank account stays
 * blocked on a lapsed plan (#359).
 *
 * Exported (pure, no I/O) so the near misses can be unit tested directly.
 *
 * @param method the HTTP method (any case)
 * @param path   the app-root path with the query string already stripped
 * @param body   the parsed request body (`req.body`), whatever it is
 * @returns true only for the two writes above
 */
export function isEarnedMoneyWrite(method: string, path: string, body: unknown): boolean {
  const verb = method.toUpperCase();

  // 1. Withdraw earned balance: POST, exact path. The body (bank account,
  //    amount) is validated by the controller, not here.
  if (verb === "POST" && /^(\/api)?\/bank-accounts\/withdraw\/?$/.test(path)) {
    return true;
  }

  // 2. Cancel one's own unpaid payment request: PUT, exact path with a
  //    single-segment id, and a body that asks for exactly "cancelled".
  if (verb === "PUT" && /^(\/api)?\/payment-requests\/[^/]+\/status\/?$/.test(path)) {
    // A missing or non-object body is never exempt (arrays are objects in
    // JS, so they are ruled out by name).
    if (typeof body !== "object" || body === null || Array.isArray(body)) return false;
    return (body as Record<string, unknown>).status === "cancelled";
  }

  return false;
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
      (method === "POST" && path.endsWith("/users/me/ai-message-access/notice-dismissed")) ||
      // Earned money (#345, product owner decision 2026-11-15): withdrawing
      // the balance already earned (`POST /bank-accounts/withdraw`) and
      // cancelling one's own unpaid payment request
      // (`PUT /payment-requests/<id>/status` with body status "cancelled")
      // still work on a lapsed plan. Method + EXACT path (+ body for the
      // cancel); see `isEarnedMoneyWrite` for the near misses that stay 402.
      isEarnedMoneyWrite(method, path, req.body);

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

// ============================================
// Stricter optional auth (issue #289)
// ============================================

/**
 * The custom-claim keys that say who an account is and whether it may be
 * served. On the strict path these are taken from the account's CURRENT
 * claims, never from the (possibly stale) ID token.
 */
const IDENTITY_CLAIM_KEYS = ["role", "agencyId", "admin", "agent", "disabled"] as const;

/**
 * True when a set of claims makes the holder agent side: the canonical `role`
 * claim is admin, owner or agent, or one of the legacy boolean claims
 * (`admin`, `agent`) that predate it is set. Only such tokens can unlock more
 * than a guest sees on the single-visa reads (the CASL `read` grant on a
 * hidden visa goes to admins and the owning agency's members), so only they
 * pay for the fresh lookup in `optionalAuthFresh`.
 */
function claimsAreAgentSide(claims: Record<string, unknown>): boolean {
  return (
    (AGENT_SIDE_ROLES as readonly unknown[]).includes(claims.role) ||
    claims.admin === true ||
    !!claims.agent
  );
}

/**
 * The account's CURRENT custom claims, or null when the caller must be served
 * as a guest. Two Auth lookups (hence only for agent-side tokens, on the
 * routes that need it):
 *  1. `verifyIdToken(token, true)`: rejects a token issued before the
 *     account's refresh tokens were revoked (what a suspension does, see
 *     `claimsService.setAccountDisabled`) and a disabled Firebase user;
 *  2. `getUser(uid)`: the claims as they are NOW. A suspension shows up as
 *     `disabled: true` here even when the token was minted in the same second
 *     as the revocation (which the revocation check alone would let through),
 *     and a demotion (which revokes nothing) shows up as the lower `role`.
 *
 * Any failure (revoked, user deleted, network, quota) throws to the caller,
 * which serves a guest: the token's own claims are never a fallback.
 */
async function currentClaimsOrNull(
  token: string,
  uid: string
): Promise<Record<string, unknown> | null> {
  // 1. Still a live session? Throws when revoked or the user is disabled.
  await auth.verifyIdToken(token, true);
  // 2. Who the account is now.
  const account = await auth.getUser(uid);
  const current = (account.customClaims ?? {}) as Record<string, unknown>;
  // A disabled Firebase user, or the suspension claim: not served as signed in.
  if (account.disabled === true || current.disabled === true) return null;
  return current;
}

/**
 * `optionalAuth` for the public routes that give a signed-in caller MORE than
 * a guest sees: today the three single-visa reads, where an admin or a member
 * of the owning agency is served hidden visas (issue #289).
 *
 * Why plain `optionalAuth` is not enough there: it trusts the ID token's
 * claims without a revocation check, and a token lives up to an hour. So a
 * suspended admin or agency member (tokens revoked, but the old token has no
 * `disabled` claim) and a demoted admin (nothing revoked, old token still
 * says `role: "admin"`) kept reading hidden visas until the token expired.
 *
 * What this does instead, never blocking the request (same contract as
 * `optionalAuth`, and the same #286 rule: anything short of a valid, enabled
 * token is a guest with no half-set identity):
 *  - no / non-Bearer header, an invalid token, a `disabled` token claim:
 *    guest, exactly as `optionalAuth`;
 *  - a token whose claims are NOT agent side (`client`, or no role claim):
 *    the cheap path, unchanged. No revocation check and no account lookup.
 *    Such a caller only reaches a hidden visa through their own applications,
 *    which is decided from the database, not from the token's role;
 *  - a token whose claims ARE agent side (role admin / owner / agent, or the
 *    legacy `admin` / `agent` claims): the token is re-verified with
 *    `checkRevoked`, and `req.authz` / `req.ability` are built from the
 *    account's CURRENT custom claims (`auth.getUser`). So a suspended account
 *    is a guest at once, and a demoted admin is served as their current role;
 *  - if that lookup fails for ANY reason (revoked, user deleted, network):
 *    guest. Never a 500, and never the token's claims.
 *
 * Cost: two Auth calls per request, only for agent-side tokens, only on the
 * routes that use this middleware. The pricing-only public reads (agencies,
 * agents, news) keep `optionalAuth`.
 */
export async function optionalAuthFresh(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  const authHeader = req.headers.authorization;

  if (authHeader?.startsWith("Bearer ")) {
    const token = authHeader.split("Bearer ")[1];
    try {
      // Signature / expiry / project check only (local, no Auth call).
      const decodedToken = await auth.verifyIdToken(token);
      if (decodedToken.disabled === true) {
        // A disabled account is not served as signed in (#286).
        clearIdentity(req);
      } else if (!claimsAreAgentSide(decodedToken)) {
        // ---- Cheap path: identical to optionalAuth ----
        req.user = decodedToken;
        req.userId = decodedToken.uid;
        await attachAuthz(req);
      } else {
        // ---- Strict path: answer from the account's current state ----
        const current = await currentClaimsOrNull(token, decodedToken.uid);
        if (!current) {
          // Suspended / disabled since the token was issued: guest.
          clearIdentity(req);
        } else {
          // `req.user` keeps the verified token's standard fields (uid,
          // email, ...) but every identity claim is replaced by the current
          // one, so nothing downstream can read a stale `role` or `admin`
          // off it (e.g. `isAgentSideRequest`, `verifyAdmin`).
          const user = { ...decodedToken } as DecodedIdToken;
          for (const key of IDENTITY_CLAIM_KEYS) {
            delete user[key];
            if (current[key] !== undefined) user[key] = current[key];
          }
          req.user = user;
          req.userId = decodedToken.uid;
          // A current account with no `role` claim yet (legacy `admin: true`
          // only) is resolved from server-written state inside attachAuthz,
          // as on every other route.
          await attachAuthz(req, {
            role: current.role as Role | undefined,
            agencyId: current.agencyId as string | null | undefined,
          });
        }
      }
    } catch (error) {
      // Invalid or revoked token, deleted user, or the Auth lookup failed:
      // serve the request as a guest, with no identity set at all. Only the
      // error code is logged (never the token).
      clearIdentity(req);
      console.log(
        "Optional auth (fresh): serving as guest:",
        (error as { code?: string })?.code ?? "invalid token or lookup failure"
      );
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
