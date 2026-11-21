// ============================================
// Unit tests — date-relative objective checks (issue #444)
// ============================================
//
// A rule like FIN 7.1 of the Standard Visitor v2 rulebook ("financial evidence
// dated within 31 days of the application") used to be checked by asking the
// model for a field no document prints, so every applicant whose uploads were
// all readable failed it with "We couldn't find this in your documents". Now
// code measures it from the dates the review READ on the documents that count
// (#418's caseworker read), against the application date (`barDateOf`).
//
// Part 1 replays the rulebook fixture (a read-only copy of the live v2) through
// the pure engine. Part 2 runs the real AiCaseOfficerService over the in-memory
// Firestore with a ScriptedProvider on a small fictional rulebook of the same
// shape (no network, no real model, no spend). Every date is fixed: `now` is
// injected, never the real clock.

import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";
import { Timestamp } from "firebase-admin/firestore";
import { ROLES } from "@durin-tech/authz";
import { store } from "../helpers/fake-firestore";
import {
  assembleContent,
  buildExtractionRequest,
  CASEWORKER_FIELD_NAMES,
  dateRelativeChecksOf,
  documentDateOf,
  documentFieldsFor,
  evaluateObjective,
  evidenceItemChoicesFor,
  extractionSchema,
  figuresAreGrounded,
  narrativeGroundingOf,
  noDocumentDateReason,
  parseExtraction,
  type DocumentExtraction,
  type ExtractedValue,
  type ObjectiveOptions,
} from "../../src/services/ai/assessment-engine";
import { extractOneDocument } from "../../src/services/ai/document-extraction";
import { CHECK_FIELDS } from "../../src/services/ai/document-check-engine";
import { ASSESSMENT_PROMPT_VERSION } from "../../src/services/ai/prompt-safety";
import { barDateOf } from "../../src/services/ai-case-officer.service";
import { envelope } from "../../src/services/ai/tier-serializer";
import type { EvidenceItem, VisaRubric } from "../../src/types/rubric";
import type { LlmRequest } from "../../src/services/ai/llm-provider";
import {
  criterion,
  docBytes,
  fictionalRubric,
  installAssessmentFakes,
  keyOfBytes,
  resetAll,
  routeARubric,
  rubricBook,
  ScriptedProvider,
  seedApplication,
  seedDocument,
  seedEligibility,
  seedStatement,
  seedUser,
  serviceWith,
} from "./harness";
import fixture from "./fixtures/uk-standard-visitor-v2-308.json";

/* eslint-disable @typescript-eslint/no-explicit-any */

// ============================================
// Fixtures and helpers
// ============================================

/** The live v2 rulebook (fixture copy). */
const V2 = fixture.rubric as unknown as VisaRubric;
/** FIN 7.1's criterion id in the fixture (the only date-relative check a document item names). */
const FIN = "crit_a441f774ac3adf58";
/** Its checked field, as the rulebook stores it (never asked of the model any more). */
const FIN_FIELD = "financialEvidence.mostRecentDaysBeforeApplication";
/** The title of the document item that names it. */
const FIN_TITLE = "Financial evidence (most recent dated within 31 days of application)";
/** V 17.3(a): an `lte` duration check NO document item names (a length of stay). */
const STAY = "crit_b519396347206c2b";

/** The review date of every test: 21 November 2026. */
const REVIEW_NOW = new Date("2026-11-21T09:00:00Z");

/** One extraction result, read cleanly unless `extra` says otherwise. */
function ext(id: string, values: Array<Partial<ExtractedValue> & { field: string; value: ExtractedValue["value"] }>, extra: Partial<DocumentExtraction> = {}): DocumentExtraction {
  return {
    documentId: id,
    label: "fixture",
    mediaType: "application/pdf",
    readable: true,
    failed: false,
    failure: null,
    suspicious: false,
    values: values.map((v) => ({ unit: null, page: 1, quote: null, ...v })),
    documentKind: "bank_statement",
    ...extra,
  };
}

/** A `general` upload read as financial evidence, with a statement period end. */
function statement(id: string, periodEnd: string | null, extra: Partial<DocumentExtraction> = {}): DocumentExtraction {
  return ext(id, periodEnd === null ? [] : [{ field: "statementPeriodEnd", value: periodEnd }], { evidenceItems: ["financial_evidence"], ...extra });
}

/** FIN 7.1's result on the v2 rulebook for these uploads, measured on `applicationDate`. */
function fin(docs: DocumentExtraction[], opts: ObjectiveOptions = { applicationDate: "2026-11-21" }) {
  return evaluateObjective(V2, {}, docs, opts).find((r) => r.criterionId === FIN)!;
}

