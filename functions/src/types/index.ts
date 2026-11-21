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
// #299: `VisaFeeMeta` (the fee block `computeFee` builds) is reused by `VisaSourcedFee`.
import type { VisaFeeMeta, VisaScrapeMeta } from "../scrapers/types";

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

// ============================================
// SOURCED FEE OF A SHARED ROUTE (issue #299)
// ============================================
//
// A shared route's official source can set ONE government fee for every
// member country. That fact is recorded once, on the route, in the shared
// visa data file (src/data/shared-visa-data.ts). The seed converts it to USD
// with the stored exchange rate (`appConfig/fx`, the same `computeFee` a
// scraped visa uses) and writes the whole-dollar figure as `baseCostUsd` on
// each record that inherits the route, with this block beside it so the
// figure can always be traced to the sentence and the dated rate behind it.
//
// Fields are absent (never `undefined`) when they do not apply, like
// `VisaFeeMeta`.
/**
 * Issue #339: the citation of ONE fact of a shared route a record inherits
 * (its processing time or its stay limit), shaped like `VisaSourcedFee`
 * without the conversion block. `quote` is a list because one fact can need
 * several sentences that are separate paragraphs in the source.
 */
export interface VisaSourcedFact {
  /** The shared route whose source states the fact. */
  sharedRouteId: string;
  /** The sentence(s) of the official source that state the fact, word for word, in the source's order. */
  quote: string[];
  /** The official document the quote is from (https). */
  url: string;
  /** The stored official source the quote is in (`guidanceSources/{id}`). */
  guidanceSourceId: string;
}

/**
 * Issue #339: one citation per sourced fact on a record. A key is present
 * only when the record carries that fact from a shared route:
 *   - `processing` cites `processingTime` (and `processingDaysMin` /
 *     `processingDaysMax` when the route states them),
 *   - `validity` cites `validityPeriod`.
 */
export interface VisaSourcedFacts {
  processing?: VisaSourcedFact;
  validity?: VisaSourcedFact;
}

export interface VisaSourcedFee {
  /** The shared route whose source states the fee. */
  sharedRouteId: string;
  /** The sentence of the official source that states the fee, word for word. */
  quote: string;
  /** The official document the quote is from (https). */
  url: string;
  /** The stored official source the quote is in (`guidanceSources/{id}`). */
  guidanceSourceId: string;
  /** Optional: the published rule the quote was read from. */
  ruleRef?: { routeKey: string; version: number; criterionId: string };
  /**
   * The conversion, exactly as `computeFee` returned it: the fee in its source
   * currency (`components`, `totals`), the unrounded `totalUsd`, and the rate
   * used (`fxRateToUsd`, `fxDate`, `fxSource`). `baseCostUsd` on the record is
   * `Math.round(fee.totalUsd)`.
   */
  fee: VisaFeeMeta;
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

  // Issue #299: where `baseCostUsd` comes from when it is the government fee
  // of a shared route this record inherits (see `VisaSourcedFee` below).
  // Written and removed ONLY by the countries/visas seed, together with
  // `baseCostUsd`; absent on every record whose fee has another origin.
  sourcedFee?: VisaSourcedFee;

  // Issue #339: where `processingTime` / `processingDaysMax` and
  // `validityPeriod` come from when they are facts of a shared route this
  // record inherits (see `VisaSourcedFacts` below). Written and removed ONLY
  // by the countries/visas seed, together with the fields they cite; absent
  // on every record whose facts have another origin.
  sourcedFacts?: VisaSourcedFacts;

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
 * deletes this doc; reject sets `reviewStatus: "rejected"` + reason and
 * empties `changes`, so a rejected edit can never go live later, #154). See
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
  // Issue #237 (P8 of #228): on a SHARED-route application, the shared route's
  // name at creation (kept current by PUT /applications/:id/through-country).
  // `countryName` stays the country applied through. ABSENT otherwise.
  routeName?: string;

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

/** Issue #321: how a consultation was booked (see `Consultation.bookedVia`). */
export type ConsultationBookedVia = "client" | "agent" | "public_page";

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

  // Issue #321: HOW the booking was made, written once at creation and never
  // changed. It decides whether an UNPAID booking proves that the client
  // chose this agent (see `isClientOfAgent` in consultation.controller.ts):
  //  - "client":      the client booked it themselves while signed in
  //                   (client flow of POST /consultations). Counts as a
  //                   relationship even when free or still unpaid.
  //  - "agent":       an agent or owner booked it for the client (agent flow
  //                   of POST /consultations). Counts only once PAID.
  //  - "public_page": a guest booked it on an agency's public page by typing
  //                   an email (POST /agencies/public/:slug/consultations).
  //                   Anyone can type anyone's email, so it counts only once
  //                   PAID.
  // Absent on bookings made before #321: those count only once paid (no
  // backfill; nothing had been released to real users).
  bookedVia?: ConsultationBookedVia;

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
  // Issue #405: when the agent side last MOVED this booking while it was
  // unpaid (`PUT /consultations/:id` changing the slot of a
  // `pending_payment` booking). The abandoned-booking sweep's 24-hour payment
  // grace runs from the LATER of this and `quoteExpiresAt`, so a booking
  // moved after its quote lock gives the client the full 24 hours to pay for
  // the new time. Absent on a booking never moved while unpaid.
  paymentGraceStartsAt?: Timestamp;

