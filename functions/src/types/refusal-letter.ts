import type { Timestamp } from "firebase-admin/firestore";
import type { CriterionKind } from "./rubric";

// ============================================
// REFUSAL-LETTER ANALYSIS — stored record (issue #122)
// ============================================
//
// `refusalAnalyses/{id}` is both the job record and the result, like
// `applicationAssessments` (#42). Written by the worker only; read through the
// `/ai/refusal-letters` routes and the whitelist serializer
// (services/ai/refusal-letter-serializer.ts), never by clients directly.
//
// What the MODEL contributes is values only: the references the letter cites,
// the letter's own words for each reason, the decision date, the visa type it
// names, and the name / date of birth printed on it. Everything else here
// (matching, framing, the deception flag, the checklist) is decided in code.

/** Lifecycle of the job. */
export type RefusalAnalysisStatus = "queued" | "running" | "succeeded" | "failed";

/**
 * What the reading produced, once the job has run:
 *  - `analysed`              the letter was read and reasons were extracted
 *  - `unreadable`            "we could not read this": nothing is shown as fact
 *  - `not_a_refusal_letter`  readable, but it is not a refusal decision
 */
export type RefusalOutcome = "analysed" | "unreadable" | "not_a_refusal_letter";

/** A rubric criterion matched to a cited reference. Every field comes from the rubric. */
export interface RefusalRuleMatch {
  criterionId: string;
  title: string;
  kind: CriterionKind;
  ruleRef: string;
  sourceUrl: string;
  sourceQuote: string;
  // How the cited reference met the rubric's: the same paragraph, or the letter
  // cited a sub-paragraph of the paragraph the rubric holds.
  matchType: "exact" | "parent";
  // Code-chosen. A judgement criterion is something to strengthen, never a
  // restated refusal (containment from #42).
  framing: "requirement" | "strengthen";
}

/** One reason the letter gives. */
export interface RefusalReason {
  reasonId: string;
  // The letter's own wording, verbatim as the model reported it (sanitised, capped).
  letterQuote: string;
  // The references the letter cites for this reason, as printed.
  citedRefs: string[];
  page: number | null;
  // Empty = "not matched to our guidance".
  matches: RefusalRuleMatch[];
  // True when the reason is a deception ground (decided in code from the
  // criterion's own source text and the letter's wording). No do-it-yourself
  // fix list is shown for it.
  deception: boolean;
}

/** A warning shown to the applicant. Never a block. */
export interface RefusalWarning {
  code: "name_mismatch" | "dob_mismatch";
}

/** One reapplication-checklist line. NOT a DocumentRequest: nothing is created until confirmed. */
export interface RefusalChecklistItem {
  checklistItemId: string;
  title: string;
  holder: "applicant" | "sponsor";
  required: boolean;
  reason: string;
  citation: { quote: string; url: string; ruleRef?: string };
  // The matched criterion ids this item is asked for.
  addressesCriterionIds: string[];
}

export interface RefusalChecklist {
  state: "ready" | "intake_needed" | "no_checklist" | "not_built";
  emptyReason?: string;
  items: RefusalChecklistItem[];
}

export interface RefusalAnalysis {
  id: string;
  userId: string; // the applicant (the application's owner)
  agencyId: string | null;
  applicationId: string;
  documentId: string;
  countryCode: string;
  visaTypeId: string;
  // Approved rubric version used, or null when the route had none.
  rubricVersion: number | null;
  status: RefusalAnalysisStatus;
  error: { code: string; message: string } | null;
  outcome: RefusalOutcome | null;
  requestedBy: string;
  createdAt: Timestamp;
  startedAt: Timestamp | null;
  finishedAt: Timestamp | null;

  // ---- extracted values (the model's whole contribution) ----
  decisionDate: string | null; // as written on the letter
  visaTypeNamed: string | null; // as written on the letter
  reasons: RefusalReason[];
  warnings: RefusalWarning[];
  // Code-side flag: the letter's text addressed a reader model. For operators;
  // never shown to the applicant.
  suspiciousContent: boolean;

  // ---- derived in code ----
  checklist: RefusalChecklist;
  // Derived lists kept for operators and later queries (design 3.8).
  matchedCriterionIds: string[];
  unmatchedReasonIds: string[];

  model: string | null;
  promptVersion: string;
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number } | null;
}
