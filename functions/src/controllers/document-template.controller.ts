/**
 * Document template controller — read-only catalog endpoints.
 *
 *   GET /document-templates            → templates visible to the caller
 *   GET /document-templates/:id        → one template (add ?includeContent=true
 *                                        to include the ProseMirror body)
 *
 * Visibility is scope-based: every caller sees global templates plus their own
 * agency's templates. Only agent-side roles reach these routes (enforced by the
 * route middleware), so there's no per-document ownership check here.
 */
import { Response } from "express";
import { AuthenticatedRequest } from "../middleware/auth";
import {
  documentTemplateService,
  TemplateFilters,
} from "../services/document-template.service";
import { Agent, DocumentTemplate, ProseMirrorDoc, TemplateCategory } from "../types";
import { collections } from "../utils/firebase";
import { ROLES } from "@durin-tech/authz";
import {
  sendSuccess,
  sendCreated,
  sendError,
  ErrorMessages,
} from "../utils/response";

// Allowed template categories (validated on create/update).
const VALID_CATEGORIES: TemplateCategory[] = [
  "cover_letter",
  "sop",
  "affidavit",
  "other",
];

// A minimally-valid ProseMirror document (a `doc` node, optional content array).
function isProseMirrorDoc(v: unknown): v is ProseMirrorDoc {
  return (
    typeof v === "object" &&
    v !== null &&
    (v as { type?: unknown }).type === "doc"
  );
}

export class DocumentTemplateController {
  /**
   * GET /document-templates?category=...&search=...
   */
  async list(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const filters: TemplateFilters = {
        category: req.query.category as TemplateCategory | undefined,
        search: req.query.search as string | undefined,
      };

      // The caller's agency (may be null for admins / independent agents); used
      // to include agency-scoped templates alongside the global ones.
      const agencyId = req.authz?.agencyId ?? null;
      const templates = await documentTemplateService.listVisibleTemplates(
        agencyId,
        filters
      );
      sendSuccess(res, templates);
    } catch (error) {
      console.error("Error listing document templates:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  /**
   * GET /document-templates/:id?includeContent=true
   */
  async getOne(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const includeContent = req.query.includeContent === "true";

      const template = await documentTemplateService.getById(id, includeContent);
      if (!template) {
        sendError(res, "NOT_FOUND", ErrorMessages.NOT_FOUND, 404);
        return;
      }

      // Enforce scope: a caller may only view global templates or ones belonging
      // to their own agency. Admins (no agency) may view any.
      const isAdmin = req.authz?.role === "admin";
      const sameAgency =
        template.scope === "global" ||
        (!!template.agencyId && template.agencyId === req.authz?.agencyId);
      if (!isAdmin && !sameAgency) {
        sendError(res, "FORBIDDEN", ErrorMessages.FORBIDDEN, 403);
        return;
      }

      sendSuccess(res, template);
    } catch (error) {
      console.error("Error getting document template:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  // ============================================
  // AUTHORING (any agent-side user — routes gated by verifyAgent)
  // ============================================

  /**
   * POST /document-templates  { title, category, content, description? }
   *
   * Any agent-side user (agent/owner/admin) can create a template. It's added to
   * the shared GLOBAL catalog so every portal user can use it. `createdBy` records
   * the author so they (or an admin) can later edit/delete it.
   */
  async create(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const userId = req.userId!;
      const { title, description, category, content } = req.body ?? {};

      if (!title || typeof title !== "string") {
        sendError(res, "VALIDATION_ERROR", "title is required");
        return;
      }
      if (!VALID_CATEGORIES.includes(category)) {
        sendError(
          res,
          "VALIDATION_ERROR",
          `category must be one of: ${VALID_CATEGORIES.join(", ")}`
        );
        return;
      }
      if (!isProseMirrorDoc(content)) {
        sendError(res, "VALIDATION_ERROR", "content must be a ProseMirror doc");
        return;
      }

      const createdByName = await this.resolveDisplayName(userId);
      const template = await documentTemplateService.create({
        title,
        description: typeof description === "string" ? description : undefined,
        category,
        content,
        scope: "global",
        createdBy: userId,
        createdByName,
      });
      sendCreated(res, template);
    } catch (error) {
      console.error("Error creating document template:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  /**
   * PUT /document-templates/:id  { title?, description?, category?, content? }
   */
  async update(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const { title, description, category, content } = req.body ?? {};

      // Ownership: creator or admin only.
      const existing = await documentTemplateService.getById(id, false);
      if (!existing) {
        sendError(res, "NOT_FOUND", ErrorMessages.NOT_FOUND, 404);
        return;
      }
      if (!this.canManageTemplate(req, existing)) {
        sendError(
          res,
          "FORBIDDEN",
          "You can only edit templates you created.",
          403
        );
        return;
      }

      // Validate any provided fields (all optional — patch semantics).
      if (title !== undefined && typeof title !== "string") {
        sendError(res, "VALIDATION_ERROR", "title must be a string");
        return;
      }
      if (category !== undefined && !VALID_CATEGORIES.includes(category)) {
        sendError(
          res,
          "VALIDATION_ERROR",
          `category must be one of: ${VALID_CATEGORIES.join(", ")}`
        );
        return;
      }
      if (content !== undefined && !isProseMirrorDoc(content)) {
        sendError(res, "VALIDATION_ERROR", "content must be a ProseMirror doc");
        return;
      }

      const updated = await documentTemplateService.update(id, {
        title,
        description,
        category,
        content,
      });
      if (!updated) {
        sendError(res, "NOT_FOUND", ErrorMessages.NOT_FOUND, 404);
        return;
      }
      sendSuccess(res, updated);
    } catch (error) {
      console.error("Error updating document template:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  /**
   * DELETE /document-templates/:id
   *
   * Returns 200 { id } (not 204) — the portal apiClient parses every body as JSON.
   */
  async remove(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;

      // Ownership: creator or admin only.
      const existing = await documentTemplateService.getById(id, false);
      if (!existing) {
        sendError(res, "NOT_FOUND", ErrorMessages.NOT_FOUND, 404);
        return;
      }
      if (!this.canManageTemplate(req, existing)) {
        sendError(
          res,
          "FORBIDDEN",
          "You can only delete templates you created.",
          403
        );
        return;
      }

      await documentTemplateService.delete(id);
      sendSuccess(res, { id });
    } catch (error) {
      console.error("Error deleting document template:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  // ============================================
  // HELPERS
  // ============================================

  /**
   * A template may be edited/deleted by its creator or by any admin. Seeded
   * templates (no `createdBy`) are therefore admin-only.
   */
  private canManageTemplate(
    req: AuthenticatedRequest,
    template: DocumentTemplate
  ): boolean {
    if (req.authz?.role === ROLES.ADMIN) return true;
    return !!template.createdBy && template.createdBy === req.userId;
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
    return "Seli user";
  }
}

export const documentTemplateController = new DocumentTemplateController();
