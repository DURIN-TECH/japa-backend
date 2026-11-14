// ============================================
// Unit tests — what the applicant holds, and rules that use it (issue #234, P5 of #228)
// ============================================
//
// Pure code only (no Firestore, no model). Covers every way code decides a
// rule from the applicant's facts:
//   - bar groups of each kind (nationality, residence, holds, members_of) with
//     the fact missing, an expired document and several nationalities;
//   - members_of with no recorded members ("could not tell", never "nobody");
//   - fact triggers (nationality, residence, holds) through resolveApplicability,
//     alone and combined with a question trigger;
//   - an OLD-SHAPE stored rule (nationalities / asWritten / uncoded, no groups)
//     read as the nationality kind with no rewrite;
//   - a two-layer stack (shared + own layer) through the real stack merge;
//   - the facts line sent to the assessment model (only what rules need, never a note).
//
// Every code and id is made up ("QA", "QB", "zq-bloc", ...): no real country,
// nationality or bloc appears.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { Timestamp } from "firebase-admin/firestore";
import {
  decideFactTrigger,
  decideGroups,
  factsFromApplicantFacts,
  factsFromNationality,
  factsSummaryForModel,
  groupsOf,
  isHeldDocumentValidOn,
  matchGroup,
  membershipAuthorityIdsOf,
  NO_FACTS,
  type FactsForRules,
} from "../../src/services/ai/applicant-groups";
import { barNotAssessedItems, decideMandatoryBars, mandatoryBarHits, judgementCriteriaOf, isJudgedBar } from "../../src/services/ai/assessment-engine";
import { effectiveIntakeQuestions, resolveApplicability, splitByApplicability, notAssessedItems } from "../../src/services/ai/rule-applicability";
import { isValidFactTrigger, parseHoldsValue } from "../../src/utils/rubric-trigger";
// The scrapers module through its public API only (lint rule: no internals from outside it).
import { keyFieldsOf, mergeRulebookStack, rulebookTargetOf, validateVisaRubric } from "../../src/scrapers";
import type { AssessmentCriterion, IntakeQuestion, VisaRubric } from "../../src/types/rubric";
import type { RouteLayer } from "../../src/types/shared-route";

/* eslint-disable @typescript-eslint/no-explicit-any */

// ----- Fixtures (all made up) -----

/** The date rules are checked on in these tests. */
const ON = "2026-11-14";

/** A citation (made-up page). */
function cite(quote: string, sourceId = "src-1") {
  return { quote, sourceId, url: `https://rules.example/${sourceId}`, contentHash: "a".repeat(64), retrievedAt: "2026-11-01T00:00:00.000Z" };
}

/** A mandatory bar with the given group. */
function bar(id: string, appliesTo: AssessmentCriterion["appliesTo"], over: Partial<AssessmentCriterion> = {}): AssessmentCriterion {
  return {
    criterionId: id,
    title: `Bar ${id}`,
    kind: "mandatory_bar",
    stage: "suitability",
    severity: "critical",
    source: cite(`The quote of bar ${id}.`),
    applicability: "all_applicants",
    appliesTo,
    confidence: 0.9,
    ...over,
  };
}

/** An ordinary rule. */
function rule(id: string, over: Partial<AssessmentCriterion> = {}): AssessmentCriterion {
  return { criterionId: id, title: `Rule ${id}`, kind: "objective", stage: "eligibility", severity: "high", source: cite(`The quote of rule ${id}.`), applicability: "all_applicants", check: { field: "funds.balance", op: "present" }, confidence: 0.9, ...over };
}

/** Facts with sensible "not stated" defaults. */
function facts(over: Partial<FactsForRules> = {}): FactsForRules {
  return { ...NO_FACTS, ...over };
}

/** An approved version in the shape the store serves (made-up key). */
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
  } as VisaRubric;
}

// ============================================
// Old stored shape: read as the nationality kind, no rewrite
// ============================================

