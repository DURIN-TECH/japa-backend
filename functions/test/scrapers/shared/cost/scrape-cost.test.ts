// ============================================
// Unit tests — scrape cost: usage, prices, rollup, report (issue #82)
// ============================================
//
// Run with `npm test`. NO network and NO emulator: Firestore is the in-memory
// fake (test/helpers/fake-firestore.ts), DeepSeek is a stubbed global fetch,
// visa pages come from a stubbed adapter, the news HTTP client is a stub.
//
// Covers:
//  - parseDeepSeekUsage (full, missing cache fields, unusable)
//  - price lookup by name / alias, peak vs off-peak hours, unpriced models,
//    the default table's numbers (quoted from DeepSeek's pricing page)
//  - DeepSeekExtractor reports usage via onUsage, also when validation fails
//  - recorder: usage / costUsd / costBreakdown on the run doc (runs: 1)
//  - monthly rollup: added once per runId (idempotent), by kind / country /
//    model, per-kind maps; monthToDate() shape (#83) with / without budget
//  - report(): groupBy month (zero-filled) / country / model / kind, the kind
//    filter, budget + price provenance; controller 403 / 400 / 200
//  - visa orchestrator end to end: page usage, scrapeMeta.llmUsage, run
//    totals, rollup doc; list items carry usage + costUsd
//  - news orchestrator: API requests per provider on the run
//  - re-extract estimate + averageUsageOf; eval buildResults sums usage

import { test, describe, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Timestamp } from "firebase-admin/firestore";
import { ROLES, defineAbilitiesFor } from "@durin-tech/authz";
import type { Role } from "@durin-tech/authz";

import { Data, installFakes, resetStore, store } from "../../../helpers/fake-firestore";

// Project id (GCLOUD_PROJECT=demo-unit-test) and the no-network guard are set
// centrally by the test preload, test/helpers/setup.ts (issue #94).

/* eslint-disable @typescript-eslint/no-explicit-any */
let pricingMod: any; // scrapers/shared/cost/scrape-cost-pricing (pure)
let costMod: any; // scrapers/shared/cost/scrape-cost.service
let costs: any; // scrapeCostService
let runs: any; // scrapeRunService
let runsMod: any;
let crawl: any;
let adapters: any;
let extractMod: any;
let newsMod: any;
let controller: any;
let evalRun: any;

// Tuesday 2026-11-10 12:00 UTC: OFF-peak (peak is 01-04 and 06-10 UTC Mon-Fri).
const NOW = Date.parse("2026-11-10T12:00:00Z");
// Tuesday 2026-11-10 02:30 UTC: PEAK.
const PEAK = Date.parse("2026-11-10T02:30:00Z");

before(async () => {
  await installFakes();
  pricingMod = await import("../../../../src/scrapers/shared/cost/scrape-cost-pricing");
  costMod = await import("../../../../src/scrapers/shared/cost/scrape-cost.service");
  costs = costMod.scrapeCostService;
  runsMod = await import("../../../../src/scrapers/shared/runs/scrape-run.service");
  runs = runsMod.scrapeRunService;
  crawl = (await import("../../../../src/scrapers/visa-catalog/visa-catalog-crawl.service")).visaCatalogCrawlService;
  adapters = await import("../../../../src/scrapers/visa-catalog/adapters");
  extractMod = await import("../../../../src/scrapers/visa-catalog/visa-catalog-extract.service");
  newsMod = await import("../../../../src/scrapers/news/news-scraper.service");
  controller = (await import("../../../../src/scrapers/shared/runs/scrape-run.controller")).scrapeRunController;
  evalRun = await import("../../../../src/scrapers/visa-catalog/eval/run");
});

beforeEach(() => {
  resetStore();
  costs.clock = () => NOW;
});

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

/** A usage object (cache miss = prompt - hit). */
function usage(prompt: number, completion: number, hit = 0) {
  return { promptTokens: prompt, completionTokens: completion, cacheHitTokens: hit, cacheMissTokens: prompt - hit, totalTokens: prompt + completion };
}

/** All top-level run docs. */
function runDocs(): Data[] {
  return [...store.entries()].filter(([p]) => p.startsWith("scrapeRuns/") && p.split("/").length === 2).map(([, d]) => d);
}

// ============================================
// Pure: usage + prices
// ============================================

describe("parseDeepSeekUsage", () => {
  test("reads the provider's fields", () => {
    assert.deepEqual(
      pricingMod.parseDeepSeekUsage({
        prompt_tokens: 5000,
        completion_tokens: 700,
        total_tokens: 5700,
        prompt_cache_hit_tokens: 3000,
        prompt_cache_miss_tokens: 2000,
      }),
      { promptTokens: 5000, completionTokens: 700, cacheHitTokens: 3000, cacheMissTokens: 2000, totalTokens: 5700 }
    );
  });

  test("missing cache fields: hit 0, miss = prompt; total derived", () => {
    assert.deepEqual(pricingMod.parseDeepSeekUsage({ prompt_tokens: 100, completion_tokens: 10 }), usage(100, 10));
  });

  test("no usable usage -> undefined (never a made-up 0)", () => {
    assert.equal(pricingMod.parseDeepSeekUsage(undefined), undefined);
    assert.equal(pricingMod.parseDeepSeekUsage({ completion_tokens: 3 }), undefined);
    assert.equal(pricingMod.parseDeepSeekUsage({ prompt_tokens: "9", completion_tokens: 3 }), undefined);
  });
});

