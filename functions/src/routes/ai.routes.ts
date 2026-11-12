import { Router } from "express";
import { aiCaseOfficerController } from "../controllers/ai-case-officer.controller";
import { aiChatController } from "../controllers/ai-chat.controller";
import { refusalLetterController } from "../controllers/refusal-letter.controller";
import { verifyAuth } from "../middleware/auth";
import { aiActionController, requireCaseOfficerPlanFailClosed } from "../controllers/ai-action.controller";

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
//
// Proposed actions (issue #44). Behind verifyAuth AND a fail-closed
// `ai.case_officer` plan gate (unresolved entitlements are refused, unlike
// `requireFeature`), then the shared application access check in the handler:
//   GET  /ai/assessments/:id/actions                     the proposals
//   POST /ai/assessments/:id/actions/:actionId/accept    accept (may create a DocumentRequest)
//   POST /ai/assessments/:id/actions/:actionId/reject    reject, optional { reason }
//   POST   /ai/applications/:id/chat      ask one question (issue #45)
//   GET    /ai/applications/:id/chat      the caller's own chat history
//   DELETE /ai/applications/:id/chat      clear the caller's own chat history
//   POST /ai/refusal-letters              start reading an uploaded refusal letter (#122)
//   GET  /ai/refusal-letters/:id          one refusal-letter analysis, by id (#122)

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

aiRoutes.get("/assessments/:id/actions", verifyAuth, requireCaseOfficerPlanFailClosed, (req, res) =>
  aiActionController.list(req, res)
);
aiRoutes.post("/assessments/:id/actions/:actionId/accept", verifyAuth, requireCaseOfficerPlanFailClosed, (req, res) =>
  aiActionController.accept(req, res)
);
aiRoutes.post("/assessments/:id/actions/:actionId/reject", verifyAuth, requireCaseOfficerPlanFailClosed, (req, res) =>
  aiActionController.reject(req, res)
);
aiRoutes.post("/applications/:id/chat", verifyAuth, (req, res) => aiChatController.ask(req, res));
aiRoutes.get("/applications/:id/chat", verifyAuth, (req, res) => aiChatController.history(req, res));
aiRoutes.delete("/applications/:id/chat", verifyAuth, (req, res) => aiChatController.clear(req, res));
// ---- refusal-letter analysis (issue #122) ----
aiRoutes.post("/refusal-letters", verifyAuth, (req, res) => refusalLetterController.create(req, res));
aiRoutes.get("/refusal-letters/:id", verifyAuth, (req, res) => refusalLetterController.byId(req, res));
aiRoutes.post("/refusal-letters/:id/checklist/confirm", verifyAuth, (req, res) =>
  refusalLetterController.confirmChecklist(req, res)
);

export { aiRoutes };