describe("an OLD-SHAPE stored bar (nationalities / asWritten / uncoded, no groups)", () => {
  // Exactly the shape approved rulebooks on dev carry (stored before #234).
  const stored = JSON.parse(
    JSON.stringify({
      criterionId: "old-bar",
      title: "Old bar",
      kind: "mandatory_bar",
      stage: "suitability",
      severity: "critical",
      source: cite("Nationals of Qaland or Qbland, and people with right of abode, are refused."),
      appliesTo: { nationalities: ["QA", "QB"], asWritten: ["Qaland", "Qbland"], codeNames: ["Qaland", "Qbland"], uncoded: ["people with right of abode"] },
      confidence: 0.9,
    })
  ) as AssessmentCriterion;

  test("groupsOf reads its codes as nationality members, in order, and never the uncoded ones", () => {
    assert.deepEqual(groupsOf(stored.appliesTo), [
      { kind: "nationality", code: "QA", asWritten: "Qaland" },
      { kind: "nationality", code: "QB", asWritten: "Qbland" },
    ]);
  });

  test("the bar decides exactly as before #234 from a single nationality code", () => {
    const rubric = { criteria: [stored] };
    assert.deepEqual(mandatoryBarHits(rubric, "QA", ON).map((c) => c.criterionId), ["old-bar"]);
    assert.deepEqual(mandatoryBarHits(rubric, "QC", ON), []);
    assert.deepEqual(mandatoryBarHits(rubric, null, ON), [], "a null nationality still matches nothing");
    // Its uncoded member still sends it to the model, as before (#222).
    assert.ok(isJudgedBar(stored));
    assert.deepEqual(judgementCriteriaOf(rubric).map((c) => c.criterionId), ["old-bar"]);
  });

  test("the stored version still validates (no field it lacks is required)", () => {
    const r = approved({ countryCode: "QX", visaTypeId: "qx-visit" }, 1, { criteria: [stored] });
    const v = validateVisaRubric(r);
    assert.ok(!v.errors.some((e: any) => e.target === "old-bar"), JSON.stringify(v.errors));
  });
});

// ============================================
// Each group kind: match, no match, missing fact, expired, several nationalities
// ============================================

