/**
 * Checklist builder (issue #114): the PURE half. Decides, in code, which
 * documents a self-service applicant should expect to provide, and whose they
 * are. No Firebase, no model call, no clock, no randomness: the same inputs
 * always give the same list, ids included.
 *
 * WHERE ITEMS COME FROM (and nowhere else; nothing is ever hardcoded):
 *   1. The APPROVED rubric's `evidenceItems` (types/rubric.ts, issue #40).
 *      Each declares a document title, its holder (`applicant` | `sponsor`),
 *      the criteria it evidences, an optional intake condition (`when`) and
 *      the verbatim sentence of the published source that names it.
 *   2. The visa record's official "documents you must provide" list
 *      (`VisaType.requiredDocuments`, issue #129), each with its verbatim
 *      quote under `scrapeMeta.citations["requiredDocuments.<i>"]` and the
 *      page URL in `scrapeMeta.sourceUrl`. An entry with no quote is SKIPPED.
 *
 * Every item therefore carries a verbatim quote + source URL. An item that
 * cannot is dropped, never shown. The hand-seeded `requirements[].
 * requiredDocuments` (no quote, no URL) are deliberately NOT used.
 *
 * Generic by design: this file names no country, route, nationality or
 * document. A second rubric with different documents and holders produces its
 * own list with no code change.
 *
 * Wording: `reason` is a deterministic template. A model may reword it, but
 * only via `wordings` (per item, stored per rubric version, never per
 * applicant) and only if `isFaithfulWording` accepts it. The list itself never
 * depends on a wording.
 */
import type { EvidenceItem, IntakeCondition, VisaRubric } from "../../types/rubric";
import type { DocumentRequestCitation } from "../../types";
import {
  metaFromQuoteOnly,
  normaliseStoredMeta,
  type DocumentKind,
  type DocumentNeed,
  type RequiredDocumentMeta,
} from "../../scrapers/visa-catalog/required-document-meta";

// ============================================
// Types
// ============================================

/** One document on the checklist, before it is stored as a DocumentRequest. */
export interface ChecklistItem {
  /** Stable id: `ev-<evidence key>` (rubric) or `vr-<hash>` (visa record). */
  checklistItemId: string;
  title: string;
  holder: "applicant" | "sponsor";
  /** True only when the source says so. Rubric evidence is optional unless the
   *  rubric item carries `required: true`; the visa record's list is required. */
  required: boolean;
  /** Issue #187: "document" (uploaded) or "information" (typed in). Default document. */
  kind: DocumentKind;
  /** Issue #187: could not classify from the page's wording; stays "document". */
  kindReview?: true;
  /** Issue #187: verbatim page text behind `kind` (or the lead-in). */
  kindQuote?: string;
  /** Issue #187: required | conditional | optional. `required` above is true ONLY for "required". */
  need: DocumentNeed;
  /** Issue #187: verbatim "if ..." / "unless ..." / "depending on ..." clause or lead-in. */
  appliesWhen?: string;
  /** Always present: deterministic template, or an accepted model wording. */
  reason: string;
  /** Rubric criterion id (first one the item evidences), or undefined. */
  criterionRef?: string;
  citation: DocumentRequestCitation;
}

/** Why the builder returned no items (so the client can say the right thing). */
export type ChecklistState =
  | "ready" //          a list was built (it may still be short)
  | "intake_needed" //  the route asks questions and none are answered yet
  | "no_checklist"; //  no approved rubric evidence and no visa-record documents

export interface ChecklistResult {
  state: ChecklistState;
  /** One plain sentence, set whenever `items` is empty. */
  emptyReason?: string;
  /** Approved rubric version used, or null. */
  rubricVersion: number | null;
  items: ChecklistItem[];
}

/** The slice of the visa record the builder reads (#129 fields, all optional). */
export interface VisaRecordDocuments {
  requiredDocuments?: string[];
  scrapeMeta?: {
    sourceUrl?: string;
    citations?: Record<string, string>;
    /** Issue #187: kind + need per item, index-aligned with requiredDocuments. */
    requiredDocumentMeta?: RequiredDocumentMeta[];
  };
}

