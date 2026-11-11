import { Timestamp, type Transaction } from "firebase-admin/firestore";
import { collectionGroups, collections, db, subcollections } from "../utils/firebase";
// The scrapers module is reached through its public entry point only (the
// ESLint boundary rule of issue #91 refuses deep imports from here).
import { SnapshotQuoteIndex, guidanceSnapshotStore, rubricStore, validateVisaRubric } from "../scrapers";
import type { GuidanceSnapshotContent } from "../scrapers/types";
import {
  INTENT_POLARITIES,
  RUBRIC_REVIEW_FIELDS,
  RUBRIC_REVIEW_STATUSES,
  type AssessmentCriterion,
  type IntentPolarity,
  type RubricCitation,
  type RubricFlag,
  type RubricHead,
  type RubricReviewStatus,
  type VisaRubric,
} from "../types/rubric";
import { diffRubricVersions, type ChangedCriterion, type IntentPolarityDiff } from "./rubric-diff";

// ============================================
// RUBRIC REVIEW — ADMIN SERVICE (issue #125)
// ============================================
//
// The human gate between rubric extraction (#40, which only ever writes
// `pending_review`) and everything that scores an application by a rubric
// (#42 and friends, which only ever read an APPROVED version through
// `rubricStore.getApprovedRubric`). Three operations, all admin-only (the
// routes gate them; see routes/rubric-review.routes.ts):
//
//   listVersions  the review queue, by review status
//   getVersion    one version + diff against the serving version + per-
//                 criterion stale-citation check + what blocks approval
//   decide        approve or reject a WHOLE version (there is no partial
//                 approval and no in-place edit of a criterion)
//
// ---- The rules `decide` enforces ----
//
// REJECT: needs a reason (same minimum length as the visa review form). The
// version becomes `rejected`; the head is NOT touched, so whatever was
// approved before keeps serving. A reject can never leave a route with less
// than it had.
//
// APPROVE, refused outright (nothing the reviewer can tick away):
//  - the version is not the route's NEWEST one (`NOT_LATEST_VERSION`). A
//    newer extraction exists because the sources moved on (or it was forced);
//    approving the older reading would serve rules read from an out-of-date
//    snapshot, and could put an older version over a newer approval. Only the
//    newest version of a route can be approved, so `approvedVersion` only
//    ever goes up. An older pending version can still be rejected.
//  - any criterion's quote is no longer in the CURRENT stored text of its
//    source (`STALE_CITATION`), or that cannot be checked right now
//    (`CITATION_UNVERIFIABLE`: source or snapshot unreadable; fails closed).
//    The source has moved on: re-extract instead.
//  - the structural validator finds an error in the rubric as it would be
//    approved (`RUBRIC_INVALID`).
//
// APPROVE, needs the reviewer's explicit acknowledgement:
//  - every flag on the version must be named in `acknowledgedFlags`, by its
//    key `code:target`, unless this file knows its code to be harmless.
//    Missing one -> `FLAGS_NOT_ACKNOWLEDGED`, nothing written. Two kinds:
//      * "must_acknowledge": something specific to look at (passages that
//        read as instructions to a reader model, a quote that starts
//        mid-sentence, a country code whose name is not how the source names
//        the group, conflicting polarity passages, criteria about intent left
//        with no polarity, an empty rubric, and ANY code this file has never
//        heard of). The per-criterion ones carry the criterion id as their
//        target, so each criterion is acknowledged by name.
//      * "standing_notice": a limit of extraction that holds for the whole
//        version (codes were proposed by the model, intake wording is the
//        model's, the source was read in several excerpts, a page ends
//        mid-sentence). One per version, acknowledged once.
//    Who acknowledged what is recorded in the audit entry.
//
// APPROVE, the polarity: `intentPolarity` is the ADMIN'S DECISION and must be
// in the request, always. It is never copied from the extractor's proposal:
// the admin may send the same value (accept) or another (override), and the
// audit entry records which.
//
// ---- Concurrency ----
//
// One Firestore transaction reads the version, the head, the version being
// superseded and the guidance sources, checks everything, and writes the
// version's review fields, the superseded version's `supersededAt`, the
// head's `approvedVersion` and the audit entry together. `revision` is the
// optimistic token: the request must carry the revision the reviewer saw. Of
// two concurrent decisions on one version exactly one commits; the other
// re-reads inside its retried transaction, finds the version decided and
// gets 409 `ALREADY_DECIDED` (or `REVISION_MISMATCH`), having written nothing.
//
// ---- Immutability ----
//
// A version's content never changes. Every write to a version doc goes
// through `reviewFieldsUpdate`, which refuses any key outside
// `RUBRIC_REVIEW_FIELDS`, and is an `update`, never a `set`.
//
// ---- What a response may contain ----
//
// Criterion quotes: yes (a reviewer needs them), each with a BOUNDED window
// of the source around it (`quoteContext`: at most QUOTE_CONTEXT_CHARS on
// either side, never beyond the quote's own line or page), because a quote
// that begins after a negation cannot be caught in code and must be read in
// context. The stored snapshot text as a whole, its Storage path, or any URL
// to it: never. Nothing read from a snapshot is logged.
//
// ---- Seam for re-assessment (#37) ----
//
// Nothing is re-assessed here. After an approval COMMITS, every listener
// registered with `onApproved` is called with a `RubricApprovedEvent`
// (awaited, errors logged and swallowed: a listener can never undo or fail an
// approval). The durable form of the same event is the audit entry in
// `rubricReviewHistory` (action "approve"), which a Firestore trigger can
// watch instead.
//
// Generic: a route is DATA (`countryCode` + `visaTypeId`). Nothing here names
// a country, a route, a publisher or a nationality.

// ============================================
// Constants
// ============================================

/**
 * Shortest reject reason accepted, in characters after trimming. Mirrors the
 * visa review form (`rejectVisaSchema` in the portal: min 10).
 */
export const RUBRIC_REJECT_REASON_MIN_LENGTH = 10;
/** Longest reason / note stored. */
export const RUBRIC_REVIEW_REASON_MAX_LENGTH = 2000;

/** List page sizes (GET /admin/rubrics). */
export const RUBRIC_LIST_DEFAULT_LIMIT = 50;
export const RUBRIC_LIST_MAX_LIMIT = 100;

/** Most flags a request may acknowledge (one per flagged criterion at most). */
const MAX_ACKNOWLEDGED_FLAGS = 500;

/**
 * Most source text returned on EITHER side of a quote as its context. The
 * window also stops at the end of the quote's line (web page) or page (PDF).
 */
export const QUOTE_CONTEXT_CHARS = 300;

/** Validator flag raised when criteria concern intent but no polarity scores them. */
const INTENT_FLAG_CODE = "intent_criteria_without_polarity";
/** Extraction flag raised when the source held passages addressed to a reader model. */
const SUSPICIOUS_FLAG_CODE = "suspicious_passages";

