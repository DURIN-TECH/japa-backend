// ============================================
// A competence rule whose cases are its LIST LINES (issue #335)
// ============================================
//
// The EU Visa Code says which member country examines an application in a
// lead-in ("... shall be:") followed by three lettered cases. Its official page
// sets each letter alone on a line, with the case's words on the next line.
// Before #335:
//   1. the list reader stored the bare "(a)" and stopped (a list silently cut
//      to its first marker), and `verifyListItems` confirmed the cut list;
//   2. `competenceProblems` looked for a step's `restsOn` in the quote only,
//      so a step resting on a case ("sole destination", in item (a)) was
//      refused, and the whole block with it;
//   3. the quote served for a proposal was the lead-in alone.
//
// The page layout is the REAL stored text: `fixtures/visa-code-article-5-1.json`
// holds lines copied by code from the stored snapshot (never typed). Every
// other wording below (rules, questions, a second layout) is made up.
// No Firestore, no model, no network.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SnapshotQuoteIndex } from "../../../src/scrapers/rubric/rubric-quote";
import { isBareMarker, quoteWithItems, readLeadInList, readListLines, verifyListItems } from "../../../src/scrapers/rubric/rubric-list-items";
import { MIN_RESTS_ON_CHARS, competenceProblems, restsOnSite, restsOnSites, stepQuoteShown } from "../../../src/scrapers/rubric/rubric-competence";
import { resolveCompetence } from "../../../src/services/competence.service";
import { assessChunkOutput, mergeAssessments } from "../../../src/scrapers/rubric/rubric-extraction.service";
import { DEFAULT_SEVERITY_LEVELS, type AssessmentCriterion, type CompetenceBlock, type IntakeQuestion } from "../../../src/types/rubric";
import type { GuidanceSnapshotContent } from "../../../src/scrapers/guidance/types";
import { answer, crit } from "./rubric-harness";

/* eslint-disable @typescript-eslint/no-explicit-any */

// ============================================
// The stored page (verbatim lines, copied by code)
// ============================================

/** The fixture: lines of the stored snapshot around Article 5(1), unchanged (no-break spaces kept). */
const FIXTURE = JSON.parse(readFileSync(join(__dirname, "fixtures", "visa-code-article-5-1.json"), "utf8")) as { sourceId: string; url: string; fetchedAt: string; lines: string[] };

/** A snapshot made of some lines, hashed like a stored one. */
function snapOf(lines: readonly string[], url = FIXTURE.url): GuidanceSnapshotContent {
  const text = lines.join("\n\n");
  return { schemaVersion: 1, sourceId: FIXTURE.sourceId, contentHash: createHash("sha256").update(text).digest("hex"), docType: "html", url, finalUrl: url, fetchedAt: FIXTURE.fetchedAt, text, pages: null };
}

const PAGE = snapOf(FIXTURE.lines);
const INDEX = new SnapshotQuoteIndex(PAGE);
// The lead-in, as stored in version 1's rule `crit_a96b72ed1cc11170`; located in the page, never typed as a fact.
const LEAD_IN = (FIXTURE.lines.find((l) => l.endsWith("shall be:")) as string).trim();
const FOUND = INDEX.locate(LEAD_IN);
if (!FOUND.ok) throw new Error("fixture: the lead-in is not in the page");

/** The page's own normalised lines, by position (so expectations are built from the page, not typed). */
const line = (n: number): string => INDEX.unitText(n);

// ============================================
// 1. The list reader
// ============================================

