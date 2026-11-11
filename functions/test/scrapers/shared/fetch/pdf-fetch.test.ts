// ============================================
// PDF fetching (issue #33) — unit tests, no network
// ============================================
//
// Covers the PDF path of VisaCatalogFetchService.fetchAndClean() and the pure
// helpers in src/scrapers/shared/fetch/pdf-text.ts, against small synthetic
// PDFs built in memory (test/helpers/pdf-fixture.ts) and a stubbed HTTP
// client. The real guidance PDFs are exercised by the opt-in live test next
// to this file (pdf-live.integration.test.ts), which is skipped by default.
//
// The fixture text is generic on purpose: nothing in the fetcher is specific
// to a country, route or publisher, and the hosts below are made up.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import {
  MAX_CLEAN_TEXT_CHARS,
  MAX_HTML_BYTES,
  VisaCatalogFetchService,
  VisaCatalogHttpClient,
} from "../../../../src/scrapers/shared/fetch/visa-catalog-fetch.service";
import {
  DEFAULT_PDF_LIMITS,
  PDF_PAGE_SEPARATOR,
  PdfFailureReason,
  PdfLimits,
  assemblePdfText,
  cleanPdfPageText,
  findPdfQuote,
  hasPdfMagic,
  isPdfFetchError,
  isPdfResponse,
  normalizeForQuoteMatch,
  pdfPageAtOffset,
} from "../../../../src/scrapers/shared/fetch/pdf-text";
import { isHostBackoffError } from "../../../../src/scrapers/shared/etiquette/visa-crawl-host-state";
import { GenericHtmlAdapter } from "../../../../src/scrapers/visa-catalog/adapters/generic-html.adapter";
import { buildPdf, deflatedPaddedContent } from "../../../helpers/pdf-fixture";

// ----- Fixtures -----

const HOST = "guidance.example.org";
const PDF_URL = `https://${HOST}/media/abc123/caseworker-guidance.pdf`;
const ROBOTS_URL = `https://${HOST}/robots.txt`;

// A sentence long enough that every fixture page clears the 100-character
// "has a text layer" floor on its own.
const FILLER =
  "The decision maker must consider all of the evidence provided and record the reasons for the decision.";

// Three pages of plain guidance-like text. Page 2 carries a sentence that is
// broken across two lines, the way a PDF wraps a paragraph.
const PAGE_1 = `Guidance for decision makers\nVersion 3.0\n${FILLER}`;
const PAGE_2 =
  "Genuine intention to visit\nThe applicant must satisfy the decision maker that they\n" +
  `will leave at the end of their visit.\n${FILLER}`;
const PAGE_3 = `Refusal wording\nUse the standard paragraphs.\n${FILLER}`;
const THREE_PAGES = [PAGE_1, PAGE_2, PAGE_3];

/** sha256 hex, independently of the service. */
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

// ----- Stub HTTP client -----

/** One stubbed response. `body` may be text, bytes or a stream. */
interface StubResponse {
  status?: number; // default 200
  body?: string | Buffer | Readable;
  contentType?: string;
  headers?: Record<string, unknown>; // extra headers (content-length, retry-after, …)
  responseUrl?: string; // post-redirect URL, as axios's Node adapter reports it
}

/** A recorded request: what was asked for, how, and when. */
interface StubCall {
  url: string;
  responseType?: string;
  headers?: Record<string, string>;
  maxContentLength?: number;
  at: number;
}

/**
 * Fetch service over a stub client that serves `routes[url]` (404 when
 * absent; robots.txt is "allow everything" unless a route says otherwise) and
 * records every call. A route may be a function, to build a fresh response
 * (e.g. a new stream) per request.
 */
function serviceWith(
  routes: Record<string, StubResponse | (() => StubResponse)>,
  options: {
    pdf?: Partial<PdfLimits>;
    minIntervalMs?: number;
    bodyTimeoutMs?: number;
    bodyIdleTimeoutMs?: number;
  } = {}
) {
  const calls: StubCall[] = [];
  const http: VisaCatalogHttpClient = {
    async get(url, config) {
      calls.push({
        url,
        responseType: config?.responseType,
        headers: config?.headers,
        maxContentLength: config?.maxContentLength,
        at: Date.now(),
      });
      const route = routes[url];
      const r: StubResponse =
        (typeof route === "function" ? route() : route) ??
        (url.endsWith("/robots.txt")
          ? { status: 200, body: "", contentType: "text/plain" }
          : { status: 404, body: "<html>not found</html>", contentType: "text/html" });
      return {
        status: r.status ?? 200,
        data: r.body ?? "",
        headers: { "content-type": r.contentType ?? "", ...(r.headers ?? {}) },
        ...(r.responseUrl ? { request: { res: { responseUrl: r.responseUrl } } } : {}),
      };
    },
  };
  const service = new VisaCatalogFetchService({
    http,
    minIntervalMs: options.minIntervalMs ?? 0,
    pdf: options.pdf,
    bodyTimeoutMs: options.bodyTimeoutMs,
    bodyIdleTimeoutMs: options.bodyIdleTimeoutMs,
  });
  return { service, calls };
}

/** A PDF served with the proper content type. */
const pdfRoute = (pages: string[], extra: Partial<StubResponse> = {}): StubResponse => ({
  body: buildPdf(pages),
  contentType: "application/pdf",
  ...extra,
});

