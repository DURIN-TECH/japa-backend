// ============================================
// Unit tests — manual USD cost on pending scraped visas (issue #70)
// ============================================
//
// Run with `npm test`. NO network and NO emulator: Firebase Admin is
// initialised against a dummy project id (never contacted) and every
// collection ref + transaction runner is swapped for the in-memory fake in
// helpers/fake-firestore.ts.
//
// Covers:
//  - parseManualCostInput: valid body (normalised), and every 400 rule
//    (amount type / finite / > 0 / rounds to >= 1 / max, reason required +
//    length, rate shape, expectedContentHash)
//  - planManualCost: TWD fxMissing / feeUnverified / noPublishedFee / pre-#59
//    docs → fxSource "manual", flags cleared (kept in `previous`), components
//    kept, baseCostUsd = round(amount), and the approval guard accepts it;
//    refusals (not pending / not scraped / already converted / stale hash);
//    correcting an earlier manual cost records `supersedes`
//  - planManualCostOverwrite (pure)
//  - PUT /admin/visas/:id/manual-cost controller: 200 + one transactional
//    write; then PATCH review approve succeeds; 403 for owner / agent /
//    client (nothing written, before validation); 400 / 404 / 409 mapping;
//    401 without a token (verifyAuth)
//  - ingest after a manual cost: changed content that converts replaces it
//    (recorded in replacedManualCost + logged); changed content that is
//    flagged deletes the cost (approval blocked again); same content hash →
//    untouched; an FX re-convert keeps the replacedManualCost audit entry

import { test, describe, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Timestamp } from "firebase-admin/firestore";
import { ROLES, defineAbilitiesFor } from "@durin-tech/authz";
import type { Role } from "@durin-tech/authz";

import type { ExtractedFeeComponent, ExtractedVisa, FxRatesDoc, VisaFeeMeta } from "../src/types/visa-catalog";
import {
  FX_SOURCE_ECB,
  FX_SOURCE_MANUAL,
  VisaFeeNotConvertibleError,
  assertVisaApprovable,
  computeFee,
} from "../src/services/visa-catalog-fx";
import {
  MAX_MANUAL_COST_USD,
  ManualCostError,
  ManualCostInput,
  parseManualCostInput,
  planManualCost,
  planManualCostOverwrite,
} from "../src/services/visa-manual-cost";
import { Data, clone, installFakes, resetStore, store, writes } from "./helpers/fake-firestore";

// Admin init needs a project id (utils/firebase derives the bucket from it).
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || "demo-unit-test";

// ============================================
// Fixtures
// ============================================

const DAY_MS = 24 * 60 * 60 * 1000;
const CC = "TW";
const VISA_ID = "tw-visitor-visa";
const VISA_PATH = `countries/${CC}/visaTypes/${VISA_ID}`;
const URL = "https://www.boca.gov.tw/visitor-visa";
const NOW = Timestamp.fromMillis(Date.UTC(2026, 10, 10, 12));
const isoDaysAgo = (d: number) => new Date(Date.now() - d * DAY_MS).toISOString().slice(0, 10);

/** A fresh rate doc WITHOUT TWD (ECB does not publish it), with GBP. */
const freshFx = (): FxRatesDoc => ({
  base: "USD",
  rates: { GBP: 0.8 },
  fetchedAt: Timestamp.now(),
  rateDate: isoDaysAgo(1),
  source: FX_SOURCE_ECB,
});

const TWD_FEE: ExtractedFeeComponent[] = [
  { kind: "application", label: "Visa fee", amount: 1600, currency: "TWD", per: "application" },
];
const GBP_FEE: ExtractedFeeComponent[] = [
  { kind: "application", label: "Visa fee", amount: 80, currency: "GBP", per: "application" },
];

/** A validated extraction (override any field). */
function extraction(over: Partial<ExtractedVisa> = {}): ExtractedVisa {
  return {
    name: "Visitor visa",
    code: "V",
    description: "Visit Taiwan.",
    category: "tourist",
    processingTime: "5 days",
    processingDaysMin: 1,
    processingDaysMax: 5,
    feeComponents: TWD_FEE,
    validityPeriod: "90 days",
    isExtendable: false,
    eligibilityCriteria: ["Valid passport"],
    confidence: 0.9,
    citations: { "fee.application": "NT$1,600" },
    ...over,
  } as ExtractedVisa;
}

