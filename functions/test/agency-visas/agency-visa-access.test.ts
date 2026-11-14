// ============================================
// Unit tests — agency visas reachable through the agency (issue #102)
// ============================================
//
// Run with `npm test`. Hermetic: NO network and NO emulator. Firestore refs
// in utils/firebase are swapped for the in-memory fake
// (test/helpers/fake-firestore.ts + fake-collection-group.ts), and the
// controller handlers are called directly with a minimal req / res carrying a
// REAL CASL ability from @durin-tech/authz (defineAbilitiesFor), the same
// way verifyAuth / optionalAuth would set it.
//
// Cast: agencies A ("acme") and B ("bravo"), plus C (approved, no visas) and
// a suspended agency D. Callers: owner + agent of A, owner + agent of B, an
// applicant with a case at A, an applicant with no case, an admin and an
// anonymous caller. Test emails use `delivered+<name>@resend.dev`.
//
// Covers:
//  - pure rules: canStartCaseOnVisa, isApprovedAgencyVisa, applicant-safe
//    projection (sponsor licence number + contact never survive);
//  - public agency page: only the agency's own approved + active visas (and
//    its priced global ones), applicant-safe fields only, `[]` when none,
//    unknown slug and unapproved agency 404;
//  - visa detail, /full and /requirements for every caller (404 body equal to
//    an unknown id's), existing cases keep loading after "agency-only again";
//  - case start (POST /applications and /applications/for-client): owning
//    agency only; non-approved / inactive never; nothing written on refusal
//    (and for-client provisions nobody);
//  - the public lists still leave agency-only visas out (#99).

import { test, describe, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Timestamp } from "firebase-admin/firestore";
import { ROLES, defineAbilitiesFor } from "@durin-tech/authz";

import { fakeCollection, installFakes, resetStore, store, writes } from "../helpers/fake-firestore";
import type { Data } from "../helpers/fake-firestore";
import { fakeCollectionGroup } from "../helpers/fake-collection-group";
import {
  APPLICANT_SAFE_VISA_FIELDS,
  canStartCaseOnVisa,
  isApprovedAgencyVisa,
  toApplicantSafeVisa,
} from "../../src/agency-visas/agency-visa-access";
import { visaController } from "../../src/controllers/visa.controller";
import { agencyController } from "../../src/controllers/agency.controller";
import { applicationController } from "../../src/controllers/application.controller";
import { userService } from "../../src/services/user.service";
import { messagingService } from "../../src/services/messaging.service";
import { notificationService } from "../../src/services/notification.service";
import type { VisaType } from "../../src/types";

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
const AGENCY_C = "agency-c";
const AGENCY_D = "agency-d";

/** The private sponsor values: they must never appear in an applicant response. */
const LICENCE = "LIC-SECRET-123";
const CONTACT = "delivered+sponsor@resend.dev";

/** Store path of a visa doc. */
const visaPath = (id: string) => `countries/${CC}/visaTypes/${id}`;

/** A global seed visa (no visibility / reviewStatus: public). */
function seedGlobal(id: string, over: Data = {}): string {
  store.set(visaPath(id), {
    id,
    countryCode: CC,
    name: `Global ${id}`,
    code: id.toUpperCase(),
    description: "seed",
    category: "work",
    processingTime: "3 weeks",
    processingDaysMin: 15,
    processingDaysMax: 21,
    baseCostUsd: 719,
    validityPeriod: "5 years",
    isExtendable: true,
    eligibilityCriteria: ["A job offer"],
    agentIds: [],
    isActive: true,
    createdAt: T0,
    updatedAt: T0,
    ...over,
  });
  return id;
}

