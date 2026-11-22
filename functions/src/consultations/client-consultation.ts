// ============================================
// Client consultation projection (issue #332, follow-up of #329)
// ============================================
//
// The consultation endpoints answer the booking's CLIENT (the payer) with
// `ClientConsultation`, never with the raw Firestore `Consultation`. The
// stored document is what agents, owners and admins work with, and it
// carries things a paying client must not see:
//  - `fxMarginBps`: Seli's exchange-rate markup;
//  - `fxRate` / `fxRateAsOf` / `fxRateSource`: the raw (mid-market) rate the
//    markup is added to. With the amount charged it gives the markup away;
//  - `supersededCheckouts`: every replaced checkout, EACH with its own full
//    snapshot (raw rate and markup again);
//  - checkout and settlement bookkeeping (`checkoutCallbackUrl`,
//    `paidAfterQuoteExpiry`, `paidOnSupersededReference`, `paystackPaidAt`),
//    `bookedVia` and `cancelledBy`.
//
// `toClientConsultation` is a field-by-field ALLOW-LIST, like
// `toClientTransaction` (transactions/client-transaction.ts). Do not rewrite
// it as `{ ...c }` or "omit these keys": a new `Consultation` field must stay
// hidden from clients until it is added here deliberately.
// test/consultations/client-consultation-allow-list.test.ts pins the key set
// and fails when a stored field (known or brand new) reaches a client.
//
// The charge is given through `clientChargeFields` (money/client-charge.ts):
// the dollar price, the amount charged, the quote lock, and the EFFECTIVE
// rate (amount charged ÷ dollar price, markup included) in place of the raw
// rate.
//
// WHO gets which view is decided in ONE place, `seesFullConsultation`, used
// by every consultation route that can answer either side.

import type { Timestamp } from "firebase-admin/firestore";
import { ROLES } from "@durin-tech/authz";
import type {
  Consultation,
  ConsultationStatus,
  ConsultationType,
  PaymentStatus,
} from "../types";
import { CLIENT_CHARGE_FIELDS, ClientChargeFields, clientChargeFields } from "../money/client-charge";

/**
 * The exact key set of a client consultation response. Exported so tests
 * assert against the same list. Keys that are optional on
 * `ClientConsultation` appear only when the stored booking has them.
 */
export const CLIENT_CONSULTATION_FIELDS = [
  "id",
  "userId",
  "agentId",
  "agencyId",
  "applicationId",
  "clientName",
  "clientEmail",
  "agentName",
  "type",
  "scheduledDate",
  "scheduledTime",
  "durationMinutes",
  "timezone",
  "status",
  "meetingLink",
  "meetingPlatform",
  // The charge, as a payer may see it (money/client-charge.ts).
  ...CLIENT_CHARGE_FIELDS,
  "fee",
  "paymentStatus",
  "transactionId",
  "checkoutUrl",
  "paidAt",
  "summary",
  "recordingUrl",
  "cancelledAt",
  "cancellationReason",
  // Issue #317: where the booking's refund stands (no ids, no Paystack data).
  "refundStatus",
  // Issue #465: why a refund is held (e.g. `fee_not_less_than_amount`: no
  // refund due), so the app can say so instead of "delayed".
  "refundHeldReason",
  // Issue #382: the "the meeting didn't happen" report (for #442).
  "canReportNoShow",
  "noShowReport",
  "createdAt",
  "updatedAt",
] as const;

/**
 * One booking as its client may see it. Timestamps are passed through as
 * stored, so they serialize exactly as they did before #332.
 */
export interface ClientConsultation extends ClientChargeFields {
  /** The booking's document id. */
  id: string;
  /** The client's own uid. */
  userId: string;
  /** The agent's user uid (the app opens the agent's profile and chat with it). */
  agentId: string;
  /** The agent's agency, when they have one. */
  agencyId?: string;
  /** The client's case this consultation belongs to, if any. */
  applicationId?: string;

