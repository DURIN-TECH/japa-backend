// ============================================
// Fixture builder: lines of the stored Visa Code snapshot (issue #335)
// ============================================
//
// The list-reader tests must run on the REAL stored text of the official page,
// and legal text is never typed or retyped by hand. This script COPIES lines
// out of the stored guidance snapshot of Regulation (EC) No 810/2009 (Visa
// Code), consolidated text of 28 June 2024, into small JSON fixtures:
//
//   visa-code-article-25.json   Article 25 (paragraph 1: cases (a)(i)-(iii), "or", (b))
//   visa-code-article-32.json   Article 32 (paragraph 1: (a)(i)...(iia)...(vii), "or", (b))
//
// (`visa-code-article-5-1.json` was copied the same way in the first round.)
//
// Each fixture line is one line of the snapshot's `text`, unchanged (no-break
// spaces kept), from the article's heading line to the line before the next
// heading. Nothing is edited, trimmed or reordered.
//
// INPUT: the snapshot JSON as stored in the dev bucket,
//   guidance-snapshots/<sourceId>/<contentHash>.json
// fetched READ-ONLY (see the engineer's diagnosis comment on the issue). The
// script checks the file's sha256 against its `contentHash` and against the
// hash pinned below, so a different or altered snapshot cannot build fixtures.
//
// Run (from functions/):
//   node test/scrapers/rubric/fixtures/build-visa-code-fixtures.mjs <snapshot.json>
//
// It reads one local file and writes the two fixture files next to itself.
// No network, no project, no model.

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The stored snapshot these fixtures come from (the one version 1 of the Schengen rulebook cites). */
const SOURCE_ID = "schengen-area-visa-code-regulation-ec-no-810-2009-consolidated-text-of-28-june-2024";
const CONTENT_HASH = "81bb40570a4e9eaf56f62b2bd1a8a7f7e728270fe0a52c107b79dbac54b5d1c3";
const CELEX_URL = "https://publications.europa.eu/resource/celex/02009R0810-20240628";

/** The articles to copy: the heading line that opens each, and the heading line that follows it. */
const ARTICLES = [
  { file: "visa-code-article-25.json", article: "Article 25(1)", from: "Article 25", until: "Article 25a" },
  { file: "visa-code-article-32.json", article: "Article 32(1)", from: "Article 32", until: "CHAPTER V" },
];

const path = process.argv[2];
if (!path) {
  console.error("usage: node build-visa-code-fixtures.mjs <stored-snapshot.json>");
  process.exit(2);
}
const snapshot = JSON.parse(readFileSync(path, "utf8"));
const hash = createHash("sha256").update(snapshot.text).digest("hex");
if (hash !== snapshot.contentHash || hash !== CONTENT_HASH || snapshot.sourceId !== SOURCE_ID) {
  console.error("refused: this is not the stored snapshot the fixtures are pinned to (sourceId or sha256 differs).");
  process.exit(1);
}

// The snapshot's own lines, in order. Empty lines carry nothing and are dropped
// (the quote index drops them too); every kept line is byte-for-byte the snapshot's.
const lines = snapshot.text.split("\n").filter((l) => l.trim() !== "");
/** A line as compared with a heading: runs of whitespace (no-break spaces too) as one space. Used to FIND lines only; the copied lines are never changed. */
const flat = (l) => l.replace(/\s+/gu, " ").trim();
const here = dirname(fileURLToPath(import.meta.url));
for (const a of ARTICLES) {
  // The FIRST heading line with this exact text is the article in the regulation's body
  // (later ones are in the correlation tables of the annexes).
  const start = lines.findIndex((l) => flat(l) === a.from);
  const end = lines.findIndex((l, i) => i > start && flat(l) === a.until);
  if (start < 0 || end < 0) {
    console.error(`refused: ${a.article} was not found between its heading lines.`);
    process.exit(1);
  }
  const fixture = {
    _comment: `Issue #335. Verbatim lines copied BY CODE (build-visa-code-fixtures.mjs) from the stored snapshot of Regulation (EC) No 810/2009 (Visa Code), consolidated text of 28 June 2024, ${a.article} and the rest of its article, as stored on durin-seli-dev (sourceId and contentHash below). Each line is one line of the snapshot's text, unchanged (no-break spaces kept). Do not edit by hand.`,
    sourceId: snapshot.sourceId,
    contentHash: snapshot.contentHash,
    url: snapshot.finalUrl ?? snapshot.url,
    celexUrl: CELEX_URL,
    fetchedAt: snapshot.fetchedAt,
    lines: lines.slice(start, end),
  };
  writeFileSync(join(here, a.file), `${JSON.stringify(fixture, null, 2)}\n`);
  console.log(`${a.file}: ${fixture.lines.length} lines copied (${a.article}).`);
}
