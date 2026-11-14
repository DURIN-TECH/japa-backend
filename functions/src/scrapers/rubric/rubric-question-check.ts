import type { AssessmentCriterion, EvidenceItem, IntakeQuestion } from "../../types/rubric";
import type { LlmProvider, LlmRequest, LlmUsage } from "../../services/ai/llm-provider";
import { DATA_ONLY_RULE, wrapUntrusted } from "../../services/ai/prompt-safety";

// ============================================
// RUBRIC — AUTOMATIC CHECK OF AI-WRITTEN WORDING (issue #203)
// ============================================
//
// The questions put to applicants and the document items are written by the
// AI, not quoted. A person no longer reads them, so this module checks each
// one against the official sentence(s) of the rule(s) it is linked to:
//
//   question       asks_only_what_quote_requires | answer_type_fits | neutral_wording
//   document item  names_only_quoted_documents   | party_right
//
// each answered `yes | no | unsure` by a model that sees ONLY the item and the
// quoted sentence(s). Anything but `yes` fails the item (fail closed: doubt is
// not a pass). A failed item is removed, with its dependents, by the existing
// dependency logic; nothing is ever reworded and the linked rules stay.
//
// Safety of the call:
//  - the model gets batch-local ids ("i1", "i2", ...) that code maps back, so
//    an id written by the AI that wrote the question never reaches the model
//    as an identifier;
//  - the verdicts are CLOSED (three enum values per aspect), so no model text
//    becomes content anywhere;
//  - the answer is re-validated in code: every sent id exactly once, no extra
//    id, no extra key, only the three values. Anything else fails the whole
//    check (`output_invalid`): never "assume fine";
//  - the official text and the question wording are UNTRUSTED data: they go
//    through prompt-safety's wrapper, with the data-only rule in the system
//    prompt;
//  - spend is capped per draft in calls AND tokens, decided before the first
//    call where it can be, and recorded as the provider reported it.
//
// Batching is deterministic: items in rubric order, a batch closes at
// `batchSize` items or `batchChars` characters, whichever comes first.
//
// Generic: no country, nationality, route or publisher is named here.

/** Version of the prompts and schemas below. Recorded on every plan. */
// 2026-11-14.1 (#220): the official sentence may be in any language; the wording for applicants is English by design.
export const QUESTION_CHECK_PROMPT_VERSION = "question-check-2026-11-14.1";

/** The aspects checked for a question. */
export const QUESTION_ASPECTS = ["asks_only_what_quote_requires", "answer_type_fits", "neutral_wording"] as const;
/** The aspects checked for a document item. */
export const EVIDENCE_ASPECTS = ["names_only_quoted_documents", "party_right"] as const;

/** The verdict values. Only `yes` passes. */
const VERDICTS = ["yes", "no", "unsure"] as const;
type Verdict = (typeof VERDICTS)[number];

/** Limits of one check run (per draft). */
export interface QuestionCheckLimits {
  // Most items in one call.
  batchSize: number;
  // Most characters of item data in one call (prompt-safety caps one block at 20,000 after escaping).
  batchChars: number;
  // Most model calls one draft may make.
  maxCalls: number;
  // Most tokens (input plus output, as reported) one draft may spend.
  maxTotalTokens: number;
  // Generated-token ceiling per call.
  maxOutputTokensPerCall: number;
  // Wall clock per call.
  timeoutMs: number;
  // Calls in flight at once.
  concurrency: number;
}

/**
 * Defaults, sized from the request shape: a call carries about 700 tokens of
 * instructions plus about 250 tokens per item (wording, options, up to 3
 * quotes), and answers about 45 tokens per item.
 *  230 questions + 25 items: 14 calls, about 75,000 input and 12,000 output tokens.
 *  500 questions + 25 items: 27 calls, about 150,000 input and 24,000 output tokens.
 * `maxCalls` 60 and `maxTotalTokens` 600,000 are about twice the larger draft.
 */
export const DEFAULT_QUESTION_CHECK_LIMITS: Readonly<QuestionCheckLimits> = Object.freeze({
  batchSize: 20,
  batchChars: 12_000,
  maxCalls: 60,
  maxTotalTokens: 600_000,
  maxOutputTokensPerCall: 8_000,
  timeoutMs: 120_000,
  concurrency: 4,
});

/** Why a check run could not finish. Each maps to a held draft. */
export class QuestionCheckError extends Error {
  constructor(
    readonly code: "provider_error" | "output_invalid" | "capped" | "provider_refused" | "provider_stopped",
    message: string
  ) {
    super(message);
    this.name = "QuestionCheckError";
  }
}

// ============================================
// What the model is shown
// ============================================

/** At most this many quotes are shown for one question. */
export const MAX_QUOTES_PER_QUESTION = 3;
/** A quote or wording longer than this is cut (marked) in the payload. */
const MAX_FIELD_CHARS = 1_500;

