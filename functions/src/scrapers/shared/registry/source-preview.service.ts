import { isBlockedAddressError, asBlockedAddressError } from "../fetch/address-guard";
import {
  HostNotAllowedError,
  isHostNotAllowedError,
  visaCatalogFetchService,
  type FetchedPage,
} from "../fetch/visa-catalog-fetch.service";
import { describeError } from "../fetch/redact";
import { isHostBackoffError } from "../etiquette/visa-crawl-host-state";
import { PdfFetchError } from "../fetch/pdf-text";
import { parseRegistryUrl } from "./registry-address";
import { RegistryError } from "./registry-errors";

// ============================================
// SOURCE REGISTRY — ADDRESS PREVIEW (issue #215)
// ============================================
//
// "Read this address and tell me what it is." The ONE place the registry API
// fetches anything. It goes through the shared guarded fetch service
// (`visaCatalogFetchService`) and never through a raw HTTP call, so every
// protection of that service applies:
//   - the bot User-Agent and robots.txt (a page robots.txt disallows is
//     refused, exactly as the crawl would refuse it);
//   - the per-host spacing and 429/503 back-off;
//   - the address guard: IP literals and non-web ports refused before any
//     request, every DNS answer checked at connect time (private, loopback,
//     link-local, metadata, CGNAT, multicast), redirects limited to 5 hops with
//     each hop's address checked, no proxy;
//   - the size caps (5 MB of HTML, PDF byte / page / text limits) enforced while
//     the body streams, and the time caps (15 s per request, 60 s per body,
//     15 s idle between chunks);
//   - a fixed refusal message that never echoes a resolved address.
//
// Two modes:
//   - "check": the single explicit "check this address" action. The host does
//     NOT need to be confirmed (that is its purpose: showing the admin what a
//     site serves BEFORE they confirm it). Redirects to a DIFFERENT host are
//     followed (the guard still judges them) but reported loudly
//     (`redirectedToOtherHost`), and a confirmation refuses a preview whose
//     final host is not the host being confirmed.
//   - "register": used when saving a route. The host must already be confirmed,
//     and the policy covers the requested host, every redirect hop and the final
//     URL: a redirect to a host that is not confirmed is REFUSED before that hop
//     is requested.

/** What the preview reports (also the evidence stored with a confirmation). */
export interface AddressPreview {
  requestedUrl: string;
  host: string;
  finalUrl: string;
  finalHost: string;
  redirected: boolean;
  redirectedToOtherHost: boolean;
  httpStatus: number;
  docType: "html" | "pdf";
  // `<html lang>` as written (HTML only), else null.
  language: string | null;
  title: string | null;
  characterCount: number;
  // First 300 characters of the clean text, whitespace-collapsed.
  openingText: string;
  // sha256 of the clean text (the crawl's own change key).
  contentHash: string;
}

/** Characters of opening text shown. */
export const PREVIEW_OPENING_CHARS = 300;

/** How a page will be used, which decides what the fetch accepts. */
export type PreviewPurpose = "check" | "visa_page" | "guidance_html" | "guidance_pdf";

/** Optional pieces a caller may inject (tests). */
export interface PreviewOptions {
  purpose: PreviewPurpose;
  // Host policy (register mode). Absent = the "check" action.
  allowedHost?: (host: string) => boolean;
  // Longest HTML text accepted for a guidance page (the crawl refuses longer ones).
  maxHtmlTextChars?: number;
}

/** The fetch surface the preview needs (the shared service satisfies it). */
export interface PreviewFetcher {
  fetchAndClean(
    url: string,
    options?: { checkRobots?: boolean; acceptPdf?: boolean; maxHtmlTextChars?: number; allowedHost?: (host: string) => boolean }
  ): Promise<FetchedPage>;
}

class SourcePreviewService {
  /** The fetcher; tests inject a fake. Production: the shared guarded service. */
  fetcher: PreviewFetcher = visaCatalogFetchService;

  /**
   * Read `url` and describe it. Throws RegistryError for every refusal:
   *   400 INVALID_ADDRESS family (shape, nothing requested),
   *   422 ADDRESS_NOT_ALLOWED (address guard), 422 HOST_NOT_CONFIRMED (register mode),
   *   422 WRONG_DOCUMENT_TYPE, 502 FETCH_FAILED (anything else the fetch said).
   */
  async preview(rawUrl: string, options: PreviewOptions): Promise<AddressPreview> {
    // 1. Shape. Nothing is requested for a bad shape.
    const parsed = parseRegistryUrl(rawUrl);
    if (!parsed.ok) throw new RegistryError(parsed.code, 400, parsed.message);

    // 2. Fetch through the guarded service.
    let page: FetchedPage;
    try {
      page = await this.fetcher.fetchAndClean(parsed.url.href, {
        checkRobots: true,
        // The visa page goes to the generic-html adapter, which refuses PDFs.
        acceptPdf: options.purpose !== "visa_page",
        ...(options.maxHtmlTextChars !== undefined ? { maxHtmlTextChars: options.maxHtmlTextChars } : {}),
        ...(options.allowedHost ? { allowedHost: options.allowedHost } : {}),
      });
    } catch (err) {
      throw this.translate(err, parsed.host);
    }

    const docType: "html" | "pdf" = page.pdf ? "pdf" : "html";
    // 3. The document must be the kind the caller declared.
    if (options.purpose === "guidance_html" && docType !== "html") {
      throw new RegistryError("WRONG_DOCUMENT_TYPE", 422, "This address serves a PDF but was declared as a web page");
    }
    if (options.purpose === "guidance_pdf" && docType !== "pdf") {
      throw new RegistryError("WRONG_DOCUMENT_TYPE", 422, "This address serves a web page but was declared as a PDF");
    }

    let finalHost = parsed.host;
    try {
      finalHost = new URL(page.finalUrl).hostname.toLowerCase();
    } catch {
      /* keep the requested host */
    }
    const text = page.cleanText.replace(/\s+/g, " ").trim();
    return {
      requestedUrl: parsed.url.href,
      host: parsed.host,
      finalUrl: page.finalUrl,
      finalHost,
      redirected: page.finalUrl !== parsed.url.href,
      redirectedToOtherHost: finalHost !== parsed.host,
      httpStatus: page.httpStatus,
      docType,
      language: docType === "html" ? (page.htmlLang ?? null) : null,
      title: docType === "html" ? (page.title ?? null) : null,
      characterCount: page.cleanText.length,
      openingText: text.slice(0, PREVIEW_OPENING_CHARS),
      contentHash: page.contentHash,
    };
  }

  /** Turn whatever the fetch threw into a RegistryError an admin can read. */
  private translate(err: unknown, host: string): RegistryError {
    if (isBlockedAddressError(err)) {
      // The guard's own fixed text; it never names a resolved address.
      return new RegistryError("ADDRESS_NOT_ALLOWED", 422, asBlockedAddressError(err)!.message);
    }
    if (isHostNotAllowedError(err)) {
      const e = err as HostNotAllowedError;
      return new RegistryError("HOST_NOT_CONFIRMED", 422, e.message, { hosts: [e.host] });
    }
    if (isHostBackoffError(err)) {
      return new RegistryError("FETCH_FAILED", 502, `${host} asked us to slow down; try again later`);
    }
    if (err instanceof PdfFetchError) {
      return new RegistryError("FETCH_FAILED", 502, `The document could not be read: ${err.message}`.slice(0, 300));
    }
    return new RegistryError("FETCH_FAILED", 502, `The page could not be read: ${describeError(err)}`.slice(0, 300));
  }
}

export const sourcePreviewService = new SourcePreviewService();
