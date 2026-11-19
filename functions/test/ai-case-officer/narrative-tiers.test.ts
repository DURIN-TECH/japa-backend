// ============================================
// Unit tests — what each caller is sent, with the narrative (issue #384)
// ============================================
//
// The real controller, shared access check, tier + working decision and
// serializer, over the in-memory Firestore and a scripted provider (no real
// model). Routes: GET /ai/applications/:id/assessment (`latest`),
// GET /ai/assessments/:id (`byId`) and POST /ai/applications/:id/assess
// (`assess`, unchanged inputs -> 200 with the stored result).
//
// The three levels, decided on the server:
//   free            no ai.case_officer, or entitlements unresolved: unchanged
//   full (reading)  client with ai.case_officer only: band, blocking rule, top
//                   issues, narrative, country context; NO rule-by-rule findings
//   full + working  client with both keys, or any staff caller: today's full
//                   body plus narrative and blockingRule

import assert from "node:assert/strict";
import { after, beforeEach, describe, test } from "node:test";
import { defineAbilitiesFor, FEATURES, ROLES, type Entitlements } from "@durin-tech/authz";
import { aiCaseOfficerController } from "../../src/controllers/ai-case-officer.controller";
import { aiCaseOfficerService } from "../../src/services/ai-case-officer.service";
import { workingFor } from "../../src/services/ai/tier-serializer";
import type { LlmRequest } from "../../src/services/ai/llm-provider";
import { store } from "../helpers/fake-firestore";
import { routeARubric, rubricBook, ScriptedProvider, seedApplication, seedDocument, seedEligibility, seedStatement, seedUser, serviceWith, installAssessmentFakes, installIntakeFake, resetAll, allKeys } from "./harness";

/* eslint-disable @typescript-eslint/no-explicit-any */

// ----- Fixtures -----

const BANK = JSON.stringify({
  readable: true,
  values: [
    { field: "funds.balance", value: 3000, unit: "GBP", page: 1, quote: "balance" },
    { field: "accountHolder", value: "Ada Lovelace", unit: null, page: 1, quote: "holder" },
    { field: "statement.endDate", value: "2026-10-31", unit: null, page: 1, quote: "end" },
  ],
});

/** One concern, so the full body has findings with citations in it. */
const JUDGE = JSON.stringify({
  findings: [{ criterionId: "a-genuine", detail: "The statement gives no date of return.", whatWouldHelp: "Add your return booking.", concern: true }],
  strengths: [{ criterionId: "a-intent", detail: "Clear ties to home." }],
  statementNotes: [{ criterionId: "a-genuine", detail: "No return date.", blockIndex: 0 }],
  suspiciousPassages: [],
});

/** A grounded narrative for the band the request gives. */
function narrative(req: LlmRequest): string {
  const lead = /Required opening of the conclusion: "([^"]+)"/.exec(req.user)![1];
  return JSON.stringify({
    paragraphs: ["You told us you will return home at the end of the visit."],
    conclusion: `${lead} you will leave at the end of your visit.`,
    nextSteps: ["Add your return booking."],
  });
}

/** Entitlements with the given features (resolved, active). */
function entitled(features: string[]): Entitlements {
  return { subscriberType: "client", subscriberId: "client-1", planId: "client_standard", status: "active", features, limits: {} } as unknown as Entitlements;
}
const CASE_OFFICER = entitled([FEATURES.AI_CASE_OFFICER]);
const WITH_WORKING = entitled([FEATURES.AI_CASE_OFFICER, FEATURES.AI_REVIEW_WORKING]);
const WORKING_ONLY = entitled([FEATURES.AI_REVIEW_WORKING]);

const CLIENT = { uid: "client-1", role: ROLES.CLIENT, agencyId: null };
const OTHER_CLIENT = { uid: "client-2", role: ROLES.CLIENT, agencyId: null };
const AGENT = { uid: "agent-1", role: ROLES.AGENT, agencyId: "agency-1" };
const OWNER = { uid: "owner-1", role: ROLES.OWNER, agencyId: "agency-1" };
const ADMIN = { uid: "admin-1", role: ROLES.ADMIN, agencyId: null };
const OTHER_AGENCY_AGENT = { uid: "agent-9", role: ROLES.AGENT, agencyId: "agency-2" };