describe("prices", () => {
  const table = () => pricingMod.DEFAULT_LLM_PRICING;

  test("default table = DeepSeek's published Flash prices, with source + effectiveFrom", () => {
    const flash = table().models["deepseek-flash"];
    assert.deepEqual(
      [flash.inputPer1M, flash.cachedInputPer1M, flash.outputPer1M],
      [0.3, 0.006, 1.2]
    );
    assert.deepEqual(flash.offPeak, { inputPer1M: 0.15, cachedInputPer1M: 0.003, outputPer1M: 0.6 });
    assert.equal(flash.sourceUrl, "https://api-docs.deepseek.com/quick_start/pricing");
    assert.equal(flash.effectiveFrom, "2026-09-10");
  });

  test("deepseek-chat (our extractor's model) resolves to deepseek-flash by alias, case-insensitively", () => {
    assert.equal(pricingMod.findModelPrice(table(), "deepseek-chat").priceKey, "deepseek-flash");
    assert.equal(pricingMod.findModelPrice(table(), "DeepSeek-Flash").priceKey, "deepseek-flash");
    assert.equal(pricingMod.findModelPrice(table(), "gpt-9"), undefined);
  });

  test("peak hours: Mon-Fri 01-04 and 06-10 UTC; weekends and other hours off-peak", () => {
    const flash = table().models["deepseek-flash"];
    assert.equal(pricingMod.isPeakAt(flash, PEAK), true);
    assert.equal(pricingMod.isPeakAt(flash, Date.parse("2026-11-10T09:59:00Z")), true);
    assert.equal(pricingMod.isPeakAt(flash, Date.parse("2026-11-10T10:00:00Z")), false);
    assert.equal(pricingMod.isPeakAt(flash, Date.parse("2026-11-10T04:30:00Z")), false);
    assert.equal(pricingMod.isPeakAt(flash, Date.parse("2026-11-14T02:30:00Z")), false); // Saturday
    assert.equal(pricingMod.isPeakAt(flash, NOW), false);
  });

  test("cost = miss x input + hit x cached + completion x output, at the hour's rate", () => {
    const u = usage(5000, 700, 3000); // miss 2000
    const peak = pricingMod.priceUsageReport({ usage: u, model: "deepseek-chat", atMs: PEAK }, table());
    // (2000 x 0.30 + 3000 x 0.006 + 700 x 1.20) / 1e6
    assert.equal(peak.costUsd, pricingMod.roundUsd((2000 * 0.3 + 3000 * 0.006 + 700 * 1.2) / 1e6));
    assert.equal(peak.peak, true);
    assert.equal(peak.pricedAs, "deepseek-flash");
    const off = pricingMod.priceUsageReport({ usage: u, model: "deepseek-chat", atMs: NOW }, table());
    assert.equal(off.costUsd, pricingMod.roundUsd((2000 * 0.15 + 3000 * 0.003 + 700 * 0.6) / 1e6));
    assert.equal(off.peak, false);
  });

  test("an unpriced model gets NO cost (not 0)", () => {
    const p = pricingMod.priceUsageReport({ usage: usage(10, 1), model: "mystery-model", atMs: NOW }, table());
    assert.equal(p.costUsd, undefined);
    assert.equal("costUsd" in p, false);
  });

  test("an unknown requested name is priced by the served (response) model", () => {
    const p = pricingMod.priceUsageReport(
      { usage: usage(10, 1), model: "alias-we-do-not-know", responseModel: "deepseek-flash", atMs: NOW },
      table()
    );
    assert.equal(p.pricedAs, "deepseek-flash");
    assert.equal(p.responseModel, "deepseek-flash");
  });

  test("months helpers", () => {
    assert.equal(pricingMod.monthKeyUtc(NOW), "2026-11");
    assert.deepEqual(pricingMod.monthsBetween("2025-11", "2026-02"), ["2025-11", "2025-12", "2026-01", "2026-02"]);
    assert.equal(pricingMod.addMonths("2026-01", -1), "2025-12");
    assert.equal(pricingMod.addMonths("2026-11", -5), "2026-06");
    assert.equal(pricingMod.isMonthKey("2026-13"), false);
  });
});

// ============================================
// DeepSeek extractor -> onUsage
// ============================================