  /** The client's own name and email, as stored on the booking. */
  clientName: string;
  clientEmail: string;
  /** The agent's display name. */
  agentName: string;

  /** What kind of consultation, and when. */
  type: ConsultationType;
  scheduledDate: Timestamp;
  /** 24-hour `HH:mm`. */
  scheduledTime: string;
  durationMinutes: number;
  timezone: string;

  /** Where the booking stands. */
  status: ConsultationStatus;

  /** How the two meet. */
  meetingLink?: string;
  meetingPlatform?: Consultation["meetingPlatform"];

  /** LEGACY booking only (before #180): the fee in whole naira. */
  fee?: number;
  /** "pending" until the payment is confirmed, then "paid". */
  paymentStatus: PaymentStatus;
  /**
   * The client's OWN Paystack checkout: its reference and its page. The
   * client already gets both from the create / checkout answers
   * (`reference`, `authorizationUrl`) and from Paystack's return URL; they
   * are kept so a resumed create answers as it did before #332.
   */
  transactionId?: string;
  checkoutUrl?: string;
  /** When the payment was confirmed. */
  paidAt?: Timestamp;

  /** After the consultation. */
  summary?: string;
  recordingUrl?: string;

  /** When and why it was cancelled (not by whom: that is a user id). */
  cancelledAt?: Timestamp;
  cancellationReason?: string;

  /** Issue #317: where the refund of this booking's fee stands, if one was started. */
  refundStatus?: Consultation["refundStatus"];

  /**
   * Issue #465: why the booking's refund is held for an admin, when it is
   * (`fee_not_less_than_amount`: Paystack's fee covers the whole payment, so
   * no refund is due; `paystack_fee_unknown`: delayed).
   */
  refundHeldReason?: Consultation["refundHeldReason"];

  /**
   * Issue #382: whether the client may report now that the meeting did not
   * happen (`POST /consultations/:id/no-show-report`): paid, not cancelled,
   * the fee still held, no refund, the slot started, no report yet. Worked
   * out by the server at read time; false when it was not worked out (an
   * answer that has no fee row at hand).
   */
  canReportNoShow: boolean;
  /**
   * Issue #382: the booking's report, or null when there is none. Its
   * status only: "open" (Seli is looking into it), "refunded" (the agent did
   * not show: full refund), "released" (the meeting happened). No admin id,
   * no agent fee, no internal field.
   */
  noShowReport: { status: "open" | "refunded" | "released"; createdAt: Timestamp; resolvedAt?: Timestamp } | null;

  createdAt: Timestamp;
  updatedAt: Timestamp;
}

/**
 * Project a stored booking onto the client allow-list.
 *
 * Every output field is named and copied one by one. Nothing is spread from
 * the stored document, so a field that is not written below (existing or
 * added later, top-level or inside `supersededCheckouts`) cannot reach a
 * client. Optional fields are only set when present, so absent stays absent
 * in JSON. No money is converted or recomputed, except the effective rate,
 * which is a plain division of two stored amounts (see `effectiveRateOf`).
 *
 * @param c - The full stored booking (the caller's own)
 * @returns The payer-safe view of that booking
 */