describe("lead-in list with each marker alone on its line (EUR-Lex layout)", () => {
  test("the page holds (a), (b), (c) as a marker line followed by one line of words", () => {
    // What made the old reader stop: the marker is the whole line.
    assert.equal(isBareMarker(line(FOUND.unit + 1)), true);
    assert.equal(isBareMarker(line(FOUND.unit + 2)), false);
  });

  test("the whole list is read: each item is the marker and its words, joined by one space", () => {
    const read = readLeadInList(INDEX, FOUND);
    assert.equal(read.kind, "items");
    const items = (read as { items: string[] }).items;
    assert.deepEqual(items, [1, 3, 5].map((k) => `${line(FOUND.unit + k)} ${line(FOUND.unit + k + 1)}`));
    assert.equal(items.length, 3);
    assert.ok(items[0].startsWith("(a) ") && items[1].startsWith("(b) ") && items[2].startsWith("(c) "));
    // The list ends before the next paragraph ("2."): nothing of it is attached.
    assert.ok(!items.some((i) => i.startsWith("2.")));
  });

  test("verifyListItems passes for the full list, and every item is word for word in the stored page", () => {
    const read = readLeadInList(INDEX, FOUND) as { items: string[] };
    assert.deepEqual(verifyListItems(INDEX, FOUND, read.items), { ok: true });
    // Word for word: each item is in the page's whitespace-normalised text (what the official page shows).
    for (const item of read.items) assert.ok(INDEX.allText().includes(item), item.slice(0, 20));
  });

  test("the list version 1 stored (the bare \"(a)\") no longer verifies: it was cut", () => {
    assert.deepEqual(verifyListItems(INDEX, FOUND, ["(a)"]), { ok: false, reason: "items_not_in_snapshot" });
  });

  test("an altered, reordered or shortened list still fails (verbatim stays verbatim)", () => {
    const items = (readLeadInList(INDEX, FOUND) as { items: string[] }).items;
    assert.equal(verifyListItems(INDEX, FOUND, items.slice(0, 2)).ok, false);
    assert.equal(verifyListItems(INDEX, FOUND, [items[1], items[0], items[2]]).ok, false);
    assert.equal(verifyListItems(INDEX, FOUND, [items[0].replace("sole", "only"), items[1], items[2]]).ok, false);
    // The two halves stored as separate lines are not the list either.
    assert.equal(verifyListItems(INDEX, FOUND, [line(FOUND.unit + 1), line(FOUND.unit + 2)]).ok, false);
  });

  test("the rule's full text (what the check and a reader see) is the lead-in and the three cases", () => {
    const items = (readLeadInList(INDEX, FOUND) as { items: string[] }).items;
    assert.equal(quoteWithItems({ quote: LEAD_IN, listItems: items }).split("\n").length, 4);
  });
});

describe("bare markers: what cannot be read is refused, never guessed (made-up layouts)", () => {
  const LEAD = "A request shall be refused where any of the following applies:";

  test("a bare marker at the end of the page: marker_without_text", () => {
    assert.deepEqual(readListLines(LEAD, ["(a) the form is incomplete;", "(b)"]), { kind: "unreadable", reason: "marker_without_text" });
  });

  test("a bare marker followed by another marker: marker_without_text", () => {
    assert.deepEqual(readListLines(LEAD, ["(a)", "(b)", "the fee is unpaid."]), { kind: "unreadable", reason: "marker_without_text" });
  });

  test("a bare marker followed by a reference label (the next paragraph): marker_without_text", () => {
    assert.deepEqual(readListLines(LEAD, ["(a)", "5.2 Another paragraph"]), { kind: "unreadable", reason: "marker_without_text" });
    // A paragraph number alone on its line (the EUR-Lex layout of "2.") is the next paragraph, not the words.
    assert.deepEqual(readListLines(LEAD, ["(a)", "2."]), { kind: "unreadable", reason: "marker_without_text" });
  });

  test("markers on the same line as their words read exactly as before #335, up to a known end", () => {
    // (Fix round 1) The list ends at a KNOWN end: here the next labelled paragraph.
    assert.deepEqual(readListLines(LEAD, ["(a) the form is incomplete; or", "(b) the fee is unpaid.", "5.3 Next paragraph."]), { kind: "items", items: ["(a) the form is incomplete; or", "(b) the fee is unpaid."] });
    // Before fix round 1 this test ended the list at an unlabelled sentence ("Next paragraph."). That is
    // exactly the silent stop the review found: such a line cannot be told from more of item (b), so it is refused.
    assert.deepEqual(readListLines(LEAD, ["(a) the form is incomplete; or", "(b) the fee is unpaid.", "Next paragraph."]), { kind: "unreadable", reason: "line_after_item_not_recognised" });
  });

  test("a page mixing both layouts reads both; a nested bare-marker list keeps its depth", () => {
    const read = readListLines("(c) the request is refused where all of the following apply:", ["(i)", "the form is incomplete; and", "(ii) the fee is unpaid;", "(d)", "a sibling of the lead-in."]);
    // (d) is at the lead-in's own level: the list ends there.
    assert.deepEqual(read, { kind: "items", items: ["(i) the form is incomplete; and", "(ii) the fee is unpaid;"] });
  });
});

