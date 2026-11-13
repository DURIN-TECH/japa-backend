import {
  classifyNeed,
  extractConditionalClause,
  type RequiredDocumentMeta,
} from "./required-document-meta";
import type {
  ExtractedFeeComponent,
  ExtractedVisa,
  FeeComponentKind,
  FeeComponentPer,
} from "./types";
import { VisaCategory } from "../../types";
// Static ISO 4217 allow-list (no network) for fee component currencies.
import { isIso4217 } from "./visa-catalog-fx";
// Registry official-host matching for `applicationUrl` (issue #74).
import { officialHttpsUrl } from "./visa-catalog-official-hosts";
// Processing range vs the durations its citations state (issue #87).
// Also the shared processing citation-key prefixes used by #86's uncited rule.
import {
  checkProcessingRangeCitations,
  PROCESSING_CITATION_PREFIXES,
  PROCESSING_UNVERIFIED_CONFIDENCE_CAP,
} from "./visa-catalog-processing-check";
// Token usage from the API response (issue #82): parsed, never estimated.
import { parseDeepSeekUsage } from "../shared/cost/scrape-cost-pricing";
import type { LlmUsageReport } from "../shared/cost/types";

// ============================================
// VISA CATALOG — EXTRACT SERVICE (Step 3)
// ============================================
//
// Turns a cleaned visa page (from the fetch service) into a structured
// `ExtractedVisa` using an LLM. The model sits behind the `LlmExtractor`
// interface so the provider is swappable; the default implementation is
// DeepSeek Flash (`DEEPSEEK_EXTRACTOR_MODEL`, OpenAI-compatible API, JSON
// output mode, thinking disabled) — the cost-optimal choice for per-page
// schema extraction.
//
// Everything the model returns is run through a dependency-free validator before
// it leaves this module, so an invalid/hallucinated shape can never reach the
// staging step. (We validate by hand rather than pull in zod — one fixed schema.)

// The allowed visa categories, mirrored from the VisaCategory union so we can
// both constrain the prompt and validate the response.
const VISA_CATEGORIES: VisaCategory[] = [
  "work",
  "student",
  "tourist",
  "business",
  "family",
  "investor",
  "transit",
  "other",
];

/**
 * Version of the prompt + output schema below. Written to every scraped doc as
 * `scrapeMeta.extractorPromptVersion` (one constant, so it can't drift). Bump
 * it whenever the prompt rules or the schema change. History:
 *  - v1 (implicit, pre-#59): the LLM returned `baseCostUsd` it converted itself.
 *  - "2026-11-fee-components-v2" (#59): fee returned as published components;
 *    code does the arithmetic and the FX conversion.
 *  - "2026-11-fee-length-v3" (#59): deterministic visa-length selection (the
 *    LONGEST standard outside-country option; surcharges use the same years)
 *    and `fee.years` must quote a duration, not the fee line.
 *  - "2026-11-surcharge-total-v4" (#73): a surcharge the page prints as ONE
 *    amount for a stated stay length ("£3,105 if you're staying for 2 years
 *    and 9 months", UK Family IHS) is a total -> per:"application"; per-year x
 *    years only when the page states a per-year rate, which wins when the page
 *    also lists totals by length (Graduate) (the v3 model returned
 *    3105 per year x 3, tripling the Family fee). Also: processing time is the
 *    FULL standard range (min/max = shorter/longer of the outside- and
 *    inside-country standard decision times).
 *  - "2026-11-processing-cited-v5" (#87): each end of the processing range is
 *    tied to its quote. citations["processingDaysMin"] / ["processingDaysMax"]
 *    must each quote the sentence stating THAT figure, and
 *    citations["processingTime"] must state every duration in the range (a
 *    v4 Standard Visitor crawl stored max 56, from "extend your stay ...
 *    within 8 weeks", with only "within 3 weeks" cited). The value rule is
 *    unchanged (full range, user decision on #60); the validator now flags a
 *    range that disagrees with its citations (visa-catalog-processing-check).
 *  - "2026-11-required-documents-v6" (#129): new `requiredDocuments` array
 *    (the page's own "documents you must provide" list, in page order), each
 *    item backed by a verbatim quote in citations["requiredDocuments.<index>"].
 *    The validator drops any item without a matching quote on the page.
 *  - "2026-11-item-kinds-v7" (#187): each `requiredDocuments` item is also
 *    classified, from the page's own wording, as `kind` "document" (uploaded)
 *    or "information" (typed in) with a verbatim `kindQuote`, and `need`
 *    "required" | "conditional" | "optional" with a verbatim `appliesWhen` for
 *    conditional items ("if ...", "unless ...", "depending on ...", or the
 *    "Depending on your circumstances, you might also need to provide:"
 *    lead-in). "may" never counts. The validator drops a kind whose quote is not
 *    on the page (-> document + kindReview) and decides `need` in code.
 * Before merging a bump (or a model change), run `npm run eval:visa-extract`
 * and attach the result — see functions/src/scrapers/visa-catalog/eval/README.md.
 */
export const EXTRACTOR_PROMPT_VERSION = "2026-11-item-kinds-v7";

// A duration phrase: a number (digits or a word) followed by year(s)/month(s),
// e.g. "up to 5 years", "2 years and 9 months", "five years", "12-month".
const DURATION_RE =
  /\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)[\s-]*(years?|months?)\b/i;

// Upper bound for `years` on a per-year component (no standard visa length
// is longer; a bigger value is a mis-read). The amount plausibility cap is
// applied in USD by computeFee (MAX_FEE_COMPONENT_USD), because a cap in the
// source currency would reject legitimate IDR / VND / COP fees.
export const MAX_FEE_YEARS = 10;

// Allowed fee component enums (mirrored from the types for validation).
const FEE_KINDS: FeeComponentKind[] = ["application", "surcharge"];
const FEE_PERS: FeeComponentPer[] = ["application", "year"];

/**
 * Citation key for the n-th (1-based) fee component of a kind:
 * "fee.application" / "fee.surcharge" for the first, then "fee.surcharge.2", ...
 * (There is at most one application component, so it never gets a suffix.)
 */
export function feeCitationKey(kind: FeeComponentKind, ordinal: number): string {
  return ordinal <= 1 ? `fee.${kind}` : `fee.${kind}.${ordinal}`;
}

