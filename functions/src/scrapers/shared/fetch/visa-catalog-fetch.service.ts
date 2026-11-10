import axios, { AxiosInstance } from "axios";
import * as cheerio from "cheerio";
import { createHash } from "crypto";
// Host backoff (issue #64): 429/503 detection + Retry-After parsing live in a
// small pure helper so #15 (Firestore-backed host state) can reuse them.
import { HostBackoffError, backoffDelayMs, isBackoffStatus } from "../etiquette/visa-crawl-host-state";

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
export const MAX_CLEAN_TEXT_CHARS = 24_000;

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
    config?: { responseType?: "text"; headers?: Record<string, string> }
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

  constructor(options: VisaCatalogFetchServiceOptions = {}) {
    this.minIntervalMs = options.minIntervalMs ?? PER_HOST_MIN_INTERVAL_MS;
    this.http = options.http ?? VisaCatalogFetchService.createDefaultClient();
    this.clock = options.clock ?? Date.now;
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
      maxContentLength: 5 * 1024 * 1024, // 5MB
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
  async getRaw(url: string, headers?: Record<string, string>): Promise<RawResponse> {
    const host = this.hostOf(url);
    await this.rateLimit(host);
    const resp = await this.http.get(url, { responseType: "text", headers });
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
   * Fetch one page's raw HTML (rate-limited, redirect-following). Returns the
   * HTML string + status + final URL. Non-HTML or error statuses are surfaced so
   * the caller can record source health rather than crashing the run.
   * 429/503 throws HostBackoffError instead (issue #64).
   */
  private async fetchHtml(
    url: string
  ): Promise<{ html: string; status: number; finalUrl: string }> {
    const host = this.hostOf(url);
    await this.rateLimit(host);
    const resp = await this.http.get(url, { responseType: "text" });
    // 429/503 -> HostBackoffError (Retry-After honoured by the crawl).
    this.assertNotThrottled(url, resp);
    const finalUrl = resp.request?.res?.responseUrl || url;
    const html = typeof resp.data === "string" ? resp.data : String(resp.data ?? "");
    return { html, status: resp.status, finalUrl };
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
   */
  async fetchAndClean(url: string, options?: { checkRobots?: boolean }): Promise<FetchedPage> {
    if (options?.checkRobots) {
      const allowed = await this.isAllowedByRobots(url);
      if (!allowed) {
        throw new Error(`Blocked by robots.txt: ${url}`);
      }
    }

    const { html, status, finalUrl } = await this.fetchHtml(url);
    if (status < 200 || status >= 300) {
      throw new Error(`Fetch failed for ${url} (HTTP ${status})`);
    }

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
