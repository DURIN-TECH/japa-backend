// ============================================
// The check stops leaving rules out over labels that change no outcome (issue #240)
// ============================================
//
// No network, no model, no Firestore: the scripted provider answers the check's requests.
// Proved here:
//   - the verdict mapping, one row per (kind, ordinary / protected, stage answer, kind answer), and that
//     `failedAspect`, `failedAspectsOf`, `applicableAspects`, `judgeRule` and `leaveOutBasis` agree on every row;
//   - the edge cases (no verdict row, quote not found, kind `unsure` next to another failing aspect);
//   - the run record: leave-outs carry "found wrong" / "not confirmed", the budget gate says how many of each,
//     both still count, nothing about the limits or what is served changed, and the alert says it;
//   - the offline replay of the real first run (a synthetic fixture of ids and verdict letters) gives exactly
//     135 counted (general 11 of 113, scoped 124 of 340, primary 30 of 102), 57 found wrong, 72 not confirmed;
//   - the protected re-draft: applicability swap accepted, the original trigger carried, to / from
//     `all_applicants` refused, a stale repair attempt tried once more, a stored replacement never re-drafted;
//   - stored answers replay with ZERO model calls, and the checker prompt and its version did not move.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { CHECKER_ASPECTS, CHECKER_POLARITY_SYSTEM_PROMPT, CHECKER_PROMPT_VERSION, CHECKER_SYSTEM_PROMPT, buildVerdictSchema, encodeRow, type VerdictRow } from "../../../src/scrapers/rubric/rubric-checker-prompt";
import { RubricCheckerService, applicableAspects, failedAspect, failedAspectsOf, judgeRule, leaveOutBasis } from "../../../src/scrapers/rubric/rubric-checker";
import { DEFAULT_PUBLISH_SETTINGS } from "../../../src/scrapers/rubric/rubric-publish-settings";
import { evaluateGates, isProtectedRule, type GateInput } from "../../../src/scrapers/rubric/rubric-gates";
import { RUBRIC_REPAIR_PROMPT_VERSION, buildRepairRequest } from "../../../src/scrapers/rubric/rubric-prompt";
import { replayVerdicts, type ReplayRule } from "../../../src/scrapers/rubric/rubric-verdict-replay";
import { evaluateRubricAutoPublished, evaluateRubricDraftHeld, type RubricPublishAlertFacts } from "../../../src/scrapers/shared/alerts/scrape-alert-rules";
import type { AssessmentCriterion, IntakeQuestion } from "../../../src/types/rubric";
import { answer, crit, criteriaWire } from "./rubric-harness";
import { MemoryLedger, ScriptedProvider, isRepairRequest, pageOf, ruleOf, rubricOf, settingsWith, SRC_HASH, SRC_ID } from "./checker-fakes";

/* eslint-disable @typescript-eslint/no-explicit-any */

const row = (over: Partial<VerdictRow> = {}): VerdictRow => ({ title_faithful: "yes", kind_right: "yes", stage_right: "yes", condition_faithful: "yes", check_faithful: "na", group_matches_codes: "na", ...over });
const ANSWERS = ["yes", "no", "unsure", "na"] as const;
const CHECK = { field: "x.y", op: "gte", value: 3, unit: "days" } as any;
const GROUP = { nationalities: ["QM", "QN"], asWritten: ["Group One", "Group Two"] };

/** A rule of each kind, ordinary or protected (a named group; a bar is always protected). */
function shape(kind: AssessmentCriterion["kind"], isProtected: boolean): AssessmentCriterion {
  return ruleOf(1, {
    kind,
    ...(kind === "objective" ? { probeFactors: undefined, check: CHECK } : {}),
    ...(kind === "mandatory_bar" || isProtected ? { appliesTo: GROUP } : {}),
  });
}

/** Everything else yes for the rule's other applicable aspects (so only stage and kind decide). */
const otherYes = (r: AssessmentCriterion): Partial<VerdictRow> => ({ ...(r.check ? { check_faithful: "yes" as const } : {}), ...(r.appliesTo ? { group_matches_codes: "yes" as const } : {}) });

// ============================================
// The table
// ============================================

