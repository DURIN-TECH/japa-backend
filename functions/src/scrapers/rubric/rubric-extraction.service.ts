import { createHash, randomUUID } from "crypto";
import { Timestamp } from "firebase-admin/firestore";
import { collections, subcollections } from "../../utils/firebase";
import { costOfUsage } from "../../services/ai/ai-pricing";
import { AnthropicLlmProvider, emptyLlmUsage, type LlmProvider, type LlmRequest } from "../../services/ai/llm-provider";
import { AnthropicNotConfiguredError, describeAnthropicError } from "../../services/ai/anthropic-client";
import { normalizeForQuoteMatch } from "../shared/fetch/pdf-text";
import { guidanceSnapshotStore, type GuidanceSnapshotStore } from "../guidance/guidance-snapshot.store";
import type { GuidanceChangeEvent } from "../guidance/guidance-crawl.service";
import type { GuidanceSnapshotContent, GuidanceSnapshotMeta, GuidanceSource } from "../guidance/types";
import {
  DEFAULT_SEVERITY_LEVELS,
  RUBRIC_SCHEMA_VERSION,
  type AssessmentCriterion,
  type EvidenceItem,
  type IntakeMeta,
  type IntakeQuestion,
  type IntentPolarityProposal,
  type RubricCitation,
  type RubricDiscard,
  type RubricDiscardReason,
  type RubricExtractionRun,
  type RubricFlag,
  type RubricRunStatus,
  type RubricRunUsage,
  type RubricSourceSnapshot,
} from "../../types/rubric";
import { chunkSnapshot, type SourceChunk } from "./rubric-chunk";
import {
  RUBRIC_PROMPT_VERSION,
  RubricOutputError,
  buildRubricRequest,
  parseRubricOutput,
  type RawCriterion,
  type RawEvidenceItem,
  type RawIntakeQuestion,
  type RawRubricOutput,
} from "./rubric-prompt";
import { SnapshotQuoteIndex, dateSupported, passagesOverlap, unitSupported, unsupportedNumbers } from "./rubric-quote";
import { loadRubricSettings, type LoadedRubricSettings, type RubricExtractionSettings } from "./rubric-settings";
import { rubricRouteKey, rubricStore, type RubricDraft, type RubricStore } from "./rubric.store";
import { validateCriterionShape, validateVisaRubric } from "./rubric-validate";

// ============================================
// RUBRIC — EXTRACTION SERVICE (issue #40)
// ============================================
//
// Turns the newest snapshots of a route's guidance sources into a new,
// `pending_review` rubric version. One run:
//
//   1. settings        kill switch + caps; FAIL CLOSED when unreadable
//   2. sources         the route's guidance sources and their newest snapshot
//   3. hash gate       same snapshots as the newest version -> stop, free
//   4. plan            cut each snapshot into bounded chunks; refuse the run
//                      up front if it would pass a cap (never a partial run)
//   5. extract         one model call per chunk, in document order
//   6. VALIDATE IN CODE every quote looked up in the stored snapshot of its
//                      own source; numbers, dates and units must be in the
//                      quote; anything else is discarded WITH A REASON
//   7. merge           deterministic: document order, first occurrence wins
//   8. write           one transaction: version N+1 (pending_review) + head
//   9. record          a run doc with token usage and what was discarded
//
// What this service never does: approve, publish or serve a rubric; change a
// head's `approvedVersion`; decide the intent polarity (it stores a cited
// PROPOSAL; an admin decides); let the model decide an outcome.
//
// If any chunk fails (provider error, refusal, truncated or malformed
// answer) the WHOLE run fails and no version is written: a rubric missing the
// criteria of one part of a document would look complete and not be.
//
// It is not scheduled. Three ways in, all explicit:
//   extractRoute()        one route (the CLI script, or a later admin action)
//   onGuidanceChanged()   usable as the guidance crawl's `onChanged` listener
//   runPending()          every route whose newest snapshots have no rubric
//                         version yet (covers a listener that threw: the
//                         crawl does not retry a failed listener)
//
// Logging: ids, counts, hash prefixes and lengths only. Never source text,
// never a prompt or an answer, never the provider or client object.

/** Tag on every line this service logs. */
const TAG = "[rubric-extraction]";

/** Cap on the model's own label kept on a discard record. */
const MAX_LABEL_CHARS = 120;

/** Cap on discard records stored on one version (the count is always exact). */
const MAX_STORED_DISCARDS = 200;

// ============================================
// Public shapes
// ============================================

/** What to extract. */
export interface ExtractRouteInput {
  countryCode: string;
  visaTypeId: string;
  // Guidance sources to extract from. Required the first time a route is
  // extracted; afterwards the head remembers them (pass again to change them).
  sourceIds?: string[];
  trigger?: RubricExtractionRun["trigger"];
  // Write a new version even when the snapshots are the ones the newest
  // version was extracted from (after a prompt change, or a rejected version).
  force?: boolean;
  // Plan only: read sources, compute the chunks, call no model, write nothing.
  dryRun?: boolean;
}

/** Size of one source in a plan (lengths and hash prefixes only). */
export interface PlannedSource {
  sourceId: string;
  contentHashPrefix: string;
  docType: "html" | "pdf";
  chars: number;
  chunks: number;
}

/** The outcome of one call to `extractRoute`. */
export interface ExtractRouteResult {
  routeKey: string;
  // `dry_run` is returned for a plan; it is never stored.
  status: RubricRunStatus | "dry_run";
  reasonCode: string | null;
  error: string | null;
  runId: string | null;
  version: number | null;
  plan: PlannedSource[];
  chunks: number;
  criteriaAccepted: number;
  discardedCount: number;
  discardedByReason: Record<string, number>;
  usage: RubricRunUsage;
  costUsd: number | null;
}

