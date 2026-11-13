// ============================================
// Agency visas: ADMIN side (issue #101)
// ============================================
//
// What admins do with agency visas (`source: "agency"`, contract:
// ./agency-visas.md, "Admin side" section):
//
//  1. listForAdmin: `GET /admin/visas` with the agency visas enriched
//     (`agencyName` looked up on the server, `pendingRevision`), plus the
//     optional `source` and `agencyId` filters.
//  2. review: `PATCH /admin/visas/:id/review` for an agency visa. Stricter
//     than the scraped path (orchestrator notes from the #100 review):
//       - approve / reject only from `pending_review` (the visa itself, or
//         a pending revision of an approved visa);
//       - a pending revision is applied (approve) or rejected inside ONE
//         transaction that re-checks the revision's `updatedAt` against the
//         value the admin loaded (409 REVISION_CHANGED), and approve writes
//         ONLY the content keys of `changes` (never the whole revision doc);
//       - approve needs a finite `baseCostUsd` (409 VISA_COST_MISSING).
//  3. setVisibility: `PATCH /admin/visas/:id/visibility`, make global or
//     take back to agency-only (approved agency visas only).
//  4. Emails to the owning agency's owner (approved, rejected, made global)
//     through notifyUser (Resend), AFTER the write commits. An email failure
//     is logged and never fails or rolls back the action.
//
// Authorization: the routes run `verifyAuth` + `verifyAdmin`; the controller
// gates on the shared CASL ability with a tagged probe, and the service
// re-checks the ability on the REAL doc (tagged `asSubject("Visa", doc)`)
// inside the transaction through the `authorize` callback, so an agency
// owner holding the conditional #98 grant on their own visa is still refused
// (review and visibility fields are field-level `cannot` for them).
//
// Kept in its own file so the agency-facing service (#100) stays unchanged,
// and so visa.service.ts does not import this module (that would be an
// import cycle: agency visa service -> visa.service -> here).

import { DocumentReference, FieldValue, Timestamp, Transaction } from "firebase-admin/firestore";
import { AGENCY_VISA_SOURCE } from "@durin-tech/authz";
import { collections, db, subcollections } from "../utils/firebase";
import { Agency, VISA_VISIBILITY, VisaRevision, VisaType, VisaVisibility } from "../types";
import { VisaIsDraftError, visaService } from "../services/visa.service";
import { notificationService, NotifyUserInput } from "../services/notification.service";
import { assertVisaApprovable } from "../scrapers";
import { AGENCY_VISA_CONTENT_FIELDS, AgencyVisaError } from "./agency-visa.validation";
import { revisionId } from "./agency-visa.service";
// Issue #120: screening results on the admin list, and the approve gate.
import {
  agencyVisaScreeningService,
  isScreeningClean,
  screeningKey,
  screeningTargetFor,
} from "./agency-visa-screening.service";
import { screeningContentHash } from "../services/ai/listing-screening-prompt";
import type { ListingScreening } from "../types/listing-screening";

// ============================================
// Types
// ============================================

/** `GET /admin/visas` filter values for `source`. */
export const ADMIN_VISA_SOURCE_FILTERS = ["scraped", AGENCY_VISA_SOURCE] as const;
/** One `source` filter value. */
export type AdminVisaSourceFilter = (typeof ADMIN_VISA_SOURCE_FILTERS)[number];

/** Parsed, validated `GET /admin/visas` query. Both optional. */
export interface AdminVisaFilters {
  source?: AdminVisaSourceFilter;
  agencyId?: string;
}

/**
 * One row of `GET /admin/visas`: the stored visa + its country name. Agency
 * visas (and only them, so scraped / seed rows stay byte-for-byte what they
 * were) also carry:
 *  - `agencyName`: the owning agency's name, read from `agencies/{id}` on the
 *    server (never client-supplied); null when the agency doc is missing;
 *  - `pendingRevision`: the pending edit of an approved visa
 *    (`visaRevisions/{cc}__{id}` with `reviewStatus: "pending_review"`), or
 *    null. Its `updatedAt` is what the admin sends back as
 *    `revisionUpdatedAt` when approving or rejecting it.
 */
