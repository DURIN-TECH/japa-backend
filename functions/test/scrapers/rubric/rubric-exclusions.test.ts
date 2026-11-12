// ============================================
// Rubric criterion exclusions (issue #161) — pure unit tests, no Firestore
// ============================================
//
// Covers the read-side filter (`applyExclusions`), the preview that counts it,
// the validator's exclusion codes, the extraction guard on the store, and the
// approved-status check of the two background readers (bulk re-assessment and
// rule-change alerts). The HTTP side (approve / preview routes, the store
// read path) is in rubric-review.test.ts, next to the harness it needs.
//
// Fixtures are the invented routes of rubric-review-fixtures.ts.

import { describe, test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Timestamp } from "firebase-admin/firestore";
import { applyExclusions, previewExclusions, MAX_EXCLUDED_CRITERIA } from "../../../src/scrapers/rubric/rubric-exclusions";
import { validateVisaRubric } from "../../../src/scrapers/rubric/rubric-validate";
import { rubricStore } from "../../../src/scrapers/rubric/rubric.store";
import { BulkReassessmentService } from "../../../src/services/ai-bulk-reassessment.service";
import { RuleChangeAlertsService } from "../../../src/services/rule-change-alerts.service";
import type { EvidenceItem, IntakeQuestion, VisaRubric } from "../../../src/types/rubric";
import { fakeCollection, resetStore, store } from "../../helpers/fake-firestore";
import { quiet } from "./rubric-harness";
import { REVIEW_T0, routeAV1, routeAV2 } from "./rubric-review-fixtures";

/* eslint-disable @typescript-eslint/no-explicit-any */

const HASH = "c".repeat(64);

/** Route A's first reading as a stored version, with the extra parts a test needs. */
function rubric(extra: Partial<VisaRubric> = {}, base = routeAV1(HASH)): VisaRubric {
  return { ...base, version: 1, ...extra } as VisaRubric;
}

/** A question read by the criteria with these ids. */
const question = (id: string, criterionIds: string[], extra: Partial<IntakeQuestion> = {}): IntakeQuestion => ({
  id,
  label: `Question ${id}`,
  answerType: "text",
  required: true,
  criterionIds,
  ...extra,
});

/** An evidence item for the criteria with these ids. */
const evidence = (key: string, criterionIds: string[], extra: Partial<EvidenceItem> = {}): EvidenceItem => ({
  key,
  title: `Document ${key}`,
  party: "applicant",
  criterionIds,
  source: rubric().criteria[0].source,
  ...extra,
});

/** The ids of route A's four criteria by role in these tests. */
function ids(r: VisaRubric) {
  const by = (title: string) => r.criteria.find((c) => c.title.startsWith(title))!.criterionId;
  return { age: by("Aged"), held: by("Funds"), leave: by("Will leave"), bar: by("Nationals") };
}

