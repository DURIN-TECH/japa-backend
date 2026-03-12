import axios, { AxiosInstance } from "axios";
import * as cheerio from "cheerio";
import Parser from "rss-parser";
import { createHash } from "crypto";
import { newsService } from "./news.service";
import {
  NewsSource,
  NewsArticle,
  ScrapeRun,
  ArticleImportance,
  RawArticle,
  OrchestratorResult,
} from "../types/news";
import { Timestamp } from "firebase-admin/firestore";

// ============================================
// CUSTOM RSS PARSER TYPE
// ============================================

type CustomFeed = Record<string, never>;
type CustomItem = {
  mediaContent?: { $: { url: string } };
  mediaThumbnail?: { $: { url: string } };
  contentEncoded?: string;
};

// ============================================
// NEWS SCRAPER SERVICE
// ============================================

class NewsScraperService {
  private httpClient: AxiosInstance;
  private rssParser: Parser<CustomFeed, CustomItem>;

  constructor() {
    this.httpClient = axios.create({
      timeout: 15000,
      headers: {
        "User-Agent":
          "JAPA-VisaNewsBot/1.0 (+https://japa.app/bot)",
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5",
      },
      maxRedirects: 3,
      maxContentLength: 5 * 1024 * 1024, // 5MB limit
    });

    this.rssParser = new Parser<CustomFeed, CustomItem>({
      timeout: 10000,
      customFields: {
        item: [
          ["media:content", "mediaContent"],
          ["media:thumbnail", "mediaThumbnail"],
          ["content:encoded", "contentEncoded"],
        ],
      },
    });
  }

  // ============================================
  // ORCHESTRATOR
  // ============================================

  async runOrchestrator(): Promise<OrchestratorResult> {
    const result: OrchestratorResult = {
      sourcesProcessed: 0,
      newArticles: 0,
      errors: 0,
    };

    const dueSources = await newsService.getDueSources(5);

    if (dueSources.length === 0) {
      console.log("No sources due for scraping");
      return result;
    }

    console.log(`Found ${dueSources.length} sources due for scraping`);

    for (const source of dueSources) {
      try {
        const scrapeResult = await this.scrapeSource(source);
        result.sourcesProcessed++;
        result.newArticles += scrapeResult.articlesNew;
      } catch (error) {
        result.errors++;
        console.error(`Failed to scrape source ${source.name}:`, error);

        await newsService.updateSourceAfterScrape(
          source.id,
          false,
          (error as Error).message
        );
      }
    }

    return result;
  }

  // ============================================
  // SINGLE SOURCE SCRAPER
  // ============================================

  async scrapeSource(source: NewsSource): Promise<ScrapeRun> {
    const runId = await newsService.createScrapeRun(source.id);
    const startTime = Date.now();

    try {
      // 1. Fetch raw articles using the appropriate strategy
      let rawArticles: RawArticle[];

      switch (source.strategy) {
        case "rss":
          rawArticles = await this.fetchRss(source);
          break;
        case "html_scrape":
          rawArticles = await this.fetchHtml(source);
          break;
        case "news_api":
          rawArticles = await this.fetchNewsApi(source);
          break;
        default:
          throw new Error(`Unknown strategy: ${source.strategy}`);
      }

      // 2. Normalize and deduplicate
      let articlesNew = 0;
      let articlesDuplicate = 0;
      let articlesFailed = 0;
      const newArticles: Omit<
        NewsArticle,
        "id" | "viewCount" | "bookmarkCount" | "createdAt" | "updatedAt"
      >[] = [];

      for (const raw of rawArticles.slice(0, source.config.maxArticlesPerRun)) {
        try {
          const normalized = this.normalizeArticle(raw, source);

          const isDup = await newsService.isDuplicate(
            normalized.urlHash,
            normalized.titleHash
          );

          if (isDup) {
            articlesDuplicate++;
            continue;
          }

          newArticles.push(normalized);
          articlesNew++;
        } catch (parseError) {
          articlesFailed++;
          console.warn(
            `Failed to normalize article from ${source.name}:`,
            parseError
          );
        }
      }

      // 3. Batch write new articles
      if (newArticles.length > 0) {
        await newsService.createArticlesBatch(newArticles);
      }

      // 4. Update source health
      await newsService.updateSourceAfterScrape(source.id, true);

      // 5. Complete the scrape run record
      const runResult: Partial<ScrapeRun> = {
        status:
          articlesFailed > 0 && articlesNew === 0 ? "partial" : "success",
        articlesFound: rawArticles.length,
        articlesNew,
        articlesDuplicate,
        articlesFailed,
        durationMs: Date.now() - startTime,
      };

      await newsService.completeScrapeRun(source.id, runId, runResult);

      console.log(
        `Source "${source.name}": found=${rawArticles.length}, new=${articlesNew}, dup=${articlesDuplicate}, failed=${articlesFailed}`
      );

      return {
        ...runResult,
        id: runId,
        sourceId: source.id,
        startedAt: Timestamp.now(),
      } as ScrapeRun;
    } catch (error) {
      await newsService.completeScrapeRun(source.id, runId, {
        status: "failed",
        errorMessage: (error as Error).message,
        errorStack: (error as Error).stack,
        durationMs: Date.now() - startTime,
      });

      await newsService.updateSourceAfterScrape(
        source.id,
        false,
        (error as Error).message
      );

      throw error;
    }
  }

