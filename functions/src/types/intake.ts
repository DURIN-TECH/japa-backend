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
import type { IntakeMeta, IntakeQuestion, RulebookStackLayer } from "./rubric";

/** The saved answers, as stored on the application document. */
export interface ApplicationIntake {
  /** `${countryCode}_${visaTypeId}` of the rubric the answers were given against. */
  routeKey: string;
  /** Approved rubric version at the time of the save. (#233) On a multi-layer stack: the own layer's version (0 when it has none). */
  rubricVersion: number;
  /** (#233) Multi-layer stack only: rulebook key -> approved version at the time of the save (null = missing layer). */
  layerVersions?: Record<string, number | null>;
  /**
   * questionId -> answer. Shapes by answerType:
   *   single_choice: string (an option value)    multi_choice: string[]
   *   yes_no: boolean                            date: "YYYY-MM-DD"
   *   date_range: { from, to } (both YYYY-MM-DD) text: string
   *   amount: { amount: number, currency: "GBP" }
   * Only answers to VISIBLE questions are stored.
   */
  answers: Record<string, unknown>;
  /**
   * (#235) Answers SET ASIDE when the country applied through changed before
   * submission: their question is not part of the new route's rulebook. Kept,
   * never deleted, never validated or served as answers; every later save
   * carries them over. Absent when nothing was set aside.
   */
  orphanedAnswers?: OrphanedIntakeAnswer[];
  updatedAt: Timestamp;
}

/** (#235) One answer set aside (see `ApplicationIntake.orphanedAnswers`). */
export interface OrphanedIntakeAnswer {
  questionId: string;
  value: unknown;
  /** The rulebook the answer was given against, when known. */
  routeKey?: string;
  rubricVersion?: number;
  setAsideAt: Timestamp;
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
  /**
   * (#233) Only for a route whose rulebook is a STACK of more than one layer
   * (a shared bloc / treaty layer plus the country's own): every layer, with
   * the approved version served or `missing`, so the client can say which
   * layer has no rulebook yet. The questions above are the union of the
   * approved layers' questions, each asked once. Absent for every other route.
   */
  layers?: RulebookStackLayer[];
}
