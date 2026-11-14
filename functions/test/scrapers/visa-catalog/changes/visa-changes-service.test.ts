// ============================================
// Unit tests — pendingVisaChanges ingest, approve/reject, routes (issue #61)
// ============================================
//
// Run with `npm test`. NO network and NO emulator: Firebase Admin is
// initialised against a dummy project id (never contacted) and every
// collection ref + the transaction runner are swapped for the in-memory fake
// in helpers/fake-firestore.ts. The LLM extractor and the source adapter are
// stubs.
//
// Covers:
//  - ingestExtraction: approved scraped + diff → "proposed" row, live doc
//    byte-for-byte untouched; identical → "unchanged", no row; same hash as
//    live / open row → "unchanged", no write; newer extraction replaces the
//    open row in place; seeded / agent / rejected / staleSince → "skipped";
//    pending_review refresh-in-place regression
//  - runOrchestrator: summary.proposed; a second crawl with the same page
//    text makes no extraction call and no new row (lastContentHash gate)
//  - approveChange: happy path (only diffed fields + scrapeMeta + provenance,
//    reviewedBy/At, baseCostUsd === round(totalUsd), row approved, stats
//    recomputed after commit), stale (field changed, deactivated, staleSince),
//    already resolved, fee-flagged refusal (nothing written), missing row /
//    visa → 404, a failing stats recompute is swallowed
//  - rejectChange + reconvertFlaggedFees on open rows
//  - controller: status codes + validation for all four routes; 403 for
//    owner / agent / client abilities; 401 without a token (verifyAuth)

import { test, describe, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Timestamp } from "firebase-admin/firestore";
import { ROLES, defineAbilitiesFor } from "@durin-tech/authz";
import type { Role } from "@durin-tech/authz";

import type { ExtractedFeeComponent, ExtractedVisa, FxRatesDoc } from "../../../../src/scrapers/visa-catalog/types";
import { FX_SOURCE_ECB } from "../../../../src/scrapers/visa-catalog/visa-catalog-fx";
import { Data, clone, installFakes, resetStore, store, writes } from "../../../helpers/fake-firestore";

// Project id (GCLOUD_PROJECT=demo-unit-test) and the no-network guard are set
// centrally by the test preload, test/helpers/setup.ts (issue #94).

// ============================================
// Fixtures
// ============================================

const DAY_MS = 24 * 60 * 60 * 1000;
const CC = "GB";
const VISA_ID = "gb-skilled-worker";
const VISA_PATH = `countries/${CC}/visaTypes/${VISA_ID}`;
const URL = "https://www.gov.uk/skilled-worker-visa";
const isoDaysAgo = (d: number) => new Date(Date.now() - d * DAY_MS).toISOString().slice(0, 10);
const freshFx = (): FxRatesDoc => ({
  base: "USD",
  rates: { GBP: 0.8 },
  fetchedAt: Timestamp.now(),
  rateDate: isoDaysAgo(1),
  source: FX_SOURCE_ECB,
});
const staleFx = (): FxRatesDoc => ({ ...freshFx(), fetchedAt: Timestamp.fromMillis(Date.now() - 8 * DAY_MS), rateDate: isoDaysAgo(10) });

const FEE: ExtractedFeeComponent[] = [
  { kind: "application", label: "Application fee", amount: 800, currency: "GBP", per: "application" },
];

/** A validated extraction (override any field). */
function extraction(over: Partial<ExtractedVisa> = {}): ExtractedVisa {
  return {
    name: "Skilled Worker visa",
    code: "SW",
    description: "Work in the UK.",
    category: "work",
    processingTime: "3 weeks",
    processingDaysMin: 15,
    processingDaysMax: 21,
    feeComponents: FEE,
    validityPeriod: "5 years",
    isExtendable: true,
    eligibilityCriteria: ["Job offer"],
    confidence: 0.9,
    citations: { processingDaysMax: "within 3 weeks" },
    ...over,
  } as ExtractedVisa;
}

/** Store the live doc as ingest would have created it, then flip it to `over` (e.g. approved). */
async function seedLive(over: Data = { reviewStatus: "approved", isActive: true }, hash = "h1"): Promise<void> {
  await ingest(extraction(), hash);
  const cur = store.get(VISA_PATH)!;
  store.set(VISA_PATH, { ...cur, ...over });
  store.set(`countries/${CC}`, { code: CC, name: "United Kingdom", visaTypesCount: 1, minCostUsd: 1000, minProcessingDays: 15 });
}

/* eslint-disable @typescript-eslint/no-explicit-any */
let catalog: any;
let changes: any;
let changesMod: any;
let controller: any;
let visaSvc: any;
let crawl: any;
let adapters: any;
let extractMod: any;
let authMw: any;

/** Ingest one extraction for the fixture visa. */
function ingest(e: ExtractedVisa, hash: string, fx: FxRatesDoc | undefined = freshFx()) {
  return catalog.ingestExtraction({
    countryCode: CC,
    sourceUrl: URL,
    routeName: "Skilled Worker visa",
    contentHash: hash,
    extracted: e,
    model: "stub-model",
    visaId: VISA_ID,
    fx,
  });
}

