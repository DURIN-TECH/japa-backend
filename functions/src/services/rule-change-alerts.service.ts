import { FieldPath, Timestamp } from "firebase-admin/firestore";
import { collections } from "../utils/firebase";
import { applyExclusions, rubricStore } from "../scrapers";
import type { VisaRubric } from "../scrapers";
import type { VisaFieldDiff, FeeComponentDiff } from "../scrapers/types";
import type { Application } from "../types";
import type { ApplicationAssessment } from "../types/assessment";
import {
  MAX_QUOTE_CHARS,
  MAX_SOURCE_URLS,
  MAX_SUMMARY_LINES,
  guidanceEventId,
  layerEventId,
  ruleChangeNoticeId,
  visaEventId,
  type RuleChangeCriterionLine,
  type RuleChangeEvent,
  type RuleChangeFieldLine,
  type RuleChangeNotice,
  type RuleChangeRubricSummary,
} from "../types/rule-change";
import { EXCLUDED_APPLICATION_STATUSES } from "./ai-bulk-reassessment.service";
import { noteService } from "./note.service";
import { notificationService } from "./notification.service";
import { diffRubricVersions } from "./rubric-diff";
import type { RubricReviewAuditEntry } from "./rubric-review.service";
// (#233 P4b) The member routes and open applications of a shared layer (the service itself, not the module index).
import { sharedRouteService } from "../shared-routes/shared-route.service";
import type { SharedRoute } from "../types/shared-route";

// ============================================
// RULE-CHANGE ALERTS FOR IN-FLIGHT APPLICATIONS (issue #123)
// ============================================
//
// When an ADMIN approves a change to what an applicant is held to, the people on
// the affected in-flight applications are told what changed.
//
// ---- What counts as a change (and what never does) ----
//  - GUIDANCE: an admin approved a new rubric version (`rubricReviewHistory`,
//    action "approve"; #41/#125). The diff of that version against the one it
//    replaced (`diffRubricVersions`) is what is reported. The first approval of a
//    route, and an approval whose diff is empty, are recorded and send nothing.
//  - VISA RECORD: an admin approved a `pendingVisaChanges` row
//    (`approveChange`). The approved diff's fields, with old and new values as
//    stored, are what is reported.
//  A raw crawl diff, an unapproved extraction and an open or rejected proposal
//  never reach this file: the only entry points are the two approvals above.
//
// ---- Flow ----
//  1. RECORD. `recordRubricApproval` / `recordVisaChangeApproved` write ONE
//     `ruleChangeEvents/{id}` document with `create()` (id derived from the
//     approval), so a re-delivered trigger or a double approval records nothing
//     twice. Recording is cheap and never calls a model.
//  2. SWEEP. `runSweep` (index.ts, scheduled) picks up events and scans the
//     route's applications, resumably (`cursor`). A GUIDANCE event waits for the
//     #37 bulk re-assessment of the same approval to finish (or MAX_WAIT), so it
//     knows whether #37's reviewer notification already went out.
//  3. PER APPLICATION. Skip drafts and the #37 exclusion set (counted on the
//     event). Claim `ruleChangeNotices/{eventId}__{appId}` with `create()`; if
//     it exists the application was handled and nothing is sent. Then tell:
//
//     who is told                    rubric (guidance) change         visa-record change
//     ----------------------------   ------------------------------   ---------------------------
//     assigned agent                 criteria added/removed/changed   fields, old -> new, source
//       (else agency owner)          + source URL (detail; quotes     URL
//                                    only in the case's staff note)
//     applicant on an agent case     NOTHING                          published facts only (fee,
//                                                                     processing time, validity)
//                                                                     with the source URL
//     applicant, self-service        neutral "rules were updated      same published facts
//                                    on <date>" + source URL
//
//     The applicant is never told their readiness got worse, never gets a quote,
//     a criterion title, or any refusal / approval / likelihood wording, and never
//     gets the internal call or credibility output (a text guard refuses to send
//     anything that trips it). This keeps #37's policy: its reviewer notification
//     is the only place a worse result is mentioned, and it goes to staff.
//  4. NOT A DUPLICATE OF #37. If #37 already notified the reviewer for this
//     application under this approval (`reviewNotifiedAt` on its assessment), the
//     same people are NOT sent a second notification: the case note is still
//     written. (If #37's result lands only after this event was handled, the
//     reviewer gets #37's own notification as well: it carries different news,
//     the result got worse.)
//  5. RECORD. Each handled application gets an activity note on the case
//     (`noteService.addActivityNote`, staff-side) saying what was sent to whom,
//     and its notice document holds the outcome.
//
// ---- (#233 P4b) A SHARED layer's new version ----
// One event per affected MEMBER route (`recordLayerApproval`), keyed by the
// layer, the version and the member route (`layerEventId`). The summary is the
// shared layer's own diff; on the member route only applications whose stack
// includes the layer are told (`skippedOtherStack` counts the rest). The staff
// message says the shared rules changed and that the refresh waits for an
// admin's confirmation of the re-assessment (the bulk fan-out).
//
// ---- Re-assessment ----
// A rubric change re-assesses through #37's bulk path (the same approval starts
// it); nothing here assesses anything. A visa-record change touches no stored
// assessment input (`inputsFor` reads documents, statements, answers, intake and
// the rubric version), so it re-assesses nothing and only the notice is sent.
//
// ---- Safety ----
//  - Only a backend trigger and the scheduled sweep call this; there is no
//    client-facing endpoint.
//  - Every recipient is derived from the application's OWN `agentId`, `agencyId`
//    and `userId`, so an agent is only ever told about their own agency's cases.
//  - Delivery is best effort (`notifyUser` honours each user's preferences); one
//    failure is counted and the scan carries on.
//  - Generic: no country, route or nationality is named anywhere.
//  - Privacy: log lines carry ids and counts only, never a quote or a name.

