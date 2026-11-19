// ============================================
// Unit tests — review narrative: no more false drops (issue #408)
// ============================================
//
// The #384 code checks dropped correct sentences: everyday "section / rule"
// wording counted as a rule citation, and a correct money figure was dropped
// when the document gave no currency or gave it in lowercase. These tests pin
// every example in #408's acceptance criteria, AND keep every #384 probe
// (invented figures, wrong currency, invented quotes, listing the rulebook)
// dropped. Pure functions and `parseNarrative` only: no model, no emulator.
//
// Figures and rule refs are fictional test data, never product text.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  buildNarrativeRequest,
  currencyOfUnit,
  declaredCurrencyOf,
  figuresAreGrounded,
  labelIntakeAmounts,
  moneyFieldsFor,
  NARRATIVE_CITATION_LIMITS,
  NARRATIVE_CONCLUSION_LEADS,
  narrativeGroundingOf,
  parseNarrative,
  quotationsAreGrounded,
  ruleCitationsIn,
  type NarrativeFigureFacts,
  type NarrativeGrounding,
  type NarrativeRequestInput,
  type NarrativeRuleRef,
} from "../../src/services/ai/assessment-engine";
import type { RefusalGround } from "../../src/types/assessment";

/* eslint-disable @typescript-eslint/no-explicit-any */

// ----- Fixtures -----

/** An unrelated rubric rule: the everyday-wording cases must count 0 with or without it. */
const UNRELATED_RULE: NarrativeRuleRef = { ref: "V 4.2", quote: "visitors must leave at the end of their visit" };

/** The three rules of the #384 reviewer's probe. */
const PROBE_RULES: NarrativeRuleRef[] = [
  { ref: "V 4.2", quote: "visitors must leave at the end" },
  { ref: "V 4.3", quote: "visitors must have funds" },
  { ref: "V 4.4", quote: "visitors must not work" },
];

/** A refusal ground carrying one rubric rule (as assembly stores it). */
function ground(ruleRef: string, sourceQuote: string, criterionId: string): RefusalGround {
  return {
    criterionId,
    title: "Funds meet the minimum",
    kind: "objective",
    isMandatoryBar: false,
    stage: "eligibility",
    ruleRef,
    sourceUrl: "https://example.test/rule",
    sourceQuote,
    detail: "We couldn't find this in your documents.",
    whatWouldHelp: "Provide evidence that meets this requirement.",
  };
}

/** A narrative request input built by hand: one money field, one duration field. */
function input(partial: Partial<NarrativeRequestInput> = {}): NarrativeRequestInput {
  return {
    readiness: "weak",
    findings: {
      refusalGrounds: PROBE_RULES.map((r, i) => ground(r.ref as string, r.quote as string, `r${i}`)),
      credibilityFlags: [],
      statementFindings: [],
      insufficientInformation: [],
      strengths: [],
    },
    profileSummary: "Applicant name: Test Applicant.",
    intakeSummary: JSON.stringify({ savings: { amount: 2000000, currency: "NGN" } }),
    extractionSummary: "closingBalance: 1500000",
    statementText: null,
    ...partial,
  };
}

/** Figure facts with one value on the money field `closingBalance` (and optionally more). */
function facts(values: NarrativeFigureFacts["values"], moneyFields: string[] = ["closingBalance"]): NarrativeFigureFacts {
  return { values, moneyFields };
}

/** The figure sources for a given intake and extracted values. */
function sourcesFor(intakeSummary: string, figureFacts: NarrativeFigureFacts): string[] {
  return narrativeGroundingOf(input({ intakeSummary, figureFacts })).figureSources;
}

const NAIRA_INTAKE = JSON.stringify({ savings: { amount: 2000000, currency: "NGN" } });

/** A narrative answer for the weak band. */
function answer(paragraphs: string[], conclusion = `${NARRATIVE_CONCLUSION_LEADS.weak} you will leave at the end of your visit.`, nextSteps: string[] = []): string {
  return JSON.stringify({ paragraphs, conclusion, nextSteps });
}

// ============================================
// Rule citations: everyday wording no longer counts
// ============================================