describe("DeepSeekExtractor usage", () => {
  /** Stub global fetch with one chat-completions answer. */
  async function withFetch(body: unknown, fn: () => Promise<void>): Promise<void> {
    const origFetch = globalThis.fetch;
    const origKey = process.env.DEEPSEEK_API_KEY;
    process.env.DEEPSEEK_API_KEY = "sk-test";
    globalThis.fetch = (async () => ({ ok: true, status: 200, json: async () => body, text: async () => "" })) as any;
    try {
      await fn();
    } finally {
      globalThis.fetch = origFetch;
      if (origKey === undefined) delete process.env.DEEPSEEK_API_KEY;
      else process.env.DEEPSEEK_API_KEY = origKey;
    }
  }

  test("reports the API's usage + served model, even when the output fails validation", async () => {
    const reports: any[] = [];
    await withFetch(
      {
        model: "deepseek-v4.1-flash",
        usage: { prompt_tokens: 4000, completion_tokens: 600, prompt_cache_hit_tokens: 1000, prompt_cache_miss_tokens: 3000, total_tokens: 4600 },
        choices: [{ message: { content: JSON.stringify({ name: "" }) } }], // invalid -> throws
      },
      async () => {
        const ex = new extractMod.DeepSeekExtractor();
        await assert.rejects(
          ex.extract("text", { url: "https://x", countryName: "UK", routeName: "R", onUsage: (r: any) => reports.push(r) }),
          extractMod.ExtractionValidationError
        );
      }
    );
    assert.equal(reports.length, 1);
    assert.deepEqual(reports[0].usage, { promptTokens: 4000, completionTokens: 600, cacheHitTokens: 1000, cacheMissTokens: 3000, totalTokens: 4600 });
    assert.equal(reports[0].model, "deepseek-chat");
    assert.equal(reports[0].responseModel, "deepseek-v4.1-flash");
    assert.equal(typeof reports[0].atMs, "number");
  });

  test("a throwing onUsage never fails the extraction path; no usage -> no report", async () => {
    await withFetch({ choices: [{ message: { content: "not json" } }] }, async () => {
      const ex = new extractMod.DeepSeekExtractor();
      let called = false;
      await assert.rejects(
        quiet(() => ex.extract("t", { url: "https://x", countryName: "UK", routeName: "R", onUsage: () => (called = true) })),
        /non-JSON/
      );
      assert.equal(called, false);
    });
    await withFetch(
      { usage: { prompt_tokens: 1, completion_tokens: 1 }, choices: [{ message: { content: "not json" } }] },
      async () => {
        const ex = new extractMod.DeepSeekExtractor();
        await assert.rejects(
          quiet(() =>
            ex.extract("t", {
              url: "https://x",
              countryName: "UK",
              routeName: "R",
              onUsage: () => {
                throw new Error("boom");
              },
            })
          ),
          /non-JSON/ // the extractor's own error, not the callback's
        );
      }
    );
  });
});

// ============================================
// Recorder + rollup + monthToDate
// ============================================

describe("run usage + monthly rollup", () => {
  /** Finish a run with priced calls; returns the final doc. */
  async function finishedRun(opts: { kind?: string; startedAtMs?: number; calls?: Array<[string | undefined, string, any, number?]>; requests?: Record<string, number> }) {
    const r = await runs.start({ kind: opts.kind ?? "visa", trigger: "scheduled", startedAtMs: opts.startedAtMs ?? NOW });
    for (const [sourceId, model, u, cost] of opts.calls ?? []) {
      r.recordUsage({ sourceId, model, usage: u, ...(cost !== undefined ? { costUsd: cost } : {}) });
    }
    for (const [p, n] of Object.entries(opts.requests ?? {})) r.recordRequests(p, n);
    return quiet(() => r.finalize({ summary: { errors: 0 }, anySuccess: true }));
  }

  test("finalize writes usage (runs: 1), costUsd and the country / model split", async () => {
    const doc = await finishedRun({
      calls: [
        ["GB", "deepseek-chat", usage(1000, 100, 400), 0.0002],
        ["GB", "deepseek-chat", usage(2000, 200), 0.0004],
        ["KR", "mystery", usage(10, 1)], // unpriced
      ],
    });
    const run = runDocs()[0];
    assert.equal(run.costUsd, 0.0006);
    assert.equal((run.usage as any).runs, 1);
    assert.equal((run.usage as any).extractions, 3);
    assert.equal((run.usage as any).unpricedExtractions, 1);
    assert.equal((run.usage as any).promptTokens, 3010);
    assert.equal((run.usage as any).cacheHitTokens, 400);
    const br = run.costBreakdown as any;
    assert.equal(br.byCountry.GB.extractions, 2);
    assert.equal(br.byCountry.GB.costUsd, 0.0006);
    assert.equal(br.byCountry.GB.runs, 1);
    assert.equal(br.byCountry.KR.unpricedExtractions, 1);
    assert.equal(br.byModel["deepseek-chat"].completionTokens, 300);
    assert.equal(doc.costUsd, 0.0006);
  });

  test("the hook adds each run to scrapeCosts/{month} ONCE (replay is a no-op)", async () => {
    const doc = await finishedRun({ calls: [["GB", "deepseek-chat", usage(1000, 100), 0.001]] });
    const month = store.get("scrapeCosts/2026-11") as any;
    assert.equal(month.month, "2026-11");
    assert.equal(month.totals.runs, 1);
    assert.equal(month.totals.costUsd, 0.001);
    assert.ok(store.get(`scrapeCosts/2026-11/runs/${doc.id}`));
    // A second application of the same run (late finalize / retried hook).
    assert.equal(await costs.applyRun(doc), false);
    assert.equal((store.get("scrapeCosts/2026-11") as any).totals.costUsd, 0.001);
  });

  test("totals by kind, country, model; per-kind maps; months split by startedAt (UTC)", async () => {
    await finishedRun({ calls: [["GB", "deepseek-chat", usage(1000, 100), 0.001]] });
    await finishedRun({ calls: [["KR", "deepseek-chat", usage(500, 50), 0.0005], ["GB", "deepseek-chat", usage(10, 1), 0.00001]] });
    await finishedRun({ kind: "news", requests: { newsdata: 3, newsapi: 1 } });
    await finishedRun({ startedAtMs: Date.parse("2026-10-31T23:59:00Z"), calls: [["GB", "deepseek-chat", usage(1, 1), 0.5]] });
    const nov = store.get("scrapeCosts/2026-11") as any;
    assert.equal(nov.totals.runs, 3);
    assert.equal(nov.totals.costUsd, 0.00151);
    assert.deepEqual(nov.totals.requests, { newsdata: 3, newsapi: 1 });
    assert.equal(nov.byKind.visa.runs, 2);
    assert.equal(nov.byKind.news.runs, 1);
    assert.deepEqual(nov.byKind.news.requests, { newsdata: 3, newsapi: 1 });
    assert.equal(nov.byCountry.GB.runs, 2);
    assert.equal(nov.byCountry.GB.costUsd, 0.00101);
    assert.equal(nov.byCountry.KR.costUsd, 0.0005);
    assert.equal(nov.byKind.visa.byCountry.KR.extractions, 1);
    assert.equal(nov.byModel["deepseek-chat"].extractions, 3);
    assert.equal((store.get("scrapeCosts/2026-10") as any).totals.costUsd, 0.5);
  });

  test("monthToDate(): the #83 shape, with and without a budget", async () => {
    let mtd = await costs.monthToDate(NOW);
    assert.deepEqual(mtd, {
      month: "2026-11",
      costUsd: 0,
      budgetUsd: null,
      budgetUsedFraction: null,
      totals: pricingMod.emptyTotals(),
      byKind: {},
      updatedAt: null,
    });
    await finishedRun({ calls: [["GB", "deepseek-chat", usage(1000, 100), 2.5]] });
    store.set("appConfig/scrapeBudget", { monthlyUsd: 10 });
    mtd = await costs.monthToDate(NOW);
    assert.equal(mtd.costUsd, 2.5);
    assert.equal(mtd.budgetUsd, 10);
    assert.equal(mtd.budgetUsedFraction, 0.25);
    assert.equal(mtd.byKind.visa.costUsd, 2.5);
    assert.equal(mtd.totals.extractions, 1);
    assert.equal(mtd.updatedAt, new Date(NOW).toISOString());
  });

  test("a run doc without usage (pre-#82) is not rolled up", async () => {
    assert.equal(await costs.applyRun({ id: "old", kind: "visa", startedAt: Timestamp.fromMillis(NOW) }), false);
    assert.equal(store.get("scrapeCosts/2026-11"), undefined);
  });

  test("loadPricing: config doc when valid, default table when absent / malformed", async () => {
    assert.equal((await costs.loadPricing()).origin, "default");
    store.set("appConfig/llmPricing", { models: { m: { inputPer1M: "x" } } });
    assert.equal((await quiet(() => costs.loadPricing())).origin, "default");
    assert.equal(await costs.seedPricingIfAbsent(), false); // a doc exists: never overwritten
    store.delete("appConfig/llmPricing");
    assert.equal(await costs.seedPricingIfAbsent(), true);
    const loaded = await costs.loadPricing();
    assert.equal(loaded.origin, "config");
    assert.equal(loaded.pricing.models["deepseek-flash"].outputPer1M, 1.2);
  });
});

