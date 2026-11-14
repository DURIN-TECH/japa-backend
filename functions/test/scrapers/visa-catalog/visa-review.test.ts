// ============================================
// Unit tests — visa review keeps the catalog consistent (issue #62)
// ============================================
//
// Run with `npm test`. NO network and NO emulator: Firebase Admin is
// initialised against a dummy project id (it connects lazily and nothing here
// ever reaches it), and the collection refs the services use are swapped for
// a tiny in-memory fake (a local copy of the one in
// visa-catalog-fx-service.test.ts, extended to record update() payloads and
// to resolve serverTimestamp() like Firestore does).
//
// Covers `visaService.updateVisaReviewStatus` (PATCH /admin/visas/:id/review):
//  - approve of a scraped visa writes lastVerifiedAt in the SAME update as
//    reviewStatus "approved", and the returned visa has it
//  - approve of an agent-created / seeded visa never sets lastVerifiedAt
//  - approve clears staleSince (FieldValue.delete()) when present, writes no
//    staleSince when absent
//  - approve recomputes countries/{cc} stats (via updateCountryStats) before
//    returning; a cheaper visa lowers minCostUsd, raises visaTypesCount by 1,
//    and an active sibling without baseCostUsd never produces NaN
//  - reject of a live visa deactivates it and recomputes (it drops out of
//    the stats); reject of an inactive visa does not recompute
//  - a 409 FEE_NOT_CONVERTED approval writes nothing and does not recompute
//  - unknown visa → 404 "Visa type not found", no recompute
//  - a throwing recompute is logged and the review still returns 200
//  - re-approving is idempotent (lastVerifiedAt refreshed, stats unchanged)
//  - the duplicate VisaCatalogService.recomputeCountryStats is gone and
//    markWithdrawn now recomputes through updateCountryStats

import { test, describe, before, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { FieldValue, Timestamp } from "firebase-admin/firestore";

import type { VisaType } from "../../../src/types";
import type { ExtractedFeeComponent, FxRatesDoc } from "../../../src/scrapers/visa-catalog/types";
import { FX_SOURCE_ECB, VisaFeeNotConvertibleError, computeFee } from "../../../src/scrapers/visa-catalog/visa-catalog-fx";

// Project id (GCLOUD_PROJECT=demo-unit-test) and the no-network guard are set
// centrally by the test preload, test/helpers/setup.ts (issue #94).

// ============================================
// In-memory Firestore fake (only what these services call)
// ============================================

type Data = Record<string, unknown>;
/** "path/to/doc" -> stored data. */
const store = new Map<string, Data>();
/** Every update() call, in order: which doc and the RAW payload (sentinels
 *  intact), so tests can assert what was written in one update. */
const updateLog: { path: string; data: Data }[] = [];
/** Monotonic fake clock for resolved serverTimestamp() values, so a second
 *  write is observably "later" than the first. */
let clock = 1_700_000_000_000;

/** Deep-copy plain objects/arrays; keep class instances (Timestamp,
 *  FieldValue sentinels) by reference so their prototypes survive. */
function clone<T>(v: T): T {
  if (Array.isArray(v)) return v.map(clone) as unknown as T;
  if (v && typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype) {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clone(x)])) as T;
  }
  return v;
}

/** Resolve a field value the way the Firestore server would: a
 *  serverTimestamp() sentinel becomes a concrete (fake-clock) Timestamp. */
function resolveValue(value: unknown): unknown {
  if (value instanceof FieldValue && value.isEqual(FieldValue.serverTimestamp())) {
    clock += 1000;
    return Timestamp.fromMillis(clock);
  }
  return value;
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
    else cur[parts[parts.length - 1]] = resolveValue(value);
  }
  return out;
}

/** A doc ref backed by `store`. update() on a missing doc throws, like
 *  Firestore's NOT_FOUND. */