// ============================================
// Constants
// ============================================

/** Applications read per page of the scan. */
const SCAN_PAGE = 100;
/** Time one sweep may use, under the function's 540 s timeout. */
const SWEEP_BUDGET_MS = 420_000;
/** Longest a guidance event waits for #37's run to finish before alerting anyway. */
export const MAX_WAIT_MS = 24 * 60 * 60 * 1000;
/** Events looked at per sweep. */
const EVENTS_PER_SWEEP = 20;
/** Firestore's "already exists" gRPC code. */
const ALREADY_EXISTS = 6;
/** Titles named in a staff notification body per kind before "+N more". */
const BODY_TITLES = 3;
/** Longest a printed field value is kept. */
const MAX_VALUE_CHARS = 120;
/** Longest a case note is. */
const MAX_NOTE_CHARS = 2_000;

/** VisaType fields whose old and new value are short facts a client may be shown. */
const CLIENT_SAFE_SCALAR_FIELDS = new Set([
  "processingTime",
  "processingDaysMin",
  "processingDaysMax",
  "validityPeriod",
  "isExtendable",
  "maxExtensions",
]);

/** Plain names for the fields a message names. */
const FIELD_LABELS: Record<string, string> = {
  fee: "Fee",
  processingTime: "Processing time",
  processingDaysMin: "Minimum processing days",
  processingDaysMax: "Maximum processing days",
  validityPeriod: "Validity",
  isExtendable: "Extendable",
  maxExtensions: "Maximum extensions",
  name: "Name",
  description: "Description",
  category: "Category",
  applicationUrl: "Application link",
  applicationInstructions: "Application instructions",
  eligibilityCriteria: "Requirements",
  requiredDocuments: "Required documents",
};

/**
 * Words that must never reach an applicant: any outcome, approval, refusal or
 * likelihood talk, and the internal call. A message that trips it is NOT sent.
 */
const NEUTRAL_FORBIDDEN = /refus|reject|approv|declin|denied|deny|likel|probab|chance|credib|eligib|fraud|suspic|risk/i;

// ============================================
// Dependencies (injected, so a test can swap them)
// ============================================

/** Everything the service reaches outside Firestore. */
export interface RuleChangeDeps {
  // Any version of a route's rubric (for the diff).
  getRubricVersion(routeKey: string, version: number): Promise<VisaRubric | null>;
  notify: typeof notificationService.notifyUser;
  addNote: typeof noteService.addActivityNote;
  now(): Date;
  // (#233 P4b) The member routes affected by a shared layer: every visa record
  // that inherits it today plus every route an open application on the layer
  // applied through. Optional so fakes written before P4b still type-check;
  // without it a shared approval records nothing.
  memberRoutesOfLayer?(route: Pick<SharedRoute, "id" | "issuingAuthorityId">): Promise<{ countryCode: string; visaTypeId: string }[]>;
}

/** (#233 P4b) The default member routes of a shared layer: records inheriting it, plus routes its open applications use. */
async function defaultMemberRoutesOfLayer(route: Pick<SharedRoute, "id" | "issuingAuthorityId">): Promise<{ countryCode: string; visaTypeId: string }[]> {
  const [records, apps] = await Promise.all([sharedRouteService.memberRecordsOf(route), sharedRouteService.openApplicationsUsing(route)]);
  const byKey = new Map<string, { countryCode: string; visaTypeId: string }>();
  for (const r of [...records, ...apps.map((a) => ({ countryCode: a.countryCode, visaTypeId: a.visaTypeId }))]) byKey.set(`${r.countryCode}_${r.visaTypeId}`, r);
  return [...byKey.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, r]) => r);
}

/** The default deps: the real store, notifier and note service. */
function defaultDeps(): RuleChangeDeps {
  return {
    getRubricVersion: (routeKey, version) => rubricStore.getVersionForReview(routeKey, version),
    notify: (input) => notificationService.notifyUser(input),
    addNote: (applicationId, content, actor) => noteService.addActivityNote(applicationId, content, actor),
    now: () => new Date(),
    memberRoutesOfLayer: defaultMemberRoutesOfLayer,
  };
}

/** What a sweep did, for the log line. */
export interface RuleChangeSweepResult {
  eventsSeen: number;
  eventsWaiting: number;
  eventsCompleted: number;
}

// ============================================
// Pure helpers (exported for the tests)
// ============================================

/** Firestore's `create()` on an existing document. */
function isAlreadyExists(err: unknown): boolean {
  const code = (err as { code?: number | string } | null)?.code;
  return code === ALREADY_EXISTS || code === "already-exists";
}

