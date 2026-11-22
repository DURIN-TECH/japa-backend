/**
 * Build version 2 of the one shared rulebook named in `CHECK_REUSE_PAIR` (services/rubric-check-reuse-pair.ts;
 * owner decision on #440) from its approved version 1 plus the
 * one-rule result of `redraft-competence-rule` (#335), and (with `--write`) store it as a PENDING draft,
 * without a whole-rulebook extraction (issue #440). It never calls a model, in any mode.
 *
 * WHAT VERSION 2 IS: version 1, rule for rule, except
 *   1. the re-drafted rule, replaced by the `--out` file's rule (`redrafted`);
 *   2. the `competence` block, set from the `--out` file;
 *   3. the questions that block needs, added from the `--out` file (a question version 1 already asks is
 *      reused, never copied; the `--out` file is refused if its questions were not placed on THIS version 1);
 *   4. the stored `source.listItems` of the other rules whose stored list no longer matches the snapshot (the
 *      lists cut to their first marker by the old list reader), re-read from the snapshot by code
 *      (`readLeadInList`) and kept ONLY when the new list proves verbatim (`verifyListItems`): `list_reread`.
 *      A list that cannot be proven leaves the rule exactly as in version 1 (`list_not_proven`), so the
 *      publish check later leaves it out (`checker:source_text`), as it would today.
 * Every other field of every other rule is identical to version 1. Version 2 is a pristine pending draft:
 * review fields at their initial values and none of version 1's approval fields (exclusions, the question
 * plan, recorded replacements, the layer check; `RUBRIC_REVIEW_FIELDS` in types/rubric.ts). The publish
 * pipeline decides all of those again.
 *
 * REFUSALS (a code word; nothing is written): see `DeriveRefusal`. Among them: a snapshot whose sha256 is not
 * its `contentHash`, or not the hash its rules cite; a `--out` file that is not a kept result; a rule id that
 * version 1 does not have; a block that fails `competenceProblems` on the built version; any rulebook other
 * than the one in `CHECK_REUSE_PAIR`; a head that moved (version 1 is no longer
 * both the approved and the latest version); the production project; no project named.
 *
 * STORING (`--write`): through `RubricStore.writeDerivedPendingVersion`, the narrow write next to
 * `writePendingVersion` (which is unchanged): pending only, never approved, never over an existing version,
 * only while the head's approved AND latest version are 1, only for the same snapshots as version 1, and only
 * when the stored version 1 is exactly the `--version` file (content fingerprint). A second run reports that
 * a version 2 already exists and writes nothing. No `force` anywhere.
 *
 * AUTOMATIC PUBLISHING MUST BE OFF (fix round 1). Creating version 2 fires the version-created trigger, and on
 * a project whose publish mode is `auto` with this route allowed that trigger checks the WHOLE rulebook without
 * reuse (and the hourly sweep re-runs a held version the same way). So the write reads the target's publish
 * settings first and refuses (`auto_publish_on`) when they cannot be read, or when the mode is `auto` and the
 * route is allowed. The dry run prints the same refusal as a line. Nothing here changes a setting.
 *
 * PLANNED REQUESTS (printed, 0 model calls): what `publish:rubric --reuse-check-from 1` would send for
 * version 2: the rule check (rules reused from version 1 vs asked now, and the requests that makes), the
 * trigger check, the intention-to-stay readings, the repair step's upper bound, and on its own line the
 * question wording check (`rubric-question-check.ts`), which has no reuse (deferred, #463): every item is asked.
 *
 * (#461) SAME-RULES MODE (`--same-rules`): build version 3 as a copy of the approved version 2 of the same
 * rulebook (`CHECK_REUSE_PAIR_V3`), with NO `--out` file and no re-draft. Every rule, question, document item
 * and the `competence` block are version 2's, byte for byte; version 3 is a pristine pending draft (none of
 * version 2's review or approval fields). Its purpose: a publish run whose wording check is shown the rules'
 * list lines (#461), with the rule check reusing version 2's answers (`--reuse-check-from 2`, which follows
 * version 2's own reuse one hop back to version 1). The same refusals, head check (version 2 both approved and
 * latest), `auto_publish_on` check and store write (`writeDerivedPendingVersion` with base 2) apply. The plan
 * needs version 1 too (`--via`, the version the check's proof goes back to); offline also its check record
 * (`--via-checker`).
 *
 * OUTPUT: ids, counts and code words only. Never a quote, a title, a question's wording or model text
 * (an unexpected failure prints its class).
 *
 * Files (read-only; Firestore REST JSON or plain JSON, as `redraft-competence-rule` reads them):
 *   --version  version 1 as stored (`visaRubrics/{key}/rubricVersions/1`)
 *   --out      the `--out` file of `redraft-competence-rule --live`
 *   --page     the stored Visa Code snapshot the rules cite
 *   --head     (offline only) the head document; otherwise the head is read from the project
 *   --checker  (offline only) version 1's check record (`rubricCheckerRuns/{key}__v1`); otherwise read from the project
 *
 * Run (from functions/):
 *   npm run derive:one-rule-version -- --project <id> --version <v1.json> --out <result.json> --page <snapshot.json> [--offline --head <head.json> --checker <checker-v1.json>] [--write]
 *   (#461) npm run derive:one-rule-version -- --same-rules --project <id> --version <v2.json> --via <v1.json> --page <snapshot.json> [--offline --head <head.json> --checker <checker-v2.json> --via-checker <checker-v1.json>] [--write]
 * `--offline` reads nothing from any project (the head and the check record come from files, the publish
 * settings are the code defaults) and cannot be combined with `--write`.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { AssessmentCriterion, CompetenceBlock, IntakeQuestion, RubricHead, VisaRubric } from "../../../types/rubric";
import { RUBRIC_REVIEW_FIELDS } from "../../../types/rubric";
import type { GuidanceSnapshotContent } from "../../guidance/types";
import type { LlmProvider, LlmRequest, LlmResponse } from "../../../services/ai/llm-provider";
import { AI_MODELS, type AiModelRole } from "../../../services/ai/ai-models";
import { splitRulebookKey } from "../../../authorities/authority-ids";
import { lexiconFor } from "../../language/language-lexicon";
import { SnapshotQuoteIndex } from "../rubric-quote";
import { readLeadInList, verifyListItems } from "../rubric-list-items";
import { competenceProblems } from "../rubric-competence";
import { CHECK_REUSE_PAIR, CHECK_REUSE_PAIR_V3, type CheckReusePair } from "../../../services/rubric-check-reuse-pair";
import { ruleHashOf } from "../rubric-repair";
import { fromFirestoreRest, placeQuestions } from "./redraft-competence-rule";

// ============================================
// Types
// ============================================

/**
 * Why the script stops (nothing is written). A code word, printed as it is.
 *  - `no_project`, `production_refused`, `project_env_mismatch`: the target project (see `projectProblem`);
 *  - `offline_with_write`: `--offline` reads no project, so it cannot write to one;
 *  - `rulebook_not_allowed`, `not_a_shared_rulebook`, `version_not_allowed`, `base_not_approved`,
 *    `base_has_competence`, `version_file_split`: version 1 is not the one rulebook and version this tool is for;
 *  - `snapshot_hash_mismatch`, `snapshot_not_cited`: the snapshot is not what the rules cite;
 *  - `out_not_kept:<why>`: the `--out` file holds no kept result;
 *  - `replayed_result` (#455): the `--out` file does not say `replayed: false` (a `--replay` run's file, or
 *    one older than #455); `not_live`: it records no request made. Only a live run's result may become version 2;
 *  - `page_unreadable` (#455 fix round 1): the `--page` file holds no snapshot text (another document);
 *  - `out_rule_mismatch`, `out_rule_not_in_version`, `out_other_rulebook`, `out_rule_not_in_snapshot`,
 *    `out_questions_not_placed`: the result does not belong to this version 1;
 *  - `competence_problems_on_version:<codes>`: the block fails the code check on the built version 2;
 *  - `head_moved`, `source_set_differs`, `no_head`, `base_missing`, `base_changed`: the target project no longer
 *    matches the inputs (the head moved since they were read, or the stored version 1 is not the file);
 *  - `auto_publish_on`: the target's publish settings are unreadable, or automatic publishing covers this route.
 */