// ============================================
// 2. The code check of the block
// ============================================

/** The version-1 rule with its list read whole (what the one-rule re-draft keeps from the snapshot). */
const ITEMS = (readLeadInList(INDEX, FOUND) as { items: string[] }).items;
const RULE: AssessmentCriterion = {
  criterionId: "crit_a96b72ed1cc11170",
  title: "Which member country examines the application",
  kind: "judgement",
  stage: "validity",
  severity: "high",
  source: { quote: LEAD_IN, sourceId: PAGE.sourceId, url: PAGE.url, contentHash: PAGE.contentHash, retrievedAt: PAGE.fetchedAt, listItems: ITEMS },
  probeFactors: ["the applicant's own account of the trip"],
  requiresInterviewBeforeRefusal: false,
  confidence: 0.9,
} as AssessmentCriterion;

/** Words of item n, found in the page by position (never typed as a legal fact). */
const wordsOf = (n: number, re: RegExp): string => (ITEMS[n].match(re) as RegExpMatchArray)[0];
const SOLE = wordsOf(0, /sole destination/);
const MAIN = wordsOf(1, /main destination of the visit\(s\) in terms of the length of stay, counted in days, or the purpose of stay/);
const BORDER = wordsOf(2, /external border the applicant intends to cross/);

// Made-up questions in the shape the drafting prompt asks for. F1: the basis of the main destination
// ("length ... or the purpose") is ASKED: the applicant says which country is the main one on the basis
// that applies to them; nothing works it out from dates or days.
const QUESTIONS: IntakeQuestion[] = [
  { id: "q-visit", label: "Which countries on this route will you visit?", answerType: "multi_choice", required: true, criterionIds: [RULE.criterionId], optionsFrom: "route_destinations" },
  { id: "q-main", label: "Which country is your main destination, by the length of your stay or by the purpose of your trip?", answerType: "single_choice", required: true, criterionIds: [RULE.criterionId], optionsFrom: "route_destinations", options: [{ value: "cannot_say", label: "I can't say" }] },
  { id: "q-border", label: "Which country's external border will you cross first?", answerType: "single_choice", required: true, criterionIds: [RULE.criterionId], optionsFrom: "route_destinations" },
  // A trip-dates question the rulebook may also ask. No step reads it.
  { id: "q-days", label: "How many days will you spend in each country?", answerType: "text", required: false, criterionIds: [RULE.criterionId] },
];
const BLOCK: CompetenceBlock = {
  steps: [
    { criterionId: RULE.criterionId, questionId: "q-visit", resultFrom: "answer", restsOn: SOLE, source: RULE.source },
    { criterionId: RULE.criterionId, questionId: "q-main", resultFrom: "answer", restsOn: MAIN, source: RULE.source },
    { criterionId: RULE.criterionId, questionId: "q-border", resultFrom: "answer", restsOn: BORDER, source: RULE.source },
  ],
};
const RUBRIC = { criteria: [RULE], intakeQuestions: QUESTIONS, competence: BLOCK };

