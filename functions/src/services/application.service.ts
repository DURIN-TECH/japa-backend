import {
  collections,
  subcollections,
  serverTimestamp,
} from "../utils/firebase";
import {
  Application,
  ApplicationStatus,
  ApplicationMode,
  ApplicationTimeline,
  PaymentStatus,
} from "../types";
import { Timestamp } from "firebase-admin/firestore";
import { visaService } from "./visa.service";

export interface CreateApplicationInput {
  visaTypeId: string;
  countryCode: string;
  mode: ApplicationMode;
  agentId?: string;
  userNotes?: string;
}

export interface UpdateApplicationInput {
  userNotes?: string;
  agentNotes?: string;
}

class ApplicationService {
  /**
   * Create a new application
   */
  async createApplication(
    userId: string,
    input: CreateApplicationInput
  ): Promise<Application> {
    // Verify visa type exists
    const visaType = await visaService.getVisaType(
      input.countryCode,
      input.visaTypeId
    );
    if (!visaType) {
      throw new Error("Visa type not found");
    }

    // Get requirements to count required documents
    const requirements = await visaService.getRequirements(
      input.countryCode,
      input.visaTypeId
    );
    const documentsRequired = requirements.reduce(
      (sum, req) => sum + (req.requiredDocuments?.length || 0),
      0
    );

    const docRef = collections.applications.doc();
    const now = Timestamp.now();

    const application: Application = {
      id: docRef.id,
      userId,
      visaTypeId: input.visaTypeId,
      countryCode: input.countryCode,
      mode: input.mode,
      agentId: input.agentId,
      status: "draft",
      progress: 0,
      currentStep: "Getting started",
      nextStep: "Upload required documents",
      startDate: now,
      lastUpdated: now,
      documentsRequired,
      documentsUploaded: 0,
      documentsVerified: 0,
      documentsRejected: 0,
      totalCost: visaType.baseCostUsd * 100, // Convert to cents
      amountPaid: 0,
      paymentStatus: "pending",
      userNotes: input.userNotes,
      createdAt: now,
      updatedAt: now,
    };

    await docRef.set(application);

    // Create initial timeline entry
    await this.addTimelineEntry(application.id, {
      title: "Application Started",
      description: `You started your ${visaType.name} application`,
      status: "completed",
      responsibility: "user",
    });

    return application;
  }

  /**
   * Get application by ID
   */
  async getApplicationById(
    applicationId: string
  ): Promise<Application | null> {
    const doc = await collections.applications.doc(applicationId).get();
    if (!doc.exists) {
      return null;
    }
    return doc.data() as Application;
  }

  /**
   * Get all applications for a user
   */
  async getUserApplications(userId: string): Promise<Application[]> {
    const snapshot = await collections.applications
      .where("userId", "==", userId)
      .orderBy("updatedAt", "desc")
      .get();

    return snapshot.docs.map((doc) => doc.data() as Application);
  }

  /**
   * Get applications by status
   */
  async getApplicationsByStatus(
    userId: string,
    status: ApplicationStatus
  ): Promise<Application[]> {
    const snapshot = await collections.applications
      .where("userId", "==", userId)
      .where("status", "==", status)
      .orderBy("updatedAt", "desc")
      .get();

    return snapshot.docs.map((doc) => doc.data() as Application);
  }

  /**
   * Update application
   */
  async updateApplication(
    applicationId: string,
    updates: UpdateApplicationInput
  ): Promise<Application> {
    const appRef = collections.applications.doc(applicationId);
    const doc = await appRef.get();

    if (!doc.exists) {
      throw new Error("Application not found");
    }

    await appRef.update({
      ...updates,
      updatedAt: serverTimestamp(),
      lastUpdated: serverTimestamp(),
    });

    const updated = await appRef.get();
    return updated.data() as Application;
  }

  /**
   * Update application status
   */
  async updateStatus(
    applicationId: string,
    status: ApplicationStatus,
    options?: {
      currentStep?: string;
      nextStep?: string;
      rejectionReason?: string;
    }
  ): Promise<Application> {
    const appRef = collections.applications.doc(applicationId);
    const doc = await appRef.get();

    if (!doc.exists) {
      throw new Error("Application not found");
    }

    const application = doc.data() as Application;

    // Calculate new progress based on status
    const progress = this.calculateProgress(status);

    const updateData: Partial<Application> = {
      status,
      progress,
      updatedAt: serverTimestamp() as unknown as Timestamp,
      lastUpdated: serverTimestamp() as unknown as Timestamp,
    };

    if (options?.currentStep) {
      updateData.currentStep = options.currentStep;
    }
    if (options?.nextStep) {
      updateData.nextStep = options.nextStep;
    }
    if (options?.rejectionReason) {
      updateData.rejectionReason = options.rejectionReason;
    }

    // Set completion timestamps
    if (status === "approved" || status === "rejected") {
      updateData.completedAt = serverTimestamp() as unknown as Timestamp;
    }
    if (status === "submitted_to_embassy" && !application.submittedAt) {
      updateData.submittedAt = serverTimestamp() as unknown as Timestamp;
    }

    await appRef.update(updateData);

    // Add timeline entry for status change
    await this.addTimelineEntry(applicationId, {
      title: this.getStatusTitle(status),
      description: this.getStatusDescription(status),
      status: "completed",
      responsibility: "system",
    });

    const updated = await appRef.get();
    return updated.data() as Application;
  }

