// ============================================
// Unit tests — source auto-pause + failing-source remediation (issue #107)
// ============================================
//
// Hermetic (issue #94): Firestore is the in-memory fake
// (test/helpers/fake-firestore.ts), HTTP goes to stub clients, the visa
// adapter and the LLM extractor are stubbed (the extractor is never reached:
// no LLM call anywhere in this file). Covers:
//  - the pure rules (shared/runs/source-health.ts): limit reached pauses,
//    below the limit does not, success resets + recovers, deferred is a
//    no-op, admin paused / retired untouched, raising the limit never
//    un-pauses, lowering it pauses on the next failure;
//  - the setting: consecutiveFailureLimit default 5, PATCH 1..50 per scraper,
//    400 VALIDATION_ERROR naming the field otherwise;
//  - news: the limit from settings, auto-pause flags + run line health,
//    manual single-source recovery, admin pause kept, missing API key ->
//    paused (no error, run succeeded), key present -> runs, an auto-paused
//    source is not due so a run ends succeeded, per-source timeout;
//  - visa: the same rules through the crawl (limit, flags, recovery, admin
//    pause kept mid-run);
//  - PATCH resetFailures clears the auto-pause (and lifts a missing-key pause);
//  - GET /admin/scrape-sources rows carry the new fields;
//  - seeds: the five sources' remediation, re-seed keeps crawler holds and
//    admin overrides; the dev-data plan (dry-run script).

import { test, describe, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Timestamp } from "firebase-admin/firestore";
import * as fs from "fs";
import { ROLES, defineAbilitiesFor } from "@durin-tech/authz";
import type { Role } from "@durin-tech/authz";

import { Data, installFakes, resetStore, store } from "../../../helpers/fake-firestore";

/* eslint-disable @typescript-eslint/no-explicit-any */

let health: any; // shared/runs/source-health
let newsMod: any; // news/news-scraper.service
let newsHealth: any; // news/news-source-health (singleton service)
let newsService: any; // services/news.service
let crawl: any; // visaCatalogCrawlService
let adapters: any;
let extractMod: any;
let storeMod: any; // settings store
let settingsController: any;
let runsController: any;
let seedNews: any;
let seedVisa: any;
let remediation: any;

const HOUR = 60 * 60 * 1000;
const NOW = Date.parse("2026-11-10T12:00:00Z");
const TS = Timestamp.fromMillis(NOW);
const fetchFxRates = async () => ({ rates: { GBP: 0.8 }, rateDate: "2026-11-09" });
/** LLM calls the stubbed extractor saw (must stay 0). */
let extractCalls = 0;

before(async () => {
  await installFakes();
  health = await import("../../../../src/scrapers/shared/runs/source-health");
  newsMod = await import("../../../../src/scrapers/news/news-scraper.service");
  newsHealth = (await import("../../../../src/scrapers/news/news-source-health")).newsSourceHealthService;
  newsService = (await import("../../../../src/services/news.service")).newsService;
  crawl = (await import("../../../../src/scrapers/visa-catalog/visa-catalog-crawl.service")).visaCatalogCrawlService;
  adapters = await import("../../../../src/scrapers/visa-catalog/adapters");
  extractMod = await import("../../../../src/scrapers/visa-catalog/visa-catalog-extract.service");
  storeMod = await import("../../../../src/scrapers/shared/settings/scraper-settings.store");
  settingsController = (await import("../../../../src/scrapers/shared/settings/scraper-settings.controller")).scraperSettingsController;
  runsController = (await import("../../../../src/scrapers/shared/runs/scrape-run.controller")).scrapeRunController;
  seedNews = await import("../../../../src/scrapers/news/seed-news-sources");
  seedVisa = await import("../../../../src/scrapers/visa-catalog/data/seed-visa-sources");
  remediation = await import("../../../../src/scrapers/shared/scripts/remediate-failing-sources");
  const settingsSvc = (await import("../../../../src/scrapers/shared/settings/scraper-settings.service")).scraperSettingsService;
  settingsSvc.clock = () => NOW;
  // The extractor must never run here (no LLM calls, issue #107 AC).
  extractMod.visaCatalogExtractor.extract = async () => {
    extractCalls++;
    throw new Error("extractor must not be called");
  };
});

beforeEach(() => {
  resetStore();
  extractCalls = 0;
  delete process.env.NEWS_API_KEY_NEWSDATA;
});

// ============================================
// Helpers
// ============================================