export type DeriveRefusal = string;

/** One rule of version 2 that is not identical to version 1, and why. */
export interface DerivedChange {
  criterionId: string;
  why: "redrafted" | "list_reread";
}

/** What `deriveVersion` builds (pure; no I/O). */
export type DeriveOutcome =
  | { ok: false; refusal: DeriveRefusal }
  | {
    ok: true;
    // Version 2 as it would be stored, without `version` and `createdAt` (the write sets both).
    draft: Omit<VisaRubric, "version" | "createdAt">;
    changes: DerivedChange[];
    // Rules whose stored list no longer matches the snapshot but whose list could not be proven: left as in v1.
    notProven: string[];
    // Why each of them could not be proven (a code word: `quote_not_found`, `unreadable:<reason>`, `no_list`, `not_verbatim`).
    notProvenWhy: Record<string, string>;
    unchanged: number;
    questionsAdded: number;
  };

/** The kept result of a `redraft-competence-rule --live` run, as its `--out` file holds it. */
interface KeptResult {
  rule: AssessmentCriterion;
  intakeQuestions: IntakeQuestion[];
  competence: CompetenceBlock;
}

// ============================================
// The target project (no default, never production)
// ============================================

/** The production project id: refused, with no override flag. */
export const PRODUCTION_PROJECT = "japa-platform";

/**
 * Why the named project cannot be used, or null: none named (there is no default, as for `publish:rubric`),
 * the production project (refused, no override), or a project that disagrees with GCLOUD_PROJECT /
 * GOOGLE_CLOUD_PROJECT in the environment. Pure.
 */
export function projectProblem(project: string | undefined, env: Record<string, string | undefined>): DeriveRefusal | null {
  if (!project) return "no_project";
  if (project === PRODUCTION_PROJECT) return "production_refused";
  const envProject = env.GCLOUD_PROJECT || env.GOOGLE_CLOUD_PROJECT || "";
  if (envProject && envProject !== project) return "project_env_mismatch";
  return null;
}

// ============================================
// The `--out` file
// ============================================

/**
 * The kept result of the `--out` file, or why there is none. Accepts the file as `redraft-competence-rule`
 * writes it (the summary with the result's fields at the top level: `rule`, `intakeQuestions`, `competence`)
 * and the summary shape with a nested `result`. Kept means: not refused offline, no live failure, a result
 * with a rule, `checkPasses === true`, no `competenceProblems`, and a block with at least one step.
 */
export function keptResultOf(out: any): { ok: true; result: KeptResult; ruleId: string | undefined; routeKey: string | undefined } | { ok: false; code: string } {
  if (!out || typeof out !== "object") return { ok: false, code: "out_not_kept:unreadable" };
  // (#455) A `--replay` re-runs the code steps on SAVED answers (0 requests) to diagnose a stop; its
  // `--out` file is never a result. Only a live run's result may become version 2 (owner decision).
  // (#455 fix round 1) Only a file PROVEN live passes: `replayed` must be exactly false (a missing
  // field, an older file or a hand-edited replay is refused), and at least one request was made.
  if (out.replayed !== false) return { ok: false, code: "replayed_result" };
  if (typeof out.requests !== "number" || !(out.requests >= 1)) return { ok: false, code: "not_live" };
  if (out.refusedOffline) return { ok: false, code: "out_not_kept:refused_offline" };
  if (out.liveFailed) return { ok: false, code: "out_not_kept:live_failed" };
  const r = "result" in out ? out.result : out;
  if (!r || typeof r !== "object" || !r.rule || typeof r.rule !== "object") return { ok: false, code: "out_not_kept:no_result" };
  if (out.checkPasses !== true) return { ok: false, code: "out_not_kept:check_not_passed" };
  if (!Array.isArray(out.competenceProblems) || out.competenceProblems.length > 0) return { ok: false, code: "out_not_kept:competence_problems" };
  if (!r.competence || typeof r.competence !== "object" || !Array.isArray(r.competence.steps) || r.competence.steps.length === 0) return { ok: false, code: "out_not_kept:no_competence_block" };
  if (!Array.isArray(r.intakeQuestions)) return { ok: false, code: "out_not_kept:no_questions" };
  return { ok: true, result: { rule: r.rule, intakeQuestions: r.intakeQuestions, competence: r.competence }, ruleId: typeof out.ruleId === "string" ? out.ruleId : undefined, routeKey: typeof out.routeKey === "string" ? out.routeKey : undefined };
}

