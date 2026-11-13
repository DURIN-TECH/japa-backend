import "./record-env";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { AnthropicLlmProvider } from "../../src/services/ai/llm-provider";
import { bandDistance } from "./assertions";
import { GoldenRecordingProvider, readRecordingFile, recordingPath, type RecordingFile } from "./providers";
import { loadFixtures, runFixture } from "./runner";
import { RECORD_MAX_MODEL_CALLS } from "./types";

// ============================================
// Golden set — refresh the recorded model responses (issue #35)
// ============================================
//
//   npm run golden:record -- --fixture <id> [--fixture <id> ...]
//   npm run golden:record -- --all
//   npm run golden:record -- --all --max-calls 60
//
// Runs the chosen fixtures through the REAL engine against the LIVE model
// provider (the key comes from functions/.env.local, never printed), writes
// test/golden/recordings/<fixture>.json, and prints a band-delta table:
// previous recorded band vs the new one per fixture. Put that table in the PR
// that commits refreshed recordings.
//
// It SPENDS MONEY, so it is never run by CI or by `npm test`, and it has brakes:
//  - no flag at all prints this usage and spends nothing;
//  - a hard cap on model calls for the whole run (default RECORD_MAX_MODEL_CALLS);
//  - it stops at the FIRST failed call and writes nothing for that fixture;
//  - a fixture is written only after its whole job succeeded.
//
// What is stored: the model's answer text, stop reason, usage and model id,
// keyed by the engine's own request hash. Never the prompt, the document bytes,
// a header or any environment value.
//
// After a prompt change (ASSESSMENT_PROMPT_VERSION bump, new rubric text) every
// affected fixture's hash changes and the gate fails with "no recording ...";
// run this command to refresh them, review the band deltas, commit.

function parseArgs(argv: string[]): { ids: string[]; all: boolean; maxCalls: number } {
  const ids: string[] = [];
  let all = false;
  let maxCalls = RECORD_MAX_MODEL_CALLS;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--fixture" && argv[i + 1]) ids.push(argv[++i]);
    else if (argv[i] === "--all") all = true;
    else if (argv[i] === "--max-calls" && argv[i + 1]) maxCalls = Number(argv[++i]);
    else {
      console.error(`unknown argument: ${argv[i]}`);
      process.exit(2);
    }
  }
  if (!Number.isInteger(maxCalls) || maxCalls <= 0) {
    console.error("--max-calls must be a positive integer");
    process.exit(2);
  }
  return { ids, all, maxCalls };
}

async function main(): Promise<void> {
  const { ids, all, maxCalls } = parseArgs(process.argv.slice(2));
  if (!all && ids.length === 0) {
    console.log("usage: npm run golden:record -- --fixture <id> [--fixture <id>...] | --all  [--max-calls N]\nNothing was recorded and no model call was made.");
    process.exit(2);
  }
  const fixtures = loadFixtures();
  const chosen = all ? fixtures : ids.map((id) => {
    const f = fixtures.find((x) => x.id === id);
    if (!f) {
      console.error(`no fixture with id ${id}`);
      process.exit(2);
    }
    return f;
  });

  const rec = new GoldenRecordingProvider(new AnthropicLlmProvider(), maxCalls);
  const rows: Array<{ id: string; expected: string; previous: string; now: string; delta: string; calls: number }> = [];
  let failed: string | null = null;

  for (const fixture of chosen) {
    const before = rec.calls;
    rec.begin();
    let run;
    try {
      run = await runFixture(fixture, rec);
    } catch (err) {
      failed = `fixture ${fixture.id}: ${(err as Error).message}`;
      break;
    }
    // The engine swallows provider errors, so look at the provider's own flag.
    if (rec.fatal) {
      failed = `fixture ${fixture.id}: ${rec.fatal}`;
      break;
    }
    if (run.assessment.status !== "succeeded") {
      failed = `fixture ${fixture.id}: the job did not succeed (${run.assessment.error?.code ?? run.assessment.status})`;
      break;
    }
    const prev = readRecordingFile(fixture.id);
    const prevBand = prev?.recordedOutcome.readiness ?? null;
    const now = run.assessment.readiness;
    const file: RecordingFile = {
      fixtureId: fixture.id,
      recordedOn: new Date().toISOString().slice(0, 10),
      recordedOutcome: { readiness: now, refusalGroundIds: run.assessment.refusalGrounds.map((g) => g.criterionId).sort() },
      recordings: rec.collected(),
    };
    mkdirSync(dirname(recordingPath(fixture.id)), { recursive: true });
    writeFileSync(recordingPath(fixture.id), JSON.stringify(file, null, 1) + "\n");
    rows.push({
      id: fixture.id,
      expected: fixture.label.expectedBand,
      previous: prevBand ?? "(none)",
      now: now ?? "(none)",
      delta: prevBand && now ? (prevBand === now ? "same" : `${bandDistance(prevBand as never, now)} band(s)`) : "new",
      calls: rec.calls - before,
    });
  }

  // ---- the band-delta table ----
  console.log("\nfixture".padEnd(46) + "label".padEnd(13) + "previous".padEnd(13) + "new".padEnd(13) + "delta".padEnd(12) + "calls");
  for (const r of rows) console.log(r.id.padEnd(45) + " " + r.expected.padEnd(12) + " " + r.previous.padEnd(12) + " " + r.now.padEnd(12) + " " + r.delta.padEnd(11) + " " + r.calls);
  const t = rec.totals;
  console.log(`\nmodel calls: ${rec.calls}/${maxCalls}; tokens: input ${t.inputTokens}, output ${t.outputTokens}, cache read ${t.cacheReadTokens}, cache write ${t.cacheWriteTokens}`);
  if (failed) {
    console.error(`\nSTOPPED: ${failed}\nFixtures after this one were not run; none of this fixture's recording was written.`);
    process.exit(1);
  }
}

main().catch((err) => {
  // A redacted one-liner only: never the error object (it could carry request details).
  console.error(`record failed: ${err instanceof Error ? err.name + ": " + err.message : "error"}`);
  process.exit(1);
});