describe("#408 rule citations: everyday wording no longer counts", () => {
  const everyday = [
    "The rules in 2025 changed how this works.",
    "Paragraph 2 of your statement explains the gap.",
    "Section 3 of your bank letter shows the balance.",
    "You meet the rule of 28 days.",
  ];
  for (const s of everyday) {
    test(`"${s}" counts 0 (no rubric rules, and with an unrelated rule)`, () => {
      assert.equal(ruleCitationsIn(s), 0);
      assert.equal(ruleCitationsIn(s, [UNRELATED_RULE]), 0);
    });
  }

  test("a numeric-only rubric ref followed by a unit word counts 0", () => {
    const rules = [{ ref: "2.3", quote: null }];
    assert.equal(ruleCitationsIn("Your savings are 2.3 times the amount needed.", rules), 0);
    assert.equal(ruleCitationsIn("You have lived there 2.3 years.", rules), 0);
    assert.equal(ruleCitationsIn("Your costs rose 2.3%.", rules), 0);
  });

  test("the same numeric ref still counts 1 when no unit word follows it", () => {
    assert.equal(ruleCitationsIn("Under 2.3 you need a sponsor.", [{ ref: "2.3", quote: null }]), 1);
  });
});

// ============================================
// Rule citations: real citations still count
// ============================================

describe("#408 rule citations: real citations still count", () => {
  test("a rubric ref written as the rubric writes it counts 1 (with its 'Rule' word: one citation)", () => {
    assert.equal(ruleCitationsIn("Rule V 4.2 is met.", [UNRELATED_RULE]), 1);
    assert.equal(ruleCitationsIn("Appendix V asks for this.", [{ ref: "Appendix V", quote: null }]), 1);
  });

  test("the letter prefix is case-sensitive: 'v 4.2' and 'appendix v' are not the rubric's refs", () => {
    assert.equal(ruleCitationsIn("see v 4.2", [UNRELATED_RULE]), 0);
    assert.equal(ruleCitationsIn("the appendix v copy", [{ ref: "Appendix V", quote: null }]), 0);
  });

  test("'V 4.21' does not count for rubric ref 'V 4.2' (unchanged)", () => {
    assert.equal(ruleCitationsIn("see V 4.21", [UNRELATED_RULE]), 0);
  });

  test("a generic ref the rubric did not send counts with a capitalised prefix or a dotted number", () => {
    assert.equal(ruleCitationsIn("This is paragraph V 4.3.", []), 1);
    assert.equal(ruleCitationsIn("Appendix FM 2 asks for this.", []), 1);
    assert.equal(ruleCitationsIn("Under rule 4.2 you need funds.", []), 1);
    assert.equal(ruleCitationsIn("See paragraph 9.8.1.", []), 1);
    // The keyword is read in any case.
    assert.equal(ruleCitationsIn("RULE 4.2 applies.", []), 1);
    assert.equal(ruleCitationsIn("Rule 4.2 applies.", []), 1);
    // A bare whole number after the keyword is not a ref.
    assert.equal(ruleCitationsIn("Section 3 shows it.", []), 0);
    assert.equal(ruleCitationsIn("Paragraph 2 shows it.", []), 0);
  });

  test("a dotted generic ref followed by a unit word does not count", () => {
    assert.equal(ruleCitationsIn("section 2.3 times", []), 0);
    // And it cannot backtrack to a shorter ref ("9.8" of "9.8.1 years").
    assert.equal(ruleCitationsIn("paragraph 9.8.1 years", []), 0);
  });

  test("a verbatim quote of a rubric rule counts; named AND quoted counts once (unchanged)", () => {
    assert.equal(ruleCitationsIn("The guidance says “visitors must not work”.", PROBE_RULES), 1);
    assert.equal(ruleCitationsIn("Rule V 4.2 says “visitors must leave at the end”.", PROBE_RULES), 1);
  });

  test("#384 probe: listing three rules in one paragraph counts 3 and is dropped; the rest is kept", () => {
    const listing = "Rule V 4.2 says “visitors must leave at the end”. Rule V 4.3 says “visitors must have funds”. Rule V 4.4 says “visitors must not work”.";
    const grounding = narrativeGroundingOf(input());
    assert.equal(ruleCitationsIn(listing, grounding.rules), 3);
    const kept = "You say you are visiting your brother.";
    const p = parseNarrative(answer([listing, kept]), "weak", grounding);
    assert.ok(p.narrative);
    assert.deepEqual(p.narrative.paragraphs, [kept]);
    assert.equal(p.narrative.conclusion, `${NARRATIVE_CONCLUSION_LEADS.weak} you will leave at the end of your visit.`);
    assert.equal(p.dropped, 1);
  });

  test("the caps are unchanged", () => {
    assert.deepEqual(NARRATIVE_CITATION_LIMITS, { perString: 1, perNarrative: 2 });
    // A conclusion over the per-string cap makes the narrative null.
    const p = parseNarrative(answer(["You say you are visiting your brother."], `${NARRATIVE_CONCLUSION_LEADS.weak} you meet V 4.2 and V 4.3.`), "weak", narrativeGroundingOf(input()));
    assert.equal(p.narrative, null);
    assert.equal(p.reason, "the conclusion was dropped");
  });
});