/** Citation key supporting `years` of the n-th (1-based) per-year component:
 *  "fee.years", then "fee.years.2", ... */
export function feeYearsCitationKey(ordinal: number): string {
  return ordinal <= 1 ? "fee.years" : `fee.years.${ordinal}`;
}

// ----- Uncited numeric fields (issue #86) -----
//
// The rule: a NUMBER the extractor returns is only kept when the page backs it
// with a citation. The prompt (owned by #87) still tells the model to use "a
// sensible empty/zero default" for a missing value, so a page that says
// nothing about processing time came back as processingDaysMin/Max = 0 with no
// quote (the HiKorea C-3 page, #86) and that 0 was stored as if the page said
// "0 days". The validator now catches this for EVERY country, without relying
// on the prompt:
//   - processingDaysMin / processingDaysMax: kept only when a processing
//     citation exists (see PROCESSING_CITATION_PREFIXES) AND both values are
//     present AND the longer one is above 0 (a decision cannot take 0 days;
//     0 is the prompt's "not found" default). Otherwise BOTH are omitted and
//     the extraction is flagged `processingUnknown: true`.
//   - maxExtensions: kept only with a "maxExtensions" citation.
//   - a fee component of amount 0: kept only with its fee citation (a free
//     visa must be stated); see validateFeeComponents.
// Omitted fields are listed in `uncitedFieldsDropped` (audit trail on
// scrapeMeta), so a reviewer sees what the model returned and why it is gone.

// The citation keys that support the processing-time numbers are #87's shared
// PROCESSING_CITATION_PREFIXES (visa-catalog-processing-check.ts), imported
// above, so the uncited rule and the range check read the same keys.

// ----- Required documents (issue #129) -----
//
// The domain rule: a document is only shown as a requirement when the page
// itself lists it. So the model returns the page's own wording per item plus a
// verbatim quote, and the VALIDATOR (not the prompt) enforces it: an item with
// no quote, a quote that is not on the page, or a quote that does not contain
// the item is dropped and recorded. Code never adds a document of its own.

/** Citation key for the item at `index` (0-based) of `requiredDocuments`. */
export function requiredDocumentCitationKey(index: number): string {
  return `requiredDocuments.${index}`;
}

/**
 * Normalise text for the "is this quote on the page" test: unify curly
 * quotes/dashes, collapse whitespace, lower-case. Matching is otherwise exact,
 * so a paraphrase never passes.
 */
function normForQuote(s: string): string {
  return s
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, "\"")
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * Validate `requiredDocuments` (pushes shape problems onto `errors`).
 * Returns the kept items (page order, de-duplicated, re-indexed), the quotes
 * under their NEW indices, and the raw items that were dropped.
 *  - absent / null = the page lists none: [] and valid (not an error);
 *  - present but not an array of non-empty strings: a hard error, like a
 *    malformed eligibilityCriteria;
 *  - kept only with a non-empty quote under the item's ORIGINAL index that
 *    (a) appears on the page when `pageText` is given and (b) contains the
 *    item's text (so the item is the page's wording, not a paraphrase);
 *  - duplicates (trim + whitespace + case-insensitive) collapse to the first
 *    cited occurrence and are not "dropped" (nothing was lost).
 */
function validateRequiredDocuments(
  raw: unknown,
  citations: Record<string, string>,
  pageText: string | undefined,
  errors: string[],
  rawMeta?: unknown
): { items: string[]; quotes: Record<string, string>; dropped: string[]; meta: RequiredDocumentMeta[] } {
  const none = {
    items: [] as string[],
    quotes: {} as Record<string, string>,
    dropped: [] as string[],
    meta: [] as RequiredDocumentMeta[],
  };
  if (raw === undefined || raw === null) return none;
  if (!Array.isArray(raw) || raw.some((x) => typeof x !== "string" || x.trim().length === 0)) {
    errors.push("\"requiredDocuments\" must be an array of non-empty strings (empty when the page lists none)");
    return none;
  }
  const page = pageText === undefined ? undefined : normForQuote(pageText);
  const items: string[] = [];
  const quotes: Record<string, string> = {};
  const dropped: string[] = [];
  const meta: RequiredDocumentMeta[] = [];
  const seen = new Set<string>();
  // The model's per-item classification, index-aligned with ITS array (issue #187).
  const metaList: unknown[] = Array.isArray(rawMeta) ? rawMeta : [];
  (raw as string[]).forEach((rawItem, i) => {
    const item = rawItem.trim();
    const quote = citations[requiredDocumentCitationKey(i)];
    const q = typeof quote === "string" ? normForQuote(quote) : "";
    const cited =
      q.length > 0 && (page === undefined || page.includes(q)) && q.includes(normForQuote(item));
    if (!cited) {
      dropped.push(item);
      return;
    }
    const key = normForQuote(item);
    if (seen.has(key)) return; // repeat of a kept document: collapse silently
    seen.add(key);
    quotes[requiredDocumentCitationKey(items.length)] = (quote as string).trim();
    meta.push(validateItemMeta(metaList[i], (quote as string).trim(), page));
    items.push(item);
  });
  return { items, quotes, dropped, meta };
}

/**
 * Validate ONE item's classification (issue #187). Never throws and never
 * drops the item: a classification that cannot be verified degrades to the
 * safe default instead.
 *  - `kind` "information" is kept only with a `kindQuote` that appears on the
 *    page (normalised, exact otherwise). A "document" kind needs one too; with
 *    no verifiable quote the item is "document" + `kindReview: true`
 *    ("could not classify"), the model's claim is discarded.
 *  - `need` is decided by code from the item's own quote and the lead-in quote
 *    (classifyNeed). The model's `appliesWhen` is used only when it is a verbatim
 *    slice of the page, carries an "if / unless / depending on" cue and sits
 *    inside the item's quote or the kind quote (so it is the item's own clause);
 *    otherwise the clause is cut from the quote by code. The model's `need` is
 *    ignored: a quote with "if" is conditional whatever the model said.
 */
