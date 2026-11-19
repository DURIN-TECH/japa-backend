// ============================================
// The second list proof after QA round 3 (issue #335, fix round 4)
// ============================================
//
// QA round 3 found two gaps in `proveStoredList`'s look past a heading-shaped
// end (`continuesAfterSoftEnd`):
//   (a) a sub-marker that REPEATS an earlier sub-list's marker was never
//       counted as continuing: the continuing set was "successors of every
//       stored marker, minus every stored marker", so with "(a) (i) (ii)
//       (b) (i)" stored, the next "(ii)" was already "stored" and ignored;
//   (b) the FIRST marker met decided: a footnote "(1) OJ L ..." (or a fresh
//       "(i)") under the heading ended the walk, so a continuing "(b)" after
//       it was never seen.
// The proof now takes the successors of the levels OPEN at the last stored
// item only, and walks to the hard start: every marker must either open a new
// list under the heading (a first marker) and be followed in order, or the
// list is refused. These tests:
//   A. QA's own layouts (inline and bare), all refused;
//   B. real ends that must still prove (footnotes after a WHOLE list, a new
//      nested list under the heading, a whole list with repeated sub-lists);
//   C. a seeded FUZZ with a ground-truth oracle that builds nested roman
//      sub-lists REPEATED under several letters, puts a heading block inside
//      the list (at the top level or inside a sub-list), and sometimes puts a
//      non-continuing marker (a footnote, a fresh "(i)") after the heading
//      before the continuing one. An accepted list must hold every built item.
// All wording is MADE UP (fictional, no legal text, apart from the shape of an
// Official Journal footnote reference). No Firestore, no model, no network.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { proveStoredList, readListLines } from "../../../src/scrapers/rubric/rubric-list-items";

/** A long ordinary sentence (not title-shaped, starts with a capital, no marker). */
const LONG = "This is an ordinary sentence of the fictional scheme that runs on for long enough to be read as a paragraph of text.";
/** A heading-shaped line (short, capitalised, unpunctuated). */
const HEADING = "Exceptions for minors";
/** A lead-in with no marker of its own. */
const LEAD = "The fictional cases shall be:";
/** A footnote line in the shape the Visa Code snapshot splits out of items (fix round 1 found these). */
const FOOTNOTE = "(1) OJ L 243, 15.9.2009, p. 1.";

/** Read the list, then prove what the reader returned. */
function readAndProve(following: string[], lead = LEAD) {
  const read = readListLines(lead, following);
  const proof = read.kind === "items" ? proveStoredList(lead, following, read.items) : undefined;
  return { read, proof };
}

const REFUSED = { ok: false, reason: "list_end_not_proven" } as const;

// ============================================
// A. QA round 3's layouts
// ============================================

describe("gap (a): a cut inside a SECOND sub-list that repeats the first one's markers is refused", () => {
  test("inline: (a) (i) (ii) (b) (i) / heading / sentence / (ii) / (c)", () => {
    const following = ["(a) where x applies:", "(i) one;", "(ii) two;", "(b) where y applies:", "(i) three;", HEADING, LONG, "(ii) four;", "(c) five."];
    const { read, proof } = readAndProve(following);
    // The reader stops at the heading (QA's stored list), so the proof is what catches it.
    assert.deepEqual(read, { kind: "items", items: ["(a) where x applies:", "(i) one;", "(ii) two;", "(b) where y applies:", "(i) three;"] });
    assert.deepEqual(proof, REFUSED);
  });

  test("bare markers (the EUR-Lex layout): the same list with every marker on its own line", () => {
    const following = ["(a)", "where x applies:", "(i)", "one;", "(ii)", "two;", "(b)", "where y applies:", "(i)", "three;", HEADING, LONG, "(ii)", "four;", "(c)", "five."];
    const { read, proof } = readAndProve(following);
    assert.deepEqual(read, { kind: "items", items: ["(a) where x applies:", "(i) one;", "(ii) two;", "(b) where y applies:", "(i) three;"] });
    assert.deepEqual(proof, REFUSED);
  });

  test("the cut between the two sub-lists' parents is refused too: ... (b) (i) (ii) / heading / (c)", () => {
    const following = ["(a) where x applies:", "(i) one;", "(ii) two;", "(b) where y applies:", "(i) three;", "(ii) four;", HEADING, LONG, "(c) five."];
    assert.deepEqual(readAndProve(following).proof, REFUSED);
  });

  test("a repeated (ii) after an amendment mark or an 'or' line under the heading is refused", () => {
    for (const between of ["▼M5", "or"]) {
      const following = ["(a) where x applies:", "(i) one;", "(ii) two;", "(b) where y applies:", "(i) three;", HEADING, LONG, between, "(ii) four;", "(c) five."];
      assert.deepEqual(readAndProve(following).proof, REFUSED, between);
    }
  });
});

