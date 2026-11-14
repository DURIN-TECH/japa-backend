// ============================================
// Stacked rulebooks, first half (issue #233, P4a of #228)
// ============================================
//
// What this file pins:
//   1. rulebook keys for any issuing authority (country, bloc, treaty), and the
//      validator's `route_key_mismatch` in the new key form;
//   2. a rulebook head + version stored BEFORE #233 (only countryCode +
//      visaTypeId) reads unchanged, with authorityId + routeSlug filled in;
//   3. a bloc / treaty rulebook can be extracted (pending version + head with no
//      country fields) and is refused when its shared route is not its own;
//   4. `loadRulebookStack`: the approved version of each layer, a missing layer
//      reported, usable with one approved layer, a single layer unchanged;
//   5. intake across layers: the union of questions asked once, ids scoped per
//      shared layer, a trigger may only read its own layer (the stack plan
//      refuses a cross-layer reference);
//   6. assessment over two layers: findings carry their layer, a failed rule in
//      either layer fails the application, nothing is dropped; the input hash
//      of a single-layer route is unchanged and a stack's follows every layer.
//
// Every id is made up (two-letter codes in the unassigned Q/X/Z ranges, blocs
// named `zq-...`). No Firebase: the in-memory fake only. No model call.

import { before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { Timestamp } from "firebase-admin/firestore";
import { resetStore, store } from "../../helpers/fake-firestore";
import { RubricStore, rulebookKeyOf } from "../../../src/scrapers/rubric/rubric.store";
import { keyFieldsOf, rulebookPartsOf, rulebookTargetOf, targetInputOf, withKeyParts } from "../../../src/scrapers/rubric/rubric-key";
import { validateVisaRubric } from "../../../src/scrapers/rubric/rubric-validate";
import { layerVersionsOf, loadRulebookStack, mergeRulebookStack, sameStackVersions, scopedId, stackFromReads } from "../../../src/scrapers/rubric/rubric-stack";
import { planStack } from "../../../src/scrapers/rubric/rubric-question-plan";
import { parseRubricVersionId } from "../../../src/services/rubric-review.service";
import { parseStartBody } from "../../../src/controllers/rubric-extraction-job.controller";
import { resolvePublishSettings } from "../../../src/scrapers/rubric/rubric-publish-settings";
import { effectiveIntakeQuestions, splitByApplicability } from "../../../src/services/ai/rule-applicability";
import { assembleContent, computeInputHash, mandatoryBarHits } from "../../../src/services/ai/assessment-engine";
import { IntakeService, intakeRulebookReader } from "../../../src/services/intake.service";
import { rulebookFor, rulebookStackFor } from "../../../src/services/ai/application-rulebook";
import type { AssessmentCriterion, IntakeQuestion, VisaRubric } from "../../../src/types/rubric";
import type { RouteLayer } from "../../../src/types/shared-route";
import { A_LINES, SOURCE_A_ID, SOURCE_A_URL } from "./fixtures/synthetic-guidance";
import { answer, crit, headDoc, installRubricFakes, makeHarness, quiet, recordAnswers, resetBucket, seedSource, versionDoc, type Harness } from "./rubric-harness";

/* eslint-disable @typescript-eslint/no-explicit-any */

// ============================================
// Fixtures (made-up ids only)
// ============================================

/** A bloc authority id and its shared route (made up). */
const BLOC = "zq-bloc";
const SHARED_ROUTE = "zq-short-stay";
const SHARED_KEY = `${BLOC}_${SHARED_ROUTE}`;
/** A member country's own route (made up). */
const OWN = { countryCode: "XQ", visaTypeId: "xq-short-stay" };
const OWN_KEY = `${OWN.countryCode}_${OWN.visaTypeId}`;

/** The two-layer stack of the member route: shared first, own last. */
const STACK: RouteLayer[] = [
  { authorityId: BLOC, rulebookKey: SHARED_KEY, role: "shared" },
  { authorityId: OWN.countryCode, rulebookKey: OWN_KEY, role: "own" },
];

/** A citation with a verbatim quote and URL (made-up page). */
function cite(quote: string, sourceId: string) {
  return { quote, sourceId, url: `https://rules.example/${sourceId}`, contentHash: "h".repeat(64), retrievedAt: "2026-11-01T00:00:00.000Z" };
}

/** One rule. */
function rule(id: string, over: Partial<AssessmentCriterion> = {}): AssessmentCriterion {
  return {
    criterionId: id,
    title: `Rule ${id}`,
    kind: "objective",
    stage: "eligibility",
    severity: "high",
    source: cite(`The quote of rule ${id}.`, `src-${id}`),
    applicability: "all_applicants",
    confidence: 0.9,
    ...over,
  };
}

/** One intake question. */
function question(id: string, criterionIds: string[], over: Partial<IntakeQuestion> = {}): IntakeQuestion {
  return { id, label: `Question ${id}?`, answerType: "yes_no", required: true, criterionIds, ...over };
}

/** An approved version in the shape the store serves. Key fields come from `key`. */
function approved(key: { countryCode?: string; visaTypeId?: string; authorityId?: string; routeSlug?: string }, version: number, over: Partial<VisaRubric> = {}): VisaRubric {
  const target = rulebookTargetOf(key);
  return {
    schemaVersion: 1,
    ...keyFieldsOf(target),
    version,
    reviewStatus: "approved",
    intentPolarity: "dual_intent_permitted",
    reviewedBy: "system:rubric-auto-publish",
    reviewedAt: Timestamp.fromMillis(Date.parse("2026-11-10T00:00:00Z")),
    rejectReason: null,
    revision: 1,
    supersededAt: null,
    intentPolarityProposal: null,
    severityLevels: ["critical", "high", "medium", "low"],
    criteria: [],
    intakeQuestions: [],
    evidenceItems: [],
    sourceSnapshots: [],
    sourceSetHash: `hash-${target.routeKey}-${version}`,
    extractorModel: "model-x",
    extractorPromptVersion: "p-1",
    extractionRunId: `run-${target.routeKey}-${version}`,
    discardedCount: 0,
    discarded: [],
    suspiciousPassages: [],
    flags: [],
    createdAt: Timestamp.fromMillis(Date.parse("2026-11-09T00:00:00Z")),
    ...over,
  };
}

/**
 * The shared layer: a funds rule triggered by its own question, a document
 * item, and an intention rule. Ids deliberately COLLIDE with the own layer's
 * (`q1`, `ev1`) to prove the scoping.
 */
function sharedLayer(version = 3): VisaRubric {
  return approved({ authorityId: BLOC, routeSlug: SHARED_ROUTE }, version, {
    criteria: [
      rule("s-funds", { check: { field: "funds.balance", op: "gte", value: 100 }, intakeQuestionIds: ["q1"] }),
      rule("s-sponsor", { applicability: "conditional", trigger: { questionId: "q1", anyOf: ["true"] }, intakeQuestionIds: ["q1"] }),
    ],
    intakeQuestions: [question("q1", ["s-funds", "s-sponsor"])],
    evidenceItems: [{ key: "ev1", title: "Bank statement", party: "applicant", criterionIds: ["s-funds"], source: cite("Show a bank statement.", "src-s") }],
  });
}

/** The member's own layer: a bar on a made-up nationality code and its own `q1`. */
function ownLayer(version = 2): VisaRubric {
  return approved(OWN, version, {
    criteria: [
      rule("o-bar", { kind: "mandatory_bar", stage: "suitability", severity: "critical", appliesTo: { nationalities: ["QZ"], asWritten: ["Made-up land"] } }),
      rule("o-days", { check: { field: "trip.days", op: "lte", value: 90 }, intakeQuestionIds: ["q1"] }),
    ],
    intakeQuestions: [question("q1", ["o-days"], { answerType: "text" })],
    evidenceItems: [{ key: "ev1", title: "Travel plan", party: "applicant", criterionIds: ["o-days"], source: cite("Show your plan.", "src-o") }],
    outcomeStatistics: { categoryKey: "short", categoryLabel: "Short stays" },
  });
}

// ============================================
// 1. Keys and the validator
// ============================================

describe("rulebook keys for any issuing authority", () => {
  test("a country key is today's key; a bloc key has no country fields", () => {
    assert.equal(rulebookKeyOf(OWN.countryCode, OWN.visaTypeId), OWN_KEY);
    assert.deepEqual(keyFieldsOf(rulebookTargetOf(OWN)), { routeKey: OWN_KEY, authorityId: "XQ", routeSlug: "xq-short-stay", countryCode: "XQ", visaTypeId: "xq-short-stay" });
    assert.deepEqual(keyFieldsOf(rulebookTargetOf({ authorityId: BLOC, routeSlug: SHARED_ROUTE })), { routeKey: SHARED_KEY, authorityId: BLOC, routeSlug: SHARED_ROUTE });
    // The naming pair callers have always used, per kind.
    assert.deepEqual(targetInputOf(rulebookTargetOf(OWN)), OWN);
    assert.deepEqual(targetInputOf(rulebookTargetOf({ authorityId: BLOC, routeSlug: SHARED_ROUTE })), { authorityId: BLOC, routeSlug: SHARED_ROUTE });
  });

  test("the historic pair only ever names a country; mixed or broken input is refused", () => {
    assert.throws(() => rulebookTargetOf({ countryCode: BLOC, visaTypeId: SHARED_ROUTE }), /country code/);
    assert.throws(() => rulebookTargetOf({ countryCode: "xq", visaTypeId: "a" }));
    assert.throws(() => rulebookTargetOf({ authorityId: BLOC }));
    assert.throws(() => rulebookTargetOf({ authorityId: "XQ", routeSlug: "a", countryCode: "XZ", visaTypeId: "a" }), /disagree/);
    assert.throws(() => rulebookTargetOf({ authorityId: "zq_bad", routeSlug: "a" }));
  });

  test("the review API's version ids accept a bloc key and still refuse junk", () => {
    assert.deepEqual(parseRubricVersionId(`${SHARED_KEY}__v4`), { routeKey: SHARED_KEY, version: 4 });
    assert.deepEqual(parseRubricVersionId(`${OWN_KEY}__v2`), { routeKey: OWN_KEY, version: 2 });
    assert.equal(parseRubricVersionId("xq_lower__v1"), null, "a lower-case two-letter id is neither a country nor a bloc");
    assert.equal(parseRubricVersionId("../x__v1"), null);
  });

  test("the drafting job endpoint takes either naming pair, never both", () => {
    assert.deepEqual(parseStartBody({ authorityId: BLOC, routeSlug: SHARED_ROUTE, dryRun: true }), { ok: true, input: { authorityId: BLOC, routeSlug: SHARED_ROUTE, dryRun: true } });
    assert.deepEqual(parseStartBody({ ...OWN }), { ok: true, input: { ...OWN } });
    assert.equal(parseStartBody({ authorityId: BLOC, routeSlug: SHARED_ROUTE, countryCode: "XQ" }).ok, false);
    assert.equal(parseStartBody({ authorityId: "zq_x", routeSlug: SHARED_ROUTE }).ok, false);
    assert.equal(parseStartBody({ authorityId: BLOC }).ok, false);
  });

  test("the auto-publish allowlist holds a bloc key next to a country key (same safeguards)", () => {
    const ok = resolvePublishSettings({ routeAllowlist: [OWN_KEY, SHARED_KEY] });
    assert.deepEqual(ok.problems, []);
    assert.deepEqual(ok.settings.routeAllowlist, [OWN_KEY, SHARED_KEY]);
    // Still fails closed on junk.
    assert.deepEqual(resolvePublishSettings({ routeAllowlist: ["xq_lower"] }).settings.routeAllowlist, []);
  });

  test("route_key_mismatch: the new key form, for both kinds", () => {
    const codes = (r: VisaRubric) => validateVisaRubric(r).errors.map((e) => e.code).filter((c) => c.startsWith("route_"));
    assert.deepEqual(codes(sharedLayer()), [], "a bloc rulebook keyed {authorityId}_{routeSlug} is valid");
    assert.deepEqual(codes(ownLayer()), [], "a country rulebook with both pairs is valid");
    assert.deepEqual(codes({ ...sharedLayer(), routeKey: "zq-bloc_other" }), ["route_key_mismatch"]);
    assert.deepEqual(codes({ ...sharedLayer(), countryCode: "XQ" } as VisaRubric), ["route_key_mismatch"], "a bloc rulebook has no country");
    // The key then disagrees with authorityId too: two reports, both route_key_mismatch.
    assert.deepEqual([...new Set(codes({ ...ownLayer(), authorityId: "XZ" }))], ["route_key_mismatch"], "both pairs must agree");
    const { authorityId: _a, routeSlug: _s, countryCode: _c, visaTypeId: _v, ...bare } = ownLayer();
    assert.deepEqual(codes(bare as VisaRubric), ["route_missing"]);
  });
});

// ============================================
// 2. A rulebook stored before #233 reads unchanged
// ============================================

describe("a rulebook stored before #233 (only countryCode + visaTypeId)", () => {
  before(async () => installRubricFakes());
  beforeEach(() => resetStore());

  /** Store head + approved version exactly as they were written before #233. */
  function storeOldShape(): VisaRubric {
    const { authorityId: _a, routeSlug: _s, ...old } = ownLayer(2);
    store.set(`visaRubrics/${OWN_KEY}`, { routeKey: OWN_KEY, countryCode: OWN.countryCode, visaTypeId: OWN.visaTypeId, sourceIds: ["src-o"], approvedVersion: 2, latestVersion: 2, latestSourceSetHash: old.sourceSetHash, createdAt: old.createdAt, updatedAt: old.createdAt });
    store.set(`visaRubrics/${OWN_KEY}/rubricVersions/2`, old);
    return old as VisaRubric;
  }

  test("the approved read serves it, with authorityId + routeSlug filled in; nothing is written", async () => {
    const old = storeOldShape();
    const rubrics = new RubricStore();
    const served = await rubrics.getApprovedRubric(OWN.countryCode, OWN.visaTypeId);
    assert.ok(served);
    assert.equal(served.version, 2);
    assert.equal(served.authorityId, "XQ");
    assert.equal(served.routeSlug, "xq-short-stay");
    assert.equal(served.countryCode, "XQ");
    assert.deepEqual(served.criteria, old.criteria, "the rules are the stored rules");
    // The same document through the by-key read and the head read.
    assert.equal((await rubrics.getApprovedRubricByKey(OWN_KEY))?.version, 2);
    assert.equal((await rubrics.getHead(OWN_KEY))?.authorityId, "XQ");
    // No data move: the stored documents still have only the old fields.
    assert.equal(store.get(`visaRubrics/${OWN_KEY}/rubricVersions/2`)?.authorityId, undefined);
    assert.equal(headDoc(OWN_KEY).authorityId, undefined);
    // And the validator accepts the old shape.
    assert.deepEqual(validateVisaRubric(old).errors.filter((e) => e.code.startsWith("route_")), []);
  });

  test("rulebookPartsOf / withKeyParts read either shape and never add a country to a bloc", () => {
    assert.deepEqual(withKeyParts({ routeKey: OWN_KEY, countryCode: "XQ", visaTypeId: "xq-short-stay" }), { routeKey: OWN_KEY, countryCode: "XQ", visaTypeId: "xq-short-stay", authorityId: "XQ", routeSlug: "xq-short-stay" });
    assert.equal(rulebookPartsOf({ routeKey: SHARED_KEY })?.shape, "group");
    assert.equal(rulebookPartsOf({ routeKey: SHARED_KEY })?.countryCode, undefined);
    assert.equal(rulebookPartsOf({ routeKey: "nope" }), null);
  });

  test("as an application's one-layer stack it is exactly the stored rulebook", async () => {
    storeOldShape();
    const rubrics = new RubricStore();
    const app = { countryCode: OWN.countryCode, visaTypeId: OWN.visaTypeId, routeStack: [OWN_KEY] };
    const viaOldReader = await rulebookFor(app, { getApprovedRubric: (cc, vt) => rubrics.getApprovedRubric(cc, vt) });
    const direct = await rubrics.getApprovedRubric(OWN.countryCode, OWN.visaTypeId);
    assert.deepEqual(viaOldReader, direct);
    assert.equal(viaOldReader?.stackLayers, undefined, "no stack field on a single-layer route");
  });
});

// ============================================
// 3. Extracting a bloc rulebook
// ============================================

describe("extracting a rulebook for a bloc's shared route", () => {
  let h: Harness;
  let routeOwner = BLOC;
  before(async () => installRubricFakes());
  beforeEach(async () => {
    resetStore();
    resetBucket();
    routeOwner = BLOC;
    h = makeHarness({
      sharedRoute: async (_authorityId, slug) => (slug === SHARED_ROUTE ? { id: SHARED_ROUTE, name: "Short stay (made up)", issuingAuthorityId: routeOwner, status: "active" as const } : null),
    });
    await seedSource({ id: SOURCE_A_ID, url: SOURCE_A_URL, text: Object.values(A_LINES).join("\n") });
  });

  /** A one-rule answer quoting the page verbatim. */
  const oneRule = () => answer({ criteria: [crit({ ref: "age", title: "Aged 18 or over", kind: "objective", ruleRef: "SV 2.1", quote: A_LINES.age.replace(/^SV 2\.1 /, ""), check: { field: "applicant.age", op: "gte", value: 18, unit: null } })] });

  test("a pending version and a head under {authorityId}_{routeSlug}, with no country fields", async () => {
    await recordAnswers(h.provider, SOURCE_A_ID, [oneRule()]);
    const { result } = await quiet(() => h.service.extractRoute({ authorityId: BLOC, routeSlug: SHARED_ROUTE, sourceIds: [SOURCE_A_ID] }));
    assert.equal(result.status, "succeeded", JSON.stringify(result));
    assert.equal(result.routeKey, SHARED_KEY);
    const v = versionDoc(SHARED_KEY, 1);
    assert.equal(v.reviewStatus, "pending_review", "extraction never approves");
    assert.equal(v.authorityId, BLOC);
    assert.equal(v.routeSlug, SHARED_ROUTE);
    assert.equal(v.countryCode, undefined);
    assert.equal(v.visaTypeId, undefined);
    assert.equal(v.criteria[0].source.url.length > 0, true, "the rule keeps its URL");
    assert.ok(A_LINES.age.includes(v.criteria[0].source.quote), "the rule keeps its verbatim quote");
    const head = headDoc(SHARED_KEY);
    assert.deepEqual([head.routeKey, head.authorityId, head.routeSlug, head.countryCode, head.approvedVersion], [SHARED_KEY, BLOC, SHARED_ROUTE, undefined, null]);
    const run = [...store.entries()].find(([p]) => p.startsWith("rubricExtractionRuns/"))?.[1] as any;
    assert.equal(run.authorityId, BLOC);
    assert.equal(run.countryCode, undefined);
  });

  test("refused when the shared route belongs to another authority (no model call, nothing written)", async () => {
    routeOwner = "zq-other";
    const { result } = await quiet(() => h.service.extractRoute({ authorityId: BLOC, routeSlug: SHARED_ROUTE, sourceIds: [SOURCE_A_ID] }));
    assert.equal(result.status, "failed");
    assert.equal(result.reasonCode, "shared_route_not_found");
    assert.equal(h.provider.requests.length, 0);
    assert.equal(versionDoc(SHARED_KEY, 1), undefined);
  });
});

// ============================================
// 4. The stack loader
// ============================================

describe("loadRulebookStack", () => {
  /** A reader over fixture layers. */
  const reader = (byKey: Record<string, VisaRubric | null>) => async (layer: RouteLayer) => byKey[layer.rulebookKey] ?? null;

  test("both layers approved: one merged view, shared rules first, every rule kept", async () => {
    const stack = await loadRulebookStack(STACK, reader({ [SHARED_KEY]: sharedLayer(3), [OWN_KEY]: ownLayer(2) }));
    assert.equal(stack.usable, true);
    assert.deepEqual(stack.missing, []);
    assert.deepEqual(stack.layers.map((l) => [l.rulebookKey, l.role, l.status, l.version]), [
      [SHARED_KEY, "shared", "approved", 3],
      [OWN_KEY, "own", "approved", 2],
    ]);
    const r = stack.rubric as VisaRubric;
    assert.deepEqual(r.criteria.map((c) => c.criterionId), [scopedId(SHARED_KEY, "s-funds"), scopedId(SHARED_KEY, "s-sponsor"), "o-bar", "o-days"]);
    assert.equal(r.routeKey, OWN_KEY, "keyed as the application's own route");
    assert.equal(r.countryCode, "XQ");
    assert.equal(r.version, 2, "the own layer's version");
    assert.deepEqual(layerVersionsOf(r), { [SHARED_KEY]: 3, [OWN_KEY]: 2 });
    assert.deepEqual(r.outcomeStatistics, ownLayer().outcomeStatistics, "statistics are the destination country's");
    // Every rule keeps its own verbatim quote and URL.
    for (const c of r.criteria) assert.match(c.source.quote, /^The quote of rule /);
  });

  test("a missing layer is reported, and the stack is still usable on the other", async () => {
    const stack = await loadRulebookStack(STACK, reader({ [SHARED_KEY]: sharedLayer(3), [OWN_KEY]: null }));
    assert.equal(stack.usable, true);
    assert.deepEqual(stack.missing.map((l) => [l.rulebookKey, l.status, l.version]), [[OWN_KEY, "missing", null]]);
    const r = stack.rubric as VisaRubric;
    assert.equal(r.version, 0, "no own version approved");
    assert.equal(r.routeKey, OWN_KEY);
    assert.deepEqual(r.stackLayers?.map((l) => l.status), ["approved", "missing"], "the merged view says which layer is missing");
    assert.equal(r.outcomeStatistics, undefined, "never another layer's statistics");
  });

  test("no layer approved: not usable, never a partial rulebook", async () => {
    const stack = await loadRulebookStack(STACK, reader({}));
    assert.equal(stack.usable, false);
    assert.equal(stack.unusableReason, "no_layer_approved");
    assert.equal(stack.rubric, null);
    assert.equal(stack.missing.length, 2);
  });

  test("a single layer is served UNCHANGED (the same object)", async () => {
    const own = ownLayer(2);
    const stack = await loadRulebookStack([STACK[1]], reader({ [OWN_KEY]: own }));
    assert.equal(stack.rubric, own);
    assert.equal(layerVersionsOf(own), undefined);
  });

  test("a read error is not swallowed (no partial rulebook from an error)", async () => {
    await assert.rejects(loadRulebookStack(STACK, async () => Promise.reject(new Error("unavailable"))), /unavailable/);
  });

  test("an application reader without stack support reads its own layer alone", async () => {
    const own = ownLayer(2);
    const stack = await rulebookStackFor({ countryCode: OWN.countryCode, visaTypeId: OWN.visaTypeId }, { getApprovedRubric: async () => own });
    assert.equal(stack.layers.length, 1);
    assert.equal(stack.rubric, own);
  });
});

// ============================================
// 5. Intake across layers
// ============================================

describe("intake across layers", () => {
  const merged = () => mergeRulebookStack([{ layer: STACK[0], rubric: sharedLayer() }, { layer: STACK[1], rubric: ownLayer() }]) as VisaRubric;

  test("the union of questions, each asked once; colliding ids are scoped, references follow", () => {
    const r = merged();
    const sq1 = scopedId(SHARED_KEY, "q1");
    assert.deepEqual(r.intakeQuestions.map((q) => q.id), [sq1, "q1"]);
    assert.deepEqual(r.intakeQuestions.map((q) => q.layerKey), [SHARED_KEY, OWN_KEY]);
    assert.deepEqual(r.intakeQuestions[0].criterionIds, [scopedId(SHARED_KEY, "s-funds"), scopedId(SHARED_KEY, "s-sponsor")]);
    const sponsor = r.criteria.find((c) => c.criterionId === scopedId(SHARED_KEY, "s-sponsor")) as AssessmentCriterion;
    assert.deepEqual(sponsor.trigger, { questionId: sq1, anyOf: ["true"] }, "the trigger reads its OWN layer's question");
    assert.deepEqual(r.evidenceItems.map((e) => e.key), [scopedId(SHARED_KEY, "ev1"), "ev1"]);
    // The own layer's ids are exactly as it stores them.
    assert.deepEqual(r.criteria.filter((c) => c.layerKey === OWN_KEY).map((c) => c.criterionId), ["o-bar", "o-days"]);
  });

  test("the question plan simulates the stack", () => {
    const plan = planStack([{ rulebookKey: SHARED_KEY, role: "shared", view: sharedLayer() }, { rulebookKey: OWN_KEY, role: "own", view: ownLayer() }], merged());
    assert.equal(plan.ok, true);
    if (plan.ok) assert.equal(plan.sizing.total, 2);
  });

  test("a trigger that reads ANOTHER layer's question: the stack is refused, with the reason", () => {
    // The own layer's rule names `qs`, which exists only in the shared layer.
    const shared = sharedLayer();
    shared.intakeQuestions = [...shared.intakeQuestions, question("qs", ["s-funds"])];
    const own = ownLayer();
    own.criteria = [...own.criteria, rule("o-cross", { applicability: "conditional", trigger: { questionId: "qs", anyOf: ["true"] } })];
    const stack = stackFromReads([{ layer: STACK[0], rubric: shared }, { layer: STACK[1], rubric: own }]);
    assert.equal(stack.usable, false);
    assert.equal(stack.unusableReason, "plan_rejected");
    assert.equal(stack.problems[0].code, "cross_layer_reference");
    assert.equal(stack.problems[0].rulebookKey, OWN_KEY);
    assert.match(stack.problems[0].detail, /o-cross/);
  });

  test("through the intake service: answers are validated and saved per scoped question, layers listed", async () => {
    const original = intakeRulebookReader.read;
    intakeRulebookReader.read = async () => stackFromReads([{ layer: STACK[0], rubric: sharedLayer() }, { layer: STACK[1], rubric: ownLayer() }]);
    const firebase: any = await import("../../../src/utils/firebase");
    const savedCollections = firebase.collections.applications;
    const updates: any[] = [];
    firebase.collections.applications = { doc: () => ({ update: async (d: unknown) => void updates.push(d) }) };
    try {
      const svc = new IntakeService();
      const app = { id: "app-1", userId: "u-1", countryCode: OWN.countryCode, visaTypeId: OWN.visaTypeId, routeStack: [SHARED_KEY, OWN_KEY], status: "draft" } as any;
      const view = await svc.getIntake(app);
      assert.equal(view.available, true);
      assert.deepEqual(view.questions.map((q) => q.id), effectiveIntakeQuestions(merged()).map((q) => q.id));
      assert.deepEqual(view.openRequiredIds, [scopedId(SHARED_KEY, "q1"), "q1"]);
      assert.deepEqual(view.layers?.map((l) => [l.rulebookKey, l.status]), [[SHARED_KEY, "approved"], [OWN_KEY, "approved"]]);
      // Both `q1`s are answered separately; neither overwrites the other.
      const after = await svc.saveIntake(app, { [scopedId(SHARED_KEY, "q1")]: true, q1: "Ten days" });
      assert.deepEqual(after.openRequiredIds, []);
      assert.deepEqual(updates[0].intake.answers, { [scopedId(SHARED_KEY, "q1")]: true, q1: "Ten days" });
      assert.deepEqual(updates[0].intake.layerVersions, { [SHARED_KEY]: 3, [OWN_KEY]: 2 });
    } finally {
      intakeRulebookReader.read = original;
      firebase.collections.applications = savedCollections;
    }
  });
});

// ============================================
// 6. Assessment over two layers
// ============================================

describe("assessment over two layers", () => {
  const merged = () => mergeRulebookStack([{ layer: STACK[0], rubric: sharedLayer() }, { layer: STACK[1], rubric: ownLayer() }]) as VisaRubric;
  const sFunds = scopedId(SHARED_KEY, "s-funds");

  test("a failed rule in the SHARED layer fails the application, and the finding names its layer", () => {
    const rubric = merged();
    const split = splitByApplicability(rubric, { [scopedId(SHARED_KEY, "q1")]: false });
    // The conditional shared rule is not triggered; every other rule applies; nothing is lost.
    assert.equal(split.applicable.length + split.notApplicableIds.length + split.unknown.length, rubric.criteria.length);
    const content = assembleContent({
      rubric: { ...rubric, criteria: split.applicable },
      mandatoryHits: [],
      objective: [
        { criterionId: sFunds, outcome: "fail", reason: "funds.balance is below 100" },
        { criterionId: "o-days", outcome: "pass", reason: "within 90" },
      ],
      judgement: null,
      documents: [],
      statementReadable: false,
      score: null,
      suspiciousDocumentIds: [],
      judgementFailed: false,
    });
    assert.equal(content.internalCall, "would_refuse");
    assert.deepEqual(content.refusalGrounds.map((g) => [g.criterionId, g.layerKey, g.sourceQuote]), [[sFunds, SHARED_KEY, "The quote of rule s-funds."]]);
  });

  test("a bar in the OWN layer still bars (code-decided), tagged with its layer", () => {
    const rubric = merged();
    const hits = mandatoryBarHits(rubric, "QZ", "2026-11-14");
    assert.deepEqual(hits.map((c) => c.criterionId), ["o-bar"]);
    const content = assembleContent({ rubric, mandatoryHits: hits, objective: [], judgement: null, documents: [], statementReadable: false, score: null, suspiciousDocumentIds: [], judgementFailed: false });
    assert.equal(content.hasBlockingRule, true);
    assert.equal(content.refusalGrounds[0].layerKey, OWN_KEY);
  });

  test("a single-layer route's findings carry no layer field (unchanged)", () => {
    const own = ownLayer();
    const content = assembleContent({ rubric: own, mandatoryHits: [], objective: [{ criterionId: "o-days", outcome: "fail", reason: "too long" }], judgement: null, documents: [], statementReadable: false, score: null, suspiciousDocumentIds: [], judgementFailed: false });
    assert.equal("layerKey" in content.refusalGrounds[0], false);
  });

  test("the stricter intent polarity of the layers decides", () => {
    const shared = sharedLayer();
    shared.intentPolarity = "immigrant_intent_penalised";
    const r = mergeRulebookStack([{ layer: STACK[0], rubric: shared }, { layer: STACK[1], rubric: ownLayer() }]) as VisaRubric;
    assert.equal(r.intentPolarity, "immigrant_intent_penalised");
  });

  test("input hash: unchanged for a single layer, and a new version of ANY layer changes a stack's", () => {
    const base = { rubricVersion: 2, documents: [], statements: [], eligibilityAnswers: null, intake: {} };
    assert.equal(computeInputHash({ ...base, layerVersions: undefined }), computeInputHash(base), "a single-layer hash is what it always was");
    const a = computeInputHash({ ...base, layerVersions: { [SHARED_KEY]: 3, [OWN_KEY]: 2 } });
    const b = computeInputHash({ ...base, layerVersions: { [SHARED_KEY]: 4, [OWN_KEY]: 2 } });
    assert.notEqual(a, b);
    assert.equal(sameStackVersions({ version: 2, layerVersions: { [SHARED_KEY]: 3, [OWN_KEY]: 2 } }, { version: 2, layerVersions: { [SHARED_KEY]: 4, [OWN_KEY]: 2 } }), false);
    assert.equal(sameStackVersions({ version: 2 }, { version: 2 }), true);
    assert.equal(sameStackVersions({ version: 2 }, { version: 2, layerVersions: { [OWN_KEY]: 2, [SHARED_KEY]: 3 } }), false);
  });
});
