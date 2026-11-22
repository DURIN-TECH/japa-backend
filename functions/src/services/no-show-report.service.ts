// ============================================
// "The meeting didn't happen": client reports on paid consultations (issue #382)
// ============================================
//
// While an agent's fee for a PAID consultation is still HELD (money/fee-hold.ts:
// until slot end + 24 h, or until the meeting is marked done and the slot has
// started), the booking's client may report that the meeting did not happen.
//
// Decisions (user, 2026-11-21):
//  - an admin ALWAYS decides; there is no default and nothing happens by itself;
//  - "the agent did not show" (`agent_no_show`) is the existing admin refund
//    `admin_agent_no_show` (consultation-refund.service.ts `adminRefund`): the
//    client gets everything back, the agent carries Paystack's fee (the fee
//    rule table there), funded from the hold;
//  - "the client was wrong" (`meeting_happened`): no refund, no Paystack call;
//    the fee follows its stored release, never earlier than without the report;
//  - until the admin decides, the fee is FROZEN (`feeHoldFrozenByReportId` on
//    the fee row: `feeHoldStatusAt` reads it as held past `releaseAt`, so it is
//    in no available balance and no withdrawal can take it);
//  - a client may report only while the fee is held (after release: normal
//    support), only once the slot has started, and once per booking
//    (orchestrator): the report lives at `noShowReports/{consultationId}`.
//
// CONCURRENCY. The report is ONE Firestore transaction that reads the booking,
// its fee row, its one possible refund row, the report doc and the agent's
// withdrawal lock, and writes the report (`tx.create`), the fee freeze, the
// booking's mirror and the lock. So it serialises with a cancel (which reads
// the report and refuses while it is open), an agent marking the meeting done,
// an admin refund (which reads the report) and a withdrawal (which takes the
// same lock). A resolve re-reads the report in its own transaction: two admins
// at once, one wins; the other gets NO_SHOW_REPORT_RESOLVED.

import { FieldValue, Timestamp } from "firebase-admin/firestore";
import type {
  Consultation,
  ConsultationNoShowReportMirror,
  NoShowReport,
  NoShowReportDecision,
  NoShowReportStatus,
  Transaction,
} from "../types";
import type { Money } from "../types/money";
import { collections } from "../utils/firebase";
import { chargeRuntime } from "./charge-checkout.service";
import {
  AdminRefundOutcome,
  consultationRefundService,
  isPaidWithMoney,
  readFeeTransaction,
  refundDocId,
} from "./consultation-refund.service";
import { feeHoldStatusAt } from "../money/fee-hold";
import { slotStartsAt } from "../consultations/slot-time";
import { notificationService } from "./notification.service";

// ============================================
// Constants and types
// ============================================

/** The longest note a client may add to a report, in characters. */
export const NO_SHOW_NOTE_MAX_LENGTH = 1000;

/** Why a report is refused (409), one code per case. */
export type NoShowRefusalCode =
  /** The booking already has a report (one per booking; a repeat writes nothing). */
  | "NO_SHOW_REPORT_EXISTS"
  /** The fee is no longer held (released, or refunded, or frozen by a held refund): contact support. */
  | "FEE_NOT_HELD"
  /** Not paid with money (free, unpaid), or no settled consultation fee row. */
  | "NOT_PAID"
  /** A refund exists for the booking. */
  | "ALREADY_REFUNDED"
  /** The slot has not started yet: a meeting cannot "not happen" before it starts. */
  | "MEETING_NOT_STARTED"
  /** The booking was cancelled (with no refund): there was no meeting to miss. */
  | "BOOKING_CANCELLED";

/** The client-facing message per refusal (plain words, Seli's voice). */
export const NO_SHOW_REFUSAL_MESSAGES: Record<NoShowRefusalCode, string> = {
  NO_SHOW_REPORT_EXISTS: "You've already told us about this consultation. We're looking into it.",
  FEE_NOT_HELD: "It's too late to report this here. Please contact support and we'll help.",
  NOT_PAID: "This consultation wasn't paid for, so there's nothing to report here.",
  ALREADY_REFUNDED: "This consultation already has a refund.",
  MEETING_NOT_STARTED: "You can report this once the consultation's start time has passed.",
  BOOKING_CANCELLED: "This consultation was cancelled, so there's no meeting to report.",
};

