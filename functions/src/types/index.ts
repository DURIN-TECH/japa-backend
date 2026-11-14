import { Timestamp } from "firebase-admin/firestore";
import type { ApplicationIntake } from "./intake";
import type { SharedRouteRef } from "./shared-route";
// Issue #234: what the applicant holds (profile) and its copy on an application.
import type { ApplicantFacts, HeldDocument } from "./applicant-facts";
export * from "./applicant-facts";
// Issue #179: stored prices are dollar Money; reads add a local quote.
import type { ChargeSnapshot, CurrencyCode, LocalPriceQuote, Money, PriceMigrationRecord, QuoteLock } from "./money";
// Automated-verification result shapes live with the provider contract; the
// compliance file below embeds them as optional signals (see the verification
// service). One-way import (types -> verification.types), so no cycle.
import type {
  VerificationCheckResult,
  VerificationCheckType,
  ConsentRecord,
} from "../services/verification/verification.types";

// Re-export eligibility types
export * from "./eligibility";

// Re-export news types
export * from "./news";

// Re-export visa-catalog scraper types
export * from "../scrapers/types";
// Local import so VisaType (below) can reference the scrape provenance shape.
// Type-only, so the visa-catalog <-> index cycle is erased at compile time.
import type { VisaScrapeMeta } from "../scrapers/types";

// ============================================
// USER TYPES
// ============================================

/**
 * Per-user notification channel preferences (opt-OUT model). When a field is
 * `false` the user has switched that channel off; absent/`true` means on. Only the
 * user-configurable channels live here — `in_app` is always delivered (it's the
 * record of truth) and is intentionally not represented. Security-critical emails
 * bypass these preferences (see `NotifyUserInput.critical`).
 */
export interface NotificationPreferences {
  email: boolean; // receive email notifications
  push: boolean; // receive push notifications
}

export interface User {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  middleName?: string;
  phone?: string;
  dateOfBirth?: Timestamp;
  address?: Address;
  residentialCountry?: string;
  profilePhotoUrl?: string;

  // ---- What the applicant holds (issue #234; see types/applicant-facts.ts) ----
  // Written ONLY through PUT /users/me/holdings and its document sub-routes
  // (validated server-side); never through PUT /users/me or a client SDK
  // write (not in USER_SELF_EDITABLE_FIELDS / firestore.rules on purpose).
  // Nationalities: two-letter codes, one or more. Absent or empty = not stated.
  nationalities?: string[];
  // Held visas / permits / travel authorisations. ABSENT = never stated;
  // an empty list = the applicant said they hold none.
  heldDocuments?: HeldDocument[];
  // When the holdings were last saved.
  holdingsUpdatedAt?: Timestamp;

  // Onboarding status
  onboardingCompleted: boolean;
  onboardingCompletedAt?: Timestamp;
  
  // Passport info
  hasPassport: boolean;
  passportNumber?: string;
  passportExpiryDate?: Timestamp;
  passportCountry?: string;
  
  // Provisioning status
  // True when this account was created by an agent on a client's behalf (from the
  // portal) and the client has not yet completed sign-up themselves. Such accounts
  // can be looked up by email and have applications/conversations attached to them,
  // but the client may not have set a password or downloaded the app yet.
  isProvisional?: boolean;

  // Client-facing identity verification (KYC). Absent on legacy/unverified users.
  // This is the APPLICANT's own identity check (NIN/BVN + optional selfie), run via
  // the shared verification service — distinct from `AgencyCompliance` (owner/business
  // KYC/KYB). See `UserIdentityVerification` below.
  identityVerification?: UserIdentityVerification;

  // Metadata
  createdAt: Timestamp;
  updatedAt: Timestamp;
  lastLoginAt?: Timestamp;
  fcmTokens?: string[]; // For push notifications

  // Per-user notification channel preferences (email/push on-off). Absent = all
  // channels on (opt-out model). See NotificationPreferences.
  notificationPreferences?: NotificationPreferences;
}

// ---- Client identity verification (applicant KYC) ----

// File-level status of an applicant's identity verification. Distinct from the
// per-check `VerificationCheckStatus` (a subject has many checks but one status):
//   unverified   – nothing submitted yet (or field absent)
//   pending      – an async check (selfie/liveness) is in flight, awaiting a webhook
//   under_review – submitted; provider unconfigured or signals are mixed → awaiting
//                  a confident automated pass (or a human decision)
//   verified     – identity confirmed (auto-verified on a high-confidence pass,
//                  or admin-approved)
//   failed       – a check hard-failed (mismatch / not found)
export type IdentityVerificationStatus =
  | "unverified"
  | "pending"
  | "under_review"
  | "verified"
  | "failed";

// The applicant identity-verification file embedded on `User`. Mirrors the shape
// of the automated-verification signals on `AgencyCompliance`, minus the business
// (KYB) leg — an applicant only proves their own identity.
export interface UserIdentityVerification {
  status: IdentityVerificationStatus;
  // Which government ID the applicant submitted for the lookup.
  idType?: "nin" | "bvn";
  // Per-check normalized results, keyed by check type (BVN/NIN/doc/liveness/AML).
  checks?: Partial<Record<VerificationCheckType, VerificationCheckResult>>;
  // Audit log of the applicant's consent to the government-ID lookup(s).
  consent?: { bvn?: ConsentRecord; nin?: ConsentRecord };
  // Review / lifecycle metadata.
  submittedAt?: Timestamp;
  verifiedAt?: Timestamp;
  reviewedBy?: string; // Admin userId, when a human makes the call
  reason?: string; // Failure / needs-review explanation surfaced to the user
}

export interface Address {
  street: string;
  city: string;
  state: string;
  postalCode: string;
  country: string;
}

// ============================================
// AGENCY TYPES
// ============================================

export type AgencyMemberRole = "owner" | "agent";

export type AgencyInvitationStatus = "pending" | "accepted" | "declined" | "expired";

export type AgencyStatus = "pending_review" | "approved" | "rejected" | "suspended";

export interface AgencyService {
  id: string;
  name: string;
  /**
   * The service price in US DOLLARS (issue #179): `{ amountMinor: <cents>,
   * currency: "USD" }`. Replaces the old naira `price` number (whose comment
   * once said "in cents" and was wrong; it held whole naira). Set only
   * through PUT /agencies/me, validated by `parseUsdPriceInput`.
   */
  priceUsd: Money;
}

/**
 * `migratedFrom` on an agency (issue #179): the naira values the migration
 * converted, keyed by the OLD field name (`services` by service id).
 */
export interface AgencyPriceMigration {
  consultationFee?: PriceMigrationRecord;
  services?: Record<string, PriceMigrationRecord>;
}

// ============================================
// COMPLIANCE (KYC / KYB / PAYOUT) TYPES
// ============================================

// Lifecycle of an agency's compliance file. This is DISTINCT from `AgencyStatus`
// (which gates admission to the platform). An agency can be `approved` on the
// platform yet still be `not_started` on compliance — and it is compliance
// verification, not platform admission, that unlocks payments and the ability to
// be assigned platform-originated ("our") clients.
//   not_started  – nothing captured yet
//   in_progress  – some fields/docs saved, not yet submitted
//   under_review – all required items submitted, awaiting an admin decision
//   verified     – admin approved; payments + platform clients unlocked
//   rejected     – admin rejected; agency must fix items and resubmit
export type ComplianceStatus =
  | "not_started"
  | "in_progress"
  | "under_review"
  | "verified"
  | "rejected";

// Government ID types accepted for owner KYC (Nigeria-focused).
export type KycIdType =
  | "nin"
  | "passport"
  | "drivers_license"
  | "voters_card";

// Settlement bank account used for Paystack payouts (KYB payout leg).
export interface SettlementBank {
  bankName: string;
  bankCode?: string; // Paystack bank code, when resolved
  accountNumber: string;
  accountName: string;
}

// The full compliance file attached to an Agency. Fields are optional because
// they are captured incrementally; `getComplianceRequirements()` on the service
// derives which required items are still outstanding before an agency may submit.
export interface AgencyCompliance {
  status: ComplianceStatus;

  // ---- KYC: identity of the agency owner (the natural person) ----
  legalFirstName?: string;
  legalLastName?: string;
  dateOfBirth?: Timestamp;
  idType?: KycIdType;
  idNumber?: string; // NIN / passport no. / etc.
  bvn?: string; // Bank Verification Number (Nigeria)
  idDocumentPath?: string; // Storage path to the government ID scan
  proofOfAddressPath?: string; // Storage path to a proof-of-address doc/selfie

  // ---- KYB: the business (the agency legal entity) ----
  rcNumber?: string; // CAC RC/BN registration number
  tin?: string; // Tax Identification Number
  businessAddress?: string;
  cacDocumentPath?: string; // Storage path to the CAC registration certificate

  // ---- Payout: where settlements are paid ----
  settlementBank?: SettlementBank;

  // ---- Review metadata ----
  submittedAt?: Timestamp;
  reviewedAt?: Timestamp;
  reviewedBy?: string; // Admin userId who verified/rejected
  rejectionReason?: string;