/** ISO calendar date (UTC) of a timestamp, for "updated on <date>". */
export function dateOf(ts: Timestamp): string {
  return ts.toDate().toISOString().slice(0, 10);
}

/** Cut a string to `max` characters with an ellipsis. */
function clip(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** Reduce a rubric criterion to what a message needs. */
function lineOf(c: VisaRubric["criteria"][number]): RuleChangeCriterionLine {
  return {
    criterionId: c.criterionId,
    title: c.title,
    ruleRef: c.ruleRef ?? null,
    quote: clip(c.source?.quote ?? "", MAX_QUOTE_CHARS),
    sourceUrl: c.source?.url ?? "",
  };
}

/**
 * The compact summary of a rubric diff (pure). `current` is the approved
 * version (to find the new text of a changed rule), `baseline` the one it
 * replaced. Counts are exact; the line lists are capped.
 */
export function summariseRubricDiff(current: VisaRubric, baseline: VisaRubric): RuleChangeRubricSummary | null {
  const diff = diffRubricVersions(current, baseline);
  if (diff.added.length + diff.removed.length + diff.changed.length === 0) return null;
  const byId = new Map(current.criteria.map((c) => [c.criterionId, c]));
  const added = diff.added.map(lineOf);
  const removed = diff.removed.map(lineOf);
  const changed = diff.changed.map((c) => lineOf(byId.get(c.criterionId) ?? c.before));
  // Distinct published documents of the rules that moved; the NEW source of a
  // changed rule, the old one of a removed rule.
  const urls: string[] = [];
  for (const l of [...added, ...changed, ...removed]) if (l.sourceUrl && !urls.includes(l.sourceUrl)) urls.push(l.sourceUrl);
  return {
    version: current.version,
    previousVersion: baseline.version,
    addedCount: added.length,
    removedCount: removed.length,
    changedCount: changed.length,
    added: added.slice(0, MAX_SUMMARY_LINES),
    removed: removed.slice(0, MAX_SUMMARY_LINES),
    changed: changed.slice(0, MAX_SUMMARY_LINES),
    sourceUrls: urls.slice(0, MAX_SOURCE_URLS),
  };
}

/** Print a stored scalar. */
function printValue(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v === "string") return clip(v, MAX_VALUE_CHARS);
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return null;
}

/** "label: 120 GBP per application" with the currency and unit exactly as stored (never converted). */
function printFeeComponent(c: { label: string; amount: number; currency: string; per: string; years?: number }): string {
  const unit = c.per === "year" ? " per year" : "";
  return `${clip(c.label, 60)}: ${c.amount}${c.currency ? ` ${c.currency}` : ""}${unit}`;
}

/** One fee diff as before / after text. */
function feeLine(components: FeeComponentDiff[]): RuleChangeFieldLine {
  const before: string[] = [];
  const after: string[] = [];
  for (const c of components) {
    if (c.change === "added") after.push(printFeeComponent(c.after));
    else if (c.change === "removed") before.push(printFeeComponent(c.before));
    else {
      before.push(printFeeComponent(c.before));
      after.push(printFeeComponent(c.after));
    }
  }
  return { field: "fee", valueKind: "scalar", before: before.join("; ") || null, after: after.join("; ") || null };
}

/**
 * The approved diff of a visa record as printable lines (pure). Scalars carry
 * their old and new value; prose fields are named only (never quoted).
 */
export function fieldLinesOf(diff: VisaFieldDiff[]): RuleChangeFieldLine[] {
  const lines: RuleChangeFieldLine[] = [];
  for (const d of diff) {
    // Issue #187: a kind/need re-reading is not a rule change to tell users about.
    if (d.field === "requiredDocumentMeta") continue;
    if (d.field === "fee") {
      lines.push(feeLine(d.components));
    } else if (d.field === "eligibilityCriteria" || d.field === "requiredDocuments") {
      // Integration (#123 x #129): #129 added a `requiredDocuments` list diff
      // (added/removed names, no before/after). Like the prose fields it is named
      // only, never quoted, so it is printed as "<label> updated".
      lines.push({ field: d.field, valueKind: "text", before: null, after: null });
    } else if (CLIENT_SAFE_SCALAR_FIELDS.has(d.field)) {
      lines.push({ field: d.field, valueKind: "scalar", before: printValue(d.before), after: d.kind === "removed" ? null : printValue(d.after) });
    } else {
      lines.push({ field: d.field, valueKind: "text", before: null, after: null });
    }
  }
  return lines;
}

/** "Fee: a -> b" / "Description updated" for one line. */
function printFieldLine(l: RuleChangeFieldLine): string {
  const label = FIELD_LABELS[l.field] ?? l.field;
  if (l.valueKind === "text") return `${label} updated`;
  return `${label}: ${l.before ?? "not stated"} → ${l.after ?? "not stated"}`;
}

/** The first `n` titles of a list, then "+N more". */
function titlesOf(lines: RuleChangeCriterionLine[], total: number): string {
  const shown = lines.slice(0, BODY_TITLES).map((l) => l.title);
  const more = total - shown.length;
  return shown.join("; ") + (more > 0 ? ` (+${more} more)` : "");
}

/** A message ready for `notifyUser`. */
export interface AlertMessage {
  title: string;
  body: string;
}

