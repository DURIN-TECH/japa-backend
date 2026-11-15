// ============================================
// FIXTURE SCRIPT — the EU Visa Code text the shared route's quotes are checked against (issue #339)
// ============================================
//
// WHY THIS EXISTS
// The `processing` and `validity` blocks of the shared short-stay route
// (src/data/shared-visa-data.ts) carry sentences quoted from the Visa Code.
// A quote is a legal fact: it is never retyped or written from memory. This
// script fetches the official consolidated text and saves it as plain text,
// so a unit test (test/data/shared-route-facts-quotes.test.ts) can check that
// every quote appears in it CHARACTER FOR CHARACTER.
//
// HOW TO RUN (from functions/; it only reads a public page, it writes one local file):
//   npx tsx test/data/fixtures/fetch-visa-code-text.ts
// It writes test/data/fixtures/visa-code-02009R0810-20240628.txt next to itself.
//
// WHAT IT DOES TO THE PAGE (and nothing else)
//   - Every block element (<p>, <div>, <td>, <li>, <h1..6>, <tr>, <br>) ends
//     its own line, so one paragraph of the regulation is one line.
//   - Tags are removed and HTML entities decoded (the text a browser shows).
//   - Runs of HTML whitespace (space, tab, CR, LF) become one space, as a
//     browser renders them; empty lines are dropped.
// No other character is changed: no quote marks, dashes or non-breaking
// spaces are normalised, and the amendment markers (for example "▼M5") stay
// exactly where the publisher puts them.
//
// Not run by `npm test` (it needs the network); its OUTPUT is committed.

import fs from "node:fs";
import path from "node:path";

/** The consolidated Visa Code (Regulation (EC) No 810/2009, text of 28 June 2024). */
export const VISA_CODE_URL = "https://publications.europa.eu/resource/celex/02009R0810-20240628";

/** Where the plain text is saved (committed with the tests). */
export const VISA_CODE_FIXTURE = path.join(__dirname, "visa-code-02009R0810-20240628.txt");

/** Named HTML entities the page may use (anything else numeric is decoded below). */
const NAMED_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " " };

/** Decode `&name;`, `&#NNN;` and `&#xHH;` entities. Unknown named entities are left as written. */
function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith("#x")) return String.fromCodePoint(parseInt(body.slice(2), 16));
    if (body.startsWith("#")) return String.fromCodePoint(parseInt(body.slice(1), 10));
    return NAMED_ENTITIES[body] ?? whole;
  });
}

/**
 * The page's text, one block element per line (pure, so it could be tested).
 * See the header for exactly what is and is not changed.
 */
export function htmlToText(html: string): string {
  // Only the body is text; the head holds the title and the stylesheet link.
  const body = html.replace(/^[\s\S]*?<body[^>]*>/i, "").replace(/<\/body>[\s\S]*$/i, "");
  const withBreaks = body
    // Scripts and styles are not text.
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    // HTML whitespace (space, tab, CR, LF) collapses to one space FIRST, so a
    // line break inside the page's source never splits a paragraph. Decoded
    // entities such as a non-breaking space are not HTML whitespace (decoding
    // happens last) and are kept.
    .replace(/[ \t\r\n]+/g, " ")
    // A block element ends a line.
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|td|th|tr|li|h[1-6]|table)>/gi, "\n");
  const noTags = withBreaks.replace(/<[^>]+>/g, "");
  return (
    noTags
      .split("\n")
      // Trim the space a tag boundary leaves, then decode entities.
      .map((line) => decodeEntities(line.trim()))
      .filter((line) => line.length > 0)
      .join("\n") + "\n"
  );
}

/** Fetch the page the way the issue says (XHTML, English) and save its text. */
async function main(): Promise<void> {
  const res = await fetch(VISA_CODE_URL, { headers: { Accept: "application/xhtml+xml", "Accept-Language": "eng" } });
  if (!res.ok) throw new Error(`GET ${VISA_CODE_URL} answered ${res.status}`);
  const text = htmlToText(await res.text());
  fs.writeFileSync(VISA_CODE_FIXTURE, text, "utf8");
  console.log(`Saved ${text.length} characters to ${VISA_CODE_FIXTURE}`);
}

// Run only when executed directly (the test imports the constants, not the fetch).
if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