describe("gap (b): a marker that is not this list's no longer decides", () => {
  test("inline: (a) / heading / sentence / footnote (1) / (b) is refused", () => {
    const following = ["(a) one;", HEADING, LONG, FOOTNOTE, "(b) two."];
    const { read, proof } = readAndProve(following);
    assert.deepEqual(read, { kind: "items", items: ["(a) one;"] });
    assert.deepEqual(proof, REFUSED);
  });

  test("bare: (a) / words / heading / sentence / footnote (1) / (b) / words is refused", () => {
    const following = ["(a)", "one;", HEADING, LONG, FOOTNOTE, "(b)", "two."];
    assert.deepEqual(readAndProve(following).proof, REFUSED);
  });

  test("a fresh (i) before the continuing (b) is refused (inline and bare)", () => {
    assert.deepEqual(readAndProve(["(a) one;", HEADING, LONG, "(i) a fresh numeral;", "(b) two."]).proof, REFUSED);
    assert.deepEqual(readAndProve(["(a)", "one;", HEADING, LONG, "(i)", "a fresh numeral;", "(b)", "two."]).proof, REFUSED);
  });

  test("a marker that is neither continuing nor a first marker is refused (the proof cannot say whose it is)", () => {
    assert.deepEqual(readAndProve(["(a) one;", HEADING, LONG, "(f) some other list's line."]).proof, REFUSED);
  });

  test("both gaps at once: a repeated sub-list cut, then a footnote, then the continuing (ii)", () => {
    const following = ["(a) where x applies:", "(i) one;", "(ii) two;", "(b) where y applies:", "(i) three;", HEADING, LONG, FOOTNOTE, "(ii) four;", "(c) five."];
    assert.deepEqual(readAndProve(following).proof, REFUSED);
  });
});

// ============================================
// B. Real ends that must still prove
// ============================================

describe("real ends still prove after fix round 4", () => {
  test("a whole list with repeated sub-lists, then a heading and a sentence", () => {
    const following = ["(a) where x applies:", "(i) one;", "(ii) two;", "(b) where y applies:", "(i) three;", "(ii) four.", HEADING, LONG];
    const { read, proof } = readAndProve(following);
    assert.equal(read.kind, "items");
    assert.deepEqual(proof, { ok: true });
  });

  test("footnotes after a WHOLE list (a new numbered run that follows in order)", () => {
    const following = ["(a) one;", "(b) two.", HEADING, LONG, FOOTNOTE, "(2) OJ L 105, 13.4.2006, p. 1."];
    assert.deepEqual(readAndProve(following).proof, { ok: true });
  });

  test("a new NESTED list under the heading, opened with its own (a)", () => {
    const following = ["(a) one;", "(b) two.", HEADING, "Under this heading the fictional rules are:", "(a) where x applies:", "(i) one;", "(ii) two;", "(b) where y applies:", "(i) three;", "(c) another."];
    assert.deepEqual(readAndProve(following).proof, { ok: true });
  });

  test("a new list under the heading that opens with (1), then a paragraph number", () => {
    const following = ["(a) one;", "(b) two.", HEADING, LONG, "(1) first;", "(2) second.", "2.", "(c) belongs to paragraph two."];
    assert.deepEqual(readAndProve(following).proof, { ok: true });
  });

  test("a lead-in with its own marker: its sibling under the heading still refuses, a new list does not", () => {
    // "(3) ... shall be:" expects "(4)" next; a cut "(a)" followed, after a heading, by "(4)" must not prove.
    const lead = "(3) The fictional cases shall be:";
    const cut = ["(a) one;", HEADING, LONG, "(4) the next paragraph's case."];
    const read = readListLines(lead, cut, { before: "Article 2" });
    if (read.kind === "items") assert.deepEqual(proveStoredList(lead, cut, read.items, { before: "Article 2" }), REFUSED);
  });
});