  // ---- Issue #411: abandoned-booking sweep bookkeeping ----
  // Issue #411: how many times the agent side MOVED this booking while it was
  // unpaid, each one restarting its payment grace (#405). Only counted (no
  // cap, orchestrator decision 2026-11-21); shown on the admin sweep-review
  // list. Absent until the first such move.
  graceRestartCount?: number;
  // Issue #411: true once the sweep has SET ASIDE this booking (it stayed
  // unresolved for SWEEP_SET_ASIDE_AFTER_RUNS runs): the sweep's query no
  // longer selects it, so it stops taking a batch slot, and it is listed for
  // admins (`GET /consultations/sweep-review`). Written `false` when a
  // pending_payment booking is created, because Firestore's equality filter
  // never matches a MISSING field (rows made before #411 get it from
  // `npm run backfill:sweep-lane`). Cleared by a reschedule, by the sweep's
  // release pass when the booking's checkouts or grace change, and by an
  // admin re-check that finds nothing in flight any more.
  sweepSetAside?: boolean;
  // Issue #411: what the sweep last learned about this booking (sweep-owned;
  // see `ConsultationSweepReview`). Never read by the money paths.
  sweepReview?: ConsultationSweepReview;
  // Issue #411 (decision 2026-11-21, from #391): when the one-time pay link
  // emailed to a GUEST (`bookedVia: "public_page"`) after an agent-side move
  // expires. #391 sets it (the link itself lives in `consultationPayLinks`).
  // The sweep's payment grace for a guest booking runs until the later of
  // the normal grace and this, never past the slot start.
  payLinkExpiresAt?: Timestamp;

  // After consultation
  summary?: string;
  recordingUrl?: string;
  
  // Cancellation
  cancelledAt?: Timestamp;
  cancelledBy?: string;
  cancellationReason?: string;

