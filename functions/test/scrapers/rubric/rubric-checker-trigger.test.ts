// ============================================
// The trigger check (INTEGRATION of #202 and #207)
// ============================================
//
// A kept specialist / conditional rule carries `trigger = { questionId, anyOf }`.
// The independent check asks a small separate question about that link:
//   ordinary rule, `yes`            -> trigger kept
//   ordinary rule, `no` / `unsure`  -> trigger DROPPED, the rule is KEPT (never left out)
//   protected rule, both `yes`      -> kept; anything else HOLDS the draft
// Invalid or missing answers hold (fail closed). The dropped ids are carried to
// the question plan and applied on the read side. No network, no model.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { RubricCheckerService, judgeTrigger } from "../../../src/scrapers/rubric/rubric-checker";
import { CHECKER_TRIGGER_BATCH_SIZE, CHECKER_TRIGGER_SYSTEM_PROMPT, buildTriggerRequest, parseTriggerVerdicts, CheckerAnswerError } from "../../../src/scrapers/rubric/rubric-checker-prompt";
import { findBannedWording } from "../../../src/services/ai/prompt-safety";
import { applyExclusions } from "../../../src/scrapers/rubric/rubric-exclusions";
import { validateVisaRubric } from "../../../src/scrapers/rubric/rubric-validate";
import { buildQuestionPlan } from "../../../src/scrapers/rubric/rubric-question-planner";
import type { IntakeQuestion } from "../../../src/types/rubric";
import { MemoryLedger, ScriptedProvider, barOf, pageOf, ruleOf, rubricOf, seenTriggers, settingsWith } from "./checker-fakes";

/* eslint-disable @typescript-eslint/no-explicit-any */

/** The one activity question every specialist rule below is tied to. */
const ACTIVITY: IntakeQuestion = {
  id: "activity",
  label: "What is the main activity of your trip?",
  answerType: "multi_choice",
  options: [
    { value: "alpha", label: "Activity alpha" },
    { value: "beta", label: "Activity beta" },
  ],
  required: true,
  criterionIds: [],
} as unknown as IntakeQuestion;

const specialist = (i: number, anyOf: string[], over: Record<string, unknown> = {}) =>
  ruleOf(i, { applicability: "specialist", applicabilityCondition: `Only for activity ${anyOf.join(" or ")}`, trigger: { questionId: "activity", anyOf }, ...over } as any);

function rig(over: { lines?: number } = {}) {
  const provider = new ScriptedProvider();
  const ledger = new MemoryLedger();
  const page = pageOf(over.lines ?? 40);
  const svc = new RubricCheckerService({ provider: () => provider, readSnapshot: async () => page, loadSettings: settingsWith(), ledger, nowMs: () => Date.parse("2026-11-13T10:00:00Z"), sleep: async () => undefined });
  return { svc, provider, ledger };
}
const draftOf = (criteria: any[]) => ({ ...rubricOf(criteria), intakeQuestions: [ACTIVITY] }) as any;
const input = (rubric: any) => ({ routeKey: rubric.routeKey, version: 1, runId: `${rubric.routeKey}__v1`, rubric, codeLeftOutIds: [] as string[] });

describe("the trigger table (pure)", () => {
  test("ordinary: yes keeps; no / unsure / missing drops the trigger", () => {
    const r = ruleOf(1);
    assert.equal(judgeTrigger(r, { verification: "yes" }), "keep");
    assert.equal(judgeTrigger(r, { verification: "no" }), "drop");
    assert.equal(judgeTrigger(r, { verification: "unsure" }), "drop");
    assert.equal(judgeTrigger(r, {}), "drop");
  });
  test("protected: both models must say yes, anything else holds", () => {
    const bar = barOf(2);
    assert.equal(judgeTrigger(bar, { verification: "yes", judgement: "yes" }), "keep");
    assert.equal(judgeTrigger(bar, { verification: "yes", judgement: "no" }), "hold");
    assert.equal(judgeTrigger(bar, { verification: "unsure", judgement: "yes" }), "hold");
    assert.equal(judgeTrigger(bar, { verification: "yes" }), "hold");
    assert.equal(judgeTrigger(ruleOf(3, { appliesTo: { nationalities: ["QM"], asWritten: ["Group One"] } }), { verification: "yes" }), "hold");
  });
});

