// ============================================
// Unit tests — scrape run records + admin read API (issue #81)
// ============================================
//
// Run with `npm test`. NO network and NO emulator: Firestore is the
// in-memory fake (test/helpers/fake-firestore.ts), visa pages come from a
// stubbed adapter, the extractor is stubbed, and the news scraper gets a stub
// HTTP client + stub store.
//
// Covers:
//  - recorder: `running` doc at start (expireAt = +180d), one final write
//    with status / timing / summary / sources / pages; errors capped at
//    MAX_RECORDED_ERRORS and redacted; pages capped with pagesTruncated;
//    fail() -> failed + redacted fatalError; idempotent finalize; a failed
//    start write detaches the recorder (no throw, no writes)
//  - deriveRunStatus; finalize hooks (#82/#83 hook point): called with the
//    final doc, a throwing hook is isolated
//  - stale sweep: running > 1h -> failed, younger / finished runs untouched
//  - visa orchestrator: run doc per crawling tick (none on an idle tick),
//    page outcomes + per-source line, crawlRuns carries runId, a run that
//    throws is recorded failed; the stale sweep runs on idle ticks too
//  - news orchestrator: run doc with per-source lines, createScrapeRun gets
//    the runId, an API key in an error never reaches the run doc
//  - listRuns filters / newest first / cursor pages; getRun ISO dates;
//    source health for visa (active backoffs only, latest page error) + news
//  - controller: 403 for owner / agent / client, 400 validation, 404, shapes
//  - news cleanupOldScrapeRuns no longer touches top-level run records

import { test, describe, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Timestamp } from "firebase-admin/firestore";
import { ROLES, defineAbilitiesFor } from "@durin-tech/authz";
import type { Role } from "@durin-tech/authz";

import { Data, installFakes, resetStore, store, writes } from "./helpers/fake-firestore";

// Admin init needs a project id (utils/firebase derives the bucket from it).
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || "demo-unit-test";

/* eslint-disable @typescript-eslint/no-explicit-any */
let runsMod: any; // services/scrape-run.service
let runs: any; // the scrapeRunService singleton
let crawl: any;
let adapters: any;
let extractMod: any;
let newsMod: any;
let newsSvc: any;
let controller: any;
let firebase: any;

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = Date.parse("2026-11-10T12:00:00Z");

before(async () => {
  await installFakes();
  firebase = await import("../src/utils/firebase");
  runsMod = await import("../src/services/scrape-run.service");
  runs = runsMod.scrapeRunService;
  crawl = (await import("../src/services/visa-catalog-crawl.service")).visaCatalogCrawlService;
  adapters = await import("../src/services/visa-source-adapters");
  extractMod = await import("../src/services/visa-catalog-extract.service");
  newsMod = await import("../src/services/news-scraper.service");
  newsSvc = (await import("../src/services/news.service")).newsService;
  controller = (await import("../src/controllers/scrape-run.controller")).scrapeRunController;
});

beforeEach(() => resetStore());

/** All top-level run docs as [id, data]. */
function runDocs(): [string, Data][] {
  return [...store.entries()]
    .filter(([p]) => p.startsWith("scrapeRuns/") && p.split("/").length === 2)
    .map(([p, d]) => [p.split("/")[1], d]);
}

/** The single run doc (asserts exactly one). */
function onlyRun(): Data {
  const r = runDocs();
  assert.equal(r.length, 1, `expected 1 run doc, got ${r.length}`);
  return r[0][1];
}

/** Run `fn` with console output silenced (results are `any`: the modules are loaded dynamically). */
async function quiet(fn: () => Promise<any>): Promise<any> {
  const orig = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = () => undefined;
  try {
    return await fn();
  } finally {
    Object.assign(console, orig);
  }
}

/** Store a run doc directly (for list / sweep tests). */
function seedRun(id: string, over: Data): void {
  store.set(`scrapeRuns/${id}`, {
    id,
    kind: "visa",
    trigger: "scheduled",
    status: "succeeded",
    startedAt: Timestamp.fromMillis(NOW),
    finishedAt: Timestamp.fromMillis(NOW + 1000),
    durationMs: 1000,
    summary: { errors: 0 },
    sources: [{ sourceId: "GB" }],
    pages: [{ url: "https://x" }],
    errors: [],
    errorCount: 0,
    ...over,
  });
}