  // Refund (issue #317). Set when a refund row is written for this booking's
  // fee (on a refundable cancel, or by an admin), and kept in step with that
  // row's status by the refund engine (services/consultation-refund.service.ts).
  // The booking's `paymentStatus` stays "paid": the client DID pay, and the
  // #321 relationship check reads it. The refund is its own Transaction.
  /** Doc id of the refund Transaction (`refund_<sha256 of the Paystack reference>`, see refundDocId). */
  refundId?: string;
  /** Mirror of the refund Transaction's status. */
  refundStatus?: RefundStatus;
  /**
   * Issue #413 (portal design #357): mirror of the refund row's
   * `refundHeldReason` while the refund is HELD for an admin, so a held
   * refund does not read as a plain "failed" one. Removed when the refund is
   * worked out (or closed: `refundStatus: "closed"` then says so).
   */
  refundHeldReason?: RefundHeldReason;
  /**
   * Issue #382: mirror of the booking's "the meeting didn't happen" report
   * (`noShowReports/{bookingId}`), written in the same commit as the report
   * and its resolution. What the client view shows (`noShowReport`); the
   * admin-facing details stay on the report doc.
   */
  noShowReport?: ConsultationNoShowReportMirror;
  
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

/** Issue #382: where a no-show report stands. */
export type NoShowReportStatus =
  /** Reported, waiting for an admin; the agent's fee is frozen. */
  | "open"
  /** An admin decided the agent did not show: full refund, the agent pays Paystack's fee. */
  | "refunded"
  /** An admin decided the meeting happened: no refund, the fee follows its normal release. */
  | "released";

/** Issue #382: what an admin decided about a no-show report (no default). */
export type NoShowReportDecision = "agent_no_show" | "meeting_happened";

/** Issue #382: the booking's copy of its no-show report (see `Consultation.noShowReport`). */
export interface ConsultationNoShowReportMirror {
  status: NoShowReportStatus;
  createdAt: Timestamp;
  resolvedAt?: Timestamp;
}

/**
 * Issue #382: a client's report that a PAID consultation did not happen,
 * made while the agent's fee is still held. ONE per booking, at the
 * deterministic id `noShowReports/{consultationId}` (`tx.create`). Backend
 * only (firestore.rules denies every client). Nothing happens
 * automatically: an admin decides (`NoShowReportDecision`).
 */
export interface NoShowReport {
  /** = the booking id. */
  id: string;
  consultationId: string;
  /** The booking's client (who reported). */
  clientId: string;
  /** The booking's agent (whose fee is frozen). */
  agentId: string;
  agencyId?: string;
  /** Denormalised for the admin list. */
  clientName?: string;
  agentName?: string;
  /** The booking's settled consultation_fee Transaction (frozen by this report). */
  feeTransactionId: string;
  /** What the client paid: minor units of `currency` (the fee row's own figures). */
  amountMinor: number;
  currency: string;
  /** When the slot started (as it stood when reported). */
  slotStartAt: Timestamp;
  /** The client's note, if any (at most NO_SHOW_NOTE_MAX_LENGTH characters). */
  note?: string;
  status: NoShowReportStatus;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  /** Set when an admin decides. */
  decision?: NoShowReportDecision;
  resolvedAt?: Timestamp;
  resolvedBy?: string;
  /** The refund row written for `agent_no_show`. */
  refundId?: string;
}

// ============================================
// Abandoned-booking sweep bookkeeping (issue #411)
// ============================================

/**
 * Why a sweep run (or an admin re-check) left a booking unresolved:
 *  - `in_progress`: a checkout is still in progress at Paystack (a bank
 *    transfer may still land);
 *  - `review`:      a paid checkout could not be applied or recorded by
 *    `settlePayment` (wrong amount, ...): a human must look;
 *  - `lookup_failed`: asking Paystack failed (network, 5xx, 401);
 *  - `not_found`:   Paystack answered "not found" for a reference it
 *    generated itself (fail closed: never cancelled on that answer);
 *  - `error`:       anything else failed while handling the booking;
 *  - `too_many_checkouts`: more references than one run may look up.
 */
export type SweepUnresolvedOutcome =
  | "in_progress"
  | "review"
  | "lookup_failed"
  | "not_found"
  | "error"
  // The booking carries more checkout references than one run may look up
  // (SWEEP_MAX_LOOKUPS_PER_RUN), so the sweep can never check them all
  // before a cancel: counted, so it is set aside for an admin (whose
  // actions have no run budget).
  | "too_many_checkouts";

/**
 * The last known state of ONE checkout reference of a booking, as the sweep
 * recorded it:
 *  - `final_unpaid`:   final at Paystack and unpaid (failed, abandoned, or
 *                      one of OUR references Paystack never saw). FINAL;
 *  - `paid_handled`:   paid, and `settlePayment` recorded it as an exception
 *                      and refunded it (#354). FINAL;
 *  - `paid_confirmed`: paid, and it confirmed the booking. FINAL;
 *  - `paid_review`:    paid, but `settlePayment` could not apply or record it;
 *  - `in_progress`:    still in progress at Paystack;
 *  - `lookup_failed` / `not_found`: the lookup failed (see above).
 * A FINAL reference is never looked up again by the sweep.
 */
export type SweepCheckoutKnownState =
  | "final_unpaid"
  | "paid_handled"
  | "paid_confirmed"
  | "paid_review"
  | "in_progress"
  | "lookup_failed"
  | "not_found";

/** One checkout reference as recorded by the sweep (issue #411). */
export interface SweepCheckoutRecord {
  /** The Paystack reference. */
  reference: string;
  /** Its last known state. */
  state: SweepCheckoutKnownState;
  /** True when that state can no longer change (no further lookups). */
  final: boolean;
  /** When the sweep (or an admin re-check) learned it. */
  checkedAt: Timestamp;
  /** The `settlePayment` outcome kind, when the reference was settled. */
  settleOutcome?: string;
}

/**
 * The sweep's bookkeeping on one booking (issue #411), written only by the
 * sweep and the admin sweep-review actions, never by a money path.
 */
export interface ConsultationSweepReview {
  /** Consecutive runs that left the booking unresolved, for the same `fingerprint`. */
  unresolvedRuns: number;
  /** Why the last unresolved run left it. */
  lastOutcome?: SweepUnresolvedOutcome;
  /** When that run was. */
  lastRunAt?: Timestamp;
  /**
   * The booking's checkouts and grace when the counter was last written
   * (`sweepFingerprint`). A booking whose fingerprint changed (re-priced,
   * rescheduled, a new pay link) starts its count again.
   */
  fingerprint: string;
  /** When the booking was set aside (absent when it is not). */
  setAsideAt?: Timestamp;
  /** Last known state of each checkout reference the sweep has seen. */
  checkouts: SweepCheckoutRecord[];
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
  /**
   * Issue #354: set when the checkout was RETIRED because its booking was
   * rescheduled (`PUT /consultations/:id` moved a `pending_payment` booking
   * after its quote lock). Such a checkout was issued for the OLD slot, so a
   * payment that lands on it later never confirms the booking: `settlePayment`
   * records it as `paid_for_rescheduled_slot` and refunds it in full.
   * Absent on a checkout replaced by an ordinary re-price.
   */
  retiredBy?: "reschedule";
  /**
   * Issue #354 review fix (fix round, 2026-11-17): the booking's `agentId`
   * at the moment the reschedule retired this checkout, i.e. the agent whose
   * move caused a later payment on it to be refunded. Paystack's fee on that
   * refund is debited from THIS agent, not from whoever holds the booking
   * when the payment lands (the case may be reassigned in between): whoever
   * caused it pays. Entries retired before this field existed have none; the
   * debit then falls back to the booking's agent at settle time.
   */
  retiredByAgentId?: string;
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
  /**
   * Why the payment cannot be applied:
   *  - "paid_on_superseded_reference_after_booking_paid": a second charge on
   *    a booking another reference had already paid;
   *  - "booking_not_payable": paid after the booking stopped awaiting
   *    payment (cancelled while the payer was paying);
   *  - "paid_for_rescheduled_slot" (issue #354): paid on a checkout that was
   *    retired when the booking was rescheduled after its quote lock.
   */
  reason: "paid_on_superseded_reference_after_booking_paid" | "booking_not_payable" | "paid_for_rescheduled_slot";
  /**
   * Issue #354: every exception is refunded in full, automatically, through
   * the #317 refund engine. `open` while that refund is on its way (or for an
   * exception recorded before #354 that has no refund yet); `refunded` once
   * Paystack reports it processed; `refund_failed` once the engine gave up
   * (the refund row is `failed` and listed for an admin retry, which moves
   * this back to `open`). Also `refund_failed`, with NO refund row, while the
   * refund is held for an admin (`refundFailureReason`).
   *
   * Issue #354 fix round: `nothing_to_refund` once an admin has CLOSED a
   * client-caused exception whose Paystack fee is the whole charge or more
   * (`refundFailureReason: "fee_not_less_than_amount"`): under the fee rule
   * the client is owed nothing, so there is no refund row, no Paystack call
   * and no Transaction. A closed exception is final: it leaves the admin
   * list and a later settle of the same reference never reopens it.
   */
  status: "open" | "refunded" | "refund_failed" | "nothing_to_refund";
  /**
   * Issue #354: the refund Transaction's doc id (`refundDocId(reference)`),
   * written in the SAME Firestore transaction as this record.
   */
  refundId?: string;
  /**
   * Issue #354 (decision 2026-11-16): Paystack's processing fee on THIS
   * charge, in minor units of `currency`, exactly as Paystack reported it for
   * the reference (`data.fees` of verify / `charge.success`, or a fresh
   * lookup). Never estimated. Absent while Paystack has not reported a
   * well-formed figure: the refund is then held (`refundFailureReason:
   * "paystack_fee_unknown"`).
   */
  paystackFeeMinor?: number;
  /**
   * Issue #354: why the refund is HELD for an admin with no refund row
   * written (`status: "refund_failed"`):
   *  - "paystack_fee_unknown": Paystack's data for the reference has no
   *    well-formed `fees`, so who-pays-what cannot be worked out. Nothing is
   *    guessed; an admin retry re-reads the reference at Paystack;
   *  - "fee_not_less_than_amount": a client-caused refund where Paystack's
   *    fee is the whole charge or more, so nothing is left to refund.
   * Cleared once the refund row is written.
   */
  refundFailureReason?: "paystack_fee_unknown" | "fee_not_less_than_amount";
  /**
   * Issue #354: the agent's fee-debit Transaction (`feeDebitDocId(reference)`)
   * of an agent-caused refund (`paid_for_rescheduled_slot`), written in the
   * SAME Firestore transaction as the refund row. Absent for client-caused
   * refunds and when Paystack's fee was 0.
   */
  feeDebitId?: string;
  /**
   * Issue #354 fix round: the agent who CAUSED an agent-caused exception
   * (`paid_for_rescheduled_slot`), and so pays Paystack's fee: the
   * `retiredByAgentId` of the retired checkout that was paid (the booking's
   * agent when it was moved). Falls back to the booking's `agentId` at
   * settle time for a checkout retired before that field existed. Fixed the
   * first time the exception is planned, so a held refund retried later still
   * debits the same agent. Absent for client-caused exceptions.
   */
  causedByAgentId?: string;
  /** Issue #354 fix round: when an admin closed it as `nothing_to_refund`. */
  closedAt?: Timestamp;
  /** Issue #354 fix round: the admin (uid) who closed it as `nothing_to_refund`. */
  closedBy?: string;
  createdAt: Timestamp;
  /** Last change of `status` / `refundId` (absent until the first change). */
  updatedAt?: Timestamp;
}

/**
 * Issue #391: a one-time "pay again" link for a GUEST booking
 * (`bookedVia: "public_page"`) whose payment on a checkout retired by a
 * reschedule was refunded (`paid_for_rescheduled_slot`, #354). Emailed to
 * the guest so they can pay for the new time without signing in.
 *
 * Collection `consultationPayLinks`, doc id = the hex SHA-256 of the raw
 * token. The RAW token is never stored, logged or returned by any API: it
 * exists only in the email. Backend only: firestore.rules denies every
 * client (see services/consultation-pay-link.service.ts).
 *
 * A link is LIVE while `usedAt` and `supersededAt` are null and `expiresAt`
 * is in the future, AND its booking is still `pending_payment`. Anything
 * else is dead and every pay-link route answers the same 410.
 */
export interface ConsultationPayLink {
  /** The doc id: hex SHA-256 of the raw token (also kept in `tokenHash`). */
  id: string;
  /** Hex SHA-256 of the raw token, compared in constant time on every lookup. */
  tokenHash: string;
  /** The ONE booking this link can pay for. */
  consultationId: string;
  /** The booking's agency, and its public slug at mint time (the link's path). */
  agencyId: string;
  agencySlug: string;
  /** The Paystack reference of the refunded payment that caused this link. */
  exceptionId: string;
  createdAt: Timestamp;
  /** The earlier of 72 h after minting and the booking's slot start. */
  expiresAt: Timestamp;
  /** Set (in the same transaction) when a payment confirmed the booking. */
  usedAt: Timestamp | null;
  /** The Paystack reference of the payment that used it up. */
  usedByReference?: string;
  /** Set when a newer link for the same booking was minted (at most one live link). */
  supersededAt: Timestamp | null;
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
  /**
   * Issue #393: Paystack's processing fee on this reference, in minor units
   * of `currency`, exactly as Paystack reported it at settlement. Stored only
   * when it was a well-formed fee (`isWellFormedFee`) reported in the charge
   * currency; absent otherwise (unknown: never estimated, never 0 by
   * default). Written once with the record and never changed.
   *
   * For the human who refunds it. Decision (user, 2026-11-19): paying a
   * request that is no longer payable is CLIENT-caused (the #354 rule), so
   * the client is refunded `amountMinor - paystackFeeMinor` and the agent is
   * not charged. When these refunds are automated, they must use this stored
   * fee and #354's `feeDebitDocId(reference)` with `tx.create` for any fee
   * row, so the fee is never taken twice for one reference.
   */
  paystackFeeMinor?: number;
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
  | "withdrawal"
  // Issue #354 (decision 2026-11-16): Paystack's processing fee on a refunded
  // payment the AGENT side caused (a reschedule after the quote lock, then
  // the client paid the old checkout), taken from the agent's balance. An
  // outflow: lowers revenue and the available balance of its currency from
  // the moment it is written, never `heldBalance`; may take it below zero.
  // Never shown to the client.
  | "paystack_fee_debit"
  // Issue #413 (mismatch resolution, decision 2026-11-21): an adjustment of
  // the AGENT's balance when an admin resolves a refund Paystack paid in a
  // different amount than planned. `amount` > 0 with `adjustmentDirection`
  // ("credit": the agent gets it, "debit": it is taken). Settled when
  // written (`completed`); counts in revenue and the available balance of its
  // currency, never `heldBalance`. One per reference
  // (`mismatchAdjustmentDocId`, `tx.create`). Never shown to the client.
  | "refund_adjustment";

export type TransactionStatus = 
  | "pending"
  | "processing"
  | "completed"
  | "failed"
  | "refunded"
  | "held_in_escrow"
  | "released"
  // Issue #413 (B): a HELD consultation refund an admin closed with nothing
  // to refund (client-caused, Paystack's fee >= the charge). Final: never
  // settled, counted in no balance and no revenue, never sent to Paystack.
  | "closed";

// ============================================
// CONSULTATION REFUNDS AND FEE HOLDS (issue #317)
// ============================================

/**
 * Why a consultation fee was refunded (issue #317). The first two come from a
 * cancel (`PUT /consultations/:id/status`), the `admin_*` ones from the admin
 * endpoint `POST /consultations/:id/refund`.
 */
export type RefundReason =
  | "agent_cancelled"
  | "client_cancelled"
  | "admin_agent_no_show"
  | "admin_goodwill"
  | "admin_other"
  // Issue #354: an automatic refund of a payment that could not be applied
  // to its booking (a `consultationPaymentExceptions` record).
  | "payment_not_applied";

/**
 * Where a refund row stands (issue #317). It only ever moves forward:
 * `pending` (row written, Paystack not yet accepted) -> `processing`
 * (Paystack accepted it) -> `completed` (Paystack `refund.processed`, final),
 * or `failed` (Paystack `refund.failed`, or our retries ran out). Only an
 * admin retry moves a `failed` row back to `pending`, and it re-uses the
 * SAME row.
 */
export type RefundStatus = Extract<TransactionStatus, "pending" | "processing" | "completed" | "failed" | "closed">;

/**
 * Issue #413 (A): why a LIVE refund row (not a held one) was flagged
 * `failed` for an admin by the engine itself, rather than by Paystack:
 *  - "provider_refund_mismatch": Paystack already holds a refund for the
 *    charge that is not failed, but whose amount or currency is not the
 *    row's (or is missing), e.g. a manual refund made in the Paystack
 *    dashboard. It is NOT adopted (it may not be ours to adopt) and NO new
 *    refund is created (a second refund on the same charge could pay the
 *    client twice). The agent's fee stays where the refund left it (frozen
 *    for the admin's decision).
 */
export type RefundFailureReason = "provider_refund_mismatch";

/**
 * Issue #413 (A): the Paystack refund found for a charge that did NOT match
 * the row (see RefundFailureReason). Stored exactly as Paystack reported it;
 * a field Paystack did not report is null (never guessed).
 */
export interface ProviderRefundMismatch {
  /** Paystack's refund id. */
  id: string;
  /** Paystack's amount, in minor units of `currency`, or null when not reported. */
  amountMinor: number | null;
  /** Paystack's upper-case currency code, or null when not reported. */
  currency: string | null;
  /** Paystack's own status of that refund ("pending", "processed", ...). */
  status: string;
  /** When the engine saw it. */
  seenAt: Timestamp;
}

/**
 * Issue #413 (B): the outcome an admin closed a held consultation refund
 * with (the row is then `closed`). Only one today.
 */
export type RefundClosedOutcome = "nothing_to_refund";

/**
 * Where the money of a refund comes from (issue #317, #351 reversal):
 *  - "hold": the fee was still HELD (the meeting had not happened yet), so
 *    the refund is paid out of that held fee; the agent's available balance
 *    does not move and the agent never had the money;
 *  - "available": the fee had already been RELEASED to the agent (admin
 *    override only), so the refund comes off the agent's available balance,
 *    which may go below zero (withdrawals are then blocked until it is back
 *    above zero). Seli never absorbs the shortfall;
 *  - "unapplied_payment" (issue #354): the refund of a payment that never
 *    confirmed the booking (a `consultationPaymentExceptions` record). No
 *    fee Transaction was written for it, so nothing was ever credited to the
 *    agent: the refund touches neither the agent's balances nor revenue, and
 *    the row carries no `agentId` at all. The money given back is exactly
 *    the money that came in on that reference.
 */
export type RefundFundedFrom =
  | "hold"
  | "available"
  | "unapplied_payment"
  // Issue #413 (mismatch resolution): the TOP-UP refund sent when Paystack
  // refunded less than planned and the admin put the gap on the agent. The
  // agent already gave back the planned amount on the original row, so the
  // top-up is neutral for the agent's balances and revenue: it is money Seli
  // was holding for the client, sent on to them.
  | "mismatch_top_up";

/**
 * Issue #413 (mismatch resolution): what an admin decided for a refund row
 * flagged `provider_refund_mismatch`, stored on that row (it is then final).
 * X is what Paystack really refunded (read from Paystack, `processed`), P
 * what the row planned for the client. Minor units of the row's currency.
 */
export interface RefundMismatchResolution {
  /** Who carries the difference (no default). */
  carriedBy: PaystackFeeBorneBy;
  /** Paystack's refund that was adopted (its id, as read from Paystack). */
  providerRefundId: string;
  /** X. */
  refundedMinor: number;
  /** P. */
  plannedMinor: number;
  /** The top-up refund row (`mismatchTopUpDocId`), when one was sent (X < P, agent). */
  topUpRefundId?: string;
  /** G = P - X, when a top-up was sent. */
  topUpMinor?: number;
  /** The agent's adjustment row (`mismatchAdjustmentDocId`), when one was written. */
  adjustmentId?: string;
  /** Signed effect of that adjustment on the agent (+ credit, - debit), 0 when none. */
  agentAdjustmentMinor: number;
  resolvedBy: string;
  resolvedAt: Timestamp;
}

/**
 * Issue #390 (decision 2026-11-16, "whoever caused the refund carries
 * Paystack's fee"): who carries Paystack's processing fee on a consultation
 * refund. Paystack keeps its fee when a charge is refunded; Seli never does.
 *  - "client": the client caused it (`client_cancelled`, or an admin
 *    goodwill / other refund with `feeBorneBy: "client"`): they get back the
 *    amount charged minus Paystack's fee;
 *  - "agent": the agent side caused it (`agent_cancelled`,
 *    `admin_agent_no_show`, or an admin refund with `feeBorneBy: "agent"`):
 *    the client gets everything back and the agent carries the fee once.
 */
export type PaystackFeeBorneBy = "client" | "agent";

/**
 * Issue #390: why a consultation refund is HELD for an admin, with no
 * Paystack call and no agent debit (the row is `failed`, amount 0):
 *  - "paystack_fee_unknown": neither the fee Transaction nor a fresh
 *    Paystack lookup gives a well-formed fee for the reference;
 *  - "fee_not_less_than_amount": a client-caused refund whose Paystack fee is
 *    the whole charge or more (nothing left to give back).
 */
export type RefundHeldReason = "paystack_fee_unknown" | "fee_not_less_than_amount";

/**
 * The hold on a consultation fee (issue #317, "hold consultation fees").
 * Stored on the fee Transaction (`type: "consultation_fee"`) as `feeHold`.
 *
 * A paid fee is HELD (not withdrawable) until the meeting has happened:
 *  - released at `releaseAt` (slot end + 24 hours) by the clock alone, or
 *  - earlier, once the booking is marked `completed` (or the client
 *    `no_show`) AND the slot has started (`meetingClosedAt` set and the clock
 *    past `slotStartAt`). A booking marked complete before its slot even
 *    started keeps its hold until the slot starts.
 * `state` only ever records the two events the clock cannot see:
 *  - "held": nothing happened yet (release is worked out from the times);
 *  - "released": released for good (the legacy backfill writes this);
 *  - "refunded": the held fee was refunded to the client (the refund row's
 *    `refundFundedFrom` is "hold"); it is never released to the agent.
 * The clock rule lives in ONE function, `feeHoldStatusAt` (money/fee-hold.ts).
 */
export interface FeeHold {
  state: "held" | "released" | "refunded";
  /** The slot start the hold was last computed for (only ever moves LATER). */
  slotStartAt: Timestamp;
  /** When the fee releases by itself: slot end + 24 hours (only ever moves LATER). */
  releaseAt: Timestamp;
  /** When the booking was marked completed / no_show (agent side). */
  meetingClosedAt?: Timestamp;
  /** When the hold was ended for good (`state` "released" or "refunded"). */
  endedAt?: Timestamp;
  /** What ended it: a refund, or the one-off legacy backfill. */
  endedBy?: "refund" | "legacy_backfill";
}

/**
 * Issue #395: where Paystack's fee on a consultation fee Transaction stands.
 *  - "known": Paystack reported a well-formed fee in the charge currency,
 *    below the amount charged. The agent is credited `amount - fee` under
 *    the normal hold rules;
 *  - "unknown": Paystack reported no well-formed fee in the charge currency
 *    (missing, null, negative, a string, a fraction, another currency). The
 *    booking is confirmed (the client paid), but the row is credited NOWHERE
 *    (not held, not available, not revenue) until the fee is known. The
 *    scheduled job and the admin refresh look it up again;
 *  - "fee_not_less_than_amount": Paystack's fee is the whole charge or more,
 *    so the credit would be zero or negative. The fee is stored, nothing is
 *    credited automatically, and the row is listed for an admin.
 */
export type PaystackFeeStatus =
  | "known"
  | "unknown"
  | "fee_not_less_than_amount"
  // Issue #413 (D): an "unknown" row the scheduled lookup job gave up on
  // after PAYSTACK_FEE_MAX_JOB_LOOKUPS answered lookups. It counts EXACTLY
  // as "unknown" everywhere (credited nowhere, nothing guessed), the job no
  // longer picks it (so it cannot starve newer rows), it is listed for
  // admins (`GET /transactions?role=admin&type=consultation_fee&paystackFeeStatus=set_aside`)
  // and the admin refresh (and a refund's own lookup) still resolve it.
  | "set_aside";

/** Issue #395: what stored Paystack's fee on a consultation fee Transaction. */
export type PaystackFeeResolvedBy = "settle" | "job" | "admin_refresh" | "refund";

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