function validateItemMeta(rawItemMeta: unknown, itemQuote: string, page: string | undefined): RequiredDocumentMeta {
  const m = rawItemMeta && typeof rawItemMeta === "object" ? (rawItemMeta as Record<string, unknown>) : {};
  const onPage = (q: string) => q.length > 0 && (page === undefined || page.includes(normForQuote(q)));

  // ---- kind + its quote ----
  const claimedKind = m.kind === "information" ? "information" : "document";
  const kindQuote = typeof m.kindQuote === "string" ? m.kindQuote.trim() : "";
  const kindVerified = m.kind !== undefined && (m.kind === "document" || m.kind === "information") && onPage(kindQuote);
  const out: RequiredDocumentMeta = kindVerified
    ? { kind: claimedKind, kindQuote, need: "required" }
    : { kind: "document", kindReview: true, need: "required" };

  // ---- need (+ appliesWhen) ----
  const decided = classifyNeed(itemQuote, out.kindQuote);
  out.need = decided.need;
  if (decided.need === "conditional" && decided.appliesWhen) {
    let when = decided.appliesWhen;
    const claimed = typeof m.appliesWhen === "string" ? m.appliesWhen.trim() : "";
    const hay = normForQuote(`${itemQuote} ${out.kindQuote ?? ""}`);
    if (
      claimed &&
      extractConditionalClause(claimed) !== null &&
      onPage(claimed) &&
      hay.includes(normForQuote(claimed))
    ) {
      when = claimed;
    }
    out.appliesWhen = when;
  }
  return out;
}

/** Citation key prefix that supports `maxExtensions`. */
export const MAX_EXTENSIONS_CITATION_PREFIX = "maxExtensions";

/**
 * Display text written to `processingTime` when the processing time is unknown
 * AND the model's own processing string had no citation either (issue #86).
 * Readers that only show the string (mobile Explorer `processing`, the portal
 * review slide-over) then say "not stated" instead of showing an invented
 * "0 days" or a blank. It is a label, never a number: processingDaysMin/Max
 * stay ABSENT, so no stat or sort treats it as a duration.
 */
export const PROCESSING_TIME_UNKNOWN_LABEL = "Not stated on the official page";

/**
 * True when `citations` has a non-empty quote under any key that equals or
 * starts with one of `prefixes`.
 */
export function hasCitationWithPrefix(
  citations: Record<string, string>,
  prefixes: readonly string[]
): boolean {
  return Object.entries(citations).some(
    ([k, v]) => typeof v === "string" && v.trim().length > 0 && prefixes.some((p) => k.startsWith(p))
  );
}

// Context passed alongside the page text to ground the extraction.
export interface ExtractContext {
  url: string;
  countryName: string;
  routeName: string; // the label from the source registry, e.g. "Skilled Worker visa"
  // The country's registry `officialHosts` patterns (issue #74). When given
  // (non-empty), `applicationUrl` is kept only on these hosts; absent/empty →
  // only the http(s) check (countries without a registered host list).
  officialHosts?: readonly string[];
  // Issue #82: called once per API call that returned a response with a
  // `usage` object — BEFORE the output is parsed / validated, so a call whose
  // output is then rejected is still reported (it was billed). Callers price
  // it (scrape-cost-pricing.priceUsageReport) and put it on the run record,
  // the page line and scrapeMeta. A throwing callback is ignored (cost
  // tracking must never fail an extraction). Optional: stubs may ignore it.
  onUsage?: (report: LlmUsageReport) => void;
}

// The provider-agnostic contract. Any model backend implements this.
export interface LlmExtractor {
  readonly model: string;
  extract(cleanText: string, context: ExtractContext): Promise<ExtractedVisa>;
}

// ----- Validation (dependency-free) -----

/** Options for `validateExtractedVisa`. */
export interface ValidateOptions {
  // Registry official host patterns (see visa-catalog-official-hosts.ts).
  officialHosts?: readonly string[];
  // The page text the model saw (issue #129). When given, a required-document
  // quote must appear in it word for word; without it (stubs, eval replays)
  // only the quote's presence and its containing the item are checked.
  pageText?: string;
}

/**
 * Keep `applicationUrl` only when it is safe to show users (issue #74):
 *  - with an official host list: an https URL whose host matches it (exact, or
 *    a strict subdomain of a `*.` pattern on a label boundary — so
 *    "evilservice.gov.uk.attacker.com" and "www.gov.uk@evil.com" are dropped);
 *  - without one (country not registered yet): any parseable http(s) URL, as
 *    before; other schemes (javascript:, data:) are dropped.
 * A dropped URL is a SOFT failure (field omitted, rest of the extraction kept):
 * a bad link must not throw away a whole visa.
 */
export function sanitizeApplicationUrl(
  raw: unknown,
  officialHosts: readonly string[] | undefined
): string | undefined {
  if (typeof raw !== "string" || !raw.trim()) return undefined;
  const value = raw.trim();
  if (officialHosts && officialHosts.length > 0) {
    // Store the NORMALISED URL (`URL.toString()`: lower-cased host, resolved
    // dot segments, encoded characters), not the model's raw string, so what
    // is saved is exactly what was checked.
    return officialHttpsUrl(value, officialHosts)?.toString();
  }
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.toString() : undefined;
  } catch {
    return undefined;
  }
}

