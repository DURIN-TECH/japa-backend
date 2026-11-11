import { parentPort, workerData } from "worker_threads";
import { getDocumentProxy } from "unpdf";
import type { PdfWorkerInput, PdfWorkerOutput } from "./pdf-text";

// ============================================
// PDF TEXT EXTRACTION — WORKER THREAD (issue #33)
// ============================================
//
// Runs the PDF parser OFF the main thread, on behalf of `extractPdfText()` in
// pdf-text.ts (read the header there first). The parent starts one worker per
// PDF, hands it the bytes, and terminates it on timeout; this file only parses
// and reports.
//
// Parser: `unpdf` (MIT), which bundles Mozilla's PDF.js (Apache-2.0) as plain
// JavaScript with no native modules, so nothing is compiled at install or
// deploy time.
//
// What is read: the TEXT LAYER of each page, in page order. Nothing else:
//
//  - no JavaScript embedded in the PDF is run: this file never touches the
//    document's scripting or actions, and the bundled PDF.js (6.x) has no
//    code path that compiles PDF data into JavaScript (the old
//    `isEvalSupported` switch no longer exists);
//  - no embedded files / attachments are opened;
//  - no links, annotations or form actions are read or followed;
//  - no fonts, images or external resources are loaded (text extraction does
//    not render), and the parser is given the bytes directly, so it makes no
//    network request of its own.
//
// This module must only ever be loaded as a worker (it reads `workerData` and
// posts to `parentPort` at load time).

/** Post the one result message back to the parent. */
function post(out: PdfWorkerOutput): void {
  parentPort?.postMessage(out);
}

/**
 * Map a parser exception to a failure reason. PDF.js names its exceptions:
 * `PasswordException` for an encrypted document that needs a password (we
 * never supply one), and `InvalidPDFException` / others for files it cannot
 * read. Everything that is not a password prompt is "malformed".
 */
function failureFor(err: unknown): PdfWorkerOutput {
  const name = (err as { name?: unknown } | null)?.name;
  const message = (err as { message?: unknown } | null)?.message;
  const text = typeof message === "string" && message ? message : String(err);
  if (name === "PasswordException") {
    return { ok: false, reason: "encrypted", message: `PDF is password-protected: ${text}` };
  }
  return { ok: false, reason: "malformed", message: `PDF could not be parsed: ${text}` };
}

/** One text run as PDF.js returns it (marked-content items have no `str`). */
interface TextItemLike {
  str?: string; // the run's text
  hasEOL?: boolean; // true when the run ends a line
}

/** Parse the document handed over in `workerData` and post the result. */
async function main(): Promise<void> {
  const input = workerData as PdfWorkerInput;

  try {
    const doc = await getDocumentProxy(input.bytes, {
      // Text only: do not look for fonts on the machine or build font faces.
      useSystemFonts: false,
      disableFontFace: true,
      // Errors only; parser warnings about odd fonts are not our concern.
      verbosity: 0,
    });

    // Page cap, from the catalogue, before any page content is read.
    const pageCount = doc.numPages;
    if (pageCount > input.maxPages) {
      post({
        ok: false,
        reason: "too-many-pages",
        message: `PDF has too many pages: ${pageCount} exceeds the ${input.maxPages}-page cap`,
        details: { pageCount, maxPages: input.maxPages },
      });
      return;
    }

    const pages: string[] = [];
    let rawChars = 0;
    for (let n = 1; n <= pageCount; n++) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      // Join the text runs in the order the page lists them; a run flagged
      // `hasEOL` ends a line. PDF.js already inserts the spaces between words.
      let text = "";
      for (const item of content.items as TextItemLike[]) {
        if (typeof item.str !== "string") continue; // marked-content marker
        text += item.str;
        if (item.hasEOL) text += "\n";
      }
      pages.push(text);
      rawChars += text.length;
      // Release the page's parsed data before moving on.
      page.cleanup();

      // Memory guard: stop early when the text is already far over the cap.
      // The parent would refuse it anyway; this just says so sooner, with how
      // much had been read.
      if (rawChars > input.maxRawChars) {
        post({
          ok: false,
          reason: "text-too-long",
          message:
            `PDF text too long: stopped after ${rawChars} characters on page ${n} of ${pageCount} ` +
            "(not truncated; the fetch is refused)",
          details: { charsRead: rawChars, pagesRead: n, pageCount },
        });
        return;
      }
    }

    post({ ok: true, pages });
  } catch (err) {
    post(failureFor(err));
  }
}

void main();
