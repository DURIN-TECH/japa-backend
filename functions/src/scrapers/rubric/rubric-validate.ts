import {
  CHECK_OPS,
  CRITERION_KINDS,
  DECISION_STAGES,
  EVIDENCE_PARTIES,
  INTAKE_ANSWER_TYPES,
  INTENT_POLARITIES,
  RUBRIC_REVIEW_STATUSES,
  type AssessmentCriterion,
  type RubricFlag,
  type VisaRubric,
} from "../../types/rubric";

import { isValidTrigger } from "../../services/ai/rule-applicability";
import { EXCLUSION_NOTE_MAX, MAX_EXCLUDED_CRITERIA } from "./rubric-exclusions";

// ============================================
// RUBRIC — STRUCTURAL VALIDATOR (issue #40)
// ============================================
//
// Checks that a rubric is INTERNALLY CONSISTENT: the kind rules that contain
// judgement, the id joins (criteria, intake questions, evidence items), the
// enumerations and the review state. It runs on every extracted rubric before
// it is written, and is exported so the review API (#125) can run it again
// before an approval.
//
// It does NOT check quotes against source text: that needs the snapshot and
// lives in rubric-quote.ts / the extraction service.
//
// Two outputs:
//  - `errors`: the rubric must not be stored (or approved) as it is;
//  - `flags`:  the rubric is storable, but a reviewer must look (for example
//              criteria about intent with no polarity to score them by).
//
// Dependency-free and pure, and it knows nothing about any particular
// question, document, route or nationality: everything is checked as data.

/** One problem found by the validator. */
export interface RubricIssue {
  code: string;
  message: string;
  // What it is about: a criterion id, a question id, an evidence key, or "rubric".
  target: string;
}

/** What the validator needs from outside the rubric. All optional. */
export interface ValidateRubricOptions {
  // Ids of the EligibilityQuestion docs that exist. Needed only when a
  // criterion sets `eligibilityQuestionId`; without it such a link cannot be
  // verified and is an error (never accepted unchecked).
  knownEligibilityQuestionIds?: ReadonlySet<string>;
}

/** Result of a validation. */
export interface RubricValidation {
  errors: RubricIssue[];
  flags: RubricFlag[];
}

/** A content hash is a sha256 in lowercase hex. */
const HASH_RE = /^[a-f0-9]{64}$/;
/** ISO date, as stored for validFrom / validUntil. */
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** An evidence key / intake question id: a slug. */
const SLUG_RE = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/;

/** True for a non-empty, non-blank string. */
const filled = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;

