import * as admin from "firebase-admin";
import { FieldValue } from "firebase-admin/firestore";

// Initialize Firebase Admin SDK
// When deployed to Cloud Functions, credentials are auto-detected.
//
// We pass `storageBucket` explicitly because StorageService resolves the default
// bucket via `getStorage().bucket()` (no hardcoded name). Two things we must NOT
// rely on for the bucket id:
//   1. The auto-detected `FIREBASE_CONFIG.storageBucket` — it resolves to the
//      legacy `<project>.appspot.com` form, but this project's real bucket uses
//      the post-Oct-2024 convention `<project>.firebasestorage.app`.
//   2. A hardcoded project name — a hardcoded `japa-platform.firebasestorage.app`
//      fallback meant the DEV backend (durin-seli-dev) minted signed upload URLs
//      pointing at the PROD bucket, so uploads failed (CORS / cross-project auth)
//      and any that slipped through would have written dev data into prod storage.
//
// Instead we derive the bucket from THIS runtime's project id — exactly what the
// seed/grant scripts do (`${projectId}.firebasestorage.app`). The Cloud Functions
// runtime always exposes the active project via GCLOUD_PROJECT / GOOGLE_CLOUD_PROJECT
// (and, as a last resort, FIREBASE_CONFIG.projectId). This is correct in every
// environment with zero per-project config.
//
// Still overridable via `FIREBASE_STORAGE_BUCKET` (e.g. a staging-only bucket).
function resolveStorageBucket(): string {
  // Explicit override always wins.
  if (process.env.FIREBASE_STORAGE_BUCKET) {
    return process.env.FIREBASE_STORAGE_BUCKET;
  }

  // Active project id, from the standard runtime env vars first.
  let projectId =
    process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || "";

  // Fall back to FIREBASE_CONFIG.projectId (set by the Functions runtime/emulator).
  if (!projectId && process.env.FIREBASE_CONFIG) {
    try {
      projectId = JSON.parse(process.env.FIREBASE_CONFIG).projectId || "";
    } catch {
      // Malformed FIREBASE_CONFIG — leave projectId empty and fail loudly below.
    }
  }

  if (!projectId) {
    throw new Error(
      "Cannot resolve storage bucket: no project id in GCLOUD_PROJECT / " +
        "GOOGLE_CLOUD_PROJECT / FIREBASE_CONFIG, and FIREBASE_STORAGE_BUCKET is unset."
    );
  }

  return `${projectId}.firebasestorage.app`;
}

if (!admin.apps.length) {
  admin.initializeApp({
    storageBucket: resolveStorageBucket(),
  });
}

export const db = admin.firestore();

// Ignore undefined properties when writing to Firestore
db.settings({ ignoreUndefinedProperties: true });
export const auth = admin.auth();
export const storage = admin.storage();
export const messaging: admin.messaging.Messaging = admin.messaging();

