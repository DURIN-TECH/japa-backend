// ============================================
// Unit tests — manual USD cost on a proposed visa edit (issue #77)
// ============================================
//
// Run with `npm test`. NO network and NO emulator: every collection ref and
// the transaction runner are the in-memory fake (helpers/fake-firestore.ts);
// the project id and no-network guard come from test/helpers/setup.ts.
//
// Covers:
//  - parseProposalManualCostInput: the #70 rules (shared) + required
//    expectedRevision
//  - visaChangeService.setManualCost: happy path (row only, live visa never
//    written, audit block, approvable), then approve applies
//    baseCostUsd = round(amountUsd) and the manual fee to the live visa;
//    409 FEE_ALREADY_CONVERTED / ALREADY_RESOLVED / REVISION_MISMATCH /
//    STALE_PROPOSAL, 400 rates mismatch, 404 — each writes nothing;
//    correcting an earlier manual cost (supersedes)
//  - re-proposal: changed text replaces the manual cost and records
//    `replacedManualCost`; the same text keeps it
//  - controller: status codes, 403 for non-admins before any read, CASL
//    `update VisaChange`

import { test, describe, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Timestamp } from "firebase-admin/firestore";
import { ROLES, defineAbilitiesFor } from "@durin-tech/authz";
import type { Role } from "@durin-tech/authz";

import type { ExtractedFeeComponent, ExtractedVisa, FxRatesDoc } from "../../../../src/scrapers/visa-catalog/types";
import { FX_SOURCE_ECB, FX_SOURCE_MANUAL } from "../../../../src/scrapers/visa-catalog/visa-catalog-fx";
import { Data, clone, installFakes, resetStore, store, writes } from "../../../helpers/fake-firestore";

/* eslint-disable @typescript-eslint/no-explicit-any */

// ============================================
// Fixtures
// ============================================

const CC = "GB";
const VISA_ID = "gb-skilled-worker";
const VISA_PATH = `countries/${CC}/visaTypes/${VISA_ID}`;
const URL = "https://www.gov.uk/skilled-worker-visa";

/** Fresh FX with GBP only: a TWD fee has no rate → fxMissing (blocked). */
const freshFx = (): FxRatesDoc => ({
  base: "USD",
  rates: { GBP: 0.8 },
  fetchedAt: Timestamp.now(),
  rateDate: new Date(Date.now() - 86_400_000).toISOString().slice(0, 10),
  source: FX_SOURCE_ECB,
});

const GBP_FEE: ExtractedFeeComponent[] = [
  { kind: "application", label: "Application fee", amount: 800, currency: "GBP", per: "application" },
];
/** A fee the scraper can't convert (no TWD rate). */
const TWD_FEE: ExtractedFeeComponent[] = [
  { kind: "application", label: "Application fee", amount: 3000, currency: "TWD", per: "application" },
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
    feeComponents: GBP_FEE,
    validityPeriod: "5 years",
    isExtendable: true,
    eligibilityCriteria: ["Job offer"],
    confidence: 0.9,
    citations: { processingDaysMax: "within 3 weeks" },
    ...over,
  } as ExtractedVisa;
}

let catalog: any;
let changes: any;
let controller: any;
let parse: any;

/** Ingest one extraction for the fixture visa. */
function ingest(e: ExtractedVisa, hash: string) {
  return catalog.ingestExtraction({
    countryCode: CC,
    sourceUrl: URL,
    routeName: "Skilled Worker visa",
    contentHash: hash,
    extracted: e,
    model: "stub-model",
    visaId: VISA_ID,
    fx: freshFx(),
  });
}

/** Approved live visa (GBP fee, converted) + a proposal changing its fee to TWD (blocked). */
async function blockedProposal(): Promise<string> {
  await ingest(extraction(), "h1");
  store.set(VISA_PATH, { ...store.get(VISA_PATH)!, reviewStatus: "approved", isActive: true });
  store.set(`countries/${CC}`, { code: CC, name: "United Kingdom", visaTypesCount: 1, minCostUsd: 1000 });
  await ingest(extraction({ feeComponents: TWD_FEE }), "h2");
  return onlyRow()[0];
}

