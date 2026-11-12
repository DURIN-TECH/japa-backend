// ============================================
// Tests — news source config edit, articlesLast7d, zero-yield (issue #17)
// ============================================
//
// Hermetic: Firestore is the in-memory fake (test/helpers/fake-firestore).
// Covers:
//  - PATCH /admin/scrape-sources/news/:id (controller): 403 / 404 / 400 per
//    field, one success per new key, merged selectors, preserved fields and
//    health counters, audit history diff, no-op writes nothing, news row
//    shape (`newsConfig`, `articlesLast7d`, zero-yield fields);
//  - the seeder keeping `adminOverrides.config` on re-seed;
//  - articlesLast7d: count over the 7-day window, 0 for none, null on failure;
//  - zero-yield streak counters and `evaluateNoYieldSources`;
//  - `resolveConfig` for `thresholds.zeroYieldRuns`;
//  - the legacy /news/admin routes (sources removed, runs behind CASL).

import { test, describe, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Timestamp } from "firebase-admin/firestore";
import { ROLES, defineAbilitiesFor } from "@durin-tech/authz";
import type { Role } from "@durin-tech/authz";

import { Data, installFakes, resetStore, store, writes } from "../../helpers/fake-firestore";

/* eslint-disable @typescript-eslint/no-explicit-any */
let controller: any;
let health: any;
let seedNews: any;
let rules: any;
let runsSvc: any;
let newsController: any;
let newsRoutes: any;

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-11-10T12:00:00Z");

before(async () => {
  await installFakes();
  const firebase: any = await import("../../../src/utils/firebase");
  const { fakeCollection } = await import("../../helpers/fake-firestore");
  firebase.collections.newsArticles = fakeCollection("newsArticles");
  controller = (await import("../../../src/scrapers/shared/settings/scraper-settings.controller")).scraperSettingsController;
  const svc = (await import("../../../src/scrapers/shared/settings/scraper-settings.service")).scraperSettingsService;
  svc.clock = () => NOW;
  health = (await import("../../../src/scrapers/news/news-source-health")).newsSourceHealthService;
  const { fakeRunTransaction } = await import("../../helpers/fake-firestore");
  health.runTransaction = fakeRunTransaction;
  seedNews = await import("../../../src/scrapers/news/seed-news-sources");
  rules = await import("../../../src/scrapers/shared/alerts/scrape-alert-rules");
  runsSvc = (await import("../../../src/scrapers/shared/runs/scrape-run.service")).scrapeRunService;
  newsController = (await import("../../../src/controllers/news.controller")).newsController;
  newsRoutes = (await import("../../../src/routes/news.routes")).newsRoutes;
});

beforeEach(() => resetStore());

// ----- helpers -----

async function quiet<T>(fn: () => Promise<T>): Promise<T> {
  const orig = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = () => undefined;
  try {
    return await fn();
  } finally {
    Object.assign(console, orig);
  }
}