describe("applyExclusions: the one read-side filter", () => {
  test("nothing excluded: the very same object comes back", () => {
    const r = rubric({ intakeQuestions: [question("q1", [ids(rubric()).age])] });
    assert.equal(applyExclusions(r), r);
  });

  test("excluded criteria are dropped, the rest keep their order, the input is not mutated, the exclusion fields are stripped", () => {
    const r0 = rubric();
    const { age, leave } = ids(r0);
    const r = rubric({ excludedCriterionIds: [age], exclusionNote: "specialist" });
    const before = JSON.stringify(r);
    const out = applyExclusions(r);
    assert.deepEqual(out.criteria.map((c) => c.criterionId), r0.criteria.map((c) => c.criterionId).filter((id) => id !== age));
    assert.ok(out.criteria.some((c) => c.criterionId === leave));
    assert.equal(JSON.stringify(r), before, "input untouched");
    assert.ok(!("excludedCriterionIds" in out) && !("exclusionNote" in out));
    // Idempotent: filtering the result again changes nothing.
    assert.equal(applyExclusions(out), out);
  });

  test("a question or evidence item whose EVERY criterion is excluded drops; one that keeps a criterion stays, trimmed", () => {
    const { age, held, leave } = ids(rubric());
    const r = rubric({
      intakeQuestions: [question("only-age", [age]), question("age-and-leave", [age, leave]), question("leave", [leave])],
      evidenceItems: [evidence("passport", [age]), evidence("statement", [age, held]), evidence("letter", [leave])],
      excludedCriterionIds: [age],
    });
    const out = applyExclusions(r);
    assert.deepEqual(out.intakeQuestions.map((q) => q.id), ["age-and-leave", "leave"]);
    assert.deepEqual(out.intakeQuestions[0].criterionIds, [leave], "only the kept ids remain");
    assert.deepEqual(out.evidenceItems.map((e) => e.key), ["statement", "letter"]);
    assert.deepEqual(out.evidenceItems[0].criterionIds, [held]);
  });

  test("dangling references are cleaned: criterion.intakeQuestionIds and evidenceHelpsCriterionIds", () => {
    const { age, held, leave } = ids(rubric());
    const base = rubric();
    const criteria = base.criteria.map((c) => (c.criterionId === leave ? { ...c, intakeQuestionIds: ["only-age", "q-leave"] } : c));
    const r = rubric({
      criteria,
      intakeQuestions: [question("only-age", [age]), question("q-leave", [leave])],
      evidenceHelpsCriterionIds: [age, held],
      excludedCriterionIds: [age],
    });
    const out = applyExclusions(r);
    assert.deepEqual(out.criteria.find((c) => c.criterionId === leave)!.intakeQuestionIds, ["q-leave"]);
    assert.deepEqual(out.evidenceHelpsCriterionIds, [held]);
  });

  test("showWhen: a condition on a dropped question is removed; with none left the question is unreachable and drops, and so does what hangs off it", () => {
    const { age, leave, held } = ids(rubric());
    const cond = (questionId: string) => ({ questionId, op: "eq" as const, value: "yes" });
    const r = rubric({
      intakeQuestions: [
        question("gate", [age]), // dropped: its only criterion is excluded
        question("both", [leave], { showWhen: { anyOf: [cond("gate"), cond("open")] } }), // keeps its live condition
        question("open", [leave]),
        question("dead", [held], { showWhen: { anyOf: [cond("gate")] } }), // only condition is dead: unreachable
        question("chain", [held], { showWhen: { anyOf: [cond("dead")] } }), // hangs off the unreachable one
      ],
      evidenceItems: [evidence("needs-gate", [leave], { when: cond("gate") }), evidence("needs-open", [leave], { when: cond("open") })],
      excludedCriterionIds: [age],
    });
    const out = applyExclusions(r);
    assert.deepEqual(out.intakeQuestions.map((q) => q.id), ["both", "open"]);
    assert.deepEqual(out.intakeQuestions[0].showWhen, { anyOf: [cond("open")] });
    assert.deepEqual(out.evidenceItems.map((e) => e.key), ["needs-open"]);
    // Nothing anywhere points at a question that is gone.
    const live = new Set(out.intakeQuestions.map((q) => q.id));
    for (const q of out.intakeQuestions) for (const c of q.showWhen?.anyOf ?? []) assert.ok(live.has(c.questionId));
    for (const e of out.evidenceItems) if (e.when) assert.ok(live.has(e.when.questionId));
  });

  test("a mandatory bar is never removed, even when a stored list names it; unknown ids are ignored", () => {
    const { bar, age } = ids(rubric());
    const out = applyExclusions(rubric({ excludedCriterionIds: [bar, "no-such-criterion", age] }));
    assert.ok(out.criteria.some((c) => c.criterionId === bar), "the bar stays in force");
    assert.ok(!out.criteria.some((c) => c.criterionId === age));
  });

  test("a stored empty list is stripped without changing content", () => {
    const r = rubric({ excludedCriterionIds: [] });
    const out = applyExclusions(r);
    assert.deepEqual(out.criteria, r.criteria);
    assert.ok(!("excludedCriterionIds" in out));
  });
});

