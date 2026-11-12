// ============================================
// Unit tests — target-project guard for the expireAt backfill (issue #19)
// ============================================
// Pure decision only: no env, no SDK, no emulator.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { decideBackfillTarget, parseProjectArg } from "../../../src/scripts/backfill-news-expire-at-guard";

describe("decideBackfillTarget", () => {
  test("allows a run whose resolved project matches the asked one", () => {
    const d = decideBackfillTarget({ asked: "durin-seli-dev", googleCloudProject: "durin-seli-dev", gcloudProject: "durin-seli-dev" });
    assert.equal(d.ok, true);
    if (d.ok) assert.equal(d.projectId, "durin-seli-dev");
  });

  test("pins the asked project when the environment names none", () => {
    const d = decideBackfillTarget({ asked: "japa-platform" });
    assert.equal(d.ok, true);
    if (d.ok) assert.match(d.message, /pinned from --project/);
  });

  test("aborts when no project was asked for", () => {
    const d = decideBackfillTarget({ gcloudProject: "japa-platform" });
    assert.equal(d.ok, false);
    assert.match(d.message, /No target project/);
  });

  test("aborts when GOOGLE_CLOUD_PROJECT points elsewhere (the :dev-to-prod hole)", () => {
    const d = decideBackfillTarget({ asked: "durin-seli-dev", googleCloudProject: "japa-platform", gcloudProject: "durin-seli-dev" });
    assert.equal(d.ok, false);
    assert.match(d.message, /asked for "durin-seli-dev".*"japa-platform"/);
  });

  test("aborts when a service-account key names another project, which wins over env vars", () => {
    const d = decideBackfillTarget({ asked: "durin-seli-dev", credentialProject: "japa-platform", googleCloudProject: "durin-seli-dev" });
    assert.equal(d.ok, false);
    assert.match(d.message, /key file/);
  });

  test("aborts when only GCLOUD_PROJECT disagrees", () => {
    const d = decideBackfillTarget({ asked: "japa-platform", googleCloudProject: "japa-platform", gcloudProject: "durin-seli-dev" });
    assert.equal(d.ok, false);
  });

  test("allows the emulator, says so, and ignores a mismatching project", () => {
    const d = decideBackfillTarget({ asked: "durin-seli-dev", googleCloudProject: "japa-platform", emulatorHost: "127.0.0.1:8080" });
    assert.equal(d.ok, true);
    if (d.ok) {
      assert.equal(d.emulator, true);
      assert.match(d.message, /EMULATOR/);
    }
  });
});

describe("parseProjectArg", () => {
  test("reads --project, --project= and -p", () => {
    assert.equal(parseProjectArg(["--project", "a"]), "a");
    assert.equal(parseProjectArg(["--project=b"]), "b");
    assert.equal(parseProjectArg(["-p", "c"]), "c");
    assert.equal(parseProjectArg([]), undefined);
  });
});
