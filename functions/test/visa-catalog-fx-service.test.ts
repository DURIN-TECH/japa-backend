// ============================================
// Unit tests — FX wiring in the Firestore-backed services (issue #59)
// ============================================
//
// Run with `npm test`. NO network and NO emulator: Firebase Admin is
// initialised against a dummy project id (it connects lazily and nothing here
// ever reaches it), and the collection refs the services use are swapped for
// a tiny in-memory fake. The LLM extractor and the FX fetcher are stubs.
//
// Covers:
//  - runOrchestrator refreshes appConfig/fx once per run; a throwing fetcher
//    keeps the previous doc and the run continues
//  - runOrchestrator weekly night window (issue #63): only due sources inside
//    their local window run; out-of-window ones are untouched; no .limit()
//    before the window filter; nextCrawlAt = next window opening (no drift);
//    catch-up within a night, never twice a night, missed night waits a week;
//    no-window sources keep the interval; FX refresh / re-convert only on a
//    tick that crawls something; broken/paused never run; auto-pause at 5
//  - after a refresh, a stale-flagged pending scraped visa is re-converted
//    from its stored components with ZERO extractor calls, content hash
//    untouched; approved / agent docs are left alone
//  - visaService.updateVisaReviewStatus: approve refused (typed error, no
//    write) for a flagged scraped visa; approving a converted one and
//    rejecting a flagged one both work
//  - visaController.reviewVisa maps the typed error to 409 with the message
//  - runOrchestrator host backoff (issue #64), with a stubbed HTTP client:
//    a 429/503 stops requests to that host for the rest of the run (other
//    hosts continue), the retry-after time is stored on the source, the run
//    counts as a failure (auto-pause at 5), a later run skips the host until
//    then without counting a failure (and defers nextCrawlAt past it), an
//    expired backoff is crawled again and pruned
//  - runOrchestrator prompt-version re-extract (issue #71): an unchanged page
//    whose PENDING scraped doc came from an older extractor prompt is
//    re-extracted (and refreshed); current-version / approved / agent /
//    seeded / rejected docs are not; maxExtractions still caps the run
//  - runOrchestrator restored guide (issue #68): a withdrawn + approved
//    scraped doc whose page is live again goes back to pending_review
//    (same or changed hash), never reactivated; live / rejected / pending /
//    seeded docs get no signal; withdraw → restore → approve → withdraw
//    again sets a fresh staleSince

import { test, describe, before, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { FieldValue, Timestamp } from "firebase-admin/firestore";

import type { VisaType } from "../src/types";
import type { ExtractedFeeComponent, FxRatesDoc } from "../src/types/visa-catalog";
import {
  FEE_NOT_CONVERTED_MESSAGE,
  FX_SOURCE_ECB,
  VisaFeeNotConvertibleError,
  computeFee,
} from "../src/services/visa-catalog-fx";

// Admin init needs a project id (utils/firebase derives the bucket from it).
// Dummy, never contacted.
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || "demo-unit-test";

// ----- In-memory Firestore fake (only what these services call) -----

type Data = Record<string, unknown>;
const store = new Map<string, Data>(); // "path/to/doc" -> data

/** Deep-copy plain objects/arrays; keep class instances (Timestamp,
 *  FieldValue sentinels) by reference so their prototypes survive. */
function clone<T>(v: T): T {
  if (Array.isArray(v)) return v.map(clone) as unknown as T;
  if (v && typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype) {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clone(x)])) as T;
  }
  return v;
}

/** Apply a Firestore-style update with dotted field paths. */
function applyUpdate(target: Data, update: Data): Data {
  const out: Data = clone(target);
  for (const [path, value] of Object.entries(update)) {
    const parts = path.split(".");
    let cur = out as Data;
    for (const p of parts.slice(0, -1)) {
      if (typeof cur[p] !== "object" || cur[p] === null) cur[p] = {};
      cur = cur[p] as Data;
    }
    // FieldValue.delete() sentinel → remove the key, like Firestore.
    if (value instanceof FieldValue && value.isEqual(FieldValue.delete())) delete cur[parts[parts.length - 1]];
    else cur[parts[parts.length - 1]] = value;
  }
  return out;
}

/** A doc ref backed by `store`. */
function fakeDoc(path: string) {
  const ref: any = {
    id: path.split("/").pop()!,
    async get() {
      const d = store.get(path);
      return { id: ref.id, exists: d !== undefined, data: () => (d ? clone(d) : undefined), ref };
    },
    async set(data: Data, opts?: { merge?: boolean }) {
      store.set(path, opts?.merge ? { ...(store.get(path) ?? {}), ...data } : { ...data });
    },
    async update(data: Data) {
      const cur = store.get(path);
      if (!cur) throw new Error(`NOT_FOUND ${path}`);
      store.set(path, applyUpdate(cur, data));
    },
    // Subcollection (the orchestrator writes visaSources/{cc}/crawlRuns).
    collection: (name: string) => fakeCollection(`${path}/${name}`),
  };
  return ref;
}

/** Comparable form of a stored value: Timestamps compare by millis. */
const cmpValue = (v: unknown): unknown => (v instanceof Timestamp ? v.toMillis() : v);

/** Counter for auto-ids handed out by the fake `add()`. */
let autoId = 0;

/** Query state carried by the fake collection (immutable per query). */
interface FakeQuery {
  filters: [string, string, unknown][]; // field, op ("==" | "<="), value
  order?: [string, "asc" | "desc"];
  limit?: number;
}

/** A collection ref / query backed by `store` (direct children only).
 *  `where` / `orderBy` / `limit` return a NEW query, like Firestore (state
 *  never leaks). Supports `==` and `<=` (Timestamps compared by millis; a
 *  missing field never matches `<=`), one orderBy, and a REAL limit, so a
 *  `.limit()` before the window filter would be caught by the tests. */
function fakeCollection(path: string, q: FakeQuery = { filters: [] }): any {
  const col = {
    doc: (id: string) => fakeDoc(`${path}/${id}`),
    where(field: string, op: string, value: unknown) {
      return fakeCollection(path, { ...q, filters: [...q.filters, [field, op, value]] });
    },
    orderBy(field: string, dir: "asc" | "desc" = "asc") {
      return fakeCollection(path, { ...q, order: [field, dir] });
    },
    limit(n: number) {
      return fakeCollection(path, { ...q, limit: n });
    },
    // Auto-id add (crawlRuns log).
    async add(data: Data) {
      const ref = fakeDoc(`${path}/auto-${++autoId}`);
      await ref.set(data);
      return ref;
    },
    async get() {
      let entries = [...store.entries()]
        .filter(([p]) => p.startsWith(`${path}/`) && !p.slice(path.length + 1).includes("/"))
        .filter(([, d]) =>
          q.filters.every(([f, op, v]) => {
            const a = cmpValue(d[f]);
            const b = cmpValue(v);
            if (op === "<=") return a !== undefined && (a as number) <= (b as number);
            return a === b;
          })
        );
      if (q.order) {
        const [f, dir] = q.order;
        entries.sort(([, x], [, y]) => {
          const d = (cmpValue(x[f]) as number) - (cmpValue(y[f]) as number);
          return dir === "asc" ? d : -d;
        });
      }
      if (q.limit !== undefined) entries = entries.slice(0, q.limit);
      const docs = entries
        .map(([p]) => fakeDoc(p))
        .map((ref) => ({ id: ref.id, ref, data: () => clone(store.get(`${path}/${ref.id}`)!) }));
      return { docs, empty: docs.length === 0 };
    },
  };
  return col;
}

// ----- Fixtures -----

