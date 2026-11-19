import * as path from "path";
import { Worker } from "worker_threads";

// ============================================
// PDF TEXT EXTRACTION (issue #33)
// ============================================
//
// Official guidance is often published as a PDF rather than a web page. This
// module turns PDF BYTES into clean, per-page text for the fetch service
// (visa-catalog-fetch.service.ts), which owns the network side (robots.txt,
// per-host rate limit, 429/503 backoff, download size cap). Nothing here
// touches the network, and nothing here knows about any country, route or
// publisher: which URLs are PDFs is decided by the response, not by code.
//
// ---- A PDF is UNTRUSTED input ----
//
// A PDF is a program-like container fetched from the internet, so it is
// handled defensively, in this order:
//
//  1. Byte cap           — enforced by the fetch service WHILE downloading
//                          (and again here, so a direct caller is covered).
//  2. Magic bytes        — the file must carry the `%PDF-` header; an HTML
//                          error page or login wall served as
//                          `application/pdf` is rejected before any parsing.
//  3. Isolated parse     — the parser runs in a worker thread. The parent
//                          enforces a wall-clock timeout by TERMINATING the
//                          worker, which works even when a hostile file keeps
//                          the parser in a tight CPU loop (a timer on the same
//                          thread could never fire in that case). A parser
//                          crash kills the worker, not the crawl function.
//  3b. Memory watchdog   — a worker shares the process's memory, and the
//                          worker's V8 heap limit only bounds JavaScript
//                          objects. A PDF's compressed streams are inflated
//                          into typed arrays that live OUTSIDE that heap, so
//                          a few hundred kilobytes of highly compressible
//                          data can expand to gigabytes without ever touching
//                          the heap limit. The parent therefore watches the
//                          process's resident memory (RSS) while the worker
//                          runs and terminates it, with reason
//                          "memory-exceeded", once RSS has grown by more than
//                          `parseRssGrowthMb` (see runPdfWorker).
//  4. Page cap           — checked from the document catalogue before any
//                          page content is read.
//  5. Text cap           — exceeding it FAILS the fetch (see below).
//  6. Text only          — we read the text layer and nothing else. Embedded
//                          JavaScript is never run, embedded files and
//                          attachments are never opened, links and form
//                          actions are never followed, and no fonts, images
//                          or external resources are loaded. See
//                          pdf-text.worker.ts.
//
// ---- No silent truncation ----
//
// The HTML path caps clean text at 24,000 characters and slices the rest off,
// which is fine for one web page but would silently drop most of a long
// guidance document. The PDF path therefore has its OWN, much larger cap
// (DEFAULT_PDF_LIMITS.maxTextChars) and never slices: a document over the cap
// fails with reason "text-too-long", and the error records how many
// characters and pages had been read when it stopped.
//
// ---- No OCR ----
//
// A scanned / image-only PDF has no text layer. That is reported as the
// explicit failure "no-extractable-text" — never as an empty string, which
// would hash as a valid fetch and mark the source up to date. OCR is #38.

// ----- Limits -----

/** Limits applied to one PDF. All are configurable per fetch service. */
export interface PdfLimits {
  // Largest PDF accepted, in bytes. Enforced while downloading (fetch
  // service) and again before parsing.
  maxBytes: number;
  // Largest page count accepted. Checked before any page content is read.
  maxPages: number;
  // Largest extracted text accepted, in characters (after normalisation,
  // summed over pages). Exceeding it FAILS the fetch; text is never sliced.
  maxTextChars: number;
  // Wall-clock budget for parsing one PDF, in ms. The worker is terminated
  // when it runs out.
  parseTimeoutMs: number;
  // V8 heap limit (old generation, MB) for the parser's worker thread. This
  // bounds JavaScript objects ONLY (strings, parsed structures). It does NOT
  // bound the typed arrays that compressed streams are inflated into, which
  // live outside the heap; `parseRssGrowthMb` is the limit that covers those.
  parseMemoryMb: number;
  // How much the PROCESS's resident memory (RSS, MB) may grow while one PDF
  // is being parsed before the parse is terminated with "memory-exceeded".
  // This is the limit that actually protects the function's memory: it counts
  // everything the parse allocates, on or off the JavaScript heap. It is
  // measured for the whole process, so memory allocated by other work running
  // at the same moment counts toward it too.
  parseRssGrowthMb: number;
  // Fewest non-whitespace characters a PDF must yield to count as having a
  // text layer. Below this the fetch fails with "no-extractable-text".
  minTextChars: number;
}