/**
 * Flag codes that do NOT need an acknowledgement before approval. Everything
 * else does, including a code added later that this file has never heard of
 * (fail closed):
 *  - intake_answer_type_unknown: a rubric may be ahead of a client; clients
 *    degrade safely on an unknown answer type (#40 validator).
 */
const NON_BLOCKING_FLAG_CODES: ReadonlySet<string> = new Set(["intake_answer_type_unknown"]);

/**
 * Flag codes that are STANDING NOTICES: limits of extraction that hold for
 * the version as a whole rather than one thing to fix. They are returned to
 * the reviewer and must be acknowledged, once per version (their target is
 * the rubric, so there is one key per code):
 *  - nationality_codes_model_proposed: country codes are the model's proposal;
 *  - intake_wording_uncited: intake labels and options are the model's wording;
 *  - multiple_chunks: the source was read in several excerpts;
 *  - page_ends_mid_sentence: a rule crossing a page break may be cut short.
 */
const STANDING_NOTICE_FLAG_CODES: ReadonlySet<string> = new Set([
  "nationality_codes_model_proposed",
  "intake_wording_uncited",
  "multiple_chunks",
  "page_ends_mid_sentence",
]);

/** `{countryCode}_{visaTypeId}__v{version}`: the id of one rubric version in the API. */
// The country code is two UPPER-CASE letters, as `rubricRouteKey` requires.
const VERSION_ID_RE = /^([A-Z]{2}_[A-Za-z0-9][A-Za-z0-9_-]*)__v([1-9]\d{0,8})$/;

// ============================================
// Errors
// ============================================

/** Machine-readable outcome codes of the review API (the `error` of a response). */
export type RubricReviewErrorCode =
  | "VALIDATION_ERROR" // 400: the request itself is wrong
  | "NOT_FOUND" // 404: no such version
  | "ALREADY_DECIDED" // 409: the version is not pending any more
  | "REVISION_MISMATCH" // 409: the reviewer saw an older revision
  | "NOT_LATEST_VERSION" // 409: a newer version of the route exists
  | "STALE_CITATION" // 409: a quote is gone from the current source text
  | "CITATION_UNVERIFIABLE" // 409: a quote could not be checked (fails closed)
  | "SOURCE_CHANGED" // 409: a source moved between the check and the write
  | "RUBRIC_INVALID" // 409: the structural validator refuses the rubric
  | "FLAGS_NOT_ACKNOWLEDGED"; // 409: a blocking flag was not acknowledged

/** A refusal with its HTTP status. The controller sends it as it is. */
export class RubricReviewError extends Error {
  constructor(
    readonly code: RubricReviewErrorCode,
    message: string,
    readonly httpStatus: number
  ) {
    super(message);
    this.name = "RubricReviewError";
  }
}

/** 400 with the standard validation code. */
const invalid = (message: string) => new RubricReviewError("VALIDATION_ERROR", message, 400);
/** 409 with one of the conflict codes. */
const conflict = (code: RubricReviewErrorCode, message: string) => new RubricReviewError(code, message, 409);
/** 404 for a version that does not exist (or an id that cannot name one). */
const notFound = () => new RubricReviewError("NOT_FOUND", "Rubric version not found", 404);

// ============================================
// Ids
// ============================================

/** API id of a rubric version. */
export function rubricVersionId(routeKey: string, version: number): string {
  return `${routeKey}__v${version}`;
}

/**
 * Split an API id into its route key and version, or null when the text is
 * not such an id. The pattern is anchored and its character classes hold no
 * `/`, so a parsed route key can never steer a document path elsewhere.
 */
export function parseRubricVersionId(id: unknown): { routeKey: string; version: number } | null {
  if (typeof id !== "string") return null;
  const m = VERSION_ID_RE.exec(id);
  return m ? { routeKey: m[1], version: Number(m[2]) } : null;
}

// ============================================
// Flags
// ============================================

/** A flag as the API returns it: the stored flag plus its key and weight. */
export interface ReviewFlag {
  // `code:target`: what a request puts in `acknowledgedFlags`.
  key: string;
  code: string;
  target: string;
  message: string;
  // What it asks of the reviewer (see the file header):
  //  - must_acknowledge: a specific thing to check before approving;
  //  - standing_notice:  a limit of this extraction, acknowledged once;
  //  - info:             shown only.
  category: "must_acknowledge" | "standing_notice" | "info";
  // True when approval needs this flag acknowledged (every category but info).
  blocking: boolean;
}

/** The category of a flag code. An unknown code must be acknowledged (fail closed). */
function flagCategory(code: string): ReviewFlag["category"] {
  if (NON_BLOCKING_FLAG_CODES.has(code)) return "info";
  return STANDING_NOTICE_FLAG_CODES.has(code) ? "standing_notice" : "must_acknowledge";
}

/** Key of a flag in `acknowledgedFlags`. */
export const flagKey = (flag: Pick<RubricFlag, "code" | "target">): string => `${flag.code}:${flag.target}`;

/**
 * Every flag on a version as it stands for a given polarity decision:
 *  - the flags stored at extraction, EXCEPT the intent flag, which was
 *    computed from the extractor's proposal and is recomputed here from the
 *    decision (a decided polarity resolves it; deciding `not_assessed` while
 *    criteria concern intent raises it);
 *  - the structural validator's flags for the rubric with that decision;
 *  - a suspicious-passages flag whenever the version stores such passages,
 *    whether or not extraction recorded the flag.
 * De-duplicated by key, stored order first.
 *
 * @param decision the admin's polarity, or null before a decision (the
 *   validator then falls back to the proposal, as it did at extraction).
 */
export function reviewFlagsFor(rubric: VisaRubric, decision: IntentPolarity | null): ReviewFlag[] {
  const fresh = validateVisaRubric({ ...rubric, intentPolarity: decision }).flags;
  const all: RubricFlag[] = [...(rubric.flags ?? []).filter((f) => f.code !== INTENT_FLAG_CODE), ...fresh];
  const passages = rubric.suspiciousPassages?.length ?? 0;
  if (passages > 0) {
    all.push({
      code: SUSPICIOUS_FLAG_CODE,
      message: `${passages} passage(s) of the source read as instructions to a reader model. Read them before approving.`,
      target: "rubric",
    });
  }
  const seen = new Set<string>();
  const out: ReviewFlag[] = [];
  for (const f of all) {
    const key = flagKey(f);
    if (seen.has(key)) continue;
    seen.add(key);
    const category = flagCategory(f.code);
    out.push({ key, code: f.code, target: f.target, message: f.message, category, blocking: category !== "info" });
  }
  return out;
}

// ============================================
// Decision input
// ============================================