const DAY_MS = 24 * 60 * 60 * 1000;
const SW: ExtractedFeeComponent[] = [
  { kind: "application", label: "Application fee", amount: 1000, currency: "GBP", per: "application" },
  { kind: "surcharge", label: "Immigration Health Surcharge", amount: 1000, currency: "GBP", per: "year", years: 3 },
];
// These tests run on the REAL clock (the services call Timestamp.now()), so
// every rate date is relative to today — fixed dates would go stale after
// FX_MAX_RATE_DATE_AGE_DAYS and break the suite.
const isoDaysAgo = (d: number) => new Date(Date.now() - d * DAY_MS).toISOString().slice(0, 10);
const oldFx = (): FxRatesDoc => ({
  base: "USD",
  rates: { GBP: 0.8 },
  fetchedAt: Timestamp.fromMillis(Date.now() - 8 * DAY_MS),
  rateDate: isoDaysAgo(10),
  source: FX_SOURCE_ECB,
});

/** A scraped visa doc whose fee was converted (or flagged) against `fx`. */
function scrapedVisa(fx: FxRatesDoc | undefined, over: Data = {}): Data {
  const { baseCostUsd, feeMeta } = computeFee(SW, fx, Timestamp.now());
  const doc: Data = {
    source: "scraped",
    reviewStatus: "pending_review",
    isActive: false,
    scrapeMeta: { contentHash: "page-hash-1", fee: feeMeta },
    ...over,
  };
  if (baseCostUsd !== undefined) doc.baseCostUsd = baseCostUsd;
  return doc;
}

// ----- Wire the fakes in (dynamic import AFTER the env var is set) -----

/* eslint-disable @typescript-eslint/no-explicit-any */
let firebase: any;
let crawl: any;
let extractMod: any;
let visaSvc: any;
let controller: any;
let catalogSvc: any;
let extractorCalls = 0;

before(async () => {
  firebase = await import("../src/utils/firebase");
  firebase.collections.appConfig = fakeCollection("appConfig");
  firebase.collections.visaSources = fakeCollection("visaSources");
  // Issue #61: reconvertFlaggedFees also scans open pendingVisaChanges rows
  // (empty here), so that collection must be faked too or it would try to
  // reach a real Firestore.
  firebase.collections.pendingVisaChanges = fakeCollection("pendingVisaChanges");
  firebase.collections.countries = fakeCollection("countries");
  firebase.subcollections.visaTypes = (cc: string) => fakeCollection(`countries/${cc}/visaTypes`);

  extractMod = await import("../src/services/visa-catalog-extract.service");
  // Counting stub: no test here may reach the LLM.
  extractMod.visaCatalogExtractor.extract = async () => {
    extractorCalls++;
    throw new Error("extractor must not be called");
  };
  crawl = (await import("../src/services/visa-catalog-crawl.service")).visaCatalogCrawlService;
  // The same instance the orchestrator calls (spied on for re-convert counts).
  catalogSvc = (await import("../src/services/visa-catalog.service")).visaCatalogService;
  visaSvc = (await import("../src/services/visa.service")).visaService;
  controller = (await import("../src/controllers/visa.controller")).visaController;
});

beforeEach(() => {
  store.clear();
  extractorCalls = 0;
  // One registry country (no page due: nextCrawlAt is absent so the due query
  // filter on status is the only one that matters — keep it "paused").
  store.set("visaSources/GB", { countryCode: "GB", status: "paused", pages: [] });
});

// ----- Orchestrator: refresh + re-convert -----

/** ISO weekday (1 = Mon .. 7 = Sun) of `ms`, in UTC. */
const isoWeekdayUtc = (ms: number) => (new Date(ms).getUTCDay() === 0 ? 7 : new Date(ms).getUTCDay());

/** Make the FX tests' tick crawl something (FX only runs then, issue #63):
 *  one active, due source whose window spans the whole UTC day of `tickMs`.
 *  The SAME `tickMs` is passed to runOrchestrator as `now`, so the tick is
 *  always inside the window (no flake if the real clock crosses UTC
 *  midnight mid-test). No pages, so nothing is fetched. */
function putDueAllDaySource(tickMs: number, cc = "FR"): void {
  store.set(`visaSources/${cc}`, {
    countryCode: cc,
    status: "active",
    pages: [],
    crawlIntervalHours: 168,
    consecutiveFailures: 0,
    nextCrawlAt: Timestamp.fromMillis(tickMs - DAY_MS),
    crawlWindow: { timeZone: "UTC", dayOfWeek: isoWeekdayUtc(tickMs), startHour: 0, endHour: 24 },
  });
}

describe("runOrchestrator — FX refresh + re-convert", () => {
  test("refreshes appConfig/fx and re-converts a stale-flagged pending visa with zero extractor calls", async () => {
    store.set("appConfig/fx", oldFx() as unknown as Data);
    store.set("countries/GB/visaTypes/gb-skilled-worker-visa", scrapedVisa(oldFx()));
    // Approved + agent docs with a flagged fee must not be touched.
    store.set("countries/GB/visaTypes/gb-approved", scrapedVisa(oldFx(), { reviewStatus: "approved", baseCostUsd: 1 }));
    store.set("countries/GB/visaTypes/gb-agent", scrapedVisa(oldFx(), { source: "agent", baseCostUsd: 2 }));
    const tickMs = Date.now(); // one fixed tick time for window + orchestrator
    putDueAllDaySource(tickMs);
    const before = store.get("countries/GB/visaTypes/gb-skilled-worker-visa")!;
    assert.equal((before.scrapeMeta as any).fee.fxStale, true);
    assert.equal("baseCostUsd" in before, false);

    let fetches = 0;
    const summary = await crawl.runOrchestrator({
      now: tickMs,
      fetchFxRates: async () => {
        fetches++;
        return { rates: { GBP: 0.8 }, rateDate: isoDaysAgo(3) };
      },
    });

    assert.equal(fetches, 1); // once per run
    assert.equal(summary.fxRefreshed, true);
    assert.equal(summary.feesReconverted, 1);
    assert.equal(extractorCalls, 0);

    const fx = store.get("appConfig/fx")!;
    assert.equal(fx.base, "USD");
    assert.equal(fx.rateDate, isoDaysAgo(3));
    assert.equal(fx.source, FX_SOURCE_ECB);
    assert.ok(fx.fetchedAt instanceof Timestamp);

    const after = store.get("countries/GB/visaTypes/gb-skilled-worker-visa")!;
    const fee = (after.scrapeMeta as any).fee;
    assert.equal(after.baseCostUsd, 5000);
    assert.equal(fee.fxStale, undefined);
    assert.equal(fee.fxMissing, undefined);
    assert.equal(fee.fxDate, isoDaysAgo(3));
    assert.equal((after.scrapeMeta as any).contentHash, "page-hash-1"); // untouched

    assert.equal(store.get("countries/GB/visaTypes/gb-approved")!.baseCostUsd, 1);
    assert.equal((store.get("countries/GB/visaTypes/gb-approved")!.scrapeMeta as any).fee.fxStale, true);
    assert.equal(store.get("countries/GB/visaTypes/gb-agent")!.baseCostUsd, 2);
  });

  test("a throwing fetcher keeps the previous appConfig/fx and the run continues", async () => {
    const previous = oldFx();
    store.set("appConfig/fx", previous as unknown as Data);
    store.set("countries/GB/visaTypes/gb-skilled-worker-visa", scrapedVisa(previous));
    const tickMs = Date.now();
    putDueAllDaySource(tickMs);

    const summary = await crawl.runOrchestrator({
      now: tickMs,
      fetchFxRates: async () => {
        throw new Error("blocked");
      },
    });

    assert.equal(summary.fxRefreshed, false);
    assert.equal(summary.feesReconverted, 0); // stale doc can't clear anything
    assert.deepEqual(store.get("appConfig/fx"), previous); // kept as-is
    // Still flagged, still no cost.
    const doc = store.get("countries/GB/visaTypes/gb-skilled-worker-visa")!;
    assert.equal((doc.scrapeMeta as any).fee.fxStale, true);
    assert.equal("baseCostUsd" in doc, false);
  });
});

