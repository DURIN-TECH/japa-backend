import axios, { AxiosInstance } from "axios";
import * as cheerio from "cheerio";
import { createHash } from "crypto";
// Host backoff (issue #64): 429/503 detection + Retry-After parsing live in a
// small pure helper so #15 (Firestore-backed host state) can reuse them.
import { HostBackoffError, backoffDelayMs, isBackoffStatus } from "../etiquette/visa-crawl-host-state";
// PDF support (issue #33): detection, limits and text extraction live in
// pdf-text.ts; this service only routes a PDF response to it.
import { DEFAULT_PDF_LIMITS, PdfFetchError, PdfLimits, PdfText, extractPdfText, isPdfResponse } from "./pdf-text";

// ============================================
// VISA CATALOG — FETCH SERVICE (Step 2)
// ============================================
//
// The deterministic, model-agnostic first half of the visa-catalog pipeline
// (see src/scrapers/visa-catalog/docs/visa-catalog-scraping-spike.md). Its job: given an official visa
// page URL, fetch it politely, strip boilerplate down to readable content text,
// and hash that text so the extractor only ever runs on pages that actually
// changed. No LLM here — this layer is cheap and fully verifiable.
//
// ---- Crawler etiquette & blocking policy (issue #64) ----
//
// Seli's crawler is honest and identifiable: every request carries
// VISA_CATALOG_USER_AGENT, whose URL (https://weareseli.com/bot) explains
// what we fetch, how often, and how to ask us to stop. On top of that:
//
//  - robots.txt is respected (isAllowedByRobots, fail-open if unreadable);
//  - requests to one host are spaced by PER_HOST_MIN_INTERVAL_MS;
//  - a 429 or 503 from a host (on a page, an API call OR robots.txt) throws a
//    HostBackoffError carrying the host's `Retry-After` (seconds or HTTP-date,
//    clamped; a default when absent). The crawl then stops requesting that
//    host for the rest of the run, records the retry-after time so the next
//    scheduled run does not hit it earlier, and counts the run as a failure
//    toward the source's auto-pause (see visa-catalog-crawl.service.ts).
//
// ---- PDFs (issue #33) ----
//
// Official guidance is often a PDF. `fetchAndClean()` reads PDFs through the
// SAME request path as HTML (one GET, same User-Agent, robots.txt check,
// per-host gap and 429/503 backoff): the response is opened as a stream, its
// headers decide whether it is a PDF (`isPdfResponse`: `application/pdf`, or
// a generic content type on a `.pdf` URL), and only then is the body read,
// as bytes, under the size cap for its kind. PDF bytes go to
// `extractPdfText()` (pdf-text.ts: magic-byte check, isolated parse with a
// timeout, page and text caps, no OCR); HTML bytes are decoded and cleaned
// exactly as before. The result is hashed the same way either way, so an
// unchanged PDF is skipped by the crawl's hash gate like an unchanged page.
// Nothing here names a country, route or publisher.
//
// We NEVER rotate IP addresses, use proxies / residential IP pools, spoof
// or rotate the User-Agent, or otherwise disguise the crawler to get around a
// block, a rate limit or a robots.txt rule. A host that blocks or throttles us
// is handled by backing off and, if it persists, by contacting the site owner
// (and pausing the source) — never by evading it. Do not add any such
// mechanism here or in an adapter.

// Elements that are chrome/boilerplate, not visa content — removed before we
// read text so the extractor sees signal, not nav bars and cookie banners.
const BOILERPLATE_SELECTORS = [
  "script",
  "style",
  "noscript",
  "svg",
  "iframe",
  "nav",
  "header",
  "footer",
  "aside",
  "form",
  "[role='navigation']",
  "[role='banner']",
  "[role='contentinfo']",
  ".cookie",
  ".cookies",
  ".breadcrumb",
  ".breadcrumbs",
  ".skip-link",
];

// Prefer the true content region if the page marks one; fall back to <body>.
const MAIN_CONTENT_SELECTORS = ["main", "article", "[role='main']", "#content", ".content"];

// Cap the cleaned text handed downstream. ~24k chars ≈ 6–8k tokens — enough for
// a single visa page, and it bounds extraction cost + latency.
// Applies to the `generic-html` path only; structured adapters (e.g. the GOV.UK
// Content API adapter) have their own, separate cap.
// It does NOT apply to PDFs (issue #33): a long guidance PDF would lose most
// of its text to this slice. PDFs have their own cap, which fails the fetch
// instead of truncating (DEFAULT_PDF_LIMITS.maxTextChars in pdf-text.ts).
export const MAX_CLEAN_TEXT_CHARS = 24_000;

// Largest HTML response body accepted, in bytes. The same 5MB the client has
// always allowed (`maxContentLength`); named because `fetchAndClean()` now
// reads the body itself (as a stream, issue #33) and so enforces it itself.
export const MAX_HTML_BYTES = 5 * 1024 * 1024;