/** Everything the service reaches outside itself; all injectable for tests. */
export interface RubricExtractionDeps {
  provider?: LlmProvider;
  snapshots?: Pick<GuidanceSnapshotStore, "read">;
  store?: RubricStore;
  loadSettings?: () => Promise<LoadedRubricSettings>;
  // True when `{countryCode, visaTypeId}` is a real visa type.
  visaTypeExists?: (countryCode: string, visaTypeId: string) => Promise<boolean>;
  now?: () => Timestamp;
}

/** A run stopped on purpose, with the code and status to record. */
class RunStop extends Error {
  constructor(
    readonly status: "skipped" | "failed",
    readonly reasonCode: string,
    message: string
  ) {
    super(message);
  }
}

// ============================================
// Pure helpers (exported for tests and for #125's stale-citation check)
// ============================================

/** sha256 hex of a string. */
function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * The hash gate's key: sha256 over the sorted `sourceId:contentHash` pairs.
 * Order-independent, so listing the sources differently changes nothing.
 */
export function sourceSetHashOf(snapshots: readonly Pick<RubricSourceSnapshot, "sourceId" | "contentHash">[]): string {
  return sha256(snapshots.map((s) => `${s.sourceId}:${s.contentHash}`).sort().join("\n"));
}

/**
 * Stable id of a criterion: derived from WHERE it comes from and WHAT it
 * quotes, never from a name the model chose. The same passage read the same
 * way gets the same id in every run and every version, which is what lets
 * two versions be diffed by id.
 */
export function criterionIdOf(sourceId: string, quote: string, kind: string, checkField: string | undefined): string {
  return `crit_${sha256([sourceId, normalizeForQuoteMatch(quote), kind, checkField ?? ""].join("\n")).slice(0, 16)}`;
}

/** A slug: what intake question ids and evidence keys must look like. */
const SLUG_RE = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/;

/** A criterion that passed validation, with the handle the model gave it. */
interface AcceptedCriterion {
  ref: string;
  criterion: AssessmentCriterion;
}

/** What one chunk's answer yields once validated. */
export interface ChunkAssessment {
  criteria: AcceptedCriterion[];
  discards: RubricDiscard[];
  suspiciousPassages: RubricCitation[];
  polarity: IntentPolarityProposal | null;
  intake: IntakeMeta | null;
  intakeQuestions: RawIntakeQuestion[];
  evidenceItems: { raw: RawEvidenceItem; source: RubricCitation }[];
}

/** The citation fields code fills in for a quote found in a snapshot. */
export interface CitationBase {
  sourceId: string;
  url: string;
  contentHash: string;
  retrievedAt: string;
  publishedDate?: string;
}

/**
 * Validate ONE chunk's answer against the snapshot it was cut from. This is
 * the real defence against an invented rule and against a document that
 * tries to steer the model: nothing is kept unless code finds its words in
 * the stored text of its own source.
 *
 * @param raw   the schema-valid answer for the chunk
 * @param chunk the chunk it answers (for the discard records)
 * @param index the chunk's snapshot, prepared for lookups
 * @param base  citation fields of that snapshot
 * @param severityLevels the rubric's severity scale
 */
export function assessChunkOutput(
  raw: RawRubricOutput,
  chunk: Pick<SourceChunk, "sourceId" | "chunkIndex">,
  index: SnapshotQuoteIndex,
  base: CitationBase,
  severityLevels: readonly string[]
): ChunkAssessment {
  const discards: RubricDiscard[] = [];
  /** Record one discarded item. */
  const discard = (itemType: RubricDiscard["itemType"], reason: RubricDiscardReason, detail: string, label: string) => {
    discards.push({ itemType, reason, detail, label: label.slice(0, MAX_LABEL_CHARS), sourceId: chunk.sourceId, chunkIndex: chunk.chunkIndex });
  };
  /** Build the stored citation for a quote found on `page`. */
  const cite = (quote: string, page: number | undefined): RubricCitation => ({
    quote: quote.trim(),
    sourceId: base.sourceId,
    url: base.url,
    contentHash: base.contentHash,
    ...(page !== undefined ? { page } : {}),
    retrievedAt: base.retrievedAt,
    ...(base.publishedDate ? { publishedDate: base.publishedDate } : {}),
  });

  // ---- passages the model reports as addressed to a reader model ----
  // Only passages that really are in the source are kept (as verbatim text
  // they are safe to store, and a reviewer needs to see them).
  const suspiciousPassages: RubricCitation[] = [];
  for (const s of raw.suspiciousPassages) {
    const found = index.locate(s.quote);
    if (found.ok) suspiciousPassages.push(cite(s.quote, found.page));
  }
  /** True when a quote overlaps a flagged passage. */
  const flagged = (quote: string) => suspiciousPassages.some((s) => passagesOverlap(s.quote, quote));

  // ---- criteria ----
  const criteria: AcceptedCriterion[] = [];
  for (const c of raw.criteria) {
    const accepted = assessCriterion(c, index, cite, flagged, severityLevels);
    if ("reason" in accepted) discard("criterion", accepted.reason, accepted.detail, c.title);
    else criteria.push({ ref: c.ref, criterion: accepted });
  }

  // ---- intent polarity proposal ----
  let polarity: IntentPolarityProposal | null = null;
  // `not_assessed` is the absence of a statement: nothing to cite or keep.
  if (raw.intentPolarity && raw.intentPolarity.value !== "not_assessed") {
    const found = index.locate(raw.intentPolarity.quote);
    if (!found.ok) discard("intent_polarity", found.reason, "the passage given for the intent polarity is not in the source", raw.intentPolarity.value);
    else if (flagged(raw.intentPolarity.quote as string)) discard("intent_polarity", "quote_in_flagged_passage", "the passage given for the intent polarity was flagged", raw.intentPolarity.value);
    else polarity = { value: raw.intentPolarity.value, source: cite(raw.intentPolarity.quote as string, found.page) };
  }

  // ---- evidence items: each must quote the passage that names the document ----
  const evidenceItems: { raw: RawEvidenceItem; source: RubricCitation }[] = [];
  for (const e of raw.evidenceItems) {
    const found = index.locate(e.quote);
    if (!found.ok) {
      discard("evidence_item", found.reason, "the passage naming the document is not in the source", e.title);
    } else if (flagged(e.quote)) {
      discard("evidence_item", "quote_in_flagged_passage", "the passage naming the document was flagged", e.title);
    } else if (!SLUG_RE.test(e.key)) {
      discard("evidence_item", "invalid_shape", "key is not a slug", e.title);
    } else {
      const missing = unsupportedNumbers(e.title, e.quote);
      if (missing.length > 0) discard("evidence_item", "number_not_in_quote", `title states ${missing.join(", ")}, which the quote does not`, e.title);
      else evidenceItems.push({ raw: e, source: cite(e.quote, found.page) });
    }
  }

  return { criteria, discards, suspiciousPassages, polarity, intake: cleanIntakeMeta(raw.intake), intakeQuestions: raw.intakeQuestions, evidenceItems };
}

