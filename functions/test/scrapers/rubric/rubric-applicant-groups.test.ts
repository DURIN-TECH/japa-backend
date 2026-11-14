// ============================================
// Unit tests — drafting, checking and validating groups decided from what the
// applicant holds (issue #234, P5 of #228)
// ============================================
//
// Recorded / pure only: no model call is made. Covers:
//   - extraction keeps a drafted `appliesTo.groups` member only when its kind's
//     fields are there, its wording is in the quote, and any authority id is one
//     the drafting message listed (never one the model made up);
//   - the drafting message lists blocs and treaties only when there are any, and
//     only on the criteria call (the intake call is unchanged);
//   - the drafting prompt still says "codes only when the quote names them,
//     otherwise uncoded", and now names `groups`;
//   - the check is shown `groups` only for a rule that has them;
//   - the stored-rubric validator: group shapes, a bar with only groups, fact
//     triggers (shape, and only on a scoped rule).
//
// Every code and id is made up.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createHash } from "node:crypto";
import type { GuidanceSnapshotContent } from "../../../src/scrapers/guidance/types";
import { SnapshotQuoteIndex } from "../../../src/scrapers/rubric/rubric-quote";
import { assessChunkOutput, rawGroupProblem, reviewFlagsFor } from "../../../src/scrapers/rubric/rubric-extraction.service";
import { RUBRIC_SYSTEM_PROMPT, buildIntakeRequest, buildRubricRequest } from "../../../src/scrapers/rubric/rubric-prompt";
import { CHECKER_SYSTEM_PROMPT, buildBatchRequest } from "../../../src/scrapers/rubric/rubric-checker-prompt";
import { storedGroupProblem, validateCriterionShape, validateVisaRubric } from "../../../src/scrapers/rubric/rubric-validate";
import { DEFAULT_SEVERITY_LEVELS, type AssessmentCriterion, type VisaRubric } from "../../../src/types/rubric";
import { answer, crit } from "./rubric-harness";

/* eslint-disable @typescript-eslint/no-explicit-any */

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** A made-up guidance page, one rule per line. */
const LINES = [
  "Part 9. Refusals.",
  "9.1 A resident of Qcland must be refused entry clearance.",
  "9.2 A holder of a Qdland residence permit must be refused entry clearance.",
  "9.3 A national of a Zq member state must be refused entry clearance.",
];
const RES = "A resident of Qcland must be refused entry clearance.";
const HOLDS = "A holder of a Qdland residence permit must be refused entry clearance.";
const BLOC = "A national of a Zq member state must be refused entry clearance.";

/** The page as the snapshot store returns it. */
function snapshot(text: string): GuidanceSnapshotContent {
  return { schemaVersion: 1, sourceId: "groups-doc", contentHash: sha256(text), docType: "html", url: "https://rules.example/groups", finalUrl: "https://rules.example/groups", fetchedAt: "2026-11-11T01:00:00.000Z", text, pages: null } as GuidanceSnapshotContent;
}
const DOC = snapshot(LINES.join("\n"));
const INDEX = new SnapshotQuoteIndex(DOC);
const BASE = { sourceId: DOC.sourceId, url: DOC.url, contentHash: DOC.contentHash, retrievedAt: DOC.fetchedAt };
const CHUNK = { sourceId: DOC.sourceId, chunkIndex: 0 };

/** Draft one bar with these groups and run it through code's validation. */
function draft(quote: string, groups: any[], known: string[] = []) {
  const c = crit({ ref: "r", title: "Refused", kind: "mandatory_bar", stage: "suitability", severity: "critical", quote, appliesTo: { nationalities: [], asWritten: [], groups } });
  const out = assessChunkOutput(answer({ criteria: [c] }), CHUNK, INDEX, BASE, DEFAULT_SEVERITY_LEVELS, null, new Set(known));
  return { accepted: out.criteria[0]?.criterion as AssessmentCriterion | undefined, discards: out.discards };
}