  // ---- Automated verification (additive; absent on legacy docs) ----
  // These feed the ASSISTED-REVIEW flow: on submit the platform runs provider
  // checks and stores their normalized results here as decision signals. They do
  // NOT change the file-level `status` semantics — an admin still approves/rejects
  // (or auto-verify, when explicitly enabled). Optional so existing agencies and
  // `getRequirements()` are unaffected.
  //
  // Progress of the automated pass, distinct from the file-level `status`:
  //   not_started implicitly (field absent) -> checks_running -> passed | needs_review | failed
  verificationStatus?:
    | "not_run"
    | "checks_running"
    | "passed"
    | "needs_review"
    | "failed";
  // Per-check normalized results, keyed by check type (BVN/NIN/CAC/doc/liveness/AML).
  verificationChecks?: Partial<Record<VerificationCheckType, VerificationCheckResult>>;
  // Audit log of the user's consent to government-ID lookups (NIBSS iGree / NDPA).
  consent?: { bvn?: ConsentRecord; nin?: ConsentRecord };
}

export interface Agency {
  id: string;
  name: string;
  // URL-safe public handle used for the shareable agency landing page
  // (`/a/<slug>`). Unique across agencies, generated from the name on create
  // (see `agencyService.generateUniqueAgencySlug`). Optional in the type only so
  // that agencies created before slugs existed still satisfy it until backfilled.
  slug?: string;
  ownerId: string; // userId of the creator/owner
  ownerName: string; // Denormalized for display

  // Profile
  address?: string;
  state?: string;
  description?: string;
  logoUrl?: string;

  // Pricing (issue #179: US dollars, an explicit currency, never a bare number)
  // Agency-level default consultation fee, `{ amountMinor: <cents>, currency:
  // "USD" }`. Absent = no fee set. Replaces the old whole-naira `consultationFee`.
  consultationFeeUsd?: Money;
  // Audit of the naira values the #179 migration converted (never rewritten).
  migratedFrom?: AgencyPriceMigration;

  // Embedded services (small bounded list)
  services: AgencyService[];

  // Denormalized stats (updated via triggers/service calls)
  totalAgents: number;
  totalCases: number;
  activeCases: number;

  // Approval status (platform admission — set during onboarding review)
  status: AgencyStatus;
  rejectionReason?: string;
  reviewedBy?: string; // Admin userId who approved/rejected
  reviewedAt?: Timestamp;

  // Compliance file (KYC/KYB/payout). Absent until the owner starts it.
  // Compliance `verified` — not platform `status: "approved"` — is what unlocks
  // payments and assignment of platform-originated clients.
  compliance?: AgencyCompliance;

  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface AgencyInvitation {
  id: string;
  agencyId: string;
  agencyName: string; // Denormalized for display
  invitedBy: string; // userId of inviter
  invitedByName: string; // Denormalized
  invitedEmail: string;
  invitedAgentId?: string; // Set if agent already exists on platform
  status: AgencyInvitationStatus;
  createdAt: Timestamp;
  expiresAt: Timestamp;
}

// ============================================
// AGENT TYPES
// ============================================

export type AgentVerificationStatus =
  | "pending"
  | "under_review"
  | "verified"
  | "rejected"
  | "suspended";

export interface Agent {
  id: string;
  userId: string; // Reference to user account

  // Agency membership (null = independent agent)
  agencyId?: string;
  agencyRole?: AgencyMemberRole;

  // Profile
  displayName: string;
  bio: string;
  profilePhotoUrl?: string;

  // Professional info
  licenseNumber?: string;
  yearsOfExperience: number;
  specializations: string[]; // e.g., ["Student Visa", "Work Visa"]
  languages: string[];
  featuredVisas: string[]; // Visa type IDs they specialize in

  // Verification
  verificationStatus: AgentVerificationStatus;
  verificationDocuments?: string[]; // Storage URLs
  verifiedAt?: Timestamp;
  verifiedBy?: string; // Admin user ID

  // Ratings & Stats
  rating: number; // Average rating (1-5)
  totalReviews: number;
  totalApplications: number;
  successRate: number; // Percentage
  responseTime: string; // e.g., "24-48 hours"

  // Pricing (issue #179)
  // The agent's consultation fee in US DOLLARS, `{ amountMinor: <cents>,
  // currency: "USD" }`. New agents start at zero dollars. Replaces the naira
  // `consultationFee` number and its #148 `consultationFeeUnit` marker (both
  // removed by scripts/migrate-prices-to-usd.ts and no longer written).
  consultationFeeUsd: Money;
  // Audit of the naira fee the #179 migration converted (never rewritten).
  migratedFrom?: { consultationFee?: PriceMigrationRecord };
  /**
   * @deprecated Issue #103: SUPERSEDED by the agency-level per-visa service
   * price (`agencies/{agencyId}/visaPrices/{cc}__{visaTypeId}`, US dollars since
   * #179, see `AgencyVisaPrice` below and `src/agency-visa-prices/`).
   *
   * Legacy, never written by any UI and never read by any code: old agent
   * docs carry an empty `{}` here. It was documented as "fee in cents", so
   * it must NOT be read as naira (or at all). New agent docs no longer get
   * it, `PUT /agents/me` drops it from the body, and since #179 no client
   * may write it directly either (firestore.rules). Kept optional in the
   * type only so existing docs still type-check.
   */
  serviceFees?: Record<string, number>;

  // Availability
  isAvailable: boolean;
  availableSlots?: AvailabilitySlot[];

