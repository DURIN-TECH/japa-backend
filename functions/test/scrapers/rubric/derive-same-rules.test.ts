// ============================================
// (#461) Version 3 as a same-rules copy of the approved version 2: build, refusals, plan
// ============================================
//
// `derive-version-from-one-rule.ts --same-rules` builds version 3 of the shared Schengen
// short-stay rulebook as a copy of its approved version 2, with no `--out` file and no model
// call. These tests prove:
//  - every rule, question, document item and the competence block are version 2's, field by
//    field; version 3 is a pristine pending draft (no field of RUBRIC_REVIEW_FIELDS carried);
//  - it never calls a model, in any mode;
//  - every #440 refusal stops with its code word (rulebook, version, approval, head, sources,
//    project, offline write, automatic publishing);
//  - the dry run prints ids, counts and code words only;
//  - on a fixture shaped like today's version 2 (checked with reuse from version 1), the planned
//    publish is 0 rule-check requests (every rule, trigger and reading reused, the stored
//    re-drafts carried with their check) and 6 wording-check requests (4 question and 2 document
//    batches, every item asked), and a check of version 3 with the fake provider sends nothing.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { deriveSameRules, planLines, runSameRules, type DeriveRunDeps } from "../../../src/scrapers/rubric/scripts/derive-version-from-one-rule";
import { RubricCheckerService } from "../../../src/scrapers/rubric/rubric-checker";
import { RUBRIC_REVIEW_FIELDS, type RubricHead, type VisaRubric } from "../../../src/types/rubric";
import { DEFAULT_PUBLISH_SETTINGS, type LoadedPublishSettings } from "../../../src/scrapers/rubric/rubric-publish-settings";
import { ScriptedProvider, settingsWith } from "./checker-fakes";
import { HEAD, version1 } from "./derive-version-fixtures";
import { KEY, PAGE, RUN, chainToV2 } from "./derive-same-rules-fixtures";

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Run deps over a head (no plan, no store unless given) that collect the printed lines. */
function depsOf(head: RubricHead | null, extra: Partial<DeriveRunDeps> = {}): DeriveRunDeps & { lines: string[] } {
  const lines: string[] = [];
  return { readHead: async () => head, now: () => "now", print: (l) => lines.push(l), lines, ...extra };
}
const publishSettings = (over: Partial<LoadedPublishSettings["settings"]> = {}) => async (): Promise<LoadedPublishSettings> => ({ settings: { ...DEFAULT_PUBLISH_SETTINGS, ...over }, exists: true, problems: [] });
/** The review fields that keep an initial value on a pending draft; every other review field must be absent. */
const INITIAL = ["reviewStatus", "intentPolarity", "reviewedBy", "reviewedAt", "rejectReason", "revision", "supersededAt"];

