import axios, { AxiosInstance } from "axios";
import * as cheerio from "cheerio";
import Parser from "rss-parser";
import { createHash } from "crypto";
import { newsService } from "./news.service";
// Crawler etiquette (issue #76): the news bot reuses the visa catalog
// crawler's fetch layer (#64) — robots.txt parsing + cache, per-host rate
// limit and 429/503 detection — instead of keeping its own copy. See
// "Crawler etiquette" below.
import { VisaCatalogFetchService, type VisaCatalogHttpClient } from "./visa-catalog-fetch.service";
import {
  HostBackoffTracker,
  backoffMessage,
  hostOf,
  isHostBackoffError,
  type HostBackoffEntry,
  type HostBackoffError,
} from "./visa-crawl-host-state";
import {
  NewsSource,
  NewsArticle,
  ScrapeRun,
  ArticleImportance,
  RawArticle,
  OrchestratorResult,
} from "../types/news";
import { Timestamp } from "firebase-admin/firestore";
// Run records (issue #81): one `scrapeRuns/{runId}` doc per orchestrator run.
import { scrapeRunService, type ScrapeRunService } from "./scrape-run.service";
import type { ScrapeRunTrigger } from "../types/scrape-run";

// ============================================
// CRAWLER ETIQUETTE (issue #76)
// ============================================
//
// The news bot is honest and identifiable, like the visa catalog crawler
// (#64). Every request it makes — news listing pages, RSS feeds, article
// pages, robots.txt AND the news API calls — carries NEWS_BOT_USER_AGENT,
// whose URL points at the news-bot section of https://weareseli.com/bot
// (seli-website `bot.html`, `#news-bot`), which describes what it fetches and
// how often. Before #76 the RSS feeds were fetched by rss-parser's own HTTP
// client and so went out as `User-Agent: rss-parser`; they now go through
// the same client as everything else.
//
// On top of that, ALL requests go through a VisaCatalogFetchService instance
// built on the news bot's own HTTP client (so the News UA, not the catalog
// UA, is sent), which gives us exactly the catalog crawler's behaviour:
//
//  - robots.txt is read (cached 24h per host) and respected before every
//    listing page, feed and article page. Rules come from
//    `parseRobotsDisallows`: a group naming us (any User-agent token that
//    contains "seli", e.g. `Seli-VisaNewsBot`) wins over `*`. Fail-open if
//    robots.txt cannot be read. News API calls (newsdata.io / newsapi.org)
//    are licensed, keyed API requests, not crawling, so they are NOT checked
//    against robots.txt — they do get the backoff below.
//  - requests to one host are spaced by PER_HOST_MIN_INTERVAL_MS (1.5s).
//    This replaces the old fixed 1s / 0.5s sleeps.
//  - a 429 or 503 (on a page, a feed, robots.txt or an API call) throws a
//    HostBackoffError carrying the host's `Retry-After` (seconds or
//    HTTP-date, clamped; 1h default). For the REST OF THE RUN (one
//    orchestrator tick) the host is not requested again: later sources on it
//    are skipped and remaining article pages on it are not fetched. The
//    source's next visit is pushed to no earlier than the Retry-After time
//    (`notBeforeMs` on updateSourceAfterScrape), and the run counts as a
//    failure toward the source's auto-pause ("broken" after repeated
//    failures, see news.service.ts).
//
// We NEVER rotate IPs, use proxies, or spoof / rotate the User-Agent to get
// around a block, a rate limit or a robots.txt rule (same policy as
// visa-catalog-fetch.service.ts). That is also why a source's
// `customHeaders` may not override the User-Agent (see requestHeaders()).

/**
 * The news bot's User-Agent. The URL fragment lands on the news-bot section
 * of the public /bot page (seli-website bot.html, `id="news-bot"`), so a site
 * owner who looks it up reads what THIS bot does. Keep the two in sync.
 */
export const NEWS_BOT_USER_AGENT = "Seli-VisaNewsBot/1.0 (+https://weareseli.com/bot#news-bot)";

