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
    const decodedToken = await auth.verifyIdToken(token);
    req.user = decodedToken;
    req.userId = decodedToken.uid;
    await attachAuthz(req);

    // Read-only enforcement: a lapsed/unpaid plan may read but not write. Block
    // mutating methods for non-admin read-only principals; reads pass through.
    // Single chokepoint for every authenticated route (admins + unresolved
    // entitlements are never read-only, so nothing blocks before billing exists).
    const isWrite = !["GET", "HEAD", "OPTIONS"].includes(req.method.toUpperCase());
    if (isWrite && req.authz?.role !== "admin" && isReadOnly(req.entitlements)) {
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
 * Optional auth - sets user if token is valid, but doesn't block request
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
      req.user = decodedToken;
      req.userId = decodedToken.uid;
      await attachAuthz(req);
    } catch {
      // Token invalid, but we don't block the request
      console.log("Optional auth: invalid token provided");
    }
  }

  next();
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
