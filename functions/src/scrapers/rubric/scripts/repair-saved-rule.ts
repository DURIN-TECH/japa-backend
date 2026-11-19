/**
 * Re-draft SAVED rules once each from a SAVED snapshot and check the replacements
 * (issues #223, #243): no extraction run, no Firestore, no deploy, nothing written.
 *
 * Use it to MEASURE a change to the drafting instructions on rules the independent
 * check already found wrong, without a full extraction. For every rule in `--rules`
 * (any number, ordinary rules and bars):
 *
 *   1. the rule's quote is looked up in the saved page (the same lookup as a real run);
 *   2. the aspects the check did NOT confirm are read from its stored verdict letters
 *      (`verdicts`, six letters in the checker's aspect order), through the PRODUCTION
 *      mapping (`failedAspectsOf`), so a label the check no longer judges is not asked for;
 *   3. the rule is re-drafted ONCE, from its own source passage, by the production code
 *      (`RubricExtractionService.redraftRule`: the drafting prompt + the REPAIR block, the
 *      answer validated like any drafted rule: verbatim quote, numbers in the quote,
 *      list lines attached from the stored text, never a bar from an ordinary rule);
 *   4. every replacement is checked by the production check (`RubricCheckerService.check`,
 *      batches of 10, no repair of its own), and the verdict letters are printed.
 *
 * OFFLINE BY DEFAULT: without `--live` it only reads the two files and prints, per rule,
 * whether the quote is found, which aspects a re-draft would be told, and the size of the
 * passage window (0 model calls). `--live` is the ONLY model use:
 *   requests = (rules with a failed aspect, one re-draft each)
 *            + ceil(replacements / 10) check requests (+ the same again for bars, which both models read).
 * The key is read from `.env.local` (`ANTHROPIC_API_KEY`) by node, never printed.
 *
 * Files:
 *   --page  a stored guidance snapshot JSON ({ text, pages, sourceId, contentHash, url, fetchedAt, ... })
 *   --rules a JSON array of saved rules: { "criterionId", "title", "kind", "stage", "severity",
 *           "quote", "applicability"?, "applicabilityCondition"?, "appliesTo"?: { "nationalities",
 *           "asWritten", "uncoded"? }, "verdicts"?: "ynyyaa" } (`verdicts`: the check's six letters for the
 *           rule, aspect order title, kind, stage, condition, check, group; without it every
 *           aspect is sent as not confirmed). All rules must be quoted from the one `--page`.
 *   --route optional route name shown to the model (default "the route")
 *
 * Run (from functions/):
 *   npm run build && node --env-file-if-exists=.env.local lib/scrapers/rubric/scripts/repair-saved-rule.js --page <stored-page.json> --rules <rules.json> [--live]
 *
 * OUTPUT: rule ids, verdict letters, aspect names, code words and counts ONLY. Never a title,
 * a quote, model text, a key or an error message (an unexpected failure prints its class).
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { readFileSync } from "node:fs";
import type { AssessmentCriterion } from "../../../types/rubric";
import type { GuidanceSnapshotContent } from "../../guidance/types";
import type { LlmProvider, LlmRequest, LlmResponse } from "../../../services/ai/llm-provider";
import type { AiModelRole } from "../../../services/ai/ai-models";
import { CHECKER_ASPECTS, decodeRow, type CheckerAspect } from "../rubric-checker-prompt";
import { SnapshotQuoteIndex } from "../rubric-quote";
import { readLeadInList, verifyListItems } from "../rubric-list-items";
import { REPAIR_WINDOW_CHARS, REPAIR_WINDOW_LINES_AFTER, REPAIR_WINDOW_LINES_BEFORE, isBar } from "../rubric-repair";

/** A saved rule as the input file holds it (the shape of `recheck-list-and-group.ts`, plus the stored letters). */
export interface SavedRuleInput {
  criterionId: string;
  title: string;
  kind: AssessmentCriterion["kind"];
  stage: AssessmentCriterion["stage"];
  severity: string;
  quote: string;
  applicability?: AssessmentCriterion["applicability"];
  applicabilityCondition?: string;
  appliesTo?: AssessmentCriterion["appliesTo"];
  // The check's stored letters for this rule (six, aspect order); absent = every aspect is "not confirmed".
  verdicts?: string;
}

