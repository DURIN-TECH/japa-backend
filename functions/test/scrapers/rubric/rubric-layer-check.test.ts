// ============================================
// Stacked rulebooks, second half: the layer check, `restates` and conflicts
// (issue #233, P4b of #228)
// ============================================
//
// What this file pins:
//   1. the layer check (rubric-layer-check.ts) over a RECORDED / fake model:
//      a disagreement becomes a conflict with both quotes and URLs; a repeat
//      becomes a `restates` link only on a confident `same_requirement` that
//      also passes the code guards; the model sees only the verbatim quotes;
//   2. the "not checked" path: over a cap (no call made), a provider failure, an
//      answer that does not validate: `not_checked`, visible, NOTHING linked;
//   3. the merged view honours a link: the national rule is folded into its
//      shared twin (asked and assessed once), its own quote and URL kept on
//      `restatedBy`; a stale link (the twin's quote changed) is NOT honoured;
//      conflicts are tagged on both rules and both stay;
//   4. intake and assessment through the merged view: the restating rule's
//      question is not asked again, and the assessment has the rule once;
//   5. a single-layer route is untouched.
//
// Every id is made up (Q/X/Z codes, `zq-` blocs). No Firebase (pure, or the
// in-memory fake). No paid call: the model is a scripted fake.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { Timestamp } from "firebase-admin/firestore";
import {
  DEFAULT_LAYER_CHECK_LIMITS,
  LAYER_CHECK_PROMPT_VERSION,
  RubricLayerChecker,
  decideLayerLinks,
  linkRefusal,
  runLayerCheck,
  type LayerCheckInput,
} from "../../../src/scrapers/rubric/rubric-layer-check";
import { mergeRulebookStack, scopedId, stackFromReads } from "../../../src/scrapers/rubric/rubric-stack";
import { effectiveIntakeQuestions, splitByApplicability } from "../../../src/services/ai/rule-applicability";
import { assembleContent } from "../../../src/services/ai/assessment-engine";
import { IntakeService, intakeRulebookReader } from "../../../src/services/intake.service";
import { keyFieldsOf, rulebookTargetOf } from "../../../src/scrapers/rubric/rubric-key";
import type { AssessmentCriterion, IntakeQuestion, LayerCheckRecord, VisaRubric } from "../../../src/types/rubric";
import type { RouteLayer } from "../../../src/types/shared-route";
import type { LlmProvider, LlmRequest, LlmResponse } from "../../../src/services/ai/llm-provider";

/* eslint-disable @typescript-eslint/no-explicit-any */

// ============================================
// Fixtures (made-up ids and made-up sentences only)
// ============================================

const BLOC = "zq-bloc";
const SHARED_ROUTE = "zq-short-stay";
const SHARED_KEY = `${BLOC}_${SHARED_ROUTE}`;
const OWN = { countryCode: "XQ", visaTypeId: "xq-short-stay" };
const OWN_KEY = `${OWN.countryCode}_${OWN.visaTypeId}`;
const STACK: RouteLayer[] = [
  { authorityId: BLOC, rulebookKey: SHARED_KEY, role: "shared" },
  { authorityId: OWN.countryCode, rulebookKey: OWN_KEY, role: "own" },
];

/** The made-up sentences. The national page restates the stay limit, disagrees on insurance and adds a funds amount. */
const Q = {
  sharedStay: "A visitor may stay for no more than 90 days in any 180-day period.",
  ownStay: "You may stay for no more than 90 days in any period of 180 days.",
  sharedCover: "The applicant must hold travel medical insurance covering at least 30,000.",
  ownCover: "The applicant must hold travel medical insurance covering at least 50,000.",
  sharedMeans: "The applicant must have sufficient means of subsistence.",
  ownMeans: "You must have at least 55 per person per day of the stay.",
  ownLocal: "You must register with the local office within three days of arrival.",
};