/** A parsed PATCH /admin/rubrics/:id/review body. */
export type RubricDecisionInput =
  | {
      action: "approve";
      // The revision of the version the reviewer looked at.
      revision: number;
      // The admin's polarity decision. Always explicit.
      intentPolarity: IntentPolarity;
      // Keys (`code:target`) of the blocking flags the reviewer has read.
      acknowledgedFlags: string[];
      // Optional note, kept in the audit entry only.
      reason: string | null;
    }
  | { action: "reject"; revision: number; reason: string };

/** Body keys each action accepts. Anything else is refused, not ignored. */
const APPROVE_KEYS = ["action", "revision", "intentPolarity", "acknowledgedFlags", "reason"];
const REJECT_KEYS = ["action", "revision", "reason"];

/**
 * Validate a decision body. Strict on purpose: an unknown key is an error, so
 * a client that tries to approve "these criteria only" or to edit a field is
 * told so instead of having the extra keys silently dropped.
 *
 * @throws RubricReviewError (400 VALIDATION_ERROR)
 */
export function parseRubricDecision(body: unknown): RubricDecisionInput {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw invalid("the request body must be a JSON object");
  const b = body as Record<string, unknown>;
  if (b.action !== "approve" && b.action !== "reject") throw invalid("action must be 'approve' or 'reject'");
  const allowed = b.action === "approve" ? APPROVE_KEYS : REJECT_KEYS;
  const unknown = Object.keys(b).filter((k) => !allowed.includes(k));
  if (unknown.length > 0) {
    throw invalid(`unknown field(s) for ${b.action}: ${unknown.join(", ")}. A rubric version is approved or rejected whole.`);
  }
  if (typeof b.revision !== "number" || !Number.isInteger(b.revision) || b.revision < 0) {
    throw invalid("revision is required: the revision of the version you reviewed (a non-negative integer)");
  }
  // The reason: required for a reject, an optional note for an approve.
  let reason: string | null = null;
  if (b.reason !== undefined && b.reason !== null) {
    if (typeof b.reason !== "string") throw invalid("reason must be a string");
    reason = b.reason.trim();
    if (reason.length > RUBRIC_REVIEW_REASON_MAX_LENGTH) throw invalid(`reason must be at most ${RUBRIC_REVIEW_REASON_MAX_LENGTH} characters`);
  }
  if (b.action === "reject") {
    if (!reason || reason.length < RUBRIC_REJECT_REASON_MIN_LENGTH) {
      throw invalid(`reason is required when rejecting and must be at least ${RUBRIC_REJECT_REASON_MIN_LENGTH} characters`);
    }
    return { action: "reject", revision: b.revision, reason };
  }
  // Approve: the polarity must be stated. No default, least of all the proposal.
  if (typeof b.intentPolarity !== "string" || !(INTENT_POLARITIES as readonly string[]).includes(b.intentPolarity)) {
    throw invalid(`intentPolarity is required when approving (your decision, not the proposal's default): one of ${INTENT_POLARITIES.join(", ")}`);
  }
  let acknowledgedFlags: string[] = [];
  if (b.acknowledgedFlags !== undefined) {
    const list = b.acknowledgedFlags;
    if (!Array.isArray(list) || list.length > MAX_ACKNOWLEDGED_FLAGS || list.some((k) => typeof k !== "string" || !k || k.length > 300)) {
      throw invalid("acknowledgedFlags must be a list of flag keys (code:target)");
    }
    acknowledgedFlags = [...new Set(list as string[])];
  }
  return { action: "approve", revision: b.revision, intentPolarity: b.intentPolarity as IntentPolarity, acknowledgedFlags, reason: reason || null };
}

// ============================================
// Response shapes
// ============================================

/**
 * Whether a criterion's quote is still in the current stored text of its
 * source:
 *  - current:       it is;
 *  - stale:         the source has a newer snapshot and the quote is not in it;
 *  - unverifiable:  the source or its newest snapshot could not be read.
 */
export type CitationStatus = "current" | "stale" | "unverifiable";

/**
 * The source text around a quote, so a reviewer can read it in context. A
 * bounded window (see QUOTE_CONTEXT_CHARS), never the document.
 */
export interface QuoteContext {
  // Text of the same line / page just before and just after the quote.
  before: string;
  after: string;
  // True when the line / page holds more text in that direction.
  truncatedBefore: boolean;
  truncatedAfter: boolean;
  // Which snapshot the window was cut from: the source's CURRENT one, or
  // (for a stale citation) the one the quote was CITED to at extraction.
  snapshot: "current" | "cited";
}

/** A criterion as the review API returns it. */
export interface ReviewCriterion extends AssessmentCriterion {
  // True unless the quote was found in the current source text. So it is
  // also true when the check could not be made (see `citationStatus`).
  staleCitation: boolean;
  citationStatus: CitationStatus;
  // Null when no stored snapshot holding the quote could be read.
  quoteContext: QuoteContext | null;
}

/** Something that stops an approval whatever the reviewer acknowledges. */
export interface ApprovalBlocker {
  code: string;
  message: string;
}

/** One row of GET /admin/rubrics. */
export interface RubricVersionListItem {
  id: string;
  routeKey: string;
  countryCode: string;
  visaTypeId: string;
  version: number;
  reviewStatus: RubricReviewStatus;
  revision: number;
  criterionCount: number;
  // sha256 over the snapshots the version was extracted from.
  sourceSetHash: string;
  sources: { sourceId: string; contentHash: string; url: string; docType: string }[];
  flagCount: number;
  discardedCount: number;
  suspiciousPassageCount: number;
  intentPolarity: IntentPolarity | null;
  intentPolarityProposal: IntentPolarity | null;
  createdAt: string | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
  supersededAt: string | null;
  // The route's newest version (the only one that can be approved).
  isLatest: boolean;
  // The version consumers are served today.
  isServing: boolean;
}

