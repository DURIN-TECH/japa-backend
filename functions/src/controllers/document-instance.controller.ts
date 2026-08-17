/**
 * Document instance controller — editable documents cloned from templates.
 *
 *   GET    /document-instances                 → list (scoped by role/app)
 *   POST   /document-instances                 → clone a template into an instance
 *   GET    /document-instances/:id             → one instance (with content)
 *   PUT    /document-instances/:id             → save (optimistic concurrency)
 *   PATCH  /document-instances/:id/link        → link/unlink to an application
 *   PATCH  /document-instances/:id/share       → toggle share-with-client
 *   DELETE /document-instances/:id             → delete (+ version history)
 *   GET    /document-instances/:id/versions    → version history
 *
 * Authorization reuses the shared CASL "Document" ability: agency owners manage
 * every instance in their agency; agents manage the instances they authored.
 * The read-only-plan 402 gate is applied globally in `verifyAuth`.
 */
import { Response } from "express";
import { AuthenticatedRequest } from "../middleware/auth";
import { documentInstanceService } from "../services/document-instance.service";
import { documentTemplateService } from "../services/document-template.service";
import { applicationService } from "../services/application.service";
import { collections } from "../utils/firebase";
import {
  Agent,
  Application,
  DocumentInstance,
  DocumentShareStatus,
} from "../types";
import { can, asSubject } from "../middleware/authz";
import { ROLES } from "@durin-tech/authz";
import { sendSuccess, sendCreated, sendError, ErrorMessages } from "../utils/response";

