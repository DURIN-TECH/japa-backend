// ============================================
// Rubric review admin API (issue #125) — unit tests, no network, no emulator
// ============================================
//
// Drives the three /admin/rubrics routes over REAL HTTP against the real
// router and the real `verifyAuth` middleware (only the token verification
// and the entitlements read are stubbed), on top of the in-memory Firestore
// fake and the in-memory snapshot bucket of the #40 harness.
//
// Covers: who may call (every non-admin role is refused, with resolved and
// unresolved entitlements), the list, the detail (diff, stale citations,
// flags, response hygiene), and the decision (approve / reject rules, the
// revision check, immutability of a version's content, the audit entry, the
// approval seam). The concurrent-decision test needs real transactions and
// lives in rubric-review.emulator.test.ts.
//
// Fixtures: two fictional routes in two fictional jurisdictions
// (rubric-review-fixtures.ts). No real rule is committed.

import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import type { AddressInfo } from "node:net";
import express from "express";
import { Timestamp } from "firebase-admin/firestore";
import { ROLES } from "@durin-tech/authz";
import { fakeCollection, fakeRunTransaction, resetStore, store, writes } from "../../helpers/fake-firestore";
import { fakeCollectionGroup } from "../../helpers/fake-collection-group";
import { rubricStore } from "../../../src/scrapers/rubric/rubric.store";
import type { RubricDraft } from "../../../src/scrapers/rubric/rubric.store";
import { RUBRIC_REVIEW_FIELDS, type VisaRubric } from "../../../src/types/rubric";
import { adminRubricRoutes } from "../../../src/routes/rubric-review.routes";
import { requireRubricAdmin } from "../../../src/controllers/rubric-review.controller";
import { verifyAdmin, verifyAuth } from "../../../src/middleware/auth";
import {
  RUBRIC_REJECT_REASON_MIN_LENGTH,
  parseRubricVersionId,
  reviewFieldsUpdate,
  rubricReviewService,
  rubricVersionId,
  type RubricApprovedEvent,
} from "../../../src/services/rubric-review.service";
import { diffRubricVersions } from "../../../src/services/rubric-diff";
import { A_LINES, A_TEXT, B_PAGES, ROUTE_A, ROUTE_B, SOURCE_A_ID, SOURCE_A_URL, SOURCE_B_ID, SOURCE_B_URL } from "./fixtures/synthetic-guidance";
import { installRubricFakes, quiet, resetBucket, seedSource, snapshotStore, objects, headDoc, versionDoc } from "./rubric-harness";
import { A2_TEXT, KEY_A, KEY_B, REVIEW_T0, body, criterion, draft, routeAV1, routeAV2, routeBV1, sourceA } from "./rubric-review-fixtures";

/* eslint-disable @typescript-eslint/no-explicit-any */

// ============================================
// Wiring: fakes, principals, an HTTP server over the real router
// ============================================

const ID_A1 = rubricVersionId(KEY_A, 1);
const ID_A2 = rubricVersionId(KEY_A, 2);
const ID_B1 = rubricVersionId(KEY_B, 1);

/**
 * Decoded ID tokens by bearer token: one per role, built from the role
 * constants. `legacy` carries no role claim at all (a pre-migration user).
 */
const TOKENS: Record<string, any> = {
  "t-admin": { uid: "admin-uid", role: ROLES.ADMIN },
  "t-admin-2": { uid: "admin-uid-2", role: ROLES.ADMIN },
  "t-client": { uid: "client-uid", role: ROLES.CLIENT },
  "t-agent": { uid: "agent-uid", role: ROLES.AGENT, agencyId: "agency-1" },
  "t-owner": { uid: "owner-uid", role: ROLES.OWNER, agencyId: "agency-1" },
  "t-legacy": { uid: "legacy-uid" },
};
/** Bearer tokens of every non-admin role. */
const NON_ADMIN_TOKENS = ["t-client", "t-agent", "t-owner"];

/** What the stubbed entitlements read returns (null = unresolved). */
let entitlements: any = null;
/** Clock of the review service (each decision is stamped with it). */
let nowMs = REVIEW_T0 + 7_200_000;

let server: http.Server;
let baseUrl = "";

before(async () => {
  await installRubricFakes();
  const firebase: any = await import("../../../src/utils/firebase");
  // The two refs this issue added.
  firebase.collections.rubricReviewHistory = fakeCollection("rubricReviewHistory");
  firebase.collectionGroups.rubricVersions = () => fakeCollectionGroup("rubricVersions");
  // verifyAuth: the token check and the entitlements read are the only
  // stubs; role resolution, the ability and the read-only rule are real.
  firebase.auth.verifyIdToken = async (token: string) => {
    const decoded = TOKENS[token];
    if (!decoded) throw new Error("invalid token");
    return decoded;
  };
  const { entitlementService }: any = await import("../../../src/services/entitlement.service");
  entitlementService.getEntitlements = async () => entitlements;
  const { claimsService }: any = await import("../../../src/services/claims.service");
  // A token with no role claim resolves from the DB: here, to a client.
  claimsService.resolveRoleFromDb = async () => ({ role: ROLES.CLIENT, agencyId: null });
  claimsService.setRoleClaims = async () => undefined;

  // Transactions in memory; snapshots from the in-memory bucket.
  rubricStore.runTransaction = fakeRunTransaction as any;
  rubricReviewService.runTransaction = fakeRunTransaction as any;
  (rubricReviewService as any).deps.snapshots = snapshotStore;
  (rubricReviewService as any).deps.now = () => Timestamp.fromMillis(nowMs);

  // The real router, mounted as app.ts mounts it.
  const app = express();
  app.use(express.json());
  app.use("/admin/rubrics", adminRubricRoutes);
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => new Promise((resolve) => server.close(resolve)));

beforeEach(() => {
  resetStore();
  resetBucket();
  entitlements = null;
  nowMs = REVIEW_T0 + 7_200_000;
});

/** One HTTP call to the API. `token` null sends no Authorization header. */
async function api(method: string, urlPath: string, token: string | null, payload?: unknown): Promise<{ status: number; body: any }> {
  // verifyAuth and the controller log refusals; keep the test output clean.
  const { result } = await quiet(async () => {
    const res = await fetch(`${baseUrl}/admin/rubrics${urlPath}`, {
      method,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json" },
      ...(payload !== undefined ? { body: JSON.stringify(payload) } : {}),
    });
    return { status: res.status, body: await res.json() };
  });
  return result;
}

/** PATCH a decision as an admin. */
const decide = (id: string, payload: unknown, token = "t-admin") => api("PATCH", `/${id}/review`, token, payload);

/** Store a draft as its route's next version (the path extraction uses). */
async function write(d: RubricDraft): Promise<number> {
  const r = await rubricStore.writePendingVersion(d, d.sourceSnapshots.map((s) => s.sourceId), { now: d.createdAt, force: true });
  return r.version;
}

/** Seed route A's page and store version 1 of its rubric (pending). */
async function seedA(opts: Parameters<typeof routeAV1>[1] = {}): Promise<string> {
  const hash = await seedSource({ id: SOURCE_A_ID, url: SOURCE_A_URL, text: A_TEXT });
  await write(routeAV1(hash, opts));
  return hash;
}

/** Seed route B's PDF and store version 1 of its rubric (pending). */
async function seedB(): Promise<string> {
  const hash = await seedSource({ id: SOURCE_B_ID, url: SOURCE_B_URL, pages: B_PAGES });
  await write(routeBV1(hash));
  return hash;
}

/** The page of route A changes and version 2 is extracted from it. */
async function seedA2(opts: Parameters<typeof routeAV2>[1] = {}): Promise<string> {
  const hash = await seedSource({ id: SOURCE_A_ID, url: SOURCE_A_URL, text: A2_TEXT });
  await write(routeAV2(hash, opts));
  return hash;
}

/** A valid approve body for a version at `revision`. */
const approveBody = (revision: number, extra: Record<string, unknown> = {}) => ({ action: "approve", revision, intentPolarity: "immigrant_intent_penalised", ...extra });

/** Everything of a stored version that a review must never change. */
function contentOf(doc: Record<string, unknown>): string {
  const review: readonly string[] = RUBRIC_REVIEW_FIELDS;
  return JSON.stringify(Object.fromEntries(Object.entries(doc).filter(([k]) => !review.includes(k))));
}

/** Stored audit entries, oldest first. */
const auditEntries = () => [...store.entries()].filter(([p]) => p.startsWith("rubricReviewHistory/")).map(([, d]) => d as any);

/** Every string anywhere inside a JSON value. */
function strings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) value.forEach((v) => strings(v, out));
  else if (value && typeof value === "object") Object.entries(value).forEach(([k, v]) => (out.push(k), strings(v, out)));
  return out;
}

// ============================================
// Who may call
// ============================================