/** An agency visa of `agencyId` (approved + active + agency-only by default). */
function seedAgencyVisa(id: string, agencyId = AGENCY_A, over: Data = {}): string {
  seedGlobal(id, {
    name: `Agency ${id}`,
    source: "agency",
    ownerAgencyId: agencyId,
    createdBy: `uid-owner-${agencyId}`,
    submittedBy: `uid-owner-${agencyId}`,
    reviewedBy: "uid-admin",
    reviewedAt: T0,
    visibility: "agency",
    reviewStatus: "approved",
    isActive: true,
    applicationUrl: "https://acme.example.org/apply",
    sponsor: {
      organisationName: "Acme Ltd",
      website: "https://acme.example.org",
      sponsorLicenceNumber: LICENCE,
      contact: CONTACT,
    },
    ...over,
  });
  return id;
}

/** Countries, agencies, agent docs, users and the visa set used by every test. */
function seedBase(): void {
  store.set(`countries/${CC}`, { code: CC, name: "United Kingdom", isSupported: true, createdAt: T0, updatedAt: T0 });
  // ---- Agencies: A, B, C approved; D suspended ----
  for (const [id, slug, status] of [
    [AGENCY_A, "acme", "approved"],
    [AGENCY_B, "bravo", "approved"],
    [AGENCY_C, "charlie", "approved"],
    [AGENCY_D, "delta", "suspended"],
  ]) {
    store.set(`agencies/${id}`, {
      id, slug, name: `Agency ${slug}`, ownerId: `uid-owner-${id}`, ownerName: "Owner",
      services: [], totalAgents: 1, totalCases: 0, activeCases: 0, status, createdAt: T0, updatedAt: T0,
    });
  }
  // ---- Agent docs (Application.agentId is the agent's USER uid) ----
  for (const [doc, uid, agencyId] of [
    ["agent-doc-owner-a", "uid-owner-a", AGENCY_A],
    ["agent-doc-a", "uid-agent-a", AGENCY_A],
    ["agent-doc-owner-b", "uid-owner-b", AGENCY_B],
    ["agent-doc-b", "uid-agent-b", AGENCY_B],
  ]) {
    store.set(`agents/${doc}`, { id: doc, userId: uid, agencyId });
  }
  // ---- Users (applicants) ----
  store.set("users/uid-app-a", { email: "delivered+applicant-a@resend.dev", firstName: "Ada", lastName: "A" });
  store.set("users/uid-app-none", { email: "delivered+applicant-none@resend.dev", firstName: "Nia", lastName: "N" });
  // ---- Visas ----
  seedGlobal("uk-sw");
  seedAgencyVisa("a-own");
  seedAgencyVisa("a-global", AGENCY_A, { visibility: "global" });
  seedAgencyVisa("a-draft", AGENCY_A, { reviewStatus: "draft", isActive: false });
  seedAgencyVisa("a-pending", AGENCY_A, { reviewStatus: "pending_review", isActive: false });
  seedAgencyVisa("a-rejected", AGENCY_A, { reviewStatus: "rejected", isActive: false });
  seedAgencyVisa("a-inactive", AGENCY_A, { isActive: false });
  seedAgencyVisa("b-own", AGENCY_B, { sponsor: { organisationName: "Bravo plc" } });
  // A hidden (pending) scraped visa, for the /requirements gate.
  seedGlobal("scraped-pending", { source: "scraped", reviewStatus: "pending_review", isActive: true });
  // Requirements on a public, an agency-only and a hidden visa.
  for (const id of ["uk-sw", "a-own", "scraped-pending"]) {
    store.set(`${visaPath(id)}/requirements/r1`, { title: `Req of ${id}`, orderIndex: 0, requiredDocuments: [] });
  }
  // ---- The applicant with a case at A (on the GLOBAL visa) ----
  store.set("applications/app-a", {
    id: "app-a", userId: "uid-app-a", visaTypeId: "uk-sw", countryCode: CC,
    mode: "agent", agentId: "uid-agent-a", agencyId: AGENCY_A, status: "draft",
  });
}

