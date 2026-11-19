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

/**
 * Lifecycle of a run. (#233 P4b) `awaiting_confirmation`: a SHARED layer's
 * fan-out has its estimate and waits for an admin to confirm it. Nothing is
 * queued, and nothing can be spent, in that state (the sweep never reads it).
 */
export const BULK_RUN_STATUSES = ["enqueuing", "running", "awaiting_confirmation", "completed", "cancelled"] as const;
export type BulkRunStatus = (typeof BULK_RUN_STATUSES)[number];

/**
 * `bulkReassessments/{auditId}`: one rubric approval and what was done about it.
 */
export interface BulkReassessmentRun {
  // = the approval's audit id.
  id: string;
  routeKey: string;
  // The country's route of a run for a country's OWN layer. (#233 P4b) Absent
  // on a SHARED layer's fan-out run (`fanOut` set): its applications are on
  // many member routes, listed in `fanOut.estimate.memberRoutes`.
  countryCode?: string;
  visaTypeId?: string;
  // The version now serving, which every job of this run assesses against.
  // (#233 P4b) On a fan-out run: the SHARED layer's approved version (each job
  // records its application's own layer version and every layer's version).
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

  // (#233 P4b) Present ONLY on the run for a SHARED layer's approval.
  fanOut?: SharedLayerFanOut;
}

// ============================================
// (#233 P4b) A shared layer's fan-out: estimate, confirmation, then the bulk path
// ============================================
//
// When a shared (bloc / treaty) layer publishes a new version, the open
// applications whose stack includes it are re-assessed through THIS bulk path,
// within its spend caps, but never before an admin confirms the estimate:
//
//   1. estimating               the candidates are found (open, with a succeeded
//                               assessment, not already on this version) and
//                               stored at `bulkReassessments/{runId}/candidates/{appId}`,
//                               each with its upper bound of requests. No job, no spend.
//   2. awaiting_confirmation    the run status says so; the estimate is stored.
//   3. confirmed                an admin confirmed THIS estimate id (statement
//                               accepted); the candidates are enqueued as ordinary
//                               batch jobs. Enqueueing stops before the running
//                               bound would pass the confirmed number; the rest
//                               waits for a new confirmation (the old one is voided).
//
// One run per approval event (the run id is the audit id), and the jobs' ids
// are deterministic, so a re-delivered event or a repeated confirm does
// nothing twice. No application, applicant or agency is named in what the
// admin is shown: counts per member route only.

/** What the admin confirms. */
export interface FanOutEstimate {
  // Sent back on confirm; a different id is refused (the estimate changed).
  estimateId: string;
  applications: number;
  // Upper bound of provider requests: one judgement per application plus one
  // extraction per stored document (stored extractions are reused, so usually far fewer).
  requestsAtMost: number;
  // Applications per member route (country route through which they applied).
  memberRoutes: { countryCode: string; visaTypeId: string; applications: number }[];
  // The estimate in plain words (what the portal shows).
  plain: string;
  computedAt: Timestamp;
}

/** One confirmation of an estimate. */
export interface FanOutConfirmation {
  estimateId: string;
  by: string;
  at: Timestamp;
  // The number confirmed: enqueueing never passes it.
  maxRequests: number;
  statementAccepted: true;
}

/** `bulkReassessments/{runId}.fanOut`. */
export interface SharedLayerFanOut {
  layerKey: string;
  layerVersion: number;
  phase: "estimating" | "awaiting_confirmation" | "confirmed";
  // Running tallies of the candidate scan (resumable: `scanCursor` is the last application id passed).
  scanCursor: string | null;
  candidates: number;
  requestsAtMost: number;
  estimate: FanOutEstimate | null;
  confirmation: FanOutConfirmation | null;
  voidedConfirmations: FanOutConfirmation[];
  // Requests counted against the confirmation so far (the bound of each enqueued job).
  requestsEnqueued: number;
}

/** `bulkReassessments/{runId}/candidates/{applicationId}`: one application of a fan-out. Backend-only. */
export interface FanOutCandidate {
  applicationId: string;
  countryCode: string;
  visaTypeId: string;
  // One judgement plus one extraction per stored document (an upper bound).
  requestsAtMost: number;
  // Set when this candidate's job was enqueued (or found current / excluded).
  handled: boolean;
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
