import { ExtractedVisa } from "../types/visa-catalog";
import { VisaCategory } from "../types";

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
  const baseCostUsd = num("baseCostUsd");
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

  // ---- Range / sanity checks (defence against nonsense values) ----
  if (Number.isFinite(processingDaysMin) && Number.isFinite(processingDaysMax)) {
    if (processingDaysMin < 0 || processingDaysMax < 0)
      errors.push("processing days must be non-negative");
    if (processingDaysMin > processingDaysMax)
      errors.push("processingDaysMin must be <= processingDaysMax");
  }
  if (Number.isFinite(baseCostUsd) && (baseCostUsd < 0 || baseCostUsd > 100_000)) {
    errors.push("baseCostUsd out of plausible range (0–100000)");
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
    baseCostUsd,
    validityPeriod,
    isExtendable,
    maxExtensions,
    eligibilityCriteria: eligibility,
    applicationUrl,
    applicationInstructions,
    confidence,
    citations,
  };
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
function buildSystemPrompt(): string {
  return [
    "You extract a SINGLE country's visa/permit into strict JSON for an immigration platform.",
    "Return ONLY a JSON object — no markdown, no prose — with EXACTLY these keys:",
    "  name (string), code (short string, e.g. 'H1B' or 'SKILLED_WORKER'),",
    "  description (1-3 sentences), category (one of: " + VISA_CATEGORIES.join(", ") + "),",
    "  processingTime (string, e.g. '3-8 weeks'), processingDaysMin (number), processingDaysMax (number),",
    "  baseCostUsd (number; convert local fees to USD; 0 if unknown), validityPeriod (string, e.g. '3 years'),",
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
