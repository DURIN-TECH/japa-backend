/**
 * Checklist routes (issue #114), mounted at `/applications` in app.ts, ahead
 * of `applicationRoutes`. The paths have an extra segment, so they never
 * collide with `/:id`. Authorization lives in the controller.
 */
import { Router } from "express";
import { documentCheckController } from "../controllers/document-check.controller";
import { checklistController } from "../controllers/checklist.controller";
import { verifyAuth } from "../middleware/auth";

const router = Router();

// GET /applications/:id/checklist — read the personal document checklist
router.get("/:id/checklist", verifyAuth, (req, res) => checklistController.get(req, res));
// POST /applications/:id/checklist/refresh — (re)build it and store the requests
router.post("/:id/checklist/refresh", verifyAuth, (req, res) => checklistController.refresh(req, res));

// GET /applications/:id/document-checks — latest per-upload check per item (#115)
router.get("/:id/document-checks", verifyAuth, (req, res) => documentCheckController.listForApplication(req, res));

export { router as checklistRoutes };
