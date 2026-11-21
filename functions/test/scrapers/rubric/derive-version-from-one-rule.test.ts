// ============================================
// (#440) Version 2 from version 1 plus a one-rule result: build, refusals, plan
// ============================================
//
// `scripts/derive-version-from-one-rule.ts` builds version 2 of the shared Schengen
// short-stay rulebook from its approved version 1 and the `--out` file of
// `redraft-competence-rule`, without a model call. These tests prove:
//  - version 2 differs from version 1 ONLY in the re-drafted rule, the competence
//    block, the questions the block needs and the re-read cut lists (compared rule
//    by rule); a re-read list is kept only when it proves against the snapshot, and
//    a list that cannot be proven leaves the rule exactly as in version 1;
//  - version 2 is a pristine pending draft (no approval field of version 1);
//  - every refusal stops with its code word and builds nothing;
//  - the dry run prints ids, counts and code words only;
//  - on a fixture shaped like today's version 1 (one re-drafted rule, cut lists
//    re-read, the rest unchanged) the planned rule-check requests are only the
//    changed rules' batch, and a check of version 2 with the fake provider sends
//    exactly that.
// The page is the stored Visa Code text (fixtures copied by code) plus made-up lines;
// every title and question is made up. No model, no network, no project.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { deriveVersion, keptResultOf, planLines, projectProblem, rulesThatDiffer, runDerive, type DeriveRunDeps } from "../../../src/scrapers/rubric/scripts/derive-version-from-one-rule";
import { RubricCheckerService, viewOf } from "../../../src/scrapers/rubric/rubric-checker";
import { lexiconFor } from "../../../src/scrapers/language/language-lexicon";
import { SnapshotQuoteIndex } from "../../../src/scrapers/rubric/rubric-quote";
import { readLeadInList } from "../../../src/scrapers/rubric/rubric-list-items";
import { RUBRIC_REVIEW_FIELDS, type AssessmentCriterion, type RubricHead, type VisaRubric } from "../../../src/types/rubric";
import { MemoryLedger, ScriptedProvider, isTriggerRequest, seenRules, settingsWith } from "./checker-fakes";
import { DEFAULT_PUBLISH_SETTINGS, type LoadedPublishSettings } from "../../../src/scrapers/rubric/rubric-publish-settings";
import { DESTINATIONS, HEAD, ID, KEY, LEAD25, LEAD32, LEAD5, PAGE, PLAIN, POLARITY_LINE, UNREADABLE, outFor, version1 } from "./derive-version-fixtures";

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Run deps over a head and nothing else (no plan, no store) that collect the printed lines. */
function depsOf(head: RubricHead | null, extra: Partial<DeriveRunDeps> = {}): DeriveRunDeps & { lines: string[] } {
  const lines: string[] = [];
  return { readHead: async () => head, now: () => "now", print: (l) => lines.push(l), lines, ...extra };
}

