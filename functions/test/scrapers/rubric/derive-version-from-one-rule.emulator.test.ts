// ============================================
// (#440) Storing version 2 from version 1 plus a one-rule result — on the REAL Firestore emulator
// ============================================
//
// The unit suites prove the build (derive-version-from-one-rule.test.ts) and the store's
// narrow write on an in-memory Firestore (rubric-derived-write.test.ts). This suite runs
// the script's `runDerive` with the REAL store over the Firestore emulator, on real
// transactions, twice:
//   1. version 2 is stored as a pending version (`visaRubrics/<key>/rubricVersions/2`),
//      the head's latestVersion becomes 2, approvedVersion stays 1, version 1 is unchanged
//      and the approved read (what the app serves) still returns version 1. The dry-run
//      plan read version 1's check record from Firestore and plans one rule-check request;
//   2. the second run reports that version 2 already exists and writes nothing: no version 3.
// No model is called (the plan's provider only names models). The AI kill switch is set
// in the emulator data first (`appConfig/aiSettings.enabled = false`).
//
// Run it (non-default ports; the project id must start with `demo-`):
//
//   firebase emulators:exec --only firestore --project demo-seli-440 \
//     --config <a firebase.json with emulators.firestore.port = 8488> -- \
//     'GCLOUD_PROJECT=demo-seli-440 RUBRIC_EMULATOR_TEST=1 \
//      FIRESTORE_EMULATOR_HOST=127.0.0.1:8488 \
//      node --import tsx --test test/scrapers/rubric/derive-version-from-one-rule.emulator.test.ts'
//
// `npm test` SKIPS this suite (it registers as skipped unless RUBRIC_EMULATOR_TEST is `1`).

import { before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { Timestamp } from "firebase-admin/firestore";
import { db } from "../../../src/utils/firebase";
import { rubricStore } from "../../../src/scrapers/rubric/rubric.store";
import { RubricCheckerService, firestoreCheckerLedger } from "../../../src/scrapers/rubric/rubric-checker";
import { runDerive } from "../../../src/scrapers/rubric/scripts/derive-version-from-one-rule";
import { loadPublishSettings } from "../../../src/scrapers/rubric/rubric-publish-settings";
import { MemoryLedger, ScriptedProvider, settingsWith } from "./checker-fakes";
import { HEAD, KEY, PAGE, outFor, version1 } from "./derive-version-fixtures";

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Only an explicit opt-in runs this suite. */
const RUN = process.env.RUBRIC_EMULATOR_TEST === "1";
const suite = RUN ? describe : describe.skip;

// Refuse to run against anything but an emulator with a demo project.
if (RUN) {
  const host = process.env.FIRESTORE_EMULATOR_HOST ?? "";
  if (!host || host === "127.0.0.1:1") throw new Error("RUBRIC_EMULATOR_TEST=1 needs FIRESTORE_EMULATOR_HOST pointing at a running Firestore emulator");
  if (!(process.env.GCLOUD_PROJECT ?? "").startsWith("demo-")) throw new Error("the emulator suite needs GCLOUD_PROJECT=demo-… (never a real project)");
}

const NOW = Timestamp.fromMillis(Date.parse("2026-11-21T12:00:00Z"));
const headRef = () => db.collection("visaRubrics").doc(KEY);
const versionRef = (n: number) => headRef().collection("rubricVersions").doc(String(n));

suite("(#440) version 2 from version 1 plus a one-rule result, on the Firestore emulator", () => {
  let v1Stored: any;
  before(async () => {
    // The AI kill switch first: nothing in this suite may reach a model.
    await db.collection("appConfig").doc("aiSettings").set({ enabled: false });
    // Version 1, approved and served, and its head (approved = latest = 1).
    const v1 = version1();
    await versionRef(1).set({ ...(v1 as any), createdAt: NOW });
    await headRef().set({ ...HEAD(), createdAt: NOW, updatedAt: NOW });
    // Version 1's check record, made by the real check over the fake provider (what version 2 reuses).
    const ledger = new MemoryLedger();
    const checker = new RubricCheckerService({ provider: () => new ScriptedProvider(), readSnapshot: async () => PAGE, loadSettings: settingsWith(), ledger, nowMs: () => NOW.toMillis(), sleep: async () => undefined });
    const out1 = await checker.check({ routeKey: KEY, version: 1, runId: `${KEY}__v1`, rubric: v1, codeLeftOutIds: [] });
    assert.equal(out1.ok, true);
    await firestoreCheckerLedger.save(ledger.docs.get(`${KEY}__v1`) as any);
    v1Stored = (await versionRef(1).get()).data();
  });

  /** One run of the script's core with the real store and reads. */
  const run = async (lines: string[]) =>
    runDerive({ v1: version1(), out: await outFor(), snapshot: PAGE }, { write: true }, {
      readHead: (key) => rubricStore.getHead(key),
      writeDerived: (draft, o) => rubricStore.writeDerivedPendingVersion(draft, o),
      // The real loader: no settings doc on the emulator reads as the manual default.
      readPublishSettings: loadPublishSettings,
      plan: { loadSettings: settingsWith(), loadCheckerRecord: (id) => firestoreCheckerLedger.load(id), readSnapshot: async () => PAGE, provider: new ScriptedProvider() },
      now: () => NOW,
      print: (l) => lines.push(l),
    });

  test("first run: version 2 is stored pending; latestVersion 2, approvedVersion 1; version 1 untouched; the app serves version 1", async () => {
    const lines: string[] = [];
    const s = await run(lines);
    assert.equal(s.refusal, null, lines.join("\n"));
    assert.equal(s.written, true);
    const v2 = (await versionRef(2).get()).data() as any;
    assert.equal(v2.reviewStatus, "pending_review");
    assert.equal(v2.version, 2);
    assert.equal(v2.revision, 0);
    assert.equal(v2.excludedCriterionIds, undefined);
    assert.equal(v2.questionPlan, undefined);
    assert.equal(v2.competence.steps.length, 3);
    const head = (await headRef().get()).data() as any;
    assert.equal(head.latestVersion, 2);
    assert.equal(head.approvedVersion, 1);
    assert.equal(head.latestSourceSetHash, version1().sourceSetHash);
    assert.deepEqual((await versionRef(1).get()).data(), v1Stored, "version 1 is not changed");
    const served = await rubricStore.getApprovedRubricByKey(KEY);
    assert.equal(served?.version, 1);
    // The plan read version 1's check record from Firestore: only the changed rules' one batch.
    assert.equal(s.plan?.check.kind, "planned");
    assert.equal((s.plan?.check as any).check, 1);
    assert.equal((s.plan?.check as any).polarity, 0);
  });

  test("second run: version 2 already exists; nothing is written, no version 3", async () => {
    const lines: string[] = [];
    const before2 = (await versionRef(2).get()).data();
    const s = await run(lines);
    assert.equal(s.refusal, null);
    assert.equal(s.written, false);
    assert.equal(s.alreadyExists, true);
    assert.ok(lines.some((l) => l.includes("a version 2 already exists")));
    assert.equal((await versionRef(3).get()).exists, false);
    assert.deepEqual((await versionRef(2).get()).data(), before2);
    assert.equal(((await headRef().get()).data() as any).latestVersion, 2);
    // The store's own guard says the same when called directly.
    const direct = await rubricStore.writeDerivedPendingVersion({ ...(before2 as any), version: undefined, reviewStatus: "pending_review" }, { baseVersion: 1, baseFingerprint: "x" });
    assert.deepEqual(direct, { written: false, version: 2, reason: "already_exists" });
  });
});
