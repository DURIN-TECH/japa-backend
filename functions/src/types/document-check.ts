import type { Timestamp } from "firebase-admin/firestore";
import type { DocumentRequestCitation } from "./index";
import type { CouldNotCheckCode, DocumentChecks, RawFacts } from "../services/ai/document-check-engine";

// ============================================
// DOCUMENT CHECK RECORD (issue #115)
// ============================================
//
// `documentChecks/{documentId}`: the result of checking ONE uploaded document
// against the checklist item it was uploaded for, and the job record that
// produces it. Backend-only (no firestore.rules match); clients read it through
// the tier-trimmed routes only.
//
// It never decides a Document's status. A check that fails, times out or is
// unavailable leaves the document exactly as uploaded.

/** Job state. `done` and `could_not_check` are final until a retry re-queues it. */
export type DocumentCheckStatus = "queued" | "running" | "done" | "could_not_check";

export interface DocumentCheckRecord {
  /** Same as the doc id. */
  documentId: string;
  applicationId: string;
  /** The application's owner (the applicant). */
  userId: string;
  agencyId: string | null;
  documentRequestId: string;
  /** The checklist item (#114) the upload was made against. */
  checklistItemId: string;
  /** Version of the approved rubric the expectations came from; null if none was found. */
  rubricVersion: number | null;
  /** Model id that read the document; null when no model call was made. */
  model: string | null;
  /** Version of the extraction prompt (ASSESSMENT_PROMPT_VERSION). */
  promptVersion: string;
  /** sha256 of the file bytes; lets an identical re-upload reuse the extraction. */
  fileHash: string | null;
  /** True when the values came from an earlier check of the same file (no model call). */
  reusedFromDocumentId: string | null;
  status: DocumentCheckStatus;
  /** Starts at 1; a retry adds one. */
  attempt: number;
  /** The five check results; set when status is `done`. */
  checks: DocumentChecks | null;
  /** Why no check could run; set when status is `could_not_check`. */
  reason: { code: CouldNotCheckCode; message: string } | null;
  /**
   * The values read, KEPT MINIMAL: type, dates and the holder's name only. No
   * account or card number is ever requested. A sponsor's name is stored as
   * initials. Used to re-decide on reuse without a model call.
   */
  extracted: RawFacts | null;
  /** The rubric's own quote and URL for the item, shown beside every result. */
  citation: DocumentRequestCitation | null;
  createdAt: Timestamp;
  /** Set on creation and on each retry (the order the latest check is chosen by). */
  requestedAt: Timestamp;
  startedAt?: Timestamp;
  finishedAt?: Timestamp;
}
