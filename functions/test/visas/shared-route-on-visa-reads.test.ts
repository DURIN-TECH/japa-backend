// ============================================
// Shared route on the public visa reads (issue #237, P8 of #228)
// ============================================
//
// Hermetic: in-memory Firestore fake, handlers called directly. Every id, code
// and name is made up. Covers `sharedRoute` on:
//  - GET /countries/:code/visas, /:visaId, /:visaId/full, /visas, /visas/search,
//    /visas/popular;
//  - a visa without inheritance: `sharedRoute: null`;
//  - a retired / unknown route: null;
//  - `covers`: today's destinations that have a PUBLICLY VISIBLE inheriting
//    record only (a member with a pending, inactive or agency-only record, or
//    one that is not a destination, is left out);
//  - cost: one shared-route read per distinct route per request;
//  - nothing but id, name and { countryCode, countryName } is exposed.

import { test, describe, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Timestamp } from "firebase-admin/firestore";
import { fakeCollection, installFakes, resetStore, store } from "../helpers/fake-firestore";
import type { Data } from "../helpers/fake-firestore";

/* eslint-disable @typescript-eslint/no-explicit-any */

const T0 = Timestamp.fromMillis(1_700_000_000_000);

/** A tiny collection-group fake over the store: where(array-contains / ==) + get. */
function groupFake(collectionId: string, filters: Array<[string, string, unknown]> = []): any {
  return {
    where: (f: string, op: string, v: unknown) => groupFake(collectionId, [...filters, [f, op, v]]),
    async get() {
      const { fakeDoc, clone } = await import("../helpers/fake-firestore");
      const docs = [...store.entries()]
        .filter(([p]) => {
          const parts = p.split("/");
          return parts.length % 2 === 0 && parts[parts.length - 2] === collectionId;
        })
        .filter(([, d]: [string, any]) => filters.every(([f, op, v]) => (op === "==" ? d[f] === v : Array.isArray(d[f]) && d[f].some((x: unknown) => JSON.stringify(x) === JSON.stringify(v)))))
        .map(([p, d]) => ({ id: fakeDoc(p).id, exists: true, ref: fakeDoc(p), data: () => clone(d) }));
      return { docs, empty: docs.length === 0, size: docs.length };
    },
  };
}