// Firestore collection references
export const collections = {
  users: db.collection("users"),
  agents: db.collection("agents"),
  agencies: db.collection("agencies"),
  countries: db.collection("countries"),
  applications: db.collection("applications"),
  // CANONICAL home of uploaded application documents (issue #28): the
  // TOP-LEVEL `documents` collection, one doc per uploaded file, linked to its
  // application by the `applicationId` field (and to the client by `userId`).
  // This is the path services/document.service.ts reads and writes, the seeder
  // (data/seed-portal-data.ts) writes, and the per-application document limit
  // counts. There is deliberately NO `applications/{id}/documents`
  // subcollection and no `subcollections.documents()` helper: that second path
  // was the "split-brain" (seeded there, read here, so nothing seeded was ever
  // visible). Do not reintroduce it. Composite indexes for this collection
  // (applicationId + uploadedAt, applicationId + requirementId + uploadedAt)
  // live in firestore.indexes.json. Backend-only: no firestore.rules match ->
  // clients are denied and go through the API, which authorizes via CASL.
  documents: db.collection("documents"),
  transactions: db.collection("transactions"),
  consultations: db.collection("consultations"),
  notifications: db.collection("notifications"),
  // Audit trail of outbound multi-channel deliveries (email/sms/push) attempted by
  // the unified notifier. Email/SMS are currently stubbed, so this collection is the
  // record that a message "would have been" sent; it becomes a real delivery log once
  // SendGrid/Twilio are wired in.
  notificationDeliveries: db.collection("notificationDeliveries"),
  paymentRequests: db.collection("paymentRequests"),
  conversations: db.collection("conversations"),
  agencyInvitations: db.collection("agencyInvitations"),
  bankAccounts: db.collection("bankAccounts"),
  newsArticles: db.collection("newsArticles"),
  newsSources: db.collection("newsSources"),
  newsSubscriptions: db.collection("newsSubscriptions"),
  // RBAC + subscription entitlement layer (@durin-tech/authz):
  // - plans: plan config (features/limits per audience)
  // - subscriptions: one active doc per subscriber entity (agency/agent/client)
  // - entitlements: resolved {features,limits} cache, keyed by subscriberId
  plans: db.collection("plans"),
  subscriptions: db.collection("subscriptions"),
  entitlements: db.collection("entitlements"),
  // Audit log of normalized billing/provider events (Paystack webhooks, verifications)
  billingEvents: db.collection("billingEvents"),
  // Document templates feature:
  // - documentTemplates: the clonable rich-text catalog (global + per-agency)
  // - documentInstances: editable docs cloned from templates (per-agent/agency),
  //   with an immutable `versions` subcollection (see `subcollections` below)
  documentTemplates: db.collection("documentTemplates"),
  documentInstances: db.collection("documentInstances"),
  // Durable "agent asked the client for document X" records. Top-level (rather
  // than a subcollection of applications) so one query by `userId + status`
  // returns a client's outstanding asks across ALL of their applications — the
  // to-do list that powers the client web workspace.
  documentRequests: db.collection("documentRequests"),
  // Visa-catalog scraper (see src/scrapers/visa-catalog/docs/visa-catalog-scraping-spike.md):
  // - visaSources: per-country registry of official visa URLs the crawler reads.
  //   Scraped visas are written into countries/{code}/visaTypes as
  //   reviewStatus="pending_review" / source="scraped" and reviewed via the
  //   existing admin visa-review flow (no separate queue).
  visaSources: db.collection("visaSources"),
  // Caseworker-guidance source registry (issue #39), kept SEPARATE from
  // visaSources on purpose:
  // - visaSources describes WHAT A VISA IS (the public pages the catalog
  //   crawler turns into visa types, fees and requirements);
  // - guidanceSources describes HOW OFFICERS DECIDE (the published rules and
  //   caseworker guidance a rubric is extracted from).
  // One doc per document (web page or PDF), keyed by a generic
  // jurisdiction + route. Written by the seed
  // (scrapers/guidance/data/seed-guidance-sources.ts) and the guidance crawl
  // (scrapers/guidance/guidance-crawl.service.ts); read by admins through
  // GET /admin/guidance-sources. Immutable text snapshots hang off each
  // source (see `subcollections.guidanceSnapshots`).
  // Backend-only: no firestore.rules match -> clients denied.
  guidanceSources: db.collection("guidanceSources"),
  // Source registry safeguards (issue #215). ALL backend-only (no
  // firestore.rules match -> clients denied; pinned by
  // test/emulator/backend-only-collections.emu.ts):
  // - officialDomains/{host}: the allow-list of official websites an admin
  //   confirmed. A portal-added source may only point at a confirmed host.
  // - officialDomainPreviews/{uid}__{host}: the last address check an admin made
  //   for a host; a confirmation must rest on it (server-held evidence).
  // - sourceRegistryAudit/{id}: append-only record of every confirm, revoke,
  //   register, edit and removal (never updated or deleted).
  // - sourceRegistryRateLimits/{uid}__{kind}__{hour}: per-admin hourly counters.
  officialDomains: db.collection("officialDomains"),
  officialDomainPreviews: db.collection("officialDomainPreviews"),
  sourceRegistryAudit: db.collection("sourceRegistryAudit"),
  sourceRegistryRateLimits: db.collection("sourceRegistryRateLimits"),
  // Published outcome statistics (issue #116): decision counts per destination,
  // published category and nationality, imported from a government's own
  // statistics release (src/scrapers/outcome-statistics). One doc per
  // (release, category, nationality) plus an "ALL" nationality doc per category.
  // Read only by the assessment's country-context lookup
  // (services/outcome-statistics); never exposed as a list endpoint.
  // Backend-only: no firestore.rules match -> clients denied.
  outcomeStatistics: db.collection("outcomeStatistics"),
  // Which release is current per destination: `outcomeStatisticsReleases/{destination}`.
  // Flipped last by the import, so a failed import changes nothing. Backend-only.
  outcomeStatisticsReleases: db.collection("outcomeStatisticsReleases"),
  // One record per import attempt (release date, file, hash, period, counts,
  // unmapped names, result), listed by GET /admin/outcome-statistics/runs.
  // Backend-only.
  outcomeStatisticsRuns: db.collection("outcomeStatisticsRuns"),
  // Admin "Run now" requests; a Firestore trigger runs the import in a
  // higher-memory function than the API. Backend-only.
  outcomeStatisticsRunRequests: db.collection("outcomeStatisticsRunRequests"),
  // Backend-only app configuration documents. Today: `appConfig/fx`, the
  // USD exchange rates (Frankfurter / ECB) the visa scraper converts
  // published fees with (issue #59). No firestore.rules match → clients denied.
  appConfig: db.collection("appConfig"),
  // Exchange rates for charging in a local currency (issue #178):
  // `exchangeRates/{CURRENCY}` holds the provider's last rate and an optional
  // admin override; `exchangeRateAudit` is the append-only history of admin
  // changes. Config for both lives in `appConfig/currencies`. Backend-only:
  // no firestore.rules match -> clients denied.
  exchangeRates: db.collection("exchangeRates"),
  exchangeRateAudit: db.collection("exchangeRateAudit"),
  // Proposed field-level edits to already-approved scraped visas (issue #61):
  // the crawl stages one `open` row per visa here instead of touching the
  // live doc, and an admin approves/rejects it via /admin/visa-changes.
  // Backend-only: no firestore.rules match → clients denied.
  pendingVisaChanges: db.collection("pendingVisaChanges"),
  // One record per visa / news scraper run (issue #81): timing, counters,
  // per-source + per-page outcomes, first N errors. Written by
  // scrapers/shared/runs/scrape-run.service.ts, read via /admin/scrape-runs. TTL-deleted
  // 180 days after start (`expireAt`). NOTE: shares its collection ID with the
  // per-source news log `newsSources/{id}/scrapeRuns` — collection-group
  // queries on "scrapeRuns" see both. Backend-only: no firestore.rules match.
  scrapeRuns: db.collection("scrapeRuns"),
  // Scraper alerts (issue #83): one doc per alert incident (rule, severity,
  // subject, firstSeen/lastSeen/count, open|acknowledged|resolved). Written by
  // scrapers/shared/alerts/scrape-alert.service.ts, read via /admin/scrape-alerts.
  // TTL-deleted 180 days after lastSeen / resolvedAt (`expireAt`).
  // Backend-only: no firestore.rules match -> clients denied.
  scrapeAlerts: db.collection("scrapeAlerts"),
  // Dedupe pointers for scrapeAlerts (issue #83): `{sha256(dedupeKey)}` ->
  // the ACTIVE alert's id. Exists only while that alert is open/acknowledged;
  // read in the upsert transaction so one key never gets two active alerts.
  // Backend-only.
  scrapeAlertKeys: db.collection("scrapeAlertKeys"),
  // Monthly scraping cost rollup (issue #82): `scrapeCosts/{YYYY-MM}` sums
  // every finalised run's LLM usage / cost / news API requests by kind,
  // country and model; `scrapeCosts/{month}/runs/{runId}` markers make each
  // run count once. Written by scrapers/shared/cost/scrape-cost.service.ts (finalize
  // hook), read via /admin/scrape-costs and by #83's budget alert.
  // Backend-only: no firestore.rules match.
  scrapeCosts: db.collection("scrapeCosts"),
  // ---- Scraper settings + manual runs (issue #96). All backend-only: no
  // firestore.rules match -> clients denied; admins go through the API. ----
  // Audit trail of admin edits to the scraper settings and per-source
  // controls: one doc per change set (who, when, target, field diff).
  scraperSettingsHistory: db.collection("scraperSettingsHistory"),
  // Manual "Run now" requests: written by the admin API, processed by the
  // onCreate function processScrapeRunRequest. TTL 30 days (`expireAt`).
  scrapeRunRequests: db.collection("scrapeRunRequests"),
  // One lock doc per source / whole scraper (`{kind}__{sourceId|_all}`):
  // the in-flight request + cooldown start, claimed in a transaction.
  scrapeRunLocks: db.collection("scrapeRunLocks"),
  // Per-source crawl leases (`{kind}__{sourceId}`): every crawl of a source
  // (scheduled, manual, whole-scraper) holds it while crawling, so two runs
  // never crawl the same source at once. Expire after 15 min.
  scrapeSourceLeases: db.collection("scrapeSourceLeases"),
  // Pending edits to APPROVED agency visas (issue #100):
  // `visaRevisions/{countryCode}__{visaId}`, one per visa. Kept off the live
  // visa doc so public reads never serve unreviewed agency text. Written by
  // src/agency-visas, reviewed by the admin (#101). Backend-only: no
  // firestore.rules match -> clients denied.
  visaRevisions: db.collection("visaRevisions"),
  // Visa rubrics (issue #40): `visaRubrics/{countryCode}_{visaTypeId}` is the
  // HEAD of one route's rubric (which version is approved, which is newest,
  // which guidance sources it is extracted from). The rubric itself is in the
  // `rubricVersions` subcollection (see subcollections.rubricVersions), so an
  // approved version and a newer pending one can exist together. Written by
  // scrapers/rubric (extraction, always `pending_review`) and by the rubric
  // review API (#125). Backend-only: no firestore.rules match -> clients denied.
  visaRubrics: db.collection("visaRubrics"),
  // One record per rubric extraction run (issue #40): status, token usage,
  // cost (null while the model is unpriced), what was discarded and why.
  // Backend-only: no firestore.rules match.
  rubricExtractionRuns: db.collection("rubricExtractionRuns"),
  // Audit trail of rubric review decisions (issue #125): one doc per approve
  // or reject (who, when, route, version, action, reason, the flags the
  // reviewer acknowledged, the version that was serving before). Written in
  // the SAME transaction as the decision by services/rubric-review.service.ts,
  // so a decision never exists without its record. Append-only.
  // Backend-only: no firestore.rules match -> clients denied.
  rubricReviewHistory: db.collection("rubricReviewHistory"),
  // Automatic rubric publishing (issue #201). BACKEND-ONLY (no firestore.rules
  // match, so clients are denied):
  //  - rubricPublishRuns/{routeKey}__v{version}: one record per version's
  //    automatic publish run (outcome, gates, leave-outs); created once with
  //    `create()`, so a re-delivered trigger cannot run a version twice;
  //  - rubricPublishSettingsHistory/{auto}: who changed
  //    appConfig/rubricPublishSettings, with before and after.
  rubricPublishRuns: db.collection("rubricPublishRuns"),
  rubricPublishSettingsHistory: db.collection("rubricPublishSettingsHistory"),
  // The independent check's record of one version (issue #202):
  // `rubricCheckerRuns/{routeKey}__v{version}`, the same id as the publish run.
  // Holds the closed verdicts (keyed by request hash, so a re-run of the same
  // version reuses them and calls no model), the per-rule verdicts, and the
  // calls and tokens spent. Never holds source text or model prose.
  // Backend-only: no firestore.rules match.
  rubricCheckerRuns: db.collection("rubricCheckerRuns"),
  // The AI case-officer assessment (issue #42): one document per assessment,
  // which is also its job record. The id is derived from the application id and
  // the input hash, so the same inputs address the same document. Backend-only:
  // no firestore.rules match, so clients read it only through /ai routes.
  applicationAssessments: db.collection("applicationAssessments"),
  // Auto-run debounce markers (issue #117): `assessmentDebounce/{applicationId}`,
  // one per application with a recent document change. Backend-only.
  assessmentDebounce: db.collection("assessmentDebounce"),
  // One-per-assessment notification claims (issue #117), id = assessmentId.
  // Created with `create()`, so a duplicate trigger delivery cannot notify twice. Backend-only.
  assessmentNotifications: db.collection("assessmentNotifications"),
  // Eligibility checks (read by the assessment for the score and nationality).
  // The same collection EligibilityService writes; listed here so the AI path
  // reads it through the registry, not a second `db.collection` call.
  eligibilityChecks: db.collection("eligibilityChecks"),
  // Per-day AI spend counters, one document per UTC day (`aiCosts/{YYYY-MM-DD}`).
  // Written in a transaction per assessment; read by the daily cap. Backend-only.
  aiCosts: db.collection("aiCosts"),
  // Bulk re-assessment after a rubric approval (issue #37). One run per approval
  // (id = the approval's audit id), one doc per provider batch, and a cache of
  // stage 2 document extractions. All backend-only (no firestore.rules match).
  bulkReassessments: db.collection("bulkReassessments"),
  assessmentBatches: db.collection("assessmentBatches"),
  documentExtractions: db.collection("documentExtractions"),
  // Rule-change alerts (issue #123): one event per admin-approved change, one
  // notice (the dedupe claim) per event and application. Backend-only.
  ruleChangeEvents: db.collection("ruleChangeEvents"),
  ruleChangeNotices: db.collection("ruleChangeNotices"),
  // Ask-anywhere chat (issue #45). `aiConversations/{id}`: one conversation per
  // (application, user), id = sha256(applicationId:uid), so a caller can only
  // ever address their OWN conversation. Messages hang off it (see
  // `subcollections.aiChatMessages`). Backend-only: no firestore.rules match, so
  // clients read history only through GET /ai/applications/:id/chat.
  aiConversations: db.collection("aiConversations"),
  // Per-user chat usage counters, one doc per user per UTC day
  // (`aiChatUsage/{uid}_{YYYY-MM-DD}`): messages per hour and per day, tokens
  // spent. Read and written by the chat rate / spend caps. Backend-only.
  aiChatUsage: db.collection("aiChatUsage"),
  // Per-upload document checks (issue #115): `documentChecks/{documentId}`, one
  // per uploaded document, which is also its job record (queued -> running ->
  // done | could_not_check). Read only through the /documents/:id/check and
  // /applications/:id/document-checks routes, tier-trimmed. Backend-only: no
  // firestore.rules match, so clients are denied.
  documentChecks: db.collection("documentChecks"),
  // Per-day counters that bound the cost of document checks (issue #115):
  // `documentCheckCaps/{applicationId|userId}__{YYYY-MM-DD}` -> { count }.
  // Backend-only, same as above.
  documentCheckCaps: db.collection("documentCheckCaps"),
  // Refusal-letter analyses (issue #122): one document per letter version, which
  // is also its job record. The id is a hash of the user, document, storage path
  // and updatedAt, so asking twice for the same letter is a no-op. Holds the
  // letter's quoted reasons (personal data). Backend-only: no firestore.rules
  // match, so clients read it only through /ai/refusal-letters.
  refusalAnalyses: db.collection("refusalAnalyses"),
  // Trafficking / scam signals for a human to review (issue #119). One
  // `riskSignals/{signalId}` per finding, plus an append-only
  // `riskSignals/{signalId}/events` audit trail. Raised only by backend code
  // (riskSignalService.raiseRiskSignal, used by #120 / #121), read and decided
  // by admins through /admin/risk-signals. Visible to admins only and never
  // to the subject: backend-only, no firestore.rules match -> clients denied.
  riskSignals: db.collection("riskSignals"),
  // Agency listing screening results (issue #120): `listingScreenings/{countryCode}__{visaId}`
  // (the same key as `visaRevisions`), one per listing: code comparisons against
  // the verified record, the model's validated language flags (with the listing's
  // own quotes) and the ids of the signals raised. Admin-only, through
  // GET /admin/visas and the rerun route. Backend-only: no firestore.rules match,
  // so clients are denied.
  listingScreenings: db.collection("listingScreenings"),
  // AI message access (issue #172). `aiMessageAccess/{userId}`: one per user, holds
  // their express approval (with the exact wording), the account-wide "off" setting
  // and the one-time-notice dismissal. `aiMessageAccessAudit/{id}`: append-only
  // trail of every change (approval, chat switch, account-wide setting). Both are
  // backend-only: no firestore.rules match, so clients are denied and read/write
  // only through the API (the audit trail only through the admin route).
  aiMessageAccess: db.collection("aiMessageAccess"),
  aiMessageAccessAudit: db.collection("aiMessageAccessAudit"),
} as const;

