// ============================================
// Rubric extraction keeps specialist rules (issue #207) — end to end, no model
// ============================================
//
// A FICTIONAL source (invented rule numbers, no country, no real route) run
// through the real extraction service over hand-written model answers. What is
// checked: a specialist-activity rule is kept with its verbatim condition and
// a validated trigger; other_route is still dropped; the run record counts the
// specialist rules kept; the intake call is sent the scoped rules' conditions;
// a trigger code cannot validate leaves the rule kept (never dropped).

import { before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { resetStore, store } from "../../helpers/fake-firestore";
import { RUBRIC_PROMPT_VERSION, RUBRIC_INTAKE_SYSTEM_PROMPT } from "../../../src/scrapers/rubric/rubric-prompt";
import { validateVisaRubric } from "../../../src/scrapers/rubric/rubric-validate";
import type { RawRubricOutput } from "../../../src/scrapers/rubric/rubric-prompt";
import type { VisaRubric } from "../../../src/types/rubric";
import { ROUTE_A, SOURCE_A_ID, SOURCE_A_URL } from "./fixtures/synthetic-guidance";
import { answer, crit, installRubricFakes, makeHarness, quiet, recordAnswers, resetBucket, runDocs, seedSource, versionDoc, type Harness } from "./rubric-harness";

/* eslint-disable @typescript-eslint/no-explicit-any */

const KEY_A = `${ROUTE_A.countryCode}_${ROUTE_A.visaTypeId}`;

// Fictional rules. Q 2.1 and Q 2.2 are for two different activities.
const GENERAL = "The applicant must hold a valid travel document.";
const TEACH_COND = "An applicant coming to teach at a school";
const TEACH = "An applicant coming to teach at a school must hold a letter from the school.";
const SPORT_COND = "An applicant coming to compete in a sporting event";
const SPORT = "An applicant coming to compete in a sporting event must hold an invitation from the organiser.";
const OTHER = "An applicant for the other category must hold a sponsor licence.";
const TEXT = [
  "Q 1.1 " + GENERAL,
  "Q 2.1 " + TEACH,
  "Q 2.2 " + SPORT,
  "Q 3.1 " + OTHER,
].join("\n");

/** The model's answer: one general rule, two specialist rules, one other-route rule. */
function modelAnswer(triggers: RawRubricOutput["ruleTriggers"]): RawRubricOutput {
  const j = { kind: "judgement" as const, probeFactors: ["x"], requiresInterviewBeforeRefusal: false };
  return answer({
    criteria: [
      crit({ ref: "gen", title: "Holds a travel document", ...j, quote: GENERAL }),
      crit({ ref: "teach", title: "Letter from the school", ...j, quote: TEACH, applicability: "specialist", applicabilityCondition: TEACH_COND }),
      crit({ ref: "sport", title: "Invitation from the organiser", ...j, quote: SPORT, applicability: "specialist", applicabilityCondition: SPORT_COND }),
      crit({ ref: "other", title: "Sponsor licence", ...j, quote: OTHER, applicability: "other_route" }),
    ],
    intakeQuestions: [{
      id: "visit-activity", label: "What will you do on your visit?", helpText: null, answerType: "single_choice", required: true, criterionRefs: ["gen"], group: null, party: null,
      options: [{ value: "teaching", label: "Teach at a school", description: null }, { value: "sport", label: "Compete in a sporting event", description: null }],
      textMaxLength: null, dateRelativeToToday: null, showWhenAnyOf: [],
    }],
    ruleTriggers: triggers,
  });
}

let h: Harness;

before(installRubricFakes);
beforeEach(() => {
  resetStore();
  resetBucket();
  h = makeHarness();
});

/** Seed the fictional source as the route's PRIMARY source (so scope rules apply) and record `out`. */
async function setUp(out: RawRubricOutput): Promise<void> {
  h.state.knownVisaTypes.add(`${ROUTE_A.countryCode}/${ROUTE_A.visaTypeId}`);
  await seedSource({ id: SOURCE_A_ID, url: SOURCE_A_URL, text: TEXT });
  store.set(`guidanceSources/${SOURCE_A_ID}`, { ...(store.get(`guidanceSources/${SOURCE_A_ID}`) as any), role: "primary" });
  await recordAnswers(h.provider, SOURCE_A_ID, [out]);
}
const run = () => quiet(() => h.service.extractRoute({ ...ROUTE_A, sourceIds: [SOURCE_A_ID] }));

describe("extraction keeps specialist rules (#207)", () => {
  test("a specialist rule is kept with its verbatim condition and a validated trigger; other_route is still dropped", async () => {
    await setUp(modelAnswer([
      { criterionRef: "teach", questionId: "visit-activity", answerValues: ["teaching"] },
      { criterionRef: "sport", questionId: "visit-activity", answerValues: ["sport"] },
    ]));
    const { result } = await run();
    assert.equal(result.status, "succeeded");
    assert.equal(result.criteriaAccepted, 3, "general + two specialist rules");
    assert.equal(result.specialistKept, 2);
    assert.deepEqual(result.discardedByReason, { other_route: 1 });

    const rubric = versionDoc(KEY_A, 1) as VisaRubric;
    const teach = rubric.criteria.find((c) => c.title === "Letter from the school")!;
    assert.equal(teach.applicability, "specialist");
    assert.equal(teach.applicabilityCondition, TEACH_COND, "the condition is the source's own words");
    assert.ok(TEXT.includes(teach.applicabilityCondition as string));
    assert.deepEqual(teach.trigger, { questionId: "visit-activity", anyOf: ["teaching"] });
    assert.deepEqual(rubric.criteria.find((c) => c.title === "Invitation from the organiser")!.trigger, { questionId: "visit-activity", anyOf: ["sport"] });
    // The criteria and the question reference each other, and the stored rubric is structurally valid.
    assert.deepEqual(teach.intakeQuestionIds, ["visit-activity"]);
    assert.equal(validateVisaRubric(rubric).errors.length, 0);
    assert.equal(rubric.flags.some((f) => f.code === "specialist_criteria_dropped" || f.code === "specialist_rules_without_trigger"), false);
    assert.equal(rubric.discarded.some((d) => (d.reason as string) === "specialist_activity"), false);
    assert.equal(rubric.extractorPromptVersion, RUBRIC_PROMPT_VERSION);
  });

  test("the run record reports specialistKept", async () => {
    await setUp(modelAnswer([{ criterionRef: "teach", questionId: "visit-activity", answerValues: ["teaching"] }]));
    await run();
    const rec = runDocs()[0];
    assert.equal(rec.status, "succeeded");
    assert.equal(rec.specialistKept, 2);
    assert.equal(rec.criteriaAccepted, 3);
  });

  test("a trigger code cannot validate leaves the rule KEPT without a trigger, and the version says so", async () => {
    await setUp(modelAnswer([{ criterionRef: "teach", questionId: "visit-activity", answerValues: ["flying"] }]));
    const { result } = await run();
    assert.equal(result.status, "succeeded");
    assert.equal(result.specialistKept, 2, "no specialist rule is dropped for want of a trigger");
    const rubric = versionDoc(KEY_A, 1) as VisaRubric;
    assert.equal(rubric.criteria.find((c) => c.title === "Letter from the school")!.trigger, undefined);
    const flag = rubric.flags.find((f) => f.code === "specialist_rules_without_trigger");
    assert.ok(flag);
    assert.match(flag!.message, /^2 specialist-activity rule/);
  });

  test("the intake call is sent each scoped rule's applicability and condition words, and is told to ask for rule triggers", async () => {
    await setUp(modelAnswer([]));
    await run();
    const intake = h.provider.requests.find((r) => r.system === RUBRIC_INTAKE_SYSTEM_PROMPT)!;
    assert.ok(intake.user.includes("\"applicability\":\"specialist\""));
    assert.ok(intake.user.includes(`"condition":"${TEACH_COND}"`));
    assert.match(RUBRIC_INTAKE_SYSTEM_PROMPT, /ruleTriggers/);
    // Generic: the prompts name no route, activity or country.
    assert.doesNotMatch(RUBRIC_INTAKE_SYSTEM_PROMPT, /teach|sport|school|visitor|student/i);
  });
});
