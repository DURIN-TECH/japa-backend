// ============================================
// (#440) The rule check reuses version 1's answers only when it is safe
// ============================================
//
// `RubricCheckerService.check` with `reuseFrom` (one rulebook and version pair only,
// rubric-check-reuse-pair.ts) reuses the base version's stored answers for a rule only
// when the rule and everything the model is shown are identical, the models and the
// prompt version are the same, and the answer is PROVEN by rebuilding the base version's
// own requests. These tests run version 1's check for real (scripted provider: no network,
// no model), then check version 2 with reuse and count what is sent:
//   - identical version 2: 0 requests, the same kept / left-out rules, repairs and reading;
//   - one changed character of a quote, another snapshot, a changed trigger question,
//     another model, another prompt version, a tampered or foreign record: asked again;
//   - a protected rule: both models' answers reused, or both asked again;
//   - reuse outside the one pair is held before any spend; no reuse = exactly as before;
//   - the run record says per rule what was reused or asked, with totals;
//   - `planRequests` (0 model calls) predicts exactly what the run sends.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { RubricCheckerService, type RubricCheckerRun, type RubricCheckInputShape } from "../../../src/scrapers/rubric/rubric-checker";
import { CHECK_REUSE_PAIR } from "../../../src/scrapers/rubric/rubric-check-reuse-pair";
import type { GuidanceSnapshotContent } from "../../../src/scrapers/guidance/types";
import type { AssessmentCriterion, IntakeQuestion, VisaRubric } from "../../../src/types/rubric";
import { MemoryLedger, ScriptedProvider, SRC_HASH, SRC_ID, barOf, isRepairRequest, isTriggerRequest, pageOf, ruleOf, seenRules, settingsWith, type RowPolicy } from "./checker-fakes";
import { answer, crit, criteriaWire } from "./rubric-harness";

/* eslint-disable @typescript-eslint/no-explicit-any */

const KEY = CHECK_REUSE_PAIR.routeKey;
const V1_RUN = `${KEY}__v1`;
const V2_RUN = `${KEY}__v2`;

// ---- the page: rules with DISTINCT wording (so no two read as duplicates), and a polarity sentence ----
const qt = (i: number) => `Applicants must supply tok${i}a tok${i}b tok${i}c documents before decision ${i}.`;
const POLARITY_LINE = "Applicants must show they intend to leave before the visa expires.";
const OTHER_POLARITY_LINE = "Applicants must show they will return home at the end of the visit.";
const lines = (n: number) => [...Array.from({ length: n }, (_, k) => `R${k + 1}.1 ${qt(k + 1)}`), POLARITY_LINE, OTHER_POLARITY_LINE];
const PAGE: GuidanceSnapshotContent = pageOf(0, lines(24));
// A second snapshot of the same source: the same rule lines, other text around them.
const OTHER_HASH = "b".repeat(64);
const OTHER_PAGE: GuidanceSnapshotContent = { ...pageOf(0, ["A new heading introduced in a later edition", ...lines(24)]), contentHash: OTHER_HASH };
const readSnapshot = async (_id: string, hash: string) => (hash === OTHER_HASH ? OTHER_PAGE : PAGE);

const sourceOf = (quote: string, over: Record<string, unknown> = {}) => ({ quote, sourceId: SRC_ID, url: "https://rules.example/page", contentHash: SRC_HASH, retrievedAt: "2026-11-13T00:00:00Z", ...over });
const plain = (i: number, over: Partial<AssessmentCriterion> = {}) => ruleOf(i, { source: sourceOf(qt(i)), ...over });

/** The trigger question (made up). */
const ACTIVITY: IntakeQuestion = { id: "activity", label: "Which activity will you do?", answerType: "multi_choice", options: [{ value: "alpha", label: "Activity alpha" }, { value: "beta", label: "Activity beta" }], required: true, criterionIds: [] } as unknown as IntakeQuestion;
const specialist = (i: number, anyOf: string[]) => plain(i, { applicability: "specialist", applicabilityCondition: `Only for activity ${anyOf.join(" or ")}`, trigger: { questionId: "activity", anyOf } } as any);

const PROPOSAL = (line = POLARITY_LINE) => ({ value: "immigrant_intent_penalised" as const, source: sourceOf(line) });