// Collection-group queries (every subcollection with that id, across all
// parents). A function, not a stored query, so a test can swap it for a fake.
export const collectionGroups = {
  // Every `countries/{cc}/visaTypes` subcollection at once. Used by the
  // agency visa endpoints (issue #100) to find an agency's visas without
  // knowing their country (indexes: visaTypes ownerAgencyId + createdAt and
  // ownerAgencyId + id, COLLECTION_GROUP scope).
  visaTypes: () => db.collectionGroup("visaTypes"),
  // Every `visaRubrics/{routeKey}/rubricVersions` subcollection at once
  // (issue #125): the admin review queue lists rubric versions of all routes
  // by review status, newest first (index: rubricVersions reviewStatus +
  // createdAt DESC, COLLECTION_GROUP scope). ADMIN REVIEW ONLY: it returns
  // versions of any status, so it must never back a client-facing route.
  rubricVersions: () => db.collectionGroup("rubricVersions"),
};

// Helper to get subcollection references
export const subcollections = {
  // `applicationAssessments/{assessmentId}/proposedActions/{actionId}` (issue #44).
  // Backend-only: no firestore.rules match, so clients read it via /ai routes.
  proposedActions: (assessmentId: string) =>
    collections.applicationAssessments.doc(assessmentId).collection("proposedActions"),

  // Visa types under countries
  visaTypes: (countryCode: string) => 
    collections.countries.doc(countryCode).collection("visaTypes"),
  
  // Requirements under visa types
  requirements: (countryCode: string, visaTypeId: string) =>
    collections.countries
      .doc(countryCode)
      .collection("visaTypes")
      .doc(visaTypeId)
      .collection("requirements"),
  
  // NOTE: there is intentionally no `documents` helper here. Application
  // documents live in the TOP-LEVEL `collections.documents` (filter by
  // `applicationId`), never under `applications/{id}/documents` (issue #28).

  // Timeline under applications
  timeline: (applicationId: string) =>
    collections.applications.doc(applicationId).collection("timeline"),
  
  // Reviews under agents
  reviews: (agentId: string) =>
    collections.agents.doc(agentId).collection("reviews"),
  
  // Answers to "information" checklist items under applications (issue #187):
  // `applications/{id}/answers/{checklistItemId}` = { text, updatedAt, updatedBy }.
  // Backend-only: firestore.rules deny every client read and write.
  answers: (applicationId: string) =>
    collections.applications.doc(applicationId).collection("answers"),

  // Notes under applications
  notes: (applicationId: string) =>
    collections.applications.doc(applicationId).collection("notes"),

  // Chat turns under an AI conversation (issue #45).
  aiChatMessages: (conversationId: string) =>
    collections.aiConversations.doc(conversationId).collection("messages"),

  // Messages under conversations
  messages: (conversationId: string) =>
    collections.conversations.doc(conversationId).collection("messages"),

  // Scrape runs under news sources
  scrapeRuns: (sourceId: string) =>
    collections.newsSources.doc(sourceId).collection("scrapeRuns"),

  // Immutable content snapshots under a document instance (version history).
  documentVersions: (instanceId: string) =>
    collections.documentInstances.doc(instanceId).collection("versions"),

  // Immutable snapshots of one guidance source (issue #39):
  // `guidanceSources/{sourceId}/snapshots/{contentHash}`. METADATA only; the
  // snapshot's text lives in Cloud Storage (see
  // scrapers/guidance/guidance-snapshot.store.ts). Backend-only, like its
  // parent: no firestore.rules match.
  guidanceSnapshots: (sourceId: string) =>
    collections.guidanceSources.doc(sourceId).collection("snapshots"),

  // Versions of one route's rubric (issue #40):
  // `visaRubrics/{routeKey}/rubricVersions/{version}`. The id is
  // `rubricVersions`, not `versions`, because `documentInstances/{id}/versions`
  // already exists and a collection-group query on `versions` would see both.
  // A version's content is immutable once written. Backend-only, like its parent.
  rubricVersions: (routeKey: string) =>
    collections.visaRubrics.doc(routeKey).collection("rubricVersions"),

  // An agency's per-visa service prices (issue #103), in whole NAIRA:
  // `agencies/{agencyId}/visaPrices/{countryCode}__{visaTypeId}`. Written and
  // read only by src/agency-visa-prices (no firestore.rules match for the
  // subcollection -> clients denied). A function so tests can swap a fake.
  agencyVisaPrices: (agencyId: string) =>
    collections.agencies.doc(agencyId).collection("visaPrices"),
} as const;

// Firestore timestamp helpers
export const serverTimestamp = FieldValue.serverTimestamp;
export const increment = FieldValue.increment;
export const arrayUnion = FieldValue.arrayUnion;
export const arrayRemove = FieldValue.arrayRemove;

export { admin };
