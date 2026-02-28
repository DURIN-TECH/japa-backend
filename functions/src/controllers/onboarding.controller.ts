import { Response } from "express";
import { AuthenticatedRequest } from "../middleware/auth";
import { collections, db, serverTimestamp } from "../utils/firebase";
import { Agent, Agency } from "../types";
import { Timestamp } from "firebase-admin/firestore";
import { sendSuccess, sendError, ErrorMessages } from "../utils/response";

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
}

export const onboardingController = new OnboardingController();
