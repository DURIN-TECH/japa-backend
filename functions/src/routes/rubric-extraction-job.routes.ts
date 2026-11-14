import { Router } from "express";
import { verifyAdmin, verifyAuth } from "../middleware/auth";
import { requireRubricAdmin } from "../controllers/rubric-review.controller";
import { rubricExtractionJobController } from "../controllers/rubric-extraction-job.controller";

// ============================================
// Routes mounted at /admin/rubric-extraction-jobs (issue #216)
// ============================================
//
// Start a rulebook drafting job, read its status, cancel it. THREE routes and
// only these. Each runs the SAME gate as the other rubric admin routes
// (routes/rubric-review.routes.ts), in the same order:
//  1. `verifyAuth`          no / bad token -> 401;
//  2. `requireRubricAdmin`  not an admin -> 403 `FORBIDDEN`, before the body is
//                           read or any document is touched;
//  3. `verifyAdmin`         the app's standard admin check, kept so the route
//                           stays admin-only even if step 2 is ever changed.
// Starting a job spends model calls, so no entitlement or role below admin can
// reach it.

/** /admin/rubric-extraction-jobs */
const adminRubricExtractionJobRoutes = Router();

/** The gate every route shares, in order. */
const adminOnly = [verifyAuth, requireRubricAdmin, verifyAdmin];

adminRubricExtractionJobRoutes.post("/", ...adminOnly, (req, res) => rubricExtractionJobController.start(req, res));
adminRubricExtractionJobRoutes.get("/:id", ...adminOnly, (req, res) => rubricExtractionJobController.get(req, res));
adminRubricExtractionJobRoutes.post("/:id/cancel", ...adminOnly, (req, res) => rubricExtractionJobController.cancel(req, res));

export { adminRubricExtractionJobRoutes };
