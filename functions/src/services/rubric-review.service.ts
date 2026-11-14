import { Timestamp, type DocumentData, type Transaction, type UpdateData } from "firebase-admin/firestore";
import { collectionGroups, collections, db, subcollections } from "../utils/firebase";
// The scrapers module is reached through its public entry point only (the
// ESLint boundary rule of issue #91 refuses deep imports from here).
import { EXCLUSION_NOTE_MAX, MAX_EXCLUDED_CRITERIA, applyRuleRepairs, barsServedWithoutTrigger, SnapshotQuoteIndex, guidanceSnapshotStore, previewExclusions, rubricStore, rulebookPartsOf, targetInputOf, validateVisaRubric } from "../scrapers";
import type { ExclusionPreview } from "../scrapers";
import type { GuidanceSnapshotContent } from "../scrapers/types";
import type { RubricIssue } from "../scrapers";
import {
  INTENT_POLARITIES,
  JUDGED_BAR_NOTE,
  RUBRIC_REVIEW_FIELDS,
  RUBRIC_REVIEW_STATUSES,
  RUBRIC_ACTOR_KIND,
  RUBRIC_SYSTEM_ACTOR_ID,
  type AssessmentCriterion,
  type EvidenceItem,
  type IntentPolarity,
  type OutcomeStatisticsMapping,
  type RubricCitation,
  type RubricFlag,
  type RubricHead,
  type RubricReviewActor,
  type RubricReviewStatus,
  type VisaRubric,
} from "../types/rubric";
import { diffRubricVersions, type ChangedCriterion, type IntentPolarityDiff, type RubricDiff } from "./rubric-diff";

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
// ---- Who may decide (issue #201) ----
//
// The approve (and the reject) branch takes an ACTOR: `{ kind: ADMIN, uid }`
// from the verified token, or `{ kind: SYSTEM, id: RUBRIC_SYSTEM_ACTOR_ID }`
// for the automatic publisher (services/rubric-auto-publish.service.ts). There
// is ONE approval transaction and ONE validator for both: every invariant
// above (newest version only, sources unchanged, stale citations, structural
// check, bars never excluded, pending only, flags acknowledged, primary
// exclusions confirmed) applies to the machine exactly as to a person. The
// system actor differs only in what it writes: `reviewedBy` / audit `by` is the
// system id, and the audit entry carries `automatic: true` and `publishRunId`.
// An admin whose uid equals the system id is refused, so the id can never be
// claimed by a person.
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

/** The shape of an outcome-statistics `categoryKey` an admin may set (#116). */
const OUTCOME_CATEGORY_KEY_RE = /^(group|type):[a-z0-9:-]+$/;
/** Longest `categoryKey`, `categoryLabel`, `adapterId`, `sourceUrl`, `note` accepted. */
const OUTCOME_KEY_MAX = 200;
const OUTCOME_LABEL_MAX = 120;
const OUTCOME_ADAPTER_MAX = 100;
const OUTCOME_URL_MAX = 2000;
const OUTCOME_NOTE_MAX = 1000;
/** Most criteria one `evidenceHelpsCriterionIds` may name. */
const MAX_EVIDENCE_HELPS_CRITERIA = 100;
/** Keys an `outcomeStatistics` body object may carry (strict). */
const OUTCOME_BODY_KEYS = ["categoryKey", "categoryLabel", "adapterId", "sourceUrl", "note"];

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
 *  - page_ends_mid_sentence: a rule crossing a page break may be cut short;
 *  - title_wording_uncited: criterion titles are the model's own wording (raised on
 *    essentially every version);
 *  - specialist_rules_without_trigger / rule_trigger_simplified (#207): some kept rules
 *    could not be tied to an intake answer (assessed as "could not tell") or only their
 *    first trigger question was stored.
 */
const STANDING_NOTICE_FLAG_CODES: ReadonlySet<string> = new Set([
  "nationality_codes_model_proposed",
  "intake_wording_uncited",
  "multiple_chunks",
  "page_ends_mid_sentence",
  "title_wording_uncited",
  // INTEGRATION (#200): raised by #207, which keeps specialist rules. Both are limits of the
  // extraction that hold for the version as a whole (one key per code), not one thing to fix.
  "specialist_rules_without_trigger",
  "rule_trigger_simplified",
]);

/**
 * `{routeKey}__v{version}`: the id of one rubric version in the API.
 * (#233) The route key is any authority's rulebook key `{authorityId}_{routeSlug}`
 * (a country's `{countryCode}_{visaTypeId}` as before, or a bloc / treaty's
 * shared layer). The pattern keeps the old character classes (no `/`, so a
 * parsed key can never steer a path), and `parseRubricVersionId` then checks
 * the key against the authority id rules.
 */
const VERSION_ID_RE = /^([A-Za-z0-9][A-Za-z0-9_-]*)__v([1-9]\d{0,8})$/;

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
  | "RUBRIC_MALFORMED" // 422: the stored document is not a rubric (no criteria list)
  | "FLAGS_NOT_ACKNOWLEDGED" // 409: a blocking flag was not acknowledged
  | "PRIMARY_EXCLUSION_UNCONFIRMED"; // 409: primary-source criteria excluded without confirmPrimaryExclusions (#161)

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
/** 422 for a stored version whose document is not shaped like a rubric. */
const malformed = () => new RubricReviewError("RUBRIC_MALFORMED", "This rubric version is stored in a shape the review cannot read. Reject it and re-extract.", 422);

/**
 * A safe description of an error for the log: its numeric/string `code` when
 * it has one, else its class name. Never the message, which for a storage
 * error includes the object path.
 */
function errorClass(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === "string" || typeof code === "number") return `code ${code}`;
  return (err as { constructor?: { name?: string } } | null)?.constructor?.name ?? "unknown error";
}

// ============================================
// Ids
// ============================================

/** API id of a rubric version. */
export function rubricVersionId(routeKey: string, version: number): string {
  return `${routeKey}__v${version}`;
}

/**
 * (#233) The naming pair of a rulebook document for API rows, audit entries and
 * approval events: `countryCode` + `visaTypeId` for a country's rulebook
 * (exactly the fields these carried before), `authorityId` + `routeSlug` for a
 * bloc / treaty layer (which has no country). Empty for a document whose key
 * cannot be read (the validator reports that one).
 */
function namingOf(doc: { routeKey: string; authorityId?: string; routeSlug?: string; countryCode?: string; visaTypeId?: string }): { countryCode?: string; visaTypeId?: string; authorityId?: string; routeSlug?: string } {
  const parts = rulebookPartsOf(doc);
  return parts ? targetInputOf(parts) : {};
}

