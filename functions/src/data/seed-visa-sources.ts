import { getFirestore, Timestamp } from "firebase-admin/firestore";
import * as fs from "fs";
import * as path from "path";
import { VisaSourcePage, VisaSourceValidation } from "../types/visa-catalog";

// Firestore handle — mirrors the other data seeders. Requires Firebase Admin to
// already be initialized, so this module must only be imported AFTER init (the
// consolidated seed entry point, scripts/seed-all.ts, guarantees that).
const db = getFirestore();

// Verified-links markdown filename. The file lives at the japa repo root, which
// is FOUR levels up from this module (compiled `lib/data/…` → lib → functions →
// japa-backend → repo root; ts-node `src/data/…` has the same depth). We also
// probe japa-backend/ as a fallback in case the file is ever colocated there, so
// a wrong path can't silently skip the seed the way `../../../` did before.
const MARKDOWN_FILENAME = "official_visa_links_verified_v3.md";
const MARKDOWN_CANDIDATES = [
  path.resolve(__dirname, "../../../../", MARKDOWN_FILENAME), // repo root
  path.resolve(__dirname, "../../../", MARKDOWN_FILENAME), // japa-backend/
];
// Pick the first candidate that exists; fall back to the repo-root path so the
// "not found" warning below reports a sensible location.
const DEFAULT_MARKDOWN_PATH =
  MARKDOWN_CANDIDATES.find((p) => fs.existsSync(p)) || MARKDOWN_CANDIDATES[0];

// Weekly sweep by default (locked decision) — see the spike doc.
const CRAWL_INTERVAL_HOURS = 168;

// Country-name → ISO 3166-1 alpha-2, for the 26 countries in the v3 file. The
// section headers are matched case-insensitively after trimming.
const COUNTRY_CODES: Record<string, string> = {
  canada: "CA",
  "new zealand": "NZ",
  "united kingdom": "GB",
  germany: "DE",
  netherlands: "NL",
  ireland: "IE",
  singapore: "SG",
  france: "FR",
  japan: "JP",
  "united states": "US",
  sweden: "SE",
  norway: "NO",
  finland: "FI",
  denmark: "DK",
  austria: "AT",
  belgium: "BE",
  czechia: "CZ",
  estonia: "EE",
  malta: "MT",
  "hong kong": "HK",
  taiwan: "TW",
  malaysia: "MY",
  "south korea": "KR",
  "united arab emirates": "AE",
  qatar: "QA",
  "saudi arabia": "SA",
};

// Map the markdown's validation label to our enum.
function toValidation(label: string): VisaSourceValidation {
  const l = label.toUpperCase();
  if (l.includes("TEXT-VERIFIED")) return "text_verified";
  if (l.includes("OFFICIAL TYPE-PAGE")) return "official_type_page";
  if (l.includes("PATHWAY-VERIFIED")) return "pathway_verified";
  return "unverified";
}

interface ParsedCountry {
  countryCode: string;
  countryName: string;
  pages: VisaSourcePage[];
}

/**
 * Parse the verified-links markdown into per-country page lists.
 *
 * The file is a sequence of `## N. Country` sections, each containing a table:
 *   | Visa / route | Official link | Validation | Useful information confirmed |
 * We take every row that carries an http(s) link; non-table prose ("Excluded
 * for now:", "Note:") is ignored because it doesn't start with a pipe.
 */
export function parseVisaSourcesMarkdown(markdown: string): ParsedCountry[] {
  const lines = markdown.split(/\r?\n/);
  const out: ParsedCountry[] = [];
  let current: ParsedCountry | null = null;

  // Matches "## 3. United Kingdom" → captures "United Kingdom".
  const countryHeader = /^##\s+\d+\.\s+(.+?)\s*$/;

  for (const line of lines) {
    const header = line.match(countryHeader);
    if (header) {
      const name = header[1].trim();
      const code = COUNTRY_CODES[name.toLowerCase()];
      // Only track sections we can map to an ISO code (skips intro/notes headers).
      current = code ? { countryCode: code, countryName: name, pages: [] } : null;
      if (current) out.push(current);
      continue;
    }

    if (!current) continue;
    // Table rows start with a pipe and (for data rows) contain a link.
    if (!line.trimStart().startsWith("|")) continue;

    const cells = line.split("|").map((c) => c.trim());
    // A pipe row splits to ["", route, link, validation, notes, ""]; drop the
    // empty edges.
    const inner = cells.slice(1, -1);
    if (inner.length < 2) continue;

    const urlMatch = inner[1]?.match(/https?:\/\/[^\s)|]+/);
    if (!urlMatch) continue; // header / separator / non-data row

    current.pages.push({
      url: urlMatch[0],
      routeName: inner[0] || "Unknown route",
      validation: toValidation(inner[2] || ""),
      notes: inner[3] || undefined,
    });
  }

  return out;
}

/**
 * Seed the `visaSources/{countryCode}` registry from the verified-links
 * markdown. Idempotent (deterministic doc IDs); returns the number of country
 * sources written. Re-running resets scheduling/health to defaults, so run it
 * to refresh the registry when the markdown changes.
 */
export async function seedVisaSources(markdownPath?: string): Promise<number> {
  const file = markdownPath || DEFAULT_MARKDOWN_PATH;
  if (!fs.existsSync(file)) {
    console.warn(`[seed-visa-sources] markdown not found at ${file} — skipping.`);
    return 0;
  }

  const countries = parseVisaSourcesMarkdown(fs.readFileSync(file, "utf8"));
  const collection = db.collection("visaSources");
  const batch = db.batch();
  const now = Timestamp.now();

  for (const c of countries) {
    if (c.pages.length === 0) continue;
    const ref = collection.doc(c.countryCode); // ISO code = deterministic id
    batch.set(ref, {
      id: c.countryCode,
      countryCode: c.countryCode,
      countryName: c.countryName,
      // The v3 list only admits official/government sources by its inclusion rule.
      isOfficial: true,
      pages: c.pages,
      crawlIntervalHours: CRAWL_INTERVAL_HOURS,
      // Due immediately so the first crawl picks it up.
      nextCrawlAt: now,
      status: "active",
      reliabilityScore: 100,
      consecutiveFailures: 0,
      createdAt: now,
      updatedAt: now,
    });
  }

  await batch.commit();
  const pageCount = countries.reduce((n, c) => n + c.pages.length, 0);
  console.log(
    `[seed-visa-sources] wrote ${countries.length} country sources (${pageCount} pages).`
  );
  return countries.length;
}
