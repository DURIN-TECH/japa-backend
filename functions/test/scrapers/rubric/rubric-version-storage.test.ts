// ============================================
// Rubric versions too big for one Firestore document (issue #278)
// ============================================
//
// The UK Family draft came to 1,988,261 bytes, almost twice Firestore's 1 MiB
// document limit, and its save was refused after every model call had been
// paid for. These tests cover the fix, on the in-memory Firestore fake:
//
//  1. the pure layout: small versions stay ONE document (unchanged), large
//     ones become a header plus parts that each fit, and read back whole;
//  2. the store: a >1 MiB version written and read back through every read
//     path (review read, approved read, admin list), and a version written
//     the OLD way (one document, no `contentStorage`) still reads (dual read);
//  3. the review approval transaction reads a split version whole (the
//     publish path), and only touches the header;
//  4. the pre-flight size projection refuses a run before any model call;
//  5. the background job keeps every paid step when the save is refused, and
//     a restart finishes WITHOUT paying for any call again.
//
// The real-Firestore counterpart (a real 1 MiB refusal, real transactions) is
// rubric-version-storage.emulator.test.ts.

import { before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { Timestamp } from "firebase-admin/firestore";
import { fakeCollection, fakeRunTransaction, resetStore, store } from "../../helpers/fake-firestore";
import { fakeCollectionGroup } from "../../helpers/fake-collection-group";
import { RubricStoreError, rubricStore, type RubricDraft } from "../../../src/scrapers/rubric/rubric.store";
import {
  INLINE_MAX_BYTES,
  MAX_STORED_BYTES,
  PART_MAX_BYTES,
  STORED_BYTES_PER_INPUT_CHAR,
  VersionPartsError,
  VersionTooLargeError,
  assembleVersion,
  firestoreDocSize,
  firestoreValueSize,
  isPartitioned,
  layoutVersion,
  projectStoredBytes,
} from "../../../src/scrapers/rubric/rubric-version-storage";
import { RunStop } from "../../../src/scrapers/rubric/rubric-extraction.service";
import { rubricReviewService, rubricVersionId } from "../../../src/services/rubric-review.service";
import type { RubricDiscard, VisaRubric } from "../../../src/types/rubric";
import { A_TEXT, ROUTE_A, SOURCE_A_ID, SOURCE_A_URL } from "./fixtures/synthetic-guidance";
import { installRubricFakes, makeHarness, makeJobHarness, quiet, resetBucket, seedSource, snapshotStore, type Harness, type JobHarness } from "./rubric-harness";
import { KEY_A, REVIEW_T0, routeAV1 } from "./rubric-review-fixtures";
import { ROUTE, setUpMulti, storedStepKeys } from "./rubric-job-fixtures";

/* eslint-disable @typescript-eslint/no-explicit-any */

// ============================================
// Fixtures
// ============================================

/** Firestore's own per-document limit, the number the Family save broke. */
const ONE_MIB = 1_048_576;

/**
 * `n` discarded proposals of about 700 bytes each: the cheapest way to make a
 * VALID draft big (a discard needs no quote in the source), so the same
 * version can still be approved by the real review code.
 */
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

/** Route A v1 padded past 1 MiB with discards (still a valid, approvable draft). */
function bigDraft(hash: string, discards = 2_600): RubricDraft {
  const d = routeAV1(hash);
  return { ...d, discarded: bigDiscards(discards), discardedCount: discards };
}

/** Every stored document path under one version (the version doc and its parts). */
function partPaths(routeKey: string, version: number): string[] {
  return [...store.keys()].filter((p) => p.startsWith(`visaRubrics/${routeKey}/rubricVersions/${version}/rubricVersionParts/`)).sort();
}

/** The path of a version document. */
const versionPath = (routeKey: string, version: number) => `visaRubrics/${routeKey}/rubricVersions/${version}`;

before(async () => {
  await installRubricFakes();
  const firebase: any = await import("../../../src/utils/firebase");
  firebase.collections.rubricReviewHistory = fakeCollection("rubricReviewHistory");
  firebase.collectionGroups.rubricVersions = () => fakeCollectionGroup("rubricVersions");
  rubricStore.runTransaction = fakeRunTransaction as any;
  rubricReviewService.runTransaction = fakeRunTransaction as any;
  (rubricReviewService as any).deps.snapshots = snapshotStore;
  (rubricReviewService as any).deps.now = () => Timestamp.fromMillis(REVIEW_T0 + 7_200_000);
});

beforeEach(() => {
  resetStore();
  resetBucket();
});

/** Seed route A's source (as the crawl leaves it) and return its content hash. */
const seedA = () => seedSource({ id: SOURCE_A_ID, url: SOURCE_A_URL, text: A_TEXT, fetchedAtMs: REVIEW_T0 - 3_600_000 });

// ============================================
// 1. The pure layout
// ============================================

describe("layout (pure)", () => {
  test("the size estimate follows Firestore's rules (strings +1, numbers 8, field names +1)", () => {
    assert.equal(firestoreValueSize("abc"), 4);
    assert.equal(firestoreValueSize(12), 8);
    assert.equal(firestoreValueSize(null), 1);
    assert.equal(firestoreValueSize(true), 1);
    assert.equal(firestoreValueSize(Timestamp.fromMillis(0)), 8);
    assert.equal(firestoreValueSize({ ab: "c" }), 3 + 2);
    assert.equal(firestoreValueSize(["a", "b"]), 4);
    // A multi-byte character counts in UTF-8 bytes.
    assert.equal(firestoreValueSize("é"), 3);
  });

  test("a small version stays ONE document, exactly as before #278", () => {
    const v = { ...routeAV1("a".repeat(64)), version: 1 } as VisaRubric;
    const layout = layoutVersion(v, versionPath(KEY_A, 1));
    assert.equal(layout.kind, "inline");
    assert.equal((layout as any).doc, v, "the very same object is written");
  });

  test("a version over 1 MiB becomes a header plus parts that each fit, and reads back field for field", () => {
    const v = { ...bigDraft("a".repeat(64)), version: 1, quoteTranslations: { c1: { text: "x", lang: "fr" } } } as unknown as VisaRubric;
    assert.ok(firestoreDocSize(versionPath(KEY_A, 1), v as any) > ONE_MIB, "the fixture really is over the limit");
    const layout = layoutVersion(v, versionPath(KEY_A, 1));
    assert.equal(layout.kind, "parts");
    if (layout.kind !== "parts") return;
    assert.ok(layout.parts.length >= 2);
    // The header has no large arrays, and says how to put them back.
    for (const f of ["criteria", "discarded", "flags", "intakeQuestions", "evidenceItems", "suspiciousPassages", "quoteTranslations"]) assert.equal(f in layout.header, false, f);
    assert.equal(layout.header.contentStorage.partCount, layout.parts.length);
    assert.equal(layout.header.contentStorage.itemCounts.discarded, 2_600);
    // Every document fits comfortably.
    assert.ok(firestoreDocSize(versionPath(KEY_A, 1), layout.header) < PART_MAX_BYTES);
    for (const p of layout.parts) assert.ok(firestoreDocSize(`${versionPath(KEY_A, 1)}/rubricVersionParts/${p.index}`, p as any) <= PART_MAX_BYTES, `part ${p.index}`);
    // Back together: exactly the one-document version (same keys, same order).
    assert.equal(isPartitioned(layout.header), true);
    const back = assembleVersion(layout.header, layout.parts);
    assert.deepEqual(back, v);
    assert.equal("contentStorage" in back, false);
  });

  test("a missing or short part is refused, never served as half a rulebook", () => {
    const v = { ...bigDraft("a".repeat(64)), version: 1 } as unknown as VisaRubric;
    const layout = layoutVersion(v, versionPath(KEY_A, 1));
    if (layout.kind !== "parts") throw new Error("expected parts");
    assert.throws(() => assembleVersion(layout.header, layout.parts.slice(0, -1)), VersionPartsError);
    const short = layout.parts.map((p, i) => (i === 0 ? { ...p, entries: p.entries.map((e) => ({ ...e, items: e.items.slice(1) })) } : p));
    assert.throws(() => assembleVersion(layout.header, short), /expected/);
  });

  test("a version past the hard bound is refused (nothing is cut to make it fit)", () => {
    const n = Math.ceil(MAX_STORED_BYTES / 600) + 100;
    const v = { ...bigDraft("a".repeat(64), n), version: 1 } as unknown as VisaRubric;
    assert.throws(() => layoutVersion(v, versionPath(KEY_A, 1)), VersionTooLargeError);
  });

  test("the pre-flight projection is the measured Family ratio, rounded up", () => {
    assert.equal(STORED_BYTES_PER_INPUT_CHAR, 4);
    // Family: 608,864 characters gave 1,988,261 bytes; the projection is above that.
    assert.ok(projectStoredBytes(608_864) > 1_988_261);
    assert.ok(INLINE_MAX_BYTES < ONE_MIB && PART_MAX_BYTES < ONE_MIB);
  });
});

// ============================================
// 2. The store: write, read, dual read
// ============================================

describe("store", () => {
  test("a >1 MiB version is written as header + parts in one go, and every read returns it whole", async () => {
    const hash = await seedA();
    const draft = bigDraft(hash);
    const written = await rubricStore.writePendingVersion(draft, [SOURCE_A_ID]);
    assert.deepEqual(written, { written: true, version: 1 });

    const header = store.get(versionPath(KEY_A, 1)) as any;
    assert.equal(header.reviewStatus, "pending_review", "status stays on the header (queries and the trigger read it)");
    assert.equal(header.extractionRunId, draft.extractionRunId);
    assert.equal(header.discardedCount, 2_600);
    assert.equal(header.discarded, undefined, "the large array is not on the header");
    assert.equal(header.criteria, undefined);
    assert.ok(partPaths(KEY_A, 1).length >= 2);
    assert.equal(partPaths(KEY_A, 1).length, header.contentStorage.partCount);

    const read = await rubricStore.getVersionForReview(KEY_A, 1);
    assert.ok(read);
    assert.equal(read.criteria.length, draft.criteria.length);
    assert.deepEqual(read.discarded, draft.discarded);
    assert.deepEqual(read.criteria, draft.criteria);
    assert.equal("contentStorage" in read, false, "the storage marker never reaches a reader");
  });

  test("a version written the OLD way (one document, no contentStorage) still reads: dual read, no migration", async () => {
    const hash = await seedA();
    // Exactly what a pre-#278 write left (Standard Visitor v2, Graduate v1, ...).
    const legacy = { ...routeAV1(hash), version: 1, authorityId: "GB", routeSlug: ROUTE_A.visaTypeId };
    store.set(versionPath(KEY_A, 1), legacy as any);
    store.set(`visaRubrics/${KEY_A}`, { routeKey: KEY_A, countryCode: ROUTE_A.countryCode, visaTypeId: ROUTE_A.visaTypeId, approvedVersion: null, latestVersion: 1, latestSourceSetHash: legacy.sourceSetHash, sourceIds: [SOURCE_A_ID] } as any);
    const read = await rubricStore.getVersionForReview(KEY_A, 1);
    assert.equal(read?.criteria.length, 4);
    assert.deepEqual(partPaths(KEY_A, 1), [], "no parts were read or written");
  });

  test("a small new version is still one document (no parts)", async () => {
    const hash = await seedA();
    await rubricStore.writePendingVersion(routeAV1(hash), [SOURCE_A_ID]);
    assert.equal((store.get(versionPath(KEY_A, 1)) as any).criteria.length, 4);
    assert.equal((store.get(versionPath(KEY_A, 1)) as any).contentStorage, undefined);
    assert.deepEqual(partPaths(KEY_A, 1), []);
  });

  test("a version too large even for parts is refused with too_large, and nothing is written", async () => {
    const hash = await seedA();
    const n = Math.ceil(MAX_STORED_BYTES / 600) + 100;
    await assert.rejects(rubricStore.writePendingVersion(bigDraft(hash, n), [SOURCE_A_ID]), (err: unknown) => err instanceof RubricStoreError && err.code === "too_large");
    assert.equal(store.has(versionPath(KEY_A, 1)), false);
    assert.equal(store.has(`visaRubrics/${KEY_A}`), false, "no head either");
  });

  test("a split version with a part missing reads as an error for review, and serves nothing to consumers", async () => {
    const hash = await seedA();
    await rubricStore.writePendingVersion(bigDraft(hash), [SOURCE_A_ID]);
    // Pretend it was approved, then lose a part.
    store.set(versionPath(KEY_A, 1), { ...(store.get(versionPath(KEY_A, 1)) as any), reviewStatus: "approved" });
    store.set(`visaRubrics/${KEY_A}`, { ...(store.get(`visaRubrics/${KEY_A}`) as any), approvedVersion: 1 });
    store.delete(partPaths(KEY_A, 1).at(-1) as string);
    await assert.rejects(rubricStore.getVersionForReview(KEY_A, 1), (err: unknown) => err instanceof RubricStoreError && err.code === "parts_missing");
    const { result } = await quiet(() => rubricStore.getApprovedRubric(ROUTE_A.countryCode, ROUTE_A.visaTypeId));
    assert.equal(result, null);
  });
});

// ============================================
// 3. Review and publish read split versions whole
// ============================================

describe("review / publish on a split version", () => {
  test("the admin list counts a split version's rules and passages from its parts", async () => {
    const hash = await seedA();
    await rubricStore.writePendingVersion(bigDraft(hash), [SOURCE_A_ID]);
    const list = await rubricReviewService.listVersions({ reviewStatus: "pending_review", limit: 10 });
    assert.equal(list.length, 1);
    assert.equal(list[0].criterionCount, 4);
    assert.equal(list[0].discardedCount, 2_600);
  });

  test("approving a split version reads it whole inside the transaction, writes only the header, and serves it whole", async () => {
    const hash = await seedA();
    await rubricStore.writePendingVersion(bigDraft(hash), [SOURCE_A_ID]);
    const partsBefore = partPaths(KEY_A, 1).map((p) => JSON.stringify(store.get(p)));
    const id = rubricVersionId(KEY_A, 1);
    const detail = await rubricReviewService.getVersion(id);
    assert.ok(detail);
    assert.equal(detail.approval.canApprove, true, JSON.stringify(detail.approval.blockers));
    await quiet(() =>
      rubricReviewService.decide(id, { action: "approve", revision: 0, intentPolarity: "immigrant_intent_penalised", acknowledgedFlags: detail.approval.requiredAcknowledgements, reason: null } as any, "admin-uid")
    );
    // The header took the decision; the parts are untouched (immutable content).
    assert.equal((store.get(versionPath(KEY_A, 1)) as any).reviewStatus, "approved");
    assert.deepEqual(partPaths(KEY_A, 1).map((p) => JSON.stringify(store.get(p))), partsBefore);
    // Consumers get the whole approved rulebook.
    const served = await rubricStore.getApprovedRubric(ROUTE_A.countryCode, ROUTE_A.visaTypeId);
    assert.equal(served?.version, 1);
    assert.equal(served?.criteria.length, 4);
    assert.equal(served?.discarded.length, 2_600);
  });
});

// ============================================
// 4 + 5. Extraction: pre-flight, and keeping paid steps
// ============================================

describe("extraction", () => {
  let h: Harness;
  let jh: JobHarness;
  beforeEach(() => {
    h = makeHarness();
  });

  test("the pre-flight refuses a run whose projected size is past the bound, before any model call", () => {
    const chars = Math.ceil(MAX_STORED_BYTES / STORED_BYTES_PER_INPUT_CHAR) + 1;
    const chunks = [{ sourceId: "s", chunkIndex: 0, text: "x".repeat(chars) }] as any;
    const settings = { ...h.settings, maxRequestsPerRun: 1_000, maxInputCharsPerRun: chars * 2 };
    assert.throws(
      () => h.service.assertWithinCaps(chunks, settings),
      (err: unknown) => err instanceof RunStop && err.reasonCode === "projected_too_large" && err.status === "skipped"
    );
    // Today's dev caps (650,000 characters) project well inside the bound.
    assert.doesNotThrow(() => h.service.assertWithinCaps([{ sourceId: "s", chunkIndex: 0, text: "x".repeat(650_000) }] as any, { ...settings, maxInputCharsPerRun: 650_000 }));
    assert.equal(h.provider.requests.length, 0);
  });

  test("a refused save fails the job as rubric_too_large, keeps every paid step, and a restart finishes without a single new call", async () => {
    const setup = await setUpMulti(h, 1, 4);
    jh = makeJobHarness(h);
    const real = h.rubrics.writePendingVersion.bind(h.rubrics);
    h.rubrics.writePendingVersion = async () => {
      throw new RubricStoreError("too_large", "rubric version X/1 cannot be stored: simulated");
    };
    const id = (await quiet(() => jh.jobs.startJob({ ...ROUTE, sourceIds: setup.sourceIds }))).result.jobId as string;
    let out: any;
    for (let i = 0; i < 30; i++) {
      out = (await quiet(() => jh.jobs.advance(id))).result;
      if (out.kind === "finished" || out.kind === "idle") break;
    }
    assert.equal(out.kind, "finished");
    assert.equal(out.status, "failed");
    assert.equal(out.reasonCode, "rubric_too_large");
    const callsPaid = jh.calls.length;
    assert.equal(callsPaid, setup.calls);
    assert.equal(storedStepKeys(id).length, setup.calls, "every paid step is kept");

    // Fixed: the same start re-queues the same job, which goes straight to the save.
    h.rubrics.writePendingVersion = real;
    const again = (await quiet(() => jh.jobs.startJob({ ...ROUTE, sourceIds: setup.sourceIds }))).result;
    assert.equal(again.outcome, "restarted");
    assert.equal(again.jobId, id);
    for (let i = 0; i < 30; i++) {
      out = (await quiet(() => jh.jobs.advance(id))).result;
      if (out.kind === "finished" || out.kind === "idle") break;
    }
    assert.equal(out.status, "succeeded");
    assert.equal(jh.calls.length, callsPaid, "no model call was paid for twice");
  });
});
