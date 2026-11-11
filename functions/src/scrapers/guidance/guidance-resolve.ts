import * as cheerio from "cheerio";
import type { RawResponse } from "../shared/fetch/visa-catalog-fetch.service";
import { NESTED_QUANTIFIER_RE } from "./guidance-published-date";
import type { GuidanceResolveFrom } from "./types";

// ============================================
// GUIDANCE — RESOLVING A DOCUMENT'S CURRENT ADDRESS (issue #111)
// ============================================
//
// Some publishers re-issue a document under a NEW address every time (the
// file's URL carries a per-release id), while a stable "publication" page
// always links to the current file. Seeding the file's address alone would
// make the source go `failing` at the next release, or worse, keep reading a
// superseded file for as long as the old address stays up.
//
// So a registry entry may say where to look the address up (`resolveFrom`):
// a stable page plus a pattern that picks out exactly one link on it. This
// module does that lookup. It is DATA-DRIVEN: nothing here knows any
// publisher, host, country or route; the page and the pattern come from the
// registry entry.
//
// Safety rules (a fetched page is untrusted input):
//  - the page is requested through the shared fetch service (robots.txt, bot
//    user agent, per-host delay, 429/503 backoff): no second HTTP client;
//  - the pattern must begin with a literal `https://<host>/`, checked at
//    seeding time, so whatever the page contains, the crawl can only be sent
//    to the host a human wrote into the seed;
//  - the pattern must match exactly ONE distinct link. No match and several
//    matches are both failures: the crawl never guesses which file is meant;
//  - the pattern is matched against one link at a time (bounded length), and
//    the nested-quantifier shape is refused, so a careless pattern cannot
//    hold a crawl.

/** Longest link pattern accepted (same bound as the date selector). */
export const MAX_LINK_PATTERN_CHARS = 300;

/** Longest link on a page that is considered at all. */
export const MAX_RESOLVED_LINK_CHARS = 2_048;

/** Largest parent page read, in characters (a listing page is small). */
export const MAX_RESOLVE_PAGE_CHARS = 5 * 1024 * 1024;

/**
 * What a link pattern must START with: `https://`, then a host written out
 * literally (labels of letters, digits and hyphens joined by ESCAPED dots),
 * then `/`. Tested against the pattern's SOURCE TEXT. Because the pattern is
 * matched against the whole URL, this pins the scheme and the host.
 */
const LITERAL_ORIGIN_RE = /^https:\/\/(?:[A-Za-z0-9-]+\\\.)+[A-Za-z]{2,}\//;

/** The fetch surface the lookup needs (the shared fetch service has both). */
export interface GuidanceResolveFetcher {
  isAllowedByRobots(url: string): Promise<boolean>;
  getRaw(url: string): Promise<RawResponse>;
}

/** The lookup failed for a reason of its own (see `resolveDocumentUrl`). */
export class GuidanceResolveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GuidanceResolveError";
  }
}

/** True for an absolute https URL. */
function isHttpsUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Everything wrong with a `resolveFrom` value (empty = fine). Used by the
 * seed validator, so a bad entry is refused at seeding time, and again by
 * the crawl, so a hand-edited doc is not trusted either.
 */
export function resolveFromProblems(value: unknown): string[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return ["resolveFrom must be an object with pageUrl and linkPattern"];
  }
  const { pageUrl, linkPattern } = value as Partial<GuidanceResolveFrom>;
  const problems: string[] = [];
  if (!isHttpsUrl(pageUrl)) problems.push("resolveFrom.pageUrl must be an absolute https URL");

  if (typeof linkPattern !== "string" || !linkPattern.trim()) {
    problems.push("resolveFrom.linkPattern is required");
    return problems;
  }
  if (linkPattern.length > MAX_LINK_PATTERN_CHARS) {
    problems.push(`resolveFrom.linkPattern is longer than ${MAX_LINK_PATTERN_CHARS} characters`);
  }
  try {
    new RegExp(linkPattern);
  } catch (err) {
    problems.push(`resolveFrom.linkPattern is not a valid regular expression: ${(err as Error).message}`);
    return problems;
  }
  // Scheme and host are written out, not matched: see LITERAL_ORIGIN_RE.
  if (!LITERAL_ORIGIN_RE.test(linkPattern)) {
    problems.push("resolveFrom.linkPattern must begin with a literal https://<host>/ (dots escaped), so it pins the host");
  }
  // A top-level alternative (`a|b`) would escape that literal start.
  if (hasTopLevelAlternation(linkPattern)) {
    problems.push("resolveFrom.linkPattern must not use a top-level alternative (|): put it inside a group");
  }
  if (NESTED_QUANTIFIER_RE.test(linkPattern)) {
    problems.push("resolveFrom.linkPattern must not repeat a group that itself contains a quantifier (nested quantifiers)");
  }
  return problems;
}

