// ============================================
// Unit tests — news source health counted once per run (issue #79)
// ============================================
//
// Run with `npm test`. NO network and NO emulator: HTTP goes to a stub
// client, Firestore is the in-memory fake (test/helpers/fake-firestore), and
// the REAL newsService.updateSourceAfterScrape does the counting, so the
// assertions cover the actual totalRuns / consecutiveFailures /
// reliabilityScore / auto-pause maths.
//
// The bug: a failing source was recorded twice per run (scrapeSource's catch
// AND the orchestrator's catch), so totalRuns and consecutiveFailures went up
// by 2 and the source was auto-paused ("broken") after 3 failed runs, not 5.
//
// Covers:
//  - a failing source: totalRuns +1 and consecutiveFailures +1 per run, and
//    auto-paused at exactly the 5th consecutive failure (not before)
//  - reliabilityScore = successfulRuns / totalRuns after mixed runs
//  - the #76 backed-off-host skip path: exactly one update for the skipped
//    source
//  - #81's per-source run log still carries the run-wide runId

import { test, describe, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { FieldValue } from "firebase-admin/firestore";

import type { NewsSource } from "../src/types/news";
import type { VisaCatalogHttpClient } from "../src/services/visa-catalog-fetch.service";
import { installFakes, resetStore, store as fakeStore } from "./helpers/fake-firestore";

// Project id (GCLOUD_PROJECT=demo-unit-test) and the no-network guard are set
// centrally by the test preload, test/helpers/setup.ts (issue #94).

type ScraperModule = typeof import("../src/services/news-scraper.service");
let mod: ScraperModule;
let newsService: typeof import("../src/services/news.service")["newsService"];

before(async () => {
  await installFakes();
  // The fake stores FieldValue sentinels verbatim; the counters under test
  // use increment(1), so resolve that one sentinel against the stored value
  // before the fake applies the update (like Firestore does server-side).
  const firebase: any = await import("../src/utils/firebase");
  const sources = firebase.collections.newsSources;
  const origDoc = sources.doc.bind(sources);
  sources.doc = (id: string) => {
    const ref = origDoc(id);
    const origUpdate = ref.update.bind(ref);
    ref.update = async (data: Record<string, unknown>) => {
      const cur = (fakeStore.get(`newsSources/${id}`) ?? {}) as Record<string, unknown>;
      const resolved: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(data)) {
        resolved[k] =
          v instanceof FieldValue && v.isEqual(FieldValue.increment(1))
            ? Number(cur[k] ?? 0) + 1
            : v;
      }
      return origUpdate(resolved);
    };
    return ref;
  };
  mod = await import("../src/services/news-scraper.service");
  newsService = (await import("../src/services/news.service")).newsService;
});

// ----- Stub HTTP: url -> status; unknown URLs 404 (robots.txt absent) -----

let routes: Map<string, { status: number; body?: string; headers?: Record<string, string> }>;
const http: VisaCatalogHttpClient = {
  async get(url) {
    const r = routes.get(url) ?? { status: 404, body: "" };
    return { status: r.status, data: r.body ?? "", headers: r.headers ?? {} };
  },
};

const RSS = `<?xml version="1.0"?><rss version="2.0"><channel><title>t</title>
<item><title>New rule</title><link>https://ok.example.org/a1</link><description>s</description></item>
</channel></rss>`;

/** A fresh, active RSS source document seeded into the fake Firestore. */
function seedSource(id: string, feedUrl: string): NewsSource {
  const source = {
    id,
    name: id,
    slug: id,
    url: new URL(feedUrl).origin + "/",
    countryCodes: ["GB"],
    strategy: "rss",
    config: { feedUrl, maxArticlesPerRun: 10, fetchFullContent: false },
    scrapeIntervalMinutes: 120,
    isOfficial: false,
    status: "active",
    totalRuns: 0,
    successfulRuns: 0,
    consecutiveFailures: 0,
    reliabilityScore: 100,
  };
  fakeStore.set(`newsSources/${id}`, source);
  return source as unknown as NewsSource;
}

/** Current stored state of a source. */
const sourceDoc = (id: string) => fakeStore.get(`newsSources/${id}`) as Record<string, any>;

