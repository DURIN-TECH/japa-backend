import { Router } from "express";
import { onboardingController } from "../controllers/onboarding.controller";
import { verifyAuth } from "../middleware/auth";

const onboardingRoutes = Router();

onboardingRoutes.post("/agency-owner", verifyAuth, (req, res) =>
  onboardingController.completeAgencyOwnerOnboarding(req, res)
);

// Invited-agent onboarding: join the agency from an invitation (no new agency).
onboardingRoutes.post("/join-agency", verifyAuth, (req, res) =>
  onboardingController.completeAgentInvitationOnboarding(req, res)
);

export { onboardingRoutes };
