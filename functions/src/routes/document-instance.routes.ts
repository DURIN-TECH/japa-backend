/**
 * Document instance routes — editable documents cloned from templates.
 *
 * All routes require an authenticated agent-side user (agent/owner/admin).
 * Per-document ownership is enforced in the controller via the shared CASL
 * "Document" ability; the read-only-plan 402 gate is applied in `verifyAuth`.
 *
 * NOTE: the static `/:id/versions` route is registered before the bare `/:id`
 * handlers by virtue of Express matching the more specific path first for GET;
 * they don't collide since they differ by the trailing segment.
 */
import { Router } from "express";
import { documentInstanceController } from "../controllers/document-instance.controller";
import { verifyAuth, verifyAgent } from "../middleware/auth";

const router = Router();

// GET /document-instances — list (scoped by role / applicationId)
router.get("/", verifyAuth, verifyAgent, (req, res) =>
  documentInstanceController.list(req, res)
);

// POST /document-instances — clone a template into an editable instance
router.post("/", verifyAuth, verifyAgent, (req, res) =>
  documentInstanceController.clone(req, res)
);

// GET /document-instances/:id/versions — version history
router.get("/:id/versions", verifyAuth, verifyAgent, (req, res) =>
  documentInstanceController.versions(req, res)
);

// GET /document-instances/:id — one instance (with content)
router.get("/:id", verifyAuth, verifyAgent, (req, res) =>
  documentInstanceController.getOne(req, res)
);

// PUT /document-instances/:id — save (optimistic concurrency)
router.put("/:id", verifyAuth, verifyAgent, (req, res) =>
  documentInstanceController.save(req, res)
);

// PATCH /document-instances/:id/link — link/unlink to an application
router.patch("/:id/link", verifyAuth, verifyAgent, (req, res) =>
  documentInstanceController.link(req, res)
);

// PATCH /document-instances/:id/share — toggle share-with-client
router.patch("/:id/share", verifyAuth, verifyAgent, (req, res) =>
  documentInstanceController.share(req, res)
);

// DELETE /document-instances/:id — delete (+ version history)
router.delete("/:id", verifyAuth, verifyAgent, (req, res) =>
  documentInstanceController.remove(req, res)
);

export { router as documentInstanceRoutes };
