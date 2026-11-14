import * as functions from "firebase-functions";
import { app } from "./app";
// The Anthropic secret list (issue #31). Importing this module is cheap: it
// does not load the Anthropic SDK (that happens lazily on the first model call).
import { refusalLetterService } from "./services/ai/refusal-letter.service";
import { AI_SECRETS } from "./services/ai/anthropic-client";

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
 *   - ANTHROPIC_API_KEY      — Anthropic API key for the AI tasks (AI_SECRETS, see below)
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

// Automated identity/document verification (Dojah by default). Bound to `api`
// because the compliance/KYC routes + the verification webhook live in the Express
// app. Absent secrets => provider `isConfigured=false` => runChecks() no-ops, so
// the manual review flow is unaffected (safe-rollout). `DOJAH_BASE_URL` selects
// sandbox (dev) vs live (prod); `VERIFICATION_PROVIDER`/`VERIFICATION_AUTO_APPROVE`
// are plain env (not secrets).
const VERIFICATION_SECRETS = [
  "DOJAH_APP_ID",
  "DOJAH_SECRET_KEY",
  "DOJAH_WEBHOOK_SECRET",
  "DOJAH_BASE_URL",
];

// Visa-catalog scraper LLM key (DeepSeek). Bound to the crawl orchestrator only.
// Absent => the extractor throws at call time (crawl records the page as failed),
// so deploying without a key is safe — no visas are ever wrongly published.
const VISA_CATALOG_SECRETS = ["DEEPSEEK_API_KEY"];

// Anthropic API key for the AI tasks (issue #31). `AI_SECRETS` is declared and
// exported in ONE place, services/ai/anthropic-client.ts (next to the factory
// that is the only reader of the key), and imported at the top of this file.
// Bound to:
//   - `api` only, for now — it will host the `/ai` routes.
// NOT bound to `onApplicationUpdated`: it only enqueues work and never calls
// the model. Assessments run in a dedicated Firestore-triggered worker built
// in #42; that worker adds `AI_SECRETS` to its own runWith when it lands,
// as do the later AI tasks (#115, #117, #118) for their functions.
// Absent at runtime => getAnthropicClient() throws "ANTHROPIC_API_KEY is not
// set for this project". Absent in Secret Manager at DEPLOY time => deploying
// `api` fails, so create the secret first
// (`firebase functions:secrets:set ANTHROPIC_API_KEY`). Only `durin-seli-dev`
// has it for now; production (`japa-platform`) is deliberately left unset.

export const api = functions
  .runWith({
    secrets: [
      "PAYSTACK_SECRET_KEY",
      "PAYSTACK_CALLBACK_URL",
      ...EMAIL_SECRETS,
      ...VERIFICATION_SECRETS,
      // Anthropic key for the upcoming `/ai` routes (issue #31).
      ...AI_SECRETS,
    ],
  })
  .https.onRequest(app);

// ============================================
// FIRESTORE TRIGGERS
// ============================================

