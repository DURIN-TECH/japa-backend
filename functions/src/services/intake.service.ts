// ============================================
// INTAKE SERVICE (issue #113)
// ============================================
//
// Reads the intake questions of an application's route from the APPROVED
// rubric and validates / stores the applicant's answers on the application.
//
// Rules (from the AI integration technical design, section 3.6):
//  - Question ids, types, options and required flags come ONLY from the
//    approved rubric's `intakeQuestions`. Nothing is hardcoded per country,
//    route or nationality, and there is no fallback question list: no
//    approved rubric (or one without intake questions) means "no intake".
//  - Unknown question ids are rejected; answers are validated per type.
//  - Answers to questions hidden by `showWhen` are dropped, never stored.
//  - Missing required answers NEVER block a save (a draft is allowed); they
//    are reported as `openRequiredIds`.
//  - Free-text answers are personal data: never logged here.
//
// DEPENDENCY: reads `visaRubrics` directly because the rubric store from #40
// is not on `dev` yet. Same paths as #40's `rubric.store.ts`
// (head `visaRubrics/{routeKey}`, version `rubricVersions/{version}`); swap
// `loadApprovedIntake` for the store call when #40 merges.

import { Timestamp } from "firebase-admin/firestore";
import { collections, db } from "../utils/firebase";
import { Application, ApplicationStatus } from "../types";
import {
  ApplicationIntake,
  IntakeCondition,
  IntakeMeta,
  IntakeQuestion,
  IntakeResponse,
} from "../types/intake";

// ============================================
// Constants
// ============================================

/**
 * Statuses in which the applicant may still change their answers. From
 * `under_review` onward the application is read-only (orchestrator decision
 * on #113).
 */
export const INTAKE_EDITABLE_STATUSES: readonly ApplicationStatus[] = [
  "draft",
  "pending_payment",
  "pending_documents",
];

/** Hard caps so a client cannot store an unbounded document. */
const MAX_TEXT_LENGTH = 2000; // used when the question declares no maxLength
const MAX_MULTI_CHOICE = 50;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const CURRENCY_CODE = /^[A-Z]{3}$/;

// ============================================
// Errors
// ============================================

/** A rejected answer. `message` names the question so a client can show it. */
export class IntakeValidationError extends Error {
  constructor(
    public readonly questionId: string,
    message: string
  ) {
    super(message);
    this.name = "IntakeValidationError";
  }
}

// ============================================
// Rubric lookup
// ============================================

interface ApprovedIntake {
  routeKey: string;
  version: number;
  meta: IntakeMeta;
  questions: IntakeQuestion[];
}

/**
 * The approved rubric's intake for a route, or null when there is no
 * approved version or it carries no questions.
 */
async function loadApprovedIntake(
  countryCode: string,
  visaTypeId: string
): Promise<ApprovedIntake | null> {
  const routeKey = `${countryCode}_${visaTypeId}`;
  const head = await db.collection("visaRubrics").doc(routeKey).get();
  const approved = head.exists ? head.data()?.approvedVersion : null;
  if (typeof approved !== "number") return null;

  const versionDoc = await db
    .collection("visaRubrics")
    .doc(routeKey)
    .collection("rubricVersions")
    .doc(String(approved))
    .get();
  if (!versionDoc.exists) return null;
  const data = versionDoc.data() ?? {};

  // Belt and braces: only ever serve a version a human approved.
  if (data.reviewStatus !== "approved") return null;

  const questions = Array.isArray(data.intakeQuestions)
    ? (data.intakeQuestions as IntakeQuestion[])
    : [];
  if (questions.length === 0) return null;

  return { routeKey, version: approved, meta: (data.intake as IntakeMeta) ?? {}, questions };
}

// ============================================
// Visibility (showWhen)
// ============================================

function conditionHolds(cond: IntakeCondition, answers: Record<string, unknown>): boolean {
  const actual = answers[cond.questionId];
  switch (cond.op) {
    case "eq":
      return actual === cond.value;
    case "neq":
      // An unanswered question is not "different from" the value: stay hidden.
      return actual !== undefined && actual !== null && actual !== cond.value;
    case "in":
      return Array.isArray(cond.value) && typeof actual === "string" && cond.value.includes(actual);
    default:
      return false;
  }
}

/**
 * Which questions are visible given the answers. Evaluated IN ORDER, and a
 * hidden question's answer does not count for later conditions, so hiding
 * cascades down a follow-up chain.
 */
