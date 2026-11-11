import { findPdfQuote, normalizeForQuoteMatch } from "../shared/fetch/pdf-text";
import { GUIDANCE_SOURCE_ID_RE } from "./guidance-snapshot.store";
import type { GuidanceSnapshotContent } from "./types";

// ============================================
// GUIDANCE — QUOTE INTEGRITY CHECK (issue #111)
// ============================================
//
// A rubric criterion is only as good as the passage it quotes. Before any
// criterion is built from a source, this check proves that passages a human
// read in the published document are present, VERBATIM, in the snapshot that
// was actually stored: so the stored text is the document it claims to be,
// the cleaning step did not mangle it, and (when the same passage is listed
// against two renditions of one document, such as a web page and its PDF)
// the two renditions agree.
//
// Generic by design: a check is DATA (data/guidance-quote-checks.ts): a
// passage plus the ids of the registry entries it must appear in. Nothing
// here knows which document, publisher, country or route a passage is from.
//
// Matching rule: both sides go through `normalizeForQuoteMatch` (the #33
// helper: ligatures expanded, invisible characters dropped, every run of
// whitespace collapsed to one space) and the passage must then be a plain
// substring of the snapshot text. Nothing else is folded: letter case,
// punctuation and quote marks must be exactly as published. A passage that
// matches only after its quote marks or dashes are folded is reported as NOT
// FOUND, with a hint saying so; it is never accepted.
//
// Pure functions plus one async runner whose I/O is injected, so the unit
// tests need neither network nor emulator. Output carries ids, hashes, page
// numbers and the passage being looked for; never the document's text.

/** One passage and the registry entries whose snapshot must contain it. */
export interface GuidanceQuoteCheck {
  // Stable key of the check: lowercase letters, digits and hyphens.
  id: string;
  // Where the passage sits in the document, as its reader saw it (a
  // paragraph or section reference). Shown in the report; never matched.
  label: string;
  // The passage, copied character for character from the published source.
  passage: string;
  // Ids of the registry entries whose LATEST snapshot must contain it. Two
  // ids = two renditions of the same document that must agree.
  sourceIds: string[];
}

/** Why a passage could not be confirmed in a source's snapshot. */
export type GuidanceQuoteProblem =
  | "no_snapshot" // the source has never been fetched successfully
  | "snapshot_unreadable" // the stored object is missing or fails its integrity check
  | "not_found"; // the snapshot was read and the passage is not in it

/** One (check, source) pair's result. */
export interface GuidanceQuoteResult {
  checkId: string;
  label: string;
  sourceId: string;
  // The snapshot that was searched (null when there is none).
  contentHash: string | null;
  found: boolean;
  // For a PDF snapshot: the 1-based page the passage starts and ends on.
  page?: number;
  endPage?: number;
  problem?: GuidanceQuoteProblem;
  // Extra detail for a failure (a read error, or a punctuation hint).
  detail?: string;
}

/** Where a passage was found in one snapshot. */
export interface PassageLocation {
  found: boolean;
  page?: number;
  endPage?: number;
}

/**
 * Fold the typographic variants a copyist most often gets wrong (curly vs
 * straight quote marks, en/em dash vs hyphen). Used ONLY to explain a miss
 * ("the passage is there, but punctuated differently"); never to pass a check.
 */
export function foldTypography(text: string): string {
  return text
    .replace(/[‘’‚‛′]/g, "'")
    .replace(/[“”„‟″]/g, '"')
    .replace(/[‐-―−]/g, "-");
}

/**
 * Is the passage in this snapshot, verbatim after whitespace normalisation?
 * For a PDF snapshot the page numbers are reported too. Pure.
 */
export function findPassage(content: Pick<GuidanceSnapshotContent, "text" | "pages">, passage: string): PassageLocation {
  const needle = normalizeForQuoteMatch(passage);
  if (!needle) return { found: false };
  if (!normalizeForQuoteMatch(content.text).includes(needle)) return { found: false };
  // Per-page text (PDF): say which page, so a citation can carry it. A
  // passage can be in the joined text yet span a page break; then the page
  // lookup still answers (start and end page differ).
  if (content.pages && content.pages.length > 0) {
    const at = findPdfQuote({ pages: content.pages.map((p) => p.text) }, passage);
    if (at) return { found: true, page: at.page, endPage: at.endPage };
  }
  return { found: true };
}

/**
 * Everything wrong with a list of checks (empty = valid). `knownSourceIds`
 * are the ids in the seed: a check that names an entry which does not exist
 * would otherwise pass by checking nothing.
 */
