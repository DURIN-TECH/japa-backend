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

export interface OrchestratorResult {
  sourcesProcessed: number;
  newArticles: number;
  errors: number;
}
