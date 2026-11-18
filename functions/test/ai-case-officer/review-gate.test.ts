// ============================================
// Unit tests — "enough to review" gate and the free-review rule (issue #309)
// ============================================
//
// The real controller, access check, tier decision and intake service, over
// the in-memory Firestore and a scripted provider (no network, no model).
//
// "Enough to review" = the route's intake (when it has one) has no open
// required question AND at least one document is uploaded, not counting the
// refusal letter. Otherwise POST /ai/applications/:id/assess answers
// 422 NOT_ENOUGH_TO_REVIEW, writes nothing and calls no model.
//
// Covers: every missing combination; a route with no intake; a refusal letter
// alone; the same 422 for paid callers; access (403) and missing (404) checks
// before the gate; no rubric still 404; the free review not used up by an
// earlier "nothing to read" result (while a real one, or a bar hit, still
// counts); the status trigger unchanged; and a 500 instead of a hung request.

import assert from "node:assert/strict";
import { after, beforeEach, describe, test } from "node:test";
import { Timestamp } from "firebase-admin/firestore";
import { defineAbilitiesFor, ROLES, type Entitlements } from "@durin-tech/authz";
import { aiCaseOfficerController } from "../../src/controllers/ai-case-officer.controller";
import { aiCaseOfficerService, isNoModelCallResult } from "../../src/services/ai-case-officer.service";
import type { VisaRubric } from "../../src/types/rubric";
import type { ApplicationStatus } from "../../src/types";
import { INTAKE_EDITABLE_STATUSES } from "../../src/services/intake.service";
import { store } from "../helpers/fake-firestore";
import {
  installAssessmentFakes,
  installIntakeFake,
  resetAll,
  routeARubric,
  rubricBook,
  ScriptedProvider,
  seedApplication,
  seedDocument,
  seedEligibility,
  seedUser,
  serviceWith,
  storedAssessments,
} from "./harness";

/* eslint-disable @typescript-eslint/no-explicit-any */

// ----- Fixtures -----

/** A bank statement extraction the scripted provider answers with. */
const BANK = JSON.stringify({
  readable: true,
  values: [
    { field: "funds.balance", value: 3000, unit: "GBP", page: 1, quote: "balance" },
    { field: "accountHolder", value: "Ada Lovelace", unit: null, page: 1, quote: "holder" },
    { field: "statement.endDate", value: "2026-10-31", unit: null, page: 1, quote: "end" },
  ],
});

/** An empty judgement answer. */
const JUDGE = JSON.stringify({ findings: [], strengths: [], statementNotes: [], suspiciousPassages: [] });

/** A paid client's entitlements (the case-officer feature). */
const PAID: Entitlements = {
  subscriberType: "client",
  subscriberId: "client-1",
  planId: "client_standard",
  status: "active",
  features: ["ai.case_officer"],
  limits: {},
} as unknown as Entitlements;

const OWNER = { uid: "client-1", role: ROLES.CLIENT, agencyId: null };
const OTHER_AGENCY = { uid: "agent-9", role: ROLES.AGENT, agencyId: "agency-2" };

/**
 * Route A with an intake: two required questions (read by an always-applicable
 * judgement rule, so both are visible) and one optional one.
 */
function routeAWithIntake(): VisaRubric {
  return {
    ...routeARubric(),
    intakeQuestions: [
      { id: "q-purpose", label: "Purpose of the visit", answerType: "text", required: true, criterionIds: ["a-genuine"] },
      { id: "q-return", label: "When will you return?", answerType: "text", required: true, criterionIds: ["a-genuine"] },
      { id: "q-notes", label: "Anything else?", answerType: "text", required: false, criterionIds: ["a-genuine"] },
    ],
  } as unknown as VisaRubric;
}

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
/** (#309) Puts the real intake reader back after the suite. */
let restoreIntake: () => void = () => {};

/** Point the singleton (the one the controller uses) at a scripted provider. */
function useProvider(provider: ScriptedProvider) {
  const svc = serviceWith(provider);
  Object.assign(aiCaseOfficerService, { deps: (svc as any).deps });
}

