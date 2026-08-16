import { Response } from "express";
import { AuthenticatedRequest } from "../middleware/auth";
import { userService } from "../services/user.service";
import { storageService } from "../services/storage.service";
import { claimsService } from "../services/claims.service";
import { notificationService } from "../services/notification.service";
import { emailService } from "../services/email/email.service";
import { EMAIL_BRANDING } from "../services/email/branding";
import { auth } from "../utils/firebase";
import { Role, ROLES, packAbility } from "@durin-tech/authz";
import {
  sendSuccess,
  sendError,
  ErrorMessages,
} from "../utils/response";

// Basic email shape check, reused by the account-security endpoints below. Mirrors
// the validation used in auth.controller (a malformed/blank email is a client bug,
// not an enumeration signal, so rejecting it leaks nothing).
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Mask an email for display in a security notice ("a***@example.com") so the OLD
// address is told WHERE the account is moving without echoing the full new address
// back to a channel the requester may not control.
function maskEmail(email: string): string {
  const [local, domain] = email.split("@");
  if (!domain) return email;
  const head = local.slice(0, 1);
  return `${head}${"*".repeat(Math.max(1, local.length - 1))}@${domain}`;
}

// Roles an admin may assign through the role-management endpoint. Sourced from the
// shared authz constants (never hardcoded literals) so the list can't drift.
const ASSIGNABLE_ROLES: Role[] = [ROLES.ADMIN, ROLES.OWNER, ROLES.AGENT, ROLES.CLIENT];