/** What a report did. */
export type ReportOutcome =
  | { kind: "not_found" }
  /** The caller is not the booking's client: 403. */
  | { kind: "forbidden" }
  | { kind: "refused"; code: NoShowRefusalCode }
  | { kind: "created"; report: NoShowReport; booking: Consultation };

/** One row of the admin list (`GET /consultations/no-show-reports`). */
export interface NoShowReportListItem {
  consultationId: string;
  /** ISO time the slot started. */
  slotStartAt: string;
  /** The booking's status now (null when the booking is gone). */
  bookingStatus: Consultation["status"] | null;
  clientName: string | null;
  agentName: string | null;
  agencyId: string | null;
  /** What the client paid, in minor units of its currency. */
  amount: Money;
  note: string | null;
  status: NoShowReportStatus;
  /** The admin's decision, once made. */
  decision: NoShowReportDecision | null;
  createdAt: string;
  resolvedAt: string | null;
}

/** What a resolve did. */
export type ResolveOutcome =
  | { kind: "not_found" }
  | { kind: "already_resolved"; report: NoShowReport }
  /** `meeting_happened`: the freeze is lifted, no money moved. */
  | { kind: "released"; report: NoShowReport }
  /** `agent_no_show`: the admin refund's answer; `report` set when it wrote the refund. */
  | { kind: "refund"; outcome: AdminRefundOutcome; report: NoShowReport | null };

// ============================================
// Pure rules
// ============================================

/**
 * Why a report of `booking` at time `at` is refused, or null when it may be
 * made (issue #382). Pure. Used inside the report's transaction AND for the
 * client view's `canReportNoShow` (on the same rule, at read time).
 *
 * In order: a report exists; not paid with money; cancelled (with a refund:
 * ALREADY_REFUNDED); no settled fee row; a refund exists; the fee is not
 * HELD at `at` (released by the clock or a closed meeting, refunded, or
 * frozen by a held refund); the slot has not started.
 */
export function noShowReportRefusal(input: {
  booking: Consultation;
  fee: Transaction | null;
  at: Date;
  /** Whether `noShowReports/{id}` exists (read in the transaction). */
  reportExists: boolean;
  /** Whether the booking's refund row exists (read in the transaction). */
  refundExists: boolean;
}): NoShowRefusalCode | null {
  const { booking, fee, at } = input;
  if (input.reportExists || booking.noShowReport) return "NO_SHOW_REPORT_EXISTS";
  if (!isPaidWithMoney(booking)) return "NOT_PAID";
  const refunded = input.refundExists || !!booking.refundId;
  if (booking.status === "cancelled") return refunded ? "ALREADY_REFUNDED" : "BOOKING_CANCELLED";
  if (!fee) return "NOT_PAID";
  if (refunded) return "ALREADY_REFUNDED";
  if (fee.feeHoldFrozenByRefundId || feeHoldStatusAt(fee, at) !== "held") return "FEE_NOT_HELD";
  let start: number;
  try {
    start = slotStartsAt(booking).getTime();
  } catch {
    // An unreadable slot: we cannot say it has started (fails closed).
    return "MEETING_NOT_STARTED";
  }
  if (at.getTime() < start) return "MEETING_NOT_STARTED";
  return null;
}

/** The booking's mirror of a report (what the client view shows). Pure. */
export function reportMirror(report: Pick<NoShowReport, "status" | "createdAt" | "resolvedAt">): ConsultationNoShowReportMirror {
  return {
    status: report.status,
    createdAt: report.createdAt,
    ...(report.resolvedAt ? { resolvedAt: report.resolvedAt } : {}),
  };
}

/** ISO string of a stored Timestamp, or null. */
function iso(value: unknown): string | null {
  const t = value as { toDate?: () => Date } | undefined;
  return t && typeof t.toDate === "function" ? t.toDate().toISOString() : null;
}

// ============================================
// The service
// ============================================

