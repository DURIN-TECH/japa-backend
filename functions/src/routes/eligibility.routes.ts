import { Router } from "express";
import { eligibilityController } from "../controllers/eligibility.controller";
import { verifyAuth, verifyAdmin } from "../middleware/auth";

// Routes mounted at /eligibility
const eligibilityRoutes = Router();

eligibilityRoutes.post("/pre-check", (req, res) =>
  eligibilityController.preCheck(req, res)
);
eligibilityRoutes.get("/questions/:visaTypeId", (req, res) =>
  eligibilityController.getQuestions(req, res)
);
eligibilityRoutes.post("/check", verifyAuth, (req, res) =>
  eligibilityController.submitCheck(req, res)
);
eligibilityRoutes.get("/checks", verifyAuth, (req, res) =>
  eligibilityController.getUserChecks(req, res)
);
eligibilityRoutes.get("/checks/:checkId", verifyAuth, (req, res) =>
  eligibilityController.getCheck(req, res)
);
eligibilityRoutes.get("/checks/latest/:visaTypeId", verifyAuth, (req, res) =>
  eligibilityController.getLatestCheck(req, res)
);

// Routes mounted at /admin/eligibility
const adminEligibilityRoutes = Router();

adminEligibilityRoutes.get("/questions", verifyAuth, verifyAdmin, (req, res) =>
  eligibilityController.listQuestions(req, res)
);
adminEligibilityRoutes.post(
  "/questions",
  verifyAuth,
  verifyAdmin,
  (req, res) => eligibilityController.createQuestion(req, res)
);
adminEligibilityRoutes.put(
  "/questions/:questionId",
  verifyAuth,
  verifyAdmin,
  (req, res) => eligibilityController.updateQuestion(req, res)
);
adminEligibilityRoutes.delete(
  "/questions/:questionId",
  verifyAuth,
  verifyAdmin,
  (req, res) => eligibilityController.deleteQuestion(req, res)
);
adminEligibilityRoutes.post("/seed", verifyAuth, verifyAdmin, (req, res) =>
  eligibilityController.seedQuestions(req, res)
);
adminEligibilityRoutes.post(
  "/seed/nigeria-ireland",
  verifyAuth,
  verifyAdmin,
  (req, res) => eligibilityController.seedNigeriaIreland(req, res)
);

export { eligibilityRoutes, adminEligibilityRoutes };