/**
 * Production defaults.
 *
 *  - maxBytes 20 MB: guidance PDFs are typically well under 5 MB; 20 MB
 *    leaves room while staying far below the crawl function's 512 MB.
 *  - maxPages 500 / maxTextChars 1,000,000: an 80-page guidance document is
 *    about 170,000 characters, so this admits documents several times that
 *    size and still bounds what later stages are handed.
 *  - parseTimeoutMs 30 s: an 80-page document parses in well under a second;
 *    30 s only ever stops a pathological file.
 *  - parseMemoryMb 256: generous for the parser's JavaScript objects; not
 *    the limit that protects the function (see parseRssGrowthMb).
 *  - parseRssGrowthMb 160: the crawl function has 512 MB. An idle instance
 *    sits at roughly 150-200 MB, and a 20 MB PDF is held twice during a parse
 *    (the downloaded buffer and the worker's copy: 40 MB). 160 MB of growth
 *    on top of that stays under 512 MB with room for the watchdog's reaction
 *    time. For scale: parsing an 80-page guidance PDF grows RSS by about
 *    85 MB, most of it the worker thread and the parser themselves.
 *  - minTextChars 100: the same floor the HTML path uses for "too little
 *    content".
 */
export const DEFAULT_PDF_LIMITS: Readonly<PdfLimits> = Object.freeze({
  maxBytes: 20 * 1024 * 1024,
  maxPages: 500,
  maxTextChars: 1_000_000,
  parseTimeoutMs: 30_000,
  parseMemoryMb: 256,
  parseRssGrowthMb: 160,
  minTextChars: 100,
});

// ----- Failure reasons -----

/**
 * Why a PDF could not be read. A stable, machine-readable code so callers
 * (source health, later OCR routing in #38) can branch on it without parsing
 * a message.
 */
export type PdfFailureReason =
  | "too-large" // more bytes than maxBytes (declared or actually received)
  | "not-a-pdf" // no %PDF- header: an HTML error page / login wall / other file
  | "encrypted" // password-protected; we never try passwords
  | "malformed" // the parser could not read the file (or crashed on it)
  | "too-many-pages" // more pages than maxPages
  | "text-too-long" // more extracted text than maxTextChars (never truncated)
  | "no-extractable-text" // no text layer (scanned / image-only); OCR is #38
  | "parse-timeout" // parsing exceeded parseTimeoutMs and was terminated
  | "memory-exceeded" // parsing grew process memory past parseRssGrowthMb and was terminated
  | "not-accepted"; // the caller asked for no PDFs (acceptPdf: false); nothing was downloaded

/** Numbers recorded with a failure, so a refusal is never unexplained. */
export interface PdfFailureDetails {
  byteLength?: number; // bytes received (or declared by Content-Length)
  maxBytes?: number; // the byte cap that applied
  pageCount?: number; // pages in the document, when known
  maxPages?: number; // the page cap that applied
  pagesRead?: number; // pages whose text had been read when we stopped
  charsRead?: number; // characters of text read when we stopped
  maxTextChars?: number; // the text cap that applied
  minTextChars?: number; // the text floor that applied
  timeoutMs?: number; // the parse budget that applied
  rssGrowthMb?: number; // process RSS growth (MB) seen when the parse was stopped
  maxRssGrowthMb?: number; // the RSS growth budget (MB) that applied
}

/**
 * A PDF fetch/extraction failure with a reason code. It is an ordinary Error
 * (callers that only record `err.message` keep working, and the message
 * already names the reason and the numbers), plus `reason` and `details` for
 * callers that want to branch.
 */
