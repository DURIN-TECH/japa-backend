// ============================================
// The lead-in list reader after code review (issue #335, fix round 1)
// ============================================
//
// Review found that a MARKED list could still be cut short and look whole:
//   1. a nested lead-in whose own marker is on the line before it was given
//      its parent's later items;
//   2. any line without a marker ended the list silently ("or", "and",
//      "and/or", an editorial amendment mark, a row of dashes, a second
//      paragraph inside an item), and `verifyListItems`, which re-ran the same
//      reader, confirmed the cut list;
//   3. the line joined to a bare marker could be a heading or an amendment
//      mark;
// (the fourth finding, an ambiguous `restsOn`, is tested in
// rubric-competence-list-items.test.ts, on the Article 5(1) rule).
//
// Two kinds of test here:
//   A. the REAL stored text: Articles 25 and 32 of the Visa Code, lines copied
//      by code from the stored snapshot (fixtures/build-visa-code-fixtures.mjs,
//      never typed). Article 25(1) must read with its case (b); Article 32(1)
//      must read whole. Every expectation is built from the page's own lines
//      by position;
//   B. one test per reproduction in the review, on MADE-UP lines (fictional
//      wording, no legal text).
// No Firestore, no model, no network.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SnapshotQuoteIndex } from "../../../src/scrapers/rubric/rubric-quote";
import { LIST_UNREADABLE_DETAIL, LIST_UNREADABLE_REASONS, isAmendmentMark, isBareMarker, proveStoredList, readLeadInList, readListLines, verifyListItems } from "../../../src/scrapers/rubric/rubric-list-items";
import { lexiconFor } from "../../../src/scrapers/language/language-lexicon";
import type { GuidanceSnapshotContent } from "../../../src/scrapers/guidance/types";

// ============================================
// A. The real stored page
// ============================================

/** One fixture file: verbatim lines of the stored snapshot (no-break spaces kept). */
interface Fixture {
  sourceId: string;
  url: string;
  fetchedAt: string;
  lines: string[];
}
const fixture = (name: string): Fixture => JSON.parse(readFileSync(join(__dirname, "fixtures", name), "utf8")) as Fixture;

/** A snapshot made of a fixture's lines, hashed like a stored one, and its quote index. */
function pageOf(f: Fixture): SnapshotQuoteIndex {
  const text = f.lines.join("\n\n");
  const snap: GuidanceSnapshotContent = { schemaVersion: 1, sourceId: f.sourceId, contentHash: createHash("sha256").update(text).digest("hex"), docType: "html", url: f.url, finalUrl: f.url, fetchedAt: f.fetchedAt, text, pages: null };
  return new SnapshotQuoteIndex(snap);
}

/** A whole line of the page as a located quote (the lead-in is found in the page, never typed as a fact). */
function leadIn(index: SnapshotQuoteIndex, endsWith: string) {
  let unit = -1;
  for (let i = 0; i < index.unitCount && unit < 0; i++) if (index.unitText(i).endsWith(endsWith)) unit = i;
  assert.ok(unit >= 0, `the fixture has a line ending with "${endsWith}"`);
  const found = index.locate(index.unitText(unit));
  assert.ok(found.ok && found.unit === unit, "the lead-in is located on its own line");
  return found as Extract<typeof found, { ok: true }>;
}

/** The item a bare marker at `unit` makes with the line after it (how the reader joins them). */
const joined = (index: SnapshotQuoteIndex, unit: number): string => `${index.unitText(unit)} ${index.unitText(unit + 1)}`;

