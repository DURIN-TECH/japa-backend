import { getFirestore, Timestamp } from "firebase-admin/firestore";
import * as fs from "fs";
import * as path from "path";
import { VisaSourcePage, VisaSourceValidation } from "../types/visa-catalog";
import {
  VisaSourcePin,
  applyVisaSourcePins,
  mergePageCrawlState,
  pickSourceCrawlState,
} from "../services/visa-catalog-ids";

// NOTE: the Firestore handle is resolved LAZILY inside seedVisaSources() (not at
// module load), so this module can be imported without Firebase Admin init —
// the unit tests import VISA_SOURCE_OVERRIDES and parseVisaSourcesMarkdown
// directly. seedVisaSources() itself still requires Admin to be initialized
// first (scripts/seed-all.ts guarantees that).

// Verified-links markdown filename. It lives at the meta-repo root (the folder
// that contains seli-backend/). Rather than hard-coding a depth — which breaks
// in a git worktree under `.worktrees/`, one level deeper — we walk up from
// this module's directory and take the first ancestor that has the file.
// (Compiled `lib/data/…` and ts-node/tsx `src/data/…` both work this way.)
export const MARKDOWN_FILENAME = "official_visa_links_verified_v3.md";

/** How many parent directories to probe for the markdown before giving up. */
const MARKDOWN_SEARCH_DEPTH = 8;

/**
 * Locate the verified-links markdown by walking up from `startDir`. Returns
 * the first existing `<ancestor>/official_visa_links_verified_v3.md`, or
 * `undefined` if none is found within MARKDOWN_SEARCH_DEPTH levels.
 */
export function findVisaSourcesMarkdown(startDir: string = __dirname): string | undefined {
  let dir = path.resolve(startDir);
  for (let i = 0; i < MARKDOWN_SEARCH_DEPTH; i++) {
    const candidate = path.join(dir, MARKDOWN_FILENAME);
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break; // reached filesystem root
    dir = parent;
  }
  return undefined;
}

// ============================================
// PINNED RECORD IDENTITY (the ONE override map)
// ============================================
//
// Registry page URL (exactly as written in official_visa_links_verified_v3.md)
// -> the visa doc id (and optionally code) that visas scraped from that page
// are written to, under countries/{cc}/visaTypes/{visaId}. The registry owns
// record identity: the crawl uses these verbatim instead of deriving an id, so
// a GOV.UK URL rename later only needs this map's KEY updated, not the id.
//
// GB ids live in their own `gb-*` namespace and are equal to today's
// path-derived id (`gb-${slug(path)}`). They deliberately do NOT reuse the
// temporary seeded `uk-*` docs (seed-countries-visas.ts): scraped and seeded
// records are compared side by side, then the seeds are removed (issue #65).
// A unit test asserts these ids are disjoint from every seeded id.
//
// `visaCode` is pinned ONLY for the four routes with a seeded equivalent, with
// the seeded code copied from seed-countries-visas.ts, so the two line up in
// the comparison. Other routes keep the extracted code.
//
// Applied by seedVisaSources(); parseVisaSourcesMarkdown() stays a pure parser.
// A key that matches no parsed page is logged as a warning at seed time.
export const VISA_SOURCE_OVERRIDES: Record<string, VisaSourcePin> = {
  // ---- United Kingdom (GB) — routes with a seeded uk-* equivalent ----
  "https://www.gov.uk/standard-visitor": { visaId: "gb-standard-visitor", visaCode: "SVV" }, // ~ uk-visitor
  "https://www.gov.uk/skilled-worker-visa": { visaId: "gb-skilled-worker-visa", visaCode: "SWV" }, // ~ uk-skilled-worker
  "https://www.gov.uk/student-visa": { visaId: "gb-student-visa", visaCode: "TIER4" }, // ~ uk-student
  "https://www.gov.uk/uk-family-visa": { visaId: "gb-uk-family-visa", visaCode: "FAM" }, // ~ uk-family
  // ---- United Kingdom (GB) — routes with no seeded equivalent (no visaCode) ----
  "https://www.gov.uk/health-care-worker-visa": { visaId: "gb-health-care-worker-visa" },
  "https://www.gov.uk/child-study-visa": { visaId: "gb-child-study-visa" },
  "https://www.gov.uk/graduate-visa": { visaId: "gb-graduate-visa" },
  "https://www.gov.uk/global-talent": { visaId: "gb-global-talent" },
  "https://www.gov.uk/high-potential-individual-visa": { visaId: "gb-high-potential-individual-visa" },
  "https://www.gov.uk/youth-mobility": { visaId: "gb-youth-mobility" },
  "https://www.gov.uk/india-young-professionals-scheme-visa": {
    visaId: "gb-india-young-professionals-scheme-visa",
  },
  "https://www.gov.uk/british-national-overseas-bno-visa": {
    visaId: "gb-british-national-overseas-bno-visa",
  },
};

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

