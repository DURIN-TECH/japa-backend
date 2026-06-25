import { subcollections, serverTimestamp } from "../utils/firebase";
import { ApplicationNote, NoteAuthorRole } from "../types";
import { Timestamp } from "firebase-admin/firestore";

class NoteService {
  /**
   * Get all notes for an application
   */
  async getNotes(applicationId: string): Promise<ApplicationNote[]> {
    const snapshot = await subcollections
      .notes(applicationId)
      .orderBy("createdAt", "desc")
      .get();

    return snapshot.docs.map((doc) => doc.data() as ApplicationNote);
  }

  /**
   * Add a note to an application
   */
  async addNote(
    applicationId: string,
    authorId: string,
    authorName: string,
    authorRole: NoteAuthorRole,
    content: string
  ): Promise<ApplicationNote> {
    const noteRef = subcollections.notes(applicationId).doc();
    const now = Timestamp.now();

    const note: ApplicationNote = {
      id: noteRef.id,
      applicationId,
      authorId,
      authorName,
      authorRole,
      content,
      createdAt: now,
      updatedAt: now,
    };

    await noteRef.set(note);
    return note;
  }

  /**
   * Record an automatic "activity" note on a case — a system-authored entry that
   * captures something done in relation to the case (status change, document
   * request, document review, agent assignment, etc.) so the notes feed doubles
   * as an audit trail of everything that has happened.
   *
   * `actor` attributes the activity to the agent who performed it: their name is
   * stored as `authorName` (and id as `authorId`) so the audit trail shows WHO
   * acted. The `authorRole` stays "system" so the portal still renders it as an
   * activity entry (badge, not editable). Callers should also embed the actor's
   * name in `content` since the notes list shows content (not author).
   *
   * Best-effort: failures are logged and swallowed so this side-effect can never
   * break the underlying mutation that triggered it (mirrors the notification
   * service's fail-soft behaviour).
   */
  async addActivityNote(
    applicationId: string,
    content: string,
    actor?: { id?: string; name?: string }
  ): Promise<void> {
    try {
      // Attribute to the acting agent when known; otherwise fall back to the
      // generic system sentinel. authorRole stays "system" regardless so the
      // portal renders these as activity entries (badge, no edit/delete).
      await this.addNote(
        applicationId,
        actor?.id || "system",
        actor?.name?.trim() || "Seli",
        "system",
        content
      );
    } catch (err) {
      console.error("[addActivityNote] failed to record activity note:", err);
    }
  }

  /**
   * Update a note's content
   */
  async updateNote(
    applicationId: string,
    noteId: string,
    content: string
  ): Promise<ApplicationNote> {
    const noteRef = subcollections.notes(applicationId).doc(noteId);
    const doc = await noteRef.get();

    if (!doc.exists) {
      throw new Error("Note not found");
    }

    await noteRef.update({
      content,
      updatedAt: serverTimestamp(),
    });

    const updated = await noteRef.get();
    return updated.data() as ApplicationNote;
  }

  /**
   * Delete a note
   */
  async deleteNote(applicationId: string, noteId: string): Promise<void> {
    const noteRef = subcollections.notes(applicationId).doc(noteId);
    const doc = await noteRef.get();

    if (!doc.exists) {
      throw new Error("Note not found");
    }

    await noteRef.delete();
  }
}

export const noteService = new NoteService();