function fakeDoc(path: string) {
  const ref = {
    id: path.split("/").pop()!,
    async get() {
      const d = store.get(path);
      return { id: ref.id, exists: d !== undefined, data: () => (d ? clone(d) : undefined), ref };
    },
    async set(data: Data, opts?: { merge?: boolean }) {
      store.set(path, applyUpdate(opts?.merge ? store.get(path) ?? {} : {}, data));
    },
    async update(data: Data) {
      updateLog.push({ path, data: { ...data } });
      const cur = store.get(path);
      if (!cur) throw new Error(`NOT_FOUND ${path}`);
      store.set(path, applyUpdate(cur, data));
    },
  };
  return ref;
}

/** A collection ref / query backed by `store` (direct children only).
 *  `where` returns a NEW query; every filter is treated as equality, which
 *  covers getVisaTypesByCountry's `isActive == true`. orderBy is a no-op. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fakeCollection(path: string, filters: [string, unknown][] = []): any {
  const col = {
    doc: (id: string) => fakeDoc(`${path}/${id}`),
    where(field: string, _op: string, value: unknown) {
      return fakeCollection(path, [...filters, [field, value]]);
    },
    orderBy: () => col,
    limit: () => col,
    async get() {
      const docs = [...store.entries()]
        .filter(([p]) => p.startsWith(`${path}/`) && !p.slice(path.length + 1).includes("/"))
        .filter(([, d]) => filters.every(([f, v]) => d[f] === v))
        .map(([p]) => fakeDoc(p))
        .map((ref) => ({ id: ref.id, ref, data: () => clone(store.get(`${path}/${ref.id}`)!) }));
      return { docs, empty: docs.length === 0 };
    },
  };
  return col;
}

// ============================================
// Fixtures
// ============================================

const DAY_MS = 24 * 60 * 60 * 1000;
const COUNTRY = "countries/GB";
const visaPath = (id: string) => `countries/GB/visaTypes/${id}`;

// Rates relative to the REAL clock (the approval guard checks freshness
// against Timestamp.now()), so the suite never goes stale.
const isoDaysAgo = (d: number) => new Date(Date.now() - d * DAY_MS).toISOString().slice(0, 10);
const freshFx = (): FxRatesDoc => ({
  base: "USD",
  rates: { GBP: 0.8 },
  fetchedAt: Timestamp.now(),
  rateDate: isoDaysAgo(1),
  source: FX_SOURCE_ECB,
});
const staleFx = (): FxRatesDoc => ({
  ...freshFx(),
  fetchedAt: Timestamp.fromMillis(Date.now() - 8 * DAY_MS),
  rateDate: isoDaysAgo(10),
});

/** One-component fee: £gbp application fee (→ gbp / 0.8 USD at freshFx). */
const fee = (gbp: number): ExtractedFeeComponent[] => [
  { kind: "application", label: "Application fee", amount: gbp, currency: "GBP", per: "application" },
];

/** A PENDING scraped visa whose fee was converted (or flagged) against `fx`;
 *  approvable when `fx` is fresh. */
function scrapedVisa(gbp: number, fx: FxRatesDoc, over: Data = {}): Data {
  const { baseCostUsd, feeMeta } = computeFee(fee(gbp), fx, Timestamp.now());
  const doc: Data = {
    source: "scraped",
    reviewStatus: "pending_review",
    isActive: false,
    processingDaysMin: 15,
    scrapeMeta: { contentHash: "h", fee: feeMeta },
    ...over,
  };
  if (baseCostUsd !== undefined) doc.baseCostUsd = baseCostUsd;
  return doc;
}

/**
 * Seed GB with two LIVE visas and matching stats:
 *  - gb-seeded: seeded (no `source`), $1000, 20 days
 *  - gb-legacy: agent-created, approved, NO baseCostUsd (must not make NaN)
 * Stats as updateCountryStats would compute them: 2 visas, min $1000, 10 days.
 */
function seedLiveCountry(): void {
  store.set(visaPath("gb-seeded"), { isActive: true, baseCostUsd: 1000, processingDaysMin: 20 });
  store.set(visaPath("gb-legacy"), {
    isActive: true,
    source: "agent",
    reviewStatus: "approved",
    processingDaysMin: 10,
  });
  store.set(COUNTRY, { code: "GB", name: "United Kingdom", visaTypesCount: 2, minCostUsd: 1000, minProcessingDays: 10 });
}