/**
 * A scraper over the REAL newsService, except getDueSources (returns the
 * given ids' current docs, so the fake needs no query support) and the
 * article writes (irrelevant here).
 */
function makeScraper(dueIds: string[]) {
  const store = {
    getDueSources: async () => dueIds.map((id) => sourceDoc(id) as unknown as NewsSource),
    createScrapeRun: newsService.createScrapeRun.bind(newsService),
    completeScrapeRun: newsService.completeScrapeRun.bind(newsService),
    updateSourceAfterScrape: newsService.updateSourceAfterScrape.bind(newsService),
    isDuplicate: async () => false,
    createArticlesBatch: async (a: unknown[]) => a.length,
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new mod.NewsScraperService({ http, store: store as any, minIntervalMs: 0 });
}

beforeEach(() => {
  resetStore();
  routes = new Map();
});

describe("source health is updated once per source per run (issue #79)", () => {
  test("a failing source auto-pauses at exactly the 5th consecutive failure", async () => {
    seedSource("bad", "https://bad.example.org/feed.xml");
    routes.set("https://bad.example.org/feed.xml", { status: 500, body: "" });

    for (let run = 1; run <= 5; run++) {
      await makeScraper(["bad"]).runOrchestrator();
      const doc = sourceDoc("bad");
      // One increment per run, not two.
      assert.equal(doc.totalRuns, run, `totalRuns after run ${run}`);
      assert.equal(doc.consecutiveFailures, run, `consecutiveFailures after run ${run}`);
      assert.equal(doc.reliabilityScore, 0);
      // Still active through run 4; paused on run 5 exactly.
      assert.equal(doc.status, run < 5 ? "active" : "broken", `status after run ${run}`);
    }
  });

  test("reliabilityScore is successfulRuns / totalRuns over mixed runs", async () => {
    seedSource("flaky", "https://flaky.example.org/feed.xml");
    // 3 successes, then 1 failure.
    routes.set("https://flaky.example.org/feed.xml", { status: 200, body: RSS });
    for (let i = 0; i < 3; i++) await makeScraper(["flaky"]).runOrchestrator();
    routes.set("https://flaky.example.org/feed.xml", { status: 500, body: "" });
    await makeScraper(["flaky"]).runOrchestrator();

    const doc = sourceDoc("flaky");
    assert.equal(doc.totalRuns, 4);
    assert.equal(doc.successfulRuns, 3);
    assert.equal(doc.consecutiveFailures, 1);
    assert.equal(doc.reliabilityScore, 75);
  });

  test("a source skipped behind a backed-off host is counted once", async () => {
    // Both sources share a host; the first gets 429, so the second is
    // deferred without a request (#76) and must still get one update only.
    seedSource("first", "https://slow.example.org/a.xml");
    seedSource("second", "https://slow.example.org/b.xml");
    routes.set("https://slow.example.org/a.xml", {
      status: 429,
      body: "",
      headers: { "retry-after": "60" },
    });

    const result = await makeScraper(["first", "second"]).runOrchestrator();
    assert.equal(result.sourcesDeferred, 1);
    for (const id of ["first", "second"]) {
      assert.equal(sourceDoc(id).totalRuns, 1, `${id} totalRuns`);
      assert.equal(sourceDoc(id).consecutiveFailures, 1, `${id} consecutiveFailures`);
    }
  });

  test("the per-source run log keeps its run-wide runId (#81)", async () => {
    seedSource("bad", "https://bad.example.org/feed.xml");
    routes.set("https://bad.example.org/feed.xml", { status: 500, body: "" });
    await makeScraper(["bad"]).runOrchestrator();

    const logs = [...fakeStore.entries()].filter(([p]) => p.startsWith("newsSources/bad/scrapeRuns/"));
    assert.equal(logs.length, 1);
    const runIds = [...fakeStore.keys()].filter((p) => /^scrapeRuns\/[^/]+$/.test(p)).map((p) => p.split("/")[1]);
    assert.ok(runIds.includes((logs[0][1] as Record<string, unknown>).runId as string));
  });
});