export type AdminVisaRow = VisaType & {
  countryName: string;
  agencyName?: string | null;
  pendingRevision?: VisaRevision | null;
  /**
   * Issue #120, agency rows only: the listing screening result (the stored
   * `listingScreenings` doc, or null when none ran) and the count of active
   * risk signals about this visa. ADMIN-ONLY: they come from this admin list
   * and nowhere else.
   */
  screening?: ListingScreening | null;
  openScreeningSignals?: number;
};

/**
 * Ability callback from the controller: true when the caller may write
 * `field` of THIS visa (CASL `update` on the doc tagged as a `Visa`, field
 * level). Called on the freshly read doc inside the transaction.
 */
export type AuthorizeAdminVisa = (visa: VisaType, field: "reviewStatus" | "visibility") => boolean;

/** Input of an admin review of an agency visa. */
export interface AgencyVisaReviewInput {
  countryCode: string;
  visaId: string;
  action: "approve" | "reject";
  /** The admin's uid. */
  reviewedBy: string;
  /** Required by the controller on reject. */
  rejectionReason?: string;
  /**
   * `pendingRevision.updatedAt` as the admin loaded it, in millis (the
   * controller parses ISO 8601 or a serialised Timestamp). Required when the
   * visa has a pending revision; ignored otherwise.
   */
  revisionUpdatedAtMillis?: number;
  /**
   * Issue #120: the admin has seen the screening result and approves anyway.
   * Without it, approve is refused (409 SCREENING_OPEN) unless the screening
   * is clean. Ignored on reject.
   */
  acknowledgeScreening?: boolean;
}

/**
 * What an admin review did. Drives the email (none for `unchanged`) and the
 * response message.
 *  - approved / rejected: the visa itself (it was pending_review);
 *  - revision_approved / revision_rejected: the pending edit of an approved
 *    visa;
 *  - unchanged: approve of an already approved visa with no pending
 *    revision (idempotent: 200, nothing written, no email).
 */
export type AgencyVisaReviewOutcome =
  | "approved"
  | "rejected"
  | "revision_approved"
  | "revision_rejected"
  | "unchanged";

/** Result of review / setVisibility: the visa as stored after the action. */
export interface AgencyVisaAdminResult<O extends string> {
  outcome: O;
  visa: VisaType;
}

/** What a visibility change did (`unchanged` = same value, nothing written). */
export type AgencyVisaVisibilityOutcome = "made_global" | "made_agency_only" | "unchanged";

// ============================================
// Errors (all AgencyVisaError: code + HTTP status the controller sends)
// ============================================

/** The visa (by country + id) does not exist. */
const notFound = () => new AgencyVisaError("NOT_FOUND", "Visa type not found", 404);

/**
 * Approve of an agency visa without a finite `baseCostUsd` (optional for
 * agency visas, required to go live). A dedicated code so the portal can
 * show "add the government fee first" instead of the scraped-fee message.
 */
export const VISA_COST_MISSING = "VISA_COST_MISSING";

/**
 * Approve of an agency visa whose listing screening is not clean (no result for
 * this content, a failed language check, a mismatch or a flag) and the body had
 * no `acknowledgeScreening: true` (issue #120). Nothing is written.
 */
export const SCREENING_OPEN = "SCREENING_OPEN";

// ============================================
// Pure helpers (exported for tests)
// ============================================

/**
 * Parse an "expected updatedAt" value from a request body into millis.
 * Accepts what the portal has in hand: an ISO 8601 string, a number of
 * millis, or a serialised Firestore Timestamp (`{ _seconds, _nanoseconds }`
 * as every endpoint returns it, or `{ seconds, nanoseconds }`).
 *
 * @returns millis, or null when the value is missing or unparseable
 */
export function parseExpectedTimestamp(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : null;
  }
  if (typeof value === "object") {
    const o = value as Record<string, unknown>;
    const seconds = o._seconds ?? o.seconds;
    const nanos = o._nanoseconds ?? o.nanoseconds ?? 0;
    if (typeof seconds === "number" && typeof nanos === "number" && Number.isFinite(seconds) && Number.isFinite(nanos)) {
      return seconds * 1000 + Math.floor(nanos / 1e6);
    }
  }
  return null;
}

/** Millis of a stored Timestamp (or anything Timestamp-like), else null. */
function toMillis(value: unknown): number | null {
  if (value instanceof Timestamp) return value.toMillis();
  return parseExpectedTimestamp(value);
}

