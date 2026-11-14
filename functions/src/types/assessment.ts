import type { Timestamp } from "firebase-admin/firestore";
import type { CountryContextResult } from "../services/outcome-statistics/country-context";
import type { CriterionKind, DecisionStage, RulebookStackLayer } from "./rubric";

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
  // Bulk re-assessment (#37): the application was closed, submitted to the
  // embassy or withdrawn between the rubric approval and the job running.
  "application_closed",
] as const;
export type AssessmentErrorCode = (typeof ASSESSMENT_ERROR_CODES)[number];

/** What caused the job. */
export const ASSESSMENT_TRIGGERS = ["manual", "status_change", "documents_changed", "rubric_bump"] as const;
export type AssessmentTrigger = (typeof ASSESSMENT_TRIGGERS)[number];

/**
 * What changed between an assessment and the one it superseded (issue #37).
 * Built in code from the two rubric versions and the two stored results, never
 * by a model. Shown to the agent only: it is stripped from client-role
 * responses (services/ai/tier-serializer.ts), because it names rule changes.
 */
export interface AssessmentChangeSummary {
  previousAssessmentId: string;
  previousRubricVersion: number;
  rubricVersion: number;
  // The readiness band before and after, and which way it moved. `unknown`
  // when the previous result carried no band.
  readiness: { from: ReadinessBand | null; to: ReadinessBand | null; direction: "down" | "up" | "same" | "unknown" };
  // Criterion ids that differ between the two RUBRIC versions. Null when the
  // previous rubric version could not be read (the summary then says so
  // instead of guessing). `changed` lists the id in the new version.
  criteria: { added: string[]; removed: string[]; changed: string[] } | null;
  // Criterion ids of the stored FINDINGS (refusal grounds, credibility flags,
  // insufficient information): newly raised on this applicant, and no longer
  // raised.
  findings: { raised: string[]; resolved: string[] };
  // A mandatory bar now applies that did not before (code-decided).
  newBlockingRule: boolean;
}

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
  // (#207) Set when the rule was NOT assessed because it could not be told
  // whether it applies to this applicant: "unanswered" (its trigger question
  // has no answer yet) or "no_trigger" (a specialist rule the guidance did not
  // let us tie to a question). What is missing is an intake answer, not a
  // document, so no evidence request or proposed action is made for it, and it
  // is never one of the free tier's top issues.
  notAssessed?: "unanswered" | "no_trigger";
  // (#233) The rulebook layer the rule came from (its rulebook key), set only
  // when the application runs on a stack of more than one layer. Copied from
  // the rubric in code, never from model text.
  layerKey?: string;
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
  // (#233) The rulebook layer the rule came from (its rulebook key), set only
  // when the application runs on a stack of more than one layer. Copied from
  // the rubric in code, never from model text.
  layerKey?: string;
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
  // (#233) The rulebook layer the rule came from (its rulebook key), set only
  // when the application runs on a stack of more than one layer. Copied from
  // the rubric in code, never from model text.
  layerKey?: string;
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
  // (#233) The rulebook layer the rule came from (its rulebook key), set only
  // when the application runs on a stack of more than one layer. Copied from
  // the rubric in code, never from model text.
  layerKey?: string;
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

  // The approved version of the route's rulebook. (#233) On a stack of more
  // than one layer: the country's OWN layer's version (0 when the own layer has
  // none approved), with every layer's version in `layerVersions`.
  rubricVersion: number;
  // (#233) Set only on a stack of more than one layer: rulebook key -> the
  // approved version used (null for a missing layer). Part of the input hash,
  // and compared for "the rules changed", so a new version of ANY layer makes
  // the assessment out of date. Absent for a single-layer route (unchanged).
  layerVersions?: Record<string, number | null>;
  // (#233) Set only on a stack of more than one layer: every layer, with the
  // version used or `missing`, so the application shows which layer had no
  // approved rulebook (never silently ignored).
  rulebookLayers?: RulebookStackLayer[];
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
  strengths: Array<{ criterionId: string; title: string; detail: string; layerKey?: string }>;
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
  // Published outcome statistics for the applicant's passport country and the
  // route's published category (#116). Present ONLY when a figure was found
  // (status "available"); absent otherwise, and absent when building it
  // failed. Computed AFTER and OUTSIDE scoring: nothing above this line reads
  // it, it is not part of the input hash, and it is never sent to a model.
  // Full tier and staff only: the free whitelist does not include it.
  countryContext?: AvailableCountryContext;
  // Stored, stripped from every client-role response (see tier-serializer).
  internalCall: "would_approve" | "would_refuse" | null;

  models: { extract: string | null; judge: string | null };
  promptVersion: string;

  // ---- bulk re-assessment (issue #37). All optional: documents written
  // before #37, and every interactive assessment, simply do not carry them ----
  // True when the job belongs to the Batch API path. The interactive worker
  // (processAssessmentJob) ignores such a job; the bulk sweep owns it.
  viaBatch?: boolean;
  // The bulk run (the rubric approval's audit id) that created the job.
  bulkRunId?: string | null;
  // The provider batch the job currently waits on (an `assessmentBatches` id),
  // or null when it is waiting to be planned into the next one.
  batchId?: string | null;
  // Which stage that batch holds for this job.
  batchPhase?: "extraction" | "judgement" | null;
  // How many batch rounds have failed for this job. At the cap it is failed.
  batchAttempts?: number;
  // Why this assessment exists when it was not asked for: the approved rules
  // moved. `rules_updated` is the same word the stale state uses.
  updateReason?: "rules_updated" | null;
  // The assessment this one replaced, and (on the replaced one) the reverse.
  // The replaced assessment is RETAINED, never overwritten.
  supersedesAssessmentId?: string | null;
  supersededByAssessmentId?: string | null;
  supersededAt?: Timestamp | null;
  // What changed against the replaced assessment. Set when the job succeeds.
  changeSummary?: AssessmentChangeSummary | null;
  // Policy: an agent (or the agency owner, or an admin) must look at this one
  // because the result got worse for the applicant. The APPLICANT is never
  // notified of it automatically.
  reviewRequired?: boolean;
  // When the reviewer was notified. Null until then (and for ever when no
  // review is required).
  reviewNotifiedAt?: Timestamp | null;
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
/** The "available" arm of the country-context result: what is stored and served. */
export type AvailableCountryContext = Extract<CountryContextResult, { status: "available" }>;