describe("(#440) building version 2", () => {
  test("version 2 differs from version 1 only in the re-drafted rule, the block, its questions and the re-read lists", async () => {
    const v1 = version1();
    const out = await outFor(v1);
    const built = deriveVersion(v1, out, PAGE);
    assert.ok(built.ok, built.ok ? "" : built.refusal);
    // One line per changed rule, with why.
    assert.deepEqual(built.changes, [
      { criterionId: ID, why: "redrafted" },
      { criterionId: "crit_list_25", why: "list_reread" },
      { criterionId: "crit_list_32", why: "list_reread" },
    ]);
    assert.deepEqual(built.notProven, ["crit_unreadable"]);
    assert.equal(built.notProvenWhy.crit_unreadable, "unreadable:line_after_item_not_recognised");
    assert.equal(built.unchanged, 21);
    // Rule by rule: only those three differ, and every other rule is byte-identical.
    assert.deepEqual(rulesThatDiffer(v1, built.draft as VisaRubric).sort(), [ID, "crit_list_25", "crit_list_32"].sort());
    for (const c of v1.criteria) {
      if ([ID, "crit_list_25", "crit_list_32"].includes(c.criterionId)) continue;
      assert.equal(JSON.stringify(built.draft.criteria.find((x) => x.criterionId === c.criterionId)), JSON.stringify(c), c.criterionId);
    }
    // The re-drafted rule is the `--out` file's rule (only its question links can be re-pointed, here none).
    assert.deepEqual(built.draft.criteria.find((x) => x.criterionId === ID), out.rule);
    // A re-read rule differs ONLY in its list lines, which are the ones code reads from the page.
    const index = new SnapshotQuoteIndex(PAGE);
    for (const id of ["crit_list_25", "crit_list_32"]) {
      const before = v1.criteria.find((x) => x.criterionId === id) as AssessmentCriterion;
      const after = built.draft.criteria.find((x) => x.criterionId === id) as AssessmentCriterion;
      const read = readLeadInList(index, index.locate(before.source.quote) as any);
      assert.equal(read.kind, "items");
      assert.deepEqual(after.source.listItems, (read as any).items);
      assert.ok((after.source.listItems ?? []).length > 1);
      assert.deepEqual({ ...after, source: { ...after.source, listItems: undefined } }, { ...before, source: { ...before.source, listItems: undefined } });
    }
    // The block and the questions it needs come from the `--out` file; version 1's questions are kept as they are.
    assert.deepEqual(built.draft.competence, out.competence);
    assert.deepEqual(built.draft.intakeQuestions.slice(0, 1), v1.intakeQuestions);
    assert.deepEqual(built.draft.intakeQuestions.slice(1), out.intakeQuestions);
    assert.equal(built.questionsAdded, 3);
  });

  test("version 2 is a pristine pending draft: no review or approval field of version 1 is carried over", async () => {
    const built = deriveVersion(version1(), await outFor(), PAGE);
    assert.ok(built.ok);
    const d = built.draft as any;
    assert.equal(d.reviewStatus, "pending_review");
    for (const [f, v] of Object.entries({ intentPolarity: null, reviewedBy: null, reviewedAt: null, rejectReason: null, revision: 0, supersededAt: null })) assert.equal(d[f], v, f);
    for (const f of RUBRIC_REVIEW_FIELDS) if (!["reviewStatus", "intentPolarity", "reviewedBy", "reviewedAt", "rejectReason", "revision", "supersededAt"].includes(f)) assert.equal(d[f], undefined, f);
    assert.equal(d.version, undefined, "the store numbers it");
    assert.equal(d.createdAt, undefined, "the write stamps it");
    // Content and provenance stay version 1's (the same snapshots: the same source set hash).
    assert.equal(d.sourceSetHash, "c".repeat(64));
    assert.deepEqual(d.intentPolarityProposal, version1().intentPolarityProposal);
  });

  test("a question version 1 already asks is reused, not copied: the block and the rule point at version 1's question", async () => {
    const out = await outFor();
    // Version 1 (as stored) already asks the block's first question, word for word.
    const asked = { ...out.intakeQuestions[0], id: "where_going", criterionIds: ["crit_plain_01"] };
    const v1 = version1({ intakeQuestions: [DESTINATIONS, asked] } as any);
    const built = deriveVersion(v1, out, PAGE);
    assert.ok(built.ok, built.ok ? "" : built.refusal);
    assert.equal(built.draft.intakeQuestions.filter((q) => q.label === asked.label).length, 1, "no copy");
    assert.equal(built.draft.competence?.steps[0].questionId, "where_going");
    const r = built.draft.criteria.find((x) => x.criterionId === ID) as AssessmentCriterion;
    assert.ok(r.intakeQuestionIds?.includes("where_going") && !r.intakeQuestionIds.includes(out.intakeQuestions[0].id));
  });
});

