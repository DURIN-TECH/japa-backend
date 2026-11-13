// ============================================
// Rubric review admin API (issue #125) — one decision per version, on the
// REAL Firestore emulator
// ============================================
//
// Why this suite exists: the unit suite (rubric-review.test.ts) runs on an
// in-memory Firestore whose transactions never contend, so it can prove the
// state checks (a decided version, a stale revision) but not the RACE. This
// suite fires two approvals at one pending version, on a real Firestore
// transaction, and asserts exactly one commits.
//
// Run it (non-default port; the project id must start with `demo-`):
//
//   firebase emulators:exec --only firestore --project demo-ai-team \
//     --config <a firebase.json with emulators.firestore.port = 8181> -- \
//     'GCLOUD_PROJECT=demo-ai-team RUBRIC_EMULATOR_TEST=1 \
//      FIRESTORE_EMULATOR_HOST=127.0.0.1:8181 \
//      node --import tsx --test test/scrapers/rubric/rubric-review.emulator.test.ts'
//
// `npm test` SKIPS this suite on purpose: its preload points every emulator
// host at a refusing port (test/helpers/setup.ts, issue #94), so unit tests can
// never touch a developer's emulator. The suite registers itself as skipped
// when RUBRIC_EMULATOR_TEST is not `1`.
//
// One emulator stack, one project, one route: this is a concurrency test, not
// a second copy of the unit suite. Snapshot text is served from memory (the
// citation check only needs it); Firestore — where the race happens — is real.

import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { Timestamp } from "firebase-admin/firestore";
import { db } from "../../../src/utils/firebase";
import { sha256Hex } from "../../../src/scrapers/guidance/guidance-snapshot.store";
import { rubricStore } from "../../../src/scrapers/rubric/rubric.store";
import {
  RubricReviewError,
  RubricReviewService,
  rubricVersionId,
} from "../../../src/services/rubric-review.service";
import { RubricAutoPublishService } from "../../../src/services/rubric-auto-publish.service";
import { DEFAULT_CONFIG } from "../../../src/scrapers/shared/alerts/scrape-alert-rules";
import { RUBRIC_SYSTEM_ACTOR_ID } from "../../../src/types/rubric";
import { A_TEXT, SOURCE_A_ID, SOURCE_A_URL } from "./fixtures/synthetic-guidance";
import { KEY_A, REVIEW_T0, routeAV1 } from "./rubric-review-fixtures";

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Only an explicit opt-in runs this suite (see the file header). */
const RUN = process.env.RUBRIC_EMULATOR_TEST === "1";

/** The suite's name and its skip form (`npm test` registers it skipped). */
const suite = RUN ? describe : describe.skip;

const ID_A1 = rubricVersionId(KEY_A, 1);
const HASH = sha256Hex(A_TEXT);
const NOW = Timestamp.fromMillis(REVIEW_T0 + 7_200_000);

/** The one snapshot this suite needs, served from memory. */
const snapshots = {
  async read(sourceId: string, contentHash: string): Promise<any> {
    return {
      schemaVersion: 1,
      sourceId,
      contentHash,
      docType: "html",
      url: SOURCE_A_URL,
      finalUrl: SOURCE_A_URL,
      fetchedAt: new Date(REVIEW_T0 - 3_600_000).toISOString(),
      text: A_TEXT,
      pages: null,
    };
  },
};

/** No fakes: real Firestore transactions, real clock injection. */
const service = new RubricReviewService({ snapshots: snapshots as any, now: () => NOW });

// Fail loudly rather than silently calling a real project, if someone runs
// the suite without the emulator environment.
if (RUN) {
  const host = process.env.FIRESTORE_EMULATOR_HOST ?? "";
  if (!host || host === "127.0.0.1:1") throw new Error("RUBRIC_EMULATOR_TEST=1 needs FIRESTORE_EMULATOR_HOST pointing at a running Firestore emulator");
  if (!(process.env.GCLOUD_PROJECT ?? "").startsWith("demo-")) throw new Error("the emulator suite needs GCLOUD_PROJECT=demo-… (never a real project)");
}

/** Point the source at the fixture snapshot, as the #39 crawl leaves it. */
async function seedSource(): Promise<void> {
  await db.doc(`guidanceSources/${SOURCE_A_ID}`).set({
    title: SOURCE_A_ID,
    url: SOURCE_A_URL,
    finalUrl: SOURCE_A_URL,
    docType: "html",
    status: "active",
    latestSnapshotId: HASH,
    lastContentHash: HASH,
    publishedDate: null,
  });
}

/** Route A version 1, pending, written through the real store. */
async function seed(): Promise<void> {
  await seedSource();
  const written = await rubricStore.writePendingVersion(routeAV1(HASH), [SOURCE_A_ID], { now: NOW });
  assert.equal(written.version, 1);
}