/** GET /admin/rubrics/:id. */
export interface RubricVersionDetail extends Omit<RubricVersionListItem, "intentPolarityProposal" | "sources"> {
  schemaVersion: number;
  rejectReason: string | null;
  // The extractor's proposal with its quote, and that quote's context: the
  // sentence that states a polarity is exactly where a negation matters.
  intentPolarityProposal: (NonNullable<VisaRubric["intentPolarityProposal"]> & { quoteContext: QuoteContext | null }) | null;
  severityLevels: string[];
  criteria: ReviewCriterion[];
  intake: VisaRubric["intake"] | null;
  intakeQuestions: VisaRubric["intakeQuestions"];
  evidenceItems: VisaRubric["evidenceItems"];
  outcomeStatistics: VisaRubric["outcomeStatistics"] | null;
  sourceSnapshots: VisaRubric["sourceSnapshots"];
  extractorModel: string;
  extractorPromptVersion: string;
  extractionRunId: string;
  // ---- what the extractor dropped or doubted ----
  flags: ReviewFlag[];
  discarded: VisaRubric["discarded"];
  // Discards by reason code, counted over the stored list.
  discardedByReason: Record<string, number>;
  suspiciousPassages: RubricCitation[];
  // ---- the route ----
  route: { approvedVersion: number | null; latestVersion: number | null };
  // ---- against the serving version ----
  diff: {
    baselineVersion: number | null;
    allNew: boolean;
    added: AssessmentCriterion[];
    removed: AssessmentCriterion[];
    changed: ChangedCriterion[];
    unchangedCount: number;
    // Prominent: see IntentPolarityDiff.
    intentPolarityChanged: boolean;
    intentPolarity: IntentPolarityDiff;
    summary: { added: number; removed: number; changed: number; unchanged: number };
  };
  // ---- can it be approved, and what would that take ----
  approval: {
    // False when a blocker below applies (or the version is already decided).
    canApprove: boolean;
    blockers: ApprovalBlocker[];
    // Always true: an approve request must carry the admin's polarity.
    intentPolarityRequired: boolean;
    intentCriteriaCount: number;
    // Keys to send in `acknowledgedFlags`, as things stand with the
    // PROPOSED polarity. Deciding `not_assessed` while criteria concern
    // intent adds `conditionalAcknowledgement`.
    requiredAcknowledgements: string[];
    conditionalAcknowledgement: { key: string; when: string } | null;
    staleCriterionIds: string[];
  };
}

/** What `decide` returns. */
export interface RubricDecisionResult {
  id: string;
  routeKey: string;
  countryCode: string;
  visaTypeId: string;
  version: number;
  action: "approve" | "reject";
  reviewStatus: RubricReviewStatus;
  // The version's new revision.
  revision: number;
  intentPolarity: IntentPolarity | null;
  reviewedBy: string;
  reviewedAt: string;
  rejectReason: string | null;
  // The route's serving version after the decision.
  approvedVersion: number | null;
  // The version that was serving before (superseded by an approval; still
  // serving after a reject).
  previousApprovedVersion: number | null;
  // Id of the audit entry in `rubricReviewHistory`.
  auditId: string;
}

/** One `rubricReviewHistory` doc. */
export interface RubricReviewAuditEntry {
  id: string;
  at: Timestamp;
  // uid of the admin who decided.
  by: string;
  action: "approve" | "reject";
  routeKey: string;
  countryCode: string;
  visaTypeId: string;
  version: number;
  // Reject reason, or the optional approval note.
  reason: string | null;
  // Approve only: the decision, what the extractor proposed, and whether the
  // admin departed from it.
  intentPolarity: IntentPolarity | null;
  intentPolarityProposal: IntentPolarity | null;
  intentPolarityOverridden: boolean;
  // Approve only: the blocking flags `by` acknowledged (never free text from
  // the request: copied from the version's own flags).
  acknowledgedFlags: { key: string; code: string; target: string; message: string }[];
  // The version serving before this decision.
  previousApprovedVersion: number | null;
  // The version serving after it.
  approvedVersion: number | null;
  revisionBefore: number;
  revisionAfter: number;
  sourceSetHash: string;
}

/** Sent to `onApproved` listeners after an approval has committed. */
export interface RubricApprovedEvent {
  routeKey: string;
  countryCode: string;
  visaTypeId: string;
  // The version now serving.
  version: number;
  // The version it replaced, or null for a route's first approval.
  previousApprovedVersion: number | null;
  approvedBy: string;
  // ISO-8601.
  approvedAt: string;
  auditId: string;
}

/** A listener for approvals (#37 registers the re-assessment fan-out here). */
export type RubricApprovedListener = (event: RubricApprovedEvent) => void | Promise<void>;

// ============================================
// Small helpers
// ============================================

/** Firestore Timestamp -> ISO string (null when absent or not a Timestamp). */
function iso(value: unknown): string | null {
  const ts = value as Timestamp | null | undefined;
  return ts && typeof ts.toDate === "function" ? ts.toDate().toISOString() : null;
}

/**
 * The update for a version doc, restricted to the review fields. This is the
 * ONLY way this service builds a write to a version: a key outside
 * `RUBRIC_REVIEW_FIELDS` throws instead of reaching Firestore, so content and
 * provenance (criteria, sources, quotes) cannot be changed by a review.
 */
export function reviewFieldsUpdate(fields: Partial<Pick<VisaRubric, (typeof RUBRIC_REVIEW_FIELDS)[number]>>): Record<string, unknown> {
  const allowed: readonly string[] = RUBRIC_REVIEW_FIELDS;
  const update: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (!allowed.includes(key)) throw new Error(`rubric review may not write "${key}" on a version`);
    update[key] = value;
  }
  return update;
}

/** A citation copied field by field (nothing a later schema adds leaks). */
function toCitation(c: RubricCitation): RubricCitation {
  return {
    quote: c.quote,
    sourceId: c.sourceId,
    url: c.url,
    contentHash: c.contentHash,
    ...(c.page !== undefined ? { page: c.page } : {}),
    retrievedAt: c.retrievedAt,
    ...(c.publishedDate !== undefined ? { publishedDate: c.publishedDate } : {}),
  };
}

/** A criterion copied field by field, with its citation. */
function toCriterion(c: AssessmentCriterion): AssessmentCriterion {
  return {
    criterionId: c.criterionId,
    title: c.title,
    kind: c.kind,
    stage: c.stage,
    severity: c.severity,
    ...(c.ruleRef !== undefined ? { ruleRef: c.ruleRef } : {}),
    source: toCitation(c.source),
    ...(c.check !== undefined ? { check: c.check } : {}),
    // Includes `codeNames` (the platform's name for each proposed code).
    ...(c.appliesTo !== undefined ? { appliesTo: c.appliesTo } : {}),
    ...(c.validFrom !== undefined ? { validFrom: c.validFrom } : {}),
    ...(c.validUntil !== undefined ? { validUntil: c.validUntil } : {}),
    ...(c.probeFactors !== undefined ? { probeFactors: c.probeFactors } : {}),
    ...(c.requiresInterviewBeforeRefusal !== undefined ? { requiresInterviewBeforeRefusal: c.requiresInterviewBeforeRefusal } : {}),
    ...(c.concernsIntent !== undefined ? { concernsIntent: c.concernsIntent } : {}),
    ...(c.eligibilityQuestionId !== undefined ? { eligibilityQuestionId: c.eligibilityQuestionId } : {}),
    ...(c.intakeQuestionIds !== undefined ? { intakeQuestionIds: c.intakeQuestionIds } : {}),
    ...(c.citations !== undefined ? { citations: c.citations } : {}),
    confidence: c.confidence,
  };
}

