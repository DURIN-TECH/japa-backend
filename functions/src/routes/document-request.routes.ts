/**
 * Document request routes — the durable "agent asked the client for X" list.
 *
 * Mounted at `/document-requests`.
 *
 * NOTE ON MIDDLEWARE: unlike most agent-side routers, these routes use `verifyAuth`
 * WITHOUT `verifyAgent`. That is deliberate — the whole point of this feature is
 * that a CLIENT can read their own outstanding requests from the web workspace.
 * The controller derives each caller's scope from `req.authz.role` (a client only
 * ever sees `userId == self`) and blocks the applicant from the write paths, so
 * opening the router to clients doesn't widen agent-side access.
 */
import { Router } from "express";
import { documentRequestController } from "../controllers/document-request.controller";
import { verifyAuth } from "../middleware/auth";

const router = Router();

// GET /document-requests — the caller's requests (scope derived from their role)
router.get("/", verifyAuth, (req, res) =>
  documentRequestController.list(req, res)
);

// POST /document-requests — agent raises a new ask against a case
router.post("/", verifyAuth, (req, res) =>
  documentRequestController.create(req, res)
);

// PATCH /document-requests/:id — agent waives or cancels a pending ask.
// (`fulfilled` is intentionally NOT settable here — only a real upload can do that.)
router.patch("/:id", verifyAuth, (req, res) =>
  documentRequestController.resolve(req, res)
);

export { router as documentRequestRoutes };