// ============================================
// Report + controller
// ============================================

describe("cost report", () => {
  /** Two months of rollups via real runs. */
  async function seedMonths(): Promise<void> {
    const mk = async (kind: string, at: number, calls: Array<[string, string, number]>, requests: Record<string, number> = {}) => {
      const r = await runs.start({ kind, trigger: "scheduled", startedAtMs: at });
      for (const [cc, model, cost] of calls) r.recordUsage({ sourceId: cc, model, usage: usage(100, 10), costUsd: cost });
      for (const [p, n] of Object.entries(requests)) r.recordRequests(p, n);
      await quiet(() => r.finalize({ summary: { errors: 0 }, anySuccess: true }));
    };
    await mk("visa", NOW, [["GB", "deepseek-chat", 0.3], ["KR", "deepseek-chat", 0.1]]);
    await mk("visa", Date.parse("2026-09-15T00:00:00Z"), [["GB", "other-model", 0.2]]);
    await mk("news", NOW, [], { newsdata: 4 });
  }

  test("groupBy month: every month zero-filled oldest first; totals; budget; pricing provenance", async () => {
    await seedMonths();
    store.set("appConfig/scrapeBudget", { monthlyUsd: 2 });
    const rep = await costs.report({ from: "2026-08", to: "2026-11", groupBy: "month" });
    assert.deepEqual(rep.groups.map((g: any) => [g.key, g.costUsd]), [["2026-08", 0], ["2026-09", 0.2], ["2026-10", 0], ["2026-11", 0.4]]);
    assert.equal(rep.totals.costUsd, 0.6);
    assert.equal(rep.totals.runs, 3);
    assert.deepEqual(rep.totals.requests, { newsdata: 4 });
    assert.deepEqual(rep.budget, { monthlyUsd: 2, month: "2026-11", monthToDateUsd: 0.4, usedFraction: 0.2, configPath: "appConfig/scrapeBudget.monthlyUsd" });
    assert.equal(rep.pricing.origin, "default");
    assert.equal(rep.pricing.models[0].model, "deepseek-flash");
    assert.equal(rep.pricing.models[0].sourceUrl, "https://api-docs.deepseek.com/quick_start/pricing");
    assert.equal(rep.pricing.models[0].effectiveFrom, "2026-09-10");
    assert.equal(rep.kind, null);
    assert.equal(rep.currency, "USD");
  });

  test("groupBy country / model / kind, highest cost first; the kind filter applies to each", async () => {
    await seedMonths();
    const by = async (groupBy: string, kind?: string) =>
      (await costs.report({ from: "2026-09", to: "2026-11", groupBy, kind })).groups.map((g: any) => [g.key, g.costUsd]);
    assert.deepEqual(await by("country"), [["GB", 0.5], ["KR", 0.1]]);
    assert.deepEqual(await by("model"), [["deepseek-chat", 0.4], ["other-model", 0.2]]);
    assert.deepEqual(await by("kind"), [["visa", 0.6], ["news", 0]]);
    assert.deepEqual(await by("kind", "news"), [["news", 0]]);
    assert.deepEqual(await by("country", "news"), []);
    assert.deepEqual(await by("month", "news"), [["2026-09", 0], ["2026-10", 0], ["2026-11", 0]]);
    const news = await costs.report({ from: "2026-11", to: "2026-11", groupBy: "month", kind: "news" });
    assert.deepEqual(news.groups[0].requests, { newsdata: 4 });
  });
});

