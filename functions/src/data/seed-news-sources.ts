import { IngestionStrategy, ScrapingConfig, SourceStatus, SupportedCountryCode } from "../types/news";

export interface NewsSourceSeed {
  name: string;
  slug: string;
  url: string;
  countryCodes: SupportedCountryCode[];
  strategy: IngestionStrategy;
  config: ScrapingConfig;
  scrapeIntervalMinutes: number;
  status: SourceStatus;
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
    status: "active",
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
    status: "active",
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
    status: "active",
    isOfficial: false,
    priority: 5,
  },
];
