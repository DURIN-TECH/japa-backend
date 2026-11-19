// ============================================
// Unit tests — visa ownership fields + public visibility (issue #99)
// ============================================
//
// Run with `npm test`. Hermetic: NO network and NO emulator. The Firestore
// refs in utils/firebase are swapped for the in-memory fake
// (test/helpers/fake-firestore.ts), and the controller handlers are called
// directly with a minimal req / res, so every public endpoint is exercised
// end to end from the handler down to the (fake) Firestore reads.
//
// Covers:
//  - isVisaPubliclyVisible for every combination in the issue, plus
//    `visibility` / `reviewStatus` missing and null;
//  - the seven-doc matrix (seed, scraped approved, scraped pending, agent
//    pending with isActive:true = the old bug, agency approved agency-only,
//    agency approved global, inactive) through every public read:
//    GET /countries/:code/visas (with and without ?category), GET /visas
//    (incl. pagination total), /visas/search, /visas/popular, the single-visa
//    reads (404 for hidden ones), and updateCountryStats;
//  - admin reads still see every visa (/admin/visas, /full with an admin
//    ability) and the internal visaService.getVisaType stays unfiltered;
//  - createVisaType writes isActive:false + visibility "agency" +
//    pending_review, and the doc is absent from /countries/:code/visas;
//    approval activates it without changing visibility;
//  - the backfill: pure planner, dry run (no writes), real run, second run
//    is a no-op, CLI flag parsing (dry run by default).

import { test, describe, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Timestamp } from "firebase-admin/firestore";
import { defineAbilitiesFor, ROLES } from "@durin-tech/authz";

import { fakeCollection, installFakes, resetStore, store, writes } from "../helpers/fake-firestore";
import type { Data } from "../helpers/fake-firestore";
import { isVisaPubliclyVisible, visaService } from "../../src/services/visa.service";
import { visaController } from "../../src/controllers/visa.controller";
import {
  backfillVisaOwnership,
  parseBackfillArgs,
  planVisaOwnershipBackfill,
} from "../../src/scripts/backfill-visa-ownership";
import type { VisaType } from "../../src/types";

/* eslint-disable @typescript-eslint/no-explicit-any */

// ============================================
// Fixtures
// ============================================

/** Country used by every visa in the matrix. */
const CC = "GB";
/** Fixed timestamp for seeded docs. */
const T0 = Timestamp.fromMillis(1_700_000_000_000);

/** A complete visa doc; `over` sets the fields the case is about. */
function visaDoc(id: string, over: Data): Data {
  return {
    id,
    countryCode: CC,
    name: `Visa ${id}`,
    code: id.toUpperCase(),
    description: "test visa",
    category: "work",
    processingTime: "3 weeks",
    processingDaysMin: 15,
    processingDaysMax: 21,
    baseCostUsd: 100,
    validityPeriod: "2 years",
    isExtendable: false,
    eligibilityCriteria: [],
    agentIds: [],
    createdAt: T0,
    updatedAt: T0,
    ...over,
  };
}

/**
 * The matrix from the acceptance criteria. Each doc has a distinct cost /
 * processing time so the country stats show exactly which docs were counted.
 */
const MATRIX: Record<string, Data> = {
  // Visible: seed (no source / reviewStatus / visibility).
  seed: { isActive: true, baseCostUsd: 300, processingDaysMin: 30 },
  // Visible: approved scraped visa.
  scrapedApproved: { isActive: true, source: "scraped", reviewStatus: "approved", baseCostUsd: 200, processingDaysMin: 20 },
  // Hidden: pending scraped visa (inactive, as the crawl writes it).
  scrapedPending: { isActive: false, source: "scraped", reviewStatus: "pending_review", baseCostUsd: 1 },
  // Hidden: the pre-#99 bug — pending agent visa written isActive:true.
  agentPending: { isActive: true, source: "agent", reviewStatus: "pending_review", baseCostUsd: 2, processingDaysMin: 1 },
  // Hidden: approved agency visa, still agency-only.
  agencyOnly: {
    isActive: true,
    source: "agency",
    reviewStatus: "approved",
    visibility: "agency",
    ownerAgencyId: "agency-1",
    createdBy: "uid-owner",
    baseCostUsd: 3,
    processingDaysMin: 2,
  },
  // Visible: approved agency visa made global.
  agencyGlobal: {
    isActive: true,
    source: "agency",
    reviewStatus: "approved",
    visibility: "global",
    ownerAgencyId: "agency-1",
    createdBy: "uid-owner",
    sponsor: { organisationName: "Acme Ltd", sponsorLicenceNumber: "ABC123" },
    baseCostUsd: 150,
    processingDaysMin: 10,
  },
  // Hidden: inactive seed-like doc.
  inactive: { isActive: false, baseCostUsd: 4, processingDaysMin: 3 },
};