describe("(#440) refusals: the script stops with a code word and builds nothing", () => {
  test("the snapshot is not what it says or not what the rules cite", async () => {
    const out = await outFor();
    assert.deepEqual(deriveVersion(version1(), out, { ...PAGE, text: `${PAGE.text} ` }), { ok: false, refusal: "snapshot_hash_mismatch" });
    const elsewhere = version1();
    elsewhere.criteria[5] = { ...elsewhere.criteria[5], source: { ...elsewhere.criteria[5].source, contentHash: "d".repeat(64) } };
    assert.deepEqual(deriveVersion(elsewhere, out, PAGE), { ok: false, refusal: "snapshot_not_cited" });
  });

  test("the --out file is not a kept result", async () => {
    const out = await outFor();
    const v1 = version1();
    assert.deepEqual(deriveVersion(v1, { ...out, rule: null, competence: null }, PAGE), { ok: false, refusal: "out_not_kept:no_result" });
    assert.deepEqual(deriveVersion(v1, { ...out, liveFailed: "failed:TypeError" }, PAGE), { ok: false, refusal: "out_not_kept:live_failed" });
    assert.deepEqual(deriveVersion(v1, { ...out, checkPasses: false }, PAGE), { ok: false, refusal: "out_not_kept:check_not_passed" });
    assert.deepEqual(deriveVersion(v1, { ...out, checkPasses: null }, PAGE), { ok: false, refusal: "out_not_kept:check_not_passed" });
    assert.deepEqual(deriveVersion(v1, { ...out, competenceProblems: ["step_not_in_quote"] }, PAGE), { ok: false, refusal: "out_not_kept:competence_problems" });
    // The nested shape (`result`) is read the same way.
    assert.equal(keptResultOf({ ...out, result: null }).ok, false);
    assert.equal(keptResultOf({ ...out, result: { rule: out.rule, intakeQuestions: out.intakeQuestions, competence: out.competence } }).ok, true);
  });

  test("the result names a rule version 1 does not have, or another rulebook", async () => {
    const out = await outFor();
    const v1 = version1();
    const missing = { ...out, ruleId: "crit_missing", rule: { ...out.rule, criterionId: "crit_missing" } };
    assert.deepEqual(deriveVersion(v1, missing, PAGE), { ok: false, refusal: "out_rule_not_in_version" });
    assert.deepEqual(deriveVersion(v1, { ...out, ruleId: "crit_plain_01" }, PAGE), { ok: false, refusal: "out_rule_mismatch" });
    assert.deepEqual(deriveVersion(v1, { ...out, routeKey: "QM_route-one" }, PAGE), { ok: false, refusal: "out_other_rulebook" });
    assert.deepEqual(deriveVersion(v1, { ...out, rule: { ...out.rule, source: { ...out.rule.source, sourceId: "another-source" } } }, PAGE), { ok: false, refusal: "out_other_rulebook" });
  });

  test("the block fails competenceProblems on the built version 2", async () => {
    const out = await outFor();
    // A step whose words are not in the rule's quote or list lines (made up): code refuses it on the version.
    const block = { steps: out.competence.steps.map((s: any, i: number) => (i === 0 ? { ...s, restsOn: "words that are nowhere in the passage" } : s)) };
    const built = deriveVersion(version1(), { ...out, competence: block }, PAGE);
    assert.equal(built.ok, false);
    assert.match((built as any).refusal, /^competence_problems_on_version:/);
  });

  test("only this one shared rulebook, at version 1, approved, without a block", async () => {
    const out = await outFor();
    assert.deepEqual(deriveVersion(version1({ routeKey: "QM_route-one" } as any), out, PAGE), { ok: false, refusal: "rulebook_not_allowed" });
    assert.deepEqual(deriveVersion(version1({ routeKey: "GB_visitor" } as any), out, PAGE), { ok: false, refusal: "rulebook_not_allowed" });
    assert.deepEqual(deriveVersion(version1({ version: 2 } as any), out, PAGE), { ok: false, refusal: "version_not_allowed" });
    assert.deepEqual(deriveVersion(version1({ reviewStatus: "pending_review" } as any), out, PAGE), { ok: false, refusal: "base_not_approved" });
    assert.deepEqual(deriveVersion(version1({ competence: { steps: [] } } as any), out, PAGE), { ok: false, refusal: "base_has_competence" });
  });

  test("version 1 is not the approved and latest version on the target (the head moved)", async () => {
    const inputs = { v1: version1(), out: await outFor(), snapshot: PAGE };
    for (const head of [HEAD({ approvedVersion: 2, latestVersion: 2 }), HEAD({ approvedVersion: 1, latestVersion: 3 }), HEAD({ approvedVersion: null, latestVersion: 1 })]) {
      const d = depsOf(head);
      const s = await runDerive(inputs, { write: true }, d);
      assert.equal(s.refusal, "head_moved");
      assert.ok(d.lines.some((l) => l.includes("refused (head_moved)")));
    }
    assert.equal((await runDerive(inputs, { write: false }, depsOf(null))).refusal, "no_head");
    assert.equal((await runDerive(inputs, { write: false }, depsOf(HEAD({ latestSourceSetHash: "e".repeat(64) })))).refusal, "source_set_differs");
  });

  test("the target project: none named, production, or one the environment disagrees with", () => {
    assert.equal(projectProblem(undefined, {}), "no_project");
    assert.equal(projectProblem("", {}), "no_project");
    assert.equal(projectProblem("japa-platform", {}), "production_refused");
    assert.equal(projectProblem("durin-seli-dev", { GCLOUD_PROJECT: "japa-platform" }), "project_env_mismatch");
    assert.equal(projectProblem("durin-seli-dev", { GCLOUD_PROJECT: "durin-seli-dev" }), null);
  });

  test("the command line refuses production (no override flag), no project, and --offline with --write, before reading any file", () => {
    const script = join(__dirname, "..", "..", "..", "src", "scrapers", "rubric", "scripts", "derive-version-from-one-rule.ts");
    const env = { ...process.env, GCLOUD_PROJECT: "", GOOGLE_CLOUD_PROJECT: "" };
    for (const [args, code] of [
      [["--project", "japa-platform", "--allow-production", "--write"], "production_refused"],
      [["--version", "x.json"], "no_project"],
      [["--project", "demo-x", "--offline", "--write"], "offline_with_write"],
    ] as const) {
      const r = spawnSync(process.execPath, ["--import", "tsx", script, ...args], { env, encoding: "utf8" });
      assert.equal(r.status, 2, String(args));
      assert.ok(r.stderr.includes(`refused (${code})`), r.stderr);
    }
  });
});