/** Writes to applications (must stay empty on a refused case start). */
const applicationWrites = () => writes.filter((w) => w.path.startsWith("applications/"));

// ============================================
// Principals (real CASL abilities)
// ============================================

/** What verifyAuth / optionalAuth put on the request. */
interface Principal {
  userId: string;
  authz: { uid: string; role: string; agencyId: string | null };
  ability: unknown;
  user: { uid: string; email?: string };
}

/** Build a principal for a role + agency. */
function principal(uid: string, role: (typeof ROLES)[keyof typeof ROLES], agencyId: string | null): Principal {
  const authz = { uid, role, agencyId };
  return { userId: uid, authz, ability: defineAbilitiesFor(authz as any), user: { uid } };
}

const ownerA = () => principal("uid-owner-a", ROLES.OWNER, AGENCY_A);
const agentA = () => principal("uid-agent-a", ROLES.AGENT, AGENCY_A);
const ownerB = () => principal("uid-owner-b", ROLES.OWNER, AGENCY_B);
const agentB = () => principal("uid-agent-b", ROLES.AGENT, AGENCY_B);
const applicantA = () => principal("uid-app-a", ROLES.CLIENT, null);
const applicantNone = () => principal("uid-app-none", ROLES.CLIENT, null);
const admin = () => principal("uid-admin", ROLES.ADMIN, null);

// ============================================
// Minimal Express req / res
// ============================================

/** Captured response of one handler call. */
interface Captured {
  status: number;
  body: any;
}

/** Call a handler as `who` (null = anonymous) with params / query / body. */
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

/** Bound handler shorthands. */
const V = visaController;
const detail = (who: Principal | null, id: string) =>
  call(V.getVisaType.bind(V), who, { params: { code: CC, visaId: id } });
const full = (who: Principal | null, id: string) =>
  call(V.getVisaTypeWithRequirements.bind(V), who, { params: { code: CC, visaId: id } });
const requirements = (who: Principal | null, id: string) =>
  call(V.getRequirements.bind(V), who, { params: { code: CC, visaId: id } });
const publicAgency = (slug: string) =>
  call(agencyController.getPublicAgency.bind(agencyController), null, { params: { slug } });
const A = applicationController;
const startSelf = (who: Principal, body: Data) => call(A.createApplication.bind(A), who, { body });
const startForClient = (who: Principal, body: Data) =>
  call(A.createApplicationForClient.bind(A), who, {
    body: { clientName: "Ada A", clientEmail: "delivered+applicant-a@resend.dev", countryCode: CC, ...body },
  });

/** The 404 body of an unknown visa id (every denial must match it). */
async function unknownBody(): Promise<unknown> {
  const r = await detail(null, "does-not-exist");
  assert.equal(r.status, 404);
  return r.body;
}

/** Assert no private agency field appears anywhere in a JSON response. */
function assertNoPrivateFields(body: unknown): void {
  const json = JSON.stringify(body);
  assert.ok(!json.includes(LICENCE), "sponsor licence number leaked");
  assert.ok(!json.includes(CONTACT), "sponsor contact leaked");
  for (const key of ["createdBy", "submittedBy", "reviewedBy", "reviewedAt", "agentIds", "sponsorLicenceNumber", "contact"]) {
    assert.ok(!json.includes(`"${key}"`), `${key} leaked`);
  }
}

// ============================================
// Setup
// ============================================

/** Calls to the client-provisioning lookup (must stay 0 on a refused for-client start). */
let userLookups = 0;