/** A response recorder shaped like Express's. */
function fakeRes() {
  const out: { status: number; body: any } = { status: 200, body: undefined };
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

/** A request with the CASL ability of `role`. */
function req(role: Role, query: Data = {}): any {
  const authz = { uid: `${role}-uid`, role, agencyId: role === ROLES.OWNER || role === ROLES.AGENT ? "ag1" : null };
  return { params: {}, query, body: {}, userId: authz.uid, authz, ability: defineAbilitiesFor(authz) };
}

/** Call a controller handler. */
async function call(handler: string, r: any) {
  const { res, out } = fakeRes();
  await quiet(() => controller[handler](r, res));
  return out;
}

describe("GET /admin/scrape-costs controller", () => {
  test("403 for owner / agent / client", async () => {
    for (const role of [ROLES.OWNER, ROLES.AGENT, ROLES.CLIENT] as Role[]) {
      assert.equal((await call("costs", req(role))).status, 403);
    }
  });

  test("admin 200 with defaults (6 months to the current month), months and ISO bounds accepted", async () => {
    const ok = await call("costs", req(ROLES.ADMIN));
    assert.equal(ok.status, 200);
    assert.equal(ok.body.data.groupBy, "month");
    assert.equal(ok.body.data.groups.length, 6);
    const iso = await call("costs", req(ROLES.ADMIN, { from: "2026-01-15", to: "2026-03-01T00:00:00Z", groupBy: "kind", kind: "visa" }));
    assert.equal(iso.status, 200);
    assert.equal(iso.body.data.from, "2026-01");
    assert.equal(iso.body.data.to, "2026-03");
    assert.equal(iso.body.data.kind, "visa");
  });

  test("400 on bad groupBy / kind / dates / from > to / > 24 months / repeated params", async () => {
    const bad = async (q: Data) => (await call("costs", req(ROLES.ADMIN, q))).status;
    assert.equal(await bad({ groupBy: "day" }), 400);
    assert.equal(await bad({ kind: "jobs" }), 400);
    assert.equal(await bad({ from: "nope" }), 400);
    assert.equal(await bad({ from: "2026-05", to: "2026-04" }), 400);
    assert.equal(await bad({ from: "2024-01", to: "2026-01" }), 400); // 25 months
    assert.equal(await bad({ from: "2024-02", to: "2026-01" }), 200); // 24 months
    assert.equal(await bad({ kind: ["visa", "news"] }), 400);
  });
});

// ============================================
// Orchestrators end to end
// ============================================

describe("visa orchestrator records cost", () => {
  const PAGE = "https://www.gov.uk/skilled-worker-visa";

  test("page line, scrapeMeta, run totals, rollup and list item carry usage + cost", async () => {
    store.set("visaSources/GB", {
      countryCode: "GB",
      countryName: "United Kingdom",
      status: "active",
      nextCrawlAt: Timestamp.fromMillis(NOW - 1000),
      crawlIntervalHours: 168,
      consecutiveFailures: 0,
      reliabilityScore: 100,
      pages: [{ url: PAGE, routeName: "Skilled Worker visa", visaId: "gb-skilled-worker" }],
    });
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
        contentHash: "h-ok",
      }),
    };
    // Stub extractor that reports usage like DeepSeek does (atMs = off-peak NOW).
    extractMod.visaCatalogExtractor.extract = async (_t: string, ctx: any) => {
      ctx.onUsage?.({ usage: usage(5000, 700, 3000), model: "deepseek-chat", responseModel: "deepseek-v4.1-flash", atMs: NOW });
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
      await quiet(() => crawl.runOrchestrator({ now: NOW, fetchFxRates: async () => ({ rates: {}, rateDate: "2026-11-09" }) }));
    } finally {
      adapters.sourceAdapters["generic-html"] = origAdapter;
      extractMod.visaCatalogExtractor.extract = origExtract;
    }
    const expectedCost = pricingMod.roundUsd((2000 * 0.15 + 3000 * 0.003 + 700 * 0.6) / 1e6);
    const run = runDocs()[0] as any;
    // Page line
    const page = run.pages[0];
    assert.equal(page.outcome, "created");
    assert.deepEqual(page.usage, usage(5000, 700, 3000));
    assert.equal(page.costUsd, expectedCost);
    assert.equal(page.model, "deepseek-chat");
    // Served model "deepseek-v4.1-flash" is not in the table -> priced by the requested alias.
    assert.equal(page.pricedAs, "deepseek-flash");
    assert.equal(page.promptVersion, extractMod.EXTRACTOR_PROMPT_VERSION);
    // Run totals
    assert.equal(run.costUsd, expectedCost);
    assert.equal(run.usage.extractions, 1);
    assert.equal(run.costBreakdown.byCountry.GB.costUsd, expectedCost);
    // scrapeMeta on the visa doc
    const visa = store.get("countries/GB/visaTypes/gb-skilled-worker") as any;
    assert.deepEqual(visa.scrapeMeta.llmUsage, usage(5000, 700, 3000));
    assert.equal(visa.scrapeMeta.llmCostUsd, expectedCost);
    assert.equal(visa.scrapeMeta.llmResponseModel, "deepseek-v4.1-flash");
    assert.equal(visa.scrapeMeta.extractorPromptVersion, extractMod.EXTRACTOR_PROMPT_VERSION);
    // Rollup
    assert.equal((store.get("scrapeCosts/2026-11") as any).byCountry.GB.costUsd, expectedCost);
    // List item
    const list = await runs.listRuns({ limit: 5 });
    assert.equal(list.items[0].costUsd, expectedCost);
    assert.equal(list.items[0].usage.promptTokens, 5000);
  });
});

