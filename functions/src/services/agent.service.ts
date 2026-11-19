import { collections, subcollections, serverTimestamp, arrayUnion, arrayRemove } from "../utils/firebase";
import {
  Agent,
  AgentReview,
  AgentVerificationStatus,
  AvailabilitySlot,
} from "../types";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { claimsService } from "./claims.service";
import { pickAllowedFields } from "../utils/pick-allowed-fields";
import type { Money } from "../types/money";
import { parseUsdPriceInput, PriceInputError, zeroUsd } from "../money/usd-price";

/**
 * Issue #179: the agent's fee is set in US DOLLARS through this body key,
 * `{ "consultationFeeUsd": { "amount": "10.00", "currency": "USD" } }`, and
 * validated by `parseUsdPriceInput` (finite, >= 0, whole cents, capped,
 * USD only). It is deliberately NOT in AGENT_SELF_EDITABLE_FIELDS: that list
 * copies values through unchecked, and a price must always be validated.
 */
export const AGENT_FEE_INPUT_FIELD = "consultationFeeUsd";

/**
 * Body keys of the old naira fee (#148). Sending one is a 400, not a silent
 * drop, so a client still on the naira screen learns the field moved.
 */
const RETIRED_AGENT_FEE_FIELDS = ["consultationFee", "consultationFeeUnit"] as const;

/**
 * Read the dollar fee from an untrusted body, if one was sent.
 *
 * @returns the validated Money, or undefined when the key is absent
 * @throws PriceInputError for a bad value or a retired naira key
 */
export function readAgentFeeInput(body: Record<string, unknown>): Money | undefined {
  for (const retired of RETIRED_AGENT_FEE_FIELDS) {
    if (body[retired] !== undefined) {
      throw new PriceInputError(
        retired,
        `was replaced by ${AGENT_FEE_INPUT_FIELD} (US dollars), e.g. { "amount": "10.00", "currency": "USD" }`
      );
    }
  }
  const raw = body[AGENT_FEE_INPUT_FIELD];
  if (raw === undefined) return undefined;
  return parseUsdPriceInput(raw, AGENT_FEE_INPUT_FIELD);
}

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
  /** Already validated (readAgentFeeInput); absent = start at zero dollars. */
  consultationFeeUsd?: Money;
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
  /** Raw body value; validated inside updateAgent (issue #179). */
  consultationFeeUsd?: unknown;
  isAvailable?: boolean;
  availableSlots?: AvailabilitySlot[];
}

/**
 * The ONLY fields an agent may change on their own agent document through
 * `PUT /agents/me` (issue #135): exactly the keys of `UpdateAgentInput`.
 * `updateAgent` copies these from the request and ignores every other key.
 *
 * Why an allow-list: the request body comes straight from the client and the
 * Admin SDK bypasses firestore.rules. Fields that decide what the agent may
 * do, or how they are presented, must never be copied from it: `agencyId` /
 * `agencyRole` (agency membership and ownership; read by the role lookup),
 * `verificationStatus` / `verifiedAt` / `verifiedBy` / `verificationDocuments`
 * (the verification decision), `userId` (who the profile belongs to), and the
 * computed stats (`rating`, `totalReviews`, `totalApplications`,
 * `successRate`, `responseTime`). Those are written only by the dedicated
 * server flows (onboarding, invitations, agency member endpoints, admin
 * verification, review aggregation).
 *
 * `isAvailable` is on the list but is NOT a free field: only a verified
 * agent may switch it on. `updateAgent` applies the same check as the
 * availability endpoint before writing it (issue #138, see
 * `assertMayBeAvailable`).
 *
 * See also `selfEditableAgentFields()` in firestore.rules (direct client
 * writes; slightly stricter, it leaves out `isAvailable`).
 */
export const AGENT_SELF_EDITABLE_FIELDS = [
  "displayName",
  "bio",
  "profilePhotoUrl",
  "licenseNumber",
  "yearsOfExperience",
  "specializations",
  "languages",
  "featuredVisas",
  // Issue #179: no price here. `consultationFeeUsd` is written by updateAgent
  // only after `readAgentFeeInput` validated it; the naira `consultationFee`
  // and the never-used `serviceFees` are gone.
  "isAvailable",
  "availableSlots",
] as const;

/**
 * Thrown when an agent who is not verified tries to switch themselves
 * available. One rule, enforced in one place (`assertMayBeAvailable`), for
 * both endpoints that can set `isAvailable`: PUT /agents/me/availability and
 * PUT /agents/me (issue #138). The message is kept as it always was, since
 * existing handlers match on it.
 */