before(async () => {
  await installFakes();
  const firebase: any = await import("../../src/utils/firebase");
  firebase.collections.agencies = fakeCollection("agencies");
  firebase.collections.agents = fakeCollection("agents");
  firebase.collections.applications = fakeCollection("applications");
  firebase.collectionGroups.visaTypes = () => fakeCollectionGroup("visaTypes");
  firebase.subcollections.agencyVisaPrices = (agencyId: string) => fakeCollection(`agencies/${agencyId}/visaPrices`);
  firebase.subcollections.requirements = (cc: string, id: string) =>
    fakeCollection(`countries/${cc}/visaTypes/${id}/requirements`);
  firebase.subcollections.timeline = (id: string) => fakeCollection(`applications/${id}/timeline`);
  // ---- Side effects of POST /applications/for-client (not under test) ----
  const users: any = userService;
  users.getUserByEmail = async (email: string) => {
    userLookups++;
    return { id: "uid-app-a", email };
  };
  (messagingService as any).getOrCreateConversation = async () => ({ id: "conv-1" });
  (notificationService as any).notifyUser = async () => undefined;
});

beforeEach(() => {
  resetStore();
  seedBase();
  userLookups = 0;
});

// ============================================
// Pure rules
// ============================================

describe("pure rules", () => {
  /** The seeded doc of a visa, typed. */
  const visa = (id: string) => ({ ...store.get(visaPath(id)) }) as unknown as VisaType;

  test("isApprovedAgencyVisa: only approved + active agency visas with an owner", () => {
    assert.equal(isApprovedAgencyVisa(visa("a-own")), true);
    assert.equal(isApprovedAgencyVisa(visa("a-global")), true);
    for (const id of ["a-draft", "a-pending", "a-rejected", "a-inactive", "uk-sw"]) {
      assert.equal(isApprovedAgencyVisa(visa(id)), false, id);
    }
    assert.equal(isApprovedAgencyVisa({ ...visa("a-own"), ownerAgencyId: "" }), false);
  });

  test("canStartCaseOnVisa: public for anyone, agency-only for the owning agency's cases only", () => {
    // Public visas (seed, and an agency visa made global): any agency or none.
    for (const id of ["uk-sw", "a-global"]) {
      for (const agency of [undefined, AGENCY_A, AGENCY_B]) assert.equal(canStartCaseOnVisa(visa(id), agency), true);
    }
    // Agency-only: only A's cases.
    assert.equal(canStartCaseOnVisa(visa("a-own"), AGENCY_A), true);
    assert.equal(canStartCaseOnVisa(visa("a-own"), AGENCY_B), false);
    assert.equal(canStartCaseOnVisa(visa("a-own"), undefined), false);
    assert.equal(canStartCaseOnVisa(visa("a-own"), ""), false);
    // Not usable by anyone, owner included.
    for (const id of ["a-draft", "a-pending", "a-rejected", "a-inactive", "scraped-pending"]) {
      assert.equal(canStartCaseOnVisa(visa(id), AGENCY_A), false, id);
    }
    // A hidden agency-visibility visa with NO owner never matches a case with no agency.
    assert.equal(
      canStartCaseOnVisa({ ...visa("a-own"), ownerAgencyId: undefined } as VisaType, undefined),
      false
    );
  });

  test("toApplicantSafeVisa keeps only whitelisted fields and the public sponsor part", () => {
    const safe = toApplicantSafeVisa(visa("a-own")) as Data;
    assert.deepEqual(safe.sponsor, { organisationName: "Acme Ltd", website: "https://acme.example.org" });
    for (const key of Object.keys(safe)) {
      assert.ok(key === "sponsor" || (APPLICANT_SAFE_VISA_FIELDS as readonly string[]).includes(key), key);
    }
    assert.equal(safe.name, "Agency a-own");
    assert.equal(safe.applicationUrl, "https://acme.example.org/apply");
    assertNoPrivateFields(safe);
  });
});

// ============================================
// Public agency page
// ============================================

