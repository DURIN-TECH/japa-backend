import { createDeflate, deflateSync } from "node:zlib";

// ============================================
// Synthetic PDF fixtures (issue #33)
// ============================================
//
// Builds small, valid PDF files in memory for the PDF fetch tests, so the
// repo carries no binary fixtures and `npm test` needs no network. The real
// guidance PDFs (hundreds of kilobytes each) are only fetched by the opt-in
// live test (test/scrapers/shared/fetch/pdf-live.integration.test.ts).
//
// A built file has one page object per entry in `pages`, each with a content
// stream that draws the page's lines top to bottom in one font. The font
// carries a ToUnicode map, which is how a PDF says "glyph code N means this
// Unicode character": that lets a fixture contain ANY character, including
// the ones the extractor has to normalise (ligature glyphs such as U+FB01,
// soft hyphens, no-break spaces), exactly as a typeset document would.

/** Options for `buildPdf`. */
export interface BuildPdfOptions {
  // Add an /Encrypt dictionary so the file demands a password to open.
  // (The keys are dummies: no password opens it, which is the point.)
  encrypted?: boolean;
  // Bytes placed before the `%PDF-` header (readers tolerate a short prefix).
  prefix?: string;
  // Store each page's content stream deflate-compressed (`/FlateDecode`), as
  // almost every real PDF does. The extracted text is the same either way.
  compress?: boolean;
  // ALREADY-DEFLATED content stream to use for page 1 instead of one built
  // from its text (see `deflatedPaddedContent`). Requires nothing else; the
  // page's entry in `pages` is then ignored.
  deflatedFirstPage?: Buffer;
}

/**
 * Build, deflate-compressed, a page content stream that is `paddingMb` MB of
 * spaces followed by one short line of text. Spaces are legal filler between
 * drawing operators, and megabytes of one repeated byte compress about
 * 1000:1, so the result is small on disk and enormous once a parser inflates
 * it: the shape of a "decompression bomb". Used to test that the parse is
 * stopped by its memory budget.
 *
 * The padding is fed to the compressor 1 MB at a time, so building the
 * fixture never holds the inflated size in memory itself.
 */
export function deflatedPaddedContent(paddingMb: number): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const deflate = createDeflate({ level: 9 });
    const out: Buffer[] = [];
    deflate.on("data", (chunk: Buffer) => out.push(chunk));
    deflate.on("error", reject);
    deflate.on("end", () => resolve(Buffer.concat(out)));

    const megabyte = Buffer.alloc(1024 * 1024, 0x20); // 1 MB of spaces
    let written = 0;
    /** Write padding until done or the compressor asks us to wait. */
    const pump = () => {
      while (written < paddingMb) {
        written++;
        if (!deflate.write(megabyte)) {
          deflate.once("drain", pump);
          return;
        }
      }
      // A real (if tiny) text line after the padding, in the standard font.
      deflate.end(Buffer.from("BT /F1 11 Tf 50 780 Td (padded page) Tj ET", "latin1"));
    };
    pump();
  });
}

/** Latin-1 bytes of an ASCII string. */
const ascii = (s: string): Buffer => Buffer.from(s, "latin1");

/** Two-digit uppercase hex of a glyph code (1..255). */
const hex2 = (n: number): string => n.toString(16).toUpperCase().padStart(2, "0");

/** Four-digit uppercase hex of a UTF-16 code unit. */
const hex4 = (n: number): string => n.toString(16).toUpperCase().padStart(4, "0");

/**
 * Build a PDF whose page i shows the lines of `pages[i]` (one string per
 * page, lines separated by "\n"). A page given as "" has an empty content
 * stream: no text layer, like a scanned page.
 *
 * Limits of this tiny builder: at most 255 distinct characters per document,
 * and only characters in the Basic Multilingual Plane.
 */
