// ============================================
// Emulator tests — news dedup lookup + expireAt backfill (issue #19)
// ============================================
//
// Run with `npm run test:emulator` (Firestore emulator, Admin SDK).
//
// Pins, against a real Firestore:
//  - newsService.findExistingHashes across Firestore's 30-value `in` limit:
//    35 stored hashes of each kind are all found in one call (2 chunks per
//    hash field), and unknown hashes are not reported;
//  - the expireAt backfill: sets the field on legacy articles and per-source
//    run logs, and a SECOND run updates 0 (idempotent).
// TTL deletion itself is not emulated; the declaration in
// firestore.indexes.json is the checkable artefact.

import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Timestamp } from "firebase-admin/firestore";

import { resetEmulators } from "./helpers";

/* eslint-disable @typescript-eslint/no-explicit-any */

let db: any;
let collections: any;
let newsService: any;
let backfill: () => Promise<any>;

const DAY = 24 * 60 * 60 * 1000;

before(async () => {
  // Imported lazily so the emulator environment (checked by setup.ts) is in
  // place before the Admin SDK initialises.
  ({ db, collections } = await import("../../src/utils/firebase"));
  ({ newsService } = await import("../../src/services/news.service"));
  ({ backfillNewsExpireAt: backfill } = await import("../../src/scripts/backfill-news-expire-at"));
});

beforeEach(async () => {
  await resetEmulators();
});

after(async () => {
  await resetEmulators();
});

describe("findExistingHashes across the 30-value chunk boundary", () => {
  test("35 stored url hashes and 35 stored title hashes are all found", async () => {
    const batch = db.batch();
    for (let i = 0; i < 35; i++) {
      batch.set(collections.newsArticles.doc(`a${i}`), { id: `a${i}`, urlHash: `url-${i}`, titleHash: `title-${i}` });
    }
    await batch.commit();

    const urls = Array.from({ length: 35 }, (_, i) => `url-${i}`);
    const titles = Array.from({ length: 35 }, (_, i) => `title-${i}`);
    const found: Set<string> = await newsService.findExistingHashes(
      [...urls, "url-unknown"],
      [...titles, "title-unknown"]
    );

    assert.equal(found.size, 70);
    for (const h of [...urls, ...titles]) assert.ok(found.has(h), `missing ${h}`);
    assert.ok(!found.has("url-unknown"));
    assert.ok(!found.has("title-unknown"));
  });

  test("a hash stored only as a title hash is found from the title list", async () => {
    await collections.newsArticles.doc("x").set({ id: "x", urlHash: "u-x", titleHash: "t-x" });
    const found: Set<string> = await newsService.findExistingHashes(["nope"], ["t-x"]);
    assert.deepEqual([...found], ["t-x"]);
  });
});

describe("backfill-news-expire-at", () => {
  test("sets expireAt once, and a second run updates 0", async () => {
    const created = Timestamp.fromMillis(Date.now() - 5 * DAY);
    const old = Timestamp.fromMillis(Date.now() - 120 * DAY);
    await collections.newsArticles.doc("old").set({ id: "old", publishedAt: old, createdAt: created });
    await collections.newsArticles.doc("has").set({ id: "has", publishedAt: old, createdAt: created, expireAt: Timestamp.fromMillis(1) });
    await collections.newsSources.doc("s1").set({ id: "s1" });
    await collections.newsSources.doc("s1").collection("scrapeRuns").doc("r1").set({ id: "r1", startedAt: created });

    const first = await backfill();
    assert.deepEqual(first.articles, { total: 2, updated: 1, skipped: 1 });
    assert.deepEqual(first.scrapeRuns, { total: 1, updated: 1, skipped: 0 });

    const article = (await collections.newsArticles.doc("old").get()).data();
    assert.equal(article.expireAt.toMillis(), created.toMillis() + 90 * DAY);
    // An existing deadline is never overwritten.
    assert.equal((await collections.newsArticles.doc("has").get()).data().expireAt.toMillis(), 1);
    const run = (await collections.newsSources.doc("s1").collection("scrapeRuns").doc("r1").get()).data();
    assert.equal(run.expireAt.toMillis(), created.toMillis() + 30 * DAY);

    const second = await backfill();
    assert.equal(second.articles.updated, 0);
    assert.equal(second.scrapeRuns.updated, 0);
  });
});