describe("(#240) verdict mapping: stage of a judgement rule, kind `unsure` of an ordinary judgement rule", () => {
  /**
   * The ISSUE's rule, written out plainly (not the production code): which aspects fail for these rows.
   *  - stage: judged only for an objective rule (not for a judgement rule or a bar): `yes` passes, anything else fails;
   *  - kind: `yes` passes; `unsure` passes ONLY for an ordinary (not protected) judgement rule; `no` and `na` fail.
   */
  const expectedFailures = (kind: AssessmentCriterion["kind"], isProtected: boolean, stage: string, kindAnswer: string): string[] => {
    const failed: string[] = [];
    if (kindAnswer !== "yes" && !(kindAnswer === "unsure" && kind === "judgement" && !isProtected && kind !== ("mandatory_bar" as string))) failed.push("kind_right");
    if (kind === "objective" && stage !== "yes") failed.push("stage_right");
    return failed;
  };

  for (const kind of ["objective", "judgement", "mandatory_bar"] as const) {
    for (const isProtected of [false, true]) {
      // A bar is protected by its kind: there is no ordinary bar.
      if (kind === "mandatory_bar" && !isProtected) continue;
      for (const stage of ANSWERS) {
        for (const kindAnswer of ANSWERS) {
          test(`${kind}, ${isProtected ? "protected" : "ordinary"}, stage=${stage}, kind=${kindAnswer}`, () => {
            const r = shape(kind, isProtected);
            assert.equal(isProtectedRule(r), isProtected);
            const v = row({ ...otherYes(r), stage_right: stage, kind_right: kindAnswer });
            const failed = expectedFailures(kind, isProtected, stage, kindAnswer);
            // Every function of the mapping tells the same story.
            assert.deepEqual(failedAspectsOf(r, v), failed, "failedAspectsOf");
            assert.equal(failedAspect(r, v), failed[0] ?? null, "failedAspect");
            const stageApplies = applicableAspects(r).has("stage_right");
            assert.equal(stageApplies, kind === "objective", "stage_right applies to an objective rule only");
            const action = judgeRule(r, { verification: v, judgement: v });
            if (failed.length === 0) assert.deepEqual(action, { action: "keep" }, "judgeRule keeps");
            else assert.deepEqual(action, { action: isProtected ? "hold" : "leave_out", aspect: failed[0] }, "judgeRule");
            // The basis: found wrong only when a FAILING verdict is a `no`.
            if (!isProtected && failed.length > 0) {
              const wrong = (failed.includes("kind_right") && kindAnswer === "no") || (failed.includes("stage_right") && stage === "no");
              assert.equal(leaveOutBasis(r, v), wrong ? "found_wrong" : "not_confirmed");
            }
          });
        }
      }
    }
  }

  test("a protected rule: EITHER model's failing verdict still holds (kind `unsure` on a judgement rule scoped to a group, one model only)", () => {
    const r = shape("judgement", true);
    assert.deepEqual(judgeRule(r, { verification: row(otherYes(r)), judgement: row({ ...otherYes(r), kind_right: "unsure" }) }), { action: "hold", aspect: "kind_right" });
    assert.deepEqual(judgeRule(r, { verification: row({ ...otherYes(r), kind_right: "unsure" }), judgement: row(otherYes(r)) }), { action: "hold", aspect: "kind_right" });
    // Its stage is not judged, from either model.
    assert.deepEqual(judgeRule(r, { verification: row({ ...otherYes(r), stage_right: "no" }), judgement: row({ ...otherYes(r), stage_right: "unsure" }) }), { action: "keep" });
  });

  test("every OTHER aspect is judged exactly as before on a judgement rule: `unsure` and `no` fail, `na` on an applicable one fails", () => {
    const r = shape("judgement", false);
    for (const aspect of ["title_faithful", "condition_faithful"] as const) {
      for (const bad of ["no", "unsure", "na"] as const) assert.deepEqual(failedAspectsOf(r, row({ [aspect]: bad })), [aspect], `${aspect}=${bad}`);
    }
    // `na` on kind is still "not verified" for an ordinary judgement rule: only `unsure` is tolerated.
    assert.deepEqual(failedAspectsOf(r, row({ kind_right: "na" })), ["kind_right"]);
    assert.deepEqual(failedAspectsOf(r, row({ kind_right: "no" })), ["kind_right"]);
  });

  test("a judgement rule with kind `unsure` AND another failing aspect is still left out, under that other aspect", () => {
    const r = shape("judgement", false);
    const v = row({ kind_right: "unsure", condition_faithful: "unsure" });
    assert.deepEqual(judgeRule(r, { verification: v }), { action: "leave_out", aspect: "condition_faithful" });
    assert.deepEqual(failedAspectsOf(r, v), ["condition_faithful"]);
    // Not confirmed: the tolerated `unsure` is not a failing verdict, and the failing one is `unsure` too.
    assert.equal(leaveOutBasis(r, v), "not_confirmed");
    // A `no` on the other aspect makes it found wrong; an ignored stage `no` does not.
    assert.equal(leaveOutBasis(r, row({ condition_faithful: "no" })), "found_wrong");
    assert.equal(leaveOutBasis(r, row({ stage_right: "no", condition_faithful: "unsure" })), "not_confirmed", "a stage `no` on a judgement rule is not a failing verdict");
  });

  test("a rule with no verdict row still fails (and was never confirmed)", () => {
    for (const kind of ["judgement", "objective"] as const) {
      const r = shape(kind, false);
      assert.equal(judgeRule(r, {}).action, "leave_out");
      assert.equal(leaveOutBasis(r, undefined), "not_confirmed");
    }
    assert.equal(judgeRule(shape("mandatory_bar", true), {}).action, "hold");
  });

  test("a judgement rule whose quote is not in its snapshot is left out as checker:source_text, not confirmed, with no model call for it", async () => {
    const provider = new ScriptedProvider();
    const svc = new RubricCheckerService({ provider: () => provider, readSnapshot: async () => pageOf(6), loadSettings: settingsWith(), ledger: new MemoryLedger(), nowMs: () => Date.parse("2026-11-13T10:00:00Z"), sleep: async () => undefined });
    const lost = ruleOf(7, { source: { ...ruleOf(7).source, quote: "A sentence that is nowhere in the page at all." } });
    const rubric = rubricOf([...Array.from({ length: 6 }, (_, k) => ruleOf(k + 1)), lost], null);
    const out = await svc.check({ routeKey: rubric.routeKey, version: 1, runId: `${rubric.routeKey}__v1`, rubric, codeLeftOutIds: [] });
    assert.equal(out.ok, true);
    if (out.ok) assert.deepEqual(out.leftOut, [{ criterionId: "crit-0007", reason: "checker:source_text", basis: "not_confirmed" }]);
  });

  test("a run with zero rules, and a run where every rule passes, behave as before", async () => {
    const provider = new ScriptedProvider();
    const mk = () => new RubricCheckerService({ provider: () => provider, readSnapshot: async () => pageOf(5), loadSettings: settingsWith(), ledger: new MemoryLedger(), nowMs: () => Date.parse("2026-11-13T10:00:00Z"), sleep: async () => undefined });
    const empty = await mk().check({ routeKey: "XA_xa-test", version: 1, runId: "XA_xa-test__v1", rubric: rubricOf([], null), codeLeftOutIds: [] });
    assert.deepEqual(empty, { ok: true, leftOut: [], resolvedFlagCodes: [], intentPolarity: null });
    const rubric = rubricOf(Array.from({ length: 5 }, (_, k) => ruleOf(k + 1)), null);
    const all = await mk().check({ routeKey: rubric.routeKey, version: 1, runId: `${rubric.routeKey}__v1`, rubric, codeLeftOutIds: [] });
    assert.equal(all.ok, true);
    if (all.ok) assert.deepEqual(all.leftOut, []);
  });
});

