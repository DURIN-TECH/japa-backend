# Visa News Scraping System

## Context

JAPA is a visa application platform. Users need timely visibility into visa policy changes, new visa programs, and immigration news for their countries of interest. This system scrapes reputable sources (government sites, immigration news platforms, news APIs) at regular intervals and surfaces new articles to users via the app and push notifications.

**Initial countries**: Canada (CA), Australia (AU), Ireland (IE), UK (GB) -- extensible to more.

---

## Sources

### RSS Feeds (preferred -- lightweight, structured)
| Source | Country | URL | Interval |
|--------|---------|-----|----------|
| CIC News | CA | `cicnews.com/feed` | 2 hrs |
| Free Movement | GB | `freemovement.org.uk/feed/` | 3 hrs |
| Visa Reporter | CA,AU,IE,GB | `visareporter.com/feed/` | 4 hrs |
| IRCC Official | CA | `canada.ca/.../news.html` RSS feed | 6 hrs |

### HTML Scraping (Cheerio -- static HTML, no JS rendering needed)
| Source | Country | URL | Interval |
|--------|---------|-----|----------|
| IRCC Newsroom | CA | `canada.ca/en/immigration-refugees-citizenship/news.html` | 6 hrs |
| Dept of Home Affairs | AU | `immi.homeaffairs.gov.au/news-media/archive` | 6 hrs |
| SBS Immigration | AU | `sbs.com.au/news/topic/immigration` | 4 hrs |
| Irish Immigration (ISD) | IE | `irishimmigration.ie/news-and-updates/` | 8 hrs |
| GOV.UK UKVI | GB | `gov.uk/government/organisations/uk-visas-and-immigration` | 6 hrs |

### News API (supplementary, preserves quota)
| Source | Country | Provider | Interval |
|--------|---------|----------|----------|
| NewsData.io | All | `newsdata.io` (free tier) | 12 hrs |

---

## Architecture

```
[scrapeNewsOrchestrator] -- Cloud Scheduler, every 30 min
       |
       | queries newsSources where status="active" AND nextScrapeAt <= now
       | processes at most 5 sources per invocation
       |
       v
[Strategy Router] -- picks RSS / HTML / News API based on source config
       |
       v
[Normalizer] -- unified NewsArticle schema, tag extraction, importance classification
       |
       v
[Deduplicator] -- SHA-256 of normalized URL + SHA-256 of lowercased title
       |
       v
[Firestore Batch Write] -- newsArticles collection
       |
       v
[onNewsArticleCreated trigger] -- sends FCM + in-app notification to subscribed users
```

Key decisions:
- **Single orchestrator function**, not per-source functions -- avoids cold-start overhead, keeps costs predictable
- **Staggered scheduling** via per-source `nextScrapeAt` field -- distributes load naturally
- **Cheerio over Puppeteer** -- all target sites serve static HTML, Cheerio is 100x lighter
- **Top-level `newsArticles` collection** (not nested under countries) -- articles can cover multiple countries; avoids fan-out writes
- **CSS selectors stored in Firestore** (not code) -- when a site layout changes, update the selector config without redeploying

---

## Firestore Data Model

### New Collections
```
newsArticles/{articleId}                       -- normalized articles
newsSources/{sourceId}                         -- source registry + health tracking
newsSources/{sourceId}/scrapeRuns/{runId}       -- per-source execution logs
newsSubscriptions/{subscriptionId}             -- user notification preferences
```

### Modified Collections
- `src/utils/firebase.ts` -- add `newsArticles`, `newsSources`, `newsSubscriptions` to `collections`, add `scrapeRuns` to `subcollections`
- `src/types/index.ts` -- extend `NotificationType` with `"visa_news"`, extend `relatedEntityType` with `"news_article"`

---

## New Types (`src/types/news.ts`)