/** Narrow unknown → ExtractedVisa, or throw with the first problem found. */
export function validateExtractedVisa(raw: unknown, options: ValidateOptions = {}): ExtractedVisa {
  const errors: string[] = [];
  const o = (raw ?? {}) as Record<string, unknown>;

  const str = (k: string, required = true) => {
    const v = o[k];
    if (typeof v === "string" && v.trim().length > 0) return v.trim();
    if (required) errors.push(`"${k}" must be a non-empty string`);
    return "";
  };
  // Optional number (issue #86): absent / null / "" -> undefined (the page
  // did not state it, which is allowed); a finite number or numeric string ->
  // the number; anything else (e.g. "three weeks") is still a hard error.
  const optNum = (k: string): number | undefined => {
    const raw = o[k];
    if (raw === undefined || raw === null || (typeof raw === "string" && raw.trim() === "")) return undefined;
    const v = typeof raw === "string" ? Number(raw) : raw;
    if (typeof v === "number" && Number.isFinite(v)) return v;
    errors.push(`"${k}" must be a number`);
    return undefined;
  };
  const bool = (k: string) => {
    if (typeof o[k] === "boolean") return o[k] as boolean;
    errors.push(`"${k}" must be a boolean`);
    return false;
  };

  const name = str("name");
  const code = str("code");
  const description = str("description");
  const category = str("category") as VisaCategory;
  if (category && !VISA_CATEGORIES.includes(category)) {
    errors.push(`"category" must be one of ${VISA_CATEGORIES.join(", ")}`);
  }
  let processingTime = str("processingTime", false);
  const rawProcessingDaysMin = optNum("processingDaysMin");
  const rawProcessingDaysMax = optNum("processingDaysMax");
  const validityPeriod = str("validityPeriod", false);
  const isExtendable = bool("isExtendable");

  // eligibilityCriteria: array of non-empty strings.
  const eligibility = Array.isArray(o.eligibilityCriteria)
    ? (o.eligibilityCriteria as unknown[]).filter(
      (x): x is string => typeof x === "string" && x.trim().length > 0
    )
    : [];
  if (eligibility.length === 0) errors.push("\"eligibilityCriteria\" must be a non-empty string array");

  // requiredDocuments (issue #129): optional; validated further once the
  // citations are parsed below (it needs them).
  // confidence: 0–1.
  const confidence = typeof o.confidence === "number" ? o.confidence : NaN;
  if (!(confidence >= 0 && confidence <= 1)) errors.push("\"confidence\" must be a number in [0,1]");

  // citations: field -> quote map (optional-ish but expected).
  const citations: Record<string, string> = {};
  if (o.citations && typeof o.citations === "object") {
    for (const [k, v] of Object.entries(o.citations as Record<string, unknown>)) {
      if (typeof v === "string") citations[k] = v;
    }
  }

  // ---- Fee components (issue #59): as published, validated per component ----
  const { components: feeComponents, unverifiedReasons } = validateFeeComponents(
    o.feeComponents,
    citations,
    errors
  );

  // ---- Required documents (issue #129): cited verbatim or dropped ----
  const docs = validateRequiredDocuments(
    o.requiredDocuments,
    citations,
    options.pageText,
    errors,
    o.requiredDocumentMeta
  );
  // Re-key the document citations to the KEPT items' indices: strip the
  // model's (raw-index) keys, then add the remapped ones, so a dropped or
  // collapsed item never leaves a quote pointing at the wrong document.
  for (const k of Object.keys(citations)) if (k.startsWith("requiredDocuments.")) delete citations[k];
  Object.assign(citations, docs.quotes);

  // ---- Uncited numeric fields (issue #86, see the module note above) ----
  // Fields the model returned but the page does not back; listed on the
  // result (and scrapeMeta) so the omission is never silent.
  const uncitedFieldsDropped: string[] = [];

  // Processing time: both numbers or neither.
  const processingCited = hasCitationWithPrefix(citations, PROCESSING_CITATION_PREFIXES);
  const processingKnown =
    processingCited &&
    rawProcessingDaysMin !== undefined &&
    rawProcessingDaysMax !== undefined &&
    // A 0-day upper bound is the prompt's "zero default", not a real
    // decision time — even when some processing quote exists.
    rawProcessingDaysMax > 0;
  let processingDaysMin: number | undefined;
  let processingDaysMax: number | undefined;
  if (processingKnown) {
    processingDaysMin = rawProcessingDaysMin;
    processingDaysMax = rawProcessingDaysMax;
  } else {
    // Record which of the two the model DID return (absent ones were never
    // there to drop).
    if (rawProcessingDaysMin !== undefined) uncitedFieldsDropped.push("processingDaysMin");
    if (rawProcessingDaysMax !== undefined) uncitedFieldsDropped.push("processingDaysMax");
    // Display-only default for the string (see PROCESSING_TIME_UNKNOWN_LABEL):
    // only when nothing on the page backs the model's processing string
    // either. A cited string ("varies by embassy") is kept as the page says.
    if (!processingCited) processingTime = PROCESSING_TIME_UNKNOWN_LABEL;
  }

  // maxExtensions: an optional count, kept only with its own citation.
  let maxExtensions: number | undefined;
  const rawMaxExtensions = optNum("maxExtensions");
  if (rawMaxExtensions !== undefined) {
    if (hasCitationWithPrefix(citations, [MAX_EXTENSIONS_CITATION_PREFIX])) maxExtensions = rawMaxExtensions;
    else uncitedFieldsDropped.push("maxExtensions");
  }

  // ---- Range / sanity checks (defence against nonsense values) ----
  // Only for values that survived the citation rule above.
  if (processingDaysMin !== undefined && processingDaysMax !== undefined) {
    if (processingDaysMin < 0 || processingDaysMax < 0)
      errors.push("processing days must be non-negative");
    if (processingDaysMin > processingDaysMax)
      errors.push("processingDaysMin must be <= processingDaysMax");
  }

  if (errors.length > 0) {
    throw new ExtractionValidationError(errors);
  }
  // Official-host check (issue #74): off-registry / unsafe URLs are dropped.
  const applicationUrl = sanitizeApplicationUrl(o.applicationUrl, options.officialHosts);
  const applicationInstructions =
    typeof o.applicationInstructions === "string" ? o.applicationInstructions : undefined;

  // ---- Issue #87: the processing range must match its cited durations ----
  // A SOFT check (never a rejection): when min/max is more than 20% from
  // every duration the processing citations state (Standard Visitor: max 56
  // stored with only "within 3 weeks" cited), the extraction is kept but
  // FLAGGED (`processingUnverifiedReasons`) and its confidence capped, so the
  // reviewer sees it instead of a silently stored number. Values with no
  // cited duration at all are not judged here (that is #86's rule).
  const processingUnverifiedReasons = checkProcessingRangeCitations(
    { processingDaysMin, processingDaysMax },
    citations
  );
  const finalConfidence =
    processingUnverifiedReasons.length > 0
      ? Math.min(confidence, PROCESSING_UNVERIFIED_CONFIDENCE_CAP)
      : confidence;

  return {
    name,
    code,
    description,
    category,
    processingTime,
    // Absent (not 0) when unknown — the `...` spreads below add the flag.
    ...(processingDaysMin !== undefined ? { processingDaysMin } : {}),
    ...(processingDaysMax !== undefined ? { processingDaysMax } : {}),
    ...(processingKnown ? {} : { processingUnknown: true as const }),
    feeComponents,
    validityPeriod,
    isExtendable,
    ...(maxExtensions !== undefined ? { maxExtensions } : {}),
    eligibilityCriteria: eligibility,
    requiredDocuments: docs.items,
    // Issue #187: kind + need per kept item, index-aligned (omitted when none).
    ...(docs.meta.length > 0 ? { requiredDocumentMeta: docs.meta } : {}),
    // Audit trail, only when something was dropped (issue #129).
    ...(docs.dropped.length > 0 ? { requiredDocumentsDropped: docs.dropped } : {}),
    applicationUrl,
    applicationInstructions,
    // Capped when the processing range disagrees with its citations (#87).
    confidence: finalConfidence,
    citations,
    // Only present when a surcharge was dropped (never an empty array/undefined key).
    ...(unverifiedReasons.length > 0 ? { feeUnverifiedReasons: unverifiedReasons } : {}),
    // Only present when something was dropped (issue #86).
    ...(uncitedFieldsDropped.length > 0 ? { uncitedFieldsDropped } : {}),
    // Only present when the processing range disagrees with its citations (#87).
    ...(processingUnverifiedReasons.length > 0 ? { processingUnverifiedReasons } : {}),
  };
}

