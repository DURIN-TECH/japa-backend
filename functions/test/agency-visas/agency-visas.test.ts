// ============================================
// Unit tests — agency visa create / edit / submit / delete (issue #100)
// ============================================
//
// Run with `npm test`. Hermetic: NO network and NO emulator. Firestore refs
// in utils/firebase are swapped for the in-memory fake
// (test/helpers/fake-firestore.ts + fake-collection-group.ts), the
// transaction runner for the in-memory one, and the controller handlers are
// called directly with a minimal req / res carrying a REAL CASL ability from
// @durin-tech/authz (defineAbilitiesFor). One suite mounts the real router on
// a local HTTP server to check that every route answers 401 without a token.
//
// Two agencies, A and B. Covers:
//  - validation: required fields, bad values, sponsor, protected fields
//    (every VISA_PROTECTED_FIELDS key -> 400) and other unknown keys;
//  - create: server-built draft (ownership, source, visibility, draft,
//    inactive), tampering refused with nothing written, unknown country;
//  - list / get: own visas only, `[]` for an empty agency, 404 with the same
//    body for an unknown id and agency A's id seen by B;
//  - B gets 404 (and writes nothing) on A's id for get / update / submit /
//    delete;
//  - update: draft + rejected written, pending 409, countryCode immutable,
//    null clears optional fields;
//  - submit: draft -> pending_review (isActive false), 409 twice, 400 on
//    missing required fields, rejected -> pending with reason cleared;
//  - approved edit: live doc + isActive untouched, revision stored, public
//    reads keep the live values, merge / revert / reopen a rejected revision;
//  - delete: drafts only (409 otherwise);
//  - roles: owner + agent OK; agent without agency, client, admin 403;
//  - a doc owned by A but not `source: "agency"` is never reachable (the
//    ability is checked on the tagged doc, conditions included);
//  - admin list hides drafts; admin review refuses a draft (409);
//  - public reads never return a draft / pending / rejected agency visa.

