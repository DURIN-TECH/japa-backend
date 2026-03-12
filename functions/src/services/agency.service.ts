import {
  collections,
  serverTimestamp,
  increment,
} from "../utils/firebase";
import {
  Agency,
  AgencyInvitation,
  AgencyService as AgencyServiceType,
  Agent,
  User,
} from "../types";
import { Timestamp } from "firebase-admin/firestore";

export interface CreateAgencyInput {
  name: string;
  address?: string;
  state?: string;
  description?: string;
  logoUrl?: string;
  consultationFee?: number;
  services?: AgencyServiceType[];
}

export interface UpdateAgencyInput {
  name?: string;
  address?: string;
  state?: string;
  description?: string;
  logoUrl?: string;
  consultationFee?: number;
  services?: AgencyServiceType[];
}

class AgencyService {
  /**
   * Create a new agency. The creator becomes the owner.
   * Also updates the agent's document with agencyId and agencyRole.
   */
  async createAgency(
    ownerUserId: string,
    ownerName: string,
    input: CreateAgencyInput
  ): Promise<Agency> {
    // Check if user already owns an agency
    const existing = await this.getAgencyByOwnerId(ownerUserId);
    if (existing) {
      throw new Error("User already owns an agency");
    }

    // Check if user has an agent profile
    const agentSnapshot = await collections.agents
      .where("userId", "==", ownerUserId)
      .limit(1)
      .get();

    if (agentSnapshot.empty) {
      throw new Error("User must have an agent profile to create an agency");
    }

    const agentDoc = agentSnapshot.docs[0];
    const agent = agentDoc.data() as Agent;

    // Don't allow creating an agency if already in one
    if (agent.agencyId) {
      throw new Error("Agent is already part of an agency. Leave first.");
    }

    const docRef = collections.agencies.doc();
    const now = Timestamp.now();

    const agency: Agency = {
      id: docRef.id,
      name: input.name,
      ownerId: ownerUserId,
      ownerName,
      address: input.address,
      state: input.state,
      description: input.description,
      logoUrl: input.logoUrl,
      consultationFee: input.consultationFee,
      services: input.services || [],
      totalAgents: 1, // Owner counts as the first member
      totalCases: 0,
      activeCases: 0,
      status: "pending_review",
      createdAt: now,
      updatedAt: now,
    };

    await docRef.set(agency);

    // Update the owner's agent profile with agency membership
    await agentDoc.ref.update({
      agencyId: agency.id,
      agencyRole: "owner",
      updatedAt: serverTimestamp(),
    });

    return agency;
  }

  /**
   * Get agency by ID
   */
  async getAgencyById(agencyId: string): Promise<Agency | null> {
    const doc = await collections.agencies.doc(agencyId).get();
    if (!doc.exists) return null;
    return doc.data() as Agency;
  }

  /**
   * Get agency by owner's userId
   */
  async getAgencyByOwnerId(ownerUserId: string): Promise<Agency | null> {
    const snapshot = await collections.agencies
      .where("ownerId", "==", ownerUserId)
      .limit(1)
      .get();

    if (snapshot.empty) return null;
    return snapshot.docs[0].data() as Agency;
  }

  /**
   * Get the agency an agent belongs to (by agent's userId)
   */
  async getAgencyForAgent(agentUserId: string): Promise<Agency | null> {
    const agentSnapshot = await collections.agents
      .where("userId", "==", agentUserId)
      .limit(1)
      .get();

    if (agentSnapshot.empty) return null;
    const agent = agentSnapshot.docs[0].data() as Agent;
    if (!agent.agencyId) return null;

    return this.getAgencyById(agent.agencyId);
  }

  /**
   * Update agency profile
   */
  async updateAgency(
    agencyId: string,
    updates: UpdateAgencyInput
  ): Promise<Agency> {
    const agencyRef = collections.agencies.doc(agencyId);
    const doc = await agencyRef.get();

    if (!doc.exists) {
      throw new Error("Agency not found");
    }

    await agencyRef.update({
      ...updates,
      updatedAt: serverTimestamp(),
    });

    const updated = await agencyRef.get();
    return updated.data() as Agency;
  }

  /**
   * Get all agents in an agency
   */
  async getAgencyMembers(agencyId: string): Promise<Agent[]> {
    const snapshot = await collections.agents
      .where("agencyId", "==", agencyId)
      .orderBy("displayName", "asc")
      .get();

    return snapshot.docs.map((doc) => doc.data() as Agent);
  }