describe("previewExclusions: counts from the same function", () => {
  test("counts kept and dropped questions and evidence items, and names them", () => {
    const { age, leave } = ids(rubric());
    const r = rubric({
      intakeQuestions: [question("q-age", [age]), question("q-leave", [leave])],
      evidenceItems: [evidence("ev-age", [age]), evidence("ev-leave", [leave])],
    });
    const p = previewExclusions(r, [age]);
    assert.deepEqual(p, {
      criteriaKept: 3,
      criteriaExcluded: 1,
      intakeQuestionsKept: 1,
      intakeQuestionsDropped: 1,
      evidenceItemsKept: 1,
      evidenceItemsDropped: 1,
      droppedIntakeQuestionIds: ["q-age"],
      droppedEvidenceItemKeys: ["ev-age"],
      droppedIntakeQuestions: [{ id: "q-age", label: "Question q-age", reason: "no_kept_criterion", keptCriterionIds: [] }],
      droppedEvidenceItems: [{ key: "ev-age", title: "Document ev-age", reason: "no_kept_criterion" }],
    });
    // The preview did not touch the rubric.
    assert.equal(r.intakeQuestions.length, 2);
  });

  test("(#169) says why each item drops: no kept criterion, or a dropped question it depends on; keptCriterionIds only for the dependency case", () => {
    const { age, leave, held } = ids(rubric());
    const cond = (questionId: string) => ({ questionId, op: "eq" as const, value: "yes" });
    const r = rubric({
      intakeQuestions: [
        question("gate", [age]), // no kept criterion
        question("dep", [leave, age], { showWhen: { anyOf: [cond("gate")] } }), // kept criterion `leave` still links to it
        question("chain", [held], { showWhen: { anyOf: [cond("dep")] } }), // depends on a question that itself dropped
        question("open", [leave]),
      ],
      evidenceItems: [
        evidence("ev-gate", [age]),
        evidence("ev-dep", [leave], { when: cond("gate") }),
        evidence("ev-keep", [leave], { when: cond("open") }),
      ],
    });
    const p = previewExclusions(r, [age]);
    assert.deepEqual(p.droppedIntakeQuestions, [
      { id: "gate", label: "Question gate", reason: "no_kept_criterion", keptCriterionIds: [] },
      { id: "dep", label: "Question dep", reason: "depends_on_dropped_question", dependsOn: "gate", keptCriterionIds: [leave] },
      { id: "chain", label: "Question chain", reason: "depends_on_dropped_question", dependsOn: "dep", keptCriterionIds: [held] },
    ]);
    assert.deepEqual(p.droppedEvidenceItems, [
      { key: "ev-gate", title: "Document ev-gate", reason: "no_kept_criterion" },
      { key: "ev-dep", title: "Document ev-dep", reason: "depends_on_dropped_question", dependsOn: "gate" },
    ]);
    // keptCriterionIds is non-empty exactly for the dependency drops.
    for (const q of p.droppedIntakeQuestions) assert.equal(q.keptCriterionIds.length > 0, q.reason === "depends_on_dropped_question");
  });

  test("(#169) the reported drops are exactly what applyExclusions removes", () => {
    const { age, leave, held } = ids(rubric());
    const cond = (questionId: string) => ({ questionId, op: "eq" as const, value: "yes" });
    const r = rubric({
      intakeQuestions: [
        question("gate", [age]),
        question("dep", [leave], { showWhen: { anyOf: [cond("gate")] } }),
        question("partly", [age, held], { showWhen: { anyOf: [cond("gate"), cond("open")] } }),
        question("open", [leave]),
      ],
      evidenceItems: [evidence("a", [age]), evidence("b", [leave], { when: cond("dep") }), evidence("c", [held])],
    });
    for (const excl of [[age], [age, leave], [leave, held], []]) {
      const p = previewExclusions(r, excl);
      const out = applyExclusions({ ...r, excludedCriterionIds: excl });
      const keptQ = new Set(out.intakeQuestions.map((q) => q.id));
      const keptE = new Set(out.evidenceItems.map((e) => e.key));
      assert.deepEqual(p.droppedIntakeQuestions.map((q) => q.id), r.intakeQuestions.map((q) => q.id).filter((id) => !keptQ.has(id)));
      assert.deepEqual(p.droppedEvidenceItems.map((e) => e.key), r.evidenceItems.map((e) => e.key).filter((k) => !keptE.has(k)));
      assert.deepEqual(p.droppedIntakeQuestions.map((q) => q.id), p.droppedIntakeQuestionIds);
      assert.deepEqual(p.droppedEvidenceItems.map((e) => e.key), p.droppedEvidenceItemKeys);
    }
  });

  test("an empty set removes nothing", () => {
    const p = previewExclusions(rubric({ intakeQuestions: [question("q", [ids(rubric()).age])] }), []);
    assert.equal(p.criteriaExcluded, 0);
    assert.equal(p.intakeQuestionsDropped, 0);
  });
});

describe("validator: exclusion codes", () => {
  const codes = (r: VisaRubric) => validateVisaRubric(r).errors.map((e) => e.code);
  const { age, bar } = ids(rubric());

  test("a valid list and note pass", () => {
    assert.deepEqual(codes(rubric({ excludedCriterionIds: [age], exclusionNote: "Specialist route only." })), []);
  });
  test("an id that is not a criterion of the version", () => {
    assert.deepEqual(codes(rubric({ excludedCriterionIds: ["nope"] })), ["exclusion_criterion_unknown"]);
  });
  test("a duplicate id", () => {
    assert.deepEqual(codes(rubric({ excludedCriterionIds: [age, age] })), ["exclusion_duplicate"]);
  });
  test("a mandatory bar can never be excluded", () => {
    assert.deepEqual(codes(rubric({ excludedCriterionIds: [bar] })), ["mandatory_bar_excluded"]);
  });
  test("a list over the cap, a non-list and a bad note", () => {
    assert.ok(codes(rubric({ excludedCriterionIds: Array.from({ length: MAX_EXCLUDED_CRITERIA + 1 }, (_, i) => `x${i}`) })).includes("exclusion_list_too_long"));
    assert.deepEqual(codes(rubric({ excludedCriterionIds: "all" as any })), ["exclusion_invalid"]);
    assert.deepEqual(codes(rubric({ exclusionNote: "x".repeat(1001) })), ["exclusion_note_invalid"]);
  });
});