describe("competenceProblems: a step may rest on a list line of its rule", () => {
  test("steps resting on words of items (a), (b), (c) pass", () => {
    assert.deepEqual(competenceProblems(RUBRIC, { sharedRulebook: true }), []);
    assert.equal(restsOnSite(RULE.source, SOLE), 0);
    assert.equal(restsOnSite(RULE.source, MAIN), 1);
    assert.equal(restsOnSite(RULE.source, BORDER), 2);
    assert.equal(restsOnSite(RULE.source, "competent for examining"), "quote");
  });

  test("words that are in no line of the rule are still refused", () => {
    const steps = [{ ...BLOCK.steps[0], restsOn: "the country of longest stay" }];
    assert.deepEqual(competenceProblems({ ...RUBRIC, competence: { steps } }).map((p) => p.code), ["competence_rests_on_not_in_quote"]);
  });

  test("words stitched across two list lines are refused (each must sit inside one line)", () => {
    const across = `${ITEMS[0].slice(-12)} ${ITEMS[1].slice(0, 12)}`;
    assert.equal(restsOnSite(RULE.source, across), undefined);
    const steps = [{ ...BLOCK.steps[0], restsOn: across }];
    assert.deepEqual(competenceProblems({ ...RUBRIC, competence: { steps } }).map((p) => p.code), ["competence_rests_on_not_in_quote"]);
  });

  test("a step carrying other list lines than its rule's is refused", () => {
    const steps = [{ ...BLOCK.steps[0], source: { ...RULE.source, listItems: [`${ITEMS[0]} of the visit`] } }];
    assert.deepEqual(competenceProblems({ ...RUBRIC, competence: { steps } }).map((p) => p.code), ["competence_source_mismatch"]);
  });

  test("the rule as version 1 stored it (list cut to \"(a)\") cannot carry the steps", () => {
    const cut = { ...RULE, source: { ...RULE.source, listItems: ["(a)"] } };
    const steps = BLOCK.steps.map((s) => ({ ...s, source: cut.source }));
    assert.deepEqual([...new Set(competenceProblems({ ...RUBRIC, criteria: [cut], competence: { steps } }).map((p) => p.code))], ["competence_rests_on_not_in_quote"]);
  });
});

// ============================================
// 2b. Fix round 1: the words must name EXACTLY ONE line of the rule
// ============================================
//
// Review finding: the code check took the FIRST list line that held a step's
// words, on a plain substring match of 3 characters or more. On this very rule
// "the Member State" is in the quote and in all three cases, and the words for
// the main destination are in cases (b) and (c): a step for case (b) or (c)
// with such words passed, and the applicant was shown case (a) as the official
// words for it. No model check reads the steps, so this code check is the only
// guard. Every phrase below is cut out of the page's own lines by position.

