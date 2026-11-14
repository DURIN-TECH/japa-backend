import { collections, serverTimestamp } from "../utils/firebase";
import { PaymentRequest, PaymentRequestStatus, PaymentRequestCategory } from "../types";
import type { Money } from "../types/money";
import { Timestamp } from "firebase-admin/firestore";
import { chargeRuntime } from "./charge-checkout.service";

// ============================================
// Issue #181 review fix: agent status changes and deletes, race-safely
// ============================================

/**
 * The ONLY status changes an agent may make by hand (`PUT /:id/status`):
 * withdrawing a request the client has not paid. Everything else is either
 * the client's own decision (approve, reject), or the settlement's (paid).
 * Before this fix an agent could set any status, including `approved`
 * without the client, or `pending` on a request the client was paying.
 */
export const AGENT_STATUS_TRANSITIONS: Readonly<Record<string, readonly PaymentRequestStatus[]>> = {
  pending: ["cancelled"],
  approved: ["cancelled"],
};

/**
 * The result of an agent's cancel, decided in ONE Firestore transaction.
 *  - `cancelled`: written; carries the request as stored;
 *  - `not_found`: the request is gone;
 *  - `already_paid`: a settlement committed first; nothing written;
 *  - `not_allowed`: the request's status has no such transition (already
 *    cancelled, rejected, ...); nothing written;
 *  - `checkout_changed`: the request now carries a different checkout than
 *    the one the caller checked at Paystack (a re-issue landed in between),
 *    so the in-flight check no longer holds; nothing written, try again.
 */
export type AgentCancelOutcome =
  | { kind: "cancelled"; request: PaymentRequest }
  | { kind: "not_found" }
  | { kind: "already_paid"; request: PaymentRequest }
  | { kind: "not_allowed"; request: PaymentRequest }
  | { kind: "checkout_changed"; request: PaymentRequest };

/**
 * The result of a delete, decided in ONE Firestore transaction.
 *  - `deleted`;
 *  - `not_found`;
 *  - `already_paid`: paid requests are never deleted (their Transaction and
 *    the case's `amountPaid` point at them);
 *  - `checkout_open`: a checkout was opened for it at some point (current or
 *    superseded reference). A payment may still land on that reference, and
 *    a deleted request would leave it untracked (no settlement, no
 *    exception record). Cancel instead;
 *  - `not_pending`: only a pending request may be deleted (as before #181).
 */
export type DeleteOutcome =
  | { kind: "deleted" }
  | { kind: "not_found" }
  | { kind: "already_paid" }
  | { kind: "checkout_open" }
  | { kind: "not_pending" };

/** Whether a checkout was ever opened (or claimed) for this request. */
export function hasAnyCheckout(r: Partial<PaymentRequest>): boolean {
  return !!r.paystackReference || !!r.checkoutUrl || (r.supersededCheckouts?.length ?? 0) > 0;
}

/**
 * What the controller hands over to create a request (issue #181): the
 * dollar price as `Money` (already validated with parseUsdPriceInput), never
 * a bare number and never a client-chosen currency.
 */
export interface CreatePaymentRequestInput {
  applicationId: string;
  /** The requesting agent's profile id (`agents/{id}`). */
  agentId: string;
  agencyId?: string;
  clientId: string;
  clientName: string;
  clientEmail: string;
  /** The price in US dollars ({ amountMinor: cents, currency: "USD" }). */
  priceUsd: Money;
  description: string;
  category: PaymentRequestCategory;
}

