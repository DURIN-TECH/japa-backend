import { createHash } from "crypto";
import type { LinkedSurchargeRef, VisaSourcePage } from "./types";

// ============================================
// VISA CATALOG — RECORD IDENTITY + CRAWL-STATE HELPERS (pure)
// ============================================
//
// Pure functions behind two guarantees of the visa-catalog scraper:
//
//  1. RECORD IDENTITY. A scraped visa always lands on the same, predictable
//     `countries/{code}/visaTypes/{id}` doc. The id comes from the SOURCE
//     REGISTRY (a pinned `visaId` on the page, or the page URL's path), never
//     from what the LLM extracted — extracted names/codes drift between crawls
//     and used to fork one visa into several docs.
//
//  2. CRAWL STATE SURVIVES RE-SEEDING. Re-running the `visaSources` seed must
//     not wipe each page's content hash / timestamps, or the next crawl would
//     re-fetch and re-extract every page (the hash gate would be lost).
//
// IMPORTANT: this module must stay importable WITHOUT Firebase Admin init (no
// `utils/firebase`, no `getFirestore()` at module level) so the unit tests in
// `functions/test/` can exercise it directly, with no emulator.

// ----- Id derivation -----

/**
 * Max length of the path slug part of a derived id (the `${cc}-` prefix is not
 * counted). Long enough that every real GOV.UK route slug fits untouched (the
 * longest pinned one, `india-young-professionals-scheme-visa`, is 37 chars),
 * short enough to keep Firestore doc ids readable in the console.
 */
export const VISA_ID_SLUG_MAX = 80;

/** Hex chars of the sha256 suffix appended when a slug has to be truncated. */
const HASH_SUFFIX_LEN = 6;

/**
 * Lowercase, collapse every run of non-alphanumerics to a single hyphen, and
 * trim hyphens from both ends. `"/Work/Skilled_Worker visa/"` -> `"work-skilled-worker-visa"`.
 */
export function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Normalise a source URL to the path that identifies the page.
 *
 * - Query string and fragment are dropped (`URL.pathname` excludes both), so
 *   `.../b-visa?x=1` and `.../b-visa#top` identify the same page as `.../b-visa`.
 * - Trailing slashes are dropped, so `.../b-visa/` is the same page too.
 * - The hostname is NOT part of the id: ids are already namespaced by country
 *   (`${cc}-…`) and a country's registry points at its own official site.
 *
 * Throws on an unparseable URL or an empty path (`https://x.gov/`): we refuse
 * to invent an id rather than collapsing many pages onto one doc.
 */
export function normalizedSourcePath(sourceUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(sourceUrl);
  } catch {
    throw new Error(`Cannot derive visa id: unparseable source URL "${sourceUrl}"`);
  }
  // Strip trailing slashes; "/" (the site root) becomes "" and is rejected below.
  const pathname = parsed.pathname.replace(/\/+$/, "");
  if (!slugify(pathname)) {
    throw new Error(`Cannot derive visa id: source URL "${sourceUrl}" has an empty path`);
  }
  return pathname;
}

/**
 * Deterministic visa doc id for a crawled page.
 *
 * Resolution order:
 *  1. `visaId` pinned on the registry page -> used verbatim (the registry owns
 *     record identity; this is what keeps an id stable across a URL rename).
 *  2. Otherwise `${countryCode.toLowerCase()}-${slug(FULL url path)}`. The whole
 *     path is used (not its last segment) so deep paths on other countries'
 *     sites — e.g. `/work/visa` vs `/study/visa` — never collide.
 *     If the slug exceeds VISA_ID_SLUG_MAX it is truncated and a 6-hex sha256
 *     of the FULL normalised path is appended, so two long paths that share a
 *     prefix still get distinct ids.
 *
 * Deliberately takes no extraction input: `extracted.code` / `extracted.name`
 * must never influence identity.
 */
export function deriveVisaId(params: {
  countryCode: string;
  sourceUrl: string;
  visaId?: string;
}): string {
  const { countryCode, sourceUrl, visaId } = params;
  // 1. Pinned id wins (ignore blank strings so a bad registry edit can't
  //    produce an empty doc id).
  if (visaId && visaId.trim()) return visaId.trim();

  // 2. Path-derived fallback.
  const path = normalizedSourcePath(sourceUrl);
  let pathSlug = slugify(path);
  if (pathSlug.length > VISA_ID_SLUG_MAX) {
    const hash = createHash("sha256").update(path).digest("hex").slice(0, HASH_SUFFIX_LEN);
    // Leave room for "-" + hash; trim a hyphen the cut may leave at the end.
    const head = pathSlug
      .slice(0, VISA_ID_SLUG_MAX - HASH_SUFFIX_LEN - 1)
      .replace(/-+$/, "");
    pathSlug = `${head}-${hash}`;
  }
  return `${countryCode.toLowerCase()}-${pathSlug}`;
}

/**
 * The visa `code` written to the doc: the registry's pinned `visaCode` when
 * set (so scraped records line up with their seeded equivalents for the
 * side-by-side comparison), else whatever the extractor returned.
 */
export function resolveVisaCode(visaCode: string | undefined, extractedCode: string): string {
  return visaCode && visaCode.trim() ? visaCode.trim() : extractedCode;
}

// ----- Registry pins -----

/**
 * One registry-owned override for a page (see VISA_SOURCE_OVERRIDES): pinned
 * identity plus optional section-selection overrides for structured adapters.
 */