// ============================================
// Recorder
// ============================================

describe("ScrapeRunRecorder", () => {
  test("start writes `running` with expireAt = startedAt + 180 days; finalize writes once", async () => {
    const r = await runs.start({ kind: "visa", trigger: "script", startedAtMs: NOW, options: { country: "GB", visa: undefined } });
    const started = onlyRun();
    assert.equal(started.status, "running");
    assert.equal(started.kind, "visa");
    assert.equal(started.trigger, "script");
    assert.equal(started.finishedAt, null);
    assert.equal((started.startedAt as Timestamp).toMillis(), NOW);
    assert.equal((started.expireAt as Timestamp).toMillis(), NOW + 180 * DAY);
    assert.deepEqual(started.options, { country: "GB" }); // undefined knobs dropped

    r.recordPage({ sourceId: "GB", url: "https://a", outcome: "created", visaId: "gb-a" });
    r.recordSource({ sourceId: "GB", name: "United Kingdom", status: "succeeded", pagesAttempted: 1, pagesFetched: 1, errors: 0 });
    const mark = writes.length;
    await r.finalize({ summary: { pagesFetched: 1, errors: 0, fxRefreshed: true }, anySuccess: true });
    const done = onlyRun();
    assert.equal(writes.length - mark, 1, "exactly one final write");
    assert.equal(done.status, "succeeded");
    assert.equal(typeof done.durationMs, "number");
    assert.ok((done.finishedAt as Timestamp).toMillis() >= NOW);
    assert.deepEqual(done.summary, { pagesFetched: 1, errors: 0, fxRefreshed: true });
    assert.equal(done.sourcesAttempted, 1);
    assert.equal(done.pagesAttempted, 1);
    assert.equal((done.pages as any[])[0].visaId, "gb-a");

    // Idempotent: a second finalize / fail writes nothing.
    const mark2 = writes.length;
    await r.finalize({ summary: {}, anySuccess: false });
    await r.fail(new Error("late"));
    assert.equal(writes.length, mark2);
  });

  test("errors: all counted, first 20 stored, secrets redacted; summary.errors wins when larger", async () => {
    const r = await runs.start({ kind: "news", trigger: "scheduled", startedAtMs: NOW });
    for (let i = 0; i < 25; i++) {
      r.recordError({ sourceId: "s1", url: `https://newsdata.io/api/1/news?apikey=SECRET${i}`, error: new Error(`boom apikey=SECRET${i}`) });
    }
    await r.finalize({ summary: { errors: 30 }, anySuccess: true });
    const d = onlyRun();
    assert.equal(d.errorCount, 30);
    assert.equal((d.errors as any[]).length, runsMod.MAX_RECORDED_ERRORS);
    assert.equal(d.status, "partial");
    const blob = JSON.stringify(d.errors);
    assert.ok(!blob.includes("SECRET"), "no key in stored errors");
    assert.ok(blob.includes("apikey=[REDACTED]"));
  });

  test("bearer tokens and DEEPSEEK_API_KEY values are redacted too", async () => {
    const prev = process.env.DEEPSEEK_API_KEY;
    process.env.DEEPSEEK_API_KEY = "sk-deepseek-abcdef";
    try {
      const r = await runs.start({ kind: "visa", trigger: "scheduled", startedAtMs: NOW });
      r.recordError({ error: new Error("401 Authorization: Bearer sk-live-123456 and sk-deepseek-abcdef") });
      await r.finalize({ summary: { errors: 1 }, anySuccess: false });
      const msg = (onlyRun().errors as any[])[0].message as string;
      assert.ok(!msg.includes("sk-live-123456"));
      assert.ok(!msg.includes("sk-deepseek-abcdef"));
    } finally {
      if (prev === undefined) delete process.env.DEEPSEEK_API_KEY;
      else process.env.DEEPSEEK_API_KEY = prev;
    }
  });

  test("pages past MAX_RECORDED_PAGES are counted, not stored, and flagged", async () => {
    const r = await runs.start({ kind: "visa", trigger: "scheduled", startedAtMs: NOW });
    const n = runsMod.MAX_RECORDED_PAGES + 5;
    for (let i = 0; i < n; i++) r.recordPage({ sourceId: "GB", url: `https://p/${i}`, outcome: "unchanged" });
    await r.finalize({ summary: { errors: 0 }, anySuccess: true });
    const d = onlyRun();
    assert.equal(d.pagesAttempted, n);
    assert.equal((d.pages as any[]).length, runsMod.MAX_RECORDED_PAGES);
    assert.equal(d.pagesTruncated, true);
  });

  test("fail() -> failed with a redacted fatalError", async () => {
    const r = await runs.start({ kind: "visa", trigger: "scheduled", startedAtMs: NOW });
    await r.fail(new Error("crash X-Api-Key: abc123"), { pagesFetched: 2 });
    const d = onlyRun();
    assert.equal(d.status, "failed");
    assert.equal(d.fatalError, "crash X-Api-Key: [REDACTED]");
    assert.deepEqual(d.summary, { pagesFetched: 2 });
    assert.equal(d.errorCount, 1);
  });

  test("a failed start write detaches the recorder: no throw, nothing written", async () => {
    const orig = firebase.collections.scrapeRuns;
    firebase.collections.scrapeRuns = {
      doc: () => ({ id: "x1", set: async () => { throw new Error("unavailable"); }, update: async () => { throw new Error("no"); } }),
    };
    try {
      const r = await quiet(() => runs.start({ kind: "visa", trigger: "scheduled", startedAtMs: NOW }));
      assert.equal(r.persisted, false);
      const doc = await r.finalize({ summary: { errors: 0 }, anySuccess: true });
      assert.equal(doc.status, "succeeded"); // still computed for the caller
    } finally {
      firebase.collections.scrapeRuns = orig;
    }
    assert.equal(runDocs().length, 0);
  });

  test("deriveRunStatus", () => {
    assert.equal(runsMod.deriveRunStatus(0, false), "succeeded");
    assert.equal(runsMod.deriveRunStatus(0, true), "succeeded");
    assert.equal(runsMod.deriveRunStatus(2, true), "partial");
    assert.equal(runsMod.deriveRunStatus(2, false), "failed");
  });

  test("finalize hooks get the final doc; a throwing hook is isolated", async () => {
    const seen: any[] = [];
    const off1 = runs.registerFinalizeHook(() => {
      throw new Error("hook broke");
    });
    const off2 = runs.registerFinalizeHook(async (run: any) => void seen.push(run));
    try {
      const r = await runs.start({ kind: "news", trigger: "scheduled", startedAtMs: NOW });
      await quiet(() => r.finalize({ summary: { errors: 0, newArticles: 3 }, anySuccess: true }));
      assert.equal(seen.length, 1);
      assert.equal(seen[0].id, r.id);
      assert.equal(seen[0].status, "succeeded");
      assert.equal(seen[0].summary.newArticles, 3);
    } finally {
      off1();
      off2();
    }
  });
});

