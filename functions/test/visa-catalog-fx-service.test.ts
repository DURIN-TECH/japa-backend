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
//  - after a refresh, a stale-flagged pending scraped visa is re-converted
//    from its stored components with ZERO extractor calls, content hash
//    untouched; approved / agent docs are left alone
//  - visaService.updateVisaReviewStatus: approve refused (typed error, no
//    write) for a flagged scraped visa; approving a converted one and
//    rejecting a flagged one both work
//  - visaController.reviewVisa maps the typed error to 409 with the message

import { test, describe, before, beforeEach } from "node:test";
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
  const ref = {
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
  };
  return ref;
}

/** A collection ref / query backed by `store` (direct children only).
 *  `where` returns a NEW query, like Firestore (filters never leak). Every
 *  filter is treated as equality — enough for the code under test (the
 *  orchestrator's `nextCrawlAt <= now` simply matches nothing here). */
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

describe("runOrchestrator — FX refresh + re-convert", () => {
  test("refreshes appConfig/fx and re-converts a stale-flagged pending visa with zero extractor calls", async () => {
    store.set("appConfig/fx", oldFx() as unknown as Data);
    store.set("countries/GB/visaTypes/gb-skilled-worker-visa", scrapedVisa(oldFx()));
    // Approved + agent docs with a flagged fee must not be touched.
    store.set("countries/GB/visaTypes/gb-approved", scrapedVisa(oldFx(), { reviewStatus: "approved", baseCostUsd: 1 }));
    store.set("countries/GB/visaTypes/gb-agent", scrapedVisa(oldFx(), { source: "agent", baseCostUsd: 2 }));
    const before = store.get("countries/GB/visaTypes/gb-skilled-worker-visa")!;
    assert.equal((before.scrapeMeta as any).fee.fxStale, true);
    assert.equal("baseCostUsd" in before, false);

    let fetches = 0;
    const summary = await crawl.runOrchestrator({
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

    const summary = await crawl.runOrchestrator({
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
