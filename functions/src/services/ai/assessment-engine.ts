import { createHash } from "crypto";
import type { AssessmentCriterion, VisaRubric, IntentPolarity } from "../../scrapers";
import type { DecisionStage } from "../../types/rubric";
import type {
  AssessmentNarrative,
  BlockingRule,
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
// (#234) Group matching from what the applicant holds (pure).
import { decideGroups, factsFromNationality, groupsOf, needWords, type FactNeed, type FactsForRules, type MembershipOnDate } from "./applicant-groups";
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
  // (#308) Only ever set with `outcome: "insufficient"`: the checked field is
  // in no document AND the rulebook names no document item for the rule, so
  // nothing the applicant uploads could settle it. `assembleContent` copies it
  // onto the stored item (`InsufficientItem.notAssessed`), which keeps the rule
  // out of the top issues, the proposed actions, the band and the confidence.
  notAssessed?: "not_in_documents";
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
  // (#308) Null when nothing refuses and the objective checks could not be
  // made (the rulebook names no document for them, an upload is unread, or a
  // field could not be read): code has no basis for a call, so it makes none.
  internalCall: "would_approve" | "would_refuse" | null;
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
  // (#233) Only on a rulebook stack of more than one layer: rulebook key ->
  // approved version. Absent otherwise, so a single-layer hash is unchanged.
  layerVersions?: Record<string, number | null>;
  // Document paths and their `updatedAt` (ms). A changed file changes the hash.
  documents: Array<{ path: string; updatedAtMs: number }>;
  // Statements, by CONTENT hash (see hashStatementContent), not by `version`:
  // a version bump with identical text must not trigger a re-run (#36).
  statements: Array<{ instanceId: string; contentHash: string }>;
  // Eligibility answers, as stored on the latest check (null when none).
  eligibilityAnswers: Record<string, unknown> | null;
  // Intake answers (#113). Empty until that feature stores them.
  intake: Record<string, unknown>;
  // (#234) The application's copy of what the applicant holds, as rules read
  // it (codes, kinds, issuers, dates; never the applicant's note). Only when
  // the application HAS a copy: absent otherwise, so the hash of every
  // application started before #234 is unchanged (no re-run is forced).
  applicantFacts?: {
    nationalities: string[];
    residentialCountry: string | null;
    heldDocuments: Array<{ kind: string; issuer: string | null; validUntil: string }> | null;
  };
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
 * (#234) What code decided about the mandatory bars for one applicant.
 *  - `hits`:    bars the applicant is in the group of, on the bar date (a
 *               refusal ground, decided by code alone).
 *  - `unknown`: bars code could not decide because a fact the group needs is
 *               not stated (or an authority has no recorded members): each is
 *               reported "could not be assessed: we need to know ..." and is
 *               never read as "applies" nor as "does not apply".
 * A bar not in either list was decided "not in the group" from stated facts.
 */
export interface BarDecisions {
  hits: AssessmentCriterion[];
  unknown: Array<{ criterion: AssessmentCriterion; needs: FactNeed[] }>;
}

/**
 * Decide every mandatory bar of a rubric for one applicant. An applicant is in
 * a bar's group when ANY coded member matches (`groupsOf`: the stored
 * `appliesTo.nationalities`, read as `nationality` members, plus #234
 * `appliesTo.groups`: residence, holds, members_of) and the date falls inside
 * `validFrom` / `validUntil`. Several nationalities: any one counts. An
 * expired held document never matches.
 *
 * Kept from before #234, unchanged:
 *  - (#222) only CODED members are decided here; members in
 *    `appliesTo.uncoded` have no code, so `judgementCriteriaOf` puts such a
 *    bar, in full, to the assessment model (never "nobody", never "everybody");
 *  - (#248) a bar served WITHOUT its trigger (`notCodeDecided`) is never
 *    decided here at all (neither a hit nor an "unknown"): it is judged in full.
 * No model call, no network.
 *
 * @param membership members of each `members_of` authority on the
 *   application's start date (missing = no recorded members = unknown)
 */
export function decideMandatoryBars(
  rubric: Pick<VisaRubric, "criteria">,
  facts: FactsForRules,
  applicationDate: string,
  membership: MembershipOnDate = {}
): BarDecisions {
  const out: BarDecisions = { hits: [], unknown: [] };
  for (const c of rubric.criteria) {
    if (c.kind !== "mandatory_bar" || c.appliesTo === undefined) continue;
    // (#248) With no trigger, a group match alone would bar every applicant in the group,
    // including ones the bar's condition does not cover: never decided by code.
    if (c.notCodeDecided === true) continue;
    // Outside the bar's own dates it does not run at all (as before).
    if (!withinBar(c, applicationDate)) continue;
    const groups = groupsOf(c.appliesTo);
    // Only uncoded members: nothing for code to decide (the model judges it, #222).
    if (groups.length === 0) continue;
    const d = decideGroups(groups, facts, applicationDate, membership);
    if (d.status === "match") out.hits.push(c);
    else if (d.status === "unknown") out.unknown.push({ criterion: c, needs: d.needs });
  }
  return out;
}

/**
 * The mandatory bars that apply to this applicant (the `hits` of
 * `decideMandatoryBars`). Accepts a single nationality code, as before #234
 * (null matches nothing), or the applicant's full facts.
 * No model call, no network.
 */
export function mandatoryBarHits(
  rubric: Pick<VisaRubric, "criteria">,
  facts: string | null | FactsForRules,
  applicationDate: string,
  membership: MembershipOnDate = {}
): AssessmentCriterion[] {
  const read = typeof facts === "string" || facts === null ? factsFromNationality(facts) : facts;
  return decideMandatoryBars(rubric, read, applicationDate, membership).hits;
}

/**
 * (#234) The "could not be assessed" items for bars code could not decide,
 * in the shape of `notAssessedItems` (rule-applicability.ts), so they join the
 * same insufficient-information list. Plain words, no verdict.
 */
export function barNotAssessedItems(unknown: BarDecisions["unknown"]): Array<{ criterionId: string; title: string; reason: string; notAssessed: "missing_fact"; layerKey?: string }> {
  return unknown.map((u) => ({
    criterionId: u.criterion.criterionId,
    title: u.criterion.title,
    reason: `could not be assessed: we need to know ${needWords(u.needs)}`,
    notAssessed: "missing_fact" as const,
    ...(u.criterion.layerKey ? { layerKey: u.criterion.layerKey } : {}),
  }));
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
 * (#308) The titles of the rulebook's document items that name each rule
 * (`evidenceItems[].criterionIds`), by criterion id. An applicant's own
 * documents come first (the same order the proposed action uses for its
 * title), then rulebook order; a title is listed once. A rule that is not a
 * key of this map has NO document item: the rulebook never asks anyone for a
 * document that would show it. A rubric with no `evidenceItems` (older
 * versions) gives an empty map.
 */
function documentItemTitlesByCriterion(rubric: Partial<Pick<VisaRubric, "evidenceItems">>): Map<string, string[]> {
  const items = [...(rubric.evidenceItems ?? [])]
    // Stable sort: applicant items first, rulebook order kept inside each party.
    .sort((a, b) => Number(b.party === "applicant") - Number(a.party === "applicant"));
  const byCriterion = new Map<string, string[]>();
  for (const item of items) {
    for (const id of item.criterionIds ?? []) {
      const titles = byCriterion.get(id) ?? [];
      if (!titles.includes(item.title)) titles.push(item.title);
      byCriterion.set(id, titles);
    }
  }
  return byCriterion;
}

/** (#308) The stored reason of a rule that no document item names and no document mentions. */
export const NOT_CHECKABLE_REASON = "not checked: the guidance names no document that would show this";

/**
 * Evaluate every objective criterion's `check` in code.
 *
 * Outcome rules, in order:
 *  - the fact is present and comparable: pass or fail by the operator;
 *  - (#308) the fact is absent and the rulebook names NO document item for the
 *    rule (`evidenceItems[].criterionIds`): insufficient, marked
 *    `notAssessed: "not_in_documents"`, whatever state the documents are in.
 *    WHY: "it is not in your documents" is only a fair failure when the
 *    rulebook asked for a document that would contain it. Rules about an
 *    exclusion order, a paid fee or biometrics name no document, so before
 *    #308 EVERY applicant who uploaded readable documents failed all of them
 *    (35 refusal grounds on one ordinary applicant). Such a rule is recorded as not
 *    checkable from documents, for staff; it is never a refusal ground;
 *  - the fact is absent, a document item names the rule, and every document
 *    was read cleanly: fail, and the reason names the document item(s) by
 *    title, in plain words (never the raw field id);
 *  - the fact is absent and at least one document was unreadable, failed or
 *    suspicious, or there are no documents at all: insufficient (never a fail);
 *  - a document listed the field but its value could not be read: insufficient
 *    (unchanged, with or without a document item: the applicant can re-upload);
 *  - the value is not a number where a number is needed, the unit differs from
 *    the criterion's unit, or the unit cannot be converted: insufficient (a
 *    balance in a currency with no stated conversion is not a fail).
 *
 * A value that WAS read and fails its comparison is a fail exactly as before:
 * only the "field missing" path depends on the document items.
 *
 * @param rubric the criteria to check, and (#308) the rulebook's document
 *   items. `evidenceItems` is optional so a criteria-only caller still
 *   compiles; absent or empty, no missing field can fail.
 */
export function evaluateObjective(
  rubric: Pick<VisaRubric, "criteria"> & Partial<Pick<VisaRubric, "evidenceItems">>,
  facts: Facts,
  docs: readonly DocumentExtraction[]
): ObjectiveResult[] {
  const complete = docs.length > 0 && docs.every((d) => d.readable && !d.failed && !d.suspicious);
  // (#308) Which rules the rulebook asks a document for, and that document's title.
  const itemTitles = documentItemTitlesByCriterion(rubric);
  return rubric.criteria
    .filter((c) => c.kind === "objective" && c.check)
    .map((c) => {
      const check = c.check!;
      const got = lookup(check.field, facts, docs);
      if (!got.found) {
        // The field was listed by a document (or given as a fact) with no
        // readable value: something was there, so this stays "could not be
        // read" (the applicant can act on it), as before #308.
        if (got.unreadable) return { criterionId: c.criterionId, outcome: "insufficient" as const, reason: `${check.field} could not be read` };
        const titles = itemTitles.get(c.criterionId);
        // (#308) No document item names this rule: not checkable from
        // documents. Decided before `complete`, so an unreadable upload does
        // not turn these rules into evidence requests either.
        if (!titles || titles.length === 0) {
          return { criterionId: c.criterionId, outcome: "insufficient" as const, reason: NOT_CHECKABLE_REASON, notAssessed: "not_in_documents" as const };
        }
        // A document item names the rule and every upload was read cleanly:
        // the document the rulebook asks for is missing. A refusal ground.
        if (complete) return { criterionId: c.criterionId, outcome: "fail" as const, reason: `We couldn't find this in your documents: ${titles.join("; ")}` };
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
  // (#222) A bar whose group has members code cannot match (`appliesTo.uncoded`:
  // not a nationality, so no code) is ALSO put to the assessment model, in
  // full, as a judgement: code can only decide the members that have a code
  // (see `mandatoryBarHits`), and the rest must never read as "applies to
  // nobody" nor as "applies to everybody". The model can only raise a concern
  // on it; a refusal on a bar stays decided by code alone.
  // (#248) A bar served without its unconfirmed trigger (`notCodeDecided`) is put to the model
  // the same way, for the whole of its group: code does not decide it at all (see
  // `mandatoryBarHits`), so the model's reading is the only one it gets.
  return rubric.criteria.filter((c) => c.kind === "judgement" || isJudgedBar(c));
}

/** True for a rule whose group names members that are not nationalities (no code to match by). */
export function hasUncodedGroup(c: Pick<AssessmentCriterion, "kind" | "appliesTo">): boolean {
  return c.kind === "mandatory_bar" && (c.appliesTo?.uncoded?.length ?? 0) > 0;
}

/** (#248) True for a bar code does NOT decide: served without its trigger. */
export function isNotCodeDecidedBar(c: Pick<AssessmentCriterion, "kind" | "notCodeDecided">): boolean {
  return c.kind === "mandatory_bar" && c.notCodeDecided === true;
}

/**
 * (#222, #248) True for a bar the assessment model is shown: one with uncoded group members,
 * or one code does not decide at all. Both may only ever become a CONCERN (a credibility flag),
 * never a refusal ground (see `assembleContent`).
 */
export function isJudgedBar(c: Pick<AssessmentCriterion, "kind" | "appliesTo" | "notCodeDecided">): boolean {
  return hasUncodedGroup(c) || isNotCodeDecidedBar(c);
}

/**
 * (#248) What the model is told about a bar that code does not decide: that code does not decide
 * it, the group AS WRITTEN in the source (its own words, coded and uncoded members alike: no code
 * is shown as if it settled anything), and the rule's original condition words, so the model can
 * weigh whether this applicant is one the bar covers. Text from the rubric only (trusted data).
 */
function notCodeDecidedBlock(c: AssessmentCriterion): string {
  const group = [...(c.appliesTo?.asWritten ?? []), ...(c.appliesTo?.uncoded ?? [])];
  return (
    " | mandatory bar NOT decided by code (which applicants it covers was not confirmed): weigh whether it applies to this applicant and raise a concern if it does" +
    ` | group as written: ${group.join("; ") || "none stated"}` +
    ` | applies when: ${c.applicabilityCondition ? `"${c.applicabilityCondition}"` : "not stated (read the source)"}`
  );
}

/** The rule's own text as the model is shown it: the quote, then any list lines under a lead-in (#222). */
function ruleSourceText(c: Pick<AssessmentCriterion, "source">): string {
  const items = c.source.listItems ?? [];
  return items.length > 0 ? `${c.source.quote} ${items.join(" ")}` : c.source.quote;
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
  // (#248) A bar code does not decide also carries its group as written and its condition words.
  const judgedExtra = isNotCodeDecidedBar(c) ? notCodeDecidedBlock(c).length : 0;
  return c.criterionId.length + c.title.length + (c.probeFactors ?? []).join("; ").length + ruleSourceText(c).length + (c.appliesTo?.uncoded ?? []).join("; ").length + judgedExtra + 60;
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
        `source: "${ruleSourceText(c)}"` +
        // (#248) A bar code does not decide gets its own block (group as written + condition words);
        // a bar with uncoded members that code still decides for its coded members keeps the #222 text.
        (isNotCodeDecidedBar(c)
          ? notCodeDecidedBlock(c)
          : hasUncodedGroup(c)
            ? ` | group (code matches only its nationalities ${(c.appliesTo?.nationalities ?? []).join(", ") || "none"}; also named, with no code: ${(c.appliesTo?.uncoded ?? []).join("; ")})`
            : "") +
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
// Uploads that were not read (#308)
// ============================================

/**
 * The `failure` text the job gives a document it did NOT send to a model
 * because the rulebook has no document field to read at all. Such an upload is
 * not "unreadable" (nobody tried to read it), so it is never reported to the
 * applicant as one. The job uses this constant; the bulk path writes the same
 * text (services/ai-bulk-reassessment.service.ts), so keep the two equal.
 */
export const NO_FIELD_TO_READ = "no field to read";

/** Prefix of the id an unread-upload item carries in place of a rule id. */
const UNREAD_DOCUMENT_ID_PREFIX = "document:";

/**
 * The `failure` text the job gives a file over the size limit (it is never
 * sent to a model). The bulk path writes the same text, so keep the two equal.
 */
export const FILE_TOO_LARGE = "file is larger than the limit";

/** What the applicant is told about an upload that could not be read. Fixed text, never model text. */
export const UNREAD_DOCUMENT_REASON = "We couldn't read this upload, so nothing in it was checked. Upload a clearer copy.";

/** The same for an upload whose content cannot be relied on (it addressed the reader instead of stating facts). */
export const UNUSABLE_DOCUMENT_REASON = "We couldn't use this upload, so nothing in it was checked. Upload a clean copy of the original document.";

/** The same for a file over the size limit: a clearer copy would not help, a smaller file does. */
export const TOO_LARGE_DOCUMENT_REASON = "This file is too large for us to read, so nothing in it was checked. Upload a smaller file.";

/** Longest document label copied into an item title. */
const MAX_DOCUMENT_LABEL = 80;

/**
 * (#308) The uploads whose content reached NO check: unreadable (too large,
 * unsupported, password protected, not readable), failed (the reading broke
 * its contract or the call failed) or flagged suspicious. An upload that was
 * simply not sent because the rulebook reads no document field is left out.
 */
export function unreadDocumentsOf(documents: readonly DocumentExtraction[]): DocumentExtraction[] {
  return documents.filter((d) => (!d.readable || d.failed || d.suspicious) && d.failure !== NO_FIELD_TO_READ);
}

/**
 * (#308) One applicant-facing item per unread upload, independent of any rule.
 * WHY: before #308 an applicant heard about an unreadable upload only through
 * rules going "could not be read". Rules no document item names no longer do
 * that, so without this item an unreadable upload could go unmentioned.
 *
 *  - `criterionId` is `document:<documentId>` (no rule is involved; the id is
 *    unique per upload, so two unread uploads never share a key);
 *  - `title` is what the applicant recognises the upload by: the name the
 *    caller gives for it in `names` (checklist item, display name or file
 *    name), else the upload's code label, else "document";
 *  - `documentId` marks the item as being about an upload, not a rule;
 *  - NO `notAssessed` marker: the applicant CAN act on it (upload again), so it
 *    is listed, gets one proposed action, and counts against the band and the
 *    confidence like any other open item.
 *
 * @param names applicant-facing name per document id. Kept apart from
 *   `DocumentExtraction.label`, which is a code label sent to the model and
 *   must never be the name the applicant typed.
 */
export function unreadDocumentItems(documents: readonly DocumentExtraction[], names: Readonly<Record<string, string>> = {}): InsufficientItem[] {
  return unreadDocumentsOf(documents).map((d) => ({
    criterionId: `${UNREAD_DOCUMENT_ID_PREFIX}${d.documentId}`,
    title: ((names[d.documentId] ?? "").trim() || d.label || "document").slice(0, MAX_DOCUMENT_LABEL),
    reason: d.suspicious ? UNUSABLE_DOCUMENT_REASON : d.failure === FILE_TOO_LARGE ? TOO_LARGE_DOCUMENT_REASON : UNREAD_DOCUMENT_REASON,
    documentId: d.documentId,
  }));
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
  // (#308) `evidenceItems` (optional) tells assembly whether the rulebook names
  // a document for ANY objective rule; absent is read as "names none".
  rubric: Pick<VisaRubric, "criteria" | "intentPolarity" | "severityLevels"> & Partial<Pick<VisaRubric, "evidenceItems">>;
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
  // (#308) Applicant-facing name of each upload, by document id (the checklist
  // item it was uploaded to, its display name or its file name). Used only as
  // the title of a "we couldn't read this upload" item. Optional: without it
  // the upload's code label is used.
  documentNames?: Record<string, string>;
}

/**
 * (#233) "Findings carry their layer": the rulebook layer of a rule, copied
 * from the rubric in code (never model text), spread into every finding made
 * from it. Empty for a single-layer rulebook (no `layerKey`), so those results
 * are exactly as before.
 */
function layerOf(c: Pick<AssessmentCriterion, "layerKey">): { layerKey?: string } {
  return c.layerKey ? { layerKey: c.layerKey } : {};
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
    ...layerOf(c),
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

  // (#308) An upload that could not be read is always said, first in the list,
  // whether or not any rule names the document.
  const unreadItems = unreadDocumentItems(input.documents, input.documentNames);
  insufficient.push(...unreadItems);

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
      // (#308) A rule that is not checkable from documents keeps its marker,
      // so it is stored for staff but never treated as something to fix.
      insufficient.push({ criterionId: c.criterionId, title: c.title, reason: r.reason, ...(r.notAssessed ? { notAssessed: r.notAssessed } : {}), ...layerOf(c) });
    }
  }

  // (#207) Rules whose applicability could not be decided are reported, not dropped.
  for (const n of input.notAssessed ?? []) insufficient.push(n);

  let judgementOutcome: StageOutcomes["judgement"] = "not_run";
  const judgementIds = new Set(judgementCriteriaOf(rubric).map((c) => c.criterionId));
  if (input.judgementFailed) {
    for (const id of judgementIds) {
      const c = criterionById(rubric, id)!;
      insufficient.push({ criterionId: id, title: c.title, reason: "the judgement check could not be completed", ...layerOf(c) });
    }
  } else if (!input.judgement && input.mandatoryHits.length === 0) {
    // Judgement was not run because there was nothing to read. Said, not silent.
    for (const id of judgementIds) {
      const c = criterionById(rubric, id)!;
      insufficient.push({ criterionId: id, title: c.title, reason: NO_STATEMENT_REASON, ...layerOf(c) });
    }
  } else if (input.judgement) {
    judgementOutcome = "clear";
    // (#207) Criteria of a judgement call that failed while others succeeded.
    for (const id of input.unjudgedCriterionIds ?? []) {
      const c = criterionById(rubric, id);
      if (c) insufficient.push({ criterionId: id, title: c.title, reason: "the judgement check could not be completed", ...layerOf(c) });
    }
    for (const f of input.judgement.findings) {
      const c = criterionById(rubric, f.criterionId);
      if (!c || !f.concern) continue;
      // Only a judgement criterion can be flagged here: a finding the model
      // attached to an objective or bar criterion id is ignored, so model text
      // can never add to, or override, a code-decided rule.
      // (#248) EXTENDED, not loosened: a bar the model was SHOWN as a judgement
      // (`isJudgedBar`: uncoded members, or served without its trigger so code does
      // not decide it) may also become a concern. Before, such a concern was dropped
      // here, so "the model can raise a concern on it" had no effect at all and a
      // barred applicant code cannot match heard nothing. It is still never a refusal
      // ground and never touches `mandatoryHits`: what code decided stays exactly as
      // code decided it, and the model cannot clear it. A bar code already refused on
      // for this applicant is not flagged twice. Objective criteria and bars the model
      // was not shown stay ignored (pinned by tests).
      const judgedBar = c.kind === "mandatory_bar" && isJudgedBar(c);
      if (c.kind !== "judgement" && !judgedBar) continue;
      if (judgedBar && seenRefusal.has(c.criterionId)) continue;
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
        // (#248) True only for a judged bar's concern: staff can tell a concern about a bar
        // from an ordinary one. It is still a FLAG (no refusal ground, no `hasBlockingRule`).
        isMandatoryBar: judgedBar,
        // Stage comes from the rubric criterion, never from model text (#43).
        stage: c.stage,
        ruleRef: c.ruleRef ?? null,
        sourceUrl: c.source.url,
        sourceQuote: c.source.quote,
        detail: f.detail,
        whatWouldHelp: f.whatWouldHelp,
        ...layerOf(c),
      });
    }
    for (const s of input.judgement.strengths) {
      const c = criterionById(rubric, s.criterionId);
      if (c) strengths.push({ criterionId: c.criterionId, title: c.title, detail: s.detail, ...layerOf(c) });
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
        ...layerOf(c),
      });
    }
  }

  // (#308) The objective stage is read from the checks code could actually
  // make. A rule marked "not in documents" was not checked at all (like a rule
  // split out as "could not tell whether it applies", which never reaches
  // `input.objective`), so it neither makes the stage "insufficient" nor
  // counts as a check that came out clear.
  const objectiveChecked = input.objective.filter((r) => !r.notAssessed);
  const objectiveFail = objectiveChecked.some((r) => r.outcome === "fail");
  const objectiveFromChecks: StageOutcomes["objective"] =
    objectiveFail ? "fail" : objectiveChecked.some((r) => r.outcome === "insufficient") ? "insufficient" : objectiveChecked.length > 0 ? "clear" : "not_applicable";
  // (#308) While any upload is unread the stage cannot read "clear" (nor
  // "nothing to check"): what that upload holds was never compared.
  const objectiveOutcome: StageOutcomes["objective"] =
    unreadItems.length > 0 && (objectiveFromChecks === "clear" || objectiveFromChecks === "not_applicable") ? "insufficient" : objectiveFromChecks;
  // (#308) THE DOCUMENTS ARE UNGUARDED: at least one objective rule came out
  // "not in documents", and the rulebook names a document for NONE of the
  // objective rules this applicant is assessed on (an older rulebook with no
  // document items at all, or one whose items name only other rules). On such
  // a rulebook code can never say "a document you were asked for is missing":
  // every missing field, core ones included, is only ever marked. One field
  // that happens to be read and pass says nothing about the rest, so the
  // result must not read better than what was checked: see the three caps
  // below. (This also covers "not one rule could be checked".)
  //
  // Why this boundary and not "any marked rule": on a rulebook that DOES name
  // documents for its objective rules, the named rules guard the documents it
  // asks for (a missing one is a refusal ground) and the marked ones are side
  // rules nobody can evidence; capping there would hold back every applicant,
  // however complete. A fully checked application (no marked rule) is never
  // capped on any rulebook.
  const namedByAnItem = new Set((rubric.evidenceItems ?? []).flatMap((e) => e.criterionIds ?? []));
  const anyObjectiveRuleNamed = rubric.criteria.some((c) => c.kind === "objective" && c.check && namedByAnItem.has(c.criterionId));
  const documentsUnguarded = !anyObjectiveRuleNamed && input.objective.some((r) => r.notAssessed === "not_in_documents");
  const stageOutcomes: StageOutcomes = {
    mandatoryBar: input.mandatoryHits.length > 0 ? "hit" : rubric.criteria.some((c) => c.kind === "mandatory_bar") ? "clear" : "not_applicable",
    objective: objectiveOutcome,
    judgement: judgementOutcome,
    credibility: credibilityFlags.length > 0 ? "at_risk" : "clear",
  };

  // (#207) A specialist rule that cannot be tied to any question ("no_trigger")
  // is listed, but cannot be resolved by the applicant either, so it does not
  // lower the band or the confidence (else every applicant on a route with
  // unlinked specialist rules would be capped for something nobody can fix).
  // (#308) The same holds for a rule no document item names
  // ("not_in_documents"): no upload or answer of the applicant's can settle
  // it, so it must not cap the band or the confidence either.
  const countable = insufficient.filter((i) => !isNotActionableMarker(i.notAssessed));
  // An unread upload's item has no marker, so it is in `countable`: it caps a
  // "strong" band at "competitive" and keeps the confidence below "high".
  const bandFromFacts = readinessFor({
    hit: input.mandatoryHits.length > 0,
    refusalCount: refusalGrounds.length,
    score: input.score,
    insufficientCount: countable.length,
    flagCount: credibilityFlags.length,
    documentCount: input.documents.length,
  });
  // (#308) Cap 1: the documents are unguarded, so never "strong".
  const readiness: ReadinessBand = documentsUnguarded && bandFromFacts === "strong" ? "competitive" : bandFromFacts;

  const confidenceFromItems: AssessmentContent["confidence"] =
    countable.length === 0 && input.documents.length > 0 ? "high" : countable.length <= 2 ? "medium" : "low";
  // (#308) Cap 2: the documents are unguarded, so never "high".
  const confidence: AssessmentContent["confidence"] = documentsUnguarded && confidenceFromItems === "high" ? "medium" : confidenceFromItems;

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
    // (#308) Cap 3: "no refusal ground" is a basis for "would approve" only
    // when the objective checks could be made. No call is made (null, for
    // staff to see) when the documents are unguarded, and when the objective
    // stage is "insufficient": an upload is unread, or a checked field could
    // not be read, so nothing says the applicant passes.
    internalCall: refusalGrounds.length > 0 ? "would_refuse" : documentsUnguarded || objectiveOutcome === "insufficient" ? null : "would_approve",
    hasBlockingRule: input.mandatoryHits.length > 0,
    droppedCount,
    unanchoredCount,
  };
}

/**
 * (#207, #308) True for the two "could not assess" markers the applicant can do
 * NOTHING about: a specialist rule the guidance did not tie to a question
 * (`no_trigger`) and a rule no document item names (`not_in_documents`). Items
 * with either marker are stored, but do not lower the band or the confidence.
 * (`unanswered` and `missing_fact` items DO count: the applicant can answer.)
 */
export function isNotActionableMarker(marker: InsufficientItem["notAssessed"]): boolean {
  return marker === "no_trigger" || marker === "not_in_documents";
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
    // (#308) Nor is a rule that is not checkable from documents
    // (`notAssessed: "not_in_documents"`): ANY marker keeps an item out.
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
// Blocking rule (#384): never paywalled, never model text
// ============================================

/**
 * The mandatory bar that stops the review, copied from the FIRST mandatory-bar
 * refusal ground. Every field is rubric text that `groundFrom` copied from the
 * criterion, so nothing here is model-written. Null when no bar applies.
 *
 * Used twice: by the job when it stores a result, and by the serializer for a
 * document stored before #384 (no `blockingRule` key), so both agree.
 */
export function blockingRuleOf(refusalGrounds: ReadonlyArray<Pick<RefusalGround, "criterionId" | "title" | "isMandatoryBar" | "ruleRef" | "sourceQuote" | "sourceUrl">> | null | undefined): BlockingRule | null {
  const bar = (refusalGrounds ?? []).find((g) => g && g.isMandatoryBar === true);
  if (!bar) return null;
  // A whitelist copy: exactly the five keys, whatever else the ground carries.
  return { criterionId: bar.criterionId, title: bar.title, ruleRef: bar.ruleRef ?? null, sourceQuote: bar.sourceQuote, sourceUrl: bar.sourceUrl };
}

// ============================================
// Narrative (#384): one call after assembly, checked in code
// ============================================
//
// After the findings are assembled, the interactive worker makes ONE more
// model call that writes a short, plain-English reading of the applicant's
// own application in a caseworker's reasoning style: what they told us, what
// their documents show, where the two conflict or fall short, how convincing
// the whole picture is, a conclusion that agrees with the band, and what would
// change it. The rule-by-rule working stays in the findings (which a client
// caller only gets with `ai.review_working`, see tier-serializer.ts).
//
// "Grounded or not shown": the model's answer is never trusted as is. Every
// string (paragraph, conclusion, next step) goes through four code checks and
// is DROPPED when it fails one:
//   1. banned wording (findBannedWording, the #43 list, unchanged);
//   2. injection (findInjectionSignals; counted as suspicious content);
//   3. figures: every number in it must appear in the applicant inputs or the
//      rubric text sent to the call (no conversion, no estimate, no rounding);
//   4. quotations: text in double or curly quotes must be a verbatim substring
//      of a rule's quoted wording or of the applicant inputs.
// The conclusion has one more check: it must open with the form its band asks
// for (so it always agrees with the band). No conclusion or no paragraph left
// means no narrative at all (null). A shape mismatch is also null.

/** The narrative's limits. Enforced in code (the schema sent does not carry them). */
export const NARRATIVE_LIMITS = {
  minParagraphs: 1,
  maxParagraphs: 6,
  maxParagraphChars: 700,
  maxConclusionChars: 400,
  maxNextSteps: 5,
  maxNextStepChars: 200,
} as const;

/**
 * The opening each band's conclusion must use. The negative form is the one
 * the founder chose on #384: the #43 banned-wording guard rejects "is
 * unlikely", so "an officer is unlikely to be satisfied" is NOT used. Neither
 * form names an outcome, a likelihood or a verdict.
 */
export const NARRATIVE_CONCLUSION_LEADS: Readonly<Record<ReadinessBand, string>> = {
  not_ready: "As things stand, what you have sent is not yet enough for an officer to be satisfied that",
  weak: "As things stand, what you have sent is not yet enough for an officer to be satisfied that",
  competitive: "As things stand, what you have sent goes a long way towards satisfying an officer that",
  strong: "As things stand, what you have sent gives an officer a clear basis to be satisfied that",
};

/**
 * The narrative output schema: exactly three keys. Lengths and counts are NOT
 * in the schema (structured output does not reliably enforce them); they are
 * stated in the prompt and checked in `parseNarrative`.
 */
export function narrativeSchema(): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: ["paragraphs", "conclusion", "nextSteps"],
    properties: {
      paragraphs: { type: "array", items: { type: "string" } },
      conclusion: { type: "string" },
      nextSteps: { type: "array", items: { type: "string" } },
    },
  };
}