import { test, describe, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { Timestamp } from "firebase-admin/firestore";
import { VISA_PROTECTED_FIELDS, ROLES, defineAbilitiesFor } from "@durin-tech/authz";

import { clone, fakeCollection, fakeRunTransaction, installFakes, resetStore, store, writes } from "../helpers/fake-firestore";
import type { Data } from "../helpers/fake-firestore";
import { fakeCollectionGroup } from "../helpers/fake-collection-group";
import { agencyVisaController } from "../../src/agency-visas/agency-visa.controller";
import { agencyVisaService } from "../../src/agency-visas/agency-visa.service";
import { AgencyVisaError, parseAgencyVisaBody } from "../../src/agency-visas/agency-visa.validation";
import { visaController } from "../../src/controllers/visa.controller";
import { visaService } from "../../src/services/visa.service";

/* eslint-disable @typescript-eslint/no-explicit-any */

// ============================================
// Fixtures
// ============================================

/** Country of every visa here. */
const CC = "GB";
/** Fixed timestamp for seeded docs. */
const T0 = Timestamp.fromMillis(1_700_000_000_000);
const AGENCY_A = "agency-a";
const AGENCY_B = "agency-b";

/** A complete, valid create body (agency-sponsored skilled worker route). */
function validBody(over: Data = {}): Data {
  return {
    countryCode: "gb",
    name: "Acme Sponsored Skilled Worker",
    code: "acme-sw",
    description: "Skilled worker route sponsored by Acme Ltd (CoS issued by Acme).",
    category: "work",
    processingTime: "3 to 8 weeks",
    processingDaysMin: 21,
    processingDaysMax: 56,
    validityPeriod: "Up to 5 years",
    isExtendable: true,
    eligibilityCriteria: ["Job offer from Acme Ltd", "English at B1"],
    baseCostUsd: 900,
    sourceUrl: "https://www.gov.uk/skilled-worker-visa",
    sponsor: {
      organisationName: "Acme Ltd",
      website: "https://acme.example.org",
      sponsorLicenceNumber: "ABC12345",
      contact: "delivered+acme@resend.dev",
    },
    ...over,
  };
}

/** A stored agency visa doc for agency A (seed directly into the store). */
function agencyDoc(id: string, over: Data = {}): Data {
  return {
    id,
    countryCode: CC,
    name: `Visa ${id}`,
    code: id.toUpperCase(),
    description: "agency visa",
    category: "work",
    processingTime: "3 weeks",
    processingDaysMin: 15,
    processingDaysMax: 21,
    baseCostUsd: 100,
    validityPeriod: "2 years",
    isExtendable: false,
    eligibilityCriteria: ["criterion"],
    agentIds: [],
    source: "agency",
    ownerAgencyId: AGENCY_A,
    createdBy: "uid-owner-a",
    visibility: "agency",
    reviewStatus: "draft",
    isActive: false,
    createdAt: T0,
    updatedAt: T0,
    ...over,
  };
}

/** Store path of a visa doc. */
const visaPath = (id: string) => `countries/${CC}/visaTypes/${id}`;
/** Store path of a revision doc. */
const revPath = (id: string) => `visaRevisions/${CC}__${id}`;

/** Seed the GB country doc. */
function seedCountry(): void {
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
}

/** Seed one agency visa; returns its id. */
function seedVisa(id: string, over: Data = {}): string {
  store.set(visaPath(id), agencyDoc(id, over));
  return id;
}

// ============================================
// Principals (real CASL abilities)
// ============================================

/** An authenticated principal: what verifyAuth puts on the request. */
interface Principal {
  userId: string;
  authz: { uid: string; role: string; agencyId: string | null };
  ability: unknown;
}

/** Build a principal for a role + agency. */
function principal(uid: string, role: (typeof ROLES)[keyof typeof ROLES], agencyId: string | null): Principal {
  const authz = { uid, role, agencyId };
  return { userId: uid, authz, ability: defineAbilitiesFor(authz as any) };
}

const ownerA = () => principal("uid-owner-a", ROLES.OWNER, AGENCY_A);
const agentA = () => principal("uid-agent-a", ROLES.AGENT, AGENCY_A);
const ownerB = () => principal("uid-owner-b", ROLES.OWNER, AGENCY_B);
const agentNoAgency = () => principal("uid-solo", ROLES.AGENT, null);
const client = () => principal("uid-client", ROLES.CLIENT, null);
const admin = () => principal("uid-admin", ROLES.ADMIN, null);

// ============================================
// Minimal Express req / res
// ============================================

/** Captured response of one handler call. */
interface Captured {
  status: number;
  body: any;
}

/** Call a handler as `who` with params / body; return status + body. */
async function call(
  handler: (req: any, res: any) => Promise<void>,
  who: Principal | null,
  req: { params?: Data; query?: Data; body?: unknown; method?: string } = {}
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
  await handler({ params: {}, query: {}, body: {}, headers: {}, ...(who ?? {}), ...req }, res);
  return out;
}

/** Bound handler shorthands. */
const C = agencyVisaController;
const list = (who: Principal) => call(C.list.bind(C), who);
const get = (who: Principal, id: string) => call(C.get.bind(C), who, { params: { id } });
const create = (who: Principal, body: unknown) => call(C.create.bind(C), who, { body });
const update = (who: Principal, id: string, body: unknown) => call(C.update.bind(C), who, { params: { id }, body });
const submit = (who: Principal, id: string) => call(C.submit.bind(C), who, { params: { id } });
const remove = (who: Principal, id: string) => call(C.remove.bind(C), who, { params: { id } });

/** Snapshot of a stored doc (deep copy for before/after comparisons; the
 *  fake's clone keeps Timestamp instances, structuredClone would not). */
const snapshotOf = (path: string) => clone(store.get(path));

// ============================================
// Setup
// ============================================

before(async () => {
  await installFakes();
  const firebase: any = await import("../../src/utils/firebase");
  // Issue #100: revisions collection + the cross-country visaTypes group.
  firebase.collections.visaRevisions = fakeCollection("visaRevisions");
  firebase.collectionGroups.visaTypes = () => fakeCollectionGroup("visaTypes");
  agencyVisaService.runTransaction = fakeRunTransaction;
});

beforeEach(() => {
  resetStore();
  seedCountry();
});

// ============================================
// Validation (pure)
// ============================================

describe("parseAgencyVisaBody", () => {
  /** Expect a 400 AgencyVisaError naming `field`. */
  function expect400(body: unknown, mode: "create" | "update", field: string, code = "VALIDATION_ERROR") {
    assert.throws(
      () => parseAgencyVisaBody(body, mode),
      (e: unknown) => e instanceof AgencyVisaError && e.httpStatus === 400 && e.field === field && e.code === code
    );
  }

  test("a valid body is normalised (countryCode + code upper-cased, text trimmed)", () => {
    const { fields, cleared } = parseAgencyVisaBody(validBody({ name: "  Acme route  " }), "create");
    assert.equal(fields.countryCode, "GB");
    assert.equal(fields.code, "ACME-SW");
    assert.equal(fields.name, "Acme route");
    assert.deepEqual(cleared, []);
  });

  test("every VISA_PROTECTED_FIELDS key is refused with 400 PROTECTED_FIELD (create and update)", () => {
    for (const key of VISA_PROTECTED_FIELDS) {
      expect400(validBody({ [key]: "x" }), "create", key, "PROTECTED_FIELD");
      expect400({ [key]: "x" }, "update", key, "PROTECTED_FIELD");
    }
  });

  test("agentIds, scrapeMeta and other unknown keys are refused with 400 UNKNOWN_FIELD", () => {
    for (const key of ["agentIds", "scrapeMeta", "id", "createdAt", "lastVerifiedAt", "pendingRevision", "submittedAt"]) {
      expect400(validBody({ [key]: [] }), "create", key, "UNKNOWN_FIELD");
    }
  });

  test("create: each missing required field is named", () => {
    for (const field of [
      "countryCode", "name", "code", "description", "category", "processingTime",
      "processingDaysMin", "processingDaysMax", "validityPeriod", "isExtendable", "eligibilityCriteria",
    ]) {
      const body = validBody();
      delete body[field];
      expect400(body, "create", field);
    }
  });

  test("bad values are named", () => {
    expect400(validBody({ name: "   " }), "create", "name");
    expect400(validBody({ category: "space" }), "create", "category");
    expect400(validBody({ processingDaysMin: -1 }), "create", "processingDaysMin");
    expect400(validBody({ processingDaysMax: 2.5 }), "create", "processingDaysMax");
    expect400(validBody({ processingDaysMin: 60, processingDaysMax: 10 }), "create", "processingDaysMin");
    expect400(validBody({ isExtendable: "yes" }), "create", "isExtendable");
    expect400(validBody({ eligibilityCriteria: "one" }), "create", "eligibilityCriteria");
    expect400(validBody({ eligibilityCriteria: ["ok", ""] }), "create", "eligibilityCriteria[1]");
    expect400(validBody({ baseCostUsd: -5 }), "create", "baseCostUsd");
    expect400(validBody({ baseCostUsd: Number.NaN }), "create", "baseCostUsd");
    expect400(validBody({ baseCostUsd: Infinity }), "create", "baseCostUsd");
    expect400(validBody({ sourceUrl: "not a url" }), "create", "sourceUrl");
    expect400(validBody({ sourceUrl: "ftp://gov.uk/x" }), "create", "sourceUrl");
    expect400(validBody({ applicationUrl: "javascript:alert(1)" }), "create", "applicationUrl");
    expect400(validBody({ maxExtensions: -1 }), "create", "maxExtensions");
    expect400(validBody({ countryCode: "GBR" }), "create", "countryCode");
  });

  test("sponsor: bad website, missing organisation name, unknown key", () => {
    expect400(validBody({ sponsor: { organisationName: "Acme", website: "acme" } }), "create", "sponsor.website");
    expect400(validBody({ sponsor: { website: "https://acme.example.org" } }), "create", "sponsor.organisationName");
    expect400(validBody({ sponsor: { organisationName: "Acme", owner: "x" } }), "create", "sponsor.owner", "UNKNOWN_FIELD");
    expect400(validBody({ sponsor: "Acme" }), "create", "sponsor");
  });

  test("update: partial body is fine; null clears optional fields only", () => {
    const parsed = parseAgencyVisaBody({ name: "New", sponsor: null, sourceUrl: null }, "update");
    assert.deepEqual(parsed.fields, { name: "New" });
    assert.deepEqual(parsed.cleared.sort(), ["sourceUrl", "sponsor"]);
    expect400({ name: null }, "update", "name");
  });

  test("a non-object body is a 400", () => {
    assert.throws(() => parseAgencyVisaBody([], "create"), AgencyVisaError);
    assert.throws(() => parseAgencyVisaBody(null, "update"), AgencyVisaError);
  });
});

// ============================================
// Create
// ============================================

describe("POST /agency/visas", () => {
  test("owner creates a server-built draft (ownership, source, visibility, draft, inactive)", async () => {
    const r = await create(ownerA(), validBody());
    assert.equal(r.status, 201);
    const id = r.body.data.id;
    const stored = store.get(visaPath(id))!;
    assert.equal(stored.ownerAgencyId, AGENCY_A);
    assert.equal(stored.createdBy, "uid-owner-a");
    assert.equal(stored.source, "agency");
    assert.equal(stored.visibility, "agency");
    assert.equal(stored.reviewStatus, "draft");
    assert.equal(stored.isActive, false);
    assert.deepEqual(stored.agentIds, []);
    assert.equal(stored.countryCode, CC);
    assert.equal(stored.code, "ACME-SW");
    assert.deepEqual(stored.sponsor, validBody().sponsor);
    assert.equal(r.body.data.pendingRevision, null);
  });

  test("an agent of the agency can create too", async () => {
    const r = await create(agentA(), validBody());
    assert.equal(r.status, 201);
    assert.equal(store.get(visaPath(r.body.data.id))!.createdBy, "uid-agent-a");
  });

  test("tampering with protected fields is a 400 and writes nothing", async () => {
    for (const [key, value] of [
      ["ownerAgencyId", AGENCY_B],
      ["source", "scraped"],
      ["visibility", "global"],
      ["reviewStatus", "approved"],
      ["isActive", true],
      ["createdBy", "someone"],
      ["reviewedBy", "uid-admin"],
      ["rejectionReason", "x"],
      ["agentIds", ["a1"]],
      ["scrapeMeta", {}],
    ] as const) {
      const r = await create(ownerA(), validBody({ [key]: value }));
      assert.equal(r.status, 400, key);
      assert.equal(r.body.field, key);
    }
    assert.equal(writes.length, 0);
  });

  test("unknown country is a 400 naming countryCode", async () => {
    const r = await create(ownerA(), validBody({ countryCode: "ZZ" }));
    assert.equal(r.status, 400);
    assert.equal(r.body.field, "countryCode");
    assert.equal(writes.length, 0);
  });

  test("a missing required field is a 400 naming it", async () => {
    const body = validBody();
    delete body.description;
    const r = await create(ownerA(), body);
    assert.equal(r.status, 400);
    assert.equal(r.body.field, "description");
  });
});

// ============================================
// List / get, and agency isolation
// ============================================

describe("GET /agency/visas and /:id", () => {
  test("A lists its visas newest first; B sees none of them ([] with 200)", async () => {
    seedVisa("old", { createdAt: Timestamp.fromMillis(1), reviewStatus: "rejected", rejectionReason: "Fix fees" });
    seedVisa("new", { createdAt: Timestamp.fromMillis(2) });
    const a = await list(ownerA());
    assert.equal(a.status, 200);
    assert.deepEqual(a.body.data.map((v: any) => v.id), ["new", "old"]);
    // Each item carries review state, visibility and rejection reason.
    assert.equal(a.body.data[1].reviewStatus, "rejected");
    assert.equal(a.body.data[1].rejectionReason, "Fix fees");
    assert.equal(a.body.data[1].visibility, "agency");
    const b = await list(ownerB());
    assert.equal(b.status, 200);
    assert.deepEqual(b.body.data, []);
  });

  test("get: own visa 200; unknown id and A's id seen by B are the same 404", async () => {
    const id = seedVisa("v1");
    const mine = await get(agentA(), id);
    assert.equal(mine.status, 200);
    assert.equal(mine.body.data.id, id);
    const unknown = await get(ownerB(), "does-not-exist");
    const others = await get(ownerB(), id);
    assert.equal(unknown.status, 404);
    assert.equal(others.status, 404);
    assert.deepEqual(others.body, unknown.body);
  });

  test("B gets 404 on A's id for update / submit / delete and nothing is written", async () => {
    const id = seedVisa("v1");
    const before = snapshotOf(visaPath(id));
    for (const r of [
      await update(ownerB(), id, { name: "Hijacked" }),
      await submit(ownerB(), id),
      await remove(ownerB(), id),
    ]) {
      assert.equal(r.status, 404);
      assert.equal(r.body.error, "NOT_FOUND");
    }
    assert.deepEqual(store.get(visaPath(id)), before);
    assert.equal(writes.length, 0);
  });

  test("a doc owned by A that is not source 'agency' is never reachable (tagged CASL conditions)", async () => {
    seedVisa("scraped-x", { source: "scraped", reviewStatus: "pending_review" });
    assert.equal((await get(ownerA(), "scraped-x")).status, 404);
    assert.equal((await update(ownerA(), "scraped-x", { name: "x" })).status, 404);
    assert.deepEqual((await list(ownerA())).body.data, []);
    assert.equal(writes.length, 0);
  });
});

// ============================================
// Update
// ============================================

describe("PUT/PATCH /agency/visas/:id", () => {
  test("updates a draft; protected fields stay unchanged", async () => {
    const id = seedVisa("v1");
    const r = await update(agentA(), id, { name: "Renamed", processingDaysMax: 30 });
    assert.equal(r.status, 200);
    const stored = store.get(visaPath(id))!;
    assert.equal(stored.name, "Renamed");
    assert.equal(stored.processingDaysMax, 30);
    assert.equal(stored.reviewStatus, "draft");
    assert.equal(stored.ownerAgencyId, AGENCY_A);
    assert.equal(stored.isActive, false);
  });

  test("a protected field in an update is a 400 and nothing is written", async () => {
    const id = seedVisa("v1");
    for (const key of VISA_PROTECTED_FIELDS) {
      const r = await update(ownerA(), id, { name: "x", [key]: "y" });
      assert.equal(r.status, 400);
      assert.equal(r.body.error, "PROTECTED_FIELD");
    }
    assert.equal(writes.length, 0);
  });

  test("null clears an optional field; countryCode can't change", async () => {
    const id = seedVisa("v1", { sourceUrl: "https://www.gov.uk/x" });
    assert.equal((await update(ownerA(), id, { sourceUrl: null })).status, 200);
    assert.equal("sourceUrl" in store.get(visaPath(id))!, false);
    const r = await update(ownerA(), id, { countryCode: "IE" });
    assert.equal(r.status, 400);
    assert.equal(r.body.field, "countryCode");
  });

  test("the merged visa must stay consistent (min <= max)", async () => {
    const id = seedVisa("v1"); // min 15, max 21
    const r = await update(ownerA(), id, { processingDaysMin: 40 });
    assert.equal(r.status, 400);
    assert.equal(r.body.field, "processingDaysMin");
  });

  test("a pending_review visa can't be edited (409)", async () => {
    const id = seedVisa("v1", { reviewStatus: "pending_review", submittedAt: T0 });
    const r = await update(ownerA(), id, { name: "x" });
    assert.equal(r.status, 409);
    assert.equal(r.body.error, "VISA_IN_REVIEW");
  });

  test("a rejected visa can be edited (stays rejected until resubmitted)", async () => {
    const id = seedVisa("v1", { reviewStatus: "rejected", rejectionReason: "Fees", submittedAt: T0 });
    assert.equal((await update(ownerA(), id, { baseCostUsd: 950 })).status, 200);
    const stored = store.get(visaPath(id))!;
    assert.equal(stored.baseCostUsd, 950);
    assert.equal(stored.reviewStatus, "rejected");
  });
});

// ============================================
// Submit
// ============================================

describe("POST /agency/visas/:id/submit", () => {
  test("draft -> pending_review, isActive stays false; a second submit is 409", async () => {
    const created = await create(ownerA(), validBody());
    const id = created.body.data.id;
    const r = await submit(ownerA(), id);
    assert.equal(r.status, 200);
    const stored = store.get(`countries/${CC}/visaTypes/${id}`)!;
    assert.equal(stored.reviewStatus, "pending_review");
    assert.equal(stored.isActive, false);
    assert.equal(stored.submittedBy, "uid-owner-a");
    assert.ok(stored.submittedAt instanceof Timestamp);
    const again = await submit(ownerA(), id);
    assert.equal(again.status, 409);
    assert.equal(again.body.error, "ALREADY_SUBMITTED");
  });

  test("missing required fields block submit with a 400 naming the field (nothing written)", async () => {
    const id = seedVisa("v1");
    const doc = store.get(visaPath(id))!;
    delete doc.description;
    const r = await submit(ownerA(), id);
    assert.equal(r.status, 400);
    assert.equal(r.body.field, "description");
    assert.equal(store.get(visaPath(id))!.reviewStatus, "draft");
    assert.equal(writes.length, 0);
  });

  test("rejected -> pending_review and the rejection reason is cleared", async () => {
    const id = seedVisa("v1", { reviewStatus: "rejected", rejectionReason: "Fees", submittedAt: T0 });
    assert.equal((await submit(ownerA(), id)).status, 200);
    const stored = store.get(visaPath(id))!;
    assert.equal(stored.reviewStatus, "pending_review");
    assert.equal("rejectionReason" in stored, false);
    assert.equal(stored.isActive, false);
  });

  test("an approved visa can't be submitted (409)", async () => {
    const id = seedVisa("v1", { reviewStatus: "approved", isActive: true, submittedAt: T0 });
    const r = await submit(ownerA(), id);
    assert.equal(r.status, 409);
    assert.equal(r.body.error, "VISA_APPROVED");
  });
});

// ============================================
// Editing an approved visa = pending revision
// ============================================

describe("editing an approved visa", () => {
  /** An approved, live, globally visible agency visa. */
  function seedApproved(): string {
    return seedVisa("live", {
      reviewStatus: "approved",
      isActive: true,
      visibility: "global",
      name: "Live name",
      submittedAt: T0,
      reviewedBy: "uid-admin",
      reviewedAt: T0,
    });
  }

  test("the live doc and isActive are unchanged; the edit is a pending revision", async () => {
    const id = seedApproved();
    const before = snapshotOf(visaPath(id));
    const r = await update(ownerA(), id, { name: "Proposed name", sponsor: { organisationName: "Acme Ltd" } });
    assert.equal(r.status, 200);
    assert.deepEqual(store.get(visaPath(id)), before);
    const rev = store.get(revPath(id))!;
    assert.equal(rev.reviewStatus, "pending_review");
    assert.equal(rev.ownerAgencyId, AGENCY_A);
    assert.equal(rev.visaId, id);
    assert.deepEqual(rev.changes, { name: "Proposed name", sponsor: { organisationName: "Acme Ltd" } });
    // Agency reads: live values + the revision alongside.
    assert.equal(r.body.data.name, "Live name");
    assert.equal(r.body.data.reviewStatus, "approved");
    assert.equal(r.body.data.isActive, true);
    assert.equal(r.body.data.pendingRevision.changes.name, "Proposed name");
  });

  test("public reads keep serving the live values", async () => {
    const id = seedApproved();
    await update(ownerA(), id, { name: "Proposed name" });
    const pub = await call(visaController.getVisaTypes.bind(visaController), null, { params: { code: CC } });
    assert.equal(pub.status, 200);
    assert.deepEqual(pub.body.data.map((v: any) => v.name), ["Live name"]);
    assert.equal("pendingRevision" in pub.body.data[0], false);
    const one = await call(visaController.getVisaType.bind(visaController), null, { params: { code: CC, visaId: id } });
    assert.equal(one.body.data.name, "Live name");
  });

  test("further edits merge into the revision; reverting everything removes it", async () => {
    const id = seedApproved();
    await update(ownerA(), id, { name: "Proposed name" });
    await update(ownerA(), id, { baseCostUsd: 120 });
    assert.deepEqual(store.get(revPath(id))!.changes, { name: "Proposed name", baseCostUsd: 120 });
    await update(ownerA(), id, { name: "Live name", baseCostUsd: 100 });
    assert.equal(store.has(revPath(id)), false);
  });

  test("clearing an optional field is proposed as null", async () => {
    const id = seedApproved();
    await update(ownerA(), id, { baseCostUsd: null });
    assert.deepEqual(store.get(revPath(id))!.changes, { baseCostUsd: null });
    assert.equal(store.get(visaPath(id))!.baseCostUsd, 100);
  });

  test("a rejected revision is reopened as pending and its reason cleared", async () => {
    const id = seedApproved();
    store.set(revPath(id), {
      id: `${CC}__${id}`,
      visaId: id,
      countryCode: CC,
      ownerAgencyId: AGENCY_A,
      changes: { name: "Bad name" },
      reviewStatus: "rejected",
      rejectionReason: "Name misleading",
      reviewedBy: "uid-admin",
      submittedBy: "uid-owner-a",
      submittedAt: T0,
      createdAt: T0,
      updatedAt: T0,
    });
    await update(agentA(), id, { name: "Better name" });
    const rev = store.get(revPath(id))!;
    assert.equal(rev.reviewStatus, "pending_review");
    assert.equal("rejectionReason" in rev, false);
    assert.deepEqual(rev.changes, { name: "Better name" });
    assert.equal(rev.submittedBy, "uid-agent-a");
  });

  test("B can't stage a revision on A's approved visa", async () => {
    const id = seedApproved();
    assert.equal((await update(ownerB(), id, { name: "x" })).status, 404);
    assert.equal(store.has(revPath(id)), false);
  });

  test("the revision is listed with the visa", async () => {
    const id = seedApproved();
    await update(ownerA(), id, { name: "Proposed name" });
    const r = await list(ownerA());
    assert.equal(r.body.data[0].pendingRevision.changes.name, "Proposed name");
  });
});

// ============================================
// Delete
// ============================================

describe("DELETE /agency/visas/:id", () => {
  test("deletes a draft", async () => {
    const id = seedVisa("v1");
    const r = await remove(ownerA(), id);
    assert.equal(r.status, 200);
    assert.equal(store.has(visaPath(id)), false);
  });

  test("409 for pending_review, approved and rejected-after-submit visas", async () => {
    seedVisa("p", { reviewStatus: "pending_review", submittedAt: T0 });
    seedVisa("a", { reviewStatus: "approved", isActive: true, submittedAt: T0 });
    seedVisa("r", { reviewStatus: "rejected", rejectionReason: "x", submittedAt: T0 });
    for (const id of ["p", "a", "r"]) {
      const r = await remove(ownerA(), id);
      assert.equal(r.status, 409, id);
      assert.equal(r.body.error, "NOT_A_DRAFT");
      assert.equal(store.has(visaPath(id)), true);
    }
  });
});

// ============================================
// Roles
// ============================================

describe("roles", () => {
  test("agent without agency, client and admin get 403 on every endpoint", async () => {
    const id = seedVisa("v1");
    for (const who of [agentNoAgency(), client(), admin()]) {
      for (const r of [
        await list(who),
        await get(who, id),
        await create(who, validBody()),
        await update(who, id, { name: "x" }),
        await submit(who, id),
        await remove(who, id),
      ]) {
        assert.equal(r.status, 403, who.authz.role);
      }
    }
    assert.equal(writes.length, 0);
  });

  test("a client whose token somehow carries an agencyId still gets 403 (no Visa grant)", async () => {
    const who = principal("uid-c", ROLES.CLIENT, AGENCY_A);
    assert.equal((await list(who)).status, 403);
    assert.equal((await create(who, validBody())).status, 403);
  });

  describe("unauthenticated (real router over HTTP)", () => {
    let server: http.Server;
    let base: string;

    before(async () => {
      const { agencyVisaRoutes } = await import("../../src/agency-visas");
      const app = express();
      app.use(express.json());
      app.use("/agency/visas", agencyVisaRoutes);
      server = app.listen(0, "127.0.0.1");
      await new Promise<void>((resolve) => server.once("listening", () => resolve()));
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });
    after(() => {
      server.close();
    });

    test("every route answers 401 without a token", async () => {
      for (const [method, path] of [
        ["GET", "/agency/visas"],
        ["POST", "/agency/visas"],
        ["GET", "/agency/visas/x"],
        ["PUT", "/agency/visas/x"],
        ["PATCH", "/agency/visas/x"],
        ["POST", "/agency/visas/x/submit"],
        ["DELETE", "/agency/visas/x"],
      ]) {
        const r = await fetch(`${base}${path}`, { method, headers: { "content-type": "application/json" }, body: method === "GET" ? undefined : "{}" });
        assert.equal(r.status, 401, `${method} ${path}`);
      }
    });
  });
});

// ============================================
// Admin review list + public reads
// ============================================

describe("admin and public reads", () => {
  test("GET /admin/visas hides drafts but lists submitted agency visas", async () => {
    seedVisa("draft");
    seedVisa("pending", { reviewStatus: "pending_review", submittedAt: T0 });
    const r = await call(visaController.getAdminVisas.bind(visaController), admin());
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.data.map((v: any) => v.id), ["pending"]);
  });

  test("the admin review endpoint refuses a draft with 409 and writes nothing", async () => {
    const id = seedVisa("draft");
    const r = await call(visaController.reviewVisa.bind(visaController), admin(), {
      params: { id },
      body: { action: "approve", countryCode: CC },
    });
    assert.equal(r.status, 409);
    assert.equal(r.body.error, "VISA_IS_DRAFT");
    assert.equal(writes.length, 0);
  });

  test("draft, pending and rejected agency visas are in no public read", async () => {
    // Even with isActive forced true and visibility global, the review state hides them.
    seedVisa("draft", { isActive: true, visibility: "global" });
    seedVisa("pending", { reviewStatus: "pending_review", isActive: true, visibility: "global" });
    seedVisa("rejected", { reviewStatus: "rejected", isActive: true, visibility: "global" });
    const byCountry = await visaService.getVisaTypesByCountry(CC);
    const all = await visaService.getAllVisaTypes();
    const search = await visaService.searchVisaTypes("visa");
    const popular = await visaService.getPopularVisaTypes();
    for (const result of [byCountry, all.visaTypes, search, popular]) assert.deepEqual(result, []);
    const one = await call(visaController.getVisaType.bind(visaController), null, { params: { code: CC, visaId: "draft" } });
    assert.equal(one.status, 404);
  });
});
