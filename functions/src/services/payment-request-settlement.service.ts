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
 * ISSUE #181 (dollar requests, local charge): the settlement now
 *  - checks what Paystack REPORTS it charged (its `requested_amount` when
 *    reported, else `amount`, and the currency) against EXACTLY what the paid
 *    checkout asked: the request's stored charge snapshot, the snapshot of a
 *    superseded checkout of it, or a legacy request's own kobo amount. A
 *    mismatch (short payment, wrong currency, nothing reported) is never
 *    settled and never marked paid: nothing is written;
 *  - decides AND writes everything in ONE Firestore transaction: the request
 *    flips to paid, its Transaction is written (charged amount in the charged
 *    currency, plus `priceUsdCents` and the rate snapshot), and the case's
 *    `amountPaid` moves, all in the same commit. A second settlement finds the
 *    request paid and writes nothing, so there is exactly ONE Transaction per
 *    request, ever (before #181 the bookkeeping ran after the claim, outside
 *    it, and a failure there left a paid request with no record);
 *  - a second payment on a superseded checkout of an already-paid request,
 *    or a payment on a request that is no longer awaiting payment, is held in
 *    `paymentRequestExceptions` for a refund, never a second Transaction.
 *
 * The shared decision step (which checkout was paid, does the amount match)
 * is `matchPaidCheckout` in charge-checkout.service.ts, the same one
 * consultation bookings use.
 */

import { Timestamp } from "firebase-admin/firestore";
import { collections } from "../utils/firebase";
import { Application, PaymentRequest, PaymentRequestPaymentException, PaymentStatus, Transaction } from "../types";
import type { Money } from "../types/money";
import { transactionService } from "./transaction.service";
import { notificationService } from "./notification.service";
import { PaystackTransactionLookup } from "./billing/paystack.provider";
import { chargeRuntime, hasChargeSnapshot, matchPaidCheckout, snapshotOf, supersededSwap } from "./charge-checkout.service";
import { describeRequestAmount, expectedRequestCharge, isUsdPaymentRequest } from "./payment-request-charge.service";

// ============================================
// Outcomes
// ============================================

/** What settling a successful Paystack payment on a request did. */
export type PaymentRequestSettleOutcome =
  /** The request is now paid by this payment; its Transaction is written. */
  | { kind: "confirmed"; request: PaymentRequest; transaction: Transaction; viaSuperseded: boolean }
  /** This very payment already settled the request: nothing written. */
  | { kind: "already_paid"; request: PaymentRequest }
  /** A SECOND payment on an already-paid request: held for refund, no Transaction. */
  | { kind: "refund_recorded"; request: PaymentRequest; exception: PaymentRequestPaymentException }
  /** The request is no longer awaiting payment: held for refund, no Transaction. */
  | { kind: "not_payable_recorded"; request: PaymentRequest; exception: PaymentRequestPaymentException }
  /** Paystack's amount or currency differs from what that checkout asked: nothing written. */
  | { kind: "mismatch"; request: PaymentRequest }
  /** Nothing chargeable is stored for that checkout: nothing written. */
  | { kind: "not_chargeable"; request: PaymentRequest }
  /** The reference was never a checkout of this request: nothing written. */
  | { kind: "unknown_reference"; request: PaymentRequest };

// ============================================
// The case's totals: totalCost / amountPaid in ONE currency
// ============================================

/**
 * The payment status of a case from what was paid against its total (the
 * rule `incrementAmountPaid` used before #181): paid in full once the total
 * is reached, partial for anything above zero.
 */
export function paymentStatusFor(amountPaid: number, totalCost: number): PaymentStatus {
  if (amountPaid >= totalCost && totalCost > 0) return "paid";
  if (amountPaid > 0) return "partial";
  return "pending";
}

/**
 * The currency an application's `totalCost` / `amountPaid` are counted in:
 *  - its explicit `costCurrency` when stored (every case created from #181);
 *  - else "USD" when it has a positive total (a total was only ever written
 *    as the visa's `baseCostUsd` in US cents);
 *  - else undecided (null): no total and no currency yet.
 */
export function applicationCostCurrency(app: Partial<Application>): string | null {
  if (typeof app.costCurrency === "string" && app.costCurrency) return app.costCurrency;
  if (typeof app.totalCost === "number" && app.totalCost > 0) return "USD";
  return null;
}

/**
 * The update a settled payment makes to its case (issue #181). Pure.
 *
 * THE RULE (no silent mixing of US cents and kobo):
 *  - `paid` is what the payment counts as on the case: a #181 request counts
 *    its dollar price, `priceUsdCents` in "USD" (NOT the local amount
 *    charged, which depends on the rate); a LEGACY naira request counts its
 *    own stored kobo amount in "NGN" (there is no rate to convert it with).
 *  - Same currency as the case (or the case has no currency yet, which this
 *    payment then decides): `amountPaid` += amount, `costCurrency` set, and
 *    `paymentStatus` recomputed against `totalCost`.
 *  - A different currency (a legacy naira request on a dollar case): NOT
 *    added to `amountPaid` or `paymentStatus`; recorded separately in
 *    `amountPaidOtherCurrencies.<CODE>`.
 *
 * So a legacy naira request settles into `amountPaid` at its own stored
 * amount ONLY when the case has no dollar total yet (then the case is marked
 * `costCurrency: "NGN"`); otherwise it is recorded separately.
 */