class NoShowReportService {
  /**
   * The booking's client reports the meeting did not happen (issue #382),
   * `POST /consultations/:id/no-show-report`. WHO may call it (not an admin)
   * is the controller's first check; that the caller is THIS booking's client
   * is checked here, on the booking read in the transaction.
   *
   * One Firestore transaction (see the header): every rule re-checked
   * (`noShowReportRefusal`), then the report (`tx.create` at
   * `noShowReports/{id}`), the fee freeze, the booking mirror and the agent's
   * withdrawal lock, together. Notifications follow the commit and never fail
   * the report.
   */
  async report(input: { consultationId: string; clientUid: string; note?: string }): Promise<ReportOutcome> {
    const bookingRef = collections.consultations.doc(input.consultationId);
    const reportRef = collections.noShowReports.doc(input.consultationId);
    const outcome = await chargeRuntime.runTransaction<ReportOutcome>(async (tx) => {
      // ---- Reads (all before any write) ----
      const snap = await tx.get(bookingRef);
      if (!snap.exists) return { kind: "not_found" };
      const booking = snap.data() as Consultation;
      if (booking.userId !== input.clientUid) return { kind: "forbidden" };
      const reportSnap = await tx.get(reportRef);
      const fee = isPaidWithMoney(booking) ? await readFeeTransaction(tx, booking) : null;
      const refundSnap = fee?.providerTransactionId
        ? await tx.get(collections.transactions.doc(refundDocId(fee.providerTransactionId)))
        : null;
      const lockRef = collections.withdrawalLocks.doc(booking.agentId);
      const lockSnap = await tx.get(lockRef);
      // One clock for every check in this transaction.
      const at = chargeRuntime.now();

      const refusal = noShowReportRefusal({
        booking,
        fee,
        at,
        reportExists: reportSnap.exists,
        refundExists: !!refundSnap?.exists,
      });
      if (refusal) return { kind: "refused", code: refusal };

      // ---- Writes ----
      const now = Timestamp.fromDate(at);
      const feeRow = fee!;
      const report: NoShowReport = {
        id: booking.id,
        consultationId: booking.id,
        clientId: booking.userId,
        agentId: booking.agentId,
        ...(booking.agencyId ? { agencyId: booking.agencyId } : {}),
        ...(booking.clientName ? { clientName: booking.clientName } : {}),
        ...(booking.agentName ? { agentName: booking.agentName } : {}),
        feeTransactionId: feeRow.id,
        amountMinor: feeRow.amount,
        currency: feeRow.currency,
        slotStartAt: Timestamp.fromDate(slotStartsAt(booking)),
        ...(input.note ? { note: input.note } : {}),
        status: "open",
        createdAt: now,
        updatedAt: now,
      };
      // create(): a concurrent second report fails this commit instead of overwriting.
      tx.create(reportRef, report);
      // The fee is FROZEN until an admin decides (feeHoldStatusAt: held).
      tx.update(collections.transactions.doc(feeRow.id), {
        feeHoldFrozenByReportId: report.id,
        feeHoldFrozenByReportAt: now,
        updatedAt: now,
      });
      const mirror = reportMirror(report);
      tx.update(bookingRef, { noShowReport: mirror, updatedAt: now });
      // The agent's withdrawal lock (#287): a withdrawal of this agent runs
      // strictly before or after this freeze, never alongside it.
      tx.set(
        lockRef,
        {
          agentUserId: booking.agentId,
          lastNoShowReportId: report.id,
          noShowReportCount: (Number(lockSnap.exists ? lockSnap.data()?.noShowReportCount : 0) || 0) + 1,
          updatedAt: now,
        },
        { merge: true }
      );
      console.warn(
        `[no-show] ${booking.id}: client ${booking.userId} reported the meeting did not happen; ` +
          `fee ${feeRow.id} (${feeRow.amount} ${feeRow.currency} minor units) frozen for an admin`
      );
      return { kind: "created", report, booking: { ...booking, noShowReport: mirror, updatedAt: now } };
    });
    if (outcome.kind === "created") await this.notifyReported(outcome.booking);
    return outcome;
  }

