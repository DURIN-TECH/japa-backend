/**
 * Settling a paid payment request — the single place a request becomes "paid"
 * and the money-side bookkeeping happens.
 *
 * TWO CALLERS, ONE IMPLEMENTATION:
 *   1. verify-on-return  — the client comes back from Paystack and we confirm
 *   2. the Paystack webhook — the client never came back (closed the tab, lost
 *      signal, killed the browser) but the charge succeeded anyway
 *
 * Both must produce exactly the same result, and whichever arrives second must
 * be a no-op. Duplicating this logic across the two paths would have meant two
 * chances to double-credit an agency, so it lives here and both call it.
 *
 * IDEMPOTENCY is the whole point. `settlePaymentRequest` claims the request with
 * a Firestore TRANSACTION that flips `pending`/`approved` → `paid` only if it
 * hasn't been flipped already. Whoever loses the race gets `alreadySettled` and
 * writes nothing, so the escrow-release transaction and the application's
 * `amountPaid` are only ever applied once — even if the webhook and the return
 * leg land at the same instant.
 */

import { collections, db } from "../utils/firebase";
import { PaymentRequest } from "../types";
import { transactionService } from "./transaction.service";
import { applicationService } from "./application.service";
import { notificationService } from "./notification.service";
import { Timestamp } from "firebase-admin/firestore";

export interface SettlementResult {
  /** True when THIS call performed the settlement. */
  settled: boolean;
  /** True when the request was already paid before this call. */
  alreadySettled: boolean;
  /** The request as it now stands, or null if it doesn't exist. */
  request: PaymentRequest | null;
}

/** Format a minor-unit amount for human-facing copy (amounts are stored in kobo). */
function formatAmount(minorUnits: number, currency: string): string {
  const symbol = currency?.toUpperCase() === "NGN" ? "₦" : "";
  const major = (minorUnits ?? 0) / 100;
  const formatted = major.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return symbol ? `${symbol}${formatted}` : `${formatted} ${currency}`;
}

/**
 * Mark a payment request paid and apply the money-side effects, exactly once.
 *
 * @param paymentRequestId The request to settle.
 * @param reference        The Paystack reference that paid it. Recorded, and
 *                         checked against any reference already stored on the
 *                         request so a foreign reference can't settle it.
 */
export async function settlePaymentRequest(
  paymentRequestId: string,
  reference: string
): Promise<SettlementResult> {
  const ref = collections.paymentRequests.doc(paymentRequestId);

  // ── Claim the request atomically ──────────────────────────────────────────
  // Read-and-flip inside a transaction so two concurrent settlements (webhook +
  // return leg) can't both proceed past this point.
  const claim = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) {
      return { exists: false, alreadyPaid: false, request: null as PaymentRequest | null };
    }

    const request = snap.data() as PaymentRequest;

    if (request.status === "paid") {
      return { exists: true, alreadyPaid: true, request };
    }

    // A reference already on the request must match. Guards against a valid
    // reference from some other transaction being replayed against this one.
    if (request.paystackReference && request.paystackReference !== reference) {
      throw new Error("REFERENCE_MISMATCH");
    }

    tx.update(ref, {
      status: "paid",
      paidAt: Timestamp.now(),
      paystackReference: reference,
      updatedAt: Timestamp.now(),
    });

    return {
      exists: true,
      alreadyPaid: false,
      request: { ...request, status: "paid" as const },
    };
  });

  if (!claim.exists) {
    return { settled: false, alreadySettled: false, request: null };
  }
  if (claim.alreadyPaid) {
    return { settled: false, alreadySettled: true, request: claim.request };
  }

  const request = claim.request!;

  // ── Money-side effects — reached by exactly one caller ────────────────────
  // Deliberately AFTER the claim: if any of these throw, the request is still
  // correctly marked paid (the client's money did move) and the failure is
  // logged for repair, rather than the client paying and the request looking
  // unpaid forever.
  try {
    await transactionService.createEscrowRelease(request);
    await applicationService.incrementAmountPaid(
      request.applicationId,
      request.amount
    );
  } catch (error) {
    console.error(
      `[settlement] post-payment bookkeeping FAILED for request ${paymentRequestId} ` +
        `(reference ${reference}) — the charge succeeded and the request is marked ` +
        "paid, but the transaction/amountPaid records need manual repair:",
      error
    );
  }

  // Tell the agent money actually arrived. Best-effort.
  try {
    const agentUserId = (
      await collections.agents.doc(request.agentId).get()
    ).data()?.userId;
    if (agentUserId) {
      await notificationService.notifyUser({
        userId: agentUserId,
        type: "payment_received",
        title: "Payment received",
        body:
          `${request.clientName || "Your client"} paid ` +
          `${formatAmount(request.amount, request.currency)} for ${request.description}.`,
        relatedEntityType: "payment_request",
        relatedEntityId: paymentRequestId,
        data: request.applicationId
          ? { applicationId: request.applicationId }
          : undefined,
      });
    }
  } catch (error) {
    console.error("[settlement] agent notification failed:", error);
  }

  return { settled: true, alreadySettled: false, request };
}