// ============================================
// Building version 2 (pure)
// ============================================

/** sha256 hex of a text (the snapshot's own hash check). */
const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

/** The review fields whose initial value a pending draft carries; every other review field is absent. */
const INITIAL_REVIEW_VALUES: Readonly<Record<string, unknown>> = Object.freeze({
  reviewStatus: "pending_review",
  intentPolarity: null,
  reviewedBy: null,
  reviewedAt: null,
  rejectReason: null,
  revision: 0,
  supersededAt: null,
});

/**
 * Build version 2 from version 1, the kept `--out` result and the snapshot. Pure: no project, no model.
 * Every word stored comes from version 1, from the `--out` file (validated by the production code when it
 * was made) or from the snapshot (list lines, read by code and proven). Nothing is typed here.
 */
export function deriveVersion(v1: VisaRubric, out: any, snapshot: GuidanceSnapshotContent): DeriveOutcome {
  const refuse = (refusal: DeriveRefusal): DeriveOutcome => ({ ok: false, refusal });

  // ---- version 1 is the one rulebook and version this tool is for ----
  if (!v1 || v1.routeKey !== CHECK_REUSE_PAIR.routeKey) return refuse("rulebook_not_allowed");
  // Shared (a bloc or treaty's own layer) is read from the KEY, as the structural validator reads it.
  const parts = splitRulebookKey(v1.routeKey);
  if (!parts.ok || parts.authorityIdKind !== "group") return refuse("not_a_shared_rulebook");
  if (v1.version !== CHECK_REUSE_PAIR.fromVersion) return refuse("version_not_allowed");
  if (v1.reviewStatus !== "approved") return refuse("base_not_approved");
  if (v1.competence !== undefined) return refuse("base_has_competence");
  // A split version's header has no rules: the whole stored version is needed.
  if (!Array.isArray(v1.criteria) || (v1 as any).contentStorage !== undefined) return refuse("version_file_split");

  // ---- the snapshot is the one the rules cite ----
  // (#455 fix round 1) A `--page` file that is not a stored snapshot (no `text`: the snapshot's metadata
  // document, the head, a version) is refused with a code word, instead of `sha256(undefined)` throwing
  // a TypeError that the command line can only report by its class.
  if (!snapshot || typeof snapshot.text !== "string") return refuse("page_unreadable");
  if (sha256(snapshot.text) !== snapshot.contentHash) return refuse("snapshot_hash_mismatch");

  // ---- the `--out` file holds a kept result for a rule of this version 1 ----
  const kept = keptResultOf(out);
  if (!kept.ok) return refuse(kept.code);
  const { rule: newRule, intakeQuestions: outQuestions, competence: outBlock } = kept.result;
  if (kept.ruleId !== undefined && kept.ruleId !== newRule.criterionId) return refuse("out_rule_mismatch");
  if (kept.routeKey !== undefined && kept.routeKey !== v1.routeKey) return refuse("out_other_rulebook");
  const ruleId = newRule.criterionId;
  const oldRule = v1.criteria.find((c) => c.criterionId === ruleId);
  if (!oldRule) return refuse("out_rule_not_in_version");
  if (!newRule.source || newRule.source.sourceId !== oldRule.source.sourceId) return refuse("out_other_rulebook");
  // The snapshot is the one the re-drafted rule cites (before and after), and every rule of version 1
  // that cites this source cites this exact snapshot (it is the one their lists are re-read from).
  if (oldRule.source.sourceId !== snapshot.sourceId || oldRule.source.contentHash !== snapshot.contentHash || newRule.source.contentHash !== snapshot.contentHash) return refuse("snapshot_not_cited");
  if (v1.criteria.some((c) => c.source?.sourceId === snapshot.sourceId && c.source.contentHash !== snapshot.contentHash)) return refuse("snapshot_not_cited");

  // ---- the snapshot, read in the language version 1 registered it in ----
  const language = v1.sourceSnapshots?.find((s) => s.sourceId === snapshot.sourceId)?.language;
  const index = new SnapshotQuoteIndex(snapshot, lexiconFor(language));
  // Defence in depth: the replacement's quote is in the snapshot and its list lines (if any) prove verbatim.
  const foundNew = index.locate(newRule.source.quote);
  if (!foundNew.ok) return refuse("out_rule_not_in_snapshot");
  if (newRule.source.listItems !== undefined && !verifyListItems(index, foundNew, newRule.source.listItems).ok) return refuse("out_rule_not_in_snapshot");

  // ---- the questions: placed on version 1 by the same code the one-rule script uses ----
  // `placeQuestions` never changes a question of version 1. A new question that IS one version 1 already asks
  // (same wording, answer type and option source) is reused, not copied: the block and the re-drafted rule
  // then point at version 1's question. A new question whose id is taken by a DIFFERENT question of version 1
  // would have been renamed by the one-rule script when it was run on this version 1; one here means the file
  // was made against another version, and the rule's own links could not be told apart: refused, not guessed.
  const placed = placeQuestions(v1.intakeQuestions ?? [], outQuestions, outBlock);
  if (Object.keys(placed.renamed).length > 0) return refuse("out_questions_not_placed");
  const reusedId = (id: string): string => placed.reused[id] ?? id;
  const linkedRule: AssessmentCriterion = Object.keys(placed.reused).length === 0
    ? newRule
    : {
      ...newRule,
      ...(newRule.intakeQuestionIds ? { intakeQuestionIds: [...new Set(newRule.intakeQuestionIds.map(reusedId))] } : {}),
      ...(newRule.trigger ? { trigger: { ...newRule.trigger, questionId: reusedId(newRule.trigger.questionId) } } : {}),
    };

  // ---- the other rules: re-read the lists that no longer match the snapshot ----
  const changes: DerivedChange[] = [];
  const notProven: string[] = [];
  const notProvenWhy: Record<string, string> = {};
  const reread = new Map<string, AssessmentCriterion>();
  for (const c of v1.criteria) {
    if (c.criterionId === ruleId || c.source?.sourceId !== snapshot.sourceId || c.source.listItems === undefined) continue;
    const found = index.locate(c.source.quote);
    // A quote no longer found: nothing can be proven, the rule stays as it is.
    if (!found.ok) {
      notProven.push(c.criterionId);
      notProvenWhy[c.criterionId] = "quote_not_found";
      continue;
    }
    // A stored list that still proves stays as it is.
    if (verifyListItems(index, found, c.source.listItems).ok) continue;
    const read = readLeadInList(index, found);
    if (read.kind === "items" && verifyListItems(index, found, read.items).ok) {
      // ONLY the list lines change (copied by code from the snapshot); the quote and every other field stay.
      reread.set(c.criterionId, { ...c, source: { ...c.source, listItems: [...read.items] } });
    } else {
      notProven.push(c.criterionId);
      notProvenWhy[c.criterionId] = read.kind === "unreadable" ? `unreadable:${read.reason}` : read.kind === "items" ? "not_verbatim" : "no_list";
    }
  }

  // ---- version 2 ----
  const criteria = v1.criteria.map((c) => {
    if (c.criterionId === ruleId) {
      changes.push({ criterionId: c.criterionId, why: "redrafted" });
      return linkedRule;
    }
    const r = reread.get(c.criterionId);
    if (r) {
      changes.push({ criterionId: c.criterionId, why: "list_reread" });
      return r;
    }
    return c;
  });
  // Everything of version 1 but its number, its creation time and its review and approval fields.
  const base: Record<string, unknown> = { ...(v1 as unknown as Record<string, unknown>) };
  delete base.version;
  delete base.createdAt;
  for (const f of RUBRIC_REVIEW_FIELDS) delete base[f];
  // Served-side only: never stored.
  delete base.stackLayers;
  const draft = {
    ...base,
    ...INITIAL_REVIEW_VALUES,
    criteria,
    intakeQuestions: placed.intakeQuestions,
    competence: placed.competence,
  } as unknown as Omit<VisaRubric, "version" | "createdAt">;

  // ---- the block passes the code check on the version it will be served on ----
  const problems = competenceProblems(draft, { sharedRulebook: true }).map((p) => p.code);
  if (problems.length > 0) return refuse(`competence_problems_on_version:${[...new Set(problems)].join(",")}`);

  return { ok: true, draft, changes, notProven, notProvenWhy, unchanged: v1.criteria.length - changes.length, questionsAdded: placed.intakeQuestions.length - (v1.intakeQuestions ?? []).length };
}

