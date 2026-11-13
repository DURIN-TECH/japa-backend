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
import { AuthzSubject, ROLES } from "@durin-tech/authz";

/** Thrown when an agency has no free paid seats to add another agent. */
export class SeatLimitError extends Error {
  constructor(public readonly limit: number) {
    super(
      `All ${limit} paid agent seat(s) are in use. Purchase more seats to add agents.`
    );
    this.name = "SeatLimitError";
  }
}

/**
 * Thrown by `removeAgentFromAgency` when the agent is not a member of the
 * agency the caller is acting on (issue #138). Controllers answer it like a
 * missing member, so nothing is revealed about other agencies.
 */
export class NotAgencyMemberError extends Error {
  constructor() {
    super("Agent is not a member of this agency");
    this.name = "NotAgencyMemberError";
  }
}

/**
 * The ONLY fields an agency owner may set on their agency record, through
 * `POST /agencies` (create) and `PUT /agencies/me` (update) (issue #138).
 *
 * Why an allow-list: the request body comes straight from the client and the
 * Admin SDK bypasses firestore.rules. Everything else on the record is a
 * decision somebody else makes, or is relied on as an authority, and must
 * never be copied from a request:
 *  - `ownerId` / `ownerName`: the ownership anchor read by the role lookup
 *    (claims.service.ts) and by the owner endpoints;
 *  - `status`, `reviewedBy`, `reviewedAt`, `rejectionReason`: the admin's
 *    admission decision (PUT /agencies/:id/approval);
 *  - `compliance`: the KYC/KYB/payout file and its review state, which gates
 *    payment requests and platform-client assignment. Edited only through
 *    /agencies/me/compliance (field allow-list + lock once submitted) and
 *    decided only by an admin;
 *  - `totalAgents` (the seat check counts from it), `totalCases`,
 *    `activeCases`: maintained by the member / case flows;
 *  - `slug`, `id`, `createdAt`: fixed at creation;
 *  - `logoUrl`: set only by POST /agencies/me/logo, which checks that the
 *    file is an upload issued for this agency (issue #141).
 *
 * firestore.rules makes the whole collection backend-only, so this list is
 * the single statement of what an owner can edit.
 */
export const AGENCY_OWNER_EDITABLE_FIELDS = [
  "name",
  "address",
  "state",
  "description",
  "consultationFee",
  "services",
] as const;

/** The owner-editable profile of an agency (see AGENCY_OWNER_EDITABLE_FIELDS). */
export interface AgencyProfileInput {
  name?: string;
  address?: string | null;
  state?: string | null;
  description?: string | null;
  consultationFee?: number | null;
  services?: AgencyServiceType[];
}

/** Creating an agency needs a name; the rest of the profile is optional. */
export interface CreateAgencyInput extends AgencyProfileInput {
  name: string;
}

/**
 * What the server itself may write on an agency besides the owner-editable
 * profile. Deliberately NOT reachable from a request body: only server code
 * passes these (today: the logo endpoint, after validating the upload).
 */
export interface AgencyServerWrittenFields {
  logoUrl?: string;
}

/** Result of checking a request body against the owner-editable profile. */
export type AgencyProfileCheck =
  | { ok: true; profile: AgencyProfileInput }
  | { ok: false; message: string };

