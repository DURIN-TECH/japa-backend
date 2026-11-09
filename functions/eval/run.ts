import { execFileSync, type ExecFileSyncOptionsWithStringEncoding } from "child_process";
import * as fs from "fs";
import * as path from "path";

import { VISA_SOURCE_OVERRIDES } from "../src/data/seed-visa-sources";
import {
  EXTRACTOR_PROMPT_VERSION,
  visaCatalogExtractor,
  type LlmExtractor,
} from "../src/services/visa-catalog-extract.service";
import { GovukContentApiAdapter } from "../src/services/visa-source-adapters";
import type { ExtractedVisa, VisaSourcePage } from "../src/types/visa-catalog";
import {
  EVAL_COUNTRY_NAME,
  EVAL_ROUTES,
  FIELD_WEIGHTS,
  GOLDEN_DIR,
  PROCESSING_DAYS_MIN_TOLERANCE_DAYS,
  PROCESSING_DAYS_TOLERANCE,
  RESULTS_DIR,
  SCORED_FIELDS,
  findEvalRoute,
  type EvalRoute,
  type ScoredField,
} from "./config";
import { expectedPath, fixtureFetchService, guidePath, loadExpected, loadGuide } from "./golden";
import {
  evaluateGate,
  fieldScores,
  fieldTypeScores,
  scoreRoute,
  type ExpectedVisa,
  type FieldType,
  type GateResult,
  type RouteScore,
} from "./score";

// ============================================
// VISA EXTRACTION EVAL — RUNNER (`npm run eval:visa-extract`, issue #60)
// ============================================
//
//   npm run eval:visa-extract                       live run, all routes (~6 LLM calls)
//   npm run eval:visa-extract -- --only <route>     live run, one route
//   npm run eval:visa-extract -- --compare <file>   … and print the delta vs an earlier results file
//   npm run eval:visa-extract -- --replay <file>    re-score a results file's stored outputs (no LLM, no key)
//
// For each golden route the runner:
//   1. loads eval/golden/<route>/guide.json and serves it to the REAL
//      GovukContentApiAdapter through a stub fetch service (golden.ts), so the
//      real robots check, parsing, section selection (incl. the registry's
//      VISA_SOURCE_OVERRIDES section lists — registry config, not visa seed
//      data), formatting and cap are used and NO network call is made;
//   2. calls the REAL extractor (`visaCatalogExtractor.extract()`, DeepSeek) —
//      the only network call of a run;
//   3. scores the output with the pure scorer (score.ts) against expected.json.
// A failed or invalid extraction (ExtractionValidationError, API error) scores
// that route 0 and is shown; it does not crash the run.
//
// Output: a table on stdout and a results JSON file
// eval/results/<EXTRACTOR_PROMPT_VERSION>__<model>__<timestamp>.json (live
// runs only; replay just prints). Results files are meant to be committed
// with a prompt/model PR (before/after), see eval/README.md.
//
// Exit codes: 0 pass, 1 below the gate (any fee mismatch, overall < 0.85 or a
// route < 0.7), 2 usage/config error (no DEEPSEEK_API_KEY, missing fixture,
// unknown route, unreadable results file).
//
// NOT part of `npm test`, CI or any deploy: nothing under src/ imports this
// file (a unit test asserts it). `npm test` only exercises --replay.

// ----- Results file shape -----

/** One route in a results file: provenance + the raw extractor output + its score. */
export interface RouteRecord {
  route: string;
  sourceUrl: string;
  fixtureRecordedAt?: string; // guide.json `_fixture.recordedAt`
  sourceUpdatedAt?: string; // GOV.UK `updated_at` of the fixture
  contentHash?: string; // sha256 of the text sent to the extractor
  sectionsUsed?: string[]; // guide parts the adapter selected
  truncated?: boolean; // adapter cap hit
  extracted: ExtractedVisa | null; // the extractor's (validated) output; null when it failed
  error?: string; // why the extraction failed
  score: RouteScore;
}

