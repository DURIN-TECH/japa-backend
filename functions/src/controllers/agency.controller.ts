import { Response } from "express";
import { AuthenticatedRequest } from "../middleware/auth";
import {
  agencyService,
  NotAgencyMemberError,
  readAgencyProfileInput,
  SeatLimitError,
} from "../services/agency.service";
import { storageService } from "../services/storage.service";
import { notificationService } from "../services/notification.service";
import { emailService } from "../services/email/email.service";
import { resolveEventEmail } from "../services/email/event-templates";
import { EMAIL_BRANDING } from "../services/email/branding";
import { auth, collections } from "../utils/firebase";
import { validateStoragePath } from "../utils/storage-paths";
import { Agency, Agent, AgencyInvitation } from "../types";
// Issue #103: per-visa service prices on the public agency page.
import { agencyVisaPriceService } from "../agency-visa-prices/agency-visa-price.service";
import type { PublicAgencyVisaPrice } from "../agency-visa-prices/agency-visa-price.service";
import { ROLES } from "@durin-tech/authz";
import {
  sendSuccess,
  sendError,
  sendCreated,
  ErrorMessages,
} from "../utils/response";

// Image MIME types accepted for an agency's white-label logo. Kept narrow on
// purpose — these are the formats that render reliably in <Image>/<img> and
// avoid the XSS surface of arbitrary uploads.
const ALLOWED_LOGO_CONTENT_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/svg+xml",
];

export class AgencyController {
  // ============================================
  // WHO IS ACTING (issue #138)
  // ============================================

  /**
   * True when the caller is a platform admin BY CLAIM: the canonical `role`
   * claim or the legacy `admin: true` boolean (same two signals verifyAdmin
   * accepts). Never a document field.
   */
  private isAdmin(req: AuthenticatedRequest): boolean {
    return req.authz?.role === ROLES.ADMIN || req.user?.admin === true;
  }

  /**
   * Authorize an action on the agency named in the URL (`/agencies/:id/...`).
   *
   * Returns the agency when the caller may act on it, otherwise sends the
   * response and returns null. The caller may act when:
   *  - they are that agency's OWNER: the resolved principal (`req.authz`)
   *    says owner of exactly this agency AND the agency's own record names
   *    them (agencyService.getOwnedAgencyForPrincipal); or
   *  - `allowAdmin` is set and they are an admin by claim.
   * The agency id in the URL is therefore never trusted on its own: for an
   * owner it must be the agency of their own principal.
   */
  private async authorizeAgencyAction(
    req: AuthenticatedRequest,
    res: Response,
    agencyId: string,
    forbiddenMessage: string,
    opts: { allowAdmin?: boolean } = {}
  ): Promise<Agency | null> {
    if (opts.allowAdmin && this.isAdmin(req)) {
      const agency = await agencyService.getAgencyById(agencyId);
      if (!agency) {
        sendError(res, "NOT_FOUND", "Agency not found", 404);
        return null;
      }
      return agency;
    }

    const owned = await agencyService.getOwnedAgencyForPrincipal(req.authz);
    if (!owned || owned.id !== agencyId) {
      sendError(res, "FORBIDDEN", forbiddenMessage, 403);
      return null;
    }
    return owned;
  }

  /**
   * Create an invitation for `email` to join `agency` and email the invite
   * link. Shared by POST /agencies/:id/invitations (the owner typed an
   * address) and POST /agencies/:id/members (the owner picked an existing
   * agent, who must still accept). The caller has already been authorized as
   * the agency's owner. Throws what agencyService.inviteAgent throws
   * (SeatLimitError, duplicate invitation).
   */
  private async issueInvitation(
    agency: Agency,
    inviterUserId: string,
    email: string
  ): Promise<AgencyInvitation> {
    // Get inviter's name for denormalization
    const userDoc = await collections.users.doc(inviterUserId).get();
    const inviterName = userDoc.exists
      ? `${userDoc.data()?.firstName || ""} ${userDoc.data()?.lastName || ""}`.trim()
      : "Unknown";

    const invitation = await agencyService.inviteAgent(
      agency.id,
      agency.name,
      inviterUserId,
      inviterName,
      email
    );

    // Email the invited address directly — the invitee may not have an account
    // yet, so this bypasses notifyUser (which is keyed by an existing userId).
    const ev = resolveEventEmail("agent_invited", {
      title: "Agency invitation",
      body: "",
      relatedEntityType: "agency",
      relatedEntityId: agency.id,
    });
    // Deep-link straight to signup with the invitation context so the invitee
    // lands on a "join {agency}" flow (and is auto-added on account creation)
    // rather than the generic create-your-own-agency onboarding.
    const inviteUrl = `${EMAIL_BRANDING.appUrl}/create-account?invite=${invitation.id}`;
    await emailService
      .sendNotification({
        to: email,
        subject: ev.subject,
        title: `${inviterName} invited you to join ${agency.name}`,
        body: `${inviterName} has invited you to join ${agency.name} on Seli as an agent.\n\nCreate your account (or sign in) with this email to join the agency.`,
        actionUrl: inviteUrl,
        actionLabel: "Join agency",
      })
      .catch((e) => console.error("[invite] email failed:", e));

    return invitation;
  }

