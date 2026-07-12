import { Request, Response } from "express";
import { auth } from "../utils/firebase";
import { emailService } from "../services/email/email.service";
import { EMAIL_BRANDING } from "../services/email/branding";
import { EmailResult } from "../services/email/email.types";
import { sendSuccess, sendError, ErrorMessages } from "../utils/response";

/**
 * Inspect the result of a transactional email send and log LOUDLY when it didn't
 * actually go out. The Resend provider is deliberately non-throwing (`skipped`
 * when unconfigured, `failed` on a provider error such as an unverified sender
 * domain) so a delivery problem never 500s a security flow — but that also means
 * a silent no-send is invisible unless we surface it here. We keep returning the
 * generic success response to the caller (enumeration protection / UX), while
 * making the operational failure obvious in Cloud Functions logs.
 *
 * Returns `true` when the email was actually accepted by the provider.
 */
function logEmailOutcome(flow: string, to: string, result: EmailResult): boolean {
  if (result.status === "sent") return true;
  if (result.status === "skipped") {
    // Email provider not configured (missing RESEND_API_KEY / EMAIL_FROM secret).
    console.error(
      `[auth:${flow}] email NOT sent to ${to} — provider is not configured ` +
        "(check RESEND_API_KEY / EMAIL_FROM function secrets)."
    );
  } else {
    // Provider rejected the send (most commonly a 403: unverified sender domain).
    console.error(
      `[auth:${flow}] email send FAILED to ${to} — ${result.error ?? "unknown provider error"} ` +
        "(check that the EMAIL_FROM domain is verified in Resend)."
    );
  }
  return false;
}

/**
 * AuthController — the small set of *public* (unauthenticated) auth flows that
 * the backend owns. Sign-in / sign-up themselves stay client-side (Firebase Auth
 * on the portal + mobile); the backend only steps in where we need something the
 * client can't do securely on its own — here, minting a password-reset link with
 * the Admin SDK so we can deliver a fully white-labelled (Seli-branded) reset
 * email through our own Resend pipeline instead of Firebase's stock template.
 */
