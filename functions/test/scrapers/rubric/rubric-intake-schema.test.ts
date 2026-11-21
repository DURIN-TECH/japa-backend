// ============================================
// The intake answer format fits the provider (issue #456)
// ============================================
//
// The v13 intake schema (call 2) was refused live with HTTP 400 "The compiled
// grammar is too large" (#335). v14 removes its union types and two optional
// parameters, and moves what the schema checked into code. No network, no
// model, no Firestore. Covers:
//  - SIZE: the intake schema has 0 unions, at most 11 optional parameters and
//    a depth of at most 5; the criteria schema stays at 17 optional / 1 union.
//    The check fails (and says where) when a union or an optional is added;
//  - NO CHECK WEAKENED: a condition value that does not fit its question's
//    answer type is refused (`typeConditionValues`, and at merge time for a
//    question of a later excerpt); a missing or wrongly typed field is still
//    refused by `validateAgainstSchema`;
//  - SAME SHAPE STORED: a rulebook built from a v14 answer equals the one the
//    same answer, typed as before v14, builds (booleans for yes_no, numbers
//    for number, strings otherwise);
//  - `parseRubricOutput`: `optionsFrom: "none"` reads as null, an empty
//    `competenceSteps` reads as "no steps".
// Every id, sentence and code below is made up.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { assessChunkOutput, mergeAssessments } from "../../../src/scrapers/rubric/rubric-extraction.service";
import {
  RubricOutputError,
  buildIntakeOutputSchema,
  buildRubricOutputSchema,
  conditionValueFor,
  parseRubricOutput,
  typeConditionValues,
  validateAgainstSchema,
  type RawRubricOutput,
} from "../../../src/scrapers/rubric/rubric-prompt";
import { CRITERIA_SCHEMA_LIMITS, INTAKE_SCHEMA_LIMITS, describeSchemaSize, measureSchema, schemaSizeProblems } from "../../../src/scrapers/rubric/rubric-schema-size";
import { SnapshotQuoteIndex } from "../../../src/scrapers/rubric/rubric-quote";
import { DEFAULT_SEVERITY_LEVELS } from "../../../src/types/rubric";
import type { GuidanceSnapshotContent } from "../../../src/scrapers/guidance/types";
import { answer, crit, intakeWire, v14IntakeAnswer } from "./rubric-harness";

/* eslint-disable @typescript-eslint/no-explicit-any */

// ============================================
// Schema size (offline measurement)
// ============================================