/**
 * Split an API id into its route key and version, or null when the text is
 * not such an id. The pattern is anchored and its character classes hold no
 * `/`, so a parsed route key can never steer a document path elsewhere.
 */
export function parseRubricVersionId(id: unknown): { routeKey: string; version: number } | null {
  if (typeof id !== "string") return null;
  const m = VERSION_ID_RE.exec(id);
  if (!m) return null;
  // (#233) The key must be a valid rulebook key (a country code in capitals,
  // or a bloc / treaty id), exactly as the store would address it.
  if (!rulebookPartsOf({ routeKey: m[1] })) return null;
  return { routeKey: m[1], version: Number(m[2]) };
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
      // ADMIN-SET (#116), optional: written with the approval when sent,
      // left as stored (absent) when not. Never read from extraction output.
      outcomeStatistics?: OutcomeStatisticsMapping;
      evidenceHelpsCriterionIds?: string[];
      // ADMIN-SET (#161), optional: criteria to leave out of the served
      // rubric, the reviewer's one note for them, and the explicit
      // confirmation needed when any of them comes from a primary source.
      excludedCriterionIds?: string[];
      exclusionNote?: string;
      confirmPrimaryExclusions?: boolean;
    }
  | { action: "reject"; revision: number; reason: string };

/** Body keys each action accepts. Anything else is refused, not ignored. */
const APPROVE_KEYS = ["action", "revision", "intentPolarity", "acknowledgedFlags", "reason", "outcomeStatistics", "evidenceHelpsCriterionIds", "excludedCriterionIds", "exclusionNote", "confirmPrimaryExclusions"];
// A reject accepts none of the admin-set fields (REJECT_KEYS is strict), so
// sending exclusions with a reject is a 400 like the other admin-set fields.
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
  const out: RubricDecisionInput = { action: "approve", revision: b.revision, intentPolarity: b.intentPolarity as IntentPolarity, acknowledgedFlags, reason: reason || null };
  if (b.outcomeStatistics !== undefined) out.outcomeStatistics = parseOutcomeStatistics(b.outcomeStatistics);
  if (b.evidenceHelpsCriterionIds !== undefined) out.evidenceHelpsCriterionIds = parseEvidenceHelps(b.evidenceHelpsCriterionIds);
  // ---- exclusions (#161) ----
  if (b.excludedCriterionIds !== undefined) out.excludedCriterionIds = parseExcludedIds(b.excludedCriterionIds, "excludedCriterionIds");
  if (b.exclusionNote !== undefined && b.exclusionNote !== null) {
    if (typeof b.exclusionNote !== "string") throw invalid("exclusionNote must be a string");
    const note = b.exclusionNote.trim();
    if (note.length > EXCLUSION_NOTE_MAX) throw invalid(`exclusionNote must be at most ${EXCLUSION_NOTE_MAX} characters`);
    // A note with nothing excluded would describe nothing: refuse it.
    if (note && !(out.excludedCriterionIds && out.excludedCriterionIds.length > 0)) throw invalid("exclusionNote needs excludedCriterionIds: there is nothing to explain");
    if (note) out.exclusionNote = note;
  }
  if (b.confirmPrimaryExclusions !== undefined) {
    if (typeof b.confirmPrimaryExclusions !== "boolean") throw invalid("confirmPrimaryExclusions must be true or false");
    out.confirmPrimaryExclusions = b.confirmPrimaryExclusions;
  }
  return out;
}

/**
 * Validate the admin-set outcome-statistics mapping of an approval. Strict:
 * unknown keys are refused; strings are trimmed; `sourceUrl` is http(s) only.
 * @throws RubricReviewError (400 VALIDATION_ERROR)
 */
function parseOutcomeStatistics(raw: unknown): OutcomeStatisticsMapping {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw invalid("outcomeStatistics must be an object");
  const o = raw as Record<string, unknown>;
  const extra = Object.keys(o).filter((k) => !OUTCOME_BODY_KEYS.includes(k));
  if (extra.length > 0) throw invalid(`unknown field(s) in outcomeStatistics: ${extra.join(", ")}`);
  /** A trimmed string no longer than `max`; null when absent. */
  const text = (key: string, max: number): string | null => {
    const v = o[key];
    if (v === undefined || v === null) return null;
    if (typeof v !== "string") throw invalid(`outcomeStatistics.${key} must be a string`);
    const t = v.trim();
    if (t.length > max) throw invalid(`outcomeStatistics.${key} must be at most ${max} characters`);
    return t;
  };
  const categoryKey = text("categoryKey", OUTCOME_KEY_MAX);
  if (!categoryKey || !OUTCOME_CATEGORY_KEY_RE.test(categoryKey)) throw invalid("outcomeStatistics.categoryKey is required and must look like group:<slug> or type:<slug>");
  const categoryLabel = text("categoryLabel", OUTCOME_LABEL_MAX);
  if (!categoryLabel) throw invalid("outcomeStatistics.categoryLabel is required (the wording for the category in the applicant's note)");
  const result: OutcomeStatisticsMapping = { categoryKey, categoryLabel };
  const adapterId = text("adapterId", OUTCOME_ADAPTER_MAX);
  if (adapterId) result.adapterId = adapterId;
  const sourceUrl = text("sourceUrl", OUTCOME_URL_MAX);
  if (sourceUrl) {
    let ok = false;
    try {
      ok = ["http:", "https:"].includes(new URL(sourceUrl).protocol);
    } catch {
      ok = false;
    }
    if (!ok) throw invalid("outcomeStatistics.sourceUrl must be an http(s) URL");
    result.sourceUrl = sourceUrl;
  }
  const note = text("note", OUTCOME_NOTE_MAX);
  if (note) result.note = note;
  return result;
}

/** Validate the admin's list of criterion ids: strings, de-duplicated, capped. */
function parseEvidenceHelps(raw: unknown): string[] {
  if (!Array.isArray(raw) || raw.length > MAX_EVIDENCE_HELPS_CRITERIA || raw.some((v) => typeof v !== "string" || !v.trim() || v.length > 200)) {
    throw invalid(`evidenceHelpsCriterionIds must be a list of at most ${MAX_EVIDENCE_HELPS_CRITERIA} criterion ids`);
  }
  return [...new Set((raw as string[]).map((v) => v.trim()))];
}