/**
 * The Firestore update that applies a revision's `changes` to the live doc.
 * ONLY the agency content keys (AGENCY_VISA_CONTENT_FIELDS) are taken, minus
 * `countryCode` (part of the doc path, never changed): anything else that
 * might be in `changes` (a protected field such as `reviewStatus` or
 * `visibility`, ownership, meta) is ignored, so a revision can never write
 * review state, visibility or ownership. `null` -> FieldValue.delete().
 */
export function revisionUpdate(changes: Record<string, unknown>): Record<string, unknown> {
  const update: Record<string, unknown> = {};
  for (const field of AGENCY_VISA_CONTENT_FIELDS) {
    if (field === "countryCode") continue;
    if (!Object.prototype.hasOwnProperty.call(changes, field)) continue;
    const v = changes[field];
    update[field] = v === null ? FieldValue.delete() : v;
  }
  return update;
}

/**
 * The live visa as it would be after applying `changes` (pure, for the
 * approval guard). Same key rules as revisionUpdate.
 */
export function applyRevision(live: VisaType, changes: Record<string, unknown>): VisaType {
  const out: Record<string, unknown> = { ...live };
  for (const field of AGENCY_VISA_CONTENT_FIELDS) {
    if (field === "countryCode") continue;
    if (!Object.prototype.hasOwnProperty.call(changes, field)) continue;
    const v = changes[field];
    if (v === null) delete out[field];
    else out[field] = v;
  }
  return out as unknown as VisaType;
}

/**
 * Throw unless `visa` can go live: a finite `baseCostUsd` first (agency
 * specific code, VISA_COST_MISSING), then the shared approval guard
 * (assertVisaApprovable, issue #59) for anything else it checks.
 */
export function assertAgencyVisaApprovable(visa: VisaType): void {
  if (typeof visa.baseCostUsd !== "number" || !Number.isFinite(visa.baseCostUsd)) {
    throw new AgencyVisaError(
      VISA_COST_MISSING,
      "Add the government fee in USD (baseCostUsd) to this visa before approving it",
      409,
      "baseCostUsd"
    );
  }
  assertVisaApprovable(visa);
}

/**
 * Issue #120: refuse an approve whose screening is not clean for the content
 * about to go live, unless the admin acknowledged it. Pure apart from the throw;
 * runs before any write, so nothing is written on a 409. A listing therefore
 * never goes live without a person having seen the result.
 */
export function assertScreeningAcknowledged(
  doc: ListingScreening | null,
  target: ReturnType<typeof screeningTargetFor>,
  acknowledged: boolean | undefined
): void {
  if (acknowledged === true || !target) return;
  const clean = isScreeningClean(doc, { target: target.target, contentHash: screeningContentHash(target.target, target.content) });
  if (clean) return;
  throw new AgencyVisaError(
    SCREENING_OPEN,
    "This listing has screening results that need your attention before it goes live. " +
      "Review them, then approve again with acknowledgeScreening set to true.",
    409
  );
}

/** 409 for an agency visa that is not waiting for review. */
function notInReview(status: string | undefined): AgencyVisaError {
  return new AgencyVisaError(
    "VISA_NOT_IN_REVIEW",
    `This agency visa is not waiting for review (status: ${status ?? "none"}). ` +
      "Only a submitted visa, or a submitted edit to an approved one, can be approved or rejected",
    409
  );
}

// ============================================
// Service
// ============================================

class AgencyVisaReviewService {
  /** Transaction runner; swapped for an in-memory one in unit tests. */
  runTransaction: <T>(fn: (tx: Transaction) => Promise<T>) => Promise<T> = (fn) => db.runTransaction(fn);

  /** Clock; swappable in tests. */
  now: () => Timestamp = () => Timestamp.now();

  /**
   * Email delivery: the existing notifyUser path (Resend, branded template).
   * Swappable in tests to capture the calls (and to make one fail).
   */
  notify: (input: NotifyUserInput) => Promise<void> = (input) => notificationService.notifyUser(input);

  // ------------------------------------------
  // 1. Admin list
  // ------------------------------------------

