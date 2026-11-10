// ============================================
// Agency visas: storage + state machine (issue #100)
// ============================================
//
// Where things live (contract: ./agency-visas.md):
//  - The visa itself: `countries/{cc}/visaTypes/{id}`, the SAME collection
//    as seed and scraped visas, so the admin review endpoint, the public
//    reads (#99 visibility rule) and case creation all work unchanged.
//  - A pending edit to an APPROVED visa: `visaRevisions/{cc}__{id}` (top
//    level, one per visa). The live doc is never touched by an agency edit
//    once approved.
//
// States (`VisaType.reviewStatus` of an agency visa):
//   draft --submit--> pending_review --admin--> approved | rejected
//   rejected --edit/submit--> pending_review
//   approved --edit--> (live unchanged) + visaRevisions doc pending_review
//
// Authorization: every lookup is scoped to the caller's agency in the QUERY
// (`ownerAgencyId == agencyId`), so another agency's visa is simply not
// found (404, no existence leak). On top of that, every operation calls an
// `authorize(doc)` callback from the controller, which checks the shared
// CASL ability on the doc tagged with `asSubject("Visa", doc)`. The service
// itself knows nothing about roles.

import { FieldValue, Timestamp, Transaction } from "firebase-admin/firestore";
import { AGENCY_VISA_SOURCE } from "@durin-tech/authz";
import { collectionGroups, collections, db, subcollections } from "../utils/firebase";
import { VISA_VISIBILITY, VisaRevision, VisaType } from "../types";
import { visaService } from "../services/visa.service";
import {
  AgencyVisaContent,
  AgencyVisaError,
  ParsedAgencyVisaBody,
  assertCompleteContent,
  diffContent,
  mergeContent,
  pickContent,
} from "./agency-visa.validation";

// ============================================
// Types
// ============================================

/**
 * What the agency endpoints return for one visa: the visa as stored (live
 * values, review state, visibility, rejection reason) plus its pending
 * revision, or null when there is none.
 */
export type AgencyVisaView = VisaType & { pendingRevision: VisaRevision | null };

/**
 * Authorization callback from the controller: true when the caller's CASL
 * ability allows the operation on this doc (and, for updates, on each
 * written field). Called on the freshly read doc, inside the transaction.
 */
export type AuthorizeVisa = (visa: VisaType, fields?: string[]) => boolean;

/** The caller: their agency (from the token claims) and uid. */
export interface AgencyVisaActor {
  agencyId: string;
  uid: string;
}

/** The single 404 for "unknown id" AND "another agency's id" (same body). */
export function visaNotFound(): AgencyVisaError {
  return new AgencyVisaError("NOT_FOUND", "Visa not found", 404);
}

/** Revision doc id for a visa: `${countryCode}__${visaId}`. */
export function revisionId(countryCode: string, visaId: string): string {
  return `${countryCode}__${visaId}`;
}

// ============================================
// Service
// ============================================

class AgencyVisaService {
  /** Transaction runner; swapped for an in-memory one in unit tests. */
  runTransaction: <T>(fn: (tx: Transaction) => Promise<T>) => Promise<T> = (fn) => db.runTransaction(fn);

  /** Clock; swappable in tests. */
  now: () => Timestamp = () => Timestamp.now();

  // ------------------------------------------
  // Lookups (always scoped to the caller's agency)
  // ------------------------------------------

  /**
   * Find one of THIS agency's visas by id, across all countries.
   *
   * Query: collection group `visaTypes` where `ownerAgencyId == agencyId`
   * and `id == visaId` (index: visaTypes ownerAgencyId + id,
   * COLLECTION_GROUP). Visa docs store their own id in the `id` field. An
   * unknown id and another agency's id both return null.
   * A doc that matches but is not `source: "agency"` (should never exist) is
   * ignored too, so this can never reach a scraped or seed visa.
   */
  async findOwned(agencyId: string, visaId: string) {
    const snap = await collectionGroups
      .visaTypes()
      .where("ownerAgencyId", "==", agencyId)
      .where("id", "==", visaId)
      .limit(1)
      .get();
    const doc = snap.docs[0];
    if (!doc) return null;
    const visa = { id: doc.id, ...doc.data() } as VisaType;
    if (visa.source !== AGENCY_VISA_SOURCE || visa.ownerAgencyId !== agencyId) return null;
    return { ref: doc.ref, visa };
  }