/** All pendingVisaChanges rows as [id, data]. */
function rows(): [string, Data][] {
  return [...store.entries()]
    .filter(([p]) => p.startsWith("pendingVisaChanges/"))
    .map(([p, d]) => [p.split("/")[1], d]);
}

/** The single row (asserts exactly one). */
function onlyRow(): [string, Data] {
  const r = rows();
  assert.equal(r.length, 1);
  return r[0];
}

/** Writes to the live visa doc since index `from`. */
function visaWritesSince(from: number) {
  return writes.slice(from).filter((w) => w.path === VISA_PATH);
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
  await controller[handler](r, res);
  return out;
}

/** Run `fn` with console.error silenced, returning what was logged. */
async function quiet<T>(fn: () => Promise<T>): Promise<{ result: T; logged: unknown[][] }> {
  const logged: unknown[][] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => void logged.push(a);
  try {
    return { result: await fn(), logged };
  } finally {
    console.error = orig;
  }
}

before(async () => {
  await installFakes();
  catalog = (await import("../../../../src/scrapers/visa-catalog/visa-catalog.service")).visaCatalogService;
  changesMod = await import("../../../../src/scrapers/visa-catalog/changes/visa-catalog-changes.service");
  changes = changesMod.visaChangeService;
  controller = (await import("../../../../src/scrapers/visa-catalog/changes/visa-change.controller")).visaChangeController;
  visaSvc = (await import("../../../../src/services/visa.service")).visaService;
  crawl = (await import("../../../../src/scrapers/visa-catalog/visa-catalog-crawl.service")).visaCatalogCrawlService;
  adapters = await import("../../../../src/scrapers/visa-catalog/adapters");
  extractMod = await import("../../../../src/scrapers/visa-catalog/visa-catalog-extract.service");
  authMw = await import("../../../../src/middleware/auth");
});

beforeEach(() => resetStore());

// ============================================
// Ingest
// ============================================

describe("ingestExtraction — approved scraped visas are proposed, never written", () => {
  test("diff → 'proposed' row in the documented shape; live doc byte-for-byte untouched", async () => {
    await seedLive();
    const liveBefore = clone(store.get(VISA_PATH));
    const mark = writes.length;
    const r = await ingest(extraction({ processingDaysMax: 30 }), "h2");
    assert.equal(r.outcome, "proposed");
    assert.deepEqual(store.get(VISA_PATH), liveBefore);
    assert.equal(visaWritesSince(mark).length, 0);

    const [, row] = onlyRow();
    assert.equal(row.countryCode, CC);
    assert.equal(row.visaId, VISA_ID);
    assert.equal(row.status, "open");
    assert.equal(row.changeType, "update");
    assert.equal(row.revision, 1);
    assert.deepEqual(row.diff, [{ field: "processingDaysMax", kind: "changed", before: 21, after: 30 }]);
    assert.deepEqual(row.current, { processingDaysMax: 21 });
    assert.deepEqual(row.proposed, { processingDaysMax: 30 });
    assert.deepEqual(row.citations, { processingDaysMax: "within 3 weeks" });
    assert.equal((row.proposedScrapeMeta as any).contentHash, "h2");
    assert.equal(row.contentHash, "h2");
    assert.equal(row.sourceUrl, URL);
    assert.equal(row.proposedSourceUrl, URL);
    assert.equal(row.model, "stub-model");
    assert.equal(row.approvable, true);
    assert.ok(row.createdAt instanceof Timestamp);
  });

  test("identical extraction (new hash) → 'unchanged', no row", async () => {
    await seedLive();
    const r = await ingest(extraction(), "h2");
    assert.equal(r.outcome, "unchanged");
    assert.equal(rows().length, 0);
  });

  test("same hash as the live doc → 'unchanged', no write at all", async () => {
    await seedLive();
    const mark = writes.length;
    assert.equal((await ingest(extraction({ processingDaysMax: 30 }), "h1")).outcome, "unchanged");
    assert.equal(writes.length, mark);
  });

  test("same hash as the open row → 'unchanged', no write", async () => {
    await seedLive();
    await ingest(extraction({ processingDaysMax: 30 }), "h2");
    const mark = writes.length;
    assert.equal((await ingest(extraction({ processingDaysMax: 30 }), "h2")).outcome, "unchanged");
    assert.equal(writes.length, mark);
  });

  test("newer extraction overwrites the open row in place (same id + createdAt, revision+1)", async () => {
    await seedLive();
    await ingest(extraction({ processingDaysMax: 30 }), "h2");
    const [id1, first] = onlyRow();
    const r = await ingest(extraction({ processingDaysMax: 40, name: "Skilled Worker" }), "h3");
    assert.equal(r.outcome, "proposed");
    const [id2, second] = onlyRow();
    assert.equal(id2, id1);
    assert.ok((second.createdAt as Timestamp).isEqual(first.createdAt as Timestamp));
    assert.equal(second.revision, 2);
    assert.equal(second.contentHash, "h3");
    assert.deepEqual(second.proposed, { name: "Skilled Worker", processingDaysMax: 40 });
    assert.equal((second.proposedScrapeMeta as any).contentHash, "h3");
  });

  test("a resolved row is not replaced: the next diff opens a new row", async () => {
    await seedLive();
    await ingest(extraction({ processingDaysMax: 30 }), "h2");
    const [id1] = onlyRow();
    await changes.rejectChange(id1, "admin", "no");
    await ingest(extraction({ processingDaysMax: 40 }), "h3");
    assert.equal(rows().length, 2);
  });

  for (const [label, over] of [
    ["seeded uk-* (no source)", { source: undefined, reviewStatus: undefined }],
    ["agent-authored", { source: "agent", reviewStatus: "approved" }],
    ["rejected scraped", { reviewStatus: "rejected" }],
    ["withdrawn (staleSince)", { reviewStatus: "approved", staleSince: Timestamp.now() }],
  ] as [string, Data][]) {
    test(`${label} → 'skipped', no row, no write`, async () => {
      await seedLive();
      const cur = { ...store.get(VISA_PATH)!, ...over };
      for (const k of Object.keys(cur)) if (cur[k] === undefined) delete cur[k];
      store.set(VISA_PATH, cur);
      const mark = writes.length;
      assert.equal((await ingest(extraction({ processingDaysMax: 30 }), "h2")).outcome, "skipped");
      assert.equal(rows().length, 0);
      assert.equal(writes.length, mark);
    });
  }

  test("regression: pending_review scraped doc is still refreshed in place, no row", async () => {
    await seedLive({}); // stays pending_review
    const r = await ingest(extraction({ processingDaysMax: 30 }), "h2");
    assert.equal(r.outcome, "updated");
    assert.equal(store.get(VISA_PATH)!.processingDaysMax, 30);
    assert.equal((store.get(VISA_PATH)!.scrapeMeta as any).contentHash, "h2");
    assert.equal(rows().length, 0);
  });

  test("proposed fee goes through computeFee with the run's FX: stale → not approvable", async () => {
    await seedLive();
    await ingest(extraction({ feeComponents: [{ ...FEE[0], amount: 900 }] }), "h2", staleFx());
    const [, row] = onlyRow();
    assert.equal(row.approvable, false);
    assert.ok(row.blockReason);
    assert.equal((row.proposedScrapeMeta as any).fee.fxStale, true);
  });
});

