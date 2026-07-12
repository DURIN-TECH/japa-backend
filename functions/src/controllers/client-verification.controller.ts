import { Response } from "express";
import { AuthenticatedRequest } from "../middleware/auth";
import { clientVerificationService } from "../services/client-verification.service";
import { notificationService } from "../services/notification.service";
import { sendSuccess, sendError, ErrorMessages } from "../utils/response";

// ============================================
// CLIENT VERIFICATION CONTROLLER (applicant KYC)
// ============================================
//
// The applicant-facing identity-verification surface used by the mobile app:
//   GET  /users/me/verification            → current identity-verification status
//   POST /users/me/verification/identity   → submit a NIN/BVN (+ explicit consent)
//
// Distinct from the agency compliance surface (owner/business KYC/KYB under
// /agencies/me/compliance). This one verifies the signed-in applicant's own identity.

/** NIN and BVN are both 11 digits in Nigeria. */
const ID_DIGIT_LENGTH = 11;

class ClientVerificationController {
  /**
   * GET /users/me/verification
   * Returns the applicant's current identity-verification file (or a fresh
   * `{ status: "unverified" }` when they've never submitted).
   */
  async getStatus(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const userId = req.userId!;
      const status = await clientVerificationService.getStatus(userId);
      sendSuccess(res, status);
    } catch (error) {
      console.error("getVerificationStatus error:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  /**
   * POST /users/me/verification/identity
   * Body: { idType: "nin" | "bvn", idNumber: string, consent: true }
   *
   * Validates the submission, requires explicit consent (the backend also enforces
   * this before any government-ID lookup), runs the check, and notifies the user on
   * a terminal outcome. Responds with the resulting identity-verification file so the
   * app can reflect the new status immediately.
   */
  async submitIdentity(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const userId = req.userId!;
      const { idType, idNumber, consent } = req.body as {
        idType?: string;
        idNumber?: string;
        consent?: boolean;
      };

      // ---- Validation ----
      if (idType !== "nin" && idType !== "bvn") {
        sendError(res, "VALIDATION_ERROR", "idType must be 'nin' or 'bvn'");
        return;
      }
      // Consent is mandatory: we never run a gov-id lookup without it (NDPA / iGree).
      if (consent !== true) {
        sendError(
          res,
          "VALIDATION_ERROR",
          "Consent is required to verify your identity"
        );
        return;
      }
      const digits = String(idNumber ?? "").replace(/\D/g, "");
      if (digits.length !== ID_DIGIT_LENGTH) {
        sendError(
          res,
          "VALIDATION_ERROR",
          `${idType.toUpperCase()} must be ${ID_DIGIT_LENGTH} digits`
        );
        return;
      }

      // ---- Submit + verify ----
      const file = await clientVerificationService.submitIdentity(userId, {
        idType,
        idNumber: digits,
        ipAddress: req.ip, // recorded on the consent audit trail
      });

      // ---- Notify on a terminal outcome (in-app + push + email via policy) ----
      // Best-effort: a notification failure must never fail the submission response.
      if (file.status === "verified") {
        void notificationService
          .notifyUser({
            userId,
            type: "identity_verified",
            title: "Identity verified",
            body: "Your identity has been verified — you're all set.",
          })
          .catch(() => undefined);
      } else if (file.status === "failed") {
        void notificationService
          .notifyUser({
            userId,
            type: "identity_verification_failed",
            title: "Identity verification needs attention",
            body:
              file.reason ??
              "We couldn't verify your identity. Please check your details and try again.",
          })
          .catch(() => undefined);
      }

      sendSuccess(res, file);
    } catch (error) {
      console.error("submitIdentity error:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }
}

export const clientVerificationController = new ClientVerificationController();