/** Version 1: 20 plain rules, 2 with a trigger, one bar, a stated polarity; approved. */
function version1(over: Partial<VisaRubric> = {}): VisaRubric {
  const criteria = Array.from({ length: 20 }, (_, k) => (k + 1 === 4 || k + 1 === 9 ? specialist(k + 1, ["alpha"]) : plain(k + 1)));
  criteria.push(barOf(21, { source: sourceOf(qt(21)) }));
  return { routeKey: KEY, version: 1, reviewStatus: "approved", criteria, intakeQuestions: [ACTIVITY], evidenceItems: [], intentPolarityProposal: PROPOSAL(), sourceSnapshots: [] , ...over } as unknown as VisaRubric;
}

/** Version 2 from version 1: the same content (deep copy), pending, number 2, with `edit` applied to its rules. */
function version2(v1: VisaRubric, edit: (rules: AssessmentCriterion[]) => AssessmentCriterion[] = (r) => r, over: Partial<VisaRubric> = {}): VisaRubric {
  const copy = JSON.parse(JSON.stringify(v1)) as VisaRubric;
  return { ...copy, version: 2, reviewStatus: "pending_review", criteria: edit(copy.criteria), ...over };
}

/** A scripted provider whose models can be renamed (to test "another model"). */
class Models extends ScriptedProvider {
  constructor(private readonly names: Partial<Record<string, string>> = {}) {
    super();
  }
  override modelFor(role: any): string {
    return this.names[role] ?? super.modelFor(role);
  }
}

/** One checker over a shared ledger (version 1's record stays in it). */
function rig(policy?: RowPolicy) {
  const ledger = new MemoryLedger();
  const provider = new Models();
  if (policy) provider.policy = policy;
  const svc = (p: ScriptedProvider = provider) => new RubricCheckerService({ provider: () => p, readSnapshot, loadSettings: settingsWith(), ledger, nowMs: () => Date.parse("2026-11-21T10:00:00Z"), sleep: async () => undefined });
  return { ledger, provider, svc };
}

const v1Input = (v1: VisaRubric): RubricCheckInputShape => ({ routeKey: KEY, version: 1, runId: V1_RUN, rubric: v1, codeLeftOutIds: [] });
const v2Input = (v1: VisaRubric, v2: VisaRubric): RubricCheckInputShape => ({ routeKey: KEY, version: 2, runId: V2_RUN, rubric: v2, codeLeftOutIds: [], reuseFrom: { version: 1, rubric: v1 } });

/** The rule ids a set of rule-check requests asked about (by title: titles are `Matter <i>`). */
const askedTitles = (reqs: ScriptedProvider["requests"]) => reqs.filter((q) => !isTriggerRequest(q) && !isRepairRequest(q) && (q.schema as any).properties.verdicts).flatMap((q) => seenRules(q).map((r) => r.title as string));
const polarityRequests = (reqs: ScriptedProvider["requests"]) => reqs.filter((q) => "answer" in (q.schema as any).properties);

/** Run version 1's check, then version 2's with reuse; returns both outcomes and what version 2 sent. */
async function v1ThenV2(edit?: (rules: AssessmentCriterion[]) => AssessmentCriterion[], opts: { policy?: RowPolicy; v2Over?: Partial<VisaRubric>; v2Provider?: ScriptedProvider; tamper?: (rec: RubricCheckerRun) => void; v1?: VisaRubric } = {}) {
  const r = rig(opts.policy);
  const v1 = opts.v1 ?? version1();
  const out1 = await r.svc().check(v1Input(v1));
  assert.equal(out1.ok, true, "version 1 passes its own check");
  if (opts.tamper) opts.tamper(r.ledger.docs.get(V1_RUN) as RubricCheckerRun);
  const v2 = version2(v1, edit, opts.v2Over);
  const p2 = opts.v2Provider ?? new Models();
  if (opts.policy && !opts.v2Provider) p2.policy = opts.policy;
  const plan = await r.svc(p2).planRequests(v2Input(v1, v2));
  const before = p2.requests.length;
  const out2 = await r.svc(p2).check(v2Input(v1, v2));
  return { r, v1, v2, out1, out2, plan, sent: p2.requests.slice(before), record: r.ledger.docs.get(V2_RUN) as RubricCheckerRun | undefined, provider2: p2 };
}