/** Assert `p` rejects with a PdfFetchError of the given reason; return it. */
async function rejectsWithReason(p: Promise<unknown>, reason: PdfFailureReason) {
  let caught: unknown;
  await assert.rejects(p, (err: unknown) => {
    caught = err;
    assert.ok(isPdfFetchError(err), `expected PdfFetchError, got ${String(err)}`);
    assert.equal(err.reason, reason);
    // The message alone must say why (callers often only keep err.message).
    assert.ok(err.message.length > 20);
    return true;
  });
  if (!isPdfFetchError(caught)) throw new Error("unreachable");
  return caught;
}

/** Silence console.warn for one call (rejections are logged by the service). */
async function quietly<T>(fn: () => Promise<T>): Promise<{ result: T | undefined; warnings: string[]; error?: unknown }> {
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  };
  try {
    return { result: await fn(), warnings };
  } catch (error) {
    return { result: undefined, warnings, error };
  } finally {
    console.warn = original;
  }
}

/** Run a fetch expected to be refused; return the error and what was logged. */
async function refused(p: () => Promise<unknown>, reason: PdfFailureReason) {
  const out = await quietly(p);
  assert.ok(out.error, "expected the fetch to be refused");
  const err = await rejectsWithReason(Promise.reject(out.error), reason);
  return { err, warnings: out.warnings };
}

// ============================================
// Detection
// ============================================

describe("PDF detection (isPdfResponse / hasPdfMagic)", () => {
  test("application/pdf is a PDF whatever the URL looks like", () => {
    assert.equal(isPdfResponse("application/pdf", "https://x.example/download?id=7"), true);
    assert.equal(isPdfResponse("Application/PDF; charset=binary", "https://x.example/doc"), true);
    assert.equal(isPdfResponse("application/x-pdf", "https://x.example/doc"), true);
  });

  test("a generic content type falls back to the .pdf URL suffix", () => {
    for (const generic of ["application/octet-stream", "binary/octet-stream", "", "application/force-download"]) {
      assert.equal(isPdfResponse(generic, "https://x.example/a/Guide.PDF?v=2"), true, generic);
      assert.equal(isPdfResponse(generic, "https://x.example/a/guide"), false, generic);
    }
    // The suffix may only appear after a redirect.
    assert.equal(isPdfResponse("application/octet-stream", "https://x.example/latest", "https://cdn.example/g.pdf"), true);
  });

  test("a specific non-PDF content type is believed, even on a .pdf URL", () => {
    assert.equal(isPdfResponse("text/html; charset=utf-8", "https://x.example/guide.pdf"), false);
    assert.equal(isPdfResponse("application/json", "https://x.example/guide.pdf"), false);
  });

  test("magic bytes: %PDF- at the start, or within the first 1024 bytes", () => {
    assert.equal(hasPdfMagic(buildPdf([FILLER])), true);
    assert.equal(hasPdfMagic(buildPdf([FILLER], { prefix: "\n\n" })), true);
    assert.equal(hasPdfMagic(Buffer.from("<!doctype html><html><body>Sign in</body></html>")), false);
    assert.equal(hasPdfMagic(Buffer.alloc(0)), false);
    // Too deep into the file to count as a header.
    assert.equal(hasPdfMagic(Buffer.concat([Buffer.alloc(2000, 0x20), Buffer.from("%PDF-1.4")])), false);
  });
});

// ============================================
// Routing + extraction through fetchAndClean
// ============================================

describe("fetchAndClean — PDF responses", () => {
  test("a PDF is requested as a binary stream and routed to the text extractor", async () => {
    const { service, calls } = serviceWith({ [PDF_URL]: pdfRoute(THREE_PAGES) });
    const page = await service.fetchAndClean(PDF_URL, { checkRobots: true });

    // One request for the document (after robots.txt), as a stream, with no
    // per-request header override (so the client's bot User-Agent applies).
    assert.deepEqual(calls.map((c) => c.url), [ROBOTS_URL, PDF_URL]);
    assert.equal(calls[1].responseType, "stream");
    assert.equal(calls[1].headers, undefined);
    // The client-level size limit is lifted to the PDF cap for this request.
    assert.equal(calls[1].maxContentLength, DEFAULT_PDF_LIMITS.maxBytes);

    assert.equal(page.httpStatus, 200);
    assert.equal(page.url, PDF_URL);
    assert.ok(page.pdf, "PDF results carry the per-page structure");
    assert.equal(page.pdf.pageCount, 3);
    assert.deepEqual(page.pdf.pages, THREE_PAGES);
    assert.equal(page.cleanText, THREE_PAGES.join(PDF_PAGE_SEPARATOR));
    assert.equal(page.pdf.cleanText, page.cleanText);
    assert.deepEqual(page.pdf.pagesWithoutText, []);
  });

  test("a generic content type on a .pdf URL is read as a PDF; a stream body works", async () => {
    const { service } = serviceWith({
      [PDF_URL]: () => ({
        // Served in small chunks, as a real download arrives.
        body: Readable.from(chunked(buildPdf(THREE_PAGES), 257)),
        contentType: "application/octet-stream",
      }),
    });
    const page = await service.fetchAndClean(PDF_URL);
    assert.deepEqual(page.pdf?.pages, THREE_PAGES);
  });

  test("the .pdf suffix may come from the post-redirect URL", async () => {
    const start = `https://${HOST}/guidance/latest`;
    const { service } = serviceWith({
      [start]: { body: buildPdf(THREE_PAGES), contentType: "binary/octet-stream", responseUrl: PDF_URL },
    });
    const page = await service.fetchAndClean(start);
    assert.equal(page.finalUrl, PDF_URL);
    assert.equal(page.pdf?.pageCount, 3);
  });

  test("a .pdf URL that serves real HTML takes the HTML path", async () => {
    const html = `<html><body><main><h1>Moved</h1><p>${FILLER} ${FILLER}</p></main></body></html>`;
    const { service } = serviceWith({ [PDF_URL]: { body: html, contentType: "text/html" } });
    const page = await service.fetchAndClean(PDF_URL);
    assert.equal(page.pdf, undefined);
    assert.ok(page.cleanText.startsWith("Moved"));
  });
});

