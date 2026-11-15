/**
 * Re-draft ONE saved rule of a published SHARED rulebook, draft the competence steps that rest on
 * it ("which member country examines the application"), and check the rule, WITHOUT re-drafting
 * the rulebook (issue #335). Nothing is written to Firestore, Storage or any project: the result is
 * a local JSON file for the person who decides what happens next.
 *
 * WHY: version 1 of a shared rulebook can lack its competence block because the drafting prompt
 * that made it predates competence steps, and because a lead-in rule's list was cut by code to its
 * first marker ("(a)"). Re-drafting the whole rulebook would cost a whole extraction. This script
 * spends on the ONE rule only, through the production code paths:
 *
 *   0. offline (always): the rule's quote is located in the saved snapshot; its list lines are read
 *      FROM THE SNAPSHOT by code (`readLeadInList`) and proved verbatim (`verifyListItems`); the
 *      aspects the check did not confirm are read from its stored letters (`--verdicts`) through
 *      the production mapping; every request a live run would send is BUILT (never sent) and
 *      listed with its role and size.
 *   1. re-draft (`RubricExtractionService.redraftRule`, the repair prompt): ONE request, only when
 *      the stored letters fail an aspect. The replacement is validated like any drafted rule.
 *   2. competence steps (`RubricExtractionService.draftCompetenceSteps`, production call 2 on the
 *      rule's own passage): ONE request. Code builds the block and keeps it only when EVERY step
 *      passes `competenceProblems` (each step rests on this rule; its words are verbatim in the
 *      quote or one list line; its question lists the route's members from membership data; its
 *      result comes from the applicant's answer, never worked out).
 *   3. the independent check of the rule (`RubricCheckerService.check`, production table): ONE
 *      request for an ordinary rule (two for a protected rule, which both models read).
 *   Every call gets the production's one retry for a transient provider failure, so the most a
 *   live run can send is twice the planned figure. A refused or unrepairable re-draft, or a block
 *   code refuses, STOPS the run: nothing after it is sent.
 *
 * OFFLINE BY DEFAULT: without `--live` no model is called (0 requests) and the planned requests
 * are printed. `--live` is the ONLY model use. The key is read from `.env.local`
 * (`ANTHROPIC_API_KEY`) by node, never printed.
 *
 * WHAT IT NEVER DOES: write to any project, publish, change a setting, the allowlist or a gate,
 * skip or weaken the check, type a legal word (every stored word comes from the snapshot or from
 * the model through the production validation), or infer anything for an applicant.
 *
 * Files (read-only inputs; both may be Firestore REST JSON or plain JSON):
 *   --page     the stored guidance snapshot the rule cites ({ text, sourceId, contentHash, url, ... });
 *              its sha256 must equal its contentHash, and the rule's `source.contentHash`
 *   --version  the published version document (`visaRubrics/{key}/rubricVersions/{n}`)
 *   --rule     the rule's criterionId
 *   --verdicts the check's six stored letters for the rule (`rubricCheckerRuns/{key}__v{n}`,
 *              `ruleVerdicts.<id>.verification`); absent = every aspect is sent as not confirmed
 *   --route    the route name shown to the model (default "the route")
 *   --out      live only: where to write the result JSON (default: print a summary only)
 *
 * Run (from functions/):
 *   npm run redraft:competence-rule -- --page <snapshot.json> --version <v1.json> --rule <id> --verdicts <letters> [--route <name>] [--live --out <result.json>]
 *
 * OUTPUT: ids, roles, counts, sizes, code words and verdict letters ONLY. Never a quote, a title,
 * model text, a key or an error message (an unexpected failure prints its class).
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import type { AssessmentCriterion, CompetenceBlock, IntakeQuestion, VisaRubric } from "../../../types/rubric";
import type { GuidanceSnapshotContent } from "../../guidance/types";
import type { LlmProvider, LlmRequest, LlmResponse } from "../../../services/ai/llm-provider";
import type { AiModelRole } from "../../../services/ai/ai-models";
import { SnapshotQuoteIndex } from "../rubric-quote";
import { readLeadInList, verifyListItems } from "../rubric-list-items";
import { competenceProblems } from "../rubric-competence";
import { REPAIR_WINDOW_CHARS, REPAIR_WINDOW_LINES_AFTER, REPAIR_WINDOW_LINES_BEFORE, isBar } from "../rubric-repair";
import { aspectsToRepair } from "./repair-saved-rule";

// ============================================
// Inputs
// ============================================

/**
 * Turn a Firestore REST document (`{ name, fields: { x: { stringValue } } }`) into plain JSON.
 * A plain JSON object (no `fields` wrapper) is returned as it is. Timestamps stay ISO strings.
 */
