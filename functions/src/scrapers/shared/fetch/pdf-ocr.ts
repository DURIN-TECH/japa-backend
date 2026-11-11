import { createHash } from "crypto";
import * as path from "path";
import { Worker } from "worker_threads";
import {
  DEFAULT_PDF_LIMITS,
  PdfFailureDetails,
  PdfFailureReason,
  PdfFetchError,
  PdfLimits,
  PdfOcrInfo,
  PdfOcrPage,
  PdfPageMethod,
  PdfText,
  assemblePdfText,
  cleanPdfPageText,
  isPdfFetchError,
  noTextLayerError,
  readPdfPages,
  visibleCharCount,
} from "./pdf-text";

// ============================================
// PDF OCR FALLBACK (issue #38)
// ============================================
//
// Some guidance is published as a SCANNED PDF: each page is a picture of a
// page, with no text layer. `extractPdfText()` (pdf-text.ts, issue #33)
// refuses those with "no-extractable-text". This module is the route for a
// caller that wants them read anyway: `extractPdfTextWithOcr()` tries the text
// layer first and falls back to OCR only for a document that has none.
//
// ---- Engine: tesseract.js (Apache-2.0), fully inside the function ----
//
// Tesseract compiled to WebAssembly, run in a worker thread of this process:
//  - no native build step (the WASM ships inside the npm package) and no
//    native image library: page images come out of the PDF as pure
//    JavaScript (pdf-ocr.worker.ts);
//  - no network: the English model is the `@tesseract.js-data/eng` package,
//    read from node_modules (`langPath`), so tesseract.js never downloads
//    anything and, with `cacheMethod: "none"`, writes nothing to disk;
//  - no third-party service: guidance documents never leave the function.
// The cost is time and memory (see DEFAULT_OCR_LIMITS).
//
// ---- Citation integrity: OCR text is marked, never blended ----
//
// A rubric criterion is validated by matching a verbatim quote against the
// snapshot text. OCR text is less reliable than embedded text, so:
//  - the result carries `extraction` (PdfExtraction): the method per page
//    ("text-layer" | "ocr" | "none"), the engine, its version, the model, and
//    the engine's confidence per OCR page;
//  - a page that has a usable text layer KEEPS ITS EMBEDDED TEXT and is never
//    sent to OCR; only pages without one are recognised (so a page is never
//    both, and OCR text is never silently mixed into a textual page);
//  - the snapshot store and the quote check carry the marker on, so a
//    reviewer sees that a quote was matched against OCR'd text.
//
// ---- Same cleaning and hash gate ----
//
// OCR text goes through `cleanPdfPageText` and is joined with the page
// separator exactly like text-layer text, so it is hashed the same way and
// page boundaries survive (OCR runs per page). Tesseract is deterministic for
// the same image, model and version, so an unchanged scan hashes the same.
// To make an unchanged document FREE (not just unchanged), the caller may pass
// the sha256 of the file it last recognised and the content hash that gave:
// a byte-identical file then skips OCR entirely (`ocrReusedContentHash`).
//
// ---- Bounds (a PDF is untrusted input) ----
//
//  - page cap per document and a page BUDGET shared across a crawl run (the
//    "spend cap": OCR costs compute, not money, so pages are the unit);
//  - image extraction in its own worker thread (timeout + RSS watchdog);
//  - the OCR engine in its own worker thread, under a total wall-clock
//    timeout and the same RSS watchdog, terminated on either;
//  - a pixel cap per image, an image count cap per page, a PNG byte cap;
//  - a confidence floor (mean and per page) and a "looks like text" check:
//    garbage is REJECTED, never fed into extraction.

// ----- Limits -----

