// ============================================
// Rubric validation: adversarial probes (issue #40, code review round 1)
// ============================================
//
// Each test here is an answer a careless or steered model could give that an
// earlier version of the validator ACCEPTED. They run against the real
// `assessChunkOutput`, on an invented document (invented places, paragraph
// numbers and figures; user-assigned country codes).
//
// The rule they pin down: what a criterion claims (a threshold, a unit, a
// date, a group, a rule reference, a number in its title) must be written in
// the criterion's OWN quote, and the quote must be whole words of one passage
// of its own source.
//
// Three probes are NOT rejections, on purpose, and say so:
//  - a quote that starts after a negation is verbatim and cannot be refused
//    by code; it is flagged for the reviewer (and documented in the README);
//  - right names with wrong country codes: codes are a model proposal the
//    reviewer confirms; the version is flagged per code;
//  - an invisible character in the model's copy of a quote: the quote is
//    found, and what is STORED is the source's text, without it.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { GuidanceSnapshotContent } from "../../../src/scrapers/guidance/types";
import { PDF_PAGE_SEPARATOR } from "../../../src/scrapers/shared/fetch/pdf-text";
import {
  SnapshotQuoteIndex,
  containsTokenBounded,
  dateSupported,
  datesIn,
  groupNameSupported,
  hasUnreadableDigits,
  numbersIn,
  numbersOutsideDates,
  tokenBoundedPositions,
  unsupportedNumbers,
} from "../../../src/scrapers/rubric/rubric-quote";
import { assessChunkOutput, mergeAssessments, pagesEndingMidSentence, regionDisplayName, reviewFlagsFor } from "../../../src/scrapers/rubric/rubric-extraction.service";
import { RUBRIC_PROMPT_VERSION, RUBRIC_SYSTEM_PROMPT, buildRubricOutputSchema, validateAgainstSchema } from "../../../src/scrapers/rubric/rubric-prompt";
import { rubricRouteKey } from "../../../src/scrapers/rubric/rubric.store";
import { validateCriterionShape } from "../../../src/scrapers/rubric/rubric-validate";
import { DEFAULT_SEVERITY_LEVELS, RUBRIC_CITATION_FIELDS, type AssessmentCriterion } from "../../../src/types/rubric";
import type { RawCriterion } from "../../../src/scrapers/rubric/rubric-prompt";
import { answer, crit } from "./rubric-harness";

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** The invented document: one rule per line, as a web page's cleaned text. */
const LINES = [
  "Part 3. Requirements.",
  "3.1 An applicant is ineligible for entry clearance where a removal order is in force.",
  "3.2 The applicant must have sufficient funds to cover all reasonable costs of the visit.",
  "3.3 The application must be made within 128 days of the date of the invitation.",
  "3.4 The priority service fee is 1,270 units and is not refundable.",
  "3.5 Funds must have been held for twenty-eight days before the application.",
  "3.6 From 26 March 2026 a national of Borduria or South Syldavia must be refused entry clearance under this Part.",
  "3.7 The decision maker is not required to interview the applicant before refusing.",
];
const FUNDS = "The applicant must have sufficient funds to cover all reasonable costs of the visit.";
const HELD = "Funds must have been held for twenty-eight days before the application.";
const BAR = "From 26 March 2026 a national of Borduria or South Syldavia must be refused entry clearance under this Part.";
const FEE = "The priority service fee is 1,270 units and is not refundable.";

/** A snapshot object as the store returns it (web page, or PDF when given pages). */
function snapshot(textOrPages: string | string[]): GuidanceSnapshotContent {
  const pages = Array.isArray(textOrPages) ? textOrPages : null;
  const text = pages ? pages.join(PDF_PAGE_SEPARATOR) : (textOrPages as string);
  return { schemaVersion: 1, sourceId: "probe-doc", contentHash: sha256(text), docType: pages ? "pdf" : "html", url: "https://rules.example/probe", finalUrl: "https://rules.example/probe", fetchedAt: "2026-11-11T01:00:00.000Z", text, pages: pages ? pages.map((t, i) => ({ page: i + 1, text: t })) : null };
}

const DOC = snapshot(LINES.join("\n"));
const INDEX = new SnapshotQuoteIndex(DOC);
const BASE = { sourceId: DOC.sourceId, url: DOC.url, contentHash: DOC.contentHash, retrievedAt: DOC.fetchedAt };
const CHUNK = { sourceId: DOC.sourceId, chunkIndex: 0 };