describe("news orchestrator counts API requests per provider", () => {
  test("usage.requests.newsdata on the run and in the rollup", async () => {
    const prev = process.env.NEWS_API_KEY_NEWSDATA;
    process.env.NEWS_API_KEY_NEWSDATA = "k";
    const scraper = new newsMod.NewsScraperService({
      http: { get: async () => ({ status: 200, data: JSON.stringify({ results: [] }), headers: {} }) },
      store: {
        getDueSources: async () => [
          { id: "api1", name: "API", strategy: "news_api", url: "https://newsdata.io/", countryCodes: ["GB"], config: { maxArticlesPerRun: 10, fetchFullContent: false, apiConfig: { provider: "newsdata", query: "visa" } } },
        ],
        createScrapeRun: async () => "log",
        isDuplicate: async () => false,
        createArticlesBatch: async (a: unknown[]) => a.length,
        updateSourceAfterScrape: async () => undefined,
        completeScrapeRun: async () => undefined,
      },
      minIntervalMs: 0,
      clock: () => NOW,
    });
    try {
      await quiet(() => scraper.runOrchestrator());
    } finally {
      if (prev === undefined) delete process.env.NEWS_API_KEY_NEWSDATA;
      else process.env.NEWS_API_KEY_NEWSDATA = prev;
    }
    const run = runDocs()[0] as any;
    assert.deepEqual(run.usage.requests, { newsdata: 1 });
    assert.equal(run.costUsd, 0); // no per-call price configured
    assert.deepEqual((store.get("scrapeCosts/2026-11") as any).byKind.news.requests, { newsdata: 1 });
  });
});

// ============================================
// Estimate + eval
// ============================================

describe("re-extract estimate", () => {
  test("pages x average recorded usage x price, peak and off-peak", () => {
    const average = pricingMod.averageUsageOf([
      { ...pricingMod.emptyTotals(), extractions: 2, promptTokens: 8000, completionTokens: 1000, cacheHitTokens: 4000, cacheMissTokens: 4000 },
      { ...pricingMod.emptyTotals(), extractions: 0 }, // ignored
      undefined,
    ]);
    assert.deepEqual(average, { extractions: 2, promptTokens: 4000, completionTokens: 500, cacheHitTokens: 2000, cacheMissTokens: 2000 });
    const e = pricingMod.estimateReextractCost({ pages: 10, model: "deepseek-chat", pricing: pricingMod.DEFAULT_LLM_PRICING, average });
    const peakOne = pricingMod.roundUsd((2000 * 0.3 + 2000 * 0.006 + 500 * 1.2) / 1e6);
    assert.equal(e.perExtractionUsd.peak, peakOne);
    assert.equal(e.totalUsd.peak, pricingMod.roundUsd(peakOne * 10));
    assert.ok(e.totalUsd.offPeak < e.totalUsd.peak);
    assert.deepEqual(e.estimatedTokens, { prompt: 40000, completion: 5000 });
    assert.equal(e.sourceUrl, "https://api-docs.deepseek.com/quick_start/pricing");
  });

  test("no history or no price -> no USD figure (never a guess)", () => {
    const none = pricingMod.estimateReextractCost({ pages: 3, model: "deepseek-chat", pricing: pricingMod.DEFAULT_LLM_PRICING, average: null });
    assert.equal(none.totalUsd, null);
    const unpriced = pricingMod.estimateReextractCost({
      pages: 3,
      model: "mystery",
      pricing: pricingMod.DEFAULT_LLM_PRICING,
      average: { extractions: 1, promptTokens: 1, completionTokens: 1, cacheHitTokens: 0, cacheMissTokens: 1 },
    });
    assert.equal(unpriced.priceKey, null);
    assert.equal(unpriced.totalUsd, null);
  });

  test("averageVisaUsage reads recorded visa runs", async () => {
    store.set("scrapeRuns/a", { kind: "visa", startedAt: Timestamp.fromMillis(NOW), usage: { extractions: 1, promptTokens: 100, completionTokens: 10 } });
    store.set("scrapeRuns/b", { kind: "news", startedAt: Timestamp.fromMillis(NOW), usage: { extractions: 5, promptTokens: 1, completionTokens: 1 } });
    const avg = await costs.averageVisaUsage();
    assert.equal(avg.extractions, 1);
    assert.equal(avg.promptTokens, 100);
    assert.equal(await (async () => (resetStore(), costs.averageVisaUsage()))(), null);
  });
});