/** A pending scraped visa doc (pure-test shape) with the fee computed from `components`. */
function pendingVisa(components: ExtractedFeeComponent[], over: Data = {}, reasons?: string[]): any {
  const { baseCostUsd, feeMeta } = computeFee(components, freshFx(), NOW, { unverifiedReasons: reasons });
  const doc: Data = {
    source: "scraped",
    reviewStatus: "pending_review",
    isActive: false,
    scrapeMeta: { contentHash: "h1", fee: feeMeta },
    ...over,
  };
  if (baseCostUsd !== undefined) doc.baseCostUsd = baseCostUsd;
  return doc;
}

/** A valid parsed input (override any field). */
function input(over: Partial<ManualCostInput> = {}): ManualCostInput {
  return { countryCode: CC, amountUsd: 51.6, reason: "CBC rate 1 TWD = 0.03225 USD", ...over };
}

/** Assert `fn` throws a ManualCostError with `code` (and optional status). */
function throwsCode(fn: () => unknown, code: string, status?: number): void {
  assert.throws(fn, (e: unknown) => {
    assert.ok(e instanceof ManualCostError, `expected ManualCostError, got ${e}`);
    assert.equal(e.code, code);
    if (status !== undefined) assert.equal(e.httpStatus, status);
    return true;
  });
}

// ============================================
// parseManualCostInput
// ============================================

describe("parseManualCostInput", () => {
  const ok = { countryCode: "tw", amountUsd: 51.6, reason: "  CBC rate  " };

  test("valid body → normalised (country upper-cased, reason trimmed)", () => {
    assert.deepEqual(parseManualCostInput(ok), { countryCode: "TW", amountUsd: 51.6, reason: "CBC rate" });
  });

  test("optional rate (currency upper-cased) and expectedContentHash are kept", () => {
    const got = parseManualCostInput({ ...ok, rate: { currency: "twd", usdPerUnit: 0.031 }, expectedContentHash: "h1" });
    assert.deepEqual(got.rate, { currency: "TWD", usdPerUnit: 0.031 });
    assert.equal(got.expectedContentHash, "h1");
  });

  test("rate / expectedContentHash null are treated as absent", () => {
    const got = parseManualCostInput({ ...ok, rate: null, expectedContentHash: null });
    assert.equal("rate" in got, false);
    assert.equal("expectedContentHash" in got, false);
  });

  const bad: [string, unknown][] = [
    ["not an object", "x"],
    ["array body", []],
    ["missing countryCode", { amountUsd: 10, reason: "abc" }],
    ["3-letter countryCode", { ...ok, countryCode: "TWN" }],
    ["amountUsd as a string", { ...ok, amountUsd: "51.6" }],
    ["amountUsd missing", { countryCode: "TW", reason: "abc" }],
    ["amountUsd NaN", { ...ok, amountUsd: NaN }],
    ["amountUsd Infinity", { ...ok, amountUsd: Infinity }],
    ["amountUsd 0", { ...ok, amountUsd: 0 }],
    ["amountUsd negative", { ...ok, amountUsd: -5 }],
    ["amountUsd rounds to 0", { ...ok, amountUsd: 0.4 }],
    ["amountUsd over the max", { ...ok, amountUsd: MAX_MANUAL_COST_USD + 1 }],
    ["reason missing", { countryCode: "TW", amountUsd: 10 }],
    ["reason blank", { ...ok, reason: "   " }],
    ["reason too short", { ...ok, reason: "ok" }],
    ["reason too long", { ...ok, reason: "x".repeat(501) }],
    ["rate not an object", { ...ok, rate: 0.03 }],
    ["rate currency not ISO 4217", { ...ok, rate: { currency: "XYZ", usdPerUnit: 0.03 } }],
    ["rate currency USD", { ...ok, rate: { currency: "USD", usdPerUnit: 1 } }],
    ["rate usdPerUnit 0", { ...ok, rate: { currency: "TWD", usdPerUnit: 0 } }],
    ["rate usdPerUnit string", { ...ok, rate: { currency: "TWD", usdPerUnit: "0.03" } }],
    ["expectedContentHash empty", { ...ok, expectedContentHash: "" }],
  ];
  for (const [name, body] of bad) {
    test(`400 VALIDATION_ERROR: ${name}`, () => throwsCode(() => parseManualCostInput(body), "VALIDATION_ERROR", 400));
  }

  test("the max itself is accepted", () => {
    assert.equal(parseManualCostInput({ ...ok, amountUsd: MAX_MANUAL_COST_USD }).amountUsd, MAX_MANUAL_COST_USD);
  });
});

