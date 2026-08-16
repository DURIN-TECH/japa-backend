import { collections, serverTimestamp } from "../utils/firebase";
import { Timestamp } from "firebase-admin/firestore";
import { User, UserIdentityVerification, IdentityVerificationStatus } from "../types";
import { ConsentRecord } from "./verification/verification.types";
import {
  clientVerificationOrchestrator,
  ClientIdentityInput,
} from "./verification/client-verification.orchestrator";

// ============================================
// CLIENT VERIFICATION SERVICE (applicant KYC)
// ============================================
//
// Thin domain service for the applicant identity-verification flow: read the
// current status, and accept a NIN/BVN submission. It captures the user's consent,
// runs the shared verification engine (via the client orchestrator), and persists
// the normalized result onto `User.identityVerification`.
//
// Safe-rollout: when the provider is unconfigured (no Dojah keys), the orchestrator
// returns `null` and we record the submission as `under_review` — the applicant has
// done their part; a confident automated pass (or admin) flips it to `verified`.

/**
 * The exact consent copy shown to and agreed by the applicant. Persisted verbatim
 * on the consent audit record (NDPA / NIBSS iGree requirement) before any lookup.
 */
export const IDENTITY_CONSENT_TEXT =
  "I consent to Seli verifying my identity by looking up my BVN/NIN with the " +
  "relevant Nigerian authority (NIBSS / NIMC) for identity-verification (KYC) purposes.";

/** Validated input for an identity submission (from the controller). */
export interface SubmitIdentityInput {
  idType: "nin" | "bvn";
  idNumber: string; // already normalized to digits by the controller
  ipAddress?: string; // captured on the consent audit record
}

class ClientVerificationService {
  /** Current identity-verification file for a user (or a fresh `unverified` default). */
  async getStatus(userId: string): Promise<UserIdentityVerification> {
    const snap = await collections.users.doc(userId).get();
    const user = snap.data() as User | undefined;
    return user?.identityVerification ?? { status: "unverified" };
  }

  /**
   * Accept an identity submission: capture consent, run the automated check, and
   * persist the outcome. Returns the stored file so the caller can react to the
   * terminal status (e.g. send a notification).
   */
  async submitIdentity(
    userId: string,
    input: SubmitIdentityInput
  ): Promise<UserIdentityVerification> {
    const snap = await collections.users.doc(userId).get();
    if (!snap.exists) throw new Error("User not found");
    const user = snap.data() as User;

    const now = Timestamp.now();

    // Consent audit record stored on the file (Timestamp form).
    const consentRecord: ConsentRecord = {
      granted: true,
      grantedAt: now,
      text: IDENTITY_CONSENT_TEXT,
      ipAddress: input.ipAddress, // undefined is ignored on write (ignoreUndefinedProperties)
    };

    // The engine wants the applicant's known name/DOB (for match scoring) + the
    // request-shaped consent (ISO date). Name/DOB come from their profile.
    const orchestratorInput: ClientIdentityInput = {
      idType: input.idType,
      idNumber: input.idNumber,
      firstName: user.firstName,
      lastName: user.lastName,
      dateOfBirth: user.dateOfBirth ? user.dateOfBirth.toDate().toISOString() : undefined,
      consent: {
        granted: true,
        grantedAt: now.toDate().toISOString(),
        text: IDENTITY_CONSENT_TEXT,
        ipAddress: input.ipAddress,
      },
    };

    const outcome = await clientVerificationOrchestrator.runClientChecks(
      userId,
      orchestratorInput
    );

    // No provider run (unconfigured) → the applicant's submission is under_review.
    const status: IdentityVerificationStatus = outcome?.status ?? "under_review";

    // Surface the first meaningful reason from the checks (for failed / needs-review).
    const reason = outcome
      ? Object.values(outcome.checks).find((c) => c?.reason)?.reason
      : undefined;

    // Build the file. Undefined fields are dropped on write, so optional bits
    // (checks / verifiedAt / reason) only persist when present.
    const file: UserIdentityVerification = {
      status,
      idType: input.idType,
      consent: { [input.idType]: consentRecord },
      submittedAt: now,
      checks: outcome?.checks,
      verifiedAt: status === "verified" ? now : undefined,
      reason: status === "failed" || status === "under_review" ? reason : undefined,
    };

    await collections.users.doc(userId).update({
      identityVerification: file,
      updatedAt: serverTimestamp(),
    });

    return file;
  }
}

export const clientVerificationService = new ClientVerificationService();