function fakeRes() {
  const out: { status: number; body: any } = { status: 0, body: undefined };
  const res: any = {
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

function req(role: Role, over: Data = {}): any {
  const authz = { uid: `${role}-uid`, role, agencyId: role === ROLES.OWNER || role === ROLES.AGENT ? "ag1" : null };
  return { params: {}, query: {}, body: {}, userId: authz.uid, authz, ability: defineAbilitiesFor(authz), ...over };
}

async function callOn(target: any, handler: string, r: any) {
  const { res, out } = fakeRes();
  await quiet(() => target[handler](r, res));
  return out;
}
const call = (handler: string, r: any) => callOn(controller, handler, r);
const admin = (over: Data = {}) => req(ROLES.ADMIN as Role, over);

/** An RSS / html / api source doc with health counters, customHeaders and apiConfig to prove they are untouched. */
function seedSource(id: string, strategy: "rss" | "html_scrape" | "news_api", over: Data = {}): void {
  const config: Data =
    strategy === "rss"
      ? { feedUrl: "https://news.example.org/feed", maxArticlesPerRun: 15, fetchFullContent: true, customHeaders: { Accept: "x" }, requestTimeoutMs: 20000 }
      : strategy === "html_scrape"
        ? {
          selectors: { articleList: ".list", articleLink: "a", articleTitle: "h2", articleDate: "time" },
          maxArticlesPerRun: 10,
          fetchFullContent: false,
          customHeaders: { Accept: "y" },
        }
        : { apiConfig: { provider: "newsdata", query: "visa" }, maxArticlesPerRun: 20, fetchFullContent: false };
  store.set(`newsSources/${id}`, {
    id,
    name: `Name ${id}`,
    slug: id,
    url: "https://news.example.org/",
    countryCodes: ["GB"],
    strategy,
    config,
    scrapeIntervalMinutes: 120,
    priority: 2,
    status: "active",
    isOfficial: false,
    reliabilityScore: 87.5,
    totalRuns: 8,
    successfulRuns: 7,
    consecutiveFailures: 1,
    ...over,
  });
}
const doc = (id: string) => store.get(`newsSources/${id}`) as Record<string, any>;
const patch = (id: string, body: any, who = admin()) => call("patchSource", { ...who, params: { kind: "news", id }, body });

// ============================================
// PATCH: authorization + validation
// ============================================

describe("PATCH /admin/scrape-sources/news/:id: gate and 400s", () => {
  test("non-admins get 403 and nothing is written (401 is verifyAuth's, before the controller)", async () => {
    seedSource("s1", "rss");
    for (const role of [ROLES.OWNER, ROLES.AGENT, ROLES.CLIENT] as Role[]) {
      const out = await patch("s1", { priority: 5 }, req(role));
      assert.equal(out.status, 403, role);
    }
    // No principal at all: refused too.
    assert.equal((await call("patchSource", { params: { kind: "news", id: "s1" }, body: { priority: 5 } })).status, 403);
    assert.equal(writes.length, 0);
    assert.equal(doc("s1").priority, 2);
  });

  test("unknown source id is 404", async () => {
    assert.equal((await patch("nope", { priority: 5 })).status, 404);
    assert.equal(writes.length, 0);
  });

  test("each bad field is a 400 naming it; nothing written", async () => {
    seedSource("rss1", "rss");
    seedSource("html1", "html_scrape");
    seedSource("api1", "news_api");
    const cases: [string, any, string][] = [
      ["rss1", { scrapeIntervalMinutes: 5 }, "scrapeIntervalMinutes"],
      ["rss1", { scrapeIntervalMinutes: 20_000 }, "scrapeIntervalMinutes"],
      ["rss1", { priority: 0 }, "priority"],
      ["rss1", { countryCodes: [] }, "countryCodes"],
      ["rss1", { countryCodes: ["GB", "GB"] }, "countryCodes"],
      ["rss1", { countryCodes: ["ZZ"] }, "countryCodes"],
      ["rss1", { config: { feedUrl: "http://169.254.169.254/" } }, "config.feedUrl"],
      ["rss1", { config: { feedUrl: "https://u:p@a.example.org/f" } }, "config.feedUrl"],
      ["rss1", { config: { selectors: { articleList: ".x" } } }, "config.selectors"],
      ["rss1", { config: { maxArticlesPerRun: 0 } }, "config.maxArticlesPerRun"],
      ["rss1", { strategy: "html_scrape" }, "strategy"],
      ["rss1", { bogus: 1 }, "bogus"],
      ["html1", { config: { feedUrl: "https://a.example.org/f" } }, "config.feedUrl"],
      ["html1", { config: { selectors: { articleList: "div[" } } }, "config.selectors.articleList"],
      ["api1", { config: { feedUrl: "https://a.example.org/f" } }, "config.feedUrl"],
      ["api1", { config: { selectors: { articleTitle: "h2" } } }, "config.selectors"],
    ];
    for (const [id, body, field] of cases) {
      const out = await patch(id, body);
      assert.equal(out.status, 400, JSON.stringify(body));
      assert.equal(out.body.error, "VALIDATION_ERROR");
      assert.equal(out.body.field, field, JSON.stringify(body));
    }
    assert.equal(writes.length, 0);
  });

  test("a stored rss source cannot be left without a feedUrl", async () => {
    seedSource("rss1", "rss", { config: { maxArticlesPerRun: 15 } });
    const out = await patch("rss1", { priority: 3 });
    assert.equal(out.status, 400);
    assert.equal(out.body.field, "config.feedUrl");
  });

  test("visa kind still rejects the new keys", async () => {
    const out = await call("patchSource", admin({ params: { kind: "visa", id: "GB" }, body: { priority: 3 } }));
    assert.equal(out.status, 400);
    assert.equal(out.body.field, "priority");
  });
});

// ============================================
// PATCH: success paths
// ============================================

describe("PATCH /admin/scrape-sources/news/:id: edits", () => {
  test("one success per new key, with the row carrying newsConfig", async () => {
    seedSource("s1", "rss");
    let out = await patch("s1", { scrapeIntervalMinutes: 60 });
    assert.equal(out.status, 200);
    assert.equal(out.body.data.newsConfig.scrapeIntervalMinutes, 60);
    assert.equal(doc("s1").scrapeIntervalMinutes, 60);

    out = await patch("s1", { priority: 4 });
    assert.equal(doc("s1").priority, 4);
    out = await patch("s1", { countryCodes: ["GB", "IE"] });
    assert.deepEqual(doc("s1").countryCodes, ["GB", "IE"]);
    out = await patch("s1", { config: { feedUrl: "https://other.example.org/rss" } });
    assert.equal(doc("s1").config.feedUrl, "https://other.example.org/rss");
    out = await patch("s1", { config: { maxArticlesPerRun: 30 } });
    assert.equal(doc("s1").config.maxArticlesPerRun, 30);
    assert.deepEqual(out.body.data.newsConfig, {
      strategy: "rss",
      scrapeIntervalMinutes: 60,
      priority: 4,
      countryCodes: ["GB", "IE"],
      feedUrl: "https://other.example.org/rss",
      maxArticlesPerRun: 30,
    });
    assert.deepEqual(doc("s1").adminOverrides.config, {
      scrapeIntervalMinutes: 60,
      priority: 4,
      countryCodes: ["GB", "IE"],
      feedUrl: "https://other.example.org/rss",
      maxArticlesPerRun: 30,
    });
  });

  test("html: selectors merge; other config keys and health counters are untouched", async () => {
    seedSource("h1", "html_scrape");
    const out = await patch("h1", { config: { selectors: { articleTitle: "h3.t" } } });
    assert.equal(out.status, 200);
    const d = doc("h1");
    assert.deepEqual(d.config.selectors, { articleList: ".list", articleLink: "a", articleTitle: "h3.t", articleDate: "time" });
    assert.deepEqual(d.config.customHeaders, { Accept: "y" });
    assert.equal(d.config.fetchFullContent, false);
    assert.equal(d.config.maxArticlesPerRun, 10);
    assert.equal(d.strategy, "html_scrape");
    for (const [k, v] of Object.entries({ reliabilityScore: 87.5, totalRuns: 8, successfulRuns: 7, consecutiveFailures: 1, slug: "h1", name: "Name h1", isOfficial: false })) {
      assert.equal(d[k], v, k);
    }
    assert.deepEqual(d.adminOverrides.config, { selectors: { articleTitle: "h3.t" } });
    assert.equal(out.body.data.newsConfig.selectors.articleTitle, "h3.t");
    assert.equal(out.body.data.newsConfig.customHeaders, undefined, "newsConfig never carries customHeaders");
    assert.equal(out.body.data.newsConfig.apiConfig, undefined);
  });

  test("rss: customHeaders, fetchFullContent and requestTimeoutMs survive a feedUrl edit", async () => {
    seedSource("s1", "rss");
    await patch("s1", { config: { feedUrl: "https://other.example.org/rss" } });
    const c = doc("s1").config;
    assert.deepEqual(c.customHeaders, { Accept: "x" });
    assert.equal(c.fetchFullContent, true);
    assert.equal(c.requestTimeoutMs, 20000);
  });

  test("news_api accepts its four keys", async () => {
    seedSource("a1", "news_api");
    const out = await patch("a1", { scrapeIntervalMinutes: 90, priority: 1, countryCodes: ["AU"], config: { maxArticlesPerRun: 7 } });
    assert.equal(out.status, 200);
    assert.deepEqual(doc("a1").config.apiConfig, { provider: "newsdata", query: "visa" });
    assert.equal(doc("a1").config.maxArticlesPerRun, 7);
  });

  test("a body mixing old and new keys applies both, with one history entry", async () => {
    seedSource("s1", "rss");
    const out = await patch("s1", { status: "paused", reason: "checking", priority: 5 });
    assert.equal(out.status, 200);
    assert.equal(doc("s1").status, "paused");
    assert.equal(doc("s1").priority, 5);
    const history = [...store.entries()].filter(([p]) => p.startsWith("scraperSettingsHistory/"));
    assert.equal(history.length, 1);
    const entry = history[0][1] as any;
    assert.equal(entry.target, "source:news:s1");
    assert.equal(entry.by, `${ROLES.ADMIN}-uid`);
    const paths = entry.changes.map((c: any) => c.path);
    assert.ok(paths.includes("status") && paths.includes("priority"));
    assert.deepEqual(entry.changes.find((c: any) => c.path === "priority"), { path: "priority", before: 2, after: 5 });
    assert.ok(doc("s1").adminOverrides.updatedAt);
    assert.equal(doc("s1").adminOverrides.updatedBy, `${ROLES.ADMIN}-uid`);
  });

  test("history lists a before/after per changed field (selector path included)", async () => {
    seedSource("h1", "html_scrape");
    await patch("h1", { scrapeIntervalMinutes: 30, config: { selectors: { articleTitle: "h3" } } });
    const entry = ([...store.entries()].find(([p]) => p.startsWith("scraperSettingsHistory/")) as any)[1];
    assert.deepEqual(entry.changes.map((c: any) => c.path).sort(), ["config.selectors.articleTitle", "scrapeIntervalMinutes"]);
    assert.deepEqual(entry.changes.find((c: any) => c.path === "config.selectors.articleTitle"), {
      path: "config.selectors.articleTitle",
      before: "h2",
      after: "h3",
    });
  });

  test("a PATCH that changes nothing writes nothing", async () => {
    seedSource("s1", "rss");
    const out = await patch("s1", { scrapeIntervalMinutes: 120, priority: 2, countryCodes: ["GB"], config: { maxArticlesPerRun: 15 } });
    assert.equal(out.status, 200);
    assert.equal(writes.length, 0);
  });
});

// ============================================
// Seeder keeps edits
// ============================================

describe("re-seed keeps adminOverrides.config", () => {
  const seed = (existing: any) => seedNews.buildSeededNewsSource(seedNews.NEWS_SOURCES.find((s: any) => s.strategy === "rss"), existing, Timestamp.fromMillis(NOW));

  test("seed, edit scrapeIntervalMinutes, re-seed: the edited value stays; a never-edited source follows the registry", async () => {
    const registry = seedNews.NEWS_SOURCES.find((s: any) => s.strategy === "rss");
    const first = seed(undefined);
    assert.equal(first.scrapeIntervalMinutes, registry.scrapeIntervalMinutes);
    store.set(`newsSources/${registry.slug}`, { ...first, strategy: registry.strategy, adminOverrides: undefined });
    delete (store.get(`newsSources/${registry.slug}`) as any).adminOverrides;

    // Never edited: follows the registry (even when the live value drifted).
    assert.equal(seed({ ...first, scrapeIntervalMinutes: 999 }).scrapeIntervalMinutes, registry.scrapeIntervalMinutes);

    // Edit through the real PATCH, then re-seed from the stored doc.
    const out = await patch(registry.slug, { scrapeIntervalMinutes: 45, priority: 9, config: { feedUrl: "https://moved.example.org/feed", maxArticlesPerRun: 3 } });
    assert.equal(out.status, 200);
    const reseeded = seed(doc(registry.slug));
    assert.equal(reseeded.scrapeIntervalMinutes, 45);
    assert.equal(reseeded.priority, 9);
    assert.equal(reseeded.config.feedUrl, "https://moved.example.org/feed");
    assert.equal(reseeded.config.maxArticlesPerRun, 3);
    assert.deepEqual(reseeded.countryCodes, registry.countryCodes, "unedited fields follow the registry");
  });

  test("edited selectors merge over the registry selectors key by key", () => {
    const html = seedNews.NEWS_SOURCES.find((s: any) => s.strategy === "html_scrape");
    const r = seedNews.buildSeededNewsSource(html, { adminOverrides: { config: { selectors: { articleTitle: "h9" } } } }, Timestamp.fromMillis(NOW));
    assert.equal(r.config.selectors.articleTitle, "h9");
    assert.equal(r.config.selectors.articleList, html.config.selectors.articleList);
  });
});

// ============================================
// articlesLast7d
// ============================================

describe("articlesLast7d", () => {
  const article = (id: string, sourceId: string, ageDays: number) =>
    store.set(`newsArticles/${id}`, { id, sourceId, scrapedAt: Timestamp.fromMillis(NOW - ageDays * DAY) });

  test("counts the source's articles scraped within 7 days; 0 for none; visa rows null", async () => {
    seedSource("s1", "rss");
    seedSource("s2", "rss");
    article("a1", "s1", 1);
    article("a2", "s1", 6.9);
    article("a3", "s1", 8); // too old
    article("a4", "s2", 2); // other source
    store.set("visaSources/GB", { id: "GB", countryCode: "GB", countryName: "UK", status: "active", pages: [] });
    store.set("newsSources/s3", { ...(doc("s1") as any), id: "s3", slug: "s3" });
    const rows = await runsSvc.listSourceHealth(undefined, NOW);
    const by = (id: string) => rows.find((r: any) => r.sourceId === id);
    assert.equal(by("s1").articlesLast7d, 2);
    assert.equal(by("s2").articlesLast7d, 1);
    assert.equal(by("s3").articlesLast7d, 0);
    assert.equal(by("GB").articlesLast7d, null);
    assert.equal(by("GB").newsConfig, null);
    assert.equal(by("s1").zeroYieldRuns, 0);
    assert.equal(by("s1").zeroYieldSince, null);
  });

  test("counts run concurrently (all started before any resolves)", async () => {
    for (const id of ["a", "b", "c"]) seedSource(id, "rss");
    const firebase: any = await import("../../../src/utils/firebase");
    const { fakeCollection } = await import("../../helpers/fake-firestore");
    const base = fakeCollection("newsArticles");
    const orig = firebase.collections.newsArticles;
    let inFlight = 0;
    let peak = 0;
    firebase.collections.newsArticles = {
      where: (...a: any[]) => {
        const q: any = (base as any).where(...a);
        const wrap = (x: any): any => ({
          where: (...b: any[]) => wrap(x.where(...b)),
          count: () => ({
            get: async () => {
              inFlight++;
              peak = Math.max(peak, inFlight);
              await new Promise((r) => setTimeout(r, 5));
              const out = await x.count().get();
              inFlight--;
              return out;
            },
          }),
        });
        return wrap(q);
      },
    };
    try {
      await runsSvc.listSourceHealth("news", NOW);
    } finally {
      firebase.collections.newsArticles = orig;
    }
    assert.equal(peak, 3);
  });

  test("a failing count gives null and the list still returns", async () => {
    seedSource("s1", "rss");
    const firebase: any = await import("../../../src/utils/firebase");
    const orig = firebase.collections.newsArticles;
    firebase.collections.newsArticles = {
      where: () => ({ where: () => ({ count: () => ({ get: async () => { throw new Error("FAILED_PRECONDITION: index building"); } }) }) }),
    };
    try {
      const rows: any[] = await quiet<any[]>(() => runsSvc.listSourceHealth("news", NOW));
      assert.equal(rows.length, 1);
      assert.equal(rows[0].articlesLast7d, null);
      assert.equal(rows[0].sourceId, "s1");
    } finally {
      firebase.collections.newsArticles = orig;
    }
  });

  test("the PATCH response carries articlesLast7d", async () => {
    seedSource("s1", "rss");
    article("a1", "s1", 1);
    const out = await patch("s1", { priority: 3 });
    assert.equal(out.body.data.articlesLast7d, 1);
  });
});

// ============================================
// Zero-yield streak
// ============================================

describe("zero-yield streak (updateSourceAfterScrape)", () => {
  const run = (success: boolean, articlesFound?: number, nowMs = NOW) =>
    health.updateSourceAfterScrape("s1", success, success ? undefined : "boom", undefined, { nowMs, ...(articlesFound === undefined ? {} : { articlesFound }) });

  test("0 -> 1 -> N on successful zero-found runs; since is set once", async () => {
    seedSource("s1", "rss");
    assert.equal(doc("s1").zeroYieldRuns, undefined);
    await run(true, 0, NOW);
    assert.equal(doc("s1").zeroYieldRuns, 1);
    assert.equal(doc("s1").zeroYieldSince.toMillis(), NOW);
    await run(true, 0, NOW + DAY);
    await run(true, 0, NOW + 2 * DAY);
    assert.equal(doc("s1").zeroYieldRuns, 3);
    assert.equal(doc("s1").zeroYieldSince.toMillis(), NOW, "since stays at the first run of the streak");
  });

  test("a run that found articles resets (even if all were duplicates)", async () => {
    seedSource("s1", "rss", { zeroYieldRuns: 4, zeroYieldSince: Timestamp.fromMillis(NOW) });
    await run(true, 5);
    assert.equal(doc("s1").zeroYieldRuns, 0);
    assert.equal(doc("s1").zeroYieldSince, null);
  });

  test("a failed run leaves the streak unchanged", async () => {
    seedSource("s1", "rss", { zeroYieldRuns: 2, zeroYieldSince: Timestamp.fromMillis(NOW) });
    await run(false, 0);
    assert.equal(doc("s1").zeroYieldRuns, 2);
    assert.equal(doc("s1").zeroYieldSince.toMillis(), NOW);
  });

  test("a call without articlesFound changes neither field", async () => {
    seedSource("s1", "rss", { zeroYieldRuns: 2, zeroYieldSince: Timestamp.fromMillis(NOW) });
    await run(true);
    assert.equal(doc("s1").zeroYieldRuns, 2);
    assert.equal(doc("s1").zeroYieldSince.toMillis(), NOW);
    seedSource("s2", "rss");
    await health.updateSourceAfterScrape("s2", true);
    assert.equal(doc("s2").zeroYieldRuns, undefined);
  });

  test("never pauses the source", async () => {
    seedSource("s1", "rss");
    for (let i = 0; i < 10; i++) await run(true, 0, NOW + i * DAY);
    assert.equal(doc("s1").status, "active");
    assert.equal(doc("s1").zeroYieldRuns, 10);
  });

  test("the health row exposes the streak (ISO since)", async () => {
    seedSource("s1", "rss");
    await run(true, 0);
    const row = await runsSvc.getSourceHealth("news", "s1", NOW);
    assert.equal(row.zeroYieldRuns, 1);
    assert.equal(row.zeroYieldSince, new Date(NOW).toISOString());
  });
});

// ============================================
// source_no_yield rule + config threshold
// ============================================

describe("evaluateNoYieldSources", () => {
  const cfg = (patch: any = {}) => rules.resolveConfig(patch).config;
  const src = (over: any) => ({ id: "s1", name: "Feed", status: "active", ...over });

  test("below / at / above the threshold (default 3)", () => {
    assert.equal(rules.evaluateNoYieldSources([src({ zeroYieldRuns: 2 })], cfg()).signals.length, 0);
    const at = rules.evaluateNoYieldSources([src({ zeroYieldRuns: 3 })], cfg());
    assert.equal(at.signals.length, 1);
    assert.equal(at.signals[0].key, "source_no_yield:news:s1");
    assert.equal(at.signals[0].rule, "source_no_yield");
    assert.equal(at.signals[0].severity, "warning");
    assert.equal(rules.evaluateNoYieldSources([src({ zeroYieldRuns: 9 })], cfg()).signals.length, 1);
    assert.deepEqual(at.scope, { keyPrefix: "source_no_yield:news:" });
  });

  test("honours a configured threshold and severity", () => {
    const c = cfg({ thresholds: { zeroYieldRuns: 5 }, rules: { source_no_yield: { severity: "critical" } } });
    assert.equal(rules.evaluateNoYieldSources([src({ zeroYieldRuns: 4 })], c).signals.length, 0);
    const r = rules.evaluateNoYieldSources([src({ zeroYieldRuns: 5 })], c);
    assert.equal(r.signals[0].severity, "critical");
  });

  test("paused / broken / retired sources do not signal (so an alert auto-resolves)", () => {
    for (const status of ["paused", "broken", "retired"]) {
      assert.equal(rules.evaluateNoYieldSources([src({ status, zeroYieldRuns: 7 })], cfg()).signals.length, 0, status);
    }
  });

  test("a quiet-week source (streak 0 / absent) never signals", () => {
    assert.equal(rules.evaluateNoYieldSources([src({ zeroYieldRuns: 0 }), src({ id: "s2" })], cfg()).signals.length, 0);
  });

  test("details carry the streak; the rule is registered everywhere", () => {
    const r = rules.evaluateNoYieldSources([src({ zeroYieldRuns: 3, zeroYieldSince: Timestamp.fromMillis(NOW) })], cfg());
    assert.deepEqual(r.signals[0].details, { sourceId: "s1", zeroYieldRuns: 3, zeroYieldSince: new Date(NOW).toISOString(), threshold: 3 });
    assert.equal(rules.DEFAULT_SEVERITY.source_no_yield, "warning");
  });
});

describe("resolveConfig thresholds.zeroYieldRuns", () => {
  test("defaults to 3; accepts whole numbers 1..100", () => {
    assert.equal(rules.resolveConfig(undefined).config.thresholds.zeroYieldRuns, 3);
    const ok = rules.resolveConfig({ thresholds: { zeroYieldRuns: 6 } });
    assert.equal(ok.config.thresholds.zeroYieldRuns, 6);
    assert.deepEqual(ok.problems, []);
  });
  test("rejects 0, fractions, > 100 and non-numbers (falls back, reports a problem)", () => {
    for (const bad of [0, 2.5, 101, "3", null]) {
      const r = rules.resolveConfig({ thresholds: { zeroYieldRuns: bad } });
      assert.equal(r.config.thresholds.zeroYieldRuns, 3, String(bad));
      assert.ok(r.problems.some((p: string) => p.startsWith("thresholds.zeroYieldRuns")), String(bad));
    }
  });
});

describe("alerts config PATCH accepts thresholds.zeroYieldRuns", () => {
  test("PATCH /admin/scraper-settings validates it like the other thresholds", async () => {
    let out = await call("patch", admin({ body: { alerts: { thresholds: { zeroYieldRuns: 5 } } } }));
    assert.equal(out.status, 200);
    assert.equal(out.body.data.alerts.thresholds.zeroYieldRuns, 5);
    out = await call("patch", admin({ body: { alerts: { thresholds: { zeroYieldRuns: 0 } } } }));
    assert.equal(out.status, 400);
    assert.equal(out.body.field, "alerts.thresholds.zeroYieldRuns");
    out = await call("patch", admin({ body: { alerts: { rules: { source_no_yield: { enabled: false } } } } }));
    assert.equal(out.status, 200);
  });
});

// ============================================
// Legacy /news/admin routes
// ============================================

describe("legacy news admin routes", () => {
  test("GET /news/admin/sources is gone; /runs remains", () => {
    const paths = (newsRoutes.stack as any[]).filter((l) => l.route).map((l) => `${Object.keys(l.route.methods)[0]} ${l.route.path}`);
    assert.ok(!paths.includes("get /admin/sources"));
    assert.ok(paths.includes("get /admin/sources/:sourceId/runs"));
    assert.equal(typeof newsController.getSources, "undefined");
  });

  test("runs: non-admins get 403 via the CASL gate; an admin passes it", async () => {
    for (const role of [ROLES.OWNER, ROLES.AGENT, ROLES.CLIENT] as Role[]) {
      const out = await callOn(newsController, "getScrapeRuns", req(role, { params: { sourceId: "s1" } }));
      assert.equal(out.status, 403, role);
    }
    // The old gate read `req.user?.admin`; the ability alone decides now.
    const out = await callOn(newsController, "getScrapeRuns", admin({ params: { sourceId: "s1" }, user: { admin: false } }));
    assert.equal(out.status, 200);
  });
});