/**
 * Validate a list of criterion ids to exclude (#161): strings, no blanks, no
 * duplicates (a repeated id is a client bug, so it is refused rather than
 * merged), at most MAX_EXCLUDED_CRITERIA. Whether each id is a criterion of
 * the version, and whether it is a mandatory bar, is checked against the
 * version itself (`checkExclusionIds`). Used for the approve body, the
 * preview query and the preview body.
 * @throws RubricReviewError (400 VALIDATION_ERROR)
 */
export function parseExcludedIds(raw: unknown, field: string): string[] {
  if (!Array.isArray(raw) || raw.length > MAX_EXCLUDED_CRITERIA || raw.some((v) => typeof v !== "string" || !v.trim() || v.length > 300)) {
    throw invalid(`${field} must be a list of at most ${MAX_EXCLUDED_CRITERIA} criterion ids`);
  }
  const ids = (raw as string[]).map((v) => v.trim());
  if (new Set(ids).size !== ids.length) throw invalid(`${field} names a criterion more than once`);
  return ids;
}

/**
 * Refuse, with a 400, ids that are not criteria of `rubric` or that are
 * mandatory bars. The validator checks the same things on the stored result
 * (RUBRIC_INVALID); this gives the reviewer a precise message first.
 */
function checkExclusionIds(rubric: VisaRubric, ids: readonly string[]): void {
  const kinds = new Map((rubric.criteria ?? []).map((c) => [c.criterionId, c.kind]));
  const unknownIds = ids.filter((id) => !kinds.has(id));
  if (unknownIds.length > 0) throw invalid(`excludedCriterionIds names criteria this version does not have: ${unknownIds.slice(0, 20).join(", ")}`);
  const bars = ids.filter((id) => kinds.get(id) === "mandatory_bar");
  if (bars.length > 0) throw invalid(`mandatory_bar_excluded: a mandatory bar can never be excluded (${bars.join(", ")})`);
}

/**
 * Does excluding a criterion of a source with this stored registry entry need
 * the reviewer's explicit confirmation? Only `route_guidance` and `secondary`
 * sources do not. Everything else is treated as PRIMARY: a primary role, but
 * also a source that is missing, unreadable, or has no / an unknown role.
 * Fail closed: the cost of a wrong guess is one extra confirmation click.
 */
export function sourceNeedsExclusionConfirmation(source: { exists: boolean; role?: unknown }): boolean {
  if (!source.exists) return true;
  return source.role !== "route_guidance" && source.role !== "secondary";
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
  // (#161) True when excluding this criterion needs `confirmPrimaryExclusions`
  // (its source is a primary one, or its role cannot be established).
  primarySource: boolean;
  // (#161) True when the stored version already excludes this criterion.
  excluded: boolean;
}