/** A small fictional rulebook with one dated check of the given limit, named by one item. */
function datedRulebook(limit: { value: number; unit: "days" | "weeks" | "months" | "years" }): VisaRubric {
  const rubric = fictionalRubric({
    countryCode: "AA",
    visaTypeId: "route-a",
    intentPolarity: "immigrant_intent_penalised",
    criteria: [
      criterion({ criterionId: "c-recent", title: "Recent evidence", kind: "objective", stage: "eligibility", severity: "high", check: { field: "evidence.ageOfLatest", op: "lte", value: limit.value, unit: limit.unit } }),
      criterion({ criterionId: "a-genuine", title: "Genuine visit factors", kind: "judgement", stage: "credibility", severity: "high", probeFactors: ["purpose of the visit"] }),
    ],
  });
  rubric.evidenceItems = [item("funds", "Recent funds evidence", ["c-recent"]), item("id", "Identity document", [])];
  return rubric;
}

/** A rulebook document item. */
function item(key: string, title: string, criterionIds: string[]): EvidenceItem {
  return { key, title, party: "applicant", criterionIds, source: { quote: "q", sourceId: "s", url: "https://example.test", contentHash: "h", retrievedAt: "2026-11-01T00:00:00.000Z" } } as EvidenceItem;
}

// ============================================
// Part 1: the v2 rulebook (pure engine)
// ============================================

describe("#444 date-relative checks are found from the rulebook's data", () => {
  test("on the v2 fixture FIN 7.1 is the only date-relative check, measured over 31 days, named by the financial evidence item", () => {
    const checks = dateRelativeChecksOf(V2);
    assert.deepEqual([...checks.keys()], [FIN]);
    const c = checks.get(FIN)!;
    assert.deepEqual(c.maxAge, { value: 31, unit: "days" });
    assert.deepEqual(c.itemKeys, ["financial_evidence"]);
    assert.deepEqual(c.titles, [FIN_TITLE]);
  });

  test("without document items no check is date-relative (and nothing about the field list changes)", () => {
    const bare = { criteria: V2.criteria } as VisaRubric;
    assert.equal(dateRelativeChecksOf(bare).size, 0);
    assert.ok(documentFieldsFor(bare).includes(FIN_FIELD), "the pre-#444 list, field included");
  });
});

describe("#444 the model is never asked for the day count", () => {
  const items = evidenceItemChoicesFor(V2);
  const fields = documentFieldsFor(V2);
  const req = buildExtractionRequest({ label: "document 1", mediaType: "application/pdf", data: "AA==" }, fields, { caseworkerRead: true, evidenceItems: items });
  const listed = /Fields to report: ([^\n]*)\./.exec(req.user)![1].split(", ");
  const enumOf = (req.schema as any).properties.values.items.properties.field.enum as string[];

  test("the review's extraction request leaves FIN 7.1's field out, and asks for the document's own dates", () => {
    assert.equal(fields.includes(FIN_FIELD), false);
    assert.equal(listed.includes(FIN_FIELD), false);
    assert.equal(enumOf.includes(FIN_FIELD), false);
    for (const f of ["statementPeriodEnd", "documentDate", "statementPeriodStart"]) {
      assert.ok(listed.includes(f), f);
      assert.ok(enumOf.includes(f), f);
    }
  });

  test("the extraction schema is still values only, with the evidence items included", () => {
    const text = JSON.stringify(req.schema);
    assert.ok(text.includes("evidenceItems"));
    for (const forbidden of ["\"pass\"", "\"fail\"", "\"verdict\"", "\"meets\"", "\"outcome\"", "\"decision\""]) {
      assert.ok(!text.includes(forbidden), `the extraction schema must not contain ${forbidden}`);
    }
    // Same for the schema builder on its own.
    const direct = JSON.stringify(extractionSchema(["statementPeriodEnd"], { documentKind: true, evidenceItemCodes: ["E1", "E2"] }));
    for (const forbidden of ["\"pass\"", "\"fail\"", "\"verdict\"", "\"meets\""]) assert.ok(!direct.includes(forbidden));
  });

  test("a value the model returns under FIN 7.1's field is ignored: the outcome comes only from the dates read", () => {
    const told = ext("d1", [{ field: FIN_FIELD, value: 10, unit: "days" }], { evidenceItems: ["financial_evidence"] });
    const r = fin([told]);
    assert.notEqual(r.outcome, "pass");
    assert.equal(r.outcome, "insufficient");
    assert.equal(r.reason, noDocumentDateReason(FIN_TITLE));
  });

  test("a check that is not date-relative is untouched: V 17.3(a) (no document item names it) reads its value as before, and stays in the request", () => {
    assert.ok(listed.includes("totalPeriodInUK"));
    const within = evaluateObjective(V2, {}, [ext("d1", [{ field: "totalPeriodInUK", value: 3, unit: "months" }])], { applicationDate: "2026-11-21" }).find((r) => r.criterionId === STAY)!;
    const over = evaluateObjective(V2, {}, [ext("d1", [{ field: "totalPeriodInUK", value: 8, unit: "months" }])], { applicationDate: "2026-11-21" }).find((r) => r.criterionId === STAY)!;
    const absent = evaluateObjective(V2, {}, [ext("d1", [])], { applicationDate: "2026-11-21" }).find((r) => r.criterionId === STAY)!;
    // The pre-#444 outcomes: compared as a value; missing -> not checkable (no item names it).
    assert.deepEqual([within.outcome, within.reason], ["pass", "totalPeriodInUK compared"]);
    assert.deepEqual([over.outcome, over.reason], ["fail", "totalPeriodInUK compared"]);
    assert.deepEqual([absent.outcome, absent.notAssessed], ["insufficient", "not_in_documents"]);
    // Identical with no options at all (the pre-#444 call).
    assert.deepEqual(evaluateObjective(V2, {}, [ext("d1", [{ field: "totalPeriodInUK", value: 3, unit: "months" }])]).find((r) => r.criterionId === STAY), within);
  });
});