/** A citation with a verbatim quote and a made-up URL. */
const cite = (quote: string, sourceId: string) => ({ quote, sourceId, url: `https://rules.example/${sourceId}`, contentHash: "h".repeat(64), retrievedAt: "2026-11-01T00:00:00.000Z" });

/** One rule. */
function rule(id: string, quote: string, sourceId: string, over: Partial<AssessmentCriterion> = {}): AssessmentCriterion {
  return { criterionId: id, title: `Rule ${id}`, kind: "judgement", stage: "eligibility", severity: "high", source: cite(quote, sourceId), applicability: "all_applicants", confidence: 0.9, ...over } as AssessmentCriterion;
}

/** One question. */
const question = (id: string, criterionIds: string[], over: Partial<IntakeQuestion> = {}): IntakeQuestion => ({ id, label: `Question ${id}?`, answerType: "yes_no", required: true, criterionIds, ...over });

/** An approved version in the shape the store serves. */
function approved(key: { countryCode?: string; visaTypeId?: string; authorityId?: string; routeSlug?: string }, version: number, over: Partial<VisaRubric> = {}): VisaRubric {
  const target = rulebookTargetOf(key);
  return {
    schemaVersion: 1, ...keyFieldsOf(target), version, reviewStatus: "approved", intentPolarity: "dual_intent_permitted", reviewedBy: "system:rubric-auto-publish",
    reviewedAt: Timestamp.fromMillis(Date.parse("2026-11-10T00:00:00Z")), rejectReason: null, revision: 1, supersededAt: null, intentPolarityProposal: null,
    severityLevels: ["critical", "high", "medium", "low"], criteria: [], intakeQuestions: [], evidenceItems: [], sourceSnapshots: [], sourceSetHash: `hash-${target.routeKey}-${version}`,
    extractorModel: "model-x", extractorPromptVersion: "p-1", extractionRunId: `run-${target.routeKey}-${version}`, discardedCount: 0, discarded: [], suspiciousPassages: [], flags: [],
    createdAt: Timestamp.fromMillis(Date.parse("2026-11-09T00:00:00Z")), ...over,
  };
}

/** The shared layer: stay limit, insurance, means. Its question ids collide with the own layer's on purpose. */
function sharedLayer(version = 3, over: Partial<VisaRubric> = {}): VisaRubric {
  return approved({ authorityId: BLOC, routeSlug: SHARED_ROUTE }, version, {
    criteria: [rule("s-stay", Q.sharedStay, "src-s"), rule("s-cover", Q.sharedCover, "src-s"), rule("s-means", Q.sharedMeans, "src-s")],
    intakeQuestions: [question("q1", ["s-stay"], { answerType: "number" })],
    ...over,
  });
}

/** The own layer: the restated stay limit (with its own question and document item), insurance (disagrees), funds (adds to), a local rule. */
function ownLayer(version = 2, over: Partial<VisaRubric> = {}): VisaRubric {
  return approved(OWN, version, {
    criteria: [rule("o-stay", Q.ownStay, "src-o"), rule("o-cover", Q.ownCover, "src-o"), rule("o-means", Q.ownMeans, "src-o"), rule("o-local", Q.ownLocal, "src-o")],
    intakeQuestions: [question("q1", ["o-stay"], { answerType: "number" }), question("q2", ["o-local"])],
    evidenceItems: [{ key: "ev-plan", title: "Travel plan", party: "applicant", criterionIds: ["o-stay"], source: cite(Q.ownStay, "src-o") }],
    ...over,
  });
}

/** The relation the fake model answers for a pair of quotes (anything not listed: a different subject). */
const RELATIONS: Record<string, string> = {
  [`${Q.ownStay}|${Q.sharedStay}`]: "same_requirement",
  [`${Q.ownCover}|${Q.sharedCover}`]: "disagrees",
  [`${Q.ownMeans}|${Q.sharedMeans}`]: "adds_to",
};