/** True for an http(s) URL. */
function isHttpUrl(v: unknown): boolean {
  if (typeof v !== "string") return false;
  try {
    const u = new URL(v);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
}

/** Values that occur more than once in a list. */
function duplicates(values: string[]): string[] {
  const seen = new Set<string>();
  const dup = new Set<string>();
  for (const v of values) (seen.has(v) ? dup : seen).add(v);
  return [...dup];
}

/**
 * Check one criterion's own fields (not its joins). Exported because the
 * extraction service runs it on each candidate, so one malformed criterion
 * is discarded with a reason instead of failing the whole rubric.
 */
export function validateCriterionShape(c: AssessmentCriterion, severityLevels: readonly string[]): RubricIssue[] {
  const issues: RubricIssue[] = [];
  const target = filled(c.criterionId) ? c.criterionId : "(no id)";
  const add = (code: string, message: string) => issues.push({ code, message, target });

  if (!filled(c.criterionId)) add("criterion_id_missing", "criterionId is required");
  if (!filled(c.title)) add("title_missing", "title is required (the free tier shows it on its own)");
  if (!CRITERION_KINDS.includes(c.kind)) add("kind_invalid", `kind must be one of ${CRITERION_KINDS.join(", ")}`);
  if (!DECISION_STAGES.includes(c.stage)) add("stage_invalid", `stage must be one of ${DECISION_STAGES.join(", ")}`);
  if (!severityLevels.includes(c.severity)) add("severity_invalid", "severity must be one of the rubric's severityLevels");
  if (typeof c.confidence !== "number" || !(c.confidence >= 0 && c.confidence <= 1)) add("confidence_invalid", "confidence must be a number from 0 to 1");

  // ---- citation: every criterion is cited, no exceptions ----
  const s = c.source;
  if (!s || !filled(s.quote)) add("quote_empty", "source.quote is required");
  if (!s || !isHttpUrl(s.url)) add("source_url_invalid", "source.url must be an http(s) URL");
  if (!s || !filled(s.sourceId)) add("source_id_missing", "source.sourceId is required");
  if (!s || !HASH_RE.test(String(s.contentHash))) add("content_hash_invalid", "source.contentHash must be a sha256 hex digest");
  if (!s || !filled(s.retrievedAt) || Number.isNaN(Date.parse(s.retrievedAt))) add("retrieved_at_invalid", "source.retrievedAt must be an ISO-8601 instant");
  if (s && s.page !== undefined && (!Number.isInteger(s.page) || s.page < 1)) add("page_invalid", "source.page must be a positive integer");

  // ---- kind boundaries (the schema half of the containment rule in #42) ----
  if (c.kind === "judgement") {
    // A judgement criterion with a machine check would let code turn a
    // matter of weighing evidence into a pass/fail, and so into a refusal.
    if (c.check !== undefined) add("judgement_has_check", "a judgement criterion must not carry a check");
    if (!Array.isArray(c.probeFactors) || c.probeFactors.filter(filled).length === 0) add("probe_factors_missing", "a judgement criterion needs at least one probe factor");
    if (typeof c.requiresInterviewBeforeRefusal !== "boolean") add("interview_flag_missing", "a judgement criterion must say whether an interview is required before refusal");
  }
  if (c.kind === "objective") {
    if (!c.check) add("objective_without_check", "an objective criterion needs a check");
  }
  if (c.kind === "mandatory_bar") {
    const a = c.appliesTo;
    if (!a || !Array.isArray(a.nationalities) || a.nationalities.length === 0) {
      add("bar_without_applies_to", "a mandatory bar needs appliesTo.nationalities");
    } else {
      if (a.nationalities.some((n) => !/^[A-Z]{2}$/.test(n))) add("nationality_code_invalid", "appliesTo.nationalities must be two-letter uppercase codes");
      // One source name per code, in the same order. A name of one or two
      // characters is not a name (it would "match" inside almost any text).
      if (!Array.isArray(a.asWritten) || a.asWritten.length !== a.nationalities.length || a.asWritten.some((w) => !filled(w) || w.trim().length < 3)) {
        add("applies_to_as_written_mismatch", "appliesTo.asWritten must give the source's own wording (3 characters or more) for each nationality code, in the same order");
      }
      if (a.codeNames !== undefined && (!Array.isArray(a.codeNames) || a.codeNames.length !== a.nationalities.length)) {
        add("applies_to_code_names_mismatch", "appliesTo.codeNames must be parallel to appliesTo.nationalities");
      }
    }
  }
  if (c.check) {
    if (!filled(c.check.field)) add("check_field_missing", "check.field is required");
    if (!CHECK_OPS.includes(c.check.op)) add("check_op_invalid", `check.op must be one of ${CHECK_OPS.join(", ")}`);
    else if (c.check.op !== "present" && (c.check.value === undefined || c.check.value === null || c.check.value === "")) {
      add("check_value_missing", `check.value is required for op ${c.check.op}`);
    } else if (c.check.op === "heldForDays" && (typeof c.check.value !== "number" || !Number.isFinite(c.check.value) || !filled(c.check.unit))) {
      add("check_duration_invalid", "a heldForDays check needs a numeric value and the unit the source writes it in");
    } else if ((c.check.op === "gte" || c.check.op === "lte") && (typeof c.check.value !== "number" || !Number.isFinite(c.check.value))) {
      // A threshold is a number. A string here ("a hundred thousand", digits
      // of another script) could not be checked against the quote, so it is
      // refused outright rather than accepted unverified.
      add("check_value_not_numeric", `check.value must be a finite number for op ${c.check.op}`);
    } else if (c.check.op === "present" && c.check.value !== undefined) {
      add("check_value_unexpected", "a `present` check must not carry a value");
    }
  }
  for (const key of ["validFrom", "validUntil"] as const) {
    const v = c[key];
    if (v !== undefined && !ISO_DATE_RE.test(v)) add("date_invalid", `${key} must be YYYY-MM-DD`);
  }
  if (c.validFrom && c.validUntil && c.validFrom > c.validUntil) add("date_range_invalid", "validFrom is after validUntil");
  return issues;
}

/**
 * Validate a whole rubric version. See the file header for what is and is not
 * covered.
 */
export function validateVisaRubric(rubric: VisaRubric, options: ValidateRubricOptions = {}): RubricValidation {
  const errors: RubricIssue[] = [];
  const flags: RubricFlag[] = [];
  const err = (code: string, message: string, target = "rubric") => errors.push({ code, message, target });

  // ---- identity and review state ----
  if (!filled(rubric.countryCode) || !filled(rubric.visaTypeId)) err("route_missing", "countryCode and visaTypeId are required");
  if (rubric.routeKey !== `${rubric.countryCode}_${rubric.visaTypeId}`) err("route_key_mismatch", "routeKey must be `${countryCode}_${visaTypeId}`");
  if (!Number.isInteger(rubric.version) || rubric.version < 1) err("version_invalid", "version must be a positive integer");
  if (!RUBRIC_REVIEW_STATUSES.includes(rubric.reviewStatus)) err("review_status_invalid", `reviewStatus must be one of ${RUBRIC_REVIEW_STATUSES.join(", ")}`);
  if (rubric.intentPolarity !== null && !INTENT_POLARITIES.includes(rubric.intentPolarity)) err("intent_polarity_invalid", "intentPolarity is not a known value");
  if (rubric.intentPolarityProposal && !INTENT_POLARITIES.includes(rubric.intentPolarityProposal.value)) err("intent_polarity_invalid", "intentPolarityProposal.value is not a known value");
  if (rubric.reviewStatus === "approved") {
    // An approved rubric is what the engine scores by: the polarity must have
    // been DECIDED by a person, and the decision must be attributable.
    if (rubric.intentPolarity === null) err("approved_without_polarity", "an approved rubric must carry a decided intentPolarity");
    if (!filled(rubric.reviewedBy) || !rubric.reviewedAt) err("approved_without_reviewer", "an approved rubric must record who approved it and when");
  }

  // ---- severity scale ----
  const levels = Array.isArray(rubric.severityLevels) ? rubric.severityLevels : [];
  if (levels.length === 0 || levels.some((l) => !filled(l))) err("severity_levels_invalid", "severityLevels must be a non-empty ordered list");
  if (duplicates(levels).length > 0) err("severity_levels_duplicate", "severityLevels must not repeat a value");

  // ---- criteria ----
  const criteria = Array.isArray(rubric.criteria) ? rubric.criteria : [];
  for (const c of criteria) errors.push(...validateCriterionShape(c, levels));
  for (const id of duplicates(criteria.map((c) => c.criterionId))) err("criterion_id_duplicate", "criterionId is used by more than one criterion", id);
  const criterionIds = new Set(criteria.map((c) => c.criterionId));

  // ---- intake questions ----
  const questions = Array.isArray(rubric.intakeQuestions) ? rubric.intakeQuestions : [];
  for (const id of duplicates(questions.map((q) => q.id))) err("intake_question_id_duplicate", "intake question id is used more than once", id);
  const questionIds = new Set(questions.map((q) => q.id));
  for (const q of questions) {
    const target = filled(q.id) ? q.id : "(no id)";
    if (!filled(q.id) || !SLUG_RE.test(q.id)) err("intake_question_id_invalid", "intake question id must be a slug (lowercase letters, digits, - or _)", target);
    if (!filled(q.label)) err("intake_label_missing", "intake question label is required", target);
    if (!filled(q.answerType)) err("intake_answer_type_missing", "intake question answerType is required", target);
    else if (!(INTAKE_ANSWER_TYPES as readonly string[]).includes(q.answerType)) {
      // Not an error: a rubric may be ahead of a client. Clients degrade safely.
      flags.push({ code: "intake_answer_type_unknown", message: `answer type "${q.answerType}" is not one the current clients render`, target });
    }
    if (typeof q.required !== "boolean") err("intake_required_missing", "intake question must say whether it is required", target);
    if (!Array.isArray(q.criterionIds) || q.criterionIds.length === 0) err("intake_without_criteria", "an intake question must name the criteria that read its answer", target);
    for (const id of q.criterionIds ?? []) {
      if (!criterionIds.has(id)) err("intake_criterion_unknown", `intake question names criterion ${id}, which is not in the rubric`, target);
    }
    if (q.party !== undefined && !EVIDENCE_PARTIES.includes(q.party)) err("intake_party_invalid", "intake question party is not a known value", target);
    if ((q.answerType === "single_choice" || q.answerType === "multi_choice") && (!Array.isArray(q.options) || q.options.length === 0)) {
      err("intake_options_missing", "a choice question needs options", target);
    }
    if (q.options && duplicates(q.options.map((o) => o.value)).length > 0) err("intake_option_duplicate", "option values must be unique within a question", target);
    for (const cond of q.showWhen?.anyOf ?? []) {
      if (!questionIds.has(cond.questionId)) err("intake_condition_unknown", `showWhen names question ${cond.questionId}, which is not in the rubric`, target);
      if (cond.questionId === q.id) err("intake_condition_self", "a question cannot be shown depending on its own answer", target);
    }
  }
  // The other direction: a criterion that reads an answer nobody asks for.
  for (const c of criteria) {
    for (const id of c.intakeQuestionIds ?? []) {
      if (!questionIds.has(id)) err("criterion_intake_unknown", `criterion reads intake question ${id}, which is not in the rubric`, c.criterionId);
    }
    // (#207) A rule trigger names a question of this rubric and answer values
    // that question can give. Extraction only stores checked triggers, so a
    // failure here means damaged data: the rubric is not stored or approved.
    if (c.trigger !== undefined) {
      const q = questions.find((x) => x.id === c.trigger?.questionId);
      if (!q) err("criterion_trigger_question_unknown", `trigger names question ${String(c.trigger.questionId)}, which is not in the rubric`, c.criterionId);
      else if (!isValidTrigger(c.trigger, questions)) err("criterion_trigger_value_unknown", "trigger values must be option values of the question it names (true / false for a yes/no question)", c.criterionId);
    }
    if (c.eligibilityQuestionId !== undefined) {
      const known = options.knownEligibilityQuestionIds;
      if (!known) err("eligibility_question_unverified", "eligibilityQuestionId is set but no question list was supplied to check it against", c.criterionId);
      else if (!known.has(c.eligibilityQuestionId)) err("eligibility_question_unknown", `eligibilityQuestionId ${c.eligibilityQuestionId} does not resolve`, c.criterionId);
    }
  }

  // ---- evidence items ----
  const evidence = Array.isArray(rubric.evidenceItems) ? rubric.evidenceItems : [];
  for (const key of duplicates(evidence.map((e) => e.key))) err("evidence_key_duplicate", "evidence key is used more than once", key);
  for (const e of evidence) {
    const target = filled(e.key) ? e.key : "(no key)";
    if (!filled(e.key) || !SLUG_RE.test(e.key)) err("evidence_key_invalid", "evidence key must be a slug", target);
    if (!filled(e.title)) err("evidence_title_missing", "evidence title is required", target);
    if (!EVIDENCE_PARTIES.includes(e.party)) err("evidence_party_invalid", `evidence party must be one of ${EVIDENCE_PARTIES.join(", ")}`, target);
    if (!Array.isArray(e.criterionIds) || e.criterionIds.length === 0) err("evidence_without_criteria", "an evidence item must name the criteria it evidences", target);
    for (const id of e.criterionIds ?? []) {
      if (!criterionIds.has(id)) err("evidence_criterion_unknown", `evidence item names criterion ${id}, which is not in the rubric`, target);
    }
    if (e.when && !questionIds.has(e.when.questionId)) err("evidence_condition_unknown", `evidence item depends on question ${e.when.questionId}, which is not in the rubric`, target);
    if (!e.source || !filled(e.source.quote)) err("evidence_quote_empty", "an evidence item needs the quote that names the document", target);
  }

  // ---- outcome statistics mapping (admin-set; only checked when present) ----
  if (rubric.outcomeStatistics !== undefined) {
    if (!filled(rubric.outcomeStatistics.categoryKey)) err("outcome_statistics_category_missing", "outcomeStatistics.categoryKey is required");
    if (!filled(rubric.outcomeStatistics.categoryLabel)) err("outcome_statistics_label_missing", "outcomeStatistics.categoryLabel is required");
    if (rubric.outcomeStatistics.sourceUrl !== undefined && !isHttpUrl(rubric.outcomeStatistics.sourceUrl)) err("outcome_statistics_url_invalid", "outcomeStatistics.sourceUrl must be an http(s) URL");
  }

  // ---- extra-evidence tags (admin-set, #116; only checked when present) ----
  for (const id of rubric.evidenceHelpsCriterionIds ?? []) {
    if (!criterionIds.has(id)) err("evidence_tag_criterion_unknown", `evidenceHelpsCriterionIds names criterion ${id}, which is not in the rubric`);
  }

  // ---- exclusions (admin-set, #161; only checked when present) ----
  // Every problem here is an ERROR: an exclusion list that names a criterion
  // the version does not have, names one twice, or names a mandatory bar must
  // never be stored (a bar is a hard refusal rule: it stays in force).
  if (rubric.excludedCriterionIds !== undefined) {
    const excluded = rubric.excludedCriterionIds;
    if (!Array.isArray(excluded) || excluded.some((id) => typeof id !== "string")) {
      err("exclusion_invalid", "excludedCriterionIds must be a list of criterion ids");
    } else {
      if (excluded.length > MAX_EXCLUDED_CRITERIA) err("exclusion_list_too_long", `excludedCriterionIds may name at most ${MAX_EXCLUDED_CRITERIA} criteria`);
      for (const id of duplicates(excluded)) err("exclusion_duplicate", "criterion is excluded more than once", id);
      const kindById = new Map(criteria.map((c) => [c.criterionId, c.kind]));
      for (const id of new Set(excluded)) {
        if (!criterionIds.has(id)) err("exclusion_criterion_unknown", `excludedCriterionIds names criterion ${id}, which is not in the rubric`, id);
        else if (kindById.get(id) === "mandatory_bar") err("mandatory_bar_excluded", "a mandatory bar can never be excluded", id);
      }
    }
  }
  if (rubric.exclusionNote !== undefined && (typeof rubric.exclusionNote !== "string" || rubric.exclusionNote.length > EXCLUSION_NOTE_MAX)) {
    err("exclusion_note_invalid", `exclusionNote must be a string of at most ${EXCLUSION_NOTE_MAX} characters`);
  }

  // ---- intent: criteria about intent need a polarity to be scored by ----
  // The decision wins when there is one; before review, the proposal stands in.
  const polarity = rubric.intentPolarity ?? rubric.intentPolarityProposal?.value ?? null;
  const intentCriteria = criteria.filter((c) => c.concernsIntent === true);
  if (intentCriteria.length > 0 && (polarity === null || polarity === "not_assessed")) {
    flags.push({
      code: "intent_criteria_without_polarity",
      message: `${intentCriteria.length} criterion/criteria concern the applicant's intent, but the rubric's intent polarity is ${polarity ?? "not set"}. Decide the polarity before approving.`,
      target: "rubric",
    });
  }
  if (criteria.length === 0) flags.push({ code: "no_criteria", message: "the rubric has no criteria", target: "rubric" });

  return { errors, flags };
}