/**
 * The system prompt. Stable (no per-request data), so it can be cached. It
 * asks for the reasoning style of a caseworker's refusal-letter reasoning
 * (statements set against documents, conflicts and gaps, whether the evidence
 * is conclusive, comprehensive and convincing), never for a decision.
 */
export const NARRATIVE_SYSTEM =
  "You write, for an applicant, a short reading of their OWN visa application in the way an " +
  "experienced entry clearance officer reasons when weighing one. You do not decide it.\n" +
  "How to reason:\n" +
  "- Start from what the applicant told us (their answers, profile and statement), then set it " +
  "against what their documents show. Say plainly where the two agree, where they conflict, and " +
  "where something an officer would expect to see is missing. For example: the applicant says they " +
  "spend a fixed amount each month, but their bank statements show spending well above it; or they " +
  "say they have rented for years, but there is no tenancy agreement and no rent payments on the " +
  "statements.\n" +
  "- Weigh whether the evidence, taken together, is conclusive, comprehensive and convincing. Say " +
  "which parts are and which are not, and why.\n" +
  "- Reason about the applicant's own facts and documents. Name or briefly quote a rule only where it " +
  "matters to the point you are making, at most once. Never list the rules or go through them one by " +
  "one: the reading is about the applicant, not the rulebook.\n" +
  "- Use only the facts given below. Copy every figure, date and amount exactly as given, in the " +
  "currency it was given in. Never convert a currency, estimate, round, add up or work out an amount " +
  "that is not written in the data.\n" +
  "- Put text in double quotes only when it is copied word for word from the data or from a rule's " +
  "quoted wording.\n" +
  "How to write:\n" +
  `- Second person ("you", "your"), plain English, short sentences. ${NARRATIVE_LIMITS.minParagraphs} to ${NARRATIVE_LIMITS.maxParagraphs} paragraphs, ` +
  `each at most ${NARRATIVE_LIMITS.maxParagraphChars} characters.\n` +
  "- Never say or suggest that the application will or would be refused, approved or granted. Never " +
  "mention chances, odds, likelihood, probability, a score, a verdict or a prediction, and do not use " +
  "the words likely or unlikely.\n" +
  `- conclusion: one or two sentences, at most ${NARRATIVE_LIMITS.maxConclusionChars} characters, that agree with the readiness ` +
  "band you are given. It MUST begin with the exact opening for that band and then finish the sentence " +
  "with the main point (for a not_ready or weak band: the main thing not yet shown):\n" +
  `  not_ready or weak: "${NARRATIVE_CONCLUSION_LEADS.not_ready} ..."\n` +
  `  competitive: "${NARRATIVE_CONCLUSION_LEADS.competitive} ..."\n` +
  `  strong: "${NARRATIVE_CONCLUSION_LEADS.strong} ..."\n` +
  `- nextSteps: up to ${NARRATIVE_LIMITS.maxNextSteps} concrete things the applicant could do that would change this reading, ` +
  `each at most ${NARRATIVE_LIMITS.maxNextStepChars} characters, taken from the gaps you described. An empty list when nothing would.\n` +
  "- Do not number the paragraphs or the steps, and use no headings or markdown.\n" +
  DATA_ONLY_RULE;