/** The detailed message for the reviewing agent / agency owner (pure). */
export function staffMessage(event: RuleChangeEvent, route: string): AlertMessage {
  if (event.sourceKind === "guidance" && event.rubricSummary) {
    const s = event.rubricSummary;
    const parts: string[] = [];
    if (s.addedCount) parts.push(`Added: ${titlesOf(s.added, s.addedCount)}.`);
    if (s.removedCount) parts.push(`Removed: ${titlesOf(s.removed, s.removedCount)}.`);
    if (s.changedCount) parts.push(`Changed: ${titlesOf(s.changed, s.changedCount)}.`);
    const source = s.sourceUrls[0] ? ` Source: ${s.sourceUrls[0]}` : "";
    return {
      title: `Published rules changed for ${route}`,
      body:
        `Updated on ${dateOf(event.approvedAt)}: ${s.addedCount} added, ${s.removedCount} removed and ${s.changedCount} changed. ` +
        // (#233 P4b) A shared layer's change: say whose rules changed, and that the refresh waits for a confirmation.
        (event.layerKey ? `These are the shared rules (${event.layerKey}) this route applies with its own. ` : "") +
        `${parts.join(" ")}${source} ` +
        (event.layerKey ? "The assessment will be refreshed once an admin confirms the re-assessment." : "The assessment is being refreshed.") +
        " The client has not been told.",
    };
  }
  const lines = (event.fieldChanges ?? []).map(printFieldLine).join("; ");
  const source = event.publishedSourceUrl ? ` Source: ${event.publishedSourceUrl}` : "";
  return {
    title: `Published details changed for ${route}`,
    body: `Updated on ${dateOf(event.approvedAt)}: ${lines}.${source}`,
  };
}

/**
 * The neutral message for an APPLICANT, or null when there is nothing they may
 * be told (pure). `agentCase` = an agent or agency handles the application.
 *  - guidance change: only a self-service applicant is told, and only that the
 *    published rules were updated, with the source. No titles, no quotes, no
 *    counts. `reviewRefreshed` says whether a refreshed review is on its way.
 *  - visa-record change: the published facts (fee, processing time, validity)
 *    with old and new values and the source; prose fields are never included.
 * Returns null when the text trips the neutral-wording guard.
 */
export function applicantMessage(event: RuleChangeEvent, route: string, agentCase: boolean, reviewRefreshed: boolean): AlertMessage | null {
  const date = dateOf(event.approvedAt);
  let message: AlertMessage | null = null;
  if (event.sourceKind === "guidance") {
    if (agentCase) return null;
    const url = event.rubricSummary?.sourceUrls[0];
    message = {
      title: "The published rules for your route were updated",
      body:
        `The published rules for ${route} were updated on ${date}.` +
        (reviewRefreshed ? " Your review will be refreshed." : "") +
        (url ? ` Source: ${url}` : ""),
    };
  } else {
    const facts = (event.fieldChanges ?? []).filter((l) => l.valueKind === "scalar").map(printFieldLine);
    if (facts.length === 0) return null;
    message = {
      title: "Published details for your route were updated",
      body:
        `On ${date} the published details for ${route} changed: ${facts.join("; ")}.` +
        (event.publishedSourceUrl ? ` Source: ${event.publishedSourceUrl}` : "") +
        (agentCase ? " Your agent can tell you what this means for your case." : ""),
    };
  }
  // Defence in depth: the text above is built from stored published facts, but a
  // fee label is free text. Anything with outcome wording is dropped, not edited.
  return NEUTRAL_FORBIDDEN.test(`${message.title} ${message.body}`) ? null : message;
}

/** The staff-side case note (pure): the detail, including the published quotes. */
export function caseNote(event: RuleChangeEvent, told: { staff: boolean; applicant: boolean; coveredByReviewNotice: boolean }): string {
  const date = dateOf(event.approvedAt);
  const head: string[] = [];
  if (event.sourceKind === "guidance" && event.rubricSummary) {
    const s = event.rubricSummary;
    head.push(`Published rules changed (rubric v${s.previousVersion} → v${s.version}, approved ${date}).`);
    const lineText = (kind: string, ls: RuleChangeCriterionLine[]) =>
      ls.map((l) => `${kind} "${l.title}"${l.ruleRef ? ` (${l.ruleRef})` : ""}${l.quote ? `: “${l.quote}”` : ""}`);
    head.push(...lineText("Added", s.added), ...lineText("Removed", s.removed), ...lineText("Changed", s.changed));
    const hidden = s.addedCount + s.removedCount + s.changedCount - (s.added.length + s.removed.length + s.changed.length);
    if (hidden > 0) head.push(`(+${hidden} more rules not listed)`);
    if (s.sourceUrls.length) head.push(`Source: ${s.sourceUrls.join(", ")}`);
  } else {
    head.push(`Published visa details changed (approved ${date}): ${(event.fieldChanges ?? []).map(printFieldLine).join("; ")}.`);
    if (event.publishedSourceUrl) head.push(`Source: ${event.publishedSourceUrl}`);
  }
  const who: string[] = [];
  if (told.staff) who.push("the case's agent / agency owner");
  if (told.coveredByReviewNotice) who.push("(reviewer already notified by the re-assessment)");
  if (told.applicant) who.push("the applicant (neutral notice)");
  head.push(who.length ? `Told: ${who.join(", ")}.` : "Nobody was notified.");
  return clip(head.join(" "), MAX_NOTE_CHARS);
}