export class DocumentInstanceController {
  /**
   * GET /document-instances?role=agent|owner|admin&applicationId=...&status=...&search=...
   *
   * Scope resolution:
   *   - applicationId present → instances for that case (after access check)
   *   - role=admin            → all instances (admin only)
   *   - role=owner            → all instances in the caller's agency
   *   - role=agent (default)  → instances the caller authored
   * Optional `status`/`search` are applied in memory on top.
   */
  async list(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const userId = req.userId!;
      const role = (req.query.role as string) || ROLES.AGENT;
      const applicationId = req.query.applicationId as string | undefined;

      let instances: DocumentInstance[];

      if (applicationId) {
        // Case-scoped listing (LinkedDocumentsCard). Verify the caller can see
        // the application before exposing its documents.
        const appDoc = await collections.applications.doc(applicationId).get();
        if (!appDoc.exists) {
          sendError(res, "NOT_FOUND", "Application not found", 404);
          return;
        }
        const application = appDoc.data() as Application;
        if (!can(req, "read", asSubject("Application", application as unknown as Record<string, unknown>))) {
          sendError(res, "FORBIDDEN", ErrorMessages.FORBIDDEN, 403);
          return;
        }
        instances = await documentInstanceService.listForApplication(applicationId);
      } else {
        switch (role) {
        case ROLES.ADMIN: {
          if (req.authz?.role !== ROLES.ADMIN) {
            sendError(res, "FORBIDDEN", ErrorMessages.FORBIDDEN, 403);
            return;
          }
          instances = await documentInstanceService.listAll();
          break;
        }
        case ROLES.OWNER: {
          if (req.authz?.role !== ROLES.OWNER || !req.authz.agencyId) {
            sendError(
              res,
              "FORBIDDEN",
              "Only agency owners can view agency documents",
              403
            );
            return;
          }
          instances = await documentInstanceService.listForAgency(req.authz.agencyId);
          break;
        }
        case ROLES.AGENT:
        default: {
          instances = await documentInstanceService.listForAgent(userId);
          break;
        }
        }
      }

      // In-memory status/search filtering (lists are modest in size).
      const status = req.query.status as string | undefined;
      const search = (req.query.search as string | undefined)?.toLowerCase();
      if (status) instances = instances.filter((i) => i.status === status);
      if (search) instances = instances.filter((i) => i.title.toLowerCase().includes(search));

      sendSuccess(res, instances);
    } catch (error) {
      console.error("Error listing document instances:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  // ============================================
  // CLIENT-FACING READS
  // ============================================
  //
  // Everything above is agent-side (`verifyAgent`). Sharing a document with a
  // client was previously a dead end because of that: an agent could flip
  // `shareStatus` to "shared" and the client had no endpoint that would return
  // it. These two handlers are the missing read path.
  //
  // They deliberately do NOT go through the CASL "Document" ability, which
  // models agency-side ownership (author / agency owner / admin) and has no
  // notion of "the client this document is about". Access here is the narrower,
  // explicit rule: the caller must own the linked APPLICATION, and the document
  // must actually be shared.

  /**
   * Confirm the caller is the client on `applicationId`.
   *
   * Ownership is checked against `application.userId` rather than CASL because
   * that is exactly the relationship being authorized — and because an agent
   * calling these endpoints should fall through to the agent-side routes, not
   * get a second, laxer path to the same documents.
   */
  private async ownsApplication(
    userId: string,
    applicationId: string
  ): Promise<boolean> {
    const appDoc = await collections.applications.doc(applicationId).get();
    if (!appDoc.exists) return false;
    return (appDoc.data() as Application).userId === userId;
  }

  /**
   * GET /document-instances/shared?applicationId=...
   *
   * Documents an agency has shared with the authenticated client. With
   * `applicationId` it's scoped to that case; without one it spans every
   * application the client owns, which is what the "shared with you" list on a
   * client's home view needs.
   *
   * Content is stripped (as in every list response) — the client fetches a
   * single document's body via `GET /document-instances/shared/:id`.
   */
  async listShared(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const userId = req.userId!;
      const applicationId = req.query.applicationId as string | undefined;

      // Resolve which applications to look at: the requested one (after an
      // ownership check) or all of the caller's.
      let applicationIds: string[];
      if (applicationId) {
        if (!(await this.ownsApplication(userId, applicationId))) {
          // 403 rather than 404: the caller asked about a specific case, and
          // whether it exists isn't theirs to learn.
          sendError(res, "FORBIDDEN", ErrorMessages.FORBIDDEN, 403);
          return;
        }
        applicationIds = [applicationId];
      } else {
        const applications = await applicationService.getUserApplications(userId);
        applicationIds = applications.map((a) => a.id);
      }

      if (applicationIds.length === 0) {
        sendSuccess(res, []);
        return;
      }

      // One query per case, in parallel. A client has a handful of applications,
      // so this stays well inside a single request's budget — and it keeps each
      // query to the single equality filter the service standardises on.
      const perApplication = await Promise.all(
        applicationIds.map((id) =>
          documentInstanceService.listSharedForApplication(id)
        )
      );

      const instances = perApplication
        .flat()
        .sort((a, b) => b.updatedAt.toMillis() - a.updatedAt.toMillis());

      sendSuccess(res, instances);
    } catch (error) {
      console.error("Error listing shared document instances:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  /**
   * GET /document-instances/shared/:id
   *
   * A single shared document, WITH its content, for the client it was shared
   * with. Both conditions are re-checked here rather than trusted from the list
   * response: an agent can un-share a document at any moment, and this is the
   * request that actually hands over the body.
   */
  async getShared(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const userId = req.userId!;
      const { id } = req.params;

      const instance = await documentInstanceService.getById(id);
      if (!instance) {
        sendError(res, "NOT_FOUND", ErrorMessages.NOT_FOUND, 404);
        return;
      }

      // Unshared, or never linked to a case — indistinguishable from "doesn't
      // exist" as far as a client is concerned, and answered the same way so the
      // endpoint can't be used to probe for document ids.
      if (
        instance.shareStatus !== "shared" ||
        !instance.applicationId ||
        !(await this.ownsApplication(userId, instance.applicationId))
      ) {
        sendError(res, "NOT_FOUND", ErrorMessages.NOT_FOUND, 404);
        return;
      }

      sendSuccess(res, instance);
    } catch (error) {
      console.error("Error getting shared document instance:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  /**
   * GET /document-instances/:id
   */
  async getOne(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const instance = await documentInstanceService.getById(id);
      if (!instance) {
        sendError(res, "NOT_FOUND", ErrorMessages.NOT_FOUND, 404);
        return;
      }
      if (!can(req, "read", this.documentSubject(instance))) {
        sendError(res, "FORBIDDEN", ErrorMessages.FORBIDDEN, 403);
        return;
      }
      sendSuccess(res, instance);
    } catch (error) {
      console.error("Error getting document instance:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  /**
   * POST /document-instances  { templateId, applicationId?, title? }
   *
   * Clones a template into a new editable instance owned by the caller.
   */
  async clone(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const userId = req.userId!;
      const { templateId, applicationId, title } = req.body ?? {};

      if (!templateId) {
        sendError(res, "VALIDATION_ERROR", "templateId is required");
        return;
      }

      // Entitlement + role check: mirrors the portal's GatedButton
      // ({ action: "create", subject: "Document" }). The prospective subject
      // carries the caller as the author so ownership conditions match.
      const agencyId = req.authz?.agencyId ?? undefined;
      const prospective = asSubject("Document", {
        agentId: userId,
        agencyId,
        userId,
      });
      if (!can(req, "create", prospective)) {
        sendError(
          res,
          "FORBIDDEN",
          "You don't have permission to create documents.",
          403
        );
        return;
      }

      // Resolve the source template WITH content (needed to seed the clone).
      const template = await documentTemplateService.getById(templateId, true);
      if (!template) {
        sendError(res, "NOT_FOUND", "Template not found", 404);
        return;
      }
      // Scope check: the caller may only clone global or same-agency templates.
      const templateVisible =
        req.authz?.role === ROLES.ADMIN ||
        template.scope === "global" ||
        (!!template.agencyId && template.agencyId === agencyId);
      if (!templateVisible) {
        sendError(res, "FORBIDDEN", "Template not available to your agency", 403);
        return;
      }

      // Optional link at creation: validate access to the target application.
      let linkedApplicationId: string | null = null;
      if (applicationId) {
        const appDoc = await collections.applications.doc(applicationId).get();
        if (!appDoc.exists) {
          sendError(res, "NOT_FOUND", "Application not found", 404);
          return;
        }
        const application = appDoc.data() as Application;
        if (!can(req, "read", asSubject("Application", application as unknown as Record<string, unknown>))) {
          sendError(res, "FORBIDDEN", "You don't have access to that application", 403);
          return;
        }
        linkedApplicationId = applicationId;
      }

      const createdByName = await this.resolveDisplayName(userId);
      const instance = await documentInstanceService.clone({
        template,
        title: (title as string) || template.title,
        createdBy: userId,
        createdByName,
        agencyId,
        applicationId: linkedApplicationId,
      });

      // Audit: if the document was created already attached to a case, record it.
      await this.auditToCase(
        linkedApplicationId,
        "Document attached",
        `"${instance.title}" was created from a template and attached by ${createdByName}.`
      );

      sendCreated(res, instance);
    } catch (error) {
      console.error("Error cloning template:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  /**
   * PUT /document-instances/:id  { content, version, title? }
   *
   * Optimistic-concurrency save. A stale `version` returns 409 VERSION_CONFLICT
   * with the current version + last editor so the editor can prompt the user.
   */
  async save(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const userId = req.userId!;
      const { id } = req.params;
      const { content, version, title } = req.body ?? {};

      if (content === undefined || typeof version !== "number") {
        sendError(res, "VALIDATION_ERROR", "content and numeric version are required");
        return;
      }

      // Load first for the access check (the transaction re-reads for concurrency).
      const existing = await documentInstanceService.getById(id);
      if (!existing) {
        sendError(res, "NOT_FOUND", ErrorMessages.NOT_FOUND, 404);
        return;
      }
      if (!can(req, "update", this.documentSubject(existing))) {
        sendError(res, "FORBIDDEN", ErrorMessages.FORBIDDEN, 403);
        return;
      }

      const editorName = await this.resolveDisplayName(userId);
      const result = await documentInstanceService.save(id, {
        content,
        expectedVersion: version,
        title,
        editorName,
      });

      if (result.status === "notFound") {
        sendError(res, "NOT_FOUND", ErrorMessages.NOT_FOUND, 404);
        return;
      }
      if (result.status === "conflict") {
        // 409 carries a structured body the portal's apiClient relays as
        // `data` so the editor can show "edited by X (version N)".
        res.status(409).json({
          success: false,
          error: "VERSION_CONFLICT",
          message: "This document was updated by someone else. Reload or overwrite.",
          data: {
            currentVersion: result.current.version,
            updatedByName: result.current.updatedByName,
            updatedAt: result.current.updatedAt,
          },
        });
        return;
      }

      // Audit: record the edit on the linked case (if any). The per-version
      // snapshot in the versions subcollection is the fine-grained history; this
      // timeline entry surfaces the activity on the case screen.
      await this.auditToCase(
        result.instance.applicationId,
        "Document updated",
        `"${result.instance.title}" was edited by ${editorName} (version ${result.instance.version}).`
      );

      sendSuccess(res, result.instance);
    } catch (error) {
      console.error("Error saving document instance:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  /**
   * PATCH /document-instances/:id/link  { applicationId: string | null }
   */
  async link(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const userId = req.userId!;
      const { id } = req.params;
      const { applicationId } = req.body ?? {};

      const existing = await documentInstanceService.getById(id);
      if (!existing) {
        sendError(res, "NOT_FOUND", ErrorMessages.NOT_FOUND, 404);
        return;
      }
      if (!can(req, "update", this.documentSubject(existing))) {
        sendError(res, "FORBIDDEN", ErrorMessages.FORBIDDEN, 403);
        return;
      }

      // Linking (non-null) requires access to the target application. Unlinking
      // (null) just detaches and needs no application check.
      if (applicationId) {
        const appDoc = await collections.applications.doc(applicationId).get();
        if (!appDoc.exists) {
          sendError(res, "NOT_FOUND", "Application not found", 404);
          return;
        }
        const application = appDoc.data() as Application;
        if (!can(req, "read", asSubject("Application", application as unknown as Record<string, unknown>))) {
          sendError(res, "FORBIDDEN", "You don't have access to that application", 403);
          return;
        }
      }

      const previousApplicationId = existing.applicationId;
      const nextApplicationId = (applicationId as string | null) ?? null;
      const updated = await documentInstanceService.setApplication(
        id,
        nextApplicationId
      );

      // Audit the attach/detach on the affected case timelines.
      if (previousApplicationId !== nextApplicationId) {
        const actor = await this.resolveDisplayName(userId);
        // Detach from the previous case (if it was linked to a different one).
        if (previousApplicationId) {
          await this.auditToCase(
            previousApplicationId,
            "Document detached",
            `"${existing.title}" was detached from this case by ${actor}.`
          );
        }
        // Attach to the new case (if now linked).
        if (nextApplicationId) {
          await this.auditToCase(
            nextApplicationId,
            "Document attached",
            `"${existing.title}" was attached to this case by ${actor}.`
          );
        }
      }

      sendSuccess(res, updated);
    } catch (error) {
      console.error("Error linking document instance:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  /**
   * PATCH /document-instances/:id/share  { shareStatus: "private" | "shared" }
   */
  async share(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const { shareStatus } = req.body ?? {};

      const valid: DocumentShareStatus[] = ["private", "shared"];
      if (!valid.includes(shareStatus)) {
        sendError(res, "VALIDATION_ERROR", "shareStatus must be 'private' or 'shared'");
        return;
      }

      const existing = await documentInstanceService.getById(id);
      if (!existing) {
        sendError(res, "NOT_FOUND", ErrorMessages.NOT_FOUND, 404);
        return;
      }
      if (!can(req, "update", this.documentSubject(existing))) {
        sendError(res, "FORBIDDEN", ErrorMessages.FORBIDDEN, 403);
        return;
      }

      const updated = await documentInstanceService.setShareStatus(id, shareStatus);

      // Audit the share/unshare on the linked case (if any).
      const actor = await this.resolveDisplayName(req.userId!);
      await this.auditToCase(
        existing.applicationId,
        shareStatus === "shared" ? "Document shared with client" : "Document sharing revoked",
        shareStatus === "shared"
          ? `"${existing.title}" was shared with the client by ${actor}.`
          : `Sharing of "${existing.title}" with the client was revoked by ${actor}.`
      );

      sendSuccess(res, updated);
    } catch (error) {
      console.error("Error updating share status:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  /**
   * DELETE /document-instances/:id
   *
   * Returns 200 with `{ id }` (not 204) — the portal's apiClient parses every
   * response body as JSON, so an empty 204 would surface as a failure.
   */
  async remove(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;

      const existing = await documentInstanceService.getById(id);
      if (!existing) {
        sendError(res, "NOT_FOUND", ErrorMessages.NOT_FOUND, 404);
        return;
      }
      if (!can(req, "delete", this.documentSubject(existing))) {
        sendError(res, "FORBIDDEN", ErrorMessages.FORBIDDEN, 403);
        return;
      }

      // Audit the removal on the linked case (if any) BEFORE deleting, while we
      // still hold the instance's title + link.
      const actor = await this.resolveDisplayName(req.userId!);
      await this.auditToCase(
        existing.applicationId,
        "Document removed",
        `"${existing.title}" was deleted by ${actor}.`
      );

      await documentInstanceService.delete(id);
      sendSuccess(res, { id });
    } catch (error) {
      console.error("Error deleting document instance:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  /**
   * GET /document-instances/:id/versions
   */
  async versions(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;

      const existing = await documentInstanceService.getById(id);
      if (!existing) {
        sendError(res, "NOT_FOUND", ErrorMessages.NOT_FOUND, 404);
        return;
      }
      if (!can(req, "read", this.documentSubject(existing))) {
        sendError(res, "FORBIDDEN", ErrorMessages.FORBIDDEN, 403);
        return;
      }

      const versions = await documentInstanceService.listVersions(id);
      sendSuccess(res, versions);
    } catch (error) {
      console.error("Error listing document versions:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  // ============================================
  // HELPERS
  // ============================================

  /**
   * Tag an instance as a CASL "Document" subject. The shared ability matches
   * agents on `agentId` and owners on `agencyId`; the stored field is `createdBy`,
   * so we surface it as `agentId` (and `userId`, harmless for the client rule).
   */
  private documentSubject(
    instance: DocumentInstance
  ): Parameters<typeof can>[2] {
    return asSubject("Document", {
      ...(instance as unknown as Record<string, unknown>),
      agentId: instance.createdBy,
      userId: instance.createdBy,
    });
  }

  /**
   * Audit trail: append an entry to the linked application's case timeline (the
   * same feed shown on the case-detail screen), so document actions — attach,
   * detach, edit, share, delete — are visible in the case history.
   *
   * Best-effort and non-fatal: a timeline write failure must never fail the
   * underlying document operation, so errors are swallowed with a log. No-ops
   * when there is no linked application (nothing to attach the audit to).
   */
  private async auditToCase(
    applicationId: string | null | undefined,
    title: string,
    description: string
  ): Promise<void> {
    if (!applicationId) return;
    try {
      await applicationService.addTimelineEntry(applicationId, {
        title,
        description,
        status: "completed",
        responsibility: "agent",
      });
    } catch (error) {
      console.error("[document-instance] audit timeline write failed:", error);
    }
  }

  /**
   * Resolve a display name for denormalization: prefer the agent profile's
   * displayName, then the user's first/last name, else a generic fallback.
   */
  private async resolveDisplayName(userId: string): Promise<string> {
    const agentSnap = await collections.agents
      .where("userId", "==", userId)
      .limit(1)
      .get();
    if (!agentSnap.empty) {
      const agent = agentSnap.docs[0].data() as Agent;
      if (agent.displayName) return agent.displayName;
    }
    const userDoc = await collections.users.doc(userId).get();
    if (userDoc.exists) {
      const u = userDoc.data() as { firstName?: string; lastName?: string };
      const name = `${u.firstName || ""} ${u.lastName || ""}`.trim();
      if (name) return name;
    }
    return "Agent";
  }
}

export const documentInstanceController = new DocumentInstanceController();