/** The list row of a stored version. */
function toListItem(rubric: VisaRubric, head: RubricHead | null): RubricVersionListItem {
  return {
    id: rubricVersionId(rubric.routeKey, rubric.version),
    routeKey: rubric.routeKey,
    countryCode: rubric.countryCode,
    visaTypeId: rubric.visaTypeId,
    version: rubric.version,
    reviewStatus: rubric.reviewStatus,
    revision: rubric.revision,
    criterionCount: Array.isArray(rubric.criteria) ? rubric.criteria.length : 0,
    sourceSetHash: rubric.sourceSetHash,
    sources: (rubric.sourceSnapshots ?? []).map((s) => ({ sourceId: s.sourceId, contentHash: s.contentHash, url: s.url, docType: s.docType })),
    flagCount: reviewFlagsFor(rubric, rubric.intentPolarity).length,
    discardedCount: rubric.discardedCount ?? 0,
    suspiciousPassageCount: rubric.suspiciousPassages?.length ?? 0,
    intentPolarity: rubric.intentPolarity ?? null,
    intentPolarityProposal: rubric.intentPolarityProposal?.value ?? null,
    createdAt: iso(rubric.createdAt),
    reviewedBy: rubric.reviewedBy ?? null,
    reviewedAt: iso(rubric.reviewedAt),
    supersededAt: iso(rubric.supersededAt),
    isLatest: head !== null && head.latestVersion === rubric.version,
    isServing: head !== null && head.approvedVersion === rubric.version && rubric.reviewStatus === "approved",
  };
}

// ============================================
// Service
// ============================================

/** What the service needs from outside; all replaceable in tests. */
export interface RubricReviewDeps {
  // Reads a stored snapshot for the stale-citation check. Backend use only.
  snapshots: { read(sourceId: string, contentHash: string): Promise<GuidanceSnapshotContent> };
  // The clock every write of one decision is stamped with.
  now: () => Timestamp;
}

/** What was found for one citation. */
interface CitationFinding {
  status: CitationStatus;
  context: QuoteContext | null;
}

/** Outcome of the stale-citation check of one version. */
interface CitationCheck {
  // criterionId -> status and context.
  byCriterion: Map<string, CitationFinding>;
  // The polarity proposal's own quote, when it has one.
  proposal: CitationFinding | null;
  // sourceId -> the `latestSnapshotId` the check was made against (null when
  // the source has none or does not exist). Re-read inside the decision's
  // transaction: a source that moved in between aborts the approval.
  sourceHeads: Map<string, string | null>;
}

export class RubricReviewService {
  // Transaction runner; a property so tests can swap in an in-memory one.
  runTransaction: <T>(fn: (tx: Transaction) => Promise<T>) => Promise<T> = (fn) => db.runTransaction(fn);

  /** Listeners called after an approval commits (the #37 seam). */
  private readonly approvalListeners: RubricApprovedListener[] = [];

  private readonly deps: RubricReviewDeps;

  constructor(deps: Partial<RubricReviewDeps> = {}) {
    this.deps = { snapshots: guidanceSnapshotStore, now: () => Timestamp.now(), ...deps };
  }

  // ---------- Seam for #37 ----------

  /**
   * Register a listener for approvals. Called once per approval, AFTER the
   * transaction has committed, with the route and the version now serving.
   * A listener that throws is logged and ignored. Returns an unsubscribe.
   */
  onApproved(listener: RubricApprovedListener): () => void {
    this.approvalListeners.push(listener);
    return () => {
      const i = this.approvalListeners.indexOf(listener);
      if (i >= 0) this.approvalListeners.splice(i, 1);
    };
  }

  /** Call every approval listener; never throws. */
  private async emitApproved(event: RubricApprovedEvent): Promise<void> {
    for (const listener of [...this.approvalListeners]) {
      try {
        await listener(event);
      } catch (err) {
        // Ids only: an approval is already committed and must not fail here.
        console.error(`Rubric review: an approval listener failed for ${event.routeKey} v${event.version}: ${(err as Error)?.message ?? err}`);
      }
    }
  }

  // ---------- List ----------

  /**
   * Versions with the given review status across every route, newest
   * extraction first. Needs the `rubricVersions` collection-group index
   * (reviewStatus ASC, createdAt DESC) in firestore.indexes.json.
   */
  async listVersions(q: { reviewStatus: RubricReviewStatus; limit: number }): Promise<RubricVersionListItem[]> {
    const [snap, heads] = await Promise.all([
      collectionGroups.rubricVersions().where("reviewStatus", "==", q.reviewStatus).orderBy("createdAt", "desc").limit(q.limit).get(),
      // The registry of routes is small; one read tells "newest" and "serving".
      rubricStore.listHeads(),
    ]);
    const headByRoute = new Map(heads.map((h) => [h.routeKey, h]));
    return snap.docs.map((d) => {
      const rubric = d.data() as VisaRubric;
      return toListItem(rubric, headByRoute.get(rubric.routeKey) ?? null);
    });
  }

  // ---------- Stale citations ----------