// ============================================
// Stale sweep
// ============================================

describe("sweepStaleRuns", () => {
  test("running > 1h -> failed; younger running and finished runs untouched", async () => {
    seedRun("old", { status: "running", startedAt: Timestamp.fromMillis(NOW - 2 * HOUR), finishedAt: null, durationMs: null });
    seedRun("young", { status: "running", startedAt: Timestamp.fromMillis(NOW - 30 * 60 * 1000), finishedAt: null });
    seedRun("done", { status: "succeeded", startedAt: Timestamp.fromMillis(NOW - 5 * HOUR) });
    const swept = await quiet(() => runs.sweepStaleRuns(NOW));
    assert.equal(swept, 1);
    const old = store.get("scrapeRuns/old")!;
    assert.equal(old.status, "failed");
    assert.match(String(old.fatalError), /^stale:/);
    assert.equal((old.finishedAt as Timestamp).toMillis(), NOW);
    assert.equal(old.durationMs, 2 * HOUR);
    assert.equal(store.get("scrapeRuns/young")!.status, "running");
    assert.equal(store.get("scrapeRuns/done")!.status, "succeeded");
  });
});

// ============================================
// Visa orchestrator
// ============================================

describe("visa orchestrator run records", () => {
  const CC = "GB";
  const PAGE_OK = "https://www.gov.uk/skilled-worker-visa";
  const PAGE_BAD = "https://www.gov.uk/broken-visa";

  /** A due GB source (no window) with two pages. */
  function seedSource(): void {
    store.set(`visaSources/${CC}`, {
      countryCode: CC,
      countryName: "United Kingdom",
      status: "active",
      nextCrawlAt: Timestamp.fromMillis(NOW - 1000),
      crawlIntervalHours: 168,
      consecutiveFailures: 0,
      reliabilityScore: 100,
      pages: [
        { url: PAGE_OK, routeName: "Skilled Worker visa", visaId: "gb-skilled-worker" },
        { url: PAGE_BAD, routeName: "Broken visa", visaId: "gb-broken" },
      ],
    });
  }

  /** Stub adapter: PAGE_BAD throws (with a key in the message), others fetch. */
  async function withStubs(fn: () => Promise<any>): Promise<any> {
    const origAdapter = adapters.sourceAdapters["generic-html"];
    const origExtract = extractMod.visaCatalogExtractor.extract;
    adapters.sourceAdapters["generic-html"] = {
      id: "generic-html",
      canHandle: () => true,
      fetch: async (page: { url: string }) => {
        if (page.url === PAGE_BAD) throw new Error("HTTP 500 at https://x/?apikey=TOPSECRET");
        return {
          url: page.url,
          canonicalUrl: page.url,
          sourceProvider: "generic-html",
          withdrawn: false,
          sections: [{ slug: "page", title: "", text: "text" }],
          text: "text",
          contentHash: "h-ok",
        };
      },
    };
    extractMod.visaCatalogExtractor.extract = async () => ({
      name: "Skilled Worker visa",
      description: "Work.",
      category: "work",
      processingTime: "3 weeks",
      processingDaysMin: 15,
      processingDaysMax: 21,
      feeComponents: [],
      validityPeriod: "5 years",
      isExtendable: true,
      eligibilityCriteria: [],
      confidence: 0.9,
      citations: {},
    });
    try {
      return await quiet(fn);
    } finally {
      adapters.sourceAdapters["generic-html"] = origAdapter;
      extractMod.visaCatalogExtractor.extract = origExtract;
    }
  }

  const fetchFxRates = async () => ({ rates: { GBP: 0.8 }, rateDate: "2026-11-09" });

  test("a crawling tick writes one run doc: partial, page outcomes, source line, crawlRuns.runId", async () => {
    seedSource();
    const summary = await withStubs(() => crawl.runOrchestrator({ now: NOW, fetchFxRates }));
    const run = onlyRun();
    const [runId] = runDocs()[0];
    assert.equal(run.kind, "visa");
    assert.equal(run.trigger, "scheduled");
    assert.equal(run.status, "partial"); // one page fetched, one errored
    assert.equal((run.startedAt as Timestamp).toMillis(), NOW);
    assert.deepEqual(run.summary, { ...summary });
    assert.equal(run.errorCount, 1);
    assert.equal(run.pagesAttempted, 2);
    assert.deepEqual(
      (run.pages as any[]).map((p) => [p.url, p.outcome, p.visaId]),
      [
        [PAGE_OK, "created", "gb-skilled-worker"],
        [PAGE_BAD, "error", undefined],
      ]
    );
    assert.ok(!JSON.stringify(run).includes("TOPSECRET"), "page error redacted");
    assert.deepEqual(run.options, { maxSources: 3, maxExtractions: 15 });
    // Per-source line, linked to the crawlRuns log, which links back.
    const src = (run.sources as any[])[0];
    assert.equal(src.sourceId, CC);
    assert.equal(src.status, "partial");
    assert.equal(src.pagesFetched, 1);
    assert.equal(src.errors, 1);
    assert.equal(src.counts.created, 1);
    const crawlRun = store.get(`visaSources/${CC}/crawlRuns/${src.sourceRunId}`)!;
    assert.equal(crawlRun.runId, runId);
  });

  test("trigger is passed through", async () => {
    seedSource();
    await withStubs(() => crawl.runOrchestrator({ now: NOW, fetchFxRates, trigger: "manual" }));
    assert.equal(onlyRun().trigger, "manual");
  });

  test("an idle tick writes no run doc but still sweeps stale runs", async () => {
    seedRun("stuck", { status: "running", startedAt: Timestamp.fromMillis(NOW - 3 * HOUR), finishedAt: null });
    await withStubs(() => crawl.runOrchestrator({ now: NOW, fetchFxRates })); // no sources
    assert.equal(runDocs().length, 1);
    assert.equal(store.get("scrapeRuns/stuck")!.status, "failed");
  });

  test("a run that throws mid-way is recorded failed and the error rethrown", async () => {
    seedSource();
    const origUpdate = firebase.collections.visaSources;
    // The source-health write blows up (e.g. Firestore unavailable).
    firebase.collections.visaSources = {
      ...origUpdate,
      where: (...a: unknown[]) => {
        const q = origUpdate.where(...a);
        return {
          ...q,
          where: (...b: unknown[]) => {
            const q2 = q.where(...b);
            return {
              ...q2,
              orderBy: (...c: unknown[]) => {
                const q3 = q2.orderBy(...c);
                return {
                  async get() {
                    const snap = await q3.get();
                    for (const d of snap.docs) d.ref.update = async () => { throw new Error("write failed"); };
                    return snap;
                  },
                };
              },
            };
          },
        };
      },
    };
    try {
      await assert.rejects(withStubs(() => crawl.runOrchestrator({ now: NOW, fetchFxRates })), /write failed/);
    } finally {
      firebase.collections.visaSources = origUpdate;
    }
    const run = onlyRun();
    assert.equal(run.status, "failed");
    assert.equal(run.fatalError, "write failed");
  });
});

