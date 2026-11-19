// ============================================
// Drafting instructions that stop the defects the second check found (issue #243)
// ============================================
//
// No network, no model: the scripted provider (checker-fakes.ts) answers the one re-draft
// request and the check's requests. Proved here:
//   - the criteria prompt holds each new instruction, the old conflicting wording is gone,
//     nothing in it asks for fewer rules, it still lacks the word "intake", and it names no
//     country, route or publisher (the repo-wide genericness test also scans the file);
//   - the prompt versions moved (the hash pins are in rubric-review-probes.test.ts);
//   - the kind wording is ONE shared constant, used by the drafting prompt;
//   - the re-draft request carries the new instructions, and says the right thing about the
//     quote for a bar and for an ordinary rule;
//   - `repair-saved-rule`: offline by default (0 calls, ids and letters only), and the live path
//     re-drafts an ordinary rule, refuses a bar made from it, reports the same-line fact, and
//     checks the replacements in batches.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  RUBRIC_INTAKE_SYSTEM_PROMPT,
  RUBRIC_PROMPT_VERSION,
  RUBRIC_REPAIR_PROMPT_VERSION,
  RUBRIC_SYSTEM_PROMPT,
  buildRepairRequest,
} from "../../../src/scrapers/rubric/rubric-prompt";
import { KIND_JUDGEMENT, KIND_MANDATORY_BAR, KIND_OBJECTIVE, KIND_WORDING_SENTENCE } from "../../../src/scrapers/rubric/rubric-kind-wording";
import { CHECKER_SYSTEM_PROMPT } from "../../../src/scrapers/rubric/rubric-checker-prompt";
import { runRepairs, aspectsToRepair, type SavedRuleInput } from "../../../src/scrapers/rubric/scripts/repair-saved-rule";
import { answer, crit, criteriaWire } from "./rubric-harness";
import { ScriptedProvider, SRC_HASH, SRC_ID, isRepairRequest } from "./checker-fakes";

/* eslint-disable @typescript-eslint/no-explicit-any */

describe("the criteria prompt holds the new instructions (#243)", () => {
  const p = RUBRIC_SYSTEM_PROMPT;

  test("titles keep every exception, the quote's modal strength, and add no intent words", () => {
    assert.match(p, /Titles\. A title states what the quote states, neither wider nor narrower/);
    for (const w of ["unless", "except", "other than", "provided that"]) assert.ok(p.includes(`"${w}"`), `names "${w}"`);
    assert.match(p, /ends with "unless an exception applies"/);
    assert.match(p, /"should" stays "should" \(never "must"\)/);
    assert.match(p, /adds no word about intent, belief or continuation/);
  });

  test("a definition or a set of alternatives is ONE rule quoting its lead-in; sub-conditions keep one rule per item", () => {
    assert.match(p, /Definitions and alternatives/);
    assert.match(p, /Draft ONE criterion whose `quote` is the lead-in sentence only, and do NOT draft one criterion per item/);
    assert.match(p, /could arise in the following circumstances/);
    assert.match(p, /either \(a\) or \(b\)/);
    assert.match(p, /sub-conditions that must EACH be met \(previous rule\), which keep one criterion per item/);
    // The lead-in path allows the definition's lead-in as a quote.
    assert.match(p, /the definition or set of alternatives the list spells out/);
  });

  test("one condition rule: the item's own lead-in, never a sibling; specialist names the activity (heading when only it does)", () => {
    assert.match(p, /Conditions\. `applicabilityCondition` is the circumstance in which THIS rule applies/);
    assert.match(p, /takes its own lead-in sentence.*Never the text of a sibling item/);
    assert.match(p, /For a `specialist` rule the condition must name the activity or sub-category/);
    assert.match(p, /only the heading of the section does, the condition is that heading/);
    // The two old, conflicting instructions are gone.
    assert.ok(!p.includes("If the circumstance is stated in a lead-in sentence above a list, copy that sentence."));
    assert.ok(!p.includes("Carry the paragraph's triggering circumstance (its lead-in sentence) onto each of them"));
    assert.ok(!p.includes("When the items of a list are alternatives or separate rules, extract each one separately in the same way."));
    assert.ok(!p.includes("Give `applicabilityCondition` the same way: the words of the excerpt (a heading, a lead-in sentence or the rule itself)"));
  });

  test("an exemption makes a rule conditional, and a condition is a circumstance, never an outcome", () => {
    assert.match(p, /exempts a group, route or category of applicant .* is `conditional`, never `all_applicants`/);
    assert.match(p, /The condition is the CIRCUMSTANCE, never the outcome/);
  });

  test("examples, summaries and link labels are not rules, without dropping any statement that is one", () => {
    assert.match(p, /Not rules\. An example \("An example would be \.\.\."\)/);
    assert.match(p, /link label or topic name in a checklist/);
    assert.match(p, /Every line that does state one is still drafted, including an instruction to the decision maker/);
  });

  test("nothing asks the model to drop, cap or reduce rules", () => {
    assert.ok(!/\b(fewer|at most|no more than|only the most|skip rules|drop rules|cap the number|limit the number|as few)\b/i.test(p));
    assert.ok(!/\b(fewer|at most|no more than|only the most|as few)\b/i.test(KIND_WORDING_SENTENCE));
  });

  test("the criteria prompt still lacks the word 'intake' (a test detects the intake call by it)", () => {
    assert.ok(!/intake/i.test(p));
    assert.ok(RUBRIC_INTAKE_SYSTEM_PROMPT.includes("intake"));
  });

  test("no country, route name, nationality or publisher in the new wording", () => {
    for (const w of ["United Kingdom", "UK", "Home Office", "gov.uk", "Appendix", "Visitor", "Transit", "Schengen", "British", "Nigeria"]) {
      assert.ok(!new RegExp(`\\b${w}\\b`).test(p), `names ${w}`);
    }
  });
});

