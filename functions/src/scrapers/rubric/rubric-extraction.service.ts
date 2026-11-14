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
  RUBRIC_CITATION_FIELDS,
  RUBRIC_SCHEMA_VERSION,
  type AssessmentCriterion,
  type EvidenceItem,
  type IntakeMeta,
  type IntakeQuestion,
  type IntentPolarityProposal,
  type QuoteTranslation,
  type RubricCitation,
  type RubricDiscard,
  type RubricDiscardReason,
  type RubricExtractionRun,
  type RubricFlag,
  type RubricRunStatus,
  type RubricRunUsage,
  type RubricSourceSnapshot,
} from "../../types/rubric";
import { chunkSnapshot, pageMarker, type SourceChunk } from "./rubric-chunk";
import { isBar, REPAIR_WINDOW_CHARS, REPAIR_WINDOW_LINES_AFTER, REPAIR_WINDOW_LINES_BEFORE } from "./rubric-repair";
import {
  RUBRIC_PROMPT_VERSION,
  RubricOutputError,
  buildIntakeRequest,
  buildRepairRequest,
  buildRubricRequest,
  parseRubricOutput,
  type RepairRuleView,
  type RubricRouteContext,
  type RawCriterion,
  type RawEvidenceItem,
  type RawIntakeQuestion,
  type RawRuleTrigger,
  type RawRubricOutput,
  type AcceptedCriterionView,
  type KnownQuestionView,
} from "./rubric-prompt";
import { triggerValuesOf } from "../../services/ai/rule-applicability";
import {
  SnapshotQuoteIndex,
  appendixNamesIn,
  containsTokenBounded,
  dateSupported,
  datesIn,
  groupNameSupported,
  uncodedNameSupported,
  passagesOverlap,
  refTokensIn,
  unitAdjacentToNumber,
  unitSupported,
  unsupportedNumbers,
  withoutLeadingParagraphNumber,
} from "./rubric-quote";
import { lexiconFor, resolveSourceLanguage, sourceLanguagesOf, needsTranslation, productLanguageCode, type Lexicon } from "../language/language-lexicon";
import { TranslationError, buildTranslationRequest, parseTranslationOutput, toQuoteTranslation, type TranslationItem } from "./rubric-translation";
import { listNotReadableFlag, readLeadInList, unreadableListReason, verifyListItems } from "./rubric-list-items";
import { spansSiblingMarkers } from "./rubric-marker-chain";
import { loadRubricSettings, type LoadedRubricSettings, type RubricExtractionSettings } from "./rubric-settings";
import { rubricRouteKey, rubricStore, type RubricDraft, type RubricStore } from "./rubric.store";
import type { RubricHead } from "../../types/rubric";
import type { StartJobInput, StartJobResult } from "./rubric-extraction-job";
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

/** Cap on a stored discard detail (details are fixed strings; this is a backstop). */
const MAX_DETAIL_CHARS = 200;

/** How many characters of a discarded quote are kept for the audit trail. */
const MAX_AUDIT_QUOTE_CHARS = 120;

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
  // (#207) Accepted criteria that are specialist-activity rules (kept).
  specialistKept: number;
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
  // The route's display name (default: the visa type document's `name`).
  visaTypeName?: (countryCode: string, visaTypeId: string) => Promise<string>;
  now?: () => Timestamp;
  // (#216) Starts a route's drafting job (default: the job service, resolved at call time).
  startJob?: (input: StartJobInput) => Promise<StartJobResult>;
}

/**
 * A run stopped on purpose, with the code and status to record.
 * (#216) Exported: the background job (rubric-extraction-job.ts) stops for the
 * same reasons with the same codes, so a job's reason codes ARE these codes.
 */
export class RunStop extends Error {
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

/** Attempts per model call (first try plus one retry). (#216: the job bounds a step's attempts with it too.) */
export const MAX_CALL_ATTEMPTS = 2;
/** Pause before a retry, multiplied by the attempt number. */
const RETRY_BACKOFF_MS = 3000;

/** Failed attempts of a run, and the request cap they count against. */
interface CallAttempts {
  failed: number;
  cap: number;
}

/**
 * True for a transient provider failure: a transport error (the connection
 * was cut: "terminated", reset, "fetch failed"), or an HTTP 5xx / 429 /
 * 529. Never a 4xx. The message is the secret-free one `describeAnthropicError`
 * builds (`status=NNN ...` when the API answered).
 */
export function isTransientProviderError(message: string): boolean {
  const status = /status=(\d{3})/.exec(message);
  if (status) {
    const code = Number(status[1]);
    return code >= 500 || code === 429;
  }
  return /terminated|ECONNRESET|ETIMEDOUT|fetch failed|socket hang up|other side closed|overloaded|timed out/i.test(message);
}

/** A slug: what intake question ids and evidence keys must look like. */
const SLUG_RE = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/;

/**
 * What decides whether a criterion from a cross-route (secondary) source
 * belongs to the route (issue #112). Built in code from the route's own
 * (primary) source text: the reference-shaped tokens it prints and the
 * appendix / part names it mentions.
 */
export interface RouteScope {
  // References the primary source prints ("V 15.1", "FIN 2.1", ...).
  refs: ReadonlySet<string>;
  // Appendix / part names the primary source mentions.
  names: ReadonlySet<string>;
}

/** Build the scope allow-list from the primary sources' normalised text. */
export function routeScopeFrom(primaryTexts: readonly string[], lexicons: readonly Lexicon[] = []): RouteScope {
  const refs = new Set<string>();
  const names = new Set<string>();
  // (#220) The reference shapes and the words that name an appendix or part are
  // the language's (its lexicon, one per text, in the same order); with no
  // lexicon given the product language's are used, as before.
  primaryTexts.forEach((t, i) => {
    for (const r of refTokensIn(t, lexicons[i])) refs.add(r);
    for (const n of appendixNamesIn(t, lexicons[i])) names.add(n);
  });
  return { refs, names };
}

/** What a source is to its route (registry data, see GuidanceSourceRole). */
export type SourceRole = "primary" | "route_guidance" | "secondary";

/** How much of a document's start is searched for its own name. */
const DOCUMENT_NAME_HEAD_CHARS = 400;

/**
 * True when the route's own (primary) source refers to a cross-route
 * document BY NAME: an appendix / part name the primary source mentions
 * appears in the document's registry title or at the start of its text.
 * Names come from the primary text and titles from the registry, so no name
 * is written in code.
 */
export function primaryNamesDocument(scope: RouteScope, title: string, text: string): boolean {
  const head = `${title} ${text.slice(0, DOCUMENT_NAME_HEAD_CHARS)}`.replace(/\s+/gu, " ");
  return [...scope.names].some((n) => head.includes(n));
}

/**
 * Everything `assessChunkOutput` needs to apply the scope rules of one
 * source: its role, the allow-list from the primary source, and whether the
 * primary source names THIS document. Null (no primary source in the run):
 * nothing is scoped out.
 */
export interface SourceScope {
  role: SourceRole;
  allow: RouteScope;
  // Secondary only: the primary source refers to this document by name.
  namedByPrimary: boolean;
}

/** Things done to a criterion that a reviewer should be able to count. */
interface CriterionNotes {
  // A `check` the model attached to a judgement criterion was dropped.
  checkStripped: boolean;
  // The model's rule reference was not printed with the quote and was removed.
  refRemoved: boolean;
  // The rule reference was taken from the snapshot's own layout, not the model.
  refDerived: boolean;
}

/** A criterion that passed validation, with the handle the model gave it. */
interface AcceptedCriterion {
  ref: string;
  criterion: AssessmentCriterion;
  notes: CriterionNotes;
  // The quote begins part-way through a sentence of the source (see
  // SnapshotQuoteIndex.startsMidSentence): becomes a reviewer flag.
  startsMidSentence: boolean;
  // The quote stops before the end of its sentence (see
  // SnapshotQuoteIndex.endsMidSentence): becomes a reviewer flag.
  endsMidSentence: boolean;
  // A dated criterion whose quote holds more than one date: the reviewer
  // checks validFrom / validUntil are the right ones.
  multipleDates: boolean;
  // The quote spans two or more list markers of one level, or only introduces
  // a list ("...the third party:"): sub-conditions may have been merged.
  combinedSubConditions: boolean;
  // (#222) The quote is a lead-in whose list could not be read cleanly (reason code).
  listUnreadable?: string;
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
  // (#207) The model's proposed rule triggers (call 2). Resolved and checked
  // at merge time, when every question of the rubric is known. Absent = none.
  ruleTriggers?: RawRuleTrigger[];
  // Counts of things done to criteria (see CriterionNotes), for flags.
  counters: { judgementChecksStripped: number; ruleRefsRemoved: number; ruleRefsDerived: number };
}

/** Join the criteria half and the intake half of one chunk's two calls. */
export function combineAssessments(criteriaPart: ChunkAssessment, intakePart: ChunkAssessment): ChunkAssessment {
  return {
    criteria: criteriaPart.criteria,
    discards: [...criteriaPart.discards, ...intakePart.discards],
    suspiciousPassages: [...criteriaPart.suspiciousPassages, ...intakePart.suspiciousPassages],
    polarity: criteriaPart.polarity,
    intake: intakePart.intake,
    intakeQuestions: intakePart.intakeQuestions,
    evidenceItems: intakePart.evidenceItems,
    ruleTriggers: intakePart.ruleTriggers ?? [],
    counters: {
      judgementChecksStripped: criteriaPart.counters.judgementChecksStripped + intakePart.counters.judgementChecksStripped,
      ruleRefsRemoved: criteriaPart.counters.ruleRefsRemoved + intakePart.counters.ruleRefsRemoved,
      ruleRefsDerived: criteriaPart.counters.ruleRefsDerived + intakePart.counters.ruleRefsDerived,
    },
  };
}

/** The citation fields code fills in for a quote found in a snapshot. */
export interface CitationBase {
  sourceId: string;
  url: string;
  contentHash: string;
  retrievedAt: string;
  publishedDate?: string;
}

/** Fixed, code-written details for discard records. No model text, no source text. */
const DETAIL = {
  quote: "the quote is not in the stored text of its source as one whole-word passage",
  flagged: "the quote overlaps a passage flagged as addressed to a reader model",
  citationField: "a supporting citation names a field outside the allowed list",
  citation: "a supporting citation is not in the stored text of the source",
  scope: "from a cross-route source the route's own source does not point to, or not a rule for applicants of the route",
  otherRoute: "the text says the rule applies to a different route or category of applicant",
  condition: "the applicability condition is not verbatim in the source",
  ruleRef: "the rule reference is not printed in, or directly before, the quote",
  valueType: "check.value must be a JSON number for this operator",
  valuePresent: "a `present` check must not carry a value",
  value: "check.value is not written in the criterion's own quote",
  unit: "check.unit is not written in the criterion's own quote",
  unitNotAdjacent: "check.unit does not stand directly next to check.value in the criterion's own quote",
  titleNumber: "the title states a number the criterion's own quote does not",
  factorNumber: "a probe factor states a number the criterion's own quote does not",
  date: "validFrom / validUntil is not a date written in the criterion's own quote",
  groupShape: "appliesTo.nationalities and appliesTo.asWritten must be parallel lists of the same length",
  group: "a member of appliesTo.asWritten is not named in the criterion's own quote as a whole name",
  polarity: "the passage given for the intent polarity is not in the stored text",
  polarityFlagged: "the passage given for the intent polarity was flagged",
  evidenceQuote: "the passage naming the document is not in the stored text",
  evidenceFlagged: "the passage naming the document was flagged",
  evidenceKey: "the evidence key is not a slug",
  evidenceNumber: "the evidence title states a number its quote does not",
} as const;

/**
 * Make a model-supplied label safe to store: control and invisible
 * formatting characters removed, whitespace collapsed, capped. Labels are
 * stored for the reviewer and never logged.
 */
function safeLabel(label: string): string {
  // eslint-disable-next-line no-control-regex
  return label.replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_LABEL_CHARS);
}