  // ---- Issue #317: the hold on a consultation fee (type "consultation_fee") ----
  /** See `FeeHold`. Absent on a fee written before #317 (counted as held until backfilled). */
  feeHold?: FeeHold;
  /**
   * Issue #390 (orchestrator decision 2026-11-19): set while a refund of this
   * fee is HELD for an admin (`refundHeldReason` on that refund row, whose id
   * this is). The fee is FROZEN: it counts as held whatever the clock or a
   * closed meeting says (`feeHoldStatusAt`), so it is never available or
   * withdrawable, and the legacy hold backfill never stamps it. Cleared when
   * the admin retry works the refund out (it is then refunded out of the hold).
   */
  feeHoldFrozenByRefundId?: string;
  /** Issue #390: when the fee was frozen (see `feeHoldFrozenByRefundId`). */
  feeHoldFrozenAt?: Timestamp;
  /**
   * Issue #382: set while the booking's client has an OPEN "the meeting
   * didn't happen" report (`noShowReports/{id}`, this is its id). The fee is
   * FROZEN: held whatever the clock or a closed meeting say, so it is never
   * available or withdrawable until an admin decides. Removed when they do.
   */
  feeHoldFrozenByReportId?: string;
  /** Issue #382: when the report froze the fee. */
  feeHoldFrozenByReportAt?: Timestamp;

