// ============================================
// Routes mounted at /admin/risk-signals (issue #119)
// ============================================
//
// The admin review queue for trafficking / scam signals. Every route is
// admin-only: `verifyAuth` gives 401 without a valid token (and rejects a
// disabled account), `verifyAdmin` gives 403 for every other role. A client,
// agent or agency owner therefore never sees the queue, a signal or a count
// of signals.
//
// There is NO POST / route: a signal is created only by backend code through
// riskSignalService.raiseRiskSignal() (#120 and #121 call it). An admin can
// only record a decision on an existing signal.
//
//   GET  /               list (status, category, type, subjectType, severity,
//                        limit, cursor)
//   GET  /:id            one signal + its append-only audit trail
//   POST /:id/status     { status, note?, expectedRevision, reopen? }

import { Router } from "express";
import { verifyAdmin, verifyAuth } from "../middleware/auth";
import { riskSignalController } from "../controllers/risk-signal.controller";

const adminRiskSignalRoutes = Router();

// List the queue (newest first, optional filters, cursor page).
adminRiskSignalRoutes.get("/", verifyAuth, verifyAdmin, (req, res) => riskSignalController.list(req, res));
// One signal with its event history, or 404.
adminRiskSignalRoutes.get("/:id", verifyAuth, verifyAdmin, (req, res) => riskSignalController.get(req, res));
// Record an admin decision (in_review / actioned / dismissed, or an explicit
// reopen). Nothing is written outside riskSignals/{id} and its events.
adminRiskSignalRoutes.post("/:id/status", verifyAuth, verifyAdmin, (req, res) =>
  riskSignalController.changeStatus(req, res)
);

export { adminRiskSignalRoutes };
