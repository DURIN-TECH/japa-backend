// ============================================
// Unit tests — the /ai handlers and their response shapes (issue #42)
// ============================================
//
// The real controller, shared access check, tier decision and serializer, over
// the in-memory Firestore and a scripted provider. The request and response are
// plain objects: no HTTP server.
//
// Covers: the free body's exact keys; full bodies for paid, agent and admin
// callers; internalCall stripped for clients (including the owner) and kept for
// agents; cross-agency FORBIDDEN on every route; 402 on a free re-run; 404 with
// the route named when no rubric is approved; an unresolved entitlement getting
// the free body; two concurrent POSTs making one job; and the stale flag.

import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import { defineAbilitiesFor, ROLES, type Entitlements } from "@durin-tech/authz";
import { aiCaseOfficerController } from "../../src/controllers/ai-case-officer.controller";
import { aiCaseOfficerService } from "../../src/services/ai-case-officer.service";
import { routeARubric, rubricBook, ScriptedProvider, seedApplication, seedDocument, seedEligibility, seedStatement, seedUser, serviceWith, installAssessmentFakes, resetAll, storedAssessments, allKeys } from "./harness";

/* eslint-disable @typescript-eslint/no-explicit-any */

const BANK = JSON.stringify({
  readable: true,
  values: [
    { field: "funds.balance", value: 3000, unit: "GBP", page: 1, quote: "balance" },
    { field: "accountHolder", value: "Ada Lovelace", unit: null, page: 1, quote: "holder" },
    { field: "statement.endDate", value: "2026-10-31", unit: null, page: 1, quote: "end" },
  ],
});

const PAID: Entitlements = {
  subscriberType: "client",
  subscriberId: "client-1",
  planId: "client_standard",
  status: "active",
  features: ["ai.case_officer"],
  limits: {},
} as unknown as Entitlements;

/** A response that records what the handler sent. */
function mockRes() {
  const res: any = { statusCode: 200, body: undefined };
  res.status = (c: number) => {
    res.statusCode = c;
    return res;
  };
  res.json = (b: unknown) => {
    res.body = b;
    return res;
  };
  return res;
}

/** A request for a principal, with its ability built the way the middleware builds it. */
function req(params: Record<string, string>, authz: { uid: string; role: string; agencyId: string | null }, entitlements: Entitlements | null) {
  return {
    params,
    authz,
    entitlements,
    ability: defineAbilitiesFor(authz as any, entitlements ?? undefined),
  } as any;
}

const OWNER = { uid: "client-1", role: ROLES.CLIENT, agencyId: null };
const AGENT = { uid: "agent-1", role: ROLES.AGENT, agencyId: "agency-1" };
const OTHER_AGENCY = { uid: "agent-9", role: ROLES.AGENT, agencyId: "agency-2" };
const ADMIN = { uid: "admin-1", role: ROLES.ADMIN, agencyId: null };

const originalDeps = (aiCaseOfficerService as any).deps;

/** Point the singleton (the one the controller uses) at a scripted provider. */
function useProvider(provider: ScriptedProvider, settings: Record<string, unknown> = {}) {
  const svc = serviceWith(provider, settings);
  Object.assign(aiCaseOfficerService, { deps: (svc as any).deps });
  return svc;
}

/** Seed one applicant case with documents and a statement. */
function seedCase(appId = "app-1") {
  seedApplication({ id: appId, agencyId: "agency-1", agentId: "agent-1" });
  seedUser("client-1", "Ada", "Lovelace");
  seedEligibility({ nationality: "IN", score: 80 });
  seedDocument({ id: `doc-${appId}`, applicationId: appId, key: "bank", label: "Bank statement" });
  seedStatement({ id: `stmt-${appId}`, applicationId: appId, text: "I will return home at the end of the visit." });
}

/** Run the queued job for an assessment id, as the worker would. */
async function work(assessmentId: string) {
  await aiCaseOfficerService.runJob(assessmentId);
}

