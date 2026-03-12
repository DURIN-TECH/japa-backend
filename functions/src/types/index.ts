import { Timestamp } from "firebase-admin/firestore";

// Re-export eligibility types
export * from "./eligibility";

// Re-export news types
export * from "./news";

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

  // Approval status
  status: AgencyStatus;
  rejectionReason?: string;
  reviewedBy?: string; // Admin userId who approved/rejected
  reviewedAt?: Timestamp;

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

export interface Application {
  id: string;
  userId: string;
  visaTypeId: string;
  countryCode: string;

  // Mode
  mode: ApplicationMode;
  agentId?: string;
  agencyId?: string; // Cases belong to the agency, not the individual agent

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
  | "application_update"
  | "document_status"
  | "consultation_reminder"
  | "payment_received"
  | "payment_request"
  | "payment_request_rejected"
  | "message_received"
  | "visa_news"
  | "system";

export interface Notification {
  id: string;
  userId: string;
  
  type: NotificationType;
  title: string;
  body: string;
  
  // Deep linking
  actionUrl?: string;
  relatedEntityType?: "application" | "consultation" | "document" | "message" | "news_article" | "payment_request";
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