// ============================================
// Orchestrator: summary + hash gate
// ============================================

describe("runOrchestrator — proposed count and the page hash gate", () => {
  test("first crawl proposes once; a second crawl with the same page text makes no extraction and no new row", async () => {
    await seedLive();
    store.set("visaSources/GB", {
      countryCode: CC,
      countryName: "United Kingdom",
      status: "active",
      nextCrawlAt: Timestamp.fromMillis(Date.now() - 1000),
      crawlIntervalHours: 168,
      consecutiveFailures: 0,
      reliabilityScore: 100,
      pages: [{ url: URL, routeName: "Skilled Worker visa", validation: "text_verified", visaId: VISA_ID }],
    });
    // Stub the adapter (generic-html is the default) and the extractor.
    const origAdapter = adapters.sourceAdapters["generic-html"];
    const origExtract = extractMod.visaCatalogExtractor.extract;
    let extractions = 0;
    adapters.sourceAdapters["generic-html"] = {
      id: "generic-html",
      canHandle: () => true,
      fetch: async () => ({
        url: URL,
        canonicalUrl: URL,
        sourceProvider: "generic-html",
        withdrawn: false,
        sections: [{ slug: "page", title: "", text: "new page text" }],
        text: "new page text",
        contentHash: "page-h2",
      }),
    };
    extractMod.visaCatalogExtractor.extract = async () => {
      extractions++;
      return extraction({ processingDaysMax: 30 });
    };
    try {
      const fetchFxRates = async () => ({ rates: { GBP: 0.8 }, rateDate: isoDaysAgo(1) });
      const s1 = await crawl.runOrchestrator({ fetchFxRates });
      assert.equal(s1.proposed, 1);
      assert.equal(s1.skipped, 0);
      assert.equal(extractions, 1);
      assert.equal(rows().length, 1);
      assert.equal((store.get("visaSources/GB")!.pages as any[])[0].lastContentHash, "page-h2");

      // Make the source due again; same page text.
      store.set("visaSources/GB", { ...store.get("visaSources/GB")!, nextCrawlAt: Timestamp.fromMillis(Date.now() - 1000) });
      const s2 = await crawl.runOrchestrator({ fetchFxRates });
      assert.equal(extractions, 1); // no second LLM call
      assert.equal(s2.proposed, 0);
      assert.equal(rows().length, 1);
      assert.equal(onlyRow()[1].revision, 1);
    } finally {
      adapters.sourceAdapters["generic-html"] = origAdapter;
      extractMod.visaCatalogExtractor.extract = origExtract;
    }
  });
});

// ============================================
// Approve
// ============================================