/** Limits for the OCR route. Any subset can be overridden. */
export interface OcrLimits {
  // Master switch: false = behave exactly like extractPdfText() (refuse).
  enabled: boolean;
  // Most pages OCR'd for ONE document. Over it: "ocr-too-many-pages".
  maxPages: number;
  // A page whose embedded text has fewer visible characters than this has no
  // usable text layer and is OCR'd; at or above it, the embedded text is kept.
  minPageTextChars: number;
  // Wall-clock budget for the whole OCR of one document, ms.
  totalTimeoutMs: number;
  // Wall-clock budget for pulling the page images out of the PDF, ms.
  imageTimeoutMs: number;
  // How far process RSS (MB) may grow during image extraction / OCR.
  rssGrowthMb: number;
  // Largest embedded image accepted, in pixels (decoded size bomb guard).
  maxImagePixels: number;
  // Images recognised per page (largest first) and the smallest side worth it.
  maxImagesPerPage: number;
  minImageSide: number;
  // Cap on the total PNG bytes the image step may hand back.
  maxTotalPngBytes: number;
  // Floors on the engine's 0-100 confidence: the characters-weighted mean
  // over all OCR'd pages, and any single page that produced text.
  minMeanConfidence: number;
  minPageConfidence: number;
  // Lowest share of visible characters that are letters or digits. Below it
  // the output is symbol noise, whatever the engine claims.
  minAlphanumericShare: number;
  // OCR language (the model package installed is English).
  language: string;
}

/**
 * Production defaults.
 *
 *  - maxPages 30: OCR of a 300 dpi page takes roughly 5-15 s on the crawl
 *    function's fraction of a vCPU, so 30 pages fits in totalTimeoutMs.
 *  - totalTimeoutMs 240 s: inside the 540 s function limit, leaving time for
 *    the rest of the crawl.
 *  - rssGrowthMb 300: the WASM engine plus model take about 150 MB, and a
 *    page image a few tens more. NOTE the crawl function's 512 MB is too small
 *    for this on top of an idle instance; the function that runs OCR should
 *    have 1 GB (see the guidance README).
 *  - mean confidence 70 / page 40: clean scans score 85-95; below 70 on
 *    average, or any page below 40, the words are too unreliable to quote.
 */
export const DEFAULT_OCR_LIMITS: Readonly<OcrLimits> = Object.freeze({
  enabled: true,
  maxPages: 30,
  minPageTextChars: 25,
  totalTimeoutMs: 240_000,
  imageTimeoutMs: 60_000,
  rssGrowthMb: 300,
  maxImagePixels: 16_000_000,
  maxImagesPerPage: 4,
  minImageSide: 100,
  maxTotalPngBytes: 96 * 1024 * 1024,
  minMeanConfidence: 70,
  minPageConfidence: 40,
  minAlphanumericShare: 0.6,
  language: "eng",
});

/**
 * Pages OCR may still spend in one crawl run: the spend cap. Created once per
 * run by the caller and shared by every document of that run; pages are taken
 * when OCR is about to start (and not given back if it then fails, because
 * the compute was spent).
 */
export class OcrBudget {
  constructor(public pagesLeft: number) {}
}

/** Default run budget: two full-size documents. */
export const DEFAULT_OCR_RUN_BUDGET_PAGES = 60;

/** What the caller passes to `extractPdfTextWithOcr`. */
export interface PdfOcrOptions {
  limits?: Partial<OcrLimits>;
  // The run's shared page budget (none = unlimited, for tests / one-offs).
  budget?: OcrBudget;
  // What the caller last recognised for this document: if the file is
  // byte-identical, OCR is skipped (see the header).
  lastRecognised?: { pdfSha256: string; contentHash: string };
}

// ----- Engine identity (recorded on every OCR snapshot) -----

// Pinned in package.json; update these strings with the packages.
const OCR_ENGINE = "tesseract.js";
const OCR_ENGINE_VERSION = "tesseract.js 7.0.0 (tesseract.js-core 7.0.0)";
const OCR_MODEL_DIR = "4.0.0_best_int";
const OCR_MODEL = `eng ${OCR_MODEL_DIR}`;

// ----- Worker messages (image extraction) -----

/** What the parent hands the image worker (see pdf-ocr.worker.ts). */
export interface PdfOcrImageWorkerInput {
  bytes: Uint8Array;
  pages: number[]; // 1-based pages to pull images from
  maxImagePixels: number;
  maxImagesPerPage: number;
  minImageSide: number;
  maxTotalPngBytes: number;
}

/** What it posts back: greyscale PNGs per page, or a reasoned failure. */
export type PdfOcrImageWorkerOutput =
  | { ok: true; pages: { page: number; images: Uint8Array[] }[] }
  | { ok: false; reason: PdfFailureReason; message: string; details?: PdfFailureDetails };

