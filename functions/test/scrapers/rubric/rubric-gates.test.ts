// ============================================
// Automatic rubric publishing (issue #201) — the pure code gates
// ============================================
//
// `evaluateGates` takes plain data, so each gate is tested with a fixture that
// FAILS ONLY THAT GATE, plus the all-pass case. Nothing here touches Firestore
// or a model. Rules are invented (no real guidance); ids are opaque strings.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  CHECKER_RESOLVED_FLAG_CODES,
  HOLD_FLAG_CODES,
  INFORMATIONAL_FLAG_CODES,
  LEAVE_OUT_FLAG_CODES,
  acknowledgementsFor,
  buildExclusionNote,
  duplicatePartnerOf,
  evaluateGates,
  reasonInWords,
  sampleAudit,
  type GateFlag,
  type GateInput,
} from "../../../src/scrapers/rubric/rubric-gates";
import { DEFAULT_PUBLISH_SETTINGS } from "../../../src/scrapers/rubric/rubric-publish-settings";
import { EXCLUSION_NOTE_MAX } from "../../../src/scrapers/rubric/rubric-exclusions";
import { possibleDuplicateFlags } from "../../../src/scrapers/rubric/rubric-extraction.service";
import type { AssessmentCriterion } from "../../../src/types/rubric";

/* eslint-disable @typescript-eslint/no-explicit-any */

/** An invented rule from source `src`. */
function rule(id: string, extra: Partial<AssessmentCriterion> = {}, src = "src-main"): AssessmentCriterion {
  return {
    criterionId: id,
    title: `Rule ${id}`,
    kind: "judgement",
    stage: "eligibility",
    severity: "high",
    source: { quote: `quote of ${id}`, sourceId: src, url: `https://docs.invalid/${src}`, contentHash: "h".repeat(64), retrievedAt: "2026-11-11T00:00:00.000Z" },
    confidence: 0.9,
    ...extra,
  };
}

/** A flag the way the review service lists it. */
const flag = (code: string, target: string, message = "m"): GateFlag => ({ key: `${code}:${target}`, code, target, message });

/** Twenty ordinary rules from the main source: a leave-out of up to three stays inside the default budget. */
const rules = (n = 20): AssessmentCriterion[] => Array.from({ length: n }, (_, i) => rule(`r${i + 1}`));

/** An input where every gate passes; tests override one thing. */
function input(over: Partial<GateInput> = {}): GateInput {
  return {
    criteria: rules(),
    flags: [],
    suspiciousPassageCount: 0,
    structuralErrorCodes: [],
    primarySourceIds: new Set(["src-main"]),
    allSourceIds: ["src-main"],
    servingKeptCount: null,
    settings: DEFAULT_PUBLISH_SETTINGS,
    checker: null,
    ...over,
  };
}

describe("gates: the all-pass case", () => {
  test("a clean draft passes every gate, leaves nothing out and keeps every rule", () => {
    const r = evaluateGates(input());
    assert.deepEqual(r.reasonCodes, []);
    assert.equal(r.counts.kept, 20);
    assert.deepEqual(r.excludedCriterionIds, []);
    assert.ok(r.gates.every((g) => g.passed), JSON.stringify(r.gates));
  });
});

