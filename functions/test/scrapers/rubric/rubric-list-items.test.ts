// ============================================
// Lists after a lead-in, and non-nationality group members (issue #222)
// ============================================
//
// Layouts below are SHAPED like the stored official pages (a rule whose
// sentence ends in a colon followed by plain lines; lettered lists with nested
// numerals; a mixed group "British citizen or right of abode"), but the wording
// is fictional or generic. No model, no network.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, test } from "node:test";
import { SnapshotQuoteIndex, uncodedNameSupported } from "../../../src/scrapers/rubric/rubric-quote";
import { LIST_ITEM_MAX_CHARS, quoteWithItems, readLeadInList, readListLines, verifyListItems } from "../../../src/scrapers/rubric/rubric-list-items";
import { assessChunkOutput, mergeAssessments, reviewFlagsFor } from "../../../src/scrapers/rubric/rubric-extraction.service";
import { validateCriterionShape } from "../../../src/scrapers/rubric/rubric-validate";
import { evaluateGates } from "../../../src/scrapers/rubric/rubric-gates";
import { buildBatchRequest } from "../../../src/scrapers/rubric/rubric-checker-prompt";
import { buildJudgementRequest, judgementCriteriaOf, mandatoryBarHits } from "../../../src/services/ai/assessment-engine";
import type { GuidanceSnapshotContent } from "../../../src/scrapers/guidance/types";
import { DEFAULT_SEVERITY_LEVELS, type AssessmentCriterion } from "../../../src/types/rubric";
import { answer, crit } from "./rubric-harness";
import { criterion, fictionalRubric } from "../../ai-case-officer/harness";

const snap = (lines: string[], extra: Partial<GuidanceSnapshotContent> = {}): GuidanceSnapshotContent => {
  const text = lines.join("\n");
  return { schemaVersion: 1, sourceId: "doc", contentHash: createHash("sha256").update(text).digest("hex"), docType: "html", url: "https://docs.example/z", finalUrl: "https://docs.example/z", fetchedAt: "2026-11-11T01:00:00.000Z", text, pages: null, ...extra };
};
const baseOf = (s: GuidanceSnapshotContent) => ({ sourceId: s.sourceId, url: s.url, contentHash: s.contentHash, retrievedAt: s.fetchedAt });
const CHUNK = { sourceId: "doc", chunkIndex: 0 };

// ---- page layouts ----
const LEAD = "Citizens of Examplia are not eligible to apply under these rules, except where they are subject to any of the following:";
const UNMARKED = [
  "3.2 Another group",
  "Some earlier paragraph that is not part of anything.",
  "3.3 Citizens of Examplia",
  LEAD,
  "a removal order made under section 5 of the Fictional Act 1971",
  "an exclusion decision made under regulation 23 of the Fictional Regulations 2016",
  "a travel ban implemented under section 8B of the Fictional Act 1971",
  "Those who fall within one of the exceptions above do need permission.",
  "3.4 Next heading",
];
const MARKED = [
  "Z 4.6. The Visitor must not receive payment from a local source, except for the following:",
  "(a) reasonable expenses to cover the cost of their travel; or",
  "(b) a person working as a driver, who:",
  "(i) is employed abroad; and",
  "(ii) carries goods into the country; or",
  "(c) prize money.",
  "Z 4.7. The Visitor must not work.",
];
const NESTED_LEAD = [
  "Z 5.1. A person may have permission cancelled where:",
  "(a) they are on route one; or",
  "(b) they are on route two, and all of the following apply:",
  "(i) they are sponsored by a club; and",
  "(ii) the player will return at the end of the loan.",
  "(c) another sibling item.",
];
const AT_END = ["Z 9.1. Entry is refused where the applicant is subject to any of the following:", "a first ground", "a second ground"];

function idx(lines: string[], quote: string) {
  const index = new SnapshotQuoteIndex(snap(lines));
  const found = index.locate(quote);
  assert.ok(found.ok, "the test quote must be found");
  return { index, found: found as Extract<typeof found, { ok: true }> };
}