// ============================================
// C. Fuzz: nested, repeated sub-lists; headings; non-continuing markers
// ============================================

/** A small seeded PRNG (mulberry32): the same sequences on every run. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ROMANS = ["i", "ii", "iii", "iv"];

/**
 * One generated page. The list is BUILT whole, so the oracle knows every
 * marker in order: 2 to 4 letter items, and each letter (often more than one,
 * so the roman markers REPEAT) may open a sub-list of 2 to 4 roman items. A
 * heading block may sit after any built line except the last (at the top
 * level or inside a sub-list), sometimes followed by a non-continuing marker
 * line (a footnote, a fresh "(i)") and/or an amendment mark or "or" before
 * the list goes on. After the list: nothing, a heading block, a heading with
 * footnotes, a heading with a new list, a paragraph number, a division heading.
 */
function generate(rand: () => number): { following: string[]; markers: string[] } {
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)];
  const bare = rand() < 0.4;
  // The built list, as [marker, words] lines in reading order.
  const built: Array<[string, string]> = [];
  const letters = 2 + Math.floor(rand() * 3);
  for (let k = 0; k < letters; k++) {
    const m = String.fromCharCode(97 + k);
    const sub = rand() < 0.6 ? 2 + Math.floor(rand() * 3) : 0;
    built.push([m, sub > 0 ? `where fictional case ${k + 1} applies:` : `the fictional case number ${k + 1};`]);
    for (let r = 0; r < sub; r++) built.push([ROMANS[r], `the fictional sub-case ${k + 1}.${r + 1};`]);
  }
  // The very last line closes the list with a full stop.
  const last = built[built.length - 1];
  last[1] = last[1].replace(/[;:]$/u, ".");
  if (last[1].endsWith(":.")) last[1] = last[1].slice(0, -2) + ".";
  // Where (if anywhere) a heading block sits inside the list: after built line `cut`.
  const cut = rand() < 0.6 ? Math.floor(rand() * (built.length - 1)) : -1;
  const headingBlock = (): string[] => [pick([HEADING, "Special Cases", "Further Provisions"]), pick([LONG, `${LONG} It goes on.`])];
  const following: string[] = [];
  built.forEach(([m, words], k) => {
    if (bare) following.push(`(${m})`, words);
    else following.push(`(${m}) ${words}`);
    if (k === cut) {
      following.push(...headingBlock());
      // The gap (b) shapes: a marker that is not this list's before it goes on.
      const intruder = pick(["none", "footnote", "fresh-i", "footnote-and-mark"] as const);
      if (intruder === "footnote") following.push(FOOTNOTE);
      if (intruder === "fresh-i") following.push(...(bare ? ["(i)", "a fresh numeral;"] : ["(i) a fresh numeral;"]));
      if (intruder === "footnote-and-mark") following.push(FOOTNOTE, pick(["▼M5", "or"]));
    } else if (k < built.length - 1) {
      if (rand() < 0.1) following.push("▼M5");
      if (rand() < 0.1) following.push("or");
    }
  });
  const tail = pick(["none", "heading", "footnotes", "new-list", "number", "division"] as const);
  if (tail === "heading") following.push(...headingBlock());
  if (tail === "footnotes") following.push(...headingBlock(), FOOTNOTE, "(2) OJ L 105, 13.4.2006, p. 1.");
  if (tail === "new-list") following.push(...headingBlock(), "Under this heading the fictional rules are:", "(a) another first;", "(i) its sub-case;", "(b) another second.");
  if (tail === "number") following.push("2.", LONG);
  if (tail === "division") following.push("Article 9", LONG);
  return { following, markers: built.map(([m]) => m) };
}

