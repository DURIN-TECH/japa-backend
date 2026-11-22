// ============================================
// (#461) Rule-check reuse across a chain: version 1 -> 2 -> 3
// ============================================
//
// Version 2 of the shared rulebook was checked with reuse from version 1, so its record
// holds only the answers it ASKED for (the rules it changed), plus letters for the rest.
// Version 3 is a same-rules copy of version 2. Its check reuses from version 2, and for a
// rule version 2 itself reused, the proof follows version 2's reuse account ONE hop back to
// version 1 (`reuseFrom.via`). These tests run version 1's and version 2's checks for real
// (scripted provider: no network, no model), then check version 3 and count what is sent:
//   - version 3 identical to version 2: 0 requests, the same kept and left-out rules;
//   - a rule version 2 asked about, then changed in version 3: asked;
//   - a rule version 2 reused, with version 1's stored answer tampered: asked;
//   - version 2's audit letters disagreeing with version 1's answer: asked;
//   - another model, or another checker prompt version: everything asked;
//   - a two-hop chain (version 1 itself a reuse), or a base account naming another run: not followed;
//   - a missing version 1 record: the rules version 2 reused are asked;
//   - the step 2 -> 3 without `via` is refused before any spend.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { RubricCheckerService, type RubricCheckerRun, type RubricCheckInputShape } from "../../../src/scrapers/rubric/rubric-checker";
import { CHECK_REUSE_PAIR_V3, CHECK_REUSE_PAIRS } from "../../../src/services/rubric-check-reuse-pair";
import type { GuidanceSnapshotContent } from "../../../src/scrapers/guidance/types";
import type { AssessmentCriterion, IntakeQuestion, VisaRubric } from "../../../src/types/rubric";
import { MemoryLedger, ScriptedProvider, SRC_HASH, SRC_ID, barOf, isRepairRequest, isTriggerRequest, pageOf, ruleOf, seenRules, settingsWith, type RowPolicy } from "./checker-fakes";
import { answer, crit, criteriaWire } from "./rubric-harness";

/* eslint-disable @typescript-eslint/no-explicit-any */

const KEY = CHECK_REUSE_PAIR_V3.routeKey;
const RUN = (v: number) => `${KEY}__v${v}`;

// ---- the page (made-up words): distinct rule lines and a polarity sentence ----
const qt = (i: number) => `Applicants must supply tok${i}a tok${i}b tok${i}c documents before decision ${i}.`;
const POLARITY_LINE = "Applicants must show they intend to leave before the visa expires.";
const PAGE: GuidanceSnapshotContent = pageOf(0, [...Array.from({ length: 24 }, (_, k) => `R${k + 1}.1 ${qt(k + 1)}`), POLARITY_LINE]);
const readSnapshot = async () => PAGE;
const sourceOf = (quote: string) => ({ quote, sourceId: SRC_ID, url: "https://rules.example/page", contentHash: SRC_HASH, retrievedAt: "2026-11-13T00:00:00Z" });
const plain = (i: number, over: Partial<AssessmentCriterion> = {}) => ruleOf(i, { source: sourceOf(qt(i)), ...over });
const ACTIVITY: IntakeQuestion = { id: "activity", label: "Which activity will you do?", answerType: "multi_choice", options: [{ value: "alpha", label: "Activity alpha" }, { value: "beta", label: "Activity beta" }], required: true, criterionIds: [] } as unknown as IntakeQuestion;
const specialist = (i: number) => plain(i, { applicability: "specialist", applicabilityCondition: "Only for activity alpha", trigger: { questionId: "activity", anyOf: ["alpha"] } } as any);

/** Version 1: 20 plain rules (4 and 9 with a trigger), one bar, a stated polarity; approved. */
function version1(): VisaRubric {
  const criteria = Array.from({ length: 20 }, (_, k) => (k + 1 === 4 || k + 1 === 9 ? specialist(k + 1) : plain(k + 1)));
  criteria.push(barOf(21, { source: sourceOf(qt(21)) }));
  return { routeKey: KEY, version: 1, reviewStatus: "approved", criteria, intakeQuestions: [ACTIVITY], evidenceItems: [], intentPolarityProposal: { value: "immigrant_intent_penalised", source: sourceOf(POLARITY_LINE) }, sourceSnapshots: [] } as unknown as VisaRubric;
}
/** A deep copy of `from` as version `n` with `edit` applied to its rules. */
function copyAs(from: VisaRubric, n: number, status: string, edit: (rules: AssessmentCriterion[]) => AssessmentCriterion[] = (r) => r): VisaRubric {
  const c = JSON.parse(JSON.stringify(from)) as VisaRubric;
  return { ...c, version: n, reviewStatus: status as any, criteria: edit(c.criteria) };
}
// Version 2 changed rule 2's quote (one character less): version 2 ASKED about rule 2 and reused the rest.
const v2Edit = (rules: AssessmentCriterion[]) => rules.map((c) => (c.criterionId === "crit-0002" ? { ...c, source: { ...c.source, quote: qt(2).slice(0, -1) } } : c));

