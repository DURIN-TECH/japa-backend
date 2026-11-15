// ============================================
// Unit tests — rules that cannot be checked from documents (issue #308)
// ============================================
//
// Before #308, an objective rule whose checked field was in no document FAILED
// whenever every upload was read cleanly. On the published UK Standard Visitor
// rulebook (v2) that made 35 refusal grounds for a plain visitor: an exclusion
// order, a deportation order, the fee, biometrics, private foster care ...
// none of which any document item of the rulebook asks for.
//
// The rule now: a missing field fails a rule ONLY when the rulebook names a
// document item for it (`evidenceItems[].criterionIds`). Every other missing
// field is stored as "not checkable from documents"
// (`notAssessed: "not_in_documents"`): never a refusal ground, never a top
// issue, never a proposed action, and it does not lower the band or the
// confidence.
//
// No Firestore, no network, no model. Part 1 uses small hand-written rubrics;
// part 2 replays a fixture copied (read-only) from the real rulebook and the
// QA application the issue names.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  assembleContent,
  barNotAssessedItems,
  decideMandatoryBars,
  evaluateObjective,
  isNotActionableMarker,
  topIssuesOf,
  NOT_CHECKABLE_REASON,
  type AssessmentContent,
  type DocumentExtraction,
  type Facts,
  type JudgementOutput,
} from "../../src/services/ai/assessment-engine";
import { notAssessedItems, splitByApplicability } from "../../src/services/ai/rule-applicability";
import { deriveProposedActions } from "../../src/services/ai-action.service";
import type { EvidenceItem, VisaRubric } from "../../src/types/rubric";
import { criterion, fictionalRubric } from "./harness";
import fixture from "./fixtures/uk-standard-visitor-v2-308.json";

/* eslint-disable @typescript-eslint/no-explicit-any */

// ============================================
// Helpers
// ============================================

/** One cleanly read document with the given values (none by default). */
function doc(id: string, values: Array<{ field: string; value: any; unit?: string | null }> = [], extra: Partial<DocumentExtraction> = {}): DocumentExtraction {
  return {
    documentId: id,
    label: "fixture",
    mediaType: "application/pdf",
    readable: true,
    failed: false,
    failure: null,
    suspicious: false,
    values: values.map((v) => ({ field: v.field, value: v.value, unit: v.unit ?? null, page: 1, quote: "q" })),
    ...extra,
  };
}

/** A document item of a rulebook, naming the rules it evidences. */
function item(key: string, title: string, criterionIds: string[], party: EvidenceItem["party"] = "applicant"): EvidenceItem {
  return { key, title, party, criterionIds, source: { quote: "q", sourceId: "s", url: "https://example.test/doc", contentHash: "h", retrievedAt: "2026-11-01T00:00:00.000Z" } } as EvidenceItem;
}

/**
 * A small route with the four kinds of objective rule the issue is about:
 *  - `r-passport`: a document item names it (the passport);
 *  - `r-funds`:    a document item names it, and its value can be compared;
 *  - `r-exclusion`, `r-fee`: no document item names them (the bug's rules);
 * plus one judgement rule, so a credibility flag can be raised beside them.
 */
function smallRubric(evidenceItems: EvidenceItem[] | undefined): VisaRubric {
  const rubric = fictionalRubric({
    countryCode: "QX",
    visaTypeId: "qx-visit",
    intentPolarity: "not_assessed",
    criteria: [
      criterion({ criterionId: "r-exclusion", title: "Subject of an exclusion order", kind: "objective", stage: "suitability", severity: "critical", check: { field: "exclusionOrder", op: "present" } }),
      criterion({ criterionId: "r-fee", title: "Required fee paid", kind: "objective", stage: "validity", severity: "high", check: { field: "feePaid", op: "eq", value: true } }),
      criterion({ criterionId: "r-passport", title: "Passport establishing identity", kind: "objective", stage: "validity", severity: "high", check: { field: "identityDocument", op: "present" } }),
      criterion({ criterionId: "r-funds", title: "Funds meet the minimum", kind: "objective", stage: "eligibility", severity: "medium", check: { field: "funds.balance", op: "gte", value: 2000, unit: "GBP" } }),
      criterion({ criterionId: "r-genuine", title: "Genuine visit", kind: "judgement", stage: "credibility", severity: "low" }),
    ],
  });
  // `undefined` removes the property altogether (a rubric written before document items existed).
  if (evidenceItems === undefined) delete (rubric as any).evidenceItems;
  else rubric.evidenceItems = evidenceItems;
  return rubric;
}

