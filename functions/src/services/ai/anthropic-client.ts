// ============================================
// ANTHROPIC CLIENT — the one shared factory (issue DURIN-TECH/japa#31)
// ============================================
//
// Every backend call to the Claude API goes through getAnthropicClient().
// Nothing else in `functions/src` should call `new Anthropic(...)` or read
// `process.env.ANTHROPIC_API_KEY`.
//
// Where the key comes from:
//  - Deployed: Cloud Secret Manager. Gen-1 functions only see a secret when
//    they list it in `.runWith({ secrets })`; `AI_SECRETS` below is that
//    list (src/index.ts spreads it into the functions that need it). A function that calls the model without binding AI_SECRETS
//    hits the "not set" error below — which is the point of the error.
//  - Local / emulator: the gitignored `functions/.env.local`.
//  The key is never in git, never in a tracked `.env.<project>` file.
//
// What this module guarantees:
//  1. The key is read ONCE per function instance (the client is memoised).
//  2. A missing key fails loudly and actionably at the call site, instead of
//     the SDK surfacing an opaque auth failure / 500 at request time.
//  3. The SDK is loaded lazily, on the first call. Importing this module costs
//     nothing, so routes that never touch AI don't pay the SDK's module-load
//     time on a cold start.
//  4. The key never reaches logs — see "Keeping the key out of logs" below.
//
// Model ids are NOT here: import a role from ./ai-models.

// Type-only import: erased at compile time, so it does NOT load the SDK. The
// runtime load is the lazy require() inside getAnthropicClient().
import type Anthropic from "@anthropic-ai/sdk";

/** Name of the env var / Firebase function secret that holds the API key. */
export const ANTHROPIC_API_KEY_ENV = "ANTHROPIC_API_KEY";

/**
 * The Firebase function secrets an AI-calling function must bind. The single
 * exported list: src/index.ts (and any function module added later) spreads it
 * into `.runWith({ secrets: [...AI_SECRETS] })`, the same way
 * `crawlVisaCatalogOrchestrator` spreads `VISA_CATALOG_SECRETS`. Gen 1
 * (`firebase-functions/v1`) binding by NAME: this codebase does not use the
 * Gen-2 secret-parameter helper, and a unit test keeps it out of src/.
 *
 * Bound today: `api` only. The assessment worker (#42) and later AI tasks
 * (#115, #117, #118) add it to their own function when they land.
 */
export const AI_SECRETS: string[] = [ANTHROPIC_API_KEY_ENV];

// ============================================
// Missing-key error
// ============================================

/**
 * Thrown by getAnthropicClient() when ANTHROPIC_API_KEY is absent or blank.
 * A dedicated class so callers (e.g. the future `/ai` routes) can map it to a
 * clean 503 "AI is not configured" rather than a generic 500.
 *
 * The message names the variable and the project and says how to fix it. It
 * never contains a key (there is none to contain).
 */
export class AnthropicNotConfiguredError extends Error {
  constructor() {
    // GCLOUD_PROJECT is set by the Functions runtime and the emulator; it
    // tells the operator WHICH project is missing the secret (dev vs prod).
    const project = process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || "unknown project";
    super(
      `${ANTHROPIC_API_KEY_ENV} is not set for this project (${project}). ` +
        `Deployed: run \`firebase functions:secrets:set ${ANTHROPIC_API_KEY_ENV} --project ${project}\`, ` +
        "make sure the calling function spreads AI_SECRETS into its runWith({ secrets }) " +
        "(src/index.ts), then redeploy (secrets bind at deploy time). " +
        `Local/emulator: add ${ANTHROPIC_API_KEY_ENV} to the gitignored functions/.env.local.`
    );
    this.name = "AnthropicNotConfiguredError";
  }
}

// ============================================
// Client factory (memoised, lazy)
// ============================================

/** The one client per function instance; built on first use. */
let cachedClient: Anthropic | null = null;

/**
 * The shared Anthropic client.
 *
 * First call: reads ANTHROPIC_API_KEY, throws AnthropicNotConfiguredError if
 * it is missing/blank, otherwise loads the SDK and builds the client. Later
 * calls return the same instance (the env is not read again).
 *
 * A missing key is NOT cached: each call re-checks and throws, so a test (or
 * an emulator restart with the key added) is not stuck with a stale failure.
 *
 * Timeouts and retries are left at the SDK defaults here (10 min, 2 retries).
 * Callers running inside a short-lived function should pass a per-request
 * `{ timeout, maxRetries }` that fits their function's own timeout.
 *
 * @throws AnthropicNotConfiguredError when the key is not set.
 */
