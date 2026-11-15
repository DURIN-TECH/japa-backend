import { collections } from "../utils/firebase";
import { Consultation, ConsultationStatus } from "../types";
import { Timestamp } from "firebase-admin/firestore";
import { ROLES } from "@durin-tech/authz";
// Issue #151: the shared clock and Firestore transaction runner of the charge
// path (tests swap both through the consultations harness). The status change
// uses the SAME clock as the quote lock it reads, and the same runner as
// `settlePayment`, so a cancel and a payment can never interleave.
import { chargeRuntime, isQuoteExpired } from "./charge-checkout.service";

// ============================================
// STATUS TRANSITION RULES (issue #151)
// ============================================
//
// Who may move a consultation to which status, and from which status. This is
// the ONE place the rules live: `PUT /consultations/:id/status` uses it today
// and the `PUT /consultations/:id` follow-up (#316) is meant to reuse it.
//
// The two parties of a booking:
//  - the CLIENT: the booking's `userId`;
//  - the AGENT SIDE: the booking's `agentId` (a user uid), the owner of the
//    booking's agency, or an admin.
// Working out which party a caller is belongs to the controller (it knows
// the request's principal); this file only decides what a party may do.

/** The party of a booking a caller acts as. */
export const CONSULTATION_ACTORS = {
  /** The booking's own client (`userId`). */
  CLIENT: ROLES.CLIENT,
  /** The booking's agent, its agency's owner, or an admin. */
  AGENT_SIDE: "agent_side",
} as const;
export type ConsultationActor = (typeof CONSULTATION_ACTORS)[keyof typeof CONSULTATION_ACTORS];

/** Every status a consultation can hold (also the list a request's `status` is checked against). */
export const CONSULTATION_STATUSES: ConsultationStatus[] = [
  "pending_payment", "scheduled", "confirmed", "in_progress",
  "completed", "cancelled", "no_show",
];

/**
 * Statuses nobody may SET through the API: `pending_payment` is written only
 * by booking creation, and `scheduled` only by booking creation (free) or by
 * payment verification (`settlePayment`). Letting a caller write `scheduled`
 * is exactly how an unpaid booking used to be marked as booked.
 */
export const SYSTEM_ONLY_STATUSES: ConsultationStatus[] = ["pending_payment", "scheduled"];

/**
 * The transition table: for each party, target status -> the statuses it may
 * be reached FROM. A target missing for a party is one that party may never
 * set. Terminal statuses (`completed`, `cancelled`, `no_show`) appear in no
 * "from" list, so nothing ever leaves them; an unpaid `pending_payment`
 * booking can only be cancelled.
 */
export const STATUS_TRANSITIONS: Record<
  ConsultationActor,
  Partial<Record<ConsultationStatus, ConsultationStatus[]>>
> = {
  // A client can only cancel, and only before the consultation has started.
  [CONSULTATION_ACTORS.CLIENT]: {
    cancelled: ["pending_payment", "scheduled", "confirmed"],
  },
  [CONSULTATION_ACTORS.AGENT_SIDE]: {
    confirmed: ["scheduled"],
    in_progress: ["scheduled", "confirmed"],
    completed: ["scheduled", "confirmed", "in_progress"],
    no_show: ["scheduled", "confirmed", "in_progress"],
    cancelled: ["pending_payment", "scheduled", "confirmed"],
  },
};

/** Why a status change was refused: the API error code and its HTTP status. */
export interface StatusChangeRefusal {
  ok: false;
  code: "FORBIDDEN" | "VALIDATION_ERROR" | "INVALID_STATUS_TRANSITION" | "PAYMENT_IN_PROGRESS";
  httpStatus: 400 | 403 | 409;
  message: string;
}
export type StatusChangeDecision = { ok: true } | StatusChangeRefusal;