describe("versions moved, and the kind wording is shared (#243)", () => {
  test("versions", () => {
    // (#234) moved on again: v11 (groups decided from what the applicant holds) and repair v5.
    // (#235) v12: the intake call drafts competence steps; the re-draft is unchanged (v5).
    assert.equal(RUBRIC_PROMPT_VERSION, "2026-11-rubric-v12");
    assert.equal(RUBRIC_REPAIR_PROMPT_VERSION, "2026-11-repair-v5");
  });

  test("ONE kind wording (rubric-kind-wording.ts): the drafting prompt and the check's prompt carry the same sentence word for word", () => {
    assert.ok(RUBRIC_SYSTEM_PROMPT.includes(KIND_WORDING_SENTENCE));
    assert.ok(CHECKER_SYSTEM_PROMPT.includes(KIND_WORDING_SENTENCE));
    for (const k of [KIND_OBJECTIVE, KIND_MANDATORY_BAR, KIND_JUDGEMENT]) {
      assert.ok(RUBRIC_SYSTEM_PROMPT.includes(k));
      assert.ok(CHECKER_SYSTEM_PROMPT.includes(k));
    }
    for (const w of ["a requirement the applicant must show", "a permitted activity", "a definition", "a method of calculation", "an instruction to the decision maker"]) {
      assert.ok(KIND_JUDGEMENT.includes(w), w);
    }
  });
});

