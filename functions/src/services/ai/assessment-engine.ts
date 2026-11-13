import { createHash } from "crypto";
import type { AssessmentCriterion, VisaRubric, IntentPolarity } from "../../scrapers";
import type { DecisionStage } from "../../types/rubric";
import type {
  CredibilityFlag,
  InsufficientItem,
  ReadinessBand,
  RefusalGround,
  StageOutcomes,
  StatementFinding,
  StatementRef,
} from "../../types/assessment";
import type { LlmRequest } from "./llm-provider";
import { AI_MODELS } from "./ai-models";
import { DATA_ONLY_RULE, findBannedWording, findInjectionSignals, sanitizeUntrusted, wrapUntrusted, MAX_UNTRUSTED_CHARS } from "./prompt-safety";

// ============================================
// ASSESSMENT ENGINE — PURE CORE (issue #42)
// ============================================
//
// Everything in this module is a pure function of its inputs. No Firestore, no
// SDK, no clock (the caller passes `now`). The job runner in
// services/ai-case-officer.service.ts does the I/O and calls in here.
//
// The non-negotiables this file enforces, each at the point it happens:
//
//  1. CODE DECIDES OBJECTIVE RULES. `evaluateObjective` compares extracted values
//     with each criterion's `check`. The extraction schema has no verdict field.
//  2. A JUDGEMENT CRITERION CANNOT BECOME A REFUSAL. `assembleContent` builds
//     refusalGrounds only from objective and mandatory-bar criteria, and sends a
//     judgement concern to credibilityFlags. A genuineness concern is never a
//     predicted refusal (rule 4 of the plan).
//  3. CITATIONS COME FROM THE RUBRIC. A refusal ground's ruleRef, sourceUrl and
//     sourceQuote are copied from the criterion. A model-named criterionId that
//     the rubric does not contain is dropped and counted.
//  4. GENERIC. Nothing here names a country, a nationality, a route or a visa
//     type. A nationality is only a value compared with a criterion's appliesTo
//     list; a route is only the rubric it is given.
//  5. INTENT IS DECLARED. The stage 3 prompt takes its polarity sentence from the
//     rubric's approved `intentPolarity`. The model is never asked to infer it.
//
// The PROMPT VERSION lives in prompt-safety.ts and is recorded on every stored
// assessment, so a prompt change shows up in the record.

// ============================================
// Inputs and results
// ============================================

/** A value a model read from one document, with where it was read. */
export interface ExtractedValue {
  field: string;
  value: string | number | boolean | null;
  unit: string | null;
  page: number | null;
  quote: string | null;
}

/** What stage 2 made of one document. */
export interface DocumentExtraction {
  documentId: string;
  // A code label (never the stored file name, which the applicant typed).
  label: string;
  // The file's media type as SNIFFED from its bytes.
  mediaType: string;
  readable: boolean;
  // Values read, already limited to the requested fields.
  values: ExtractedValue[];
  // The model's answer broke the output contract. The document then counts as
  // unread, so its criteria go to insufficientInformation.
  failed: boolean;
  failure: string | null;
  // The document addressed the model. Its values cannot satisfy any criterion.
  suspicious: boolean;
}

/** Facts the objective checks may read, keyed by a dotted name. */
export type Facts = Record<string, string | number | boolean | null | undefined>;

/** Result of one objective criterion. */
export interface ObjectiveResult {
  criterionId: string;
  outcome: "pass" | "fail" | "insufficient";
  reason: string;
}

/** Model output for stage 3, after shape and code validation. */
export interface JudgementOutput {
  findings: Array<{ criterionId: string; detail: string; whatWouldHelp: string; concern: boolean }>;
  strengths: Array<{ criterionId: string; detail: string }>;
  // `blockIndex` is the model's number for a statement block, ALREADY validated
  // against the blocks that were sent: an integer in range, else null.
  statementNotes: Array<{ criterionId: string; detail: string; blockIndex: number | null }>;
  suspiciousPassages: string[];
  dropped: number;
  // Statement notes kept but stored without a position (missing or out-of-range index).
  unanchored: number;
}

/** One stored assessment's content, before the job adds its record fields. */
export interface AssessmentContent {
  stageOutcomes: StageOutcomes;
  refusalGrounds: RefusalGround[];
  credibilityFlags: CredibilityFlag[];
  strengths: Array<{ criterionId: string; title: string; detail: string }>;
  statementFindings: StatementFinding[];
  // The statement that was read (null when none).
  statement: StatementRef | null;
  insufficientInformation: InsufficientItem[];
  suspiciousDocumentIds: string[];
  score: number | null;
  readiness: ReadinessBand;
  confidence: "high" | "medium" | "low";
  internalCall: "would_approve" | "would_refuse";
  // A mandatory bar applies (code-decided). Served to the free tier as a boolean.
  hasBlockingRule: boolean;
  droppedCount: number;
  // Statement findings stored without `nodePath` (see JudgementOutput.unanchored).
  unanchoredCount: number;
}

// ============================================
// Input hash and ids
// ============================================

/** Everything the assessment reads. Any change here means a new assessment. */
export interface AssessmentInputs {
  rubricVersion: number;
  // Document paths and their `updatedAt` (ms). A changed file changes the hash.
  documents: Array<{ path: string; updatedAtMs: number }>;
  // Statements, by CONTENT hash (see hashStatementContent), not by `version`:
  // a version bump with identical text must not trigger a re-run (#36).
  statements: Array<{ instanceId: string; contentHash: string }>;
  // Eligibility answers, as stored on the latest check (null when none).
  eligibilityAnswers: Record<string, unknown> | null;
  // Intake answers (#113). Empty until that feature stores them.
  intake: Record<string, unknown>;
}