/** Everything the run needs from outside: output, and (live only) the provider. */
export interface RepairRunOptions {
  live: boolean;
  routeName?: string;
  // Called with each output line. Lines hold ids, letters, aspect names, code words and counts only.
  print: (line: string) => void;
  // Live only: the model provider (the real one from the CLI, a scripted one in tests).
  provider?: LlmProvider;
}

/** What a run did, for tests and the summary line. */
export interface RepairRunSummary {
  rules: number;
  quoteNotFound: number;
  nothingToRepair: number;
  redrafted: number;
  refused: number;
  passed: number;
  requests: number;
}

/** A provider that counts the requests that go through it (the summary's request figure). */
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

/** The aspects a re-draft is told: those the check's stored letters fail under the PRODUCTION mapping (all six without letters). */
export async function aspectsToRepair(rule: AssessmentCriterion, letters: string | undefined): Promise<CheckerAspect[]> {
  // The checker module is loaded here, after `main()` has made sure a (placeholder) project id exists: its imports
  // resolve a storage bucket at load time and throw without one.
  const { failedAspectsOf } = await import("../rubric-checker");
  const row = letters === undefined ? undefined : decodeRow(letters) ?? undefined;
  if (letters !== undefined && !row) return [...CHECKER_ASPECTS];
  return row ? failedAspectsOf(rule, row) : [...CHECKER_ASPECTS];
}

/** Build the stored-rule object the production code works on, from one input entry and the saved page. */
function toCriterion(r: SavedRuleInput, snapshot: GuidanceSnapshotContent, index: SnapshotQuoteIndex): { rule: AssessmentCriterion; listKind: string; listItems: number; windowChars: number } | { notFound: string } {
  const found = index.locate(r.quote);
  if (!found.ok) return { notFound: found.reason };
  // The list lines of a lead-in quote come from the stored text, like at extraction (#222).
  const read = readLeadInList(index, found);
  const listItems = read.kind === "items" && verifyListItems(index, found, read.items).ok ? read.items : undefined;
  const rule = {
    criterionId: r.criterionId, title: r.title, kind: r.kind, stage: r.stage, severity: r.severity,
    applicability: r.applicability, applicabilityCondition: r.applicabilityCondition,
    ...(r.appliesTo ? { appliesTo: r.appliesTo } : {}),
    source: { quote: found.matched, sourceId: snapshot.sourceId, url: snapshot.url, contentHash: snapshot.contentHash, retrievedAt: snapshot.fetchedAt, ...(listItems ? { listItems } : {}) },
    confidence: 1,
  } as AssessmentCriterion;
  const window = index.passageWindow(found, REPAIR_WINDOW_LINES_BEFORE, REPAIR_WINDOW_LINES_AFTER, REPAIR_WINDOW_CHARS);
  return { rule, listKind: read.kind, listItems: listItems?.length ?? 0, windowChars: window.text.length };
}

/**
 * Run the offline half for every rule, and (with `live`) the re-draft and the check of the replacements.
 * Pure of process state: the CLI below only parses arguments and builds the real provider.
 */
