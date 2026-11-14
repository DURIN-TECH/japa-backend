// ============================================
// ANSWERS SERVICE (issue #187)
// ============================================
//
// Some items on an applicant's checklist are INFORMATION (typed in), not
// documents (uploaded): "the dates you're planning to travel", "your current
// home address". This service stores the applicant's answer to each, one
// document per item at `applications/{applicationId}/answers/{checklistItemId}`.
//
// Rules:
//  - the item must be an `information` item on the application's CURRENT
//    checklist (unknown ids and document items are rejected: 400);
//  - the text is trimmed and at most MAX_ANSWER_LENGTH characters; an empty
//    string CLEARS the answer (the document is deleted);
//  - answers are personal data: NEVER logged, never sent to analytics, and the
//    collection is closed to client SDKs by firestore.rules.
//
// NO authorisation here: the controller has already run
// `checkApplicationAccessForRequest`.

import { Timestamp } from "firebase-admin/firestore";
import { subcollections } from "../utils/firebase";
import { checklistService } from "./ai/checklist.service";
import type { Application } from "../types";

/** Longest answer accepted, in characters (orchestrator decision on #187). */
export const MAX_ANSWER_LENGTH = 2000;

/** A rejected input. The message is safe to show and never contains answer text. */
export class AnswerValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AnswerValidationError";
  }
}

/** One stored answer as the API returns it. */
export interface AnswerView {
  text: string;
  updatedAt: string; // ISO 8601
}

/** The shape of the stored document. */
interface StoredAnswer {
  text: string;
  updatedAt: Timestamp;
  updatedBy?: string;
}

/**
 * Validate a client-supplied answer. Pure. Returns the trimmed text.
 * @throws AnswerValidationError for a non-string or over-length answer
 */
export function validateAnswerText(raw: unknown): string {
  if (typeof raw !== "string") throw new AnswerValidationError("\"text\" must be a string");
  const text = raw.trim();
  if (text.length > MAX_ANSWER_LENGTH) {
    throw new AnswerValidationError(`"text" must be at most ${MAX_ANSWER_LENGTH} characters`);
  }
  return text;
}

class AnswersService {
  /** All stored answers of an application, keyed by checklist item id. */
  async getAnswers(applicationId: string): Promise<Record<string, AnswerView>> {
    const snap = await subcollections.answers(applicationId).get();
    const out: Record<string, AnswerView> = {};
    for (const doc of snap.docs) {
      const d = doc.data() as StoredAnswer;
      out[doc.id] = { text: d.text, updatedAt: d.updatedAt.toDate().toISOString() };
    }
    return out;
  }

  /**
   * Save (or clear, with "") the answer to one information item.
   * @throws AnswerValidationError for bad text, an unknown item, or a document item
   */
  async saveAnswer(
    application: Application,
    itemId: string,
    rawText: unknown,
    userId: string
  ): Promise<{ itemId: string; text: string; updatedAt: string }> {
    const text = validateAnswerText(rawText);
    // The item must exist on the current checklist and be information.
    const view = await checklistService.getChecklist(application);
    const item = view.items.find((i) => i.checklistItemId === itemId);
    if (!item) throw new AnswerValidationError("Unknown checklist item");
    if (item.kind !== "information") {
      throw new AnswerValidationError("This item is a document to upload, not information to answer");
    }
    const ref = subcollections.answers(application.id).doc(itemId);
    const now = Timestamp.now();
    if (text === "") {
      await ref.delete(); // an empty string clears the answer
    } else {
      await ref.set({ text, updatedAt: now, updatedBy: userId } satisfies StoredAnswer);
    }
    return { itemId, text, updatedAt: now.toDate().toISOString() };
  }
}

export const answersService = new AnswersService();
