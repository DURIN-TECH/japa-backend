import { Router } from "express";
import { verifyAuth } from "../middleware/auth";
import { scrapeRunController } from "../controllers/scrape-run.controller";

// ============================================
// Routes for scraper monitoring (issue #81)
// ============================================
//
// Mounted at /admin/scrape-runs and /admin/scrape-sources (app.ts). Read-only.
// `verifyAuth` gives 401 without a valid token; the controller then gates on
// CASL `read ScrapeRun` (admin-only in @durin-tech/authz) → 403 otherwise.

/** /admin/scrape-runs — one record per visa / news scraper run. */
const adminScrapeRunRoutes = Router();
// Newest-first, filterable, cursor-paginated list.
adminScrapeRunRoutes.get("/", verifyAuth, (req, res) => scrapeRunController.list(req, res));
// One run in full (sources, pages, errors).
adminScrapeRunRoutes.get("/:id", verifyAuth, (req, res) => scrapeRunController.get(req, res));

/** /admin/scrape-sources — per-source health for each scraper. */
const adminScrapeSourceRoutes = Router();
adminScrapeSourceRoutes.get("/", verifyAuth, (req, res) => scrapeRunController.sources(req, res));

export { adminScrapeRunRoutes, adminScrapeSourceRoutes };