// ============================================
// Through the whole check: judgement rules pass on the unsure labels, objective rules do not
// ============================================

describe("(#240) through the check", () => {
  const settings = settingsWith();
  const rig = () => {
    const provider = new ScriptedProvider();
    const ledger = new MemoryLedger();
    const svc = new RubricCheckerService({ provider: () => provider, readSnapshot: async () => pageOf(40), loadSettings: settings, ledger, nowMs: () => Date.parse("2026-11-13T10:00:00Z"), sleep: async () => undefined });
    return { provider, ledger, svc };
  };
  const input = (rubric: ReturnType<typeof rubricOf>) => ({ routeKey: rubric.routeKey, version: 1, runId: `${rubric.routeKey}__v1`, rubric, codeLeftOutIds: [] as string[] });
  const objectiveOf = (i: number) => ruleOf(i, { kind: "objective", probeFactors: undefined, check: CHECK });
  /** Judgement rules 1-8, objective rules 9-10. */
  const rulebook = () => [...Array.from({ length: 8 }, (_, k) => ruleOf(k + 1)), objectiveOf(9), objectiveOf(10)];

  test("stage `unsure` / `no` / `na` and kind `unsure` on judgement rules keep them; the same on objective rules leave them out", async () => {
    const r = rig();
    r.provider.policy = ({ rule }) => {
      if (rule.title === "Matter 1") return { stage_right: "unsure" };
      if (rule.title === "Matter 2") return { stage_right: "no" };
      if (rule.title === "Matter 3") return { stage_right: "na" };
      if (rule.title === "Matter 4") return { kind_right: "unsure" };
      if (rule.title === "Matter 5") return { kind_right: "no" };
      if (rule.title === "Matter 9") return { stage_right: "unsure" };
      if (rule.title === "Matter 10") return { kind_right: "unsure" };
      return undefined;
    };
    const out = await r.svc.check(input(rubricOf(rulebook(), null)));
    assert.equal(out.ok, true);
    if (!out.ok) return;
    assert.deepEqual(out.leftOut, [
      { criterionId: "crit-0005", reason: "checker:kind_right", basis: "found_wrong" },
      { criterionId: "crit-0009", reason: "checker:stage_right", basis: "not_confirmed" },
      { criterionId: "crit-0010", reason: "checker:kind_right", basis: "not_confirmed" },
    ]);
  });

  test("stored answers are reused: a replay makes ZERO model calls and decides the same (the mapping reads data, not the model)", async () => {
    const r = rig();
    r.provider.policy = ({ rule }) => (rule.title === "Matter 1" ? { stage_right: "unsure", kind_right: "unsure" } : rule.title === "Matter 9" ? { stage_right: "unsure" } : undefined);
    const rubric = rubricOf(rulebook(), null);
    const first = await r.svc.check(input(rubric));
    const spent = r.provider.requests.length;
    assert.ok(spent > 0);
    const second = await r.svc.check(input(rubric));
    assert.equal(r.provider.requests.length, spent, "no extra model call on the replay");
    assert.deepEqual(second, first);
    // And a mapping-only change replays too: the stored record is for the unchanged checker prompt version.
    assert.equal([...r.ledger.docs.values()][0].promptVersion, CHECKER_PROMPT_VERSION);
  });

  test("the checker prompt and schema are pinned: #240 itself did not touch them (#242 later bumped them: see rubric-check-context.test.ts)", () => {
    // (#242) The checker prompt moved to v6 on purpose (headings and the trigger are shown). #240's mapping tests below do not depend on it;
    // what #240 proved (a mapping-only change replays) stays true for any version, so only the pin moved.
    assert.equal(CHECKER_PROMPT_VERSION, "2026-11-checker-v6");
    const hash = createHash("sha256").update(`${CHECKER_SYSTEM_PROMPT}\n${JSON.stringify(buildVerdictSchema())}\n${CHECKER_POLARITY_SYSTEM_PROMPT}`).digest("hex");
    assert.equal(hash, "6c9410ad8e9df18e7cab534cde25cc74e40a92e2527ccac25c79dd409901d49e", "the hash pinned at the v6 bump (#242)");
  });

  test("a protected rule is still held by the stage of an objective rule and by kind `unsure` from one model", async () => {
    const r = rig();
    r.provider.policy = ({ role, rule }) => (rule.kind === "judgement" && rule.appliesTo && role === "judgement" ? { kind_right: "unsure" } : undefined);
    const scoped = ruleOf(20, { kind: "judgement", appliesTo: GROUP });
    const out = await r.svc.check(input(rubricOf([...rulebook(), scoped], null)));
    assert.equal(out.ok, false, "the protected rule's kind `unsure` still holds the draft");
    if (!out.ok) assert.deepEqual(out.protectedFailures?.[0].failedAspects, ["kind_right"]);
  });
});