/** Split a buffer into chunks of `size` bytes. */
function chunked(buf: Buffer, size: number): Buffer[] {
  const out: Buffer[] = [];
  for (let i = 0; i < buf.length; i += size) out.push(buf.subarray(i, i + size));
  return out;
}

// ============================================
// Hash gate
// ============================================

describe("fetchAndClean — PDF hash gate", () => {
  test("contentHash is the sha256 of the clean text, as for HTML", async () => {
    const { service } = serviceWith({ [PDF_URL]: pdfRoute(THREE_PAGES) });
    const page = await service.fetchAndClean(PDF_URL);
    assert.equal(page.contentHash, sha256(page.cleanText));
    assert.equal(page.contentHash, sha256(THREE_PAGES.join("\f")));
  });

  test("an unchanged PDF re-crawls to the same hash; a changed one does not", async () => {
    // Fresh bytes per request: the hash must depend on the text, not on the
    // identity of the buffer.
    let pages = THREE_PAGES;
    const { service } = serviceWith({ [PDF_URL]: () => pdfRoute(pages) });

    // First crawl.
    const first = await service.fetchAndClean(PDF_URL, { checkRobots: true });
    assert.equal(first.cleanText, THREE_PAGES.join(PDF_PAGE_SEPARATOR));

    // Second crawl of the same document: identical hash. A crawl compares
    // this with the hash it stored last time and, when equal, skips
    // extraction (the "Hash gate" in visa-catalog-crawl.service.ts does this
    // for web pages): zero downstream work for an unchanged PDF.
    const second = await service.fetchAndClean(PDF_URL, { checkRobots: true });
    assert.equal(second.contentHash, first.contentHash);
    const changedOnRecrawl = second.contentHash !== first.contentHash;
    assert.equal(changedOnRecrawl, false);

    // A new release with one edited sentence: the hash moves.
    pages = [PAGE_1, PAGE_2.replace("will leave", "will depart"), PAGE_3];
    const third = await service.fetchAndClean(PDF_URL, { checkRobots: true });
    assert.notEqual(third.contentHash, first.contentHash);
  });

  test("the hash ignores how the PDF bytes differ when the text is the same", async () => {
    const a = serviceWith({ [PDF_URL]: { body: buildPdf(THREE_PAGES), contentType: "application/pdf" } });
    const b = serviceWith({ [PDF_URL]: { body: buildPdf(THREE_PAGES, { prefix: "\n" }), contentType: "application/pdf" } });
    const [pa, pb] = [await a.service.fetchAndClean(PDF_URL), await b.service.fetchAndClean(PDF_URL)];
    assert.notEqual(pa.pdf?.byteLength, pb.pdf?.byteLength);
    assert.equal(pa.contentHash, pb.contentHash);
  });
});

// ============================================
// Text cap: separate from the HTML cap, never truncates
// ============================================

describe("fetchAndClean — PDF text cap", () => {
  // 40 pages × ~1,000 chars: well past the HTML path's 24,000-char slice.
  const longPages = Array.from({ length: 40 }, (_, i) =>
    [`Section ${i + 1}`, ...Array.from({ length: 9 }, () => FILLER)].join("\n")
  );

  test("a PDF longer than MAX_CLEAN_TEXT_CHARS is returned whole", async () => {
    const { service } = serviceWith({ [PDF_URL]: pdfRoute(longPages) });
    const page = await service.fetchAndClean(PDF_URL);
    assert.ok(page.cleanText.length > MAX_CLEAN_TEXT_CHARS, `${page.cleanText.length} chars`);
    assert.equal(page.cleanText, longPages.join(PDF_PAGE_SEPARATOR));
    // The last page is all there: nothing was cut off the end.
    assert.ok(page.cleanText.endsWith(longPages[39]));
    assert.equal(page.pdf?.pageCount, 40);
  });

  test("exceeding the PDF text cap fails with a reason and the amount read, never a slice", async () => {
    const total = longPages.join(PDF_PAGE_SEPARATOR).length;
    const { service } = serviceWith({ [PDF_URL]: pdfRoute(longPages) }, { pdf: { maxTextChars: 30_000 } });
    const { err, warnings } = await refused(() => service.fetchAndClean(PDF_URL), "text-too-long");
    assert.equal(err.details.maxTextChars, 30_000);
    assert.equal(err.details.charsRead, total);
    assert.equal(err.details.pagesRead, 40);
    assert.match(err.message, /not truncated/);
    assert.match(err.message, new RegExp(String(total)));
    // The refusal is logged with its reason.
    assert.ok(warnings.some((w) => w.includes("text-too-long")));
  });

  test("far over the cap, extraction stops early and says how far it got", async () => {
    const { service } = serviceWith({ [PDF_URL]: pdfRoute(longPages) }, { pdf: { maxTextChars: 2_000 } });
    const { err } = await refused(() => service.fetchAndClean(PDF_URL), "text-too-long");
    assert.equal(err.details.maxTextChars, 2_000);
    assert.equal(err.details.pageCount, 40);
    // Stopped part-way (after roughly 4,000 raw characters), not at the end.
    assert.ok((err.details.pagesRead ?? 99) < 40, `stopped at page ${err.details.pagesRead}`);
    assert.ok((err.details.charsRead ?? 0) > 2_000);
  });
});

