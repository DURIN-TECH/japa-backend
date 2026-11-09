import type {
  ExtractedFeeComponent,
  ExtractedVisa,
  FeeComponentKind,
  FeeComponentPer,
} from "../types/visa-catalog";
import { VisaCategory } from "../types";
// Static ISO 4217 allow-list (no network) for fee component currencies.
import { isIso4217 } from "./visa-catalog-fx";

// ============================================
// VISA CATALOG — EXTRACT SERVICE (Step 3)
// ============================================
//
// Turns a cleaned visa page (from the fetch service) into a structured
// `ExtractedVisa` using an LLM. The model sits behind the `LlmExtractor`
// interface so the provider is swappable; the default implementation is
// DeepSeek-chat (OpenAI-compatible API, JSON output mode) — the cost-optimal
// choice for per-page schema extraction.
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
 *    years only when the page states a per-year rate (the v3 model returned
 *    3105 per year x 3, tripling the Family fee). Also: processing time is the
 *    FULL standard range (min/max = shorter/longer of the outside- and
 *    inside-country standard decision times).
 * Before merging a bump (or a model change), run `npm run eval:visa-extract`
 * and attach the result — see functions/eval/README.md.
 */
export const EXTRACTOR_PROMPT_VERSION = "2026-11-surcharge-total-v4";

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

// Context passed alongside the page text to ground the extraction.
export interface ExtractContext {
  url: string;
  countryName: string;
  routeName: string; // the label from the source registry, e.g. "Skilled Worker visa"
}

// The provider-agnostic contract. Any model backend implements this.
export interface LlmExtractor {
  readonly model: string;
  extract(cleanText: string, context: ExtractContext): Promise<ExtractedVisa>;
}

// ----- Validation (dependency-free) -----

/** Narrow unknown → ExtractedVisa, or throw with the first problem found. */
export function validateExtractedVisa(raw: unknown): ExtractedVisa {
  const errors: string[] = [];
  const o = (raw ?? {}) as Record<string, unknown>;

  const str = (k: string, required = true) => {
    const v = o[k];
    if (typeof v === "string" && v.trim().length > 0) return v.trim();
    if (required) errors.push(`"${k}" must be a non-empty string`);
    return "";
  };
  const num = (k: string) => {
    const v = typeof o[k] === "string" ? Number(o[k]) : o[k];
    if (typeof v === "number" && Number.isFinite(v)) return v;
    errors.push(`"${k}" must be a number`);
    return NaN;
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
  const processingTime = str("processingTime", false);
  const processingDaysMin = num("processingDaysMin");
  const processingDaysMax = num("processingDaysMax");
  const validityPeriod = str("validityPeriod", false);
  const isExtendable = bool("isExtendable");

  // eligibilityCriteria: array of non-empty strings.
  const eligibility = Array.isArray(o.eligibilityCriteria)
    ? (o.eligibilityCriteria as unknown[]).filter(
      (x): x is string => typeof x === "string" && x.trim().length > 0
    )
    : [];
  if (eligibility.length === 0) errors.push("\"eligibilityCriteria\" must be a non-empty string array");

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

  // ---- Range / sanity checks (defence against nonsense values) ----
  if (Number.isFinite(processingDaysMin) && Number.isFinite(processingDaysMax)) {
    if (processingDaysMin < 0 || processingDaysMax < 0)
      errors.push("processing days must be non-negative");
    if (processingDaysMin > processingDaysMax)
      errors.push("processingDaysMin must be <= processingDaysMax");
  }

  if (errors.length > 0) {
    throw new ExtractionValidationError(errors);
  }

  const maxExtensions =
    typeof o.maxExtensions === "number" ? o.maxExtensions : undefined;
  const applicationUrl = typeof o.applicationUrl === "string" ? o.applicationUrl : undefined;
  const applicationInstructions =
    typeof o.applicationInstructions === "string" ? o.applicationInstructions : undefined;

  return {
    name,
    code,
    description,
    category,
    processingTime,
    processingDaysMin,
    processingDaysMax,
    feeComponents,
    validityPeriod,
    isExtendable,
    maxExtensions,
    eligibilityCriteria: eligibility,
    applicationUrl,
    applicationInstructions,
    confidence,
    citations,
    // Only present when a surcharge was dropped (never an empty array/undefined key).
    ...(unverifiedReasons.length > 0 ? { feeUnverifiedReasons: unverifiedReasons } : {}),
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
 *    "fee.surcharge.n"). A zero component needs neither (free visa).
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

    // currency + citation (only required for a non-zero amount)
    const currency = typeof c.currency === "string" ? c.currency.trim().toUpperCase() : "";
    if (amount !== 0) {
      if (!currency) errors.push(`${where}.currency is required for a non-zero amount`);
      else if (!isIso4217(currency)) errors.push(`${where}.currency "${currency}" is not a known ISO 4217 code`);
      const key = feeCitationKey(kind, kindCount[kind]);
      if (!hasCitation(key)) errors.push(`${where} has a non-zero amount but citations["${key}"] is missing`);
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
    "  eligibilityCriteria (array of short strings), applicationUrl (string, optional),",
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
    // years overstated the UK Family fee 3x (v3 eval baseline, #60).
    "SURCHARGE PER YEAR vs TOTAL (decide from the page's wording, per surcharge):",
    "- per: 'year' with `years` ONLY when the page states a per-year rate for it ('£1,035 per year',",
    "  '£1,035 for each year you'll be in the UK').",
    "- If the page prints the surcharge as ONE amount for a stated stay length ('£3,105 if you're staying for",
    "  2 years and 9 months', '£5,175 if you're staying for 5 years'), that amount is ALREADY the TOTAL for",
    "  the stay: report it as per: 'application' with NO `years`. Never multiply it or treat it as per year.",
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
 * DeepSeek extractor. Uses the OpenAI-compatible chat/completions endpoint with
 * JSON output mode. Requires `DEEPSEEK_API_KEY` in the environment (bound as a
 * Firebase secret at deploy time). Construction never throws — the key is only
 * required when `extract()` is actually called, so the pipeline can be built and
 * compiled before a key exists.
 */
export class DeepSeekExtractor implements LlmExtractor {
  readonly model: string;

  constructor(model = "deepseek-chat") {
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
        // Low temperature: extraction should be deterministic, not creative.
        temperature: 0,
        // JSON mode — the model must return a syntactically valid JSON object.
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
    };
    const content = data.choices?.[0]?.message?.content;
    if (!content) throw new Error("DeepSeek returned no content");

    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      throw new Error("DeepSeek returned non-JSON content");
    }

    // Validate before handing off — never let an invalid shape past this line.
    return validateExtractedVisa(parsed);
  }
}

// Default extractor used by the pipeline (swap here to change providers).
export const visaCatalogExtractor: LlmExtractor = new DeepSeekExtractor();
