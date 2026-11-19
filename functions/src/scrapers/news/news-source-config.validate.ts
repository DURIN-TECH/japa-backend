import * as cheerio from "cheerio";
import { isIP } from "node:net";
import { isAllowedPort, isPublicAddress } from "../shared/fetch/address-guard";
import {
  SUPPORTED_COUNTRY_CODES,
  type HtmlSelectors,
  type IngestionStrategy,
  type SupportedCountryCode,
} from "../../types/news";
import type { NewsEditableConfig } from "./news-source-config.shape";
import { SettingsValidationError } from "../shared/settings/scraper-settings.validate";

// ============================================
// NEWS SOURCE CONFIG — validation (issue #17)
// ============================================
//
// REUSED BY #24 (CSV/JSON bulk import) AND #25 (discovered RSS proposals):
// whatever creates or edits a news source validates it through THIS module so
// every entry path applies the same rules (ranges, supported countries, the
// SSRF guard on `feedUrl`, parseable CSS selectors).
//
// Pure: no Firestore, no network, no clock. Errors are the scraper settings'
// own `SettingsValidationError(field, message)` (dotted field path), which the
// admin controller turns into `400 { error: "VALIDATION_ERROR", field }`.
//
// Two entry points:
//  (a) parseNewsConfigEdit(body, stored?)  - an admin's PARTIAL edit
//      (PATCH /admin/scrape-sources/news/:id). Without `stored` it checks the
//      shape and the strategy-independent rules (what parseSourcePatch can do
//      without a Firestore read); with `stored` it also applies the rules that
//      depend on the source's strategy and returns the merged result.
//  (b) validateNewsSourceObject(obj)       - a COMPLETE source-shaped object
//      (name/slug/url/strategy/config/... as the importers build it).
//
// Import cycle note: scraper-settings.validate.ts imports this module (its
// parseSourcePatch delegates here) and this module imports the error class
// from it. Both only use the other's exports INSIDE functions (never at module
// load), which CommonJS resolves fine.

// ---------- Limits (documented constants; the API returns them in messages) ----------

/** Shortest / longest scrape interval an admin may set: 15 minutes .. 7 days. */
export const MIN_SCRAPE_INTERVAL_MINUTES = 15;
export const MAX_SCRAPE_INTERVAL_MINUTES = 10_080;
/** Source priority range (the registry uses 1 = most important .. 5). */
export const MIN_SOURCE_PRIORITY = 1;
export const MAX_SOURCE_PRIORITY = 10;
/** Articles taken from one fetch of a source. */
export const MIN_MAX_ARTICLES_PER_RUN = 1;
export const MAX_MAX_ARTICLES_PER_RUN = 100;
/** Longest feed URL / CSS selector accepted. */
export const MAX_FEED_URL_CHARS = 2048;
export const MAX_SELECTOR_CHARS = 200;

/** The `HtmlSelectors` keys, and the three a `html_scrape` source must have. */
export const HTML_SELECTOR_KEYS: readonly (keyof HtmlSelectors)[] = [
  "articleList",
  "articleLink",
  "articleTitle",
  "articleSummary",
  "articleDate",
  "articleImage",
  "articleBody",
];
export const REQUIRED_HTML_SELECTOR_KEYS: readonly (keyof HtmlSelectors)[] = ["articleList", "articleLink", "articleTitle"];

/** Strategies an edit can target (a stored `strategy` is never changed). */
const STRATEGIES: readonly IngestionStrategy[] = ["rss", "html_scrape", "news_api"];

// ---------- Types ----------
// NewsEditableConfig + newsEditableConfigOf live in news-source-config.shape.ts
// (dependency-free, so the run service can read them without loading this
// module's validation imports); re-exported here for the importers (#24 / #25).
export type { NewsEditableConfig } from "./news-source-config.shape";
export { newsEditableConfigOf } from "./news-source-config.shape";

/** A parsed partial edit. Absent = not changed. */
export interface NewsConfigEdit {
  scrapeIntervalMinutes?: number;
  priority?: number;
  countryCodes?: SupportedCountryCode[];
  config?: {
    feedUrl?: string;
    selectors?: Partial<HtmlSelectors>; // merged over the stored selectors
    maxArticlesPerRun?: number;
  };
}

/** Top-level keys a news edit may carry (on top of status/reason/resetFailures). */
export const NEWS_EDIT_KEYS = ["scrapeIntervalMinutes", "priority", "countryCodes", "config"] as const;

// ---------- Small helpers ----------

/** Plain object (not null / array). */
function isObj(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === "object" && !Array.isArray(v);
}