  // ---- Issue #395: Paystack's fee on a consultation fee (type "consultation_fee") ----
  // Issue #393: the same fields, statuses and rules apply to a paid payment
  // request (type "escrow_release"): the agent pays Paystack's fee there too.
  // Decision (user, 2026-11-17): on a paid consultation the AGENT pays
  // Paystack's fee. `amount` stays what the client was charged (A); the agent
  // is credited A - F, where F is Paystack's own `fees` for this reference in
  // the charge currency. F is never estimated, never a rate, never a default.
  // All three fields are absent on a fee written before #395 (a LEGACY row):
  // it keeps counting as A (money/paystack-fee.ts `consultationFeeCredit`).
  /**
   * Paystack's processing fee on this charge, in minor units of `currency`,
   * exactly as Paystack reported it. Set when `paystackFeeStatus` is "known"
   * or "fee_not_less_than_amount"; absent while it is "unknown".
   */
  paystackFeeMinor?: number;
  /** Where Paystack's fee for this charge stands (see PaystackFeeStatus). */
  paystackFeeStatus?: PaystackFeeStatus;
  /**
   * What the agent is credited: `amount - paystackFeeMinor`, in minor units
   * of `currency`. Set only when `paystackFeeStatus` is "known" (shown to
   * the agent side next to the fee; the balances recompute it from the fee).
   */
  agentCreditMinor?: number;
  /** When Paystack's fee was stored (at settle, or later by the job / an admin refresh / a refund). */
  paystackFeeResolvedAt?: Timestamp;
  /** What stored Paystack's fee (see PaystackFeeResolvedBy). */
  paystackFeeResolvedBy?: PaystackFeeResolvedBy;
  /**
   * Issue #413 (D): how many scheduled-job lookups answered without a usable
   * fee for this row. At PAYSTACK_FEE_MAX_JOB_LOOKUPS the row is set aside
   * (`paystackFeeStatus: "set_aside"`). A lookup Paystack could not answer
   * (outage) does not count.
   */
  paystackFeeLookupAttempts?: number;
  /** Issue #413 (D): when the job set the row aside. */
  paystackFeeSetAsideAt?: Timestamp;