/** Stable JSON: object keys sorted at every depth, so the hash is order-free. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value === undefined ? null : value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`).join(",")}}`;
}

/** sha256 of a statement's ProseMirror content, key-order independent. */
export function hashStatementContent(content: unknown): string {
  return createHash("sha256").update(canonical(content)).digest("hex");
}

/**
 * sha256 over every input the assessment reads. Deliberately NOT over the
 * application document: an unrelated application field (its title, its notes)
 * changes nothing and must not trigger a re-run.
 */
export function computeInputHash(inputs: AssessmentInputs): string {
  const documents = [...inputs.documents].sort((a, b) => (a.path < b.path ? -1 : 1));
  const statements = [...inputs.statements].sort((a, b) => (a.instanceId < b.instanceId ? -1 : 1));
  return createHash("sha256")
    .update(canonical({ ...inputs, documents, statements }))
    .digest("hex");
}

/** The assessment document id: the same inputs always address the same document. */
export function assessmentIdFor(applicationId: string, inputHash: string): string {
  return createHash("sha256").update(`${applicationId}:${inputHash}`).digest("hex");
}

// ============================================
// Stage 1: mandatory bars (zero model calls)
// ============================================

/** ISO date (YYYY-MM-DD) comparison. Both sides must already be ISO dates. */
function withinBar(criterion: AssessmentCriterion, applicationDate: string): boolean {
  if (criterion.validFrom && applicationDate < criterion.validFrom) return false;
  if (criterion.validUntil && applicationDate > criterion.validUntil) return false;
  return true;
}

/**
 * The mandatory bars that apply to this applicant. An applicant matches a bar
 * when their nationality code is in `appliesTo.nationalities` and the date
 * falls inside `validFrom` / `validUntil`. Null nationality matches nothing.
 * No model call, no network.
 */
export function mandatoryBarHits(
  rubric: Pick<VisaRubric, "criteria">,
  nationality: string | null,
  applicationDate: string
): AssessmentCriterion[] {
  if (!nationality) return [];
  return rubric.criteria.filter(
    (c) =>
      c.kind === "mandatory_bar" &&
      c.appliesTo !== undefined &&
      c.appliesTo.nationalities.includes(nationality) &&
      withinBar(c, applicationDate)
  );
}

// ============================================
// Stage 2: extraction (one call per document)
// ============================================

/**
 * Facts code derives itself (never read from a document). A check on one of
 * these is answered by code, so the model is not asked for it.
 */
const DERIVED_FACTS: Record<string, string> = { "funds.holderIsApplicant": "accountHolder" };

/**
 * The document fields the model must read for the objective checks: the checked
 * field itself, or, for a derived fact, the field it is derived from.
 */
export function documentFieldsFor(rubric: Pick<VisaRubric, "criteria">): string[] {
  const fields = new Set<string>();
  for (const c of rubric.criteria) {
    if (c.kind !== "objective" || !c.check) continue;
    const field = c.check.field;
    if (field.startsWith("intake.") || field.startsWith("applicant.")) continue;
    if (field in DERIVED_FACTS) fields.add(DERIVED_FACTS[field]);
    else fields.add(field);
  }
  return [...fields].sort();
}

/**
 * The output schema for stage 2. VALUES ONLY: there is no pass, fail, verdict or
 * meets property anywhere in it. A test asserts that.
 */
export function extractionSchema(fields: readonly string[]): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: ["readable", "values"],
    properties: {
      readable: { type: "boolean" },
      values: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["field", "value", "unit", "page", "quote"],
          properties: {
            field: { type: "string", enum: [...fields] },
            value: { type: ["string", "number", "boolean", "null"] },
            unit: { type: ["string", "null"] },
            page: { type: ["integer", "null"] },
            quote: { type: ["string", "null"] },
          },
        },
      },
    },
  };
}

const EXTRACTION_SYSTEM =
  "You read one attached document and report the values of the requested fields. " +
  "For each value give the value as written, its unit if the document states one, " +
  "the page it is on, and a short verbatim quote. If a field is not in the document " +
  "or cannot be read, leave it out. Do not judge, compare, score or decide anything; " +
  "only report what the document says.\n" +
  DATA_ONLY_RULE;

/** The request for stage 2, one document. The label is code-written; the document is attached. */
export function buildExtractionRequest(
  doc: { label: string; mediaType: "application/pdf" | "image/jpeg" | "image/png"; data: string },
  fields: readonly string[]
): LlmRequest {
  return {
    role: "extraction",
    system: EXTRACTION_SYSTEM,
    user:
      `Fields to report: ${fields.join(", ")}.\n` +
      wrapUntrusted(doc.label, "document_label"),
    schema: extractionSchema(fields),
    documents: [{ mediaType: doc.mediaType, data: doc.data }],
    maxOutputTokens: 4_000,
    timeoutMs: 120_000,
  };
}

/** Result of checking one stage 2 answer against the contract. */
export type ExtractionParse =
  | { ok: true; readable: boolean; values: ExtractedValue[] }
  | { ok: false; reason: string };

const EXTRACTION_KEYS = new Set(["readable", "values"]);
const VALUE_KEYS = new Set(["field", "value", "unit", "page", "quote"]);

/**
 * Check a stage 2 answer in code. Any shape mismatch (missing key, extra key,
 * wrong type, unknown field) is a FAILED extraction, never a pass. Unknown
 * fields inside an otherwise valid answer are dropped, not trusted.
 */