function visibleAnswers(
  questions: IntakeQuestion[],
  answers: Record<string, unknown>
): { visibleIds: Set<string>; effective: Record<string, unknown> } {
  const visibleIds = new Set<string>();
  const effective: Record<string, unknown> = {};
  for (const q of questions) {
    const any = q.showWhen?.anyOf;
    const visible = !any || any.length === 0 || any.some((c) => conditionHolds(c, effective));
    if (visible) {
      visibleIds.add(q.id);
      if (answers[q.id] !== undefined) effective[q.id] = answers[q.id];
    }
  }
  return { visibleIds, effective };
}

/** True when an answer counts as "not answered". */
function isBlank(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === "string") return value.trim() === "";
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "object") {
    // date_range / amount: every part must be present.
    return Object.values(value as Record<string, unknown>).some(
      (v) => v === undefined || v === null || v === ""
    );
  }
  return false;
}

/** Required, visible, unanswered question ids, in question order. */
function openRequired(questions: IntakeQuestion[], answers: Record<string, unknown>): string[] {
  const { visibleIds, effective } = visibleAnswers(questions, answers);
  return questions
    .filter((q) => q.required && visibleIds.has(q.id) && isBlank(effective[q.id]))
    .map((q) => q.id);
}

// ============================================
// Per-type validation
// ============================================

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Days between two YYYY-MM-DD dates (to - from). */
function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);
}