/** The single update() payload written to a visa doc (asserts exactly one). */
function onlyVisaUpdate(id: string): Data {
  const writes = updateLog.filter((u) => u.path === visaPath(id));
  assert.equal(writes.length, 1, `expected exactly one update of ${id}`);
  return writes[0].data;
}

/** Minimal Express res double capturing status + JSON body. */
function fakeRes() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
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

/** Run `fn` with console.error captured (expected failures stay quiet). */
async function captureErrors(fn: () => Promise<unknown>): Promise<unknown[][]> {
  const logged: unknown[][] = [];
  const orig = console.error;
  console.error = (...args: unknown[]) => void logged.push(args);
  try {
    await fn();
  } finally {
    console.error = orig;
  }
  return logged;
}

// ============================================
// Wire the fakes in (dynamic import AFTER the env var is set)
// ============================================

/* eslint-disable @typescript-eslint/no-explicit-any */
let visaSvc: any;
let catalogSvc: any;
let controller: any;
/** Country codes updateCountryStats was called with (spy). */
let statsCalls: string[] = [];
/** Original method, so the spy delegates to the real recompute. */
let realUpdateCountryStats: (cc: string) => Promise<void>;
/** When set, the spy throws this instead of recomputing. */
let statsFailure: Error | undefined;

before(async () => {
  const firebase: any = await import("../../../src/utils/firebase");
  firebase.collections.countries = fakeCollection("countries");
  firebase.subcollections.visaTypes = (cc: string) => fakeCollection(`countries/${cc}/visaTypes`);
  // Issue #94: markWithdrawn of a scraped visa also closes its open #61
  // proposals (issue #68), which queries pendingVisaChanges and resolves each
  // row in a transaction. Fake the collection (empty in these tests) and use a
  // pass-through runner, so nothing reaches a real Firestore.
  firebase.collections.pendingVisaChanges = fakeCollection("pendingVisaChanges");
  const changes: any = (await import("../../../src/scrapers/visa-catalog/changes/visa-catalog-changes.service")).visaChangeService;
  changes.runTransaction = (fn: (tx: any) => Promise<unknown>) =>
    fn({
      get: (ref: any) => ref.get(),
      update: (ref: any, data: Data) => ref.update(data),
      set: (ref: any, data: Data, opts?: { merge?: boolean }) => ref.set(data, opts),
    });

  visaSvc = (await import("../../../src/services/visa.service")).visaService;
  catalogSvc = (await import("../../../src/scrapers/visa-catalog/visa-catalog.service")).visaCatalogService;
  controller = (await import("../../../src/controllers/visa.controller")).visaController;

  // Spy on the canonical recompute (instance property, so both
  // `this.updateCountryStats` and `visaService.updateCountryStats` hit it).
  realUpdateCountryStats = visaSvc.updateCountryStats.bind(visaSvc);
  visaSvc.updateCountryStats = async (cc: string) => {
    statsCalls.push(cc);
    if (statsFailure) throw statsFailure;
    return realUpdateCountryStats(cc);
  };
});

beforeEach(() => {
  store.clear();
  updateLog.length = 0;
  statsCalls = [];
  statsFailure = undefined;
});

afterEach(() => {
  statsFailure = undefined;
});

// ============================================
// Approve
// ============================================

