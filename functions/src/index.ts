import * as functions from "firebase-functions";
import { app } from "./app";

// ============================================
// HTTP FUNCTIONS
// ============================================

/**
 * Main API endpoint
 * All REST API routes are handled by Express.
 *
 * `secrets` binds Cloud Secret Manager values so they're injected into
 * `process.env` at runtime (1st-gen functions don't see secrets otherwise).
 *   - PAYSTACK_SECRET_KEY    — Paystack API/secret key (sk_test_… / sk_live_…)
 *   - PAYSTACK_CALLBACK_URL  — where Paystack redirects after checkout
 *   - RESEND_API_KEY         — Resend API key for transactional email (re_…)
 *   - EMAIL_FROM             — verified sender, e.g. "Seli <noreply@weareseli.com>"
 * Set them with `firebase functions:secrets:set <NAME>` before deploying.
 * Locally, the emulator reads them from `functions/.env.local` instead.
 *
 * Email is safe-rollout: until RESEND_API_KEY/EMAIL_FROM are set, the email channel
 * falls back to the stub/log path — so deploying without them won't break sends.
 */
// Email secrets are needed by EVERY function that sends transactional email — not
// just `api`, but the Firestore/auth/scheduled triggers below too. Gen-1 secrets are
// bound per-function, so each email-sending function must declare them.
const EMAIL_SECRETS = ["RESEND_API_KEY", "EMAIL_FROM"];

export const api = functions
  .runWith({
    secrets: ["PAYSTACK_SECRET_KEY", "PAYSTACK_CALLBACK_URL", ...EMAIL_SECRETS],
  })
  .https.onRequest(app);

// ============================================
// FIRESTORE TRIGGERS
// ============================================

import { collections } from "./utils/firebase";
import { agentService } from "./services/agent.service";
import { visaService } from "./services/visa.service";
import { newsScraperService } from "./services/news-scraper.service";
import { newsService } from "./services/news.service";
import { newsNotificationService } from "./services/news-notification.service";
import { claimsService } from "./services/claims.service";
import { notificationService } from "./services/notification.service";
import { NewsArticle } from "./types/news";
import { Timestamp } from "firebase-admin/firestore";

/**
 * When a new user is created via Firebase Auth
 * Create initial user document in Firestore
 */