  /**
   * For each criterion: is its quote still in the CURRENT stored text of its
   * source (the snapshot the source's `latestSnapshotId` points at)? The
   * lookup is the one extraction used (`SnapshotQuoteIndex.locate`): verbatim
   * after whitespace normalisation, on word boundaries, within one line or
   * page, no fuzzy matching.
   *
   * Each finding also carries the bounded window of text around the quote:
   * from the current snapshot when the quote is there, else from the snapshot
   * it was cited to (so a reviewer can still read a stale quote in context).
   * A source or snapshot that cannot be read makes its criteria
   * `unverifiable`, never `current`. Each snapshot is read at most once.
   */
  private async checkCitations(rubric: VisaRubric): Promise<CitationCheck> {
    const criteria = Array.isArray(rubric.criteria) ? rubric.criteria : [];
    const proposalSource = rubric.intentPolarityProposal?.source ?? null;
    const sourceIds = [
      ...new Set([...criteria.map((c) => c.source?.sourceId), proposalSource?.sourceId].filter((id): id is string => typeof id === "string" && id.length > 0)),
    ];

    // ---- where each source stands now ----
    const sourceHeads = new Map<string, string | null>();
    await Promise.all(
      sourceIds.map(async (sourceId) => {
        let latest: string | null = null;
        try {
          const snap = await collections.guidanceSources.doc(sourceId).get();
          const id = snap.exists ? (snap.data() as { latestSnapshotId?: unknown }).latestSnapshotId : null;
          latest = typeof id === "string" && id ? id : null;
        } catch (err) {
          console.error(`Rubric review: guidance source ${sourceId} unreadable: ${(err as Error)?.message ?? err}`);
        }
        sourceHeads.set(sourceId, latest);
      })
    );

    // ---- snapshots, read lazily and once each; null when unreadable ----
    const indexes = new Map<string, Promise<SnapshotQuoteIndex | null>>();
    const indexOf = (sourceId: string, contentHash: string): Promise<SnapshotQuoteIndex | null> => {
      const key = `${sourceId}:${contentHash}`;
      let index = indexes.get(key);
      if (!index) {
        index = this.deps.snapshots
          .read(sourceId, contentHash)
          .then((content) => new SnapshotQuoteIndex(content))
          .catch((err) => {
            // The source id only: never the path or any text.
            console.error(`Rubric review: a snapshot of ${sourceId} is unreadable: ${(err as Error)?.message ?? err}`);
            return null;
          });
        indexes.set(key, index);
      }
      return index;
    };
    /** The window around a quote in one snapshot, or null when it is not there. */
    const contextIn = (index: SnapshotQuoteIndex | null, quote: string, snapshot: QuoteContext["snapshot"]): QuoteContext | null => {
      const found = index?.locate(quote);
      return index && found?.ok ? { ...index.contextAround(found, QUOTE_CONTEXT_CHARS), snapshot } : null;
    };
    /** Status and context of one citation. */
    const inspect = async (citation: RubricCitation | undefined): Promise<CitationFinding> => {
      const sourceId = citation?.sourceId;
      const latest = sourceId ? sourceHeads.get(sourceId) ?? null : null;
      if (!citation || !sourceId || latest === null) return { status: "unverifiable", context: null };
      const current = await indexOf(sourceId, latest);
      const inCurrent = contextIn(current, citation.quote, "current");
      if (inCurrent) return { status: "current", context: inCurrent };
      // Not in the current text (or it could not be read). Show the quote
      // where it WAS found: the snapshot it was cited to.
      const cited = citation.contentHash !== latest ? contextIn(await indexOf(sourceId, citation.contentHash), citation.quote, "cited") : null;
      return { status: current ? "stale" : "unverifiable", context: cited };
    };

    const byCriterion = new Map<string, CitationFinding>();
    await Promise.all(criteria.map(async (c) => void byCriterion.set(c.criterionId, await inspect(c.source))));
    return { byCriterion, proposal: proposalSource ? await inspect(proposalSource) : null, sourceHeads };
  }

  // ---------- Detail ----------

  /**
   * The approved version a version is compared with:
   *  - for a pending or rejected version: the one SERVING now (the head's
   *    `approvedVersion`), which is the latest approved one;
   *  - for a version that is itself approved: the approved version before it
   *    (what its own approval replaced).
   * Null when there is none.
   */
  private async loadBaseline(rubric: VisaRubric, head: RubricHead | null): Promise<VisaRubric | null> {
    let baselineVersion: number | null = null;
    if (rubric.reviewStatus !== "approved") {
      baselineVersion = head?.approvedVersion ?? null;
    } else {
      // One equality filter (automatic single-field index); a route has few
      // versions, so the predecessor is picked here.
      const snap = await subcollections.rubricVersions(rubric.routeKey).where("reviewStatus", "==", "approved").get();
      const earlier = snap.docs.map((d) => (d.data() as VisaRubric).version).filter((v) => typeof v === "number" && v < rubric.version);
      baselineVersion = earlier.length > 0 ? Math.max(...earlier) : null;
    }
    if (baselineVersion === null || baselineVersion === rubric.version) return null;
    const baseline = await rubricStore.getVersionForReview(rubric.routeKey, baselineVersion);
    // Only an approved version is a baseline, whatever the head says.
    return baseline && baseline.reviewStatus === "approved" ? baseline : null;
  }

  /**
   * One version in full, with its diff, its stale-citation check and what an
   * approval would take. Null when the id names no version.
   */
  async getVersion(id: string): Promise<RubricVersionDetail | null> {
    const parsed = parseRubricVersionId(id);
    if (!parsed) return null;
    const rubric = await rubricStore.getVersionForReview(parsed.routeKey, parsed.version);
    if (!rubric) return null;

    const [head, citations] = await Promise.all([rubricStore.getHead(parsed.routeKey), this.checkCitations(rubric)]);
    const baseline = await this.loadBaseline(rubric, head);

    // ---- criteria with their citation status ----
    const criteria: ReviewCriterion[] = rubric.criteria.map((c) => {
      const finding = citations.byCriterion.get(c.criterionId) ?? { status: "unverifiable" as const, context: null };
      return { ...toCriterion(c), staleCitation: finding.status !== "current", citationStatus: finding.status, quoteContext: finding.context };
    });

    // ---- diff (serialised criteria: the same whitelist as above) ----
    const raw = diffRubricVersions(rubric, baseline);
    const diff: RubricVersionDetail["diff"] = {
      baselineVersion: raw.baselineVersion,
      allNew: raw.allNew,
      added: raw.added.map(toCriterion),
      removed: raw.removed.map(toCriterion),
      changed: raw.changed.map((c) => ({ ...c, before: toCriterion(c.before) })),
      unchangedCount: raw.unchangedCount,
      intentPolarityChanged: raw.intentPolarity.proposalChanged,
      intentPolarity: raw.intentPolarity,
      summary: { added: raw.added.length, removed: raw.removed.length, changed: raw.changed.length, unchanged: raw.unchangedCount },
    };

    // ---- flags and approval readiness ----
    // Before a decision the validator falls back to the proposal; after one,
    // the decision is what the flags are computed from.
    const flags = reviewFlagsFor(rubric, rubric.intentPolarity);
    const intentCriteriaCount = rubric.criteria.filter((c) => c.concernsIntent === true).length;
    const blockers = this.approvalBlockers(rubric, head, citations);
    const discardedByReason: Record<string, number> = {};
    for (const d of rubric.discarded ?? []) discardedByReason[d.reason] = (discardedByReason[d.reason] ?? 0) + 1;

    const item = toListItem(rubric, head);
    return {
      id: item.id,
      routeKey: item.routeKey,
      countryCode: item.countryCode,
      visaTypeId: item.visaTypeId,
      version: item.version,
      schemaVersion: rubric.schemaVersion,
      reviewStatus: item.reviewStatus,
      revision: item.revision,
      criterionCount: item.criterionCount,
      sourceSetHash: item.sourceSetHash,
      flagCount: flags.length,
      discardedCount: item.discardedCount,
      suspiciousPassageCount: item.suspiciousPassageCount,
      intentPolarity: item.intentPolarity,
      intentPolarityProposal: rubric.intentPolarityProposal
        ? {
          value: rubric.intentPolarityProposal.value,
          ...(rubric.intentPolarityProposal.source ? { source: toCitation(rubric.intentPolarityProposal.source) } : {}),
          quoteContext: citations.proposal?.context ?? null,
        }
        : null,
      createdAt: item.createdAt,
      reviewedBy: item.reviewedBy,
      reviewedAt: item.reviewedAt,
      rejectReason: rubric.rejectReason ?? null,
      supersededAt: item.supersededAt,
      isLatest: item.isLatest,
      isServing: item.isServing,
      severityLevels: [...(rubric.severityLevels ?? [])],
      criteria,
      intake: rubric.intake ?? null,
      intakeQuestions: rubric.intakeQuestions ?? [],
      evidenceItems: (rubric.evidenceItems ?? []).map((e) => ({ ...e, source: toCitation(e.source) })),
      outcomeStatistics: rubric.outcomeStatistics ?? null,
      sourceSnapshots: (rubric.sourceSnapshots ?? []).map((s) => ({
        sourceId: s.sourceId,
        contentHash: s.contentHash,
        url: s.url,
        docType: s.docType,
        ...(s.publishedDate !== undefined ? { publishedDate: s.publishedDate } : {}),
      })),
      extractorModel: rubric.extractorModel,
      extractorPromptVersion: rubric.extractorPromptVersion,
      extractionRunId: rubric.extractionRunId,
      flags,
      discarded: (rubric.discarded ?? []).map((d) => ({
        itemType: d.itemType,
        reason: d.reason,
        detail: d.detail,
        label: d.label,
        sourceId: d.sourceId,
        chunkIndex: d.chunkIndex,
      })),
      discardedByReason,
      suspiciousPassages: (rubric.suspiciousPassages ?? []).map(toCitation),
      route: { approvedVersion: head?.approvedVersion ?? null, latestVersion: head?.latestVersion ?? null },
      diff,
      approval: {
        canApprove: blockers.length === 0,
        blockers,
        intentPolarityRequired: true,
        intentCriteriaCount,
        requiredAcknowledgements: rubric.reviewStatus === "pending_review" ? flags.filter((f) => f.blocking).map((f) => f.key) : [],
        conditionalAcknowledgement:
          rubric.reviewStatus === "pending_review" && intentCriteriaCount > 0
            ? { key: flagKey({ code: INTENT_FLAG_CODE, target: "rubric" }), when: "intentPolarity is not_assessed" }
            : null,
        staleCriterionIds: criteria.filter((c) => c.staleCitation).map((c) => c.criterionId),
      },
    };
  }