describe("approve — lastVerifiedAt + staleSince", () => {
  test("scraped visa: lastVerifiedAt written in the same update as reviewStatus approved, and returned", async () => {
    seedLiveCountry();
    store.set(visaPath("gb-new"), scrapedVisa(400, freshFx()));

    const v: VisaType = await visaSvc.updateVisaReviewStatus("GB", "gb-new", "approve", "admin-1");

    const payload = onlyVisaUpdate("gb-new");
    assert.equal(payload.reviewStatus, "approved");
    assert.equal(payload.isActive, true);
    // Server timestamp sentinel, in that same payload.
    assert.ok(payload.lastVerifiedAt instanceof FieldValue);
    assert.ok((payload.lastVerifiedAt as FieldValue).isEqual(FieldValue.serverTimestamp()));
    // The endpoint's visa carries the resolved timestamp.
    assert.ok(v.lastVerifiedAt instanceof Timestamp);
    assert.equal(v.reviewStatus, "approved");
    assert.equal(v.reviewedBy, "admin-1");
  });

  test("agent-created visa: approval does not set lastVerifiedAt", async () => {
    seedLiveCountry();
    store.set(visaPath("gb-agent"), {
      source: "agent",
      reviewStatus: "pending_review",
      isActive: true,
      baseCostUsd: 700,
      processingDaysMin: 30,
    });
    const v: VisaType = await visaSvc.updateVisaReviewStatus("GB", "gb-agent", "approve", "admin-1");
    assert.equal("lastVerifiedAt" in onlyVisaUpdate("gb-agent"), false);
    assert.equal(v.lastVerifiedAt, undefined);
    assert.equal(v.reviewStatus, "approved");
  });

  test("seeded visa (no source): approval does not set lastVerifiedAt", async () => {
    seedLiveCountry();
    const v: VisaType = await visaSvc.updateVisaReviewStatus("GB", "gb-seeded", "approve", "admin-1");
    assert.equal("lastVerifiedAt" in onlyVisaUpdate("gb-seeded"), false);
    assert.equal(v.lastVerifiedAt, undefined);
  });

  test("visa with staleSince: approval removes the field with FieldValue.delete()", async () => {
    seedLiveCountry();
    store.set(visaPath("gb-stale"), scrapedVisa(400, freshFx(), { staleSince: Timestamp.fromMillis(1) }));

    const v: VisaType = await visaSvc.updateVisaReviewStatus("GB", "gb-stale", "approve", "admin-1");

    const payload = onlyVisaUpdate("gb-stale");
    assert.ok(payload.staleSince instanceof FieldValue);
    assert.ok((payload.staleSince as FieldValue).isEqual(FieldValue.delete()));
    assert.equal("staleSince" in store.get(visaPath("gb-stale"))!, false);
    assert.equal(v.staleSince, undefined);
    assert.equal(v.isActive, true);
  });

  test("visa without staleSince: approval works and writes no staleSince", async () => {
    seedLiveCountry();
    store.set(visaPath("gb-new"), scrapedVisa(400, freshFx()));
    const v: VisaType = await visaSvc.updateVisaReviewStatus("GB", "gb-new", "approve", "admin-1");
    assert.equal("staleSince" in onlyVisaUpdate("gb-new"), false);
    assert.equal("staleSince" in store.get(visaPath("gb-new"))!, false);
    assert.equal(v.reviewStatus, "approved");
  });
});

describe("approve — country stats", () => {
  test("stats recomputed via updateCountryStats before the call returns", async () => {
    seedLiveCountry();
    store.set(visaPath("gb-new"), scrapedVisa(1200, freshFx())); // $1500, dearer than the min

    await visaSvc.updateVisaReviewStatus("gb", "gb-new", "approve", "admin-1"); // lower-case code

    // Called once, with the upper-case country doc id.
    assert.deepEqual(statsCalls, ["GB"]);
    // Already written by the time the promise resolved (not the trigger).
    const c = store.get(COUNTRY)!;
    assert.equal(c.visaTypesCount, 3);
    assert.equal(c.minCostUsd, 1000);
    assert.equal(c.minProcessingDays, 10);
  });

  test("a cheaper scraped visa lowers minCostUsd and raises visaTypesCount by 1; finite minimum, never NaN", async () => {
    seedLiveCountry();
    const before = clone(store.get(COUNTRY)!);
    store.set(visaPath("gb-cheap"), scrapedVisa(400, freshFx())); // $500 < $1000
    assert.equal(store.get(visaPath("gb-cheap"))!.baseCostUsd, 500);

    await visaSvc.updateVisaReviewStatus("GB", "gb-cheap", "approve", "admin-1");

    const c = store.get(COUNTRY)!;
    assert.equal(c.visaTypesCount, (before.visaTypesCount as number) + 1);
    assert.equal(c.minCostUsd, 500);
    // gb-legacy (active, no baseCostUsd) is counted but ignored by the min.
    assert.ok(Number.isFinite(c.minCostUsd as number));
    assert.ok(Number.isFinite(c.minProcessingDays as number));
  });

  test("re-approving an approved scraped visa is idempotent: lastVerifiedAt refreshed, stats unchanged", async () => {
    seedLiveCountry();
    store.set(visaPath("gb-new"), scrapedVisa(400, freshFx()));
    const first: VisaType = await visaSvc.updateVisaReviewStatus("GB", "gb-new", "approve", "admin-1");
    const statsAfterFirst = clone(store.get(COUNTRY)!);
    const { updatedAt: _a, ...firstStats } = statsAfterFirst;

    const second: VisaType = await visaSvc.updateVisaReviewStatus("GB", "gb-new", "approve", "admin-2");

    assert.equal(second.reviewStatus, "approved");
    assert.equal(second.isActive, true);
    assert.equal(second.reviewedBy, "admin-2");
    assert.ok(second.lastVerifiedAt!.toMillis() > first.lastVerifiedAt!.toMillis());
    const { updatedAt: _b, ...secondStats } = store.get(COUNTRY)!;
    assert.deepEqual(secondStats, firstStats);
  });
});