export function getAnthropicClient(): Anthropic {
  if (cachedClient) return cachedClient;

  // Trimmed: a secret set from a file/pipe often carries a trailing newline,
  // and a whitespace-only value is as good as unset.
  const apiKey = (process.env[ANTHROPIC_API_KEY_ENV] ?? "").trim();
  if (!apiKey) throw new AnthropicNotConfiguredError();

  // Lazy runtime load (see header, point 3). `require` rather than a static
  // import so the SDK's module-load time is only paid by code paths that
  // actually call the model. The package's CommonJS build exposes the client
  // class as both `.default` and `.Anthropic`.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const sdk = require("@anthropic-ai/sdk") as typeof import("@anthropic-ai/sdk");
  const AnthropicClient = sdk.default;

  // `apiKey` is passed explicitly on purpose. Left to its defaults the SDK
  // would also consider ANTHROPIC_AUTH_TOKEN and on-disk profiles; passing the
  // key pins the credential to the one secret this project binds.
  cachedClient = new AnthropicClient({ apiKey });
  return cachedClient;
}

/**
 * Drop the memoised client so the next getAnthropicClient() re-reads the env.
 * For unit tests only (they flip ANTHROPIC_API_KEY between cases).
 */
export function resetAnthropicClientForTests(): void {
  cachedClient = null;
}

// ============================================
// Keeping the key out of logs
// ============================================
//
// How "the key never reaches logs" is guaranteed:
//  - This module never logs. It does not log the client, its options, or env.
//  - The SDK's own logger defaults to `warn`; even at `debug` it redacts the
//    `authorization` / `x-api-key` request headers before printing
//    (node_modules/@anthropic-ai/sdk/internal/utils/log.js).
//  - The SDK's APIError carries the RESPONSE status/headers/body and a request
//    id — not the request headers — so an error object does not hold the key.
//  - Belt and braces, callers log failures through describeAnthropicError()
//    below instead of `console.error(err)`. Same APPROACH as the scraper's
//    describeError() (scrapers/shared/fetch/redact.ts): keep a one-line
//    message plus status/request id, never the raw object, and redact.
//    The scraper helper itself is not imported: it is internal to
//    src/scrapers (ESLint `no-restricted-imports`, src/scrapers/README.md),
//    and its public barrel would drag the whole crawler into every AI caller.
//    The two patterns below mirror it.
//
// Rule for callers: never `console.log` the client or a request options
// object, and never echo request headers from an error handler.

/** `x-api-key: <value>` / `api_key=<value>`-style pairs (case-insensitive). */
const API_KEY_PAIR_PATTERN = /((?:x-api-key|api[_-]?key)\s*[=:]\s*)[^&\s"',;]+/gi;

/** A bearer token (this SDK sends the key as `Authorization: Bearer <key>`). */
const BEARER_PATTERN = /(bearer\s+)[A-Za-z0-9._~+/=-]{6,}/gi;

/**
 * A loggable, secret-free one-line description of an error from an Anthropic
 * call: HTTP status, error type and request id when it is an SDK APIError
 * (read field by field — the error object is never serialised whole), then the
 * message. Bearer tokens and `x-api-key:`-style pairs are redacted, and any
 * literal occurrence of the configured ANTHROPIC_API_KEY is replaced too, in
 * case an upstream/proxy error body ever echoed it back.
 */
export function describeAnthropicError(error: unknown): string {
  const parts: string[] = [];
  if (error && typeof error === "object") {
    // Duck-typed on the documented APIError fields so this helper does not
    // force-load the SDK just to do an `instanceof`.
    const e = error as { status?: unknown; type?: unknown; requestID?: unknown };
    if (typeof e.status === "number") parts.push(`status=${e.status}`);
    if (typeof e.type === "string") parts.push(`type=${e.type}`);
    if (typeof e.requestID === "string") parts.push(`request_id=${e.requestID}`);
  }
  parts.push(error instanceof Error ? error.message : String(error));

  let out = parts.join(" ").replace(API_KEY_PAIR_PATTERN, "$1[REDACTED]").replace(BEARER_PATTERN, "$1[REDACTED]");
  // Literal-value redaction of our own key (same length floor as the scraper
  // helper uses, so a short placeholder value cannot blank out ordinary text).
  const key = (process.env[ANTHROPIC_API_KEY_ENV] ?? "").trim();
  if (key.length >= 6) out = out.split(key).join("[REDACTED]");
  return out;
}