// Image MIME types accepted for a user's profile photo (avatar). Restricted to
// the raster formats that render reliably in <img> — no SVG (XSS surface) and no
// HEIC (browsers can't display it inline).
const ALLOWED_PHOTO_CONTENT_TYPES = ["image/png", "image/jpeg", "image/webp"];

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
   * GET /admin/users  (admin only)
   * List every user with their joined details (identity, role, agency, plan,
   * status, timestamps) for the admin directory.
   */
  async listAllUsers(_req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const users = await userService.listAllUsers();
      sendSuccess(res, users);
    } catch (error) {
      console.error("Error listing all users:", error);
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
   * POST /users/me/photo/upload-url
   * Mint a short-lived signed URL the client uses to PUT the profile photo
   * directly to Cloud Storage. Finalized via POST /users/me/photo afterwards.
   */
  async getPhotoUploadUrl(
    req: AuthenticatedRequest,
    res: Response
  ): Promise<void> {
    try {
      const userId = req.userId!;
      const { fileName, contentType } = req.body;

      if (!fileName || !contentType) {
        sendError(res, "VALIDATION_ERROR", "fileName and contentType are required", 400);
        return;
      }

      // Reject anything that isn't an allowed image type before minting a URL.
      if (!ALLOWED_PHOTO_CONTENT_TYPES.includes(contentType)) {
        sendError(
          res,
          "VALIDATION_ERROR",
          `Invalid content type. Allowed: ${ALLOWED_PHOTO_CONTENT_TYPES.join(", ")}`,
          400
        );
        return;
      }

      const result = await storageService.getSignedProfilePhotoUploadUrl(
        userId,
        fileName,
        contentType
      );

      sendSuccess(res, result);
    } catch (error) {
      console.error("Error getting profile photo upload URL:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  /**
   * POST /users/me/photo
   * Finalize a profile photo upload: confirm the file exists, verify it lives
   * under this user's own profile prefix, make it publicly readable, and persist
   * the durable public URL onto the user. Returns the updated user profile.
   */
  async setPhoto(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const userId = req.userId!;
      const { storagePath } = req.body;

      if (!storagePath) {
        sendError(res, "VALIDATION_ERROR", "storagePath is required", 400);
        return;
      }

      // Guard against registering a path that isn't theirs — the path must live
      // under this user's own profile prefix.
      if (!storagePath.startsWith(`users/${userId}/profile/`)) {
        sendError(res, "VALIDATION_ERROR", "storagePath does not belong to this user", 400);
        return;
      }

      // Confirm the client actually completed the upload.
      const exists = await storageService.fileExists(storagePath);
      if (!exists) {
        sendError(res, "VALIDATION_ERROR", "File not found at the specified path", 400);
        return;
      }

      // Make the object public and capture its stable URL for persistent rendering
      // (avatars appear in the header/sidebar on every page, so a short-lived
      // signed download URL would expire — mirrors the agency-logo flow).
      const profilePhotoUrl = await storageService.makeFilePublic(storagePath);

      const updatedUser = await userService.updateUser(userId, { profilePhotoUrl });

      sendSuccess(res, updatedUser, "Profile photo updated successfully");
    } catch (error) {
      console.error("Error setting profile photo:", error);
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
  /**
   * POST /users/me/password-changed
   *
   * Fires the branded "your password was changed" SECURITY notice. The password
   * itself is changed entirely client-side via Firebase Auth (reauthenticate +
   * updatePassword) — it never touches the backend. The client calls this endpoint
   * AFTER a successful change so the account owner gets an out-of-band heads-up:
   * if they didn't make the change, that email is their signal to react.
   *
   * Best-effort: a delivery failure never fails the request (the password is
   * already changed; we just log the miss). Rides `notifyUser`, so the same event
   * also lands in-app + push per the channel policy.
   */
  async notifyPasswordChanged(
    req: AuthenticatedRequest,
    res: Response
  ): Promise<void> {
    try {
      const userId = req.userId!;
      await notificationService
        .notifyUser({
          userId,
          type: "password_changed",
          title: "Your password was changed",
          body:
            `The password for your ${EMAIL_BRANDING.appName} account was just ` +
            "changed. If this was you, no action is needed.\n\n" +
            "If you did NOT change your password, reset it immediately from the " +
            "sign-in screen and contact support — your account may be at risk.",
          // Security alert — deliver the email even if the user has opted out of
          // email notifications. They can't silence an alert about their own account.
          critical: true,
        })
        .catch((e) =>
          console.error("[user] password-changed notify failed:", e)
        );
      sendSuccess(res, { notified: true }, "Password change confirmed");
    } catch (error) {
      console.error("Error sending password-changed notice:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  /**
   * POST /users/me/change-email
   * Body: { newEmail: string }
   *
   * Starts a branded, verification-gated email-change flow:
   *   1. Mint a Firebase "verify-and-change" link for (currentEmail → newEmail)
   *      with the Admin SDK. The change only takes effect once the user clicks it,
   *      so we never trust an unverified address.
   *   2. Send that link — Seli-branded (Resend) — to the NEW address to confirm.
   *   3. Send a branded SECURITY notice to the OLD address so an attacker who got
   *      a session can't silently move the account out from under the owner.
   *
   * We deliberately DON'T mutate Firestore here: the email only flips after the
   * user verifies, and the profile reconciles from the token on next sign-in.
   * Reauthentication is enforced client-side (recent password) before this call.
   */
  async changeEmail(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const userId = req.userId!;
      const rawEmail = (req.body?.newEmail ?? "") as string;
      const newEmail = rawEmail.trim().toLowerCase();

      // Validate the target address shape up front.
      if (!newEmail || !EMAIL_RE.test(newEmail)) {
        sendError(res, "VALIDATION_ERROR", "A valid new email address is required", 400);
        return;
      }

      // Resolve the current (authoritative) email from the Auth record — not the
      // Firestore profile, which can lag. generateVerifyAndChangeEmailLink requires
      // the FROM address to match the account's current email.
      const userRecord = await auth.getUser(userId);
      const currentEmail = (userRecord.email ?? "").toLowerCase();
      if (!currentEmail) {
        sendError(res, "VALIDATION_ERROR", "Your account has no email to change", 400);
        return;
      }
      if (currentEmail === newEmail) {
        sendError(res, "VALIDATION_ERROR", "That is already your email address", 400);
        return;
      }

      // Refuse if the target address already belongs to another account. getUserByEmail
      // throws auth/user-not-found when it's free — the only case we want to proceed.
      try {
        await auth.getUserByEmail(newEmail);
        sendError(res, "CONFLICT", "That email address is already in use", 409);
        return;
      } catch (err: unknown) {
        const code = (err as { code?: string }).code || "";
        if (code !== "auth/user-not-found" && code !== "auth/email-not-found") {
          throw err; // a real lookup failure, not "address is free"
        }
      }

      // Mint the verify-and-change link (change is applied by Firebase only after
      // the user clicks it from the new inbox).
      const changeLink = await auth.generateVerifyAndChangeEmailLink(
        currentEmail,
        newEmail
      );

      // 1) Confirmation to the NEW address (carries the actionable link).
      const confirmResult = await emailService.sendNotification({
        to: newEmail,
        subject: `Confirm your new ${EMAIL_BRANDING.appName} email`,
        title: "Confirm your new email address",
        body:
          `You asked to use this address for your ${EMAIL_BRANDING.appName} ` +
          "account. Click the button below to confirm the change. Until you do, " +
          "your account keeps its current email.\n\n" +
          "If you didn't request this, you can safely ignore this email.",
        actionUrl: changeLink,
        actionLabel: "Confirm email change",
        preheader: `Confirm your new ${EMAIL_BRANDING.appName} email address`,
      });
      if (confirmResult.status !== "sent") {
        console.error(
          `[user:change-email] confirmation email to ${newEmail} was not sent ` +
            `(status=${confirmResult.status}${confirmResult.error ? `: ${confirmResult.error}` : ""}).`
        );
      }

      // 2) Security heads-up to the OLD address (no link — informational only).
      await emailService
        .sendNotification({
          to: currentEmail,
          subject: `Security alert: email change requested on ${EMAIL_BRANDING.appName}`,
          title: "Email change requested",
          body:
            `A request was made to change the email on your ${EMAIL_BRANDING.appName} ` +
            `account to ${maskEmail(newEmail)}. The change only completes once it's ` +
            "confirmed from the new address.\n\n" +
            "If this wasn't you, reset your password immediately and contact support " +
            "— someone may have access to your account.",
          preheader: "Was this you? A change to your account email was requested.",
        })
        .catch((e) =>
          console.error("[user:change-email] old-address notice failed:", e)
        );

      sendSuccess(
        res,
        { sent: true },
        "Check your new email inbox to confirm the change."
      );
    } catch (error) {
      console.error("Error starting email change:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  /**
   * PATCH /users/me/notification-preferences
   * Body: { email?: boolean, push?: boolean }
   *
   * Update which channels this user receives non-critical notifications on. A
   * partial body is allowed (toggle one channel at a time); omitted fields keep
   * their current value. `in_app` is always delivered and can't be turned off here.
   * Security-critical emails (e.g. password changed) ignore these preferences.
   */
  async updateNotificationPreferences(
    req: AuthenticatedRequest,
    res: Response
  ): Promise<void> {
    try {
      const userId = req.userId!;
      const { email, push } = req.body as { email?: unknown; push?: unknown };

      // Accept only booleans for the fields that are present; reject anything else
      // so a malformed toggle can't write garbage into the prefs object.
      const prefs: Partial<{ email: boolean; push: boolean }> = {};
      if (email !== undefined) {
        if (typeof email !== "boolean") {
          sendError(res, "VALIDATION_ERROR", "`email` must be a boolean", 400);
          return;
        }
        prefs.email = email;
      }
      if (push !== undefined) {
        if (typeof push !== "boolean") {
          sendError(res, "VALIDATION_ERROR", "`push` must be a boolean", 400);
          return;
        }
        prefs.push = push;
      }
      if (prefs.email === undefined && prefs.push === undefined) {
        sendError(
          res,
          "VALIDATION_ERROR",
          "Provide at least one of `email` or `push`",
          400
        );
        return;
      }

      const updated = await userService.updateNotificationPreferences(userId, prefs);
      sendSuccess(
        res,
        updated.notificationPreferences ?? { email: true, push: true },
        "Notification preferences updated"
      );
    } catch (error) {
      console.error("Error updating notification preferences:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

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

      // Capture the email BEFORE we delete anything — once the profile + Auth user
      // are gone there's nothing left to address the confirmation to. Prefer the
      // authoritative Auth record, fall back to the Firestore profile.
      let email: string | undefined;
      try {
        const rec = await auth.getUser(userId);
        email = rec.email ?? undefined;
      } catch {
        // Auth record may already be gone / unreadable — fall back below.
      }
      if (!email) {
        const profile = await userService.getUserById(userId);
        email = profile?.email;
      }

      // Send the branded "your account was deleted" confirmation FIRST (direct
      // send — `notifyUser` can't be used once the profile/tokens are deleted).
      // Best-effort: a delivery miss must not block the deletion the user asked for.
      if (email) {
        await emailService
          .sendNotification({
            to: email,
            subject: `Your ${EMAIL_BRANDING.appName} account was deleted`,
            title: "Your account was deleted",
            body:
              `Your ${EMAIL_BRANDING.appName} account and personal data have been ` +
              "deleted as requested. We're sorry to see you go.\n\n" +
              "If you did NOT request this, contact support immediately — your " +
              "account may have been compromised.",
            preheader: `Your ${EMAIL_BRANDING.appName} account has been deleted`,
          })
          .catch((e) =>
            console.error("[user:delete] confirmation email failed:", e)
          );
      }

      // Remove the Firestore profile. (Deeper cleanup — applications, documents,
      // refunds, agent notifications — is intentionally out of scope here and left
      // as a follow-up; this covers the account + credential.)
      await userService.deleteUser(userId);

      // Delete the Firebase Auth user too, so the credential can't sign back in and
      // recreate an orphaned session. Best-effort: the profile is already gone, so
      // don't fail the request if the Auth deletion hiccups (it can be reconciled).
      await auth
        .deleteUser(userId)
        .catch((e) => console.error("[user:delete] auth user delete failed:", e));

      sendSuccess(res, { deleted: true }, "Account deleted successfully");
    } catch (error) {
      console.error("Error deleting user:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }
}

export const userController = new UserController();
