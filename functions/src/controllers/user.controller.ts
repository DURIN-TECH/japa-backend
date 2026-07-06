import { Response } from "express";
import { AuthenticatedRequest } from "../middleware/auth";
import { userService } from "../services/user.service";
import { claimsService } from "../services/claims.service";
import { notificationService } from "../services/notification.service";
import { Role, ROLES, packAbility } from "@durin-tech/authz";
import {
  sendSuccess,
  sendError,
  ErrorMessages,
} from "../utils/response";

// Roles an admin may assign through the role-management endpoint. Sourced from the
// shared authz constants (never hardcoded literals) so the list can't drift.
const ASSIGNABLE_ROLES: Role[] = [ROLES.ADMIN, ROLES.OWNER, ROLES.AGENT, ROLES.CLIENT];

export class UserController {
  /**
   * GET /users/me/authorization
   * Returns the principal's role, agencyId, resolved entitlements, and packed CASL
   * rules so the portal/mobile can rebuild the exact same ability locally for UI
   * gating (the backend remains the authoritative enforcer).
   */
  async getAuthorization(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      if (!req.authz || !req.ability) {
        sendError(res, "UNAUTHORIZED", "Not authenticated", 401);
        return;
      }
      sendSuccess(res, {
        role: req.authz.role,
        agencyId: req.authz.agencyId ?? null,
        entitlements: req.entitlements ?? null,
        rules: packAbility(req.ability),
      });
    } catch (error) {
      console.error("Error building authorization:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  /**
   * PUT /users/:uid/role  (admin only)
   * Set a user's RBAC role + agencyId in their custom claims. This is the manual
   * role-management path (e.g. promoting an admin) before any self-serve flows.
   */
  async setUserRole(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { uid } = req.params;
      const { role, agencyId } = req.body as { role?: Role; agencyId?: string | null };

      if (!role || !ASSIGNABLE_ROLES.includes(role)) {
        sendError(
          res,
          "VALIDATION_ERROR",
          `role is required and must be one of: ${ASSIGNABLE_ROLES.join(", ")}`,
          400
        );
        return;
      }
      // Owners/agents must carry an agencyId; admin/client must not.
      const needsAgency = role === ROLES.OWNER || role === ROLES.AGENT;
      if (needsAgency && !agencyId) {
        sendError(res, "VALIDATION_ERROR", `agencyId is required for role "${role}"`, 400);
        return;
      }

      // Last-admin guard: refuse to demote the final admin. Without this, an admin
      // could change the only remaining admin (possibly themselves) to a lesser role
      // and lock the whole platform out of every admin-only operation — including this
      // very endpoint, making recovery a manual break-glass script run. We only pay for
      // the admin scan when we're actually about to remove admin from a current admin.
      if (role !== ROLES.ADMIN && (await claimsService.isAdmin(uid))) {
        const adminCount = await claimsService.countAdmins();
        if (adminCount <= 1) {
          sendError(
            res,
            "LAST_ADMIN",
            "Cannot change the role of the last remaining admin. Promote another admin first.",
            409
          );
          return;
        }
      }

      await claimsService.setRoleClaims(uid, role, needsAgency ? agencyId : null);

      // Notify the user their access level changed (best-effort).
      await notificationService
        .notifyUser({
          userId: uid,
          type: "role_changed",
          title: "Your account access changed",
          body: `Your role on Seli is now "${role}".`,
        })
        .catch((e) => console.error("[user] role-change notify failed:", e));

      sendSuccess(
        res,
        { uid, role, agencyId: needsAgency ? agencyId : null },
        "User role updated. The user must refresh their token for it to take effect."
      );
    } catch (error) {
      console.error("Error setting user role:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  /**
   * GET /users/me
   * Get current authenticated user's profile
   */
  async getMe(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const userId = req.userId!;
      const user = await userService.getUserById(userId);

      if (!user) {
        // User authenticated but no profile exists yet
        // Return minimal info from token
        sendSuccess(res, {
          id: userId,
          email: req.user?.email || null,
          onboardingCompleted: false,
          needsOnboarding: true,
        });
        return;
      }

      sendSuccess(res, user);
    } catch (error) {
      console.error("Error getting user profile:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  /**
   * PUT /users/me
   * Update current user's profile
   */
  async updateMe(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const userId = req.userId!;
      const updates = req.body;

      // Validate that user exists
      const existingUser = await userService.getUserById(userId);
      if (!existingUser) {
        sendError(res, "NOT_FOUND", "User profile not found", 404);
        return;
      }

      const updatedUser = await userService.updateUser(userId, updates);
      sendSuccess(res, updatedUser, "Profile updated successfully");
    } catch (error) {
      console.error("Error updating user profile:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  /**
   * POST /users/onboarding
   * Complete user onboarding
   */
  async completeOnboarding(
    req: AuthenticatedRequest,
    res: Response
  ): Promise<void> {
    try {
      const userId = req.userId!;
      const { firstName, lastName, email, residentialCountry, hasPassport } =
        req.body;

      // Validate required fields
      if (!firstName || !lastName || !residentialCountry) {
        sendError(
          res,
          "VALIDATION_ERROR",
          "firstName, lastName, and residentialCountry are required",
          400
        );
        return;
      }

      const user = await userService.completeOnboarding(userId, {
        firstName,
        lastName,
        email: email || req.user?.email || "",
        residentialCountry,
        hasPassport: hasPassport ?? false,
      });

      sendSuccess(res, user, "Onboarding completed successfully");
    } catch (error) {
      console.error("Error completing onboarding:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  /**
   * GET /users/onboarding/status
   * Check if user has completed onboarding
   */
  async getOnboardingStatus(
    req: AuthenticatedRequest,
    res: Response
  ): Promise<void> {
    try {
      const userId = req.userId!;
      const completed = await userService.hasCompletedOnboarding(userId);

      sendSuccess(res, { completed });
    } catch (error) {
      console.error("Error checking onboarding status:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  /**
   * POST /users/fcm-token
   * Register FCM token for push notifications
   */
  async registerFcmToken(
    req: AuthenticatedRequest,
    res: Response
  ): Promise<void> {
    try {
      const userId = req.userId!;
      const { token } = req.body;

      if (!token) {
        sendError(res, "VALIDATION_ERROR", "FCM token is required", 400);
        return;
      }

      await userService.addFcmToken(userId, token);
      sendSuccess(res, { registered: true }, "FCM token registered");
    } catch (error) {
      console.error("Error registering FCM token:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  /**
   * DELETE /users/fcm-token
   * Remove FCM token
   */
  async removeFcmToken(
    req: AuthenticatedRequest,
    res: Response
  ): Promise<void> {
    try {
      const userId = req.userId!;
      const { token } = req.body;

      if (!token) {
        sendError(res, "VALIDATION_ERROR", "FCM token is required", 400);
        return;
      }

      await userService.removeFcmToken(userId, token);
      sendSuccess(res, { removed: true }, "FCM token removed");
    } catch (error) {
      console.error("Error removing FCM token:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  /**
   * POST /users/login
   * Record user login (for analytics)
   */
  async recordLogin(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const userId = req.userId!;
      await userService.updateLastLogin(userId);
      sendSuccess(res, { logged: true });
    } catch (error) {
      console.error("Error recording login:", error);
      // Don't fail the login if recording fails
      sendSuccess(res, { logged: false });
    }
  }

  /**
   * DELETE /users/me
   * Delete user account
   */
  async deleteMe(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const userId = req.userId!;

      // In a real app, you'd want to:
      // 1. Check for active applications
      // 2. Handle refunds
      // 3. Notify agents
      // 4. Anonymize or archive data

      await userService.deleteUser(userId);
      sendSuccess(res, { deleted: true }, "Account deleted successfully");
    } catch (error) {
      console.error("Error deleting user:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }
}

export const userController = new UserController();