// ============================================
// The run record, the budget gate and the alert
// ============================================

describe("(#240) run record, budget gate detail and alert wording", () => {
  const rules = (n: number): AssessmentCriterion[] => Array.from({ length: n }, (_, k) => ruleOf(k + 1));
  const gateInput = (criteria: AssessmentCriterion[], leftOut: { criterionId: string; reason: string; basis?: "found_wrong" | "not_confirmed" }[], settings: Partial<GateInput["settings"]> = {}): GateInput => ({
    criteria,
    flags: [],
    suspiciousPassageCount: 0,
    structuralErrorCodes: [],
    primarySourceIds: new Set([SRC_ID]),
    allSourceIds: [SRC_ID],
    servingKeptCount: null,
    settings: { ...DEFAULT_PUBLISH_SETTINGS, ...settings },
    checker: { leftOut, resolvedFlagCodes: [] },
  });

  test("counts split the check's leave-outs; code leave-outs keep their own reasons and are in neither", () => {
    const criteria = rules(40);
    const report = evaluateGates(gateInput(criteria, [
      { criterionId: "crit-0001", reason: "checker:title_faithful", basis: "found_wrong" },
      { criterionId: "crit-0002", reason: "checker:condition_faithful", basis: "not_confirmed" },
      { criterionId: "crit-0003", reason: "checker:kind_right", basis: "not_confirmed" },
    ]));
    assert.equal(report.counts.leftOut, 3);
    assert.equal(report.counts.leftOutFoundWrong, 1);
    assert.equal(report.counts.leftOutNotConfirmed, 2);
    assert.deepEqual(report.counts.leftOutByReason, { "checker:title_faithful": 1, "checker:condition_faithful": 1, "checker:kind_right": 1 });
    assert.deepEqual(report.leftOut.map((l) => l.basis), ["found_wrong", "not_confirmed", "not_confirmed"]);
  });

  test("the leave_out_budget detail says 'N found wrong, M not confirmed'; both count against the budget and neither is served", () => {
    const criteria = rules(40);
    // 6 of 40 = 15.0 % is AT the limit (held only above it); 7 of 40 is over.
    const at = (n: number) => evaluateGates(gateInput(criteria, Array.from({ length: n }, (_, k) => ({ criterionId: `crit-${String(k + 1).padStart(4, "0")}`, reason: k % 2 === 0 ? "checker:title_faithful" : "checker:condition_faithful", basis: (k % 2 === 0 ? "found_wrong" : "not_confirmed") as "found_wrong" | "not_confirmed" }))));
    const six = at(6);
    const budget = six.gates.find((g) => g.gate === "leave_out_budget");
    assert.equal(budget?.passed, true);
    assert.match(budget?.detail ?? "", /6 of 40 left out for correctness/);
    assert.match(budget?.detail ?? "", /3 found wrong, 3 not confirmed/);
    const seven = at(7);
    assert.equal(seven.gates.find((g) => g.gate === "leave_out_budget")?.passed, false, "not-confirmed rules count: 7 of 40 is over 15 %");
    assert.ok(seven.reasonCodes.includes("leave_out_budget_exceeded"));
    // None of the 7 is served.
    assert.equal(seven.keptCriterionIds.length, 33);
    assert.equal(seven.excludedCriterionIds.length, 7);
    // The limits are the ones that were there.
    assert.equal(DEFAULT_PUBLISH_SETTINGS.maxLeftOutShare, 0.15);
    assert.equal(DEFAULT_PUBLISH_SETTINGS.maxPrimaryLeftOutShare, 0.2);
  });

  test("a leave-out with no recorded basis (an older caller) is counted against the budget and in neither split", () => {
    const report = evaluateGates(gateInput(rules(40), [{ criterionId: "crit-0001", reason: "checker:title_faithful" }]));
    assert.equal(report.counts.leftOut, 1);
    assert.equal(report.counts.leftOutFoundWrong, 0);
    assert.equal(report.counts.leftOutNotConfirmed, 0);
    assert.doesNotMatch(report.gates.find((g) => g.gate === "leave_out_budget")?.detail ?? "", /found wrong/);
  });

  const facts = (over: Partial<RubricPublishAlertFacts> = {}): RubricPublishAlertFacts => ({
    routeKey: "XA_xa-test",
    version: 2,
    previousVersion: null,
    link: "https://app.example/admin",
    rules: 453,
    kept: 324,
    leftOutByReason: { "checker:title_faithful": 57, "checker:condition_faithful": 72 },
    held: 0,
    primaryLeftOut: [],
    informationalFlags: {},
    sample: [],
    reasons: ["too many rules would have to be left out"],
    protectedHold: false,
    settingsUnreadable: false,
    attempt: 1,
    ...over,
  });
  const config = { rules: {} } as any;

  test("the alerts say how many of the check's leave-outs were found wrong and how many could not be confirmed", () => {
    const held = evaluateRubricDraftHeld(facts({ leftOutFoundWrong: 57, leftOutNotConfirmed: 72 }), config).signals[0].message;
    assert.match(held, /Of the independent check's leave-outs, 57 were found wrong and 72 could not be confirmed\./);
    const published = evaluateRubricAutoPublished(facts({ leftOutFoundWrong: 57, leftOutNotConfirmed: 72 }), config).signals[0].message;
    assert.match(published, /57 were found wrong and 72 could not be confirmed/);
    // Nothing recorded (a record from before #240, or no check leave-outs): the wording is unchanged.
    assert.doesNotMatch(evaluateRubricDraftHeld(facts(), config).signals[0].message, /found wrong/);
  });
});

// ============================================
// The offline replay of the first real run
// ============================================

describe("(#240) replay of the stored verdicts of the first automatic run (a synthetic fixture: ids, kinds, letters only)", () => {
  const rules = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "replay-verdicts-synthetic.json"), "utf8")) as ReplayRule[];
  // `source-b` is the fixture's one primary source (102 rules).
  const result = replayVerdicts(rules, new Set(["source-b"]));

  test("135 rules count against the budget: general 11 of 113, scoped 124 of 340, primary 30 of 102", () => {
    assert.equal(result.rules, 453);
    assert.equal(result.counted, 135);
    assert.deepEqual(result.general, { counted: 11, of: 113 });
    assert.deepEqual(result.scoped, { counted: 124, of: 340 });
    assert.deepEqual(result.primary, { counted: 30, of: 102 });
  });

  test("57 of the check's leave-outs are found wrong and 72 not confirmed, plus the code leave-outs (6 counted, 3 duplicates not)", () => {
    assert.equal(result.foundWrong, 57);
    assert.equal(result.notConfirmed, 72);
    assert.deepEqual(result.codeLeftOut, { list_not_readable: 5, combined_sub_conditions: 1, possible_duplicate: 3 });
    assert.equal(result.foundWrong + result.notConfirmed + 6, result.counted);
  });

  test("the budget still holds this rulebook (the limits did not move), and the protected rules that failed still hold it", () => {
    assert.ok(result.counted / result.rules > DEFAULT_PUBLISH_SETTINGS.maxLeftOutShare);
    assert.ok(result.scoped.counted / result.scoped.of > DEFAULT_PUBLISH_SETTINGS.maxLeftOutShare);
    assert.equal(result.heldProtected.length, 2, "the two bars the real run reported as not confirmed");
    // Rules the stored run left out for the check that are kept now: 219 - 135 = 84.
    assert.equal(result.nowKept, 84);
  });
});