// ============================================
// Figures: correct money no longer dropped
// ============================================

describe("#408 figures: correct money is no longer dropped", () => {
  test("declared currency: the one currency of every intake amount answer, nested included", () => {
    assert.equal(declaredCurrencyOf(NAIRA_INTAKE), "NGN");
    assert.equal(declaredCurrencyOf(JSON.stringify({ a: { b: [{ amount: 1, currency: "ngn" }] }, c: { amount: 2, currency: "NGN" } })), "NGN");
    assert.equal(declaredCurrencyOf(JSON.stringify({ stayDays: 15 })), null, "no amount answers");
    assert.equal(declaredCurrencyOf(JSON.stringify({ a: { amount: 1, currency: "NGN" }, b: { amount: 2, currency: "GBP" } })), null, "two currencies");
    assert.equal(declaredCurrencyOf("not json"), null);
  });

  test("a unitless money value takes the declared currency (NGN): ₦, NGN and bare are all kept", () => {
    const sources = sourcesFor(NAIRA_INTAKE, facts([{ field: "closingBalance", value: 1500000, unit: null, page: 1 }]));
    assert.equal(figuresAreGrounded("You hold ₦1,500,000.", sources), true);
    assert.equal(figuresAreGrounded("You hold 1,500,000 NGN.", sources), true);
    assert.equal(figuresAreGrounded("You hold 1,500,000.", sources), true);
  });

  test("a lowercase unit is read case-insensitively, and a sign as unit reads as its code", () => {
    for (const unit of ["gbp", "GBP", "Gbp", "£"]) {
      const sources = sourcesFor(NAIRA_INTAKE, facts([{ field: "closingBalance", value: 1500000, unit, page: null }]));
      assert.equal(figuresAreGrounded("You hold £1,500,000.", sources), true, `unit ${unit}`);
    }
    assert.equal(currencyOfUnit("gbp"), "GBP");
    assert.equal(currencyOfUnit(" £ "), "GBP");
    assert.equal(currencyOfUnit("months"), null);
    assert.equal(currencyOfUnit(null), null);
  });

  test("a lowercase currency in an intake answer is read as that currency", () => {
    const intake = JSON.stringify({ monthlyIncome: { amount: 1500, currency: "gbp" } });
    assert.equal(labelIntakeAmounts(intake), "monthlyIncome: 1500 GBP");
    assert.equal(declaredCurrencyOf(intake), "GBP");
    assert.equal(figuresAreGrounded("You earn £1,500 a month.", narrativeGroundingOf(input({ intakeSummary: intake })).figureSources), true);
  });

  test("money fields are the document fields an objective check reads with a currency unit", () => {
    const criteria: any[] = [
      { kind: "objective", check: { field: "closingBalance", op: "gte", value: 1000, unit: "gbp" } },
      { kind: "objective", check: { field: "funds.balance", op: "gte", value: 1000, unit: "£" } },
      { kind: "objective", check: { field: "employment.months", op: "gte", value: 6, unit: "months" } },
      { kind: "objective", check: { field: "intake.savings", op: "gte", value: 1, unit: "GBP" } },
      { kind: "objective", check: { field: "funds.holderIsApplicant", op: "eq", value: true, unit: "GBP" } },
      { kind: "judged", check: { field: "other", op: "gte", value: 1, unit: "GBP" } },
    ];
    assert.deepEqual(moneyFieldsFor({ criteria }), ["closingBalance", "funds.balance"]);
  });
});