// Overall time allowed for reading one response body once its headers have
// arrived, in ms. The client's 15s timeout only covers socket inactivity, so
// without this a server drip-feeding a large PDF could hold a crawl open.
export const DEFAULT_BODY_TIMEOUT_MS = 60_000;

// Longest silence allowed BETWEEN two chunks of a response body, in ms: the
// same 15s the client's timeout gave a stalled download before bodies were
// streamed. A body that stops arriving is dropped after this, well before the
// overall deadline above.
export const DEFAULT_BODY_IDLE_TIMEOUT_MS = 15_000;

// Minimum gap between two requests to the SAME host, so we never hammer a
// government site. Different hosts are unaffected.
export const PER_HOST_MIN_INTERVAL_MS = 1_500;

// Honest, identifiable bot User-Agent shared by every visa-catalog request
// (HTML pages, robots.txt and the GOV.UK Content API alike).
export const VISA_CATALOG_USER_AGENT = "Seli-VisaCatalogBot/1.0 (+https://weareseli.com/bot)";

// How long a host's parsed robots.txt is trusted before it is re-read: 24h
// (RFC 9309 §2.4: crawlers SHOULD NOT use a cached copy for more than 24
// hours). Without a TTL a warm Cloud Functions instance would keep a stale
// copy for its whole lifetime and miss a newly added Disallow.
export const ROBOTS_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * True when a robots.txt `User-agent` value names US. RFC 9309 matches the
 * product token case-insensitively; we also accept any token containing
 * "seli" (the historic, lenient rule) so a site writing `User-agent: Seli`
 * or `SeliBot` is honoured too. `*` is NOT a match here (it is the fallback
 * group, handled separately).
 */
export function robotsAgentMatchesUs(agent: string): boolean {
  const a = agent.trim().toLowerCase();
  return a !== "*" && a.includes("seli");
}

/**
 * Parse robots.txt into the Disallow path prefixes that apply to our crawler,
 * following RFC 9309 group rules:
 *
 *  - A GROUP is one or more consecutive `User-agent:` lines followed by its
 *    rule lines (`Allow:` / `Disallow:`). The first rule line ends the agent
 *    list; the next `User-agent:` after a rule starts a NEW group. So in
 *      User-agent: OtherBot
 *      User-agent: Seli-VisaCatalogBot
 *      Disallow: /
 *    the Disallow applies to BOTH agents (the old parser reset on each
 *    `User-agent:` line and lost it when we were not listed last).
 *  - If any group names our agent, ONLY those groups apply (merged, if there
 *    are several), and the `*` group is ignored — the specific group wins.
 *  - Otherwise the `*` group(s) apply; with neither, nothing is disallowed.
 *  - Other lines (Sitemap, Crawl-delay, unknown) are ignored and do not end
 *    a group's agent list. An empty `Disallow:` disallows nothing.
 *
 * Simplification (unchanged from before): `Allow:` lines are not evaluated
 * (no longest-match allow-vs-disallow), so an Allow inside a disallowed tree
 * is still treated as disallowed — the conservative side for a crawler.
 */
export function parseRobotsDisallows(text: string): string[] {
  /** One robots.txt group: its user-agents and its Disallow values. */
  interface Group {
    agents: string[];
    disallows: string[];
  }
  const groups: Group[] = [];
  let current: Group | undefined;
  // True once the current group has seen a rule line (its agent list is closed).
  let inRules = false;

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.split("#")[0].trim();
    if (!line) continue;
    const colon = line.indexOf(":");
    if (colon < 0) continue; // not a "field: value" line
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();

    if (key === "user-agent") {
      // A user-agent after rules (or the very first one) opens a new group;
      // consecutive user-agent lines extend the current group's agent list.
      if (!current || inRules) {
        current = { agents: [], disallows: [] };
        groups.push(current);
        inRules = false;
      }
      current.agents.push(value);
    } else if (key === "allow" || key === "disallow") {
      // Rules before any user-agent line belong to no group: ignored.
      if (!current) continue;
      inRules = true;
      if (key === "disallow" && value) current.disallows.push(value);
    }
  }

  // Specific groups (naming us) win; else the `*` fallback; else nothing.
  const ours = groups.filter((g) => g.agents.some(robotsAgentMatchesUs));
  const chosen = ours.length > 0 ? ours : groups.filter((g) => g.agents.some((a) => a.trim() === "*"));
  return chosen.flatMap((g) => g.disallows);
}

// Block-level elements that get a trailing newline before text is read, so
// headings/paragraphs/list items don't run together (see blockText()).
const BLOCK_SELECTORS = "p,h1,h2,h3,h4,h5,h6,li,br,div,section,article,tr,td,dt,dd";

/**
 * Minimal HTTP surface the fetch service needs from its client. An
 * `AxiosInstance` satisfies it; tests inject a stub with the same `get` shape
 * so `npm test` never touches the network.
 */