class AuthController {
  /**
   * POST /auth/forgot-password
   * Body: { email: string }
   *
   * Kicks off the "forgot password" flow:
   *   1. Generate a Firebase password-reset link with the Admin SDK.
   *   2. Extract the one-time `oobCode` from that link and rebuild it as a link
   *      into OUR OWN reset page (`${APP_URL}/reset-password?oobCode=…`) so the
   *      entire experience — email AND landing page — is Seli-branded. The portal
   *      /reset-password page completes the reset client-side via
   *      `confirmPasswordReset(oobCode, newPassword)`.
   *   3. Send that link through the branded email template (Resend).
   *
   * SECURITY — account-enumeration protection: this endpoint ALWAYS responds with
   * the same generic success message, whether or not the email maps to a real
   * account. If we returned a different response for unknown emails, an attacker
   * could probe which addresses have Seli accounts. So a missing user is treated
   * as a silent no-op (we simply don't send an email), and the caller can't tell
   * the difference. For the same reason we never surface Firebase's raw error.
   */
  async forgotPassword(req: Request, res: Response): Promise<void> {
    // The message we return in the happy path AND when the account doesn't exist —
    // identical on purpose (see the enumeration note above).
    const GENERIC_OK =
      "If an account exists for that email, we've sent a link to reset your password.";

    try {
      const rawEmail = (req.body?.email ?? "") as string;
      const email = rawEmail.trim().toLowerCase();

      // Basic shape validation. This is the ONE case where we DO reject — a
      // malformed/blank email is a client bug, not an enumeration signal, so
      // there's no account to protect.
      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        sendError(res, "VALIDATION_ERROR", "A valid email address is required");
        return;
      }

      // Where the branded reset link should point. Per-environment via APP_URL
      // (dev portal vs prod portal); falls back to the prod portal domain. NOTE:
      // the oobCode is scoped to THIS backend's Firebase project, so APP_URL must
      // point at the portal wired to the same project (e.g. locally set
      // APP_URL=http://localhost:3000 in functions/.env.local).
      const appUrl = EMAIL_BRANDING.appUrl;

      // Generate the reset link. We deliberately DON'T pass actionCodeSettings:
      //   - We only need the one-time `oobCode`; we build our own link below, so a
      //     `continueUrl` would be dead weight.
      //   - Passing a `url` requires that domain to be in Firebase's Authorized
      //     domains list, or the call throws auth/unauthorized-continue-uri.
      //     Omitting it sidesteps that per-domain config entirely.
      // This THROWS for unknown accounts (auth/user-not-found /
      // auth/email-not-found) — which we swallow below so the response stays
      // identical to the success case.
      let resetUrl: string;
      try {
        const firebaseLink = await auth.generatePasswordResetLink(email);

        // Firebase returns a link to its own action handler, e.g.
        //   https://<project>.firebaseapp.com/__/auth/action?mode=resetPassword&oobCode=XYZ&apiKey=…
        // We only need the one-time `oobCode`; we re-point it at our own branded
        // reset page so no Firebase-hosted surface is ever shown to the user.
        const oobCode = new URL(firebaseLink).searchParams.get("oobCode");
        // Extremely unlikely (Firebase always includes oobCode), but if the shape
        // ever changes, fall back to the raw link so the user isn't stranded — it
        // still resolves via Firebase's own handler.
        resetUrl = oobCode
          ? `${appUrl}/reset-password?oobCode=${encodeURIComponent(oobCode)}`
          : firebaseLink;
      } catch (err: unknown) {
        const code = (err as { code?: string }).code || "";
        if (
          code === "auth/user-not-found" ||
          code === "auth/email-not-found"
        ) {
          // No such account — silently succeed (enumeration protection).
          sendSuccess(res, { sent: true }, GENERIC_OK);
          return;
        }
        // Anything else (e.g. transient Admin SDK failure) is a real error.
        throw err;
      }

      // Deliver the branded reset email. `sendNotification` renders the shared
      // Seli template (logo, brand accent, CTA button) around this content.
      const result = await emailService.sendNotification({
        to: email,
        subject: `Reset your ${EMAIL_BRANDING.appName} password`,
        title: "Reset your password",
        body:
          "We received a request to reset the password for your " +
          `${EMAIL_BRANDING.appName} account. Click the button below to choose a ` +
          "new password. This link will expire in 1 hour.\n\n" +
          "If you didn't request this, you can safely ignore this email — your " +
          "password won't change.",
        actionUrl: resetUrl,
        actionLabel: "Reset password",
        preheader: `Reset your ${EMAIL_BRANDING.appName} password`,
      });
      // Surface (but don't leak) a delivery failure: the response stays generic
      // for the user, but ops can see in the logs that nothing was actually sent.
      logEmailOutcome("forgot-password", email, result);

      sendSuccess(res, { sent: true }, GENERIC_OK);
    } catch (error) {
      console.error("forgotPassword error:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  /**
   * POST /auth/resend-verification
   * Body: { email: string }
   *
   * Sends (or re-sends) a branded "verify your email" message. Sign-up happens
   * client-side with Firebase Auth, which does NOT send a verification email by
   * default and — even if enabled — would use Firebase's stock, unbranded
   * template. So, exactly like the reset flow, we mint the verification link with
   * the Admin SDK and deliver it through our own Resend pipeline.
   *
   * The link points at Firebase's own action handler (it verifies the address and
   * shows a confirmation page), so this works with zero extra hosted pages. The
   * email around it is fully Seli-branded.
   *
   * Enumeration-safe (same posture as forgotPassword): always returns the same
   * generic success, whether or not the address maps to an unverified account.
   */
  async resendEmailVerification(req: Request, res: Response): Promise<void> {
    // Identical happy-path / unknown-account response (see enumeration note above).
    const GENERIC_OK =
      "If that email needs verifying, we've sent a verification link to it.";

    try {
      const rawEmail = (req.body?.email ?? "") as string;
      const email = rawEmail.trim().toLowerCase();

      // Reject only a malformed/blank email — a client bug, not an account signal.
      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        sendError(res, "VALIDATION_ERROR", "A valid email address is required");
        return;
      }

      // Mint the verification link. Unlike the reset flow we keep Firebase's own
      // link as-is: its action handler verifies the email and shows a confirmation
      // page, so no custom landing page is required. Throws auth/user-not-found for
      // unknown accounts, which we swallow (enumeration protection).
      let verifyUrl: string;
      try {
        verifyUrl = await auth.generateEmailVerificationLink(email);
      } catch (err: unknown) {
        const code = (err as { code?: string }).code || "";
        if (
          code === "auth/user-not-found" ||
          code === "auth/email-not-found"
        ) {
          sendSuccess(res, { sent: true }, GENERIC_OK);
          return;
        }
        throw err;
      }

      // Deliver the branded verification email through the shared Seli template.
      const result = await emailService.sendNotification({
        to: email,
        subject: `Verify your ${EMAIL_BRANDING.appName} email`,
        title: "Verify your email address",
        body:
          `Welcome to ${EMAIL_BRANDING.appName}! Please confirm this is your email ` +
          "address by clicking the button below. Verifying helps keep your account " +
          "secure and ensures you receive important updates about your applications.\n\n" +
          "If you didn't create an account, you can safely ignore this email.",
        actionUrl: verifyUrl,
        actionLabel: "Verify email",
        preheader: `Confirm your ${EMAIL_BRANDING.appName} email address`,
      });
      logEmailOutcome("resend-verification", email, result);

      sendSuccess(res, { sent: true }, GENERIC_OK);
    } catch (error) {
      console.error("resendEmailVerification error:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }
}

// Singleton — matches the pattern used by every other controller in this app.
export const authController = new AuthController();