describe("approveChange", () => {
  /** Seed an approved live doc and propose `e`; returns the row id. */
  async function proposed(e: ExtractedVisa, fx: FxRatesDoc = freshFx()): Promise<string> {
    await seedLive();
    await ingest(e, "h2", fx);
    return onlyRow()[0];
  }

  test("happy path: only diffed fields + scrapeMeta + provenance; row approved; stats recomputed", async () => {
    const id = await proposed(extraction({ processingDaysMax: 30, feeComponents: [{ ...FEE[0], amount: 400 }] }));
    const before = clone(store.get(VISA_PATH))!;
    const mark = writes.length;
    const visa = await changes.approveChange(id, "admin-1");

    const vw = visaWritesSince(mark);
    assert.equal(vw.length, 1);
    assert.deepEqual(Object.keys(vw[0].data).sort(), [
      "baseCostUsd",
      "lastVerifiedAt",
      "processingDaysMax",
      "reviewedAt",
      "reviewedBy",
      "scrapeMeta",
      "sourceUrl",
      "updatedAt",
    ]);
    const after = store.get(VISA_PATH)!;
    assert.equal(after.processingDaysMax, 30);
    assert.equal(after.baseCostUsd, 500); // 400 / 0.8
    assert.equal(after.baseCostUsd, Math.round((after.scrapeMeta as any).fee.totalUsd));
    assert.equal((after.scrapeMeta as any).contentHash, "h2");
    assert.equal(after.reviewedBy, "admin-1");
    assert.ok(after.lastVerifiedAt instanceof Timestamp);
    for (const k of ["isActive", "reviewStatus", "source", "code", "agentIds", "createdAt", "name"]) {
      assert.deepEqual(after[k], before[k], k);
    }
    assert.equal(visa.processingDaysMax, 30);
    assert.equal(visa.id, VISA_ID);

    const row = store.get(`pendingVisaChanges/${id}`)!;
    assert.equal(row.status, "approved");
    assert.equal(row.resolvedBy, "admin-1");
    assert.ok(row.resolvedAt instanceof Timestamp);
    assert.deepEqual(row.appliedFields, ["processingDaysMax", "baseCostUsd"]);

    // Stats recomputed after commit (cheaper cost now the min).
    assert.equal(store.get(`countries/${CC}`)!.minCostUsd, 500);
  });

  test("409 ALREADY_RESOLVED on a second approve", async () => {
    const id = await proposed(extraction({ processingDaysMax: 30 }));
    await changes.approveChange(id, "admin-1");
    await assert.rejects(changes.approveChange(id, "admin-1"), { code: "ALREADY_RESOLVED", httpStatus: 409 });
  });

  for (const [label, over] of [
    ["a diffed field changed", { processingDaysMax: 22 }],
    ["the doc was deactivated / unapproved", { reviewStatus: "rejected", isActive: false }],
    ["the doc was withdrawn (staleSince)", { staleSince: Timestamp.now() }],
  ] as [string, Data][]) {
    test(`409 STALE_PROPOSAL when ${label}; nothing written, row stays open`, async () => {
      const id = await proposed(extraction({ processingDaysMax: 30 }));
      store.set(VISA_PATH, { ...store.get(VISA_PATH)!, ...over });
      const mark = writes.length;
      await assert.rejects(changes.approveChange(id, "admin-1"), { code: "STALE_PROPOSAL", httpStatus: 409 });
      assert.equal(writes.length, mark);
      assert.equal(store.get(`pendingVisaChanges/${id}`)!.status, "open");
    });
  }

  test("fee-flagged proposal is refused with VisaFeeNotConvertibleError; nothing written", async () => {
    const id = await proposed(extraction({ feeComponents: [{ ...FEE[0], amount: 900 }] }), staleFx());
    const mark = writes.length;
    await assert.rejects(changes.approveChange(id, "admin-1"), { name: "VisaFeeNotConvertibleError" });
    assert.equal(writes.length, mark);
  });

  test("expectedRevision: matching revision approves; a different one → 409 REVISION_MISMATCH, nothing written, row open", async () => {
    await seedLive();
    await ingest(extraction({ processingDaysMax: 30 }), "h2");
    await ingest(extraction({ processingDaysMax: 40 }), "h3"); // revision 2
    const [id] = onlyRow();
    const mark = writes.length;
    await assert.rejects(changes.approveChange(id, "admin-1", 1), { code: "REVISION_MISMATCH", httpStatus: 409 });
    assert.equal(writes.length, mark);
    assert.equal(store.get(`pendingVisaChanges/${id}`)!.status, "open");
    const visa = await changes.approveChange(id, "admin-1", 2);
    assert.equal(visa.processingDaysMax, 40);
  });

  test("a proposal that empties eligibilityCriteria is refused (409 ELIGIBILITY_REMOVED, nothing written); reject works", async () => {
    await seedLive();
    await ingest(extraction({ eligibilityCriteria: [] }), "h2");
    const [id, row] = onlyRow();
    assert.equal(row.approvable, false);
    assert.match(row.blockReason as string, /would remove all eligibility criteria/);
    const mark = writes.length;
    await assert.rejects(changes.approveChange(id, "admin-1"), { code: "ELIGIBILITY_REMOVED", httpStatus: 409 });
    assert.equal(writes.length, mark);
    assert.deepEqual(store.get(VISA_PATH)!.eligibilityCriteria, ["Job offer"]);
    const rejected = await changes.rejectChange(id, "admin-1", "Bad extraction");
    assert.equal(rejected.status, "rejected");
  });

  test("404 for a missing row or a missing visa doc", async () => {
    await assert.rejects(changes.approveChange("nope", "a"), { code: "NOT_FOUND", httpStatus: 404 });
    const id = await proposed(extraction({ processingDaysMax: 30 }));
    store.delete(VISA_PATH);
    await assert.rejects(changes.approveChange(id, "a"), { code: "NOT_FOUND", httpStatus: 404 });
  });

  test("a failing stats recompute is logged and swallowed (approval committed)", async () => {
    const id = await proposed(extraction({ processingDaysMax: 30 }));
    const orig = visaSvc.updateCountryStats;
    visaSvc.updateCountryStats = async () => {
      throw new Error("boom");
    };
    try {
      const { result, logged } = await quiet(() => changes.approveChange(id, "admin-1"));
      assert.equal((result as any).processingDaysMax, 30);
      assert.equal(logged.length, 1);
      assert.equal(store.get(`pendingVisaChanges/${id}`)!.status, "approved");
    } finally {
      visaSvc.updateCountryStats = orig;
    }
  });
});

