import { FieldValue, getFirestore, Timestamp } from "firebase-admin/firestore";
import { IngestionStrategy, ScrapingConfig, SourceStatus, SupportedCountryCode } from "../../types/news";

// NOTE: the Firestore handle is resolved LAZILY inside seedNewsSources() (not
// at module load). getFirestore() throws when Firebase Admin is not yet
// initialized, and since #91 this module is loaded by scrapers/index.ts on
// every function cold start, in whatever order the import graph gives. Same
// pattern as seed-visa-sources.ts. seedNewsSources() itself still requires
// Admin to be initialized first (scripts/seed-all.ts guarantees that).

export interface NewsSourceSeed {
  name: string;
  slug: string;
  url: string;
  countryCodes: SupportedCountryCode[];
  strategy: IngestionStrategy;
  config: ScrapingConfig;
  scrapeIntervalMinutes: number;
  status: SourceStatus;
  // Issue #107: why the registry ships this source paused / retired
  // (required for those statuses; stored as `statusReason` on the doc and
  // shown on the source's health row).
  statusReason?: string;
  isOfficial: boolean;
  priority: number;
}

export const NEWS_SOURCES: NewsSourceSeed[] = [
  // ============================================
  // CANADA
  // ============================================
  {
    name: "CIC News",
    slug: "cic-news",
    url: "https://www.cicnews.com/",
    countryCodes: ["CA"],
    strategy: "rss",
    config: {
      feedUrl: "https://www.cicnews.com/feed",
      maxArticlesPerRun: 20,
      fetchFullContent: false,
      // Issue #107: runs failed with "timeout of 15000ms exceeded" (the news
      // client's default, NEWS_HTTP_TIMEOUT_MS). Checked 2026-11-10 with a
      // plain public GET: the feed answers 200 with items, but the host is
      // slow at times (the `/feed/` -> `/feed` redirect alone took ~7.6s).
      // 30s for this source only; a run that still times out is recorded
      // as a normal failure ("timeout of 30000ms exceeded").
      requestTimeoutMs: 30_000,
    },
    scrapeIntervalMinutes: 120,
    status: "active",
    isOfficial: false,
    priority: 1,
  },
  {
    name: "IRCC Official News",
    slug: "ircc-official",
    url: "https://www.canada.ca/en/immigration-refugees-citizenship/news.html",
    countryCodes: ["CA"],
    strategy: "html_scrape",
    config: {
      selectors: {
        articleList: ".item, .views-row",
        articleLink: "a",
        articleTitle: "a, .field-content",
        articleSummary: ".views-field-body p, .field-content p",
        articleDate: ".views-field-created, .date",
      },
      maxArticlesPerRun: 15,
      fetchFullContent: false,
    },
    scrapeIntervalMinutes: 360,
    status: "active",
    isOfficial: true,
    priority: 2,
  },

  // ============================================
  // AUSTRALIA
  // ============================================
  {
    name: "Dept of Home Affairs",
    slug: "au-home-affairs",
    url: "https://immi.homeaffairs.gov.au/news-media/archive",
    countryCodes: ["AU"],
    strategy: "html_scrape",
    config: {
      selectors: {
        articleList: ".news-item, .archive-item, article",
        articleLink: "a",
        articleTitle: "h3, h2, .title",
        articleSummary: "p, .summary",
        articleDate: ".date, time",
      },
      maxArticlesPerRun: 15,
      fetchFullContent: false,
    },
    scrapeIntervalMinutes: 360,
    // Issue #107: PAUSED. Every run got HTTP 403. Checked 2026-11-10 with a
    // plain public GET: the Akamai edge in front of every homeaffairs.gov.au
    // host (immi., www., minister., incl. robots.txt) answers 403 "Access
    // Denied" to our bot User-Agent (Seli-VisaNewsBot) and 200 to generic
    // clients, and the department publishes no RSS / Atom feed (the archive
    // page links none). Our crawler policy forbids spoofing the UA to get
    // round a block, so there is nothing to repoint to: paused with a reason.
    status: "paused",
    statusReason:
      "Home Affairs blocks our bot User-Agent (HTTP 403 from the Akamai edge on every homeaffairs.gov.au host, " +
      "robots.txt included) and publishes no RSS/Atom feed; we never spoof the User-Agent (checked 2026-11-10, issue #107)",
    isOfficial: true,
    priority: 1,
  },
  {
    name: "SBS Immigration News",
    slug: "sbs-immigration",
    url: "https://www.sbs.com.au/news/topic/immigration",
    countryCodes: ["AU"],
    strategy: "html_scrape",
    config: {
      selectors: {
        articleList: "article, .card",
        articleLink: "a",
        articleTitle: "h3, h2",
        articleSummary: "p, .description",
        articleDate: "time",
        articleImage: "img",
      },
      maxArticlesPerRun: 15,
      fetchFullContent: false,
    },
    scrapeIntervalMinutes: 240,
    status: "active",
    isOfficial: false,
    priority: 3,
  },

  // ============================================
  // IRELAND
  // ============================================
  {
    name: "Irish Immigration Service",
    slug: "irish-immigration",
    url: "https://www.irishimmigration.ie/news-and-updates/",
    countryCodes: ["IE"],
    strategy: "html_scrape",
    config: {
      selectors: {
        articleList: "article, .post, .news-item",
        articleLink: "a",
        articleTitle: "h2, h3, .entry-title",
        articleSummary: ".entry-summary, .excerpt, p",
        articleDate: ".date, time, .entry-date",
      },
      maxArticlesPerRun: 15,
      fetchFullContent: false,
    },
    scrapeIntervalMinutes: 480,
    status: "active",
    isOfficial: true,
    priority: 1,
  },

  // ============================================
  // UK
  // ============================================
  {
    name: "Free Movement",
    slug: "free-movement-uk",
    url: "https://freemovement.org.uk/",
    countryCodes: ["GB"],
    strategy: "rss",
    config: {
      feedUrl: "https://freemovement.org.uk/feed/",
      maxArticlesPerRun: 15,
      fetchFullContent: false,
    },
    scrapeIntervalMinutes: 180,
    status: "active",
    isOfficial: false,
    priority: 2,
  },
  {
    name: "GOV.UK UKVI",
    slug: "gov-uk-ukvi",
    url: "https://www.gov.uk/government/organisations/uk-visas-and-immigration",
    countryCodes: ["GB"],
    strategy: "html_scrape",
    config: {
      selectors: {
        articleList: ".gem-c-document-list__item, .document-row",
        articleLink: "a",
        articleTitle: ".gem-c-document-list__item-title, a",
        articleSummary: ".gem-c-document-list__item-description, p",
        articleDate: ".gem-c-document-list__attribute, time",
      },
      maxArticlesPerRun: 15,
      fetchFullContent: false,
    },
    scrapeIntervalMinutes: 360,
    status: "active",
    isOfficial: true,
    priority: 1,
  },

  // ============================================
  // CROSS-COUNTRY
  // ============================================
  {
    name: "Visa Reporter",
    slug: "visa-reporter",
    url: "https://visareporter.com/",
    countryCodes: ["CA", "AU", "IE", "GB"],
    strategy: "rss",
    config: {
      feedUrl: "https://visareporter.com/feed/",
      maxArticlesPerRun: 20,
      fetchFullContent: false,
    },
    scrapeIntervalMinutes: 240,
    // Issue #107: RETIRED. Every run failed with "getaddrinfo EAI_AGAIN
    // visareporter.com"; checked 2026-11-10: the domain does not resolve
    // (no DNS answer), so the site is gone.
    status: "retired",
    statusReason: "domain does not resolve (visareporter.com: no DNS answer, checked 2026-11-10, issue #107)",
    isOfficial: false,
    priority: 4,
  },

  // ============================================
  // NEWS API (SUPPLEMENTARY)
  // ============================================
  {
    name: "NewsData.io Immigration",
    slug: "newsdata-immigration",
    url: "https://newsdata.io",
    countryCodes: ["CA", "AU", "IE", "GB"],
    strategy: "news_api",
    config: {
      apiConfig: {
        provider: "newsdata",
        query: "visa immigration",
        language: "en",
        category: "politics",
      },
      maxArticlesPerRun: 10,
      fetchFullContent: false,
    },
    scrapeIntervalMinutes: 720,
    // Issue #107: stays active in the registry. Without the
    // NEWS_API_KEY_NEWSDATA secret the scraper pauses it at run time
    // (status paused, autoPaused, reason "missing API key") instead of
    // erroring; once the secret is set an admin un-pauses it with
    // PATCH /admin/scrape-sources/news/newsdata-immigration { "resetFailures": true }.
    status: "active",
    isOfficial: false,
    priority: 5,
  },
];

