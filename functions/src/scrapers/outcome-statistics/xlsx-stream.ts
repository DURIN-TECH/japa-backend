import * as unzipper from "unzipper";
import { SaxesParser } from "saxes";
import { StringDecoder } from "string_decoder";

// ============================================
// STREAMING .xlsx READER (issue #116)
// ============================================
//
// Reads big spreadsheets WITHOUT loading them whole. The real Home Office
// outcomes workbook is 31.5 MB zipped but its two data sheets are ~108 MB and
// ~192 MB of XML, so a DOM-style reader (or one that unzips a sheet to memory,
// which is also what a function's /tmp is) would not fit a Cloud Function.
//
// How it stays small:
//  - The zip's central directory is read first (unzipper.Open.file reads from
//    disk by offset), so the small parts (workbook.xml, its rels and
//    sharedStrings.xml) can be read BEFORE any sheet even though the file
//    stores sheets first. A forward-only zip reader would have to spool every
//    sheet to a temp file to wait for the shared strings.
//  - A sheet is then streamed through a SAX parser (saxes); each row is
//    handed to a callback and dropped. Memory is the shared string table
//    (a few hundred short strings for these files) plus one row.
//  - The callback can ask to stop (e.g. after the header row), which destroys
//    the stream so the rest of the sheet is never decompressed.
//
// Generic: nothing here knows what the sheets contain. Cell values come back as
// text (shared strings resolved, numbers as their raw text); the caller parses.

/** One row's cells by 0-based column index; gaps are undefined. */
export type XlsxRow = (string | undefined)[];

/** Row callback: return true to stop reading the sheet. */
export type XlsxRowHandler = (rowNumber: number, cells: XlsxRow) => boolean | void;

/** Element name without any namespace prefix ("x:row" -> "row"). */
function local(name: string): string {
  const i = name.indexOf(":");
  return i === -1 ? name : name.slice(i + 1);
}

/** Column letters of a cell ref ("AB12" -> index 27). */
function columnIndex(ref: string): number {
  let n = 0;
  for (const ch of ref) {
    const code = ch.charCodeAt(0);
    if (code < 65 || code > 90) break; // stop at the first digit
    n = n * 26 + (code - 64);
  }
  return n - 1;
}

/** Parse a small XML document fully with a callback-style SAX handler. */
function parseSmallXml(xml: string, setup: (p: SaxesParser) => void): void {
  const parser = new SaxesParser();
  parser.on("error", (e) => {
    throw e;
  });
  setup(parser);
  parser.write(xml).close();
}

/** An opened workbook: sheet names and a streaming row reader. */
export class XlsxWorkbook {
  private constructor(
    private readonly directory: unzipper.CentralDirectory,
    /** sheet name -> path of its XML inside the zip */
    private readonly sheetPaths: Map<string, string>,
    private readonly sharedStrings: string[]
  ) {}

  /**
   * Open a workbook on disk: reads the directory, workbook.xml (+ rels) and
   * the shared strings, never a sheet.
   */
  static async open(filePath: string): Promise<XlsxWorkbook> {
    const directory = await unzipper.Open.file(filePath);
    const entry = (p: string) => directory.files.find((f) => f.path === p);

    // ---- workbook.xml: sheet name -> relationship id ----
    const wbEntry = entry("xl/workbook.xml");
    if (!wbEntry) throw new Error("Not a valid .xlsx: xl/workbook.xml is missing");
    const sheetRids = new Map<string, string>();
    parseSmallXml((await wbEntry.buffer()).toString("utf8"), (p) => {
      p.on("opentag", (t) => {
        if (local(t.name) !== "sheet") return;
        const name = t.attributes["name"] as string | undefined;
        // r:id (prefix can vary), so look for any attribute named "*:id" / "id".
        const ridKey = Object.keys(t.attributes).find((k) => k === "r:id" || k.endsWith(":id"));
        const rid = ridKey ? (t.attributes[ridKey] as string) : undefined;
        if (name && rid) sheetRids.set(name, rid);
      });
    });

    // ---- workbook.xml.rels: relationship id -> target path ----
    const relsEntry = entry("xl/_rels/workbook.xml.rels");
    if (!relsEntry) throw new Error("Not a valid .xlsx: xl/_rels/workbook.xml.rels is missing");
    const targets = new Map<string, string>();
    parseSmallXml((await relsEntry.buffer()).toString("utf8"), (p) => {
      p.on("opentag", (t) => {
        if (local(t.name) !== "Relationship") return;
        const id = t.attributes["Id"] as string | undefined;
        const target = t.attributes["Target"] as string | undefined;
        if (id && target) targets.set(id, target);
      });
    });

    const sheetPaths = new Map<string, string>();
    for (const [name, rid] of sheetRids) {
      const target = targets.get(rid);
      if (!target) continue;
      // Targets are relative to xl/ ("worksheets/sheet1.xml") or absolute ("/xl/...").
      sheetPaths.set(name, target.startsWith("/") ? target.slice(1) : `xl/${target}`);
    }

    // ---- sharedStrings.xml (absent when a workbook has only inline strings) ----
    const strings: string[] = [];
    const ssEntry = entry("xl/sharedStrings.xml");
    if (ssEntry) {
      let current: string | null = null; // text of the <si> being read
      let inT = false; // inside a <t> that counts
      let phoneticDepth = 0; // inside <rPh> (phonetic runs are not display text)
      parseSmallXml((await ssEntry.buffer()).toString("utf8"), (p) => {
        p.on("opentag", (t) => {
          const n = local(t.name);
          if (n === "si") current = "";
          else if (n === "rPh") phoneticDepth++;
          else if (n === "t" && phoneticDepth === 0) inT = true;
        });
        p.on("text", (text) => {
          if (inT && current !== null) current += text;
        });
        p.on("closetag", (t) => {
          const n = local(t.name);
          if (n === "t") inT = false;
          else if (n === "rPh") phoneticDepth--;
          else if (n === "si") {
            // An empty <si/> still takes an index, so push even when "".
            strings.push(current ?? "");
            current = null;
          }
        });
      });
    }

    return new XlsxWorkbook(directory, sheetPaths, strings);
  }

