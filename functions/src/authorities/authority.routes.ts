import { Router } from "express";
import { verifyAdmin, verifyAuth } from "../middleware/auth";
import { authorityController as c } from "./authority.controller";

// ============================================
// Routes for the authorities API (issue #230, P1 of #228)
// ============================================
//
// Mounted in app.ts at /admin/authorities. Every route: `verifyAuth` (401),
// `verifyAdmin` (the app's standard admin check, kept so the routes stay
// admin-only even if the controller's gate changes), then the controller's
// CASL gate on `ScrapeRun` (403) before anything is read. No delete route:
// an authority is retired and a member is given a `leftOn` date.
const adminAuthorityRoutes = Router();
const adminOnly = [verifyAuth, verifyAdmin];

adminAuthorityRoutes.get("/", ...adminOnly, (req, res) => c.list(req, res));
adminAuthorityRoutes.post("/", ...adminOnly, (req, res) => c.create(req, res));
adminAuthorityRoutes.get("/:id", ...adminOnly, (req, res) => c.get(req, res));
adminAuthorityRoutes.patch("/:id", ...adminOnly, (req, res) => c.update(req, res));
adminAuthorityRoutes.get("/:id/members", ...adminOnly, (req, res) => c.members(req, res));
adminAuthorityRoutes.put("/:id/members/:countryCode", ...adminOnly, (req, res) => c.putMember(req, res));

export { adminAuthorityRoutes };