describe("lead-in detection and list attachment", () => {
  test("unmarked list (real page layout): items are the lines up to the first non-item, verbatim, in order", () => {
    const { index, found } = idx(UNMARKED, LEAD);
    const read = readLeadInList(index, found);
    assert.equal(read.kind, "items");
    assert.deepEqual((read as { items: string[] }).items, UNMARKED.slice(4, 7));
    // the list ended at the paragraph, which starts with a capital
    assert.ok(!(read as { items: string[] }).items.includes(UNMARKED[7]));
  });

  test("a quote that stops just before the closing colon is still a lead-in", () => {
    const { index, found } = idx(UNMARKED, LEAD.slice(0, -1));
    assert.equal(readLeadInList(index, found).kind, "items");
  });

  test("marked list with a nested list: all items in document order, ends at the first unmarked line", () => {
    const { index, found } = idx(MARKED, "The Visitor must not receive payment from a local source, except for the following:");
    const read = readLeadInList(index, found);
    assert.deepEqual((read as { items: string[] }).items, MARKED.slice(1, 6));
  });

  test("a marked lead-in ends its list at its own sibling marker (nested numerals only)", () => {
    const { index, found } = idx(NESTED_LEAD, "(b) they are on route two, and all of the following apply:");
    assert.deepEqual((readLeadInList(index, found) as { items: string[] }).items, NESTED_LEAD.slice(3, 5));
  });

  test("a list that runs to the end of the page is read to its end", () => {
    const { index, found } = idx(AT_END, "Entry is refused where the applicant is subject to any of the following:");
    assert.deepEqual((readLeadInList(index, found) as { items: string[] }).items, ["a first ground", "a second ground"]);
  });

  test("a lead-in with no list following is unreadable, never an empty list", () => {
    const lines = ["Z 1.1. Examplia citizens must be one of the following:", "Z 1.2. A different rule entirely."];
    const { index, found } = idx(lines, "Examplia citizens must be one of the following:");
    assert.deepEqual(readLeadInList(index, found), { kind: "unreadable", reason: "no_list_follows" });
    const last = idx(["Z 1.1. Examplia citizens must be one of the following:"], "The applicant must be one of the following:");
    assert.deepEqual(readLeadInList(last.index, last.found), { kind: "unreadable", reason: "no_list_follows" });
  });

  test("a quote that is not a lead-in is not touched", () => {
    const { index, found } = idx(MARKED, "Z 4.7. The Visitor must not work.");
    assert.deepEqual(readLeadInList(index, found), { kind: "none" });
  });

  test("an item over the length limit is refused, never truncated", () => {
    const long = "a " + "x".repeat(LIST_ITEM_MAX_CHARS);
    assert.deepEqual(readListLines("The following apply:", ["a short one", long]), { kind: "unreadable", reason: "item_too_long" });
    assert.deepEqual(readListLines("The following apply:", ["(a) " + "y".repeat(LIST_ITEM_MAX_CHARS)]), { kind: "unreadable", reason: "item_too_long" });
  });

  test("unmarked capitalised lines cannot be told from headings: ambiguous; an unmarked nested lead-in is refused", () => {
    assert.deepEqual(readListLines("Apply if any of these:", ["Something capitalised without a stop"]), { kind: "unreadable", reason: "ambiguous_list_end" });
    assert.deepEqual(readListLines("Apply if any of these:", ["a first one", "a second one that introduces:", "a third"]), { kind: "unreadable", reason: "nested_unmarked_lead_in" });
  });

  test("a PDF page has no usable line layout: a lead-in there is unreadable", () => {
    const pdf = snap([], { docType: "pdf", text: "", pages: [{ page: 1, text: "Entry is refused where the applicant is subject to any of the following:\n a first ground\n a second ground" }] });
    const index = new SnapshotQuoteIndex(pdf);
    const found = index.locate("Entry is refused where the applicant is subject to any of the following:");
    assert.ok(found.ok);
    assert.deepEqual(readLeadInList(index, found as never), { kind: "unreadable", reason: "pdf_layout_lost" });
  });
});

