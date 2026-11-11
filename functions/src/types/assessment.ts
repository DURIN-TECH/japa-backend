import type { Timestamp } from "firebase-admin/firestore";

// ============================================
// APPLICATION ASSESSMENT — TYPES (issue #42)
// ============================================
//
// `applicationAssessments/{assessmentId}` is one stored, cited, staged verdict
// for an application against its APPROVED rubric version. It is also the job
// record: one document, one lifecycle (queued -> running -> succeeded | failed).
//
// The id is derived, not random: sha256(applicationId + ":" + inputHash). Two
// POSTs for the same inputs, or two rapid triggers, address the same document,
// so a second create is a no-op and never a second model run.
//
// Who writes what:
//   - the worker writes every field below;
//   - nothing a client sends is stored here (the handler takes the application
//     id from the path and everything else from Firestore).
//
// Who reads what: the tier serializer (services/ai/tier-serializer.ts) is the
// only path to a response body. Free callers get band + top three; full callers
// get this document, minus `internalCall` for client-role callers.
//
// Pure module: types and constant lists only.

/** Readiness band. Computed in code from the stored outcomes, never by the model. */
export const READINESS_BANDS = ["not_ready", "weak", "competitive", "strong"] as const;
export type ReadinessBand = (typeof READINESS_BANDS)[number];

/** Job lifecycle. */
export const ASSESSMENT_STATUSES = ["queued", "running", "succeeded", "failed"] as const;
export type AssessmentStatus = (typeof ASSESSMENT_STATUSES)[number];

/**
 * Why a job failed. Stable codes; the message is a fixed, secret-free line.
 * `timed_out` and the cap codes are checked before a model call, so a job
 * that fails on a cap has not spent past it.
 */
export const ASSESSMENT_ERROR_CODES = [
  "inputs_changed",
  "rubric_changed",
  "timed_out",
  "cost_cap_exceeded",
  "daily_cap_exceeded",
  "settings_unavailable",
  "disabled",
  "provider_error",
  "provider_refused",
  "provider_stopped",
  "invalid_model_output",
  "internal_error",
] as const;
export type AssessmentErrorCode = (typeof ASSESSMENT_ERROR_CODES)[number];

/** What caused the job. */
export const ASSESSMENT_TRIGGERS = ["manual", "status_change", "documents_changed", "rubric_bump"] as const;
export type AssessmentTrigger = (typeof ASSESSMENT_TRIGGERS)[number];

/** Outcome of one stage, as the engine recorded it. */
export interface StageOutcomes {
  // `hit`: a mandatory bar applied and the assessment stopped at stage 1.
  mandatoryBar: "clear" | "hit" | "not_applicable";
  // `fail`: an objective check was evaluated and failed (a refusal ground).
  objective: "clear" | "fail" | "insufficient" | "not_applicable";
  // `concern`: the judgement pass raised a credibility flag.
  judgement: "clear" | "concern" | "not_run";
  // `at_risk` is a credibility concern. It never renders as a refusal.
  credibility: "clear" | "at_risk";
}

/** A criterion the engine could not decide. */
export interface InsufficientItem {
  criterionId: string;
  title: string;
  reason: string;
}

/**
 * A refusal ground. `ruleRef`, `sourceUrl` and `sourceQuote` are copied from
 * the rubric criterion, never from model text. Only objective and mandatory-bar
 * criteria can produce one (a judgement criterion never can).
 */
export interface RefusalGround {
  criterionId: string;
  title: string;
  ruleRef: string | null;
  sourceUrl: string;
  sourceQuote: string;
  detail: string;
  whatWouldHelp: string;
}

/** A credibility flag. Judgement concerns end here, never in refusalGrounds. */
export interface CredibilityFlag {
  criterionId: string;
  title: string;
  ruleRef: string | null;
  sourceUrl: string;
  sourceQuote: string;
  detail: string;
  whatWouldHelp: string;
}

/** A passage that addressed the model (injection). Stored, never shown. */
export interface SuspiciousContentFlag {
  source: "document" | "statement";
  documentId: string | null;
  page: number | null;
}

/** Usage of one stage, as the API reported it. */
export interface AssessmentUsage {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/**
 * `applicationAssessments/{assessmentId}`. Fields follow the approved plan
 * (#42), with the job-record fields the design adds (P in the technical design).
 */
export interface ApplicationAssessment {
  id: string;
  applicationId: string;
  // Copied from the application when the job is created, for isolation checks.
  userId: string;
  agencyId: string | null;
  countryCode: string;
  visaTypeId: string;

  rubricVersion: number;
  inputHash: string;
  // The judgement model when stage 3 ran, else the extraction model, else null.
  model: string | null;
  createdAt: Timestamp;

  // ---- job record ----
  status: AssessmentStatus;
  error: { code: AssessmentErrorCode; message: string } | null;
  attempt: number;
  trigger: AssessmentTrigger;
  requestedBy: string; // uid, or "system"
  startedAt: Timestamp | null;
  finishedAt: Timestamp | null;

  // ---- result (set on success or on a partial result) ----
  stageOutcomes: StageOutcomes;
  score: number | null;
  readiness: ReadinessBand | null;
  refusalGrounds: RefusalGround[];
  credibilityFlags: CredibilityFlag[];
  strengths: Array<{ criterionId: string; title: string; detail: string }>;
  statementFindings: Array<{ criterionId: string; title: string; detail: string }>;
  insufficientInformation: InsufficientItem[];
  suspiciousContent: SuspiciousContentFlag[];
  confidence: "high" | "medium" | "low" | null;
  // The three issues the free tier shows, chosen in code at run time and stored
  // so a read never needs the rubric again. Titles are the rubric's own.
  topIssues: Array<{ criterionId: string; title: string }>;
  // Stored, stripped from every client-role response (see tier-serializer).
  internalCall: "would_approve" | "would_refuse" | null;

  models: { extract: string | null; judge: string | null };
  promptVersion: string;
  usage: { extract: AssessmentUsage; judge: AssessmentUsage };
  // Null while the model has no price entry (see services/ai/ai-pricing.ts).
  costUsd: number | null;
}
