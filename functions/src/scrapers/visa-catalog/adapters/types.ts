import type { SourceAdapterId, VisaSourcePage } from "../types";

// ============================================
// VISA CATALOG — SOURCE ADAPTER CONTRACT
// ============================================
//
// The pipeline is shared (hash gate → LLM extractor → ingest); only FETCHING
// differs by kind of source. Each kind implements `SourceAdapter` and returns a
// `SourceDocument`, which is all the rest of the pipeline sees. See
// src/scrapers/visa-catalog/docs/visa-scraper-uk-reference.md §4.1.
//
//   registry row ──► SourceAdapter.fetch(page) ──► SourceDocument ──► extractor
//                     │ govuk-content-api (GB)
//                     │ generic-html      (everyone else)
//
// Adapters are per source TYPE, not per country: adding a country is a registry
// row; code is only needed for a new kind of structured source.
//
// IMPORTANT: adapter modules must stay importable WITHOUT Firebase Admin init
// (no `utils/firebase`) so the unit tests in `functions/test/` can use them.

/** One section of a source document (a GOV.UK guide part; generic-html: the whole page). */
export interface SourceSection {
  slug: string; // stable machine id, e.g. "how-much-it-costs" ("page" for generic-html)
  title: string; // human title, e.g. "How much it costs"
  text: string; // plain text (no markup) of the section
}

/** What every adapter returns for one registry page. */
export interface SourceDocument {
  url: string; // the registry page URL that was requested
  canonicalUrl: string; // the page's canonical/final URL (after redirects / base_path)
  sourceProvider: SourceAdapterId; // which adapter produced this document
  sourceDocumentId?: string; // source's stable id (GOV.UK `content_id`), if any
  sourceUpdatedAt?: string; // when the source last changed (GOV.UK `updated_at`), if known
  // True when the source says the page is withdrawn (GOV.UK `withdrawn_notice`).
  // A withdrawn document carries NO sections/text: the crawl must not extract.
  withdrawn: boolean;
  // The SELECTED sections, in source order (generic-html → exactly one).
  sections: SourceSection[];
  // The exact text handed to `VisaCatalogExtractor.extract()` as `cleanText`:
  // selected sections, formatted and capped. generic-html: the cleaned page.
  text: string;
  // sha256 of `text` — i.e. over the selected, capped text actually sent to the
  // extractor. The change-detection key compared with `page.lastContentHash`.
  contentHash: string;
  // True when the selected text exceeded the adapter cap and `text` was cut.
  // Only structured adapters set it (generic-html keeps its historic cap).
  truncated?: boolean;
}

/** One implementation per kind of source, not per country. */
export interface SourceAdapter {
  readonly id: SourceAdapterId;
  /** True when this adapter can fetch `url` (e.g. govuk: host is www.gov.uk). */
  canHandle(url: string): boolean;
  /**
   * Fetch + convert one registry page. THROWS on any failure (robots-blocked,
   * non-2xx, bad payload, nothing selected…) so the crawl records it as the
   * page's `lastError` without extracting.
   */
  fetch(page: VisaSourcePage): Promise<SourceDocument>;
}