/** The whole results file. */
export interface EvalResultFile {
  extractorPromptVersion: string;
  model: string;
  ranAt: string; // ISO timestamp
  gitSha: string; // HEAD when the run was made ("unknown" outside git)
  gitDirty: boolean; // uncommitted changes at run time
  mode: "live" | "replay";
  replayOf?: string; // replay: the results file re-scored
  config: {
    weights: typeof FIELD_WEIGHTS;
    processingDaysTolerance: number;
    processingDaysMinToleranceDays: number;
  };
  thresholds: GateResult["thresholds"];
  routes: RouteRecord[];
  fieldTypeScores: Record<FieldType, number>;
  fieldScores: Record<ScoredField, number>;
  overall: number;
  pass: boolean;
  failures: string[];
}

// ----- Dependencies (injectable for tests) -----

/** Everything main() touches outside pure code. Defaults = production. */
export interface RunDeps {
  env?: NodeJS.ProcessEnv; // default process.env (DEEPSEEK_API_KEY check)
  extractor?: LlmExtractor; // default visaCatalogExtractor (DeepSeek)
  goldenDir?: string; // default eval/golden
  resultsDir?: string; // default eval/results
  writeResults?: boolean; // live runs write a results file (default true)
  now?: () => Date; // clock for ranAt / file name
  gitInfo?: () => { sha: string; dirty: boolean }; // default: `git` in this repo
  log?: (line: string) => void; // stdout
  logError?: (line: string) => void; // stderr
}

/** Usage line printed on a usage error. */
const USAGE =
  "usage: npm run eval:visa-extract -- [--only <route>] [--compare <results.json>] [--replay <results.json>]";

/** Parsed CLI options. */
interface RunArgs {
  only?: string;
  compare?: string;
  replay?: string;
}

/** Parse argv (flags take one value each). Returns an error string on bad input. */
export function parseRunArgs(argv: string[]): RunArgs | { error: string } {
  const out: RunArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === "--only" || flag === "--compare" || flag === "--replay") {
      if (!value || value.startsWith("--")) return { error: `${flag} needs a value\n${USAGE}` };
      out[flag.slice(2) as keyof RunArgs] = value;
      i++;
    } else {
      return { error: `unknown argument "${flag}"\n${USAGE}` };
    }
  }
  return out;
}

/** HEAD sha + dirty flag of the repo containing this file ("unknown" on failure). */
function defaultGitInfo(): { sha: string; dirty: boolean } {
  try {
    const opts: ExecFileSyncOptionsWithStringEncoding = { cwd: __dirname, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] };
    const sha = execFileSync("git", ["rev-parse", "HEAD"], opts).trim();
    const dirty = execFileSync("git", ["status", "--porcelain"], opts).trim().length > 0;
    return { sha, dirty };
  } catch {
    return { sha: "unknown", dirty: false };
  }
}

/** File-name-safe UTC stamp: 2026-11-09T18:30:12.345Z → 20261109T183012Z. */
export function fileStamp(d: Date): string {
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

/** Results file name for a run. */
export function resultsFileName(promptVersion: string, model: string, ranAt: Date): string {
  const safe = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, "-");
  return `${safe(promptVersion)}__${safe(model)}__${fileStamp(ranAt)}.json`;
}

/** A registry page for a golden route, with the registry's section overrides. */
function evalPage(route: EvalRoute): VisaSourcePage {
  const pin = VISA_SOURCE_OVERRIDES[route.url] ?? {};
  return {
    url: route.url,
    routeName: route.routeName,
    validation: "text_verified",
    ...(pin.includeSections ? { includeSections: pin.includeSections } : {}),
    ...(pin.excludeSections ? { excludeSections: pin.excludeSections } : {}),
  };
}