import { collections } from "./utils/firebase";
import { rateService, FX_RATE_SECRETS } from "./money";
import { agentService } from "./services/agent.service";
import { visaService } from "./services/visa.service";
import { newsScraperService } from "./scrapers";
import { visaCatalogCrawlService } from "./scrapers";
import { guidanceCrawlService } from "./scrapers";
import { newsNotificationService } from "./services/news-notification.service";
import { claimsService } from "./services/claims.service";
import { notificationService } from "./services/notification.service";
import { unreadMessageReminderService } from "./services/unread-message-reminder.service";
import { scrapeRunService } from "./scrapers";
import { scrapeAlertService } from "./scrapers";
import { scrapeRunWorker } from "./scrapers";
import { aiCaseOfficerService } from "./services/ai-case-officer.service";
import { assessmentAutoRunService } from "./services/assessment-auto-run.service";
import { bulkReassessmentService } from "./services/ai-bulk-reassessment.service";
import { ruleChangeAlertsService } from "./services/rule-change-alerts.service";
import { rubricExtractionJobService, rubricExtractionService, routeOnboardingService } from "./scrapers";
import type { RubricReviewAuditEntry } from "./services/rubric-review.service";
import { rubricAutoPublishService } from "./services/rubric-auto-publish.service";
import { outcomeImportService, outcomeRunWorker, registeredDestinations } from "./scrapers";
import { documentCheckService } from "./services/ai/document-check.service";
import { NewsArticle } from "./types/news";
import { Timestamp } from "firebase-admin/firestore";
import { onUserContactWritten } from "./services/risk-rules/shared-contact.runner";

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

    // AI case-officer (issue #42): moving to under review queues an assessment.
    // Only writes the job document; it makes no model call and never throws.
    // The worker (processAssessmentJob) does the work, idempotently, by id.
    if (before.status !== after.status && after.status === "under_review") {
      await aiCaseOfficerService.enqueueForStatusChange(context.params.applicationId);
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
 * Risk rule (issue #121): shared contact detail across applicant accounts.
 *
 * Fires when a user document is created or its phone / email changes. The
 * handler only ever raises an admin-only risk signal (#119); it never touches
 * the user, notifies anyone or blocks anything, and it swallows its own
 * failures so the user write that triggered it is never affected.
 */
export const onUserContactChanged = functions.firestore
  .document("users/{userId}")
  .onWrite(async (change) => {
    await onUserContactWritten(
      change.before.exists ? (change.before.data() as Record<string, unknown>) : undefined,
      change.after.exists ? (change.after.data() as Record<string, unknown>) : undefined
    );
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
 * Every 15 minutes: nudge whoever has left a message unread for over an hour.
 *
 * Applies equally to clients and agents, and each is emailed a link into their
 * own view of the thread. Runs on a tighter cadence than the 1-hour threshold so
 * the nudge lands promptly after the hour elapses rather than up to an hour late;
 * the per-side reminder stamp is what prevents duplicates, not the interval.
 */
export const sendUnreadMessageReminders = functions
  .runWith({ secrets: EMAIL_SECRETS })
  .pubsub.schedule("*/15 * * * *")
  .timeZone("UTC")
  .onRun(async () => {
    console.log("Sending unread-message reminders...");
    try {
      const result = await unreadMessageReminderService.run();
      console.log(
        `Unread-message reminders: ${result.conversationsScanned} conversations ` +
          `scanned, ${result.remindersSent} sent, ${result.errors} errors`
      );
    } catch (error) {
      console.error("Unread-message reminder sweep failed:", error);
    }
  });

/**
 * Every 30 minutes: Scrape visa news from due sources
 */
// EMAIL_SECRETS (issue #83): the run's finalize hook evaluates the scraper
// alert rules and emails admins about new / escalated alerts from inside
// this function, so it needs the Resend secrets like any other sender.
export const scrapeNewsOrchestrator = functions
  .runWith({ memory: "512MB", timeoutSeconds: 540, secrets: EMAIL_SECRETS })
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
 * Visa catalog crawler — ticks HOURLY at :15 UTC and processes the country
 * sources that are due (`nextCrawlAt <= now`) AND inside their weekly local
 * night window (issue #63; e.g. GB Monday 02:15 Europe/London). Every seeded
 * zone has a whole-hour offset, so :15 UTC is :15 local too. Ticks with no
 * in-window due source return immediately (no FX call, no LLM). Fetches official
 * visa pages, and for pages whose content changed, extracts + stages a proposal
 * into `pendingVisaChanges` for agent approval. Never publishes to the live
 * catalog. See src/scrapers/visa-catalog/docs/visa-catalog-scraping-spike.md.
 */
export const crawlVisaCatalogOrchestrator = functions
  // EMAIL_SECRETS (issue #83): post-run alert emails, see scrapeNewsOrchestrator.
  .runWith({ memory: "512MB", timeoutSeconds: 540, secrets: [...VISA_CATALOG_SECRETS, ...EMAIL_SECRETS] })
  .pubsub.schedule("15 * * * *") // hourly at :15 (issue #63)
  .timeZone("UTC")
  .onRun(async () => {
    console.log("Running visa catalog crawl orchestrator...");
    try {
      const result = await visaCatalogCrawlService.runOrchestrator();
      console.log(
        `Visa catalog crawl: ${result.sourcesProcessed} sources, ${result.pagesFetched} pages, ` +
          // promptReextracts (issue #71): unchanged pages re-extracted because
          // their pending doc came from an older extractor prompt.
          `${result.pagesChanged} changed + ${result.promptReextracts} prompt re-extracts → ` +
          `${result.created} new / ${result.updated} updated / ` +
          `${result.skipped} skipped, ${result.errors} errors` +
          // Issue #69: pages not extracted because their linked surcharge
          // page (UK IHS) could not be fetched/parsed — part of `errors`.
          (result.linkedSurchargeErrors ? ` (${result.linkedSurchargeErrors} linked-surcharge errors)` : "")
      );
    } catch (error) {
      console.error("Visa catalog crawl orchestrator failed:", error);
    }
  });

/**
 * Caseworker-guidance crawler (issue #143) — ONCE A NIGHT at 03:20 UTC.
 * Weekly-or-nightly cadence per source is not decided here: every source
 * carries its own `checkIntervalHours`, and a tick only requests the sources
 * that are due (a source checked recently answers `not_due` without a
 * request), so a tick with nothing due returns at once: no run record, no
 * alert. :20 is off the other ticks (:00 / :15 / :30 / :45), so it never
 * lands on the same minute as the news, visa or alert-check functions.
 *
 * Fetches go through the shared fetch service (robots.txt, per-host gap,
 * 429/503 backoff) that `guidanceCrawlService` uses by default; each run is a
 * `scrapeRuns` doc of kind "guidance", each source is crawled under its own
 * lease, and the finalize hook below alerts admins when a source turns
 * `failing` or the crawl could not store its results. The crawl never sends
 * a document to a model, so it needs no LLM secret, only the email secrets.
 */
export const crawlGuidanceOrchestrator = functions
  // EMAIL_SECRETS: post-run alert emails, see scrapeNewsOrchestrator.
  .runWith({ memory: "512MB", timeoutSeconds: 540, secrets: [...EMAIL_SECRETS] })
  .pubsub.schedule("20 3 * * *") // nightly at 03:20 UTC (issue #143)
  .timeZone("UTC")
  .onRun(async () => {
    console.log("Running guidance crawl orchestrator...");
    try {
      const result = await guidanceCrawlService.runOrchestrator();
      console.log(
        `Guidance crawl: ${result.sourcesConsidered} sources, ${result.sourcesFetched} fetched, ` +
          `${result.changed} changed / ${result.unchanged} unchanged / ${result.failed} failed, ` +
          `${result.infraErrors} infrastructure errors, ${result.notDue} not due`
      );
    } catch (error) {
      console.error("Guidance crawl orchestrator failed:", error);
    }
  });

// ============================================
// SCRAPER ALERTS (issue #83)
// ============================================

/**
 * Post-run alert rules: every visa / news / guidance run, once finalised (#81), is
 * checked for run_failed / error_rate / linked_surcharge / host_backoff /
 * source_broken (scrapers/shared/alerts/scrape-alert.service.ts onRunFinalized). The hook
 * never throws, and the run's record is already written when it runs.
 * Registered at module load, so it is active in every function instance that
 * runs a scraper (CLI scripts do not load index.ts: script runs never alert).
 */
scrapeRunService.registerFinalizeHook((run) => scrapeAlertService.onRunFinalized(run).then(() => undefined));

/**
 * Hourly at :45 UTC: the alert checks no run hook can do — stuck runs, the
 * latest finished run per scraper (runs the stale sweep marked failed fire
 * no hook), missed weekly windows, auto-paused sources, FX refresh failing,
 * the LLM budget (#82) and the ageing review queue — then the daily digest
 * when configured. :45 sits between the visa tick (:15) and news ticks
 * (:00 / :30). Thresholds + recipients: Firestore `appConfig/scrapeAlerts`.
 */
// Explicit budget (review fix): the work is sequential (a query per visa
// source, a transaction per alert, an email per admin), so the 60s default
// is too tight. 256MB is plenty: it holds a few hundred small docs at most.
export const checkScrapeAlerts = functions
  .runWith({ timeoutSeconds: 300, memory: "256MB", secrets: EMAIL_SECRETS })
  .pubsub.schedule("45 * * * *")
  .timeZone("UTC")
  .onRun(async () => {
    const result = await scrapeAlertService.runHourlyCheck();
    const counts: Record<string, number> = {};
    for (const a of result.actions) counts[a.action] = (counts[a.action] ?? 0) + 1;
    console.log(
      `Scrape alert check: ${JSON.stringify(counts)}, emailed ${result.emailed} alert(s) to ${result.recipients} admin(s), ` +
        `digest ${result.digestSent ? "sent" : "not sent"}` +
        (result.skippedRules.length ? `, skipped rules: ${result.skippedRules.join(", ")}` : "")
    );
  });

/**
 * Manual "Run now" (issue #96): the admin API writes a
 * `scrapeRunRequests/{requestId}` doc (POST /admin/scrape-sources/:kind/:id/run
 * or POST /admin/scrapers/:kind/run) and returns at once; this trigger runs
 * the crawl. It calls the normal visa / news orchestrator scoped to one
 * source (or every due source, windows ignored) with trigger "manual", so a
 * manual run gets its own scrapeRuns record and still obeys robots.txt, host
 * backoff, maxExtractionsPerRun and the budget hard stop. Same memory,
 * timeout and secrets as the visa orchestrator (DeepSeek for extraction,
 * email for the post-run alerts). The worker never throws; every outcome is
 * written on the request doc, which the portal polls via
 * GET /admin/scrape-run-requests/:id. Region pinned to us-central1 (the
 * gen1 default, where the API and the scheduled scrapers run).
 */
export const processScrapeRunRequest = functions
  .region("us-central1")
  .runWith({ memory: "512MB", timeoutSeconds: 540, secrets: [...VISA_CATALOG_SECRETS, ...EMAIL_SECRETS] })
  .firestore.document("scrapeRunRequests/{requestId}")
  .onCreate(async (_snapshot, context) => {
    await scrapeRunWorker.process(context.params.requestId);
  });

// ============================================
// PUBLISHED OUTCOME STATISTICS (issue #116)
// ============================================

/**
 * Quarterly import of published decision statistics (one run per registered
 * destination). Governments publish quarterly (the UK Home Office in the
 * second half of Feb / May / Aug / Nov), so this ticks every MONDAY at 05:00
 * UTC but only in those four months: an unchanged release is detected by one
 * cheap page fetch and skipped (same file address / same file hash), so the
 * weekly tick inside a release month is how a late publication is still
 * caught. Heavy: the release file is streamed from disk, never held, but the
 * function gets 2 GB and the full 9 minutes. No secrets needed (public data).
 * Kill switch: appConfig/outcomeStatistics.scheduledImportEnabled.
 */
export const importOutcomeStatistics = functions
  .runWith({ memory: "2GB", timeoutSeconds: 540 })
  .pubsub.schedule("0 5 * 2,5,8,11 1")
  .timeZone("UTC")
  .onRun(async () => {
    for (const destination of registeredDestinations()) {
      try {
        const outcome = await outcomeImportService.run(destination, "scheduled");
        console.log(
          `Outcome statistics import (${destination}): ` +
            (outcome ? `${outcome.result}${outcome.error ? ` (${outcome.error})` : ""}` : "disabled by settings")
        );
      } catch (error) {
        console.error(`Outcome statistics import (${destination}) failed:`, error);
      }
    }
  });

/**
 * Refresh the exchange rate used to charge in a local currency (issue #178).
 * Every 6 hours: the CBN publishes once per working day, so most ticks just
 * re-confirm the same rate (which is what keeps it "fresh"); a provider
 * outage leaves the stored rate serving until the freshness limit in
 * appConfig/currencies, then pricing reports unavailable. Failures are logged
 * and recorded on the rate doc, never thrown. Secrets: FX_RATE_SECRETS is
 * empty until an OANDA key exists (see money/index.ts).
 */
export const refreshExchangeRates = functions
  .runWith({ timeoutSeconds: 120, memory: "256MB", secrets: FX_RATE_SECRETS })
  .pubsub.schedule("15 */6 * * *")
  .timeZone("UTC")
  .onRun(async () => {
    const outcomes = await rateService.refreshAll();
    // refreshAll isolates each currency; failures are logged at error level.
    for (const o of outcomes) {
      if (o.ok) console.log(`Exchange rate refresh ${o.currency}: ${o.source} ${o.rate}`);
      else console.error(`Exchange rate refresh ${o.currency}: unavailable (${o.reason})`);
    }
  });

/**
 * Manual "Run now" for outcome statistics: the admin API
 * (POST /admin/outcome-statistics/runs) writes an `outcomeStatisticsRunRequests`
 * doc and returns 202; this trigger runs the import with the same 2 GB budget
 * as the scheduled one. The worker never throws; the outcome is written on
 * the request doc and as an `outcomeStatisticsRuns` record. Region pinned like
 * processScrapeRunRequest.
 */
export const processOutcomeStatisticsRunRequest = functions
  .region("us-central1")
  .runWith({ memory: "2GB", timeoutSeconds: 540 })
  .firestore.document("outcomeStatisticsRunRequests/{requestId}")
  .onCreate(async (_snapshot, context) => {
    await outcomeRunWorker.process(context.params.requestId);
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

// ============================================
// AI CASE-OFFICER WORKER (issue #42)
// ============================================
//
// Runs an assessment job. It returns at once unless the write moved the document
// INTO `queued` (created queued, or failed -> queued). runJob then claims the
// document `queued -> running` in a transaction, so a duplicate delivery of the
// same event never runs twice. Function-level retry stays off: a failed job is
// retried by a new request, which moves the same document back to queued.
//
// Binds AI_SECRETS: this is the function that calls the model. Timeout and
// memory follow the crawler's pattern (540 s, the Gen-1 maximum). The memory is
// for holding one attached document at a time.
export const processAssessmentJob = functions
  // EMAIL_SECRETS too (#266): the self-service readiness notice sends an email.
  .runWith({ secrets: [...AI_SECRETS, ...EMAIL_SECRETS], timeoutSeconds: 540, memory: "1GB" })
  .firestore.document("applicationAssessments/{assessmentId}")
  .onWrite(async (change, context) => {
    if (!change.after.exists) return;
    const after = change.after.data() ?? {};
    const before = change.before.exists ? change.before.data() ?? {} : {};
    if (after.status !== "queued" || before.status === "queued") return;
    // Bulk re-assessment jobs (#37) belong to the Batch API sweep, never to this worker.
    if (after.viaBatch === true) return;
    const result = await aiCaseOfficerService.runJob(context.params.assessmentId);
    // Issue #117: after a successful AUTO-run, tell the assigned agent once if the
    // findings changed. No-op for manual runs, failures, and an identical finding set.
    if (result === "succeeded") {
      await assessmentAutoRunService.notifyIfNew(context.params.assessmentId);
      // #266: a self-service applicant hears that their readiness review is ready.
      // Never throws; a no-op for agent cases, failures and an unchanged result.
      await assessmentAutoRunService.notifyApplicantIfReady(context.params.assessmentId);
    }
  });

// ============================================
// AGENT PRE-REVIEW AUTO-RUN (issue #117)
// ============================================
//
// Neither function below calls the model, so neither binds AI_SECRETS. They only
// write the `queued` assessment document; the worker above (which holds the
// secret) does the work, and it only ever sees entitled, gated applications.

/**
 * A document was added to, or replaced on, an application: record (or push out)
 * the debounce marker. Fires for creates and for a changed `storageUrl` only.
 */
export const recordAssessmentDebounce = functions
  .firestore.document("documents/{documentId}")
  .onWrite(async (change) => {
    if (!change.after.exists) return; // a delete never starts a run
    const after = change.after.data() ?? {};
    const before = change.before.exists ? change.before.data() ?? {} : null;
    if (before && before.storageUrl === after.storageUrl) return; // not a new or replaced file
    await assessmentAutoRunService.recordDocumentChange(after.applicationId);
  });

/**
 * Every 5 minutes: start ONE assessment per application whose quiet period has
 * passed (entitled, agent-assigned, open cases only), and re-queue a transient
 * auto-run failure once.
 */
export const sweepAssessmentDebounce = functions
  .runWith({ timeoutSeconds: 300, memory: "256MB" })
  .pubsub.schedule("*/5 * * * *")
  .timeZone("UTC")
  .onRun(async () => {
    const r = await assessmentAutoRunService.sweep();
    console.log(`Assessment auto-run sweep: ${r.due} due, ${r.requested} requested, ${r.skipped} skipped, ${r.retried} retried`);
  });

// ============================================
// BULK RE-ASSESSMENT AFTER A RUBRIC APPROVAL (issue #37)
// ============================================

/**
 * Fires on the durable audit document #125 writes in the SAME transaction as a
 * rubric approval (`rubricReviewHistory`, action "approve"), and enqueues the
 * bulk re-assessment of the route's open applications. Triggering from the
 * document, not from an in-memory listener, means a crash or a cold start after
 * the approval commits cannot lose the event; a re-delivered event is harmless
 * (the run id is the audit id). No model call happens here: it only writes jobs.
 * Memory and timeout follow the crawler pattern (512 MB, 540 s); the enqueue
 * scan is resumable, so a very large route is finished by the sweep below.
 */
export const onRubricApproved = functions
  .runWith({ memory: "512MB", timeoutSeconds: 540 })
  .firestore.document("rubricReviewHistory/{auditId}")
  .onCreate(async (snap, context) => {
    try {
      const outcome = await bulkReassessmentService.startRun(context.params.auditId, snap.data() as RubricReviewAuditEntry);
      console.log(`[bulk-reassess] approval ${context.params.auditId}: ${outcome}`);
    } catch (error) {
      // Logged, not rethrown: function retry is off, and the sweep resumes any
      // run whose document was created before the failure.
      console.error("Bulk re-assessment enqueue failed:", error);
    }
  });

/**
 * Issue #123: record a rule-change event when an admin approves a rubric
 * version. Fires on the SAME durable audit document as `onRubricApproved`
 * (separate function, so neither can hold up or break the other). It only ever
 * sees an approval: a raw crawl diff or an unapproved extraction writes no
 * audit document. Makes no model call. The event id is derived from the route
 * and version, so a re-delivered trigger records nothing twice. The alerts
 * themselves go out from `processRuleChangeAlerts` below.
 */
export const onRubricApprovedRecordAlert = functions
  .runWith({ memory: "256MB", timeoutSeconds: 120 })
  .firestore.document("rubricReviewHistory/{auditId}")
  .onCreate(async (snap, context) => {
    try {
      const outcome = await ruleChangeAlertsService.recordRubricApproval(context.params.auditId, snap.data() as RubricReviewAuditEntry);
      console.log(`[rule-change] approval ${context.params.auditId}: ${outcome}`);
    } catch (error) {
      // Logged, not rethrown: function retry is off.
      console.error("Recording the rule-change event failed:", error);
    }
  });

/**
 * Issue #123: when a guidance source's snapshot hash changes (the crawl moved
 * `latestSnapshotId`, which IS the content hash), re-extract every route that
 * uses the source. #40's own hash gate means an unchanged source set costs
 * nothing; the result is only ever STAGED `pending_review` (never approved),
 * and its spend caps apply: a capped run is skipped and leaves the previous
 * approved rubric serving. Nobody is alerted here: an alert needs an admin's
 * approval of the staged version. Binds AI_SECRETS (the extraction reads it).
 */
export const onGuidanceSourceChanged = functions
  .runWith({ memory: "1GB", timeoutSeconds: 540, secrets: [...AI_SECRETS] })
  .firestore.document("guidanceSources/{sourceId}")
  .onUpdate(async (change, context) => {
    const before = (change.before.data() as { latestSnapshotId?: string | null }).latestSnapshotId ?? null;
    const after = (change.after.data() as { latestSnapshotId?: string | null }).latestSnapshotId ?? null;
    // Only a moved hash is a change; every other source write (fetch stamps,
    // health, pauses) leaves it alone.
    if (!after || after === before) return;
    try {
      const results = await rubricExtractionService.onGuidanceChanged({ sourceId: context.params.sourceId });
      console.log(`[rule-change] source ${context.params.sourceId} changed: ${results.map((r) => r.outcome).join(",") || "no route uses it"}`);
    } catch (error) {
      console.error("Re-extraction after a guidance change failed:", error);
    }
  });

/**
 * Issue #216: the WORKER of the rulebook drafting job. Fires when a job
 * document is created or its `kick` counter changes (the job bumps `kick` to
 * hand over to the next invocation, and an admin start or the sweep bumps it to
 * wake a worker); every other write to the job (a step finishing, the lease
 * moving) is ignored, so a worker does not wake itself on its own progress.
 * Each invocation takes a lease on the job and runs as many saved steps as fit
 * in its time budget (under the 540 s cut-off), then hands over. A duplicate or
 * late delivery finds a live lease or nothing left to do and returns. Binds
 * AI_SECRETS: this is the function that makes the model calls of a draft. It
 * never throws: a failure is recorded on the job.
 */
export const processRubricExtractionJob = functions
  .runWith({ secrets: [...AI_SECRETS], timeoutSeconds: 540, memory: "1GB" })
  .firestore.document("rubricExtractionJobs/{jobId}")
  .onWrite(async (change, context) => {
    const after = change.after.exists ? (change.after.data() as { status?: string; kick?: number }) : null;
    if (!after || (after.status !== "queued" && after.status !== "running")) return;
    const before = change.before.exists ? (change.before.data() as { kick?: number }) : null;
    // Only a new job or a changed `kick` is a request for work.
    if (before && before.kick === after.kick) return;
    try {
      const outcome = await rubricExtractionJobService.advance(context.params.jobId);
      console.log(`[rubric-job] ${context.params.jobId}: ${outcome.kind}`);
    } catch (error) {
      console.error("Rubric drafting worker failed:", error);
    }
  });

/**
 * Issue #216: every 5 minutes, wake the drafting jobs that stalled: an active
 * job with no live lease and no recent progress (its worker died, was
 * redeployed or timed out, or the trigger was lost) gets its `kick` bumped,
 * which fires `processRubricExtractionJob`. This function calls no model and
 * takes no lease, so it binds no secret.
 */
export const sweepRubricExtractionJobs = functions
  .runWith({ timeoutSeconds: 120, memory: "256MB" })
  .pubsub.schedule("*/5 * * * *")
  .timeZone("UTC")
  .onRun(async () => {
    const result = await rubricExtractionJobService.sweep();
    if (result.considered > 0) console.log(`[rubric-job] sweep: ${JSON.stringify(result)}`);
  });

/**
 * Issue #217: the WORKER of a route onboarding run. Fires when a run document
 * is created or its `kick` counter changes (each action bumps `kick` to hand
 * over to the next one; the sweep and the two wake-up triggers below bump it to
 * wake a run). Takes a lease, runs ONE action (a crawl, the dry plan, the start
 * of the drafting job, or a read of the safeguards' outcome) and hands over, so
 * a run survives the 540 s limit and crashes. A duplicate or late delivery finds
 * a live lease or nothing to do. Binds the visa crawl's DeepSeek key (the visa
 * page read; no Claude call happens here) and the email secrets (alerts). Never
 * throws: a failure is recorded on the run.
 */
export const processRouteOnboardingRun = functions
  .runWith({ secrets: [...VISA_CATALOG_SECRETS, ...EMAIL_SECRETS], timeoutSeconds: 540, memory: "1GB" })
  .firestore.document("routeOnboardingRuns/{runId}")
  .onWrite(async (change, context) => {
    const after = change.after.exists ? (change.after.data() as { status?: string; kick?: number }) : null;
    if (!after || !["preparing", "running", "waiting_for_publish"].includes(after.status ?? "")) return;
    const before = change.before.exists ? (change.before.data() as { kick?: number }) : null;
    // Only a new run or a changed `kick` is a request for work.
    if (before && before.kick === after.kick) return;
    try {
      const outcome = await routeOnboardingService.advance(context.params.runId);
      console.log(`[route-onboarding] ${context.params.runId}: ${outcome.kind}`);
    } catch (error) {
      console.error("Route onboarding worker failed:", error);
    }
  });

/**
 * Issue #217: every 5 minutes, wake the onboarding runs that stalled (no live
 * lease, nothing recent, any wait time passed), raise the alerts of runs that
 * ended failed or held, and let a held run whose automatic retry is pending
 * become published. Calls no model; binds the email secrets for the alerts.
 */
export const sweepRouteOnboardingRuns = functions
  .runWith({ secrets: EMAIL_SECRETS, timeoutSeconds: 120, memory: "256MB" })
  .pubsub.schedule("*/5 * * * *")
  .timeZone("UTC")
  .onRun(async () => {
    const result = await routeOnboardingService.sweep();
    if (result.considered > 0 || result.alertsRaised > 0 || result.heldChecked > 0) console.log(`[route-onboarding] sweep: ${JSON.stringify(result)}`);
  });

/**
 * Issue #217: a drafting job reached a FINAL status: wake its route's onboarding
 * run so it moves on at once instead of at the next poll. Fires on every write
 * of the job but acts only when the status changed to a final one (a handful of
 * times per job). Calls nothing but the wake-up.
 */
export const onRubricJobFinishedWakeOnboarding = functions
  .runWith({ memory: "256MB", timeoutSeconds: 60 })
  .firestore.document("rubricExtractionJobs/{jobId}")
  .onWrite(async (change) => {
    if (!change.after.exists) return;
    const after = change.after.data() as { status?: string; routeKey?: string };
    const before = change.before.exists ? (change.before.data() as { status?: string }) : null;
    if (!after.routeKey || after.status === "queued" || after.status === "running" || before?.status === after.status) return;
    await routeOnboardingService.wakeRoute(after.routeKey);
  });

/**
 * Issue #217: the publishing pipeline wrote or changed a version's run record
 * (published, held, skipped): wake the route's onboarding run (or re-read a held
 * one whose retry the hourly sweep may just have cleared).
 */
export const onRubricPublishRunWakeOnboarding = functions
  .runWith({ memory: "256MB", timeoutSeconds: 60 })
  .firestore.document("rubricPublishRuns/{runId}")
  .onWrite(async (change) => {
    if (!change.after.exists) return;
    const routeKey = (change.after.data() as { routeKey?: string }).routeKey;
    if (routeKey) await routeOnboardingService.wakeRoute(routeKey);
  });

/**
 * Issue #201: automatic rubric publishing. Fires when a rulebook version is
 * CREATED (`visaRubrics/{routeKey}/rubricVersions/{version}`): both a manual
 * first extraction and the automatic re-draft after a guidance change write a
 * `pending_review` version with an `extractionRunId`. In `auto` mode (see
 * `appConfig/rubricPublishSettings`) the draft goes through the automatic code
 * gates and, when every one passes, is published by the system actor through
 * the SAME approval transaction a human approval uses; otherwise it is HELD and
 * admins are alerted. In `manual` mode (or with no settings) it does nothing.
 *
 * A SEPARATE function from `onGuidanceSourceChanged`: extraction's 540 s budget
 * is not shared with the independent check (part B), and it has its own
 * timeout. Binds AI_SECRETS (the check calls a model) and EMAIL_SECRETS (the
 * alerts email admins). Idempotent per version (`rubricPublishRuns/{id}`), and
 * it never throws: a failure is recorded as a hold and alerted, so a retry can
 * never publish twice.
 */
export const onRubricVersionCreated = functions
  .runWith({ memory: "1GB", timeoutSeconds: 540, secrets: [...AI_SECRETS, ...EMAIL_SECRETS] })
  .firestore.document("visaRubrics/{routeKey}/rubricVersions/{version}")
  .onCreate(async (snap, context) => {
    const data = snap.data() as { reviewStatus?: string; extractionRunId?: string } | undefined;
    // Only a fresh draft written by an extraction run is a candidate.
    if (data?.reviewStatus !== "pending_review" || !data.extractionRunId) return;
    const version = Number(context.params.version);
    if (!Number.isInteger(version) || version < 1) return;
    const report = await rubricAutoPublishService.onVersionCreated(context.params.routeKey, version);
    if (report) console.log(`[rubric-auto-publish] ${report.runId}: ${report.outcome}${report.reasonCodes.length ? ` (${report.reasonCodes.join(", ")})` : ""}`);
  });

/**
 * Issue #202: every hour, retry the held drafts whose only reasons can clear on
 * their own (the independent check was unavailable, over a daily cap, or got an
 * unreadable answer), at most 3 runs per version, only in `auto` mode. The same
 * pipeline and the same shared approval transaction as the trigger; a retry
 * reuses the check's stored batches. Binds AI_SECRETS and EMAIL_SECRETS like
 * the trigger. Never throws.
 */
export const sweepHeldRubricDrafts = functions
  .runWith({ memory: "1GB", timeoutSeconds: 540, secrets: [...AI_SECRETS, ...EMAIL_SECRETS] })
  .pubsub.schedule("17 * * * *")
  .timeZone("UTC")
  .onRun(async () => {
    const result = await rubricAutoPublishService.sweepRetryable();
    if (result.considered > 0) console.log(`[rubric-auto-publish] sweep: ${JSON.stringify(result)}`);
  });

/**
 * Issue #201: when a rubric version is decided (approved or rejected, by an
 * admin or by the automatic publisher), resolve the "draft held" alerts that
 * decision settles: an approval settles every held draft of the route, a
 * rejection settles that version's. A separate function on the same audit
 * document as the two triggers above, so none of them is touched. Writes only
 * alert state; never throws.
 */
export const onRubricDecisionResolveHeldAlerts = functions
  .runWith({ memory: "256MB", timeoutSeconds: 120 })
  .firestore.document("rubricReviewHistory/{auditId}")
  .onCreate(async (snap) => {
    const entry = snap.data() as RubricReviewAuditEntry;
    await rubricAutoPublishService.afterDecision(entry);
  });

/**
 * Issue #123: every 15 minutes, send the alerts of recorded rule-change events
 * (admin-approved rubric versions and visa-record edits): a notification per
 * affected in-flight application to the case's agent / owner, and the neutral,
 * factual notices an applicant may be sent. Idempotent per event and
 * application. Binds EMAIL_SECRETS (the notifications email). No model call.
 */
export const processRuleChangeAlerts = functions
  .runWith({ memory: "512MB", timeoutSeconds: 540, secrets: [...EMAIL_SECRETS] })
  .pubsub.schedule("*/15 * * * *")
  .timeZone("UTC")
  .onRun(async () => {
    try {
      const result = await ruleChangeAlertsService.runSweep();
      if (result.eventsSeen > 0) console.log(`Rule-change alert sweep: ${JSON.stringify(result)}`);
    } catch (error) {
      console.error("Rule-change alert sweep failed:", error);
    }
  });

/**
 * Every 15 minutes: advance bulk re-assessments. Polls the provider's batches
 * and writes their results, plans waiting jobs into new batches (within the
 * daily cap; the remainder waits for the next day), and closes finished runs.
 * Binds AI_SECRETS (it submits and reads batches) and EMAIL_SECRETS (a worse
 * result notifies the reviewing agent). Memory and timeout follow
 * `crawlVisaCatalogOrchestrator`; the sweep keeps its own time budget under 540 s.
 */
export const processBulkReassessments = functions
  .runWith({ memory: "1GB", timeoutSeconds: 540, secrets: [...AI_SECRETS, ...EMAIL_SECRETS] })
  .pubsub.schedule("*/15 * * * *")
  .timeZone("UTC")
  .onRun(async () => {
    try {
      const result = await bulkReassessmentService.runSweep();
      if (result.skipped) console.log(`Bulk re-assessment sweep skipped: ${result.skipped}`);
    } catch (error) {
      console.error("Bulk re-assessment sweep failed:", error);
    }
  });

// ============================================
// PER-UPLOAD DOCUMENT CHECK WORKER (issue #115)
// ============================================
//
// Runs a document check job. POST /documents only WRITES the queued record (and
// only for a paid applicant), so the upload response never waits on this. The
// worker returns at once unless the write moved the record INTO `queued`
// (created queued, or a retry), then claims `queued -> running` in a
// transaction so a duplicate delivery never runs twice. Function-level retry
// stays off: a retry is a new request. Binds AI_SECRETS because it calls the
// model. 120 s covers the job's own 90 s limit, after which the job stores
// `could_not_check` instead of being killed mid-write.
export const processDocumentCheck = functions
  .runWith({ secrets: [...AI_SECRETS], timeoutSeconds: 120, memory: "512MB" })
  .firestore.document("documentChecks/{documentId}")
  .onWrite(async (change, context) => {
    if (!change.after.exists) return;
    const after = change.after.data() ?? {};
    const before = change.before.exists ? change.before.data() ?? {} : {};
    if (after.status !== "queued" || before.status === "queued") return;
    await documentCheckService.runJob(context.params.documentId);
    // #266: tell a self-service applicant how the check ended. Never throws, and
    // does nothing unless the job reached a final status. No email, so no new secret.
    await documentCheckService.notifyApplicant(context.params.documentId);
  });

// ============================================
// REFUSAL-LETTER WORKER (issue #122)
// ============================================
//
// Same shape as processAssessmentJob: returns at once unless the write moved the
// document INTO `queued`; runJob claims `queued -> running` in a transaction so a
// duplicate delivery never runs twice. Binds AI_SECRETS (it calls the model).
export const processRefusalAnalysisJob = functions
  .runWith({ secrets: [...AI_SECRETS], timeoutSeconds: 300, memory: "1GB" })
  .firestore.document("refusalAnalyses/{analysisId}")
  .onWrite(async (change, context) => {
    if (!change.after.exists) return;
    const after = change.after.data() ?? {};
    const before = change.before.exists ? change.before.data() ?? {} : {};
    if (after.status !== "queued" || before.status === "queued") return;
    await refusalLetterService.runJob(context.params.analysisId);
  });