/**
 * The status a re-seed writes for one news source (pure). In order:
 *  1. an admin set one (`adminOverrides.status`, issue #96): the stored
 *     status is kept, so an admin pause / retire is never undone by a deploy;
 *  2. the registry ships the source `paused` / `retired` (issue #107, e.g. a
 *     dead domain): that wins over any stored crawler state;
 *  3. the crawler holds it (`broken`, or `autoPaused`, issue #107): kept, so
 *     a re-seed never un-pauses a source that keeps failing (before #107 the
 *     seed reset it to active with 0 failures, and it failed again);
 *  4. otherwise the seed's status.
 * `adminOverrides` itself is not written by the seed (merge: true).
 */
export function newsSeedStatus(seedStatus: SourceStatus, existing: Record<string, unknown> | undefined): SourceStatus {
  const overrides = existing?.adminOverrides as { status?: unknown } | undefined;
  if (overrides && typeof overrides.status === "string" && typeof existing?.status === "string") {
    return existing.status as SourceStatus;
  }
  if (seedStatus === "paused" || seedStatus === "retired") return seedStatus;
  if (existing && (existing.status === "broken" || existing.autoPaused === true) && typeof existing.status === "string") {
    return existing.status as SourceStatus;
  }
  return seedStatus;
}

/**
 * Runtime health fields the crawler owns (issue #107). A re-seed of an
 * EXISTING doc keeps them (only a new doc gets the baseline), so the streak
 * and the auto-pause flags survive deploys and match the kept status.
 */
