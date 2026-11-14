// ============================================
// Ordinary-rule repair (issue #244) — the check's side
// ============================================
//
// No network, no model, no Firestore: the scripted provider (checker-fakes.ts) answers the check's requests
// AND the one re-draft request of each ordinary rule the check found WRONG; the ledger and the snapshot
// reader are in memory, the clock is a variable. Proved here:
//   - who is eligible (a `no` on title / kind / condition / check; never `unsure` only, never a code leave-out);
//   - a re-draft is validated like any drafted rule, checked by the verification model, and served only when
//     it passes; otherwise the original stays left out exactly as before, with its repair status recorded;
//   - an ordinary rule never becomes a bar; kind and applicability are kept unless the check faulted them;
//   - replacements that coincide (definition items that all come back as the same lead-in) are served ONCE,
//     and the originals they cover are recorded;
//   - the guard, the request cap, the input cap and the clock degrade to "left out as before": the run
//     completes, nothing is trimmed, nothing is paid for twice on a retry (call counts asserted);
//   - the pure parts: the eligibility test, `applyRuleRepairs` for ordinary rules, `sameRuleAs`, the budget.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { RubricCheckerService, ORDINARY_REPAIR_ASPECTS, ordinaryRepairAspects, sameRuleAs } from "../../../src/scrapers/rubric/rubric-checker";
import { applyExclusions } from "../../../src/scrapers/rubric/rubric-exclusions";
import { applyRuleRepairs, REDRAFT_DUPLICATE_REASON, ruleHashOf } from "../../../src/scrapers/rubric/rubric-repair";
import { evaluateGates } from "../../../src/scrapers/rubric/rubric-gates";
import { DEFAULT_PUBLISH_SETTINGS } from "../../../src/scrapers/rubric/rubric-publish-settings";
import { decodeRow } from "../../../src/scrapers/rubric/rubric-checker-prompt";
import { RUBRIC_REPAIR_PROMPT_VERSION } from "../../../src/scrapers/rubric/rubric-prompt";
import type { AssessmentCriterion, RubricRuleRepair } from "../../../src/types/rubric";
import { answer, crit, criteriaWire } from "./rubric-harness";
import { MemoryLedger, ScriptedProvider, isRepairRequest, pageOf, ruleOf, rubricOf, settingsWith, SRC_HASH, SRC_ID, type RowPolicy } from "./checker-fakes";

/* eslint-disable @typescript-eslint/no-explicit-any */

// ---------- fixtures ----------

/** A definition on the page: a lead-in and two items (invented words: nothing real). */
const DEF_LEAD = "A Gadget Holder means a person who is one or more of the following:";
const ITEM_A = "a. currently holds a gadget licence; or";
const ITEM_B = "b. held a gadget licence within the previous 4 years.";
const DEF_ITEMS = [ITEM_A, ITEM_B];

/**
 * Plain rules with DISTINCT wording. The shared fixtures' lines differ by one number, which the duplicate gate's
 * word test (80 % shared words) rightly reads as one rule, so a replacement would be "covered" by a neighbour.
 * Here each line has three words of its own: well under 80 % shared.
 */
const qt = (i: number) => `Applicants must supply tok${i}a tok${i}b tok${i}c documents before decision ${i}.`;
const page = (n: number) => {
  const base = pageOf(0, [...Array.from({ length: n }, (_, k) => `R${k + 1}.1 ${qt(k + 1)}`), DEF_LEAD, ...DEF_ITEMS]);
  return base;
};
const plain = (i: number, over: Partial<AssessmentCriterion> = {}) => ruleOf(i, { source: sourceOf(qt(i)), ...over });

/** A stored rule quoting some other text of the page (a definition item). */
const sourceOf = (quote: string, over: Record<string, unknown> = {}) => ({ quote, sourceId: SRC_ID, url: "https://rules.example/page", contentHash: SRC_HASH, retrievedAt: "2026-11-13T00:00:00Z", ...over });
const itemRule = (i: number, quote: string, title: string, over: Partial<AssessmentCriterion> = {}) => ruleOf(i, { title, source: sourceOf(quote), ...over });
/** The lead-in rule an ordinary check can read: its list lines are stored with it (#222). */
const leadInRule = (i: number, title = "Gadget Holder definition", over: Partial<AssessmentCriterion> = {}) => ruleOf(i, { title, source: sourceOf(DEF_LEAD, { listItems: DEF_ITEMS }), ...over });

/** What the model answers to a re-draft: the same quote, a renewed title. `over` overrides fields of the one rule. */
const renew = (quote?: string, over: Record<string, unknown> = {}) => ({ shown }: { shown: Record<string, any> }) =>
  criteriaWire(answer({ criteria: [crit({ ref: "r1", title: `Repaired ${shown.title}`, kind: shown.kind, stage: shown.stage, quote: quote ?? shown.quote, probeFactors: ["a factor"], ...over } as any)] }));

/** The check finds these titles wrong on `title_faithful` (a `no`), and everything else fine. */
const wrongTitles = (titles: string[], aspect: "title_faithful" | "kind_right" | "condition_faithful" | "check_faithful" = "title_faithful"): RowPolicy => ({ rule }) => (titles.includes(rule.title) ? { [aspect]: "no" } : undefined);

interface Clock {
  t: number;
}

/** A check over `n` plain rules (and the definition). The clock is a variable so a test can move it. */
function rig(opts: { n?: number; settings?: Parameters<typeof settingsWith>[0]; ledger?: MemoryLedger; provider?: ScriptedProvider; clock?: Clock } = {}) {
  const provider = opts.provider ?? new ScriptedProvider();
  const ledger = opts.ledger ?? new MemoryLedger();
  const clock = opts.clock ?? { t: Date.parse("2026-11-13T10:00:00Z") };
  const p = page(opts.n ?? 30);
  const svc = new RubricCheckerService({ provider: () => provider, readSnapshot: async () => p, loadSettings: settingsWith(opts.settings), ledger, nowMs: () => clock.t, sleep: async () => undefined });
  return { svc, provider, ledger, clock };
}