/**
 * Validate `feeComponents` (pushes problems onto `errors`, returns the
 * normalized components). Rules (issue #59):
 *  - must be an array; [] is allowed (the page states no fee)
 *  - kind in {application, surcharge}; at most ONE application component
 *  - amount: finite number >= 0 (a plain numeric string is accepted)
 *  - per in {application, year}; per:"year" needs integer `years` >= 1 AND a
 *    `fee.years` citation (n-th per-year component: "fee.years.n")
 *  - a NON-ZERO amount needs a known ISO 4217 currency (static allow-list) and
 *    a non-empty citation "fee.application" / "fee.surcharge" (n-th surcharge:
 *    "fee.surcharge.n"). A zero component (free visa) may omit the currency
 *    but, since #86, still needs its citation: an uncited 0 is DROPPED and
 *    recorded as an unverified reason (no fake $0 cost).
 *  - components may use different currencies (each converted separately).
 */
function validateFeeComponents(
  raw: unknown,
  citations: Record<string, string>,
  errors: string[]
): { components: ExtractedFeeComponent[]; unverifiedReasons: string[] } {
  // Why a per-year surcharge was dropped (soft failures, see below).
  const unverifiedReasons: string[] = [];
  if (!Array.isArray(raw)) {
    errors.push("\"feeComponents\" must be an array (empty when the page states no fee)");
    return { components: [], unverifiedReasons };
  }
  const out: ExtractedFeeComponent[] = [];
  // Per-kind / per-year ordinals drive the citation key suffixes.
  const kindCount: Record<FeeComponentKind, number> = { application: 0, surcharge: 0 };
  let yearCount = 0;
  const hasCitation = (key: string) =>
    typeof citations[key] === "string" && citations[key].trim().length > 0;

  raw.forEach((item, i) => {
    const c = (item ?? {}) as Record<string, unknown>;
    const where = `feeComponents[${i}]`;

    // kind
    const kind = c.kind as FeeComponentKind;
    if (!FEE_KINDS.includes(kind)) {
      errors.push(`${where}.kind must be one of ${FEE_KINDS.join(", ")}`);
      return;
    }
    kindCount[kind]++;
    if (kind === "application" && kindCount.application > 1) {
      errors.push("at most one application fee component is allowed");
    }

    // amount (finite, >= 0)
    const amount = typeof c.amount === "string" && c.amount.trim() !== "" ? Number(c.amount) : c.amount;
    if (typeof amount !== "number" || !Number.isFinite(amount)) {
      errors.push(`${where}.amount must be a number`);
      return;
    }
    if (amount < 0) errors.push(`${where}.amount must be >= 0`);

    // per (+ years)
    const per = c.per as FeeComponentPer;
    if (!FEE_PERS.includes(per)) {
      errors.push(`${where}.per must be one of ${FEE_PERS.join(", ")}`);
      return;
    }
    const label = typeof c.label === "string" && c.label.trim() ? c.label.trim() : kind;
    let years: number | undefined;
    if (per === "year") {
      yearCount++;
      // Problems with `years` / its length citation. For a SURCHARGE these are
      // soft: the component is dropped (rest of the extraction kept) and the
      // fee is marked unverified, so one unprovable length (e.g. "the length
      // of your course") doesn't throw away the whole visa. For a per-year
      // APPLICATION fee they stay hard errors.
      const yearProblems: string[] = [];
      const y = typeof c.years === "string" ? Number(c.years) : c.years;
      if (typeof y !== "number" || !Number.isInteger(y) || y < 1 || y > MAX_FEE_YEARS) {
        yearProblems.push(`${where}.years must be an integer from 1 to ${MAX_FEE_YEARS} when per is "year"`);
      } else {
        years = y;
      }
      const yKey = feeYearsCitationKey(yearCount);
      if (!hasCitation(yKey)) {
        yearProblems.push(`${where} is per year but citations["${yKey}"] is missing`);
      } else {
        // The years citation must state a DURATION ("up to 5 years",
        // "2 years and 9 months", "five years"), not just a fee amount…
        const yQuote = citations[yKey];
        if (!DURATION_RE.test(yQuote)) {
          yearProblems.push(`citations["${yKey}"] must quote a visa length/duration (e.g. "up to 5 years")`);
        }
        // …and must not just repeat the application-fee sentence (the
        // failure seen live: the "up to 3 years - £819" fee line reused).
        const appQuote = citations[feeCitationKey("application", 1)];
        if (appQuote && appQuote.trim() === yQuote.trim()) {
          yearProblems.push(`citations["${yKey}"] must quote the visa length, not repeat the fee.application quote`);
        }
      }
      if (yearProblems.length > 0) {
        if (kind === "surcharge") {
          unverifiedReasons.push(`dropped surcharge "${label}": ${yearProblems.join(", ")}`);
          return; // drop this component only
        }
        errors.push(...yearProblems);
      }
    }

    // currency + citation
    const currency = typeof c.currency === "string" ? c.currency.trim().toUpperCase() : "";
    const citationKey = feeCitationKey(kind, kindCount[kind]);
    if (amount === 0 && !hasCitation(citationKey)) {
      // Issue #86: an UNCITED 0 is the prompt's "zero default", not a page
      // saying the visa is free. Soft failure: drop the component (rest of
      // the extraction kept) and mark the fee unverified, so computeFee
      // writes no baseCostUsd and approval is blocked — never a fake $0.
      unverifiedReasons.push(
        `dropped uncited zero ${kind} "${label}": a 0 amount needs citations["${citationKey}"] stating the visa is free`
      );
      return;
    }
    if (amount !== 0) {
      if (!currency) errors.push(`${where}.currency is required for a non-zero amount`);
      else if (!isIso4217(currency)) errors.push(`${where}.currency "${currency}" is not a known ISO 4217 code`);
      if (!hasCitation(citationKey)) errors.push(`${where} has a non-zero amount but citations["${citationKey}"] is missing`);
    } else if (currency && !isIso4217(currency)) {
      // A zero component may omit the currency, but must not invent one.
      errors.push(`${where}.currency "${currency}" is not a known ISO 4217 code`);
    }

    const component: ExtractedFeeComponent = { kind, label, amount, currency, per };
    if (years !== undefined) component.years = years;
    out.push(component);
  });
  return { components: out, unverifiedReasons };
}