/** The document items of the small route: a passport and a bank statement. */
const SMALL_ITEMS = [item("passport", "Passport", ["r-passport"]), item("bank", "Bank statement", ["r-funds"])];

/** Assemble, rank and derive actions the way the job does, for a small rubric. */
function run(rubric: VisaRubric, docs: DocumentExtraction[], judgement: JudgementOutput | null = null, facts: Facts = {}) {
  const objective = evaluateObjective(rubric, facts, docs);
  const content = assembleContent({
    rubric, mandatoryHits: [], objective, judgement, documents: docs, statementReadable: true, score: 90, suspiciousDocumentIds: [], judgementFailed: false,
  });
  const top = topIssuesOf(rubric, content);
  const { actions } = deriveProposedActions({ id: "assess-1", applicationId: "app-1", userId: "client-1", agencyId: null } as any, rubric, content);
  return { objective, content, top, actions };
}

/** A judgement answer with no findings (the stage ran and raised nothing). */
const QUIET: JudgementOutput = { findings: [], strengths: [], statementNotes: [], suspiciousPassages: [], dropped: 0, unanchored: 0 };

// ============================================
// Part 1: the rule, case by case
// ============================================

describe("#308 a missing field fails a rule only when the rulebook names a document for it", () => {
  test("missing field WITH a document item: still a refusal ground, and the detail names the document in plain words", () => {
    const { objective, content, top, actions } = run(smallRubric(SMALL_ITEMS), [doc("d1")], QUIET);

    const passport = objective.find((r) => r.criterionId === "r-passport");
    assert.equal(passport?.outcome, "fail");
    assert.equal(passport?.notAssessed, undefined);

    const ground = content.refusalGrounds.find((g) => g.criterionId === "r-passport");
    assert.ok(ground, "the passport rule is a refusal ground");
    assert.equal(ground?.detail, "We couldn't find this in your documents: Passport");
    assert.ok(!ground?.detail.includes("identityDocument"), "the raw field id is not shown");

    // It is a top issue and gets its blocking action, titled by the document item.
    assert.ok(top.some((t) => t.criterionId === "r-passport"));
    const action = actions.find((a) => a.criterionId === "r-passport");
    assert.equal(action?.blocking, true);
    assert.equal(action?.origin, "refusal_ground");
    assert.equal(action?.title, "Passport");
    assert.equal(content.readiness, "not_ready");
  });

  test("the detail lists every document item that names the rule, the applicant's own first", () => {
    const rubric = smallRubric([item("sponsor-letter", "Sponsor's letter", ["r-passport"], "sponsor" as any), item("passport", "Passport", ["r-passport"]), item("passport-copy", "Passport", ["r-passport"])]);
    const passport = evaluateObjective(rubric, {}, [doc("d1")]).find((r) => r.criterionId === "r-passport");
    assert.equal(passport?.reason, "We couldn't find this in your documents: Passport; Sponsor's letter");
  });

  test("missing field with NO document item: not a refusal ground; stored with the new marker", () => {
    const { objective, content } = run(smallRubric(SMALL_ITEMS), [doc("d1")], QUIET);

    for (const id of ["r-exclusion", "r-fee"]) {
      const r = objective.find((o) => o.criterionId === id);
      assert.equal(r?.outcome, "insufficient", `${id} is not a fail`);
      assert.equal(r?.notAssessed, "not_in_documents");
      assert.ok(!content.refusalGrounds.some((g) => g.criterionId === id), `${id} is not a refusal ground`);
      const stored = content.insufficientInformation.find((i) => i.criterionId === id);
      assert.equal(stored?.notAssessed, "not_in_documents");
      assert.equal(stored?.reason, NOT_CHECKABLE_REASON);
    }
  });

  test("items with the new marker are not top issues and create no proposed action of any kind", () => {
    const { top, actions } = run(smallRubric(SMALL_ITEMS), [doc("d1")], QUIET);
    // `r-exclusion` is the most severe rule of the route (critical): before #308 it led the top three.
    assert.deepEqual(top.map((t) => t.criterionId), ["r-passport", "r-funds"]);
    assert.deepEqual(actions.map((a) => a.criterionId).sort(), ["r-funds", "r-passport"]);
    assert.ok(!actions.some((a) => a.criterionId === "r-exclusion" || a.criterionId === "r-fee"));
  });

  test("items with the new marker do not lower the readiness band or the confidence", () => {
    // Passport and funds are both read and pass, so the ONLY open items are the
    // two rules no document item names. Score 90 must still read "strong".
    const docs = [doc("d1", [{ field: "identityDocument", value: "P1234567" }, { field: "funds.balance", value: 5000, unit: "GBP" }])];
    const { content, top, actions } = run(smallRubric(SMALL_ITEMS), docs, QUIET);

    assert.deepEqual(content.refusalGrounds, []);
    assert.deepEqual(content.insufficientInformation.map((i) => [i.criterionId, i.notAssessed]), [["r-exclusion", "not_in_documents"], ["r-fee", "not_in_documents"]]);
    assert.equal(content.readiness, "strong", "the band is not capped by rules nobody can evidence");
    assert.equal(content.confidence, "high");
    assert.equal(content.internalCall, "would_approve");
    assert.equal(content.stageOutcomes.objective, "clear", "the stage is read from the checks that were made");
    assert.deepEqual(top, []);
    assert.deepEqual(actions, []);
  });

  test("an ordinary 'could not be read' item still caps the band and gets its action (contrast)", () => {
    // The passport field was listed by the document with no readable value:
    // the applicant can re-upload, so this item stays unmarked and counts.
    const docs = [doc("d1", [{ field: "identityDocument", value: null }, { field: "funds.balance", value: 5000, unit: "GBP" }])];
    const { content, top, actions } = run(smallRubric(SMALL_ITEMS), docs, QUIET);
    const stored = content.insufficientInformation.find((i) => i.criterionId === "r-passport");
    assert.equal(stored?.notAssessed, undefined);
    assert.equal(content.readiness, "competitive");
    assert.equal(content.confidence, "medium");
    assert.deepEqual(top.map((t) => t.criterionId), ["r-passport"]);
    assert.deepEqual(actions.map((a) => [a.criterionId, a.origin, a.blocking]), [["r-passport", "insufficient_information", true]]);
  });

  test("a value that WAS read and fails its comparison is still a refusal ground with its blocking action", () => {
    // Funds below the minimum: read from a document, compared by code, failed.
    const docs = [doc("d1", [{ field: "identityDocument", value: "P1234567" }, { field: "funds.balance", value: 500, unit: "GBP" }])];
    const { objective, content, top, actions } = run(smallRubric(SMALL_ITEMS), docs, QUIET);
    assert.equal(objective.find((r) => r.criterionId === "r-funds")?.outcome, "fail");
    assert.deepEqual(content.refusalGrounds.map((g) => g.criterionId), ["r-funds"]);
    assert.equal(content.refusalGrounds[0].detail, "funds.balance compared");
    assert.equal(content.readiness, "not_ready");
    assert.deepEqual(top.map((t) => t.criterionId), ["r-funds"]);
    assert.deepEqual(actions.map((a) => [a.criterionId, a.origin, a.blocking]), [["r-funds", "refusal_ground", true]]);
  });

  test("a read value fails its comparison even when NO document item names the rule", () => {
    // `feePaid: false` was read from a document. Only the "field missing" path
    // depends on document items: a value that was read is compared as before.
    const docs = [doc("d1", [{ field: "feePaid", value: false }])];
    const { content } = run(smallRubric([]), docs, QUIET);
    assert.deepEqual(content.refusalGrounds.map((g) => g.criterionId), ["r-fee"]);
    assert.equal(content.readiness, "not_ready");
  });

  test("a rubric with no evidenceItems at all: every missing field gets the new marker, none fails", () => {
    for (const items of [[] as EvidenceItem[], undefined]) {
      const { objective, content, top, actions } = run(smallRubric(items), [doc("d1")], QUIET);
      assert.equal(objective.length, 4);
      assert.ok(objective.every((r) => r.outcome === "insufficient" && r.notAssessed === "not_in_documents"), "every missing field is marked");
      assert.deepEqual(content.refusalGrounds, []);
      assert.equal(content.insufficientInformation.length, 4);
      assert.ok(content.insufficientInformation.every((i) => i.notAssessed === "not_in_documents"));
      assert.deepEqual(top, []);
      assert.deepEqual(actions, []);
      assert.equal(content.readiness, "strong");
      assert.equal(content.stageOutcomes.objective, "not_applicable", "nothing was checked, so the stage does not read clear");
    }
  });

  test("an unreadable upload does not turn rules without a document item into evidence requests", () => {
    // One of two documents could not be read. Before #308 every missing field
    // became an unmarked "could not be read" item with a blocking action.
    const docs = [doc("d1"), doc("d2", [], { readable: false })];
    const { objective, actions, top } = run(smallRubric(SMALL_ITEMS), docs, QUIET);
    assert.equal(objective.find((r) => r.criterionId === "r-exclusion")?.notAssessed, "not_in_documents");
    // The rules a document item names are unmarked "could not be read" (never a fail on a partial read).
    const passport = objective.find((r) => r.criterionId === "r-passport");
    assert.deepEqual([passport?.outcome, passport?.notAssessed], ["insufficient", undefined]);
    assert.deepEqual(actions.map((a) => a.criterionId).sort(), ["r-funds", "r-passport"]);
    assert.deepEqual(top.map((t) => t.criterionId), ["r-passport", "r-funds"]);
  });

  test("the marker helper: only no_trigger and not_in_documents are left out of the band", () => {
    assert.equal(isNotActionableMarker("no_trigger"), true);
    assert.equal(isNotActionableMarker("not_in_documents"), true);
    assert.equal(isNotActionableMarker("unanswered"), false);
    assert.equal(isNotActionableMarker("missing_fact"), false);
    assert.equal(isNotActionableMarker(undefined), false);
  });
});