describe("competenceProblems: words found in two or more lines are refused, never resolved to the first", () => {
  /** A step for the case at `stepIndex` resting on `restsOn`, in the otherwise sound block. */
  const withWords = (stepIndex: number, restsOn: string) => ({ ...RUBRIC, competence: { steps: BLOCK.steps.map((s, i) => (i === stepIndex ? { ...s, restsOn } : s)) } });
  const codes = (rubric: Parameters<typeof competenceProblems>[0]) => competenceProblems(rubric, { sharedRulebook: true }).map((p) => `${p.stepIndex}:${p.code}`);

  // Phrases the cases share, each found in the page (never typed as a fact).
  const THE_MEMBER_STATE = wordsOf(0, /the Member State/); // the reviewer's phrase: cut out of case (a), and in (b) and (c) too
  const MAIN_DESTINATION = wordsOf(2, /main destination/); // in (b) and in (c)
  const WHOSE_TERRITORY = wordsOf(0, /Member State whose territory constitutes the/); // in (a) and in (b)
  const DESTINATION_OF = wordsOf(0, /destination of the visit\(s\)/); // in (a) and in (b)

  test("the shared phrases really are in several lines of this rule", () => {
    assert.deepEqual(restsOnSites(RULE.source, THE_MEMBER_STATE), [0, 1, 2]);
    assert.deepEqual(restsOnSites(RULE.source, MAIN_DESTINATION), [1, 2]);
    assert.deepEqual(restsOnSites(RULE.source, WHOSE_TERRITORY), [0, 1]);
    assert.deepEqual(restsOnSites(RULE.source, DESTINATION_OF), [0, 1]);
    // The lead-in's own wording of it (capital T) is in the quote only.
    assert.deepEqual(restsOnSites(RULE.source, "The Member State"), ["quote"]);
  });

  for (const [name, stepIndex, phrase] of [
    ["the phrase every case repeats, on the step for case (b)", 1, THE_MEMBER_STATE],
    ["the phrase every case repeats, on the step for case (c)", 2, THE_MEMBER_STATE],
    ["the main-destination words, which are in cases (b) and (c), on the step for case (b)", 1, MAIN_DESTINATION],
    ["the main-destination words, on the step for case (c)", 2, MAIN_DESTINATION],
    ["words shared by cases (a) and (b), on the step for case (b)", 1, WHOSE_TERRITORY],
    ["the destination words shared by cases (a) and (b), on the step for case (a)", 0, DESTINATION_OF],
  ] as const) {
    test(`ambiguous: ${name}`, () => {
      assert.deepEqual(codes(withWords(stepIndex, phrase)), [`${stepIndex}:competence_rests_on_ambiguous`]);
      // No single line: nothing is picked, and the first match is never shown for it.
      assert.equal(restsOnSite(RULE.source, phrase), undefined);
      assert.equal(stepQuoteShown(RULE.source, phrase), LEAD_IN);
      assert.notEqual(stepQuoteShown(RULE.source, phrase), `${LEAD_IN}\n${ITEMS[0]}`);
    });
  }

  test("one ambiguous step takes the WHOLE block: it is not served and not kept by drafting", () => {
    const rubric = withWords(1, MAIN_DESTINATION);
    // Read side: the block is not servable.
    assert.equal(competenceProblems(rubric).length, 1);
    // Drafting: `mergeAssessments` drops the block with a flag (same path as any failing step).
    const base = { sourceId: PAGE.sourceId, url: PAGE.url, contentHash: PAGE.contentHash, retrievedAt: PAGE.fetchedAt };
    const q = (id: string, fields: Record<string, unknown> = {}) => ({ id, label: `Question ${id}`, helpText: null, answerType: "single_choice", required: true, criterionRefs: ["c1"], group: null, party: null, options: [], textMaxLength: null, dateRelativeToToday: null, showWhenAnyOf: [], optionsFrom: "route_destinations" as const, ...fields });
    const c1 = crit({ ref: "c1", title: "Which member country examines the application", kind: "judgement", stage: "validity", quote: LEAD_IN, probeFactors: ["the countries the applicant will visit"], requiresInterviewBeforeRefusal: false });
    const criteriaPart = assessChunkOutput(answer({ criteria: [c1] }), { sourceId: PAGE.sourceId, chunkIndex: 0 }, INDEX, base, DEFAULT_SEVERITY_LEVELS);
    const intakePart = assessChunkOutput(
      answer({
        intakeQuestions: [q("visit", { answerType: "multi_choice" }), q("main"), q("border")] as any,
        competenceSteps: [
          { criterionRef: "c1", restsOn: SOLE, questionId: "visit", whenAllOf: [] },
          { criterionRef: "c1", restsOn: MAIN_DESTINATION, questionId: "main", whenAllOf: [] },
          { criterionRef: "c1", restsOn: BORDER, questionId: "border", whenAllOf: [] },
        ],
      }),
      { sourceId: PAGE.sourceId, chunkIndex: 0 },
      INDEX,
      base,
      DEFAULT_SEVERITY_LEVELS
    );
    const merged = mergeAssessments([{ chunk: { sourceId: PAGE.sourceId, chunkIndex: 0 }, assessment: { ...intakePart, criteria: criteriaPart.criteria } }]);
    assert.equal(merged.competence, undefined);
    assert.ok(merged.flags.some((f) => f.code === "competence_dropped"));
  });

  test("the match is on token boundaries: words cut out of the middle of a longer word are not the rule's words", () => {
    // "sole destination" starts a word; the same letters without the first one start INSIDE that word.
    const at = ITEMS[0].indexOf(SOLE);
    const insideWord = ITEMS[0].slice(at + 1, at + SOLE.length); // "ole destination"
    assert.ok(ITEMS[0].includes(insideWord) && insideWord.length >= MIN_RESTS_ON_CHARS);
    assert.deepEqual(restsOnSites(RULE.source, insideWord), []);
    assert.deepEqual(codes(withWords(0, insideWord)), ["0:competence_rests_on_not_in_quote"]);
    // Cut at the END of a word as well ("sole destinatio").
    assert.deepEqual(restsOnSites(RULE.source, SOLE.slice(0, -1)), []);
  });

  test("the minimum length is above 3: a short word that sits in one line only is still not a basis", () => {
    assert.ok(MIN_RESTS_ON_CHARS > 3);
    // "sole" is in case (a) only, but four letters name nothing.
    const sole = wordsOf(0, /sole/);
    assert.ok(sole.length < MIN_RESTS_ON_CHARS);
    assert.deepEqual(restsOnSites(RULE.source, sole), []);
    assert.deepEqual(codes(withWords(0, sole)), ["0:competence_rests_on_not_in_quote"]);
    assert.deepEqual(codes(withWords(0, "the")), ["0:competence_rests_on_not_in_quote"]);
  });

  test("words that name one line still pass, and that line is the one shown", () => {
    assert.deepEqual(codes(RUBRIC), []);
    assert.deepEqual([SOLE, MAIN, BORDER].map((w) => restsOnSites(RULE.source, w)), [[0], [1], [2]]);
    assert.equal(stepQuoteShown(RULE.source, MAIN), `${LEAD_IN}\n${ITEMS[1]}`);
    assert.equal(stepQuoteShown(RULE.source, BORDER), `${LEAD_IN}\n${ITEMS[2]}`);
  });
});