/** Pull a wrapped JSON block (prompt-safety escapes `<` and `>` only, so the JSON is intact). */
function block(user: string, source: string): { id: string; quote: string }[] {
  const m = new RegExp(`source="${source}">\\n([\\s\\S]*?)\\n</`).exec(user);
  return m ? JSON.parse(m[1]) : [];
}

/**
 * A scripted model: answers from RELATIONS by the quotes it was shown, or with
 * `override` (a bad answer, a refusal). Records every request.
 */
class FakeLayerModel implements LlmProvider {
  readonly requests: LlmRequest[] = [];
  override: ((req: LlmRequest) => Partial<LlmResponse> | Error) | null = null;
  relations: Record<string, string> = RELATIONS;
  modelFor(): string {
    return "fake-verification-model";
  }
  async complete(req: LlmRequest): Promise<LlmResponse> {
    this.requests.push(req);
    const usage = { inputTokens: 1_000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 };
    if (this.override) {
      const o = this.override(req);
      if (o instanceof Error) throw o;
      return { text: "", stopReason: "end_turn", usage, model: "fake-verification-model", ...o } as LlmResponse;
    }
    const national = block(req.user, "national_rules");
    const shared = block(req.user, "shared_rules");
    const answers = national.map((n) => ({
      id: n.id,
      matches: shared.flatMap((s) => (this.relations[`${n.quote}|${s.quote}`] ? [{ shared_id: s.id, relation: this.relations[`${n.quote}|${s.quote}`] }] : [])),
    }));
    return { text: JSON.stringify({ answers }), stopReason: "end_turn", usage, model: "fake-verification-model" };
  }
}

/** The check's input for the fixture layers. */
const inputOf = (own = ownLayer(), shared = sharedLayer()): LayerCheckInput => ({ ownRulebookKey: OWN_KEY, ownCriteria: own.criteria, shared: [{ rulebookKey: SHARED_KEY, version: shared.version, criteria: shared.criteria }] });

/** The own layer as the approval writes it: with the layer check's record and conflicts. */
async function checkedOwnLayer(model = new FakeLayerModel(), own = ownLayer(), shared = sharedLayer()): Promise<VisaRubric> {
  const out = await runLayerCheck(inputOf(own, shared), model);
  return { ...own, layerCheck: out.record, layerConflicts: out.conflicts };
}

// ============================================
// 1. The check over a fake model
// ============================================

