// ============================================
// EU LAW READER — machine route for EUR-Lex documents (issue #261)
// ============================================
//
// Problem: `eur-lex.europa.eu` pages answer an ordinary reader with an empty
// shell (a redirect to the site root, ~250 characters of menu). The EU
// Publications Office serves the SAME documents for machines at
//
//   https://publications.europa.eu/resource/celex/{CELEX}
//
// when the request says it wants XHTML and English:
//
//   Accept: application/xhtml+xml
//   Accept-Language: eng
//
// The address then redirects (same host) to
// `/resource/cellar/<uuid>/DOC_1` and returns the whole document (the Visa
// Code, consolidated, is ~575 KB of XHTML, ~148,000 characters of text).
// With `Accept: text/html` the same address is a 404, so the header is needed.
//
// This module holds only the pure rules (what is an EU-law address, which
// headers, what a redirect may look like, how to strip consolidation
// markers). `VisaCatalogFetchService.fetchAndClean` applies them, and ONLY to
// addresses `isEuLawCelexUrl` accepts: every other host is untouched.
//
// No crawler disguise: the request still carries our normal user agent, goes
// through robots.txt, the per-host politeness gap and the address guard.

/** The one host this reader is for. */
export const EU_LAW_HOST = "publications.europa.eu";

/** Path prefix of a CELEX address (the address an admin registers). */
const CELEX_PATH_PREFIX = "/resource/celex/";

/** Path prefix the CELEX address redirects to (the document itself). */
const CELLAR_PATH_PREFIX = "/resource/cellar/";

/**
 * The two headers that make the route return the document. They are added to
 * the request on top of the client's defaults (our user agent stays).
 */
export const EU_LAW_REQUEST_HEADERS: Readonly<Record<string, string>> = {
  Accept: "application/xhtml+xml",
  "Accept-Language": "eng",
};

/**
 * Longest cleaned text accepted for an EU-law document when the caller names
 * no limit of its own. Same figure as the PDF path (1,000,000 characters,
 * DEFAULT_PDF_LIMITS.maxTextChars): the legal text must never be cut short, so
 * an over-long document FAILS the fetch (HtmlTextTooLongError) instead.
 * Duplicated as a literal (not imported) to keep this module dependency-free;
 * a test pins the two together.
 */
export const EU_LAW_MAX_TEXT_CHARS = 1_000_000;

/** Parse a URL, or undefined when it is not one. */
function parse(url: string): URL | undefined {
  try {
    return new URL(url);
  } catch {
    return undefined;
  }
}

/**
 * True for a `publications.europa.eu/resource/celex/<CELEX>` address (http or
 * https, default ports only). This is the single switch for the whole reader:
 * anything else, including other paths on the same host, takes the ordinary
 * path.
 */
export function isEuLawCelexUrl(url: string): boolean {
  const u = parse(url);
  if (!u) return false;
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  if (u.hostname.toLowerCase() !== EU_LAW_HOST) return false;
  if (u.port !== "") return false;
  return u.pathname.startsWith(CELEX_PATH_PREFIX) && u.pathname.length > CELEX_PATH_PREFIX.length;
}

/**
 * Is `finalUrl` an acceptable place for the request for `requestedUrl` to have
 * ended? Same host only, and either the document under `/resource/cellar/` or
 * (no redirect at all) the address that was asked for. Anything else, such as
 * the redirect to the EUR-Lex site root that the ordinary pages suffer from,
 * is refused rather than read.
 */
export function isAcceptableEuLawFinalUrl(requestedUrl: string, finalUrl: string): boolean {
  const f = parse(finalUrl);
  if (!f || f.hostname.toLowerCase() !== EU_LAW_HOST) return false;
  if (f.pathname.startsWith(CELLAR_PATH_PREFIX) && f.pathname.length > CELLAR_PATH_PREFIX.length) return true;
  const r = parse(requestedUrl);
  return !!r && f.pathname === r.pathname && f.search === r.search;
}

/**
 * Redirect-hop policy: a hop may only go to the EU Publications Office host.
 * Matches the `redirectHostCheck` shape the guarded client calls BEFORE it
 * requests a hop (the argument is the lowercased hostname).
 */
export function euLawRedirectHostCheck(host: string): boolean {
  return host.toLowerCase().replace(/:\d+$/, "") === EU_LAW_HOST;
}

// ---- Consolidation markers ----
//
// A consolidated EU text is the base act with its amendments folded in. Each
// amended passage is bracketed by markers that name the amending act:
//
//   "▼B"   the passage is from the base act (begins)
//   "▼M7"  the passage comes from amendment 7 (begins)
//   "▼C1"  the passage comes from corrigendum 1 (begins)
//   "►M5 ... ◄"  a shorter inserted/replaced stretch (opens / closes)
//
// They are editorial apparatus, not law, and they land in the middle of the
// text ("Article 16 Visa fee ▼M7 1. Applicants shall pay a visa fee of ...").
// DECISION: the marker TOKENS are removed from the cleaned text and everything
// else is kept (the amending act's title lines stay). Reason: the stored text
// is what rule drafting reads and what a rule's quote is matched against
// (`normalizeForQuoteMatch` plus a plain substring test); a marker sitting
// between two words of a real sentence would make a true quote fail, and the
// drafter would otherwise copy markers into quotes. The cost: a passage copied
// BY HAND from EUR-Lex, markers included, will not match; copy it without the
// marker tokens (the quote check is unchanged and deliberately not taught
// about markers, so no other source is affected).

/**
 * One marker token: a triangle, an optional space, ONE capital letter and up
 * to three digits ("▼B", "▼M7", "►C12"), not followed by another letter or
 * digit (so a glued-on word is never eaten); or a lone closing "◄".
 */
const MARKER_RE = /[▼►][ \t]*[A-Z]\d{0,3}(?![\p{L}\p{N}])|◄/gu;

/**
 * Remove consolidation markers from cleaned text and tidy the whitespace they
 * leave behind (same rules as the shared HTML cleaner: runs of spaces become
 * one, spaces around line breaks go, blank-line runs collapse). Pure and
 * deterministic, so the content hash stays stable across runs.
 */
export function stripConsolidationMarkers(text: string): string {
  return text
    .replace(MARKER_RE, "")
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Plain-words message for a non-2xx answer from the machine route. The
 * `(HTTP n)` tail is kept because the guidance crawl classifies a failure as
 * `http_error` by matching it.
 */
export function euLawHttpErrorMessage(url: string, status: number): string {
  if (status === 404) {
    return (
      `The EU Publications Office has no English document for ${url} (HTTP 404). ` +
      "Check the CELEX number is right. A newer consolidated version has a new CELEX number, " +
      "so the address needs updating when the law is amended"
    );
  }
  return `Fetch failed for ${url} (HTTP ${status}): the EU Publications Office did not return the document`;
}