export function parseExtraction(text: string, fields: readonly string[]): ExtractionParse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, reason: "answer is not JSON" };
  }
  if (!isRecord(parsed)) return { ok: false, reason: "answer is not an object" };
  for (const key of Object.keys(parsed)) if (!EXTRACTION_KEYS.has(key)) return { ok: false, reason: `unexpected key ${key}` };
  if (typeof parsed.readable !== "boolean") return { ok: false, reason: "readable is not a boolean" };
  if (!Array.isArray(parsed.values)) return { ok: false, reason: "values is not an array" };

  const values: ExtractedValue[] = [];
  const allowed = new Set(fields);
  for (const v of parsed.values) {
    if (!isRecord(v)) return { ok: false, reason: "a value is not an object" };
    for (const key of Object.keys(v)) if (!VALUE_KEYS.has(key)) return { ok: false, reason: `unexpected value key ${key}` };
    if (typeof v.field !== "string") return { ok: false, reason: "a value has no field" };
    if (!(v.value === null || ["string", "number", "boolean"].includes(typeof v.value))) return { ok: false, reason: "a value has a bad type" };
    if (!(v.unit === null || typeof v.unit === "string")) return { ok: false, reason: "a unit has a bad type" };
    if (!(v.page === null || (typeof v.page === "number" && Number.isInteger(v.page)))) return { ok: false, reason: "a page has a bad type" };
    if (!(v.quote === null || typeof v.quote === "string")) return { ok: false, reason: "a quote has a bad type" };
    if (!allowed.has(v.field)) continue; // a field the rubric did not ask for: dropped
    values.push({
      field: v.field,
      value: v.value as string | number | boolean | null,
      unit: v.unit as string | null,
      page: v.page as number | null,
      quote: v.quote as string | null,
    });
  }
  return { ok: true, readable: parsed.readable, values };
}

/** True when the extracted text or quotes address the model. Sets the suspicious flag. */
export function extractionIsSuspicious(values: readonly ExtractedValue[]): boolean {
  return values.some(
    (v) => findInjectionSignals(String(v.value ?? "")) || (v.quote !== null && findInjectionSignals(v.quote))
  );
}

// ============================================
// Objective evaluation (code only)
// ============================================

/** A duration in days, from a value and its unit. Null when the unit is not one we convert. */
function daysOf(value: number, unit: string | null): number | null {
  if (unit === "days") return value;
  if (unit === "weeks") return value * 7;
  return null;
}

/**
 * Value of a fact for one check: a fact the caller derived (profile, intake),
 * or the first usable value extracted from a readable, unsuspicious document.
 */
function lookup(
  field: string,
  facts: Facts,
  docs: readonly DocumentExtraction[]
): { value: string | number | boolean | null; unit: string | null; found: boolean; unreadable: boolean } {
  if (Object.prototype.hasOwnProperty.call(facts, field) && facts[field] !== undefined) {
    const v = facts[field];
    return { value: v === undefined ? null : v, unit: null, found: v !== null, unreadable: v === null };
  }
  let unreadable = false;
  for (const d of docs) {
    if (!d.readable || d.failed || d.suspicious) continue;
    for (const v of d.values) {
      if (v.field !== field) continue;
      // The model listed the field and could not read it (a date that is
      // unreadable, a balance with no figure): that is not a value and not a fail.
      if (v.value === null) unreadable = true;
      else return { value: v.value, unit: v.unit, found: true, unreadable: false };
    }
  }
  return { value: null, unit: null, found: false, unreadable };
}

/**
 * Evaluate every objective criterion's `check` in code.
 *
 * Outcome rules, in order:
 *  - the fact is present and comparable: pass or fail by the operator;
 *  - the fact is absent and every document was read cleanly: fail;
 *  - the fact is absent and at least one document was unreadable, failed or
 *    suspicious, or there are no documents at all: insufficient (never a fail);
 *  - the value is not a number where a number is needed, the unit differs from
 *    the criterion's unit, or the unit cannot be converted: insufficient (a
 *    balance in a currency with no stated conversion is not a fail).
 */
export function evaluateObjective(
  rubric: Pick<VisaRubric, "criteria">,
  facts: Facts,
  docs: readonly DocumentExtraction[]
): ObjectiveResult[] {
  const complete = docs.length > 0 && docs.every((d) => d.readable && !d.failed && !d.suspicious);
  return rubric.criteria
    .filter((c) => c.kind === "objective" && c.check)
    .map((c) => {
      const check = c.check!;
      const got = lookup(check.field, facts, docs);
      if (!got.found) {
        if (complete && !got.unreadable) return { criterionId: c.criterionId, outcome: "fail" as const, reason: `${check.field} is not in the documents` };
        return { criterionId: c.criterionId, outcome: "insufficient" as const, reason: `${check.field} could not be read` };
      }
      return compareCheck(c.criterionId, check, got);
    });
}

function compareCheck(
  criterionId: string,
  check: NonNullable<AssessmentCriterion["check"]>,
  got: { value: string | number | boolean | null; unit: string | null }
): ObjectiveResult {
  const insufficient = (reason: string): ObjectiveResult => ({ criterionId, outcome: "insufficient", reason });
  const pass = (ok: boolean, reason: string): ObjectiveResult => ({ criterionId, outcome: ok ? "pass" : "fail", reason });

  if (check.op === "present") return pass(true, `${check.field} is present`);

  if (check.op === "eq") {
    if (typeof check.value === "boolean") {
      if (typeof got.value !== "boolean") return insufficient(`${check.field} is not yes or no`);
      return pass(got.value === check.value, `${check.field} compared`);
    }
    if (typeof check.value === "string") {
      if (typeof got.value !== "string") return insufficient(`${check.field} is not text`);
      return pass(got.value.trim().toLowerCase() === check.value.trim().toLowerCase(), `${check.field} compared`);
    }
  }

  if (typeof got.value !== "number" || typeof check.value !== "number") {
    return insufficient(`${check.field} is not a number`);
  }

  if (check.op === "heldForDays") {
    const days = daysOf(got.value, got.unit);
    if (days === null) return insufficient(`${check.field} period unit cannot be converted`);
    return pass(days >= check.value, `${check.field} compared in days`);
  }

  // gte / lte / eq on numbers. A unit is required when the criterion states one.
  if (check.unit && got.unit !== check.unit) return insufficient(`${check.field} unit is not stated as ${check.unit}`);
  if (check.op === "gte") return pass(got.value >= check.value, `${check.field} compared`);
  if (check.op === "lte") return pass(got.value <= check.value, `${check.field} compared`);
  return pass(got.value === check.value, `${check.field} compared`);
}