describe("verifyListItems: verbatim, whole lines, whole list", () => {
  const { index, found } = idx(UNMARKED, LEAD);
  const items = UNMARKED.slice(4, 7);
  test("accepts exactly the lines of the snapshot", () => assert.deepEqual(verifyListItems(index, found, items), { ok: true }));
  test("rejects an altered, a reordered, a shortened and an extended list", () => {
    assert.equal(verifyListItems(index, found, [items[0].replace("removal", "deportation"), items[1], items[2]]).ok, false);
    assert.equal(verifyListItems(index, found, [items[1], items[0], items[2]]).ok, false);
    assert.equal(verifyListItems(index, found, items.slice(0, 2)).ok, false);
    assert.equal(verifyListItems(index, found, [...items, UNMARKED[7]]).ok, false);
  });
  test("quoteWithItems shows the quote then its lines", () => {
    assert.equal(quoteWithItems({ quote: "Q:", listItems: ["a", "b"] }), "Q:\na\nb");
    assert.equal(quoteWithItems({ quote: "Q." }), "Q.");
  });
});

describe("extraction: items are attached by code and stored in source.listItems", () => {
  const s = snap(UNMARKED);
  const index = new SnapshotQuoteIndex(s);
  const bar = (quote: string, extra = {}) => crit({ ref: "b", title: "Citizens barred", kind: "mandatory_bar", quote, appliesTo: { nationalities: ["EX"], asWritten: ["Examplia"] }, ...extra });
  const run = (c: ReturnType<typeof crit>, i = index, base = baseOf(s)) => assessChunkOutput(answer({ criteria: [c] }), CHUNK, i, base, DEFAULT_SEVERITY_LEVELS, null);

  test("a lead-in quote gets the stored list, and no combined_sub_conditions / list flag", () => {
    const out = run(bar(LEAD, { appliesTo: { nationalities: ["EX"], asWritten: ["Examplia"] } }));
    assert.equal(out.criteria[0].criterion.source.listItems?.length, 3);
    assert.deepEqual(out.criteria[0].criterion.source.listItems, UNMARKED.slice(4, 7));
    const merged = mergeAssessments([{ chunk: CHUNK, assessment: out }]);
    assert.deepEqual(merged.flags.filter((f) => f.code === "list_not_readable" || f.code === "combined_sub_conditions"), []);
  });

  test("the model cannot supply list text: nothing but the snapshot's lines can be stored", () => {
    const out = run(bar(LEAD));
    for (const item of out.criteria[0].criterion.source.listItems ?? []) assert.ok(s.text.split("\n").includes(item));
  });

  test("a rule that is not a lead-in has no listItems field", () => {
    const o = run(crit({ ref: "j", title: "Permission", kind: "judgement", quote: "Those who fall within one of the exceptions above do need permission.", probeFactors: ["x"], requiresInterviewBeforeRefusal: false }));
    assert.equal(o.criteria[0].criterion.source.listItems, undefined);
  });

  test("an unreadable list keeps the rule, flags it list_not_readable; a protected rule HOLDS, an ordinary rule is left out", () => {
    const lines = ["Z 1.1. Examplia citizens must be one of the following:", "Z 1.2. A different rule entirely."];
    const s2 = snap(lines);
    const i2 = new SnapshotQuoteIndex(s2);
    const quote = "Examplia citizens must be one of the following:";
    const ordinary = crit({ ref: "o", title: "Ordinary", kind: "judgement", quote, probeFactors: ["x"], requiresInterviewBeforeRefusal: false });
    const protectedBar = crit({ ref: "p", title: "Bar", kind: "mandatory_bar", quote, appliesTo: { nationalities: ["EX"], asWritten: ["Examplia"] } });
    for (const [c, isProtected] of [[ordinary, false], [protectedBar, true]] as const) {
      const out = assessChunkOutput(answer({ criteria: [c] }), CHUNK, i2, baseOf(s2), DEFAULT_SEVERITY_LEVELS, null);
      assert.ok(out.criteria[0], "the rule is kept, not discarded");
      const merged = mergeAssessments([{ chunk: CHUNK, assessment: out }]);
      const flag = merged.flags.find((f) => f.code === "list_not_readable");
      assert.ok(flag, "flag raised");
      assert.match(flag.message, /no_list_follows/);
      const verdict = evaluateGates({
        criteria: merged.criteria,
        flags: merged.flags.map((f) => ({ key: `${f.code}:${f.target}`, ...f })),
        suspiciousPassageCount: 0,
        structuralErrorCodes: [],
        primarySourceIds: new Set(["doc"]),
        allSourceIds: ["doc"],
        servingKeptCount: null,
        settings: { maxLeftOutShare: 1, maxPrimaryLeftOutShare: 1, minKeptShareOfServing: 0 },
      });
      if (isProtected) {
        assert.equal(verdict.protectedHold, true);
        assert.ok(verdict.reasonCodes.some((r) => r.startsWith("protected_rule_flagged:")));
      } else {
        assert.deepEqual(verdict.leftOut.map((l) => l.reason), ["list_not_readable"]);
      }
    }
  });

  test("existing sub-condition behaviour is unchanged: a lettered item quoted on its own is still its own rule, no listItems", () => {
    const s3 = snap(MARKED);
    const o = assessChunkOutput(answer({ criteria: [crit({ ref: "a", title: "Expenses", kind: "judgement", quote: "(a) reasonable expenses to cover the cost of their travel; or", probeFactors: ["x"], requiresInterviewBeforeRefusal: false })] }), CHUNK, new SnapshotQuoteIndex(s3), baseOf(s3), DEFAULT_SEVERITY_LEVELS, null);
    assert.equal(o.criteria[0].criterion.source.listItems, undefined);
    assert.equal(o.criteria[0].combinedSubConditions, false);
  });
});