/** Ids that every public read must return, in id order. */
const VISIBLE = ["agencyGlobal", "scrapedApproved", "seed"];

/** Seed the country + the matrix into the fake store. */
function seedMatrix(): void {
  store.set(`countries/${CC}`, {
    code: CC,
    name: "United Kingdom",
    isSupported: true,
    popularityRank: 1,
    visaTypesCount: 0,
    minProcessingDays: 0,
    minCostUsd: 0,
    createdAt: T0,
    updatedAt: T0,
  });
  for (const [id, over] of Object.entries(MATRIX)) {
    store.set(`countries/${CC}/visaTypes/${id}`, visaDoc(id, over));
  }
}

// ============================================
// Minimal Express req / res
// ============================================

/** Captured response of one handler call. */
interface Captured {
  status: number;
  body: any;
}

/** Call a controller handler with params / query / ability; return status + body. */
async function call(
  handler: (req: any, res: any) => Promise<void>,
  req: { params?: Data; query?: Data; body?: Data; ability?: unknown; userId?: string }
): Promise<Captured> {
  const out: Captured = { status: 0, body: undefined };
  const res = {
    status(code: number) {
      out.status = code;
      return res;
    },
    json(body: unknown) {
      out.body = body;
      return res;
    },
  };
  await handler({ params: {}, query: {}, body: {}, headers: {}, ...req }, res);
  return out;
}

/** Sorted ids of a list of visas. */
const ids = (visas: { id: string }[]) => visas.map((v) => v.id).sort();

/** CASL ability of an admin / a client (the shared authz package). */
const adminAbility = () => defineAbilitiesFor({ uid: "uid-admin", role: ROLES.ADMIN, agencyId: null });
const clientAbility = () => defineAbilitiesFor({ uid: "uid-client", role: ROLES.CLIENT, agencyId: null });

// ============================================
// Setup
// ============================================

before(async () => {
  await installFakes();
  // Requirements subcollection (read by /full); not in installFakes.
  const firebase: any = await import("../../src/utils/firebase");
  firebase.subcollections.requirements = (cc: string, visaId: string) =>
    fakeCollection(`countries/${cc}/visaTypes/${visaId}/requirements`);
});

beforeEach(() => {
  resetStore();
  seedMatrix();
});

// ============================================
// The visibility helper
// ============================================

describe("isVisaPubliclyVisible", () => {
  /** Run the helper on one matrix entry. */
  const visible = (key: string) => isVisaPubliclyVisible(MATRIX[key] as unknown as VisaType);

  test("seed visa (no source / reviewStatus / visibility) is visible", () => {
    assert.equal(visible("seed"), true);
  });
  test("approved scraped visa is visible", () => {
    assert.equal(visible("scrapedApproved"), true);
  });
  test("approved agency visa made global is visible", () => {
    assert.equal(visible("agencyGlobal"), true);
  });
  test("pending scraped visa is hidden", () => {
    assert.equal(visible("scrapedPending"), false);
  });
  test("pending agent visa with isActive:true (the old bug) is hidden", () => {
    assert.equal(visible("agentPending"), false);
  });
  test("approved agency-only visa is hidden", () => {
    assert.equal(visible("agencyOnly"), false);
  });
  test("inactive visa is hidden", () => {
    assert.equal(visible("inactive"), false);
  });
  test("rejected visa is hidden even when active", () => {
    assert.equal(isVisaPubliclyVisible({ isActive: true, reviewStatus: "rejected" }), false);
  });
  test("visibility missing or null counts as global", () => {
    assert.equal(isVisaPubliclyVisible({ isActive: true, reviewStatus: "approved" }), true);
    assert.equal(isVisaPubliclyVisible({ isActive: true, reviewStatus: "approved", visibility: null as any }), true);
  });
  test("reviewStatus null counts as missing (seed)", () => {
    assert.equal(isVisaPubliclyVisible({ isActive: true, reviewStatus: null as any }), true);
  });
  test("isActive must be strictly true", () => {
    assert.equal(isVisaPubliclyVisible({ isActive: undefined as any }), false);
    assert.equal(isVisaPubliclyVisible({ isActive: "true" as any }), false);
  });
});