// ============================================
// Page boundaries
// ============================================

describe("PDF page boundaries", () => {
  test("every span of the joined text maps back to its page", async () => {
    const { service } = serviceWith({ [PDF_URL]: pdfRoute(THREE_PAGES) });
    const { cleanText, pdf } = await service.fetchAndClean(PDF_URL);
    assert.ok(pdf);

    // Offsets point at each page's first character.
    assert.equal(pdf.pageOffsets.length, 3);
    pdf.pageOffsets.forEach((offset, i) => {
      assert.equal(cleanText.slice(offset, offset + pdf.pages[i].length), pdf.pages[i]);
    });

    // A phrase's position in cleanText gives its page.
    const pageOf = (phrase: string) => pdfPageAtOffset(pdf, cleanText.indexOf(phrase));
    assert.equal(pageOf("Version 3.0"), 1);
    assert.equal(pageOf("Genuine intention to visit"), 2);
    assert.equal(pageOf("Use the standard paragraphs."), 3);

    // First and last characters, the separator, and out-of-range offsets.
    assert.equal(pdfPageAtOffset(pdf, 0), 1);
    assert.equal(pdfPageAtOffset(pdf, cleanText.length - 1), 3);
    assert.equal(pdfPageAtOffset(pdf, pdf.pageOffsets[1] - 1), 1); // the form feed after page 1
    assert.equal(pdfPageAtOffset(pdf, cleanText.length), undefined);
    assert.equal(pdfPageAtOffset(pdf, -1), undefined);

    // The page separator never occurs inside a page, so splitting the joined
    // text on it recovers the pages exactly.
    assert.deepEqual(cleanText.split(PDF_PAGE_SEPARATOR), pdf.pages);
  });

  test("a quote is found on its page however its lines were broken", async () => {
    const { service } = serviceWith({ [PDF_URL]: pdfRoute(THREE_PAGES) });
    const { pdf } = await service.fetchAndClean(PDF_URL);
    assert.ok(pdf);

    // The sentence is split across two lines in the PDF; the quote is not.
    const quote = "The applicant must satisfy the decision maker that they will leave at the end of their visit.";
    assert.deepEqual(findPdfQuote(pdf, quote), { page: 2, endPage: 2 });
    // Whitespace in the quote does not matter either.
    assert.deepEqual(findPdfQuote(pdf, "  Use the   standard\nparagraphs. "), { page: 3, endPage: 3 });
    // A quote that runs over a page break reports both pages.
    const across = `${FILLER} Refusal wording`;
    assert.deepEqual(findPdfQuote(pdf, across), { page: 2, endPage: 3 });
    // Absent or empty quotes are not found.
    assert.equal(findPdfQuote(pdf, "This sentence is not in the document."), undefined);
    assert.equal(findPdfQuote(pdf, "   "), undefined);
  });

  test("pages without text keep their number (a scanned insert does not shift later pages)", async () => {
    const { service } = serviceWith({ [PDF_URL]: pdfRoute([PAGE_1, "", PAGE_3]) });
    const { pdf, cleanText } = await service.fetchAndClean(PDF_URL);
    assert.ok(pdf);
    assert.equal(pdf.pageCount, 3);
    assert.deepEqual(pdf.pagesWithoutText, [2]);
    assert.equal(pdfPageAtOffset(pdf, cleanText.indexOf("Refusal wording")), 3);
    assert.deepEqual(findPdfQuote(pdf, "Use the standard paragraphs."), { page: 3, endPage: 3 });
  });

  test("assemblePdfText: offsets and empty pages (pure)", () => {
    const pdf = assemblePdfText(["ab", "", "cde"], 10);
    assert.equal(pdf.cleanText, "ab\f\fcde");
    assert.deepEqual(pdf.pageOffsets, [0, 3, 4]);
    assert.deepEqual(pdf.pagesWithoutText, [2]);
    assert.equal(pdfPageAtOffset(pdf, 4), 3);
  });
});

// ============================================
// Normalisation for quote matching
// ============================================

describe("PDF text normalisation", () => {
  test("ligatures, soft hyphens and odd spaces are normalised in extracted text", async () => {
    // As a typeset PDF encodes it: "fi"/"fl"/"ffi" ligature glyphs, a soft
    // hyphen inside a word, a no-break space, a zero-width space.
    const typeset =
      "The of\uFB01cial must be satis\uFB01ed that the applicant has su\uFB03cient funds\n" +
      "and will not seek employ\u00ADment or bene\uFB01ts during the visit, including any\n" +
      "\uFB02ight costs, for up to 6\u00A0months\u200B.";
    const { service } = serviceWith({ [PDF_URL]: pdfRoute([typeset]) });
    const { pdf, cleanText } = await service.fetchAndClean(PDF_URL);
    assert.ok(pdf);

    assert.equal(
      cleanText,
      "The official must be satisfied that the applicant has sufficient funds\n" +
        "and will not seek employment or benefits during the visit, including any\n" +
        "flight costs, for up to 6 months."
    );
    assert.doesNotMatch(cleanText, /[\uFB00-\uFB06\u00AD\u00A0\u200B]/);

    // A quote typed in plain letters, on one line, is a whitespace-normalised
    // substring of the extracted text.
    const quote =
      "must be satisfied that the applicant has sufficient funds and will not seek employment or benefits";
    assert.ok(normalizeForQuoteMatch(cleanText).includes(normalizeForQuoteMatch(quote)));
    assert.deepEqual(findPdfQuote(pdf, quote), { page: 1, endPage: 1 });

    // A quote copied WITH the ligature glyphs and soft hyphen matches too:
    // both sides go through the same normalisation.
    const copied = "satis\uFB01ed that the applicant has su\uFB03cient funds and will not seek employ\u00ADment";
    assert.deepEqual(findPdfQuote(pdf, copied), { page: 1, endPage: 1 });
  });

  test("cleanPdfPageText: whitespace rules and reserved form feed (pure)", () => {
    assert.equal(cleanPdfPageText("  A   B \t C  \r\n\r\n\r\n\r\n D \f E  "), "A B C\n\nD\nE");
    // Real hyphens at a line end are kept: they cannot be told from wrapping.
    assert.equal(cleanPdfPageText("non-\ncomplex"), "non-\ncomplex");
    assert.equal(normalizeForQuoteMatch("non-\ncomplex  case\fnext"), "non- complex case next");
  });
});

