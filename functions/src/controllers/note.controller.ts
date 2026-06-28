import { Response } from "express";
import { AuthenticatedRequest } from "../middleware/auth";
import { noteService } from "../services/note.service";
import { applicationService } from "../services/application.service";
import { collections } from "../utils/firebase";
import { can, asSubject } from "../middleware/authz";
import { ROLES } from "@durin-tech/authz";
import {
  sendSuccess,
  sendError,
  sendCreated,
  sendNoContent,
  ErrorMessages,
} from "../utils/response";
import { NoteAuthorRole } from "../types";

export class NoteController {
  /**
   * GET /applications/:id/notes
   * Get all notes for an application
   */
  async getNotes(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;

      const application = await applicationService.getApplicationById(id);
      if (!application) {
        sendError(res, "NOT_FOUND", "Application not found", 404);
        return;
      }

      const hasAccess = can(
        req,
        "read",
        asSubject("Application", application as unknown as Record<string, unknown>)
      );
      if (!hasAccess) {
        sendError(res, "FORBIDDEN", ErrorMessages.FORBIDDEN, 403);
        return;
      }

      const notes = await noteService.getNotes(id);
      sendSuccess(res, notes);
    } catch (error) {
      console.error("Error getting notes:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  /**
   * POST /applications/:id/notes
   * Add a note to an application
   */
  async addNote(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const userId = req.userId!;
      const { id } = req.params;
      const { content } = req.body;

      if (!content || typeof content !== "string" || !content.trim()) {
        sendError(res, "VALIDATION_ERROR", "content is required", 400);
        return;
      }

      const application = await applicationService.getApplicationById(id);
      if (!application) {
        sendError(res, "NOT_FOUND", "Application not found", 404);
        return;
      }

      const hasAccess = can(
        req,
        "read",
        asSubject("Application", application as unknown as Record<string, unknown>)
      );
      if (!hasAccess) {
        sendError(res, "FORBIDDEN", ErrorMessages.FORBIDDEN, 403);
        return;
      }

      // Resolve author name and role
      const { authorName, authorRole } = await this.resolveAuthor(req);

      const note = await noteService.addNote(
        id,
        userId,
        authorName,
        authorRole,
        content.trim()
      );

      sendCreated(res, note, "Note added successfully");
    } catch (error) {
      console.error("Error adding note:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  /**
   * PUT /applications/:id/notes/:noteId
   * Update a note (only the author can update)
   */
  async updateNote(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const userId = req.userId!;
      const { id, noteId } = req.params;
      const { content } = req.body;

      if (!content || typeof content !== "string" || !content.trim()) {
        sendError(res, "VALIDATION_ERROR", "content is required", 400);
        return;
      }

      // Verify the note exists and belongs to this user
      const notes = await noteService.getNotes(id);
      const note = notes.find((n) => n.id === noteId);

      if (!note) {
        sendError(res, "NOT_FOUND", "Note not found", 404);
        return;
      }

      if (note.authorId !== userId && req.authz?.role !== ROLES.ADMIN) {
        sendError(res, "FORBIDDEN", "You can only edit your own notes", 403);
        return;
      }

      const updated = await noteService.updateNote(id, noteId, content.trim());
      sendSuccess(res, updated, "Note updated successfully");
    } catch (error) {
      console.error("Error updating note:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  /**
   * DELETE /applications/:id/notes/:noteId
   * Delete a note (only the author or admin can delete)
   */
  async deleteNote(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const userId = req.userId!;
      const { id, noteId } = req.params;

      // Verify the note exists and belongs to this user
      const notes = await noteService.getNotes(id);
      const note = notes.find((n) => n.id === noteId);

      if (!note) {
        sendError(res, "NOT_FOUND", "Note not found", 404);
        return;
      }

      if (note.authorId !== userId && req.authz?.role !== ROLES.ADMIN) {
        sendError(res, "FORBIDDEN", "You can only delete your own notes", 403);
        return;
      }

      await noteService.deleteNote(id, noteId);
      sendNoContent(res);
    } catch (error) {
      console.error("Error deleting note:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  // ============================================
  // HELPER METHODS
  // ============================================

  /**
   * Resolve the display name and role for a note author from the role claim.
   * Notes are agent-side, so any non-agent-side role (e.g. a client) is recorded
   * as "agent" (preserving prior behaviour).
   */
  private async resolveAuthor(
    req: AuthenticatedRequest
  ): Promise<{ authorName: string; authorRole: NoteAuthorRole }> {
    const uid = req.userId!;
    const userDoc = await collections.users.doc(uid).get();
    const userData = userDoc.exists ? userDoc.data() : null;
    const authorName = userData
      ? `${userData.firstName || ""} ${userData.lastName || ""}`.trim()
      : "Unknown";

    const role = req.authz?.role;
    const authorRole: NoteAuthorRole =
      role === ROLES.ADMIN || role === ROLES.OWNER || role === ROLES.AGENT
        ? role
        : "agent";
    return { authorName, authorRole };
  }
}

export const noteController = new NoteController();