describe("the trigger request and its answer", () => {
  test("the model sees the quote, condition and lead-in, and the answers split into selected and other, nothing else of the rule", () => {
    const req = buildTriggerRequest("verification", [{ rule: specialist(1, ["alpha"]), listLeadIn: "You must be:", question: { label: ACTIVITY.label, options: ACTIVITY.options as any } }], { maxOutputTokens: 2000, timeoutMs: 1000 });
    const [item] = seenTriggers(req);
    assert.deepEqual(Object.keys(item).sort(), ["condition", "id", "listLeadIn", "otherAnswers", "question", "quote", "selectedAnswers"]);
    assert.deepEqual(item.selectedAnswers, [{ value: "alpha", label: "Activity alpha" }]);
    assert.deepEqual(item.otherAnswers, [{ value: "beta", label: "Activity beta" }]);
    assert.equal(req.role, "verification");
    assert.ok(req.cacheSystem);
  });
  test("a yes/no question's two answers are spelled out", () => {
    const req = buildTriggerRequest("verification", [{ rule: specialist(1, ["true"], { trigger: { questionId: "flag", anyOf: ["true"] } }), listLeadIn: "", question: { label: "Is it so?", options: [] } }], { maxOutputTokens: 2000, timeoutMs: 1000 });
    const [item] = seenTriggers(req);
    assert.deepEqual(item.selectedAnswers, [{ value: "true", label: "Yes" }]);
    assert.deepEqual(item.otherAnswers, [{ value: "false", label: "No" }]);
  });
  test("strict parsing: a missing, repeated, unknown id, an extra key or a bad enum is invalid", () => {
    const ok = JSON.stringify({ verdicts: [{ id: "r1", trigger_faithful: "yes" }, { id: "r2", trigger_faithful: "no" }] });
    assert.equal(parseTriggerVerdicts(ok, ["r1", "r2"]).get("r2"), "no");
    for (const bad of [
      JSON.stringify({ verdicts: [{ id: "r1", trigger_faithful: "yes" }] }),
      JSON.stringify({ verdicts: [{ id: "r1", trigger_faithful: "yes" }, { id: "r1", trigger_faithful: "yes" }] }),
      JSON.stringify({ verdicts: [{ id: "r1", trigger_faithful: "yes" }, { id: "r9", trigger_faithful: "yes" }] }),
      JSON.stringify({ verdicts: [{ id: "r1", trigger_faithful: "yes", note: "x" }, { id: "r2", trigger_faithful: "yes" }] }),
      JSON.stringify({ verdicts: [{ id: "r1", trigger_faithful: "na" }, { id: "r2", trigger_faithful: "yes" }] }),
      "not json",
    ]) assert.throws(() => parseTriggerVerdicts(bad, ["r1", "r2"]), CheckerAnswerError);
  });
  test("the prompt has no outcome or likelihood wording and names no country", () => {
    assert.equal(findBannedWording(CHECKER_TRIGGER_SYSTEM_PROMPT), false);
    assert.ok(!/\b(united kingdom|ireland|canada|nigeria|schengen)\b/i.test(CHECKER_TRIGGER_SYSTEM_PROMPT));
  });
});

