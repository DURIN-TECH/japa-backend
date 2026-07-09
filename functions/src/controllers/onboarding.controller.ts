import { Response } from "express";
import { AuthenticatedRequest } from "../middleware/auth";
import { collections, db, serverTimestamp, increment } from "../utils/firebase";
import { Agent, Agency, AgencyInvitation } from "../types";
import { Timestamp } from "firebase-admin/firestore";
import { sendSuccess, sendError, ErrorMessages } from "../utils/response";
import { claimsService } from "../services/claims.service";
import { entitlementService } from "../services/entitlement.service";
import { notificationService } from "../services/notification.service";

class OnboardingController {
  /**
   * POST /onboarding/agency-owner
   * Combined endpoint: updates user profile + creates agent profile + creates agency
   * All writes are performed in a Firestore batch for atomicity.
   */
  async completeAgencyOwnerOnboarding(
    req: AuthenticatedRequest,
    res: Response
  ): Promise<void> {
    try {
      const userId = req.userId!;
      const {
        firstName,
        lastName,
        phone,
        residentialCountry,
        agencyName,
        agencyDescription,
        agencyState,
      } = req.body;

      // Validate required fields
      if (!firstName || !lastName) {
        sendError(res, "VALIDATION_ERROR", "First name and last name are required", 400);
        return;
      }
      if (!residentialCountry) {
        sendError(res, "VALIDATION_ERROR", "Country of residence is required", 400);
        return;
      }
      if (!agencyName) {
        sendError(res, "VALIDATION_ERROR", "Agency name is required", 400);
        return;
      }

      // Check user exists
      const userRef = collections.users.doc(userId);
      const userDoc = await userRef.get();
      if (!userDoc.exists) {
        sendError(res, "NOT_FOUND", "User profile not found", 404);
        return;
      }

      // Check if already has an agent profile
      const existingAgent = await collections.agents
        .where("userId", "==", userId)
        .limit(1)
        .get();
      if (!existingAgent.empty) {
        sendError(res, "VALIDATION_ERROR", "Agent profile already exists. Onboarding already completed.", 400);
        return;
      }

      const now = Timestamp.now();
      const displayName = `${firstName} ${lastName}`.trim();

      // Prepare agent doc
      const agentRef = collections.agents.doc();
      const agencyRef = collections.agencies.doc();

      const agent: Agent = {
        id: agentRef.id,
        userId,
        agencyId: agencyRef.id,
        agencyRole: "owner",
        displayName,
        bio: "",
        yearsOfExperience: 0,
        specializations: [],
        languages: ["English"],
        featuredVisas: [],
        verificationStatus: "pending",
        rating: 0,
        totalReviews: 0,
        totalApplications: 0,
        successRate: 0,
        responseTime: "N/A",
        consultationFee: 0,
        serviceFees: {},
        isAvailable: false,
        createdAt: now,
        updatedAt: now,
      };

      const agency: Agency = {
        id: agencyRef.id,
        name: agencyName,
        ownerId: userId,
        ownerName: displayName,
        description: agencyDescription,
        state: agencyState,
        services: [],
        totalAgents: 1,
        totalCases: 0,
        activeCases: 0,
        status: "pending_review",
        createdAt: now,
        updatedAt: now,
      };

      // Batch write: user update + agent create + agency create
      const batch = db.batch();

      batch.update(userRef, {
        firstName,
        lastName,
        phone: phone || null,
        residentialCountry,
        onboardingCompleted: true,
        onboardingCompletedAt: now,
        updatedAt: serverTimestamp(),
      });

      batch.set(agentRef, agent);
      batch.set(agencyRef, agency);

      await batch.commit();

      // Promote the user to agency owner in their custom claims so the role rides
      // in the token. Best-effort: a claims failure must not fail onboarding.
      await claimsService
        .setRoleClaims(userId, "owner", agencyRef.id)
        .catch((e) => console.error("Failed to set owner claims:", e));

      // Return the created data
      const updatedUser = await userRef.get();

      sendSuccess(res, {
        user: updatedUser.data(),
        agentProfile: agent,
        agency,
      }, "Onboarding completed successfully");
    } catch (error) {
      console.error("Error completing onboarding:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  /**
   * POST /onboarding/join-agency  { invitationId, firstName, lastName, phone?, residentialCountry? }
   *
   * The invited-agent counterpart to agency-owner onboarding: instead of creating
   * a new agency, it creates the agent profile as a MEMBER of the agency they were
   * invited to and accepts the invitation — so an invited user is automatically
   * added to the agency the moment they finish creating their account (no
   * create-your-own-agency step).
   *
   * Security: the authenticated user's email must match the invitation's
   * `invitedEmail`, so an invite link can only be redeemed by its intended
   * recipient. Idempotent-ish: re-linking an agent already in an agency is
   * rejected.
   */
  async completeAgentInvitationOnboarding(
    req: AuthenticatedRequest,
    res: Response
  ): Promise<void> {
    try {
      const userId = req.userId!;
      const userEmail = (req.user?.email || "").toLowerCase();
      const { invitationId, firstName, lastName, phone, residentialCountry } =
        req.body;

      if (!invitationId) {
        sendError(res, "VALIDATION_ERROR", "invitationId is required", 400);
        return;
      }
      if (!firstName || !lastName) {
        sendError(res, "VALIDATION_ERROR", "First name and last name are required", 400);
        return;
      }

      // Load + validate the invitation.
      const inviteRef = collections.agencyInvitations.doc(invitationId);
      const inviteDoc = await inviteRef.get();
      if (!inviteDoc.exists) {
        sendError(res, "NOT_FOUND", "Invitation not found", 404);
        return;
      }
      const invite = inviteDoc.data() as AgencyInvitation;
      if (invite.status !== "pending") {
        sendError(res, "VALIDATION_ERROR", "This invitation is no longer pending", 400);
        return;
      }
      if (invite.expiresAt.toMillis() < Date.now()) {
        await inviteRef.update({ status: "expired" });
        sendError(res, "VALIDATION_ERROR", "This invitation has expired", 400);
        return;
      }
      // The invite may only be redeemed by the address it was sent to.
      if (userEmail && invite.invitedEmail.toLowerCase() !== userEmail) {
        sendError(
          res,
          "FORBIDDEN",
          "This invitation was sent to a different email address.",
          403
        );
        return;
      }

      // Reject if the user is already an agent in some agency.
      const existingAgentSnap = await collections.agents
        .where("userId", "==", userId)
        .limit(1)
        .get();
      if (!existingAgentSnap.empty && existingAgentSnap.docs[0].data().agencyId) {
        sendError(
          res,
          "VALIDATION_ERROR",
          "You're already part of an agency. Leave it before joining another.",
          400
        );
        return;
      }

      // Seat check at the moment a seat is consumed (excludes the owner).
      const agencyRef = collections.agencies.doc(invite.agencyId);
      const agencyDoc = await agencyRef.get();
      if (!agencyDoc.exists) {
        sendError(res, "NOT_FOUND", "Agency not found", 404);
        return;
      }
      const totalMembers = (agencyDoc.data()?.totalAgents as number) ?? 1;
      const seat = await entitlementService.canAddAgent(
        invite.agencyId,
        totalMembers - 1
      );
      if (!seat.allowed) {
        sendError(
          res,
          "UPGRADE_REQUIRED",
          "This agency has no available agent seats. The owner needs to add a seat.",
          402
        );
        return;
      }

      // Upsert the user doc rather than requiring it: the Auth onCreate trigger
      // that provisions it runs asynchronously and can race a fresh signup that
      // immediately joins, so we merge to create-or-update safely.
      const userRef = collections.users.doc(userId);

      const now = Timestamp.now();
      const displayName = `${firstName} ${lastName}`.trim();

      // Reuse a bare existing agent profile if present; otherwise create one.
      const agentRef = existingAgentSnap.empty
        ? collections.agents.doc()
        : existingAgentSnap.docs[0].ref;

      const batch = db.batch();

      if (existingAgentSnap.empty) {
        // Invited agents join an already-approved agency at the owner's request,
        // so they're marked verified + available and can work immediately.
        const agent: Agent = {
          id: agentRef.id,
          userId,
          agencyId: invite.agencyId,
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
          serviceFees: {},
          isAvailable: true,
          createdAt: now,
          updatedAt: now,
        };
        batch.set(agentRef, agent);
      } else {
        batch.update(agentRef, {
          agencyId: invite.agencyId,
          agencyRole: "agent",
          displayName,
          updatedAt: now,
        });
      }

      batch.set(
        userRef,
        {
          id: userId,
          email: userEmail || invite.invitedEmail,
          firstName,
          lastName,
          phone: phone || null,
          residentialCountry: residentialCountry || null,
          hasPassport: false,
          onboardingCompleted: true,
          onboardingCompletedAt: now,
          updatedAt: serverTimestamp(),
        },
        { merge: true }
      );

      batch.update(inviteRef, { status: "accepted", acceptedAt: now });
      batch.update(agencyRef, {
        totalAgents: increment(1),
        updatedAt: serverTimestamp(),
      });

      await batch.commit();

      // Ride the agent role + agencyId in the token (best-effort).
      await claimsService
        .setRoleClaims(userId, "agent", invite.agencyId)
        .catch((e) => console.error("Failed to set agent claims:", e));

      // Notify the inviting owner that the invite was accepted (best-effort).
      if (invite.invitedBy) {
        await notificationService
          .notifyUser({
            userId: invite.invitedBy,
            type: "invitation_accepted",
            title: "Invitation accepted",
            body: `${invite.invitedEmail} joined ${invite.agencyName}.`,
            relatedEntityType: "agency",
            relatedEntityId: invite.agencyId,
          })
          .catch((e) => console.error("[join-agency] notify failed:", e));
      }

      const updatedUser = await userRef.get();
      const agentData = (await agentRef.get()).data();
      sendSuccess(
        res,
        {
          user: updatedUser.data(),
          agentProfile: agentData,
          agencyId: invite.agencyId,
        },
        "Joined agency successfully"
      );
    } catch (error) {
      console.error("Error joining agency via invitation:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }
}

export const onboardingController = new OnboardingController();