describe("eval results record usage", () => {
  test("buildResults sums route usage + cost with the price provenance", () => {
    const score = { route: "r", score: 1, fields: [] };
    const res = evalRun.buildResults(
      [
        { route: "a", sourceUrl: "u", extracted: null, usage: usage(1000, 100), costUsd: 0.001, score },
        { route: "b", sourceUrl: "u", extracted: null, usage: usage(500, 50), costUsd: 0.0005, score },
        { route: "c", sourceUrl: "u", extracted: null, score }, // no call reached the API
      ],
      { extractorPromptVersion: "v", model: "deepseek-chat", ranAt: "t", gitSha: "s", gitDirty: false, mode: "live" }
    );
    assert.equal(res.usage.extractions, 2);
    assert.equal(res.usage.promptTokens, 1500);
    assert.equal(res.costUsd, 0.0015);
    assert.deepEqual(res.pricing, {
      priceKey: "deepseek-flash",
      sourceUrl: "https://api-docs.deepseek.com/quick_start/pricing",
      effectiveFrom: "2026-09-10",
    });
  });
});

// ============================================
// Review fixes (#82): strict price validation, non-finite costs,
// served-model-first pricing, rollup backfill
// ============================================

describe("review: price table validation + non-finite costs", () => {
  /** A valid table to break one field of. */
  const good = () => JSON.parse(JSON.stringify(pricingMod.DEFAULT_LLM_PRICING));

  test("isValidPricingDoc rejects bad peak / offPeak prices, peak windows, aliases, request prices", () => {
    assert.equal(costMod.isValidPricingDoc(good()), true);
    const broken: Array<(d: any) => void> = [
      (d) => (d.models["deepseek-flash"].outputPer1M = Number.NaN),
      (d) => (d.models["deepseek-flash"].inputPer1M = -1),
      (d) => (d.models["deepseek-flash"].offPeak.cachedInputPer1M = "0.003"),
      (d) => delete d.models["deepseek-flash"].offPeak.outputPer1M,
      (d) => delete d.models["deepseek-flash"].peakWindowsUtc, // offPeak without windows
      (d) => (d.models["deepseek-flash"].peakWindowsUtc[0].endHour = 25),
      (d) => (d.models["deepseek-flash"].peakWindowsUtc[0].startHour = 5), // start >= end (4)
      (d) => (d.models["deepseek-flash"].peakWindowsUtc[1].isoWeekdays = [0, 8]),
      (d) => (d.models["deepseek-flash"].peakWindowsUtc[1].isoWeekdays = []),
      (d) => (d.models["deepseek-flash"].aliases = [42]),
      (d) => delete d.models["deepseek-flash"].sourceUrl,
      (d) => (d.requestPricing = { newsapi: { perRequestUsd: Number.POSITIVE_INFINITY } }),
    ];
    for (const breakIt of broken) {
      const d = good();
      breakIt(d);
      assert.equal(costMod.isValidPricingDoc(d), false, breakIt.toString());
    }
  });

  test("an invalid stored doc falls back to the default table with a console.error", async () => {
    const d = good();
    d.models["deepseek-flash"].offPeak.outputPer1M = null;
    store.set("appConfig/llmPricing", d);
    const errors: string[] = [];
    const orig = console.error;
    console.error = (m: string) => errors.push(String(m));
    try {
      const loaded = await costs.loadPricing();
      assert.equal(loaded.origin, "default");
      assert.equal(loaded.pricing.models["deepseek-flash"].offPeak.outputPer1M, 0.6);
    } finally {
      console.error = orig;
    }
    assert.ok(errors.some((e) => /malformed/.test(e)));
  });

  test("a non-finite cost is UNPRICED in priceUsageReport, accumulators and page fields (never $0 / NaN)", () => {
    const nanTable = { currency: "USD", verifiedAt: "x", models: { m: { inputPer1M: Number.NaN, cachedInputPer1M: 0, outputPer1M: 0, effectiveFrom: "x", sourceUrl: "x" } } };
    const p = pricingMod.priceUsageReport({ usage: usage(100, 10), model: "m", atMs: NOW }, nanTable);
    assert.equal(p.costUsd, undefined);
    assert.equal(p.pricedAs, undefined);

    const t = pricingMod.emptyTotals();
    pricingMod.addPricedUsage(t, { usage: usage(100, 10), model: "m", costUsd: Number.NaN });
    pricingMod.addPricedUsage(t, { usage: usage(100, 10), model: "m", costUsd: Number.POSITIVE_INFINITY });
    pricingMod.addPricedUsage(t, { usage: usage(100, 10), model: "m", costUsd: 0.25 });
    assert.equal(t.extractions, 3);
    assert.equal(t.unpricedExtractions, 2);
    assert.equal(t.costUsd, 0.25);
    assert.equal(Number.isNaN(pricingMod.roundUsd(Number.NaN)), true);
    assert.equal("costUsd" in pricingMod.pageUsageFields({ usage: usage(1, 1), model: "m", costUsd: Number.NaN }, "v"), false);
  });

  test("recorder: a NaN call cost or request cost never reaches the run doc", async () => {
    const r = await runs.start({ kind: "news", trigger: "scheduled", startedAtMs: NOW });
    r.recordUsage({ model: "m", usage: usage(10, 1), costUsd: Number.NaN });
    r.recordRequests("newsapi", 2, Number.NaN);
    await quiet(() => r.finalize({ summary: { errors: 0 }, anySuccess: true }));
    const run = runDocs()[0] as any;
    assert.equal(run.costUsd, 0);
    assert.equal(run.usage.unpricedExtractions, 1);
    assert.deepEqual(run.usage.requests, { newsapi: 2 });
  });
});