/** A judgement criterion over `quote` (the simplest shape that is otherwise valid). */
const judgement = (quote: string, extra: Partial<RawCriterion> = {}) => crit({ ref: "r", title: "T", kind: "judgement", quote, probeFactors: ["x"], requiresInterviewBeforeRefusal: false, ...extra });
/** An objective criterion over `quote` with the given check. */
const objective = (quote: string, check: RawCriterion["check"], extra: Partial<RawCriterion> = {}) => crit({ ref: "r", title: "T", kind: "objective", quote, check, ...extra });
/** A mandatory bar over the BAR sentence. */
const bar = (appliesTo: RawCriterion["appliesTo"], extra: Partial<RawCriterion> = {}) => crit({ ref: "r", title: "T", kind: "mandatory_bar", quote: BAR, appliesTo, ...extra });

/** Assess one proposed criterion against the probe document. */
function assess(c: RawCriterion, index = INDEX) {
  const out = assessChunkOutput(answer({ criteria: [c] }), CHUNK, index, BASE, DEFAULT_SEVERITY_LEVELS);
  return { accepted: out.criteria[0]?.criterion as AssessmentCriterion | undefined, midSentence: out.criteria[0]?.startsMidSentence, reason: out.discards[0]?.reason, detail: out.discards[0]?.detail, out };
}

/** Assert a criterion is rejected with `reason`. */
function rejects(c: RawCriterion, reason: string, index = INDEX): void {
  const r = assess(c, index);
  assert.equal(r.accepted, undefined, "the criterion must not be accepted");
  assert.equal(r.reason, reason);
}

// ============================================
// B1: a quote is whole words of one passage
// ============================================

describe("probe: token boundaries", () => {
  test("a quote cut out of the middle of a word is rejected (\"eligible\" from \"ineligible\")", () => {
    rejects(judgement("eligible for entry clearance where a removal order is in force"), "quote_not_found");
    // The whole word is fine.
    assert.ok(assess(judgement("An applicant is ineligible for entry clearance where a removal order is in force.")).accepted);
  });

  test("a quote cut out of the middle of a number is rejected (\"28 days\" from \"128 days\")", () => {
    rejects(objective("28 days of the date of the invitation", { field: "daysSinceInvitation", op: "lte", value: 28, unit: "days" }), "quote_not_found");
    assert.ok(assess(objective("within 128 days of the date of the invitation", { field: "daysSinceInvitation", op: "lte", value: 128, unit: "days" })).accepted);
  });

  test("a quote may not start or end inside a number written with separators", () => {
    rejects(judgement("270 units and is not refundable"), "quote_not_found");
    assert.deepEqual(tokenBoundedPositions("the fee is 1,270 units", "270 units"), []);
    assert.deepEqual(tokenBoundedPositions("a rate of 1.5 per day", "5 per day"), []);
    assert.deepEqual(tokenBoundedPositions("held for 28 days. Then", "28 days"), [9]);
    assert.deepEqual(tokenBoundedPositions("the limit is 28.", "is 28"), [10]);
  });

  test("token bounds are unicode-aware and exact", () => {
    assert.equal(containsTokenBounded("le séjour est autorisé", "jour est"), false);
    assert.equal(containsTokenBounded("le séjour est autorisé", "séjour est"), true);
    assert.equal(containsTokenBounded("An applicant (aged 18) may apply", "aged 18"), true);
    assert.equal(containsTokenBounded("An applicant may apply", "an applicant"), false);
  });

  test("a web-page quote that runs across two lines (two blocks of the page) is rejected", () => {
    rejects(judgement("is not refundable. 3.5 Funds must have been held"), "quote_spans_paragraphs");
  });

  // Code review round 2: the boundary check treated hyphen, apostrophe, %,
  // + and / as boundaries, so a quote could start or end inside a token.
  test("a token runs through hyphens, apostrophes, %, + and / (round 2)", () => {
    // B1/B6: the inverse of the source's group must not be quotable.
    assert.equal(containsTokenBounded("a non-Bordurian national", "Bordurian"), false);
    assert.equal(containsTokenBounded("a non-Bordurian national", "non-Bordurian"), true);
    // B4 end to end: "eight days" is not a whole token of "twenty-eight days".
    assert.equal(containsTokenBounded("held for twenty-eight days", "eight days"), false);
    assert.equal(containsTokenBounded("held for twenty-eight days", "twenty-eight days"), true);
    assert.equal(containsTokenBounded("the applicant's funds", "applicant"), false);
    assert.equal(containsTokenBounded("a fee of 20% applies", "20"), false);
    assert.equal(containsTokenBounded("dial +44 for help", "44"), false);
    assert.equal(containsTokenBounded("the and/or clause", "or"), false);
    // The typographic apostrophe is the same joiner as the ASCII one.
    assert.equal(containsTokenBounded("the applicant\u2019s funds", "applicant"), false);
  });

  test("the hyphen cut is rejected end to end (\"eight days\" from \"twenty-eight days\")", () => {
    rejects(objective("eight days before the application", { field: "f", op: "heldForDays", value: 8, unit: "days" }), "quote_not_found");
  });

  test("still rejected: a case-altered quote, two passages joined, a look-alike letter", () => {
    rejects(judgement(FUNDS.toLowerCase()), "quote_not_found");
    rejects(judgement("The applicant must have sufficient funds The priority service fee is 1,270 units"), "quote_not_found");
    // A Cyrillic letter that looks like the Latin "o", in "costs".
    rejects(judgement(FUNDS.replace("costs", "c\u043Ests")), "quote_not_found");
  });

  test("an invisible character in the model's copy does not reach storage: the SOURCE's text is stored", () => {
    // A zero-width space inside "sufficient".
    const r = assess(judgement(FUNDS.replace("sufficient", "suffi\u200Bcient")));
    assert.ok(r.accepted, "the passage is in the source, so the criterion stands");
    assert.equal(r.accepted?.source.quote, FUNDS);
    assert.doesNotMatch(r.accepted?.source.quote as string, /\u200B/);
    // The same for a re-wrapped copy: stored as the source has it.
    assert.equal(assess(judgement(FUNDS.replace(/ /g, "\n  "))).accepted?.source.quote, FUNDS);
  });
});