describe("public agency page (GET /agencies/public/:slug)", () => {
  test("A's page lists only A's approved, active visas, with applicant-safe fields", async () => {
    const r = await publicAgency("acme");
    assert.equal(r.status, 200);
    const list = r.body.data.visaPrices as Data[];
    // Own approved visas, newest first (same createdAt here: both present).
    assert.deepEqual(list.map((v) => v.visaTypeId).sort(), ["a-global", "a-own"]);
    for (const v of list) {
      assert.equal(v.isAgencyVisa, true);
      assert.equal(v.countryCode, CC);
    }
    const own = list.find((v) => v.visaTypeId === "a-own")!;
    assert.deepEqual(own, {
      visaTypeId: "a-own",
      countryCode: CC,
      visaName: "Agency a-own",
      category: "work",
      // Issue #179: dollar price + local figure; both null when unpriced.
      priceUsd: null,
      priceLocal: null,
      isAgencyVisa: true,
      visibility: "agency",
      visaCode: "A-OWN",
      description: "seed",
      processingTime: "3 weeks",
      processingDaysMin: 15,
      processingDaysMax: 21,
      validityPeriod: "5 years",
      isExtendable: true,
      maxExtensions: null,
      eligibilityCriteria: ["A job offer"],
      baseCostUsd: 719,
      applicationUrl: "https://acme.example.org/apply",
      applicationInstructions: null,
      sponsor: { organisationName: "Acme Ltd", website: "https://acme.example.org" },
    });
    // Never draft / pending / rejected / inactive, never another agency's.
    assertNoPrivateFields(r.body);
    assert.ok(!JSON.stringify(r.body).includes("b-own"));
    // The rest of the page is unchanged.
    assert.equal(r.body.data.name, "Agency acme");
    assert.equal(r.body.data.slug, "acme");
  });

  test("B's page lists only B's visa; C (no visas) gets []", async () => {
    const b = await publicAgency("bravo");
    assert.deepEqual((b.body.data.visaPrices as Data[]).map((v) => v.visaTypeId), ["b-own"]);
    assert.deepEqual(b.body.data.visaPrices[0].sponsor, { organisationName: "Bravo plc" });
    const c = await publicAgency("charlie");
    assert.equal(c.status, 200);
    assert.deepEqual(c.body.data.visaPrices, []);
    assert.equal(c.body.data.name, "Agency charlie");
  });

  test("a priced global visa is listed as not the agency's own", async () => {
    store.set(`agencies/${AGENCY_C}/visaPrices/${CC}__uk-sw`, {
      id: `${CC}__uk-sw`, agencyId: AGENCY_C, visaTypeId: "uk-sw", countryCode: CC, priceUsd: { amountMinor: 12500, currency: "USD" },
      updatedBy: "uid-owner-agency-c", createdAt: T0, updatedAt: T0,
    });
    const c = await publicAgency("charlie");
    assert.equal(c.body.data.visaPrices.length, 1);
    assert.equal(c.body.data.visaPrices[0].isAgencyVisa, false);
    assert.equal(c.body.data.visaPrices[0].visibility, "global");
    assert.deepEqual(c.body.data.visaPrices[0].priceUsd, { amountMinor: 12500, currency: "USD" });
  });

  test("unknown slug and a suspended agency are 404 (no visas exposed)", async () => {
    seedAgencyVisa("d-own", AGENCY_D);
    for (const slug of ["nope", "delta"]) {
      const r = await publicAgency(slug);
      assert.equal(r.status, 404, slug);
      assert.ok(!JSON.stringify(r.body).includes("d-own"));
    }
  });
});

// ============================================
// Visa detail, /full, /requirements
// ============================================

