/**
 * Evaluate how a language behaves on a real official page, BEFORE it is enabled
 * (issue #220, "Evaluation before enabling").
 *
 * It reports, for one route's page(s) in one language:
 *   - rules KEPT and rules DISCARDED by reason;
 *   - a RECHECK of every kept rule against the stored page, read in the page's
 *     own language (the quote is found; the numbers, units and dates the rule
 *     claims are in the quote);
 *   - the independent check's verdicts (live mode);
 *   - a 20-rule SAMPLE SHEET (`sample-sheet.json`) for a person to read against
 *     the official wording, with empty fields for their verdict;
 *   - and, with `--score`, the AGREEMENT between the check and the person on
 *     those 20 rules.
 *
 * IT ENABLES NOTHING. A language is added to `supportedLanguages` by a person,
 * after reading the report. It never touches Firestore or any project: its
 * inputs are FILES (the stored page text as JSON), its only output is files.
 *
 * TWO MODES
 *  - OFFLINE (the default): no model call, no network. Needs `--version`, a
 *    stored rubric version exported as JSON (the draft of this route whose
 *    pages are given), and the `--page` file(s) it was drafted from. Reports
 *    what that version holds and rechecks it.
 *  - `--live`: DRAFTS the rulebook now, in memory (the same steps, prompts and
 *    code validation as the real drafting path, including the translation
 *    step), then runs the independent check on it. THIS CALLS THE MODEL AND
 *    COSTS MONEY: it needs ANTHROPIC_API_KEY (functions/.env.local), and is
 *    capped by `--max-requests` (default: the drafting setting's own cap).
 *    Nothing is written anywhere but the report files.
 *
 * Run (from functions/):
 *   npm run build
 *   # offline recheck of a stored version
 *   node lib/scrapers/rubric/scripts/evaluate-language.js --route=<routeKey> --version=<version.json> --page=<stored-page.json> [--page=...] --out=<dir>
 *   # live drafting + check (spends model calls)
 *   node --env-file-if-exists=.env.local lib/scrapers/rubric/scripts/evaluate-language.js --live --route=<routeKey> --route-name="<visa route name>" --page=<stored-page.json> --language=<code> --out=<dir>
 *   # after a person filled the sheet
 *   node lib/scrapers/rubric/scripts/evaluate-language.js --score=<dir>/sample-sheet.json --report=<dir>/language-eval-<routeKey>.json
 * or `npm run evaluate:language -- [flags]`.
 *
 * Inputs
 *   --page=<file>      a stored page: the JSON of a guidance snapshot (`schemaVersion, sourceId,
 *                      contentHash, docType, url, finalUrl, fetchedAt, text, pages`), as the snapshot
 *                      store keeps it. Repeat for several pages. A page may carry `"language": "<code>"`;
 *                      otherwise `--language=<code>` applies to every page; with neither, the page is
 *                      read as the product language.
 *   --role=<role>      live: the role of every page (`primary` default, `route_guidance`, `secondary`).
 *   --version=<file>   offline: a rubric version exported as JSON.
 *   --out=<dir>        where the report files go (default: the current directory).
 *
 * Never prints document text: ids, counts and codes only (the sample sheet FILE holds the quotes).
 */

import fs from "fs";
import path from "path";
import type { GuidanceSnapshotContent } from "../../guidance/types";
import type { AssessmentCriterion, QuoteTranslation, RubricDiscard, VisaRubric } from "../../../types/rubric";
import { hasLexicon, resolveSourceLanguage, sourceLanguagesOf } from "../../language/language-lexicon";
import {
  EVALUATION_NOTE,
  SAMPLE_SHEET_SIZE,
  buildSampleSheet,
  discardTally,
  indexPages,
  recheckRule,
  renderMarkdown,
  scoreSheet,
  type EvaluationPage,
  type LanguageEvaluationReport,
  type SampleSheetRow,
} from "../rubric-language-eval";

/** Tag every line this script prints. */
const TAG = "[evaluate-language]";

