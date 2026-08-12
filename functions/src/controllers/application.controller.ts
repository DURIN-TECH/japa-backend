import { Response } from "express";
import { AuthenticatedRequest } from "../middleware/auth";
import { applicationService } from "../services/application.service";
import { userService } from "../services/user.service";
import { messagingService } from "../services/messaging.service";
import { notificationService } from "../services/notification.service";
import { noteService } from "../services/note.service";
import { documentRequestService } from "../services/document-request.service";
// Used to invite a freshly-provisioned client to set a password (claim their account).
import { authController } from "./auth.controller";
import { collections, auth } from "../utils/firebase";
import { can, asSubject, checkWithinLimit, paymentRequired } from "../middleware/authz";
import { complianceService } from "../services/compliance.service";
import { LIMITS } from "@durin-tech/authz";
import {
  sendSuccess,
  sendError,
  sendCreated,
  sendNoContent,
  ErrorMessages,
} from "../utils/response";
import {
  Application,
  ApplicationStatus,
  Agent,
  NotificationChannel,
} from "../types";

export class ApplicationController {
  /**
   * POST /applications
   * Create a new application
   */
  async createApplication(
    req: AuthenticatedRequest,
    res: Response
  ): Promise<void> {
    try {
      const userId = req.userId!;
      const { visaTypeId, countryCode, mode, agentId, userNotes } = req.body;

      // Validate required fields
      if (!visaTypeId || !countryCode || !mode) {
        sendError(
          res,
          "VALIDATION_ERROR",
          "visaTypeId, countryCode, and mode are required",
          400
        );
        return;
      }

      // Validate mode
      if (mode !== "self" && mode !== "agent") {
        sendError(
          res,
          "VALIDATION_ERROR",
          "mode must be 'self' or 'agent'",
          400
        );
        return;
      }

      // If agent mode, agentId is required
      if (mode === "agent" && !agentId) {
        sendError(
          res,
          "VALIDATION_ERROR",
          "agentId is required when mode is 'agent'",
          400
        );
        return;
      }

      // Enforce the per-plan active-application limit (self-serve → the client's own
      // active applications). No-op until the client has a plan with this limit.
      const activeCount = await this.countActiveApplications("userId", userId);
      if (!checkWithinLimit(req, LIMITS.MAX_ACTIVE_APPLICATIONS, activeCount)) {
        paymentRequired(
          res,
          "You've reached your plan's active application limit. Upgrade to start more."
        );
        return;
      }

      const application = await applicationService.createApplication(userId, {
        visaTypeId,
        countryCode,
        mode,
        agentId,
        userNotes,
      });

      sendCreated(res, application, "Application created successfully");
    } catch (error) {
      console.error("Error creating application:", error);
      if ((error as Error).message === "Visa type not found") {
        sendError(res, "NOT_FOUND", "Visa type not found", 404);
        return;
      }
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  /**
   * POST /applications/for-client
   *
   * Lets an authenticated AGENT start an application on a CLIENT's behalf from the
   * portal. Differs from the self-serve `createApplication` (where the caller IS the
   * applicant) in several ways:
   *   - The applicant (`userId`) is the CLIENT, resolved/provisioned from an email.
   *   - The application is tagged `mode: "agent"`, `createdVia: "portal"` and linked
   *     to the calling agent (`agentId`).
   *   - A conversation is opened between agent and client.
   *   - The client is notified across channels (in-app + push real; email/sms stub).
   */
  async createApplicationForClient(
    req: AuthenticatedRequest,
    res: Response
  ): Promise<void> {
    try {
      const callerUid = req.userId!;
      const {
        clientName,
        clientEmail,
        clientPhone,
        countryCode,
        visaTypeId,
        agentNotes,
        channels,
        // Admin-only: the owning agent + agency the admin is acting for, and an
        // optional reason. Ignored for the agent flow (owner = the caller).
        agentId: ownerAgentId,
        agencyId: ownerAgencyId,
        adminCreationReason: adminReason,
      } = req.body as {
        clientName?: string;
        clientEmail?: string;
        clientPhone?: string;
        countryCode?: string;
        visaTypeId?: string;
        agentNotes?: string;
        channels?: NotificationChannel[];
        agentId?: string;
        agencyId?: string;
        adminCreationReason?: string;
      };

      // --- Validation --------------------------------------------------------
      if (!clientName || !clientEmail || !countryCode || !visaTypeId) {
        sendError(
          res,
          "VALIDATION_ERROR",
          "clientName, clientEmail, countryCode and visaTypeId are required",
          400
        );
        return;
      }

      // --- Authorize & resolve the OWNING agent ------------------------------
      // Two kinds of caller may start an application for a client:
      //   1) An AGENT — the case is owned by them (original behaviour).
      //   2) A platform ADMIN — acting on an agency's behalf. The admin must name
      //      the owning agent (`agentId`) and agency (`agencyId`); the case is
      //      owned by that agent, but we stamp admin provenance for the audit trail.
      //
      // Either way we end up with the owning agent's USER uid (Application.agentId)
      // and DOC id (Conversation.agentId) — intentionally different identifiers.
      const isAdmin = req.authz?.role === "admin" || req.user?.admin === true;

      let ownerAgentUid: string;
      let agentDocId: string;
      // Admin provenance passed through to the created application (undefined for
      // the agent flow, so no admin fields are written).
      let adminProvenance:
        | {
            createdByAdmin: true;
            createdByAdminId: string;
            createdByAdminName?: string;
            adminCreationReason?: string;
          }
        | undefined;

      if (isAdmin) {
        // Admin flow: the owning agent + agency must be supplied and consistent.
        if (!ownerAgentId || !ownerAgencyId) {
          sendError(
            res,
            "VALIDATION_ERROR",
            "agentId and agencyId are required when an admin starts an application",
            400
          );
          return;
        }
        const ownerSnap = await collections.agents
          .where("userId", "==", ownerAgentId)
          .limit(1)
          .get();
        if (ownerSnap.empty) {
          sendError(res, "NOT_FOUND", "The selected agent could not be found", 404);
          return;
        }
        const ownerDoc = ownerSnap.docs[0];
        // Defence-in-depth: the chosen agent must belong to the chosen agency
        // (the portal filters agents by agency, but never trust the client).
        if ((ownerDoc.data() as { agencyId?: string }).agencyId !== ownerAgencyId) {
          sendError(
            res,
            "VALIDATION_ERROR",
            "The selected agent does not belong to the selected agency",
            400
          );
          return;
        }
        ownerAgentUid = ownerAgentId;
        agentDocId = ownerDoc.id;

        // Build the "which admin" audit fields from the admin's own profile.
        const adminDoc = await collections.users.doc(callerUid).get();
        const adminData = adminDoc.exists
          ? (adminDoc.data() as { firstName?: string; lastName?: string; email?: string })
          : null;
        const adminName =
          (adminData
            ? `${adminData.firstName || ""} ${adminData.lastName || ""}`.trim()
            : "") ||
          adminData?.email ||
          req.user?.email;
        adminProvenance = {
          createdByAdmin: true,
          createdByAdminId: callerUid,
          createdByAdminName: adminName || undefined,
          adminCreationReason: adminReason?.trim() || undefined,
        };
      } else {
        // Agent flow: the caller must themselves be an agent.
        const agentSnapshot = await collections.agents
          .where("userId", "==", callerUid)
          .limit(1)
          .get();
        if (agentSnapshot.empty) {
          sendError(
            res,
            "FORBIDDEN",
            "Only agents can start applications on behalf of a client",
            403
          );
          return;
        }
        ownerAgentUid = callerUid;
        agentDocId = agentSnapshot.docs[0].id;
      }

      // Enforce the active-application limit for the agency (or independent agent)
      // before provisioning anything. No-op until a plan with the limit is assigned.
      // Scope the count to the OWNING agency: for the admin flow that's the
      // agency they picked; for an agent it's their own agency (or themselves if
      // they're an independent agent).
      const scopeField = isAdmin || req.authz?.agencyId ? "agencyId" : "agentId";
      const scopeValue = isAdmin
        ? ownerAgencyId!
        : req.authz?.agencyId || callerUid;
      const activeCount = await this.countActiveApplications(scopeField, scopeValue);
      if (!checkWithinLimit(req, LIMITS.MAX_ACTIVE_APPLICATIONS, activeCount)) {
        paymentRequired(
          res,
          "Your agency has reached its active application limit. Upgrade to start more."
        );
        return;
      }

      // --- Resolve or provision the client -----------------------------------
      const normalizedEmail = clientEmail.trim().toLowerCase();
      // Split the typed full name into first/last for the user profile.
      const [firstName, ...rest] = clientName.trim().split(/\s+/);
      const lastName = rest.join(" ");

      let clientUid: string;
      let clientExisted: boolean;

      const existingUser = await userService.getUserByEmail(normalizedEmail);
      if (existingUser) {
        // LINK to the existing client. Do not touch their profile — their own
        // account details win; the typed name/phone only feed the denormalized
        // application fields below.
        clientUid = existingUser.id;
        clientExisted = true;
      } else {
        // Provision a shell account so the application has a real applicant the
        // client can later claim by signing in with this email.
        clientExisted = false;
        try {
          const authUser = await auth.createUser({
            email: normalizedEmail,
            displayName: clientName.trim(),
          });
          clientUid = authUser.uid;
        } catch (err) {
          // Race / pre-existing Auth account without a Firestore profile: an Auth
          // record already exists for this email. Recover by looking it up and
          // treating it as an existing client.
          if ((err as { code?: string }).code === "auth/email-already-exists") {
            const authUser = await auth.getUserByEmail(normalizedEmail);
            clientUid = authUser.uid;
            clientExisted = true;
          } else {
            throw err;
          }
        }

        // Create the Firestore profile for the freshly provisioned account.
        // (Skip if we recovered an existing Auth user that already has a profile.)
        if (!clientExisted) {
          await userService.createUser(clientUid, {
            email: normalizedEmail,
            firstName: firstName || clientName.trim(),
            lastName,
            phone: clientPhone,
          });
          // Mark as provisional — created by an agent, not yet self-claimed.
          await collections.users
            .doc(clientUid)
            .update({ isProvisional: true });
        }
      }

      // --- Invite a brand-new client to claim their account -------------------
      // A provisioned account has no password, so without this the client has no
      // way into the web workspace to upload documents or reply to their agent —
      // the notification below would tell them something happened but not how to
      // act on it. Best-effort and deliberately not awaited into the failure path:
      // an email problem must never fail an application that was already created.
      if (!clientExisted) {
        const agencyName = await this.resolveAgencyName(
          isAdmin ? ownerAgencyId : req.authz?.agencyId
        );
        void authController
          .sendClaimEmail(normalizedEmail, firstName, agencyName)
          .catch((e) =>
            console.error("[application] claim-account invite failed:", e)
          );
      }

      // --- Create the application (agent-managed, portal-originated) ----------
      const application = await applicationService.createApplication(clientUid, {
        visaTypeId,
        countryCode,
        mode: "agent",
        // Application.agentId = owning agent's USER uid (the caller for the agent
        // flow; the admin-selected agent for the admin flow).
        agentId: ownerAgentUid,
        agentNotes,
        createdVia: "portal",
        clientNameOverride: clientName.trim(),
        clientEmailOverride: normalizedEmail,
        clientPhoneOverride: clientPhone,
        // Admin provenance (spread only when an admin created this).
        ...(adminProvenance ?? {}),
      });

      // --- Open an agent<->client conversation --------------------------------
      // Conversation.agentId is the agent DOC id (different identifier — see above).
      const conversation = await messagingService.getOrCreateConversation(
        clientUid,
        agentDocId,
        application.id
      );

      // --- Notify the client across channels ----------------------------------
      const inviteLine = clientExisted
        ? "Your agent has started a new visa application for you. Open the app to view the details."
        : "Your agent has started a visa application for you on Seli. Download the app or check your email to follow along.";
      await notificationService.notifyUser({
        userId: clientUid,
        type: "application_created",
        title: `New ${application.visaTypeName || "visa"} application started`,
        body: inviteLine,
        // Default to in-app + email + push so a client without the app still hears
        // about it; the agent can override per request.
        channels: channels ?? ["in_app", "email", "push"],
        relatedEntityType: "application",
        relatedEntityId: application.id,
        data: { conversationId: conversation.id },
      });

      // Return the created application plus the side-effect ids and the link/invite
      // outcome so the portal can show the right confirmation message.
      sendCreated(
        res,
        {
          ...application,
          conversationId: conversation.id,
          clientExisted,
          clientId: clientUid,
        },
        clientExisted
          ? "Application created and linked to existing client"
          : "Application created and client invited"
      );
    } catch (error) {
      console.error("Error creating application for client:", error);
      if ((error as Error).message === "Visa type not found") {
        sendError(res, "NOT_FOUND", "Visa type not found", 404);
        return;
      }
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  /**
   * GET /applications
   * Get applications based on role:
   *   ?role=agent  → cases assigned to this agent
   *   ?role=owner  → all cases in the agent's agency
   *   ?role=admin  → all cases (admin only)
   *   (default)    → cases owned by this user (applicant view)
   */
  async getApplications(
    req: AuthenticatedRequest,
    res: Response
  ): Promise<void> {
    try {
      const userId = req.userId!;
      const { status, role, mode } = req.query;

      let applications: Application[];

      if (role === "admin") {
        // Admin: see everything
        if (!req.user?.admin) {
          sendError(res, "FORBIDDEN", "Admin access required", 403);
          return;
        }
        applications = await applicationService.getAllApplications();
      } else if (role === "owner") {
        // Agency owner: see all agency cases
        const agent = await this.getAgentForUser(userId);
        if (!agent?.agencyId || agent.agencyRole !== "owner") {
          sendError(res, "FORBIDDEN", "Agency owner access required", 403);
          return;
        }
        applications = await applicationService.getAgencyApplications(agent.agencyId);
      } else if (role === "agent") {
        // Agent: see cases assigned to them
        applications = await applicationService.getAgentApplications(userId);
      } else {
        // Default: applicant's own applications
        if (status && typeof status === "string") {
          applications = await applicationService.getApplicationsByStatus(
            userId,
            status as ApplicationStatus
          );
        } else {
          applications = await applicationService.getUserApplications(userId);
        }
      }

      // Filter by mode if specified (e.g., ?mode=self for self-service clients)
      if (mode && typeof mode === "string") {
        applications = applications.filter((app) => app.mode === mode);
      }

      // Resolve who is handling each case so client-facing UIs can name them.
      sendSuccess(res, await this.withHandlerNames(applications));
    } catch (error) {
      console.error("Error getting applications:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  /**
   * GET /applications/:id
   * Get a specific application.
   * Access: owner, assigned agent, same-agency member, or admin.
   */
  async getApplication(
    req: AuthenticatedRequest,
    res: Response
  ): Promise<void> {
    try {
      const { id } = req.params;

      const application = await applicationService.getApplicationById(id);

      if (!application) {
        sendError(res, "NOT_FOUND", "Application not found", 404);
        return;
      }

      const hasAccess = this.checkApplicationAccess(req, application);
      if (!hasAccess) {
        sendError(res, "FORBIDDEN", ErrorMessages.FORBIDDEN, 403);
        return;
      }

      const [enriched] = await this.withHandlerNames([application]);
      sendSuccess(res, enriched);
    } catch (error) {
      console.error("Error getting application:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  /**
   * PUT /applications/:id
   * Update an application.
   * Owner can update userNotes. Agent/owner can update agentNotes.
   */
  async updateApplication(
    req: AuthenticatedRequest,
    res: Response
  ): Promise<void> {
    try {
      const userId = req.userId!;
      const { id } = req.params;
      const { userNotes, agentNotes, agentId, agencyId, mode } = req.body;

      const application = await applicationService.getApplicationById(id);

      if (!application) {
        sendError(res, "NOT_FOUND", "Application not found", 404);
        return;
      }

      const hasAccess = this.checkApplicationAccess(req, application);
      if (!hasAccess) {
        sendError(res, "FORBIDDEN", ErrorMessages.FORBIDDEN, 403);
        return;
      }

      const isOwner = application.userId === userId;
      const updates: { userNotes?: string; agentNotes?: string; agentId?: string; agencyId?: string; mode?: "self" | "agent" } = {};

      // Only the applicant can update userNotes
      if (userNotes !== undefined && isOwner) {
        updates.userNotes = userNotes;
      }
      // Agents/agency members can update agentNotes
      if (agentNotes !== undefined && !isOwner) {
        updates.agentNotes = agentNotes;
      }
      // Agent/owner/admin can reassign agent or transfer self-service
      if (!isOwner || req.user?.admin) {
        if (agentId !== undefined) updates.agentId = agentId;
        if (agencyId !== undefined) updates.agencyId = agencyId;
        if (mode !== undefined) updates.mode = mode;
      }

      // ---- Compliance gate: platform-originated ("our") clients ----
      // An unverified agency may manage its OWN clients (cases it created via the
      // portal, createdVia="portal") but may NOT take on platform-originated
      // clients (self-serve / mobile). Block an unverified agency from being
      // assigned such a case. Admins bypass; the applicant editing their own
      // notes is unaffected (no assignment change).
      const isAdmin = req.user?.admin === true || req.authz?.role === "admin";
      const isAssigning =
        updates.agencyId !== undefined ||
        updates.agentId !== undefined ||
        updates.mode === "agent";
      // Platform-originated = anything not started by an agency in the portal.
      const isPlatformClient = application.createdVia !== "portal";
      if (!isAdmin && isAssigning && isPlatformClient) {
        // The agency the case would belong to after this change: an explicit
        // target agencyId if given, otherwise the acting caller's agency.
        const targetAgencyId =
          updates.agencyId ?? req.authz?.agencyId ?? application.agencyId;
        const verified = targetAgencyId
          ? await complianceService.isVerified(targetAgencyId)
          : false;
        if (!verified) {
          sendError(
            res,
            "COMPLIANCE_REQUIRED",
            "Your agency must complete KYC/KYB verification before taking on Seli clients. You can still manage your own clients.",
            403
          );
          return;
        }
      }

      const updated = await applicationService.updateApplication(id, updates);

      // Record an activity note when the assigned agent changes (assignment /
      // reassignment / self-service takeover) so the case notes reflect it,
      // attributed to the agent who performed it.
      if (
        updates.agentId !== undefined &&
        updates.agentId !== application.agentId
      ) {
        // Resolve both the actor (who made the change) and the target agent name.
        const [actorName, targetName] = await Promise.all([
          userService.getDisplayName(userId),
          userService.getDisplayName(updates.agentId),
        ]);
        const target = targetName || "an agent";
        // Distinguish a self-service takeover (mode self -> agent) from a plain
        // reassignment for a more meaningful audit entry.
        const tookOverSelfService =
          updates.mode === "agent" && application.mode === "self";
        await noteService.addActivityNote(
          id,
          tookOverSelfService
            ? `${target} picked up the case (was self-service).`
            : `${actorName || "An agent"} assigned the case to ${target}.`,
          { id: userId, name: actorName }
        );

        // Notify the newly-assigned agent (in-app + push + email).
        await notificationService
          .notifyUser({
            userId: updates.agentId,
            type: "application_assigned",
            title: "New case assigned",
            body: `${actorName || "An agent"} assigned a case to you${application.clientName ? ` for ${application.clientName}` : ""}.`,
            relatedEntityType: "application",
            relatedEntityId: id,
          })
          .catch((e) => console.error("[application] assign notify failed:", e));
      }

      sendSuccess(res, updated, "Application updated successfully");
    } catch (error) {
      console.error("Error updating application:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  /**
   * POST /applications/:id/documents/request
   *
   * An agent requests a (specific type of) document from the client. This is an
   * agent-side action with two effects:
   *   1. records an activity note on the case (so the notes feed shows it), and
   *   2. notifies the client across channels that a document was requested.
   * It does not (yet) create a document record — it's a request/prompt + audit.
   */
  async requestDocument(
    req: AuthenticatedRequest,
    res: Response
  ): Promise<void> {
    try {
      const userId = req.userId!;
      const { id } = req.params;
      const { documentType, notes } = req.body as {
        documentType?: string;
        notes?: string;
      };

      if (!documentType) {
        sendError(res, "VALIDATION_ERROR", "documentType is required", 400);
        return;
      }

      const application = await applicationService.getApplicationById(id);
      if (!application) {
        sendError(res, "NOT_FOUND", "Application not found", 404);
        return;
      }

      // Only the case's agent/owner/admin can request documents — not the client.
      const isApplicant = application.userId === userId;
      const hasAccess = this.checkApplicationAccess(req, application);
      if (!hasAccess || isApplicant) {
        sendError(res, "FORBIDDEN", ErrorMessages.FORBIDDEN, 403);
        return;
      }

      const actorName = await userService.getDisplayName(userId);

      // 1. Persist the ask. This used to be fire-and-forget (note + notification
      // only), which left nothing for a client to look up later — so a client on
      // the web workspace had no way to see what they still owed. The durable
      // record is now the source of truth; the note and notification below remain
      // as the audit trail and the nudge.
      const request = await documentRequestService.create({
        applicationId: id,
        userId: application.userId,
        agencyId: application.agencyId ?? req.authz?.agencyId ?? null,
        documentType: documentType.trim(),
        notes,
        requestedBy: userId,
        requestedByName: actorName || "Your agent",
        visaTypeName: application.visaTypeName,
        countryName: application.countryName,
      });

      // 2. Activity note (audit trail on the case notes feed), attributed to the
      // requesting agent.
      await noteService.addActivityNote(
        id,
        `${actorName || "An agent"} requested a document from the client: ${documentType}.` +
          (notes ? ` Note: ${notes}` : ""),
        { id: userId, name: actorName }
      );

      // 3. Notify the client across channels so they know to upload it. The
      // request id rides in `data` so a client that understands it can deep-link
      // straight to the item; `relatedEntityId` stays the application id so the
      // existing mobile deep-link handlers keep working unchanged.
      await notificationService.notifyUser({
        userId: application.userId,
        type: "document_status",
        title: "Document requested",
        body:
          `Your agent requested a document: ${documentType}.` +
          (notes ? ` ${notes}` : ""),
        channels: ["in_app", "email", "push"],
        relatedEntityType: "application",
        relatedEntityId: id,
        data: { documentRequestId: request.id },
      });

      // Return the full record (not just the echoed type) so the portal can drop
      // it straight into its outstanding-requests list without a refetch.
      sendSuccess(res, request, "Document requested from client");
    } catch (error) {
      console.error("Error requesting document:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  /**
   * DELETE /applications/:id
   * Delete a draft application
   */
  async deleteApplication(
    req: AuthenticatedRequest,
    res: Response
  ): Promise<void> {
    try {
      const userId = req.userId!;
      const { id } = req.params;

      const application = await applicationService.getApplicationById(id);

      if (!application) {
        sendError(res, "NOT_FOUND", "Application not found", 404);
        return;
      }

      // Only the applicant or admin can delete
      if (application.userId !== userId && !req.user?.admin) {
        sendError(res, "FORBIDDEN", ErrorMessages.FORBIDDEN, 403);
        return;
      }

      await applicationService.deleteApplication(id);
      sendNoContent(res);
    } catch (error) {
      console.error("Error deleting application:", error);
      if ((error as Error).message === "Only draft applications can be deleted") {
        sendError(res, "VALIDATION_ERROR", (error as Error).message, 400);
        return;
      }
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  /**
   * PUT /applications/:id/status
   * Update application status.
   * Owner can only withdraw. Agent/admin can set any status.
   */
  async updateStatus(
    req: AuthenticatedRequest,
    res: Response
  ): Promise<void> {
    try {
      const userId = req.userId!;
      const { id } = req.params;
      const { status, currentStep, nextStep, rejectionReason } = req.body;

      if (!status) {
        sendError(res, "VALIDATION_ERROR", "status is required", 400);
        return;
      }

      const application = await applicationService.getApplicationById(id);

      if (!application) {
        sendError(res, "NOT_FOUND", "Application not found", 404);
        return;
      }

      const isApplicant = application.userId === userId;
      const isAdmin = !!req.user?.admin;
      const hasAccess = this.checkApplicationAccess(req, application);

      if (!hasAccess) {
        sendError(res, "FORBIDDEN", ErrorMessages.FORBIDDEN, 403);
        return;
      }

      // Applicants can only withdraw their own applications
      if (isApplicant && !isAdmin && status !== "withdrawn") {
        const isAgentToo = application.agentId === userId;
        if (!isAgentToo) {
          sendError(
            res,
            "FORBIDDEN",
            "You can only withdraw your application",
            403
          );
          return;
        }
      }

      // Resolve the acting agent's name so the activity note attributes the change.
      const actorName = await userService.getDisplayName(userId);
      const updated = await applicationService.updateStatus(id, status, {
        currentStep,
        nextStep,
        rejectionReason,
        actorId: userId,
        actorName,
      });

      sendSuccess(res, updated, "Status updated successfully");
    } catch (error) {
      console.error("Error updating status:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  /**
   * GET /applications/:id/timeline
   * Get application timeline
   */
  async getTimeline(
    req: AuthenticatedRequest,
    res: Response
  ): Promise<void> {
    try {
      const { id } = req.params;

      const application = await applicationService.getApplicationById(id);

      if (!application) {
        sendError(res, "NOT_FOUND", "Application not found", 404);
        return;
      }

      const hasAccess = this.checkApplicationAccess(req, application);
      if (!hasAccess) {
        sendError(res, "FORBIDDEN", ErrorMessages.FORBIDDEN, 403);
        return;
      }

      const timeline = await applicationService.getTimeline(id);
      sendSuccess(res, timeline);
    } catch (error) {
      console.error("Error getting timeline:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  // ============================================
  // HELPER METHODS
  // ============================================

  /**
   * Check if the request's principal can access an application.
   *
   * Now delegates to the shared CASL ability (`req.ability`, built from the role
   * claim in `verifyAuth`) instead of re-deriving access ad-hoc. The "read" grant
   * encodes the same rule that used to be inlined here: admin (manage all),
   * applicant (own `userId`), assigned agent (`agentId`), and same-agency members
   * (owner/agent on matching `agencyId`).
   */
  private checkApplicationAccess(
    req: AuthenticatedRequest,
    application: Application,
    action: "read" | "update" | "delete" = "read"
  ): boolean {
    return can(req, action, asSubject("Application", application as unknown as Record<string, unknown>));
  }

  /**
   * Count non-terminal ("active") applications for a scope, used for the
   * `max_active_applications` plan limit. Terminal statuses don't count against it.
   */
  private async countActiveApplications(
    field: "userId" | "agencyId" | "agentId",
    value: string
  ): Promise<number> {
    const snap = await collections.applications.where(field, "==", value).get();
    const TERMINAL: ApplicationStatus[] = ["approved", "rejected", "withdrawn", "expired"];
    return snap.docs.filter(
      (d) => !TERMINAL.includes((d.data() as Application).status)
    ).length;
  }


  /**
   * Attach `agentName` / `agencyName` / `agencyLogoUrl` to applications.
   *
   * WHY ON READ: a client needs to know who is handling their case, but these
   * names aren't stored on the application. Denormalizing them at write time
   * would mean backfilling every existing application and re-syncing whenever a
   * case is reassigned; resolving here is correct for old and new data alike,
   * and the client never needs read access to the agents/agencies collections.
   *
   * COST: batched, not N+1. Unique agent/agency ids across the whole result set
   * are resolved ONCE each, so a page of 50 cases from one agency costs two
   * reads, not a hundred. Fail-soft — on any lookup error the applications are
   * returned unenriched rather than failing the request.
   *
   * NOTE `Application.agentId` is a USER uid (unlike Conversation.agentId, which
   * is an agent DOC id), so agents are resolved by querying on `userId`.
   */
  private async withHandlerNames(
    applications: Application[]
  ): Promise<Application[]> {
    if (applications.length === 0) return applications;

    try {
      const agentUids = [
        ...new Set(applications.map((a) => a.agentId).filter(Boolean) as string[]),
      ];
      const agencyIds = [
        ...new Set(applications.map((a) => a.agencyId).filter(Boolean) as string[]),
      ];

      const [agentEntries, agencyEntries] = await Promise.all([
        Promise.all(
          agentUids.map(async (uid) => {
            const snap = await collections.agents
              .where("userId", "==", uid)
              .limit(1)
              .get();
            const name = snap.empty
              ? undefined
              : (snap.docs[0].data() as { displayName?: string }).displayName;
            return [uid, name] as const;
          })
        ),
        Promise.all(
          agencyIds.map(async (id) => {
            const snap = await collections.agencies.doc(id).get();
            const data = snap.exists
              ? (snap.data() as { name?: string; logoUrl?: string })
              : undefined;
            return [id, data] as const;
          })
        ),
      ]);

      const agentNames = new Map(agentEntries);
      const agencies = new Map(agencyEntries);

      return applications.map((app) => ({
        ...app,
        agentName: app.agentId ? agentNames.get(app.agentId) : undefined,
        agencyName: app.agencyId ? agencies.get(app.agencyId)?.name : undefined,
        agencyLogoUrl: app.agencyId
          ? agencies.get(app.agencyId)?.logoUrl
          : undefined,
      }));
    } catch (error) {
      // Never fail a case list because a display name couldn't be resolved.
      console.error("[application] handler-name enrichment failed:", error);
      return applications;
    }
  }

  /**
   * Look up an agency's display name for use in outbound client-facing copy.
   *
   * Naming the agency in the "claim your account" email is what stops it reading
   * like phishing to a client who has never heard of Seli. Fail-soft: returns
   * undefined on a missing id or any lookup error, and the email falls back to
   * generic wording rather than not being sent.
   */
  private async resolveAgencyName(
    agencyId?: string | null
  ): Promise<string | undefined> {
    if (!agencyId) return undefined;
    try {
      const snap = await collections.agencies.doc(agencyId).get();
      const name = snap.exists ? (snap.data() as { name?: string }).name : undefined;
      return name?.trim() || undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Get agent document for a userId
   */
  private async getAgentForUser(userId: string): Promise<Agent | null> {
    const snapshot = await collections.agents
      .where("userId", "==", userId)
      .limit(1)
      .get();

    if (snapshot.empty) return null;
    return snapshot.docs[0].data() as Agent;
  }
}

export const applicationController = new ApplicationController();
