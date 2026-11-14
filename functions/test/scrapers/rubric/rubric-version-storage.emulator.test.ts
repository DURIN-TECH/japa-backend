// ============================================
// Rubric versions over 1 MiB (issue #278) — on the REAL Firestore emulator
// ============================================
//
// Why this suite exists: the unit suite (rubric-version-storage.test.ts) runs
// on an in-memory Firestore that has no document size limit, so it can prove
// the layout but not that Firestore ACCEPTS it. Here the same >1 MiB version
// that a single document cannot hold (the emulator refuses it, like the real
// service refused UK Family) is written through the store, read back whole,
// listed, and published by the automatic publisher (its gates and the shared
// approval transaction read the split version), on real transactions.
//
// Run it (non-default port; the project id must start with `demo-`):
//
//   firebase emulators:exec --only firestore --project demo-ai-team \
//     --config <a firebase.json with emulators.firestore.port = 8188> -- \
//     'GCLOUD_PROJECT=demo-ai-team RUBRIC_EMULATOR_TEST=1 \
//      FIRESTORE_EMULATOR_HOST=127.0.0.1:8188 \
//      node --import tsx --test test/scrapers/rubric/rubric-version-storage.emulator.test.ts'
//
// `npm test` SKIPS this suite on purpose (see rubric-review.emulator.test.ts):
// it registers itself as skipped when RUBRIC_EMULATOR_TEST is not `1`.

import { after, before, beforeEach, test } from "node:test";
import { describe } from "node:test";
import assert from "node:assert/strict";
import { Timestamp } from "firebase-admin/firestore";
import { db } from "../../../src/utils/firebase";
import { sha256Hex } from "../../../src/scrapers/guidance/guidance-snapshot.store";
import { rubricStore, type RubricDraft } from "../../../src/scrapers/rubric/rubric.store";
import { RubricReviewService } from "../../../src/services/rubric-review.service";
import { RubricAutoPublishService } from "../../../src/services/rubric-auto-publish.service";
import { DEFAULT_PUBLISH_SETTINGS } from "../../../src/scrapers/rubric/rubric-publish-settings";
import { DEFAULT_CONFIG } from "../../../src/scrapers/shared/alerts/scrape-alert-rules";
import { RUBRIC_SYSTEM_ACTOR_ID, type RubricDiscard } from "../../../src/types/rubric";
import { A_TEXT, ROUTE_A, SOURCE_A_ID, SOURCE_A_URL } from "./fixtures/synthetic-guidance";
import { KEY_A, REVIEW_T0, routeAV1 } from "./rubric-review-fixtures";

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Only an explicit opt-in runs this suite. */
const RUN = process.env.RUBRIC_EMULATOR_TEST === "1";
const suite = RUN ? describe : describe.skip;

const HASH = sha256Hex(A_TEXT);
const NOW = Timestamp.fromMillis(REVIEW_T0 + 7_200_000);

// Refuse to run against anything but an emulator with a demo project.
if (RUN) {
  const host = process.env.FIRESTORE_EMULATOR_HOST ?? "";
  if (!host || host === "127.0.0.1:1") throw new Error("RUBRIC_EMULATOR_TEST=1 needs FIRESTORE_EMULATOR_HOST pointing at a running Firestore emulator");
  if (!(process.env.GCLOUD_PROJECT ?? "").startsWith("demo-")) throw new Error("the emulator suite needs GCLOUD_PROJECT=demo-… (never a real project)");
}

/** The one snapshot the citation check needs, served from memory. */
const snapshots = {
  async read(sourceId: string, contentHash: string): Promise<any> {
    return { schemaVersion: 1, sourceId, contentHash, docType: "html", url: SOURCE_A_URL, finalUrl: SOURCE_A_URL, fetchedAt: new Date(REVIEW_T0 - 3_600_000).toISOString(), text: A_TEXT, pages: null };
  },
};

/** No fakes: the real review service on real transactions. */
const service = new RubricReviewService({ snapshots: snapshots as any, now: () => NOW });

/** ~700-byte discards: makes a VALID, approvable draft big (see the unit suite). */
function bigDiscards(n: number): RubricDiscard[] {
  return Array.from({ length: n }, (_, i) => ({
    itemType: "criterion" as const,
    reason: "number_not_in_quote" as const,
    detail: "check.value is not in the quote",
    label: `Proposal ${i} `.padEnd(400, "x"),
    sourceId: SOURCE_A_ID,
    chunkIndex: i % 40,
    ruleRef: `FM ${i}`,
    quoteHash: "a".repeat(64),
    quoteStart: "q".repeat(120),
  }));
}

/** Route A v1, padded to about 2 MB (the size of the UK Family draft). */
function bigDraft(): RubricDraft {
  const d = routeAV1(HASH);
  return { ...d, discarded: bigDiscards(2_900), discardedCount: 2_900 };
}