describe("appliesTo.uncoded", () => {
  const MIXED = ["2.3 People who are citizens or who have a legal status", "A person who is a Borduria citizen, or who has right of abode in the country cannot be given permission under the rules."];
  const s = snap(MIXED);
  const index = new SnapshotQuoteIndex(s);
  const QUOTE = MIXED[1];
  const mixed = (appliesTo: { nationalities: string[]; asWritten: string[]; uncoded?: string[] }) =>
    assessChunkOutput(answer({ criteria: [crit({ ref: "m", title: "Citizens and status holders", kind: "mandatory_bar", quote: QUOTE, appliesTo })] }), CHUNK, index, baseOf(s), DEFAULT_SEVERITY_LEVELS, null);

  test("round-trips: a coded nationality plus an uncoded member verbatim in the quote; no code is invented for it", () => {
    const out = mixed({ nationalities: ["BD"], asWritten: ["Borduria"], uncoded: ["right of abode"] });
    const a = out.criteria[0].criterion.appliesTo;
    assert.deepEqual(a?.uncoded, ["right of abode"]);
    assert.deepEqual(a?.nationalities, ["BD"]);
    assert.deepEqual(a?.asWritten, ["Borduria"]);
    assert.equal(a?.codeNames?.length, 1, "codeNames stays parallel to the codes only");
    // stored shape survives a JSON round trip (Firestore)
    assert.deepEqual(JSON.parse(JSON.stringify(a)).uncoded, ["right of abode"]);
  });

  test("an uncoded entry that is not in the quote discards the rule (applies_to_not_in_quote)", () => {
    const out = mixed({ nationalities: ["BD"], asWritten: ["Borduria"], uncoded: ["refugee status"] });
    assert.equal(out.criteria.length, 0);
    assert.equal(out.discards[0].reason, "applies_to_not_in_quote");
  });

  test("a bar with only uncoded members is valid; a bar with no members at all is not", () => {
    const only = mixed({ nationalities: [], asWritten: [], uncoded: ["right of abode"] });
    assert.ok(only.criteria[0], "uncoded-only bar accepted");
    const none = mixed({ nationalities: [], asWritten: [], uncoded: [] });
    assert.equal(none.criteria.length, 0);
    assert.match(none.discards[0].detail, /bar_without_applies_to/);
  });

  test("shape: entries under 3 characters are invalid", () => {
    const c = mixed({ nationalities: ["BD"], asWritten: ["Borduria"], uncoded: ["right of abode"] }).criteria[0].criterion;
    const bad: AssessmentCriterion = { ...c, appliesTo: { ...(c.appliesTo as NonNullable<typeof c.appliesTo>), uncoded: ["ab"] } };
    assert.ok(validateCriterionShape(bad, DEFAULT_SEVERITY_LEVELS).some((i) => i.code === "applies_to_uncoded_invalid"));
  });

  test("uncodedNameSupported: lower-case phrases need two words; capitalised names follow the group-name rule", () => {
    assert.equal(uncodedNameSupported("right of abode", QUOTE), true);
    assert.equal(uncodedNameSupported("abode", QUOTE), false, "one lower-case word is not a group");
    assert.equal(uncodedNameSupported("right of", "A person with right of abode"), true);
    assert.equal(uncodedNameSupported("right of abod", QUOTE), false, "not token-bounded");
    assert.equal(uncodedNameSupported("ab", QUOTE), false);
  });

  test("reviewFlagsFor lists uncoded members in the 'confirm every code' flag", () => {
    const criteria = mixed({ nationalities: ["BD"], asWritten: ["Borduria"], uncoded: ["right of abode"] }).criteria.map((c) => c.criterion);
    const flags = reviewFlagsFor({ criteria, intakeQuestions: [] }, { chunkCount: 1, pagesEndingMidSentence: [] });
    const f = flags.find((x) => x.code === "nationality_codes_model_proposed");
    assert.match(f?.message ?? "", /right of abode/);
  });

  test("a version stored before #222 (no uncoded, no listItems) still validates", () => {
    const c = mixed({ nationalities: ["BD"], asWritten: ["Borduria"] }).criteria[0].criterion;
    assert.equal(c.appliesTo?.uncoded, undefined);
    assert.deepEqual(validateCriterionShape(c, DEFAULT_SEVERITY_LEVELS), []);
  });
});

