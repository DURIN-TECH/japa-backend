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

// --- Authoring ---
// Any agent-side user (agent/owner/admin) can create a template, added to the
// shared global catalog. Editing/deleting is restricted to the creator (or an
// admin) inside the controller.
// POST /document-templates — create a global template
router.post("/", verifyAuth, verifyAgent, (req, res) =>
  documentTemplateController.create(req, res)
);

// PUT /document-templates/:id — update a template (creator or admin)
router.put("/:id", verifyAuth, verifyAgent, (req, res) =>
  documentTemplateController.update(req, res)
);

// DELETE /document-templates/:id — delete a template (creator or admin)
router.delete("/:id", verifyAuth, verifyAgent, (req, res) =>
  documentTemplateController.remove(req, res)
);

export { router as documentTemplateRoutes };
