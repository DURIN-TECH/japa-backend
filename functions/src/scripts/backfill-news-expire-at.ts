/**
 * One-time migration (issue #19): give existing news docs an `expireAt` so
 * Firestore TTL can delete them.
 *
 * TTL never touches a doc that lacks the field, so without this script every
 * article / per-source run log written before #19 would live forever (the
 * weekly `cleanupOldNews` sweep that used to prune them is gone).
 *
 *  - `newsArticles/{id}`: expireAt = max(publishedAt, createdAt) + 90 days
 *    (`articleExpireAt`; the doc's own timestamps, so an old article expires
 *    at once on the next TTL pass, a fresh one lives out its 90 days).
 *  - `newsSources/{id}/scrapeRuns/{id}`: expireAt = startedAt + 30 days
 *    (`scrapeRunExpireAt`).
 *
 * Idempotent: docs that already have `expireAt` are skipped, so a second run
 * updates 0. Writes in batches of at most 400. Logs total / updated / skipped.
 *
 * Run:  npm run backfill:expireat        (project from the environment)
 *       npm run backfill:expireat:dev    (GCLOUD_PROJECT=durin-seli-dev)
 * Against the emulator: set FIRESTORE_EMULATOR_HOST.
 */
import { Timestamp } from "firebase-admin/firestore";
import { collections, db, subcollections } from "../utils/firebase";
import { articleExpireAt, scrapeRunExpireAt } from "../services/news.service";

/** Firestore allows 500 writes per batch; stay under it. */
const BATCH_SIZE = 400;

/** Counts logged per collection. */
export interface BackfillCounts {
  total: number;
  updated: number;
  skipped: number;
}

/**
 * Set `expireAt` (computed by `compute` from the doc's data) on every doc in
 * `docs` that lacks it, committing in batches of BATCH_SIZE. Docs whose
 * timestamps cannot be read are skipped (and counted as skipped) rather than
 * given a wrong deadline.
 */
async function backfillDocs(
  docs: FirebaseFirestore.QueryDocumentSnapshot[],
  compute: (data: FirebaseFirestore.DocumentData) => Timestamp | null
): Promise<BackfillCounts> {
  const counts: BackfillCounts = { total: 0, updated: 0, skipped: 0 };
  let batch = db.batch();
  let pending = 0;

  for (const doc of docs) {
    counts.total++;
    const data = doc.data();
    // Already has a deadline: leave it (idempotent re-runs).
    if (data.expireAt) {
      counts.skipped++;
      continue;
    }
    const expireAt = compute(data);
    if (!expireAt) {
      counts.skipped++;
      continue;
    }
    batch.update(doc.ref, { expireAt });
    counts.updated++;
    if (++pending >= BATCH_SIZE) {
      await batch.commit();
      batch = db.batch();
      pending = 0;
    }
  }
  if (pending > 0) await batch.commit();
  return counts;
}

/** True for a Firestore Timestamp (guards against missing/odd fields). */
const isTs = (v: unknown): v is Timestamp => v instanceof Timestamp;

/** Backfill articles and per-source run logs. Exported for tests / reuse. */
export async function backfillNewsExpireAt(): Promise<{
  articles: BackfillCounts;
  scrapeRuns: BackfillCounts;
}> {
  console.log("Backfilling expireAt on newsArticles and newsSources/*/scrapeRuns…");

  // Articles: createdAt is the fallback base when publishedAt is missing.
  const articleSnap = await collections.newsArticles.get();
  const articles = await backfillDocs(articleSnap.docs, (d) => {
    if (!isTs(d.createdAt) && !isTs(d.publishedAt)) return null;
    // A missing createdAt falls back to publishedAt (articleExpireAt takes the max).
    const created = isTs(d.createdAt) ? d.createdAt : (d.publishedAt as Timestamp);
    return articleExpireAt(isTs(d.publishedAt) ? d.publishedAt : null, created);
  });

  // Per-source run logs: one subcollection per news source.
  const sources = await collections.newsSources.get();
  const scrapeRuns: BackfillCounts = { total: 0, updated: 0, skipped: 0 };
  for (const source of sources.docs) {
    const runSnap = await subcollections.scrapeRuns(source.id).get();
    const c = await backfillDocs(runSnap.docs, (d) =>
      isTs(d.startedAt) ? scrapeRunExpireAt(d.startedAt) : null
    );
    scrapeRuns.total += c.total;
    scrapeRuns.updated += c.updated;
    scrapeRuns.skipped += c.skipped;
  }

  console.log(
    `newsArticles: total=${articles.total} updated=${articles.updated} skipped=${articles.skipped}`
  );
  console.log(
    `scrapeRuns (per source): total=${scrapeRuns.total} updated=${scrapeRuns.updated} skipped=${scrapeRuns.skipped}`
  );
  return { articles, scrapeRuns };
}

// Allow `node lib/scripts/backfill-news-expire-at.js` to run it directly.
if (require.main === module) {
  backfillNewsExpireAt()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error("expireAt backfill failed:", error);
      process.exit(1);
    });
}