describe("matchGroup: every kind", () => {
  test("nationality: any of several nationalities counts; none stated is unknown", () => {
    const g = { kind: "nationality" as const, code: "QB", asWritten: "Qbland" };
    assert.deepEqual(matchGroup(g, facts({ nationalities: ["QA", "QB"] }), ON, {}), { status: "match" });
    assert.deepEqual(matchGroup(g, facts({ nationalities: ["QA"] }), ON, {}), { status: "no_match" });
    assert.deepEqual(matchGroup(g, facts(), ON, {}), { status: "unknown", needs: ["nationality"] });
  });

  test("residence: matches the stated country; not stated is unknown", () => {
    const g = { kind: "residence" as const, code: "QC", asWritten: "residents of Qcland" };
    assert.deepEqual(matchGroup(g, facts({ residentialCountry: "QC" }), ON, {}), { status: "match" });
    assert.deepEqual(matchGroup(g, facts({ residentialCountry: "QD" }), ON, {}), { status: "no_match" });
    assert.deepEqual(matchGroup(g, facts({ nationalities: ["QC"] }), ON, {}), { status: "unknown", needs: ["residence"] }, "nationality is never used as residence");
  });

  test("holds: a valid document of that kind from that issuer matches; an expired one never does", () => {
    const g = { kind: "holds" as const, document: "residence_permit" as const, issuer: "QD", asWritten: "holders of a valid Qdland residence permit" };
    const valid = { kind: "residence_permit" as const, issuerCountryCode: "QD", validUntil: "2027-01-01" };
    const expired = { kind: "residence_permit" as const, issuerCountryCode: "QD", validUntil: "2026-11-13" };
    const otherKind = { kind: "visa" as const, issuerCountryCode: "QD", validUntil: "2027-01-01" };
    const otherIssuer = { kind: "residence_permit" as const, issuerCountryCode: "QE", validUntil: "2027-01-01" };
    assert.deepEqual(matchGroup(g, facts({ heldDocuments: [valid] }), ON, {}), { status: "match" });
    assert.deepEqual(matchGroup(g, facts({ heldDocuments: [expired] }), ON, {}), { status: "no_match" }, "expired: stated, so not unknown, and never a match");
    assert.deepEqual(matchGroup(g, facts({ heldDocuments: [otherKind, otherIssuer] }), ON, {}), { status: "no_match" });
    assert.deepEqual(matchGroup(g, facts({ heldDocuments: [] }), ON, {}), { status: "no_match" }, "holds none");
    assert.deepEqual(matchGroup(g, facts({ heldDocuments: null }), ON, {}), { status: "unknown", needs: ["holds"] }, "never stated");
  });

  test("holds: valid on its last day, expired the day after", () => {
    assert.equal(isHeldDocumentValidOn({ validUntil: ON }, ON), true);
    assert.equal(isHeldDocumentValidOn({ validUntil: "2026-11-13" }, ON), false);
    assert.equal(isHeldDocumentValidOn({ validUntil: "not a date" }, ON), false);
  });

  test("holds: an authority issuer matches only a document recorded as issued under that authority (no widening)", () => {
    const g = { kind: "holds" as const, document: "visa" as const, issuer: "zq-bloc", asWritten: "holders of a valid Zq visa" };
    assert.deepEqual(matchGroup(g, facts({ heldDocuments: [{ kind: "visa", issuerAuthorityId: "zq-bloc", validUntil: "2027-01-01" }] }), ON, {}), { status: "match" });
    // A member country's own visa is NOT read as the bloc's, even if that country is a member.
    assert.deepEqual(matchGroup(g, facts({ heldDocuments: [{ kind: "visa", issuerCountryCode: "QA", validUntil: "2027-01-01" }] }), ON, { "zq-bloc": ["QA"] }), { status: "no_match" });
  });

  test("members_of: resolved through membership on the start date; no recorded members is unknown, never nobody", () => {
    const g = { kind: "members_of" as const, authorityId: "zq-bloc", fact: "nationality" as const, asWritten: "citizens of a Zq member state" };
    assert.deepEqual(matchGroup(g, facts({ nationalities: ["QZ", "QA"] }), ON, { "zq-bloc": ["QA", "QB"] }), { status: "match" }, "any nationality that is a member");
    assert.deepEqual(matchGroup(g, facts({ nationalities: ["QZ"] }), ON, { "zq-bloc": ["QA", "QB"] }), { status: "no_match" });
    assert.deepEqual(matchGroup(g, facts({ nationalities: ["QA"] }), ON, { "zq-bloc": [] }), { status: "no_match" }, "members recorded, none current: known");
    assert.deepEqual(matchGroup(g, facts({ nationalities: ["QA"] }), ON, { "zq-bloc": null }), { status: "unknown", needs: ["membership"] });
    assert.deepEqual(matchGroup(g, facts({ nationalities: ["QA"] }), ON, {}), { status: "unknown", needs: ["membership"] }, "authority not loaded / unknown");
    assert.deepEqual(matchGroup(g, facts(), ON, { "zq-bloc": ["QA"] }), { status: "unknown", needs: ["nationality"] });
    const byResidence = { ...g, fact: "residence" as const };
    assert.deepEqual(matchGroup(byResidence, facts({ nationalities: ["QA"], residentialCountry: "QB" }), ON, { "zq-bloc": ["QB"] }), { status: "match" });
    assert.deepEqual(matchGroup(byResidence, facts({ nationalities: ["QB"] }), ON, { "zq-bloc": ["QB"] }), { status: "unknown", needs: ["residence"] });
  });

  test("a group: any member matching wins; else any undecidable member makes it unknown; else no match", () => {
    const groups = groupsOf({ nationalities: ["QA"], asWritten: ["Qaland"], groups: [{ kind: "residence", code: "QC", asWritten: "residents of Qcland" }] });
    assert.deepEqual(decideGroups(groups, facts({ nationalities: ["QA"] }), ON, {}), { status: "match" }, "nationality matches even though residence is not stated");
    assert.deepEqual(decideGroups(groups, facts({ nationalities: ["QB"] }), ON, {}), { status: "unknown", needs: ["residence"] }, "they might be in it as a resident");
    assert.deepEqual(decideGroups(groups, facts({ nationalities: ["QB"], residentialCountry: "QD" }), ON, {}), { status: "no_match" });
  });
});

// ============================================
// Mandatory bars from facts: hits and "could not be assessed"
// ============================================