/** Integer within [min, max], else a 400 naming `field`. */
function assertIntInRange(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new SettingsValidationError(field, `${field} must be an integer between ${min} and ${max}`);
  }
  return value;
}

/** 400 for any key of `obj` outside `allowed` (prefix = the object's path). */
function rejectUnknown(obj: Record<string, unknown>, allowed: readonly string[], prefix: string): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) {
      const path = prefix ? `${prefix}.${key}` : key;
      throw new SettingsValidationError(path, `${path} is not a known setting`);
    }
  }
}

// ---------- Field validators (exported: #24 / #25 and the tests use them) ----------

/** countryCodes: non-empty array, no duplicates, every value supported. */
export function parseCountryCodes(value: unknown, field = "countryCodes"): SupportedCountryCode[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new SettingsValidationError(field, `${field} must be a non-empty array of: ${SUPPORTED_COUNTRY_CODES.join(", ")}`);
  }
  const seen = new Set<string>();
  for (const code of value) {
    if (typeof code !== "string" || !(SUPPORTED_COUNTRY_CODES as readonly string[]).includes(code)) {
      throw new SettingsValidationError(field, `${field}: "${String(code)}" is not supported (use: ${SUPPORTED_COUNTRY_CODES.join(", ")})`);
    }
    if (seen.has(code)) throw new SettingsValidationError(field, `${field}: "${code}" is listed twice`);
    seen.add(code);
  }
  return [...value] as SupportedCountryCode[];
}

/** Hostnames that are never a public feed (cloud metadata, local names). */
const BLOCKED_HOST_NAMES = new Set(["localhost", "metadata", "metadata.google.internal", "instance-data"]);
const BLOCKED_HOST_SUFFIXES = [".localhost", ".local", ".internal", ".localdomain", ".home.arpa"];

/**
 * feedUrl: a valid http(s) URL, no embedded credentials, port 80/443 only, and
 * a host that is a dotted public name or a public IP literal (the scraper
 * fetches this URL from our servers, so it must not be pointable at internal
 * addresses). Returns the NORMALISED url.href (issue #159), so what is stored
 * is what was checked: backslashes, tabs/newlines and mixed-case hosts are
 * already resolved by the WHATWG parser, and re-parsing the stored value gives
 * the same host.
 *
 * Literal-only: IP literals are judged by the shared classifier
 * (shared/fetch/address-guard.ts, the same rules the fetch layer applies);
 * names are NOT resolved here (no DNS at write time). A name that resolves to
 * an internal address is refused at fetch time by the guarded client.
 */
export function parseFeedUrl(value: unknown, field = "config.feedUrl"): string {
  if (typeof value !== "string" || value.trim() === "" || value.length > MAX_FEED_URL_CHARS) {
    throw new SettingsValidationError(field, `${field} must be a URL string of at most ${MAX_FEED_URL_CHARS} characters`);
  }
  const raw = value.trim();
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SettingsValidationError(field, `${field} is not a valid URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new SettingsValidationError(field, `${field} must start with http:// or https://`);
  }
  if (url.username !== "" || url.password !== "") {
    throw new SettingsValidationError(field, `${field} must not contain credentials`);
  }
  // Only the standard web ports (80/443, explicit or the scheme's default).
  if (!isAllowedPort(url.port)) {
    throw new SettingsValidationError(field, `${field} must use the default port (80 or 443)`);
  }
  // WHATWG URL already normalises decimal / hex / short IPv4 forms (e.g.
  // http://2130706433/ -> 127.0.0.1), so the literal checks below see them.
  // ALL trailing dots are stripped ("localhost.." too) before any check.
  const host = url.hostname.toLowerCase().replace(/\.+$/, "");
  const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  const isLiteral = isIP(bare) !== 0;
  const blocked = isLiteral
    ? !isPublicAddress(bare) // every IPv4 / IPv6 class: the shared classifier
    : BLOCKED_HOST_NAMES.has(host) ||
      BLOCKED_HOST_SUFFIXES.some((s) => host.endsWith(s)) ||
      !host.includes("."); // single-label (bare intranet) names are never a public feed
  if (blocked) {
    throw new SettingsValidationError(field, `${field} must point at a public host (not localhost, a private IP or a metadata host)`);
  }
  return url.href;
}