describe("the layer check: conflicts and restates links from closed answers", () => {
  test("a repeat is linked, a disagreement is a conflict with both quotes and URLs, an addition is neither", async () => {
    const model = new FakeLayerModel();
    const out = await runLayerCheck(inputOf(), model);
    const r = out.record;
    assert.equal(r.status, "checked");
    assert.equal(r.promptVersion, LAYER_CHECK_PROMPT_VERSION);
    assert.equal(r.model, "fake-verification-model");
    assert.deepEqual(r.sharedLayers, [{ rulebookKey: SHARED_KEY, version: 3 }]);
    assert.deepEqual([r.ownRulesChecked, r.sharedRulesChecked, r.calls], [4, 3, 1]);
    assert.deepEqual([r.inputTokens, r.outputTokens], [1_000, 100], "the spend as the provider reported it");
    // The repeat: one link, recording the twin's quote.
    assert.deepEqual(r.restates, [{ criterionId: "o-stay", sharedRulebookKey: SHARED_KEY, sharedVersion: 3, sharedCriterionId: "s-stay", sharedQuote: Q.sharedStay }]);
    // The disagreement: both quotes and both URLs.
    assert.equal(out.conflicts.length, 1);
    assert.deepEqual(out.conflicts[0], {
      criterionId: "o-cover", title: "Rule o-cover", quote: Q.ownCover, url: "https://rules.example/src-o",
      sharedRulebookKey: SHARED_KEY, sharedVersion: 3, sharedCriterionId: "s-cover", sharedTitle: "Rule s-cover", sharedQuote: Q.sharedCover, sharedUrl: "https://rules.example/src-s",
    });
    assert.equal(r.conflictCount, 1);
    assert.deepEqual(r.refusedLinks, []);
    assert.deepEqual(r.unsure, []);
  });

  test("the model is shown ONLY the verbatim quotes under batch-local ids, through the checker's independent role", async () => {
    const model = new FakeLayerModel();
    await runLayerCheck(inputOf(), model);
    const req = model.requests[0];
    assert.equal(req.role, "verification");
    const national = block(req.user, "national_rules");
    assert.deepEqual(national.map((n) => Object.keys(n).sort()), Array(4).fill(["id", "quote"]));
    assert.deepEqual(national.map((n) => n.id), ["n1", "n2", "n3", "n4"]);
    for (const c of [...ownLayer().criteria, ...sharedLayer().criteria]) assert.ok(!req.user.includes(c.criterionId), "no real id reaches the model");
    assert.ok(!req.user.includes("Rule o-"), "no AI-written title reaches the model");
  });

  test("an `unsure` answer is recorded and nothing is linked; a rule both repeated and doubted is not linked", async () => {
    const model = new FakeLayerModel();
    model.relations = { [`${Q.ownStay}|${Q.sharedStay}`]: "unsure" };
    const out = await runLayerCheck(inputOf(), model);
    assert.deepEqual(out.record.restates, []);
    assert.deepEqual(out.record.unsure, [{ criterionId: "o-stay", sharedRulebookKey: SHARED_KEY, sharedCriterionId: "s-stay" }]);
    // Same requirement as one shared rule AND disputed against another: never linked.
    model.relations = { [`${Q.ownStay}|${Q.sharedStay}`]: "same_requirement", [`${Q.ownStay}|${Q.sharedMeans}`]: "disagrees" };
    const both = await runLayerCheck(inputOf(), model);
    assert.deepEqual(both.record.restates, []);
    assert.deepEqual(both.record.refusedLinks.map((x) => [x.criterionId, x.reason]), [["o-stay", "rule_also_disputed_or_doubted"]]);
  });

  test("code guards: a `same_requirement` is NOT linked across kinds, applicability, checks, bar groups, or to a less severe twin", () => {
    const base = rule("o", "x", "s");
    const twin = rule("s", "x", "s");
    assert.equal(linkRefusal(base, twin), null);
    assert.equal(linkRefusal({ ...base, kind: "mandatory_bar" }, twin), "different_kind");
    assert.equal(linkRefusal({ ...base, applicability: "conditional" }, twin), "different_applicability");
    assert.equal(linkRefusal({ ...base, trigger: { questionId: "q", anyOf: ["true"] } }, twin), "different_trigger");
    assert.equal(linkRefusal({ ...base, kind: "objective", check: { field: "a", op: "gte", value: 1 } } as any, { ...twin, kind: "objective", check: { field: "a", op: "gte", value: 2 } } as any), "different_check");
    assert.equal(linkRefusal({ ...base, kind: "mandatory_bar", appliesTo: { nationalities: ["QZ"] } } as any, { ...twin, kind: "mandatory_bar", appliesTo: { nationalities: ["QY"] } } as any), "different_bar_groups");
    assert.equal(linkRefusal({ ...base, severity: "critical" }, twin), "national_rule_more_severe");
    // Two twins for one national rule: refused (never guess which).
    const input = inputOf();
    const two = decideLayerLinks(input, [
      { criterionId: "o-stay", sharedIndex: 0, sharedCriterionId: "s-stay", relation: "same_requirement" },
      { criterionId: "o-stay", sharedIndex: 0, sharedCriterionId: "s-means", relation: "same_requirement" },
    ]);
    assert.deepEqual(two.restates, []);
    assert.deepEqual(two.refusedLinks.map((x) => x.reason), ["more_than_one_twin", "more_than_one_twin"]);
  });

  test("batching is deterministic and cut by count: every own batch meets every shared chunk", async () => {
    const model = new FakeLayerModel();
    const out = await runLayerCheck(inputOf(), model, { ...DEFAULT_LAYER_CHECK_LIMITS, ownBatchSize: 2, sharedChunkSize: 2, concurrency: 1 });
    assert.equal(out.record.calls, 4, "2 own batches x 2 shared chunks");
    // The same result as one call: answers are keyed by rule.
    assert.deepEqual(out.record.restates.map((l) => l.criterionId), ["o-stay"]);
    assert.equal(out.conflicts.length, 1);
  });
});