/** A provider that answers every role, and records each call. */
function answeringProvider() {
  return new ScriptedProvider((r) => (r.role === "extraction" ? BANK : JUDGE));
}

/** An application on route A for client-1, in agency-1, with no documents yet. */
// (#309 fix round) The status decides whether the intake can still be edited
// (INTAKE_EDITABLE_STATUSES). The default is an editable one, where the gate
// asks for the intake; past those statuses only the documents part applies.
function seedEmptyCase(appId = "app-1", status: ApplicationStatus = "pending_documents") {
  seedApplication({ id: appId, agencyId: "agency-1", agentId: "agent-1" });
  const cur = store.get(`applications/${appId}`) as Record<string, unknown>;
  store.set(`applications/${appId}`, { ...cur, status });
  seedUser("client-1", "Ada", "Lovelace");
  seedEligibility({ nationality: "IN", score: 80 });
}

/** Save intake answers on the application, the way the intake service stores them. */
function answerIntake(appId: string, answers: Record<string, unknown>) {
  const cur = store.get(`applications/${appId}`) as Record<string, unknown>;
  store.set(`applications/${appId}`, { ...cur, intake: { answers, routeKey: "AA_route-a", rubricVersion: 1, updatedAt: Timestamp.fromMillis(5_000) } });
}

/** Top-level assessment documents for an application (proposed actions live in a subcollection). */
function assessmentDocs(appId: string): any[] {
  return storedAssessments(appId).filter((a) => a.path.split("/").length === 2);
}

/** POST /assess as a caller, returning the recorded response. */
async function post(appId: string, who: { uid: string; role: string; agencyId: string | null } = OWNER, ent: Entitlements | null = null) {
  const res = mockRes();
  await aiCaseOfficerController.assess(req({ id: appId }, who, ent), res);
  return res;
}

/** Assert a 422 NOT_ENOUGH_TO_REVIEW with exactly these parts, and that nothing was written or called. */
function assertNotEnough(res: any, provider: ScriptedProvider, missing: string[], openRequiredCount: number) {
  assert.equal(res.statusCode, 422);
  assert.equal(res.body.success, false);
  assert.equal(res.body.error, "NOT_ENOUGH_TO_REVIEW");
  assert.equal(typeof res.body.message, "string");
  assert.deepEqual(res.body.missing, missing);
  assert.equal(res.body.openRequiredCount, openRequiredCount);
  assert.equal(assessmentDocs("app-1").length, 0, "no assessment document is written");
  assert.equal(provider.requests.length, 0, "no model call is made");
}