describe("#308 mandatory bars and judgement flags are unchanged", () => {
  test("a mandatory bar that applies is still a refusal ground and still blocks", () => {
    const rubric = smallRubric(SMALL_ITEMS);
    rubric.criteria.push(criterion({ criterionId: "r-bar", title: "Nationality bar", kind: "mandatory_bar", stage: "suitability", severity: "critical", appliesTo: { nationalities: ["QA"], asWritten: ["Qatari"] } } as any));
    const bars = decideMandatoryBars(rubric, { nationalities: ["QA"], residentialCountry: null, heldDocuments: null }, "2026-11-14");
    assert.deepEqual(bars.hits.map((c) => c.criterionId), ["r-bar"]);
    const content = assembleContent({ rubric, mandatoryHits: bars.hits, objective: [], judgement: null, documents: [], statementReadable: false, score: 90, suspiciousDocumentIds: [], judgementFailed: false });
    assert.deepEqual(content.refusalGrounds.map((g) => [g.criterionId, g.isMandatoryBar, g.detail]), [["r-bar", true, "A mandatory bar applies to this applicant."]]);
    assert.equal(content.hasBlockingRule, true);
    assert.equal(content.readiness, "not_ready");
    assert.equal(content.stageOutcomes.mandatoryBar, "hit");
  });

  test("a judgement concern is still a credibility flag (never a refusal), a top issue, with its non-blocking action", () => {
    const judgement: JudgementOutput = { ...QUIET, findings: [{ criterionId: "r-genuine", detail: "The itinerary is thin.", whatWouldHelp: "Add a day-by-day plan.", concern: true }] };
    const docs = [doc("d1", [{ field: "identityDocument", value: "P1234567" }, { field: "funds.balance", value: 5000, unit: "GBP" }])];
    const { content, top, actions } = run(smallRubric(SMALL_ITEMS), docs, judgement);
    assert.deepEqual(content.credibilityFlags.map((f) => f.criterionId), ["r-genuine"]);
    assert.deepEqual(content.refusalGrounds, []);
    assert.equal(content.stageOutcomes.judgement, "concern");
    assert.equal(content.readiness, "competitive", "a flag caps the band below strong, as before");
    assert.deepEqual(top.map((t) => t.criterionId), ["r-genuine"]);
    assert.deepEqual(actions.map((a) => [a.criterionId, a.origin, a.blocking]), [["r-genuine", "credibility_flag", false]]);
  });
});

