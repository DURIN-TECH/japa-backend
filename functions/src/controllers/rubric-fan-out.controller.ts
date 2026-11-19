import { Response } from "express";
import type { Timestamp } from "firebase-admin/firestore";
import { AuthenticatedRequest } from "../middleware/auth";
import { sendError, sendSuccess } from "../utils/response";
import { bulkReassessmentService, FAN_OUT_STATEMENT, FanOutError } from "../services/ai-bulk-reassessment.service";
import { BULK_RUN_STATUSES, type BulkReassessmentRun, type FanOutConfirmation } from "../types/bulk-reassessment";

// ============================================
// ADMIN — A SHARED LAYER'S RE-ASSESSMENT FAN-OUT (issue #233, P4b of #228)
// ============================================
//
// Mounted under /admin/rubrics (routes/rubric-review.routes.ts), behind the
// same admin-only chain as the rest of the rubric review (`verifyAuth`,
// `requireRubricAdmin`, `verifyAdmin`):
//
//   GET  /admin/rubrics/fan-outs?status=&limit=     the fan-out runs, newest first
//   POST /admin/rubrics/fan-outs/:id/confirm        {estimateId, statementAccepted: true}
//
// When a shared (bloc / treaty) layer publishes a new version, the open
// applications on it are ESTIMATED and wait for this confirmation; nothing is
// queued or spent before it (services/ai-bulk-reassessment.service.ts).
//
// DATA ISOLATION: the view below is a whitelist of COUNTS (applications per
// member route, requests). No application id, applicant, agent or agency ever
// leaves the server through it.

/** Admin uid for the confirmation record (verifyAuth always sets it). */
const uid = (req: AuthenticatedRequest): string => req.userId ?? req.authz?.uid ?? "unknown";

/** A run id is an audit id: a Firestore auto id. */
const RUN_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

/** Timestamp -> ISO (null when absent). */
const iso = (t: Timestamp | null | undefined): string | null => (t && typeof t.toDate === "function" ? t.toDate().toISOString() : null);

/** A confirmation as the portal gets it. */
function confirmationView(c: FanOutConfirmation) {
  return { estimateId: c.estimateId, by: c.by, at: iso(c.at), maxRequests: c.maxRequests, statementAccepted: c.statementAccepted };
}

/** A fan-out run as the portal gets it: counts only. */
export function fanOutView(run: BulkReassessmentRun) {
  const f = run.fanOut;
  return {
    runId: run.id,
    layerKey: f?.layerKey ?? run.routeKey,
    layerVersion: f?.layerVersion ?? run.rubricVersion,
    previousApprovedVersion: run.previousApprovedVersion,
    status: run.status,
    phase: f?.phase ?? null,
    estimate: f?.estimate ? { ...f.estimate, computedAt: iso(f.estimate.computedAt) } : null,
    statement: FAN_OUT_STATEMENT,
    confirmation: f?.confirmation ? confirmationView(f.confirmation) : null,
    voidedConfirmations: (f?.voidedConfirmations ?? []).map(confirmationView),
    requestsEnqueued: f?.requestsEnqueued ?? 0,
    enqueued: run.enqueued,
    alreadyCurrent: run.alreadyCurrent,
    excluded: run.excluded,
    deferredAtLastSweep: run.deferredAtLastSweep,
    succeeded: run.succeeded,
    failed: run.failed,
    createdAt: iso(run.createdAt),
    updatedAt: iso(run.updatedAt),
    completedAt: iso(run.completedAt),
  };
}

/** Map a thrown error onto HTTP (the message only, never a body). */
function sendFanOutError(res: Response, error: unknown, what: string): void {
  if (error instanceof FanOutError) {
    res.status(error.status).json({ success: false, error: error.code, message: error.message, ...error.extra });
    return;
  }
  console.error(`${what} failed:`, (error as Error)?.message ?? "unknown error");
  sendError(res, "INTERNAL_ERROR", `${what} failed`, 500);
}

class RubricFanOutController {
  /** GET /admin/rubrics/fan-outs */
  async list(req: AuthenticatedRequest, res: Response): Promise<void> {
    const status = typeof req.query.status === "string" ? req.query.status : undefined;
    if (status !== undefined && !(BULK_RUN_STATUSES as readonly string[]).includes(status)) {
      sendError(res, "VALIDATION_ERROR", `status must be one of ${BULK_RUN_STATUSES.join(", ")}`, 400);
      return;
    }
    const rawLimit = typeof req.query.limit === "string" ? Number(req.query.limit) : 20;
    if (!Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > 100) {
      sendError(res, "VALIDATION_ERROR", "limit must be a whole number from 1 to 100", 400);
      return;
    }
    try {
      const runs = await bulkReassessmentService.listFanOuts({ status: status as BulkReassessmentRun["status"] | undefined, limit: rawLimit });
      sendSuccess(res, { runs: runs.map(fanOutView), total: runs.length });
    } catch (error) {
      sendFanOutError(res, error, "Listing the re-assessment fan-outs");
    }
  }

  /** POST /admin/rubrics/fan-outs/:id/confirm */
  async confirm(req: AuthenticatedRequest, res: Response): Promise<void> {
    const id = String(req.params.id ?? "");
    if (!RUN_ID_RE.test(id)) {
      sendError(res, "VALIDATION_ERROR", "That is not a run id", 400);
      return;
    }
    const body = req.body;
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some((k) => k !== "estimateId" && k !== "statementAccepted")) {
      sendError(res, "VALIDATION_ERROR", "The body takes only estimateId and statementAccepted", 400);
      return;
    }
    if (typeof body.estimateId !== "string" || body.estimateId.length === 0 || body.estimateId.length > 64) {
      sendError(res, "VALIDATION_ERROR", "estimateId is required", 400);
      return;
    }
    try {
      const out = await bulkReassessmentService.confirmFanOut(id, { estimateId: body.estimateId, statementAccepted: body.statementAccepted === true }, uid(req));
      sendSuccess(res, { alreadyConfirmed: out.alreadyConfirmed, run: fanOutView(out.run) });
    } catch (error) {
      sendFanOutError(res, error, "Confirming the re-assessment");
    }
  }
}

export const rubricFanOutController = new RubricFanOutController();
