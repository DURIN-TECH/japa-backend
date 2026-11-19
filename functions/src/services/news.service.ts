import { collections, subcollections, db, increment } from "../utils/firebase";
import {
  NewsArticle,
  NewsSource,
  ScrapeRun,
  NewsSubscription,
  SupportedCountryCode,
  ArticleImportance,
  SourceStatus,
} from "../types/news";
import { Timestamp } from "firebase-admin/firestore";

// ============================================
// RETENTION + QUERY CONSTANTS (issue #19)
// ============================================

/**
 * How long an article is kept, in days, counted from the LATER of its
 * `publishedAt` and its ingest time (`createdAt`). Firestore TTL deletes the
 * doc about 24h after `expireAt` (declared in firestore.indexes.json
 * `fieldOverrides`, collection group `newsArticles`). Replaces the weekly
 * `cleanupOldNews` sweep, which only removed 400 docs per run.
 */
export const NEWS_ARTICLE_RETENTION_DAYS = 90;

/**
 * How long a per-source run log (`newsSources/{id}/scrapeRuns`) is kept, in
 * days from `startedAt`. Covered by the `scrapeRuns` TTL declaration, which is
 * collection-group scoped and so also matches these docs.
 */
export const NEWS_SCRAPE_RUN_RETENTION_DAYS = 30;

/** Milliseconds in a day (retention maths). */
const DAY_MS = 24 * 60 * 60 * 1000;

/** Firestore's cap on the number of values in one `in` filter. */
export const FIRESTORE_IN_LIMIT = 30;

/**
 * Split `values` into chunks of at most `size` (default: Firestore's `in`
 * limit of 30), keeping order. Pure: an empty input gives no chunks, so a
 * caller issues no query at all.
 */
export function chunkForInQuery<T>(values: readonly T[], size = FIRESTORE_IN_LIMIT): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < values.length; i += size) {
    chunks.push(values.slice(i, i + size));
  }
  return chunks;
}

/**
 * The TTL deadline of an article: the later of `publishedAt` and `createdAt`
 * plus 90 days. Using the later one keeps an article with a missing, future
 * or very old `publishedAt` for 90 days from ingest, instead of deleting it
 * within a day and re-scraping it from the feed. `publishedAt` may be absent
 * on legacy docs (the backfill passes whatever the doc has).
 */
export function articleExpireAt(
  publishedAt: Timestamp | undefined | null,
  createdAt: Timestamp
): Timestamp {
  const base = Math.max(publishedAt ? publishedAt.toMillis() : 0, createdAt.toMillis());
  return Timestamp.fromMillis(base + NEWS_ARTICLE_RETENTION_DAYS * DAY_MS);
}

/** The TTL deadline of a per-source run log: `startedAt` + 30 days. */
export function scrapeRunExpireAt(startedAt: Timestamp): Timestamp {
  return Timestamp.fromMillis(startedAt.toMillis() + NEWS_SCRAPE_RUN_RETENTION_DAYS * DAY_MS);
}

// ============================================
// QUERY OPTIONS
// ============================================

export interface GetArticlesOptions {
  countryCode?: SupportedCountryCode;
  importance?: ArticleImportance;
  sourceId?: string;
  limit?: number;
  startAfter?: Timestamp;
}

// ============================================
// NEWS SERVICE
// ============================================

class NewsService {
  // ============================================
  // ARTICLE OPERATIONS
  // ============================================

  async getArticles(options: GetArticlesOptions = {}): Promise<NewsArticle[]> {
    const limit = Math.min(options.limit || 20, 50);

    let query: FirebaseFirestore.Query = collections.newsArticles
      .where("isPublished", "==", true)
      .orderBy("publishedAt", "desc")
      .limit(limit);

    if (options.countryCode) {
      query = collections.newsArticles
        .where("isPublished", "==", true)
        .where("countryCodes", "array-contains", options.countryCode)
        .orderBy("publishedAt", "desc")
        .limit(limit);
    }

    if (options.startAfter) {
      query = query.startAfter(options.startAfter);
    }

    const snapshot = await query.get();
    return snapshot.docs.map((doc) => doc.data() as NewsArticle);
  }

  async getArticleById(articleId: string): Promise<NewsArticle | null> {
    const doc = await collections.newsArticles.doc(articleId).get();
    return doc.exists ? (doc.data() as NewsArticle) : null;
  }

  async createArticlesBatch(
    articles: Omit<
      NewsArticle,
      "id" | "viewCount" | "bookmarkCount" | "createdAt" | "updatedAt" | "expireAt"
    >[]
  ): Promise<number> {
    if (articles.length === 0) return 0;

    const batch = db.batch();
    const now = Timestamp.now();

    for (const data of articles) {
      const ref = collections.newsArticles.doc();
      const article: NewsArticle = {
        ...data,
        id: ref.id,
        viewCount: 0,
        bookmarkCount: 0,
        createdAt: now,
        updatedAt: now,
        // TTL deadline (see articleExpireAt): Firestore deletes the doc itself.
        expireAt: articleExpireAt(data.publishedAt, now),
      };
      batch.set(ref, article);
    }

    await batch.commit();
    return articles.length;
  }

  async incrementViewCount(articleId: string): Promise<void> {
    await collections.newsArticles.doc(articleId).update({
      viewCount: increment(1),
    });
  }

