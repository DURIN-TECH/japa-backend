// ============================================
// Unit tests — the #239 migration's project guard and the CLI refusal
// ============================================
// The migration must refuse production and an unnamed project BEFORE any Firebase
// module loads. The CLI cases spawn the real script with a scrubbed environment:
// it must exit 2 and print a refusal, and never reach Firestore.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { checkMigrationProject, parseMigrationArgs } from "../../src/scripts/shared-visa-model/project-guard";

describe("parseMigrationArgs", () => {
  test("dry run unless --apply; --dry-run wins; both --project forms", () => {
    assert.deepEqual(parseMigrationArgs([]), { dryRun: true });
    assert.deepEqual(parseMigrationArgs(["--project", "durin-seli-dev"]), { project: "durin-seli-dev", dryRun: true });
    assert.deepEqual(parseMigrationArgs(["--project=durin-seli-dev", "--apply"]), { project: "durin-seli-dev", dryRun: false });
    assert.equal(parseMigrationArgs(["--apply", "--dry-run"]).dryRun, true);
  });
});

describe("checkMigrationProject", () => {
  test("no project named: refused (the default project is never used)", () => {
    for (const p of [undefined, "", "   "]) assert.equal(checkMigrationProject(p, {}).ok, false);
  });

  test("production is refused, even when the environment agrees", () => {
    assert.equal(checkMigrationProject("japa-platform", {}).ok, false);
    assert.equal(checkMigrationProject("japa-platform", { GCLOUD_PROJECT: "japa-platform" }).ok, false);
  });

  test("only the dev project and demo-* emulator projects are allowed", () => {
    assert.deepEqual(checkMigrationProject("durin-seli-dev", {}), { ok: true, project: "durin-seli-dev" });
    assert.deepEqual(checkMigrationProject("demo-rehearsal", {}), { ok: true, project: "demo-rehearsal" });
    assert.equal(checkMigrationProject("some-other-project", {}).ok, false);
  });

  test("an environment that names a different project is refused (no silent override)", () => {
    assert.equal(checkMigrationProject("durin-seli-dev", { GCLOUD_PROJECT: "japa-platform" }).ok, false);
    assert.equal(checkMigrationProject("durin-seli-dev", { GOOGLE_CLOUD_PROJECT: "japa-platform" }).ok, false);
    assert.equal(checkMigrationProject("durin-seli-dev", { FIREBASE_CONFIG: JSON.stringify({ projectId: "japa-platform" }) }).ok, false);
    assert.equal(checkMigrationProject("durin-seli-dev", { GCLOUD_PROJECT: "durin-seli-dev" }).ok, true);
    // A FIREBASE_CONFIG that is a file path is not a project id: ignored.
    assert.equal(checkMigrationProject("durin-seli-dev", { FIREBASE_CONFIG: "/tmp/x.json" }).ok, true);
  });
});

describe("the script itself", () => {
  const script = path.join(__dirname, "../../src/scripts/migrate-shared-visa-model.ts");
  /** Run the CLI with no Google/Firebase environment at all. */
  const run = (args: string[]) =>
    spawnSync(process.execPath, ["--import", "tsx", script, ...args], {
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
      encoding: "utf8",
      timeout: 60_000,
    });

  for (const [label, args] of [
    ["no project", ["--apply"]],
    ["production", ["--project", "japa-platform", "--apply"]],
    ["production, dry run", ["--project=japa-platform"]],
    ["an unknown project", ["--project", "someone-elses-project"]],
  ] as const) {
    test(`refuses: ${label}`, () => {
      const r = run([...args]);
      assert.equal(r.status, 2, `${r.stdout}${r.stderr}`);
      assert.match(r.stderr, /Refused/);
      assert.doesNotMatch(r.stdout, /Project:/); // never got as far as pinning a project
    });
  }
});
