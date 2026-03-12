import { collections, messaging } from "../utils/firebase";
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

        // Get user's FCM tokens
        const userDoc = await collections.users.doc(sub.userId).get();
        const user = userDoc.data();

        if (user?.fcmTokens?.length) {
          await messaging.sendEachForMulticast({
            tokens: user.fcmTokens,
            notification: {
              title: this.formatNotificationTitle(article),
              body: article.summary.slice(0, 150),
            },
            data: {
              type: "visa_news",
              articleId: article.id,
              countryCodes: article.countryCodes.join(","),
              importance: article.importance,
            },
          });
        }

        // Create in-app notification record
        await collections.notifications.add({
          userId: sub.userId,
          type: "visa_news",
          title: this.formatNotificationTitle(article),
          body: article.summary.slice(0, 200),
          relatedEntityType: "news_article",
          relatedEntityId: article.id,
          actionUrl: `/news/${article.id}`,
          isRead: false,
          createdAt: Timestamp.now(),
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