  /**
   * Which of the given hashes are already stored on a `newsArticles` doc.
   *
   * Replaces the per-article `isDuplicate` (two awaited queries per article):
   * the hashes are de-duplicated, split into chunks of at most 30 (Firestore's
   * `in` limit) and every chunk is queried at once, so a source with N
   * articles issues `2 * ceil(N / 30)` queries, run concurrently. Single-field
   * equality filters, so no composite index is needed. Only the hash field is
   * read (`select`), not whole articles.
   *
   * The result is ONE set holding matching url hashes and title hashes; the
   * two hash kinds are digests of different strings, so they cannot clash.
   * An article is a duplicate when its urlHash OR its titleHash is in it.
   *
   * Query-then-write, so it is race-safe only while one orchestrator runs
   * (the per-source lease guarantees that today; see #14).
   */
  async findExistingHashes(
    urlHashes: readonly string[],
    titleHashes: readonly string[]
  ): Promise<Set<string>> {
    const found = new Set<string>();

    // One query per chunk and per hash field, all started together.
    const lookups: Promise<void>[] = [];
    const lookup = (field: "urlHash" | "titleHash", hashes: readonly string[]) => {
      for (const chunk of chunkForInQuery([...new Set(hashes)])) {
        lookups.push(
          collections.newsArticles
            .where(field, "in", chunk)
            .select(field)
            .get()
            .then((snapshot) => {
              snapshot.docs.forEach((doc) => {
                const value = (doc.data() as Record<string, unknown>)[field];
                if (typeof value === "string") found.add(value);
              });
            })
        );
      }
    };
    lookup("urlHash", urlHashes);
    lookup("titleHash", titleHashes);

    await Promise.all(lookups);
    return found;
  }

  // ============================================
  // SOURCE OPERATIONS
  // ============================================

  async getActiveSources(): Promise<NewsSource[]> {
    const snapshot = await collections.newsSources
      .where("status", "==", "active" as SourceStatus)
      .orderBy("priority", "asc")
      .get();
    return snapshot.docs.map((doc) => doc.data() as NewsSource);
  }

  /**
   * Due = `active` and nextScrapeAt <= now, oldest first. `paused`,
   * `retired` and `broken` (auto-paused by the scraper, issue #107) sources
   * never match, so a source that keeps failing is not attempted again
   * until an admin resets it or runs it by hand.
   */
  async getDueSources(limit = 5): Promise<NewsSource[]> {
    const now = Timestamp.now();
    const snapshot = await collections.newsSources
      .where("status", "==", "active" as SourceStatus)
      .where("nextScrapeAt", "<=", now)
      .orderBy("nextScrapeAt", "asc")
      .limit(limit)
      .get();
    return snapshot.docs.map((doc) => doc.data() as NewsSource);
  }

  async getSourceById(sourceId: string): Promise<NewsSource | null> {
    const doc = await collections.newsSources.doc(sourceId).get();
    return doc.exists ? (doc.data() as NewsSource) : null;
  }

  // Issue #107: the per-run health write (`updateSourceAfterScrape`) moved
  // to the scrapers module (scrapers/news/news-source-health.ts), next to the
  // visa crawler's, so both apply the same auto-pause rules
  // (scrapers/shared/runs/source-health.ts).

  // ============================================
  // SCRAPE RUN OPERATIONS
  // ============================================

  /**
   * Start a per-source run log (`newsSources/{sourceId}/scrapeRuns`).
   * @param runId the run-wide `scrapeRuns/{runId}` record it belongs to
   *   (issue #81), when called from an orchestrator run.
   */
  async createScrapeRun(sourceId: string, runId?: string): Promise<string> {
    const ref = subcollections.scrapeRuns(sourceId).doc();
    const startedAt = Timestamp.now();
    const run: ScrapeRun = {
      id: ref.id,
      sourceId,
      ...(runId ? { runId } : {}),
      status: "running",
      articlesFound: 0,
      articlesNew: 0,
      articlesDuplicate: 0,
      articlesFailed: 0,
      startedAt,
      // TTL deadline for this log (replaces the weekly cleanup sweep).
      expireAt: scrapeRunExpireAt(startedAt),
    };
    await ref.set(run);
    return ref.id;
  }

  async completeScrapeRun(
    sourceId: string,
    runId: string,
    result: Partial<ScrapeRun>
  ): Promise<void> {
    const ref = subcollections.scrapeRuns(sourceId).doc(runId);
    await ref.update({
      ...result,
      completedAt: Timestamp.now(),
    });
  }

  async getScrapeRuns(sourceId: string, limit = 20): Promise<ScrapeRun[]> {
    const snapshot = await subcollections
      .scrapeRuns(sourceId)
      .orderBy("startedAt", "desc")
      .limit(Math.min(limit, 50))
      .get();
    return snapshot.docs.map((doc) => doc.data() as ScrapeRun);
  }

  // ============================================
  // SUBSCRIPTION OPERATIONS
  // ============================================

  async getSubscription(userId: string): Promise<NewsSubscription | null> {
    const snapshot = await collections.newsSubscriptions
      .where("userId", "==", userId)
      .limit(1)
      .get();
    return snapshot.empty
      ? null
      : (snapshot.docs[0].data() as NewsSubscription);
  }

  async upsertSubscription(
    userId: string,
    data: Partial<
      Omit<NewsSubscription, "id" | "userId" | "createdAt" | "updatedAt">
    >
  ): Promise<NewsSubscription> {
    const existing = await this.getSubscription(userId);

    if (existing) {
      const ref = collections.newsSubscriptions.doc(existing.id);
      await ref.update({ ...data, updatedAt: Timestamp.now() });
      const updated = await ref.get();
      return updated.data() as NewsSubscription;
    }

    const ref = collections.newsSubscriptions.doc();
    const now = Timestamp.now();
    const sub: NewsSubscription = {
      id: ref.id,
      userId,
      countryCodes: data.countryCodes || [],
      importanceThreshold: data.importanceThreshold || "normal",
      pushEnabled: data.pushEnabled ?? true,
      createdAt: now,
      updatedAt: now,
    };
    await ref.set(sub);
    return sub;
  }
}

export const newsService = new NewsService();
