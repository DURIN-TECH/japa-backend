// ============================================
// Unit tests — batched news dedup + article/run expiry (issue #19)
// ============================================
//
// Run with `npm test`. NO network and NO emulator: HTTP goes to a stub
// client, Firestore is the in-memory fake (test/helpers/fake-firestore.ts)
// and the scraper gets a stub store.
//
// Covers:
//  - chunkForInQuery: 0, 1, 30, 31 and 61 values
//  - newsService.findExistingHashes against the fake Firestore: matches on
//    urlHash or titleHash, number of queries = 2 * ceil(N / 30), none for an
//    empty input
//  - scrapeSource: duplicate by urlHash or titleHash, an in-batch repeat
//    writes ONE article, an all-duplicates run writes nothing, one lookup per
//    source (not per article), a normalisation failure does not abort the rest
//  - expireAt: articleExpireAt (normal / future publishedAt / 120 days old),
//    createArticlesBatch stamps it, createScrapeRun stamps startedAt + 30d

import { test, describe, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Timestamp } from "firebase-admin/firestore";

import type { NewsSource } from "../../../src/types/news";
import type { VisaCatalogHttpClient } from "../../../src/scrapers/shared/fetch/visa-catalog-fetch.service";
import { fakeCollection, installFakes, resetStore, store as fakeStore } from "../../helpers/fake-firestore";

/* eslint-disable @typescript-eslint/no-explicit-any */
type NewsModule = typeof import("../../../src/services/news.service");
type ScraperModule = typeof import("../../../src/scrapers/news/news-scraper.service");
let news: NewsModule;
let mod: ScraperModule;
let firebase: any;

const DAY = 24 * 60 * 60 * 1000;

before(async () => {
  await installFakes();
  firebase = await import("../../../src/utils/firebase");
  // newsArticles is not in installFakes(): fake it here, plus a minimal batch.
  firebase.collections.newsArticles = fakeCollection("newsArticles");
  firebase.db.batch = () => {
    const pending: [string, Record<string, unknown>][] = [];
    return {
      set: (ref: { path: string }, data: Record<string, unknown>) => void pending.push([ref.path, data]),
      commit: async () => {
        for (const [path, data] of pending) fakeStore.set(path, data);
      },
    };
  };
  news = await import("../../../src/services/news.service");
  mod = await import("../../../src/scrapers/news/news-scraper.service");
});

beforeEach(() => resetStore());

// ============================================
// Chunker
// ============================================

describe("chunkForInQuery", () => {
  const range = (n: number) => Array.from({ length: n }, (_, i) => i);
  const sizes = (n: number) => news.chunkForInQuery(range(n)).map((c) => c.length);

  test("0, 1, 30, 31 and 61 values", () => {
    assert.deepEqual(sizes(0), []);
    assert.deepEqual(sizes(1), [1]);
    assert.deepEqual(sizes(30), [30]);
    assert.deepEqual(sizes(31), [30, 1]);
    assert.deepEqual(sizes(61), [30, 30, 1]);
  });

  test("keeps order and loses nothing", () => {
    assert.deepEqual(news.chunkForInQuery(range(61)).flat(), range(61));
  });
});

// ============================================
// findExistingHashes
// ============================================

describe("newsService.findExistingHashes", () => {
  /** Seed an article doc with the two dedup hashes. */
  const seed = (id: string, urlHash: string, titleHash: string) =>
    fakeStore.set(`newsArticles/${id}`, { id, urlHash, titleHash });

  test("returns stored url and title hashes only", async () => {
    seed("a", "u1", "t1");
    seed("b", "u2", "t2");
    const found = await news.newsService.findExistingHashes(["u1", "u9"], ["t2", "t9"]);
    assert.deepEqual([...found].sort(), ["t2", "u1"]);
  });

  test("issues 2 * ceil(N / 30) queries, none for an empty input", async () => {
    let queries = 0;
    const base = fakeCollection("newsArticles");
    const counting = {
      ...base,
      where: (f: string, op: string, v: unknown) => {
        queries++;
        return base.where(f, op, v);
      },
    };
    firebase.collections.newsArticles = counting;
    try {
      const hashes = (p: string, n: number) => Array.from({ length: n }, (_, i) => `${p}${i}`);
      await news.newsService.findExistingHashes(hashes("u", 20), hashes("t", 20));
      assert.equal(queries, 2); // 20 articles = 2 queries
      queries = 0;
      await news.newsService.findExistingHashes(hashes("u", 31), hashes("t", 31));
      assert.equal(queries, 4);
      queries = 0;
      await news.newsService.findExistingHashes([], []);
      assert.equal(queries, 0);
    } finally {
      firebase.collections.newsArticles = base;
    }
  });
});

