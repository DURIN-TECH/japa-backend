// ============================================
// APPLICATION INTAKE — TYPES (issue #113)
// ============================================
//
// The intake is a list of questions a ROUTE needs answered before it can be
// assessed. The questions are DATA owned by the approved visa rubric
// (`visaRubrics/{countryCode}_{visaTypeId}`, issue #40); the answers are stored
// on the application as `Application.intake`.
//
// DEPENDENCY ON UNMERGED WORK: the full rubric types live in `types/rubric.ts`
// on the #40 branch (not on `dev` yet). This file declares ONLY the minimal
// read-side shape #113 needs, mirroring #40's `IntakeQuestion` / `IntakeMeta`
// field for field. When #40 merges, replace the `Rubric*` interfaces below
// with `import type { IntakeQuestion, IntakeMeta } from "./rubric"`.
//
// Generic by design: nothing here (or in the service built on it) names a
// country, a route, a nationality or a visa type.

import type { Timestamp } from "firebase-admin/firestore";

/** Answer types the renderer and the validator understand. */
export const INTAKE_ANSWER_TYPES = [
  "single_choice",
  "multi_choice",
  "yes_no",
  "date",
  "date_range",
  "text",
  "amount",
] as const;
export type IntakeAnswerType = (typeof INTAKE_ANSWER_TYPES)[number];

/** One selectable option of a choice question (mirrors #40). */
export interface IntakeOption {
  value: string;
  label: string;
  description?: string;
}

/** One "show this question when..." condition (mirrors #40). */
export interface IntakeCondition {
  questionId: string;
  op: "eq" | "neq" | "in";
  value: string | number | boolean | string[];
}

/**
 * One intake question as stored on the rubric (mirrors #40's `IntakeQuestion`).
 *
 * Two OPTIONAL fields go beyond #40's shape (`maxLengthDays`, `currencies`):
 * the design spec for #113 asks for them and the renderer degrades safely
 * without them. They are read if the rubric carries them; #40/#112 decide
 * whether to add them to the schema.
 */
export interface IntakeQuestion {
  id: string;
  label: string;
  helpText?: string;
  /** Plain string: a rubric may carry a type this version doesn't know. */
  answerType: string;
  required: boolean;
  criterionIds: string[];
  group?: string;
  party?: "applicant" | "sponsor";
  options?: IntakeOption[];
  dateLimits?: { min?: string; max?: string; relativeToToday?: "past_only" | "future_only" };
  textLimits?: { minLength?: number; maxLength?: number };
  showWhen?: { anyOf: IntakeCondition[] };
  /** date_range: longest allowed range, in days (beyond #40). */
  maxLengthDays?: number;
  /** amount: allowed ISO 4217 codes (beyond #40). Any code when absent. */
  currencies?: string[];
}

/** Headings of the intake section as a whole (mirrors #40's `IntakeMeta`). */
export interface IntakeMeta {
  title?: string;
  cardTitle?: string;
  intro?: string;
}

/** The saved answers, as stored on the application document. */
export interface ApplicationIntake {
  /** `${countryCode}_${visaTypeId}` of the rubric the answers were given against. */
  routeKey: string;
  /** Approved rubric version at the time of the save. */
  rubricVersion: number;
  /**
   * questionId -> answer. Shapes by answerType:
   *   single_choice: string (an option value)    multi_choice: string[]
   *   yes_no: boolean                            date: "YYYY-MM-DD"
   *   date_range: { from, to } (both YYYY-MM-DD) text: string
   *   amount: { amount: number, currency: "GBP" }
   * Only answers to VISIBLE questions are stored.
   */
  answers: Record<string, unknown>;
  updatedAt: Timestamp;
}

/**
 * What GET /applications/:id/intake returns. `available: false` means the
 * route has no approved rubric with intake questions: the client shows no
 * intake step at all (no fallback questions, ever).
 */
export interface IntakeResponse {
  available: boolean;
  /** False once the application is past the editable statuses (read-only). */
  editable: boolean;
  routeKey: string | null;
  /** Approved rubric version the questions come from. */
  rubricVersion: number | null;
  meta: IntakeMeta;
  questions: IntakeQuestion[];
  answers: Record<string, unknown>;
  /** ISO-8601 of the last save, or null when nothing was saved yet. */
  updatedAt: string | null;
  /** Rubric version the saved answers were given against (null if unsaved). */
  savedRubricVersion: number | null;
  /** Ids of required, visible, unanswered questions (in question order). */
  openRequiredIds: string[];
  /** ISO-8601 of the last assessment (#42). Always null until #42 ships. */
  lastReviewAt: string | null;
}
