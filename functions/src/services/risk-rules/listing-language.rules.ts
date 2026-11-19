// ============================================
// Listing language indicators (issue #120)
// ============================================
//
// Three recruitment-fraud indicators, each grounded in a PUBLISHED quote. A
// model only LOCATES wording that matches an indicator (it returns
// `{ indicator, field, quote }`); CODE validates every flag, owns the
// severity, and raises the signal. The model decides nothing about holding,
// approving or severity.
//
// Sources were fetched as raw pages and the quotes confirmed verbatim on
// 2026-11-13 (plain HTTP fetch, tags stripped, whitespace collapsed):
//
//  1. listing_guaranteed_outcome
//     https://www.gov.uk/government/publications/frauds-tricks-and-scams/fraud-tricks-and-scams
//     "Fraud, tricks and scams: guidance". Quote is verbatim on the page.
//
//  2. listing_payment_for_job_offer
//     Same page. Quote verbatim. Second reference (not the registered quote):
//     https://www.ilo.org/resource/ilos-2016-general-principles-and-operational-guidelines-fair-recruitment
//     "No recruitment fees or related costs should be charged to, or otherwise
//     borne by, workers or jobseekers." (verbatim on that page, 2026-11-13).
//
//  3. listing_identity_document_retention
//     The ILO page above. The page prints a typographic apostrophe in
//     "Workers’ identity documents ..."; the registered quote keeps the
//     page's own character (U+2019), not a straight one.
//
// Do not paraphrase a quote and do not add an indicator without a published
// quote (candidates without one are tracked in #127).
//
// Wording of every message is neutral: "contains wording matching an
// indicator". Nothing here predicts an outcome or a likelihood.
//
// Generic: no jurisdiction, country, nationality or route is named in code.
// (The source URLs above are data on the rule entries.)

import type { RiskSignalSeverity } from "../../types/risk-signal";
import type { ListingLanguageFlag } from "../../types/listing-screening";
import type { RiskRule } from "./types";

// ============================================
// Constants
// ============================================

/** Version of the indicator set and its validation, on every signal. */
export const LISTING_LANGUAGE_VERSION = "1";

/** Signal `type` raised for accepted flags. */
export const LISTING_LANGUAGE_SIGNAL_TYPE = "listing_recruitment_language";

/** Longest quote a flag may carry. */
export const MAX_FLAG_QUOTE_CHARS = 200;
/** Most flags accepted from one model reply. */
export const MAX_FLAGS_PER_LISTING = 10;

/**
 * The listing text fields the model may read and flag (and nothing else).
 * Eligibility criteria are addressed as `eligibilityCriteria.<index>`.
 */
export const FLAGGABLE_STATIC_FIELDS = ["name", "description", "applicationInstructions", "sponsor.organisationName"] as const;

/** One indicator: a registered rule plus its model-facing description and severity. */
export interface ListingLanguageRule extends RiskRule<ListingLanguageInput, ListingLanguageFinding> {
  /** Plain description shown to the model (a restatement of the quote, no jurisdiction). */
  description: string;
  /** Severity comes from this table, never from the model. */
  severity: RiskSignalSeverity;
}

/** What `evaluate` receives: the flags that already passed validation. */
export interface ListingLanguageInput {
  flags: ListingLanguageFlag[];
}

/** The flags of ONE indicator. */
export interface ListingLanguageFinding {
  flags: ListingLanguageFlag[];
}

/** Build a rule whose `evaluate` keeps only the flags of its own indicator. */
function languageRule(
  fields: Omit<ListingLanguageRule, "version" | "evaluate">
): ListingLanguageRule {
  return {
    ...fields,
    version: LISTING_LANGUAGE_VERSION,
    evaluate({ flags }) {
      const mine = flags.filter((f) => f.indicator === fields.ruleId);
      return mine.length > 0 ? { flags: mine } : null;
    },
  };
}

// ============================================
// The three indicators
// ============================================

export const guaranteedOutcomeRule = languageRule({
  ruleId: "listing_guaranteed_outcome",
  category: "scam",
  severity: "medium",
  sourceUrl: "https://www.gov.uk/government/publications/frauds-tricks-and-scams/fraud-tricks-and-scams",
  sourceQuote: "Someone guarantees you will get a visa if you apply using documents they will give you.",
  description: "The text promises or guarantees that a visa will be granted.",
});