// ============================================
// The protected re-draft
// ============================================

const BAR_QUOTE = "An application must be refused where the applicant is a national of Borduria or Syldavia.";
const barLine = `B1.1 ${BAR_QUOTE}`;
const ACTIVITY: IntakeQuestion = { id: "activity", label: "What is the main activity of your trip?", answerType: "multi_choice", options: [{ value: "alpha", label: "Activity alpha" }, { value: "beta", label: "Activity beta" }], required: true, criterionIds: [] } as unknown as IntakeQuestion;

/** The stored bar: `conditional` with a trigger on the activity question. */
const barWithTrigger = (over: Partial<AssessmentCriterion> = {}): AssessmentCriterion =>
  ruleOf(101, {
    title: "Original bar 1",
    kind: "mandatory_bar",
    stage: "validity",
    severity: "critical",
    source: { quote: BAR_QUOTE, sourceId: SRC_ID, url: "https://rules.example/page", contentHash: SRC_HASH, retrievedAt: "2026-11-13T00:00:00Z" },
    appliesTo: { nationalities: ["QM", "QN"], asWritten: ["Borduria", "Syldavia"] },
    applicability: "conditional",
    applicabilityCondition: "An application must be refused",
    trigger: { questionId: "activity", anyOf: ["alpha"] },
    ...over,
  });