  /**
   * What refuses an approval outright, as far as it can be told without the
   * request (state, position in the route, citations). The same checks run
   * again, authoritatively, inside `decide`.
   */
  private approvalBlockers(rubric: VisaRubric, head: RubricHead | null, citations: CitationCheck): ApprovalBlocker[] {
    const blockers: ApprovalBlocker[] = [];
    if (rubric.reviewStatus !== "pending_review") {
      blockers.push({ code: "ALREADY_DECIDED", message: `This version is already ${rubric.reviewStatus}.` });
    }
    if (!head || head.latestVersion !== rubric.version) {
      blockers.push({ code: "NOT_LATEST_VERSION", message: "A newer version of this route's rubric exists. Review that one; this one can only be rejected." });
    }
    const statuses = [...citations.byCriterion.values()].map((f) => f.status);
    const stale = statuses.filter((s) => s === "stale").length;
    const unverifiable = statuses.filter((s) => s === "unverifiable").length;
    if (stale > 0) {
      blockers.push({ code: "STALE_CITATION", message: `${stale} criterion/criteria quote text that is no longer in the current source. Re-extract the rubric instead of approving this version.` });
    }
    if (unverifiable > 0) {
      blockers.push({ code: "CITATION_UNVERIFIABLE", message: `${unverifiable} criterion/criteria could not be checked against the current source text (source or snapshot unreadable).` });
    }
    return blockers;
  }

  // ---------- Decide ----------