// ============================================
// Refusals: every failure has a reason
// ============================================

describe("fetchAndClean — PDFs that cannot be read", () => {
  test("image-only PDF: explicit 'no extractable text', never an empty success", async () => {
    // Four pages with no text layer at all (what a scan looks like).
    const { service } = serviceWith({ [PDF_URL]: pdfRoute(["", "", "", ""]) });
    const { err, warnings } = await refused(() => service.fetchAndClean(PDF_URL), "no-extractable-text");
    assert.equal(err.details.pageCount, 4);
    assert.equal(err.details.charsRead, 0);
    assert.match(err.message, /No extractable text/);
    assert.ok(warnings.some((w) => w.includes("no-extractable-text")));
  });

  test("a few stray characters (a scan with a stamped page number) still count as no text", async () => {
    const { service } = serviceWith({ [PDF_URL]: pdfRoute(["1", "2", "3"]) });
    const { err } = await refused(() => service.fetchAndClean(PDF_URL), "no-extractable-text");
    assert.equal(err.details.charsRead, 3);
    assert.equal(err.details.minTextChars, DEFAULT_PDF_LIMITS.minTextChars);
  });

  test("an HTML login wall served as application/pdf (HTTP 200) fails with 'not-a-pdf'", async () => {
    const wall = "<!doctype html><html><body><h1>Sign in to continue</h1></body></html>";
    const { service } = serviceWith({ [PDF_URL]: { status: 200, body: wall, contentType: "application/pdf" } });
    const { err } = await refused(() => service.fetchAndClean(PDF_URL), "not-a-pdf");
    assert.match(err.message, /no %PDF- header/);
  });

  test("an HTML 404 page served as application/pdf fails with the HTTP status", async () => {
    const { service } = serviceWith({
      [PDF_URL]: { status: 404, body: "<html><body>Not found</body></html>", contentType: "application/pdf" },
    });
    await assert.rejects(service.fetchAndClean(PDF_URL), /Fetch failed for .* \(HTTP 404\)/);
  });

  test("a password-protected PDF fails with 'encrypted'", async () => {
    const { service } = serviceWith({
      [PDF_URL]: { body: buildPdf(THREE_PAGES, { encrypted: true }), contentType: "application/pdf" },
    });
    const { err } = await refused(() => service.fetchAndClean(PDF_URL), "encrypted");
    assert.match(err.message, /password-protected/);
  });

  test("a malformed PDF (header, then garbage) fails with 'malformed'", async () => {
    const garbage = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(4096, 0x41)]);
    const { service } = serviceWith({ [PDF_URL]: { body: garbage, contentType: "application/pdf" } });
    await refused(() => service.fetchAndClean(PDF_URL), "malformed");
  });

  test("a truncated PDF (download cut short) fails with a reason", async () => {
    const whole = buildPdf(THREE_PAGES);
    const cut = whole.subarray(0, Math.floor(whole.length / 3));
    const { service } = serviceWith({ [PDF_URL]: { body: cut, contentType: "application/pdf" } });
    const out = await quietly(() => service.fetchAndClean(PDF_URL));
    // The parser may salvage nothing (malformed) or pages with no text.
    assert.ok(isPdfFetchError(out.error), `expected PdfFetchError, got ${String(out.error)}`);
    assert.ok(["malformed", "no-extractable-text"].includes(out.error.reason), out.error.reason);
  });

  test("more pages than the page cap fails with 'too-many-pages' before reading any", async () => {
    const { service } = serviceWith({ [PDF_URL]: pdfRoute(THREE_PAGES) }, { pdf: { maxPages: 2 } });
    const { err } = await refused(() => service.fetchAndClean(PDF_URL), "too-many-pages");
    assert.equal(err.details.pageCount, 3);
    assert.equal(err.details.maxPages, 2);
  });

  test("a parse that outlives its budget is terminated with 'parse-timeout'", async () => {
    // 1 ms is less than a worker thread takes to start, so this always fires;
    // it proves the parent stops the worker rather than waiting for it.
    const { service } = serviceWith({ [PDF_URL]: pdfRoute(THREE_PAGES) }, { pdf: { parseTimeoutMs: 1 } });
    const { err } = await refused(() => service.fetchAndClean(PDF_URL), "parse-timeout");
    assert.equal(err.details.timeoutMs, 1);
  });

  test("a compressed (FlateDecode) PDF reads the same as an uncompressed one", async () => {
    const plain = serviceWith({ [PDF_URL]: { body: buildPdf(THREE_PAGES), contentType: "application/pdf" } });
    const packed = serviceWith({
      [PDF_URL]: { body: buildPdf(THREE_PAGES, { compress: true }), contentType: "application/pdf" },
    });
    const [a, b] = [await plain.service.fetchAndClean(PDF_URL), await packed.service.fetchAndClean(PDF_URL)];
    assert.deepEqual(b.pdf?.pages, THREE_PAGES);
    assert.equal(b.contentHash, a.contentHash);
  });
});