  /**
   * `GET /admin/visas`: every reviewable visa (drafts excluded, #100), with
   * agency visas enriched, then filtered.
   *
   * No new Firestore query: the rows come from the existing per-country scan
   * (getAllVisaTypesForAdmin), the filters run in code, agency names are
   * doc gets on `agencies/{id}` (one per distinct agency), and pending
   * revisions are one equality query on `visaRevisions.reviewStatus`
   * (automatic single-field index). So no composite index is needed.
   *
   * With no filters the result is today's list, plus `agencyName` and
   * `pendingRevision` on agency rows only.
   *
   * @param filters `source` ("scraped" = only `source: "scraped"`, "agency"
   *   = only agency visas) and/or `agencyId` (agency visas of that agency)
   */
  async listForAdmin(filters: AdminVisaFilters = {}): Promise<AdminVisaRow[]> {
    const all = (await visaService.getAllVisaTypesForAdmin()) as AdminVisaRow[];

    // ---- Filters (in code) ----
    const rows = all.filter((v) => {
      if (filters.source && v.source !== filters.source) return false;
      if (filters.agencyId && (v.source !== AGENCY_VISA_SOURCE || v.ownerAgencyId !== filters.agencyId)) return false;
      return true;
    });

    const agencyRows = rows.filter((v) => v.source === AGENCY_VISA_SOURCE);
    if (agencyRows.length === 0) return rows;

    // Issue #120: screening result + open signal count, admin-only (this list).
    const screenings = await agencyVisaScreeningService.adminViews(agencyRows);

    // ---- Enrichment: agency names + pending revisions ----
    const agencyIds = [...new Set(agencyRows.map((v) => v.ownerAgencyId).filter((id): id is string => !!id))];
    const [names, revSnap] = await Promise.all([
      this.agencyNames(agencyIds),
      collections.visaRevisions.where("reviewStatus", "==", "pending_review").get(),
    ]);
    const revisions = new Map<string, VisaRevision>();
    for (const d of revSnap.docs) revisions.set(d.id, d.data() as VisaRevision);

    return rows.map((v) => {
      if (v.source !== AGENCY_VISA_SOURCE) return v;
      return {
        ...v,
        agencyName: v.ownerAgencyId ? names.get(v.ownerAgencyId) ?? null : null,
        pendingRevision: revisions.get(revisionId(v.countryCode, v.id)) ?? null,
        screening: screenings.get(screeningKey(v.countryCode, v.id))?.screening ?? null,
        openScreeningSignals: screenings.get(screeningKey(v.countryCode, v.id))?.openScreeningSignals ?? 0,
      };
    });
  }

  /** `agencies/{id}.name` for each id (missing doc -> not in the map). */
  private async agencyNames(ids: string[]): Promise<Map<string, string>> {
    const snaps = await Promise.all(ids.map((id) => collections.agencies.doc(id).get()));
    const names = new Map<string, string>();
    snaps.forEach((s, i) => {
      const name = s.exists ? (s.data() as Agency | undefined)?.name : undefined;
      if (typeof name === "string") names.set(ids[i], name);
    });
    return names;
  }

  // ------------------------------------------
  // 2. Review (approve / reject)
  // ------------------------------------------

