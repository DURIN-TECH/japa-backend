import * as functions from "firebase-functions";
import { app } from "./app";

// ============================================
// HTTP FUNCTIONS
// ============================================

/**
 * Main API endpoint
 * All REST API routes are handled by Express
 */
export const api = functions.https.onRequest(app);

// ============================================
// FIRESTORE TRIGGERS
// ============================================

import { collections, messaging } from "./utils/firebase";
import { agentService } from "./services/agent.service";
import { visaService } from "./services/visa.service";
import { newsScraperService } from "./services/news-scraper.service";
import { newsService } from "./services/news.service";
import { newsNotificationService } from "./services/news-notification.service";
import { NewsArticle } from "./types/news";
import { Timestamp } from "firebase-admin/firestore";

/**
 * When a new user is created via Firebase Auth
 * Create initial user document in Firestore
 */
export const onUserCreated = functions.auth.user().onCreate(async (user) => {
  console.log("New user created:", user.uid);

  try {
    await collections.users.doc(user.uid).set({
      id: user.uid,
      email: user.email || "",
      firstName: "",
      lastName: "",
      onboardingCompleted: false,
      hasPassport: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    console.log("User document created for:", user.uid);
  } catch (error) {
    console.error("Error creating user document:", error);
  }
});

/**
 * When a user is deleted from Firebase Auth
 * Clean up user data (or anonymize)
 */
export const onUserDeleted = functions.auth.user().onDelete(async (user) => {
  console.log("User deleted:", user.uid);

  try {
    // Delete user document
    await collections.users.doc(user.uid).delete();

    // Optionally: anonymize applications, reviews, etc.
    // For now, we'll just log
    console.log("User document deleted for:", user.uid);
  } catch (error) {
    console.error("Error cleaning up user data:", error);
  }
});

/**
 * When an application status changes
 * Send notification to user
 */
export const onApplicationUpdated = functions.firestore
  .document("applications/{applicationId}")
  .onUpdate(async (change, context) => {
    const before = change.before.data();
    const after = change.after.data();

    // Check if status changed
    if (before.status !== after.status) {
      console.log(
        `Application ${context.params.applicationId} status changed: ${before.status} -> ${after.status}`
      );

      try {
        // Get user's FCM tokens
        const userDoc = await collections.users.doc(after.userId).get();
        const user = userDoc.data();

        if (user?.fcmTokens?.length) {
          const statusMessages: Record<string, string> = {
            under_review: "Your application is now under review",
            submitted_to_embassy: "Your application has been submitted to the embassy",
            interview_scheduled: "Your interview has been scheduled",
            approved: "Congratulations! Your visa has been approved",
            rejected: "Unfortunately, your visa application was not approved",
          };

          const message = statusMessages[after.status];
          if (message) {
            await messaging.sendEachForMulticast({
              tokens: user.fcmTokens,
              notification: {
                title: "Application Update",
                body: message,
              },
              data: {
                type: "application_update",
                applicationId: context.params.applicationId,
                status: after.status,
              },
            });
          }
        }

        // Create notification record
        await collections.notifications.add({
          userId: after.userId,
          type: "application_update",
          title: "Application Status Update",
          body: `Your application status is now: ${after.status.replace(/_/g, " ")}`,
          relatedEntityType: "application",
          relatedEntityId: context.params.applicationId,
          isRead: false,
          createdAt: new Date(),
        });
      } catch (error) {
        console.error("Error sending notification:", error);
      }
    }

    // Update agent stats when application completes
    if (
      after.agentId &&
      (after.status === "approved" || after.status === "rejected")
    ) {
      await agentService.updateAgentStats(after.agentId);
    }
  });

/**
 * When a consultation is created
 * Send notification to agent
 */
export const onConsultationCreated = functions.firestore
  .document("consultations/{consultationId}")
  .onCreate(async (snapshot, context) => {
    const consultation = snapshot.data();
    console.log(
      `New consultation created: ${context.params.consultationId}`
    );

    try {
      // Get agent's user profile to get FCM tokens
      const agentDoc = await collections.agents.doc(consultation.agentId).get();
      const agent = agentDoc.data();

      if (agent) {
        const userDoc = await collections.users.doc(agent.userId).get();
        const user = userDoc.data();

        if (user?.fcmTokens?.length) {
          await messaging.sendEachForMulticast({
            tokens: user.fcmTokens,
            notification: {
              title: "New Consultation Booking",
              body: "You have a new consultation booking",
            },
            data: {
              type: "consultation_booking",
              consultationId: context.params.consultationId,
            },
          });
        }
      }
    } catch (error) {
      console.error("Error notifying agent:", error);
    }
  });

/**
 * When a new payment request is created
 * Send push notification to the client so they can approve/reject
 */
export const onPaymentRequestCreated = functions.firestore
  .document("paymentRequests/{requestId}")
  .onCreate(async (snapshot, context) => {
    const request = snapshot.data();
    console.log(`New payment request created: ${context.params.requestId}`);

    try {
      // Get client's FCM tokens for push notification
      const userDoc = await collections.users.doc(request.clientId).get();
      const user = userDoc.data();

      if (user?.fcmTokens?.length) {
        const amountDisplay = (request.amount / 100).toLocaleString();
        await messaging.sendEachForMulticast({
          tokens: user.fcmTokens,
          notification: {
            title: "Payment Request",
            body: `Your agent requests ₦${amountDisplay} for ${request.description}`,
          },
          data: {
            type: "payment_request",
            paymentRequestId: context.params.requestId,
            applicationId: request.applicationId,
          },
        });
      }

      // Create notification record for the client
      await collections.notifications.add({
        userId: request.clientId,
        type: "payment_request",
        title: "New Payment Request",
        body: `Your agent requests ₦${(request.amount / 100).toLocaleString()} for ${request.description}`,
        relatedEntityType: "payment_request",
        relatedEntityId: context.params.requestId,
        isRead: false,
        createdAt: new Date(),
      });
    } catch (error) {
      console.error("Error sending payment request notification:", error);
    }
  });

/**
 * When a review is added
 * Recalculate agent rating
 */
export const onReviewCreated = functions.firestore
  .document("agents/{agentId}/reviews/{reviewId}")
  .onCreate(async (snapshot, context) => {
    const { agentId } = context.params;
    console.log(`New review added for agent: ${agentId}`);

    // Rating is already updated in the service, but we can add
    // additional logic here if needed (e.g., notify agent)
  });

/**
 * When a visa type is updated
 * Update country stats
 */
export const onVisaTypeUpdated = functions.firestore
  .document("countries/{countryCode}/visaTypes/{visaTypeId}")
  .onWrite(async (change, context) => {
    const { countryCode } = context.params;
    console.log(`Visa type changed in country: ${countryCode}`);

    await visaService.updateCountryStats(countryCode);
  });

// ============================================
// SCHEDULED FUNCTIONS
// ============================================

/**
 * Daily: Clean up expired notifications
 * Runs every day at 3 AM
 */
export const cleanupNotifications = functions.pubsub
  .schedule("0 3 * * *")
  .onRun(async () => {
    console.log("Running notification cleanup...");

    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    try {
      const oldNotifications = await collections.notifications
        .where("isRead", "==", true)
        .where("createdAt", "<", thirtyDaysAgo)
        .get();

      const batch = collections.notifications.firestore.batch();
      oldNotifications.docs.forEach((doc) => {
        batch.delete(doc.ref);
      });

      await batch.commit();
      console.log(`Deleted ${oldNotifications.size} old notifications`);
    } catch (error) {
      console.error("Error cleaning up notifications:", error);
    }
  });

/**
 * Daily: Send consultation reminders
 * Runs every day at 8 AM
 */
export const sendConsultationReminders = functions.pubsub
  .schedule("0 8 * * *")
  .onRun(async () => {
    console.log("Sending consultation reminders...");

    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(0, 0, 0, 0);

    const dayAfterTomorrow = new Date(tomorrow);
    dayAfterTomorrow.setDate(dayAfterTomorrow.getDate() + 1);

    try {
      const upcomingConsultations = await collections.consultations
        .where("status", "==", "confirmed")
        .where("scheduledDate", ">=", tomorrow)
        .where("scheduledDate", "<", dayAfterTomorrow)
        .get();

      for (const doc of upcomingConsultations.docs) {
        const consultation = doc.data();

        // Get user's FCM tokens
        const userDoc = await collections.users.doc(consultation.userId).get();
        const user = userDoc.data();

        if (user?.fcmTokens?.length) {
          await messaging.sendEachForMulticast({
            tokens: user.fcmTokens,
            notification: {
              title: "Consultation Reminder",
              body: `You have a consultation scheduled tomorrow at ${consultation.scheduledTime}`,
            },
            data: {
              type: "consultation_reminder",
              consultationId: doc.id,
            },
          });
        }
      }

      console.log(
        `Sent ${upcomingConsultations.size} consultation reminders`
      );
    } catch (error) {
      console.error("Error sending consultation reminders:", error);
    }
  });

/**
 * Every 30 minutes: Scrape visa news from due sources
 */
export const scrapeNewsOrchestrator = functions
  .runWith({ memory: "512MB", timeoutSeconds: 540 })
  .pubsub.schedule("*/30 * * * *")
  .timeZone("UTC")
  .onRun(async () => {
    console.log("Running news scrape orchestrator...");
    try {
      const result = await newsScraperService.runOrchestrator();
      console.log(
        `Orchestrator complete: ${result.sourcesProcessed} sources, ${result.newArticles} new articles, ${result.errors} errors`
      );
    } catch (error) {
      console.error("News scrape orchestrator failed:", error);
    }
  });

/**
 * Weekly: Clean up old news articles and scrape runs
 * Runs every Sunday at 4 AM UTC
 */
export const cleanupOldNews = functions.pubsub
  .schedule("0 4 * * 0")
  .timeZone("UTC")
  .onRun(async () => {
    console.log("Running news cleanup...");
    try {
      const articlesDeleted = await newsService.cleanupOldArticles(90);
      const runsDeleted = await newsService.cleanupOldScrapeRuns(30);
      console.log(
        `News cleanup: ${articlesDeleted} articles, ${runsDeleted} scrape runs deleted`
      );
    } catch (error) {
      console.error("News cleanup failed:", error);
    }
  });

/**
 * When a new news article is created
 * Send notifications to subscribed users
 */
export const onNewsArticleCreated = functions.firestore
  .document("newsArticles/{articleId}")
  .onCreate(async (snapshot) => {
    const article = { ...snapshot.data(), id: snapshot.id } as NewsArticle;

    // Only notify for published, non-low importance articles
    if (!article.isPublished || article.importance === "low") {
      return;
    }

    try {
      const sentCount = await newsNotificationService.notifySubscribers(article);
      console.log(
        `News notification sent to ${sentCount} users for article: ${article.title}`
      );

      // Mark notification as sent
      await snapshot.ref.update({
        isNotificationSent: true,
        notificationSentAt: Timestamp.now(),
      });
    } catch (error) {
      console.error("Error notifying subscribers:", error);
    }
  });