/** An evidence item as the review API returns it, with its citation check. */
export interface ReviewEvidenceItem extends EvidenceItem {
  // True unless the item's quote was found in the current source text (also
  // true when the check could not be made: see `citationStatus`).
  staleCitation: boolean;
  citationStatus: CitationStatus;
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
  // (#233) Key parts: `authorityId` + `routeSlug` for any rulebook; the
  // country pair only for a country's own rulebook (absent on a shared layer).
  authorityId?: string;
  routeSlug?: string;
  countryCode?: string;
  visaTypeId?: string;
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
  // Each item carries the same citation check as a criterion.
  evidenceItems: ReviewEvidenceItem[];
  outcomeStatistics: VisaRubric["outcomeStatistics"] | null;
  // Admin-set (#116): criteria for which extra evidence helps; null when unset.
  evidenceHelpsCriterionIds: string[] | null;
  // Admin-set at approval (#161): what the stored version excludes (null when
  // nothing was) and the reviewer's note. The lists above are always the FULL
  // extraction: the reviewer sees everything, exclusions are only marked.
  excludedCriterionIds: string[] | null;
  exclusionNote: string | null;
  // (#203) The automatic approval's question plan, null when there is none.
  // The lists above stay the FULL, unfiltered draft; the plan is shown beside them.
  questionPlan: VisaRubric["questionPlan"] | null;
  // What the PROPOSED exclusion set (query `previewExcluded`) would remove,
  // or what the stored one did remove; null when there is nothing to count.
  exclusionPreview: ExclusionPreview | null;
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
    // The admin-set fields against the serving version (see RubricDiff).
    adminSet: RubricDiff["adminSet"];
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
  // (#233) Key parts: `authorityId` + `routeSlug` for any rulebook; the
  // country pair only for a country's own rulebook (absent on a shared layer).
  authorityId?: string;
  routeSlug?: string;
  countryCode?: string;
  visaTypeId?: string;
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
  // uid of the admin who decided, or RUBRIC_SYSTEM_ACTOR_ID (#201).
  by: string;
  // (#201) Present and true ONLY on a decision by the automatic publisher;
  // absent on an admin's, so an admin entry is unchanged in shape.
  automatic?: boolean;
  // (#201) The run record (`rubricPublishRuns/{routeKey}__v{version}`) behind an automatic decision.
  publishRunId?: string;
  action: "approve" | "reject";
  routeKey: string;
  // (#233) Key parts: `authorityId` + `routeSlug` for any rulebook; the
  // country pair only for a country's own rulebook (absent on a shared layer).
  authorityId?: string;
  routeSlug?: string;
  countryCode?: string;
  visaTypeId?: string;
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
  // Approve only: the admin-set fields written with the approval (null when
  // the request did not send them).
  outcomeStatistics?: OutcomeStatisticsMapping | null;
  evidenceHelpsCriterionIds?: string[] | null;
  // Approve only (#161): the exclusions written with the approval. Null when
  // none were sent. `exclusionCount` is the length of the list.
  excludedCriterionIds?: string[] | null;
  exclusionNote?: string | null;
  exclusionCount?: number;
  // Approve only (#161): the primary-source criteria excluded under an explicit
  // confirmation (empty when none, or none from a primary source).
  confirmedPrimaryExclusions?: string[];
  // (#223) Protected rules replaced by their one automatic re-draft with this approval (the replacements are on the version as `ruleRepairs`).
  repairedCriterionIds?: string[];
  // (#244) Originals that a repaired ordinary rule also stands for (several items of one definition that came back
  // as the same rule): left out as covered, listed so the audit says which rule replaced which.
  coveredCriterionIds?: string[];
  // (#248) Bars this approval serves WITHOUT their trigger (the independent check confirmed the rule but not
  // its trigger): each named with the fixed note that it is assessed by judgement, never decided by code.
  // Derived from the approved review fields by the same function the read side uses. Absent when none.
  barsJudgedWithoutTrigger?: { criterionId: string; title: string; note: string }[];
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
  // (#233) Key parts: `authorityId` + `routeSlug` for any rulebook; the
  // country pair only for a country's own rulebook (absent on a shared layer).
  authorityId?: string;
  routeSlug?: string;
  countryCode?: string;
  visaTypeId?: string;
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
export function reviewFieldsUpdate(fields: Partial<Pick<VisaRubric, (typeof RUBRIC_REVIEW_FIELDS)[number]>>): UpdateData<DocumentData> {
  const allowed: readonly string[] = RUBRIC_REVIEW_FIELDS;
  const update: UpdateData<DocumentData> = {};
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
    // (#222) The list lines of a lead-in quote travel with the citation.
    ...(c.listItems !== undefined ? { listItems: [...c.listItems] } : {}),
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
    // Scope (#112), returned so the review screen can filter by it (#161).
    ...(c.applicability !== undefined ? { applicability: c.applicability } : {}),
    ...(c.applicabilityCondition !== undefined ? { applicabilityCondition: c.applicabilityCondition } : {}),
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
    // (#233) The rulebook's naming pair: the country pair for a country (as before), authorityId + routeSlug for a shared layer.
    ...namingOf(rubric),
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
  // Ids of the EligibilityQuestion docs that exist (the `eligibilityQuestions`
  // collection, the one `eligibility.service` reads). The validator needs them
  // to verify a criterion's `eligibilityQuestionId`; read only when a version
  // has such a criterion. Backend use only.
  eligibilityQuestionIds: () => Promise<ReadonlySet<string>>;
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
  // One finding per evidence item, in the stored order (an item's `key` is
  // not guaranteed unique in a malformed version, so it is not the map key).
  evidence: CitationFinding[];
  // The polarity proposal's own quote, when it has one.
  proposal: CitationFinding | null;
  // sourceId -> the `latestSnapshotId` the check was made against (null when
  // the source has none or does not exist). Re-read inside the decision's
  // transaction: a source that moved in between aborts the approval.
  sourceHeads: Map<string, string | null>;
  // sourceId -> whether excluding its criteria needs confirmation (#161); see
  // `sourceNeedsExclusionConfirmation`. A source that could not be read is true.
  sourceNeedsConfirmation: Map<string, boolean>;
}

/** The admin-set fields an approve body carries (only those that were sent). */
function adminSetOf(input: RubricDecisionInput): Pick<VisaRubric, "outcomeStatistics" | "evidenceHelpsCriterionIds" | "excludedCriterionIds" | "exclusionNote"> {
  if (input.action !== "approve") return {};
  return {
    // An empty list is a decision of "exclude nothing": not stored at all.
    ...(input.excludedCriterionIds && input.excludedCriterionIds.length > 0 ? { excludedCriterionIds: input.excludedCriterionIds } : {}),
    ...(input.excludedCriterionIds && input.excludedCriterionIds.length > 0 && input.exclusionNote ? { exclusionNote: input.exclusionNote } : {}),
    ...(input.outcomeStatistics ? { outcomeStatistics: input.outcomeStatistics } : {}),
    ...(input.evidenceHelpsCriterionIds ? { evidenceHelpsCriterionIds: input.evidenceHelpsCriterionIds } : {}),
  };
}

/**
 * What a citation check refuses an approval for: quotes that are no longer in
 * the current source text (stale) and quotes that could not be checked
 * (unverifiable), over EVERY quote the version cites: criteria, evidence
 * items and the polarity proposal. Empty when all are current. Used by the
 * detail (`approval.blockers`) and by `decide`, so the two agree.
 */
function citationBlockers(citations: CitationCheck): ApprovalBlocker[] {
  const groups: { label: string; findings: CitationFinding[] }[] = [
    { label: "criterion quote(s)", findings: [...citations.byCriterion.values()] },
    { label: "evidence item quote(s)", findings: citations.evidence },
    { label: "intent polarity proposal quote(s)", findings: citations.proposal ? [citations.proposal] : [] },
  ];
  const count = (status: CitationStatus) =>
    groups.map((g) => ({ label: g.label, n: g.findings.filter((f) => f.status === status).length })).filter((g) => g.n > 0);
  const out: ApprovalBlocker[] = [];
  const stale = count("stale");
  if (stale.length > 0) {
    out.push({ code: "STALE_CITATION", message: `${stale.map((g) => `${g.n} ${g.label}`).join(", ")} no longer in the current source text. Re-extract the rubric instead of approving this version.` });
  }
  const unverifiable = count("unverifiable");
  if (unverifiable.length > 0) {
    out.push({ code: "CITATION_UNVERIFIABLE", message: `${unverifiable.map((g) => `${g.n} ${g.label}`).join(", ")} could not be checked against the current source text (source or snapshot unreadable).` });
  }
  return out;
}

/**
 * The structural validator's errors for the rubric as it would be approved
 * with `polarity`. Shared by the detail (so `canApprove` is false exactly
 * when `decide` would answer RUBRIC_INVALID) and by `decide`.
 */
export function structuralErrors(
  rubric: VisaRubric,
  polarity: IntentPolarity,
  knownEligibilityQuestionIds: ReadonlySet<string> | undefined,
  adminSet: Partial<Pick<VisaRubric, (typeof RUBRIC_REVIEW_FIELDS)[number]>> = {}
): RubricIssue[] {
  // The admin-set fields of the request, as they would be stored.
  // The validator refuses an "approved" rubric with no reviewer (it is how the
  // engine attributes a decision). `decide` passes the real reviewer in `rubric`;
  // the read-only preview (`canApprove` / blockers on the review detail) validates
  // a still-pending version, whose reviewedBy / reviewedAt are null, so without a
  // stand-in EVERY pending version reported RUBRIC_INVALID and could never be
  // approved from the UI. The stand-in only satisfies that one check: it is never stored.
  const candidate: VisaRubric = applyRuleRepairs({
    ...rubric,
    ...adminSet,
    reviewStatus: "approved",
    intentPolarity: polarity,
    reviewedBy: rubric.reviewedBy ?? "preview",
    reviewedAt: rubric.reviewedAt ?? Timestamp.now(),
  });
  // (#223) `applyRuleRepairs` swaps in any recorded replacement of a repaired protected rule, so the
  // validator judges the rulebook exactly as it will be served (the replacement, not the original).
  return validateVisaRubric(candidate, { knownEligibilityQuestionIds }).errors;
}

/**
 * What only the automatic publisher may pass to `decideAs` (issue #201).
 */
export interface SystemDecisionExtras {
  // `rubricPublishRuns/{routeKey}__v{version}`: written to the audit entry.
  publishRunId?: string;
  // Review fields the question planner (part C, #203) adds to the version
  // (e.g. `questionPlan`). Only keys in PLANNER_WRITABLE_FIELDS are accepted.
  extraReviewFields?: Record<string, unknown>;
}

/**
 * The review fields the question planner may set on a version through the
 * automatic path: only `"questionPlan"` (#203; it is also in
 * RUBRIC_REVIEW_FIELDS, and the validator checks its shape). Everything
 * else a decision writes (status, polarity, reviewer, exclusions, ...) is set
 * by this file only and can never come from a caller.
 */
// (#223) `ruleRepairs`: the replacements of protected rules the automatic check re-drafted once and confirmed.
export const PLANNER_WRITABLE_FIELDS: readonly string[] = ["questionPlan", "ruleRepairs"];

/** Validate the planner's fields against the allow-list; a key outside it throws (never silently dropped). */
function plannerReviewFields(raw: Record<string, unknown> | undefined): Partial<Pick<VisaRubric, (typeof RUBRIC_REVIEW_FIELDS)[number]>> {
  if (!raw) return {};
  for (const key of Object.keys(raw)) {
    if (!PLANNER_WRITABLE_FIELDS.includes(key)) throw new Error(`rubric review: the planner may not write "${key}" on a version`);
  }
  return raw as Partial<Pick<VisaRubric, (typeof RUBRIC_REVIEW_FIELDS)[number]>>;
}

export class RubricReviewService {
  // Transaction runner; a property so tests can swap in an in-memory one.
  runTransaction: <T>(fn: (tx: Transaction) => Promise<T>) => Promise<T> = (fn) => db.runTransaction(fn);