describe("decideMandatoryBars", () => {
  const rubric = {
    criteria: [
      bar("b-nat", { nationalities: ["QA"], asWritten: ["Qaland"] }),
      bar("b-res", { nationalities: [], asWritten: [], groups: [{ kind: "residence", code: "QC", asWritten: "residents of Qcland" }] }),
      bar("b-holds", { nationalities: [], asWritten: [], groups: [{ kind: "holds", document: "visa", issuer: "QD", asWritten: "holders of a Qdland visa" }] }),
      bar("b-bloc", { nationalities: [], asWritten: [], groups: [{ kind: "members_of", authorityId: "zq-bloc", fact: "nationality", asWritten: "nationals of a Zq member" }] }),
    ],
  };

  test("nothing stated: no hit, and every bar is 'could not be assessed' with a plain reason", () => {
    const d = decideMandatoryBars(rubric, NO_FACTS, ON, { "zq-bloc": ["QA"] });
    assert.deepEqual(d.hits, []);
    const items = barNotAssessedItems(d.unknown);
    assert.deepEqual(items.map((i) => [i.criterionId, i.reason, i.notAssessed]), [
      ["b-nat", "could not be assessed: we need to know your nationality", "missing_fact"],
      ["b-res", "could not be assessed: we need to know which country you live in", "missing_fact"],
      ["b-holds", "could not be assessed: we need to know which visas or permits you hold", "missing_fact"],
      ["b-bloc", "could not be assessed: we need to know your nationality", "missing_fact"],
    ]);
  });

  test("several nationalities, residence and a valid visa: each bar that matches is a hit", () => {
    const f = facts({ nationalities: ["QZ", "QA"], residentialCountry: "QC", heldDocuments: [{ kind: "visa", issuerCountryCode: "QD", validUntil: "2027-01-01" }] });
    const d = decideMandatoryBars(rubric, f, ON, { "zq-bloc": ["QA"] });
    assert.deepEqual(d.hits.map((c) => c.criterionId), ["b-nat", "b-res", "b-holds", "b-bloc"]);
    assert.deepEqual(d.unknown, []);
  });

  test("an expired visa never hits; stated facts that miss every group decide 'not in it'", () => {
    const f = facts({ nationalities: ["QZ"], residentialCountry: "QY", heldDocuments: [{ kind: "visa", issuerCountryCode: "QD", validUntil: "2026-01-01" }] });
    const d = decideMandatoryBars(rubric, f, ON, { "zq-bloc": ["QA"] });
    assert.deepEqual(d.hits, []);
    assert.deepEqual(d.unknown, []);
  });

  test("a members_of bar on an authority with no recorded members is unknown, not 'nobody'", () => {
    const d = decideMandatoryBars(rubric, facts({ nationalities: ["QA"] }), ON, {});
    assert.deepEqual(d.unknown.find((u) => u.criterion.criterionId === "b-bloc")?.needs, ["membership"]);
  });

  test("bar safeguards are kept: a notCodeDecided bar and a bar outside its dates are never decided", () => {
    const guarded = {
      criteria: [
        bar("nc", { nationalities: [], asWritten: [], groups: [{ kind: "residence", code: "QC", asWritten: "residents of Qcland" }] }, { notCodeDecided: true }),
        bar("dated", { nationalities: ["QA"], asWritten: ["Qaland"] }, { validFrom: "2027-01-01" }),
        bar("uncoded-only", { nationalities: [], asWritten: [], uncoded: ["people with right of abode"] }),
      ],
    };
    const d = decideMandatoryBars(guarded, facts({ nationalities: ["QA"], residentialCountry: "QC" }), ON, {});
    assert.deepEqual(d.hits, []);
    assert.deepEqual(d.unknown, [], "neither decided nor reported missing: the model judges nc and uncoded-only (#222/#248)");
    assert.deepEqual(judgementCriteriaOf(guarded).map((c) => c.criterionId).sort(), ["nc", "uncoded-only"]);
  });

  test("the authority ids to load are exactly those the groups name", () => {
    assert.deepEqual(membershipAuthorityIdsOf(rubric.criteria), ["zq-bloc"]);
    assert.deepEqual(membershipAuthorityIdsOf([bar("x", { nationalities: ["QA"], asWritten: ["Qaland"] })]), []);
  });
});

