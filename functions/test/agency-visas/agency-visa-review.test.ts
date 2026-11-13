// ============================================
// Unit tests — admin review of agency visas + make-global (issue #101)
// ============================================
//
// Run with `npm test`. Hermetic: NO network and NO emulator. Firestore refs
// in utils/firebase are swapped for the in-memory fake
// (test/helpers/fake-firestore.ts + fake-collection-group.ts), every
// transaction runner for the in-memory one, and notifyUser for a capturing
// stub (agencyVisaReviewService.notify). Controller handlers are called
// directly with a minimal req / res carrying a REAL CASL ability from
// @durin-tech/authz; one suite mounts the real admin router over HTTP for
// the 401s, and the verifyAdmin middleware is called directly for its 403.
//
// Covers:
//  - GET /admin/visas: agency rows carry agencyName (server lookup),
//    ownerAgencyId, createdBy, visibility, sponsor, pendingRevision; drafts
//    left out; scraped rows unchanged; `source` / `agencyId` filters; 400 on
//    a bad filter;
//  - review: approve with and without baseCostUsd (VISA_COST_MISSING),
//    approve keeps visibility "agency" (absent from public reads), reject
//    stores the reason, pending_review only (rejected -> 409), idempotent
//    re-approve (200, no write, no email), draft 409;
//  - revisions: approve applies ONLY content keys of `changes` and deletes
//    the revision; updatedAt re-check (409 REVISION_CHANGED, 400 missing);
//    reject keeps the live values + isActive; cost guard on the result;
//  - visibility: approved agency visas only (409 otherwise), 404, records
//    who/when, ownerAgencyId + source untouched, public reads + country
//    stats toggle, same value -> 200 no write no email;
//  - emails: owner gets approved / rejected (with reason) / made global, no
//    email on take-back; a failing email never fails or rolls back the
//    action, and is logged;
//  - authz: a client, an agent and the agency owner OF the visa get 403 on
//    all three admin handlers (CASL) and from verifyAdmin; 401 without token.

import { test, describe, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { Timestamp } from "firebase-admin/firestore";
import { ROLES, defineAbilitiesFor, subject } from "@durin-tech/authz";

import { clone, fakeCollection, fakeRunTransaction, installFakes, resetStore, store, writes } from "../helpers/fake-firestore";
import type { Data } from "../helpers/fake-firestore";
import { fakeCollectionGroup } from "../helpers/fake-collection-group";
import { visaController } from "../../src/controllers/visa.controller";
import { visaService } from "../../src/services/visa.service";
import { agencyVisaService } from "../../src/agency-visas/agency-visa.service";
import {
  agencyVisaReviewService,
  applyRevision,
  parseExpectedTimestamp,
  revisionUpdate,
} from "../../src/agency-visas/agency-visa-review.service";
import { verifyAdmin } from "../../src/middleware/auth";
import type { NotifyUserInput } from "../../src/services/notification.service";
import type { VisaType } from "../../src/types";

/* eslint-disable @typescript-eslint/no-explicit-any */

// ============================================
// Fixtures
// ============================================

/** Country of every visa here. */
const CC = "GB";
/** Fixed timestamps for seeded docs. */
const T0 = Timestamp.fromMillis(1_700_000_000_000);
const T1 = Timestamp.fromMillis(1_700_000_500_000);
/** The clock the services use in these tests. */
const NOW = Timestamp.fromMillis(1_700_001_000_000);
const AGENCY_A = "agency-a";
const AGENCY_B = "agency-b";
/** Agency A's owner (the email recipient). */
const OWNER_A_UID = "uid-owner-a";

/** Store path of a visa doc. */
const visaPath = (id: string) => `countries/${CC}/visaTypes/${id}`;
/** Store path of a revision doc. */
const revPath = (id: string) => `visaRevisions/${CC}__${id}`;

/** A stored agency visa doc for agency A, submitted for review by default. */
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
    sponsor: { organisationName: "Acme Ltd", sponsorLicenceNumber: "ABC12345" },
    agentIds: [],
    source: "agency",
    ownerAgencyId: AGENCY_A,
    createdBy: OWNER_A_UID,
    visibility: "agency",
    reviewStatus: "pending_review",
    isActive: false,
    submittedAt: T0,
    submittedBy: OWNER_A_UID,
    createdAt: T0,
    updatedAt: T0,
    ...over,
  };
}

