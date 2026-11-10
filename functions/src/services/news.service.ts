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
import { Timestamp, FieldValue } from "firebase-admin/firestore";

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
      "id" | "viewCount" | "bookmarkCount" | "createdAt" | "updatedAt"
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
   * Check if a URL hash or title hash already exists.
   * Returns true if the article is a duplicate.
   */
  async isDuplicate(urlHash: string, titleHash: string): Promise<boolean> {
    // Check URL hash first (exact duplicate)
    const urlCheck = await collections.newsArticles
      .where("urlHash", "==", urlHash)
      .limit(1)
      .get();
    if (!urlCheck.empty) return true;

    // Check title hash (same title from different URL)
    const titleCheck = await collections.newsArticles
      .where("titleHash", "==", titleHash)
      .limit(1)
      .get();
    return !titleCheck.empty;
  }

  async cleanupOldArticles(olderThanDays: number): Promise<number> {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - olderThanDays);
    const cutoffTimestamp = Timestamp.fromDate(cutoff);

    const snapshot = await collections.newsArticles
      .where("publishedAt", "<", cutoffTimestamp)
      .limit(400)
      .get();

    if (snapshot.empty) return 0;

    const batch = db.batch();
    snapshot.docs.forEach((doc) => batch.delete(doc.ref));
    await batch.commit();
    return snapshot.size;
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

  /**
   * Record a scrape outcome on the source and schedule its next visit.
   *
   * @param notBeforeMs optional epoch ms the next visit must not precede —
   *   the host's Retry-After time after a 429/503 (issue #76). The next visit
   *   is the LATER of `now + scrapeIntervalMinutes` and this, so a long
   *   Retry-After pushes the source back but a short one never brings it
   *   forward.
   */
  async updateSourceAfterScrape(
    sourceId: string,
    success: boolean,
    errorMessage?: string,
    notBeforeMs?: number
  ): Promise<void> {
    const ref = collections.newsSources.doc(sourceId);
    const doc = await ref.get();
    if (!doc.exists) return;

    const source = doc.data() as NewsSource;
    const nextInterval = source.scrapeIntervalMinutes * 60 * 1000;
    const nextScrapeAt = Timestamp.fromMillis(
      Math.max(Date.now() + nextInterval, notBeforeMs ?? 0)
    );

    const updates: Record<string, unknown> = {
      lastScrapedAt: Timestamp.now(),
      nextScrapeAt,
      totalRuns: increment(1),
      updatedAt: FieldValue.serverTimestamp(),
    };

    if (success) {
      updates.consecutiveFailures = 0;
      updates.successfulRuns = increment(1);
      updates.reliabilityScore = Math.min(
        100,
        ((source.successfulRuns + 1) / (source.totalRuns + 1)) * 100
      );
    } else {
      updates.consecutiveFailures = source.consecutiveFailures + 1;
      updates.lastErrorMessage = errorMessage;
      updates.lastErrorAt = Timestamp.now();
      updates.reliabilityScore =
        (source.successfulRuns / (source.totalRuns + 1)) * 100;

      // Auto-pause after 5 consecutive failures
      if (source.consecutiveFailures + 1 >= 5) {
        updates.status = "broken";
        console.warn(
          `Source ${source.name} auto-paused after 5 consecutive failures`
        );
      }
    }

    await ref.update(updates);
  }

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
    const run: ScrapeRun = {
      id: ref.id,
      sourceId,
      ...(runId ? { runId } : {}),
      status: "running",
      articlesFound: 0,
      articlesNew: 0,
      articlesDuplicate: 0,
      articlesFailed: 0,
      startedAt: Timestamp.now(),
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

  /**
   * Delete per-source news run logs (`newsSources/{id}/scrapeRuns`) older
   * than `olderThanDays`, at most 400 per call (one batch).
   *
   * Issue #81: this used to be a collection-group query on "scrapeRuns",
   * which would ALSO match the new top-level `scrapeRuns/{runId}` run
   * records (same collection ID) and delete them after 30 days instead of
   * their 180-day TTL. It now queries each news source's subcollection
   * directly (a handful of sources), so top-level run records are never
   * touched here — they are removed only by the Firestore TTL policy.
   */
  async cleanupOldScrapeRuns(olderThanDays: number): Promise<number> {
    const cutoff = Timestamp.fromDate(
      new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000)
    );
    const MAX_DELETES = 400; // one batch (Firestore allows 500 writes)
    const sources = await collections.newsSources.get();
    const refs: FirebaseFirestore.DocumentReference[] = [];
    for (const source of sources.docs) {
      if (refs.length >= MAX_DELETES) break;
      const snapshot = await subcollections
        .scrapeRuns(source.id)
        .where("startedAt", "<", cutoff)
        .limit(MAX_DELETES - refs.length)
        .get();
      snapshot.docs.forEach((doc) => refs.push(doc.ref));
    }

    if (refs.length === 0) return 0;
    const batch = db.batch();
    refs.forEach((ref) => batch.delete(ref));
    await batch.commit();
    return refs.length;
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