export function fromFirestoreRest(doc: any): any {
  /** One typed value -> plain value. */
  const value = (v: any): any => {
    if (v === null || typeof v !== "object") return v;
    if ("mapValue" in v) return Object.fromEntries(Object.entries(v.mapValue.fields ?? {}).map(([k, x]) => [k, value(x)]));
    if ("arrayValue" in v) return (v.arrayValue.values ?? []).map(value);
    if ("integerValue" in v) return Number(v.integerValue);
    if ("doubleValue" in v) return Number(v.doubleValue);
    if ("booleanValue" in v) return v.booleanValue;
    if ("nullValue" in v) return null;
    if ("stringValue" in v) return v.stringValue;
    if ("timestampValue" in v) return v.timestampValue;
    throw new Error(`unsupported Firestore value type: ${Object.keys(v).join(",")}`);
  };
  if (doc && typeof doc === "object" && doc.fields && typeof doc.fields === "object" && !Array.isArray(doc.fields)) {
    return Object.fromEntries(Object.entries(doc.fields).map(([k, x]) => [k, value(x)]));
  }
  return doc;
}

/** Everything the run needs from outside: output, and (live only) the provider. */
export interface CompetenceRuleRunOptions {
  live: boolean;
  routeName?: string;
  // The check's stored letters for the rule (six, aspect order); absent = every aspect is not confirmed.
  verdicts?: string;
  // Called with each output line (ids, roles, counts, sizes, code words, letters only).
  print: (line: string) => void;
  // Live only: the model provider (the real one from the CLI, a scripted one in tests).
  provider?: LlmProvider;
}

/** One request a live run would send, as planned offline. */
export interface PlannedRequest {
  step: "redraft" | "competence_steps" | "check";
  role: AiModelRole;
  // Characters of prompt (system + user) when the request can be built offline; null when it
  // depends on an earlier answer (the check reads the re-drafted rule).
  chars: number | null;
}

/** What a run did, for tests and the summary line. */
export interface CompetenceRuleRunSummary {
  // Why the run stopped before any spend (a code word), or null.
  refusedOffline: string | null;
  listLinesStored: number;
  listLinesRead: number;
  storedListVerifies: boolean;
  aspects: string[];
  planned: PlannedRequest[];
  // Live only.
  requests: number;
  redraft: string | null;
  competence: string | null;
  competenceProblems: string[];
  checkLetters: string | null;
  checkPasses: boolean | null;
  // Live only: the result a person reviews (the replacement rule, the questions the block reads, the block).
  result: { rule: AssessmentCriterion; intakeQuestions: IntakeQuestion[]; competence: CompetenceBlock; renamedQuestionIds: Record<string, string> } | null;
}

/** A provider that counts the requests that go through it. */
class CountingProvider implements LlmProvider {
  requests = 0;
  constructor(private readonly inner: LlmProvider) {}
  modelFor(role: AiModelRole): string {
    return this.inner.modelFor(role);
  }
  complete(request: LlmRequest): Promise<LlmResponse> {
    this.requests += 1;
    return this.inner.complete(request);
  }
}

// ============================================
// Composition (pure)
// ============================================

/**
 * Put the new questions next to the version's own, without ever changing one of the version's
 * questions. A new question whose id is already taken by a DIFFERENT question of the version gets
 * a fresh id (`<id>__c`, `<id>__c2`, ...), and every reference to it in the new questions' show
 * conditions and in the block's steps is renamed with it. Ids are internal handles: renaming one
 * changes no wording, option or rule.
 */