describe("review: served model priced first", () => {
  /** Requested alias -> cheap entry; served model -> its own (dearer) entry. */
  const table = {
    currency: "USD",
    verifiedAt: "x",
    models: {
      cheap: { inputPer1M: 1, cachedInputPer1M: 0, outputPer1M: 0, aliases: ["deepseek-chat"], effectiveFrom: "x", sourceUrl: "x" },
      dear: { inputPer1M: 10, cachedInputPer1M: 0, outputPer1M: 0, effectiveFrom: "x", sourceUrl: "x" },
    },
  };

  test("the response model wins over the requested alias; pricedAs records it", () => {
    const p = pricingMod.priceUsageReport({ usage: usage(1_000_000, 0), model: "deepseek-chat", responseModel: "dear", atMs: NOW }, table);
    assert.equal(p.pricedAs, "dear");
    assert.equal(p.costUsd, 10);
    assert.equal(pricingMod.pageUsageFields(p, "v").pricedAs, "dear");
  });

  test("an unknown response model falls back to the requested model / alias", () => {
    const p = pricingMod.priceUsageReport({ usage: usage(1_000_000, 0), model: "deepseek-chat", responseModel: "unknown-x", atMs: NOW }, table);
    assert.equal(p.pricedAs, "cheap");
    assert.equal(p.costUsd, 1);
  });
});

describe("review: rollup backfill", () => {
  /** Finish a visa run whose rollup hook transaction FAILS once. */
  async function runWithFailedHook(startedAtMs: number, cost: number): Promise<any> {
    const origTx = costs.runTransaction;
    costs.runTransaction = async () => {
      throw new Error("firestore unavailable");
    };
    try {
      const r = await runs.start({ kind: "visa", trigger: "scheduled", startedAtMs });
      r.recordUsage({ sourceId: "GB", model: "deepseek-chat", usage: usage(100, 10), costUsd: cost });
      return await quiet(() => r.finalize({ summary: { errors: 0 }, anySuccess: true }));
    } finally {
      costs.runTransaction = origTx;
    }
  }

  test("a run whose hook failed stays costRolledUp:false; backfillRecent adds it once and flags it", async () => {
    const doc = await runWithFailedHook(NOW, 0.5);
    assert.equal(store.get(`scrapeRuns/${doc.id}`)!.costRolledUp, false);
    assert.equal(store.get("scrapeCosts/2026-11"), undefined);
    assert.equal(await quiet(() => costs.backfillRecent(NOW)), 1);
    assert.equal((store.get("scrapeCosts/2026-11") as any).totals.costUsd, 0.5);
    assert.equal(store.get(`scrapeRuns/${doc.id}`)!.costRolledUp, true);
    assert.equal(await costs.backfillRecent(NOW), 0); // idempotent
    assert.equal((store.get("scrapeCosts/2026-11") as any).totals.costUsd, 0.5);
  });

  test("a normal run is flagged by the hook (nothing to backfill)", async () => {
    const r = await runs.start({ kind: "visa", trigger: "scheduled", startedAtMs: NOW });
    r.recordUsage({ sourceId: "GB", model: "deepseek-chat", usage: usage(1, 1), costUsd: 0.1 });
    const doc = await quiet(() => r.finalize({ summary: { errors: 0 }, anySuccess: true }));
    assert.equal(store.get(`scrapeRuns/${doc.id}`)!.costRolledUp, true);
    assert.equal(await costs.backfillRecent(NOW), 0);
  });

  test("covers the current + previous month only, skips running docs, is bounded", async () => {
    await runWithFailedHook(Date.parse("2026-10-31T23:00:00Z"), 0.2); // previous month
    await runWithFailedHook(Date.parse("2026-09-15T00:00:00Z"), 0.3); // too old
    store.set("scrapeRuns/live", { id: "live", kind: "visa", status: "running", costRolledUp: false, startedAt: Timestamp.fromMillis(NOW + 5000), usage: { extractions: 1, costUsd: 9 } });
    await runWithFailedHook(NOW, 0.1);
    await runWithFailedHook(NOW + 1000, 0.1);
    assert.equal(await quiet(() => costs.backfillMonth("2026-11", 1)), 1); // bounded: 1 of 2
    assert.equal(await quiet(() => costs.backfillRecent(NOW)), 2); // Oct run + the other Nov run
    assert.equal((store.get("scrapeCosts/2026-10") as any).totals.costUsd, 0.2);
    assert.equal((store.get("scrapeCosts/2026-11") as any).totals.costUsd, 0.2);
    assert.equal(store.get("scrapeCosts/2026-09"), undefined);
    assert.equal(store.get("scrapeRuns/live")!.costRolledUp, false);
  });

  test("the visa orchestrator backfills at the start of every tick (idle ticks too)", async () => {
    await runWithFailedHook(NOW - 2 * 60 * 60 * 1000, 0.4);
    // No due sources: an idle tick.
    await quiet(() => crawl.runOrchestrator({ now: NOW, fetchFxRates: async () => ({ rates: {}, rateDate: "x" }) }));
    assert.equal((store.get("scrapeCosts/2026-11") as any).totals.costUsd, 0.4);
  });
});