/** The findings the narrative is given: the assembled content, as stored. */
export type NarrativeFindings = Pick<AssessmentContent, "refusalGrounds" | "credibilityFlags" | "statementFindings" | "insufficientInformation" | "strengths">;

/** Inputs for the narrative request. Everything applicant-derived is wrapped. */
export interface NarrativeRequestInput {
  // The band the code decided. The conclusion must agree with it.
  readiness: ReadinessBand;
  findings: NarrativeFindings;
  // The same summaries the judgement call was given (applicant-derived).
  profileSummary: string;
  intakeSummary: string;
  extractionSummary: string;
  // Every statement's plain text (null when none).
  statementText: string | null;
  // (#408) Extra facts for the FIGURE check only. `buildNarrativeRequest`
  // never reads this field, so the text sent to the model (and its recorded
  // request hash) is the same with or without it. Optional: without it the
  // figure check reads `extractionSummary` as sent (unitless document values
  // stay bare, which fails closed).
  figureFacts?: NarrativeFigureFacts;
}

/**
 * (#408) What the figure check needs about the document values, beyond the
 * extraction summary's text: each value with its field and unit, and which
 * fields hold money. With these, a unitless value on a money field is read in
 * the application's declared currency (see `declaredCurrencyOf`), and a unit
 * written in lowercase or as a sign ("gbp", "£") is read as its ISO code.
 */
