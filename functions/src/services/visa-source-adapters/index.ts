import type { SourceAdapterId, VisaScrapeMeta } from "../../types/visa-catalog";
import { visaCatalogFetchService, type VisaCatalogFetchService } from "../visa-catalog-fetch.service";
import { GenericHtmlAdapter } from "./generic-html.adapter";
import { GovukContentApiAdapter } from "./govuk-content-api.adapter";
import type { SourceAdapter, SourceDocument } from "./types";

// ============================================
// SOURCE ADAPTER REGISTRY
// ============================================
//
// Maps a registry `VisaSource.adapter` id to its implementation and picks the
// adapter for one page. Both crawl entry points (scheduled orchestrator and the
// manual crawl script) go through `pickSourceAdapter()`, so they fetch the
// same way.

export * from "./types";
export { GenericHtmlAdapter, GENERIC_HTML_SECTION_SLUG } from "./generic-html.adapter";
export {
  GovukContentApiAdapter,
  GOVUK_MAX_TEXT_CHARS,
  govukContentApiUrl,
  isWithdrawnNotice,
} from "./govuk-content-api.adapter";

/** Adapter used when a source has no `adapter` set. */
export const DEFAULT_SOURCE_ADAPTER: SourceAdapterId = "generic-html";

/** One instance of each adapter, all sharing one fetch service. */
export type SourceAdapterSet = Record<SourceAdapterId, SourceAdapter>;

/**
 * Build the adapter set over a fetch service. Production uses the singleton
 * (`sourceAdapters` below); tests pass a fetch service with a stubbed client.
 */
export function createSourceAdapters(fetchService: VisaCatalogFetchService): SourceAdapterSet {
  return {
    "generic-html": new GenericHtmlAdapter(fetchService),
    "govuk-content-api": new GovukContentApiAdapter(fetchService),
  };
}

/** Production adapters over the shared fetch-service singleton. */
export const sourceAdapters: SourceAdapterSet = createSourceAdapters(visaCatalogFetchService);

/**
 * Adapter for one page of a source:
 *  - the source's `adapter` (absent → "generic-html"; an unknown id → too), but
 *  - if that adapter can't handle this page's URL (e.g. a non-www.gov.uk link in
 *    a GB list), fall back to generic-html for that page rather than failing.
 */
export function pickSourceAdapter(
  adapterId: SourceAdapterId | undefined,
  pageUrl: string,
  adapters: SourceAdapterSet = sourceAdapters
): SourceAdapter {
  const chosen = adapters[adapterId ?? DEFAULT_SOURCE_ADAPTER] ?? adapters[DEFAULT_SOURCE_ADAPTER];
  return chosen.canHandle(pageUrl) ? chosen : adapters[DEFAULT_SOURCE_ADAPTER];
}

/** The provenance subset of VisaScrapeMeta that comes from the source document. */
export type ScrapeSourceMeta = Pick<
  VisaScrapeMeta,
  "sourceProvider" | "sourceDocumentId" | "sourceUpdatedAt" | "sectionsUsed" | "truncated"
>;

/**
 * Provenance to pass to `ingestExtraction({ sourceMeta })` for a fetched doc.
 * Only defined values are set (no `undefined` keys). generic-html records
 * `sourceProvider` only (its single whole-page section is not a "section used").
 */
export function sourceMetaFromDocument(doc: SourceDocument): ScrapeSourceMeta {
  const meta: ScrapeSourceMeta = { sourceProvider: doc.sourceProvider };
  if (doc.sourceDocumentId) meta.sourceDocumentId = doc.sourceDocumentId;
  if (doc.sourceUpdatedAt) meta.sourceUpdatedAt = doc.sourceUpdatedAt;
  if (doc.sourceProvider !== "generic-html") {
    meta.sectionsUsed = doc.sections.map((s) => s.slug);
    meta.truncated = Boolean(doc.truncated);
  }
  return meta;
}