  // ============================================
  // STRATEGY: RSS
  // ============================================

  private async fetchRss(source: NewsSource): Promise<RawArticle[]> {
    const feedUrl = source.config.feedUrl;
    if (!feedUrl) {
      throw new Error(`No feedUrl configured for RSS source: ${source.name}`);
    }

    const feed = await this.rssParser.parseURL(feedUrl);

    return (feed.items || []).map((item) => ({
      title: this.cleanText(item.title || ""),
      url: item.link || "",
      summary: this.cleanText(
        item.contentSnippet || item.content || item.summary || ""
      ).slice(0, 500),
      body: item.contentEncoded || item.content || undefined,
      imageUrl:
        item.mediaThumbnail?.$.url ||
        item.mediaContent?.$.url ||
        item.enclosure?.url ||
        undefined,
      publishedAt: item.pubDate ? new Date(item.pubDate) : undefined,
    }));
  }

  // ============================================
  // STRATEGY: HTML SCRAPE
  // ============================================

  private async fetchHtml(source: NewsSource): Promise<RawArticle[]> {
    const selectors = source.config.selectors;
    if (!selectors) {
      throw new Error(
        `No selectors configured for HTML source: ${source.name}`
      );
    }

    // Politeness delay
    await this.delay(1000);

    const response = await this.httpClient.get(source.url, {
      headers: source.config.customHeaders || {},
    });

    const $ = cheerio.load(response.data);
    const articles: RawArticle[] = [];

    $(selectors.articleList).each((_, element) => {
      try {
        const $el = $(element);

        const title = this.cleanText(
          $el.find(selectors.articleTitle).first().text()
        );
        const linkEl = $el.find(selectors.articleLink).first();
        let url = linkEl.attr("href") || "";

        // Resolve relative URLs
        if (url && !url.startsWith("http")) {
          const baseUrl = new URL(source.url);
          url = new URL(url, baseUrl.origin).toString();
        }

        const summary = selectors.articleSummary
          ? this.cleanText(
              $el.find(selectors.articleSummary).first().text()
            ).slice(0, 500)
          : "";

        const imageUrl = selectors.articleImage
          ? $el.find(selectors.articleImage).first().attr("src") || undefined
          : undefined;

        let publishedAt: Date | undefined;
        if (selectors.articleDate) {
          const dateText = $el.find(selectors.articleDate).first().text().trim();
          if (dateText) {
            const parsed = new Date(dateText);
            if (!isNaN(parsed.getTime())) {
              publishedAt = parsed;
            }
          }
        }

        if (title && url) {
          articles.push({ title, url, summary, imageUrl, publishedAt });
        }
      } catch {
        // Skip individual articles that fail to parse
      }
    });

    // Optionally fetch full content for each article
    if (source.config.fetchFullContent && selectors.articleBody) {
      for (const article of articles.slice(0, 5)) {
        try {
          await this.delay(500);
          const detailResp = await this.httpClient.get(article.url);
          const detail$ = cheerio.load(detailResp.data);
          article.body = this.cleanText(
            detail$(selectors.articleBody).text()
          ).slice(0, 5000);
        } catch {
          // Summary is enough
        }
      }
    }

    return articles;
  }

  // ============================================
  // STRATEGY: NEWS API
  // ============================================

  private async fetchNewsApi(source: NewsSource): Promise<RawArticle[]> {
    const apiConfig = source.config.apiConfig;
    if (!apiConfig) {
      throw new Error(
        `No apiConfig configured for API source: ${source.name}`
      );
    }

    const apiKey =
      process.env[`NEWS_API_KEY_${apiConfig.provider.toUpperCase()}`];
    if (!apiKey) {
      throw new Error(`Missing API key for provider: ${apiConfig.provider}`);
    }

    let articles: RawArticle[] = [];

    if (apiConfig.provider === "newsdata") {
      const response = await this.httpClient.get(
        "https://newsdata.io/api/1/news",
        {
          params: {
            apikey: apiKey,
            q: apiConfig.query,
            language: apiConfig.language || "en",
            country: apiConfig.country,
            category: apiConfig.category,
          },
        }
      );

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      articles = (response.data.results || []).map((item: any) => ({
        title: item.title || "",
        url: item.link || "",
        summary: (item.description || "").slice(0, 500),
        imageUrl: item.image_url || undefined,
        publishedAt: item.pubDate ? new Date(item.pubDate) : undefined,
      }));
    } else if (apiConfig.provider === "newsapi") {
      const response = await this.httpClient.get(
        "https://newsapi.org/v2/everything",
        {
          params: {
            apiKey,
            q: apiConfig.query,
            language: apiConfig.language || "en",
            sortBy: "publishedAt",
            pageSize: source.config.maxArticlesPerRun,
          },
        }
      );

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      articles = (response.data.articles || []).map((item: any) => ({
        title: item.title || "",
        url: item.url || "",
        summary: (item.description || "").slice(0, 500),
        imageUrl: item.urlToImage || undefined,
        publishedAt: item.publishedAt
          ? new Date(item.publishedAt)
          : undefined,
      }));
    }

    return articles;
  }