suite("rubric review on the Firestore emulator (issue #125)", () => {
  before(async () => {
    // Touch the emulator once: a wrong host fails here, not mid-race.
    await db.collection("visaRubrics").limit(1).get();
  });

  beforeEach(async () => {
    await db.recursiveDelete(db.collection("visaRubrics"));
    await db.recursiveDelete(db.collection("guidanceSources"));
    await db.recursiveDelete(db.collection("rubricReviewHistory"));
    await db.recursiveDelete(db.collection("rubricPublishRuns"));
  });

  after(async () => {
    await db.terminate();
  });

  test("two approvals fired at once: exactly one wins, the other is 409 ALREADY_DECIDED, and one audit entry records the winner", async () => {
    await seed();
    const detail = await service.getVersion(ID_A1);
    assert.ok(detail, "the seeded version is readable");
    assert.equal(detail.reviewStatus, "pending_review");
    assert.equal(detail.revision, 0);
    assert.equal(detail.approval.canApprove, true, JSON.stringify(detail.approval.blockers));

    /** One admin's approval of the same version at the same revision. */
    const approve = (reviewerUid: string) =>
      service.decide(
        ID_A1,
        {
          action: "approve",
          revision: 0,
          intentPolarity: "immigrant_intent_penalised",
          acknowledgedFlags: detail.approval.requiredAcknowledgements,
          reason: null,
        },
        reviewerUid
      );

    // Fired together, neither awaited first: the two transactions contend on
    // the version doc. Firestore retries the loser's transaction, whose
    // re-read then sees the version decided.
    const outcomes = await Promise.allSettled([approve("admin-one"), approve("admin-two")]);

    const won = outcomes.filter((o): o is PromiseFulfilledResult<any> => o.status === "fulfilled");
    const lost = outcomes.filter((o): o is PromiseRejectedResult => o.status === "rejected");
    assert.equal(won.length, 1, `exactly one approval commits (got ${won.length})`);
    assert.equal(lost.length, 1, "the other is refused");

    const refusal = lost[0].reason;
    assert.ok(refusal instanceof RubricReviewError, `expected a RubricReviewError, got ${String(refusal)}`);
    assert.equal(refusal.httpStatus, 409);
    assert.equal(refusal.code, "ALREADY_DECIDED");
    assert.doesNotMatch(refusal.message, /admin-(one|two)/, "the refusal does not name the other reviewer");

    // The winner's write is the only one, and it is complete.
    const winner = won[0].value;
    assert.equal(winner.version, 1);
    assert.equal(winner.revision, 1);
    const stored = await rubricStore.getVersionForReview(KEY_A, 1);
    assert.ok(stored);
    assert.equal(stored.reviewStatus, "approved");
    assert.equal(stored.revision, 1, "one decision, one revision step");
    assert.equal(stored.reviewedBy, winner.reviewedBy, "the stored reviewer is the winner");
    const head = await rubricStore.getHead(KEY_A);
    assert.equal(head?.approvedVersion, 1);
    assert.equal(head?.latestVersion, 1);

    const audit = await db.collection("rubricReviewHistory").get();
    assert.equal(audit.size, 1, "exactly one audit entry");
    assert.equal(audit.docs[0].data().by, winner.reviewedBy);
    assert.equal(audit.docs[0].data().action, "approve");
    assert.equal(audit.docs[0].data().revisionBefore, 0);
    assert.equal(audit.docs[0].data().revisionAfter, 1);

    // A third decision afterwards is refused the same way, not applied.
    await assert.rejects(
      () => service.decide(ID_A1, { action: "reject", revision: 1, reason: "changed my mind after the fact" }, "admin-three"),
      (err: unknown) => err instanceof RubricReviewError && err.code === "ALREADY_DECIDED" && err.httpStatus === 409
    );
    assert.equal((await db.collection("rubricReviewHistory").get()).size, 1);
  });

  // Issue #201: the automatic publisher on REAL transactions. The unit suite's
  // in-memory transaction never contends, so "a re-delivered trigger publishes
  // nothing twice" is proved here, with two deliveries of one version in flight.
  test("the automatic publisher delivered twice at once publishes ONCE: one audit entry by the system actor, one head move, one run record", async () => {
    await seed();
    const auto = new RubricAutoPublishService({
      review: service,
      loadSettings: async () => ({ settings: { mode: "auto", pauseAfterRollback: true, maxLeftOutShare: 0.15, maxPrimaryLeftOutShare: 0.2, minKeptShareOfServing: 0.7 }, exists: true, problems: [] }),
      checker: { check: async () => ({ ok: true, leftOut: [], resolvedFlagCodes: [], intentPolarity: "immigrant_intent_penalised" }) },
      planner: { plan: async () => ({ ok: true }) },
      raiseAlerts: async () => [],
      loadAlertConfig: async () => DEFAULT_CONFIG,
      now: () => NOW,
      appUrl: () => "https://portal.test",
    });
    const outcomes = await Promise.all([auto.onVersionCreated(KEY_A, 1), auto.onVersionCreated(KEY_A, 1)]);
    assert.equal(outcomes.filter((o) => o?.outcome === "published").length, 1, JSON.stringify(outcomes.map((o) => [o?.outcome, o?.reasonCodes])));
    const audit = await db.collection("rubricReviewHistory").get();
    assert.equal(audit.size, 1, "exactly one audit entry");
    assert.equal(audit.docs[0].data().by, RUBRIC_SYSTEM_ACTOR_ID);
    assert.equal(audit.docs[0].data().automatic, true);
    assert.equal((await rubricStore.getHead(KEY_A))?.approvedVersion, 1);
    assert.equal((await db.collection("rubricPublishRuns").get()).size, 1, "one run record");
    // A third delivery afterwards is a quiet no-op.
    const third = await auto.onVersionCreated(KEY_A, 1);
    assert.equal(third?.outcome, "skipped");
    assert.equal((await db.collection("rubricReviewHistory").get()).size, 1);
  });
});