/**
 * Rule by rule, the ids of the rules of `v2` that are not identical to `v1` (by content, `ruleHashOf`), and
 * any rule added or removed. The tests use it to prove "every other rule is identical"; the dry run prints
 * the same comparison so what is stored can be checked against what was planned.
 */
export function rulesThatDiffer(v1: Pick<VisaRubric, "criteria">, v2: Pick<VisaRubric, "criteria">): string[] {
  const before = new Map(v1.criteria.map((c) => [c.criterionId, ruleHashOf(c)]));
  const after = new Map(v2.criteria.map((c) => [c.criterionId, ruleHashOf(c)]));
  const ids = new Set([...before.keys(), ...after.keys()]);
  return [...ids].filter((id) => before.get(id) !== after.get(id));
}

// ============================================
// Planned requests (0 model calls)
// ============================================

/**
 * A provider that names the models and NEVER sends: planning asks only `modelFor`. A `complete` call would
 * be a bug, so it throws (and the plan fails loudly rather than spending).
 */
export class PlanOnlyProvider implements LlmProvider {
  modelFor(role: AiModelRole): string {
    return AI_MODELS[role];
  }
  async complete(_request: LlmRequest): Promise<LlmResponse> {
    throw new Error("planning never sends a request");
  }
}

/** Where the plan reads what is stored (files offline, the project otherwise). */
export interface PlanSources {
  loadSettings: () => Promise<import("../rubric-publish-settings").LoadedPublishSettings>;
  loadCheckerRecord: (runId: string) => Promise<import("../rubric-checker").RubricCheckerRun | null>;
  readSnapshot: (sourceId: string, contentHash: string) => Promise<GuidanceSnapshotContent>;
  provider?: LlmProvider;
}

/** The planned requests of the new version's publish. */
export interface PublishPlan {
  // (#461) The version the check reuses from (1 for version 2, 2 for version 3).
  fromVersion: number;
  check: import("../rubric-checker").CheckRequestPlan;
  // The question wording check: no reuse (deferred, #463), every item asked. `ifSameLeftOut`: with the base's
  // left-out rules; `atMost`: none left out. (#461) `shortenedQuotes`: quotes cut at the field limit (with the
  // base's left-out rules), list lines included.
  questionCheck: { ifSameLeftOut: number; atMost: number; shortenedQuotes: number };
}

/**
 * Work out what `publish:rubric --reuse-check-from 1` would send for `v2`, without calling a model. The rule
 * check is planned by the checker itself (`planRequests`: the same preparation as a run). The question
 * wording check is counted from its own batching (`buildCheckItems` + `batchItems`) on the served view.
 */