describe("consumers carry the new fields", () => {
  const withBoth: AssessmentCriterion = {
    ...criterion({ criterionId: "bar1", kind: "mandatory_bar", stage: "validity", severity: "high", title: "Citizens and status holders" }),
    source: { quote: "Citizens are barred except where subject to any of the following:", sourceId: "doc", url: "https://docs.example/z", contentHash: "a".repeat(64), retrievedAt: "2026-11-01T00:00:00.000Z", listItems: ["a removal order", "a travel ban"] },
    appliesTo: { nationalities: ["BD"], asWritten: ["Borduria"], codeNames: ["Borduria"], uncoded: ["right of abode"] },
  };

  test("the checker request shows listItems and uncoded", () => {
    const req = buildBatchRequest("verification", [{ rule: withBoth, listLeadIn: "", textBefore: "", textAfter: "" }], { maxOutputTokens: 1000, timeoutMs: 1000 });
    assert.match(req.user, /"listItems":\["a removal order","a travel ban"\]/);
    assert.match(req.user, /"uncoded":\["right of abode"\]/);
    assert.match(req.system, /listItems/);
    assert.match(req.system, /uncoded/);
  });

  test("a rule without the fields renders empty lists (old versions still load)", () => {
    const plain = criterion({ criterionId: "j1", kind: "judgement", stage: "eligibility", severity: "high", title: "Plain" });
    const req = buildBatchRequest("verification", [{ rule: plain, listLeadIn: "", textBefore: "", textAfter: "" }], { maxOutputTokens: 1000, timeoutMs: 1000 });
    assert.match(req.user, /"listItems":\[\]/);
  });

  test("serving: code still matches the coded nationality only; the bar is ALSO put to the assessment model in full", () => {
    const rubric = fictionalRubric({ countryCode: "XX", visaTypeId: "visit", intentPolarity: null, criteria: [withBoth] });
    assert.equal(mandatoryBarHits(rubric, "BD", "2026-11-11").length, 1);
    assert.equal(mandatoryBarHits(rubric, "NG", "2026-11-11").length, 0, "no code is invented for the uncoded member");
    assert.deepEqual(judgementCriteriaOf(rubric).map((c) => c.criterionId), ["bar1"]);
    const req = buildJudgementRequest({ rubric, profileSummary: "", intakeSummary: "", extractionSummary: "", objectiveSummary: "" } as never);
    assert.match(req.user, /a removal order a travel ban/);
    assert.match(req.user, /right of abode/);
  });

  test("a bar without uncoded members is not sent to the judgement stage", () => {
    const plain: AssessmentCriterion = { ...withBoth, appliesTo: { nationalities: ["BD"], asWritten: ["Borduria"] } };
    const rubric = fictionalRubric({ countryCode: "XX", visaTypeId: "visit", intentPolarity: null, criteria: [plain] });
    assert.deepEqual(judgementCriteriaOf(rubric), []);
  });
});