export function placeQuestions(existing: readonly IntakeQuestion[], added: readonly IntakeQuestion[], block: CompetenceBlock): { intakeQuestions: IntakeQuestion[]; competence: CompetenceBlock; renamed: Record<string, string> } {
  const taken = new Set(existing.map((q) => q.id));
  const renamed: Record<string, string> = {};
  for (const q of added) {
    if (!taken.has(q.id)) {
      taken.add(q.id);
      continue;
    }
    let n = 1;
    let id = `${q.id}__c`;
    while (taken.has(id)) id = `${q.id}__c${++n}`;
    renamed[q.id] = id;
    taken.add(id);
  }
  const ren = (id: string): string => renamed[id] ?? id;
  const questions = added.map((q) => ({
    ...q,
    id: ren(q.id),
    ...(q.showWhen ? { showWhen: { anyOf: q.showWhen.anyOf.map((c) => ({ ...c, questionId: ren(c.questionId) })) } } : {}),
  }));
  const competence: CompetenceBlock = {
    steps: block.steps.map((s) => ({ ...s, questionId: ren(s.questionId), ...(s.when ? { when: s.when.map((c) => ({ ...c, questionId: ren(c.questionId) })) } : {}) })),
  };
  return { intakeQuestions: [...existing, ...questions], competence, renamed };
}

// ============================================
// The run
// ============================================

/**
 * Run the offline half for the rule, and (with `live`) the re-draft, the competence call and the
 * check. Pure of process state: the CLI below only parses arguments and builds the real provider.
 */
