import type { Timestamp } from "firebase-admin/firestore";
import type { CriterionKind, DecisionStage } from "./rubric";

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
  // The rubric criterion's kind, copied from the rubric (never model text).
  kind: CriterionKind;
  // True when the criterion is a mandatory bar (a rule that applies regardless of documents).
  isMandatoryBar: boolean;
  // The decision stage (validity | suitability | eligibility | credibility),
  // copied from the rubric criterion in code, never from model text (#43). It
  // lets staff tell "not a valid application" from a refusal ground. Absent on
  // documents stored before #43, so readers must tolerate undefined.
  stage: DecisionStage;
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
  kind: CriterionKind;
  isMandatoryBar: boolean;
  // The decision stage (validity | suitability | eligibility | credibility),
  // copied from the rubric criterion in code, never from model text (#43). It
  // lets staff tell "not a valid application" from a refusal ground. Absent on
  // documents stored before #43, so readers must tolerate undefined.
  stage: DecisionStage;
  ruleRef: string | null;
  sourceUrl: string;
  sourceQuote: string;
  detail: string;
  whatWouldHelp: string;
}

/**
 * One finding about the applicant's statement, anchored to a block of it (#36).
 *
 * Everything except `comment`/`detail` and `nodePath` is copied by code from the
 * rubric criterion or the statement record; the model supplies only the
 * explanation and a block number, which code validates before storing a path.
 */
export interface StatementFinding {
  criterionId: string;
  title: string;
  // The model's explanation. `detail` carries the same text so consumers
  // written before `comment` existed keep working.
  comment: string;
  detail: string;
  // ---- copied from the rubric criterion, never model text ----
  kind: CriterionKind;
  stage: DecisionStage;
  ruleRef: string | null;
  sourceQuote: string;
  sourceUrl: string;
  severity: string;
  // The DocumentInstance `version` that was read. Null only when no statement
  // was read (it cannot happen for a finding the model made about a statement).
  statementVersion: number | null;
  // Child indexes from the statement document root: `[blockIndex]` for a
  // top-level block. ABSENT (not null, not []) when the model's block number
  // was missing or out of range: a position is never guessed.
  nodePath?: number[];
}

/** Which statement the findings were read from. */
export interface StatementRef {
  instanceId: string;
  version: number;
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
  statementFindings: StatementFinding[];
  // The statement read at assessment time (null when none). Findings'
  // `nodePath` is only valid against this instance at this version.
  statement: StatementRef | null;
  insufficientInformation: InsufficientItem[];
  suspiciousContent: SuspiciousContentFlag[];
  confidence: "high" | "medium" | "low" | null;
  // The three issues the free tier shows, chosen in code at run time and stored
  // so a read never needs the rubric again. Titles are the rubric's own.
  topIssues: Array<{ criterionId: string; title: string }>;
  // True when a mandatory bar applies to this applicant. Computed in code. The
  // free tier is told this one boolean so a free applicant learns that a rule
  // blocks them (decision on #43); it carries no rule text.
  hasBlockingRule: boolean;
  // Stored, stripped from every client-role response (see tier-serializer).
  internalCall: "would_approve" | "would_refuse" | null;

  models: { extract: string | null; judge: string | null };
  promptVersion: string;
  usage: { extract: AssessmentUsage; judge: AssessmentUsage };
  // Null while the model has no price entry (see services/ai/ai-pricing.ts).
  costUsd: number | null;
}

// ============================================
// PROPOSED ACTIONS — TYPES (issue #44)
// ============================================
//
// `applicationAssessments/{assessmentId}/proposedActions/{actionId}`.
//
// A proposed action is a PROPOSAL. It is derived in code from one assessment
// finding (its `whatWouldHelp`) and the rubric criterion that finding cites.
// Nothing is created for the applicant until a human with access accepts it;
// accepting a blocking, client-owned action creates a real DocumentRequest
// through the existing document-request service. There is no step engine, no
// new applicant-facing surface and no new collection for the result.
//
// Who writes what: the assessment worker writes the proposals (status
// "proposed"); the accept / reject handlers change `status` and the decision
// fields; the document-request hooks move an accepted action on to "satisfied"
// or "withdrawn". Nothing a client sends is stored except an optional reject reason.

/** Who has to do it. */
export const PROPOSED_ACTION_OWNERS = ["client", "agent"] as const;
export type ProposedActionOwner = (typeof PROPOSED_ACTION_OWNERS)[number];

/** A rough size of the job, set in code from the kind of finding. */
export const PROPOSED_ACTION_EFFORTS = ["quick", "moderate", "significant"] as const;
export type ProposedActionEffort = (typeof PROPOSED_ACTION_EFFORTS)[number];

/**
 * Lifecycle:
 *  - proposed:  written by the worker, nothing created for anyone;
 *  - accepted:  a human accepted it (a DocumentRequest exists when it was
 *               blocking and client-owned);
 *  - rejected:  a human declined it;
 *  - satisfied: its DocumentRequest was fulfilled;
 *  - withdrawn: its DocumentRequest was waived or cancelled (no longer asked for).
 */
export const PROPOSED_ACTION_STATUSES = ["proposed", "accepted", "rejected", "satisfied", "withdrawn"] as const;
export type ProposedActionStatus = (typeof PROPOSED_ACTION_STATUSES)[number];

/** Which kind of finding the action came from. Stored for the operator; never served. */
export type ProposedActionOrigin = "refusal_ground" | "credibility_flag" | "insufficient_information";

/** The stored document. */
export interface ProposedAction {
  id: string;
  assessmentId: string;
  // Copied from the assessment, for isolation checks and queries.
  applicationId: string;
  userId: string;
  agencyId: string | null;

  title: string;
  ownerRole: ProposedActionOwner;
  // True when the plan cannot move on without it. Only a blocking, client-owned
  // action becomes a DocumentRequest when accepted.
  blocking: boolean;
  // Resolves to a criterion in the rubric version the assessment used (checked at write time).
  criterionId: string;
  evidenceNeeded: string;
  estEffort: ProposedActionEffort;
  status: ProposedActionStatus;
  origin: ProposedActionOrigin;

  createdAt: Timestamp;
  updatedAt: Timestamp;

  // ---- decision ----
  acceptedBy: string | null;
  acceptedAt: Timestamp | null;
  rejectedBy: string | null;
  rejectedAt: Timestamp | null;
  rejectReason: string | null;
  // The DocumentRequest this action created. Null for any other accept.
  documentRequestId: string | null;
}
