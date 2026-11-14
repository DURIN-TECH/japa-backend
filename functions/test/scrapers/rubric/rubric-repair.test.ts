// ============================================
// Protected-rule repair (issue #223) — the check's side
// ============================================
//
// No network, no model, no Firestore: the scripted provider (checker-fakes.ts)
// answers the check's requests AND the one re-draft request of a failed bar; the
// ledger and the snapshot reader are in memory. Proved here:
//   - a failed bar is re-drafted ONCE from its own passage, validated by the same
//     code as any drafted rule, checked again by BOTH models, and kept when it passes;
//   - it is held when the re-draft still fails the check (an "unsure" that a
//     re-draft cannot change stays a failure), has no verbatim quote, is not a bar
//     any more, or the model says it cannot be repaired;
//   - the ordinary rules are checked EVEN when a bar failed (the held report is complete);
//   - the caps: more failed bars than the cap, the request cap, the input cap;
//   - idempotency: a re-run, and a retry after a provider failure, never re-draft twice;
//   - the pure helpers: the rule hash, and the read-side swap that can never remove a bar.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { RubricCheckerService } from "../../../src/scrapers/rubric/rubric-checker";
import { applyExclusions } from "../../../src/scrapers/rubric/rubric-exclusions";
import { applyRuleRepairs, isBar, ruleHashOf } from "../../../src/scrapers/rubric/rubric-repair";
import { isProtectedRule } from "../../../src/scrapers/rubric/rubric-gates";
import { buildRepairRequest, RUBRIC_REPAIR_PROMPT_VERSION } from "../../../src/scrapers/rubric/rubric-prompt";
import { SnapshotQuoteIndex } from "../../../src/scrapers/rubric/rubric-quote";
import type { AssessmentCriterion, RubricRuleRepair } from "../../../src/types/rubric";
import { answer, crit, criteriaWire } from "./rubric-harness";
import { MemoryLedger, ScriptedProvider, isRepairRequest, pageOf, ruleOf, rubricOf, settingsWith, SRC_HASH, SRC_ID } from "./checker-fakes";

/* eslint-disable @typescript-eslint/no-explicit-any */

// ---------- fixtures ----------

/** The line of the page that holds a bar, and its quote (invented names: nothing real). */
const BAR_QUOTE = "An application must be refused where the applicant is a national of Borduria or Syldavia.";
const quoteOfBar = (n: number) => (n === 1 ? BAR_QUOTE : `${BAR_QUOTE} Variant ${n}.`);
const barLine = (n: number) => `B${n}.1 ${quoteOfBar(n)}`;

/** A page of ordinary rules plus `bars` bar lines at its end. */
const page = (ordinary: number, bars = 1) => pageOf(ordinary, Array.from({ length: bars }, (_, k) => barLine(k + 1)));

/** The stored bar `n` (n = 1 .. bars): a bar on two named groups, quoting its own line. */
function bar(n = 1, over: Partial<AssessmentCriterion> = {}): AssessmentCriterion {
  return ruleOf(100 + n, {
    title: `Original bar ${n}`,
    kind: "mandatory_bar",
    stage: "validity",
    severity: "critical",
    source: { quote: quoteOfBar(n), sourceId: SRC_ID, url: "https://rules.example/page", contentHash: SRC_HASH, retrievedAt: "2026-11-13T00:00:00Z" },
    appliesTo: { nationalities: ["QM", "QN"], asWritten: ["Borduria", "Syldavia"] },
    ...over,
  });
}

/** What the model answers to a re-draft of bar `n`: the same passage, a corrected stage. */
const goodRedraft = (n = 1, over: Record<string, unknown> = {}) =>
  criteriaWire(answer({
    criteria: [
      crit({
        ref: "r1",
        title: `Repaired bar ${String.fromCharCode(64 + n)}`,
        kind: "mandatory_bar",
        stage: "suitability",
        severity: "critical",
        quote: quoteOfBar(n),
        appliesTo: { nationalities: ["QM", "QN"], asWritten: ["Borduria", "Syldavia"] },
        ...over,
      }),
    ],
  }));

interface Rig {
  svc: RubricCheckerService;
  provider: ScriptedProvider;
  ledger: MemoryLedger;
}

/** A check over `ordinary` rules and `bars` bar lines. */
function rig(opts: { ordinary?: number; bars?: number; page?: ReturnType<typeof pageOf>; settings?: Parameters<typeof settingsWith>[0]; ledger?: MemoryLedger; provider?: ScriptedProvider } = {}): Rig {
  const provider = opts.provider ?? new ScriptedProvider();
  const ledger = opts.ledger ?? new MemoryLedger();
  const p = opts.page ?? page(opts.ordinary ?? 12, opts.bars ?? 1);
  const svc = new RubricCheckerService({
    provider: () => provider,
    readSnapshot: async () => p,
    loadSettings: settingsWith(opts.settings),
    ledger,
    nowMs: () => Date.parse("2026-11-13T10:00:00Z"),
    sleep: async () => undefined,
  });
  return { svc, provider, ledger };
}

