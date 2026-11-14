// ============================================
// Which country do I apply through (issue #235, P6 of #228): the service
// ============================================
//
// Hermetic: an in-memory Firestore (test/helpers/fake-firestore.ts), fixture
// rulebooks injected in place of the store, a fixed clock. No emulator, no
// model, no network. Covers:
//  - the options: today's members with a usable record only (a member that
//    left, a pending record, another agency's agency-only record: not offered);
//    "We can't offer this route yet" when none is;
//  - question options from membership data at the time of asking;
//  - the proposal (offered or not), never forced;
//  - creation: 422 for a country that is not a destination today or not
//    offered; country / visa / price from the member's own record; the choice
//    stored with who chose it and the rule shown; answers seed the intake;
//  - changing the country before submission: new record and stack, answers
//    kept or set aside (never deleted), a later save keeps the set-aside ones;
//    refused once submitted or paid;
//  - the controller's 422 shape for POST /applications.
// Every code, id and name is made up.

import { before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { Timestamp } from "firebase-admin/firestore";
import { defineAbilitiesFor, ROLES } from "@durin-tech/authz";
import { fakeCollection, fakeRunTransaction, installFakes, resetStore, store } from "../helpers/fake-firestore";
import { DEFAULT_SEVERITY_LEVELS, type AssessmentCriterion, type IntakeQuestion, type VisaRubric } from "../../src/types/rubric";

/* eslint-disable @typescript-eslint/no-explicit-any */

const T0 = Timestamp.fromMillis(1_700_000_000_000);
const NOW = Date.parse("2026-11-14T12:00:00Z");
const SHARED_KEY = "test-bloc_route-one";
const sid = (id: string) => `${SHARED_KEY}::${id}`;

// ---------- fixture rulebooks ----------

const URL = "https://rules.example.org/route-one";
const QUOTE = "The country competent to examine an application shall be the country that is the sole destination of the visit; where no single destination applies, the country whose border the applicant intends to cross first.";

function rubric(fields: Partial<VisaRubric>): VisaRubric {
  return {
    schemaVersion: 1,
    version: 2,
    reviewStatus: "approved",
    intentPolarity: "not_assessed",
    reviewedBy: "auto",
    reviewedAt: T0,
    rejectReason: null,
    revision: 1,
    supersededAt: null,
    intentPolarityProposal: null,
    severityLevels: [...DEFAULT_SEVERITY_LEVELS],
    criteria: [],
    intakeQuestions: [],
    evidenceItems: [],
    sourceSnapshots: [],
    sourceSetHash: "s",
    extractorModel: "m",
    extractorPromptVersion: "v",
    extractionRunId: "r",
    discardedCount: 0,
    discarded: [],
    suspiciousPassages: [],
    flags: [],
    createdAt: T0,
    ...fields,
  } as VisaRubric;
}

const RULE = {
  criterionId: "rule-competent",
  title: "Which country examines the application",
  kind: "judgement",
  stage: "validity",
  severity: "high",
  source: { quote: QUOTE, sourceId: "s1", url: URL, contentHash: "a".repeat(64), retrievedAt: "2026-11-01T00:00:00.000Z" },
  probeFactors: ["the trip"],
  requiresInterviewBeforeRefusal: false,
  concernsIntent: false,
  confidence: 0.9,
} as AssessmentCriterion;

const SHARED_QUESTIONS: IntakeQuestion[] = [
  { id: "visit", label: "Which countries on this route will you visit?", answerType: "multi_choice", required: true, criterionIds: ["rule-competent"], optionsFrom: "route_destinations" },
  { id: "border", label: "Which country's border will you cross first?", answerType: "single_choice", required: true, criterionIds: ["rule-competent"], optionsFrom: "route_destinations" },
];

const SHARED = rubric({
  routeKey: SHARED_KEY,
  authorityId: "test-bloc",
  routeSlug: "route-one",
  version: 4,
  criteria: [RULE],
  intakeQuestions: SHARED_QUESTIONS,
  competence: {
    steps: [
      { criterionId: "rule-competent", questionId: "visit", resultFrom: "answer", restsOn: "sole destination", source: RULE.source },
      { criterionId: "rule-competent", questionId: "border", resultFrom: "answer", restsOn: "intends to cross first", source: RULE.source },
    ],
  },
});

/** A country's own layer with one question of its own (so a change of country orphans its answer). */
function ownLayer(cc: string, vid: string): VisaRubric {
  const rule = { ...RULE, criterionId: `own-rule-${cc}`, title: `Own rule ${cc}`, source: { ...RULE.source, quote: `Own rule of ${cc}.` } } as AssessmentCriterion;
  return rubric({
    routeKey: `${cc}_${vid}`,
    authorityId: cc,
    routeSlug: vid,
    countryCode: cc,
    visaTypeId: vid,
    criteria: [rule],
    intakeQuestions: [{ id: `own-q-${cc.toLowerCase()}`, label: `Own question ${cc}`, answerType: "yes_no", required: false, criterionIds: [rule.criterionId] }],
  });
}

// ---------- the services (loaded after the fakes) ----------

let competenceService: any;
let CompetenceError: any;
let applicationService: any;
let applicationController: any;
let intakeService: any;
let sharedRulebook: VisaRubric | null = SHARED;

before(async () => {
  await installFakes();
  const firebase: any = await import("../../src/utils/firebase");
  firebase.collections.authorities = fakeCollection("authorities");
  firebase.collections.sharedRoutes = fakeCollection("sharedRoutes");
  firebase.collections.applications = fakeCollection("applications");
  firebase.collections.agents = fakeCollection("agents");
  firebase.subcollections.authorityMembers = (id: string) => fakeCollection(`authorities/${id}/members`);
  firebase.subcollections.requirements = (cc: string, v: string) => fakeCollection(`countries/${cc}/visaTypes/${v}/requirements`);
  firebase.subcollections.timeline = (id: string) => fakeCollection(`applications/${id}/timeline`);

  const authorities: any = await import("../../src/authorities");
  authorities.authorityService.runTransaction = fakeRunTransaction;
  authorities.authorityService.clock = () => NOW;
  const shared: any = await import("../../src/shared-routes");
  shared.sharedRouteService.clock = () => NOW;

  const comp: any = await import("../../src/services/competence.service");
  competenceService = comp.competenceService;
  CompetenceError = comp.CompetenceError;
  competenceService.clock = () => NOW;
  competenceService.readSharedLayer = async (key: string) => (key === SHARED_KEY ? sharedRulebook : null);

  // The application's stack is read through the intake's injected reader:
  // the fixture shared layer plus the country's own fixture layer.
  const intake: any = await import("../../src/services/intake.service");
  intakeService = intake.intakeService;
  const scrapers: any = await import("../../src/scrapers");
  intake.intakeRulebookReader.read = async (app: any) => {
    const layers = shared.layersFromKeys(app.routeStack) ?? [{ authorityId: app.countryCode, rulebookKey: `${app.countryCode}_${app.visaTypeId}`, role: "own" }];
    return scrapers.loadRulebookStack(layers, async (layer: any) => (layer.role === "shared" ? (layer.rulebookKey === SHARED_KEY ? sharedRulebook : null) : ownLayer(app.countryCode, app.visaTypeId)));
  };
  applicationService = (await import("../../src/services/application.service")).applicationService;
  applicationController = (await import("../../src/controllers/application.controller")).applicationController;
});

function member(cc: string, joinedOn: string, leftOn?: string): void {
  store.set(`authorities/test-bloc/members/${cc}`, { countryCode: cc, joinedOn, ...(leftOn ? { leftOn } : {}), sourceQuote: "q", sourceUrl: "https://x.example.org/", createdBy: "a", createdAt: T0, updatedBy: "a", updatedAt: T0 });
}

function seedVisa(cc: string, id: string, over: Record<string, unknown> = {}): void {
  store.set(`countries/${cc}/visaTypes/${id}`, {
    id, countryCode: cc, name: `Visa ${id}`, code: id.toUpperCase(), description: "d", category: "tourist", processingTime: "1 week",
    processingDaysMin: 5, processingDaysMax: 7, baseCostUsd: 100, validityPeriod: "90 days", isExtendable: false, eligibilityCriteria: [],
    agentIds: [], isActive: true, inheritsFrom: [{ sharedRouteId: "route-one" }], createdAt: T0, updatedAt: T0, ...over,
  });
}

beforeEach(() => {
  resetStore();
  sharedRulebook = SHARED;
  for (const cc of ["XA", "XB", "XC", "XD", "XE"]) store.set(`countries/${cc}`, { code: cc, name: `Country ${cc}`, isSupported: true, createdAt: T0, updatedAt: T0 });
  store.set("authorities/test-bloc", { id: "test-bloc", kind: "bloc", name: "Test bloc", status: "active", createdBy: "a", createdAt: T0, updatedBy: "a", updatedAt: T0 });
  member("XA", "2020-01-01");
  member("XB", "2020-01-01");
  member("XC", "2019-01-01", "2024-01-01"); // left before today
  member("XD", "2020-01-01");
  member("XE", "2020-01-01");
  store.set("sharedRoutes/route-one", { id: "route-one", name: "Route One", category: "tourist", issuingAuthorityId: "test-bloc", destinations: { mode: "members_of", authorityId: "test-bloc" }, status: "active", createdBy: "a", createdAt: T0, updatedBy: "a", updatedAt: T0 });
  seedVisa("XA", "xa-visit", { baseCostUsd: 100 });
  seedVisa("XB", "xb-visit", { baseCostUsd: 200 });
  seedVisa("XC", "xc-visit");
  seedVisa("XD", "xd-visit", { reviewStatus: "pending" }); // not usable: not offered
  // An agency-only record of agency-1: offered only for a case of that agency.
  seedVisa("XE", "xe-visit", { source: "agency", visibility: "agency", ownerAgencyId: "agency-1", reviewStatus: "approved" });
  store.set("agents/ag1", { userId: "agent-1-uid", agencyId: "agency-1" });
  store.set("agents/ag2", { userId: "agent-2-uid", agencyId: "agency-2" });
  store.set("users/u1", { firstName: "Test", lastName: "Applicant", email: "delivered+applicant@resend.dev" });
});

/** Await a promise that must fail with a CompetenceError of this code and status. */
async function refused(p: Promise<unknown>, code: string, status: number): Promise<CompetenceErrorShape> {
  try {
    await p;
  } catch (err: any) {
    assert.ok(err instanceof CompetenceError, `expected a CompetenceError, got ${err?.message}`);
    assert.equal(err.code, code);
    assert.equal(err.status, status);
    return err;
  }
  assert.fail(`expected ${code}`);
}
interface CompetenceErrorShape {
  code: string;
  status: number;
  message: string;
}

// ============================================
// The apply-through step
// ============================================

describe("propose", () => {
  test("offers today's members with a usable record only; question options come from membership data", async () => {
    const v = await competenceService.propose("route-one", undefined, undefined);
    assert.equal(v.available, true);
    assert.equal(v.message, null);
    // XC left, XD's record is pending, XE is another agency's agency-only record.
    assert.deepEqual(v.options.map((o: any) => [o.countryCode, o.visaTypeId, o.baseCostUsd]), [["XA", "xa-visit", 100], ["XB", "xb-visit", 200]]);
    // The questions carry the ids the application's intake stores, and list
    // every member TODAY (from membership data), whatever their record.
    assert.deepEqual(v.questions.map((q: any) => q.id), [sid("visit"), sid("border")]);
    assert.deepEqual(v.questions[0].options.map((o: any) => [o.value, o.label]), [["XA", "Country XA"], ["XB", "Country XB"], ["XD", "Country XD"], ["XE", "Country XE"]]);
    assert.deepEqual(v.competence.steps.map((s: any) => [s.questionId, s.restsOn, s.url]), [[sid("visit"), "sole destination", URL], [sid("border"), "intends to cross first", URL]]);
    assert.deepEqual(v.result, { status: "ask", questionId: sid("visit") });
    assert.equal(v.proposal, null);
    assert.equal(v.rulebookKey, SHARED_KEY);
    assert.equal(v.rulebookVersion, 4);
  });

  test("membership is read on the day: a member that joins later is listed once it has joined", async () => {
    member("XB", "2027-01-01");
    const v = await competenceService.propose("route-one", undefined, undefined);
    assert.deepEqual(v.options.map((o: any) => o.countryCode), ["XA"]);
    competenceService.clock = () => Date.parse("2027-02-01T00:00:00Z");
    try {
      const later = await competenceService.propose("route-one", undefined, undefined);
      assert.deepEqual(later.options.map((o: any) => o.countryCode), ["XA", "XB"]);
    } finally {
      competenceService.clock = () => NOW;
    }
  });

  test("an agency-only record is offered only for a case of its agency", async () => {
    const mine = await competenceService.propose("route-one", undefined, "agency-1");
    assert.deepEqual(mine.options.map((o: any) => o.countryCode), ["XA", "XB", "XE"]);
    const other = await competenceService.propose("route-one", undefined, "agency-2");
    assert.deepEqual(other.options.map((o: any) => o.countryCode), ["XA", "XB"]);
  });

  test("answers give a proposal with the rule's quote; a proposed country with no usable record is marked not offered", async () => {
    const v = await competenceService.propose("route-one", { [sid("visit")]: ["XB"] }, undefined);
    assert.deepEqual(v.proposal, { countryCode: "XB", countryName: "Country XB", stepIndex: 0, restsOn: "sole destination", quote: QUOTE, url: URL, offered: true });
    const d = await competenceService.propose("route-one", { [sid("visit")]: ["XA", "XB"], [sid("border")]: "XD" }, undefined);
    assert.equal(d.proposal.countryCode, "XD");
    assert.equal(d.proposal.stepIndex, 1);
    assert.equal(d.proposal.offered, false);
  });

  test("an answer that is not an option (a member that left) is refused like any intake answer", async () => {
    await assert.rejects(competenceService.propose("route-one", { [sid("visit")]: ["XC"] }, undefined), /choose from the options/);
  });

  test("a shared rulebook with no competence rule: no questions, the applicant picks", async () => {
    const { competence: _c, ...withoutBlock } = SHARED as any;
    void _c;
    sharedRulebook = withoutBlock;
    const v = await competenceService.propose("route-one", undefined, undefined);
    assert.equal(v.competence, null);
    assert.deepEqual(v.questions, []);
    assert.equal(v.result.reason, "NO_COMPETENCE_RULE");
    assert.equal(v.options.length, 2);
  });

  test("no member with a usable record: \"We can't offer this route yet\"", async () => {
    for (const [cc, id] of [["XA", "xa-visit"], ["XB", "xb-visit"]]) store.set(`countries/${cc}/visaTypes/${id}`, { ...(store.get(`countries/${cc}/visaTypes/${id}`) as any), reviewStatus: "pending" });
    const v = await competenceService.propose("route-one", undefined, undefined);
    assert.equal(v.available, false);
    assert.equal(v.message, "We can't offer this route yet");
    assert.deepEqual(v.options, []);
  });

  test("an unknown or retired route is 404", async () => {
    await refused(competenceService.propose("no-such-route", undefined, undefined), "NOT_FOUND", 404);
    store.set("sharedRoutes/route-one", { ...(store.get("sharedRoutes/route-one") as any), status: "retired" });
    await refused(competenceService.propose("route-one", undefined, undefined), "NOT_FOUND", 404);
  });
});

// ============================================
// Creating the application
// ============================================

describe("create through a member country", () => {
  const actor = { uid: "u1", role: "client" };

  test("a country that is not a destination today (it left) is 422, with a plain message", async () => {
    const e = await refused(competenceService.resolveForCreate({ sharedRouteId: "route-one", throughCountryCode: "XC" }, undefined, actor), "COUNTRY_NOT_A_DESTINATION", 422);
    assert.equal(e.message, "Country XC is not part of this route today, so you can't apply through it.");
    await refused(competenceService.resolveForCreate({ sharedRouteId: "route-one", throughCountryCode: "XZ" }, undefined, actor), "COUNTRY_NOT_A_DESTINATION", 422);
  });

  test("a member with a pending record, or another agency's record, is 422 not offered", async () => {
    await refused(competenceService.resolveForCreate({ sharedRouteId: "route-one", throughCountryCode: "XD" }, undefined, actor), "COUNTRY_NOT_OFFERED", 422);
    await refused(competenceService.resolveForCreate({ sharedRouteId: "route-one", throughCountryCode: "XE" }, "agency-2", actor), "COUNTRY_NOT_OFFERED", 422);
    const ok = await competenceService.resolveForCreate({ sharedRouteId: "route-one", throughCountryCode: "XE" }, "agency-1", actor);
    assert.equal(ok.visaTypeId, "xe-visit");
  });

  test("a malformed code is 400", async () => {
    await refused(competenceService.resolveForCreate({ sharedRouteId: "route-one", throughCountryCode: "xa" }, undefined, actor), "VALIDATION_ERROR", 400);
  });

  test("picking another member than the rule's: allowed, with the reason shown stored", async () => {
    const r = await competenceService.resolveForCreate({ sharedRouteId: "route-one", throughCountryCode: "XB", answers: { [sid("visit")]: ["XA"] } }, undefined, actor);
    assert.equal(r.countryCode, "XB");
    assert.equal(r.visaTypeId, "xb-visit");
    assert.equal(r.choice.followedProposal, false);
    assert.equal(r.choice.reasonShown, "The rule says Country XA; you chose Country XB.");
    assert.deepEqual(r.choice.proposal, { countryCode: "XA", stepIndex: 0, restsOn: "sole destination", quote: QUOTE, url: URL });
    assert.equal(r.choice.chosenByUid, "u1");
    assert.equal(r.choice.chosenByRole, "client");
    assert.equal(r.choice.rulebookVersion, 4);
  });

  test("the application takes country, visa and price from the member's own record, and stores the choice", async () => {
    const r = await competenceService.resolveForCreate({ sharedRouteId: "route-one", throughCountryCode: "XB", answers: { [sid("visit")]: ["XB"] } }, undefined, actor);
    assert.equal(r.choice.followedProposal, true);
    assert.equal(r.choice.reasonShown, undefined);
    const app = await applicationService.createApplication("u1", { countryCode: r.countryCode, visaTypeId: r.visaTypeId, mode: "self", throughCountry: { choice: r.choice, answers: r.answers, routeName: r.routeName } });
    const stored: any = store.get(`applications/${app.id}`);
    assert.equal(stored.countryCode, "XB");
    assert.equal(stored.visaTypeId, "xb-visit");
    assert.equal(stored.countryName, "Country XB");
    // (#237) The route's name beside the country applied through.
    assert.equal(stored.routeName, "Route One");
    assert.equal(stored.totalCost, 200 * 100);
    assert.deepEqual(stored.routeStack, [SHARED_KEY, "XB_xb-visit"]);
    assert.equal(stored.throughCountryCode, "XB");
    assert.equal(stored.throughCountry.sharedRouteId, "route-one");
    assert.equal(stored.throughCountry.proposal.quote, QUOTE);
    // The answers given in the step are not asked again.
    assert.deepEqual(stored.intake.answers, { [sid("visit")]: ["XB"] });
    assert.equal(stored.intake.orphanedAnswers, undefined);
  });

  test("an application on an ordinary visa is unchanged (no through-country fields)", async () => {
    store.set("countries/XA/visaTypes/plain", { ...(store.get("countries/XA/visaTypes/xa-visit") as any), id: "plain", inheritsFrom: undefined });
    const app = await applicationService.createApplication("u1", { countryCode: "XA", visaTypeId: "plain", mode: "self" });
    assert.equal((store.get(`applications/${app.id}`) as any).routeName, undefined);
    const stored: any = store.get(`applications/${app.id}`);
    assert.equal(stored.throughCountryCode, undefined);
    assert.equal(stored.throughCountry, undefined);
    assert.equal(stored.intake, undefined);
  });
});

// ============================================
// POST /applications (controller)
// ============================================

/** A minimal Express response double. */
function resDouble(): any {
  const res: any = { statusCode: 200, body: undefined };
  res.status = (c: number) => ((res.statusCode = c), res);
  res.json = (b: unknown) => ((res.body = b), res);
  res.send = (b: unknown) => ((res.body = b), res);
  return res;
}

describe("POST /applications with a shared route", () => {
  const call = async (body: Record<string, unknown>) => {
    const res = resDouble();
    const saved = console.error;
    console.error = () => undefined;
    try {
      await applicationController.createApplication({ userId: "u1", body, authz: { uid: "u1", role: "client", agencyId: null } }, res);
    } finally {
      console.error = saved;
    }
    return res;
  };

  test("a country that is not a destination today: 422 with the plain message, nothing written", async () => {
    const res = await call({ sharedRouteId: "route-one", throughCountryCode: "XC", mode: "self" });
    assert.equal(res.statusCode, 422);
    assert.equal(res.body.error, "COUNTRY_NOT_A_DESTINATION");
    assert.match(res.body.message, /not part of this route today/);
    assert.equal([...store.keys()].some((k) => k.startsWith("applications/")), false);
  });

  test("201 with the member's record; mixing both forms is 400", async () => {
    const res = await call({ sharedRouteId: "route-one", throughCountryCode: "XA", mode: "self", competenceAnswers: { [sid("visit")]: ["XA"] } });
    assert.equal(res.statusCode, 201);
    // (#237) The route's name beside the country, and the flag from the shared rule.
    assert.equal(res.body.data.routeName, "Route One");
    assert.equal(res.body.data.canChangeThroughCountry, true);
    assert.equal(res.body.data.countryCode, "XA");
    assert.equal(res.body.data.visaTypeId, "xa-visit");
    assert.equal(res.body.data.throughCountry.followedProposal, true);
    const bad = await call({ sharedRouteId: "route-one", throughCountryCode: "XA", countryCode: "XA", visaTypeId: "xa-visit", mode: "self" });
    assert.equal(bad.statusCode, 400);
  });
});

// ============================================
// Changing the country before submission
// ============================================

describe("change the country applied through", () => {
  const actor = { uid: "u1", role: "client" };

  /** An application through XA with a shared answer and an answer to XA's own question. */
  async function startThroughXA(): Promise<any> {
    const r = await competenceService.resolveForCreate({ sharedRouteId: "route-one", throughCountryCode: "XA", answers: { [sid("visit")]: ["XA", "XB"], [sid("border")]: "XA" } }, undefined, actor);
    const app = await applicationService.createApplication("u1", { countryCode: r.countryCode, visaTypeId: r.visaTypeId, mode: "self", throughCountry: { choice: r.choice, answers: r.answers, routeName: r.routeName } });
    const stored: any = store.get(`applications/${app.id}`);
    stored.intake.answers["own-q-xa"] = true;
    store.set(`applications/${app.id}`, stored);
    return stored;
  }

  test("recomputes the record and the stack; answers still asked are kept, the others set aside, none deleted", async () => {
    const app = await startThroughXA();
    const r = await competenceService.changeThroughCountry(app, "XB", actor);
    assert.equal(r.changed, true);
    assert.equal(r.answersKept, 2);
    assert.equal(r.answersSetAside, 1);
    const stored: any = store.get(`applications/${app.id}`);
    assert.equal(stored.countryCode, "XB");
    assert.equal(stored.visaTypeId, "xb-visit");
    assert.equal(stored.totalCost, 200 * 100);
    assert.deepEqual(stored.routeStack, [SHARED_KEY, "XB_xb-visit"]);
    assert.equal(stored.throughCountryCode, "XB");
    // (#237) routeName is correct after the change: still the route's name, countryName the new country.
    assert.equal(stored.routeName, "Route One");
    assert.equal(stored.countryName, "Country XB");
    // The border answer pointed at XA: the reason is shown and stored.
    assert.equal(stored.throughCountry.followedProposal, false);
    assert.equal(stored.throughCountry.reasonShown, "The rule says Country XA; you chose Country XB.");
    assert.deepEqual(stored.intake.answers, { [sid("visit")]: ["XA", "XB"], [sid("border")]: "XA" });
    assert.deepEqual(stored.intake.orphanedAnswers.map((o: any) => [o.questionId, o.value, o.routeKey]), [["own-q-xa", true, "XA_xa-visit"]]);

    // A later save keeps the set-aside answers.
    const fresh: any = store.get(`applications/${app.id}`);
    await intakeService.saveIntake(fresh, { [sid("visit")]: ["XB"], "own-q-xb": false });
    const after: any = store.get(`applications/${app.id}`);
    assert.deepEqual(after.intake.answers, { [sid("visit")]: ["XB"], "own-q-xb": false });
    assert.deepEqual(after.intake.orphanedAnswers.map((o: any) => o.questionId), ["own-q-xa"]);

    // Changing back moves XB's own answer aside too; nothing is lost.
    await competenceService.changeThroughCountry(after, "XA", actor);
    const back: any = store.get(`applications/${app.id}`);
    assert.deepEqual(back.intake.orphanedAnswers.map((o: any) => o.questionId), ["own-q-xa", "own-q-xb"]);
  });

  test("(#237) a route renamed since creation: the change of country stores the route's current name", async () => {
    const app = await startThroughXA();
    store.set("sharedRoutes/route-one", { ...(store.get("sharedRoutes/route-one") as any), name: "Route One Renamed" });
    await competenceService.changeThroughCountry(app, "XB", actor);
    assert.equal((store.get(`applications/${app.id}`) as any).routeName, "Route One Renamed");
  });

  test("the same country again changes nothing", async () => {
    const app = await startThroughXA();
    const before = JSON.stringify(store.get(`applications/${app.id}`));
    const r = await competenceService.changeThroughCountry(app, "XA", actor);
    assert.equal(r.changed, false);
    assert.equal(JSON.stringify(store.get(`applications/${app.id}`)), before);
  });

  test("refused once submitted, once paid, for a non-member and for an ordinary application", async () => {
    const app = await startThroughXA();
    await refused(competenceService.changeThroughCountry({ ...app, status: "under_review" }, "XB", actor), "NOT_EDITABLE", 409);
    await refused(competenceService.changeThroughCountry({ ...app, amountPaid: 500 }, "XB", actor), "ALREADY_PAID", 409);
    await refused(competenceService.changeThroughCountry(app, "XC", actor), "COUNTRY_NOT_A_DESTINATION", 422);
    await refused(competenceService.changeThroughCountry(app, "XD", actor), "COUNTRY_NOT_OFFERED", 422);
    await refused(competenceService.changeThroughCountry({ ...app, throughCountry: undefined, throughCountryCode: undefined }, "XB", actor), "NOT_SHARED_ROUTE", 409);
    assert.equal((store.get(`applications/${app.id}`) as any).countryCode, "XA");
  });

  test("an agency's case may move only to records that agency may use", async () => {
    const app = await startThroughXA();
    await refused(competenceService.changeThroughCountry({ ...app, agencyId: "agency-2" }, "XE", actor), "COUNTRY_NOT_OFFERED", 422);
    const r = await competenceService.changeThroughCountry({ ...app, agencyId: "agency-1" }, "XE", actor);
    assert.equal(r.application.visaTypeId, "xe-visit");
  });
});


// ============================================
// (#237) stackLayers on the applicant's reads, and canChangeThroughCountry
// ============================================

describe("stackLayers and canChangeThroughCountry", () => {
  const actor = { uid: "u1", role: "client" };
  const authedReq = (id: string) => ({ userId: "u1", params: { id }, body: {}, authz: { uid: "u1", role: "client", agencyId: null }, ability: defineAbilitiesFor({ uid: "u1", role: ROLES.CLIENT, agencyId: null }) });

  async function start(cc = "XA"): Promise<any> {
    const r = await competenceService.resolveForCreate({ sharedRouteId: "route-one", throughCountryCode: cc, answers: { [sid("visit")]: [cc] } }, undefined, actor);
    const app = await applicationService.createApplication("u1", { countryCode: r.countryCode, visaTypeId: r.visaTypeId, mode: "self", throughCountry: { choice: r.choice, answers: r.answers, routeName: r.routeName } });
    return store.get(`applications/${app.id}`);
  }

  test("the intake read lists the layers: shared first with the route's name, the country last; keys match the questions' layerKey", async () => {
    const app = await start();
    const res = resDouble();
    await applicationController.getIntake(authedReq(app.id), res);
    const body = res.body.data;
    assert.deepEqual(body.stackLayers, [
      { key: SHARED_KEY, kind: "shared", name: "Route One", status: "ready" },
      { key: "XA_xa-visit", kind: "country", countryCode: "XA", countryName: "Country XA", status: "ready" },
    ]);
    const keys = new Set(body.stackLayers.map((l: any) => l.key));
    for (const q of body.questions) assert.ok(keys.has(q.layerKey), `question ${q.id} layerKey ${q.layerKey}`);
  });

  test("a layer with no approved rulebook is listed as missing", async () => {
    const app = await start();
    sharedRulebook = null;
    const res = resDouble();
    await applicationController.getIntake(authedReq(app.id), res);
    const shared = res.body.data.stackLayers.find((l: any) => l.kind === "shared");
    assert.equal(shared.status, "missing");
    assert.equal(res.body.data.stackLayers.find((l: any) => l.kind === "country").status, "ready");
  });

  test("an ordinary single-layer application has no stackLayers (the field is omitted)", async () => {
    store.set("countries/XA/visaTypes/plain", { ...(store.get("countries/XA/visaTypes/xa-visit") as any), id: "plain", inheritsFrom: undefined });
    const app = await applicationService.createApplication("u1", { countryCode: "XA", visaTypeId: "plain", mode: "self" });
    const res = resDouble();
    await applicationController.getIntake(authedReq(app.id), res);
    assert.equal(res.body.data?.stackLayers, undefined);
  });

  test("canChangeThroughCountry: true while editable and unpaid; false once submitted, once paid, and on an ordinary application", async () => {
    const { canChangeThroughCountry, throughCountryRefusal } = await import("../../src/shared-routes/through-country-rule");
    const app = await start();
    assert.equal(canChangeThroughCountry(app), true);
    assert.equal(canChangeThroughCountry({ ...app, status: "under_review" }), false);
    assert.equal(canChangeThroughCountry({ ...app, amountPaid: 500 }), false);
    assert.equal(canChangeThroughCountry({ ...app, throughCountry: undefined, throughCountryCode: undefined }), false);
    // The endpoint refuses with exactly the helper's code in every false case.
    for (const [over, code] of [[{ status: "under_review" }, "NOT_EDITABLE"], [{ amountPaid: 500 }, "ALREADY_PAID"], [{ throughCountry: undefined, throughCountryCode: undefined }, "NOT_SHARED_ROUTE"]] as const) {
      const a = { ...app, ...over };
      assert.equal(throughCountryRefusal(a)?.code, code);
      await refused(competenceService.changeThroughCountry(a, "XB", actor), code, 409);
    }
  });

  test("GET /applications/:id and the list carry the flag; the through-country result's application too", async () => {
    const app = await start();
    const res = resDouble();
    await applicationController.getApplication(authedReq(app.id), res);
    assert.equal(res.body.data.canChangeThroughCountry, true);
    assert.equal(res.body.data.routeName, "Route One");
    store.set(`applications/${app.id}`, { ...(store.get(`applications/${app.id}`) as any), amountPaid: 100 });
    const res2 = resDouble();
    await applicationController.getApplication(authedReq(app.id), res2);
    assert.equal(res2.body.data.canChangeThroughCountry, false);
  });
});