export function buildPdf(pages: string[], options: BuildPdfOptions = {}): Buffer {
  // ---- Assign each distinct character a one-byte glyph code (1..255) ----
  const codeOf = new Map<string, number>();
  for (const ch of pages.join("").replace(/\n/g, "")) {
    if (!codeOf.has(ch)) codeOf.set(ch, codeOf.size + 1);
  }
  if (codeOf.size > 255) throw new Error("buildPdf: more than 255 distinct characters");

  // ---- ToUnicode CMap: glyph code -> Unicode ----
  const mappings = [...codeOf.entries()].map(([ch, code]) => `<${hex2(code)}> <${hex4(ch.charCodeAt(0))}>`);
  // A bfchar block holds at most 100 entries.
  const blocks: string[] = [];
  for (let i = 0; i < mappings.length; i += 100) {
    const chunk = mappings.slice(i, i + 100);
    blocks.push(`${chunk.length} beginbfchar\n${chunk.join("\n")}\nendbfchar`);
  }
  const cmap =
    "/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n" +
    "/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n" +
    "/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n" +
    "1 begincodespacerange\n<00> <FF>\nendcodespacerange\n" +
    `${blocks.join("\n")}\nendcmap\nCMapName currentdict /CMap defineresource pop\nend\nend`;

  // ---- Objects: 1 catalogue, 2 page tree, 3 font, 4 ToUnicode, then a
  // (page, content stream) pair per page ----
  const objects: Buffer[] = [];
  /** A stream object body: dictionary with /Length (and filter), then the data. */
  const streamBytes = (data: Buffer, filter = ""): Buffer =>
    Buffer.concat([ascii(`<< /Length ${data.length}${filter} >>\nstream\n`), data, ascii("\nendstream")]);
  /** An uncompressed stream object from text. */
  const stream = (data: string): Buffer => streamBytes(ascii(data));
  /** A page content stream: deflated when `compress` is set. */
  const contentStream = (data: string): Buffer =>
    options.compress ? streamBytes(deflateSync(ascii(data)), " /Filter /FlateDecode") : stream(data);

  const pageObjNum = (i: number) => 5 + i * 2; // page i's object number
  const kids = pages.map((_, i) => `${pageObjNum(i)} 0 R`).join(" ");
  objects.push(ascii("<< /Type /Catalog /Pages 2 0 R >>"));
  objects.push(ascii(`<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`));
  objects.push(ascii("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /ToUnicode 4 0 R >>"));
  objects.push(stream(cmap));

  pages.forEach((text, i) => {
    // Content stream: begin text, 11pt font, start near the top-left, then
    // one line per `Tj`, moving down 14pt each time (`T*`).
    let content = "";
    if (text.length > 0) {
      const lines = text.split("\n").map((line) => {
        const glyphs = [...line].map((ch) => hex2(codeOf.get(ch) as number)).join("");
        return `<${glyphs}> Tj`;
      });
      content = `BT\n/F1 11 Tf\n14 TL\n50 780 Td\n${lines.join("\nT*\n")}\nET`;
    }
    objects.push(
      ascii(
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] " +
          `/Resources << /Font << /F1 3 0 R >> >> /Contents ${pageObjNum(i) + 1} 0 R >>`
      )
    );
    // Page 1 may be given as a ready-made deflated stream (see options).
    if (i === 0 && options.deflatedFirstPage) {
      objects.push(streamBytes(options.deflatedFirstPage, " /Filter /FlateDecode"));
    } else {
      objects.push(contentStream(content));
    }
  });

  // ---- Serialise: header, objects (recording byte offsets), xref, trailer ----
  const parts: Buffer[] = [];
  let length = 0;
  const push = (b: Buffer) => {
    parts.push(b);
    length += b.length;
  };
  if (options.prefix) push(ascii(options.prefix));
  push(ascii("%PDF-1.4\n"));

  let encryptRef = "";
  if (options.encrypted) {
    // Standard security handler, 40-bit RC4, with dummy owner/user keys: a
    // reader cannot validate the empty password and must ask for one.
    const key = "<" + "AB".repeat(32) + ">";
    objects.push(ascii(`<< /Filter /Standard /V 1 /R 2 /O ${key} /U ${key} /P -44 >>`));
    encryptRef = ` /Encrypt ${objects.length} 0 R /ID [<${"01".repeat(16)}> <${"01".repeat(16)}>]`;
  }

  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(length);
    push(ascii(`${i + 1} 0 obj\n`));
    push(body);
    push(ascii("\nendobj\n"));
  });

  const xrefAt = length;
  // Each xref entry is exactly 20 bytes: 10-digit offset, generation, flag.
  const entries = offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("");
  push(ascii(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${entries}`));
  push(ascii(`trailer\n<< /Size ${objects.length + 1} /Root 1 0 R${encryptRef} >>\nstartxref\n${xrefAt}\n%%EOF\n`));

  return Buffer.concat(parts, length);
}