// One country section of the markdown, as parsed (no pins / crawl state yet).
export interface ParsedCountry {
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
 * markdown plus VISA_SOURCE_OVERRIDES. Idempotent (deterministic doc ids);
 * returns the number of country sources written.
 *
 * Re-seeding PRESERVES crawl state, so it is safe to run after deploys:
 *  - `pages` is rebuilt from the markdown + pins (pages removed from the
 *    markdown disappear; new pages start with no crawl state; existing pages
 *    gain/refresh `visaId`/`visaCode` — this is how deployed registries pick up
 *    the pins), then each page's crawler fields (lastContentHash, lastCrawledAt,
 *    lastExtractedAt, lastError) are copied from the stored page with the same
 *    URL, so the hash gate still holds on the next crawl.
 *  - Source-level createdAt, nextCrawlAt, lastCrawledAt, status,
 *    reliabilityScore and consecutiveFailures are kept from the existing doc;
 *    only `updatedAt` is refreshed. A brand-new country gets the defaults.
 */
export async function seedVisaSources(markdownPath?: string): Promise<number> {
  const file = markdownPath || findVisaSourcesMarkdown();
  if (!file || !fs.existsSync(file)) {
    console.warn(
      `[seed-visa-sources] ${MARKDOWN_FILENAME} not found ` +
        `(${file || `searched up from ${__dirname}`}) — skipping.`
    );
    return 0;
  }

  // Resolved here (not at module load) — see the note at the top of the file.
  const db = getFirestore();
  const countries = parseVisaSourcesMarkdown(fs.readFileSync(file, "utf8"));
  const collection = db.collection("visaSources");
  const now = Timestamp.now();

  // Only countries with at least one page become registry docs.
  const seedable = countries.filter((c) => c.pages.length > 0);

  // Read every existing registry doc up front (one round trip) so crawl state
  // can be carried over. getAll() on zero refs would throw, hence the guard.
  const refs = seedable.map((c) => collection.doc(c.countryCode)); // ISO code = deterministic id
  const snaps = refs.length ? await db.getAll(...refs) : [];

  const batch = db.batch();
  // Override URLs that matched a parsed page, across all countries.
  const matchedOverrideUrls = new Set<string>();

  seedable.forEach((c, idx) => {
    const ref = refs[idx];
    const existing = snaps[idx]?.exists
      ? (snaps[idx].data() as Record<string, unknown>)
      : undefined;

    // 1. Seed-owned page fields: markdown rows + pinned identity.
    const pinned = applyVisaSourcePins(c.pages, VISA_SOURCE_OVERRIDES);
    pinned.matchedUrls.forEach((u) => matchedOverrideUrls.add(u));

    // 2. Crawler-owned page fields: carried over by URL from the stored doc.
    const pages = mergePageCrawlState(
      pinned.pages,
      existing?.pages as VisaSourcePage[] | undefined
    );

    // 3. Defaults for a new country, overlaid with any stored crawl/health
    //    state (pickSourceCrawlState returns {} for a new country).
    batch.set(ref, {
      id: c.countryCode,
      countryCode: c.countryCode,
      countryName: c.countryName,
      // The v3 list only admits official/government sources by its inclusion rule.
      isOfficial: true,
      pages,
      crawlIntervalHours: CRAWL_INTERVAL_HOURS,
      // Due immediately so the first crawl picks a new country up.
      nextCrawlAt: now,
      status: "active",
      reliabilityScore: 100,
      consecutiveFailures: 0,
      createdAt: now,
      ...pickSourceCrawlState(existing),
      updatedAt: now,
    });
  });

  // Guard: an override whose URL no longer appears in the markdown (e.g. the
  // URL was edited there) would silently drop its pin — say so loudly.
  for (const url of Object.keys(VISA_SOURCE_OVERRIDES)) {
    if (!matchedOverrideUrls.has(url)) {
      console.warn(
        `[seed-visa-sources] WARNING: override URL matches no page in ${MARKDOWN_FILENAME}: ${url} ` +
          `(pinned id ${VISA_SOURCE_OVERRIDES[url].visaId} not applied)`
      );
    }
  }

  await batch.commit();
  const pageCount = seedable.reduce((n, c) => n + c.pages.length, 0);
  console.log(
    `[seed-visa-sources] wrote ${seedable.length} country sources (${pageCount} pages, ` +
      `${matchedOverrideUrls.size} pinned).`
  );
  return seedable.length;
}
