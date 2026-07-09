import { AgencyCompliance } from "../../types";
import { verificationService } from "./verification.service";
import { suggestDecision } from "./decision-policy";
import {
  VerificationCheckRequest,
  VerificationCheckResult,
  VerificationCheckType,
  VerificationEvent,
} from "./verification.types";

// ============================================
// VERIFICATION ORCHESTRATOR
// ============================================
//
// Glue between the compliance/KYC domain and the provider-agnostic
// `verificationService`. It builds the right set of `VerificationCheckRequest`s
// from a subject's captured data, runs them, folds the results into a keyed map,
// and derives the automated `verificationStatus` — WITHOUT the compliance service
// needing to know anything about providers.
//
// Phase 0 is a safe no-op: `runAgencyChecks` returns `null` whenever the provider
// is unconfigured (every environment today), so `submitForReview` writes exactly
// what it writes now. The sync request-building is wired ahead of time so Phase 1
// only has to implement the provider's HTTP calls.

/** What `runAgencyChecks` contributes back onto the compliance file. */
export interface AgencyVerificationOutcome {
  verificationChecks: Partial<Record<VerificationCheckType, VerificationCheckResult>>;
  verificationStatus: NonNullable<AgencyCompliance["verificationStatus"]>;
}

/** Map a policy suggestion onto the file-level automated `verificationStatus`. */
function decisionToStatus(
  decision: ReturnType<typeof suggestDecision>
): AgencyVerificationOutcome["verificationStatus"] {
  switch (decision) {
  case "wait":
    return "checks_running"; // an async check is still pending
  case "reject":
    return "failed";
  case "auto_verify":
    return "passed";
  default:
    return "needs_review";
  }
}

/**
 * Build the SYNC checks to run for an agency from its captured compliance data:
 * BVN + NIN government-ID lookups and the CAC business-registry lookup. Document
 * authenticity and liveness are client-SDK-initiated and arrive async by webhook
 * (Phase 2), so they are not built here.
 */
function buildAgencyCheckRequests(
  agencyId: string,
  c: AgencyCompliance
): VerificationCheckRequest[] {
  const reqs: VerificationCheckRequest[] = [];
  const firstName = c.legalFirstName;
  const lastName = c.legalLastName;
  const dateOfBirth = c.dateOfBirth ? c.dateOfBirth.toDate().toISOString() : undefined;

  // Convert a stored consent record into the request-shaped consent (ISO date).
  const bvnConsent = c.consent?.bvn
    ? {
      granted: c.consent.bvn.granted,
      grantedAt: c.consent.bvn.grantedAt.toDate().toISOString(),
      ipAddress: c.consent.bvn.ipAddress,
      text: c.consent.bvn.text,
    }
    : undefined;
  const ninConsent = c.consent?.nin
    ? {
      granted: c.consent.nin.granted,
      grantedAt: c.consent.nin.grantedAt.toDate().toISOString(),
      ipAddress: c.consent.nin.ipAddress,
      text: c.consent.nin.text,
    }
    : undefined;

  if (c.bvn) {
    reqs.push({
      checkType: "gov_id_bvn",
      subjectRef: agencyId,
      bvn: c.bvn,
      firstName,
      lastName,
      dateOfBirth,
      consent: bvnConsent,
    });
  }
  // NIN lookup only when the owner's chosen ID type is NIN.
  if (c.idType === "nin" && c.idNumber) {
    reqs.push({
      checkType: "gov_id_nin",
      subjectRef: agencyId,
      nin: c.idNumber,
      firstName,
      lastName,
      dateOfBirth,
      consent: ninConsent,
    });
  }
  if (c.rcNumber) {
    reqs.push({
      checkType: "business_registry",
      subjectRef: agencyId,
      rcNumber: c.rcNumber,
    });
  }
  return reqs;
}

/**
 * Run the automated checks for an agency at submit time.
 * Returns `null` when nothing ran (provider unconfigured, or no applicable data),
 * so the caller leaves the compliance file untouched — the safe-rollout property.
 */
export async function runAgencyChecks(
  agencyId: string,
  compliance: AgencyCompliance
): Promise<AgencyVerificationOutcome | null> {
  if (!verificationService.isConfigured) return null;

  const requests = buildAgencyCheckRequests(agencyId, compliance);
  if (requests.length === 0) return null;

  const results = await verificationService.runChecks(requests);
  if (results.length === 0) return null;

  const verificationChecks: Partial<
    Record<VerificationCheckType, VerificationCheckResult>
  > = {};
  for (const r of results) verificationChecks[r.checkType] = r;

  const decision = suggestDecision(verificationChecks, {
    autoApprove: verificationService.autoApproveEnabled,
  });

  return { verificationChecks, verificationStatus: decisionToStatus(decision) };
}

/**
 * Apply an async provider result (webhook) onto the correct subject record.
 * Phase 2: locate the subject via the `providerRef -> subjectRef` index, merge the
 * results into `verificationChecks`, re-run `suggestDecision`, and (if auto-approve)
 * reuse the existing `review()` path. Phase 0 has no in-flight async checks, so this
 * is a logged no-op.
 */
export async function applyEvent(event: VerificationEvent): Promise<void> {
  console.log(
    `[verification] received async event (provider=${event.provider}, ref=${event.providerRef}); ` +
      "async apply lands in Phase 2 — no-op for now."
  );
}

// Grouped export so callers read `verificationOrchestrator.runAgencyChecks(...)`.
export const verificationOrchestrator = { runAgencyChecks, applyEvent };
