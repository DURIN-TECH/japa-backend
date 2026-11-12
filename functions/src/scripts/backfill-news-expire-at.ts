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
 * Reads in pages by document id with `select()` (no article bodies in memory).
 * Docs with no usable date are counted separately ("skipped, no dates") and
 * never given an invented expiry.
 *
 * Target-project guard: the CLI resolves the project the Admin SDK would write
 * to (key file, GOOGLE_CLOUD_PROJECT, GCLOUD_PROJECT), prints it, and aborts
 * with exit 1 if it differs from `--project`. See backfill-news-expire-at-guard.ts.
 *
 * Run:  npm run backfill:expireat -- --project japa-platform   (project is mandatory)
 *       npm run backfill:expireat:dev                          (pins durin-seli-dev)
 * Against the emulator: set FIRESTORE_EMULATOR_HOST.
 */
import { Timestamp, FieldPath } from "firebase-admin/firestore";
import { enforceBackfillTarget } from "./backfill-news-expire-at-guard";

/**
 * NOTE: `utils/firebase` and `news.service` are imported lazily inside
 * `backfillNewsExpireAt` (they initialise the Admin SDK on import). The CLI
 * must run the target-project guard first, so nothing here may touch the SDK
 * at module load.
 */

/** Firestore allows 500 writes per batch; stay under it. */
const BATCH_SIZE = 400;

/** Docs read per page (ordered by document id). Small enough to bound memory. */
const PAGE_SIZE = 300;

/** Counts logged per collection. */
export interface BackfillCounts {
  total: number;
  /** expireAt written. */
  updated: number;
  /** Already had `expireAt` (idempotent re-run). */
  skipped: number;
  /** No usable date to derive a deadline from: left alone, never given an invented expiry. */
  skippedNoDates: number;
}

/** Zeroed counts. */
const emptyCounts = (): BackfillCounts => ({ total: 0, updated: 0, skipped: 0, skippedNoDates: 0 });

/** True for a Firestore Timestamp (guards against missing/odd fields). */
const isTs = (v: unknown): v is Timestamp => v instanceof Timestamp;

/** Options, mainly so tests can use a tiny page size. */
export interface BackfillOptions {
  pageSize?: number;
}

/**
 * Walk `query` in pages ordered by document id (selecting only `fields`, so
 * bodies are never loaded) and set `expireAt` on every doc that lacks it,
 * committing in batches of BATCH_SIZE. `compute` returns null when the doc has
 * no usable date: it is counted in `skippedNoDates` and its id is logged.
 * Neither case invents an expiry.
 *
 * A doc deleted between read and commit fails that batch with NOT_FOUND (e.g.
 * the still-deployed `cleanupOldNews` running mid-backfill); the run aborts
 * and a re-run finishes the job, since it skips docs that already have a deadline.
 */
async function backfillQuery(
  label: string,
  baseQuery: FirebaseFirestore.Query,
  fields: string[],
  compute: (data: FirebaseFirestore.DocumentData) => Timestamp | null,
  pageSize: number,
  db: FirebaseFirestore.Firestore
): Promise<BackfillCounts> {
  const counts = emptyCounts();
  const noDateIds: string[] = [];
  let last: FirebaseFirestore.QueryDocumentSnapshot | undefined;

  for (;;) {
    let q = baseQuery.orderBy(FieldPath.documentId()).select(...fields).limit(pageSize);
    if (last) q = q.startAfter(last);
    const page = await q.get();
    if (page.empty) break;

    let batch = db.batch();
    let pending = 0;
    for (const doc of page.docs) {
      counts.total++;
      const data = doc.data();
      // Already has a deadline: leave it (idempotent re-runs).
      if (data.expireAt) {
        counts.skipped++;
        continue;
      }
      const expireAt = compute(data);
      if (!expireAt) {
        counts.skippedNoDates++;
        noDateIds.push(doc.ref.path);
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

    last = page.docs[page.docs.length - 1];
    if (page.size < pageSize) break;
  }

  // Make the docs that will never expire visible (first 20 ids).
  if (noDateIds.length > 0) {
    console.warn(`${label}: ${noDateIds.length} doc(s) have no dates and will never expire. First ids: ${noDateIds.slice(0, 20).join(", ")}`);
  }
  return counts;
}

/**
 * Backfill articles and per-source run logs. Exported for tests / reuse.
 * Deliberately has NO target-project guard: the CLI entry below runs it; tests
 * run it against the emulator.
 */
export async function backfillNewsExpireAt(options: BackfillOptions = {}): Promise<{
  articles: BackfillCounts;
  scrapeRuns: BackfillCounts;
}> {
  const pageSize = options.pageSize ?? PAGE_SIZE;
  // Lazy: these initialise the Admin SDK, which the CLI guard must precede.
  const { collections, db, subcollections } = await import("../utils/firebase");
  const { articleExpireAt, scrapeRunExpireAt } = await import("../services/news.service");

  console.log("Backfilling expireAt on newsArticles and newsSources/*/scrapeRuns…");

  // Articles: createdAt is the fallback base when publishedAt is missing.
  const articles = await backfillQuery(
    "newsArticles",
    collections.newsArticles,
    ["expireAt", "createdAt", "publishedAt"],
    (d) => {
      if (!isTs(d.createdAt) && !isTs(d.publishedAt)) return null;
      // A missing createdAt falls back to publishedAt (articleExpireAt takes the max).
      const created = isTs(d.createdAt) ? d.createdAt : (d.publishedAt as Timestamp);
      return articleExpireAt(isTs(d.publishedAt) ? d.publishedAt : null, created);
    },
    pageSize,
    db
  );

  // Per-source run logs: one subcollection per news source (ids only; no bodies).
  const sources = await collections.newsSources.select().get();
  const scrapeRuns = emptyCounts();
  for (const source of sources.docs) {
    const c = await backfillQuery(
      `newsSources/${source.id}/scrapeRuns`,
      subcollections.scrapeRuns(source.id),
      ["expireAt", "startedAt"],
      (d) => (isTs(d.startedAt) ? scrapeRunExpireAt(d.startedAt) : null),
      pageSize,
      db
    );
    scrapeRuns.total += c.total;
    scrapeRuns.updated += c.updated;
    scrapeRuns.skipped += c.skipped;
    scrapeRuns.skippedNoDates += c.skippedNoDates;
  }

  for (const [name, c] of [["newsArticles", articles], ["scrapeRuns (per source)", scrapeRuns]] as const) {
    console.log(
      `${name}: total=${c.total} updated=${c.updated} skipped (already has expireAt)=${c.skipped} skipped, no dates: ${c.skippedNoDates}`
    );
  }
  return { articles, scrapeRuns };
}

// Allow `node lib/scripts/backfill-news-expire-at.js` to run it directly.
if (require.main === module) {
  // Guard FIRST: resolve + print the project, abort on a mismatch, pin env vars.
  enforceBackfillTarget(process.argv.slice(2));
  backfillNewsExpireAt()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error("expireAt backfill failed:", error);
      process.exit(1);
    });
}