/**
 * True when a pattern's source has a `|` outside every group and character
 * class (`a|b`, but not `(a|b)` or `[a|b]`). Such a pattern would match
 * either side on its own, so only the first side would carry the literal
 * `https://<host>/` start.
 */
function hasTopLevelAlternation(pattern: string): boolean {
  let depth = 0; // open groups
  let inClass = false; // inside [...]
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "\\") {
      i++; // the next character is escaped: skip it
    } else if (inClass) {
      if (c === "]") inClass = false;
    } else if (c === "[") {
      inClass = true;
    } else if (c === "(") {
      depth++;
    } else if (c === ")") {
      depth = Math.max(0, depth - 1);
    } else if (c === "|" && depth === 0) {
      return true;
    }
  }
  return false;
}

/**
 * The distinct absolute URLs of the links on a page that match the pattern
 * in full. Pure. Relative links are resolved against `baseUrl`; fragments
 * are dropped (they never reach a server); links that are not https, are
 * over-long or cannot be parsed are ignored.
 */
export function findMatchingLinks(html: string, baseUrl: string, linkPattern: string): string[] {
  // Anchored at both ends: the pattern describes the whole address.
  const re = new RegExp(`^(?:${linkPattern})$`);
  const $ = cheerio.load(html);
  const found = new Set<string>();
  $("a[href]").each((_, el) => {
    const href = ($(el).attr("href") ?? "").trim();
    if (!href || href.length > MAX_RESOLVED_LINK_CHARS) return;
    let absolute: URL;
    try {
      absolute = new URL(href, baseUrl);
    } catch {
      return; // not a URL: not a candidate
    }
    if (absolute.protocol !== "https:") return;
    absolute.hash = "";
    const url = absolute.toString();
    if (url.length <= MAX_RESOLVED_LINK_CHARS && re.test(url)) found.add(url);
  });
  return [...found];
}

/** Result of a lookup. */
export interface ResolvedDocumentUrl {
  // The document's current address: the one link that matched.
  resolvedUrl: string;
  // Where the request for the parent page ended (after redirects).
  pageFinalUrl: string;
}

/**
 * Look a document's current address up on its parent page.
 *
 * Throws, and the crawl records a failed attempt on the source:
 *  - `Blocked by robots.txt: <page>` when robots.txt disallows the page;
 *  - a HostBackoffError (from the fetch service) on a 429/503;
 *  - a GuidanceResolveError when the entry is malformed, the page did not
 *    answer 200, is too large, or does not link to exactly one match.
 *
 * @param fetcher     the shared fetch service
 * @param resolveFrom the registry entry's `resolveFrom`
 */
export async function resolveDocumentUrl(
  fetcher: GuidanceResolveFetcher,
  resolveFrom: GuidanceResolveFrom
): Promise<ResolvedDocumentUrl> {
  // Not trusted just because it is stored: a hand-edited doc is re-checked.
  const problems = resolveFromProblems(resolveFrom);
  if (problems.length > 0) throw new GuidanceResolveError(`Invalid resolveFrom: ${problems.join("; ")}`);
  const { pageUrl, linkPattern } = resolveFrom;

  // Same etiquette as a document request: robots.txt first, then one
  // rate-limited GET through the shared client.
  if (!(await fetcher.isAllowedByRobots(pageUrl))) throw new Error(`Blocked by robots.txt: ${pageUrl}`);
  const page = await fetcher.getRaw(pageUrl);
  if (page.status < 200 || page.status >= 300) {
    throw new GuidanceResolveError(`Could not read the parent page ${pageUrl} (HTTP ${page.status})`);
  }
  if (page.body.length > MAX_RESOLVE_PAGE_CHARS) {
    throw new GuidanceResolveError(`Parent page ${pageUrl} is too large to search (${page.body.length} characters)`);
  }

  const matches = findMatchingLinks(page.body, page.finalUrl || pageUrl, linkPattern);
  if (matches.length === 0) {
    throw new GuidanceResolveError(`No link on ${pageUrl} matches the entry's linkPattern: the document's address could not be resolved`);
  }
  if (matches.length > 1) {
    // Never guess between files. The addresses are listed (bounded) so the
    // person fixing the pattern can see what it matched.
    throw new GuidanceResolveError(
      `${matches.length} different links on ${pageUrl} match the entry's linkPattern (it must match exactly one): ` +
        matches.slice(0, 3).join(", ")
    );
  }
  return { resolvedUrl: matches[0], pageFinalUrl: page.finalUrl || pageUrl };
}
