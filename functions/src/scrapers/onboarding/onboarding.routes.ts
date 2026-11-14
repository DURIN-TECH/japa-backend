import { Router } from "express";
import { verifyAdmin, verifyAuth } from "../../middleware/auth";
import { onboardingController as c } from "./onboarding.controller";

// ============================================
// Routes for route onboarding runs (issue #217)
// ============================================
//
// Mounted in app.ts at /admin/route-onboarding. Every route: `verifyAuth`
// (401), `verifyAdmin` (the app's standard admin check, kept so the routes stay
// admin-only even if the controller's gate changes), then the controller's
// CASL gate on `ScrapeRun` (403) before anything is read. There is no delete
// route: a run is cancelled, never removed. `/settings` is declared before
// `/:id` so it is never read as a run id.
const adminRouteOnboardingRoutes = Router();
const adminOnly = [verifyAuth, verifyAdmin];

adminRouteOnboardingRoutes.get("/settings", ...adminOnly, (req, res) => c.getSettings(req, res));
adminRouteOnboardingRoutes.patch("/settings", ...adminOnly, (req, res) => c.patchSettings(req, res));
adminRouteOnboardingRoutes.post("/", ...adminOnly, (req, res) => c.start(req, res));
adminRouteOnboardingRoutes.get("/", ...adminOnly, (req, res) => c.list(req, res));
adminRouteOnboardingRoutes.get("/:id", ...adminOnly, (req, res) => c.get(req, res));
adminRouteOnboardingRoutes.post("/:id/confirm", ...adminOnly, (req, res) => c.confirm(req, res));
adminRouteOnboardingRoutes.post("/:id/cancel", ...adminOnly, (req, res) => c.cancel(req, res));

export { adminRouteOnboardingRoutes };
