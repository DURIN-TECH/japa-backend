import { Timestamp } from "firebase-admin/firestore";

import type { EntryRequirementResult } from "./entry-requirements";

// ============================================
// VISA REQUIREMENT TYPES (pre-check answer)
// ============================================
//
// Issue #236: the hand-seeded `visaExemptions` matrix (and its `VisaExemption`
// row type) is RETIRED: its rows had no verbatim quote. The pre-check now
// answers from sourced entry rules (types/entry-requirements.ts) and says
// `unknown` when there is no official source, never "visa required" by default.

export type VisaRequirementType =
  | "visa_free"           // No visa needed (the official source says so)
  | "visa_on_arrival"     // Can get visa at border
  | "eta"                 // Electronic travel authorisation (entry outcome `travel_authorisation`)
  | "evisa"               // Online visa application (kept for stored checks; not produced since #236)
  | "visa_required"       // Must hold a visa (the official source says so)
  | "unknown";            // (#236) No official source for this trip: never a guess

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

export type TravelPurpose = "tourism" | "business" | "work" | "study" | "family" | "transit" | "other";

export interface EligibilityCheckInput {
  visaTypeId: string;
  countryCode: string;       // Destination country
  nationality: string;       // Applicant's nationality
  travelPurpose?: TravelPurpose;
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

  // Pre-check result. (#236) `null` when no official source answered it.
  visaRequired: boolean | null;
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
  travelPurpose: TravelPurpose;
  intendedStayDays?: number;
}

export interface VisaPreCheckResult {
  // (#236) `null` when there is no official source for the trip (`status:
  // "unknown"`): never guessed as true or false.
  visaRequired: boolean | null;
  requirementType: VisaRequirementType;
  // (#236) Whether the answer rests on an official source.
  status: "answer" | "unknown";
  // (#236) The full sourced answer from GET /entry-requirements (quotes, URLs,
  // stay, conditions; or the unknown reason and the official page).
  entryRequirement: EntryRequirementResult;

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
