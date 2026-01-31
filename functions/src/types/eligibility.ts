import { Timestamp } from "firebase-admin/firestore";

// ============================================
// VISA EXEMPTION / REQUIREMENT MATRIX
// ============================================

export type VisaRequirementType =
  | "visa_free"           // No visa needed
  | "visa_on_arrival"     // Can get visa at border
  | "eta"                 // Electronic Travel Authorization (e.g., Canada eTA)
  | "evisa"               // Online visa application
  | "visa_required";      // Must apply at embassy/consulate

export interface VisaExemption {
  id: string;
  nationality: string;         // ISO country code of passport holder
  destinationCountry: string;  // ISO country code of destination

  requirementType: VisaRequirementType;

  // For visa-free / visa on arrival
  maxStayDays?: number;        // e.g., 90 days
  purposesAllowed?: string[];  // ["tourism", "business", "transit"]

  // Conditions
  conditions?: string[];       // e.g., "Must have return ticket", "Passport valid 6 months"

  // For work/study, usually still need visa
  workPermitRequired: boolean;
  studyPermitRequired: boolean;

  // Source and validity
  source?: string;             // Where this info came from
  lastVerified?: Timestamp;
  validFrom?: Timestamp;
  validUntil?: Timestamp;

  createdAt: Timestamp;
  updatedAt: Timestamp;
}

// ============================================
// ELIGIBILITY QUESTIONS
// ============================================

export type QuestionType =
  | "boolean"      // Yes/No
  | "single"       // Single choice from options
  | "multiple"     // Multiple choice
  | "number"       // Numeric input
  | "date"         // Date input
  | "text";        // Free text

export type QuestionScope =
  | "common"                              // All visas
  | `country:${string}`                   // Destination country (e.g., "country:IE")
  | `category:${string}`                  // Visa category (e.g., "category:work")
  | `nationality:${string}`               // Applicant nationality (e.g., "nationality:NG")
  | `nationality:${string}:${string}`     // Nationality + destination (e.g., "nationality:NG:IE")
  | `visa:${string}`;                     // Specific visa type ID

export interface EligibilityQuestion {
  id: string;
  visaTypeId?: string;  // Optional - for visa-specific questions

  // Scoping - determines when this question applies
  scope: QuestionScope;

  // For nationality-specific, which nationalities
  applicableNationalities?: string[];  // If set, only show to these nationalities
  excludedNationalities?: string[];    // If set, hide from these nationalities

  // Question content
  question: string;
  description?: string;
  helpText?: string;     // Additional guidance
  type: QuestionType;
  options?: string[];    // For single/multiple choice

  // Scoring
  weight: number;        // How much this affects the score (0-100)
  correctAnswers?: string[];  // Answers that score full points
  partialAnswers?: string[];  // Answers that score partial points

  // For numeric questions
  minValue?: number;
  maxValue?: number;
  idealMin?: number;
  idealMax?: number;
  unit?: string;         // e.g., "months", "years", "USD"

  // Recommendations when answer is wrong
  failRecommendation?: string;

  // Display
  orderIndex: number;
  isRequired: boolean;
  isActive: boolean;

  // Dependencies - show this question only if...
  dependsOn?: {
    questionId: string;
    expectedAnswer: string | string[];
  };

  createdAt: Timestamp;
  updatedAt: Timestamp;
}

// ============================================
// ELIGIBILITY CHECK RESULTS
// ============================================

export interface EligibilityAnswer {
  questionId: string;
  answer: string | string[] | number | boolean;
}

export interface EligibilityCheckInput {
  visaTypeId: string;
  countryCode: string;       // Destination country
  nationality: string;       // Applicant's nationality
  travelPurpose?: string;    // tourism, business, work, study, etc.
  answers: EligibilityAnswer[];
}

export interface EligibilityBreakdownItem {
  questionId: string;
  question: string;
  answer: string;
  passed: boolean;
  points: number;
  maxPoints: number;
  recommendation?: string;
}

export interface EligibilityCheck {
  id: string;
  userId: string;
  visaTypeId: string;
  countryCode: string;
  nationality: string;

  // Pre-check result
  visaRequired: boolean;
  visaRequirementType: VisaRequirementType;
  exemptionDetails?: {
    maxStayDays?: number;
    conditions?: string[];
  };

  // If visa required, the eligibility score
  score: number;  // 0-100
  eligibilityLevel: "high" | "medium" | "low" | "not_applicable";

  // Detailed breakdown
  answers: EligibilityAnswer[];
  breakdown: EligibilityBreakdownItem[];

  // Recommendations
  recommendations: string[];
  missingRequirements: string[];

  // Actions
  suggestedPath: "self_service" | "agent_assisted" | "not_eligible" | "visa_free";

  createdAt: Timestamp;
}

export interface EligibilityResult {
  // Pre-check
  visaRequired: boolean;
  visaRequirementType: VisaRequirementType;
  exemptionDetails?: {
    maxStayDays?: number;
    conditions?: string[];
    purposesAllowed?: string[];
  };

  // Score (only if visa required)
  score: number;
  eligibilityLevel: "high" | "medium" | "low" | "not_applicable";

  breakdown: EligibilityBreakdownItem[];
  recommendations: string[];
  missingRequirements: string[];
  suggestedPath: "self_service" | "agent_assisted" | "not_eligible" | "visa_free";
}

// ============================================
// PRE-CHECK (before full eligibility)
// ============================================

export interface VisaPreCheckInput {
  nationality: string;
  destinationCountry: string;
  travelPurpose: "tourism" | "business" | "work" | "study" | "family" | "transit" | "other";
  intendedStayDays?: number;
}

export interface VisaPreCheckResult {
  visaRequired: boolean;
  requirementType: VisaRequirementType;

  // If visa free
  maxStayDays?: number;
  conditions?: string[];

  // If visa required
  recommendedVisaTypes?: Array<{
    id: string;
    name: string;
    description: string;
    processingTime: string;
    baseCostUsd: number;
  }>;

  // Warnings
  warnings?: string[];  // e.g., "Your stay exceeds visa-free limit"

  // Next steps
  nextSteps: string[];
}