/** English display names of region codes (platform data, loaded on first use). */
let regionNames: Intl.DisplayNames | undefined;

/**
 * The platform's display name for a two-letter region code, or the code
 * itself when the platform has none (a code it does not know comes back
 * unchanged, which then never matches the source's wording and is flagged).
 */
export function regionDisplayName(code: string): string {
  try {
    regionNames ??= new Intl.DisplayNames([productLanguageCode()], { type: "region" });
    return regionNames.of(code) ?? code;
  } catch {
    return code;
  }
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
  severityLevels: readonly string[],
  scope: SourceScope | null = null
): ChunkAssessment {
  const discards: RubricDiscard[] = [];
  const counters = { judgementChecksStripped: 0, ruleRefsRemoved: 0, ruleRefsDerived: 0 };
  /** Record one discarded item (with an audit trail for a criterion). */
  const discard = (itemType: RubricDiscard["itemType"], reason: RubricDiscardReason, detail: string, label: string, audit?: Pick<RubricDiscard, "ruleRef" | "quoteHash" | "quoteStart">) => {
    discards.push({ itemType, reason, detail: detail.slice(0, MAX_DETAIL_CHARS), label: safeLabel(label), sourceId: chunk.sourceId, chunkIndex: chunk.chunkIndex, ...(audit ?? {}) });
  };
  /**
   * Build the stored citation for a located passage. `matched` is the
   * SOURCE's text (from the lookup), never the model's copy.
   */
  const cite = (matched: string, page: number | undefined): RubricCitation => ({
    quote: matched,
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
    if (found.ok) suspiciousPassages.push(cite(found.matched, found.page));
  }
  /** True when a quote overlaps a flagged passage. */
  const flagged = (quote: string) => suspiciousPassages.some((s) => passagesOverlap(s.quote, quote));

  // ---- criteria ----
  const criteria: AcceptedCriterion[] = [];
  for (const c of raw.criteria) {
    const accepted = assessCriterion(c, index, cite, flagged, severityLevels, scope);
    if ("reason" in accepted) {
      // What the model proposed, so a reviewer can audit WHY it was dropped:
      // its reference, a hash of its quote and the quote's first characters.
      // (Published guidance: no personal data.)
      discard("criterion", accepted.reason, accepted.detail, c.title, {
        ...(c.ruleRef?.trim() ? { ruleRef: c.ruleRef.trim().slice(0, 60) } : {}),
        quoteHash: sha256(normalizeForQuoteMatch(c.quote)),
        quoteStart: normalizeForQuoteMatch(c.quote).slice(0, MAX_AUDIT_QUOTE_CHARS),
      });
    } else {
      const { criterion, notes } = accepted;
      if (notes.checkStripped) counters.judgementChecksStripped++;
      if (notes.refRemoved) counters.ruleRefsRemoved++;
      if (notes.refDerived) counters.ruleRefsDerived++;
      // Located again only to ask where the quote sits in its sentence.
      const found = index.locate(criterion.source.quote);
      criteria.push({
        ref: c.ref,
        criterion,
        notes,
        startsMidSentence: found.ok && index.startsMidSentence(found),
        endsMidSentence: found.ok && index.endsMidSentence(found),
        multipleDates: Boolean(criterion.validFrom || criterion.validUntil) && datesIn(criterion.source.quote, index.lexicon).length > 1,
        combinedSubConditions: found.ok && (spansSiblingMarkers(criterion.source.quote) || (index.introducesList(found) && criterion.source.listItems === undefined)),
        listUnreadable: found.ok ? unreadableListReason(index, found, criterion.source.listItems) : undefined,
      });
    }
  }

  // ---- intent polarity proposal ----
  let polarity: IntentPolarityProposal | null = null;
  // `not_assessed` is the absence of a statement: nothing to cite or keep.
  if (raw.intentPolarity && raw.intentPolarity.value !== "not_assessed") {
    const found = index.locate(raw.intentPolarity.quote);
    if (!found.ok) discard("intent_polarity", found.reason, DETAIL.polarity, raw.intentPolarity.value);
    else if (flagged(found.matched)) discard("intent_polarity", "quote_in_flagged_passage", DETAIL.polarityFlagged, raw.intentPolarity.value);
    else polarity = { value: raw.intentPolarity.value, source: cite(found.matched, found.page) };
  }

  // ---- evidence items: each must quote the passage that names the document ----
  const evidenceItems: { raw: RawEvidenceItem; source: RubricCitation }[] = [];
  for (const e of raw.evidenceItems) {
    const found = index.locate(e.quote);
    if (!found.ok) discard("evidence_item", found.reason, DETAIL.evidenceQuote, e.title);
    else if (flagged(found.matched)) discard("evidence_item", "quote_in_flagged_passage", DETAIL.evidenceFlagged, e.title);
    else if (!SLUG_RE.test(e.key)) discard("evidence_item", "invalid_shape", DETAIL.evidenceKey, e.title);
    else if (unsupportedNumbers(e.title, found.matched, { lexicon: index.lexicon }).length > 0) discard("evidence_item", "number_not_in_quote", DETAIL.evidenceNumber, e.title);
    else evidenceItems.push({ raw: e, source: cite(found.matched, found.page) });
  }

  return { criteria, discards, suspiciousPassages, polarity, intake: cleanIntakeMeta(raw.intake), intakeQuestions: raw.intakeQuestions, evidenceItems, ruleTriggers: raw.ruleTriggers, counters };
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

/** Operators whose value is a threshold, and so must be a number. */
const NUMERIC_OPS: readonly string[] = ["gte", "lte", "heldForDays"];

/**
 * Validate one proposed criterion. Returns the stored criterion, or the
 * reason it is discarded.
 *
 * The one rule behind every check below: what the criterion CLAIMS (a
 * threshold, a unit, a date, a group, a number in its title) must be written
 * in the criterion's OWN QUOTE. Supporting citations are kept for the
 * reviewer but never widen what a claim is checked against: a figure from
 * another paragraph of the same document proves nothing about this rule.
 */
function assessCriterion(
  c: RawCriterion,
  index: SnapshotQuoteIndex,
  cite: (matched: string, page: number | undefined) => RubricCitation,
  flagged: (quote: string) => boolean,
  severityLevels: readonly string[],
  scope: SourceScope | null
): { criterion: AssessmentCriterion; notes: CriterionNotes } | { reason: RubricDiscardReason; detail: string } {
  // 1. The quote must be verbatim in THIS source's snapshot: whole words,
  //    one page / one paragraph. A paraphrase, an invented sentence, a
  //    fragment cut out of a longer word or number, and a sentence from
  //    another document all fail here.
  const found = index.locate(c.quote);
  if (!found.ok) return { reason: found.reason, detail: DETAIL.quote };
  // From here on only the SOURCE's text is used, never the model's copy.
  const quote = found.matched;
  if (flagged(quote)) return { reason: "quote_in_flagged_passage", detail: DETAIL.flagged };

  // 2. Supporting citations: a closed list of fields, each passage verbatim.
  //    Reviewer aids only (see the function comment).
  const citations: Record<string, string> = {};
  for (const extra of c.citations) {
    if (!(RUBRIC_CITATION_FIELDS as readonly string[]).includes(extra.field)) return { reason: "invalid_shape", detail: DETAIL.citationField };
    const at = index.locate(extra.quote);
    if (!at.ok || flagged(at.matched)) return { reason: "citation_not_found", detail: DETAIL.citation };
    citations[extra.field] = at.matched;
  }

  // 3. The rule reference. Never trusted from the model (issue #112):
  //    (i) a reference the model gives is kept only when it is printed with
  //    the quote (in it, or earlier on its line); otherwise
  //    (ii) the reference the SNAPSHOT'S OWN LAYOUT gives the quote is used
  //    (its own label, a list marker under its parent paragraph's label, or
  //    the heading it sits under: see SnapshotQuoteIndex.derivedRuleRef);
  //    (iii) failing both, the reference is left out (it is optional): the
  //    quote itself was found verbatim, so the criterion stands on its words.
  const notes: CriterionNotes = { checkStripped: false, refRemoved: false, refDerived: false };
  const claimedRef = c.ruleRef?.trim() || undefined;
  let ruleRef: string | undefined;
  if (claimedRef && index.ruleRefNear(found, claimedRef)) {
    ruleRef = claimedRef;
  } else {
    ruleRef = index.derivedRuleRef(found);
    notes.refDerived = ruleRef !== undefined;
    notes.refRemoved = claimedRef !== undefined && ruleRef === undefined;
  }

  // 3b. A judgement criterion is never machine-checked: a check the model
  //     attached anyway is dropped here (counted), and the criterion kept.
  const raw = c;
  if (raw.kind === "judgement" && raw.check) {
    c = { ...c, check: null };
    notes.checkStripped = true;
  }

  // 3c. Scope (issue #112). The model proposes an applicability; code decides
  //     what to keep from the source's role (registry data) alone:
  //      - primary, route_guidance: keep `all_applicants` and `conditional`;
  //        a `specialist` or `other_route` criterion is dropped under its own
  //        reason, so the reviewer can count them;
  //      - secondary: keep a criterion only when the route's own source
  //        points at it (names the document, or prints this criterion's
  //        reference) AND it is `all_applicants` or `conditional`; anything
  //        else is `out_of_route_scope`.
  //     A criterion with no applicability (a caller that predates the field)
  //     is read as `all_applicants`.
  //     (#207) A `specialist` criterion is KEPT like a conditional one: every
  //     rule the guidance states for the route stays, however long the
  //     rulebook gets. It is assessed only for applicants its condition covers
  //     (see `trigger`). The size of the rulebook is never a reason to drop
  //     a rule; `other_route` and `out_of_route_scope` are about correctness.
  const applicability = c.applicability ?? "all_applicants";
  if (scope) {
    const wanted = applicability === "all_applicants" || applicability === "conditional" || applicability === "specialist";
    if (scope.role === "secondary") {
      const pointedAt = scope.namedByPrimary || (ruleRef !== undefined && scope.allow.refs.has(ruleRef));
      if (!pointedAt || !wanted) return { reason: "out_of_route_scope", detail: DETAIL.scope };
    } else if (applicability === "other_route") {
      return { reason: "other_route", detail: DETAIL.otherRoute };
    }
  }

  // 3d. A conditional or specialist criterion's condition is the source's own
  //     words, found verbatim like any quote (a condition that is not found
  //     discards the criterion, as for any quote). A criterion that is neither
  //     keeps no condition.
  let applicabilityCondition: string | undefined;
  if ((applicability === "conditional" || applicability === "specialist") && c.applicabilityCondition?.trim()) {
    const cond = index.locate(c.applicabilityCondition);
    if (!cond.ok) return { reason: cond.reason, detail: DETAIL.condition };
    applicabilityCondition = cond.matched;
  }

  // 4. The check: a threshold is a NUMBER written in the quote (and not the
  //    day or year of a date in it); a string is only allowed for `eq`, and
  //    must be in the quote word for word; a unit must be in the quote too.
  if (c.check) {
    const v = c.check.value;
    if (NUMERIC_OPS.includes(c.check.op) && !(typeof v === "number" && Number.isFinite(v))) return { reason: "invalid_shape", detail: DETAIL.valueType };
    if (c.check.op === "present" && v !== null) return { reason: "invalid_shape", detail: DETAIL.valuePresent };
    // A paragraph number at the start of the quote labels the rule; it is
    // not something the rule states, so it supports no number.
    // (#220) A quote is read in ITS source's language (`lex`); what the model
    // wrote about it (title, factors) is in the product language.
    const lex = index.lexicon;
    const content = withoutLeadingParagraphNumber(quote, lex);
    if (typeof v === "number" && unsupportedNumbers(v, content, { outsideDates: true, lexicon: lex }).length > 0) return { reason: "number_not_in_quote", detail: DETAIL.value };
    if (typeof v === "string" && (!v.trim() || !containsTokenBounded(quote, v))) return { reason: "number_not_in_quote", detail: DETAIL.value };
    if (c.check.unit !== null && !unitSupported(c.check.unit, quote)) return { reason: "unit_not_in_quote", detail: DETAIL.unit };
    // The unit belongs to THIS number: "28 days or 4 weeks" does not make
    // (28, "weeks") a reading of the rule.
    if (c.check.unit !== null && typeof v === "number" && !unitAdjacentToNumber(v, c.check.unit, content, lex)) return { reason: "unit_not_in_quote", detail: DETAIL.unitNotAdjacent };
  }

  // 5. Numbers in the applicant-facing wording must be in the quote as well.
  //    (The rule reference's own digits do not count.)
  const body = withoutLeadingParagraphNumber(quote, index.lexicon);
  if (unsupportedNumbers(c.title, body, { lexicon: index.lexicon }).length > 0) return { reason: "number_not_in_quote", detail: DETAIL.titleNumber };
  for (const factor of c.probeFactors) {
    if (unsupportedNumbers(factor, body, { lexicon: index.lexicon }).length > 0) return { reason: "number_not_in_quote", detail: DETAIL.factorNumber };
  }

  // 6. Dates: the same date, as one date expression, in the quote.
  for (const key of ["validFrom", "validUntil"] as const) {
    const v = c[key];
    if (v && !dateSupported(v, quote, index.lexicon)) return { reason: "date_not_in_quote", detail: DETAIL.date };
  }

  // 7. A bar's group: one source name per code, each a whole name in the quote.
  if (c.appliesTo) {
    if (c.appliesTo.asWritten.length !== c.appliesTo.nationalities.length) return { reason: "invalid_shape", detail: DETAIL.groupShape };
    if (c.appliesTo.asWritten.some((w) => !groupNameSupported(w, quote))) return { reason: "applies_to_not_in_quote", detail: DETAIL.group };
    // (#222) Members that are not a nationality: each a whole name in the quote, no code.
    if ((c.appliesTo.uncoded ?? []).some((w) => !uncodedNameSupported(w, quote))) return { reason: "applies_to_not_in_quote", detail: DETAIL.group };
  }
  // 7b. (#222) A quote that ends with a lead-in gets its list lines from the
  //     stored text (rubric-list-items.ts). An unreadable list is NOT a discard
  //     here: the rule is kept without items and flagged, so the gates hold a
  //     protected rule / leave out an ordinary one by a named reason.
  const list = readLeadInList(index, found);
  const listItems = list.kind === "items" && verifyListItems(index, found, list.items).ok ? list.items : undefined;

  // 8. Build the stored criterion. Nothing is silently "repaired": a
  //    judgement criterion that came with a check keeps it here, and is then
  //    discarded by the shape rules below.
  const nationalities = c.appliesTo?.nationalities.map((n) => n.trim().toUpperCase()) ?? [];
  const criterion: AssessmentCriterion = {
    criterionId: criterionIdOf(index.snapshot.sourceId, quote, c.kind, c.check?.field),
    title: c.title.trim(),
    kind: c.kind,
    stage: c.stage,
    severity: c.severity,
    ...(ruleRef ? { ruleRef } : {}),
    ...(c.applicability ? { applicability: c.applicability as "all_applicants" | "conditional" } : {}),
    ...(applicabilityCondition ? { applicabilityCondition } : {}),
    source: { ...cite(quote, found.page), ...(listItems ? { listItems } : {}) },
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
    ...(c.appliesTo
      ? {
        appliesTo: {
          nationalities,
          asWritten: c.appliesTo.asWritten.map((w) => w.trim()),
          // Platform data beside the model's proposal, for the reviewer.
          codeNames: nationalities.map(regionDisplayName),
          ...((c.appliesTo.uncoded ?? []).length > 0 ? { uncoded: (c.appliesTo.uncoded ?? []).map((w) => w.trim()) } : {}),
        },
      }
      : {}),
    ...(c.validFrom ? { validFrom: c.validFrom } : {}),
    ...(c.validUntil ? { validUntil: c.validUntil } : {}),
    ...(c.kind === "judgement"
      ? { probeFactors: c.probeFactors.map((f) => f.trim()).filter(Boolean), requiresInterviewBeforeRefusal: c.requiresInterviewBeforeRefusal === true }
      : {}),
    ...(c.concernsIntent ? { concernsIntent: true } : {}),
    ...(Object.keys(citations).length > 0 ? { citations } : {}),
    confidence: c.confidence,
  };

  // 9. Kind rules (judgement with a check, objective without one, a bar with
  //    no group, ...). The detail is the validator's own codes.
  const issues = validateCriterionShape(criterion, severityLevels);
  if (issues.length > 0) return { reason: "invalid_shape", detail: issues.map((i) => i.code).join(", ") };
  return { criterion, notes };
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
  // Exact duplicates: the same normalised quote with the same reference
  // (issue #112). Only these are merged in code; near-duplicates are left to
  // the reviewer and flagged below.
  const byQuoteAndRef = new Map<string, string>();
  const totals = { judgementChecksStripped: 0, ruleRefsRemoved: 0, ruleRefsDerived: 0 };
  // Evidence items whose trigger had to be simplified (see below).
  let simplifiedTriggers = 0;
  // Trigger conditions of evidence items, resolved once every question is in.
  const evidenceConditions = new Map<string, NonNullable<RawEvidenceItem["showWhenAnyOf"]>>();
  // (#207) Rule triggers the model proposed, with the stable id of the rule
  // each is for. Checked once every question of the rubric is known (the
  // question may be asked in another excerpt than the rule).
  const pendingTriggers: { criterionId: string; raw: RawRuleTrigger }[] = [];

  for (const { chunk, assessment } of parts) {
    discards.push(...assessment.discards);
    totals.judgementChecksStripped += assessment.counters.judgementChecksStripped;
    totals.ruleRefsRemoved += assessment.counters.ruleRefsRemoved;
    totals.ruleRefsDerived += assessment.counters.ruleRefsDerived;
    suspiciousPassages.push(...assessment.suspiciousPassages);
    /** Record a discard made at merge time. */
    const discard = (itemType: RubricDiscard["itemType"], reason: RubricDiscardReason, detail: string, label: string) =>
      discards.push({ itemType, reason, detail, label: safeLabel(label), sourceId: chunk.sourceId, chunkIndex: chunk.chunkIndex });

    // ---- criteria ----
    // The model's handles are only meaningful inside its own answer.
    const refToId = new Map<string, string>();
    for (const { ref, criterion, startsMidSentence, endsMidSentence, multipleDates, combinedSubConditions, listUnreadable } of assessment.criteria) {
      refToId.set(ref, criterion.criterionId);
      if (byId.has(criterion.criterionId)) {
        discard("criterion", "duplicate", "the same passage was already extracted", criterion.title);
        continue;
      }
      // The same words with the same reference under another id (another
      // source, or another reading of the check): an exact duplicate.
      const dupKey = `${normalizeForQuoteMatch(criterion.source.quote)}|${criterion.ruleRef ?? ""}`;
      const dupOf = byQuoteAndRef.get(dupKey);
      if (dupOf !== undefined) {
        refToId.set(ref, dupOf);
        discard("criterion", "duplicate", "the same quote and reference were already extracted", criterion.title);
        continue;
      }
      byQuoteAndRef.set(dupKey, criterion.criterionId);
      byId.set(criterion.criterionId, criterion);
      criteria.push(criterion);
      if (endsMidSentence) {
        flags.push({
          code: "quote_ends_mid_sentence",
          message: "the quote stops before the end of its sentence. A condition or exception that follows it (\"only where\", \"unless\") may change its meaning: read the whole sentence in the source before approving.",
          target: criterion.criterionId,
        });
      }
      if (combinedSubConditions) {
        flags.push({
          code: "combined_sub_conditions",
          message: "the quote spans two or more list items of the same level, or is only the lead-in of a list. Each lettered or numbered sub-condition should be its own criterion with its own quote: check the source and split or add criteria before approving.",
          target: criterion.criterionId,
        });
      }
      listNotReadableFlag(criterion.criterionId, listUnreadable, flags);
      if (multipleDates) {
        flags.push({
          code: "multiple_dates_in_quote",
          message: "the quote contains more than one date. Check that validFrom / validUntil are the dates this rule is meant to carry.",
          target: criterion.criterionId,
        });
      }
      if (startsMidSentence) {
        // The check code cannot make: do the words BEFORE the quote change
        // what it means? Said out loud, per criterion, for the reviewer.
        flags.push({
          code: "quote_starts_mid_sentence",
          message: "the quote begins part-way through a sentence of the source. Words before it (a negation, a condition) may change its meaning: read the whole sentence in the source before approving.",
          target: criterion.criterionId,
        });
      }
    }
    // (#207) Remember this excerpt's proposed triggers against stable ids.
    for (const t of assessment.ruleTriggers ?? []) {
      const id = refToId.get(t.criterionRef);
      if (id !== undefined) pendingTriggers.push({ criterionId: id, raw: t });
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
        // (#207) Another excerpt may name another activity or sub-category for
        // the same question (the activity question is asked once): add the
        // options the first wording lacks. The first wording of each option wins.
        if (q.options.length > 0 && (first.answerType === "single_choice" || first.answerType === "multi_choice")) {
          const have = new Set((first.options ?? []).map((o) => o.value));
          const extra = q.options.filter((o) => !have.has(o.value));
          if (extra.length > 0) {
            first.options = [...(first.options ?? []), ...extra.map((o) => ({ value: o.value, label: o.label, ...(o.description?.trim() ? { description: o.description.trim() } : {}) }))];
          }
        }
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
        evidenceConditions.set(raw.key, raw.showWhenAnyOf ?? []);
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
        discards.push({ itemType: "intake_question", reason: "unresolved_reference", detail: "its show-when condition names a question that is not in the rubric", label: safeLabel(q.label), sourceId: "", chunkIndex: -1 });
        questions.delete(id);
        removed = true;
      }
    }
  }
  for (const [id, conds] of conditions) {
    const q = questions.get(id);
    if (q && conds.length > 0) q.showWhen = { anyOf: conds.map((c) => ({ questionId: c.questionId, op: c.op, value: c.value })) };
  }

  // ---- evidence triggers ----
  // An evidence item is asked for only when an intake answer matches. The
  // stored shape is ONE condition: several `eq` on the same question become
  // one `in`; anything else keeps the first condition and is flagged. An item
  // whose trigger names a question that is not in the rubric is discarded.
  for (const [key, conds] of evidenceConditions) {
    const item = evidence.get(key);
    if (!item || conds.length === 0) continue;
    if (conds.some((c) => !questions.has(c.questionId))) {
      discards.push({ itemType: "evidence_item", reason: "unresolved_reference", detail: "its trigger names a question that is not in the rubric", label: safeLabel(item.title), sourceId: "", chunkIndex: -1 });
      evidence.delete(key);
      continue;
    }
    const sameQuestion = conds.every((c) => c.questionId === conds[0].questionId && c.op === "eq");
    if (conds.length === 1) item.when = { questionId: conds[0].questionId, op: conds[0].op, value: conds[0].value };
    else if (sameQuestion) item.when = { questionId: conds[0].questionId, op: "in", value: conds.map((c) => String(c.value)) };
    else {
      item.when = { questionId: conds[0].questionId, op: conds[0].op, value: conds[0].value };
      simplifiedTriggers++;
    }
  }

  // ---- rule triggers (#207) ----
  // A scoped (specialist or conditional) rule applies only when an intake
  // answer says so. The model proposes the question and the answer values;
  // CODE checks the link before it is stored: the rule exists and is scoped,
  // the question exists in the rubric (and survived the show-when pass above),
  // its answers can be enumerated, and every value is one of its options. A
  // proposal that fails any of these is ignored: the rule is KEPT with no
  // trigger, which an assessment reads as "could not tell whether this
  // applies" (specialist) - never as dropped, never as applying to everyone.
  // The rule is also added to the question's `criterionIds`, so the question
  // is not removed with the rules that did not need it (exclusions) and the
  // validator's rule-question join holds.
  let simplifiedRuleTriggers = 0;
  for (const { criterionId, raw: t } of pendingTriggers) {
    const c = byId.get(criterionId);
    const q = questions.get(t.questionId);
    if (!c || !q || (c.applicability !== "specialist" && c.applicability !== "conditional")) continue;
    const allowed = triggerValuesOf(q);
    const wanted = [...new Set(t.answerValues)];
    if (!allowed || wanted.length === 0 || wanted.some((v) => !allowed.includes(v))) continue;
    if (c.trigger && c.trigger.questionId !== q.id) {
      // Two different questions for one rule: the stored shape is ONE
      // question; the first stays and a reviewer flag says so.
      simplifiedRuleTriggers++;
      continue;
    }
    c.trigger = { questionId: q.id, anyOf: [...new Set([...(c.trigger?.anyOf ?? []), ...wanted])] };
    q.criterionIds = [...new Set([...q.criterionIds, criterionId])];
  }

  // ---- back-links: which questions each criterion reads ----
  const intakeQuestions = [...questions.values()];
  for (const q of intakeQuestions) {
    for (const id of q.criterionIds) {
      const c = byId.get(id);
      if (c) c.intakeQuestionIds = [...(c.intakeQuestionIds ?? []), q.id];
    }
  }

  // ---- reviewer flags for what code did on the way ----
  if (totals.judgementChecksStripped > 0) {
    flags.push({
      code: "judgement_check_stripped",
      message: `${totals.judgementChecksStripped} judgement criteria came with a machine check from the model. A judgement criterion is never machine-checked, so the check was dropped and the criterion kept.`,
      target: "rubric",
    });
  }
  if (totals.ruleRefsRemoved > 0) {
    flags.push({
      code: "rule_ref_removed",
      message: `${totals.ruleRefsRemoved} rule reference(s) given by the model were not printed with their quote and could not be derived from the source's layout, so they were left out. The criteria were kept: their quotes are verbatim.`,
      target: "rubric",
    });
  }
  if (totals.ruleRefsDerived > 0) {
    flags.push({
      code: "rule_ref_derived",
      message: `${totals.ruleRefsDerived} rule reference(s) were taken from the source's own layout (a paragraph label, a list marker under its parent paragraph, or the heading above), not from the model.`,
      target: "rubric",
    });
  }
  // (#207) Specialist-activity rules are KEPT. Said once, with the count, for
  // the ones code could not tie to an intake question: they stay in the
  // rubric, and an assessment reports each as "could not tell whether this
  // applies" until a question links them.
  const unlinkedSpecialist = criteria.filter((c) => c.applicability === "specialist" && !c.trigger).length;
  if (unlinkedSpecialist > 0) {
    flags.push({
      code: "specialist_rules_without_trigger",
      message: `${unlinkedSpecialist} specialist-activity rule(s) could not be tied to an intake question and answer, so they are kept but cannot be told apart by an applicant's answers: an assessment reports each as "could not tell whether this applies". They are never dropped and never applied to everyone.`,
      target: "rubric",
    });
  }
  if (simplifiedRuleTriggers > 0) {
    flags.push({
      code: "rule_trigger_simplified",
      message: `${simplifiedRuleTriggers} rule trigger(s) named a second, different question for a rule; only the first question is stored. Read the rule's condition in the source.`,
      target: "rubric",
    });
  }
  if (simplifiedTriggers > 0) {
    flags.push({
      code: "evidence_trigger_simplified",
      message: `${simplifiedTriggers} evidence item(s) had several different triggers; only the first is stored. Read the quote to see when the document is asked for.`,
      target: "rubric",
    });
  }
  flags.push(...possibleDuplicateFlags(criteria));

  return { criteria, intake, intakeQuestions, evidenceItems: [...evidence.values()], intentPolarityProposal, suspiciousPassages, discards, flags };
}

/** Share of words two criteria must have in common to be flagged as possible duplicates. */
const DUPLICATE_SIMILARITY = 0.8;

/**
 * Flag pairs of criteria whose quotes are near-identical (issue #112). They
 * are NOT merged: whether two rules are the same rule is for the reviewer.
 * Similarity is the share of distinct lower-case words the quotes have in
 * common (Jaccard). Quadratic, which is fine for a few hundred criteria.
 */
export function possibleDuplicateFlags(criteria: readonly AssessmentCriterion[]): RubricFlag[] {
  const words = criteria.map((c) => new Set(c.source.quote.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 2)));
  const flags: RubricFlag[] = [];
  for (let i = 0; i < criteria.length; i++) {
    for (let j = i + 1; j < criteria.length; j++) {
      const a = words[i];
      const b = words[j];
      if (a.size < 4 || b.size < 4) continue;
      let shared = 0;
      for (const w of a) if (b.has(w)) shared++;
      if (shared / (a.size + b.size - shared) >= DUPLICATE_SIMILARITY) {
        flags.push({ code: "possible_duplicate", message: `this criterion's quote is nearly the same as that of ${criteria[j].criterionId}. Decide whether they are one rule.`, target: criteria[i].criterionId });
      }
    }
  }
  return flags;
}

