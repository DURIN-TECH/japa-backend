// ============================================
// Unit tests — the e2e fixture's emulator-only guard (issue #361)
// ============================================
// The fixture (`npm run seed:e2e`) runs under the REAL dev project id, so it
// must refuse unless Firestore, Auth and Storage all point at local emulators.
// Pure cases call `checkEmulatorOnly`; the CLI cases spawn the real script with
// a scrubbed environment: it must exit 2 with a refusal and never load Firebase.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { spawnSync } from "node:child_process";

import {
  REQUIRED_EMULATOR_ENV,
  checkEmulatorOnly,
  isLocalEmulatorHost,
  parseEmulatorHost,
} from "../../src/scripts/e2e/emulator-guard";
import { parseE2eSeedArgs } from "../../src/scripts/seed-e2e";

/** A fully local environment (the e2e ports from firebase.e2e.json). */
const LOCAL = {
  FIRESTORE_EMULATOR_HOST: "127.0.0.1:19603",
  FIREBASE_AUTH_EMULATOR_HOST: "localhost:19605",
  FIREBASE_STORAGE_EMULATOR_HOST: "http://127.0.0.1:19606",
};

describe("parseEmulatorHost / isLocalEmulatorHost", () => {
  test("host:port with an optional http:// prefix", () => {
    assert.deepEqual(parseEmulatorHost("127.0.0.1:19603"), { host: "127.0.0.1", port: 19603 });
    assert.deepEqual(parseEmulatorHost("http://LOCALHOST:9199"), { host: "localhost", port: 9199 });
  });

  test("anything else is not a host", () => {
    for (const v of [undefined, "", "  ", "127.0.0.1", "127.0.0.1:", "127.0.0.1:abc", "127.0.0.1:70000", "https://127.0.0.1:1", "127.0.0.1:1/path", "user@127.0.0.1:1"]) {
      assert.equal(parseEmulatorHost(v), null, String(v));
    }
  });

  test("only localhost and 127.0.0.1 count as local", () => {
    assert.equal(isLocalEmulatorHost("localhost:1"), true);
    assert.equal(isLocalEmulatorHost("127.0.0.1:1"), true);
    for (const v of ["firestore.googleapis.com:443", "10.0.0.5:8080", "0.0.0.0:8080", "127.0.0.1.evil.com:80", "localhost.example.com:80"]) {
      assert.equal(isLocalEmulatorHost(v), false, v);
    }
  });
});

describe("checkEmulatorOnly", () => {
  test("all three local: allowed, project defaults to durin-seli-dev", () => {
    assert.deepEqual(checkEmulatorOnly(LOCAL), { ok: true, project: "durin-seli-dev" });
    assert.deepEqual(checkEmulatorOnly(LOCAL, "demo-e2e"), { ok: true, project: "demo-e2e" });
  });

  test("nothing set: refused, every variable named", () => {
    const r = checkEmulatorOnly({});
    assert.equal(r.ok, false);
    if (r.ok) return;
    for (const name of REQUIRED_EMULATOR_ENV) assert.ok(r.problems.some((p) => p.startsWith(`${name} is not set`)), name);
  });

  test("each variable unset or blank on its own: refused", () => {
    for (const name of REQUIRED_EMULATOR_ENV) {
      for (const value of [undefined, ""]) {
        const r = checkEmulatorOnly({ ...LOCAL, [name]: value });
        assert.equal(r.ok, false, `${name}=${String(value)}`);
      }
    }
  });

  test("each variable pointing off this machine: refused", () => {
    for (const name of REQUIRED_EMULATOR_ENV) {
      const r = checkEmulatorOnly({ ...LOCAL, [name]: "firestore.googleapis.com:443" });
      assert.equal(r.ok, false, name);
      if (!r.ok) assert.match(r.problems.join("\n"), new RegExp(`${name}=.*does not point at localhost`));
    }
  });

  test("production and unknown projects are refused, even fully local", () => {
    for (const p of ["japa-platform", "someone-elses-project", "demo-"]) assert.equal(checkEmulatorOnly(LOCAL, p).ok, false, p);
  });

  test("an environment naming another project is refused (no silent override)", () => {
    assert.equal(checkEmulatorOnly({ ...LOCAL, GCLOUD_PROJECT: "japa-platform" }).ok, false);
    assert.equal(checkEmulatorOnly({ ...LOCAL, GOOGLE_CLOUD_PROJECT: "japa-platform" }).ok, false);
    assert.equal(checkEmulatorOnly({ ...LOCAL, GCLOUD_PROJECT: "durin-seli-dev" }).ok, true);
  });
});

describe("parseE2eSeedArgs", () => {
  test("project forms and --fixture-only", () => {
    assert.deepEqual(parseE2eSeedArgs([]), { fixtureOnly: false });
    assert.deepEqual(parseE2eSeedArgs(["--project", "demo-x"]), { project: "demo-x", fixtureOnly: false });
    assert.deepEqual(parseE2eSeedArgs(["--project=demo-x", "--fixture-only"]), { project: "demo-x", fixtureOnly: true });
  });
});

describe("the seed:e2e script itself", () => {
  const script = path.join(__dirname, "../../src/scripts/seed-e2e.ts");
  /** Run the CLI with a scrubbed environment plus `extra`. */
  const run = (extra: Record<string, string>, args: string[] = []) =>
    spawnSync(process.execPath, ["--import", "tsx", script, ...args], {
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...extra },
      encoding: "utf8",
      timeout: 60_000,
    });

  for (const [label, env, args] of [
    ["no emulator variables", {}, []],
    ["Auth and Storage missing", { FIRESTORE_EMULATOR_HOST: "127.0.0.1:19603" }, []],
    ["Firestore pointing at Google", { ...LOCAL, FIRESTORE_EMULATOR_HOST: "firestore.googleapis.com:443" }, []],
    ["production project", LOCAL, ["--project", "japa-platform"]],
  ] as const) {
    test(`refuses: ${label}`, () => {
      const r = run({ ...env }, [...args]);
      assert.equal(r.status, 2, `${r.stdout}${r.stderr}`);
      assert.match(r.stderr, /Refused: the e2e fixture only runs against the LOCAL Firebase emulators/);
      // Never got as far as announcing a target (so never loaded Firebase).
      assert.doesNotMatch(r.stdout, /E2E fixture seed on the emulators/);
    });
  }
});