/** A scripted provider whose models can be renamed. */
class Models extends ScriptedProvider {
  constructor(private readonly names: Partial<Record<string, string>> = {}) {
    super();
  }
  override modelFor(role: any): string {
    return this.names[role] ?? super.modelFor(role);
  }
}

// Matter 3 found wrong (left out; its re-draft refused by default). Matter 5 found wrong and re-drafted on version 1.
const POLICY: RowPolicy = ({ rule }) => (rule.title === "Matter 3" || rule.title === "Matter 5" ? { title_faithful: "no" } : undefined);
const REDRAFT = ({ shown }: any) => (shown.title === "Matter 5" ? criteriaWire(answer({ criteria: [crit({ ref: "r1", title: `Repaired ${shown.title}`, kind: shown.kind, stage: shown.stage, quote: shown.quote, probeFactors: ["a factor"] } as any)] })) : { criteria: [], suspiciousPassages: [] });
const provider = (names?: Partial<Record<string, string>>) => {
  const p = new Models(names);
  p.policy = POLICY;
  p.redraftPolicy = REDRAFT;
  return p;
};

/** The rule-check requests' rule titles (not triggers, not re-drafts, not polarity). */
const askedTitles = (reqs: ScriptedProvider["requests"]) => reqs.filter((q) => !isTriggerRequest(q) && !isRepairRequest(q) && (q.schema as any).properties.verdicts).flatMap((q) => seenRules(q).map((r) => r.title as string));

/**
 * Check version 1 (plain), then version 2 (reuse from 1), then version 3 (reuse from 2 via 1). `between` may
 * tamper with the ledger before version 3; `v3Edit` changes version 3's rules; `input3` overrides its input.
 */
async function chain(opts: { between?: (ledger: MemoryLedger) => void; v3Edit?: (rules: AssessmentCriterion[]) => AssessmentCriterion[]; v3Provider?: ScriptedProvider; input3?: (i: RubricCheckInputShape) => RubricCheckInputShape } = {}) {
  const ledger = new MemoryLedger();
  const svc = (p: ScriptedProvider) => new RubricCheckerService({ provider: () => p, readSnapshot, loadSettings: settingsWith(), ledger, nowMs: () => Date.parse("2026-11-22T10:00:00Z"), sleep: async () => undefined });
  const v1 = version1();
  const out1 = (await svc(provider()).check({ routeKey: KEY, version: 1, runId: RUN(1), rubric: v1, codeLeftOutIds: [] })) as any;
  assert.equal(out1.ok, true);
  const v2 = copyAs(v1, 2, "pending_review", v2Edit);
  const p2 = provider();
  const out2 = (await svc(p2).check({ routeKey: KEY, version: 2, runId: RUN(2), rubric: v2, codeLeftOutIds: [], reuseFrom: { version: 1, rubric: v1 } })) as any;
  assert.equal(out2.ok, true);
  // Version 2 asked rule 2 only (and the re-draft of nothing: Matter 5's stored replacement and check were carried).
  assert.deepEqual(askedTitles(p2.requests), ["Matter 2"]);
  if (opts.between) opts.between(ledger);
  const v2approved = { ...v2, reviewStatus: "approved" } as VisaRubric;
  const v3 = copyAs(v2approved, 3, "pending_review", opts.v3Edit);
  let input: RubricCheckInputShape = { routeKey: KEY, version: 3, runId: RUN(3), rubric: v3, codeLeftOutIds: [], reuseFrom: { version: 2, rubric: v2approved, via: { version: 1, rubric: v1 } } };
  if (opts.input3) input = opts.input3(input);
  const p3 = opts.v3Provider ?? provider();
  const plan = await svc(p3).planRequests(input);
  const before = p3.requests.length;
  const out3 = (await svc(p3).check(input)) as any;
  return { ledger, out1, out2, out3, plan, sent: p3.requests.slice(before), v2rec: ledger.docs.get(RUN(2)) as RubricCheckerRun, record: ledger.docs.get(RUN(3)) as RubricCheckerRun | undefined };
}