  // Metadata
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

/**
 * Issue #147: the ONLY shape an unauthenticated agent route may return.
 *
 * It is an allow-list (built field by field in `toPublicAgent`, never by
 * spreading or omitting from `Agent`), so a field added to `Agent` later stays
 * private until someone adds it here on purpose. Deliberately NOT included:
 * `userId` (the account uid), `licenseNumber`, `verificationDocuments`,
 * `verifiedBy`, `verifiedAt`, `availableSlots`, `serviceFees`.
 */
export interface PublicAgent {
  id: string;
  agencyId?: string; // Agency the agent belongs to (absent = independent)
  agencyRole?: AgencyMemberRole; // Role in that agency (mobile labels agents with it)
  displayName: string;
  bio: string;
  profilePhotoUrl?: string;
  yearsOfExperience: number;
  specializations: string[];
  languages: string[];
  featuredVisas: string[];
  verificationStatus: AgentVerificationStatus;
  rating: number;
  totalReviews: number;
  totalApplications: number;
  successRate: number;
  responseTime: string;
  /** The fee in US dollars as stored; null when the doc has no valid dollar fee (issue #179). */
  consultationFeeUsd: Money | null;
  /** The same fee in the viewer's local currency at the current rate; null when there is no fee. */
  consultationFeeLocal: LocalPriceQuote | null;
  isAvailable: boolean;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface AvailabilitySlot {
  dayOfWeek: number; // 0-6 (Sunday-Saturday)
  startTime: string; // "09:00"
  endTime: string; // "17:00"
}

export interface AgentReview {
  id: string;
  agentId: string;
  userId: string;
  applicationId?: string;
  rating: number; // 1-5
  title?: string;
  comment: string;
  createdAt: Timestamp;
  updatedAt?: Timestamp;
  isVerifiedClient: boolean;
}

// ============================================
// COUNTRY & VISA TYPES
// ============================================

export interface Country {
  code: string; // ISO 3166-1 alpha-2 (e.g., "US", "GB")
  name: string;
  flagUrl?: string;
  isSupported: boolean;
  visaTypesCount: number;
  minProcessingDays: number;
  minCostUsd: number;
  popularityRank?: number;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface VisaType {
  id: string;
  countryCode: string;

  // Basic info
  name: string; // e.g., "H-1B Work Visa"
  code: string; // e.g., "H1B"
  description: string;
  category: VisaCategory;

  // Timing & Cost
  processingTime: string; // e.g., "6-8 months"
  processingDaysMin: number;
  processingDaysMax: number;
  baseCostUsd: number; // Government fees

  // Validity
  validityPeriod: string; // e.g., "3 years"
  isExtendable: boolean;
  maxExtensions?: number;

  // Eligibility
  eligibilityCriteria: string[];

  // Issue #129: official "documents you must provide", extracted verbatim from
  // the scraped page and written only on admin approval (scrapeMeta.citations
  // holds the per-item quote under "requiredDocuments.<index>"). ABSENT when
  // the page lists none; plain strings, never invented.
  requiredDocuments?: string[];

  // Official application
  applicationUrl?: string; // URL to official online application form (e.g., AVATS for Ireland)
  applicationInstructions?: string; // Brief instructions for completing official application

  // Provenance (set when a value comes from the visa-catalog scraper + approval).
  // Note: the `source` flag lives in the "Admin review" block below.
  sourceUrl?: string; // official URL this record was last verified against
  lastVerifiedAt?: Timestamp; // when an agent last approved a scraped update
  scrapeMeta?: VisaScrapeMeta; // extractor provenance + per-field citations (audit trail)
  // Set ONCE when the scraper found the source withdrawn (GOV.UK
  // `withdrawn_notice`) and took this scraped visa off the app (isActive:false).
  // Never cleared automatically: reactivation is a human review step.
  staleSince?: Timestamp;
  // Issue #68: set when the crawl put a withdrawn + approved scraped visa back
  // into the review queue because its source page is live again (reviewStatus
  // approved -> pending_review). Marks the queue entry as a RESTORE (not a new
  // scrape), so a re-withdrawal before review can put it back to approved.
  // Cleared by an admin review (approve or reject) and by that re-withdrawal.
  restoredAt?: Timestamp;
  // Issue #212: set when an admin approved this scraped visa (or a re-crawl
  // proposal for it) while `scrapeMeta.missingFromExtraction` listed items the
  // extractor missed: who acknowledged them and when.
  missingItemsAcknowledgedBy?: string;
  missingItemsAcknowledgedAt?: Timestamp;

  // Stats
  successRate?: number;
  totalApplications?: number;

  // Issue #231 (P2 of #228): shared routes this record inherits, in order. The
  // country must be in each shared route's destinations on the day it is set.
  // The record stays the key of everything country-keyed (agency prices,
  // screenings, revisions, alerts); this only adds shared rulebook layers
  // BEFORE the country's own one (see shared-routes/route-stack.ts). Written
  // only by the admin shared-routes API; absent on every existing record.
  inheritsFrom?: SharedRouteRef[];

  // Availability
  isActive: boolean;
  quotaLimit?: number;
  currentQuotaUsed?: number;

  // Agents who handle this visa
  agentIds: string[];

  // Admin review
  // "draft" (issue #100): an agency visa that was saved but never submitted.
  // Only `source: "agency"` docs use it (POST /agency/visas). A draft is
  // hidden everywhere except the owning agency's `/agency/visas` reads: it is
  // inactive, agency-only, not "approved" (so isVisaPubliclyVisible is false
  // on three counts), left out of `GET /admin/visas`, and refused by the admin
  // review endpoint. Missing still means "seed / never reviewed".
  reviewStatus?: VisaReviewStatus;
  // Where the visa came from (issue #99 adds "agency"):
  //  - "scraped": created by the visa-catalog scraper (pending until approved);
  //  - "agent":   LEGACY. Created through the admin-only
  //               `POST /countries/:code/visas` before ownership existed. Still
  //               valid for those existing docs; nothing new is written with it
  //               except by that legacy endpoint (createVisaType);
  //  - "agency":  created by an agency (owner/agent) for its own clients (#100).
  //               Always carries `ownerAgencyId` + `createdBy`.
  // Missing on seed visas (treated as admin-curated and publicly visible).
  source?: VisaSource;
  reviewedBy?: string;
  reviewedAt?: Timestamp;
  rejectionReason?: string;

  // ---- Ownership + visibility (issue #99) ----
  // Agency that owns this visa (`agencies/{id}`). Set for `source: "agency"`
  // visas only; it never changes, and it stays set after the visa is made
  // global (the agency keeps the creator tag). Missing = Seli-owned
  // (seed, scraped, or legacy admin-created `source: "agent"`).
  ownerAgencyId?: string;
  // Firebase Auth uid of the user who created the visa (an agency owner or
  // agent for agency visas, the admin for admin-created ones). Missing on
  // seed, scraped and legacy docs, whose creator was never recorded.
  createdBy?: string;
  // Who can see the visa once it is active + approved:
  //  - "global": everyone (Explorer, `/visas`, country lists, search, stats);
  //  - "agency": only through the owning agency (its portal users, its public
  //              `/a/<slug>` page, its cases — #102). Never in public reads.
  // Missing = "global" (seed and scraped docs predate the field). Approval
  // does NOT change it: only the admin make-global action (#101) does.
  // Public reads decide with `isVisaPubliclyVisible` (visa.service.ts).
  visibility?: VisaVisibility;
  // Organisation that sponsors this route, for organisation-sponsored visas
  // (e.g. a UK sponsor-licence holder issuing Certificates of Sponsorship).
  // Optional on every visa; validated by the agency endpoints (#100).
  sponsor?: VisaSponsor;

  // ---- Agency submission (issue #100) ----
  // When / by whom an agency visa was last submitted for review
  // (`POST /agency/visas/:id/submit`). Missing on drafts that were never
  // submitted and on every non-agency visa.
  submittedAt?: Timestamp;
  submittedBy?: string;

  // ---- Make global / agency-only (issue #101) ----
  // Written only by the admin `PATCH /admin/visas/:id/visibility` action.
  // Both pairs are kept as history (neither is cleared):
  //  - madeGlobalBy / madeGlobalAt: the admin uid + time of the LAST switch
  //    to `visibility: "global"`;
  //  - madeAgencyOnlyBy / madeAgencyOnlyAt: the admin uid + time of the LAST
  //    switch back to `visibility: "agency"`.
  // The current state is always `visibility`; compare the two times to see
  // which switch happened last. Missing on visas never switched.
  madeGlobalBy?: string;
  madeGlobalAt?: Timestamp;
  madeAgencyOnlyBy?: string;
  madeAgencyOnlyAt?: Timestamp;

  createdAt: Timestamp;
  updatedAt: Timestamp;
}

/**
 * `VisaType.reviewStatus` values. "draft" is agency-only (issue #100); the
 * other three are the admin review states used by every source.
 */
export type VisaReviewStatus = "draft" | "pending_review" | "approved" | "rejected";

/**
 * A pending edit to an APPROVED agency visa (issue #100), stored in the
 * top-level `visaRevisions/{countryCode}__{visaId}` collection — never on the
 * live visa doc, so public and agency reads keep serving the approved values
 * (and unreviewed text never reaches a public read of the live doc).
 *
 * One revision per visa: further edits merge into it. The admin approve /
 * reject of a revision is #101 (approve applies `changes` to the live doc and
 * deletes this doc; reject sets `reviewStatus: "rejected"` + reason). See
 * `src/agency-visas/agency-visas.md` for the full contract.
 */
export interface VisaRevision {
  /** Doc id: `${countryCode}__${visaId}`. */
  id: string;
  /** The live visa this revision edits (`countries/{cc}/visaTypes/{visaId}`). */
  visaId: string;
  countryCode: string;
  /** Copied from the live visa, so an agency's revisions are one query. */
  ownerAgencyId: string;
  /**
   * Content fields that differ from the live visa, with their proposed
   * values. `null` = remove that optional field from the live visa.
   */
  changes: Record<string, unknown>;
  /** Review state of THIS revision (the live visa stays "approved"). */
  reviewStatus: "pending_review" | "rejected";
  /** Last agency user who edited the revision, and when. */
  submittedBy: string;
  submittedAt: Timestamp;
  /** Set by the admin reject (#101); cleared on the next agency edit. */
  rejectionReason?: string;
  reviewedBy?: string;
  reviewedAt?: Timestamp;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

/**
 * Origin of a visa doc (`VisaType.source`). See the field comment for each
 * value; "agent" is legacy and kept only so existing docs stay valid.
 */
export type VisaSource = "scraped" | "agent" | "agency";

/**
 * Named `VisaType.visibility` values (issue #99), so code compares against
 * one constant instead of repeating string literals.
 */
export const VISA_VISIBILITY = {
  /** Only visible through the owning agency. */
  AGENCY: "agency",
  /** Visible to everyone (public reads). The default when missing. */
  GLOBAL: "global",
} as const;

/** `VisaType.visibility`: "agency" | "global" (see VISA_VISIBILITY). */
export type VisaVisibility = (typeof VISA_VISIBILITY)[keyof typeof VISA_VISIBILITY];

/**
 * Sponsoring organisation of an organisation-sponsored visa route
 * (`VisaType.sponsor`, issue #99). Free-text details as the agency entered
 * them; validation lives with the agency visa endpoints (#100).
 */
export interface VisaSponsor {
  /** Legal or trading name of the sponsoring organisation. Required. */
  organisationName: string;
  /** Organisation website (absolute URL). */
  website?: string;
  /** Sponsor licence number, e.g. a UK Home Office sponsor licence. */
  sponsorLicenceNumber?: string;
  /** How to reach the sponsor: a name, email or phone number. */
  contact?: string;
}

export type VisaCategory = 
  | "work" 
  | "student" 
  | "tourist" 
  | "business" 
  | "family" 
  | "investor" 
  | "transit"
  | "other";

export interface VisaRequirement {
  id: string;
  visaTypeId: string;
  
  title: string;
  description: string;
  
  // Timing
  estimatedTime: string; // e.g., "1-2 weeks"
  orderIndex: number; // For sequencing requirements
  
  // Documents needed for this requirement
  requiredDocuments: RequiredDocument[];
  
  // Dependencies
  dependsOn?: string[]; // IDs of requirements that must be completed first
  
