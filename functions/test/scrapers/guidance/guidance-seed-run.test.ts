// ============================================
// Guidance seed run guards (issue #111) — unit tests, no network, no emulator
// ============================================
//
// The seed script's decisions about whether a run may start (which project,
// which emulators, which `--only` ids) and whether a crawl did its job, as
// the pure functions in guidance-seed-run.ts. Project ids and source ids
// below are made up; the only rule the code knows is the `demo-` prefix.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  crawlTargetProblems,
  projectGuardProblems,
  unknownSourceIds,
} from "../../../src/scrapers/guidance/guidance-seed-run";
import type { GuidanceSourceResult } from "../../../src/scrapers/guidance/guidance-crawl.service";

// A real-looking (non-demo) project id and the two emulator hosts.
const REAL = "harbour-office-prod";
const DEMO = "demo-harbour";
const FS = "127.0.0.1:8391";
const ST = "127.0.0.1:9391";

/** The guard's problems, joined, for pattern assertions. */
const problems = (input: Parameters<typeof projectGuardProblems>[0]) => projectGuardProblems(input).problems.join(" | ");

describe("guidance seed run: project guard", () => {
  test("a demo project with BOTH emulators may read and write, with no confirmation", () => {
    const out = projectGuardProblems({ gcloudProject: DEMO, firestoreEmulatorHost: FS, storageEmulatorHost: ST, writes: true });
    assert.deepEqual(out, { problems: [], target: { projectId: DEMO, emulated: true } });
  });

  test("no project id is refused", () => {
    const out = projectGuardProblems({ writes: false });
    assert.equal(out.target, null);
    assert.match(out.problems.join(), /set GCLOUD_PROJECT/);
  });

  test("writing to a non-demo project is refused without --confirm-project=<same id>", () => {
    assert.match(problems({ gcloudProject: REAL, writes: true }), /refusing to write to harbour-office-prod.*pass --confirm-project=harbour-office-prod/);
    assert.match(problems({ gcloudProject: REAL, writes: true, confirmProject: "harbour-office-dev" }), /does not match the target project \(harbour-office-prod\): nothing written/);
    assert.match(problems({ gcloudProject: REAL, writes: true, confirmProject: "" }), /refusing to write/);
    assert.deepEqual(projectGuardProblems({ gcloudProject: REAL, writes: true, confirmProject: REAL }), {
      problems: [],
      target: { projectId: REAL, emulated: false },
    });
  });

  test("a read-only run on a non-demo project needs no confirmation", () => {
    assert.deepEqual(projectGuardProblems({ gcloudProject: REAL, writes: false }).problems, []);
    // ... but a confirmation naming ANOTHER project is still called out.
    assert.match(problems({ gcloudProject: REAL, writes: false, confirmProject: "elsewhere" }), /does not match the target project/);
  });

  test("mixed emulator settings are refused: one emulator host without the other", () => {
    assert.match(
      problems({ gcloudProject: DEMO, firestoreEmulatorHost: FS, writes: true }),
      /FIRESTORE_EMULATOR_HOST is set but FIREBASE_STORAGE_EMULATOR_HOST is not/
    );
    assert.match(
      problems({ gcloudProject: DEMO, storageEmulatorHost: ST, writes: false }),
      /FIREBASE_STORAGE_EMULATOR_HOST is set but FIRESTORE_EMULATOR_HOST is not/
    );
  });

  test("an emulator host with a non-demo project id is refused, even with a confirmation", () => {
    const out = projectGuardProblems({ gcloudProject: REAL, firestoreEmulatorHost: FS, storageEmulatorHost: ST, writes: true, confirmProject: REAL });
    assert.equal(out.target, null);
    assert.match(out.problems.join(), /an emulator host is set but the project id \(harbour-office-prod\) does not start with "demo-"/);
  });

  test("a demo project id without the emulators is refused", () => {
    assert.match(problems({ gcloudProject: DEMO, writes: false }), /is a demo-\* id but no emulator host is set/);
  });

  test("GCLOUD_PROJECT and GOOGLE_CLOUD_PROJECT must not disagree", () => {
    assert.match(
      problems({ gcloudProject: DEMO, googleCloudProject: REAL, firestoreEmulatorHost: FS, storageEmulatorHost: ST, writes: true }),
      /name different projects/
    );
    assert.deepEqual(
      projectGuardProblems({ googleCloudProject: DEMO, firestoreEmulatorHost: FS, storageEmulatorHost: ST, writes: true }).target,
      { projectId: DEMO, emulated: true }
    );
  });
});