describe("(#461) the pairs", () => {
  test("v1 -> v2 is kept and v2 -> v3 (via v1) is added, for the one rulebook only", () => {
    assert.deepEqual(CHECK_REUSE_PAIRS.map((p) => [p.routeKey, p.fromVersion, p.toVersion, p.viaVersion]), [
      [KEY, 1, 2, undefined],
      [KEY, 2, 3, 1],
    ]);
  });
});

describe("(#461) version 3 identical to version 2", () => {
  test("0 rule-check requests, the same kept and left-out rules, triggers, reading and carried re-draft", async () => {
    const { out2, out3, sent, plan, record, v2rec } = await chain();
    assert.equal(v2rec.reuse?.totals.rulesAsked, 1, "version 2 asked rule 2 only");
    assert.equal(sent.length, 0, "nothing is sent");
    assert.equal(out3.ok, true);
    assert.deepEqual(out3.leftOut, out2.leftOut);
    assert.deepEqual(out3.intentPolarity, out2.intentPolarity);
    assert.deepEqual(out3.droppedTriggerIds, out2.droppedTriggerIds);
    assert.deepEqual(out3.repairs, out2.repairs.map((x: any) => ({ ...x, runId: RUN(3) })));
    assert.ok(record?.reuse);
    assert.deepEqual(record.reuse.via, { version: 1, runId: RUN(1) });
    assert.equal(record.reuse.totals.rulesReused, 21);
    assert.equal(record.reuse.totals.rulesAsked, 0);
    assert.equal(record.reuse.totals.triggersReused, 2);
    assert.equal(record.reuse.totals.polarityReused, 2);
    assert.equal(record.reuse.totals.repairsCarried, v2rec.reuse?.totals.repairsCarried);
    assert.equal(record.reuse.totals.repairChecksCarried, 1, "Matter 5's replacement keeps its check, proven on version 1");
    assert.deepEqual(record.ruleVerdicts, v2rec.ruleVerdicts, "the audit letters are version 2's");
    // The plan says the same before any spend.
    assert.equal(plan.kind, "planned");
    assert.deepEqual(plan.kind === "planned" && [plan.check, plan.trigger, plan.polarity], [0, 0, 0]);
  });
});

