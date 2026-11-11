/**
 * Checklist routes (issue #114), mounted at `/applications` in app.ts, ahead
 * of `applicationRoutes`. The paths have an extra segment, so they never
 * collide with `/:id`. Authorization lives in the controller.
 */
import { Router } from "express";
import { checklistController } from "../controllers/checklist.controller";
import { verifyAuth } from "../middleware/auth";

const router = Router();

// GET /applications/:id/checklist — read the personal document checklist
router.get("/:id/checklist", verifyAuth, (req, res) => checklistController.get(req, res));
// POST /applications/:id/checklist/refresh — (re)build it and store the requests
router.post("/:id/checklist/refresh", verifyAuth, (req, res) => checklistController.refresh(req, res));

export { router as checklistRoutes };