export interface NarrativeFigureFacts {
  // The values the extraction summary was built from, in the same order and
  // with the same filter (readable, not failed, not suspicious documents).
  values: ReadonlyArray<Pick<ExtractedValue, "field" | "value" | "unit" | "page">>;
  // The document fields an objective rubric check reads with a currency unit
  // (`moneyFieldsFor`). Only these take the declared currency.
  moneyFields: readonly string[];
}

/** The trusted rule text of one finding: rubric wording only. */
function ruleLine(tag: string, f: { title: string; ruleRef?: string | null; sourceQuote?: string }): string {
  return `[${tag}] rule: ${f.title}${f.ruleRef ? ` | ref: ${f.ruleRef}` : ""}${f.sourceQuote ? ` | published wording: "${f.sourceQuote}"` : ""}`;
}

/**
 * The open items the narrative may talk about: the insufficient-information
 * items the applicant can act on. Items with a not-actionable marker
 * (`no_trigger`, `not_in_documents`) are left out, as on every other
 * applicant surface (they are stored for staff).
 */
function actionableInsufficient(items: readonly InsufficientItem[]): InsufficientItem[] {
  return items.filter((i) => !isNotActionableMarker(i.notAssessed));
}

/**
 * Build the narrative request. Rubric text (titles, rule refs, published
 * wording) is trusted data and goes in the plain part. Everything derived from
 * the applicant (their answers, profile, documents, statement, and the finding
 * details, which describe the applicant's facts) goes through `wrapUntrusted`,
 * and the system prompt carries DATA_ONLY_RULE.
 */
