import { collections, subcollections, serverTimestamp, arrayUnion, arrayRemove } from "../utils/firebase";
import {
  Agent,
  AgentReview,
  AgentVerificationStatus,
  AvailabilitySlot,
} from "../types";
import { Timestamp } from "firebase-admin/firestore";

export interface CreateAgentInput {
  userId: string;
  displayName: string;
  bio: string;
  profilePhotoUrl?: string;
  licenseNumber?: string;
  yearsOfExperience: number;
  specializations: string[];
  languages: string[];
  featuredVisas: string[];
  consultationFee: number;
  availableSlots?: AvailabilitySlot[];
}

export interface UpdateAgentInput {
  displayName?: string;
  bio?: string;
  profilePhotoUrl?: string;
  licenseNumber?: string;
  yearsOfExperience?: number;
  specializations?: string[];
  languages?: string[];
  featuredVisas?: string[];
  consultationFee?: number;
  serviceFees?: Record<string, number>;
  isAvailable?: boolean;
  availableSlots?: AvailabilitySlot[];
}

export interface AgentFilters {
  specialization?: string;
  language?: string;
  visaType?: string;
  minRating?: number;
  isAvailable?: boolean;
}

export interface CreateReviewInput {
  userId: string;
  applicationId?: string;
  rating: number;
  title?: string;
  comment: string;
}

class AgentService {
  // ============================================
  // AGENT CRUD OPERATIONS
  // ============================================

  /**
   * Create a new agent profile
   */
  async createAgent(input: CreateAgentInput): Promise<Agent> {
    // Check if user already has an agent profile
    const existing = await this.getAgentByUserId(input.userId);
    if (existing) {
      throw new Error("Agent profile already exists for this user");
    }

    const agentRef = collections.agents.doc();
    const now = Timestamp.now();

    const agent: Agent = {
      id: agentRef.id,
      userId: input.userId,
      displayName: input.displayName,
      bio: input.bio,
      profilePhotoUrl: input.profilePhotoUrl,
      licenseNumber: input.licenseNumber,
      yearsOfExperience: input.yearsOfExperience,
      specializations: input.specializations,
      languages: input.languages,
      featuredVisas: input.featuredVisas,
      verificationStatus: "pending",
      rating: 0,
      totalReviews: 0,
      totalApplications: 0,
      successRate: 0,
      responseTime: "24-48 hours",
      consultationFee: input.consultationFee,
      serviceFees: {},
      isAvailable: false, // Not available until verified
      availableSlots: input.availableSlots || [],
      createdAt: now,
      updatedAt: now,
    };

    await agentRef.set(agent);
    return agent;
  }

  /**
   * Get agent by ID
   */
  async getAgentById(agentId: string): Promise<Agent | null> {
    const doc = await collections.agents.doc(agentId).get();
    return doc.exists ? (doc.data() as Agent) : null;
  }

  /**
   * Get agent by user ID
   */
  async getAgentByUserId(userId: string): Promise<Agent | null> {
    const snapshot = await collections.agents
      .where("userId", "==", userId)
      .limit(1)
      .get();

    if (snapshot.empty) {
      return null;
    }

    return snapshot.docs[0].data() as Agent;
  }

  /**
   * Get all verified agents with optional filters
   */
  async getAgents(filters?: AgentFilters): Promise<Agent[]> {
    let query = collections.agents.where("verificationStatus", "==", "verified");

    if (filters?.isAvailable !== undefined) {
      query = query.where("isAvailable", "==", filters.isAvailable);
    }

    if (filters?.minRating) {
      query = query.where("rating", ">=", filters.minRating);
    }

    const snapshot = await query.orderBy("rating", "desc").get();
    let agents = snapshot.docs.map((doc) => doc.data() as Agent);

    // Apply array filters (Firestore can't do array-contains with multiple conditions)
    if (filters?.specialization) {
      agents = agents.filter((a) =>
        a.specializations.includes(filters.specialization!)
      );
    }

    if (filters?.language) {
      agents = agents.filter((a) => a.languages.includes(filters.language!));
    }

    if (filters?.visaType) {
      agents = agents.filter((a) =>
        a.featuredVisas.includes(filters.visaType!)
      );
    }

    return agents;
  }

  /**
   * Get top-rated agents
   */
  async getTopAgents(limit = 10): Promise<Agent[]> {
    const snapshot = await collections.agents
      .where("verificationStatus", "==", "verified")
      .where("isAvailable", "==", true)
      .orderBy("rating", "desc")
      .limit(limit)
      .get();

    return snapshot.docs.map((doc) => doc.data() as Agent);
  }

  /**
   * Get agents for a specific visa type
   */
  async getAgentsForVisaType(visaTypeId: string): Promise<Agent[]> {
    const snapshot = await collections.agents
      .where("verificationStatus", "==", "verified")
      .where("featuredVisas", "array-contains", visaTypeId)
      .get();

    return snapshot.docs.map((doc) => doc.data() as Agent);
  }

  /**
   * Update agent profile
   */
  async updateAgent(agentId: string, input: UpdateAgentInput): Promise<Agent> {
    const agentRef = collections.agents.doc(agentId);
    const doc = await agentRef.get();

    if (!doc.exists) {
      throw new Error("Agent not found");
    }

    await agentRef.update({
      ...input,
      updatedAt: serverTimestamp(),
    });

    const updated = await agentRef.get();
    return updated.data() as Agent;
  }