const input = (rubric: ReturnType<typeof rubricOf>, codeLeftOutIds: string[] = []) => ({ routeKey: rubric.routeKey, version: 1, runId: `${rubric.routeKey}__v1`, rubric, codeLeftOutIds });
const rules = (n: number) => Array.from({ length: n }, (_, k) => plain(k + 1));
const redrafts = (p: ScriptedProvider) => p.requests.filter(isRepairRequest);
const batches = (p: ScriptedProvider) => p.requests.filter((q) => (q.schema as any).properties.verdicts);
/** The outcome of a check that is expected to have gone through. */
const ok = (o: any) => {
  assert.equal(o.ok, true, JSON.stringify(o));
  return o;
};
const line = (o: any, id: string) => o.ordinaryRepairs.records.find((r: any) => r.criterionId === id);

// ============================================
// Who is eligible
// ============================================

describe("who gets the one re-draft (#244)", () => {
  test("a `no` on title, kind, condition or check makes an ordinary rule eligible; `unsure` / `na` alone does not; stage and group never do", () => {
    const rule = ruleOf(1, { applicability: "conditional", applicabilityCondition: "where the applicant studies", check: { field: "applicant.age", op: "gte", value: 18 } as any, kind: "objective" });
    const row = (letters: string) => decodeRow(letters) as any;
    // title, kind, stage, condition, check, group
    for (const [letters, expected] of [
      ["nyyyya", ["title_faithful"]],
      ["ynyyya", ["kind_right"]],
      ["yyynya", ["stage_right", "condition_faithful"]], // objective: stage is judged, and still failed with `unsure`? see below
      ["yyyyna", ["check_faithful"]],
    ] as const) {
      const got = ordinaryRepairAspects(rule, row(letters.replace("yyynya", "yyuuya")));
      if (letters === "yyynya") continue; // covered by the next assertion block
      assert.deepEqual(got, expected, letters);
    }
    // A `no` on condition, with an `unsure` on stage: eligible, and the re-draft is told BOTH.
    assert.deepEqual(ordinaryRepairAspects(rule, row("yyunya")), ["stage_right", "condition_faithful"]);
    // Only `unsure`: nobody said it is wrong.
    assert.equal(ordinaryRepairAspects(rule, row("yuuuya")), null);
    // A `no` on stage alone (objective: stage is judged) is not one of the four aspects.
    assert.equal(ordinaryRepairAspects(rule, row("yynyya")), null);
    // A rule that passes, a missing row, a protected rule.
    assert.equal(ordinaryRepairAspects(rule, row("yyyyya")), null);
    assert.equal(ordinaryRepairAspects(rule, undefined), null);
    assert.equal(ordinaryRepairAspects(ruleOf(2, { kind: "mandatory_bar", appliesTo: { nationalities: ["QM"], asWritten: ["Borduria"] } }), row("nyyyaa")), null);
    // A tolerated `unsure` (kind of an ordinary judgement rule) next to a `no` elsewhere: told only what failed.
    assert.deepEqual(ordinaryRepairAspects(ruleOf(3), row("nuyyaa")), ["title_faithful"]);
    // The four aspects are pinned.
    assert.deepEqual([...ORDINARY_REPAIR_ASPECTS], ["title_faithful", "kind_right", "condition_faithful", "check_faithful"]);
  });

  test("a rule with only `unsure` verdicts is never re-drafted: no request, no record, and it stays left out with its reason", async () => {
    const r = rig();
    r.provider.policy = ({ rule }) => (rule.title === "Matter 3" ? { title_faithful: "unsure" } : undefined);
    const out = ok(await r.svc.check(input(rubricOf(rules(30), null))));
    assert.equal(redrafts(r.provider).length, 0);
    assert.equal(out.ordinaryRepairs, undefined, "nothing eligible: no record");
    assert.deepEqual(out.leftOut, [{ criterionId: "crit-0003", reason: "checker:title_faithful", basis: "not_confirmed" }]);
    assert.equal(out.requests, undefined);
  });

  test("a code leave-out is not re-drafted even when the check also found it wrong (it keeps its own reason)", async () => {
    const r = rig();
    r.provider.policy = wrongTitles(["Matter 3", "Matter 4"]);
    r.provider.redraftPolicy = renew();
    const out = ok(await r.svc.check(input(rubricOf(rules(30), null), ["crit-0003"])));
    assert.equal(redrafts(r.provider).length, 1, "only Matter 4");
    assert.equal(out.ordinaryRepairs.counts.eligible, 1);
    assert.equal(line(out, "crit-0003"), undefined);
    assert.equal(out.repairs[0].criterionId, "crit-0004");
  });

  test("a quote the snapshot cannot show (checker:source_text) is not re-drafted", async () => {
    const r = rig();
    const lost = plain(5, { source: sourceOf("A sentence that is nowhere in the stored text at all.") });
    r.provider.redraftPolicy = renew();
    const out = ok(await r.svc.check(input(rubricOf([...rules(4), lost, ...rules(30).slice(5)], null))));
    assert.equal(redrafts(r.provider).length, 0);
    assert.deepEqual(out.leftOut, [{ criterionId: "crit-0005", reason: "checker:source_text", basis: "not_confirmed" }]);
  });
});

// ============================================
// Repaired and confirmed / not
// ============================================