export function buildNarrativeRequest(input: NarrativeRequestInput): LlmRequest {
  const f = input.findings;
  const ruleLines: string[] = [];
  const detailLines: string[] = [];
  // Refusal grounds and credibility flags: what does not meet a rule, and what an officer would doubt.
  f.refusalGrounds.forEach((g, i) => {
    ruleLines.push(`${ruleLine(`R${i + 1}`, g)} | kind: does not meet the rule yet`);
    detailLines.push(`[R${i + 1}] what we found: ${g.detail} | what would help: ${g.whatWouldHelp}`);
  });
  f.credibilityFlags.forEach((c, i) => {
    ruleLines.push(`${ruleLine(`C${i + 1}`, c)} | kind: a point an officer would weigh`);
    detailLines.push(`[C${i + 1}] what we found: ${c.detail} | what would help: ${c.whatWouldHelp}`);
  });
  f.statementFindings.forEach((s, i) => {
    ruleLines.push(`${ruleLine(`N${i + 1}`, s)} | kind: about the statement`);
    detailLines.push(`[N${i + 1}] what we found: ${s.comment}`);
  });
  actionableInsufficient(f.insufficientInformation).forEach((u, i) => {
    ruleLines.push(`[U${i + 1}] could not be told yet: ${u.title}`);
    detailLines.push(`[U${i + 1}] why: ${u.reason}`);
  });
  f.strengths.forEach((s, i) => {
    ruleLines.push(`[S${i + 1}] a strength: ${s.title}`);
    detailLines.push(`[S${i + 1}] what we found: ${s.detail}`);
  });
  const user =
    `Readiness band (decided by code; the conclusion must agree with it): ${input.readiness}\n` +
    `Required opening of the conclusion: "${NARRATIVE_CONCLUSION_LEADS[input.readiness]}"\n\n` +
    `Findings, with the rule each one is about (rule wording copied from the published guidance):\n${ruleLines.join("\n") || "(none)"}\n\n` +
    wrapUntrusted(detailLines.join("\n") || "(none)", "findings") +
    "\n" +
    wrapUntrusted(input.profileSummary, "profile") +
    "\n" +
    wrapUntrusted(input.intakeSummary, "intake") +
    "\n" +
    wrapUntrusted(input.extractionSummary || "(no values read from documents)", "extraction") +
    "\n" +
    wrapUntrusted(input.statementText ?? "(no statement)", "statement");
  return {
    role: "narrative",
    system: NARRATIVE_SYSTEM,
    user,
    schema: narrativeSchema(),
    maxOutputTokens: 4_000,
    timeoutMs: NARRATIVE_TIMEOUT_MS,
    effort: "medium",
  };
}

/** Wall-clock budget of the narrative call. The job skips the call when less than this is left. */
export const NARRATIVE_TIMEOUT_MS = 90_000;