/** Name comparison for a holder check: case, spacing and punctuation insensitive. */
function normaliseName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .sort()
    .join(" ");
}

/**
 * Derive the holder fact from extracted `accountHolder` values: true when the
 * holder's name matches the applicant's, false when it does not. Absent when no
 * holder was read. The check reads `funds.holderIsApplicant`.
 */
export function deriveHolderFact(applicantName: string | null, docs: readonly DocumentExtraction[]): Facts {
  if (!applicantName) return {};
  for (const d of docs) {
    if (!d.readable || d.failed || d.suspicious) continue;
    for (const v of d.values) {
      if (v.field === "accountHolder" && typeof v.value === "string" && v.value.trim()) {
        return { "funds.holderIsApplicant": normaliseName(v.value) === normaliseName(applicantName) };
      }
    }
  }
  return {};
}

// ============================================
// Stage 3: judgement (one call)
// ============================================

/** The judgement criteria a stage 3 call is asked about. */
export function judgementCriteriaOf(rubric: Pick<VisaRubric, "criteria">): AssessmentCriterion[] {
  return rubric.criteria.filter((c) => c.kind === "judgement");
}

// ----- Batching (#207): a long rulebook never shrinks, it is split -----

/**
 * Most judgement criteria one stage 3 call is asked about. A rulebook keeps
 * every rule the guidance states, so the rules that apply to ONE applicant can
 * number in the hundreds; one call over all of them would pass the model's
 * output limit (12 000 tokens: about 300 per rule at this size) and fail as a
 * whole. Above this the rules are split into several calls, never dropped.
 */
export const JUDGEMENT_BATCH_MAX_CRITERIA = 40;

/**
 * The order a caseworker applies the stages in (the contract in
 * types/rubric.ts DECISION_STAGES). Written out here, typed against the
 * stage type, because a value import from the rubric module is not allowed
 * outside it (see the boundary test).
 */
const STAGE_ORDER: readonly DecisionStage[] = ["validity", "suitability", "eligibility", "credibility"];

/** Most characters of rule text (titles, factors, quotes) in one stage 3 call. */
export const JUDGEMENT_BATCH_MAX_CHARS = 50_000;

/** Characters one criterion adds to the criteria block of a stage 3 request. */
function criterionBlockChars(c: AssessmentCriterion): number {
  return c.criterionId.length + c.title.length + (c.probeFactors ?? []).join("; ").length + c.source.quote.length + 60;
}

/**
 * Split the judgement criteria of ONE applicant into the groups each stage 3
 * call is asked about. Pure and deterministic: the same criteria always give
 * the same batches, so the same inputs make the same calls.
 *
 *  - criteria are grouped by decision STAGE, in the order a caseworker applies
 *    them (validity, suitability, eligibility, credibility), keeping rubric
 *    order inside a stage: a call reasons about rules of one kind;
 *  - consecutive stage groups share a call while they fit under both limits
 *    (JUDGEMENT_BATCH_MAX_CRITERIA, JUDGEMENT_BATCH_MAX_CHARS), so a short
 *    list is still ONE call, exactly as before;
 *  - a stage group that is over a limit by itself is cut into consecutive
 *    runs that each fit.
 *
 * EVERY input criterion is in exactly one batch (a test asserts it): nothing
 * is truncated. The caller makes one request per batch and keeps the spend
 * caps, so a rulebook too large for the caps fails with the cap error rather
 * than being assessed in part.
 */