describe("(#440) the dry run: what version 2 contains and what its publish would send", () => {
  /** Version 1's check, run for real with the fake provider (its record is what version 2 reuses). */
  async function checkedV1() {
    const ledger = new MemoryLedger();
    const provider = new ScriptedProvider();
    const svc = new RubricCheckerService({ provider: () => provider, readSnapshot: async () => PAGE, loadSettings: settingsWith(), ledger, nowMs: () => Date.parse("2026-11-21T10:00:00Z"), sleep: async () => undefined });
    const v1 = version1();
    const out1 = await svc.check({ routeKey: KEY, version: 1, runId: `${KEY}__v1`, rubric: v1, codeLeftOutIds: [] });
    assert.equal(out1.ok, true);
    return { ledger, provider, svc, v1, fullV1Requests: provider.requests.length };
  }

  test("prints one line per changed rule and the unchanged count, ids and code words only", async () => {
    const { ledger, v1 } = await checkedV1();
    const out = await outFor(v1);
    const d = depsOf(HEAD(), { plan: { loadSettings: settingsWith(), loadCheckerRecord: async (id) => ledger.docs.get(id) ?? null, readSnapshot: async () => PAGE, provider: new ScriptedProvider() } });
    const s = await runDerive({ v1, out, snapshot: PAGE }, { write: false }, d);
    assert.equal(s.refusal, null);
    assert.equal(s.written, false);
    assert.ok(d.lines.includes(`  ${ID}: redrafted`));
    assert.ok(d.lines.includes("  crit_list_25: list_reread"));
    assert.ok(d.lines.includes("  crit_list_32: list_reread"));
    assert.ok(d.lines.some((l) => l.startsWith("  crit_unreadable: list_not_proven (unreadable:line_after_item_not_recognised")));
    assert.ok(d.lines.some((l) => l.includes("unchanged rules: 21")));
    // Never a quote, a title, a list line or a question's wording.
    const printed = d.lines.join("\n");
    const words = [LEAD5, LEAD25, LEAD32, UNREADABLE[0], ...PLAIN, POLARITY_LINE, ...v1.criteria.map((c) => c.title), out.rule.title, ...out.intakeQuestions.map((q: any) => q.label), DESTINATIONS.label];
    for (const w of words) assert.ok(!printed.includes(w), `printed: ${w}`);
  });

  test("on a fixture shaped like today's version 1, the planned rule-check requests are only the changed rules' batch", async () => {
    const { ledger, v1, fullV1Requests } = await checkedV1();
    const out = await outFor(v1);
    const d = depsOf(HEAD(), { plan: { loadSettings: settingsWith(), loadCheckerRecord: async (id) => ledger.docs.get(id) ?? null, readSnapshot: async () => PAGE, provider: new ScriptedProvider() } });
    const s = await runDerive({ v1, out, snapshot: PAGE }, { write: false }, d);
    const plan = s.plan?.check;
    assert.ok(plan && plan.kind === "planned");
    // PINNED: the three changed rules (re-drafted + two re-read lists) fit one batch; nothing else is asked.
    assert.equal(plan.check, 1);
    assert.equal(plan.trigger, 0);
    assert.equal(plan.polarity, 0, "the intention-to-stay reading is reused");
    // The 20 plain rules (the 21st unchanged rule is the unreadable one, which has no view).
    assert.equal(plan.reuse?.totals.rulesReused, 20);
    assert.equal(plan.reuse?.totals.rulesAsked, 3);
    for (const id of [ID, "crit_list_25", "crit_list_32"]) assert.deepEqual(plan.reuse?.rules[id], { rule: "asked", reason: "rule_changed" }, id);
    // The rule that could not be re-read has no view: nothing is sent for it (it is left out as checker:source_text).
    assert.equal(plan.reuse?.rules.crit_unreadable, undefined);
    // Version 1's own full check asked 2 batches (its 20 readable rules) and 2 readings; without reuse version 2
    // would ask 3 batches (23 readable rules) and 2 readings. With reuse: the changed rules' one batch only.
    assert.equal(fullV1Requests, 4);
    assert.ok(planLines(s.plan as any).some((l) => l.startsWith("question wording check (no reuse, #441):")));

    // And the check of version 2 with reuse (fake provider) sends exactly the planned request.
    const p2 = new ScriptedProvider();
    const svc2 = new RubricCheckerService({ provider: () => p2, readSnapshot: async () => PAGE, loadSettings: settingsWith(), ledger, nowMs: () => Date.parse("2026-11-21T11:00:00Z"), sleep: async () => undefined });
    const v2 = { ...(deriveVersion(v1, out, PAGE) as any).draft, version: 2 } as VisaRubric;
    const out2 = await svc2.check({ routeKey: KEY, version: 2, runId: `${KEY}__v2`, rubric: v2, codeLeftOutIds: [], reuseFrom: { version: 1, rubric: v1 } });
    assert.equal(out2.ok, true);
    assert.equal(p2.requests.length, 1);
    assert.equal(p2.requests.filter(isTriggerRequest).length, 0);
    assert.deepEqual(seenRules(p2.requests[0]).map((r) => r.title).sort(), [out.rule.title, "Limited territorial validity cases", "Refusal grounds"].sort());
    // The unreadable list is left out as before; the re-read and re-drafted rules are now kept.
    assert.deepEqual((out2 as any).leftOut.map((l: any) => `${l.criterionId}:${l.reason}`), ["crit_unreadable:checker:source_text"]);
  });

  test("version 2 already on the target: reported, nothing written", async () => {
    const writes: unknown[] = [];
    const d = depsOf(HEAD({ latestVersion: 2 }), { writeDerived: async (x) => (writes.push(x), { written: true, version: 2 }) });
    const s = await runDerive({ v1: version1(), out: await outFor(), snapshot: PAGE }, { write: true }, d);
    assert.equal(s.alreadyExists, true);
    assert.equal(s.written, false);
    assert.equal(writes.length, 0);
    assert.ok(d.lines.some((l) => l.includes("a version 2 already exists on the target (not compared with this build)")));
  });

  test("with --write the draft goes to the store's narrow write with the base's fingerprint", async () => {
    const calls: any[] = [];
    const d = depsOf(HEAD(), { writeDerived: async (draft, o) => (calls.push({ draft, o }), { written: true, version: 2 }), readPublishSettings: manual });
    const v1 = version1();
    const s = await runDerive({ v1, out: await outFor(v1), snapshot: PAGE }, { write: true }, d);
    assert.equal(s.written, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].o.baseVersion, 1);
    const { derivedBaseFingerprint } = await import("../../../src/scrapers/rubric/rubric.store");
    assert.equal(calls[0].o.baseFingerprint, derivedBaseFingerprint(v1));
    assert.equal(calls[0].draft.reviewStatus, "pending_review");
    assert.equal(calls[0].draft.createdAt, "now");
  });
});