describe("POST /assess: the enough-to-review gate (#309)", () => {
  after(() => {
    Object.assign(aiCaseOfficerService, { deps: originalDeps });
    restoreIntake();
  });

  beforeEach(async () => {
    resetAll();
    await installAssessmentFakes();
    // (#309) The POST's enough-to-review gate reads the intake through the book.
    restoreIntake = await installIntakeFake();
    rubricBook.set("AA_route-a", routeAWithIntake());
  });

  // ----- What is missing -----

  test("an empty application gets 422 with intake and documents missing, and nothing is written", async () => {
    seedEmptyCase();
    const provider = answeringProvider();
    useProvider(provider);
    const res = await post("app-1");
    assertNotEnough(res, provider, ["intake", "documents"], 2);
    assert.match(res.body.message, /2 required questions/);
    assert.match(res.body.message, /at least one document/);
  });

  test("intake done but no documents gets 422 with documents missing", async () => {
    seedEmptyCase();
    answerIntake("app-1", { "q-purpose": "Tourism", "q-return": "In two weeks" });
    const provider = answeringProvider();
    useProvider(provider);
    assertNotEnough(await post("app-1"), provider, ["documents"], 0);
  });

  test("documents but an open required question gets 422 with intake missing", async () => {
    seedEmptyCase();
    answerIntake("app-1", { "q-purpose": "Tourism", "q-notes": "none" });
    seedDocument({ id: "doc-1", applicationId: "app-1", key: "bank" });
    const provider = answeringProvider();
    useProvider(provider);
    const res = await post("app-1");
    assertNotEnough(res, provider, ["intake"], 1);
    assert.match(res.body.message, /the 1 required question\b/);
  });

  test("only a refusal letter uploaded gets 422: the letter does not count", async () => {
    seedEmptyCase();
    answerIntake("app-1", { "q-purpose": "Tourism", "q-return": "In two weeks" });
    seedDocument({ id: "doc-refusal", applicationId: "app-1", key: "refusal" });
    const cur = store.get("documents/doc-refusal") as Record<string, unknown>;
    store.set("documents/doc-refusal", { ...cur, requirementId: "refusal-letter" });
    const provider = answeringProvider();
    useProvider(provider);
    assertNotEnough(await post("app-1"), provider, ["documents"], 0);
  });

  test("a route with no intake and one document is accepted", async () => {
    rubricBook.set("AA_route-a", routeARubric()); // no intake questions
    seedEmptyCase();
    seedDocument({ id: "doc-1", applicationId: "app-1", key: "bank" });
    useProvider(answeringProvider());
    const res = await post("app-1");
    assert.equal(res.statusCode, 202);
    assert.equal(res.body.data.status, "queued");
    assert.equal(assessmentDocs("app-1").length, 1);
  });

  test("intake answered and one document (no statement) is accepted", async () => {
    seedEmptyCase();
    answerIntake("app-1", { "q-purpose": "Tourism", "q-return": "In two weeks" });
    seedDocument({ id: "doc-1", applicationId: "app-1", key: "bank" });
    useProvider(answeringProvider());
    const res = await post("app-1");
    assert.equal(res.statusCode, 202);
  });

  // ----- Only an editable intake can be missing (#309 fix round) -----

  // Every status the intake can still be saved in: an open required question
  // blocks the review, exactly as above.
  for (const status of INTAKE_EDITABLE_STATUSES) {
    test(`${status}: an open required question with a document gets 422 with intake missing`, async () => {
      seedEmptyCase("app-1", status);
      answerIntake("app-1", { "q-purpose": "Tourism" });
      seedDocument({ id: "doc-1", applicationId: "app-1", key: "bank" });
      const provider = answeringProvider();
      useProvider(provider);
      assertNotEnough(await post("app-1"), provider, ["intake"], 1);
    });
  }

  // Every status past them: a save would be refused (409 NOT_EDITABLE), so
  // open questions never block; the review runs and reports those rules as
  // "could not be assessed". The documents part still applies.
  const NOT_EDITABLE: ApplicationStatus[] = ["under_review", "submitted_to_embassy", "interview_scheduled", "approved", "rejected", "withdrawn", "expired"];
  for (const status of NOT_EDITABLE) {
    test(`${status}: open required questions with a document are accepted`, async () => {
      seedEmptyCase("app-1", status);
      seedDocument({ id: "doc-1", applicationId: "app-1", key: "bank" });
      useProvider(answeringProvider());
      const res = await post("app-1", OWNER, PAID);
      assert.equal(res.statusCode, 202);
      assert.equal(assessmentDocs("app-1").length, 1);
    });

    test(`${status}: open required questions and no document get 422 with only documents missing`, async () => {
      seedEmptyCase("app-1", status);
      const provider = answeringProvider();
      useProvider(provider);
      const res = await post("app-1", OWNER, PAID);
      assertNotEnough(res, provider, ["documents"], 0);
      assert.doesNotMatch(res.body.message, /question/);
    });
  }

  // ----- Same answer for every tier; access and missing checks first -----

  test("a paid caller gets the same 422 as a free one", async () => {
    seedEmptyCase();
    const provider = answeringProvider();
    useProvider(provider);
    assertNotEnough(await post("app-1", OWNER, PAID), provider, ["intake", "documents"], 2);
  });

  test("a caller without update access gets 403, never the 422", async () => {
    seedEmptyCase();
    useProvider(answeringProvider());
    const res = await post("app-1", OTHER_AGENCY, PAID);
    assert.equal(res.statusCode, 403);
    assert.equal(res.body.error, "FORBIDDEN");
    assert.equal(res.body.missing, undefined, "nothing about the application leaks");
  });

  test("a missing application is 404, and no approved rubric is still 404 NO_APPROVED_RUBRIC", async () => {
    useProvider(answeringProvider());
    const missing = await post("nope");
    assert.equal(missing.statusCode, 404);
    seedApplication({ id: "app-x", visaTypeId: "route-x", agentId: "agent-1", agencyId: "agency-1" });
    const noRubric = await post("app-x");
    assert.equal(noRubric.statusCode, 404);
    assert.equal(noRubric.body.error, "NO_APPROVED_RUBRIC");
  });

  // ----- The free review -----

  test("a free user whose earlier result had no model call is accepted once the application is complete, not 402", async () => {
    seedEmptyCase();
    const provider = answeringProvider();
    useProvider(provider);
    // An earlier "nothing to read" result, made the way it was before #309
    // (the status trigger still can): no model call, no bar hit.
    await aiCaseOfficerService.enqueueForStatusChange("app-1");
    const [first] = assessmentDocs("app-1");
    await aiCaseOfficerService.runJob(first.id);
    const done = assessmentDocs("app-1")[0];
    assert.equal(done.status, "succeeded");
    assert.equal(provider.requests.length, 0, "the earlier result made no model call");
    assert.ok(isNoModelCallResult(done));

    // The applicant completes what was missing; their next request starts the review.
    answerIntake("app-1", { "q-purpose": "Tourism", "q-return": "In two weeks" });
    seedDocument({ id: "doc-1", applicationId: "app-1", key: "bank" });
    const res = await post("app-1");
    assert.equal(res.statusCode, 202, "the free review is still available");
    assert.equal(assessmentDocs("app-1").length, 2);

    // That review reaches the model, so it is the free review: a later change is 402.
    await aiCaseOfficerService.runJob(res.body.data.assessmentId);
    assert.ok(provider.requests.length > 0, "the real review reached the model");
    seedDocument({ id: "doc-2", applicationId: "app-1", key: "bank-2" });
    const again = await post("app-1");
    assert.equal(again.statusCode, 402);
    assert.equal(again.body.error, "UPGRADE_REQUIRED");
  });

  test("isNoModelCallResult: a bar hit or any model call still counts as a review", () => {
    const zero = { requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    assert.equal(isNoModelCallResult({ usage: { extract: zero, judge: zero }, hasBlockingRule: false } as any), true);
    assert.equal(isNoModelCallResult({ usage: { extract: zero, judge: zero }, hasBlockingRule: true } as any), false);
    assert.equal(isNoModelCallResult({ usage: { extract: { ...zero, requests: 1 }, judge: zero }, hasBlockingRule: false } as any), false);
    assert.equal(isNoModelCallResult({ usage: { extract: zero, judge: { ...zero, requests: 1 } }, hasBlockingRule: false } as any), false);
  });

  // ----- Unchanged paths -----

  test("the status trigger is unchanged: it still queues a job on an empty application", async () => {
    seedEmptyCase();
    useProvider(answeringProvider());
    await aiCaseOfficerService.enqueueForStatusChange("app-1");
    const stored = assessmentDocs("app-1");
    assert.equal(stored.length, 1);
    assert.equal(stored[0].status, "queued");
    assert.equal(stored[0].trigger, "status_change");
  });

  test("an unexpected failure answers 500, not a hung request", async () => {
    seedEmptyCase();
    useProvider(answeringProvider());
    const original = aiCaseOfficerService.requestAssessment;
    (aiCaseOfficerService as any).requestAssessment = async () => {
      throw new Error("boom");
    };
    try {
      const res = await post("app-1");
      assert.equal(res.statusCode, 500);
      assert.equal(res.body.error, "INTERNAL_ERROR");
    } finally {
      (aiCaseOfficerService as any).requestAssessment = original;
    }
  });
});