export function validateQuoteChecks(checks: readonly GuidanceQuoteCheck[], knownSourceIds: Iterable<string>): string[] {
  const known = new Set(knownSourceIds);
  const problems: string[] = [];
  const ids = new Set<string>();
  checks.forEach((check, i) => {
    const label = typeof check?.id === "string" && check.id ? check.id : `check ${i}`;
    if (typeof check?.id !== "string" || !GUIDANCE_SOURCE_ID_RE.test(check.id)) {
      problems.push(`${label}: id must be lowercase letters, digits and hyphens`);
    }
    if (ids.has(check.id)) problems.push(`${label}: duplicate id`);
    ids.add(check.id);
    if (typeof check.label !== "string" || !check.label.trim()) problems.push(`${label}: label is required`);
    if (typeof check.passage !== "string" || !normalizeForQuoteMatch(check.passage)) {
      problems.push(`${label}: passage is required`);
    }
    if (!Array.isArray(check.sourceIds) || check.sourceIds.length === 0) {
      problems.push(`${label}: sourceIds must name at least one registry entry`);
      return;
    }
    if (new Set(check.sourceIds).size !== check.sourceIds.length) problems.push(`${label}: sourceIds repeats an entry`);
    for (const sourceId of check.sourceIds) {
      if (!known.has(sourceId)) problems.push(`${label}: source ${JSON.stringify(sourceId)} is not in the seed`);
    }
  });
  return problems;
}

/** The I/O the runner needs; production wires Firestore and the snapshot store. */
export interface GuidanceQuoteCheckDeps {
  // Content hash of a source's newest snapshot, or null when it has none.
  latestSnapshotId(sourceId: string): Promise<string | null>;
  // The stored snapshot (integrity-checked by the store).
  readSnapshot(sourceId: string, contentHash: string): Promise<GuidanceSnapshotContent>;
}

/**
 * Run every check against the latest stored snapshot of each source it
 * names. Never throws for a per-source problem: a missing or unreadable
 * snapshot is a failed result, so one bad source cannot hide the others.
 *
 * @param checks    the passages to confirm
 * @param deps      where snapshots come from
 * @param onlySourceIds when given, pairs for other sources are left out
 *   (an operator crawling a subset checks that subset)
 * @returns one result per (check, source) pair, in the checks' order
 */
export async function runQuoteChecks(
  checks: readonly GuidanceQuoteCheck[],
  deps: GuidanceQuoteCheckDeps,
  onlySourceIds?: readonly string[]
): Promise<GuidanceQuoteResult[]> {
  const only = onlySourceIds ? new Set(onlySourceIds) : undefined;
  // Each snapshot is read once, however many passages are looked for in it.
  const cache = new Map<string, Promise<{ hash: string | null; content?: GuidanceSnapshotContent; error?: string }>>();
  const load = (sourceId: string) => {
    let entry = cache.get(sourceId);
    if (!entry) {
      entry = (async () => {
        let hash: string | null = null;
        try {
          hash = await deps.latestSnapshotId(sourceId);
          if (!hash) return { hash: null };
          return { hash, content: await deps.readSnapshot(sourceId, hash) };
        } catch (err) {
          return { hash, error: err instanceof Error ? err.message : String(err) };
        }
      })();
      cache.set(sourceId, entry);
    }
    return entry;
  };

  const results: GuidanceQuoteResult[] = [];
  for (const check of checks) {
    for (const sourceId of check.sourceIds) {
      if (only && !only.has(sourceId)) continue;
      const base = { checkId: check.id, label: check.label, sourceId };
      const snap = await load(sourceId);
      if (snap.error !== undefined) {
        results.push({ ...base, contentHash: snap.hash, found: false, problem: "snapshot_unreadable", detail: snap.error.slice(0, 300) });
        continue;
      }
      if (!snap.hash || !snap.content) {
        results.push({ ...base, contentHash: null, found: false, problem: "no_snapshot" });
        continue;
      }
      const at = findPassage(snap.content, check.passage);
      if (at.found) {
        results.push({ ...base, contentHash: snap.hash, found: true, ...(at.page ? { page: at.page, endPage: at.endPage } : {}) });
        continue;
      }
      // A miss. Say whether the words are there under different punctuation:
      // that points at the passage (or the rendition), not at a missing rule.
      const folded = normalizeForQuoteMatch(foldTypography(snap.content.text)).includes(
        normalizeForQuoteMatch(foldTypography(check.passage))
      );
      results.push({
        ...base,
        contentHash: snap.hash,
        found: false,
        problem: "not_found",
        ...(folded
          ? { detail: "the words are present, but with different quote marks or dashes: the passage is not verbatim" }
          : {}),
      });
    }
  }
  return results;
}

/** The results that failed. */
export function failedQuoteResults(results: readonly GuidanceQuoteResult[]): GuidanceQuoteResult[] {
  return results.filter((r) => !r.found);
}
