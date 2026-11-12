import { Router } from "express";
import { aiCaseOfficerController } from "../controllers/ai-case-officer.controller";
import { verifyAuth } from "../middleware/auth";

// ============================================
// AI CASE-OFFICER ROUTES (issue #42)
// ============================================
//
// Mounted at /ai in app.ts. Every route is behind verifyAuth. There is no
// requireFeature here: the tier is decided in the handler (see the controller).
//
//   POST /ai/applications/:id/assess      start (or return) the assessment
//   GET  /ai/applications/:id/assessment  the latest assessment for the application
//   GET  /ai/assessments/:id              one assessment, by id

const aiRoutes = Router();

aiRoutes.post("/applications/:id/assess", verifyAuth, (req, res) =>
  aiCaseOfficerController.assess(req, res)
);
aiRoutes.get("/applications/:id/assessment", verifyAuth, (req, res) =>
  aiCaseOfficerController.latest(req, res)
);
aiRoutes.get("/assessments/:id", verifyAuth, (req, res) =>
  aiCaseOfficerController.byId(req, res)
);

export { aiRoutes };