// ============================================
// Figures: wrong currency still dropped (#384 probes)
// ============================================

describe("#408 figures: wrong currency and invented figures are still dropped", () => {
  test("#384 probe: '£399,367' against a naira intake is dropped", () => {
    const sources = narrativeGroundingOf(input({ intakeSummary: JSON.stringify({ monthlyIncome: { amount: 399367, currency: "NGN" } }) })).figureSources;
    assert.equal(figuresAreGrounded("You earn £399,367 a month.", sources), false);
  });

  test("a lowercase code in the narrative is read as that currency: '399,367 gbp' against naira is dropped", () => {
    const sources = narrativeGroundingOf(input({ intakeSummary: JSON.stringify({ monthlyIncome: { amount: 399367, currency: "NGN" } }) })).figureSources;
    assert.equal(figuresAreGrounded("You earn 399,367 gbp a month.", sources), false);
  });

  test("declared NGN, unitless 1500000: '£1,500,000' is dropped (read as naira, not any currency)", () => {
    const sources = sourcesFor(NAIRA_INTAKE, facts([{ field: "closingBalance", value: 1500000, unit: null, page: null }]));
    assert.equal(figuresAreGrounded("You hold £1,500,000.", sources), false);
  });

  test("closingBalance 1500 in 'gbp': '₦1,500' is dropped", () => {
    const sources = sourcesFor(NAIRA_INTAKE, facts([{ field: "closingBalance", value: 1500, unit: "gbp", page: null }]));
    assert.equal(figuresAreGrounded("You hold ₦1,500.", sources), false);
  });

  test("no declared currency (no amounts, or two currencies): a unitless value stays bare", () => {
    const value = facts([{ field: "closingBalance", value: 1500000, unit: null, page: null }]);
    for (const intake of [JSON.stringify({ stayDays: 15 }), JSON.stringify({ a: { amount: 1, currency: "NGN" }, b: { amount: 2, currency: "GBP" } })]) {
      const sources = sourcesFor(intake, value);
      assert.equal(figuresAreGrounded("You hold ₦1,500,000.", sources), false, intake);
      assert.equal(figuresAreGrounded("You hold 1,500,000.", sources), true, intake);
    }
  });

  test("a unitless value on a field that is not money does not take the declared currency", () => {
    const sources = sourcesFor(NAIRA_INTAKE, facts([{ field: "employment.months", value: 6, unit: null, page: null }]));
    assert.equal(figuresAreGrounded("You have ₦6.", sources), false);
    assert.equal(figuresAreGrounded("You have worked 6 months.", sources), true);
    // Same with the check's own unit written on the value.
    const withUnit = sourcesFor(NAIRA_INTAKE, facts([{ field: "employment.months", value: 6, unit: "months", page: null }]));
    assert.equal(figuresAreGrounded("You have ₦6.", withUnit), false);
    assert.equal(figuresAreGrounded("You have worked 6 months.", withUnit), true);
  });

  test("#384 probe: an invented figure is dropped", () => {
    const sources = sourcesFor(NAIRA_INTAKE, facts([{ field: "closingBalance", value: 1500000, unit: null, page: null }]));
    assert.equal(figuresAreGrounded("You have £5,000 saved.", sources), false);
  });
});

// ============================================
// Quotes (#384 probes still dropped)
// ============================================

describe("#408 quotes: the #384 probes are still dropped", () => {
  const grounding = narrativeGroundingOf(input());
  test("an invented ‘…’ quote is dropped", () => {
    assert.equal(quotationsAreGrounded("The rule says ‘you must leave the UK’.", grounding.quoteSources), false);
  });
  test("an invented mixed pair is dropped; a verbatim rubric quote is kept; an apostrophe stays inside one quotation", () => {
    assert.equal(quotationsAreGrounded("The rule says “you must leave the UK\".", grounding.quoteSources), false);
    assert.equal(quotationsAreGrounded("The guidance says “visitors must have funds”.", grounding.quoteSources), true);
    // ‘you don’t qualify’ is ONE quotation (and invented, so dropped as a whole).
    assert.equal(quotationsAreGrounded("It says ‘you don’t qualify’.", grounding.quoteSources), false);
    assert.equal(quotationsAreGrounded("It says ‘visitors must not work’.", grounding.quoteSources), true);
  });
});