// ----- Orchestrator: weekly night window (issue #63) -----
//
// Fixed tick times (injected via `now`), Europe/London:
//  - GMT week: Mon 2026-11-09 02:15 GMT = 02:15Z
//  - BST week: Mon 2026-06-15 02:15 BST = 01:15Z
// GB's window is Mon 02:00-05:00 local (ticks 02:15, 03:15, 04:15).

const HOUR_MS = 60 * 60 * 1000;
const GB_WINDOW = { timeZone: "Europe/London", dayOfWeek: 1, startHour: 2, endHour: 5 };
const at = (iso: string) => Date.parse(iso);

/** An active registry source (no pages → nothing fetched), due since
 *  `dueSince`, with GB's window unless overridden. */
function putSource(cc: string, over: Data = {}, dueSince = "2026-11-02T02:00:00Z"): void {
  store.set(`visaSources/${cc}`, {
    countryCode: cc,
    status: "active",
    pages: [],
    crawlIntervalHours: 168,
    consecutiveFailures: 0,
    reliabilityScore: 100,
    nextCrawlAt: Timestamp.fromMillis(at(dueSince)),
    crawlWindow: GB_WINDOW,
    ...over,
  });
}

/** Stored nextCrawlAt of a source, as an ISO string. */
const nextOf = (cc: string) => (store.get(`visaSources/${cc}`)!.nextCrawlAt as Timestamp).toDate().toISOString();

describe("runOrchestrator — weekly night window", () => {
  // Counting stubs for the FX side: fetcher + re-convert spy.
  let fxFetches = 0;
  let reconverts = 0;
  let origReconvert: any;
  const fetchFxRates = async () => {
    fxFetches++;
    return { rates: { GBP: 0.8 }, rateDate: isoDaysAgo(1) };
  };
  /** Run one tick at `iso` with the stubs (and optional extra options). */
  const tick = (iso: string, extra: Data = {}) => crawl.runOrchestrator({ now: at(iso), fetchFxRates, ...extra });

  beforeEach(() => {
    store.delete("visaSources/GB"); // the shared paused fixture; each test seeds its own
    fxFetches = 0;
    reconverts = 0;
    origReconvert = catalogSvc.reconvertFlaggedFees;
    catalogSvc.reconvertFlaggedFees = async (...args: unknown[]) => {
      reconverts++;
      return origReconvert.apply(catalogSvc, args);
    };
  });
  afterEach(() => {
    catalogSvc.reconvertFlaggedFees = origReconvert;
  });

  test("GB is skipped on a Sunday afternoon: untouched, and no FX refresh / re-convert", async () => {
    putSource("GB");
    const before = clone(store.get("visaSources/GB"));
    const summary = await tick("2026-11-08T15:15:00Z"); // Sun 15:15 GMT
    assert.equal(summary.sourcesProcessed, 0);
    assert.equal(summary.fxRefreshed, false);
    assert.equal(fxFetches, 0); // no Frankfurter call
    assert.equal(reconverts, 0); // no pending-visa scan
    assert.equal(store.has("appConfig/fx"), false);
    assert.deepEqual(store.get("visaSources/GB"), before); // no write, nextCrawlAt unchanged
  });

  test("no due source at all → no FX refresh / re-convert", async () => {
    putSource("GB", {}, "2026-11-16T02:00:00Z"); // not due yet
    const summary = await tick("2026-11-09T02:15:00Z");
    assert.equal(summary.sourcesProcessed, 0);
    assert.equal(summary.fxRefreshed, false);
    assert.equal(fxFetches, 0);
    assert.equal(reconverts, 0);
  });

  test("GB runs at Mon 02:15 GMT → next Monday 02:00 GMT; FX refreshed exactly once", async () => {
    putSource("GB");
    putSource("DE", { crawlWindow: { ...GB_WINDOW, timeZone: "Europe/Berlin" } }); // Mon 03:15 Berlin: also in window
    const summary = await tick("2026-11-09T02:15:00Z");
    assert.equal(summary.sourcesProcessed, 2);
    assert.equal(summary.fxRefreshed, true);
    assert.equal(fxFetches, 1); // once per tick, not per source
    assert.equal(reconverts, 1);
    assert.equal(nextOf("GB"), "2026-11-16T02:00:00.000Z");
    assert.equal(nextOf("DE"), "2026-11-16T01:00:00.000Z"); // Mon 02:00 CET
    const gb = store.get("visaSources/GB")!;
    assert.equal((gb.lastCrawledAt as Timestamp).toMillis(), at("2026-11-09T02:15:00Z"));
    // crawlRuns log is on the injected tick clock too.
    const runs = [...store.entries()].filter(([p]) => p.startsWith("visaSources/GB/crawlRuns/")).map(([, d]) => d);
    assert.equal(runs.length, 1);
    assert.equal((runs[0].startedAt as Timestamp).toMillis(), at("2026-11-09T02:15:00Z"));
    const completed = (runs[0].completedAt as Timestamp).toMillis();
    assert.ok(completed >= at("2026-11-09T02:15:00Z") && completed < at("2026-11-09T02:16:00Z"));
  });

  test("GB runs at Mon 02:15 BST (01:15Z) → next Monday 02:00 BST (01:00Z)", async () => {
    putSource("GB", {}, "2026-06-08T01:00:00Z");
    const summary = await tick("2026-06-15T01:15:00Z");
    assert.equal(summary.sourcesProcessed, 1);
    assert.equal(nextOf("GB"), "2026-06-22T01:00:00.000Z");
  });

  test("DST: next opening stays at local 02:00 across both clock changes", async () => {
    putSource("GB", {}, "2026-03-16T02:00:00Z");
    await tick("2026-03-23T02:15:00Z"); // Mon 02:15 GMT
    assert.equal(nextOf("GB"), "2026-03-30T01:00:00.000Z"); // Mon 02:00 BST
    putSource("GB", {}, "2026-10-12T01:00:00Z");
    await tick("2026-10-19T01:15:00Z"); // Mon 02:15 BST
    assert.equal(nextOf("GB"), "2026-10-26T02:00:00.000Z"); // Mon 02:00 GMT
  });

  test("no drift: a run on the last catch-up tick (04:15) still lands on next Monday 02:00", async () => {
    putSource("GB");
    await tick("2026-11-09T04:15:00Z");
    assert.equal(nextOf("GB"), "2026-11-16T02:00:00.000Z");
  });

  test("the due query has no limit: 4 due out-of-window sources ordered first don't starve the in-window one", async () => {
    // Oldest nextCrawlAt first, all due, all on a Tuesday window (out on a Monday).
    const tue = { ...GB_WINDOW, dayOfWeek: 2 };
    for (const [i, cc] of ["IE", "FR", "KR", "SA"].entries()) {
      putSource(cc, { crawlWindow: tue }, `2026-10-0${i + 1}T02:00:00Z`);
    }
    putSource("GB", {}, "2026-11-02T02:00:00Z"); // youngest: ordered LAST
    const outBefore = ["IE", "FR", "KR", "SA"].map((cc) => clone(store.get(`visaSources/${cc}`)));
    const summary = await tick("2026-11-09T02:15:00Z", { maxSources: 3 });
    assert.equal(summary.sourcesProcessed, 1);
    assert.equal(nextOf("GB"), "2026-11-16T02:00:00.000Z");
    // Out-of-window sources: no write at all (no fetch, nextCrawlAt unchanged).
    assert.deepEqual(
      ["IE", "FR", "KR", "SA"].map((cc) => store.get(`visaSources/${cc}`)),
      outBefore
    );
  });

  test("catch-up: a source left over by maxSources runs on a later tick the same night, and nobody runs twice", async () => {
    for (const [i, cc] of ["GB", "DE", "JP", "QA"].entries()) {
      // All on GB's London window; distinct due times fix the order.
      putSource(cc, {}, `2026-11-02T0${i}:00:00Z`);
    }
    const first = await tick("2026-11-09T02:15:00Z", { maxSources: 3 });
    assert.equal(first.sourcesProcessed, 3);
    assert.equal(nextOf("QA"), "2026-11-02T03:00:00.000Z"); // left over: untouched, still due

    const second = await tick("2026-11-09T03:15:00Z", { maxSources: 3 });
    assert.equal(second.sourcesProcessed, 1); // only QA: the others moved to next week
    assert.equal(nextOf("QA"), "2026-11-16T02:00:00.000Z");

    const third = await tick("2026-11-09T04:15:00Z", { maxSources: 3 });
    assert.equal(third.sourcesProcessed, 0); // never twice in one night
    assert.equal(third.fxRefreshed, false);
  });

  test("a whole missed night: not run mid-week, run at the next window", async () => {
    putSource("GB", {}, "2026-11-02T02:00:00Z"); // its Mon 02-05 window was missed
    const tue = await tick("2026-11-10T02:15:00Z"); // Tuesday
    assert.equal(tue.sourcesProcessed, 0);
    const mon5 = await tick("2026-11-09T05:15:00Z"); // Monday, but after the window
    assert.equal(mon5.sourcesProcessed, 0);
    assert.equal(nextOf("GB"), "2026-11-02T02:00:00.000Z"); // still due, unchanged
    const nextMon = await tick("2026-11-16T02:15:00Z");
    assert.equal(nextMon.sourcesProcessed, 1);
    assert.equal(nextOf("GB"), "2026-11-23T02:00:00.000Z");
  });

  test("a source with no crawlWindow keeps the legacy behaviour (any time, now + crawlIntervalHours)", async () => {
    putSource("XX", { crawlWindow: undefined });
    delete store.get("visaSources/XX")!.crawlWindow;
    const summary = await tick("2026-11-11T13:00:00Z"); // a Wednesday afternoon
    assert.equal(summary.sourcesProcessed, 1);
    assert.equal(nextOf("XX"), new Date(at("2026-11-11T13:00:00Z") + 168 * HOUR_MS).toISOString());
  });

  test("broken / paused sources are never processed, even in window", async () => {
    putSource("GB", { status: "broken" });
    putSource("DE", { status: "paused" });
    const summary = await tick("2026-11-09T02:15:00Z");
    assert.equal(summary.sourcesProcessed, 0);
    assert.equal(fxFetches, 0);
  });

  test("auto-pause after 5 consecutive failures still works", async () => {
    putSource("GB", { consecutiveFailures: 4 }); // no pages → this run fails too
    await tick("2026-11-09T02:15:00Z");
    const gb = store.get("visaSources/GB")!;
    assert.equal(gb.consecutiveFailures, 5);
    assert.equal(gb.status, "broken");
    assert.equal(nextOf("GB"), "2026-11-16T02:00:00.000Z");
  });

  test("an invalid stored window is skipped (logged), not thrown", async () => {
    putSource("GB", { crawlWindow: { ...GB_WINDOW, timeZone: "Mars/Olympus" } });
    const origError = console.error;
    console.error = () => undefined;
    try {
      const summary = await tick("2026-11-09T02:15:00Z");
      assert.equal(summary.sourcesProcessed, 0);
    } finally {
      console.error = origError;
    }
  });
});