/**
 * What a narrative string may be grounded in:
 *  - `figureSources`: the applicant inputs AND the rubric text sent to the call
 *    (titles, rule refs, published wording). A number in the narrative must be
 *    in one of these;
 *  - `quoteSources`: the rubric's published wording (`sourceQuote`) AND the
 *    applicant inputs. Quoted text must be a verbatim substring of one.
 * Model-written finding details are deliberately NOT a source: they were
 * written by a model too, so a figure in them is not proof of anything.
 */
export interface NarrativeGrounding {
  figureSources: string[];
  quoteSources: string[];
  // (#384, fix round 1) The rubric rules the narrative was given, by their
  // ref and published wording. Used to COUNT rule citations (see
  // `ruleCitationsIn`): the narrative must explain, not list the rulebook,
  // which is what `ai.review_working` sells. Optional so a caller that only
  // checks figures and quotes can leave it out (no rule is then recognised by
  // ref or wording; generic "rule 4.2" patterns are still counted).
  rules?: NarrativeRuleRef[];
}

/** (#384) One rubric rule a narrative might cite: its ref and its published wording (either may be absent). */
export interface NarrativeRuleRef {
  ref: string | null;
  quote: string | null;
}

/** The grounding for one narrative request, from the same inputs the request was built from. */
export function narrativeGroundingOf(input: NarrativeRequestInput): NarrativeGrounding {
  const f = input.findings;
  const ruled = [...f.refusalGrounds, ...f.credibilityFlags, ...f.statementFindings];
  const applicant = [input.profileSummary, input.intakeSummary, input.extractionSummary, input.statementText ?? ""];
  const quotes = ruled.map((r) => r.sourceQuote).filter(Boolean);
  const rubricText = [
    ...ruled.flatMap((r) => [r.title, r.ruleRef ?? ""]),
    ...actionableInsufficient(f.insufficientInformation).map((u) => u.title),
    ...f.strengths.map((s) => s.title),
    ...quotes,
  ];
  // (#384, fix round 1) The intake is sent as JSON, where an amount answer is
  // `{"amount":399367,"currency":"NGN"}`: the number and its currency are not
  // next to each other, so `figuresIn` would read the number with NO currency
  // and any currency label in the narrative would pass. For the FIGURE check
  // the intake is therefore re-written with each amount labelled
  // ("399367 NGN"). The quote check keeps the text exactly as sent.
  // (#408) The document values the same way: when the caller gave the values
  // with their fields and units, the figure check reads a labelled copy of
  // the extraction summary (see `labelExtractedValues`) INSTEAD of the text as
  // sent, so a money value carries its currency. Without them, the summary is
  // read as sent (unitless values stay bare: fail closed).
  const figureExtraction = input.figureFacts
    ? labelExtractedValues(input.figureFacts, declaredCurrencyOf(input.intakeSummary))
    : input.extractionSummary;
  const figureApplicant = [input.profileSummary, labelIntakeAmounts(input.intakeSummary), figureExtraction, input.statementText ?? ""];
  const rules: NarrativeRuleRef[] = ruled.map((r) => ({ ref: r.ruleRef ?? null, quote: r.sourceQuote || null }));
  return { figureSources: [...figureApplicant, ...rubricText], quoteSources: [...quotes, ...applicant], rules };
}

/**
 * (#408) Every amount answer in the intake (`{ amount: number, currency:
 * string }`, types/intake.ts), nested ones included: the same walk as
 * `labelIntakeAmounts`. Returns each answer's currency, trimmed and
 * upper-cased ("gbp" reads as "GBP"). Not JSON: none.
 */
function intakeAmountCurrencies(intakeSummary: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(intakeSummary);
  } catch {
    return [];
  }
  const out: string[] = [];
  /** Walk the answers depth-first, collecting each amount answer's currency. */
  const walk = (v: unknown): void => {
    if (isRecord(v) && typeof v.amount === "number" && typeof v.currency === "string") {
      out.push(v.currency.trim().toUpperCase());
    } else if (Array.isArray(v)) {
      v.forEach(walk);
    } else if (isRecord(v)) {
      Object.values(v).forEach(walk);
    }
  };
  walk(parsed);
  return out;
}

/**
 * (#408) The declared currency of an application: the ONE currency every
 * intake amount answer uses. Null when there is no amount answer, or when they
 * use two or more currencies (no guess is made, so a unitless document value
 * then stays bare: fail closed). The profile country is deliberately NOT a
 * fallback: where someone lives says nothing about the currency of a bank
 * letter, and the charge-currency mapping falls back to NGN.
 *
 * @param intakeSummary the intake as sent to the model (`JSON.stringify` of the answers)
 */
export function declaredCurrencyOf(intakeSummary: string): string | null {
  const currencies = new Set(intakeAmountCurrencies(intakeSummary).filter(Boolean));
  return currencies.size === 1 ? [...currencies][0] : null;
}

/**
 * (#408) The ISO code a unit names, when it names a currency: an ISO code in
 * `CURRENCY_CODES` compared case-insensitively ("GBP", "gbp", "Gbp"), or a
 * sign in `CURRENCY_SIGNS` ("£" is GBP). Null for anything else (a duration,
 * a count, an unknown word): such a unit is never read as money.
 */
export function currencyOfUnit(unit: string | null | undefined): string | null {
  const u = unit?.trim();
  if (!u) return null;
  if (CURRENCY_SIGNS[u]) return CURRENCY_SIGNS[u];
  const code = u.toUpperCase();
  return CURRENCY_CODES.includes(code) ? code : null;
}

/**
 * (#408) The MONEY fields of a rubric: the document fields an objective
 * criterion's check reads with a currency unit (`currencyOfUnit`). Intake and
 * applicant fields are not document fields (they are left out exactly as in
 * `documentFieldsFor`), and a derived fact is read from another field that is
 * not money (`accountHolder`), so it is left out too.
 */
export function moneyFieldsFor(rubric: Pick<VisaRubric, "criteria">): string[] {
  const fields = new Set<string>();
  for (const c of rubric.criteria) {
    if (c.kind !== "objective" || !c.check) continue;
    const field = c.check.field;
    if (field.startsWith("intake.") || field.startsWith("applicant.") || field in DERIVED_FACTS) continue;
    if (currencyOfUnit(c.check.unit) !== null) fields.add(field);
  }
  return [...fields].sort();
}

/**
 * (#408) The extraction summary re-written for the FIGURE check, one line per
 * value in the same shape the model is sent (`field: value unit (page n)`),
 * with the unit made readable by `figuresIn`:
 *  - a currency unit, in any case or as a sign, is written as its ISO code
 *    ("gbp" and "£" become "GBP");
 *  - NO unit on a money field: the application's declared currency, when it
 *    has one (a bank letter that prints "1,500,000" for a naira applicant);
 *  - anything else is written as it is (no unit stays bare, "months" stays
 *    "months"), so it is never read as money.
 * Never converts or rounds a value. Only used for grounding: the model is sent
 * the summary exactly as before.
 */
export function labelExtractedValues(facts: NarrativeFigureFacts, declaredCurrency: string | null): string {
  const money = new Set(facts.moneyFields);
  return facts.values
    .map((v) => {
      const rawUnit = v.unit?.trim() ? v.unit.trim() : null;
      const currency = currencyOfUnit(rawUnit) ?? (rawUnit === null && money.has(v.field) ? declaredCurrency : null);
      const unit = currency ?? rawUnit;
      return `${v.field}: ${String(v.value)}${unit ? ` ${unit}` : ""}${v.page ? ` (page ${v.page})` : ""}`;
    })
    .join("\n");
}

/**
 * (#384) The intake summary with every amount answer written as
 * "<amount> <CURRENCY>" so its currency sits next to its number.
 *
 * The summary is `JSON.stringify(intake answers)`; an amount answer is
 * `{ amount: number, currency: string }` (types/intake.ts). Every other value
 * is written as it is (a bare number stays bare: it has no currency). Not JSON
 * (should not happen): the text is returned unchanged, so nothing is lost.
 */