// ============================================
// The limit code cannot close: a quote after a negation
// ============================================

describe("probe: a quote that begins after a negation", () => {
  test("it is verbatim, so it is not rejected; it is FLAGGED for the reviewer", () => {
    const r = assess(judgement("required to interview the applicant before refusing", { requiresInterviewBeforeRefusal: true }));
    assert.ok(r.accepted, "documented limit: code cannot tell that the words before the quote reverse it");
    assert.equal(r.midSentence, true);
    const merged = mergeAssessments([{ chunk: CHUNK, assessment: r.out }]);
    assert.deepEqual(merged.flags.map((f) => [f.code, f.target]), [["quote_starts_mid_sentence", r.accepted?.criterionId]]);
  });

  test("a quote that starts its sentence, or follows only a paragraph number, is not flagged", () => {
    assert.equal(assess(judgement("The decision maker is not required to interview the applicant before refusing.")).midSentence, false);
    assert.equal(assess(judgement(FUNDS)).midSentence, false);
    // Second sentence of a line: follows a full stop.
    const two = new SnapshotQuoteIndex(snapshot("4.1 There is no set level of funds. The officer weighs income against planned spending."));
    assert.equal(assess(judgement("The officer weighs income against planned spending."), two).midSentence, false);
    assert.equal(assess(judgement("weighs income against planned spending."), two).midSentence, true);
  });
});

// ============================================
// B2: only the criterion's own quote supports its claims
// ============================================