describe("the re-draft request carries the new instructions (#243)", () => {
  const chunk = { sourceId: SRC_ID, contentHash: SRC_HASH, docType: "html", chunkIndex: 0, chunkCount: 1, text: "An excerpt." } as any;
  const limits = { maxOutputTokens: 1000, timeoutMs: 1000 };
  const build = (rule: any) => buildRepairRequest(chunk, { rule, aspects: ["title_faithful"] }, ["high"], limits);

  test("the system prompt is the drafting prompt, so the instructions ride along", () => {
    const req = build({ title: "T", kind: "judgement", stage: "eligibility", quote: "q" });
    assert.equal(req.system, RUBRIC_SYSTEM_PROMPT);
    assert.match(req.system, /Definitions and alternatives/);
  });

  test("a bar must quote its own line; an ordinary rule may come back as its definition's lead-in and never as a bar", () => {
    const bar = build({ title: "T", kind: "mandatory_bar", stage: "validity", quote: "q" });
    assert.match(bar.user, /taken from the same line of the excerpt/);
    assert.match(bar.user, /discarded by code/);
    const ordinary = build({ title: "T", kind: "judgement", stage: "eligibility", quote: "q" });
    assert.match(ordinary.user, /draft ONE rule from the lead-in sentence of the list instead/);
    assert.match(ordinary.user, /must not be a mandatory bar/);
    assert.ok(!/discarded by code/.test(ordinary.user));
    // The shared sentences are still there.
    for (const r of [bar, ordinary]) assert.match(r.user, /Keep the rule's kind/);
  });
});

// ---------- repair-saved-rule ----------

/** A page with a definition (lead-in + two items), a sentence with an exception, and filler. */
const DEF_LEAD = "A Gadget Holder means a person who is one or more of the following:";
const PAGE_LINES = [
  "Section 1 Gadgets",
  DEF_LEAD,
  "a. currently holds a gadget licence; or",
  "b. held a gadget licence within the previous 4 years.",
  "The applicant must pay the fee unless the fee has been waived by the decision maker.",
  "A national of Borduria must be refused entry unless they hold a special permit.",
];
const page: any = { schemaVersion: 1, sourceId: SRC_ID, contentHash: SRC_HASH, docType: "html", url: "https://rules.example/page", finalUrl: "https://rules.example/page", fetchedAt: "2026-11-13T00:00:00Z", text: PAGE_LINES.join("\n"), pages: null };

const GROUP_QUOTE = "A national of Borduria must be refused entry unless they hold a special permit.";
const FEE_QUOTE = "The applicant must pay the fee unless the fee has been waived by the decision maker.";
const ITEM_B = "b. held a gadget licence within the previous 4 years.";
const input = (id: string, quote: string, over: Partial<SavedRuleInput> = {}): SavedRuleInput => ({ criterionId: id, title: "SECRET TITLE", kind: "judgement", stage: "eligibility", severity: "high", quote, applicability: "all_applicants", verdicts: "nyyyaa", ...over });

describe("repair-saved-rule (#243)", () => {
  test("offline by default: 0 model calls, and the output holds ids, letters and code words only", async () => {
    const lines: string[] = [];
    const provider = new ScriptedProvider();
    const summary = await runRepairs(page, [input("rule-a", FEE_QUOTE), input("rule-b", ITEM_B, { verdicts: "ynyyaa" }), input("rule-c", "A sentence that is nowhere in the page at all.")], { live: false, provider, print: (l) => lines.push(l) });
    assert.equal(provider.requests.length, 0);
    assert.deepEqual({ rules: summary.rules, quoteNotFound: summary.quoteNotFound }, { rules: 3, quoteNotFound: 1 });
    const out = lines.join("\n");
    assert.match(out, /rule-a: quote found; ordinary, kind judgement; old letters nyyyaa; aspects a re-draft would be told: title_faithful;/);
    assert.match(out, /rule-b: quote found;.*aspects a re-draft would be told: kind_right;/);
    assert.match(out, /rule-c: quote NOT found/);
    assert.match(out, /offline: 0 model calls\. --live would make 2 re-draft request\(s\)/);
    // Redaction: no title, no quote text, no source text.
    for (const secret of ["SECRET TITLE", "applicant must pay", "gadget licence", "Gadget Holder", "nowhere in the page"]) assert.ok(!out.includes(secret), `leaked ${secret}`);
  });

  test("the aspects come from the stored letters through the production mapping; no letters = all six", async () => {
    const rule: any = { kind: "judgement", applicability: "all_applicants" };
    // A tolerated label (stage of a judgement rule, kind `unsure` on an ordinary one) is not asked for.
    assert.deepEqual(await aspectsToRepair(rule, "yuuyaa"), []);
    assert.deepEqual(await aspectsToRepair(rule, "nnyyaa"), ["title_faithful", "kind_right"]);
    assert.equal((await aspectsToRepair(rule, undefined)).length, 6);
    assert.equal((await aspectsToRepair(rule, "garbage")).length, 6);
  });

  test("live: a title re-draft passes; a definition item comes back as the lead-in (different line); a bar is refused; requests are counted", async () => {
    const provider = new ScriptedProvider();
    provider.redraftPolicy = ({ shown }: { shown: Record<string, any> }) => {
      // The fee rule: same line, title now keeps the exception.
      if (shown.quote === FEE_QUOTE) return JSON.parse(criteriaWire(answer({ criteria: [crit({ ref: "r1", title: "Fee must be paid unless it has been waived", kind: "judgement", quote: FEE_QUOTE, probeFactors: ["whether the fee was waived"] })] })));
      // The definition item: ONE rule quoting the lead-in (the list lines are attached by the program).
      if (shown.quote === ITEM_B) return JSON.parse(criteriaWire(answer({ criteria: [crit({ ref: "r1", title: "Gadget Holder definition", kind: "judgement", quote: DEF_LEAD, probeFactors: ["which alternative applies"] })] })));
      // The third rule: the model tries to turn an ordinary rule into a bar.
      return JSON.parse(criteriaWire(answer({ criteria: [crit({ ref: "r1", title: "A bar", kind: "mandatory_bar", stage: "validity", severity: "critical", quote: GROUP_QUOTE, appliesTo: { nationalities: ["QM"], asWritten: ["Borduria"] } })] })));
    };
    // The check says the fee replacement is fine, the definition one still has a wrong condition.
    provider.policy = ({ rule }) => (String(rule.quote).startsWith("A Gadget Holder") ? { condition_faithful: "no" as const } : undefined);
    const lines: string[] = [];
    const summary = await runRepairs(page, [input("rule-a", FEE_QUOTE), input("rule-b", ITEM_B, { verdicts: "ynyyaa" }), input("rule-c", GROUP_QUOTE)], { live: true, provider, print: (l) => lines.push(l) });
    const out = lines.join("\n");
    assert.equal(summary.redrafted, 2);
    assert.equal(summary.refused, 1);
    assert.equal(summary.passed, 1);
    assert.match(out, /rule-a: old nyyyaa; new yyyyaa; same line yes; becomes a bar no; passes every aspect yes\./);
    assert.match(out, /rule-b: old ynyyaa; new [a-z]{6}; same line no; becomes a bar no; passes every aspect no \(condition_faithful\)\./);
    assert.match(out, /rule-c: old nyyyaa; re-draft refused:became_a_bar/);
    // 3 re-drafts + 1 check batch (2 replacements, one verification model for ordinary rules).
    assert.equal(provider.requests.filter(isRepairRequest).length, 3);
    assert.equal(summary.requests, 4);
    assert.match(out, /4 request\(s\) made\./);
    for (const secret of ["SECRET TITLE", "applicant must pay", "Fee must be paid", "Gadget Holder"]) assert.ok(!out.includes(secret), `leaked ${secret}`);
  });
});
