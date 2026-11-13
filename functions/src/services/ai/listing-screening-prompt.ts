// ============================================
// Listing screening: prompt, schema and screened-content helpers (issue #120)
// ============================================
//
// PURE module (no Firestore, no clock, no SDK). It holds:
//  - listingTextFields(): the ONLY text the model ever sees (the listing's own
//    text fields), keyed by the field names a flag may cite;
//  - screeningContentHash(): the hash that makes screening idempotent;
//  - buildListingScreeningRequest(): the `LlmRequest` (role `extraction`, no
//    tools, capped output and time), with the untrusted text wrapped by
//    wrapUntrusted(text, "listing") and DATA_ONLY_RULE in the system prompt;
//  - LISTING_SCREENING_SCHEMA: the JSON the model must return.
//
// What the model never gets: applicant data, messages, documents, the verified
// record, the comparison results, or any tool. What it never decides: holding,
// approving, severity. It returns `{ flags: [{ indicator, field, quote }] }`
// and code validates every flag (listing-language.rules.ts).
//
// Generic: indicator wording comes from the rule entries; nothing here names a
// country, nationality or route, so two routes' prompts differ only in the
// listing's own text.

import { createHash } from "crypto";
import type { LlmRequest } from "./llm-provider";
import { DATA_ONLY_RULE, wrapUntrusted } from "./prompt-safety";
import {
  LISTING_LANGUAGE_RULES,
  MAX_FLAGS_PER_LISTING,
  MAX_FLAG_QUOTE_CHARS,
} from "../risk-rules/listing-language.rules";
import type { ScreeningTarget } from "../../types/listing-screening";

// ============================================
// Constants
// ============================================

/** Version of the prompt and schema (bump on any wording change). */
export const LISTING_SCREENING_PROMPT_VERSION = "listing-screening-2026-11-13.1";

/** Output ceiling: well under the 1000-token limit the issue sets. */
export const LISTING_SCREENING_MAX_OUTPUT_TOKENS = 1000;

/**
 * Time one model request may take, in ms (the issue allows at most 20000).
 * The SDK may retry once, so the service also stops waiting after its own
 * overall budget (see agency-visa-screening.service.ts).
 */
export const LISTING_SCREENING_TIMEOUT_MS = 12_000;

// ============================================
// Screened content
// ============================================

/**
 * The listing's text fields, keyed by the field names a flag may cite:
 * `name`, `description`, `applicationInstructions`, `eligibilityCriteria.<i>`
 * and `sponsor.organisationName`. Missing or blank values are left out.
 * Values are the EXACT stored text (a quote must be a substring of it).
 */
export function listingTextFields(content: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  const add = (key: string, v: unknown) => {
    if (typeof v === "string" && v.trim().length > 0) out[key] = v;
  };
  add("name", content.name);
  add("description", content.description);
  add("applicationInstructions", content.applicationInstructions);
  if (Array.isArray(content.eligibilityCriteria)) {
    content.eligibilityCriteria.forEach((c, i) => add(`eligibilityCriteria.${i}`, c));
  }
  const sponsor = content.sponsor;
  if (typeof sponsor === "object" && sponsor !== null) {
    add("sponsor.organisationName", (sponsor as Record<string, unknown>).organisationName);
  }
  return out;
}

/** JSON with object keys sorted, so equal content always serialises equally. */
function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined && o[k] !== null)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

/**
 * sha256 of the screened content (`sha256:<hex>`). `content` is the visa's
 * content fields as they would go live (a submit: the visa; an edit: live
 * content plus the proposal). The target is part of the hash so a visa and a
 * revision with equal content are not mistaken for each other.
 */
export function screeningContentHash(target: ScreeningTarget, content: Record<string, unknown>): string {
  const hex = createHash("sha256").update(canonicalJson({ target, content })).digest("hex");
  return `sha256:${hex}`;
}

// ============================================
// Prompt
// ============================================

/** The JSON the model must return. The caller re-validates every flag in code. */
export const LISTING_SCREENING_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    flags: {
      type: "array",
      items: {
        type: "object",
        properties: {
          indicator: { type: "string", enum: LISTING_LANGUAGE_RULES.map((r) => r.ruleId) },
          field: { type: "string" },
          quote: { type: "string" },
        },
        required: ["indicator", "field", "quote"],
        additionalProperties: false,
      },
    },
  },
  required: ["flags"],
  additionalProperties: false,
};

/** The system prompt: the task, the indicators (data from the rule entries) and the data-only rule. */
export function buildListingScreeningSystemPrompt(): string {
  return [
    "You locate wording in a visa listing that matches a fixed list of indicators. You do not judge the listing.",
    "",
    "Indicators (use the id exactly as written):",
    ...LISTING_LANGUAGE_RULES.map((r) => `- ${r.ruleId}: ${r.description}`),
    "",
    "Rules:",
    "- Return ONLY JSON: {\"flags\":[{\"indicator\":\"<id>\",\"field\":\"<field name>\",\"quote\":\"<exact words>\"}]}.",
    `- "field" is the field name shown before the text. "quote" must be copied EXACTLY, character for character, from that field, at most ${MAX_FLAG_QUOTE_CHARS} characters.`,
    `- Return at most ${MAX_FLAGS_PER_LISTING} flags. Return {"flags":[]} when nothing matches.`,
    "- Flag only wording that matches an indicator. Do not flag ordinary fees, ordinary requirements or ordinary advice.",
    "- Do not say whether the listing is genuine, likely to be a scam or likely to succeed. Do not decide anything about it.",
    "",
    DATA_ONLY_RULE,
  ].join("\n");
}

/** The user message: each text field under its name, wrapped as untrusted data. */
export function buildListingScreeningUserPrompt(fields: Readonly<Record<string, string>>): string {
  const blocks = Object.entries(fields).map(([name, text]) => `Field "${name}":\n${wrapUntrusted(text, "listing")}`);
  return ["Listing text fields:", "", ...blocks].join("\n\n");
}

/**
 * The full request for one listing: role `extraction`, no tools, no
 * documents, bounded output and time.
 */
export function buildListingScreeningRequest(fields: Readonly<Record<string, string>>): LlmRequest {
  return {
    role: "extraction",
    system: buildListingScreeningSystemPrompt(),
    user: buildListingScreeningUserPrompt(fields),
    schema: LISTING_SCREENING_SCHEMA,
    maxOutputTokens: LISTING_SCREENING_MAX_OUTPUT_TOKENS,
    timeoutMs: LISTING_SCREENING_TIMEOUT_MS,
  };
}
