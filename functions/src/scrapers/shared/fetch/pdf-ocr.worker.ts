import { parentPort, workerData } from "worker_threads";
import { deflateSync } from "zlib";
import { extractImages, getDocumentProxy } from "unpdf";
import type { PdfOcrImageWorkerInput, PdfOcrImageWorkerOutput } from "./pdf-ocr";

// ============================================
// PDF OCR — PAGE IMAGE EXTRACTION, WORKER THREAD (issue #38)
// ============================================
//
// Runs on behalf of `extractPdfTextWithOcr()` in pdf-ocr.ts (read the header
// there first). For the pages the parent says have no text layer, this worker
// pulls out the page's EMBEDDED IMAGES and hands them back as small greyscale
// PNGs, ready for the OCR engine. It runs in its own worker thread, under the
// parent's timeout and memory watchdog, exactly like pdf-text.worker.ts: a PDF
// is untrusted input, and decoding its images is where a hostile file does its
// damage (an image declared a few thousand pixels wide can inflate to
// gigabytes), so the parent can terminate this thread at any moment.
//
// Why embedded images and not a rendered page: a scanned PDF is, in practice,
// one full-page image per page. Pulling that image out needs only the pure
// JavaScript parser (PDF.js through `unpdf`), so there is NO native canvas
// module and nothing is compiled at install or deploy time (the other route,
// rendering the page, needs `@napi-rs/canvas`, a prebuilt native binary). The
// limit of this route: a page whose content is VECTOR text outlined as paths,
// or a page drawn from many tiny image tiles, yields no usable image and is
// reported as "no image" (so it ends as `none`, never as invented text).
//
// What is NOT done: no JavaScript in the PDF is run, no embedded file is
// opened, no link or action is followed, and the parser makes no network
// request (same guarantees as pdf-text.worker.ts). Page rotation is not
// applied, so a scan stored sideways is read sideways and will fail the
// confidence floor rather than produce text.
//
// This module must only ever be loaded as a worker (it reads `workerData` and
// posts to `parentPort` at load time).

/** Post the one result message back to the parent (PNG buffers are moved). */
function post(out: PdfOcrImageWorkerOutput): void {
  if (out.ok) {
    const transfer: ArrayBuffer[] = [];
    for (const p of out.pages) for (const img of p.images) transfer.push(img.buffer as ArrayBuffer);
    parentPort?.postMessage(out, transfer);
  } else {
    parentPort?.postMessage(out);
  }
}

// ----- Greyscale PNG encoder (no dependency) -----

// CRC-32 table (the PNG chunk checksum), built once.
const CRC_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** CRC-32 of a byte array. */
function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** One PNG chunk: length, type, data, CRC over type + data. */
function chunk(type: string, data: Uint8Array): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "latin1");
  out.set(data, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/** Encode 8-bit greyscale pixels (`width * height` bytes) as a PNG. */
function encodeGreyPng(width: number, height: number, grey: Uint8Array): Uint8Array {
  // Every scanline is prefixed with filter type 0 ("none").
  const raw = Buffer.alloc((width + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width + 1)] = 0;
    raw.set(grey.subarray(y * width, (y + 1) * width), y * (width + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // colour type 0 = greyscale
  // bytes 10-12 (compression, filter, interlace) stay 0.
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 6 })),
    chunk("IEND", new Uint8Array(0)),
  ]);
  // A standalone ArrayBuffer (not a slice of Node's shared pool), so it can be
  // transferred to the parent without copying.
  const own = new Uint8Array(png.length);
  own.set(png);
  return own;
}

/**
 * Greyscale of a decoded image. 1 channel: as is. 3 channels (RGB) and 4
 * (RGBA): luma, with transparent pixels composited over WHITE (paper), so a
 * scan with an alpha mask does not turn black behind the text.
 */
function toGrey(data: Uint8ClampedArray, pixels: number, channels: 1 | 3 | 4): Uint8Array {
  if (channels === 1) return Uint8Array.from(data.subarray(0, pixels));
  const grey = new Uint8Array(pixels);
  for (let i = 0; i < pixels; i++) {
    const o = i * channels;
    const luma = 0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2];
    const alpha = channels === 4 ? data[o + 3] / 255 : 1;
    grey[i] = Math.round(luma * alpha + 255 * (1 - alpha));
  }
  return grey;
}

/** Map a parser exception to a failure (a password prompt is "encrypted"). */
function failureFor(err: unknown): PdfOcrImageWorkerOutput {
  const name = (err as { name?: unknown } | null)?.name;
  const message = (err as { message?: unknown } | null)?.message;
  const text = typeof message === "string" && message ? message : String(err);
  if (name === "PasswordException") return { ok: false, reason: "encrypted", message: `PDF is password-protected: ${text}` };
  return { ok: false, reason: "ocr-failed", message: `Page images could not be read: ${text}` };
}

/** Read the page images asked for in `workerData` and post the result. */
async function main(): Promise<void> {
  const input = workerData as PdfOcrImageWorkerInput;
  try {
    const doc = await getDocumentProxy(input.bytes, { useSystemFonts: false, disableFontFace: true, verbosity: 0 });

    const pages: { page: number; images: Uint8Array[] }[] = [];
    let totalPngBytes = 0;
    for (const pageNumber of input.pages) {
      if (pageNumber < 1 || pageNumber > doc.numPages) continue; // never trust the list blindly

      const found = await extractImages(doc, pageNumber);
      const images: Uint8Array[] = [];
      // Largest first: the scan itself, before any logo or stamp. Small
      // pieces (rules, bullets, tiles) are not worth recognising.
      const usable = found
        .filter((im) => Math.min(im.width, im.height) >= input.minImageSide)
        .filter((im) => im.width * im.height <= input.maxImagePixels)
        .sort((a, b) => b.width * b.height - a.width * a.height)
        .slice(0, input.maxImagesPerPage);
      for (const im of usable) {
        const png = encodeGreyPng(im.width, im.height, toGrey(im.data, im.width * im.height, im.channels));
        totalPngBytes += png.byteLength;
        // Memory guard on what is handed back, besides the parent's watchdog.
        if (totalPngBytes > input.maxTotalPngBytes) {
          post({
            ok: false,
            reason: "memory-exceeded",
            message: `Page images too large: over ${input.maxTotalPngBytes} bytes of PNG after page ${pageNumber}`,
          });
          return;
        }
        images.push(png);
      }
      pages.push({ page: pageNumber, images });
    }
    post({ ok: true, pages });
  } catch (err) {
    post(failureFor(err));
  }
}

void main();