describe("approve — refused or unknown", () => {
  test("409 FEE_NOT_CONVERTED: nothing written (no lastVerifiedAt, no staleSince change), no stats call", async () => {
    seedLiveCountry();
    const stale = Timestamp.fromMillis(1);
    store.set(visaPath("gb-flagged"), scrapedVisa(400, staleFx(), { staleSince: stale }));
    const visaBefore = clone(store.get(visaPath("gb-flagged")));
    const countryBefore = clone(store.get(COUNTRY));

    await assert.rejects(
      visaSvc.updateVisaReviewStatus("GB", "gb-flagged", "approve", "admin-1"),
      VisaFeeNotConvertibleError
    );

    assert.equal(updateLog.length, 0);
    assert.deepEqual(store.get(visaPath("gb-flagged")), visaBefore);
    assert.equal(store.get(visaPath("gb-flagged"))!.staleSince, stale);
    assert.deepEqual(store.get(COUNTRY), countryBefore);
    assert.deepEqual(statsCalls, []);

    // And through the controller: still the 409.
    const { res, out } = fakeRes();
    await captureErrors(() =>
      controller.reviewVisa(
        { params: { id: "gb-flagged" }, body: { action: "approve", countryCode: "GB" }, userId: "admin-1" },
        res
      )
    );
    assert.equal(out.status, 409);
    assert.equal(out.body.error, "FEE_NOT_CONVERTED");
    assert.equal(updateLog.length, 0);
    assert.deepEqual(statsCalls, []);
  });

  test("unknown visa → existing 404 'Visa type not found', recompute not attempted", async () => {
    seedLiveCountry();
    await assert.rejects(
      visaSvc.updateVisaReviewStatus("GB", "gb-nope", "approve", "admin-1"),
      (e: unknown) => (e as Error).message === "Visa type not found"
    );
    const { res, out } = fakeRes();
    await captureErrors(() =>
      controller.reviewVisa(
        { params: { id: "gb-nope" }, body: { action: "reject", reason: "x", countryCode: "GB" }, userId: "admin-1" },
        res
      )
    );
    assert.equal(out.status, 404);
    assert.equal(out.body.error, "NOT_FOUND");
    assert.equal(out.body.message, "Visa type not found");
    assert.deepEqual(statsCalls, []);
    assert.equal(updateLog.length, 0);
  });
});

// ============================================
// Reject
// ============================================