  /**
   * Update agent verification status (admin only)
   */
  async updateVerificationStatus(
    agentId: string,
    status: AgentVerificationStatus,
    adminUserId: string
  ): Promise<Agent> {
    const agentRef = collections.agents.doc(agentId);
    const doc = await agentRef.get();

    if (!doc.exists) {
      throw new Error("Agent not found");
    }

    const updates: Partial<Agent> = {
      verificationStatus: status,
      updatedAt: Timestamp.now(),
    };

    if (status === "verified") {
      updates.verifiedAt = Timestamp.now();
      updates.verifiedBy = adminUserId;
      updates.isAvailable = true;
    } else if (status === "rejected" || status === "suspended") {
      updates.isAvailable = false;
    }

    await agentRef.update(updates);

    const updated = await agentRef.get();
    return updated.data() as Agent;
  }

  // ============================================
  // VERIFICATION DOCUMENTS
  // ============================================

  /**
   * Add a verification document to an agent profile
   */
  async addVerificationDocument(agentId: string, storagePath: string): Promise<void> {
    const agentRef = collections.agents.doc(agentId);
    const doc = await agentRef.get();

    if (!doc.exists) {
      throw new Error("Agent not found");
    }

    await agentRef.update({
      verificationDocuments: arrayUnion(storagePath),
      verificationStatus: "under_review",
      updatedAt: serverTimestamp(),
    });
  }

  /**
   * Remove a verification document from an agent profile
   */
  async removeVerificationDocument(agentId: string, storagePath: string): Promise<void> {
    const agentRef = collections.agents.doc(agentId);
    const doc = await agentRef.get();

    if (!doc.exists) {
      throw new Error("Agent not found");
    }

    await agentRef.update({
      verificationDocuments: arrayRemove(storagePath),
      updatedAt: serverTimestamp(),
    });
  }

  // ============================================
  // AGENT REVIEWS
  // ============================================

  /**
   * Get reviews for an agent
   */
  async getAgentReviews(
    agentId: string,
    limit = 20
  ): Promise<AgentReview[]> {
    const snapshot = await subcollections
      .reviews(agentId)
      .orderBy("createdAt", "desc")
      .limit(limit)
      .get();

    return snapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    })) as AgentReview[];
  }

  /**
   * Add a review for an agent
   */
  async addReview(
    agentId: string,
    input: CreateReviewInput
  ): Promise<AgentReview> {
    // Validate rating
    if (input.rating < 1 || input.rating > 5) {
      throw new Error("Rating must be between 1 and 5");
    }

    // Check if user already reviewed this agent
    const existingReview = await subcollections
      .reviews(agentId)
      .where("userId", "==", input.userId)
      .limit(1)
      .get();

    if (!existingReview.empty) {
      throw new Error("User has already reviewed this agent");
    }

    // Check if this is a verified client (has application with this agent)
    const applicationSnapshot = await collections.applications
      .where("userId", "==", input.userId)
      .where("agentId", "==", agentId)
      .limit(1)
      .get();

    const isVerifiedClient = !applicationSnapshot.empty;

    const reviewRef = subcollections.reviews(agentId).doc();
    const now = Timestamp.now();

    const review: AgentReview = {
      id: reviewRef.id,
      agentId,
      userId: input.userId,
      applicationId: input.applicationId,
      rating: input.rating,
      title: input.title,
      comment: input.comment,
      createdAt: now,
      isVerifiedClient,
    };

    await reviewRef.set(review);

    // Update agent's rating
    await this.recalculateAgentRating(agentId);

    return review;
  }

  /**
   * Recalculate agent's average rating
   */
  private async recalculateAgentRating(agentId: string): Promise<void> {
    const reviews = await subcollections.reviews(agentId).get();

    if (reviews.empty) {
      await collections.agents.doc(agentId).update({
        rating: 0,
        totalReviews: 0,
        updatedAt: serverTimestamp(),
      });
      return;
    }

    const ratings = reviews.docs.map((doc) => doc.data().rating as number);
    const avgRating = ratings.reduce((a, b) => a + b, 0) / ratings.length;

    await collections.agents.doc(agentId).update({
      rating: Math.round(avgRating * 10) / 10, // Round to 1 decimal
      totalReviews: reviews.size,
      updatedAt: serverTimestamp(),
    });
  }

  // ============================================
  // AGENT STATS
  // ============================================

  /**
   * Update agent's application count and success rate
   */
  async updateAgentStats(agentId: string): Promise<void> {
    const applications = await collections.applications
      .where("agentId", "==", agentId)
      .get();

    if (applications.empty) {
      return;
    }

    const total = applications.size;
    const successful = applications.docs.filter(
      (doc) => doc.data().status === "approved"
    ).length;

    const successRate = total > 0 ? Math.round((successful / total) * 100) : 0;

    await collections.agents.doc(agentId).update({
      totalApplications: total,
      successRate,
      updatedAt: serverTimestamp(),
    });
  }

  // ============================================
  // AVAILABILITY
  // ============================================

  /**
   * Update agent availability
   */
  async setAvailability(
    agentId: string,
    isAvailable: boolean
  ): Promise<Agent> {
    const agent = await this.getAgentById(agentId);
    if (!agent) {
      throw new Error("Agent not found");
    }

    // Only verified agents can be available
    if (isAvailable && agent.verificationStatus !== "verified") {
      throw new Error("Agent must be verified to be available");
    }

    await collections.agents.doc(agentId).update({
      isAvailable,
      updatedAt: serverTimestamp(),
    });

    const updated = await this.getAgentById(agentId);
    return updated!;
  }

  /**
   * Update agent's available time slots
   */
  async updateAvailableSlots(
    agentId: string,
    slots: AvailabilitySlot[]
  ): Promise<Agent> {
    await collections.agents.doc(agentId).update({
      availableSlots: slots,
      updatedAt: serverTimestamp(),
    });

    const updated = await this.getAgentById(agentId);
    return updated!;
  }
}

export const agentService = new AgentService();