const clip = (text: string): string => (text.length > MAX_FIELD_CHARS ? `${text.slice(0, MAX_FIELD_CHARS)} [shortened]` : text);

/** One item as the model sees it (ids are batch-local). */
interface PayloadItem {
  id: string;
  [k: string]: unknown;
}

/** An item to check, with the real id code maps the verdict back to. */
export interface CheckItem {
  kind: "question" | "evidence";
  // The question id or the evidence key.
  realId: string;
  payload: Omit<PayloadItem, "id">;
}

/** (#235) The data line that stands for "one option per member country of the route, listed when asked". */
export const DESTINATION_OPTIONS_LINE = "one option for each member country of the route, listed from membership data on the day the question is asked";

/**
 * The items to check, in rubric order: every question with the quotes of its
 * linked rules (at most 3, in rubric order), every document item with its own
 * quote. Questions linked to no rule in `criteria` are still checked (with no
 * quote they cannot pass, which is correct: nothing supports them).
 */
export function buildCheckItems(view: { criteria: AssessmentCriterion[]; intakeQuestions: IntakeQuestion[]; evidenceItems: EvidenceItem[] }): { questions: CheckItem[]; evidence: CheckItem[] } {
  const criteria = new Map(view.criteria.map((c) => [c.criterionId, c]));
  const order = new Map(view.criteria.map((c, i) => [c.criterionId, i]));
  const questions: CheckItem[] = view.intakeQuestions.map((q) => {
    const linked = [...new Set(q.criterionIds ?? [])]
      .map((id) => criteria.get(id))
      .filter((c): c is AssessmentCriterion => c !== undefined)
      .sort((a, b) => (order.get(a.criterionId) ?? 0) - (order.get(b.criterionId) ?? 0));
    return {
      kind: "question",
      realId: q.id,
      payload: {
        question: clip(q.label),
        ...(q.helpText ? { help: clip(q.helpText) } : {}),
        answer_type: q.answerType,
        // (#235) A destination question stores no country: the checker is told,
        // in one fixed line of data, that one option per member country is listed
        // when it is asked (so the answer type is judged on what the applicant
        // will see). Only such questions carry the line; every other request
        // is byte-for-byte as before.
        ...(q.optionsFrom === "route_destinations"
          ? { options: [DESTINATION_OPTIONS_LINE, ...(q.options ?? []).map((o) => clip(o.label))] }
          : q.options && q.options.length > 0 ? { options: q.options.map((o) => clip(o.label)) } : {}),
        ...(q.party ? { about_party: q.party } : {}),
        quotes: linked.slice(0, MAX_QUOTES_PER_QUESTION).map((c) => clip(c.source?.quote ?? "")),
      },
    };
  });
  const evidence: CheckItem[] = view.evidenceItems.map((e) => ({
    kind: "evidence",
    realId: e.key,
    payload: {
      document: clip(e.title),
      ...(e.expects?.documentType ? { document_type: clip(e.expects.documentType) } : {}),
      whose_document: e.party,
      quote: clip(e.source?.quote ?? ""),
    },
  }));
  return { questions, evidence };
}

