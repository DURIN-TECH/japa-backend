// ============================================
// Paystack "return to the app" helpers (issue #252)
// ============================================
//
// The mobile app opens Paystack checkout in an in-app auth browser
// (ASWebAuthenticationSession on iOS, a Custom Tab on Android) and waits for
// the browser to navigate to the app's own URL scheme. Paystack can only
// redirect to an https `callback_url`, so the mobile-initiated checkouts point
// Paystack at a small PUBLIC page on this API (`GET /payments/return`), which
// bounces straight on to `durintech://payment-return?reference=<ref>`.
//
// Security model:
//  - The redirect TARGET is fixed in code (`APP_RETURN_URL`). Nothing in the
//    request can change the scheme, host or path, so the page cannot be used
//    as an open redirect.
//  - Only the Paystack reference is forwarded (from `reference`, falling back
//    to Paystack's duplicate `trxref`), validated against a conservative
//    character set and URL-encoded. Every other query param is dropped.
//  - The reference is NOT proof of payment. The app only uses it as an input
//    to the authenticated verify endpoints (`POST /subscriptions/verify`,
//    `POST /payment-requests/:id/verify`), which re-check the transaction with
//    Paystack and the subscriber / request it belongs to. A forged
//    `durintech://payment-return?reference=x` therefore changes nothing.
//
// Portal web flows never send `returnTo`, so they keep their existing
// callbacks (`PAYSTACK_CALLBACK_URL` for subscriptions, the portal
// `/client/payments` page for payment requests).

/**
 * The only accepted value of the optional `returnTo` body field on
 * `POST /subscriptions/checkout` and `PUT /payment-requests/:id/approve`.
 * Sent by the mobile app to opt in to the app return page.
 */
export const RETURN_TO_APP = "app" as const;

/** The parsed `returnTo` option: the app, or the default (web) callback. */
export type ReturnTo = typeof RETURN_TO_APP | undefined;

/**
 * The fixed deep link the return page redirects to. The scheme is the mobile
 * app's `scheme` from `seli-mobile/app.json` (`durintech`). Deliberately a
 * constant: no part of it is ever taken from the request.
 */
export const APP_RETURN_URL = "durintech://payment-return";

/** Path (under the API base) of the public return page. */
export const RETURN_PAGE_PATH = "/payments/return";

/**
 * What a Paystack reference may look like before we forward it. Paystack's
 * own references are alphanumeric; callers that mint their own (e.g. the
 * consultation path) use `-`, `_`, `.` and `=` too. Anything else (spaces,
 * slashes, `?`, `#`, `&`, `:` ...) is refused, and the length is capped, so a
 * crafted value cannot smuggle extra params or a second URL into the deep
 * link even before it is URL-encoded.
 */
const REFERENCE_PATTERN = /^[A-Za-z0-9._=-]{1,100}$/;

/**
 * Parse the optional `returnTo` field of a checkout / approve request body.
 *
 * - absent (`undefined` / `null`) → `{ ok: true, value: undefined }`: keep the
 *   default web callback (portal behaviour unchanged);
 * - exactly `"app"`               → `{ ok: true, value: "app" }`;
 * - anything else                 → `{ ok: false }` so the controller answers
 *   400 rather than silently picking a callback the caller did not ask for.
 */
export function parseReturnTo(raw: unknown): { ok: true; value: ReturnTo } | { ok: false } {
  if (raw === undefined || raw === null) return { ok: true, value: undefined };
  if (raw === RETURN_TO_APP) return { ok: true, value: RETURN_TO_APP };
  return { ok: false };
}