export interface VisaCatalogHttpClient {
  get(
    url: string,
    // `timeout` (ms, issue #107): a per-request override of the client's
    // default timeout (axios honours it; test stubs may ignore it).
    // `responseType: "stream"` (issue #33): `data` is then a Node Readable
    // of the body, so the caller can look at the headers first and cap the
    // download per content kind. Test stubs may ignore it and return a string
    // or a Buffer; `fetchAndClean()` accepts all three.
    // `maxContentLength` (bytes): per-request override of the client's
    // response-size limit (axios honours it for buffered responses).
    config?: {
      responseType?: "text" | "stream";
      headers?: Record<string, string>;
      timeout?: number;
      maxContentLength?: number;
    }
  ): Promise<{
    status: number;
    data: unknown;
    headers?: unknown;
    // Axios exposes the post-redirect URL at request.res.responseUrl (Node).
    request?: { res?: { responseUrl?: string } };
  }>;
}

/** Constructor options — all optional; defaults are the production values. */
export interface VisaCatalogFetchServiceOptions {
  // Inject an HTTP client (tests). Default: an axios instance with our UA.
  http?: VisaCatalogHttpClient;
  // Per-host politeness gap in ms. Default PER_HOST_MIN_INTERVAL_MS (1.5s);
  // tests lower it so they don't sleep.
  minIntervalMs?: number;
  // Clock (epoch ms) used to turn `Retry-After` into an instant (issue #64)
  // and to age the robots.txt cache. Default Date.now; tests inject a fixed
  // (or advancing) clock so HTTP-dates and the TTL are exact.
  clock?: () => number;
  // PDF limits (issue #33): byte cap, page cap, text cap, parse timeout and
  // parser memory. Any subset; the rest come from DEFAULT_PDF_LIMITS
  // (20 MB / 500 pages / 1,000,000 chars / 30 s / 160 MB of memory growth).
  pdf?: Partial<PdfLimits>;
  // Overall time allowed to read one response body, in ms. Default
  // DEFAULT_BODY_TIMEOUT_MS (60s); tests lower it.
  bodyTimeoutMs?: number;
  // Longest gap allowed between two chunks of a body, in ms. Default
  // DEFAULT_BODY_IDLE_TIMEOUT_MS (15s); tests lower it.
  bodyIdleTimeoutMs?: number;
}

/** Raw HTTP response handed to adapters by `getRaw()`. */
export interface RawResponse {
  status: number; // HTTP status (non-2xx is returned, not thrown)
  body: string; // response body as text (never parsed here)
  finalUrl: string; // URL after redirects
  contentType: string; // Content-Type header ("" when absent)
}

// `AnyNode` is domhandler's node union. domhandler is only a transitive
// dependency (via cheerio), so rather than import it directly we recover the
// type from `cheerio.load`'s first parameter (string | AnyNode | AnyNode[] | Buffer).
type AnyNode = Exclude<Parameters<typeof cheerio.load>[0], string | Buffer | unknown[]>;

/**
 * Shared HTML-to-text step: give every block element a trailing newline, read
 * the text, and normalise whitespace. Used by BOTH `htmlToCleanText()` (whole
 * pages, generic-html adapter) and the GOV.UK adapter (one guide part body at a
 * time), so the two paths produce text the same way. Takes the cheerio
 * selection to read; does NOT cap length (callers own their caps).
 *
 * NOTE: mutates the selection (appends "\n" to block elements) — callers pass
 * a freshly loaded document.
 */
