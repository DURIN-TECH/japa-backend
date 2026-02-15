import { collections } from "../utils/firebase";
import { Consultation, ConsultationStatus } from "../types";
import { Timestamp } from "firebase-admin/firestore";

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
   * Update consultation status.
   */
  async updateStatus(
    id: string,
    status: ConsultationStatus,
    extra?: { cancelledBy?: string; cancellationReason?: string; summary?: string }
  ): Promise<Consultation | null> {
    const ref = collections.consultations.doc(id);
    const doc = await ref.get();
    if (!doc.exists) return null;

    const updates: Record<string, unknown> = {
      status,
      updatedAt: Timestamp.now(),
    };

    if (status === "cancelled") {
      updates.cancelledAt = Timestamp.now();
      if (extra?.cancelledBy) updates.cancelledBy = extra.cancelledBy;
      if (extra?.cancellationReason) updates.cancellationReason = extra.cancellationReason;
    }
    if (status === "completed" && extra?.summary) {
      updates.summary = extra.summary;
    }

    await ref.update(updates);
    const updated = await ref.get();
    return updated.data() as Consultation;
  }

  /**
   * Delete a consultation.
   */
  async deleteConsultation(id: string): Promise<boolean> {
    const ref = collections.consultations.doc(id);
    const doc = await ref.get();
    if (!doc.exists) return false;
    await ref.delete();
    return true;
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
