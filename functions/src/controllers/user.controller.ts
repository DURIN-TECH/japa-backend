import { Response } from "express";
import { AuthenticatedRequest } from "../middleware/auth";
import { userService } from "../services/user.service";
import {
  sendSuccess,
  sendError,
  ErrorMessages,
} from "../utils/response";

export class UserController {
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