// ============================================
// Fact triggers through resolveApplicability
// ============================================

describe("fact triggers ({ fact, anyOf } beside { questionId, anyOf })", () => {
  const questions: IntakeQuestion[] = [{ id: "purpose", label: "your purpose of travel", answerType: "single_choice", required: true, criterionIds: ["both"], options: [{ value: "work", label: "Work" }, { value: "visit", label: "Visit" }] }];
  const byNationality = rule("nat", { applicability: "conditional", factTrigger: { fact: "nationality", anyOf: ["QA"] } });
  const byResidence = rule("res", { applicability: "specialist", factTrigger: { fact: "residence", anyOf: ["QC"] } });
  const byHolds = rule("holds", { applicability: "conditional", factTrigger: { fact: "holds", anyOf: ["residence_permit:QD", "visa:zq-bloc"] } });
  const both = rule("both", { applicability: "specialist", trigger: { questionId: "purpose", anyOf: ["work"] }, factTrigger: { fact: "nationality", anyOf: ["QA"] } });
  const ctx = (f: Partial<FactsForRules>) => ({ facts: facts(f), onDate: ON });

  test("missing fact: unknown with the plain need, never applies and never not-applicable", () => {
    assert.deepEqual(resolveApplicability(byNationality, [], {}, ctx({})), { status: "unknown", reason: "missing_fact", need: "your nationality" });
    assert.deepEqual(resolveApplicability(byResidence, [], {}, ctx({})), { status: "unknown", reason: "missing_fact", need: "which country you live in" });
    assert.deepEqual(resolveApplicability(byHolds, [], {}, ctx({})), { status: "unknown", reason: "missing_fact", need: "which visas or permits you hold" });
    // No context at all (a consumer that has no facts) is the same "could not tell".
    assert.equal(resolveApplicability(byNationality, [], {}).status, "unknown");
  });

  test("several nationalities: any one triggers", () => {
    assert.deepEqual(resolveApplicability(byNationality, [], {}, ctx({ nationalities: ["QZ", "QA"] })), { status: "applies" });
    assert.deepEqual(resolveApplicability(byNationality, [], {}, ctx({ nationalities: ["QZ"] })), { status: "not_applicable" });
  });

  test("holds: a valid document triggers, an expired one does not; an authority-issued one matches its id", () => {
    assert.deepEqual(resolveApplicability(byHolds, [], {}, ctx({ heldDocuments: [{ kind: "residence_permit", issuerCountryCode: "QD", validUntil: "2030-01-01" }] })), { status: "applies" });
    assert.deepEqual(resolveApplicability(byHolds, [], {}, ctx({ heldDocuments: [{ kind: "residence_permit", issuerCountryCode: "QD", validUntil: "2020-01-01" }] })), { status: "not_applicable" });
    assert.deepEqual(resolveApplicability(byHolds, [], {}, ctx({ heldDocuments: [{ kind: "visa", issuerAuthorityId: "zq-bloc", validUntil: "2030-01-01" }] })), { status: "applies" });
  });

  test("with a question trigger too: both must hold; either ruling out rules out; a gap on either is unknown", () => {
    assert.deepEqual(resolveApplicability(both, questions, { purpose: "work" }, ctx({ nationalities: ["QA"] })), { status: "applies" });
    assert.deepEqual(resolveApplicability(both, questions, { purpose: "visit" }, ctx({})), { status: "not_applicable" }, "the answer rules it out whatever the facts");
    assert.deepEqual(resolveApplicability(both, questions, { purpose: "work" }, ctx({ nationalities: ["QZ"] })), { status: "not_applicable" });
    assert.equal(resolveApplicability(both, questions, {}, ctx({ nationalities: ["QA"] })).status, "unknown");
    assert.deepEqual(resolveApplicability(both, questions, { purpose: "work" }, ctx({})), { status: "unknown", reason: "missing_fact", need: "your nationality" });
  });

  test("the split reports a missing fact in plain words ('we need to know your nationality')", () => {
    const split = splitByApplicability({ criteria: [byNationality, rule("all")], intakeQuestions: [] }, {}, ctx({}));
    assert.deepEqual(split.applicable.map((c) => c.criterionId), ["all"]);
    assert.deepEqual(notAssessedItems(split).map((i) => [i.criterionId, i.reason, i.notAssessed]), [["nat", "could not be assessed: we need to know your nationality", "missing_fact"]]);
  });

  test("a damaged fact trigger is treated as absent (a specialist rule is then 'could not tell')", () => {
    const damaged = rule("dmg", { applicability: "specialist", factTrigger: { fact: "nationality", anyOf: ["not-a-code"] } });
    assert.equal(isValidFactTrigger(damaged.factTrigger), false);
    assert.deepEqual(resolveApplicability(damaged, [], {}, ctx({ nationalities: ["QA"] })), { status: "unknown", reason: "no_trigger", need: "whether this rule applies to your application" });
    assert.equal(isValidFactTrigger({ fact: "holds", anyOf: ["passport:QA"] }), false, "unknown document kind");
    assert.equal(isValidFactTrigger({ fact: "holds", anyOf: ["visa:x"] }), false, "issuer neither a code nor an authority id");
    assert.deepEqual(parseHoldsValue("travel_authorisation:QA"), { document: "travel_authorisation", issuer: "QA" });
  });

  test("a question only a fact-triggered specialist rule reads stays asked", () => {
    const q: IntakeQuestion = { id: "employer", label: "your employer", answerType: "text", required: false, criterionIds: ["res"] };
    const shown = effectiveIntakeQuestions({ criteria: [byResidence], intakeQuestions: [q] });
    assert.deepEqual(shown.map((x) => x.id), ["employer"]);
  });
});

