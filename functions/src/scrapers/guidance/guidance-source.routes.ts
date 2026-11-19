import { Router } from "express";
import { verifyAuth } from "../../middleware/auth";
import { guidanceSourceController } from "./guidance-source.controller";
import { registryController } from "../shared/registry/registry.controller";

// ============================================
// Routes for the guidance source registry (issue #39)
// ============================================
//
// Mounted at /admin/guidance-sources (app.ts). Two routes: the read-only list,
// and (issue #143) the admin retry `POST /:id/crawl`. `verifyAuth` gives 401
// without a valid token; the controller then gates on the admin-only CASL
// ability -> 403 FORBIDDEN otherwise.
//
// There is deliberately no route that returns a snapshot or its text: stored
// guidance text is for the backend's own quote validation.

/** /admin/guidance-sources — the caseworker-guidance registry. */
const adminGuidanceSourceRoutes = Router();
adminGuidanceSourceRoutes.get("/", verifyAuth, (req, res) => guidanceSourceController.list(req, res));

// Crawl exactly this source now (due or not, `failing` included).
adminGuidanceSourceRoutes.post("/:id/crawl", verifyAuth, (req, res) => guidanceSourceController.crawl(req, res));

// Issue #215: set a source's status (active / paused / retired) or role. There
// is no DELETE route: retiring is the removal. Admin gate + audit in the service.
adminGuidanceSourceRoutes.patch("/:id", verifyAuth, (req, res) => registryController.patchGuidanceSource(req, res));

export { adminGuidanceSourceRoutes };