describe("probe: support comes from the criterion's own quote", () => {
  test("a threshold borrowed from an unrelated passage through a citation is rejected", () => {
    rejects(objective(FUNDS, { field: "funds", op: "gte", value: 1270, unit: null }, { citations: [{ field: "check.value", quote: FEE }] }), "number_not_in_quote");
  });

  test("a unit, a date and a group borrowed through a citation are rejected too", () => {
    rejects(objective(FUNDS, { field: "funds", op: "eq", value: true, unit: "units" }, { citations: [{ field: "check.unit", quote: FEE }] }), "unit_not_in_quote");
    rejects(judgement(FUNDS, { validFrom: "2026-03-26", citations: [{ field: "validFrom", quote: BAR }] }), "date_not_in_quote");
    rejects(crit({ ref: "r", title: "T", kind: "mandatory_bar", quote: FUNDS, appliesTo: { nationalities: ["QM"], asWritten: ["Borduria"] }, citations: [{ field: "appliesTo", quote: BAR }] }), "applies_to_not_in_quote");
  });

  test("a citation is still kept, as the source's text, for the reviewer", () => {
    const r = assess(judgement(FUNDS, { citations: [{ field: "probeFactors", quote: "The priority service fee is 1,270 units\nand is not refundable." }] }));
    assert.deepEqual(r.accepted?.citations, { probeFactors: FEE });
  });

  test("a number in the title must be in the quote; the rule reference's digits do not license it", () => {
    rejects(judgement(FUNDS, { title: "Funds of at least 1,270", ruleRef: "1,270" }), "rule_ref_not_in_source");
    rejects(judgement(FUNDS, { title: "Rule 3.2: sufficient funds", ruleRef: "3.2" }), "number_not_in_quote");
    assert.ok(assess(judgement(FUNDS, { title: "Sufficient funds", ruleRef: "3.2" })).accepted);
  });

  test("the year or day of a date in the quote does not support a threshold", () => {
    rejects(objective(BAR, { field: "x", op: "eq", value: 2026, unit: null }), "number_not_in_quote");
    rejects(objective(BAR, { field: "x", op: "gte", value: 26, unit: null }), "number_not_in_quote");
    assert.deepEqual([...numbersOutsideDates("from 26 March 2026 for 3 visits")], ["3"]);
    assert.deepEqual([...numbersIn("from 26 March 2026 for 3 visits")].sort(), ["2026", "26", "3"]);
  });
});

// ============================================
// B3 + B4: thresholds are numbers; number words are whole numbers
// ============================================