// ============================================
// Memory: a small PDF that inflates to hundreds of MB
// ============================================

describe("fetchAndClean — PDF memory watchdog", () => {
  test("a stream that inflates far past its size is stopped with 'memory-exceeded', memory stays bounded", async () => {
    // A ~0.3 MB PDF whose one content stream inflates to 300 MB. The parser
    // inflates it into typed arrays outside the JavaScript heap, so the
    // worker's heap limit never sees it; only the watchdog on process memory
    // can stop it. Without the watchdog this parse takes process memory up by
    // more than the 300 MB it inflates (the parser's buffers double as they
    // grow) and then "succeeds".
    const INFLATES_TO_MB = 300;
    const BUDGET_MB = 64;
    const pdfBytes = buildPdf([FILLER], { deflatedFirstPage: await deflatedPaddedContent(INFLATES_TO_MB) });
    assert.ok(pdfBytes.length < 1024 * 1024, `fixture is small on the wire: ${pdfBytes.length} bytes`);

    const { service } = serviceWith(
      { [PDF_URL]: { body: pdfBytes, contentType: "application/pdf" } },
      { pdf: { parseRssGrowthMb: BUDGET_MB } }
    );

    // Sample process memory ourselves, independently of the watchdog, to see
    // the peak the process actually reached.
    const baseline = process.memoryUsage.rss();
    let peak = baseline;
    const sampler = setInterval(() => {
      peak = Math.max(peak, process.memoryUsage.rss());
    }, 5);
    let outcome: Awaited<ReturnType<typeof refused>>;
    try {
      outcome = await refused(() => service.fetchAndClean(PDF_URL), "memory-exceeded");
    } finally {
      clearInterval(sampler);
    }
    const { err, warnings } = outcome;

    // Reasoned failure, with the numbers.
    assert.equal(err.details.maxRssGrowthMb, BUDGET_MB);
    assert.ok((err.details.rssGrowthMb ?? 0) > BUDGET_MB, `grew ${err.details.rssGrowthMb} MB`);
    assert.equal(err.details.byteLength, pdfBytes.length);
    assert.match(err.message, /used too much memory/);
    assert.ok(warnings.some((w) => w.includes("memory-exceeded")), "the refusal is logged with its reason");

    // Bounded: the process never got near the 300 MB the stream inflates to.
    // The watchdog samples every 25 ms and the parser's buffers grow by
    // doubling, so some overshoot past the budget is expected; 200 MB is the
    // generous ceiling, well under the unguarded figure.
    const peakGrowthMb = Math.round((peak - baseline) / (1024 * 1024));
    assert.ok(peakGrowthMb < 200, `process memory grew by ${peakGrowthMb} MB (budget ${BUDGET_MB} MB)`);
  });

  test("the default budget lets an ordinary PDF through and is part of the configurable limits", async () => {
    assert.equal(DEFAULT_PDF_LIMITS.parseRssGrowthMb, 160);
    const { service } = serviceWith({ [PDF_URL]: pdfRoute(THREE_PAGES) });
    assert.equal((await service.fetchAndClean(PDF_URL)).pdf?.pageCount, 3);
  });
});

// ============================================
// The generic web-page adapter does not take PDFs
// ============================================

describe("GenericHtmlAdapter — PDF responses are refused, not truncated", () => {
  const sourcePage = { url: PDF_URL, routeName: "Guidance", validation: "text_verified" as const };

  test("a page that serves a PDF is refused with a logged reason, before the body is read", async () => {
    let bytesServed = 0;
    const pdfBytes = buildPdf(THREE_PAGES);
    const body = new Readable({
      read() {
        bytesServed += pdfBytes.length;
        this.push(pdfBytes);
        this.push(null);
      },
    });
    const { service, calls } = serviceWith({ [PDF_URL]: { body, contentType: "application/pdf" } });
    const adapter = new GenericHtmlAdapter(service);

    const { err, warnings } = await refused(() => adapter.fetch(sourcePage), "not-accepted");
    assert.match(err.message, /PDF not accepted/);
    assert.match(err.message, /nothing was downloaded/);
    assert.ok(warnings.some((w) => w.includes("not-accepted")), "the refusal is logged with its reason");
    // Etiquette still ran (robots.txt, then one request), and the PDF body
    // was dropped unread: no download, no parse, nothing sent downstream.
    assert.deepEqual(calls.map((c) => c.url), [ROBOTS_URL, PDF_URL]);
    assert.equal(bytesServed, 0);
    assert.equal(body.destroyed, true);
  });

  test("a web page URL that redirects to a PDF is refused the same way", async () => {
    const start = `https://${HOST}/guidance/latest`;
    const { service } = serviceWith({
      [start]: { body: buildPdf(THREE_PAGES), contentType: "application/octet-stream", responseUrl: PDF_URL },
    });
    const adapter = new GenericHtmlAdapter(service);
    await refused(() => adapter.fetch({ ...sourcePage, url: start }), "not-accepted");
  });

  test("the same URL is still readable by a caller that asks the fetch service directly", async () => {
    const { service } = serviceWith({ [PDF_URL]: () => pdfRoute(THREE_PAGES) });
    await refused(() => new GenericHtmlAdapter(service).fetch(sourcePage), "not-accepted");
    assert.equal((await service.fetchAndClean(PDF_URL, { checkRobots: true })).pdf?.pageCount, 3);
  });

  test("web pages through the adapter are unaffected", async () => {
    const url = `https://${HOST}/visas/visitor`;
    const html = `<html><body><main><h1>Visitor visa</h1><p>${FILLER} ${FILLER}</p></main></body></html>`;
    const { service } = serviceWith({ [url]: { body: html, contentType: "text/html" } });
    const doc = await new GenericHtmlAdapter(service).fetch({ ...sourcePage, url });
    const direct = await service.fetchAndClean(url);
    assert.equal(doc.text, direct.cleanText);
    assert.equal(doc.contentHash, direct.contentHash);
  });
});

