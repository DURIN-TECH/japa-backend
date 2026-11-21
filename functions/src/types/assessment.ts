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
  // Kept for failures stored before #310 and for the bulk path (#37). The
  // single-application review no longer writes it: see the two codes below.
  "cost_cap_exceeded",
  // The PLATFORM-WIDE daily limit is used up. True "try again tomorrow".
  "daily_cap_exceeded",
  // (#310) The application itself is too big for ONE review. Neither is a
  // pause and neither is fixed by waiting: the same inputs fail the same way.
  //   too_many_documents  more documents than the request cap leaves room for
  //                       (one extraction call each, after the judgement calls);
  //   review_too_large    the review would pass a per-review cap for another
  //                       reason (the rules alone need every request, the
  //                       TEXT of the requests passes the input-size cap, or
  //                       all the files together pass the attached-bytes cap).
  "too_many_documents",
  "review_too_large",
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
  // (#234) `missing_fact`: a rule decided from what the applicant holds needs a fact they have not stated.
  // (#308) `not_in_documents`: an objective rule whose checked field is in no
  // uploaded document, and for which the rulebook names NO document item
  // (`evidenceItems[].criterionIds`), so no upload could settle it (an
  // exclusion order, a paid fee, biometrics). Stored for staff. Like
  // `no_trigger` it is never a refusal ground or a top issue, makes no proposed
  // action, and does not lower the band or the confidence. Clients must not
  // list it to the applicant as something to act on.
  // NOTE: the app hides any marker it does not know. A NEW marker the
  // applicant can act on therefore needs an app change before it is served.
  notAssessed?: "unanswered" | "no_trigger" | "missing_fact" | "not_in_documents";
  // (#233) The rulebook layer the rule came from (its rulebook key), set only
  // when the application runs on a stack of more than one layer. Copied from
  // the rubric in code, never from model text.
  layerKey?: string;
  // (#308) Set only on an item that is about an UPLOAD, not a rule: a document
  // that could not be read (unreadable, failed or flagged). `criterionId` is
  // then `document:<documentId>` (no rule), `title` is the upload's label and
  // `reason` is a fixed sentence written for the applicant. It never carries
  // `notAssessed`: the applicant can act on it (upload a clearer copy).
  documentId?: string;
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
  // (#384) `narrative`: a string of the model-written narrative that addressed
  // a reader (it was dropped by code, never stored in `narrative`).
  source: "document" | "statement" | "narrative";
  documentId: string | null;
  page: number | null;
}

/**
 * (#384) The caseworker-style reading of the applicant's own application: what
 * they told us, what their documents show, where the two conflict or fall
 * short, how convincing the whole is, a conclusion that agrees with the band,
 * and what would change it.
 *
 * Written by ONE model call after the findings are assembled
 * (`buildNarrativeRequest` in services/ai/assessment-engine.ts) and then
 * checked string by string in code (`parseNarrative`): banned wording,
 * injection, every figure and every quotation must be grounded in what was
 * sent. A string that fails is dropped; when the conclusion is dropped or no
 * paragraph is left the whole narrative is null. Null also when the call was
 * skipped (a mandatory bar, nothing to weigh, a cap) or failed, and on every
 * assessment written by the bulk path (#386) or before #384.
 */
export interface AssessmentNarrative {
  // 1 to 6 short paragraphs, each at most 700 characters, in order.
  paragraphs: string[];
  // The readiness conclusion in an officer's reasoning voice (at most 400
  // characters). Its opening agrees with the band (checked in code).
  conclusion: string;
  // 0 to 5 things that would change the reading, each at most 200 characters.
  nextSteps: string[];
}

/**
 * (#384) The mandatory bar that stops the review, for the full tier whatever
 * the working entitlement: blocking rules are never paywalled. Copied in code
 * from the FIRST mandatory-bar refusal ground (rubric text, never model text).
 * The free tier never gets it (only `hasBlockingRule`, as decided on #43).
 */
export interface BlockingRule {
  criterionId: string;
  title: string;
  ruleRef: string | null;
  sourceQuote: string;
  sourceUrl: string;
}

// ============================================
// (#418) What the review read in each upload
// ============================================

/**
 * (#418) The kinds of document the extraction call may say an upload is,
 * read by the model from the document's CONTENT (never from its label or
 * file name). A fixed list, so the schema can carry it as an `enum` and the
 * parser can reject anything else. `other` is the catch-all. Kept generic: no
 * kind names a country, a route or a nationality.
 *
 * Used by: the extraction schema and parser (assessment-engine.ts), the
 * document list the judgement and narrative calls are given, the narrative's
 * "a read document is never said to be missing" check, and the stored
 * `documentsRead` record below.
 */