/** Run `fn` with console output silenced. */
async function quiet(fn: () => Promise<any>): Promise<any> {
  const orig = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = () => undefined;
  try {
    return await fn();
  } finally {
    Object.assign(console, orig);
  }
}

/** Resolved default settings with per-section patches. */
function settingsWith(patch: any = {}): any {
  const s = storeMod.resolveScraperSettings({}).settings;
  for (const [k, v] of Object.entries(patch)) s[k] = { ...s[k], ...(v as object) };
  return s;
}

/** Minimal Express res double + a call helper for controller handlers. */
async function call(controller: any, handler: string, r: any) {
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
  await quiet(() => controller[handler](r, res));
  return out;
}

/** An admin request (CASL ability attached as verifyAuth would). */
function admin(over: Data = {}): any {
  const authz = { uid: "admin-uid", role: ROLES.ADMIN as Role, agencyId: null };
  return { params: {}, query: {}, body: {}, userId: authz.uid, authz, ability: defineAbilitiesFor(authz), ...over };
}

// ---- News ----

/** Stub HTTP for the news bot: url -> status/body; anything else 404. */
let routes: Map<string, { status: number; body?: string }>;
/** Per-request configs the stub saw (to check the per-source timeout). */
let seenConfigs: { url: string; timeout?: number }[];
const http = {
  async get(url: string, config?: { timeout?: number }) {
    seenConfigs.push({ url, timeout: config?.timeout });
    const r = routes.get(url) ?? { status: 404, body: "" };
    return { status: r.status, data: r.body ?? "", headers: {} };
  },
};

const RSS = `<?xml version="1.0"?><rss version="2.0"><channel><title>t</title>
<item><title>New rule</title><link>https://ok.example.org/a1</link><description>s</description></item>
</channel></rss>`;

/** Seed one news source doc; due now by default. */
function seedNewsSource(id: string, over: Data = {}): void {
  store.set(`newsSources/${id}`, {
    id,
    name: id,
    slug: id,
    url: `https://${id}.example.org/`,
    countryCodes: ["GB"],
    strategy: "rss",
    config: { feedUrl: `https://${id}.example.org/feed.xml`, maxArticlesPerRun: 10, fetchFullContent: false },
    scrapeIntervalMinutes: 120,
    isOfficial: false,
    priority: 1,
    status: "active",
    nextScrapeAt: Timestamp.fromMillis(NOW - HOUR),
    totalRuns: 0,
    successfulRuns: 0,
    consecutiveFailures: 0,
    reliabilityScore: 100,
    ...over,
  });
}

/** A news scraper over the REAL store (fake Firestore), stub HTTP and the given settings. */
function makeNews(settings: any = settingsWith()) {
  const store = {
    getDueSources: (n: number) => newsService.getDueSources(n),
    getSourceById: (id: string) => newsService.getSourceById(id),
    createScrapeRun: (id: string, runId?: string) => newsService.createScrapeRun(id, runId),
    completeScrapeRun: (id: string, runId: string, r: any) => newsService.completeScrapeRun(id, runId, r),
    isDuplicate: async () => false,
    createArticlesBatch: async (a: unknown[]) => a.length,
    updateSourceAfterScrape: newsHealth.updateSourceAfterScrape.bind(newsHealth),
    pauseForMissingApiKey: newsHealth.pauseForMissingApiKey.bind(newsHealth),
  };
  return new newsMod.NewsScraperService({ http, store, minIntervalMs: 0, loadSettings: async () => settings });
}

const newsDoc = (id: string) => store.get(`newsSources/${id}`) as Record<string, any>;

/** The only run doc in the store. */
function lastRun(): Record<string, any> {
  const runs = [...store.entries()].filter(([p]) => /^scrapeRuns\/[^/]+$/.test(p)).map(([, d]) => d as Record<string, any>);
  return runs.sort((a, b) => (a.startedAt?.toMillis?.() ?? 0) - (b.startedAt?.toMillis?.() ?? 0)).at(-1)!;
}

// ---- Visa ----

const CC = "GB";
const PAGE = "https://www.gov.uk/skilled-worker-visa";

/** A GB source with one page, due now, no window (legacy interval). */
function seedGb(over: Data = {}): void {
  store.set(`visaSources/${CC}`, {
    id: CC,
    countryCode: CC,
    countryName: "United Kingdom",
    status: "active",
    nextCrawlAt: Timestamp.fromMillis(NOW - HOUR),
    crawlIntervalHours: 168,
    consecutiveFailures: 0,
    reliabilityScore: 100,
    pages: [{ url: PAGE, routeName: "Skilled Worker visa", visaId: "gb-skilled-worker", lastContentHash: "h-same" }],
    ...over,
  });
}