describe("the check run with triggers", () => {
  test("a confirmed trigger changes nothing: no dropped ids", async () => {
    const r = rig();
    const out = await r.svc.check(input(draftOf([ruleOf(1), specialist(2, ["alpha"]), specialist(3, ["beta"])])));
    assert.ok(out.ok);
    assert.deepEqual(out.ok && out.droppedTriggerIds, []);
    assert.ok(r.provider.requests.some((q) => q.user.includes("<triggers_data_")), "the trigger call was made");
  });

  test("an ordinary rule whose trigger fails is KEPT with its trigger dropped, never left out", async () => {
    const r = rig();
    r.provider.triggerPolicy = ({ item }) => (item.quote.includes("number 3 ") ? "no" : item.quote.includes("number 4 ") ? "unsure" : "yes");
    const out = await r.svc.check(input(draftOf([specialist(2, ["alpha"]), specialist(3, ["beta"]), specialist(4, ["alpha", "beta"])])));
    assert.ok(out.ok);
    assert.deepEqual(out.ok && out.droppedTriggerIds, ["crit-0003", "crit-0004"]);
    assert.deepEqual(out.ok && out.leftOut, [], "a wrong trigger removes nothing");
  });

  test("a rule already left out by an aspect needs no trigger decision", async () => {
    const r = rig();
    r.provider.policy = ({ rule }) => (rule.title === "Matter 3" ? { title_faithful: "no" } : undefined);
    r.provider.triggerPolicy = () => "no";
    const out = await r.svc.check(input(draftOf([specialist(2, ["alpha"]), specialist(3, ["beta"])])));
    assert.ok(out.ok);
    assert.deepEqual(out.ok && out.leftOut.map((l) => l.criterionId), ["crit-0003"]);
    assert.deepEqual(out.ok && out.droppedTriggerIds, ["crit-0002"]);
  });

  test("a protected rule's trigger needs BOTH models; one `no` holds the draft and names the rule", async () => {
    const r = rig();
    const bar = barOf(5, { applicability: "specialist", applicabilityCondition: "Only for activity alpha", trigger: { questionId: "activity", anyOf: ["alpha"] } } as any);
    r.provider.triggerPolicy = ({ role }) => (role === "judgement" ? "unsure" : "yes");
    const out = await r.svc.check(input(draftOf([ruleOf(1), bar])));
    assert.equal(out.ok, false);
    assert.deepEqual(!out.ok && out.reasonCodes, ["protected_rule_failed:crit-0005"]);
    assert.deepEqual(!out.ok && out.protectedRuleIds, ["crit-0005"]);
  });

  test("a protected rule whose trigger both models confirm passes", async () => {
    const r = rig();
    const bar = barOf(5, { applicability: "specialist", applicabilityCondition: "Only for activity alpha", trigger: { questionId: "activity", anyOf: ["alpha"] } } as any);
    const out = await r.svc.check(input(draftOf([ruleOf(1), bar])));
    assert.ok(out.ok);
    assert.deepEqual(out.ok && out.droppedTriggerIds, []);
  });

  test("an invalid trigger answer holds (checker_output_invalid); nothing is assumed", async () => {
    const r = rig();
    r.provider.script = (_n, req) => (req.user.includes("<triggers_data_") ? { text: JSON.stringify({ verdicts: [] }) } : undefined);
    const out = await r.svc.check(input(draftOf([specialist(2, ["alpha"])])));
    assert.deepEqual(!out.ok && out.reasonCodes, ["checker_output_invalid"]);
  });

  test("a trigger that is not usable against the draft's questions is not asked about (consumers already ignore it)", async () => {
    const r = rig();
    const dangling = specialist(2, ["alpha"], { trigger: { questionId: "nope", anyOf: ["alpha"] } });
    const out = await r.svc.check(input(draftOf([dangling])));
    assert.ok(out.ok);
    assert.ok(!r.provider.requests.some((q) => q.user.includes("<triggers_data_")));
  });

  test("batches of CHECKER_TRIGGER_BATCH_SIZE, and a second run of the same version makes no model call", async () => {
    const r = rig({ lines: 40 });
    const many = Array.from({ length: 25 }, (_, k) => specialist(k + 1, ["alpha"]));
    const rubric = draftOf(many);
    await r.svc.check(input(rubric));
    const triggerCalls = r.provider.requests.filter((q) => q.user.includes("<triggers_data_")).length;
    assert.equal(triggerCalls, Math.ceil(25 / CHECKER_TRIGGER_BATCH_SIZE));
    const before = r.provider.requests.length;
    const again = await r.svc.check(input(rubric));
    assert.ok(again.ok);
    assert.equal(r.provider.requests.length, before, "stored verdicts are reused");
  });
});

describe("a dropped trigger on the read side", () => {
  const plan = (dropped: string[]) => ({ ...rubricFor(), questionPlan: buildQuestionPlan(rubricFor(), [], { questions: [], evidence: [] }, null, dropped) }) as any;
  function rubricFor(): any {
    return { ...draftOf([specialist(2, ["alpha"]), specialist(3, ["beta"])]), intakeQuestions: [{ ...ACTIVITY, criterionIds: ["crit-0002", "crit-0003"] }], evidenceItems: [] };
  }

  test("the rule stays and only its trigger is ignored", () => {
    const served = applyExclusions(plan(["crit-0003"]));
    assert.equal(served.criteria.length, 2);
    assert.ok(served.criteria.find((c: any) => c.criterionId === "crit-0002").trigger, "a confirmed trigger stays");
    assert.equal(served.criteria.find((c: any) => c.criterionId === "crit-0003").trigger, undefined, "the dropped trigger is gone");
    assert.equal(served.questionPlan, undefined, "the plan is not served");
  });

  test("the plan validates; an id without a trigger or a repeated id is an error", () => {
    const ok = plan(["crit-0003"]);
    const errs = (r: any) => validateVisaRubric(r).errors.filter((e) => e.code === "question_plan_invalid");
    assert.deepEqual(errs(ok), []);
    assert.equal(errs({ ...ok, questionPlan: { ...ok.questionPlan, droppedTriggerCriterionIds: ["crit-0003", "crit-0003"] } }).length, 1);
    assert.equal(errs({ ...ok, questionPlan: { ...ok.questionPlan, droppedTriggerCriterionIds: ["nope"] } }).length, 1);
  });

  test("buildQuestionPlan ignores an id that carries no trigger", () => {
    const p = buildQuestionPlan(rubricFor(), [], { questions: [], evidence: [] }, null, ["crit-0002", "ghost"]);
    assert.deepEqual(p.droppedTriggerCriterionIds, ["crit-0002"]);
  });
});