// ============================================
// Public reads over the matrix
// ============================================

describe("public visa reads return only visible visas", () => {
  test("GET /countries/:code/visas", async () => {
    const r = await call(visaController.getVisaTypes.bind(visaController), { params: { code: CC } });
    assert.equal(r.status, 200);
    assert.deepEqual(ids(r.body.data), VISIBLE);
  });

  test("GET /countries/:code/visas?category=work", async () => {
    const r = await call(visaController.getVisaTypes.bind(visaController), {
      params: { code: CC },
      query: { category: "work" },
    });
    assert.equal(r.status, 200);
    assert.deepEqual(ids(r.body.data), VISIBLE);
  });

  test("GET /visas: list and pagination total count visible visas only", async () => {
    const r = await call(visaController.getAllVisaTypes.bind(visaController), { query: {} });
    assert.equal(r.status, 200);
    assert.deepEqual(ids(r.body.data.visaTypes), VISIBLE);
    assert.equal(r.body.data.total, VISIBLE.length);

    // A page smaller than the result keeps the visible-only total.
    const page = await call(visaController.getAllVisaTypes.bind(visaController), { query: { limit: "1" } });
    assert.equal(page.body.data.visaTypes.length, 1);
    assert.equal(page.body.data.total, VISIBLE.length);

    // Category filter path of /visas too.
    const cat = await call(visaController.getAllVisaTypes.bind(visaController), { query: { category: "work" } });
    assert.deepEqual(ids(cat.body.data.visaTypes), VISIBLE);
    assert.equal(cat.body.data.total, VISIBLE.length);
  });

  test("GET /visas/search", async () => {
    // "visa" matches every name ("Visa <id>").
    const r = await call(visaController.searchVisaTypes.bind(visaController), { query: { q: "visa" } });
    assert.equal(r.status, 200);
    assert.deepEqual(ids(r.body.data), VISIBLE);
    // A query naming a hidden visa finds nothing.
    const hidden = await call(visaController.searchVisaTypes.bind(visaController), { query: { q: "agentpending" } });
    assert.deepEqual(hidden.body.data, []);
  });

  test("GET /visas/popular", async () => {
    const r = await call(visaController.getPopularVisaTypes.bind(visaController), { query: { limit: "50" } });
    assert.equal(r.status, 200);
    assert.deepEqual(ids(r.body.data), VISIBLE);
  });

  test("GET /countries/:code/visas/:visaId: 200 for visible, 404 for hidden", async () => {
    for (const id of Object.keys(MATRIX)) {
      const r = await call(visaController.getVisaType.bind(visaController), { params: { code: CC, visaId: id } });
      assert.equal(r.status, VISIBLE.includes(id) ? 200 : 404, id);
      if (r.status === 404) assert.equal(r.body.error, "NOT_FOUND");
    }
  });

  test("GET /countries/:code/visas/:visaId/full: 200 for visible, 404 for hidden (anonymous and client)", async () => {
    for (const ability of [undefined, clientAbility()]) {
      for (const id of Object.keys(MATRIX)) {
        const r = await call(visaController.getVisaTypeWithRequirements.bind(visaController), {
          params: { code: CC, visaId: id },
          ability,
        });
        assert.equal(r.status, VISIBLE.includes(id) ? 200 : 404, id);
      }
    }
  });

  test("updateCountryStats counts visible visas only", async () => {
    await visaService.updateCountryStats(CC);
    const country = store.get(`countries/${CC}`)!;
    assert.equal(country.visaTypesCount, VISIBLE.length);
    // Cheapest / fastest visible: agencyGlobal (150 USD, 10 days). The hidden
    // docs are all cheaper and faster, so any leak would change these.
    assert.equal(country.minCostUsd, 150);
    assert.equal(country.minProcessingDays, 10);
  });
});