describe("probe: check values", () => {
  test("a threshold given as a string is rejected, whatever it says", () => {
    for (const value of ["a hundred thousand", "\uFF15\uFF10\uFF10\uFF10", "5000", "", "28"]) {
      for (const op of ["gte", "lte", "heldForDays"] as const) {
        rejects(objective(HELD, { field: "f", op, value, unit: "days" }), "invalid_shape");
      }
    }
    // The stored-rubric validator says the same (it is what #125 re-runs).
    const stored = { ...(assess(objective(HELD, { field: "f", op: "gte", value: 28, unit: "days" })).accepted as AssessmentCriterion) };
    assert.deepEqual(validateCriterionShape(stored, DEFAULT_SEVERITY_LEVELS), []);
    stored.check = { field: "f", op: "gte", value: "a hundred thousand" };
    assert.deepEqual(validateCriterionShape(stored, DEFAULT_SEVERITY_LEVELS).map((i) => i.code), ["check_value_not_numeric"]);
    stored.check = { field: "f", op: "lte", value: Number.POSITIVE_INFINITY };
    assert.deepEqual(validateCriterionShape(stored, DEFAULT_SEVERITY_LEVELS).map((i) => i.code), ["check_value_not_numeric"]);
    stored.check = { field: "f", op: "present", value: 1 };
    assert.deepEqual(validateCriterionShape(stored, DEFAULT_SEVERITY_LEVELS).map((i) => i.code), ["check_value_unexpected"]);
  });

  test("an `eq` string must be in the quote word for word; a `present` check carries no value", () => {
    assert.ok(assess(objective(FEE, { field: "fee.refundable", op: "eq", value: "not refundable", unit: null })).accepted);
    rejects(objective(FEE, { field: "fee.refundable", op: "eq", value: "refundable in part", unit: null }), "number_not_in_quote");
    rejects(objective(FEE, { field: "fee.refundable", op: "eq", value: "fundable", unit: null }), "number_not_in_quote");
    rejects(objective(FEE, { field: "fee.refundable", op: "eq", value: "  ", unit: null }), "number_not_in_quote");
    rejects(objective(FEE, { field: "fee.paid", op: "present", value: 1270, unit: null }), "invalid_shape");
  });

  test("every unit is checked against the quote, not only durations", () => {
    rejects(objective(HELD, { field: "f", op: "heldForDays", value: 28, unit: "months" }), "unit_not_in_quote");
    rejects(objective(FEE, { field: "fee", op: "eq", value: 1270, unit: "XAC" }), "unit_not_in_quote");
    assert.ok(assess(objective(FEE, { field: "fee", op: "eq", value: 1270, unit: "units" })).accepted);
  });

  test("a compound number word is one number: \"twenty-eight\" supports 28, not 20 and not 8", () => {
    assert.ok(assess(objective(HELD, { field: "f", op: "heldForDays", value: 28, unit: "days" })).accepted);
    rejects(objective(HELD, { field: "f", op: "heldForDays", value: 20, unit: "days" }), "number_not_in_quote");
    rejects(objective(HELD, { field: "f", op: "heldForDays", value: 8, unit: "days" }), "number_not_in_quote");
  });

  test("numbersIn: what is read as a number, and what is not", () => {
    const read = (t: string) => [...numbersIn(t)].sort();
    assert.deepEqual(read("twenty-eight"), ["28"]);
    assert.deepEqual(read("twenty eight"), ["28"]);
    assert.deepEqual(read("two hundred and fifty"), ["250"]);
    assert.deepEqual(read("a hundred thousand"), ["100000"]);
    assert.deepEqual(read("one hundred and five thousand"), ["105000"]);
    assert.deepEqual(read("5 thousand"), ["5000"]);
    assert.deepEqual(read("1.5 million"), ["1500000"]);
    // Two numbers side by side stay two numbers.
    assert.deepEqual(read("eight twenty"), ["20", "8"]);
    assert.deepEqual(read("pages three five"), ["3", "5"]);
    // "one" is a pronoun unless a duration follows.
    assert.deepEqual(read("no one may apply"), []);
    assert.deepEqual(read("within one month"), ["1"]);
    // Digit runs: plain, thousands commas, decimals. Other shapes are not read.
    assert.deepEqual(read("1,270 and 1,270.50 and 28th"), ["1270", "1270.5", "28"]);
    assert.deepEqual(read("1.000,50"), []);
    assert.deepEqual(read("10,20"), []);
    // Compatibility digits are folded to ASCII; other scripts are not read.
    assert.deepEqual(read("\uFF15\uFF10\uFF10\uFF10"), ["5000"]);
    assert.deepEqual(read("\u0661\u0662\u0667\u0660"), []);
    assert.equal(hasUnreadableDigits("\u0661\u0662\u0667\u0660"), true);
    assert.equal(hasUnreadableDigits("\uFF15\uFF10 and 12"), false);
  });

  test("a claim whose digits cannot be read is unsupported, never passed", () => {
    assert.deepEqual(unsupportedNumbers("at least \u0661\u0662\u0667\u0660", "at least 1270"), ["unreadable-digits"]);
    rejects(judgement(FEE, { title: "Fee of \u0661\u0662\u0667\u0660" }), "number_not_in_quote");
    assert.deepEqual(unsupportedNumbers(Number.NaN, "1 2 3"), ["NaN"]);
  });
});

// ============================================
// B5: dates
// ============================================

describe("probe: dates", () => {
  test("a date with the right day and year but the wrong month is rejected", () => {
    rejects(bar({ nationalities: ["QM"], asWritten: ["Borduria"] }, { validFrom: "2026-11-26" }), "date_not_in_quote");
    assert.ok(assess(bar({ nationalities: ["QM"], asWritten: ["Borduria"] }, { validFrom: "2026-03-26" })).accepted);
  });

  test("day, month and year must come from ONE date expression, not scattered numbers", () => {
    assert.equal(dateSupported("2026-03-26", "26 weeks in March of the 2026 season"), false);
    assert.equal(dateSupported("2026-02-26", "26 weeks in 2026 or 2 visits"), false);
    assert.equal(dateSupported("2026-03-26", "on or after 26 March 2026"), true);
  });

  test("only a real calendar date is accepted", () => {
    assert.equal(dateSupported("2026-02-31", "26 weeks in 2026 or 31"), false);
    assert.equal(dateSupported("2026-02-31", "on 31 February 2026"), false);
    assert.equal(dateSupported("2026-13-01", "on 1 January 2026"), false);
    assert.equal(dateSupported("26 March 2026", "on 26 March 2026"), false);
  });

  test("the date forms that are read", () => {
    assert.deepEqual(datesIn("from 26 March 2026"), ["2026-03-26"]);
    assert.deepEqual(datesIn("from the 26th of Mar. 2026"), ["2026-03-26"]);
    assert.deepEqual(datesIn("from March 26, 2026"), ["2026-03-26"]);
    assert.deepEqual(datesIn("from 2026-03-26"), ["2026-03-26"]);
    assert.deepEqual(datesIn("from 26/03/2026 or 03.26.2026"), ["2026-03-26"]);
    // Day-first or month-first cannot be told: it supports no date.
    assert.deepEqual(datesIn("from 03/04/2026"), []);
    assert.deepEqual(datesIn("from 4 Marzo 2026"), []);
    assert.deepEqual(datesIn("in March 2026"), []);
  });
});