describe("Article 25(1) of the Visa Code (stored lines): the case after the \"or\" line is read", () => {
  const index = pageOf(fixture("visa-code-article-25.json"));
  const found = leadIn(index, "in the following cases:");
  const at = found.unit;
  const read = readLeadInList(index, found);
  const items = read.kind === "items" ? read.items : [];

  test("the page sets (a), its three numerals, a line that is only a connector word, then (b)", () => {
    // Offsets from the lead-in: +1 (a), +3 (i), +5 (ii), +7 (iii), +9 the connector, +10 (b), +12 the next paragraph's number.
    for (const k of [1, 3, 5, 7, 10]) assert.equal(isBareMarker(index.unitText(at + k)), true, `line +${k} is a bare marker`);
    assert.equal(index.unitText(at + 1), "(a)");
    assert.equal(index.unitText(at + 10), "(b)");
    // The connector line: one short word, no marker (this is the line the list used to stop at).
    assert.ok(/^\p{Ll}{2,3}$/u.test(index.unitText(at + 9)));
    assert.ok(/^2\.$/u.test(index.unitText(at + 12)));
  });

  test("the list is read whole: (a), (i), (ii), (iii), the connector line, (b)", () => {
    assert.equal(read.kind, "items");
    assert.deepEqual(items, [joined(index, at + 1), joined(index, at + 3), joined(index, at + 5), joined(index, at + 7), index.unitText(at + 9), joined(index, at + 10)]);
    assert.equal(items.length, 6);
    // Case (b) is there, with its words.
    assert.ok(items[5].startsWith("(b) ") && items[5].length > 40);
    // Nothing of paragraph 2 is attached.
    assert.ok(!items.some((i) => i.startsWith("2.")));
  });

  test("every stored line is word for word in the stored page, and the list verifies", () => {
    for (const item of items) assert.ok(index.allText().includes(item), item.slice(0, 24));
    assert.deepEqual(verifyListItems(index, found, items), { ok: true });
  });

  test("the list as the first round read it (cut before the connector) does not verify", () => {
    const cut = items.slice(0, 4);
    assert.equal(verifyListItems(index, found, cut).ok, false);
    // Nor does version 1's stored "(a)", nor the list without its connector line.
    assert.equal(verifyListItems(index, found, ["(a)"]).ok, false);
    assert.equal(verifyListItems(index, found, [...items.slice(0, 4), items[5]]).ok, false);
  });

  test("the second proof alone (no reader) refuses the cut list: the line after it is not a known end", () => {
    const following: string[] = [];
    for (let i = at + 1; i < index.unitCount; i++) if (index.unitText(i)) following.push(index.unitText(i));
    const ctx = { before: index.unitText(at - 1) };
    assert.deepEqual(proveStoredList(index.unitText(at), following, items, ctx), { ok: true });
    assert.deepEqual(proveStoredList(index.unitText(at), following, items.slice(0, 4), ctx), { ok: false, reason: "list_end_not_proven" });
    // Cut after any item but the last, the end is never proven.
    for (let n = 1; n < items.length; n++) assert.equal(proveStoredList(index.unitText(at), following, items.slice(0, n), ctx).ok, false, `cut to ${n}`);
  });
});

describe("Article 32(1) of the Visa Code (stored lines): read whole, never cut", () => {
  const index = pageOf(fixture("visa-code-article-32.json"));
  const outer = leadIn(index, "a visa shall be refused:");
  const at = outer.unit;
  const read = readLeadInList(index, outer);
  const items = read.kind === "items" ? read.items : [];

  test("the page: (a) is itself a lead-in, its numerals include an inserted (iia), then a connector line and (b)", () => {
    assert.equal(index.unitText(at + 1), "(a)");
    assert.ok(index.unitText(at + 2).endsWith(":"));
    assert.equal(index.unitText(at + 7), "(iia)");
    assert.equal(index.unitText(at + 20), "(b)");
    assert.ok(/^2\.$/u.test(index.unitText(at + 22)));
  });

  test("paragraph 1 is read whole: (a), eight numerals with (iia) in its place, the connector line, (b)", () => {
    assert.equal(read.kind, "items");
    const markers = [1, 3, 5, 7, 9, 11, 13, 15, 17];
    assert.deepEqual(items, [...markers.map((k) => joined(index, at + k)), index.unitText(at + 19), joined(index, at + 20)]);
    assert.equal(items.length, 11);
    assert.deepEqual(items.filter((i) => i.startsWith("(")).map((i) => i.slice(0, i.indexOf(")") + 1)), ["(a)", "(i)", "(ii)", "(iia)", "(iii)", "(iv)", "(v)", "(vi)", "(vii)", "(b)"]);
    for (const item of items) assert.ok(index.allText().includes(item), item.slice(0, 24));
    assert.deepEqual(verifyListItems(index, outer, items), { ok: true });
  });

  test("the list as the first round read it (nine lines, no connector, no (b)) does not verify", () => {
    assert.equal(verifyListItems(index, outer, items.slice(0, 9)).ok, false);
  });

  test("the NESTED lead-in (a), whose marker is on the line before it, gets its own numerals and not (b)", () => {
    // "(a)" is alone on the line before the lead-in line: that is the lead-in's own marker.
    const inner = index.locate(index.unitText(at + 2));
    assert.ok(inner.ok && inner.unit === at + 2);
    const found = inner as Extract<typeof inner, { ok: true }>;
    const nested = readLeadInList(index, found);
    assert.equal(nested.kind, "items");
    const got = (nested as { items: string[] }).items;
    assert.deepEqual(got, [3, 5, 7, 9, 11, 13, 15, 17].map((k) => joined(index, at + k)));
    // The parent's next case and the connector before it are NOT this rule's.
    assert.ok(!got.some((i) => i.startsWith("(b)")));
    assert.ok(!got.includes(index.unitText(at + 19)));
    assert.deepEqual(verifyListItems(index, found, got), { ok: true });
    // With the parent's (b) attached (what the first round returned), it does not verify.
    assert.equal(verifyListItems(index, found, [...got, joined(index, at + 20)]).ok, false);
  });
});