// ============================================
// (#440 fix round 1) The write refuses while automatic publishing covers this route
// ============================================

/** Publish settings as the loader returns them (the mode and allow-list overridable; `readError` for a failed read). */
const publishSettings = (over: Partial<LoadedPublishSettings["settings"]> = {}, readError?: string) => async (): Promise<LoadedPublishSettings> =>
  ({ settings: { ...DEFAULT_PUBLISH_SETTINGS, ...over }, exists: true, problems: [], ...(readError !== undefined ? { readError } : {}) });
const manual = publishSettings({ mode: "manual" });

describe("(#440 fix round 1) auto_publish_on: no version 2 while the trigger or the sweep would check it without reuse", () => {
  /** A write run over the given settings reader; returns the summary, the printed lines and the writes made. */
  async function writeWith(readPublishSettings: DeriveRunDeps["readPublishSettings"], write = true) {
    const writes: unknown[] = [];
    const d = depsOf(HEAD(), { writeDerived: async (x) => (writes.push(x), { written: true, version: 2 }), ...(readPublishSettings ? { readPublishSettings } : {}) });
    const s = await runDerive({ v1: version1(), out: await outFor(), snapshot: PAGE }, { write }, d);
    return { s, lines: d.lines, writes };
  }

  test("mode auto with this route allowed (no allow-list, or one naming it): refused, nothing written", async () => {
    for (const reader of [publishSettings({ mode: "auto" }), publishSettings({ mode: "auto", routeAllowlist: [KEY] })]) {
      const { s, lines, writes } = await writeWith(reader);
      assert.equal(s.refusal, "auto_publish_on");
      assert.equal(writes.length, 0);
      assert.ok(lines.includes("refused (auto_publish_on); nothing was written."));
    }
  });

  test("settings that cannot be read, a reader that throws, or no reader at all: refused (fail closed)", async () => {
    for (const reader of [publishSettings({ mode: "manual" }, "unavailable"), async () => { throw new Error("read failed"); }, undefined]) {
      const { s, writes } = await writeWith(reader as any);
      assert.equal(s.refusal, "auto_publish_on");
      assert.equal(writes.length, 0);
    }
  });

  test("manual mode, or auto mode with an allow-list that leaves this route out: the write goes ahead", async () => {
    for (const reader of [manual, publishSettings({ mode: "auto", routeAllowlist: ["QM_route-one"] })]) {
      const { s, writes } = await writeWith(reader);
      assert.equal(s.refusal, null);
      assert.equal(s.written, true);
      assert.equal(writes.length, 1);
    }
  });

  test("the dry run prints the refusal as a line and goes on (nothing written either way)", async () => {
    const { s, lines, writes } = await writeWith(publishSettings({ mode: "auto" }), false);
    assert.equal(s.refusal, null);
    assert.equal(writes.length, 0);
    assert.ok(lines.some((l) => l.startsWith("a write would be refused (auto_publish_on: publish mode auto and this route allowed)")));
    assert.ok(lines.some((l) => l.startsWith("(dry run: nothing was written")) || lines.some((l) => l.includes("dry run: nothing was written")));
  });
});