// ============================================
// Part 2: the real rulebook and application (fixture)
// ============================================
//
// `fixtures/uk-standard-visitor-v2-308.json` is a read-only copy of the UK
// Standard Visitor rulebook v2 as served on dev (409 rules, 9 document items,
// 65 questions), the intake answers of QA application wyPrIGfPVSMs8VbPivs9, and
// the numbers its stored assessment 607619bc... recorded before the fix. The
// replay below is the job's own sequence (services/ai-case-officer.service.ts
// `execute`, the same calls the bulk path makes) without the model calls:
//   - the documents are the application's two uploads, read cleanly, with none
//     of the checked fields in them (what the stored result shows: every
//     applicable objective rule read "<field> is not in the documents");
//   - the judgement answer raises a concern on the same rule ids the stored
//     assessment flagged (ids only; no model text is copied).

/** Words that name the rule families the issue says must not surface to the applicant. */
const NOT_FOR_APPLICANT = /exclusion|excluded|deport|fee|biometric|specified form|foster|marriage|civil partnership|transit|replacement passport|NHS/i;

/** Replay the stored inputs through the engine as the job does. */
function replayFixture(): { rubric: VisaRubric; content: AssessmentContent; top: ReturnType<typeof topIssuesOf>; actions: ReturnType<typeof deriveProposedActions>["actions"] } {
  const fullRubric = fixture.rubric as unknown as VisaRubric;
  const facts = fixture.applicantFacts as any;
  // Which rules apply to this applicant (unchanged by #308).
  const split = splitByApplicability(fullRubric, fixture.intakeAnswers as Record<string, unknown>, { facts, onDate: fixture.barDate });
  const rubric = { ...fullRubric, criteria: split.applicable } as VisaRubric;
  const bars = decideMandatoryBars(rubric, facts, fixture.barDate, {});
  const notAssessed = [...notAssessedItems(split), ...barNotAssessedItems(bars.unknown)];
  // The uploads: read cleanly, none of the checked fields in them.
  const docs = Array.from({ length: fixture.documentsUploaded }, (_, i) => doc(`d${i + 1}`));
  const intakeFacts: Facts = Object.fromEntries(Object.entries(fixture.intakeAnswers).map(([k, v]) => [`intake.${k}`, v as Facts[string]]));
  const objective = evaluateObjective(rubric, intakeFacts, docs);
  const judgement: JudgementOutput = { ...QUIET, findings: fixture.concernCriterionIds.map((criterionId) => ({ criterionId, detail: "A concern (fixture).", whatWouldHelp: "Add supporting evidence.", concern: true })) };
  const content = assembleContent({
    rubric, mandatoryHits: bars.hits, objective, judgement, documents: docs, statementReadable: true, score: fixture.before.score, suspiciousDocumentIds: [], judgementFailed: false, notAssessed,
  });
  const top = topIssuesOf(fullRubric, content);
  const { actions } = deriveProposedActions({ id: "assess-308", applicationId: "app-308", userId: "client-308", agencyId: null } as any, fullRubric, content);
  return { rubric: fullRubric, content, top, actions };
}

