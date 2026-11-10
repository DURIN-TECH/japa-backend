// ============================================
// Scraper settings + manual runs (issue #96)
// ============================================
//
// Hermetic (issue #94): every Firestore call goes through the in-memory fake
// (test/helpers/fake-firestore.ts); the visa adapter and the LLM extractor are
// stubbed, the news scraper runs over an injected store. Covers:
//  - the runtime settings merge (defaults = the old code constants);
//  - kill switch: a switched-off scheduled tick records and spends nothing
//    (visa + news), a manual run still goes;
//  - limits from settings reach the run record;
//  - budget hard stop: fetch + hash, no LLM call, page stays pending, run
//    warning + summary flags, budget_hard_stop alert;
//  - single-source manual scope (ignores due + window), force (hash gate);
//  - PATCH /admin/scraper-settings: validation 400s naming the field,
//    pricing never saved when invalid, writes + history diff + updatedBy,
//    no-op PATCH writes nothing; GET defaults;
//  - per-source PATCH (status / reason / window / reset / backoffs) and the
//    seeders keeping admin overrides;
//  - Run now: 202, one in flight (409), cooldown (409 + retryAfter),
//    paused source / disabled scraper (409), 403 for non-admins;
//  - the worker: claim once, manual run record, runId on the request, lock
//    released, skipped when nothing ran;
//  - alerts: extraRecipientEmails validation + delivery.

import { test, describe, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Timestamp } from "firebase-admin/firestore";
import { ROLES, defineAbilitiesFor } from "@durin-tech/authz";
import type { Role } from "@durin-tech/authz";

import { Data, installFakes, resetStore, store, writes } from "../../../helpers/fake-firestore";

/* eslint-disable @typescript-eslint/no-explicit-any */
let storeMod: any; // shared/settings/scraper-settings.store
let validate: any; // shared/settings/scraper-settings.validate
let controller: any; // shared/settings/scraper-settings.controller
let requests: any; // scrapeRunRequestService
let worker: any; // scrapeRunWorker
let crawl: any; // visaCatalogCrawlService
let adapters: any;
let extractMod: any;
let newsMod: any;
let alertsMod: any;
let alertRules: any;
let seedVisa: any;
let seedNews: any;

const HOUR = 60 * 60 * 1000;
// Tuesday 2026-11-10 12:00 UTC: outside GB's Monday 02:00-05:00 London window.
const NOW = Date.parse("2026-11-10T12:00:00Z");
const CC = "GB";
const PAGE = "https://www.gov.uk/skilled-worker-visa";
const GB_WINDOW = { timeZone: "Europe/London", dayOfWeek: 1, startHour: 2, endHour: 5 };
const fetchFxRates = async () => ({ rates: { GBP: 0.8 }, rateDate: "2026-11-09" });

/** LLM calls made by the stubbed extractor (reset per test). */
let extractCalls = 0;

before(async () => {
  await installFakes();
  storeMod = await import("../../../../src/scrapers/shared/settings/scraper-settings.store");
  validate = await import("../../../../src/scrapers/shared/settings/scraper-settings.validate");
  controller = (await import("../../../../src/scrapers/shared/settings/scraper-settings.controller")).scraperSettingsController;
  requests = (await import("../../../../src/scrapers/shared/settings/scrape-run-request.service")).scrapeRunRequestService;
  worker = (await import("../../../../src/scrapers/shared/settings/scrape-run-worker")).scrapeRunWorker;
  crawl = (await import("../../../../src/scrapers/visa-catalog/visa-catalog-crawl.service")).visaCatalogCrawlService;
  adapters = await import("../../../../src/scrapers/visa-catalog/adapters");
  extractMod = await import("../../../../src/scrapers/visa-catalog/visa-catalog-extract.service");
  newsMod = await import("../../../../src/scrapers/news/news-scraper.service");
  alertsMod = await import("../../../../src/scrapers/shared/alerts/scrape-alert.service");
  alertRules = await import("../../../../src/scrapers/shared/alerts/scrape-alert-rules");
  seedVisa = await import("../../../../src/scrapers/visa-catalog/data/seed-visa-sources");
  seedNews = await import("../../../../src/scrapers/news/seed-news-sources");
  // Fixed clocks so cooldowns / months / windows are deterministic.
  const settingsSvc = (await import("../../../../src/scrapers/shared/settings/scraper-settings.service")).scraperSettingsService;
  settingsSvc.clock = () => NOW;
  requests.clock = () => NOW;
  worker.clock = () => NOW;
  const costs = (await import("../../../../src/scrapers/shared/cost/scrape-cost.service")).scrapeCostService;
  costs.clock = () => NOW;
});