// ============================================
// The service
// ============================================

export class RuleChangeAlertsService {
  constructor(private readonly deps: RuleChangeDeps = defaultDeps()) {}

  // ----------------------------------------------------------------
  // 1. Recording an approved change
  // ----------------------------------------------------------------

  /** A blank event with the shared fields filled in. */
  private blankEvent(partial: Pick<RuleChangeEvent, "id" | "sourceKind" | "sourceId" | "countryCode" | "visaTypeId" | "routeKey" | "approvedBy">): RuleChangeEvent {
    const now = Timestamp.fromDate(this.deps.now());
    return {
      ...partial,
      status: "pending",
      skipReason: null,
      rubricVersion: null,
      previousRubricVersion: null,
      rubricSummary: null,
      fieldChanges: null,
      publishedSourceUrl: null,
      approvedAt: now,
      createdAt: now,
      updatedAt: now,
      cursor: null,
      scanDone: false,
      scanned: 0,
      skippedDrafts: 0,
      skippedExcluded: 0,
      alreadyHandled: 0,
      coveredByReviewNotice: 0,
      staffNotified: 0,
      applicantNotified: 0,
      deliveryFailures: 0,
      completedAt: null,
    };
  }

  /** Write an event once. Returns false when it already existed (a re-delivery). */
  private async createEvent(event: RuleChangeEvent): Promise<boolean> {
    try {
      await collections.ruleChangeEvents.doc(event.id).create(event as unknown as Record<string, unknown>);
      return true;
    } catch (err) {
      if (isAlreadyExists(err)) return false;
      throw err;
    }
  }

  /**
   * Record the event for a rubric approval. Called by the Firestore trigger on
   * the durable audit document an approval writes (`rubricReviewHistory`).
   * Idempotent: the event id is derived from the route and the approved version.
   * Makes no model call.
   *
   * @returns "recorded" | "skipped" (recorded, sends nothing) | "duplicate" | "ignored"
   */
  async recordRubricApproval(auditId: string, entry: RubricReviewAuditEntry): Promise<"recorded" | "skipped" | "duplicate" | "ignored"> {
    // Only an approval that now serves a version is a change. A reject changes nothing.
    if (entry.action !== "approve" || entry.approvedVersion === null || entry.approvedVersion === undefined) return "ignored";
    // (#233 P4b) A SHARED layer's approval (a bloc / treaty rulebook: no
    // country pair): one event per affected MEMBER route (see recordLayerApproval).
    if (entry.countryCode === undefined || entry.visaTypeId === undefined) return this.recordLayerApproval(auditId, entry);
    const countryCode = entry.countryCode;
    const visaTypeId = entry.visaTypeId;
    const version = entry.approvedVersion;
    const event = this.blankEvent({
      id: guidanceEventId(entry.routeKey, version),
      sourceKind: "guidance",
      sourceId: auditId,
      countryCode,
      visaTypeId,
      routeKey: entry.routeKey,
      approvedBy: entry.by,
    });
    event.approvedAt = entry.at ?? event.approvedAt;
    event.rubricVersion = version;
    event.previousRubricVersion = entry.previousApprovedVersion ?? null;

    const skip = async (reason: string): Promise<"skipped" | "duplicate"> => {
      event.status = "skipped";
      event.skipReason = reason;
      event.scanDone = true;
      event.completedAt = event.createdAt;
      return (await this.createEvent(event)) ? "skipped" : "duplicate";
    };

    // The first approval of a route replaces nothing: no rule CHANGED for anyone.
    if (event.previousRubricVersion === null) return skip("first_approval");

    const [current, baseline] = await Promise.all([
      this.deps.getRubricVersion(entry.routeKey, version),
      this.deps.getRubricVersion(entry.routeKey, event.previousRubricVersion),
    ]);
    if (!current || !baseline) return skip("rubric_version_missing");
    // `getVersionForReview` returns any status. Both versions here are named by
    // an approval (the one approved and the one it replaced), so each must
    // BE approved; anything else is skipped and logged, never diffed.
    if (current.reviewStatus !== "approved" || baseline.reviewStatus !== "approved") {
      console.warn(`Rule-change alerts: ${entry.routeKey} v${version} or v${event.previousRubricVersion} is not approved; skipped`);
      return skip("rubric_version_not_approved");
    }

    // Diff what applicants actually get (#161): each version without the
    // criteria its reviewer excluded.
    const summary = summariseRubricDiff(applyExclusions(current), applyExclusions(baseline));
    // An approval that moves no criterion (a noisy page edit that extracted the
    // same rules) alerts nobody.
    if (!summary) return skip("no_criteria_change");
    event.rubricSummary = summary;
    return (await this.createEvent(event)) ? "recorded" : "duplicate";
  }