// ============================================
// 2. Not checked: nothing linked, visibly
// ============================================

describe("the layer check: not checked", () => {
  const assertNothingLinked = (r: LayerCheckRecord, reason: RegExp) => {
    assert.equal(r.status, "not_checked");
    assert.match(String(r.reason), reason);
    assert.deepEqual(r.restates, []);
    assert.equal(r.conflictCount, 0);
  };

  test("over the call cap: refused BEFORE any call", async () => {
    const model = new FakeLayerModel();
    const out = await runLayerCheck(inputOf(), model, { ...DEFAULT_LAYER_CHECK_LIMITS, ownBatchSize: 1, sharedChunkSize: 1, maxCalls: 3 });
    assertNothingLinked(out.record, /^capped: 12 calls needed, the cap is 3$/);
    assert.equal(model.requests.length, 0, "nothing was spent");
    assert.deepEqual(out.conflicts, []);
  });

  test("over the token cap (estimated): refused before any call", async () => {
    const model = new FakeLayerModel();
    const out = await runLayerCheck(inputOf(), model, { ...DEFAULT_LAYER_CHECK_LIMITS, maxTotalTokens: 10 });
    assertNothingLinked(out.record, /^capped: about/);
    assert.equal(model.requests.length, 0);
  });

  test("the publish settings' request cap lowers the check's own (never raises it)", async () => {
    const model = new FakeLayerModel();
    const checker = new RubricLayerChecker({ provider: model, limits: { ...DEFAULT_LAYER_CHECK_LIMITS, ownBatchSize: 1, sharedChunkSize: 1 } });
    const out = await checker.check(inputOf(), { maxRequests: 5 });
    assertNothingLinked(out.record, /cap is 5/);
    assert.equal(model.requests.length, 0);
  });

  test("a provider failure, a refusal or an unusable answer: not checked, the spend so far recorded", async () => {
    for (const [override, code] of [
      [() => new Error("network"), "provider_error"],
      [() => ({ stopReason: "refusal" }), "provider_refused"],
      [() => ({ stopReason: "max_tokens" }), "provider_stopped"],
      [() => ({ text: "not json" }), "output_invalid"],
      [() => ({ text: JSON.stringify({ answers: [] }) }), "output_invalid"],
      [(req: LlmRequest) => ({ text: JSON.stringify({ answers: block(req.user, "national_rules").map((n) => ({ id: n.id, matches: [{ shared_id: "s99", relation: "same_requirement" }] })) }) }), "output_invalid"],
      [(req: LlmRequest) => ({ text: JSON.stringify({ answers: block(req.user, "national_rules").map((n) => ({ id: n.id, matches: [{ shared_id: "s1", relation: "probably" }] })) }) }), "output_invalid"],
    ] as const) {
      const model = new FakeLayerModel();
      model.override = override as any;
      const out = await runLayerCheck(inputOf(), model);
      assertNothingLinked(out.record, new RegExp(`^${code}$`));
      assert.deepEqual(out.conflicts, []);
    }
  });

  test("a not-checked own layer serves both rules (duplicated, never guessed)", async () => {
    const model = new FakeLayerModel();
    model.override = () => new Error("down");
    const own = await checkedOwnLayer(model);
    const merged = mergeRulebookStack([{ layer: STACK[0], rubric: sharedLayer() }, { layer: STACK[1], rubric: own }]) as VisaRubric;
    assert.ok(merged.criteria.some((c) => c.criterionId === "o-stay"));
    assert.ok(merged.criteria.some((c) => c.criterionId === scopedId(SHARED_KEY, "s-stay")));
    assert.equal(merged.criteria.some((c) => c.restatedBy), false);
  });
});