// ============================================
// News orchestrator
// ============================================

describe("news orchestrator run records", () => {
  const FEED_OK = "https://ok.example/feed.xml";
  const API_SOURCE = "api1";
  const rss = `<?xml version="1.0"?><rss version="2.0"><channel><title>t</title>
    <item><title>One</title><link>https://ok.example/1</link><description>d</description></item>
    <item><title>Two</title><link>https://ok.example/2</link><description>d</description></item>
  </channel></rss>`;

  /** Run the news orchestrator over an RSS source and a failing news API source. */
  async function runNews() {
    const createdRuns: { sourceId: string; runId?: string }[] = [];
    const prevKey = process.env.NEWS_API_KEY_NEWSDATA;
    process.env.NEWS_API_KEY_NEWSDATA = "newsdata-secret-999";
    const scraper = new newsMod.NewsScraperService({
      http: {
        async get(url: string) {
          if (url === FEED_OK) return { status: 200, data: rss, headers: {} };
          if (url.startsWith("https://newsdata.io/")) return { status: 500, data: "", headers: {} };
          return { status: 404, data: "", headers: {} };
        },
      },
      store: {
        getDueSources: async () => [
          { id: "rss1", name: "OK feed", strategy: "rss", url: "https://ok.example/", countryCodes: ["GB"], config: { feedUrl: FEED_OK, maxArticlesPerRun: 10, fetchFullContent: false } },
          { id: API_SOURCE, name: "API", strategy: "news_api", url: "https://newsdata.io/", countryCodes: ["GB"], config: { maxArticlesPerRun: 10, fetchFullContent: false, apiConfig: { provider: "newsdata", query: "visa" } } },
        ],
        createScrapeRun: async (sourceId: string, runId?: string) => {
          createdRuns.push({ sourceId, runId });
          return `log-${sourceId}`;
        },
        isDuplicate: async () => false,
        createArticlesBatch: async (a: unknown[]) => a.length,
        updateSourceAfterScrape: async () => undefined,
        completeScrapeRun: async () => undefined,
      },
      minIntervalMs: 0,
      clock: () => NOW,
    });
    try {
      const result = await quiet(() => scraper.runOrchestrator());
      return { result, createdRuns };
    } finally {
      if (prevKey === undefined) delete process.env.NEWS_API_KEY_NEWSDATA;
      else process.env.NEWS_API_KEY_NEWSDATA = prevKey;
    }
  }

  test("one run doc per tick: partial, per-source lines linked to their logs, keys redacted", async () => {
    const { result, createdRuns } = await runNews();
    const run = onlyRun();
    const [runId] = runDocs()[0];
    assert.equal(run.kind, "news");
    assert.equal(run.status, "partial");
    assert.equal(run.errorCount, 1);
    assert.equal(result.articlesFound, 2);
    assert.equal(result.newArticles, 2);
    assert.deepEqual(run.summary, { ...result });
    assert.ok(result.requestsAttempted >= 2);
    assert.equal(run.pagesAttempted, result.requestsAttempted);
    // Each per-source log was created with the run id.
    assert.deepEqual(createdRuns, [
      { sourceId: "rss1", runId },
      { sourceId: API_SOURCE, runId },
    ]);
    const [ok, bad] = run.sources as any[];
    assert.equal(ok.status, "succeeded");
    assert.equal(ok.sourceRunId, "log-rss1");
    assert.equal(ok.counts.articlesNew, 2);
    assert.equal(bad.status, "failed");
    assert.equal(bad.sourceRunId, `log-${API_SOURCE}`);
    assert.ok(!JSON.stringify(run).includes("newsdata-secret-999"), "API key never stored");
  });
});