  /**
   * (#233 P4b) A SHARED layer's approval: ONE event per affected member route
   * (every visa record inheriting the layer today, and every route an open
   * application on the layer applied through), each keyed by the layer key,
   * the version and the member route (`layerEventId`), so a re-delivered
   * trigger records nothing twice. The summary is the shared layer's own diff
   * (the same for every member). No member layer is re-drafted, and nothing is
   * assessed here (the re-assessment is the bulk fan-out of the same approval,
   * which waits for an admin's confirmation).
   *
   * @returns "recorded" when at least one member event was new and pending,
   *   "skipped" when they were all recorded as sending nothing, "duplicate"
   *   when every one existed, "ignored" when there is no member route.
   */
  private async recordLayerApproval(auditId: string, entry: RubricReviewAuditEntry): Promise<"recorded" | "skipped" | "duplicate" | "ignored"> {
    const version = entry.approvedVersion as number;
    if (!entry.authorityId || !entry.routeSlug || !this.deps.memberRoutesOfLayer) return "ignored";
    const members = await this.deps.memberRoutesOfLayer({ issuingAuthorityId: entry.authorityId, id: entry.routeSlug });
    if (members.length === 0) {
      console.log(`Rule-change alerts: approval ${auditId} of ${entry.routeKey}: no member route, nothing recorded`);
      return "ignored";
    }
    // The diff of the shared layer, once (it is the same news for every member).
    const previous = entry.previousApprovedVersion ?? null;
    let skipReason: string | null = null;
    let summary: RuleChangeRubricSummary | null = null;
    if (previous === null) skipReason = "first_approval";
    else {
      const [current, baseline] = await Promise.all([this.deps.getRubricVersion(entry.routeKey, version), this.deps.getRubricVersion(entry.routeKey, previous)]);
      if (!current || !baseline) skipReason = "rubric_version_missing";
      else if (current.reviewStatus !== "approved" || baseline.reviewStatus !== "approved") skipReason = "rubric_version_not_approved";
      else {
        summary = summariseRubricDiff(applyExclusions(current), applyExclusions(baseline));
        if (!summary) skipReason = "no_criteria_change";
      }
    }
    let created = 0;
    for (const m of members) {
      const memberKey = `${m.countryCode}_${m.visaTypeId}`;
      const event = this.blankEvent({ id: layerEventId(entry.routeKey, version, memberKey), sourceKind: "guidance", sourceId: auditId, countryCode: m.countryCode, visaTypeId: m.visaTypeId, routeKey: memberKey, approvedBy: entry.by });
      event.layerKey = entry.routeKey;
      event.skippedOtherStack = 0;
      event.approvedAt = entry.at ?? event.approvedAt;
      event.rubricVersion = version;
      event.previousRubricVersion = previous;
      if (skipReason) {
        event.status = "skipped";
        event.skipReason = skipReason;
        event.scanDone = true;
        event.completedAt = event.createdAt;
      } else event.rubricSummary = summary;
      if (await this.createEvent(event)) created++;
    }
    console.log(`Rule-change alerts: approval ${auditId} of ${entry.routeKey}: ${created} member-route event(s) recorded of ${members.length}${skipReason ? ` (${skipReason})` : ""}`);
    if (created === 0) return "duplicate";
    return skipReason ? "skipped" : "recorded";
  }

  /**
   * Record the event for an approved visa-record change. Called AFTER the
   * approval transaction committed (`approveChange`), outside it: the caller
   * logs and swallows any error from here, so the approval is never affected.
   * Idempotent on the `pendingVisaChanges` id. Makes no model call.
   */
  async recordVisaChangeApproved(input: {
    changeId: string;
    countryCode: string;
    visaId: string;
    diff: VisaFieldDiff[];
    sourceUrl: string | null;
    approvedBy: string;
  }): Promise<"recorded" | "skipped" | "duplicate"> {
    const event = this.blankEvent({
      id: visaEventId(input.changeId),
      sourceKind: "visa",
      sourceId: input.changeId,
      countryCode: input.countryCode,
      visaTypeId: input.visaId,
      routeKey: `${input.countryCode}_${input.visaId}`,
      approvedBy: input.approvedBy,
    });
    const lines = fieldLinesOf(input.diff);
    event.fieldChanges = lines;
    event.publishedSourceUrl = input.sourceUrl;
    if (lines.length === 0) {
      event.status = "skipped";
      event.skipReason = "no_fields";
      event.scanDone = true;
      event.completedAt = event.createdAt;
      return (await this.createEvent(event)) ? "skipped" : "duplicate";
    }
    return (await this.createEvent(event)) ? "recorded" : "duplicate";
  }

  // ----------------------------------------------------------------
  // 2. The sweep
  // ----------------------------------------------------------------

  /**
   * One scheduled pass: advance every pending / processing event. Safe to run
   * at any time and any number of times (every send is guarded by its claim).
   */
  async runSweep(): Promise<RuleChangeSweepResult> {
    const result: RuleChangeSweepResult = { eventsSeen: 0, eventsWaiting: 0, eventsCompleted: 0 };
    const deadline = this.deps.now().getTime() + SWEEP_BUDGET_MS;
    const snap = await collections.ruleChangeEvents.where("status", "in", ["pending", "processing"]).limit(EVENTS_PER_SWEEP).get();
    for (const d of snap.docs) {
      if (this.deps.now().getTime() >= deadline) break;
      result.eventsSeen++;
      const event = d.data() as RuleChangeEvent;
      try {
        if (!(await this.readyToNotify(event))) {
          result.eventsWaiting++;
          continue;
        }
        if (await this.processEvent(event, deadline)) result.eventsCompleted++;
      } catch (err) {
        // One bad event never stops the others; it is picked up again next sweep.
        console.error(`[rule-change] event ${event.id} failed: ${(err as Error).name}`);
      }
    }
    return result;
  }