/** A stored scraped visa (approved + live + global by omission). */
function scrapedDoc(id: string, over: Data = {}): Data {
  return {
    id,
    countryCode: CC,
    name: `Scraped ${id}`,
    code: id.toUpperCase(),
    description: "scraped visa",
    category: "student",
    processingTime: "3 weeks",
    processingDaysMin: 10,
    processingDaysMax: 20,
    baseCostUsd: 500,
    validityPeriod: "1 year",
    isExtendable: false,
    eligibilityCriteria: [],
    agentIds: [],
    source: "scraped",
    reviewStatus: "approved",
    isActive: true,
    createdAt: T1,
    updatedAt: T1,
    ...over,
  };
}

/** Seed one agency visa; returns its id. */
function seedVisa(id: string, over: Data = {}): string {
  store.set(visaPath(id), agencyDoc(id, over));
  return id;
}

/** Seed an approved, live agency visa with a pending revision. */
function seedApprovedWithRevision(id: string, changes: Data, visaOver: Data = {}): string {
  seedVisa(id, { reviewStatus: "approved", isActive: true, reviewedBy: "uid-admin", reviewedAt: T0, ...visaOver });
  store.set(revPath(id), {
    id: `${CC}__${id}`,
    visaId: id,
    countryCode: CC,
    ownerAgencyId: AGENCY_A,
    changes,
    reviewStatus: "pending_review",
    submittedBy: OWNER_A_UID,
    submittedAt: T1,
    createdAt: T1,
    updatedAt: T1,
  });
  return id;
}

/** Seed GB, both agencies and their owners (Resend test addresses). */
function seedBase(): void {
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
  store.set(`agencies/${AGENCY_A}`, { id: AGENCY_A, name: "Acme Visas", ownerId: OWNER_A_UID, ownerName: "Ada" });
  store.set(`agencies/${AGENCY_B}`, { id: AGENCY_B, name: "Beta Travel", ownerId: "uid-owner-b", ownerName: "Bo" });
  store.set(`users/${OWNER_A_UID}`, { id: OWNER_A_UID, email: "delivered+owner-a@resend.dev" });
  store.set("users/uid-owner-b", { id: "uid-owner-b", email: "delivered+owner-b@resend.dev" });
}

// ============================================
// Principals (real CASL abilities)
// ============================================

/** What verifyAuth puts on the request. */
interface Principal {
  userId: string;
  user: { uid: string };
  authz: { uid: string; role: string; agencyId: string | null };
  ability: unknown;
}

/** Build a principal for a role + agency. */
function principal(uid: string, role: (typeof ROLES)[keyof typeof ROLES], agencyId: string | null): Principal {
  const authz = { uid, role, agencyId };
  return { userId: uid, user: { uid }, authz, ability: defineAbilitiesFor(authz as any) };
}

const admin = () => principal("uid-admin", ROLES.ADMIN, null);
/** The owner of the agency that OWNS the visas seeded here. */
const ownerA = () => principal(OWNER_A_UID, ROLES.OWNER, AGENCY_A);
const agentA = () => principal("uid-agent-a", ROLES.AGENT, AGENCY_A);
const client = () => principal("uid-client", ROLES.CLIENT, null);

// ============================================
// Minimal Express req / res
// ============================================

/** Captured response of one handler call. */
interface Captured {
  status: number;
  body: any;
}