  /**
   * Reports for the admin queue (issue #382), `GET
   * /consultations/no-show-reports?status=open|resolved`, newest first.
   * WHO may call it (admins only) is the controller's check. Index:
   * noShowReports(status, createdAt desc).
   */
  async list(status: "open" | "resolved"): Promise<NoShowReportListItem[]> {
    const query =
      status === "open"
        ? collections.noShowReports.where("status", "==", "open")
        : collections.noShowReports.where("status", "in", ["refunded", "released"]);
    const snap = await query.orderBy("createdAt", "desc").get();
    const reports = snap.docs.map((d) => d.data() as NoShowReport);
    // The booking's status now, one read per report (the queue is short).
    const bookings = await Promise.all(reports.map((r) => collections.consultations.doc(r.consultationId).get()));
    return reports.map((r, i) => ({
      consultationId: r.consultationId,
      slotStartAt: iso(r.slotStartAt) ?? "",
      bookingStatus: bookings[i].exists ? ((bookings[i].data() as Consultation).status) : null,
      clientName: r.clientName ?? null,
      agentName: r.agentName ?? null,
      agencyId: r.agencyId ?? null,
      amount: { amountMinor: r.amountMinor, currency: r.currency as Money["currency"] },
      note: r.note ?? null,
      status: r.status,
      decision: r.decision ?? null,
      createdAt: iso(r.createdAt) ?? "",
      resolvedAt: iso(r.resolvedAt),
    }));
  }

  /**
   * An admin decides a report (issue #382), `POST
   * /consultations/:id/no-show-report/resolve`. WHO may call it (admins only)
   * and that `decision` is one of the two (no default) are the controller's
   * checks.
   *
   *  - `agent_no_show`: the EXISTING admin refund path (`adminRefund`,
   *    reason `admin_agent_no_show`, the agent carries Paystack's fee), with
   *    `noShowResolution`: the same transaction re-reads the report, writes
   *    the refund, lifts the freeze and marks the report `refunded`. When the
   *    refund cannot be written (`fee_unknown`, `paystack_unavailable`, ...)
   *    the report stays open and frozen and its answer is returned. On success
   *    the refund is sent to Paystack and both sides are told;
   *  - `meeting_happened`: one transaction, no refund, no Paystack call: the
   *    report becomes `released`, the freeze is lifted, and the fee follows
   *    its stored `feeHold.releaseAt` (at once when that has passed; never
   *    earlier than without the report).
   * Already resolved: nothing written (`already_resolved`; two admins at
   * once: one wins).
   */
  async resolve(input: { consultationId: string; adminUid: string; decision: NoShowReportDecision }): Promise<ResolveOutcome> {
    const reportRef = collections.noShowReports.doc(input.consultationId);
    // A quick read first, so a missing or resolved report never reaches Paystack.
    const pre = await reportRef.get();
    if (!pre.exists) return { kind: "not_found" };
    const preReport = pre.data() as NoShowReport;
    if (preReport.status !== "open") return { kind: "already_resolved", report: preReport };

    if (input.decision === "agent_no_show") {
      const outcome = await consultationRefundService.adminRefund({
        consultationId: input.consultationId,
        adminUid: input.adminUid,
        reason: "admin_agent_no_show",
        feeBorneBy: "agent",
        noShowResolution: true,
      });
      if (outcome.kind === "no_show_report_resolved") {
        const now = await reportRef.get();
        return { kind: "already_resolved", report: now.data() as NoShowReport };
      }
      if (outcome.kind === "no_show_report_not_found") return { kind: "not_found" };
      if (outcome.kind !== "created") return { kind: "refund", outcome, report: null };
      // Written: send it to Paystack now (a failure leaves it to the retry job).
      let refund = outcome.refund;
      try {
        refund = (await consultationRefundService.processRefund(refund.id)) ?? refund;
      } catch (error) {
        console.error(`[no-show] refund ${refund.id} could not be sent yet; the retry job will:`, error);
      }
      const booking = { ...outcome.booking, refundStatus: refund.status as Consultation["refundStatus"] };
      await consultationRefundService.notifyCreated(refund, booking, outcome.debit);
      const report = (await reportRef.get()).data() as NoShowReport;
      await this.notifyResolved(booking, report);
      return { kind: "refund", outcome: { ...outcome, refund, booking }, report };
    }

    // ---- meeting_happened: no money, the freeze is lifted ----
    const bookingRef = collections.consultations.doc(input.consultationId);
    const result = await chargeRuntime.runTransaction<
      { kind: "not_found" } | { kind: "already_resolved"; report: NoShowReport } | { kind: "released"; report: NoShowReport; booking: Consultation | null }
    >(async (tx) => {
      const reportSnap = await tx.get(reportRef);
      if (!reportSnap.exists) return { kind: "not_found" };
      const report = reportSnap.data() as NoShowReport;
      if (report.status !== "open") return { kind: "already_resolved", report };
      const bookingSnap = await tx.get(bookingRef);
      const feeRef = collections.transactions.doc(report.feeTransactionId);
      const feeSnap = await tx.get(feeRef);
      const now = Timestamp.fromDate(chargeRuntime.now());
      const resolved: NoShowReport = {
        ...report,
        status: "released",
        decision: "meeting_happened",
        resolvedAt: now,
        resolvedBy: input.adminUid,
        updatedAt: now,
      };
      tx.update(reportRef, {
        status: resolved.status,
        decision: resolved.decision,
        resolvedAt: now,
        resolvedBy: input.adminUid,
        updatedAt: now,
      });
      // Lift THIS report's freeze only; the stored hold times are untouched,
      // so the fee releases exactly when it would have without the report.
      if (feeSnap.exists && (feeSnap.data() as Transaction).feeHoldFrozenByReportId === report.id) {
        tx.update(feeRef, { feeHoldFrozenByReportId: FieldValue.delete(), feeHoldFrozenByReportAt: FieldValue.delete(), updatedAt: now });
      }
      let booking: Consultation | null = null;
      if (bookingSnap.exists) {
        const mirror = reportMirror(resolved);
        tx.update(bookingRef, { noShowReport: mirror, updatedAt: now });
        booking = { ...(bookingSnap.data() as Consultation), noShowReport: mirror, updatedAt: now };
      }
      console.warn(`[no-show] ${report.id}: admin ${input.adminUid} found the meeting happened; fee ${report.feeTransactionId} unfrozen`);
      return { kind: "released", report: resolved, booking };
    });
    if (result.kind === "released") {
      if (result.booking) await this.notifyResolved(result.booking, result.report);
      return { kind: "released", report: result.report };
    }
    return result;
  }