/** The single pendingVisaChanges row (asserts exactly one). */
function onlyRow(): [string, Data] {
  const r = [...store.entries()].filter(([p]) => p.startsWith("pendingVisaChanges/"));
  assert.equal(r.length, 1);
  return [r[0][0].split("/")[1], r[0][1]];
}

/** A valid body for the fixture proposal. */
function body(over: Data = {}): Data {
  return {
    amountUsd: 93.6,
    reason: "CBC rate 1 TWD = 0.0312 USD on 2026-11-10",
    rates: [{ currency: "TWD", usdPerUnit: 0.0312 }],
    expectedRevision: 1,
    ...over,
  };
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

before(async () => {
  await installFakes();
  catalog = (await import("../../../../src/scrapers/visa-catalog/visa-catalog.service")).visaCatalogService;
  changes = (await import("../../../../src/scrapers/visa-catalog/changes/visa-catalog-changes.service")).visaChangeService;
  controller = (await import("../../../../src/scrapers/visa-catalog/changes/visa-change.controller")).visaChangeController;
  parse = (await import("../../../../src/scrapers/visa-catalog/changes/visa-change-manual-cost")).parseProposalManualCostInput;
});

beforeEach(() => resetStore());

// ============================================
// Input validation
// ============================================

describe("parseProposalManualCostInput", () => {
  test("valid body → trimmed reason, upper-cased currencies, expectedRevision", () => {
    const input = parse(body({ reason: "  CBC rate 0.0312 today  ", rates: [{ currency: "twd", usdPerUnit: 0.0312 }] }));
    assert.equal(input.reason, "CBC rate 0.0312 today");
    assert.deepEqual(input.rates, [{ currency: "TWD", usdPerUnit: 0.0312 }]);
    assert.equal(input.expectedRevision, 1);
  });

  for (const [label, over] of [
    ["expectedRevision missing", { expectedRevision: undefined }],
    ["expectedRevision 0", { expectedRevision: 0 }],
    ["expectedRevision as string", { expectedRevision: "1" }],
    ["amountUsd as string (shared #70 rule)", { amountUsd: "93" }],
    ["amountUsd over the cap", { amountUsd: 100_001 }],
    ["short reason", { reason: "too short" }],
    ["legacy rate field", { rate: 0.03 }],
    ["USD rate", { rates: [{ currency: "USD", usdPerUnit: 1 }] }],
  ] as [string, Data][]) {
    test(`400 VALIDATION_ERROR: ${label}`, () => {
      assert.throws(() => parse(body(over)), { code: "VALIDATION_ERROR", httpStatus: 400 });
    });
  }

  test("non-object body → 400", () => {
    for (const b of [null, [], "x"]) assert.throws(() => parse(b), { code: "VALIDATION_ERROR" });
  });
});

// ============================================
// Service
// ============================================

describe("visaChangeService.setManualCost", () => {
  test("blocked proposal: writes the ROW only; proposed fee carries the manual cost; approvable", async () => {
    const id = await blockedProposal();
    const before = onlyRow()[1];
    assert.equal(before.approvable, false);
    const liveBefore = clone(store.get(VISA_PATH));
    const mark = writes.length;

    const row = await changes.setManualCost(id, parse(body()), "admin-1");

    // ---- Only the row was written; the live visa is untouched ----
    assert.deepEqual(writes.slice(mark).map((w) => w.path), [`pendingVisaChanges/${id}`]);
    assert.deepEqual(store.get(VISA_PATH), liveBefore);

    // ---- Proposed fee: manual, same audit shape as #70 ----
    const fee = row.proposedScrapeMeta.fee;
    assert.equal(fee.fxSource, FX_SOURCE_MANUAL);
    assert.equal(fee.totalUsd, 93.6);
    assert.equal(fee.fxMissing, undefined);
    assert.deepEqual(fee.components, (before.proposedScrapeMeta as any).fee.components);
    assert.equal(fee.manualCost.amountUsd, 93.6);
    assert.equal(fee.manualCost.setBy, "admin-1");
    assert.ok(fee.manualCost.setAt instanceof Timestamp);
    assert.equal(fee.manualCost.contentHash, "h2");
    assert.deepEqual(fee.manualCost.rates, [{ currency: "TWD", usdPerUnit: 0.0312 }]);
    assert.equal(fee.manualCost.previous.fxMissing, true);

    // ---- Cost on the diff + proposed; block cleared; revision bumped ----
    assert.equal(row.proposed.baseCostUsd, 94);
    assert.equal(row.diff.find((d: any) => d.field === "fee").baseCostUsdAfter, 94);
    assert.equal(row.approvable, true);
    assert.equal(row.blockReason, undefined);
    assert.equal(row.revision, 2);
    assert.equal(row.status, "open");
    // The returned row is exactly what was committed.
    assert.deepEqual(row, { ...store.get(`pendingVisaChanges/${id}`), id });
  });

  test("the existing approve path then applies baseCostUsd = round(amountUsd) + the manual fee to the live visa", async () => {
    const id = await blockedProposal();
    await changes.setManualCost(id, parse(body()), "admin-1");
    const visa = await changes.approveChange(id, "admin-2", 2);
    assert.equal(visa.baseCostUsd, 94);
    const live = store.get(VISA_PATH)! as any;
    assert.equal(live.baseCostUsd, 94);
    assert.equal(live.scrapeMeta.fee.fxSource, FX_SOURCE_MANUAL);
    assert.equal(live.scrapeMeta.fee.manualCost.setBy, "admin-1");
    assert.equal(live.reviewedBy, "admin-2");
    assert.equal(store.get(`pendingVisaChanges/${id}`)!.status, "approved");
  });

  test("revision: two admins set costs → the first admin's approve with the revision they saw is refused", async () => {
    const id = await blockedProposal();
    // Admin A sets a cost on revision 1 → revision 2 (A's screen now shows 2).
    const a = await changes.setManualCost(id, parse(body()), "admin-a");
    assert.equal(a.revision, 2);
    // Admin B, also on revision 2, changes the cost → revision 3.
    const b = await changes.setManualCost(id, parse(body({ amountUsd: 120, reason: "Embassy rate is higher", expectedRevision: 2 })), "admin-b");
    assert.equal(b.revision, 3);
    // A approves with the revision they saw: refused, nothing written.
    const mark = writes.length;
    await assert.rejects(changes.approveChange(id, "admin-a", 2), { code: "REVISION_MISMATCH", httpStatus: 409 });
    assert.equal(writes.length, mark);
    assert.equal(store.get(`pendingVisaChanges/${id}`)!.status, "open");
    // Also refused: setting a cost on the old revision.
    await assert.rejects(changes.setManualCost(id, parse(body()), "admin-a"), { code: "REVISION_MISMATCH" });
    // With the current revision, B's cost is applied.
    const visa = await changes.approveChange(id, "admin-a", 3);
    assert.equal(visa.baseCostUsd, 120);
  });

  test("eligibility-only block → 409 FEE_ALREADY_CONVERTED; nothing written", async () => {
    await ingest(extraction(), "h1");
    store.set(VISA_PATH, { ...store.get(VISA_PATH)!, reviewStatus: "approved", isActive: true });
    await ingest(extraction({ eligibilityCriteria: [], feeComponents: [{ ...GBP_FEE[0], amount: 900 }] }), "h2");
    const [id, row] = onlyRow();
    assert.equal(row.approvable, false);
    assert.match(row.blockReason as string, /eligibility/);
    const mark = writes.length;
    await assert.rejects(changes.setManualCost(id, parse(body({ rates: [{ currency: "GBP", usdPerUnit: 1.25 }] })), "a"), {
      code: "FEE_ALREADY_CONVERTED",
      httpStatus: 409,
    });
    assert.equal(writes.length, mark);
  });

  test("fee + eligibility block → cost is set, but approve is still refused ELIGIBILITY_REMOVED", async () => {
    await ingest(extraction(), "h1");
    store.set(VISA_PATH, { ...store.get(VISA_PATH)!, reviewStatus: "approved", isActive: true });
    await ingest(extraction({ eligibilityCriteria: [], feeComponents: TWD_FEE }), "h2");
    const [id] = onlyRow();
    const row = await changes.setManualCost(id, parse(body()), "admin-1");
    assert.equal(row.proposedScrapeMeta.fee.fxSource, FX_SOURCE_MANUAL);
    assert.equal(row.approvable, false);
    assert.match(row.blockReason, /eligibility/);
    assert.match(store.get(`pendingVisaChanges/${id}`)!.blockReason as string, /eligibility/);
    const liveBefore = clone(store.get(VISA_PATH));
    await assert.rejects(changes.approveChange(id, "admin-1", row.revision), { code: "ELIGIBILITY_REMOVED", httpStatus: 409 });
    assert.deepEqual(store.get(VISA_PATH), liveBefore);
  });

  test("409 FEE_ALREADY_CONVERTED on a proposal whose fee converts; nothing written", async () => {
    await ingest(extraction(), "h1");
    store.set(VISA_PATH, { ...store.get(VISA_PATH)!, reviewStatus: "approved", isActive: true });
    await ingest(extraction({ feeComponents: [{ ...GBP_FEE[0], amount: 900 }] }), "h2");
    const [id] = onlyRow();
    const mark = writes.length;
    await assert.rejects(changes.setManualCost(id, parse(body({ rates: [{ currency: "GBP", usdPerUnit: 1.25 }] })), "a"), {
      code: "FEE_ALREADY_CONVERTED",
      httpStatus: 409,
    });
    assert.equal(writes.length, mark);
  });

  test("400 when the rates don't match the proposed fee's currencies; nothing written", async () => {
    const id = await blockedProposal();
    const mark = writes.length;
    for (const rates of [[], [{ currency: "GBP", usdPerUnit: 1.2 }]]) {
      await assert.rejects(changes.setManualCost(id, parse(body({ rates })), "a"), { code: "VALIDATION_ERROR" });
    }
    assert.equal(writes.length, mark);
  });

  test("409 REVISION_MISMATCH / STALE_PROPOSAL / ALREADY_RESOLVED and 404 — nothing written", async () => {
    const id = await blockedProposal();
    const mark = writes.length;
    await assert.rejects(changes.setManualCost(id, parse(body({ expectedRevision: 2 })), "a"), {
      code: "REVISION_MISMATCH",
      httpStatus: 409,
    });
    await assert.rejects(changes.setManualCost("nope", parse(body()), "a"), { code: "NOT_FOUND", httpStatus: 404 });
    await assert.rejects(changes.setManualCost("__x__", parse(body()), "a"), { code: "NOT_FOUND", httpStatus: 404 });
    // Live visa withdrawn → stale
    const live = store.get(VISA_PATH)!;
    store.set(VISA_PATH, { ...live, staleSince: Timestamp.now() });
    await assert.rejects(changes.setManualCost(id, parse(body()), "a"), { code: "STALE_PROPOSAL", httpStatus: 409 });
    store.set(VISA_PATH, live);
    assert.equal(writes.length, mark);
    // Resolved row
    await changes.rejectChange(id, "a", "wrong");
    const mark2 = writes.length;
    await assert.rejects(changes.setManualCost(id, parse(body()), "a"), { code: "ALREADY_RESOLVED", httpStatus: 409 });
    assert.equal(writes.length, mark2);
  });

  test("a second manual cost corrects the first (supersedes, original previous kept)", async () => {
    const id = await blockedProposal();
    await changes.setManualCost(id, parse(body()), "admin-1");
    const row = await changes.setManualCost(
      id,
      parse(body({ amountUsd: 100, reason: "Corrected: CBC 0.0333 rate", expectedRevision: 2 })),
      "admin-2"
    );
    assert.equal(row.revision, 3);
    const m = row.proposedScrapeMeta.fee.manualCost;
    assert.equal(m.amountUsd, 100);
    assert.equal(m.supersedes.amountUsd, 93.6);
    assert.equal(m.supersedes.setBy, "admin-1");
    assert.equal(m.previous.fxMissing, true);
    assert.equal(row.proposed.baseCostUsd, 100);
  });
});

// ============================================
// Re-proposal overwrite
// ============================================

describe("re-proposal after a manual cost", () => {
  test("changed page text replaces the row; the manual cost is recorded as replacedManualCost (row level)", async () => {
    const id = await blockedProposal();
    await changes.setManualCost(id, parse(body()), "admin-1");
    await ingest(extraction({ feeComponents: [{ ...TWD_FEE[0], amount: 3500 }] }), "h3");
    const [id2, row] = onlyRow();
    assert.equal(id2, id);
    assert.equal(row.revision, 3); // 1 crawl, 2 manual cost, 3 crawl
    assert.equal(row.approvable, false);
    const fee = (row.proposedScrapeMeta as any).fee;
    assert.equal(fee.manualCost, undefined);
    assert.equal(fee.fxMissing, true);
    const replaced = row.replacedManualCost as any;
    assert.equal(replaced.amountUsd, 93.6);
    assert.equal(replaced.setBy, "admin-1");
    assert.equal(replaced.replacedByContentHash, "h3");
    assert.ok(replaced.replacedAt instanceof Timestamp);

    // A further replacement without a new manual cost carries the record forward.
    await ingest(extraction({ feeComponents: [{ ...TWD_FEE[0], amount: 3600 }] }), "h4");
    assert.equal((onlyRow()[1].replacedManualCost as any).replacedByContentHash, "h3");
  });

  test("the same page text keeps the manual cost (no write)", async () => {
    const id = await blockedProposal();
    await changes.setManualCost(id, parse(body()), "admin-1");
    const mark = writes.length;
    await ingest(extraction({ feeComponents: TWD_FEE }), "h2");
    assert.equal(writes.filter((w, i) => i >= mark && w.path.startsWith("pendingVisaChanges/")).length, 0);
    assert.equal((onlyRow()[1].proposedScrapeMeta as any).fee.manualCost.amountUsd, 93.6);
  });
});

// ============================================
// Controller
// ============================================

describe("visaChangeController.setManualCost", () => {
  /** Call the handler and return the captured response. */
  async function call(r: any) {
    const { res, out } = fakeRes();
    await controller.setManualCost(r, res);
    return out;
  }

  test("200 with the row; 400 on a bad body; 409 REVISION_MISMATCH; 404", async () => {
    const id = await blockedProposal();
    let out = await call(req(ROLES.ADMIN, { params: { id }, body: body({ expectedRevision: undefined }) }));
    assert.equal(out.status, 400);
    assert.equal(out.body.error, "VALIDATION_ERROR");
    out = await call(req(ROLES.ADMIN, { params: { id }, body: body({ expectedRevision: 3 }) }));
    assert.equal(out.status, 409);
    assert.equal(out.body.error, "REVISION_MISMATCH");
    out = await call(req(ROLES.ADMIN, { params: { id: "missing" }, body: body() }));
    assert.equal(out.status, 404);
    out = await call(req(ROLES.ADMIN, { params: { id }, body: body() }));
    assert.equal(out.status, 200);
    assert.equal(out.body.data.approvable, true);
    assert.equal(out.body.data.proposedScrapeMeta.fee.manualCost.setBy, `${ROLES.ADMIN}-uid`);
  });

  test("409 FEE_ALREADY_CONVERTED is passed through with its code", async () => {
    await ingest(extraction(), "h1");
    store.set(VISA_PATH, { ...store.get(VISA_PATH)!, reviewStatus: "approved", isActive: true });
    await ingest(extraction({ processingDaysMax: 30 }), "h2");
    const out = await call(req(ROLES.ADMIN, { params: { id: onlyRow()[0] }, body: body({ rates: [] }) }));
    assert.equal(out.status, 409);
    assert.equal(out.body.error, "FEE_ALREADY_CONVERTED");
  });

  test("owner / agent / client → 403 before any read or validation", async () => {
    store.set("pendingVisaChanges/c1", { status: "open", countryCode: CC, visaId: VISA_ID });
    const mark = writes.length;
    for (const role of [ROLES.OWNER, ROLES.AGENT, ROLES.CLIENT]) {
      const out = await call(req(role, { params: { id: "c1" }, body: {} }));
      assert.equal(out.status, 403, role);
      assert.equal(out.body.error, "FORBIDDEN");
    }
    assert.equal(writes.length, mark);
  });

  test("gate is CASL `update VisaChange`: admin has it, other roles don't", () => {
    for (const role of [ROLES.ADMIN, ROLES.OWNER, ROLES.AGENT, ROLES.CLIENT]) {
      const ability = defineAbilitiesFor({ uid: "u", role, agencyId: null });
      assert.equal(ability.can("update", "VisaChange"), role === ROLES.ADMIN, role);
    }
  });
});