  isOptional: boolean;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface RequiredDocument {
  id: string;
  name: string;
  description: string;
  acceptedFormats: string[]; // ["pdf", "jpg", "png"]
  maxSizeMb: number;
  isRequired: boolean;
  validationCriteria?: string[];
  sampleUrl?: string; // Link to sample document
  // Issue #175: set ONLY on documents derived at read time from a scraped
  // visa record. The verbatim quote (scrapeMeta.citations) and the official
  // page it came from. Absent on seeded / admin-authored documents.
  citation?: { quote: string; sourceUrl: string };
  // Issue #187: what the applicant does with the item and how firmly the page
  // asks for it. Seeded / admin-authored documents are always `document` +
  // `required` (the defaults, written out by the derive/checklist code, not
  // stored on those records). `isRequired` above is true ONLY for `required`.
  kind?: "document" | "information";
  kindReview?: true; // could not classify from the page's wording: stays `document`
  kindQuote?: string; // verbatim page text behind `kind` (or the lead-in)
  // Issue #187 regroom: the answer shape of an INFORMATION item (absent on documents).
  answerType?: "date" | "date_range" | "money" | "address" | "list" | "text";
  answerTypeQuote?: string; // verbatim page text behind `answerType` (absent when the rule decided)
  need?: "required" | "conditional" | "optional";
  appliesWhen?: string; // verbatim "if ..." / "unless ..." / "depending on ..." clause or lead-in
}

// ============================================
// APPLICATION TYPES
// ============================================

export type ApplicationStatus = 
  | "draft"
  | "pending_payment"
  | "pending_documents"
  | "under_review"
  | "submitted_to_embassy"
  | "interview_scheduled"
  | "approved"
  | "rejected"
  | "withdrawn"
  | "expired";

export type ApplicationMode = "self" | "agent";

// Origin channel for an application. This is distinct from `mode` (which records
// WHO manages the application — the client themselves vs an agent). `createdVia`
// records WHERE the application was started: the mobile app (client self-serve)
// vs the agent portal (an agent starting it on a client's behalf). This lets us
// tell the two populations apart for reporting, routing and onboarding logic.
export type ApplicationCreatedVia = "portal" | "mobile";

export interface Application {
  id: string;
  userId: string;
  visaTypeId: string;
  countryCode: string;

  // Mode
  mode: ApplicationMode;
  agentId?: string;
  agencyId?: string; // Cases belong to the agency, not the individual agent

  // Origin channel — "mobile" for client self-serve, "portal" for agent-started.
  // Optional for backward-compatibility with documents created before this field
  // existed (those are treated as "mobile" downstream).
  createdVia?: ApplicationCreatedVia;

  // Admin provenance — set when a platform ADMIN (not the assigned agent) starts
  // the application on an agency's behalf. `agentId`/`agencyId` above still point
  // to the chosen owning agent/agency; these fields record who actually created
  // it and why, for audit and support. Absent on agent/self-serve applications.
  createdByAdmin?: boolean; // Flag: was this created by an admin?
  createdByAdminId?: string; // The admin's user uid (which admin)
  createdByAdminName?: string; // Denormalized admin name for display
  adminCreationReason?: string; // Optional reason the admin gave

  // ---- Who is handling this case (resolved on READ, not stored) ----
  // Populated by the API when an application is returned, so a client can see
  // who is acting for them without needing read access to the agents/agencies
  // collections. Deliberately NOT persisted: denormalizing would require a
  // backfill across every existing application and re-syncing on reassignment,
  // whereas resolving on read is correct for old and new data alike.
  agentName?: string;
  agencyName?: string;
  /** Agency logo, when the agency has uploaded one (client-facing branding). */
  agencyLogoUrl?: string;

  // Status & Progress
  status: ApplicationStatus;
  progress: number; // 0-100
  currentStep: string;
  nextStep?: string;
  
  // Key dates
  startDate: Timestamp;
  lastUpdated: Timestamp;
  submittedAt?: Timestamp;
  completedAt?: Timestamp;
  interviewDate?: Timestamp;
  
  // Documents summary
  documentsRequired: number;
  documentsUploaded: number;
  documentsVerified: number;
  documentsRejected: number;
  
  // Financial (issue #181: real unit and currency documented)
  // `totalCost` and `amountPaid` are integer MINOR units of `costCurrency`.
  // New applications are priced from the visa's `baseCostUsd`, so both are
  // US CENTS with `costCurrency: "USD"` (written on create and by every
  // payment-request settlement). An application stored before #181 has no
  // `costCurrency`: a positive `totalCost` there is US cents too (it was always
  // `baseCostUsd` in cents); with no total yet its currency is undecided, and
  // the first settlement decides it (see payment-request-settlement.service.ts
  // `applicationPaymentUpdate`). A payment in ANOTHER currency than
  // `costCurrency` (a legacy naira request on a dollar case) is never added to
  // `amountPaid`: it is recorded in `amountPaidOtherCurrencies` instead, so
  // US cents and kobo are never summed.
  totalCost: number;
  amountPaid: number;
  /** The currency of `totalCost` and `amountPaid` ("USD" for every new case). */
  costCurrency?: CurrencyCode;
  /**
   * Paid amounts in a currency other than `costCurrency`, in minor units of
   * that currency, keyed by ISO code (e.g. `{ NGN: 2500000 }` for a legacy
   * naira request settled on a dollar case). Never counted in `amountPaid`.
   */
  amountPaidOtherCurrencies?: Record<CurrencyCode, number>;
  paymentStatus: PaymentStatus;
  
  // Notes
  userNotes?: string;
  agentNotes?: string;
  rejectionReason?: string;

  // Denormalized fields (colocated for read performance)
  clientName?: string;
  clientEmail?: string;
  clientPhone?: string; // Captured when an agent starts an application for a client
  visaTypeName?: string;
  countryName?: string;

  // Answers to the route's intake questions (issue #113). Written only by
  // PUT /applications/:id/intake, which validates them against the approved
  // rubric; never through the generic application update.
  intake?: ApplicationIntake;

  // Issue #231 (P2 of #228): the rulebook keys this application runs on, shared
  // layer(s) first and the country's own `{countryCode}_{visaTypeId}` last,
  // fixed when the application starts so a later change of the visa's
  // `inheritsFrom` does not rewrite a running application. ABSENT on
  // applications started before P2: those resolve live
  // (shared-routes/route-stack.ts `resolveApplicationStack`).
  routeStack?: string[];

  // Issue #234 (P5 of #228): the applicant's holdings (nationalities, country
  // of residence, held visas and permits) COPIED from their profile when the
  // application started, with the time taken. Assessment reads this copy, not
  // the live profile. Personal data: returned only by GET /applications/:id
  // (behind `checkApplicationAccess`) and stripped from case lists. ABSENT on
  // applications started before #234. Never written by the generic update.
  applicantFacts?: ApplicantFacts;

  // Issue #235 (P6 of #228): on a SHARED route, the member country the
  // application goes through, CONFIRMED by the applicant (or their agent).
  // `countryCode` / `visaTypeId` above are that member's own inheriting record,
  // so prices, agencies and the rest of the system read it unchanged. ABSENT on
  // every application that was not started through a shared route.
  throughCountryCode?: string;
  // Who confirmed it, and the rule shown at that time (see ThroughCountryChoice).
  throughCountry?: ThroughCountryChoice;

  createdAt: Timestamp;
  updatedAt: Timestamp;
}

/**
 * (#235) The confirmed "country I apply through" of a shared-route
 * application, with what the applicant was shown when they confirmed it.
 * The proposal is NEVER forced: `followedProposal` is false when the applicant
 * picked another member, and `reasonShown` is the line they saw ("The rule
 * says X; you chose Y"). Written only by the create and change-country paths.
 */
export interface ThroughCountryChoice {
  /** The shared route the application is on. */
  sharedRouteId: string;
  /** The confirmed member country (same as `Application.throughCountryCode`). */
  countryCode: string;
  /** Who confirmed it: their uid and role at the time. */
  chosenByUid: string;
  chosenByRole?: string;
  confirmedAt: Timestamp;
  /**
   * The proposal shown at that time, from the shared rulebook's competence
   * steps (null when the rulebook has no such rule or the answers did not
   * point to a country: the applicant then simply picked).
   */
  proposal: { countryCode: string; stepIndex: number; restsOn: string; quote: string; url: string } | null;
  /** The answers the proposal was worked out from (scoped question ids). */
  answers: Record<string, unknown>;
  /** Why there was no proposal (a code from the resolver), when there was none. */
  noProposalReason?: string;
  /** True when the confirmed country is the proposed one; null when there was no proposal. */
  followedProposal: boolean | null;
  /** The plain line shown when the applicant chose another member than the rule's. */
  reasonShown?: string;
  /** The shared rulebook (key and approved version) the steps came from, when one was read. */
  rulebookKey?: string;
  rulebookVersion?: number;
}

export type PaymentStatus = 
  | "pending"
  | "partial"
  | "paid"
  | "refunded"
  | "failed";

export interface ApplicationTimeline {
  id: string;
  applicationId: string;
  
  title: string;
  description: string;
  status: "completed" | "current" | "upcoming" | "blocked";
  
  date: Timestamp;
  completedAt?: Timestamp;
  
  // Who is responsible
  responsibility: "user" | "agent" | "embassy" | "system";
  