export function applicationPaymentUpdate(app: Partial<Application>, paid: Money): Record<string, unknown> {
  const currency = applicationCostCurrency(app);
  if (currency === null || currency === paid.currency) {
    const amountPaid = (typeof app.amountPaid === "number" ? app.amountPaid : 0) + paid.amountMinor;
    return {
      amountPaid,
      costCurrency: paid.currency,
      paymentStatus: paymentStatusFor(amountPaid, typeof app.totalCost === "number" ? app.totalCost : 0),
    };
  }
  const others = { ...(app.amountPaidOtherCurrencies ?? {}) };
  others[paid.currency] = (others[paid.currency] ?? 0) + paid.amountMinor;
  return { amountPaidOtherCurrencies: others };
}

// ============================================
// Settlement
// ============================================

/** Statuses a request can be paid from: `approved` (checkout started); a legacy one also from `pending`, as before. */
function isAwaitingPayment(r: PaymentRequest): boolean {
  if (r.status === "approved") return true;
  return !isUsdPaymentRequest(r) && r.status === "pending";
}

/**
 * Settle a SUCCESSFUL Paystack payment on a request, atomically and once.
 * Everything is decided on the FRESH request inside ONE Firestore
 * transaction:
 *
 *  1. Which checkout was paid? The current `paystackReference`, or one in
 *     `supersededCheckouts`. A legacy request with no stored reference
 *     accepts the reference the caller checked against Paystack's metadata
 *     (as before #181). Neither: `unknown_reference`.
 *  2. Does Paystack's amount (`requested_amount` when reported) and currency
 *     equal what THAT checkout asked? No: `mismatch`, nothing written.
 *  3. Already paid: by this reference, `already_paid`; by another one, a
 *     second charge, held in `paymentRequestExceptions` for refund.
 *  4. No longer awaiting payment (cancelled / rejected / expired): held for
 *     refund too.
 *  5. Otherwise confirm, in this one commit: the request -> paid (with the
 *     superseded checkout's snapshot when that one was paid), its Transaction,
 *     and the case's `amountPaid` (see applicationPaymentUpdate).
 *
 * @param paymentRequestId the request to settle
 * @param reference the Paystack reference that was paid
 * @param reported what Paystack reports for it (verify lookup, or the
 *   signature-verified webhook payload)
 * @returns null when the request does not exist
 */
