// ============================================
// VISA CATALOG — OFFICIAL HOSTS (registry-owned, pure)
// ============================================
//
// Which hosts count as a country's OFFICIAL government hosts (issue #74). Two
// consumers:
//
//  1. The GOV.UK adapter (`htmlFragmentToText` with a link filter) renders a
//     link as `text (url)` only when its host is an official APPLY service
//     (an official host other than the guidance site itself), so the extractor
//     can see the real apply URL instead of falling back to the page URL.
//  2. The extractor validator (`validateExtractedVisa`) keeps `applicationUrl`
//     only when its host is official — a hallucinated or third-party link
//     (agent sites, look-alike domains) is dropped before ingest.
//
// Like VISA_SOURCE_ADAPTERS, this map is registry config: seedVisaSources()
// writes it onto `visaSources/{cc}.officialHosts`, and the crawl falls back to
// this constant when a stored doc predates the field (no re-seed needed).
//
// IMPORTANT: no Firebase imports here — the adapters, validator and unit tests
// import this module without Admin init.
//
// Pattern syntax (deliberately tiny, so it can't be tricked):
//  - "www.gov.uk"         → that EXACT host only.
//  - "*.service.gov.uk"   → any STRICT subdomain of service.gov.uk
//                           ("visas-immigration.service.gov.uk"), matched on a
//                           label boundary: the host must END WITH
//                           ".service.gov.uk". Not the bare apex, and not
//                           "evilservice.gov.uk" or
//                           "x.service.gov.uk.attacker.com".
// Matching is on the URL's parsed `hostname` (lower-cased, trailing dot
// stripped), so userinfo tricks ("https://www.gov.uk@evil.com") resolve to the
// real host (evil.com) before matching.

/**
 * ISO alpha-2 → official host patterns. Countries not listed have no host
 * list: the validator then keeps `applicationUrl` as before (only an http(s)
 * check), and no adapter renders link URLs for them.
 */
export const VISA_SOURCE_OFFICIAL_HOSTS: Record<string, readonly string[]> = {
  // GB: the guidance site + the two families of Home Office apply services
  // seen on the golden guides (2026-11-09):
  //   visas-immigration.service.gov.uk               (visitor, family)
  //   apply-to-visit-or-stay-in-the-uk.homeoffice.gov.uk (work, study, talent…)
  GB: ["www.gov.uk", "*.service.gov.uk", "*.homeoffice.gov.uk"],
};

/** Official host patterns for a country code ([] when none are registered). */
export function officialHostsFor(countryCode: string | undefined): readonly string[] {
  if (!countryCode) return [];
  return VISA_SOURCE_OFFICIAL_HOSTS[countryCode.toUpperCase()] ?? [];
}

/** Normalise a hostname for comparison: lower-case, no trailing dot. */
function normaliseHost(host: string): string {
  return host.trim().toLowerCase().replace(/\.$/, "");
}

/**
 * True when `host` matches ONE pattern (syntax above). Blank / malformed
 * patterns never match ("*" alone, "*." etc. are rejected so a typo can't
 * allow every host).
 */
export function hostMatchesPattern(host: string, pattern: string): boolean {
  const h = normaliseHost(host);
  const p = normaliseHost(pattern);
  if (!h || !p) return false;
  if (p.startsWith("*.")) {
    const apex = p.slice(2);
    // A wildcard needs a real registrable-looking apex (at least one dot) and
    // no further wildcards.
    if (!apex.includes(".") || apex.includes("*")) return false;
    // Label-boundary suffix match: "x.service.gov.uk" ends with ".service.gov.uk";
    // "evilservice.gov.uk" does not, and neither does the apex itself.
    return h.endsWith(`.${apex}`);
  }
  if (p.includes("*")) return false; // wildcards only as a leading "*." label
  return h === p;
}

/** True when `host` matches ANY of `patterns`. */
export function isOfficialHost(host: string, patterns: readonly string[]): boolean {
  return patterns.some((p) => hostMatchesPattern(host, p));
}

/**
 * Parse `url` and return it when it is an https URL on an official host,
 * else undefined. Used for both link rendering and `applicationUrl`.
 * Non-https schemes (http, javascript:, data:, mailto:), credentials and
 * explicit ports never pass.
 */
export function officialHttpsUrl(url: string, patterns: readonly string[]): URL | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "https:") return undefined;
  // Credentials in a URL are never legitimate for an apply link.
  if (parsed.username || parsed.password) return undefined;
  // Any explicit non-default port is rejected (":8443" etc.). `URL` already
  // normalises ":443" on https to "", so only unusual ports reach this.
  if (parsed.port !== "") return undefined;
  return isOfficialHost(parsed.hostname, patterns) ? parsed : undefined;
}

/**
 * The official host patterns to use for one registry source: the stored
 * `officialHosts` when it is a non-empty array of non-empty strings, else the
 * code map for its country (a doc seeded before #74, or a malformed field,
 * must not disable the gate or crash the crawl).
 */
export function resolveOfficialHosts(stored: unknown, countryCode: string | undefined): readonly string[] {
  if (
    Array.isArray(stored) &&
    stored.length > 0 &&
    stored.every((h) => typeof h === "string" && h.trim().length > 0)
  ) {
    return stored as string[];
  }
  return officialHostsFor(countryCode);
}