// ============================================
// 3. The merged view honours the links
// ============================================

describe("the merged view: restates folded, conflicts tagged", () => {
  const sStay = scopedId(SHARED_KEY, "s-stay");
  const sCover = scopedId(SHARED_KEY, "s-cover");

  test("the national repeat is folded into its twin, keeping its own quote and URL; its question is not asked again; its document item stays", async () => {
    const own = await checkedOwnLayer();
    const merged = mergeRulebookStack([{ layer: STACK[0], rubric: sharedLayer() }, { layer: STACK[1], rubric: own }]) as VisaRubric;
    const ids = merged.criteria.map((c) => c.criterionId);
    assert.ok(!ids.includes("o-stay"), "assessed once: under the shared rule");
    const twin = merged.criteria.find((c) => c.criterionId === sStay) as AssessmentCriterion;
    assert.deepEqual(twin.restatedBy, [{ rulebookKey: OWN_KEY, criterionId: "o-stay", title: "Rule o-stay", quote: Q.ownStay, url: "https://rules.example/src-o" }]);
    assert.equal(twin.source.quote, Q.sharedStay, "the shared rule keeps its own quote");
    // Asked once: the own `q1` (only the repeat asked it) is gone; the shared one stays.
    assert.deepEqual(merged.intakeQuestions.map((q) => q.id), [scopedId(SHARED_KEY, "q1"), "q2"]);
    // The national document item is never dropped: it now names the twin.
    assert.deepEqual(merged.evidenceItems.map((e) => [e.key, e.criterionIds]), [["ev-plan", [sStay]]]);
    // Every other rule is still there, the stored own version untouched.
    assert.deepEqual(ids, [sStay, sCover, scopedId(SHARED_KEY, "s-means"), "o-cover", "o-means", "o-local"]);
    assert.ok(own.criteria.some((c) => c.criterionId === "o-stay"));
  });

  test("a conflict: both rules stay, each tagged with the other", async () => {
    const own = await checkedOwnLayer();
    const merged = mergeRulebookStack([{ layer: STACK[0], rubric: sharedLayer() }, { layer: STACK[1], rubric: own }]) as VisaRubric;
    assert.deepEqual(merged.criteria.find((c) => c.criterionId === "o-cover")?.layerConflictWith, [sCover]);
    assert.deepEqual(merged.criteria.find((c) => c.criterionId === sCover)?.layerConflictWith, ["o-cover"]);
  });

  test("the stricter result decides: a failure of EITHER side of a conflict fails the application, and both are shown", async () => {
    const own = await checkedOwnLayer();
    const merged = mergeRulebookStack([{ layer: STACK[0], rubric: sharedLayer() }, { layer: STACK[1], rubric: own }]) as VisaRubric;
    const content = assembleContent({
      rubric: merged, mandatoryHits: [],
      objective: [{ criterionId: sCover, outcome: "pass", reason: "covers 40,000" }, { criterionId: "o-cover", outcome: "fail", reason: "covers 40,000" }],
      judgement: null, documents: [], statementReadable: false, score: null, suspiciousDocumentIds: [], judgementFailed: false,
    });
    assert.equal(content.internalCall, "would_refuse");
    assert.deepEqual(content.refusalGrounds.map((g) => [g.criterionId, g.layerKey]), [["o-cover", OWN_KEY]]);
  });

  test("a stale link is NOT honoured: the shared rule's quote changed in a later shared version", async () => {
    const own = await checkedOwnLayer();
    const newer = sharedLayer(4, { criteria: [rule("s-stay", "A visitor may stay for no more than 60 days in any 180-day period.", "src-s"), rule("s-cover", Q.sharedCover, "src-s")] });
    const merged = mergeRulebookStack([{ layer: STACK[0], rubric: newer }, { layer: STACK[1], rubric: own }]) as VisaRubric;
    assert.ok(merged.criteria.some((c) => c.criterionId === "o-stay"), "both appear: never folded into a different rule");
    assert.equal(merged.criteria.some((c) => c.restatedBy), false);
    assert.ok(merged.intakeQuestions.some((q) => q.id === "q1"));
  });

  test("a link whose twin is no longer the same kind of rule is not honoured (the guards run again at merge time)", async () => {
    const own = await checkedOwnLayer();
    const changed = sharedLayer(4, { criteria: [rule("s-stay", Q.sharedStay, "src-s", { kind: "objective", check: { field: "trip.days", op: "lte", value: 90 } } as any), rule("s-cover", Q.sharedCover, "src-s")] });
    const merged = mergeRulebookStack([{ layer: STACK[0], rubric: changed }, { layer: STACK[1], rubric: own }]) as VisaRubric;
    assert.ok(merged.criteria.some((c) => c.criterionId === "o-stay"));
  });

  test("a question the repeat shares with another national rule stays (pointed at the twin), and the stack plan accepts the view", async () => {
    const own = await checkedOwnLayer(new FakeLayerModel(), ownLayer(2, { intakeQuestions: [question("q1", ["o-stay", "o-local"])] }));
    const stack = stackFromReads([{ layer: STACK[0], rubric: sharedLayer() }, { layer: STACK[1], rubric: own }]);
    assert.equal(stack.usable, true, JSON.stringify(stack.problems));
    const q1 = stack.rubric?.intakeQuestions.find((q) => q.id === "q1");
    assert.deepEqual(q1?.criterionIds, [sStay, "o-local"]);
  });

  test("a single-layer route is the rulebook itself, links or not", async () => {
    const own = await checkedOwnLayer();
    assert.equal(mergeRulebookStack([{ layer: STACK[1], rubric: own }]), own);
  });
});

