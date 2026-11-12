// ============================================
// APPLICATION INTAKE — TYPES (issue #113)
// ============================================
//
// The intake is a list of questions a ROUTE needs answered before it can be
// assessed. The questions are DATA owned by the approved visa rubric
// (`visaRubrics/{countryCode}_{visaTypeId}`, issue #40); the answers are stored
// on the application as `Application.intake`.
//
// INTEGRATION: #113 was built before #40 was on its base, so it carried a copy
// of the rubric intake types. The copy is gone: the question types are #40's
// (`types/rubric.ts`) and are re-exported here so existing imports keep working.
//
// Generic by design: nothing here (or in the service built on it) names a
// country, a route, a nationality or a visa type.

import type { Timestamp } from "firebase-admin/firestore";

export { INTAKE_ANSWER_TYPES } from "./rubric";
export type { IntakeAnswerType, IntakeOption, IntakeCondition, IntakeQuestion, IntakeMeta } from "./rubric";
import type { IntakeMeta, IntakeQuestion } from "./rubric";

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