  createdAt: Timestamp;
}

// ============================================
// APPLICATION NOTE TYPES
// ============================================

export type NoteAuthorRole = "agent" | "owner" | "admin" | "system";

export interface ApplicationNote {
  id: string;
  applicationId: string;
  authorId: string;
  authorName: string; // Denormalized to avoid user lookups
  authorRole: NoteAuthorRole;
  content: string;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

// ============================================
// DOCUMENT TYPES
// ============================================

export type DocumentStatus = 
  | "pending_upload"
  | "uploading"
  | "uploaded"
  | "under_review"
  | "verified"
  | "rejected"
  | "resubmission_required";

/**
 * Who pushed the bytes for a document. Distinct from *ownership*: a document
 * always belongs to the application's client (`Document.userId`), but agency
 * staff may upload it for them (see `uploadedOnBehalf` below).
 */
export type DocumentUploaderRole = "client" | "agent" | "owner" | "admin";

/**
 * How a document reached the agency when staff uploaded it on a client's
 * behalf. Captured for audit — "where did this file come from?" is the first
 * question asked when a document's provenance is challenged.
 */
export type DocumentUploadSource =
  | "email"
  | "whatsapp"
  | "in_person"
  | "postal"
  | "third_party"
  | "other";

export interface Document {
  id: string;
  applicationId: string;
  requirementId: string;
  /**
   * The application's CLIENT — the person the document belongs to. This is
   * ownership, NOT authorship: when an agent uploads for a client this still
   * points at the client, so the document appears in their workspace. See
   * `uploadedByUserId` for who actually performed the upload.
   */
  userId: string;

  // File info
  fileName: string;
  fileType: string;
  fileSizeMb: number;
  storageUrl: string;

  // Status
  status: DocumentStatus;

  // ---- Descriptive metadata (captured at upload time) ----
  // Optional across the board: self-serve client uploads from the mobile app
  // supply none of these, and pre-existing documents have none.
  /** Category label, e.g. "Bank Statement". Free text so it isn't capped by a list. */
  documentType?: string;
  /** Human label for the document, shown instead of the raw file name when set. */
  displayName?: string;
  /** Free-text notes about the document's contents, coverage period, etc. */
  description?: string;

  // ---- Upload provenance (audit trail) ----
  // Added so an agency can upload documents for a client without the record
  // silently claiming the client submitted it themselves. Absent on documents
  // created before this existed — treat a missing `uploadedByUserId` as
  // "uploaded by the owner" (`userId`) when rendering.
  /** The uid that actually performed the upload. Equals `userId` for self-uploads. */
  uploadedByUserId?: string;
  /** Denormalized uploader name so listings need no extra user lookup. */
  uploadedByName?: string;
  /** The uploader's role at the time of upload. */
  uploadedByRole?: DocumentUploaderRole;
  /** True when the uploader was NOT the client — i.e. agency staff acted for them. */
  uploadedOnBehalf?: boolean;
  /** WHY staff uploaded for the client. Required for on-behalf uploads. */
  uploadReason?: string;
  /** How the file reached the agency (email, WhatsApp, in person…). */
  uploadSource?: DocumentUploadSource;

  // Review
  reviewedBy?: string; // Agent ID
  reviewedAt?: Timestamp;
  rejectionReason?: string;
  agentComments?: string;

  // Tracking
  resubmissionCount: number;

  uploadedAt: Timestamp;
  updatedAt: Timestamp;
}

// ============================================
// DOCUMENT REQUEST TYPES
// ============================================

/**
 * Lifecycle of an agent's "please send me X" ask.
 *
 *  - `pending`   — outstanding; this is what the client's to-do list renders.
 *  - `fulfilled` — the client uploaded a document against it (auto-transitioned
 *                  by `POST /documents` when it carries `documentRequestId`).
 *  - `waived`    — the agent decided it's no longer needed.
 *  - `cancelled` — the agent withdrew the request (asked in error / duplicate).
 *
 * Only `pending` is actionable by the client; the other three are terminal.
 */
export type DocumentRequestStatus =
  | "pending"
  | "fulfilled"
  | "waived"
  | "cancelled";

/**
 * A durable record of an agent asking a client for a specific document.
 *
 * WHY THIS EXISTS: this ask used to be fire-and-forget — an activity note plus a
 * push/email notification. That's fine for the mobile app (which nudges the user
 * in the moment) but leaves nothing queryable, so a client opening the web
 * workspace days later had no way to see what they still owe. Persisting the ask
 * gives the client a checklist and the agent a fulfilment view, and lets us close
 * the loop automatically when the matching upload lands.
 *
 * Stored in the top-level `documentRequests` collection (not a subcollection of
 * the application) so a client's outstanding items across every one of their
 * applications can be fetched with a single `userId + status` query.
 */
export interface DocumentRequest {
  id: string;
  applicationId: string;
  /** The CLIENT this is addressed to (== Application.userId). Query key. */
  userId: string;
  /** Owning agency, when the requesting agent belongs to one. Query key for the
   *  agency-wide fulfilment view; null for an independent agent. */
  agencyId?: string | null;

  // --- What's being asked for -------------------------------------------------
  /** Free-text label the agent typed, e.g. "Bank statement (last 6 months)". */
  documentType: string;
  /** Optional extra instruction shown under the label. */
  notes?: string;
  /** Optional soft deadline surfaced in the client UI. Not enforced. */
  dueDate?: Timestamp;

  // --- Provenance -------------------------------------------------------------
  /** USER uid of the agent/owner/admin who made the request. */
  requestedBy: string;
  /** Denormalized display name so the client UI needs no extra lookup. */
  requestedByName: string;

  // --- Denormalized application context (saves an N+1 fetch on the to-do list) --
  visaTypeName?: string;
  countryName?: string;

  // --- Issue #187: kind + need carried from the checklist item -----------------
  kind?: "document" | "information";
  kindReview?: true;
  kindQuote?: string;
  // Issue #187 regroom: answer shape of an information item.
  answerType?: "date" | "date_range" | "money" | "address" | "list" | "text";
  answerTypeQuote?: string;
  need?: "required" | "conditional" | "optional";
  appliesWhen?: string;

  // --- Lifecycle --------------------------------------------------------------
  status: DocumentRequestStatus;
  /** Id of the `Document` the client uploaded to satisfy this request. */
  fulfilledDocumentId?: string;
  fulfilledAt?: Timestamp;
  /** Uid of whoever moved it to a terminal non-fulfilled state (waive/cancel).
   *  `"system"` (CHECKLIST_SYSTEM_ACTOR_ID) when the checklist sync cancelled it. */
  resolvedBy?: string;

  // --- Back-reference to an accepted AI proposed action (issue #44) ------------
  // Additive and optional: set only on a request created by accepting a proposed
  // action (`applicationAssessments/{sourceAssessmentId}/proposedActions/{sourceActionId}`).
  // Existing consumers ignore them. They make accept idempotent and let a
  // fulfilled / waived / cancelled request update the action it came from.
  sourceAssessmentId?: string;
  sourceActionId?: string;
  // --- Checklist-origin fields (issue #114) ------------------------------------
  // All OPTIONAL: agent-raised requests and every pre-existing document carry
  // none of them and behave exactly as before.
  /** `"checklist"` when the request was generated from the verified visa
   *  record by the checklist builder; absent for agent-raised requests. */
  origin?: "checklist";
  /** Stable id of the checklist item (from the rubric evidence key, or the
   *  visa record's document list). With `applicationId` it is the idempotency
   *  key: the doc id is `{applicationId}__{checklistItemId}`. */
  checklistItemId?: string;
  /** Whose document it is. `sponsor` documents are still uploaded by the
   *  applicant (the sponsor has no account) and belong to the applicant. */
  holder?: "applicant" | "sponsor";
  /** Why the document is asked for: a deterministic template filled from the
   *  rubric criterion, so it is always present on a checklist item. */
  reason?: string;
  /** Whether the source calls the document required (false = optional). */
  required?: boolean;
  /** The rubric criterion this item mainly evidences (its `ruleRef` or
   *  `criterionId`), for display and audit. */
  criterionRef?: string;
  /** The published source behind the item: verbatim quote + official URL. */
  citation?: DocumentRequestCitation;

  createdAt: Timestamp;
  updatedAt: Timestamp;
}

/** Verbatim quote + URL behind a checklist item (never model-written). */
export interface DocumentRequestCitation {
  /** The exact words of the published source. */
  quote: string;
  /** The official page the quote is on. */
  url: string;
  /** The publisher's own paragraph / section number, when the rubric has one. */
  ruleRef?: string;
}

/** Actor recorded as `requestedBy` / `resolvedBy` on system-built requests. */
export const CHECKLIST_SYSTEM_ACTOR_ID = "system";
/** Display name shown to the applicant for system-built requests. */
export const CHECKLIST_SYSTEM_ACTOR_NAME = "Seli";

// ============================================
// CONSULTATION TYPES
// ============================================

export type ConsultationStatus = 
  | "pending_payment"
  | "scheduled"
  | "confirmed"
  | "in_progress"
  | "completed"
  | "cancelled"
  | "no_show";

export type ConsultationType = 
  | "initial"
  | "document_review"
  | "interview_prep"
  | "follow_up"
  | "general";

/**
 * A consultation booking.
 *
 * Issue #180: a PAID booking created from #180 on carries the charge
 * snapshot (`ChargeSnapshot`: priceUsdCents, chargedCurrency,
 * chargedAmountMinor, fxRate, fxRateAsOf, fxRateSource, fxMarginBps) and the
 * quote lock (`QuoteLock`: quoteLockedAt, quoteExpiresAt), all priced on the
 * SERVER from the agent's / agency's dollar fee. A FREE booking carries only
 * `priceUsdCents: 0`. A LEGACY booking (before #180) carries only `fee`
 * (whole naira) and no snapshot: it is shown as naira and never re-priced.
 * The snapshot fields are optional in the type because legacy rows lack them.
 */
export interface Consultation extends Partial<ChargeSnapshot>, Partial<QuoteLock> {
  id: string;
  userId: string;
  agentId: string;
  agencyId?: string;
  applicationId?: string;