describe("guidance seed run: --only ids", () => {
  test("an id that is not a seed entry is reported; no --only means nothing to report", () => {
    const seedIds = ["delta-rules-web", "delta-rules-pdf"];
    assert.deepEqual(unknownSourceIds(undefined, seedIds), []);
    assert.deepEqual(unknownSourceIds(["delta-rules-web"], seedIds), []);
    assert.deepEqual(unknownSourceIds(["delta-rules-wbe", "delta-rules-pdf", "delta-rules-wbe"], seedIds), ["delta-rules-wbe"]);
  });
});

describe("guidance seed run: did the crawl do its job", () => {
  const HASH = "a".repeat(64);
  /** A result line. */
  const line = (sourceId: string, outcome: GuidanceSourceResult["outcome"], extra: Partial<GuidanceSourceResult> = {}): GuidanceSourceResult => ({
    sourceId,
    outcome,
    ...extra,
  });
  /** Every listed id has a stored snapshot. */
  const snapshots = (...ids: string[]) => new Map<string, string | null>(ids.map((id) => [id, HASH]));

  test("changed, unchanged and not_due with a stored snapshot are complete", () => {
    const results = [line("one", "changed"), line("two", "unchanged"), line("three", "not_due")];
    assert.deepEqual(crawlTargetProblems({ results, warnings: [] }, ["one", "two", "three"], snapshots("one", "two", "three")), []);
  });

  test("a completed outcome WITHOUT a stored snapshot is not complete", () => {
    const got = crawlTargetProblems({ results: [line("one", "not_due"), line("two", "unchanged")] , warnings: [] }, ["one", "two"], new Map([["one", null]]));
    assert.deepEqual(got, ["one: outcome not_due but it has no stored snapshot", "two: outcome unchanged but it has no stored snapshot"]);
  });

  test("a targeted source that was skipped, deferred or failed makes the run fail, each with its reason", () => {
    const results = [
      line("unverified", "skipped_unverified"),
      line("paused", "skipped_inactive"),
      line("throttled", "deferred", { errorKind: "host_backoff", error: "retry later" }),
      line("gone", "failed", { errorKind: "http_error", error: "Fetch failed (HTTP 404)" }),
      line("ours", "infra_error", { errorKind: "storage_error", error: "bucket unavailable" }),
    ];
    const ids = results.map((r) => r.sourceId);
    assert.deepEqual(crawlTargetProblems({ results, warnings: [] }, ids, snapshots(...ids)), [
      "unverified: outcome skipped_unverified",
      "paused: outcome skipped_inactive",
      "throttled: outcome deferred (host_backoff): retry later",
      "gone: outcome failed (http_error): Fetch failed (HTTP 404)",
      "ours: outcome infra_error (storage_error): bucket unavailable",
    ]);
  });

  test("a source dropped after an unexpected error (a warning, no result line) makes the run fail", () => {
    const warnings = ["source one: skipped after an unexpected error: boom", "source other: change listener failed: x"];
    assert.deepEqual(crawlTargetProblems({ results: [], warnings }, ["one"], snapshots("one")), [
      "one: the crawl produced no result for it (source one: skipped after an unexpected error: boom)",
    ]);
    // An id the crawl never saw at all (not in the registry).
    assert.deepEqual(crawlTargetProblems({ results: [], warnings: [] }, ["absent"], new Map()), ["absent: the crawl produced no result for it"]);
  });

  test("a warning about a targeted source that did complete is still reported; other sources' are not", () => {
    const got = crawlTargetProblems(
      { results: [line("one", "changed"), line("two", "changed")], warnings: ["source one: change listener failed: x"] },
      ["one", "two"],
      snapshots("one", "two")
    );
    assert.deepEqual(got, ["one: source one: change listener failed: x"]);
  });

  test("only the TARGETED sources are judged", () => {
    const results = [line("one", "changed"), line("two", "failed", { errorKind: "http_error" })];
    assert.deepEqual(crawlTargetProblems({ results, warnings: [] }, ["one"], snapshots("one")), []);
  });
});