// ============================================
// Admin reads (service)
// ============================================

describe("listRuns / getRun", () => {
  /** Five runs, one hour apart (newest = r5). */
  function seedFive(): void {
    seedRun("r1", { kind: "visa", status: "succeeded", startedAt: Timestamp.fromMillis(NOW - 4 * HOUR) });
    seedRun("r2", { kind: "news", status: "failed", startedAt: Timestamp.fromMillis(NOW - 3 * HOUR) });
    seedRun("r3", { kind: "visa", status: "partial", startedAt: Timestamp.fromMillis(NOW - 2 * HOUR) });
    seedRun("r4", { kind: "news", status: "succeeded", startedAt: Timestamp.fromMillis(NOW - 1 * HOUR) });
    seedRun("r5", { kind: "visa", status: "succeeded", startedAt: Timestamp.fromMillis(NOW) });
  }

  test("newest first, list items omit pages / sources / errors, ISO dates", async () => {
    seedFive();
    const page = await runs.listRuns({ limit: 25 });
    assert.deepEqual(page.items.map((r: any) => r.id), ["r5", "r4", "r3", "r2", "r1"]);
    assert.equal(page.nextCursor, null);
    const first = page.items[0];
    assert.equal(first.pages, undefined);
    assert.equal(first.sources, undefined);
    assert.equal(first.errors, undefined);
    assert.equal(first.startedAt, new Date(NOW).toISOString());
  });

  test("kind / status / from / to filters", async () => {
    seedFive();
    const ids = async (q: object) => (await runs.listRuns({ limit: 25, ...q })).items.map((r: any) => r.id);
    assert.deepEqual(await ids({ kind: "visa" }), ["r5", "r3", "r1"]);
    assert.deepEqual(await ids({ status: "succeeded" }), ["r5", "r4", "r1"]);
    assert.deepEqual(await ids({ kind: "visa", status: "succeeded" }), ["r5", "r1"]);
    assert.deepEqual(await ids({ fromMs: NOW - 2 * HOUR, toMs: NOW - HOUR }), ["r4", "r3"]);
  });

  test("cursor pages; an unknown cursor throws InvalidCursorError", async () => {
    seedFive();
    const p1 = await runs.listRuns({ limit: 2 });
    assert.deepEqual(p1.items.map((r: any) => r.id), ["r5", "r4"]);
    assert.equal(p1.nextCursor, "r4");
    const p2 = await runs.listRuns({ limit: 2, cursor: p1.nextCursor });
    assert.deepEqual(p2.items.map((r: any) => r.id), ["r3", "r2"]);
    const p3 = await runs.listRuns({ limit: 2, cursor: p2.nextCursor });
    assert.deepEqual(p3.items.map((r: any) => r.id), ["r1"]);
    assert.equal(p3.nextCursor, null);
    await assert.rejects(runs.listRuns({ limit: 2, cursor: "nope" }), runsMod.InvalidCursorError);
  });

  test("getRun returns the full doc with ISO dates (nested too), or null", async () => {
    seedRun("r1", { errors: [{ message: "m", at: Timestamp.fromMillis(NOW) }] });
    const run = await runs.getRun("r1");
    assert.equal(run.id, "r1");
    assert.equal(run.startedAt, new Date(NOW).toISOString());
    assert.equal(run.errors[0].at, new Date(NOW).toISOString());
    assert.deepEqual(run.pages, [{ url: "https://x" }]);
    assert.equal(await runs.getRun("missing"), null);
  });
});