// ============================================
// B6: the group of a mandatory bar
// ============================================

describe("probe: appliesTo", () => {
  test("a name that is only the start of a longer word, or part of a longer name, is rejected", () => {
    // "Bordur" is the start of "Borduria"; "Syldavia" here is part of "South Syldavia".
    rejects(bar({ nationalities: ["QM", "QN"], asWritten: ["Bordur", "Syldavia"] }), "applies_to_not_in_quote");
    rejects(bar({ nationalities: ["QN"], asWritten: ["Syldavia"] }), "applies_to_not_in_quote");
    rejects(bar({ nationalities: ["QN"], asWritten: ["South"] }), "applies_to_not_in_quote");
    assert.ok(assess(bar({ nationalities: ["QM", "QN"], asWritten: ["Borduria", "South Syldavia"] })).accepted);
  });

  test("single letters and other fragments are rejected", () => {
    rejects(bar({ nationalities: ["QM", "QN", "QO"], asWritten: ["a", "o", "e"] }), "applies_to_not_in_quote");
    rejects(bar({ nationalities: ["QM"], asWritten: ["of"] }), "applies_to_not_in_quote");
    rejects(bar({ nationalities: ["QM"], asWritten: [""] }), "applies_to_not_in_quote");
  });

  test("codes and names must be parallel lists of the same length", () => {
    rejects(bar({ nationalities: ["QM", "QN"], asWritten: ["Borduria"] }), "invalid_shape");
    rejects(bar({ nationalities: ["QM"], asWritten: ["Borduria", "South Syldavia"] }), "invalid_shape");
  });

  test("groupNameSupported: whole names only", () => {
    assert.equal(groupNameSupported("Borduria", "a national of Borduria or Syldavia"), true);
    assert.equal(groupNameSupported("Bordur", "a national of Borduria or Syldavia"), false);
    assert.equal(groupNameSupported("Syldavia", "a national of South Syldavia"), false);
    assert.equal(groupNameSupported("Syldavia", "a national of Syldavia-Bissau"), false);
    assert.equal(groupNameSupported("Syldavia", "nationals of Syldavia, and others"), true);
    // Found twice: one whole occurrence is enough.
    assert.equal(groupNameSupported("Syldavia", "South Syldavia and Syldavia"), true);
    assert.equal(groupNameSupported("Sy", "Sy is a place"), false);
  });

  test("right names with wrong codes: not something code can refuse, so each code is flagged for the reviewer", () => {
    // "ZZ" is a code the platform does name; the invented codes are not.
    const zzName = regionDisplayName("ZZ");
    const doc = new SnapshotQuoteIndex(snapshot(`5.1 A national of ${zzName} or Borduria must be refused entry clearance.`));
    const quote = `A national of ${zzName} or Borduria must be refused entry clearance.`;
    const r = assess(crit({ ref: "r", title: "T", kind: "mandatory_bar", quote, appliesTo: { nationalities: ["zz", "QM"], asWritten: [zzName, "Borduria"] } }), doc);
    assert.ok(r.accepted);
    // The platform's name is stored beside each (upper-cased) code.
    assert.deepEqual(r.accepted?.appliesTo, { nationalities: ["ZZ", "QM"], asWritten: [zzName, "Borduria"], codeNames: [zzName, "QM"] });
    const flags = reviewFlagsFor({ criteria: [r.accepted as AssessmentCriterion], intakeQuestions: [] }, { chunkCount: 1, pagesEndingMidSentence: [] });
    // A standing flag on every version with a bar, and one per code whose
    // platform name is not the source's wording (here: the second only).
    assert.deepEqual(flags.map((f) => [f.code, f.target]), [
      ["nationality_codes_model_proposed", "rubric"],
      ["nationality_code_name_mismatch", r.accepted?.criterionId],
    ]);
    assert.match(flags[1].message, /^entry 2 of the group: code QM /);

    // Swap the codes: both entries are now flagged.
    const swapped = { ...(r.accepted as AssessmentCriterion), appliesTo: { nationalities: ["QM", "ZZ"], asWritten: [zzName, "Borduria"], codeNames: ["QM", zzName] } };
    const again = reviewFlagsFor({ criteria: [swapped], intakeQuestions: [] }, { chunkCount: 1, pagesEndingMidSentence: [] });
    assert.deepEqual(again.map((f) => f.code), ["nationality_codes_model_proposed", "nationality_code_name_mismatch", "nationality_code_name_mismatch"]);
  });

  test("the stored-rubric validator: names of fewer than three characters, and codeNames that are not parallel", () => {
    const stored = assess(bar({ nationalities: ["QM"], asWritten: ["Borduria"] })).accepted as AssessmentCriterion;
    assert.deepEqual(validateCriterionShape(stored, DEFAULT_SEVERITY_LEVELS), []);
    assert.deepEqual(validateCriterionShape({ ...stored, appliesTo: { nationalities: ["QM"], asWritten: ["Bo"] } }, DEFAULT_SEVERITY_LEVELS).map((i) => i.code), ["applies_to_as_written_mismatch"]);
    assert.deepEqual(validateCriterionShape({ ...stored, appliesTo: { nationalities: ["QM"], asWritten: ["Borduria"], codeNames: [] } }, DEFAULT_SEVERITY_LEVELS).map((i) => i.code), ["applies_to_code_names_mismatch"]);
  });
});

