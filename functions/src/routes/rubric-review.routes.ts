import { Router } from "express";
import { verifyAdmin, verifyAuth } from "../middleware/auth";
import { requireRubricAdmin, rubricReviewController } from "../controllers/rubric-review.controller";

// ============================================
// Routes mounted at /admin/rubrics (issue #125)
// ============================================
//
// The admin review of extracted rubric versions. THREE routes, and only
// these: there is deliberately no route that approves part of a version or
// edits a criterion (a version is approved or rejected whole), and no route
// that serves a snapshot's text.
//
// Every route runs the same chain:
//  1. `verifyAuth`          no / bad token -> 401; builds the principal and
//                           its ability from the token's claims;
//  2. `requireRubricAdmin`  not an admin -> 403 `FORBIDDEN`, before anything
//                           is validated or read;
//  3. `verifyAdmin`         the app's standard admin check (as on
//                           /admin/visas). It can no longer refuse anyone
//                           step 2 let through; it stays so that the route is
//                           admin-only even if step 2 is ever changed.
//
// These are the ONLY routes that read a rubric version of any review status.
// Consumers get approved rubrics through `rubricStore.getApprovedRubric`.

/** /admin/rubrics — rubric review queue, detail and decision. */
const adminRubricRoutes = Router();

/** The gate every route shares, in order. */
const adminOnly = [verifyAuth, requireRubricAdmin, verifyAdmin];

// The queue: versions by review status (default pending_review), newest first.
adminRubricRoutes.get("/", ...adminOnly, (req, res) => rubricReviewController.list(req, res));
// One version: criteria with `staleCitation`, diff against the serving
// version, flags, discards, suspicious passages, approval readiness.
adminRubricRoutes.get("/:id", ...adminOnly, (req, res) => rubricReviewController.get(req, res));
// Approve or reject the whole version, with the `revision` the reviewer saw
// (409 when it is stale or the version is already decided).
adminRubricRoutes.patch("/:id/review", ...adminOnly, (req, res) => rubricReviewController.review(req, res));

export { adminRubricRoutes };
