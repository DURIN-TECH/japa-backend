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
import { TemplateCategory } from "../types";
import { sendSuccess, sendError, ErrorMessages } from "../utils/response";

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
}

export const documentTemplateController = new DocumentTemplateController();