describe("visa detail (GET /countries/:code/visas/:visaId, /full, /requirements)", () => {
  test("A's agency-only visa: 404 (same body as unknown) for anonymous, no-case applicant, and agency B", async () => {
    const unknown = await unknownBody();
    for (const [name, who] of [
      ["anonymous", null],
      ["applicant with no case", applicantNone()],
      ["owner B", ownerB()],
      ["agent B", agentB()],
    ] as const) {
      for (const fn of [detail, full, requirements]) {
        const r = await fn(who, "a-own");
        assert.equal(r.status, 404, `${name} ${fn.name}`);
        assert.deepEqual(r.body, unknown, `${name} ${fn.name}`);
      }
    }
  });

  test("the applicant with a case at A gets the applicant-safe visa (detail, /full, /requirements)", async () => {
    const d = await detail(applicantA(), "a-own");
    assert.equal(d.status, 200);
    assert.equal(d.body.data.id, "a-own");
    assert.deepEqual(d.body.data.sponsor, { organisationName: "Acme Ltd", website: "https://acme.example.org" });
    assertNoPrivateFields(d.body);
    const f = await full(applicantA(), "a-own");
    assert.equal(f.status, 200);
    assert.equal(f.body.data.requirements[0].title, "Req of a-own");
    assertNoPrivateFields(f.body);
    const q = await requirements(applicantA(), "a-own");
    assert.equal(q.status, 200);
    assert.equal(q.body.data.length, 1);
  });

  test("owner and agent of A and an admin get the full doc", async () => {
    for (const who of [ownerA(), agentA(), admin()]) {
      const r = await detail(who, "a-own");
      assert.equal(r.status, 200, who.authz.role);
      assert.equal(r.body.data.sponsor.sponsorLicenceNumber, LICENCE);
    }
  });

  test("the applicant with a case at A still gets 404 for A's non-approved visas", async () => {
    const unknown = await unknownBody();
    for (const id of ["a-draft", "a-pending", "a-rejected", "a-inactive"]) {
      const r = await detail(applicantA(), id);
      assert.equal(r.status, 404, id);
      assert.deepEqual(r.body, unknown);
    }
  });

  test("an existing case keeps loading its visa after the visa is made agency-only again", async () => {
    // A case at B on A's visa, started while it was global.
    store.set("applications/app-legacy", {
      id: "app-legacy", userId: "uid-app-none", visaTypeId: "a-own", countryCode: CC,
      mode: "agent", agentId: "uid-agent-b", agencyId: AGENCY_B, status: "in_progress",
    });
    // The applicant of that case, and agency B's side handling it.
    for (const who of [applicantNone(), agentB(), ownerB()]) {
      const r = await detail(who, "a-own");
      assert.equal(r.status, 200, who.userId);
      assertNoPrivateFields(r.body);
    }
    // B's agency still cannot reach A's OTHER agency-only visas.
    seedAgencyVisa("a-own-2");
    assert.equal((await detail(agentB(), "a-own-2")).status, 404);
  });

  test("a public agency visa (made global) is served to anyone, applicant-safe", async () => {
    const r = await detail(null, "a-global");
    assert.equal(r.status, 200);
    assertNoPrivateFields(r.body);
    assert.equal(r.body.data.sponsor.organisationName, "Acme Ltd");
  });

  test("/requirements: public visa readable by anyone; a hidden visa is 404 (the #99 leak)", async () => {
    const pub = await requirements(null, "uk-sw");
    assert.equal(pub.status, 200);
    assert.equal(pub.body.data[0].title, "Req of uk-sw");
    const unknown = await unknownBody();
    const hidden = await requirements(null, "scraped-pending");
    assert.equal(hidden.status, 404);
    assert.deepEqual(hidden.body, unknown);
    assert.equal((await requirements(admin(), "scraped-pending")).status, 200);
  });

  test("agency-only visas stay out of the public lists (#99)", async () => {
    const r = await call(V.getVisaTypes.bind(V), applicantA(), { params: { code: CC }, query: {} });
    const ids = (r.body.data as Data[]).map((v) => v.id);
    assert.ok(ids.includes("uk-sw"));
    assert.ok(ids.includes("a-global"));
    for (const id of ["a-own", "b-own", "a-pending", "a-draft"]) assert.ok(!ids.includes(id), id);
  });
});

// ============================================
// Case start
// ============================================