/** Point the source at the fixture snapshot, as the crawl leaves it. */
async function seedSource(): Promise<void> {
  await db.doc(`guidanceSources/${SOURCE_A_ID}`).set({ title: SOURCE_A_ID, url: SOURCE_A_URL, finalUrl: SOURCE_A_URL, docType: "html", status: "active", latestSnapshotId: HASH, lastContentHash: HASH, publishedDate: null });
}

/** A value made JSON-comparable (Timestamps to millis). */
function plain(v: unknown): unknown {
  return JSON.parse(JSON.stringify(v, (_k, x) => (x && typeof x === "object" && typeof x.toMillis === "function" ? { ms: x.toMillis() } : x)));
}

suite("rubric versions over 1 MiB on the Firestore emulator (issue #278)", () => {
  before(async () => {
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

  test("the fixture is real: Firestore refuses it as ONE document, exactly like the Family save", async () => {
    const one = { ...bigDraft(), version: 1 };
    await assert.rejects(db.doc(`visaRubrics/${KEY_A}/rubricVersions/1`).set(one), /exceeds the maximum allowed size|too large|INVALID_ARGUMENT/i);
  });

  test("the store writes it as header + parts and reads it back whole", async () => {
    await seedSource();
    const draft = bigDraft();
    const written = await rubricStore.writePendingVersion(draft, [SOURCE_A_ID], { now: NOW });
    assert.deepEqual(written, { written: true, version: 1 });
    const header = (await db.doc(`visaRubrics/${KEY_A}/rubricVersions/1`).get()).data() as any;
    assert.equal(header.reviewStatus, "pending_review");
    assert.equal(header.discarded, undefined);
    const parts = await db.collection(`visaRubrics/${KEY_A}/rubricVersions/1/rubricVersionParts`).get();
    assert.equal(parts.size, header.contentStorage.partCount);
    assert.ok(parts.size >= 3, `about 2 MB needs at least 3 parts (got ${parts.size})`);

    const read = await rubricStore.getVersionForReview(KEY_A, 1);
    assert.ok(read);
    assert.deepEqual(plain(read.discarded), plain(draft.discarded));
    assert.deepEqual(plain(read.criteria), plain(draft.criteria));
    assert.equal("contentStorage" in read, false);

    // The admin list (a collection-group query) counts from the parts.
    const list = await service.listVersions({ reviewStatus: "pending_review", limit: 10 });
    assert.equal(list.length, 1);
    assert.equal(list[0].criterionCount, 4);
  });

  test("a version stored the old way (one document) still reads and lists: dual read", async () => {
    await seedSource();
    const legacy = { ...routeAV1(HASH), version: 1, authorityId: ROUTE_A.countryCode, routeSlug: ROUTE_A.visaTypeId };
    await db.doc(`visaRubrics/${KEY_A}/rubricVersions/1`).set(legacy);
    await db.doc(`visaRubrics/${KEY_A}`).set({ routeKey: KEY_A, countryCode: ROUTE_A.countryCode, visaTypeId: ROUTE_A.visaTypeId, approvedVersion: null, latestVersion: 1, latestSourceSetHash: legacy.sourceSetHash, sourceIds: [SOURCE_A_ID], createdAt: NOW, updatedAt: NOW });
    const read = await rubricStore.getVersionForReview(KEY_A, 1);
    assert.equal(read?.criteria.length, 4);
    const list = await service.listVersions({ reviewStatus: "pending_review", limit: 10 });
    assert.equal(list[0].criterionCount, 4);
  });

  test("the automatic publisher's gates and the shared approval transaction publish a split version, and consumers get it whole", async () => {
    await seedSource();
    await rubricStore.writePendingVersion(bigDraft(), [SOURCE_A_ID], { now: NOW });
    const auto = new RubricAutoPublishService({
      review: service,
      loadSettings: async () => ({ settings: { ...DEFAULT_PUBLISH_SETTINGS, mode: "auto" }, exists: true, problems: [] }),
      checker: { check: async () => ({ ok: true, leftOut: [], resolvedFlagCodes: [], intentPolarity: "immigrant_intent_penalised" }) },
      planner: { plan: async () => ({ ok: true }) },
      raiseAlerts: async () => [],
      loadAlertConfig: async () => DEFAULT_CONFIG,
      now: () => NOW,
      appUrl: () => "https://portal.test",
    } as any);
    const report = await auto.onVersionCreated(KEY_A, 1);
    assert.equal(report?.outcome, "published", JSON.stringify(report?.reasonCodes));
    const audit = await db.collection("rubricReviewHistory").get();
    assert.equal(audit.size, 1);
    assert.equal(audit.docs[0].data().by, RUBRIC_SYSTEM_ACTOR_ID);
    const served = await rubricStore.getApprovedRubric(ROUTE_A.countryCode, ROUTE_A.visaTypeId);
    assert.equal(served?.version, 1);
    assert.equal(served?.criteria.length, 4);
    assert.equal(served?.discarded.length, 2_900);
  });
});