describe("#444 which document an upload is evidence for (the evidence-items read)", () => {
  const items = evidenceItemChoicesFor(V2);
  const doc = { label: "document 1", mediaType: "application/pdf" as const, data: "AA==" };

  test("on a rulebook with a date-relative check the review's request lists the items by E-id with their titles, and the schema enum is those ids", () => {
    assert.equal(items.length, V2.evidenceItems.length);
    assert.deepEqual(items.map((i) => i.code), V2.evidenceItems.map((_, i) => `E${i + 1}`));
    const req = buildExtractionRequest(doc, documentFieldsFor(V2), { caseworkerRead: true, evidenceItems: items });
    assert.ok(req.user.includes(`E1: ${FIN_TITLE}`), req.user);
    assert.deepEqual((req.schema as any).properties.evidenceItems, { type: "array", items: { type: "string", enum: items.map((i) => i.code) } });
    assert.ok((req.schema as any).required.includes("evidenceItems"));
    assert.ok(req.system.includes("evidenceItems"));
    assert.ok(/Do not count days/.test(req.system));
  });

  test("the parser accepts only listed ids, maps them back to item keys in code, and fails on an unknown id", () => {
    const fields = ["statementPeriodEnd"];
    const answer = (evidenceItems: unknown) => JSON.stringify({ readable: true, documentKind: "bank_statement", values: [], evidenceItems });
    const ok = parseExtraction(answer(["E1", "E3", "E1"]), fields, { documentKind: true, evidenceItems: items });
    assert.ok(ok.ok);
    assert.deepEqual((ok as any).evidenceItems, ["financial_evidence", "bank_statements"]);
    const none = parseExtraction(answer([]), fields, { documentKind: true, evidenceItems: items });
    assert.deepEqual((none as any).evidenceItems, []);
    const missing = parseExtraction(JSON.stringify({ readable: true, documentKind: "bank_statement", values: [] }), fields, { documentKind: true, evidenceItems: items });
    assert.deepEqual((missing as any).evidenceItems, [], "absent reads as evidence for none");
    for (const bad of [["E99"], ["financial_evidence"], [1], "E1"]) {
      const out = parseExtraction(answer(bad), fields, { documentKind: true, evidenceItems: items });
      assert.equal(out.ok, false, JSON.stringify(bad));
    }
    // Not asked: the key is unexpected, as any other extra key.
    assert.equal(parseExtraction(answer(["E1"]), fields, { documentKind: true }).ok, false);
  });

  test("an unknown id fails the extraction end to end (counted as unread, never a pass)", async () => {
    const provider = new ScriptedProvider(() => JSON.stringify({ readable: true, documentKind: "bank_statement", values: [], evidenceItems: ["E42"] }));
    const out = await extractOneDocument({ provider, documentId: "d1", label: "document 1", bytes: docBytes("x"), fields: [], caseworkerRead: true, evidenceItems: items });
    assert.equal(out.extraction.failed, true);
    assert.equal(out.failureCode, "bad_answer");
    const good = new ScriptedProvider(() => JSON.stringify({ readable: true, documentKind: "bank_statement", values: [], evidenceItems: ["E1"] }));
    const read = await extractOneDocument({ provider: good, documentId: "d1", label: "document 1", bytes: docBytes("x"), fields: [], caseworkerRead: true, evidenceItems: items });
    assert.deepEqual(read.extraction.evidenceItems, ["financial_evidence"]);
  });

  test("a rulebook with no date-relative check sends exactly the #418 request (no evidenceItems)", () => {
    const routeA = routeARubric();
    assert.deepEqual(evidenceItemChoicesFor(routeA), []);
    const fields = documentFieldsFor(routeA);
    const withNone = buildExtractionRequest(doc, fields, { caseworkerRead: true, evidenceItems: evidenceItemChoicesFor(routeA) });
    assert.deepEqual(withNone, buildExtractionRequest(doc, fields, { caseworkerRead: true }));
    assert.equal("evidenceItems" in (withNone.schema as any).properties, false);
    assert.ok(!withNone.system.includes("evidenceItems"));
    assert.ok(!withNone.user.includes("Evidence items"));
  });

  test("the per-upload document check's request (CHECK_FIELDS, no caseworker read) is unchanged, and evidence items are ignored without the caseworker read", () => {
    const plain = buildExtractionRequest(doc, CHECK_FIELDS);
    assert.deepEqual(buildExtractionRequest(doc, CHECK_FIELDS, { evidenceItems: items }), plain);
    assert.deepEqual((plain.schema as any).required, ["readable", "values"]);
    assert.deepEqual((plain.schema as any).properties.values.items.properties.field.enum, [...CHECK_FIELDS]);
    assert.equal(plain.user, `Fields to report: ${CHECK_FIELDS.join(", ")}.\n` + plain.user.split("\n").slice(1).join("\n"));
  });
});

