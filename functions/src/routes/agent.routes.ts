import { Router } from "express";
import { agentController } from "../controllers/agent.controller";
import { verifyAuth, verifyAdmin } from "../middleware/auth";

const router = Router();

// Authenticated agent endpoints — MUST come before /:id to avoid "me" matching as an id
router.get("/me", verifyAuth, (req, res) =>
  agentController.getMyAgentProfile(req, res)
);
router.put("/me", verifyAuth, (req, res) =>
  agentController.updateMyAgentProfile(req, res)
);
router.put("/me/availability", verifyAuth, (req, res) =>
  agentController.updateAvailability(req, res)
);
router.put("/me/slots", verifyAuth, (req, res) =>
  agentController.updateAvailableSlots(req, res)
);

// Public agent endpoints
router.get("/", (req, res) => agentController.getAgents(req, res));
router.get("/top", (req, res) => agentController.getTopAgents(req, res));
router.get("/visa/:visaTypeId", (req, res) =>
  agentController.getAgentsForVisaType(req, res)
);

// Create agent profile
router.post("/", verifyAuth, (req, res) =>
  agentController.createAgent(req, res)
);

// Parameterized routes
router.get("/:id", (req, res) => agentController.getAgent(req, res));
router.get("/:id/reviews", (req, res) =>
  agentController.getAgentReviews(req, res)
);
router.post("/:id/reviews", verifyAuth, (req, res) =>
  agentController.addReview(req, res)
);

// Agency owner endpoints
router.put("/:id/status", verifyAuth, (req, res) =>
  agentController.updateAgentStatus(req, res)
);

// Admin endpoints
router.put("/:id/verification", verifyAuth, verifyAdmin, (req, res) =>
  agentController.updateVerificationStatus(req, res)
);

export { router as agentRoutes };