/** Every value of a repeatable `--name=value` flag. */
function flags(args: string[], name: string): string[] {
  return args.filter((a) => a.startsWith(`--${name}=`)).map((a) => a.slice(name.length + 3).trim());
}
const flag = (args: string[], name: string): string | undefined => flags(args, name)[0];

/** Read a JSON file. */
const readJson = <T>(file: string): T => JSON.parse(fs.readFileSync(file, "utf8")) as T;

/** Write a JSON file (pretty, so a person can open it). */
function writeJson(file: string, value: unknown): void {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

/** Load the `--page` files. */
function loadPages(args: string[]): EvaluationPage[] {
  const language = flag(args, "language");
  return flags(args, "page").map((file) => {
    const content = readJson<GuidanceSnapshotContent & { language?: string }>(file);
    if (!content.sourceId || !content.contentHash || typeof content.text !== "string") throw new Error(`${file} is not a stored page (sourceId, contentHash and text are needed)`);
    return { content, language: content.language ?? language };
  });
}

/** What both modes hand to the report. */
interface Findings {
  mode: "offline" | "live";
  routeKey: string;
  kept: AssessmentCriterion[];
  discards: RubricDiscard[];
  discardedCount: number;
  translations: Record<string, QuoteTranslation>;
  version: number;
  verdicts: Record<string, { verification?: string; judgement?: string }>;
  checker: { ran: boolean; leftOut: string[] } | null;
  usage: { requests: number; inputTokens: number; outputTokens: number } | null;
}

/** OFFLINE: what a stored version holds. */
function offline(args: string[], routeKey: string): Findings {
  const file = flag(args, "version");
  if (!file) throw new Error("offline mode needs --version=<exported version.json> (or use --live to draft now)");
  const v = readJson<VisaRubric>(file);
  return { mode: "offline", routeKey, kept: v.criteria, discards: v.discarded ?? [], discardedCount: v.discardedCount ?? (v.discarded ?? []).length, translations: v.quoteTranslations ?? {}, version: v.version ?? 0, verdicts: {}, checker: null, usage: null };
}

/** LIVE: draft in memory, translate, check. Model calls. */
async function live(args: string[], routeKey: string, pages: EvaluationPage[]): Promise<Findings> {
  const routeName = flag(args, "route-name") ?? routeKey;
  const role = (flag(args, "role") ?? "primary") as "primary" | "route_guidance" | "secondary";
  // Loaded here, not at the top: offline mode must not even import the model code.
  const { AnthropicLlmProvider } = await import("../../../services/ai/llm-provider");
  const service = await import("../rubric-extraction.service");
  const { RubricCheckerService } = await import("../rubric-checker");
  const { DEFAULT_RUBRIC_SETTINGS } = await import("../rubric-settings");
  const { DEFAULT_PUBLISH_SETTINGS } = await import("../rubric-publish-settings");
  const { sourceSetHashOf } = service;

  const provider = new AnthropicLlmProvider();
  const settings = { ...DEFAULT_RUBRIC_SETTINGS };
  const cap = Number(flag(args, "max-requests") ?? settings.maxRequestsPerRun);
  if (!Number.isInteger(cap) || cap < 1) throw new Error("--max-requests must be a whole number of at least 1");
  settings.maxRequestsPerRun = cap;

  // The pages stand in for the snapshot store: read by (sourceId, contentHash), as the real path does.
  const byId = new Map(pages.map((p) => [p.content.sourceId, p.content]));
  const svc = new service.RubricExtractionService({ provider, snapshots: { read: async (id: string) => byId.get(id) as GuidanceSnapshotContent } });
  const sources: import("../rubric-extraction.service").LoadedSource[] = pages.map((p) => ({
    snapshot: { sourceId: p.content.sourceId, contentHash: p.content.contentHash, url: p.content.finalUrl || p.content.url, docType: p.content.docType, ...(p.language ? { language: p.language } : {}) },
    retrievedAt: p.content.fetchedAt,
    role,
    title: p.content.sourceId,
    ...(p.language ? { language: p.language } : {}),
  }));
  const ctx = await svc.buildRunContext(sources, settings, routeName);
  svc.assertWithinCaps(ctx.chunks, settings);

  // The same steps, in the same order, as the real drafting path.
  const usage = { requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  const attempts = { failed: 0, cap: settings.maxRequestsPerRun };
  const known = new Map<string, import("../rubric-prompt").KnownQuestionView>();
  const parts: { chunk: (typeof ctx.chunks)[number]; assessment: import("../rubric-extraction.service").ChunkAssessment }[] = [];
  const translations: Record<string, QuoteTranslation> = {};
  const { needsTranslation } = await import("../../language/language-lexicon");
  for (const chunk of ctx.chunks) {
    const criteriaPart = await svc.runCriteriaStep(ctx, chunk, usage, attempts);
    let assessment = criteriaPart;
    if (criteriaPart.criteria.length > 0) {
      const intakePart = await svc.runIntakeStep(ctx, chunk, criteriaPart, [...known.values()], usage, attempts);
      assessment = service.combineAssessments(criteriaPart, intakePart);
      service.rememberQuestions(known, assessment);
    }
    parts.push({ chunk, assessment });
    if (assessment.criteria.length > 0 && needsTranslation(sources.find((s) => s.snapshot.sourceId === chunk.sourceId)?.language)) {
      Object.assign(translations, (await svc.runTranslateStep(ctx, chunk, assessment, usage, attempts)).translations);
    }
  }
  const assembled = service.assembleDraft(
    { routeKey, countryCode: routeKey.split("_")[0], visaTypeId: routeKey.split("_").slice(1).join("_"), sources, sourceSetHash: sourceSetHashOf(sources.map((s) => s.snapshot)), model: provider.modelFor("judgement"), runId: `evaluation-${Date.now()}`, severityLevels: ctx.severityLevels, chunkCount: ctx.chunks.length, midSentence: ctx.midSentence, createdAt: (await import("firebase-admin/firestore")).Timestamp.now() },
    parts,
    translations
  );
  if (!assembled.ok) throw new Error(`the draft failed: ${assembled.reasonCode} (${assembled.error})`);
  const draft = { ...assembled.draft, version: 0 } as unknown as VisaRubric;

  // The independent check, with an in-memory record: nothing is written anywhere.
  const records = new Map<string, import("../rubric-checker").RubricCheckerRun>();
  const checker = new RubricCheckerService({
    provider: () => provider,
    readSnapshot: async (id: string) => byId.get(id) as GuidanceSnapshotContent,
    loadSettings: async () => ({ settings: { ...DEFAULT_PUBLISH_SETTINGS }, exists: false, problems: [] }),
    ledger: { load: async (id) => records.get(id) ?? null, save: async (r) => void records.set(r.runId, JSON.parse(JSON.stringify(r))), countRunsOnDay: async () => 0 },
  });
  const outcome = await checker.check({ routeKey, version: 0, runId: `${routeKey}__evaluation`, rubric: draft, codeLeftOutIds: [] });
  const record = [...records.values()][0];
  const checkerRequests = record?.usage?.requests ?? 0;
  return {
    mode: "live",
    routeKey,
    kept: draft.criteria,
    discards: draft.discarded,
    discardedCount: draft.discardedCount,
    translations: draft.quoteTranslations ?? {},
    version: 0,
    verdicts: record?.ruleVerdicts ?? {},
    checker: { ran: outcome.ok || record?.status === "completed", leftOut: outcome.ok ? outcome.leftOut.map((l) => l.criterionId) : (outcome.protectedRuleIds ?? []) },
    usage: { requests: usage.requests + checkerRequests, inputTokens: usage.inputTokens + (record?.usage?.inputTokens ?? 0), outputTokens: usage.outputTokens + (record?.usage?.outputTokens ?? 0) },
  };
}

/** Score a filled sheet and update the report next to it. */
function score(args: string[]): void {
  const sheetFile = flag(args, "score") as string;
  const reportFile = flag(args, "report");
  const rows = readJson<SampleSheetRow[]>(sheetFile);
  const agreement = scoreSheet(rows);
  console.log(`${TAG} ${JSON.stringify(agreement)}`);
  if (reportFile) {
    const report = readJson<LanguageEvaluationReport>(reportFile);
    report.agreement = agreement;
    writeJson(reportFile, report);
    fs.writeFileSync(reportFile.replace(/\.json$/, ".md"), renderMarkdown(report), "utf8");
    console.log(`${TAG} report updated: ${reportFile}`);
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (flag(args, "score")) return score(args);
  const routeKey = flag(args, "route");
  if (!routeKey) throw new Error("give --route=<routeKey> (for example the country code, an underscore, and the visa type id)");
  const pages = loadPages(args);
  if (pages.length === 0) throw new Error("give at least one --page=<stored-page.json>");
  const isLive = args.includes("--live");
  console.log(`${TAG} ${isLive ? "LIVE: the model will be called and this costs money (nothing is written but the report files)" : "OFFLINE: no model call, nothing is sent anywhere (pass --live to draft and check now)"}`);

  const findings = isLive ? await live(args, routeKey, pages) : offline(args, routeKey);
  const indexes = indexPages(pages);
  const sourceLanguage = (sourceId: string) => pages.find((p) => p.content.sourceId === sourceId)?.language;

  // The recheck: every kept rule, against its own page, in that page's language.
  const problems = findings.kept
    .map((rule) => {
      const index = indexes.get(rule.source.sourceId);
      return index ? recheckRule(rule, index) : { criterionId: rule.criterionId, problems: ["page_not_given"] };
    })
    .filter((r) => r.problems.length > 0);

  const out = flag(args, "out") ?? ".";
  fs.mkdirSync(out, { recursive: true });
  const sheetFile = path.join(out, "sample-sheet.json");
  const leftOut = findings.checker?.leftOut ?? [];
  const sheet = buildSampleSheet({ kept: findings.kept, version: findings.version, translations: findings.translations, verdicts: findings.verdicts, checkerLeftOut: leftOut, size: SAMPLE_SHEET_SIZE });
  writeJson(sheetFile, sheet);

  const withVerdict = findings.kept.filter((c) => findings.verdicts[c.criterionId]).length;
  const report: LanguageEvaluationReport = {
    generatedAt: new Date().toISOString(),
    mode: findings.mode,
    routeKey,
    sourceLanguages: sourceLanguagesOf(pages.map((p) => ({ language: p.language }))),
    pages: pages.map((p) => ({ sourceId: p.content.sourceId, language: resolveSourceLanguage(sourceLanguage(p.content.sourceId)), hasLexicon: hasLexicon(resolveSourceLanguage(p.language)), characters: p.content.text.length })),
    rulesKept: findings.kept.length,
    discardedTotal: findings.discardedCount,
    discardedByReason: discardTally(findings.discards),
    recheck: { checked: findings.kept.length, withProblems: problems.length, problems },
    checker: findings.checker ? { ran: findings.checker.ran, kept: findings.kept.length - leftOut.length, leftOut: leftOut.length, noVerdict: findings.kept.length - withVerdict } : null,
    translations: { stored: Object.keys(findings.translations).length },
    usage: findings.usage,
    sampleSheetFile: sheetFile,
    agreement: null,
    note: EVALUATION_NOTE,
  };
  const reportFile = path.join(out, `language-eval-${routeKey}.json`);
  writeJson(reportFile, report);
  fs.writeFileSync(reportFile.replace(/\.json$/, ".md"), renderMarkdown(report), "utf8");
  console.log(`${TAG} kept ${report.rulesKept}, discarded ${report.discardedTotal}, recheck problems ${problems.length}; report ${reportFile}; sample sheet ${sheetFile} (${sheet.length} rules)`);
}

// Only when run as a script.
if (require.main === module) {
  main().catch((err) => {
    console.error(`${TAG} failed: ${(err as Error)?.message ?? String(err)}`);
    process.exitCode = 1;
  });
}