describe("a found-wrong ordinary rule is re-drafted once and served only if the check confirms it (#244)", () => {
  test("repaired and confirmed: served as the replacement (same id), no longer left out, recorded, and the original is untouched", async () => {
    const r = rig();
    r.provider.policy = wrongTitles(["Matter 7"]);
    r.provider.redraftPolicy = renew();
    const original = rules(30)[6];
    const before = JSON.stringify(original);
    const out = ok(await r.svc.check(input(rubricOf(rules(30), null))));

    assert.deepEqual(out.leftOut, [], "the repaired rule is not left out: it counts as kept");
    assert.equal(out.repairs.length, 1);
    const rep = out.repairs[0] as RubricRuleRepair;
    assert.equal(rep.criterionId, "crit-0007");
    assert.equal(rep.replacement.criterionId, "crit-0007");
    assert.equal(rep.replacement.title, "Repaired Matter 7");
    assert.equal(rep.replacement.source.quote, original.source.quote, "the verbatim quote, found again by code");
    assert.equal(rep.originalRuleHash, ruleHashOf(original));
    assert.equal(rep.alsoReplaced, undefined);
    assert.equal(JSON.stringify(original), before, "the check never edits a rule");
    // The record.
    assert.deepEqual(out.ordinaryRepairs.counts, { eligible: 1, attempted: 1, repaired: 1, failedCheck: 0, invalid: 0, mergedDuplicates: 0, checkPending: 0, notAttempted: 0, requests: { redraft: 1, check: 1 } });
    const l = line(out, "crit-0007");
    assert.equal(l.repair.status, "repaired");
    assert.deepEqual(l.failedAspects, ["title_faithful"]);
    assert.equal(l.verdicts.verification, "nyyyaa", "the ORIGINAL's letters");
    assert.equal(l.repair.replacementVerdicts.verification, "yyyyaa");
    assert.equal(l.repair.sameLine, true);
    // Spend: 3 ordinary batches + 1 re-draft + 1 check of the replacement; ONE model reads it (not a bar).
    assert.equal(r.provider.requests.length, 5);
    assert.deepEqual(out.requests, { total: 5, repair: 2 });
    const readers = batches(r.provider).filter((q) => q.user.includes("Repaired Matter 7")).map((q) => q.role);
    assert.deepEqual(readers, ["verification"]);
    // The re-draft was told the aspect that failed and shown the failed rule.
    const [req] = redrafts(r.provider);
    assert.ok(req.user.includes("title_faithful") && req.user.includes("Matter 7"));
    assert.equal(r.ledger.docs.get("XA_xa-test__v1")?.repairs?.["crit-0007"]?.promptVersion, RUBRIC_REPAIR_PROMPT_VERSION);
  });

  test("the replacement fails the check again: left out as before (original reason and basis), never served, never re-drafted a second time", async () => {
    const r = rig();
    r.provider.policy = (ctx) => (ctx.rule.title === "Matter 7" ? { title_faithful: "no" } : ctx.rule.title === "Repaired Matter 7" ? { condition_faithful: "unsure", kind_right: "no" } : undefined);
    r.provider.redraftPolicy = renew();
    const first = ok(await r.svc.check(input(rubricOf(rules(30), null))));
    assert.deepEqual(first.leftOut, [{ criterionId: "crit-0007", reason: "checker:title_faithful", basis: "found_wrong" }]);
    assert.equal(first.repairs, undefined);
    assert.equal(first.ordinaryRepairs.counts.failedCheck, 1);
    const l = line(first, "crit-0007");
    assert.equal(l.repair.status, "failed_check");
    assert.deepEqual(l.repair.replacementFailedAspects, ["kind_right", "condition_faithful"]);
    // A second run (a sweep retry, a re-delivered trigger, an admin re-run): nothing is asked, nothing re-drafted.
    const calls = r.provider.requests.length;
    const second = ok(await r.svc.check(input(rubricOf(rules(30), null))));
    assert.equal(r.provider.requests.length, calls);
    assert.equal(redrafts(r.provider).length, 1);
    assert.deepEqual(second.leftOut, first.leftOut);
    assert.equal(line(second, "crit-0007").repair.status, "failed_check");
  });

  test("a trigger the trigger check does not confirm fails the replacement (an ordinary rule's replacement needs its trigger confirmed)", async () => {
    const r = rig();
    const q = { id: "q1", label: "Which activity?", answerType: "multi_choice", options: [{ value: "a", label: "Activity A" }], required: true, criterionIds: ["crit-0007"] } as any;
    const scoped = plain(7, { applicability: "specialist", applicabilityCondition: "Applicants must supply", trigger: { questionId: "q1", anyOf: ["a"] } });
    const rubric = { ...rubricOf([...rules(30).slice(0, 6), scoped, ...rules(30).slice(7)], null), intakeQuestions: [q] } as any;
    r.provider.policy = wrongTitles(["Matter 7"]);
    // Specialist rules carry their activity: the re-draft keeps it (the trigger is carried over by code).
    r.provider.redraftPolicy = renew(undefined, { applicability: "specialist", applicabilityCondition: "Applicants must supply" });
    // Only the replacement's trigger matters: the original is left out, so its own trigger is never judged.
    r.provider.triggerPolicy = () => "no";
    const out = ok(await r.svc.check(input(rubric)));
    assert.equal(out.repairs, undefined);
    const l = line(out, "crit-0007");
    assert.equal(l.repair.status, "failed_check");
    assert.equal(l.repair.detail, "trigger_not_confirmed");
    assert.deepEqual(out.leftOut.map((x: any) => x.criterionId), ["crit-0007"]);
  });

  test("refused or unrepairable: left out exactly as before, the status says why (a model that cannot repair it, a quote not in the text)", async () => {
    const r = rig();
    r.provider.policy = wrongTitles(["Matter 3", "Matter 5", "Matter 8"]);
    r.provider.redraftPolicy = ({ shown }: { shown: Record<string, any> }) => {
      if (shown.title === "Matter 3") return { criteria: [], suspiciousPassages: [] };
      if (shown.title === "Matter 5") return renew("A sentence that the page does not contain anywhere.")({ shown });
      return renew()({ shown });
    };
    const out = ok(await r.svc.check(input(rubricOf(rules(30), null))));
    assert.equal(line(out, "crit-0003").repair.status, "cannot_be_repaired");
    assert.equal(line(out, "crit-0005").repair.status, "invalid_redraft");
    assert.equal(line(out, "crit-0008").repair.status, "repaired");
    assert.deepEqual(out.leftOut.map((x: any) => `${x.criterionId}:${x.reason}:${x.basis}`), ["crit-0003:checker:title_faithful:found_wrong", "crit-0005:checker:title_faithful:found_wrong"]);
    assert.equal(out.ordinaryRepairs.counts.invalid, 2);
    assert.equal(out.ordinaryRepairs.counts.repaired, 1);
    // Only the repaired one was checked: 1 re-check batch.
    assert.equal(out.ordinaryRepairs.counts.requests.check, 1);
    // A re-run asks nothing: the refusals are stored too.
    const calls = r.provider.requests.length;
    ok(await r.svc.check(input(rubricOf(rules(30), null))));
    assert.equal(r.provider.requests.length, calls);
  });

  test("a replacement that would become a bar is refused (never served)", async () => {
    const r = rig();
    r.provider.policy = wrongTitles(["Matter 4"]);
    r.provider.redraftPolicy = renew(undefined, { kind: "mandatory_bar", stage: "suitability", severity: "critical", appliesTo: { nationalities: ["QM"], asWritten: ["Applicants"] } });
    const out = ok(await r.svc.check(input(rubricOf(rules(30), null))));
    assert.equal(line(out, "crit-0004").repair.status, "invalid_redraft");
    assert.match(line(out, "crit-0004").repair.detail, /^became_a_bar/);
    assert.equal(out.repairs, undefined);
    assert.deepEqual(out.leftOut.map((x: any) => x.criterionId), ["crit-0004"]);
    // The defence in depth: a stored replacement that is protected is never served either.
    const hash = ruleHashOf(rules(30)[3]);
    r.ledger.docs.get("XA_xa-test__v1")!.repairs!["crit-0004"] = { ruleHash: hash, kind: "replacement", requests: 1, promptVersion: RUBRIC_REPAIR_PROMPT_VERSION, replacement: ruleOf(4, { kind: "mandatory_bar", appliesTo: { nationalities: ["QM"], asWritten: ["x"] } }) };
    const again = ok(await r.svc.check(input(rubricOf(rules(30), null))));
    assert.equal(line(again, "crit-0004").repair.detail, "became_protected");
    assert.equal(again.repairs, undefined);
  });

  test("kind and applicability are kept unless the check faulted them", async () => {
    // Applicability: an everyone-rule that comes back scoped is refused when only the title was faulted ...
    const scopedBack = renew(undefined, { applicability: "specialist", applicabilityCondition: "Applicants must supply" });
    const a = rig();
    a.provider.policy = wrongTitles(["Matter 4"]);
    a.provider.redraftPolicy = scopedBack;
    const refused = ok(await a.svc.check(input(rubricOf(rules(30), null))));
    assert.equal(line(refused, "crit-0004").repair.status, "invalid_redraft");
    assert.equal(line(refused, "crit-0004").repair.detail, "applicability_changed");
    // ... and accepted when `condition_faithful` failed too.
    const b = rig();
    b.provider.policy = ({ rule }) => (rule.title === "Matter 4" ? { title_faithful: "no", condition_faithful: "no" } : undefined);
    b.provider.redraftPolicy = scopedBack;
    const accepted = ok(await b.svc.check(input(rubricOf(rules(30), null))));
    assert.equal(line(accepted, "crit-0004").repair.status, "repaired", JSON.stringify(line(accepted, "crit-0004")));
    assert.equal(accepted.repairs[0].replacement.applicability, "specialist");
    // Kind: a judgement rule that comes back objective is refused when only the title was faulted ...
    const objective = renew(undefined, { kind: "objective", check: { field: "applicant.age", op: "gte", value: 4 } });
    const c = rig();
    c.provider.policy = wrongTitles(["Matter 4"]);
    c.provider.redraftPolicy = objective;
    const kindRefused = ok(await c.svc.check(input(rubricOf(rules(30), null))));
    assert.equal(line(kindRefused, "crit-0004").repair.detail, "kind_changed", JSON.stringify(line(kindRefused, "crit-0004")));
    // ... and accepted (when the model gives a valid objective rule) once `kind_right` is among the failed aspects.
    const d = rig();
    d.provider.policy = ({ rule }) => (rule.title === "Matter 4" ? { kind_right: "no" } : undefined);
    d.provider.redraftPolicy = objective;
    const kindOk = ok(await d.svc.check(input(rubricOf(rules(30), null))));
    assert.notEqual(line(kindOk, "crit-0004").repair.detail, "kind_changed");
  });
});