  /**
   * Approve or reject an agency visa, or the pending revision of an approved
   * one, in ONE transaction. State table (anything else writes nothing):
   *
   * | visa state                      | approve                         | reject                              |
   * | ------------------------------- | ------------------------------- | ----------------------------------- |
   * | draft                           | 409 VISA_IS_DRAFT               | 409 VISA_IS_DRAFT                   |
   * | pending_review                  | approved, isActive true         | rejected + reason, isActive false   |
   * | approved + pending revision     | changes applied, revision gone  | revision rejected + reason; live kept |
   * | approved, no pending revision   | 200 unchanged (idempotent)      | 409 VISA_NOT_IN_REVIEW              |
   * | rejected                        | 409 VISA_NOT_IN_REVIEW          | 409 VISA_NOT_IN_REVIEW              |
   *
   * Approve never changes `visibility`: an approved agency visa stays
   * agency-only until setVisibility. Approve needs a finite `baseCostUsd`
   * on the result (409 VISA_COST_MISSING).
   *
   * Revisions: `revisionUpdatedAtMillis` must equal the revision's stored
   * `updatedAt` (re-read inside the transaction): missing -> 400, different
   * -> 409 REVISION_CHANGED (the agency edited it after the admin loaded
   * it). Approve writes only the content keys of `changes`
   * (revisionUpdate), plus reviewedBy / reviewedAt / updatedAt, and deletes
   * the revision doc.
   *
   * After the commit: country stats are recomputed when the live doc changed
   * (best effort), then the owner is emailed (best effort, never throws).
   *
   * @throws AgencyVisaError (404, 400, 403, 409) or VisaIsDraftError (409)
   *   or VisaFeeNotConvertibleError (409); nothing written in every case
   */
  async review(
    input: AgencyVisaReviewInput,
    authorize: AuthorizeAdminVisa
  ): Promise<AgencyVisaAdminResult<AgencyVisaReviewOutcome>> {
    const cc = input.countryCode.toUpperCase();
    const ref = subcollections.visaTypes(cc).doc(input.visaId);
    const revRef = collections.visaRevisions.doc(revisionId(cc, input.visaId));

    // ---- One transaction: read, decide, write ----
    const decided = await this.runTransaction(async (tx) => {
      // Reads first (Firestore requires all reads before writes).
      const snap = await tx.get(ref);
      if (!snap.exists) throw notFound();
      const visa = { id: snap.id, ...snap.data() } as VisaType;
      if (visa.source !== AGENCY_VISA_SOURCE) {
        // The controller only routes agency visas here; never review a
        // scraped / seed visa with the agency rules.
        throw new AgencyVisaError("NOT_AN_AGENCY_VISA", "This visa was not created by an agency", 409);
      }
      // Defence in depth: CASL on the real doc, field level.
      if (!authorize(visa, "reviewStatus")) {
        throw new AgencyVisaError("FORBIDDEN", "Only Seli admins can review agency visas", 403);
      }
      const revSnap = await tx.get(revRef);
      const revision = revSnap.exists ? (revSnap.data() as VisaRevision) : null;
      // Issue #120: the screening result, read with the other reads so the
      // approve gate below decides on what is stored right now.
      const screeningSnap = await tx.get(collections.listingScreenings.doc(screeningKey(cc, input.visaId)));
      const screening = screeningSnap.exists ? (screeningSnap.data() as ListingScreening) : null;

      const now = this.now();
      const status = visa.reviewStatus;

      // ---- Draft: never submitted (same error as the scraped path) ----
      if (status === "draft") throw new VisaIsDraftError();

      // ---- The visa itself is waiting for review ----
      if (status === "pending_review") {
        if (input.action === "approve") {
          assertAgencyVisaApprovable(visa);
          assertScreeningAcknowledged(screening, screeningTargetFor(visa, null), input.acknowledgeScreening);
          tx.update(ref, {
            reviewStatus: "approved",
            isActive: true,
            reviewedBy: input.reviewedBy,
            reviewedAt: now,
            updatedAt: now,
            // A visa resubmitted after a rejection had its reason cleared on
            // submit (#100); clear again in case, so an approved visa never
            // shows an old reason.
            rejectionReason: FieldValue.delete(),
          });
          return { outcome: "approved" as const, liveChanged: true };
        }
        tx.update(ref, {
          reviewStatus: "rejected",
          rejectionReason: input.rejectionReason,
          // Submitted visas are already inactive (#100 submit); explicit so
          // a rejected visa is never live whatever the data said.
          isActive: false,
          reviewedBy: input.reviewedBy,
          reviewedAt: now,
          updatedAt: now,
        });
        return { outcome: "rejected" as const, liveChanged: visa.isActive === true };
      }

      // ---- Approved: only a pending revision can be reviewed ----
      if (status === "approved") {
        if (revision && revision.reviewStatus === "pending_review") {
          // Optimistic concurrency: the admin decides on what they saw.
          if (input.revisionUpdatedAtMillis === undefined) {
            throw new AgencyVisaError(
              "VALIDATION_ERROR",
              "revisionUpdatedAt is required: send pendingRevision.updatedAt as you loaded it",
              400,
              "revisionUpdatedAt"
            );
          }
          if (toMillis(revision.updatedAt) !== input.revisionUpdatedAtMillis) {
            throw new AgencyVisaError(
              "REVISION_CHANGED",
              "The agency changed this edit after you opened it. Reload it and review again",
              409
            );
          }

          if (input.action === "approve") {
            assertAgencyVisaApprovable(applyRevision(visa, revision.changes ?? {}));
            assertScreeningAcknowledged(screening, screeningTargetFor(visa, revision), input.acknowledgeScreening);
            tx.update(ref, {
              ...revisionUpdate(revision.changes ?? {}),
              reviewedBy: input.reviewedBy,
              reviewedAt: now,
              updatedAt: now,
            });
            tx.delete(revRef);
            return { outcome: "revision_approved" as const, liveChanged: true };
          }
          // Reject: the revision keeps its changes (the agency can rework
          // them); the live doc is not written at all, so it stays approved
          // and active with its previous values.
          tx.update(revRef, {
            reviewStatus: "rejected",
            rejectionReason: input.rejectionReason,
            reviewedBy: input.reviewedBy,
            reviewedAt: now,
          });
          return { outcome: "revision_rejected" as const, liveChanged: false };
        }
        // No pending revision: re-approving is a no-op (idempotent).
        if (input.action === "approve") return { outcome: "unchanged" as const, liveChanged: false };
        throw notInReview(status);
      }

      // ---- Rejected (or anything unexpected): not in review ----
      throw notInReview(status);
    });

    // ---- After the commit (best effort) ----
    if (decided.liveChanged) await this.recomputeStats(cc, input.visaId);
    const visa = await this.read(ref);
    if (decided.outcome !== "unchanged") {
      await this.emailOwner(visa, decided.outcome, input.rejectionReason);
    }
    return { outcome: decided.outcome, visa };
  }

