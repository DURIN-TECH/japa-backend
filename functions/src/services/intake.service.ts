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
// The approved rubric is read through #40's `rubricStore.getApprovedRubric`.
// (#233) Since P4a it is the application's rulebook STACK (shared layer(s)
// plus its own), read through services/ai/application-rulebook.ts; for a route
// without inheritance that is the same `getApprovedRubric` read.

import { Timestamp } from "firebase-admin/firestore";
import { collections } from "../utils/firebase";
import { layerVersionsOf, rubricRouteKey, type RulebookStack } from "../scrapers";
import { defaultRulebookStack, type ApplicationStackRef } from "./ai/application-rulebook";
import type { RulebookStackLayer } from "../types/rubric";
import { Application, ApplicationStatus } from "../types";
import { answerIncludesAny, effectiveIntakeQuestions } from "./ai/rule-applicability";
// (#235) Destination questions list the route's member countries when asked.
import { withDestinationOptions } from "./route-destinations";
import {
  ApplicationIntake,
  IntakeCondition,
  OrphanedIntakeAnswer,
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
  // (#233) Only for a rulebook stack of more than one layer: every layer's
  // version (saved with the answers) and the layer list (approved / missing).
  layerVersions?: Record<string, number | null>;
  layers?: RulebookStackLayer[];
}

/**
 * (#233) How the intake reads an application's rulebook: its STACK (shared
 * layer(s) + its own), through services/ai/application-rulebook.ts. The
 * default reader is the store's approved read (`getApprovedRubric` for the
 * own layer alone, `getRulebookStack` for the whole stack). A property of the
 * module so a test can swap it.
 */
export const intakeRulebookReader: { read: (app: ApplicationStackRef) => Promise<RulebookStack> } = {
  read: (app) => defaultRulebookStack(app),
};

/**
 * The approved rubric's intake for a route, or null when there is no
 * approved version or it carries no questions.
 *
 * Integration: reads through #40's `rubricStore.getApprovedRubric`, the one read
 * consumers may use (it re-checks the version's own `reviewStatus`), instead of
 * the direct `visaRubrics` reads #113 shipped with. Note the store validates the
 * route key (upper-case two-letter country code), so a malformed code throws
 * rather than silently addressing a second key; the caller treats that as no
 * intake.
 */
async function loadApprovedIntake(application: ApplicationStackRef): Promise<ApprovedIntake | null> {
  const { countryCode, visaTypeId } = application;
  let stack: RulebookStack;
  try {
    // (#233) The union of the stack's layers' questions, each asked once (a
    // shared layer's question ids are scoped by its rulebook key, so two
    // layers never share an answer). For a route without inheritance this is
    // exactly the own layer's approved rubric, as before.
    stack = await intakeRulebookReader.read(application);
  } catch {
    // Invalid route key parts: no such route, so no intake step.
    return null;
  }
  const rubric = stack.usable ? stack.rubric : null;
  if (!rubric) return null;
  if (!Array.isArray(rubric.intakeQuestions) || rubric.intakeQuestions.length === 0) return null;
  // (#207) A question that only specialist or conditional rules read is shown
  // only once an answer triggers one of those rules (their `trigger`s become
  // each question's `showWhen`); one that only unassessable specialist rules
  // read is left out. See effectiveIntakeQuestions.
  // (#235) A question whose options are the route's member countries gets
  // them NOW, from membership data on today's date (never stored, never typed
  // in). Validation below then accepts exactly the countries the applicant saw.
  const questions = await withDestinationOptions(effectiveIntakeQuestions(rubric), rubric.routeKey);
  const layerVersions = layerVersionsOf(rubric);
  return {
    routeKey: rubricRouteKey(countryCode, visaTypeId),
    version: rubric.version,
    meta: rubric.intake ?? {},
    questions,
    ...(layerVersions ? { layerVersions, layers: rubric.stackLayers } : {}),
  };
}

// ============================================
// Visibility (showWhen)
// ============================================

/**
 * Does one condition hold on these answers? Exported (#235) so the "apply
 * through" steps read their `when` conditions exactly like `showWhen`.
 */