// ============================================
// Reject + re-convert
// ============================================

describe("rejectChange / reconvertFlaggedFees", () => {
  test("reject marks the row rejected; live doc untouched; fee flags never block", async () => {
    await seedLive();
    await ingest(extraction({ feeComponents: [{ ...FEE[0], amount: 900 }] }), "h2", staleFx());
    const [id] = onlyRow();
    const live = clone(store.get(VISA_PATH));
    const row = await changes.rejectChange(id, "admin-1", "Wrong page");
    assert.equal(row.status, "rejected");
    assert.equal(row.rejectionReason, "Wrong page");
    assert.equal(row.resolvedBy, "admin-1");
    assert.ok(row.resolvedAt instanceof Timestamp);
    assert.deepEqual(store.get(VISA_PATH), live);
    await assert.rejects(changes.rejectChange(id, "admin-1", "again"), { code: "ALREADY_RESOLVED" });
    await assert.rejects(changes.rejectChange("nope", "admin-1", "x"), { code: "NOT_FOUND" });
  });

  test("an open row with a stale proposed fee is re-converted (no LLM) and becomes approvable", async () => {
    await seedLive();
    await ingest(extraction({ feeComponents: [{ ...FEE[0], amount: 900 }] }), "h2", staleFx());
    const [id, row] = onlyRow();
    assert.equal(row.approvable, false);
    const result = await catalog.reconvertFlaggedFees(freshFx());
    assert.equal(result.proposalsReconverted, 1);
    const after = store.get(`pendingVisaChanges/${id}`)!;
    assert.equal(after.approvable, true);
    assert.equal("blockReason" in after, false);
    assert.equal((after.proposed as any).baseCostUsd, 1125);
    assert.equal((after.proposedScrapeMeta as any).fee.fxStale, undefined);
    // …and it can now be approved, consistently.
    await changes.approveChange(id, "admin-1");
    const live = store.get(VISA_PATH)!;
    assert.equal(live.baseCostUsd, Math.round((live.scrapeMeta as any).fee.totalUsd));
  });
});

// ============================================
// Controller
// ============================================

// ============================================
// Withdrawal closes open proposals (issue #68 review fix)
// ============================================

describe("markWithdrawn — closes open proposals for the visa (issue #68)", () => {
  test("an open proposal becomes rejected/superseded by the system; resolved rows and other visas are untouched", async () => {
    // Approved live doc + an open proposal from a changed page (h2).
    await seedLive();
    await ingest(extraction({ processingDaysMax: 30 }), "h2");
    const [openId] = onlyRow();
    // An already-rejected row for the same visa, and an open row for ANOTHER visa.
    const done = { countryCode: CC, visaId: VISA_ID, status: "rejected", rejectionReason: "admin said no", resolvedBy: "admin-1" };
    store.set("pendingVisaChanges/done", clone(done));
    const other = { countryCode: CC, visaId: "gb-other", status: "open" };
    store.set("pendingVisaChanges/other", clone(other));

    const outcome = await catalog.markWithdrawn(CC, VISA_ID);

    assert.equal(outcome, "deactivated");
    const row = store.get(`pendingVisaChanges/${openId}`)!;
    assert.equal(row.status, "rejected");
    assert.equal(row.rejectionReason, changesMod.SUPERSEDED_BY_WITHDRAWAL_REASON);
    assert.equal(row.resolvedBy, changesMod.SYSTEM_RESOLVER);
    assert.ok(row.resolvedAt instanceof Timestamp);
    assert.deepEqual(store.get("pendingVisaChanges/done"), done);
    assert.deepEqual(store.get("pendingVisaChanges/other"), other);
    // The live doc is only deactivated; the proposal was never applied.
    assert.equal(store.get(VISA_PATH)!.isActive, false);
    assert.notEqual(store.get(VISA_PATH)!.processingDaysMax, 30);
  });

  test("withdraw → restore (same text) → re-approve: the pre-withdrawal proposal cannot be approved", async () => {
    await seedLive();
    await ingest(extraction({ processingDaysMax: 30 }), "h2");
    const [openId, openRow] = onlyRow();
    await catalog.markWithdrawn(CC, VISA_ID);
    await catalog.markRestored(CC, VISA_ID);
    await visaSvc.updateVisaReviewStatus(CC, VISA_ID, "approve", "admin-1");
    await assert.rejects(changes.approveChange(openId, "admin-1", openRow.revision), /already rejected/);
  });

  test("a later withdrawn crawl (already inactive) still closes a row left open", async () => {
    await seedLive({ reviewStatus: "approved", isActive: false, staleSince: Timestamp.fromMillis(1) });
    store.set("pendingVisaChanges/late", { countryCode: CC, visaId: VISA_ID, status: "open" });
    assert.equal(await catalog.markWithdrawn(CC, VISA_ID), "already_inactive");
    assert.equal(store.get("pendingVisaChanges/late")!.status, "rejected");
  });

  test("seeded / agent docs: no proposal query side effects", async () => {
    await seedLive({ source: undefined });
    store.set("pendingVisaChanges/x", { countryCode: CC, visaId: VISA_ID, status: "open" });
    assert.equal(await catalog.markWithdrawn(CC, VISA_ID), "not_scraped");
    assert.equal(store.get("pendingVisaChanges/x")!.status, "open");
  });
});

