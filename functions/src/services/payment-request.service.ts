import { collections, serverTimestamp } from "../utils/firebase";
import { PaymentRequest, PaymentRequestStatus, PaymentRequestCategory } from "../types";
import { Timestamp } from "firebase-admin/firestore";

export interface CreatePaymentRequestInput {
  applicationId: string;
  agentId: string;
  agencyId?: string;
  clientId: string;
  clientName: string;
  clientEmail: string;
  amount: number;
  currency: string;
  description: string;
  category: PaymentRequestCategory;
}

class PaymentRequestService {
  /**
   * Create a new payment request
   */
  async createPaymentRequest(input: CreatePaymentRequestInput): Promise<PaymentRequest> {
    const ref = collections.paymentRequests.doc();
    const paymentRequest: Omit<PaymentRequest, "id"> & { id: string } = {
      id: ref.id,
      ...input,
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

  /**
   * Update payment request status
   */
  async updateStatus(id: string, status: PaymentRequestStatus): Promise<PaymentRequest> {
    const ref = collections.paymentRequests.doc(id);
    const doc = await ref.get();

    if (!doc.exists) {
      throw new Error("Payment request not found");
    }

    const updates: Record<string, unknown> = {
      status,
      updatedAt: serverTimestamp(),
    };

    if (status === "paid") {
      updates.paidAt = serverTimestamp();
    } else if (status === "cancelled") {
      updates.cancelledAt = serverTimestamp();
    } else if (status === "approved") {
      updates.approvedAt = serverTimestamp();
    } else if (status === "rejected") {
      updates.rejectedAt = serverTimestamp();
    }

    await ref.update(updates);
    const updated = await ref.get();
    return updated.data() as PaymentRequest;
  }

  /**
   * Delete a payment request (only if pending)
   */
  async deletePaymentRequest(id: string): Promise<void> {
    const ref = collections.paymentRequests.doc(id);
    const doc = await ref.get();

    if (!doc.exists) {
      throw new Error("Payment request not found");
    }

    const request = doc.data() as PaymentRequest;
    if (request.status !== "pending") {
      throw new Error("Can only delete pending payment requests");
    }

    await ref.delete();
  }
}

export const paymentRequestService = new PaymentRequestService();
