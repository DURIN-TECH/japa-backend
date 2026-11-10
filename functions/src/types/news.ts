import { Timestamp } from "firebase-admin/firestore";

// ============================================
// ENUMS / TYPE UNIONS
// ============================================

export type IngestionStrategy = "rss" | "html_scrape" | "news_api";

export type SourceStatus = "active" | "paused" | "broken" | "retired";

export type ArticleImportance = "breaking" | "high" | "normal" | "low";

export type SupportedCountryCode = "CA" | "AU" | "IE" | "GB";

export type ScrapeRunStatus = "running" | "success" | "partial" | "failed";

// ============================================
// SCRAPING CONFIG
// ============================================

export interface HtmlSelectors {
  articleList: string;
  articleLink: string;
  articleTitle: string;
  articleSummary?: string;
  articleDate?: string;
  articleImage?: string;
  articleBody?: string;
}

export interface NewsApiConfig {
  provider: "newsdata" | "newsapi";
  query: string;
  language?: string;
  country?: string;
  category?: string;
}

export interface ScrapingConfig {
  /** CSS selectors for HTML scraping strategy */
  selectors?: HtmlSelectors;

  /** RSS/Atom feed URL (for strategy "rss") */
  feedUrl?: string;

  /** News API query parameters (for strategy "news_api") */
  apiConfig?: NewsApiConfig;

  /** Max number of articles to fetch per run */
  maxArticlesPerRun: number;

  /** Whether to follow article links and scrape full body text */
  fetchFullContent: boolean;

  /** Custom HTTP headers (e.g., for Accept or User-Agent) */
  customHeaders?: Record<string, string>;

  /**
   * Issue #107: per-request timeout in ms for this source's requests (feed,
   * listing page, article pages). Absent = the news HTTP client's default
   * (NEWS_HTTP_TIMEOUT_MS, 15000). Clamped to NEWS_MAX_REQUEST_TIMEOUT_MS
   * (60000) by the scraper. Set in seed-news-sources.ts (e.g. cic-news).
   */
  requestTimeoutMs?: number;
}

// ============================================
// NEWS SOURCE
// ============================================

export interface NewsSource {
  id: string;

  // Identity
  name: string;
  slug: string;
  url: string;
  countryCodes: SupportedCountryCode[];

  // Ingestion
  strategy: IngestionStrategy;
  config: ScrapingConfig;

  // Scheduling
  scrapeIntervalMinutes: number;
  lastScrapedAt?: Timestamp;
  nextScrapeAt?: Timestamp;

  // Health
  status: SourceStatus;
  reliabilityScore: number;
  consecutiveFailures: number;
  totalRuns: number;
  successfulRuns: number;
  lastErrorMessage?: string;
  lastErrorAt?: Timestamp;

  // Issue #107: set by the CRAWLER when it pauses the source itself
  // (scrapers/shared/runs/source-health.ts): `broken` after
  // `news.consecutiveFailureLimit` consecutive failures (cause
  // "failure_limit"), or `paused` when a news_api provider key is missing
  // (cause "missing_api_key"). Cleared on recovery / admin reset.
  autoPaused?: boolean;
  autoPausedAt?: Timestamp | null;
  autoPausedReason?: string | null;
  autoPauseCause?: "failure_limit" | "missing_api_key" | null;
  // Issue #107: why the REGISTRY (seed-news-sources.ts) ships the source
  // paused / retired, e.g. "domain does not resolve". Admin reasons live in
  // `adminOverrides.reason`.
  statusReason?: string;

  // Metadata
  isOfficial: boolean;
  priority: number;

  createdAt: Timestamp;
  updatedAt: Timestamp;
}

// ============================================
// NEWS ARTICLE
// ============================================

export interface NewsArticle {
  id: string;

  // Content
  title: string;
  summary: string;
  body?: string;
  originalUrl: string;
  imageUrl?: string;

  // Classification
  countryCodes: SupportedCountryCode[];
  tags: string[];
  importance: ArticleImportance;

  // Source attribution (denormalized)
  sourceId: string;
  sourceName: string;
  sourceIsOfficial: boolean;

  // Deduplication
  urlHash: string;
  titleHash: string;
  contentFingerprint?: string;

  // Timing
  publishedAt: Timestamp;
  scrapedAt: Timestamp;

  // Status
  isPublished: boolean;
  isNotificationSent: boolean;
  notificationSentAt?: Timestamp;

  // Engagement
  viewCount: number;
  bookmarkCount: number;

  createdAt: Timestamp;
  updatedAt: Timestamp;
}

// ============================================
// SCRAPE RUN (subcollection of newsSources)
// ============================================

export interface ScrapeRun {
  id: string;
  sourceId: string;
  // Issue #81: the run-wide `scrapeRuns/{runId}` record this source run
  // belongs to (absent on logs written before #81, or for a standalone
  // scrapeSource() call outside an orchestrator run).
  runId?: string;

  status: ScrapeRunStatus;

  // Metrics
  articlesFound: number;
  articlesNew: number;
  articlesDuplicate: number;
  articlesFailed: number;

  // Timing
  startedAt: Timestamp;
  completedAt?: Timestamp;
  durationMs?: number;

  // Error details
  errorMessage?: string;
  errorStack?: string;

  // Debug
  httpStatusCode?: number;
  responseTimeMs?: number;
}

// ============================================
// NEWS SUBSCRIPTION
// ============================================

export interface NewsSubscription {
  id: string;
  userId: string;

  // What to subscribe to
  countryCodes: SupportedCountryCode[];
  importanceThreshold: ArticleImportance;

  // Notification preferences
  pushEnabled: boolean;

  createdAt: Timestamp;
  updatedAt: Timestamp;
}

// ============================================
// INTERNAL TYPES (used by scraper service)
// ============================================

export interface RawArticle {
  title: string;
  url: string;
  summary: string;
  body?: string;
  imageUrl?: string;
  publishedAt?: Date;
  tags?: string[];
}

/**
 * One news orchestrator run's summary. Logged by the scheduled function and
 * stored verbatim as `summary` on the run's `scrapeRuns/{runId}` doc (#81).
 */
export interface OrchestratorResult {
  sourcesProcessed: number; // sources scraped without throwing
  newArticles: number;
  errors: number; // sources that failed or were skipped for a backoff
  // ---- Issue #81: the rest of the run's counters ----
  articlesFound: number; // raw articles returned by feeds / pages / APIs
  articlesDuplicate: number;
  articlesFailed: number; // articles that failed to normalise
  sourcesDeferred: number; // skipped without a request: host backed off this run
  hostsBackedOff: number; // sources whose host answered 429/503 this run
  requestsAttempted: number; // listing / feed / article / API requests tried
  // Issue #96 review: sources skipped because another run held their crawl
  // lease (recorded as `deferred` source lines; not errors). Absent = 0.
  sourcesLeased?: number;
  // Issue #107: news_api sources skipped and paused because their provider
  // key secret is missing (`deferred` lines, not errors). Absent = 0.
  sourcesPaused?: number;
  // Issue #107: sources THIS run auto-paused (streak reached
  // news.consecutiveFailureLimit). Absent = 0.
  sourcesAutoPaused?: number;
}