  /** The revision of one visa, or null. */
  async getRevision(countryCode: string, visaId: string): Promise<VisaRevision | null> {
    const snap = await collections.visaRevisions.doc(revisionId(countryCode, visaId)).get();
    return snap.exists ? (snap.data() as VisaRevision) : null;
  }

  /**
   * `GET /agency/visas`: every visa of this agency, newest first, each with
   * its pending revision. `authorize` drops any doc the ability can't read
   * (defence in depth: the query is already agency-scoped).
   *
   * Queries: collection group `visaTypes` where `ownerAgencyId ==` ordered by
   * `createdAt desc` (index: visaTypes ownerAgencyId + createdAt desc,
   * COLLECTION_GROUP); `visaRevisions` where `ownerAgencyId ==` (single
   * field, automatic index).
   */
  async list(agencyId: string, authorize: AuthorizeVisa): Promise<AgencyVisaView[]> {
    const [visaSnap, revSnap] = await Promise.all([
      collectionGroups.visaTypes().where("ownerAgencyId", "==", agencyId).orderBy("createdAt", "desc").get(),
      collections.visaRevisions.where("ownerAgencyId", "==", agencyId).get(),
    ]);
    // Revisions by their doc id (cc__visaId) for the join.
    const revisions = new Map<string, VisaRevision>();
    for (const d of revSnap.docs) revisions.set(d.id, d.data() as VisaRevision);

    return visaSnap.docs
      .map((d) => ({ id: d.id, ...d.data() }) as VisaType)
      .filter((v) => v.source === AGENCY_VISA_SOURCE && v.ownerAgencyId === agencyId && authorize(v))
      .map((v) => ({ ...v, pendingRevision: revisions.get(revisionId(v.countryCode, v.id)) ?? null }));
  }

  /** `GET /agency/visas/:id`: one visa + its revision; 404 when not this agency's. */
  async get(agencyId: string, visaId: string, authorize: AuthorizeVisa): Promise<AgencyVisaView> {
    const found = await this.findOwned(agencyId, visaId);
    if (!found || !authorize(found.visa)) throw visaNotFound();
    const pendingRevision = await this.getRevision(found.visa.countryCode, found.visa.id);
    return { ...found.visa, pendingRevision };
  }

  // ------------------------------------------
  // Create
  // ------------------------------------------

  /**
   * Build the draft doc ON THE SERVER (pure apart from the new doc id).
   * Ownership, source, visibility, review state and activation come from
   * here, never from the request body:
   *   ownerAgencyId = caller's agency, createdBy = caller's uid,
   *   source = AGENCY_VISA_SOURCE, visibility = "agency",
   *   reviewStatus = "draft", isActive = false, agentIds = [].
   */
  buildDraft(id: string, content: AgencyVisaContent, actor: AgencyVisaActor, now: Timestamp): VisaType {
    return {
      ...content,
      id,
      countryCode: content.countryCode,
      source: AGENCY_VISA_SOURCE,
      ownerAgencyId: actor.agencyId,
      createdBy: actor.uid,
      visibility: VISA_VISIBILITY.AGENCY,
      reviewStatus: "draft",
      isActive: false,
      agentIds: [],
      createdAt: now,
      updatedAt: now,
    } as VisaType;
  }

  /**
   * `POST /agency/visas`: write a new draft.
   *
   * @param content a complete, validated body (parseAgencyVisaBody "create")
   * @param authorize CASL `create` check on the built draft; false -> 403
   * @throws AgencyVisaError 400 (unknown country), 403 (ability says no)
   */
  async create(content: AgencyVisaContent, actor: AgencyVisaActor, authorize: AuthorizeVisa): Promise<AgencyVisaView> {
    // ---- countryCode must be a real country ----
    const country = await visaService.getCountryByCode(content.countryCode);
    if (!country) {
      throw new AgencyVisaError("VALIDATION_ERROR", "countryCode: unknown country", 400, "countryCode");
    }

    const ref = subcollections.visaTypes(content.countryCode).doc();
    const draft = this.buildDraft(ref.id, content, actor, this.now());

    // ---- CASL `create` on the doc we are about to write ----
    if (!authorize(draft)) {
      throw new AgencyVisaError("FORBIDDEN", "You cannot create visas for this agency", 403);
    }

    // Hidden draft: no country stats change (only public visas count), so no
    // recompute here; the onVisaTypeUpdated trigger runs anyway.
    await ref.set(draft);
    return { ...draft, pendingRevision: null };
  }

