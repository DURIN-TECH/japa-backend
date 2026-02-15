import * as admin from "firebase-admin";
import { FieldValue } from "firebase-admin/firestore";

// Initialize Firebase Admin SDK
// When deployed to Cloud Functions, credentials are auto-detected
if (!admin.apps.length) {
  admin.initializeApp();
}

export const db = admin.firestore();

// Ignore undefined properties when writing to Firestore
db.settings({ ignoreUndefinedProperties: true });
export const auth = admin.auth();
export const storage = admin.storage();
export const messaging = admin.messaging();

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
  conversations: db.collection("conversations"),
  agencyInvitations: db.collection("agencyInvitations"),
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
} as const;

// Firestore timestamp helpers
export const serverTimestamp = FieldValue.serverTimestamp;
export const increment = FieldValue.increment;
export const arrayUnion = FieldValue.arrayUnion;
export const arrayRemove = FieldValue.arrayRemove;

export { admin };
