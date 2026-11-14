import { Router } from "express";
import { agentController } from "../controllers/agent.controller";
import { verificationController } from "../controllers/verification.controller";
import { verifyAuth, verifyAdmin, optionalAuth } from "../middleware/auth";

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

// Verification document endpoints
router.post("/me/verification/upload-url", verifyAuth, (req, res) =>
  verificationController.getUploadUrl(req, res)
);
router.post("/me/verification/documents", verifyAuth, (req, res) =>
  verificationController.registerDocument(req, res)
);
router.get("/me/verification/documents", verifyAuth, (req, res) =>
  verificationController.listDocuments(req, res)
);
router.delete("/me/verification/documents", verifyAuth, (req, res) =>
  verificationController.removeDocument(req, res)
);

// Public agent endpoints. Issue #286: `optionalAuth` lets a signed-in
// client be quoted in their own currency (`consultationFeeLocal`, from their
// profile country); no token or an invalid one is served as a guest (default
// currency), never a 401.
router.get("/", optionalAuth, (req, res) => agentController.getAgents(req, res));
router.get("/top", optionalAuth, (req, res) => agentController.getTopAgents(req, res));
router.get("/visa/:visaTypeId", optionalAuth, (req, res) =>
  agentController.getAgentsForVisaType(req, res)
);

// Create agent profile
router.post("/", verifyAuth, (req, res) =>
  agentController.createAgent(req, res)
);

// Parameterized routes
// Public too (#286: optionalAuth for the viewer's quote currency).
router.get("/:id", optionalAuth, (req, res) => agentController.getAgent(req, res));
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
