// ============================================
// Unit tests — news scraper x address guard (issue #159)
// ============================================
//
// NO network and NO emulator: a stub HTTP client stands in for the guarded
// client (the guard itself is tested against local servers in
// address-guard-client.test.ts). Here we check what the SCRAPER does with a
// refusal and with scraped links.

import { test, describe, before, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { NewsSource } from "../../../src/types/news";
import { BlockedAddressError } from "../../../src/scrapers/shared/fetch/address-guard";
import type { VisaCatalogHttpClient } from "../../../src/scrapers/shared/fetch/visa-catalog-fetch.service";
import { installFakes } from "../../helpers/fake-firestore";

// Project id (GCLOUD_PROJECT=demo-unit-test) and the no-network guard are set
// centrally by the test preload, test/helpers/setup.ts (issue #94).

// Loaded in before(): a static import would run utils/firebase before the env
// line above (imports are hoisted).
type ScraperModule = typeof import("../../../src/scrapers/news/news-scraper.service");
let mod: ScraperModule;

before(async () => {
  // Issue #81: the orchestrator now writes a `scrapeRuns` run record through
  // utils/firebase; swap in the in-memory fake so no real Firestore is hit.
  await installFakes();
  mod = await import("../../../src/scrapers/news/news-scraper.service");
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
  async findExistingHashes() {
    return new Set<string>();
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

const LISTING = `<html><body>
<div class="item"><a href="https://gov.example.org/n/1">Fee update one</a></div>
<div class="item"><a href="http://127.0.0.1/admin">Internal one</a></div>
<div class="item"><a href="http://169.254.169.254/x">Internal two</a></div>
<div class="item"><a href="https://gov.example.org:8443/n/4">Odd port</a></div>
</body></html>`;

const RSS_OK = `<?xml version="1.0"?><rss version="2.0"><channel><title>t</title>
<item><title>New rule</title><link>https://good.example.org/a1</link><description>Summary</description></item>
</channel></rss>`;

const urlsRequested = () => requests.map((r) => r.url);

beforeEach(() => {
  requests = [];
  routes = new Map();
  dueSources = [];
  updates = [];
  runs = [];
  created = [];
});

describe("scraped article links", () => {
  test("links to non-public addresses or ports are never requested and do not fail the run", async () => {
    routes.set("https://gov.example.org/news", { status: 200, body: LISTING });
    routes.set("https://gov.example.org/n/1", { status: 200, body: "<div class=\"body\">Full text one</div>" });
    const run = await makeScraper().scrapeSource(htmlSource("ukvi", "https://gov.example.org/news", true));
    // The run succeeded and found every link.
    assert.equal(updates[0].success, true);
    assert.equal(run.articlesFound, 4);
    // Only the public article was opened (plus its robots check); nothing else.
    assert.ok(urlsRequested().includes("https://gov.example.org/n/1"));
    assert.ok(!urlsRequested().some((u) => u.includes("127.0.0.1") || u.includes("169.254") || u.includes(":8443")));
    // The skipped articles keep their summary-only record.
    assert.equal(created.length, 4);
    assert.equal(created.find((a) => a.originalUrl.includes("127.0.0.1"))?.body, undefined);
  });
});

describe("a refusal from the guarded client", () => {
  /** Stub client whose requests to `badHost` are refused like the real guard does. */
  const refusingHttp: VisaCatalogHttpClient = {
    async get(url) {
      requests.push({ url });
      if (new URL(url).hostname === "bad.example.org") throw new BlockedAddressError("bad.example.org");
      const r = routes.get(url) ?? { status: 404, body: "" };
      return { status: r.status, data: r.body ?? "", headers: {} };
    },
  };
  const scraper = () =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    new mod.NewsScraperService({ http: refusingHttp, store: store as any, minIntervalMs: 0, clock: () => NOW });

  test("is a normal failed run with the fixed message, no backoff and no retry", async () => {
    await assert.rejects(scraper().scrapeSource(rssSource("bad", "https://bad.example.org/feed")), /address not allowed/);
    assert.equal(updates[0].success, false);
    assert.equal(updates[0].errorMessage, "Refusing to fetch from bad.example.org: address not allowed");
    // Not a 429/503 host backoff: nothing is deferred.
    assert.equal(updates[0].notBeforeMs, undefined);
    assert.equal(runs[0].result.status, "failed");
    // Robots check (refused, fails open) then the feed itself (refused): no retry.
    assert.deepEqual(
      urlsRequested(),
      ["https://bad.example.org/robots.txt", "https://bad.example.org/feed"]
    );
  });

  test("does not stop other sources in the same run", async () => {
    routes.set("https://good.example.org/feed", { status: 200, body: RSS_OK });
    dueSources = [rssSource("bad", "https://bad.example.org/feed"), rssSource("good", "https://good.example.org/feed")];
    const result = await scraper().runOrchestrator();
    assert.equal(result.errors, 1);
    assert.equal(result.newArticles, 1);
    assert.equal(updates.find((u) => u.sourceId === "bad")?.success, false);
    assert.equal(updates.find((u) => u.sourceId === "good")?.success, true);
    assert.equal(result.hostsBackedOff, 0);
  });
});