export async function planPublish(v1: VisaRubric, v2: VisaRubric, sources: PlanSources, via?: VisaRubric): Promise<PublishPlan> {
  const { RubricCheckerService } = await import("../rubric-checker");
  const checker = new RubricCheckerService({
    provider: () => sources.provider ?? new PlanOnlyProvider(),
    readSnapshot: sources.readSnapshot,
    loadSettings: sources.loadSettings,
    ledger: {
      load: sources.loadCheckerRecord,
      // Planning never writes.
      save: async () => {
        throw new Error("planning never writes");
      },
      countRunsOnDay: async () => 0,
    },
  });
  const runId = `${v2.routeKey}__v${v2.version}`;
  // The code gates' own leave-outs are not worked out offline: only the polarity plan and the repair bound
  // read them, and both treat "none" as the larger case.
  // (#461) `via`: for version 3, the version the base (version 2) reused its answers from (one hop back).
  const check = await checker.planRequests({ routeKey: v2.routeKey, version: v2.version, runId, rubric: v2, codeLeftOutIds: [], reuseFrom: { version: v1.version, rubric: v1, ...(via ? { via: { version: via.version, rubric: via } } : {}) } });
  const { buildCheckItems, batchItems, DEFAULT_QUESTION_CHECK_LIMITS } = await import("../rubric-question-check");
  const { applyExclusions } = await import("../rubric-exclusions");
  /** The wording check's requests (every item asked: no reuse) and its shortened quotes, for a set of left-out rules. */
  const calls = (excluded: readonly string[]): { requests: number; shortened: number } => {
    const view = applyExclusions({ ...v2, excludedCriterionIds: [...excluded], questionPlan: undefined });
    const { questions, evidence, shortenedQuotes } = buildCheckItems(view);
    return { requests: batchItems(questions, DEFAULT_QUESTION_CHECK_LIMITS).length + batchItems(evidence, DEFAULT_QUESTION_CHECK_LIMITS).length, shortened: shortenedQuotes };
  };
  const same = calls(v1.excludedCriterionIds ?? []);
  return { fromVersion: v1.version, check, questionCheck: { ifSameLeftOut: same.requests, atMost: calls([]).requests, shortenedQuotes: same.shortened } };
}

/** The plan as report lines (counts and code words only). */
export function planLines(plan: PublishPlan): string[] {
  const lines: string[] = [];
  const c = plan.check;
  const t = c.reuse?.totals;
  // (#461) The version reused from, and the one hop back when the check followed it.
  const via = c.reuse?.via ? ` (answers version ${plan.fromVersion} reused proven on version ${c.reuse.via.version})` : "";
  if (t) lines.push(`rule check: ${t.rulesReused} rule(s) reused from version ${plan.fromVersion}${via}, ${t.rulesAsked} asked again; triggers ${t.triggersReused} reused, ${t.triggersAsked} asked again; intention-to-stay readings reused ${t.polarityReused}; stored re-drafts carried ${t.repairsCarried} (with their check ${t.repairChecksCarried}).`);
  // (Fix round 1) Why the asked rules are asked, by reason code (e.g. `base_answer_mismatch` when version 1's
  // audit letters were overwritten), so an unexpected count is seen before any spend.
  if (c.reuse) {
    const byReason = new Map<string, number>();
    for (const l of Object.values(c.reuse.rules)) if (l.rule === "asked") byReason.set(l.reason ?? "unknown", (byReason.get(l.reason ?? "unknown") ?? 0) + 1);
    lines.push(`rule check asked again, by reason: ${byReason.size === 0 ? "none" : [...byReason].sort(([a], [b]) => a.localeCompare(b)).map(([r, n]) => `${r} ${n}`).join(", ")}.`);
  }
  if (c.kind === "held") lines.push(`rule check: would HOLD before any request (${c.reasonCodes.join(", ")}).`);
  else {
    lines.push(`rule check requests: ${c.check}; trigger check requests: ${c.trigger}; intention-to-stay requests: ${c.polarity}; repair requests at most ${c.repairAtMost}.`);
    lines.push(`rule check planned: ${c.check + c.trigger + c.polarity} request(s), at most ${c.check + c.trigger + c.polarity + c.repairAtMost} with repairs (each may take its one retry for a transient provider failure).`);
  }
  // On its own line: the question wording check has no reuse (deferred, #463): every item is asked.
  lines.push(`question wording check (no reuse, #463; every item asked): ${plan.questionCheck.ifSameLeftOut} request(s) if the same rules are left out as in version ${plan.fromVersion}; at most ${plan.questionCheck.atMost}; quotes shortened ${plan.questionCheck.shortenedQuotes}.`);
  return lines;
}

// ============================================
// The run (dry run, or the write)
// ============================================

/** Everything a run reads and writes outside its inputs (the CLI wires the real ones; tests inject fakes). */
export interface DeriveRunDeps {
  // The head of the rulebook on the target project (or from the `--head` file offline).
  readHead: (routeKey: string) => Promise<RubricHead | null>;
  // The narrow pending write (`RubricStore.writeDerivedPendingVersion`). Absent = no write possible.
  writeDerived?: (draft: Omit<VisaRubric, "version">, opts: { baseVersion: number; baseFingerprint: string }) => Promise<import("../rubric.store").DerivedWriteResult>;
  // What the plan reads; absent = no plan printed.
  plan?: PlanSources;
  // (#440 fix round 1) The publish settings of the TARGET project (`appConfig/rubricPublishSettings`). Read
  // before any write: absent (offline) or unreadable means a write is refused (see `autoPublishOn`).
  readPublishSettings?: () => Promise<import("../rubric-publish-settings").LoadedPublishSettings>;
  // The creation time of version 2 (the write only).
  now: () => unknown;
  print: (line: string) => void;
}

/**
 * (#440 fix round 1) True when creating version 2 on the target would let the AUTOMATIC paths check it: the
 * version-created trigger runs the whole pipeline on a new pending version, and the hourly sweep re-runs a
 * held one, both WITHOUT `reuseFrom`, so every rule would be sent to the models (a whole-rulebook spend) and
 * the trigger could publish version 2 before the reuse run. That happens when the publish mode is `auto` and
 * this route is allowed. Settings that could not be read (or were not read at all) count as "on": fail closed.
 * No setting is changed here; the owner sets the mode. Pure.
 */