export function planJudgementBatches(criteria: readonly AssessmentCriterion[]): AssessmentCriterion[][] {
  const stageRank = (c: AssessmentCriterion) => {
    const i = STAGE_ORDER.indexOf(c.stage);
    return i < 0 ? STAGE_ORDER.length : i;
  };
  // Stable sort by stage (Array.prototype.sort is stable): rubric order inside a stage.
  const ordered = criteria.map((c, i) => ({ c, i })).sort((a, b) => stageRank(a.c) - stageRank(b.c) || a.i - b.i).map((x) => x.c);
  const batches: AssessmentCriterion[][] = [];
  let current: AssessmentCriterion[] = [];
  let chars = 0;
  for (const c of ordered) {
    const size = criterionBlockChars(c);
    const wouldOverflow = current.length >= JUDGEMENT_BATCH_MAX_CRITERIA || (current.length > 0 && chars + size > JUDGEMENT_BATCH_MAX_CHARS);
    if (wouldOverflow) {
      batches.push(current);
      current = [];
      chars = 0;
    }
    current.push(c);
    chars += size;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

/**
 * Combine the validated answers of several stage 3 calls into one, by
 * concatenation in batch order, summing the counters. Each batch's ids were
 * checked against that batch alone, so the union is exactly the criteria asked.
 */
export function mergeJudgementOutputs(outputs: readonly JudgementOutput[]): JudgementOutput {
  return {
    findings: outputs.flatMap((o) => o.findings),
    strengths: outputs.flatMap((o) => o.strengths),
    statementNotes: outputs.flatMap((o) => o.statementNotes),
    suspiciousPassages: [...new Set(outputs.flatMap((o) => o.suspiciousPassages))],
    dropped: outputs.reduce((n, o) => n + o.dropped, 0),
    unanchored: outputs.reduce((n, o) => n + o.unanchored, 0),
  };
}

/** The polarity sentence. Taken from the rubric's decision; never inferred by the model. */
export function polaritySentence(polarity: IntentPolarity | null): string {
  switch (polarity) {
  case "immigrant_intent_penalised":
    return "The route's rules say that showing an intention to settle permanently counts against the applicant.";
  case "dual_intent_permitted":
    return "The route's rules allow a temporary stay alongside a longer-term intention; that intention is not itself a concern.";
  case "not_assessed":
    return "The route's rules do not make intention a factor. Do not raise intention.";
  default:
    return "The route's intent rule has not been decided. Do not raise intention.";
  }
}

/**
 * The stage 3 output schema. Each finding names a judgement criterion by id
 * (enum of the ids sent) and carries a concern flag. There is no field that can
 * express a refusal or an approval, and the code would ignore one.
 */
export function judgementSchema(criterionIds: readonly string[]): Record<string, unknown> {
  const idEnum = [...criterionIds];
  // A statement note also names the numbered block it is about. Only a number:
  // the model never returns a path or a text span (code builds the path).
  const statementNote = {
    type: "object",
    additionalProperties: false,
    required: ["criterionId", "detail", "blockIndex"],
    properties: { criterionId: { type: "string", enum: idEnum }, detail: { type: "string" }, blockIndex: { type: "integer" } },
  };
  const pair = {
    type: "object",
    additionalProperties: false,
    required: ["criterionId", "detail"],
    properties: { criterionId: { type: "string", enum: idEnum }, detail: { type: "string" } },
  };
  return {
    type: "object",
    additionalProperties: false,
    required: ["findings", "strengths", "statementNotes", "suspiciousPassages"],
    properties: {
      findings: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["criterionId", "detail", "whatWouldHelp", "concern"],
          properties: {
            criterionId: { type: "string", enum: idEnum },
            detail: { type: "string" },
            whatWouldHelp: { type: "string" },
            concern: { type: "boolean" },
          },
        },
      },
      strengths: { type: "array", items: pair },
      statementNotes: { type: "array", items: statementNote },
      suspiciousPassages: { type: "array", items: { type: "string" } },
    },
  };
}

const JUDGEMENT_SYSTEM =
  "You weigh an application against the rubric criteria listed below, using the " +
  "factors listed under each criterion. You report concerns and strengths with " +
  "reasons. You do not decide the outcome, do not predict a decision, and do not " +
  "say that an applicant will or will not be approved, refused, granted or likely to " +
  "succeed. Name each criterion only by its id. Quote nothing you have not been given.\n" +
  "The statement is shown as numbered blocks, each line starting [n]. For every " +
  "statement note, set blockIndex to the number n of the one block the note is about. " +
  "Use -1 when the note concerns the statement as a whole or text that is not numbered. " +
  "Never write a path or copy text spans.\n" +
  DATA_ONLY_RULE;

/** Inputs for the stage 3 request. Everything applicant-derived is wrapped. */
export interface JudgementRequestInput {
  rubric: Pick<VisaRubric, "criteria" | "intentPolarity">;
  // Numbered statement blocks (see numberStatementBlocks), or null.
  statementText: string | null;
  // Text of any further statements: unnumbered, so notes on it cannot be anchored.
  otherStatementsText?: string | null;
  profileSummary: string;
  intakeSummary: string;
  extractionSummary: string;
  objectiveSummary: string;
}

/** The statement as sent to the model: numbered text and how many blocks it holds. */
export interface NumberedStatement {
  text: string;
  // Blocks that are actually in `text`. A block cut by the size cap is not
  // counted, so a number the model could never have seen is never accepted.
  sentCount: number;
}

/**
 * Number the TOP-LEVEL blocks of a statement, one `[n] text` line each, n being
 * the block's index in the document's `content` array. Why numbers and not
 * paths or quotes: the model can only point at a block it was shown, and code
 * turns that number into `nodePath` after range-checking it. Empty blocks keep
 * their number (as an empty line) so indexes always match the real document.
 */
export function numberStatementBlocks(blockTexts: readonly string[]): NumberedStatement {
  const lines: string[] = [];
  let used = 0;
  for (let i = 0; i < blockTexts.length; i++) {
    // Sanitise per line so the size check below counts the escaped length.
    const line = `[${i}] ${sanitizeUntrusted(blockTexts[i])}`;
    if (used + line.length + 1 > MAX_UNTRUSTED_CHARS) break;
    lines.push(line);
    used += line.length + 1;
  }
  return { text: lines.join("\n"), sentCount: lines.length };
}

