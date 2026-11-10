import { getFirestore, Timestamp } from "firebase-admin/firestore";
import * as fs from "fs";
import * as path from "path";
import {
  CrawlWindow,
  SourceAdapterId,
  VisaSourcePage,
  VisaSourceValidation,
} from "../types/visa-catalog";
// Pure window helpers (no Firebase): validate each seeded window and compute
// a brand-new country's first `nextCrawlAt` (its next window opening).
import { assertValidCrawlWindow, nextWindowOpening } from "../services/visa-crawl-window";
import {
  VisaSourcePin,
  applyVisaSourcePins,
  mergePageCrawlState,
  pickSourceCrawlState,
} from "../services/visa-catalog-ids";
// Registry official hosts (issue #74) — lives in a pure services module so the
// adapters + validator can read it without importing this seed file.
import { VISA_SOURCE_OFFICIAL_HOSTS } from "../services/visa-catalog-official-hosts";
export { VISA_SOURCE_OFFICIAL_HOSTS };

// NOTE: the Firestore handle is resolved LAZILY inside seedVisaSources() (not at
// module load), so this module can be imported without Firebase Admin init —
// the unit tests import VISA_SOURCE_OVERRIDES and parseVisaSourcesMarkdown
// directly. seedVisaSources() itself still requires Admin to be initialized
// first (scripts/seed-all.ts guarantees that).

// ============================================
// WHERE THE VERIFIED-LINKS MARKDOWN COMES FROM (issue #78)
// ============================================
//
// The SOURCE OF TRUTH is `official_visa_links_verified_v3.md` at the meta-repo
// root (the folder that contains seli-backend/). But CI (deploy-dev.yml ->
// `npm run seed:dev`) checks out seli-backend ALONE, so the meta-repo copy is
// never there: before #78 the seed logged "not found ... skipping", wrote 0
// sources, and dev's scraper had nothing to crawl.
//
// Fix: a VENDORED copy is committed next to this module at
// `functions/src/data/official_visa_links_verified_v3.md`, and the seed reads
// ONLY that copy. Keeping it in step with the meta-repo:
//   - `npm run sync:visa-sources` copies the meta-repo file over the vendored
//     one (scripts/sync-visa-sources.ts), when the meta-repo is present;
//   - a unit test (test/visa-sources-vendored.test.ts) asserts the two are
//     byte-identical whenever the meta-repo copy can be found, and skips in a
//     standalone checkout (CI), where only the vendored copy exists.
export const MARKDOWN_FILENAME = "official_visa_links_verified_v3.md";

/**
 * Env var that points the sync script / drift test at a specific meta-repo
 * copy instead of walking up. Useful when the nearest meta-repo checkout is on
 * a different branch than the one being vendored (e.g. a stacked worktree).
 */
export const META_MARKDOWN_ENV = "SELI_META_VISA_SOURCES_MD";

/**
 * Locate the VENDORED markdown for a module living in `startDir`.
 *
 * tsc does not copy `.md` files into lib/, so two layouts are probed:
 *   1. `<startDir>/<file>`             — tsx / ts-node running src/data/…
 *                                        (and tests passing src/data);
 *   2. `<startDir>/../../src/data/<file>` — compiled lib/data/… (seed:dev in
 *                                        CI), reading the committed src copy.
 * No walking up: the seed must never silently pick a different (e.g. stale
 * meta-repo) file than the one committed with this code.
 */
export function findVisaSourcesMarkdown(startDir: string = __dirname): string | undefined {
  const dir = path.resolve(startDir);
  const candidates = [
    path.join(dir, MARKDOWN_FILENAME),
    path.resolve(dir, "../../src/data", MARKDOWN_FILENAME),
  ];
  return candidates.find((c) => fs.existsSync(c));
}

/**
 * Where the vendored copy is COMMITTED: `functions/src/data/<file>`. Resolves
 * the same from src/data (`../../src/data` = itself) and lib/data. The sync
 * script writes here (never into lib/, which is build output).
 */
export function vendoredVisaSourcesMarkdownPath(startDir: string = __dirname): string {
  return path.resolve(startDir, "../../src/data", MARKDOWN_FILENAME);
}

/** How many parent directories to probe for the meta-repo copy. */
const META_SEARCH_DEPTH = 6;