describe("#308 UK Standard Visitor v2, application wyPrIGfPVSMs8VbPivs9 (fixture)", () => {
  test("the fixture is the rulebook the issue describes", () => {
    const { criteria, evidenceItems } = fixture.rubric;
    const objective = criteria.filter((c) => c.kind === "objective");
    const named = new Set(evidenceItems.flatMap((e) => e.criterionIds));
    assert.equal(fixture.rubric.version, 2);
    assert.equal(criteria.length, 409);
    assert.equal(objective.length, 73);
    assert.equal(objective.filter((c) => named.has(c.criterionId)).length, 2, "71 of 73 objective rules have no document item");
    assert.equal(objective.filter((c) => (c as any).check?.field.startsWith("intake.")).length, 0, "no objective check reads an intake answer");
    // What the stored assessment recorded BEFORE the fix.
    assert.equal(fixture.before.refusalGroundIds.length, 35);
    assert.equal(fixture.before.refusalGroundDetailsAllFieldMissing, true);
    assert.equal(fixture.before.proposedActions.blocking, 35);
  });

  test("refusal grounds are only the passport and the financial-evidence rules", () => {
    const { content } = replayFixture();
    assert.deepEqual(
      content.refusalGrounds.map((g) => [g.title, g.detail]),
      [
        ["Most recent financial evidence dated within 31 days before application", "We couldn't find this in your documents: Financial evidence (most recent dated within 31 days of application)"],
        ["Passport or identity document establishing identity and nationality", "We couldn't find this in your documents: Passport or identity document"],
      ]
    );
    // Both were refusal grounds before too: nothing new is raised.
    for (const g of content.refusalGrounds) assert.ok(fixture.before.refusalGroundIds.includes(g.criterionId));
  });

  test("the other 33 former refusal grounds are stored as not checkable from documents", () => {
    const { content } = replayFixture();
    const kept = new Set(content.refusalGrounds.map((g) => g.criterionId));
    const moved = fixture.before.refusalGroundIds.filter((id) => !kept.has(id));
    assert.equal(moved.length, 33);
    for (const id of moved) {
      const stored = content.insufficientInformation.filter((i) => i.criterionId === id);
      assert.equal(stored.length, 1, `${id} is stored once`);
      assert.equal(stored[0].notAssessed, "not_in_documents");
    }
    // The rest of the list is exactly what it was: 172 + 10 + 2.
    const byMarker: Record<string, number> = {};
    for (const i of content.insufficientInformation) byMarker[i.notAssessed ?? "none"] = (byMarker[i.notAssessed ?? "none"] ?? 0) + 1;
    assert.deepEqual(byMarker, { ...fixture.before.insufficientByMarker, not_in_documents: 33 });
  });

  test("no top issue names an exclusion, deportation, fee, biometrics, form, foster-care, marriage, transit, replacement-passport or NHS rule", () => {
    const { top, content } = replayFixture();
    // Before: the three exclusion / deportation rules.
    assert.ok(fixture.before.topIssues.every((t) => NOT_FOR_APPLICANT.test(t.title)));
    assert.equal(top.length, 3);
    for (const t of top) assert.ok(!NOT_FOR_APPLICANT.test(t.title), `top issue "${t.title}" must not be shown`);
    // The ranking itself is untouched (rubric severity, then rubric order,
    // over grounds and flags together), so three "critical" credibility flags
    // now lead; the two real grounds are "high" and rank just below them.
    const flagged = new Set(content.credibilityFlags.map((f) => f.criterionId));
    assert.ok(top.every((t) => flagged.has(t.criterionId)));
    assert.deepEqual(top.map((t) => t.title), [
      "Genuine visitor assessment of circumstances, purpose, travel history, compliance and funds",
      "Funds not considered where institution cannot be satisfactorily verified",
      "Funds not considered where institution is not regulated",
    ]);
  });

  test("blocking actions are only the two real grounds; none for a rule that cannot be checked", () => {
    const { content, actions } = replayFixture();
    const blocking = actions.filter((a) => a.blocking);
    assert.deepEqual(blocking.map((a) => [a.title, a.origin]), [
      ["Financial evidence (most recent dated within 31 days of application)", "refusal_ground"],
      ["Passport or identity document", "refusal_ground"],
    ]);
    // No action of ANY kind for an item with a marker.
    const marked = new Set(content.insufficientInformation.filter((i) => i.notAssessed).map((i) => i.criterionId));
    const flagged = new Set(content.credibilityFlags.map((f) => f.criterionId));
    for (const a of actions) {
      assert.ok(a.origin !== "insufficient_information", "no action is made from a could-not-assess item here");
      if (!flagged.has(a.criterionId)) assert.ok(!marked.has(a.criterionId), `no action for marked rule ${a.criterionId}`);
    }
    // Every other action is a non-blocking one from a credibility flag, as before.
    assert.ok(actions.filter((a) => !a.blocking).every((a) => a.origin === "credibility_flag"));
    assert.equal(blocking.length + actions.filter((a) => !a.blocking).length, actions.length);
  });

  test("readiness is still not_ready, and credibility flags are untouched", () => {
    const { content } = replayFixture();
    assert.equal(content.readiness, "not_ready");
    assert.equal(content.internalCall, "would_refuse");
    assert.equal(content.stageOutcomes.objective, "fail");
    assert.equal(content.hasBlockingRule, false);
    assert.equal(content.credibilityFlags.length, fixture.before.credibilityFlagCount);
    // Confidence stays low: 12 rules still wait on an answer or a fact of the applicant's.
    assert.equal(content.confidence, fixture.before.confidence);
  });
});