// ============================================
// Admin + internal reads stay unfiltered
// ============================================

describe("admin and internal reads still see every visa", () => {
  test("GET /admin/visas lists all seven docs", async () => {
    // Issue #101: the list is CASL-gated (review rights), so the call
    // carries an admin ability, as verifyAuth would attach.
    const r = await call(visaController.getAdminVisas.bind(visaController), { ability: adminAbility() });
    assert.equal(r.status, 200);
    assert.deepEqual(ids(r.body.data), Object.keys(MATRIX).sort());
  });

  test("/full and the single-visa read serve a hidden visa to an admin", async () => {
    for (const id of ["agentPending", "agencyOnly", "inactive", "scrapedPending"]) {
      const full = await call(visaController.getVisaTypeWithRequirements.bind(visaController), {
        params: { code: CC, visaId: id },
        ability: adminAbility(),
      });
      assert.equal(full.status, 200, id);
      assert.equal(full.body.data.visaType.id, id);
      assert.deepEqual(full.body.data.requirements, []);
      const one = await call(visaController.getVisaType.bind(visaController), {
        params: { code: CC, visaId: id },
        ability: adminAbility(),
      });
      assert.equal(one.status, 200, id);
    }
  });

  test("visaService.getVisaType (case creation) stays unfiltered; getPublicVisaType filters", async () => {
    assert.equal((await visaService.getVisaType(CC, "agencyOnly"))?.id, "agencyOnly");
    assert.equal(await visaService.getPublicVisaType(CC, "agencyOnly"), null);
    assert.equal((await visaService.getPublicVisaType(CC, "seed"))?.id, "seed");
    assert.equal(await visaService.getPublicVisaType(CC, "missing"), null);
  });
});

// ============================================
// createVisaType write path
// ============================================

describe("createVisaType (POST /countries/:code/visas)", () => {
  /** Valid create body. */
  const body = {
    name: "Sponsored Worker",
    code: "sw",
    description: "Created by an admin",
    category: "work",
    processingTime: "3 weeks",
    processingDaysMin: 5,
    processingDaysMax: 21,
    baseCostUsd: 50,
    validityPeriod: "2 years",
    eligibilityCriteria: ["job offer"],
  };

  test("writes isActive:false, visibility agency, pending_review, createdBy; hidden from the public list", async () => {
    const r = await call(visaController.createVisaType.bind(visaController), {
      params: { code: CC },
      body,
      userId: "uid-admin",
    });
    assert.equal(r.status, 201);
    const created = r.body.data as VisaType;
    const stored = store.get(`countries/${CC}/visaTypes/${created.id}`)!;
    assert.equal(stored.isActive, false);
    assert.equal(stored.visibility, "agency");
    assert.equal(stored.reviewStatus, "pending_review");
    assert.equal(stored.source, "agent");
    assert.equal(stored.createdBy, "uid-admin");
    assert.equal(stored.ownerAgencyId, undefined);

    // Not in the public list, and the stats ignore it (cheaper than all).
    const list = await call(visaController.getVisaTypes.bind(visaController), { params: { code: CC } });
    assert.deepEqual(ids(list.body.data), VISIBLE);
    assert.equal(store.get(`countries/${CC}`)!.visaTypesCount, VISIBLE.length);
    assert.equal(store.get(`countries/${CC}`)!.minCostUsd, 150);
  });

  test("approval activates it but keeps visibility agency (still not public)", async () => {
    const created = await visaService.createVisaType({ ...body, countryCode: CC } as any, "uid-admin");
    const approved = await visaService.updateVisaReviewStatus(CC, created.id, "approve", "uid-admin");
    assert.equal(approved.isActive, true);
    assert.equal(approved.reviewStatus, "approved");
    assert.equal(approved.visibility, "agency");
    // No review write touched visibility.
    for (const w of writes.filter((x) => x.path.endsWith(created.id) && x.op === "update")) {
      assert.equal("visibility" in w.data, false);
    }
    const list = await visaService.getVisaTypesByCountry(CC);
    assert.equal(list.some((v) => v.id === created.id), false);
  });
});

// ============================================
// Backfill
// ============================================

