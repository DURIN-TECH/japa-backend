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
//  - the value is validated by the item's `answerType` (answer-values.ts: date,
//    date_range, money, address, list, text); a missing type is "text";
//  - an EMPTY value of any type CLEARS the answer (the document is deleted);
//  - answers are personal data: NEVER logged, never sent to analytics, and the
//    collection is closed to client SDKs by firestore.rules.
//
// STORED DOCUMENT: { answerType, value, updatedAt, updatedBy } (+ `text` for a
// text answer, so older readers keep working). A LEGACY document is
// { text, updatedAt, updatedBy } with no `answerType`/`value`.
//
// NO authorisation here: the controller has already run
// `checkApplicationAccessForRequest`.

import { Timestamp } from "firebase-admin/firestore";
import { subcollections } from "../utils/firebase";
import { checklistService } from "./ai/checklist.service";
import {
  AnswerValidationError,
  MAX_ANSWER_LENGTH,
  isEmptyAnswer,
  legacyValueFor,
  renderAnswerText,
  validateAnswerValue,
  type AnswerValue,
} from "./answer-values";
import { isAnswerType, type AnswerType } from "../scrapers";
import type { Application } from "../types";

// Re-exported so existing imports keep working.
export { AnswerValidationError, MAX_ANSWER_LENGTH };

/** One stored answer as the API returns it. */
export interface AnswerView {
  /** The answer's type (the item's CURRENT type when it is still on the checklist). */
  answerType: AnswerType;
  /** The typed value (see answer-values.ts). For `legacy: true` see legacyValueFor. */
  value: unknown;
  /** Plain-text rendering of `value` (text answers: the text itself). */
  text: string;
  /** True for an answer saved before types existed (or under a different type) and re-read as this type. */
  legacy?: true;
  updatedAt: string; // ISO 8601
}

/** The shape of the stored document. */
interface StoredAnswer {
  answerType?: AnswerType;
  value?: unknown;
  text?: string;
  updatedAt: Timestamp;
  updatedBy?: string;
}

/**
 * Validate a client-supplied TEXT answer. Pure. Returns the trimmed text.
 * Kept for the text type's callers and tests.
 * @throws AnswerValidationError for a non-string or over-length answer
 */
export function validateAnswerText(raw: unknown): string {
  return validateAnswerValue("text", raw) as string;
}

/**
 * Read one stored document as the API shape for `itemType` (the item's current
 * type, or undefined when the item is no longer on the checklist).
 * No data loss, never throws: a legacy string, or a value saved under another
 * type, is re-read as `itemType` with `legacy: true`.
 */
export function toAnswerView(d: StoredAnswer, itemType: AnswerType | undefined): AnswerView {
  const updatedAt = d.updatedAt.toDate().toISOString();
  const storedType = isAnswerType(d.answerType) && d.value !== undefined ? d.answerType : undefined;
  const type = itemType ?? storedType ?? "text";
  if (storedType && storedType === type) {
    return { answerType: type, value: d.value, text: renderAnswerText(d.value), updatedAt };
  }
  // Legacy: the plain string, or the text rendering of a value of another type.
  const plain = storedType ? renderAnswerText(d.value) : typeof d.text === "string" ? d.text : "";
  if (type === "text") return { answerType: "text", value: plain, text: plain, ...(storedType ? { legacy: true as const } : {}), updatedAt };
  return { answerType: type, value: legacyValueFor(type, plain), text: plain, legacy: true, updatedAt };
}

class AnswersService {
  /**
   * All stored answers of an application, keyed by checklist item id, each in
   * the shape of its item's current type (legacy strings re-read, never lost).
   */
  async getAnswers(application: Application): Promise<Record<string, AnswerView>> {
    const snap = await subcollections.answers(application.id).get();
    if (snap.empty) return {};
    // Current types, to re-read legacy answers as the item's type. A checklist
    // failure must not fail the read: fall back to each answer's stored type.
    const types = new Map<string, AnswerType>();
    try {
      const view = await checklistService.getChecklist(application);
      for (const i of view.items) if (i.kind === "information") types.set(i.checklistItemId, i.answerType ?? "text");
    } catch {
      /* stored types are used */
    }
    const out: Record<string, AnswerView> = {};
    for (const doc of snap.docs) out[doc.id] = toAnswerView(doc.data() as StoredAnswer, types.get(doc.id));
    return out;
  }

  /**
   * Save (or clear, with an empty value) the answer to one information item.
   * @throws AnswerValidationError for a bad value, an unknown item, or a document item
   */
  async saveAnswer(
    application: Application,
    itemId: string,
    rawValue: unknown,
    userId: string
  ): Promise<{ itemId: string; answerType: AnswerType; value: AnswerValue | null; text: string; updatedAt: string }> {
    // The item must exist on the current checklist and be information.
    const view = await checklistService.getChecklist(application);
    const item = view.items.find((i) => i.checklistItemId === itemId);
    if (!item) throw new AnswerValidationError("Unknown checklist item");
    if (item.kind !== "information") {
      throw new AnswerValidationError("This item is a document to upload, not information to answer");
    }
    const type: AnswerType = item.answerType ?? "text";
    const ref = subcollections.answers(application.id).doc(itemId);
    const now = Timestamp.now();
    if (isEmptyAnswer(type, rawValue)) {
      await ref.delete(); // an empty value clears the answer
      return { itemId, answerType: type, value: null, text: "", updatedAt: now.toDate().toISOString() };
    }
    const value = validateAnswerValue(type, rawValue);
    const text = renderAnswerText(value);
    await ref.set({
      answerType: type,
      value,
      // A text answer also keeps the legacy field so older readers still see it.
      ...(type === "text" ? { text } : {}),
      updatedAt: now,
      updatedBy: userId,
    } satisfies StoredAnswer);
    return { itemId, answerType: type, value, text, updatedAt: now.toDate().toISOString() };
  }
}

export const answersService = new AnswersService();
