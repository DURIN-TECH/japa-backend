/**
 * Analytics Service
 *
 * Stores portal/mobile analytics events in Firestore.
 * Events are received as batches from the portal's tracker
 * and written efficiently using batched writes.
 *
 * Collection: "analyticsEvents"
 * Each document represents a single event with:
 *   - event name, properties, timestamp
 *   - sessionId, userId, page (from the client)
 *   - serverTimestamp (when it was received)
 *   - source (portal, mobile, etc.)
 *
 * This data powers the analytics dashboard KPIs and
 * can be exported to BigQuery for deeper analysis.
 */

import { db, serverTimestamp } from "../utils/firebase";
import { Timestamp } from "firebase-admin/firestore";

// ============================================
// TYPES
// ============================================

/** Shape of a single analytics event from the client */
export interface AnalyticsEventInput {
  event: string;
  properties?: Record<string, string | number | boolean>;
  timestamp: string; // ISO 8601 string from client
  sessionId: string;
  userId?: string;
  page: string;
}

/** Shape of an analytics event as stored in Firestore */
interface AnalyticsEventDoc {
  event: string;
  properties: Record<string, string | number | boolean>;
  clientTimestamp: Timestamp;
  serverTimestamp: ReturnType<typeof serverTimestamp>;
  sessionId: string;
  userId: string | null;
  page: string;
  source: string;
}

// ============================================
// CONSTANTS
// ============================================

/** Firestore collection for analytics events */
const COLLECTION = "analyticsEvents";

/**
 * Maximum number of events per batch request.
 * Prevents abuse — the portal sends max 20 per flush,
 * but we add a safety margin.
 */
const MAX_EVENTS_PER_BATCH = 50;

/**
 * Allowed event name pattern.
 * Only lowercase letters, numbers, and underscores.
 * Prevents injection of arbitrary data as event names.
 */
const EVENT_NAME_PATTERN = /^[a-z][a-z0-9_]{1,63}$/;

// ============================================
// SERVICE
// ============================================

class AnalyticsService {
  /**
   * Ingest a batch of analytics events.
   *
   * Validates each event, converts timestamps, and writes
   * them to Firestore in a single batched write for efficiency.
   *
   * @param events - Array of raw events from the client
   * @param source - Client source identifier (e.g. "portal", "mobile")
   * @param authenticatedUserId - The verified userId from the auth token (overrides client-sent userId)
   * @returns Number of events successfully ingested
   */
  async ingestEvents(
    events: AnalyticsEventInput[],
    source: string,
    authenticatedUserId?: string
  ): Promise<number> {
    // Guard: reject oversized batches
    if (!events || events.length === 0) return 0;
    if (events.length > MAX_EVENTS_PER_BATCH) {
      console.warn(
        `Analytics batch too large (${events.length} events), truncating to ${MAX_EVENTS_PER_BATCH}`
      );
      events = events.slice(0, MAX_EVENTS_PER_BATCH);
    }

    // Filter and validate events
    const validEvents = events.filter((e) => this.isValidEvent(e));
    if (validEvents.length === 0) return 0;

    // Use Firestore batched write for atomicity and performance
    const batch = db.batch();
    const collection = db.collection(COLLECTION);

    for (const event of validEvents) {
      const docRef = collection.doc(); // Auto-generated ID
      const doc: AnalyticsEventDoc = {
        event: event.event,
        properties: event.properties || {},
        // Parse the ISO timestamp from the client
        clientTimestamp: Timestamp.fromDate(new Date(event.timestamp)),
        // Server-side timestamp for when we received the event
        serverTimestamp: serverTimestamp(),
        sessionId: event.sessionId,
        // Trust the authenticated userId over any client-sent userId
        userId: authenticatedUserId || event.userId || null,
        page: event.page,
        source,
      };
      batch.set(docRef, doc);
    }

    await batch.commit();

    return validEvents.length;
  }

  /**
   * Validates a single analytics event.
   *
   * Checks:
   * - event name exists and matches allowed pattern
   * - timestamp is a valid ISO string
   * - sessionId is present
   * - page is present
   * - properties values are primitives only (no nested objects)
   */
  private isValidEvent(event: AnalyticsEventInput): boolean {
    // Event name must exist and match pattern
    if (!event.event || !EVENT_NAME_PATTERN.test(event.event)) {
      console.warn(`Invalid analytics event name: "${event.event}"`);
      return false;
    }

    // Timestamp must be a parseable date
    if (!event.timestamp || isNaN(new Date(event.timestamp).getTime())) {
      console.warn(`Invalid analytics timestamp: "${event.timestamp}"`);
      return false;
    }

    // SessionId and page are required
    if (!event.sessionId || !event.page) {
      console.warn("Analytics event missing sessionId or page");
      return false;
    }

    // Properties must be flat (no nested objects/arrays)
    if (event.properties) {
      for (const [key, value] of Object.entries(event.properties)) {
        if (typeof value === "object" && value !== null) {
          console.warn(`Analytics property "${key}" has non-primitive value`);
          return false;
        }
      }
    }

    return true;
  }
}

/** Singleton instance */
export const analyticsService = new AnalyticsService();