describe("#444 code decides FIN 7.1 (v2 fixture, 31 days)", () => {
  test("draft reviewed 2026-11-21, a general upload read as financial evidence, period end 2026-11-02: pass (19 days), with the reason in plain words", () => {
    const appDate = barDateOf({ submittedAt: undefined } as any, REVIEW_NOW);
    assert.equal(appDate, "2026-11-21");
    const r = fin([statement("d1", "2026-11-02")], { applicationDate: appDate, uploadSlots: { d1: "general" } });
    assert.equal(r.outcome, "pass");
    assert.equal(r.reason, `Your most recent ${FIN_TITLE} is dated 2 November 2026, 19 days before 21 November 2026.`);
  });

  test("exactly 31 days before (2026-10-21) passes; 32 days before (2026-10-20) fails", () => {
    assert.equal(fin([statement("d1", "2026-10-21")]).outcome, "pass");
    const late = fin([statement("d1", "2026-10-20")]);
    assert.equal(late.outcome, "fail");
    assert.equal(late.reason, `Your most recent ${FIN_TITLE} is dated 20 October 2026, 32 days before 21 November 2026. It must be within 31 days.`);
    assert.equal(fin([statement("d1", "2026-09-01")]).reason, `Your most recent ${FIN_TITLE} is dated 1 September 2026, 81 days before 21 November 2026. It must be within 31 days.`);
  });

  test("submitted 2026-10-01, reviewed 2026-11-21, period end 2026-09-20: pass (11 days, from submittedAt); the same upload on a draft fails", () => {
    const submitted = barDateOf({ submittedAt: Timestamp.fromDate(new Date("2026-10-01T12:00:00Z")) } as any, REVIEW_NOW);
    assert.equal(submitted, "2026-10-01");
    const r = fin([statement("d1", "2026-09-20")], { applicationDate: submitted });
    assert.equal(r.outcome, "pass");
    assert.ok(r.reason.includes("11 days before 1 October 2026"), r.reason);
    assert.equal(fin([statement("d1", "2026-09-20")], { applicationDate: barDateOf({} as any, REVIEW_NOW) }).outcome, "fail");
  });

  test("a missing or malformed submittedAt uses the review date (as barDateOf does)", () => {
    for (const app of [{}, { submittedAt: null }, { submittedAt: { _seconds: 1 } }, { submittedAt: "2026-10-01" }]) {
      const date = barDateOf(app as any, REVIEW_NOW);
      assert.equal(date, "2026-11-21", JSON.stringify(app));
      assert.equal(fin([statement("d1", "2026-09-20")], { applicationDate: date }).outcome, "fail");
    }
  });

  test("two counted documents dated 2026-08-01 and 2026-11-10: the most recent one decides (pass)", () => {
    const r = fin([statement("d1", "2026-08-01"), statement("d2", "2026-11-10")]);
    assert.equal(r.outcome, "pass");
    assert.ok(r.reason.includes("10 November 2026, 11 days before"), r.reason);
  });

  test("a document with both a statement period end and a document date uses the later of the two", () => {
    const both = ext("d1", [{ field: "statementPeriodEnd", value: "2026-09-30" }, { field: "documentDate", value: "5 November 2026" }], { evidenceItems: ["financial_evidence"] });
    assert.equal(documentDateOf(both), "2026-11-05");
    const r = fin([both]);
    assert.equal(r.outcome, "pass");
    assert.ok(r.reason.includes("5 November 2026, 16 days before"), r.reason);
    // The period START, an expiry or a tenancy date never dates the document.
    const others = ext("d2", [{ field: "statementPeriodStart", value: "2026-11-15" }, { field: "expiryDate", value: "2026-11-20" }, { field: "tenancyStart", value: "2026-11-19" }], { evidenceItems: ["financial_evidence"] });
    assert.equal(documentDateOf(others), null);
    assert.equal(fin([others]).outcome, "insufficient");
  });

  test("a month-unit check is measured in calendar months: 3 months before 2026-11-21 is 2026-08-21", () => {
    const rubric = datedRulebook({ value: 3, unit: "months" });
    const one = (date: string) => evaluateObjective(rubric, {}, [ext("d1", [{ field: "documentDate", value: date }], { evidenceItems: ["funds"] })], { applicationDate: "2026-11-21" })[0];
    assert.equal(one("2026-08-21").outcome, "pass");
    const late = one("2026-08-20");
    assert.equal(late.outcome, "fail");
    assert.ok(late.reason.endsWith("It must be within 3 months."), late.reason);
  });

  test("a week-unit check is measured as 7 days a week", () => {
    const rubric = datedRulebook({ value: 2, unit: "weeks" });
    const one = (date: string) => evaluateObjective(rubric, {}, [ext("d1", [{ field: "documentDate", value: date }], { evidenceItems: ["funds"] })], { applicationDate: "2026-11-21" })[0];
    assert.equal(one("2026-11-07").outcome, "pass", "14 days");
    assert.equal(one("2026-11-06").outcome, "fail", "15 days");
    assert.ok(one("2026-11-06").reason.endsWith("It must be within 2 weeks."));
  });

  test("an upload made to ev-financial_evidence counts even when the model read no evidenceItems for it", () => {
    const r = fin([ext("d1", [{ field: "statementPeriodEnd", value: "2026-11-02" }], { evidenceItems: [] })], { applicationDate: "2026-11-21", uploadSlots: { d1: "ev-financial_evidence" } });
    assert.equal(r.outcome, "pass");
    // Also with no evidence-items read at all (the key absent).
    assert.equal(fin([ext("d1", [{ field: "statementPeriodEnd", value: "2026-11-02" }])], { applicationDate: "2026-11-21", uploadSlots: { d1: "ev-financial_evidence" } }).outcome, "pass");
  });

  test("an upload made to another item's slot (ev-passport) and read as financial evidence does not count", () => {
    const r = fin([statement("d1", "2026-11-02")], { applicationDate: "2026-11-21", uploadSlots: { d1: "ev-passport" } });
    assert.equal(r.outcome, "fail");
    assert.equal(r.reason, `We couldn't find this in your documents: ${FIN_TITLE}`);
  });

  test("a suspicious document's dates are not used", () => {
    const flagged = statement("d1", "2026-11-02", { suspicious: true });
    assert.equal(documentDateOf(flagged), null);
    const r = fin([flagged]);
    assert.notEqual(r.outcome, "pass");
    assert.equal(r.outcome, "insufficient");
  });
});