// ----- Orchestrator: host backoff on 429/503 (issue #64) -----
//
// The orchestrator gets adapters over a fetch service whose HTTP client is a
// stub (records every requested URL), with no politeness delay and a clock
// fixed at the tick, so Retry-After instants are exact. Pages carry the hash
// of the stub's page text as lastContentHash, so a successful fetch hits the
// hash gate and never reaches the (throwing) extractor stub.

describe("runOrchestrator — host backoff on 429/503", () => {
  const TICK = "2026-11-09T02:15:00Z"; // Mon 02:15 GMT: inside GB_WINDOW
  const tickMs = Date.parse(TICK);
  // Long enough page text to pass the fetch service's 100-char minimum.
  const PAGE_HTML =
    "<html><body><main><h1>Work visa</h1><p>" +
    "You can apply for this visa if you have a job offer from an approved employer. ".repeat(5) +
    "</p></main></body></html>";

  /** A stubbed response (`responseUrl` = post-redirect URL, as axios reports it). */
  type Stub = { status: number; body?: string; headers?: Record<string, unknown>; responseUrl?: string };
  let calls: string[] = [];
  let adapters: any;
  let pageHash = "";

  /** Build adapters over a stub serving `routes` (default: 200 PAGE_HTML; robots.txt 404). */
  async function wire(routes: Record<string, Stub>): Promise<void> {
    const { VisaCatalogFetchService } = await import("../src/services/visa-catalog-fetch.service");
    const { createSourceAdapters } = await import("../src/services/visa-source-adapters");
    calls = [];
    const fetchService = new VisaCatalogFetchService({
      minIntervalMs: 0,
      clock: () => tickMs,
      http: {
        async get(url: string) {
          calls.push(url);
          const r: Stub =
            routes[url] ?? (url.endsWith("/robots.txt") ? { status: 404 } : { status: 200, body: PAGE_HTML });
          return {
            status: r.status,
            data: r.body ?? "",
            headers: r.headers ?? {},
            ...(r.responseUrl ? { request: { res: { responseUrl: r.responseUrl } } } : {}),
          };
        },
      },
    });
    pageHash = fetchService.hash(fetchService.htmlToCleanText(PAGE_HTML));
    adapters = createSourceAdapters(fetchService);
  }

  /** A registry page on `url`, already crawled (hash = the stub's text). */
  const pg = (url: string) => ({ url, routeName: "Route", validation: "text_verified", lastContentHash: pageHash });

  /** An active generic-html source, due, on GB_WINDOW, with `urls` as pages. */
  function putPagedSource(cc: string, urls: string[], over: Data = {}): void {
    putSource(cc, { pages: urls.map(pg), ...over });
  }

  const run = () => crawl.runOrchestrator({ now: tickMs, adapters, fetchFxRates: async () => ({ rates: { GBP: 0.8 }, rateDate: isoDaysAgo(1) }) });
  const src = (cc: string) => store.get(`visaSources/${cc}`)!;
  const pagesOf = (cc: string) => src(cc).pages as any[];

  beforeEach(() => {
    store.delete("visaSources/GB"); // the shared paused fixture
  });

  test("429 (Retry-After seconds): rest of the host skipped, other hosts continue, backoff stored, run counts as a failure", async () => {
    await wire({
      "https://a.example.gov/visas/one": { status: 429, headers: { "retry-after": "3600" } },
    });
    putPagedSource("ZZ", [
      "https://a.example.gov/visas/one",
      "https://a.example.gov/visas/two",
      "https://b.example.gov/visas/three",
    ]);

    const summary = await run();

    // a.example.gov: only robots + the throttled page were requested; page two never was.
    assert.deepEqual(calls, [
      "https://a.example.gov/robots.txt",
      "https://a.example.gov/visas/one",
      "https://b.example.gov/robots.txt",
      "https://b.example.gov/visas/three",
    ]);
    const until = "2026-11-09T03:15:00.000Z";
    const pages = pagesOf("ZZ");
    assert.equal(pages[0].lastError, `host backed off (429), retry after ${until}`);
    assert.equal(pages[1].lastError, `host backed off (429), retry after ${until}`);
    assert.equal(pages[1].lastCrawledAt, undefined); // skipped, not crawled
    assert.equal(pages[2].lastError, undefined); // the other host was fine

    // Stored for the next run.
    const backoffs = src("ZZ").hostBackoffs as any[];
    assert.equal(backoffs.length, 1);
    assert.equal(backoffs[0].host, "a.example.gov");
    assert.equal(backoffs[0].status, 429);
    assert.equal((backoffs[0].until as Timestamp).toDate().toISOString(), until);
    assert.equal((backoffs[0].recordedAt as Timestamp).toMillis(), tickMs);

    // A throttled run is a failure even though one page fetched.
    assert.equal(src("ZZ").consecutiveFailures, 1);
    assert.equal(src("ZZ").status, "active");
    // Not every host is backed off -> normal weekly schedule.
    assert.equal(nextOf("ZZ"), "2026-11-16T02:00:00.000Z");
    assert.equal(summary.hostsBackedOff, 1);
    assert.equal(summary.pagesDeferred, 1);
    assert.equal(summary.pagesFetched, 1);
  });

  test("503 (HTTP-date) with 4 prior failures -> auto-paused (broken)", async () => {
    await wire({
      "https://a.example.gov/visas/one": { status: 503, headers: { "retry-after": "Mon, 09 Nov 2026 04:00:00 GMT" } },
    });
    putPagedSource("ZZ", ["https://a.example.gov/visas/one"], { consecutiveFailures: 4 });

    await run();

    assert.equal(src("ZZ").consecutiveFailures, 5);
    assert.equal(src("ZZ").status, "broken");
    assert.equal(pagesOf("ZZ")[0].lastError, "host backed off (503), retry after 2026-11-09T04:00:00.000Z");
  });

  test("missing Retry-After -> default backoff stored", async () => {
    await wire({ "https://a.example.gov/robots.txt": { status: 429 } }); // throttled on robots.txt itself
    putPagedSource("ZZ", ["https://a.example.gov/visas/one", "https://a.example.gov/visas/two"]);

    await run();

    assert.deepEqual(calls, ["https://a.example.gov/robots.txt"]); // no page request at all
    const backoffs = src("ZZ").hostBackoffs as any[];
    assert.equal((backoffs[0].until as Timestamp).toMillis(), tickMs + 60 * 60 * 1000);
    assert.equal(src("ZZ").consecutiveFailures, 1);
  });

  test("the next run before retry-after: no request, no failure counted, nextCrawlAt deferred past it", async () => {
    await wire({});
    // Stored by an earlier run: a.example.gov asked us to wait until Tue 17 Nov.
    putPagedSource("ZZ", ["https://a.example.gov/visas/one", "https://a.example.gov/visas/two"], {
      consecutiveFailures: 2,
      hostBackoffs: [
        {
          host: "a.example.gov",
          until: Timestamp.fromMillis(Date.parse("2026-11-17T00:00:00Z")),
          status: 429,
          recordedAt: Timestamp.fromMillis(Date.parse("2026-11-02T02:15:00Z")),
        },
      ],
    });

    const summary = await run();

    assert.deepEqual(calls, []); // the host was not contacted
    assert.equal(summary.pagesDeferred, 2);
    assert.equal(summary.hostsBackedOff, 0);
    assert.equal(src("ZZ").consecutiveFailures, 2); // a deferral is not a failure
    assert.match(pagesOf("ZZ")[0].lastError, /^host backed off \(429\), retry after 2026-11-17T00:00:00.000Z$/);
    // Next Monday (16th) is before the retry-after -> the Monday after.
    assert.equal(nextOf("ZZ"), "2026-11-23T02:00:00.000Z");
    assert.equal((src("ZZ").hostBackoffs as any[]).length, 1); // kept
  });

  test("an expired stored backoff: host crawled again, entry pruned, success resets failures", async () => {
    await wire({});
    putPagedSource("ZZ", ["https://a.example.gov/visas/one"], {
      consecutiveFailures: 1,
      hostBackoffs: [
        {
          host: "a.example.gov",
          until: Timestamp.fromMillis(tickMs - 1000),
          status: 503,
          recordedAt: Timestamp.fromMillis(tickMs - 7 * DAY_MS),
        },
      ],
    });

    await run();

    assert.deepEqual(calls, ["https://a.example.gov/robots.txt", "https://a.example.gov/visas/one"]);
    assert.deepEqual(src("ZZ").hostBackoffs, []);
    assert.equal(src("ZZ").consecutiveFailures, 0);
    assert.equal(pagesOf("ZZ")[0].lastError, undefined);
  });

  test("429 after a cross-host redirect: backoff stored for the final AND the requested host", async () => {
    await wire({
      "https://a.example.gov/visas/one": {
        status: 429,
        headers: { "retry-after": "3600" },
        responseUrl: "https://cdn.example.net/visas/one",
      },
    });
    putPagedSource("ZZ", ["https://a.example.gov/visas/one", "https://a.example.gov/visas/two"], {
      nextCrawlAt: Timestamp.fromMillis(Date.parse("2026-11-01T00:00:00Z")), // processed first
    });
    // A later source whose page is ON the redirect target host.
    putPagedSource("YY", ["https://cdn.example.net/visas/three"]);

    await run();

    // The final (throttling) host is blocked for the rest of the run too.
    assert.equal(calls.some((u) => u.startsWith("https://cdn.example.net/")), false);
    assert.match(pagesOf("YY")[0].lastError, /^host backed off \(429\)/);
    // The second page on the same origin is NOT requested (it would be
    // redirected straight back to the host that throttled us).
    assert.equal(calls.filter((u) => u.includes("/visas/")).length, 1);
    // Only a.example.gov is a page host, so only it is persisted on this source.
    const hosts = (src("ZZ").hostBackoffs as any[]).map((b) => b.host);
    assert.deepEqual(hosts, ["a.example.gov"]);
    assert.equal(src("ZZ").consecutiveFailures, 1);
  });

  test("a host that throttled one source is not requested by a later source in the same run", async () => {
    await wire({ "https://a.example.gov/visas/one": { status: 429, headers: { "retry-after": "60" } } });
    putPagedSource("AA", ["https://a.example.gov/visas/one"], { nextCrawlAt: Timestamp.fromMillis(Date.parse("2026-11-01T00:00:00Z")) });
    putPagedSource("BB", ["https://a.example.gov/visas/two"]); // due later -> processed second

    await run();

    assert.equal(calls.filter((u) => u.includes("/visas/")).length, 1); // only AA's page
    assert.match(pagesOf("BB")[0].lastError, /^host backed off \(429\)/);
    assert.equal(src("BB").consecutiveFailures, 0); // BB was only deferred
  });
});

