import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { composeMarkerChain } from "../../../src/scrapers/rubric/rubric-marker-chain";
import { SnapshotQuoteIndex } from "../../../src/scrapers/rubric/rubric-quote";
import type { GuidanceSnapshotContent } from "../../../src/scrapers/guidance/types";

// Synthetic, fictional list layouts only (issue #112).

describe("composeMarkerChain", () => {
  it("returns an empty chain for no markers", () => {
    assert.deepEqual(composeMarkerChain([]), []);
  });

  it("a single marker is its own chain", () => {
    assert.deepEqual(composeMarkerChain(["c"]), ["(c)"]);
  });

  it("a nested roman list under a letter gives both levels", () => {
    assert.deepEqual(composeMarkerChain(["a", "i", "ii"]), ["(a)", "(ii)"]);
  });

  it("a later sibling replaces an earlier one: roman siblings never stack", () => {
    assert.deepEqual(composeMarkerChain(["a", "i", "ii", "iii", "iv", "v", "vi"]), ["(a)", "(vi)"]);
  });

  it("a shallower marker ends the deeper list", () => {
    assert.deepEqual(composeMarkerChain(["a", "i", "ii", "b"]), ["(b)"]);
    assert.deepEqual(composeMarkerChain(["a", "i", "ii", "b", "i"]), ["(b)", "(i)"]);
  });

  it("an (i) after (h) is alphabetic, not roman", () => {
    assert.deepEqual(composeMarkerChain(["g", "h", "i"]), ["(i)"]);
    assert.deepEqual(composeMarkerChain(["g", "h", "i", "j"]), ["(j)"]);
  });

  it("an (i) that opens a deeper list after (a) is roman", () => {
    assert.deepEqual(composeMarkerChain(["a", "i"]), ["(a)", "(i)"]);
  });

  it("a (v) after (iv) is roman, after (u) alphabetic", () => {
    assert.deepEqual(composeMarkerChain(["a", "i", "ii", "iii", "iv", "v"]), ["(a)", "(v)"]);
    assert.deepEqual(composeMarkerChain(["t", "u", "v"]), ["(v)"]);
  });

  it("an (x) after (ix) is roman, after (w) alphabetic", () => {
    assert.deepEqual(composeMarkerChain(["a", "i", "ii", "iii", "iv", "v", "vi", "vii", "viii", "ix", "x"]), ["(a)", "(x)"]);
    assert.deepEqual(composeMarkerChain(["v", "w", "x"]), ["(x)"]);
  });

  it("digits nest under letters and reset on the next letter", () => {
    assert.deepEqual(composeMarkerChain(["a", "1", "2"]), ["(a)", "(2)"]);
    assert.deepEqual(composeMarkerChain(["a", "1", "2", "b"]), ["(b)"]);
  });
});

/** A web-style snapshot: one unit per line. */
function web(lines: string[]): GuidanceSnapshotContent {
  const text = lines.join("\n");
  return { schemaVersion: 1, sourceId: "s", contentHash: "h", docType: "html", url: "https://docs.example/doc", finalUrl: "https://docs.example/doc", fetchedAt: "2026-11-11T01:00:00.000Z", text, pages: null };
}

describe("derivedRuleRef with sibling list markers", () => {
  it("does not stack siblings: the sixth numeral under (b) is X 9.9(b)(vi)", () => {
    const idx = new SnapshotQuoteIndex(
      web([
        "X 9.9. The applicant must not:",
        "(a) do the first thing in the list;",
        "(b) do one of the following:",
        "(i) the first nested thing here;",
        "(ii) the second nested thing here;",
        "(iii) the third nested thing here;",
        "(iv) the fourth nested thing here;",
        "(v) the fifth nested thing here;",
        "(vi) the sixth nested thing here;",
        "(c) do the last thing in the list.",
      ])
    );
    const nested = idx.locate("(vi) the sixth nested thing here;");
    assert.ok(nested.ok);
    assert.equal(idx.derivedRuleRef(nested), "X 9.9(b)(vi)");
    const last = idx.locate("(c) do the last thing in the list.");
    assert.ok(last.ok);
    assert.equal(idx.derivedRuleRef(last), "X 9.9(c)");
  });

  it("reads an (i) after (h) as the next letter", () => {
    const idx = new SnapshotQuoteIndex(
      web(["X 9.8. The applicant must not:", "(g) do the seventh thing;", "(h) do the eighth thing;", "(i) do the ninth thing;"])
    );
    const found = idx.locate("(i) do the ninth thing;");
    assert.ok(found.ok);
    assert.equal(idx.derivedRuleRef(found), "X 9.8(i)");
  });
});
