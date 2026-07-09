import { Timestamp } from "firebase-admin/firestore";

// ============================================
// VERIFICATION PROVIDER CONTRACT (provider-agnostic)
// ============================================
//
// Mirrors the email/billing provider pattern: the rest of the app talks to this
// interface, and a concrete provider (Dojah today; Smile ID swappable) implements
// it. Swap providers by writing a sibling class + flipping `VERIFICATION_PROVIDER`
// — nothing else changes. Lives backend-only because verification involves a
// secret API key + outbound HTTP + PII, which must never reach a client.
//
// The layer sits UNDER the existing manual compliance flow: it produces decision
// *signals* for admins (assisted review), it does not by default replace the admin
// decision. When unconfigured it is a no-op, so the current manual flow is intact.

/**
 * The normalized set of checks the platform can request, independent of provider.
 * A single subject (agency or client) may run several of these.
 */
export type VerificationCheckType =
  | "gov_id_bvn" // BVN lookup against NIBSS (name/DOB/phone match)
  | "gov_id_nin" // NIN / vNIN lookup against NIMC
  | "business_registry" // CAC lookup by RC/BN -> company + directors (KYB)
  | "document_analysis" // ID document OCR + authenticity/tamper
  | "liveness_facematch" // selfie liveness + face-match vs ID / gov photo
  | "aml_pep"; // AML / PEP / sanctions screening

/**
 * Outcome status of a single check. Deliberately DISTINCT from the file-level
 * `ComplianceStatus` / `KycProfileStatus`: a record has many check results but one
 * overall status.
 *   - `pending`      — async check submitted, awaiting a provider webhook.
 *   - `passed`       — check succeeded above the confidence threshold.
 *   - `failed`       — check failed (mismatch / not found / tampered).
 *   - `needs_review` — ambiguous / low-confidence -> a human should decide.
 */
export type VerificationCheckStatus =
  | "pending"
  | "passed"
  | "failed"
  | "needs_review";

/**
 * One normalized check outcome, stored on the subject's compliance / KYC record
 * (keyed by `checkType`). `providerRef` is the provider's own reference id and is
 * how an async webhook result is correlated back to the check that started it.
 */
export interface VerificationCheckResult {
  checkType: VerificationCheckType;
  provider: string; // "dojah" | "smileid"
  providerRef?: string; // provider reference_id / job_id (audit + webhook correlation)
  status: VerificationCheckStatus;
  confidence?: number; // 0..1 where the provider returns one
  /**
   * Extracted / matched data worth keeping for the admin signal — e.g. OCR fields,
   * name/DOB match booleans, the CAC director list. Data-minimized on purpose:
   * do NOT stuff raw BVN/NIN here (see the consent/data-protection notes).
   */
  extractedData?: Record<string, unknown>;
  reason?: string; // human-readable failure / needs_review explanation
  checkedAt: Timestamp;
}

/**
 * A short record that a user granted consent to a government-data lookup
 * (NIBSS iGree for BVN, NIMC/NDPA for NIN). Persisted as an audit log on the
 * subject's record before any gov-id check runs.
 */
export interface ConsentRecord {
  granted: boolean;
  grantedAt: Timestamp;
  text: string; // the exact consent copy shown to the user
  ipAddress?: string;
}

/**
 * Inputs for a single check invocation. Only the fields relevant to `checkType`
 * are populated. Document/liveness checks pass a short-lived signed READ URL so
 * the provider can fetch the file server-to-server (see storage.service).
 */
export interface VerificationCheckRequest {
  checkType: VerificationCheckType;
  subjectRef: string; // agencyId or userId — provider metadata + webhook correlation

  // gov-id lookups
  bvn?: string;
  nin?: string;

  // match scoring (compared against the authority's record)
  firstName?: string;
  lastName?: string;
  dateOfBirth?: string; // ISO date string

  // business registry (KYB)
  rcNumber?: string;

  // document / liveness — signed GET URLs to the uploaded assets
  documentUrl?: string;
  selfieUrl?: string;

  // consent — REQUIRED for gov-id lookups (enforced by the service)
  consent?: { granted: boolean; grantedAt: string; ipAddress?: string; text: string };
}

/**
 * A normalized async event parsed from a provider webhook. Mirrors the billing
 * layer's normalized-event shape. `providerRef` correlates back to the `pending`
 * `VerificationCheckResult` that started the async check.
 */
export interface VerificationEvent {
  provider: string;
  providerRef: string;
  subjectRef?: string; // present if the provider echoes our metadata
  results: VerificationCheckResult[];
  raw: unknown; // the raw payload, for debugging/audit
}

/**
 * Pluggable verification provider — mirrors `EmailProvider` / `BillingProvider`.
 * A concrete provider implements the sync `runCheck` and the async `parseWebhook`.
 */
export interface VerificationProvider {
  readonly name: string;
  /** True when the provider has everything it needs (API keys). Guards safe-rollout. */
  readonly isConfigured: boolean;
  /** Run a single check now. Sync checks resolve with a terminal status; async
   *  checks resolve `pending` and complete later via `parseWebhook`. */
  runCheck(req: VerificationCheckRequest): Promise<VerificationCheckResult>;
  /**
   * Verify the webhook signature (HMAC) and normalize the payload into a
   * `VerificationEvent`. Returns `null` for an unverified or irrelevant payload —
   * the caller must never trust an unsigned body.
   */
  parseWebhook(
    headers: Record<string, string | undefined>,
    rawBody: string
  ): VerificationEvent | null;
}