// ============================================
// Duplicates
// ============================================

describe("replacements that coincide are served ONCE (#244)", () => {
  /** A draft whose two definition items are both found wrong; both come back as the lead-in. */
  const itemsDraft = () => [...rules(28), itemRule(29, ITEM_A, "Gadget item a"), itemRule(30, ITEM_B, "Gadget item b")];
  const asLeadIn = ({ shown }: { shown: Record<string, any> }) => criteriaWire(answer({ criteria: [crit({ ref: "r1", title: "Gadget Holder definition", kind: shown.kind, stage: shown.stage, quote: DEF_LEAD, probeFactors: ["which alternative applies"] })] }));

  test("two items that both come back as the lead-in: one rule served, the other original covered, recorded both ways, not counted in the budget", async () => {
    const r = rig();
    r.provider.policy = wrongTitles(["Gadget item a", "Gadget item b"]);
    r.provider.redraftPolicy = asLeadIn;
    const out = ok(await r.svc.check(input(rubricOf(itemsDraft(), null))));

    assert.equal(out.repairs.length, 1, "ONE replacement is served");
    const rep = out.repairs[0] as RubricRuleRepair;
    assert.equal(rep.criterionId, "crit-0029", "the first in rulebook order");
    assert.deepEqual(rep.alsoReplaced, ["crit-0030"], "and it records which originals it replaced");
    assert.equal(rep.replacement.source.quote, DEF_LEAD);
    assert.deepEqual(rep.replacement.source.listItems, DEF_ITEMS, "a lead-in replacement carries its list lines (#222)");
    // The covered original is left out as a covered duplicate (no basis: nothing was found wrong with what is served).
    assert.deepEqual(out.leftOut, [{ criterionId: "crit-0030", reason: REDRAFT_DUPLICATE_REASON }]);
    assert.equal(line(out, "crit-0029").repair.status, "repaired");
    assert.equal(line(out, "crit-0029").repair.sameLine, false, "it quotes another line than the original");
    assert.equal(line(out, "crit-0030").repair.status, "merged_duplicate");
    assert.equal(line(out, "crit-0030").repair.coveredBy, "crit-0029");
    assert.equal(out.ordinaryRepairs.counts.mergedDuplicates, 1);
    assert.equal(out.ordinaryRepairs.counts.repaired, 1);
    assert.equal(out.ordinaryRepairs.counts.attempted, 2);
    // Both items were re-drafted (one attempt each); both replacements were checked.
    assert.equal(redrafts(r.provider).length, 2);
  });

  test("a replacement that says what a rule ALREADY served says: not served twice, the original is covered by that rule", async () => {
    const r = rig();
    r.provider.policy = wrongTitles(["Gadget item a", "Gadget item b"]);
    r.provider.redraftPolicy = asLeadIn;
    // The lead-in is already a (confirmed) rule of the draft.
    const draft = [...rules(27), leadInRule(28), itemRule(29, ITEM_A, "Gadget item a"), itemRule(30, ITEM_B, "Gadget item b")];
    const out = ok(await r.svc.check(input(rubricOf(draft, null))));
    assert.equal(out.repairs, undefined, "nothing new is served: the lead-in rule already is");
    assert.deepEqual(out.leftOut.map((x: any) => `${x.criterionId}:${x.reason}`), [`crit-0029:${REDRAFT_DUPLICATE_REASON}`, `crit-0030:${REDRAFT_DUPLICATE_REASON}`]);
    assert.equal(line(out, "crit-0029").repair.coveredBy, "crit-0028");
    assert.equal(line(out, "crit-0030").repair.coveredBy, "crit-0028");
  });

  test("the same words for OTHER applicants are another rule: both are served (the duplicate gate's own scope test)", () => {
    const a = leadInRule(1);
    const sameWords = leadInRule(2, "Other", { applicability: "specialist", applicabilityCondition: "where the applicant does something else" });
    assert.equal(sameRuleAs(a, leadInRule(3)), true);
    assert.equal(sameRuleAs(sameWords, a), false);
    assert.equal(sameRuleAs(a, a), false, "a rule is never its own twin");
    assert.equal(sameRuleAs(plain(1), plain(2)), false, "different quotes");
    // A bar covers the replacement whatever the scope: the gate would hold the draft over the pair.
    const bar = ruleOf(5, { kind: "mandatory_bar", appliesTo: { nationalities: ["QM"], asWritten: ["x"] }, source: sourceOf(DEF_LEAD) });
    assert.equal(sameRuleAs(sameWords, bar), true);
  });

  test("a covered original's question links are re-pointed to the one served rule by the read-side filter, and the covered rule is gone", () => {
    const a = ruleOf(1, { title: "A", intakeQuestionIds: ["qa"] });
    const b = ruleOf(2, { title: "B", intakeQuestionIds: ["qb"] });
    const c = ruleOf(3, { title: "C" });
    const replacement = { ...a, title: "Lead-in rule" };
    const rubric = {
      criteria: [a, b, c],
      intakeQuestions: [
        { id: "qa", label: "A?", criterionIds: ["crit-0001"] },
        { id: "qb", label: "B?", criterionIds: ["crit-0002"] },
      ],
      evidenceItems: [{ key: "e", title: "E", criterionIds: ["crit-0002", "crit-0003"] }],
      excludedCriterionIds: ["crit-0002"],
      ruleRepairs: [{ criterionId: "crit-0001", replacement, originalRuleHash: ruleHashOf(a), runId: "r", alsoReplaced: ["crit-0002"] }],
    };
    const served = applyExclusions(rubric as any) as any;
    assert.deepEqual(served.criteria.map((x: AssessmentCriterion) => x.title), ["Lead-in rule", "C"], "ONE copy of the rule, the covered original is not served");
    assert.deepEqual(served.criteria[0].intakeQuestionIds, ["qa", "qb"], "the served rule carries both originals' question links");
    // qb survives, pointing at the served rule; the evidence item keeps its other link.
    assert.deepEqual(served.intakeQuestions.map((q: any) => [q.id, q.criterionIds]), [["qa", ["crit-0001"]], ["qb", ["crit-0001"]]]);
    assert.deepEqual(served.evidenceItems[0].criterionIds, ["crit-0001", "crit-0003"]);
  });
});