export interface BuildChecklistInput {
  /** The approved rubric (from `rubricStore.getApprovedRubric`) or null. */
  rubric: VisaRubric | null;
  /** The visa record, for its cited documents list (#129). */
  visaRecord?: VisaRecordDocuments | null;
  /**
   * The applicant's saved intake answers (#113 `Application.intake.answers`),
   * questionId -> answer; null when no intake was saved.
   */
  intakeAnswers: Record<string, unknown> | null;
  /** Optional model rewordings, itemId -> text, already stored per rubric version. */
  wordings?: Record<string, string>;
}

// ============================================
// Intake conditions
// ============================================

/**
 * Does the saved answer satisfy an item's `when` condition?
 * Conservative: an UNANSWERED question never triggers an item (so sponsor
 * items cannot appear before the applicant has said someone else pays).
 * Answer shapes follow #113: string | string[] (multi) | boolean | number.
 */
export function conditionHolds(cond: IntakeCondition, answers: Record<string, unknown>): boolean {
  const answer = answers[cond.questionId];
  if (answer === undefined || answer === null || answer === "") return false;
  // Multi-choice answers are arrays: "equals" means "includes".
  const values = Array.isArray(answer) ? answer : [answer];
  const wanted = Array.isArray(cond.value) ? cond.value : [cond.value];
  switch (cond.op) {
  case "eq":
    return values.some((v) => v === cond.value);
  case "neq":
    return values.every((v) => v !== cond.value);
  case "in":
    return values.some((v) => wanted.includes(v as never));
  default:
    // Unknown operator from a newer rubric: do not guess, do not show.
    return false;
  }
}

// ============================================
// Ids and wording
// ============================================