/** Thrown when the model output fails validation (collects all problems). */
export class ExtractionValidationError extends Error {
  constructor(public readonly problems: string[]) {
    super(`Extracted visa failed validation: ${problems.join("; ")}`);
    this.name = "ExtractionValidationError";
  }
}

// ----- Prompt -----

// The instruction + schema the model must follow. Stable across all pages (a
// good candidate for provider-side prompt/context caching).
export function buildSystemPrompt(): string {
  return [
    "You extract a SINGLE country's visa/permit into strict JSON for an immigration platform.",
    "Return ONLY a JSON object — no markdown, no prose — with EXACTLY these keys:",
    "  name (string), code (short string, e.g. 'H1B' or 'SKILLED_WORKER'),",
    "  description (1-3 sentences), category (one of: " + VISA_CATEGORIES.join(", ") + "),",
    "  processingTime (string, e.g. '3-8 weeks'), processingDaysMin (number), processingDaysMax (number),",
    "  feeComponents (array, see FEES below), validityPeriod (string, e.g. '3 years'),",
    "  isExtendable (boolean), maxExtensions (number, optional),",
    "  eligibilityCriteria (array of short strings),",
    "  requiredDocuments (array of strings, see DOCUMENTS below), requiredDocumentMeta (array of objects, one per",
    "  requiredDocuments item in the same order, see DOCUMENTS below), applicationUrl (string, optional),",
    "  applicationInstructions (string, optional),",
    "  confidence (number 0-1: how confident you are this is accurate FROM THE PAGE),",
    "  citations (object mapping field name -> a short verbatim quote from the page that supports it).",
    "",
    "Rules:",
    "- Use ONLY information present on the page. Do NOT invent values.",
    "- If a value isn't on the page, use a sensible empty/zero default and LOWER your confidence.",
    "- Every non-trivial field you fill should have a matching quote in `citations`.",
    "- If the page describes MULTIPLE distinct visas, extract the one named in the provided route label.",
    "",
    "FEES (feeComponents):",
    "- Report fees EXACTLY as the page prints them, in the page's own currency. Do NOT convert currency.",
    "- Do NOT do any arithmetic: never add, multiply or total amounts. Report each published amount as-is.",
    "- Include ONLY: (1) the MAIN applicant's government application fee for the standard case of applying",
    "  from OUTSIDE the country, and (2) MANDATORY per-applicant surcharges",
    "  (e.g. the UK Immigration Health Surcharge) for that same visa length.",
    "- EXCLUDE: dependants' fees, priority/premium/super-priority services, shortage-occupation, immigration",
    "  salary list or other reduced-rate variants, in-country fees (extending, switching, updating, applying",
    "  from inside the country), and optional extras.",
    "",
    "CHOOSING THE VISA LENGTH (apply these steps in order, deterministically):",
    "  1. Keep only the outside-the-country, standard-rate (non-shortage, non-reduced) application fee options.",
    "  2. If those options differ by visa length (e.g. 'up to 3 years' vs 'more than 3 years'), pick the",
    "     option for the LONGEST length. Never pick a shorter-length option when a longer one is listed.",
    "  3. The visa length = the MAXIMUM length the page says that option can be granted for. If the option",
    "     is open-ended (e.g. 'more than 3 years'), use the visa's stated maximum length from elsewhere on the",
    "     page (e.g. 'Your visa can last for up to 5 years' -> 5).",
    "  4. Every per-year surcharge uses that SAME length as its `years` (a whole number of years; if the",
    "     length is not a whole number of years, use the number of years the page says the surcharge is",
    "     charged for). This step applies ONLY to a surcharge the page prints as a per-year rate.",
    "  Example (UK Skilled Worker): options outside the UK are 'up to 3 years - £819' and 'more than 3 years",
    "  - £1,618'; the visa can last up to 5 years. Correct: application amount 1618, healthcare surcharge",
    "  1035 per year with years 5. WRONG: 819 with years 3.",
    "",
    // ---- #73: a surcharge printed as a TOTAL for a stay length ----
    // GOV.UK prints some IHS amounts per year ("£1,035 per year") and some as
    // one amount for the whole stay ("£3,105 if you're staying for 2 years
    // and 9 months"). The second is already the total: multiplying it by the
    // years overstated the UK Family fee 3x (v3 eval baseline, #60). Some
    // pages print BOTH (Graduate: "£1,035 for each year" and "2 years - it
    // will cost £2,070"): the per-year rate wins, so one rule covers both.
    "SURCHARGE PER YEAR vs TOTAL (decide from the page's wording, per surcharge):",
    "- per: 'year' with `years` ONLY when the page states a per-year rate for it ('£1,035 per year',",
    "  '£1,035 for each year you'll be in the UK').",
    "- If the page states a per-year rate for the surcharge, ALWAYS use per: 'year' with that rate, even",
    "  when the page ALSO lists totals by length (e.g. '2 years - it will cost £2,070'). Do not report the",
    "  listed total in that case.",
    "- Only when the page states NO per-year rate for it and prints the surcharge as",
    "  ONE amount for a stated stay length ('£3,105 if you're staying for 2 years and 9 months',",
    "  '£5,175 if you're staying for 5 years'), that amount is ALREADY the TOTAL for the stay:",
    "  report it as per: 'application' with NO `years`. Never multiply it or treat it as per year.",
    "- When several such totals are listed by stay length, pick the one for the visa length chosen above",
    "  (the main adult applicant's standard stay when applying from outside the country). No 'fee.years'",
    "  citation is needed for a per: 'application' surcharge; cite the amount line in 'fee.surcharge'.",
    "  Example (UK Family, partner): '£3,105 if you're staying for 2 years and 9 months' -> surcharge amount",
    "  3105, per 'application'. WRONG: 3105 per year with years 3.",
    "",
    "- Each component is an object: { kind: 'application' | 'surcharge', label (the page's name for the fee),",
    "  amount (plain number, no symbols or thousands separators), currency (ISO 4217 code, e.g. 'GBP'),",
    "  per: 'application' | 'year', years (integer, ONLY when per is 'year': the visa length from the steps above) }.",
    "- At most ONE 'application' component. A visa with no surcharge has only the application component.",
    "- A free visa: one application component with amount 0. If the page states no fee at all: [].",
    "  Never use 0 for a fee you could not find: use [] instead (0 means the page says it is free).",
    "- Citations for fees (verbatim quotes): citations['fee.application'] for the application fee,",
    "  citations['fee.surcharge'] for the surcharge (a 2nd surcharge uses 'fee.surcharge.2').",
    "- citations['fee.years'] (2nd per-year component: 'fee.years.2') must quote the text that states the",
    "  visa LENGTH/DURATION you used for `years` (e.g. 'Your visa can last for up to 5 years'). It must",
    "  contain that duration, and must NOT simply repeat the fee sentence used for 'fee.application'.",
    "",
    // ---- #60/#73: processing time is the FULL standard range ----
    // User decision on #60: min/max span both standard decision times the
    // page states (outside- and inside-country), whichever is shorter first.
    "PROCESSING TIME (processingDaysMin / processingDaysMax, in days; 1 week = 7 days):",
    "- Report the FULL range of the STANDARD decision times the page states for applying from outside AND",
    "  from inside the country: processingDaysMin = the SHORTER of the two, processingDaysMax = the LONGER.",
    "  Example: '3 weeks, if you're outside the UK' and '8 weeks, if you're inside the UK' -> 21 and 56.",
    "  Example: 'outside the UK ... within 12 weeks' and 'inside the UK ... within 8 weeks' -> 56 and 84",
    "  (the inside time can be the shorter one).",
    "- The inside-country time may be for extending or switching (e.g. a visitor extending their stay):",
    "  still use its standard-service figure for the range.",
    "- Use standard service only: ignore priority / faster / paid-for services and exceptional cases",
    "  (e.g. 'about 12 months if you do not meet the requirements').",
    "- If the page gives only ONE standard figure (e.g. 'within 8 weeks'), use it for both",
    "  processingDaysMin and processingDaysMax.",
    "- processingTime (string) describes the same range, e.g. '3-8 weeks'.",
    // ---- #87: every processing figure is tied to the quote that states it ----
    // A v4 crawl stored max 56 (the visitor extension's "within 8 weeks")
    // while the only processing quote was "within 3 weeks". The validator
    // now flags a range whose ends are not stated in its citations.
    "- Processing citations (verbatim quotes, each must CONTAIN the duration it supports):",
    "  citations['processingDaysMin'] = the sentence stating the SHORTER time,",
    "  citations['processingDaysMax'] = the sentence stating the LONGER time (a different sentence when the",
    "  two times come from different parts of the page, e.g. applying from outside vs extending inside),",
    "  citations['processingTime'] = the quote(s) stating every duration in the range; when the two ends come",
    "  from different sentences, join both quotes with ' / '.",
    "  Example: citations['processingDaysMin'] = 'you'll usually get a decision on your visa within 3 weeks',",
    "  citations['processingDaysMax'] = 'a decision will usually be made within 8 weeks', processingTime '3-8 weeks'.",
    "- Never report a processing figure that no quote in these citations states.",
    "",
    // ---- #129: the page's own document list, nothing else ----
    "DOCUMENTS (requiredDocuments):",
    "- List ONLY the documents the page itself says the applicant must provide / send / upload / submit",
    "  (e.g. under a heading such as 'documents you must provide' or 'what you need to apply'), one string per",
    "  document, in the order the page lists them, using the page's own wording.",
    "- Never add a document the page does not name, even a typical one (passport, photo, ...). Do not infer",
    "  documents from eligibility rules. Do not split or merge the page's items.",
    "- If the page has no such list, return [] (this is valid; do not lower confidence for it).",
    "- EVERY item needs a verbatim quote: citations['requiredDocuments.<index>'] where <index> is the item's",
    "  0-based position in YOUR array (citations['requiredDocuments.0'] for the first). The quote must be copied",
    "  word for word from the page and contain the item's text. An item without such a quote will be discarded.",
    "",
    // ---- #187: what kind of item it is, and how firmly the page asks for it ----
    "DOCUMENT KIND AND NEED (requiredDocumentMeta; one object per requiredDocuments item, SAME order, SAME length):",
    "  { \"kind\": \"document\"|\"information\", \"kindQuote\": string, \"need\": \"required\"|\"conditional\"|\"optional\", \"appliesWhen\": string (only when need is conditional) }",
    "- kind: judge ONLY from the page's own wording. 'document' = something the applicant uploads or hands over",
    "  (a passport, a certificate, a letter, bank statements). 'information' = something the applicant types in or",
    "  states on the form (dates of travel, an address, a name, details of offences) - typically listed under a",
    "  lead-in such as 'You'll need to provide the following information in your online application'.",
    "  Decide each item from the sentence that introduces its list and from the item's own words; do not use",
    "  outside knowledge of what such a document usually is. When the page does not make it clear, still pick the",
    "  closer kind, but kindQuote must be real page text.",
    "- kindQuote: a verbatim quote from the page that supports the kind: the lead-in sentence of the item's list,",
    "  or the item's own words. For an item listed under 'Depending on your circumstances, you might also need to",
    "  provide:' use that lead-in as its kindQuote. A kindQuote that is not on the page makes the kind be ignored.",
    "- need: 'conditional' when the item's own quote has an 'if ...', 'unless ...' or 'depending on ...' clause, or",
    "  when the item sits under the lead-in 'Depending on your circumstances, you might also need to provide:'.",
    "  'optional' only when the page says 'optional'. Otherwise 'required'. The word 'may' NEVER makes an item",
    "  conditional or optional ('details of any offences you may have committed' is required).",
    "- appliesWhen (conditional only): the clause copied word for word, e.g. 'if you're visiting for more than 6",
    "  months', 'if you have an income', 'if known'; for lead-in items the lead-in itself ('Depending on your",
    "  circumstances, you might also need to provide'). Never reword it.",
  ].join("\n");
}