/**
 * The public base URL of THIS deployed API, so the return page URL follows the
 * project it runs in (dev `durin-seli-dev`, prod `japa-platform`) instead of
 * being hard-coded to one of them.
 *
 * Resolution order:
 *  1. `API_PUBLIC_URL` (plain env var, not a secret), when set: an explicit
 *     override, e.g. for an Android emulator that reaches the host on
 *     10.0.2.2. A trailing slash is trimmed. Must be http(s), else ignored.
 *  2. Functions emulator (`FUNCTIONS_EMULATOR === "true"`): the emulator URL,
 *     which carries the project id in its path.
 *  3. Deployed: the `api` function's default URL in `us-central1` (the region
 *     the mobile app's `app.config.ts` already calls).
 *
 * Read from the environment on every call (not cached at import) so tests can
 * vary it and so it always reflects the running project.
 */
export function getApiBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.API_PUBLIC_URL?.trim();
  if (override && /^https?:\/\//i.test(override)) return override.replace(/\/+$/, "");

  const projectId = env.GCLOUD_PROJECT || env.GOOGLE_CLOUD_PROJECT || "";
  if (env.FUNCTIONS_EMULATOR === "true") {
    return `http://127.0.0.1:5001/${projectId}/us-central1/api`;
  }
  return `https://us-central1-${projectId}.cloudfunctions.net/api`;
}

/** The full callback URL handed to Paystack for app-initiated checkouts. */
export function getAppReturnCallbackUrl(env: NodeJS.ProcessEnv = process.env): string {
  return `${getApiBaseUrl(env)}${RETURN_PAGE_PATH}`;
}

/**
 * Pick the callback URL for a checkout: the app return page when the caller
 * opted in with `returnTo: "app"`, else `fallback` (the existing web
 * callback; `undefined` lets the provider use its `PAYSTACK_CALLBACK_URL`).
 */
export function selectCallbackUrl(returnTo: ReturnTo, fallback?: string): string | undefined {
  return returnTo === RETURN_TO_APP ? getAppReturnCallbackUrl() : fallback;
}

/**
 * Read one query value as a string. Express gives arrays for repeated params
 * (`?reference=a&reference=b`) and objects for `a[b]=c`; we take the FIRST
 * plain string and ignore everything else.
 */
function firstString(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  return undefined;
}

/**
 * The validated Paystack reference from the return page's query, or null.
 * Paystack appends both `reference` and `trxref` (same value); `reference`
 * wins, `trxref` is the fallback.
 */
export function extractReference(query: Record<string, unknown>): string | null {
  for (const key of ["reference", "trxref"]) {
    const value = firstString(query[key])?.trim();
    if (value && REFERENCE_PATTERN.test(value)) return value;
  }
  return null;
}

/**
 * Build the deep link the return page redirects to. Always the fixed
 * `APP_RETURN_URL`; `?reference=<url-encoded>` only when a valid reference was
 * present. Without one the app still lands back (its auth session closes) and
 * verifies with the reference it got from the checkout call.
 */
export function buildAppReturnUrl(query: Record<string, unknown>): string {
  const reference = extractReference(query);
  return reference
    ? `${APP_RETURN_URL}?reference=${encodeURIComponent(reference)}`
    : APP_RETURN_URL;
}

/** Escape a string for safe use inside HTML text and double-quoted attributes. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * The HTML fallback body sent with the 302: some in-app browsers show the
 * body instead of following a redirect to a custom scheme, so the user gets a
 * plain "Return to Seli" link to tap. No scripts, no external resources (the
 * response also carries a `default-src 'none'` CSP).
 */
export function renderReturnPage(target: string): string {
  const href = escapeHtml(target);
  return [
    "<!doctype html>",
    "<html lang=\"en\">",
    "<head>",
    "<meta charset=\"utf-8\">",
    "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">",
    "<title>Return to Seli</title>",
    "</head>",
    "<body style=\"font-family:-apple-system,system-ui,sans-serif;text-align:center;padding:48px 16px\">",
    "<p>Payment finished. Taking you back to Seli…</p>",
    `<p><a href="${href}">Return to Seli</a></p>`,
    "</body>",
    "</html>",
  ].join("\n");
}