/** Deterministic batches: in order, closing at the item count or the character budget. */
export function batchItems(items: readonly CheckItem[], limits: Pick<QuestionCheckLimits, "batchSize" | "batchChars">): CheckItem[][] {
  const batches: CheckItem[][] = [];
  let current: CheckItem[] = [];
  let chars = 0;
  for (const item of items) {
    const size = JSON.stringify(item.payload).length;
    if (current.length > 0 && (current.length >= limits.batchSize || chars + size > limits.batchChars)) {
      batches.push(current);
      current = [];
      chars = 0;
    }
    current.push(item);
    chars += size;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

// ============================================
// Prompts and schemas (flat and small: no unions, no optional fields)
// ============================================

const SHARED_RULES =
  "You check wording that an AI wrote for applicants against the official sentence it was written for. " +
  "You do not judge whether the official rule is right or fair, and you never rewrite anything. " +
  "Answer for each item with `yes`, `no` or `unsure` for every aspect, keyed by the item's id. " +
  "Use `unsure` whenever the quoted sentence does not give you enough to judge: doubt is not a yes. " +
  "The quoted official sentences may be written in any language; the wording written for applicants is in English by design, which is never a fault. Judge across the two languages (a question may ask only for what a quoted sentence requires, in whichever language the sentence is written), and answer `unsure` for an item whose sentence you cannot read well enough. " +
  `${DATA_ONLY_RULE}`;

/** System prompt for questions. */
export const QUESTION_SYSTEM_PROMPT =
  `${SHARED_RULES}\n\n` +
  "Each item is a question put to an applicant, with the official sentence(s) of the rule(s) it serves. Judge three aspects.\n" +
  "- asks_only_what_quote_requires: `yes` only if the question asks for nothing beyond what the quoted sentence(s) require the applicant to state or show, and what it asks is something at least one quoted sentence needs.\n" +
  "- answer_type_fits: `yes` only if the answer type and the options (if any) let an applicant give every distinction the quoted sentence(s) draw, including a way to say that none applies where the sentence distinguishes that case; options must not leave out a case the sentence names.\n" +
  "- neutral_wording: `yes` only if the wording states no outcome, predicts nothing about the applicant's chances, and does not lead the applicant towards a particular answer.";

/** System prompt for document items. */
export const EVIDENCE_SYSTEM_PROMPT =
  `${SHARED_RULES}\n\n` +
  "Each item is a document an applicant is asked to provide, with the official sentence that names it. Judge two aspects.\n" +
  "- names_only_quoted_documents: `yes` only if every document the item names or expects is one the quoted sentence actually asks for, and the item asks for nothing the sentence does not.\n" +
  "- party_right: `yes` only if the person the document is asked of (the `whose_document` field) is the person the quoted sentence requires it from.";

/** The closed answer for a set of aspects: one verdict object per sent id. */
function schemaFor(aspects: readonly string[]): Record<string, unknown> {
  const properties: Record<string, unknown> = { id: { type: "string" } };
  for (const a of aspects) properties[a] = { type: "string", enum: [...VERDICTS] };
  return {
    type: "object",
    additionalProperties: false,
    required: ["verdicts"],
    properties: {
      verdicts: {
        type: "array",
        items: { type: "object", additionalProperties: false, required: ["id", ...aspects], properties },
      },
    },
  };
}

export const QUESTION_SCHEMA = schemaFor(QUESTION_ASPECTS);
export const EVIDENCE_SCHEMA = schemaFor(EVIDENCE_ASPECTS);

/** The user message for one batch: the items inside one untrusted block. */
function userMessage(batch: readonly CheckItem[]): string {
  const items: PayloadItem[] = batch.map((it, i) => ({ id: `i${i + 1}`, ...it.payload }));
  return [
    "Check each item below. Return one verdict object per item, using the item's id exactly.",
    wrapUntrusted(JSON.stringify(items), "rubric_items"),
  ].join("\n\n");
}

/** The provider request for one batch. */
export function buildCheckRequest(kind: "question" | "evidence", batch: readonly CheckItem[], limits: Pick<QuestionCheckLimits, "maxOutputTokensPerCall" | "timeoutMs">): LlmRequest {
  return {
    // A different model tier from the extractor ("judgement"), so the check is independent of what wrote the wording.
    role: "drafting",
    system: kind === "question" ? QUESTION_SYSTEM_PROMPT : EVIDENCE_SYSTEM_PROMPT,
    user: userMessage(batch),
    schema: kind === "question" ? QUESTION_SCHEMA : EVIDENCE_SCHEMA,
    maxOutputTokens: limits.maxOutputTokensPerCall,
    timeoutMs: limits.timeoutMs,
    effort: "low",
  };
}

// ============================================
// Parsing (closed verdicts, validated in code)
// ============================================

/**
 * Parse and validate one answer. Returns the failed aspects per real id (an
 * empty list = every aspect `yes`).
 * @throws QuestionCheckError("output_invalid") for anything but exactly one
 *   verdict object per sent id, with exactly the expected keys and values.
 */
export function parseVerdicts(text: string, kind: "question" | "evidence", batch: readonly CheckItem[]): Map<string, string[]> {
  const aspects: readonly string[] = kind === "question" ? QUESTION_ASPECTS : EVIDENCE_ASPECTS;
  const bad = (why: string): never => {
    throw new QuestionCheckError("output_invalid", `the check answer was not usable: ${why}`);
  };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return bad("not JSON");
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return bad("not an object");
  const keys = Object.keys(raw);
  if (keys.length !== 1 || keys[0] !== "verdicts" || !Array.isArray((raw as { verdicts: unknown }).verdicts)) return bad("expected only a verdicts list");
  const list = (raw as { verdicts: unknown[] }).verdicts;
  const sent = new Map(batch.map((it, i) => [`i${i + 1}`, it.realId]));
  if (list.length !== sent.size) return bad("wrong number of verdicts");
  const out = new Map<string, string[]>();
  const expectedKeys = ["id", ...aspects].sort().join(",");
  for (const v of list) {
    if (!v || typeof v !== "object" || Array.isArray(v)) return bad("a verdict is not an object");
    const rec = v as Record<string, unknown>;
    if (Object.keys(rec).sort().join(",") !== expectedKeys) return bad("a verdict has the wrong keys");
    const real = typeof rec.id === "string" ? sent.get(rec.id) : undefined;
    if (real === undefined) return bad("an id that was not sent");
    if (out.has(real)) return bad("an id answered twice");
    const failed: string[] = [];
    for (const a of aspects) {
      const value = rec[a];
      if (!(VERDICTS as readonly unknown[]).includes(value)) return bad("a verdict value outside yes / no / unsure");
      if ((value as Verdict) !== "yes") failed.push(a);
    }
    out.set(real, failed);
  }
  return out;
}

// ============================================
// Running the check
// ============================================

/** What the check found and spent. */
export interface QuestionCheckResult {
  // Failed aspects per real question id (only ids that failed at least one).
  failedQuestions: Map<string, string[]>;
  failedEvidence: Map<string, string[]>;
  questionsChecked: number;
  evidenceItemsChecked: number;
  calls: number;
  usage: { inputTokens: number; outputTokens: number };
  model: string;
}

/** Rough tokens of a text (characters / 3 is deliberately pessimistic for JSON). */
const estimateTokens = (chars: number): number => Math.ceil(chars / 3);

/**
 * Check every question and document item of a view.
 *
 * The cap is checked BEFORE the first call (the number of calls is known, and
 * the tokens are estimated) and again after every call against what the
 * provider reported. A draft that would pass a cap is refused (`capped`), never
 * partly checked: a partly checked set could not honestly be called checked.
 *
 * @throws QuestionCheckError for a provider failure, an unusable answer or a cap
 */
export async function runQuestionCheck(
  view: { criteria: AssessmentCriterion[]; intakeQuestions: IntakeQuestion[]; evidenceItems: EvidenceItem[] },
  provider: LlmProvider,
  limits: QuestionCheckLimits = DEFAULT_QUESTION_CHECK_LIMITS
): Promise<QuestionCheckResult> {
  const { questions, evidence } = buildCheckItems(view);
  const jobs: { kind: "question" | "evidence"; batch: CheckItem[] }[] = [
    ...batchItems(questions, limits).map((batch) => ({ kind: "question" as const, batch })),
    ...batchItems(evidence, limits).map((batch) => ({ kind: "evidence" as const, batch })),
  ];
  const model = provider.modelFor("drafting");
  if (jobs.length > limits.maxCalls) throw new QuestionCheckError("capped", `the check needs ${jobs.length} calls; the cap is ${limits.maxCalls}`);
  // Estimate before spending: instructions + item data in, a verdict per item out.
  const requests = jobs.map((j) => buildCheckRequest(j.kind, j.batch, limits));
  const estimate = requests.reduce((n, r, i) => n + estimateTokens(r.system.length + r.user.length) + jobs[i].batch.length * 60, 0);
  if (estimate > limits.maxTotalTokens) throw new QuestionCheckError("capped", `the check is estimated at ${estimate} tokens; the cap is ${limits.maxTotalTokens}`);

  const failedQuestions = new Map<string, string[]>();
  const failedEvidence = new Map<string, string[]>();
  const usage: LlmUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  let calls = 0;
  let next = 0;
  let stop: QuestionCheckError | null = null;

  // A small worker pool; results are keyed by item, so completion order cannot change them.
  const worker = async (): Promise<void> => {
    while (stop === null) {
      const i = next++;
      if (i >= jobs.length) return;
      // The running total, from what the provider reported.
      if (usage.inputTokens + usage.outputTokens > limits.maxTotalTokens) {
        stop = new QuestionCheckError("capped", "the token cap was passed");
        return;
      }
      calls++;
      let text: string;
      try {
        const res = await provider.complete(requests[i]);
        usage.inputTokens += res.usage.inputTokens;
        usage.outputTokens += res.usage.outputTokens;
        if (res.stopReason === "refusal") throw new QuestionCheckError("provider_refused", "the model declined the request");
        if (res.stopReason !== "end_turn") throw new QuestionCheckError("provider_stopped", `the model stopped with reason ${String(res.stopReason)}`);
        text = res.text;
        const verdicts = parseVerdicts(text, jobs[i].kind, jobs[i].batch);
        const sink = jobs[i].kind === "question" ? failedQuestions : failedEvidence;
        for (const [id, failed] of verdicts) if (failed.length > 0) sink.set(id, failed);
      } catch (err) {
        // The class only: never a prompt, an answer or a provider object.
        stop = err instanceof QuestionCheckError ? err : new QuestionCheckError("provider_error", "the provider call failed");
        return;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limits.concurrency, jobs.length) }, () => worker()));
  if (stop !== null) throw stop;
  if (usage.inputTokens + usage.outputTokens > limits.maxTotalTokens) throw new QuestionCheckError("capped", "the token cap was passed");
  return {
    failedQuestions,
    failedEvidence,
    questionsChecked: questions.length,
    evidenceItemsChecked: evidence.length,
    calls,
    usage: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens },
    model,
  };
}