describe("(#440) reuse: an unchanged version asks nothing", () => {
  test("version 2 identical to version 1: 0 model requests, the same kept and left-out rules, reading and triggers", async () => {
    // Matter 3 is found wrong (left out, not re-drafted: its re-draft is refused by default); Matter 7 not confirmed.
    const policy: RowPolicy = ({ rule }) => (rule.title === "Matter 3" ? { title_faithful: "no" } : rule.title === "Matter 7" ? { kind_right: "no" } : undefined);
    const { out1, out2, sent, record, plan, r } = await v1ThenV2(undefined, { policy });
    assert.equal(sent.length, 0, "nothing is sent");
    assert.equal(out2.ok, true);
    assert.deepEqual((out2 as any).leftOut, (out1 as any).leftOut);
    assert.deepEqual((out2 as any).intentPolarity, (out1 as any).intentPolarity);
    assert.deepEqual((out2 as any).droppedTriggerIds, (out1 as any).droppedTriggerIds);
    assert.deepEqual((out2 as any).ordinaryRepairs?.records.map((x: any) => x.repair.status), (out1 as any).ordinaryRepairs?.records.map((x: any) => x.repair.status));
    // The record of version 2 says what was reused, even though nothing was sent.
    assert.ok(record, "a record is written");
    assert.equal(record.reachedModel, false, "it did not reach the model (the daily cap does not count it)");
    assert.equal(record.reuse?.totals.rulesReused, 21);
    assert.equal(record.reuse?.totals.rulesAsked, 0);
    assert.equal(record.reuse?.totals.triggersReused, 2);
    assert.equal(record.reuse?.totals.polarityReused, 2);
    assert.ok(Object.values(record.reuse?.rules ?? {}).every((l) => l.rule === "reused"));
    // The audit letters of version 2 are version 1's.
    assert.deepEqual(record.ruleVerdicts, r.ledger.docs.get(V1_RUN)?.ruleVerdicts);
    // The plan says the same before any spend: Matter 3's stored attempt (the model's "cannot be repaired") is
    // reused, so not even a re-draft is planned.
    assert.deepEqual(plan, { kind: "planned", check: 0, trigger: 0, polarity: 0, repairAtMost: 0, rulesRead: 21, reuse: record.reuse });
  });

  test("a rule version 1 re-drafted is not re-drafted or re-checked again: its stored replacement and check are reused", async () => {
    const r = rig(({ rule }) => (rule.title === "Matter 5" ? { title_faithful: "no" } : undefined));
    r.provider.redraftPolicy = ({ shown }: any) => criteriaWire(answer({ criteria: [crit({ ref: "r1", title: `Repaired ${shown.title}`, kind: shown.kind, stage: shown.stage, quote: shown.quote, probeFactors: ["a factor"] } as any)] }));
    const v1 = version1();
    const out1 = (await r.svc().check(v1Input(v1))) as any;
    assert.equal(out1.repairs?.[0]?.criterionId, "crit-0005", "version 1 repaired Matter 5");
    const p2 = new Models();
    p2.policy = r.provider.policy;
    const out2 = (await r.svc(p2).check(v2Input(v1, version2(v1)))) as any;
    assert.equal(p2.requests.length, 0, "no re-draft and no check of the replacement");
    assert.deepEqual(out2.repairs, out1.repairs.map((x: any) => ({ ...x, runId: V2_RUN })));
    assert.equal(r.ledger.docs.get(V2_RUN)?.reuse?.totals.repairChecksCarried, 1);
  });
});