/**
 * True while a Paystack payment may still land on an unpaid booking: it is
 * `pending_payment`, a checkout was opened (`transactionId`), and that
 * checkout's quote lock (`quoteExpiresAt`) has not passed. The lock is used
 * rather than a Paystack lookup so the rule is the same on the emulators.
 * A booking with no lock at all (legacy naira rows) counts as expired.
 */
export function isPaymentInFlight(
  c: Pick<Consultation, "status" | "transactionId" | "quoteExpiresAt">,
  at: Date
): boolean {
  return c.status === "pending_payment" && !!c.transactionId && !isQuoteExpired(c, at);
}

/**
 * Decide whether `actor` may move `booking` to `target` at time `at`.
 * Pure: reads nothing, writes nothing. Checks run in this order, and the
 * first that fails is the answer:
 *
 *  1. `target` is `pending_payment` or `scheduled`: 400 VALIDATION_ERROR, for
 *     anyone (only booking creation and payment verify write those).
 *  2. `actor` is null (the caller is not a party of the booking): 403.
 *  3. The party may never set `target` (a client setting anything but
 *     `cancelled`): 403 FORBIDDEN.
 *  4. The party may set `target`, but not from the booking's current status
 *     (wrong starting state, a terminal status, or an unpaid booking to
 *     anything but `cancelled`): 409 INVALID_STATUS_TRANSITION.
 *  5. Cancelling while a payment is in flight (see `isPaymentInFlight`):
 *     409 PAYMENT_IN_PROGRESS.
 */
export function decideStatusChange(
  actor: ConsultationActor | null,
  booking: Pick<Consultation, "status" | "transactionId" | "quoteExpiresAt">,
  target: ConsultationStatus,
  at: Date
): StatusChangeDecision {
  if (SYSTEM_ONLY_STATUSES.includes(target)) {
    return {
      ok: false,
      code: "VALIDATION_ERROR",
      httpStatus: 400,
      message: `A consultation cannot be set to ${target}: that status is set when it is booked or paid`,
    };
  }
  if (!actor) {
    return { ok: false, code: "FORBIDDEN", httpStatus: 403, message: "You do not have permission to perform this action" };
  }
  const allowedFrom = STATUS_TRANSITIONS[actor][target];
  if (!allowedFrom) {
    return { ok: false, code: "FORBIDDEN", httpStatus: 403, message: "You do not have permission to perform this action" };
  }
  if (!allowedFrom.includes(booking.status)) {
    return {
      ok: false,
      code: "INVALID_STATUS_TRANSITION",
      httpStatus: 409,
      message: `A consultation that is ${booking.status} cannot be set to ${target}`,
    };
  }
  if (target === "cancelled" && isPaymentInFlight(booking, at)) {
    return {
      ok: false,
      code: "PAYMENT_IN_PROGRESS",
      httpStatus: 409,
      message: "A payment for this booking may still be in progress. Try again once the checkout has expired.",
    };
  }
  return { ok: true };
}

/** What `changeStatus` did. `refused` and `not_found` wrote nothing. */
export type ChangeStatusOutcome =
  | { kind: "not_found" }
  | { kind: "refused"; refusal: StatusChangeRefusal }
  | { kind: "changed"; before: Consultation; consultation: Consultation };

/** What `deleteUnpaidConsultation` did. Only `deleted` removed anything. */
export type DeleteConsultationOutcome =
  | { kind: "not_found" }
  | { kind: "has_payment" }
  | { kind: "deleted"; consultation: Consultation };

/**
 * True when a booking has, or may still receive, a payment: a Paystack
 * checkout was opened for it (`transactionId`, kept after it is paid) or it
 * is marked paid. Such a booking must never be hard-deleted (issue #151): a
 * payment that lands afterwards would find no booking and `settlePayment`
 * would return null, leaving the money unrecorded.
 */
export function bookingHasPayment(c: Pick<Consultation, "transactionId" | "paymentStatus">): boolean {
  return !!c.transactionId || c.paymentStatus === "paid";
}