// ============================================
// scrapeSource dedup (fake store)
// ============================================

const http = (body: string): VisaCatalogHttpClient => ({
  async get(url) {
    // Only the feed answers; robots.txt etc. are 404 (absent).
    return url.endsWith("feed.xml")
      ? { status: 200, data: body, headers: {} }
      : { status: 404, data: "", headers: {} };
  },
});

const item = (title: string, link: string) =>
  `<item><title>${title}</title><link>${link}</link><description>s</description></item>`;
const feed = (...items: string[]) =>
  `<?xml version="1.0"?><rss version="2.0"><channel><title>t</title>${items.join("")}</channel></rss>`;

const source = {
  id: "s1",
  name: "s1",
  slug: "s1",
  url: "https://ok.example.org/",
  countryCodes: ["GB"],
  strategy: "rss",
  config: { feedUrl: "https://ok.example.org/feed.xml", maxArticlesPerRun: 100, fetchFullContent: false },
  scrapeIntervalMinutes: 120,
  isOfficial: false,
} as unknown as NewsSource;

/** Scrape `body` with a store whose "existing" hashes come from `existing`. */
async function scrape(body: string, existing: (u: string[], t: string[]) => Set<string> = () => new Set()) {
  const calls: { u: string[]; t: string[] }[] = [];
  const written: { urlHash: string; titleHash: string }[] = [];
  const store = {
    createScrapeRun: async () => "run1",
    findExistingHashes: async (u: string[], t: string[]) => {
      calls.push({ u, t });
      return existing(u, t);
    },
    createArticlesBatch: async (a: { urlHash: string; titleHash: string }[]) => {
      written.push(...a);
      return a.length;
    },
    completeScrapeRun: async () => undefined,
    updateSourceAfterScrape: async () => undefined,
  };
  const scraper = new mod.NewsScraperService({ http: http(body), store: store as any, minIntervalMs: 0 });
  const log = console.log;
  console.log = () => undefined;
  try {
    return { run: await scraper.scrapeSource(source), calls, written };
  } finally {
    console.log = log;
  }
}

