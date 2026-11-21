// ============================================
// (#440) RubricStore.writeDerivedPendingVersion: the narrow write of a derived version
// ============================================
//
// A version built from its approved base over the SAME snapshots has the base's
// `sourceSetHash`, so `writePendingVersion`'s hash gate (rightly) writes nothing for it.
// The derived write is its own, narrow path. These tests (in-memory Firestore) prove it:
//  - writes version n + 1 as `pending_review`, moves only the head's `latestVersion`,
//    leaves `approvedVersion`, the source pointers and version n untouched;
//  - a second call writes nothing and says the version already exists;
//  - refuses a draft that is not pristine (review OR approval fields), a head that
//    moved, a base that is not approved, other snapshots, and a base whose stored
//    content is not what the caller built from;
//  - never overwrites an existing document;
//  - `writePendingVersion` still refuses the same draft (its gate is unchanged).

import { before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { Timestamp } from "firebase-admin/firestore";
import { fakeRunTransaction, resetStore, store } from "../../helpers/fake-firestore";
import { installRubricFakes, versionDoc, headDoc } from "./rubric-harness";
import { RubricStoreError, derivedBaseFingerprint, rubricStore, type RubricDraft } from "../../../src/scrapers/rubric/rubric.store";
import type { VisaRubric } from "../../../src/types/rubric";

/* eslint-disable @typescript-eslint/no-explicit-any */

const KEY = "schengen-area_schengen-area-short-stay";
const HASH = "c".repeat(64);
const NOW = Timestamp.fromMillis(Date.parse("2026-11-21T12:00:00Z"));

/** The approved base version 1 (content only: what the derived write compares). */
const base = (): VisaRubric =>
  ({
    schemaVersion: 1, routeKey: KEY, authorityId: "schengen-area", routeSlug: "schengen-area-short-stay", version: 1,
    reviewStatus: "approved", intentPolarity: "not_assessed", reviewedBy: "system", reviewedAt: null, rejectReason: null, revision: 1, supersededAt: null,
    intentPolarityProposal: null, severityLevels: ["high"], criteria: [{ criterionId: "c1", title: "A rule", source: { quote: "q", sourceId: "s", contentHash: "h" } }], intakeQuestions: [], evidenceItems: [],
    sourceSnapshots: [{ sourceId: "s", contentHash: "h" }], sourceSetHash: HASH, extractorModel: "m", extractorPromptVersion: "p", extractionRunId: "r", discardedCount: 0, discarded: [], suspiciousPassages: [], flags: [],
    excludedCriterionIds: ["c9"], createdAt: NOW,
  }) as unknown as VisaRubric;

/** The pristine derived draft (one rule changed). */
const draft = (over: Record<string, unknown> = {}): RubricDraft => {
  const { version: _v, excludedCriterionIds: _e, ...rest } = base() as any;
  void _v;
  void _e;
  return { ...rest, reviewStatus: "pending_review", intentPolarity: null, reviewedBy: null, reviewedAt: null, rejectReason: null, revision: 0, supersededAt: null, criteria: [{ criterionId: "c1", title: "A re-drafted rule", source: { quote: "q", sourceId: "s", contentHash: "h" } }], ...over } as RubricDraft;
};

/** Seed the head (approved = latest = 1) and the base version document. */
function seed(head: Record<string, unknown> = {}, v1: Record<string, unknown> = {}): void {
  store.set(`visaRubrics/${KEY}`, { routeKey: KEY, authorityId: "schengen-area", routeSlug: "schengen-area-short-stay", sourceIds: ["s"], approvedVersion: 1, latestVersion: 1, latestSourceSetHash: HASH, createdAt: NOW, updatedAt: NOW, ...head });
  store.set(`visaRubrics/${KEY}/rubricVersions/1`, { ...(base() as any), ...v1 });
}

const FP = derivedBaseFingerprint(base());

before(async () => {
  await installRubricFakes();
  rubricStore.runTransaction = fakeRunTransaction as any;
});
beforeEach(() => resetStore());

describe("(#440) the derived pending write", () => {
  test("stores version 2 as pending; only latestVersion moves; version 1 is untouched; a second call writes nothing", async () => {
    seed();
    const v1Before = JSON.stringify(versionDoc(KEY, 1));
    const first = await rubricStore.writeDerivedPendingVersion(draft(), { baseVersion: 1, baseFingerprint: FP, now: NOW });
    assert.deepEqual(first, { written: true, version: 2 });
    const v2 = versionDoc(KEY, 2);
    assert.equal(v2.reviewStatus, "pending_review");
    assert.equal(v2.version, 2);
    assert.equal(v2.criteria[0].title, "A re-drafted rule");
    const head = headDoc(KEY);
    assert.equal(head.latestVersion, 2);
    assert.equal(head.approvedVersion, 1, "the app keeps serving version 1");
    assert.equal(head.latestSourceSetHash, HASH);
    assert.deepEqual(head.sourceIds, ["s"]);
    assert.equal(JSON.stringify(versionDoc(KEY, 1)), v1Before, "version 1 is not changed");
    // The second run: version 2 already exists, nothing is written, no version 3.
    const second = await rubricStore.writeDerivedPendingVersion(draft(), { baseVersion: 1, baseFingerprint: FP, now: NOW });
    assert.deepEqual(second, { written: false, version: 2, reason: "already_exists" });
    assert.equal(versionDoc(KEY, 3), undefined);
  });

  test("a draft that is not pristine is refused (review fields and every approval field)", async () => {
    seed();
    for (const over of [{ reviewStatus: "approved" }, { revision: 1 }, { reviewedBy: "someone" }, { excludedCriterionIds: [] }, { exclusionNote: "x" }, { questionPlan: {} }, { ruleRepairs: [] }, { layerCheck: {} }, { layerConflicts: [] }, { evidenceHelpsCriterionIds: [] }, { outcomeStatistics: {} }]) {
      await assert.rejects(() => rubricStore.writeDerivedPendingVersion(draft(over), { baseVersion: 1, baseFingerprint: FP }), (e: unknown) => e instanceof RubricStoreError && e.code === "not_pending", JSON.stringify(over));
    }
    assert.equal(versionDoc(KEY, 2), undefined);
  });

  test("refuses when the head moved, the base is not approved, the snapshots differ or the stored base is not the caller's", async () => {
    const cases: [Record<string, unknown>, Record<string, unknown>, string, string][] = [
      [{ latestVersion: 2 }, {}, FP, "head_moved"],
      [{ approvedVersion: null }, {}, FP, "head_moved"],
      [{}, { reviewStatus: "rejected" }, FP, "base_not_approved"],
      [{ latestSourceSetHash: "e".repeat(64) }, {}, FP, "source_set_differs"],
      [{}, { criteria: [{ criterionId: "c1", title: "Edited since", source: { quote: "q", sourceId: "s", contentHash: "h" } }] }, FP, "base_changed"],
    ];
    for (const [head, v1, fp, reason] of cases) {
      resetStore();
      seed(head, v1);
      const r = await rubricStore.writeDerivedPendingVersion(draft(), { baseVersion: 1, baseFingerprint: fp });
      assert.equal(r.written, false, reason);
      assert.equal((r as any).reason, reason);
      assert.equal(versionDoc(KEY, 2), undefined, reason);
      assert.equal(headDoc(KEY).latestVersion, (head.latestVersion as number | undefined) ?? 1, `${reason}: the head is unchanged`);
    }
    resetStore();
    assert.equal(((await rubricStore.writeDerivedPendingVersion(draft(), { baseVersion: 1, baseFingerprint: FP })) as any).reason, "no_head");
  });

  test("(fix round 1) the same sources at the store level: missing hashes, or a snapshot list unlike the base's, are refused", async () => {
    // Both hashes missing: never read as "the same".
    resetStore();
    seed({ latestSourceSetHash: undefined });
    assert.equal(((await rubricStore.writeDerivedPendingVersion(draft({ sourceSetHash: undefined }), { baseVersion: 1, baseFingerprint: FP })) as any).reason, "source_set_differs");
    // The hash agrees but the draft lists another snapshot than the stored base.
    resetStore();
    seed();
    assert.equal(((await rubricStore.writeDerivedPendingVersion(draft({ sourceSnapshots: [{ sourceId: "s", contentHash: "other" }] }), { baseVersion: 1, baseFingerprint: FP })) as any).reason, "source_set_differs");
    assert.equal(versionDoc(KEY, 2), undefined);
  });

  test("never overwrites: a version 2 document that exists although the head does not point at it is refused", async () => {
    seed();
    store.set(`visaRubrics/${KEY}/rubricVersions/2`, { reviewStatus: "rejected", marker: "keep me" });
    await assert.rejects(() => rubricStore.writeDerivedPendingVersion(draft(), { baseVersion: 1, baseFingerprint: FP }), (e: unknown) => e instanceof RubricStoreError && e.code === "version_exists");
    assert.equal(versionDoc(KEY, 2).marker, "keep me");
  });

  test("writePendingVersion's hash gate is unchanged: the same draft is not written through it", async () => {
    seed();
    const r = await rubricStore.writePendingVersion(draft(), ["s"]);
    assert.deepEqual(r, { written: false, version: 1 });
    assert.equal(versionDoc(KEY, 2), undefined);
  });
});