describe("reject", () => {
  test("a live, previously approved visa is deactivated and drops out of the stats", async () => {
    seedLiveCountry();
    // Approve a cheap scraped visa first so it is live and the min.
    store.set(visaPath("gb-cheap"), scrapedVisa(400, freshFx()));
    await visaSvc.updateVisaReviewStatus("GB", "gb-cheap", "approve", "admin-1");
    assert.equal(store.get(COUNTRY)!.visaTypesCount, 3);
    assert.equal(store.get(COUNTRY)!.minCostUsd, 500);
    updateLog.length = 0;
    statsCalls = [];

    const v: VisaType = await visaSvc.updateVisaReviewStatus("GB", "gb-cheap", "reject", "admin-1", "fee changed");

    const payload = onlyVisaUpdate("gb-cheap");
    assert.equal(payload.isActive, false);
    assert.equal(payload.reviewStatus, "rejected");
    assert.equal(payload.rejectionReason, "fee changed");
    assert.equal(v.isActive, false);
    assert.equal(v.reviewStatus, "rejected");
    assert.equal(v.rejectionReason, "fee changed");
    assert.deepEqual(statsCalls, ["GB"]);
    const c = store.get(COUNTRY)!;
    assert.equal(c.visaTypesCount, 2);
    assert.equal(c.minCostUsd, 1000);
  });

  test("a live agent-created pending visa is deactivated on reject", async () => {
    seedLiveCountry();
    store.set(visaPath("gb-agent"), {
      source: "agent",
      reviewStatus: "pending_review",
      isActive: true,
      baseCostUsd: 300,
      processingDaysMin: 5,
    });
    store.set(COUNTRY, { ...store.get(COUNTRY)!, visaTypesCount: 3, minCostUsd: 300, minProcessingDays: 5 });

    await visaSvc.updateVisaReviewStatus("GB", "gb-agent", "reject", "admin-1", "duplicate");

    assert.equal(store.get(visaPath("gb-agent"))!.isActive, false);
    const c = store.get(COUNTRY)!;
    assert.equal(c.visaTypesCount, 2);
    assert.equal(c.minCostUsd, 1000);
    assert.equal(c.minProcessingDays, 10);
  });

  test("an already inactive (pending scraped) visa: no stats change and no recompute", async () => {
    seedLiveCountry();
    store.set(visaPath("gb-pending"), scrapedVisa(400, staleFx())); // isActive: false
    const countryBefore = clone(store.get(COUNTRY));

    const v: VisaType = await visaSvc.updateVisaReviewStatus("GB", "gb-pending", "reject", "admin-1", "bad fee");

    assert.equal(v.reviewStatus, "rejected");
    assert.equal(v.isActive, false);
    // Only the review fields were written: no isActive flip.
    assert.equal("isActive" in onlyVisaUpdate("gb-pending"), false);
    assert.deepEqual(statsCalls, []);
    assert.deepEqual(store.get(COUNTRY), countryBefore);
  });
});

// ============================================
// Stats failure is logged, never a 500
// ============================================

describe("recompute failure", () => {
  test("approve with a missing country doc → 200 with the updated visa, error logged", async () => {
    // No countries/GB doc: the real updateCountryStats update() throws.
    store.set(visaPath("gb-new"), scrapedVisa(400, freshFx()));
    const { res, out } = fakeRes();

    const logged = await captureErrors(() =>
      controller.reviewVisa(
        { params: { id: "gb-new" }, body: { action: "approve", countryCode: "GB" }, userId: "admin-1" },
        res
      )
    );

    assert.equal(out.status, 200);
    assert.equal(out.body.success, true);
    assert.equal(out.body.data.reviewStatus, "approved");
    assert.equal(out.body.data.isActive, true);
    assert.ok(out.body.data.lastVerifiedAt instanceof Timestamp);
    assert.deepEqual(statsCalls, ["GB"]);
    assert.equal(store.has(COUNTRY), false); // no stub country created
    assert.ok(logged.some((args) => String(args[0]).includes("stats recompute failed")));
  });

  test("reject of a live visa with a throwing recompute → 200, visa deactivated, error logged", async () => {
    seedLiveCountry();
    statsFailure = new Error("boom");
    const { res, out } = fakeRes();

    const logged = await captureErrors(() =>
      controller.reviewVisa(
        { params: { id: "gb-seeded" }, body: { action: "reject", reason: "gone", countryCode: "GB" }, userId: "admin-1" },
        res
      )
    );

    assert.equal(out.status, 200);
    assert.equal(out.body.data.isActive, false);
    assert.equal(out.body.data.reviewStatus, "rejected");
    assert.deepEqual(statsCalls, ["GB"]);
    assert.ok(logged.some((args) => args.some((a) => a instanceof Error && a.message === "boom")));
  });
});