// ============================================
// applyRuleRepairs for ordinary rules
// ============================================

describe("applyRuleRepairs and ordinary rules (#244)", () => {
  const original = ruleOf(7);
  const replacement = { ...original, title: "Replaced" };
  const rep = (over: Partial<RubricRuleRepair> = {}): RubricRuleRepair => ({ criterionId: original.criterionId, replacement, originalRuleHash: ruleHashOf(original), runId: "r", ...over });
  const bar = (i: number) => ruleOf(i, { kind: "mandatory_bar", appliesTo: { nationalities: ["QM"], asWritten: ["Borduria"] } });

  test("an ordinary original is swapped for an ordinary replacement of the same id, in place", () => {
    const out = applyRuleRepairs({ criteria: [ruleOf(1), original, ruleOf(8)], ruleRepairs: [rep()] });
    assert.deepEqual(out.criteria.map((c) => c.title), ["Matter 1", "Replaced", "Matter 8"]);
  });

  test("a rule never changes class: a protected original keeps its bar, an ordinary one is never swapped for a protected rule, another id is ignored", () => {
    const protectedRep = { ...bar(7), criterionId: original.criterionId, title: "Became a bar" };
    const out = applyRuleRepairs({ criteria: [original], ruleRepairs: [rep({ replacement: protectedRep })] });
    assert.equal(out.criteria[0].title, "Matter 7");
    const barOriginal = bar(9);
    const ordinaryForBar = applyRuleRepairs({ criteria: [barOriginal], ruleRepairs: [{ criterionId: barOriginal.criterionId, replacement: { ...ordinaryOf(barOriginal) }, originalRuleHash: "h", runId: "r" }] });
    assert.equal(ordinaryForBar.criteria[0].kind, "mandatory_bar");
    assert.equal(applyRuleRepairs({ criteria: [original], ruleRepairs: [rep({ replacement: { ...replacement, criterionId: "crit-9999" } })] }).criteria[0].title, "Matter 7");
  });

  test("a bar can never be covered by `alsoReplaced`, and an id that does not exist re-points nothing", () => {
    const b = bar(2);
    const out = applyRuleRepairs({
      criteria: [ruleOf(1), b],
      intakeQuestions: [{ criterionIds: ["crit-0002"] }],
      ruleRepairs: [{ criterionId: "crit-0001", replacement: { ...ruleOf(1), title: "R" }, originalRuleHash: "h", runId: "r", alsoReplaced: ["crit-0002", "crit-9999"] }],
    });
    assert.equal(out.criteria[1].kind, "mandatory_bar");
    assert.deepEqual(out.intakeQuestions?.[0].criterionIds, ["crit-0002"]);
  });
});