// ============================================
// The application's copy and the eligibility fallback
// ============================================

describe("facts from the application's copy, and the dev-data fallback", () => {
  test("the copy is read as stated; malformed codes are not stated (never guessed)", () => {
    const f = factsFromApplicantFacts({ nationalities: ["QA", "bad"], residentialCountry: "Somewhere", heldDocuments: [] } as any);
    assert.deepEqual(f, { nationalities: ["QA"], residentialCountry: null, heldDocuments: [] });
  });

  test("the eligibility fallback knows one nationality and nothing else", () => {
    assert.deepEqual(factsFromNationality("QA"), { nationalities: ["QA"], residentialCountry: null, heldDocuments: null });
    assert.deepEqual(factsFromNationality(null), NO_FACTS);
  });

  test("decideFactTrigger on an unusable trigger is unknown with no need", () => {
    assert.deepEqual(decideFactTrigger(undefined, NO_FACTS, ON), { status: "unknown", needs: [] });
  });
});

// ============================================
// What reaches the assessment model
// ============================================

describe("the facts line of the model's profile summary: only what rules need", () => {
  const f = facts({ nationalities: ["QA", "QB"], residentialCountry: "QC", heldDocuments: [{ kind: "visa", issuerCountryCode: "QD", validUntil: "2027-01-01" }, { kind: "visa", issuerCountryCode: "QE", validUntil: "2020-01-01" }] });
  const withNote = { ...f, heldDocuments: f.heldDocuments!.map((d) => ({ ...d, note: "SECRET-NOTE" })) } as FactsForRules;

  test("a rulebook that reads only nationality: nationality codes only", () => {
    const line = factsSummaryForModel(f, [bar("b", { nationalities: ["QA"], asWritten: ["Qaland"] })], ON, false);
    assert.equal(line, "Nationality code(s): QA, QB.");
  });

  test("residence and held documents only when a rule reads them; only valid documents; never the note", () => {
    const criteria = [
      bar("r", { nationalities: [], asWritten: [], groups: [{ kind: "residence", code: "QC", asWritten: "residents of Qcland" }] }),
      rule("h", { applicability: "conditional", factTrigger: { fact: "holds", anyOf: ["visa:QD"] } }),
    ];
    const line = factsSummaryForModel(withNote, criteria, ON, false);
    assert.match(line, /Country of residence code: QC\./);
    assert.match(line, /visa issued by QD, valid until 2027-01-01/);
    assert.doesNotMatch(line, /QE/, "an expired document is not sent");
    assert.doesNotMatch(line, /SECRET-NOTE/);
  });

  test("a judged bar (uncoded members) gets residence and documents too, so the model can weigh its group", () => {
    const line = factsSummaryForModel(withNote, [bar("u", { nationalities: [], asWritten: [], uncoded: ["holders of a long-stay permit"] })], ON, true);
    assert.match(line, /Country of residence code: QC\./);
    assert.match(line, /Valid visas and permits held:/);
    assert.doesNotMatch(line, /SECRET-NOTE/);
  });

  test("not stated reads 'not given'", () => {
    assert.equal(factsSummaryForModel(NO_FACTS, [], ON, true), "Nationality code(s): not given. Country of residence code: not given. Valid visas and permits held: not given.");
  });
});