  // ---- Issue #317: a consultation refund (type "refund") ----
  // Refund rows are written by the backend only (firestore.rules deny every
  // client). `amount` + `currency` equal the refunded fee's, in minor units.
  /** Doc id of the consultation_fee Transaction this refund gives back. */
  refundOf?: string;
  /**
   * Issue #354: on the refund of a payment that could not be applied, the
   * `consultationPaymentExceptions` doc id it refunds (= the Paystack
   * reference). The refund engine mirrors the row's status onto THAT record,
   * never onto the booking (whose `refundId` / `refundStatus` belong to the
   * booking's own fee).
   *
   * Also set on a `paystack_fee_debit` row (issue #354): the exception whose
   * Paystack fee it debits the agent for.
   */
  paymentExceptionId?: string;
  /** Why it was refunded. */
  reason?: RefundReason;
  /** Uid of who started it (the cancelling user, or the admin). */
  initiatedBy?: string;
  /** The admin's note (required for reason `admin_other`). */
  refundNote?: string;
  /** Held fee or available balance (see RefundFundedFrom). */
  refundFundedFrom?: RefundFundedFrom;
  /**
   * #351: when a released fee is refunded, how far the refund took the
   * agent's available balance below zero (minor units of `currency`), at the
   * moment the row was written. 0 when the balance covered it. Admin-visible.
   */
  balanceShortfallMinor?: number;
  /**
   * Issue #354: on the refund of a CLIENT-caused unapplied payment, the part
   * of the charge Paystack kept as its processing fee (minor units of
   * `currency`). `amount` + this = what the client was charged, so Seli
   * carries none of it.
   */
  paystackFeeKeptMinor?: number;
  // ---- Issue #390: Paystack's fee on a consultation refund ----
  /**
   * Who carries Paystack's fee on this refund (see PaystackFeeBorneBy). Set
   * on every consultation refund row written since #390 (live or held).
   * (Also `paystackFeeMinor`, declared with the #395 fields above: on a
   * refund row it is Paystack's fee on the refunded charge, the value the
   * refund was worked out with, from the fee Transaction or a fresh lookup.)
   */
  feeBorneBy?: PaystackFeeBorneBy;
  /**
   * How much this refund row takes off the AGENT, in minor units of
   * `currency` (issue #390): what `availableBalance` (from the moment it is
   * written, `refundFundedFrom: "available"`) and `totalRevenue` (once
   * settled) lose. It can differ from `amount` (what the client gets back):
   *  - out of the hold: the fee's whole credit (A - F, or A on a legacy row);
   *  - from available: the larger of the refund and the credit (an older
   *    full-credit row refunded on the client's fault gives back A while the
   *    client gets A - F, user decision 2026-11-17).
   * Absent on rows written before #390: `amount` is used, as before.
   */
  agentReversalMinor?: number;
  /**
   * Issue #390: set while the refund is HELD for an admin (see
   * RefundHeldReason). Such a row is `failed`, has `amount` 0 (no figure is
   * ever guessed), no `refundFundedFrom`, and counts nowhere; it is never
   * sent to Paystack. An admin retry re-reads the fee and, once known,
   * rewrites the row under the rule (the field is then removed).
   */
  refundHeldReason?: RefundHeldReason;
  /**
   * Issue #390: on a refund row, the agent's `paystack_fee_debit` written
   * with it (`feeDebitDocId(reference)`); on a `paystack_fee_debit`, the
   * refund row it belongs to (`refundId`).
   */
  feeDebitId?: string;
  /** Issue #390: on a `paystack_fee_debit` of a consultation refund, that refund row's id. */
  refundId?: string;
  /**
   * Paystack's id of the refund, once Paystack has one. Issue #383: the
   * row's CURRENT attempt: every refund the engine creates or adopts for the
   * row replaces it, so only that attempt's webhooks move the row.
   */
  providerRefundId?: string;
  /**
   * Issue #383: Paystack refund ids of the row's EARLIER attempts (replaced
   * by a newer one, or retired by an admin retry of a failed row). Their
   * webhooks are still recognised as ours, but change nothing.
   */
  previousProviderRefundIds?: string[];
  /** Paystack's own refund status as last seen ("pending", "processed", ...). */
  providerRefundStatus?: string;
  /** How many times the engine has tried (claimed) the Paystack call. */
  refundAttempts?: number;
  /**
   * How many times a Paystack create-refund call was really STARTED for
   * this row. Above 0, any further try first looks the refund up at
   * Paystack (a call may have gone through before a crash or a timeout).
   */
  refundProviderCalls?: number;
  /** When a pending row is next due for a retry (the 15-minute job reads it). */
  refundNextAttemptAt?: Timestamp;
  /** While set in the future, another worker is talking to Paystack for this row. */
  refundLeaseUntil?: Timestamp;
  /** The last error from Paystack, for admins. */
  refundLastError?: string;
  /**
   * Issue #381: when the row last ENTERED `processing` (Paystack accepted
   * it). The processing poll picks rows that have sat there longer than
   * REFUND_PROCESSING_POLL_AFTER_MINUTES. Rows that entered processing before
   * #381 have none and are picked by `updatedAt` instead.
   */
  processingSince?: Timestamp;
  /** When Paystack reported the refund processed. */
  refundedAt?: Timestamp;
  /** When the row became `failed`. */
  refundFailedAt?: Timestamp;
  /**
   * Issue #413 (A): why the ENGINE flagged a live row `failed` for an admin
   * (see RefundFailureReason). Removed by an admin retry (set again when the
   * same check fails again).
   */
  refundFailureReason?: RefundFailureReason;
  /**
   * Issue #413 (A): the Paystack refund that did not match this row (kept
   * after a retry, as history and so the client is told it is delayed only
   * once per such refund).
   */
  providerRefundMismatch?: ProviderRefundMismatch;
  /** Issue #413 (B): when an admin closed this held refund (status `closed`). */
  refundClosedAt?: Timestamp;
  /** Issue #413 (B): the admin who closed it. */
  refundClosedBy?: string;
  /** Issue #413 (B): what it was closed as. */
  refundClosedOutcome?: RefundClosedOutcome;
  // ---- Issue #413: resolving a mismatch-flagged refund ----
  /** On the flagged row once an admin resolved it (see RefundMismatchResolution). */
  refundMismatchResolution?: RefundMismatchResolution;
  /** On a resolved row whose `amount` was set to what Paystack refunded: the amount it planned. */
  plannedAmountMinor?: number;
  /** On a top-up refund row: the original refund row it completes. */
  refundTopUpOf?: string;
  /**
   * On a top-up refund row: Paystack refund ids of the same charge that are
   * NOT this row's (the original refund, earlier attempts). The engine and
   * the poll never adopt or match them.
   */
  refundTopUpExcludes?: string[];
  /** On a `refund_adjustment`: whether the agent is credited or debited `amount`. */
  adjustmentDirection?: "credit" | "debit";

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
  // Self-service applicant notices (issue #266). Sent ONLY for an application the
  // applicant runs alone (see `isSelfServiceApplication`); agent cases keep their
  // agent-side notices. All four set relatedEntityType "application" and
  // relatedEntityId = the application id, so the mobile app can open it.
  | "readiness_review_ready" // The readiness review finished (in_app + push + email)
  | "document_check_problems" // An upload check found something to fix
  | "document_check_could_not_check" // An upload was saved but could not be checked
  | "document_check_passed" // An upload check passed (in_app only)
  // Refusal-letter analysis finished (issue #268), self-service only, in_app + push.
  // relatedEntityType "application", relatedEntityId = the application id,
  // data.analysisId = the analysis. No reason text from the letter in the copy.
  | "refusal_analysis_ready"
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
  // Issue #317: a consultation fee was refunded (client: "on its way"; agent:
  // the fee was given back), and a refund that is delayed (failed at Paystack).
  | "consultation_refunded"
  | "consultation_refund_delayed"
  // Issue #382: a client reported a paid meeting did not happen (agent: the
  // payment is paused; client: confirmation), and an admin decided it.
  | "consultation_no_show_reported"
  | "consultation_no_show_resolved"
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

/** Issue #321: which side opened a conversation (see `Conversation.startedBy`). */
export type ConversationStartedBy = "user" | "agent";

export interface Conversation {
  id: string;
  userId: string;
  agentId: string;
  applicationId?: string;

