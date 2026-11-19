import { Response } from "express";
import { AuthenticatedRequest } from "../middleware/auth";
import { paymentRequired } from "../middleware/authz";
import { collections } from "../utils/firebase";
import { checkApplicationAccessForRequest } from "../utils/access";
import { sendError, sendForbidden, sendNotFound, sendSuccess } from "../utils/response";
import type { Application, Document, DocumentRequest } from "../types";
import type { DocumentCheckRecord } from "../types/document-check";
import { CHECK_KEYS, COULD_NOT_CHECK_MESSAGES } from "../services/ai/document-check-engine";
import { documentCheckService } from "../services/ai/document-check.service";
import { tierFor } from "../services/ai/tier-serializer";

// ============================================
// DOCUMENT CHECK — HANDLERS (issue #115)
// ============================================
//
//   GET  /documents/:id/check              the check for one document
//   POST /documents/:id/check/retry        run it again (applicant, paid tier)
//   GET  /applications/:id/document-checks the latest check per checklist item
//
// Each handler: (1) loads the object and runs the shared `checkApplicationAccess`
// on its APPLICATION (a different applicant or another agency gets FORBIDDEN);
// (2) decides the tier from the caller's entitlement with the same fail-closed
// rule as the assessment (`tierFor`: unresolved entitlements read as free);
// (3) answers through `present`, the only path to a response body.
//
// TRIMMING IS SERVER-SIDE. A free caller gets `{ tier: "free", state:
// "upgrade_required" }` and nothing from the stored record, whatever it holds.
// A full caller gets the checks as { outcome, code, message } and the rule's
// own quote and URL. Never returned: the model id, file hash, extracted values.

/** The wording a free caller gets. */
const UPGRADE_MESSAGE = "Document checks are available on the paid plan. Your upload is saved either way.";

/** Check results as the client sees them: outcome, code and message only. */
function trimChecks(checks: NonNullable<DocumentCheckRecord["checks"]>) {
  return Object.fromEntries(CHECK_KEYS.map((k) => [k, { outcome: checks[k].outcome, code: checks[k].code, message: checks[k].message }]));
}

/** What one stored record looks like to a FULL-tier caller. */
function presentRecord(rec: DocumentCheckRecord) {
  const stale = documentCheckService.isStale(rec);
  const pending = (rec.status === "queued" || rec.status === "running") && !stale;
  const state = pending ? "pending" : stale ? "could_not_check" : rec.status;
  return {
    documentId: rec.documentId,
    documentRequestId: rec.documentRequestId,
    checklistItemId: rec.checklistItemId,
    state,
    // `checks` only when the check finished; `reason` only when it could not run.
    checks: state === "done" && rec.checks ? trimChecks(rec.checks) : null,
    reason: stale
      ? { code: "timed_out", message: COULD_NOT_CHECK_MESSAGES.timed_out }
      : state === "could_not_check" && rec.reason
        ? { code: rec.reason.code, message: rec.reason.message }
        : null,
    // The rule behind the item, always beside the result.
    citation: rec.citation,
    rubricVersion: rec.rubricVersion,
    attempt: rec.attempt,
    finishedAt: rec.finishedAt ? rec.finishedAt.toDate().toISOString() : null,
    canRetry: !pending,
  };
}

/** Body for a caller and a (possibly missing) record. */
function present(tier: "free" | "full", rec: DocumentCheckRecord | null, documentId: string) {
  if (tier === "free") return { tier, state: "upgrade_required" as const, message: UPGRADE_MESSAGE };
  if (!rec) return { tier, documentId, state: "not_checked" as const, checks: null, reason: null, citation: null, canRetry: true };
  return { tier, ...presentRecord(rec) };
}

async function loadApplication(id: string): Promise<Application | null> {
  const snap = await collections.applications.doc(id).get();
  return snap.exists ? ({ id: snap.id, ...snap.data() } as Application) : null;
}

async function loadDocument(id: string): Promise<Document | null> {
  const snap = await collections.documents.doc(id).get();
  return snap.exists ? ({ id: snap.id, ...snap.data() } as Document) : null;
}

export class DocumentCheckController {
  /** GET /documents/:id/check */
  async get(req: AuthenticatedRequest, res: Response): Promise<void> {
    const document = await loadDocument(req.params.id);
    if (!document) return sendNotFound(res, "Document not found");
    const app = await loadApplication(document.applicationId);
    // The check is on the parent application, never on the document id alone.
    if (!app || !checkApplicationAccessForRequest(req, app, "read")) return sendForbidden(res);

    const tier = tierFor(req.authz?.role, req.entitlements);
    // A free caller's record is never even read.
    const rec = tier === "full" ? await documentCheckService.getByDocumentId(document.id) : null;
    return sendSuccess(res, present(tier, rec, document.id));
  }

  /**
   * POST /documents/:id/check/retry
   * 202 with the pending state; 402 UPGRADE_REQUIRED for a free caller;
   * 403 for anyone but the applicant (checks for agent-managed cases are #117).
   */
  async retry(req: AuthenticatedRequest, res: Response): Promise<void> {
    const document = await loadDocument(req.params.id);
    if (!document) return sendNotFound(res, "Document not found");
    const app = await loadApplication(document.applicationId);
    if (!app || !checkApplicationAccessForRequest(req, app, "update")) return sendForbidden(res);
    if (app.userId !== req.authz?.uid) return sendForbidden(res);

    const tier = tierFor(req.authz?.role, req.entitlements);
    if (tier !== "full") return paymentRequired(res, UPGRADE_MESSAGE);

    // The request the document was uploaded against; it carries the cited item.
    const requirementId = document.requirementId ?? "";
    const documentRequestId = requirementId.startsWith("docreq:") ? requirementId.slice("docreq:".length) : null;
    const reqSnap = documentRequestId ? await collections.documentRequests.doc(documentRequestId).get() : null;
    if (!reqSnap || !reqSnap.exists) return sendError(res, "NOT_A_CHECKLIST_UPLOAD", "This document was not uploaded against a checklist item, so there is nothing to check it against.", 400);
    const docRequest = { id: reqSnap.id, ...reqSnap.data() } as DocumentRequest;
    if (docRequest.applicationId !== app.id || docRequest.userId !== document.userId) return sendForbidden(res);

    const outcome = await documentCheckService.enqueue(document, app, docRequest);
    if (outcome.kind === "skipped") {
      return sendError(res, "NOT_A_CHECKLIST_UPLOAD", "This document was not uploaded against a checklist item, so there is nothing to check it against.", 400);
    }
    return sendSuccess(res, { documentId: document.id, state: "pending" }, undefined, 202);
  }

  /** GET /applications/:id/document-checks */
  async listForApplication(req: AuthenticatedRequest, res: Response): Promise<void> {
    const app = await loadApplication(req.params.id);
    if (!app) return sendNotFound(res, "Application not found");
    if (!checkApplicationAccessForRequest(req, app, "read")) return sendForbidden(res);

    const tier = tierFor(req.authz?.role, req.entitlements);
    if (tier === "free") return sendSuccess(res, { tier, state: "upgrade_required", message: UPGRADE_MESSAGE, checks: [] });
    const records = await documentCheckService.latestForApplication(app.id);
    return sendSuccess(res, { tier, state: "ok", checks: records.map(presentRecord) });
  }
}

export const documentCheckController = new DocumentCheckController();