  // Denormalized display fields
  clientName: string;
  clientEmail: string;
  agentName: string;

  // Booking details
  type: ConsultationType;
  scheduledDate: Timestamp;
  scheduledTime: string; // "10:30"
  durationMinutes: number;
  timezone: string;

  // Status
  status: ConsultationStatus;
  
  // Meeting
  meetingLink?: string;
  meetingPlatform?: "zoom" | "google_meet" | "teams";
  
  // Payment
  // LEGACY ONLY: whole naira (issue #148), on bookings made before #180. Not
  // written any more (the snapshot fields above replace it) and never
  // re-priced: a legacy row is displayed and verified as naira as stored.
  fee?: number;
  paymentStatus: PaymentStatus;
  // The Paystack reference of the CURRENT checkout while pending, then of the
  // payment that settled it (used by verify to match the return leg).
  transactionId?: string;
  // Issue #180: the Paystack checkout page for the current reference, so a
  // retry inside the quote lock returns the SAME checkout (no second charge
  // is opened while the first can still be paid).
  checkoutUrl?: string;
  // Issue #180: where Paystack sends the payer back (kept so a re-priced
  // checkout returns the payer to the same page as the first one).
  checkoutCallbackUrl?: string;
  // Issue #180: when the payment was confirmed.
  paidAt?: Timestamp;
  // Issue #180: when Paystack says the payment completed (its `paid_at`).
  paystackPaidAt?: Timestamp;
  // Issue #180: true when an exact payment landed after `quoteExpiresAt` and
  // was honoured anyway; flagged for review (also on the Transaction).
  paidAfterQuoteExpiry?: boolean;
  // Issue #180 (review fix): every checkout this booking has REPLACED, each
  // with the snapshot and lock it was priced at. A re-price never forgets the
  // old reference: an exact payment that completes on it later can still
  // settle a still-unpaid booking at THAT reference's own price, or is
  // recorded for refund (consultationPaymentExceptions) when the booking was
  // already paid. Appended inside the same Firestore transaction that stores
  // the new reference.
  supersededCheckouts?: SupersededCheckout[];
  // Issue #180 (review fix): true when the booking was settled by an exact
  // payment on a superseded reference (also on the Transaction).
  paidOnSupersededReference?: boolean;
  
  // After consultation
  summary?: string;
  recordingUrl?: string;
  
  // Cancellation
  cancelledAt?: Timestamp;
  cancelledBy?: string;
  cancellationReason?: string;
  
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

/**
 * A Paystack checkout a consultation booking (issue #180 review fix) or a
 * payment request (issue #181) no longer offers: replaced by a re-price after
 * the quote lock passed, or by a reissue after a checkout that never opened.
 * Kept with the exact price it asked for, so a payment that completes on it
 * later is judged against what THAT checkout asked, never the record's newer
 * price.
 */
export interface SupersededCheckout extends ChargeSnapshot, Partial<QuoteLock> {
  /** Our own Paystack reference for that checkout. */
  reference: string;
  /** When it was replaced. */
  supersededAt: Timestamp;
}

/**
 * Money we hold for a consultation that cannot be applied to it (issue #180
 * review fix): an exact payment on a superseded checkout of a booking that
 * was already paid (a second charge), or a payment on a booking that is no
 * longer awaiting payment (e.g. cancelled while the payer was paying).
 *
 * Collection `consultationPaymentExceptions`, doc id = the Paystack
 * reference (so a second verify of the same payment never records it twice).
 * Backend only: firestore.rules denies every client. Written for a human to
 * refund; NEVER a second Transaction.
 */
export interface ConsultationPaymentException {
  id: string;
  consultationId: string;
  /** The Paystack reference that was paid. */
  reference: string;
  /** What Paystack charged (its `amount`, minor units of `currency`). */
  amountMinor: number;
  currency: string;
  /** Paystack's own payment time (`paid_at`), when it reported one. */
  paystackPaidAt: Timestamp | null;
  reason: "paid_on_superseded_reference_after_booking_paid" | "booking_not_payable";
  /** Open until a human refunds it (no automated refund yet). */
  status: "open";
  createdAt: Timestamp;
}

/**
 * Money we hold for a payment request that cannot be applied to it (issue
 * #181, same rules as ConsultationPaymentException): an exact payment on a
 * superseded checkout of a request that was already paid (a second charge),
 * or a payment on a request that is no longer awaiting payment (cancelled,
 * rejected or expired while the client was paying).
 *
 * Collection `paymentRequestExceptions`, doc id = the Paystack reference.
 * Backend only: firestore.rules denies every client. Written for a human to
 * refund; NEVER a second Transaction.
 */
export interface PaymentRequestPaymentException {
  id: string;
  paymentRequestId: string;
  /** The Paystack reference that was paid. */
  reference: string;
  /** What Paystack charged, in minor units of `currency`. */
  amountMinor: number;
  currency: string;
  /** Paystack's own payment time (`paid_at`), when it reported one. */
  paystackPaidAt: Timestamp | null;
  reason: "paid_on_superseded_reference_after_request_paid" | "request_not_payable";
  /** Open until a human refunds it (no automated refund yet). */
  status: "open";
  createdAt: Timestamp;
}

// ============================================
// TRANSACTION TYPES
// ============================================

export type TransactionType =
  | "consultation_fee"
  | "service_fee"
  | "government_fee"
  | "refund"
  | "escrow_release"
  | "withdrawal";

export type TransactionStatus = 
  | "pending"
  | "processing"
  | "completed"
  | "failed"
  | "refunded"
  | "held_in_escrow"
  | "released";

/**
 * One financial event.
 *
 * Issue #180: a consultation-fee transaction also records the charge
 * snapshot of the booking it settles (priceUsdCents, chargedCurrency,
 * chargedAmountMinor, fxRate, fxRateAsOf, fxRateSource, fxMarginBps), so the
 * payment never changes when the rate moves. Optional: older transaction
 * kinds and legacy rows have none.
 */
export interface Transaction extends Partial<ChargeSnapshot> {
  id: string;
  // Issue #180 (consultation_fee): Paystack's payment time, and the flag for
  // an exact payment honoured after the booking's quote lock.
  paystackPaidAt?: Timestamp;
  paidAfterQuoteExpiry?: boolean;
  // Issue #180 review fix: settled by an exact payment on a superseded checkout.
  paidOnSupersededReference?: boolean;
  // Issue #181: the payment request a payment-request transaction settles.
  paymentRequestId?: string;
  userId: string;
  agentId?: string;
  applicationId?: string;
  consultationId?: string;
  
  // Payment details
  type: TransactionType;
  // Minor units of `currency` (kobo for NGN, cents for USD). Never a bare
  // number: always read together with `currency` (issue #178).
  amount: number;
  currency: string;
  
  // Status
  status: TransactionStatus;
  
  // Escrow (for milestone-based payments)
  isEscrow: boolean;
  escrowReleaseCondition?: string;
  escrowReleasedAt?: Timestamp;
  
  // Payment processor. "paystack" is the live gateway (subscriptions, seats, and
  // guest consultation fees); the others predate it.
  paymentProvider: "stripe" | "paypal" | "manual" | "paystack";
  providerTransactionId?: string;
  
  // Metadata
  description: string;
  metadata?: Record<string, unknown>;

  // Denormalized fields (for read performance)
  clientName?: string;
  clientEmail?: string;
  visaTypeName?: string;

  createdAt: Timestamp;
  updatedAt: Timestamp;
}

// ============================================
// PAYMENT REQUEST TYPES
// ============================================

export type PaymentRequestStatus =
  | "pending"
  | "paid"
  | "cancelled"
  | "expired"
  | "approved"
  | "rejected";

// Category of the payment request — enables consistent filtering/analytics
export type PaymentRequestCategory =
  | "visa_fee"
  | "health_check"
  | "document_creation"
  | "document_review"
  | "translation"
  | "government_fee"
  | "other";

/**
 * A payment an agent asks a client for, on one case (application).
 *
 * Issue #181: the agent sets the price in US DOLLARS. A request created from
 * #181 on stores it as `priceUsd` (a `Money`, `currency: "USD"`), and mirrors
 * it in `amount` (US cents) + `currency: "USD"` so every reader that already
 * shows `amount` in minor units of `currency` keeps working. When the client
 * starts checkout the server prices it in the client's charge currency and
 * stores the charge snapshot (`ChargeSnapshot`: priceUsdCents,
 * chargedCurrency, chargedAmountMinor, fxRate, fxRateAsOf, fxRateSource,
 * fxMarginBps) and the quote lock (`QuoteLock`). Re-issuing an unpaid
 * checkout re-quotes; once `status` is `paid` the snapshot never changes.
 *
 * A LEGACY request (before #181) has no `priceUsd` and no snapshot: `amount`
 * is kobo and `currency` is "NGN". It lists, displays and settles as before
 * and is never re-priced or rewritten.
 */
export interface PaymentRequest extends Partial<ChargeSnapshot>, Partial<QuoteLock> {
  id: string;
  applicationId: string;
  /** The requesting agent's PROFILE id (`agents/{id}`), not their user uid. */
  agentId: string;
  agencyId?: string;
  clientId: string;

