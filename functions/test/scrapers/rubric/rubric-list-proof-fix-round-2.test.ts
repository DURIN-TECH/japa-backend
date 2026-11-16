// ============================================
// The second list proof after review round 2 (issue #335, fix round 2)
// ============================================
//
// Review round 2 (blocking 1): `proveStoredList` ended with the reader's own
// `isKnownEnd`, `leadMarkerOf` and `markerFollows`, so it stopped where the
// reader stopped and confirmed the reader's cuts. The reviewer fuzzed ~300,000
// line sequences (~54,000 marked lists) and the proof refused NONE. A heading-
// shaped line inside a list ("Exceptions for minors") cut it silently.
//
// The proof now walks PAST a heading-shaped end to the next hard start (or the
// end of the page) and refuses (`list_end_not_proven`) when the first marker
// met there would continue the stored list. These tests:
//   A. the reviewer's two layouts, verbatim as made-up lines;
//   B. what must still pass (a real heading, a new list under it, a paragraph
//      number before the next marker);
//   C. a seeded FUZZ with a ground-truth oracle: lists are BUILT whole, a
//      heading is sometimes put inside them, and the proof must never accept
//      a stored list that is missing one of the built items; and it must
//      actually refuse some (the round 2 failure was "zero refusals");
//   D. the cheap non-blocking fixes (a connector read as an unmarked item;
//      amendment marks before an unmarked list).
// All wording is MADE UP (fictional, no legal text). No Firestore, no model, no network.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { LIST_UNREADABLE_DETAIL, proveStoredList, readListLines } from "../../../src/scrapers/rubric/rubric-list-items";

/** A long ordinary sentence (not title-shaped, starts with a capital, no marker). */
const LONG = "This is an ordinary sentence of the fictional scheme that runs on for long enough to be read as a paragraph of text.";
/** A heading-shaped line (short, capitalised, unpunctuated). */
const HEADING = "Exceptions for minors";
/** A lead-in with no marker of its own. */
const LEAD = "The fictional cases shall be:";

/** Read the list, then prove what the reader returned. */
function readAndProve(following: string[], lead = LEAD) {
  const read = readListLines(lead, following);
  const proof = read.kind === "items" ? proveStoredList(lead, following, read.items) : undefined;
  return { read, proof };
}

// ============================================
// A. The reviewer's layouts
// ============================================

describe("blocking 1: a heading-shaped line inside a list no longer cuts it silently", () => {
  test("inline markers: (a) / heading / long sentence / (b) is refused by the proof", () => {
    const following = ["(a) diplomats;", HEADING, LONG, "(b) children under 12."];
    const { read, proof } = readAndProve(following);
    // The reader still stops at the heading (it cannot tell), so the proof is what catches it.
    assert.deepEqual(read, { kind: "items", items: ["(a) diplomats;"] });
    assert.deepEqual(proof, { ok: false, reason: "list_end_not_proven" });
  });

  test("bare markers: (a) / words / heading / long / (b) / words is refused by the proof", () => {
    const following = ["(a)", "the first case;", "Special Cases", LONG, "(b)", "the second case."];
    const { read, proof } = readAndProve(following);
    assert.deepEqual(read, { kind: "items", items: ["(a) the first case;"] });
    assert.deepEqual(proof, { ok: false, reason: "list_end_not_proven" });
  });

  test("a deeper level is caught too: (a) / (i) / heading / long / (ii)", () => {
    const following = ["(a) the first case, where:", "(i) one thing applies;", HEADING, LONG, "(ii) another thing applies."];
    const { proof } = readAndProve(following);
    assert.deepEqual(proof, { ok: false, reason: "list_end_not_proven" });
  });

  test("an inserted marker after the heading is caught: (ii) / heading / long / (iia)", () => {
    const following = ["(i) one thing applies;", "(ii) another thing applies;", HEADING, LONG, "(iia) an inserted thing applies."];
    const { proof } = readAndProve(following);
    assert.deepEqual(proof, { ok: false, reason: "list_end_not_proven" });
  });

  test("the reason's wording names the new check", () => {
    assert.match(LIST_UNREADABLE_DETAIL.list_end_not_proven, /after a heading-shaped end/);
  });
});

// ============================================
// B. What must still pass
// ============================================