describe("rubric review: admin only", () => {
  /** The three endpoints, each with a body that would succeed for an admin. */
  const calls = (): [string, string, unknown?][] => [
    ["GET", "", undefined],
    ["GET", `/${ID_A1}`, undefined],
    ["PATCH", `/${ID_A1}/review`, approveBody(0)],
  ];

  test("no token: 401 on all three", async () => {
    await seedA();
    for (const [method, p, payload] of calls()) {
      const out = await api(method, p, null, payload);
      assert.equal(out.status, 401, `${method} ${p}`);
    }
  });

  test("client, agent and agency owner get 403 FORBIDDEN on all three, with entitlements unresolved", async () => {
    await seedA();
    writes.length = 0;
    entitlements = null; // unresolved: `requireFeature` would wave this through
    for (const token of NON_ADMIN_TOKENS) {
      for (const [method, p, payload] of calls()) {
        const out = await api(method, p, token, payload);
        assert.equal(out.status, 403, `${token} ${method} ${p}`);
        assert.equal(out.body.success, false);
        assert.equal(out.body.error, "FORBIDDEN");
        assert.equal(out.body.data, undefined, "nothing about the queue is returned");
      }
    }
    assert.equal(writes.length, 0, "nothing was written");
    assert.equal(versionDoc(KEY_A, 1).reviewStatus, "pending_review");
  });

  test("the same roles with a resolved, active plan (every feature) still get 403 FORBIDDEN", async () => {
    await seedA();
    writes.length = 0;
    const { FEATURES }: any = await import("@durin-tech/authz");
    entitlements = { subscriberType: "agency", subscriberId: "agency-1", planId: "top", status: "active", features: Object.values(FEATURES), limits: {} };
    for (const token of NON_ADMIN_TOKENS) {
      for (const [method, p, payload] of calls()) {
        const out = await api(method, p, token, payload);
        assert.equal(out.status, 403, `${token} ${method} ${p}`);
        assert.equal(out.body.error, "FORBIDDEN");
      }
    }
    assert.equal(writes.length, 0);
  });

  test("a lapsed (read-only) plan: reads are 403 FORBIDDEN, the write is refused before the gate, nothing is written", async () => {
    await seedA();
    writes.length = 0;
    entitlements = { subscriberType: "client", subscriberId: "client-uid", planId: "p", status: "past_due", features: [], limits: {} };
    assert.equal((await api("GET", "", "t-client")).body.error, "FORBIDDEN");
    assert.equal((await api("GET", `/${ID_A1}`, "t-client")).body.error, "FORBIDDEN");
    // verifyAuth's own read-only rule answers a non-admin write first (402).
    const out = await api("PATCH", `/${ID_A1}/review`, "t-client", approveBody(0));
    assert.ok(out.status === 402 || out.status === 403, String(out.status));
    assert.equal(writes.length, 0);
  });

  test("a token with no role claim is resolved from the DB (a client here) and refused", async () => {
    await seedA();
    const out = await api("GET", "", "t-legacy");
    assert.equal(out.status, 403);
    assert.equal(out.body.error, "FORBIDDEN");
  });

  test("the guard refuses a request that carries no principal at all", () => {
    const sent: any = {};
    const res: any = { status: (c: number) => ((sent.status = c), res), json: (b: unknown) => ((sent.body = b), res) };
    let called = false;
    requireRubricAdmin({} as any, res, () => (called = true));
    assert.equal(called, false);
    assert.equal(sent.status, 403);
    assert.equal(sent.body.error, "FORBIDDEN");
  });

  test("an admin is let through", async () => {
    await seedA();
    const out = await api("GET", "", "t-admin");
    assert.equal(out.status, 200);
    assert.equal(out.body.data.total, 1);
  });

  test("exactly three routes exist, each behind verifyAuth, the admin guard and verifyAdmin: no partial approval endpoint", () => {
    const routes = (adminRubricRoutes as any).stack.filter((l: any) => l.route).map((l: any) => ({
      path: l.route.path,
      methods: Object.keys(l.route.methods),
      chain: l.route.stack.slice(0, 3).map((s: any) => s.handle),
    }));
    assert.deepEqual(routes.map((r: any) => `${r.methods.join(",")} ${r.path}`), ["get /", "get /:id", "patch /:id/review"]);
    for (const r of routes) assert.deepEqual(r.chain, [verifyAuth, requireRubricAdmin, verifyAdmin], r.path);
  });
});

// ============================================
// GET /admin/rubrics
// ============================================

describe("GET /admin/rubrics", () => {
  test("lists pending versions of every route with the fields the queue needs", async () => {
    const hashA = await seedA();
    const hashB = await seedB();
    const out = await api("GET", "?reviewStatus=pending_review", "t-admin");
    assert.equal(out.status, 200);
    assert.equal(out.body.data.total, 2);
    // Newest extraction first (route B's fixture is stamped an hour later).
    const [b, a] = out.body.data.items;
    assert.equal(a.id, ID_A1);
    assert.equal(a.countryCode, ROUTE_A.countryCode);
    assert.equal(a.visaTypeId, ROUTE_A.visaTypeId);
    assert.equal(a.version, 1);
    assert.equal(a.reviewStatus, "pending_review");
    assert.equal(a.revision, 0);
    assert.equal(a.criterionCount, 4);
    assert.equal(a.sourceSetHash, versionDoc(KEY_A, 1).sourceSetHash);
    assert.deepEqual(a.sources, [{ sourceId: SOURCE_A_ID, contentHash: hashA, url: SOURCE_A_URL, docType: "html" }]);
    assert.equal(a.intentPolarity, null);
    assert.equal(a.intentPolarityProposal, "immigrant_intent_penalised");
    assert.equal(a.isLatest, true);
    assert.equal(a.isServing, false);
    assert.equal(b.id, ID_B1);
    assert.equal(b.countryCode, ROUTE_B.countryCode);
    assert.equal(b.criterionCount, 2);
    assert.equal(b.sources[0].contentHash, hashB);
    assert.equal(b.intentPolarityProposal, "dual_intent_permitted");
    // A row carries counts, never criteria or quotes.
    for (const item of out.body.data.items) assert.equal(item.criteria, undefined);
  });

  test("filters by review status; pending is the default", async () => {
    await seedA();
    await seedB();
    assert.equal((await decide(ID_A1, approveBody(0))).status, 200);
    assert.equal((await decide(ID_B1, { action: "reject", revision: 0, reason: "The tuition rule was misread." })).status, 200);

    const approved = (await api("GET", "?reviewStatus=approved", "t-admin")).body.data.items;
    assert.deepEqual(approved.map((i: any) => i.id), [ID_A1]);
    assert.equal(approved[0].isServing, true);
    assert.equal(approved[0].intentPolarity, "immigrant_intent_penalised");
    assert.equal(approved[0].reviewedBy, "admin-uid");
    const rejected = (await api("GET", "?reviewStatus=rejected", "t-admin")).body.data.items;
    assert.deepEqual(rejected.map((i: any) => i.id), [ID_B1]);
    assert.equal(rejected[0].isServing, false);
    assert.deepEqual((await api("GET", "", "t-admin")).body.data, { items: [], total: 0 });
  });

  test("an unknown status, a repeated status or a bad limit is 400 VALIDATION_ERROR", async () => {
    for (const q of ["?reviewStatus=published", "?reviewStatus=approved&reviewStatus=rejected", "?limit=0", "?limit=abc"]) {
      const out = await api("GET", q, "t-admin");
      assert.equal(out.status, 400, q);
      assert.equal(out.body.error, "VALIDATION_ERROR");
    }
  });

  test("limit caps the page", async () => {
    await seedA();
    await seedB();
    assert.equal((await api("GET", "?limit=1", "t-admin")).body.data.items.length, 1);
  });
});

// ============================================
// GET /admin/rubrics/:id
// ============================================

