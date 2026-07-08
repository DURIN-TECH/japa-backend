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
import { complianceService } from "../services/compliance.service";

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

/**
 * Route guard: require the caller's agency to have PASSED compliance
 * (KYC/KYB/payout verified by an admin) before proceeding.
 *
 * This is the enforcement arm of the compliance callout: an unverified agency
 * can manage its own clients, but it cannot move money on the platform. Apply
 * this to payment-initiating routes.
 *
 * Behaviour:
 *  - Admins always pass.
 *  - A caller with no agency (independent, pre-agency) is blocked — there is no
 *    verified business entity to move money on behalf of.
 *  - Otherwise the agency's compliance must be `verified`.
 *
 * Returns HTTP 403 with a `COMPLIANCE_REQUIRED` code the portal can key off of
 * to surface the verification callout.
 *
 * @param action Human-readable verb used in the error message, e.g.
 *   "request payments" -> "…before you can request payments."
 */
export function requireAgencyVerified(action = "do this") {
  return async (
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ): Promise<void> => {
    if (req.authz?.role === "admin") return next();

    const agencyId = req.authz?.agencyId;
    if (!agencyId) {
      sendError(
        res,
        "COMPLIANCE_REQUIRED",
        `Your agency must complete verification before you can ${action}.`,
        403
      );
      return;
    }

    const verified = await complianceService.isVerified(agencyId);
    if (verified) return next();

    sendError(
      res,
      "COMPLIANCE_REQUIRED",
      `Your agency must complete KYC/KYB verification before you can ${action}. Finish verification under Account Settings → Verification.`,
      403
    );
  };
}
