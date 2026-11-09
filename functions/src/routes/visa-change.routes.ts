import { Router } from "express";
import { verifyAuth } from "../middleware/auth";
import { visaChangeController } from "../controllers/visa-change.controller";

// ============================================
// Routes mounted at /admin/visa-changes (issue #61)
// ============================================
//
// The admin queue of proposed edits to already-approved scraped visas
// (`pendingVisaChanges`). `verifyAuth` gives 401 without a valid token; the
// controller then gates each route on the shared CASL ability for the
// `VisaChange` subject (admin-only in @durin-tech/authz) → 403 otherwise.
const adminVisaChangeRoutes = Router();

// List the queue (default status=open, newest first).
adminVisaChangeRoutes.get("/", verifyAuth, (req, res) => visaChangeController.list(req, res));
// One proposal (full shape: diff, current/proposed, citations, ...).
adminVisaChangeRoutes.get("/:id", verifyAuth, (req, res) => visaChangeController.get(req, res));
// Apply it to the live visa in one transaction.
adminVisaChangeRoutes.post("/:id/approve", verifyAuth, (req, res) => visaChangeController.approve(req, res));
// Reject it with { reason }; the live visa is untouched.
adminVisaChangeRoutes.post("/:id/reject", verifyAuth, (req, res) => visaChangeController.reject(req, res));

export { adminVisaChangeRoutes };