  // Denormalized
  clientName: string;
  clientEmail: string;

  // Payment details
  /**
   * Issue #181: the price the agent asked for, in US dollars. Absent on a
   * legacy request.
   */
  priceUsd?: Money;
  /**
   * Minor units of `currency`. New requests: US cents (= `priceUsd`).
   * Legacy requests: kobo, with `currency: "NGN"`. Never a bare number:
   * always read together with `currency`.
   */
  amount: number;
  currency: string;
  description: string;
  category: PaymentRequestCategory;

  // Status
  status: PaymentRequestStatus;
  paidAt?: Timestamp;
  /**
   * Paystack transaction reference of the CURRENT checkout while unpaid, then
   * of the payment that settled it. Issue #181: generated by US
   * (`preq-<id>-<uuid>`) and stored before the checkout opens, so a
   * return-from-Paystack or a webhook can be tied back to THIS request and a
   * replayed reference can't be credited to a different one. (A legacy
   * request carries Paystack's own reference.)
   */
  paystackReference?: string;
  /** Issue #181: the Paystack checkout page for the current reference (null while it opens). */
  checkoutUrl?: string | null;
  /** Issue #181: where Paystack sends the payer back (kept for a re-priced checkout). */
  checkoutCallbackUrl?: string;
  /** Issue #181: every checkout this request has replaced, with its own snapshot (see SupersededCheckout). */
  supersededCheckouts?: SupersededCheckout[];
  /** Issue #181: Paystack's own payment time (`paid_at`), when reported. */
  paystackPaidAt?: Timestamp;
  /** Issue #181: an exact payment honoured after `quoteExpiresAt` (flagged for review, also on the Transaction). */
  paidAfterQuoteExpiry?: boolean;
  /** Issue #181: settled by an exact payment on a superseded checkout (also on the Transaction). */
  paidOnSupersededReference?: boolean;
  /** Issue #181: the id of the Transaction the settlement wrote (one per request, ever). */
  paymentTransactionId?: string;
  cancelledAt?: Timestamp;
  expiresAt?: Timestamp;
  approvedAt?: Timestamp;
  rejectedAt?: Timestamp;
  rejectionReason?: string;

  createdAt: Timestamp;
  updatedAt: Timestamp;
}

// ============================================
// BANK ACCOUNT TYPES
// ============================================

export interface BankAccount {
  id: string;
  userId: string; // Owner of the bank account

  accountName: string;
  bankName: string;
  accountNumber: string;
  isMain: boolean;

  createdAt: Timestamp;
  updatedAt: Timestamp;
}

// ============================================
// NOTIFICATION TYPES
// ============================================

export type NotificationType =
  // Applications
  | "application_update"
  | "application_created" // An agent started an application on a client's behalf
  | "application_assigned" // An application was assigned to an agent
  | "application_withdrawn"
  // The approved rules changed and a bulk re-assessment (#37) produced a worse
  // or blocking result: sent to the assigned agent / agency owner / admins,
  // NEVER to the applicant.
  | "assessment_rules_updated"
  // The published rules or details of an in-flight application's route changed
  // (issue #123), raised only from an ADMIN-APPROVED change. Staff get the
  // detail; an applicant only ever gets a neutral, factual notice.
  | "rule_change_alert"
  // Documents
  | "document_status"
  | "document_uploaded" // Client uploaded a document for review
  | "document_approved"
  | "document_rejected"
  // Consultations
  | "consultation_booking" // A consultation was booked/scheduled
  | "consultation_reminder"
  | "consultation_confirmed"
  | "consultation_rescheduled"
  | "consultation_cancelled"
  | "consultation_completed"
  // Payments
  | "payment_received"
  | "payment_request"
  | "payment_request_rejected"
  // Subscriptions / billing
  | "subscription_activated"
  | "subscription_renewed"
  | "subscription_payment_failed"
  | "subscription_canceled"
  | "plan_changed"
  | "seats_added"
  // Agency / agent lifecycle
  | "agent_invited"
  | "invitation_accepted"
  | "invitation_declined"
  | "agency_member_removed"
  | "agent_suspended" // Owner suspended the agent's access (temporary)
  | "agent_deactivated" // Owner deactivated the agent (access revoked)
  | "agency_pending_review" // Agency created, awaiting admin approval
  | "agency_approved"
  | "agency_rejected"
  // Agency-created visas (issue #101): sent to the owning agency's owner when
  // Seli approves or rejects the visa (or a pending edit to it), and when an
  // admin makes it global. Taking it back to agency-only sends nothing.
  | "agency_visa_approved"
  | "agency_visa_rejected"
  | "agency_visa_made_global"
  // Verification
  | "verification_approved"
  | "verification_rejected"
  // Compliance (agency KYC/KYB/payout)
  | "compliance_submitted" // Owner submitted the compliance file for review
  | "compliance_approved" // Admin verified the agency's compliance
  | "compliance_rejected" // Admin rejected; items need fixing
  // Identity verification (applicant/client KYC — NIN/BVN + optional selfie)
  | "identity_verified" // The applicant's identity check passed
  | "identity_verification_failed" // The applicant's identity check failed / needs attention
  // Account / engagement
  | "welcome"
  | "role_changed"
  // Scraper monitoring (issue #83): a new / escalated scraper alert or the
  // daily alert digest, emailed to admins only (server-side).
  | "scrape_alert"
  | "review_received"
  // Account security / self-service (mobile + portal account management)
  | "password_changed" // Security notice: the account password was just changed
  | "email_changed" // Security notice sent to the OLD address when an email change is requested
  | "account_deleted" // Confirmation that the account + data were deleted
  // Other
  | "message_received"
  // Nudge sent by email when a message has sat unread for over an hour. Distinct
  // from `message_received` (in-app/push only, fired the instant a message
  // arrives) so the two can carry different copy and different channels: this one
  // exists precisely because the real-time channels were missed.
  | "message_unread_reminder"
  | "visa_news"
  // Issue #117: an automatic pre-review run produced findings that differ from
  // the previous run. Goes to the assigned agent only, never to the applicant.
  | "assessment_insights"
  | "system";

// Delivery channels supported by the unified notifier (`notifyUser`). Each channel
// is best-effort and independent. "in_app" + "push" are delivered for real today;
// "email" + "sms" are stubbed (logged + recorded in `notificationDeliveries`) so a
// real provider (SendGrid/Twilio) can be dropped in later without changing callers.
export type NotificationChannel = "in_app" | "email" | "sms" | "push";

export interface Notification {
  id: string;
  userId: string;
  
  type: NotificationType;
  title: string;
  body: string;
  
  // Deep linking
  actionUrl?: string;
  relatedEntityType?: "application" | "consultation" | "document" | "message" | "news_article" | "payment_request" | "subscription" | "agency" | "agent" | "verification" | "review" | "visa";
  relatedEntityId?: string;
  
  // Status
  isRead: boolean;
  readAt?: Timestamp;
  
  createdAt: Timestamp;
}

// ============================================
// MESSAGE TYPES (for agent-user chat)
// ============================================

export interface Message {
  id: string;
  conversationId: string;
  senderId: string;
  senderType: "user" | "agent";
  
  content: string;
  attachmentUrls?: string[];
  
  isRead: boolean;
  readAt?: Timestamp;
  
  createdAt: Timestamp;
}

export interface Conversation {
  id: string;
  userId: string;
  agentId: string;
  applicationId?: string;

  lastMessageAt: Timestamp;
  lastMessage?: string;
  unreadCountUser: number;
  unreadCountAgent: number;

  // --- Unread-message email reminders -----------------------------------------
  // When the hourly nudge was last emailed to each side. The scheduler sends only
  // if the stamp is absent or OLDER than `lastMessageAt`, which gives exactly one
  // reminder per burst of unread messages: a later message moves `lastMessageAt`
  // forward and re-arms the nudge, while the same unread backlog never nags twice.
  // Absent on conversations that predate the feature — treated as "never sent".
  unreadReminderSentAtUser?: Timestamp;
  unreadReminderSentAtAgent?: Timestamp;

  // --- RETIRED (issue #209): per-participant chat switch from #172 -------------
  // Nothing writes these any more and nothing reads them for access decisions:
  // the PUT /conversations/:id/ai-access route is gone. Old values may still sit
  // on existing documents; they are IGNORED by the access check and stripped from
  // every API response. Kept only so those documents still type-check.
  aiAccessOffUser?: boolean;
  aiAccessOffAgent?: boolean;