describe("fuzz: nested, repeated sub-lists and non-continuing markers never let a cut list through", () => {
  test("30,000 seeded pages", () => {
    const rand = prng(3354);
    let accepted = 0;
    let refusedByProof = 0;
    let cutAndAccepted = 0;
    let wholeAccepted = 0;
    for (let run = 0; run < 30000; run++) {
      const { following, markers } = generate(rand);
      const { read, proof } = readAndProve(following);
      if (read.kind !== "items" || proof === undefined) continue;
      if (!proof.ok) {
        refusedByProof += 1;
        continue;
      }
      accepted += 1;
      // THE ORACLE: every built marker is in the stored list, in order (none silently cut).
      const stored = read.items.filter((l) => l.startsWith("(")).map((l) => l.slice(1, l.indexOf(")")));
      if (stored.join(",") !== markers.join(",")) cutAndAccepted += 1;
      else wholeAccepted += 1;
      assert.deepEqual(stored, markers, `accepted a cut list: ${JSON.stringify(following)}`);
    }
    assert.equal(cutAndAccepted, 0);
    // The fuzz must exercise both sides: many cut lists refused, many whole lists accepted.
    assert.ok(refusedByProof > 3000, `the proof refused only ${refusedByProof} lists`);
    assert.ok(accepted > 3000 && wholeAccepted === accepted, `the proof accepted only ${accepted} lists`);
  });
});

// ============================================
// D. Review round 4: a last line ending "; or" / "; and" promises another item
// ============================================

describe("review round 4: a stored last line that ends with a connector is a cut unless the lead-in's sibling follows", () => {
  test("(a) one; / (b) two; or / 2. is refused (a cut at a hard start)", () => {
    const following = ["(a) one;", "(b) two; or", "2.", LONG];
    assert.deepEqual(proveStoredList(LEAD, following, ["(a) one;", "(b) two; or"]), REFUSED);
  });

  test("every connector of the language file, after the semicolon, is refused at a hard start, a heading and the end of the page", () => {
    for (const word of ["or", "and", "and/or", "OR"]) {
      const last = `(b) two; ${word}`;
      for (const tail of [["2."], ["Article 9"], [HEADING, LONG], []]) {
        const following = ["(a) one;", last, ...tail];
        assert.deepEqual(proveStoredList(LEAD, following, ["(a) one;", last]), REFUSED, `${word} / ${JSON.stringify(tail)}`);
      }
    }
  });

  test("the lead-in's sibling right after it is a whole list: a nested lead-in's last sub-item may end '; or'", () => {
    const lead = "(a) the fictional cases where:";
    const following = ["(i) one;", "(ii) two; or", "(b) the next case of the parent."];
    assert.deepEqual(proveStoredList(lead, following, ["(i) one;", "(ii) two; or"], { before: "1." }), { ok: true });
    // An amendment mark between them is layout and changes nothing.
    assert.deepEqual(proveStoredList(lead, ["(i) one;", "(ii) two; or", "▼M5", "(b) the next case."], ["(i) one;", "(ii) two; or"], { before: "1." }), { ok: true });
  });

  test("words that only contain a connector are not one ('; order', '; or the next')", () => {
    for (const last of ["(b) two; order.", "(b) two; or the next one."]) {
      assert.deepEqual(proveStoredList(LEAD, ["(a) one;", last, "2."], ["(a) one;", last]), { ok: true }, last);
    }
  });

  test("a whole list ending with a full stop still proves at a hard start", () => {
    assert.deepEqual(proveStoredList(LEAD, ["(a) one; or", "(b) two.", "2."], ["(a) one; or", "(b) two."]), { ok: true });
  });
});