describe("gates: each one fails alone", () => {
  test("structural validator error -> rubric_invalid", () => {
    const r = evaluateGates(input({ structuralErrorCodes: ["judgement_has_check"] }));
    assert.deepEqual(r.reasonCodes, ["rubric_invalid"]);
    assert.equal(r.gates.find((g) => g.gate === "structural_validity")?.passed, false);
  });

  test("suspicious passages (count or flag) -> suspicious_passages", () => {
    assert.deepEqual(evaluateGates(input({ suspiciousPassageCount: 1 })).reasonCodes, ["suspicious_passages"]);
    assert.deepEqual(evaluateGates(input({ flags: [flag("suspicious_passages", "rubric")] })).reasonCodes, ["suspicious_passages"]);
  });

  for (const code of ["no_criteria", "intent_polarity_conflict", "intent_criteria_without_polarity"]) {
    test(`flag ${code} holds the draft`, () => {
      const r = evaluateGates(input({ flags: [flag(code, "rubric")] }));
      assert.deepEqual(r.reasonCodes, [code]);
    });
  }

  test("a draft with no rules holds as no_criteria even without the flag (and nothing divides by zero)", () => {
    const r = evaluateGates(input({ criteria: [] }));
    assert.ok(r.reasonCodes.includes("no_criteria"));
    assert.equal(r.counts.rules, 0);
  });

  test("an unknown flag code holds as unknown_flag:<code>", () => {
    const r = evaluateGates(input({ flags: [flag("brand_new_code", "rubric")] }));
    assert.deepEqual(r.reasonCodes, ["unknown_flag:brand_new_code"]);
  });

  test("shrink guard: kept rules below the share of the serving version's", () => {
    // 20 kept of 40 serving = 0.5 < 0.7
    assert.deepEqual(evaluateGates(input({ servingKeptCount: 40 })).reasonCodes, ["shrink_below_floor"]);
    // exactly at the floor passes: 14 of 20 serving
    assert.deepEqual(evaluateGates(input({ servingKeptCount: 20 })).reasonCodes, []);
    assert.deepEqual(evaluateGates(input({ criteria: rules(14), servingKeptCount: 20 })).reasonCodes, []);
    assert.deepEqual(evaluateGates(input({ criteria: rules(13), servingKeptCount: 20 })).reasonCodes, ["shrink_below_floor"]);
  });

  test("shrink guard: a primary source with zero kept rules", () => {
    const r = evaluateGates(input({ criteria: rules(), allSourceIds: ["src-main", "src-other"], primarySourceIds: new Set(["src-main", "src-other"]) }));
    assert.deepEqual(r.reasonCodes, ["primary_source_empty:src-other"]);
    // A non-primary source with no rules is fine.
    assert.deepEqual(evaluateGates(input({ allSourceIds: ["src-main", "src-other"] })).reasonCodes, []);
  });

  test("leave-out budget: more than 15% of all rules", () => {
    // 4 of 20 = 20% > 15%
    const flags = ["r1", "r2", "r3", "r4"].map((id) => flag("quote_starts_mid_sentence", id));
    assert.deepEqual(evaluateGates(input({ flags })).reasonCodes, ["leave_out_budget_exceeded"]);
  });

  test("leave-out budget: exactly at the share passes (3 of 20 = 15%)", () => {
    const flags = ["r1", "r2", "r3"].map((id) => flag("quote_ends_mid_sentence", id));
    const r = evaluateGates(input({ flags, settings: { ...DEFAULT_PUBLISH_SETTINGS, maxPrimaryLeftOutShare: 0.2 } }));
    assert.deepEqual(r.reasonCodes, []);
    assert.equal(r.counts.leftOut, 3);
  });

  test("leave-out budget: the primary share is its own limit", () => {
    // 100 rules, 30 from a non-primary source: leaving out 12 primary of 70 = 17% (<= 20%), but 12 of 100 total = 12% (<= 15%): passes.
    // Now only primary rules are left out: 15 of 70 primary = 21.4% > 20% while 15 of 100 = 15% (not more than 15%).
    const crits = [...rules(70), ...Array.from({ length: 30 }, (_, i) => rule(`o${i}`, {}, "src-other"))];
    const flags = Array.from({ length: 15 }, (_, i) => flag("combined_sub_conditions", `r${i + 1}`));
    const r = evaluateGates(input({ criteria: crits, flags, allSourceIds: ["src-main", "src-other"] }));
    assert.deepEqual(r.reasonCodes, ["primary_leave_out_budget_exceeded"]);
  });
});

