import { Router } from "express";
import { authController } from "../controllers/auth.controller";

/**
 * Auth routes — PUBLIC (unauthenticated) auth flows only.
 *
 * These are intentionally mounted WITHOUT `verifyAuth`: the whole point of
 * "forgot password" is that the user can't sign in, so there's no token to
 * verify. (Note also that `verifyAuth` enforces a read-only-plan 402 block on
 * non-GET requests, which would wrongly reject a legitimate forgot-password POST.)
 *
 * Sign-in / sign-up stay client-side via Firebase Auth; this router only exists
 * for the server-owned pieces of the password-reset flow.
 */
const router = Router();

// Start the branded password-reset email flow.
router.post("/forgot-password", (req, res) =>
  authController.forgotPassword(req, res)
);

// Send (or re-send) the branded "verify your email" message. Public + enumeration
// safe, mirroring forgot-password: the client just supplies the address to verify.
router.post("/resend-verification", (req, res) =>
  authController.resendEmailVerification(req, res)
);

// "Claim your account" — first-run set-a-password link for a client whose account
// was provisioned by an agent. Same one-time code as a reset, but framed (and
// landed at /claim) for someone who never signed up themselves.
router.post("/claim-account", (req, res) =>
  authController.claimAccount(req, res)
);

// Passwordless fallback — email a one-tap sign-in link. See the controller for the
// Firebase Authorized-domains / email-link-provider prerequisites.
router.post("/magic-link", (req, res) => authController.magicLink(req, res));

export { router as authRoutes };