  // ------------------------------------------
  // 3. Make global / agency-only
  // ------------------------------------------

  /**
   * Set an agency visa's `visibility` (admin only).
   *
   *  - Only `source: "agency"` visas (409 NOT_AN_AGENCY_VISA) that are
   *    `approved` (409 VISA_NOT_APPROVED). Unknown id: 404.
   *  - "global": writes `visibility`, `madeGlobalBy`, `madeGlobalAt`,
   *    `updatedAt`. The visa then passes isVisaPubliclyVisible (approved +
   *    active + global) and shows in every public read.
   *  - "agency": writes `visibility`, `madeAgencyOnlyBy`,
   *    `madeAgencyOnlyAt`, `updatedAt`. Both pairs are kept as history.
   *  - Same value as stored: 200 `unchanged`, nothing written, no email.
   *  - `ownerAgencyId`, `source` and the review fields are never written.
   *
   * After the commit: country stats recomputed (the public set changed),
   * then the owner is emailed on make-global only. Taking a visa back to
   * agency-only sends no email: the agency loses nothing (its own access
   * and pages are unchanged), so there is nothing for it to act on.
   */
  async setVisibility(
    input: { countryCode: string; visaId: string; visibility: VisaVisibility; changedBy: string },
    authorize: AuthorizeAdminVisa
  ): Promise<AgencyVisaAdminResult<AgencyVisaVisibilityOutcome>> {
    const cc = input.countryCode.toUpperCase();
    const ref = subcollections.visaTypes(cc).doc(input.visaId);

    const outcome = await this.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) throw notFound();
      const visa = { id: snap.id, ...snap.data() } as VisaType;
      if (!authorize(visa, "visibility")) {
        throw new AgencyVisaError("FORBIDDEN", "Only Seli admins can change a visa's visibility", 403);
      }
      if (visa.source !== AGENCY_VISA_SOURCE) {
        throw new AgencyVisaError(
          "NOT_AN_AGENCY_VISA",
          "Only visas created by an agency can be made global or agency-only",
          409
        );
      }
      if (visa.reviewStatus !== "approved") {
        throw new AgencyVisaError(
          "VISA_NOT_APPROVED",
          "Approve this visa before changing who can see it",
          409
        );
      }
      // Agency visas always store `visibility` (#100); default defensively.
      const current = visa.visibility ?? VISA_VISIBILITY.AGENCY;
      if (current === input.visibility) return "unchanged" as const;