  // Issue #321: WHICH SIDE opened the conversation, written once when it is
  // created and never changed. "user" = the client opened it themselves;
  // "agent" = the agent side (or the backend on the agent's behalf, e.g. when
  // an agent creates an application) opened it. An agent can open a
  // conversation with any uid, so only a "user"-started conversation, or one
  // the client has sent a message in, proves the client knows the agent (see
  // `isClientOfAgent` in consultation.controller.ts). Absent on conversations
  // made before #321: those count only through the client-message check.
  startedBy?: ConversationStartedBy;

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

// ============================================
// SAVED DESTINATIONS (issue #146)
// ============================================
//
// A client "saves" a destination (one visa in one country) with the heart on
// its screen. Each save is ONE document under the user:
//   users/{uid}/savedDestinations/{COUNTRYCODE}_{visaId}
// Backend only (firestore.rules denies every client read and write); the app
// goes through GET / PUT / DELETE /users/me/saved-destinations.

/**
 * The stored save. It holds only the key and the time: the visa's name, fee
 * and so on are read from the visa when the list is served, so a tile never
 * shows stale data and a visa that is hidden later drops out of the list.
 */
export interface SavedDestination {
  /** ISO 3166-1 alpha-2, always UPPER CASE ("GB"), whatever case was sent. */
  countryCode: string;
  /** Id of the visa: countries/{countryCode}/visaTypes/{visaId}. */
  visaId: string;
  /** When the user first saved it. Saving again does not move it. */
  savedAt: Timestamp;
}

/**
 * The part of a visa a destination tile draws. An allow-list on purpose: the
 * saved list never returns a visa's internal fields (review state, scrape
 * provenance, owning agency...). The names match `VisaType`, so the mobile
 * tile mapper takes this object as it takes a visa.
 */
export interface SavedDestinationVisa {
  id: string;
  /** UPPER CASE, same as the item's `countryCode`. */
  countryCode: string;
  name: string;
  description: string;
  category: VisaCategory;
  /** Display text, e.g. "3 weeks". */
  processingTime: string;
  /** Government fee in US dollars. */
  baseCostUsd: number;
  /** Percent, or null when not known. */
  successRate: number | null;
  /** Null when not counted yet. */
  totalApplications: number | null;
  /** Where the visa record came from ("scraped", "agency"...), or null for a seed. */
  source: VisaType["source"] | null;
}

/** One saved destination as the API returns it (list item and PUT result). */
export interface SavedDestinationItem extends SavedDestination {
  /** The country's display name ("United Kingdom"); the code when the country record is missing. */
  countryName: string;
  /** What the tile needs, read from the visa at request time. */
  visa: SavedDestinationVisa;
}