  /**
   * Approve or reject a whole version. See the file header for the rules.
   *
   * @param id          API id of the version (`{routeKey}__v{version}`)
   * @param input       a parsed decision (`parseRubricDecision`)
   * @param reviewerUid uid of the admin deciding (from the verified token)
   * @throws RubricReviewError with the HTTP status to send; nothing is
   *   written when it throws.
   */
  async decide(id: string, input: RubricDecisionInput, reviewerUid: string): Promise<RubricDecisionResult> {
    const parsed = parseRubricVersionId(id);
    if (!parsed) throw notFound();
    if (!reviewerUid) throw new Error("rubric review: a decision needs the reviewer's uid");
    const { routeKey, version } = parsed;

    // ---- Before the transaction: the stale-citation check (Storage reads
    // cannot run inside a Firestore transaction). Approve only. The version
    // content it reads is immutable, and the sources it was made against are
    // re-read inside the transaction below.
    let citations: CitationCheck | null = null;
    if (input.action === "approve") {
      const preview = await rubricStore.getVersionForReview(routeKey, version);
      if (!preview) throw notFound();
      // Cheap early answers; both are checked again inside the transaction.
      if (preview.reviewStatus !== "pending_review") throw conflict("ALREADY_DECIDED", `This rubric version is already ${preview.reviewStatus}`);
      citations = await this.checkCitations(preview);
      const statuses = [...citations.byCriterion.values()].map((f) => f.status);
      if (statuses.includes("stale")) {
        throw conflict("STALE_CITATION", "A criterion quotes text that is no longer in the current source. The source has moved on: re-extract the rubric instead of approving this version.");
      }
      if (statuses.includes("unverifiable")) {
        throw conflict("CITATION_UNVERIFIABLE", "A criterion could not be checked against the current source text (source or snapshot unreadable). Nothing was approved; try again or re-extract.");
      }
    }

    const now = this.deps.now();
    const versionRef = subcollections.rubricVersions(routeKey).doc(String(version));
    const headRef = collections.visaRubrics.doc(routeKey);
    const auditRef = collections.rubricReviewHistory.doc();

    const result = await this.runTransaction(async (tx) => {
      // ======== READS (all before any write) ========
      const [versionSnap, headSnap] = await Promise.all([tx.get(versionRef), tx.get(headRef)]);
      if (!versionSnap.exists || !headSnap.exists) throw notFound();
      const rubric = versionSnap.data() as VisaRubric;
      const head = headSnap.data() as RubricHead;

      // ---- one decision per version ----
      if (rubric.reviewStatus !== "pending_review") throw conflict("ALREADY_DECIDED", `This rubric version is already ${rubric.reviewStatus}`);
      if (rubric.revision !== input.revision) {
        throw conflict("REVISION_MISMATCH", `This rubric version changed since you opened it (revision ${rubric.revision}, you reviewed ${input.revision}). Reload it and review again.`);
      }
      const revisionAfter = rubric.revision + 1;
      const previousApprovedVersion = head.approvedVersion ?? null;

      /** The audit fields both actions share. */
      const auditBase = {
        id: auditRef.id,
        at: now,
        by: reviewerUid,
        routeKey,
        countryCode: rubric.countryCode,
        visaTypeId: rubric.visaTypeId,
        version,
        previousApprovedVersion,
        revisionBefore: rubric.revision,
        revisionAfter,
        sourceSetHash: rubric.sourceSetHash,
      };
      /** The response fields both actions share. */
      const resultBase = {
        id: rubricVersionId(routeKey, version),
        routeKey,
        countryCode: rubric.countryCode,
        visaTypeId: rubric.visaTypeId,
        version,
        revision: revisionAfter,
        reviewedBy: reviewerUid,
        reviewedAt: now.toDate().toISOString(),
        previousApprovedVersion,
        auditId: auditRef.id,
      };

      // ======== REJECT ========
      if (input.action === "reject") {
        // Only the version's review fields. The head is not written at all,
        // so `approvedVersion` cannot move: what was serving keeps serving.
        tx.update(versionRef, reviewFieldsUpdate({ reviewStatus: "rejected", rejectReason: input.reason, reviewedBy: reviewerUid, reviewedAt: now, revision: revisionAfter }));
        const audit: RubricReviewAuditEntry = {
          ...auditBase,
          action: "reject",
          reason: input.reason,
          intentPolarity: null,
          intentPolarityProposal: rubric.intentPolarityProposal?.value ?? null,
          intentPolarityOverridden: false,
          acknowledgedFlags: [],
          approvedVersion: previousApprovedVersion,
        };
        tx.set(auditRef, audit as unknown as Record<string, unknown>);
        return { ...resultBase, action: "reject" as const, reviewStatus: "rejected" as const, intentPolarity: null, rejectReason: input.reason, approvedVersion: previousApprovedVersion };
      }

      // ======== APPROVE ========
      // ---- only the newest version of a route, and never backwards ----
      if (head.latestVersion !== version || (previousApprovedVersion !== null && previousApprovedVersion > version)) {
        throw conflict("NOT_LATEST_VERSION", `Version ${head.latestVersion} of this route's rubric is newer than version ${version}. Only the newest version can be approved; this one can only be rejected.`);
      }

      // ---- the version it replaces (read now: reads come before writes) ----
      const supersededRef = previousApprovedVersion !== null && previousApprovedVersion !== version ? subcollections.rubricVersions(routeKey).doc(String(previousApprovedVersion)) : null;
      const supersededSnap = supersededRef ? await tx.get(supersededRef) : null;

      // ---- the sources must still be where the citation check found them ----
      for (const [sourceId, checkedAgainst] of (citations as CitationCheck).sourceHeads) {
        const snap = await tx.get(collections.guidanceSources.doc(sourceId));
        const latest = snap.exists ? (snap.data() as { latestSnapshotId?: unknown }).latestSnapshotId : null;
        if ((typeof latest === "string" && latest ? latest : null) !== checkedAgainst) {
          throw conflict("SOURCE_CHANGED", "A guidance source changed while this approval was being checked. Nothing was approved; reload the version and review again.");
        }
      }

      // ---- the rubric exactly as it would be approved ----
      const candidate: VisaRubric = { ...rubric, reviewStatus: "approved", intentPolarity: input.intentPolarity, reviewedBy: reviewerUid, reviewedAt: now, rejectReason: null, revision: revisionAfter };
      const validation = validateVisaRubric(candidate);
      if (validation.errors.length > 0) {
        const codes = [...new Set(validation.errors.map((e) => e.code))].join(", ");
        throw conflict("RUBRIC_INVALID", `This rubric version is not internally consistent and cannot be approved (${codes}). Reject it and re-extract.`);
      }

      // ---- blocking flags: each one acknowledged by name ----
      const flags = reviewFlagsFor(rubric, input.intentPolarity);
      const blocking = flags.filter((f) => f.blocking);
      const unknownKeys = input.acknowledgedFlags.filter((k) => !flags.some((f) => f.key === k));
      if (unknownKeys.length > 0) throw invalid(`acknowledgedFlags names flag(s) this version does not have: ${unknownKeys.join(", ")}`);
      const missing = blocking.filter((f) => !input.acknowledgedFlags.includes(f.key));
      if (missing.length > 0) {
        throw conflict("FLAGS_NOT_ACKNOWLEDGED", `This version has flag(s) you must read and acknowledge before approving: ${missing.map((f) => f.key).join(", ")}. Send them in acknowledgedFlags.`);
      }
      const acknowledged = flags.filter((f) => input.acknowledgedFlags.includes(f.key)).map((f) => ({ key: f.key, code: f.code, target: f.target, message: f.message }));

      // ======== WRITES ========
      // 1. The version: review fields only.
      tx.update(versionRef, reviewFieldsUpdate({ reviewStatus: "approved", intentPolarity: input.intentPolarity, reviewedBy: reviewerUid, reviewedAt: now, rejectReason: null, revision: revisionAfter }));
      // 2. The version it replaces: marked superseded (it stays `approved`
      //    as a record, but the head no longer points at it).
      if (supersededRef && supersededSnap?.exists) {
        const superseded = supersededSnap.data() as VisaRubric;
        tx.update(supersededRef, reviewFieldsUpdate({ supersededAt: now, revision: (superseded.revision ?? 0) + 1 }));
      }
      // 3. The head: this version now serves. Same transaction, so a consumer
      //    never sees a head pointing at a version that is not approved.
      tx.update(headRef, { approvedVersion: version, updatedAt: now });
      // 4. The audit entry.
      const proposal = rubric.intentPolarityProposal?.value ?? null;
      const audit: RubricReviewAuditEntry = {
        ...auditBase,
        action: "approve",
        reason: input.reason,
        intentPolarity: input.intentPolarity,
        intentPolarityProposal: proposal,
        intentPolarityOverridden: proposal !== input.intentPolarity,
        acknowledgedFlags: acknowledged,
        approvedVersion: version,
      };
      tx.set(auditRef, audit as unknown as Record<string, unknown>);
      return { ...resultBase, action: "approve" as const, reviewStatus: "approved" as const, intentPolarity: input.intentPolarity, rejectReason: null, approvedVersion: version };
    });

    // ---- After the commit: tell whoever re-assesses (#37). Never throws. ----
    if (result.action === "approve") {
      await this.emitApproved({
        routeKey: result.routeKey,
        countryCode: result.countryCode,
        visaTypeId: result.visaTypeId,
        version: result.version,
        previousApprovedVersion: result.previousApprovedVersion,
        approvedBy: reviewerUid,
        approvedAt: result.reviewedAt,
        auditId: result.auditId,
      });
    }
    return result;
  }
}

/** Singleton over the project's Firestore and snapshot store. */
export const rubricReviewService = new RubricReviewService();

/** Review statuses a list may be asked for (re-exported for the controller). */
export { RUBRIC_REVIEW_STATUSES };