export const onUserCreated = functions
  .runWith({ secrets: EMAIL_SECRETS })
  .auth.user()
  .onCreate(async (user) => {
    console.log("New user created:", user.uid);

    try {
    // Use create() rather than set() so this trigger only PROVISIONS a brand
    // new user document and never overwrites one that already exists.
    //
    // This matters because the Auth onCreate event is asynchronous and can
    // race with other writers of the same user doc — most notably the seed
    // script (which calls auth.createUser() and then writes a fully-populated
    // user doc with firstName/lastName/phone/etc.), and onboarding. A plain
    // set() here would replace the whole document with these empty defaults,
    // wiping out fields written by those other paths. create() is atomic: if
    // the doc already exists it throws ALREADY_EXISTS, which we treat as a
    // no-op so the richer, already-written data is preserved.
      await collections.users.doc(user.uid).create({
        id: user.uid,
        email: user.email || "",
        // Mirror the Auth displayName (if any) into first/last name so seeded or
        // dashboard-created users aren't left with blank names when this trigger
        // wins the race and creates the doc first. Onboarding still overwrites
        // these with the values the user actually enters.
        firstName: (user.displayName || "").split(" ")[0] || "",
        lastName: (user.displayName || "").split(" ").slice(1).join(" ") || "",
        onboardingCompleted: false,
        hasPassport: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      console.log("User document created for:", user.uid);
      // Provision the user's RBAC role claim. resolveRoleFromDb defaults brand-new
      // users to "client"; seeded admins / agents get reconciled here too.
      await claimsService
        .syncClaimsFromDb(user.uid)
        .catch((e) => console.error("Failed to set initial role claims:", e));

      // Welcome the new user (best-effort, in-app + email).
      await notificationService
        .notifyUser({
          userId: user.uid,
          type: "welcome",
          title: "Welcome to Seli",
          body: "Thanks for joining Seli — we're glad to have you on board. Sign in to get started.",
        })
        .catch((e) => console.error("Welcome notification failed:", e));
    } catch (error: unknown) {
    // ALREADY_EXISTS (Firestore gRPC code 6) means another writer (seed /
    // onboarding) already created the doc — that's expected and benign, so we
    // intentionally swallow it to keep their data intact. Anything else is a
    // real error worth logging.
      const code = (error as { code?: number }).code;
      if (code === 6) {
        console.log("User document already exists, skipping create for:", user.uid);
      } else {
        console.error("Error creating user document:", error);
      }
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
export const onApplicationUpdated = functions
  .runWith({ secrets: EMAIL_SECRETS })
  .firestore.document("applications/{applicationId}")
  .onUpdate(async (change, context) => {
    const before = change.before.data();
    const after = change.after.data();

    // Check if status changed
    if (before.status !== after.status) {
      console.log(
        `Application ${context.params.applicationId} status changed: ${before.status} -> ${after.status}`
      );

      try {
        // Friendly per-status copy (falls back to a humanized status).
        const statusMessages: Record<string, string> = {
          under_review: "Your application is now under review.",
          submitted_to_embassy: "Your application has been submitted to the embassy.",
          interview_scheduled: "Your interview has been scheduled.",
          approved: "Congratulations! Your visa has been approved.",
          rejected: "Unfortunately, your visa application was not approved.",
        };
        const message =
          statusMessages[after.status] ??
          `Your application status is now: ${after.status.replace(/_/g, " ")}`;

        // One call fans out to in-app + push + email (per the channel policy).
        await notificationService.notifyUser({
          userId: after.userId,
          type: "application_update",
          title: "Application Status Update",
          body: message,
          relatedEntityType: "application",
          relatedEntityId: context.params.applicationId,
          data: { status: after.status },
        });

        // On withdrawal, also notify the assigned agent their case was withdrawn.
        if (after.status === "withdrawn" && after.agentId) {
          await notificationService.notifyUser({
            userId: after.agentId,
            type: "application_withdrawn",
            title: "Case withdrawn",
            body: `${after.clientName || "A client"} withdrew their application.`,
            relatedEntityType: "application",
            relatedEntityId: context.params.applicationId,
          });
        }
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
export const onConsultationCreated = functions
  .runWith({ secrets: EMAIL_SECRETS })
  .firestore.document("consultations/{consultationId}")
  .onCreate(async (snapshot, context) => {
    const consultation = snapshot.data();
    console.log(
      `New consultation created: ${context.params.consultationId}`
    );

    try {
      // Resolve the agent's user id, then notify across in-app + push + email.
      const agentDoc = await collections.agents.doc(consultation.agentId).get();
      const agentUserId = agentDoc.data()?.userId;

      if (agentUserId) {
        await notificationService.notifyUser({
          userId: agentUserId,
          type: "consultation_booking",
          title: "New Consultation Booking",
          body: "You have a new consultation booking.",
          relatedEntityType: "consultation",
          relatedEntityId: context.params.consultationId,
        });
      }
    } catch (error) {
      console.error("Error notifying agent:", error);
    }
  });

/**
 * When a new payment request is created
 * Send push notification to the client so they can approve/reject
 */
export const onPaymentRequestCreated = functions
  .runWith({ secrets: EMAIL_SECRETS })
  .firestore.document("paymentRequests/{requestId}")
  .onCreate(async (snapshot, context) => {
    const request = snapshot.data();
    console.log(`New payment request created: ${context.params.requestId}`);

    try {
      const amountDisplay = (request.amount / 100).toLocaleString();
      await notificationService.notifyUser({
        userId: request.clientId,
        type: "payment_request",
        title: "New Payment Request",
        body: `Your agent requests ₦${amountDisplay} for ${request.description}.`,
        relatedEntityType: "payment_request",
        relatedEntityId: context.params.requestId,
        data: request.applicationId
          ? { applicationId: request.applicationId }
          : undefined,
      });
    } catch (error) {
      console.error("Error sending payment request notification:", error);
    }
  });

/**
 * When a review is added
 * Recalculate agent rating
 */
export const onReviewCreated = functions
  .runWith({ secrets: EMAIL_SECRETS })
  .firestore.document("agents/{agentId}/reviews/{reviewId}")
  .onCreate(async (snapshot, context) => {
    const { agentId, reviewId } = context.params;
    console.log(`New review added for agent: ${agentId}`);

    try {
      const agentUserId = (await collections.agents.doc(agentId).get()).data()
        ?.userId as string | undefined;
      if (agentUserId) {
        const review = snapshot.data();
        await notificationService.notifyUser({
          userId: agentUserId,
          type: "review_received",
          title: "New review received",
          body: review?.rating
            ? `You received a ${review.rating}-star review.`
            : "You received a new review.",
          relatedEntityType: "review",
          relatedEntityId: reviewId,
        });
      }
    } catch (error) {
      console.error("Error notifying agent of review:", error);
    }
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
export const sendConsultationReminders = functions
  .runWith({ secrets: EMAIL_SECRETS })
  .pubsub.schedule("0 8 * * *")
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

        // Notify the client across in-app + push + email (per the channel policy).
        await notificationService.notifyUser({
          userId: consultation.userId,
          type: "consultation_reminder",
          title: "Consultation Reminder",
          body: `You have a consultation scheduled tomorrow at ${consultation.scheduledTime}.`,
          relatedEntityType: "consultation",
          relatedEntityId: doc.id,
        });
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