class PaymentRequestService {
  /**
   * Create a new payment request (pending). Issue #181: stored in dollars; no
   * rate is read until the client starts checkout.
   */
  async createPaymentRequest(input: CreatePaymentRequestInput): Promise<PaymentRequest> {
    if (input.priceUsd.currency !== "USD") {
      // The controller only ever passes parseUsdPriceInput's result; anything
      // else is a bug, and must never be stored as a request.
      throw new Error("A payment request is priced in US dollars");
    }
    const ref = collections.paymentRequests.doc();
    const paymentRequest: Omit<PaymentRequest, "id"> & { id: string } = {
      id: ref.id,
      ...input,
      priceUsd: { amountMinor: input.priceUsd.amountMinor, currency: "USD" },
      // Mirror of `priceUsd` for readers that show `amount` in minor units of
      // `currency` (the portal list): US cents, "USD". Never kobo any more.
      amount: input.priceUsd.amountMinor,
      currency: "USD",
      status: "pending",
      createdAt: serverTimestamp() as unknown as Timestamp,
      updatedAt: serverTimestamp() as unknown as Timestamp,
    };

    await ref.set(paymentRequest);
    const doc = await ref.get();
    return doc.data() as PaymentRequest;
  }

  /**
   * Approve a payment request (client approves agent's fund request)
   */
  async approvePaymentRequest(id: string): Promise<PaymentRequest> {
    const ref = collections.paymentRequests.doc(id);
    const doc = await ref.get();

    if (!doc.exists) {
      throw new Error("Payment request not found");
    }

    const request = doc.data() as PaymentRequest;
    if (request.status !== "pending") {
      throw new Error("Only pending payment requests can be approved");
    }

    await ref.update({
      status: "approved",
      approvedAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });

    const updated = await ref.get();
    return updated.data() as PaymentRequest;
  }

  /**
   * Reject a payment request (client rejects agent's fund request)
   */
  async rejectPaymentRequest(id: string, rejectionReason: string): Promise<PaymentRequest> {
    const ref = collections.paymentRequests.doc(id);
    const doc = await ref.get();

    if (!doc.exists) {
      throw new Error("Payment request not found");
    }

    const request = doc.data() as PaymentRequest;
    if (request.status !== "pending") {
      throw new Error("Only pending payment requests can be rejected");
    }

    await ref.update({
      status: "rejected",
      rejectedAt: serverTimestamp(),
      rejectionReason,
      updatedAt: serverTimestamp(),
    });

    const updated = await ref.get();
    return updated.data() as PaymentRequest;
  }

  /**
   * Get payment requests for a client (by clientId)
   */
  async getClientPaymentRequests(
    clientId: string,
    filters?: { applicationId?: string; status?: PaymentRequestStatus }
  ): Promise<PaymentRequest[]> {
    let query = collections.paymentRequests
      .where("clientId", "==", clientId)
      .orderBy("createdAt", "desc") as FirebaseFirestore.Query;

    if (filters?.applicationId) {
      query = query.where("applicationId", "==", filters.applicationId);
    }
    if (filters?.status) {
      query = query.where("status", "==", filters.status);
    }

    const snapshot = await query.get();
    return snapshot.docs.map((doc) => doc.data() as PaymentRequest);
  }

  /**
   * Get payment request by ID
   */
  async getPaymentRequestById(id: string): Promise<PaymentRequest | null> {
    const doc = await collections.paymentRequests.doc(id).get();
    return doc.exists ? (doc.data() as PaymentRequest) : null;
  }

  /**
   * Get payment requests for an agent
   */
  async getAgentPaymentRequests(
    agentId: string,
    filters?: { applicationId?: string; status?: PaymentRequestStatus }
  ): Promise<PaymentRequest[]> {
    let query = collections.paymentRequests
      .where("agentId", "==", agentId)
      .orderBy("createdAt", "desc") as FirebaseFirestore.Query;

    if (filters?.applicationId) {
      query = query.where("applicationId", "==", filters.applicationId);
    }
    if (filters?.status) {
      query = query.where("status", "==", filters.status);
    }

    const snapshot = await query.get();
    return snapshot.docs.map((doc) => doc.data() as PaymentRequest);
  }