export const NEWS_SOURCE_HEALTH_FIELDS = [
  "reliabilityScore",
  "consecutiveFailures",
  "totalRuns",
  "successfulRuns",
  "createdAt",
] as const;

/**
 * The doc a re-seed writes for one news source (pure, merge: true).
 * Registry fields always; the health baseline only for a NEW doc.
 */
export function buildSeededNewsSource(
  source: NewsSourceSeed,
  existing: Record<string, unknown> | undefined,
  now: Timestamp
): Record<string, unknown> {
  const status = newsSeedStatus(source.status, existing);
  const doc: Record<string, unknown> = {
    id: source.slug,
    name: source.name,
    slug: source.slug,
    url: source.url,
    countryCodes: source.countryCodes,
    strategy: source.strategy,
    config: source.config,
    scrapeIntervalMinutes: source.scrapeIntervalMinutes,
    // Due immediately so the scraper picks it up right away (only an
    // `active` source is ever due).
    nextScrapeAt: now,
    status,
    // The registry's reason for a paused / retired source; removed when the
    // registry no longer gives one (merge: true needs an explicit delete).
    statusReason: source.statusReason ?? (existing ? FieldValue.delete() : undefined),
    isOfficial: source.isOfficial,
    priority: source.priority,
    updatedAt: now,
  };
  if (doc.statusReason === undefined) delete doc.statusReason;
  // The registry's paused / retired status replaces a crawler hold: drop the
  // auto-pause flags so the row does not claim the crawler paused it.
  if (existing?.autoPaused === true && status !== existing.status) {
    Object.assign(doc, { autoPaused: false, autoPausedAt: null, autoPausedReason: null, autoPauseCause: null });
  }
  if (!existing) {
    // Brand-new source: the health baseline.
    Object.assign(doc, { reliabilityScore: 100, consecutiveFailures: 0, totalRuns: 0, successfulRuns: 0, createdAt: now });
  } else {
    // Existing source: keep the crawler's health (merge leaves it alone);
    // fill in only what an old doc lacks.
    for (const field of NEWS_SOURCE_HEALTH_FIELDS) {
      if (existing[field] === undefined) {
        doc[field] = field === "reliabilityScore" ? 100 : field === "createdAt" ? now : 0;
      }
    }
  }
  return doc;
}

/**
 * Seed the `newsSources` collection from the static NEWS_SOURCES list above.
 *
 * Moved here (out of scripts/seed-all.ts) so news-source seeding lives next to
 * its own data definition, matching how every other domain seeder is organized
 * (seed-portal-data, seed-countries-visas, eligibility-seed-nigeria-ireland).
 * The consolidated entry point now just calls this function.
 *
 * Each source is written under a deterministic doc ID (its slug) with
 * `{ merge: true }`, so re-running the seed is idempotent: existing sources are
 * updated in place rather than duplicated. Issue #107: the runtime health the
 * scraper owns (reliabilityScore, run counters, the failure streak and the
 * auto-pause flags) is KEPT on existing docs (it used to be reset on every
 * seed, which un-paused failing sources); see buildSeededNewsSource().
 *
 * @returns the number of sources seeded.
 */
export async function seedNewsSources(): Promise<number> {
  // Resolved here (not at module load) — see the note at the top of the file.
  const db = getFirestore();
  const collection = db.collection("newsSources");
  const batch = db.batch();
  const now = Timestamp.now();

  // Issue #96: read the existing docs (one round trip) so an admin's status
  // edit (`adminOverrides`, set through PATCH /admin/scrape-sources/news/:id)
  // survives the re-seed. getAll() on zero refs would throw, hence the guard.
  const refs = NEWS_SOURCES.map((s) => collection.doc(s.slug));
  const snaps = refs.length ? await db.getAll(...refs) : [];

  NEWS_SOURCES.forEach((source, idx) => {
    // Use the slug as the deterministic doc ID so re-running is idempotent.
    const ref = refs[idx];
    const existing = snaps[idx]?.exists ? (snaps[idx].data() as Record<string, unknown>) : undefined;
    batch.set(
      ref,
      buildSeededNewsSource(source, existing, now),
      { merge: true }
    );
  });

  await batch.commit();
  console.log(`✅ Seeded ${NEWS_SOURCES.length} news sources`);
  return NEWS_SOURCES.length;
}