describe("#444 missing or unparseable dates are unknown, never a fail", () => {
  test("counted documents with no usable date (none read, ambiguous 03/04/2026, unreadable text): insufficient, the item named, not a refusal ground", () => {
    for (const value of [null, "03/04/2026", "sometime last month"]) {
      const d = value === null ? statement("d1", null) : statement("d1", value);
      const r = fin([d]);
      assert.equal(r.outcome, "insufficient", String(value));
      assert.equal(r.reason, `We couldn't read a date on your ${FIN_TITLE}`);
    }
    // Assembled: an open item, not a refusal ground.
    const objective = evaluateObjective(V2, {}, [statement("d1", "03/04/2026")], { applicationDate: "2026-11-21" });
    const content = assembleContent({ rubric: V2, mandatoryHits: [], objective, judgement: null, documents: [statement("d1", "03/04/2026")], statementReadable: false, score: 80, suspiciousDocumentIds: [], judgementFailed: false });
    assert.ok(!content.refusalGrounds.some((g) => g.criterionId === FIN));
    assert.ok(content.insufficientInformation.some((i) => i.criterionId === FIN && i.reason === noDocumentDateReason(FIN_TITLE)));
  });

  test("the only usable dates are after the application date: insufficient, same reason", () => {
    const r = fin([statement("d1", "2026-11-25")]);
    assert.deepEqual([r.outcome, r.reason], ["insufficient", noDocumentDateReason(FIN_TITLE)]);
    // A later date beside a usable one: the usable one is measured.
    const mixed = ext("d1", [{ field: "statementPeriodEnd", value: "2026-11-02" }, { field: "documentDate", value: "2026-12-01" }], { evidenceItems: ["financial_evidence"] });
    assert.equal(fin([mixed]).outcome, "pass");
  });

  test("read dates too old, another counted upload unread (unreadable, failed, password protected): insufficient; a read date that passes still passes", () => {
    const unread = [
      ext("d2", [], { readable: false, failure: "file could not be read" }),
      ext("d2", [], { readable: false, failed: true, failure: "the model call failed" }),
      ext("d2", [], { readable: false, failure: "the file is password protected" }),
    ];
    for (const u of unread) {
      for (const slots of [{ d2: "ev-financial_evidence" }, { d2: "general" }]) {
        const old = fin([statement("d1", "2026-08-01"), u], { applicationDate: "2026-11-21", uploadSlots: slots });
        assert.equal(old.outcome, "insufficient", `${u.failure} ${JSON.stringify(slots)}`);
        assert.ok(old.reason.includes("Another upload could not be read"), old.reason);
        assert.equal(fin([statement("d1", "2026-11-02"), u], { applicationDate: "2026-11-21", uploadSlots: slots }).outcome, "pass");
      }
    }
    // An unread upload in ANOTHER item's slot is never this evidence: the old date fails.
    assert.equal(fin([statement("d1", "2026-08-01"), unread[0]], { applicationDate: "2026-11-21", uploadSlots: { d2: "ev-passport" } }).outcome, "fail");
  });

  test("no counted document and every upload read cleanly: today's 'We couldn't find this in your documents' ground (a passport and a payslip)", () => {
    const passport = ext("d1", [{ field: "documentDate", value: "2026-11-01" }], { documentKind: "passport", evidenceItems: ["passport"] });
    const payslip = ext("d2", [{ field: "documentDate", value: "2026-11-01" }], { documentKind: "payslip", evidenceItems: [] });
    const r = fin([passport, payslip], { applicationDate: "2026-11-21", uploadSlots: { d1: "general", d2: "general" } });
    assert.deepEqual([r.outcome, r.reason], ["fail", `We couldn't find this in your documents: ${FIN_TITLE}`]);
  });

  test("no counted document and some upload could not be read: insufficient, as today", () => {
    const r = fin([ext("d1", [], { documentKind: "passport", evidenceItems: [] }), ext("d2", [], { readable: false })]);
    assert.deepEqual([r.outcome, r.reason], ["insufficient", `${FIN_FIELD} could not be read`]);
  });

  test("no uploads at all: the same outcome as today", () => {
    const r = fin([]);
    assert.deepEqual([r.outcome, r.reason], ["insufficient", `${FIN_FIELD} could not be read`]);
  });

  test("no application date (the bulk path today): no document is counted, so the 'no counted document' rules apply", () => {
    assert.equal(fin([statement("d1", "2026-11-02")], {}).outcome, "fail");
    assert.equal(fin([statement("d1", "2026-11-02"), ext("d2", [], { readable: false })], {}).outcome, "insufficient");
  });
});