export function autoPublishOn(loaded: import("../rubric-publish-settings").LoadedPublishSettings | null | undefined, routeKey: string, routeAllowed: (s: import("../rubric-publish-settings").RubricPublishSettings, key: string) => boolean): boolean {
  if (!loaded || loaded.readError !== undefined) return true;
  return loaded.settings.mode === "auto" && routeAllowed(loaded.settings, routeKey);
}

/** What a run did (for tests and the exit code). */
export interface DeriveRunSummary {
  refusal: DeriveRefusal | null;
  changes: DerivedChange[];
  notProven: string[];
  unchanged: number;
  written: boolean;
  alreadyExists: boolean;
  plan: PublishPlan | null;
}

/**
 * Build version 2, print what it contains and the planned requests, and with `write` store it. Prints ids,
 * counts and code words only.
 */
export async function runDerive(inputs: { v1: VisaRubric; out: any; snapshot: GuidanceSnapshotContent }, opts: { write: boolean }, deps: DeriveRunDeps): Promise<DeriveRunSummary> {
  const summary: DeriveRunSummary = { refusal: null, changes: [], notProven: [], unchanged: 0, written: false, alreadyExists: false, plan: null };
  const stop = (code: DeriveRefusal): DeriveRunSummary => {
    summary.refusal = code;
    deps.print(`refused (${code}); nothing was written.`);
    return summary;
  };

  const built = deriveVersion(inputs.v1, inputs.out, inputs.snapshot);
  if (!built.ok) return stop(built.refusal);
  summary.changes = built.changes;
  summary.notProven = built.notProven;
  summary.unchanged = built.unchanged;

  // ---- the head on the target: version 1 must be both the approved and the latest version ----
  const head = await deps.readHead(inputs.v1.routeKey);
  if (!head) return stop("no_head");
  const v2Number = CHECK_REUSE_PAIR.toVersion;
  const alreadyThere = head.approvedVersion === CHECK_REUSE_PAIR.fromVersion && head.latestVersion === v2Number;
  if (!alreadyThere && (head.approvedVersion !== CHECK_REUSE_PAIR.fromVersion || head.latestVersion !== CHECK_REUSE_PAIR.fromVersion)) return stop("head_moved");
  if (!head.latestSourceSetHash || head.latestSourceSetHash !== built.draft.sourceSetHash) return stop("source_set_differs");

  // ---- what version 2 contains (ids and code words only) ----
  deps.print(`${inputs.v1.routeKey}: version ${v2Number} built from version ${CHECK_REUSE_PAIR.fromVersion} (0 model calls).`);
  for (const ch of built.changes) deps.print(`  ${ch.criterionId}: ${ch.why}`);
  for (const id of built.notProven) deps.print(`  ${id}: list_not_proven (${built.notProvenWhy[id]}; left as in version ${CHECK_REUSE_PAIR.fromVersion}, so the check leaves it out as checker:source_text)`);
  deps.print(`  unchanged rules: ${built.unchanged}; questions added: ${built.questionsAdded}; competence steps: ${built.draft.competence?.steps.length ?? 0}.`);

  // ---- the planned requests of its publish ----
  if (deps.plan) {
    summary.plan = await planPublish(inputs.v1, { ...(built.draft as VisaRubric), version: v2Number }, deps.plan);
    for (const l of planLines(summary.plan)) deps.print(`  ${l}`);
  }

  return finishRun(summary, { pair: CHECK_REUSE_PAIR, alreadyThere, draft: built.draft, base: inputs.v1 }, opts, deps, stop);
}

/**
 * The part of a run shared by both modes once the new version is built and its plan printed (#440; #461 made it
 * take the pair, so the same-rules mode uses exactly the same guards): a version already there is reported and
 * nothing is written; the target's publish settings are read and `auto_publish_on` refuses a write (a line in a
 * dry run); then, with `write`, the narrow pending write over the pair's base version, with its fingerprint.
 */
async function finishRun(
  summary: DeriveRunSummary,
  args: { pair: Readonly<CheckReusePair>; alreadyThere: boolean; draft: Omit<VisaRubric, "version" | "createdAt">; base: VisaRubric },
  opts: { write: boolean },
  deps: DeriveRunDeps,
  stop: (code: DeriveRefusal) => DeriveRunSummary
): Promise<DeriveRunSummary> {
  const { pair } = args;
  if (args.alreadyThere) {
    summary.alreadyExists = true;
    deps.print(`a version ${pair.toVersion} already exists on the target (not compared with this build); nothing was written.`);
    return summary;
  }

  // ---- (#440 fix round 1) automatic publishing must be off for this route before the new version exists ----
  // Read on every run that can reach the project; offline it is not read, and a write is impossible there.
  const { routeAllowed } = await import("../rubric-publish-settings");
  let loaded: import("../rubric-publish-settings").LoadedPublishSettings | null | undefined;
  if (deps.readPublishSettings) {
    try {
      loaded = await deps.readPublishSettings();
    } catch {
      loaded = null;
    }
  }
  const autoOn = autoPublishOn(loaded, args.base.routeKey, routeAllowed);
  if (autoOn) {
    const why = loaded === undefined ? "publish settings not read (offline)" : loaded === null || loaded.readError !== undefined ? "publish settings unreadable" : "publish mode auto and this route allowed";
    // The dry run says so as a refusal line and goes on; the write stops here.
    if (opts.write) return stop("auto_publish_on");
    deps.print(`a write would be refused (auto_publish_on: ${why}). Keep the publish mode manual until the publish:rubric --reuse-check-from ${pair.fromVersion} run has finished.`);
  } else deps.print("  publish settings: automatic publishing does not apply to this route (a write may go ahead).");
  if (!opts.write) {
    deps.print(`\n(dry run: nothing was written. Add --write to store version ${pair.toVersion} as a pending draft.)`);
    return summary;
  }
  if (!deps.writeDerived) return stop("no_store");

  // ---- the write: pending only, through the store's narrow path, over the pair's base version ----
  const { derivedBaseFingerprint } = await import("../rubric.store");
  const result = await deps.writeDerived({ ...args.draft, createdAt: deps.now() } as Omit<VisaRubric, "version">, { baseVersion: pair.fromVersion, baseFingerprint: derivedBaseFingerprint(args.base) });
  if (result.written) {
    summary.written = true;
    deps.print(`stored version ${result.version} as a pending draft; the head's approved version stays ${pair.fromVersion}.`);
    return summary;
  }
  if (result.reason === "already_exists") {
    summary.alreadyExists = true;
    deps.print(`a version ${result.version} already exists on the target (not compared with this build); nothing was written.`);
    return summary;
  }
  return stop(result.reason);
}

