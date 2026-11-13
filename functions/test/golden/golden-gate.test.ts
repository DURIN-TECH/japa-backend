// ============================================
// Golden set — the CI gate (issue #35)
// ============================================
//
// Runs every fixture application in test/golden/fixtures/applications/ through
// the REAL assessment engine, offline, against the recorded model answers in
// test/golden/recordings/, and applies the gate assertions (assertions.ts).
//
//   npm run test:golden       just this gate
//   npm test                  everything, this gate included (that is what CI runs)
//
// Offline and deterministic: the provider is a replay of stored answers, the
// store is the in-memory fake, the clock is fixed. A request with no recording
// FAILS the fixture and names the command that refreshes it.
//
// What blocks the PR:
//   - every structural assertion (a to g) for every fixture;
//   - nationality invariance for the identical-facts group;
//   - band-within-one (h) ONLY for fixtures whose labelSource is "expert";
//     for "draft-unreviewed" fixtures the band comparison is printed, not enforced.
// See README.md for how a fixture becomes expert-labelled.

import assert from "node:assert/strict";
import { before, describe, test } from "node:test";
import { bandRow, checkFixture, checkFixtureData, checkNationalityInvariance, expertBandShare, type BandRow, type GateInput } from "./assertions";
import { GoldenReplayProvider, readRecordingFile, refreshCommand } from "./providers";
import { loadFixtures, loadRubric, runFixture } from "./runner";
import { BAND_WITHIN_ONE_MIN_SHARE, MIN_EXPERT_LABELLED_FIXTURES, type Violation } from "./types";
import { NOW } from "../ai-case-officer/harness";

/** One fixture's replay: the gate input, or why there is none. */
interface Replayed {
  input: GateInput | null;
  misses: string[];
  requests: Array<{ role: string; system: string }>;
}

const fixtures = loadFixtures();
const replayed = new Map<string, Replayed>();

/** `fixture <id>: <assertion>: <message>` per violation, one per line. */
function format(vs: Violation[]): string {
  return vs.map((x) => `fixture ${x.fixtureId}: ${x.assertion}: ${x.message}`).join("\n");
}

describe("golden set: replay every fixture through the real engine", () => {
  before(async () => {
    // Sequential on purpose: the fake store is process-global.
    for (const fixture of fixtures) {
      const rec = readRecordingFile(fixture.id);
      const provider = new GoldenReplayProvider(fixture.id, rec);
      const run = await runFixture(fixture, provider);
      replayed.set(fixture.id, {
        input: {
          fixture,
          rubric: run.rubric,
          assessment: run.assessment,
          extractionAnswers: provider.extractionAnswers,
          barDate: NOW.toISOString().slice(0, 10),
        },
        misses: provider.misses.map((m) => `${m.role} request ${m.hash.slice(0, 12)}`),
        requests: provider.requests.map((r) => ({ role: r.role, system: r.system })),
      });
    }
  });

  test("the corpus is not empty and every fixture has a recording", () => {
    assert.ok(fixtures.length > 0, "no fixtures found");
    for (const f of fixtures) {
      assert.ok(readRecordingFile(f.id) !== null, `fixture ${f.id}: no recording file; refresh with: ${refreshCommand(f.id)}`);
    }
  });

  for (const fixture of fixtures) {
    test(`fixture ${fixture.id}`, () => {
      const r = replayed.get(fixture.id)!;
      // A missing recording is reported first and by itself: everything else
      // would be a consequence of an engine that never got its answer.
      assert.equal(r.misses.length, 0, `fixture ${fixture.id}: no recording for ${r.misses.join(", ")}; refresh with: ${refreshCommand(fixture.id)}`);
      const violations = checkFixture(r.input!);
      assert.equal(violations.length, 0, `\n${format(violations)}`);
    });
  }

  test("fixture data: unique ids, emails, labels, expected grounds, group labels", () => {
    const violations = checkFixtureData(fixtures, (f) => loadRubric(f.rubric));
    assert.equal(violations.length, 0, `\n${format(violations)}`);
  });

  test("nationality does not move the band where the facts are identical", () => {
    const rows = [...replayed.values()].map((r) => bandRow(r.input!));
    const violations = checkNationalityInvariance(rows, fixtures);
    assert.equal(violations.length, 0, `\n${format(violations)}`);
    // The group must actually span several nationalities (the issue asks for at least five).
    const groups = new Map<string, Set<string>>();
    for (const f of fixtures) if (f.group) groups.set(f.group, (groups.get(f.group) ?? new Set()).add(f.applicant.nationality));
    assert.ok([...groups.values()].some((s) => s.size >= 5), "no group spans five nationalities");
  });

  test("generic engine: one system prompt per role across both rubrics; only rubric and applicant data differ", () => {
    const rubrics = new Set(fixtures.map((f) => f.rubric));
    assert.ok(rubrics.size >= 2, "the corpus must run over at least two rubrics");
    for (const role of ["extraction", "judgement"]) {
      const systems = new Set([...replayed.values()].flatMap((r) => r.requests.filter((q) => q.role === role).map((q) => q.system)));
      assert.equal(systems.size, 1, `the ${role} system prompt differs between fixtures/rubrics (${systems.size} variants)`);
    }
  });

  test("band comparison (non-blocking for draft labels) and corpus size", (t) => {
    const rows: BandRow[] = [...replayed.values()].map((r) => bandRow(r.input!));
    const lines = ["fixture".padEnd(46) + "label source".padEnd(18) + "expected".padEnd(13) + "recorded".padEnd(13) + "dist  blocking  grounds(expected | recorded)"];
    for (const r of rows) {
      lines.push(
        r.fixtureId.padEnd(46) + r.labelSource.padEnd(18) + r.expected.padEnd(13) + String(r.recorded).padEnd(13) +
          String(r.distance).padEnd(6) + (r.blocking ? "yes" : "no").padEnd(10) + `[${r.expectedGrounds}] | [${r.recordedGrounds}]`
      );
    }
    for (const l of lines) t.diagnostic(l);

    const { share, expertCount } = expertBandShare(rows);
    t.diagnostic(`expert-labelled fixtures: ${expertCount} of the ${MIN_EXPERT_LABELLED_FIXTURES} the band gate needs; share within one band: ${share === null ? "n/a" : share.toFixed(2)} (threshold ${BAND_WITHIN_ONE_MIN_SHARE})`);
    if (expertCount < MIN_EXPERT_LABELLED_FIXTURES) {
      t.diagnostic(`WARNING: only ${expertCount} expert-labelled fixtures; the band gate is not yet meaningful (needs ${MIN_EXPERT_LABELLED_FIXTURES} to 50). See test/golden/README.md.`);
    }
    // The corpus-level threshold, enforced over expert-labelled fixtures only.
    if (share !== null) assert.ok(share >= BAND_WITHIN_ONE_MIN_SHARE, `band-within-one share ${share.toFixed(2)} is below the threshold ${BAND_WITHIN_ONE_MIN_SHARE} over ${expertCount} expert fixtures`);
    // Opt-in: turn the corpus-size floor into a failure once the corpus is meant to be complete.
    if (process.env.GOLDEN_ENFORCE_CORPUS_SIZE === "1") {
      assert.ok(expertCount >= MIN_EXPERT_LABELLED_FIXTURES, `${expertCount} expert-labelled fixtures, the gate needs at least ${MIN_EXPERT_LABELLED_FIXTURES}`);
    }
  });
});