describe("#444 the narrative may repeat the code-written dates", () => {
  test("a paragraph repeating the reason's date and day count is grounded only through the code-written reasons", () => {
    const reason = fin([statement("d1", "2026-11-02")]).reason;
    const input = {
      readiness: "strong" as const,
      findings: { refusalGrounds: [], credibilityFlags: [], statementFindings: [], insufficientInformation: [], strengths: [] },
      profileSummary: "Applicant name: Ada Lovelace.",
      intakeSummary: "{}",
      extractionSummary: "[D1]\nstatementPeriodEnd: 2026-11-02 (page 1)",
      statementText: null,
    };
    const paragraph = "Your latest statement is dated 2 November 2026, 19 days before 21 November 2026, so it is recent enough.";
    const without = narrativeGroundingOf({ ...input, figureFacts: { values: [], moneyFields: [] } });
    const withReasons = narrativeGroundingOf({ ...input, figureFacts: { values: [], moneyFields: [], codeWritten: [reason] } });
    assert.equal(figuresAreGrounded(paragraph, without.figureSources), false, "19 and 21 are in no input");
    assert.equal(figuresAreGrounded(paragraph, withReasons.figureSources), true);
    // Not a quote source.
    assert.ok(!withReasons.quoteSources.includes(reason));
    // A figure nothing holds is still not grounded.
    assert.equal(figuresAreGrounded("It is dated 45 days before.", withReasons.figureSources), false);
  });
});

// ============================================
// Part 2: the review job (ScriptedProvider)
// ============================================

/** The scripted extraction answer: a statement read as evidence item E1 (funds), with a period end. */
function bankAnswer(periodEnd: string, evidenceItems: string[] = ["E1"]): string {
  return JSON.stringify({
    readable: true,
    documentKind: "bank_statement",
    values: [
      { field: "closingBalance", value: 1480000, unit: null, page: 1, quote: "closing" },
      { field: "statementPeriodEnd", value: periodEnd, unit: null, page: 1, quote: "to" },
    ],
    evidenceItems,
  });
}