// ----- Orchestrator: re-extract pending docs from an older prompt (issue #71) -----
//
// Every page here is UNCHANGED (its stored lastContentHash = the stub's text
// hash, and the doc's scrapeMeta.contentHash = the same hash), so before #71
// the hash gate would skip all of them. Only a PENDING scraped doc whose
// scrapeMeta.extractorPromptVersion ≠ EXTRACTOR_PROMPT_VERSION may now reach
// the extractor, and only within maxExtractions.

describe("runOrchestrator — prompt-version re-extract (issue #71)", () => {
  const TICK = "2026-11-09T02:15:00Z"; // Mon 02:15 GMT: inside GB_WINDOW
  const tickMs = Date.parse(TICK);
  // Long enough page text to pass the fetch service's 100-char minimum.
  const PAGE_HTML =
    "<html><body><main><h1>Work visa</h1><p>" +
    "You can apply for this visa if you have a job offer from an approved employer. ".repeat(5) +
    "</p></main></body></html>";
  const OLD_VERSION = "2026-10-old-prompt";
  let adapters: any;
  let pageHash = "";
  let extractCalls: string[] = []; // URLs the (stubbed) extractor was asked for
  let originalExtract: any;

  before(async () => {
    // Adapters over a stub HTTP client: every page answers 200 PAGE_HTML,
    // robots.txt 404 (allowed). No network.
    const { VisaCatalogFetchService } = await import("../src/services/visa-catalog-fetch.service");
    const { createSourceAdapters } = await import("../src/services/visa-source-adapters");
    const fetchService = new VisaCatalogFetchService({
      minIntervalMs: 0,
      clock: () => tickMs,
      http: {
        async get(url: string) {
          return url.endsWith("/robots.txt")
            ? { status: 404, data: "", headers: {} }
            : { status: 200, data: PAGE_HTML, headers: {} };
        },
      },
    });
    pageHash = fetchService.hash(fetchService.htmlToCleanText(PAGE_HTML));
    adapters = createSourceAdapters(fetchService);
  });

  beforeEach(() => {
    store.delete("visaSources/GB"); // the shared paused fixture
    extractCalls = [];
    // Valid extraction stub (counts calls) for this block only; the file-wide
    // stub (which throws) is restored in afterEach.
    originalExtract = extractMod.visaCatalogExtractor.extract;
    extractMod.visaCatalogExtractor.extract = async (_text: string, ctx: { url: string }) => {
      extractCalls.push(ctx.url);
      return {
        name: "Work visa", code: "W", description: "d", category: "work",
        processingTime: "3 weeks", processingDaysMin: 15, processingDaysMax: 21,
        feeComponents: [SW[0]], validityPeriod: "5 years", isExtendable: true,
        eligibilityCriteria: ["x"], confidence: 0.9, citations: { "fee.application": "a" },
      };
    };
  });

  afterEach(() => {
    extractMod.visaCatalogExtractor.extract = originalExtract;
  });

  /** Page URL + pinned visaId for slot `n` (pinned so the doc path is known). */
  const url = (n: string) => `https://a.example.gov/visas/${n}`;
  const docPath = (n: string) => `countries/ZZ/visaTypes/zz-${n}`;

  /** An active, due ZZ source on GB_WINDOW whose pages were already crawled
   *  (lastContentHash = the stub's hash, so the hash gate sees no change). */
  function putZz(names: string[]): void {
    putSource("ZZ", {
      pages: names.map((n) => ({
        url: url(n),
        routeName: `Route ${n}`,
        validation: "text_verified",
        visaId: `zz-${n}`,
        lastContentHash: pageHash,
      })),
    });
  }

  /** A stored doc at slot `n`, same content hash as the page. */
  function putDoc(n: string, over: Data, promptVersion: string | undefined): void {
    const scrapeMeta: Data = { contentHash: pageHash };
    if (promptVersion !== undefined) scrapeMeta.extractorPromptVersion = promptVersion;
    store.set(docPath(n), { source: "scraped", reviewStatus: "pending_review", isActive: false, scrapeMeta, ...over });
  }

  const run = (maxExtractions?: number) =>
    crawl.runOrchestrator({
      now: tickMs,
      adapters,
      maxExtractions,
      fetchFxRates: async () => ({ rates: { GBP: 0.8 }, rateDate: isoDaysAgo(1) }),
    });

  test("pending doc from an older prompt (or with no version) is re-extracted and refreshed", async () => {
    putZz(["old", "none"]);
    putDoc("old", {}, OLD_VERSION);
    putDoc("none", {}, undefined); // pre-#59 doc: no extractorPromptVersion at all

    const summary = await run();

    assert.deepEqual(extractCalls.sort(), [url("none"), url("old")]);
    assert.equal(summary.promptReextracts, 2);
    assert.equal(summary.pagesChanged, 0); // the page text did NOT change
    assert.equal(summary.updated, 2); // refreshed in place, not "unchanged"
    for (const n of ["old", "none"]) {
      const doc = store.get(docPath(n))!;
      assert.equal((doc.scrapeMeta as any).extractorPromptVersion, extractMod.EXTRACTOR_PROMPT_VERSION);
      assert.equal((doc.scrapeMeta as any).contentHash, pageHash);
      assert.ok((doc.scrapeMeta as any).fee); // the new prompt's fee block reached it
      assert.equal(doc.reviewStatus, "pending_review");
      assert.equal(doc.isActive, false);
    }
  });

  test("pending doc on the current prompt is NOT re-extracted (hash gate as before)", async () => {
    putZz(["cur"]);
    putDoc("cur", {}, extractMod.EXTRACTOR_PROMPT_VERSION);
    const before = store.get(docPath("cur"));

    const summary = await run();

    assert.equal(extractCalls.length, 0);
    assert.equal(summary.promptReextracts, 0);
    assert.deepEqual(store.get(docPath("cur")), before);
  });

  test("approved / agent / seeded / rejected docs from an older prompt are untouched (no LLM, no proposal)", async () => {
    putZz(["approved", "agent", "seeded", "rejected", "missing"]);
    putDoc("approved", { reviewStatus: "approved", isActive: true }, OLD_VERSION);
    putDoc("agent", { source: "agent", reviewStatus: "approved" }, OLD_VERSION);
    putDoc("seeded", { source: undefined, reviewStatus: undefined }, OLD_VERSION);
    putDoc("rejected", { reviewStatus: "rejected" }, OLD_VERSION);
    // "missing": no doc at all → nothing to re-extract (unchanged page).
    const before = ["approved", "agent", "seeded", "rejected"].map((n) => store.get(docPath(n)));

    const summary = await run();

    assert.equal(extractCalls.length, 0);
    assert.equal(summary.promptReextracts, 0);
    assert.equal(summary.proposed, 0);
    assert.deepEqual(["approved", "agent", "seeded", "rejected"].map((n) => store.get(docPath(n))), before);
    assert.equal(store.get(docPath("missing")), undefined);
    // No pendingVisaChanges row for the approved doc (#61 needs a real change).
    assert.equal([...store.keys()].filter((k) => k.startsWith("pendingVisaChanges/")).length, 0);
  });

  test("stays within maxExtractions: a version bump drains over several runs", async () => {
    putZz(["a", "b", "c"]);
    for (const n of ["a", "b", "c"]) putDoc(n, {}, OLD_VERSION);

    // Run 1: cap 2 → only two LLM calls.
    const first = await run(2);
    assert.equal(extractCalls.length, 2);
    assert.equal(first.promptReextracts, 2);
    const stale = ["a", "b", "c"].filter(
      (n) => (store.get(docPath(n))!.scrapeMeta as any).extractorPromptVersion === OLD_VERSION
    );
    assert.equal(stale.length, 1); // one left for a later run

    // Run 2 (source made due again, same tick): only the leftover is extracted;
    // the two refreshed docs are now on the current version → hash-gated.
    store.set("visaSources/ZZ", { ...store.get("visaSources/ZZ")!, nextCrawlAt: Timestamp.fromMillis(tickMs - HOUR_MS) });
    extractCalls = [];
    const second = await run(2);
    assert.deepEqual(extractCalls, [url(stale[0])]);
    assert.equal(second.promptReextracts, 1);
    for (const n of ["a", "b", "c"]) {
      assert.equal(
        (store.get(docPath(n))!.scrapeMeta as any).extractorPromptVersion,
        extractMod.EXTRACTOR_PROMPT_VERSION
      );
    }
  });
});