describe("extraction: a drafted group is kept only as the quote and the listed authorities allow", () => {
  test("a residence member with a code and the quote's wording is kept, in its stored form", () => {
    const r = draft(RES, [{ kind: "residence", asWritten: "resident of Qcland", code: "qc" }]);
    assert.ok(r.accepted, JSON.stringify(r.discards));
    assert.deepEqual(r.accepted?.appliesTo?.groups, [{ kind: "residence", code: "QC", asWritten: "resident of Qcland" }]);
    // The reviewer is told the group's codes are the model's proposal.
    const flags = reviewFlagsFor({ criteria: [r.accepted as AssessmentCriterion], intakeQuestions: [] }, { chunkCount: 1, pagesEndingMidSentence: [] });
    assert.match(flags.find((f) => f.code === "nationality_codes_model_proposed")?.message ?? "", /appliesTo\.groups/);
  });

  test("a holds member needs a document kind and an issuer code (or a listed authority id)", () => {
    assert.ok(draft(HOLDS, [{ kind: "holds", asWritten: "holder of a Qdland residence permit", document: "residence_permit", issuer: "QD" }]).accepted);
    assert.equal(draft(HOLDS, [{ kind: "holds", asWritten: "holder of a Qdland residence permit", document: null, issuer: "QD" }]).accepted, undefined, "no kind: refused, never guessed");
    assert.equal(draft(HOLDS, [{ kind: "holds", asWritten: "holder of a Qdland residence permit", document: "residence_permit", issuer: "zq-made-up" }]).accepted, undefined, "an unlisted authority id is refused");
    assert.ok(draft(HOLDS, [{ kind: "holds", asWritten: "holder of a Qdland residence permit", document: "residence_permit", issuer: "zq-bloc" }], ["zq-bloc"]).accepted);
  });

  test("a members_of member is kept only with an authority id the drafting message listed", () => {
    const group = { kind: "members_of", asWritten: "national of a Zq member state", authorityId: "zq-bloc", fact: "nationality" };
    const refused = draft(BLOC, [group]);
    assert.equal(refused.accepted, undefined, "no list: the model cannot name any authority");
    assert.equal(refused.discards[0].reason, "invalid_shape");
    const kept = draft(BLOC, [group], ["zq-bloc"]);
    assert.deepEqual(kept.accepted?.appliesTo?.groups, [{ kind: "members_of", authorityId: "zq-bloc", fact: "nationality", asWritten: "national of a Zq member state" }]);
  });

  test("a member whose wording is not in the quote is refused (like a nationality name)", () => {
    const r = draft(RES, [{ kind: "residence", asWritten: "resident of Qeland", code: "QE" }]);
    assert.equal(r.accepted, undefined);
    assert.equal(r.discards[0].reason, "applies_to_not_in_quote");
  });

  test("rawGroupProblem names what is missing", () => {
    assert.equal(rawGroupProblem({ kind: "residence", asWritten: "resident of Qcland", code: "Q1" }, new Set()), "a residence group member needs a two-letter code");
    assert.equal(rawGroupProblem({ kind: "members_of", asWritten: "national of a Zq member state", authorityId: "zq-bloc", fact: "income" }, new Set(["zq-bloc"])), "a members_of group member needs a fact (nationality or residence)");
    assert.equal(rawGroupProblem({ kind: "nationality", asWritten: "national of Qaland" }, new Set()), "a group member's kind must be residence, holds or members_of");
  });
});

describe("the drafting prompt and message", () => {
  const chunk = { sourceId: DOC.sourceId, contentHash: DOC.contentHash, docType: "html", chunkIndex: 0, chunkCount: 1, text: LINES.join("\n") } as any;
  const limits = { maxOutputTokens: 1000, timeoutMs: 1000 };

  test("the prompt keeps 'never invent a code: otherwise uncoded', and names groups the same way", () => {
    assert.match(RUBRIC_SYSTEM_PROMPT, /goes in `appliesTo\.uncoded`, written exactly as the quote names it: it has no code, so never invent one/);
    assert.match(RUBRIC_SYSTEM_PROMPT, /`appliesTo\.groups`/);
    assert.match(RUBRIC_SYSTEM_PROMPT, /never invent one\. A member you cannot code this way stays in `appliesTo\.uncoded`\./);
  });

  test("blocs and treaties are listed only when there are any, and only on the criteria call", () => {
    const none = buildRubricRequest(chunk, DEFAULT_SEVERITY_LEVELS, limits, { routeName: "Route Q", sourceRole: "unspecified" });
    assert.doesNotMatch(none.user, /Blocs and treaties/);
    const listed = buildRubricRequest(chunk, DEFAULT_SEVERITY_LEVELS, limits, { routeName: "Route Q", sourceRole: "unspecified", groupAuthorities: [{ id: "zq-bloc", name: "Zq Union\nline two" }] });
    assert.match(listed.user, /Blocs and treaties \(id: name\): zq-bloc: Zq Union line two/);
    const intake = buildIntakeRequest(chunk, [], limits, { routeName: "Route Q", sourceRole: "unspecified", groupAuthorities: [{ id: "zq-bloc", name: "Zq Union" }] });
    assert.doesNotMatch(intake.user, /Blocs and treaties/, "the intake call is unchanged");
  });
});

