import { Response } from "express";
import { AuthenticatedRequest } from "../middleware/auth";
import { applicationService } from "../services/application.service";
import { userService } from "../services/user.service";
import { messagingService } from "../services/messaging.service";
import { notificationService } from "../services/notification.service";
import { noteService } from "../services/note.service";
import { collections, auth } from "../utils/firebase";
import { can, asSubject, checkWithinLimit, paymentRequired } from "../middleware/authz";
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
      } = req.body as {
        clientName?: string;
        clientEmail?: string;
        clientPhone?: string;
        countryCode?: string;
        visaTypeId?: string;
        agentNotes?: string;
        channels?: NotificationChannel[];
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

      // --- Authorize: caller must be an agent --------------------------------
      // We need both the agent's USER uid (used as Application.agentId, consistent
      // with the rest of the application code) and the agent DOC id (used as the
      // Conversation.agentId — these two identifiers are intentionally different).
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
      const agentDocId = agentSnapshot.docs[0].id;

      // Enforce the active-application limit for the agency (or independent agent)
      // before provisioning anything. No-op until a plan with the limit is assigned.
      const scopeField = req.authz?.agencyId ? "agencyId" : "agentId";
      const scopeValue = req.authz?.agencyId || callerUid;
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

      // --- Create the application (agent-managed, portal-originated) ----------
      const application = await applicationService.createApplication(clientUid, {
        visaTypeId,
        countryCode,
        mode: "agent",
        agentId: callerUid, // Application.agentId = agent USER uid (codebase convention)
        agentNotes,
        createdVia: "portal",
        clientNameOverride: clientName.trim(),
        clientEmailOverride: normalizedEmail,
        clientPhoneOverride: clientPhone,
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

      sendSuccess(res, applications);
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

      sendSuccess(res, application);
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

      // 1. Activity note (audit trail on the case notes feed), attributed to the
      // requesting agent.
      const actorName = await userService.getDisplayName(userId);
      await noteService.addActivityNote(
        id,
        `${actorName || "An agent"} requested a document from the client: ${documentType}.` +
          (notes ? ` Note: ${notes}` : ""),
        { id: userId, name: actorName }
      );

      // 2. Notify the client across channels so they know to upload it.
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
      });

      sendSuccess(res, { documentType }, "Document requested from client");
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