/**
 * Run the visa crawl with the generic-html adapter stubbed: it fails with
 * `fail` (a string) or returns the page with an UNCHANGED hash (hash gate:
 * no extraction, so no LLM call). `beforeWrite` runs inside the adapter
 * (i.e. mid-crawl, before the health write).
 */
async function runVisa(opts: { fail?: string; settings?: any; sourceId?: string; beforeWrite?: () => void } = {}) {
  const orig = adapters.sourceAdapters["generic-html"];
  adapters.sourceAdapters["generic-html"] = {
    id: "generic-html",
    canHandle: () => true,
    fetch: async (page: { url: string }) => {
      opts.beforeWrite?.();
      if (opts.fail) throw new Error(opts.fail);
      return {
        url: page.url,
        canonicalUrl: page.url,
        sourceProvider: "generic-html",
        withdrawn: false,
        sections: [{ slug: "page", title: "", text: "text" }],
        text: "text",
        contentHash: "h-same",
      };
    },
  };
  try {
    return await quiet(() =>
      crawl.runOrchestrator({
        now: NOW,
        fetchFxRates,
        settings: opts.settings ?? settingsWith(),
        trigger: opts.sourceId ? "manual" : "scheduled",
        sourceId: opts.sourceId,
      })
    );
  } finally {
    adapters.sourceAdapters["generic-html"] = orig;
  }
}

const gbDoc = () => store.get(`visaSources/${CC}`) as Record<string, any>;

// ============================================
// Pure rules
// ============================================

describe("nextSourceHealth (pure rules)", () => {
  const ctx = (limit: number, errorMessage = "HTTP 500") => ({ limit, errorMessage, now: TS });

  test("below the limit: counted, still active; at the limit: broken + flags", () => {
    const below = health.nextSourceHealth({ status: "active", consecutiveFailures: 3 }, "failure", ctx(5));
    assert.equal(below.status, "active");
    assert.equal(below.consecutiveFailures, 4);
    assert.equal(below.autoPause, undefined);
    const at = health.nextSourceHealth({ status: "active", consecutiveFailures: 4 }, "failure", ctx(5));
    assert.equal(at.status, "broken");
    assert.equal(at.consecutiveFailures, 5);
    assert.equal(at.newlyAutoPaused, true);
    assert.deepEqual(at.autoPause, { autoPaused: true, autoPausedAt: TS, autoPausedReason: "HTTP 500", autoPauseCause: "failure_limit" });
  });

  test("success resets the streak and recovers an auto-paused source", () => {
    const ok = health.nextSourceHealth({ status: "active", consecutiveFailures: 3 }, "success", ctx(5));
    assert.deepEqual([ok.status, ok.consecutiveFailures, ok.autoPause], ["active", 0, undefined]);
    const rec = health.nextSourceHealth({ status: "broken", consecutiveFailures: 7, autoPaused: true }, "success", ctx(5));
    assert.equal(rec.status, "active");
    assert.equal(rec.consecutiveFailures, 0);
    assert.deepEqual(rec.autoPause, health.clearedAutoPause());
  });

  test("deferred changes nothing", () => {
    const d = health.nextSourceHealth({ status: "active", consecutiveFailures: 4 }, "deferred", ctx(1));
    assert.deepEqual([d.status, d.consecutiveFailures, d.autoPause], ["active", 4, undefined]);
  });

  test("admin paused / retired: status never changed by any outcome", () => {
    for (const status of ["paused", "retired"]) {
      for (const outcome of ["failure", "success"]) {
        const h = health.nextSourceHealth({ status, consecutiveFailures: 10 }, outcome, ctx(1));
        assert.equal(h.status, status, `${status} after ${outcome}`);
        assert.equal(h.autoPause, undefined);
        assert.equal(h.newlyAutoPaused, false);
      }
    }
  });

  test("lowering the limit pauses on the next failure; raising it never un-pauses", () => {
    // Streak 3, limit lowered to 2: the next failure (4) pauses it.
    assert.equal(health.nextSourceHealth({ status: "active", consecutiveFailures: 3 }, "failure", ctx(2)).status, "broken");
    // Broken at 5, limit raised to 20: a failed manual retry keeps it broken.
    const raised = health.nextSourceHealth(
      { status: "broken", consecutiveFailures: 5, autoPaused: true, autoPausedAt: Timestamp.fromMillis(NOW - HOUR) },
      "failure",
      ctx(20)
    );
    assert.equal(raised.status, "broken");
    assert.equal(raised.consecutiveFailures, 6);
    // The first auto-pause instant is kept at the limit too.
    const again = health.nextSourceHealth(
      { status: "broken", consecutiveFailures: 5, autoPaused: true, autoPausedAt: Timestamp.fromMillis(NOW - HOUR) },
      "failure",
      ctx(5)
    );
    assert.equal(again.autoPause.autoPausedAt.toMillis(), NOW - HOUR);
    assert.equal(again.newlyAutoPaused, false);
  });

  test("a bad limit falls back to the default 5", () => {
    assert.equal(health.effectiveFailureLimit(0), 5);
    assert.equal(health.effectiveFailureLimit(2.5), 5);
    assert.equal(health.effectiveFailureLimit(3), 3);
  });
});