  /**
   * Add an existing agent to an agency
   */
  async addAgentToAgency(
    agencyId: string,
    agentId: string
  ): Promise<void> {
    const agencyRef = collections.agencies.doc(agencyId);
    const agentRef = collections.agents.doc(agentId);

    const [agencyDoc, agentDoc] = await Promise.all([
      agencyRef.get(),
      agentRef.get(),
    ]);

    if (!agencyDoc.exists) throw new Error("Agency not found");
    if (!agentDoc.exists) throw new Error("Agent not found");

    const agent = agentDoc.data() as Agent;
    if (agent.agencyId) {
      throw new Error("Agent is already part of an agency");
    }

    // Update agent with agency membership
    await agentRef.update({
      agencyId,
      agencyRole: "agent",
      updatedAt: serverTimestamp(),
    });

    // Increment agency's agent count
    await agencyRef.update({
      totalAgents: increment(1),
      updatedAt: serverTimestamp(),
    });
  }

  /**
   * Remove an agent from an agency.
   * Cases stay with the agency (agencyId on applications is NOT cleared).
   * The agent's agentId on those applications can be cleared or reassigned separately.
   */
  async removeAgentFromAgency(agentId: string): Promise<void> {
    const agentRef = collections.agents.doc(agentId);
    const agentDoc = await agentRef.get();

    if (!agentDoc.exists) throw new Error("Agent not found");

    const agent = agentDoc.data() as Agent;
    if (!agent.agencyId) {
      throw new Error("Agent is not part of any agency");
    }

    if (agent.agencyRole === "owner") {
      throw new Error("Agency owner cannot be removed. Transfer ownership or delete the agency.");
    }

    const agencyRef = collections.agencies.doc(agent.agencyId);

    // Clear agent's agency membership
    await agentRef.update({
      agencyId: null,
      agencyRole: null,
      updatedAt: serverTimestamp(),
    });

    // Decrement agency's agent count
    await agencyRef.update({
      totalAgents: increment(-1),
      updatedAt: serverTimestamp(),
    });
  }

  // ============================================
  // INVITATION OPERATIONS
  // ============================================

  /**
   * Create an invitation for an agent to join an agency
   */
  async inviteAgent(
    agencyId: string,
    agencyName: string,
    invitedBy: string,
    invitedByName: string,
    invitedEmail: string
  ): Promise<AgencyInvitation> {
    // Check for existing pending invitation
    const existingSnapshot = await collections.agencyInvitations
      .where("agencyId", "==", agencyId)
      .where("invitedEmail", "==", invitedEmail)
      .where("status", "==", "pending")
      .limit(1)
      .get();

    if (!existingSnapshot.empty) {
      throw new Error("An invitation has already been sent to this email");
    }

    // Check if the agent already exists on the platform
    const userSnapshot = await collections.users
      .where("email", "==", invitedEmail)
      .limit(1)
      .get();

    let invitedAgentId: string | undefined;
    if (!userSnapshot.empty) {
      const userId = userSnapshot.docs[0].id;
      const agentSnapshot = await collections.agents
        .where("userId", "==", userId)
        .limit(1)
        .get();

      if (!agentSnapshot.empty) {
        invitedAgentId = agentSnapshot.docs[0].id;
      }
    }

    const docRef = collections.agencyInvitations.doc();
    const now = Timestamp.now();
    const expiresAt = Timestamp.fromMillis(
      now.toMillis() + 7 * 24 * 60 * 60 * 1000 // 7 days
    );

    const invitation: AgencyInvitation = {
      id: docRef.id,
      agencyId,
      agencyName,
      invitedBy,
      invitedByName,
      invitedEmail,
      invitedAgentId,
      status: "pending",
      createdAt: now,
      expiresAt,
    };

    await docRef.set(invitation);
    return invitation;
  }

