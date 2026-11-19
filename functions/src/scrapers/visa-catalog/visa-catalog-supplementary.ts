import { createHash } from "crypto";
import type { VisaSourcePage, VisaSupplementaryPageMeta } from "./types";
// Pure adapter contract only (no Firebase): the fetched document shape.
import type { SourceDocument } from "./adapters/types";

// ============================================
// VISA CATALOG — SUPPLEMENTARY PAGES (issue #86)
// ============================================
//
// Some official route pages describe a visa but leave out its fee (and/or
// processing time), which another official page of the same country
// publishes. South Korea is the first case: the Ministry of Justice HiKorea
// guide for the Temporary Visit (C-3) visa gives ~870 characters of purpose +
// documents and no fee, while the Korea Visa Portal's static fee table
// (www.visa.go.kr, MENU_ID=10103) states "90 days or less Single-entry visa
// USD 40". Extracting the C-3 page alone gave a 40%-confidence visa with no
// fee and fake 0 processing days.
//
// How it works:
//   1. REGISTRY: the fee table is its own row in the verified-links markdown
//      (so it is reviewed + TEXT-VERIFIED like every other source), pinned in
//      VISA_SOURCE_OVERRIDES with `supplementOnly: true`. The route row's pin
//      lists it in `supplementaryPages`.
//   2. CRAWL: a `supplementOnly` page is never extracted on its own (it is
//      not a visa). For a route that lists supplements, each supplement is
//      fetched AT MOST ONCE per run (SupplementaryPageCache, through the
//      source's adapter, so robots / rate limit / host backoff all apply) and
//      its text is APPENDED to the route text under a clear header
//      (combineSupplementaryText). The extractor then sees both pages and
//      cites from either. The extractor PROMPT is unchanged (owned by #87):
//      this only changes the page content handed to it.
//   3. HASH GATE: the route's change-detection hash folds in each
//      supplement's hash (supplementaryGateHash), so a fee change on the
//      supplement re-stages the route even when the route page is unchanged.
//   4. PROVENANCE: scrapeMeta.supplementaryPages lists the pages used.
//
// Fail closed: a route whose supplement cannot be fetched (or that names a
// URL which is not a `supplementOnly` row of the same source) is NOT
// extracted — extracting it without the supplement would silently lose the
// fee again. The error is recorded on the route page like any page error.
//
// Pure module apart from the injected fetch function: importable without
// Firebase Admin (unit tests use it directly).

/** Thrown when a route's supplementary page can't be used. */
export class SupplementaryPageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SupplementaryPageError";
  }
}

/** A supplementary registry page together with its fetched document. */
export interface ResolvedSupplementaryPage {
  page: VisaSourcePage; // the registry row (supplementOnly)
  doc: SourceDocument; // as fetched this run
}

/** Fetches one supplementary page (the crawl wires the source adapter in). */
export type SupplementaryPageFetcher = (page: VisaSourcePage) => Promise<SourceDocument>;

/**
 * Fetch each supplementary page AT MOST ONCE per crawl run, however many
 * routes use it. The promise is cached, including a failure (e.g. a 429): a
 * page that failed is not requested again in the same run, and every route
 * that needs it gets the same error.
 */
export class SupplementaryPageCache {
  private readonly byUrl = new Map<string, Promise<SourceDocument>>();

  /** @param fetcher fetches the page (crawl: the source adapter, behind the host-backoff check) */
  constructor(private readonly fetcher: SupplementaryPageFetcher) {}

  /** The fetched document for a supplementary registry page (fetched on first use). */
  get(page: VisaSourcePage): Promise<SourceDocument> {
    let pending = this.byUrl.get(page.url);
    if (!pending) {
      pending = this.fetcher(page);
      this.byUrl.set(page.url, pending);
    }
    return pending;
  }

  /**
   * Resolve every supplementary page a route lists ([] when it lists none —
   * the common case, no request). `sourcePages` is the country's full page
   * list: each listed URL must be one of its rows AND marked
   * `supplementOnly` (a registry typo, or pointing at another visa route,
   * throws instead of mixing two visas into one extraction). A withdrawn
   * supplement throws too. Throws the first failure.
   */
  async forPage(
    route: Pick<VisaSourcePage, "url" | "supplementaryPages">,
    sourcePages: readonly VisaSourcePage[]
  ): Promise<ResolvedSupplementaryPage[]> {
    const urls = Array.isArray(route.supplementaryPages) ? route.supplementaryPages : [];
    const out: ResolvedSupplementaryPage[] = [];
    for (const url of urls) {
      const page = sourcePages.find((p) => p.url === url);
      if (!page) {
        throw new SupplementaryPageError(
          `supplementary page ${url} of ${route.url} is not a row of this source — check VISA_SOURCE_OVERRIDES`
        );
      }
      if (!page.supplementOnly) {
        throw new SupplementaryPageError(
          `supplementary page ${url} of ${route.url} is not marked supplementOnly — check VISA_SOURCE_OVERRIDES`
        );
      }
      const doc = await this.get(page);
      if (doc.withdrawn) {
        throw new SupplementaryPageError(`supplementary page ${url} of ${route.url} is withdrawn`);
      }
      out.push({ page, doc });
    }
    return out;
  }
}

/**
 * The header written above each appended supplementary page. It names the
 * page and its URL so the model (and a human reading the stored hash input)
 * can tell which official page a quote came from.
 */
export function supplementaryHeader(page: Pick<VisaSourcePage, "routeName" | "url">): string {
  return `--- SUPPLEMENTARY OFFICIAL PAGE (same country): ${page.routeName} — ${page.url} ---`;
}

/**
 * The text handed to the extractor: the route page's own text, then each
 * supplementary page under its header, in registry order. Unchanged route
 * text when there are none.
 */
export function combineSupplementaryText(routeText: string, supplements: ResolvedSupplementaryPage[]): string {
  if (supplements.length === 0) return routeText;
  const parts = [routeText];
  for (const s of supplements) parts.push(`${supplementaryHeader(s.page)}\n${s.doc.text}`);
  return parts.join("\n\n");
}

/**
 * The route's change-detection hash with its supplements folded in: the page
 * hash itself when there are none (unchanged behaviour for every other
 * route), else sha256 over the page hash and each supplement's URL + hash.
 */
export function supplementaryGateHash(pageHash: string, supplements: ResolvedSupplementaryPage[]): string {
  if (supplements.length === 0) return pageHash;
  const parts = [pageHash, ...supplements.map((s) => `supplement:${s.page.url}:${s.doc.contentHash}`)];
  return createHash("sha256").update(parts.join("\n")).digest("hex");
}

/** Provenance for scrapeMeta.supplementaryPages (optional fields absent, never `undefined`). */
export function supplementaryPagesMeta(supplements: ResolvedSupplementaryPage[]): VisaSupplementaryPageMeta[] {
  return supplements.map((s) => {
    const meta: VisaSupplementaryPageMeta = {
      url: s.page.url,
      routeName: s.page.routeName,
      contentHash: s.doc.contentHash,
    };
    if (s.doc.sourceUpdatedAt) meta.sourceUpdatedAt = s.doc.sourceUpdatedAt;
    return meta;
  });
}
