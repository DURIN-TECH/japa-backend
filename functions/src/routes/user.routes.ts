import { Router } from "express";
import { userController } from "../controllers/user.controller";
import { clientVerificationController } from "../controllers/client-verification.controller";
import { verifyAuth, verifyAdmin } from "../middleware/auth";

const router = Router();

// Admin-only user directory. Mounted separately at /admin/users (see app.ts) so the
// list endpoint lives on the admin surface and can't be shadowed by the /users/:uid
// matcher on the main user router.
const adminUsersRouter = Router();
adminUsersRouter.get("/", verifyAuth, verifyAdmin, (req, res) =>
  userController.listAllUsers(req, res)
);

// Admin-only: manage a user's RBAC role/claims.
router.put("/:uid/role", verifyAuth, verifyAdmin, (req, res) =>
  userController.setUserRole(req, res)
);

router.get("/me", verifyAuth, (req, res) => userController.getMe(req, res));
router.get("/me/authorization", verifyAuth, (req, res) =>
  userController.getAuthorization(req, res)
);
router.put("/me", verifyAuth, (req, res) => userController.updateMe(req, res));
router.delete("/me", verifyAuth, (req, res) =>
  userController.deleteMe(req, res)
);

// Account-security self-service (mobile + portal). These are exempted from the
// read-only-plan write-block in `verifyAuth` — a lapsed plan must never stop a
// user from securing or deleting their own account.
//   password-changed → fire the branded "your password was changed" notice
//                       (the password itself is changed client-side via Firebase).
//   change-email     → start the branded, verification-gated email-change flow.
router.post("/me/password-changed", verifyAuth, (req, res) =>
  userController.notifyPasswordChanged(req, res)
);
router.post("/me/change-email", verifyAuth, (req, res) =>
  userController.changeEmail(req, res)
);

// Notification channel preferences (email/push on-off). PATCH a partial body to
// toggle one or both channels.
router.patch("/me/notification-preferences", verifyAuth, (req, res) =>
  userController.updateNotificationPreferences(req, res)
);

// Profile photo (avatar) upload — two-step signed-URL flow:
//   1. mint a signed PUT URL, 2. register the uploaded object (makes it public
//   and persists profilePhotoUrl onto the user).
router.post("/me/photo/upload-url", verifyAuth, (req, res) =>
  userController.getPhotoUploadUrl(req, res)
);
router.post("/me/photo", verifyAuth, (req, res) =>
  userController.setPhoto(req, res)
);

router.post("/onboarding", verifyAuth, (req, res) =>
  userController.completeOnboarding(req, res)
);
router.get("/onboarding/status", verifyAuth, (req, res) =>
  userController.getOnboardingStatus(req, res)
);

router.post("/fcm-token", verifyAuth, (req, res) =>
  userController.registerFcmToken(req, res)
);
router.delete("/fcm-token", verifyAuth, (req, res) =>
  userController.removeFcmToken(req, res)
);

router.post("/login", verifyAuth, (req, res) =>
  userController.recordLogin(req, res)
);

// Applicant identity verification (client KYC) — NIN/BVN + explicit consent.
// GET returns the current status; POST submits an ID for an automated Dojah check.
router.get("/me/verification", verifyAuth, (req, res) =>
  clientVerificationController.getStatus(req, res)
);
router.post("/me/verification/identity", verifyAuth, (req, res) =>
  clientVerificationController.submitIdentity(req, res)
);

export { router as userRoutes, adminUsersRouter };
