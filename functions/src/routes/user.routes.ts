import { Router } from "express";
import { userController } from "../controllers/user.controller";
import { verifyAuth } from "../middleware/auth";

const router = Router();

router.get("/me", verifyAuth, (req, res) => userController.getMe(req, res));
router.put("/me", verifyAuth, (req, res) => userController.updateMe(req, res));
router.delete("/me", verifyAuth, (req, res) =>
  userController.deleteMe(req, res)
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

export { router as userRoutes };