/** News API endpoints (requested hosts are what the backoff tracker keys on). */
export const NEWSDATA_API_URL = "https://newsdata.io/api/1/news";
export const NEWSAPI_API_URL = "https://newsapi.org/v2/everything";

/** Max article pages opened per source per run when `fetchFullContent` is on. */
export const MAX_FULL_CONTENT_ARTICLES = 5;

// ============================================
// SECRET-SAFE ERROR LOGGING (issue #76 review)
// ============================================
//
// News API keys must never reach Cloud Logging or Firestore, so the scraper
// never logs or stores a raw error object: everything goes through
// describeError() / redactSecrets(). They moved to utils/redact.ts (#81) so
// the scrape-run recorder can redact run errors without importing this
// module; re-exported here so existing callers and tests keep working.
import { redactSecrets, describeError } from "../utils/redact";
export { redactSecrets, describeError };

/**
 * The production HTTP client for every news-bot request. `validateStatus`
 * accepts every status so the fetch layer sees 429/503 (and decides what is
 * an error) instead of axios throwing first.
 */
export function createNewsHttpClient(): AxiosInstance {
  return axios.create({
    timeout: 15000,
    headers: {
      "User-Agent": NEWS_BOT_USER_AGENT,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.5",
    },
    maxRedirects: 3,
    maxContentLength: 5 * 1024 * 1024, // 5MB limit
    validateStatus: () => true,
  });
}

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
// DEPENDENCIES (injectable for tests)
// ============================================

/** The slice of newsService the scraper writes through (a stub in tests). */
export type NewsScraperStore = Pick<
  typeof newsService,
  | "getDueSources"
  | "createScrapeRun"
  | "isDuplicate"
  | "createArticlesBatch"
  | "updateSourceAfterScrape"
  | "completeScrapeRun"
>;

/** Constructor options — all optional; defaults are the production values. */
export interface NewsScraperServiceOptions {
  // HTTP client for every request (tests inject a stub; no network).
  http?: VisaCatalogHttpClient;
  // Firestore-backed store (tests inject a stub; no emulator).
  store?: NewsScraperStore;
  // Per-host politeness gap in ms (tests pass 0 so they don't sleep).
  minIntervalMs?: number;
  // Clock (epoch ms) for Retry-After maths and the run's backoff tracker.
  clock?: () => number;
  // Issue #81: run-record service (tests inject one backed by the fake
  // Firestore; defaults to the Firestore-backed singleton).
  runs?: ScrapeRunService;
}

/**
 * Filled in by scrapeSource() for its caller (issue #81): the id of the
 * per-source log doc it created, and how many requests it attempted. Set even
 * when scrapeSource throws, so the orchestrator can still link the failed
 * source's log and count its requests.
 */
export interface ScrapeSourceTrace {
  sourceRunId?: string;
  requestsAttempted: number;
}

// ============================================
// NEWS SCRAPER SERVICE
// ============================================

export class NewsScraperService {
  // Politeness layer shared with the visa catalog crawler (#64), on OUR client.
  private readonly fetcher: VisaCatalogFetchService;
  private readonly store: NewsScraperStore;
  private readonly clock: () => number;
  private readonly runs: ScrapeRunService;
  // Issue #81: requests attempted (listing pages, feeds, article pages, API
  // calls) since construction. Callers read deltas around a scrape.
  private requestsAttempted = 0;
  private rssParser: Parser<CustomFeed, CustomItem>;