export function toClientConsultation(
  c: Consultation,
  /** Issue #382: what the server worked out at read time (see `canReportNoShow`). */
  extras: { canReportNoShow?: boolean } = {}
): ClientConsultation {
  // The fields every booking has.
  const out: ClientConsultation = {
    id: c.id,
    userId: c.userId,
    agentId: c.agentId,
    clientName: c.clientName,
    clientEmail: c.clientEmail,
    agentName: c.agentName,
    type: c.type,
    scheduledDate: c.scheduledDate,
    scheduledTime: c.scheduledTime,
    durationMinutes: c.durationMinutes,
    timezone: c.timezone,
    status: c.status,
    paymentStatus: c.paymentStatus,
    // Issue #382: never true unless the caller worked it out (fails closed).
    canReportNoShow: extras.canReportNoShow === true,
    // Issue #382: the report's status and times only, field by field.
    noShowReport: c.noShowReport
      ? {
        status: c.noShowReport.status,
        createdAt: c.noShowReport.createdAt,
        ...(c.noShowReport.resolvedAt ? { resolvedAt: c.noShowReport.resolvedAt } : {}),
      }
      : null,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  };

  // Optional links: the agency and the client's case.
  if (c.agencyId !== undefined) out.agencyId = c.agencyId;
  if (c.applicationId !== undefined) out.applicationId = c.applicationId;

  // The meeting.
  if (c.meetingLink !== undefined) out.meetingLink = c.meetingLink;
  if (c.meetingPlatform !== undefined) out.meetingPlatform = c.meetingPlatform;

  // The charge: dollar price, amount charged, EFFECTIVE rate, quote lock.
  // The raw rate, its date and source, and the margin stay behind.
  Object.assign(out, clientChargeFields(c));

  // Legacy naira fee (pre-#180 bookings carry no snapshot).
  if (c.fee !== undefined) out.fee = c.fee;

  // The client's own checkout, and when it was paid.
  if (c.transactionId !== undefined) out.transactionId = c.transactionId;
  if (c.checkoutUrl !== undefined) out.checkoutUrl = c.checkoutUrl;
  if (c.paidAt !== undefined) out.paidAt = c.paidAt;

  // After the consultation.
  if (c.summary !== undefined) out.summary = c.summary;
  if (c.recordingUrl !== undefined) out.recordingUrl = c.recordingUrl;

  // Cancellation: when and why.
  if (c.cancelledAt !== undefined) out.cancelledAt = c.cancelledAt;
  if (c.cancellationReason !== undefined) out.cancellationReason = c.cancellationReason;

  // Refund status only (issue #317): never the refund id or Paystack data.
  if (c.refundStatus !== undefined) out.refundStatus = c.refundStatus;
  // Issue #465: the held reason (a fixed code, nothing internal).
  if (c.refundHeldReason !== undefined) out.refundHeldReason = c.refundHeldReason;

  return out;
}

/** Who is asking: the uid and the role resolved for THIS request (`req.userId`, `req.authz.role`). */
export interface ConsultationViewer {
  uid?: string;
  role?: string;
}

/**
 * Whether `viewer` gets the FULL stored booking (true) or the client view
 * (false). Fails closed: the full document is only for a caller who is
 * positively on the agent side.
 *
 *  - no resolved role, or the `client` role: client view, whatever booking
 *    it is (this covers a former agent, whose role is back to `client`);
 *  - the booking's own client (`userId`): client view, even when their role
 *    is agent, owner or admin. On their own booking they are the payer;
 *  - an agent, owner or admin looking at someone else's booking: the full
 *    document, as before #332.
 *
 * This decides only the SHAPE of an answer. Whether the caller may read the
 * booking at all is decided before, by each route (CASL / the party check).
 *
 * @param viewer - The caller's uid and resolved role
 * @param booking - The booking being answered
 */
export function seesFullConsultation(viewer: ConsultationViewer, booking: Pick<Consultation, "userId">): boolean {
  // The payer of this booking is always answered as a payer.
  if (!viewer.uid || booking.userId === viewer.uid) return false;
  return viewer.role === ROLES.ADMIN || viewer.role === ROLES.AGENT || viewer.role === ROLES.OWNER;
}

/**
 * The booking in the shape `viewer` may receive: the stored document for the
 * agent side, the allow-listed client view for everyone else.
 *
 * @param viewer - The caller's uid and resolved role
 * @param booking - The full stored booking
 */
export function consultationFor(
  viewer: ConsultationViewer,
  booking: Consultation,
  /** Issue #382: read-time facts for the client view (ignored for the agent side). */
  extras: { canReportNoShow?: boolean } = {}
): Consultation | ClientConsultation {
  return seesFullConsultation(viewer, booking) ? booking : toClientConsultation(booking, extras);
}