describe("(#461) building version 3 from version 2", () => {
  test("every rule, question, document item and the competence block are version 2's; a pristine pending draft", async () => {
    const { v2 } = await chainToV2();
    const built = deriveSameRules(v2);
    assert.ok(built.ok, built.ok ? "" : built.refusal);
    const d = built.draft as any;
    // Field by field: the content is byte-identical (deep equality of the stored JSON).
    for (const f of ["criteria", "intakeQuestions", "evidenceItems", "competence", "intentPolarityProposal", "sourceSnapshots", "sourceSetHash", "routeKey", "authorityId", "routeSlug", "severityLevels", "schemaVersion"]) {
      assert.equal(JSON.stringify(d[f]), JSON.stringify((v2 as any)[f]), f);
    }
    assert.ok(d.competence?.steps?.length > 0, "the competence block is there");
    // Rule by rule, too.
    v2.criteria.forEach((c, i) => assert.equal(JSON.stringify(d.criteria[i]), JSON.stringify(c), c.criterionId));
    // Pristine pending draft: the initial review values, and no other review field of version 2.
    assert.deepEqual([d.reviewStatus, d.intentPolarity, d.reviewedBy, d.reviewedAt, d.rejectReason, d.revision, d.supersededAt], ["pending_review", null, null, null, null, 0, null]);
    for (const f of RUBRIC_REVIEW_FIELDS) if (!INITIAL.includes(f)) assert.equal(d[f], undefined, f);
    assert.ok((v2 as any).excludedCriterionIds && (v2 as any).questionPlan, "version 2 had approval fields to leave behind");
    assert.equal(d.version, undefined);
    assert.equal(d.createdAt, undefined);
  });

  test("refusals of the build: another rulebook, another version, not approved, a split file", async () => {
    const { v2 } = await chainToV2();
    assert.deepEqual(deriveSameRules({ ...v2, routeKey: "QM_route-one" } as VisaRubric), { ok: false, refusal: "rulebook_not_allowed" });
    assert.deepEqual(deriveSameRules(version1()), { ok: false, refusal: "version_not_allowed" });
    assert.deepEqual(deriveSameRules({ ...v2, version: 3 } as VisaRubric), { ok: false, refusal: "version_not_allowed" });
    assert.deepEqual(deriveSameRules({ ...v2, reviewStatus: "pending_review" } as VisaRubric), { ok: false, refusal: "base_not_approved" });
    assert.deepEqual(deriveSameRules({ ...v2, contentStorage: { parts: 2 } } as any), { ok: false, refusal: "version_file_split" });
  });

  test("the head on the target: version 2 must be both approved and latest; the same sources", async () => {
    const { v2 } = await chainToV2();
    for (const head of [HEAD(), HEAD({ approvedVersion: 1, latestVersion: 2 }), HEAD({ approvedVersion: 2, latestVersion: 4 }), HEAD({ approvedVersion: null, latestVersion: 2 })]) {
      const d = depsOf(head);
      assert.equal((await runSameRules({ v2 }, { write: true }, d)).refusal, "head_moved");
      assert.ok(d.lines.includes("refused (head_moved); nothing was written."));
    }
    assert.equal((await runSameRules({ v2 }, { write: false }, depsOf(null))).refusal, "no_head");
    assert.equal((await runSameRules({ v2 }, { write: false }, depsOf(HEAD({ approvedVersion: 2, latestVersion: 2, latestSourceSetHash: "e".repeat(64) })))).refusal, "source_set_differs");
  });

  test("auto_publish_on: a write is refused while automatic publishing covers the route (or the settings are unknown)", async () => {
    const { v2, head } = await chainToV2();
    for (const reader of [publishSettings({ mode: "auto" }), undefined]) {
      const writes: unknown[] = [];
      const d = depsOf(head, { writeDerived: async (x) => (writes.push(x), { written: true, version: 3 }), ...(reader ? { readPublishSettings: reader } : {}) });
      assert.equal((await runSameRules({ v2 }, { write: true }, d)).refusal, "auto_publish_on");
      assert.equal(writes.length, 0);
    }
    // The dry run prints it as a line, naming the reuse run to wait for.
    const d = depsOf(head, { readPublishSettings: publishSettings({ mode: "auto" }) });
    assert.equal((await runSameRules({ v2 }, { write: false }, d)).refusal, null);
    assert.ok(d.lines.some((l) => l.startsWith("a write would be refused (auto_publish_on: publish mode auto and this route allowed)") && l.includes("--reuse-check-from 2")));
  });

  test("with --write: the store's narrow write over base 2 with version 2's fingerprint; a version 3 already there is reported", async () => {
    const { v2, head } = await chainToV2();
    const calls: any[] = [];
    const d = depsOf(head, { writeDerived: async (draft, o) => (calls.push({ draft, o }), { written: true, version: 3 }), readPublishSettings: publishSettings({ mode: "manual" }) });
    const s = await runSameRules({ v2 }, { write: true }, d);
    assert.equal(s.written, true);
    assert.equal(calls[0].o.baseVersion, 2);
    const { derivedBaseFingerprint } = await import("../../../src/scrapers/rubric/rubric.store");
    assert.equal(calls[0].o.baseFingerprint, derivedBaseFingerprint(v2));
    assert.equal(calls[0].draft.reviewStatus, "pending_review");
    // The head already says 3 is the latest: nothing written.
    const d2 = depsOf(HEAD({ approvedVersion: 2, latestVersion: 3 }), { writeDerived: async () => assert.fail("no write") });
    const s2 = await runSameRules({ v2 }, { write: true }, d2);
    assert.equal(s2.alreadyExists, true);
    assert.ok(d2.lines.some((l) => l.includes("a version 3 already exists on the target")));
  });

  test("the command line refuses production (no override), no project, and --offline with --write in same-rules mode", () => {
    const script = join(__dirname, "..", "..", "..", "src", "scrapers", "rubric", "scripts", "derive-version-from-one-rule.ts");
    const env = { ...process.env, GCLOUD_PROJECT: "", GOOGLE_CLOUD_PROJECT: "" };
    for (const [args, code] of [
      [["--same-rules", "--project", "japa-platform", "--allow-production", "--write"], "production_refused"],
      [["--same-rules", "--version", "x.json"], "no_project"],
      [["--same-rules", "--project", "demo-x", "--offline", "--write"], "offline_with_write"],
    ] as const) {
      const r = spawnSync(process.execPath, ["--import", "tsx", script, ...args], { env, encoding: "utf8" });
      assert.equal(r.status, 2, String(args));
      assert.ok(r.stderr.includes(`refused (${code})`), r.stderr);
    }
  });
});