const redraft = (applicability: string, over: Record<string, unknown> = {}) =>
  criteriaWire(answer({
    criteria: [
      crit({
        ref: "r1",
        title: "Repaired bar A",
        kind: "mandatory_bar",
        stage: "suitability",
        severity: "critical",
        quote: BAR_QUOTE,
        appliesTo: { nationalities: ["QM", "QN"], asWritten: ["Borduria", "Syldavia"] },
        applicability: applicability as any,
        applicabilityCondition: applicability === "all_applicants" ? null : "An application must be refused",
        ...over,
      }),
    ],
  }));

const unsureGroup = ({ role, rule }: { role: string; rule: any }) => (rule.appliesTo && role === "judgement" && rule.title === "Original bar 1" ? { condition_faithful: "unsure" as const } : undefined);
const draft = (rule: AssessmentCriterion) => ({ ...rubricOf([...Array.from({ length: 12 }, (_, k) => ruleOf(k + 1)), rule], null), intakeQuestions: [ACTIVITY] }) as any;
const input = (rubric: any) => ({ routeKey: rubric.routeKey, version: 1, runId: `${rubric.routeKey}__v1`, rubric, codeLeftOutIds: [] as string[] });
function repairRig(ledger = new MemoryLedger(), provider = new ScriptedProvider()) {
  const svc = new RubricCheckerService({ provider: () => provider, readSnapshot: async () => pageOf(12, [barLine]), loadSettings: settingsWith(), ledger, nowMs: () => Date.parse("2026-11-13T10:00:00Z"), sleep: async () => undefined });
  return { svc, provider, ledger };
}
const repairRequestsOf = (p: ScriptedProvider) => p.requests.filter(isRepairRequest).length;