/** Error → one-line message (ExtractionValidationError lists every problem). */
function errorMessage(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

/** Fetch (from the fixture) + extract (real LLM) + score one route. Never throws. */
async function runRoute(route: EvalRoute, expected: ExpectedVisa, goldenDir: string, extractor: LlmExtractor): Promise<RouteRecord> {
  const guide = loadGuide(route.route, goldenDir);
  const base = { route: route.route, sourceUrl: route.url, fixtureRecordedAt: guide._fixture?.recordedAt };
  try {
    // Real adapter over a stub fetch service serving the fixture (no network).
    const adapter = new GovukContentApiAdapter(fixtureFetchService(route.url, guide));
    const page = evalPage(route);
    const doc = await adapter.fetch(page);
    const provenance = {
      sourceUpdatedAt: doc.sourceUpdatedAt,
      contentHash: doc.contentHash,
      sectionsUsed: doc.sections.map((s) => s.slug),
      truncated: Boolean(doc.truncated),
    };
    try {
      // The ONLY network call: the real extractor, same context as a crawl.
      const extracted = await extractor.extract(doc.text, {
        url: page.url,
        countryName: EVAL_COUNTRY_NAME,
        routeName: page.routeName,
      });
      return { ...base, ...provenance, extracted, score: scoreRoute(expected, extracted) };
    } catch (err) {
      const error = errorMessage(err);
      return { ...base, ...provenance, extracted: null, error, score: scoreRoute(expected, null, error) };
    }
  } catch (err) {
    // Adapter failure on a recorded fixture (shouldn't happen) — still a 0, not a crash.
    const error = `adapter: ${errorMessage(err)}`;
    return { ...base, extracted: null, error, score: scoreRoute(expected, null, error) };
  }
}

/** Format a 0..1 score as "0.917". */
const f3 = (n: number) => n.toFixed(3);

/** Format a signed delta as "+0.083" / "-0.100" / " 0.000". */
const delta = (n: number) => (Math.abs(n) < 0.0005 ? " 0.000" : `${n > 0 ? "+" : ""}${n.toFixed(3)}`);

/** Pad / cut a cell to a width. */
const cell = (s: string, w: number) => (s.length >= w ? s.slice(0, w) : s + " ".repeat(w - s.length));

/** Print the report table (per route x field type, overall, gate, notes). */
export function printReport(res: EvalResultFile, log: (l: string) => void): void {
  const types: FieldType[] = ["fee", "exact", "numeric", "text", "eligibility", "url"];
  log(`\nVisa extraction eval — ${res.mode}${res.replayOf ? ` of ${res.replayOf}` : ""}`);
  log(`prompt ${res.extractorPromptVersion} | model ${res.model} | ran ${res.ranAt} | git ${res.gitSha.slice(0, 12)}${res.gitDirty ? " (dirty)" : ""}\n`);
  log(`${cell("route", 22)}${cell("score", 8)}${types.map((t) => cell(t, 12)).join("")}`);
  for (const r of res.routes) {
    const byType = types.map((t) => {
      const fs_ = r.score.fields.filter((f) => f.type === t);
      const v = fs_.length ? fs_.reduce((s, f) => s + f.score, 0) / fs_.length : 0;
      return cell(f3(v), 12);
    });
    log(`${cell(r.route, 22)}${cell(f3(r.score.score), 8)}${byType.join("")}${r.error ? "  EXTRACTION FAILED" : ""}`);
  }
  log(`${cell("field type mean", 30)}${types.map((t) => cell(f3(res.fieldTypeScores[t]), 12)).join("")}`);
  log(`\nOVERALL ${f3(res.overall)} (pass >= ${res.thresholds.overall}, every route >= ${res.thresholds.route}, no fee mismatch)`);

  // Every failing field, so a reader sees WHY without opening the JSON.
  log("\nField failures:");
  let any = false;
  for (const r of res.routes) {
    for (const f of r.score.fields) {
      if (f.pass) continue;
      any = true;
      log(`  ${r.route}.${f.field} (${f3(f.score)}): ${f.detail ?? ""} | actual ${JSON.stringify(f.actual)}`);
    }
  }
  if (!any) log("  none");

  // Known gaps / notes never fail the run, but are always shown.
  const notes = res.routes.flatMap((r) => r.score.notes.map((n) => `  ${r.route}: ${n}`));
  if (notes.length) log(`\nNotes (never fail the run):\n${notes.join("\n")}`);

  log(`\nGATE: ${res.pass ? "PASS" : "FAIL"}`);
  for (const fl of res.failures) log(`  - ${fl}`);
}

/** Print per-field / per-route / overall deltas of `cur` against an earlier file. */
export function printCompare(cur: EvalResultFile, prev: EvalResultFile, prevName: string, log: (l: string) => void): void {
  log(`\nCompare with ${prevName} (prompt ${prev.extractorPromptVersion}, model ${prev.model}, ran ${prev.ranAt})`);
  log(`${cell("field", 22)}${cell("before", 9)}${cell("now", 9)}delta`);
  for (const f of SCORED_FIELDS) {
    const a = prev.fieldScores?.[f] ?? 0;
    const b = cur.fieldScores[f];
    log(`${cell(f, 22)}${cell(f3(a), 9)}${cell(f3(b), 9)}${delta(b - a)}`);
  }
  log(`${cell("route", 22)}${cell("before", 9)}${cell("now", 9)}delta`);
  for (const r of cur.routes) {
    const p = prev.routes.find((x) => x.route === r.route);
    log(`${cell(r.route, 22)}${cell(p ? f3(p.score.score) : "-", 9)}${cell(f3(r.score.score), 9)}${p ? delta(r.score.score - p.score.score) : "(new)"}`);
  }
  log(`${cell("OVERALL", 22)}${cell(f3(prev.overall), 9)}${cell(f3(cur.overall), 9)}${delta(cur.overall - prev.overall)}`);
}

/** Read + parse a results file (throws with a clear message). */
function readResults(file: string): EvalResultFile {
  return JSON.parse(fs.readFileSync(path.resolve(file), "utf8")) as EvalResultFile;
}

/** Assemble a results file from scored routes. */
export function buildResults(
  routes: RouteRecord[],
  meta: Pick<EvalResultFile, "extractorPromptVersion" | "model" | "ranAt" | "gitSha" | "gitDirty" | "mode" | "replayOf">
): EvalResultFile {
  const scores = routes.map((r) => r.score);
  const gate = evaluateGate(scores);
  return {
    ...meta,
    config: {
      weights: FIELD_WEIGHTS,
      processingDaysTolerance: PROCESSING_DAYS_TOLERANCE,
      processingDaysMinToleranceDays: PROCESSING_DAYS_MIN_TOLERANCE_DAYS,
    },
    thresholds: gate.thresholds,
    routes,
    fieldTypeScores: fieldTypeScores(scores),
    fieldScores: fieldScores(scores),
    overall: gate.overall,
    pass: gate.pass,
    failures: gate.failures,
  };
}

/**
 * The CLI, as a function returning the exit code (so tests can drive it).
 * Order of checks: args → routes → fixtures/expected present → (live) API key
 * — all BEFORE any LLM call, so a config error never costs money.
 */
export async function main(argv: string[], deps: RunDeps = {}): Promise<number> {
  const env = deps.env ?? process.env;
  const goldenDir = deps.goldenDir ?? GOLDEN_DIR;
  const resultsDir = deps.resultsDir ?? RESULTS_DIR;
  const log = deps.log ?? ((l: string) => console.log(l));
  const logError = deps.logError ?? ((l: string) => console.error(l));
  const now = deps.now ?? (() => new Date());
  const gitInfo = deps.gitInfo ?? defaultGitInfo;

  // ---- Args ----
  const args = parseRunArgs(argv);
  if ("error" in args) {
    logError(args.error);
    return 2;
  }

  // ---- Earlier results to compare against (read up front: a bad path is a usage error) ----
  let compareWith: EvalResultFile | undefined;
  if (args.compare) {
    try {
      compareWith = readResults(args.compare);
    } catch (err) {
      logError(`cannot read --compare file ${args.compare}: ${(err as Error).message}`);
      return 2;
    }
  }

  // ---- Replay: re-score stored outputs, no LLM, no key ----
  if (args.replay) {
    let stored: EvalResultFile;
    try {
      stored = readResults(args.replay);
    } catch (err) {
      logError(`cannot read --replay file ${args.replay}: ${(err as Error).message}`);
      return 2;
    }
    const records = stored.routes.filter((r) => !args.only || r.route === args.only);
    if (records.length === 0) {
      logError(`no routes to replay${args.only ? ` (--only ${args.only} not in ${args.replay})` : ""}`);
      return 2;
    }
    const rescored: RouteRecord[] = [];
    for (const rec of records) {
      if (!fs.existsSync(expectedPath(rec.route, goldenDir))) {
        logError(`missing expected.json for route "${rec.route}" in ${goldenDir}`);
        return 2;
      }
      const expected = loadExpected(rec.route, goldenDir);
      rescored.push({ ...rec, score: scoreRoute(expected, rec.extracted, rec.error) });
    }
    const res = buildResults(rescored, {
      extractorPromptVersion: stored.extractorPromptVersion,
      model: stored.model,
      ranAt: stored.ranAt,
      gitSha: stored.gitSha,
      gitDirty: stored.gitDirty,
      mode: "replay",
      replayOf: path.basename(args.replay),
    });
    printReport(res, log);
    if (compareWith && args.compare) printCompare(res, compareWith, path.basename(args.compare), log);
    return res.pass ? 0 : 1;
  }

  // ---- Live: routes + fixtures, then the key, then the calls ----
  let routes: EvalRoute[] = [...EVAL_ROUTES];
  if (args.only) {
    const r = findEvalRoute(args.only);
    if (!r) {
      logError(`unknown route "${args.only}" (known: ${EVAL_ROUTES.map((x) => x.route).join(", ")})`);
      return 2;
    }
    routes = [r];
  }
  const expectedByRoute = new Map<string, ExpectedVisa>();
  for (const r of routes) {
    for (const file of [guidePath(r.route, goldenDir), expectedPath(r.route, goldenDir)]) {
      if (!fs.existsSync(file)) {
        logError(`missing fixture ${file} (record it with: npm run eval:record -- ${r.route} --write)`);
        return 2;
      }
    }
    expectedByRoute.set(r.route, loadExpected(r.route, goldenDir));
  }
  if (!deps.extractor && !env.DEEPSEEK_API_KEY) {
    logError(
      "DEEPSEEK_API_KEY is not set. Put it in functions/.env.local (read by npm run eval:visa-extract) " +
        "or export it, or use --replay <results.json> to re-score a stored run without the LLM."
    );
    return 2;
  }
  const extractor = deps.extractor ?? visaCatalogExtractor;

  // Sequential on purpose: ~6 calls, and a predictable log.
  const records: RouteRecord[] = [];
  for (const r of routes) {
    log(`extracting ${r.route} …`);
    records.push(await runRoute(r, expectedByRoute.get(r.route) as ExpectedVisa, goldenDir, extractor));
  }

  const ranAt = now();
  const git = gitInfo();
  const res = buildResults(records, {
    extractorPromptVersion: EXTRACTOR_PROMPT_VERSION,
    model: extractor.model,
    ranAt: ranAt.toISOString(),
    gitSha: git.sha,
    gitDirty: git.dirty,
    mode: "live",
  });
  printReport(res, log);
  if (compareWith && args.compare) printCompare(res, compareWith, path.basename(args.compare), log);

  if (deps.writeResults ?? true) {
    fs.mkdirSync(resultsDir, { recursive: true });
    const file = path.join(resultsDir, resultsFileName(res.extractorPromptVersion, res.model, ranAt));
    // Results hold only page-derived values and scores — never the API key.
    fs.writeFileSync(file, JSON.stringify(res, null, 2) + "\n");
    log(`\nresults written to ${path.relative(process.cwd(), file)}`);
  }
  return res.pass ? 0 : 1;
}

// ----- CLI entry -----

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error(err);
      process.exit(2);
    }
  );
}