// ============================================
// 4. Intake and assessment through the merged view
// ============================================

describe("restates honoured in intake and assessment", () => {
  test("intake: the repeat's question is not asked; the shared one is asked once", async () => {
    const own = await checkedOwnLayer();
    const original = intakeRulebookReader.read;
    intakeRulebookReader.read = async () => stackFromReads([{ layer: STACK[0], rubric: sharedLayer() }, { layer: STACK[1], rubric: own }]);
    try {
      const app = { id: "app-1", userId: "u-1", countryCode: OWN.countryCode, visaTypeId: OWN.visaTypeId, routeStack: [SHARED_KEY, OWN_KEY], status: "draft" } as any;
      const view = await new IntakeService().getIntake(app);
      assert.equal(view.available, true);
      assert.deepEqual(view.openRequiredIds, [scopedId(SHARED_KEY, "q1"), "q2"]);
    } finally {
      intakeRulebookReader.read = original;
    }
  });

  test("assessment: the rule is assessed once (under the shared rule) and nothing else is dropped", async () => {
    const own = await checkedOwnLayer();
    const merged = mergeRulebookStack([{ layer: STACK[0], rubric: sharedLayer() }, { layer: STACK[1], rubric: own }]) as VisaRubric;
    const split = splitByApplicability(merged, {});
    assert.equal(split.applicable.filter((c) => c.criterionId === scopedId(SHARED_KEY, "s-stay") || c.criterionId === "o-stay").length, 1);
    assert.equal(split.applicable.length, 6);
    assert.equal(effectiveIntakeQuestions(merged).length, 2);
  });
});