describe("visaChangeController — status codes, validation, authz", () => {
  test("list: default status=open, newest first, [] when empty; invalid status / limit / countryCode → 400", async () => {
    let out = await call("list", req(ROLES.ADMIN));
    assert.equal(out.status, 200);
    assert.deepEqual(out.body.data, []);

    const mk = (id: string, ms: number, status = "open", countryCode = CC) =>
      store.set(`pendingVisaChanges/${id}`, { status, countryCode, createdAt: Timestamp.fromMillis(ms) });
    mk("old", 1000);
    mk("new", 2000);
    mk("done", 3000, "approved");
    mk("us", 4000, "open", "US");
    out = await call("list", req(ROLES.ADMIN, { query: { countryCode: "gb" } }));
    assert.deepEqual(out.body.data.map((r: any) => r.id), ["new", "old"]);
    out = await call("list", req(ROLES.ADMIN, { query: { status: "approved" } }));
    assert.deepEqual(out.body.data.map((r: any) => r.id), ["done"]);
    out = await call("list", req(ROLES.ADMIN, { query: { limit: "1" } }));
    assert.deepEqual(out.body.data.map((r: any) => r.id), ["us"]);
    out = await call("list", req(ROLES.ADMIN, { query: { limit: "500" } })); // capped, not an error
    assert.equal(out.status, 200);

    for (const query of [
      { status: "bogus" },
      { status: ["open", "approved"] }, // repeated param → array
      { limit: "0" },
      { limit: "x" },
      { limit: ["5"] },
      { countryCode: "GBR" },
      { countryCode: ["GB"] },
    ]) {
      out = await call("list", req(ROLES.ADMIN, { query }));
      assert.equal(out.status, 400, JSON.stringify(query));
      assert.equal(out.body.error, "VALIDATION_ERROR");
    }
  });

  test("get: row or 404", async () => {
    store.set("pendingVisaChanges/c1", { status: "open", countryCode: CC });
    let out = await call("get", req(ROLES.ADMIN, { params: { id: "c1" } }));
    assert.equal(out.status, 200);
    assert.equal(out.body.data.id, "c1");
    out = await call("get", req(ROLES.ADMIN, { params: { id: "nope" } }));
    assert.equal(out.status, 404);
  });

  test("approve: 200 with the visa, 409 ALREADY_RESOLVED / STALE_PROPOSAL / FEE_NOT_CONVERTED, 404", async () => {
    await seedLive();
    await ingest(extraction({ processingDaysMax: 30 }), "h2");
    const [id] = onlyRow();
    let out = await call("approve", req(ROLES.ADMIN, { params: { id } }));
    assert.equal(out.status, 200);
    assert.equal(out.body.data.processingDaysMax, 30);
    out = await call("approve", req(ROLES.ADMIN, { params: { id } }));
    assert.equal(out.status, 409);
    assert.equal(out.body.error, "ALREADY_RESOLVED");
    out = await call("approve", req(ROLES.ADMIN, { params: { id: "nope" } }));
    assert.equal(out.status, 404);

    // Stale.
    await ingest(extraction({ processingDaysMax: 40 }), "h3");
    const open = rows().find(([, d]) => d.status === "open")![0];
    store.set(VISA_PATH, { ...store.get(VISA_PATH)!, processingDaysMax: 31 });
    out = await call("approve", req(ROLES.ADMIN, { params: { id: open } }));
    assert.equal(out.status, 409);
    assert.equal(out.body.error, "STALE_PROPOSAL");
  });

  test("approve: expectedRevision mismatch → 409 REVISION_MISMATCH; non-integer → 400", async () => {
    await seedLive();
    await ingest(extraction({ processingDaysMax: 30 }), "h2");
    const [id] = onlyRow();
    let out = await call("approve", req(ROLES.ADMIN, { params: { id }, body: { expectedRevision: 2 } }));
    assert.equal(out.status, 409);
    assert.equal(out.body.error, "REVISION_MISMATCH");
    for (const expectedRevision of ["1", 1.5, 0]) {
      out = await call("approve", req(ROLES.ADMIN, { params: { id }, body: { expectedRevision } }));
      assert.equal(out.status, 400, String(expectedRevision));
    }
    assert.equal(store.get(`pendingVisaChanges/${id}`)!.status, "open");
    out = await call("approve", req(ROLES.ADMIN, { params: { id }, body: { expectedRevision: 1 } }));
    assert.equal(out.status, 200);
  });

  test("approve of an eligibility-emptying proposal → 409 ELIGIBILITY_REMOVED", async () => {
    await seedLive();
    await ingest(extraction({ eligibilityCriteria: [] }), "h2");
    const out = await call("approve", req(ROLES.ADMIN, { params: { id: onlyRow()[0] } }));
    assert.equal(out.status, 409);
    assert.equal(out.body.error, "ELIGIBILITY_REMOVED");
  });

  test("ids Firestore rejects → 404 (not 500) on get / approve / reject", async () => {
    // Use the REAL doc-id rules: a fake collection would accept anything, so
    // assert the guard rejects before any Firestore call.
    for (const id of ["..", ".", "a/b", "__x__", "x".repeat(1501)]) {
      assert.equal(changesMod.isValidDocId(id), false, id);
      for (const handler of ["get", "approve", "reject"]) {
        const out = await call(handler, req(ROLES.ADMIN, { params: { id }, body: { reason: "x" } }));
        assert.equal(out.status, 404, `${handler} ${id.slice(0, 10)}`);
        assert.equal(out.body.error, "NOT_FOUND");
      }
    }
    assert.equal(changesMod.isValidDocId("sWPFAQbJ01MXCovE0cb9"), true);
  });

  test("approve of a fee-flagged proposal → 409 FEE_NOT_CONVERTED", async () => {
    await seedLive();
    await ingest(extraction({ feeComponents: [{ ...FEE[0], amount: 900 }] }), "h2", staleFx());
    const out = await call("approve", req(ROLES.ADMIN, { params: { id: onlyRow()[0] } }));
    assert.equal(out.status, 409);
    assert.equal(out.body.error, "FEE_NOT_CONVERTED");
  });

  test("reject: 400 on missing/blank reason, 200 then 409 ALREADY_RESOLVED", async () => {
    await seedLive();
    await ingest(extraction({ processingDaysMax: 30 }), "h2");
    const [id] = onlyRow();
    for (const body of [{}, { reason: "   " }, { reason: 3 }]) {
      const out = await call("reject", req(ROLES.ADMIN, { params: { id }, body }));
      assert.equal(out.status, 400);
      assert.equal(out.body.error, "VALIDATION_ERROR");
    }
    let out = await call("reject", req(ROLES.ADMIN, { params: { id }, body: { reason: " Wrong " } }));
    assert.equal(out.status, 200);
    assert.equal(out.body.data.rejectionReason, "Wrong");
    out = await call("reject", req(ROLES.ADMIN, { params: { id }, body: { reason: "again" } }));
    assert.equal(out.status, 409);
  });

  test("owner / agent / client → 403 on all four routes, before any read", async () => {
    store.set("pendingVisaChanges/c1", { status: "open", countryCode: CC, visaId: VISA_ID });
    for (const role of [ROLES.OWNER, ROLES.AGENT, ROLES.CLIENT]) {
      for (const handler of ["list", "get", "approve", "reject"]) {
        const out = await call(handler, req(role, { params: { id: "c1" }, body: { reason: "x" } }));
        assert.equal(out.status, 403, `${role} ${handler}`);
        assert.equal(out.body.error, "FORBIDDEN");
      }
    }
    assert.equal(store.get("pendingVisaChanges/c1")!.status, "open");
  });

  test("no token → 401 from verifyAuth (handler never reached)", async () => {
    const { res, out } = fakeRes();
    let nextCalled = false;
    await authMw.verifyAuth({ headers: {}, method: "GET", originalUrl: "/admin/visa-changes" }, res, () => {
      nextCalled = true;
    });
    assert.equal(out.status, 401);
    assert.equal(nextCalled, false);
  });

  test("controller has no role string literals: the gate is the CASL ability (admin has it)", () => {
    const admin = defineAbilitiesFor({ uid: "a", role: ROLES.ADMIN, agencyId: null });
    for (const action of ["read", "approve", "reject"]) assert.equal(admin.can(action, "VisaChange"), true);
  });
});

