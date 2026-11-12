import type { Timestamp } from "firebase-admin/firestore";

// ============================================
// RULE-CHANGE ALERTS — STORED RECORDS (issue #123)
// ============================================
//
// Two backend-only collections (no firestore.rules match, so every client is
// denied; admins and the system reach them only through the Admin SDK):
//
//   ruleChangeEvents/{eventId}          one APPROVED change to what applicants
//                                       are held to: either a rubric version an
//                                       admin approved (#41/#125) or a visa-record
//                                       edit an admin approved (#61). The id is
//                                       derived from the approval, so a re-delivered
//                                       trigger addresses the same document.
//   ruleChangeNotices/{eventId}__{appId} one claim per (event, application): the
//                                       dedupe key AND the record of who was told
//                                       what. Created with `create()` BEFORE any
//                                       message is sent, so a retry or a second
//                                       delivery finds it and sends nothing.
//
// An event only ever exists for an ADMIN-APPROVED change. A raw crawl diff or an
// unapproved extraction never writes one, so a noisy page edit cannot alert.
//
// Pure module: types, constants and id helpers only.

/** Where a change came from. */
export type RuleChangeSourceKind =
  // An admin approved a new rubric version (derived from guidance snapshots).
  | "guidance"
  // An admin approved a `pendingVisaChanges` row on a visa record.
  | "visa";

/** Lifecycle of an event. */
export const RULE_CHANGE_EVENT_STATUSES = ["pending", "processing", "completed", "skipped"] as const;
export type RuleChangeEventStatus = (typeof RULE_CHANGE_EVENT_STATUSES)[number];

/** One rule of a rubric diff, reduced to what a message needs. */
export interface RuleChangeCriterionLine {
  criterionId: string;
  // Short name of the rule.
  title: string;
  // The publisher's own reference (paragraph number), when it has one.
  ruleRef: string | null;
  // The published words, truncated. STAFF-SIDE ONLY: never put in an applicant message.
  quote: string;
  // The published document the quote is in.
  sourceUrl: string;
}

/** The rubric diff of an approval, stored compactly on the event. */
export interface RuleChangeRubricSummary {
  version: number;
  previousVersion: number;
  addedCount: number;
  removedCount: number;
  changedCount: number;
  // At most MAX_SUMMARY_LINES of each, in diff order. The counts are exact.
  added: RuleChangeCriterionLine[];
  removed: RuleChangeCriterionLine[];
  changed: RuleChangeCriterionLine[];
  // Distinct published URLs of every criterion that moved (at most MAX_SOURCE_URLS).
  sourceUrls: string[];
}

/** One changed field of a visa record, as the approved diff states it. */
export interface RuleChangeFieldLine {
  // The VisaType field name (or "fee").
  field: string;
  // "scalar": before/after are short printable values (fee lines, processing time,
  // validity). "text": prose (description, requirements): named, never quoted.
  valueKind: "scalar" | "text";
  // Printable old and new value, currency and unit as STORED (never converted).
  before: string | null;
  after: string | null;
}

/** `ruleChangeEvents/{eventId}`. */
export interface RuleChangeEvent {
  id: string;
  sourceKind: RuleChangeSourceKind;
  // The approval it came from: the `rubricReviewHistory` id (guidance) or the
  // `pendingVisaChanges` id (visa).
  sourceId: string;
  countryCode: string;
  visaTypeId: string;
  routeKey: string;
  status: RuleChangeEventStatus;
  // Why an event was recorded but sends nothing (first approval, empty diff, ...).
  skipReason: string | null;

  // ---- guidance only ----
  rubricVersion: number | null;
  previousRubricVersion: number | null;
  rubricSummary: RuleChangeRubricSummary | null;

  // ---- visa only ----
  fieldChanges: RuleChangeFieldLine[] | null;
  // The page the new values were read from.
  publishedSourceUrl: string | null;

  // Who approved it, and when. Shown to nobody but the admins.
  approvedBy: string;
  approvedAt: Timestamp;
  createdAt: Timestamp;
  updatedAt: Timestamp;

  // ---- scan progress (resumable) ----
  // Last application id the scan passed, or null at the start.
  cursor: string | null;
  scanDone: boolean;
  // Counters, written as the scan goes.
  scanned: number;
  skippedDrafts: number;
  skippedExcluded: number;
  alreadyHandled: number;
  // A staff notification was NOT sent because #37's reviewer notification already
  // told the same people the rules changed.
  coveredByReviewNotice: number;
  staffNotified: number;
  applicantNotified: number;
  // Best-effort deliveries that threw. They never stop the scan.
  deliveryFailures: number;
  completedAt: Timestamp | null;
}

/** What one application's notice came to. */
export type RuleChangeNoticeOutcome =
  // Claimed, not yet finished (a crash here leaves it; the claim is never re-sent).
  | "claimed"
  | "sent"
  // #37 already told the reviewer; only the activity note was written.
  | "covered_by_review_notice"
  // Nobody to tell (no eligible recipient or nothing a client may be told).
  | "no_recipient"
  | "failed";

/** `ruleChangeNotices/{eventId}__{applicationId}`. */
export interface RuleChangeNotice {
  id: string;
  eventId: string;
  applicationId: string;
  // The agency the case belongs to (null for self-service): every recipient was
  // derived from THIS application only, so a notice never crosses agencies.
  agencyId: string | null;
  outcome: RuleChangeNoticeOutcome;
  // Recipients actually handed to `notifyUser` (uids, never addresses).
  staffRecipientIds: string[];
  applicantNotified: boolean;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

/** Lines of each kind kept on an event's summary. */
export const MAX_SUMMARY_LINES = 10;
/** Longest quote kept on a summary line, in characters. */
export const MAX_QUOTE_CHARS = 300;
/** Most distinct source URLs kept on a summary. */
export const MAX_SOURCE_URLS = 5;

/** Replace anything a Firestore id or a key should not hold. */
function safeIdPart(part: string): string {
  return part.replace(/[^A-Za-z0-9_-]/g, "_");
}

/**
 * Event id of a rubric approval. Keyed on the ROUTE AND VERSION (not the audit
 * id), so the same version can never raise two events, whatever delivers it.
 */
export function guidanceEventId(routeKey: string, version: number): string {
  return `guidance_${safeIdPart(routeKey)}_v${version}`;
}

/** Event id of an approved visa-record change. */
export function visaEventId(changeId: string): string {
  return `visa_${safeIdPart(changeId)}`;
}

/** Dedupe key of one application under one event. */
export function ruleChangeNoticeId(eventId: string, applicationId: string): string {
  return `${eventId}__${applicationId}`;
}
