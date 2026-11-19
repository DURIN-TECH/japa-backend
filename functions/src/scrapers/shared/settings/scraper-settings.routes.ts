import { Router } from "express";
import { verifyAuth } from "../../../middleware/auth";
import { scraperSettingsController as c } from "./scraper-settings.controller";

// ============================================
// Routes for scraper settings + manual runs (issue #96)
// ============================================
//
// Mounted in app.ts. Every route: `verifyAuth` (401), then the controller's
// CASL gate on `ScrapeRun` (read for GETs, update for edits / runs) -> 403.
// Contract: scraper-settings.md.

/** /admin/scraper-settings — the one settings doc view + edits + audit. */
const adminScraperSettingsRoutes = Router();
adminScraperSettingsRoutes.get("/", verifyAuth, (req, res) => c.get(req, res));
adminScraperSettingsRoutes.patch("/", verifyAuth, (req, res) => c.patch(req, res));
adminScraperSettingsRoutes.get("/history", verifyAuth, (req, res) => c.history(req, res));

/**
 * /admin/scrape-sources/:kind/:id — per-source controls. Mounted on the same
 * path as the #81 read-only router (GET /admin/scrape-sources); Express tries
 * both, and these paths do not overlap with it.
 */
const adminScrapeSourceControlRoutes = Router();
adminScrapeSourceControlRoutes.patch("/:kind/:id", verifyAuth, (req, res) => c.patchSource(req, res));
adminScrapeSourceControlRoutes.post("/:kind/:id/run", verifyAuth, (req, res) => c.runSource(req, res));

/** /admin/scrapers/:kind/run — Run now for every due source of a scraper. */
const adminScraperRunRoutes = Router();
adminScraperRunRoutes.post("/:kind/run", verifyAuth, (req, res) => c.runScraper(req, res));

/** /admin/scrape-run-requests/:id — poll a Run now request. */
const adminScrapeRunRequestRoutes = Router();
adminScrapeRunRequestRoutes.get("/:id", verifyAuth, (req, res) => c.getRequest(req, res));

export { adminScrapeRunRequestRoutes, adminScrapeSourceControlRoutes, adminScraperRunRoutes, adminScraperSettingsRoutes };