describe("(#461) anything not proven along the chain is asked", () => {
  test("a rule version 2 asked about, then changed in version 3: asked", async () => {
    const { sent, record } = await chain({ v3Edit: (rules) => rules.map((c) => (c.criterionId === "crit-0002" ? { ...c, source: { ...c.source, quote: qt(2) } } : c)) });
    assert.deepEqual(askedTitles(sent), ["Matter 2"]);
    assert.deepEqual(record?.reuse?.rules["crit-0002"], { rule: "asked", reason: "rule_changed" });
    assert.equal(record?.reuse?.totals.rulesReused, 20);
  });

  test("a rule version 2 reused, with version 1's stored answer tampered: asked", async () => {
    const { sent, record } = await chain({
      between: (ledger) => {
        const rec = ledger.docs.get(RUN(1)) as RubricCheckerRun;
        // Flip rule 1's letters in version 1's batch answer; version 1's audit letters say otherwise.
        const batch = Object.values(rec.responses).find((x) => x.rows && x.role === "verification" && Object.keys(x.rows).length === 10) as any;
        batch.rows.r1 = batch.rows.r1 === "yyyyyy" ? "nyyyyy" : "yyyyyy";
      },
    });
    assert.deepEqual(askedTitles(sent), ["Matter 1"]);
    assert.equal(record?.reuse?.rules["crit-0001"].reason, "base_answer_mismatch");
  });

  test("version 2's audit letters disagreeing with version 1's answer: asked", async () => {
    const { sent, record } = await chain({
      between: (ledger) => {
        const rec = ledger.docs.get(RUN(2)) as RubricCheckerRun;
        const cur = rec.ruleVerdicts["crit-0006"].verification as string;
        rec.ruleVerdicts["crit-0006"].verification = cur === "yyyyyy" ? "nyyyyy" : "yyyyyy";
      },
    });
    assert.deepEqual(askedTitles(sent), ["Matter 6"]);
    assert.equal(record?.reuse?.rules["crit-0006"].reason, "base_answer_mismatch");
  });

  test("another model id: everything is asked", async () => {
    const { sent, record } = await chain({ v3Provider: provider({ verification: "another-verification-model" }) });
    assert.equal(askedTitles(sent).filter((t) => !t.startsWith("Repaired")).length >= 21, true);
    assert.ok(Object.values(record?.reuse?.rules ?? {}).every((l) => l.rule === "asked" && l.reason === "model_changed"));
  });

  test("another checker prompt version on version 2's record: everything is asked", async () => {
    const { record } = await chain({ between: (ledger) => void ((ledger.docs.get(RUN(2)) as RubricCheckerRun).promptVersion = "2026-01-checker-v0") });
    assert.ok(Object.values(record?.reuse?.rules ?? {}).every((l) => l.rule === "asked" && l.reason === "prompt_version_changed"));
  });

  test("another checker prompt version on version 1's record: the rules version 2 reused are asked, its own are not", async () => {
    const { record } = await chain({ between: (ledger) => void ((ledger.docs.get(RUN(1)) as RubricCheckerRun).promptVersion = "2026-01-checker-v0") });
    assert.equal(record?.reuse?.rules["crit-0002"].rule, "reused", "version 2's own answer is proven on version 2");
    const others = Object.entries(record?.reuse?.rules ?? {}).filter(([id]) => id !== "crit-0002");
    assert.ok(others.every(([, l]) => l.rule === "asked" && l.reason === "prompt_version_changed"));
  });

  test("a two-hop chain is not followed: version 1's record itself a reuse", async () => {
    const { record } = await chain({
      between: (ledger) => {
        const rec = ledger.docs.get(RUN(1)) as RubricCheckerRun;
        rec.reuse = { fromVersion: 0, fromRunId: RUN(0), rules: Object.fromEntries(Object.keys(rec.ruleVerdicts).map((id) => [id, { rule: "reused" as const }])), totals: { rulesReused: 0, rulesAsked: 0, triggersReused: 0, triggersAsked: 0, polarityReused: 0, repairsCarried: 0, repairChecksCarried: 0 } };
      },
    });
    const others = Object.entries(record?.reuse?.rules ?? {}).filter(([id]) => id !== "crit-0002");
    assert.ok(others.length === 20 && others.every(([, l]) => l.rule === "asked" && l.reason === "no_base_answer"));
  });

  test("a base account naming another run is not followed", async () => {
    const { record } = await chain({ between: (ledger) => void ((ledger.docs.get(RUN(2)) as RubricCheckerRun).reuse!.fromRunId = RUN(0)) });
    const others = Object.entries(record?.reuse?.rules ?? {}).filter(([id]) => id !== "crit-0002");
    assert.ok(others.every(([, l]) => l.rule === "asked" && l.reason === "hop_not_allowed"));
    assert.equal(record?.reuse?.via, undefined);
  });

  test("a missing version 1 record: the rules version 2 reused are asked", async () => {
    const { record } = await chain({ between: (ledger) => void ledger.docs.delete(RUN(1)) });
    assert.equal(record?.reuse?.rules["crit-0002"].rule, "reused");
    const others = Object.entries(record?.reuse?.rules ?? {}).filter(([id]) => id !== "crit-0002");
    assert.ok(others.every(([, l]) => l.rule === "asked" && l.reason === "base_record_missing"));
  });

  test("the step 2 -> 3 without `via`, or with another `via`, is refused before any spend", async () => {
    const noVia = await chain({ input3: (i) => ({ ...i, reuseFrom: { version: 2, rubric: i.reuseFrom!.rubric } }) });
    assert.deepEqual(noVia.out3, { ok: false, reasonCodes: ["checker_reuse_refused:via_mismatch"] });
    assert.equal(noVia.sent.length, 0);
    const pendingVia = await chain({ input3: (i) => ({ ...i, reuseFrom: { ...i.reuseFrom!, via: { version: 1, rubric: { ...i.reuseFrom!.via!.rubric, reviewStatus: "pending_review" } as VisaRubric } } }) });
    assert.deepEqual(pendingVia.out3, { ok: false, reasonCodes: ["checker_reuse_refused:via_not_approved"] });
  });
});