/** Build the stage 3 request. Rubric text is trusted data; applicant text is wrapped. */
export function buildJudgementRequest(input: JudgementRequestInput): LlmRequest {
  const criteria = judgementCriteriaOf(input.rubric);
  const criteriaBlock = criteria
    .map(
      (c) =>
        `- ${c.criterionId} | ${c.title} | factors: ${(c.probeFactors ?? []).join("; ") || "none stated"} | ` +
        `source: "${c.source.quote}"` +
        (c.concernsIntent ? " | concerns intention" : "")
    )
    .join("\n");
  const user =
    `Criteria to weigh:\n${criteriaBlock}\n\n` +
    `Route intent rule: ${polaritySentence(input.rubric.intentPolarity)}\n\n` +
    `Objective results (decided by code):\n${input.objectiveSummary}\n\n` +
    wrapUntrusted(input.profileSummary, "profile") +
    "\n" +
    wrapUntrusted(input.intakeSummary, "intake") +
    "\n" +
    wrapUntrusted(input.extractionSummary, "extraction") +
    "\n" +
    wrapUntrusted(input.statementText ?? "(no statement)", "statement") +
    (input.otherStatementsText ? "\n" + wrapUntrusted(input.otherStatementsText, "other_statement") : "");
  return {
    role: "judgement",
    system: JUDGEMENT_SYSTEM,
    user,
    schema: judgementSchema(criteria.map((c) => c.criterionId)),
    maxOutputTokens: 12_000,
    timeoutMs: 240_000,
    effort: "medium",
  };
}

/**
 * Check a stage 3 answer in code. A shape mismatch returns `ok: false` (the
 * stage fails). A criterion id the rubric does not contain, or a detail that
 * breaks the banned-wording list, drops that one item and counts it.
 */
export function parseJudgement(
  text: string,
  criterionIds: readonly string[],
  // Number of numbered statement blocks that were sent (0 when none).
  statementBlockCount = 0
): { ok: true; output: JudgementOutput } | { ok: false; reason: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, reason: "answer is not JSON" };
  }
  if (!isRecord(parsed)) return { ok: false, reason: "answer is not an object" };
  for (const key of ["findings", "strengths", "statementNotes", "suspiciousPassages"]) {
    if (!Array.isArray(parsed[key])) return { ok: false, reason: `${key} is not an array` };
  }
  const known = new Set(criterionIds);
  let dropped = 0;
  const usable = (text: string): boolean => {
    if (findBannedWording(text)) {
      dropped++;
      return false;
    }
    return true;
  };

  const findings: JudgementOutput["findings"] = [];
  for (const f of parsed.findings as unknown[]) {
    if (!isRecord(f) || typeof f.criterionId !== "string" || typeof f.detail !== "string" || typeof f.whatWouldHelp !== "string" || typeof f.concern !== "boolean") {
      return { ok: false, reason: "a finding breaks the shape" };
    }
    if (!known.has(f.criterionId)) {
      dropped++;
      continue;
    }
    if (!usable(f.detail) || !usable(f.whatWouldHelp)) continue;
    findings.push({ criterionId: f.criterionId, detail: f.detail, whatWouldHelp: f.whatWouldHelp, concern: f.concern });
  }

  const pairs = (list: unknown[], label: string): Array<{ criterionId: string; detail: string }> => {
    const out: Array<{ criterionId: string; detail: string }> = [];
    for (const p of list) {
      if (!isRecord(p) || typeof p.criterionId !== "string" || typeof p.detail !== "string") {
        throw new Error(label);
      }
      if (!known.has(p.criterionId)) {
        dropped++;
        continue;
      }
      if (!usable(p.detail)) continue;
      out.push({ criterionId: p.criterionId, detail: p.detail });
    }
    return out;
  };
  let strengths: Array<{ criterionId: string; detail: string }>;
  let statementNotes: JudgementOutput["statementNotes"];
  let unanchored = 0;
  try {
    strengths = pairs(parsed.strengths as unknown[], "strengths");
    // Notes keep the pair checks (shape, known id, banned wording); the block
    // index is then validated in code. An index that is not an integer inside
    // the document that was sent is dropped to null, never clamped or guessed.
    const rawNotes = parsed.statementNotes as unknown[];
    statementNotes = [];
    for (const raw of rawNotes) {
      const [kept] = pairs([raw], "statementNotes");
      if (!kept) continue;
      const idx = (raw as Record<string, unknown>).blockIndex;
      const valid = typeof idx === "number" && Number.isInteger(idx) && idx >= 0 && idx < statementBlockCount;
      if (!valid) unanchored++;
      statementNotes.push({ ...kept, blockIndex: valid ? (idx as number) : null });
    }
  } catch (err) {
    return { ok: false, reason: `${(err as Error).message} breaks the shape` };
  }

  const suspiciousPassages = (parsed.suspiciousPassages as unknown[]).filter((p): p is string => typeof p === "string");
  return { ok: true, output: { findings, strengths, statementNotes, suspiciousPassages, dropped, unanchored } };
}

// ============================================
// Assembly: containment and citations (code only)
// ============================================

/** A rubric criterion by id, or undefined when the rubric does not contain it. */
export function criterionById(rubric: Pick<VisaRubric, "criteria">, id: string): AssessmentCriterion | undefined {
  return rubric.criteria.find((c) => c.criterionId === id);
}

/** Inputs to the assembly step. Everything here is code output or rubric data. */
export interface AssembleInput {
  rubric: Pick<VisaRubric, "criteria" | "intentPolarity" | "severityLevels">;
  mandatoryHits: AssessmentCriterion[];
  objective: ObjectiveResult[];
  judgement: JudgementOutput | null;
  documents: DocumentExtraction[];
  statementReadable: boolean;
  // The statement the numbered blocks came from (null when none was read).
  statement?: StatementRef | null;
  score: number | null;
  // Documents the statement and extraction saw as addressing the model.
  suspiciousDocumentIds: string[];
  // Judgement was requested but the stage failed: recorded as insufficient on every judgement criterion.
  judgementFailed: boolean;
  // (#207) Judgement ran in several calls and SOME failed: the criteria of
  // the failed calls are recorded as insufficient (the others keep their
  // findings). Never a pass, never a subset reported as the whole.
  unjudgedCriterionIds?: string[];
  // (#207) Criteria whose applicability to this applicant could not be
  // decided (trigger question unanswered, or a specialist rule with no valid
  // trigger). They are in the rubric, so they are reported here as "could not
  // be assessed", not as a failure and not as a pass.
  notAssessed?: InsufficientItem[];
}

