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
  // Visa-catalog scraper (see docs/visa-catalog-scraping-spike.md):
  // - visaSources: per-country registry of official visa URLs the crawler reads.
  //   Scraped visas are written into countries/{code}/visaTypes as
  //   reviewStatus="pending_review" / source="scraped" and reviewed via the
  //   existing admin visa-review flow (no separate queue).
  visaSources: db.collection("visaSources"),
} as const;

// Helper to get subcollection references
export const subcollections = {
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
  
  // Documents under applications
  documents: (applicationId: string) =>
    collections.applications.doc(applicationId).collection("documents"),
  
  // Timeline under applications
  timeline: (applicationId: string) =>
    collections.applications.doc(applicationId).collection("timeline"),
  
  // Reviews under agents
  reviews: (agentId: string) =>
    collections.agents.doc(agentId).collection("reviews"),
  
  // Notes under applications
  notes: (applicationId: string) =>
    collections.applications.doc(applicationId).collection("notes"),

  // Messages under conversations
  messages: (conversationId: string) =>
    collections.conversations.doc(conversationId).collection("messages"),

  // Scrape runs under news sources
  scrapeRuns: (sourceId: string) =>
    collections.newsSources.doc(sourceId).collection("scrapeRuns"),

  // Immutable content snapshots under a document instance (version history).
  documentVersions: (instanceId: string) =>
    collections.documentInstances.doc(instanceId).collection("versions"),
} as const;

// Firestore timestamp helpers
export const serverTimestamp = FieldValue.serverTimestamp;
export const increment = FieldValue.increment;
export const arrayUnion = FieldValue.arrayUnion;
export const arrayRemove = FieldValue.arrayRemove;

export { admin };