describe("(#461) the planned publish of version 3 (0 model calls)", () => {
  test("on a fixture shaped like version 2: rule check 0 requests, wording check 6; and the check of version 3 sends nothing", async () => {
    const { v1, v2, ledger, head, v2Record } = await chainToV2();
    const planner = new ScriptedProvider();
    const d = depsOf(head, { plan: { loadSettings: settingsWith(), loadCheckerRecord: async (id) => ledger.docs.get(id) ?? null, readSnapshot: async () => PAGE, provider: planner } });
    const s = await runSameRules({ v2, via: v1 }, { write: false }, d);
    assert.equal(s.refusal, null, d.lines.join("\n"));
    assert.equal(planner.requests.length, 0, "planning never calls a model");
    const plan = s.plan?.check;
    assert.ok(plan && plan.kind === "planned", JSON.stringify(plan));
    // PINNED: the rule check sends nothing.
    assert.deepEqual([plan.check, plan.trigger, plan.polarity, plan.repairAtMost], [0, 0, 0, 0]);
    assert.equal(plan.reuse?.totals.rulesAsked, 0);
    assert.equal(plan.reuse?.totals.rulesReused, (v2Record.reuse?.totals.rulesReused ?? -1) + (v2Record.reuse?.totals.rulesAsked ?? -1));
    assert.equal(plan.reuse?.totals.polarityReused, 2);
    assert.equal(plan.reuse?.totals.repairsCarried, v2Record.reuse?.totals.repairsCarried);
    assert.deepEqual(plan.reuse?.via, { version: 1, runId: RUN(1) });
    // PINNED: the wording check asks every item: 4 question batches + 2 document batches; nothing shortened.
    assert.deepEqual(s.plan?.questionCheck, { ifSameLeftOut: 6, atMost: 6, shortenedQuotes: 0 });
    const lines = planLines(s.plan as any);
    assert.ok(lines.some((l) => l.startsWith("question wording check (no reuse, #463; every item asked): 6 request(s)") && l.includes("quotes shortened 0")));
    assert.ok(lines.some((l) => l.startsWith("rule check planned: 0 request(s), at most 0 with repairs")));

    // The check of version 3 itself, with reuse from 2 via 1 (fake provider): nothing is sent, the same left-out rules.
    const p3 = new ScriptedProvider();
    const svc = new RubricCheckerService({ provider: () => p3, readSnapshot: async () => PAGE, loadSettings: settingsWith(), ledger, nowMs: () => Date.parse("2026-11-22T12:00:00Z"), sleep: async () => undefined });
    const v3 = { ...(deriveSameRules(v2) as any).draft, version: 3 } as VisaRubric;
    const out3 = (await svc.check({ routeKey: KEY, version: 3, runId: RUN(3), rubric: v3, codeLeftOutIds: [], reuseFrom: { version: 2, rubric: v2, via: { version: 1, rubric: v1 } } })) as any;
    assert.equal(out3.ok, true);
    assert.equal(p3.requests.length, 0);
    assert.deepEqual(out3.leftOut.map((l: any) => `${l.criterionId}:${l.reason}`), ["crit_unreadable:checker:source_text"]);
  });

  test("the dry run prints ids, counts and code words only (no quote, title or question wording)", async () => {
    const { v1, v2, ledger, head } = await chainToV2();
    const d = depsOf(head, { plan: { loadSettings: settingsWith(), loadCheckerRecord: async (id) => ledger.docs.get(id) ?? null, readSnapshot: async () => PAGE, provider: new ScriptedProvider() } });
    await runSameRules({ v2, via: v1 }, { write: false }, d);
    const printed = d.lines.join("\n");
    const words = [...v2.criteria.flatMap((c) => [c.title, c.source.quote.slice(0, 40)]), ...(v2.intakeQuestions ?? []).map((q) => q.label), ...(v2.evidenceItems ?? []).map((e) => e.title)];
    for (const w of words) assert.ok(!printed.includes(w), `printed: ${w}`);
  });

  test("without version 1 (--via) the plan says the check would hold before any request", async () => {
    const { v2, ledger, head } = await chainToV2();
    const d = depsOf(head, { plan: { loadSettings: settingsWith(), loadCheckerRecord: async (id) => ledger.docs.get(id) ?? null, readSnapshot: async () => PAGE, provider: new ScriptedProvider() } });
    const s = await runSameRules({ v2 }, { write: false }, d);
    assert.deepEqual(s.plan?.check, { kind: "held", reasonCodes: ["checker_reuse_refused:via_mismatch"] });
  });
});