export const paymentForJobOfferRule = languageRule({
  ruleId: "listing_payment_for_job_offer",
  category: "scam",
  severity: "medium",
  sourceUrl: "https://www.gov.uk/government/publications/frauds-tricks-and-scams/fraud-tricks-and-scams",
  sourceQuote: "A genuine employer will not ask for payment to secure a visa.",
  description:
    "The text asks the applicant to pay to secure a visa or a job offer, or says recruitment fees or related costs are charged to the worker or jobseeker.",
});

export const identityDocumentRetentionRule = languageRule({
  ruleId: "listing_identity_document_retention",
  category: "trafficking",
  severity: "high",
  sourceUrl: "https://www.ilo.org/resource/ilos-2016-general-principles-and-operational-guidelines-fair-recruitment",
  // The page prints U+2019 (a curly apostrophe) here; kept as published.
  sourceQuote: "Workers’ identity documents and contracts should not be confiscated, destroyed or retained.",
  description: "The text says identity documents or contracts will be kept, held or taken from the worker.",
});

/** The indicators, registered in RISK_RULES by ./registry.ts. */
export const LISTING_LANGUAGE_RULES: readonly ListingLanguageRule[] = [
  guaranteedOutcomeRule,
  paymentForJobOfferRule,
  identityDocumentRetentionRule,
];

/** Look up an indicator by its rule id (undefined = not registered). */
export function languageRuleFor(indicator: string): ListingLanguageRule | undefined {
  return LISTING_LANGUAGE_RULES.find((r) => r.ruleId === indicator);
}

// ============================================
// Flag validation (pure)
// ============================================

/** Result of validating a model reply. */
export type FlagValidation =
  | { ok: true; accepted: ListingLanguageFlag[]; dropped: number }
  | { ok: false }; // not valid JSON / not the expected shape: a model failure

/**
 * Validate the model's reply against the listing's own text.
 *
 * @param replyText the model's raw answer
 * @param fields    field name -> that field's exact text (the only fields a flag may name)
 *
 * A flag is accepted only when: the indicator is a registered rule id; the
 * field is one of `fields`; the quote is non-empty, at most
 * MAX_FLAG_QUOTE_CHARS and an EXACT substring of that field's text; it is not
 * a repeat; and fewer than MAX_FLAGS_PER_LISTING have been accepted already.
 * Everything else is dropped and counted. A reply that is not JSON, or whose
 * top level is not `{ flags: [...] }`, is `{ ok: false }` (a model failure).
 */
export function validateListingFlags(replyText: string, fields: Readonly<Record<string, string>>): FlagValidation {
  let parsed: unknown;
  try {
    parsed = JSON.parse(replyText);
  } catch {
    return { ok: false };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return { ok: false };
  const raw = (parsed as { flags?: unknown }).flags;
  if (!Array.isArray(raw)) return { ok: false };

  const accepted: ListingLanguageFlag[] = [];
  const seen = new Set<string>();
  let dropped = 0;
  for (const item of raw) {
    const flag = acceptFlag(item, fields);
    const key = flag ? `${flag.indicator}|${flag.field}|${flag.quote}` : "";
    if (!flag || seen.has(key) || accepted.length >= MAX_FLAGS_PER_LISTING) {
      dropped++;
      continue;
    }
    seen.add(key);
    accepted.push(flag);
  }
  return { ok: true, accepted, dropped };
}

/** One flag, or null when it fails any check. */
function acceptFlag(item: unknown, fields: Readonly<Record<string, string>>): ListingLanguageFlag | null {
  if (typeof item !== "object" || item === null || Array.isArray(item)) return null;
  const { indicator, field, quote } = item as Record<string, unknown>;
  if (typeof indicator !== "string" || !languageRuleFor(indicator)) return null;
  // `hasOwn`: a field name like "constructor" must not resolve through the prototype.
  if (typeof field !== "string" || !Object.prototype.hasOwnProperty.call(fields, field)) return null;
  if (typeof quote !== "string" || quote.trim().length === 0 || quote.length > MAX_FLAG_QUOTE_CHARS) return null;
  if (!fields[field].includes(quote)) return null;
  return { indicator, field, quote };
}