describe("gates: per-rule leave-outs from flags", () => {
  for (const code of LEAVE_OUT_FLAG_CODES) {
    test(`${code} leaves the flagged rule out, with the flag as the reason`, () => {
      const r = evaluateGates(input({ flags: [flag(code, "r5")] }));
      assert.deepEqual(r.reasonCodes, []);
      assert.deepEqual(r.leftOut, [{ criterionId: "r5", reason: code, flagCode: code }]);
      assert.deepEqual(r.excludedCriterionIds, ["r5"]);
      assert.equal(r.flagResolutions[`${code}:r5`], "left_out");
      assert.equal(r.counts.kept, 19);
      assert.deepEqual(r.primaryLeftOutIds, ["r5"]);
    });
  }

  test("the same flag on a protected rule HOLDS and the rule is never in the exclusion list", () => {
    const bar = rule("bar1", { kind: "mandatory_bar", appliesTo: { nationalities: ["QM"], asWritten: ["Nowhere"] } });
    const scoped = rule("scoped1", { appliesTo: { nationalities: ["QN"], asWritten: ["Elsewhere"] } });
    for (const p of [bar, scoped]) {
      const r = evaluateGates(input({ criteria: [...rules(), p], flags: [flag("quote_starts_mid_sentence", p.criterionId)] }));
      assert.deepEqual(r.reasonCodes, [`protected_rule_flagged:${p.criterionId}`]);
      assert.equal(r.protectedHold, true);
      assert.deepEqual(r.excludedCriterionIds, []);
      assert.deepEqual(r.heldRuleIds, [p.criterionId]);
    }
  });

  test("a leave-out flag naming no rule of the draft holds", () => {
    const r = evaluateGates(input({ flags: [flag("combined_sub_conditions", "ghost")] }));
    assert.deepEqual(r.reasonCodes, ["flag_target_unknown:combined_sub_conditions"]);
  });
});

describe("gates: possible_duplicate is applied last and a pair never vanishes", () => {
  const dup = (target: string, partner: string) => flag("possible_duplicate", target, `this criterion's quote is nearly the same as that of ${partner}. Decide whether they are one rule.`);

  test("duplicatePartnerOf reads the partner id from the code-written message", () => {
    assert.equal(duplicatePartnerOf(dup("a", "crit_0123456789abcdef")), "crit_0123456789abcdef");
    assert.equal(duplicatePartnerOf({ message: "something else" }), null);
  });

  test("the partner is read correctly from the REAL flag extraction writes", () => {
    const q = (id: string, quote: string) => rule(id, { source: { ...rule(id).source, quote } });
    const pair = [q("a", "the applicant must hold a valid passport for the whole stay"), q("b", "the applicant must hold a valid passport for the whole stay")];
    const [real] = possibleDuplicateFlags(pair);
    assert.equal(real.code, "possible_duplicate");
    assert.equal(duplicatePartnerOf(real), "b");
    const r = evaluateGates(input({ criteria: pair, flags: [{ ...real, key: `${real.code}:${real.target}` }], allSourceIds: [], settings: { ...DEFAULT_PUBLISH_SETTINGS, maxLeftOutShare: 1, maxPrimaryLeftOutShare: 1 } }));
    assert.deepEqual(r.excludedCriterionIds, ["a"]);
  });

  test("the flagged rule is left out when its partner is kept", () => {
    const r = evaluateGates(input({ flags: [dup("r1", "r2")] }));
    assert.deepEqual(r.excludedCriterionIds, ["r1"]);
    assert.equal(r.flagResolutions["possible_duplicate:r1"], "left_out");
  });

  test("when the partner is already left out by another flag, the flagged rule stays", () => {
    const r = evaluateGates(input({ flags: [dup("r1", "r2"), flag("quote_ends_mid_sentence", "r2")] }));
    assert.deepEqual(r.excludedCriterionIds, ["r2"], "only the partner is out, whatever the flag order");
    assert.equal(r.flagResolutions["possible_duplicate:r1"], "kept_partner_left_out");
  });

  test("mutual flags leave exactly one of the pair", () => {
    const r = evaluateGates(input({ flags: [dup("r1", "r2"), dup("r2", "r1")] }));
    assert.equal(r.excludedCriterionIds.length, 1);
    assert.equal(r.counts.kept, 19);
  });

  test("a chain a~b, b~c leaves c", () => {
    const r = evaluateGates(input({ flags: [dup("r1", "r2"), dup("r2", "r3")] }));
    assert.deepEqual(r.excludedCriterionIds, ["r1", "r2"]);
  });

  test("a duplicate flag on a protected rule holds; an unreadable partner holds", () => {
    const bar = rule("bar1", { kind: "mandatory_bar", appliesTo: { nationalities: ["QM"], asWritten: ["Nowhere"] } });
    const a = evaluateGates(input({ criteria: [...rules(), bar], flags: [dup("bar1", "r1")] }));
    assert.deepEqual(a.reasonCodes, ["protected_rule_flagged:bar1"]);
    const b = evaluateGates(input({ flags: [flag("possible_duplicate", "r1", "garbled")] }));
    assert.deepEqual(b.reasonCodes, ["duplicate_partner_unknown"]);
  });
});