describe("backfill-visa-ownership", () => {
  test("planner: approved legacy → global; pending / rejected → inactive + agency; others untouched", () => {
    assert.deepEqual(planVisaOwnershipBackfill({ source: "agent", reviewStatus: "approved", isActive: true }), {
      outcome: "made_global",
      update: { visibility: "global" },
    });
    assert.deepEqual(planVisaOwnershipBackfill({ source: "agent", reviewStatus: "pending_review", isActive: true }), {
      outcome: "hidden",
      update: { isActive: false, visibility: "agency" },
    });
    assert.deepEqual(planVisaOwnershipBackfill({ source: "agent", reviewStatus: "rejected", isActive: false }), {
      outcome: "hidden",
      update: { visibility: "agency" },
    });
    assert.deepEqual(
      planVisaOwnershipBackfill({ source: "agent", reviewStatus: "approved", isActive: true, visibility: "global" }),
      { outcome: "unchanged", update: {} }
    );
    for (const source of [undefined, "scraped", "agency"] as const) {
      assert.equal(
        planVisaOwnershipBackfill({ source, reviewStatus: "pending_review", isActive: true }).outcome,
        "skipped_not_agent"
      );
    }
  });

  test("CLI flags: dry run unless --apply; --dry-run always wins", () => {
    assert.deepEqual(parseBackfillArgs([]), { dryRun: true });
    assert.deepEqual(parseBackfillArgs(["--dry-run"]), { dryRun: true });
    assert.deepEqual(parseBackfillArgs(["--apply"]), { dryRun: false });
    assert.deepEqual(parseBackfillArgs(["--apply", "--dry-run"]), { dryRun: true });
  });

  /** Add legacy agent docs on top of the matrix (which has agentPending). */
  function seedLegacy(): void {
    store.set(`countries/${CC}/visaTypes/agentApproved`, visaDoc("agentApproved", {
      isActive: true, source: "agent", reviewStatus: "approved",
    }));
    store.set(`countries/${CC}/visaTypes/agentRejected`, visaDoc("agentRejected", {
      isActive: false, source: "agent", reviewStatus: "rejected",
    }));
  }

  test("dry run (the default) reports counts and writes nothing", async () => {
    seedLegacy();
    const before = JSON.stringify([...store.entries()]);
    const r = await backfillVisaOwnership();
    assert.equal(r.dryRun, true);
    assert.equal(r.legacy, 3);
    assert.equal(r.madeGlobal, 1);
    assert.equal(r.hidden, 2);
    assert.equal(r.written, 0);
    assert.deepEqual(r.countriesRecomputed, []);
    assert.equal(writes.length, 0);
    assert.equal(JSON.stringify([...store.entries()]), before);
  });

  test("real run migrates, recomputes stats; a second run is a no-op", async () => {
    seedLegacy();
    const r = await backfillVisaOwnership({ dryRun: false });
    assert.equal(r.written, 3);
    assert.deepEqual(r.countriesRecomputed, [CC]);

    const doc = (id: string) => store.get(`countries/${CC}/visaTypes/${id}`)!;
    assert.equal(doc("agentApproved").visibility, "global");
    assert.equal(doc("agentApproved").isActive, true);
    assert.equal(doc("agentPending").isActive, false);
    assert.equal(doc("agentPending").visibility, "agency");
    assert.equal(doc("agentPending").ownerAgencyId, undefined);
    assert.equal(doc("agentRejected").visibility, "agency");
    // Non-agent docs untouched.
    assert.equal(doc("seed").visibility, undefined);
    assert.equal(doc("agencyOnly").visibility, "agency");

    // The approved legacy visa is public; stats count it.
    const list = await visaService.getVisaTypesByCountry(CC);
    assert.deepEqual(ids(list), [...VISIBLE, "agentApproved"].sort());
    assert.equal(store.get(`countries/${CC}`)!.visaTypesCount, VISIBLE.length + 1);

    // ---- Second run: nothing to do ----
    const writesBefore = writes.length;
    const again = await backfillVisaOwnership({ dryRun: false });
    assert.equal(again.unchanged, 3);
    assert.equal(again.written, 0);
    assert.deepEqual(again.countriesRecomputed, []);
    assert.equal(writes.length, writesBefore);
  });
});