// ============================================
// 3. What the applicant is shown, and what is never worked out
// ============================================

describe("resolveCompetence on the lead-in rule", () => {
  const MEMBERS = ["XA", "XB", "XC"];
  const stack = { competence: BLOCK, destinations: MEMBERS };

  test("one destination: that country, shown with the lead-in AND the case's own line (a)", () => {
    const r = resolveCompetence(stack, { "q-visit": ["XB"] });
    assert.equal(r.status, "country");
    const c = r as Extract<typeof r, { status: "country" }>;
    assert.equal(c.countryCode, "XB");
    assert.equal(c.quote, `${LEAD_IN}\n${ITEMS[0]}`);
    assert.equal(c.url, PAGE.url);
    assert.equal(stepQuoteShown(RULE.source, SOLE), c.quote);
  });

  test("several destinations: the main destination is ASKED; days per country never decide it", () => {
    // The applicant gave how long they stay in each country, but not which is the main destination.
    const r = resolveCompetence(stack, { "q-visit": ["XA", "XB"], "q-days": "XA 10 days, XB 2 days" });
    assert.deepEqual(r, { status: "ask", questionId: "q-main" });
  });

  test("the main destination the applicant names decides, shown with line (b)", () => {
    const r = resolveCompetence(stack, { "q-visit": ["XA", "XB"], "q-main": "XA" });
    assert.equal(r.status, "country");
    assert.equal((r as any).quote, `${LEAD_IN}\n${ITEMS[1]}`);
  });

  test("no main destination can be named: the first-external-border case, shown with line (c)", () => {
    assert.deepEqual(resolveCompetence(stack, { "q-visit": ["XA", "XB"], "q-main": "cannot_say" }), { status: "ask", questionId: "q-border" });
    const r = resolveCompetence(stack, { "q-visit": ["XA", "XB"], "q-main": "cannot_say", "q-border": "XC" });
    assert.equal(r.status, "country");
    assert.equal((r as any).countryCode, "XC");
    assert.equal((r as any).quote, `${LEAD_IN}\n${ITEMS[2]}`);
  });

  test("a step resting on the quote itself is shown with the quote alone (as before #335)", () => {
    assert.equal(stepQuoteShown(RULE.source, "competent for examining"), LEAD_IN);
  });
});

