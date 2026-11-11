import { Router } from "express";
import { verifyAuth } from "../../middleware/auth";
import { guidanceSourceController } from "./guidance-source.controller";

// ============================================
// Routes for the guidance source registry (issue #39)
// ============================================
//
// Mounted at /admin/guidance-sources (app.ts). Read-only: ONE route, the
// list. `verifyAuth` gives 401 without a valid token; the controller then
// gates on the admin-only CASL ability -> 403 FORBIDDEN otherwise.
//
// There is deliberately no route that returns a snapshot or its text: stored
// guidance text is for the backend's own quote validation.

/** /admin/guidance-sources — the caseworker-guidance registry. */
const adminGuidanceSourceRoutes = Router();
adminGuidanceSourceRoutes.get("/", verifyAuth, (req, res) => guidanceSourceController.list(req, res));

export { adminGuidanceSourceRoutes };
