import {
  collections,
  serverTimestamp,
  increment,
} from "../utils/firebase";
import {
  Agency,
  AgencyInvitation,
  AgencyService as AgencyServiceType,
  AgencyStatus,
  Agent,
  User,
} from "../types";
import { Timestamp } from "firebase-admin/firestore";
import { claimsService } from "./claims.service";
import { entitlementService } from "./entitlement.service";

/** Thrown when an agency has no free paid seats to add another agent. */
export class SeatLimitError extends Error {
  constructor(public readonly limit: number) {
    super(
      `All ${limit} paid agent seat(s) are in use. Purchase more seats to add agents.`
    );
    this.name = "SeatLimitError";
  }
}

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

// ============================================
// PUBLIC AGENCY DIRECTORY (issue #144)
// ============================================

/** Hard cap on `GET /agencies/browse?limit=` (and the default page size). */
export const PUBLIC_AGENCY_LIST_MAX = 100;

/**
 * Public-safe projection of an Agency for the UNAUTHENTICATED directory
 * (`GET /agencies/browse` and `GET /agencies/browse/:id`, the mobile
 * Explorer's agency screens; matches mobile `ApiAgency` in
 * `src/hooks/useAgencies.ts`).
 *
 * This is a deliberate ALLOW-LIST: it carries ONLY fields that are safe to
 * show to any anonymous browser, copied one by one in `toPublicAgency()`.
 * It intentionally EXCLUDES every private / compliance / internal field:
 *   - `ownerId`            (internal user id, a leak vector)
 *   - `compliance`         (owner KYC/KYB PII: BVN, NIN, ID docs, settlement bank)
 *   - `reviewedBy` / `reviewedAt` / `rejectionReason` (admin review metadata)
 *   - `activeCases`        (operational load, not for public consumption)
 *
 * `consultationFee` and `services` ARE included: they are customer-facing
 * pricing, not financial internals. Both are in WHOLE NAIRA, exactly as
 * stored (never divided or multiplied by 100).
 */
export interface PublicAgency {
  id: string;
  name: string;
  /** Public slug of the `/a/<slug>` landing page; null until backfilled. */
  slug: string | null;
  /** Display name only, never the owner's user id. */
  ownerName: string;
  /** Region / location. Omitted from the JSON when unset. */
  state?: string;
  /** Business address (public contact info). Omitted when unset. */
  address?: string;
  description?: string;
  logoUrl?: string;
  /** Default consultation fee in WHOLE NAIRA. Omitted when unset. */
  consultationFee?: number;
  /** Public service menu: id, name and price (WHOLE NAIRA) only. */
  services: { id: string; name: string; price: number }[];
  /** Denormalized member count (the agency's `totalAgents`). */
  agentCount: number;
  /** Track-record stat (the agency's `totalCases`). */
  totalCases: number;
  /** Always "approved": nothing else is ever returned publicly. */
  status: AgencyStatus;
  /** Compliance-verified badge (boolean only, never the compliance file). */
  verified: boolean;
  /** Serializes as `{ _seconds, _nanoseconds }` over JSON. */
  createdAt: Timestamp;
}

/**
 * Is this agency publicly visible (directory, public pages)?
 *
 * "Public" == admitted to the platform (`status === "approved"`).
 * `pending_review`, `rejected` and `suspended` agencies are never public.
 * Compliance verification is a SEPARATE gate (it unlocks payments and
 * platform-client assignment) and is shown as the `verified` badge instead,
 * so an approved but unverified agency is still listed. Shared by the slug
 * page and the browse endpoints so both gate the same way.
 */
export function isAgencyPubliclyVisible(agency: Pick<Agency, "status"> | null | undefined): boolean {
  return agency?.status === "approved";
}

/**
 * The public trust badge: true only when the agency's compliance file
 * (KYC/KYB/payout) was verified by an admin. Only this boolean is ever
 * exposed, never the file itself. Shared with the slug page.
 */
export function isAgencyComplianceVerified(agency: Pick<Agency, "compliance">): boolean {
  return agency.compliance?.status === "verified";
}

/**
 * The public service menu: id, name and price (whole naira) only, so any
 * extra field ever added to a stored service can't leak. Shared with the
 * slug page.
 */
export function toPublicAgencyServices(
  services: AgencyServiceType[] | undefined
): { id: string; name: string; price: number }[] {
  return (services || []).map((s) => ({ id: s.id, name: s.name, price: s.price }));
}

/**
 * Map a full Agency doc down to its public-safe projection (allow-list).
 * Centralized so every browse endpoint returns an identical, minimal shape
 * and no private / compliance field can accidentally leak. Optional profile
 * fields stay `undefined` when unset (dropped from the JSON), as mobile's
 * `ApiAgency` expects.
 */
