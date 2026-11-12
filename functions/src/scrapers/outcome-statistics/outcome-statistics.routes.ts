import { Router } from "express";
import { verifyAuth } from "../../middleware/auth";
import { outcomeStatisticsController } from "./outcome-statistics.controller";

// ============================================
// Routes: outcome statistics imports (issue #116)
// ============================================
//
// Mounted at /admin/outcome-statistics (app.ts). Admin-only: `verifyAuth`
// gives 401 without a token, the controller gates on the admin-only CASL
// ability -> 403 FORBIDDEN otherwise. Run records and "Run now" only; no route
// returns statistics.

/** /admin/outcome-statistics */
const adminOutcomeStatisticsRoutes = Router();
adminOutcomeStatisticsRoutes.get("/runs", verifyAuth, (req, res) => outcomeStatisticsController.listRuns(req, res));
adminOutcomeStatisticsRoutes.post("/runs", verifyAuth, (req, res) => outcomeStatisticsController.requestRun(req, res));

export { adminOutcomeStatisticsRoutes };
