import { collections } from "../utils/firebase";
import { notificationService } from "./notification.service";
import { NewsArticle, NewsSubscription, ArticleImportance } from "../types/news";
import { Timestamp } from "firebase-admin/firestore";

const IMPORTANCE_RANK: Record<ArticleImportance, number> = {
  breaking: 4,
  high: 3,
  normal: 2,
  low: 1,
};

const COUNTRY_LABELS: Record<string, string> = {
  CA: "Canada",
  AU: "Australia",
  IE: "Ireland",
  GB: "UK",
};

class NewsNotificationService {
  /**
   * Notify subscribed users about a new article.
   * Returns the number of users notified.
   */
  async notifySubscribers(article: NewsArticle): Promise<number> {
    // 1. Find all subscriptions matching this article's countries
    const subscriberMap = new Map<string, NewsSubscription>();

    for (const countryCode of article.countryCodes) {
      const snapshot = await collections.newsSubscriptions
        .where("countryCodes", "array-contains", countryCode)
        .where("pushEnabled", "==", true)
        .get();

      for (const doc of snapshot.docs) {
        const sub = doc.data() as NewsSubscription;
        subscriberMap.set(sub.userId, sub);
      }
    }

    // Also include subscribers with empty countryCodes (subscribed to all)
    const allSnapshot = await collections.newsSubscriptions
      .where("countryCodes", "==", [])
      .where("pushEnabled", "==", true)
      .get();

    for (const doc of allSnapshot.docs) {
      const sub = doc.data() as NewsSubscription;
      subscriberMap.set(sub.userId, sub);
    }

    // 2. Filter by importance threshold
    const eligibleSubscribers = Array.from(subscriberMap.values()).filter(
      (sub) =>
        IMPORTANCE_RANK[article.importance] >=
        IMPORTANCE_RANK[sub.importanceThreshold]
    );

    if (eligibleSubscribers.length === 0) return 0;

    // 3. Send notifications, respecting rate limits
    const twentyFourHoursAgo = Timestamp.fromMillis(
      Date.now() - 24 * 60 * 60 * 1000
    );
    let sentCount = 0;

    for (const sub of eligibleSubscribers) {
      try {
        // Rate limit: max 3 news notifications per user per 24 hours
        const recentCount = await collections.notifications
          .where("userId", "==", sub.userId)
          .where("type", "==", "visa_news")
          .where("createdAt", ">", twentyFourHoursAgo)
          .count()
          .get();

        if (recentCount.data().count >= 3) {
          continue;
        }

        // Deliver through the unified notifier: it writes the inbox record and
        // sends the push (with the sound/badge payload, dead-token pruning and
        // the user's `notificationPreferences.push` opt-out). One body for both
        // inbox and push. Explicit channels so this stays in_app + push whatever
        // the central per-type policy says.
        await notificationService.notifyUser({
          userId: sub.userId,
          type: "visa_news",
          title: this.formatNotificationTitle(article),
          body: article.summary.slice(0, 150),
          channels: ["in_app", "push"],
          relatedEntityType: "news_article",
          relatedEntityId: article.id,
          actionUrl: `/news/${article.id}`,
          // FCM data values must be strings.
          data: {
            articleId: article.id,
            countryCodes: article.countryCodes.join(","),
            importance: article.importance,
          },
        });

        sentCount++;
      } catch (error) {
        console.error(`Failed to notify user ${sub.userId}:`, error);
      }
    }

    return sentCount;
  }

  private formatNotificationTitle(article: NewsArticle): string {
    const prefix =
      article.importance === "breaking"
        ? "[BREAKING] "
        : article.importance === "high"
          ? "[Important] "
          : "";
    const countries = article.countryCodes
      .map((c) => COUNTRY_LABELS[c] || c)
      .join(", ");
    return `${prefix}${countries} Visa News`;
  }
}

export const newsNotificationService = new NewsNotificationService();
