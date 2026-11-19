import { Router } from "express";
import { verifyAdmin, verifyAuth } from "../middleware/auth";
import { entryRequirementsController as c } from "./entry-requirements.controller";

// ============================================
// Routes for entry requirements (issue #236, P7 of #228)
// ============================================
//
// Mounted in app.ts:
//   /entry-requirements       signed-in users (verifyAuth); free, no plan gate
//                             (stored data, no AI call at answer time)
//   /admin/entry-rules        admin review data (verifyAuth + verifyAdmin, then
//                             the controller's CASL gate); read-only, no screen

/** GET /entry-requirements */
const entryRequirementsRoutes = Router();
entryRequirementsRoutes.get("/", verifyAuth, (req, res) => c.lookup(req, res));

/** GET /admin/entry-rules, GET /admin/entry-rules/runs */
const adminEntryRuleRoutes = Router();
const adminOnly = [verifyAuth, verifyAdmin];
adminEntryRuleRoutes.get("/", ...adminOnly, (req, res) => c.listRules(req, res));
adminEntryRuleRoutes.get("/runs", ...adminOnly, (req, res) => c.listRuns(req, res));

export { entryRequirementsRoutes, adminEntryRuleRoutes };
