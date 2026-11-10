import { Router } from "express";
import { verifyAuth } from "../middleware/auth";
import { scrapeAlertController } from "../controllers/scrape-alert.controller";

// ============================================
// Routes for scraper alerts (issue #83)
// ============================================
//
// Mounted at /admin/scrape-alerts (app.ts). `verifyAuth` gives 401 without a
// valid token; the controller then gates on CASL: `read ScrapeRun` to list /
// get, `update ScrapeRun` to acknowledge / resolve (admin-only) -> 403.

const adminScrapeAlertRoutes = Router();
// Filterable (status), cursor-paginated list, lastSeen newest first.
adminScrapeAlertRoutes.get("/", verifyAuth, (req, res) => scrapeAlertController.list(req, res));
// One alert.
adminScrapeAlertRoutes.get("/:id", verifyAuth, (req, res) => scrapeAlertController.get(req, res));
// "I'm on it": stops further emails for this alert unless it escalates.
adminScrapeAlertRoutes.post("/:id/acknowledge", verifyAuth, (req, res) => scrapeAlertController.acknowledge(req, res));
// Close it by hand (a recurrence opens a new alert).
adminScrapeAlertRoutes.post("/:id/resolve", verifyAuth, (req, res) => scrapeAlertController.resolve(req, res));

export { adminScrapeAlertRoutes };