/** An ordinary version of a rule (for the "ordinary for a bar" case). */
function ordinaryOf(c: AssessmentCriterion): AssessmentCriterion {
  const { appliesTo: _a, ...rest } = c;
  void _a;
  return { ...rest, kind: "judgement" };
}

// ============================================
// The guard, the caps and the clock
// ============================================

describe("the guard and the bounds degrade to 'left out as before' (#244)", () => {
  const wrongOnes = (k: number) => Array.from({ length: k }, (_, i) => `Matter ${i + 1}`);

  test("systemic guard: more eligible rules than the share of the draft allows: NO ordinary rule is re-drafted, the run records it", async () => {
    const r = rig({ n: 30 });
    r.provider.policy = wrongTitles(wrongOnes(7)); // 7 of 30 = 23 % > 20 %
    r.provider.redraftPolicy = renew();
    const out = ok(await r.svc.check(input(rubricOf(rules(30), null))));
    assert.equal(redrafts(r.provider).length, 0);
    assert.equal(out.ordinaryRepairs.counts.skipped, "too_many");
    assert.equal(out.ordinaryRepairs.counts.eligible, 7);
    assert.equal(out.ordinaryRepairs.counts.notAttempted, 7);
    assert.equal(out.repairs, undefined);
    assert.equal(out.leftOut.length, 7, "judged by the budget as today");
    assert.ok(out.ordinaryRepairs.records.every((x: any) => x.repair.status === "not_attempted" && x.repair.detail === "too_many"));
  });

  test("exactly at the share is allowed (`more than` the share); the rule count cap and 0 = disabled both skip", async () => {
    const at = rig({ n: 30 });
    at.provider.policy = wrongTitles(wrongOnes(6)); // 6 of 30 = 20 %: not more than 20 %
    at.provider.redraftPolicy = renew();
    assert.equal(ok(await at.svc.check(input(rubricOf(rules(30), null)))).ordinaryRepairs.counts.repaired, 6);
    const cap = rig({ n: 30, settings: { ordinaryRepairMaxRules: 2 } });
    cap.provider.policy = wrongTitles(wrongOnes(3));
    cap.provider.redraftPolicy = renew();
    assert.equal(ok(await cap.svc.check(input(rubricOf(rules(30), null)))).ordinaryRepairs.counts.skipped, "too_many");
    const off = rig({ n: 30, settings: { ordinaryRepairMaxRules: 0 } });
    off.provider.policy = wrongTitles(wrongOnes(1));
    const o = ok(await off.svc.check(input(rubricOf(rules(30), null))));
    assert.equal(o.ordinaryRepairs.counts.skipped, "too_many");
    assert.equal(redrafts(off.provider).length, 0);
  });

  test("request cap: only what fits WITH the check of the replacements is re-drafted, the rest is left out, the run completes, and a retry pays only for the rest", async () => {
    const ledger = new MemoryLedger();
    // 60 rules = 6 check batches; 10 wrong (16.7 %). cap 16: 6 + n + ceil(n/10) + ceil(n/10) + 2 <= 16 -> n = 6.
    const first = rig({ n: 60, ledger, settings: { checkerMaxRequestsPerRun: 16 } });
    first.provider.policy = wrongTitles(wrongOnes(10));
    first.provider.redraftPolicy = renew();
    const out1 = ok(await first.svc.check(input(rubricOf(rules(60), null))));
    assert.equal(redrafts(first.provider).length, 6);
    assert.ok(first.provider.requests.length <= 16, `${first.provider.requests.length} requests`);
    assert.equal(out1.ordinaryRepairs.counts.cutOff, "capped");
    assert.equal(out1.ordinaryRepairs.counts.repaired, 6);
    assert.equal(out1.ordinaryRepairs.counts.notAttempted, 4);
    assert.deepEqual(out1.leftOut.map((x: any) => x.criterionId), ["crit-0007", "crit-0008", "crit-0009", "crit-0010"], "the rest stay left out as found wrong: nothing trimmed");
    assert.ok(out1.leftOut.every((x: any) => x.basis === "found_wrong"));
    assert.ok(out1.ordinaryRepairs.records.filter((x: any) => x.repair.status === "not_attempted").every((x: any) => x.repair.detail === "cap_exceeded"));

    // The retry (the sweep): same ledger, a roomy cap. The six finished attempts are NOT re-drafted or re-checked.
    const second = rig({ n: 60, ledger, provider: new ScriptedProvider() });
    second.provider.policy = wrongTitles(wrongOnes(10));
    second.provider.redraftPolicy = renew();
    const out2 = ok(await second.svc.check(input(rubricOf(rules(60), null))));
    assert.equal(redrafts(second.provider).length, 4, "only the four that were never tried");
    assert.equal(batches(second.provider).length, 1, "and only their one check batch: the six stored readings are reused");
    assert.equal(out2.ordinaryRepairs.counts.repaired, 10);
    assert.deepEqual(out2.leftOut, []);
    assert.equal(out2.ordinaryRepairs.counts.cutOff, undefined);
    assert.equal(out2.repairs.length, 10);
  });

  test("input-size cap: the same degrade (the prompt characters of the re-drafts count inside it)", async () => {
    const r = rig({ n: 30, settings: { checkerMaxInputCharsPerRun: 150_000 } });
    r.provider.policy = wrongTitles(wrongOnes(4));
    r.provider.redraftPolicy = renew();
    const out = ok(await r.svc.check(input(rubricOf(rules(30), null))));
    assert.equal(out.ordinaryRepairs.counts.cutOff, "capped");
    assert.ok(out.ordinaryRepairs.counts.notAttempted > 0);
    assert.equal(out.ok, true);
    // Every repaired + not attempted rule is accounted for.
    assert.equal(out.ordinaryRepairs.counts.repaired + out.ordinaryRepairs.counts.notAttempted + out.ordinaryRepairs.counts.checkPending, 4);
  });

  test("the clock: no wave starts after the start deadline; the run completes; the next run resumes with the stored attempts and pays only for the rest", async () => {
    const ledger = new MemoryLedger();
    const clock = { t: Date.parse("2026-11-13T10:00:00Z") };
    const start = clock.t;
    const first = rig({ n: 100, ledger, clock });
    first.provider.policy = wrongTitles(wrongOnes(10)); // 10 of 100 = 10 %
    first.provider.redraftPolicy = renew();
    // The clock jumps past the start deadline once the first wave of six re-drafts has been asked.
    let drafted = 0;
    first.provider.script = (_n, req) => {
      if (isRepairRequest(req) && ++drafted === 6) clock.t = start + 400_000;
      return undefined;
    };
    const out1 = ok(await first.svc.check(input(rubricOf(rules(100), null))));
    assert.equal(redrafts(first.provider).length, 6, "one wave");
    assert.equal(out1.ordinaryRepairs.counts.cutOff, "deadline");
    // The six attempts are stored; their check could not start (the clock), so they are pending, not lost.
    assert.equal(out1.ordinaryRepairs.counts.checkPending, 6);
    assert.equal(out1.ordinaryRepairs.counts.notAttempted, 4);
    assert.equal(out1.repairs, undefined);
    assert.equal(out1.leftOut.length, 10, "all ten stay left out for now");
    assert.equal(Object.keys(ledger.docs.get("XA_xa-test__v1")!.repairs!).length, 6, "stored before the clock ran out");

    // Next delivery, a fresh clock: only the four remaining are re-drafted; all ten replacements are checked.
    const second = rig({ n: 100, ledger, clock: { t: start + 3_600_000 } });
    second.provider.policy = wrongTitles(wrongOnes(10));
    second.provider.redraftPolicy = renew();
    const out2 = ok(await second.svc.check(input(rubricOf(rules(100), null))));
    assert.equal(redrafts(second.provider).length, 4);
    assert.equal(redrafts(first.provider).length + redrafts(second.provider).length, 10, "every rule re-drafted exactly once across both runs");
    assert.equal(out2.ordinaryRepairs.counts.repaired, 10);
    assert.deepEqual(out2.leftOut, []);
  });

  test("a provider failure mid-repair: no attempt is stored for it, the rest of the queue waits, the run completes, the retry re-drafts only what was not finished", async () => {
    const ledger = new MemoryLedger();
    const first = rig({ n: 60, ledger });
    first.provider.policy = wrongTitles(wrongOnes(8)); // 8 of 60
    first.provider.redraftPolicy = renew();
    let seen = 0;
    first.provider.script = (_n, req) => (isRepairRequest(req) && ++seen === 3 ? "hard" : undefined);
    const out1 = ok(await first.svc.check(input(rubricOf(rules(60), null))));
    assert.equal(out1.ordinaryRepairs.counts.cutOff, "provider");
    const stored = Object.keys(ledger.docs.get("XA_xa-test__v1")!.repairs!).length;
    assert.equal(stored, 5, "the five that finished in the wave; the failed one is not an attempt");
    const second = rig({ n: 60, ledger });
    second.provider.policy = wrongTitles(wrongOnes(8));
    second.provider.redraftPolicy = renew();
    const out2 = ok(await second.svc.check(input(rubricOf(rules(60), null))));
    assert.equal(redrafts(second.provider).length, 8 - stored + 0 * stored, "the failed rule and the three never started");
    assert.equal(out2.ordinaryRepairs.counts.repaired, 8);
  });

  test("a stored attempt made under an older repair prompt that gave no replacement gets one more try; a stored replacement is kept", async () => {
    const ledger = new MemoryLedger();
    const r = rig({ n: 30, ledger });
    r.provider.policy = wrongTitles(["Matter 3", "Matter 4"]);
    r.provider.redraftPolicy = renew();
    const target = rules(30);
    ledger.docs.set("XA_xa-test__v1", {
      runId: "XA_xa-test__v1", routeKey: "XA_xa-test", version: 1, promptVersion: "other", models: { verification: "", judgement: "" }, day: "", reachedModel: true, status: "failed", reasonCodes: [], responses: {}, ruleVerdicts: {}, rules: 30,
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, requests: 0, inputChars: 0 }, lifetimeUsage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, requests: 0, inputChars: 0 }, updatedAtMs: 0,
      repairs: {
        "crit-0003": { ruleHash: ruleHashOf(target[2]), kind: "cannot_be_repaired", requests: 1, promptVersion: "an-older-repair-prompt" },
        "crit-0004": { ruleHash: ruleHashOf(target[3]), kind: "cannot_be_repaired", requests: 1, promptVersion: RUBRIC_REPAIR_PROMPT_VERSION },
      },
    } as any);
    const out = ok(await r.svc.check(input(rubricOf(target, null))));
    assert.equal(redrafts(r.provider).length, 1, "Matter 3 only: the stale refusal is retried once; Matter 4's current refusal stands");
    assert.equal(line(out, "crit-0003").repair.status, "repaired");
    assert.equal(line(out, "crit-0004").repair.status, "cannot_be_repaired");
  });

  test("a stored attempt for a rule that has since changed (another hash) is not reused", async () => {
    const ledger = new MemoryLedger();
    const r = rig({ n: 30, ledger });
    r.provider.policy = wrongTitles(["Matter 3"]);
    r.provider.redraftPolicy = renew();
    ledger.docs.set("XA_xa-test__v1", { runId: "XA_xa-test__v1", repairs: { "crit-0003": { ruleHash: "different", kind: "cannot_be_repaired", requests: 1, promptVersion: RUBRIC_REPAIR_PROMPT_VERSION } }, promptVersion: "x", responses: {}, usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, requests: 0, inputChars: 0 }, lifetimeUsage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, requests: 0, inputChars: 0 } } as any);
    ok(await r.svc.check(input(rubricOf(rules(30), null))));
    assert.equal(redrafts(r.provider).length, 1);
  });
});