```typescript
export type IngestionStrategy = "rss" | "html_scrape" | "news_api";
export type SourceStatus = "active" | "paused" | "broken" | "retired";
export type ArticleImportance = "breaking" | "high" | "normal" | "low";
export type SupportedCountryCode = "CA" | "AU" | "IE" | "GB";

export interface ScrapingConfig {
  /** CSS selectors for HTML scraping strategy */
  selectors?: {
    articleList: string;       // Selector for the container/list of articles
    articleLink: string;       // Selector for the article link within each item
    articleTitle: string;      // Selector for the title element
    articleSummary?: string;   // Selector for the summary/excerpt
    articleDate?: string;      // Selector for the publication date
    articleImage?: string;     // Selector for the thumbnail image
    articleBody?: string;      // Selector for full article body (on detail page)
  };
  /** RSS/Atom feed URL (for strategy "rss") */
  feedUrl?: string;
  /** News API query parameters (for strategy "news_api") */
  apiConfig?: {
    provider: "newsdata" | "newsapi";
    query: string;
    language?: string;
    country?: string;
    category?: string;
  };
  /** Max number of articles to fetch per run */
  maxArticlesPerRun: number;
  /** Whether to follow article links and scrape full body text */
  fetchFullContent: boolean;
  /** Custom HTTP headers */
  customHeaders?: Record<string, string>;
}

export interface NewsSource {
  id: string;
  name: string;                          // "CIC News"
  slug: string;                          // "cic-news"
  url: string;
  countryCodes: SupportedCountryCode[];
  strategy: IngestionStrategy;
  config: ScrapingConfig;
  scrapeIntervalMinutes: number;
  lastScrapedAt?: Timestamp;
  nextScrapeAt?: Timestamp;
  status: SourceStatus;
  reliabilityScore: number;              // 0-100 from success rate
  consecutiveFailures: number;           // auto-pauses at 5
  totalRuns: number;
  successfulRuns: number;
  lastErrorMessage?: string;
  lastErrorAt?: Timestamp;
  isOfficial: boolean;                   // government vs third-party
  priority: number;                      // 1 (highest) to 10
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface NewsArticle {
  id: string;
  title: string;
  summary: string;
  body?: string;
  originalUrl: string;
  imageUrl?: string;
  countryCodes: SupportedCountryCode[];
  tags: string[];                        // auto-extracted: "work-visa", "express-entry", etc.
  importance: ArticleImportance;         // auto-classified from keywords
  sourceId: string;
  sourceName: string;                    // denormalized
  sourceIsOfficial: boolean;             // denormalized
  urlHash: string;                       // SHA-256 for dedup
  titleHash: string;                     // SHA-256 for dedup
  publishedAt: Timestamp;
  scrapedAt: Timestamp;
  isPublished: boolean;
  isNotificationSent: boolean;
  viewCount: number;
  bookmarkCount: number;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface ScrapeRun {
  id: string;
  sourceId: string;
  status: "running" | "success" | "partial" | "failed";
  articlesFound: number;
  articlesNew: number;
  articlesDuplicate: number;
  articlesFailed: number;
  startedAt: Timestamp;
  completedAt?: Timestamp;
  durationMs?: number;
  errorMessage?: string;
}

export interface NewsSubscription {
  id: string;
  userId: string;
  countryCodes: SupportedCountryCode[];   // empty = all countries
  importanceThreshold: ArticleImportance; // only notify at this level or higher
  pushEnabled: boolean;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}
```

---

## New Files to Create

| File | Purpose |
|------|---------|
| `src/types/news.ts` | Type definitions above |
| `src/services/news.service.ts` | Firestore CRUD for articles, sources, subscriptions |
| `src/services/news-scraper.service.ts` | Orchestrator + RSS/HTML/API strategy implementations |
| `src/services/news-notification.service.ts` | FCM + in-app notification dispatch to subscribers |
| `src/controllers/news.controller.ts` | HTTP request handlers |
| `src/routes/news.routes.ts` | Express route definitions |
| `src/data/seed-news-sources.ts` | Initial source configurations |
| `src/scripts/seed-news-sources.ts` | Seed script runner |

## Existing Files to Modify

| File | Change |
|------|--------|
| `src/utils/firebase.ts` | Add `newsArticles`, `newsSources`, `newsSubscriptions` to collections; `scrapeRuns` to subcollections |
| `src/types/index.ts` | Add `"visa_news"` to `NotificationType`, `"news_article"` to `relatedEntityType`, re-export `./news` |
| `src/app.ts` | Mount `/news` routes |
| `src/index.ts` | Add `scrapeNewsOrchestrator`, `cleanupOldNews`, `onNewsArticleCreated` exports |
| `firestore.indexes.json` | Add composite indexes for news queries |
| `package.json` | Add `axios`, `cheerio`, `rss-parser` dependencies |

---

## Cloud Functions

### `scrapeNewsOrchestrator` (Scheduled, every 30 min)
- Queries `newsSources` where `status == "active"` and `nextScrapeAt <= now`
- Processes up to 5 sources per invocation
- For each source: fetch -> normalize -> dedup -> batch write -> update source health
- Memory: 512MB, Timeout: 540s

### `cleanupOldNews` (Scheduled, weekly Sunday 4 AM)
- Deletes articles older than 90 days
- Deletes scrape runs older than 30 days
- Memory: 256MB, Timeout: 120s

