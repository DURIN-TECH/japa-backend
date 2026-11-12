import type { Timestamp } from "firebase-admin/firestore";
import type { ExtractedValue } from "../services/ai/assessment-engine";
import type { AssessmentUsage } from "./assessment";

// ============================================
// BULK RE-ASSESSMENT — STORED RECORDS (issue #37)
// ============================================
//
// Three backend-only collections (no firestore.rules match, so clients are
// denied; they read results only through the /ai routes):
//
//   bulkReassessments/{runId}      one run per rubric approval. The id IS the
//                                  approval's audit id (`rubricReviewHistory`),
//                                  so a re-delivered trigger addresses the same
//                                  document and starts nothing twice.
//   assessmentBatches/{batchId}    one provider (Anthropic) batch: which stage
//                                  it holds, how many requests, how it ended.
//   documentExtractions/{key}      one stage 2 result for one document. A rubric
//                                  bump changes no document, so a re-assessment
//                                  reads these instead of paying to read the
//                                  document again; the batch then holds only the
//                                  stage 3 (judgement) requests.
//
// Pure module: types and constants only.

/** Lifecycle of a run. */
export const BULK_RUN_STATUSES = ["enqueuing", "running", "completed", "cancelled"] as const;
export type BulkRunStatus = (typeof BULK_RUN_STATUSES)[number];

/**
 * `bulkReassessments/{auditId}`: one rubric approval and what was done about it.
 */
export interface BulkReassessmentRun {
  // = the approval's audit id.
  id: string;
  routeKey: string;
  countryCode: string;
  visaTypeId: string;
  // The version now serving, which every job of this run assesses against.
  rubricVersion: number;
  previousApprovedVersion: number | null;
  approvedBy: string;
  status: BulkRunStatus;
  createdAt: Timestamp;
  updatedAt: Timestamp;

  // ---- enqueue progress (resumable) ----
  // Last `applicationId` the candidate scan has passed, or null at the start.
  // The scan is resumed from here by the next sweep when a pass ran out of time.
  enqueueCursor: string | null;
  // The candidate scan reached the end of the route's assessments.
  enqueueDone: boolean;
  // Counters, written as the scan goes (never recomputed from a guess).
  enqueued: number;
  alreadyCurrent: number;
  excluded: number;

  // ---- spend cap ----
  // How many jobs were left waiting at the last sweep because the day's cap was
  // used up, and when that was. A deferral is recorded here, never silent.
  deferredAtLastSweep: number;
  lastDeferredAt: Timestamp | null;
  // "requests": the price table is empty, so the cap counts provider requests.
  // "usd": prices are confirmed and a dollar cap is set.
  capMode: "requests" | "usd" | null;

  // ---- result (set when the run completes) ----
  succeeded: number | null;
  failed: number | null;
  completedAt: Timestamp | null;
}

/** Lifecycle of one provider batch. */
export const ASSESSMENT_BATCH_STATUSES = [
  // The doc exists and the members are claimed; the provider has not accepted it.
  "pending_submit",
  // The provider accepted it and is working.
  "submitted",
  // The provider says it ended; results are not all written yet.
  "ended",
  // Every result was handled.
  "processed",
  // Never reached the provider (submit failed), or was abandoned as stale.
  "failed",
] as const;
export type AssessmentBatchStatus = (typeof ASSESSMENT_BATCH_STATUSES)[number];

/** `assessmentBatches/{batchId}`. */
export interface AssessmentBatch {
  id: string;
  // Which stage the requests are. One kind per batch, so `custom_id` can be the
  // bare 64-character hash (the provider allows 64 characters at most).
  kind: "extraction" | "judgement";
  routeKey: string;
  rubricVersion: number;
  bulkRunId: string;
  status: AssessmentBatchStatus;
  // The provider's id, once it accepted the batch.
  providerBatchId: string | null;
  requestCount: number;
  // Filled in when the results are processed.
  succeeded: number;
  failed: number;
  submittedAt: Timestamp | null;
  endedAt: Timestamp | null;
  createdAt: Timestamp;
  // Reason a batch is `failed`, as a fixed, secret-free line.
  failure: string | null;
}

/** `documentExtractions/{key}` status. */
export type DocumentExtractionStatus = "pending" | "ok" | "failed";

/**
 * One stage 2 result. The key is a hash of the document id, its `updatedAt`, the
 * fields asked for, the prompt version and the model, so a changed file, a changed
 * rubric field list or a new prompt each get a new entry and nothing stale is read.
 *
 * PERSONAL DATA: `values` is read from an applicant's documents. Backend-only;
 * `applicationId` is stored so an erasure can find it.
 */
export interface DocumentExtractionRecord {
  key: string;
  applicationId: string;
  documentId: string;
  status: DocumentExtractionStatus;
  // The batch that holds the request while `pending`.
  batchId: string | null;
  // The fields the request asked for (stored so a result can be parsed without
  // the rubric it was asked under still being the approved one).
  fields: string[];
  // Failed rounds so far; at the cap the document counts as unread for good.
  attempts: number;
  // The run that paid for it (used to attribute spend to that run only).
  bulkRunId: string | null;
  mediaType: string;
  readable: boolean;
  values: ExtractedValue[];
  suspicious: boolean;
  // A fixed reason when the document was unreadable or the answer failed.
  failure: string | null;
  usage: AssessmentUsage | null;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}
