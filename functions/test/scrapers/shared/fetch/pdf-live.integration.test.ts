// ============================================
// PDF fetching (issue #33) — LIVE integration test (opt-in)
// ============================================
//
// Fetches two real, published guidance PDFs from two different publishers
// through the production fetch service: the real HTTP client, the honest bot
// User-Agent, robots.txt, the per-host gap and the streamed download. It
// proves the PDF reader works on real files and is not specific to one
// publisher.
//
// SKIPPED BY DEFAULT: `npm test` never touches the network. To run it:
//
//   PDF_LIVE_FIXTURES=1 node --import tsx --import ./test/helpers/setup.ts \
//     --test test/scrapers/shared/fetch/pdf-live.integration.test.ts
//
// The PDFs are not committed (about 0.8 MB and 0.3 MB of binary). Each run
// writes the extracted text to a fresh temp directory (path printed) so it
// can be read, and prints the first 500 extracted characters of each.
//
// These URLs and phrases are TEST DATA: the fetcher itself names no country,
// route or publisher. A publisher re-issuing a document can change its URL
// or wording; if a phrase assertion fails after a new release, re-copy the
// phrase from the current PDF.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAX_CLEAN_TEXT_CHARS,
  VisaCatalogFetchService,
} from "../../../../src/scrapers/shared/fetch/visa-catalog-fetch.service";
import { findPdfQuote, normalizeForQuoteMatch, pdfPageAtOffset } from "../../../../src/scrapers/shared/fetch/pdf-text";

// Opt-in switch. Anything but "1" skips every test in this file.
const LIVE = process.env.PDF_LIVE_FIXTURES === "1";

// Publication page that lists the first PDF. The attachment's own URL carries
// a media id that changes with every release, so it is resolved from this
// page at run time rather than hard-coded.
const PUBLICATION_PAGE = "https://www.gov.uk/government/publications/visit-guidance";

// A sentence copied verbatim from the first PDF (version 18.0, published
// 8 October 2026), where it is wrapped over three lines on page 10.
const KNOWN_PHRASE =
  "A person who is a British citizen, or who has right of abode in the UK cannot be " +
  "given permission to enter or stay under the Immigration Rules.";

// The second publisher's PDF: a fixed URL, used only to show the reader is
// not tied to the first publisher.
const SECOND_PDF = "https://assets.ireland.ie/documents/NDVO_20250708_IRL_Visa_checklist_Study.pdf";

describe("live guidance PDFs (opt-in: PDF_LIVE_FIXTURES=1)", { skip: !LIVE }, () => {
  // One service for the file: default client and default limits, i.e. exactly
  // what production uses.
  const service = new VisaCatalogFetchService();
  // Extracted text is written here for inspection.
  const outDir = LIVE ? mkdtempSync(join(tmpdir(), "pdf-live-")) : "";

  /** Print the first 500 characters and save the whole text. */
  const report = (name: string, url: string, cleanText: string) => {
    const file = join(outDir, `${name}.txt`);
    writeFileSync(file, cleanText, "utf8");
    console.log(`\n[${name}] ${url}\n[${name}] text saved to ${file}`);
    console.log(`[${name}] first 500 characters:\n${cleanText.slice(0, 500)}\n`);
  };

  test("publisher 1: an 80-page caseworker guidance PDF is read whole, with page numbers", { timeout: 120_000 }, async () => {
    // Resolve the current attachment URL from the publication page.
    const listing = await service.getRaw(PUBLICATION_PAGE);
    assert.equal(listing.status, 200);
    const links = [...listing.body.matchAll(/https:\/\/assets\.publishing\.service\.gov\.uk\/[^"'\s<>]+\.pdf/g)].map((m) => m[0]);
    assert.ok(links.length > 0, "the publication page lists a PDF attachment");
    const url = links[0];

    const first = await service.fetchAndClean(url, { checkRobots: true });
    assert.ok(first.pdf, "the response was read as a PDF");
    report("publisher-1", url, first.cleanText);

    // Read whole: far more than the HTML cap, every page present.
    assert.ok(first.pdf.pageCount >= 50, `${first.pdf.pageCount} pages`);
    assert.ok(first.cleanText.length > MAX_CLEAN_TEXT_CHARS * 3, `${first.cleanText.length} chars`);
    assert.deepEqual(first.pdf.pagesWithoutText, []);
    assert.equal(first.contentHash, createHash("sha256").update(first.cleanText).digest("hex"));

    // A verbatim quote is found (whitespace-normalised), on a known page.
    assert.ok(normalizeForQuoteMatch(first.cleanText).includes(normalizeForQuoteMatch(KNOWN_PHRASE)));
    const where = findPdfQuote(first.pdf, KNOWN_PHRASE);
    assert.ok(where, "the known phrase is in the extracted text");
    console.log(`[publisher-1] known phrase found on page ${where.page}`);
    // The document prints "Page N of M" on every page: the page we computed
    // must be the page the document says it is.
    assert.match(first.pdf.pages[where.page - 1], new RegExp(`^Page ${where.page} of ${first.pdf.pageCount}\\b`));
    assert.equal(pdfPageAtOffset(first.pdf, first.cleanText.indexOf("right of abode")), findPdfQuote(first.pdf, "right of abode")?.page);

    // Hash gate: a second fetch of the unchanged PDF gives the same hash,
    // which is what lets the crawl skip all downstream work.
    const second = await service.fetchAndClean(url, { checkRobots: true });
    assert.equal(second.contentHash, first.contentHash);
    console.log(`[publisher-1] ${first.pdf.pageCount} pages, ${first.cleanText.length} chars, ${first.pdf.byteLength} bytes, hash ${first.contentHash} (unchanged on re-fetch)`);
  });

  test("publisher 2: a different publisher's PDF is read by the same code", { timeout: 120_000 }, async () => {
    const page = await service.fetchAndClean(SECOND_PDF, { checkRobots: true });
    assert.ok(page.pdf, "the response was read as a PDF");
    report("publisher-2", SECOND_PDF, page.cleanText);
    assert.ok(page.pdf.pageCount >= 1);
    assert.ok(page.cleanText.length > 500, `${page.cleanText.length} chars`);
    console.log(`[publisher-2] ${page.pdf.pageCount} pages, ${page.cleanText.length} chars, ${page.pdf.byteLength} bytes, hash ${page.contentHash}`);
  });
});
