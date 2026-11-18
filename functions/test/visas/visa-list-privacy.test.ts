// ============================================
// Unit tests — public visa lists hide agency-private fields (issue #153)
// ============================================
//
// Run with `npm test`. Hermetic (in-memory fake Firestore, handlers called
// directly), same approach as visa-visibility.test.ts.
//
// A global agency visa carries seven private fields. Every PUBLIC list route
// must return it in its applicant-safe shape, while seeded / scraped visas
// come back unchanged and the admin list still shows the full doc:
//   GET /countries/:code/visas (all + ?category=), GET /visas,
//   GET /visas/search?q=, GET /visas/popular, and (unchanged) GET /admin/visas.

import { test, describe, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Timestamp } from "firebase-admin/firestore";
import { defineAbilitiesFor, ROLES } from "@durin-tech/authz";

import { installFakes, resetStore, store } from "../helpers/fake-firestore";
import type { Data } from "../helpers/fake-firestore";
import { visaController } from "../../src/controllers/visa.controller";
import { toPublicListVisa } from "../../src/agency-visas/agency-visa-access";
import type { VisaType } from "../../src/types";

/* eslint-disable @typescript-eslint/no-explicit-any */

const CC = "GB";
const T0 = Timestamp.fromMillis(1_700_000_000_000);

/** The seven fields no public list may ever contain (dotted = nested). */
const PRIVATE_PATHS = [
  "sponsor.sponsorLicenceNumber",
  "sponsor.contact",
  "createdBy",
  "reviewedBy",
  "submittedBy",
  "madeGlobalBy",
  "agentIds",
];

/** Whether `path` (dotted) exists on `obj`. */
function hasPath(obj: any, path: string): boolean {
  const [head, ...rest] = path.split(".");
  if (obj == null || !(head in obj)) return false;
  return rest.length === 0 ? true : hasPath(obj[head], rest.join("."));
}

/** Fail unless NONE of the seven private fields is on `visa`. */
function assertNoPrivateFields(visa: any): void {
  for (const path of PRIVATE_PATHS) {
    assert.equal(hasPath(visa, path), false, `${visa.id} leaks ${path}`);
  }
}

/** A complete visa doc; `over` sets what the case is about. */
function visaDoc(id: string, over: Data): Data {
  return {
    id,
    countryCode: CC,
    name: `Visa ${id}`,
    // "agencyglobal" must be findable by search ("Visa ...").
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
    isActive: true,
    createdAt: T0,
    updatedAt: T0,
    ...over,
  };
}

/** An approved, global agency visa with every private field filled in. */
const AGENCY_GLOBAL: Data = {
  source: "agency",
  reviewStatus: "approved",
  visibility: "global",
  ownerAgencyId: "agency-1",
  sponsor: {
    organisationName: "Acme Ltd",
    website: "https://acme.example",
    sponsorLicenceNumber: "ABC123",
    contact: { name: "Jo", email: "delivered+jo@resend.dev" },
  },
  createdBy: "uid-owner",
  reviewedBy: "uid-admin",
  submittedBy: "uid-owner",
  madeGlobalBy: "uid-admin",
  agentIds: ["agent-1", "agent-2"],
};

/** Seed: a seeded visa, a scraped visa, and the global agency visa. */
function seed(): void {
  store.set(`countries/${CC}`, {
    code: CC,
    name: "United Kingdom",
    isSupported: true,
    popularityRank: 1,
    visaTypesCount: 3,
    createdAt: T0,
    updatedAt: T0,
  });
  store.set(`countries/${CC}/visaTypes/seed`, visaDoc("seed", { agentIds: ["seed-agent"] }));
  store.set(
    `countries/${CC}/visaTypes/scraped`,
    visaDoc("scraped", { source: "scraped", reviewStatus: "approved", sourceUrl: "https://gov.example" })
  );
  store.set(`countries/${CC}/visaTypes/agencyglobal`, visaDoc("agencyglobal", AGENCY_GLOBAL));
}

/** Captured response of one handler call. */
interface Captured {
  status: number;
  body: any;
}