const input = (rubric: ReturnType<typeof rubricOf>) => ({ routeKey: rubric.routeKey, version: 1, runId: `${rubric.routeKey}__v1`, rubric, codeLeftOutIds: [] as string[] });
const ordinaryRules = (n: number) => Array.from({ length: n }, (_, k) => ruleOf(k + 1));
/** An outcome without `requests`: the spend of THIS run, which is 0 when everything is replayed from the stored answers. */
const withoutSpend = (o: any) => {
  const { requests: _requests, ...rest } = o;
  void _requests;
  return rest;
};
const repairRequests = (p: ScriptedProvider) => p.requests.filter(isRepairRequest);
const batchRequests = (p: ScriptedProvider) => p.requests.filter((q) => (q.schema as any).properties.verdicts);

/** The real failure of the first run, in miniature: ONE `unsure`, on `group_matches_codes` (#226: a bar's stage is no longer judged), from the judgement-role model only. */
const unsureGroupFromJudgement = ({ role, rule }: { role: string; rule: any }) => (rule.appliesTo && role === "judgement" ? { group_matches_codes: "unsure" as const } : undefined);

// ============================================
// Repaired and confirmed
// ============================================

describe("a failed bar gets one repair (#223)", () => {
  test("re-drafted from its own passage, checked by BOTH models, confirmed: the run goes on with the replacement", async () => {
    const r = rig();
    // The original fails; the replacement (a different title) passes.
    r.provider.policy = (ctx) => (ctx.rule.title === "Original bar 1" ? unsureGroupFromJudgement(ctx) : undefined);
    r.provider.redraftPolicy = () => goodRedraft();
    const rules = [...ordinaryRules(12), bar()];
    const out = await r.svc.check(input(rubricOf(rules, null)));

    assert.equal(out.ok, true);
    if (!out.ok) return;
    assert.equal(out.repairs?.length, 1);
    const rep = out.repairs?.[0] as RubricRuleRepair;
    // Same id (every link stays valid), new content from the re-draft, still a bar.
    assert.equal(rep.criterionId, rules[12].criterionId);
    assert.equal(rep.replacement.title, "Repaired bar A");
    assert.equal(rep.replacement.stage, "suitability");
    assert.equal(rep.replacement.source.quote, BAR_QUOTE, "the quote is the source's own words, found again by code");
    assert.ok(isProtectedRule(rep.replacement));
    assert.equal(rep.originalRuleHash, ruleHashOf(rules[12]));
    assert.equal(rep.runId, "XA_xa-test__v1");
    // The original stays untouched in the draft (the audit trail): the check never edits a rule.
    assert.equal(rules[12].title, "Original bar 1");
    assert.equal(rules[12].stage, "validity");
    // The record of the attempt.
    const f = out.protectedFailures?.[0];
    assert.equal(f?.repair.status, "repaired");
    assert.deepEqual(f?.failedAspects, ["group_matches_codes"]);
    assert.equal(f?.title, "Original bar 1");
    assert.equal(f?.repair.ruleHash, ruleHashOf(rules[12]));
    assert.deepEqual(f?.repair.replacementFailedAspects, []);
    // The replacement's own verdicts, letters in the checker's aspect order (title, kind, stage, condition, check, group).
    assert.deepEqual(f?.repair.replacementVerdicts, { verification: "yyyyay", judgement: "yyyyay" });
    // Spend: 2 bar batches + 2 ordinary batches (12 rules, batches of 10) + 1 re-draft + 2 checks of the replacement.
    assert.equal(r.provider.requests.length, 7);
    assert.equal(repairRequests(r.provider).length, 1);
    assert.deepEqual(out.requests, { total: 7, repair: 3 });
    // Both models read the replacement (a request carrying its new title, from each role).
    const replacementReaders = batchRequests(r.provider).filter((q) => q.user.includes("Repaired bar A")).map((q) => q.role).sort();
    assert.deepEqual(replacementReaders, ["judgement", "verification"]);
  });

  test("the re-draft is shown the failed rule, the aspect that failed and the source passage, and the SAME drafting prompt", async () => {
    const r = rig();
    r.provider.policy = unsureGroupFromJudgement;
    r.provider.redraftPolicy = () => goodRedraft();
    await r.svc.check(input(rubricOf([...ordinaryRules(3), bar()], null)));
    const [req] = repairRequests(r.provider);
    assert.ok(req.user.includes("group_matches_codes"), "the failed aspect");
    assert.ok(req.user.includes("Original bar 1"), "the failed rule's own fields");
    assert.ok(req.user.includes(BAR_QUOTE), "the source passage");
    assert.equal(req.effort, "high");
    // The drafting call's schema, unchanged: the answer is validated by the drafting code.
    assert.ok("criteria" in (req.schema as any).properties);
    assert.match(RUBRIC_REPAIR_PROMPT_VERSION, /repair/);
  });

  test("the replacement goes through the drafting validation: a rule whose group name is not in its quote is refused", async () => {
    const r = rig();
    r.provider.policy = unsureGroupFromJudgement;
    r.provider.redraftPolicy = () => goodRedraft(1, { appliesTo: { nationalities: ["QM"], asWritten: ["Atlantis"] } });
    const out = await r.svc.check(input(rubricOf([...ordinaryRules(3), bar()], null)));
    assert.equal(out.ok, false);
    if (out.ok) return;
    assert.equal(out.protectedFailures?.[0].repair.status, "invalid_redraft");
    assert.equal(out.protectedFailures?.[0].repair.detail, "applies_to_not_in_quote");
    // No check of a rule that code refused: only the re-draft was spent.
    assert.equal(out.requests?.repair, 1);
  });
});