export function labelIntakeAmounts(intakeSummary: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(intakeSummary);
  } catch {
    return intakeSummary;
  }
  const lines: string[] = [];
  /** Walk the answers; `path` is the key chain, for a readable line. */
  const walk = (v: unknown, path: string): void => {
    if (isRecord(v) && typeof v.amount === "number" && typeof v.currency === "string") {
      lines.push(`${path}: ${v.amount} ${v.currency.toUpperCase()}`);
    } else if (Array.isArray(v)) {
      v.forEach((item, i) => walk(item, `${path}[${i}]`));
    } else if (isRecord(v)) {
      for (const [k, item] of Object.entries(v)) walk(item, path ? `${path}.${k}` : k);
    } else {
      lines.push(`${path}: ${String(v)}`);
    }
  };
  walk(parsed, "");
  return lines.join("\n");
}

// ----- Figures -----

/** Currency signs read next to a number, by ISO code. */
const CURRENCY_SIGNS: Record<string, string> = { "£": "GBP", $: "USD", "€": "EUR", "₦": "NGN", "₹": "INR", "¥": "JPY", "₵": "GHS" };
/**
 * Currency codes read next to a number (before or after it). (#384, fix round
 * 1) Widened to the codes Seli's applicants and routes use, so an intake
 * amount in one of them is read WITH its currency.
 */
const CURRENCY_CODES = ["GBP", "USD", "EUR", "NGN", "CAD", "AUD", "NZD", "INR", "ZAR", "KES", "GHS", "CHF", "JPY", "CNY", "AED", "SGD"];

/** One number found in text: its value in a canonical form, and its currency when one is written next to it. */
interface FoundFigure {
  value: string;
  currency: string | null;
}

/**
 * Every number in a text: digits, with or without thousands separators, with
 * or without decimals, with or without a currency sign or code next to it.
 * `value` is canonical (no separators, no trailing decimal zeros), so
 * "₦399,367" and "399367" are the same figure and "3,000.00" equals "3000".
 */
export function figuresIn(text: string): FoundFigure[] {
  const out: FoundFigure[] = [];
  // sign? then 1-3 digits with ,ddd groups, or a plain digit run; then an optional decimal part.
  const re = /([£$€₦₹¥₵])?\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const whole = m[2].replace(/,/g, "");
    const decimals = (m[3] ?? "").replace(/0+$/, "");
    const value = `${whole.replace(/^0+(?=\d)/, "")}${decimals ? `.${decimals}` : ""}`;
    let currency: string | null = m[1] ? CURRENCY_SIGNS[m[1]] : null;
    if (!currency) {
      // A code written right after ("3000 GBP") or right before ("GBP 3000").
      // (#408) Matched case-insensitively: "399,367 gbp" is pounds, not a bare
      // number (a bare number would match any source currency). The code is
      // READ from the text, never guessed, so no string is kept by guessing.
      const after = text.slice(m.index + m[0].length, m.index + m[0].length + 5);
      const before = text.slice(Math.max(0, m.index - 5), m.index);
      const code = CURRENCY_CODES.find((c) => new RegExp(`^\\s?${c}\\b`, "i").test(after) || new RegExp(`\\b${c}\\s?$`, "i").test(before));
      currency = code ?? null;
    }
    out.push({ value, currency });
  }
  return out;
}

/**
 * True when every number in `text` is grounded: the same value appears in a
 * source, and, when the narrative writes a currency next to it, a source has
 * that value in that same currency. Nothing is rounded or converted to make a
 * match.
 *
 * (#384, fix round 1) A currency-labelled figure no longer matches a bare
 * source number: "£399,367" against a naira intake of 399367 is a mislabel,
 * and a bare source figure (a count, an id, a date part) is no proof of any
 * currency. Money sources carry their currency: intake amounts through
 * `labelIntakeAmounts`, document values through their unit, rubric text
 * through its own sign. A bare figure in the narrative still matches any
 * source holding that value.
 */
export function figuresAreGrounded(text: string, sources: readonly string[]): boolean {
  const known = new Map<string, Set<string | null>>();
  for (const s of sources) {
    for (const fig of figuresIn(s)) {
      const set = known.get(fig.value) ?? new Set<string | null>();
      set.add(fig.currency);
      known.set(fig.value, set);
    }
  }
  return figuresIn(text).every((fig) => {
    const currencies = known.get(fig.value);
    if (!currencies) return false;
    if (fig.currency === null) return true;
    return currencies.has(fig.currency);
  });
}

// ----- Quotations -----

/** Whitespace collapsed and curly apostrophes made straight, for a fair verbatim comparison. */
function normaliseForQuote(text: string): string {
  return text.replace(/[‘’]/g, "'").replace(/\s+/g, " ").trim();
}

/**
 * The quoted passages in a text.
 *
 *  - Double quotes: any opening mark (straight ", curly “ or low „) up to the
 *    next closing mark (straight " or curly ”), so a mixed pair like “…" is
 *    checked too (#384, fix round 1).
 *  - Single curly quotes ‘…’ (#384, fix round 1). The closing ’ is also the
 *    apostrophe, so it only closes a quotation when no letter follows it
 *    ("‘you don’t qualify’" is ONE quotation, not "you don").
 *
 * Straight single quotes are not read: they are apostrophes far more often
 * than quotation marks.
 */
export function quotationsIn(text: string): string[] {
  const out: string[] = [];
  const re = /["“„]([^"“”„\n]+)["”]|‘([^‘\n]+?)’(?![A-Za-z])/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    // Trailing punctuation the writer put inside the quotes is not part of the source.
    const q = normaliseForQuote(m[1] ?? m[2] ?? "").replace(/[.,;:!?]+$/, "");
    if (q) out.push(q);
  }
  return out;
}

/** True when every quotation in `text` is a verbatim substring of a source. */
export function quotationsAreGrounded(text: string, sources: readonly string[]): boolean {
  const normalised = sources.map(normaliseForQuote);
  return quotationsIn(text).every((q) => normalised.some((s) => s.includes(q)));
}

// ----- Rule citations (#384, fix round 1) -----

/**
 * The most rule citations one narrative string may carry, and the most across
 * the whole narrative. The founder's rule: the narrative explains the case in
 * a caseworker's words, it does not list the rulebook (the rules ARE the
 * working that `ai.review_working` sells). The prompt asks for this; these
 * caps make it hold in code. A string over a cap is dropped.
 */
export const NARRATIVE_CITATION_LIMITS = { perString: 1, perNarrative: 2 } as const;

/**
 * (#408) A regex source in which every lower-case letter also matches its
 * capital ("rules?" matches "Rule" and "RULES"), so it can sit inside a regex
 * that is otherwise case-SENSITIVE (the letter prefix of a ref must be
 * capitalised). Only for sources written with plain letters, `?`, `|` and
 * spaces: an escape like `\s` would be broken by it.
 */
function anyCase(src: string): string {
  return src.replace(/[a-z]/g, (ch) => `[${ch}${ch.toUpperCase()}]`);
}

/**
 * (#408) The unit words that turn a number into a quantity, not a rule ref:
 * "2.3 times", "2.3 x" / "2.3×", "2.3%", "2.3 percent" / "per cent", and the
 * durations (day, week, month, year, singular or plural). Any letter case; a
 * word unit must end there ("2.3 xyz" is not "2.3 x").
 */
const UNIT_WORD_SRC = `(?:%|×|(?:${anyCase(["times", "x", "percent", "per +cent", "days?", "weeks?", "months?", "years?"].join("|"))})(?![A-Za-z]))`;

/** (#408) "No unit word follows": optional spaces, then a unit word, must NOT come next. */
const NO_UNIT_AFTER_SRC = `(?!\\s*${UNIT_WORD_SRC})`;

/**
 * A rule reference written in the generic way: one of these keywords (any
 * case), then the ref. Catches refs the rubric did not send, too.
 *
 * (#408) Only real ref shapes count, so everyday wording about the
 * applicant's own documents is not a citation:
 *  - a CAPITALISED letter prefix then a number ("paragraph V 4.3",
 *    "Appendix FM 2"; case-sensitive, so "rules in 2025" is not one), or
 *  - a DOTTED number ("rule 4.2", "paragraph 9.8.1").
 * A bare whole number ("Section 3 of your bank letter", "Paragraph 2 of your
 * statement", "the rule of 28 days") does not count. Nor does a ref followed
 * by a unit word ("section 2.3 times"). The `(?![\d.])` stops the number from
 * backtracking to a shorter ref ("9.8.1 years" must not count as "9.8").
 */