// ============================================
// The setting
// ============================================

describe("consecutiveFailureLimit setting", () => {
  test("GET shows 5 for both scrapers by default", async () => {
    const out = await call(settingsController, "get", admin());
    assert.equal(out.status, 200);
    assert.equal(out.body.data.visa.consecutiveFailureLimit, 5);
    assert.equal(out.body.data.news.consecutiveFailureLimit, 5);
  });

  test("PATCH stores a value per scraper; out of range is 400 naming the field", async () => {
    let out = await call(settingsController, "patch", admin({ body: { news: { consecutiveFailureLimit: 2 } } }));
    assert.equal(out.status, 200);
    assert.equal(out.body.data.news.consecutiveFailureLimit, 2);
    assert.equal(out.body.data.visa.consecutiveFailureLimit, 5, "per scraper: visa unchanged");
    assert.equal((store.get("appConfig/scraperSettings") as any).news.consecutiveFailureLimit, 2);
    for (const bad of [0, 51, 2.5, "3", null]) {
      out = await call(settingsController, "patch", admin({ body: { visa: { consecutiveFailureLimit: bad } } }));
      assert.equal(out.status, 400, `value ${JSON.stringify(bad)}`);
      assert.equal(out.body.error, "VALIDATION_ERROR");
      assert.equal(out.body.field, "visa.consecutiveFailureLimit");
    }
    out = await call(settingsController, "patch", admin({ body: { visa: { consecutiveFailureLimit: 50 } } }));
    assert.equal(out.status, 200);
    out = await call(settingsController, "patch", admin({ body: { visa: { consecutiveFailureLimit: 1 } } }));
    assert.equal(out.status, 200);
  });
});

// ============================================
// News scraper
// ============================================