// ============================================
// planManualCost (pure)
// ============================================

describe("planManualCost", () => {
  test("TWD fee (fxMissing) → manual block, flags cleared, guard accepts", () => {
    const visa = pendingVisa(TWD_FEE);
    assert.equal(visa.scrapeMeta.fee.fxMissing, true);
    const plan = planManualCost(visa, input({ rate: { currency: "TWD", usdPerUnit: 0.03225 } }), "admin-1", NOW);

    assert.equal(plan.baseCostUsd, 52); // Math.round(51.6)
    const fee = plan.fee;
    assert.equal(fee.totalUsd, 51.6);
    assert.equal(fee.fxSource, FX_SOURCE_MANUAL);
    assert.equal(fee.fxSource, "manual");
    assert.equal(fee.fxDate, "2026-11-10");
    assert.equal("fxMissing" in fee, false);
    assert.equal("fxStale" in fee, false);
    assert.equal("feeUnverified" in fee, false);
    assert.equal("fxRateToUsd" in fee, false);
    // Published components / totals untouched.
    assert.deepEqual(fee.components, visa.scrapeMeta.fee.components);
    assert.deepEqual(fee.totals, [{ currency: "TWD", amount: 1600 }]);
    // Who / when / why / rate.
    assert.deepEqual(fee.manualCost, {
      amountUsd: 51.6,
      reason: "CBC rate 1 TWD = 0.03225 USD",
      rate: { currency: "TWD", usdPerUnit: 0.03225 },
      setBy: "admin-1",
      setAt: NOW,
      contentHash: "h1",
      previous: { fxMissing: true },
    });
    // The approval guard (baseCostUsd === round(totalUsd)) accepts it.
    assert.doesNotThrow(() =>
      assertVisaApprovable({ ...visa, baseCostUsd: plan.baseCostUsd, scrapeMeta: { ...visa.scrapeMeta, fee } })
    );
  });

  test("feeUnverified (dropped surcharge) → cleared, reason kept in previous", () => {
    const visa = pendingVisa(GBP_FEE, {}, ["dropped surcharge"]);
    assert.equal(visa.scrapeMeta.fee.feeUnverified, true);
    const plan = planManualCost(visa, input({ amountUsd: 900 }), "admin-1", NOW);
    assert.equal("feeUnverified" in plan.fee, false);
    assert.equal("feeUnverifiedReason" in plan.fee, false);
    // fxSource is kept too: the GBP part was converted, only the total was untrusted.
    assert.deepEqual(plan.fee.manualCost!.previous, {
      feeUnverified: true,
      feeUnverifiedReason: "dropped surcharge",
      fxSource: FX_SOURCE_ECB,
    });
    assert.equal(plan.baseCostUsd, 900);
  });

  test("fxStale → cleared; the old (stale-era) baseCostUsd is recorded in previous", () => {
    const visa = pendingVisa(GBP_FEE);
    // Flag it stale as ingest would with an old rate (cost left in place).
    const { feeMeta } = computeFee(GBP_FEE, { ...freshFx(), fetchedAt: Timestamp.fromMillis(0) }, NOW);
    visa.scrapeMeta.fee = feeMeta;
    assert.equal(feeMeta.fxStale, true);
    const plan = planManualCost(visa, input({ amountUsd: 100 }), "admin-1", NOW);
    assert.equal("fxStale" in plan.fee, false);
    assert.deepEqual(plan.fee.manualCost!.previous, { fxStale: true, baseCostUsd: 100 });
  });

  test("no published fee → cleared (noPublishedFee in previous), empty components kept", () => {
    const plan = planManualCost(pendingVisa([]), input({ amountUsd: 30 }), "admin-1", NOW);
    assert.equal("noPublishedFee" in plan.fee, false);
    assert.deepEqual(plan.fee.components, []);
    assert.deepEqual(plan.fee.manualCost!.previous, { noPublishedFee: true });
  });

  test("pre-#59 scraped doc (no fee block) gets one", () => {
    const visa = { source: "scraped", reviewStatus: "pending_review", scrapeMeta: { contentHash: "h0" } } as any;
    const plan = planManualCost(visa, input(), "admin-1", NOW);
    assert.deepEqual(plan.fee.components, []);
    assert.deepEqual(plan.fee.totals, []);
    assert.equal(plan.fee.manualCost!.contentHash, "h0");
  });

  test("409 NOT_PENDING_SCRAPED: approved, rejected, seeded, agent", () => {
    for (const over of [
      { reviewStatus: "approved" },
      { reviewStatus: "rejected" },
      { source: undefined },
      { source: "agent" },
    ]) {
      throwsCode(() => planManualCost(pendingVisa(TWD_FEE, over), input(), "a", NOW), "NOT_PENDING_SCRAPED", 409);
    }
  });

  test("409 FEE_ALREADY_CONVERTED when the scraper's cost is approvable", () => {
    const visa = pendingVisa(GBP_FEE);
    assert.equal(visa.baseCostUsd, 100);
    throwsCode(() => planManualCost(visa, input(), "a", NOW), "FEE_ALREADY_CONVERTED", 409);
  });

  test("409 STALE_VISA when expectedContentHash differs; matching hash is fine", () => {
    const visa = pendingVisa(TWD_FEE);
    throwsCode(() => planManualCost(visa, input({ expectedContentHash: "old" }), "a", NOW), "STALE_VISA", 409);
    assert.doesNotThrow(() => planManualCost(visa, input({ expectedContentHash: "h1" }), "a", NOW));
  });

  test("correcting an earlier manual cost: allowed, keeps the scraper's previous, records supersedes", () => {
    const visa = pendingVisa(TWD_FEE);
    const first = planManualCost(visa, input(), "admin-1", NOW);
    const after = { ...visa, baseCostUsd: first.baseCostUsd, scrapeMeta: { ...visa.scrapeMeta, fee: first.fee } };
    const later = Timestamp.fromMillis(NOW.toMillis() + 1000);
    const second = planManualCost(after, input({ amountUsd: 60, reason: "typo fix" }), "admin-2", later);
    assert.equal(second.baseCostUsd, 60);
    assert.deepEqual(second.fee.manualCost!.previous, { fxMissing: true });
    assert.deepEqual(second.fee.manualCost!.supersedes, {
      amountUsd: 51.6,
      reason: "CBC rate 1 TWD = 0.03225 USD",
      setBy: "admin-1",
      setAt: NOW,
      contentHash: "h1",
    });
  });
});

