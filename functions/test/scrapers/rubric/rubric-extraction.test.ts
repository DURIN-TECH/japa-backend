// ============================================
// Rubric extraction (issue #40) — unit tests, no network, no model, no emulator
// ============================================
//
// Drives RubricExtractionService end to end over:
//  - snapshots stored by the REAL guidance snapshot store (in-memory bucket);
//  - the in-memory Firestore fake;
//  - a RecordedLlmProvider replaying HAND-WRITTEN model answers by request
//    hash. No live model call is ever made (there is no key in CI or here).
//
// The documents are synthetic (fixtures/synthetic-guidance.ts): two invented
// routes in two invented jurisdictions, one web page and one PDF, with
// opposite intent polarity. No real rule is committed.

import { before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { Timestamp } from "firebase-admin/firestore";
import { resetStore, store } from "../../helpers/fake-firestore";
import { RubricStoreError, type RubricDraft } from "../../../src/scrapers/rubric/rubric.store";
import { RUBRIC_SYSTEM_PROMPT, delimiterTag } from "../../../src/scrapers/rubric/rubric-prompt";
import { criterionIdOf, sourceSetHashOf } from "../../../src/scrapers/rubric/rubric-extraction.service";
import type { RawRubricOutput } from "../../../src/scrapers/rubric/rubric-prompt";
import type { AssessmentCriterion, VisaRubric } from "../../../src/types/rubric";
import {
  A_LINES,
  A_TEXT,
  A_TEXT_INJECTED,
  B_PAGES,
  B_QUOTES,
  INJECTED_LINE,
  ROUTE_A,
  ROUTE_B,
  SOURCE_A_ID,
  SOURCE_A_PUBLISHED,
  SOURCE_A_URL,
  SOURCE_B_ID,
  SOURCE_B_PUBLISHED,
  SOURCE_B_URL,
} from "./fixtures/synthetic-guidance";
import {
  RECORDED_USAGE,
  T0,
  answer,
  crit,
  headDoc,
  installRubricFakes,
  makeHarness,
  quiet,
  recordAnswers,
  resetBucket,
  runDocs,
  seedSource,
  versionDoc,
  versionPaths,
  type Harness,
} from "./rubric-harness";

/* eslint-disable @typescript-eslint/no-explicit-any */

const KEY_A = `${ROUTE_A.countryCode}_${ROUTE_A.visaTypeId}`;
const KEY_B = `${ROUTE_B.countryCode}_${ROUTE_B.visaTypeId}`;

/** Strip the leading paragraph reference ("SV 2.1 ") from a fixture line. */
const body = (line: string) => line.replace(/^[A-Z]+ [\d.]+ /, "");

/** A faithful hand-written answer for route A's page. */
function routeAAnswer(): RawRubricOutput {
  return answer({
    criteria: [
      crit({ ref: "valid", title: "Fee paid and passport provided", kind: "objective", stage: "validity", severity: "critical", ruleRef: "SV 1.1", quote: body(A_LINES.validity), check: { field: "application.feePaid", op: "present", value: null, unit: null } }),
      crit({ ref: "age", title: "Aged 18 or over", kind: "objective", ruleRef: "SV 2.1", quote: body(A_LINES.age), check: { field: "applicant.age", op: "gte", value: 18, unit: null } }),
      crit({ ref: "held", title: "Funds held for 28 days", kind: "objective", ruleRef: "SV 2.2", quote: body(A_LINES.held), check: { field: "funds.balance", op: "heldForDays", value: 28, unit: "days" } }),
      crit({
        ref: "leave",
        title: "Will leave at the end of the visit",
        kind: "judgement",
        stage: "credibility",
        ruleRef: "SV 3.1",
        quote: "The decision maker must be satisfied that the applicant will leave Avalen at the end of the visit.",
        concernsIntent: true,
        probeFactors: ["ties outside the destination", "previous travel"],
        requiresInterviewBeforeRefusal: false,
      }),
      crit({
        ref: "funds",
        title: "Can meet the reasonable costs of the visit",
        kind: "judgement",
        ruleRef: "SV 3.2",
        quote: "The decision maker must consider whether the applicant can meet the reasonable costs of the visit, having regard to their income and their planned spending.",
        probeFactors: ["income", "planned spending"],
        requiresInterviewBeforeRefusal: false,
      }),
      crit({
        ref: "bar",
        title: "Nationals refused from a stated date",
        kind: "mandatory_bar",
        stage: "suitability",
        severity: "critical",
        ruleRef: "SV 4.1",
        quote: body(A_LINES.bar),
        appliesTo: { nationalities: ["QM", "QN"], asWritten: ["Borduria", "Syldavia"] },
        validFrom: "2026-03-26",
      }),
    ],
    intentPolarity: { value: "immigrant_intent_penalised", quote: "An intention to remain beyond the visit counts against the applicant." },
    intake: { title: "About your visit", cardTitle: "Your visit", intro: null },
    intakeQuestions: [
      { id: "return_date", label: "When will you leave?", helpText: null, answerType: "date", required: true, criterionRefs: ["leave"], group: "Trip", party: null, options: [], textMaxLength: null, dateRelativeToToday: "future_only", showWhenAnyOf: [] },
      { id: "has_sponsor", label: "Is someone else paying for the visit?", helpText: null, answerType: "yes_no", required: true, criterionRefs: ["funds"], group: "Money", party: null, options: [], textMaxLength: null, dateRelativeToToday: null, showWhenAnyOf: [] },
      { id: "sponsor_full_name", label: "Sponsor's full name", helpText: null, answerType: "text", required: false, criterionRefs: ["funds"], group: "Money", party: "sponsor", options: [], textMaxLength: 120, dateRelativeToToday: null, showWhenAnyOf: [{ questionId: "has_sponsor", op: "eq", value: true }] },
    ],
    evidenceItems: [
      { key: "sponsor-bank-statements", title: "Sponsor's bank statements", party: "sponsor", criterionRefs: ["funds"], quote: body(A_LINES.sponsor), documentType: "bank_statement", fields: ["accountHolder", "balance"] },
    ],
  });
}

/** Seed route A's page and record `out` as its answer. */
async function setUpRouteA(h: Harness, out: RawRubricOutput | string = routeAAnswer(), text = A_TEXT): Promise<string> {
  h.state.knownVisaTypes.add(`${ROUTE_A.countryCode}/${ROUTE_A.visaTypeId}`);
  const hash = await seedSource({ id: SOURCE_A_ID, url: SOURCE_A_URL, text, publishedDate: SOURCE_A_PUBLISHED });
  await recordAnswers(h.provider, SOURCE_A_ID, [out]);
  return hash;
}

/** Extract route A (first run names its source). */
const runA = (h: Harness, extra: Record<string, unknown> = {}) =>
  quiet(() => h.service.extractRoute({ ...ROUTE_A, sourceIds: [SOURCE_A_ID], ...extra }));

/** The stored criterion with this title. */
const byTitle = (rubric: VisaRubric, title: string) => rubric.criteria.find((c) => c.title === title) as AssessmentCriterion;

let h: Harness;

before(installRubricFakes);

beforeEach(() => {
  resetStore();
  resetBucket();
  h = makeHarness();
});

// ============================================
// A web page: the whole path
// ============================================

describe("rubric extraction: a web-page source", () => {
  test("writes version 1 as pending_review with every criterion cited to the snapshot", async () => {
    const hash = await setUpRouteA(h);
    const { result } = await runA(h);

    assert.equal(result.status, "succeeded");
    assert.equal(result.version, 1);
    assert.equal(result.criteriaAccepted, 6);
    assert.equal(result.discardedCount, 0);

    const rubric = versionDoc(KEY_A, 1) as VisaRubric;
    assert.equal(rubric.reviewStatus, "pending_review");
    assert.equal(rubric.routeKey, KEY_A);
    assert.equal(rubric.version, 1);
    assert.deepEqual(rubric.severityLevels, ["critical", "high", "medium", "low"]);
    assert.equal(rubric.criteria.length, 6);

    // Every criterion: verbatim quote, URL, the hash it was validated
    // against, when that snapshot was fetched, the publisher's date.
    for (const c of rubric.criteria) {
      assert.ok(A_TEXT.includes(c.source.quote), `quote of "${c.title}" is in the source`);
      assert.equal(c.source.url, SOURCE_A_URL);
      assert.equal(c.source.sourceId, SOURCE_A_ID);
      assert.equal(c.source.contentHash, hash);
      assert.equal(c.source.retrievedAt, new Date(T0 - 3_600_000).toISOString());
      assert.equal(c.source.publishedDate, SOURCE_A_PUBLISHED);
      assert.equal(c.source.page, undefined, "a web page has no page number");
      assert.match(c.criterionId, /^crit_[a-f0-9]{16}$/);
      assert.ok(c.title.length > 0);
    }

    // Kinds carry what their kind needs, and only that.
    const age = byTitle(rubric, "Aged 18 or over");
    assert.deepEqual(age.check, { field: "applicant.age", op: "gte", value: 18 });
    assert.equal(age.ruleRef, "SV 2.1");
    assert.deepEqual(byTitle(rubric, "Funds held for 28 days").check, { field: "funds.balance", op: "heldForDays", value: 28, unit: "days" });
    assert.deepEqual(byTitle(rubric, "Fee paid and passport provided").check, { field: "application.feePaid", op: "present" });
    const leave = byTitle(rubric, "Will leave at the end of the visit");
    assert.equal(leave.kind, "judgement");
    assert.equal(leave.check, undefined);
    assert.deepEqual(leave.probeFactors, ["ties outside the destination", "previous travel"]);
    assert.equal(leave.requiresInterviewBeforeRefusal, false);
    assert.equal(leave.concernsIntent, true);
    // "No set level of funds" -> a judgement criterion, never a threshold.
    const funds = byTitle(rubric, "Can meet the reasonable costs of the visit");
    assert.equal(funds.kind, "judgement");
    assert.equal(funds.check, undefined);
    // A nationality-scoped bar round-trips with its dates and its wording.
    const bar = byTitle(rubric, "Nationals refused from a stated date");
    assert.deepEqual(bar.appliesTo, { nationalities: ["QM", "QN"], asWritten: ["Borduria", "Syldavia"] });
    assert.equal(bar.validFrom, "2026-03-26");
    assert.equal(bar.stage, "suitability");

    // Intake questions and evidence point at the STABLE criterion ids.
    assert.deepEqual(rubric.intake, { title: "About your visit", cardTitle: "Your visit" });
    assert.deepEqual(rubric.intakeQuestions.map((q) => q.id), ["return_date", "has_sponsor", "sponsor_full_name"]);
    assert.deepEqual(rubric.intakeQuestions[0].criterionIds, [leave.criterionId]);
    assert.deepEqual(rubric.intakeQuestions[0].dateLimits, { relativeToToday: "future_only" });
    const sponsorName = rubric.intakeQuestions[2];
    assert.equal(sponsorName.party, "sponsor");
    assert.deepEqual(sponsorName.textLimits, { maxLength: 120 });
    assert.deepEqual(sponsorName.showWhen, { anyOf: [{ questionId: "has_sponsor", op: "eq", value: true }] });
    assert.deepEqual(funds.intakeQuestionIds, ["has_sponsor", "sponsor_full_name"]);
    assert.equal(rubric.evidenceItems.length, 1);
    assert.equal(rubric.evidenceItems[0].party, "sponsor");
    assert.deepEqual(rubric.evidenceItems[0].criterionIds, [funds.criterionId]);
    assert.deepEqual(rubric.evidenceItems[0].expects, { documentType: "bank_statement", fields: ["accountHolder", "balance"] });
    assert.equal(rubric.evidenceItems[0].source.contentHash, hash);
    // Never filled in by extraction.
    assert.equal(rubric.outcomeStatistics, undefined);

    // Provenance.
    assert.deepEqual(rubric.sourceSnapshots, [{ sourceId: SOURCE_A_ID, contentHash: hash, url: SOURCE_A_URL, docType: "html", publishedDate: SOURCE_A_PUBLISHED }]);
    assert.equal(rubric.sourceSetHash, sourceSetHashOf([{ sourceId: SOURCE_A_ID, contentHash: hash }]));
    assert.equal(rubric.extractorModel, "recorded-model");
    assert.equal(rubric.extractorPromptVersion, "2026-11-rubric-v1");
  });

  test("the polarity is stored as a cited PROPOSAL; the decision stays empty for the admin", async () => {
    await setUpRouteA(h);
    await runA(h);
    const rubric = versionDoc(KEY_A, 1) as VisaRubric;
    assert.equal(rubric.intentPolarity, null);
    assert.equal(rubric.intentPolarityProposal?.value, "immigrant_intent_penalised");
    assert.equal(rubric.intentPolarityProposal?.source?.quote, "An intention to remain beyond the visit counts against the applicant.");
    assert.equal(rubric.reviewedBy, null);
    assert.equal(rubric.reviewedAt, null);
    assert.equal(rubric.revision, 0);
  });

  test("criteria about intent with no cited polarity: the stored version is flagged for the reviewer", async () => {
    const out = routeAAnswer();
    out.intentPolarity = null;
    await setUpRouteA(h, out);
    await runA(h);
    const rubric = versionDoc(KEY_A, 1) as VisaRubric;
    assert.equal(rubric.intentPolarityProposal, null);
    assert.deepEqual(rubric.flags.map((f) => f.code), ["intent_criteria_without_polarity"]);
  });

  test("the head records the newest version and leaves approvedVersion empty", async () => {
    const hash = await setUpRouteA(h);
    await runA(h);
    const head = headDoc(KEY_A);
    assert.equal(head.latestVersion, 1);
    assert.equal(head.approvedVersion, null);
    assert.deepEqual(head.sourceIds, [SOURCE_A_ID]);
    assert.equal(head.latestSourceSetHash, sourceSetHashOf([{ sourceId: SOURCE_A_ID, contentHash: hash }]));
  });

  test("a pending version is unreadable through the consumer read", async () => {
    await setUpRouteA(h);
    await runA(h);
    assert.equal(await h.rubrics.getApprovedRubric(ROUTE_A.countryCode, ROUTE_A.visaTypeId), null);
    // The admin-review read does see it.
    assert.equal((await h.rubrics.getVersionForReview(KEY_A, 1))?.reviewStatus, "pending_review");
    // Even a head that (wrongly) points at a pending version yields nothing.
    store.set(`visaRubrics/${KEY_A}`, { ...headDoc(KEY_A), approvedVersion: 1 });
    assert.equal(await h.rubrics.getApprovedRubric(ROUTE_A.countryCode, ROUTE_A.visaTypeId), null);
  });

  test("the run is recorded with token usage and no cost (the model is unpriced)", async () => {
    await setUpRouteA(h);
    const { result } = await runA(h);
    const [run] = runDocs();
    assert.equal(run.runId, result.runId);
    assert.equal(run.status, "succeeded");
    assert.equal(run.version, 1);
    assert.deepEqual(run.usage, { requests: 1, ...RECORDED_USAGE });
    assert.equal(run.costUsd, null);
    assert.equal(run.model, "recorded-model");
    assert.equal(run.criteriaAccepted, 6);
    assert.equal(versionDoc(KEY_A, 1).extractionRunId, run.runId);
  });

  test("nothing logged contains source text", async () => {
    await setUpRouteA(h);
    const { lines } = await runA(h);
    assert.ok(lines.length > 0);
    for (const line of lines) {
      for (const sentence of Object.values(A_LINES)) assert.ok(!line.includes(body(sentence)), "a log line repeats source text");
    }
  });
});

// ============================================
// A PDF: page numbers, opposite polarity
// ============================================

describe("rubric extraction: a PDF source", () => {
  /** Seed route B and record an answer for its single chunk. */
  async function setUpRouteB(out: RawRubricOutput): Promise<string> {
    h.state.knownVisaTypes.add(`${ROUTE_B.countryCode}/${ROUTE_B.visaTypeId}`);
    const hash = await seedSource({ id: SOURCE_B_ID, url: SOURCE_B_URL, pages: B_PAGES, publishedDate: SOURCE_B_PUBLISHED });
    await recordAnswers(h.provider, SOURCE_B_ID, [out]);
    return hash;
  }
  const runB = () => quiet(() => h.service.extractRoute({ ...ROUTE_B, sourceIds: [SOURCE_B_ID] }));

  test("each criterion carries the page its quote is on, and the opposite polarity is proposed", async () => {
    await setUpRouteB(
      answer({
        criteria: [
          crit({ ref: "ties", title: "Ties, study plan and previous travel", kind: "judgement", stage: "credibility", ruleRef: "G 3", quote: B_QUOTES.tiesRewrapped, concernsIntent: true, probeFactors: ["ties to the home country", "study plan", "previous travel"], requiresInterviewBeforeRefusal: true, citations: [{ field: "requiresInterviewBeforeRefusal", quote: B_QUOTES.interview }] }),
          crit({ ref: "tuition", title: "Tuition for the first 12 months", kind: "objective", ruleRef: "G 5", quote: B_QUOTES.tuition, check: { field: "tuition.monthsCovered", op: "gte", value: 12, unit: "months" } }),
        ],
        intentPolarity: { value: "dual_intent_permitted", quote: B_QUOTES.dual },
      })
    );
    const { result } = await runB();
    assert.equal(result.status, "succeeded");
    const rubric = versionDoc(KEY_B, 1) as VisaRubric;
    const ties = byTitle(rubric, "Ties, study plan and previous travel");
    // The quote was re-wrapped by the "model": whitespace-only differences match.
    assert.equal(ties.source.page, 2);
    assert.equal(ties.requiresInterviewBeforeRefusal, true);
    assert.deepEqual(ties.citations, { requiresInterviewBeforeRefusal: B_QUOTES.interview });
    assert.equal(byTitle(rubric, "Tuition for the first 12 months").source.page, 3);
    assert.equal(rubric.intentPolarityProposal?.value, "dual_intent_permitted");
    assert.equal(rubric.intentPolarityProposal?.source?.page, 2);
    assert.equal(rubric.intentPolarity, null);
    assert.equal(rubric.sourceSnapshots[0].docType, "pdf");
  });

  test("a quote that runs across a page break is rejected", async () => {
    await setUpRouteB(
      answer({
        criteria: [
          crit({ ref: "letter", title: "Letter of acceptance", kind: "objective", quote: B_QUOTES.acrossPages, check: { field: "acceptance.letter", op: "present", value: null, unit: null } }),
          crit({ ref: "tuition", title: "Tuition for the first 12 months", kind: "objective", quote: B_QUOTES.tuition, check: { field: "tuition.monthsCovered", op: "gte", value: 12, unit: "months" } }),
        ],
      })
    );
    const { result } = await runB();
    assert.equal(result.status, "succeeded");
    assert.deepEqual(result.discardedByReason, { quote_spans_pages: 1 });
    const rubric = versionDoc(KEY_B, 1) as VisaRubric;
    assert.deepEqual(rubric.criteria.map((c) => c.title), ["Tuition for the first 12 months"]);
    assert.equal(rubric.discarded[0].reason, "quote_spans_pages");
    assert.equal(rubric.discarded[0].label, "Letter of acceptance");
  });
});

// ============================================
// Verbatim citation or reject
// ============================================

describe("rubric extraction: what the code-side validation rejects", () => {
  /** Run route A with one extra (bad) criterion next to a good one; return the discard reasons. */
  async function rejectReason(bad: ReturnType<typeof crit>): Promise<{ reasons: Record<string, number>; rubric: VisaRubric; lines: string[] }> {
    const good = crit({ ref: "age", title: "Aged 18 or over", kind: "objective", quote: body(A_LINES.age), check: { field: "applicant.age", op: "gte", value: 18, unit: null } });
    await setUpRouteA(h, answer({ criteria: [good, bad] }));
    const { result, lines } = await runA(h);
    assert.equal(result.status, "succeeded");
    const rubric = versionDoc(KEY_A, 1) as VisaRubric;
    // The bad criterion never reaches Firestore; the good one does.
    assert.deepEqual(rubric.criteria.map((c) => c.title), ["Aged 18 or over"]);
    assert.equal(rubric.discardedCount, 1);
    assert.equal(rubric.discarded[0].label, bad.title);
    return { reasons: result.discardedByReason, rubric, lines };
  }

  test("an invented quote is rejected", async () => {
    const { reasons, lines } = await rejectReason(crit({ ref: "x", title: "Invented rule", kind: "judgement", quote: "The applicant must demonstrate exceptional character to the officer.", probeFactors: ["character"], requiresInterviewBeforeRefusal: false }));
    assert.deepEqual(reasons, { quote_not_found: 1 });
    // Logged with its reason, not swallowed.
    assert.ok(lines.some((l) => l.includes("discarded criterion (quote_not_found)")));
  });

  test("a paraphrased quote is rejected (no fuzzy matching)", async () => {
    const { reasons } = await rejectReason(crit({ ref: "x", title: "Adult applicant", kind: "objective", quote: "An applicant has to be 18 years old or older on the application date.", check: { field: "applicant.age", op: "gte", value: 18, unit: null } }));
    assert.deepEqual(reasons, { quote_not_found: 1 });
  });

  test("a quote that differs only in case or punctuation is rejected", async () => {
    const { reasons } = await rejectReason(crit({ ref: "x", title: "Adult applicant", kind: "objective", quote: "an applicant must be aged 18 or over on the date of application", check: { field: "applicant.age2", op: "gte", value: 18, unit: null } }));
    assert.deepEqual(reasons, { quote_not_found: 1 });
  });

  test("an empty quote and a too-short quote are rejected", async () => {
    const empty = await rejectReason(crit({ ref: "x", title: "No quote", kind: "judgement", quote: "   ", probeFactors: ["a"], requiresInterviewBeforeRefusal: false }));
    assert.deepEqual(empty.reasons, { quote_empty: 1 });
    resetStore();
    resetBucket();
    h = makeHarness();
    const short = await rejectReason(crit({ ref: "x", title: "Tiny quote", kind: "judgement", quote: "the visit", probeFactors: ["a"], requiresInterviewBeforeRefusal: false }));
    assert.deepEqual(short.reasons, { quote_too_short: 1 });
  });

  test("an invented number is rejected: check.value must be written in the quote", async () => {
    // The quote is real ("no set level of funds"); the threshold is made up.
    const { reasons, rubric } = await rejectReason(crit({ ref: "x", title: "Minimum funds", kind: "objective", quote: "There is no set level of funds.", check: { field: "funds.balance", op: "gte", value: 5000, unit: null } }));
    assert.deepEqual(reasons, { number_not_in_quote: 1 });
    assert.match(rubric.discarded[0].detail, /5000/);
  });

  test("a real quote with an altered number is rejected", async () => {
    const { reasons } = await rejectReason(crit({ ref: "x", title: "Adult applicant", kind: "objective", quote: body(A_LINES.age), check: { field: "applicant.age", op: "gte", value: 21, unit: null } }));
    assert.deepEqual(reasons, { number_not_in_quote: 1 });
  });

  test("a duration, a unit, a date and a title number not in the quote are rejected", async () => {
    const cases: [ReturnType<typeof crit>, string][] = [
      [crit({ ref: "x", title: "Funds held", kind: "objective", quote: body(A_LINES.held), check: { field: "funds.held", op: "heldForDays", value: 90, unit: "days" } }), "number_not_in_quote"],
      [crit({ ref: "x", title: "Funds held", kind: "objective", quote: body(A_LINES.held), check: { field: "funds.held", op: "heldForDays", value: 28, unit: "months" } }), "unit_not_in_quote"],
      [crit({ ref: "x", title: "Bar from a date", kind: "mandatory_bar", quote: body(A_LINES.bar), appliesTo: { nationalities: ["QM", "QN"], asWritten: ["Borduria", "Syldavia"] }, validFrom: "2027-01-01" }), "date_not_in_quote"],
      [crit({ ref: "x", title: "Funds held for 6 months", kind: "judgement", quote: "There is no set level of funds.", probeFactors: ["income"], requiresInterviewBeforeRefusal: false }), "number_not_in_quote"],
      [crit({ ref: "x", title: "Costs of the visit", kind: "judgement", quote: "There is no set level of funds.", probeFactors: ["at least 3 payslips"], requiresInterviewBeforeRefusal: false }), "number_not_in_quote"],
    ];
    for (const [bad, reason] of cases) {
      resetStore();
      resetBucket();
      h = makeHarness();
      assert.deepEqual((await rejectReason(bad)).reasons, { [reason]: 1 }, `${bad.title} -> ${reason}`);
    }
  });

  test("a rule reference the document does not print, and a group it does not name, are rejected", async () => {
    const ref = await rejectReason(crit({ ref: "x", title: "Costs of the visit", kind: "judgement", ruleRef: "SV 9.9", quote: "There is no set level of funds.", probeFactors: ["income"], requiresInterviewBeforeRefusal: false }));
    assert.deepEqual(ref.reasons, { rule_ref_not_in_source: 1 });
    resetStore();
    resetBucket();
    h = makeHarness();
    const group = await rejectReason(crit({ ref: "x", title: "Wider bar", kind: "mandatory_bar", quote: body(A_LINES.bar), appliesTo: { nationalities: ["QM", "QN", "QO"], asWritten: ["Borduria", "Syldavia", "Ruritania"] } }));
    assert.deepEqual(group.reasons, { applies_to_not_in_quote: 1 });
  });

  test("a supporting citation that is not in the source rejects the criterion", async () => {
    const { reasons } = await rejectReason(crit({ ref: "x", title: "Minimum funds", kind: "objective", quote: "There is no set level of funds.", check: { field: "funds.balance", op: "gte", value: 5000, unit: null }, citations: [{ field: "check.value", quote: "Applicants should hold at least 5000 in savings." }] }));
    assert.deepEqual(reasons, { citation_not_found: 1 });
  });

  test("kind boundaries: a judgement with a check, an objective without one, a bar without a group", async () => {
    const cases = [
      crit({ ref: "x", title: "Costs with a check", kind: "judgement", quote: "There is no set level of funds.", probeFactors: ["income"], requiresInterviewBeforeRefusal: false, check: { field: "funds.balance", op: "present", value: null, unit: null } }),
      crit({ ref: "x", title: "Objective, no check", kind: "objective", quote: "There is no set level of funds." }),
      crit({ ref: "x", title: "Bar, no group", kind: "mandatory_bar", quote: body(A_LINES.bar) }),
      crit({ ref: "x", title: "Judgement, no factors", kind: "judgement", quote: "There is no set level of funds.", requiresInterviewBeforeRefusal: false }),
    ];
    for (const bad of cases) {
      resetStore();
      resetBucket();
      h = makeHarness();
      const { reasons } = await rejectReason(bad);
      assert.deepEqual(reasons, { invalid_shape: 1 }, bad.title);
    }
  });

  test("a quote drawn from a different source document in the same batch is rejected", async () => {
    // One route, two sources. The answer for source A quotes a sentence that
    // is only in source B (and the other way round would fail the same way).
    h.state.knownVisaTypes.add(`${ROUTE_A.countryCode}/${ROUTE_A.visaTypeId}`);
    await seedSource({ id: SOURCE_A_ID, url: SOURCE_A_URL, text: A_TEXT });
    await seedSource({ id: SOURCE_B_ID, url: SOURCE_B_URL, pages: B_PAGES });
    await recordAnswers(h.provider, SOURCE_A_ID, [
      answer({
        criteria: [
          crit({ ref: "age", title: "Aged 18 or over", kind: "objective", quote: body(A_LINES.age), check: { field: "applicant.age", op: "gte", value: 18, unit: null } }),
          crit({ ref: "x", title: "Tuition from the other document", kind: "objective", quote: B_QUOTES.tuition, check: { field: "tuition.monthsCovered", op: "gte", value: 12, unit: "months" } }),
        ],
      }),
    ]);
    await recordAnswers(h.provider, SOURCE_B_ID, [
      answer({ criteria: [crit({ ref: "tuition", title: "Tuition for the first 12 months", kind: "objective", quote: B_QUOTES.tuition, check: { field: "tuition.monthsCovered", op: "gte", value: 12, unit: "months" } })] }),
    ]);
    const { result } = await quiet(() => h.service.extractRoute({ ...ROUTE_A, sourceIds: [SOURCE_B_ID, SOURCE_A_ID] }));
    assert.equal(result.status, "succeeded");
    assert.deepEqual(result.discardedByReason, { quote_not_found: 1 });
    const rubric = versionDoc(KEY_A, 1) as VisaRubric;
    // Each surviving criterion is cited to the document it is really in.
    assert.deepEqual(
      rubric.criteria.map((c) => [c.title, c.source.sourceId]),
      [["Aged 18 or over", SOURCE_A_ID], ["Tuition for the first 12 months", SOURCE_B_ID]]
    );
    assert.equal(rubric.sourceSnapshots.length, 2);
  });

  test("an intake question or evidence item whose criteria were all rejected goes with them", async () => {
    await setUpRouteA(
      h,
      answer({
        criteria: [
          crit({ ref: "age", title: "Aged 18 or over", kind: "objective", quote: body(A_LINES.age), check: { field: "applicant.age", op: "gte", value: 18, unit: null } }),
          crit({ ref: "ghost", title: "Invented rule", kind: "judgement", quote: "A sentence that is nowhere in the document at all.", probeFactors: ["x"], requiresInterviewBeforeRefusal: false }),
        ],
        intakeQuestions: [
          { id: "ghost_q", label: "Asked for the invented rule", helpText: null, answerType: "text", required: true, criterionRefs: ["ghost"], group: null, party: null, options: [], textMaxLength: null, dateRelativeToToday: null, showWhenAnyOf: [] },
          { id: "dob", label: "Date of birth", helpText: null, answerType: "date", required: true, criterionRefs: ["age", "ghost"], group: null, party: null, options: [], textMaxLength: null, dateRelativeToToday: "past_only", showWhenAnyOf: [] },
        ],
        evidenceItems: [
          { key: "ghost-doc", title: "Document for the invented rule", party: "applicant", criterionRefs: ["ghost"], quote: body(A_LINES.sponsor), documentType: null, fields: [] },
          { key: "made-up-doc", title: "A document the source never names", party: "applicant", criterionRefs: ["age"], quote: "Applicants must also provide a certificate of good standing.", documentType: null, fields: [] },
        ],
      })
    );
    const { result } = await runA(h);
    assert.deepEqual(result.discardedByReason, { quote_not_found: 2, unresolved_reference: 2 });
    const rubric = versionDoc(KEY_A, 1) as VisaRubric;
    assert.deepEqual(rubric.intakeQuestions.map((q) => q.id), ["dob"]);
    assert.deepEqual(rubric.intakeQuestions[0].criterionIds, [rubric.criteria[0].criterionId]);
    assert.deepEqual(rubric.evidenceItems, []);
  });

  test("when no criterion survives, the run fails and nothing is written", async () => {
    await setUpRouteA(h, answer({ criteria: [crit({ ref: "x", title: "Invented", kind: "judgement", quote: "A sentence that is nowhere in the document at all.", probeFactors: ["x"], requiresInterviewBeforeRefusal: false })] }));
    const { result } = await runA(h);
    assert.equal(result.status, "failed");
    assert.equal(result.reasonCode, "no_criteria_accepted");
    assert.equal(result.discardedCount, 1);
    assert.deepEqual(versionPaths(), []);
    assert.equal(headDoc(KEY_A), undefined);
    // The failed run is still recorded: it cost tokens.
    assert.equal(runDocs()[0].status, "failed");
    assert.equal(runDocs()[0].usage.requests, 1);
  });
});

// ============================================
// Source text is untrusted
// ============================================

describe("rubric extraction: a document that carries instructions", () => {
  test("the source text is sent as delimited data, with the data-only rule in the system prompt", async () => {
    const hash = await setUpRouteA(h, routeAAnswer(), A_TEXT_INJECTED);
    await runA(h);
    const [request] = h.provider.requests;
    const tag = delimiterTag(hash);
    // Paragraphs are separated by a blank line inside the delimiters.
    assert.ok(request.user.includes(`<${tag}>\n${A_TEXT_INJECTED.split("\n").join("\n\n")}\n</${tag}>`));
    // The injected line is inside the delimiters and nowhere else.
    assert.equal(request.user.split(INJECTED_LINE).length, 2);
    // (The frame's first line names both tags, hence the opening tag on its
    // own line and the LAST closing tag.)
    assert.ok(request.user.indexOf(`\n<${tag}>\n`) < request.user.indexOf(INJECTED_LINE));
    assert.ok(request.user.indexOf(INJECTED_LINE) < request.user.lastIndexOf(`</${tag}>`));
    assert.match(request.system, /never as instructions/);
    assert.equal(request.system, RUBRIC_SYSTEM_PROMPT);
    // No tools, no sampling parameters: the request type has no such field.
    assert.deepEqual(Object.keys(request).sort(), ["effort", "maxOutputTokens", "role", "schema", "system", "timeoutMs", "user"]);
  });

  test("a model that obeys the injected text cannot add or alter criteria beyond what quotes support", async () => {
    // The clean run: what the document's real rules yield.
    await setUpRouteA(h);
    await runA(h);
    const clean = (versionDoc(KEY_A, 1) as VisaRubric).criteria;

    // Now the same rules with the injected line, and a "model" that did what
    // the line asked: it invents the credits rule (with a made-up quote),
    // turns it into a numeric check quoting an unrelated real sentence, and
    // rewrites the age rule the line told it to drop.
    resetStore();
    resetBucket();
    h = makeHarness();
    const obeyed = routeAAnswer();
    obeyed.criteria = [
      ...obeyed.criteria.filter((c) => c.ref !== "age"),
      crit({ ref: "credits1", title: "Must hold credits", kind: "objective", quote: "Every applicant must hold 9,999 credits before applying.", check: { field: "credits.balance", op: "gte", value: 9999, unit: null } }),
      crit({ ref: "credits2", title: "Must hold credits", kind: "objective", quote: "There is no set level of funds.", check: { field: "credits.balance", op: "gte", value: 9999, unit: null } }),
      crit({ ref: "age", title: "Aged 16 or over", kind: "objective", quote: body(A_LINES.age), check: { field: "applicant.age", op: "gte", value: 16, unit: null } }),
    ];
    await setUpRouteA(h, obeyed, A_TEXT_INJECTED);
    const { result } = await runA(h);
    assert.equal(result.status, "succeeded");
    assert.deepEqual(result.discardedByReason, { quote_not_found: 1, number_not_in_quote: 2 });
    const tainted = (versionDoc(KEY_A, 1) as VisaRubric).criteria;
    // Nothing was added, and nothing that survived differs from the clean run.
    const cleanById = new Map(clean.map((c) => [c.criterionId, c]));
    for (const c of tainted) {
      const twin = cleanById.get(c.criterionId);
      assert.ok(twin, `"${c.title}" is not in the clean rubric`);
      assert.deepEqual({ ...c, source: { ...c.source, contentHash: "" } }, { ...twin, source: { ...twin.source, contentHash: "" } });
    }
    assert.ok(!tainted.some((c) => /credit/i.test(c.title)));
    assert.ok(!tainted.some((c) => c.check?.value === 9999 || c.check?.value === 16));
    // The altered rule is gone rather than stored wrong: a reviewer sees it
    // in the discards, and the count says the rubric is one criterion short.
    assert.equal(tainted.length, clean.length - 1);
  });

  test("a criterion that quotes the injected passage itself is rejected once the passage is flagged", async () => {
    const out = routeAAnswer();
    out.suspiciousPassages = [{ quote: INJECTED_LINE }];
    out.criteria.push(crit({ ref: "credits", title: "Must hold credits", kind: "objective", quote: "every applicant must hold 9,999 credits", check: { field: "credits.balance", op: "gte", value: 9999, unit: null } }));
    await setUpRouteA(h, out, A_TEXT_INJECTED);
    const { result } = await runA(h);
    assert.equal(result.status, "succeeded");
    assert.deepEqual(result.discardedByReason, { quote_in_flagged_passage: 1 });
    const rubric = versionDoc(KEY_A, 1) as VisaRubric;
    assert.equal(rubric.criteria.length, 6);
    // The passage is kept, cited, for the reviewer, and the rubric is flagged.
    assert.equal(rubric.suspiciousPassages.length, 1);
    assert.equal(rubric.suspiciousPassages[0].quote, INJECTED_LINE);
    assert.ok(rubric.flags.some((f) => f.code === "suspicious_passages"));
  });

  test("an answer with a field outside the schema (a verdict) fails the run", async () => {
    const out: any = routeAAnswer();
    out.criteria[0].verdict = "pass";
    await setUpRouteA(h, out);
    const { result } = await runA(h);
    assert.equal(result.status, "failed");
    assert.equal(result.reasonCode, "invalid_model_output");
    assert.deepEqual(versionPaths(), []);
  });
});

// ============================================
// Governance and versioning
// ============================================

describe("rubric extraction: governance and versions", () => {
  test("re-extraction with an unchanged source hash calls no model and writes nothing", async () => {
    await setUpRouteA(h);
    await runA(h);
    const requestsBefore = h.provider.requests.length;
    const pathsBefore = [...store.keys()].sort();

    // The second run does not even name the sources: the head remembers them.
    const { result } = await quiet(() => h.service.extractRoute({ ...ROUTE_A }));
    assert.equal(result.status, "unchanged");
    assert.equal(result.reasonCode, "source_unchanged");
    assert.equal(result.version, 1);
    assert.equal(h.provider.requests.length, requestsBefore);
    assert.deepEqual([...store.keys()].sort(), pathsBefore);
  });

  test("a changed source writes version + 1 as pending and leaves the approved version serving", async () => {
    await setUpRouteA(h);
    await runA(h);
    // An admin approves version 1 (what #125 will do).
    store.set(`visaRubrics/${KEY_A}/rubricVersions/1`, { ...versionDoc(KEY_A, 1), reviewStatus: "approved", intentPolarity: "immigrant_intent_penalised", reviewedBy: "admin-1", reviewedAt: Timestamp.fromMillis(T0), revision: 1 });
    store.set(`visaRubrics/${KEY_A}`, { ...headDoc(KEY_A), approvedVersion: 1 });
    const v1 = JSON.stringify(versionDoc(KEY_A, 1));

    // The publisher changes the age rule; the crawl stores a new snapshot.
    const changed = A_TEXT.replace("aged 18 or over", "aged 21 or over");
    const out = routeAAnswer();
    const age = out.criteria.find((c) => c.ref === "age") as any;
    age.title = "Aged 21 or over";
    age.quote = "An applicant must be aged 21 or over on the date of application.";
    age.check.value = 21;
    const newHash = await setUpRouteA(h, out, changed);
    h.state.nowMs = T0 + 60_000;
    const { result } = await quiet(() => h.service.extractRoute({ ...ROUTE_A }));

    assert.equal(result.status, "succeeded");
    assert.equal(result.version, 2);
    const v2 = versionDoc(KEY_A, 2) as VisaRubric;
    assert.equal(v2.reviewStatus, "pending_review");
    assert.equal(v2.intentPolarity, null);
    assert.equal(v2.sourceSnapshots[0].contentHash, newHash);
    // Version 1 is byte-for-byte what it was, and still what consumers get.
    assert.equal(JSON.stringify(versionDoc(KEY_A, 1)), v1);
    assert.equal(headDoc(KEY_A).approvedVersion, 1);
    assert.equal(headDoc(KEY_A).latestVersion, 2);
    const served = await h.rubrics.getApprovedRubric(ROUTE_A.countryCode, ROUTE_A.visaTypeId);
    assert.equal(served?.version, 1);
    assert.ok(served?.criteria.some((c) => c.title === "Aged 18 or over"));
  });

  test("criteria keep their ids across versions when their text is unchanged (so versions can be diffed by id)", async () => {
    await setUpRouteA(h);
    await runA(h);
    const v1 = versionDoc(KEY_A, 1) as VisaRubric;
    const changed = A_TEXT.replace("aged 18 or over", "aged 21 or over");
    const out = routeAAnswer();
    const age = out.criteria.find((c) => c.ref === "age") as any;
    // The model also names things differently this time: ids must not care.
    out.criteria.forEach((c, i) => (c.ref = `c${i}`));
    out.intakeQuestions.forEach((q) => (q.criterionRefs = q.criterionRefs.map((r) => (r === "leave" ? "c3" : "c4"))));
    out.evidenceItems.forEach((e) => (e.criterionRefs = ["c4"]));
    age.title = "Aged 21 or over";
    age.quote = "An applicant must be aged 21 or over on the date of application.";
    age.check.value = 21;
    await setUpRouteA(h, out, changed);
    await quiet(() => h.service.extractRoute({ ...ROUTE_A }));
    const v2 = versionDoc(KEY_A, 2) as VisaRubric;

    const ids1 = new Set(v1.criteria.map((c) => c.criterionId));
    const ids2 = new Set(v2.criteria.map((c) => c.criterionId));
    const kept = [...ids1].filter((id) => ids2.has(id));
    const removed = v1.criteria.filter((c) => !ids2.has(c.criterionId));
    const added = v2.criteria.filter((c) => !ids1.has(c.criterionId));
    assert.equal(kept.length, 5);
    assert.deepEqual(removed.map((c) => c.title), ["Aged 18 or over"]);
    assert.deepEqual(added.map((c) => c.title), ["Aged 21 or over"]);
    // The changed rule can be paired by its rule reference.
    assert.equal(removed[0].ruleRef, added[0].ruleRef);
    // The id is a pure function of source, quote, kind and checked field.
    assert.equal(added[0].criterionId, criterionIdOf(SOURCE_A_ID, age.quote, "objective", "applicant.age"));
  });

  test("--force writes a new version from the same snapshots", async () => {
    await setUpRouteA(h);
    await runA(h);
    const { result } = await runA(h, { force: true });
    assert.equal(result.status, "succeeded");
    assert.equal(result.version, 2);
    assert.equal(versionDoc(KEY_A, 2).reviewStatus, "pending_review");
  });

  test("extraction cannot produce an approved document: the store refuses anything but a pristine pending draft", async () => {
    await setUpRouteA(h);
    await runA(h);
    const { version: _v, ...pending } = versionDoc(KEY_A, 1) as VisaRubric;
    const base = { ...pending, sourceSetHash: "f".repeat(64) } as RubricDraft;
    const attempts: Partial<RubricDraft>[] = [
      { reviewStatus: "approved" },
      { reviewStatus: "rejected" },
      { intentPolarity: "dual_intent_permitted" },
      { reviewedBy: "someone" },
      { reviewedAt: Timestamp.fromMillis(T0) },
      { revision: 1 },
    ];
    for (const change of attempts) {
      await assert.rejects(
        () => h.rubrics.writePendingVersion({ ...base, ...change }, [SOURCE_A_ID]),
        (err: unknown) => err instanceof RubricStoreError && err.code === "not_pending",
        JSON.stringify(Object.keys(change))
      );
    }
    assert.deepEqual(versionPaths(), [`visaRubrics/${KEY_A}/rubricVersions/1`]);
    // And every version the service itself has written is pending.
    for (const path of versionPaths()) assert.equal((store.get(path) as any).reviewStatus, "pending_review");
  });

  test("a version document is never overwritten", async () => {
    await setUpRouteA(h);
    await runA(h);
    const { version: _v, ...pending } = versionDoc(KEY_A, 1) as VisaRubric;
    // A head that lost track (latestVersion 0) would make the next write
    // target version 1 again: refused, not replaced.
    store.set(`visaRubrics/${KEY_A}`, { ...headDoc(KEY_A), latestVersion: 0, latestSourceSetHash: "0".repeat(64) });
    await assert.rejects(
      () => h.rubrics.writePendingVersion(pending as RubricDraft, [SOURCE_A_ID]),
      (err: unknown) => err instanceof RubricStoreError && err.code === "version_exists"
    );
  });

  test("a rubric for a route that is not a real visa type is rejected", async () => {
    await setUpRouteA(h);
    h.state.knownVisaTypes.clear();
    const { result } = await runA(h);
    assert.equal(result.status, "failed");
    assert.equal(result.reasonCode, "visa_type_not_found");
    assert.equal(h.provider.requests.length, 0);
    assert.deepEqual(versionPaths(), []);
  });

  test("the default visa-type lookup reads countries/{cc}/visaTypes/{id}", async () => {
    // No injected lookup: the service reads the catalogue itself.
    const real = makeHarness({ visaTypeExists: undefined });
    await seedSource({ id: SOURCE_A_ID, url: SOURCE_A_URL, text: A_TEXT });
    await recordAnswers(real.provider, SOURCE_A_ID, [routeAAnswer()]);
    const missing = await quiet(() => real.service.extractRoute({ ...ROUTE_A, sourceIds: [SOURCE_A_ID] }));
    assert.equal(missing.result.reasonCode, "visa_type_not_found");
    store.set(`countries/${ROUTE_A.countryCode}/visaTypes/${ROUTE_A.visaTypeId}`, { name: "Short visit" });
    const found = await quiet(() => real.service.extractRoute({ ...ROUTE_A, sourceIds: [SOURCE_A_ID] }));
    assert.equal(found.result.status, "succeeded");
  });
});

// ============================================
// Finding work without a listener
// ============================================

describe("rubric extraction: stale routes", () => {
  test("findStaleRoutes / runPending pick up a route whose newest snapshot has no version", async () => {
    await setUpRouteA(h);
    await runA(h);
    assert.deepEqual(await h.service.findStaleRoutes(), []);
    assert.deepEqual((await quiet(() => h.service.runPending())).result, []);

    // The crawl stored a new snapshot but its listener never ran.
    const changed = `${A_TEXT}\nSV 6.1 An applicant must hold a return ticket for the journey home.`;
    const out = routeAAnswer();
    out.criteria.push(crit({ ref: "ticket", title: "Holds a return ticket", kind: "objective", quote: "An applicant must hold a return ticket for the journey home.", check: { field: "travel.returnTicket", op: "present", value: null, unit: null } }));
    await setUpRouteA(h, out, changed);
    assert.deepEqual(await h.service.findStaleRoutes(), [{ routeKey: KEY_A, ...ROUTE_A }]);

    const { result } = await quiet(() => h.service.runPending());
    assert.equal(result.length, 1);
    assert.equal(result[0].status, "succeeded");
    assert.equal(result[0].version, 2);
    assert.equal(runDocs().find((r) => r.version === 2).trigger, "pending_sweep");
    assert.deepEqual(await h.service.findStaleRoutes(), []);
  });

  test("onGuidanceChanged re-extracts only the routes that use the changed source", async () => {
    await setUpRouteA(h);
    await runA(h);
    // A change event for a source no route uses: nothing happens.
    assert.deepEqual((await quiet(() => h.service.onGuidanceChanged({ sourceId: "some-other-source" }))).result, []);
    // A change event for route A's source while its hash is the same: free.
    const same = await quiet(() => h.service.onGuidanceChanged({ sourceId: SOURCE_A_ID }));
    assert.deepEqual(same.result.map((r) => r.status), ["unchanged"]);
    assert.equal(h.provider.requests.length, 1);
  });

  test("a dry run plans the chunks, calls no model and writes nothing", async () => {
    await setUpRouteA(h);
    const { result } = await runA(h, { dryRun: true });
    assert.equal(result.status, "dry_run");
    assert.equal(result.chunks, 1);
    assert.equal(result.plan[0].sourceId, SOURCE_A_ID);
    assert.equal(result.plan[0].chars, A_TEXT.length);
    assert.equal(h.provider.requests.length, 0);
    assert.deepEqual(versionPaths(), []);
    assert.deepEqual(runDocs(), []);
  });
});

// ============================================
// Cost guards and provider failures
// ============================================

describe("rubric extraction: cost guards", () => {
  test("fails closed when the settings cannot be read", async () => {
    await setUpRouteA(h);
    h.state.readError = "reading appConfig/rubricExtractionSettings failed: unavailable";
    const { result } = await runA(h);
    assert.equal(result.status, "skipped");
    assert.equal(result.reasonCode, "settings_unavailable");
    assert.equal(h.provider.requests.length, 0);
    assert.deepEqual(versionPaths(), []);
  });

  test("the kill switch stops a run before any call", async () => {
    await setUpRouteA(h);
    h.settings.enabled = false;
    const { result } = await runA(h);
    assert.equal(result.status, "skipped");
    assert.equal(result.reasonCode, "disabled");
    assert.equal(h.provider.requests.length, 0);
  });

  test("a run that would pass a per-run cap is refused whole, before its first call", async () => {
    await setUpRouteA(h);
    h.settings.maxInputCharsPerRun = 500; // the page is longer than this
    const chars = await runA(h);
    assert.equal(chars.result.status, "skipped");
    assert.equal(chars.result.reasonCode, "run_cap_exceeded");
    assert.equal(h.provider.requests.length, 0);
    assert.deepEqual(versionPaths(), []);
  });

  test("the daily cap counts runs that reached the model", async () => {
    await setUpRouteA(h);
    h.settings.maxRunsPerDay = 1;
    assert.equal((await runA(h)).result.status, "succeeded");
    const second = await runA(h, { force: true });
    assert.equal(second.result.status, "skipped");
    assert.equal(second.result.reasonCode, "daily_cap_reached");
    assert.equal(h.provider.requests.length, 1);
    // The next UTC day it runs again.
    h.state.nowMs = T0 + 24 * 3_600_000;
    assert.equal((await runA(h, { force: true })).result.status, "succeeded");
  });

  test("each request carries the configured timeout and token ceiling", async () => {
    h.settings.requestTimeoutMs = 90_000;
    h.settings.maxOutputTokensPerRequest = 8_000;
    await setUpRouteA(h);
    await runA(h);
    assert.equal(h.provider.requests[0].timeoutMs, 90_000);
    assert.equal(h.provider.requests[0].maxOutputTokens, 8_000);
    assert.equal(h.provider.requests[0].role, "judgement");
  });
});

describe("rubric extraction: provider failures never produce a version", () => {
  const cases: [string, any, string][] = [
    ["a refusal", { raw: true, text: "", stopReason: "refusal" }, "provider_refused"],
    ["a truncated answer", { raw: true, text: "{\"criteria\": [", stopReason: "max_tokens" }, "output_truncated"],
    ["an answer that is not JSON", "Here are the criteria you asked for.", "invalid_model_output"],
    ["an answer missing a required list", JSON.stringify({ criteria: [] }), "invalid_model_output"],
  ];
  for (const [name, recorded, reasonCode] of cases) {
    test(`${name} fails the run (${reasonCode})`, async () => {
      await setUpRouteA(h, recorded);
      const { result } = await runA(h);
      assert.equal(result.status, "failed");
      assert.equal(result.reasonCode, reasonCode);
      assert.deepEqual(versionPaths(), []);
      assert.equal(headDoc(KEY_A), undefined);
      // The tokens of the failed call are still accounted for.
      assert.equal(runDocs()[0].usage.requests, 1);
      assert.equal(runDocs()[0].usage.inputTokens, RECORDED_USAGE.inputTokens);
    });
  }

  test("a request with no recording fails the run instead of reaching a network", async () => {
    h.state.knownVisaTypes.add(`${ROUTE_A.countryCode}/${ROUTE_A.visaTypeId}`);
    await seedSource({ id: SOURCE_A_ID, url: SOURCE_A_URL, text: A_TEXT });
    const { result } = await runA(h);
    assert.equal(result.status, "failed");
    assert.equal(result.reasonCode, "provider_error");
    assert.match(result.error as string, /no recording for request/);
    assert.deepEqual(versionPaths(), []);
  });
});