describe("news: auto-pause at news.consecutiveFailureLimit", () => {
  beforeEach(() => {
    routes = new Map();
    seenConfigs = [];
  });

  test("limit 2: paused on the 2nd failure with flags; the run line shows streak + limit", async () => {
    seedNewsSource("bad");
    routes.set("https://bad.example.org/feed.xml", { status: 500 });
    const settings = settingsWith({ news: { consecutiveFailureLimit: 2 } });
    await quiet(() => makeNews(settings).runOrchestrator());
    assert.equal(newsDoc("bad").status, "active");
    assert.equal(newsDoc("bad").consecutiveFailures, 1);
    let line = lastRun().sources[0];
    assert.deepEqual(line.health, { consecutiveFailures: 1, consecutiveFailureLimit: 2, autoPaused: false, autoPausedThisRun: false });

    // Due again (the run moved nextScrapeAt forward).
    store.set("newsSources/bad", { ...newsDoc("bad"), nextScrapeAt: Timestamp.fromMillis(NOW - HOUR) });
    const result = await quiet(() => makeNews(settings).runOrchestrator());
    const d = newsDoc("bad");
    assert.equal(d.status, "broken");
    assert.equal(d.consecutiveFailures, 2);
    assert.equal(d.autoPaused, true);
    assert.equal(d.autoPauseCause, "failure_limit");
    assert.match(d.autoPausedReason, /HTTP 500/);
    assert.ok(d.autoPausedAt);
    assert.equal(result.sourcesAutoPaused, 1);
    line = lastRun().sources[0];
    assert.deepEqual(line.health, { consecutiveFailures: 2, consecutiveFailureLimit: 2, autoPaused: true, autoPausedThisRun: true });
    // A failure below/at the limit still marks the run (only source failed -> failed).
    assert.equal(lastRun().status, "failed");
  });

  test("an auto-paused source is not due: the next scheduled run skips it and ends succeeded", async () => {
    seedNewsSource("dead", { status: "broken", autoPaused: true, consecutiveFailures: 5 });
    seedNewsSource("good");
    routes.set("https://good.example.org/feed.xml", { status: 200, body: RSS });
    await quiet(() => makeNews().runOrchestrator());
    const run = lastRun();
    assert.equal(run.status, "succeeded");
    assert.deepEqual(run.sources.map((s: any) => s.sourceId), ["good"]);
    assert.equal(run.errorCount, 0);
    assert.ok(!seenConfigs.some((c) => c.url.includes("dead.example.org")), "the dead source was not requested");
  });

  test("manual single-source run on an auto-paused source: success -> active, streak 0, flags cleared", async () => {
    seedNewsSource("back", {
      status: "broken",
      consecutiveFailures: 5,
      autoPaused: true,
      autoPausedAt: TS,
      autoPausedReason: "HTTP 500",
      autoPauseCause: "failure_limit",
    });
    routes.set("https://back.example.org/feed.xml", { status: 200, body: RSS });
    await quiet(() => makeNews().runOrchestrator({ trigger: "manual", sourceId: "back" }));
    const d = newsDoc("back");
    assert.equal(d.status, "active");
    assert.equal(d.consecutiveFailures, 0);
    assert.equal(d.autoPaused, false);
    assert.equal(d.autoPausedReason, null);
    assert.equal(lastRun().status, "succeeded");
  });

  test("an admin pause that lands mid-crawl is kept (the failure is counted, status untouched)", async () => {
    seedNewsSource("adm", { consecutiveFailures: 4 });
    // The feed request flips the doc to an admin pause before the health write.
    routes.set("https://adm.example.org/feed.xml", { status: 500 });
    const origGet = http.get;
    http.get = async (url: string, config?: any) => {
      if (url.endsWith("/feed.xml")) {
        store.set("newsSources/adm", { ...newsDoc("adm"), status: "paused", adminOverrides: { status: "paused", reason: "x" } });
      }
      return origGet(url, config);
    };
    try {
      await quiet(() => makeNews().runOrchestrator());
    } finally {
      http.get = origGet;
    }
    const d = newsDoc("adm");
    assert.equal(d.status, "paused", "never un-paused / re-labelled by the crawler");
    assert.equal(d.consecutiveFailures, 5);
    assert.notEqual(d.autoPaused, true);
  });

  test("missing NewsData key: paused 'missing API key', no request, no error, run succeeded", async () => {
    seedNewsSource("newsdata-immigration", {
      strategy: "news_api",
      config: { apiConfig: { provider: "newsdata", query: "visa" }, maxArticlesPerRun: 10, fetchFullContent: false },
    });
    const result = await quiet(() => makeNews().runOrchestrator());
    const d = newsDoc("newsdata-immigration");
    assert.equal(d.status, "paused");
    assert.equal(d.autoPaused, true);
    assert.equal(d.autoPauseCause, "missing_api_key");
    assert.match(d.autoPausedReason, /^missing API key/);
    assert.equal(d.consecutiveFailures, 0, "not a failure");
    assert.equal(result.errors, 0);
    assert.equal(result.sourcesPaused, 1);
    assert.equal(seenConfigs.length, 0, "no request made");
    const run = lastRun();
    assert.equal(run.status, "succeeded");
    assert.equal(run.errorCount, 0);
    assert.equal(run.sources[0].status, "deferred");
    assert.ok(!JSON.stringify(run).includes("Missing API key for provider"));
  });

  test("NewsData key present: the source runs normally", async () => {
    process.env.NEWS_API_KEY_NEWSDATA = "test-key";
    seedNewsSource("newsdata-immigration", {
      strategy: "news_api",
      config: { apiConfig: { provider: "newsdata", query: "visa" }, maxArticlesPerRun: 10, fetchFullContent: false },
    });
    const orig = http.get;
    http.get = async (url: string, config?: any) => {
      if (url.startsWith("https://newsdata.io/api/1/news")) {
        seenConfigs.push({ url });
        return { status: 200, data: JSON.stringify({ results: [{ title: "T", link: "https://n.example.org/1" }] }), headers: {} };
      }
      return orig(url, config);
    };
    try {
      await quiet(() => makeNews().runOrchestrator());
    } finally {
      http.get = orig;
    }
    assert.equal(newsDoc("newsdata-immigration").status, "active");
    assert.equal(newsDoc("newsdata-immigration").successfulRuns, 1);
    assert.equal(lastRun().status, "succeeded");
  });

  test("per-source requestTimeoutMs reaches the HTTP client (clamped to 60s); default otherwise", async () => {
    seedNewsSource("slow", {
      config: { feedUrl: "https://slow.example.org/feed.xml", maxArticlesPerRun: 10, fetchFullContent: false, requestTimeoutMs: 30_000 },
    });
    seedNewsSource("plain");
    routes.set("https://slow.example.org/feed.xml", { status: 200, body: RSS });
    routes.set("https://plain.example.org/feed.xml", { status: 200, body: RSS });
    await quiet(() => makeNews().runOrchestrator());
    assert.equal(seenConfigs.find((c) => c.url === "https://slow.example.org/feed.xml")?.timeout, 30_000);
    assert.equal(seenConfigs.find((c) => c.url === "https://plain.example.org/feed.xml")?.timeout, undefined);
    assert.equal(newsMod.sourceTimeoutMs({ config: { requestTimeoutMs: 999_999 } }), 60_000);
    assert.equal(newsMod.sourceTimeoutMs({ config: {} }), undefined);
  });
});

