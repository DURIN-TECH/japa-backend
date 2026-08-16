import { IdentityVerificationStatus } from "../../types";
import { verificationService } from "./verification.service";
import { suggestDecision } from "./decision-policy";
import {
  VerificationCheckRequest,
  VerificationCheckResult,
  VerificationCheckType,
} from "./verification.types";

// ============================================
// CLIENT (APPLICANT) VERIFICATION ORCHESTRATOR
// ============================================
//
// The applicant-side sibling of `verification.orchestrator.ts`. Where the agency
// orchestrator builds owner/business (KYC/KYB) checks from an `AgencyCompliance`
// file, this one builds a single applicant IDENTITY check (NIN or BVN government-ID
// lookup) from a client's submission, runs it through the SAME provider-agnostic
// `verificationService`, and maps the resulting decision onto the file-level
// `IdentityVerificationStatus` stored on `User.identityVerification`.
//
// It shares the load-bearing safe-rollout property: when the provider is
// unconfigured (no Dojah keys — the state until we go live), `runClientChecks`
// returns `null`, so the caller records the submission as `under_review` without
// any provider call ever happening.

/** Consent captured from the applicant before a government-ID lookup runs. */
export interface ClientConsent {
  granted: boolean;
  grantedAt: string; // ISO date string
  text: string; // exact consent copy shown to the user
  ipAddress?: string;
}

/** The applicant's identity submission (from POST /users/me/verification/identity). */
export interface ClientIdentityInput {
  idType: "nin" | "bvn";
  idNumber: string;
  firstName?: string;
  lastName?: string;
  dateOfBirth?: string; // ISO date string, for name/DOB match scoring
  consent: ClientConsent;
}

/** What a completed client verification run contributes back onto the user record. */
export interface ClientVerificationOutcome {
  checks: Partial<Record<VerificationCheckType, VerificationCheckResult>>;
  status: IdentityVerificationStatus;
}

/**
 * Map the pure policy suggestion onto the applicant file-level status.
 * (Agency uses a parallel `decisionToStatus`; the client vocabulary differs.)
 */
function decisionToStatus(
  decision: ReturnType<typeof suggestDecision>
): IdentityVerificationStatus {
  switch (decision) {
  case "wait":
    return "pending"; // an async check (selfie/liveness) is still outstanding
  case "reject":
    return "failed";
  case "auto_verify":
    return "verified";
  default:
    return "under_review"; // mixed / low-confidence → awaiting a confident pass or a human
  }
}

/**
 * Build the government-ID check for an applicant submission. Exactly one of BVN /
 * NIN is produced, matching the submitted `idType`. (Applicants prove only their
 * own identity — there is no business-registry leg here.)
 */
function buildClientCheckRequests(
  userId: string,
  input: ClientIdentityInput
): VerificationCheckRequest[] {
  const base = {
    subjectRef: userId,
    firstName: input.firstName,
    lastName: input.lastName,
    dateOfBirth: input.dateOfBirth,
    consent: input.consent,
  };

  if (input.idType === "bvn") {
    return [{ ...base, checkType: "gov_id_bvn", bvn: input.idNumber }];
  }
  return [{ ...base, checkType: "gov_id_nin", nin: input.idNumber }];
}

/**
 * Run the applicant's identity check now.
 * Returns `null` when nothing ran (provider unconfigured), so the caller records
 * the submission as `under_review` — the safe-rollout path.
 */
export async function runClientChecks(
  userId: string,
  input: ClientIdentityInput
): Promise<ClientVerificationOutcome | null> {
  if (!verificationService.isConfigured) return null;

  const requests = buildClientCheckRequests(userId, input);
  const results = await verificationService.runChecks(requests);
  if (results.length === 0) return null;

  const checks: Partial<Record<VerificationCheckType, VerificationCheckResult>> = {};
  for (const r of results) checks[r.checkType] = r;

  const decision = suggestDecision(checks, {
    autoApprove: verificationService.autoApproveEnabled,
  });

  return { checks, status: decisionToStatus(decision) };
}

// Grouped export so callers read `clientVerificationOrchestrator.runClientChecks(...)`.
export const clientVerificationOrchestrator = { runClientChecks };