export interface ConsultationFilters {
  status?: ConsultationStatus;
  applicationId?: string;
  type?: string;
  startDate?: string;
  endDate?: string;
}

export interface ConsultationStats {
  total: number;
  upcoming: number;
  completed: number;
  cancelled: number;
  noShow: number;
}

class ConsultationService {
  /**
   * Get consultations where the user is the assigned agent.
   */
  async getConsultationsForAgent(
    agentUserId: string,
    filters?: ConsultationFilters
  ): Promise<Consultation[]> {
    let query = collections.consultations
      .where("agentId", "==", agentUserId)
      .orderBy("scheduledDate", "desc") as FirebaseFirestore.Query;

    query = this.applyFilters(query, filters);
    const snapshot = await query.get();
    return snapshot.docs.map((doc) => doc.data() as Consultation);
  }

  /**
   * Get all consultations for agents in an agency.
   */
  async getConsultationsForAgency(
    agencyId: string,
    filters?: ConsultationFilters
  ): Promise<Consultation[]> {
    let query = collections.consultations
      .where("agencyId", "==", agencyId)
      .orderBy("scheduledDate", "desc") as FirebaseFirestore.Query;

    query = this.applyFilters(query, filters);
    const snapshot = await query.get();
    return snapshot.docs.map((doc) => doc.data() as Consultation);
  }

  /**
   * Get consultations where the user is the client (userId).
   * Used by mobile app clients to see their booked consultations.
   */
  async getConsultationsForClient(
    clientUserId: string,
    filters?: ConsultationFilters
  ): Promise<Consultation[]> {
    let query = collections.consultations
      .where("userId", "==", clientUserId)
      .orderBy("scheduledDate", "desc") as FirebaseFirestore.Query;

    query = this.applyFilters(query, filters);
    const snapshot = await query.get();
    return snapshot.docs.map((doc) => doc.data() as Consultation);
  }

  /**
   * Get all consultations (admin only).
   */
  async getAllConsultations(
    filters?: ConsultationFilters
  ): Promise<Consultation[]> {
    let query = collections.consultations
      .orderBy("scheduledDate", "desc");

    query = this.applyFilters(query, filters);
    const snapshot = await query.get();
    return snapshot.docs.map((doc) => doc.data() as Consultation);
  }

  /**
   * Get a single consultation by ID.
   */
  async getConsultationById(id: string): Promise<Consultation | null> {
    const doc = await collections.consultations.doc(id).get();
    if (!doc.exists) return null;
    return doc.data() as Consultation;
  }

  /**
   * Create a new consultation.
   */
  async createConsultation(
    data: Omit<Consultation, "id" | "createdAt" | "updatedAt">
  ): Promise<Consultation> {
    const now = Timestamp.now();
    const ref = collections.consultations.doc();
    const consultation: Consultation = {
      ...data,
      id: ref.id,
      createdAt: now,
      updatedAt: now,
    };

    await ref.set(consultation);
    return consultation;
  }

  /**
   * Update a consultation.
   */
  async updateConsultation(
    id: string,
    data: Partial<Consultation>
  ): Promise<Consultation | null> {
    const ref = collections.consultations.doc(id);
    const doc = await ref.get();
    if (!doc.exists) return null;

    const updates = {
      ...data,
      updatedAt: Timestamp.now(),
    };
    // Don't allow overwriting id or createdAt
    delete updates.id;
    delete updates.createdAt;

    await ref.update(updates);
    const updated = await ref.get();
    return updated.data() as Consultation;
  }