beforeEach(() => {
  resetStore();
  extractCalls = 0;
  requests.clock = () => NOW;
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

/** A GB source with one page; `over` patches the doc. Not due by default. */
function seedGb(over: Data = {}): void {
  store.set(`visaSources/${CC}`, {
    id: CC,
    countryCode: CC,
    countryName: "United Kingdom",
    status: "active",
    crawlWindow: GB_WINDOW,
    nextCrawlAt: Timestamp.fromMillis(NOW + 6 * 24 * HOUR), // next Monday: NOT due
    crawlIntervalHours: 168,
    consecutiveFailures: 0,
    reliabilityScore: 100,
    pages: [{ url: PAGE, routeName: "Skilled Worker visa", visaId: "gb-skilled-worker", lastContentHash: "h-old" }],
    ...over,
  });
}

/** Stub the generic-html adapter (always fetches "h-new") + the extractor. */
async function withStubs(fn: () => Promise<any>, hash = "h-new"): Promise<any> {
  const origAdapter = adapters.sourceAdapters["generic-html"];
  const origExtract = extractMod.visaCatalogExtractor.extract;
  adapters.sourceAdapters["generic-html"] = {
    id: "generic-html",
    canHandle: () => true,
    fetch: async (page: { url: string }) => ({
      url: page.url,
      canonicalUrl: page.url,
      sourceProvider: "generic-html",
      withdrawn: false,
      sections: [{ slug: "page", title: "", text: "text" }],
      text: "text",
      contentHash: hash,
    }),
  };
  extractMod.visaCatalogExtractor.extract = async () => {
    extractCalls++;
    return {
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
    };
  };
  try {
    return await quiet(fn);
  } finally {
    adapters.sourceAdapters["generic-html"] = origAdapter;
    extractMod.visaCatalogExtractor.extract = origExtract;
  }
}

/** Top-level docs of a collection as data. */
function docsOf(collection: string): Data[] {
  return [...store.entries()]
    .filter(([p]) => p.startsWith(`${collection}/`) && p.split("/").length === 2)
    .map(([, d]) => d);
}

/** Resolved default settings with a patch (deep enough for these tests). */
function settingsWith(patch: any = {}): any {
  const s = storeMod.resolveScraperSettings({}).settings;
  for (const [k, v] of Object.entries(patch)) s[k] = { ...s[k], ...(v as object) };
  return s;
}

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

const admin = (over: Data = {}) => req(ROLES.ADMIN as Role, over);

// ============================================
// Runtime settings
// ============================================

describe("settings store (runtime merge)", () => {
  test("defaults equal the pre-#96 code constants", () => {
    const { settings, problems } = storeMod.resolveScraperSettings(undefined);
    assert.deepEqual(settings, {
      // consecutiveFailureLimit (issue #107): 5 = the old hard-coded auto-pause threshold.
      visa: { enabled: true, blockManualWhenOff: false, consecutiveFailureLimit: 5, maxExtractionsPerRun: 15, maxSourcesPerTick: 3 },
      news: { enabled: true, blockManualWhenOff: false, consecutiveFailureLimit: 5, maxSourcesPerRun: 5 },
      manualRuns: { cooldownMinutes: 10 },
      budget: { hardStop: false },
    });
    assert.deepEqual(problems, []);
  });

  test("a bad stored value falls back to its default (reported), others are kept", () => {
    const { settings, problems } = storeMod.resolveScraperSettings({
      visa: { maxExtractionsPerRun: 2, maxSourcesPerTick: "lots" },
      news: "nope",
    });
    assert.equal(settings.visa.maxExtractionsPerRun, 2);
    assert.equal(settings.visa.maxSourcesPerTick, 3);
    assert.equal(settings.news.maxSourcesPerRun, 5);
    assert.equal(problems.length, 2);
  });

  test("loadScraperSettings reads appConfig/scraperSettings once", async () => {
    store.set("appConfig/scraperSettings", { visa: { enabled: false } });
    const s = await storeMod.loadScraperSettings();
    assert.equal(s.visa.enabled, false);
    assert.equal(s.news.enabled, true);
  });
});

// ============================================
// Orchestrators: kill switch, limits, scope, force, hard stop
// ============================================

describe("visa orchestrator + settings", () => {
  test("kill switch: a switched-off scheduled tick records nothing and spends nothing", async () => {
    // Due AND in window (Monday 02:15 London), with a stale running run that
    // a normal tick would sweep: nothing may happen.
    const monday = Date.parse("2026-11-09T02:15:00Z");
    seedGb({ nextCrawlAt: Timestamp.fromMillis(monday - HOUR) });
    store.set("scrapeRuns/old", { id: "old", kind: "visa", status: "running", startedAt: Timestamp.fromMillis(monday - 5 * HOUR) });
    store.set("appConfig/scraperSettings", { visa: { enabled: false } });
    const summary = await withStubs(() => crawl.runOrchestrator({ now: monday, fetchFxRates }));
    assert.equal(summary.sourcesProcessed, 0);
    assert.equal(extractCalls, 0);
    assert.equal(docsOf("scrapeRuns").length, 1, "no new run doc");
    assert.equal(store.get("scrapeRuns/old")!.status, "running", "no stale sweep");
    assert.equal(writes.length, 0, "no write at all");
  });

  test("kill switch does not stop a manual run", async () => {
    seedGb();
    const settings = settingsWith({ visa: { enabled: false } });
    const summary = await withStubs(() =>
      crawl.runOrchestrator({ now: NOW, fetchFxRates, settings, trigger: "manual", sourceId: CC })
    );
    assert.equal(summary.sourcesProcessed, 1);
  });

  test("single-source manual run ignores nextCrawlAt + window; limits come from settings", async () => {
    seedGb(); // not due, out of window
    let started: string | undefined;
    const settings = settingsWith({ visa: { maxExtractionsPerRun: 1, maxSourcesPerTick: 2 } });
    await withStubs(() =>
      crawl.runOrchestrator({
        now: NOW,
        fetchFxRates,
        settings,
        trigger: "manual",
        sourceId: CC,
        onRunStarted: (id: string) => {
          started = id;
        },
      })
    );
    const [run] = docsOf("scrapeRuns");
    assert.equal(run.trigger, "manual");
    assert.equal(run.id, started);
    assert.deepEqual(run.options, { maxSources: 2, maxExtractions: 1, sourceId: CC });
    assert.equal(extractCalls, 1);
    assert.equal((run.pages as any[])[0].outcome, "created");
  });

  test("a scheduled tick uses maxExtractionsPerRun / maxSourcesPerTick from appConfig", async () => {
    const monday = Date.parse("2026-11-09T02:15:00Z");
    seedGb({ nextCrawlAt: Timestamp.fromMillis(monday - HOUR) });
    store.set("appConfig/scraperSettings", { visa: { maxExtractionsPerRun: 4, maxSourcesPerTick: 1 } });
    await withStubs(() => crawl.runOrchestrator({ now: monday, fetchFxRates }));
    assert.deepEqual(docsOf("scrapeRuns")[0].options, { maxSources: 1, maxExtractions: 4 });
  });

  test("paused / retired sources are never run, even by id", async () => {
    for (const status of ["paused", "retired"]) {
      resetStore();
      seedGb({ status });
      const summary = await withStubs(() => crawl.runOrchestrator({ now: NOW, fetchFxRates, trigger: "manual", sourceId: CC }));
      assert.equal(summary.sourcesProcessed, 0);
      assert.equal(docsOf("scrapeRuns").length, 0);
    }
  });

  test("force ignores the content-hash gate (unchanged page re-extracted)", async () => {
    seedGb({ pages: [{ url: PAGE, routeName: "Skilled Worker visa", visaId: "gb-skilled-worker", lastContentHash: "h-same" }] });
    await withStubs(() => crawl.runOrchestrator({ now: NOW, fetchFxRates, trigger: "manual", sourceId: CC }), "h-same");
    assert.equal(extractCalls, 0, "hash gate holds without force");
    await withStubs(
      () => crawl.runOrchestrator({ now: NOW, fetchFxRates, trigger: "manual", sourceId: CC, force: true }),
      "h-same"
    );
    assert.equal(extractCalls, 1, "force re-extracts");
  });

  test("hard stop at budget: fetch + hash, no LLM call, page stays pending, warning + alert", async () => {
    seedGb();
    store.set("appConfig/scraperSettings", { budget: { hardStop: true } });
    store.set("appConfig/scrapeBudget", { monthlyUsd: 1 });
    store.set("scrapeCosts/2026-11", { month: "2026-11", totals: { costUsd: 1.5 } });
    const summary = await withStubs(() => crawl.runOrchestrator({ now: NOW, fetchFxRates, trigger: "manual", sourceId: CC }));
    assert.equal(extractCalls, 0, "no LLM call");
    assert.equal(summary.pagesFetched, 1, "still fetched");
    assert.equal(summary.pagesChanged, 1, "change detected");
    assert.equal(summary.budgetHardStop, true);
    assert.equal(summary.extractionsSkippedBudget, 1);
    const page = (store.get(`visaSources/${CC}`)!.pages as any[])[0];
    assert.equal(page.lastContentHash, "h-old", "old hash kept: still pending");
    assert.equal((page.extractionDeferredAt as Timestamp).toMillis(), NOW);
    const [run] = docsOf("scrapeRuns");
    assert.equal((run.pages as any[])[0].outcome, "capped");
    assert.match((run.pages as any[])[0].reason, /budget hard stop/);
    assert.ok((run.warnings as string[]).some((w) => /LLM budget hard stop/.test(w)));
    // The post-run alert rule raises budget_hard_stop from the summary flag.
    const ev = alertRules.evaluateBudgetHardStop(run, alertRules.resolveConfig({}).config);
    assert.equal(ev.signals.length, 1);
    assert.equal(ev.signals[0].severity, "critical");
    // Under budget (hard stop on): extraction happens and the marker clears.
    store.set("appConfig/scrapeBudget", { monthlyUsd: 100 });
    await withStubs(() => crawl.runOrchestrator({ now: NOW, fetchFxRates, trigger: "manual", sourceId: CC }));
    assert.equal(extractCalls, 1);
    const after = (store.get(`visaSources/${CC}`)!.pages as any[])[0];
    assert.equal(after.lastContentHash, "h-new");
    assert.equal(after.extractionDeferredAt, undefined);
  });

  test("hard stop off (default): no budget reads, extraction as before", async () => {
    seedGb();
    store.set("appConfig/scrapeBudget", { monthlyUsd: 1 });
    store.set("scrapeCosts/2026-11", { month: "2026-11", totals: { costUsd: 5 } });
    const summary = await withStubs(() => crawl.runOrchestrator({ now: NOW, fetchFxRates, trigger: "manual", sourceId: CC }));
    assert.equal(extractCalls, 1);
    assert.equal(summary.budgetHardStop, false);
  });
});

describe("news orchestrator + settings", () => {
  /** A news scraper over a stub store that records what it was asked. */
  function scraper(settings: any, calls: string[]) {
    return new newsMod.NewsScraperService({
      loadSettings: async () => settings,
      clock: () => NOW,
      store: {
        getDueSources: async (n: number) => {
          calls.push(`due:${n}`);
          return [];
        },
        getSourceById: async (id: string) => {
          calls.push(`byId:${id}`);
          return null;
        },
      },
    });
  }

  test("kill switch: a switched-off scheduled tick reads and writes nothing", async () => {
    const calls: string[] = [];
    await quiet(() => scraper(settingsWith({ news: { enabled: false } }), calls).runOrchestrator());
    assert.deepEqual(calls, []);
    assert.equal(writes.length, 0);
  });

  test("maxSourcesPerRun reaches the due query; a manual run reads its one source", async () => {
    const calls: string[] = [];
    const s = scraper(settingsWith({ news: { maxSourcesPerRun: 2 } }), calls);
    await quiet(() => s.runOrchestrator());
    await quiet(() => s.runOrchestrator({ trigger: "manual", sourceId: "cic-news" }));
    assert.deepEqual(calls, ["due:2", "byId:cic-news"]);
  });
});

// ============================================
// PATCH / GET /admin/scraper-settings
// ============================================

describe("scraper settings API", () => {
  test("non-admins get 403 on every route, before any read", async () => {
    for (const role of [ROLES.OWNER, ROLES.AGENT, ROLES.CLIENT] as Role[]) {
      for (const [h, params] of [
        ["get", {}],
        ["patch", {}],
        ["history", {}],
        ["patchSource", { kind: "visa", id: CC }],
        ["runSource", { kind: "visa", id: CC }],
        ["runScraper", { kind: "visa" }],
        ["getRequest", { id: "r1" }],
      ] as const) {
        assert.equal((await call(h, req(role, { params, body: { visa: { enabled: false } } }))).status, 403, `${role} ${h}`);
      }
    }
    assert.equal(writes.length, 0);
  });

  test("GET fills in defaults (empty Firestore)", async () => {
    const out = await call("get", admin());
    assert.equal(out.status, 200);
    const v = out.body.data;
    assert.equal(v.visa.maxExtractionsPerRun, 15);
    assert.equal(v.news.maxSourcesPerRun, 5);
    assert.equal(v.manualRuns.cooldownMinutes, 10);
    assert.deepEqual(v.budget, { monthlyUsd: null, hardStop: false, month: "2026-11", monthToDateUsd: 0, hardStopActive: false });
    assert.deepEqual(v.alerts.extraRecipientEmails, []);
    assert.ok(v.alerts.ruleDefaults.some((r: any) => r.rule === "budget_hard_stop" && r.defaultSeverity === "critical"));
    assert.equal(v.pricing.origin, "default");
    assert.equal(v.updatedAt, null);
    assert.equal(writes.length, 0, "GET never writes");
  });

  test("validation 400s name the field; nothing is written", async () => {
    const cases: [any, string][] = [
      [{ visa: { maxExtractionsPerRun: 0 } }, "visa.maxExtractionsPerRun"],
      [{ visa: { maxSourcesPerTick: 2.5 } }, "visa.maxSourcesPerTick"],
      [{ visa: { enabled: "no" } }, "visa.enabled"],
      [{ news: { maxSourcesPerRun: 51 } }, "news.maxSourcesPerRun"],
      [{ manualRuns: { cooldownMinutes: -1 } }, "manualRuns.cooldownMinutes"],
      [{ budget: { monthlyUsd: -5 } }, "budget.monthlyUsd"],
      [{ budget: { hardStop: 1 } }, "budget.hardStop"],
      [{ visa: { maxExtractions: 3 } }, "visa.maxExtractions"],
      [{ unknown: 1 }, "unknown"],
      [{ alerts: { thresholds: { errorRatePct: 300 } } }, "alerts.thresholds.errorRatePct"],
      [{ alerts: { thresholds: { nope: 1 } } }, "alerts.thresholds.nope"],
      [{ alerts: { email: { digestHourUtc: 24 } } }, "alerts.email.digestHourUtc"],
      [{ alerts: { rules: { made_up: { enabled: false } } } }, "alerts.rules.made_up"],
      [{ alerts: { rules: { error_rate: { severity: "loud" } } } }, "alerts.rules.error_rate.severity"],
      [{ alerts: { extraRecipientEmails: ["not-an-email"] } }, "alerts.extraRecipientEmails"],
      [{ pricing: { table: { models: { m: { inputPer1M: -1 } }, verifiedAt: "x" } } }, "pricing.table"],
      [{ pricing: { verifiedAt: "x" } }, "pricing.verifiedAt"],
      [{ pricing: { table: { currency: "USD", models: {} } } }, "pricing.table.verifiedAt"],
      ["nope", "body"],
    ];
    for (const [body, field] of cases) {
      const out = await call("patch", admin({ body }));
      assert.equal(out.status, 400, JSON.stringify(body));
      assert.equal(out.body.error, "VALIDATION_ERROR");
      assert.equal(out.body.field, field, JSON.stringify(body));
    }
    assert.equal(writes.length, 0);
    assert.equal(store.has("appConfig/llmPricing"), false, "invalid pricing never saved");
  });

  test("a PATCH writes each touched doc with updatedBy/updatedAt and one history entry with the diff", async () => {
    store.set("appConfig/scrapeAlerts", { enabled: true, thresholds: { errorRatePct: 20 } });
    const table = {
      currency: "USD",
      verifiedAt: "2026-11-10",
      models: {
        "deepseek-flash": {
          inputPer1M: 0.2,
          cachedInputPer1M: 0.02,
          outputPer1M: 0.8,
          sourceUrl: "https://api-docs.deepseek.com/quick_start/pricing",
          effectiveFrom: "2026-09-01",
          aliases: ["deepseek-chat"],
        },
      },
    };
    const out = await call(
      "patch",
      admin({
        body: {
          visa: { maxExtractionsPerRun: 1 },
          budget: { monthlyUsd: 25, hardStop: true },
          alerts: { extraRecipientEmails: ["Ops@Example.org"], thresholds: { errorRatePct: 30 }, rules: { error_rate: { enabled: false } } },
          pricing: { table },
        },
      })
    );
    assert.equal(out.status, 200);
    const v = out.body.data;
    assert.equal(v.visa.maxExtractionsPerRun, 1);
    assert.equal(v.budget.monthlyUsd, 25);
    assert.equal(v.budget.hardStop, true);
    assert.deepEqual(v.alerts.extraRecipientEmails, ["ops@example.org"]);
    assert.equal(v.alerts.thresholds.errorRatePct, 30);
    assert.equal(v.alerts.rules.error_rate.enabled, false);
    assert.equal(v.pricing.origin, "config");
    assert.equal(v.updatedBy, "admin-uid");
    for (const id of ["scraperSettings", "scrapeBudget", "scrapeAlerts", "llmPricing"]) {
      const d = store.get(`appConfig/${id}`)!;
      assert.equal(d.updatedBy, "admin-uid", id);
      assert.equal((d.updatedAt as Timestamp).toMillis(), NOW, id);
    }
    // The engines read their own docs as before.
    assert.equal(store.get("appConfig/scrapeBudget")!.monthlyUsd, 25);
    assert.equal((store.get("appConfig/scrapeAlerts")!.thresholds as any).errorRatePct, 30);
    const [h] = docsOf("scraperSettingsHistory");
    assert.equal(h.by, "admin-uid");
    assert.equal(h.target, "settings");
    const paths = (h.changes as any[]).map((c) => c.path);
    assert.ok(paths.includes("visa.maxExtractionsPerRun"));
    assert.deepEqual((h.changes as any[]).find((c) => c.path === "visa.maxExtractionsPerRun"), {
      path: "visa.maxExtractionsPerRun",
      before: 15,
      after: 1,
    });
    assert.ok(paths.includes("budget.monthlyUsd"));
    assert.ok(paths.includes("budget.hardStop"));
    assert.ok(paths.includes("alerts.thresholds.errorRatePct"));
    assert.ok(paths.includes("alerts.rules.error_rate.enabled"));
    assert.ok(paths.some((p: string) => p.startsWith("pricing.table.")));
    // History API lists it.
    const hist = await call("history", admin());
    assert.equal(hist.body.data.items.length, 1);
    assert.equal(hist.body.data.nextCursor, null);
  });

  test("a PATCH that changes nothing writes nothing; rule override null drops it", async () => {
    let out = await call("patch", admin({ body: { visa: { maxExtractionsPerRun: 15 } } }));
    assert.equal(out.status, 200);
    assert.equal(writes.length, 0, "default value = no change");
    store.set("appConfig/scrapeAlerts", { rules: { error_rate: { enabled: false } } });
    out = await call("patch", admin({ body: { alerts: { rules: { error_rate: null } } } }));
    assert.equal(out.status, 200);
    assert.deepEqual(store.get("appConfig/scrapeAlerts")!.rules, {});
  });

  test("an old invalid value elsewhere in the alert doc does not block an unrelated change", async () => {
    store.set("appConfig/scrapeAlerts", { thresholds: { stuckRunMinutes: "typo" } });
    const out = await call("patch", admin({ body: { alerts: { thresholds: { errorRatePct: 25 } } } }));
    assert.equal(out.status, 200);
  });
});

// ============================================
// Per-source controls + seeders
// ============================================

describe("per-source controls", () => {
  test("pause needs a reason; window validated; unknown source 404; news has no window", async () => {
    seedGb();
    const p = { kind: "visa", id: CC };
    let out = await call("patchSource", admin({ params: p, body: { status: "paused" } }));
    assert.equal(out.status, 400);
    assert.equal(out.body.field, "reason");
    out = await call("patchSource", admin({ params: p, body: { crawlWindow: { ...GB_WINDOW, endHour: 1 } } }));
    assert.equal(out.status, 400);
    assert.equal(out.body.field, "crawlWindow");
    out = await call("patchSource", admin({ params: p, body: { status: "broken", reason: "x" } }));
    assert.equal(out.body.field, "status");
    out = await call("patchSource", admin({ params: p, body: {} }));
    assert.equal(out.status, 400);
    out = await call("patchSource", admin({ params: { kind: "visa", id: "FR" }, body: { resetFailures: true } }));
    assert.equal(out.status, 404);
    store.set("newsSources/cic-news", { id: "cic-news", name: "CIC News", status: "active", consecutiveFailures: 0 });
    out = await call("patchSource", admin({ params: { kind: "news", id: "cic-news" }, body: { crawlWindow: GB_WINDOW } }));
    assert.equal(out.body.field, "crawlWindow");
    out = await call("patchSource", admin({ params: { kind: "news", id: "cic-news" }, body: { clearHostBackoffs: true } }));
    assert.equal(out.body.field, "clearHostBackoffs");
    assert.equal(writes.length, 0);
  });

  test("pause + window + reset + clear backoffs apply at once, with adminOverrides and history", async () => {
    seedGb({
      status: "broken",
      consecutiveFailures: 5,
      hostBackoffs: [{ host: "www.gov.uk", until: Timestamp.fromMillis(NOW + HOUR), status: 429, recordedAt: Timestamp.fromMillis(NOW) }],
    });
    const p = { kind: "visa", id: CC };
    const fri = { timeZone: "Europe/London", dayOfWeek: 5, startHour: 1, endHour: 4 };
    let out = await call("patchSource", admin({ params: p, body: { crawlWindow: fri, resetFailures: true, clearHostBackoffs: true } }));
    assert.equal(out.status, 200);
    let d = store.get(`visaSources/${CC}`)!;
    assert.equal(d.status, "active", "reset on a broken source re-activates it");
    assert.equal(d.consecutiveFailures, 0);
    assert.deepEqual(d.hostBackoffs, []);
    assert.deepEqual(d.crawlWindow, fri);
    assert.deepEqual((d.adminOverrides as any).crawlWindow, fri);
    // Next Friday 01:00 London (GMT in November) = 2026-11-13T01:00Z.
    assert.equal((d.nextCrawlAt as Timestamp).toMillis(), Date.parse("2026-11-13T01:00:00Z"));
    assert.deepEqual(out.body.data.adminOverrides.crawlWindow, fri);
    // Pause with a reason.
    out = await call("patchSource", admin({ params: p, body: { status: "paused", reason: "Site redesign" } }));
    d = store.get(`visaSources/${CC}`)!;
    assert.equal(d.status, "paused");
    assert.equal((d.adminOverrides as any).reason, "Site redesign");
    assert.equal((d.adminOverrides as any).updatedBy, "admin-uid");
    // Window back to the registry default.
    await call("patchSource", admin({ params: p, body: { crawlWindow: null } }));
    d = store.get(`visaSources/${CC}`)!;
    assert.deepEqual(d.crawlWindow, seedVisa.VISA_SOURCE_WINDOWS.GB);
    assert.equal((d.adminOverrides as any).crawlWindow, undefined);
    const hist = docsOf("scraperSettingsHistory");
    assert.equal(hist.length, 3);
    assert.ok(hist.every((h) => h.target === "source:visa:GB"));
  });

  test("re-seeding keeps admin overrides (visa window + status, news status)", () => {
    const fri = { timeZone: "Europe/London", dayOfWeek: 5, startHour: 1, endHour: 4 };
    const existing = {
      status: "paused",
      crawlWindow: fri,
      nextCrawlAt: Timestamp.fromMillis(NOW + HOUR),
      adminOverrides: { status: "paused", reason: "Site redesign", crawlWindow: fri },
    };
    const { doc } = seedVisa.buildSeededVisaSource({
      country: { countryCode: "GB", countryName: "United Kingdom", pages: [{ url: PAGE, routeName: "Skilled Worker visa" }] },
      existing,
      now: Timestamp.fromMillis(NOW),
    });
    assert.equal(doc.status, "paused");
    assert.deepEqual(doc.crawlWindow, fri, "override window wins over the registry's");
    assert.deepEqual(doc.adminOverrides, existing.adminOverrides);
    assert.equal((doc.nextCrawlAt as Timestamp).toMillis(), NOW + HOUR, "same window: nextCrawlAt kept");
    // News: an admin status survives; without overrides the seed's status applies.
    assert.equal(seedNews.newsSeedStatus("active", { status: "retired", adminOverrides: { status: "retired" } }), "retired");
    // Issue #107: a crawler hold (broken) is no longer undone by a re-seed.
    assert.equal(seedNews.newsSeedStatus("active", { status: "broken" }), "broken");
    assert.equal(seedNews.newsSeedStatus("active", { status: "active" }), "active");
  });
});

// ============================================
// Run now: requests, lock, cooldown, worker
// ============================================

describe("Run now", () => {
  test("202 queued; one in flight (409); cooldown after it finishes (409 + retryAfter)", async () => {
    seedGb();
    const p = { kind: "visa", id: CC };
    const first = await call("runSource", admin({ params: p, body: {} }));
    assert.equal(first.status, 202);
    const { requestId, runId, status } = first.body.data;
    assert.equal(runId, null);
    assert.equal(status, "queued");
    const reqDoc = store.get(`scrapeRunRequests/${requestId}`)!;
    assert.equal(reqDoc.kind, "visa");
    assert.equal(reqDoc.sourceId, CC);
    assert.equal(reqDoc.requestedBy, "admin-uid");

    const second = await call("runSource", admin({ params: p, body: { force: true } }));
    assert.equal(second.status, 409);
    assert.equal(second.body.error, "RUN_IN_PROGRESS");
    assert.equal(second.body.requestId, requestId);

    // The worker runs it (stubbed orchestrator), then the cooldown applies.
    worker.overrides = {
      loadSettings: async () => settingsWith(),
      visa: {
        runOrchestrator: async (o: any) => {
          await o.onRunStarted("run-1");
          return { sourcesProcessed: 1 };
        },
      },
    };
    try {
      assert.equal(await quiet(() => worker.process(requestId)), "succeeded");
    } finally {
      worker.overrides = undefined;
    }
    const done = store.get(`scrapeRunRequests/${requestId}`)!;
    assert.equal(done.status, "succeeded");
    assert.equal(done.runId, "run-1");
    assert.equal(store.get("scrapeRunLocks/visa__GB")!.activeRequestId, null);

    requests.clock = () => NOW + 60 * 1000;
    const third = await call("runSource", admin({ params: p, body: {} }));
    assert.equal(third.status, 409);
    assert.equal(third.body.error, "RUN_COOLDOWN");
    assert.equal(third.body.retryAfter, new Date(NOW + 10 * 60 * 1000).toISOString());
    // After the cooldown: accepted again.
    requests.clock = () => NOW + 11 * 60 * 1000;
    assert.equal((await call("runSource", admin({ params: p, body: {} }))).status, 202);
  });

  test("a request stuck past 15 min no longer blocks", async () => {
    seedGb();
    const p = { kind: "visa", id: CC };
    assert.equal((await call("runSource", admin({ params: p, body: {} }))).status, 202);
    requests.clock = () => NOW + 16 * 60 * 1000;
    assert.equal((await call("runSource", admin({ params: p, body: {} }))).status, 202);
  });

  test("refusals: unknown 404, paused 409, disabled + blockManualWhenOff 409, bad body 400", async () => {
    let out = await call("runSource", admin({ params: { kind: "visa", id: "FR" }, body: {} }));
    assert.equal(out.status, 404);
    seedGb({ status: "paused" });
    out = await call("runSource", admin({ params: { kind: "visa", id: CC }, body: {} }));
    assert.equal(out.status, 409);
    assert.equal(out.body.error, "SOURCE_NOT_ACTIVE");
    store.set("appConfig/scraperSettings", { visa: { enabled: false, blockManualWhenOff: true } });
    out = await call("runScraper", admin({ params: { kind: "visa" }, body: {} }));
    assert.equal(out.status, 409);
    assert.equal(out.body.error, "SCRAPER_DISABLED");
    out = await call("runScraper", admin({ params: { kind: "news" }, body: { force: "yes" } }));
    assert.equal(out.status, 400);
    assert.equal(out.body.field, "force");
    out = await call("runScraper", admin({ params: { kind: "jobs" }, body: {} }));
    assert.equal(out.body.field, "kind");
    // Off WITHOUT blockManualWhenOff: manual runs are allowed.
    store.set("appConfig/scraperSettings", { news: { enabled: false } });
    out = await call("runScraper", admin({ params: { kind: "news" }, body: {} }));
    assert.equal(out.status, 202);
  });

  test("worker end to end: manual visa run record, runId on the request, claimed once", async () => {
    seedGb();
    const created = await call("runSource", admin({ params: { kind: "visa", id: CC }, body: {} }));
    const { requestId } = created.body.data;
    // The real orchestrator (stubbed adapter + LLM), fixed tick time.
    const real = crawl;
    worker.overrides = {
      loadSettings: async () => settingsWith({ visa: { maxExtractionsPerRun: 1 } }),
      visa: { runOrchestrator: (o: any) => real.runOrchestrator({ ...o, now: NOW, fetchFxRates }) },
    };
    try {
      assert.equal(await withStubs(() => worker.process(requestId)), "succeeded");
      assert.equal(await quiet(() => worker.process(requestId)), null, "a duplicate event is ignored");
    } finally {
      worker.overrides = undefined;
    }
    const r = store.get(`scrapeRunRequests/${requestId}`)!;
    const runs = docsOf("scrapeRuns");
    assert.equal(runs.length, 1);
    assert.equal(runs[0].trigger, "manual");
    assert.equal(r.runId, runs[0].id);
    assert.equal((r.summary as any).sourcesProcessed, 1);
    assert.equal(extractCalls, 1);
    // Poll endpoint.
    const polled = await call("getRequest", admin({ params: { id: requestId } }));
    assert.equal(polled.status, 200);
    assert.equal(polled.body.data.status, "succeeded");
    assert.equal(polled.body.data.runId, runs[0].id);
    assert.equal(typeof polled.body.data.requestedAt, "string");
    assert.equal((await call("getRequest", admin({ params: { id: "nope" } }))).status, 404);
  });

  test("worker: nothing ran -> skipped; orchestrator throws -> failed; lock released either way", async () => {
    store.set("newsSources/cic-news", { id: "cic-news", name: "CIC News", status: "active" });
    for (const [impl, expected] of [
      [async () => ({ sourcesProcessed: 0 }), "skipped"],
      [
        async () => {
          throw new Error("boom apikey=SECRET");
        },
        "failed",
      ],
    ] as const) {
      requests.clock = () => NOW + (expected === "failed" ? 20 * 60 * 1000 : 0);
      const { requestId } = (await call("runSource", admin({ params: { kind: "news", id: "cic-news" }, body: {} }))).body.data;
      worker.overrides = { loadSettings: async () => settingsWith(), news: { runOrchestrator: impl } };
      try {
        assert.equal(await quiet(() => worker.process(requestId)), expected);
      } finally {
        worker.overrides = undefined;
      }
      const r = store.get(`scrapeRunRequests/${requestId}`)!;
      assert.equal(r.status, expected);
      if (expected === "failed") assert.ok(!String(r.error).includes("SECRET"), "error redacted");
      else assert.ok(r.skipReason);
      assert.equal(store.get("scrapeRunLocks/news__cic-news")!.activeRequestId, null);
    }
  });
});

// ============================================
// Alerts: extra recipient emails
// ============================================

describe("alert extra recipient emails", () => {
  test("resolveConfig validates extraRecipientEmails (lower-cased, deduped, max 20)", () => {
    const ok = alertRules.resolveConfig({ extraRecipientEmails: ["A@x.org", "a@x.org"] });
    assert.deepEqual(ok.config.extraRecipientEmails, ["a@x.org"]);
    const bad = alertRules.resolveConfig({ extraRecipientEmails: Array.from({ length: 21 }, (_, i) => `u${i}@x.org`) });
    assert.deepEqual(bad.config.extraRecipientEmails, []);
    assert.equal(bad.problems.length, 1);
  });

  test("a budget_hard_stop alert is emailed to admins AND the extra addresses", async () => {
    const svc = alertsMod.scrapeAlertService;
    const sentTo: string[] = [];
    const notified: string[] = [];
    const orig = { notify: svc.notify, sendEmail: svc.sendEmail, log: svc.log, clock: svc.realClock };
    svc.notify = async (i: any) => {
      notified.push(i.userId);
    };
    svc.sendEmail = async (i: any) => {
      sentTo.push(i.to);
      return { status: "sent" };
    };
    svc.log = () => undefined;
    svc.realClock = () => NOW;
    store.set("users/admin1", { email: "delivered+admin1@resend.dev", admin: true });
    store.set("appConfig/scrapeAlerts", { extraRecipientEmails: ["delivered+ops@resend.dev"] });
    try {
      const result = await quiet(() =>
        svc.onRunFinalized({
          id: "run-x",
          kind: "visa",
          trigger: "manual",
          status: "succeeded",
          startedAt: Timestamp.fromMillis(NOW - 1000),
          finishedAt: Timestamp.fromMillis(NOW),
          durationMs: 1000,
          summary: { errors: 0, budgetHardStop: true, extractionsSkippedBudget: 2 },
          sourcesAttempted: 1,
          pagesAttempted: 1,
          sources: [],
          pages: [],
          pagesTruncated: false,
          errorCount: 0,
          errors: [],
        })
      );
      assert.ok(result.actions.some((a: any) => a.action === "created" && a.alert.rule === "budget_hard_stop"));
      assert.deepEqual(notified, ["admin1"]);
      assert.deepEqual(sentTo, ["delivered+ops@resend.dev"]);
    } finally {
      Object.assign(svc, { notify: orig.notify, sendEmail: orig.sendEmail, log: orig.log, realClock: orig.clock });
    }
  });
});

// ============================================
// Pure validation helpers
// ============================================

describe("validation helpers", () => {
  test("diffValues reports changed, added and removed leaves by path", () => {
    const d = validate.diffValues({ a: { b: 1, c: 2 }, x: [1] }, { a: { b: 1, d: 3 }, x: [2] }, "s");
    assert.deepEqual(d, [
      { path: "s.a.c", before: 2, after: null },
      { path: "s.a.d", before: null, after: 3 },
      { path: "s.x", before: [1], after: [2] },
    ]);
  });

  test("mergeAlertsPatch merges objects, replaces arrays, null drops a rule field", () => {
    const m = validate.mergeAlertsPatch(
      { email: { digest: true, immediate: true }, recipientUserIds: ["a"], rules: { error_rate: { enabled: false, severity: "info" } }, updatedBy: "x" },
      { email: { digest: false }, recipientUserIds: ["b"], rules: { error_rate: { severity: null } } }
    );
    assert.deepEqual(m, {
      email: { digest: false, immediate: true },
      recipientUserIds: ["b"],
      rules: { error_rate: { enabled: false } },
    });
  });
});

// ============================================
// Review fixes (round 1): crawl leases, stale requests, fail closed,
// budget_hard_stop resolution, strict price-table keys
// ============================================

describe("source crawl leases", () => {
  let leasesSvc: any;
  let firebase: any;
  before(async () => {
    leasesSvc = (await import("../../../../src/scrapers/shared/runs/source-lease")).sourceLeaseService;
    firebase = await import("../../../../src/utils/firebase");
  });
  beforeEach(() => {
    leasesSvc.clock = () => NOW;
    requests.leaseClock = () => NOW;
  });

  /** Store a lease doc held by another run until `untilMs`. */
  function holdLease(kind: string, id: string, untilMs: number, runId = "other-run"): void {
    store.set(`scrapeSourceLeases/${kind}__${id}`, {
      kind,
      sourceId: id,
      token: "someone-else",
      trigger: "manual",
      runId,
      acquiredAt: Timestamp.fromMillis(NOW - 60 * 1000),
      expiresAt: Timestamp.fromMillis(untilMs),
    });
  }

  test("a whole-scraper run in flight -> single-source Run now is 409 RUN_IN_PROGRESS", async () => {
    seedGb();
    const all = await call("runScraper", admin({ params: { kind: "visa" }, body: {} }));
    assert.equal(all.status, 202);
    const one = await call("runSource", admin({ params: { kind: "visa", id: CC }, body: {} }));
    assert.equal(one.status, 409);
    assert.equal(one.body.error, "RUN_IN_PROGRESS");
    assert.equal(one.body.requestId, all.body.data.requestId);
  });

  test("a held source lease (any run crawling it) -> Run now is 409 with the holder's runId", async () => {
    seedGb();
    holdLease("visa", CC, NOW + 5 * 60 * 1000, "run-scraper-wide");
    const out = await call("runSource", admin({ params: { kind: "visa", id: CC }, body: {} }));
    assert.equal(out.status, 409);
    assert.equal(out.body.error, "RUN_IN_PROGRESS");
    assert.equal(out.body.runId, "run-scraper-wide");
    assert.equal(out.body.leaseExpiresAt, new Date(NOW + 5 * 60 * 1000).toISOString());
  });

  test("manual GB run holding the lease -> the scheduled tick skips GB (deferred, reason), no fetch", async () => {
    const monday = Date.parse("2026-11-09T02:15:00Z");
    seedGb({ nextCrawlAt: Timestamp.fromMillis(monday - HOUR) });
    holdLease("visa", CC, NOW + 5 * 60 * 1000, "manual-gb-run");
    const before = JSON.stringify(store.get(`visaSources/${CC}`));
    const summary = await withStubs(() => crawl.runOrchestrator({ now: monday, fetchFxRates }));
    assert.equal(summary.sourcesLeased, 1);
    assert.equal(summary.sourcesProcessed, 0);
    assert.equal(summary.pagesFetched, 0);
    assert.equal(extractCalls, 0);
    assert.equal(JSON.stringify(store.get(`visaSources/${CC}`)), before, "source untouched");
    const [run] = docsOf("scrapeRuns");
    const line = (run.sources as any[])[0];
    assert.equal(line.status, "deferred");
    assert.match(line.error, /being crawled by another manual run \(manual-gb-run\)/);
    assert.equal(run.errorCount, 0);
    // The other run's lease is untouched.
    assert.equal(store.get(`scrapeSourceLeases/visa__${CC}`)!.token, "someone-else");
  });

  test("an expired lease is reclaimed; the run releases its own lease when done", async () => {
    seedGb();
    holdLease("visa", CC, NOW - 1000); // expired
    const summary = await withStubs(() => crawl.runOrchestrator({ now: NOW, fetchFxRates, trigger: "manual", sourceId: CC }));
    assert.equal(summary.sourcesProcessed, 1);
    assert.equal(summary.sourcesLeased, 0);
    assert.equal(store.has(`scrapeSourceLeases/visa__${CC}`), false, "released");
  });

  test("news: a held lease defers the source (no scrape), others go on", async () => {
    holdLease("news", "cic-news", NOW + 60 * 1000);
    const scraped: string[] = [];
    const s = new newsMod.NewsScraperService({
      loadSettings: async () => settingsWith(),
      clock: () => NOW,
      store: { getDueSources: async () => [{ id: "cic-news", name: "CIC News", status: "active" }] },
    });
    s.scrapeSource = async (src: any) => {
      scraped.push(src.id);
      return { status: "success", articlesNew: 0 };
    };
    const result = await quiet(() => s.runOrchestrator());
    assert.deepEqual(scraped, []);
    assert.equal(result.sourcesLeased, 1);
    assert.equal((docsOf("scrapeRuns")[0].sources as any[])[0].status, "deferred");
  });

  test("settings unreadable: scheduled ticks fail closed, Run now 503, hourly alert", async () => {
    const orig = firebase.collections.appConfig;
    firebase.collections.appConfig = {
      ...orig,
      doc: (id: string) => (id === "scraperSettings" ? { get: async () => Promise.reject(new Error("unavailable")) } : orig.doc(id)),
    };
    try {
      const monday = Date.parse("2026-11-09T02:15:00Z");
      seedGb({ nextCrawlAt: Timestamp.fromMillis(monday - HOUR) });
      const summary = await withStubs(() => crawl.runOrchestrator({ now: monday, fetchFxRates }));
      assert.equal(summary.sourcesProcessed, 0);
      assert.equal(docsOf("scrapeRuns").length, 0, "tick skipped");
      // News too (default loader).
      const calls: string[] = [];
      const n = new newsMod.NewsScraperService({ store: { getDueSources: async () => (calls.push("due"), []) } });
      await quiet(() => n.runOrchestrator());
      assert.deepEqual(calls, []);
      // Run now refuses (503).
      const out = await call("runSource", admin({ params: { kind: "visa", id: CC }, body: {} }));
      assert.equal(out.status, 503);
      assert.equal(out.body.error, "SETTINGS_UNAVAILABLE");
      // The hourly check raises settings_unreadable.
      const svc = alertsMod.scrapeAlertService;
      const origLog = svc.log;
      svc.log = () => undefined;
      svc.realClock = () => NOW;
      try {
        const r = await quiet(() => svc.runHourlyCheck(NOW));
        assert.ok(r.actions.some((a: any) => a.action === "created" && a.alert.rule === "settings_unreadable"));
      } finally {
        svc.log = origLog;
      }
    } finally {
      firebase.collections.appConfig = orig;
    }
  });
});

describe("stale Run now requests", () => {
  test("a request left running past its deadline reads as failed (timed out); worker sweep too", async () => {
    store.set("scrapeRunRequests/r-old", {
      id: "r-old",
      kind: "visa",
      scope: "source",
      sourceId: CC,
      status: "running",
      requestedAt: Timestamp.fromMillis(NOW - 20 * 60 * 1000),
      startedAt: Timestamp.fromMillis(NOW - 20 * 60 * 1000),
      lockId: "visa__GB",
    });
    store.set("scrapeRunRequests/r-old2", {
      id: "r-old2",
      kind: "news",
      scope: "scraper",
      sourceId: null,
      status: "queued",
      requestedAt: Timestamp.fromMillis(NOW - 16 * 60 * 1000),
      startedAt: null,
      lockId: "news___all",
    });
    const out = await call("getRequest", admin({ params: { id: "r-old" } }));
    assert.equal(out.body.data.status, "failed");
    assert.match(out.body.data.error, /^timed out/);
    // The worker's sweep closes the other one before claiming its own.
    await quiet(() => worker.process("missing-request"));
    assert.equal(store.get("scrapeRunRequests/r-old2")!.status, "failed");
  });
});

describe("budget_hard_stop resolution (review)", () => {
  const run = (summary: any) => ({ id: "r", kind: "visa", status: "succeeded", summary });
  const cfg = () => alertRules.resolveConfig({}).config;

  test("post-run: resolves only when the run checked the budget and found it under", () => {
    const key = alertRules.BUDGET_HARD_STOP_KEY;
    assert.deepEqual(alertRules.evaluateBudgetHardStop(run({ budgetChecked: true, budgetOver: false }), cfg()).scope, { keys: [key] });
    assert.deepEqual(alertRules.evaluateBudgetHardStop(run({ budgetChecked: false }), cfg()).scope, { keys: [] }, "cost unreadable: keep");
    assert.deepEqual(alertRules.evaluateBudgetHardStop(run({ budgetChecked: true, budgetOver: true }), cfg()).scope, { keys: [] }, "still over: keep");
    assert.deepEqual(alertRules.evaluateBudgetHardStop(run({}), cfg()).scope, { keys: [] }, "older run doc: keep");
  });

  test("hourly: clears when the stop is off, no budget, or spend is under; keeps when over", () => {
    const key = alertRules.BUDGET_HARD_STOP_KEY;
    assert.deepEqual(alertRules.evaluateBudgetHardStopClears(false, { monthUsd: 9, budgetUsd: 1 }).scope, { keys: [key] });
    assert.deepEqual(alertRules.evaluateBudgetHardStopClears(true, { monthUsd: 9, budgetUsd: null }).scope, { keys: [key] });
    assert.deepEqual(alertRules.evaluateBudgetHardStopClears(true, { monthUsd: 0.5, budgetUsd: 1 }).scope, { keys: [key] });
    assert.deepEqual(alertRules.evaluateBudgetHardStopClears(true, { monthUsd: 1, budgetUsd: 1 }).scope, { keys: [] });
  });

  test("a hard-stopped visa run sets budgetChecked + budgetOver", async () => {
    seedGb();
    store.set("appConfig/scraperSettings", { budget: { hardStop: true } });
    store.set("appConfig/scrapeBudget", { monthlyUsd: 1 });
    store.set("scrapeCosts/2026-11", { month: "2026-11", totals: { costUsd: 1.5 } });
    const s = await withStubs(() => crawl.runOrchestrator({ now: NOW, fetchFxRates, trigger: "manual", sourceId: CC }));
    assert.equal(s.budgetChecked, true);
    assert.equal(s.budgetOver, true);
  });
});

describe("price table keys (review)", () => {
  const model = {
    inputPer1M: 0.2,
    cachedInputPer1M: 0.02,
    outputPer1M: 0.8,
    sourceUrl: "https://api-docs.deepseek.com/quick_start/pricing",
    effectiveFrom: "2026-09-01",
  };
  test("unknown keys and reserved names are 400s naming the field; nothing stored", async () => {
    const cases: [any, string][] = [
      [{ currency: "USD", verifiedAt: "x", models: { m: model }, extra: 1 }, "pricing.table.extra"],
      [{ currency: "USD", verifiedAt: "x", models: { m: { ...model, typo: 1 } } }, "pricing.table.models.m.typo"],
      [{ currency: "USD", verifiedAt: "x", models: { __name__: model } }, "pricing.table.models"],
      [{ currency: "USD", verifiedAt: "x", models: { "bad key!": model } }, "pricing.table.models"],
      [
        { currency: "USD", verifiedAt: "x", models: { m: model }, requestPricing: { __x__: { perRequestUsd: 0, effectiveFrom: "x", sourceUrl: "x" } } },
        "pricing.table.requestPricing",
      ],
      [
        { currency: "USD", verifiedAt: "x", models: { m: { ...model, offPeak: { inputPer1M: 1, cachedInputPer1M: 1, outputPer1M: 1, x: 2 } } } },
        "pricing.table.models.m.offPeak.x",
      ],
    ];
    for (const [table, field] of cases) {
      const out = await call("patch", admin({ body: { pricing: { table } } }));
      assert.equal(out.status, 400, JSON.stringify(table));
      assert.equal(out.body.field, field);
    }
    assert.equal(store.has("appConfig/llmPricing"), false);
  });
});
