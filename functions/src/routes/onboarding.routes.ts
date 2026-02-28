import { Router } from "express";
import { onboardingController } from "../controllers/onboarding.controller";
import { verifyAuth } from "../middleware/auth";

const onboardingRoutes = Router();

onboardingRoutes.post("/agency-owner", verifyAuth, (req, res) =>
  onboardingController.completeAgencyOwnerOnboarding(req, res)
);

export { onboardingRoutes };