/** True for a number that can be an amount of money (finite, not negative). */
function isAmount(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/**
 * Read the owner-editable agency profile out of an untrusted request body
 * (issue #138). Only the keys in AGENCY_OWNER_EDITABLE_FIELDS are looked at;
 * every other key is ignored. A key that IS on the list but carries a value
 * of the wrong type is an error (the request is refused with a 400) rather
 * than being stored as it came:
 *  - `name`: a non-empty string;
 *  - `address`, `state`, `description`: a string, or null to clear;
 *  - `consultationFee`: a non-negative number (naira), or null to clear;
 *  - `services`: an array of `{ id, name, price }`. Only those three keys of
 *    each entry are kept (the public agency page shows this list).
 * Keys that are absent stay absent, so a partial update changes only what it
 * names.
 */
export function readAgencyProfileInput(body: unknown): AgencyProfileCheck {
  const raw = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const profile: AgencyProfileInput = {};

  if (raw.name !== undefined) {
    if (typeof raw.name !== "string" || raw.name.trim() === "") {
      return { ok: false, message: "Agency name must be a non-empty string" };
    }
    profile.name = raw.name.trim();
  }

  // Optional free-text fields: a string, or null to clear.
  for (const field of ["address", "state", "description"] as const) {
    const value = raw[field];
    if (value === undefined) continue;
    if (value !== null && typeof value !== "string") {
      return { ok: false, message: `${field} must be a string` };
    }
    profile[field] = value;
  }

  if (raw.consultationFee !== undefined) {
    if (raw.consultationFee !== null && !isAmount(raw.consultationFee)) {
      return { ok: false, message: "consultationFee must be a non-negative number" };
    }
    profile.consultationFee = raw.consultationFee;
  }

  if (raw.services !== undefined) {
    if (!Array.isArray(raw.services)) {
      return { ok: false, message: "services must be an array" };
    }
    const services: AgencyServiceType[] = [];
    for (const entry of raw.services as unknown[]) {
      const service = entry as Record<string, unknown> | null;
      if (
        !service ||
        typeof service !== "object" ||
        (typeof service.id !== "string" && typeof service.id !== "number") ||
        typeof service.name !== "string" ||
        !isAmount(service.price)
      ) {
        return {
          ok: false,
          message: "Each service needs an id, a name and a non-negative price",
        };
      }
      // Copy the three known keys only; anything else on the entry is dropped.
      services.push({ id: String(service.id), name: service.name, price: service.price });
    }
    profile.services = services;
  }

  return { ok: true, profile };
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
   * Also updates the agent's document with agencyId and agencyRole, and
   * promotes the creator to the owner role in their custom claims.
   *
   * `input` must be the result of `readAgencyProfileInput` (owner-editable
   * fields only). Everything else on the record is set here: the agency
   * always starts `pending_review`, with no compliance file, one member (the
   * owner) and no logo.
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
      // Optional profile fields: null ("cleared") is stored as absent.
      address: input.address ?? undefined,
      state: input.state ?? undefined,
      description: input.description ?? undefined,
      consultationFee: input.consultationFee ?? undefined,
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

    // Promote the creator to agency owner in their custom claims, exactly as
    // owner onboarding does (issue #138). Owner views and owner endpoints
    // read the role from the claims, so without this the new owner would be
    // treated as an independent agent until something else rewrote their
    // claims. Best-effort, like onboarding: a claims failure must not undo
    // the agency that was just created (the audit script lists agencies whose
    // owner has no owner claim).
    await claimsService
      .setRoleClaims(ownerUserId, ROLES.OWNER, agency.id)
      .catch((e) => console.error("Failed to set owner claims on agency creation:", e));

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
   * The agency this principal OWNS, or null (issue #138).
   *
   * This is the check every owner-only endpoint uses. Two server-written
   * records have to agree:
   *  - the resolved principal (`req.authz`, from the custom claims, or from
   *    the role lookup when the token has no role claim yet) says the caller
   *    is an owner of agency X; and
   *  - agency X's own record names the caller as `ownerId`.
   * Looking the agency up by `ownerId` alone is not enough: an agency record
   * that names a user is only an authority when the role lookup agrees, and
   * that lookup also requires the user's agent document to say so. (Records
   * written before `agencies` became backend-only in firestore.rules could
   * name anybody.)
   */
  async getOwnedAgencyForPrincipal(
    authz: Pick<AuthzSubject, "uid" | "role" | "agencyId"> | undefined
  ): Promise<Agency | null> {
    if (!authz || authz.role !== ROLES.OWNER) return null;
    const { agencyId } = authz;
    // A usable document id, nothing else (never let doc() throw on bad data).
    if (typeof agencyId !== "string" || !agencyId || agencyId.includes("/")) return null;
    const agency = await this.getAgencyById(agencyId);
    if (!agency || agency.ownerId !== authz.uid) return null;
    return agency;
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
   * Update agency profile.
   *
   * `profile` is the owner-editable part and must be the result of
   * `readAgencyProfileInput`; it is filtered through
   * AGENCY_OWNER_EDITABLE_FIELDS once more here, so nothing else can ride
   * along even if a future caller passes a wider object. `serverFields` is
   * for values the server itself decided (see AgencyServerWrittenFields) and
   * is never built from a request body.
   */
  async updateAgency(
    agencyId: string,
    profile: AgencyProfileInput,
    serverFields: AgencyServerWrittenFields = {}
  ): Promise<Agency> {
    const agencyRef = collections.agencies.doc(agencyId);
    const doc = await agencyRef.get();

    if (!doc.exists) {
      throw new Error("Agency not found");
    }

    // Copy the allow-listed keys that are present (undefined = "not sent").
    const updates: Record<string, unknown> = {};
    for (const field of AGENCY_OWNER_EDITABLE_FIELDS) {
      if (profile[field] !== undefined) updates[field] = profile[field];
    }
    if (serverFields.logoUrl !== undefined) updates.logoUrl = serverFields.logoUrl;

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

  // NOTE (issue #138): there is deliberately no "add an existing agent to
  // an agency" method any more. Attaching an agent to an agency without the
  // agent saying yes is not something an owner may do; the one way in is an
  // invitation the agent accepts (inviteAgent + acceptInvitation below, or
  // POST /onboarding/join-agency for a new account). POST /agencies/:id/members
  // now sends such an invitation.

  /**
   * Remove an agent from an agency.
   * Cases stay with the agency (agencyId on applications is NOT cleared).
   * The agent's agentId on those applications can be cleared or reassigned separately.
   *
   * `agencyId` is the agency the caller is acting on (the controller has
   * already checked that the caller is its owner, or an admin). The agent
   * MUST currently be a member of exactly that agency (issue #138): the
   * agent id comes from the URL, so without this check the owner of one
   * agency could detach a member of any other. A missing agent, an agent
   * with no agency and an agent of a different agency are all answered the
   * same way (NotAgencyMemberError).
   */
  async removeAgentFromAgency(agencyId: string, agentId: string): Promise<void> {
    // Malformed ids can never name a member (and must not make doc() throw).
    if (typeof agentId !== "string" || !agentId || agentId.includes("/")) {
      throw new NotAgencyMemberError();
    }
    const agentRef = collections.agents.doc(agentId);
    const agentDoc = await agentRef.get();

    if (!agentDoc.exists) throw new NotAgencyMemberError();

    const agent = agentDoc.data() as Agent;
    if (!agencyId || agent.agencyId !== agencyId) {
      throw new NotAgencyMemberError();
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
   * Whether an invitation was really issued by the owner of the agency it
   * names (issue #135). Redeeming an invitation turns it into agency
   * membership, so an invitation document is only an authority when it agrees
   * with the agency's own record: the agency must exist and its `ownerId`
   * must be the invitation's `invitedBy`. That is exactly what the one server
   * flow that creates invitations guarantees (POST /agencies/:id/invitations
   * refuses anyone but the agency's owner; admins do not invite).
   *
   * Both redemption paths (acceptInvitation below and POST
   * /onboarding/join-agency) call this BEFORE doing anything else with the
   * invitation, and treat `false` as "invitation not found".
   */
  async isInvitationIssuedByAgencyOwner(
    invitation: Pick<AgencyInvitation, "agencyId" | "invitedBy">
  ): Promise<boolean> {
    const { agencyId, invitedBy } = invitation;
    // Malformed references can never match an agency owner.
    if (typeof agencyId !== "string" || !agencyId || agencyId.includes("/")) return false;
    if (typeof invitedBy !== "string" || !invitedBy) return false;
    const agencyDoc = await collections.agencies.doc(agencyId).get();
    if (!agencyDoc.exists) return false;
    return (agencyDoc.data() as Agency).ownerId === invitedBy;
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

    // Only an invitation issued by the agency's owner is an invitation at all
    // (issue #135; see isInvitationIssuedByAgencyOwner). Same answer as for a
    // missing document, so nothing is revealed about why.
    if (!(await this.isInvitationIssuedByAgencyOwner(invitation))) {
      throw new Error("Invitation not found");
    }

    if (invitation.status !== "pending") {
      throw new Error("Invitation is no longer pending");
    }

    // The invitation may only be redeemed by the address it was sent to.
    // ALWAYS enforced (issue #135): whether or not the caller already has an
    // agent profile, and a caller whose token carries no email is refused.
    if (
      !userEmail ||
      typeof invitation.invitedEmail !== "string" ||
      invitation.invitedEmail.toLowerCase() !== userEmail.toLowerCase()
    ) {
      throw new Error("This invitation was sent to a different email address.");
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
      // No profile yet → create one as a verified, available member. (The
      // invited-email match was already enforced above, for every caller.)

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
        consultationFeeUnit: "naira", // server-owned marker (#148): fee is whole naira
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
   * Decline an invitation.
   *
   * Only the address the invitation was sent to may decline it (issue #138),
   * the same match that accepting requires: `userEmail` is the email on the
   * caller's token. Anyone else, and a caller whose token carries no email,
   * gets the same answer as for a missing invitation. (The inviting owner
   * withdraws an invitation with cancelInvitation instead.)
   */
  async declineInvitation(invitationId: string, userEmail?: string): Promise<void> {
    const invitationRef = collections.agencyInvitations.doc(invitationId);
    const invitationDoc = await invitationRef.get();

    if (!invitationDoc.exists) throw new Error("Invitation not found");

    const invitation = invitationDoc.data() as AgencyInvitation;
    if (
      !userEmail ||
      typeof invitation.invitedEmail !== "string" ||
      invitation.invitedEmail.toLowerCase() !== userEmail.toLowerCase()
    ) {
      throw new Error("Invitation not found");
    }
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