describe("gates: informational flags never block and are counted", () => {
  test("every informational code passes, is counted and resolved as informational", () => {
    const flags = INFORMATIONAL_FLAG_CODES.map((c) => flag(c, "rubric"));
    const r = evaluateGates(input({ flags }));
    assert.deepEqual(r.reasonCodes, []);
    for (const c of INFORMATIONAL_FLAG_CODES) {
      assert.equal(r.informationalFlags[c], 1);
      assert.equal(r.flagResolutions[`${c}:rubric`], "informational");
    }
  });
});

describe("gates: the flag table is complete and disjoint", () => {
  test("no code sits in two groups", () => {
    const groups = [HOLD_FLAG_CODES, LEAVE_OUT_FLAG_CODES, INFORMATIONAL_FLAG_CODES, CHECKER_RESOLVED_FLAG_CODES, ["possible_duplicate"]];
    const all = groups.flat();
    assert.equal(new Set(all).size, all.length);
    // The 21 codes of the overview (every code extraction can raise) are all classified.
    for (const c of [
      "no_criteria", "suspicious_passages", "intent_polarity_conflict", "intent_criteria_without_polarity", "nationality_codes_model_proposed", "nationality_code_name_mismatch",
      "quote_starts_mid_sentence", "quote_ends_mid_sentence", "combined_sub_conditions", "multiple_dates_in_quote", "possible_duplicate", "judgement_check_stripped", "rule_ref_removed",
      "rule_ref_derived", "specialist_criteria_dropped", "evidence_trigger_simplified", "title_wording_uncited", "intake_wording_uncited", "multiple_chunks", "page_ends_mid_sentence", "intake_answer_type_unknown",
    ]) assert.ok(all.includes(c), c);
  });
});