describe("real ends still prove", () => {
  test("a heading, then a long line, then the end of the page", () => {
    assert.deepEqual(readAndProve(["(a) one;", "(b) two.", HEADING, LONG]).proof, { ok: true });
  });

  test("a heading, then a NEW list that opens with its own first marker", () => {
    const following = ["(a) one;", "(b) two.", HEADING, "Under this heading the fictional rules are:", "(a) another first;", "(b) another second;", "(c) another third."];
    assert.deepEqual(readAndProve(following).proof, { ok: true });
  });

  test("a heading, then a paragraph number before the next marker (another paragraph)", () => {
    const following = ["(a) one;", HEADING, LONG, "2.", "(b) belongs to paragraph two."];
    assert.deepEqual(readAndProve(following).proof, { ok: true });
  });

  test("a hard start straight after the list needs no walk", () => {
    assert.deepEqual(readAndProve(["(a) one;", "(b) two.", "Article 7", "(c) of another article."]).proof, { ok: true });
  });
});

// ============================================
// C. Fuzz with a ground-truth oracle
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

/**
 * One generated page: a lead-in list of `n` letter-marked items, BUILT whole
 * (so the oracle knows every item), in the inline or bare-marker layout, with
 * optional "or" connectors, amendment marks, a heading block INSIDE the list
 * (the cut the reviewer found), and something after it (nothing, a heading
 * block, a paragraph number, a division heading).
 */
function generate(rand: () => number): { following: string[]; markers: string[] } {
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)];
  const n = 2 + Math.floor(rand() * 4);
  const bare = rand() < 0.4;
  // Where (if anywhere) a heading block sits inside the list: after item `cut`.
  const cut = rand() < 0.5 ? Math.floor(rand() * (n - 1)) : -1;
  const headingBlock = (): string[] => [pick([HEADING, "Special Cases", "Further Provisions"]), pick([LONG, `${LONG} It goes on.`])];
  const following: string[] = [];
  const markers: string[] = [];
  for (let k = 0; k < n; k++) {
    const m = String.fromCharCode(97 + k);
    markers.push(m);
    const words = `the fictional case number ${k + 1}${k === n - 1 ? "." : ";"}`;
    if (bare) following.push(`(${m})`, words);
    else following.push(`(${m}) ${words}`);
    if (k < n - 1) {
      if (rand() < 0.15) following.push("▼M5");
      if (rand() < 0.2) following.push("or");
      if (k === cut) following.push(...headingBlock());
    }
  }
  const tail = pick(["none", "heading", "number", "division"] as const);
  if (tail === "heading") following.push(...headingBlock());
  if (tail === "number") following.push("2.", LONG);
  if (tail === "division") following.push("Article 9", LONG);
  return { following, markers };
}

describe("fuzz: the proof never accepts a list missing one of its built items", () => {
  test("20,000 seeded pages", () => {
    const rand = prng(335);
    let accepted = 0;
    let refusedByProof = 0;
    for (let run = 0; run < 20000; run++) {
      const { following, markers } = generate(rand);
      const { read, proof } = readAndProve(following);
      if (read.kind !== "items" || proof === undefined) continue;
      if (!proof.ok) {
        refusedByProof += 1;
        continue;
      }
      accepted += 1;
      // THE ORACLE: every built marker is in the stored list (none silently cut).
      const stored = read.items.filter((l) => l.startsWith("(")).map((l) => l.slice(1, l.indexOf(")")));
      assert.deepEqual(stored, markers, `accepted a cut list: ${JSON.stringify(following)}`);
    }
    // Round 2 failed on "zero refusals": the proof must actually refuse cut lists now.
    assert.ok(refusedByProof > 1000, `the proof refused only ${refusedByProof} lists`);
    // And it still accepts whole ones (it is not refusing everything).
    assert.ok(accepted > 1000, `the proof accepted only ${accepted} lists`);
  });
});

// ============================================
// D. Non-blocking fixes from review round 2
// ============================================

describe("non-blocking: a connector is never an unmarked item", () => {
  test("shall be: / or / (a) one; / (b) two. is refused by the reader", () => {
    assert.deepEqual(readListLines(LEAD, ["or", "(a) one;", "(b) two."]), { kind: "unreadable", reason: "connector_out_of_place" });
  });

  test("the proof refuses a stored connector-only unmarked list", () => {
    assert.deepEqual(proveStoredList(LEAD, ["or", "(a) one;"], ["or"]), { ok: false, reason: "connector_out_of_place" });
  });
});

describe("non-blocking: the reader and the proof agree on amendment marks before an unmarked list", () => {
  test("▼M5 / the applicant; / 2. reads AND proves", () => {
    const following = ["▼M5", "the fictional applicant.", "2."];
    const read = readListLines(LEAD, following);
    assert.deepEqual(read, { kind: "items", items: ["the fictional applicant."] });
    assert.deepEqual(proveStoredList(LEAD, following, ["the fictional applicant."]), { ok: true });
  });
});
