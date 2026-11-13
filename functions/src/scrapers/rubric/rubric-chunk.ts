import type { GuidanceSnapshotContent } from "../guidance/types";

// ============================================
// RUBRIC — CHUNKING A SNAPSHOT (issue #40)
// ============================================
//
// A long guidance document (tens of pages, well over 100,000 characters) is
// not sent to the model in one request. It is cut into CHUNKS of bounded
// size, each extracted on its own, and the results are merged in code.
//
// How boundaries are chosen (deterministic: the same snapshot and the same
// limit always give the same chunks):
//
//  - PDF: whole pages are packed greedily, in order, until adding the next
//    page would pass the limit. A page is never split across chunks, because
//    a quote must sit within one page anyway. Pages with no text are left
//    out. Only a single page longer than the limit is cut (as below), and
//    every piece keeps that page's number.
//  - Web page: paragraphs (lines of the cleaned text) are packed greedily the
//    same way. Only a single paragraph longer than the limit is cut, at the
//    last whitespace before the limit.
//
// There is NO OVERLAP between chunks, so no passage is sent twice and overlap
// cannot create duplicates. Every quote is validated against the whole
// snapshot, not the chunk, so a chunk boundary cannot make a real quote fail.
// A rule the document itself repeats (a summary and a detailed section) can
// still come back from two chunks; that is handled at merge time (see
// rubric-extraction.service.ts: the first occurrence in document order wins).
//
// Pure: text in, chunks out.

/** One bounded piece of one snapshot, ready to be put in a prompt. */
export interface SourceChunk {
  sourceId: string;
  contentHash: string;
  docType: "html" | "pdf";
  // 0-based position among this snapshot's chunks, and how many there are.
  chunkIndex: number;
  chunkCount: number;
  // First and last page in the chunk (PDF only, 1-based, inclusive).
  pageStart?: number;
  pageEnd?: number;
  // The text handed to the model. For a PDF each page is introduced by a
  // marker line added by code (see pageMarker); it is not source text.
  text: string;
}

/** The marker line placed before each PDF page in a chunk. */
export function pageMarker(page: number): string {
  return `[[page ${page}]]`;
}

/**
 * Cut a text longer than `maxChars` into pieces of at most `maxChars`, each
 * ending at the last whitespace before the limit (or hard at the limit when
 * there is none).
 */
export function splitLongText(text: string, maxChars: number): string[] {
  const pieces: string[] = [];
  let rest = text;
  while (rest.length > maxChars) {
    // Last whitespace inside the window; never before its midpoint, so a
    // piece is always at least half full and the loop always advances.
    let cut = rest.lastIndexOf(" ", maxChars);
    const newline = rest.lastIndexOf("\n", maxChars);
    cut = Math.max(cut, newline);
    if (cut < maxChars / 2) cut = maxChars;
    pieces.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) pieces.push(rest);
  return pieces.filter((p) => p.length > 0);
}

/** A unit that is packed whole: one PDF page (or piece of one), or one paragraph. */
interface Unit {
  text: string;
  page?: number;
}

/** Split a snapshot into packable units, in document order. */
function unitsOf(snapshot: GuidanceSnapshotContent, maxChars: number): Unit[] {
  const units: Unit[] = [];
  if (snapshot.pages) {
    for (const p of snapshot.pages) {
      const text = p.text.trim();
      if (!text) continue; // a page with no text layer has nothing to extract
      // The marker and its line break count toward the limit.
      const room = maxChars - pageMarker(p.page).length - 1;
      for (const piece of splitLongText(text, room)) units.push({ text: piece, page: p.page });
    }
    return units;
  }
  for (const para of snapshot.text.split(/\n+/)) {
    const text = para.trim();
    if (!text) continue;
    for (const piece of splitLongText(text, maxChars)) units.push({ text: piece });
  }
  return units;
}

/** How a unit is written into a chunk. */
function render(unit: Unit): string {
  return unit.page === undefined ? unit.text : `${pageMarker(unit.page)}\n${unit.text}`;
}

/**
 * Cut one snapshot into chunks of at most `maxChars` characters.
 *
 * @param maxChars upper bound on a chunk's text, in characters (>= 1000)
 */
export function chunkSnapshot(snapshot: GuidanceSnapshotContent, maxChars: number): SourceChunk[] {
  if (!Number.isInteger(maxChars) || maxChars < 1000) throw new Error(`maxChars must be an integer >= 1000 (got ${maxChars})`);
  const groups: Unit[][] = [];
  let current: Unit[] = [];
  let size = 0;
  for (const unit of unitsOf(snapshot, maxChars)) {
    // +2 for the blank line that separates two units.
    const cost = render(unit).length + (current.length > 0 ? 2 : 0);
    if (current.length > 0 && size + cost > maxChars) {
      groups.push(current);
      current = [];
      size = 0;
    }
    size += current.length > 0 ? cost : render(unit).length;
    current.push(unit);
  }
  if (current.length > 0) groups.push(current);

  return groups.map((group, chunkIndex) => {
    const pages = group.map((u) => u.page).filter((p): p is number => p !== undefined);
    return {
      sourceId: snapshot.sourceId,
      contentHash: snapshot.contentHash,
      docType: snapshot.docType,
      chunkIndex,
      chunkCount: groups.length,
      ...(pages.length > 0 ? { pageStart: pages[0], pageEnd: pages[pages.length - 1] } : {}),
      text: group.map(render).join("\n\n"),
    };
  });
}