// ============================================
// Visa crawler
// ============================================

describe("visa: auto-pause at visa.consecutiveFailureLimit", () => {
  test("limit reached -> broken + flags + summary; below -> active", async () => {
    seedGb({ consecutiveFailures: 1 });
    const settings = settingsWith({ visa: { consecutiveFailureLimit: 3 } });
    await runVisa({ fail: "HTTP 404", settings });
    assert.equal(gbDoc().status, "active");
    assert.equal(gbDoc().consecutiveFailures, 2);
    store.set(`visaSources/${CC}`, { ...gbDoc(), nextCrawlAt: Timestamp.fromMillis(NOW - HOUR) });
    const summary = await runVisa({ fail: "HTTP 404", settings });
    const d = gbDoc();
    assert.equal(d.status, "broken");
    assert.equal(d.consecutiveFailures, 3);
    assert.equal(d.autoPaused, true);
    assert.equal(d.autoPauseCause, "failure_limit");
    assert.match(d.autoPausedReason, /HTTP 404/);
    assert.equal(summary.sourcesAutoPaused, 1);
    const line = lastRun().sources[0];
    assert.deepEqual(line.health, { consecutiveFailures: 3, consecutiveFailureLimit: 3, autoPaused: true, autoPausedThisRun: true });
    assert.equal(extractCalls, 0);
  });

  test("a broken source is not due; a manual run that succeeds makes it active again", async () => {
    seedGb({ status: "broken", consecutiveFailures: 5, autoPaused: true, autoPausedAt: TS, autoPausedReason: "x", autoPauseCause: "failure_limit" });
    const idle = await runVisa();
    assert.equal(idle.sourcesProcessed, 0, "scheduled tick skips it");
    await runVisa({ sourceId: CC });
    const d = gbDoc();
    assert.equal(d.status, "active");
    assert.equal(d.consecutiveFailures, 0);
    assert.equal(d.autoPaused, false);
    assert.equal(lastRun().status, "succeeded");
    assert.equal(extractCalls, 0);
  });

  test("an admin pause made mid-crawl is kept by the health write", async () => {
    seedGb({ consecutiveFailures: 4 });
    await runVisa({
      fail: "HTTP 500",
      beforeWrite: () => store.set(`visaSources/${CC}`, { ...gbDoc(), status: "paused", adminOverrides: { status: "paused", reason: "x" } }),
    });
    assert.equal(gbDoc().status, "paused");
    assert.equal(gbDoc().consecutiveFailures, 5);
    assert.notEqual(gbDoc().autoPaused, true);
  });
});

// ============================================
// Admin reset + health rows
// ============================================