describe("gates: the checker plug-in point", () => {
  const checkerFlags = CHECKER_RESOLVED_FLAG_CODES.map((c) => flag(c, "rubric"));

  test("flags only the check can resolve stay unresolved when it did not run (no second reason code)", () => {
    const r = evaluateGates(input({ flags: checkerFlags, checker: null }));
    assert.deepEqual(r.reasonCodes, []);
    const g = r.gates.find((x) => x.gate === "checker_resolved_flags");
    assert.equal(g?.passed, false);
    assert.match(g?.detail ?? "", /has not run/);
    assert.deepEqual(r.flagResolutions, {});
  });

  test("when the check ran and did not resolve a code, that is its own reason", () => {
    const r = evaluateGates(input({ flags: checkerFlags, checker: { leftOut: [], resolvedFlagCodes: ["title_wording_uncited"] } }));
    assert.deepEqual(r.reasonCodes, ["flag_unresolved:nationality_codes_model_proposed", "flag_unresolved:nationality_code_name_mismatch", "flag_unresolved:intake_wording_uncited"]);
  });

  test("when the check resolved every code, they pass and are recorded", () => {
    const r = evaluateGates(input({ flags: checkerFlags, checker: { leftOut: [], resolvedFlagCodes: [...CHECKER_RESOLVED_FLAG_CODES] } }));
    assert.deepEqual(r.reasonCodes, []);
    for (const f of checkerFlags) assert.equal(r.flagResolutions[f.key], "resolved_by_checker");
  });

  test("the check's leave-outs join the code's, count against the budget, and never take a protected rule", () => {
    const bar = rule("bar1", { kind: "mandatory_bar", appliesTo: { nationalities: ["QM"], asWritten: ["Nowhere"] } });
    const ok = evaluateGates(input({ checker: { leftOut: [{ criterionId: "r1", reason: "checker:title_faithful" }], resolvedFlagCodes: [] } }));
    assert.deepEqual(ok.leftOut, [{ criterionId: "r1", reason: "checker:title_faithful", flagCode: null }]);
    const over = evaluateGates(input({ checker: { leftOut: ["r1", "r2", "r3", "r4"].map((id) => ({ criterionId: id, reason: "checker:kind_right" })), resolvedFlagCodes: [] } }));
    assert.ok(over.reasonCodes.includes("leave_out_budget_exceeded"));
    const prot = evaluateGates(input({ criteria: [...rules(), bar], checker: { leftOut: [{ criterionId: "bar1", reason: "checker:group_matches_codes" }], resolvedFlagCodes: [] } }));
    assert.deepEqual(prot.reasonCodes, ["protected_rule_flagged:bar1"]);
    assert.deepEqual(prot.excludedCriterionIds, []);
    const ghost = evaluateGates(input({ checker: { leftOut: [{ criterionId: "ghost", reason: "checker:kind_right" }], resolvedFlagCodes: [] } }));
    assert.deepEqual(ghost.reasonCodes, ["checker_unknown_rule:ghost"]);
  });
});

describe("gates: acknowledgements, note, sample, wording", () => {
  test("only a flag with a recorded gate result is acknowledged", () => {
    const out = acknowledgementsFor(["a:1", "b:2", "c:3"], { "a:1": "left_out", "c:3": "informational" });
    assert.deepEqual(out, { acknowledged: ["a:1", "c:3"], unresolved: ["b:2"] });
  });

  test("the exclusion note is code-written, names the run and the counts by reason, and is capped", () => {
    const note = buildExclusionNote("XA_x__v3", 20, { quote_starts_mid_sentence: 2, possible_duplicate: 1 });
    assert.equal(note, "Automatic publish XA_x__v3: 3 of 20 rules left out (possible_duplicate: 1; quote_starts_mid_sentence: 2).");
    const long = buildExclusionNote("r", 5000, Object.fromEntries(Array.from({ length: 400 }, (_, i) => [`reason_number_${i}`, 1])));
    assert.ok(long.length <= EXCLUSION_NOTE_MAX);
  });

  test("the sample audit is reproducible, order-independent, version-dependent and at most ten", () => {
    const kept = rules(40);
    const a = sampleAudit(kept, 3);
    assert.equal(a.length, 10);
    assert.deepEqual(sampleAudit([...kept].reverse(), 3), a);
    assert.notDeepEqual(sampleAudit(kept, 4).map((r) => r.criterionId), a.map((r) => r.criterionId));
    assert.equal(sampleAudit(rules(4), 1).length, 4);
    assert.deepEqual(Object.keys(a[0]).sort(), ["criterionId", "quote", "ruleRef", "title", "url"]);
  });

  test("every reason code the pipeline raises has wording; unknown codes show as they are", () => {
    for (const c of ["rubric_invalid", "checker_not_configured", "question_plan_missing", "NOT_LATEST_VERSION", "settings_unreadable", "unknown_flag:x", "protected_rule_flagged:y"]) {
      assert.notEqual(reasonInWords(c), c, c);
    }
    assert.equal(reasonInWords("something_else"), "something_else");
  });
});