/** A CSS selector: non-empty, bounded, and parseable by cheerio (css-select). */
export function parseSelector(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "" || value.length > MAX_SELECTOR_CHARS) {
    throw new SettingsValidationError(field, `${field} must be a non-empty CSS selector of at most ${MAX_SELECTOR_CHARS} characters`);
  }
  const selector = value.trim();
  // cheerio treats a string starting with "<" as HTML, not a selector.
  if (selector.startsWith("<")) throw new SettingsValidationError(field, `${field} is not a valid CSS selector`);
  try {
    // Selecting against an empty document compiles the selector (throws on a syntax error).
    cheerio.load("<div></div>").root().find(selector);
  } catch {
    throw new SettingsValidationError(field, `${field} is not a valid CSS selector`);
  }
  return selector;
}

/** A partial selectors object: known keys only, each a valid selector. */
function parseSelectorsPatch(value: unknown, prefix = "config.selectors"): Partial<HtmlSelectors> {
  if (!isObj(value)) throw new SettingsValidationError(prefix, `${prefix} must be an object`);
  rejectUnknown(value, HTML_SELECTOR_KEYS, prefix);
  const out: Record<string, string> = {};
  for (const [key, v] of Object.entries(value)) out[key] = parseSelector(v, `${prefix}.${key}`);
  return out as Partial<HtmlSelectors>;
}

// ============================================
// (a) PARTIAL EDIT
// ============================================

/**
 * Parse a partial news-source edit.
 *
 * @param body   the PATCH body restricted to the news keys
 *               (`NEWS_EDIT_KEYS`); other keys are the caller's business.
 *               `strategy` is rejected here ("cannot be changed").
 * @param stored the stored source's editable slice. Omit it for the
 *               shape-only parse; pass it to apply the strategy rules
 *               (feedUrl only for rss, selectors only for html_scrape,
 *               news_api takes neither, required selectors after merging).
 * @returns the parsed edit (`edit`) and, when `stored` was given, the
 *          merged effective values (`next`).
 * @throws SettingsValidationError on the first bad field.
 */
export function parseNewsConfigEdit(
  body: Record<string, unknown>,
  stored?: NewsEditableConfig
): { edit: NewsConfigEdit; next?: NewsEditableConfig } {
  if ("strategy" in body) {
    throw new SettingsValidationError("strategy", "strategy cannot be changed");
  }
  const edit: NewsConfigEdit = {};

  if (body.scrapeIntervalMinutes !== undefined) {
    edit.scrapeIntervalMinutes = assertIntInRange(
      body.scrapeIntervalMinutes,
      "scrapeIntervalMinutes",
      MIN_SCRAPE_INTERVAL_MINUTES,
      MAX_SCRAPE_INTERVAL_MINUTES
    );
  }
  if (body.priority !== undefined) {
    edit.priority = assertIntInRange(body.priority, "priority", MIN_SOURCE_PRIORITY, MAX_SOURCE_PRIORITY);
  }
  if (body.countryCodes !== undefined) edit.countryCodes = parseCountryCodes(body.countryCodes);

  if (body.config !== undefined) {
    const c = body.config;
    if (!isObj(c)) throw new SettingsValidationError("config", "config must be an object");
    rejectUnknown(c, ["feedUrl", "selectors", "maxArticlesPerRun"], "config");
    if (Object.keys(c).length === 0) throw new SettingsValidationError("config", "config has nothing to change");
    edit.config = {};
    if (c.feedUrl !== undefined) edit.config.feedUrl = parseFeedUrl(c.feedUrl);
    if (c.selectors !== undefined) {
      edit.config.selectors = parseSelectorsPatch(c.selectors);
      if (Object.keys(edit.config.selectors).length === 0) {
        throw new SettingsValidationError("config.selectors", "config.selectors has nothing to change");
      }
    }
    if (c.maxArticlesPerRun !== undefined) {
      edit.config.maxArticlesPerRun = assertIntInRange(
        c.maxArticlesPerRun,
        "config.maxArticlesPerRun",
        MIN_MAX_ARTICLES_PER_RUN,
        MAX_MAX_ARTICLES_PER_RUN
      );
    }
  }

  if (!stored) return { edit };
  return { edit, next: applyNewsConfigEdit(stored, edit) };
}

/**
 * Apply an already-parsed edit to a stored source's editable slice (pure) and
 * enforce the strategy rules. Selectors are MERGED over the stored ones;
 * everything else replaces. Throws SettingsValidationError.
 */