export const DOCUMENT_KINDS = [
  "passport", //               a passport or travel document
  "identity_card", //          a national identity card or residence card
  "bank_statement", //         a bank or account statement
  "payslip", //                a payslip or salary slip
  "employment_letter", //      a letter from an employer, or an employment contract
  "tenancy_agreement", //      a tenancy, lease or rental agreement
  "property_document", //      a title deed or other proof of owning property
  "sponsor_letter", //         a letter from someone paying for or supporting the applicant
  "invitation_letter", //      a letter inviting the applicant
  "study_acceptance", //       an offer, acceptance or confirmation of a place on a course
  "academic_record", //        a transcript, certificate or award letter
  "tax_document", //           a tax return, tax certificate or tax clearance
  "business_document", //      a business registration or company document
  "relationship_document", //  a birth, marriage or other civil-status certificate
  "travel_booking", //         a flight, hotel or travel booking
  "insurance", //              an insurance policy or certificate
  "utility_bill", //           a utility bill
  "photo", //                  a photograph of the applicant
  "other", //                  anything else
] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];

/**
 * (#418) Why an upload was NOT read, in plain fixed words. Code-written,
 * never model text and never internal wording ("the answer broke the
 * contract"): the judgement and narrative calls are given these, and the
 * narrative may repeat them to the applicant.
 */
export const DOCUMENT_UNREAD_REASONS = {
  // The file could not be downloaded, the model said it could not read it,
  // the call failed or the answer broke the output contract.
  unreadable: "could not be opened or read",
  // An encrypted PDF (never sent to a model).
  passwordProtected: "password protected",
  // Not a PDF, JPEG or PNG by its bytes (never sent to a model).
  unsupportedType: "file type not supported",
  // Over the per-file size limit (never sent to a model).
  tooLarge: "too large",
  // Flagged suspicious: it addressed the reader instead of stating facts, so
  // nothing in it is used.
  unusable: "could not be used",
} as const;
export type DocumentUnreadReason = (typeof DOCUMENT_UNREAD_REASONS)[keyof typeof DOCUMENT_UNREAD_REASONS];

/**
 * (#418) One upload as the review saw it, stored on the assessment for STAFF
 * (`ApplicationAssessment.documentsRead`). Deliberately holds NO read value
 * (no balance, no salary, no name): only whether it was read, what kind it
 * is, why not when it was not, and how many values were kept.
 */
export interface DocumentReadRecord {
  documentId: string;
  // The kind the model read from the content; null when unread (or not given).
  documentKind: DocumentKind | null;
  // True only when the upload was read cleanly (readable, not failed, not suspicious).
  readable: boolean;
  // The fixed reason when not read; null when read.
  reason: DocumentUnreadReason | null;
  // How many read values were kept for this upload (after the per-document cap).
  valueCount: number;
  // (#444) The rulebook evidence item KEYS the review read the upload as ([]
  // when the rulebook has no date-relative check, or the upload was not read).
  // Optional: records stored before #444 do not carry it.
  evidenceItems?: string[];
  // (#444) The upload's own date (the latest statement period end or document
  // date read on it, YYYY-MM-DD), null when none was read. A date, not an
  // amount or a name. Optional for records stored before #444.
  documentDate?: string | null;
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
  // (#384) The caseworker-style reading (see AssessmentNarrative). Null when
  // it was not written or did not pass the code checks. Documents stored
  // before #384 have no key at all; the serializer reads that as null.
  narrative: AssessmentNarrative | null;
  // (#384) The mandatory bar that applies, copied from the first mandatory-bar
  // refusal ground (never model text); null when none applies. Documents
  // stored before #384 have no key; the serializer derives it from
  // `refusalGrounds` at read time.
  blockingRule: BlockingRule | null;
  // Stored, stripped from every client-role response (see tier-serializer).
  // (#308) Also null on a FINISHED assessment when nothing refuses and the
  // objective checks could not be made (the rulebook names no document for
  // them, an upload is unread, or a field could not be read): no call is made.
  internalCall: "would_approve" | "would_refuse" | null;
  // (#418) Staff only: one entry per upload the interactive review looked at
  // (see DocumentReadRecord). No read values are stored here. Stripped from
  // every client-role response (tier-serializer.ts); absent on the bar and
  // nothing-to-read paths, on the bulk path and on documents stored before #418.
  documentsRead?: DocumentReadRecord[];
  // (#444) Staff only: the application date (YYYY-MM-DD) the date-relative
  // checks were measured against (`barDateOf`: `submittedAt`, else the review
  // date). Stripped from every client-role response like `documentsRead`;
  // absent where `documentsRead` is.
  measuredOn?: string;

  // (#384) `narrative`: the model that wrote the narrative, when the call was
  // made (absent on documents without a narrative call).
  models: { extract: string | null; judge: string | null; narrative?: string | null };
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
  // (#384) `narrative`: usage of the one narrative call, when it was made.
  // Absent on the bulk path and on documents written before #384.
  usage: { extract: AssessmentUsage; judge: AssessmentUsage; narrative?: AssessmentUsage };
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
  // (#308) The one exception: an action for an upload that could not be read
  // carries `document:<documentId>` here (no rule is involved).
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