  // ============================================
  // NORMALIZATION
  // ============================================

  private normalizeArticle(
    raw: RawArticle,
    source: NewsSource
  ): Omit<
    NewsArticle,
    "id" | "viewCount" | "bookmarkCount" | "createdAt" | "updatedAt"
  > {
    const normalizedUrl = this.normalizeUrl(raw.url);
    const normalizedTitle = raw.title.toLowerCase().trim();

    return {
      title: raw.title.trim(),
      summary: raw.summary || "",
      body: raw.body || undefined,
      originalUrl: raw.url,
      imageUrl: raw.imageUrl,

      countryCodes: source.countryCodes,
      tags: this.extractTags(raw.title + " " + raw.summary),
      importance: this.classifyImportance(raw.title, raw.summary, source),

      sourceId: source.id,
      sourceName: source.name,
      sourceIsOfficial: source.isOfficial,

      urlHash: this.hash(normalizedUrl),
      titleHash: this.hash(normalizedTitle),
      contentFingerprint: raw.body
        ? this.hash(raw.body.slice(0, 1000))
        : undefined,

      publishedAt: raw.publishedAt
        ? Timestamp.fromDate(raw.publishedAt)
        : Timestamp.now(),
      scrapedAt: Timestamp.now(),

      isPublished: true,
      isNotificationSent: false,
    };
  }

  // ============================================
  // IMPORTANCE CLASSIFICATION
  // ============================================

  private classifyImportance(
    title: string,
    summary: string,
    source: NewsSource
  ): ArticleImportance {
    const text = (title + " " + summary).toLowerCase();

    const breakingPatterns = [
      /breaking/i,
      /urgent/i,
      /immediate\s+effect/i,
      /border\s+clos/i,
      /suspend(ed|s|ing)/i,
      /ban(ned|s)?\s+(on\s+)?visa/i,
    ];
    if (breakingPatterns.some((p) => p.test(text))) {
      return "breaking";
    }

    const highPatterns = [
      /policy\s+change/i,
      /new\s+(visa|immigration)\s+(rule|regulation|requirement|policy|pathway)/i,
      /deadline/i,
      /quota\s+(increase|decrease|change)/i,
      /express\s+entry\s+draw/i,
      /processing\s+time\s+(change|update|increase|decrease)/i,
      /fee\s+(increase|change|update)/i,
      /announcement/i,
      /effective\s+(immediately|from)/i,
    ];
    if (highPatterns.some((p) => p.test(text))) {
      return "high";
    }

    if (source.isOfficial) {
      return "high";
    }

    return "normal";
  }

  // ============================================
  // TAG EXTRACTION
  // ============================================

  private extractTags(text: string): string[] {
    const tags: string[] = [];

    const tagPatterns: Record<string, RegExp> = {
      "work-visa": /work\s*(visa|permit)/i,
      "student-visa": /stud(y|ent)\s*(visa|permit)/i,
      "express-entry": /express\s*entry/i,
      "family-reunion": /family\s*(reunion|sponsorship|visa)/i,
      "tourist-visa": /tourist\s*visa|visitor\s*visa|travel\s*visa/i,
      "permanent-residence": /permanent\s*residen/i,
      "citizenship": /citizenship|naturali[sz]ation/i,
      "skilled-worker": /skilled\s*worker|points.based/i,
      "policy-change": /policy\s*change|new\s*rule|regulation\s*change/i,
      "processing-time": /processing\s*time/i,
      "fee-update": /fee\s*(increase|change|update)/i,
      "quota": /quota|allocation|cap/i,
      "refugee": /refugee|asylum/i,
      "investment": /invest(or|ment)\s*visa/i,
      "startup-visa": /start.?up\s*visa/i,
    };

    for (const [tag, pattern] of Object.entries(tagPatterns)) {
      if (pattern.test(text)) {
        tags.push(tag);
      }
    }

    return tags;
  }

  // ============================================
  // UTILITIES
  // ============================================

  private hash(input: string): string {
    return createHash("sha256").update(input).digest("hex");
  }

  private normalizeUrl(url: string): string {
    try {
      const parsed = new URL(url);
      const trackingParams = [
        "utm_source",
        "utm_medium",
        "utm_campaign",
        "utm_content",
        "utm_term",
        "ref",
        "fbclid",
      ];
      trackingParams.forEach((p) => parsed.searchParams.delete(p));
      let normalized = parsed.toString();
      if (normalized.endsWith("/")) {
        normalized = normalized.slice(0, -1);
      }
      return normalized.toLowerCase();
    } catch {
      return url.toLowerCase().trim();
    }
  }

  private cleanText(text: string): string {
    return text
      .replace(/\s+/g, " ")
      .replace(/\n+/g, " ")
      .replace(/<[^>]*>/g, "")
      .trim();
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

export const newsScraperService = new NewsScraperService();