/** Call a controller handler with a minimal req / res; return status + body. */
async function call(
  handler: (req: any, res: any) => Promise<void>,
  req: { params?: Data; query?: Data; ability?: unknown }
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

/** Pull the visa list out of a `{ data }` envelope, or `{ data: { visaTypes } }`. */
const listOf = (c: Captured): any[] => (Array.isArray(c.body.data) ? c.body.data : c.body.data.visaTypes);
const byId = (list: any[], id: string) => list.find((v) => v.id === id);

before(async () => {
  await installFakes();
});

beforeEach(() => {
  resetStore();
  seed();
});

/** Shared assertions: agency visa safe + still present, others untouched. */
function assertProjected(list: any[]): void {
  const agency = byId(list, "agencyglobal");
  assert.ok(agency, "the global agency visa is still listed");
  assertNoPrivateFields(agency);
  // The public part survives.
  assert.equal(agency.name, "Visa agencyglobal");
  assert.equal(agency.sponsor.organisationName, "Acme Ltd");
  assert.equal(agency.sponsor.website, "https://acme.example");
}

describe("public visa lists project agency visas (#153)", () => {
  test("GET /countries/:code/visas (all visas)", async () => {
    const r = await call((q, s) => visaController.getVisaTypes(q, s), { params: { code: CC } });
    assert.equal(r.status, 200);
    assertProjected(listOf(r));
  });

  test("GET /countries/:code/visas?category=", async () => {
    const r = await call((q, s) => visaController.getVisaTypes(q, s), {
      params: { code: CC },
      query: { category: "work" },
    });
    assert.equal(r.status, 200);
    assertProjected(listOf(r));
  });

  test("GET /visas (total is unchanged)", async () => {
    const r = await call((q, s) => visaController.getAllVisaTypes(q, s), {});
    assert.equal(r.status, 200);
    assert.equal(r.body.data.total, 3);
    assertProjected(listOf(r));
  });

  test("GET /visas?category=", async () => {
    const r = await call((q, s) => visaController.getAllVisaTypes(q, s), { query: { category: "work" } });
    assertProjected(listOf(r));
  });

  test("GET /visas/search?q=", async () => {
    const r = await call((q, s) => visaController.searchVisaTypes(q, s), { query: { q: "agencyglobal" } });
    assert.equal(r.status, 200);
    assertProjected(listOf(r));
  });

  test("GET /visas/popular", async () => {
    const r = await call((q, s) => visaController.getPopularVisaTypes(q, s), {});
    assert.equal(r.status, 200);
    assertProjected(listOf(r));
  });
});

describe("seeded and scraped visas are unchanged (#153)", () => {
  test("country list returns them exactly as stored", async () => {
    const r = await call((q, s) => visaController.getVisaTypes(q, s), { params: { code: CC } });
    const list = listOf(r);
    // The seeded doc keeps its agentIds: it is not an agency visa.
    assert.deepEqual(byId(list, "seed").agentIds, ["seed-agent"]);
    assert.equal(byId(list, "scraped").sourceUrl, "https://gov.example");
    assert.equal(byId(list, "scraped").source, "scraped");
  });

  test("toPublicListVisa returns a non-agency visa as the same object", () => {
    const v = visaDoc("seed", {}) as unknown as VisaType;
    assert.equal(toPublicListVisa(v), v);
  });
});

// ---- Rebase onto #237 (shared routes on public visa reads) ----
// The list handlers attach `sharedRoute` on the FULL record (the lookup needs
// `inheritsFrom`, which the applicant-safe whitelist drops) and project
// afterwards, so the projection must carry `sharedRoute` over.
describe("projection keeps the public sharedRoute (#153 on top of #237)", () => {
  test("toPublicListVisa keeps an attached sharedRoute on an agency visa", () => {
    const route = { id: "route-1", name: "Schengen", covers: [{ countryCode: CC, countryName: "United Kingdom" }] };
    const v = { ...visaDoc("agencyglobal", AGENCY_GLOBAL), sharedRoute: route } as unknown as VisaType;
    const out: any = toPublicListVisa(v);
    // Still projected: none of the seven private fields...
    assertNoPrivateFields(out);
    // ...and the route the app shows ("one route, several countries") survives.
    assert.deepEqual(out.sharedRoute, route);
  });

  test("an explicit sharedRoute: null is kept as null", () => {
    const v = { ...visaDoc("agencyglobal", AGENCY_GLOBAL), sharedRoute: null } as unknown as VisaType;
    const out: any = toPublicListVisa(v);
    assert.equal("sharedRoute" in out, true);
    assert.equal(out.sharedRoute, null);
  });

  test("no sharedRoute key is added when the caller did not attach one", () => {
    const out: any = toPublicListVisa(visaDoc("agencyglobal", AGENCY_GLOBAL) as unknown as VisaType);
    assert.equal("sharedRoute" in out, false);
  });

  test("GET /countries/:code/visas: the projected agency visa carries sharedRoute: null", async () => {
    // No visa in the seed inherits a route, so attachSharedRoutes takes its
    // fast path (sharedRoute: null) and the projection must keep that key.
    const r = await call((q, s) => visaController.getVisaTypes(q, s), { params: { code: CC } });
    const agency = byId(listOf(r), "agencyglobal");
    assertNoPrivateFields(agency);
    assert.equal(agency.sharedRoute, null);
  });
});

describe("admin list is unchanged (#153)", () => {
  test("GET /admin/visas still returns every private field", async () => {
    const r = await call(visaController.getAdminVisas.bind(visaController), {
      // The real handler gates on the caller's CASL ability: an admin's.
      ability: defineAbilitiesFor({ uid: "uid-admin", role: ROLES.ADMIN, agencyId: null }),
    });
    assert.equal(r.status, 200);
    const list: any[] = Array.isArray(r.body.data) ? r.body.data : r.body.data.visas ?? r.body.data.visaTypes;
    const agency = byId(list, "agencyglobal");
    assert.ok(agency, "admin sees the agency visa");
    for (const path of PRIVATE_PATHS) {
      assert.equal(hasPath(agency, path), true, `admin list lost ${path}`);
    }
  });
});