// ============================================
// Byte cap
// ============================================

describe("fetchAndClean — PDF byte cap", () => {
  test("the default cap is 20 MB and is configurable per service", () => {
    assert.equal(DEFAULT_PDF_LIMITS.maxBytes, 20 * 1024 * 1024);
  });

  test("a declared Content-Length over the cap is refused before any body is read", async () => {
    let bytesServed = 0;
    const body = new Readable({
      read() {
        bytesServed += 1024;
        this.push(Buffer.alloc(1024, 0x25));
      },
    });
    const { service } = serviceWith(
      { [PDF_URL]: { body, contentType: "application/pdf", headers: { "content-length": "50000000" } } },
      { pdf: { maxBytes: 10_000 } }
    );
    const { err, warnings } = await refused(() => service.fetchAndClean(PDF_URL), "too-large");
    assert.equal(err.details.byteLength, 50_000_000);
    assert.equal(err.details.maxBytes, 10_000);
    assert.equal(bytesServed, 0, "nothing was pulled from the body");
    assert.equal(body.destroyed, true, "the connection was released");
    assert.ok(warnings.some((w) => w.includes("too-large")), "the refusal is logged with its reason");
  });

  test("an undeclared oversized download is cut off while streaming, not after", async () => {
    // An endless body with no Content-Length: only the cap can stop it.
    let bytesServed = 0;
    const body = new Readable({
      read() {
        bytesServed += 1024;
        this.push(Buffer.alloc(1024, 0x25));
      },
    });
    const { service } = serviceWith(
      { [PDF_URL]: { body, contentType: "application/pdf" } },
      { pdf: { maxBytes: 10_000 } }
    );
    const { err } = await refused(() => service.fetchAndClean(PDF_URL), "too-large");
    assert.equal(err.details.maxBytes, 10_000);
    assert.equal(body.destroyed, true, "the download was stopped");
    // Stopped within a few chunks of the cap (stream read-ahead), nowhere
    // near "the whole thing".
    assert.ok(bytesServed < 200_000, `served ${bytesServed} bytes`);
  });

  test("a PDF under a custom cap is read; the same PDF over a lower cap is not", async () => {
    const bytes = buildPdf(THREE_PAGES);
    const ok = serviceWith({ [PDF_URL]: { body: bytes, contentType: "application/pdf" } }, { pdf: { maxBytes: bytes.length } });
    assert.equal((await ok.service.fetchAndClean(PDF_URL)).pdf?.byteLength, bytes.length);
    const tooSmall = serviceWith(
      { [PDF_URL]: { body: bytes, contentType: "application/pdf" } },
      { pdf: { maxBytes: bytes.length - 1 } }
    );
    await refused(() => tooSmall.service.fetchAndClean(PDF_URL), "too-large");
  });

  test("a body that stalls is dropped by the inactivity timer, long before the overall deadline", async () => {
    // Sends a little, then goes silent without ending.
    const body = new Readable({ read() { /* never pushes again */ } });
    body.push(Buffer.from("%PDF-1.4\n"));
    const { service } = serviceWith(
      { [PDF_URL]: { body, contentType: "application/pdf" } },
      { bodyIdleTimeoutMs: 30, bodyTimeoutMs: 60_000 }
    );
    const started = Date.now();
    await assert.rejects(service.fetchAndClean(PDF_URL), /Response body stalled .* no data for 30 ms after 9 bytes/);
    assert.ok(Date.now() - started < 5_000, "did not wait for the overall deadline");
    assert.equal(body.destroyed, true);
  });

  test("a body that keeps dripping is dropped by the overall deadline", async () => {
    // One byte every 10 ms: never idle for long, never finished.
    let timer: NodeJS.Timeout | undefined;
    const body = new Readable({
      read() {
        if (!timer) timer = setInterval(() => this.push(Buffer.from("%")), 10);
      },
      destroy(err, callback) {
        clearInterval(timer);
        callback(err);
      },
    });
    const { service } = serviceWith(
      { [PDF_URL]: { body, contentType: "application/pdf" } },
      { bodyIdleTimeoutMs: 1_000, bodyTimeoutMs: 80 }
    );
    await assert.rejects(service.fetchAndClean(PDF_URL), /Timed out reading the response body .* after 80 ms/);
    assert.equal(body.destroyed, true);
  });
});

// ============================================
// Etiquette applies to PDFs unchanged
// ============================================