// ============================================
// (#461) Same-rules mode: version 3 as a copy of the approved version 2
// ============================================

/** What `deriveSameRules` builds (pure; no I/O). */
export type SameRulesOutcome = { ok: false; refusal: DeriveRefusal } | { ok: true; draft: Omit<VisaRubric, "version" | "createdAt"> };

/**
 * Build version 3 from the approved version 2 of the one rulebook in `CHECK_REUSE_PAIR_V3`. Pure: no project,
 * no model, no `--out` file. Every content field is version 2's own (rules, questions, document items, the
 * `competence` block, the polarity proposal, the sources), copied as it is; only the version number, the creation
 * time and the review and approval fields (`RUBRIC_REVIEW_FIELDS`) are not carried: the review fields take their
 * pending initial values and every other one is absent, so the publish pipeline decides all of them again.
 * Refusals (code words): `rulebook_not_allowed`, `not_a_shared_rulebook`, `version_not_allowed`,
 * `base_not_approved`, `version_file_split` (a split version's header holds no rules: the whole version is needed).
 */
export function deriveSameRules(v2: VisaRubric): SameRulesOutcome {
  const refuse = (refusal: DeriveRefusal): SameRulesOutcome => ({ ok: false, refusal });
  if (!v2 || v2.routeKey !== CHECK_REUSE_PAIR_V3.routeKey) return refuse("rulebook_not_allowed");
  const parts = splitRulebookKey(v2.routeKey);
  if (!parts.ok || parts.authorityIdKind !== "group") return refuse("not_a_shared_rulebook");
  if (v2.version !== CHECK_REUSE_PAIR_V3.fromVersion) return refuse("version_not_allowed");
  if (v2.reviewStatus !== "approved") return refuse("base_not_approved");
  if (!Array.isArray(v2.criteria) || (v2 as any).contentStorage !== undefined) return refuse("version_file_split");
  // Everything of version 2 but its number, its creation time and its review and approval fields.
  const base: Record<string, unknown> = { ...(v2 as unknown as Record<string, unknown>) };
  delete base.version;
  delete base.createdAt;
  for (const f of RUBRIC_REVIEW_FIELDS) delete base[f];
  // Served-side only: never stored.
  delete base.stackLayers;
  return { ok: true, draft: { ...base, ...INITIAL_REVIEW_VALUES } as unknown as Omit<VisaRubric, "version" | "createdAt"> };
}

/**
 * (#461) Build version 3, print what it is and the planned requests of `publish:rubric --reuse-check-from 2`
 * (with `via`, version 1, for the check's one hop back), and with `write` store it. The head on the target must
 * have version 2 as both its approved and its latest version (or version 3 as the latest: reported, nothing
 * written). Prints ids, counts and code words only.
 */
export async function runSameRules(inputs: { v2: VisaRubric; via?: VisaRubric }, opts: { write: boolean }, deps: DeriveRunDeps): Promise<DeriveRunSummary> {
  const pair = CHECK_REUSE_PAIR_V3;
  const summary: DeriveRunSummary = { refusal: null, changes: [], notProven: [], unchanged: 0, written: false, alreadyExists: false, plan: null };
  const stop = (code: DeriveRefusal): DeriveRunSummary => {
    summary.refusal = code;
    deps.print(`refused (${code}); nothing was written.`);
    return summary;
  };
  const built = deriveSameRules(inputs.v2);
  if (!built.ok) return stop(built.refusal);
  summary.unchanged = built.draft.criteria.length;

  // ---- the head on the target: version 2 must be both the approved and the latest version ----
  const head = await deps.readHead(inputs.v2.routeKey);
  if (!head) return stop("no_head");
  const alreadyThere = head.approvedVersion === pair.fromVersion && head.latestVersion === pair.toVersion;
  if (!alreadyThere && (head.approvedVersion !== pair.fromVersion || head.latestVersion !== pair.fromVersion)) return stop("head_moved");
  if (!head.latestSourceSetHash || head.latestSourceSetHash !== built.draft.sourceSetHash) return stop("source_set_differs");

  // ---- what version 3 is (counts only) ----
  const v3 = { ...(built.draft as VisaRubric), version: pair.toVersion };
  deps.print(`${inputs.v2.routeKey}: version ${pair.toVersion} built as a copy of version ${pair.fromVersion} (same rules; 0 model calls).`);
  deps.print(`  rules ${v3.criteria.length} (differing from version ${pair.fromVersion}: ${rulesThatDiffer(inputs.v2, v3).length}); questions ${v3.intakeQuestions?.length ?? 0}; document items ${v3.evidenceItems?.length ?? 0}; competence steps: ${v3.competence?.steps.length ?? 0}.`);

  // ---- the planned requests of its publish ----
  if (deps.plan) {
    if (!inputs.via) deps.print(`  plan: version ${pair.viaVersion} not given (--via), so the check would hold (checker_reuse_refused:via_mismatch).`);
    summary.plan = await planPublish(inputs.v2, v3, deps.plan, inputs.via);
    for (const l of planLines(summary.plan)) deps.print(`  ${l}`);
  }
  return finishRun(summary, { pair, alreadyThere, draft: built.draft, base: inputs.v2 }, opts, deps, stop);
}