export function blockText(root: cheerio.Cheerio<AnyNode>): string {
  // Insert line breaks between block elements — cheerio's `.text()` concatenates
  // with no separator, which would run headings/paragraphs/list-items together
  // into one blob ("visaYou can apply…"). Appending a newline to each block keeps
  // the structure legible for the extractor.
  root.find(BLOCK_SELECTORS).append("\n");

  // Normalise: collapse runs of spaces, collapse blank-line runs, trim.
  return root
    .text()
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Convert an HTML FRAGMENT (e.g. one GOV.UK guide part's `body`) to plain text
 * with the shared block-newline logic. No boilerplate stripping or main-region
 * picking — a fragment is already just content.
 */
export function htmlFragmentToText(html: string, options: FragmentTextOptions = {}): string {
  const $ = cheerio.load(html);
  // ---- Optional link rendering (issue #74) ----
  // By default links are read as their text only (href dropped) — exactly the
  // pre-#74 output. When a caller passes `renderLinkUrl`, each <a href> is
  // resolved against `baseUrl` and, if the predicate returns a URL string, the
  // anchor's text becomes `text (url)`. Only the GOV.UK adapter opts in; the
  // generic-html path never calls this function, so its text + hash are
  // unchanged (#58 guarantee).
  if (options.renderLinkUrl) {
    const render = options.renderLinkUrl;
    $("a[href]").each((_, el) => {
      const a = $(el);
      const href = (a.attr("href") ?? "").trim();
      if (!href) return;
      // Resolve relative hrefs ("/apply", "apply") against the base; an
      // unparseable href is simply left as plain text.
      let absolute: string;
      try {
        absolute = new URL(href, options.baseUrl).toString();
      } catch {
        return;
      }
      const url = render(absolute);
      if (!url) return;
      // Don't duplicate when the anchor text already IS the URL — compared
      // against the raw href AND the normalised URL, each with and without a
      // trailing slash ("https://x.gov.uk" vs "https://x.gov.uk/").
      const text = a.text().trim();
      const noSlash = (u: string) => u.replace(/\/+$/, "");
      const same = [href, absolute, url].some((u) => noSlash(u) === noSlash(text));
      if (same) return;
      // Append as a TEXT node, never as HTML: appending a string to cheerio
      // parses it as markup, so entities in a query string would be decoded
      // ("&param=" → "¶m=", "&copy=" → "©="). `.text()` sets literal text.
      a.append($("<span>").text(` (${url})`));
    });
  }
  // cheerio wraps a fragment in <html><body>; read from <body>.
  return blockText($("body"));
}

/** Options for `htmlFragmentToText` (all optional; none → pre-#74 output). */
export interface FragmentTextOptions {
  // Base URL relative hrefs are resolved against (e.g. "https://www.gov.uk").
  baseUrl?: string;
  // Given a link's ABSOLUTE url, return the URL to print after the link text
  // (`text (url)`), or undefined to keep the link as plain text.
  renderLinkUrl?: (absoluteUrl: string) => string | undefined;
}

export interface FetchedPage {
  url: string; // the URL requested
  finalUrl: string; // after redirects
  httpStatus: number;
  cleanText: string; // boilerplate-stripped, whitespace-normalised, capped
  contentHash: string; // sha256 of cleanText — the change-detection key
  fetchedAt: number; // epoch ms (caller stamps Firestore Timestamp)
  // Present ONLY when the response was a PDF (issue #33); absent for HTML, so
  // HTML results are exactly what they were. Holds the per-page text and the
  // page offsets into `cleanText` (pages are joined with a form feed), so a
  // later stage can cite the page a quote is on: see `pdfPageAtOffset` and
  // `findPdfQuote` in pdf-text.ts. For a PDF, `cleanText` is NOT capped at
  // MAX_CLEAN_TEXT_CHARS and is never truncated.
  pdf?: PdfText;
}

/**
 * Body of a response as the HTTP client may hand it over: a Node stream (the
 * real client, `responseType: "stream"`), or already-read bytes / text (test
 * stubs, which ignore `responseType`).
 */
type ResponseBody = NodeJS.ReadableStream | Buffer | Uint8Array | ArrayBuffer | string | null | undefined;

/** A readable stream that can also be destroyed (every Node Readable can). */
type DestroyableStream = NodeJS.ReadableStream & { destroy?: (err?: Error) => void };

/** True when `data` is a readable stream (has `.on` and is async-iterable). */
function isReadableStream(data: unknown): data is DestroyableStream {
  return (
    typeof data === "object" &&
    data !== null &&
    typeof (data as { on?: unknown }).on === "function" &&
    typeof (data as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === "function"
  );
}

/**
 * Stop a response we are not going to read (throttled, error status, too
 * large), so the socket is released instead of left waiting on a body.
 */
function discardBody(data: unknown): void {
  if (isReadableStream(data) && typeof data.destroy === "function") data.destroy();
}

/**
 * Decode an HTML body to text the way the client did when it was asked for
 * `responseType: "text"`: UTF-8, with a leading byte-order mark removed. A
 * body that is already a string (stubs) is returned untouched, so cleaned
 * text and hashes are identical to the pre-#33 path.
 */
function decodeHtmlBody(body: Buffer | string): string {
  if (typeof body === "string") return body;
  const text = body.toString("utf8");
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * Fetches + cleans official visa pages. Stateless w.r.t. Firestore; the crawl
 * orchestrator (Step 5) owns persistence and the content-hash comparison.
 */
export class VisaCatalogFetchService {
  // The ONE HTTP client for every visa-catalog request (pages, robots.txt and
  // structured adapters such as the GOV.UK Content API go through it).
  private readonly http: VisaCatalogHttpClient;
  // Per-host politeness gap (ms); PER_HOST_MIN_INTERVAL_MS unless overridden.
  private readonly minIntervalMs: number;
  // Last-request time per host, for polite per-host rate limiting.
  private readonly lastRequestByHost = new Map<string, number>();
  // Cached robots.txt disallow rules per host (null = fetch failed / none),
  // with the time they were read; entries older than ROBOTS_CACHE_TTL_MS are
  // re-fetched (see isAllowedByRobots).
  private readonly robotsCache = new Map<string, { disallows: string[] | null; fetchedAt: number }>();
  // Clock for Retry-After maths and the robots cache TTL (see options.clock).
  private readonly clock: () => number;
  // PDF caps and parse budget (issue #33): the defaults with any overrides.
  private readonly pdfLimits: PdfLimits;
  // Overall budget for reading one response body (ms).
  private readonly bodyTimeoutMs: number;
  // Longest gap between two chunks of a response body (ms).
  private readonly bodyIdleTimeoutMs: number;

  constructor(options: VisaCatalogFetchServiceOptions = {}) {
    this.minIntervalMs = options.minIntervalMs ?? PER_HOST_MIN_INTERVAL_MS;
    this.http = options.http ?? VisaCatalogFetchService.createDefaultClient();
    this.clock = options.clock ?? Date.now;
    this.pdfLimits = { ...DEFAULT_PDF_LIMITS, ...(options.pdf ?? {}) };
    this.bodyTimeoutMs = options.bodyTimeoutMs ?? DEFAULT_BODY_TIMEOUT_MS;
    this.bodyIdleTimeoutMs = options.bodyIdleTimeoutMs ?? DEFAULT_BODY_IDLE_TIMEOUT_MS;
  }

  /**
   * Back off on 429/503 (issue #64): if `status` asks us to slow down, throw a
   * HostBackoffError for `host` whose `untilMs` comes from the response's
   * `Retry-After` header (delta-seconds or HTTP-date, clamped to
   * MAX_BACKOFF_MS; DEFAULT_BACKOFF_MS when missing/garbage). Every request
   * path (pages, getRaw for adapters, robots.txt) calls this right after the
   * response arrives, so no caller can accidentally treat a throttle as an
   * ordinary error and keep hammering the host. Other statuses return.
   *
   * Redirects: axios follows them, so a 429/503 may come from ANOTHER host
   * than the one requested. The error's `host` is the FINAL host (the one
   * that throttled us), read from `request.res.responseUrl`; `requestedHost`
   * is the one we asked. responseUrl is only populated by axios's Node http
   * adapter (follow-redirects) — stubs and other adapters may omit it — so
   * when it is missing we fall back to the requested host. Callers record the
   * backoff against BOTH hosts (see the orchestrator), so a missing
   * responseUrl can never let us keep hitting the throttling host.
   */
  private assertNotThrottled(
    requestedUrl: string,
    resp: Awaited<ReturnType<VisaCatalogHttpClient["get"]>>
  ): void {
    if (!isBackoffStatus(resp.status)) return;
    const requestedHost = this.hostOf(requestedUrl);
    const finalHost = this.hostOf(resp.request?.res?.responseUrl ?? "") || requestedHost;
    // Header lookup: axios lowercases header names; tolerate plain objects
    // (test stubs) that use the canonical casing.
    const hdrs = (resp.headers ?? {}) as Record<string, unknown>;
    const retryAfter = hdrs["retry-after"] ?? hdrs["Retry-After"];
    const now = this.clock();
    throw new HostBackoffError({
      host: finalHost,
      requestedHost,
      status: resp.status,
      untilMs: now + backoffDelayMs(retryAfter, now),
    });
  }

  /** Production axios client (the shape used before adapters existed). */
  private static createDefaultClient(): AxiosInstance {
    // Mirrors the news scraper's client: identifies our bot, bounds time + size.
    return axios.create({
      timeout: 15_000,
      headers: {
        "User-Agent": VISA_CATALOG_USER_AGENT,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5",
      },
      maxRedirects: 5,
      maxContentLength: MAX_HTML_BYTES, // 5MB
      // We handle non-2xx ourselves (some sites 403 bots) rather than throwing.
      validateStatus: () => true,
    });
  }

  /** Small sleep helper for per-host politeness delays. */
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /** Host of a URL, lowercased ("" if unparseable). */
  private hostOf(url: string): string {
    try {
      return new URL(url).host.toLowerCase();
    } catch {
      return "";
    }
  }

  /**
   * Enforce the per-host minimum interval: if we hit `host` too recently, wait
   * out the remainder before proceeding. Records the (post-wait) request time.
   */
  private async rateLimit(host: string): Promise<void> {
    const last = this.lastRequestByHost.get(host);
    if (last !== undefined) {
      const wait = this.minIntervalMs - (Date.now() - last);
      if (wait > 0) await this.delay(wait);
    }
    this.lastRequestByHost.set(host, Date.now());
  }

  /**
   * Best-effort robots.txt check for our user-agent. Fetches (and caches) the
   * host's robots.txt and returns false if any `Disallow` rule (under `*` or our
   * agent) prefixes the target path. Fail-open: if robots.txt can't be read we
   * proceed, which is the conventional crawler behaviour — EXCEPT a 429/503 on
   * robots.txt, which throws HostBackoffError (issue #64): a host that is
   * throttling us must not then get the page request too. Nothing is cached
   * in that case, so a later run re-reads robots.txt.
   */
  async isAllowedByRobots(url: string): Promise<boolean> {
    const host = this.hostOf(url);
    if (!host) return false;

    // Use the cached copy only while it is younger than ROBOTS_CACHE_TTL_MS;
    // otherwise (or on a miss) re-read robots.txt.
    const cached = this.robotsCache.get(host);
    let disallows: string[] | null;
    if (cached && this.clock() - cached.fetchedAt < ROBOTS_CACHE_TTL_MS) {
      disallows = cached.disallows;
    } else {
      // May throw HostBackoffError (429/503 on robots.txt) — left uncached
      // (an expired entry stays expired, so the next check retries).
      disallows = await this.loadRobots(url);
      this.robotsCache.set(host, { disallows, fetchedAt: this.clock() });
    }
    if (!disallows || disallows.length === 0) return true;

    let path = "/";
    try {
      path = new URL(url).pathname || "/";
    } catch {
      return true;
    }
    // Disallowed if the path starts with any disallow prefix.
    return !disallows.some((rule) => rule && path.startsWith(rule));
  }

  /**
   * Fetch robots.txt and parse it (parseRobotsDisallows: RFC 9309 groups;
   * our specific group wins over `*`) into the Disallow prefixes that apply
   * to us. null when it can't be read (fail-open).
   */
  private async loadRobots(url: string): Promise<string[] | null> {
    try {
      const origin = new URL(url).origin;
      const host = this.hostOf(url);
      await this.rateLimit(host);
      const robotsUrl = `${origin}/robots.txt`;
      const resp = await this.http.get(robotsUrl, { responseType: "text" });
      // 429/503 -> HostBackoffError, rethrown by the catch below (NOT fail-open).
      this.assertNotThrottled(robotsUrl, resp);
      if (resp.status >= 400 || typeof resp.data !== "string") return null;
      return parseRobotsDisallows(resp.data);
    } catch (err) {
      // A throttle is not "robots unreadable": propagate it so the crawl
      // backs off instead of going on to request the page.
      if (err instanceof HostBackoffError) throw err;
      return null; // fail-open
    }
  }

  /**
   * Rate-limited GET through the shared client, for adapters that need the raw
   * response (e.g. the GOV.UK Content API adapter). Waits out the per-host gap
   * first, sends our UA (client default) plus any extra `headers` (such as
   * `Accept: application/json`), and returns status/body/final URL WITHOUT
   * throwing on non-2xx — the adapter decides what is an error. The ONE
   * exception is 429/503, which throws HostBackoffError (issue #64) so every
   * adapter backs off the same way. Robots is NOT checked here; call
   * `isAllowedByRobots()` first (as fetchAndClean does).
   *
   * Keeping this the only way adapters reach the network means the rate limit,
   * robots cache and client live in one place (#15 can swap them here).
   */
  async getRaw(url: string, headers?: Record<string, string>, opts?: { timeoutMs?: number }): Promise<RawResponse> {
    const host = this.hostOf(url);
    await this.rateLimit(host);
    // Issue #107: `opts.timeoutMs` overrides the client timeout for this
    // request only (a slow news feed, e.g. cic-news). Omitted = client default.
    const resp = await this.http.get(url, {
      responseType: "text",
      headers,
      ...(opts?.timeoutMs ? { timeout: opts.timeoutMs } : {}),
    });
    // 429/503 -> HostBackoffError (Retry-After honoured by the crawl).
    this.assertNotThrottled(url, resp);
    const finalUrl = resp.request?.res?.responseUrl || url;
    const body = typeof resp.data === "string" ? resp.data : String(resp.data ?? "");
    // Header lookup is case-insensitive in axios; tolerate plain objects (stubs).
    const hdrs = (resp.headers ?? {}) as Record<string, unknown>;
    const contentType = String(hdrs["content-type"] ?? hdrs["Content-Type"] ?? "");
    return { status: resp.status, body, finalUrl, contentType };
  }

  /**
   * Fetch one URL's body (rate-limited, redirect-following) and say what it
   * is. The ONE request path for pages, HTML and PDF alike (issue #33):
   *
   *  1. wait out the per-host gap, then GET the URL as a STREAM, so the
   *     headers can be inspected before any of the body is read;
   *  2. 429/503 throws HostBackoffError (issue #64), any other non-2xx throws
   *     "Fetch failed … (HTTP n)"; the unread body is discarded either way;
   *  3. the headers decide the kind (`isPdfResponse`) and therefore the byte
   *     cap: `pdfLimits.maxBytes` for a PDF, MAX_HTML_BYTES otherwise;
   *  4. the body is read as bytes under that cap (see readBody).
   *
   * `acceptPdf: false` refuses a PDF at step 3, before any of its body is
   * downloaded (PdfFetchError "not-accepted").
   *
   * Returns the bytes (or the string a test stub supplied) with the kind,
   * status and final URL.
   */
  private async fetchBody(
    url: string,
    acceptPdf: boolean
  ): Promise<{ kind: "html" | "pdf"; body: Buffer | string; status: number; finalUrl: string }> {
    const host = this.hostOf(url);
    await this.rateLimit(host);
    const resp = await this.http.get(url, {
      responseType: "stream",
      // The larger of the two caps: if the client enforces a size limit of
      // its own, it must not cut a PDF off at the HTML limit. The cap for the
      // actual kind is enforced below, while reading.
      maxContentLength: Math.max(MAX_HTML_BYTES, this.pdfLimits.maxBytes),
    });
    const data = resp.data as ResponseBody;

    // 429/503 -> HostBackoffError (Retry-After honoured by the crawl).
    try {
      this.assertNotThrottled(url, resp);
    } catch (err) {
      discardBody(data);
      throw err;
    }
    const finalUrl = resp.request?.res?.responseUrl || url;

    // Any other error status: same message as before PDFs existed. This is
    // also what an HTML 404 page served as `application/pdf` ends in.
    if (resp.status < 200 || resp.status >= 300) {
      discardBody(data);
      throw new Error(`Fetch failed for ${url} (HTTP ${resp.status})`);
    }

    // Header lookup: axios lowercases header names; tolerate plain objects
    // (test stubs) that use the canonical casing.
    const hdrs = (resp.headers ?? {}) as Record<string, unknown>;
    const contentType = String(hdrs["content-type"] ?? hdrs["Content-Type"] ?? "");
    const declaredLength = Number(hdrs["content-length"] ?? hdrs["Content-Length"]);
    const kind: "html" | "pdf" = isPdfResponse(contentType, url, finalUrl) ? "pdf" : "html";
    const maxBytes = kind === "pdf" ? this.pdfLimits.maxBytes : MAX_HTML_BYTES;

    // The caller does not take PDFs: refuse now, on the headers alone, so the
    // document is neither downloaded nor parsed.
    if (kind === "pdf" && !acceptPdf) {
      discardBody(data);
      const err = new PdfFetchError(
        "not-accepted",
        `PDF not accepted for ${url}: the response is a PDF (${contentType || "no content type"}) ` +
          "and this caller reads web pages only; nothing was downloaded"
      );
      console.warn(`Visa catalog fetch: PDF rejected (${err.reason}): ${err.message}`);
      throw err;
    }

    /** The "over the cap" error for this response's kind. */
    const tooLarge = (bytes: number, how: string): Error => {
      if (kind !== "pdf") {
        return new Error(`Response too large for ${url}: ${how} ${bytes} bytes exceeds the ${maxBytes}-byte cap`);
      }
      const err = new PdfFetchError(
        "too-large",
        `PDF too large for ${url}: ${how} ${bytes} bytes exceeds the ${maxBytes}-byte cap`,
        { byteLength: bytes, maxBytes }
      );
      // Logged here because this refusal happens before extraction, where
      // the other PDF refusals are logged (see fetchAndClean).
      console.warn(`Visa catalog fetch: PDF rejected (${err.reason}): ${err.message}`);
      return err;
    };

    // Refuse on the declared size alone, before downloading anything.
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      discardBody(data);
      throw tooLarge(declaredLength, "Content-Length of");
    }

    const body = await this.readBody(data, maxBytes, url, tooLarge);
    return { kind, body, status: resp.status, finalUrl };
  }

  /**
   * Read a response body under a byte cap.
   *
   *  - A stream (the real client) is read chunk by chunk; the moment the
   *    running total passes `maxBytes` the stream is destroyed and the fetch
   *    fails, so an oversized (or mis-declared) body is never held in memory.
   *    Two timers bound the read: `bodyIdleTimeoutMs` between chunks (a
   *    stalled download) and `bodyTimeoutMs` overall (a drip-fed one).
   *  - Bytes or a string already in hand (test stubs) are only measured.
   */
  private async readBody(
    data: ResponseBody,
    maxBytes: number,
    url: string,
    tooLarge: (bytes: number, how: string) => Error
  ): Promise<Buffer | string> {
    if (data === null || data === undefined) return "";

    // Already read (stubs): just apply the cap.
    if (typeof data === "string") {
      const size = Buffer.byteLength(data, "utf8");
      if (size > maxBytes) throw tooLarge(size, "received");
      return data;
    }
    if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
      // Buffer and Uint8Array are both views; wrap without copying.
      const buf =
        data instanceof ArrayBuffer ? Buffer.from(data) : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
      if (buf.byteLength > maxBytes) throw tooLarge(buf.byteLength, "received");
      return buf;
    }
    if (!isReadableStream(data)) return String(data);

    // Stream: count while downloading.
    const stream: DestroyableStream = data;
    const chunks: Buffer[] = [];
    let total = 0;
    // Overall deadline for the body: destroying the stream with an error
    // ends the loop below with that error.
    const timer = setTimeout(() => {
      stream.destroy?.(new Error(`Timed out reading the response body for ${url} after ${this.bodyTimeoutMs} ms`));
    }, this.bodyTimeoutMs);
    // Inactivity timer: restarted on every chunk, so it only fires when the
    // body has gone quiet for `bodyIdleTimeoutMs`.
    let idleTimer: NodeJS.Timeout | undefined;
    const restartIdleTimer = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        stream.destroy?.(
          new Error(`Response body stalled for ${url}: no data for ${this.bodyIdleTimeoutMs} ms after ${total} bytes`)
        );
      }, this.bodyIdleTimeoutMs);
    };
    restartIdleTimer();
    try {
      for await (const chunk of stream) {
        restartIdleTimer();
        const buf = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : Buffer.from(chunk);
        total += buf.byteLength;
        if (total > maxBytes) {
          // Stop the download now; do not keep what was read.
          stream.destroy?.();
          throw tooLarge(total, "received more than");
        }
        chunks.push(buf);
      }
    } finally {
      clearTimeout(timer);
      clearTimeout(idleTimer);
    }
    return Buffer.concat(chunks, total);
  }

  /**
   * Reduce raw HTML to clean, readable content text: drop boilerplate elements,
   * pick the main content region, collapse whitespace, and cap length. This is
   * what gets hashed and (later) handed to the extractor.
   */
  htmlToCleanText(html: string): string {
    const $ = cheerio.load(html);
    // Remove chrome/boilerplate outright.
    $(BOILERPLATE_SELECTORS.join(",")).remove();

    // Prefer a semantic main-content region; fall back to <body>.
    let root = $("body");
    for (const sel of MAIN_CONTENT_SELECTORS) {
      const el = $(sel).first();
      if (el.length && el.text().trim().length > 200) {
        // Cast: `.first()` on a selector widens the node type; we only read text.
        root = el as typeof root;
        break;
      }
    }

    // Block newlines + whitespace normalisation (shared with the GOV.UK
    // adapter's per-part conversion), then the generic-html cap.
    const text = blockText(root);
    return text.length > MAX_CLEAN_TEXT_CHARS ? text.slice(0, MAX_CLEAN_TEXT_CHARS) : text;
  }

  /** SHA-256 of arbitrary text — the content-change key. */
  hash(text: string): string {
    return createHash("sha256").update(text).digest("hex");
  }

  /**
   * The one call the orchestrator uses: fetch a URL, clean it, and hash it.
   * Throws on network failure or a non-2xx status (so the caller records a
   * source failure) — a HostBackoffError for 429/503, from robots.txt or the
   * page itself; returns the cleaned + hashed page on success.
   *
   * Handles PDFs too (issue #33): when the response is a PDF the result's
   * `cleanText` is the document's text with pages joined by a form feed,
   * `pdf` carries the per-page text, and a PDF that cannot be read throws a
   * `PdfFetchError` whose `reason` says why (see pdf-text.ts).
   */
  async fetchAndClean(
    url: string,
    // checkRobots: check robots.txt first (throws when disallowed).
    // acceptPdf (default true): pass false to refuse a PDF response outright,
    // with PdfFetchError "not-accepted" and without downloading it; for
    // callers that can only use a web page's text.
    options?: { checkRobots?: boolean; acceptPdf?: boolean }
  ): Promise<FetchedPage> {
    if (options?.checkRobots) {
      const allowed = await this.isAllowedByRobots(url);
      if (!allowed) {
        throw new Error(`Blocked by robots.txt: ${url}`);
      }
    }

    // One request for both kinds; a non-2xx status has already thrown
    // "Fetch failed for … (HTTP n)" inside fetchBody.
    const { kind, body, status, finalUrl } = await this.fetchBody(url, options?.acceptPdf ?? true);

    // ---- PDF (issue #33) ----
    // Extract the text layer per page. Every refusal (not a PDF, encrypted,
    // malformed, too many pages, too much text, no text layer, parse
    // timeout, too much memory) is a PdfFetchError with a reason; it is logged here and
    // rethrown so the caller records a source failure, exactly as for a
    // failed HTML fetch. Nothing is truncated and empty text is never
    // returned as a success.
    if (kind === "pdf") {
      // A stub may hand a PDF over as a binary string; latin1 keeps its bytes.
      const bytes = typeof body === "string" ? Buffer.from(body, "latin1") : body;
      let pdf: PdfText;
      try {
        pdf = await extractPdfText(bytes, url, this.pdfLimits);
      } catch (err) {
        if (err instanceof PdfFetchError) {
          console.warn(`Visa catalog fetch: PDF rejected (${err.reason}): ${err.message}`);
        }
        throw err;
      }
      return {
        url,
        finalUrl,
        httpStatus: status,
        // Pages joined with a form feed; NOT subject to MAX_CLEAN_TEXT_CHARS.
        cleanText: pdf.cleanText,
        // Same change-detection key as HTML: sha256 of the clean text.
        contentHash: this.hash(pdf.cleanText),
        fetchedAt: Date.now(),
        pdf,
      };
    }

    // ---- HTML (unchanged) ----
    const html = decodeHtmlBody(body);
    const cleanText = this.htmlToCleanText(html);
    if (cleanText.length < 100) {
      // Almost no readable content — likely JS-rendered or a block page. Flag it
      // rather than feeding an empty page to the extractor.
      throw new Error(`Too little content extracted from ${url} (${cleanText.length} chars)`);
    }

    return {
      url,
      finalUrl,
      httpStatus: status,
      cleanText,
      contentHash: this.hash(cleanText),
      fetchedAt: Date.now(),
    };
  }
}

// Singleton — mirrors the other services in this codebase.
export const visaCatalogFetchService = new VisaCatalogFetchService();