  createdAt: Timestamp;
  updatedAt: Timestamp;
}

// ============================================
// DOCUMENT TEMPLATE TYPES
// ============================================
//
// The "document templates" feature (distinct from the file-upload `Document`
// above): agents clone a rich-text template from a catalog into an editable
// `DocumentInstance`, optionally linked to an application, optionally shared
// with the mobile client. Content is stored as ProseMirror JSON — an opaque
// structured document that the portal's rich-text editor round-trips.
//
// Mirrors the portal contract in japa-portal/src/types/api.ts (which uses
// `string` dates); here we use Firestore `Timestamp` and rely on the standard
// serialization (`{ _seconds, _nanoseconds }`) the portal mappers already
// handle. Kept in sync with the portal type names deliberately.

/**
 * ProseMirror JSON document. Opaque to the backend — we store and return it
 * verbatim; only the editor interprets `content`. Typed loosely so we never
 * couple the backend to a specific schema/version of the editor.
 */
export type ProseMirrorDoc = { type: "doc"; content?: unknown[] } & Record<
  string,
  unknown
>;

/** Catalog grouping for templates (drives the portal's Category column). */
export type TemplateCategory = "cover_letter" | "sop" | "affidavit" | "other";

/**
 * Ownership scope of a template:
 *   - "global": authored by Seli, visible to every agency (no `agencyId`).
 *   - "agency": authored by an agency, visible only within that agency.
 */
export type TemplateScope = "global" | "agency";

/** Lifecycle of an editable instance (agent-driven; not client-visible). */
export type DocumentInstanceStatus = "draft" | "final";

/** Whether the linked mobile client can see the instance yet. */
export type DocumentShareStatus = "private" | "shared";

/**
 * A clonable template in the catalog. `content` is only loaded on demand
 * (single-fetch with `?includeContent=true`) since it can be large; list
 * responses omit it.
 */
export interface DocumentTemplate {
  id: string;
  title: string;
  description?: string;
  category: TemplateCategory;
  scope: TemplateScope;
  agencyId?: string; // present only when scope === "agency"
  schemaVersion: number; // editor/content schema version (for future migrations)
  content?: ProseMirrorDoc; // omitted in list responses
  // Authoring: who created this template. Any agent-side user can contribute
  // templates to the shared global catalog; the creator (or an admin) may edit or
  // delete it. Absent on Seli-seeded templates (admin-managed only).
  createdBy?: string; // authoring user's uid
  createdByName?: string; // denormalized display name
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

/**
 * An editable document cloned from a template. Carries the fields the shared
 * CASL "Document" ability matches on for authorization:
 *   - `agencyId`  → agency owners manage every instance in their agency
 *   - `createdBy` → the authoring agent (surfaced to CASL as `agentId`)
 */
export interface DocumentInstance {
  id: string;
  title: string;
  templateId: string; // source template
  agencyId?: string; // owning agency (absent for independent agents)
  createdBy: string; // authoring agent's userId
  applicationId: string | null; // linked case; null until linked
  status: DocumentInstanceStatus;
  shareStatus: DocumentShareStatus;
  version: number; // optimistic-concurrency token; incremented on every save
  schemaVersion: number; // copied from the source template at clone time
  content?: ProseMirrorDoc; // omitted in list responses, present on get-one
  // Denormalized display names (avoid client-side user lookups)
  createdByName?: string;
  updatedByName?: string;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

/**
 * An immutable snapshot of an instance's content, written on each successful
 * save. Enables the editor's version history (`GET /:id/versions`). Stored in a
 * `versions` subcollection under the instance.
 */
export interface DocumentVersion {
  id: string;
  instanceId: string;
  version: number;
  updatedByName?: string; // who produced this version
  content?: ProseMirrorDoc; // the content at this version
  createdAt: Timestamp;
}

// ============================================
// AGENCY PER-VISA SERVICE PRICE (issue #103)
// ============================================

/**
 * An agency's own service price for one visa: what the AGENCY charges for
 * handling the application. Separate from the visa's government fee
 * (`VisaType.baseCostUsd`, USD), which it never reads or changes.
 *
 * Stored at `agencies/{agencyId}/visaPrices/{countryCode}__{visaTypeId}`
 * (doc id built by `agencyVisaPriceId`), one doc per visa the agency prices.
 * Keyed by the visa: `visaTypeId` plus its `countryCode`, because a visa's
 * identity is `countries/{cc}/visaTypes/{visaTypeId}` and seed ids are only
 * unique within a country. Prices are PER AGENCY: every agency (the creator
 * of a global visa included) has its own doc, so one agency's price never
 * shows on another agency's page. Backend-only: no firestore.rules match for
 * the subcollection, so clients are denied; reads go through the API.
 *
 * Supersedes the legacy `Agent.serviceFees` (never used). Contract:
 * `src/agency-visa-prices/agency-visa-prices.md`.
 */
export interface AgencyVisaPrice {
  /** Doc id: `${countryCode}__${visaTypeId}`. */
  id: string;
  /** The agency that set this price (also the parent doc). */
  agencyId: string;
  /** The priced visa: `countries/{countryCode}/visaTypes/{visaTypeId}`. */
  visaTypeId: string;
  countryCode: string;
  /**
   * The agency's service price in US DOLLARS (issue #179): `{ amountMinor:
   * <cents>, currency: "USD" }`, at most MAX_PRICE_USD_CENTS. Replaces the
   * old whole-naira `price` number.
   */
  priceUsd: Money;
  /** Audit of the naira price the #179 migration converted (never rewritten). */
  migratedFrom?: { price?: PriceMigrationRecord };
  /** Uid of the agency member who last set it. */
  updatedBy: string;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}


// ============================================
// AI MESSAGE ACCESS TYPES (issue #172)
// ============================================

/**
 * A person's express approval for intelligent analysis of the messages they
 * send. Same idea as the KYC `ConsentRecord`: who, when, which wording version
 * and the exact text shown. Stored on `aiMessageAccess/{userId}`.
 */
export interface AiMessageApproval {
  userId: string;
  grantedAt: Timestamp;
  /** Id of the wording version the person saw (see message-access/wording.ts). */
  wordingVersion: string;
  /** The exact wording stored at approval time (never the client's copy). */
  wording: string;
  ipAddress?: string;
  /** Set when the person withdraws. A revoked approval no longer counts. */
  revokedAt?: Timestamp;
}

/** The per-user AI message access document, `aiMessageAccess/{userId}`. */
export interface AiMessageAccessRecord {
  userId: string;
  /** The current approval (revoked or not); null/absent = never approved. */
  approval?: AiMessageApproval | null;
  /** Account-wide off: while true no chat of this user releases anything. */
  accountWideOff?: boolean;
  accountWideOffChangedAt?: Timestamp;
  /** One-time notice dismissal, stored on the server so it follows the person across devices. */
  noticeDismissedAt?: Timestamp;
  noticeDismissedVersion?: string;
  updatedAt: Timestamp;
}

/** What an audit record describes. */
export type AiMessageAccessAuditAction =
  | "approval_granted"
  | "approval_revoked"
  | "account_wide_off_enabled"
  | "account_wide_off_disabled";

/**
 * Actions that may be READ from old audit rows but can no longer be written
 * (the per-chat switch was retired in #209). Old rows stay in the trail.
 */
export type LegacyAiMessageAccessAuditAction = "chat_switched_off" | "chat_switched_on";

/**
 * One append-only audit record, `aiMessageAccessAudit/{id}`. Written with
 * `create()` in the same transaction as the change; the API has no update or
 * delete path. Readable only by admins.
 */
export interface AiMessageAccessAuditRecord {
  id: string;
  /** Who made the change (always the person whose setting it is). */
  actorUid: string;
  /** Whose setting changed. Equal to `actorUid` today; kept explicit for the audit reader. */
  subjectUid: string;
  action: AiMessageAccessAuditAction | LegacyAiMessageAccessAuditAction;
  /** The new value: approved / account-wide-off (or switched-off, on old chat-switch rows). */
  newValue: boolean;
  /** Old chat-switch rows only: which chat, and which side of it. */
  conversationId?: string;
  side?: "user" | "agent";
  /** Approvals only: the wording version recorded. */
  wordingVersion?: string;
  createdAt: Timestamp;
}

// Money, exchange-rate and charge-snapshot types (issue #178)
export * from "./money";

// ============================================
// Feedback (issue #257)
// ============================================

/** What the tester is reporting. */
export type FeedbackKind = "bug" | "idea";

/**
 * One in-app feedback note, stored in the backend-only `feedback` collection.
 * `userId`, `userEmail` and `role` come from the verified token, never from the
 * request body; the rest is validated client input.
 */
export interface Feedback {
  id?: string;
  userId: string;
  userEmail: string;
  role: string;
  kind: FeedbackKind;
  /** Trimmed, 1 to 2000 characters. */
  message: string;
  /** Screen the tester was on (route path only, no params), max 200 chars. */
  route: string;
  appVersion: string;
  platform: string;
  osVersion: string;
  /** App environment the build points at (dev/prod). */
  appEnv: string;
  /** Private storage key of the screenshot, or null when none was sent. */
  screenshotPath: string | null;
  /** Triage state; the team edits this in the console. */
  status: "new";
  createdAt: Timestamp;
}
