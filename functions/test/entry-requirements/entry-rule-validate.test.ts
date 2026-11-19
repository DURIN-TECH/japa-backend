// ============================================
// Entry requirements (issue #236) — the store refuses a rule without quote + URL
// ============================================

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { assertStorableEntryRule, entryRuleProblems, EntryRuleRefusedError } from "../../src/entry-requirements/entry-rule-validate";
import { rule } from "./fixtures";

describe("entryRuleProblems", () => {
  test("a complete rule is storable", () => {
    assert.deepEqual(entryRuleProblems(rule("r1")), []);
  });

  test("a rule without a quote, or without an https URL, is refused", () => {
    for (const over of [{ quote: "" }, { quote: undefined }, { quote: "too short" }]) {
      assert.throws(() => assertStorableEntryRule(rule("r1", over as never)), EntryRuleRefusedError);
    }
    for (const url of ["", "http://www.gov.example.org/x", "not a url", undefined]) {
      const problems = entryRuleProblems(rule("r1", { url: url as never }));
      assert.ok(problems.some((p) => p.startsWith("url:")), String(url));
    }
  });

  test("'not a visa' only on a travel authorisation, and only with its own quote and URL", () => {
    assert.ok(entryRuleProblems(rule("r1", { notAVisa: { quote: "It is not a visa at all.", url: "https://www.gov.example.org/x" } })).some((p) => p.startsWith("notAVisa")));
    assert.deepEqual(entryRuleProblems(rule("r1", { outcome: "travel_authorisation", notAVisa: { quote: "It is not a visa at all.", url: "https://www.gov.example.org/x" } })), []);
    assert.ok(entryRuleProblems(rule("r1", { outcome: "travel_authorisation", notAVisa: { quote: "", url: "" } })).some((p) => p.startsWith("notAVisa")));
  });

  test("a group naming nobody, a bad code, or a fee without its quote are refused", () => {
    assert.ok(entryRuleProblems(rule("r1", { group: { members: [], uncoded: [] } })).some((p) => p.startsWith("group:")));
    assert.ok(entryRuleProblems(rule("r1", { group: { members: [{ kind: "nationality", code: "xb", asWritten: "Xbland" }], uncoded: [] } })).some((p) => p.includes(".code")));
    assert.ok(entryRuleProblems(rule("r1", { fee: { amount: 10, currency: "XTS", quote: "" } })).some((p) => p.startsWith("fee.quote")));
    // An uncoded-only group is storable (kept as written, never decided by code).
    assert.deepEqual(entryRuleProblems(rule("r1", { group: { members: [], uncoded: ["holders of a special status"] } })), []);
  });

  test("the destination scope and its denormalised fields must agree", () => {
    assert.ok(entryRuleProblems(rule("r1", { destinationCodes: ["XZ"] })).length > 0);
    assert.deepEqual(entryRuleProblems(rule("r1", { destination: { kind: "members_of", authorityId: "test-bloc" }, destinationCodes: [], scopeAuthorityId: "test-bloc", issuingAuthorityId: "test-bloc" })), []);
  });
});