  // ============================================
  // Notifications (a failure never fails the report or the decision)
  // ============================================

  /** Tell the agent the payment is paused, and the client their report arrived. */
  private async notifyReported(booking: Consultation): Promise<void> {
    const common = { type: "consultation_no_show_reported" as const, relatedEntityType: "consultation" as const, relatedEntityId: booking.id };
    const client = booking.clientName || "Your client";
    await notificationService
      .notifyUser({
        ...common,
        userId: booking.agentId,
        title: "Client reported a missed meeting",
        body: `${client} told us the consultation didn't happen. The payment is paused while Seli looks into it.`,
      })
      .catch((e) => console.error("[no-show] agent notify failed:", e));
    await notificationService
      .notifyUser({
        ...common,
        userId: booking.userId,
        title: "We got your report",
        body: "Thanks for telling us the consultation didn't happen. We're looking into it and will let you know what we decide.",
      })
      .catch((e) => console.error("[no-show] client notify failed:", e));
  }

  /** Tell both sides what the admin decided. */
  private async notifyResolved(booking: Consultation, report: NoShowReport): Promise<void> {
    const common = { type: "consultation_no_show_resolved" as const, relatedEntityType: "consultation" as const, relatedEntityId: booking.id };
    const refunded = report.status === "refunded";
    await notificationService
      .notifyUser({
        ...common,
        userId: booking.userId,
        title: "About your report",
        body: refunded
          ? "We looked into your report and agree the consultation didn't happen. Your full refund is on its way."
          : "We looked into your report and found the consultation did take place, so no refund is due. Contact support if you think we got this wrong.",
      })
      .catch((e) => console.error("[no-show] client notify failed:", e));
    await notificationService
      .notifyUser({
        ...common,
        userId: booking.agentId,
        title: "About the missed-meeting report",
        body: refunded
          ? "Seli looked into the client's report and found the consultation didn't happen, so the client gets a full refund."
          : "Seli looked into the client's report and found the consultation did take place. Your payment is no longer paused.",
      })
      .catch((e) => console.error("[no-show] agent notify failed:", e));
  }
}

export const noShowReportService = new NoShowReportService();