// ============================================
// Held
// ============================================

describe("a bar that is still not confirmed holds the draft (#223)", () => {
  test("the replacement fails the check again: held, with the aspect the replacement still fails; an 'unsure' a re-draft cannot change is still a failure", async () => {
    const r = rig();
    // EVERY reading of a bar by the judgement model is unsure on stage: the re-draft cannot change that.
    r.provider.policy = unsureGroupFromJudgement;
    r.provider.redraftPolicy = () => goodRedraft();
    const out = await r.svc.check(input(rubricOf([...ordinaryRules(12), bar()], null)));
    assert.equal(out.ok, false);
    if (out.ok) return;
    assert.deepEqual(out.reasonCodes, ["protected_rule_failed:crit-0101"]);
    assert.deepEqual(out.protectedRuleIds, ["crit-0101"]);
    const f = out.protectedFailures?.[0];
    assert.equal(f?.repair.status, "failed_check");
    assert.deepEqual(f?.repair.replacementFailedAspects, ["group_matches_codes"]);
    assert.deepEqual(f?.repair.replacementVerdicts, { verification: "yyyyay", judgement: "yyyyau" });
    // The ORIGINAL's verdicts are on the record too.
    assert.deepEqual(f?.verdicts, { verification: "yyyyay", judgement: "yyyyau" });
    assert.equal([...r.ledger.docs.values()][0].status, "failed");
  });

  test("the ordinary rules are STILL checked when a bar failed, and the held report lists their leave-outs", async () => {
    const r = rig();
    r.provider.policy = (ctx) => (ctx.rule.title === "Matter 4" ? { kind_right: "no" } : unsureGroupFromJudgement(ctx));
    const out = await r.svc.check(input(rubricOf([...ordinaryRules(12), bar()], null)));
    assert.equal(out.ok, false);
    if (out.ok) return;
    // 2 ordinary batches ran although the bar failed, and the report carries what they found.
    const ordinaryBatches = batchRequests(r.provider).filter((q) => q.role === "verification" && q.user.includes("Matter 1"));
    assert.equal(ordinaryBatches.length, 2, "12 ordinary rules, batches of 10");
    assert.deepEqual(out.leftOut, [{ criterionId: "crit-0004", reason: "checker:kind_right", basis: "found_wrong" }]);
    // Every ordinary verdict is stored with the check's record, so a re-run needs nothing.
    assert.equal(Object.keys([...r.ledger.docs.values()][0].responses).length >= 4, true);
  });

  test("the model says the passage cannot be repaired: held, one request spent", async () => {
    const r = rig();
    r.provider.policy = unsureGroupFromJudgement;
    // default redraftPolicy: an empty `criteria` list
    const out = await r.svc.check(input(rubricOf([...ordinaryRules(3), bar()], null)));
    assert.equal(out.ok, false);
    if (out.ok) return;
    assert.equal(out.protectedFailures?.[0].repair.status, "cannot_be_repaired");
    assert.deepEqual(out.reasonCodes, ["protected_rule_failed:crit-0101"]);
    assert.equal(out.requests?.repair, 1);
  });

  test("a re-draft whose quote is not in the official text is refused by code: held, nothing else spent", async () => {
    const r = rig();
    r.provider.policy = unsureGroupFromJudgement;
    r.provider.redraftPolicy = () => goodRedraft(1, { quote: "An application must be refused where the applicant is a national of Atlantis." });
    const out = await r.svc.check(input(rubricOf([...ordinaryRules(3), bar()], null)));
    assert.equal(out.ok, false);
    if (out.ok) return;
    assert.equal(out.protectedFailures?.[0].repair.status, "invalid_redraft");
    assert.equal(out.protectedFailures?.[0].repair.detail, "quote_not_found");
    assert.equal(out.requests?.repair, 1, "only the re-draft was spent: no check of an invalid rule");
  });

  test("a re-draft that is no longer a bar, or quotes another line, is refused (a bar can never be repaired away)", async () => {
    // (1) The same passage drafted as an ordinary judgement rule: not a bar any more.
    const notBar = rig();
    notBar.provider.policy = unsureGroupFromJudgement;
    notBar.provider.redraftPolicy = () => goodRedraft(1, { kind: "judgement", appliesTo: null, probeFactors: ["a factor"] });
    const a = await notBar.svc.check(input(rubricOf([...ordinaryRules(3), bar()], null)));
    assert.equal(a.ok, false);
    if (a.ok) return;
    assert.equal(a.protectedFailures?.[0].repair.status, "invalid_redraft");
    // (#226) The record says WHICH condition failed: the line was right, the rule is no longer a bar.
    assert.equal(a.protectedFailures?.[0].repair.detail, "not_the_same_bar:not_a_bar:returned=1:accepted=1:same_line=1:bar=0");

    // (2) A valid bar, but of ANOTHER line of the page: it is not this rule again.
    const other = rig({ bars: 2 });
    other.provider.policy = unsureGroupFromJudgement;
    other.provider.redraftPolicy = () => goodRedraft(2);
    const b = await other.svc.check(input(rubricOf([...ordinaryRules(3), bar(1)], null)));
    assert.equal(b.ok, false);
    if (b.ok) return;
    // (#226) ... and here the bar is intact but quotes another line.
    assert.equal(b.protectedFailures?.[0].repair.detail, "not_the_same_bar:different_line:returned=1:accepted=1:same_line=0:bar=1");
  });

  test("(#226) a re-draft that drifts to a NEIGHBOURING line which restates the point is still refused, and the record says so", async () => {
    // The first real run's shape: the model, asked about a bar's stage, drafts the line below that reads as a clearer fit.
    const lines = [`B1.1 ${BAR_QUOTE}`, "B1.2 If a national of Borduria applies you should advise them that the application cannot be considered."];
    const r = rig({ page: pageOf(12, lines) });
    r.provider.policy = unsureGroupFromJudgement;
    r.provider.redraftPolicy = () => goodRedraft(1, { quote: "If a national of Borduria applies you should advise them that the application cannot be considered.", appliesTo: { nationalities: ["QM"], asWritten: ["Borduria"] } });
    const out = await r.svc.check(input(rubricOf([...ordinaryRules(12), bar()], null)));
    assert.equal(out.ok, false);
    if (out.ok) return;
    assert.equal(out.protectedFailures?.[0].repair.status, "invalid_redraft");
    assert.equal(out.protectedFailures?.[0].repair.detail, "not_the_same_bar:different_line:returned=1:accepted=1:same_line=0:bar=1");
    // Nothing of the model's text is on the record.
    assert.ok(!JSON.stringify(out.protectedFailures).includes("cannot be considered"));
  });

  test("(#226) a faithful re-draft that quotes ANOTHER SENTENCE of the same line (or the same one) is accepted: the test is the line, not the exact quote", async () => {
    const second = "This is because a national of Borduria has no standing to apply.";
    const lines = [`B1.1 ${BAR_QUOTE} ${second}`];
    for (const quote of [BAR_QUOTE, second]) {
      const r = rig({ page: pageOf(12, lines) });
      r.provider.policy = (ctx) => (ctx.rule.title === "Original bar 1" ? unsureGroupFromJudgement(ctx) : undefined);
      r.provider.redraftPolicy = () => goodRedraft(1, { quote, appliesTo: { nationalities: ["QM"], asWritten: ["Borduria"] } });
      const out = await r.svc.check(input(rubricOf([...ordinaryRules(12), bar()], null)));
      assert.equal(out.ok, true, quote);
      if (!out.ok) return;
      assert.equal(out.repairs?.[0].criterionId, "crit-0101");
      assert.ok(isBar(out.repairs?.[0].replacement as AssessmentCriterion));
    }
  });

  test("(#226) a re-draft can never let a DIFFERENT rule replace a bar: another id is ignored, the id and the original quoted line decide", async () => {
    // The model returns a rule for the right line but the replacement always takes the ORIGINAL's id, so no other rule is displaced.
    const r = rig();
    r.provider.policy = (ctx) => (ctx.rule.title === "Original bar 1" ? unsureGroupFromJudgement(ctx) : undefined);
    r.provider.redraftPolicy = () => goodRedraft(1);
    const rules = [...ordinaryRules(12), bar()];
    const out = await r.svc.check(input(rubricOf(rules, null)));
    assert.equal(out.ok, true);
    if (!out.ok) return;
    assert.equal(out.repairs?.length, 1);
    assert.equal(out.repairs?.[0].criterionId, "crit-0101");
    assert.equal(out.repairs?.[0].replacement.criterionId, "crit-0101");
    // And the read side refuses a replacement that is not a bar, or that carries another id.
    const notBar = { ...(out.repairs?.[0].replacement as AssessmentCriterion), kind: "judgement" as const, appliesTo: undefined };
    const swapped = applyRuleRepairs({ criteria: rules, ruleRepairs: [{ ...(out.repairs?.[0] as RubricRuleRepair), replacement: notBar }] });
    assert.equal(swapped.criteria[12].title, "Original bar 1");
    const otherId = applyRuleRepairs({ criteria: rules, ruleRepairs: [{ ...(out.repairs?.[0] as RubricRuleRepair), replacement: { ...(out.repairs?.[0].replacement as AssessmentCriterion), criterionId: "crit-0001" } }] });
    assert.equal(otherId.criteria[12].title, "Original bar 1");
    assert.equal(otherId.criteria[0].title, rules[0].title);
  });

  test("(#226) the re-draft instructions say: same line, keep the kind; the version is bumped", () => {
    // (#234) v5: reuses the v11 system prompt; the same-line / keep-kind wording is unchanged.
    assert.equal(RUBRIC_REPAIR_PROMPT_VERSION, "2026-11-repair-v5");
    const chunk = { sourceId: SRC_ID, contentHash: SRC_HASH, docType: "html", chunkIndex: 0, chunkCount: 1, text: BAR_QUOTE } as any;
    const req = buildRepairRequest(chunk, { rule: { title: "T", kind: "mandatory_bar", stage: "validity", quote: BAR_QUOTE }, aspects: ["group_matches_codes"] }, ["high"], { maxOutputTokens: 1000, timeoutMs: 1000 });
    assert.match(req.user, /taken from the same line of the excerpt/);
    assert.match(req.user, /discarded by code/);
    assert.match(req.user, /Keep the rule's kind/);
    // (#240) v3: and its applicability, unless condition_faithful is among the failed aspects.
    assert.match(req.user, /Keep the rule's applicability/);
    assert.match(req.user, /unless condition_faithful is one of the aspects/);
  });

  test("a bar whose quote cannot be found is held before any spend, and no repair is tried", async () => {
    const r = rig();
    const lost = bar(1, { source: { quote: "A sentence that is nowhere in the stored text of this page at all.", sourceId: SRC_ID, url: "u", contentHash: SRC_HASH, retrievedAt: "x" } });
    const out = await r.svc.check(input(rubricOf([...ordinaryRules(3), lost], null)));
    assert.deepEqual(out, { ok: false, reasonCodes: ["protected_rule_failed:crit-0101"], protectedRuleIds: ["crit-0101"] });
    assert.equal(r.provider.requests.length, 0);
  });
});

// ============================================
// Caps
// ============================================

describe("repair is bounded (#223)", () => {
  test("more failed bars than the cap: NO repair is attempted, every bar is named, the draft is held whole", async () => {
    const r = rig({ bars: 6 });
    r.provider.policy = unsureGroupFromJudgement;
    r.provider.redraftPolicy = () => goodRedraft();
    const bars = [1, 2, 3, 4, 5, 6].map((n) => bar(n));
    const out = await r.svc.check(input(rubricOf([...ordinaryRules(3), ...bars], null)));
    assert.equal(out.ok, false);
    if (out.ok) return;
    assert.deepEqual(out.reasonCodes, bars.map((b) => `protected_rule_failed:${b.criterionId}`));
    assert.equal(repairRequests(r.provider).length, 0, "no re-draft request was made");
    assert.ok(out.protectedFailures?.every((f) => f.repair.status === "not_attempted" && f.repair.detail === "cap_exceeded"));
    assert.deepEqual(out.requests?.repair, 0);
  });

  test("exactly the cap is repaired; the setting can lower it, and 0 turns repair off", async () => {
    // 5 bars, default cap 5: all five re-drafted (5 requests).
    const five = rig({ bars: 5 });
    five.provider.policy = (ctx) => (ctx.rule.title.startsWith("Original") ? unsureGroupFromJudgement(ctx) : undefined);
    five.provider.redraftPolicy = ({ shown }: any) => goodRedraft(Number(shown.title.slice("Original bar ".length)));
    const fiveBars = [1, 2, 3, 4, 5].map((n) => bar(n));
    const ok = await five.svc.check(input(rubricOf([...ordinaryRules(3), ...fiveBars], null)));
    assert.equal(repairRequests(five.provider).length, 5);
    assert.equal(ok.ok, true);
    if (ok.ok) assert.equal(ok.repairs?.length, 5);

    for (const [cap, detail] of [[1, "cap_exceeded"], [0, "repair_disabled"]] as const) {
      const r = rig({ bars: 2, settings: { repairMaxRulesPerRun: cap } });
      r.provider.policy = unsureGroupFromJudgement;
      const out = await r.svc.check(input(rubricOf([...ordinaryRules(3), bar(1), bar(2)], null)));
      assert.equal(out.ok, false);
      if (out.ok) return;
      assert.equal(repairRequests(r.provider).length, 0);
      assert.ok(out.protectedFailures?.every((f) => f.repair.detail === detail));
    }
  });

  test("the request cap covers repair requests: a run that cannot afford the re-draft holds checker_capped, names the bar, stores nothing as an attempt", async () => {
    // 2 bar batches + 1 ordinary batch = 3 requests; a cap of 3 leaves nothing for the re-draft.
    const r = rig({ settings: { checkerMaxRequestsPerRun: 3 } });
    r.provider.policy = unsureGroupFromJudgement;
    r.provider.redraftPolicy = () => goodRedraft();
    const out = await r.svc.check(input(rubricOf([...ordinaryRules(3), bar()], null)));
    assert.equal(out.ok, false);
    if (out.ok) return;
    assert.deepEqual(out.reasonCodes, ["checker_capped"]);
    assert.deepEqual(out.protectedRuleIds, ["crit-0101"], "the failed bar is still reported (critical alert)");
    assert.equal(out.protectedFailures?.[0].repair.status, "attempt_unfinished");
    assert.equal(repairRequests(r.provider).length, 0);
    assert.equal(r.provider.requests.length, 3, "never over the cap");
    assert.equal([...r.ledger.docs.values()][0].repairs?.["crit-0101"], undefined);
  });

  test("the request cap also stops the CHECK of a replacement: capped, never over", async () => {
    // 3 + 1 re-draft = 4 requests fit; the two checks of the replacement would be the 5th and 6th.
    const r = rig({ settings: { checkerMaxRequestsPerRun: 4 } });
    r.provider.policy = unsureGroupFromJudgement;
    r.provider.redraftPolicy = () => goodRedraft();
    const out = await r.svc.check(input(rubricOf([...ordinaryRules(3), bar()], null)));
    assert.equal(out.ok, false);
    if (out.ok) return;
    assert.deepEqual(out.reasonCodes, ["checker_capped"]);
    assert.ok(r.provider.requests.length <= 4);
    assert.equal(out.protectedFailures?.[0].repair.status, "attempt_unfinished");
  });

  test("the input-size cap covers the re-draft", async () => {
    const rules = [...ordinaryRules(3), bar()];
    // Measure what the checks alone send (repair off), then allow just a little more: not enough for a re-draft.
    const probe = rig({ settings: { repairMaxRulesPerRun: 0 } });
    probe.provider.policy = unsureGroupFromJudgement;
    await probe.svc.check(input(rubricOf(rules, null)));
    const checksOnly = [...probe.ledger.docs.values()][0].usage.inputChars;

    const r = rig({ settings: { checkerMaxInputCharsPerRun: checksOnly + 1_000 } });
    r.provider.policy = unsureGroupFromJudgement;
    r.provider.redraftPolicy = () => goodRedraft();
    const out = await r.svc.check(input(rubricOf(rules, null)));
    assert.equal(out.ok, false);
    if (out.ok) return;
    assert.deepEqual(out.reasonCodes, ["checker_capped"]);
    assert.equal(repairRequests(r.provider).length, 0);
    assert.equal(out.protectedFailures?.[0].repair.status, "attempt_unfinished");
  });
});

// ============================================
// Idempotency
// ============================================

describe("one attempt per rule, however often the run repeats (#223)", () => {
  test("a re-run of the same version (a re-delivered trigger, an admin re-run) makes ZERO requests and gives the same outcome", async () => {
    const r = rig();
    r.provider.policy = (ctx) => (ctx.rule.title === "Original bar 1" ? unsureGroupFromJudgement(ctx) : undefined);
    r.provider.redraftPolicy = () => goodRedraft();
    const rubric = rubricOf([...ordinaryRules(12), bar()], null);
    const first = await r.svc.check(input(rubric));
    const spent = r.provider.requests.length;
    const second = await r.svc.check(input(rubric));
    assert.equal(r.provider.requests.length, spent, "no model call on the re-run");
    assert.equal(repairRequests(r.provider).length, 1);
    assert.deepEqual(withoutSpend(second), withoutSpend(first));
  });

  test("a held repair is never re-drafted on a re-run either (the answer is stored, the check is replayed)", async () => {
    const r = rig();
    r.provider.policy = unsureGroupFromJudgement;
    r.provider.redraftPolicy = () => goodRedraft();
    const rubric = rubricOf([...ordinaryRules(3), bar()], null);
    const first = await r.svc.check(input(rubric));
    const spent = r.provider.requests.length;
    const second = await r.svc.check(input(rubric));
    assert.equal(r.provider.requests.length, spent);
    assert.deepEqual(withoutSpend(second), withoutSpend(first));
  });

  test("an invalid or 'cannot be repaired' attempt is stored: a later run does not ask again", async () => {
    for (const policy of [() => ({ criteria: [], suspiciousPassages: [] }), () => goodRedraft(1, { quote: "Nothing like the stored text at all, sorry." })]) {
      const r = rig();
      r.provider.policy = unsureGroupFromJudgement;
      r.provider.redraftPolicy = policy;
      const rubric = rubricOf([...ordinaryRules(3), bar()], null);
      await r.svc.check(input(rubric));
      await r.svc.check(input(rubric));
      assert.equal(repairRequests(r.provider).length, 1);
    }
  });

  test("a provider failure during the re-draft is NOT an attempt: the retry (the sweep) re-drafts, once, and the run after that spends nothing", async () => {
    const provider = new ScriptedProvider();
    const ledger = new MemoryLedger();
    provider.policy = (ctx) => (ctx.rule.title === "Original bar 1" ? unsureGroupFromJudgement(ctx) : undefined);
    provider.redraftPolicy = () => goodRedraft();
    const rubric = rubricOf([...ordinaryRules(3), bar()], null);

    // Run 1: every re-draft request fails hard.
    provider.script = (_n, req) => (isRepairRequest(req) ? "hard" : undefined);
    const down = rig({ provider, ledger });
    const first = await down.svc.check(input(rubric));
    assert.equal(first.ok, false);
    if (first.ok) return;
    // Retryable reason, bar still reported.
    assert.deepEqual(first.reasonCodes, ["checker_unavailable:provider"]);
    assert.deepEqual(first.protectedRuleIds, ["crit-0101"]);
    assert.equal(first.protectedFailures?.[0].repair.status, "attempt_unfinished");
    assert.equal(ledger.docs.get("XA_xa-test__v1")?.repairs?.["crit-0101"], undefined, "nothing stored as the rule's attempt");

    // Run 2 (the sweep): the provider is back. The checks already made are reused; one re-draft; one check pair.
    provider.script = () => undefined;
    const before = provider.requests.length;
    const second = await rig({ provider, ledger }).svc.check(input(rubric));
    assert.equal(second.ok, true);
    assert.equal(provider.requests.slice(before).filter(isRepairRequest).length, 1);

    // Run 3: nothing at all.
    const after = provider.requests.length;
    const third = await rig({ provider, ledger }).svc.check(input(rubric));
    assert.equal(provider.requests.length, after);
    assert.deepEqual(withoutSpend(third), withoutSpend(second));
  });

  test("a rule that changed (another hash) is a different attempt", async () => {
    const r = rig();
    r.provider.policy = unsureGroupFromJudgement;
    await r.svc.check(input(rubricOf([...ordinaryRules(3), bar()], null)));
    await r.svc.check(input(rubricOf([...ordinaryRules(3), bar(1, { title: "Original bar 1, reworded" })], null)));
    assert.equal(repairRequests(r.provider).length, 2);
  });
});

// ============================================
// Pure helpers
// ============================================

describe("repair records and the read-side swap (#223)", () => {
  const original = bar(1);
  const replacement: AssessmentCriterion = { ...bar(1), title: "Repaired bar A", stage: "suitability" };
  const repair = (over: Partial<RubricRuleRepair> = {}): RubricRuleRepair => ({ criterionId: original.criterionId, replacement, originalRuleHash: ruleHashOf(original), runId: "r", ...over });

  test("the rule hash ignores key order and undefined fields, and changes with any content", () => {
    const a = ruleOf(1);
    const reordered = JSON.parse(JSON.stringify(Object.fromEntries(Object.entries(a).reverse()))) as AssessmentCriterion;
    assert.equal(ruleHashOf(a), ruleHashOf({ ...reordered, trigger: undefined }));
    assert.notEqual(ruleHashOf(a), ruleHashOf({ ...a, title: "Other" }));
    assert.match(ruleHashOf(a), /^[0-9a-f]{64}$/);
  });

  test("applyRuleRepairs swaps the replacement in at the original's position and drops the record", () => {
    const rubric = { criteria: [ruleOf(1), original, ruleOf(2)], ruleRepairs: [repair()] };
    const out = applyRuleRepairs(rubric);
    assert.deepEqual(out.criteria.map((c) => c.title), ["Matter 1", "Repaired bar A", "Matter 2"]);
    assert.equal("ruleRepairs" in out, false);
    // Nothing recorded = the very same object.
    const plain = { criteria: [ruleOf(1)] };
    assert.equal(applyRuleRepairs(plain), plain);
  });

  test("a bar can never be repaired away: a replacement that is not a bar, or has another id, or an ordinary rule swapped for a bar, is ignored", () => {
    const notBar: AssessmentCriterion = { ...ruleOf(1), criterionId: original.criterionId, title: "Not a bar" };
    const anotherId: AssessmentCriterion = { ...replacement, criterionId: "crit-9999" };
    const ordinary = ruleOf(7);
    // (#244) an ordinary original is swapped only for an ordinary replacement; for a bar it is ignored.
    const ordinaryBecomesBar: AssessmentCriterion = { ...replacement, criterionId: ordinary.criterionId, title: "Swapped" };
    for (const bad of [repair({ replacement: notBar }), repair({ replacement: anotherId }), repair({ criterionId: ordinary.criterionId, replacement: ordinaryBecomesBar })]) {
      const out = applyRuleRepairs({ criteria: [original, ordinary], ruleRepairs: [bad] });
      assert.deepEqual(out.criteria.map((c) => c.title), [original.title, ordinary.title]);
      assert.ok(out.criteria.some(isBar), "the bar is still in force");
    }
    // The two protected tests agree.
    for (const c of [original, ordinary, notBar]) assert.equal(isBar(c), isProtectedRule(c));
  });

  test("applyExclusions (the one read-side filter) serves the replacement; exclusions still apply to the swapped rulebook", () => {
    const rubric = { criteria: [ruleOf(1), original, ruleOf(2)], intakeQuestions: [], evidenceItems: [], excludedCriterionIds: ["crit-0001"], ruleRepairs: [repair()] };
    const served = applyExclusions(rubric as any) as any;
    assert.deepEqual(served.criteria.map((c: AssessmentCriterion) => c.title), ["Repaired bar A", "Matter 2"]);
    assert.equal("ruleRepairs" in served, false);
    // Even an id list naming the repaired bar cannot remove it.
    const named = applyExclusions({ ...rubric, excludedCriterionIds: [original.criterionId] } as any) as any;
    assert.ok(named.criteria.some((c: AssessmentCriterion) => c.title === "Repaired bar A"));
  });

  test("passageWindow: the quote's line, the lines above and below, bounded, verbatim", () => {
    const p = pageOf(3, ["Lead-in: any of the following apply:", "(a) first item", "(b) second item", "(c) third item"]);
    const index = new SnapshotQuoteIndex(p);
    const found = index.locate("Lead-in: any of the following apply:");
    assert.equal(found.ok, true);
    if (!found.ok) return;
    const w = index.passageWindow(found, 1, 2, 10_000);
    assert.equal(w.text.includes("(a) first item"), true);
    assert.equal(w.text.includes("(b) second item"), true);
    assert.equal(w.text.includes("(c) third item"), false, "two lines below only");
    assert.equal(w.text.includes("matter number 3"), true, "one line above");
    // The overall bound never cuts the quote's own line.
    const tight = index.passageWindow(found, 5, 5, 40);
    assert.equal(tight.text.includes("Lead-in: any of the following apply:"), true);
  });

  test("buildRepairRequest names every failed aspect and carries no model-written source text", () => {
    const chunk = { sourceId: "s", contentHash: "a".repeat(64), docType: "html" as const, chunkIndex: 0, chunkCount: 1, text: BAR_QUOTE };
    const req = buildRepairRequest(chunk, { rule: { title: "T", kind: "mandatory_bar", stage: "validity", quote: BAR_QUOTE }, aspects: ["stage_right", "group_matches_codes"] }, ["high"], { maxOutputTokens: 1000, timeoutMs: 1000 });
    assert.ok(req.user.includes("- stage_right:"));
    assert.ok(req.user.includes("- group_matches_codes:"));
    assert.ok(req.user.includes("empty `criteria` list"));
  });
});