const GENERIC_RULE_REF_RE = new RegExp(
  `\\b(?:${anyCase(["rules?", "paragraphs?", "paras?", "sections?", "appendix", "annex", "clauses?"].join("|"))})` +
    `\\s+(?:[A-Z]{1,4}[-\\s]?\\d+(?:\\.\\d+)*|\\d+(?:\\.\\d+)+)(?:\\([a-z0-9]+\\))?(?![\\d.]?\\d)${NO_UNIT_AFTER_SRC}`,
  "g"
);

/** A rubric ref shorter than this (after removing spaces) is too vague to look for ("1", "A"). */
const MIN_RULE_REF_CHARS = 3;

/** Escape a string for use inside a RegExp. */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * How many rule citations a narrative string carries. A citation is:
 *  - a rubric rule named by its ref ("V 4.2") or quoted from its published
 *    wording. One rule named AND quoted ("Rule V 4.2 says “…”") is ONE
 *    citation; each distinct rule counts once per string;
 *  - plus every generic rule reference ("paragraph 9.8") left once the
 *    rubric's own refs are taken out (so "Rule V 4.2" is not counted twice).
 *
 * (#408) Everyday wording no longer counts: rubric refs are matched in the
 * rubric's own letter case, a numeric-only rubric ref followed by a unit word
 * is a quantity, and a generic ref needs a capitalised letter prefix or a
 * dotted number (see `GENERIC_RULE_REF_RE`).
 */
export function ruleCitationsIn(text: string, rules: readonly NarrativeRuleRef[] = []): number {
  const cited = new Set<number>();
  let rest = text;
  rules.forEach((r, i) => {
    const ref = r.ref?.trim();
    if (!ref || ref.replace(/\s+/g, "").length < MIN_RULE_REF_CHARS) return;
    // The ref as a whole token: whitespace-flexible, not inside a longer id ("V 4.21").
    // (#408) Case-SENSITIVE, written as the rubric writes it: "Appendix V"
    // is the rubric's ref, "appendix v" in a sentence is not.
    // (#408) A ref that is only a number ("2.3") is not a citation when a
    // unit word follows it: "2.3 times the amount", "2.3 years", "2.3%" are
    // quantities. "Under 2.3 you need a sponsor" still counts.
    const numericOnly = /^\d+(?:\.\d+)*$/.test(ref);
    const re = new RegExp(`(?<![A-Za-z0-9])${escapeRegExp(ref).replace(/\s+/g, "\\s+")}(?![A-Za-z0-9])${numericOnly ? NO_UNIT_AFTER_SRC : ""}`, "g");
    if (re.test(rest)) {
      cited.add(i);
      rest = rest.replace(re, " ");
    }
  });
  // A quotation inside a rule's published wording cites that rule.
  const normalisedQuotes = rules.map((r) => (r.quote ? normaliseForQuote(r.quote) : null));
  for (const q of quotationsIn(text)) {
    const i = normalisedQuotes.findIndex((rq) => rq !== null && rq.includes(q));
    if (i >= 0) cited.add(i);
  }
  const generic = rest.match(GENERIC_RULE_REF_RE)?.length ?? 0;
  return cited.size + generic;
}

// ----- Parse + checks -----

/** Result of checking one narrative answer. */
export interface NarrativeParse {
  // The narrative to store, or null (shape mismatch, no conclusion, no paragraph).
  narrative: AssessmentNarrative | null;
  // Strings dropped by the banned-wording, figure, quote, lead or rule-citation checks.
  dropped: number;
  // Strings dropped because they addressed a model (stored as suspicious content).
  suspicious: number;
  // Why the whole narrative is null (for the count-only log). Null when kept.
  reason: string | null;
}

const NARRATIVE_KEYS = new Set(["paragraphs", "conclusion", "nextSteps"]);

/** Every string in a list is a string, non-empty after trimming, and within the cap. */
function stringsWithin(list: unknown, max: number): list is string[] {
  return Array.isArray(list) && list.every((s) => typeof s === "string" && s.trim().length > 0 && s.length <= max);
}

/**
 * Check a narrative answer in code. Shape first (exact keys, counts and
 * lengths: any mismatch is null), then each string on its own: a string that
 * fails a check is dropped. Then: no conclusion, or no paragraph, is null.
 *
 * @param band the band the code decided (the conclusion's opening must match)
 * @param grounding what figures and quotations may come from
 */
export function parseNarrative(text: string, band: ReadinessBand, grounding: NarrativeGrounding): NarrativeParse {
  const fail = (reason: string, dropped = 0, suspicious = 0): NarrativeParse => ({ narrative: null, dropped, suspicious, reason });
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return fail("answer is not JSON");
  }
  if (!isRecord(parsed)) return fail("answer is not an object");
  const keys = Object.keys(parsed);
  if (keys.length !== NARRATIVE_KEYS.size || !keys.every((k) => NARRATIVE_KEYS.has(k))) return fail("answer does not have exactly the three keys");
  const { paragraphs, conclusion, nextSteps } = parsed as { paragraphs: unknown; conclusion: unknown; nextSteps: unknown };
  if (!stringsWithin(paragraphs, NARRATIVE_LIMITS.maxParagraphChars) || paragraphs.length < NARRATIVE_LIMITS.minParagraphs || paragraphs.length > NARRATIVE_LIMITS.maxParagraphs) {
    return fail("paragraphs break the shape");
  }
  if (typeof conclusion !== "string" || conclusion.trim().length === 0 || conclusion.length > NARRATIVE_LIMITS.maxConclusionChars) return fail("conclusion breaks the shape");
  if (!stringsWithin(nextSteps, NARRATIVE_LIMITS.maxNextStepChars) || nextSteps.length > NARRATIVE_LIMITS.maxNextSteps) return fail("nextSteps break the shape");

  let dropped = 0;
  let suspicious = 0;
  /** The four string checks, in order. Injection is counted apart (it is stored as suspicious content). */
  const keep = (s: string): boolean => {
    if (findInjectionSignals(s)) {
      suspicious++;
      return false;
    }
    if (findBannedWording(s) || !figuresAreGrounded(s, grounding.figureSources) || !quotationsAreGrounded(s, grounding.quoteSources)) {
      dropped++;
      return false;
    }
    return true;
  };
  // (#384, fix round 1) The rule-citation caps. `citationsUsed` counts the
  // citations of the strings KEPT so far; a string that has more than
  // `perString`, or that would take the narrative past `perNarrative`, is
  // dropped like any other failed string. Run after the other checks, so a
  // string dropped for another reason uses none of the budget.
  let citationsUsed = 0;
  const withinCitationCaps = (s: string): boolean => {
    const n = ruleCitationsIn(s, grounding.rules ?? []);
    if (n > NARRATIVE_CITATION_LIMITS.perString || citationsUsed + n > NARRATIVE_CITATION_LIMITS.perNarrative) {
      dropped++;
      return false;
    }
    citationsUsed += n;
    return true;
  };
  // The conclusion is checked FIRST (it is shown last): without it the whole
  // narrative is null, so it gets the first claim on the citation budget.
  // Its opening must be the band's own (so a conclusion can never read better
  // or worse than the band).
  const c = conclusion.trim();
  let keptConclusion: string | null = keep(c) ? c : null;
  if (keptConclusion !== null && !normaliseForQuote(keptConclusion).toLowerCase().startsWith(NARRATIVE_CONCLUSION_LEADS[band].toLowerCase())) {
    dropped++;
    keptConclusion = null;
  }
  if (keptConclusion !== null && !withinCitationCaps(keptConclusion)) keptConclusion = null;
  // Then the paragraphs and the steps, in the order they are shown.
  const keptParagraphs = paragraphs.map((p) => p.trim()).filter((p) => keep(p) && withinCitationCaps(p));
  const keptSteps = nextSteps.map((s) => s.trim()).filter((st) => keep(st) && withinCitationCaps(st));
  if (keptConclusion === null) return fail("the conclusion was dropped", dropped, suspicious);
  if (keptParagraphs.length === 0) return fail("every paragraph was dropped", dropped, suspicious);
  return { narrative: { paragraphs: keptParagraphs, conclusion: keptConclusion, nextSteps: keptSteps }, dropped, suspicious, reason: null };
}

// ============================================
// Helpers
// ============================================

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** The model roles the engine uses, for the record. */
export const ENGINE_MODELS = { extract: AI_MODELS.extraction, judge: AI_MODELS.judgement } as const;