// ----- Orchestrator: restored GOV.UK guide → admin review signal (issue #68) -----

describe("runOrchestrator — restored guide (issue #68)", () => {
  const TICK = "2026-11-09T02:15:00Z"; // Mon 02:15 GMT: inside GB_WINDOW
  const tickMs = Date.parse(TICK);
  const URL_A = "https://www.gov.uk/zz-work-visa";
  const DOC = "countries/ZZ/visaTypes/zz-work";
  // What the stub adapter answers: withdrawn or live, and with which hash.
  let withdrawnNow = false;
  let hashNow = "hash-1";
  let extractCalls = 0;
  let originalExtract: any;

  /** Stub adapter set: both ids map to one adapter that handles every URL
   *  and returns a document shaped by `withdrawnNow` / `hashNow`. No network. */
  const stubAdapter = {
    id: "generic-html",
    canHandle: () => true,
    async fetch(page: { url: string }) {
      return withdrawnNow
        ? { url: page.url, withdrawn: true, sections: [], text: "", contentHash: "empty" }
        : {
            url: page.url,
            withdrawn: false,
            sections: [{ slug: "page", title: "t", text: "Work visa text" }],
            text: "Work visa text",
            contentHash: hashNow,
          };
    },
  };
  const adapters: any = { "generic-html": stubAdapter, "govuk-content-api": stubAdapter };

  beforeEach(() => {
    store.delete("visaSources/GB"); // the shared paused fixture
    withdrawnNow = false;
    hashNow = "hash-1";
    extractCalls = 0;
    // Valid extraction stub (counts calls); the file-wide throwing stub is
    // restored in afterEach.
    originalExtract = extractMod.visaCatalogExtractor.extract;
    extractMod.visaCatalogExtractor.extract = async () => {
      extractCalls++;
      return {
        name: "Work visa (restored)", code: "W", description: "d", category: "work",
        processingTime: "3 weeks", processingDaysMin: 15, processingDaysMax: 21,
        feeComponents: [SW[0]], validityPeriod: "5 years", isExtendable: true,
        eligibilityCriteria: ["x"], confidence: 0.9, citations: { "fee.application": "a" },
      };
    };
  });

  afterEach(() => {
    extractMod.visaCatalogExtractor.extract = originalExtract;
  });

  /** One due ZZ source, one page pinned to zz-work, last crawled at `lastHash`. */
  function putZz(lastHash = "hash-1"): void {
    putSource("ZZ", {
      pages: [{ url: URL_A, routeName: "Work", validation: "text_verified", visaId: "zz-work", lastContentHash: lastHash }],
    });
  }

  /** The stored zz-work doc: approved scraped visa, current prompt, hash-1. */
  function putDoc(over: Data = {}): void {
    store.set(DOC, {
      source: "scraped",
      reviewStatus: "approved",
      isActive: true,
      name: "Work visa",
      scrapeMeta: { contentHash: "hash-1", extractorPromptVersion: extractMod.EXTRACTOR_PROMPT_VERSION },
      ...over,
    });
  }

  /** Run one tick; the source is made due again first (same tick clock). */
  const run = () => {
    const src = store.get("visaSources/ZZ");
    if (src) store.set("visaSources/ZZ", { ...src, nextCrawlAt: Timestamp.fromMillis(tickMs - HOUR_MS) });
    return crawl.runOrchestrator({
      now: tickMs,
      adapters,
      fetchFxRates: async () => ({ rates: { GBP: 0.8 }, rateDate: isoDaysAgo(1) }),
    });
  };

  test("withdrawn approved doc whose page is live again (same hash) → pending_review, still inactive, staleSince kept", async () => {
    const stale = Timestamp.fromMillis(1_700_000_000_000);
    putZz();
    putDoc({ isActive: false, staleSince: stale });

    const summary = await run();

    const doc = store.get(DOC)!;
    assert.equal(summary.restored, 1);
    assert.equal(doc.reviewStatus, "pending_review"); // shows in admin Visa Review
    assert.equal(doc.isActive, false); // never auto-reactivated
    assert.equal((doc.staleSince as Timestamp).toMillis(), stale.toMillis());
    assert.equal(extractCalls, 0); // unchanged text: no LLM call
    // The flag goes on the doc itself, no #61 proposal row.
    assert.equal([...store.keys()].filter((k) => k.startsWith("pendingVisaChanges/")).length, 0);
  });

  test("restored with CHANGED text → flagged, then refreshed in place with the new extraction", async () => {
    putZz("hash-1");
    putDoc({ isActive: false, staleSince: Timestamp.fromMillis(1) });
    hashNow = "hash-2";

    const summary = await run();

    const doc = store.get(DOC)!;
    assert.equal(summary.restored, 1);
    assert.equal(summary.updated, 1); // pending_review branch: refresh in place
    assert.equal(extractCalls, 1);
    assert.equal(doc.reviewStatus, "pending_review");
    assert.equal(doc.isActive, false);
    assert.equal(doc.name, "Work visa (restored)");
    assert.equal((doc.scrapeMeta as any).contentHash, "hash-2");
    assert.ok(doc.staleSince); // still marked until an admin approves
  });

  test("no signal for live docs, rejected docs, already-pending docs, seeded docs", async () => {
    const cases: [string, Data][] = [
      ["live approved", {}],
      ["rejected + withdrawn", { reviewStatus: "rejected", isActive: false, staleSince: Timestamp.fromMillis(1) }],
      ["pending + withdrawn", { reviewStatus: "pending_review", isActive: false, staleSince: Timestamp.fromMillis(1) }],
      ["seeded + inactive + staleSince", { source: undefined, isActive: false, staleSince: Timestamp.fromMillis(1) }],
    ];
    for (const [label, over] of cases) {
      store.clear();
      putZz();
      putDoc(over);
      const before = clone(store.get(DOC));
      const summary = await run();
      assert.equal(summary.restored, 0, label);
      assert.deepEqual(store.get(DOC), before, label);
    }
  });

  test("full cycle: withdraw → restore → approve clears staleSince → second withdrawal sets a FRESH staleSince", async () => {
    putZz();
    putDoc();
    // Country doc so the stats recompute after each isActive flip succeeds
    // (otherwise it logs a swallowed NOT_FOUND).
    store.set("countries/ZZ", { code: "ZZ", name: "Zedland" });

    // 1) Withdrawn on GOV.UK: deactivated + staleSince.
    withdrawnNow = true;
    await run();
    let doc = store.get(DOC)!;
    assert.equal(doc.isActive, false);
    const firstStale = (doc.staleSince as Timestamp).toMillis();

    // 2) Restored: back in the review queue, still off.
    withdrawnNow = false;
    assert.equal((await run()).restored, 1);
    assert.equal(store.get(DOC)!.reviewStatus, "pending_review");

    // 3) Admin approves through the existing review flow: on again, staleSince gone.
    const fresh = { ...oldFx(), fetchedAt: Timestamp.now(), rateDate: isoDaysAgo(1) };
    const { feeMeta, baseCostUsd } = computeFee(SW, fresh, Timestamp.now());
    store.set(DOC, { ...store.get(DOC)!, baseCostUsd, scrapeMeta: { ...(store.get(DOC)!.scrapeMeta as Data), fee: feeMeta } });
    await visaSvc.updateVisaReviewStatus("ZZ", "zz-work", "approve", "admin-1");
    doc = store.get(DOC)!;
    assert.equal(doc.isActive, true);
    assert.equal("staleSince" in doc, false);

    // 4) Withdrawn again: a NEW staleSince (not the first episode's).
    await new Promise((r) => setTimeout(r, 5)); // make Timestamp.now() move on
    withdrawnNow = true;
    await run();
    doc = store.get(DOC)!;
    assert.equal(doc.isActive, false);
    assert.ok((doc.staleSince as Timestamp).toMillis() > firstStale);
  });
});