// ============================================
// One canonical stats function
// ============================================

describe("single stats function", () => {
  test("VisaCatalogService.recomputeCountryStats no longer exists", () => {
    assert.equal(typeof catalogSvc.recomputeCountryStats, "undefined");
    assert.equal("recomputeCountryStats" in Object.getPrototypeOf(catalogSvc), false);
  });

  test("markWithdrawn recomputes through visaService.updateCountryStats", async () => {
    seedLiveCountry();
    store.set(visaPath("gb-live-scraped"), {
      source: "scraped",
      reviewStatus: "approved",
      isActive: true,
      baseCostUsd: 400,
      processingDaysMin: 3,
    });
    store.set(COUNTRY, { ...store.get(COUNTRY)!, visaTypesCount: 3, minCostUsd: 400, minProcessingDays: 3 });

    const outcome = await catalogSvc.markWithdrawn("GB", "gb-live-scraped");

    assert.equal(outcome, "deactivated");
    assert.deepEqual(statsCalls, ["GB"]);
    const c = store.get(COUNTRY)!;
    assert.equal(c.visaTypesCount, 2);
    assert.equal(c.minCostUsd, 1000);
    assert.equal(c.minProcessingDays, 10);
  });
  test("markWithdrawn with a missing country doc: deactivates, returns 'deactivated', logs the stats error", async () => {
    // No countries/GB doc: the real updateCountryStats update() throws.
    store.set(visaPath("gb-live-scraped"), {
      source: "scraped",
      reviewStatus: "approved",
      isActive: true,
      baseCostUsd: 400,
      processingDaysMin: 3,
    });

    let outcome: unknown;
    const logged = await captureErrors(async () => {
      outcome = await catalogSvc.markWithdrawn("GB", "gb-live-scraped");
    });

    // The crawl sees a normal withdrawal (not a page error).
    assert.equal(outcome, "deactivated");
    const doc = store.get(visaPath("gb-live-scraped"))!;
    assert.equal(doc.isActive, false);
    assert.ok(doc.staleSince instanceof Timestamp);
    assert.deepEqual(statsCalls, ["GB"]);
    assert.equal(store.has(COUNTRY), false); // no stub country created
    assert.ok(logged.some((args) => String(args[0]).includes("stats recompute failed")));
  });
});

// ============================================
// Issue #212: missing items must be acknowledged before approval
// ============================================