export function conditionHolds(cond: IntakeCondition, answers: Record<string, unknown>): boolean {
  const actual = answers[cond.questionId];
  switch (cond.op) {
  case "eq":
    return actual === cond.value;
  case "neq":
    // An unanswered question is not "different from" the value: stay hidden.
    return actual !== undefined && actual !== null && actual !== cond.value;
  case "in":
    // (#207) A multi-choice answer is an array and a yes/no answer a boolean:
    // `in` holds when any selected value is one of the wanted ones.
    return Array.isArray(cond.value) && answerIncludesAny(actual, cond.value.map((v) => String(v)));
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
  // (#207) Passes repeat until nothing changes: a question may depend on one
  // that comes LATER in the list (a rule's triggering question can be asked in
  // a later part of the guidance), and a hidden question's answer still never
  // counts. Starting from nothing visible, a question becomes visible only
  // through questions already visible, so a cycle never makes itself visible.
  // The list is finite, so at most `questions.length` passes change anything.
  for (let changed = true; changed; ) {
    changed = false;
    for (const q of questions) {
      if (visibleIds.has(q.id)) continue;
      const any = q.showWhen?.anyOf;
      const visible = !any || any.length === 0 || any.some((c) => conditionHolds(c, effective));
      if (visible) {
        visibleIds.add(q.id);
        if (answers[q.id] !== undefined) effective[q.id] = answers[q.id];
        changed = true;
      }
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

/**
 * Validate a full set of answers against a question list (the steps
 * `saveIntake` applies, exported for #235 so the "apply through" questions are
 * checked by the same code):
 *  1. unknown ids are rejected (never silently dropped, never stored);
 *  2. visibility is decided on the submitted answers; hidden questions'
 *     answers are dropped; a blank answer clears the question;
 *  3. every remaining answer is validated per type.
 * Throws `IntakeValidationError`. Returns the answers to store.
 */
export function cleanAnswers(questions: IntakeQuestion[], rawAnswers: unknown): Record<string, unknown> {
  if (!rawAnswers || typeof rawAnswers !== "object" || Array.isArray(rawAnswers)) {
    throw new IntakeValidationError("", "answers must be an object keyed by question id");
  }
  const input = rawAnswers as Record<string, unknown>;
  const byId = new Map(questions.map((q) => [q.id, q]));
  for (const id of Object.keys(input)) {
    if (!byId.has(id)) throw new IntakeValidationError(id, "That question is not part of this application");
  }
  const { visibleIds } = visibleAnswers(questions, input);
  const toStore: Record<string, unknown> = {};
  for (const q of questions) {
    if (!visibleIds.has(q.id)) continue;
    const raw = input[q.id];
    if (raw === undefined || raw === null || (typeof raw === "string" && raw.trim() === "")) continue;
    toStore[q.id] = validateAnswer(q, raw);
  }
  return toStore;
}

/** What `IntakeService.rebuildIntake` returns: the intake to store and what was set aside. */
export interface RebuiltIntake {
  // The intake to store (null when the new stack has no intake and nothing was set aside).
  intake: ApplicationIntake | null;
  // How many answers were kept / set aside by this rebuild.
  kept: number;
  setAside: number;
}

export class IntakeService {
  /**
   * (#235) Rebuild an application's saved intake for a NEW rulebook stack (the
   * country applied through changed, or the application is starting with
   * answers already given). Answers whose question still exists in the new
   * stack are kept as they are; every other answer is moved to
   * `orphanedAnswers` (with the route and version it was given against), never
   * deleted. Earlier orphans are kept. Pure apart from the rulebook read.
   *
   * @param target the application's NEW country / visa / stack
   * @param previous the saved intake (or a fresh set of answers to start with)
   */
  async rebuildIntake(
    target: ApplicationStackRef,
    previous: { answers: Record<string, unknown>; routeKey?: string; rubricVersion?: number; orphanedAnswers?: OrphanedIntakeAnswer[] },
    now: Timestamp = Timestamp.now()
  ): Promise<RebuiltIntake> {
    const approved = await loadApprovedIntake(target);
    const known = new Set((approved?.questions ?? []).map((q) => q.id));
    const answers: Record<string, unknown> = {};
    const orphaned: OrphanedIntakeAnswer[] = [...(previous.orphanedAnswers ?? [])];
    let setAside = 0;
    for (const [id, value] of Object.entries(previous.answers ?? {})) {
      if (known.has(id)) answers[id] = value;
      else {
        orphaned.push({
          questionId: id,
          value,
          ...(previous.routeKey ? { routeKey: previous.routeKey } : {}),
          ...(typeof previous.rubricVersion === "number" ? { rubricVersion: previous.rubricVersion } : {}),
          setAsideAt: now,
        });
        setAside++;
      }
    }
    if (!approved && orphaned.length === 0 && Object.keys(answers).length === 0) return { intake: null, kept: 0, setAside: 0 };
    const intake: ApplicationIntake = {
      routeKey: approved?.routeKey ?? rubricRouteKey(target.countryCode, target.visaTypeId),
      rubricVersion: approved?.version ?? 0,
      ...(approved?.layerVersions ? { layerVersions: approved.layerVersions } : {}),
      answers,
      ...(orphaned.length > 0 ? { orphanedAnswers: orphaned } : {}),
      updatedAt: now,
    };
    return { intake, kept: Object.keys(answers).length, setAside };
  }

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
    const approved = await loadApprovedIntake(application);
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
      // (#233) Only on a multi-layer stack: which layer is approved or missing.
      ...(approved.layers ? { layers: approved.layers } : {}),
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

    const approved = await loadApprovedIntake(application);
    if (!approved) throw new Error("NO_INTAKE");

    // 1-2. Unknown ids rejected, hidden answers dropped, each answer validated.
    const toStore = cleanAnswers(approved.questions, rawAnswers);

    // 3. Write. Only the `intake` field and `updatedAt` change; the answers
    //    come from the validated copy above, never from the request body.
    const intake: ApplicationIntake = {
      routeKey: approved.routeKey,
      rubricVersion: approved.version,
      // (#233) Every layer's version, on a multi-layer stack only.
      ...(approved.layerVersions ? { layerVersions: approved.layerVersions } : {}),
      answers: toStore,
      // (#235) Answers kept aside when the country applied through changed are
      // never lost by a later save (they are not this route's answers any more,
      // so they are carried over as they are, never validated or edited).
      ...(application.intake?.orphanedAnswers ? { orphanedAnswers: application.intake.orphanedAnswers } : {}),
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