/** What `reviewFlagsFor` needs to know about the run besides its content. */
export interface ReviewFlagContext {
  // Model calls the version was built from.
  chunkCount: number;
  // PDF pages whose text does not end at the end of a sentence, per source.
  pagesEndingMidSentence: { sourceId: string; pages: number[] }[];
}

/** Characters a page can end on and still be "at the end of a sentence". */
const SENTENCE_END_RE = /[.!?:;)\]"'\u2019\u201D\u00BB]$/;

/** 1-based numbers of a PDF snapshot's pages that end mid-sentence. */
export function pagesEndingMidSentence(snapshot: Pick<GuidanceSnapshotContent, "pages">): number[] {
  return (snapshot.pages ?? []).filter((p) => p.text.trim().length > 0 && !SENTENCE_END_RE.test(p.text.trim())).map((p) => p.page);
}

/**
 * The STANDING reviewer flags of an extracted rubric: things code cannot
 * verify, said out loud on every version they apply to, so a reviewer never
 * has to remember them. They are remarks, not errors.
 *
 *  - nationality_codes_model_proposed   any mandatory bar: the country codes
 *        are the model's mapping of the source's wording; confirm each one.
 *  - nationality_code_name_mismatch     per criterion and code: the
 *        platform's name for the code is not how the source names it.
 *  - title_wording_uncited              criterion titles are model wording.
 *  - quote_ends_mid_sentence / multiple_dates_in_quote   per criterion (see
 *        mergeAssessments), beside quote_starts_mid_sentence.
 *  - intake_wording_uncited             intake labels, help text and options
 *        are the model's wording, not quotes.
 *  - multiple_chunks / page_ends_mid_sentence   a rule that runs across a
 *        chunk or page boundary may be missing or cut short.
 */
