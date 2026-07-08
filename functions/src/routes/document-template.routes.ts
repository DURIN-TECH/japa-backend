/**
 * Document template routes — read-only catalog.
 *
 * All routes require an authenticated agent-side user (agent/owner/admin);
 * clients (mobile) have no template catalog access. Route-level authorization
 * is coarse (agent-side); finer scope checks live in the controller.
 */
import { Router } from "express";
import { documentTemplateController } from "../controllers/document-template.controller";
import { verifyAuth, verifyAgent } from "../middleware/auth";

const router = Router();

// GET /document-templates — visible catalog (global + own agency)
router.get("/", verifyAuth, verifyAgent, (req, res) =>
  documentTemplateController.list(req, res)
);

// GET /document-templates/:id?includeContent=true — one template
router.get("/:id", verifyAuth, verifyAgent, (req, res) =>
  documentTemplateController.getOne(req, res)
);

export { router as documentTemplateRoutes };