describe("(#240) the protected re-draft keeps applicability and accepts a harmless swap", () => {
  test("the repair prompt says to keep the applicability unless condition_faithful failed, and its version moved", () => {
    assert.equal(RUBRIC_REPAIR_PROMPT_VERSION, "2026-11-repair-v4");
    const chunk = { sourceId: SRC_ID, contentHash: SRC_HASH, docType: "html", chunkIndex: 0, chunkCount: 1, text: BAR_QUOTE } as any;
    const req = buildRepairRequest(chunk, { rule: { title: "T", kind: "mandatory_bar", stage: "validity", quote: BAR_QUOTE }, aspects: ["group_matches_codes"] }, ["high"], { maxOutputTokens: 1000, timeoutMs: 1000 });
    assert.match(req.user, /Keep the rule's applicability/);
    assert.match(req.user, /unless condition_faithful is one of the aspects the reader did not confirm/);
    assert.match(req.user, /Keep the rule's kind/, "the kind sentence is still there");
  });

  test("a re-draft that swaps conditional for specialist on a rule with a trigger is ACCEPTED, with the ORIGINAL trigger carried over, and the replacement's trigger is checked by both models", async () => {
    const r = repairRig();
    r.provider.policy = unsureGroup;
    r.provider.redraftPolicy = () => redraft("specialist");
    const original = barWithTrigger();
    const out = await r.svc.check(input(draft(original)));
    assert.equal(out.ok, true);
    if (!out.ok) return;
    assert.equal(out.protectedFailures?.[0].repair.status, "repaired");
    const rep = out.repairs?.[0];
    assert.equal(rep?.replacement.applicability, "specialist");
    assert.deepEqual(rep?.replacement.trigger, original.trigger, "the original's trigger, not whatever the model wrote");
    assert.equal(rep?.replacement.criterionId, original.criterionId);
    // The trigger request is the same text for the original and the replacement (same quote, condition and
    // trigger), so each model's answer is asked once and reused; both models did judge it.
    const triggerRoles = new Set(r.provider.requests.filter((q) => q.user.includes("<triggers_data_")).map((q) => q.role));
    assert.deepEqual([...triggerRoles].sort(), ["judgement", "verification"]);
  });

  test("the replacement's trigger is still judged by both models: one model's `no` on it fails the replacement (trigger_not_confirmed)", async () => {
    const r = repairRig();
    // The original fails on its condition (so a re-draft happens); then the judgement model refuses the trigger.
    r.provider.policy = unsureGroup;
    r.provider.triggerPolicy = ({ role }) => (role === "judgement" ? "no" : "yes");
    r.provider.redraftPolicy = () => redraft("specialist");
    const out = await r.svc.check(input(draft(barWithTrigger())));
    assert.equal(out.ok, false);
    if (!out.ok) {
      assert.equal(out.protectedFailures?.[0].repair.status, "failed_check");
      assert.equal(out.protectedFailures?.[0].repair.detail, "trigger_not_confirmed");
    }
  });

  test("the same swap the other way (specialist to conditional) is accepted too", async () => {
    const r = repairRig();
    r.provider.policy = unsureGroup;
    r.provider.redraftPolicy = () => redraft("conditional");
    const out = await r.svc.check(input(draft(barWithTrigger({ applicability: "specialist" }))));
    assert.equal(out.ok, true);
    if (out.ok) assert.equal(out.repairs?.[0].replacement.applicability, "conditional");
  });

  test("a change to or from all_applicants (or to other_route) on a rule with a trigger is still refused: applicability_changed", async () => {
    for (const [from, to] of [["conditional", "all_applicants"], ["conditional", "other_route"], ["specialist", "all_applicants"]] as const) {
      const r = repairRig();
      r.provider.policy = unsureGroup;
      r.provider.redraftPolicy = () => redraft(to);
      const out = await r.svc.check(input(draft(barWithTrigger({ applicability: from }))));
      assert.equal(out.ok, false, `${from} -> ${to}`);
      if (!out.ok) {
        assert.equal(out.protectedFailures?.[0].repair.status, "invalid_redraft");
        assert.equal(out.protectedFailures?.[0].repair.detail, "applicability_changed", `${from} -> ${to}`);
      }
    }
    // Nothing to protect without a trigger: unchanged behaviour (a rule with no trigger may change applicability).
    const r = repairRig();
    r.provider.policy = unsureGroup;
    r.provider.redraftPolicy = () => redraft("all_applicants");
    const noTrigger = barWithTrigger();
    delete (noTrigger as any).trigger;
    const out = await r.svc.check(input(draft(noTrigger)));
    assert.equal(out.ok, true);
  });

  test("a stored attempt from an OLDER repair prompt version is attempted once more; the current version is reused; never twice under one version", async () => {
    const ledger = new MemoryLedger();
    const provider = new ScriptedProvider();
    provider.policy = unsureGroup;
    // Attempt 1 (as under the old guard): refused, stored as invalid.
    provider.redraftPolicy = () => redraft("all_applicants");
    const rubric = draft(barWithTrigger());
    const first = await repairRig(ledger, provider).svc.check(input(rubric));
    assert.equal(first.ok, false);
    assert.equal(repairRequestsOf(provider), 1);
    // Same version again: reused, nothing asked.
    const spent = provider.requests.length;
    await repairRig(ledger, provider).svc.check(input(rubric));
    assert.equal(provider.requests.length, spent, "the current version's attempt is reused");
    // Pretend that attempt was made under the previous repair prompt.
    const doc = ledger.docs.get("XA_xa-test__v1") as any;
    assert.equal(doc.repairs["crit-0101"].promptVersion, RUBRIC_REPAIR_PROMPT_VERSION);
    doc.repairs["crit-0101"].promptVersion = "2026-11-repair-v2";
    provider.redraftPolicy = () => redraft("specialist");
    const third = await repairRig(ledger, provider).svc.check(input(rubric));
    assert.equal(repairRequestsOf(provider), 2, "exactly one more re-draft");
    assert.equal(third.ok, true);
    if (third.ok) assert.equal(third.protectedFailures?.[0].repair.status, "repaired");
    assert.equal((ledger.docs.get("XA_xa-test__v1") as any).repairs["crit-0101"].promptVersion, RUBRIC_REPAIR_PROMPT_VERSION, "stored under the current version");
    // And now it is never re-drafted again.
    const after = provider.requests.length;
    await repairRig(ledger, provider).svc.check(input(rubric));
    assert.equal(provider.requests.length, after);
    assert.equal(repairRequestsOf(provider), 2);
  });

  test("a bar already repaired and confirmed under the older version is NOT re-drafted, and its check is replayed with zero requests", async () => {
    const ledger = new MemoryLedger();
    const provider = new ScriptedProvider();
    provider.policy = unsureGroup;
    provider.redraftPolicy = () => redraft("specialist");
    const rubric = draft(barWithTrigger());
    const first = await repairRig(ledger, provider).svc.check(input(rubric));
    assert.equal(first.ok, true);
    (ledger.docs.get("XA_xa-test__v1") as any).repairs["crit-0101"].promptVersion = "2026-11-repair-v2";
    const spent = provider.requests.length;
    const second = await repairRig(ledger, provider).svc.check(input(rubric));
    assert.equal(provider.requests.length, spent, "no re-draft and no new check request");
    assert.equal(second.ok, true);
    if (second.ok) assert.equal(second.protectedFailures?.[0].repair.status, "repaired");
  });

  test("one old invalid attempt and one old confirmed replacement in the same run: one new re-draft, and the replay's check is not batched with the new one", async () => {
    const ledger = new MemoryLedger();
    const provider = new ScriptedProvider();
    const second = { ...barWithTrigger(), criterionId: "crit-0102", title: "Original bar 2", source: { ...barWithTrigger().source, quote: `${BAR_QUOTE} Variant 2.` } } as AssessmentCriterion;
    provider.policy = ({ role, rule }) => (rule.appliesTo && role === "judgement" && String(rule.title).startsWith("Original bar") ? { condition_faithful: "unsure" as const } : undefined);
    // Bar 1's re-draft is refused, bar 2's is fine.
    provider.redraftPolicy = ({ shown }: any) => (shown.quote === BAR_QUOTE ? redraft("all_applicants") : redraft("specialist", { quote: `${BAR_QUOTE} Variant 2.`, title: "Repaired bar B" }));
    const rubric = { ...rubricOf([...Array.from({ length: 12 }, (_, k) => ruleOf(k + 1)), barWithTrigger(), second], null), intakeQuestions: [ACTIVITY] } as any;
    const mk = () => new RubricCheckerService({ provider: () => provider, readSnapshot: async () => pageOf(12, [barLine, `B2.1 ${BAR_QUOTE} Variant 2.`]), loadSettings: settingsWith(), ledger, nowMs: () => Date.parse("2026-11-13T10:00:00Z"), sleep: async () => undefined });
    await mk().check(input(rubric));
    const doc = ledger.docs.get("XA_xa-test__v1") as any;
    assert.equal(doc.repairs["crit-0101"].kind, "invalid");
    assert.equal(doc.repairs["crit-0102"].kind, "replacement");
    for (const id of ["crit-0101", "crit-0102"]) doc.repairs[id].promptVersion = "2026-11-repair-v2";
    const before = provider.requests.length;
    provider.redraftPolicy = () => redraft("specialist");
    await mk().check(input(rubric));
    const added = provider.requests.slice(before);
    assert.equal(added.filter(isRepairRequest).length, 1, "only the refused one is re-drafted");
    // The confirmed replacement (bar 2) is replayed unchanged: none of the new requests re-checks it.
    assert.ok(added.every((q) => !q.user.includes("Repaired bar B")), "the replay's check is reused as stored");
  });
});

// ============================================
// Containment
// ============================================

describe("(#240) containment", () => {
  const src = path.join(__dirname, "..", "..", "..", "src");
  const read = (...p: string[]) => fs.readFileSync(path.join(src, ...p), "utf8");

  test("nothing at assessment time reads the check's mapping or the leave-out basis", () => {
    for (const f of [["services", "ai", "assessment-engine.ts"], ["utils", "rule-applicability.ts"]]) {
      if (!fs.existsSync(path.join(src, ...f))) continue;
      const text = read(...f);
      assert.doesNotMatch(text, /rubric-checker|leaveOutBasis|LeaveOutBasis|unjudgedAspects/, f.join("/"));
    }
  });

  test("the leave-out basis is named only by the checker, the gates, the replay, the pipeline, the alert and the types", () => {
    const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : e.name.endsWith(".ts") ? [path.join(dir, e.name)] : []));
    const users = walk(src)
      .filter((f) => /\bleaveOutBasis\b|\bLeaveOutBasis\b|\bleftOutFoundWrong\b/.test(fs.readFileSync(f, "utf8")))
      .map((f) => path.relative(src, f))
      .sort();
    assert.deepEqual(users, [
      path.join("scrapers", "rubric", "rubric-checker.ts"),
      path.join("scrapers", "rubric", "rubric-gates.ts"),
      path.join("scrapers", "rubric", "rubric-verdict-replay.ts"),
      path.join("scrapers", "rubric", "scripts", "publish-rubric.ts"),
      path.join("scrapers", "rubric", "scripts", "replay-check-verdicts.ts"),
      path.join("scrapers", "shared", "alerts", "scrape-alert-rules.ts"),
      path.join("services", "rubric-auto-publish.service.ts"),
      path.join("types", "rubric.ts"),
    ]);
  });

  test("the encoded letters a stored run holds decode back to the same row (the replay reads what the check stored)", () => {
    const v = row({ stage_right: "unsure", kind_right: "unsure" });
    assert.equal(encodeRow(v), "yuuyaa");
    assert.deepEqual(CHECKER_ASPECTS.length, 6);
  });
});