// ============================================
// 4. Drafting: the block is kept when its steps rest on list lines
// ============================================

describe("drafting (mergeAssessments) on the stored page", () => {
  const base = { sourceId: PAGE.sourceId, url: PAGE.url, contentHash: PAGE.contentHash, retrievedAt: PAGE.fetchedAt };
  const q = (id: string, fields: Record<string, unknown> = {}) => ({ id, label: `Question ${id}`, helpText: null, answerType: "single_choice", required: true, criterionRefs: ["c1"], group: null, party: null, options: [], textMaxLength: null, dateRelativeToToday: null, showWhenAnyOf: [], optionsFrom: "route_destinations" as const, ...fields });

  test("code attaches the whole list to the drafted rule, and the steps on its lines are kept", () => {
    const c1 = crit({ ref: "c1", title: "Which member country examines the application", kind: "judgement", stage: "validity", quote: LEAD_IN, probeFactors: ["the countries the applicant will visit"], requiresInterviewBeforeRefusal: false });
    const criteriaPart = assessChunkOutput(answer({ criteria: [c1] }), { sourceId: PAGE.sourceId, chunkIndex: 0 }, INDEX, base, DEFAULT_SEVERITY_LEVELS);
    assert.equal(criteriaPart.criteria.length, 1);
    // The list comes from the stored page by code, never from the model.
    assert.deepEqual(criteriaPart.criteria[0].criterion.source.listItems, ITEMS);
    const intakePart = assessChunkOutput(
      answer({
        intakeQuestions: [q("visit", { answerType: "multi_choice" }), q("main"), q("border")] as any,
        competenceSteps: [
          { criterionRef: "c1", restsOn: SOLE, questionId: "visit", whenAllOf: [] },
          { criterionRef: "c1", restsOn: MAIN, questionId: "main", whenAllOf: [] },
          { criterionRef: "c1", restsOn: BORDER, questionId: "border", whenAllOf: [] },
        ],
      }),
      { sourceId: PAGE.sourceId, chunkIndex: 0 },
      INDEX,
      base,
      DEFAULT_SEVERITY_LEVELS
    );
    const merged = mergeAssessments([{ chunk: { sourceId: PAGE.sourceId, chunkIndex: 0 }, assessment: { ...intakePart, criteria: criteriaPart.criteria } }]);
    assert.ok(!merged.flags.some((f) => f.code === "competence_dropped"), JSON.stringify(merged.flags.map((f) => f.code)));
    const steps = merged.competence?.steps ?? [];
    assert.deepEqual(steps.map((s) => s.restsOn), [SOLE, MAIN, BORDER]);
    // Each step's source is its rule's, list lines included (copied by code).
    for (const s of steps) assert.deepEqual(s.source.listItems, ITEMS);
    assert.deepEqual(competenceProblems({ criteria: merged.criteria, intakeQuestions: merged.intakeQuestions, competence: merged.competence }, { sharedRulebook: true }), []);
  });
});