describe("PATCH resetFailures + GET /admin/scrape-sources rows", () => {
  test("resetFailures on an auto-paused source: active, 0, flags cleared", async () => {
    seedGb({ status: "broken", consecutiveFailures: 6, autoPaused: true, autoPausedAt: TS, autoPausedReason: "HTTP 404", autoPauseCause: "failure_limit" });
    const out = await call(settingsController, "patchSource", admin({ params: { kind: "visa", id: CC }, body: { resetFailures: true } }));
    assert.equal(out.status, 200);
    const d = gbDoc();
    assert.deepEqual(
      [d.status, d.consecutiveFailures, d.autoPaused, d.autoPausedAt, d.autoPausedReason, d.autoPauseCause],
      ["active", 0, false, null, null, null]
    );
    assert.equal(out.body.data.autoPaused, false);
  });

  test("resetFailures lifts a missing-key pause but never an admin pause", async () => {
    seedNewsSource("nd", { status: "paused", autoPaused: true, autoPauseCause: "missing_api_key", autoPausedReason: "missing API key" });
    seedNewsSource("adm", { status: "paused", consecutiveFailures: 3, adminOverrides: { status: "paused", reason: "mine" } });
    await call(settingsController, "patchSource", admin({ params: { kind: "news", id: "nd" }, body: { resetFailures: true } }));
    await call(settingsController, "patchSource", admin({ params: { kind: "news", id: "adm" }, body: { resetFailures: true } }));
    assert.equal(newsDoc("nd").status, "active");
    assert.equal(newsDoc("nd").autoPaused, false);
    assert.equal(newsDoc("adm").status, "paused");
    assert.equal(newsDoc("adm").consecutiveFailures, 0);
  });

  test("rows carry autoPaused, reason, cause, limit in force and the failure count (both kinds)", async () => {
    store.set("appConfig/scraperSettings", { visa: { consecutiveFailureLimit: 3 }, news: { consecutiveFailureLimit: 7 } });
    seedGb({ status: "broken", consecutiveFailures: 3, autoPaused: true, autoPausedAt: TS, autoPausedReason: "HTTP 404", autoPauseCause: "failure_limit" });
    seedNewsSource("au-home-affairs", { status: "paused", statusReason: "blocked" });
    const out = await call(runsController, "sources", admin({ query: {} }));
    assert.equal(out.status, 200);
    const visa = out.body.data.find((r: any) => r.kind === "visa");
    assert.equal(visa.autoPaused, true);
    assert.equal(visa.autoPausedReason, "HTTP 404");
    assert.equal(visa.autoPauseCause, "failure_limit");
    assert.equal(visa.autoPausedAt, new Date(NOW).toISOString());
    assert.equal(visa.consecutiveFailures, 3);
    assert.equal(visa.consecutiveFailureLimit, 3);
    const news = out.body.data.find((r: any) => r.kind === "news");
    assert.equal(news.autoPaused, false, "registry / admin pause is not an auto-pause");
    assert.equal(news.statusReason, "blocked");
    assert.equal(news.consecutiveFailureLimit, 7);
    // Existing fields still present (additive change).
    for (const key of ["status", "reliabilityScore", "lastError", "adminOverrides", "hostBackoffs"]) assert.ok(key in visa, key);
  });
});

// ============================================
// Seeds + the dev-data fix
// ============================================