// ============================================
// B. The review's reproductions (made-up lines)
// ============================================

/** A made-up lead-in with no marker of its own. */
const LEAD = "A parcel is turned back where any of the following applies:";
/** Shorthand for a refusal. */
const refused = (reason: string) => ({ kind: "unreadable", reason });

describe("finding 1: a nested lead-in whose marker is on the line before it", () => {
  const NESTED = "where the sorting office considers it necessary:";
  const following = ["(i)", "to weigh the parcel again;", "(ii)", "to open the parcel;", "(b)", "where the sender asks for it.", "2."];

  test("with its marker read from the line before, the list stops at the parent's next item", () => {
    assert.deepEqual(readListLines(NESTED, following, { before: "(a)" }), { kind: "items", items: ["(i) to weigh the parcel again;", "(ii) to open the parcel;"] });
  });

  test("the parent's item is never attached, even when the line before is not known", () => {
    // "(b)" neither follows "(ii)" nor opens a deeper list at its first marker: refused, not attached.
    assert.deepEqual(readListLines(NESTED, following), refused("marker_out_of_order"));
  });

  test("the lead-in's marker on its own line still wins (the layout before #335)", () => {
    assert.deepEqual(readListLines(`(a) ${NESTED}`, following, { before: "1." }), { kind: "items", items: ["(i) to weigh the parcel again;", "(ii) to open the parcel;"] });
  });

  test("a connector line before the parent's next item belongs to the parent: not stored", () => {
    const withOr = ["(i)", "to weigh the parcel again;", "(ii)", "to open the parcel;", "or", "(b)", "where the sender asks for it.", "2."];
    assert.deepEqual(readListLines(NESTED, withOr, { before: "(a)" }), { kind: "items", items: ["(i) to weigh the parcel again;", "(ii) to open the parcel;"] });
  });
});