/** An empty, valid judgement answer. */
const JUDGE = JSON.stringify({ findings: [], strengths: [], statementNotes: [], suspiciousPassages: [] });

/** The conclusion opening a narrative request asks for. */
function leadOf(req: LlmRequest): string {
  return /Required opening of the conclusion: "([^"]+)"/.exec(req.user)![1];
}

/** A provider for the job: the extraction answer per document key, and the narrative paragraphs. */
function provider(answers: Record<string, string>, paragraphs: string[] = ["You told us you will return home at the end of the visit."]): ScriptedProvider {
  return new ScriptedProvider((req, key) => {
    if (req.role === "extraction") return answers[key ?? ""] ?? JSON.stringify({ readable: true, documentKind: "other", values: [], evidenceItems: [] });
    if (req.role === "judgement") return JUDGE;
    return JSON.stringify({ paragraphs, conclusion: `${leadOf(req)} you will leave at the end of your visit.`, nextSteps: [] });
  });
}

/** Seed the applicant (a draft unless `submittedAt` is given). */
function seedApplicant(submittedAt?: string): void {
  seedApplication({ id: "app-1" });
  if (submittedAt) (store.get("applications/app-1") as any).submittedAt = Timestamp.fromDate(new Date(submittedAt));
  seedUser("client-1", "Ada", "Lovelace");
  seedEligibility({ nationality: "AA", score: 80 });
  seedStatement({ id: "stmt-1", text: "I will return home at the end of the visit." });
}

/** Seed one upload, made to the given checklist slot. */
function seedUpload(id: string, key: string, requirementId: string): void {
  seedDocument({ id, key, label: "Bank statement" });
  (store.get(`documents/${id}`) as any).requirementId = requirementId;
}

/** Request then run the job at REVIEW_NOW; returns the stored assessment. */
async function assessOnce(p: ScriptedProvider): Promise<any> {
  const svc = serviceWith(p, {}, { now: () => REVIEW_NOW });
  const app = { id: "app-1", ...(store.get("applications/app-1") as any) } as any;
  const out: any = await svc.requestAssessment(app, { tier: "full", trigger: "manual", requestedBy: "tester" });
  if (out.assessmentId && (out.kind === "created" || out.kind === "queued")) await svc.runJob(out.assessmentId);
  return store.get(`applicationAssessments/${out.assessmentId}`) as any;
}