/** Why judgement did not run on a route that has judgement criteria. */
const NO_STATEMENT_REASON = "there is no statement or document to weigh";

function groundFrom(c: AssessmentCriterion, detail: string, whatWouldHelp: string): RefusalGround {
  return {
    criterionId: c.criterionId,
    title: c.title,
    kind: c.kind,
    isMandatoryBar: c.kind === "mandatory_bar",
    // Stage comes from the rubric criterion, never from model text (#43).
    stage: c.stage,
    ruleRef: c.ruleRef ?? null,
    sourceUrl: c.source.url,
    sourceQuote: c.source.quote,
    detail,
    whatWouldHelp,
  };
}

/**
 * Build the stored content from the stage results.
 *
 * CONTAINMENT (enforced here, not by the prompt): a refusal ground is produced
 * only from a mandatory bar or a failed objective check. A judgement criterion
 * can only ever become a credibility flag, and only when the model raised a
 * concern on it. A concern on an intention criterion becomes a flag only under
 * `immigrant_intent_penalised`.
 */
export function assembleContent(input: AssembleInput): AssessmentContent {
  const { rubric } = input;
  const refusalGrounds: RefusalGround[] = [];
  const credibilityFlags: CredibilityFlag[] = [];
  const insufficient: InsufficientItem[] = [];
  const strengths: AssessmentContent["strengths"] = [];
  const statementFindings: AssessmentContent["statementFindings"] = [];
  let droppedCount = input.judgement?.dropped ?? 0;
  const unanchoredCount = input.judgement?.unanchored ?? 0;
  const statementRef = input.statement ?? null;

  const seenRefusal = new Set<string>();
  for (const c of input.mandatoryHits) {
    if (seenRefusal.has(c.criterionId)) continue;
    seenRefusal.add(c.criterionId);
    refusalGrounds.push(groundFrom(c, "A mandatory bar applies to this applicant.", "This bar is decided by the rules, not by the documents."));
  }

  for (const r of input.objective) {
    const c = criterionById(rubric, r.criterionId);
    if (!c) {
      droppedCount++;
      continue;
    }
    if (r.outcome === "fail" && !seenRefusal.has(c.criterionId)) {
      seenRefusal.add(c.criterionId);
      refusalGrounds.push(groundFrom(c, r.reason, "Provide evidence that meets this requirement."));
    } else if (r.outcome === "insufficient") {
      insufficient.push({ criterionId: c.criterionId, title: c.title, reason: r.reason });
    }
  }

  // (#207) Rules whose applicability could not be decided are reported, not dropped.
  for (const n of input.notAssessed ?? []) insufficient.push(n);

  let judgementOutcome: StageOutcomes["judgement"] = "not_run";
  const judgementIds = new Set(judgementCriteriaOf(rubric).map((c) => c.criterionId));
  if (input.judgementFailed) {
    for (const id of judgementIds) {
      const c = criterionById(rubric, id)!;
      insufficient.push({ criterionId: id, title: c.title, reason: "the judgement check could not be completed" });
    }
  } else if (!input.judgement && input.mandatoryHits.length === 0) {
    // Judgement was not run because there was nothing to read. Said, not silent.
    for (const id of judgementIds) {
      const c = criterionById(rubric, id)!;
      insufficient.push({ criterionId: id, title: c.title, reason: NO_STATEMENT_REASON });
    }
  } else if (input.judgement) {
    judgementOutcome = "clear";
    // (#207) Criteria of a judgement call that failed while others succeeded.
    for (const id of input.unjudgedCriterionIds ?? []) {
      const c = criterionById(rubric, id);
      if (c) insufficient.push({ criterionId: id, title: c.title, reason: "the judgement check could not be completed" });
    }
    for (const f of input.judgement.findings) {
      const c = criterionById(rubric, f.criterionId);
      if (!c || !f.concern) continue;
      // Only a judgement criterion can be flagged here: a finding the model
      // attached to an objective or bar criterion id is ignored, so model text
      // can never add to, or override, a code-decided rule.
      if (c.kind !== "judgement") continue;
      // THE CONTAINMENT POINT. A judgement criterion produces a credibility
      // flag, never a refusal ground, and this is enforced here in code, not by
      // the prompt. Why: the engine cannot verify genuineness (leaves at the end
      // of the visit, genuine purpose, sufficiency of funds) from documents, so a
      // genuineness concern is a flag for the applicant to address and is never
      // presented as a predicted refusal (plan rule 4). Caseworker guidance does
      // let an officer refuse on genuineness; this product still never tells an
      // applicant they would be refused.
      if (c.concernsIntent && rubric.intentPolarity !== "immigrant_intent_penalised") continue;
      judgementOutcome = "concern";
      credibilityFlags.push({
        criterionId: c.criterionId,
        title: c.title,
        kind: c.kind,
        isMandatoryBar: false,
        // Stage comes from the rubric criterion, never from model text (#43).
        stage: c.stage,
        ruleRef: c.ruleRef ?? null,
        sourceUrl: c.source.url,
        sourceQuote: c.source.quote,
        detail: f.detail,
        whatWouldHelp: f.whatWouldHelp,
      });
    }
    for (const s of input.judgement.strengths) {
      const c = criterionById(rubric, s.criterionId);
      if (c) strengths.push({ criterionId: c.criterionId, title: c.title, detail: s.detail });
    }
    for (const n of input.judgement.statementNotes) {
      const c = criterionById(rubric, n.criterionId);
      // An unknown id was already dropped and counted in parseJudgement; this
      // second check keeps assembly safe on its own.
      if (!c) {
        droppedCount++;
        continue;
      }
      // `comment` is what the portal shows; re-checked here so banned wording
      // can never reach an applicant through the new field.
      if (findBannedWording(n.detail)) {
        droppedCount++;
        continue;
      }
      statementFindings.push({
        criterionId: c.criterionId,
        title: c.title,
        comment: n.detail,
        // Same text, so consumers that read `detail` keep working.
        detail: n.detail,
        // Everything below comes from the rubric criterion, never the model.
        kind: c.kind,
        stage: c.stage,
        ruleRef: c.ruleRef ?? null,
        sourceQuote: c.source.quote,
        sourceUrl: c.source.url,
        severity: c.severity,
        statementVersion: statementRef ? statementRef.version : null,
        // Already range-checked against the blocks sent. Absent when not valid.
        ...(n.blockIndex !== null && statementRef ? { nodePath: [n.blockIndex] } : {}),
      });
    }
  }

  const objectiveFail = input.objective.some((r) => r.outcome === "fail");
  const stageOutcomes: StageOutcomes = {
    mandatoryBar: input.mandatoryHits.length > 0 ? "hit" : rubric.criteria.some((c) => c.kind === "mandatory_bar") ? "clear" : "not_applicable",
    objective:
      objectiveFail ? "fail" : input.objective.some((r) => r.outcome === "insufficient") ? "insufficient" : input.objective.length > 0 ? "clear" : "not_applicable",
    judgement: judgementOutcome,
    credibility: credibilityFlags.length > 0 ? "at_risk" : "clear",
  };

  // (#207) A specialist rule that cannot be tied to any question ("no_trigger")
  // is listed, but cannot be resolved by the applicant either, so it does not
  // lower the band or the confidence (else every applicant on a route with
  // unlinked specialist rules would be capped for something nobody can fix).
  const countable = insufficient.filter((i) => i.notAssessed !== "no_trigger");
  const readiness = readinessFor({
    hit: input.mandatoryHits.length > 0,
    refusalCount: refusalGrounds.length,
    score: input.score,
    insufficientCount: countable.length,
    flagCount: credibilityFlags.length,
    documentCount: input.documents.length,
  });

  const confidence: AssessmentContent["confidence"] =
    countable.length === 0 && input.documents.length > 0 ? "high" : countable.length <= 2 ? "medium" : "low";

  return {
    stageOutcomes,
    refusalGrounds,
    credibilityFlags,
    strengths,
    statementFindings,
    statement: statementRef,
    insufficientInformation: insufficient,
    suspiciousDocumentIds: input.suspiciousDocumentIds,
    score: input.score,
    readiness,
    confidence,
    internalCall: refusalGrounds.length > 0 ? "would_refuse" : "would_approve",
    hasBlockingRule: input.mandatoryHits.length > 0,
    droppedCount,
    unanchoredCount,
  };
}