describe("fetchAndClean — crawler etiquette for PDFs", () => {
  test("robots.txt is checked first and a disallowed PDF is never requested", async () => {
    const { service, calls } = serviceWith({
      [ROBOTS_URL]: { body: "User-agent: *\nDisallow: /media/\n", contentType: "text/plain" },
      [PDF_URL]: pdfRoute(THREE_PAGES),
    });
    await assert.rejects(service.fetchAndClean(PDF_URL, { checkRobots: true }), /Blocked by robots\.txt/);
    assert.deepEqual(calls.map((c) => c.url), [ROBOTS_URL]);
  });

  test("the per-host minimum interval spaces robots.txt, the PDF and the next PDF", async () => {
    const second = `https://${HOST}/media/def456/other.pdf`;
    const { service, calls } = serviceWith(
      { [PDF_URL]: () => pdfRoute(THREE_PAGES), [second]: () => pdfRoute([PAGE_1]) },
      { minIntervalMs: 60 }
    );
    await service.fetchAndClean(PDF_URL, { checkRobots: true });
    await service.fetchAndClean(second, { checkRobots: true });
    assert.deepEqual(calls.map((c) => c.url), [ROBOTS_URL, PDF_URL, second]);
    // Allow a few ms of timer slack.
    assert.ok(calls[1].at - calls[0].at >= 55, `robots→pdf gap ${calls[1].at - calls[0].at}ms`);
    assert.ok(calls[2].at - calls[1].at >= 55, `pdf→pdf gap ${calls[2].at - calls[1].at}ms`);
  });

  test("429 / 503 on a PDF throws HostBackoffError with Retry-After, and drops the body", async () => {
    for (const status of [429, 503]) {
      const body = Readable.from([Buffer.from("slow down")]);
      const { service } = serviceWith({
        [PDF_URL]: { status, body, contentType: "application/pdf", headers: { "retry-after": "120" } },
      });
      const before = Date.now();
      await assert.rejects(service.fetchAndClean(PDF_URL), (err: unknown) => {
        assert.ok(isHostBackoffError(err), `expected HostBackoffError, got ${String(err)}`);
        assert.equal(err.host, HOST);
        assert.equal(err.status, status);
        assert.ok(err.untilMs >= before + 120_000);
        return true;
      });
      assert.equal(body.destroyed, true);
    }
  });

  test("429 on robots.txt stops the PDF from being requested at all", async () => {
    const { service, calls } = serviceWith({
      [ROBOTS_URL]: { status: 429, body: "", headers: { "retry-after": "60" } },
      [PDF_URL]: pdfRoute(THREE_PAGES),
    });
    await assert.rejects(service.fetchAndClean(PDF_URL, { checkRobots: true }), isHostBackoffError);
    assert.deepEqual(calls.map((c) => c.url), [ROBOTS_URL]);
  });
});

// ============================================
// HTML path is unchanged
// ============================================

describe("fetchAndClean — HTML path unchanged by PDF support", () => {
  const html =
    "<html><head><title>t</title></head><body><nav>menu</nav><main><h1>Visitor visa</h1>" +
    `<p>${FILLER}</p><p>${FILLER}</p><ul><li>Passport</li><li>Bank statements — 6 months</li></ul></main>` +
    "<footer>footer</footer></body></html>";
  const url = `https://${HOST}/visas/visitor`;

  test("same clean text and hash whether the body arrives as text, bytes or a stream", async () => {
    const asString = await serviceWith({ [url]: { body: html, contentType: "text/html; charset=utf-8" } })
      .service.fetchAndClean(url);
    const asBytes = await serviceWith({ [url]: { body: Buffer.from(html, "utf8"), contentType: "text/html" } })
      .service.fetchAndClean(url);
    const asStream = await serviceWith({
      // Chunk boundary lands inside the multi-byte dash on purpose.
      [url]: { body: Readable.from(chunked(Buffer.from(html, "utf8"), 7)), contentType: "text/html" },
    }).service.fetchAndClean(url);
    // With a UTF-8 byte-order mark, which the text decoder has always removed.
    const withBom = await serviceWith({
      [url]: { body: Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(html, "utf8")]), contentType: "text/html" },
    }).service.fetchAndClean(url);

    // The cleaned text is what the pre-#33 pipeline produced for this page.
    assert.equal(asString.cleanText, new VisaCatalogFetchService().htmlToCleanText(html));
    assert.equal(asString.contentHash, sha256(asString.cleanText));
    for (const other of [asBytes, asStream, withBom]) {
      assert.equal(other.cleanText, asString.cleanText);
      assert.equal(other.contentHash, asString.contentHash);
    }
  });

  test("an HTML result has no `pdf` field and keeps the 24,000-character cap", async () => {
    const long = `<html><body><main>${`<p>${FILLER}</p>`.repeat(400)}</main></body></html>`;
    const { service } = serviceWith({ [url]: { body: long, contentType: "text/html" } });
    const page = await service.fetchAndClean(url);
    assert.equal(page.cleanText.length, MAX_CLEAN_TEXT_CHARS);
    assert.deepEqual(Object.keys(page).sort(), ["cleanText", "contentHash", "fetchedAt", "finalUrl", "httpStatus", "url"]);
  });

  test("HTML keeps its own 5 MB download cap (the PDF cap does not loosen it)", async () => {
    const body = Readable.from(chunked(Buffer.alloc(MAX_HTML_BYTES + 4096, 0x61), 64 * 1024));
    const { service } = serviceWith({ [url]: { body, contentType: "text/html" } });
    await assert.rejects(service.fetchAndClean(url), (err: unknown) => {
      assert.equal(isPdfFetchError(err), false);
      assert.match(String((err as Error).message), /Response too large/);
      return true;
    });
    assert.equal(body.destroyed, true);
  });
});