// ============================================
// planManualCostOverwrite (pure)
// ============================================

describe("planManualCostOverwrite", () => {
  const manualFee = (): VisaFeeMeta => planManualCost(pendingVisa(TWD_FEE), input(), "admin-1", NOW).fee;

  test("manual + new converted fee → replacedManualCost recorded, cost kept (not deleted)", () => {
    const { feeMeta, baseCostUsd } = computeFee(GBP_FEE, freshFx(), NOW);
    const plan = planManualCostOverwrite(manualFee(), feeMeta, baseCostUsd, "h2", NOW);
    assert.equal(plan.deleteCost, false);
    assert.equal(plan.replaced!.amountUsd, 51.6);
    assert.equal(plan.fee.replacedManualCost!.replacedByContentHash, "h2");
    assert.equal(plan.fee.manualCost, undefined);
    assert.equal(feeMeta.replacedManualCost, undefined); // input not mutated
  });

  test("manual + new flagged fee → deleteCost", () => {
    const { feeMeta, baseCostUsd } = computeFee(TWD_FEE, freshFx(), NOW);
    const plan = planManualCostOverwrite(manualFee(), feeMeta, baseCostUsd, "h2", NOW);
    assert.equal(plan.deleteCost, true);
    assert.equal(plan.fee.fxMissing, true);
  });

  test("no manual cost → nothing replaced; an older replacedManualCost is carried forward", () => {
    const { feeMeta } = computeFee(TWD_FEE, freshFx(), NOW);
    assert.deepEqual(planManualCostOverwrite(feeMeta, feeMeta, undefined, "h2", NOW), { fee: feeMeta, deleteCost: false });
    const old = planManualCostOverwrite(manualFee(), feeMeta, undefined, "h2", NOW).fee;
    const next = planManualCostOverwrite(old, feeMeta, undefined, "h3", NOW);
    assert.equal(next.replaced, undefined);
    assert.equal(next.fee.replacedManualCost!.replacedByContentHash, "h2");
  });
});