// ============================================
// Rule references
// ============================================

describe("probe: rule references", () => {
  test("a reference printed elsewhere in the document is not this rule's reference", () => {
    rejects(judgement(FUNDS, { ruleRef: "3.7" }), "rule_ref_not_in_source");
    rejects(judgement(FUNDS, { ruleRef: "3.1" }), "rule_ref_not_in_source");
    assert.equal(assess(judgement(FUNDS, { ruleRef: "3.2" })).accepted?.ruleRef, "3.2");
  });

  test("a one-character or punctuation-only reference, and a fragment of one, are rejected", () => {
    rejects(judgement(FUNDS, { ruleRef: "3" }), "rule_ref_not_in_source");
    rejects(judgement(FUNDS, { ruleRef: ".." }), "rule_ref_not_in_source");
    rejects(judgement(FUNDS, { ruleRef: ".2" }), "rule_ref_not_in_source");
  });

  test("a reference inside the quote counts; on a PDF page it must be shortly before the quote", () => {
    assert.ok(assess(judgement(`3.2 ${FUNDS}`, { ruleRef: "3.2" })).accepted);
    const filler = "The officer records the evidence considered and the weight given to it. ".repeat(6);
    const page = new SnapshotQuoteIndex(snapshot([`7.1 ${filler}\n7.2 Short rule here.\n${FUNDS}`]));
    assert.equal(assess(judgement(FUNDS, { ruleRef: "7.2" }), page).accepted?.ruleRef, "7.2");
    // 7.1 is on the same page but more than the window before the quote.
    rejects(judgement(FUNDS, { ruleRef: "7.1" }), "rule_ref_not_in_source", page);
  });
});

// ============================================
// B7: citation fields are a closed list
// ============================================

describe("probe: citation fields", () => {
  test("an empty or unknown citation field is rejected", () => {
    rejects(judgement(FUNDS, { citations: [{ field: "", quote: FEE }] }), "invalid_shape");
    rejects(judgement(FUNDS, { citations: [{ field: "anything-the-model-likes", quote: FEE }] }), "invalid_shape");
  });

  test("the output schema only allows the listed fields, and a problem line never repeats a model-chosen key", () => {
    const schema = buildRubricOutputSchema(DEFAULT_SEVERITY_LEVELS);
    const good = answer({ criteria: [judgement(FUNDS, { citations: [{ field: "probeFactors", quote: FEE }] })] });
    assert.deepEqual(validateAgainstSchema(good, schema), []);
    for (const field of RUBRIC_CITATION_FIELDS) {
      assert.deepEqual(validateAgainstSchema(answer({ criteria: [judgement(FUNDS, { citations: [{ field, quote: FEE }] })] }), schema), []);
    }
    const bad: any = answer({ criteria: [judgement(FUNDS, { citations: [{ field: "MODEL-KEY", quote: FEE }] })] });
    bad.criteria[0]["MODEL-PROPERTY"] = 1;
    const problems = validateAgainstSchema(bad, schema);
    assert.deepEqual(problems.sort(), ["$.criteria[0].citations[0].field: not one of the allowed values", "$.criteria[0]: has a property that is not allowed"]);
  });
});