function buildUserPrompt(cleanText: string, ctx: ExtractContext): string {
  return [
    `Country: ${ctx.countryName}`,
    `Visa/route label: ${ctx.routeName}`,
    `Source URL: ${ctx.url}`,
    "",
    "PAGE CONTENT:",
    cleanText,
  ].join("\n");
}

// ----- DeepSeek implementation -----

const DEEPSEEK_BASE_URL = process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com";

/**
 * The DeepSeek model the extractor requests (issue DURIN-TECH/japa#92). The
 * ONE place the model id lives: the crawl, the CLI and the eval all read it
 * through `visaCatalogExtractor.model`, and run records / results file names
 * carry it.
 *
 * Source (checked 2026-11-10):
 *  - https://api-docs.deepseek.com/quick_start/pricing: "Use `deepseek-flash`
 *    as the model name" (model version DeepSeek-V4.1-Flash-1017); "JSON
 *    Output" is supported; the legacy names "deepseek-v4-flash and
 *    deepseek-v4-flash-vision-exp are still accepted" but their models "have
 *    been retired".
 *  - https://api-docs.deepseek.com/updates, 2026-10-17: "simply use
 *    `deepseek-flash` to access the latest model"; 2026-09-10: "Change the
 *    model name to `deepseek-flash` to call the latest V4.1 Flash model".
 *  - Same change log, 2026-04-24: `deepseek-chat` "will be discontinued in
 *    three months (2026-07-24)"; until then it mapped to V4 Flash's
 *    non-thinking mode. We used to request `deepseek-chat`; an explicit id
 *    means a removal of that alias cannot break crawls.
 *
 * `deepseek-flash` is a moving alias for the latest Flash build (DeepSeek
 * names no dated id to pin). A Flash upgrade can therefore change output
 * without a code change: the response's `model` field is recorded as
 * `responseModel` on every extraction so a drift is visible, and the eval
 * (`npm run eval:visa-extract`) is the check to re-run when the change log
 * announces a new Flash build.
 */