const BYTES_PER_MB = 1024 * 1024;
// RSS sampling interval, as in pdf-text.ts.
const RSS_POLL_INTERVAL_MS = 25;

/**
 * Start the image worker: compiled code runs `pdf-ocr.worker.js`; under tsx
 * (tests) the `.ts` worker is started through a tsx bootstrap. Same approach
 * and same "no inherited Node flags" rule as pdf-text.ts.
 */
function imageWorkerEntry(): { entry: string; evalEntry: boolean } {
  const ext = path.extname(__filename);
  const file = path.join(__dirname, `pdf-ocr.worker${ext}`);
  if (ext !== ".ts") return { entry: file, evalEntry: false };
  return { entry: `require("tsx/cjs"); require(${JSON.stringify(file)});`, evalEntry: true };
}

/**
 * Pull the page images out of the PDF in a worker thread, under the image
 * timeout and the RSS watchdog. Rejects only with a PdfFetchError.
 */
function runImageWorker(input: PdfOcrImageWorkerInput, limits: OcrLimits, label: string): Promise<{ page: number; images: Uint8Array[] }[]> {
  return new Promise((resolve, reject) => {
    const byteLength = input.bytes.byteLength;
    const baselineRss = process.memoryUsage.rss();
    const { entry, evalEntry } = imageWorkerEntry();
    const worker = new Worker(entry, {
      eval: evalEntry,
      workerData: input,
      transferList: [input.bytes.buffer as ArrayBuffer],
      execArgv: [],
      resourceLimits: { maxOldGenerationSizeMb: DEFAULT_PDF_LIMITS.parseMemoryMb },
    });

    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(watchdog);
      void worker.terminate(); // stops a CPU loop and frees inflated streams
      fn();
    };
    const timer = setTimeout(
      () =>
        finish(() =>
          reject(
            new PdfFetchError("parse-timeout", `OCR image extraction timed out for ${label}: stopped after ${limits.imageTimeoutMs} ms`, {
              timeoutMs: limits.imageTimeoutMs,
              byteLength,
            })
          )
        ),
      limits.imageTimeoutMs
    );
    const watchdog = setInterval(() => {
      const growth = process.memoryUsage.rss() - baselineRss;
      if (growth <= limits.rssGrowthMb * BYTES_PER_MB) return;
      const grownMb = Math.round(growth / BYTES_PER_MB);
      finish(() =>
        reject(
          new PdfFetchError(
            "memory-exceeded",
            `OCR image extraction used too much memory for ${label}: process memory grew by ${grownMb} MB, over the ${limits.rssGrowthMb} MB budget`,
            { rssGrowthMb: grownMb, maxRssGrowthMb: limits.rssGrowthMb, byteLength }
          )
        )
      );
    }, RSS_POLL_INTERVAL_MS);

    worker.once("message", (out: PdfOcrImageWorkerOutput) =>
      finish(() => {
        if (out.ok) resolve(out.pages);
        else reject(new PdfFetchError(out.reason, `${out.message} (${label})`, { byteLength, ...(out.details ?? {}) }));
      })
    );
    worker.once("error", (err) =>
      finish(() => reject(new PdfFetchError("ocr-failed", `OCR image worker failed for ${label}: ${err?.message ?? String(err)}`)))
    );
    worker.once("exit", (code) =>
      finish(() => reject(new PdfFetchError("ocr-failed", `OCR image worker exited without a result for ${label} (code ${code})`)))
    );
  });
}

/** Raw OCR result for one page, before cleaning. */
interface OcrPageRaw {
  page: number;
  text: string; // raw text of the page's images, joined
  confidence: number; // characters-weighted mean over the page's images, 0-100
}

/**
 * Recognise the images with tesseract.js. The engine runs in tesseract.js's
 * own worker thread; THIS function owns that handle and terminates it on the
 * total timeout, on the RSS budget, and when done, so a runaway recognition
 * is stopped from outside, as the PDF parser is. Rejects only with a
 * PdfFetchError.
 */