  /**
   * A guidance event waits for #37's run for the same approval to finish, so
   * the dedupe against its reviewer notification is complete. It stops waiting
   * after MAX_WAIT_MS (the run may be stuck behind a disabled switch or spend cap).
   */
  private async readyToNotify(event: RuleChangeEvent): Promise<boolean> {
    if (event.sourceKind !== "guidance") return true;
    const run = await collections.bulkReassessments.doc(event.sourceId).get();
    const status = run.exists ? (run.data() as { status?: string }).status : null;
    // (#233 P4b) A shared layer's fan-out waiting for its confirmation has sent no
    // reviewer notification (no job ran), so there is nothing to dedupe against: ready.
    if (status === "completed" || status === "cancelled" || status === "awaiting_confirmation") return true;
    return this.deps.now().getTime() - event.createdAt.toMillis() >= MAX_WAIT_MS;
  }

  /**
   * Scan the route's applications and handle each, resuming from the saved
   * cursor. Returns true when the scan finished and the event is completed.
   */
  async processEvent(event: RuleChangeEvent, deadlineMs: number): Promise<boolean> {
    const ref = collections.ruleChangeEvents.doc(event.id);
    const tally = { ...event };
    if (event.status === "pending") await ref.update({ status: "processing", updatedAt: Timestamp.fromDate(this.deps.now()) });

    let cursor = event.cursor;
    let done = event.scanDone;
    while (!done && this.deps.now().getTime() < deadlineMs) {
      // Equality filters plus the document id: answered by the automatic indexes.
      let q = collections.applications
        .where("countryCode", "==", event.countryCode)
        .where("visaTypeId", "==", event.visaTypeId)
        .orderBy(FieldPath.documentId())
        .limit(SCAN_PAGE);
      if (cursor) q = q.startAfter(cursor);
      const page = await q.get();
      if (page.empty) {
        done = true;
        break;
      }
      for (const d of page.docs) {
        const app = { id: d.id, ...d.data() } as Application;
        await this.handleApplication(tally, app);
      }
      cursor = page.docs[page.docs.length - 1].id;
      if (page.size < SCAN_PAGE) done = true;
      // Progress after every page, so a crash loses at most one page, which
      // re-runs harmlessly (its claims already exist).
      await ref.update({
        cursor,
        scanDone: done,
        scanned: tally.scanned,
        skippedDrafts: tally.skippedDrafts,
        skippedExcluded: tally.skippedExcluded,
        ...(tally.layerKey ? { skippedOtherStack: tally.skippedOtherStack ?? 0 } : {}),
        alreadyHandled: tally.alreadyHandled,
        coveredByReviewNotice: tally.coveredByReviewNotice,
        staffNotified: tally.staffNotified,
        applicantNotified: tally.applicantNotified,
        deliveryFailures: tally.deliveryFailures,
        updatedAt: Timestamp.fromDate(this.deps.now()),
      });
    }
    if (!done) return false;
    const stamp = Timestamp.fromDate(this.deps.now());
    await ref.update({ status: "completed", scanDone: true, completedAt: stamp, updatedAt: stamp });
    // The skipped counts are logged as the issue asks (ids and counts only).
    console.log(
      `[rule-change] event ${event.id} completed: scanned ${tally.scanned}, skipped drafts ${tally.skippedDrafts}, ` +
        `skipped closed/submitted ${tally.skippedExcluded}, already handled ${tally.alreadyHandled}, ` +
        `staff notified ${tally.staffNotified}, applicants notified ${tally.applicantNotified}, ` +
        `covered by review notice ${tally.coveredByReviewNotice}, failures ${tally.deliveryFailures}`
    );
    return true;
  }

  // ----------------------------------------------------------------
  // 3. One application
  // ----------------------------------------------------------------

  /** Who reviews this case: the assigned agent, else the agency owner. Never the applicant. */
  private async staffRecipients(app: Application): Promise<string[]> {
    let ids: string[] = [];
    if (app.agentId) ids = [app.agentId];
    else if (app.agencyId) {
      const agency = await collections.agencies.doc(app.agencyId).get();
      const ownerId = agency.exists ? (agency.data() as { ownerId?: string }).ownerId : undefined;
      if (ownerId) ids = [ownerId];
    }
    return [...new Set(ids)].filter((uid) => uid !== app.userId);
  }

  /**
   * #37's assessment for this application under this approval, if it ran:
   * tells whether the reviewer was already notified and whether a refreshed
   * review exists / is on its way.
   */
  private async bulkAssessmentOf(event: RuleChangeEvent, applicationId: string): Promise<ApplicationAssessment | null> {
    if (event.sourceKind !== "guidance") return null;
    const snap = await collections.applicationAssessments.where("applicationId", "==", applicationId).where("bulkRunId", "==", event.sourceId).limit(1).get();
    return snap.empty ? null : (snap.docs[0].data() as ApplicationAssessment);
  }

