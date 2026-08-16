/**
 * DocumentRequestController — the durable "agent asked the client for X" list.
 *
 * Routes mounted at `/document-requests`. This controller is deliberately usable
 * by BOTH sides of the platform:
 *
 *   - the CLIENT reads their own outstanding asks (the to-do list that powers the
 *     client web workspace) and nothing else;
 *   - AGENT-SIDE principals (agent / owner / admin) raise, waive and cancel asks,
 *     scoped by the shared CASL "Application" ability.
 *
 * The scope a caller gets is decided here from `req.authz.role`, never from a
 * query parameter — a client cannot widen their own query.
 */
import { Response } from "express";
import { AuthenticatedRequest } from "../middleware/auth";
import { documentRequestService } from "../services/document-request.service";
import { applicationService } from "../services/application.service";
import { userService } from "../services/user.service";
import { noteService } from "../services/note.service";
import { notificationService } from "../services/notification.service";
import { can, asSubject } from "../middleware/authz";
import { ROLES } from "@durin-tech/authz";
import {
  sendSuccess,
  sendError,
  sendCreated,
  ErrorMessages,
} from "../utils/response";
import { Application, DocumentRequestStatus } from "../types";

/** Lifecycle states an agent may move a pending request into by hand. */
const RESOLVABLE_STATUSES: DocumentRequestStatus[] = ["waived", "cancelled"];