/**
 * Locate the META-REPO copy (the source of truth), or `undefined` when this
 * seli-backend checkout is standalone (CI). `$SELI_META_VISA_SOURCES_MD` wins
 * when set. Otherwise walks up starting ABOVE the seli-backend repo root
 * (`<functions>/../..`), so the vendored copy inside functions/ can never be
 * mistaken for the meta-repo one. Works from src/data and lib/data alike, and
 * from a git worktree under `.worktrees/` (one level deeper than the main
 * checkout).
 */
export function findMetaRepoVisaSourcesMarkdown(startDir: string = __dirname): string | undefined {
  const fromEnv = process.env[META_MARKDOWN_ENV];
  if (fromEnv) return fs.existsSync(fromEnv) ? path.resolve(fromEnv) : undefined;

  // startDir is functions/{src,lib}/data -> functions -> seli-backend -> parent.
  let dir = path.resolve(startDir, "../../../..");
  for (let i = 0; i < META_SEARCH_DEPTH; i++) {
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
/**
 * The KR registry page URL pinned in VISA_SOURCE_OVERRIDES below (issue #67), exported so the unit
 * tests reference the same string as the map key instead of retyping it.
 * Must equal the KR row in official_visa_links_verified_v3.md character for
 * character (see the KR comment in the map for why this page was chosen).
 */
export const KR_TEMPORARY_VISIT_URL =
  "https://www.hikorea.go.kr/info/InfoDatail.pt?CAT_SEQ=522&PARENT_ID=1267&locale=en";

export const VISA_SOURCE_OVERRIDES: Record<string, VisaSourcePin> = {
  // ---- United Kingdom (GB) — routes with a seeded uk-* equivalent ----
  "https://www.gov.uk/standard-visitor": { visaId: "gb-standard-visitor", visaCode: "SVV" }, // ~ uk-visitor
  "https://www.gov.uk/skilled-worker-visa": { visaId: "gb-skilled-worker-visa", visaCode: "SWV" }, // ~ uk-skilled-worker
  "https://www.gov.uk/student-visa": { visaId: "gb-student-visa", visaCode: "TIER4" }, // ~ uk-student
  // Family is ONE guide covering partner/child/parent/… routes, with slugs the
  // default section patterns don't know (partner-spouse, proof-income-partner,
  // provide-information). v1 keeps it as one record (matching the seed), so it
  // gets an explicit include list: the partner route (the main one, where the
  // fees and requirements live) plus the shared English / documents parts.
  // Parent/child/adult-dependent/private-life parts are left out (§3.1: a
  // later decision may split them into their own records).
  "https://www.gov.uk/uk-family-visa": {
    visaId: "gb-uk-family-visa",
    visaCode: "FAM", // ~ uk-family
    includeSections: [
      "overview",
      "partner-spouse",
      "proof-income-partner",
      "knowledge-of-english",
      "provide-information",
    ],
  },
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

  // ---- South Korea (KR) — issue #67 ----
  //
  // WHY A PIN IS NEEDED HERE. The old KR row was the Korea Visa Portal home
  // page (`https://www.visa.go.kr/?LANG_TYPE=EN`): its path is "/", so
  // deriveVisaId() refused to invent an id and every crawl logged a page
  // error (the source would flip to `broken` after 5 weekly runs).
  //
  // WHY THIS URL. visa.go.kr is no use for a route page: its per-visa detail
  // screens are reached by a JS form POST (`/openPage.do?MENU_ID=1010201`
  // with IN_SOJ_QUAL_GRP in the body), so no GET URL addresses one visa.
  // The Ministry of Justice's HiKorea portal serves server-rendered English
  // "Easy Guide to Immigration" pages, one per purpose of stay, over plain
  // GET (`locale=en` selects English). This one is the short-term visit
  // route; checked 2026-11-10 with the crawl's own fetchAndClean (robots.txt
  // only restricts Googlebot; 200; ~870 chars of cleaned text) — it states:
  //   "Temporary visit (C-3) Those seeking short term stay for travel/transit,
  //    medical treatment, visiting relatives, a major sporting event,
  //    attending conferences, various cultural or artistic events, religious
  //    ceremony, or other similar reasons. (The visit must be non-profit in
  //    nature) ... Passport + Visa + Disembarkation card"
  //
  // WHY PINNED EVEN THOUGH THE PATH IS NON-EMPTY. Every HiKorea guide page
  // shares the path `/info/InfoDatail.pt` and differs only in its query
  // (CAT_SEQ / PARENT_ID), which normalizedSourcePath() drops. The derived id
  // would be the generic `kr-info-infodatail-pt`, and a second HiKorea row
  // (Study, Work, ...) would silently land on the same doc. The pin gives
  // this route its own stable id instead.
  //
  // No `visaCode`: there is no seeded KR visa to line up with
  // (seed-countries-visas.ts has no kr-* docs), so the extracted code stays.
  //
  // KEY MUST MATCH THE MARKDOWN ROW EXACTLY (official_visa_links_verified_v3.md,
  // "## 23. South Korea"); otherwise seedVisaSources() warns and the pin is
  // not applied.
  [KR_TEMPORARY_VISIT_URL]: {
    visaId: "kr-temporary-visit-c-3",
  },
};

// ============================================
// SOURCE ADAPTER PER COUNTRY (registry-owned)
// ============================================
//
// ISO code -> the SourceAdapter that fetches that country's pages (see
// services/visa-source-adapters/). Countries not listed get no `adapter` field
// and use the default, "generic-html". Like the pins above, this is applied by
// seedVisaSources() and REFRESHED on every re-seed (it is registry config, not
// crawl state), while crawl state is still preserved.
//
// GB: GOV.UK's JSON Content API — guide parts fetched separately and selected
// (docs/visa-scraper-uk-reference.md §3). NOTE: switching a country's adapter
// changes its content hashes, so every page re-extracts once on the next crawl.
export const VISA_SOURCE_ADAPTERS: Record<string, SourceAdapterId> = {
  GB: "govuk-content-api",
};

// ============================================
// WEEKLY NIGHT CRAWL WINDOW PER COUNTRY (registry-owned, issue #63)
// ============================================
//
// ISO code -> when that country's source may be crawled: one local night a
// week, 02:00-05:00 in its own IANA zone (user decision on issue #63: first
// run at the 02:15 tick, catch-up tries at 03:15 and 04:15). The 26 countries
// are spread over the 7 nights 4/4/4/4/4/3/3 so government sites are hit at
// their quietest and no night is crowded (at most 4 due, well inside 3 ticks
// x maxSources 3). Mixing zones within one night is intended.
//
// Every zone here has a whole-hour UTC offset year-round, which is why the
// hourly :15 UTC tick is also :15 local. CA and US use one representative
// zone (their national sites aren't tied to a single local night).
//
// Like VISA_SOURCE_ADAPTERS, this is applied by seedVisaSources() and
// REFRESHED on every re-seed (it is registry config, NOT crawl state, so it is
// not in SOURCE_CRAWL_STATE_FIELDS). A unit test asserts it covers exactly the
// keys of COUNTRY_CODES with valid windows.

/** Local window hours shared by every seeded source (02:00 inclusive -> 05:00 exclusive). */
const WINDOW_START_HOUR = 2;
const WINDOW_END_HOUR = 5;

/** Build a seeded window for one zone + ISO weekday (1 = Mon .. 7 = Sun). */
function night(timeZone: string, dayOfWeek: number): CrawlWindow {
  return { timeZone, dayOfWeek, startHour: WINDOW_START_HOUR, endHour: WINDOW_END_HOUR };
}

export const VISA_SOURCE_WINDOWS: Record<string, CrawlWindow> = {
  // ---- Monday (1) ----
  GB: night("Europe/London", 1), // UK: Monday 02:15 Europe/London
  DE: night("Europe/Berlin", 1),
  JP: night("Asia/Tokyo", 1),
  QA: night("Asia/Qatar", 1),
  // ---- Tuesday (2) ----
  IE: night("Europe/Dublin", 2),
  FR: night("Europe/Paris", 2),
  KR: night("Asia/Seoul", 2),
  SA: night("Asia/Riyadh", 2),
  // ---- Wednesday (3) ----
  CA: night("America/Toronto", 3),
  NL: night("Europe/Amsterdam", 3),
  HK: night("Asia/Hong_Kong", 3),
  EE: night("Europe/Tallinn", 3),
  // ---- Thursday (4) ----
  AE: night("Asia/Dubai", 4),
  SE: night("Europe/Stockholm", 4),
  TW: night("Asia/Taipei", 4),
  MT: night("Europe/Malta", 4),
  // ---- Friday (5) ----
  US: night("America/New_York", 5),
  NO: night("Europe/Oslo", 5),
  MY: night("Asia/Kuala_Lumpur", 5),
  CZ: night("Europe/Prague", 5),
  // ---- Saturday (6) ----
  NZ: night("Pacific/Auckland", 6),
  FI: night("Europe/Helsinki", 6),
  BE: night("Europe/Brussels", 6),
  // ---- Sunday (7) ----
  SG: night("Asia/Singapore", 7),
  DK: night("Europe/Copenhagen", 7),
  AT: night("Europe/Vienna", 7),
};

// Interval fallback, used ONLY by a source without a crawlWindow (none of the
// seeded ones): weekly sweep (locked decision) — see the spike doc.
const CRAWL_INTERVAL_HOURS = 168;

// Country-name → ISO 3166-1 alpha-2, for the 26 countries in the v3 file. The
// section headers are matched case-insensitively after trimming. Exported so
// the unit test can check VISA_SOURCE_WINDOWS covers exactly these countries.
export const COUNTRY_CODES: Record<string, string> = {
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

/** True when two windows are the same zone, weekday and hours (field-wise,
 *  so key order / extra fields in the stored doc don't matter). */
function sameCrawlWindow(a: CrawlWindow, b: CrawlWindow): boolean {
  return (
    a.timeZone === b.timeZone &&
    a.dayOfWeek === b.dayOfWeek &&
    a.startHour === b.startHour &&
    a.endHour === b.endHour
  );
}

/**
 * Build the `visaSources/{cc}` doc for one parsed country (pure — no I/O).
 *
 * Seed-owned (refreshed every seed): identity, pages from the markdown + pins
 * (incl. section overrides), `adapter` from `adapters` and `crawlWindow` from
 * `windows` (issue #63). Crawler-owned:
 * page crawl state (mergePageCrawlState) and source health/scheduling
 * (pickSourceCrawlState) are carried over from `existing`. Returns the doc plus
 * the override URLs that matched a page (for the stale-override warning).
 * If the stored `crawlWindow` differs from the code's, `nextCrawlAt` is reset
 * to the new window's next opening (see step 5).
 */
export function buildSeededVisaSource(params: {
  country: ParsedCountry;
  existing: Record<string, unknown> | undefined;
  now: Timestamp;
  overrides?: Record<string, VisaSourcePin>;
  adapters?: Record<string, SourceAdapterId>;
  // Registry-owned night windows; defaults to VISA_SOURCE_WINDOWS.
  windows?: Record<string, CrawlWindow>;
  officialHosts?: Record<string, readonly string[]>;
}): { doc: Record<string, unknown>; matchedUrls: Set<string> } {
  const { country: c, existing, now } = params;
  const overrides = params.overrides ?? VISA_SOURCE_OVERRIDES;
  const adapters = params.adapters ?? VISA_SOURCE_ADAPTERS;
  const windows = params.windows ?? VISA_SOURCE_WINDOWS;
  const officialHostMap = params.officialHosts ?? VISA_SOURCE_OFFICIAL_HOSTS;

  // 1. Seed-owned page fields: markdown rows + pinned identity/sections.
  const pinned = applyVisaSourcePins(c.pages, overrides);

  // 2. Crawler-owned page fields: carried over by URL from the stored doc.
  const pages = mergePageCrawlState(pinned.pages, existing?.pages as VisaSourcePage[] | undefined);

  // 3. Registry-owned adapter (absent → field omitted → generic-html default).
  const adapter = adapters[c.countryCode];
  // 3a. Registry-owned official hosts (#74); absent → field omitted.
  const officialHosts = officialHostMap[c.countryCode];

  // 3b. Registry-owned night window (absent → field omitted → legacy
  //     interval scheduling). Validated here so a typo in the map fails the
  //     seed loudly instead of storing a window the orchestrator can't use.
  const crawlWindow = windows[c.countryCode];
  if (crawlWindow) assertValidCrawlWindow(crawlWindow);

  // 4. Defaults for a new country, overlaid with any stored crawl/health
  //    state (pickSourceCrawlState returns {} for a new country).
  const doc: Record<string, unknown> = {
    id: c.countryCode,
    countryCode: c.countryCode,
    countryName: c.countryName,
    // The v3 list only admits official/government sources by its inclusion rule.
    isOfficial: true,
    pages,
    ...(adapter ? { adapter } : {}),
    ...(crawlWindow ? { crawlWindow } : {}),
    ...(officialHosts && officialHosts.length ? { officialHosts: [...officialHosts] } : {}),
    crawlIntervalHours: CRAWL_INTERVAL_HOURS,
    // A brand-new country with a window waits for its night: first
    // nextCrawlAt = its next window opening (operators use the manual
    // `crawl-visa-catalog --country` script for an immediate first crawl).
    // Without a window it is due immediately (legacy). An EXISTING doc keeps
    // its stored nextCrawlAt via pickSourceCrawlState below; an old value in
    // the past just means it runs at its first window, then stays on the
    // weekly grid — no migration needed.
    nextCrawlAt: crawlWindow
      ? Timestamp.fromDate(nextWindowOpening(crawlWindow, now.toMillis()))
      : now,
    status: "active",
    reliabilityScore: 100,
    consecutiveFailures: 0,
    createdAt: now,
    ...pickSourceCrawlState(existing),
    updatedAt: now,
  };

  // 5. Window CHANGED in code since the last seed -> the stored nextCrawlAt
  //    belongs to the old grid (e.g. a source moved from Tue to Fri would
  //    otherwise still run on its old night, or not until a week later).
  //    Reset it to the NEW window's next opening. An unchanged window keeps
  //    the stored nextCrawlAt (crawl state preserved), and so does a doc that
  //    had no stored window yet (first rollout of #63: its past nextCrawlAt
  //    makes it run at its first window — the issue's no-migration rule).
  //    All other crawl state (status, health, lastCrawledAt) is kept either way.
  const storedWindow = existing?.crawlWindow as CrawlWindow | undefined;
  if (crawlWindow && storedWindow && !sameCrawlWindow(storedWindow, crawlWindow)) {
    doc.nextCrawlAt = Timestamp.fromDate(nextWindowOpening(crawlWindow, now.toMillis()));
  }
  return { doc, matchedUrls: pinned.matchedUrls };
}

/** True on a CI runner (GitHub Actions and most CI systems set CI=true). */
function isCi(): boolean {
  const v = (process.env.CI || "").toLowerCase();
  return v === "true" || v === "1";
}

/**
 * Seed the `visaSources/{countryCode}` registry from the verified-links
 * markdown plus VISA_SOURCE_OVERRIDES. Idempotent (deterministic doc ids);
 * returns the number of country sources written.
 *
 * The markdown is the VENDORED copy (findVisaSourcesMarkdown) unless a path is
 * passed. If it is missing, this THROWS when CI=true and warns + returns 0
 * otherwise (issue #78).
 *
 * Re-seeding PRESERVES crawl state, so it is safe to run after deploys:
 *  - `pages` is rebuilt from the markdown + pins (pages removed from the
 *    markdown disappear; new pages start with no crawl state; existing pages
 *    gain/refresh `visaId`/`visaCode`/`includeSections`/`excludeSections` —
 *    this is how deployed registries pick up the pins), the source `adapter`
 *    and `crawlWindow` are refreshed from VISA_SOURCE_ADAPTERS /
 *    VISA_SOURCE_WINDOWS, then each page's crawler fields (lastContentHash, lastCrawledAt,
 *    lastExtractedAt, lastError) are copied from the stored page with the same
 *    URL, so the hash gate still holds on the next crawl.
 *  - Source-level createdAt, nextCrawlAt, lastCrawledAt, status,
 *    reliabilityScore and consecutiveFailures are kept from the existing doc;
 *    only `updatedAt` is refreshed. A brand-new country gets the defaults
 *    (its nextCrawlAt = its next window opening, not now).
 */
export async function seedVisaSources(markdownPath?: string): Promise<number> {
  const file = markdownPath || findVisaSourcesMarkdown();
  if (!file || !fs.existsSync(file)) {
    const msg =
      `[seed-visa-sources] ${MARKDOWN_FILENAME} not found ` +
      `(${file || `looked for the vendored copy from ${__dirname}`})`;
    // In CI a missing source list is a BUILD BUG (the vendored file wasn't
    // committed / shipped), not something to skip: before #78 this branch
    // logged one line and returned 0, and dev ran with an empty registry.
    // GitHub Actions always sets CI=true, so the seed step now fails there.
    // Locally (no CI) it still only warns, so a partial seed keeps working.
    if (isCi()) throw new Error(`${msg} — refusing to skip in CI.`);
    console.warn(`${msg} — skipping.`);
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

    // Seed-owned fields (pages + pins + adapter) refreshed, crawl state kept.
    const { doc, matchedUrls } = buildSeededVisaSource({ country: c, existing, now });
    matchedUrls.forEach((u) => matchedOverrideUrls.add(u));
    // Full overwrite (no merge): a registry field removed from code (e.g. a
    // country dropped from VISA_SOURCE_ADAPTERS) disappears from the doc too.
    batch.set(ref, doc);
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