/** Call a handler as `who`; return status + body. */
async function call(
  handler: (req: any, res: any) => Promise<void>,
  who: Principal | null,
  req: { params?: Data; query?: Data; body?: unknown } = {}
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

/** Handler shorthands. */
const V = visaController;
const list = (who: Principal, query: Data = {}) => call(V.getAdminVisas.bind(V), who, { query });
// Issue #120: these suites test the review logic, not screening, so they approve
// with `acknowledgeScreening: true` (a visa with no screening result is "open").
// The screening gate itself is tested in agency-visa-screening.test.ts.
const review = (who: Principal, id: string, body: Data) =>
  call(V.reviewVisa.bind(V), who, { params: { id }, body: { countryCode: CC, acknowledgeScreening: true, ...body } });
const setVisibility = (who: Principal, id: string, visibility: unknown) =>
  call(V.setVisibility.bind(V), who, { params: { id }, body: { countryCode: CC, visibility } });

/** Every public read, as ids. */
async function publicIds(): Promise<{ byCountry: string[]; all: string[]; search: string[]; popular: string[] }> {
  const ids = (vs: VisaType[]) => vs.map((v) => v.id).sort();
  return {
    byCountry: ids(await visaService.getVisaTypesByCountry(CC)),
    all: ids((await visaService.getAllVisaTypes()).visaTypes),
    search: ids(await visaService.searchVisaTypes("visa")),
    popular: ids(await visaService.getPopularVisaTypes()),
  };
}

// ============================================
// Setup
// ============================================

/** notifyUser calls captured by the stub. */
const emails: NotifyUserInput[] = [];
/** When set, the stub rejects (simulates a Resend / notifyUser failure). */
let failEmail: Error | null = null;

before(async () => {
  await installFakes();
  const firebase: any = await import("../../src/utils/firebase");
  firebase.collections.visaRevisions = fakeCollection("visaRevisions");
  firebase.collections.agencies = fakeCollection("agencies");
  firebase.collectionGroups.visaTypes = () => fakeCollectionGroup("visaTypes");
  agencyVisaService.runTransaction = fakeRunTransaction;
  agencyVisaReviewService.runTransaction = fakeRunTransaction;
  agencyVisaReviewService.now = () => NOW;
  agencyVisaReviewService.notify = async (input) => {
    if (failEmail) throw failEmail;
    emails.push(input);
  };
});

beforeEach(() => {
  resetStore();
  seedBase();
  emails.length = 0;
  failEmail = null;
});

// ============================================
// Pure helpers
// ============================================

describe("pure helpers", () => {
  test("parseExpectedTimestamp accepts ISO, millis and serialised Timestamps", () => {
    assert.equal(parseExpectedTimestamp(new Date(1_700_000_500_000).toISOString()), 1_700_000_500_000);
    assert.equal(parseExpectedTimestamp(1_700_000_500_000), 1_700_000_500_000);
    assert.equal(parseExpectedTimestamp({ _seconds: 1_700_000_500, _nanoseconds: 0 }), 1_700_000_500_000);
    assert.equal(parseExpectedTimestamp({ seconds: 1_700_000_500, nanoseconds: 2_000_000 }), 1_700_000_500_002);
    assert.equal(parseExpectedTimestamp("not a date"), null);
    assert.equal(parseExpectedTimestamp(undefined), null);
  });

  test("revisionUpdate / applyRevision take only content keys (never review, visibility, ownership, countryCode)", () => {
    const changes = {
      name: "New",
      baseCostUsd: null,
      reviewStatus: "approved",
      visibility: "global",
      ownerAgencyId: "agency-b",
      source: "scraped",
      isActive: true,
      countryCode: "US",
    };
    const update = revisionUpdate(changes);
    assert.deepEqual(Object.keys(update).sort(), ["baseCostUsd", "name"]);
    const applied = applyRevision(agencyDoc("x") as unknown as VisaType, changes);
    assert.equal(applied.name, "New");
    assert.equal(applied.baseCostUsd, undefined);
    assert.equal(applied.visibility, "agency");
    assert.equal(applied.ownerAgencyId, AGENCY_A);
    assert.equal(applied.countryCode, CC);
  });
});

// ============================================
// GET /admin/visas
// ============================================

describe("GET /admin/visas", () => {
  test("lists submitted agency visas with agency name, ownership, sponsor and revision; drafts left out", async () => {
    seedVisa("draft", { reviewStatus: "draft", submittedAt: undefined });
    seedVisa("pending");
    seedVisa("b-visa", { ownerAgencyId: AGENCY_B, createdBy: "uid-owner-b", reviewStatus: "rejected", rejectionReason: "x" });
    seedApprovedWithRevision("live", { name: "Renamed" });
    store.set(visaPath("scraped"), scrapedDoc("scraped"));

    const r = await list(admin());
    assert.equal(r.status, 200);
    const byId = new Map<string, any>(r.body.data.map((v: any) => [v.id, v]));
    assert.deepEqual([...byId.keys()].sort(), ["b-visa", "live", "pending", "scraped"]);

    const pending = byId.get("pending");
    assert.equal(pending.agencyName, "Acme Visas");
    assert.equal(pending.ownerAgencyId, AGENCY_A);
    assert.equal(pending.createdBy, OWNER_A_UID);
    assert.equal(pending.visibility, "agency");
    assert.deepEqual(pending.sponsor, { organisationName: "Acme Ltd", sponsorLicenceNumber: "ABC12345" });
    assert.equal(pending.pendingRevision, null);
    assert.equal(byId.get("b-visa").agencyName, "Beta Travel");
    assert.deepEqual(byId.get("live").pendingRevision.changes, { name: "Renamed" });

    // Scraped rows are exactly as before #101: no added keys.
    const scraped = byId.get("scraped");
    assert.equal("agencyName" in scraped, false);
    assert.equal("pendingRevision" in scraped, false);
    assert.equal(scraped.countryName, "United Kingdom");
  });

  test("the agency name comes from agencies/{id}, never from the visa doc", async () => {
    seedVisa("spoof", { agencyName: "Spoofed Name" });
    const r = await list(admin());
    assert.equal(r.body.data[0].agencyName, "Acme Visas");
  });

  test("filters: source=agency, source=scraped, agencyId", async () => {
    seedVisa("a1");
    seedVisa("b1", { ownerAgencyId: AGENCY_B });
    store.set(visaPath("scraped"), scrapedDoc("scraped"));
    store.set(visaPath("seed"), scrapedDoc("seed", { source: undefined, reviewStatus: undefined }));

    const ids = (r: Captured) => r.body.data.map((v: any) => v.id).sort();
    assert.deepEqual(ids(await list(admin())), ["a1", "b1", "scraped", "seed"]);
    assert.deepEqual(ids(await list(admin(), { source: "agency" })), ["a1", "b1"]);
    assert.deepEqual(ids(await list(admin(), { source: "scraped" })), ["scraped"]);
    assert.deepEqual(ids(await list(admin(), { agencyId: AGENCY_B })), ["b1"]);
    assert.deepEqual(ids(await list(admin(), { agencyId: AGENCY_B, source: "scraped" })), []);
  });

  test("a bad filter value is a 400", async () => {
    assert.equal((await list(admin(), { source: "agent" })).status, 400);
    assert.equal((await list(admin(), { agencyId: "__x__" })).status, 400);
  });
});

// ============================================
// PATCH /admin/visas/:id/review (agency visas)
// ============================================

describe("review of an agency visa", () => {
  test("approve: approved + active, visibility stays agency, absent from public reads, owner emailed", async () => {
    const id = seedVisa("v1");
    const r = await review(admin(), id, { action: "approve" });
    assert.equal(r.status, 200);
    assert.equal(r.body.data.reviewOutcome, "approved");

    const stored = store.get(visaPath(id))!;
    assert.equal(stored.reviewStatus, "approved");
    assert.equal(stored.isActive, true);
    assert.equal(stored.visibility, "agency");
    assert.equal(stored.reviewedBy, "uid-admin");
    assert.deepEqual(stored.reviewedAt, NOW);

    const pub = await publicIds();
    assert.deepEqual(pub, { byCountry: [], all: [], search: [], popular: [] });

    assert.equal(emails.length, 1);
    assert.equal(emails[0].userId, OWNER_A_UID);
    assert.equal(emails[0].type, "agency_visa_approved");
    assert.match(emails[0].title, /Visa v1/);
  });

  test("approve without a finite baseCostUsd: 409 VISA_COST_MISSING, nothing written, no email", async () => {
    const id = seedVisa("nocost", { baseCostUsd: undefined });
    const before = clone(store.get(visaPath(id)));
    const r = await review(admin(), id, { action: "approve" });
    assert.equal(r.status, 409);
    assert.equal(r.body.error, "VISA_COST_MISSING");
    assert.match(r.body.message, /government fee/);
    assert.deepEqual(store.get(visaPath(id)), before);
    assert.equal(writes.length, 0);
    assert.equal(emails.length, 0);
  });

  test("reject stores the reason, keeps the visa inactive, emails the reason; agency can then resubmit", async () => {
    const id = seedVisa("v2");
    const r = await review(admin(), id, { action: "reject", reason: "Sponsor licence number not found" });
    assert.equal(r.status, 200);
    const stored = store.get(visaPath(id))!;
    assert.equal(stored.reviewStatus, "rejected");
    assert.equal(stored.rejectionReason, "Sponsor licence number not found");
    assert.equal(stored.isActive, false);

    assert.equal(emails.length, 1);
    assert.equal(emails[0].type, "agency_visa_rejected");
    assert.match(emails[0].body, /Sponsor licence number not found/);

    // #100: a rejected visa can be resubmitted.
    const resubmitted = await agencyVisaService.submit(id, { agencyId: AGENCY_A, uid: OWNER_A_UID }, () => true);
    assert.equal(resubmitted.reviewStatus, "pending_review");
  });

  test("only from pending_review: a rejected (edited, not resubmitted) visa can't be approved or rejected", async () => {
    const id = seedVisa("rej", { reviewStatus: "rejected", rejectionReason: "old" });
    for (const body of [{ action: "approve" }, { action: "reject", reason: "again" }]) {
      const r = await review(admin(), id, body);
      assert.equal(r.status, 409);
      assert.equal(r.body.error, "VISA_NOT_IN_REVIEW");
    }
    assert.equal(writes.length, 0);
    assert.equal(emails.length, 0);
  });

  test("an approved visa with no revision: re-approve is 200 with no write and no email; reject is 409", async () => {
    const id = seedVisa("ok", { reviewStatus: "approved", isActive: true });
    const before = clone(store.get(visaPath(id)));
    const r = await review(admin(), id, { action: "approve" });
    assert.equal(r.status, 200);
    assert.equal(r.body.data.reviewOutcome, "unchanged");
    assert.deepEqual(store.get(visaPath(id)), before);
    assert.equal(writes.length, 0);
    assert.equal(emails.length, 0);
    assert.equal((await review(admin(), id, { action: "reject", reason: "x" })).status, 409);
  });

  test("a draft is still 409 VISA_IS_DRAFT", async () => {
    const id = seedVisa("d", { reviewStatus: "draft" });
    const r = await review(admin(), id, { action: "approve" });
    assert.equal(r.status, 409);
    assert.equal(r.body.error, "VISA_IS_DRAFT");
  });

  test("unknown id: 404", async () => {
    const r = await review(admin(), "nope", { action: "approve" });
    assert.equal(r.status, 404);
  });

  test("a failing email never fails or rolls back the review, and is logged", async () => {
    const id = seedVisa("mailfail");
    failEmail = new Error("Resend is down");
    const logged: unknown[][] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => void logged.push(args);
    try {
      const r = await review(admin(), id, { action: "approve" });
      assert.equal(r.status, 200);
    } finally {
      console.error = original;
    }
    assert.equal(store.get(visaPath(id))!.reviewStatus, "approved");
    assert.ok(logged.some((args) => String(args[0]).includes("approved email failed")));
  });
});

// ============================================
// Revisions of approved visas
// ============================================

describe("review of a pending revision", () => {
  /** What the admin loaded: the revision's updatedAt, as JSON serialises it. */
  const loaded = { _seconds: T1.seconds, _nanoseconds: T1.nanoseconds };

  test("approve applies ONLY the content keys of changes, deletes the revision, live stays approved + agency", async () => {
    const id = seedApprovedWithRevision("r1", {
      name: "Renamed route",
      baseCostUsd: 250,
      applicationUrl: null,
      // Smuggled non-content keys must never reach the live doc.
      visibility: "global",
      reviewStatus: "rejected",
      ownerAgencyId: AGENCY_B,
    }, { applicationUrl: "https://example.org/apply" });
    const r = await review(admin(), id, { action: "approve", revisionUpdatedAt: loaded });
    assert.equal(r.status, 200);
    assert.equal(r.body.data.reviewOutcome, "revision_approved");

    const live = store.get(visaPath(id))!;
    assert.equal(live.name, "Renamed route");
    assert.equal(live.baseCostUsd, 250);
    assert.equal("applicationUrl" in live, false);
    assert.equal(live.visibility, "agency");
    assert.equal(live.reviewStatus, "approved");
    assert.equal(live.ownerAgencyId, AGENCY_A);
    assert.equal(live.isActive, true);
    assert.equal(store.has(revPath(id)), false);

    assert.equal(emails.length, 1);
    assert.equal(emails[0].type, "agency_visa_approved");
    assert.match(emails[0].title, /changes to Renamed route/);
  });

  test("an ISO updatedAt works too", async () => {
    const id = seedApprovedWithRevision("r2", { name: "N" });
    const r = await review(admin(), id, { action: "approve", revisionUpdatedAt: T1.toDate().toISOString() });
    assert.equal(r.status, 200);
  });

  test("the agency edited it since the admin loaded it: 409 REVISION_CHANGED, nothing written", async () => {
    const id = seedApprovedWithRevision("r3", { name: "N" });
    const stale = { _seconds: T0.seconds, _nanoseconds: 0 };
    for (const action of ["approve", "reject"]) {
      const r = await review(admin(), id, { action, reason: "x", revisionUpdatedAt: stale });
      assert.equal(r.status, 409);
      assert.equal(r.body.error, "REVISION_CHANGED");
    }
    assert.equal(writes.length, 0);
    assert.equal(emails.length, 0);
  });

  test("revisionUpdatedAt missing: 400; unparseable: 400", async () => {
    const id = seedApprovedWithRevision("r4", { name: "N" });
    assert.equal((await review(admin(), id, { action: "approve" })).status, 400);
    assert.equal((await review(admin(), id, { action: "approve", revisionUpdatedAt: "nope" })).status, 400);
    assert.equal(writes.length, 0);
  });

  test("approve of a revision that removes baseCostUsd: 409 VISA_COST_MISSING", async () => {
    const id = seedApprovedWithRevision("r5", { baseCostUsd: null });
    const r = await review(admin(), id, { action: "approve", revisionUpdatedAt: loaded });
    assert.equal(r.status, 409);
    assert.equal(r.body.error, "VISA_COST_MISSING");
    assert.equal(writes.length, 0);
  });

  test("reject discards it: revision rejected with reason, live values + isActive kept, email has the reason", async () => {
    const id = seedApprovedWithRevision("r6", { name: "N" });
    const before = clone(store.get(visaPath(id)));
    const r = await review(admin(), id, { action: "reject", reason: "Name must match the CoS", revisionUpdatedAt: loaded });
    assert.equal(r.status, 200);
    assert.equal(r.body.data.reviewOutcome, "revision_rejected");
    assert.deepEqual(store.get(visaPath(id)), before);
    assert.equal(store.get(visaPath(id))!.isActive, true);
    const rev = store.get(revPath(id))!;
    assert.equal(rev.reviewStatus, "rejected");
    assert.equal(rev.rejectionReason, "Name must match the CoS");
    assert.equal(rev.reviewedBy, "uid-admin");
    assert.equal(emails[0].type, "agency_visa_rejected");
    assert.match(emails[0].body, /Name must match the CoS/);

    // A rejected revision is no longer reviewable until the agency edits it.
    const again = await review(admin(), id, { action: "approve", revisionUpdatedAt: loaded });
    assert.equal(again.body.data.reviewOutcome, "unchanged");
    assert.equal(store.get(visaPath(id))!.name, before!.name);
  });
});

// ============================================
// PATCH /admin/visas/:id/visibility
// ============================================

describe("make global / agency-only", () => {
  test("make global then take back: public reads + country stats toggle; who/when recorded; tag kept", async () => {
    const id = seedVisa("g1", { reviewStatus: "approved", isActive: true });

    const g = await setVisibility(admin(), id, "global");
    assert.equal(g.status, 200);
    assert.equal(g.body.data.visibilityOutcome, "made_global");
    let stored = store.get(visaPath(id))!;
    assert.equal(stored.visibility, "global");
    assert.equal(stored.madeGlobalBy, "uid-admin");
    assert.deepEqual(stored.madeGlobalAt, NOW);
    assert.equal(stored.ownerAgencyId, AGENCY_A);
    assert.equal(stored.source, "agency");
    assert.deepEqual(await publicIds(), { byCountry: [id], all: [id], search: [id], popular: [id] });
    assert.equal(store.get(`countries/${CC}`)!.visaTypesCount, 1);
    assert.equal(store.get(`countries/${CC}`)!.minCostUsd, 100);
    assert.equal(emails.length, 1);
    assert.equal(emails[0].type, "agency_visa_made_global");
    assert.equal(emails[0].userId, OWNER_A_UID);

    const a = await setVisibility(admin(), id, "agency");
    assert.equal(a.status, 200);
    assert.equal(a.body.data.visibilityOutcome, "made_agency_only");
    stored = store.get(visaPath(id))!;
    assert.equal(stored.visibility, "agency");
    assert.equal(stored.madeAgencyOnlyBy, "uid-admin");
    assert.deepEqual(stored.madeAgencyOnlyAt, NOW);
    assert.equal(stored.madeGlobalBy, "uid-admin"); // history kept
    assert.equal(stored.ownerAgencyId, AGENCY_A);
    assert.equal(stored.source, "agency");
    assert.deepEqual(await publicIds(), { byCountry: [], all: [], search: [], popular: [] });
    assert.equal(store.get(`countries/${CC}`)!.visaTypesCount, 0);
    assert.equal(emails.length, 1); // no email on take-back

    // The owning agency still sees it either way.
    const own = await agencyVisaService.list(AGENCY_A, () => true);
    assert.deepEqual(own.map((v) => v.id), [id]);
  });

  test("same visibility again: 200 unchanged, nothing written, no duplicate email", async () => {
    const id = seedVisa("g2", { reviewStatus: "approved", isActive: true });
    await setVisibility(admin(), id, "global");
    writes.length = 0;
    const r = await setVisibility(admin(), id, "global");
    assert.equal(r.status, 200);
    assert.equal(r.body.data.visibilityOutcome, "unchanged");
    assert.equal(writes.length, 0);
    assert.equal(emails.length, 1);
    // Already agency-only + "agency": unchanged too.
    const id2 = seedVisa("g3", { reviewStatus: "approved", isActive: true });
    assert.equal((await setVisibility(admin(), id2, "agency")).body.data.visibilityOutcome, "unchanged");
  });

  test("only approved agency visas: pending / rejected / draft 409 VISA_NOT_APPROVED; scraped 409; unknown 404; bad body 400", async () => {
    for (const status of ["pending_review", "rejected", "draft"]) {
      const id = seedVisa(`s-${status}`, { reviewStatus: status });
      const r = await setVisibility(admin(), id, "global");
      assert.equal(r.status, 409, status);
      assert.equal(r.body.error, "VISA_NOT_APPROVED");
    }
    store.set(visaPath("scraped"), scrapedDoc("scraped"));
    const s = await setVisibility(admin(), "scraped", "agency");
    assert.equal(s.status, 409);
    assert.equal(s.body.error, "NOT_AN_AGENCY_VISA");
    assert.equal((await setVisibility(admin(), "nope", "global")).status, 404);
    assert.equal((await setVisibility(admin(), "x", "public")).status, 400);
    assert.equal(writes.length, 0);
  });

  test("a failing make-global email does not roll back the change", async () => {
    const id = seedVisa("g4", { reviewStatus: "approved", isActive: true });
    failEmail = new Error("boom");
    const original = console.error;
    console.error = () => undefined;
    try {
      assert.equal((await setVisibility(admin(), id, "global")).status, 200);
    } finally {
      console.error = original;
    }
    assert.equal(store.get(visaPath(id))!.visibility, "global");
  });
});

// ============================================
// Authorization
// ============================================

describe("authorization", () => {
  test("client, agent and the agency owner OF the visa get 403 on all three admin handlers; nothing written", async () => {
    const pending = seedVisa("p");
    const approved = seedVisa("a", { reviewStatus: "approved", isActive: true });
    for (const who of [client(), agentA(), ownerA()]) {
      assert.equal((await list(who)).status, 403, `list ${who.authz.role}`);
      assert.equal((await review(who, pending, { action: "approve" })).status, 403, `review ${who.authz.role}`);
      assert.equal((await setVisibility(who, approved, "global")).status, 403, `visibility ${who.authz.role}`);
    }
    assert.equal(writes.length, 0);
    assert.equal(emails.length, 0);
  });

  test("the owner's ability is refused on the real doc too (field-level), not only by the probe", async () => {
    const id = seedVisa("p2");
    const who = ownerA();
    await assert.rejects(
      agencyVisaReviewService.review(
        { countryCode: CC, visaId: id, action: "approve", reviewedBy: who.userId },
        (doc, field) => (who.ability as any).can("update", subject("Visa", { ...doc }), field)
      ),
      (e: any) => e.httpStatus === 403
    );
    assert.equal(writes.length, 0);
  });

  test("verifyAdmin answers 403 for the agency owner and 401 without a user", async () => {
    const run = async (req: any) => {
      const out: Captured = { status: 0, body: undefined };
      let nextCalled = false;
      const res = {
        status(c: number) {
          out.status = c;
          return res;
        },
        json(b: unknown) {
          out.body = b;
          return res;
        },
      };
      await verifyAdmin(req, res as any, () => {
        nextCalled = true;
      });
      return { ...out, nextCalled };
    };
    const owner = ownerA();
    assert.equal((await run({ user: owner.user, authz: owner.authz })).status, 403);
    assert.equal((await run({})).status, 401);
    const ok = await run({ user: { uid: "uid-admin" }, authz: admin().authz });
    assert.equal(ok.nextCalled, true);
  });

  describe("unauthenticated (real admin router over HTTP)", () => {
    let server: http.Server;
    let base: string;

    before(async () => {
      const { adminVisaRoutes } = await import("../../src/routes/visa.routes");
      const app = express();
      app.use(express.json());
      app.use("/admin/visas", adminVisaRoutes);
      server = app.listen(0, "127.0.0.1");
      await new Promise<void>((resolve) => server.once("listening", () => resolve()));
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });
    after(() => {
      server.close();
    });

    test("GET /, PATCH /:id/review and PATCH /:id/visibility answer 401 without a token", async () => {
      for (const [method, path] of [
        ["GET", "/admin/visas"],
        ["PATCH", "/admin/visas/x/review"],
        ["PATCH", "/admin/visas/x/visibility"],
      ]) {
        const r = await fetch(`${base}${path}`, {
          method,
          headers: { "content-type": "application/json" },
          body: method === "GET" ? undefined : "{}",
        });
        assert.equal(r.status, 401, `${method} ${path}`);
      }
    });
  });
});
