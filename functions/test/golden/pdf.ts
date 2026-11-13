// ============================================
// Golden set — a tiny PDF writer for synthetic documents (issue #35)
// ============================================
//
// A fixture document is a few lines of ASCII text. The engine only accepts a
// real file (PDF / JPEG / PNG, sniffed from its bytes), and the LIVE refresh
// sends it to a real model, so the text must be a genuine, readable PDF.
//
// Why not test/helpers/pdf-fixture.ts: that builder maps every character to a
// private glyph code with a ToUnicode table (right for testing a text extractor,
// but a rendered page would show the wrong glyphs to a model that looks at the
// page image). This one uses the standard Helvetica font with plain ASCII codes,
// so the page looks like what it says.
//
// Deterministic on purpose: the same lines always give the same bytes, so the
// request hash (which covers a digest of the bytes) is stable across runs and
// machines. Nothing here reads a clock or a random source.

/** The bytes of a one-page PDF showing `lines` top to bottom. ASCII only. */
export function buildTextPdf(lines: readonly string[]): Buffer {
  for (const l of lines) {
    // eslint-disable-next-line no-control-regex
    if (!/^[\x20-\x7e]*$/.test(l)) throw new Error(`fixture document line is not printable ASCII: ${JSON.stringify(l)}`);
  }
  // PDF string escapes: backslash and parentheses.
  const esc = (s: string): string => s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
  // Content stream: 11pt Helvetica, 16pt leading, starting near the top-left.
  const content = `BT\n/F1 11 Tf\n16 TL\n50 780 Td\n${lines.map((l) => `(${esc(l)}) Tj`).join("\nT*\n")}\nET`;

  // Objects: 1 catalogue, 2 page tree, 3 page, 4 content, 5 font.
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${Buffer.byteLength(content, "latin1")} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
  ];

  // Assemble with byte offsets for the cross-reference table.
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out, "latin1"));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefAt = Buffer.byteLength(out, "latin1");
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}
