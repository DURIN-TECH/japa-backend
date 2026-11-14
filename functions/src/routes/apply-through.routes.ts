import { Router } from "express";
import { verifyAuth } from "../middleware/auth";
import { applyThroughController as c } from "../controllers/apply-through.controller";

// ============================================
// Routes for "which country do I apply through" (issue #235, P6 of #228)
// ============================================
//
// Mounted in app.ts at /shared-routes. Signed-in users only; read-only.
const router = Router();

router.get("/:id/apply-through", verifyAuth, (req, res) => c.get(req, res));
router.post("/:id/apply-through", verifyAuth, (req, res) => c.propose(req, res));

export { router as applyThroughRoutes };