describe("listSourceHealth", () => {
  test("visa: active backoffs only, latest page error, window; news: mapped fields", async () => {
    store.set("visaSources/GB", {
      countryCode: "GB",
      countryName: "United Kingdom",
      status: "active",
      reliabilityScore: 50,
      consecutiveFailures: 2,
      crawlIntervalHours: 168,
      crawlWindow: { timeZone: "Europe/London", dayOfWeek: 1, startHour: 2, endHour: 5 },
      lastCrawledAt: Timestamp.fromMillis(NOW - DAY),
      nextCrawlAt: Timestamp.fromMillis(NOW + 6 * DAY),
      hostBackoffs: [
        { host: "www.gov.uk", until: Timestamp.fromMillis(NOW + HOUR), status: 429, recordedAt: Timestamp.fromMillis(NOW - HOUR) },
        { host: "old.gov.uk", until: Timestamp.fromMillis(NOW - HOUR), status: 503, recordedAt: Timestamp.fromMillis(NOW - 2 * HOUR) },
      ],
      pages: [
        { url: "https://a", routeName: "A", lastError: "older", lastCrawledAt: Timestamp.fromMillis(NOW - 2 * DAY) },
        { url: "https://b", routeName: "B", lastError: "newer", lastCrawledAt: Timestamp.fromMillis(NOW - DAY) },
        { url: "https://c", routeName: "C" },
      ],
    });
    store.set("newsSources/n1", {
      id: "n1",
      name: "Home Office news",
      countryCodes: ["GB"],
      status: "broken",
      reliabilityScore: 66.666,
      consecutiveFailures: 5,
      scrapeIntervalMinutes: 120,
      lastScrapedAt: Timestamp.fromMillis(NOW - HOUR),
      nextScrapeAt: Timestamp.fromMillis(NOW + HOUR),
      lastErrorMessage: "HTTP 500 apikey=abc",
      lastErrorAt: Timestamp.fromMillis(NOW - HOUR),
    });

    const visa = await runs.listSourceHealth("visa", NOW);
    assert.equal(visa.length, 1);
    const gb = visa[0];
    assert.equal(gb.kind, "visa");
    assert.equal(gb.sourceId, "GB");
    assert.equal(gb.reliabilityScore, 50);
    assert.equal(gb.consecutiveFailures, 2);
    assert.equal(gb.nextCrawlAt, new Date(NOW + 6 * DAY).toISOString());
    assert.equal(gb.crawlWindow.timeZone, "Europe/London");
    assert.deepEqual(gb.hostBackoffs, [
      { host: "www.gov.uk", until: new Date(NOW + HOUR).toISOString(), status: 429, recordedAt: new Date(NOW - HOUR).toISOString() },
    ]);
    assert.deepEqual(gb.lastError, { message: "newer", at: new Date(NOW - DAY).toISOString(), url: "https://b" });
    assert.equal(gb.pageCount, 3);
    assert.equal(gb.pagesWithErrors, 2);

    const news = await runs.listSourceHealth("news", NOW);
    assert.equal(news.length, 1);
    assert.equal(news[0].reliabilityScore, 67);
    assert.equal(news[0].intervalHours, 2);
    assert.equal(news[0].crawlWindow, null);
    assert.equal(news[0].lastError.message, "HTTP 500 apikey=[REDACTED]");

    assert.equal((await runs.listSourceHealth(undefined, NOW)).length, 2);
  });
});