/** The keys of the rule-by-rule working, which a reading body must not carry at any depth. */
const WORKING_KEYS = ["refusalGrounds", "credibilityFlags", "strengths", "statementFindings", "insufficientInformation", "statement", "internalCall", "score", "sourceUrl", "sourceQuote"];

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
  return { params, authz, entitlements, ability: defineAbilitiesFor(authz as any, entitlements ?? undefined) } as any;
}

const originalDeps = (aiCaseOfficerService as any).deps;
let restoreIntake: () => void = () => {};

/** Seed the case and run its review as an admin (so the stored result exists). Returns the assessment id. */
async function reviewed(opts: { nationality?: string } = {}): Promise<string> {
  seedApplication({ id: "app-1", agencyId: "agency-1", agentId: "agent-1" });
  seedUser("client-1", "Ada", "Lovelace");
  seedEligibility({ nationality: opts.nationality ?? "IN", score: 80 });
  seedDocument({ id: "doc-1", applicationId: "app-1", key: "bank", label: "Bank statement" });
  seedStatement({ id: "stmt-1", applicationId: "app-1", text: "I will return home at the end of the visit." });
  const provider = new ScriptedProvider((r) => (r.role === "extraction" ? BANK : r.role === "judgement" ? JUDGE : narrative(r)));
  Object.assign(aiCaseOfficerService, { deps: (serviceWith(provider) as any).deps });
  const posted = mockRes();
  await aiCaseOfficerController.assess(req({ id: "app-1" }, ADMIN, null), posted);
  assert.equal(posted.statusCode, 202);
  await aiCaseOfficerService.runJob(posted.body.data.assessmentId);
  return posted.body.data.assessmentId;
}

/** A principal the handlers read. */
type Principal = { uid: string; role: string; agencyId: string | null };