describe("(#440) reuse: anything that changed is asked again", () => {
  test("one character of one rule's quote changed: only that rule is asked; the others are reused", async () => {
    // The quote without its final full stop is still in the snapshot (one character less).
    const { sent, record, plan } = await v1ThenV2((rules) => rules.map((c) => (c.criterionId === "crit-0002" ? { ...c, source: { ...c.source, quote: qt(2).slice(0, -1) } } : c)));
    assert.deepEqual(askedTitles(sent), ["Matter 2"]);
    assert.equal(sent.length, 1);
    assert.deepEqual(record?.reuse?.rules["crit-0002"], { rule: "asked", reason: "rule_changed" });
    assert.equal(record?.reuse?.totals.rulesReused, 20);
    assert.equal(plan.kind === "planned" && plan.check, 1);
  });

  test("the same rule citing another snapshot (a different contentHash and window): asked again", async () => {
    const { sent, record } = await v1ThenV2((rules) => rules.map((c) => (c.criterionId === "crit-0006" ? { ...c, source: { ...c.source, contentHash: OTHER_HASH } } : c)));
    assert.deepEqual(askedTitles(sent), ["Matter 6"]);
    assert.equal(record?.reuse?.rules["crit-0006"].reason, "rule_changed");
  });

  test("a rule identical but its trigger question's wording changed: the rule and its trigger are asked again", async () => {
    const reworded = { ...ACTIVITY, label: "Which activity will you take part in?" };
    const { sent, record } = await v1ThenV2(undefined, { v2Over: { intakeQuestions: [reworded] } as any });
    // Both rules that read the question (Matter 4 and 9) are shown its wording: both asked, rule and trigger.
    assert.deepEqual(askedTitles(sent).sort(), ["Matter 4", "Matter 9"]);
    assert.equal(sent.filter(isTriggerRequest).length, 1);
    assert.deepEqual(record?.reuse?.rules["crit-0004"], { rule: "asked", reason: "view_changed", trigger: "asked", triggerReason: "rule_asked" });
    assert.equal(record?.reuse?.totals.rulesReused, 19);
  });

  test("another model id: everything is asked again", async () => {
    const { sent, record } = await v1ThenV2(undefined, { v2Provider: new Models({ verification: "another-verification-model" }) });
    // Every ordinary rule (verification) is asked; the bar needs both models, so it is asked by both.
    assert.equal(askedTitles(sent).length, 21 + 1);
    assert.ok(Object.values(record?.reuse?.rules ?? {}).every((l) => l.rule === "asked" && l.reason === "model_changed"));
    // The polarity reading of the verification model is asked again; the judgement model's is reused.
    assert.equal(polarityRequests(sent).length, 1);
  });

  test("another checker prompt version on the record: everything is asked again", async () => {
    const { sent, record } = await v1ThenV2(undefined, { tamper: (rec) => void (rec.promptVersion = "2026-01-checker-v0") });
    assert.equal(askedTitles(sent).length, 21 + 1);
    assert.ok(Object.values(record?.reuse?.rules ?? {}).every((l) => l.reason === "prompt_version_changed"));
    assert.equal(polarityRequests(sent).length, 2);
  });

  test("a stored answer that does not match its audit letters (tampered) is not reused", async () => {
    const { sent, record } = await v1ThenV2(undefined, {
      tamper: (rec) => {
        // Flip the first ordinary rule's stored letters in its batch answer; the audit letters say otherwise.
        const batch = Object.values(rec.responses).find((x) => x.rows && x.role === "verification" && Object.keys(x.rows).length === 10) as any;
        batch.rows.r1 = "yyyyyy" === batch.rows.r1 ? "nyyyyy" : "yyyyyy";
      },
    });
    assert.deepEqual(askedTitles(sent), ["Matter 1"]);
    assert.equal(record?.reuse?.rules["crit-0001"].reason, "base_answer_mismatch");
  });

  test("an answer stored under a hash that no request rebuilt from version 1 has is never read", async () => {
    const { sent, record } = await v1ThenV2(undefined, {
      tamper: (rec) => {
        // Move every rule-batch answer to a hash of nothing: the answers are there, but no rebuilt request finds them.
        for (const [h, x] of Object.entries(rec.responses)) {
          if (!x.rows) continue;
          delete rec.responses[h];
          rec.responses[`f${h.slice(1)}`] = x;
        }
      },
    });
    assert.equal(askedTitles(sent).length, 21 + 1);
    assert.ok(Object.values(record?.reuse?.rules ?? {}).every((l) => l.rule === "asked" && l.reason === "no_base_answer"));
  });

  test("a record that is not version 1's own (another version or rulebook) is not reused at all", async () => {
    const { sent, record } = await v1ThenV2(undefined, { tamper: (rec) => void (rec.version = 3) });
    assert.equal(askedTitles(sent).length, 21 + 1);
    assert.ok(Object.values(record?.reuse?.rules ?? {}).every((l) => l.reason === "base_record_mismatch"));
    assert.equal(polarityRequests(sent).length, 2);
  });

  test("the intention-to-stay reading is reused only for the same quote", async () => {
    const { sent } = await v1ThenV2(undefined, { v2Over: { intentPolarityProposal: PROPOSAL(OTHER_POLARITY_LINE) } as any });
    assert.equal(polarityRequests(sent).length, 2);
    assert.equal(askedTitles(sent).length, 0);
  });
});