describe("finding 2: a line between two markers never ends the list silently", () => {
  const around = (x: string): string[] => ["(a)", "first;", x, "(b)", "second.", "2."];

  for (const connector of ["or", "and", "and/or"]) {
    test(`the connector line "${connector}" is kept, verbatim, between the two items`, () => {
      const read = readListLines(LEAD, around(connector));
      assert.deepEqual(read, { kind: "items", items: ["(a) first;", connector, "(b) second."] });
      // The cut list the reader used to return fails the second proof.
      assert.deepEqual(proveStoredList(LEAD, around(connector), ["(a) first;"]), { ok: false, reason: "list_end_not_proven" });
      assert.deepEqual(proveStoredList(LEAD, around(connector), ["(a) first;", connector, "(b) second."]), { ok: true });
    });
  }

  for (const mark of ["▼M5", "▼B", "◄", "►M5", "▼C1", "►M5 ◄"]) {
    test(`the amendment mark "${mark}" is recognised by shape, skipped, and never stored`, () => {
      assert.equal(isAmendmentMark(mark), true);
      const read = readListLines(LEAD, around(mark));
      assert.deepEqual(read, { kind: "items", items: ["(a) first;", "(b) second."] });
      assert.deepEqual(proveStoredList(LEAD, around(mark), ["(a) first;", "(b) second."]), { ok: true });
      assert.deepEqual(proveStoredList(LEAD, around(mark), ["(a) first;"]), { ok: false, reason: "list_end_not_proven" });
    });
  }

  test("amendment marks before the first item and before the end are skipped too", () => {
    assert.deepEqual(readListLines(LEAD, ["▼M5", "(a)", "first;", "▼B", "(b)", "second.", "◄", "2."]), { kind: "items", items: ["(a) first;", "(b) second."] });
  });

  test("words that only look like a mark are not skipped", () => {
    assert.equal(isAmendmentMark("M5"), false);
    assert.equal(isAmendmentMark("▼ see the note"), false);
    assert.equal(isAmendmentMark("or"), false);
  });

  test("a row of dashes between two items is REFUSED, with its reason", () => {
    assert.deepEqual(readListLines(LEAD, around("—————")), refused("line_after_item_not_recognised"));
    assert.deepEqual(readListLines(LEAD, around("-----")), refused("line_after_item_not_recognised"));
    assert.deepEqual(proveStoredList(LEAD, around("—————"), ["(a) first;"]), { ok: false, reason: "list_end_not_proven" });
  });

  test("a second unmarked paragraph inside an item is REFUSED, with its reason", () => {
    assert.deepEqual(readListLines(LEAD, around("This also covers parcels sent on from another office.")), refused("line_after_item_not_recognised"));
    assert.deepEqual(readListLines(LEAD, around("this also covers parcels sent on from another office;")), refused("line_after_item_not_recognised"));
    // The same with the markers on the items' own lines.
    assert.deepEqual(readListLines(LEAD, ["(a) first;", "This also covers parcels sent on.", "(b) second.", "2."]), refused("line_after_item_not_recognised"));
    assert.deepEqual(proveStoredList(LEAD, around("This also covers parcels sent on from another office."), ["(a) first;"]), { ok: false, reason: "list_end_not_proven" });
  });

  test("closing words under a list, a bullet and a table cell are refused, not dropped", () => {
    assert.deepEqual(readListLines(LEAD, ["(a) first; or", "(b) second,", "and the sender has been told in writing.", "Z 4.7. Next paragraph."]), refused("line_after_item_not_recognised"));
    assert.deepEqual(readListLines(LEAD, ["(a) first; or", "(b) second:", "• a bullet under it", "Z 4.7. Next paragraph."]), refused("line_after_item_not_recognised"));
    assert.deepEqual(readListLines(LEAD, ["(a) first; or", "(b) second.", "16", "Z 4.7. Next paragraph."]), refused("line_after_item_not_recognised"));
  });

  test("a connector that is not followed by a marker cannot be placed: refused", () => {
    assert.deepEqual(readListLines(LEAD, ["(a)", "first;", "or", "something unmarked.", "(b)", "second."]), refused("line_after_item_not_recognised"));
    assert.deepEqual(readListLines(LEAD, ["(a)", "first;", "or"]), refused("line_after_item_not_recognised"));
    assert.deepEqual(readListLines(LEAD, ["(a)", "first;", "or", "and", "(b)", "second."]), refused("line_after_item_not_recognised"));
  });

  test("connector words are language data: another language's are read with its lexicon only", () => {
    const es = lexiconFor("es");
    assert.deepEqual(readListLines(LEAD, ["(a)", "primero;", "o", "(b)", "segundo.", "2."], { lexicon: es }), { kind: "items", items: ["(a) primero;", "o", "(b) segundo."] });
    // The product language does not know that word: refused, never cut.
    assert.deepEqual(readListLines(LEAD, ["(a)", "primero;", "o", "(b)", "segundo.", "2."]), refused("line_after_item_not_recognised"));
    // A language with no lexicon file knows no connector at all.
    assert.deepEqual(readListLines(LEAD, around("or"), { lexicon: lexiconFor("zz") }), refused("line_after_item_not_recognised"));
  });
});