  // ------------------------------------------
  // Update
  // ------------------------------------------

  /**
   * `PUT|PATCH /agency/visas/:id`: partial update.
   *
   *  - draft / rejected: written to the visa doc (status unchanged; a
   *    rejected visa keeps its reason until it is resubmitted).
   *  - pending_review: 409 VISA_IN_REVIEW (wait for the admin).
   *  - approved: the live doc is NOT written. The merged proposal (live +
   *    existing revision + this body) is diffed against the live content and
   *    stored as `visaRevisions/{cc}__{id}` with `reviewStatus:
   *    "pending_review"` (a rejected revision is reopened, its reason
   *    cleared). A body that brings everything back to the live values
   *    deletes the revision.
   *
   * `countryCode` can't change (it is part of the doc path): a different one
   * is a 400.
   *
   * Runs in a transaction: the doc is re-read, so a concurrent submit or
   * review can't be overwritten with a stale state decision.
   *
   * @param authorize CASL `update` on the doc + each written field
   * @throws AgencyVisaError 400 / 404 / 409
   */
  async update(
    visaId: string,
    parsed: ParsedAgencyVisaBody,
    actor: AgencyVisaActor,
    authorize: AuthorizeVisa
  ): Promise<AgencyVisaView> {
    const found = await this.findOwned(actor.agencyId, visaId);
    if (!found) throw visaNotFound();
    const { ref } = found;
    const cc = found.visa.countryCode;
    const revRef = collections.visaRevisions.doc(revisionId(cc, visaId));

    // ---- countryCode is immutable ----
    if (parsed.fields.countryCode !== undefined && parsed.fields.countryCode !== cc) {
      throw new AgencyVisaError(
        "VALIDATION_ERROR",
        "countryCode: cannot be changed after the visa is created",
        400,
        "countryCode"
      );
    }

    // Fields this request writes (for the per-field CASL check).
    const written = [...Object.keys(parsed.fields), ...parsed.cleared];

    await this.runTransaction(async (tx) => {
      // ---- Re-read inside the transaction ----
      const snap = await tx.get(ref);
      if (!snap.exists) throw visaNotFound();
      const visa = { id: snap.id, ...snap.data() } as VisaType;
      if (visa.ownerAgencyId !== actor.agencyId || visa.source !== AGENCY_VISA_SOURCE) throw visaNotFound();
      if (!authorize(visa, written)) throw visaNotFound();

      const now = this.now();
      const status = visa.reviewStatus;

      if (status === "pending_review") {
        throw new AgencyVisaError(
          "VISA_IN_REVIEW",
          "This visa is waiting for Seli's review and can't be edited until then",
          409
        );
      }

      if (status === "approved") {
        // ---- Approved: stage a revision, leave the live doc alone ----
        const revSnap = await tx.get(revRef);
        const prior = revSnap.exists ? (revSnap.data() as VisaRevision) : null;
        const live = pickContent(visa);
        // Proposal = live + earlier revision changes (null = removed) + body.
        const base: Record<string, unknown> = { ...live };
        for (const [k, v] of Object.entries(prior?.changes ?? {})) {
          if (v === null) delete base[k];
          else base[k] = v;
        }
        const proposed = mergeContent(base as Partial<AgencyVisaContent>, parsed);
        assertCompleteContent(proposed);
        const changes = diffContent(live, proposed);

        if (Object.keys(changes).length === 0) {
          // Nothing differs from the live visa any more: no revision.
          if (prior) tx.delete(revRef);
          return;
        }
        const revision: VisaRevision = {
          id: revRef.id,
          visaId,
          countryCode: cc,
          ownerAgencyId: actor.agencyId,
          changes,
          reviewStatus: "pending_review",
          submittedBy: actor.uid,
          submittedAt: now,
          createdAt: prior?.createdAt ?? now,
          updatedAt: now,
        };
        // set() without merge: a reopened rejected revision loses its old
        // rejectionReason / reviewedBy / reviewedAt.
        tx.set(revRef, revision);
        return;
      }

      // ---- Draft / rejected: write the doc ----
      const merged = mergeContent(pickContent(visa), parsed);
      assertCompleteContent(merged);
      const update: Record<string, unknown> = { ...parsed.fields, updatedAt: now };
      for (const field of parsed.cleared) update[field] = FieldValue.delete();
      tx.update(ref, update);
    });

    return this.get(actor.agencyId, visaId, () => true);
  }