export interface VisaSourcePin {
  visaId: string; // the doc id under countries/{cc}/visaTypes
  visaCode?: string; // optional code override (only where a seeded equivalent exists)
  // Slug patterns that REPLACE the adapter's default include/exclude lists for
  // this page (see visa-source-adapters/sections.ts). Optional.
  includeSections?: string[];
  excludeSections?: string[];
  // Surcharges published on a linked page that this route must add (#69).
  linkedSurcharges?: LinkedSurchargeRef[];
  // Supplementary pages (issue #86): URLs of `supplementOnly` rows of the same
  // country whose text is appended to this route's text before extraction.
  supplementaryPages?: string[];
  // True for a row that is not a visa route (e.g. a fee table): never
  // extracted on its own, only fetched as a supplement (issue #86).
  supplementOnly?: boolean;
}

/**
 * Apply a URL-keyed pin map to freshly parsed registry pages.
 *
 * Returns new page objects (inputs are not mutated) plus the set of override
 * URLs that matched one of the given pages, so the caller can warn about map
 * entries that matched nothing (a markdown URL edit silently dropping a pin).
 * Matching is by exact URL string, as written in the markdown.
 */
export function applyVisaSourcePins(
  pages: VisaSourcePage[],
  overrides: Record<string, VisaSourcePin>
): { pages: VisaSourcePage[]; matchedUrls: Set<string> } {
  const matchedUrls = new Set<string>();
  const out = pages.map((page) => {
    const pin = Object.prototype.hasOwnProperty.call(overrides, page.url)
      ? overrides[page.url]
      : undefined;
    if (!pin) return { ...page };
    matchedUrls.add(page.url);
    return {
      ...page,
      visaId: pin.visaId,
      // Only set optional fields when the pin has them, so they stay absent
      // (not `undefined`-valued) on the stored page.
      ...(pin.visaCode ? { visaCode: pin.visaCode } : {}),
      // Section overrides are registry-owned too: copied (fresh arrays) on
      // every seed, so editing the map changes the stored page on re-seed.
      ...(pin.includeSections ? { includeSections: [...pin.includeSections] } : {}),
      ...(pin.excludeSections ? { excludeSections: [...pin.excludeSections] } : {}),
      // Linked-surcharge markers (#69): registry-owned, deep-copied so the
      // stored page never shares objects with the code map.
      ...(pin.linkedSurcharges
        ? { linkedSurcharges: pin.linkedSurcharges.map((r) => ({ ...r, length: { ...r.length } })) }
        : {}),
      // Supplementary pages (#86): registry-owned, fresh array per seed.
      ...(pin.supplementaryPages && pin.supplementaryPages.length > 0
        ? { supplementaryPages: [...pin.supplementaryPages] }
        : {}),
      // Only `true` is stored (absent = an ordinary route page).
      ...(pin.supplementOnly ? { supplementOnly: true } : {}),
    };
  });
  return { pages: out, matchedUrls };
}

// ----- Crawl-state merge (re-seed) -----

/**
 * Page-level fields written by the crawler (not by the seed). These are the
 * ones a re-seed must carry over from the stored page with the same URL.
 */
export const PAGE_CRAWL_STATE_FIELDS = [
  "lastContentHash",
  "lastCrawledAt",
  "lastExtractedAt",
  "lastError",
] as const;

/**
 * Source-level fields owned by the crawler/scheduler that a re-seed keeps from
 * the existing `visaSources/{cc}` doc instead of resetting to defaults.
 */
export const SOURCE_CRAWL_STATE_FIELDS = [
  "createdAt",
  "nextCrawlAt",
  "lastCrawledAt",
  "status",
  "reliabilityScore",
  "consecutiveFailures",
  // Host backoffs (issue #64): a re-seed must not let us hit a host that
  // asked us to wait.
  "hostBackoffs",
] as const;

/**
 * Rebuild a country's page list on re-seed.
 *
 * `freshPages` (markdown + pins) is the source of truth for WHICH pages exist
 * and their seed-owned fields (routeName, validation, notes, visaId, visaCode,
 * includeSections, excludeSections):
 * pages removed from the markdown disappear, new pages start with no crawl
 * state. For every fresh page whose URL matches a stored page, the crawler's
 * fields (PAGE_CRAWL_STATE_FIELDS) are copied over, so the hash gate holds and
 * the next crawl doesn't re-fetch/re-extract everything.
 *
 * Fields that are absent/undefined on the stored page are not copied (no
 * `undefined` values are introduced).
 */
export function mergePageCrawlState(
  freshPages: VisaSourcePage[],
  existingPages: VisaSourcePage[] | undefined
): VisaSourcePage[] {
  // Index stored pages by URL (first one wins if the stored list had dupes).
  const byUrl = new Map<string, VisaSourcePage>();
  for (const p of existingPages || []) {
    if (p && typeof p.url === "string" && !byUrl.has(p.url)) byUrl.set(p.url, p);
  }
  return freshPages.map((fresh) => {
    const prev = byUrl.get(fresh.url);
    if (!prev) return { ...fresh };
    const merged: VisaSourcePage = { ...fresh };
    for (const field of PAGE_CRAWL_STATE_FIELDS) {
      const value = prev[field];
      if (value !== undefined && value !== null) {
        // Cast: each field keeps its own type; TS can't narrow the union key.
        (merged as unknown as Record<string, unknown>)[field] = value;
      }
    }
    return merged;
  });
}

/**
 * Pick the source-level crawl-state fields (SOURCE_CRAWL_STATE_FIELDS) that are
 * present on an existing `visaSources/{cc}` doc, for the re-seed to keep.
 * Returns `{}` for a brand-new country (no existing doc), so defaults apply.
 */
export function pickSourceCrawlState(
  existing: Record<string, unknown> | undefined
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!existing) return out;
  for (const field of SOURCE_CRAWL_STATE_FIELDS) {
    const value = existing[field];
    if (value !== undefined && value !== null) out[field] = value;
  }
  return out;
}
