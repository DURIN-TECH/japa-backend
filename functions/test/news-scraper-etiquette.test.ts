// ============================================
// Unit tests — news bot crawler etiquette (issue #76)
// ============================================
//
// Run with `npm test`. NO network and NO emulator: every HTTP request goes to
// a stub client injected into NewsScraperService, and the Firestore-backed
// newsService is replaced by an in-memory stub store. Firebase Admin is
// initialised (news.service imports it) against a dummy project id that is
// never contacted.
//
// Covers:
//  - the User-Agent points at the news-bot section of /bot, and a source's
//    customHeaders cannot override it
//  - robots.txt: a Disallow (in our own group or `*`) stops the listing / feed
//    request; our specific group wins over `*`; disallowed article pages are
//    skipped; news API calls are not robots-checked
//  - 429/503 (page, feed, robots.txt, API): Retry-After honoured, the host is
//    not requested again for the rest of the run (later sources skipped,
//    article pages skipped), the next visit is pushed to the Retry-After time,
//    other hosts are unaffected, and API keys never reach error messages
//  - RSS feeds go through the shared client (so they carry our UA)

import { test, describe, before, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { NewsSource } from "../src/types/news";
import type { VisaCatalogHttpClient } from "../src/services/visa-catalog-fetch.service";

// Admin init needs a project id (utils/firebase derives the bucket from it).
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || "demo-unit-test";

// Loaded in before(): a static import would run utils/firebase before the env
// line above (imports are hoisted).
type ScraperModule = typeof import("../src/services/news-scraper.service");
let mod: ScraperModule;

before(async () => {
  mod = await import("../src/services/news-scraper.service");
});

// ----- Fixed clock -----

const NOW = Date.parse("2026-11-10T12:00:00Z");

// ----- Stub HTTP -----

interface StubResponse {
  status: number;
  body?: string;
  headers?: Record<string, string>;
}

/** Every request the scraper sent, in order. */
let requests: { url: string; headers?: Record<string, string> }[] = [];
/** url -> response; unknown URLs answer 404 (so robots.txt is "absent"). */
let routes: Map<string, StubResponse>;

const http: VisaCatalogHttpClient = {
  async get(url, config) {
    requests.push({ url, headers: config?.headers });
    const r = routes.get(url) ?? { status: 404, body: "" };
    return { status: r.status, data: r.body ?? "", headers: r.headers ?? {} };
  },
};

// ----- Stub store (the newsService slice the scraper uses) -----

interface SourceUpdate {
  sourceId: string;
  success: boolean;
  errorMessage?: string;
  notBeforeMs?: number;
}

let dueSources: NewsSource[] = [];
let updates: SourceUpdate[] = [];
let runs: { sourceId: string; result: Record<string, unknown> }[] = [];
let created: { originalUrl: string; body?: string }[] = [];

const store = {
  async getDueSources() {
    return dueSources;
  },
  async createScrapeRun(sourceId: string) {
    return `run-${sourceId}`;
  },
  async isDuplicate() {
    return false;
  },
  async createArticlesBatch(articles: { originalUrl: string; body?: string }[]) {
    created.push(...articles);
    return articles.length;
  },
  async updateSourceAfterScrape(
    sourceId: string,
    success: boolean,
    errorMessage?: string,
    notBeforeMs?: number
  ) {
    updates.push({ sourceId, success, errorMessage, notBeforeMs });
  },
  async completeScrapeRun(sourceId: string, _runId: string, result: Record<string, unknown>) {
    runs.push({ sourceId, result });
  },
};

function makeScraper() {
  return new mod.NewsScraperService({
    http,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    store: store as any,
    minIntervalMs: 0,
    clock: () => NOW,
  });
}

// ----- Source + fixture builders -----

function rssSource(id: string, feedUrl: string, extra: Partial<NewsSource["config"]> = {}): NewsSource {
  return {
    id,
    name: id,
    slug: id,
    url: new URL(feedUrl).origin + "/",
    countryCodes: ["GB"],
    strategy: "rss",
    config: { feedUrl, maxArticlesPerRun: 10, fetchFullContent: false, ...extra },
    scrapeIntervalMinutes: 120,
    isOfficial: false,
  } as unknown as NewsSource;
}

function htmlSource(id: string, url: string, fetchFullContent = false): NewsSource {
  return {
    id,
    name: id,
    slug: id,
    url,
    countryCodes: ["GB"],
    strategy: "html_scrape",
    config: {
      selectors: { articleList: ".item", articleLink: "a", articleTitle: "a", articleBody: ".body" },
      maxArticlesPerRun: 10,
      fetchFullContent,
    },
    scrapeIntervalMinutes: 360,
    isOfficial: true,
  } as unknown as NewsSource;
}

function apiSource(id: string): NewsSource {
  return {
    id,
    name: id,
    slug: id,
    url: "https://newsdata.io",
    countryCodes: ["GB"],
    strategy: "news_api",
    config: {
      apiConfig: { provider: "newsdata", query: "visa immigration" },
      maxArticlesPerRun: 10,
      fetchFullContent: false,
    },
    scrapeIntervalMinutes: 720,
    isOfficial: false,
  } as unknown as NewsSource;
}

const RSS = `<?xml version="1.0"?><rss version="2.0"><channel><title>t</title>
<item><title>New skilled worker rule</title><link>https://news.example.org/a1</link><description>Summary one</description></item>
</channel></rss>`;

const LISTING = `<html><body>
<div class="item"><a href="https://gov.example.org/n/1">Fee update one</a></div>
<div class="item"><a href="https://other.example.net/n/2">Fee update two</a></div>
<div class="item"><a href="https://other.example.net/n/3">Fee update three</a></div>
</body></html>`;

const urlsRequested = () => requests.map((r) => r.url);

beforeEach(() => {
  requests = [];
  routes = new Map();
  dueSources = [];
  updates = [];
  runs = [];
  created = [];
  process.env.NEWS_API_KEY_NEWSDATA = "secret-key-123";
});

// ============================================
// User-Agent
// ============================================

describe("news bot User-Agent", () => {
  test("points at the news-bot section of the /bot page", () => {
    assert.equal(mod.NEWS_BOT_USER_AGENT, "Seli-VisaNewsBot/1.0 (+https://weareseli.com/bot#news-bot)");
    const client = mod.createNewsHttpClient();
    assert.equal(client.defaults.headers["User-Agent"], mod.NEWS_BOT_USER_AGENT);
    // Every status reaches the fetch layer (so 429/503 are seen, not thrown).
    assert.equal(client.defaults.validateStatus?.(503), true);
  });

  test("a source's customHeaders cannot override the User-Agent", async () => {
    routes.set("https://news.example.org/feed", { status: 200, body: RSS });
    const src = rssSource("cic", "https://news.example.org/feed", {
      customHeaders: { "User-Agent": "Mozilla/5.0", "X-Keep": "1" },
    });
    await makeScraper().scrapeSource(src);
    const feedReq = requests.find((r) => r.url === "https://news.example.org/feed");
    assert.ok(feedReq);
    assert.equal(feedReq.headers?.["User-Agent"], undefined);
    assert.equal(feedReq.headers?.["X-Keep"], "1");
  });
});

// ============================================
// robots.txt
// ============================================

describe("robots.txt", () => {
  test("RSS feed is fetched through the shared client after a robots check", async () => {
    routes.set("https://news.example.org/feed", { status: 200, body: RSS });
    const run = await makeScraper().scrapeSource(rssSource("cic", "https://news.example.org/feed"));
    assert.deepEqual(urlsRequested(), ["https://news.example.org/robots.txt", "https://news.example.org/feed"]);
    assert.equal(run.articlesNew, 1);
    assert.equal(created[0].originalUrl, "https://news.example.org/a1");
  });

  test("a Disallow in the Seli-VisaNewsBot group blocks the listing page", async () => {
    routes.set("https://gov.example.org/robots.txt", {
      status: 200,
      body: "User-agent: *\nDisallow:\n\nUser-agent: Seli-VisaNewsBot\nDisallow: /news\n",
    });
    await assert.rejects(
      makeScraper().scrapeSource(htmlSource("ukvi", "https://gov.example.org/news")),
      /Blocked by robots\.txt/
    );
    // Only robots.txt was requested — never the page.
    assert.deepEqual(urlsRequested(), ["https://gov.example.org/robots.txt"]);
    assert.equal(updates[0].success, false);
    assert.equal(runs[0].result.status, "failed");
  });

  test("our specific group wins over `*` (a `*` Disallow does not apply)", async () => {
    routes.set("https://gov.example.org/robots.txt", {
      status: 200,
      body: "User-agent: *\nDisallow: /\n\nUser-agent: Seli-VisaNewsBot\nDisallow: /private\n",
    });
    routes.set("https://gov.example.org/news", { status: 200, body: LISTING });
    const run = await makeScraper().scrapeSource(htmlSource("ukvi", "https://gov.example.org/news"));
    assert.equal(run.articlesFound, 3);
  });

  test("a `*` Disallow applies when no group names us", async () => {
    routes.set("https://news.example.org/robots.txt", { status: 200, body: "User-agent: *\nDisallow: /feed\n" });
    await assert.rejects(
      makeScraper().scrapeSource(rssSource("cic", "https://news.example.org/feed")),
      /Blocked by robots\.txt/
    );
    assert.ok(!urlsRequested().includes("https://news.example.org/feed"));
  });

  test("disallowed article pages are skipped; allowed ones are fetched", async () => {
    routes.set("https://gov.example.org/news", { status: 200, body: LISTING });
    routes.set("https://other.example.net/robots.txt", { status: 200, body: "User-agent: *\nDisallow: /n/\n" });
    routes.set("https://gov.example.org/n/1", { status: 200, body: "<div class=\"body\">Full text one</div>" });
    await makeScraper().scrapeSource(htmlSource("ukvi", "https://gov.example.org/news", true));
    assert.ok(urlsRequested().includes("https://gov.example.org/n/1"));
    assert.ok(!urlsRequested().includes("https://other.example.net/n/2"));
    assert.ok(!urlsRequested().includes("https://other.example.net/n/3"));
    assert.equal(created.find((a) => a.originalUrl.endsWith("/n/1"))?.body, "Full text one");
  });

  test("news API calls are not robots-checked", async () => {
    routes.set("https://newsdata.io/api/1/news?apikey=secret-key-123&q=visa+immigration&language=en", {
      status: 200,
      body: JSON.stringify({ results: [{ title: "Visa news", link: "https://x.example/1" }] }),
    });
    const run = await makeScraper().scrapeSource(apiSource("newsdata"));
    assert.equal(run.articlesNew, 1);
    assert.ok(!urlsRequested().some((u) => u.endsWith("/robots.txt")));
  });
});

// ============================================
// 429 / 503 backoff
// ============================================

describe("429/503 backoff", () => {
  test("429 with Retry-After: the host is skipped for the rest of the run; other hosts are not", async () => {
    routes.set("https://news.example.org/feed", { status: 429, headers: { "retry-after": "7200" } });
    routes.set("https://visa.example.com/feed", { status: 200, body: RSS });
    dueSources = [
      rssSource("first", "https://news.example.org/feed"),
      rssSource("second-same-host", "https://news.example.org/other-feed"),
      rssSource("third-other-host", "https://visa.example.com/feed"),
    ];

    const result = await makeScraper().runOrchestrator();

    // The throttled host got exactly robots.txt + the one 429 — nothing more.
    assert.deepEqual(
      urlsRequested().filter((u) => u.startsWith("https://news.example.org")),
      ["https://news.example.org/robots.txt", "https://news.example.org/feed"]
    );
    // The other host was still crawled.
    assert.ok(urlsRequested().includes("https://visa.example.com/feed"));
    assert.equal(result.sourcesProcessed, 1);
    assert.equal(result.errors, 2);

    const until = NOW + 7200 * 1000;
    // The throttled source and the skipped one: failures, next visit >= Retry-After.
    const first = updates.filter((u) => u.sourceId === "first");
    assert.ok(first.length > 0 && first.every((u) => !u.success && u.notBeforeMs === until));
    const skipped = updates.filter((u) => u.sourceId === "second-same-host");
    assert.equal(skipped.length, 1);
    assert.equal(skipped[0].success, false);
    assert.equal(skipped[0].notBeforeMs, until);
    assert.match(skipped[0].errorMessage ?? "", /host backed off \(429\)/);
    // The skipped source sent no request and opened no scrape run.
    assert.ok(!runs.some((r) => r.sourceId === "second-same-host"));
    assert.deepEqual(updates.find((u) => u.sourceId === "third-other-host")?.success, true);
  });

  test("503 on robots.txt backs off without requesting the page (default 1h when no Retry-After)", async () => {
    routes.set("https://gov.example.org/robots.txt", { status: 503 });
    await assert.rejects(
      makeScraper().scrapeSource(htmlSource("ukvi", "https://gov.example.org/news")),
      { name: "HostBackoffError" }
    );
    assert.deepEqual(urlsRequested(), ["https://gov.example.org/robots.txt"]);
    assert.equal(updates[0].notBeforeMs, NOW + 60 * 60 * 1000);
  });

  test("429 on an article page stops further article requests to that host", async () => {
    routes.set("https://gov.example.org/news", { status: 200, body: LISTING });
    routes.set("https://other.example.net/n/2", { status: 429, headers: { "retry-after": "60" } });
    const run = await makeScraper().scrapeSource(htmlSource("ukvi", "https://gov.example.org/news", true));
    // The listing still succeeds; /n/3 on the throttled host is never requested.
    assert.equal(run.articlesNew, 3);
    assert.ok(urlsRequested().includes("https://other.example.net/n/2"));
    assert.ok(!urlsRequested().includes("https://other.example.net/n/3"));
  });

  test("429 from a news API backs off and never leaks the API key", async () => {
    routes.set("https://newsdata.io/api/1/news?apikey=secret-key-123&q=visa+immigration&language=en", {
      status: 429,
      headers: { "Retry-After": "120" },
    });
    dueSources = [apiSource("newsdata")];
    const result = await makeScraper().runOrchestrator();
    assert.equal(result.errors, 1);
    for (const u of updates) {
      assert.equal(u.notBeforeMs, NOW + 120 * 1000);
      assert.ok(!(u.errorMessage ?? "").includes("secret-key-123"));
    }
    for (const r of runs) {
      assert.ok(!String(r.result.errorMessage ?? "").includes("secret-key-123"));
    }
  });

  test("a non-2xx API error message names the host, not the keyed URL", async () => {
    routes.set("https://newsdata.io/api/1/news?apikey=secret-key-123&q=visa+immigration&language=en", {
      status: 401,
      body: "{}",
    });
    await assert.rejects(makeScraper().scrapeSource(apiSource("newsdata")), (err: Error) => {
      assert.match(err.message, /newsdata\.io failed \(HTTP 401\)/);
      assert.ok(!err.message.includes("secret-key-123"));
      return true;
    });
  });
});

// ============================================
// API keys never reach logs (issue #76 review)
// ============================================

describe("API key secrecy", () => {
  /** Run `fn` with console.log/warn/error captured; returns everything logged. */
  async function captureLogs(fn: () => Promise<unknown>): Promise<string> {
    const lines: string[] = [];
    const orig = { log: console.log, warn: console.warn, error: console.error };
    const sink = (...args: unknown[]) => {
      // Serialise objects deeply (like Cloud Logging would) so a raw error's
      // config.url / headers would show up if they were logged.
      lines.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a, Object.getOwnPropertyNames(a ?? {})))).join(" "));
    };
    console.log = sink;
    console.warn = sink;
    console.error = sink;
    try {
      await fn();
    } finally {
      Object.assign(console, orig);
    }
    return lines.join("\n");
  }

  test("a network-level axios error on the keyed NewsData URL logs no key", async () => {
    // An axios-shaped error whose message AND config carry the keyed URL.
    const keyedUrl = "https://newsdata.io/api/1/news?apikey=secret-key-123&q=visa";
    const failingHttp: VisaCatalogHttpClient = {
      async get(url) {
        const err = Object.assign(new Error(`connect ECONNREFUSED while requesting ${url}`), {
          isAxiosError: true,
          config: { url, headers: { "X-Api-Key": "secret-key-123" } },
        });
        throw err;
      },
    };
    dueSources = [apiSource("newsdata")];
    const scraper = new mod.NewsScraperService({
      http: failingHttp,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      store: store as any,
      minIntervalMs: 0,
      clock: () => NOW,
    });
    const logs = await captureLogs(() => scraper.runOrchestrator());
    assert.ok(logs.includes("Failed to scrape source newsdata"), logs);
    assert.ok(logs.includes("host=newsdata.io"), logs);
    assert.ok(!logs.includes("secret-key-123"), logs);
    assert.ok(!logs.includes(keyedUrl), logs);
    // Nothing written to Firestore carries it either.
    for (const u of updates) assert.ok(!(u.errorMessage ?? "").includes("secret-key-123"));
    for (const r of runs) {
      assert.ok(!String(r.result.errorMessage ?? "").includes("secret-key-123"));
      assert.ok(!String(r.result.errorStack ?? "").includes("secret-key-123"));
    }
  });

  test("NewsAPI gets its key in the X-Api-Key header, not the URL", async () => {
    process.env.NEWS_API_KEY_NEWSAPI = "newsapi-key-456";
    const src = apiSource("newsapi");
    src.config.apiConfig = { provider: "newsapi", query: "visa" };
    routes.set("https://newsapi.org/v2/everything?q=visa&language=en&sortBy=publishedAt&pageSize=10", {
      status: 200,
      body: JSON.stringify({ articles: [{ title: "T", url: "https://x.example/2" }] }),
    });
    const run = await makeScraper().scrapeSource(src);
    assert.equal(run.articlesNew, 1);
    const req = requests.find((r) => r.url.startsWith("https://newsapi.org/"));
    assert.ok(req && !req.url.includes("newsapi-key-456"));
    assert.equal(req.headers?.["X-Api-Key"], "newsapi-key-456");
  });

  test("redactSecrets / describeError strip key pairs and configured key values", () => {
    assert.equal(
      mod.redactSecrets("GET /news?apikey=abc123&q=x apiKey=zzz X-Api-Key: qqq"),
      "GET /news?apikey=[REDACTED]&q=x apiKey=[REDACTED] X-Api-Key: [REDACTED]"
    );
    assert.equal(mod.describeError(new Error("echo secret-key-123 back")), "echo [REDACTED] back");
  });
});