interface Captured {
  status: number;
  body: any;
}
async function call(handler: (req: any, res: any) => Promise<void>, req: { params?: Data; query?: Data }): Promise<Captured> {
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

function visa(cc: string, id: string, over: Record<string, unknown> = {}): void {
  store.set(`countries/${cc}/visaTypes/${id}`, {
    id, countryCode: cc, name: `Visa ${id}`, code: id.toUpperCase(), description: "d", category: "tourist", processingTime: "1 week",
    processingDaysMin: 5, processingDaysMax: 7, baseCostUsd: 100, validityPeriod: "90 days", isExtendable: false, eligibilityCriteria: [],
    agentIds: [], isActive: true, createdAt: T0, updatedAt: T0, ...over,
  });
}
const inherits = (...ids: string[]) => ({ inheritsFrom: ids.map((sharedRouteId) => ({ sharedRouteId })) });
function route(id: string, over: Record<string, unknown> = {}): void {
  store.set(`sharedRoutes/${id}`, {
    id, name: `Route ${id}`, category: "tourist", issuingAuthorityId: "test-bloc", destinations: { mode: "listed", countryCodes: ["XA", "XB", "XC", "XD", "XE"] },
    status: "active", createdBy: "a", createdAt: T0, updatedBy: "a", updatedAt: T0, ...over,
  });
}

let visaController: any;
let sharedRouteService: any;

before(async () => {
  await installFakes();
  const firebase: any = await import("../../src/utils/firebase");
  firebase.collections.sharedRoutes = fakeCollection("sharedRoutes");
  firebase.collectionGroups.visaTypes = () => groupFake("visaTypes");
  firebase.subcollections.requirements = (cc: string, v: string) => fakeCollection(`countries/${cc}/visaTypes/${v}/requirements`);
  firebase.subcollections.authorityMembers = (id: string) => fakeCollection(`authorities/${id}/members`);
  visaController = (await import("../../src/controllers/visa.controller")).visaController;
  sharedRouteService = (await import("../../src/shared-routes")).sharedRouteService;
});

beforeEach(() => {
  resetStore();
  for (const cc of ["XA", "XB", "XC", "XD", "XE", "XF"]) store.set(`countries/${cc}`, { code: cc, name: `Country ${cc}`, isSupported: true, popularityRank: 1, createdAt: T0, updatedAt: T0 });
  route("route-one");
  route("route-two", { destinations: { mode: "listed", countryCodes: ["XA", "XF"] } });
  route("route-old", { status: "retired" });
  visa("XA", "xa-visit", inherits("route-one"));
  visa("XB", "xb-visit", inherits("route-one"));
  visa("XC", "xc-visit", { ...inherits("route-one"), reviewStatus: "pending_review" }); // not publicly visible
  visa("XD", "xd-visit", { ...inherits("route-one"), isActive: false }); // inactive
  visa("XE", "xe-visit", { ...inherits("route-one"), visibility: "agency" }); // agency-only
  visa("XA", "xa-plain"); // no inheritance
  visa("XA", "xa-old", inherits("route-old")); // retired route
  visa("XF", "xf-visit", inherits("route-two")); // another route
});

const names = (r: any) => r.covers.map((c: any) => c.countryCode);

describe("sharedRoute on the country visa list", () => {
  test("a visa on a route gets { id, name, covers }; covers lists only countries with a publicly visible inheriting record", async () => {
    const out = await call((q, s) => visaController.getVisaTypes(q, s), { params: { code: "XA" } });
    assert.equal(out.status, 200);
    const v = out.body.data.find((x: any) => x.id === "xa-visit");
    assert.deepEqual(v.sharedRoute, {
      id: "route-one",
      name: "Route route-one",
      covers: [{ countryCode: "XA", countryName: "Country XA" }, { countryCode: "XB", countryName: "Country XB" }],
    });
  });

  test("a visa without inheritance gets sharedRoute null and is otherwise unchanged", async () => {
    const out = await call((q, s) => visaController.getVisaTypes(q, s), { params: { code: "XA" } });
    const plain = out.body.data.find((x: any) => x.id === "xa-plain");
    assert.equal(plain.sharedRoute, null);
    assert.equal(plain.name, "Visa xa-plain");
  });

  test("a retired route gives null", async () => {
    const out = await call((q, s) => visaController.getVisaTypes(q, s), { params: { code: "XA" } });
    assert.equal(out.body.data.find((x: any) => x.id === "xa-old").sharedRoute, null);
  });

  test("a member whose record is hidden is left out; a country that is not a destination today is left out", async () => {
    // XB leaves the destinations: it still has a visible inheriting record, but is not covered.
    route("route-one", { destinations: { mode: "listed", countryCodes: ["XA", "XC", "XD", "XE"] } });
    const out = await call((q, s) => visaController.getVisaTypes(q, s), { params: { code: "XA" } });
    const v = out.body.data.find((x: any) => x.id === "xa-visit");
    assert.deepEqual(names(v.sharedRoute), ["XA"]);
  });

  test("only one shared-route read per distinct route, however many visas inherit it", async () => {
    visa("XA", "xa-second", inherits("route-one"));
    visa("XA", "xa-third", inherits("route-one", "route-two"));
    const original = sharedRouteService.get.bind(sharedRouteService);
    const asked: string[] = [];
    sharedRouteService.get = async (id: string) => {
      asked.push(id);
      return original(id);
    };
    try {
      await call((q, s) => visaController.getVisaTypes(q, s), { params: { code: "XA" } });
    } finally {
      delete sharedRouteService.get; // back to the prototype method
    }
    assert.deepEqual([...asked].sort(), ["route-old", "route-one", "route-two"]);
  });

  test("with several inherited routes the first active one is used", async () => {
    visa("XA", "xa-multi", inherits("route-old", "route-two"));
    const out = await call((q, s) => visaController.getVisaTypes(q, s), { params: { code: "XA" } });
    const v = out.body.data.find((x: any) => x.id === "xa-multi");
    assert.equal(v.sharedRoute.id, "route-two");
    assert.deepEqual(names(v.sharedRoute), ["XA", "XF"]);
  });

  test("only public fields are exposed", async () => {
    const out = await call((q, s) => visaController.getVisaTypes(q, s), { params: { code: "XA" } });
    const v = out.body.data.find((x: any) => x.id === "xa-visit");
    assert.deepEqual(Object.keys(v.sharedRoute).sort(), ["covers", "id", "name"]);
    for (const c of v.sharedRoute.covers) assert.deepEqual(Object.keys(c).sort(), ["countryCode", "countryName"]);
  });

  test("members_of destinations are read from membership data on the day", async () => {
    store.set("authorities/test-bloc", { id: "test-bloc", kind: "bloc", name: "Test bloc", status: "active", createdBy: "a", createdAt: T0, updatedBy: "a", updatedAt: T0 });
    const member = (cc: string, joinedOn: string, leftOn?: string) =>
      store.set(`authorities/test-bloc/members/${cc}`, { countryCode: cc, joinedOn, ...(leftOn ? { leftOn } : {}), sourceQuote: "q", sourceUrl: "https://x.example.org/", createdBy: "a", createdAt: T0, updatedBy: "a", updatedAt: T0 });
    member("XA", "2020-01-01");
    member("XB", "2019-01-01", "2024-01-01"); // left
    route("route-one", { destinations: { mode: "members_of", authorityId: "test-bloc" } });
    const out = await call((q, s) => visaController.getVisaTypes(q, s), { params: { code: "XA" } });
    assert.deepEqual(names(out.body.data.find((x: any) => x.id === "xa-visit").sharedRoute), ["XA"]);
  });
});

describe("sharedRoute on the other public reads", () => {
  test("single visa, /full, /visas, /visas/search and /visas/popular", async () => {
    const one = await call((q, s) => visaController.getVisaType(q, s), { params: { code: "XA", visaId: "xa-visit" } });
    assert.equal(one.body.data.sharedRoute.id, "route-one");
    assert.deepEqual(names(one.body.data.sharedRoute), ["XA", "XB"]);

    const plain = await call((q, s) => visaController.getVisaType(q, s), { params: { code: "XA", visaId: "xa-plain" } });
    assert.equal(plain.body.data.sharedRoute, null);

    const full = await call((q, s) => visaController.getVisaTypeWithRequirements(q, s), { params: { code: "XB", visaId: "xb-visit" } });
    assert.equal(full.body.data.visaType.sharedRoute.id, "route-one");
    assert.ok(Array.isArray(full.body.data.requirements));

    const all = await call((q, s) => visaController.getAllVisaTypes(q, s), { query: { limit: "50" } });
    const listed = all.body.data.visaTypes;
    assert.ok(listed.length > 0 && listed.every((v: any) => "sharedRoute" in v));
    assert.equal(listed.find((v: any) => v.id === "xf-visit").sharedRoute.id, "route-two");
    assert.equal(all.body.data.total, listed.length);

    const search = await call((q, s) => visaController.searchVisaTypes(q, s), { query: { q: "xb-visit" } });
    assert.ok(search.body.data.every((v: any) => "sharedRoute" in v));

    const popular = await call((q, s) => visaController.getPopularVisaTypes(q, s), { query: {} });
    assert.ok(popular.body.data.every((v: any) => "sharedRoute" in v));
  });

  test("a hidden visa is still a 404 (visibility rules unchanged)", async () => {
    const hidden = await call((q, s) => visaController.getVisaType(q, s), { params: { code: "XC", visaId: "xc-visit" } });
    assert.equal(hidden.status, 404);
  });
});