export function applyNewsConfigEdit(stored: NewsEditableConfig, edit: NewsConfigEdit): NewsEditableConfig {
  const strategy = stored.strategy;
  const cfg = edit.config ?? {};

  // ---- Strategy gates: which config keys this kind of source accepts ----
  if (cfg.feedUrl !== undefined && strategy !== "rss") {
    throw new SettingsValidationError("config.feedUrl", `config.feedUrl is only for rss sources (this one is ${strategy})`);
  }
  if (cfg.selectors !== undefined && strategy !== "html_scrape") {
    throw new SettingsValidationError("config.selectors", `config.selectors is only for html_scrape sources (this one is ${strategy})`);
  }

  const next: NewsEditableConfig = {
    strategy,
    scrapeIntervalMinutes: edit.scrapeIntervalMinutes ?? stored.scrapeIntervalMinutes,
    priority: edit.priority ?? stored.priority,
    countryCodes: edit.countryCodes ?? [...stored.countryCodes],
    maxArticlesPerRun: cfg.maxArticlesPerRun ?? stored.maxArticlesPerRun,
  };
  if (strategy === "rss") {
    const feedUrl = cfg.feedUrl ?? stored.feedUrl;
    if (!feedUrl) throw new SettingsValidationError("config.feedUrl", "an rss source needs a config.feedUrl");
    next.feedUrl = feedUrl;
  }
  if (strategy === "html_scrape") {
    const selectors = { ...(stored.selectors ?? {}), ...(cfg.selectors ?? {}) };
    for (const key of REQUIRED_HTML_SELECTOR_KEYS) {
      if (!selectors[key]) throw new SettingsValidationError(`config.selectors.${key}`, `an html_scrape source needs config.selectors.${key}`);
    }
    next.selectors = selectors;
  }
  return next;
}

// ============================================
// (b) COMPLETE OBJECT (used by #24 import / #25 proposals)
// ============================================

/**
 * Validate a complete source-shaped object, e.g. one CSV/JSON import row or a
 * discovered proposal. Checks the same rules as an edit, plus the identity
 * fields a new source needs. Throws SettingsValidationError naming the field.
 * `apiConfig` / `customHeaders` / `fetchFullContent` are not editable through
 * this module and are ignored here (their own validation belongs to #24).
 */
export function validateNewsSourceObject(obj: unknown): NewsEditableConfig {
  if (!isObj(obj)) throw new SettingsValidationError("body", "the source must be a JSON object");
  for (const key of ["name", "slug"] as const) {
    const v = obj[key];
    if (typeof v !== "string" || v.trim() === "" || v.length > 200) {
      throw new SettingsValidationError(key, `${key} must be a non-empty string of at most 200 characters`);
    }
  }
  if (!/^[a-z0-9][a-z0-9-]*$/.test(obj.slug as string)) {
    throw new SettingsValidationError("slug", "slug must be lowercase letters, digits and dashes");
  }
  if (typeof obj.url !== "string") throw new SettingsValidationError("url", "url must be a URL string");
  parseFeedUrl(obj.url, "url"); // same public-host / no-credentials rules
  if (!STRATEGIES.includes(obj.strategy as IngestionStrategy)) {
    throw new SettingsValidationError("strategy", `strategy must be one of: ${STRATEGIES.join(", ")}`);
  }
  const strategy = obj.strategy as IngestionStrategy;
  if (obj.scrapeIntervalMinutes === undefined) throw new SettingsValidationError("scrapeIntervalMinutes", "scrapeIntervalMinutes is required");
  if (obj.priority === undefined) throw new SettingsValidationError("priority", "priority is required");
  if (obj.countryCodes === undefined) throw new SettingsValidationError("countryCodes", "countryCodes is required");
  const config = obj.config;
  if (!isObj(config)) throw new SettingsValidationError("config", "config must be an object");
  if (config.maxArticlesPerRun === undefined) {
    throw new SettingsValidationError("config.maxArticlesPerRun", "config.maxArticlesPerRun is required");
  }
  // A complete object is an edit of an EMPTY source of the same strategy:
  // reuse the partial parser + strategy rules so there is one rule set.
  const empty: NewsEditableConfig = {
    strategy,
    scrapeIntervalMinutes: 0,
    priority: 0,
    countryCodes: [],
    maxArticlesPerRun: 0,
  };
  const body: Record<string, unknown> = {
    scrapeIntervalMinutes: obj.scrapeIntervalMinutes,
    priority: obj.priority,
    countryCodes: obj.countryCodes,
    config: {
      maxArticlesPerRun: config.maxArticlesPerRun,
      ...(config.feedUrl !== undefined ? { feedUrl: config.feedUrl } : {}),
      ...(config.selectors !== undefined ? { selectors: config.selectors } : {}),
    },
  };
  return parseNewsConfigEdit(body, empty).next as NewsEditableConfig;
}