// ============================================
// Controller + service + ingest (in-memory Firestore)
// ============================================

/* eslint-disable @typescript-eslint/no-explicit-any */
let catalog: any;
let controller: any;
let visaSvc: any;
let authMw: any;

/** Ingest one extraction for the fixture visa. */
function ingest(e: ExtractedVisa, hash: string, fx: FxRatesDoc | undefined = freshFx()): Promise<any> {
  return catalog.ingestExtraction({
    countryCode: CC,
    sourceUrl: URL,
    routeName: "Visitor visa",
    contentHash: hash,
    extracted: e,
    model: "stub-model",
    visaId: VISA_ID,
    fx,
  });
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
function req(role: Role, body: unknown, id = VISA_ID): any {
  const authz = { uid: `${role}-uid`, role, agencyId: role === ROLES.OWNER || role === ROLES.AGENT ? "ag1" : null };
  return { params: { id }, query: {}, body, userId: authz.uid, authz, ability: defineAbilitiesFor(authz) };
}

/** PUT /admin/visas/:id/manual-cost as `role`. */
async function put(role: Role, body: unknown, id?: string) {
  const { res, out } = fakeRes();
  await controller.setManualCost(req(role, body, id), res);
  return out;
}

/** A valid request body. */
const BODY = { countryCode: "TW", amountUsd: 51.6, reason: "CBC rate 1 TWD = 0.03225 USD" };

/** Run `fn` capturing console.warn output. */
async function captureWarn<T>(fn: () => Promise<T>): Promise<{ result: T; warned: string[] }> {
  const warned: string[] = [];
  const orig = console.warn;
  console.warn = (...a: unknown[]) => void warned.push(a.map(String).join(" "));
  try {
    return { result: await fn(), warned };
  } finally {
    console.warn = orig;
  }
}

before(async () => {
  await installFakes();
  catalog = (await import("../src/services/visa-catalog.service")).visaCatalogService;
  controller = (await import("../src/controllers/visa.controller")).visaController;
  visaSvc = (await import("../src/services/visa.service")).visaService;
  authMw = await import("../src/middleware/auth");
});

beforeEach(async () => {
  resetStore();
  store.set(`countries/${CC}`, { code: CC, name: "Taiwan", visaTypesCount: 0, minCostUsd: 0, minProcessingDays: 0 });
});

describe("PUT /admin/visas/:id/manual-cost", () => {
  test("admin → 200, one update with baseCostUsd + scrapeMeta.fee; then approve succeeds", async () => {
    await ingest(extraction(), "h1"); // TWD → fxMissing, no cost
    assert.equal("baseCostUsd" in store.get(VISA_PATH)!, false);
    const mark = writes.length;

    const out = await put(ROLES.ADMIN, { ...BODY, expectedContentHash: "h1" });
    assert.equal(out.status, 200);
    assert.equal(out.body.success, true);
    assert.equal(out.body.data.id, VISA_ID);
    assert.equal(out.body.data.baseCostUsd, 52);

    const w = writes.slice(mark);
    assert.equal(w.length, 1);
    assert.equal(w[0].op, "update");
    assert.deepEqual(Object.keys(w[0].data).sort(), ["baseCostUsd", "scrapeMeta.fee", "updatedAt"]);

    const doc = store.get(VISA_PATH)! as any;
    assert.equal(doc.scrapeMeta.contentHash, "h1"); // rest of scrapeMeta untouched
    assert.equal(doc.scrapeMeta.fee.fxSource, "manual");
    assert.equal(doc.scrapeMeta.fee.manualCost.setBy, `${ROLES.ADMIN}-uid`);
    assert.equal(doc.reviewStatus, "pending_review"); // not approved by this call
    assert.equal(doc.isActive, false);

    const approved = await visaSvc.updateVisaReviewStatus(CC, VISA_ID, "approve", "admin-uid");
    assert.equal(approved.reviewStatus, "approved");
    assert.equal(approved.isActive, true);
    assert.equal(store.get(`countries/${CC}`)!.minCostUsd, 52);
  });

  test("owner / agent / client → 403 before validation, nothing written", async () => {
    await ingest(extraction(), "h1");
    const before = clone(store.get(VISA_PATH));
    const mark = writes.length;
    for (const role of [ROLES.OWNER, ROLES.AGENT, ROLES.CLIENT]) {
      const out = await put(role, {}); // invalid body: the gate must still win
      assert.equal(out.status, 403, role);
      assert.equal(out.body.error, "FORBIDDEN");
    }
    assert.equal(writes.length, mark);
    assert.deepEqual(store.get(VISA_PATH), before);
  });

  test("400 VALIDATION_ERROR for a bad body, nothing written", async () => {
    await ingest(extraction(), "h1");
    const mark = writes.length;
    for (const body of [{ ...BODY, amountUsd: 0 }, { ...BODY, reason: undefined }, { ...BODY, amountUsd: 1e9 }]) {
      const out = await put(ROLES.ADMIN, body);
      assert.equal(out.status, 400);
      assert.equal(out.body.error, "VALIDATION_ERROR");
    }
    assert.equal(writes.length, mark);
  });

  test("404 for an unknown or unaddressable id", async () => {
    for (const id of ["nope", "__bad__"]) {
      const out = await put(ROLES.ADMIN, BODY, id);
      assert.equal(out.status, 404);
      assert.equal(out.body.error, "NOT_FOUND");
    }
  });

  test("409 NOT_PENDING_SCRAPED on an approved visa; 409 FEE_ALREADY_CONVERTED on a converted one; 409 STALE_VISA", async () => {
    await ingest(extraction({ feeComponents: GBP_FEE }), "h1"); // converts
    let out = await put(ROLES.ADMIN, BODY);
    assert.equal(out.status, 409);
    assert.equal(out.body.error, "FEE_ALREADY_CONVERTED");

    store.set(VISA_PATH, { ...store.get(VISA_PATH)!, reviewStatus: "approved", isActive: true });
    out = await put(ROLES.ADMIN, BODY);
    assert.equal(out.status, 409);
    assert.equal(out.body.error, "NOT_PENDING_SCRAPED");

    resetStore();
    await ingest(extraction(), "h2");
    const mark = writes.length;
    out = await put(ROLES.ADMIN, { ...BODY, expectedContentHash: "h1" });
    assert.equal(out.status, 409);
    assert.equal(out.body.error, "STALE_VISA");
    assert.equal(writes.length, mark);
  });

  test("the write runs in a transaction: a throwing plan writes nothing", async () => {
    await ingest(extraction({ feeComponents: GBP_FEE }), "h1");
    const mark = writes.length;
    await assert.rejects(
      visaSvc.setManualCost(VISA_ID, input(), "admin-uid"),
      (e: unknown) => e instanceof ManualCostError && e.code === "FEE_ALREADY_CONVERTED"
    );
    assert.equal(writes.length, mark);
  });

  test("no token → 401 from verifyAuth (handler never reached)", async () => {
    const { res, out } = fakeRes();
    let nextCalled = false;
    await authMw.verifyAuth({ headers: {}, method: "PUT", originalUrl: "/admin/visas/x/manual-cost" }, res, () => {
      nextCalled = true;
    });
    assert.equal(out.status, 401);
    assert.equal(nextCalled, false);
  });

  // The endpoint edits the visa document itself, so it is gated on the `Visa`
  // subject (@durin-tech/authz 0.1.4), not `VisaChange` (a pending proposal).
  test("the gate is the CASL ability: only admin can update a Visa", () => {
    const can = (role: Role) =>
      defineAbilitiesFor({ uid: "u", role, agencyId: role === ROLES.ADMIN ? null : "ag1" }).can("update", "Visa");
    assert.equal(can(ROLES.ADMIN), true);
    for (const role of [ROLES.OWNER, ROLES.AGENT, ROLES.CLIENT]) assert.equal(can(role), false);
  });

  test("the handler checks `update Visa` (not `VisaChange`) on the visa id", async () => {
    // Swap the request's ability for a spy that records every check and
    // denies it, so the handler stops at the gate with a 403. The recorded
    // subject type is the one CASL's `subject()` tagged on the resource.
    const seen: Array<[string, unknown, unknown]> = [];
    const spy = {
      can(action: string, resource: any) {
        seen.push([action, resource?.__caslSubjectType__, resource?.id]);
        return false;
      },
    };
    const { res, out } = fakeRes();
    await controller.setManualCost({ ...req(ROLES.ADMIN, BODY), ability: spy }, res);
    assert.equal(out.status, 403);
    assert.deepEqual(seen, [["update", "Visa", VISA_ID]]);
  });
});

describe("a later scrape replaces a manual cost — never silently", () => {
  /** Ingest the TWD visa and set a manual cost on it. */
  async function seedManual(): Promise<void> {
    await ingest(extraction(), "h1");
    assert.equal((await put(ROLES.ADMIN, BODY)).status, 200);
  }

  test("changed content that converts → its cost replaces the manual one; overwrite recorded + logged", async () => {
    await seedManual();
    const { result, warned } = await captureWarn(() => ingest(extraction({ feeComponents: GBP_FEE }), "h2"));
    assert.equal(result.outcome, "updated");
    const doc = store.get(VISA_PATH)! as any;
    assert.equal(doc.baseCostUsd, 100); // 80 GBP / 0.8
    const fee = doc.scrapeMeta.fee;
    assert.equal(fee.fxSource, FX_SOURCE_ECB);
    assert.equal(fee.manualCost, undefined);
    assert.equal(fee.replacedManualCost.amountUsd, 51.6);
    assert.equal(fee.replacedManualCost.setBy, `${ROLES.ADMIN}-uid`);
    assert.equal(fee.replacedManualCost.replacedByContentHash, "h2");
    assert.ok(fee.replacedManualCost.replacedAt instanceof Timestamp);
    assert.equal(warned.length, 1);
    assert.match(warned[0], /Manual USD cost 51\.6 on TW\/tw-visitor-visa .* replaced .*new cost 100/);
  });

  test("changed content still flagged → manual cost deleted, approval blocked again", async () => {
    await seedManual();
    const { warned } = await captureWarn(() =>
      ingest(extraction({ processingDaysMax: 9 }), "h2") // same TWD fee, other content changed
    );
    const doc = store.get(VISA_PATH)! as any;
    assert.equal("baseCostUsd" in doc, false);
    assert.equal(doc.scrapeMeta.fee.fxMissing, true);
    assert.equal(doc.scrapeMeta.fee.replacedManualCost.amountUsd, 51.6);
    assert.equal(warned.length, 1);
    assert.match(warned[0], /cost removed/);
    await assert.rejects(visaSvc.updateVisaReviewStatus(CC, VISA_ID, "approve", "admin-uid"), VisaFeeNotConvertibleError);
    // ...and the admin can set a cost again on the new extraction.
    const out = await put(ROLES.ADMIN, { ...BODY, expectedContentHash: "h2" });
    assert.equal(out.status, 200);
    assert.equal(out.body.data.scrapeMeta.fee.manualCost.contentHash, "h2");
  });

  test("same content hash → unchanged, manual cost kept", async () => {
    await seedManual();
    const before = clone(store.get(VISA_PATH));
    const { result, warned } = await captureWarn(() => ingest(extraction(), "h1"));
    assert.equal(result.outcome, "unchanged");
    assert.deepEqual(store.get(VISA_PATH), before);
    assert.equal(warned.length, 0);
  });

  test("FX re-convert after an overwrite keeps the replacedManualCost entry; a manual fee is never re-converted", async () => {
    await seedManual();
    // A manual fee has no flags → the re-convert pass leaves it alone.
    store.set("visaSources/TW", { countryCode: CC, status: "active", pages: [] });
    const manualBefore = clone(store.get(VISA_PATH));
    await catalog.reconvertFlaggedFees({ ...freshFx(), rates: { GBP: 0.8, TWD: 31 } });
    assert.deepEqual(store.get(VISA_PATH), manualBefore);

    // Overwrite with a flagged extraction, then a TWD rate appears.
    await captureWarn(() => ingest(extraction({ processingDaysMax: 9 }), "h2"));
    const r = await catalog.reconvertFlaggedFees({ ...freshFx(), rates: { GBP: 0.8, TWD: 32 } });
    assert.equal(r.reconverted, 1);
    const doc = store.get(VISA_PATH)! as any;
    assert.equal(doc.baseCostUsd, 50); // 1600 / 32
    assert.equal(doc.scrapeMeta.fee.replacedManualCost.amountUsd, 51.6);
  });
});
