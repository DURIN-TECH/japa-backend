/**
 * Authorization helpers for controllers — thin wrappers over the CASL ability
 * attached to the request (`req.ability`, built in `verifyAuth`/`attachAuthz`).
 *
 * Usage in a handler:
 *   if (!can(req, "update", asSubject("Application", app))) return forbidden(res);
 */
import { Response, NextFunction } from "express";
import {
  Action,
  AppAbility,
  FeatureKey,
  LimitKey,
  hasFeature,
  isWithinLimit,
  subject as caslSubject,
  SubjectType,
} from "@durin-tech/authz";
import { AuthenticatedRequest } from "./auth";
import { sendError } from "../utils/response";

/** Tag a plain resource object with its CASL subject type for condition matching. */
export function asSubject<T extends Record<PropertyKey, unknown>>(
  type: SubjectType,
  resource: T
): T {
  return caslSubject(type, resource) as T;
}

/** True if the request's principal can perform `action` on `resource`. */
export function can(
  req: AuthenticatedRequest,
  action: Action,
  resource: Parameters<AppAbility["can"]>[1]
): boolean {
  return req.ability?.can(action, resource) ?? false;
}

/** Send a standardized 403. */
export function forbidden(res: Response, message = "You do not have access to this resource"): void {
  sendError(res, "FORBIDDEN", message, 403);
}

/** Send a standardized 402 (payment/subscription required) for locked features. */
export function paymentRequired(res: Response, message: string): void {
  sendError(res, "UPGRADE_REQUIRED", message, 402);
}

/**
 * Route guard: require the principal's plan to include `feature`. Returns 402 with
 * an upgrade hint when locked.
 *
 * Safe-rollout: admins bypass, and when no entitlements are resolved yet (pre-seed /
 * no plan assigned) gating is OFF — matching the ability factory + frontend, so
 * nothing 402s before plans exist. Once entitlements are populated, it enforces.
 */
export function requireFeature(feature: FeatureKey) {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
    if (req.authz?.role === "admin") return next();
    if (!req.entitlements) return next(); // ungated until a plan is resolved
    if (hasFeature(req.entitlements, feature)) return next();
    paymentRequired(res, `Your plan does not include "${feature}". Upgrade to unlock it.`);
  };
}

/**
 * Check a numeric limit against current usage. Call inside a handler once you've
 * counted current usage, e.g.:
 *   if (!checkWithinLimit(req, "max_active_applications", count)) return paymentRequired(res, ...)
 *
 * Safe-rollout: admins and not-yet-resolved entitlements pass (treated as unlimited)
 * so limits only bite once a plan is assigned.
 */
export function checkWithinLimit(
  req: AuthenticatedRequest,
  limit: LimitKey,
  currentCount: number
): boolean {
  if (req.authz?.role === "admin") return true;
  if (!req.entitlements) return true; // ungated until a plan is resolved
  return isWithinLimit(req.entitlements, limit, currentCount);
}