// ============================================
// CLI
// ============================================

/** Value of `--name value` or `--name=value`, or undefined. */
const arg = (name: string): string | undefined => {
  const a = process.argv.slice(2);
  const eq = a.find((x) => x.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const i = a.indexOf(`--${name}`);
  return i >= 0 && i + 1 < a.length && !a[i + 1].startsWith("--") ? a[i + 1] : undefined;
};

/** Read a JSON input file (Firestore REST or plain). */
const readJson = (path: string): any => fromFirestoreRest(JSON.parse(readFileSync(path, "utf8")));

/** The command line: check the project, read the files, wire the real reads (and write), run. */
async function main(): Promise<void> {
  const write = process.argv.includes("--write");
  const offline = process.argv.includes("--offline");
  const project = arg("project");
  const problem = projectProblem(project, process.env) ?? (offline && write ? "offline_with_write" : null);
  if (problem) {
    console.error(`derive-version-from-one-rule: refused (${problem}); nothing was written. Name the target with --project <id> (never ${PRODUCTION_PROJECT}).`);
    process.exit(2);
  }
  // (#461) `--same-rules`: version 3 as a copy of version 2 (no `--out`; `--via` is version 1, for the plan).
  const sameRules = process.argv.includes("--same-rules");
  const versionPath = arg("version");
  const outPath = arg("out");
  const pagePath = arg("page");
  const viaPath = arg("via");
  if (sameRules && (!versionPath || !pagePath || !viaPath || (offline && (!arg("head") || !arg("checker") || !arg("via-checker"))))) {
    console.error("usage: --same-rules --project <id> --version <v2.json> --via <v1.json> --page <page.json> [--offline --head <head.json> --checker <check-record-v2.json> --via-checker <check-record-v1.json>] [--write]");
    process.exit(2);
  }
  if (!sameRules && (!versionPath || !outPath || !pagePath || (offline && (!arg("head") || !arg("checker"))))) {
    console.error("usage: --project <id> --version <v1.json> --out <result.json> --page <page.json> [--offline --head <head.json> --checker <check-record.json>] [--write]");
    process.exit(2);
  }
  // Set BEFORE Firebase Admin loads, so it can never initialise against an unintended default. Offline, a
  // placeholder id lets the service modules load; nothing reaches any project.
  process.env.GCLOUD_PROJECT = offline ? "derive-offline" : (project as string);
  process.env.GOOGLE_CLOUD_PROJECT = process.env.GCLOUD_PROJECT;
  const v1 = readJson(versionPath as string) as VisaRubric;
  const out = sameRules ? null : readJson(outPath as string);
  const snapshot = readJson(pagePath as string) as GuidanceSnapshotContent;
  // (#461) Same-rules mode: `--version` is version 2 (the base), `--via` version 1.
  const via = sameRules ? (readJson(viaPath as string) as VisaRubric) : undefined;
  /** The snapshot from the file when it is the one asked for (the plan reads it); else the project's store. */
  const readSnapshot = async (sourceId: string, contentHash: string): Promise<GuidanceSnapshotContent> => {
    if (sourceId === snapshot.sourceId && contentHash === snapshot.contentHash) return snapshot;
    if (offline) throw new Error("offline: only the --page snapshot is available");
    const { guidanceSnapshotStore } = await import("../../guidance/guidance-snapshot.store");
    return guidanceSnapshotStore.read(sourceId, contentHash);
  };
  const { DEFAULT_PUBLISH_SETTINGS, loadPublishSettings } = await import("../rubric-publish-settings");
  let deps: DeriveRunDeps;
  if (offline) {
    const head = readJson(arg("head") as string) as RubricHead;
    const record = readJson(arg("checker") as string);
    // (#461) Same-rules mode: the hop's record too (version 1's), served only under its own run id.
    const viaRecord = sameRules ? readJson(arg("via-checker") as string) : null;
    deps = {
      readHead: async (key) => (head.routeKey === key ? head : null),
      plan: {
        loadSettings: async () => ({ settings: { ...DEFAULT_PUBLISH_SETTINGS }, exists: false, problems: [] }),
        loadCheckerRecord: async (runId) => (record?.runId === runId ? record : viaRecord?.runId === runId ? viaRecord : null),
        readSnapshot,
      },
      now: () => null,
      print: (l) => console.log(l),
    };
  } else {
    const { rubricStore } = await import("../rubric.store");
    const { firestoreCheckerLedger } = await import("../rubric-checker");
    const { Timestamp } = await import("firebase-admin/firestore");
    const emulator = process.env.FIRESTORE_EMULATOR_HOST || "";
    console.log(`project ${project}${emulator ? ` (emulator ${emulator})` : ""}: ${write ? `WRITE: version ${sameRules ? CHECK_REUSE_PAIR_V3.toVersion : CHECK_REUSE_PAIR.toVersion} is stored as a pending draft if every check passes` : "DRY RUN: reads only, nothing is written"}.`);
    deps = {
      readHead: (key) => rubricStore.getHead(key),
      writeDerived: (draft, o) => rubricStore.writeDerivedPendingVersion(draft, o),
      readPublishSettings: loadPublishSettings,
      plan: { loadSettings: loadPublishSettings, loadCheckerRecord: (runId) => firestoreCheckerLedger.load(runId), readSnapshot },
      now: () => Timestamp.now(),
      print: (l) => console.log(l),
    };
  }
  const summary = sameRules ? await runSameRules({ v2: v1, via }, { write }, deps) : await runDerive({ v1, out, snapshot }, { write }, deps);
  if (summary.refusal) process.exit(1);
}

// Run only when started as a script, never when a test imports the functions above.
if (require.main === module) {
  main().catch((e) => {
    // The class only: never the message, which can carry a path or a document.
    console.error(`derive-version-from-one-rule failed: ${(e as Error).constructor.name}`);
    process.exit(1);
  });
}