export async function runRepairs(snapshot: GuidanceSnapshotContent, inputs: readonly SavedRuleInput[], opts: RepairRunOptions): Promise<RepairRunSummary> {
  const index = new SnapshotQuoteIndex(snapshot);
  const summary: RepairRunSummary = { rules: inputs.length, quoteNotFound: 0, nothingToRepair: 0, redrafted: 0, refused: 0, passed: 0, requests: 0 };
  const ready: { input: SavedRuleInput; rule: AssessmentCriterion; aspects: CheckerAspect[] }[] = [];

  // ---- offline half: what a real run would send, per rule (0 model calls) ----
  for (const input of inputs) {
    const built = toCriterion(input, snapshot, index);
    if ("notFound" in built) {
      summary.quoteNotFound += 1;
      opts.print(`${input.criterionId}: quote NOT found (${built.notFound}); a real run would leave this rule out before any spend.`);
      continue;
    }
    const aspects = await aspectsToRepair(built.rule, input.verdicts);
    const old = input.verdicts ?? "none";
    opts.print(
      `${input.criterionId}: quote found; ${isBar(built.rule) ? "bar" : "ordinary"}, kind ${built.rule.kind}; old letters ${old}; ` +
      `aspects a re-draft would be told: ${aspects.length > 0 ? aspects.join(",") : "none"}; lead-in list ${built.listKind}${built.listItems ? ` (${built.listItems} lines attached)` : ""}; window ${built.windowChars} characters.`
    );
    if (aspects.length === 0) {
      summary.nothingToRepair += 1;
      continue;
    }
    ready.push({ input, rule: built.rule, aspects });
  }

  if (!opts.live) {
    opts.print(`\n(offline: 0 model calls. --live would make ${ready.length} re-draft request(s) and ${Math.ceil(ready.length / 10)} check request(s) per checking model; add --live to run them)`);
    return summary;
  }
  if (!opts.provider) throw new Error("live run without a provider");

  // ---- live half: the ONLY place a model is called ----
  const provider = new CountingProvider(opts.provider);
  const { RubricExtractionService } = await import("../rubric-extraction.service");
  const { RubricCheckerService, failedAspectsOf } = await import("../rubric-checker");
  const { DEFAULT_PUBLISH_SETTINGS } = await import("../rubric-publish-settings");
  const drafter = new RubricExtractionService({ provider });
  const limits = { maxOutputTokens: DEFAULT_PUBLISH_SETTINGS.checkerMaxOutputTokensPerRequest, timeoutMs: DEFAULT_PUBLISH_SETTINGS.checkerRequestTimeoutMs };
  const usage = { requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

  // 1. one re-draft per rule (sequential: a handful of requests, and the order of the output is the input's).
  const replacements: { id: string; criterion: AssessmentCriterion; sameLine: boolean }[] = [];
  const outcomeById = new Map<string, string>();
  for (const { rule, aspects } of ready) {
    try {
      const outcome = await drafter.redraftRule({ rule, aspects, index, routeName: opts.routeName ?? "the route", limits, sent: { chars: 0 } }, usage as any, { failed: 0, cap: 3 });
      if (outcome.kind === "replacement") {
        summary.redrafted += 1;
        replacements.push({ id: rule.criterionId, criterion: outcome.criterion, sameLine: outcome.sameLine === true });
        outcomeById.set(rule.criterionId, "replacement");
      } else {
        summary.refused += 1;
        // A code word only (`detail` is a validator reason code, never model text).
        outcomeById.set(rule.criterionId, outcome.kind === "invalid" ? `refused:${outcome.detail}` : outcome.kind);
      }
    } catch (e) {
      summary.refused += 1;
      outcomeById.set(rule.criterionId, `failed:${(e as Error).constructor.name}`);
    }
  }

  // 2. the production check of ALL replacements at once (batches of 10; no repair of its own: cap 0).
  const verdicts = new Map<string, { verification?: string; judgement?: string }>();
  if (replacements.length > 0) {
    const records = new Map<string, any>();
    const checker = new RubricCheckerService({
      provider: () => provider,
      readSnapshot: async () => snapshot,
      loadSettings: async () => ({ settings: { ...DEFAULT_PUBLISH_SETTINGS, mode: "auto", repairMaxRulesPerRun: 0 }, exists: true, problems: [] }),
      ledger: {
        load: async (id) => records.get(id) ?? null,
        save: async (rec) => void records.set(rec.runId, rec),
        countRunsOnDay: async () => 0,
      },
    });
    await checker.check({
      routeKey: "SAVED_saved-rules",
      version: 1,
      runId: "SAVED_saved-rules__v1",
      rubric: { routeKey: "SAVED_saved-rules", version: 1, criteria: replacements.map((r) => r.criterion), intentPolarityProposal: null } as any,
      codeLeftOutIds: [],
    });
    for (const [id, v] of Object.entries(records.get("SAVED_saved-rules__v1")?.ruleVerdicts ?? {})) verdicts.set(id, v as any);
  }

  // 3. the report: per rule, old and new letters, and whether the replacement quotes the same line.
  for (const { input, rule } of ready) {
    const id = rule.criterionId;
    const rep = replacements.find((r) => r.id === id);
    if (!rep) {
      opts.print(`${id}: old ${input.verdicts ?? "none"}; re-draft ${outcomeById.get(id)}; no replacement to check.`);
      continue;
    }
    const v = verdicts.get(id);
    // A replacement passes by the PRODUCTION mapping (what a real run would keep): both models for a bar, one otherwise.
    const rows = isBar(rep.criterion) ? [decodeRow(v?.verification), decodeRow(v?.judgement)] : [decodeRow(v?.verification)];
    const failed = failedAspectsOf(rep.criterion, ...rows.map((r) => r ?? undefined));
    const passes = failed.length === 0;
    if (passes) summary.passed += 1;
    opts.print(
      `${id}: old ${input.verdicts ?? "none"}; new ${v?.verification ?? "none"}${isBar(rep.criterion) ? `/${v?.judgement ?? "none"}` : ""}; same line ${rep.sameLine ? "yes" : "no"}; ` +
      `becomes a bar ${isBar(rep.criterion) && !isBar(rule) ? "YES" : "no"}; passes every aspect ${passes ? "yes" : `no (${failed.join(",")})`}.`
    );
  }
  summary.requests = provider.requests;
  opts.print(`\n${summary.rules} rule(s): ${summary.redrafted} re-drafted, ${summary.refused} refused or unrepairable, ${summary.passed} pass every aspect; ${summary.requests} request(s) made.`);
  return summary;
}

/** Value of `--name value`, or undefined. */
const arg = (name: string): string | undefined => {
  const a = process.argv.slice(2);
  const i = a.indexOf(`--${name}`);
  return i >= 0 ? a[i + 1] : undefined;
};

/** Print one report line (the lines are ids, letters and counts only; see the header). */
const printLine = (line: string): void => console.log(line);

/** The command line: parse the arguments, read the two files, build the real provider only for `--live`. */
async function main(): Promise<void> {
  const pagePath = arg("page");
  const rulesPath = arg("rules");
  if (!pagePath || !rulesPath) {
    console.error("usage: --page <stored-page.json> --rules <rules.json> [--route <name>] [--live]");
    process.exit(2);
  }
  // The service modules resolve a storage bucket when loaded, though this script never touches storage. A
  // PLACEHOLDER project id (never a real one) lets them load; a value already in the environment is kept.
  process.env.GCLOUD_PROJECT ??= "saved-rules-offline";
  const snapshot = JSON.parse(readFileSync(pagePath, "utf8")) as GuidanceSnapshotContent;
  const inputs = JSON.parse(readFileSync(rulesPath, "utf8")) as SavedRuleInput[];
  const live = process.argv.includes("--live");
  const provider = live ? new (await import("../../../services/ai/llm-provider")).AnthropicLlmProvider() : undefined;
  await runRepairs(snapshot, inputs, { live, routeName: arg("route"), print: printLine, provider });
}

// Run only when started as a script, never when a test imports `runRepairs`.
if (require.main === module) {
  main().catch((e) => {
    // The class only: never the message, which can carry a path.
    console.error(`repair-saved-rule failed: ${(e as Error).constructor.name}`);
    process.exit(1);
  });
}