// ============================================
// Controller
// ============================================

/** Minimal Express res double. */
function fakeRes() {
  const out: { status: number; body: any } = { status: 0, body: undefined };
  const res = {
    status(code: number) {
      out.status = code;
      return res;
    },
    json(b: unknown) {
      out.body = b;
      return res;
    },
  };
  return { res, out };
}

/** A request with the CASL ability of `role` (as verifyAuth would attach). */
function req(role: Role, over: Data = {}): any {
  const authz = { uid: `${role}-uid`, role, agencyId: role === ROLES.OWNER || role === ROLES.AGENT ? "ag1" : null };
  return { params: {}, query: {}, body: {}, userId: authz.uid, authz, ability: defineAbilitiesFor(authz), ...over };
}

/** Call a controller handler and return the captured response. */
async function call(handler: string, r: any) {
  const { res, out } = fakeRes();
  await quiet(() => controller[handler](r, res));
  return out;
}

describe("scrape-run controller", () => {
  test("owner / agent / client get 403 on every route, before any read", async () => {
    seedRun("r1", {});
    for (const role of [ROLES.OWNER, ROLES.AGENT, ROLES.CLIENT] as Role[]) {
      assert.equal((await call("list", req(role))).status, 403);
      assert.equal((await call("get", req(role, { params: { id: "r1" } }))).status, 403);
      assert.equal((await call("sources", req(role))).status, 403);
    }
  });

  test("admin: list shape with nextCursor; get; 404; sources", async () => {
    seedRun("r1", { startedAt: Timestamp.fromMillis(NOW - HOUR) });
    seedRun("r2", { startedAt: Timestamp.fromMillis(NOW) });
    const list = await call("list", req(ROLES.ADMIN, { query: { limit: "1" } }));
    assert.equal(list.status, 200);
    assert.equal(list.body.success, true);
    assert.deepEqual(list.body.data.items.map((r: any) => r.id), ["r2"]);
    assert.equal(list.body.data.nextCursor, "r2");
    const next = await call("list", req(ROLES.ADMIN, { query: { limit: "1", cursor: "r2" } }));
    assert.deepEqual(next.body.data.items.map((r: any) => r.id), ["r1"]);

    const one = await call("get", req(ROLES.ADMIN, { params: { id: "r1" } }));
    assert.equal(one.status, 200);
    assert.equal(one.body.data.id, "r1");
    assert.equal((await call("get", req(ROLES.ADMIN, { params: { id: "missing" } }))).status, 404);

    const src = await call("sources", req(ROLES.ADMIN, { query: { kind: "news" } }));
    assert.equal(src.status, 200);
    assert.deepEqual(src.body.data, []);
  });

  test("validation: bad kind / status / dates / limit / cursor / repeated param -> 400", async () => {
    const bad = [
      { kind: "jobs" },
      { status: "done" },
      { from: "yesterday" },
      { from: "2026-11-10", to: "2026-11-01" },
      { limit: "0" },
      { limit: "abc" },
      { cursor: "bad/cursor" },
      { cursor: "unknownid" },
      { kind: ["visa", "news"] },
    ];
    for (const query of bad) {
      const out = await call("list", req(ROLES.ADMIN, { query }));
      assert.equal(out.status, 400, JSON.stringify(query));
    }
    assert.equal((await call("sources", req(ROLES.ADMIN, { query: { kind: "x" } }))).status, 400);
    // Valid date forms: ISO and epoch ms.
    assert.equal((await call("list", req(ROLES.ADMIN, { query: { from: "2026-11-01", to: String(NOW) } }))).status, 200);
  });
});