describe("the store refuses an extraction output that carries exclusions", () => {
  test("writePendingVersion: not_pending for excludedCriterionIds or exclusionNote", async () => {
    const { version: _v, ...d } = rubric();
    void _v;
    await assert.rejects(() => rubricStore.writePendingVersion({ ...d, excludedCriterionIds: [] } as any, []), (e: any) => e.code === "not_pending");
    await assert.rejects(() => rubricStore.writePendingVersion({ ...d, exclusionNote: "x" } as any, []), (e: any) => e.code === "not_pending");
  });
});

describe("background readers only diff APPROVED versions", () => {
  before(async () => {
    const firebase: any = await import("../../../src/utils/firebase");
    firebase.collections.ruleChangeEvents = fakeCollection("ruleChangeEvents");
  });
  beforeEach(() => resetStore());

  const approved = (v: number, extra: Partial<VisaRubric> = {}, base = routeAV1(HASH)): VisaRubric =>
    ({ ...base, version: v, reviewStatus: "approved", intentPolarity: "immigrant_intent_penalised", reviewedBy: "a", reviewedAt: Timestamp.fromMillis(REVIEW_T0), ...extra }) as VisaRubric;

  test("bulk re-assessment: a pending or rejected version is skipped (null), an approved one comes back filtered", async () => {
    const { age } = ids(rubric());
    const versions = new Map<number, VisaRubric>([
      [1, approved(1, { excludedCriterionIds: [age] })],
      [2, { ...approved(2), reviewStatus: "pending_review" } as VisaRubric],
      [3, { ...approved(3), reviewStatus: "rejected" } as VisaRubric],
    ]);
    const svc: any = new BulkReassessmentService({ getRubricVersion: async (_k: string, v: number) => versions.get(v) ?? null } as any);
    const current = approved(4);
    const { result: one, lines } = await quiet((): Promise<VisaRubric | null> => svc.rubricVersionOf(current, 1));
    assert.ok(one && !one.criteria.some((c: any) => c.criterionId === age), "effective content: the excluded criterion is not in it");
    const { result: two, lines: l2 } = await quiet(() => svc.rubricVersionOf(current, 2));
    const { result: three } = await quiet(() => svc.rubricVersionOf(current, 3));
    assert.equal(two, null);
    assert.equal(three, null);
    assert.ok(l2.some((l) => /not approved/.test(l)), "logged");
    assert.equal(lines.length, 0);
  });

  test("rule-change alerts: an audit entry naming a non-approved version records a skipped event and diffs nothing", async () => {
    const versions = new Map<number, VisaRubric>([
      [1, approved(1)],
      [2, { ...approved(2, {}, routeAV2(HASH)), reviewStatus: "pending_review" } as VisaRubric],
    ]);
    const svc = new RuleChangeAlertsService({ getRubricVersion: async (_k: string, v: number) => versions.get(v) ?? null, now: () => new Date(REVIEW_T0) } as any);
    const entry: any = { action: "approve", approvedVersion: 2, previousApprovedVersion: 1, routeKey: "ZZ_x", countryCode: "ZZ", visaTypeId: "x", by: "admin-uid", at: Timestamp.fromMillis(REVIEW_T0) };
    const { result } = await quiet(() => svc.recordRubricApproval("audit-1", entry));
    assert.equal(result, "skipped");
    const events = [...store.values()].filter((d: any) => d.sourceKind === "guidance") as any[];
    assert.equal(events.length, 1);
    assert.equal(events[0].skipReason, "rubric_version_not_approved");
    assert.ok(events[0].rubricSummary == null, "no rubric diff was made");
  });

  test("rule-change alerts: an exclusion made at approval is diffed as a removal for applicants", async () => {
    const { age } = ids(rubric());
    // Same extracted content; the new approval excluded a criterion the old one served.
    // Effective content of v2 lacks it, so it is a REMOVAL for applicants: summarised.
    const versions = new Map<number, VisaRubric>([[1, approved(1)], [2, approved(2, { excludedCriterionIds: [age] })]]);
    const svc = new RuleChangeAlertsService({ getRubricVersion: async (_k: string, v: number) => versions.get(v) ?? null, now: () => new Date(REVIEW_T0) } as any);
    const entry: any = { action: "approve", approvedVersion: 2, previousApprovedVersion: 1, routeKey: "ZZ_x", countryCode: "ZZ", visaTypeId: "x", by: "admin-uid", at: Timestamp.fromMillis(REVIEW_T0) };
    const { result } = await quiet(() => svc.recordRubricApproval("audit-2", entry));
    assert.equal(result, "recorded");
    const ev: any = [...store.values()].find((d: any) => d.sourceKind === "guidance");
    assert.equal(ev.rubricSummary.removedCount, 1);
    assert.equal(ev.rubricSummary.addedCount, 0);
  });
});