describe("scrapeSource batched dedup", () => {
  test("one lookup for the whole source, all-new feed writes everything", async () => {
    const { run, calls, written } = await scrape(
      feed(item("One", "https://ok.example.org/1"), item("Two", "https://ok.example.org/2"), item("Three", "https://ok.example.org/3"))
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0].u.length, 3);
    assert.equal(written.length, 3);
    assert.equal(run.articlesNew, 3);
    assert.equal(run.articlesDuplicate, 0);
  });

  test("stored urlHash OR titleHash makes a duplicate", async () => {
    const first = await scrape(feed(item("One", "https://ok.example.org/1"), item("Two", "https://ok.example.org/2"), item("Three", "https://ok.example.org/3")));
    const [h1, h2, h3] = first.written;
    // h1 known by url, h2 known by title only; h3 is new.
    const { run, written } = await scrape(
      feed(item("One", "https://ok.example.org/1"), item("Two", "https://ok.example.org/2"), item("Three", "https://ok.example.org/3")),
      () => new Set([h1.urlHash, h2.titleHash])
    );
    assert.equal(run.articlesDuplicate, 2);
    assert.equal(run.articlesNew, 1);
    assert.deepEqual(written.map((w) => w.urlHash), [h3.urlHash]);
  });

  test("an in-batch repeat (same url, or same title) writes ONE article", async () => {
    const { run, written } = await scrape(
      feed(
        item("Same", "https://ok.example.org/x"),
        item("Other title", "https://ok.example.org/x"), // same url
        item("Same", "https://ok.example.org/y"), // same title
        item("Fresh", "https://ok.example.org/z")
      )
    );
    assert.equal(written.length, 2);
    assert.equal(run.articlesNew, 2);
    assert.equal(run.articlesDuplicate, 2);
  });

  test("an all-duplicates run writes nothing and counts every article", async () => {
    const body = feed(item("One", "https://ok.example.org/1"), item("Two", "https://ok.example.org/2"));
    const first = await scrape(body);
    const known = new Set(first.written.map((w) => w.urlHash));
    const { run, written } = await scrape(body, () => known);
    assert.equal(written.length, 0);
    assert.equal(run.articlesNew, 0);
    assert.equal(run.articlesDuplicate, 2);
    assert.equal(run.status, "success");
  });

  test("a normalisation failure counts articlesFailed and does not abort the others", async () => {
    const warn = console.warn;
    console.warn = () => undefined;
    const orig = (mod.NewsScraperService.prototype as any).normalizeArticle;
    (mod.NewsScraperService.prototype as any).normalizeArticle = function (raw: any, src: any) {
      if (raw.title === "Bad") throw new Error("boom");
      return orig.call(this, raw, src);
    };
    try {
      const { run, written } = await scrape(feed(item("Bad", "https://ok.example.org/b"), item("Good", "https://ok.example.org/g")));
      assert.equal(run.articlesFailed, 1);
      assert.equal(run.articlesNew, 1);
      assert.equal(written.length, 1);
    } finally {
      (mod.NewsScraperService.prototype as any).normalizeArticle = orig;
      console.warn = warn;
    }
  });
});

// ============================================
// expireAt
// ============================================

describe("expireAt", () => {
  const created = Timestamp.fromMillis(Date.parse("2026-11-10T12:00:00Z"));

  test("articleExpireAt: normal, future publishedAt, 120-day-old publishedAt", () => {
    const at = (published: Timestamp | undefined) => news.articleExpireAt(published, created).toMillis();
    // Normal: published a day ago -> 90 days from ingest (the later of the two).
    assert.equal(at(Timestamp.fromMillis(created.toMillis() - DAY)), created.toMillis() + 90 * DAY);
    // Future publishedAt: 90 days from that date.
    const future = Timestamp.fromMillis(created.toMillis() + 10 * DAY);
    assert.equal(at(future), future.toMillis() + 90 * DAY);
    // 120 days old: kept 90 days from ingest, not already expired.
    assert.equal(at(Timestamp.fromMillis(created.toMillis() - 120 * DAY)), created.toMillis() + 90 * DAY);
    // Missing publishedAt: from ingest.
    assert.equal(at(undefined), created.toMillis() + 90 * DAY);
  });

  test("createArticlesBatch writes expireAt on every new doc", async () => {
    const published = Timestamp.fromMillis(Date.now() - 120 * DAY);
    await news.newsService.createArticlesBatch([{ title: "a", publishedAt: published } as any, { title: "b", publishedAt: published } as any]);
    const docs = [...fakeStore.entries()].filter(([p]) => p.startsWith("newsArticles/"));
    assert.equal(docs.length, 2);
    for (const [, d] of docs) {
      const createdAt = (d.createdAt as Timestamp).toMillis();
      assert.equal((d.expireAt as Timestamp).toMillis(), createdAt + 90 * DAY);
    }
  });

  test("createScrapeRun writes expireAt = startedAt + 30 days", async () => {
    const id = await news.newsService.createScrapeRun("s1");
    const d = fakeStore.get(`newsSources/s1/scrapeRuns/${id}`) as any;
    assert.equal((d.expireAt as Timestamp).toMillis(), (d.startedAt as Timestamp).toMillis() + 30 * DAY);
  });
});
