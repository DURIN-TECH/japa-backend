/**
 * DocumentRequestService — persistence for "an agent asked this client for a
 * specific document".
 *
 * Background: requesting a document used to be fire-and-forget (an activity note
 * plus a notification). Nothing was queryable afterwards, so a client who opened
 * the web workspace later had no way to see what was still outstanding. This
 * service backs the durable `documentRequests` collection that gives the client a
 * checklist and the agent a fulfilment view.
 *
 * Every read path here is deliberately narrow — callers pass an already-authorized
 * scope (a client's own uid, an agent's uid, or an agencyId). Authorization itself
 * lives in the controller; this layer only shapes queries and writes.
 */
import { collections } from "../utils/firebase";
import {
  DocumentRequest,
  DocumentRequestStatus,
  CHECKLIST_SYSTEM_ACTOR_ID,
  CHECKLIST_SYSTEM_ACTOR_NAME,
} from "../types";
import type { ChecklistItem } from "./ai/checklist-builder";
import { Timestamp, FieldValue } from "firebase-admin/firestore";

/** Fields a caller supplies when raising a new request. */
export interface CreateDocumentRequestInput {
  applicationId: string;
  /** The client the request is addressed to (Application.userId). */
  userId: string;
  agencyId?: string | null;
  documentType: string;
  notes?: string;
  /** ISO date string from the client; converted to a Timestamp below. */
  dueDate?: string;
  requestedBy: string;
  requestedByName: string;
  visaTypeName?: string;
  countryName?: string;
}

/** Filters accepted by `list`. At least one scope key must be provided. */
export interface ListDocumentRequestsFilter {
  /** Client scope — their own outstanding asks across every application. */
  userId?: string;
  /** Agent scope — everything this agent personally raised. */
  requestedBy?: string;
  /** Agency scope — everything raised by anyone in the agency. */
  agencyId?: string;
  /** Narrow to a single case (used by the case-detail panel). */
  applicationId?: string;
  /** Narrow by lifecycle state; omit for "all". */
  status?: DocumentRequestStatus;
}

class DocumentRequestService {
  /**
   * Create a pending request. Returns the stored record so the caller can echo
   * it back to the portal without a re-read.
   *
   * `undefined` optional fields are stripped before the write — Firestore rejects
   * explicit `undefined` values, and a missing key reads back as absent anyway.
   */
  async create(input: CreateDocumentRequestInput): Promise<DocumentRequest> {
    const ref = collections.documentRequests.doc();
    const now = Timestamp.now();

    const request: DocumentRequest = {
      id: ref.id,
      applicationId: input.applicationId,
      userId: input.userId,
      agencyId: input.agencyId ?? null,
      documentType: input.documentType.trim(),
      status: "pending",
      requestedBy: input.requestedBy,
      requestedByName: input.requestedByName,
      createdAt: now,
      updatedAt: now,
      // Optional fields — only set when actually provided (see note above).
      ...(input.notes?.trim() ? { notes: input.notes.trim() } : {}),
      ...(input.dueDate
        ? { dueDate: Timestamp.fromDate(new Date(input.dueDate)) }
        : {}),
      ...(input.visaTypeName ? { visaTypeName: input.visaTypeName } : {}),
      ...(input.countryName ? { countryName: input.countryName } : {}),
    };

    await ref.set(request);
    return request;
  }

  /** Fetch one request by id, or null when it doesn't exist. */
  async getById(id: string): Promise<DocumentRequest | null> {
    const snap = await collections.documentRequests.doc(id).get();
    return snap.exists ? (snap.data() as DocumentRequest) : null;
  }

  /**
   * List requests within a caller-supplied scope, newest first.
   *
   * IMPLEMENTATION NOTE — sorting happens in memory rather than via `orderBy`.
   * Every combination of (scope field + optional status + optional applicationId
   * + orderBy createdAt) would need its own Firestore composite index; the result
   * sets here are inherently small (the outstanding asks on a handful of cases),
   * so an in-memory sort buys us index-free flexibility at negligible cost.
   */
  async list(filter: ListDocumentRequestsFilter): Promise<DocumentRequest[]> {
    let query: FirebaseFirestore.Query = collections.documentRequests;

    // Scope — exactly one of these is set by the controller based on the caller's
    // role, so a client can never widen the query beyond their own records.
    if (filter.userId) query = query.where("userId", "==", filter.userId);
    if (filter.requestedBy) {
      query = query.where("requestedBy", "==", filter.requestedBy);
    }
    if (filter.agencyId) query = query.where("agencyId", "==", filter.agencyId);

    // Optional narrowing.
    if (filter.applicationId) {
      query = query.where("applicationId", "==", filter.applicationId);
    }
    if (filter.status) query = query.where("status", "==", filter.status);

    const snapshot = await query.get();
    const requests = snapshot.docs.map((d) => d.data() as DocumentRequest);

    // Newest first. `toMillis()` is guarded because a hand-seeded doc could carry
    // a plain object rather than a real Timestamp.
    return requests.sort((a, b) => {
      const aMs = a.createdAt?.toMillis?.() ?? 0;
      const bMs = b.createdAt?.toMillis?.() ?? 0;
      return bMs - aMs;
    });
  }

