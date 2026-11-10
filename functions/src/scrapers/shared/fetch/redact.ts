import { hostOf } from "../etiquette/visa-crawl-host-state";

// ============================================
// SECRET REDACTION — shared helpers (issues #76, #81)
// ============================================
//
// Pure (no Firebase import). Originally lived in news-scraper.service.ts
// (#76); moved here in #81 so the scrape-run recorder
// (scrapers/shared/runs/scrape-run.service.ts) can redact the errors it stores on
// `scrapeRuns/{runId}` without importing the news scraper (which would be a
// circular import: the scraper records runs). news-scraper.service.ts
// re-exports both functions, so its public API is unchanged.
//
// News API keys must never reach Cloud Logging or Firestore. NewsAPI gets
// its key in the `X-Api-Key` header (documented at
// https://newsapi.org/docs/authentication), but NewsData.io only documents
// the `apikey` QUERY parameter (https://newsdata.io/documentation), so its
// key is in the request URL. A raw axios error carries that URL (and the
// request headers) in `error.config`, so the scraper NEVER logs or stores a
// raw error object: everything goes through describeError(), which keeps
// only the message (plus host + status when known) with keys redacted.

/** Query parameters / headers that carry an API key (matched case-insensitively). */
const SECRET_PARAM_PATTERN = /((?:api[_-]?key|x-api-key|access[_-]?key|x-access-key)\s*[=:]\s*)[^&\s"',;]+/gi;

/** A bearer token in an Authorization header / error text (#81). */
const BEARER_PATTERN = /(bearer\s+)[A-Za-z0-9._~+/=-]{6,}/gi;

/**
 * Other secret env vars whose literal values are redacted wherever they
 * appear (#81): the scrape-run recorder stores visa crawl errors too, and an
 * LLM provider error could echo the extractor key back.
 */
const EXTRA_SECRET_ENV_VARS = ["DEEPSEEK_API_KEY"];

/**
 * Replace the value of every `apikey=` / `apiKey=` / `X-Api-Key:`-style pair
 * in `text` with `[REDACTED]`. Also redacts the literal values of the
 * configured NEWS_API_KEY_* env vars (and EXTRA_SECRET_ENV_VARS) wherever they appear (belt and braces:
 * catches a key echoed back in an upstream error body).
 */
export function redactSecrets(text: string): string {
  let out = text
    .replace(SECRET_PARAM_PATTERN, "$1[REDACTED]")
    // `Authorization: Bearer <token>` (e.g. the DeepSeek extractor's key, #81).
    .replace(BEARER_PATTERN, "$1[REDACTED]");
  for (const [name, value] of Object.entries(process.env)) {
    if ((name.startsWith("NEWS_API_KEY_") || EXTRA_SECRET_ENV_VARS.includes(name)) && value && value.length >= 6) {
      out = out.split(value).join("[REDACTED]");
    }
  }
  return out;
}

/**
 * A loggable, secret-free one-line description of an error: its message,
 * plus `host` and HTTP `status` when it is an axios error (read from
 * `config.url` / `response.status`, never echoed whole). Redacted.
 */
export function describeError(error: unknown): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const e = error as any;
  const message = error instanceof Error ? error.message : String(error);
  const parts: string[] = [];
  if (e && typeof e === "object" && e.isAxiosError) {
    const host = typeof e.config?.url === "string" ? hostOf(e.config.url) : "";
    if (host) parts.push(`host=${host}`);
    if (typeof e.response?.status === "number") parts.push(`status=${e.response.status}`);
  }
  parts.push(message);
  return redactSecrets(parts.join(" "));
}