      const now = this.now();
      if (input.visibility === VISA_VISIBILITY.GLOBAL) {
        tx.update(ref, {
          visibility: VISA_VISIBILITY.GLOBAL,
          madeGlobalBy: input.changedBy,
          madeGlobalAt: now,
          updatedAt: now,
        });
        return "made_global" as const;
      }
      tx.update(ref, {
        visibility: VISA_VISIBILITY.AGENCY,
        madeAgencyOnlyBy: input.changedBy,
        madeAgencyOnlyAt: now,
        updatedAt: now,
      });
      return "made_agency_only" as const;
    });

    if (outcome !== "unchanged") await this.recomputeStats(cc, input.visaId);
    const visa = await this.read(ref);
    if (outcome === "made_global") await this.emailOwner(visa, "made_global");
    return { outcome, visa };
  }

  // ------------------------------------------
  // Helpers
  // ------------------------------------------

  /** Read a visa doc back after a write. */
  private async read(ref: DocumentReference): Promise<VisaType> {
    const snap = await ref.get();
    return { id: snap.id, ...snap.data() } as VisaType;
  }

  /**
   * Recompute the country's denormalized stats (visaTypesCount, mins) after
   * a write that may change the public set. Best effort: the action is
   * already committed and the onVisaTypeUpdated trigger reconciles, so a
   * failure is logged, never thrown.
   */
  private async recomputeStats(cc: string, visaId: string): Promise<void> {
    try {
      await visaService.updateCountryStats(cc);
    } catch (error) {
      console.error(`[agency-visa-review] ${cc}/${visaId} saved but the country stats recompute failed:`, error);
    }
  }

  /**
   * Email the owning agency's owner about a decision, through notifyUser
   * (Resend; notifyUser checks the provider's EmailResult and logs a
   * non-"sent" status). NEVER throws: the action is committed, so any
   * failure (agency or owner missing, notifyUser rejecting) is logged with
   * the visa and kind, and the response is still a success.
   *
   * Copy: Seli's voice (second person, short, says what happens next) and
   * names the visa in the title, which is also the email subject.
   */
  async emailOwner(
    visa: VisaType,
    kind: "approved" | "rejected" | "revision_approved" | "revision_rejected" | "made_global",
    reason?: string
  ): Promise<void> {
    try {
      if (!visa.ownerAgencyId) {
        console.error(`[agency-visa-review] ${visa.countryCode}/${visa.id}: no ownerAgencyId, ${kind} email not sent`);
        return;
      }
      const agencySnap = await collections.agencies.doc(visa.ownerAgencyId).get();
      const ownerId = agencySnap.exists ? (agencySnap.data() as Agency | undefined)?.ownerId : undefined;
      if (!ownerId) {
        console.error(
          `[agency-visa-review] ${visa.countryCode}/${visa.id}: agency ${visa.ownerAgencyId} has no owner, ${kind} email not sent`
        );
        return;
      }
      await this.notify({ userId: ownerId, ...ownerEmailCopy(visa, kind, reason) });
    } catch (error) {
      console.error(`[agency-visa-review] ${visa.countryCode}/${visa.id}: ${kind} email failed:`, error);
    }
  }
}

/**
 * The notification (type, title, body, entity) for each decision. Exported
 * for tests. The title names the visa and doubles as the email subject
 * (the event templates for these types have no fixed subject).
 */
export function ownerEmailCopy(
  visa: VisaType,
  kind: "approved" | "rejected" | "revision_approved" | "revision_rejected" | "made_global",
  reason?: string
): Omit<NotifyUserInput, "userId"> {
  const name = visa.name;
  const entity = { relatedEntityType: "visa" as const, relatedEntityId: visa.id };
  const why = reason ? ` Reason: ${reason}` : "";
  switch (kind) {
  case "approved":
    return {
      type: "agency_visa_approved",
      title: `Seli approved ${name}`,
      body:
          `${name} is approved. Your agents can now start cases on it, ` +
          "and it’s on your agency page. Only your agency’s clients can see it for now.",
      ...entity,
    };
  case "revision_approved":
    return {
      type: "agency_visa_approved",
      title: `Seli approved your changes to ${name}`,
      body: `Your changes to ${name} are approved and live now.`,
      ...entity,
    };
  case "rejected":
    return {
      type: "agency_visa_rejected",
      title: `${name} needs changes`,
      body: `Seli didn’t approve ${name}.${why} Edit the visa and submit it again when you’re ready.`,
      ...entity,
    };
  case "revision_rejected":
    return {
      type: "agency_visa_rejected",
      title: `Your changes to ${name} need work`,
      body:
          `Seli didn’t approve your changes to ${name}.${why} ` +
          "The approved version stays live. Edit your changes to send them again.",
      ...entity,
    };
  case "made_global":
    return {
      type: "agency_visa_made_global",
      title: `${name} is now on Seli for everyone`,
      body:
          `Seli added ${name} to the Explorer, so every applicant can find it. ` +
          "It still shows your agency as its creator.",
      ...entity,
    };
  }
}

export const agencyVisaReviewService = new AgencyVisaReviewService();