// ============================================
// End to end through parseNarrative
// ============================================

describe("#408 end to end through parseNarrative", () => {
  /**
   * Grounding: naira intake, one unitless money value, one duration value. The
   * statement holds the small numbers the everyday sentences use (2025, 2, 3,
   * 28), so the FIGURE check grounds them and only the citation count is
   * under test for those sentences.
   */
  const grounding: NarrativeGrounding = narrativeGroundingOf(
    input({
      statementText: "Written in 2025. Page 2 explains the gap; page 3 of the letter shows the balance. I stayed 28 days.",
      figureFacts: facts([
        { field: "closingBalance", value: 1500000, unit: null, page: 1 },
        { field: "employment.months", value: 6, unit: "months", page: null },
      ]),
    })
  );

  /** Every sentence the criteria say must be kept, plus ONE real rubric citation. */
  const keptSentences = [
    "The rules in 2025 changed how this works.",
    "Paragraph 2 of your statement explains the gap.",
    "Section 3 of your bank letter shows the balance.",
    "You meet the rule of 28 days.",
    "You hold ₦1,500,000. That is 1,500,000 NGN, or 1,500,000.",
    "You have worked 6 months. Rule V 4.2 is met.",
  ];

  test("the 'should be kept' sentences return a narrative with dropped 0", () => {
    const p = parseNarrative(answer(keptSentences), "weak", grounding);
    assert.ok(p.narrative, p.reason ?? "");
    assert.deepEqual(p.narrative.paragraphs, keptSentences);
    assert.equal(p.dropped, 0);
    assert.equal(p.reason, null);
  });

  test("the 'should be dropped' probes are dropped, with the same count and reason as each check alone", () => {
    const probes = [
      "Rule V 4.2 says “visitors must leave at the end”. Rule V 4.3 says “visitors must have funds”. Rule V 4.4 says “visitors must not work”.",
      "You hold £1,500,000.",
      "You earn 1,500,000 gbp.",
      "You have ₦6.",
      "You have £5,000 saved.",
      "The rule says ‘you must leave the UK’.",
      "The rule says “you must leave the UK\".",
    ];
    // Each probe on its own (next to one plain paragraph): dropped once, narrative kept.
    for (const probe of probes) {
      const alone = parseNarrative(answer([probe, "You say you are visiting your brother."]), "weak", grounding);
      assert.equal(alone.dropped, 1, probe);
      assert.equal(alone.reason, null, probe);
      assert.deepEqual(alone.narrative?.paragraphs, ["You say you are visiting your brother."], probe);
    }
    // All of them at once: every one dropped. Six fit the paragraph cap, so split across two runs.
    const first = parseNarrative(answer(probes.slice(0, 6)), "weak", grounding);
    assert.equal(first.dropped, 6);
    assert.equal(first.narrative, null);
    assert.equal(first.reason, "every paragraph was dropped");
    const second = parseNarrative(answer(probes.slice(6)), "weak", grounding);
    assert.equal(second.dropped, 1);
    assert.equal(second.reason, "every paragraph was dropped");
  });
});

// ============================================
// What models are sent is unchanged
// ============================================

describe("#408 the narrative request is unchanged by the figure facts", () => {
  test("buildNarrativeRequest gives byte-for-byte the same request with or without figureFacts", () => {
    const without = buildNarrativeRequest(input());
    const withFacts = buildNarrativeRequest(input({ figureFacts: facts([{ field: "closingBalance", value: 1500000, unit: null, page: 1 }]) }));
    assert.equal(withFacts.user, without.user);
    assert.equal(withFacts.system, without.system);
    assert.deepEqual(withFacts, without);
  });

  test("the quote sources still hold the extraction summary exactly as sent", () => {
    const g = narrativeGroundingOf(input({ figureFacts: facts([{ field: "closingBalance", value: 1500000, unit: null, page: null }]) }));
    assert.ok(g.quoteSources.includes("closingBalance: 1500000"));
    assert.ok(g.figureSources.includes("closingBalance: 1500000 NGN"));
  });
});