/**
 * The readiness band, from code-decided facts only. A refusal ground or a
 * mandatory bar makes the application not ready. No documents is weak, not an
 * error. Otherwise the eligibility score sets the band, and an unresolved
 * concern caps it below strong.
 */
export function readinessFor(f: {
  hit: boolean;
  refusalCount: number;
  score: number | null;
  insufficientCount: number;
  flagCount: number;
  documentCount: number;
}): ReadinessBand {
  if (f.hit || f.refusalCount > 0) return "not_ready";
  if (f.documentCount === 0 || f.score === null) return "weak";
  const base: ReadinessBand = f.score >= 75 ? "strong" : f.score >= 50 ? "competitive" : "weak";
  if (base === "strong" && (f.insufficientCount > 0 || f.flagCount > 0)) return "competitive";
  return base;
}

// ============================================
// Top issues (the free tier)
// ============================================

/** One issue the free tier may show: an id and the rubric's own title. */
export interface TopIssue {
  criterionId: string;
  title: string;
}

/**
 * The three issues shown free. Chosen in code: over refusal grounds, credibility
 * flags and insufficient items together, ordered by the rubric's severity scale
 * (most severe first), ties by the order the criteria appear in the rubric.
 * The title is the rubric's, never model text. The model never ranks these.
 */
export function topIssuesOf(rubric: Pick<VisaRubric, "criteria" | "severityLevels">, content: Pick<AssessmentContent, "refusalGrounds" | "credibilityFlags" | "insufficientInformation">): TopIssue[] {
  const candidates = new Set<string>([
    ...content.refusalGrounds.map((g) => g.criterionId),
    ...content.credibilityFlags.map((f) => f.criterionId),
    // (#207) A rule that could not be told to apply is not an "issue" to show.
    ...content.insufficientInformation.filter((i) => !i.notAssessed).map((i) => i.criterionId),
  ]);
  const ranked = [...candidates]
    .map((id) => {
      const idx = rubric.criteria.findIndex((c) => c.criterionId === id);
      const c = rubric.criteria[idx];
      const sev = c ? rubric.severityLevels.indexOf(c.severity) : -1;
      return { id, title: c ? c.title : null, sevRank: sev < 0 ? rubric.severityLevels.length : sev, order: idx < 0 ? Number.MAX_SAFE_INTEGER : idx };
    })
    .filter((r) => r.title !== null)
    .sort((a, b) => a.sevRank - b.sevRank || a.order - b.order);
  return ranked.slice(0, 3).map((r) => ({ criterionId: r.id, title: r.title as string }));
}

// ============================================
// Helpers
// ============================================

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** The model roles the engine uses, for the record. */
export const ENGINE_MODELS = { extract: AI_MODELS.extraction, judge: AI_MODELS.judgement } as const;