// ----- Ingest: stale rate on an existing pending doc -----

describe("ingestExtraction — stale rate on an existing pending doc", () => {
  test("fee flagged fxStale, old USD provenance gone, baseCostUsd unchanged", async () => {
    const fresh = { ...oldFx(), fetchedAt: Timestamp.now(), rateDate: isoDaysAgo(1) };
    const path = "countries/GB/visaTypes/gb-skilled-worker-visa";
    store.set(path, scrapedVisa(fresh)); // converted: baseCostUsd 5000, totalUsd, fxSource
    const svc = (await import("../src/services/visa-catalog.service")).visaCatalogService;
    const out = await svc.ingestExtraction({
      countryCode: "GB",
      sourceUrl: "https://www.gov.uk/skilled-worker-visa",
      routeName: "Skilled Worker visa",
      contentHash: "page-hash-2", // changed content
      extracted: {
        name: "Skilled Worker visa", code: "SW", description: "d", category: "work",
        processingTime: "3 weeks", processingDaysMin: 15, processingDaysMax: 21,
        feeComponents: SW, validityPeriod: "5 years", isExtendable: true,
        eligibilityCriteria: ["x"], confidence: 0.9, citations: {},
      },
      model: "stub",
      visaId: "gb-skilled-worker-visa",
      fx: oldFx(), // 8 days old
    });
    assert.equal(out.outcome, "updated");
    const doc = store.get(path)!;
    const fee = (doc.scrapeMeta as any).fee;
    assert.equal(fee.fxStale, true);
    // scrapeMeta replaced wholesale: no leftover conversion from last time.
    assert.equal(fee.totalUsd, undefined);
    assert.equal(fee.fxSource, undefined);
    assert.equal(fee.fxRateToUsd, undefined);
    assert.equal(doc.baseCostUsd, 5000); // unchanged, not overwritten, not 0
    assert.equal(doc.reviewStatus, "pending_review");
    assert.equal(doc.isActive, false);
  });

  // Review blocker: a converted pending doc whose page now yields NO fee must
  // not keep (and be approvable with) its old cost.
  test("converted doc re-ingested with feeComponents [] → cost deleted, noPublishedFee, not approvable", async () => {
    const fresh = { ...oldFx(), fetchedAt: Timestamp.now(), rateDate: isoDaysAgo(0) };
    const path = "countries/GB/visaTypes/gb-skilled-worker-visa";
    store.set(path, scrapedVisa(fresh)); // baseCostUsd 5000
    assert.equal(store.get(path)!.baseCostUsd, 5000);
    const svc = (await import("../src/services/visa-catalog.service")).visaCatalogService;
    await svc.ingestExtraction({
      countryCode: "GB",
      sourceUrl: "https://www.gov.uk/skilled-worker-visa",
      routeName: "Skilled Worker visa",
      contentHash: "page-hash-3",
      extracted: {
        name: "Skilled Worker visa", code: "SW", description: "d", category: "work",
        processingTime: "3 weeks", processingDaysMin: 15, processingDaysMax: 21,
        feeComponents: [], validityPeriod: "5 years", isExtendable: true,
        eligibilityCriteria: ["x"], confidence: 0.9, citations: {},
      },
      model: "stub",
      visaId: "gb-skilled-worker-visa",
      fx: fresh,
    });
    const doc = store.get(path)!;
    assert.equal("baseCostUsd" in doc, false); // deleted, not left at 5000
    assert.equal((doc.scrapeMeta as any).fee.noPublishedFee, true);
    await assert.rejects(
      visaSvc.updateVisaReviewStatus("GB", "gb-skilled-worker-visa", "approve", "admin-1"),
      VisaFeeNotConvertibleError
    );
  });

  test("dropped surcharge (unverified) on re-ingest → cost deleted, feeUnverified, not approvable", async () => {
    const fresh = { ...oldFx(), fetchedAt: Timestamp.now(), rateDate: isoDaysAgo(0) };
    const path = "countries/GB/visaTypes/gb-student-visa";
    store.set(path, scrapedVisa(fresh));
    const svc = (await import("../src/services/visa-catalog.service")).visaCatalogService;
    await svc.ingestExtraction({
      countryCode: "GB",
      sourceUrl: "https://www.gov.uk/student-visa",
      routeName: "Student visa",
      contentHash: "page-hash-4",
      extracted: {
        name: "Student visa", code: "ST", description: "d", category: "student",
        processingTime: "3 weeks", processingDaysMin: 15, processingDaysMax: 21,
        feeComponents: [SW[0]], validityPeriod: "course", isExtendable: true,
        eligibilityCriteria: ["x"], confidence: 0.9, citations: { "fee.application": "a" },
        feeUnverifiedReasons: ["dropped surcharge \"IHS\": citations[\"fee.years\"] must quote a visa length/duration"],
      },
      model: "stub",
      visaId: "gb-student-visa",
      fx: fresh,
    });
    const doc = store.get(path)!;
    assert.equal("baseCostUsd" in doc, false);
    assert.equal((doc.scrapeMeta as any).fee.feeUnverified, true);
    await assert.rejects(
      visaSvc.updateVisaReviewStatus("GB", "gb-student-visa", "approve", "admin-1"),
      (e: unknown) => e instanceof VisaFeeNotConvertibleError && e.message === FEE_NOT_CONVERTED_MESSAGE
    );
  });

  test("new doc with no rate: baseCostUsd absent", async () => {
    const svc = (await import("../src/services/visa-catalog.service")).visaCatalogService;
    await svc.ingestExtraction({
      countryCode: "TW",
      sourceUrl: "https://www.boca.gov.tw/visitor-visa",
      routeName: "Visitor visa",
      contentHash: "h",
      extracted: {
        name: "Visitor visa", code: "V", description: "d", category: "tourist",
        processingTime: "", processingDaysMin: 1, processingDaysMax: 5,
        feeComponents: [{ kind: "application", label: "Fee", amount: 1600, currency: "TWD", per: "application" }],
        validityPeriod: "", isExtendable: false, eligibilityCriteria: ["x"], confidence: 0.9,
        citations: { "fee.application": "NT$1,600" },
      },
      model: "stub",
      visaId: "tw-visitor-visa",
      fx: { ...oldFx(), fetchedAt: Timestamp.now() },
    });
    const doc = store.get("countries/TW/visaTypes/tw-visitor-visa")!;
    assert.equal("baseCostUsd" in doc, false);
    assert.equal((doc.scrapeMeta as any).fee.fxMissing, true);
    assert.equal(doc.reviewStatus, "pending_review");
    assert.equal(doc.isActive, false);
  });
});