export class DocumentRequestController {
  /**
   * GET /document-requests
   * Query: ?status=pending&applicationId=<id>
   *
   * Returns the caller's requests, newest first. The SCOPE is derived from the
   * caller's role:
   *   - client            → requests addressed to them (`userId == caller`)
   *   - owner / admin     → requests raised anywhere in their agency
   *                         (admins with no agency fall back to their own)
   *   - agent             → requests they personally raised
   *
   * `status` and `applicationId` only ever NARROW that scope, so they're safe to
   * accept straight from the query string.
   */
  async list(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const userId = req.userId!;
      const role = req.authz?.role;
      const agencyId = req.authz?.agencyId;

      const { status, applicationId } = req.query as {
        status?: string;
        applicationId?: string;
      };

      // Validate the status filter up front so a typo yields a clear 400 rather
      // than a silently empty list.
      const validStatuses: DocumentRequestStatus[] = [
        "pending",
        "fulfilled",
        "waived",
        "cancelled",
      ];
      if (status && !validStatuses.includes(status as DocumentRequestStatus)) {
        sendError(
          res,
          "VALIDATION_ERROR",
          `Invalid status. Allowed: ${validStatuses.join(", ")}`,
          400
        );
        return;
      }

      // --- Role-derived scope (never client-supplied) -------------------------
      const filter: Parameters<typeof documentRequestService.list>[0] = {
        ...(status ? { status: status as DocumentRequestStatus } : {}),
        ...(applicationId ? { applicationId } : {}),
      };

      if (role === ROLES.CLIENT) {
        // Clients only ever see what was asked OF them.
        filter.userId = userId;
      } else if ((role === ROLES.OWNER || role === ROLES.ADMIN) && agencyId) {
        // Owners (and agency-scoped admins) see the whole agency's asks.
        filter.agencyId = agencyId;
      } else {
        // Agents — and independent/agency-less principals — see their own.
        filter.requestedBy = userId;
      }

      const requests = await documentRequestService.list(filter);
      sendSuccess(res, requests);
    } catch (error) {
      console.error("Error listing document requests:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  /**
   * POST /document-requests
   * Body: { applicationId, documentType, notes?, dueDate? }
   *
   * Raise a new ask against a case. Only the case's agent/owner/admin may do this
   * — never the applicant themselves (a client asking themselves for a document
   * is nonsense, and would let them spam their own to-do list).
   *
   * Side effects, both best-effort and non-blocking:
   *   1. an activity note on the case (audit trail), and
   *   2. a multi-channel notification so the client hears about it immediately.
   */
  async create(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const userId = req.userId!;
      const { applicationId, documentType, notes, dueDate } = req.body as {
        applicationId?: string;
        documentType?: string;
        notes?: string;
        dueDate?: string;
      };

      if (!applicationId || !documentType?.trim()) {
        sendError(
          res,
          "VALIDATION_ERROR",
          "applicationId and documentType are required",
          400
        );
        return;
      }

      // Reject an unparseable dueDate rather than silently storing garbage.
      if (dueDate && Number.isNaN(new Date(dueDate).getTime())) {
        sendError(res, "VALIDATION_ERROR", "dueDate must be a valid date", 400);
        return;
      }

      const application = await applicationService.getApplicationById(applicationId);
      if (!application) {
        sendError(res, "NOT_FOUND", "Application not found", 404);
        return;
      }

      // Agent-side access to this specific case, and explicitly NOT the applicant.
      const isApplicant = application.userId === userId;
      const hasAccess = this.checkAccess(req, application);
      if (!hasAccess || isApplicant) {
        sendError(res, "FORBIDDEN", ErrorMessages.FORBIDDEN, 403);
        return;
      }

      const requestedByName =
        (await userService.getDisplayName(userId)) || "Your agent";

      const request = await documentRequestService.create({
        applicationId,
        userId: application.userId,
        // Prefer the case's agency; fall back to the caller's own claim so an
        // independent agent's requests still carry a consistent scope key.
        agencyId: application.agencyId ?? req.authz?.agencyId ?? null,
        documentType: documentType.trim(),
        notes,
        dueDate,
        requestedBy: userId,
        requestedByName,
        visaTypeName: application.visaTypeName,
        countryName: application.countryName,
      });

      // --- Side effects (never allowed to fail the request) -------------------
      await this.announce(request.id, application, {
        actorId: userId,
        actorName: requestedByName,
        documentType: request.documentType,
        notes: request.notes,
      });

      sendCreated(res, request, "Document requested from client");
    } catch (error) {
      console.error("Error creating document request:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  /**
   * PATCH /document-requests/:id
   * Body: { status: "waived" | "cancelled" }
   *
   * Agent-side resolution of an ask that's no longer needed. `fulfilled` is NOT
   * settable here — that transition is owned by the upload path (`POST /documents`
   * with a `documentRequestId`) so a request can only ever be marked fulfilled by
   * a real document actually landing.
   */
  async resolve(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const userId = req.userId!;
      const { id } = req.params;
      const { status } = req.body as { status?: string };

      if (!status || !RESOLVABLE_STATUSES.includes(status as DocumentRequestStatus)) {
        sendError(
          res,
          "VALIDATION_ERROR",
          `status must be one of: ${RESOLVABLE_STATUSES.join(", ")}`,
          400
        );
        return;
      }

      const existing = await documentRequestService.getById(id);
      if (!existing) {
        sendError(res, "NOT_FOUND", "Document request not found", 404);
        return;
      }

      // Re-check access against the parent case, and bar the applicant — a client
      // must not be able to make their own outstanding items disappear.
      const application = await applicationService.getApplicationById(
        existing.applicationId
      );
      if (!application) {
        sendError(res, "NOT_FOUND", "Application not found", 404);
        return;
      }
      const isApplicant = application.userId === userId;
      if (!this.checkAccess(req, application) || isApplicant) {
        sendError(res, "FORBIDDEN", ErrorMessages.FORBIDDEN, 403);
        return;
      }

      // Only a still-pending ask can be resolved; anything else is already final.
      if (existing.status !== "pending") {
        sendError(
          res,
          "VALIDATION_ERROR",
          `This request is already ${existing.status}`,
          400
        );
        return;
      }

      const updated = await documentRequestService.resolve(
        id,
        status as "waived" | "cancelled",
        userId
      );

      // Audit the withdrawal on the case notes feed (best-effort).
      const actorName = (await userService.getDisplayName(userId)) || "An agent";
      await noteService
        .addActivityNote(
          existing.applicationId,
          `${actorName} ${status === "waived" ? "waived" : "cancelled"} the document ` +
            `request for "${existing.documentType}".`,
          { id: userId, name: actorName }
        )
        .catch((e) =>
          console.error("[document-request] resolve note failed:", e)
        );

      sendSuccess(res, updated, `Document request ${status}`);
    } catch (error) {
      console.error("Error resolving document request:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  // ============================================
  // HELPER METHODS
  // ============================================

  /**
   * Can this principal act on the given case? Delegates to the shared CASL
   * ability so the rule matches every other application-scoped endpoint: admin
   * (all), applicant (own), assigned agent, and same-agency members.
   */
  private checkAccess(
    req: AuthenticatedRequest,
    application: Application
  ): boolean {
    return can(
      req,
      "read",
      asSubject("Application", application as unknown as Record<string, unknown>)
    );
  }

  /**
   * Record the ask on the case's activity feed and tell the client about it.
   *
   * Both side effects are best-effort: a failed note or a failed push must never
   * roll back a request that was already written to Firestore, so each is caught
   * and logged independently.
   *
   * `relatedEntityId` stays the APPLICATION id (not the request id) so existing
   * deep-link handlers in the mobile app keep working unchanged; the request id
   * rides along in `data` for clients that know to use it.
   */
  private async announce(
    requestId: string,
    application: Application,
    ctx: {
      actorId: string;
      actorName: string;
      documentType: string;
      notes?: string;
    }
  ): Promise<void> {
    await noteService
      .addActivityNote(
        application.id,
        `${ctx.actorName} requested a document from the client: ${ctx.documentType}.` +
          (ctx.notes ? ` Note: ${ctx.notes}` : ""),
        { id: ctx.actorId, name: ctx.actorName }
      )
      .catch((e) => console.error("[document-request] activity note failed:", e));

    await notificationService
      .notifyUser({
        userId: application.userId,
        type: "document_status",
        title: "Document requested",
        body:
          `Your agent requested a document: ${ctx.documentType}.` +
          (ctx.notes ? ` ${ctx.notes}` : ""),
        // in-app + email + push so a client without the mobile app still hears
        // about it and can act on it from the web workspace.
        channels: ["in_app", "email", "push"],
        relatedEntityType: "application",
        relatedEntityId: application.id,
        data: { documentRequestId: requestId },
      })
      .catch((e) => console.error("[document-request] notify failed:", e));
  }
}

// Singleton — matches the pattern used by every other controller in this app.
export const documentRequestController = new DocumentRequestController();