describe("(#440 fix round 1) a rule whose list lines changed is asked again", () => {
  test("version 1 checked when its cut lists were accepted (as on the real record); version 2 re-reads one: only that rule is asked", async () => {
    const v1 = version1();
    const ledger = new MemoryLedger();
    const svc1 = new RubricCheckerService({ provider: () => new ScriptedProvider(), readSnapshot: async () => PAGE, loadSettings: settingsWith(), ledger, nowMs: () => Date.parse("2026-11-21T10:00:00Z"), sleep: async () => undefined });
    // The list reader of version 1's time accepted a list cut to "(a)": every rule whose quote is found had a
    // view and got letters (the real version 1 record has letters for its cut-list rules). Simulated for the
    // version 1 run only by showing every found quote.
    const index = new SnapshotQuoteIndex(PAGE, lexiconFor("en"));
    (svc1 as any).buildViews = async (rules: AssessmentCriterion[], _i: unknown, rubric?: VisaRubric) => {
      const m = new Map();
      for (const r of rules) {
        const f = index.locate(r.source.quote);
        if (f.ok) m.set(r.criterionId, viewOf(r, index, f, rubric?.intakeQuestions ?? []));
      }
      return m;
    };
    assert.equal((await svc1.check({ routeKey: KEY, version: 1, runId: `${KEY}__v1`, rubric: v1, codeLeftOutIds: [] })).ok, true);
    assert.ok(ledger.docs.get(`${KEY}__v1`)?.ruleVerdicts.crit_list_25, "version 1 has letters for the cut-list rule");

    // Version 2: only crit_list_25's list lines change (re-read from the page, as the builder does).
    const reread = (readLeadInList(index, index.locate(LEAD25) as any) as any).items as string[];
    const v2 = { ...(JSON.parse(JSON.stringify(v1)) as VisaRubric), version: 2, reviewStatus: "pending_review" } as VisaRubric;
    v2.criteria = v2.criteria.map((c) => (c.criterionId === "crit_list_25" ? { ...c, source: { ...c.source, listItems: reread } } : c));
    const p2 = new ScriptedProvider();
    const svc2 = new RubricCheckerService({ provider: () => p2, readSnapshot: async () => PAGE, loadSettings: settingsWith(), ledger, nowMs: () => Date.parse("2026-11-21T11:00:00Z"), sleep: async () => undefined });
    assert.equal((await svc2.check({ routeKey: KEY, version: 2, runId: `${KEY}__v2`, rubric: v2, codeLeftOutIds: [], reuseFrom: { version: 1, rubric: v1 } })).ok, true);
    assert.equal(p2.requests.length, 1);
    assert.deepEqual(seenRules(p2.requests[0]).map((r) => r.title), ["Limited territorial validity cases"]);
    const rec = ledger.docs.get(`${KEY}__v2`);
    assert.deepEqual(rec?.reuse?.rules.crit_list_25, { rule: "asked", reason: "rule_changed" });
    // The 20 plain rules are reused: rebuilding version 1's batches (which held the cut-list rules) proved them.
    assert.equal(rec?.reuse?.totals.rulesReused, 20);
  });
});

describe("(#455) only a live result may become version 2", () => {
  test("an --out file written by a --replay run is refused (`replayed_result`), and builds nothing", async () => {
    const out = await outFor();
    // A replay re-runs the code steps on SAVED answers to diagnose a stop: never a result to keep.
    assert.deepEqual(deriveVersion(version1(), { ...out, replayed: true }, PAGE), { ok: false, refusal: "replayed_result" });
    assert.deepEqual(keptResultOf({ ...out, replayed: true }), { ok: false, code: "replayed_result" });
    // The same file from the live run is still kept.
    assert.equal(out.replayed, false);
    assert.equal(keptResultOf(out).ok, true);
  });
});