// ============================================
// A two-layer stack (shared + own)
// ============================================

describe("a two-layer stack: groups and fact triggers from both layers are decided on the merged rulebook", () => {
  const BLOC = "zq-bloc";
  const SHARED_KEY = `${BLOC}_zq-short-stay`;
  const OWN = { countryCode: "QX", visaTypeId: "qx-short-stay" };
  const OWN_KEY = `${OWN.countryCode}_${OWN.visaTypeId}`;
  const STACK: RouteLayer[] = [
    { authorityId: BLOC, rulebookKey: SHARED_KEY, role: "shared" },
    { authorityId: OWN.countryCode, rulebookKey: OWN_KEY, role: "own" },
  ];
  const shared = approved({ authorityId: BLOC, routeSlug: "zq-short-stay" }, 3, {
    criteria: [
      bar("bloc-bar", { nationalities: [], asWritten: [], groups: [{ kind: "members_of", authorityId: "zq-other", fact: "residence", asWritten: "residents of a Zq-other member" }] }),
      rule("permit-rule", { applicability: "conditional", factTrigger: { fact: "holds", anyOf: ["residence_permit:QD"] } }),
    ],
  });
  const own = approved(OWN, 2, { criteria: [bar("own-bar", { nationalities: ["QA"], asWritten: ["Qaland"] })] });
  const merged = mergeRulebookStack([{ layer: STACK[0], rubric: shared }, { layer: STACK[1], rubric: own }]) as VisaRubric;

  test("the shared layer's ids are scoped, its groups and fact trigger ride along unchanged", () => {
    const ids = merged.criteria.map((c) => c.criterionId);
    assert.ok(ids.includes(`${SHARED_KEY}::bloc-bar`) && ids.includes(`${SHARED_KEY}::permit-rule`) && ids.includes("own-bar"), ids.join(","));
    assert.deepEqual(membershipAuthorityIdsOf(merged.criteria), ["zq-other"]);
  });

  test("both layers' bars hit for an applicant in both groups; the stricter result decides", () => {
    const f = facts({ nationalities: ["QA"], residentialCountry: "QR" });
    const d = decideMandatoryBars(merged, f, ON, { "zq-other": ["QR"] });
    assert.deepEqual(d.hits.map((c) => c.criterionId).sort(), [`${SHARED_KEY}::bloc-bar`, "own-bar"].sort());
  });

  test("the shared bar is 'could not be assessed' when its membership is not recorded, the own bar still decides", () => {
    const d = decideMandatoryBars(merged, facts({ nationalities: ["QA"], residentialCountry: "QR" }), ON, {});
    assert.deepEqual(d.hits.map((c) => c.criterionId), ["own-bar"]);
    const items = barNotAssessedItems(d.unknown);
    assert.equal(items.length, 1);
    assert.equal(items[0].layerKey, SHARED_KEY, "the layer rides along on the item");
  });

  test("the shared fact-triggered rule applies to a holder of a valid permit, and only to them", () => {
    const holder = splitByApplicability(merged, {}, { facts: facts({ heldDocuments: [{ kind: "residence_permit", issuerCountryCode: "QD", validUntil: "2030-01-01" }] }), onDate: ON });
    assert.ok(holder.applicable.some((c) => c.criterionId === `${SHARED_KEY}::permit-rule`));
    const none = splitByApplicability(merged, {}, { facts: facts({ heldDocuments: [] }), onDate: ON });
    assert.ok(none.notApplicableIds.includes(`${SHARED_KEY}::permit-rule`));
  });
});