describe("case start: POST /applications (applicant self-serve)", () => {
  test("agency-only visa with an agent of the owning agency: 201, case at A", async () => {
    const r = await startSelf(applicantNone(), { visaTypeId: "a-own", countryCode: CC, mode: "agent", agentId: "uid-agent-a" });
    assert.equal(r.status, 201);
    assert.equal(r.body.data.agencyId, AGENCY_A);
  });

  test("agency-only visa self-serve, or through agency B's agent: 404 and no application", async () => {
    const unknown = await unknownBody();
    for (const body of [
      { visaTypeId: "a-own", countryCode: CC, mode: "self" },
      { visaTypeId: "a-own", countryCode: CC, mode: "agent", agentId: "uid-agent-b" },
    ]) {
      const r = await startSelf(applicantA(), body);
      assert.equal(r.status, 404, JSON.stringify(body));
      assert.deepEqual(r.body.error, (unknown as any).error);
    }
    assert.equal(applicationWrites().length, 0);
  });

  test("a global visa can still be started by anyone (self or any agency)", async () => {
    assert.equal((await startSelf(applicantNone(), { visaTypeId: "uk-sw", countryCode: CC, mode: "self" })).status, 201);
    assert.equal(
      // confirmNew: the first call just made an active application for this
      // same user + visa, so the #253 duplicate guard would answer 409.
      (await startSelf(applicantNone(), { visaTypeId: "uk-sw", countryCode: CC, mode: "agent", agentId: "uid-agent-b", confirmNew: true })).status,
      201
    );
  });

  test("draft, pending, rejected, inactive: 404 even through the owning agency, nothing written", async () => {
    for (const id of ["a-draft", "a-pending", "a-rejected", "a-inactive", "scraped-pending"]) {
      const r = await startSelf(applicantA(), { visaTypeId: id, countryCode: CC, mode: "agent", agentId: "uid-agent-a" });
      assert.equal(r.status, 404, id);
    }
    assert.equal(applicationWrites().length, 0);
  });
});

describe("case start: POST /applications/for-client (agent / admin)", () => {
  test("agent and owner of A on A's agency-only visa: 201", async () => {
    for (const who of [agentA(), ownerA()]) {
      const r = await startForClient(who, { visaTypeId: "a-own" });
      assert.equal(r.status, 201, who.userId);
      assert.equal(r.body.data.agencyId, AGENCY_A);
    }
  });

  test("agent and owner of B on A's agency-only visa: 404, nobody provisioned, no application", async () => {
    const unknown = await unknownBody();
    for (const who of [agentB(), ownerB()]) {
      const r = await startForClient(who, { visaTypeId: "a-own" });
      assert.equal(r.status, 404, who.userId);
      assert.deepEqual(r.body.error, (unknown as any).error);
    }
    assert.equal(userLookups, 0);
    assert.equal(applicationWrites().length, 0);
  });

  test("A's own non-approved or inactive visas: 404 for A's owner too", async () => {
    for (const id of ["a-draft", "a-pending", "a-rejected", "a-inactive"]) {
      assert.equal((await startForClient(ownerA(), { visaTypeId: id })).status, 404, id);
    }
    assert.equal(userLookups, 0);
    assert.equal(applicationWrites().length, 0);
  });

  test("a global visa: any agency's agent can start it", async () => {
    assert.equal((await startForClient(agentB(), { visaTypeId: "uk-sw" })).status, 201);
  });

  test("admin acting for A may start A's visa; acting for B may not", async () => {
    const okA = await startForClient(admin(), { visaTypeId: "a-own", agentId: "uid-agent-a", agencyId: AGENCY_A });
    assert.equal(okA.status, 201);
    const writesBefore = applicationWrites().length;
    const noB = await startForClient(admin(), { visaTypeId: "a-own", agentId: "uid-agent-b", agencyId: AGENCY_B });
    assert.equal(noB.status, 404);
    assert.equal(applicationWrites().length, writesBefore);
  });
});
