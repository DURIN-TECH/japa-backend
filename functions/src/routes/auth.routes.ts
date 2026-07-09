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

export { router as authRoutes };
