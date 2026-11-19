import { Router } from "express";
import { verifyAdmin, verifyAuth } from "../middleware/auth";
import { requireRubricAdmin, rubricReviewController } from "../controllers/rubric-review.controller";
import { rubricFanOutController } from "../controllers/rubric-fan-out.controller";

// ============================================
// Routes mounted at /admin/rubrics (issue #125)
// ============================================
//
// The admin review of extracted rubric versions. FOUR routes, and only
// these (the fourth, `POST /:id/exclusion-preview`, is read-only: #161): there
// is deliberately no route that approves part of a version or edits a
// criterion (a version is approved or rejected whole), and no route
// that serves a snapshot's text.
//
// Issue #201 added THREE more (publish settings GET / PATCH, and
// `POST /:id/auto-publish`). The settings routes are registered BEFORE `/:id`
// so `publish-settings` is never captured as a version id.
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

// (#201) The automatic-publishing settings and kill switch. Registered BEFORE
// `/:id` so it is not captured by it.
adminRubricRoutes.get("/publish-settings", ...adminOnly, (req, res) => rubricReviewController.getPublishSettings(req, res));
adminRubricRoutes.patch("/publish-settings", ...adminOnly, (req, res) => rubricReviewController.patchPublishSettings(req, res));
// (#233 P4b) A shared layer's re-assessment fan-out: the estimate waits for
// this confirmation before anything is queued or spent. Registered BEFORE
// `/:id` so `fan-outs` is never captured as a version id.
adminRubricRoutes.get("/fan-outs", ...adminOnly, (req, res) => rubricFanOutController.list(req, res));
adminRubricRoutes.post("/fan-outs/:id/confirm", ...adminOnly, (req, res) => rubricFanOutController.confirm(req, res));
// The queue: versions by review status (default pending_review), newest first.
adminRubricRoutes.get("/", ...adminOnly, (req, res) => rubricReviewController.list(req, res));
// One version: criteria with `staleCitation`, diff against the serving
// version, flags, discards, suspicious passages, approval readiness.
adminRubricRoutes.get("/:id", ...adminOnly, (req, res) => rubricReviewController.get(req, res));
// What a proposed exclusion set would remove (read-only; for long id lists
// that do not fit a query string). Writes nothing.
adminRubricRoutes.post("/:id/exclusion-preview", ...adminOnly, (req, res) => rubricReviewController.exclusionPreview(req, res));
// (#201) Run the automatic pipeline on a pending draft now (`?dryRun=true`
// writes nothing). The same gates and the same approval transaction as the
// trigger, whatever `mode` is.
adminRubricRoutes.post("/:id/auto-publish", ...adminOnly, (req, res) => rubricReviewController.autoPublish(req, res));
// Approve or reject the whole version, with the `revision` the reviewer saw
// (409 when it is stale or the version is already decided).
adminRubricRoutes.patch("/:id/review", ...adminOnly, (req, res) => rubricReviewController.review(req, res));

export { adminRubricRoutes };