export async function settlePaymentRequest(
  paymentRequestId: string,
  reference: string,
  reported: PaystackTransactionLookup
): Promise<PaymentRequestSettleOutcome | null> {
  const ref = collections.paymentRequests.doc(paymentRequestId);
  const exceptionRef = collections.paymentRequestExceptions.doc(reference);
  const txRef = collections.transactions.doc();

  const outcome = await chargeRuntime.runTransaction(async (tx): Promise<PaymentRequestSettleOutcome | null> => {
    // ---- All reads first (Firestore transactions require reads before writes)
    const snap = await tx.get(ref);
    if (!snap.exists) return null;
    const current = snap.data() as PaymentRequest;
    const exceptionSnap = await tx.get(exceptionRef);
    const appRef = current.applicationId ? collections.applications.doc(current.applicationId) : null;
    const appSnap = appRef ? await tx.get(appRef) : null;
    const agentSnap = current.agentId ? await tx.get(collections.agents.doc(current.agentId)) : null;
    const at = chargeRuntime.now();
    const usdRequest = isUsdPaymentRequest(current);

    // ---- (1) + (2) Which checkout, and exactly what it asked? -------------
    const currentReference = current.paystackReference ?? (usdRequest ? null : reference);
    const match = matchPaidCheckout({
      reference,
      currentReference,
      currentExpected: expectedRequestCharge(current),
      // A legacy request has no lock and is never "late".
      currentExpiresAt: usdRequest ? (current.quoteExpiresAt ?? Timestamp.fromMillis(0)) : null,
      superseded: current.supersededCheckouts,
      reported,
      at,
    });
    if (match.kind === "unknown_reference") return { kind: "unknown_reference", request: current };
    const { isCurrent, entry, check } = match;
    if (!check.ok) return { kind: check.reason, request: current };

    /** Record money we hold but cannot apply (idempotent: doc id = reference). */
    const recordException = (
      reason: PaymentRequestPaymentException["reason"]
    ): PaymentRequestPaymentException => {
      if (exceptionSnap.exists) return exceptionSnap.data() as PaymentRequestPaymentException;
      const exception: PaymentRequestPaymentException = {
        id: reference,
        paymentRequestId,
        reference,
        amountMinor: check.charged.amountMinor,
        currency: check.charged.currency,
        paystackPaidAt: check.providerPaidAt ? Timestamp.fromDate(check.providerPaidAt) : null,
        reason,
        status: "open",
        createdAt: Timestamp.fromDate(at),
      };
      tx.set(exceptionRef, exception);
      console.error(
        `[payment-request] Paystack charge ${reference} on ${paymentRequestId} cannot be applied (${reason}): ` +
          `${check.charged.amountMinor} ${check.charged.currency} recorded in paymentRequestExceptions for refund`
      );
      return exception;
    };

    // ---- (3) Already paid ---------------------------------------------------
    if (current.status === "paid") {
      if (isCurrent) return { kind: "already_paid", request: current };
      return {
        kind: "refund_recorded",
        request: current,
        exception: recordException("paid_on_superseded_reference_after_request_paid"),
      };
    }
    // ---- (4) No longer awaiting payment ------------------------------------
    if (!isAwaitingPayment(current)) {
      return { kind: "not_payable_recorded", request: current, exception: recordException("request_not_payable") };
    }

    // ---- (5) Confirm + record, in this same commit -------------------------
    const now = Timestamp.fromDate(at);
    const review: { paidAfterQuoteExpiry?: true; paystackPaidAt?: Timestamp; paidOnSupersededReference?: true } = {
      ...(check.paidAfterQuoteExpiry ? { paidAfterQuoteExpiry: true as const } : {}),
      ...(check.providerPaidAt ? { paystackPaidAt: Timestamp.fromDate(check.providerPaidAt) } : {}),
      ...(entry ? { paidOnSupersededReference: true as const } : {}),
    };
    // Paid on a superseded checkout: the request takes THAT price, and its
    // then-current checkout becomes superseded in turn.
    const swap = supersededSwap(current, current.paystackReference ?? null, entry, at) as Partial<PaymentRequest>;
    const updates = {
      ...swap,
      status: "paid" as const,
      paidAt: now,
      paystackReference: reference,
      paymentTransactionId: txRef.id,
      ...review,
      updatedAt: now,
    };
    const settled = { ...current, ...updates } as PaymentRequest;

    // The agent's USER uid (GET /transactions filters on it).
    const agentUserId = (agentSnap?.exists ? (agentSnap.data() as { userId?: string }).userId : undefined) ?? current.agentId;
    const transaction: Transaction = {
      ...transactionService.buildPaymentRequestPayment(txRef.id, now, {
        paymentRequest: settled,
        agentUserId,
        amount: check.charged.amountMinor,
        currency: check.charged.currency,
        reference,
        snapshot: hasChargeSnapshot(settled) ? snapshotOf(settled) : undefined,
      }),
      ...review,
    };

    // What the payment counts as on the case: the dollar price for a #181
    // request, the legacy request's own kobo for a legacy one.
    const countsAs: Money = usdRequest && hasChargeSnapshot(settled)
      ? { amountMinor: settled.priceUsdCents!, currency: "USD" }
      : check.charged;

    if (check.paidAfterQuoteExpiry) {
      // Honoured, but flagged: the FX exposure is small, a human checks it.
      console.warn(
        `[payment-request] ${paymentRequestId} paid after its quote expired (reference ${reference}); ` +
          "settled and flagged paidAfterQuoteExpiry"
      );
    }
    if (entry) {
      console.warn(
        `[payment-request] ${paymentRequestId} settled on superseded reference ${reference} at that checkout's own price; ` +
          "flagged paidOnSupersededReference"
      );
    }

    tx.update(ref, updates);
    tx.set(txRef, transaction);
    if (appRef && appSnap?.exists) {
      const appUpdate = applicationPaymentUpdate(appSnap.data() as Application, countsAs);
      if (appUpdate.amountPaidOtherCurrencies) {
        console.warn(
          `[payment-request] ${paymentRequestId}: ${countsAs.amountMinor} ${countsAs.currency} recorded separately ` +
            `on application ${current.applicationId} (its totals are in another currency)`
        );
      }
      tx.update(appRef, { ...appUpdate, updatedAt: now, lastUpdated: now });
    } else {
      console.error(
        `[payment-request] ${paymentRequestId} paid, but application ${current.applicationId} was not found; ` +
          "its amountPaid was not updated"
      );
    }
    return { kind: "confirmed", request: settled, transaction, viaSuperseded: !!entry };
  });

  // ---- Tell the agent money actually arrived (best effort, after commit) ----
  if (outcome?.kind === "confirmed") {
    await notifyAgentPaid(outcome.request);
  }
  return outcome;
}

/** Tell the requesting agent their client paid. Never throws. */
async function notifyAgentPaid(request: PaymentRequest): Promise<void> {
  try {
    const agentUserId = (await collections.agents.doc(request.agentId).get()).data()?.userId;
    if (!agentUserId) return;
    await notificationService.notifyUser({
      userId: agentUserId,
      type: "payment_received",
      title: "Payment received",
      body:
        `${request.clientName || "Your client"} paid ` +
        `${describeRequestAmount(request)} for ${request.description}.`,
      relatedEntityType: "payment_request",
      relatedEntityId: request.id,
      data: request.applicationId ? { applicationId: request.applicationId } : undefined,
    });
  } catch (error) {
    console.error("[settlement] agent notification failed:", error);
  }
}