  /** Sheet names present in the workbook, in no guaranteed order. */
  get sheetNames(): string[] {
    return [...this.sheetPaths.keys()];
  }

  /** True when the workbook has a sheet of exactly this name. */
  hasSheet(name: string): boolean {
    return this.sheetPaths.has(name);
  }

  /**
   * Stream one sheet row by row. Rows arrive in file order; empty rows are
   * skipped by the format itself. Resolves when the sheet ends or the handler
   * returns true. Rejects on malformed XML.
   */
  async streamRows(sheetName: string, onRow: XlsxRowHandler): Promise<void> {
    const path = this.sheetPaths.get(sheetName);
    if (!path) throw new Error(`Sheet "${sheetName}" not found in the workbook`);
    const file = this.directory.files.find((f) => f.path === path);
    if (!file) throw new Error(`Sheet "${sheetName}" points at ${path}, which is not in the file`);

    const shared = this.sharedStrings;
    const parser = new SaxesParser();
    let stopped = false;

    // Per-row / per-cell parse state.
    let rowNumber = 0;
    let cells: XlsxRow = [];
    let colIdx = -1;
    let cellType = "";
    let buf = ""; // text of the current <v> or inline <t>
    let capture = false;
    let inInline = false; // inside <is> (inline string)

    parser.on("error", (e) => {
      throw e;
    });
    parser.on("opentag", (t) => {
      if (stopped) return;
      const n = local(t.name);
      if (n === "row") {
        rowNumber = Number(t.attributes["r"]) || rowNumber + 1;
        cells = [];
      } else if (n === "c") {
        colIdx = columnIndex(String(t.attributes["r"] ?? ""));
        cellType = String(t.attributes["t"] ?? "");
        buf = "";
      } else if (n === "v") {
        capture = true;
        buf = "";
      } else if (n === "is") {
        inInline = true;
        buf = "";
      } else if (n === "t" && inInline) {
        capture = true;
      }
    });
    parser.on("text", (text) => {
      if (capture && !stopped) buf += text;
    });
    parser.on("closetag", (t) => {
      if (stopped) return;
      const n = local(t.name);
      if (n === "v" || (n === "t" && inInline)) {
        capture = false;
      } else if (n === "is") {
        inInline = false;
      } else if (n === "c") {
        if (colIdx >= 0 && (buf !== "" || cellType === "inlineStr")) {
          // Shared string: the <v> is an index into the table.
          cells[colIdx] = cellType === "s" ? shared[Number(buf)] : buf;
        }
        colIdx = -1;
        buf = "";
      } else if (n === "row") {
        if (onRow(rowNumber, cells) === true) stopped = true;
      }
    });

    const stream = file.stream();
    const decoder = new StringDecoder("utf8"); // a multi-byte char may span chunks
    try {
      for await (const chunk of stream) {
        parser.write(decoder.write(chunk as Buffer));
        if (stopped) break;
      }
      if (!stopped) parser.write(decoder.end()).close();
    } finally {
      // Stop decompressing the rest if we left early or failed.
      stream.destroy();
    }
  }
}