describe("remediation: seeds and the dev-data plan", () => {
  const seedOf = (slug: string) => seedNews.NEWS_SOURCES.find((s: any) => s.slug === slug);

  test("news seed: au-home-affairs paused, visa-reporter retired (with reasons), cic-news 30s, newsdata active", () => {
    assert.equal(seedOf("au-home-affairs").status, "paused");
    assert.match(seedOf("au-home-affairs").statusReason, /403/);
    assert.equal(seedOf("visa-reporter").status, "retired");
    assert.match(seedOf("visa-reporter").statusReason, /domain does not resolve/);
    assert.equal(seedOf("cic-news").config.requestTimeoutMs, 30_000);
    assert.equal(seedOf("newsdata-immigration").status, "active");
    for (const s of seedNews.NEWS_SOURCES) {
      if (s.status === "paused" || s.status === "retired") assert.ok(s.statusReason, `${s.slug} needs a reason`);
    }
  });

  test("news re-seed keeps crawler health + holds, admin overrides; registry pause wins over a crawler hold", () => {
    const now = TS;
    const broken = { status: "broken", consecutiveFailures: 6, totalRuns: 9, successfulRuns: 3, autoPaused: true };
    const doc = seedNews.buildSeededNewsSource(seedOf("cic-news"), broken, now);
    assert.equal(doc.status, "broken");
    assert.equal(doc.consecutiveFailures, undefined, "streak not overwritten (merge keeps it)");
    assert.equal(doc.totalRuns, undefined);
    const admin = seedNews.buildSeededNewsSource(seedOf("au-home-affairs"), { status: "active", adminOverrides: { status: "active" } }, now);
    assert.equal(admin.status, "active", "admin override wins over the registry pause");
    const reg = seedNews.buildSeededNewsSource(seedOf("visa-reporter"), broken, now);
    assert.equal(reg.status, "retired");
    assert.equal(reg.autoPaused, false, "registry retire drops the crawler flags");
    const fresh = seedNews.buildSeededNewsSource(seedOf("cic-news"), undefined, now);
    assert.equal(fresh.consecutiveFailures, 0);
    assert.equal(fresh.statusReason, undefined);
  });

  test("HK registry: the 404 page is replaced by TPStream.html, pinned to the old record id", () => {
    const md = fs.readFileSync(seedVisa.vendoredVisaSourcesMarkdownPath(), "utf8");
    assert.ok(!md.includes("tech-professionals-stream.html |"), "old URL row gone");
    const hk = seedVisa.parseVisaSourcesMarkdown(md).find((c: any) => c.countryCode === "HK");
    assert.ok(hk.pages.some((p: any) => p.url === seedVisa.HK_TP_STREAM_URL));
    assert.equal(seedVisa.VISA_SOURCE_OVERRIDES[seedVisa.HK_TP_STREAM_URL].visaId, seedVisa.HK_TP_STREAM_VISA_ID);
  });

  test("visa re-seed keeps the auto-pause flags as crawl state", () => {
    const md = fs.readFileSync(seedVisa.vendoredVisaSourcesMarkdownPath(), "utf8");
    const hk = seedVisa.parseVisaSourcesMarkdown(md).find((c: any) => c.countryCode === "HK");
    const { doc } = seedVisa.buildSeededVisaSource({
      country: hk,
      existing: { status: "broken", consecutiveFailures: 5, autoPaused: true, autoPausedReason: "HTTP 404", autoPauseCause: "failure_limit", pages: [] },
      now: TS,
    });
    assert.equal(doc.status, "broken");
    assert.equal(doc.autoPaused, true);
    assert.equal(doc.autoPausedReason, "HTTP 404");
  });

  test("dev-data plan: the five sources, admin overrides respected, idempotent", () => {
    const md = fs.readFileSync(seedVisa.vendoredVisaSourcesMarkdownPath(), "utf8");
    const existing = new Map<string, Record<string, unknown>>();
    const base = (slug: string, over: Data = {}) => ({ ...seedOf(slug), id: slug, status: "active", consecutiveFailures: 9, totalRuns: 20, successfulRuns: 2, ...over });
    existing.set("newsSources/au-home-affairs", base("au-home-affairs", { status: "broken", url: "https://immi.homeaffairs.gov.au/news-media/archive" }));
    existing.set("newsSources/visa-reporter", base("visa-reporter"));
    existing.set("newsSources/cic-news", base("cic-news", { status: "broken", autoPaused: true, config: { feedUrl: "https://www.cicnews.com/feed", maxArticlesPerRun: 20, fetchFullContent: false } }));
    // An admin already decided about newsdata: no reset.
    existing.set("newsSources/newsdata-immigration", base("newsdata-immigration", { status: "paused", adminOverrides: { status: "paused", reason: "no key yet" } }));
    existing.set("visaSources/HK", {
      countryCode: "HK",
      countryName: "Hong Kong",
      status: "active",
      consecutiveFailures: 0,
      pages: [{ url: "https://www.immd.gov.hk/eng/services/visas/tech-professionals-stream.html", routeName: "TP", lastError: "HTTP 404" }],
    });
    const { writes } = remediation.planRemediation(existing, md, TS);
    const by = Object.fromEntries(writes.map((w: any) => [w.path, w]));
    assert.equal(by["newsSources/au-home-affairs"].doc.status, "paused");
    assert.match(by["newsSources/au-home-affairs"].doc.statusReason, /403/);
    assert.equal(by["newsSources/visa-reporter"].doc.status, "retired");
    const cic = by["newsSources/cic-news"].doc;
    assert.equal(cic.config.requestTimeoutMs, 30_000);
    assert.deepEqual([cic.status, cic.consecutiveFailures, cic.autoPaused], ["active", 0, false]);
    const nd = by["newsSources/newsdata-immigration"]?.doc;
    assert.ok(!nd || (nd.status === "paused" && nd.consecutiveFailures === undefined), "admin pause kept, no reset");
    const hk = by["visaSources/HK"];
    assert.equal(hk.merge, false);
    const urls = hk.doc.pages.map((p: any) => p.url);
    assert.ok(urls.includes(seedVisa.HK_TP_STREAM_URL));
    assert.ok(!urls.includes("https://www.immd.gov.hk/eng/services/visas/tech-professionals-stream.html"));
    assert.ok(hk.changes.some((c: string) => c.startsWith("pages: + https://www.immd.gov.hk/eng/services/visas/TPStream.html")));
    // Nothing is written by the plan itself (pure).
    assert.equal(store.size, 0);
  });
});