/** Small deterministic string hash (FNV-1a, 32 bit) as 8 hex chars. */
function stableHash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/** Lower-case, collapse whitespace: the key two spellings of one title share. */
function normaliseTitle(title: string): string {
  return title.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * The deterministic reason: names the criteria the document evidences (their
 * titles come from the rubric) and the publisher's own reference when there
 * is one. Adds no requirement, period or amount of its own.
 */
export function templateReason(criterionTitles: string[], ruleRef?: string): string {
  const what = criterionTitles.length ? criterionTitles.join("; ") : "this route's published requirements";
  return ruleRef ? `Evidence for: ${what} (${ruleRef}).` : `Evidence for: ${what}.`;
}

/** Numbers (with separators) appearing in a text, for the faithfulness check. */
function numberTokens(text: string): string[] {
  return (text.match(/\d[\d,.]*/g) ?? []).map((t) => t.replace(/[,.]+$/, ""));
}

/**
 * A model-worded reason is accepted only if it adds no number that is not in
 * the item's quote, title or the deterministic reason (so no period or amount
 * can be invented), and stays short. Anything else is rejected and the
 * template is used. This is a floor, not a proof: the template is the source
 * of truth and the citation is always shown beside the wording.
 */
export function isFaithfulWording(candidate: string, quote: string, title: string, template: string): boolean {
  const text = candidate.trim();
  if (!text || text.length > 400) return false;
  const allowed = new Set([...numberTokens(quote), ...numberTokens(title), ...numberTokens(template)]);
  return numberTokens(text).every((n) => allowed.has(n));
}

// ============================================
// The builder
// ============================================

/**
 * Build the checklist. Pure and deterministic (see file header).
 *
 * Order: rubric evidence items in rubric order, then visa-record documents in
 * page order, with visa-record entries whose title already appears among the
 * rubric items dropped (one document is never listed twice).
 */
export function buildChecklist(input: BuildChecklistInput): ChecklistResult {
  const { rubric, visaRecord, intakeAnswers, wordings } = input;
  const items: ChecklistItem[] = [];
  const seenIds = new Set<string>();
  const seenTitles = new Set<string>();

  // ---- 1. Rubric evidence ----
  if (rubric) {
    const criteriaById = new Map(rubric.criteria.map((c) => [c.criterionId, c]));
    // The route asks questions but none are answered: nothing conditional can
    // be decided yet, so say so rather than show a partial list.
    const needsIntake = (rubric.intakeQuestions?.length ?? 0) > 0 && (!intakeAnswers || Object.keys(intakeAnswers).length === 0);

    if (!needsIntake) {
      for (const ev of rubric.evidenceItems ?? []) {
        // Trigger: no `when` = always; otherwise the answer must match.
        if (ev.when && !conditionHolds(ev.when, intakeAnswers ?? {})) continue;
        // An item without a quote is never shown (domain rule).
        if (!ev.source?.quote?.trim() || !ev.source.url) continue;

        const id = `ev-${ev.key}`;
        if (seenIds.has(id)) continue;
        seenIds.add(id);

        const linked = ev.criterionIds.map((cid) => criteriaById.get(cid)).filter((c) => !!c);
        const ruleRef = linked.find((c) => c!.ruleRef)?.ruleRef;
        const template = templateReason(
          linked.map((c) => c!.title),
          ruleRef
        );
        const worded = wordings?.[id];
        const reason = worded && isFaithfulWording(worded, ev.source.quote, ev.title, template) ? worded.trim() : template;

        items.push({
          checklistItemId: id,
          title: ev.title,
          holder: ev.party,
          // `required` is not part of #40's EvidenceItem: read it if a rubric
          // carries it, otherwise the source has not said the document is required.
          required: (ev as EvidenceItem & { required?: boolean }).required === true,
          // Rubric evidence is always a document; not-required means optional
          // (what the old boolean said). Issue #187.
          kind: "document",
          need: (ev as EvidenceItem & { required?: boolean }).required === true ? "required" : "optional",
          reason,
          criterionRef: ev.criterionIds[0],
          citation: { quote: ev.source.quote, url: ev.source.url, ...(ruleRef ? { ruleRef } : {}) },
        });
        seenTitles.add(normaliseTitle(ev.title));
      }
    } else if (!(visaRecord?.requiredDocuments?.length)) {
      return {
        state: "intake_needed",
        emptyReason: "Answer the visit-details questions first and your list will appear here.",
        rubricVersion: rubric.version,
        items: [],
      };
    }
  }

  // ---- 2. Visa record: "documents you must provide" (#129), cited ----
  const docs = visaRecord?.requiredDocuments ?? [];
  docs.forEach((name, i) => {
    const quote = visaRecord?.scrapeMeta?.citations?.[`requiredDocuments.${i}`];
    const url = visaRecord?.scrapeMeta?.sourceUrl;
    // No quote or URL = not verified = not shown.
    if (!name?.trim() || !quote?.trim() || !url) return;
    if (seenTitles.has(normaliseTitle(name))) return;
    const id = `vr-${stableHash(normaliseTitle(name))}`;
    if (seenIds.has(id)) return;
    seenIds.add(id);
    seenTitles.add(normaliseTitle(name));
    // Issue #187: the stored classification for this index (quote-only
    // fallback for a visa crawled before it). `required` is true ONLY for need "required".
    const stored = visaRecord?.scrapeMeta?.requiredDocumentMeta?.[i];
    const meta = stored ? normaliseStoredMeta(stored, quote) : metaFromQuoteOnly(quote);
    items.push({
      checklistItemId: id,
      title: name.trim(),
      holder: "applicant",
      required: meta.need === "required",
      kind: meta.kind,
      ...(meta.kindReview ? { kindReview: true as const } : {}),
      ...(meta.kindQuote ? { kindQuote: meta.kindQuote } : {}),
      need: meta.need,
      ...(meta.appliesWhen ? { appliesWhen: meta.appliesWhen } : {}),
      reason: "Listed as a document you must provide on the official visa page.",
      citation: { quote, url },
    });
  });

  if (items.length === 0) {
    // Distinguish "answer questions first" from "nothing exists for this route".
    const hasEvidence = (rubric?.evidenceItems?.length ?? 0) > 0;
    return {
      state: hasEvidence ? "ready" : "no_checklist",
      emptyReason: hasEvidence
        ? "Nothing more is asked for based on your answers."
        : "There is no published document list for this visa yet.",
      rubricVersion: rubric?.version ?? null,
      items: [],
    };
  }
  return { state: "ready", rubricVersion: rubric?.version ?? null, items };
}
