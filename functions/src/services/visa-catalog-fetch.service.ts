import axios, { AxiosInstance } from "axios";
import * as cheerio from "cheerio";
import { createHash } from "crypto";

// ============================================
// VISA CATALOG — FETCH SERVICE (Step 2)
// ============================================
//
// The deterministic, model-agnostic first half of the visa-catalog pipeline
// (see docs/visa-catalog-scraping-spike.md). Its job: given an official visa
// page URL, fetch it politely, strip boilerplate down to readable content text,
// and hash that text so the extractor only ever runs on pages that actually
// changed. No LLM here — this layer is cheap and fully verifiable.

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
export function htmlFragmentToText(html: string): string {
  const $ = cheerio.load(html);
  // cheerio wraps a fragment in <html><body>; read from <body>.
  return blockText($("body"));
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
  // Cached robots.txt disallow rules per host (null = fetch failed / none).
  private readonly robotsCache = new Map<string, string[] | null>();

  constructor(options: VisaCatalogFetchServiceOptions = {}) {
    this.minIntervalMs = options.minIntervalMs ?? PER_HOST_MIN_INTERVAL_MS;
    this.http = options.http ?? VisaCatalogFetchService.createDefaultClient();
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
   * proceed, which is the conventional crawler behaviour.
   */
  async isAllowedByRobots(url: string): Promise<boolean> {
    const host = this.hostOf(url);
    if (!host) return false;

    let disallows = this.robotsCache.get(host);
    if (disallows === undefined) {
      disallows = await this.loadRobots(url);
      this.robotsCache.set(host, disallows);
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
   * Fetch + parse robots.txt into a flat list of Disallow prefixes that apply to
   * us (rules under `User-agent: *` or a Seli-specific agent). Deliberately
   * simple — enough to respect explicit blocks without a full parser.
   */
  private async loadRobots(url: string): Promise<string[] | null> {
    try {
      const origin = new URL(url).origin;
      const host = this.hostOf(url);
      await this.rateLimit(host);
      const resp = await this.http.get(`${origin}/robots.txt`, { responseType: "text" });
      if (resp.status >= 400 || typeof resp.data !== "string") return null;

      const disallows: string[] = [];
      // Track whether the current `User-agent` block applies to us.
      let applies = false;
      for (const raw of resp.data.split(/\r?\n/)) {
        const line = raw.split("#")[0].trim();
        if (!line) continue;
        const [field, ...rest] = line.split(":");
        const key = field.trim().toLowerCase();
        const value = rest.join(":").trim();
        if (key === "user-agent") {
          const ua = value.toLowerCase();
          applies = ua === "*" || ua.includes("seli");
        } else if (key === "disallow" && applies && value) {
          disallows.push(value);
        }
      }
      return disallows;
    } catch {
      return null; // fail-open
    }
  }

  /**
   * Rate-limited GET through the shared client, for adapters that need the raw
   * response (e.g. the GOV.UK Content API adapter). Waits out the per-host gap
   * first, sends our UA (client default) plus any extra `headers` (such as
   * `Accept: application/json`), and returns status/body/final URL WITHOUT
   * throwing on non-2xx — the adapter decides what is an error. Robots is NOT
   * checked here; call `isAllowedByRobots()` first (as fetchAndClean does).
   *
   * Keeping this the only way adapters reach the network means the rate limit,
   * robots cache and client live in one place (#15 can swap them here).
   */
  async getRaw(url: string, headers?: Record<string, string>): Promise<RawResponse> {
    const host = this.hostOf(url);
    await this.rateLimit(host);
    const resp = await this.http.get(url, { responseType: "text", headers });
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
   */
  private async fetchHtml(
    url: string
  ): Promise<{ html: string; status: number; finalUrl: string }> {
    const host = this.hostOf(url);
    await this.rateLimit(host);
    const resp = await this.http.get(url, { responseType: "text" });
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
   * source failure); returns the cleaned + hashed page on success.
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