export class PdfFetchError extends Error {
  readonly reason: PdfFailureReason;
  readonly details: PdfFailureDetails;

  constructor(reason: PdfFailureReason, message: string, details: PdfFailureDetails = {}) {
    super(message);
    this.name = "PdfFetchError";
    this.reason = reason;
    this.details = details;
  }
}

/** Type guard: true for a PdfFetchError (also across module copies). */
export function isPdfFetchError(err: unknown): err is PdfFetchError {
  return err instanceof PdfFetchError || (err as { name?: unknown } | null)?.name === "PdfFetchError";
}

// ----- Detecting a PDF -----

// Content types that say "this is a PDF".
const PDF_CONTENT_TYPES = new Set(["application/pdf", "application/x-pdf"]);

// Content types that say nothing about the payload ("some bytes"). Servers
// and object stores often send these for PDFs, so with one of these we fall
// back to the URL's `.pdf` suffix. A specific type such as `text/html` is
// believed as-is, even on a `.pdf` URL.
const GENERIC_CONTENT_TYPES = new Set([
  "",
  "application/octet-stream",
  "binary/octet-stream",
  "application/download",
  "application/force-download",
  "application/x-download",
]);

/** True when the URL's PATH ends in `.pdf` (query string and case ignored). */
export function hasPdfSuffix(url: string): boolean {
  try {
    return new URL(url).pathname.toLowerCase().endsWith(".pdf");
  } catch {
    return false;
  }
}

/**
 * Decide whether a response is a PDF:
 *
 *  - `Content-Type: application/pdf` (parameters such as `; charset=` are
 *    ignored) → yes, whatever the URL looks like;
 *  - a generic / missing content type AND a `.pdf` path on the requested URL
 *    or on the post-redirect URL → yes;
 *  - anything else → no (the HTML path handles it).
 *
 * This only ROUTES the response. Whether the bytes really are a PDF is checked
 * separately by `hasPdfMagic`.
 */
export function isPdfResponse(contentType: string, requestedUrl: string, finalUrl?: string): boolean {
  const mime = contentType.split(";")[0].trim().toLowerCase();
  if (PDF_CONTENT_TYPES.has(mime)) return true;
  if (!GENERIC_CONTENT_TYPES.has(mime)) return false;
  return hasPdfSuffix(requestedUrl) || (finalUrl !== undefined && hasPdfSuffix(finalUrl));
}

// The PDF header marker, "%PDF-".
const PDF_MAGIC = Buffer.from("%PDF-", "latin1");

// How far into the file the header may start. The specification puts it at
// byte 0, but real files sometimes carry a few leading bytes (a BOM, blank
// lines) and readers accept the marker anywhere in the first 1024 bytes.
const PDF_MAGIC_WINDOW = 1024;

/** True when the bytes carry the `%PDF-` header within the first 1024 bytes. */
export function hasPdfMagic(bytes: Uint8Array): boolean {
  const head = Buffer.from(bytes.buffer, bytes.byteOffset, Math.min(bytes.byteLength, PDF_MAGIC_WINDOW));
  return head.indexOf(PDF_MAGIC) >= 0;
}

// ----- Text normalisation -----

// Latin typographic ligatures (U+FB00–U+FB06) → the letters they stand for.
// PDFs frequently encode "fi", "fl" and friends as one glyph; a quote typed or
// copied as plain letters must still match.
const LIGATURES: Record<string, string> = {
  "\uFB00": "ff",
  "\uFB01": "fi",
  "\uFB02": "fl",
  "\uFB03": "ffi",
  "\uFB04": "ffl",
  "\uFB05": "st",
  "\uFB06": "st",
};

/**
 * Character-level normalisation shared by the extracted text AND by a quote
 * being matched against it (see `normalizeForQuoteMatch`), so both sides agree:
 *
 *  - ligature glyphs are expanded to their letters ("ﬁ" → "fi");
 *  - soft hyphens (U+00AD, invisible discretionary break points) and
 *    zero-width characters / BOMs are removed;
 *  - every Unicode space (no-break space, thin space, …) becomes a plain space.
 *
 * Deliberately NOT done: real hyphens at a line end are kept ("non-\ncomplex"
 * cannot be told apart from a hyphenated line break), and quotes/dashes are
 * left as published, because a verbatim quote carries the same characters.
 */