  // ------------------------------------------
  // Submit
  // ------------------------------------------

  /**
   * `POST /agency/visas/:id/submit`: draft or rejected -> pending_review.
   *
   * Writes `reviewStatus: "pending_review"`, `isActive: false` (explicit, so
   * a submitted visa is never live), `submittedAt` / `submittedBy`, and
   * removes `rejectionReason`. These are protected fields: the SERVER writes
   * them as a state transition; the request body can't carry them.
   *
   * @throws 404 (not this agency's), 409 ALREADY_SUBMITTED (pending_review),
   *   409 VISA_APPROVED (approved: edits become revisions automatically),
   *   400 (required fields missing / invalid)
   */
  async submit(visaId: string, actor: AgencyVisaActor, authorize: AuthorizeVisa): Promise<AgencyVisaView> {
    const found = await this.findOwned(actor.agencyId, visaId);
    if (!found) throw visaNotFound();
    const { ref } = found;

    await this.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) throw visaNotFound();
      const visa = { id: snap.id, ...snap.data() } as VisaType;
      if (visa.ownerAgencyId !== actor.agencyId || visa.source !== AGENCY_VISA_SOURCE) throw visaNotFound();
      if (!authorize(visa)) throw visaNotFound();

      if (visa.reviewStatus === "pending_review") {
        throw new AgencyVisaError("ALREADY_SUBMITTED", "This visa is already waiting for review", 409);
      }
      if (visa.reviewStatus === "approved") {
        throw new AgencyVisaError(
          "VISA_APPROVED",
          "This visa is already approved; edits to it are sent for review automatically",
          409
        );
      }
      // draft or rejected: the full set must be there.
      assertCompleteContent(pickContent(visa));

      const now = this.now();
      tx.update(ref, {
        reviewStatus: "pending_review",
        isActive: false,
        rejectionReason: FieldValue.delete(),
        submittedAt: now,
        submittedBy: actor.uid,
        updatedAt: now,
      });
    });

    return this.get(actor.agencyId, visaId, () => true);
  }

  // ------------------------------------------
  // Delete
  // ------------------------------------------

  /**
   * `DELETE /agency/visas/:id`: drafts only (never submitted). A visa that
   * was ever submitted (pending_review, approved, rejected) is part of the
   * review record and can't be deleted: 409 NOT_A_DRAFT.
   */
  async remove(visaId: string, actor: AgencyVisaActor, authorize: AuthorizeVisa): Promise<void> {
    const found = await this.findOwned(actor.agencyId, visaId);
    if (!found) throw visaNotFound();
    const { ref } = found;

    await this.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) throw visaNotFound();
      const visa = { id: snap.id, ...snap.data() } as VisaType;
      if (visa.ownerAgencyId !== actor.agencyId || visa.source !== AGENCY_VISA_SOURCE) throw visaNotFound();
      if (!authorize(visa)) throw visaNotFound();
      // `submittedAt` is a second guard: only a never-submitted draft goes.
      if (visa.reviewStatus !== "draft" || visa.submittedAt !== undefined) {
        throw new AgencyVisaError("NOT_A_DRAFT", "Only drafts that were never submitted can be deleted", 409);
      }
      tx.delete(ref);
    });
  }
}

export const agencyVisaService = new AgencyVisaService();