  /**
   * Change a consultation's status, if the rules allow it (issue #151).
   *
   * ONE Firestore transaction: the booking is re-read, the caller's party is
   * worked out from that fresh copy (`actorFor`), the transition table is
   * applied (`decideStatusChange`), and only then is the status written. So
   * the decision is always made on the state that is being overwritten: a
   * payment confirmed by `settlePayment` (same transaction runner) can not
   * slip in between the check and the write.
   *
   * A refused change (or an unknown id) writes NOTHING.
   *
   * @param actorFor which party of the booking the caller is, or null when
   *   they are neither (answered 403 by the decision)
   * @param extra `cancelledBy` / `cancellationReason` are stored on a cancel,
   *   `summary` on a completion (as before)
   */
  async changeStatus(
    id: string,
    actorFor: (booking: Consultation) => ConsultationActor | null,
    status: ConsultationStatus,
    extra?: { cancelledBy?: string; cancellationReason?: string; summary?: string }
  ): Promise<ChangeStatusOutcome> {
    const ref = collections.consultations.doc(id);
    return chargeRuntime.runTransaction<ChangeStatusOutcome>(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return { kind: "not_found" };
      const current = snap.data() as Consultation;
      const at = chargeRuntime.now();

      const decision = decideStatusChange(actorFor(current), current, status, at);
      if (!decision.ok) return { kind: "refused", refusal: decision };

      const now = Timestamp.fromDate(at);
      const updates: Record<string, unknown> = { status, updatedAt: now };
      if (status === "cancelled") {
        updates.cancelledAt = now;
        if (extra?.cancelledBy) updates.cancelledBy = extra.cancelledBy;
        if (extra?.cancellationReason) updates.cancellationReason = extra.cancellationReason;
      }
      if (status === "completed" && extra?.summary) {
        updates.summary = extra.summary;
      }

      tx.update(ref, updates);
      // The stored doc after the commit: the fresh copy plus what was written.
      return { kind: "changed", before: current, consultation: { ...current, ...updates } as Consultation };
    });
  }

  /**
   * Hard-delete a consultation, unless it has (or may still receive) a
   * payment (issue #151, see `bookingHasPayment`). The check and the delete
   * are one Firestore transaction, so a checkout opened or a payment
   * confirmed in between is seen. WHO may delete (admins only) is the
   * controller's check.
   */
  async deleteUnpaidConsultation(id: string): Promise<DeleteConsultationOutcome> {
    const ref = collections.consultations.doc(id);
    return chargeRuntime.runTransaction<DeleteConsultationOutcome>(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return { kind: "not_found" };
      const current = snap.data() as Consultation;
      if (bookingHasPayment(current)) return { kind: "has_payment" };
      tx.delete(ref);
      return { kind: "deleted", consultation: current };
    });
  }

  /**
   * Compute aggregate stats from a list of consultations.
   */
  computeStats(consultations: Consultation[]): ConsultationStats {
    const now = Timestamp.now();
    let upcoming = 0;
    let completed = 0;
    let cancelled = 0;
    let noShow = 0;

    for (const c of consultations) {
      switch (c.status) {
      case "completed":
        completed++;
        break;
      case "cancelled":
        cancelled++;
        break;
      case "no_show":
        noShow++;
        break;
      case "scheduled":
      case "confirmed":
        if (c.scheduledDate.toMillis() >= now.toMillis()) {
          upcoming++;
        }
        break;
      }
    }

    return {
      total: consultations.length,
      upcoming,
      completed,
      cancelled,
      noShow,
    };
  }

  // ============================================
  // HELPERS
  // ============================================

  private applyFilters(
    query: FirebaseFirestore.Query,
    filters?: ConsultationFilters
  ): FirebaseFirestore.Query {
    if (!filters) return query;

    if (filters.status) {
      query = query.where("status", "==", filters.status);
    }
    if (filters.applicationId) {
      query = query.where("applicationId", "==", filters.applicationId);
    }
    if (filters.type) {
      query = query.where("type", "==", filters.type);
    }
    if (filters.startDate) {
      query = query.where(
        "scheduledDate",
        ">=",
        Timestamp.fromDate(new Date(filters.startDate))
      );
    }
    if (filters.endDate) {
      query = query.where(
        "scheduledDate",
        "<=",
        Timestamp.fromDate(new Date(filters.endDate))
      );
    }

    return query;
  }
}

export const consultationService = new ConsultationService();