  /**
   * Mark a request fulfilled by a specific uploaded document.
   *
   * Idempotent-ish: a request that has already left `pending` is left untouched,
   * so a client re-uploading against a waived/cancelled ask can't resurrect it.
   * Returns true when this call actually transitioned the record.
   */
  async markFulfilled(id: string, documentId: string): Promise<boolean> {
    const ref = collections.documentRequests.doc(id);
    const snap = await ref.get();
    if (!snap.exists) return false;

    const existing = snap.data() as DocumentRequest;
    if (existing.status !== "pending") return false;

    await ref.update({
      status: "fulfilled",
      fulfilledDocumentId: documentId,
      fulfilledAt: Timestamp.now(),
      updatedAt: Timestamp.now(),
    });
    return true;
  }

  /**
   * Move a pending request to a terminal agent-driven state (`waived` or
   * `cancelled`). Returns the updated record, or null if it no longer exists.
   */
  async resolve(
    id: string,
    status: Extract<DocumentRequestStatus, "waived" | "cancelled">,
    resolvedBy: string
  ): Promise<DocumentRequest | null> {
    const ref = collections.documentRequests.doc(id);
    const snap = await ref.get();
    if (!snap.exists) return null;

    await ref.update({
      status,
      resolvedBy,
      updatedAt: Timestamp.now(),
    });

    const updated = await ref.get();
    return updated.data() as DocumentRequest;
  }

  /**
   * All checklist-origin requests of one application (any status).
   * Two equality filters only, so no composite index is needed.
   */
  async listChecklistForApplication(applicationId: string): Promise<DocumentRequest[]> {
    const snap = await collections.documentRequests
      .where("applicationId", "==", applicationId)
      .where("origin", "==", "checklist")
      .get();
    return snap.docs.map((d) => d.data() as DocumentRequest);
  }

  /**
   * Make the stored checklist requests match `items` (issue #114). SERVER-SIDE
   * ONLY: the caller has already authorised the applicant; this is not the
   * `POST /document-requests` path, which still bars applicants.
   *
   *  - missing item        -> created `pending`, deterministic id
   *                           `{applicationId}__{checklistItemId}` (so running
   *                           twice cannot duplicate, even concurrently:
   *                           `create()` fails if the doc exists);
   *  - existing + pending  -> wording/citation refreshed in place;
   *  - pending no longer on the list -> `cancelled`, resolvedBy "system";
   *  - fulfilled / waived / cancelled -> NEVER touched or reopened.
   * Returns counts for logging/tests.
   */
  async syncChecklist(
    application: {
      id: string;
      userId: string;
      agencyId?: string | null;
      visaTypeName?: string;
      countryName?: string;
    },
    items: ChecklistItem[]
  ): Promise<{ created: number; updated: number; cancelled: number }> {
    const existing = await this.listChecklistForApplication(application.id);
    const byItemId = new Map(existing.map((r) => [r.checklistItemId, r]));
    const wanted = new Set(items.map((i) => i.checklistItemId));
    const counts = { created: 0, updated: 0, cancelled: 0 };
    const now = Timestamp.now();

    for (const item of items) {
      const found = byItemId.get(item.checklistItemId);
      const fields = {
        documentType: item.title,
        holder: item.holder,
        reason: item.reason,
        required: item.required,
        citation: item.citation,
        ...(item.criterionRef ? { criterionRef: item.criterionRef } : {}),
      };
      if (!found) {
        const ref = collections.documentRequests.doc(`${application.id}__${item.checklistItemId}`);
        const request: DocumentRequest = {
          id: ref.id,
          applicationId: application.id,
          userId: application.userId,
          agencyId: application.agencyId ?? null,
          status: "pending",
          requestedBy: CHECKLIST_SYSTEM_ACTOR_ID,
          requestedByName: CHECKLIST_SYSTEM_ACTOR_NAME,
          origin: "checklist",
          checklistItemId: item.checklistItemId,
          ...fields,
          ...(application.visaTypeName ? { visaTypeName: application.visaTypeName } : {}),
          ...(application.countryName ? { countryName: application.countryName } : {}),
          createdAt: now,
          updatedAt: now,
        };
        try {
          await ref.create(request);
          counts.created++;
        } catch (e) {
          // ALREADY_EXISTS: a concurrent run won the race. Fine (idempotent).
          if ((e as { code?: number }).code !== 6) throw e;
        }
      } else if (found.status === "pending") {
        await collections.documentRequests.doc(found.id).update({ ...fields, updatedAt: now });
        counts.updated++;
      } else if (found.status === "cancelled" && found.resolvedBy === CHECKLIST_SYSTEM_ACTOR_ID) {
        // The system itself cancelled it (the answer changed) and the answer
        // changed back: bring it back. A request an agent cancelled stays cancelled.
        await collections.documentRequests.doc(found.id).update({
          ...fields,
          status: "pending",
          resolvedBy: FieldValue.delete(),
          updatedAt: now,
        });
        counts.updated++;
      }
    }

    // Items no longer needed: cancel only the still-pending ones.
    for (const r of existing) {
      if (r.status === "pending" && r.checklistItemId && !wanted.has(r.checklistItemId)) {
        await collections.documentRequests.doc(r.id).update({
          status: "cancelled",
          resolvedBy: CHECKLIST_SYSTEM_ACTOR_ID,
          updatedAt: now,
        });
        counts.cancelled++;
      }
    }
    return counts;
  }

  /**
   * Count a client's outstanding (pending) requests — powers the "N items need
   * your attention" badge without shipping the full list to the caller.
   */
  async countPendingForUser(userId: string): Promise<number> {
    const snapshot = await collections.documentRequests
      .where("userId", "==", userId)
      .where("status", "==", "pending")
      .count()
      .get();
    return snapshot.data().count;
  }
}

// Singleton — matches the pattern used by every other service in this app.
export const documentRequestService = new DocumentRequestService();
