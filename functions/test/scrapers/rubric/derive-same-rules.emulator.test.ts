// ============================================
// (#461) Storing version 3 as a same-rules copy of version 2 — on the REAL Firestore emulator
// ============================================
//
// The unit suite (derive-same-rules.test.ts) proves the build, the refusals and the plan. This
// suite runs the script's `runSameRules` with the REAL store over the Firestore emulator, on real
// transactions, twice:
//   1. version 3 is stored as a pending version (`visaRubrics/<key>/rubricVersions/3`), the head's
//      latestVersion becomes 3, approvedVersion stays 2, version 2 is unchanged and the approved read
//      (what the app serves) still returns version 2. The dry-run plan read version 2's AND version
//      1's check records from Firestore and plans 0 rule-check requests;
//   2. the second run reports that version 3 already exists and writes nothing: no version 4.
// No model is called (the plan's provider only names models). The AI kill switch is set in the
// emulator data first (`appConfig/aiSettings.enabled = false`).
//
// Run it (non-default ports; the project id must start with `demo-`):
//
//   firebase emulators:exec --only firestore --project demo-seli-461 \
//     --config <a firebase.json with emulators.firestore.port = 8489> -- \
//     'GCLOUD_PROJECT=demo-seli-461 RUBRIC_EMULATOR_TEST=1 \
//      FIRESTORE_EMULATOR_HOST=127.0.0.1:8489 \
//      node --import tsx --test test/scrapers/rubric/derive-same-rules.emulator.test.ts'
//
// `npm test` SKIPS this suite (it registers as skipped unless RUBRIC_EMULATOR_TEST is `1`).

import { before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { Timestamp } from "firebase-admin/firestore";
import { db } from "../../../src/utils/firebase";
import { rubricStore } from "../../../src/scrapers/rubric/rubric.store";
import { firestoreCheckerLedger } from "../../../src/scrapers/rubric/rubric-checker";
import { runSameRules } from "../../../src/scrapers/rubric/scripts/derive-version-from-one-rule";
import { loadPublishSettings } from "../../../src/scrapers/rubric/rubric-publish-settings";
import { ScriptedProvider, settingsWith } from "./checker-fakes";
import { KEY, PAGE, chainToV2 } from "./derive-same-rules-fixtures";

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

const NOW = Timestamp.fromMillis(Date.parse("2026-11-22T12:00:00Z"));
const headRef = () => db.collection("visaRubrics").doc(KEY);
const versionRef = (n: number) => headRef().collection("rubricVersions").doc(String(n));

suite("(#461) version 3 as a copy of version 2, on the Firestore emulator", () => {
  let chain: Awaited<ReturnType<typeof chainToV2>>;
  let v2Stored: any;
  before(async () => {
    // The AI kill switch first: nothing in this suite may reach a model.
    await db.collection("appConfig").doc("aiSettings").set({ enabled: false });
    // Versions 1 and 2 (approved), their check records (made by the real check over the fake provider), and
    // the head with version 2 approved and latest.
    chain = await chainToV2();
    await versionRef(1).set({ ...(chain.v1 as any), createdAt: NOW });
    await versionRef(2).set({ ...(chain.v2 as any), createdAt: NOW });
    await headRef().set({ ...chain.head, createdAt: NOW, updatedAt: NOW });
    await firestoreCheckerLedger.save(chain.v1Record);
    await firestoreCheckerLedger.save(chain.v2Record);
    v2Stored = (await versionRef(2).get()).data();
  });

  /** One run of the script's core with the real store and reads (version 2 and version 1 as read back). */
  const run = async (lines: string[]) => {
    const v2 = (await rubricStore.getVersionForReview(KEY, 2)) as any;
    const v1 = (await rubricStore.getVersionForReview(KEY, 1)) as any;
    return runSameRules({ v2, via: v1 }, { write: true }, {
      readHead: (key) => rubricStore.getHead(key),
      writeDerived: (draft, o) => rubricStore.writeDerivedPendingVersion(draft, o),
      // The real loader: no settings doc on the emulator reads as the manual default.
      readPublishSettings: loadPublishSettings,
      plan: { loadSettings: settingsWith(), loadCheckerRecord: (id) => firestoreCheckerLedger.load(id), readSnapshot: async () => PAGE, provider: new ScriptedProvider() },
      now: () => NOW,
      print: (l) => lines.push(l),
    });
  };

  test("first run: version 3 is stored pending; latestVersion 3, approvedVersion 2; version 2 untouched; the app serves version 2", async () => {
    const lines: string[] = [];
    const s = await run(lines);
    assert.equal(s.refusal, null, lines.join("\n"));
    assert.equal(s.written, true);
    const v3 = (await versionRef(3).get()).data() as any;
    assert.equal(v3.reviewStatus, "pending_review");
    assert.equal(v3.version, 3);
    assert.equal(v3.revision, 0);
    assert.equal(v3.excludedCriterionIds, undefined);
    assert.equal(v3.questionPlan, undefined);
    assert.equal(JSON.stringify(v3.criteria), JSON.stringify(v2Stored.criteria));
    assert.equal(JSON.stringify(v3.competence), JSON.stringify(v2Stored.competence));
    const head = (await headRef().get()).data() as any;
    assert.equal(head.latestVersion, 3);
    assert.equal(head.approvedVersion, 2);
    assert.deepEqual((await versionRef(2).get()).data(), v2Stored, "version 2 is not changed");
    assert.equal((await rubricStore.getApprovedRubricByKey(KEY))?.version, 2);
    // The plan read both check records from Firestore: nothing to ask in the rule check.
    assert.equal(s.plan?.check.kind, "planned");
    assert.deepEqual([(s.plan?.check as any).check, (s.plan?.check as any).trigger, (s.plan?.check as any).polarity], [0, 0, 0]);
    assert.equal(s.plan?.questionCheck.ifSameLeftOut, 6);
  });

  test("second run: version 3 already exists; nothing is written, no version 4", async () => {
    const lines: string[] = [];
    const before3 = (await versionRef(3).get()).data();
    const s = await run(lines);
    assert.equal(s.refusal, null);
    assert.equal(s.written, false);
    assert.equal(s.alreadyExists, true);
    assert.ok(lines.some((l) => l.includes("a version 3 already exists")));
    assert.equal((await versionRef(4).get()).exists, false);
    assert.deepEqual((await versionRef(3).get()).data(), before3);
    assert.equal(((await headRef().get()).data() as any).latestVersion, 3);
  });
});