/** Drop null / blank fields of the model's intake headings; null when none is left. */
function cleanIntakeMeta(raw: RawRubricOutput["intake"]): IntakeMeta | null {
  if (!raw) return null;
  const out: IntakeMeta = {};
  if (raw.title?.trim()) out.title = raw.title.trim();
  if (raw.cardTitle?.trim()) out.cardTitle = raw.cardTitle.trim();
  if (raw.intro?.trim()) out.intro = raw.intro.trim();
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * Validate one proposed criterion. Returns the stored criterion, or the
 * reason it is discarded. The checks run strictest-evidence first: is the
 * quote there, then is everything else the model said backed by it.
 */
function assessCriterion(
  c: RawCriterion,
  index: SnapshotQuoteIndex,
  cite: (quote: string, page: number | undefined) => RubricCitation,
  flagged: (quote: string) => boolean,
  severityLevels: readonly string[]
): AssessmentCriterion | { reason: RubricDiscardReason; detail: string } {
  // 1. The quote must be verbatim in THIS source's snapshot (and, in a PDF,
  //    within one page). A paraphrase, an invented sentence and a sentence
  //    from another document all fail here.
  const found = index.locate(c.quote);
  if (!found.ok) return { reason: found.reason, detail: "the quote is not in the stored text of its source" };
  if (flagged(c.quote)) return { reason: "quote_in_flagged_passage", detail: "the quote overlaps a passage flagged as addressed to a reader model" };

  // 2. Per-field supporting passages: each must be verbatim too.
  const citations: Record<string, string> = {};
  for (const extra of c.citations) {
    const at = index.locate(extra.quote);
    if (!at.ok || flagged(extra.quote)) return { reason: "citation_not_found", detail: `the supporting passage for ${extra.field} is not in the stored text` };
    citations[extra.field] = extra.quote.trim();
  }
  // Everything the model may lean on: its quote plus its supporting passages.
  const support = [c.quote, ...Object.values(citations)].join(" ");

  // 3. The rule reference must be printed in the document.
  const ruleRef = c.ruleRef?.trim() || undefined;
  if (ruleRef && !index.containsLiteral(ruleRef)) return { reason: "rule_ref_not_in_source", detail: "the rule reference does not appear in the source" };

  // 4. No invented numbers: every number stated in the check, the title or
  //    the probe factors must be written in the supporting text. (The title
  //    may also repeat the rule reference's own digits.)
  if (c.check && (typeof c.check.value === "number" || typeof c.check.value === "string")) {
    const missing = unsupportedNumbers(c.check.value, support);
    if (missing.length > 0) return { reason: "number_not_in_quote", detail: `check.value states ${missing.join(", ")}, which the quote does not` };
  }
  const titleMissing = unsupportedNumbers(c.title, `${support} ${ruleRef ?? ""}`);
  if (titleMissing.length > 0) return { reason: "number_not_in_quote", detail: `title states ${titleMissing.join(", ")}, which the quote does not` };
  for (const factor of c.probeFactors) {
    const missing = unsupportedNumbers(factor, support);
    if (missing.length > 0) return { reason: "number_not_in_quote", detail: `a probe factor states ${missing.join(", ")}, which the quote does not` };
  }
  if (c.check?.unit && !unitSupported(c.check.unit, support)) return { reason: "unit_not_in_quote", detail: `the unit ${c.check.unit} is not written in the quote` };

  // 5. Dates must be in the supporting text.
  for (const key of ["validFrom", "validUntil"] as const) {
    const v = c[key];
    if (v && !dateSupported(v, support)) return { reason: "date_not_in_quote", detail: `${key} is not written in the quote` };
  }

  // 6. A bar's group must be named in the supporting text, word for word.
  if (c.appliesTo) {
    const normSupport = normalizeForQuoteMatch(support);
    const absent = c.appliesTo.asWritten.filter((w) => !normalizeForQuoteMatch(w) || !normSupport.includes(normalizeForQuoteMatch(w)));
    if (absent.length > 0) return { reason: "applies_to_not_in_quote", detail: `${absent.length} group member(s) are not named in the quote` };
  }

  // 7. Build the stored criterion. Nothing is silently "repaired": a
  //    judgement criterion that came with a check keeps it here, and is then
  //    discarded by the shape rules below.
  const criterion: AssessmentCriterion = {
    criterionId: criterionIdOf(index.snapshot.sourceId, c.quote, c.kind, c.check?.field),
    title: c.title.trim(),
    kind: c.kind,
    stage: c.stage,
    severity: c.severity,
    ...(ruleRef ? { ruleRef } : {}),
    source: cite(c.quote, found.page),
    ...(c.check
      ? {
        check: {
          field: c.check.field.trim(),
          op: c.check.op,
          ...(c.check.value !== null ? { value: c.check.value } : {}),
          ...(c.check.unit ? { unit: c.check.unit.trim() } : {}),
        },
      }
      : {}),
    ...(c.appliesTo ? { appliesTo: { nationalities: c.appliesTo.nationalities.map((n) => n.trim().toUpperCase()), asWritten: c.appliesTo.asWritten.map((w) => w.trim()) } } : {}),
    ...(c.validFrom ? { validFrom: c.validFrom } : {}),
    ...(c.validUntil ? { validUntil: c.validUntil } : {}),
    ...(c.kind === "judgement"
      ? { probeFactors: c.probeFactors.map((f) => f.trim()).filter(Boolean), requiresInterviewBeforeRefusal: c.requiresInterviewBeforeRefusal === true }
      : {}),
    ...(c.concernsIntent ? { concernsIntent: true } : {}),
    ...(Object.keys(citations).length > 0 ? { citations } : {}),
    confidence: c.confidence,
  };

  // 8. Kind rules (judgement with a check, objective without one, a bar with
  //    no group, ...).
  const issues = validateCriterionShape(criterion, severityLevels);
  if (issues.length > 0) return { reason: "invalid_shape", detail: issues.map((i) => i.code).join(", ") };
  return criterion;
}

/** What `mergeAssessments` produces: the content of a rubric version. */
export interface MergedRubricContent {
  criteria: AssessmentCriterion[];
  intake: IntakeMeta | null;
  intakeQuestions: IntakeQuestion[];
  evidenceItems: EvidenceItem[];
  intentPolarityProposal: IntentPolarityProposal | null;
  suspiciousPassages: RubricCitation[];
  discards: RubricDiscard[];
  flags: RubricFlag[];
}

/**
 * Merge the per-chunk results into one rubric, deterministically.
 *
 * `parts` must be in document order (source by source, chunk by chunk). The
 * rule everywhere is FIRST OCCURRENCE WINS:
 *  - two criteria with the same id (the same passage read the same way, which
 *    happens when a document repeats itself) -> the later one is discarded as
 *    `duplicate`; things that pointed at it are re-pointed at the survivor;
 *  - two intake questions / evidence items with the same id / key -> the
 *    first one's wording is kept and the criteria they name are unioned;
 *  - the first cited polarity proposal is kept; a later, different one raises
 *    a flag for the reviewer.
 */
export function mergeAssessments(parts: readonly { chunk: Pick<SourceChunk, "sourceId" | "chunkIndex">; assessment: ChunkAssessment }[]): MergedRubricContent {
  const discards: RubricDiscard[] = [];
  const flags: RubricFlag[] = [];
  const criteria: AssessmentCriterion[] = [];
  const byId = new Map<string, AssessmentCriterion>();
  const suspiciousPassages: RubricCitation[] = [];
  let intentPolarityProposal: IntentPolarityProposal | null = null;
  let intake: IntakeMeta | null = null;
  const questions = new Map<string, IntakeQuestion>();
  // Conditions are resolved after every chunk is in: a question may depend
  // on one asked in a later chunk.
  const conditions = new Map<string, RawIntakeQuestion["showWhenAnyOf"]>();
  const evidence = new Map<string, EvidenceItem>();

  for (const { chunk, assessment } of parts) {
    discards.push(...assessment.discards);
    suspiciousPassages.push(...assessment.suspiciousPassages);
    /** Record a discard made at merge time. */
    const discard = (itemType: RubricDiscard["itemType"], reason: RubricDiscardReason, detail: string, label: string) =>
      discards.push({ itemType, reason, detail, label: label.slice(0, MAX_LABEL_CHARS), sourceId: chunk.sourceId, chunkIndex: chunk.chunkIndex });

    // ---- criteria ----
    // The model's handles are only meaningful inside its own answer.
    const refToId = new Map<string, string>();
    for (const { ref, criterion } of assessment.criteria) {
      refToId.set(ref, criterion.criterionId);
      if (byId.has(criterion.criterionId)) {
        discard("criterion", "duplicate", "the same passage was already extracted", criterion.title);
        continue;
      }
      byId.set(criterion.criterionId, criterion);
      criteria.push(criterion);
    }
    /** Stable ids of the surviving criteria a list of handles points at. */
    const resolve = (refs: string[]) => [...new Set(refs.map((r) => refToId.get(r)).filter((id): id is string => id !== undefined))];

    // ---- polarity ----
    if (assessment.polarity) {
      if (!intentPolarityProposal) intentPolarityProposal = assessment.polarity;
      else if (intentPolarityProposal.value !== assessment.polarity.value) {
        flags.push({
          code: "intent_polarity_conflict",
          message: `the source also contains a passage read as ${assessment.polarity.value} (page ${assessment.polarity.source?.page ?? "n/a"} of ${chunk.sourceId}); the first proposal was kept. Decide the polarity by reading both.`,
          target: "rubric",
        });
      }
    }
    if (!intake && assessment.intake) intake = assessment.intake;

    // ---- intake questions ----
    for (const q of assessment.intakeQuestions) {
      const ids = resolve(q.criterionRefs);
      if (!SLUG_RE.test(q.id)) {
        discard("intake_question", "invalid_shape", "id is not a slug", q.label);
      } else if (ids.length === 0) {
        discard("intake_question", "unresolved_reference", "none of the criteria it names survived validation", q.label);
      } else if ((q.answerType === "single_choice" || q.answerType === "multi_choice") && q.options.length === 0) {
        discard("intake_question", "invalid_shape", "a choice question with no options", q.label);
      } else if (questions.has(q.id)) {
        // Same question asked for another part of the document: keep the
        // first wording, add the criteria.
        const first = questions.get(q.id) as IntakeQuestion;
        first.criterionIds = [...new Set([...first.criterionIds, ...ids])];
      } else {
        questions.set(q.id, {
          id: q.id,
          label: q.label.trim(),
          ...(q.helpText?.trim() ? { helpText: q.helpText.trim() } : {}),
          answerType: q.answerType,
          required: q.required,
          criterionIds: ids,
          ...(q.group?.trim() ? { group: q.group.trim() } : {}),
          ...(q.party ? { party: q.party } : {}),
          ...(q.options.length > 0
            ? { options: q.options.map((o) => ({ value: o.value, label: o.label, ...(o.description?.trim() ? { description: o.description.trim() } : {}) })) }
            : {}),
          ...(q.dateRelativeToToday ? { dateLimits: { relativeToToday: q.dateRelativeToToday } } : {}),
          ...(typeof q.textMaxLength === "number" && Number.isInteger(q.textMaxLength) && q.textMaxLength > 0 ? { textLimits: { maxLength: q.textMaxLength } } : {}),
        });
        conditions.set(q.id, q.showWhenAnyOf);
      }
    }

    // ---- evidence items ----
    for (const { raw, source } of assessment.evidenceItems) {
      const ids = resolve(raw.criterionRefs);
      if (ids.length === 0) {
        discard("evidence_item", "unresolved_reference", "none of the criteria it names survived validation", raw.title);
      } else if (evidence.has(raw.key)) {
        const first = evidence.get(raw.key) as EvidenceItem;
        first.criterionIds = [...new Set([...first.criterionIds, ...ids])];
      } else {
        const fields = raw.fields.map((f) => f.trim()).filter(Boolean);
        const expects = { ...(raw.documentType?.trim() ? { documentType: raw.documentType.trim() } : {}), ...(fields.length > 0 ? { fields } : {}) };
        evidence.set(raw.key, {
          key: raw.key,
          title: raw.title.trim(),
          party: raw.party,
          criterionIds: ids,
          ...(Object.keys(expects).length > 0 ? { expects } : {}),
          source,
        });
      }
    }
  }

  // ---- show-when conditions ----
  // A question whose condition names a question that does not exist is
  // discarded rather than shown unconditionally (dropping only the condition
  // would change what the question means). Repeat until stable: removing one
  // question can orphan another.
  let removed = true;
  while (removed) {
    removed = false;
    for (const [id, conds] of conditions) {
      if (!questions.has(id)) continue;
      if (conds.some((c) => !questions.has(c.questionId) || c.questionId === id)) {
        const q = questions.get(id) as IntakeQuestion;
        discards.push({ itemType: "intake_question", reason: "unresolved_reference", detail: "its show-when condition names a question that is not in the rubric", label: q.label.slice(0, MAX_LABEL_CHARS), sourceId: "", chunkIndex: -1 });
        questions.delete(id);
        removed = true;
      }
    }
  }
  for (const [id, conds] of conditions) {
    const q = questions.get(id);
    if (q && conds.length > 0) q.showWhen = { anyOf: conds.map((c) => ({ questionId: c.questionId, op: c.op, value: c.value })) };
  }

  // ---- back-links: which questions each criterion reads ----
  const intakeQuestions = [...questions.values()];
  for (const q of intakeQuestions) {
    for (const id of q.criterionIds) {
      const c = byId.get(id);
      if (c) c.intakeQuestionIds = [...(c.intakeQuestionIds ?? []), q.id];
    }
  }

  return { criteria, intake, intakeQuestions, evidenceItems: [...evidence.values()], intentPolarityProposal, suspiciousPassages, discards, flags };
}

/** Count discards by reason. */
function countByReason(discards: readonly RubricDiscard[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const d of discards) out[d.reason] = (out[d.reason] ?? 0) + 1;
  return out;
}

/** A blank usage record for a run. */
function emptyRunUsage(): RubricRunUsage {
  return { requests: 0, ...emptyLlmUsage() };
}

// ============================================
// The service
// ============================================

/** One source of a run, loaded. */
interface LoadedSource {
  snapshot: RubricSourceSnapshot;
  retrievedAt: string;
}

export class RubricExtractionService {
  /** @param deps overrides for tests; production passes nothing. */
  constructor(private readonly deps: RubricExtractionDeps = {}) {}

  // Defaults are resolved at CALL time, never at module load: this module is
  // reached through scrapers/index.ts, whose import-cycle rule forbids using
  // another module's binding while modules are still loading.
  /** The model provider (built on first use, so importing costs nothing). */
  private lazyProvider: LlmProvider | undefined;
  private get provider(): LlmProvider {
    return this.deps.provider ?? (this.lazyProvider ??= new AnthropicLlmProvider());
  }
  private get snapshots(): Pick<GuidanceSnapshotStore, "read"> {
    return this.deps.snapshots ?? guidanceSnapshotStore;
  }
  private get store(): RubricStore {
    return this.deps.store ?? rubricStore;
  }
  private now(): Timestamp {
    return this.deps.now ? this.deps.now() : Timestamp.now();
  }

  /** Default visa-type lookup: `countries/{cc}/visaTypes/{id}` exists. */
  private async visaTypeExists(countryCode: string, visaTypeId: string): Promise<boolean> {
    if (this.deps.visaTypeExists) return this.deps.visaTypeExists(countryCode, visaTypeId);
    return (await subcollections.visaTypes(countryCode).doc(visaTypeId).get()).exists;
  }

  /**
   * Read a source's registry entry and the metadata of its newest snapshot.
   * No document text is read here (that waits until after the hash gate).
   */
  private async loadSource(sourceId: string): Promise<LoadedSource> {
    const doc = await collections.guidanceSources.doc(sourceId).get();
    if (!doc.exists) throw new RunStop("failed", "source_not_found", `guidance source ${sourceId} does not exist`);
    const source = doc.data() as GuidanceSource;
    const contentHash = source.latestSnapshotId;
    if (!contentHash) throw new RunStop("failed", "source_has_no_snapshot", `guidance source ${sourceId} has not been crawled yet`);
    const metaDoc = await subcollections.guidanceSnapshots(sourceId).doc(contentHash).get();
    if (!metaDoc.exists) throw new RunStop("failed", "snapshot_meta_missing", `snapshot ${sourceId}/${contentHash.slice(0, 12)} has no metadata`);
    const meta = metaDoc.data() as GuidanceSnapshotMeta;
    return {
      snapshot: {
        sourceId,
        contentHash,
        url: meta.finalUrl || meta.url,
        docType: meta.docType,
        ...(meta.publishedDate ? { publishedDate: meta.publishedDate } : {}),
      },
      retrievedAt: meta.fetchedAt.toDate().toISOString(),
    };
  }

  /**
   * Extract one route. Never throws for an expected problem: the result says
   * what happened (`status` + `reasonCode`). See the file header for the steps.
   */
  async extractRoute(input: ExtractRouteInput): Promise<ExtractRouteResult> {
    const startedAt = this.now();
    const routeKey = rubricRouteKey(input.countryCode, input.visaTypeId);
    const trigger = input.trigger ?? "manual";
    const model = this.provider.modelFor("judgement");
    const usage = emptyRunUsage();
    // One id for the run: on its record and on the version it writes.
    const runId = randomUUID();
    // Filled in as the run proceeds, so a failure records how far it got.
    let sources: LoadedSource[] = [];
    let sourceSetHash: string | null = null;
    let plan: PlannedSource[] = [];
    let chunkCount = 0;
    let reachedModel = false;

    /** Assemble a result (and, when asked, store the run record). */
    const finish = async (
      status: ExtractRouteResult["status"],
      fields: Partial<Pick<ExtractRouteResult, "reasonCode" | "error" | "version" | "criteriaAccepted" | "discardedCount" | "discardedByReason">>,
      record: boolean
    ): Promise<ExtractRouteResult> => {
      const costUsd = usage.requests > 0 ? costOfUsage("judgement", usage) : null;
      const result: ExtractRouteResult = {
        routeKey,
        status,
        reasonCode: fields.reasonCode ?? null,
        error: fields.error ?? null,
        runId: record && status !== "dry_run" ? runId : null,
        version: fields.version ?? null,
        plan,
        chunks: chunkCount,
        criteriaAccepted: fields.criteriaAccepted ?? 0,
        discardedCount: fields.discardedCount ?? 0,
        discardedByReason: fields.discardedByReason ?? {},
        usage,
        costUsd,
      };
      if (record && status !== "dry_run") {
        const run: RubricExtractionRun = {
          runId,
          routeKey,
          countryCode: input.countryCode,
          visaTypeId: input.visaTypeId,
          status,
          reasonCode: result.reasonCode,
          error: result.error,
          trigger,
          sourceSnapshots: sources.map((s) => s.snapshot),
          sourceSetHash,
          model,
          promptVersion: RUBRIC_PROMPT_VERSION,
          version: result.version,
          chunks: chunkCount,
          usage,
          costUsd,
          criteriaAccepted: result.criteriaAccepted,
          discardedCount: result.discardedCount,
          discardedByReason: result.discardedByReason,
          startedAt,
          finishedAt: this.now(),
        };
        try {
          await this.store.writeRun(run);
        } catch (err) {
          // The run's outcome stands even if its record could not be saved.
          console.error(`${TAG} ${routeKey}: could not store the run record: ${(err as Error)?.message ?? String(err)}`);
        }
      }
      // Ids, counts and token totals only.
      console.log(
        `${TAG} ${routeKey}: ${status}${result.reasonCode ? ` (${result.reasonCode})` : ""} ` +
          `version=${result.version ?? "-"} chunks=${chunkCount} accepted=${result.criteriaAccepted} discarded=${result.discardedCount} ` +
          `requests=${usage.requests} in=${usage.inputTokens} out=${usage.outputTokens}`
      );
      return result;
    };

    try {
      // ---- 1. settings: fail closed ----
      const loaded = await (this.deps.loadSettings ?? loadRubricSettings)();
      if (loaded.readError) throw new RunStop("skipped", "settings_unavailable", "extraction settings could not be read; not running");
      const settings = loaded.settings;
      if (!settings.enabled) throw new RunStop("skipped", "disabled", "rubric extraction is switched off");

      // ---- 2. the route and its sources ----
      const head = await this.store.getHead(routeKey);
      const sourceIds = [...new Set(input.sourceIds && input.sourceIds.length > 0 ? input.sourceIds : head?.sourceIds ?? [])].sort();
      if (sourceIds.length === 0) throw new RunStop("failed", "no_sources", "no guidance sources given, and the route has none recorded");
      // A rubric is only ever attached to a real visa type.
      if (!(await this.visaTypeExists(input.countryCode, input.visaTypeId))) {
        throw new RunStop("failed", "visa_type_not_found", `no visa type ${input.visaTypeId} under ${input.countryCode}`);
      }
      sources = [];
      for (const id of sourceIds) sources.push(await this.loadSource(id));

      // ---- 3. hash gate: nothing changed -> nothing called, nothing written ----
      sourceSetHash = sourceSetHashOf(sources.map((s) => s.snapshot));
      if (!input.force && head && head.latestSourceSetHash === sourceSetHash) {
        return await finish("unchanged", { reasonCode: "source_unchanged", version: head.latestVersion }, false);
      }

      // ---- 4. plan: read the snapshot text, cut it, check the caps ----
      const indexes = new Map<string, SnapshotQuoteIndex>();
      const chunks: SourceChunk[] = [];
      plan = [];
      for (const s of sources) {
        // `read` re-hashes the text and refuses a mismatch.
        const content: GuidanceSnapshotContent = await this.snapshots.read(s.snapshot.sourceId, s.snapshot.contentHash);
        indexes.set(s.snapshot.sourceId, new SnapshotQuoteIndex(content));
        const cut = chunkSnapshot(content, settings.maxChunkChars);
        chunks.push(...cut);
        plan.push({ sourceId: s.snapshot.sourceId, contentHashPrefix: s.snapshot.contentHash.slice(0, 12), docType: s.snapshot.docType, chars: content.text.length, chunks: cut.length });
      }
      chunkCount = chunks.length;
      if (chunkCount === 0) throw new RunStop("failed", "no_text", "the snapshots hold no text to extract from");
      this.assertWithinCaps(chunks, settings);
      if (input.dryRun) return await finish("dry_run", {}, false);

      // The daily cap counts runs that reached the model, so it is checked
      // only now that this run is about to.
      const dayStart = Timestamp.fromMillis(Math.floor(startedAt.toMillis() / 86_400_000) * 86_400_000);
      if ((await this.store.countRunsSince(dayStart)) >= settings.maxRunsPerDay) {
        throw new RunStop("skipped", "daily_cap_reached", `the daily cap of ${settings.maxRunsPerDay} extraction run(s) is used up`);
      }

      // ---- 5 + 6. one call per chunk, validated in code ----
      const severityLevels = [...DEFAULT_SEVERITY_LEVELS];
      const parts: { chunk: SourceChunk; assessment: ChunkAssessment }[] = [];
      for (const chunk of chunks) {
        const source = sources.find((s) => s.snapshot.sourceId === chunk.sourceId) as LoadedSource;
        const request = buildRubricRequest(chunk, severityLevels, { maxOutputTokens: settings.maxOutputTokensPerRequest, timeoutMs: settings.requestTimeoutMs });
        reachedModel = true;
        const raw = await this.callModel(request, usage);
        parts.push({
          chunk,
          assessment: assessChunkOutput(raw, chunk, indexes.get(chunk.sourceId) as SnapshotQuoteIndex, {
            sourceId: chunk.sourceId,
            url: source.snapshot.url,
            contentHash: chunk.contentHash,
            retrievedAt: source.retrievedAt,
            ...(source.snapshot.publishedDate ? { publishedDate: source.snapshot.publishedDate } : {}),
          }, severityLevels),
        });
      }

      // ---- 7. merge ----
      const merged = mergeAssessments(parts);
      const discardedByReason = countByReason(merged.discards);
      // Every rejection is logged with its reason (never with source text).
      for (const d of merged.discards) console.warn(`${TAG} ${routeKey}: discarded ${d.itemType} (${d.reason}) from ${d.sourceId || "merge"}#${d.chunkIndex}: ${d.detail}`);
      if (merged.criteria.length === 0) {
        return await finish("failed", { reasonCode: "no_criteria_accepted", error: "no criterion survived validation", discardedCount: merged.discards.length, discardedByReason }, true);
      }

      // ---- 8. build the draft, validate its structure, write ----
      const draft: RubricDraft = {
        schemaVersion: RUBRIC_SCHEMA_VERSION,
        routeKey,
        countryCode: input.countryCode,
        visaTypeId: input.visaTypeId,
        // Governance: always pending, never decided, by construction.
        reviewStatus: "pending_review",
        intentPolarity: null,
        reviewedBy: null,
        reviewedAt: null,
        rejectReason: null,
        revision: 0,
        supersededAt: null,
        intentPolarityProposal: merged.intentPolarityProposal,
        severityLevels,
        criteria: merged.criteria,
        ...(merged.intake ? { intake: merged.intake } : {}),
        intakeQuestions: merged.intakeQuestions,
        evidenceItems: merged.evidenceItems,
        sourceSnapshots: sources.map((s) => s.snapshot),
        sourceSetHash,
        extractorModel: model,
        extractorPromptVersion: RUBRIC_PROMPT_VERSION,
        extractionRunId: runId,
        discardedCount: merged.discards.length,
        discarded: merged.discards.slice(0, MAX_STORED_DISCARDS),
        suspiciousPassages: merged.suspiciousPassages,
        flags: merged.flags,
        createdAt: this.now(),
      };
      const validation = validateVisaRubric({ ...draft, version: 1 });
      if (validation.errors.length > 0) {
        const codes = [...new Set(validation.errors.map((e) => e.code))].join(", ");
        return await finish("failed", { reasonCode: "rubric_invalid", error: `the merged rubric is not consistent: ${codes}`, discardedCount: merged.discards.length, discardedByReason }, true);
      }
      draft.flags = [...merged.flags, ...validation.flags];
      if (merged.suspiciousPassages.length > 0) {
        draft.flags.push({ code: "suspicious_passages", message: `${merged.suspiciousPassages.length} passage(s) of the source read as instructions to a reader model; no criterion quotes them. Read them before approving.`, target: "rubric" });
      }

      const written = await this.store.writePendingVersion(draft, sourceIds, { force: input.force, now: this.now() });
      if (!written.written) {
        // Another run wrote this source set while this one was extracting.
        return await finish("unchanged", { reasonCode: "source_unchanged", version: written.version }, true);
      }
      return await finish("succeeded", { version: written.version, criteriaAccepted: merged.criteria.length, discardedCount: merged.discards.length, discardedByReason }, true);
    } catch (err) {
      if (err instanceof RunStop) {
        // Record the run when it cost something or is a real failure; a
        // refusal before any call (switch off, caps) is logged, not stored.
        return await finish(err.status, { reasonCode: err.reasonCode, error: err.message }, err.status === "failed" || reachedModel);
      }
      // Unexpected: a secret-free one-liner (the provider error class already
      // is one; anything else goes through the same redaction).
      return await finish("failed", { reasonCode: "unexpected_error", error: describeAnthropicError(err).slice(0, 500) }, true);
    }
  }

  /** Refuse the run when its plan would pass a per-run cap. */
  private assertWithinCaps(chunks: readonly SourceChunk[], settings: RubricExtractionSettings): void {
    if (chunks.length > settings.maxRequestsPerRun) {
      throw new RunStop("skipped", "run_cap_exceeded", `the run needs ${chunks.length} requests; the cap is ${settings.maxRequestsPerRun}`);
    }
    const chars = chunks.reduce((n, c) => n + c.text.length, 0);
    if (chars > settings.maxInputCharsPerRun) {
      throw new RunStop("skipped", "run_cap_exceeded", `the run would send ${chars} characters; the cap is ${settings.maxInputCharsPerRun}`);
    }
  }

  /**
   * One model call: send, account for the tokens (whatever happens next,
   * they were billed), require a complete answer, check its shape.
   *
   * @throws RunStop("failed", ...) for anything but a complete, schema-valid answer
   */
  private async callModel(request: LlmRequest, usage: RubricRunUsage): Promise<RawRubricOutput> {
    let response;
    try {
      response = await this.provider.complete(request);
    } catch (err) {
      // No key bound: say so plainly (the message names the variable and how
      // to set it; it holds no secret).
      if (err instanceof AnthropicNotConfiguredError) throw new RunStop("failed", "ai_not_configured", err.message);
      throw new RunStop("failed", "provider_error", describeAnthropicError(err).slice(0, 500));
    }
    usage.requests += 1;
    usage.inputTokens += response.usage.inputTokens;
    usage.outputTokens += response.usage.outputTokens;
    usage.cacheReadTokens += response.usage.cacheReadTokens;
    usage.cacheWriteTokens += response.usage.cacheWriteTokens;
    // A declined or cut-off answer is a failed run, never an empty finding.
    if (response.stopReason === "refusal") throw new RunStop("failed", "provider_refused", "the model declined the request");
    if (response.stopReason === "max_tokens") throw new RunStop("failed", "output_truncated", "the model's answer was cut off at the token limit");
    if (response.stopReason !== "end_turn") throw new RunStop("failed", "provider_stopped", `the model stopped with reason ${String(response.stopReason)}`);
    try {
      return parseRubricOutput(response.text, request.schema);
    } catch (err) {
      const detail = err instanceof RubricOutputError ? `${err.message}${err.problems.length > 0 ? `: ${err.problems.slice(0, 3).join("; ")}` : ""}` : "unreadable answer";
      throw new RunStop("failed", "invalid_model_output", detail);
    }
  }

  /**
   * The routes whose newest snapshots have NO rubric version derived from
   * them. Reads registry docs only (no document text, no model).
   */
  async findStaleRoutes(): Promise<{ routeKey: string; countryCode: string; visaTypeId: string }[]> {
    const stale: { routeKey: string; countryCode: string; visaTypeId: string }[] = [];
    for (const head of await this.store.listHeads()) {
      const pairs: { sourceId: string; contentHash: string }[] = [];
      for (const sourceId of head.sourceIds ?? []) {
        const doc = await collections.guidanceSources.doc(sourceId).get();
        const contentHash = doc.exists ? (doc.data() as GuidanceSource).latestSnapshotId : null;
        if (contentHash) pairs.push({ sourceId, contentHash });
      }
      // A source that vanished or has no snapshot also makes the set differ.
      if (pairs.length !== (head.sourceIds ?? []).length || sourceSetHashOf(pairs) !== head.latestSourceSetHash) {
        stale.push({ routeKey: head.routeKey, countryCode: head.countryCode, visaTypeId: head.visaTypeId });
      }
    }
    return stale;
  }

  /**
   * Extract every stale route (see findStaleRoutes). Safe to run at any time:
   * an up-to-date route costs nothing. One route failing does not stop the rest.
   */
  async runPending(opts: { dryRun?: boolean } = {}): Promise<ExtractRouteResult[]> {
    const results: ExtractRouteResult[] = [];
    for (const route of await this.findStaleRoutes()) {
      results.push(await this.extractRoute({ countryCode: route.countryCode, visaTypeId: route.visaTypeId, trigger: "pending_sweep", dryRun: opts.dryRun }));
    }
    return results;
  }

  /**
   * Listener for the guidance crawl's `onChanged` hook: re-extract every
   * route that uses the changed source. It does not throw (extractRoute
   * reports problems in its result). Should it fail anyway, the crawl does
   * not retry a listener, and `runPending` picks the route up later.
   */
  async onGuidanceChanged(event: Pick<GuidanceChangeEvent, "sourceId">): Promise<ExtractRouteResult[]> {
    const results: ExtractRouteResult[] = [];
    for (const head of await this.store.listHeads()) {
      if (!(head.sourceIds ?? []).includes(event.sourceId)) continue;
      results.push(await this.extractRoute({ countryCode: head.countryCode, visaTypeId: head.visaTypeId, trigger: "guidance_changed" }));
    }
    return results;
  }
}

/** Singleton over the real provider, bucket and Firestore. */
export const rubricExtractionService = new RubricExtractionService();