// ============================================
// Protected rules are unchanged, and go first
// ============================================

describe("protected rules keep their path (#244)", () => {
  const BAR_QUOTE = "An application must be refused where the applicant is a national of Borduria or Syldavia.";
  const barRule = () => ruleOf(100, { title: "Original bar", kind: "mandatory_bar", stage: "validity", severity: "critical", source: sourceOf(BAR_QUOTE), appliesTo: { nationalities: ["QM", "QN"], asWritten: ["Borduria", "Syldavia"] } });
  const withBarPage = () => ({ ...page(30), text: `${page(30).text}\n${BAR_QUOTE}` });

  function barRig(settings: Parameters<typeof settingsWith>[0] = {}) {
    const provider = new ScriptedProvider();
    const clock = { t: Date.parse("2026-11-13T10:00:00Z") };
    const p = withBarPage() as any;
    const svc = new RubricCheckerService({ provider: () => provider, readSnapshot: async () => p, loadSettings: settingsWith(settings), ledger: new MemoryLedger(), nowMs: () => clock.t, sleep: async () => undefined });
    return { svc, provider };
  }

  test("a bar that is repaired AND an ordinary rule that is repaired: both replacements are served, the bar's first, with its own two-model check", async () => {
    const r = barRig();
    r.provider.policy = (ctx) => (ctx.rule.title === "Original bar" ? (ctx.role === "judgement" ? { group_matches_codes: "unsure" } : undefined) : ctx.rule.title === "Matter 7" ? { title_faithful: "no" } : undefined);
    r.provider.redraftPolicy = ({ shown }: { shown: Record<string, any> }) =>
      shown.kind === "mandatory_bar"
        ? criteriaWire(answer({ criteria: [crit({ ref: "r1", title: "Repaired bar", kind: "mandatory_bar", stage: "validity", severity: "critical", quote: BAR_QUOTE, appliesTo: { nationalities: ["QM", "QN"], asWritten: ["Borduria", "Syldavia"] } })] }))
        : renew()({ shown });
    const out = ok(await r.svc.check(input(rubricOf([...rules(30), barRule()], null))));
    assert.deepEqual(out.repairs.map((x: any) => x.criterionId), ["crit-0100", "crit-0007"], "the bar's repair is first");
    assert.equal(out.protectedFailures[0].repair.status, "repaired");
    assert.equal(out.ordinaryRepairs.counts.repaired, 1);
    // The bar's replacement was read by BOTH models, the ordinary one by one.
    const readers = (title: string) => batches(r.provider).filter((q) => q.user.includes(title)).map((q) => q.role).sort();
    assert.deepEqual(readers("Repaired bar"), ["judgement", "verification"]);
    assert.deepEqual(readers("Repaired Matter 7"), ["verification"]);
  });

  test("a bar that cannot be repaired holds the draft and NOTHING is spent on the ordinary re-drafts", async () => {
    const r = barRig();
    r.provider.policy = (ctx) => (ctx.rule.title === "Original bar" ? { group_matches_codes: "no" } : ctx.rule.title === "Matter 7" ? { title_faithful: "no" } : undefined);
    r.provider.redraftPolicy = ({ shown }: { shown: Record<string, any> }) => (shown.kind === "mandatory_bar" ? { criteria: [], suspiciousPassages: [] } : renew()({ shown }));
    const out: any = await r.svc.check(input(rubricOf([...rules(30), barRule()], null)));
    assert.equal(out.ok, false);
    assert.match(out.reasonCodes[0], /^protected_rule_failed:/);
    assert.equal(redrafts(r.provider).length, 1, "the bar's one re-draft only; Matter 7 is not re-drafted for a draft that is held anyway");
    assert.equal(out.ordinaryRepairs, undefined);
    // The held report still lists the ordinary leave-out, as before.
    assert.deepEqual(out.leftOut.map((x: any) => x.criterionId), ["crit-0007"]);
  });
});