export const DEEPSEEK_EXTRACTOR_MODEL = "deepseek-flash";

/**
 * DeepSeek extractor. Uses the OpenAI-compatible chat/completions endpoint with
 * JSON output mode. Requires `DEEPSEEK_API_KEY` in the environment (bound as a
 * Firebase secret at deploy time). Construction never throws — the key is only
 * required when `extract()` is actually called, so the pipeline can be built and
 * compiled before a key exists.
 */
export class DeepSeekExtractor implements LlmExtractor {
  readonly model: string;

  constructor(model: string = DEEPSEEK_EXTRACTOR_MODEL) {
    this.model = model;
  }

  async extract(cleanText: string, context: ExtractContext): Promise<ExtractedVisa> {
    const apiKey = process.env.DEEPSEEK_API_KEY;
    if (!apiKey) {
      throw new Error(
        "DEEPSEEK_API_KEY is not set — configure it as a Firebase secret before running extraction."
      );
    }

    const resp = await fetch(`${DEEPSEEK_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        // Non-thinking mode, explicitly (issue #92). deepseek-flash has both
        // modes and "Thinking mode is enabled by default"
        // (https://api-docs.deepseek.com/guides/thinking_mode; the OpenAI
        // format is {"thinking": {"type": "enabled/disabled"}}). The old
        // deepseek-chat alias was the non-thinking mode; thinking would add
        // billed reasoning tokens to every page and, per the same guide,
        // makes `temperature` have "no effect". Extraction needs neither.
        thinking: { type: "disabled" },
        // Low temperature: extraction should be deterministic, not creative.
        // (Honoured in non-thinking mode only; see above.)
        temperature: 0,
        // JSON mode — the model must return a syntactically valid JSON object.
        // https://api-docs.deepseek.com/guides/json_mode: response_format
        // {'type': 'json_object'}, and the prompt must contain the word
        // "json" (buildSystemPrompt does). No max_tokens: the model's output
        // cap (384K per the pricing page) is far above an extraction's ~1K.
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: buildSystemPrompt() },
          { role: "user", content: buildUserPrompt(cleanText, context) },
        ],
      }),
    });

    if (!resp.ok) {
      const detail = await resp.text().catch(() => "");
      throw new Error(`DeepSeek API error ${resp.status}: ${detail.slice(0, 300)}`);
    }

    const data = (await resp.json()) as {
      choices?: { message?: { content?: string } }[];
      // Issue #82: OpenAI-compatible usage (prompt_tokens, completion_tokens,
      // total_tokens, prompt_cache_hit_tokens, prompt_cache_miss_tokens).
      usage?: unknown;
      // The model that actually served the call (may differ from the
      // requested alias, e.g. deepseek-flash -> a dated Flash build).
      model?: unknown;
    };

    // ---- Usage (issue #82): report it before anything can throw below ----
    const usage = parseDeepSeekUsage(data.usage);
    if (usage && context.onUsage) {
      try {
        context.onUsage({
          usage,
          model: this.model,
          ...(typeof data.model === "string" && data.model ? { responseModel: data.model } : {}),
          atMs: Date.now(),
        });
      } catch (err) {
        console.error("DeepSeek extractor: onUsage callback failed (ignored):", err);
      }
    }

    // JSON mode can answer with whitespace only: "the returned `content` may
    // contain only spaces" when the output was not valid JSON
    // (https://api-docs.deepseek.com/guides/json_mode). Treat that as "no
    // content" (a clear error) rather than a confusing JSON.parse failure.
    const content = data.choices?.[0]?.message?.content;
    if (!content || !content.trim()) throw new Error("DeepSeek returned no content");

    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      throw new Error("DeepSeek returned non-JSON content");
    }

    // Validate before handing off — never let an invalid shape past this line.
    // `officialHosts` (registry) gates `applicationUrl` (issue #74).
    // `pageText` lets the validator confirm document quotes are on the page (#129).
    return validateExtractedVisa(parsed, { officialHosts: context.officialHosts, pageText: cleanText });
  }
}

// Default extractor used by the pipeline (swap here to change providers).
export const visaCatalogExtractor: LlmExtractor = new DeepSeekExtractor();