export function toPublicAgency(agency: Agency): PublicAgency {
  return {
    id: agency.id,
    name: agency.name,
    slug: agency.slug ?? null,
    ownerName: agency.ownerName,
    state: agency.state,
    address: agency.address,
    description: agency.description,
    logoUrl: agency.logoUrl,
    // Whole naira, unchanged from storage.
    consultationFee: agency.consultationFee,
    services: toPublicAgencyServices(agency.services),
    agentCount: agency.totalAgents ?? 0,
    totalCases: agency.totalCases ?? 0,
    status: agency.status,
    verified: isAgencyComplianceVerified(agency),
    createdAt: agency.createdAt,
  };
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

    // Public, URL-safe handle for the shareable agency page (`/a/<slug>`).
    // Generated once at creation and never changed thereafter (stable links).
    const slug = await this.generateUniqueAgencySlug(input.name);

    const agency: Agency = {
      id: docRef.id,
      name: input.name,
      slug,
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
   * Get an agency by its public slug (used by the unauthenticated shareable
   * agency page). Returns null when no agency owns the slug.
   */
  async getAgencyBySlug(slug: string): Promise<Agency | null> {
    const snapshot = await collections.agencies
      .where("slug", "==", slug)
      .limit(1)
      .get();

    if (snapshot.empty) return null;
    return snapshot.docs[0].data() as Agency;
  }

  /**
   * Turn an agency name into a URL-safe base slug: lowercase, non-alphanumerics
   * collapsed to single hyphens, trimmed. Falls back to "agency" when the name
   * has no slug-able characters (e.g. all symbols).
   */
  private slugifyName(name: string): string {
    const base = name
      .toLowerCase()
      .normalize("NFKD") // decompose accents so diacritics can be dropped
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
    return base || "agency";
  }

  /**
   * Produce a slug that is unique across the agencies collection. Starts from
   * the slugified name and, on collision, appends a short numeric suffix
   * (`-2`, `-3`, …). Bounded so a pathological run can't loop forever; the final
   * fallback appends a short random token.
   */
  async generateUniqueAgencySlug(name: string): Promise<string> {
    const base = this.slugifyName(name);

    // Try the bare slug first, then base-2, base-3, … until one is free.
    for (let attempt = 0; attempt < 25; attempt++) {
      const candidate = attempt === 0 ? base : `${base}-${attempt + 1}`;
      const existing = await this.getAgencyBySlug(candidate);
      if (!existing) return candidate;
    }

    // Extremely unlikely fallback: base + short random token.
    const rand = Math.random().toString(36).slice(2, 8);
    return `${base}-${rand}`;
  }

  /**
   * Ensure an agency has a public `slug`, generating and persisting one if missing.
   * Lets agencies created before slugs existed self-heal on first read (so the
   * owner's "public page" link appears without an out-of-band backfill). Returns
   * the agency, mutated in place with the new slug when one had to be created.
   */
  async ensureAgencySlug(agency: Agency): Promise<Agency> {
    if (agency.slug) return agency;
    const slug = await this.generateUniqueAgencySlug(agency.name);
    await collections.agencies.doc(agency.id).update({
      slug,
      updatedAt: serverTimestamp(),
    });
    agency.slug = slug;
    return agency;
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

    // They remain an (now independent) agent — update their role claims.
    await claimsService
      .setRoleClaims(agent.userId, "agent", null)
      .catch((e) => console.error("Failed to update claims on leave:", e));

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

    // Seat-based billing: the owner can only invite agents up to the seats they
    // have paid for. Count active (non-owner) agents + outstanding pending invites
    // against the agency's `max_agents` entitlement.
    const [agencyDoc, pendingSnap] = await Promise.all([
      collections.agencies.doc(agencyId).get(),
      collections.agencyInvitations
        .where("agencyId", "==", agencyId)
        .where("status", "==", "pending")
        .get(),
    ]);
    const totalMembers = (agencyDoc.data()?.totalAgents as number) ?? 1;
    const used = totalMembers - 1 + pendingSnap.size; // exclude owner; include pending
    const seat = await entitlementService.canAddAgent(agencyId, used);
    if (!seat.allowed) {
      throw new SeatLimitError(seat.limit);
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
    agentUserId: string,
    userEmail?: string
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

    // Find the agent by userId. An invited user may NOT have an agent profile
    // yet — they signed up but never completed onboarding (the original bug
    // that stranded invited agents). In that case we create one here as a
    // member, mirroring the /onboarding/join-agency path, so accepting from the
    // dashboard invite banner (or mobile) works without a pre-existing profile.
    const agentSnapshot = await collections.agents
      .where("userId", "==", agentUserId)
      .limit(1)
      .get();

    // Authoritative seat check at the moment a seat is actually consumed: active
    // (non-owner) agents must be below the agency's paid `max_agents` seats.
    const agencyDoc = await collections.agencies.doc(invitation.agencyId).get();
    const totalMembers = (agencyDoc.data()?.totalAgents as number) ?? 1;
    const seat = await entitlementService.canAddAgent(invitation.agencyId, totalMembers - 1);
    if (!seat.allowed) {
      throw new SeatLimitError(seat.limit);
    }

    if (agentSnapshot.empty) {
      // No profile yet → create one as a verified, available member. Guard with
      // an email match (when the caller's email is known) so an invite can only
      // be redeemed by its intended recipient — same rule as join-agency.
      if (userEmail && invitation.invitedEmail.toLowerCase() !== userEmail.toLowerCase()) {
        throw new Error("This invitation was sent to a different email address.");
      }

      const userDoc = await collections.users.doc(agentUserId).get();
      const u = userDoc.data() as User | undefined;
      const displayName =
        `${u?.firstName ?? ""} ${u?.lastName ?? ""}`.trim() || u?.email || "Agent";
      const now = Timestamp.now();
      const agentRef = collections.agents.doc();
      const agent: Agent = {
        id: agentRef.id,
        userId: agentUserId,
        agencyId: invitation.agencyId,
        agencyRole: "agent",
        displayName,
        bio: "",
        yearsOfExperience: 0,
        specializations: [],
        languages: ["English"],
        featuredVisas: [],
        verificationStatus: "verified",
        rating: 0,
        totalReviews: 0,
        totalApplications: 0,
        successRate: 0,
        responseTime: "N/A",
        consultationFee: 0,
        isAvailable: true,
        createdAt: now,
        updatedAt: now,
      };
      await agentRef.set(agent);

      // Reflect completed onboarding so they aren't bounced back to onboarding.
      await collections.users.doc(agentUserId).set(
        {
          onboardingCompleted: true,
          onboardingCompletedAt: now,
          updatedAt: serverTimestamp(),
        },
        { merge: true }
      );
    } else {
      const agentDoc = agentSnapshot.docs[0];
      const agent = agentDoc.data() as Agent;

      if (agent.agencyId) {
        throw new Error("Agent is already part of an agency. Leave first.");
      }

      // Attach the existing (agency-less) profile to the agency.
      await agentDoc.ref.update({
        agencyId: invitation.agencyId,
        agencyRole: "agent",
        updatedAt: serverTimestamp(),
      });
    }

    // Reflect agency membership in the agent's role claims.
    await claimsService
      .setRoleClaims(agentUserId, "agent", invitation.agencyId)
      .catch((e) => console.error("Failed to update claims on invite accept:", e));

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
   * Cancel (delete) a pending agency invitation.
   *
   * This is the owner-initiated counterpart to declineInvitation (which is
   * invitee-initiated). The owner "un-sends" an invite they no longer want
   * outstanding. We hard-delete the doc so it disappears from the members
   * list entirely, and — importantly — so the same email can be re-invited
   * later without a stale "pending" record blocking a fresh invite.
   *
   * Only pending invitations can be cancelled: an already-accepted invite
   * corresponds to a real agent membership that must be removed via
   * removeMember, not by deleting the invitation record.
   */
  async cancelInvitation(invitationId: string): Promise<void> {
    const invitationRef = collections.agencyInvitations.doc(invitationId);
    const invitationDoc = await invitationRef.get();

    if (!invitationDoc.exists) throw new Error("Invitation not found");

    const invitation = invitationDoc.data() as AgencyInvitation;
    if (invitation.status !== "pending") {
      throw new Error("Invitation is no longer pending");
    }

    await invitationRef.delete();
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

  // ============================================
  // PUBLIC BROWSING (unauthenticated directory, issue #144)
  // ============================================

  /**
   * List the publicly visible (approved) agencies, newest first, as the
   * public projection. No `visaPrices` here: the list stays one query.
   *
   * Query: `status == "approved"` ordered by `createdAt desc`, served by the
   * existing `agencies (status ASC, createdAt DESC)` composite index.
   *
   * @param options.search case-insensitive substring match on the agency
   *   name. Applied in memory (Firestore has no "contains"), so with a
   *   search we read every approved agency, filter, THEN apply the limit.
   * @param options.limit max results, clamped to 1..PUBLIC_AGENCY_LIST_MAX
   *   (default: the max). Pushed into the query only when there is no
   *   search, else it would truncate before the name filter runs.
   */
  async listPublicAgencies(options?: { limit?: number; search?: string }): Promise<PublicAgency[]> {
    const search = options?.search?.trim().toLowerCase() || undefined;
    const requested = options?.limit;
    const limit =
      requested !== undefined && Number.isInteger(requested) && requested > 0
        ? Math.min(requested, PUBLIC_AGENCY_LIST_MAX)
        : PUBLIC_AGENCY_LIST_MAX;

    let query = collections.agencies.where("status", "==", "approved").orderBy("createdAt", "desc");
    if (!search) query = query.limit(limit);

    const snapshot = await query.get();
    let agencies = snapshot.docs.map((doc) => doc.data() as Agency);

    if (search) {
      agencies = agencies.filter((a) => (a.name ?? "").toLowerCase().includes(search)).slice(0, limit);
    }

    return agencies.map(toPublicAgency);
  }

  /**
   * One agency's public projection, or null when it does not exist or is
   * not publicly visible (not approved). Callers 404 on null with the SAME
   * body either way, so a non-approved agency's existence never leaks.
   */
  async getPublicAgencyById(agencyId: string): Promise<PublicAgency | null> {
    const agency = await this.getAgencyById(agencyId);
    if (!agency || !isAgencyPubliclyVisible(agency)) return null;
    // A doc missing its own `id` field would be corrupt; trust the path.
    return toPublicAgency({ ...agency, id: agency.id ?? agencyId });
  }
}

export const agencyService = new AgencyService();