export function reviewFlagsFor(content: Pick<MergedRubricContent, "criteria" | "intakeQuestions">, ctx: ReviewFlagContext): RubricFlag[] {
  const flags: RubricFlag[] = [];
  const bars = content.criteria.filter((c) => c.kind === "mandatory_bar" && c.appliesTo);
  // (#222) Bars whose group has members with no code: the reviewer sees them listed too.
  const uncodedBars = bars.filter((c) => (c.appliesTo?.uncoded ?? []).length > 0);
  if (bars.length > 0) {
    flags.push({
      code: "nationality_codes_model_proposed",
      message: `${bars.length} mandatory bar(s) carry country codes proposed by the extraction model from the source's wording. Code has checked the wording is in the quote, not that each code is the right one: confirm every code against appliesTo.asWritten before approving.${uncodedBars.length > 0 ? ` ${uncodedBars.length} of them also name group members that are not nationalities and carry no code (appliesTo.uncoded: ${uncodedBars.map((c) => (c.appliesTo?.uncoded ?? []).join("; ")).join(" | ")}): confirm those too.` : ""}`,
      target: "rubric",
    });
  }
  for (const c of bars) {
    const a = c.appliesTo as NonNullable<AssessmentCriterion["appliesTo"]>;
    a.nationalities.forEach((code, i) => {
      const name = a.codeNames?.[i] ?? regionDisplayName(code);
      // Compared without case; anything else (a different spelling, an
      // adjective, a code the platform does not know) is for the reviewer.
      if (name.toLowerCase() !== (a.asWritten[i] ?? "").trim().toLowerCase()) {
        flags.push({
          code: "nationality_code_name_mismatch",
          // The code is two validated letters and the name is platform data:
          // neither is free text from the model.
          message: `entry ${i + 1} of the group: code ${code} is "${name}" on this platform, which is not how the source names that entry. Confirm or reject the code.`,
          target: c.criterionId,
        });
      }
    });
  }
  if (content.criteria.length > 0) {
    flags.push({
      code: "title_wording_uncited",
      message: `${content.criteria.length} criterion title(s) are wording written by the extraction model (applicant-facing: the free tier shows a title on its own), not quotes from the source. Read each title against its quote before approving.`,
      target: "rubric",
    });
  }
  if (content.intakeQuestions.length > 0) {
    flags.push({
      code: "intake_wording_uncited",
      message: `${content.intakeQuestions.length} intake question(s): their labels, help text and options are wording written by the extraction model, not quotes from the source. Read each one before approving.`,
      target: "rubric",
    });
  }
  if (ctx.chunkCount > 1) {
    flags.push({
      code: "multiple_chunks",
      message: `built from ${ctx.chunkCount} separate excerpts of the source(s). A rule whose text runs across the boundary between two excerpts may be missing or incomplete.`,
      target: "rubric",
    });
  }
  for (const s of ctx.pagesEndingMidSentence) {
    if (s.pages.length === 0) continue;
    const shown = s.pages.slice(0, 30).join(", ");
    flags.push({
      code: "page_ends_mid_sentence",
      message: `${s.pages.length} page(s) of ${s.sourceId} do not end at the end of a sentence (page ${shown}${s.pages.length > 30 ? ", ..." : ""}). A quote cannot cross a page break, so a rule that does may be missing or cut short.`,
      target: "rubric",
    });
  }
  return flags;
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

/**
 * (#216) How a model call behaves inside a background job. Absent (the
 * one-shot `extractRoute` and the CLI) = exactly the behaviour before the job
 * existed: no deadline, two attempts, real clock and sleep.
 */
export interface CallOptions {
  // Wall-clock end (ms since epoch) of the invocation the call runs in.
  deadlineAt?: number;
  // Clock; tests inject a fake one.
  nowMs?: () => number;
  // Pause between attempts; tests inject an instant one.
  sleep?: (ms: number) => Promise<void>;
  // Attempts allowed for THIS call (default: MAX_CALL_ATTEMPTS).
  maxAttempts?: number;
}

/** Re-exported so the job counts attempts the same way the one-shot run does. */
export type { CallAttempts };

/**
 * The criteria of one chunk that the second call (intake questions and
 * evidence) is told about: what code ACCEPTED from the first call. Pure, so
 * the one-shot run and the job build the same request from the same stored
 * first-call result.
 */
export function acceptedViewOf(criteriaPart: ChunkAssessment): AcceptedCriterionView[] {
  return criteriaPart.criteria.map((a) => ({
    ref: a.ref,
    title: a.criterion.title,
    quote: a.criterion.source.quote,
    ...(a.criterion.applicability === "specialist" || a.criterion.applicability === "conditional"
      ? { applicability: a.criterion.applicability, ...(a.criterion.applicabilityCondition ? { condition: a.criterion.applicabilityCondition } : {}) }
      : {}),
  }));
}

/**
 * Remember the questions a chunk's second call asked (and their options) so the
 * calls for the chunks that FOLLOW are shown them: the question that
 * establishes an activity is asked once and reused (#207). This is what makes
 * the chunks ORDER-DEPENDENT, and therefore the job's steps strictly sequential.
 * Mutates `known`.
 */
export function rememberQuestions(known: Map<string, KnownQuestionView>, assessment: Pick<ChunkAssessment, "intakeQuestions">): void {
  for (const q of assessment.intakeQuestions) {
    const prior = known.get(q.id);
    const have = new Set((prior?.options ?? []).map((o) => o.value));
    known.set(q.id, {
      id: q.id,
      label: prior?.label ?? q.label,
      answerType: prior?.answerType ?? q.answerType,
      options: [...(prior?.options ?? []), ...q.options.filter((o) => !have.has(o.value)).map((o) => ({ value: o.value, label: o.label }))],
    });
  }
}

/** The run settings a plan is built from (and a job pins). */
export type RunSettingsPin = Pick<RubricExtractionSettings, "maxChunkChars" | "maxOutputTokensPerRequest" | "requestTimeoutMs" | "maxRequestsPerRun" | "maxInputCharsPerRun">;

/**
 * Everything a run needs that is recomputed, never stored, from the pinned
 * sources: the prepared snapshots, the chunks (the cut is deterministic, see
 * `chunkSnapshot`), the scope allow-list and the request limits.
 */
export interface RunContext {
  sources: LoadedSource[];
  indexes: Map<string, SnapshotQuoteIndex>;
  midSentence: ReviewFlagContext["pagesEndingMidSentence"];
  chunks: SourceChunk[];
  plan: PlannedSource[];
  severityLevels: string[];
  limits: { maxOutputTokens: number; timeoutMs: number };
  routeName: string;
  primaries: LoadedSource[];
  scope: RouteScope | null;
}

/**
 * (#220) The translations of the rules that are in the merged rulebook, and
 * only those (a rule merged away as a duplicate keeps none), in rule order.
 */
export function keptTranslations(translations: Readonly<Record<string, QuoteTranslation>>, criteria: readonly Pick<AssessmentCriterion, "criterionId">[]): Record<string, QuoteTranslation> {
  const out: Record<string, QuoteTranslation> = {};
  for (const c of criteria) if (translations[c.criterionId]) out[c.criterionId] = translations[c.criterionId];
  return out;
}

/** (#220) The quotes of a chunk's accepted rules, as the translation call is given them. */
export function translationItemsOf(assessment: Pick<ChunkAssessment, "criteria">): TranslationItem[] {
  return assessment.criteria.map((a) => ({ criterionId: a.criterion.criterionId, quote: a.criterion.source.quote }));
}

/** (#220) What the translation step of one excerpt produced. It never throws: a failure is `failed`, and the rules simply have none. */
export interface TranslateStepResult {
  translations: Record<string, QuoteTranslation>;
  // done: asked and read; failed: the call or its answer was unusable; skipped_cap: the request cap was used up
  outcome: "done" | "failed" | "skipped_cap";
  // A stable code (never text) for `failed`.
  reason?: string;
}

/** What `assembleDraft` produced. */
export type AssembledDraft =
  | { ok: false; reasonCode: "no_criteria_accepted" | "rubric_invalid"; error: string; discardedCount: number; discardedByReason: Record<string, number> }
  | { ok: true; draft: RubricDraft; merged: MergedRubricContent; discardedByReason: Record<string, number> };

/** What `assembleDraft` needs besides the parts. */
export interface AssembleInput {
  routeKey: string;
  countryCode: string;
  visaTypeId: string;
  sources: readonly LoadedSource[];
  sourceSetHash: string;
  model: string;
  runId: string;
  severityLevels: readonly string[];
  chunkCount: number;
  midSentence: ReviewFlagContext["pagesEndingMidSentence"];
  createdAt: Timestamp;
}

/**
 * Steps 7 and 8 up to (not including) the write, shared by the one-shot run
 * and the job's final step: merge the parts (document order), count and log
 * the discards, build the pending draft, validate its structure and add the
 * standing flags. Pure apart from the log lines. Same inputs, same draft:
 * this is the single place that decides what a rulebook looks like, which is
 * why the job's result equals the one-shot result.
 */
export function assembleDraft(input: AssembleInput, parts: readonly { chunk: Pick<SourceChunk, "sourceId" | "chunkIndex">; assessment: ChunkAssessment }[], translations: Readonly<Record<string, QuoteTranslation>> = {}): AssembledDraft {
  const merged = mergeAssessments(parts);
  const discardedByReason = countByReason(merged.discards);
  // Every rejection is logged with its reason CODE and where it came
  // from. Never the detail, the label, the model's text or source text.
  for (const d of merged.discards) console.warn(`${TAG} ${input.routeKey}: discarded ${d.itemType} (${d.reason}) from ${d.sourceId || "merge"}#${d.chunkIndex}`);
  if (merged.criteria.length === 0) {
    return { ok: false, reasonCode: "no_criteria_accepted", error: "no criterion survived validation", discardedCount: merged.discards.length, discardedByReason };
  }
  const keptQuoteTranslations = keptTranslations(translations, merged.criteria);
  const draft: RubricDraft = {
    schemaVersion: RUBRIC_SCHEMA_VERSION,
    routeKey: input.routeKey,
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
    severityLevels: [...input.severityLevels],
    criteria: merged.criteria,
    ...(merged.intake ? { intake: merged.intake } : {}),
    intakeQuestions: merged.intakeQuestions,
    evidenceItems: merged.evidenceItems,
    sourceSnapshots: input.sources.map((s) => s.snapshot),
    // (#220) What language each source is written in: the publish gate holds a
    // version unless every one of these is a supported language.
    sourceLanguages: sourceLanguagesOf(input.sources),
    // (#220) The unofficial translations, only for the rules that survived the
    // merge (a quote dropped as a duplicate keeps no translation), in a field of
    // their own, never in `source.quote`. Absent when there are none.
    ...(Object.keys(keptQuoteTranslations).length > 0 ? { quoteTranslations: keptQuoteTranslations } : {}),
    sourceSetHash: input.sourceSetHash,
    extractorModel: input.model,
    extractorPromptVersion: RUBRIC_PROMPT_VERSION,
    extractionRunId: input.runId,
    discardedCount: merged.discards.length,
    discarded: merged.discards.slice(0, MAX_STORED_DISCARDS),
    suspiciousPassages: merged.suspiciousPassages,
    flags: merged.flags,
    createdAt: input.createdAt,
  };
  const validation = validateVisaRubric({ ...draft, version: 1 });
  if (validation.errors.length > 0) {
    const codes = [...new Set(validation.errors.map((e) => e.code))].join(", ");
    return { ok: false, reasonCode: "rubric_invalid", error: `the merged rubric is not consistent: ${codes}`, discardedCount: merged.discards.length, discardedByReason };
  }
  draft.flags = [
    ...merged.flags,
    ...validation.flags,
    ...reviewFlagsFor(merged, { chunkCount: input.chunkCount, pagesEndingMidSentence: input.midSentence }),
  ];
  if (merged.suspiciousPassages.length > 0) {
    draft.flags.push({ code: "suspicious_passages", message: `${merged.suspiciousPassages.length} passage(s) of the source read as instructions to a reader model; no criterion quotes them. Read them before approving.`, target: "rubric" });
  }
  return { ok: true, draft, merged, discardedByReason };
}

// ============================================
// The service
// ============================================

/**
 * One source of a run, loaded. (#216) Exported and JSON-safe (plain strings and
 * numbers only): a background job stores the list of its sources as they were
 * when it started and rebuilds the run from it.
 */
export interface LoadedSource {
  snapshot: RubricSourceSnapshot;
  retrievedAt: string;
  // The source's role for its route (registry data); absent = secondary.
  role: SourceRole;
  // The registry's title for the document (data), used to tell whether the
  // route's own source refers to it by name.
  title: string;
  // (#220) The language the admin declared for the page (a code), as stored on
  // the source. Absent = the source predates the field (read as the product
  // language). The quote reader and the version's `sourceLanguages` use it.
  language?: string;
}

/**
 * (#223) What the one-rule re-draft of a protected rule gave back.
 *  - `replacement`        a rule that passed the SAME code validation as any
 *                         drafted rule (verbatim quote, group names in the quote,
 *                         check values in the quote, list items attached from the
 *                         stored text), for the same passage, still a bar;
 *  - `cannot_be_repaired` the model returned no rule for the passage (its
 *                         explicit "cannot be repaired" answer);
 *  - `invalid`            code refused what came back (`detail` is a code, never text).
 */
// (#243) `sameLine` (replacement only): whether the replacement quotes the SAME line of the stored text as
// the original. Always true for a bar (code refuses anything else); for an ordinary rule it can be false,
// when the rule was one item of a definition and came back as the definition's lead-in.
export type RedraftOutcome = { kind: "replacement"; criterion: AssessmentCriterion; sameLine?: boolean } | { kind: "cannot_be_repaired" } | { kind: "invalid"; detail: string };

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
  /** The model the drafting calls use (named on every run record and version). */
  modelName(): string {
    return this.provider.modelFor("judgement");
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
  async loadSource(sourceId: string): Promise<LoadedSource> {
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
        // (#220) Kept on the snapshot record too, so it travels with the version.
        ...(typeof source.language === "string" && source.language.trim() ? { language: source.language.trim() } : {}),
      },
      retrievedAt: meta.fetchedAt.toDate().toISOString(),
      role: source.role === "primary" || source.role === "route_guidance" ? source.role : "secondary",
      title: typeof source.title === "string" ? source.title : "",
      ...(typeof source.language === "string" && source.language.trim() ? { language: source.language.trim() } : {}),
    };
  }

  /**
   * The route's name from the catalogue (`countries/{cc}/visaTypes/{id}`),
   * sent to the model so it knows which category it is extracting for. Falls
   * back to the visa type id (data either way, never code).
   */
  async routeName(countryCode: string, visaTypeId: string): Promise<string> {
    if (this.deps.visaTypeName) return this.deps.visaTypeName(countryCode, visaTypeId);
    try {
      const data = (await subcollections.visaTypes(countryCode).doc(visaTypeId).get()).data() as { name?: unknown } | undefined;
      return typeof data?.name === "string" && data.name.trim() ? data.name.trim() : visaTypeId;
    } catch {
      return visaTypeId;
    }
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

    /** The run record for a status (the same doc id from start to finish). */
    const runRecord = (
      status: RubricRunStatus,
      r: Pick<ExtractRouteResult, "reasonCode" | "error" | "version" | "criteriaAccepted" | "specialistKept" | "discardedCount" | "discardedByReason" | "costUsd">
    ): RubricExtractionRun => ({
      runId,
      routeKey,
      countryCode: input.countryCode,
      visaTypeId: input.visaTypeId,
      status,
      reachedModel,
      reasonCode: r.reasonCode,
      error: r.error,
      trigger,
      sourceSnapshots: sources.map((s) => s.snapshot),
      sourceSetHash,
      model,
      promptVersion: RUBRIC_PROMPT_VERSION,
      version: r.version,
      chunks: chunkCount,
      usage,
      costUsd: r.costUsd,
      criteriaAccepted: r.criteriaAccepted,
      specialistKept: r.specialistKept,
      discardedCount: r.discardedCount,
      discardedByReason: r.discardedByReason,
      startedAt,
      finishedAt: this.now(),
    });

    /** Assemble a result (and, when asked, store the run record). */
    const finish = async (
      status: ExtractRouteResult["status"],
      fields: Partial<Pick<ExtractRouteResult, "reasonCode" | "error" | "version" | "criteriaAccepted" | "specialistKept" | "discardedCount" | "discardedByReason">>,
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
        specialistKept: fields.specialistKept ?? 0,
        discardedCount: fields.discardedCount ?? 0,
        discardedByReason: fields.discardedByReason ?? {},
        usage,
        costUsd,
      };
      if (record && status !== "dry_run") {
        const run = runRecord(status, result);
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
          `version=${result.version ?? "-"} chunks=${chunkCount} accepted=${result.criteriaAccepted} specialistKept=${result.specialistKept} discarded=${result.discardedCount} ` +
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

      // ---- 2 + 3. the route and its sources, then the hash gate ----
      // (#216: the same steps start a background job, see `resolveRoute`.)
      const head = await this.store.getHead(routeKey);
      const resolved = await this.resolveRoute(input, head);
      const sourceIds = resolved.sourceIds;
      sources = resolved.sources;
      sourceSetHash = resolved.sourceSetHash;
      if (!input.force && head && head.latestSourceSetHash === sourceSetHash) {
        return await finish("unchanged", { reasonCode: "source_unchanged", version: head.latestVersion }, false);
      }

      // ---- 4. plan: read the snapshot text, cut it, check the caps ----
      const routeName = await this.routeName(input.countryCode, input.visaTypeId);
      const ctx = await this.buildRunContext(sources, settings, routeName);
      plan = ctx.plan;
      chunkCount = ctx.chunks.length;
      if (chunkCount === 0) throw new RunStop("failed", "no_text", "the snapshots hold no text to extract from");
      this.assertWithinCaps(ctx.chunks, settings);
      if (input.dryRun) return await finish("dry_run", {}, false);

      // The daily cap counts the runs that REACHED THE MODEL today (UTC),
      // whatever became of them, so it is checked only now that this run is
      // about to.
      const dayStart = Timestamp.fromMillis(Math.floor(startedAt.toMillis() / 86_400_000) * 86_400_000);
      if ((await this.store.countRunsSince(dayStart)) >= settings.maxRunsPerDay) {
        throw new RunStop("skipped", "daily_cap_reached", `the daily cap of ${settings.maxRunsPerDay} extraction run(s) is used up`);
      }
      // Claim this run's place BEFORE its first call: a `started` record that
      // the final record later replaces. A run that crashes, or whose final
      // record cannot be saved, is then still counted, and a second run
      // starting meanwhile sees this one. (Check-then-write is not atomic:
      // two runs starting in the same instant can both pass, so the cap can
      // be exceeded by the number of simultaneous starts, not more.) If the
      // record cannot be written the run does not start: an uncounted run
      // is how a cap stops being one.
      reachedModel = true;
      try {
        await this.store.writeRun(runRecord("started", { reasonCode: null, error: null, version: null, criteriaAccepted: 0, specialistKept: 0, discardedCount: 0, discardedByReason: {}, costUsd: null }));
      } catch (err) {
        reachedModel = false;
        throw new RunStop("skipped", "run_record_unavailable", "the run could not be recorded, so it was not started");
      }

      // ---- 5 + 6. two calls per chunk, validated in code ----
      // Call 1 reads the criteria; code validates them. Call 2 reads the
      // intake questions and evidence items for the criteria code accepted
      // (a chunk with none gets no second call). The split keeps each schema
      // inside the provider's limits. (#216: each call is one STEP, run by
      // `runCriteriaStep` / `runIntakeStep`, the same functions the
      // background job calls one at a time.)
      const parts: { chunk: SourceChunk; assessment: ChunkAssessment }[] = [];
      // (#220) Unofficial translations of the quotes of non-product-language sources, by rule id.
      const translations: Record<string, QuoteTranslation> = {};
      // (#207) Questions asked so far, by id, shown to the next excerpt's call 2.
      const knownQuestions = new Map<string, KnownQuestionView>();
      // Failed attempts so far, counted against the request cap with the successes.
      const attempts: CallAttempts = { failed: 0, cap: settings.maxRequestsPerRun };
      for (const chunk of ctx.chunks) {
        const criteriaPart = await this.runCriteriaStep(ctx, chunk, usage, attempts);
        let assessment = criteriaPart;
        if (criteriaPart.criteria.length > 0) {
          const intakePart = await this.runIntakeStep(ctx, chunk, criteriaPart, [...knownQuestions.values()], usage, attempts);
          assessment = combineAssessments(criteriaPart, intakePart);
          // Remember each question (and its options) for the excerpts that follow.
          rememberQuestions(knownQuestions, assessment);
        }
        parts.push({ chunk, assessment });
        // (#220) One more step for an excerpt of a source in another language that has accepted rules:
        // a courtesy translation, never evidence, and never able to fail or block the run.
        if (assessment.criteria.length > 0 && needsTranslation(ctx.sources.find((s) => s.snapshot.sourceId === chunk.sourceId)?.language)) {
          Object.assign(translations, (await this.runTranslateStep(ctx, chunk, assessment, usage, attempts)).translations);
        }
      }

      // ---- 7 + 8. merge, build the draft, validate its structure ----
      const assembled = assembleDraft({ routeKey, countryCode: input.countryCode, visaTypeId: input.visaTypeId, sources, sourceSetHash: sourceSetHash as string, model, runId, severityLevels: ctx.severityLevels, chunkCount, midSentence: ctx.midSentence, createdAt: this.now() }, parts, translations);
      if (!assembled.ok) {
        return await finish("failed", { reasonCode: assembled.reasonCode, error: assembled.error, discardedCount: assembled.discardedCount, discardedByReason: assembled.discardedByReason }, true);
      }
      const { draft, merged, discardedByReason } = assembled;

      const written = await this.store.writePendingVersion(draft, sourceIds, { force: input.force, now: this.now() });
      if (!written.written) {
        // Another run wrote this source set while this one was extracting.
        return await finish("unchanged", { reasonCode: "source_unchanged", version: written.version }, true);
      }
      return await finish("succeeded", { version: written.version, criteriaAccepted: merged.criteria.length, specialistKept: merged.criteria.filter((c) => c.applicability === "specialist").length, discardedCount: merged.discards.length, discardedByReason }, true);
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

  /**
   * Steps 2 and 3 of a run, shared with the background job's start: the
   * route's sources (given, or remembered on the head), the visa type check,
   * and each source's registry entry with the metadata of its newest snapshot.
   * Throws `RunStop` for an expected problem. The hash gate itself is left to
   * the caller (it differs: the job also compares against running jobs).
   */
  async resolveRoute(input: Pick<ExtractRouteInput, "countryCode" | "visaTypeId" | "sourceIds">, head: RubricHead | null): Promise<{ sourceIds: string[]; sources: LoadedSource[]; sourceSetHash: string }> {
    const sourceIds = [...new Set(input.sourceIds && input.sourceIds.length > 0 ? input.sourceIds : head?.sourceIds ?? [])].sort();
    if (sourceIds.length === 0) throw new RunStop("failed", "no_sources", "no guidance sources given, and the route has none recorded");
    // A rubric is only ever attached to a real visa type.
    if (!(await this.visaTypeExists(input.countryCode, input.visaTypeId))) {
      throw new RunStop("failed", "visa_type_not_found", `no visa type ${input.visaTypeId} under ${input.countryCode}`);
    }
    const sources: LoadedSource[] = [];
    for (const id of sourceIds) sources.push(await this.loadSource(id));
    return { sourceIds, sources, sourceSetHash: sourceSetHashOf(sources.map((s) => s.snapshot)) };
  }

  /**
   * Step 4: read the text of each PINNED snapshot (by content hash, never by
   * "latest": `read` re-hashes the text and refuses a mismatch), prepare it
   * for quote lookups, and cut it into chunks. Everything here is a pure
   * function of the sources and the settings, so a background job stores
   * only the sources and rebuilds this context at the start of each
   * invocation instead of storing the (large) text.
   */
  async buildRunContext(sources: LoadedSource[], settings: Pick<RunSettingsPin, "maxChunkChars" | "maxOutputTokensPerRequest" | "requestTimeoutMs">, routeName: string): Promise<RunContext> {
    const indexes = new Map<string, SnapshotQuoteIndex>();
    const midSentence: ReviewFlagContext["pagesEndingMidSentence"] = [];
    const chunks: SourceChunk[] = [];
    const plan: PlannedSource[] = [];
    for (const s of sources) {
      const content: GuidanceSnapshotContent = await this.snapshots.read(s.snapshot.sourceId, s.snapshot.contentHash);
      // (#220) Each document is read in its own language (data: a lexicon file).
      indexes.set(s.snapshot.sourceId, new SnapshotQuoteIndex(content, lexiconFor(s.language)));
      midSentence.push({ sourceId: s.snapshot.sourceId, pages: pagesEndingMidSentence(content) });
      const cut = chunkSnapshot(content, settings.maxChunkChars);
      chunks.push(...cut);
      plan.push({ sourceId: s.snapshot.sourceId, contentHashPrefix: s.snapshot.contentHash.slice(0, 12), docType: s.snapshot.docType, chars: content.text.length, chunks: cut.length });
    }
    // The scope allow-list is built, in code, from the route's own source(s).
    const primaries = sources.filter((s) => s.role === "primary");
    const scope = primaries.length > 0 ? routeScopeFrom(primaries.map((s) => (indexes.get(s.snapshot.sourceId) as SnapshotQuoteIndex).allText()), primaries.map((s) => (indexes.get(s.snapshot.sourceId) as SnapshotQuoteIndex).lexicon)) : null;
    return {
      sources,
      indexes,
      midSentence,
      chunks,
      plan,
      severityLevels: [...DEFAULT_SEVERITY_LEVELS],
      limits: { maxOutputTokens: settings.maxOutputTokensPerRequest, timeoutMs: settings.requestTimeoutMs },
      routeName,
      primaries,
      scope,
    };
  }

  /** What validating one chunk's answer needs: its snapshot, citation base, route context and scope. */
  private chunkInputs(ctx: RunContext, chunk: SourceChunk): { index: SnapshotQuoteIndex; base: CitationBase; route: RubricRouteContext; scopeForChunk: SourceScope | null } {
    const source = ctx.sources.find((s) => s.snapshot.sourceId === chunk.sourceId) as LoadedSource;
    const index = ctx.indexes.get(chunk.sourceId) as SnapshotQuoteIndex;
    const base: CitationBase = {
      sourceId: chunk.sourceId,
      url: source.snapshot.url,
      contentHash: chunk.contentHash,
      retrievedAt: source.retrievedAt,
      ...(source.snapshot.publishedDate ? { publishedDate: source.snapshot.publishedDate } : {}),
    };
    // Scoping applies only when the run has a primary source. What is
    // kept from each source depends on its role (see assessCriterion 3c).
    const route: RubricRouteContext = { routeName: ctx.routeName, sourceRole: ctx.primaries.length === 0 ? "unspecified" : source.role };
    const scopeForChunk: SourceScope | null = ctx.scope
      ? { role: source.role, allow: ctx.scope, namedByPrimary: source.role === "secondary" && primaryNamesDocument(ctx.scope, source.title, index.allText()) }
      : null;
    return { index, base, route, scopeForChunk };
  }

  /**
   * STEP "criteria" of one chunk: exactly ONE model call (call 1) and the
   * validation of its answer in code. Needs nothing from other chunks.
   * Returns the validated criteria half of the chunk's assessment: plain JSON
   * (no Map, Set or class), which is what a job stores.
   */
  async runCriteriaStep(ctx: RunContext, chunk: SourceChunk, usage: RubricRunUsage, attempts: CallAttempts, opts: CallOptions = {}): Promise<ChunkAssessment> {
    const { index, base, route, scopeForChunk } = this.chunkInputs(ctx, chunk);
    const raw = await this.callModel(buildRubricRequest(chunk, ctx.severityLevels, ctx.limits, route), usage, attempts, opts);
    return assessChunkOutput(raw, chunk, index, base, ctx.severityLevels, scopeForChunk);
  }

  /**
   * STEP "intake" of one chunk: exactly ONE model call (call 2) and the
   * validation of its answer. It needs two things from earlier steps: the
   * criteria code accepted from this chunk's own criteria step, and the
   * questions already asked for EARLIER chunks (`known`, in document order).
   * That second input is why chunks cannot be processed in parallel or out of
   * order. Returns the intake half of the chunk's assessment (join it with
   * the criteria half using `combineAssessments`).
   */
  async runIntakeStep(ctx: RunContext, chunk: SourceChunk, criteriaPart: ChunkAssessment, known: KnownQuestionView[], usage: RubricRunUsage, attempts: CallAttempts, opts: CallOptions = {}): Promise<ChunkAssessment> {
    const { index, base, route } = this.chunkInputs(ctx, chunk);
    // (#207) Scoped rules go with their applicability and condition words,
    // and the questions asked in earlier excerpts go too, so the question
    // that establishes an activity is asked once and reused.
    const raw = await this.callModel(buildIntakeRequest(chunk, acceptedViewOf(criteriaPart), ctx.limits, route, known), usage, attempts, opts);
    return assessChunkOutput(raw, chunk, index, base, ctx.severityLevels);
  }

  /**
   * (#220) STEP "translate" of one excerpt: ONE model call that translates the
   * quotes of the excerpt's accepted rules into the product language, as an
   * UNOFFICIAL courtesy (see rubric-translation.ts for the firewall: never
   * evidence, never shown to any model as support).
   *
   * It NEVER throws and never fails a run: the cap used up, a provider error,
   * a refusal, a cut-off or an unusable answer all return `failed` /
   * `skipped_cap` with no translations, and the rules simply have none. It does
   * count: its tokens go into `usage` and its failed attempts into `attempts`,
   * so it spends against the same request cap as every other call.
   * Only the quotes (verbatim source text, already validated) are sent: no rule
   * title, no question, nothing the model wrote.
   */
  async runTranslateStep(ctx: Pick<RunContext, "sources" | "limits">, chunk: Pick<SourceChunk, "sourceId">, assessment: Pick<ChunkAssessment, "criteria">, usage: RubricRunUsage, attempts: CallAttempts, opts: CallOptions = {}): Promise<TranslateStepResult> {
    const items = translationItemsOf(assessment);
    if (items.length === 0) return { translations: {}, outcome: "done" };
    // The cap counts this call like any other; used up = no translation, not a failed run.
    if (usage.requests + attempts.failed >= attempts.cap) return { translations: {}, outcome: "skipped_cap" };
    const language = ctx.sources.find((s) => s.snapshot.sourceId === chunk.sourceId)?.language;
    const code = resolveSourceLanguage(language);
    let request: LlmRequest;
    try {
      request = buildTranslationRequest(items, lexiconFor(code).name, ctx.limits);
    } catch (err) {
      return { translations: {}, outcome: "failed", reason: err instanceof TranslationError ? "prompt_refused" : "unexpected_error" };
    }
    const maxAttempts = opts.maxAttempts ?? MAX_CALL_ATTEMPTS;
    const nowMs = opts.nowMs ?? Date.now;
    const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    for (let attempt = 1; ; attempt++) {
      try {
        const response = await this.provider.complete(request);
        usage.requests += 1;
        usage.inputTokens += response.usage.inputTokens;
        usage.outputTokens += response.usage.outputTokens;
        usage.cacheReadTokens += response.usage.cacheReadTokens;
        usage.cacheWriteTokens += response.usage.cacheWriteTokens;
        if (response.stopReason !== "end_turn") return { translations: {}, outcome: "failed", reason: response.stopReason === "refusal" ? "provider_refused" : response.stopReason === "max_tokens" ? "output_truncated" : "provider_stopped" };
        const read = parseTranslationOutput(response.text, items);
        const model = this.provider.modelFor("judgement");
        const quoteOf = new Map(items.map((i) => [i.criterionId, i.quote]));
        const translations: Record<string, QuoteTranslation> = {};
        for (const [id, text] of read) translations[id] = toQuoteTranslation(text, quoteOf.get(id) as string, model, productLanguageCode());
        return { translations, outcome: "done" };
      } catch (err) {
        if (err instanceof TranslationError) return { translations: {}, outcome: "failed", reason: "invalid_model_output" };
        const message = describeAnthropicError(err).slice(0, 300);
        const retry = isTransientProviderError(message) && attempt < maxAttempts && usage.requests + attempts.failed + 1 < attempts.cap;
        const backoff = RETRY_BACKOFF_MS * attempt;
        if (!retry || (opts.deadlineAt !== undefined && nowMs() + backoff + request.timeoutMs > opts.deadlineAt)) {
          // A provider error is a counted failed attempt (no answer was received), not a failed run.
          attempts.failed += 1;
          return { translations: {}, outcome: "failed", reason: err instanceof AnthropicNotConfiguredError ? "ai_not_configured" : "provider_error" };
        }
        attempts.failed += 1;
        await sleep(backoff);
      }
    }
  }

  /**
   * (#223) ONE re-draft of ONE protected rule that failed the independent
   * check: a fresh draft from the rule's own source passage (the quote's line,
   * the lines above it and the list lines below it, bounded), through the SAME
   * request schema, `assessChunkOutput` validation and list attach as the main
   * drafting path. There is no second drafting path: this only changes what is
   * shown to the model (a window instead of a chunk, plus the failed rule and
   * the aspects that failed) and which accepted rule is taken back.
   *
   * What is taken back: exactly one accepted rule that quotes the SAME line of
   * the stored text as the original, is still a bar (a repair can never turn a
   * bar into something that is not one), and has a readable list. The
   * replacement keeps the original's `criterionId` and its link fields
   * (`trigger`, `eligibilityQuestionId`, `intakeQuestionIds`), so every
   * reference to the rule stays valid. A rule with a trigger keeps the SAME
   * applicability (the trigger is bound to it); a rule without one may differ.
   *
   * One model call (plus the call's own transient retry, which counts in
   * `attempts`). Throws `RunStop` for a provider failure, like the other steps.
   */
  async redraftRule(
    input: { rule: AssessmentCriterion; aspects: readonly string[]; index: SnapshotQuoteIndex; routeName: string; limits: { maxOutputTokens: number; timeoutMs: number }; sent?: { chars: number } },
    usage: RubricRunUsage,
    attempts: CallAttempts,
    opts: CallOptions = {}
  ): Promise<RedraftOutcome> {
    const { rule, index } = input;
    const found = index.locate(rule.source.quote);
    if (!found.ok) return { kind: "invalid", detail: "quote_not_found" };

    // ---- the passage the model is shown: verbatim source lines around the quote ----
    const window = index.passageWindow(found, REPAIR_WINDOW_LINES_BEFORE, REPAIR_WINDOW_LINES_AFTER, REPAIR_WINDOW_CHARS);
    const chunk: SourceChunk = {
      sourceId: rule.source.sourceId,
      contentHash: rule.source.contentHash,
      docType: index.snapshot.docType,
      chunkIndex: 0,
      chunkCount: 1,
      ...(window.page !== undefined ? { pageStart: window.page, pageEnd: window.page } : {}),
      text: window.page !== undefined ? `${pageMarker(window.page)}\n${window.text}` : window.text,
    };
    // The source role is the rule's own source's: not needed to choose a window, so left unspecified.
    const route: RubricRouteContext = { routeName: input.routeName, sourceRole: "unspecified" };
    const shown: RepairRuleView = {
      title: rule.title,
      kind: rule.kind,
      stage: rule.stage,
      quote: rule.source.quote,
      ...(rule.source.listItems ? { listItems: rule.source.listItems } : {}),
      ...(rule.appliesTo ? { appliesTo: { nationalities: rule.appliesTo.nationalities, asWritten: rule.appliesTo.asWritten, ...(rule.appliesTo.uncoded ? { uncoded: rule.appliesTo.uncoded } : {}) } } : {}),
    };
    const levels = [...DEFAULT_SEVERITY_LEVELS];
    const request = buildRepairRequest(chunk, { rule: shown, aspects: input.aspects }, levels, input.limits, route);
    // The caller's input-size cap counts what is really sent (the prompt plus the bounded window).
    if (input.sent) input.sent.chars += request.system.length + request.user.length;
    const raw = await this.callModel(request, usage, attempts, opts);
    // The model's own "cannot be repaired": no rule at all.
    if (raw.criteria.length === 0) return { kind: "cannot_be_repaired" };

    // ---- the SAME validation as any drafted rule; citations come from the original's own source ----
    const base: CitationBase = {
      sourceId: rule.source.sourceId,
      url: rule.source.url,
      contentHash: rule.source.contentHash,
      retrievedAt: rule.source.retrievedAt,
      ...(rule.source.publishedDate ? { publishedDate: rule.source.publishedDate } : {}),
    };
    const assessed = assessChunkOutput(raw, chunk, index, base, levels, null);
    if (assessed.criteria.length === 0) return { kind: "invalid", detail: assessed.discards.find((d) => d.itemType === "criterion")?.reason ?? "invalid_shape" };

    // ---- the one accepted rule that is the same rule again ----
    // Each accepted rule is tested on the two conditions separately, so a refusal can say WHICH failed
    // (#226 diagnostics): the rule quotes the same line of the stored text, and the rule is still a bar.
    const tested = assessed.criteria.map((a) => {
      const at = index.locate(a.criterion.source.quote);
      return { a, sameLine: at.ok && at.unit === found.unit, bar: isBar(a.criterion) };
    });
    // (#243) An ORDINARY original (not a bar) is re-drafted by the one-off script (`repair-saved-rule`) and later
    // by the publish run (#240-D). Its replacement must never be a bar (a repair can never make a rule a bar:
    // that would change what the code refuses on), and it may quote the lead-in of the definition or alternatives
    // the original was one item of, so the same-line rule is a preference here, not a requirement: it is reported.
    const ordinaryOriginal = !isBar(rule);
    const sameRule = ordinaryOriginal ? tested.filter((t) => !t.bar).map((t) => t.a) : tested.filter((t) => t.sameLine && t.bar).map((t) => t.a);
    if (ordinaryOriginal && sameRule.length === 0) return { kind: "invalid", detail: `became_a_bar:returned=${raw.criteria.length}:accepted=${tested.length}` };
    if (sameRule.length === 0) {
      // Counts and a cause word only, stored on the repair record: never the quote or any model text.
      //   different_line: no accepted rule quotes the original's line (the model drafted another line of the window);
      //   not_a_bar:      one does, but it is no longer a mandatory bar and has no named group (kind changed).
      const sameLineCount = tested.filter((t) => t.sameLine).length;
      const cause = sameLineCount === 0 ? "different_line" : "not_a_bar";
      return { kind: "invalid", detail: `not_the_same_bar:${cause}:returned=${raw.criteria.length}:accepted=${tested.length}:same_line=${sameLineCount}:bar=${tested.filter((t) => t.bar).length}` };
    }
    // Ordinary original: if more than one rule came back, the one on the original's own line wins, else it is ambiguous.
    const sameLineOf = (a: (typeof sameRule)[number]): boolean => tested.find((t) => t.a === a)?.sameLine === true;
    const pool = ordinaryOriginal && sameRule.length > 1 && sameRule.filter(sameLineOf).length === 1 ? sameRule.filter(sameLineOf) : sameRule;
    if (pool.length > 1) return { kind: "invalid", detail: "ambiguous_redraft" };
    const accepted = pool[0];
    // A lead-in whose list could not be read cleanly is refused here, as the gates would hold it anyway.
    if (accepted.listUnreadable !== undefined) return { kind: "invalid", detail: accepted.listUnreadable };
    const normApplicability = (c: AssessmentCriterion): string => c.applicability ?? "all_applicants";
    // (#240) The trigger was planned for the ORIGINAL's applicability, so a change is refused, EXCEPT
    // between `conditional` and `specialist`: with a valid trigger the two behave identically in
    // `resolveApplicability` (the rule applies by the applicant's answer), so swapping them changes
    // nothing for any applicant, and the original's trigger is carried over below. A change to or from
    // `all_applicants` (or to `other_route`) WOULD change who the rule applies to, so it is still
    // refused. The replacement's trigger is still checked by both models like any other.
    const scoped = (c: AssessmentCriterion): boolean => c.applicability === "conditional" || c.applicability === "specialist";
    const applicabilitySwap = scoped(rule) && scoped(accepted.criterion);
    if (rule.trigger !== undefined && normApplicability(rule) !== normApplicability(accepted.criterion) && !applicabilitySwap) return { kind: "invalid", detail: "applicability_changed" };
    const criterion: AssessmentCriterion = {
      ...accepted.criterion,
      criterionId: rule.criterionId,
      ...(rule.trigger !== undefined ? { trigger: rule.trigger } : {}),
      ...(rule.eligibilityQuestionId !== undefined ? { eligibilityQuestionId: rule.eligibilityQuestionId } : {}),
      ...(rule.intakeQuestionIds !== undefined ? { intakeQuestionIds: rule.intakeQuestionIds } : {}),
    };
    return { kind: "replacement", criterion, sameLine: sameLineOf(accepted) };
  }

  /** Refuse the run when its plan would pass a per-run cap. (#216: public, the job start checks the same caps.) */
  assertWithinCaps(chunks: readonly SourceChunk[], settings: RubricExtractionSettings): void {
    // Two calls per chunk at most (criteria, then intake and evidence).
    if (chunks.length * 2 > settings.maxRequestsPerRun) {
      throw new RunStop("skipped", "run_cap_exceeded", `the run needs up to ${chunks.length * 2} requests; the cap is ${settings.maxRequestsPerRun}`);
    }
    const chars = chunks.reduce((n, c) => n + c.text.length, 0);
    if (chars > settings.maxInputCharsPerRun) {
      throw new RunStop("skipped", "run_cap_exceeded", `the run would send ${chars} characters; the cap is ${settings.maxInputCharsPerRun}`);
    }
  }

  /**
   * One model call with a retry (issue #112): at most 2 attempts, a short
   * pause between them, and only for a TRANSIENT failure: a connection cut,
   * a 5xx, 429 or "overloaded" (529). A 4xx (bad request, auth, schema), a
   * missing key, a refusal, a cut-off answer and an answer that breaks the
   * schema are never retried. Every attempt counts against the run's request
   * cap, and calls already completed for earlier chunks are untouched (their
   * results sit in `parts`), so one dropped connection costs one call.
   *
   * (#216) Deadline aware. A background job runs inside a function invocation
   * that is cut off at a fixed time. When `opts.deadlineAt` is given, the
   * in-process retry (pause, then a second attempt that may itself take the
   * whole request timeout) happens only if it can still finish before the
   * deadline; otherwise the transient error is rethrown and the job records a
   * failed attempt for this step, which the NEXT invocation retries. Nothing
   * is retried silently forever: the job bounds the attempts per step.
   */
  private async callModel(request: LlmRequest, usage: RubricRunUsage, attempts: CallAttempts, opts: CallOptions = {}): Promise<RawRubricOutput> {
    const maxAttempts = opts.maxAttempts ?? MAX_CALL_ATTEMPTS;
    const nowMs = opts.nowMs ?? Date.now;
    const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.callModelOnce(request, usage);
      } catch (err) {
        const retryable = err instanceof RunStop && err.reasonCode === "provider_error" && isTransientProviderError(err.message);
        if (!retryable || attempt >= maxAttempts || usage.requests + attempts.failed + 1 >= attempts.cap) throw err;
        const backoff = RETRY_BACKOFF_MS * attempt;
        // Not enough time left in this invocation for a pause and a whole
        // second request: hand the retry to the next invocation.
        if (opts.deadlineAt !== undefined && nowMs() + backoff + request.timeoutMs > opts.deadlineAt) throw err;
        attempts.failed += 1;
        console.warn(`${TAG} model call failed transiently, retrying (attempt ${attempt + 1} of ${maxAttempts})`);
        await sleep(backoff);
      }
    }
  }

  /**
   * One model call: send, account for the tokens (whatever happens next,
   * they were billed), require a complete answer, check its shape.
   *
   * @throws RunStop("failed", ...) for anything but a complete, schema-valid answer
   */
  private async callModelOnce(request: LlmRequest, usage: RubricRunUsage): Promise<RawRubricOutput> {
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
   * Listener for the guidance crawl's `onChanged` hook: re-draft every route
   * that uses the changed source. (#216) It no longer runs the extraction
   * inline: it creates (or finds) the route's background DRAFTING JOB, which a
   * worker advances in saved steps (a route can need 30-40 minutes, far over
   * the function's 540 seconds). The checks are the same as before and happen
   * in the job's start: a hash gate (unchanged sources start nothing), the
   * kill switch, the caps. It does not throw (`startJob` reports problems in
   * its result). Should it fail anyway, the crawl does not retry a listener,
   * and `runPending` picks the route up later.
   */
  async onGuidanceChanged(event: Pick<GuidanceChangeEvent, "sourceId">): Promise<StartJobResult[]> {
    const results: StartJobResult[] = [];
    const heads = await this.store.listHeads();
    // (#169) Tell the two "nothing to do" cases apart in the log. With no head
    // at all, no route has ever been extracted: a route's FIRST extraction is
    // started by hand (owner decision, #112), so a changed source cannot start
    // one. With heads but none listing this source, the source simply belongs
    // to no extracted route. Behaviour is unchanged in both: nothing runs.
    if (heads.length === 0) {
      console.log(`${TAG} source ${event.sourceId} changed: no rubric exists yet for any route using this source; a route's first extraction must be started by hand (npm run extract:rubric)`);
    } else if (!heads.some((h) => (h.sourceIds ?? []).includes(event.sourceId))) {
      console.log(`${TAG} source ${event.sourceId} changed: rubrics exist, but no rubric head lists this source in its sourceIds, so nothing is re-drafted`);
    }
    for (const head of heads) {
      if (!(head.sourceIds ?? []).includes(event.sourceId)) continue;
      results.push(await this.startJob({ countryCode: head.countryCode, visaTypeId: head.visaTypeId, trigger: "guidance_changed" }));
    }
    return results;
  }

  /**
   * Start a drafting job (injectable for tests). The default resolves the job
   * module at CALL time: it imports this one, so a top-level import would make
   * a cycle (see the note in scrapers/index.ts).
   */
  private async startJob(input: StartJobInput): Promise<StartJobResult> {
    if (this.deps.startJob) return this.deps.startJob(input);
    const { rubricExtractionJobService } = await import("./rubric-extraction-job");
    return rubricExtractionJobService.startJob(input);
  }
}

/** Singleton over the real provider, bucket and Firestore. */
export const rubricExtractionService = new RubricExtractionService();