  /**
   * POST /agencies
   * Create a new agency. Caller must have an agent profile.
   *
   * Only the owner-editable profile fields are read from the body (issue
   * #138, see readAgencyProfileInput): the new agency always starts
   * `pending_review` with no compliance file, whatever the body says.
   */
  async createAgency(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const userId = req.userId!;

      const checked = readAgencyProfileInput(req.body);
      if (!checked.ok) {
        sendError(res, "VALIDATION_ERROR", checked.message, 400);
        return;
      }
      const { name } = checked.profile;
      if (!name) {
        sendError(res, "VALIDATION_ERROR", "Agency name is required", 400);
        return;
      }

      // Get the user's display name for denormalization
      const userDoc = await collections.users.doc(userId).get();
      const ownerName = userDoc.exists
        ? `${userDoc.data()?.firstName || ""} ${userDoc.data()?.lastName || ""}`.trim()
        : "Unknown";

      const agency = await agencyService.createAgency(userId, ownerName, {
        ...checked.profile,
        name,
      });

      // Confirm to the owner that creation is complete and the agency is now
      // awaiting admin approval — links to their pending-review status page.
      await notificationService
        .notifyUser({
          userId,
          type: "agency_pending_review",
          title: "Agency creation completed",
          body: `Your agency "${agency.name}" has been created and is now awaiting approval. We'll let you know as soon as it's reviewed.`,
          relatedEntityType: "agency",
          relatedEntityId: agency.id,
        })
        .catch((e) => console.error("[agency] pending-review notify failed:", e));

      sendCreated(res, agency, "Agency created successfully");
    } catch (error) {
      console.error("Error creating agency:", error);
      const message = (error as Error).message;
      if (
        message === "User already owns an agency" ||
        message === "User must have an agent profile to create an agency" ||
        message === "Agent is already part of an agency. Leave first."
      ) {
        sendError(res, "VALIDATION_ERROR", message, 400);
        return;
      }
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  /**
   * GET /agencies/me
   * Get the agency the current user belongs to (as owner or agent)
   */
  async getMyAgency(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const userId = req.userId!;

      const agency = await agencyService.getAgencyForAgent(userId);
      if (!agency) {
        sendError(res, "NOT_FOUND", "You are not part of any agency", 404);
        return;
      }

      // The compliance file holds the owner's KYC/KYB PII (BVN, ID number,
      // document paths). Non-owner agents only need to know whether the agency
      // is verified (to render the "locked until verified" callout), so redact
      // everything but the status for anyone who isn't the owner or an admin.
      const isOwner = agency.ownerId === userId;
      const isAdmin = this.isAdmin(req);

      // Self-heal a missing public slug on the owner's read so the "Your public
      // page" link shows up for agencies created before slugs existed — no
      // separate backfill needed. Only the owner triggers the write (they need
      // the link); a failure here must never block loading the agency.
      if (isOwner && !agency.slug) {
        try {
          await agencyService.ensureAgencySlug(agency);
        } catch (e) {
          console.error("Failed to backfill agency slug:", e);
        }
      }

      if (agency.compliance && !isOwner && !isAdmin) {
        agency.compliance = { status: agency.compliance.status };
      }

      sendSuccess(res, agency);
    } catch (error) {
      console.error("Error getting agency:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  /**
   * PUT /agencies/me
   * Update the agency the current user owns.
   *
   * Copies ONLY the owner-editable profile fields (issue #138): name,
   * address, state, description, consultationFee, services. Every other key
   * in the body is ignored (status, compliance, ownerId, counters, slug,
   * logoUrl, ...); a listed key with a value of the wrong type is a 400.
   */
  async updateMyAgency(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      // The agency comes from the resolved principal, checked against the
      // agency's own record (see getOwnedAgencyForPrincipal).
      const agency = await agencyService.getOwnedAgencyForPrincipal(req.authz);
      if (!agency) {
        sendError(res, "FORBIDDEN", "Only agency owners can update agency settings", 403);
        return;
      }

      const checked = readAgencyProfileInput(req.body);
      if (!checked.ok) {
        sendError(res, "VALIDATION_ERROR", checked.message, 400);
        return;
      }

      const updated = await agencyService.updateAgency(agency.id, checked.profile);

      sendSuccess(res, updated, "Agency updated successfully");
    } catch (error) {
      console.error("Error updating agency:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  /**
   * POST /agencies/me/logo/upload-url
   * Owner-only. Mint a short-lived signed URL the client uses to PUT the logo
   * file directly to Cloud Storage. The file is registered (and made public)
   * via POST /agencies/me/logo afterwards.
   */
  async getLogoUploadUrl(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { fileName, contentType } = req.body;

      if (!fileName || !contentType) {
        sendError(res, "VALIDATION_ERROR", "fileName and contentType are required", 400);
        return;
      }

      // Reject anything that isn't an allowed image type before we mint a URL.
      if (!ALLOWED_LOGO_CONTENT_TYPES.includes(contentType)) {
        sendError(
          res,
          "VALIDATION_ERROR",
          `Invalid content type. Allowed: ${ALLOWED_LOGO_CONTENT_TYPES.join(", ")}`,
          400
        );
        return;
      }

      // Only the agency owner may change branding (resolved principal,
      // confirmed by the agency's own record).
      const agency = await agencyService.getOwnedAgencyForPrincipal(req.authz);
      if (!agency) {
        sendError(res, "FORBIDDEN", "Only agency owners can update the agency logo", 403);
        return;
      }

      const result = await storageService.getSignedAgencyLogoUploadUrl(
        agency.id,
        fileName,
        contentType
      );

      sendSuccess(res, result);
    } catch (error) {
      console.error("Error getting agency logo upload URL:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  /**
   * POST /agencies/me/logo
   * Owner-only. Finalize a logo upload: verify the file exists, confirm it
   * belongs to this agency's storage prefix, make it publicly readable, and
   * persist the durable public URL onto the agency. Returns the updated agency.
   */
  async setLogo(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { storagePath } = req.body;

      if (!storagePath) {
        sendError(res, "VALIDATION_ERROR", "storagePath is required", 400);
        return;
      }

      // Only the agency owner may change branding (resolved principal,
      // confirmed by the agency's own record).
      const agency = await agencyService.getOwnedAgencyForPrincipal(req.authz);
      if (!agency) {
        sendError(res, "FORBIDDEN", "Only agency owners can update the agency logo", 403);
        return;
      }

      // Guard against a caller registering a path that isn't theirs — the path
      // must live under this agency's own logo prefix.
      // Shared validator (issue #141): an issued object directly under
      // `agency-logos/{agency.id}/`, a plain bucket-relative key and nothing else.
      const checked = validateStoragePath(storagePath, { purpose: "agency-logo", agencyId: agency.id });
      if (!checked.ok) {
        sendError(res, "VALIDATION_ERROR", "storagePath does not belong to this agency", 400);
        return;
      }

      // Confirm the client actually completed the upload.
      const exists = await storageService.fileExists(checked.key);
      if (!exists) {
        sendError(res, "VALIDATION_ERROR", "File not found at the specified path", 400);
        return;
      }

      // Make the object public and capture its stable URL for persistent rendering.
      const logoUrl = await storageService.makeFilePublic(checked.key);

      // A server-decided value (the validated upload's public URL), passed
      // as a server-written field: `logoUrl` is not owner-editable.
      const updated = await agencyService.updateAgency(agency.id, {}, { logoUrl });

      sendSuccess(res, updated, "Agency logo updated successfully");
    } catch (error) {
      console.error("Error setting agency logo:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  /**
   * GET /agencies/:id/members
   * List all agents in an agency
   */
  async getMembers(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;

      // Only admins or members of this agency may view its members. Accept BOTH
      // admin signals — the `role` claim and the legacy `admin: true` boolean —
      // to match verifyAdmin(); a legacy-claim admin has no `role: "admin"` and
      // was otherwise wrongly rejected with a 403.
      if (!this.isAdmin(req) && req.authz?.agencyId !== id) {
        sendError(res, "FORBIDDEN", ErrorMessages.FORBIDDEN, 403);
        return;
      }

      const members = await agencyService.getAgencyMembers(id);
      sendSuccess(res, members);
    } catch (error) {
      console.error("Error getting members:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  /**
   * POST /agencies/:id/members   { agentId }
   * Ask an existing, independent agent to join the agency (owner only).
   *
   * The agent is NOT attached here (issue #138): joining an agency changes
   * who can see the agent's work and what the agent may do, so it needs the
   * agent's consent. This endpoint sends the agent an ordinary invitation
   * (same record, same email, same seat check as POST /agencies/:id/invitations)
   * and answers 202; the agent becomes a member, and gets the member claims,
   * only when they accept it.
   */
  async addMember(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const userId = req.userId!;
      const { id } = req.params;
      const { agentId } = req.body;

      // A plain document id, nothing else.
      if (typeof agentId !== "string" || !agentId || agentId.includes("/")) {
        sendError(res, "VALIDATION_ERROR", "agentId is required", 400);
        return;
      }

      // Only the owner of THIS agency (admins do not invite: an invitation
      // is only valid when issued by the agency's owner).
      const agency = await this.authorizeAgencyAction(req, res, id, "Only agency owners can add members");
      if (!agency) return;

      // The agent must exist and be independent.
      const agentDoc = await collections.agents.doc(agentId).get();
      if (!agentDoc.exists) {
        sendError(res, "VALIDATION_ERROR", "Agent not found", 400);
        return;
      }
      const agent = agentDoc.data() as Agent;
      if (agent.agencyId) {
        sendError(res, "VALIDATION_ERROR", "Agent is already part of an agency", 400);
        return;
      }

      // Invite the address on the agent's ACCOUNT (Firebase Auth), which is
      // the address their token carries and the one acceptance is matched on.
      const account = await auth.getUser(agent.userId).catch(() => null);
      if (!account?.email) {
        sendError(res, "VALIDATION_ERROR", "Agent not found", 400);
        return;
      }

      const invitation = await this.issueInvitation(agency, userId, account.email);
      sendSuccess(
        res,
        { added: false, invited: true, invitationId: invitation.id },
        "Invitation sent. The agent joins the agency when they accept it.",
        202
      );
    } catch (error) {
      console.error("Error adding member:", error);
      if (error instanceof SeatLimitError) {
        sendError(res, "UPGRADE_REQUIRED", error.message, 402);
        return;
      }
      const message = (error as Error).message;
      if (message === "An invitation has already been sent to this email") {
        sendError(res, "DUPLICATE", message, 409);
        return;
      }
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  /**
   * DELETE /agencies/:id/members/:agentId
   * Remove an agent from the agency (that agency's owner, or an admin).
   *
   * Two checks (issue #138): the caller owns the agency in the URL (or is an
   * admin by claim), AND the agent is currently a member of that same agency.
   * The second check lives in the service, so the agent id from the URL can
   * never reach a member of another agency.
   */
  async removeMember(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { id, agentId } = req.params;

      const agency = await this.authorizeAgencyAction(
        req,
        res,
        id,
        "Only agency owners can remove members",
        { allowAdmin: true }
      );
      if (!agency) return;

      // Capture the agent's user id before removal so we can notify them.
      // Only used after the service has confirmed they were a member here.
      const removedUserId = (await collections.agents.doc(agentId).get()).data()
        ?.userId as string | undefined;
      await agencyService.removeAgentFromAgency(agency.id, agentId);
      if (removedUserId) {
        await notificationService
          .notifyUser({
            userId: removedUserId,
            type: "agency_member_removed",
            title: "Removed from agency",
            body: `You've been removed from ${agency.name}.`,
            relatedEntityType: "agency",
            relatedEntityId: id,
          })
          .catch((e) => console.error("[agency] remove notify failed:", e));
      }
      sendSuccess(res, { removed: true }, "Agent removed from agency");
    } catch (error) {
      // Not a member of THIS agency (wrong agency, no agency, no such agent):
      // one answer for all three, nothing changed.
      if (error instanceof NotAgencyMemberError) {
        sendError(res, "NOT_FOUND", error.message, 404);
        return;
      }
      console.error("Error removing member:", error);
      const message = (error as Error).message;
      if (
        message === "Agency owner cannot be removed. Transfer ownership or delete the agency."
      ) {
        sendError(res, "VALIDATION_ERROR", message, 400);
        return;
      }
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  /**
   * POST /agencies/:id/invitations
   * Invite an agent by email (owner only)
   */
  async inviteAgent(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const userId = req.userId!;
      const { id } = req.params;
      const { email } = req.body;

      if (!email) {
        sendError(res, "VALIDATION_ERROR", "Email is required", 400);
        return;
      }

      if (typeof email !== "string") {
        sendError(res, "VALIDATION_ERROR", "Email is required", 400);
        return;
      }

      // Only the owner of THIS agency (resolved principal + agency record).
      const agency = await this.authorizeAgencyAction(req, res, id, "Only agency owners can invite agents");
      if (!agency) return;

      const invitation = await this.issueInvitation(agency, userId, email);

      sendCreated(res, invitation, "Invitation sent successfully");
    } catch (error) {
      console.error("Error inviting agent:", error);
      if (error instanceof SeatLimitError) {
        sendError(res, "UPGRADE_REQUIRED", error.message, 402);
        return;
      }
      const message = (error as Error).message;
      if (message === "An invitation has already been sent to this email") {
        sendError(res, "DUPLICATE", message, 409);
        return;
      }
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  /**
   * GET /agencies/:id/invitations
   * List invitations for an agency (owner only)
   */
  async getInvitations(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;

      // Only the owner of THIS agency (resolved principal + agency record).
      const agency = await this.authorizeAgencyAction(req, res, id, "Only agency owners can view invitations");
      if (!agency) return;

      const invitations = await agencyService.getAgencyInvitations(id);
      sendSuccess(res, invitations);
    } catch (error) {
      console.error("Error getting invitations:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  /**
   * GET /invitations/pending
   * Get pending invitations for the authenticated user (by email)
   */
  async getMyPendingInvitations(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const email = req.user?.email;
      if (!email) {
        sendError(res, "VALIDATION_ERROR", "User email not available", 400);
        return;
      }

      const invitations = await agencyService.getPendingInvitationsForEmail(email);
      sendSuccess(res, invitations);
    } catch (error) {
      console.error("Error getting pending invitations:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  /**
   * POST /invitations/:id/accept
   * Accept an agency invitation
   */
  /**
   * GET /agencies/public/:slug  (PUBLIC — no auth)
   *
   * Powers the shareable public agency landing page (`/a/<slug>`). Resolves an
   * agency by its public slug and returns a deliberately WHITELISTED, non-sensitive
   * projection — no owner ids/emails, no compliance internals, no admission status.
   * The only compliance signal exposed is a boolean `verified` badge derived from
   * `compliance.status === "verified"`. Mirrors the `getInvitationPreview` pattern.
   */
  async getPublicAgency(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { slug } = req.params;
      const agency = await agencyService.getAgencyBySlug(slug);

      // Only surface agencies that have been admitted to the platform. Anything
      // else (pending/rejected/suspended) 404s so unapproved/withheld agencies
      // aren't publicly discoverable via a guessed slug.
      if (!agency || agency.status !== "approved") {
        sendError(res, "NOT_FOUND", "Agency not found", 404);
        return;
      }

      // ---- Per-visa service prices (issue #103) ----
      // A pricing read failure must not take the whole public page down: log
      // it and serve the page without prices (it then shows no visa list).
      let visaPrices: PublicAgencyVisaPrice[] = [];
      try {
        visaPrices = await agencyVisaPriceService.listPublic(agency.id);
      } catch (error) {
        console.error("Error loading public agency visa prices:", error);
      }

      sendSuccess(res, {
        name: agency.name,
        slug: agency.slug,
        description: agency.description ?? null,
        logoUrl: agency.logoUrl ?? null,
        state: agency.state ?? null,
        ownerName: agency.ownerName,
        // Agency-level default consultation fee in whole NAIRA (the old "in
        // cents" comment was wrong; see consultation.controller). null when unset.
        consultationFee: agency.consultationFee ?? null,
        // Public service menu (name + price only).
        services: (agency.services || []).map((s) => ({
          id: s.id,
          name: s.name,
          price: s.price,
        })),
        // Social-proof stats (safe aggregates).
        totalAgents: agency.totalAgents,
        totalCases: agency.totalCases,
        // Trust badge only — never the raw compliance file.
        verified: agency.compliance?.status === "verified",
        // Issue #103: the visas this agency offers with ITS OWN service price
        // in whole naira (null = "Contact for pricing"). Only this agency's
        // prices, only visas it may still price (own approved + priced
        // global). Separate from each visa's government fee (baseCostUsd).
        visaPrices,
      });
    } catch (error) {
      console.error("Error fetching public agency:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  /**
   * GET /invitations/:id/preview  (PUBLIC — no auth)
   *
   * Minimal, unauthenticated lookup so the signup page can show "you're joining
   * {agency} as an agent" before the invitee has an account. The invitation id
   * is a random Firestore id, so possessing it is the capability. Returns only
   * non-sensitive fields.
   */
  async getInvitationPreview(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const doc = await collections.agencyInvitations.doc(id).get();
      if (!doc.exists) {
        sendError(res, "NOT_FOUND", "Invitation not found", 404);
        return;
      }
      const invite = doc.data() as AgencyInvitation;
      const expired = invite.expiresAt.toMillis() < Date.now();
      sendSuccess(res, {
        id: invite.id,
        agencyName: invite.agencyName,
        invitedEmail: invite.invitedEmail,
        status: invite.status,
        expired,
      });
    } catch (error) {
      console.error("Error previewing invitation:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  async acceptInvitation(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const userId = req.userId!;
      const { id } = req.params;

      // Pass the caller's email so the service can enforce the invite-email
      // match when it has to create a fresh member profile.
      await agencyService.acceptInvitation(id, userId, req.user?.email);

      // Notify the inviting owner that the agent accepted.
      const invite = (await collections.agencyInvitations.doc(id).get()).data();
      if (invite?.invitedBy) {
        await notificationService
          .notifyUser({
            userId: invite.invitedBy,
            type: "invitation_accepted",
            title: "Invitation accepted",
            body: `${invite.invitedEmail} accepted your invitation to join ${invite.agencyName}.`,
            relatedEntityType: "agency",
            relatedEntityId: invite.agencyId,
          })
          .catch((e) => console.error("[invitation] accept notify failed:", e));
      }

      sendSuccess(res, { accepted: true }, "Invitation accepted");
    } catch (error) {
      console.error("Error accepting invitation:", error);
      if (error instanceof SeatLimitError) {
        sendError(res, "UPGRADE_REQUIRED", error.message, 402);
        return;
      }
      const message = (error as Error).message;
      if (
        message === "Invitation not found" ||
        message === "Invitation is no longer pending" ||
        message === "Invitation has expired" ||
        message === "This invitation was sent to a different email address." ||
        message === "Agent is already part of an agency. Leave first."
      ) {
        sendError(res, "VALIDATION_ERROR", message, 400);
        return;
      }
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  /**
   * POST /invitations/:id/decline
   * Decline an agency invitation. Only the invited address may (issue #138):
   * the service matches the email on the caller's token against the
   * invitation, and nothing is sent to the owner unless that passed.
   */
  async declineInvitation(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;

      // Capture the invitation before declining so we can notify the owner.
      const invite = (await collections.agencyInvitations.doc(id).get()).data();
      await agencyService.declineInvitation(id, req.user?.email);
      if (invite?.invitedBy) {
        await notificationService
          .notifyUser({
            userId: invite.invitedBy,
            type: "invitation_declined",
            title: "Invitation declined",
            body: `${invite.invitedEmail} declined your invitation to join ${invite.agencyName}.`,
            relatedEntityType: "agency",
            relatedEntityId: invite.agencyId,
          })
          .catch((e) => console.error("[invitation] decline notify failed:", e));
      }

      sendSuccess(res, { declined: true }, "Invitation declined");
    } catch (error) {
      console.error("Error declining invitation:", error);
      const message = (error as Error).message;
      if (message === "Invitation not found" || message === "Invitation is no longer pending") {
        sendError(res, "VALIDATION_ERROR", message, 400);
        return;
      }
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  /**
   * DELETE /invitations/:id
   * Cancel (un-send) a pending invitation. Owner-initiated: only the owner of
   * the agency the invite belongs to (or an admin) may cancel it. This is what
   * lets an owner remove a pending invite from the members list — and frees the
   * email to be re-invited later.
   */
  async cancelInvitation(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;

      // Load the invitation so we can authorize against its agency.
      const invite = (await collections.agencyInvitations.doc(id).get()).data() as
        | AgencyInvitation
        | undefined;
      if (!invite) {
        sendError(res, "NOT_FOUND", "Invitation not found", 404);
        return;
      }

      // Only the owning agency's owner (or an admin) can cancel the invite.
      // The owner check is the shared one (resolved principal + agency
      // record, issue #138). An admin may cancel even when the agency record
      // is gone, so that a stray invitation can always be cleaned up.
      if (!this.isAdmin(req)) {
        const owned = await agencyService.getOwnedAgencyForPrincipal(req.authz);
        if (!owned || owned.id !== invite.agencyId) {
          sendError(res, "FORBIDDEN", "Only agency owners can cancel invitations", 403);
          return;
        }
      }

      await agencyService.cancelInvitation(id);
      sendSuccess(res, { id, cancelled: true }, "Invitation cancelled");
    } catch (error) {
      console.error("Error cancelling invitation:", error);
      const message = (error as Error).message;
      if (message === "Invitation not found" || message === "Invitation is no longer pending") {
        sendError(res, "VALIDATION_ERROR", message, 400);
        return;
      }
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  /**
   * GET /agencies/:id/review (admin only)
   * Get agency + owner details for admin review
   */
  async getAgencyReview(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const data = await agencyService.getAgencyReviewData(id);
      if (!data) {
        sendError(res, "NOT_FOUND", "Agency not found", 404);
        return;
      }
      sendSuccess(res, data);
    } catch (error) {
      console.error("Error getting agency review data:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  /**
   * GET /agencies/pending (admin only)
   * List agencies with status "pending_review"
   */
  async getPendingAgencies(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const agencies = await agencyService.getAgenciesByStatus("pending_review");
      sendSuccess(res, agencies);
    } catch (error) {
      console.error("Error getting pending agencies:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  /**
   * PUT /agencies/:id/approval (admin only)
   * Approve or reject an agency
   * Body: { action: "approve" | "reject", reason?: string }
   */
  async updateAgencyApproval(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const adminUserId = req.userId!;
      const { id } = req.params;
      const { action, reason } = req.body;

      if (!action || !["approve", "reject"].includes(action)) {
        sendError(res, "VALIDATION_ERROR", "Action must be 'approve' or 'reject'", 400);
        return;
      }

      const agency = await agencyService.updateAgencyApproval(id, action, adminUserId, reason);

      // Notify the agency owner of the admin decision.
      if (agency?.ownerId) {
        const approved = action === "approve";
        await notificationService
          .notifyUser({
            userId: agency.ownerId,
            type: approved ? "agency_approved" : "agency_rejected",
            title: approved ? "Your agency was approved" : "Update on your agency application",
            body: approved
              ? `Your agency "${agency.name}" has been approved. You can now operate on Seli.`
              : `Your agency "${agency.name}" application was not approved${reason ? `: ${reason}` : "."}`,
            relatedEntityType: "agency",
            relatedEntityId: id,
          })
          .catch((e) => console.error("[agency] approval notify failed:", e));
      }

      sendSuccess(res, agency, `Agency ${action === "approve" ? "approved" : "rejected"} successfully`);
    } catch (error) {
      console.error("Error updating agency approval:", error);
      const message = (error as Error).message;
      if (message === "Agency not found") {
        sendError(res, "NOT_FOUND", message, 404);
        return;
      }
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  /**
   * GET /agencies (admin only)
   * List all agencies
   */
  async getAllAgencies(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const agencies = await agencyService.getAllAgencies();
      sendSuccess(res, agencies);
    } catch (error) {
      console.error("Error getting all agencies:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

}

export const agencyController = new AgencyController();