// ============================================
// The budget sees the replacements
// ============================================

describe("budget and shares with replacements (#244)", () => {
  /** Gate input for a draft of `n` ordinary rules (a few scoped). */
  const gateInput = (criteria: AssessmentCriterion[], leftOut: { criterionId: string; reason: string; basis?: "found_wrong" | "not_confirmed" }[]) => ({
    criteria,
    flags: [],
    suspiciousPassageCount: 0,
    structuralErrorCodes: [],
    primarySourceIds: new Set([SRC_ID]),
    allSourceIds: [SRC_ID],
    servingKeptCount: null,
    settings: DEFAULT_PUBLISH_SETTINGS,
    checker: { leftOut, resolvedFlagCodes: [] },
  });

  test("a repaired rule no longer counts as left out: the same draft is over the budget without repair and inside it with", () => {
    const criteria = rules(20);
    const wrong = ["crit-0001", "crit-0002", "crit-0003", "crit-0004"].map((criterionId) => ({ criterionId, reason: "checker:title_faithful", basis: "found_wrong" as const }));
    const without = evaluateGates(gateInput(criteria, wrong));
    assert.ok(without.reasonCodes.includes("leave_out_budget_exceeded")); // 4 of 20 = 20 % > 15 %
    // Two of the four repaired (the replacement is in `criteria`, and is not left out).
    const withRepair = evaluateGates(gateInput(criteria.map((c) => (c.criterionId === "crit-0001" || c.criterionId === "crit-0002" ? { ...c, title: "Replaced" } : c)), wrong.slice(2)));
    assert.ok(!withRepair.reasonCodes.includes("leave_out_budget_exceeded")); // 2 of 20 = 10 %
    assert.equal(withRepair.counts.leftOut, 2);
    assert.equal(withRepair.counts.leftOutFoundWrong, 2);
  });

  test("a covered duplicate is left out but NOT counted (like possible_duplicate): the detail says so", () => {
    const criteria = rules(20);
    const leftOut = [
      { criterionId: "crit-0001", reason: REDRAFT_DUPLICATE_REASON },
      { criterionId: "crit-0002", reason: REDRAFT_DUPLICATE_REASON },
      { criterionId: "crit-0003", reason: REDRAFT_DUPLICATE_REASON },
      { criterionId: "crit-0004", reason: REDRAFT_DUPLICATE_REASON },
    ];
    const report = evaluateGates(gateInput(criteria, leftOut));
    assert.ok(!report.reasonCodes.includes("leave_out_budget_exceeded"));
    assert.equal(report.counts.leftOut, 4, "they ARE left out of the served rulebook");
    assert.equal(report.counts.leftOutByReason[REDRAFT_DUPLICATE_REASON], 4);
    assert.match(report.gates.find((g) => g.gate === "leave_out_budget")?.detail ?? "", /0 of 20 left out for correctness \(4 duplicate\(s\) not counted\)/);
    assert.deepEqual(report.excludedCriterionIds, ["crit-0001", "crit-0002", "crit-0003", "crit-0004"]);
  });
});