describe("GET /admin/rubrics/:id", () => {
  test("a first version: the full rubric, and a diff that is all new with no error", async () => {
    await seedA();
    const out = await api("GET", `/${ID_A1}`, "t-admin");
    assert.equal(out.status, 200);
    const d = out.body.data;
    assert.equal(d.id, ID_A1);
    assert.equal(d.reviewStatus, "pending_review");
    assert.equal(d.revision, 0);
    assert.equal(d.criteria.length, 4);
    assert.deepEqual(d.route, { approvedVersion: null, latestVersion: 1 });

    // The criterion shape #41 renders: addressed by criterionId, with title,
    // kind, stage, severity and source; no weight / mandatory / refusalGround.
    const age = d.criteria.find((c: any) => c.title === "Aged 18 or over");
    assert.match(age.criterionId, /^crit_[a-f0-9]{16}$/);
    assert.equal(age.kind, "objective");
    assert.equal(age.stage, "eligibility");
    assert.equal(age.severity, "high");
    assert.equal(age.ruleRef, "SV 2.1");
    assert.equal(age.source.quote, body(A_LINES.age));
    assert.equal(age.source.url, SOURCE_A_URL);
    assert.deepEqual(age.check, { field: "applicant.age", op: "gte", value: 18 });
    for (const key of ["weight", "mandatory", "refusalGround", "id"]) assert.ok(!(key in age), key);

    // The proposal and the decision are separate.
    assert.equal(d.intentPolarity, null);
    assert.equal(d.intentPolarityProposal.value, "immigrant_intent_penalised");
    assert.equal(typeof d.intentPolarityProposal.source.quote, "string");

    // Diff: everything is new.
    assert.equal(d.diff.baselineVersion, null);
    assert.equal(d.diff.allNew, true);
    assert.equal(d.diff.added.length, 4);
    assert.deepEqual(d.diff.removed, []);
    assert.deepEqual(d.diff.changed, []);
    assert.equal(d.diff.intentPolarityChanged, false);
    assert.deepEqual(d.diff.summary, { added: 4, removed: 0, changed: 0, unchanged: 0 });

    // Citations are current; nothing blocks an approval.
    for (const c of d.criteria) {
      assert.equal(c.staleCitation, false, c.title);
      assert.equal(c.citationStatus, "current");
    }
    assert.equal(d.approval.canApprove, true);
    assert.deepEqual(d.approval.blockers, []);
    assert.equal(d.approval.intentPolarityRequired, true);
    assert.equal(d.approval.intentCriteriaCount, 1);
    assert.deepEqual(d.approval.requiredAcknowledgements, []);
    assert.deepEqual(d.approval.conditionalAcknowledgement, { key: "intent_criteria_without_polarity:rubric", when: "intentPolarity is not_assessed" });
  });

  test("a PDF route keeps the page of each quote", async () => {
    await seedB();
    const d = (await api("GET", `/${ID_B1}`, "t-admin")).body.data;
    assert.deepEqual(d.criteria.map((c: any) => c.source.page), [2, 3]);
    assert.equal(d.intentPolarityProposal.value, "dual_intent_permitted");
    assert.equal(d.intentPolarityProposal.source.page, 2);
    for (const c of d.criteria) assert.equal(c.staleCitation, false);
  });

  test("version 2 against the approved version 1: added, removed, changed (paired by ruleRef), polarity flagged", async () => {
    await seedA();
    assert.equal((await decide(ID_A1, approveBody(0))).status, 200);
    await seedA2();

    const d = (await api("GET", `/${ID_A2}`, "t-admin")).body.data;
    assert.equal(d.diff.baselineVersion, 1);
    assert.equal(d.diff.allNew, false);
    assert.deepEqual(d.route, { approvedVersion: 1, latestVersion: 2 });

    // Added: the insurance rule. Removed: the nationality bar.
    assert.deepEqual(d.diff.added.map((c: any) => c.title), ["Travel insurance for the whole visit"]);
    assert.deepEqual(d.diff.removed.map((c: any) => c.title), ["Nationals refused from a stated date"]);
    assert.deepEqual(d.diff.summary, { added: 1, removed: 1, changed: 2, unchanged: 1 });

    // Changed, same id: the holding period kept its words, lost severity.
    const v1 = versionDoc(KEY_A, 1) as VisaRubric;
    const v2 = versionDoc(KEY_A, 2) as VisaRubric;
    const heldId = v2.criteria[1].criterionId;
    assert.equal(heldId, v1.criteria[1].criterionId, "the same passage has the same id in both versions");
    const held = d.diff.changed.find((c: any) => c.criterionId === heldId);
    assert.equal(held.matchedBy, "criterionId");
    assert.deepEqual(held.changes, [{ field: "severity", before: "high", after: "medium" }]);

    // Changed, new words: removed + added by id, paired by the rule reference.
    const age = d.diff.changed.find((c: any) => c.ruleRef === "SV 2.1");
    assert.equal(age.matchedBy, "ruleRef");
    assert.equal(age.previousCriterionId, v1.criteria[0].criterionId);
    assert.equal(age.criterionId, v2.criteria[0].criterionId);
    assert.notEqual(age.criterionId, age.previousCriterionId);
    assert.deepEqual(age.changes.map((c: any) => c.field), ["title", "source.quote", "check"]);
    const quote = age.changes.find((c: any) => c.field === "source.quote");
    assert.equal(quote.before, body(A_LINES.age));
    assert.match(quote.after, /aged 21 or over/);
    assert.deepEqual(age.changes.find((c: any) => c.field === "check").after, { field: "applicant.age", op: "gte", value: 21 });
    assert.equal(age.before.title, "Aged 18 or over");

    // The polarity proposal flipped: flagged prominently, with both sides.
    assert.equal(d.diff.intentPolarityChanged, true);
    assert.deepEqual(d.diff.intentPolarity, {
      proposalChanged: true,
      previousProposal: "immigrant_intent_penalised",
      currentProposal: "dual_intent_permitted",
      previousDecision: "immigrant_intent_penalised",
      proposalDiffersFromPreviousDecision: true,
    });
  });

  test("an approved version is compared with the approved version before it", async () => {
    await seedA();
    await decide(ID_A1, approveBody(0));
    await seedA2();
    assert.equal((await decide(ID_A2, approveBody(0, { intentPolarity: "dual_intent_permitted" }))).status, 200);
    const v2 = (await api("GET", `/${ID_A2}`, "t-admin")).body.data;
    assert.equal(v2.diff.baselineVersion, 1);
    assert.equal(v2.isServing, true);
    const v1 = (await api("GET", `/${ID_A1}`, "t-admin")).body.data;
    assert.equal(v1.diff.baselineVersion, null, "version 1 had no approved predecessor");
    assert.equal(v1.isServing, false);
    assert.equal(typeof v1.supersededAt, "string");
  });

  test("staleCitation: true exactly for the criteria whose quote left the current source text", async () => {
    await seedA();
    // The publisher edits the page; no new version has been extracted yet.
    await seedSource({ id: SOURCE_A_ID, url: SOURCE_A_URL, text: A2_TEXT });
    const d = (await api("GET", `/${ID_A1}`, "t-admin")).body.data;
    const stale = Object.fromEntries(d.criteria.map((c: any) => [c.title, [c.staleCitation, c.citationStatus]]));
    assert.deepEqual(stale, {
      "Aged 18 or over": [true, "stale"], // "18" became "21"
      "Funds held for 28 days": [false, "current"], // word for word the same
      "Will leave at the end of the visit": [false, "current"],
      "Nationals refused from a stated date": [true, "stale"], // paragraph removed
    });
    assert.equal(d.approval.canApprove, false);
    assert.deepEqual(d.approval.blockers.map((b: any) => b.code), ["STALE_CITATION"]);
    assert.equal(d.approval.staleCriterionIds.length, 2);
  });

  test("staleCitation ignores whitespace only: a re-spaced page is current, a reworded one is not", async () => {
    await seedA();
    // Same words, same lines, every space widened (spaces, tabs).
    await seedSource({ id: SOURCE_A_ID, url: SOURCE_A_URL, text: A_TEXT.replace(/ /g, " \t ") });
    let d = (await api("GET", `/${ID_A1}`, "t-admin")).body.data;
    for (const c of d.criteria) assert.equal(c.staleCitation, false, c.title);
    // The age rule is now split over two paragraphs: no longer one passage
    // of the source, so the same lookup extraction uses reports it gone.
    await seedSource({ id: SOURCE_A_ID, url: SOURCE_A_URL, text: A_TEXT.replace("aged 18 or over", "aged 18\nor over") });
    d = (await api("GET", `/${ID_A1}`, "t-admin")).body.data;
    assert.equal(d.criteria.find((c: any) => c.title === "Aged 18 or over").staleCitation, true);
    assert.equal(d.criteria.find((c: any) => c.title === "Funds held for 28 days").staleCitation, false);
    // One letter of case differs: no fuzzy matching, so it is stale.
    await seedSource({ id: SOURCE_A_ID, url: SOURCE_A_URL, text: A_TEXT.replace("aged 18 or over", "Aged 18 or over") });
    d = (await api("GET", `/${ID_A1}`, "t-admin")).body.data;
    assert.equal(d.criteria.find((c: any) => c.title === "Aged 18 or over").staleCitation, true);
  });

  test("a source whose newest snapshot cannot be read: unverifiable, reported stale, approval blocked", async () => {
    await seedA();
    await seedSource({ id: SOURCE_A_ID, url: SOURCE_A_URL, text: A2_TEXT });
    objects.clear(); // the stored text is gone
    const d = (await api("GET", `/${ID_A1}`, "t-admin")).body.data;
    for (const c of d.criteria) assert.deepEqual([c.staleCitation, c.citationStatus], [true, "unverifiable"]);
    assert.deepEqual(d.approval.blockers.map((b: any) => b.code), ["CITATION_UNVERIFIABLE"]);
    const out = await decide(ID_A1, approveBody(0));
    assert.equal(out.status, 409);
    assert.equal(out.body.error, "CITATION_UNVERIFIABLE");
    assert.equal(versionDoc(KEY_A, 1).reviewStatus, "pending_review");
  });

  test("flags, discards and suspicious passages are returned so the reviewer sees what was dropped", async () => {
    const hash = await seedSource({ id: SOURCE_A_ID, url: SOURCE_A_URL, text: A_TEXT });
    const s = sourceA(hash);
    await write(
      routeAV1(hash, {
        extra: {
          discardedCount: 3,
          discarded: [
            { itemType: "criterion", reason: "quote_not_found", detail: "not verbatim in the source", label: "Paraphrased rule", sourceId: SOURCE_A_ID, chunkIndex: 0 },
            { itemType: "criterion", reason: "number_not_in_quote", detail: "9999 is not in the quote", label: "Invented threshold", sourceId: SOURCE_A_ID, chunkIndex: 0 },
            { itemType: "criterion", reason: "quote_not_found", detail: "not verbatim in the source", label: "Another one", sourceId: SOURCE_A_ID, chunkIndex: 0 },
          ],
          suspiciousPassages: [{ quote: A_LINES.sponsor, sourceId: s.sourceId, url: s.url, contentHash: hash, retrievedAt: new Date(REVIEW_T0).toISOString() }],
          flags: [{ code: "intent_polarity_conflict", message: "two passages disagree", target: "rubric" }],
        },
      })
    );
    const d = (await api("GET", `/${ID_A1}`, "t-admin")).body.data;
    assert.equal(d.discardedCount, 3);
    assert.equal(d.discarded.length, 3);
    assert.deepEqual(d.discardedByReason, { quote_not_found: 2, number_not_in_quote: 1 });
    assert.equal(d.suspiciousPassageCount, 1);
    assert.equal(d.suspiciousPassages[0].quote, A_LINES.sponsor);
    assert.deepEqual(d.flags.map((f: any) => [f.key, f.category, f.blocking]), [
      ["intent_polarity_conflict:rubric", "must_acknowledge", true],
      ["suspicious_passages:rubric", "must_acknowledge", true],
    ]);
    assert.deepEqual(d.approval.requiredAcknowledgements, ["intent_polarity_conflict:rubric", "suspicious_passages:rubric"]);
  });

  test("each quote comes with a bounded window of its source: the words before a quote are visible", async () => {
    await seedA();
    const d = (await api("GET", `/${ID_A1}`, "t-admin")).body.data;
    // Web page: the window is the quote's own line, nothing from other lines.
    const leave = d.criteria.find((c: any) => c.title === "Will leave at the end of the visit");
    assert.deepEqual(leave.quoteContext, {
      before: "SV 3.1 ",
      after: " An intention to remain beyond the visit counts against the applicant.",
      truncatedBefore: false,
      truncatedAfter: false,
      snapshot: "current",
    });
    assert.equal(`${leave.quoteContext.before}${leave.source.quote}${leave.quoteContext.after}`, A_LINES.leave);
    // The polarity proposal's sentence has its context too.
    assert.equal(d.intentPolarityProposal.quoteContext.before, "SV 3.1 The decision maker must be satisfied that the applicant will leave Avalen at the end of the visit. ");
    assert.equal(d.intentPolarityProposal.quoteContext.after, "");

    // PDF: the window stays on the quote's page.
    await seedB();
    const b = (await api("GET", `/${ID_B1}`, "t-admin")).body.data;
    const tuition = b.criteria.find((c: any) => c.title === "Tuition for the first 12 months");
    assert.equal(tuition.quoteContext.before, "from a listed institution for the whole course. ");
    assert.equal(tuition.quoteContext.after, "");
    const ties = b.criteria.find((c: any) => c.title === "Ties, study plan and previous travel");
    assert.match(ties.quoteContext.before, /Holding both intentions is not a reason to refuse\. G 3 $/);
    assert.ok(!JSON.stringify(ties.quoteContext).includes("G 5 Tuition"), "nothing from page 3");
  });

  test("a quote taken from after a negation: the negation is in the context the reviewer is shown", async () => {
    const line = "SV 7.1 The applicant is not required to hold a return ticket when applying.";
    const hash = await seedSource({ id: SOURCE_A_ID, url: SOURCE_A_URL, text: `${A_TEXT}\n${line}` });
    const s = sourceA(hash);
    // Verbatim, on word boundaries, and the opposite of what the source says.
    await write(draft(ROUTE_A, [s], [criterion(s, { title: "Return ticket", kind: "objective", ruleRef: "SV 7.1", quote: "required to hold a return ticket", check: { field: "travel.returnTicket", op: "present" } })], { proposal: { value: "not_assessed" } }));
    const d = (await api("GET", `/${ID_A1}`, "t-admin")).body.data;
    assert.equal(d.criteria[0].staleCitation, false, "code cannot catch it");
    assert.equal(d.criteria[0].quoteContext.before, "SV 7.1 The applicant is not ");
    assert.equal(d.criteria[0].quoteContext.after, " when applying.");
  });

  test("the context window is bounded: at most 300 characters either side, never the whole text", async () => {
    const filler = (word: string) => Array.from({ length: 200 }, (_, i) => `${word}${i}`).join(" ");
    const quote = "The applicant must hold a valid permit at all times.";
    const line = `${filler("alpha")} ${quote} ${filler("omega")}`;
    const hash = await seedSource({ id: SOURCE_A_ID, url: SOURCE_A_URL, text: `${A_LINES.heading}\n${line}` });
    const s = sourceA(hash);
    await write(draft(ROUTE_A, [s], [criterion(s, { title: "Valid permit", kind: "judgement", quote })]));
    const out = await api("GET", `/${ID_A1}`, "t-admin");
    const ctx = out.body.data.criteria[0].quoteContext;
    assert.equal(ctx.before.length, 300);
    assert.equal(ctx.after.length, 300);
    assert.equal(ctx.truncatedBefore, true);
    assert.equal(ctx.truncatedAfter, true);
    assert.ok(line.includes(`${ctx.before}${quote}${ctx.after}`));
    assert.ok(!JSON.stringify(out.body).includes("alpha0 "), "the start of the line is not returned");
    assert.ok(!JSON.stringify(out.body).includes(A_LINES.heading), "another line is not returned");
  });

  test("a stale quote is shown in the snapshot it was cited to", async () => {
    await seedA();
    await seedSource({ id: SOURCE_A_ID, url: SOURCE_A_URL, text: A2_TEXT });
    const d = (await api("GET", `/${ID_A1}`, "t-admin")).body.data;
    const age = d.criteria.find((c: any) => c.title === "Aged 18 or over");
    assert.equal(age.staleCitation, true);
    assert.deepEqual(age.quoteContext, { before: "SV 2.1 ", after: "", truncatedBefore: false, truncatedAfter: false, snapshot: "cited" });
    assert.equal(d.criteria.find((c: any) => c.title === "Funds held for 28 days").quoteContext.snapshot, "current");
  });

  test("response hygiene: quotes yes; snapshot text, storage paths and URLs to stored text never", async () => {
    await seedA();
    await decide(ID_A1, approveBody(0));
    await seedA2();
    for (const urlPath of ["", "?reviewStatus=approved", `/${ID_A1}`, `/${ID_A2}`]) {
      const out = await api("GET", urlPath, "t-admin");
      const all = strings(out.body);
      const text = JSON.stringify(out.body);
      // No key or value that names where the text is stored, or a link to it.
      for (const s of all) {
        assert.doesNotMatch(s, /guidance-snapshots|storagePath|signedUrl|downloadUrl|storage\.googleapis|firebasestorage|X-Goog-|token=/i, `${urlPath}: ${s.slice(0, 60)}`);
        // Never the whole stored document, in either of its versions.
        assert.ok(!s.includes(A_TEXT) && !s.includes(A2_TEXT), `${urlPath} returns the stored text`);
      }
      // Lines of the page that no criterion quotes are not in the response.
      for (const line of [A_LINES.heading, A_LINES.updated, A_LINES.funds, A_LINES.sponsor]) assert.ok(!text.includes(line), `${urlPath} leaks "${line.slice(0, 30)}"`);
      // The only URLs are the publisher's own page.
      for (const s of all.filter((x) => /^https?:\/\//.test(x))) assert.equal(s, SOURCE_A_URL);
    }
  });

  test("404 for a version that does not exist and for an id that cannot name one", async () => {
    await seedA();
    for (const id of [rubricVersionId(KEY_A, 9), rubricVersionId(`QQ_${ROUTE_A.visaTypeId}`, 1), "not-an-id", `${KEY_A}__v0`, `${KEY_A}__vx`]) {
      const out = await api("GET", `/${id}`, "t-admin");
      assert.equal(out.status, 404, id);
      assert.equal(out.body.error, "NOT_FOUND");
    }
  });

  test("the version id round-trips, including a visa type id with underscores", () => {
    assert.deepEqual(parseRubricVersionId(rubricVersionId("XA_some__v2_route", 12)), { routeKey: "XA_some__v2_route", version: 12 });
    for (const bad of ["XA_route", "XA_route__v", "XA/route__v1", "../XA_route__v1", "XAB_route__v1", "xa_route__v1", 7, null]) assert.equal(parseRubricVersionId(bad), null, String(bad));
  });
});

// ============================================
// The diff, on its own
// ============================================

describe("rubric diff: pairing by rule reference", () => {
  const s = sourceA("a".repeat(64));
  /** A rubric-shaped object holding these criteria. */
  const rubricOf = (version: number, criteria: ReturnType<typeof criterion>[]) => ({ version, criteria, intentPolarity: null, intentPolarityProposal: null });

  test("criteria with no rule reference are never paired", () => {
    const before = rubricOf(1, [criterion(s, { title: "Old", kind: "judgement", quote: "The officer weighs the old factor carefully." })]);
    const after = rubricOf(2, [criterion(s, { title: "New", kind: "judgement", quote: "The officer weighs the new factor carefully." })]);
    const d = diffRubricVersions(after, before);
    assert.equal(d.changed.length, 0);
    assert.equal(d.added.length, 1);
    assert.equal(d.removed.length, 1);
  });

  test("a reference shared by two criteria pairs each with its own kind and checked field", () => {
    const before = rubricOf(1, [
      criterion(s, { title: "Balance", kind: "objective", ruleRef: "R 1", quote: "The balance must be at least 100 credits.", check: { field: "funds.balance", op: "gte", value: 100 } }),
      criterion(s, { title: "Genuine", kind: "judgement", ruleRef: "R 1", quote: "The officer must be satisfied the funds are genuine." }),
    ]);
    const after = rubricOf(2, [
      criterion(s, { title: "Genuine", kind: "judgement", ruleRef: "R 1", quote: "The officer must be satisfied the funds are genuinely available." }),
      criterion(s, { title: "Balance", kind: "objective", ruleRef: "R 1", quote: "The balance must be at least 200 credits.", check: { field: "funds.balance", op: "gte", value: 200 } }),
    ]);
    const d = diffRubricVersions(after, before);
    assert.deepEqual([d.added.length, d.removed.length, d.changed.length], [0, 0, 2]);
    for (const c of d.changed) {
      assert.equal(c.matchedBy, "ruleRef");
      assert.equal(c.before.kind, after.criteria.find((x) => x.criterionId === c.criterionId)?.kind);
    }
  });

  test("an ambiguous reference is left as added and removed, not guessed", () => {
    const j = (title: string, quote: string) => criterion(s, { title, kind: "judgement", ruleRef: "R 2", quote });
    const before = rubricOf(1, [j("One", "The officer considers the first matter in full."), j("Two", "The officer considers the second matter in full.")]);
    const after = rubricOf(2, [j("Three", "The officer considers the third matter in full."), j("Four", "The officer considers the fourth matter in full.")]);
    const d = diffRubricVersions(after, before);
    assert.deepEqual([d.added.length, d.removed.length, d.changed.length], [2, 2, 0]);
  });

  test("identical versions: nothing added, removed or changed", () => {
    const criteria = [criterion(s, { title: "Same", kind: "judgement", ruleRef: "R 3", quote: "The officer considers the same matter each time." })];
    const d = diffRubricVersions(rubricOf(2, criteria), rubricOf(1, JSON.parse(JSON.stringify(criteria))));
    assert.deepEqual([d.added.length, d.removed.length, d.changed.length, d.unchangedCount], [0, 0, 0, 1]);
    assert.equal(d.intentPolarity.proposalChanged, false);
  });
});

// ============================================
// PATCH /admin/rubrics/:id/review — approve
// ============================================

describe("rubric review: approve", () => {
  test("writes the status, reviewer, timestamp and the admin's polarity; the head now serves it", async () => {
    await seedA();
    const out = await decide(ID_A1, approveBody(0, { reason: "Read against the page." }));
    assert.equal(out.status, 200);
    assert.equal(out.body.data.reviewStatus, "approved");
    assert.equal(out.body.data.revision, 1);
    assert.equal(out.body.data.approvedVersion, 1);
    assert.equal(out.body.data.previousApprovedVersion, null);

    const v1 = versionDoc(KEY_A, 1);
    assert.equal(v1.reviewStatus, "approved");
    assert.equal(v1.reviewedBy, "admin-uid");
    assert.equal(v1.reviewedAt.toMillis(), nowMs);
    assert.equal(v1.intentPolarity, "immigrant_intent_penalised");
    assert.equal(v1.rejectReason, null);
    assert.equal(v1.revision, 1);
    assert.equal(headDoc(KEY_A).approvedVersion, 1);
    // Consumers now get it.
    assert.equal((await rubricStore.getApprovedRubric(ROUTE_A.countryCode, ROUTE_A.visaTypeId))?.version, 1);
  });

  test("the polarity must be sent: no default, and never the proposal's value", async () => {
    await seedA();
    for (const payload of [{ action: "approve", revision: 0 }, approveBody(0, { intentPolarity: null }), approveBody(0, { intentPolarity: "penalised" })]) {
      const out = await decide(ID_A1, payload);
      assert.equal(out.status, 400, JSON.stringify(payload));
      assert.equal(out.body.error, "VALIDATION_ERROR");
      assert.match(out.body.message, /intentPolarity is required/);
    }
    const v1 = versionDoc(KEY_A, 1);
    assert.equal(v1.reviewStatus, "pending_review");
    assert.equal(v1.intentPolarity, null, "the proposal was not copied into the decision");
  });

  test("the admin may override the proposal; the audit entry says so", async () => {
    await seedA(); // proposal: immigrant_intent_penalised
    const out = await decide(ID_A1, approveBody(0, { intentPolarity: "dual_intent_permitted" }));
    assert.equal(out.status, 200);
    const v1 = versionDoc(KEY_A, 1);
    assert.equal(v1.intentPolarity, "dual_intent_permitted");
    assert.equal(v1.intentPolarityProposal.value, "immigrant_intent_penalised", "the proposal is content: untouched");
    const [entry] = auditEntries();
    assert.equal(entry.intentPolarity, "dual_intent_permitted");
    assert.equal(entry.intentPolarityProposal, "immigrant_intent_penalised");
    assert.equal(entry.intentPolarityOverridden, true);
  });

  test("only review fields are written: criteria, sources and quotes are byte-identical before and after", async () => {
    await seedA();
    await seedB();
    const before = { a: versionDoc(KEY_A, 1), b: versionDoc(KEY_B, 1) };
    const snapshot = { a: contentOf(before.a), b: contentOf(before.b), criteria: JSON.stringify(before.a.criteria), sources: JSON.stringify(before.a.sourceSnapshots) };
    writes.length = 0;

    assert.equal((await decide(ID_A1, approveBody(0))).status, 200);
    assert.equal((await decide(ID_B1, { action: "reject", revision: 0, reason: "The tuition rule was misread." })).status, 200);

    const after = { a: versionDoc(KEY_A, 1), b: versionDoc(KEY_B, 1) };
    assert.equal(contentOf(after.a), snapshot.a);
    assert.equal(contentOf(after.b), snapshot.b);
    assert.equal(JSON.stringify(after.a.criteria), snapshot.criteria);
    assert.equal(JSON.stringify(after.a.sourceSnapshots), snapshot.sources);
    assert.equal(JSON.stringify(after.a.criteria.map((c: any) => c.source.quote)), JSON.stringify(before.a.criteria.map((c: any) => c.source.quote)));

    // Every write to a version doc was an update of review fields only.
    const versionWrites = writes.filter((w) => w.path.includes("/rubricVersions/"));
    assert.equal(versionWrites.length, 2);
    for (const w of versionWrites) {
      assert.equal(w.op, "update", w.path);
      for (const key of Object.keys(w.data)) assert.ok((RUBRIC_REVIEW_FIELDS as readonly string[]).includes(key), `${key} written to ${w.path}`);
    }
  });

  test("the write helper refuses any field that is not a review field", () => {
    assert.throws(() => reviewFieldsUpdate({ criteria: [] } as any), /may not write "criteria"/);
    assert.throws(() => reviewFieldsUpdate({ reviewStatus: "approved", sourceSnapshots: [] } as any), /may not write "sourceSnapshots"/);
    assert.deepEqual(reviewFieldsUpdate({ reviewStatus: "rejected", revision: 3 }), { reviewStatus: "rejected", revision: 3 });
  });

  test("approving version 2 supersedes version 1 in the same transaction", async () => {
    await seedA();
    await decide(ID_A1, approveBody(0));
    await seedA2();
    // Until the decision, version 1 serves and version 2 is invisible to consumers.
    assert.equal((await rubricStore.getApprovedRubric(ROUTE_A.countryCode, ROUTE_A.visaTypeId))?.version, 1);

    // Count transactions: the decision must be ONE.
    let runs = 0;
    const real = rubricReviewService.runTransaction;
    rubricReviewService.runTransaction = ((fn: any) => (runs++, fakeRunTransaction(fn))) as any;
    writes.length = 0;
    nowMs += 60_000;
    try {
      const out = await decide(ID_A2, approveBody(0, { intentPolarity: "dual_intent_permitted" }), "t-admin-2");
      assert.equal(out.status, 200);
      assert.equal(out.body.data.previousApprovedVersion, 1);
      assert.equal(out.body.data.approvedVersion, 2);
    } finally {
      rubricReviewService.runTransaction = real;
    }
    assert.equal(runs, 1);
    // The four writes of that one transaction.
    assert.deepEqual(writes.map((w) => `${w.op} ${w.path.replace(/rubricReviewHistory\/.*/, "rubricReviewHistory/*")}`), [
      `update visaRubrics/${KEY_A}/rubricVersions/2`,
      `update visaRubrics/${KEY_A}/rubricVersions/1`,
      `update visaRubrics/${KEY_A}`,
      "set rubricReviewHistory/*",
    ]);

    const v1 = versionDoc(KEY_A, 1);
    assert.equal(v1.reviewStatus, "approved", "kept as a record");
    assert.equal(v1.supersededAt.toMillis(), nowMs);
    assert.equal(v1.revision, 2);
    assert.equal(v1.reviewedBy, "admin-uid", "who approved version 1 is not rewritten");
    assert.equal(versionDoc(KEY_A, 2).supersededAt, null);
    assert.equal(headDoc(KEY_A).approvedVersion, 2);
    const serving = await rubricStore.getApprovedRubric(ROUTE_A.countryCode, ROUTE_A.visaTypeId);
    assert.equal(serving?.version, 2);
    assert.equal(serving?.intentPolarity, "dual_intent_permitted");
  });

  test("an older version cannot be approved while a newer one exists; it can be rejected", async () => {
    // Both versions read the SAME snapshot (a forced re-extraction), so no
    // citation is stale: the refusal is about the order alone.
    const hash = await seedA();
    await write(routeAV1(hash, { createdAtMs: REVIEW_T0 + 86_400_000 }));
    assert.equal(headDoc(KEY_A).latestVersion, 2);

    const detail = (await api("GET", `/${ID_A1}`, "t-admin")).body.data;
    assert.equal(detail.isLatest, false);
    assert.equal(detail.approval.canApprove, false);
    assert.deepEqual(detail.approval.blockers.map((b: any) => b.code), ["NOT_LATEST_VERSION"]);

    writes.length = 0;
    const out = await decide(ID_A1, approveBody(0));
    assert.equal(out.status, 409);
    assert.equal(out.body.error, "NOT_LATEST_VERSION");
    assert.equal(writes.length, 0);
    assert.equal(headDoc(KEY_A).approvedVersion, null);

    // Approve the newest, then try the older one again: still refused, and
    // the newer approval is untouched.
    assert.equal((await decide(ID_A2, approveBody(0))).status, 200);
    assert.equal((await decide(ID_A1, approveBody(0))).body.error, "NOT_LATEST_VERSION");
    assert.equal(headDoc(KEY_A).approvedVersion, 2);
    assert.equal(versionDoc(KEY_A, 1).reviewStatus, "pending_review");

    // Rejecting the older one is allowed and changes nothing that serves.
    assert.equal((await decide(ID_A1, { action: "reject", revision: 0, reason: "Superseded by version 2." })).status, 200);
    assert.equal(headDoc(KEY_A).approvedVersion, 2);
  });

  test("a stale citation blocks approval outright, whatever is acknowledged", async () => {
    await seedA();
    await seedSource({ id: SOURCE_A_ID, url: SOURCE_A_URL, text: A2_TEXT });
    writes.length = 0;
    const out = await decide(ID_A1, approveBody(0, { acknowledgedFlags: [] }));
    assert.equal(out.status, 409);
    assert.equal(out.body.error, "STALE_CITATION");
    assert.match(out.body.message, /re-extract/);
    assert.equal(writes.length, 0);
    assert.equal(versionDoc(KEY_A, 1).reviewStatus, "pending_review");
    // It can still be rejected.
    assert.equal((await decide(ID_A1, { action: "reject", revision: 0, reason: "The page changed; re-extracting." })).status, 200);
  });

  test("a source that moves between the citation check and the write aborts the approval", async () => {
    await seedA();
    const real = rubricReviewService.runTransaction;
    // The crawl stores a new snapshot after the check, before the transaction.
    rubricReviewService.runTransaction = (async (fn: any) => {
      await seedSource({ id: SOURCE_A_ID, url: SOURCE_A_URL, text: A2_TEXT });
      return fakeRunTransaction(fn);
    }) as any;
    try {
      const out = await decide(ID_A1, approveBody(0));
      assert.equal(out.status, 409);
      assert.equal(out.body.error, "SOURCE_CHANGED");
    } finally {
      rubricReviewService.runTransaction = real;
    }
    assert.equal(versionDoc(KEY_A, 1).reviewStatus, "pending_review");
    assert.equal(headDoc(KEY_A).approvedVersion, null);
    assert.equal(auditEntries().length, 0);
  });

  test("blocking flags must be acknowledged by name; who acknowledged what is recorded", async () => {
    const hash = await seedSource({ id: SOURCE_A_ID, url: SOURCE_A_URL, text: A_TEXT });
    const s = sourceA(hash);
    await write(routeAV1(hash, { extra: { suspiciousPassages: [{ quote: A_LINES.sponsor, sourceId: s.sourceId, url: s.url, contentHash: hash, retrievedAt: new Date(REVIEW_T0).toISOString() }] } }));

    // Not acknowledged: refused, nothing written.
    writes.length = 0;
    let out = await decide(ID_A1, approveBody(0));
    assert.equal(out.status, 409);
    assert.equal(out.body.error, "FLAGS_NOT_ACKNOWLEDGED");
    assert.match(out.body.message, /suspicious_passages:rubric/);
    assert.equal(writes.length, 0);

    // A key the version does not have: a client error, nothing written.
    out = await decide(ID_A1, approveBody(0, { acknowledgedFlags: ["suspicious_passages:rubric", "made_up:rubric"] }));
    assert.equal(out.status, 400);
    assert.equal(out.body.error, "VALIDATION_ERROR");
    assert.equal(writes.length, 0);

    // Acknowledged by name: approved, and the audit entry names the flag.
    out = await decide(ID_A1, approveBody(0, { acknowledgedFlags: ["suspicious_passages:rubric"] }));
    assert.equal(out.status, 200);
    const [entry] = auditEntries();
    assert.equal(entry.by, "admin-uid");
    assert.deepEqual(entry.acknowledgedFlags.map((f: any) => [f.key, f.code, f.target]), [["suspicious_passages:rubric", "suspicious_passages", "rubric"]]);
    assert.equal(typeof entry.acknowledgedFlags[0].message, "string");
  });

  test("per-criterion flags are acknowledged per criterion; standing notices once per version", async () => {
    const hash = await seedSource({ id: SOURCE_A_ID, url: SOURCE_A_URL, text: A_TEXT });
    const base = routeAV1(hash);
    const [ageId, heldId, , barId] = base.criteria.map((c) => c.criterionId);
    await write(
      routeAV1(hash, {
        extra: {
          flags: [
            // Specific things to check, one per criterion.
            { code: "quote_starts_mid_sentence", message: "begins part-way through a sentence", target: ageId },
            { code: "quote_starts_mid_sentence", message: "begins part-way through a sentence", target: heldId },
            { code: "nationality_code_name_mismatch", message: "code and source name differ", target: barId },
            // Limits of this extraction, one each for the whole version.
            { code: "nationality_codes_model_proposed", message: "codes are a model proposal", target: "rubric" },
            { code: "intake_wording_uncited", message: "intake wording is the model's", target: "rubric" },
            { code: "multiple_chunks", message: "read in several excerpts", target: "rubric" },
            { code: "page_ends_mid_sentence", message: "a page ends mid-sentence", target: "rubric" },
            { code: "page_ends_mid_sentence", message: "another source, same notice", target: "rubric" },
            // Harmless: shown, not acknowledged.
            { code: "intake_answer_type_unknown", message: "a client may not render this", target: "some_question" },
            // A code this API has never heard of: must be acknowledged.
            { code: "a_future_flag", message: "added by a later extractor", target: "rubric" },
          ],
        },
      })
    );
    const detail = (await api("GET", `/${ID_A1}`, "t-admin")).body.data;
    const byCategory = (cat: string) => detail.flags.filter((f: any) => f.category === cat).map((f: any) => f.key);
    assert.deepEqual(byCategory("must_acknowledge"), [`quote_starts_mid_sentence:${ageId}`, `quote_starts_mid_sentence:${heldId}`, `nationality_code_name_mismatch:${barId}`, "a_future_flag:rubric"]);
    // One key per notice, however many times extraction raised it.
    assert.deepEqual(byCategory("standing_notice"), ["nationality_codes_model_proposed:rubric", "intake_wording_uncited:rubric", "multiple_chunks:rubric", "page_ends_mid_sentence:rubric"]);
    assert.deepEqual(byCategory("info"), ["intake_answer_type_unknown:some_question"]);
    const required: string[] = detail.approval.requiredAcknowledgements;
    assert.equal(required.length, 8);
    assert.ok(!required.includes("intake_answer_type_unknown:some_question"));

    // Leaving out any single one refuses the approval and names it.
    writes.length = 0;
    for (const left of required) {
      const out = await decide(ID_A1, approveBody(0, { acknowledgedFlags: required.filter((k) => k !== left) }));
      assert.equal(out.status, 409, left);
      assert.equal(out.body.error, "FLAGS_NOT_ACKNOWLEDGED");
      assert.ok(out.body.message.includes(left), left);
    }
    // Acknowledging one criterion's flag does not cover another criterion's.
    assert.match((await decide(ID_A1, approveBody(0, { acknowledgedFlags: required.filter((k) => !k.endsWith(heldId)) }))).body.message, new RegExp(heldId));
    assert.equal(writes.length, 0);

    // All eight named: approved, and each is on the record with who.
    const out = await decide(ID_A1, approveBody(0, { acknowledgedFlags: required }));
    assert.equal(out.status, 200);
    const [entry] = auditEntries();
    assert.equal(entry.by, "admin-uid");
    assert.deepEqual(entry.acknowledgedFlags.map((f: any) => f.key).sort(), [...required].sort());
  });

  test("criteria about intent: a decided polarity resolves the flag; deciding not_assessed needs an acknowledgement", async () => {
    // Extraction found no passage stating the polarity: stored with the flag.
    await seedA({ proposal: null });
    assert.deepEqual(versionDoc(KEY_A, 1).flags.map((f: any) => f.code), ["intent_criteria_without_polarity"]);
    const detail = (await api("GET", `/${ID_A1}`, "t-admin")).body.data;
    assert.deepEqual(detail.approval.requiredAcknowledgements, ["intent_criteria_without_polarity:rubric"]);

    // Deciding "not assessed" leaves the intent criterion with nothing to be scored by.
    let out = await decide(ID_A1, approveBody(0, { intentPolarity: "not_assessed" }));
    assert.equal(out.status, 409);
    assert.equal(out.body.error, "FLAGS_NOT_ACKNOWLEDGED");
    assert.match(out.body.message, /intent_criteria_without_polarity:rubric/);
    assert.equal(versionDoc(KEY_A, 1).reviewStatus, "pending_review");

    // Deciding a real polarity resolves it: no acknowledgement needed.
    out = await decide(ID_A1, approveBody(0, { intentPolarity: "immigrant_intent_penalised" }));
    assert.equal(out.status, 200);
    assert.deepEqual(auditEntries()[0].acknowledgedFlags, []);
  });

  test("not_assessed with intent criteria is approved once acknowledged", async () => {
    await seedA();
    const out = await decide(ID_A1, approveBody(0, { intentPolarity: "not_assessed", acknowledgedFlags: ["intent_criteria_without_polarity:rubric"] }));
    assert.equal(out.status, 200);
    assert.equal(versionDoc(KEY_A, 1).intentPolarity, "not_assessed");
    assert.deepEqual(auditEntries()[0].acknowledgedFlags.map((f: any) => f.code), ["intent_criteria_without_polarity"]);
  });

  test("a version the validator refuses cannot be approved", async () => {
    await seedA();
    // Corrupt the stored content directly: a judgement criterion with a check.
    const doc = versionDoc(KEY_A, 1);
    doc.criteria[2].check = { field: "x.y", op: "present" };
    store.set(`visaRubrics/${KEY_A}/rubricVersions/1`, doc);
    writes.length = 0;
    const out = await decide(ID_A1, approveBody(0));
    assert.equal(out.status, 409);
    assert.equal(out.body.error, "RUBRIC_INVALID");
    assert.match(out.body.message, /judgement_has_check/);
    assert.equal(writes.length, 0);
  });

  test("there is no partial approval: a body that tries is refused, and nothing is written", async () => {
    await seedA();
    writes.length = 0;
    for (const extra of [{ criterionIds: ["crit_x"] }, { criteria: [] }, { reviewedBy: "someone-else" }, { version: 2 }]) {
      const out = await decide(ID_A1, approveBody(0, extra));
      assert.equal(out.status, 400, JSON.stringify(extra));
      assert.equal(out.body.error, "VALIDATION_ERROR");
      assert.match(out.body.message, /approved or rejected whole/);
    }
    assert.equal(writes.length, 0);
  });

  test("a bad action or revision is 400", async () => {
    await seedA();
    for (const payload of [{ action: "publish", revision: 0 }, { action: "approve", intentPolarity: "not_assessed" }, approveBody(-1), approveBody(1.5), approveBody("0" as any), []]) {
      const out = await decide(ID_A1, payload);
      assert.equal(out.status, 400, JSON.stringify(payload));
      assert.equal(out.body.error, "VALIDATION_ERROR");
    }
  });
});

// ============================================
// PATCH /admin/rubrics/:id/review — reject
// ============================================

describe("rubric review: reject", () => {
  test("needs a reason of at least the visa review's minimum length", async () => {
    assert.equal(RUBRIC_REJECT_REASON_MIN_LENGTH, 10, "same minimum as rejectVisaSchema in the portal");
    await seedA();
    writes.length = 0;
    for (const reason of [undefined, "", "   ", "too short", "123456789", " 123456789 "]) {
      const out = await decide(ID_A1, { action: "reject", revision: 0, ...(reason !== undefined ? { reason } : {}) });
      assert.equal(out.status, 400, JSON.stringify(reason));
      assert.equal(out.body.error, "VALIDATION_ERROR");
    }
    assert.equal(writes.length, 0);
    assert.equal((await decide(ID_A1, { action: "reject", revision: 0, reason: "1234567890" })).status, 200);
  });

  test("writes the status, reason, reviewer and timestamp; a first version rejected leaves the route unserved", async () => {
    await seedA();
    const out = await decide(ID_A1, { action: "reject", revision: 0, reason: "  The age rule was misread.  " });
    assert.equal(out.status, 200);
    assert.equal(out.body.data.reviewStatus, "rejected");
    assert.equal(out.body.data.approvedVersion, null);
    const v1 = versionDoc(KEY_A, 1);
    assert.equal(v1.reviewStatus, "rejected");
    assert.equal(v1.rejectReason, "The age rule was misread.");
    assert.equal(v1.reviewedBy, "admin-uid");
    assert.equal(v1.reviewedAt.toMillis(), nowMs);
    assert.equal(v1.revision, 1);
    assert.equal(v1.intentPolarity, null);
    assert.equal(headDoc(KEY_A).approvedVersion, null);
    assert.equal(await rubricStore.getApprovedRubric(ROUTE_A.countryCode, ROUTE_A.visaTypeId), null);
  });

  test("rejecting version 2 leaves the approved version 1 serving, untouched", async () => {
    await seedA();
    await decide(ID_A1, approveBody(0));
    await seedA2();
    const v1Before = JSON.stringify(versionDoc(KEY_A, 1));
    const headBefore = JSON.stringify(headDoc(KEY_A));

    const out = await decide(ID_A2, { action: "reject", revision: 0, reason: "The polarity was read backwards." });
    assert.equal(out.status, 200);
    assert.equal(out.body.data.approvedVersion, 1);
    assert.equal(out.body.data.previousApprovedVersion, 1);
    assert.equal(JSON.stringify(versionDoc(KEY_A, 1)), v1Before, "version 1 was not written");
    assert.equal(JSON.stringify(headDoc(KEY_A)), headBefore, "the head was not written");
    assert.equal(versionDoc(KEY_A, 1).supersededAt, null);
    const serving = await rubricStore.getApprovedRubric(ROUTE_A.countryCode, ROUTE_A.visaTypeId);
    assert.equal(serving?.version, 1);
  });

  test("a stale citation or an unacknowledged flag does not stand in the way of a reject", async () => {
    const hash = await seedSource({ id: SOURCE_A_ID, url: SOURCE_A_URL, text: A_TEXT });
    const s = sourceA(hash);
    await write(routeAV1(hash, { extra: { suspiciousPassages: [{ quote: A_LINES.sponsor, sourceId: s.sourceId, url: s.url, contentHash: hash, retrievedAt: new Date(REVIEW_T0).toISOString() }] } }));
    await seedSource({ id: SOURCE_A_ID, url: SOURCE_A_URL, text: A2_TEXT });
    assert.equal((await decide(ID_A1, { action: "reject", revision: 0, reason: "Flagged passages; re-extract." })).status, 200);
  });
});

// ============================================
// One decision per version
// ============================================

describe("rubric review: one decision per version", () => {
  test("a second decision on a decided version is 409 ALREADY_DECIDED and changes nothing", async () => {
    await seedA();
    await seedB();
    assert.equal((await decide(ID_A1, approveBody(0))).status, 200);
    assert.equal((await decide(ID_B1, { action: "reject", revision: 0, reason: "The tuition rule was misread." })).status, 200);
    const frozen = JSON.stringify([...store.entries()]);
    writes.length = 0;

    for (const [id, payload] of [
      [ID_A1, approveBody(1)],
      [ID_A1, { action: "reject", revision: 1, reason: "Changed my mind about it." }],
      [ID_B1, approveBody(1, { intentPolarity: "dual_intent_permitted" })],
      [ID_B1, { action: "reject", revision: 1, reason: "Rejecting it a second time." }],
    ] as [string, unknown][]) {
      const out = await decide(id, payload, "t-admin-2");
      assert.equal(out.status, 409, `${id} ${JSON.stringify(payload)}`);
      assert.equal(out.body.error, "ALREADY_DECIDED");
      assert.match(out.body.message, /already (approved|rejected)/);
    }
    assert.equal(writes.length, 0);
    assert.equal(JSON.stringify([...store.entries()]), frozen);
  });

  test("a stale revision is 409 REVISION_MISMATCH and changes nothing", async () => {
    await seedA();
    // Another writer bumped the revision since the reviewer opened it.
    const doc = versionDoc(KEY_A, 1);
    store.set(`visaRubrics/${KEY_A}/rubricVersions/1`, { ...doc, revision: 3 });
    writes.length = 0;
    for (const payload of [approveBody(0), { action: "reject", revision: 2, reason: "The age rule was misread." }]) {
      const out = await decide(ID_A1, payload);
      assert.equal(out.status, 409);
      assert.equal(out.body.error, "REVISION_MISMATCH");
      assert.match(out.body.message, /Reload/);
    }
    assert.equal(writes.length, 0);
    assert.equal(versionDoc(KEY_A, 1).reviewStatus, "pending_review");
    // With the revision the reviewer now sees, it goes through.
    assert.equal((await decide(ID_A1, approveBody(3))).body.data.revision, 4);
  });

  test("deciding a version that does not exist is 404", async () => {
    await seedA();
    for (const payload of [approveBody(0), { action: "reject", revision: 0, reason: "No such version here." }]) {
      const out = await decide(rubricVersionId(KEY_A, 7), payload);
      assert.equal(out.status, 404);
      assert.equal(out.body.error, "NOT_FOUND");
    }
  });
});

// ============================================
// Audit trail and the approval seam
// ============================================

describe("rubric review: audit and the approval seam", () => {
  test("every decision writes one audit entry: who, when, route, version, action, reason, previous approved version", async () => {
    await seedA();
    await decide(ID_A1, approveBody(0, { reason: "Read against the page." }));
    await seedA2();
    nowMs += 60_000;
    await decide(ID_A2, { action: "reject", revision: 0, reason: "The polarity was read backwards." }, "t-admin-2");

    const [first, second] = auditEntries();
    assert.equal(auditEntries().length, 2);
    assert.deepEqual(
      { ...first, at: first.at.toMillis(), id: typeof first.id },
      {
        id: "string",
        at: REVIEW_T0 + 7_200_000,
        by: "admin-uid",
        action: "approve",
        routeKey: KEY_A,
        countryCode: ROUTE_A.countryCode,
        visaTypeId: ROUTE_A.visaTypeId,
        version: 1,
        reason: "Read against the page.",
        intentPolarity: "immigrant_intent_penalised",
        intentPolarityProposal: "immigrant_intent_penalised",
        intentPolarityOverridden: false,
        acknowledgedFlags: [],
        previousApprovedVersion: null,
        approvedVersion: 1,
        revisionBefore: 0,
        revisionAfter: 1,
        sourceSetHash: versionDoc(KEY_A, 1).sourceSetHash,
      }
    );
    assert.equal(second.action, "reject");
    assert.equal(second.by, "admin-uid-2");
    assert.equal(second.at.toMillis(), nowMs);
    assert.equal(second.version, 2);
    assert.equal(second.reason, "The polarity was read backwards.");
    assert.equal(second.previousApprovedVersion, 1);
    assert.equal(second.approvedVersion, 1, "version 1 still serves after the reject");
    assert.equal(second.intentPolarity, null);
  });

  test("a refused decision writes no audit entry", async () => {
    await seedA();
    await decide(ID_A1, { action: "approve", revision: 0 });
    await decide(ID_A1, approveBody(5));
    await decide(ID_A1, { action: "reject", revision: 0, reason: "short" });
    assert.equal(auditEntries().length, 0);
  });

  test("onApproved listeners hear each approval once, after it committed; rejects and refusals are silent", async () => {
    await seedA();
    await seedB();
    const events: RubricApprovedEvent[] = [];
    let servedWhenCalled: number | null | undefined;
    const off = rubricReviewService.onApproved(async (e) => {
      events.push(e);
      // Already committed when the listener runs.
      servedWhenCalled = headDoc(e.routeKey).approvedVersion;
    });
    try {
      await decide(ID_A1, approveBody(5)); // refused
      await decide(ID_B1, { action: "reject", revision: 0, reason: "The tuition rule was misread." });
      assert.equal(events.length, 0);
      const out = await decide(ID_A1, approveBody(0));
      assert.equal(events.length, 1);
      assert.equal(servedWhenCalled, 1);
      assert.deepEqual(events[0], {
        routeKey: KEY_A,
        countryCode: ROUTE_A.countryCode,
        visaTypeId: ROUTE_A.visaTypeId,
        version: 1,
        previousApprovedVersion: null,
        approvedBy: "admin-uid",
        approvedAt: new Date(nowMs).toISOString(),
        auditId: out.body.data.auditId,
      });
    } finally {
      off();
    }
  });

  test("a listener that throws cannot fail or undo an approval", async () => {
    await seedA();
    const off = rubricReviewService.onApproved(() => {
      throw new Error("re-assessment queue is down");
    });
    try {
      const out = await decide(ID_A1, approveBody(0));
      assert.equal(out.status, 200);
      assert.equal(headDoc(KEY_A).approvedVersion, 1);
    } finally {
      off();
    }
  });
});

// ============================================
// Unapproved versions stay out of every consumer read
// ============================================

describe("rubric review: nothing unapproved is served", () => {
  test("pending and rejected versions are never returned by getApprovedRubric", async () => {
    await seedA();
    await seedB();
    assert.equal(await rubricStore.getApprovedRubric(ROUTE_A.countryCode, ROUTE_A.visaTypeId), null);
    await decide(ID_B1, { action: "reject", revision: 0, reason: "The tuition rule was misread." });
    assert.equal(await rubricStore.getApprovedRubric(ROUTE_B.countryCode, ROUTE_B.visaTypeId), null);
    // Route A approved, then a newer pending version: version 1 still serves.
    await decide(ID_A1, approveBody(0));
    await seedA2();
    assert.equal((await rubricStore.getApprovedRubric(ROUTE_A.countryCode, ROUTE_A.visaTypeId))?.version, 1);
  });

  test("only the review service reads versions of any status or the review collection group", () => {
    const src = path.join(__dirname, "..", "..", "..", "src");
    /** Every .ts file under `dir`. */
    const walk = (dir: string): string[] =>
      fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : e.name.endsWith(".ts") ? [path.join(dir, e.name)] : []));
    const users = walk(src)
      .filter((f) => /getVersionForReview|collectionGroups\.rubricVersions|rubricReviewHistory/.test(fs.readFileSync(f, "utf8")))
      .map((f) => path.relative(src, f))
      .sort();
    assert.deepEqual(users, [path.join("scrapers", "rubric", "rubric.store.ts"), path.join("services", "rubric-review.service.ts"), path.join("utils", "firebase.ts")]);
    // And the review service is reached from one controller, mounted once, under /admin.
    const importers = walk(src)
      .filter((f) => /rubric-review\.(service|controller|routes)"/.test(fs.readFileSync(f, "utf8")))
      .map((f) => path.relative(src, f))
      .sort();
    assert.deepEqual(importers, ["app.ts", path.join("controllers", "rubric-review.controller.ts"), path.join("routes", "rubric-review.routes.ts")]);
    const app = fs.readFileSync(path.join(src, "app.ts"), "utf8");
    assert.deepEqual([...app.matchAll(/app\.use\("([^"]*)",\s*adminRubricRoutes\)/g)].map((m) => m[1]), ["/admin/rubrics"]);
    // The collections have no client rules.
    const rules = fs.readFileSync(path.join(src, "..", "..", "firestore.rules"), "utf8");
    assert.ok(rules.includes("rubricReviewHistory"), "documented in the backend-only block");
    assert.doesNotMatch(rules, /^\s*match\s+[^\n]*(rubricReviewHistory|rubricVersions|visaRubrics)/m);
  });
});

// ============================================
// Generic: a route is data
// ============================================

describe("rubric review: names no country, route, nationality or role literal", () => {
  const SRC = path.join(__dirname, "..", "..", "..", "src");
  /** The files this issue added. */
  const FILES = ["services/rubric-review.service.ts", "services/rubric-diff.ts", "controllers/rubric-review.controller.ts", "routes/rubric-review.routes.ts"];
  const sources = new Map(FILES.map((f) => [f, fs.readFileSync(path.join(SRC, f), "utf8")]));

  /** Every `key: "value"` string in a seed file, for the given keys. */
  function seedValues(file: string, keys: string[]): string[] {
    const text = fs.readFileSync(path.join(SRC, file), "utf8");
    return [...new Set(keys.flatMap((key) => [...text.matchAll(new RegExp(`\\b${key}:\\s*"([^"]+)"`, "g"))].map((m) => m[1])))];
  }
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  /** Files whose text matches `pattern`. */
  const offenders = (pattern: RegExp) => [...sources].filter(([, text]) => pattern.test(text)).map(([file]) => file);

  const COUNTRY_SEED = path.join("data", "seed-countries-visas.ts");
  const GUIDANCE_SEED = path.join("scrapers", "guidance", "data", "seed-guidance-sources.ts");

  test("no country or visa name, ISO code or visa id from the seed data", () => {
    const names = seedValues(COUNTRY_SEED, ["name"]).filter((n) => /^[A-Z][A-Za-z .'-]+$/.test(n));
    assert.ok(names.length >= 12, "the seed was parsed");
    for (const name of names) assert.deepEqual(offenders(new RegExp(`\\b${esc(name)}\\b`, "i")), [], `name "${name}"`);
    const codes = seedValues(COUNTRY_SEED, ["code", "countryCode"]).filter((c) => /^[A-Z]{2}$/.test(c));
    assert.ok(codes.length >= 12, "the seed was parsed");
    for (const code of codes) assert.deepEqual(offenders(new RegExp(`\\b${code}\\b`)), [], `country code ${code}`);
    const ids = seedValues(COUNTRY_SEED, ["id", "code"]).filter((v) => v.length >= 5 && /[-\d]/.test(v));
    for (const id of ids) assert.deepEqual(offenders(new RegExp(`(^|[^a-z0-9-])${esc(id)}([^a-z0-9-]|$)`, "i")), [], `visa id "${id}"`);
  });

  test("no guidance source id, title or publisher host, and no URL at all", () => {
    for (const v of seedValues(GUIDANCE_SEED, ["id", "title"]).filter((x) => x.length >= 5 && !/^\w+$/.test(x))) {
      assert.deepEqual(offenders(new RegExp(esc(v), "i")), [], `guidance seed value "${v}"`);
    }
    assert.deepEqual(offenders(/https?:\/\/[a-z0-9.-]+\.[a-z]{2,}/i), []);
  });

  test("no role is written as a string literal (the constants are used)", () => {
    for (const role of Object.values(ROLES)) assert.deepEqual(offenders(new RegExp(`["'\`]${role}["'\`]`)), [], `role literal "${role}"`);
  });

  test("the review code makes no model call", () => {
    assert.deepEqual(offenders(/llm-provider|anthropic|LlmProvider|rubricExtractionService/i), []);
  });

  test("the tests themselves cover two different routes", () => {
    assert.notEqual(KEY_A, KEY_B);
    assert.notEqual(ROUTE_A.countryCode, ROUTE_B.countryCode);
    // And a third, made-up one works through the same builders.
    const d = draft({ countryCode: "QZ", visaTypeId: "qz-work_permit" }, [sourceA("b".repeat(64))], []);
    assert.equal(d.routeKey, "QZ_qz-work_permit");
  });
});