  /** Listeners called after an approval commits (the #37 seam). */
  private readonly approvalListeners: RubricApprovedListener[] = [];

  private readonly deps: RubricReviewDeps;

  constructor(deps: Partial<RubricReviewDeps> = {}) {
    this.deps = {
      snapshots: guidanceSnapshotStore,
      now: () => Timestamp.now(),
      // Ids only (`select()` with no fields): no question text is read.
      eligibilityQuestionIds: async () => new Set((await db.collection("eligibilityQuestions").select().get()).docs.map((d) => d.id)),
      ...deps,
    };
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
    const evidenceItems = Array.isArray(rubric.evidenceItems) ? rubric.evidenceItems : [];
    const proposalSource = rubric.intentPolarityProposal?.source ?? null;
    // Every quote the version cites: criteria, evidence items (cited
    // requirements shown to applicants) and the polarity proposal.
    const sourceIds = [
      ...new Set(
        [...criteria.map((c) => c.source?.sourceId), ...evidenceItems.map((e) => e?.source?.sourceId), proposalSource?.sourceId].filter(
          (id): id is string => typeof id === "string" && id.length > 0
        )
      ),
    ];

    // ---- where each source stands now ----
    const sourceHeads = new Map<string, string | null>();
    const sourceNeedsConfirmation = new Map<string, boolean>();
    await Promise.all(
      sourceIds.map(async (sourceId) => {
        let latest: string | null = null;
        // Unreadable = unknown role = treated as primary (fail closed).
        let needsConfirmation = true;
        try {
          const snap = await collections.guidanceSources.doc(sourceId).get();
          const data = snap.exists ? (snap.data() as { latestSnapshotId?: unknown; role?: unknown }) : null;
          const id = data ? data.latestSnapshotId : null;
          latest = typeof id === "string" && id ? id : null;
          needsConfirmation = sourceNeedsExclusionConfirmation({ exists: snap.exists, role: data?.role });
        } catch (err) {
          console.error(`Rubric review: guidance source ${sourceId} unreadable (${errorClass(err)})`);
        }
        sourceHeads.set(sourceId, latest);
        sourceNeedsConfirmation.set(sourceId, needsConfirmation);
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
            // The source id and an error class/code only: the message of a
            // storage error carries the object path, so it is never logged.
            console.error(`Rubric review: a snapshot of ${sourceId} is unreadable (${errorClass(err)})`);
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
    const evidence = await Promise.all(evidenceItems.map((e) => inspect(e?.source)));
    return { byCriterion, evidence, proposal: proposalSource ? await inspect(proposalSource) : null, sourceHeads, sourceNeedsConfirmation };
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
  async getVersion(id: string, opts: { previewExcluded?: string[] } = {}): Promise<RubricVersionDetail | null> {
    const parsed = parseRubricVersionId(id);
    if (!parsed) return null;
    const rubric = await rubricStore.getVersionForReview(parsed.routeKey, parsed.version);
    if (!rubric) return null;
    // A stored document that is not a rubric (no criteria list) is a clean,
    // typed refusal, not a crash further down.
    if (!Array.isArray(rubric.criteria)) throw malformed();

    const [head, citations] = await Promise.all([rubricStore.getHead(parsed.routeKey), this.checkCitations(rubric)]);
    const baseline = await this.loadBaseline(rubric, head);

    const evidenceItems = Array.isArray(rubric.evidenceItems) ? rubric.evidenceItems : [];
    // ---- criteria with their citation status ----
    const storedExcluded = new Set(rubric.excludedCriterionIds ?? []);
    const criteria: ReviewCriterion[] = rubric.criteria.map((c) => {
      const finding = citations.byCriterion.get(c.criterionId) ?? { status: "unverifiable" as const, context: null };
      return {
        ...toCriterion(c),
        staleCitation: finding.status !== "current",
        citationStatus: finding.status,
        quoteContext: finding.context,
        // (#161) Unknown source = primary: the fail-closed default of the check.
        primarySource: citations.sourceNeedsConfirmation.get(c.source?.sourceId) ?? true,
        excluded: storedExcluded.has(c.criterionId),
      };
    });

    // ---- exclusion preview (#161) ----
    // A proposed set (validated like the approve body) is counted with the
    // very function that will apply it; with none proposed, a decided
    // version's stored set is what is counted.
    if (opts.previewExcluded) checkExclusionIds(rubric, opts.previewExcluded);
    const previewIds = opts.previewExcluded ?? rubric.excludedCriterionIds ?? null;
    const exclusionPreview = previewIds && previewIds.length > 0 ? previewExclusions(rubric, previewIds) : null;

    // ---- diff (serialised criteria: the same whitelist as above) ----
    // With a proposed exclusion set the diff shows it as `after`.
    const raw = diffRubricVersions(opts.previewExcluded ? { ...rubric, excludedCriterionIds: opts.previewExcluded } : rubric, baseline);
    const diff: RubricVersionDetail["diff"] = {
      baselineVersion: raw.baselineVersion,
      allNew: raw.allNew,
      added: raw.added.map(toCriterion),
      removed: raw.removed.map(toCriterion),
      changed: raw.changed.map((c) => ({ ...c, before: toCriterion(c.before) })),
      unchangedCount: raw.unchangedCount,
      intentPolarityChanged: raw.intentPolarity.proposalChanged,
      intentPolarity: raw.intentPolarity,
      adminSet: raw.adminSet,
      summary: { added: raw.added.length, removed: raw.removed.length, changed: raw.changed.length, unchanged: raw.unchangedCount },
    };

    // ---- flags and approval readiness ----
    // Before a decision the validator falls back to the proposal; after one,
    // the decision is what the flags are computed from.
    const flags = reviewFlagsFor(rubric, rubric.intentPolarity);
    const intentCriteriaCount = rubric.criteria.filter((c) => c.concernsIntent === true).length;
    // The structural validator's verdict, so `canApprove` agrees with `decide`.
    // (The polarity only has to be a valid placeholder here: no validator
    // error depends on which one.)
    const structure = structuralErrors(rubric, rubric.intentPolarity ?? rubric.intentPolarityProposal?.value ?? "not_assessed", await this.knownEligibilityIds(rubric));
    const blockers = this.approvalBlockers(rubric, head, citations, structure);
    const discardedByReason: Record<string, number> = {};
    for (const d of rubric.discarded ?? []) discardedByReason[d.reason] = (discardedByReason[d.reason] ?? 0) + 1;

    const item = toListItem(rubric, head);
    return {
      id: item.id,
      routeKey: item.routeKey,
      ...namingOf(item),
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
      evidenceItems: evidenceItems.map((e, i) => {
        const finding = citations.evidence[i] ?? { status: "unverifiable" as const, context: null };
        return { ...e, source: toCitation(e.source), staleCitation: finding.status !== "current", citationStatus: finding.status, quoteContext: finding.context };
      }),
      outcomeStatistics: rubric.outcomeStatistics ?? null,
      evidenceHelpsCriterionIds: rubric.evidenceHelpsCriterionIds ?? null,
      excludedCriterionIds: rubric.excludedCriterionIds ?? null,
      exclusionNote: rubric.exclusionNote ?? null,
      questionPlan: rubric.questionPlan ?? null,
      exclusionPreview,
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
   * The ids of the eligibility questions, for the validator's check of a
   * criterion's `eligibilityQuestionId`. Read only when a criterion links one
   * (undefined otherwise). If they cannot be read, undefined too: the
   * validator then reports the link as unverified and the approval is
   * refused (fail closed). Storage-independent, so `decide` calls it BEFORE
   * its transaction and passes the result in.
   */
  async knownEligibilityIds(rubric: VisaRubric): Promise<ReadonlySet<string> | undefined> {
    const criteria = Array.isArray(rubric.criteria) ? rubric.criteria : [];
    if (!criteria.some((c) => c?.eligibilityQuestionId !== undefined)) return undefined;
    try {
      return await this.deps.eligibilityQuestionIds();
    } catch (err) {
      console.error(`Rubric review: eligibility question ids unreadable (${errorClass(err)})`);
      return undefined;
    }
  }

  /**
   * What refuses an approval outright, as far as it can be told without the
   * request (state, position in the route, citations). The same checks run
   * again, authoritatively, inside `decide`.
   */
  private approvalBlockers(rubric: VisaRubric, head: RubricHead | null, citations: CitationCheck, structure: RubricIssue[]): ApprovalBlocker[] {
    const blockers: ApprovalBlocker[] = [];
    if (rubric.reviewStatus !== "pending_review") {
      blockers.push({ code: "ALREADY_DECIDED", message: `This version is already ${rubric.reviewStatus}.` });
    }
    if (!head || head.latestVersion !== rubric.version) {
      blockers.push({ code: "NOT_LATEST_VERSION", message: "A newer version of this route's rubric exists. Review that one; this one can only be rejected." });
    }
    blockers.push(...citationBlockers(citations));
    if (structure.length > 0) {
      const codes = [...new Set(structure.map((e) => e.code))].join(", ");
      blockers.push({ code: "RUBRIC_INVALID", message: `This rubric version is not internally consistent (${codes}). Reject it and re-extract.` });
    }
    return blockers;
  }

  // ---------- Exclusion preview (#161) ----------

  /**
   * What excluding `ids` would remove from a version, without writing
   * anything (the POST route, for lists too long for a query string). Same
   * validation as the approve body, same counting function as the detail.
   * `primaryExclusionIds` are the proposed criteria whose source is primary
   * (or unknown): excluding them needs `confirmPrimaryExclusions` on approve.
   * Null when the id names no version.
   */
  async previewExclusion(id: string, ids: string[]): Promise<{ exclusionPreview: ExclusionPreview; primaryExclusionIds: string[] } | null> {
    const parsed = parseRubricVersionId(id);
    if (!parsed) return null;
    const rubric = await rubricStore.getVersionForReview(parsed.routeKey, parsed.version);
    if (!rubric) return null;
    if (!Array.isArray(rubric.criteria)) throw malformed();
    checkExclusionIds(rubric, ids);
    const needs = await this.sourcesNeedingConfirmation(rubric);
    const chosen = new Set(ids);
    return {
      exclusionPreview: previewExclusions(rubric, ids),
      primaryExclusionIds: rubric.criteria.filter((c) => chosen.has(c.criterionId) && (needs.get(c.source?.sourceId) ?? true)).map((c) => c.criterionId),
    };
  }

  /** sourceId -> needs confirmation, for the sources a version's criteria cite (a lighter read than the citation check). */
  private async sourcesNeedingConfirmation(rubric: VisaRubric): Promise<Map<string, boolean>> {
    const out = new Map<string, boolean>();
    const sourceIds = [...new Set(rubric.criteria.map((c) => c.source?.sourceId).filter((x): x is string => typeof x === "string" && x.length > 0))];
    await Promise.all(
      sourceIds.map(async (sourceId) => {
        let needs = true;
        try {
          const snap = await collections.guidanceSources.doc(sourceId).get();
          needs = sourceNeedsExclusionConfirmation({ exists: snap.exists, role: snap.exists ? (snap.data() as { role?: unknown }).role : undefined });
        } catch (err) {
          console.error(`Rubric review: guidance source ${sourceId} unreadable (${errorClass(err)})`);
        }
        out.set(sourceId, needs);
      })
    );
    return out;
  }

  // ---------- Decide ----------

  /**
   * Approve or reject a whole version as an ADMIN. See the file header for the
   * rules. A thin wrapper over `decideAs`, so the admin path and the automatic
   * path share one implementation.
   *
   * @param id          API id of the version (`{routeKey}__v{version}`)
   * @param input       a parsed decision (`parseRubricDecision`)
   * @param reviewerUid uid of the admin deciding (from the verified token)
   * @throws RubricReviewError with the HTTP status to send; nothing is
   *   written when it throws.
   */
  async decide(id: string, input: RubricDecisionInput, reviewerUid: string): Promise<RubricDecisionResult> {
    return this.decideAs(id, input, { kind: RUBRIC_ACTOR_KIND.ADMIN, uid: reviewerUid });
  }

  /**
   * The ONE decision implementation (issue #201). `decide` calls it with an
   * admin; the automatic publisher calls it with the system actor and the
   * `extras` below. Same transaction, same validator, same error codes.
   *
   * @param extras only for the system actor: the run record's id (written to
   *   the audit entry), and review fields the question planner (part C) adds to
   *   the version. The planner's fields are limited to `PLANNER_WRITABLE_FIELDS`
   *   (empty today) and still go through `reviewFieldsUpdate`.
   */
  async decideAs(id: string, input: RubricDecisionInput, actor: RubricReviewActor, extras: SystemDecisionExtras = {}): Promise<RubricDecisionResult> {
    const parsed = parseRubricVersionId(id);
    if (!parsed) throw notFound();
    // The id written as `reviewedBy` / audit `by`.
    const reviewerUid = actor.kind === RUBRIC_ACTOR_KIND.ADMIN ? actor.uid : actor.id;
    if (!reviewerUid) throw new Error("rubric review: a decision needs the reviewer's uid");
    // A person can never act as the system: refuse its id as an admin uid.
    if (actor.kind === RUBRIC_ACTOR_KIND.ADMIN && actor.uid === RUBRIC_SYSTEM_ACTOR_ID) throw new Error("rubric review: that uid is reserved for the automatic publisher");
    if (actor.kind === RUBRIC_ACTOR_KIND.SYSTEM && actor.id !== RUBRIC_SYSTEM_ACTOR_ID) throw new Error("rubric review: unknown system actor");
    if (actor.kind !== RUBRIC_ACTOR_KIND.SYSTEM && (extras.publishRunId !== undefined || extras.extraReviewFields !== undefined)) throw new Error("rubric review: automatic-publish extras need the system actor");
    const { routeKey, version } = parsed;
    // (#201) What an automatic decision adds to its audit entry.
    const automaticMarks = actor.kind === RUBRIC_ACTOR_KIND.SYSTEM ? { automatic: true as const, ...(extras.publishRunId ? { publishRunId: extras.publishRunId } : {}) } : {};
    // (#201) Review fields the planner adds (system only); validated by reviewFieldsUpdate and the allow-list.
    const plannerFields = actor.kind === RUBRIC_ACTOR_KIND.SYSTEM ? plannerReviewFields(extras.extraReviewFields) : {};

    // ---- Before the transaction: the stale-citation check (Storage reads
    // cannot run inside a Firestore transaction). Approve only. The version
    // content it reads is immutable, and the sources it was made against are
    // re-read inside the transaction below.
    let citations: CitationCheck | null = null;
    let knownEligibilityIds: ReadonlySet<string> | undefined;
    if (input.action === "approve") {
      const preview = await rubricStore.getVersionForReview(routeKey, version);
      if (!preview) throw notFound();
      // Cheap early answers; both are checked again inside the transaction.
      if (preview.reviewStatus !== "pending_review") throw conflict("ALREADY_DECIDED", `This rubric version is already ${preview.reviewStatus}`);
      citations = await this.checkCitations(preview);
      // Stale or unverifiable quotes anywhere (criteria, evidence items, the
      // polarity proposal) refuse the approval. The quotes are immutable
      // content; the sources they were checked against are re-read inside
      // the transaction (SOURCE_CHANGED), which covers all three kinds.
      const refused = citationBlockers(citations);
      const stale = refused.find((b) => b.code === "STALE_CITATION");
      if (stale) throw conflict("STALE_CITATION", `${stale.message} The source has moved on.`);
      const unverifiable = refused.find((b) => b.code === "CITATION_UNVERIFIABLE");
      if (unverifiable) throw conflict("CITATION_UNVERIFIABLE", `${unverifiable.message} Nothing was approved; try again or re-extract.`);
      // The question ids the structural check needs: read here, outside
      // the transaction (the version content is immutable, so the answer
      // holds for the copy read inside).
      knownEligibilityIds = await this.knownEligibilityIds(preview);
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
        ...automaticMarks,
        routeKey,
        // (#233) The rulebook's naming pair: the country pair for a country (as before), authorityId + routeSlug for a shared layer.
        ...namingOf(rubric),
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
        // (#233) The rulebook's naming pair: the country pair for a country (as before), authorityId + routeSlug for a shared layer.
        ...namingOf(rubric),
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
      // The same reads give the role of each source (#161), read INSIDE the
      // transaction so the confirmation rule uses what is stored now.
      const needsConfirmation = new Map<string, boolean>();
      for (const [sourceId, checkedAgainst] of (citations as CitationCheck).sourceHeads) {
        const snap = await tx.get(collections.guidanceSources.doc(sourceId));
        const latest = snap.exists ? (snap.data() as { latestSnapshotId?: unknown }).latestSnapshotId : null;
        needsConfirmation.set(sourceId, sourceNeedsExclusionConfirmation({ exists: snap.exists, role: snap.exists ? (snap.data() as { role?: unknown }).role : undefined }));
        if ((typeof latest === "string" && latest ? latest : null) !== checkedAgainst) {
          throw conflict("SOURCE_CHANGED", "A guidance source changed while this approval was being checked. Nothing was approved; reload the version and review again.");
        }
      }

      // ---- admin-set tags must name this version's own criteria (clean 400
      //      before the structural check, which would also refuse them) ----
      if (input.evidenceHelpsCriterionIds) {
        const own = new Set((rubric.criteria ?? []).map((c) => c.criterionId));
        const unknownIds = input.evidenceHelpsCriterionIds.filter((cid) => !own.has(cid));
        if (unknownIds.length > 0) throw invalid(`evidenceHelpsCriterionIds names criteria this version does not have: ${unknownIds.join(", ")}`);
      }

      // ---- exclusions (#161): ids valid, then primary ones confirmed ----
      // Both before any write. A bad id is a 400; an unconfirmed primary
      // exclusion is a 409 that lists the ids so the client can ask.
      let confirmedPrimary: string[] = [];
      if (input.excludedCriterionIds && input.excludedCriterionIds.length > 0) {
        checkExclusionIds(rubric, input.excludedCriterionIds);
        const chosen = new Set(input.excludedCriterionIds);
        // A criterion whose source is not in the transaction's reads cannot
        // have its role established: treated as primary.
        const primaryIds = rubric.criteria.filter((c) => chosen.has(c.criterionId) && (needsConfirmation.get(c.source?.sourceId) ?? true)).map((c) => c.criterionId);
        if (primaryIds.length > 0 && input.confirmPrimaryExclusions !== true) {
          throw conflict(
            "PRIMARY_EXCLUSION_UNCONFIRMED",
            `${primaryIds.length} of the criteria you excluded come from the route's primary source (or a source whose role is not known). Confirm with confirmPrimaryExclusions: true to exclude them. Criteria: ${primaryIds.join(", ")}`
          );
        }
        confirmedPrimary = primaryIds;
      }

      // ---- the rubric exactly as it would be approved ----
      const errors = structuralErrors({ ...rubric, reviewedBy: reviewerUid, reviewedAt: now, rejectReason: null, revision: revisionAfter }, input.intentPolarity, knownEligibilityIds, { ...adminSetOf(input), ...plannerFields });
      if (errors.length > 0) {
        const codes = [...new Set(errors.map((e) => e.code))].join(", ");
        throw conflict("RUBRIC_INVALID", `This rubric version is not internally consistent and cannot be approved (${codes}). Reject it and re-extract.`);
      }

      // ---- blocking flags: each one acknowledged by name ----
      // The flags the version has under the DECISION are the ones that must
      // be acknowledged. But the admin read the flags `getVersion` returned,
      // computed under the PROPOSAL: a key from either set is accepted (a key
      // the decision resolves is simply not recorded as acknowledged), and
      // only a key that belongs to neither is refused.
      // (#223) The flags of the rulebook AS IT WILL BE SERVED: a repaired protected rule is judged as its replacement.
      const served = applyRuleRepairs({ ...rubric, ...plannerFields } as VisaRubric);
      const flags = reviewFlagsFor(served, input.intentPolarity);
      const proposedFlags = reviewFlagsFor(served, null);
      const blocking = flags.filter((f) => f.blocking);
      const unknownKeys = input.acknowledgedFlags.filter((k) => !flags.some((f) => f.key === k) && !proposedFlags.some((f) => f.key === k));
      if (unknownKeys.length > 0) throw invalid(`acknowledgedFlags names flag(s) this version does not have: ${unknownKeys.join(", ")}`);
      const missing = blocking.filter((f) => !input.acknowledgedFlags.includes(f.key));
      if (missing.length > 0) {
        throw conflict("FLAGS_NOT_ACKNOWLEDGED", `This version has flag(s) you must read and acknowledge before approving: ${missing.map((f) => f.key).join(", ")}. Send them in acknowledgedFlags.`);
      }
      const acknowledged = flags.filter((f) => input.acknowledgedFlags.includes(f.key)).map((f) => ({ key: f.key, code: f.code, target: f.target, message: f.message }));

      // ======== WRITES ========
      // 1. The version: review fields only.
      //    The admin-set fields go in the same write, only when sent.
      tx.update(versionRef, reviewFieldsUpdate({ reviewStatus: "approved", intentPolarity: input.intentPolarity, reviewedBy: reviewerUid, reviewedAt: now, rejectReason: null, revision: revisionAfter, ...adminSetOf(input), ...plannerFields }));
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
      // (#248) The bars served without their trigger, from the version as approved (with the plan and repairs).
      const titleOfServed = new Map(served.criteria.map((c) => [c.criterionId, c.title]));
      const judgedBars = barsServedWithoutTrigger({ ...rubric, ...plannerFields } as VisaRubric).map((id) => ({ criterionId: id, title: titleOfServed.get(id) ?? id, note: JUDGED_BAR_NOTE }));
      const audit: RubricReviewAuditEntry = {
        ...auditBase,
        action: "approve",
        reason: input.reason,
        intentPolarity: input.intentPolarity,
        intentPolarityProposal: proposal,
        intentPolarityOverridden: proposal !== input.intentPolarity,
        acknowledgedFlags: acknowledged,
        outcomeStatistics: input.outcomeStatistics ?? null,
        evidenceHelpsCriterionIds: input.evidenceHelpsCriterionIds ?? null,
        // (#161) What was excluded, why, and how many; null when nothing was.
        excludedCriterionIds: input.excludedCriterionIds && input.excludedCriterionIds.length > 0 ? input.excludedCriterionIds : null,
        exclusionNote: input.exclusionNote ?? null,
        exclusionCount: input.excludedCriterionIds?.length ?? 0,
        confirmedPrimaryExclusions: confirmedPrimary,
        // (#223) Protected rules swapped for their automatic re-draft with this approval (empty when none).
        ...(plannerFields.ruleRepairs && plannerFields.ruleRepairs.length > 0 ? { repairedCriterionIds: plannerFields.ruleRepairs.map((r) => r.criterionId) } : {}),
        ...(plannerFields.ruleRepairs && plannerFields.ruleRepairs.some((r) => (r.alsoReplaced ?? []).length > 0) ? { coveredCriterionIds: plannerFields.ruleRepairs.flatMap((r) => r.alsoReplaced ?? []) } : {}),
        // (#248) Bars served without their unconfirmed trigger (judged, never code-decided), by title (data).
        ...(judgedBars.length > 0 ? { barsJudgedWithoutTrigger: judgedBars } : {}),
        approvedVersion: version,
      };
      tx.set(auditRef, audit as unknown as Record<string, unknown>);
      return { ...resultBase, action: "approve" as const, reviewStatus: "approved" as const, intentPolarity: input.intentPolarity, rejectReason: null, approvedVersion: version };
    });

    // ---- After the commit: tell whoever re-assesses (#37). Never throws. ----
    if (result.action === "approve") {
      await this.emitApproved({
        routeKey: result.routeKey,
        ...namingOf(result),
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