  /**
   * Get payment requests for an agency
   */
  async getAgencyPaymentRequests(
    agencyId: string,
    filters?: { applicationId?: string; status?: PaymentRequestStatus }
  ): Promise<PaymentRequest[]> {
    let query = collections.paymentRequests
      .where("agencyId", "==", agencyId)
      .orderBy("createdAt", "desc") as FirebaseFirestore.Query;

    if (filters?.applicationId) {
      query = query.where("applicationId", "==", filters.applicationId);
    }
    if (filters?.status) {
      query = query.where("status", "==", filters.status);
    }

    const snapshot = await query.get();
    return snapshot.docs.map((doc) => doc.data() as PaymentRequest);
  }

  /**
   * Get all payment requests (admin)
   */
  async getAllPaymentRequests(
    filters?: { applicationId?: string; status?: PaymentRequestStatus }
  ): Promise<PaymentRequest[]> {
    let query = collections.paymentRequests
      .orderBy("createdAt", "desc") as FirebaseFirestore.Query;

    if (filters?.applicationId) {
      query = query.where("applicationId", "==", filters.applicationId);
    }
    if (filters?.status) {
      query = query.where("status", "==", filters.status);
    }

    const snapshot = await query.get();
    return snapshot.docs.map((doc) => doc.data() as PaymentRequest);
  }

  // Issue #181 review fix: the generic `updateStatus(id, status)` (a plain,
  // unchecked `update` of any status) is gone. Agents cancel through
  // `cancelByAgent`; approve, reject and the settlement own every other
  // status change.

  /**
   * An agent withdraws a request (issue #181 review fix).
   *
   * The check and the write happen in ONE transaction that re-reads the
   * request. Before, the controller read the status, then a plain `update`
   * wrote the new one, so a settlement committing in between (the client
   * paying while the agent tapped Cancel) was overwritten: a paid request
   * with a Transaction read as cancelled, or as `pending`, which let the
   * client approve and pay a second time.
   *
   * @param id the request id
   * @param checkedReference the current checkout reference the caller asked
   *   Paystack about (null when the request had none). If the request now
   *   carries a different one, that check is stale: `checkout_changed`.
   */
  async cancelByAgent(id: string, checkedReference: string | null): Promise<AgentCancelOutcome> {
    const ref = collections.paymentRequests.doc(id);
    return chargeRuntime.runTransaction(async (tx): Promise<AgentCancelOutcome> => {
      const snap = await tx.get(ref);
      if (!snap.exists) return { kind: "not_found" };
      const fresh = snap.data() as PaymentRequest;
      // A settlement won the race: the request is final.
      if (fresh.status === "paid") return { kind: "already_paid", request: fresh };
      if (!(AGENT_STATUS_TRANSITIONS[fresh.status] ?? []).includes("cancelled")) {
        return { kind: "not_allowed", request: fresh };
      }
      if ((fresh.paystackReference ?? null) !== checkedReference) {
        return { kind: "checkout_changed", request: fresh };
      }
      const at = Timestamp.fromDate(chargeRuntime.now());
      tx.update(ref, { status: "cancelled", cancelledAt: at, updatedAt: at });
      return { kind: "cancelled", request: { ...fresh, status: "cancelled", cancelledAt: at, updatedAt: at } };
    });
  }

  /**
   * Delete a payment request: only a PENDING one that never had a checkout
   * (issue #181 review fix). Decided in one transaction so a checkout or a
   * settlement landing at the same moment cannot slip past the check.
   */
  async deletePaymentRequest(id: string): Promise<DeleteOutcome> {
    const ref = collections.paymentRequests.doc(id);
    return chargeRuntime.runTransaction(async (tx): Promise<DeleteOutcome> => {
      const snap = await tx.get(ref);
      if (!snap.exists) return { kind: "not_found" };
      const request = snap.data() as PaymentRequest;
      if (request.status === "paid") return { kind: "already_paid" };
      if (hasAnyCheckout(request)) return { kind: "checkout_open" };
      if (request.status !== "pending") return { kind: "not_pending" };
      tx.delete(ref);
      return { kind: "deleted" };
    });
  }
}

export const paymentRequestService = new PaymentRequestService();