export class AgentNotVerifiedError extends Error {
  constructor() {
    super("Agent must be verified to be available");
    this.name = "AgentNotVerifiedError";
  }
}

/** Thrown when `isAvailable` is sent with a value that is not a boolean. */
export class InvalidAvailabilityError extends Error {
  constructor() {
    super("isAvailable must be a boolean");
    this.name = "InvalidAvailabilityError";
  }
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
      // Issue #179: dollars; a new agent starts at $0 unless a fee was sent.
      consultationFeeUsd: input.consultationFeeUsd ?? zeroUsd(),
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
   * The publicly visible agents of one agency, for the unauthenticated
   * `GET /agencies/browse/:id/agents` (issue #144).
   *
   * Same rule and same shape as the public `GET /agents`: only
   * `verificationStatus === "verified"` agents, returned as the stored Agent
   * doc (exactly what `getAgents()` returns, so nothing beyond what
   * `GET /agents` already exposes). The directory also requires
   * `isAvailable === true`. Only agents whose `agencyId` is this agency.
   *
   * Query: `agencyId ==` ordered by `displayName asc`, served by the
   * existing `agents (agencyId ASC, displayName ASC)` index; the verified /
   * available filters run in memory (an agency's roster is small), so no
   * new composite index is needed.
   *
   * The caller must check the agency is public first (the controller 404s
   * otherwise), so a non-approved agency's roster is never exposed.
   */
  async getPublicAgentsByAgency(agencyId: string): Promise<Agent[]> {
    const snapshot = await collections.agents
      .where("agencyId", "==", agencyId)
      .orderBy("displayName", "asc")
      .get();

    return snapshot.docs
      .map((doc) => doc.data() as Agent)
      .filter((a) => a.agencyId === agencyId && a.verificationStatus === "verified" && a.isAvailable === true);
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

    // Copy ONLY the self-editable profile fields (issue #135): `input` is the
    // raw request body for PUT /agents/me (see AGENT_SELF_EDITABLE_FIELDS for
    // what must stay server-written). Unknown keys are dropped silently.
    const updates = pickAllowedFields(input, AGENT_SELF_EDITABLE_FIELDS);

    // The dollar fee (issue #179): validated here, before anything is
    // written, so a bad value (or an old naira key) is a 400 that changes
    // nothing. Throws PriceInputError.
    const fee = readAgentFeeInput(input as Record<string, unknown>);

    // `isAvailable` is the one allow-listed field with a condition attached:
    // the same verified-only rule as PUT /agents/me/availability (issue #138).
    // Checked BEFORE anything is written, so a refused request changes
    // nothing at all.
    if (updates.isAvailable !== undefined) {
      this.assertMayBeAvailable(doc.data() as Agent, updates.isAvailable);
    }

    // Writing the dollar fee also REMOVES the old naira fee and its #148
    // marker, so a doc never holds two prices (replace, not shadow). The
    // migration then sees the dollar field and leaves the doc alone.
    const feeWrite = fee
      ? {
        consultationFeeUsd: fee,
        consultationFee: FieldValue.delete(),
        consultationFeeUnit: FieldValue.delete(),
      }
      : {};

    await agentRef.update({
      ...updates,
      ...feeWrite,
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

    // Enforce the status at the AUTH layer, not just cosmetically: suspending or
    // rejecting an agent disables their account (revokes their session + sets a
    // `disabled` claim so verifyAuth blocks every request); verifying re-enables
    // it. Best-effort — a claims hiccup must not fail the status write, but log.
    const agent = doc.data() as Agent;
    if (agent.userId) {
      if (status === "rejected" || status === "suspended") {
        await claimsService
          .setAccountDisabled(agent.userId, true)
          .catch((e) => console.error("Failed to disable agent account:", e));
      } else if (status === "verified") {
        await claimsService
          .setAccountDisabled(agent.userId, false)
          .catch((e) => console.error("Failed to re-enable agent account:", e));
      }
    }

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
   * The one rule for `isAvailable`, used by every path that can set it
   * (setAvailability below and updateAgent, issue #138): the value must be a
   * boolean, and only a VERIFIED agent may switch it on. Switching it off is
   * always allowed. Throws InvalidAvailabilityError / AgentNotVerifiedError.
   */
  private assertMayBeAvailable(agent: Agent, isAvailable: unknown): void {
    if (typeof isAvailable !== "boolean") {
      throw new InvalidAvailabilityError();
    }
    if (isAvailable && agent.verificationStatus !== "verified") {
      throw new AgentNotVerifiedError();
    }
  }

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
    this.assertMayBeAvailable(agent, isAvailable);

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