### `onNewsArticleCreated` (Firestore trigger on `newsArticles/{articleId}`)
- Fires when a new article is created with `isPublished: true`
- Skips `importance === "low"` articles
- Queries `newsSubscriptions` for matching country codes + importance threshold
- Sends FCM push notification + creates in-app notification record
- Rate-limits to max 3 news notifications per user per 24 hours
- Memory: 256MB, Timeout: 60s

---

## User-Facing API Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/news` | Optional | List articles. `?country=CA&limit=20&after=<timestamp>` |
| GET | `/news/:id` | Optional | Article detail + increment view count |
| GET | `/news/subscriptions/me` | Required | Get user's notification preferences |
| PUT | `/news/subscriptions/me` | Required | Update notification preferences |
| GET | `/news/admin/sources` | Admin | List sources with health stats |
| GET | `/news/admin/sources/:id/runs` | Admin | Scrape run history |

---

## Deduplication Strategy

1. **URL hash** (exact match): `SHA-256(normalizeUrl(url))` -- strips UTM params, lowercases, removes trailing slash
2. **Title hash** (near-exact): `SHA-256(title.toLowerCase().trim())` -- catches same story from different URLs
3. Both checked via Firestore queries before writing

---

## Importance Classification & Tag Extraction

Auto-classify articles by scanning title + summary for keyword patterns:
- **Breaking**: "breaking", "suspended", "border closed", "banned"
- **High**: "policy change", "new visa", "deadline", "fee increase", "express entry draw"
- **Normal**: everything else (official sources default to "high")
- **Tags**: auto-extracted: "work-visa", "student-visa", "express-entry", "permanent-residence", "policy-change", etc.

---

## Source Health & Self-Healing

- `consecutiveFailures` counter resets on success, increments on failure
- After 5 consecutive failures: source auto-pauses to `status: "broken"`
- `reliabilityScore = successfulRuns / totalRuns * 100`
- Admin can investigate, update CSS selectors in Firestore, and set status back to `"active"` -- no redeploy needed

---

## NPM Packages to Add

| Package | Purpose |
|---------|---------|
| `axios` | HTTP client with timeout, redirect control, interceptors |
| `cheerio` | jQuery-like HTML parsing for static pages (no browser needed) |
| `rss-parser` | RSS/Atom feed parsing with namespace support |

---

## Implementation Checklist

### Phase 1: Foundation
- [ ] Add npm packages (`axios`, `cheerio`, `rss-parser`)
- [ ] Create `src/types/news.ts` with all type definitions
- [ ] Update `src/types/index.ts` (re-export, extend NotificationType & relatedEntityType)
- [ ] Update `src/utils/firebase.ts` (new collection/subcollection refs)
- [ ] Update `firestore.indexes.json`

### Phase 2: Core Services
- [ ] Implement `src/services/news.service.ts` (Firestore CRUD)
- [ ] Implement `src/services/news-scraper.service.ts` (orchestrator + strategies)
- [ ] Create `src/data/seed-news-sources.ts` (source configs)
- [ ] Create `src/scripts/seed-news-sources.ts` (seed runner)

### Phase 3: Scheduled Functions
- [ ] Add `scrapeNewsOrchestrator` to `src/index.ts`
- [ ] Add `cleanupOldNews` to `src/index.ts`
- [ ] Test with emulator + seed data

### Phase 4: User-Facing API
- [ ] Implement `src/controllers/news.controller.ts`
- [ ] Implement `src/routes/news.routes.ts`
- [ ] Mount `/news` routes in `src/app.ts`

### Phase 5: Notifications
- [ ] Implement `src/services/news-notification.service.ts`
- [ ] Add `onNewsArticleCreated` trigger to `src/index.ts`
- [ ] Test notification flow end-to-end

### Phase 6: Polish & Deploy
- [ ] Add dev routes for manual scrape triggering
- [ ] Tune CSS selectors against live sites
- [ ] Deploy and monitor initial runs
- [ ] Adjust intervals and selectors based on results

---

## Verification Plan

1. **Local testing**: Run with Firebase emulator (`npm run serve`), seed sources, trigger orchestrator via dev route
2. **RSS strategy**: Verify CIC News feed parses correctly, dedup works on re-run
3. **HTML strategy**: Verify selectors work against live pages (test each source URL with Cheerio)
4. **Dedup**: Run orchestrator twice in quick succession -- second run should produce 0 new articles
5. **Notifications**: Create a test subscription, verify FCM payload + in-app notification on article creation
6. **Health tracking**: Simulate failures by using a broken URL, verify auto-pause at 5 failures
7. **API endpoints**: Test `GET /news?country=CA`, `GET /news/:id`, subscription CRUD
8. **Cleanup**: Verify old article/run deletion works with weekly scheduled function