export async function runCompetenceRule(snapshot: GuidanceSnapshotContent, version: VisaRubric, ruleId: string, opts: CompetenceRuleRunOptions): Promise<CompetenceRuleRunSummary> {
  const summary: CompetenceRuleRunSummary = {
    refusedOffline: null, listLinesStored: 0, listLinesRead: 0, storedListVerifies: false, aspects: [], planned: [],
    requests: 0, redraft: null, competence: null, competenceProblems: [], checkLetters: null, checkPasses: null, result: null,
  };
  const stop = (code: string): CompetenceRuleRunSummary => {
    summary.refusedOffline = code;
    opts.print(`${ruleId}: refused before any spend (${code}).`);
    return summary;
  };

  // ---- 0a. the inputs agree with each other (never a guess about which page a rule cites) ----
  if (createHash("sha256").update(snapshot.text).digest("hex") !== snapshot.contentHash) return stop("snapshot_hash_mismatch");
  const stored = (version.criteria ?? []).find((c) => c.criterionId === ruleId);
  if (!stored) return stop("rule_not_in_version");
  if (stored.source.contentHash !== snapshot.contentHash || stored.source.sourceId !== snapshot.sourceId) return stop("rule_cites_another_snapshot");
  if (!version.authorityId) return stop("not_a_shared_rulebook");
  if (version.competence) return stop("version_already_has_a_competence_block");

  // ---- 0b. the quote, and its list lines read from the snapshot by code ----
  const index = new SnapshotQuoteIndex(snapshot);
  const found = index.locate(stored.source.quote);
  if (!found.ok) return stop(`quote_${found.reason}`);
  const read = readLeadInList(index, found);
  summary.listLinesStored = stored.source.listItems?.length ?? 0;
  summary.storedListVerifies = stored.source.listItems !== undefined && verifyListItems(index, found, stored.source.listItems).ok;
  if (read.kind === "unreadable") return stop(`list_not_readable:${read.reason}`);
  const listItems = read.kind === "items" && verifyListItems(index, found, read.items).ok ? read.items : undefined;
  if (read.kind === "items" && !listItems) return stop("list_items_not_in_snapshot");
  summary.listLinesRead = listItems?.length ?? 0;
  // The rule as code reads it from the snapshot today: the stored rule with its list lines re-attached (nothing else changes).
  const rule: AssessmentCriterion = { ...stored, source: { ...stored.source, quote: found.matched, ...(listItems ? { listItems } : {}) } };
  if (!listItems) delete (rule.source as any).listItems;

  // ---- 0c. what a re-draft would be told, and the requests a live run would send ----
  summary.aspects = await aspectsToRepair(rule, opts.verdicts);
  const { competenceStepsRequest } = await import("../rubric-extraction.service");
  const { DEFAULT_PUBLISH_SETTINGS } = await import("../rubric-publish-settings");
  const limits = { maxOutputTokens: DEFAULT_PUBLISH_SETTINGS.checkerMaxOutputTokensPerRequest, timeoutMs: DEFAULT_PUBLISH_SETTINGS.checkerRequestTimeoutMs };
  const routeName = opts.routeName ?? "the route";
  const window = index.passageWindow(found, REPAIR_WINDOW_LINES_BEFORE, REPAIR_WINDOW_LINES_AFTER, REPAIR_WINDOW_CHARS);
  // The re-draft request is built inside `redraftRule` from the same window; its size is the window plus the prompt.
  if (summary.aspects.length > 0) summary.planned.push({ step: "redraft", role: "judgement", chars: null });
  // The competence request, built from the rule as it stands (a live run builds it from the replacement).
  const comp = competenceStepsRequest(rule, index, routeName, limits, []);
  if ("notFound" in comp) return stop(`quote_${comp.notFound}`);
  summary.planned.push({ step: "competence_steps", role: comp.request.role, chars: comp.request.system.length + comp.request.user.length });
  // The check: one batch for an ordinary rule (verification model), one per model for a protected one.
  summary.planned.push({ step: "check", role: "verification", chars: null });
  const { isProtectedRule } = await import("../rubric-gates");
  if (isProtectedRule(rule)) summary.planned.push({ step: "check", role: "judgement", chars: null });

  opts.print(
    `${ruleId}: quote found; ${isBar(rule) ? "bar" : "ordinary"}${isProtectedRule(rule) ? " (protected)" : ""}, kind ${rule.kind}; ` +
    `stored list lines ${summary.listLinesStored} (verify against the snapshot: ${summary.storedListVerifies ? "yes" : "no"}); list lines read now ${summary.listLinesRead}; ` +
    `old letters ${opts.verdicts ?? "none"}; aspects a re-draft would be told: ${summary.aspects.length > 0 ? summary.aspects.join(",") : "none"}; window ${window.text.length} characters.`
  );
  summary.planned.forEach((p, i) => opts.print(`  planned request ${i + 1}: ${p.step}, role ${p.role}${p.chars !== null ? `, ${p.chars} characters` : ""}`));
  opts.print(`  planned: ${summary.planned.length} request(s); at most ${summary.planned.length * 2} if every one needs its one retry for a transient provider failure.`);

  if (!opts.live) {
    opts.print(`\n(offline: 0 model calls. Add --live to send the ${summary.planned.length} planned request(s).)`);
    return summary;
  }
  if (!opts.provider) throw new Error("live run without a provider");

  // ---- live half: the ONLY place a model is called ----
  const provider = new CountingProvider(opts.provider);
  const { RubricExtractionService } = await import("../rubric-extraction.service");
  const { RubricCheckerService, failedAspectsOf } = await import("../rubric-checker");
  const { decodeRow } = await import("../rubric-checker-prompt");
  const drafter = new RubricExtractionService({ provider });
  const usage = { requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  const done = (): CompetenceRuleRunSummary => {
    summary.requests = provider.requests;
    opts.print(`\n${ruleId}: re-draft ${summary.redraft ?? "not sent"}; competence ${summary.competence ?? "not sent"}; check ${summary.checkLetters ?? "not sent"}${summary.checkPasses === null ? "" : summary.checkPasses ? " (passes)" : " (does NOT pass)"}; ${summary.requests} request(s) made.`);
    return summary;
  };

  // 1. the re-draft (only when an aspect failed): a refusal stops the run.
  let replacement = rule;
  if (summary.aspects.length > 0) {
    try {
      const outcome = await drafter.redraftRule({ rule, aspects: summary.aspects, index, routeName, limits, sent: { chars: 0 } }, usage as any, { failed: 0, cap: 3 });
      if (outcome.kind !== "replacement") {
        summary.redraft = outcome.kind === "invalid" ? `refused:${outcome.detail}` : outcome.kind;
        return done();
      }
      replacement = outcome.criterion;
      summary.redraft = "replacement";
    } catch (e) {
      summary.redraft = `failed:${(e as Error).constructor.name}`;
      return done();
    }
  }

  // 2. the competence steps on the replacement: a block code refuses stops the run.
  let block: CompetenceBlock;
  let added: IntakeQuestion[];
  try {
    const outcome = await drafter.draftCompetenceSteps({ rule: replacement, index, routeName, limits, known: [] }, usage as any, { failed: 0, cap: 3 });
    if (outcome.kind !== "steps") {
      summary.competence = outcome.kind === "invalid" ? `refused:${outcome.detail}` : "no_steps_proposed";
      return done();
    }
    block = outcome.competence;
    // Only the questions the block (or a question it shows) needs; nothing else is added to the version.
    added = outcome.intakeQuestions;
    summary.competence = `${block.steps.length} step(s), ${added.length} question(s)`;
  } catch (e) {
    summary.competence = `failed:${(e as Error).constructor.name}`;
    return done();
  }
  const placed = placeQuestions(version.intakeQuestions ?? [], added, block);
  // The rule reads the block's questions (as drafting links them), so neither is removed as unjustified.
  const linked: AssessmentCriterion = { ...replacement, intakeQuestionIds: [...new Set([...(replacement.intakeQuestionIds ?? []), ...placed.competence.steps.map((s) => s.questionId)])] };
  const candidate = { criteria: (version.criteria ?? []).map((c) => (c.criterionId === ruleId ? linked : c)), intakeQuestions: placed.intakeQuestions, competence: placed.competence };
  summary.competenceProblems = competenceProblems(candidate, { sharedRulebook: true }).map((p) => p.code);
  if (summary.competenceProblems.length > 0) {
    summary.competence += `; refused on the version: ${[...new Set(summary.competenceProblems)].join(",")}`;
    return done();
  }

  // 3. the production check of the replacement (no repair of its own: cap 0).
  const records = new Map<string, any>();
  const checker = new RubricCheckerService({
    provider: () => provider,
    readSnapshot: async () => snapshot,
    loadSettings: async () => ({ settings: { ...DEFAULT_PUBLISH_SETTINGS, mode: "auto", repairMaxRulesPerRun: 0 }, exists: true, problems: [] }),
    ledger: { load: async (id) => records.get(id) ?? null, save: async (rec) => void records.set(rec.runId, rec), countRunsOnDay: async () => 0 },
  });
  const runId = `ONE-RULE_${ruleId}__v1`;
  await checker.check({ routeKey: "ONE-RULE", version: 1, runId, rubric: { routeKey: "ONE-RULE", version: 1, criteria: [linked], intentPolarityProposal: null } as any, codeLeftOutIds: [] });
  const v = records.get(runId)?.ruleVerdicts?.[ruleId] as { verification?: string; judgement?: string } | undefined;
  summary.checkLetters = v ? `${v.verification ?? "none"}${isProtectedRule(linked) ? `/${v.judgement ?? "none"}` : ""}` : "none";
  const rows = isProtectedRule(linked) ? [decodeRow(v?.verification), decodeRow(v?.judgement)] : [decodeRow(v?.verification)];
  summary.checkPasses = v !== undefined && failedAspectsOf(linked, ...rows.map((r) => r ?? undefined)).length === 0;
  summary.result = { rule: linked, intakeQuestions: placed.intakeQuestions.slice((version.intakeQuestions ?? []).length), competence: placed.competence, renamedQuestionIds: placed.renamed };
  return done();
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

/** Print one report line (ids, roles, counts, sizes, code words and letters only; see the header). */
const printLine = (line: string): void => console.log(line);

/** The command line: read the files, build the real provider only for `--live`, write the result only with `--out`. */
async function main(): Promise<void> {
  const pagePath = arg("page");
  const versionPath = arg("version");
  const ruleId = arg("rule");
  if (!pagePath || !versionPath || !ruleId) {
    console.error("usage: --page <stored-page.json> --version <version.json> --rule <criterionId> [--verdicts <letters>] [--route <name>] [--live [--out <result.json>]]");
    process.exit(2);
  }
  // The service modules resolve a storage bucket when loaded, though this script never touches
  // storage or Firestore. A PLACEHOLDER project id (never a real one) lets them load.
  process.env.GCLOUD_PROJECT ??= "one-rule-offline";
  const snapshot = fromFirestoreRest(JSON.parse(readFileSync(pagePath, "utf8"))) as GuidanceSnapshotContent;
  const version = fromFirestoreRest(JSON.parse(readFileSync(versionPath, "utf8"))) as VisaRubric;
  const live = process.argv.includes("--live");
  const provider = live ? new (await import("../../../services/ai/llm-provider")).AnthropicLlmProvider() : undefined;
  const summary = await runCompetenceRule(snapshot, version, ruleId, { live, routeName: arg("route"), verdicts: arg("verdicts"), print: printLine, provider });
  const out = arg("out");
  if (live && out && summary.result) {
    writeFileSync(out, JSON.stringify({ ruleId, requests: summary.requests, checkLetters: summary.checkLetters, checkPasses: summary.checkPasses, ...summary.result }, null, 2));
    console.log("result written to the --out file (nothing was written to any project).");
  }
}

// Run only when started as a script, never when a test imports `runCompetenceRule`.
if (require.main === module) {
  main().catch((e) => {
    // The class only: never the message, which can carry a path.
    console.error(`redraft-competence-rule failed: ${(e as Error).constructor.name}`);
    process.exit(1);
  });
}