// ============================================
// Issue #212: the checklist shrink guard + normalised diff
// ============================================

describe("requiredDocuments diff — shrink guard (issue #212)", () => {
  /** A live visa listing `items` with a verbatim quote for each. */
  async function seedLiveWithDocs(items: string[], quotes: boolean = true): Promise<void> {
    await seedLive();
    const cur = store.get(VISA_PATH)!;
    const scrapeMeta = { ...(cur.scrapeMeta as any), citations: quotes ? Object.fromEntries(items.map((t, i) => [`requiredDocuments.${i}`, `quote of ${t}`])) : {} };
    store.set(VISA_PATH, { ...cur, requiredDocuments: items, scrapeMeta });
  }
  const docs = (items: string[]) => ({
    requiredDocuments: items,
    citations: Object.fromEntries(items.map((t, i) => [`requiredDocuments.${i}`, t])),
  });

  test("a shrinking extraction creates an open row with removedDetails (item + the live visa's own quote); the live list is untouched", async () => {
    await seedLiveWithDocs(["a passport", "a photo", "a TB test"]);
    const liveBefore = clone(store.get(VISA_PATH));
    const mark = writes.length;
    const r = await ingest(extraction(docs(["a photo"])), "h2");
    assert.equal(r.outcome, "proposed");
    assert.deepEqual(store.get(VISA_PATH), liveBefore);
    assert.equal(visaWritesSince(mark).length, 0);
    const [, row] = onlyRow();
    const d = (row.diff as any[]).find((x) => x.field === "requiredDocuments");
    assert.deepEqual(d.removed, ["a passport", "a TB test"]);
    assert.deepEqual(d.removedDetails, [
      { item: "a passport", quote: "quote of a passport" },
      { item: "a TB test", quote: "quote of a TB test" },
    ]);
  });

  test("a removed item the live visa has no quote for carries no quote", async () => {
    await seedLiveWithDocs(["a passport", "a photo"], false);
    await ingest(extraction(docs(["a photo"])), "h2");
    const d = (onlyRow()[1].diff as any[]).find((x) => x.field === "requiredDocuments");
    assert.deepEqual(d.removedDetails, [{ item: "a passport" }]);
  });

  test("an empty proposed list shows every live item as removed; a newer shrinking extraction replaces the open row", async () => {
    await seedLiveWithDocs(["a passport", "a photo"]);
    await ingest(extraction(docs([])), "h2");
    let [id, row] = onlyRow();
    assert.deepEqual((row.diff as any[]).find((x) => x.field === "requiredDocuments").removed, ["a passport", "a photo"]);
    await ingest(extraction(docs(["a photo"])), "h3");
    [, row] = onlyRow();
    assert.equal(onlyRow()[0], id);
    assert.equal(row.revision, 2);
    assert.deepEqual((row.diff as any[]).find((x) => x.field === "requiredDocuments").removed, ["a passport"]);
  });

  test("curly vs straight apostrophes are the same item: no remove + add", async () => {
    await seedLiveWithDocs(["your parents' names", "a photo"]);
    // The re-crawl text now carries the curly apostrophe; everything else is identical.
    const r = await ingest(extraction(docs(["your parents’ names", "a photo"])), "h2");
    assert.equal(r.outcome, "unchanged");
    assert.equal(rows().length, 0);
  });

  test("itemKey (used by the diff) is exactly normForQuote", async () => {
    const { itemKey } = await import("../../../../src/scrapers/visa-catalog/required-document-meta");
    for (const s of ["Your parents’ names", "a – b — c", "  Two   spaces ", "“quoted”"]) {
      assert.equal(itemKey(s), extractMod.normForQuote(s));
    }
  });
});