  /**
   * Accept an invitation
   */
  async acceptInvitation(
    invitationId: string,
    agentUserId: string
  ): Promise<void> {
    const invitationRef = collections.agencyInvitations.doc(invitationId);
    const invitationDoc = await invitationRef.get();

    if (!invitationDoc.exists) throw new Error("Invitation not found");

    const invitation = invitationDoc.data() as AgencyInvitation;
    if (invitation.status !== "pending") {
      throw new Error("Invitation is no longer pending");
    }

    // Check expiry
    if (invitation.expiresAt.toMillis() < Date.now()) {
      await invitationRef.update({ status: "expired" });
      throw new Error("Invitation has expired");
    }

    // Find the agent by userId
    const agentSnapshot = await collections.agents
      .where("userId", "==", agentUserId)
      .limit(1)
      .get();

    if (agentSnapshot.empty) {
      throw new Error("Agent profile not found");
    }

    const agentDoc = agentSnapshot.docs[0];
    const agent = agentDoc.data() as Agent;

    if (agent.agencyId) {
      throw new Error("Agent is already part of an agency. Leave first.");
    }

    // Update agent with agency membership
    await agentDoc.ref.update({
      agencyId: invitation.agencyId,
      agencyRole: "agent",
      updatedAt: serverTimestamp(),
    });

    // Update invitation status
    await invitationRef.update({ status: "accepted" });

    // Increment agency's agent count
    await collections.agencies.doc(invitation.agencyId).update({
      totalAgents: increment(1),
      updatedAt: serverTimestamp(),
    });
  }

  /**
   * Decline an invitation
   */
  async declineInvitation(invitationId: string): Promise<void> {
    const invitationRef = collections.agencyInvitations.doc(invitationId);
    const invitationDoc = await invitationRef.get();

    if (!invitationDoc.exists) throw new Error("Invitation not found");

    const invitation = invitationDoc.data() as AgencyInvitation;
    if (invitation.status !== "pending") {
      throw new Error("Invitation is no longer pending");
    }

    await invitationRef.update({ status: "declined" });
  }

  /**
   * Get all invitations for an agency
   */
  async getAgencyInvitations(agencyId: string): Promise<AgencyInvitation[]> {
    const snapshot = await collections.agencyInvitations
      .where("agencyId", "==", agencyId)
      .orderBy("createdAt", "desc")
      .get();

    return snapshot.docs.map((doc) => doc.data() as AgencyInvitation);
  }

  /**
   * Get pending invitations for a specific email (for the invited agent to see)
   */
  async getPendingInvitationsForEmail(email: string): Promise<AgencyInvitation[]> {
    const snapshot = await collections.agencyInvitations
      .where("invitedEmail", "==", email)
      .where("status", "==", "pending")
      .get();

    return snapshot.docs.map((doc) => doc.data() as AgencyInvitation);
  }

  /**
   * Get agencies by status (admin only)
   */
  async getAgenciesByStatus(status: string): Promise<Agency[]> {
    const snapshot = await collections.agencies
      .where("status", "==", status)
      .orderBy("createdAt", "desc")
      .get();

    return snapshot.docs.map((doc) => doc.data() as Agency);
  }

  /**
   * Update agency approval status (admin only)
   */
  async updateAgencyApproval(
    agencyId: string,
    action: "approve" | "reject",
    adminUserId: string,
    reason?: string
  ): Promise<Agency> {
    const agencyRef = collections.agencies.doc(agencyId);
    const doc = await agencyRef.get();

    if (!doc.exists) {
      throw new Error("Agency not found");
    }

    const now = Timestamp.now();
    const updates: Record<string, unknown> = {
      status: action === "approve" ? "approved" : "rejected",
      reviewedBy: adminUserId,
      reviewedAt: now,
      updatedAt: now,
    };

    if (action === "reject" && reason) {
      updates.rejectionReason = reason;
    }

    await agencyRef.update(updates);
    const updated = await agencyRef.get();
    return updated.data() as Agency;
  }

  /**
   * Get agency review data: agency + owner's User profile + owner's Agent profile (admin only)
   */
  async getAgencyReviewData(
    agencyId: string
  ): Promise<{ agency: Agency; ownerUser: User; ownerAgent: Agent | null } | null> {
    const agencyDoc = await collections.agencies.doc(agencyId).get();
    if (!agencyDoc.exists) return null;

    const agency = agencyDoc.data() as Agency;

    const [userDoc, agentSnapshot] = await Promise.all([
      collections.users.doc(agency.ownerId).get(),
      collections.agents
        .where("userId", "==", agency.ownerId)
        .limit(1)
        .get(),
    ]);

    if (!userDoc.exists) return null;

    const ownerUser = { id: userDoc.id, ...userDoc.data() } as User;
    const ownerAgent = agentSnapshot.empty
      ? null
      : (agentSnapshot.docs[0].data() as Agent);

    return { agency, ownerUser, ownerAgent };
  }

  /**
   * Get all agencies (admin only)
   */
  async getAllAgencies(): Promise<Agency[]> {
    const snapshot = await collections.agencies
      .orderBy("createdAt", "desc")
      .get();

    return snapshot.docs.map((doc) => doc.data() as Agency);
  }
}

export const agencyService = new AgencyService();