/** GET latest as a caller; returns `{ meta, data }`. */
async function latestAs(authz: Principal, ent: Entitlements | null) {
  const res = mockRes();
  await aiCaseOfficerController.latest(req({ id: "app-1" }, authz, ent), res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  return res.body.data;
}

/** Every key at any depth of `data`, OUTSIDE its `blockingRule`. */
function keysOutsideBlockingRule(data: Record<string, unknown>): string[] {
  const { blockingRule: _blockingRule, ...rest } = data;
  void _blockingRule;
  return allKeys(rest);
}

describe("the working decision (#384)", () => {
  test("workingFor: staff on the full tier; clients only with both keys; fail closed otherwise", () => {
    assert.equal(workingFor(ROLES.ADMIN, null), true);
    assert.equal(workingFor(ROLES.AGENT, CASE_OFFICER), true);
    assert.equal(workingFor(ROLES.OWNER, CASE_OFFICER), true);
    assert.equal(workingFor(ROLES.AGENT, entitled([])), false, "staff on the free tier: no working");
    assert.equal(workingFor(ROLES.CLIENT, CASE_OFFICER), false);
    assert.equal(workingFor(ROLES.CLIENT, WITH_WORKING), true);
    assert.equal(workingFor(ROLES.CLIENT, WORKING_ONLY), false, "the working alone does not lift the free tier");
    assert.equal(workingFor(ROLES.CLIENT, null), false, "unresolved: fail closed");
    assert.equal(workingFor(ROLES.CLIENT, { ...WITH_WORKING, status: "past_due" } as Entitlements), false, "a lapsed plan holds nothing");
    assert.equal(workingFor(undefined, WITH_WORKING), false, "no role: fail closed");
  });
});

describe("what each caller is sent (#384)", () => {
  after(() => {
    Object.assign(aiCaseOfficerService, { deps: originalDeps });
    restoreIntake();
  });

  beforeEach(async () => {
    resetAll();
    await installAssessmentFakes();
    restoreIntake = await installIntakeFake();
    rubricBook.set("AA_route-a", routeARubric());
  });

  test("client with ai.case_officer only: the reading body, from a whitelist, with no finding key at any depth", async () => {
    await reviewed();
    const { meta, data } = await latestAs(CLIENT, CASE_OFFICER);
    assert.equal(meta.tier, "full");
    assert.equal(meta.working, false);
    assert.deepEqual(Object.keys(data).sort(), ["blockingRule", "hasBlockingRule", "narrative", "readiness", "topIssues"]);
    for (const k of WORKING_KEYS) assert.ok(!keysOutsideBlockingRule(data).includes(k), `the reading body must not carry ${k}`);
    assert.ok(data.narrative, "the narrative is served");
    assert.deepEqual(Object.keys(data.narrative).sort(), ["conclusion", "nextSteps", "paragraphs"]);
    for (const t of data.topIssues) assert.deepEqual(Object.keys(t).sort(), ["criterionId", "title"]);
    assert.equal(data.blockingRule, null);
  });

  test("the reading body carries countryContext when one is stored, and still no finding key", async () => {
    const id = await reviewed();
    const doc = store.get(`applicationAssessments/${id}`) as any;
    store.set(`applicationAssessments/${id}`, {
      ...doc,
      countryContext: { status: "available", destination: "AA", categoryKey: "visit", categoryLabel: "Visit", nationalityCode: "IN", nationalityName: "India", period: { label: "2025", start: "2025-01-01", end: "2025-12-31", quarters: [] }, nationality: null, allNationalities: null, evidenceAreas: [{ id: "a-genuine", label: "Genuine visit factors" }], source: { publisher: "x", pageUrl: "https://example.test", fileUrl: "https://example.test/f", fileName: "f", tableNames: [], releaseLabel: null, retrievedAt: "2026-01-01T00:00:00.000Z" }, text: { headline: "h", lines: [] } },
    });
    const { data } = await latestAs(CLIENT, CASE_OFFICER);
    assert.deepEqual(Object.keys(data).sort(), ["blockingRule", "countryContext", "hasBlockingRule", "narrative", "readiness", "topIssues"]);
    for (const k of WORKING_KEYS) assert.ok(!keysOutsideBlockingRule(data).includes(k), `must not carry ${k}`);
  });

  test("client with both keys: meta.working true, today's client full body plus narrative and blockingRule", async () => {
    await reviewed();
    const { meta, data } = await latestAs(CLIENT, WITH_WORKING);
    assert.equal(meta.tier, "full");
    assert.equal(meta.working, true);
    for (const k of ["refusalGrounds", "credibilityFlags", "strengths", "statementFindings", "insufficientInformation", "statement", "stageOutcomes"]) assert.ok(k in data, `carries ${k}`);
    assert.ok(data.narrative);
    assert.ok("blockingRule" in data);
    const keys = allKeys(data);
    for (const k of ["internalCall", "changeSummary", "reviewRequired", "reviewNotifiedAt", "usage", "costUsd", "suspiciousContent", "models"]) assert.ok(!keys.includes(k), `still strips ${k}`);
  });

  test("client with ai.review_working but NOT ai.case_officer: free tier, unchanged", async () => {
    await reviewed();
    const { meta, data } = await latestAs(CLIENT, WORKING_ONLY);
    assert.equal(meta.tier, "free");
    assert.equal(meta.working, false);
    assert.deepEqual(Object.keys(data).sort(), ["hasBlockingRule", "readiness", "topIssues"]);
  });

  test("client whose entitlements did not resolve: free tier, unchanged (fail closed)", async () => {
    await reviewed();
    const { meta, data } = await latestAs(CLIENT, null);
    assert.equal(meta.tier, "free");
    assert.equal(meta.working, false);
    assert.deepEqual(Object.keys(data).sort(), ["hasBlockingRule", "readiness", "topIssues"]);
    assert.equal(data.narrative, undefined, "the free body has no narrative");
  });

  test("agent, owner and admin on the full tier: today's full body plus the two keys, meta.working true", async () => {
    await reviewed();
    for (const [who, ent] of [[AGENT, CASE_OFFICER], [OWNER, CASE_OFFICER], [ADMIN, null]] as const) {
      const { meta, data } = await latestAs(who, ent);
      assert.equal(meta.tier, "full", who.role);
      assert.equal(meta.working, true, who.role);
      assert.ok(data.refusalGrounds && data.credibilityFlags && data.statementFindings, who.role);
      assert.ok(data.narrative, who.role);
      assert.ok("blockingRule" in data, who.role);
      assert.ok(allKeys(data).includes("internalCall"), `${who.role} keeps internalCall`);
    }
  });

  test("the free body is unchanged apart from meta.working = false", async () => {
    await reviewed();
    const { meta, data } = await latestAs(CLIENT, entitled([]));
    assert.equal(meta.tier, "free");
    assert.equal(meta.working, false);
    assert.deepEqual(Object.keys(data).sort(), ["hasBlockingRule", "readiness", "topIssues"]);
    for (const t of data.topIssues) assert.deepEqual(Object.keys(t).sort(), ["criterionId", "title"]);
  });

  test("a blocking rule on the full tier without the working: blockingRule carries the bar's title, ref, quote and link", async () => {
    await reviewed({ nationality: "PK" });
    const bar = routeARubric().criteria.find((c) => c.criterionId === "a-bar")!;
    const { meta, data } = await latestAs(CLIENT, CASE_OFFICER);
    assert.equal(meta.working, false);
    assert.equal(data.hasBlockingRule, true);
    assert.deepEqual(data.blockingRule, { criterionId: "a-bar", title: bar.title, ruleRef: null, sourceQuote: bar.source.quote, sourceUrl: bar.source.url });
    assert.equal(data.narrative, null, "no narrative on a bar hit");
    for (const k of WORKING_KEYS) assert.ok(!keysOutsideBlockingRule(data).includes(k), `must not carry ${k} outside blockingRule`);
    // The free tier keeps the generic card: a boolean, no rule text.
    const free = await latestAs(CLIENT, null);
    assert.equal(free.data.hasBlockingRule, true);
    assert.equal(free.data.blockingRule, undefined);
  });

  test("GET /ai/assessments/:id and POST with unchanged inputs (200) answer through the same gate", async () => {
    const id = await reviewed();
    const byId = mockRes();
    await aiCaseOfficerController.byId(req({ id }, CLIENT, CASE_OFFICER), byId);
    assert.equal(byId.statusCode, 200);
    assert.equal(byId.body.data.meta.working, false);
    assert.ok(!("refusalGrounds" in byId.body.data.data));

    const again = mockRes();
    await aiCaseOfficerController.assess(req({ id: "app-1" }, CLIENT, CASE_OFFICER), again);
    assert.equal(again.statusCode, 200, "unchanged inputs: the stored result");
    assert.equal(again.body.data.meta.working, false);
    assert.deepEqual(Object.keys(again.body.data.data).sort(), ["blockingRule", "hasBlockingRule", "narrative", "readiness", "topIssues"]);

    const againWorking = mockRes();
    await aiCaseOfficerController.assess(req({ id: "app-1" }, CLIENT, WITH_WORKING), againWorking);
    assert.equal(againWorking.statusCode, 200);
    assert.equal(againWorking.body.data.meta.working, true);
    assert.ok("refusalGrounds" in againWorking.body.data.data);
  });

  test("a client who does not own the application, and an agent of another agency, still get 403", async () => {
    const id = await reviewed();
    for (const who of [OTHER_CLIENT, OTHER_AGENCY_AGENT]) {
      const latest = mockRes();
      await aiCaseOfficerController.latest(req({ id: "app-1" }, who, WITH_WORKING), latest);
      assert.equal(latest.statusCode, 403, `${who.uid} latest`);
      const one = mockRes();
      await aiCaseOfficerController.byId(req({ id }, who, WITH_WORKING), one);
      assert.equal(one.statusCode, 403, `${who.uid} byId`);
      const post = mockRes();
      await aiCaseOfficerController.assess(req({ id: "app-1" }, who, WITH_WORKING), post);
      assert.equal(post.statusCode, 403, `${who.uid} assess`);
    }
  });

  test("an assessment stored before #384 (no narrative, no blockingRule key) serves narrative null and a derived blockingRule", async () => {
    const id = await reviewed({ nationality: "PK" });
    const { narrative: _n, blockingRule: _b, ...old } = store.get(`applicationAssessments/${id}`) as any;
    void _n;
    void _b;
    store.set(`applicationAssessments/${id}`, old);
    const bar = routeARubric().criteria.find((c) => c.criterionId === "a-bar")!;
    const expected = { criterionId: "a-bar", title: bar.title, ruleRef: null, sourceQuote: bar.source.quote, sourceUrl: bar.source.url };

    const reading = await latestAs(CLIENT, CASE_OFFICER);
    assert.equal(reading.data.narrative, null);
    assert.deepEqual(reading.data.blockingRule, expected);

    const staff = await latestAs(AGENT, CASE_OFFICER);
    assert.equal(staff.data.narrative, null);
    assert.deepEqual(staff.data.blockingRule, expected);
  });

  test("an old assessment with no bar and no narrative key serves both as null", async () => {
    const id = await reviewed();
    const { narrative: _n, blockingRule: _b, ...old } = store.get(`applicationAssessments/${id}`) as any;
    void _n;
    void _b;
    store.set(`applicationAssessments/${id}`, old);
    const { data } = await latestAs(CLIENT, CASE_OFFICER);
    assert.equal(data.narrative, null);
    assert.equal(data.blockingRule, null);
  });
});