export function normalizePdfChars(text: string): string {
  return text
    .replace(/[\uFB00-\uFB06]/g, (c) => LIGATURES[c] ?? c)
    .replace(/[\u00AD\u200B-\u200D\u2060\uFEFF]/g, "")
    .replace(/[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]/g, " ");
}

/**
 * Clean ONE page's raw text: character normalisation, then the same
 * whitespace rules as the HTML path (`blockText`): runs of spaces collapse to
 * one, spaces around line breaks go, blank-line runs collapse, ends trimmed.
 * Form feeds inside a page are turned into line breaks, because the form feed
 * is reserved as the page separator in the joined text.
 */
export function cleanPdfPageText(raw: string): string {
  return normalizePdfChars(raw)
    .replace(/\r\n?/g, "\n")
    .replace(/\f/g, "\n")
    .replace(/[ \t\v]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Normalise text for QUOTE MATCHING: character normalisation plus every run
 * of whitespace (spaces, line breaks, column breaks, page breaks) collapsed
 * to one space. Apply it to both the quote and the text; a verbatim quote
 * copied from the source PDF is then a plain substring of the extracted text
 * however the lines were broken.
 */
export function normalizeForQuoteMatch(text: string): string {
  return normalizePdfChars(text).replace(/\s+/g, " ").trim();
}

// ----- Result shape + page lookup -----

// Separator between pages in the joined `cleanText`: a form feed, the
// conventional page-break character (and what `pdftotext` emits). It never
// occurs inside a page (cleanPdfPageText removes it), so page boundaries are
// recoverable from the joined text alone, and it is whitespace, so
// whitespace-normalised quote matching sees straight through it.
export const PDF_PAGE_SEPARATOR = "\f";

/** The text of one PDF, with page boundaries kept. */
export interface PdfText {
  // All pages joined with PDF_PAGE_SEPARATOR. This is what gets hashed.
  cleanText: string;
  // Clean text per page; `pages[0]` is page 1. A page with no text is "".
  pages: string[];
  // `pageOffsets[i]` = index in `cleanText` where page i+1 starts.
  pageOffsets: number[];
  // Number of pages in the document (= pages.length).
  pageCount: number;
  // Size of the PDF file in bytes.
  byteLength: number;
  // 1-based numbers of pages that yielded no text (e.g. scanned inserts in an
  // otherwise textual document). Empty for a fully textual PDF.
  pagesWithoutText: number[];
}

/**
 * Join per-page clean text into a `PdfText` (minus the byte length, which
 * only the caller knows). Pure, so tests can build page structures directly.
 */
export function assemblePdfText(pages: string[], byteLength: number): PdfText {
  const pageOffsets: number[] = [];
  const pagesWithoutText: number[] = [];
  let offset = 0;
  pages.forEach((text, i) => {
    pageOffsets.push(offset);
    if (text.length === 0) pagesWithoutText.push(i + 1);
    // Next page starts after this page's text and one separator.
    offset += text.length + PDF_PAGE_SEPARATOR.length;
  });
  return {
    cleanText: pages.join(PDF_PAGE_SEPARATOR),
    pages,
    pageOffsets,
    pageCount: pages.length,
    byteLength,
    pagesWithoutText,
  };
}

/**
 * 1-based page number containing character `offset` of `cleanText`, or
 * undefined when the offset is out of range. An offset that lands on a page
 * separator belongs to the page before it.
 */
export function pdfPageAtOffset(pdf: Pick<PdfText, "pageOffsets" | "cleanText">, offset: number): number | undefined {
  if (!Number.isInteger(offset) || offset < 0 || offset >= pdf.cleanText.length) return undefined;
  // Last page whose start is at or before the offset (binary search).
  let lo = 0;
  let hi = pdf.pageOffsets.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (pdf.pageOffsets[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

/** Where a quote was found: the pages it starts and ends on (1-based). */
export interface PdfQuoteLocation {
  page: number; // page the quote starts on
  endPage: number; // page it ends on (= page unless it runs across a break)
}

/**
 * Find a verbatim quote in the extracted text and say which page it is on.
 * Matching is whitespace-normalised on both sides (`normalizeForQuoteMatch`),
 * so line, column and page breaks inside the quote do not matter. Returns the
 * FIRST occurrence, or undefined when the quote is not in the text (or is
 * empty).
 *
 * Note a quote that runs across a page break only matches when nothing sits
 * between the two halves in the PDF; a running header or footer repeated on
 * every page does sit between them, so quote within one page where possible.
 */
export function findPdfQuote(pdf: Pick<PdfText, "pages">, quote: string): PdfQuoteLocation | undefined {
  const needle = normalizeForQuoteMatch(quote);
  if (!needle) return undefined;

  // Build the normalised haystack page by page, remembering where each page
  // starts in it, so a match position maps straight back to a page number.
  const starts: number[] = [];
  let haystack = "";
  for (const page of pdf.pages) {
    const norm = normalizeForQuoteMatch(page);
    // One space between non-empty pages (what the page separator collapses to).
    if (haystack && norm) haystack += " ";
    starts.push(haystack.length);
    haystack += norm;
  }

  const at = haystack.indexOf(needle);
  if (at < 0) return undefined;

  /** 1-based page holding normalised position `pos` (last start <= pos). */
  const pageOf = (pos: number): number => {
    let page = 1;
    for (let i = 0; i < starts.length; i++) {
      if (starts[i] <= pos) page = i + 1;
      else break;
    }
    return page;
  };
  return { page: pageOf(at), endPage: pageOf(at + needle.length - 1) };
}

// ----- Extraction (isolated in a worker thread) -----

/** What the parent hands the worker (see pdf-text.worker.ts). */
export interface PdfWorkerInput {
  bytes: Uint8Array; // the PDF file
  maxPages: number; // refuse documents with more pages
  // Stop reading once this many RAW characters have been read. Raw text is
  // never shorter than clean text, so this is only a memory guard; the real
  // text cap is applied to the clean text by the parent.
  maxRawChars: number;
}

/** What the worker posts back: raw per-page text, or a reasoned failure. */
export type PdfWorkerOutput =
  | { ok: true; pages: string[] }
  | { ok: false; reason: PdfFailureReason; message: string; details?: PdfFailureDetails };

/**
 * How to start the worker script that sits next to this file.
 *
 *  - Compiled code (lib/, what is deployed): run `pdf-text.worker.js` directly.
 *  - Under tsx (tests, eval), this file is `.ts` and so is the worker. A
 *    worker thread does not reliably inherit the tsx loader across Node 22
 *    releases, so it is started from a two-line bootstrap that registers
 *    tsx's require hook and then loads the TypeScript worker.
 *
 * Either way the worker gets NO inherited Node flags (`execArgv: []`), so a
 * parent's preloads (such as the test setup file) never run inside it.
 */
function workerEntry(): { entry: string; evalEntry: boolean } {
  const ext = path.extname(__filename); // ".js" in lib/, ".ts" under tsx
  const file = path.join(__dirname, `pdf-text.worker${ext}`);
  if (ext !== ".ts") return { entry: file, evalEntry: false };
  return { entry: `require("tsx/cjs"); require(${JSON.stringify(file)});`, evalEntry: true };
}

// How often the parent samples process memory while a PDF is being parsed.
// Inflating a compressed stream allocates hundreds of MB per second, so the
// sample has to be frequent for the watchdog to stop it near the budget.
const RSS_POLL_INTERVAL_MS = 25;

const BYTES_PER_MB = 1024 * 1024;

/**
 * Run the parser in a worker thread and wait for its answer, enforcing the
 * wall-clock timeout, the memory watchdog and the worker's heap limit. Never
 * rejects with anything but a PdfFetchError: a worker crash (parser bug, heap
 * limit) is "malformed", running out of time is "parse-timeout", growing
 * process memory past the budget is "memory-exceeded".
 *
 * Memory watchdog: the process's RSS is recorded before the worker starts
 * (the baseline) and sampled every RSS_POLL_INTERVAL_MS while it runs. Once
 * RSS has grown by more than `limits.parseRssGrowthMb`, the worker is
 * terminated, which frees everything it allocated. This is done from the
 * PARENT because the worker cannot be trusted to notice: the allocation
 * happens inside one synchronous parser call. Between two samples memory can
 * still rise somewhat past the budget (the parser grows its buffers by
 * doubling), which the default budget leaves room for.
 */
function runPdfWorker(input: PdfWorkerInput, limits: PdfLimits, label: string): Promise<string[]> {
  return new Promise<string[]>((resolve, reject) => {
    // Read before the buffer is transferred to the worker (after which the
    // parent's view of it is empty).
    const byteLength = input.bytes.byteLength;
    // Baseline for the memory watchdog: what the process holds before parsing.
    const baselineRss = process.memoryUsage.rss();
    const budgetBytes = limits.parseRssGrowthMb * BYTES_PER_MB;

    const { entry, evalEntry } = workerEntry();
    const worker = new Worker(entry, {
      eval: evalEntry,
      workerData: input,
      // Move the PDF bytes to the worker instead of copying them again.
      transferList: [input.bytes.buffer as ArrayBuffer],
      execArgv: [],
      // Bounds the worker's JavaScript heap only; see the watchdog below for
      // memory outside it.
      resourceLimits: { maxOldGenerationSizeMb: limits.parseMemoryMb },
    });

    // Settle exactly once, always stopping both timers and the worker.
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(watchdog);
      // terminate() is what actually stops a parser stuck in a CPU loop, and
      // what releases the memory of one that is inflating a huge stream.
      void worker.terminate();
      fn();
    };

    const timer = setTimeout(() => {
      finish(() =>
        reject(
          new PdfFetchError(
            "parse-timeout",
            `PDF parse timed out for ${label}: stopped after ${limits.parseTimeoutMs} ms`,
            { timeoutMs: limits.parseTimeoutMs, byteLength }
          )
        )
      );
    }, limits.parseTimeoutMs);

    // Memory watchdog (see the function comment).
    const watchdog = setInterval(() => {
      const growth = process.memoryUsage.rss() - baselineRss;
      if (growth <= budgetBytes) return;
      // Round UP (issue #277). We only get here when growth is strictly over
      // the budget, so the reported figure must also read as over it. With
      // Math.round a growth of 64.3 MB against a 64 MB budget was reported as
      // "grew by 64 MB, over the 64 MB budget": confusing for an admin, and it
      // made the test's `rssGrowthMb > budget` check fail at random.
      const grownMb = Math.ceil(growth / BYTES_PER_MB);
      finish(() =>
        reject(
          new PdfFetchError(
            "memory-exceeded",
            `PDF parse used too much memory for ${label}: process memory grew by ${grownMb} MB, over the ` +
              `${limits.parseRssGrowthMb} MB budget, from a ${byteLength}-byte file (parse stopped; ` +
              "likely a stream that inflates to far more than its size)",
            { rssGrowthMb: grownMb, maxRssGrowthMb: limits.parseRssGrowthMb, byteLength }
          )
        )
      );
    }, RSS_POLL_INTERVAL_MS);

    worker.once("message", (out: PdfWorkerOutput) => {
      finish(() => {
        if (out.ok) resolve(out.pages);
        else {
          // Add what the parent knows to the worker's numbers, so the error
          // always says which limit applied.
          const details: PdfFailureDetails = {
            byteLength,
            ...(out.reason === "text-too-long" ? { maxTextChars: limits.maxTextChars } : {}),
            ...(out.details ?? {}),
          };
          reject(new PdfFetchError(out.reason, `${out.message} (${label})`, details));
        }
      });
    });
    // Uncaught error inside the worker, including hitting its heap limit.
    worker.once("error", (err) => {
      finish(() =>
        reject(new PdfFetchError("malformed", `PDF parser failed for ${label}: ${err?.message ?? String(err)}`))
      );
    });
    // Exited without posting a result.
    worker.once("exit", (code) => {
      finish(() =>
        reject(new PdfFetchError("malformed", `PDF parser exited without a result for ${label} (code ${code})`))
      );
    });
  });
}

/**
 * Extract clean, per-page text from PDF bytes.
 *
 * Checks, in order: byte cap, `%PDF-` header, then (in the worker, under the
 * timeout and the memory watchdog) the parse itself and the page cap, then the text cap and the "has a text layer"
 * floor. Every refusal is a `PdfFetchError` with a reason; the text is never
 * truncated and an image-only PDF never comes back as empty text.
 *
 * @param bytes  the PDF file
 * @param label  what to call the document in error messages (its URL)
 * @param limits caps to apply (default DEFAULT_PDF_LIMITS)
 */
export async function extractPdfText(
  bytes: Uint8Array,
  label: string,
  limits: PdfLimits = DEFAULT_PDF_LIMITS
): Promise<PdfText> {
  const byteLength = bytes.byteLength;

  // 1. Byte cap (the fetch service already enforced it while downloading).
  if (byteLength > limits.maxBytes) {
    throw new PdfFetchError(
      "too-large",
      `PDF too large for ${label}: ${byteLength} bytes exceeds the ${limits.maxBytes}-byte cap`,
      { byteLength, maxBytes: limits.maxBytes }
    );
  }

  // 2. Magic bytes: refuse anything that is not a PDF before parsing it.
  if (!hasPdfMagic(bytes)) {
    throw new PdfFetchError(
      "not-a-pdf",
      `Not a PDF for ${label}: the response was routed as a PDF but has no %PDF- header ` +
        `(${byteLength} bytes; likely an error page or login wall)`,
      { byteLength }
    );
  }

  // 3 + 4. Parse in the worker (timeout, memory watchdog, page cap). One
  // copy of the bytes is made here and then MOVED to the worker, so the
  // caller's buffer is left intact and the file is held twice, not three
  // times.
  const rawPages = await runPdfWorker(
    {
      bytes: new Uint8Array(bytes),
      maxPages: limits.maxPages,
      // Raw text can exceed clean text by the whitespace we collapse; allow
      // double before the worker gives up early.
      maxRawChars: limits.maxTextChars * 2,
    },
    limits,
    label
  );

  // 5. Clean each page, then apply the text cap to the clean text. Over the
  // cap is a FAILURE that says how much there was; never a silent slice.
  const pages = rawPages.map(cleanPdfPageText);
  const pdf = assemblePdfText(pages, byteLength);
  if (pdf.cleanText.length > limits.maxTextChars) {
    throw new PdfFetchError(
      "text-too-long",
      `PDF text too long for ${label}: ${pdf.cleanText.length} characters over ${pdf.pageCount} pages ` +
        `exceeds the ${limits.maxTextChars}-character cap (not truncated; the fetch is refused)`,
      {
        charsRead: pdf.cleanText.length,
        pagesRead: pdf.pageCount,
        pageCount: pdf.pageCount,
        maxTextChars: limits.maxTextChars,
        byteLength,
      }
    );
  }

  // 6. A text layer must exist. Count non-whitespace characters so a file of
  // blank pages (or page separators only) cannot pass.
  const visibleChars = pdf.cleanText.replace(/\s+/g, "").length;
  if (visibleChars < limits.minTextChars) {
    throw new PdfFetchError(
      "no-extractable-text",
      `No extractable text in PDF for ${label}: ${visibleChars} characters over ${pdf.pageCount} pages ` +
        `(below the ${limits.minTextChars}-character floor; likely scanned / image-only, which needs OCR)`,
      { charsRead: visibleChars, pageCount: pdf.pageCount, minTextChars: limits.minTextChars, byteLength }
    );
  }

  return pdf;
}