describe("approve — missingFromExtraction acknowledgement (issue #212)", () => {
  /** A scraped visa whose scrapeMeta records `missing` (undefined = field absent). */
  function withMissing(missing: unknown[] | undefined): Record<string, unknown> {
    const v = scrapedVisa(400, freshFx()) as Record<string, unknown>;
    return {
      ...v,
      scrapeMeta: { ...(v.scrapeMeta as object), extractedAt: Timestamp.fromMillis(SEEN_MS), ...(missing ? { missingFromExtraction: missing } : {}) },
    };
  }
  const one = [{ text: "a passport", leadIn: "", section: "s", appended: true }];
  // The extraction the admin saw (echoed back as `acknowledgedExtractedAt`).
  const SEEN_MS = 1_700_000_000_000;
  const seenBody = { _seconds: SEEN_MS / 1000, _nanoseconds: 0 };

  test("non-empty and not acknowledged: 409 MISSING_ITEMS_UNACKNOWLEDGED, nothing written (service + controller)", async () => {
    seedLiveCountry();
    store.set(visaPath("gb-m"), withMissing(one));
    const before = JSON.parse(JSON.stringify(store.get(visaPath("gb-m"))));
    await assert.rejects(visaSvc.updateVisaReviewStatus("GB", "gb-m", "approve", "admin-1"), { code: "MISSING_ITEMS_UNACKNOWLEDGED" });
    assert.equal(updateLog.length, 0);
    const { res, out } = fakeRes();
    await captureErrors(() =>
      controller.reviewVisa({ params: { id: "gb-m" }, body: { action: "approve", countryCode: "GB" }, userId: "admin-1" }, res)
    );
    assert.equal(out.status, 409);
    assert.equal(out.body.error, "MISSING_ITEMS_UNACKNOWLEDGED");
    assert.equal(updateLog.length, 0);
    assert.deepEqual(JSON.parse(JSON.stringify(store.get(visaPath("gb-m")))), before);
  });

  test("a non-boolean flag is a 400", async () => {
    seedLiveCountry();
    store.set(visaPath("gb-m"), withMissing(one));
    const { res, out } = fakeRes();
    await captureErrors(() =>
      controller.reviewVisa(
        { params: { id: "gb-m" }, body: { action: "approve", countryCode: "GB", acknowledgeMissingItems: "yes" }, userId: "admin-1" },
        res
      )
    );
    assert.equal(out.status, 400);
  });

  test("acknowledged: approves and stamps who and when", async () => {
    seedLiveCountry();
    store.set(visaPath("gb-m"), withMissing(one));
    const { res, out } = fakeRes();
    await captureErrors(() =>
      controller.reviewVisa(
        { params: { id: "gb-m" }, body: { action: "approve", countryCode: "GB", acknowledgeMissingItems: true, acknowledgedExtractedAt: seenBody }, userId: "admin-1" },
        res
      )
    );
    assert.equal(out.status, 200);
    const payload = onlyVisaUpdate("gb-m");
    assert.equal(payload.reviewStatus, "approved");
    assert.equal(payload.missingItemsAcknowledgedBy, "admin-1");
    assert.ok(payload.missingItemsAcknowledgedAt instanceof FieldValue);
  });

  test("the extraction changed after the admin looked (or no timestamp sent): 409 MISSING_ITEMS_CHANGED, nothing written", async () => {
    seedLiveCountry();
    store.set(visaPath("gb-m"), withMissing(one));
    for (const acknowledgedExtractedAt of [{ _seconds: SEEN_MS / 1000 - 60, _nanoseconds: 0 }, undefined]) {
      const { res, out } = fakeRes();
      await captureErrors(() =>
        controller.reviewVisa(
          { params: { id: "gb-m" }, body: { action: "approve", countryCode: "GB", acknowledgeMissingItems: true, acknowledgedExtractedAt }, userId: "admin-1" },
          res
        )
      );
      assert.equal(out.status, 409);
      assert.equal(out.body.error, "MISSING_ITEMS_CHANGED");
    }
    assert.equal(updateLog.length, 0);
  });

  test("an approve with nothing missing clears an old acknowledgement", async () => {
    seedLiveCountry();
    store.set(visaPath("gb-old"), { ...withMissing([]), missingItemsAcknowledgedBy: "someone", missingItemsAcknowledgedAt: Timestamp.now() });
    await visaSvc.updateVisaReviewStatus("GB", "gb-old", "approve", "admin-1");
    const p = onlyVisaUpdate("gb-old");
    assert.ok(p.missingItemsAcknowledgedBy instanceof FieldValue);
    assert.ok(p.missingItemsAcknowledgedAt instanceof FieldValue);
  });

  test("[] and an absent field approve as today, with no acknowledgement fields", async () => {
    seedLiveCountry();
    store.set(visaPath("gb-e"), withMissing([]));
    store.set(visaPath("gb-a"), withMissing(undefined));
    await visaSvc.updateVisaReviewStatus("GB", "gb-e", "approve", "admin-1");
    await visaSvc.updateVisaReviewStatus("GB", "gb-a", "approve", "admin-1");
    for (const id of ["gb-e", "gb-a"]) {
      const p = updateLog.find((u: any) => u.path === visaPath(id))?.data ?? onlyVisaUpdate(id);
      assert.equal("missingItemsAcknowledgedBy" in p, false, id);
    }
  });

  test("reject is never gated", async () => {
    seedLiveCountry();
    store.set(visaPath("gb-m"), withMissing(one));
    await visaSvc.updateVisaReviewStatus("GB", "gb-m", "reject", "admin-1", "no");
    assert.equal(store.get(visaPath("gb-m"))!.reviewStatus, "rejected");
  });
});