// ----- Approval guard in the service + controller -----

describe("visaService.updateVisaReviewStatus — approval guard", () => {
  test("approve is refused with the typed error, and nothing is written", async () => {
    const path = "countries/GB/visaTypes/gb-flagged";
    store.set(path, scrapedVisa(oldFx()));
    const snapshot = clone(store.get(path));
    await assert.rejects(
      visaSvc.updateVisaReviewStatus("GB", "gb-flagged", "approve", "admin-1"),
      (e: unknown) => e instanceof VisaFeeNotConvertibleError && e.message === FEE_NOT_CONVERTED_MESSAGE
    );
    assert.deepEqual(store.get(path), snapshot);
  });

  test("approving a normally converted scraped visa works", async () => {
    const fresh = { ...oldFx(), fetchedAt: Timestamp.now(), rateDate: isoDaysAgo(1) };
    store.set("countries/GB/visaTypes/gb-ok", scrapedVisa(fresh));
    const v: VisaType = await visaSvc.updateVisaReviewStatus("GB", "gb-ok", "approve", "admin-1");
    assert.equal(v.reviewStatus, "approved");
    assert.equal(v.isActive, true);
    assert.equal(v.baseCostUsd, 5000);
  });

  test("rejecting a flagged visa still works", async () => {
    store.set("countries/GB/visaTypes/gb-flagged", scrapedVisa(oldFx()));
    const v: VisaType = await visaSvc.updateVisaReviewStatus("GB", "gb-flagged", "reject", "admin-1", "bad fee");
    assert.equal(v.reviewStatus, "rejected");
    assert.equal(v.rejectionReason, "bad fee");
  });
});

describe("visaController.reviewVisa — error mapping", () => {
  test("approve of a flagged visa → 409 with the clear message", async () => {
    store.set("countries/GB/visaTypes/gb-flagged", scrapedVisa(oldFx()));
    let status = 0;
    let body: any;
    const res = {
      status(code: number) {
        status = code;
        return res;
      },
      json(b: unknown) {
        body = b;
        return res;
      },
    };
    const req = { params: { id: "gb-flagged" }, body: { action: "approve", countryCode: "GB" }, userId: "admin-1" };
    // Silence the controller's console.error for the expected failure.
    const origError = console.error;
    console.error = () => undefined;
    try {
      await controller.reviewVisa(req, res);
    } finally {
      console.error = origError;
    }
    assert.equal(status, 409);
    assert.equal(body.success, false);
    assert.equal(body.error, "FEE_NOT_CONVERTED");
    assert.equal(body.message, FEE_NOT_CONVERTED_MESSAGE);
  });
});