async function recognisePages(
  pages: { page: number; images: Uint8Array[] }[],
  limits: OcrLimits,
  label: string,
  byteLength: number
): Promise<OcrPageRaw[]> {
  const baselineRss = process.memoryUsage.rss();
  // Whichever guard fires first rejects this promise, which the work races.
  let stop!: (e: PdfFetchError) => void;
  const stopped = new Promise<never>((_, reject) => {
    stop = reject;
  });
  stopped.catch(() => undefined); // never an unhandled rejection
  const timer = setTimeout(
    () => stop(new PdfFetchError("parse-timeout", `OCR timed out for ${label}: stopped after ${limits.totalTimeoutMs} ms`, { timeoutMs: limits.totalTimeoutMs, byteLength })),
    limits.totalTimeoutMs
  );
  const watchdog = setInterval(() => {
    const growth = process.memoryUsage.rss() - baselineRss;
    if (growth <= limits.rssGrowthMb * BYTES_PER_MB) return;
    const grownMb = Math.round(growth / BYTES_PER_MB);
    stop(
      new PdfFetchError("memory-exceeded", `OCR used too much memory for ${label}: process memory grew by ${grownMb} MB, over the ${limits.rssGrowthMb} MB budget`, {
        rssGrowthMb: grownMb,
        maxRssGrowthMb: limits.rssGrowthMb,
        byteLength,
      })
    );
  }, RSS_POLL_INTERVAL_MS);

  // Loaded here, not at the top of the file: the engine's WASM is only paid
  // for by a crawl that actually meets a scanned document.
  type TesseractWorker = { recognize(image: Uint8Array | Buffer, options?: object, output?: object): Promise<{ data: { text: string; confidence: number } }>; terminate(): Promise<unknown> };
  let worker: TesseractWorker | undefined;
  let aborted = false;

  const work = (async (): Promise<OcrPageRaw[]> => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const tesseract = require("tesseract.js") as { createWorker: (lang: string, oem: number, options: object) => Promise<TesseractWorker> };
    // Model data from node_modules, never the network; nothing cached to disk.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const modelRoot = path.dirname(require.resolve("@tesseract.js-data/eng/package.json"));
    const created = await tesseract.createWorker(limits.language, 1 /* OEM.LSTM_ONLY */, {
      langPath: path.join(modelRoot, OCR_MODEL_DIR),
      gzip: true,
      cacheMethod: "none",
    });
    // A guard may have fired while the engine was loading.
    if (aborted) {
      await created.terminate().catch(() => undefined);
      return [];
    }
    worker = created;

    const out: OcrPageRaw[] = [];
    for (const p of pages) {
      let text = "";
      let weighted = 0;
      let chars = 0;
      for (const image of p.images) {
        // Text only: skip the engine's hOCR / TSV / block outputs (memory).
        const { data } = await created.recognize(Buffer.from(image), {}, { text: true });
        const n = visibleCharCount(data.text);
        text += (text ? "\n" : "") + data.text;
        weighted += data.confidence * n;
        chars += n;
      }
      out.push({ page: p.page, text, confidence: chars > 0 ? weighted / chars : 0 });
    }
    return out;
  })();
  work.catch(() => undefined); // a late failure after a guard fired is moot

  try {
    return await Promise.race([work, stopped]);
  } catch (err) {
    if (isPdfFetchError(err)) throw err;
    throw new PdfFetchError("ocr-failed", `OCR engine failed for ${label}: ${err instanceof Error ? err.message : String(err)}`, { byteLength });
  } finally {
    aborted = true;
    clearTimeout(timer);
    clearInterval(watchdog);
    // terminate() stops a recognition still in flight.
    if (worker) await worker.terminate().catch(() => undefined);
  }
}

/** Share of a text's visible characters that are letters or digits (0-1). */
function alphanumericShare(text: string): number {
  const visible = text.replace(/\s+/g, "");
  if (!visible) return 0;
  const alnum = visible.match(/[\p{L}\p{N}]/gu)?.length ?? 0;
  return alnum / visible.length;
}