describe("(#440) reuse: protected rules need both models", () => {
  test("an unchanged protected rule reuses both models' answers", async () => {
    const { sent, record } = await v1ThenV2();
    assert.equal(sent.length, 0);
    assert.deepEqual(record?.ruleVerdicts["crit-0021"] && Object.keys(record.ruleVerdicts["crit-0021"]).sort(), ["judgement", "verification"]);
    assert.equal(record?.reuse?.rules["crit-0021"].rule, "reused");
  });

  test("a protected rule that changed is asked by both models again", async () => {
    const { sent, record } = await v1ThenV2((rules) => rules.map((c) => (c.criterionId === "crit-0021" ? { ...c, severity: "critical" } : c)));
    const roles = sent.filter((q) => (q.schema as any).properties.verdicts && !isTriggerRequest(q)).map((q) => `${q.role}:${seenRules(q).map((x) => x.title).join(",")}`).sort();
    assert.deepEqual(roles, ["judgement:Matter 21", "verification:Matter 21"]);
    assert.equal(record?.reuse?.rules["crit-0021"].reason, "rule_changed");
  });
});

describe("(#440) reuse is for one rulebook and one pair of versions, named on the call", () => {
  test("another rulebook, or other versions, are held before any spend", async () => {
    const { svc, provider } = rig();
    const v1 = version1();
    const v2 = version2(v1);
    const other = { ...v2, routeKey: "QM_route-one" } as VisaRubric;
    const held = await svc().check({ routeKey: "QM_route-one", version: 2, runId: "QM_route-one__v2", rubric: other, codeLeftOutIds: [], reuseFrom: { version: 1, rubric: { ...v1, routeKey: "QM_route-one" } } });
    assert.deepEqual(held, { ok: false, reasonCodes: ["checker_reuse_refused:rulebook_not_allowed"] });
    const v3 = await svc().check({ routeKey: KEY, version: 3, runId: `${KEY}__v3`, rubric: { ...v2, version: 3 }, codeLeftOutIds: [], reuseFrom: { version: 2, rubric: { ...v2, reviewStatus: "approved" } } });
    assert.deepEqual(v3, { ok: false, reasonCodes: ["checker_reuse_refused:version_not_allowed"] });
    const pending = await svc().check({ ...v2Input(v1, v2), reuseFrom: { version: 1, rubric: { ...v1, reviewStatus: "pending_review" } } });
    assert.deepEqual(pending, { ok: false, reasonCodes: ["checker_reuse_refused:base_not_approved"] });
    const missing = await svc().check({ ...v2Input(v1, v2), reuseFrom: { version: 1, rubric: null as any } });
    assert.deepEqual(missing, { ok: false, reasonCodes: ["checker_reuse_refused:base_mismatch"] });
    assert.equal(provider.requests.length, 0);
  });

  test("without reuseFrom the check of version 2 asks everything, exactly as before", async () => {
    const r = rig();
    const v1 = version1();
    await r.svc().check(v1Input(v1));
    const p2 = new Models();
    const { reuseFrom: _no, ...plain2 } = v2Input(v1, version2(v1));
    void _no;
    await r.svc(p2).check(plain2);
    // 20 ordinary rules in 2 batches, the bar by both models, 2 polarity readings, 1 trigger batch.
    assert.equal(p2.requests.length, 2 + 2 + 2 + 1);
    assert.equal(r.ledger.docs.get(V2_RUN)?.reuse, undefined, "no reuse account on a plain check");
  });
});
