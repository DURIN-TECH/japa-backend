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