describe("the /ai handlers", () => {
  before(() => {});
  after(() => {
    Object.assign(aiCaseOfficerService, { deps: originalDeps });
  });

  beforeEach(async () => {
    resetAll();
    await installAssessmentFakes();
    rubricBook.set("AA_route-a", routeARubric());
  });

  test("a free owner gets 202, then the free body with exactly readiness and topIssues", async () => {
    seedCase();
    const provider = new ScriptedProvider((r) => (r.role === "extraction" ? BANK : JSON.stringify({ findings: [], strengths: [], statementNotes: [], suspiciousPassages: [] })));
    useProvider(provider);

    const posted = mockRes();
    await aiCaseOfficerController.assess(req({ id: "app-1" }, OWNER, null), posted);
    assert.equal(posted.statusCode, 202);
    const id = posted.body.data.assessmentId;
    await work(id);

    const got = mockRes();
    await aiCaseOfficerController.latest(req({ id: "app-1" }, OWNER, null), got);
    assert.equal(got.statusCode, 200);
    assert.equal(got.body.data.meta.tier, "free");
    assert.deepEqual(Object.keys(got.body.data.data).sort(), ["readiness", "topIssues"]);
    const keys = allKeys(got.body.data.data);
    for (const forbidden of ["refusalGrounds", "credibilityFlags", "strengths", "statementFindings", "insufficientInformation", "stageOutcomes", "score", "sourceQuote", "sourceUrl", "ruleRef", "internalCall"]) {
      assert.ok(!keys.includes(forbidden), `the free body must not carry ${forbidden}`);
    }
  });

  test("an unresolved entitlement for a paid-looking owner gets the free body, not the full review", async () => {
    seedCase();
    const provider = new ScriptedProvider((r) => (r.role === "extraction" ? BANK : JSON.stringify({ findings: [], strengths: [], statementNotes: [], suspiciousPassages: [] })));
    useProvider(provider);
    const posted = mockRes();
    await aiCaseOfficerController.assess(req({ id: "app-1" }, OWNER, null), posted);
    await work(posted.body.data.assessmentId);
    const got = mockRes();
    await aiCaseOfficerController.latest(req({ id: "app-1" }, OWNER, null), got);
    assert.equal(got.body.data.meta.tier, "free");
    assert.equal(got.body.data.data.refusalGrounds, undefined);
  });

  test("a paid owner gets the full body, and the client view has no internalCall at any depth", async () => {
    seedCase();
    const provider = new ScriptedProvider((r) => (r.role === "extraction" ? BANK : JSON.stringify({ findings: [], strengths: [], statementNotes: [], suspiciousPassages: [] })));
    useProvider(provider);
    const posted = mockRes();
    await aiCaseOfficerController.assess(req({ id: "app-1" }, OWNER, PAID), posted);
    await work(posted.body.data.assessmentId);
    const got = mockRes();
    await aiCaseOfficerController.latest(req({ id: "app-1" }, OWNER, PAID), got);
    assert.equal(got.body.data.meta.tier, "full");
    assert.ok(got.body.data.data.stageOutcomes, "the full body carries the stage outcomes");
    assert.ok(!allKeys(got.body.data).includes("internalCall"), "no internalCall reaches the client");
  });

  test("the assigned agent gets internalCall; a colleague in another agency gets FORBIDDEN", async () => {
    seedCase();
    const provider = new ScriptedProvider((r) => (r.role === "extraction" ? BANK : JSON.stringify({ findings: [], strengths: [], statementNotes: [], suspiciousPassages: [] })));
    useProvider(provider);
    const posted = mockRes();
    await aiCaseOfficerController.assess(req({ id: "app-1" }, AGENT, PAID), posted);
    await work(posted.body.data.assessmentId);

    const agentView = mockRes();
    await aiCaseOfficerController.latest(req({ id: "app-1" }, AGENT, PAID), agentView);
    assert.equal(agentView.statusCode, 200);
    assert.ok(allKeys(agentView.body.data).includes("internalCall"));

    const otherAgency = mockRes();
    await aiCaseOfficerController.latest(req({ id: "app-1" }, OTHER_AGENCY, PAID), otherAgency);
    assert.equal(otherAgency.statusCode, 403);
    assert.equal(otherAgency.body.error, "FORBIDDEN");

    const otherById = mockRes();
    await aiCaseOfficerController.byId(req({ id: posted.body.data.assessmentId }, OTHER_AGENCY, PAID), otherById);
    assert.equal(otherById.statusCode, 403, "the assessment id alone is not enough");

    const postOther = mockRes();
    await aiCaseOfficerController.assess(req({ id: "app-1" }, OTHER_AGENCY, PAID), postOther);
    assert.equal(postOther.statusCode, 403);
  });

  test("an admin gets the full body with internalCall", async () => {
    seedCase();
    const provider = new ScriptedProvider((r) => (r.role === "extraction" ? BANK : JSON.stringify({ findings: [], strengths: [], statementNotes: [], suspiciousPassages: [] })));
    useProvider(provider);
    const posted = mockRes();
    await aiCaseOfficerController.assess(req({ id: "app-1" }, ADMIN, null), posted);
    await work(posted.body.data.assessmentId);
    const got = mockRes();
    await aiCaseOfficerController.byId(req({ id: posted.body.data.assessmentId }, ADMIN, null), got);
    assert.equal(got.body.data.meta.tier, "full");
    assert.ok(allKeys(got.body.data).includes("internalCall"));
  });

  test("a free caller's re-run after a changed document is 402 UPGRADE_REQUIRED", async () => {
    seedCase();
    const provider = new ScriptedProvider((r) => (r.role === "extraction" ? BANK : JSON.stringify({ findings: [], strengths: [], statementNotes: [], suspiciousPassages: [] })));
    useProvider(provider);
    const first = mockRes();
    await aiCaseOfficerController.assess(req({ id: "app-1" }, OWNER, null), first);
    await work(first.body.data.assessmentId);

    seedDocument({ id: "doc-new", applicationId: "app-1", key: "bank-new", label: "New statement" });
    const rerun = mockRes();
    await aiCaseOfficerController.assess(req({ id: "app-1" }, OWNER, null), rerun);
    assert.equal(rerun.statusCode, 402);
    assert.equal(rerun.body.error, "UPGRADE_REQUIRED");
    assert.equal(storedAssessments("app-1").length, 1);
  });

  test("no approved rubric answers 404 and names the route", async () => {
    seedApplication({ id: "app-2", visaTypeId: "route-x", agentId: "agent-1", agencyId: "agency-1" });
    useProvider(new ScriptedProvider(() => "{}"));
    const res = mockRes();
    await aiCaseOfficerController.assess(req({ id: "app-2" }, OWNER, null), res);
    assert.equal(res.statusCode, 404);
    assert.equal(res.body.error, "NO_APPROVED_RUBRIC");
    assert.ok(res.body.message.includes("AA_route-x"), "the message names the route");
  });

  test("two concurrent POSTs make one job", async () => {
    seedCase();
    useProvider(new ScriptedProvider(() => "{}"));
    const a = mockRes();
    const b = mockRes();
    await Promise.all([
      aiCaseOfficerController.assess(req({ id: "app-1" }, OWNER, null), a),
      aiCaseOfficerController.assess(req({ id: "app-1" }, OWNER, null), b),
    ]);
    assert.equal(a.statusCode, 202);
    assert.equal(b.statusCode, 202);
    assert.equal(a.body.data.assessmentId, b.body.data.assessmentId);
    assert.equal(storedAssessments("app-1").length, 1);
  });

  test("the stale flag is set when the approved rubric has moved on", async () => {
    seedCase();
    const provider = new ScriptedProvider((r) => (r.role === "extraction" ? BANK : JSON.stringify({ findings: [], strengths: [], statementNotes: [], suspiciousPassages: [] })));
    useProvider(provider);
    const posted = mockRes();
    await aiCaseOfficerController.assess(req({ id: "app-1" }, OWNER, null), posted);
    await work(posted.body.data.assessmentId);
    rubricBook.set("AA_route-a", routeARubric({ version: 2 }));
    const got = mockRes();
    await aiCaseOfficerController.latest(req({ id: "app-1" }, OWNER, null), got);
    assert.equal(got.body.data.meta.stale, true);
    assert.equal(got.body.data.meta.rubricVersion, 1);
  });

  test("no assessment yet answers 404 NO_ASSESSMENT", async () => {
    seedCase();
    const res = mockRes();
    await aiCaseOfficerController.latest(req({ id: "app-1" }, OWNER, null), res);
    assert.equal(res.statusCode, 404);
    assert.equal(res.body.error, "NO_ASSESSMENT");
  });

  test("an unknown application is 404, and a cross-agency agent sees no assessment for it", async () => {
    const res = mockRes();
    await aiCaseOfficerController.assess(req({ id: "missing" }, OWNER, null), res);
    assert.equal(res.statusCode, 404);
    seedCase();
    const other = mockRes();
    await aiCaseOfficerController.latest(req({ id: "app-1" }, OTHER_AGENCY, PAID), other);
    assert.equal(other.statusCode, 403);
  });
});