describe("the independent check is shown groups only for a rule that has them", () => {
  const view = (rule: AssessmentCriterion) => ({ rule, listLeadIn: "", textBefore: "", textAfter: "" });
  const base = { criterionId: "c1", title: "Refused", kind: "mandatory_bar", stage: "suitability", severity: "critical", source: { quote: RES, sourceId: "s", url: "https://rules.example/s", contentHash: "a".repeat(64), retrievedAt: "2026-11-01T00:00:00.000Z" }, confidence: 0.9 } as AssessmentCriterion;
  const limits = { maxOutputTokens: 1000, timeoutMs: 1000 };

  test("an old-shape rule's JSON has no groups key; a rule with groups shows each member", () => {
    const old = buildBatchRequest("verification", [view({ ...base, appliesTo: { nationalities: ["QA"], asWritten: ["Qaland"] } })], limits);
    assert.doesNotMatch(old.user, /"groups"/);
    const withGroups = buildBatchRequest("verification", [view({ ...base, appliesTo: { nationalities: [], asWritten: [], groups: [{ kind: "residence", code: "QC", asWritten: "resident of Qcland" }] } })], limits);
    assert.match(withGroups.user, /"groups":\[\{"kind":"residence","code":"QC","asWritten":"resident of Qcland"\}\]/);
    assert.match(CHECKER_SYSTEM_PROMPT, /`groups`, when present, lists members decided by what a person holds/);
  });
});

describe("the stored-rubric validator", () => {
  const stored = (over: Partial<AssessmentCriterion>): AssessmentCriterion => ({
    criterionId: "v1",
    title: "Refused",
    kind: "mandatory_bar",
    stage: "suitability",
    severity: "critical",
    source: { quote: RES, sourceId: "s", url: "https://rules.example/s", contentHash: "a".repeat(64), retrievedAt: "2026-11-01T00:00:00.000Z" },
    confidence: 0.9,
    ...over,
  } as AssessmentCriterion);

  test("a bar whose only members are groups is valid", () => {
    const c = stored({ appliesTo: { nationalities: [], asWritten: [], groups: [{ kind: "members_of", authorityId: "zq-bloc", fact: "residence", asWritten: "resident of a Zq member" }] } });
    assert.deepEqual(validateCriterionShape(c, DEFAULT_SEVERITY_LEVELS), []);
  });

  test("a malformed group is refused, with a plain reason", () => {
    const c = stored({ appliesTo: { nationalities: [], asWritten: [], groups: [{ kind: "residence", code: "Qc", asWritten: "resident of Qcland" } as any] } });
    assert.deepEqual(validateCriterionShape(c, DEFAULT_SEVERITY_LEVELS).map((i) => i.code), ["applies_to_group_invalid"]);
    assert.equal(storedGroupProblem({ kind: "nationality", code: "QA", asWritten: "national of Qaland" }), "a nationality member goes in appliesTo.nationalities / asWritten, not appliesTo.groups");
    assert.equal(storedGroupProblem({ kind: "members_of", authorityId: "QA", fact: "nationality", asWritten: "national of a member" }), "a members_of group needs the id of a bloc or treaty authority");
    assert.equal(storedGroupProblem({ kind: "holds", document: "visa", issuer: "zq-bloc", asWritten: "holder of a Zq visa" }), null);
  });

  test("a fact trigger must have a usable shape and sit on a scoped rule", () => {
    const rubricWith = (c: AssessmentCriterion) => ({ schemaVersion: 1, routeKey: "QX_qx-visit", countryCode: "QX", visaTypeId: "qx-visit", version: 1, severityLevels: [...DEFAULT_SEVERITY_LEVELS], criteria: [c], intakeQuestions: [], evidenceItems: [] }) as unknown as VisaRubric;
    const objective = (over: Partial<AssessmentCriterion>) => stored({ kind: "objective", check: { field: "funds.balance", op: "present" }, appliesTo: undefined, ...over });
    const codes = (c: AssessmentCriterion) => validateVisaRubric(rubricWith(c)).errors.filter((e: any) => e.target === "v1").map((e: any) => e.code);
    assert.deepEqual(codes(objective({ applicability: "conditional", factTrigger: { fact: "nationality", anyOf: ["QA"] } })), []);
    assert.deepEqual(codes(objective({ applicability: "conditional", factTrigger: { fact: "nationality", anyOf: ["qa"] } })), ["criterion_fact_trigger_invalid"]);
    assert.deepEqual(codes(objective({ applicability: "all_applicants", factTrigger: { fact: "residence", anyOf: ["QA"] } })), ["criterion_fact_trigger_unscoped"]);
  });
});
