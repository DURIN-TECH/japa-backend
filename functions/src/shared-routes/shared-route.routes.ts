import { Router } from "express";
import { verifyAdmin, verifyAuth } from "../middleware/auth";
import { sharedRouteController as c } from "./shared-route.controller";

// ============================================
// Routes for the shared routes API (issue #231, P2 of #228)
// ============================================
//
// Mounted in app.ts at /admin/shared-routes. Every route: `verifyAuth` (401),
// `verifyAdmin`, then the controller's CASL gate on `ScrapeRun` (403) before
// anything is read. The two-segment paths (`inheritance`, `resolve`) are
// registered before `/:id`; they cannot clash with it (different depth).
const adminSharedRouteRoutes = Router();
const adminOnly = [verifyAuth, verifyAdmin];

adminSharedRouteRoutes.get("/", ...adminOnly, (req, res) => c.list(req, res));
adminSharedRouteRoutes.post("/", ...adminOnly, (req, res) => c.create(req, res));
adminSharedRouteRoutes.put("/inheritance/:countryCode/:visaTypeId", ...adminOnly, (req, res) => c.setInheritance(req, res));
adminSharedRouteRoutes.get("/resolve/:countryCode/:visaTypeId", ...adminOnly, (req, res) => c.resolve(req, res));
adminSharedRouteRoutes.get("/:id", ...adminOnly, (req, res) => c.get(req, res));
adminSharedRouteRoutes.patch("/:id", ...adminOnly, (req, res) => c.update(req, res));

export { adminSharedRouteRoutes };
