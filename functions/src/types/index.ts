import { Timestamp } from "firebase-admin/firestore";
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
export * from "./visa-catalog";
// Local import so VisaType (below) can reference the scrape provenance shape.
// Type-only, so the visa-catalog <-> index cycle is erased at compile time.
import type { VisaScrapeMeta } from "./visa-catalog";

// ============================================
// USER TYPES
// ============================================

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

  // Metadata
  createdAt: Timestamp;
  updatedAt: Timestamp;
  lastLoginAt?: Timestamp;
  fcmTokens?: string[]; // For push notifications
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
  price: number; // In cents
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
  ownerId: string; // userId of the creator/owner
  ownerName: string; // Denormalized for display

  // Profile
  address?: string;
  state?: string;
  description?: string;
  logoUrl?: string;

  // Pricing
  consultationFee?: number; // In cents (agency-level default)

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

  // Pricing
  consultationFee: number; // In cents
  serviceFees: Record<string, number>; // visaTypeId -> fee in cents

  // Availability
  isAvailable: boolean;
  availableSlots?: AvailabilitySlot[];

  // Metadata
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

  // Official application
  applicationUrl?: string; // URL to official online application form (e.g., AVATS for Ireland)
  applicationInstructions?: string; // Brief instructions for completing official application

  // Provenance (set when a value comes from the visa-catalog scraper + approval).
  // Note: the `source` flag lives in the "Admin review" block below.
  sourceUrl?: string; // official URL this record was last verified against
  lastVerifiedAt?: Timestamp; // when an agent last approved a scraped update
  scrapeMeta?: VisaScrapeMeta; // extractor provenance + per-field citations (audit trail)

  // Stats
  successRate?: number;
  totalApplications?: number;

  // Availability
  isActive: boolean;
  quotaLimit?: number;
  currentQuotaUsed?: number;

  // Agents who handle this visa
  agentIds: string[];

  // Admin review
  reviewStatus?: "pending_review" | "approved" | "rejected";
  source?: "scraped" | "agent";
  reviewedBy?: string;
  reviewedAt?: Timestamp;
  rejectionReason?: string;

  createdAt: Timestamp;
  updatedAt: Timestamp;
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
  
  // Financial
  totalCost: number; // In cents
  amountPaid: number;
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

  createdAt: Timestamp;
  updatedAt: Timestamp;
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

export interface Document {
  id: string;
  applicationId: string;
  requirementId: string;
  userId: string;
  
  // File info
  fileName: string;
  fileType: string;
  fileSizeMb: number;
  storageUrl: string;
  
  // Status
  status: DocumentStatus;
  
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

export interface Consultation {
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
  fee: number; // In cents
  paymentStatus: PaymentStatus;
  transactionId?: string;
  
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

export interface Transaction {
  id: string;
  userId: string;
  agentId?: string;
  applicationId?: string;
  consultationId?: string;
  
  // Payment details
  type: TransactionType;
  amount: number; // In cents
  currency: string;
  
  // Status
  status: TransactionStatus;
  
  // Escrow (for milestone-based payments)
  isEscrow: boolean;
  escrowReleaseCondition?: string;
  escrowReleasedAt?: Timestamp;
  
  // Payment processor
  paymentProvider: "stripe" | "paypal" | "manual";
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

export interface PaymentRequest {
  id: string;
  applicationId: string;
  agentId: string;
  agencyId?: string;
  clientId: string;

  // Denormalized
  clientName: string;
  clientEmail: string;

  // Payment details
  amount: number; // In smallest currency unit (kobo/cents)
  currency: string;
  description: string;
  category: PaymentRequestCategory;

  // Status
  status: PaymentRequestStatus;
  paidAt?: Timestamp;
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
  // Verification
  | "verification_approved"
  | "verification_rejected"
  // Compliance (agency KYC/KYB/payout)
  | "compliance_submitted" // Owner submitted the compliance file for review
  | "compliance_approved" // Admin verified the agency's compliance
  | "compliance_rejected" // Admin rejected; items need fixing
  // Account / engagement
  | "welcome"
  | "role_changed"
  | "review_received"
  // Other
  | "message_received"
  | "visa_news"
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
  relatedEntityType?: "application" | "consultation" | "document" | "message" | "news_article" | "payment_request" | "subscription" | "agency" | "agent" | "verification" | "review";
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