// ============================================
// News cleanup must not delete top-level run records
// ============================================

describe("newsService.cleanupOldScrapeRuns", () => {
  test("deletes old per-source logs only; top-level scrapeRuns are untouched", async () => {
    store.set("newsSources/n1", { id: "n1" });
    store.set("newsSources/n1/scrapeRuns/old", { startedAt: Timestamp.fromMillis(Date.now() - 40 * DAY) });
    store.set("newsSources/n1/scrapeRuns/new", { startedAt: Timestamp.fromMillis(Date.now() - DAY) });
    seedRun("top-old", { startedAt: Timestamp.fromMillis(Date.now() - 40 * DAY) });
    const origBatch = firebase.db.batch;
    const deleted: string[] = [];
    firebase.db.batch = () => ({
      delete: (ref: { path: string }) => void deleted.push(ref.path),
      commit: async () => {
        for (const p of deleted) store.delete(p);
      },
    });
    try {
      assert.equal(await newsSvc.cleanupOldScrapeRuns(30), 1);
    } finally {
      firebase.db.batch = origBatch;
    }
    assert.deepEqual(deleted, ["newsSources/n1/scrapeRuns/old"]);
    assert.ok(store.has("scrapeRuns/top-old"));
    assert.ok(store.has("newsSources/n1/scrapeRuns/new"));
  });
});