  /**
   * Delete application (only drafts)
   */
  async deleteApplication(applicationId: string): Promise<void> {
    const appRef = collections.applications.doc(applicationId);
    const doc = await appRef.get();

    if (!doc.exists) {
      throw new Error("Application not found");
    }

    const application = doc.data() as Application;
    if (application.status !== "draft") {
      throw new Error("Only draft applications can be deleted");
    }

    // Delete timeline entries
    const timelineSnapshot = await subcollections.timeline(applicationId).get();
    const batch = collections.applications.firestore.batch();
    timelineSnapshot.docs.forEach((doc) => batch.delete(doc.ref));
    batch.delete(appRef);
    await batch.commit();
  }

  /**
   * Update document counts
   */
  async updateDocumentCounts(
    applicationId: string,
    counts: {
      uploaded?: number;
      verified?: number;
      rejected?: number;
    }
  ): Promise<void> {
    const updates: Record<string, unknown> = {
      updatedAt: serverTimestamp(),
      lastUpdated: serverTimestamp(),
    };

    if (counts.uploaded !== undefined) {
      updates.documentsUploaded = counts.uploaded;
    }
    if (counts.verified !== undefined) {
      updates.documentsVerified = counts.verified;
    }
    if (counts.rejected !== undefined) {
      updates.documentsRejected = counts.rejected;
    }

    await collections.applications.doc(applicationId).update(updates);
  }

  /**
   * Update payment status
   */
  async updatePaymentStatus(
    applicationId: string,
    paymentStatus: PaymentStatus,
    amountPaid?: number
  ): Promise<void> {
    const updates: Record<string, unknown> = {
      paymentStatus,
      updatedAt: serverTimestamp(),
      lastUpdated: serverTimestamp(),
    };

    if (amountPaid !== undefined) {
      updates.amountPaid = amountPaid;
    }

    await collections.applications.doc(applicationId).update(updates);
  }

  // ============================================
  // TIMELINE OPERATIONS
  // ============================================

  /**
   * Get application timeline
   */
  async getTimeline(applicationId: string): Promise<ApplicationTimeline[]> {
    const snapshot = await subcollections
      .timeline(applicationId)
      .orderBy("date", "desc")
      .get();

    return snapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    })) as ApplicationTimeline[];
  }

  /**
   * Add timeline entry
   */
  async addTimelineEntry(
    applicationId: string,
    entry: {
      title: string;
      description: string;
      status: ApplicationTimeline["status"];
      responsibility: ApplicationTimeline["responsibility"];
    }
  ): Promise<ApplicationTimeline> {
    const timelineRef = subcollections.timeline(applicationId).doc();
    const now = Timestamp.now();

    const timelineEntry: ApplicationTimeline = {
      id: timelineRef.id,
      applicationId,
      title: entry.title,
      description: entry.description,
      status: entry.status,
      date: now,
      completedAt: entry.status === "completed" ? now : undefined,
      responsibility: entry.responsibility,
      createdAt: now,
    };

    await timelineRef.set(timelineEntry);
    return timelineEntry;
  }

  // ============================================
  // HELPER METHODS
  // ============================================

  private calculateProgress(status: ApplicationStatus): number {
    const progressMap: Record<ApplicationStatus, number> = {
      draft: 10,
      pending_payment: 20,
      pending_documents: 30,
      under_review: 50,
      submitted_to_embassy: 70,
      interview_scheduled: 80,
      approved: 100,
      rejected: 100,
      withdrawn: 0,
      expired: 0,
    };
    return progressMap[status] || 0;
  }

  private getStatusTitle(status: ApplicationStatus): string {
    const titles: Record<ApplicationStatus, string> = {
      draft: "Application Started",
      pending_payment: "Payment Required",
      pending_documents: "Documents Required",
      under_review: "Under Review",
      submitted_to_embassy: "Submitted to Embassy",
      interview_scheduled: "Interview Scheduled",
      approved: "Application Approved",
      rejected: "Application Rejected",
      withdrawn: "Application Withdrawn",
      expired: "Application Expired",
    };
    return titles[status];
  }

  private getStatusDescription(status: ApplicationStatus): string {
    const descriptions: Record<ApplicationStatus, string> = {
      draft: "Your application has been created",
      pending_payment: "Please complete your payment to proceed",
      pending_documents: "Please upload the required documents",
      under_review: "Your application is being reviewed",
      submitted_to_embassy: "Your application has been submitted to the embassy",
      interview_scheduled: "Your interview has been scheduled",
      approved: "Congratulations! Your application has been approved",
      rejected: "Unfortunately, your application was not approved",
      withdrawn: "You have withdrawn your application",
      expired: "Your application has expired",
    };
    return descriptions[status];
  }
}

export const applicationService = new ApplicationService();
