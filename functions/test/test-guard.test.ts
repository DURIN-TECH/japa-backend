// ============================================
// Unit tests — the hermetic test guard itself (issue #94)
// ============================================
//
// Run with `npm test`. Checks what test/helpers/setup.ts (the `--import`
// preload of every test process) promises:
//  - the project id defaults to demo-unit-test and the Firestore emulator
//    host points at a refusing local port;
//  - an un-faked Firestore call rejects AT ONCE (no 20s retry / metadata
//    wait) with a message naming the call, and is recorded so the root
//    afterEach hook would fail the test that made it;
//  - an HTTP request to a Google host is blocked the same way;
//  - the preload refuses to run (exit 1) for a project id not starting
//    with `demo-`.
// Each test that triggers the guard on purpose drains the recorded
// violations itself, so the afterEach hook does not fail it.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import https from "node:https";
import * as path from "node:path";

/* eslint-disable @typescript-eslint/no-explicit-any */

/** The preload's violation list (same registry symbol as setup.ts). */
const violations = (): string[] => (globalThis as any)[Symbol.for("seli.test.guardViolations")];

/** Remove and return what the guard recorded (so afterEach stays green). */
const drain = (): string[] => violations().splice(0);

describe("hermetic test guard (issue #94)", () => {
  test("defaults: demo-unit-test project, emulator on a refusing port", () => {
    assert.equal(process.env.GCLOUD_PROJECT?.startsWith("demo-"), true);
    assert.equal(process.env.FIRESTORE_EMULATOR_HOST, "127.0.0.1:1");
    assert.equal(process.env.METADATA_SERVER_DETECTION, "none");
    assert.equal(process.env.GOOGLE_APPLICATION_CREDENTIALS, undefined);
    assert.ok(Array.isArray(violations()), "the preload is loaded");
  });

  test("an un-faked Firestore read fails at once with a clear message", async () => {
    const { db } = await import("../src/utils/firebase");
    const started = Date.now();
    await assert.rejects(
      db.collection("guardProbe").doc("x").get(),
      /Unfaked Firestore call "batchGetDocuments".*issue #94/
    );
    // Fail fast: no gRPC retries, no metadata-server wait.
    assert.ok(Date.now() - started < 1000, `took ${Date.now() - started}ms`);
    assert.deepEqual(drain(), ["Firestore call \"batchGetDocuments\""]);
  });

  test("an un-faked query and transaction are blocked too", async () => {
    const { db } = await import("../src/utils/firebase");
    await assert.rejects(db.collection("guardProbe").where("a", "==", 1).get(), /Unfaked Firestore call "runQuery"/);
    await assert.rejects(
      db.runTransaction(async (tx) => tx.get(db.collection("guardProbe").doc("y")), { maxAttempts: 1 }),
      /Unfaked Firestore call/
    );
    const seen = drain();
    assert.ok(seen.includes("Firestore call \"runQuery\""), seen.join(", "));
    assert.ok(seen.length >= 2, seen.join(", "));
  });

  test("HTTP to a Google host is blocked; the call is recorded", async () => {
    /** Run `open`; if the guard ever regresses and a request goes out,
     *  destroy it at once so this test fails instead of hanging the file. */
    const attempt = (open: () => { destroy: () => void }) => () => {
      const req = open();
      req.destroy();
    };
    assert.throws(
      attempt(() => https.request("https://oauth2.googleapis.com/token")),
      /Unfaked HTTP request to oauth2\.googleapis\.com/
    );
    assert.throws(
      attempt(() => https.get({ hostname: "metadata.google.internal", path: "/" })),
      /Unfaked HTTP request to metadata\.google\.internal/
    );
    // global fetch (undici) goes through the same rule.
    await assert.rejects(fetch("https://firestore.googleapis.com/v1/x"), /Unfaked fetch to firestore\.googleapis\.com/);
    assert.equal(drain().length, 3);
  });

  test("refuses to run for a project id that does not start with demo-", () => {
    const cwd = path.resolve(__dirname, "..");
    const r = spawnSync(process.execPath, ["--import", "tsx", "--import", "./test/helpers/setup.ts", "-e", ""], {
      cwd,
      env: { ...process.env, GCLOUD_PROJECT: "durin-seli-dev" },
      encoding: "utf8",
    });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /Refusing to run the unit tests.*GCLOUD_PROJECT=durin-seli-dev/);
  });
});
