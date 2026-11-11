import type { VisaSourcePage } from "../types";
import type { VisaCatalogFetchService } from "../../shared/fetch/visa-catalog-fetch.service";
import type { SourceAdapter, SourceDocument } from "./types";

// ============================================
// SOURCE ADAPTER — generic-html (default)
// ============================================
//
// Today's HTML path, wrapped as an adapter with UNCHANGED behaviour: it simply
// delegates to `VisaCatalogFetchService.fetchAndClean()` — same robots check,
// 1.5s/host rate limit, UA, boilerplate cleaning, 24_000-char cap and
// "Too little content" error.
//
// PDFs (issue #33): the fetch service can read PDFs, but this adapter does
// NOT accept them. It hands its whole text to the paid extractor, which is
// sized for one web page (24,000 characters); a guidance PDF can be forty
// times that, and how such documents are split up is not decided yet (#39,
// #111). So a page that serves, or redirects to, a PDF is refused with a
// clear reason (`PdfFetchError` "not-accepted", logged by the fetch service)
// before the PDF is even downloaded. It is never truncated to fit. Callers
// that want PDF text call `fetchAndClean()` themselves.
//
// Hash compatibility (important for deploy): `text` is the cleaned page text
// exactly as before and `contentHash` is fetchAndClean's own hash of it, so a
// page's stored `lastContentHash` still matches after deploy and non-GB pages
// do NOT re-extract. A unit test asserts the hashes are identical.

/** Slug of the single whole-page section generic-html returns. */
export const GENERIC_HTML_SECTION_SLUG = "page";

export class GenericHtmlAdapter implements SourceAdapter {
  readonly id = "generic-html" as const;

  /** @param fetchService the shared fetch service (client, rate limit, robots). */
  constructor(private readonly fetchService: VisaCatalogFetchService) {}

  /** Any http(s) URL — this is the fallback adapter. */
  canHandle(url: string): boolean {
    try {
      const { protocol } = new URL(url);
      return protocol === "http:" || protocol === "https:";
    } catch {
      return false;
    }
  }

  /** Fetch + clean the page; one section holding the whole cleaned text. */
  async fetch(page: VisaSourcePage): Promise<SourceDocument> {
    // Throws on robots block / non-2xx / too little content — unchanged.
    // `acceptPdf: false`: a PDF response is refused, not extracted (see the
    // header comment).
    const fetched = await this.fetchService.fetchAndClean(page.url, { checkRobots: true, acceptPdf: false });
    return {
      url: page.url,
      canonicalUrl: fetched.finalUrl,
      sourceProvider: this.id,
      withdrawn: false, // HTML pages carry no machine-readable withdrawn signal
      sections: [
        { slug: GENERIC_HTML_SECTION_SLUG, title: page.routeName, text: fetched.cleanText },
      ],
      // Exactly the text + hash the crawl used before adapters existed.
      text: fetched.cleanText,
      contentHash: fetched.contentHash,
    };
  }
}