  constructor(options: NewsScraperServiceOptions = {}) {
    this.clock = options.clock ?? Date.now;
    this.store = options.store ?? newsService;
    this.runs = options.runs ?? scrapeRunService;
    this.fetcher = new VisaCatalogFetchService({
      http: options.http ?? createNewsHttpClient(),
      minIntervalMs: options.minIntervalMs,
      clock: this.clock,
    });

    // Used for PARSING only (parseString). The feed itself is fetched through
    // this.fetcher so it carries our UA, robots.txt and backoff (issue #76).
    this.rssParser = new Parser<CustomFeed, CustomItem>({
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

  /**
   * One scheduled tick: scrape up to 5 due sources.
   *
   * Run records (issue #81): every tick first sweeps stale `running` run docs
   * (crashed runs of either scraper -> failed). A tick with due sources then
   * writes `scrapeRuns/{runId}` as `running`, notes each source's outcome
   * (with a link to its `newsSources/{id}/scrapeRuns` log, which carries the
   * runId) and each error, and finalises it with this result. Idle ticks
   * write no run doc.
   *
   * @param opts.trigger stored on the run doc (default "scheduled").
   */
  async runOrchestrator(opts?: { trigger?: ScrapeRunTrigger }): Promise<OrchestratorResult> {
    const result: OrchestratorResult = {
      sourcesProcessed: 0,
      newArticles: 0,
      errors: 0,
      articlesFound: 0,
      articlesDuplicate: 0,
      articlesFailed: 0,
      sourcesDeferred: 0,
      hostsBackedOff: 0,
      requestsAttempted: 0,
    };

    // Stale sweep on EVERY tick (never throws).
    await this.runs.sweepStaleRuns(this.clock());

    const dueSources = await this.store.getDueSources(5);

    if (dueSources.length === 0) {
      console.log("No sources due for scraping");
      return result;
    }

    console.log(`Found ${dueSources.length} sources due for scraping`);

    // ---- Start the run record (issue #81); never throws ----
    const recorder = await this.runs.start({
      kind: "news",
      trigger: opts?.trigger ?? "scheduled",
      startedAtMs: this.clock(),
      options: { maxSources: 5 },
    });
    console.log(`News scrape: run ${recorder.id} started`);

    try {
      await this.scrapeDueSources(dueSources, result, recorder);
    } catch (err) {
      // Only reachable if a store write outside the per-source try throws.
      await recorder.fail(err, result);
      throw err;
    }

    // "Something worked" = at least one source scraped without throwing.
    await recorder.finalize({ summary: result, anySuccess: result.sourcesProcessed > 0 });
    return result;
  }

  /**
   * The per-source loop of runOrchestrator (split out in #81 so the run
   * record can wrap it). Mutates `result`, notes sources / errors on `recorder`.
   */
  private async scrapeDueSources(
    dueSources: NewsSource[],
    result: OrchestratorResult,
    recorder: Awaited<ReturnType<ScrapeRunService["start"]>>
  ): Promise<void> {

    // One backoff tracker per run (issue #76): a host that answers 429/503
    // is not requested again by any later source in this run.
    const tracker = new HostBackoffTracker(this.clock());

    for (const source of dueSources) {
      // Host already backed off in this run → skip WITHOUT sending a request.
      // Recorded like the catalog crawler does: a failure (toward auto-pause)
      // with the backoff message, next visit no earlier than Retry-After.
      const blocked = this.blockingEntryFor(source, tracker);
      if (blocked) {
        result.errors++;
        result.sourcesDeferred++;
        console.warn(`Skipping source ${source.name}: ${backoffMessage(blocked)}`);
        // Issue #81: a deferred source on the run record (counted as an
        // error, like the result above, because it counts toward auto-pause).
        recorder.recordError({ sourceId: source.id, url: this.entryUrlFor(source), error: backoffMessage(blocked) });
        recorder.recordSource({
          sourceId: source.id,
          name: source.name,
          status: "deferred",
          pagesAttempted: 0,
          pagesFetched: 0,
          errors: 1,
          error: backoffMessage(blocked),
        });
        await this.store.updateSourceAfterScrape(
          source.id,
          false,
          backoffMessage(blocked),
          blocked.untilMs
        );
        continue;
      }

      // Filled by scrapeSource even when it throws (issue #81).
      const trace: ScrapeSourceTrace = { requestsAttempted: 0 };
      try {
        const scrapeResult = await this.scrapeSource(source, tracker, { runId: recorder.id, trace });
        result.sourcesProcessed++;
        result.newArticles += scrapeResult.articlesNew;
        result.articlesFound += scrapeResult.articlesFound ?? 0;
        result.articlesDuplicate += scrapeResult.articlesDuplicate ?? 0;
        result.articlesFailed += scrapeResult.articlesFailed ?? 0;
        result.requestsAttempted += trace.requestsAttempted;
        recorder.addPagesAttempted(trace.requestsAttempted);
        recorder.recordSource({
          sourceId: source.id,
          name: source.name,
          // The per-source log's "partial" (every article failed to
          // normalise) maps to the run vocabulary's partial.
          status: scrapeResult.status === "partial" ? "partial" : "succeeded",
          pagesAttempted: trace.requestsAttempted,
          pagesFetched: trace.requestsAttempted,
          errors: 0,
          sourceRunId: trace.sourceRunId,
          counts: {
            articlesFound: scrapeResult.articlesFound ?? 0,
            articlesNew: scrapeResult.articlesNew ?? 0,
            articlesDuplicate: scrapeResult.articlesDuplicate ?? 0,
            articlesFailed: scrapeResult.articlesFailed ?? 0,
          },
        });
      } catch (error) {
        result.errors++;
        result.requestsAttempted += trace.requestsAttempted;
        if (isHostBackoffError(error)) result.hostsBackedOff++;
        // Issue #81: on the run record — describeError() keeps host +
        // status, and the recorder redacts again before storing.
        recorder.addPagesAttempted(trace.requestsAttempted);
        recorder.recordError({ sourceId: source.id, url: this.entryUrlFor(source), error: describeError(error) });
        recorder.recordSource({
          sourceId: source.id,
          name: source.name,
          status: "failed",
          pagesAttempted: trace.requestsAttempted,
          pagesFetched: 0,
          errors: 1,
          sourceRunId: trace.sourceRunId,
          error: describeError(error),
        });
        // Never log the raw error: an axios error carries the request URL
        // (NewsData.io's key is in its query string). describeError() keeps
        // host + status + message, redacted.
        console.error(`Failed to scrape source ${source.name}: ${describeError(error)}`);

        await this.store.updateSourceAfterScrape(
          source.id,
          false,
          describeError(error),
          isHostBackoffError(error) ? error.untilMs : undefined
        );
      }
    }
  }

  // ============================================
  // SINGLE SOURCE SCRAPER
  // ============================================

  /**
   * Scrape one source. `tracker` is the run's backoff state (the
   * orchestrator's); a standalone call gets a fresh one.
   */
  async scrapeSource(
    source: NewsSource,
    tracker: HostBackoffTracker = new HostBackoffTracker(this.clock()),
    // Issue #81: the run-wide record id to stamp on the per-source log, and
    // a trace object filled for the caller (see ScrapeSourceTrace).
    link?: { runId?: string; trace?: ScrapeSourceTrace }
  ): Promise<ScrapeRun> {
    const runId = await this.store.createScrapeRun(source.id, link?.runId);
    if (link?.trace) link.trace.sourceRunId = runId;
    // Requests counter before this source, for the trace's delta.
    const requestsBefore = this.requestsAttempted;
    const startTime = Date.now();

    try {
      // 1. Fetch raw articles using the appropriate strategy
      let rawArticles: RawArticle[];

      switch (source.strategy) {
      case "rss":
        rawArticles = await this.fetchRss(source);
        break;
      case "html_scrape":
        rawArticles = await this.fetchHtml(source, tracker);
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

          const isDup = await this.store.isDuplicate(
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
            `Failed to normalize article from ${source.name}: ${describeError(parseError)}`
          );
        }
      }

      // 3. Batch write new articles
      if (newArticles.length > 0) {
        await this.store.createArticlesBatch(newArticles);
      }

      // 4. Update source health
      await this.store.updateSourceAfterScrape(source.id, true);

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

      await this.store.completeScrapeRun(source.id, runId, runResult);
      if (link?.trace) link.trace.requestsAttempted = this.requestsAttempted - requestsBefore;

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
      // 429/503 from the source's host (page, feed, robots.txt or API):
      // block it for the rest of the run before recording the failure.
      if (isHostBackoffError(error)) this.recordBackoff(tracker, error);
      if (link?.trace) link.trace.requestsAttempted = this.requestsAttempted - requestsBefore;

      await this.store.completeScrapeRun(source.id, runId, {
        status: "failed",
        // Written to Firestore: redacted like the logs.
        errorMessage: describeError(error),
        errorStack: (error as Error).stack ? redactSecrets(String((error as Error).stack)) : undefined,
        durationMs: Date.now() - startTime,
      });

      await this.store.updateSourceAfterScrape(
        source.id,
        false,
        describeError(error),
        // Don't come back before the host's Retry-After time.
        isHostBackoffError(error) ? error.untilMs : undefined
      );

      throw error;
    }
  }

  // ============================================
  // ETIQUETTE HELPERS (issue #76)
  // ============================================

  /**
   * The URL a source's first request goes to (the host the run's backoff
   * check keys on): the feed for RSS, the listing page for HTML, the API
   * endpoint for news APIs. undefined when the source is misconfigured (the
   * strategy method then throws its own clear error).
   */
  private entryUrlFor(source: NewsSource): string | undefined {
    switch (source.strategy) {
    case "rss":
      return source.config.feedUrl;
    case "html_scrape":
      return source.url;
    case "news_api":
      if (source.config.apiConfig?.provider === "newsdata") return NEWSDATA_API_URL;
      if (source.config.apiConfig?.provider === "newsapi") return NEWSAPI_API_URL;
      return undefined;
    default:
      return undefined;
    }
  }

  /** The backoff entry blocking this source's host in this run, if any. */
  private blockingEntryFor(
    source: NewsSource,
    tracker: HostBackoffTracker
  ): HostBackoffEntry | undefined {
    const url = this.entryUrlFor(source);
    const host = url ? hostOf(url) : "";
    return host ? tracker.blocking(host) : undefined;
  }

  /**
   * Record a 429/503 against BOTH the host that answered it and the host we
   * requested (they differ after a cross-host redirect) — same rule as the
   * visa catalog orchestrator, so a missing post-redirect URL can never let
   * us keep hitting the throttling host.
   */
  private recordBackoff(tracker: HostBackoffTracker, err: HostBackoffError): void {
    const entry = err.toEntry(this.clock());
    for (const host of new Set([err.host, err.requestedHost])) {
      if (host) tracker.record({ ...entry, host });
    }
  }

  /**
   * Per-request headers for a source: its `customHeaders` (e.g. Accept),
   * minus any User-Agent — the bot must always identify itself as
   * NEWS_BOT_USER_AGENT (never spoof the UA, see the policy above).
   */
  private requestHeaders(source: NewsSource, extra: Record<string, string> = {}): Record<string, string> {
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(source.config.customHeaders ?? {})) {
      if (key.toLowerCase() !== "user-agent") headers[key] = value;
    }
    return { ...extra, ...headers };
  }

  /**
   * Robots-checked, rate-limited, backoff-aware GET of a crawled URL (listing
   * page, feed or article). Throws "Blocked by robots.txt" when disallowed,
   * HostBackoffError on 429/503 (robots.txt or the URL itself), and a plain
   * error on any other non-2xx. Returns the body text.
   */
  private async crawlGet(url: string, headers: Record<string, string>): Promise<string> {
    // Issue #81: counted as attempted even when robots.txt then blocks it.
    this.requestsAttempted++;
    if (!(await this.fetcher.isAllowedByRobots(url))) {
      throw new Error(`Blocked by robots.txt: ${url}`);
    }
    const resp = await this.fetcher.getRaw(url, headers);
    if (resp.status < 200 || resp.status >= 300) {
      throw new Error(`Fetch failed for ${url} (HTTP ${resp.status})`);
    }
    return resp.body;
  }

  // ============================================
  // STRATEGY: RSS
  // ============================================

  private async fetchRss(source: NewsSource): Promise<RawArticle[]> {
    const feedUrl = source.config.feedUrl;
    if (!feedUrl) {
      throw new Error(`No feedUrl configured for RSS source: ${source.name}`);
    }

    // Fetch through the shared fetch layer (UA + robots + backoff), then parse.
    const xml = await this.crawlGet(
      feedUrl,
      this.requestHeaders(source, {
        Accept: "application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.9, */*;q=0.8",
      })
    );
    const feed = await this.rssParser.parseString(xml);

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

  private async fetchHtml(source: NewsSource, tracker: HostBackoffTracker): Promise<RawArticle[]> {
    const selectors = source.config.selectors;
    if (!selectors) {
      throw new Error(
        `No selectors configured for HTML source: ${source.name}`
      );
    }

    // Politeness: the fetch layer's per-host gap (1.5s) replaces the old
    // fixed 1s sleep; robots.txt + backoff are checked inside crawlGet.
    const html = await this.crawlGet(source.url, this.requestHeaders(source));

    const $ = cheerio.load(html);
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

    // Optionally fetch full content for the first few articles. Each one is
    // robots-checked; a host that backed off (this run) is not requested.
    if (source.config.fetchFullContent && selectors.articleBody) {
      for (const article of articles.slice(0, MAX_FULL_CONTENT_ARTICLES)) {
        if (tracker.blocking(hostOf(article.url))) continue;
        try {
          const detailHtml = await this.crawlGet(article.url, {});
          const detail$ = cheerio.load(detailHtml);
          article.body = this.cleanText(
            detail$(selectors.articleBody).text()
          ).slice(0, 5000);
        } catch (err) {
          // 429/503 on an article host: stop requesting it for the rest of
          // the run. Robots-disallowed or failed pages: the summary is enough.
          if (isHostBackoffError(err)) this.recordBackoff(tracker, err);
        }
      }
    }

    return articles;
  }

  // ============================================
  // STRATEGY: NEWS API
  // ============================================

  /**
   * GET a news API endpoint with query params. Not robots-checked (a keyed
   * API call, not crawling) but rate-limited and backoff-aware via getRaw.
   * Errors NEVER include the URL: its query string carries the API key, and
   * error messages are written to Firestore (scrape runs, source health).
   */
  private async getNewsApiJson(
    endpoint: string,
    params: Record<string, string | number | undefined>,
    headers: Record<string, string> = {}
  ): Promise<Record<string, unknown>> {
    const url = new URL(endpoint);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== "") url.searchParams.set(key, String(value));
    }
    // Issue #81: one attempted request on the run record.
    this.requestsAttempted++;
    // HostBackoffError's message is host/status/time only — no key leak.
    const resp = await this.fetcher.getRaw(url.toString(), { Accept: "application/json", ...headers });
    if (resp.status < 200 || resp.status >= 300) {
      throw new Error(`News API request to ${url.host} failed (HTTP ${resp.status})`);
    }
    try {
      return JSON.parse(resp.body) as Record<string, unknown>;
    } catch {
      throw new Error(`News API response from ${url.host} was not JSON`);
    }
  }

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
      // NewsData.io only documents the `apikey` QUERY parameter (no header
      // form in its own docs), so the key stays in the URL; every log/stored
      // error goes through describeError() / redactSecrets() instead.
      const data = await this.getNewsApiJson(NEWSDATA_API_URL, {
        apikey: apiKey,
        q: apiConfig.query,
        language: apiConfig.language || "en",
        country: apiConfig.country,
        category: apiConfig.category,
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      articles = ((data.results as any[]) || []).map((item: any) => ({
        title: item.title || "",
        url: item.link || "",
        summary: (item.description || "").slice(0, 500),
        imageUrl: item.image_url || undefined,
        publishedAt: item.pubDate ? new Date(item.pubDate) : undefined,
      }));
    } else if (apiConfig.provider === "newsapi") {
      // NewsAPI documents the `X-Api-Key` header (and recommends it over the
      // query string, so the key stays out of URLs and logs).
      const data = await this.getNewsApiJson(
        NEWSAPI_API_URL,
        {
          q: apiConfig.query,
          language: apiConfig.language || "en",
          sortBy: "publishedAt",
          pageSize: source.config.maxArticlesPerRun,
        },
        { "X-Api-Key": apiKey }
      );

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      articles = ((data.articles as any[]) || []).map((item: any) => ({
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
}

export const newsScraperService = new NewsScraperService();