// ============================================
// Issue #212: approving a proposal with missing items needs the acknowledgement
// ============================================

describe("approveChange — missingFromExtraction acknowledgement (issue #212)", () => {
  const missing = [{ text: "a passport", leadIn: "", section: "s", appended: true }];
  /** Propose a change whose scrapeMeta records `missingFromExtraction`. */
  async function proposedWithMissing(list: unknown[] | undefined): Promise<string> {
    await seedLive();
    await ingest(extraction({ processingDaysMax: 30, ...(list ? { missingFromExtraction: list as any } : {}) }), "h2");
    return onlyRow()[0];
  }

  test("non-empty and not acknowledged: 409 MISSING_ITEMS_UNACKNOWLEDGED, nothing written, row stays open", async () => {
    const id = await proposedWithMissing(missing);
    const mark = writes.length;
    await assert.rejects(changes.approveChange(id, "admin-1"), { code: "MISSING_ITEMS_UNACKNOWLEDGED", httpStatus: 409 });
    assert.equal(visaWritesSince(mark).length, 0);
    assert.equal(store.get(`pendingVisaChanges/${id}`)!.status, "open");
    // Through the controller.
    const out = await call("approve", req(ROLES.ADMIN, { params: { id } }));
    assert.equal(out.status, 409);
    assert.equal(out.body.error, "MISSING_ITEMS_UNACKNOWLEDGED");
    // A non-boolean flag is a 400.
    const bad = await call("approve", req(ROLES.ADMIN, { params: { id }, body: { acknowledgeMissingItems: 1 } }));
    assert.equal(bad.status, 400);
  });

  test("acknowledged: approves, stores who and when on the visa", async () => {
    const id = await proposedWithMissing(missing);
    const out = await call("approve", req(ROLES.ADMIN, { params: { id }, body: { acknowledgeMissingItems: true } }));
    assert.equal(out.status, 200);
    const after = store.get(VISA_PATH)!;
    assert.equal(typeof after.missingItemsAcknowledgedBy, "string");
    assert.ok((after.missingItemsAcknowledgedBy as string).length > 0);
    assert.ok(after.missingItemsAcknowledgedAt instanceof Timestamp);
    assert.deepEqual((after.scrapeMeta as any).missingFromExtraction, missing);
  });

  test("[] and an absent field approve as today", async () => {
    for (const list of [[], undefined]) {
      resetStore();
      const id = await proposedWithMissing(list as any);
      await changes.approveChange(id, "admin-1");
      assert.equal("missingItemsAcknowledgedBy" in store.get(VISA_PATH)!, false);
    }
  });
});