/** A real calendar date in YYYY-MM-DD form (rejects 2027-02-31). */
function isRealDate(value: unknown): value is string {
  if (typeof value !== "string" || !ISO_DATE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

/** Check one date against the question's declared limits. Throws a plain reason. */
function checkDateLimits(q: IntakeQuestion, value: string): string | null {
  const lim = q.dateLimits;
  if (!lim) return null;
  const today = todayIso();
  if (lim.relativeToToday === "future_only" && value < today) return "that date has passed";
  if (lim.relativeToToday === "past_only" && value > today) return "that date is in the future";
  if (lim.min && value < lim.min) return "that date is too early";
  if (lim.max && value > lim.max) return "that date is too late";
  return null;
}

/**
 * Validate one answer against its question and return the value to store.
 * Throws `IntakeValidationError` naming the question. `null` / blank answers
 * are handled by the caller (they clear the answer).
 */
function validateAnswer(q: IntakeQuestion, raw: unknown): unknown {
  const fail = (why: string): never => {
    throw new IntakeValidationError(q.id, `${q.label}: ${why}`);
  };

  switch (q.answerType) {
    case "single_choice": {
      const allowed = (q.options ?? []).map((o) => o.value);
      if (typeof raw !== "string" || !allowed.includes(raw)) return fail("choose one of the options");
      return raw;
    }
    case "multi_choice": {
      const allowed = (q.options ?? []).map((o) => o.value);
      if (!Array.isArray(raw) || raw.length > MAX_MULTI_CHOICE) return fail("choose from the options");
      if (!raw.every((v) => typeof v === "string" && allowed.includes(v))) {
        return fail("choose from the options");
      }
      return Array.from(new Set(raw as string[]));
    }
    case "yes_no": {
      if (typeof raw !== "boolean") return fail("answer yes or no");
      return raw;
    }
    case "date": {
      if (!isRealDate(raw)) return fail("enter a valid date");
      const problem = checkDateLimits(q, raw);
      if (problem) return fail(problem);
      return raw;
    }
    case "date_range": {
      const r = raw as { from?: unknown; to?: unknown } | null;
      if (!r || typeof r !== "object" || !isRealDate(r.from) || !isRealDate(r.to)) {
        return fail("enter a valid start and end date");
      }
      if (r.to < r.from) return fail("the end date is before the start date");
      const p1 = checkDateLimits(q, r.from);
      if (p1) return fail(p1);
      const p2 = checkDateLimits(q, r.to);
      if (p2) return fail(p2);
      if (q.maxLengthDays && daysBetween(r.from, r.to) > q.maxLengthDays) {
        return fail(`the dates are more than ${q.maxLengthDays} days apart`);
      }
      return { from: r.from, to: r.to };
    }
    case "text": {
      if (typeof raw !== "string") return fail("enter text");
      const text = raw.trim();
      const max = q.textLimits?.maxLength ?? MAX_TEXT_LENGTH;
      const min = q.textLimits?.minLength ?? 0;
      if (text.length > max) return fail(`keep it to ${max} characters or fewer`);
      if (text.length < min) return fail(`use at least ${min} characters`);
      return text;
    }
    case "amount": {
      const r = raw as { amount?: unknown; currency?: unknown } | null;
      const okAmount =
        !!r && typeof r.amount === "number" && Number.isFinite(r.amount) && r.amount >= 0;
      const okCurrency =
        !!r &&
        typeof r.currency === "string" &&
        CURRENCY_CODE.test(r.currency) &&
        (!q.currencies || q.currencies.length === 0 || q.currencies.includes(r.currency));
      if (!r || !okAmount || !okCurrency) return fail("enter the amount in numbers and choose a currency");
      return { amount: r.amount, currency: r.currency };
    }
    default:
      // A type this backend version doesn't know: refuse rather than store
      // an unvalidated value.
      return fail("this question can't be answered in this version");
  }
}

// ============================================
// Service
// ============================================

export class IntakeService {
  /** Is the application still open to edits by its applicant? */
  isEditable(application: Application): boolean {
    return INTAKE_EDITABLE_STATUSES.includes(application.status);
  }

  /**
   * The intake as the client needs it: questions from the approved rubric,
   * the saved answers, and what is still open. Caller has already checked
   * `read` access to the application.
   */
  async getIntake(application: Application): Promise<IntakeResponse> {
    const approved = await loadApprovedIntake(application.countryCode, application.visaTypeId);
    const editable = this.isEditable(application);

    // No approved rubric / no questions: the client shows no intake step.
    if (!approved) {
      return {
        available: false,
        editable,
        routeKey: null,
        rubricVersion: null,
        meta: {},
        questions: [],
        answers: {},
        updatedAt: null,
        savedRubricVersion: null,
        openRequiredIds: [],
        lastReviewAt: null,
      };
    }

    const saved = application.intake;
    // Only hand back answers whose question still exists (the rubric may have
    // changed since the save); the client compares versions to say so.
    const known = new Set(approved.questions.map((q) => q.id));
    const answers: Record<string, unknown> = {};
    for (const [id, value] of Object.entries(saved?.answers ?? {})) {
      if (known.has(id)) answers[id] = value;
    }

    return {
      available: true,
      editable,
      routeKey: approved.routeKey,
      rubricVersion: approved.version,
      meta: approved.meta,
      questions: approved.questions,
      answers,
      updatedAt: saved?.updatedAt ? saved.updatedAt.toDate().toISOString() : null,
      savedRubricVersion: saved?.rubricVersion ?? null,
      openRequiredIds: openRequired(approved.questions, answers),
      // #42 (assessment engine) will fill this in.
      lastReviewAt: null,
    };
  }

  /**
   * Validate and store a full set of answers (replaces the previous set).
   * Caller has already checked `update` access. Returns the fresh intake.
   *
   * Throws:
   *  - `IntakeValidationError` (answer rejected; message names the question)
   *  - Error("NO_INTAKE")      the route has no approved intake questions
   *  - Error("NOT_EDITABLE")   the application is past the editable statuses
   */
  async saveIntake(application: Application, rawAnswers: unknown): Promise<IntakeResponse> {
    if (!this.isEditable(application)) throw new Error("NOT_EDITABLE");

    const approved = await loadApprovedIntake(application.countryCode, application.visaTypeId);
    if (!approved) throw new Error("NO_INTAKE");

    if (!rawAnswers || typeof rawAnswers !== "object" || Array.isArray(rawAnswers)) {
      throw new IntakeValidationError("", "answers must be an object keyed by question id");
    }
    const input = rawAnswers as Record<string, unknown>;

    // 1. Unknown ids are rejected (never silently dropped, never stored).
    const byId = new Map(approved.questions.map((q) => [q.id, q]));
    for (const id of Object.keys(input)) {
      if (!byId.has(id)) throw new IntakeValidationError(id, "That question is not part of this application");
    }

    // 2. Visibility is decided on the submitted answers; hidden questions'
    //    answers are dropped. A blank answer clears the question.
    const { visibleIds } = visibleAnswers(approved.questions, input);
    const toStore: Record<string, unknown> = {};
    for (const q of approved.questions) {
      if (!visibleIds.has(q.id)) continue;
      const raw = input[q.id];
      if (raw === undefined || raw === null || (typeof raw === "string" && raw.trim() === "")) continue;
      toStore[q.id] = validateAnswer(q, raw);
    }

    // 3. Write. Only the `intake` field and `updatedAt` change; the answers
    //    come from the validated copy above, never from the request body.
    const intake: ApplicationIntake = {
      routeKey: approved.routeKey,
      rubricVersion: approved.version,
      answers: toStore,
      updatedAt: Timestamp.now(),
    };
    await collections.applications.doc(application.id).update({
      intake,
      updatedAt: Timestamp.now(),
    });

    return this.getIntake({ ...application, intake });
  }
}

export const intakeService = new IntakeService();