describe("schema size (#456)", () => {
  test("the intake schema has no union, at most 11 optional parameters and depth at most 5", (t) => {
    const size = measureSchema(buildIntakeOutputSchema());
    // Printed on every run, so the numbers are in the log when the next refusal comes.
    t.diagnostic(`intake schema: ${describeSchemaSize(size)}`);
    assert.deepEqual(schemaSizeProblems(size, INTAKE_SCHEMA_LIMITS), [], describeSchemaSize(size));
    assert.equal(size.unions, 0);
    assert.ok(size.optional <= 11);
    assert.ok(size.maxDepth <= 5);
    // No `anyOf` and no type array ANYWHERE in it (belt and braces for the walk above).
    const json = JSON.stringify(buildIntakeOutputSchema());
    assert.equal(json.includes("anyOf"), false);
    assert.equal(/"type":\[/.test(json), false);
  });

  test("the criteria schema is pinned at no more than 17 optional and 1 union parameters (unchanged by #456)", (t) => {
    const size = measureSchema(buildRubricOutputSchema(DEFAULT_SEVERITY_LEVELS));
    t.diagnostic(`criteria schema: ${describeSchemaSize(size)}`);
    assert.deepEqual(schemaSizeProblems(size, CRITERIA_SCHEMA_LIMITS), [], describeSchemaSize(size));
    assert.equal(size.optional, 17);
    assert.deepEqual(size.unionPaths, ["$.criteria[].check.value"]);
  });

  test("adding a union or an optional parameter to the intake schema fails the check, naming the path", () => {
    // A union on one new field.
    const withUnion: any = buildIntakeOutputSchema();
    withUnion.properties.ruleTriggers.items.properties.questionId = { anyOf: [{ type: "string" }, { type: "boolean" }] };
    const u = schemaSizeProblems(measureSchema(withUnion), INTAKE_SCHEMA_LIMITS);
    assert.equal(u.length, 1);
    assert.match(u[0], /1 union-typed parameter\(s\), at most 0: \$\.ruleTriggers\[\]\.questionId$/);
    // A type array is a union too.
    const withTypeArray: any = buildIntakeOutputSchema();
    withTypeArray.properties.evidenceItems.items.properties.quote = { type: ["string", "null"] };
    assert.match(schemaSizeProblems(measureSchema(withTypeArray), INTAKE_SCHEMA_LIMITS)[0], /\$\.evidenceItems\[\]\.quote/);
    // One optional parameter too many (competenceSteps made optional again, as in v13).
    const withOptional: any = buildIntakeOutputSchema();
    withOptional.required = withOptional.required.filter((k: string) => k !== "competenceSteps");
    const o = schemaSizeProblems(measureSchema(withOptional), INTAKE_SCHEMA_LIMITS);
    assert.equal(o.length, 1);
    assert.match(o[0], /12 optional parameter\(s\), at most 11: .*\$\.competenceSteps/);
  });

  test("the v13 schema shape would have failed the check (the refused one is caught offline)", () => {
    // v13: three union `value`s, optional `competenceSteps` and `optionsFrom`.
    const v13: any = buildIntakeOutputSchema();
    const union = { anyOf: [{ type: "string" }, { type: "number" }, { type: "boolean" }] };
    v13.properties.intakeQuestions.items.properties.showWhenAnyOf.items.properties.value = union;
    v13.properties.evidenceItems.items.properties.showWhenAnyOf.items.properties.value = union;
    v13.properties.competenceSteps.items.properties.whenAllOf.items.properties.value = union;
    v13.required = v13.required.filter((k: string) => k !== "competenceSteps");
    v13.properties.intakeQuestions.items.required = v13.properties.intakeQuestions.items.required.filter((k: string) => k !== "optionsFrom");
    const size = measureSchema(v13);
    assert.equal(size.unions, 3);
    assert.equal(size.optional, 13);
    assert.equal(schemaSizeProblems(size, INTAKE_SCHEMA_LIMITS).length, 2);
  });
});

// ============================================
// Condition values: typed and checked in code
// ============================================

describe("conditionValueFor (#456)", () => {
  test("yes_no: only \"true\" / \"false\" (or a boolean) fit, and become booleans", () => {
    assert.equal(conditionValueFor("true", "yes_no"), true);
    assert.equal(conditionValueFor("false", "yes_no"), false);
    assert.equal(conditionValueFor(true, "yes_no"), true);
    for (const v of ["yes", "True", "1", "", " true", 1]) assert.equal(conditionValueFor(v, "yes_no"), undefined, String(v));
  });

  test("number: only a finite decimal number fits, and becomes a number", () => {
    assert.equal(conditionValueFor("3", "number"), 3);
    assert.equal(conditionValueFor("-2.5", "number"), -2.5);
    assert.equal(conditionValueFor(" 10 ", "number"), 10);
    assert.equal(conditionValueFor(7, "number"), 7);
    for (const v of ["", "abc", "1e3", "0x10", "Infinity", "NaN", "3 days", Number.NaN, true]) assert.equal(conditionValueFor(v, "number"), undefined, String(v));
  });

  test("every other answer type keeps the string as it is; a non-string does not fit", () => {
    for (const type of ["single_choice", "multi_choice", "text", "date", "date_range", "amount", "a_type_a_client_does_not_know"]) {
      assert.equal(conditionValueFor("tourism", type), "tourism");
      assert.equal(conditionValueFor(true, type), undefined);
    }
  });
});

describe("typeConditionValues (#456)", () => {
  /** A minimal question of the raw answer. */
  const q = (id: string, answerType: string, showWhenAnyOf: any[] = []) => ({ id, label: `Q ${id}`, helpText: null, answerType, required: true, criterionRefs: ["c1"], group: null, party: null, options: [], textMaxLength: null, dateRelativeToToday: null, showWhenAnyOf, optionsFrom: null });

  test("types show-when, evidence and competence conditions against the answer's own questions and the known ones", () => {
    const raw = answer({
      intakeQuestions: [q("paid", "yes_no"), q("who", "text", [{ questionId: "paid", op: "eq", value: "true" }]), q("nights_detail", "text", [{ questionId: "nights", op: "neq", value: "0" }])] as any,
      evidenceItems: [{ key: "e1", title: "E", party: "applicant", criterionRefs: ["c1"], quote: "x", documentType: null, fields: [], showWhenAnyOf: [{ questionId: "paid", op: "eq", value: "false" }] }],
      competenceSteps: [{ criterionRef: "c1", restsOn: "words", questionId: "visit", whenAllOf: [{ questionId: "paid", op: "neq", value: "true" }] }],
    });
    typeConditionValues(raw, [{ id: "nights", answerType: "number" }]);
    assert.equal(raw.intakeQuestions[1].showWhenAnyOf[0].value, true);
    assert.equal(raw.intakeQuestions[2].showWhenAnyOf[0].value, 0);
    assert.equal(raw.evidenceItems[0].showWhenAnyOf?.[0].value, false);
    assert.equal(raw.competenceSteps?.[0].whenAllOf[0].value, true);
  });

  test("a value that does not fit is refused as a failed answer, with paths only (never the model's text)", () => {
    const raw = answer({
      intakeQuestions: [q("paid", "yes_no"), q("who", "text", [{ questionId: "paid", op: "eq", value: "LEAK-VALUE-1" }])] as any,
      evidenceItems: [{ key: "e1", title: "E", party: "applicant", criterionRefs: ["c1"], quote: "x", documentType: null, fields: [], showWhenAnyOf: [{ questionId: "nights", op: "eq", value: "LEAK-VALUE-2" }] }],
      competenceSteps: [{ criterionRef: "c1", restsOn: "words", questionId: "visit", whenAllOf: [{ questionId: "paid", op: "eq", value: "LEAK-VALUE-3" }] }],
    });
    let caught: unknown;
    try {
      typeConditionValues(raw, [{ id: "nights", answerType: "number" }]);
    } catch (err) {
      caught = err;
    }
    assert.ok(caught instanceof RubricOutputError);
    assert.deepEqual(caught.problems, [
      "$.intakeQuestions[1].showWhenAnyOf[0].value: does not fit the answer type of the question it reads",
      "$.evidenceItems[0].showWhenAnyOf[0].value: does not fit the answer type of the question it reads",
      "$.competenceSteps[0].whenAllOf[0].value: does not fit the answer type of the question it reads",
    ]);
    assert.doesNotMatch(`${caught.message} ${caught.problems.join(" ")}`, /LEAK-/);
  });

  test("a question already asked decides the type over a same-id question of this answer (the merge keeps the first)", () => {
    const raw = answer({ intakeQuestions: [q("paid", "text"), q("who", "text", [{ questionId: "paid", op: "eq", value: "true" }])] as any });
    typeConditionValues(raw, [{ id: "paid", answerType: "yes_no" }]);
    assert.equal(raw.intakeQuestions[1].showWhenAnyOf[0].value, true);
  });

  test("a condition on a question neither in the answer nor known is left for the merge", () => {
    const raw = answer({ intakeQuestions: [q("who", "text", [{ questionId: "later", op: "eq", value: "maybe" }])] as any });
    typeConditionValues(raw, []);
    assert.equal(raw.intakeQuestions[0].showWhenAnyOf[0].value, "maybe");
  });

  test("a missing or wrongly typed field is still refused by the schema check", () => {
    const schema = buildIntakeOutputSchema();
    const ok = { intakeQuestions: [{ ...q("who", "text", [{ questionId: "paid", op: "eq", value: "true" }]), optionsFrom: "none" }], evidenceItems: [], ruleTriggers: [], competenceSteps: [], suspiciousPassages: [] };
    // helpText etc. are optional: drop the nulls, as a wire answer would.
    const clean = JSON.parse(JSON.stringify(ok, (k, v) => (v === null ? undefined : v)));
    assert.deepEqual(validateAgainstSchema(clean, schema), []);
    const typedValue = structuredClone(clean);
    typedValue.intakeQuestions[0].showWhenAnyOf[0].value = true;
    assert.deepEqual(validateAgainstSchema(typedValue, schema), ["$.intakeQuestions[0].showWhenAnyOf[0].value: must be a string"]);
    const noValue = structuredClone(clean);
    delete noValue.intakeQuestions[0].showWhenAnyOf[0].value;
    assert.deepEqual(validateAgainstSchema(noValue, schema), ["$.intakeQuestions[0].showWhenAnyOf[0].value: missing"]);
    const noOptionsFrom = structuredClone(clean);
    delete noOptionsFrom.intakeQuestions[0].optionsFrom;
    assert.deepEqual(validateAgainstSchema(noOptionsFrom, schema), ["$.intakeQuestions[0].optionsFrom: missing"]);
    const badOptionsFrom = structuredClone(clean);
    badOptionsFrom.intakeQuestions[0].optionsFrom = null;
    assert.deepEqual(validateAgainstSchema(badOptionsFrom, schema), ["$.intakeQuestions[0].optionsFrom: must be a string"]);
  });

  test("parseRubricOutput reads optionsFrom \"none\" as null and keeps route_destinations", () => {
    const text = JSON.stringify({
      intakeQuestions: [
        { id: "a", label: "A", answerType: "text", required: true, criterionRefs: [], options: [], showWhenAnyOf: [], optionsFrom: "none" },
        { id: "b", label: "B", answerType: "single_choice", required: true, criterionRefs: [], options: [], showWhenAnyOf: [], optionsFrom: "route_destinations" },
      ],
      evidenceItems: [],
      ruleTriggers: [],
      competenceSteps: [],
      suspiciousPassages: [],
    });
    const out = parseRubricOutput(text, buildIntakeOutputSchema());
    assert.equal(out.intakeQuestions[0].optionsFrom, null);
    assert.equal(out.intakeQuestions[1].optionsFrom, "route_destinations");
    assert.equal("competenceSteps" in out, false);
  });
});

// ============================================
// The same rulebook as before v14
// ============================================

describe("what is stored has the same shape as before v14 (#456)", () => {
  const URL = "https://rules.example.org/shared-route";
  // Made-up rules: one competence rule with two cases, one funds rule, one evidence line.
  const QUOTE = "The country competent to examine an application shall be the country that is the sole destination of the visit; or where no main destination can be determined, the country whose border the applicant intends to cross first.";
  const FUNDS = "Where another person pays for the visit, the decision maker should consider that person's means.";
  const LETTER = "A letter from the person paying for the visit should be provided.";
  const PLAN = "A plan of the visit should be provided for a business or tourism visit.";
  const TEXT = `${QUOTE}\n\n${FUNDS}\n\n${LETTER}\n\n${PLAN}`;
  const doc: GuidanceSnapshotContent = {
    schemaVersion: 1,
    sourceId: "src-1",
    contentHash: createHash("sha256").update(TEXT).digest("hex"),
    docType: "html",
    url: URL,
    finalUrl: URL,
    fetchedAt: "2026-11-01T00:00:00.000Z",
    text: TEXT,
    pages: null,
  };
  const base = { sourceId: doc.sourceId, url: doc.url, contentHash: doc.contentHash, retrievedAt: doc.fetchedAt };
  const CHUNK = { sourceId: "src-1", chunkIndex: 0 };
  /** A raw question with every optional at its "absent" value. */
  const q = (id: string, fields: Record<string, unknown> = {}) => ({ id, label: `Question ${id}`, helpText: null, answerType: "text", required: true, criterionRefs: ["c1"], group: null, party: null, options: [], textMaxLength: null, dateRelativeToToday: null, showWhenAnyOf: [], optionsFrom: null, ...fields });

  /** The intake answer, TYPED the way the v13 schema let a model write it. */
  const typedAnswer = (): RawRubricOutput =>
    answer({
      intakeQuestions: [
        q("paid_by_other", { answerType: "yes_no", criterionRefs: ["c2"] }),
        q("payer_name", { criterionRefs: ["c2"], party: "sponsor", showWhenAnyOf: [{ questionId: "paid_by_other", op: "eq", value: true }] }),
        q("purpose", { answerType: "single_choice", criterionRefs: ["c2"], options: [{ value: "tourism", label: "Tourism", description: null }, { value: "business", label: "Business", description: null }] }),
        q("purpose_detail", { criterionRefs: ["c2"], showWhenAnyOf: [{ questionId: "purpose", op: "neq", value: "tourism" }] }),
        q("visit", { answerType: "multi_choice", optionsFrom: "route_destinations" }),
        q("border", { answerType: "single_choice", optionsFrom: "route_destinations" }),
      ] as any,
      evidenceItems: [
        { key: "payer_letter", title: "Letter from the payer", party: "sponsor", criterionRefs: ["c2"], quote: LETTER, documentType: "letter", fields: [], showWhenAnyOf: [{ questionId: "paid_by_other", op: "eq", value: true }] },
        {
          key: "visit_plan",
          title: "Plan of the visit",
          party: "applicant",
          criterionRefs: ["c2"],
          quote: PLAN,
          documentType: null,
          fields: [],
          showWhenAnyOf: [
            { questionId: "purpose", op: "eq", value: "tourism" },
            { questionId: "purpose", op: "eq", value: "business" },
          ],
        },
      ],
      competenceSteps: [
        { criterionRef: "c1", restsOn: "sole destination", questionId: "visit", whenAllOf: [] },
        { criterionRef: "c1", restsOn: "intends to cross first", questionId: "border", whenAllOf: [{ questionId: "paid_by_other", op: "neq", value: true }] },
      ],
    });

  /** The criteria half (call 1), accepted by code. */
  const criteriaPart = () =>
    assessChunkOutput(
      answer({
        criteria: [
          crit({ ref: "c1", title: "Which country examines the application", kind: "judgement", stage: "validity", quote: QUOTE, probeFactors: ["the countries the applicant will visit"], requiresInterviewBeforeRefusal: false }),
          crit({ ref: "c2", title: "The payer's means should be considered", kind: "judgement", stage: "eligibility", quote: FUNDS, probeFactors: ["the payer's means"], requiresInterviewBeforeRefusal: false }),
        ],
      }),
      CHUNK,
      new SnapshotQuoteIndex(doc),
      base,
      DEFAULT_SEVERITY_LEVELS
    );

  /** Build the merged rulebook content from one intake answer. */
  const build = (intake: RawRubricOutput) => {
    const crits = criteriaPart();
    const intakePart = assessChunkOutput(intake, CHUNK, new SnapshotQuoteIndex(doc), base, DEFAULT_SEVERITY_LEVELS);
    return mergeAssessments([{ chunk: CHUNK, assessment: { ...intakePart, criteria: crits.criteria } }]);
  };

  test("a v14 answer (string values, required lists) builds exactly the rulebook its typed form built before", () => {
    // Before v14: the typed answer went straight into the assessment.
    const before = build(typedAnswer());
    // v14: the wire answer (strings, "none", an empty list where none) is parsed, then typed in code.
    const wire = intakeWire(typedAnswer());
    assert.doesNotMatch(wire, /"value":(true|false|\d)/, "the wire answer carries string values only");
    const parsed = typeConditionValues(parseRubricOutput(wire, buildIntakeOutputSchema()), []);
    const after = build(parsed);
    assert.deepEqual(after, before);
    // And the stored values have the types the rulebook always kept.
    const byId = new Map(after.intakeQuestions.map((x) => [x.id, x]));
    assert.deepEqual(byId.get("payer_name")?.showWhen, { anyOf: [{ questionId: "paid_by_other", op: "eq", value: true }] });
    assert.deepEqual(byId.get("purpose_detail")?.showWhen, { anyOf: [{ questionId: "purpose", op: "neq", value: "tourism" }] });
    const ev = new Map(after.evidenceItems.map((e) => [e.key, e]));
    assert.deepEqual(ev.get("payer_letter")?.when, { questionId: "paid_by_other", op: "eq", value: true });
    assert.deepEqual(ev.get("visit_plan")?.when, { questionId: "purpose", op: "in", value: ["tourism", "business"] });
    assert.ok(after.competence, "the competence block is kept");
    assert.deepEqual(after.competence?.steps[1].when, [{ questionId: "paid_by_other", op: "neq", value: true }]);
    assert.equal(byId.get("visit")?.optionsFrom, "route_destinations");
    assert.equal("optionsFrom" in (byId.get("payer_name") ?? {}), false);
  });

  test("an answer with no competence steps (an empty required list) builds what an answer without them built", () => {
    const typed = typedAnswer();
    delete typed.competenceSteps;
    const before = build(typed);
    const parsed = typeConditionValues(parseRubricOutput(intakeWire(typed), buildIntakeOutputSchema()), []);
    assert.equal("competenceSteps" in parsed, false);
    assert.deepEqual(build(parsed), before);
  });

  test("a misfit on a question of a LATER excerpt is caught at merge: the question / item / block goes, never a mistyped value", () => {
    // Excerpt 1 asks questions that read `paid_by_other`, which only excerpt 2 asks (a yes_no).
    const crits = criteriaPart();
    const first = typedAnswer();
    first.intakeQuestions = first.intakeQuestions.filter((x) => x.id !== "paid_by_other");
    (first.intakeQuestions.find((x) => x.id === "payer_name") as any).showWhenAnyOf[0].value = "maybe";
    (first.evidenceItems[0] as any).showWhenAnyOf[0].value = "maybe";
    (first.competenceSteps as any)[1].whenAllOf[0].value = "maybe";
    // Typed at arrival: the question is unknown there, so nothing is refused yet.
    const one = typeConditionValues(parseRubricOutput(intakeWire(first), buildIntakeOutputSchema()), []);
    const second = answer({ intakeQuestions: [q("paid_by_other", { answerType: "yes_no", criterionRefs: ["c2"] })] as any });
    const p1 = assessChunkOutput(one, CHUNK, new SnapshotQuoteIndex(doc), base, DEFAULT_SEVERITY_LEVELS);
    const p2 = assessChunkOutput(second, { sourceId: "src-1", chunkIndex: 1 }, new SnapshotQuoteIndex(doc), base, DEFAULT_SEVERITY_LEVELS);
    const merged = mergeAssessments([
      { chunk: CHUNK, assessment: { ...p1, criteria: crits.criteria } },
      // The same accepted rules (merged as exact duplicates), so excerpt 2's question resolves its rule.
      { chunk: { sourceId: "src-1", chunkIndex: 1 }, assessment: { ...p2, criteria: crits.criteria } },
    ]);
    // The question the misfits name IS in the rubric (so this is the type check, not an unknown reference).
    assert.ok(merged.intakeQuestions.some((x) => x.id === "paid_by_other"));
    assert.equal(merged.intakeQuestions.some((x) => x.id === "payer_name"), false);
    assert.ok(merged.discards.some((d) => d.itemType === "intake_question" && d.detail === "its show-when condition value does not fit the question it reads"));
    assert.equal(merged.evidenceItems.some((e) => e.key === "payer_letter"), false);
    assert.ok(merged.discards.some((d) => d.itemType === "evidence_item" && d.detail === "its trigger value does not fit the question it reads"));
    assert.equal(merged.competence, undefined);
    const flag = merged.flags.find((f) => f.code === "competence_dropped");
    assert.ok(flag);
    assert.match(flag.message, /competence_condition_invalid/);
    assert.doesNotMatch(JSON.stringify(merged), /"maybe"/);
  });
});

// The helper itself: the v14 wire form of a typed answer (used by every recorded intake answer).
describe("v14IntakeAnswer (test harness)", () => {
  test("strings every condition value, fills optionsFrom and competenceSteps, changes nothing else", () => {
    const out = v14IntakeAnswer({ intakeQuestions: [{ id: "a", showWhenAnyOf: [{ questionId: "b", op: "eq", value: false }] }], evidenceItems: [{ key: "e" }] });
    assert.deepEqual(out, { intakeQuestions: [{ id: "a", showWhenAnyOf: [{ questionId: "b", op: "eq", value: "false" }], optionsFrom: "none" }], evidenceItems: [{ key: "e" }], competenceSteps: [] });
  });
});