describe("#444 the review job", () => {
  beforeEach(async () => {
    resetAll();
    await installAssessmentFakes();
    rubricBook.set("AA_route-a", datedRulebook({ value: 31, unit: "days" }));
  });

  test("a general upload read as the dated item, period end 10 days before a draft's review date: pass, measuredOn stored, the record says why; no new call", async () => {
    seedApplicant();
    seedUpload("doc-1", "bank", "general");
    const p = provider({ bank: bankAnswer("2026-11-11") });
    const stored = await assessOnce(p);
    assert.equal(stored.status, "succeeded");
    // No new call: 1 extraction + 1 judgement + 1 narrative.
    assert.deepEqual([p.callsFor("extraction"), p.callsFor("judgement"), p.callsFor("narrative")], [1, 1, 1]);
    // The extraction asked which items the document is, and not for the dated field.
    const req = p.requests.find((r) => r.role === "extraction")!;
    assert.ok(req.user.includes("E1: Recent funds evidence") && req.user.includes("E2: Identity document"));
    assert.ok(!/Fields to report: [^\n]*evidence\.ageOfLatest/.test(req.user));
    assert.deepEqual(/Fields to report: ([^\n]*)\./.exec(req.user)![1].split(", "), [...CASEWORKER_FIELD_NAMES]);
    // The rule passed: no ground, no open item.
    assert.ok(!stored.refusalGrounds.some((g: any) => g.criterionId === "c-recent"));
    assert.ok(!stored.insufficientInformation.some((i: any) => i.criterionId === "c-recent"));
    assert.equal(stored.stageOutcomes.objective, "clear");
    // Staff-only record.
    assert.equal(stored.measuredOn, "2026-11-21");
    assert.deepEqual(stored.documentsRead, [{ documentId: "doc-1", documentKind: "bank_statement", readable: true, reason: null, valueCount: 2, evidenceItems: ["funds"], documentDate: "2026-11-11" }]);
    assert.equal(stored.promptVersion, ASSESSMENT_PROMPT_VERSION);
    assert.notEqual(ASSESSMENT_PROMPT_VERSION, "assessment-2026-11-21.1", "bumped for #444");
  });

  test("a submitted application is measured from submittedAt, not the review date", async () => {
    seedApplicant("2026-10-01T12:00:00Z");
    seedUpload("doc-1", "bank", "general");
    const stored = await assessOnce(provider({ bank: bankAnswer("2026-09-20") }));
    assert.equal(stored.measuredOn, "2026-10-01");
    assert.ok(!stored.refusalGrounds.some((g: any) => g.criterionId === "c-recent"));
    // The same upload on a draft is too old on 21 November.
    resetAll();
    await installAssessmentFakes();
    rubricBook.set("AA_route-a", datedRulebook({ value: 31, unit: "days" }));
    seedApplicant();
    seedUpload("doc-1", "bank", "general");
    const draft = await assessOnce(provider({ bank: bankAnswer("2026-09-20") }));
    const ground = draft.refusalGrounds.find((g: any) => g.criterionId === "c-recent");
    assert.ok(ground, "fails on a draft");
    assert.equal(ground.detail, "Your most recent Recent funds evidence is dated 20 September 2026, 62 days before 21 November 2026. It must be within 31 days.");
  });

  test("an upload in the item's own slot counts with no evidence item read; one in another item's slot does not", async () => {
    seedApplicant();
    seedUpload("doc-1", "bank", "ev-funds");
    const slotted = await assessOnce(provider({ bank: bankAnswer("2026-11-11", []) }));
    assert.ok(!slotted.refusalGrounds.some((g: any) => g.criterionId === "c-recent"));
    resetAll();
    await installAssessmentFakes();
    rubricBook.set("AA_route-a", datedRulebook({ value: 31, unit: "days" }));
    seedApplicant();
    seedUpload("doc-1", "bank", "ev-id");
    const elsewhere = await assessOnce(provider({ bank: bankAnswer("2026-11-11", ["E1"]) }));
    assert.equal(elsewhere.refusalGrounds.find((g: any) => g.criterionId === "c-recent")?.detail, "We couldn't find this in your documents: Recent funds evidence");
  });

  test("a narrative paragraph repeating the code-written date and day count is kept by the figure check", async () => {
    seedApplicant();
    seedUpload("doc-1", "bank", "general");
    const kept = "Your latest statement is dated 11 November 2026, 10 days before 21 November 2026.";
    const stored = await assessOnce(provider({ bank: bankAnswer("2026-11-11") }, [kept, "It was 45 days old."]));
    assert.deepEqual(stored.narrative.paragraphs, [kept], "the made-up figure is still dropped");
  });

  test("measuredOn and the new documentsRead fields are in no applicant response; staff see them; the applicant's full-tier keys are unchanged", async () => {
    seedApplicant();
    seedUpload("doc-1", "bank", "general");
    const stored = await assessOnce(provider({ bank: bankAnswer("2026-11-11") }));
    const free: any = envelope(stored, "free", ROLES.CLIENT, null).data;
    const reading: any = envelope(stored, "full", ROLES.CLIENT, null, null, false).data;
    const full: any = envelope(stored, "full", ROLES.CLIENT, null, null, true).data;
    for (const body of [free, reading, full]) {
      const text = JSON.stringify(body);
      for (const key of ["measuredOn", "documentsRead", "evidenceItems", "documentDate"]) assert.equal(text.includes(key), false, key);
    }
    assert.deepEqual(Object.keys(full).sort(), [
      "agencyId", "applicationId", "attempt", "blockingRule", "confidence", "countryCode", "createdAt", "credibilityFlags", "error",
      "finishedAt", "hasBlockingRule", "id", "insufficientInformation", "model", "narrative", "rubricVersion", "readiness",
      "refusalGrounds", "score", "stageOutcomes", "startedAt", "statement", "statementFindings", "status", "strengths",
      "topIssues", "trigger", "userId", "visaTypeId",
    ].sort());
    const staff: any = envelope(stored, "full", ROLES.AGENT, null).data;
    assert.equal(staff.measuredOn, "2026-11-21");
    assert.deepEqual(staff.documentsRead[0].evidenceItems, ["funds"]);
    assert.equal(staff.documentsRead[0].documentDate, "2026-11-11");
    assert.equal("measuredOn" in (envelope(stored, "full", undefined, null, null, true).data as any), false, "no role: fail closed");
  });

  test("a rulebook with no date-relative check: the review's extraction request carries no evidenceItems", async () => {
    rubricBook.set("AA_route-a", routeARubric());
    seedApplicant();
    seedUpload("doc-1", "bank", "general");
    const p = provider({});
    await assessOnce(p);
    const req = p.requests.find((r) => r.role === "extraction")!;
    assert.equal("evidenceItems" in (req.schema as any).properties, false);
    assert.ok(!req.user.includes("Evidence items"));
    void keyOfBytes;
  });
});