describe("the end of a marked list is a KNOWN end", () => {
  const two = ["(a)", "first;", "(b)", "second."];
  const whole = { kind: "items", items: ["(a) first;", "(b) second."] };

  test("the end of the page", () => assert.deepEqual(readListLines(LEAD, two), whole));

  test("a paragraph number alone on its line, an inserted one too", () => {
    assert.deepEqual(readListLines(LEAD, [...two, "2.", "The next paragraph."]), whole);
    assert.deepEqual(readListLines(LEAD, [...two, "1a.", "An inserted paragraph."]), whole);
    assert.deepEqual(readListLines(LEAD, [...two, "4.2", "A dotted paragraph."]), whole);
  });

  test("but not the number ONE (a numbered list inside the item), and not a stray number", () => {
    assert.deepEqual(readListLines(LEAD, [...two, "1.", "a numbered sub-point", "2.", "another", "(c)", "third."]), refused("line_after_item_not_recognised"));
    assert.deepEqual(readListLines(LEAD, [...two, "16", "(c)", "third."]), refused("line_after_item_not_recognised"));
  });

  test("a reference label, also one whose last number carries a letter", () => {
    assert.deepEqual(readListLines(LEAD, [...two, "Z 4.7. The next paragraph."]), whole);
    assert.deepEqual(readListLines(LEAD, [...two, "ZW 6.1A. An inserted paragraph."]), whole);
    assert.deepEqual(readListLines(LEAD, [...two, "ZW 1.5ZA. Another inserted paragraph."]), whole);
  });

  for (const heading of ["Article 8", "Article 25a", "ANNEX II", "Annex XII", "CHAPTER III", "Section 2", "TITLE IV", "Part B"]) {
    test(`the division heading "${heading}"`, () => assert.deepEqual(readListLines(LEAD, [...two, heading, "Its title", "1.", "Its first paragraph."]), whole));
  }

  test("an unlabelled heading (the index's own test): one before an ordinary paragraph, or a short stack before a labelled one", () => {
    assert.deepEqual(readListLines(LEAD, [...two, "Parcels sent abroad", "A parcel sent abroad is weighed twice before it leaves the sorting office, and the second weight is the one that counts."]), whole);
    assert.deepEqual(readListLines(LEAD, [...two, "Parcels sent abroad", "Weighing", "Z 5.1. A parcel sent abroad is weighed twice."]), whole);
    assert.deepEqual(readListLines(LEAD, [...two, "Parcels sent abroad"]), whole);
  });

  test("a title-shaped line is NOT an end when a list marker, or a run of short lines, follows it", () => {
    assert.deepEqual(readListLines(LEAD, [...two, "Parcels sent abroad", "(c)", "third."]), refused("line_after_item_not_recognised"));
    assert.deepEqual(readListLines(LEAD, [...two, "Northland", "Southland", "Eastland", "Westland", "Midland"]), refused("line_after_item_not_recognised"));
  });

  test("the second proof asks for the same known end after the last stored line", () => {
    for (const end of [["2."], ["Z 4.7. The next paragraph."], ["Article 8", "Its title"], []]) assert.deepEqual(proveStoredList(LEAD, [...two, ...end], whole.items), { ok: true });
    assert.deepEqual(proveStoredList(LEAD, [...two, "(c)", "third.", "2."], whole.items), { ok: false, reason: "list_end_not_proven" });
    assert.deepEqual(proveStoredList(LEAD, [...two, "more words of the second item.", "2."], whole.items), { ok: false, reason: "list_end_not_proven" });
    // A marked lead-in: its next sibling is a known end, with or without a connector before it.
    assert.deepEqual(proveStoredList("(c) all of these apply:", ["(i) first;", "(ii) second.", "(d) the sibling."], ["(i) first;", "(ii) second."]), { ok: true });
    assert.deepEqual(proveStoredList("all of these apply:", ["(i) first;", "(ii) second.", "or", "(d) the sibling."], ["(i) first;", "(ii) second."], { before: "(c)" }), { ok: true });
    assert.deepEqual(proveStoredList("(c) all of these apply:", ["(i) first;", "(ii) second.", "(iii) third.", "(d) the sibling."], ["(i) first;", "(ii) second."]), { ok: false, reason: "list_end_not_proven" });
  });

  test("the second proof refuses stored lines that are not the snapshot's, or not a list's", () => {
    assert.deepEqual(proveStoredList(LEAD, [...two, "2."], ["(a) first;", "(b) second!"]), { ok: false, reason: "items_not_in_snapshot" });
    assert.deepEqual(proveStoredList(LEAD, [...two, "2."], ["(a)", "first;", "(b)", "second."]), { ok: false, reason: "items_not_in_snapshot" });
    assert.deepEqual(proveStoredList(LEAD, ["(a)", "first;", "or", "(b)", "second.", "2."], ["(a) first;", "or"]), { ok: false, reason: "items_not_in_snapshot" });
    assert.deepEqual(proveStoredList(LEAD, [...two, "2."], []), { ok: false, reason: "items_not_in_snapshot" });
  });
});