  /** Handle one application: skip, claim, tell, record. Never throws. */
  private async handleApplication(tally: RuleChangeEvent, app: Application): Promise<void> {
    tally.scanned++;
    // Drafts are not in flight: nothing is sent and the count is logged.
    if (app.status === "draft") {
      tally.skippedDrafts++;
      return;
    }
    // Closed, submitted onward or withdrawn: the same set #37 leaves alone.
    if (EXCLUDED_APPLICATION_STATUSES.includes(app.status)) {
      tally.skippedExcluded++;
      return;
    }
    // (#233 P4b) A shared layer's event: an application whose stored stack does
    // not include the layer runs on other rules and is not told. One with no
    // stored stack resolves live from a record that inherits the layer: told.
    if (tally.layerKey && Array.isArray(app.routeStack) && !app.routeStack.includes(tally.layerKey)) {
      tally.skippedOtherStack = (tally.skippedOtherStack ?? 0) + 1;
      return;
    }

    const noticeRef = collections.ruleChangeNotices.doc(ruleChangeNoticeId(tally.id, app.id));
    const now = Timestamp.fromDate(this.deps.now());
    const claim: RuleChangeNotice = {
      id: noticeRef.id,
      eventId: tally.id,
      applicationId: app.id,
      agencyId: app.agencyId ?? null,
      outcome: "claimed",
      staffRecipientIds: [],
      applicantNotified: false,
      createdAt: now,
      updatedAt: now,
    };
    // THE DEDUPE: the claim is created before anything is sent. A retry, a double
    // delivery or an overlapping sweep finds it and sends nothing (a crash after
    // the claim and before the send loses that one notice rather than doubling it).
    try {
      await noticeRef.create(claim as unknown as Record<string, unknown>);
    } catch (err) {
      if (isAlreadyExists(err)) {
        tally.alreadyHandled++;
        return;
      }
      tally.deliveryFailures++;
      console.error(`[rule-change] claim failed for ${noticeRef.id}: ${(err as Error).name}`);
      return;
    }

    try {
      const route = app.visaTypeName ?? "this route";
      const agentCase = Boolean(app.agentId || app.agencyId);
      const assessment = await this.bulkAssessmentOf(tally, app.id);
      const staffIds = agentCase ? await this.staffRecipients(app) : [];
      const staffMsg = staffMessage(tally, route);
      // #37 already told the reviewer this approval changed the rules: not twice.
      const covered = Boolean(assessment?.reviewNotifiedAt) && staffIds.length > 0;

      // ---- staff (best effort, one failure does not stop the rest) ----
      const toldStaff: string[] = [];
      if (!covered) {
        for (const userId of staffIds) {
          try {
            await this.deps.notify({
              userId,
              type: "rule_change_alert",
              title: staffMsg.title,
              body: staffMsg.body,
              relatedEntityType: "application",
              relatedEntityId: app.id,
            });
            toldStaff.push(userId);
          } catch (err) {
            tally.deliveryFailures++;
            console.error(`[rule-change] staff delivery failed for ${app.id}: ${(err as Error).name}`);
          }
        }
      }

      // ---- applicant (neutral only; see applicantMessage) ----
      let toldApplicant = false;
      const applicantMsg = applicantMessage(tally, route, agentCase, Boolean(assessment));
      if (applicantMsg && app.userId) {
        try {
          await this.deps.notify({
            userId: app.userId,
            type: "rule_change_alert",
            title: applicantMsg.title,
            body: applicantMsg.body,
            relatedEntityType: "application",
            relatedEntityId: app.id,
          });
          toldApplicant = true;
        } catch (err) {
          tally.deliveryFailures++;
          console.error(`[rule-change] applicant delivery failed for ${app.id}: ${(err as Error).name}`);
        }
      }

      if (toldStaff.length > 0) tally.staffNotified++;
      if (toldApplicant) tally.applicantNotified++;
      if (covered) tally.coveredByReviewNotice++;

      // ---- the record: who was told what, on the case (staff-side note) ----
      const anyone = toldStaff.length > 0 || toldApplicant || covered;
      if (anyone) {
        await this.deps.addNote(app.id, caseNote(tally, { staff: toldStaff.length > 0, applicant: toldApplicant, coveredByReviewNotice: covered }));
      }
      await noticeRef.update({
        outcome: covered && toldStaff.length === 0 && !toldApplicant ? "covered_by_review_notice" : anyone ? "sent" : staffIds.length === 0 && !applicantMsg ? "no_recipient" : "failed",
        staffRecipientIds: toldStaff,
        applicantNotified: toldApplicant,
        updatedAt: Timestamp.fromDate(this.deps.now()),
      });
    } catch (err) {
      tally.deliveryFailures++;
      console.error(`[rule-change] handling ${app.id} failed: ${(err as Error).name}`);
      try {
        await noticeRef.update({ outcome: "failed", updatedAt: Timestamp.fromDate(this.deps.now()) });
      } catch {
        // The claim stays "claimed": still a dedupe key.
      }
    }
  }
}

/** Singleton over the real store, notifier and note service. */
export const ruleChangeAlertsService = new RuleChangeAlertsService();