/** sha256 (hex) of the PDF file. */
function sha256OfBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Extract per-page text from a PDF, falling back to OCR when it has no text
 * layer. Everything `extractPdfText()` guarantees still holds (byte cap,
 * magic bytes, isolated parse, page cap, text cap, no truncation, never an
 * empty success); on top of it:
 *
 *  - a PDF WITH a text layer is returned as `extractPdfText()` would, marked
 *    `extraction.method = "text-layer"`; OCR is never started for it;
 *  - one WITHOUT is recognised page by page, and the result is marked
 *    `"ocr"` (or `"mixed"`) with the engine, version and per-page confidence;
 *  - every refusal is a PdfFetchError whose reason names the cause:
 *    "ocr-too-many-pages", "ocr-budget-exceeded", "ocr-low-confidence",
 *    "ocr-failed", "parse-timeout", "memory-exceeded", or
 *    "no-extractable-text" when OCR is off or finds nothing at all.
 *
 * @param bytes  the PDF file
 * @param label  what to call the document in errors (its URL)
 * @param limits the PDF caps (as extractPdfText)
 * @param ocr    OCR options (limits, run budget, last recognised file)
 */
export async function extractPdfTextWithOcr(
  bytes: Uint8Array,
  label: string,
  limits: PdfLimits = DEFAULT_PDF_LIMITS,
  ocr: PdfOcrOptions = {}
): Promise<PdfText> {
  const o: OcrLimits = { ...DEFAULT_OCR_LIMITS, ...(ocr.limits ?? {}) };
  const pdf = await readPdfPages(bytes, label, limits);

  // Per-page method of the embedded text, used both for the text-layer
  // result and as the starting point of an OCR result.
  const embeddedMethods: PdfPageMethod[] = pdf.pages.map((t) => (t.length > 0 ? "text-layer" : "none"));

  // ---- Route 1: a usable text layer. OCR is never involved. ----
  const visibleChars = visibleCharCount(pdf.cleanText);
  if (visibleChars >= limits.minTextChars) {
    return { ...pdf, extraction: { method: "text-layer", pageMethods: embeddedMethods } };
  }

  // ---- No text layer. OCR, if on and if there is anything to recognise. ----
  if (!o.enabled) throw noTextLayerError(label, pdf, visibleChars, limits);
  // Pages with no usable text layer. A page with at least `minPageTextChars`
  // of embedded text keeps it: embedded text is never replaced by OCR.
  const needs: number[] = [];
  pdf.pages.forEach((t, i) => {
    if (visibleCharCount(t) < o.minPageTextChars) needs.push(i + 1);
  });
  if (needs.length === 0) throw noTextLayerError(label, pdf, visibleChars, limits);

  // Same file as the last recognised one: nothing to do. The caller reads
  // only the content hash from this result (see PdfText.ocrReusedContentHash).
  const pdfSha256 = sha256OfBytes(bytes);
  if (ocr.lastRecognised && ocr.lastRecognised.pdfSha256 === pdfSha256) {
    return { ...assemblePdfText([], pdf.byteLength), sourceSha256: pdfSha256, ocrReusedContentHash: ocr.lastRecognised.contentHash };
  }

  // ---- Spend caps, before any compute is used. ----
  if (needs.length > o.maxPages) {
    throw new PdfFetchError(
      "ocr-too-many-pages",
      `OCR refused for ${label}: ${needs.length} pages need OCR, over the ${o.maxPages}-page cap per document (no OCR was run)`,
      { ocrPages: needs.length, ocrMaxPages: o.maxPages, pageCount: pdf.pageCount, byteLength: pdf.byteLength }
    );
  }
  if (ocr.budget) {
    if (ocr.budget.pagesLeft < needs.length) {
      throw new PdfFetchError(
        "ocr-budget-exceeded",
        `OCR refused for ${label}: ${needs.length} pages need OCR but only ${ocr.budget.pagesLeft} remain in this run's OCR budget (no OCR was run; it is retried on a later run)`,
        { ocrPages: needs.length, ocrBudgetPagesLeft: ocr.budget.pagesLeft, pageCount: pdf.pageCount, byteLength: pdf.byteLength }
      );
    }
    ocr.budget.pagesLeft -= needs.length; // spent from here on, even if OCR fails
  }
  console.info(`PDF OCR: ${label} has no text layer; recognising ${needs.length} of ${pdf.pageCount} pages with ${OCR_ENGINE}`);

  // ---- Recognise. ----
  const images = await runImageWorker(
    {
      bytes: new Uint8Array(bytes),
      pages: needs,
      maxImagePixels: o.maxImagePixels,
      maxImagesPerPage: o.maxImagesPerPage,
      minImageSide: o.minImageSide,
      maxTotalPngBytes: o.maxTotalPngBytes,
    },
    o,
    label
  );
  const raw = await recognisePages(images, o, label, pdf.byteLength);

  // ---- Merge: embedded pages untouched, OCR text only where there was none. ----
  const pages = [...pdf.pages];
  const methods = [...embeddedMethods];
  const ocrPages: PdfOcrPage[] = [];
  for (const r of raw) {
    // Same cleaning as the text-layer path, so the hash gate is the same.
    const text = cleanPdfPageText(r.text);
    pages[r.page - 1] = text;
    const chars = visibleCharCount(text);
    methods[r.page - 1] = chars > 0 ? "ocr" : "none";
    if (chars > 0) ocrPages.push({ page: r.page, confidence: Math.round(r.confidence * 10) / 10, chars });
  }
  const merged = assemblePdfText(pages, pdf.byteLength);
  if (merged.cleanText.length > limits.maxTextChars) {
    throw new PdfFetchError(
      "text-too-long",
      `PDF text too long for ${label} after OCR: ${merged.cleanText.length} characters exceeds the ${limits.maxTextChars}-character cap (not truncated; the fetch is refused)`,
      { charsRead: merged.cleanText.length, pageCount: merged.pageCount, maxTextChars: limits.maxTextChars, byteLength: pdf.byteLength }
    );
  }

  // ---- Reject garbage rather than feed it into extraction. ----
  const mergedVisible = visibleCharCount(merged.cleanText);
  if (ocrPages.length === 0 || mergedVisible < limits.minTextChars) {
    throw new PdfFetchError(
      "no-extractable-text",
      `OCR found no usable text in PDF for ${label}: ${mergedVisible} characters over ${pdf.pageCount} pages (below the ${limits.minTextChars}-character floor)`,
      { charsRead: mergedVisible, pageCount: pdf.pageCount, minTextChars: limits.minTextChars, byteLength: pdf.byteLength }
    );
  }
  const totalChars = ocrPages.reduce((n, p) => n + p.chars, 0);
  const mean = ocrPages.reduce((n, p) => n + p.confidence * p.chars, 0) / totalChars;
  const lowest = Math.min(...ocrPages.map((p) => p.confidence));
  const share = alphanumericShare(ocrPages.map((p) => pages[p.page - 1]).join(""));
  if (mean < o.minMeanConfidence || lowest < o.minPageConfidence || share < o.minAlphanumericShare) {
    throw new PdfFetchError(
      "ocr-low-confidence",
      `OCR output rejected for ${label}: mean confidence ${mean.toFixed(1)} (floor ${o.minMeanConfidence}), lowest page ${lowest.toFixed(1)} ` +
        `(floor ${o.minPageConfidence}), ${(share * 100).toFixed(0)}% letters or digits (floor ${Math.round(o.minAlphanumericShare * 100)}%); ` +
        "the text is too unreliable to quote, so nothing was ingested",
      {
        ocrPages: ocrPages.length,
        ocrMeanConfidence: Math.round(mean * 10) / 10,
        ocrMinConfidence: lowest,
        ocrConfidenceFloor: o.minMeanConfidence,
        ocrPageConfidenceFloor: o.minPageConfidence,
        byteLength: pdf.byteLength,
      }
    );
  }

  const info: PdfOcrInfo = {
    engine: OCR_ENGINE,
    engineVersion: OCR_ENGINE_VERSION,
    model: OCR_MODEL,
    language: o.language,
    pages: ocrPages,
    meanConfidence: Math.round(mean * 10) / 10,
    minPageConfidence: lowest,
    confidenceFloor: o.minMeanConfidence,
    pageConfidenceFloor: o.minPageConfidence,
  };
  const anyEmbedded = methods.includes("text-layer");
  return {
    ...merged,
    sourceSha256: pdfSha256,
    extraction: { method: anyEmbedded ? "mixed" : "ocr", pageMethods: methods, ocr: info },
  };
}