describe("finding 3: the line joined to a bare marker must be words", () => {
  for (const heading of ["Article 7", "ANNEX II", "CHAPTER III", "Section 2", "TITLE IV"]) {
    test(`"(b)" followed by the heading "${heading}" is refused, never stored as an item`, () => {
      assert.deepEqual(readListLines(LEAD, ["(a)", "first;", "(b)", heading, "A title", "1.", "Words."]), refused("marker_without_text"));
    });
  }

  for (const mark of ["▼M5", "▼B", "◄"]) {
    test(`"(a)" followed by the amendment mark "${mark}" is refused, never stored as "(a) ${mark}"`, () => {
      assert.deepEqual(readListLines(LEAD, ["(a)", mark, "first;", "(b)", "second."]), refused("marker_without_text"));
    });
  }

  test("a connector word, a number, a label, a row of dashes or another marker is not an item's words", () => {
    for (const notWords of ["or", "and/or", "2.", "16", "Z 4.7. Next paragraph.", "—————", "(i)"]) {
      assert.deepEqual(readListLines(LEAD, ["(a)", notWords, "(b)", "second."]), refused("marker_without_text"), notWords);
    }
  });

  test("an amendment mark INSIDE an item's words makes the list unreadable (the mark is not official wording)", () => {
    assert.deepEqual(readListLines(LEAD, ["(a)", "►M5 first; ◄", "(b)", "second."]), refused("editorial_mark_in_item"));
    assert.deepEqual(readListLines(LEAD, ["(a) ▼M5", "(b) second."]), refused("editorial_mark_in_item"));
    assert.deepEqual(proveStoredList(LEAD, ["(a) ▼M5", "(b) second."], ["(a) ▼M5", "(b) second."]), { ok: false, reason: "editorial_mark_in_item" });
  });
});

describe("markers must be in order (the footnote and the missing-item cases)", () => {
  test("a list starts at its first marker", () => {
    assert.deepEqual(readListLines(LEAD, ["(b)", "second.", "2."]), refused("marker_out_of_order"));
    assert.deepEqual(readListLines(LEAD, ["(ii) second.", "2."]), refused("marker_out_of_order"));
  });

  test("a marker that skips one is refused (an item is missing from the stored text)", () => {
    assert.deepEqual(readListLines(LEAD, ["(a) first;", "(c) third.", "2."]), refused("marker_out_of_order"));
    assert.deepEqual(readListLines(LEAD, ["(a) first:", "(i) one;", "(iii) three.", "2."]), refused("marker_out_of_order"));
  });

  test("an inserted marker (the marker before it plus a letter) is in order, and so is what follows it", () => {
    assert.deepEqual(readListLines(LEAD, ["(a) first;", "(aa) inserted;", "(ab) inserted again;", "(b) second.", "2."]), { kind: "items", items: ["(a) first;", "(aa) inserted;", "(ab) inserted again;", "(b) second."] });
    assert.deepEqual(readListLines("where the office:", ["(i) one;", "(ii) two;", "(iia) two and a half;", "(iii) three.", "(b) the sibling."], { before: "(a)" }), { kind: "items", items: ["(i) one;", "(ii) two;", "(iia) two and a half;", "(iii) three."] });
    // An inserted marker out of its own order is refused.
    assert.deepEqual(readListLines(LEAD, ["(a) first;", "(ab) inserted;", "2."]), refused("marker_out_of_order"));
  });

  test("two markers on one line open the deeper list in order", () => {
    assert.deepEqual(readListLines(LEAD, ["(a) (i) one; and", "(ii) two; or", "(b) second.", "Z 4.7. Next."]), { kind: "items", items: ["(a) (i) one; and", "(ii) two; or", "(b) second."] });
    assert.deepEqual(readListLines(LEAD, ["(a) (ii) two;", "(b) second.", "Z 4.7. Next."]), refused("marker_out_of_order"));
  });

  test("a bracketed number after an item that ends with a full stop is not read as a nested item (a footnote line)", () => {
    assert.deepEqual(readListLines(LEAD, ["(a) first;", "(b) second.", "(1) A note printed at the foot of the page."]), refused("marker_out_of_order"));
    // Under an item that introduces it, a numbered list is read.
    assert.deepEqual(readListLines(LEAD, ["(a) first, where:", "(1) one; and", "(2) two;", "(b) second.", "2."]), { kind: "items", items: ["(a) first, where:", "(1) one; and", "(2) two;", "(b) second."] });
  });
});

describe("every reason has fixed, code-written wording", () => {
  test("no reason is without its detail text", () => {
    for (const reason of LIST_UNREADABLE_REASONS) assert.ok(LIST_UNREADABLE_DETAIL[reason].length > 20, reason);
    for (const added of ["marker_out_of_order", "line_after_item_not_recognised", "editorial_mark_in_item", "list_end_not_proven"]) assert.ok((LIST_UNREADABLE_REASONS as readonly string[]).includes(added), added);
  });
});