// ============================================
// Standing reviewer flags, prompt pin, route key
// ============================================

describe("standing reviewer flags", () => {
  const none = { chunkCount: 1, pagesEndingMidSentence: [] };

  test("no bars, no intake questions, one chunk: no standing flag", () => {
    const c = assess(judgement(FUNDS)).accepted as AssessmentCriterion;
    assert.deepEqual(reviewFlagsFor({ criteria: [c], intakeQuestions: [] }, none), []);
  });

  test("intake wording is flagged as the model's own, uncited", () => {
    const c = assess(judgement(FUNDS)).accepted as AssessmentCriterion;
    const q = { id: "q1", label: "A question", answerType: "text", required: true, criterionIds: [c.criterionId] };
    assert.deepEqual(reviewFlagsFor({ criteria: [c], intakeQuestions: [q] }, none).map((f) => f.code), ["intake_wording_uncited"]);
  });

  test("a version built from more than one chunk, and PDF pages that end mid-sentence, are flagged", () => {
    const c = assess(judgement(FUNDS)).accepted as AssessmentCriterion;
    const pdf = snapshot(["Page one ends properly.", "Page two stops in the middle of a", "sentence that page three finishes.", "", "A list ends with a bracket (see annex)"]);
    assert.deepEqual(pagesEndingMidSentence(pdf), [2]);
    assert.deepEqual(pagesEndingMidSentence(DOC), [], "a web page has no pages");
    const flags = reviewFlagsFor({ criteria: [c], intakeQuestions: [] }, { chunkCount: 3, pagesEndingMidSentence: [{ sourceId: "probe-doc", pages: [2] }, { sourceId: "other-doc", pages: [] }] });
    assert.deepEqual(flags.map((f) => f.code), ["multiple_chunks", "page_ends_mid_sentence"]);
    assert.match(flags[1].message, /1 page\(s\) of probe-doc .*\(page 2\)/);
  });
});

describe("prompt version pin", () => {
  // sha256 of the system prompt + the output schema, per prompt version.
  // Changing either WITHOUT bumping RUBRIC_PROMPT_VERSION fails here. After a
  // deliberate change: bump the version, add its line to the history comment
  // in rubric-prompt.ts, and add the new hash below (keep the old lines).
  const PINNED: Record<string, string> = {
    "2026-11-rubric-v2": "b2043fc231eb40af3853c1c802cb00d1594e8ea2c613c3e1c2c6d157dacf1c13",
  };

  test("the system prompt and output schema match the hash pinned for RUBRIC_PROMPT_VERSION", () => {
    const hash = sha256(`${RUBRIC_SYSTEM_PROMPT}\n${JSON.stringify(buildRubricOutputSchema(DEFAULT_SEVERITY_LEVELS))}`);
    assert.ok(RUBRIC_PROMPT_VERSION in PINNED, `no hash pinned for ${RUBRIC_PROMPT_VERSION}: add one`);
    assert.equal(hash, PINNED[RUBRIC_PROMPT_VERSION], "the prompt or schema changed: bump RUBRIC_PROMPT_VERSION and pin the new hash");
  });
});

describe("route key", () => {
  test("the country code must be two upper-case letters; lower case is refused, not folded", () => {
    assert.equal(rubricRouteKey("XA", "xa-short-visit"), "XA_xa-short-visit");
    assert.throws(() => rubricRouteKey("xa", "xa-short-visit"), /upper-case/);
    assert.throws(() => rubricRouteKey("Xa", "xa-short-visit"), /upper-case/);
    assert.throws(() => rubricRouteKey("XAA", "v"), /Invalid country code/);
    assert.throws(() => rubricRouteKey("XA", "a/b"), /Invalid visa type id/);
  });
});
