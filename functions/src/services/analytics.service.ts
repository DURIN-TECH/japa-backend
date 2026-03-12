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

import { db, collections, serverTimestamp } from "../utils/firebase";
import { Timestamp } from "firebase-admin/firestore";
import { Application, Transaction } from "../types";

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

  // ============================================
  // EVENT QUERY METHODS
  // Query and aggregate tracked user interactions.
  // ============================================

  /**
   * GET /analytics/event-summary
   *
   * Returns aggregated counts of tracked events, grouped by event name.
   * Useful for understanding which features are most/least used.
   *
   * Supports filtering by:
   *   - date range (from/to)
   *   - source (portal/mobile)
   *   - specific event names
   */
  async getEventSummary(
    from: string,
    to: string,
    source?: string,
    eventNames?: string[]
  ): Promise<EventSummaryItem[]> {
    let query: FirebaseFirestore.Query = db.collection(COLLECTION)
      .where("clientTimestamp", ">=", Timestamp.fromDate(new Date(from)))
      .where("clientTimestamp", "<=", Timestamp.fromDate(new Date(to + "T23:59:59.999Z")));

    if (source) {
      query = query.where("source", "==", source);
    }

    const snapshot = await query.get();

    // Count events by name
    const counts = new Map<string, number>();
    for (const doc of snapshot.docs) {
      const data = doc.data();
      const eventName = data.event as string;

      // If specific events requested, skip others
      if (eventNames && eventNames.length > 0 && !eventNames.includes(eventName)) {
        continue;
      }

      counts.set(eventName, (counts.get(eventName) || 0) + 1);
    }

    // Sort by count descending
    return Array.from(counts.entries())
      .map(([event, count]) => ({ event, count }))
      .sort((a, b) => b.count - a.count);
  }

  /**
   * GET /analytics/active-users
   *
   * Returns unique user and session counts within a date range.
   * Provides daily active users (DAU), weekly active users (WAU),
   * and total unique sessions.
   */
  async getActiveUsers(
    from: string,
    to: string,
    source?: string
  ): Promise<ActiveUsersData> {
    let query: FirebaseFirestore.Query = db.collection(COLLECTION)
      .where("clientTimestamp", ">=", Timestamp.fromDate(new Date(from)))
      .where("clientTimestamp", "<=", Timestamp.fromDate(new Date(to + "T23:59:59.999Z")));

    if (source) {
      query = query.where("source", "==", source);
    }

    const snapshot = await query.get();

    const uniqueUsers = new Set<string>();
    const uniqueSessions = new Set<string>();
    const dailyUsers = new Map<string, Set<string>>();

    for (const doc of snapshot.docs) {
      const data = doc.data();
      if (data.userId) uniqueUsers.add(data.userId);
      if (data.sessionId) uniqueSessions.add(data.sessionId);

      // Group by day for DAU
      if (data.userId && data.clientTimestamp) {
        const day = data.clientTimestamp.toDate().toISOString().split("T")[0];
        if (!dailyUsers.has(day)) dailyUsers.set(day, new Set());
        dailyUsers.get(day)!.add(data.userId);
      }
    }

    // Compute average DAU
    const dauValues = Array.from(dailyUsers.values()).map((s) => s.size);
    const avgDAU = dauValues.length > 0
      ? Math.round(dauValues.reduce((a, b) => a + b, 0) / dauValues.length)
      : 0;

    return {
      totalUniqueUsers: uniqueUsers.size,
      totalSessions: uniqueSessions.size,
      avgDailyActiveUsers: avgDAU,
      dailyBreakdown: Array.from(dailyUsers.entries())
        .map(([date, users]) => ({ date, count: users.size }))
        .sort((a, b) => a.date.localeCompare(b.date)),
    };
  }

  /**
   * GET /analytics/top-pages
   *
   * Returns page view counts grouped by page path.
   * Shows which pages get the most traffic.
   */
  async getTopPages(
    from: string,
    to: string,
    source?: string,
    limit = 20
  ): Promise<PageViewItem[]> {
    let query: FirebaseFirestore.Query = db.collection(COLLECTION)
      .where("event", "==", "page_view")
      .where("clientTimestamp", ">=", Timestamp.fromDate(new Date(from)))
      .where("clientTimestamp", "<=", Timestamp.fromDate(new Date(to + "T23:59:59.999Z")));

    if (source) {
      query = query.where("source", "==", source);
    }

    const snapshot = await query.get();

    const pageCounts = new Map<string, number>();
    for (const doc of snapshot.docs) {
      const page = doc.data().page as string;
      pageCounts.set(page, (pageCounts.get(page) || 0) + 1);
    }

    return Array.from(pageCounts.entries())
      .map(([page, views]) => ({ page, views }))
      .sort((a, b) => b.views - a.views)
      .slice(0, limit);
  }

  // ============================================
  // ANALYTICS QUERY METHODS
  // These compute KPIs, trends, and metrics from
  // application and transaction collections.
  // ============================================

  /**
   * Fetches applications scoped to the user's role.
   * - admin: all applications
   * - owner: applications belonging to the agent's agency
   * - agent: applications assigned to this agent
   *
   * This is the foundation for all analytics queries — role
   * scoping ensures users only see analytics for their data.
   */
  private async getApplicationsForRole(
    role: string,
    userId: string,
    agencyId?: string
  ): Promise<Application[]> {
    let snapshot;

    if (role === "admin") {
      // Admin sees all applications
      snapshot = await collections.applications.get();
    } else if (role === "owner" && agencyId) {
      // Agency owner sees all cases in their agency
      snapshot = await collections.applications
        .where("agencyId", "==", agencyId)
        .get();
    } else {
      // Agent sees only their assigned cases
      snapshot = await collections.applications
        .where("agentId", "==", userId)
        .get();
    }

    return snapshot.docs.map((doc) => doc.data() as Application);
  }

  /**
   * Fetches transactions scoped to the user's role.
   * Same role-based scoping as applications.
   */
  private async getTransactionsForRole(
    role: string,
    userId: string,
    agencyId?: string
  ): Promise<Transaction[]> {
    let snapshot;

    if (role === "admin") {
      snapshot = await collections.transactions.get();
    } else if (role === "owner" && agencyId) {
      // Get all agent IDs in the agency, then query transactions
      const agentSnapshot = await collections.agents
        .where("agencyId", "==", agencyId)
        .get();
      const agentUserIds = agentSnapshot.docs.map((d) => d.data().userId as string);

      if (agentUserIds.length === 0) return [];

      // Firestore 'in' queries support max 30 values
      const chunks: string[][] = [];
      for (let i = 0; i < agentUserIds.length; i += 30) {
        chunks.push(agentUserIds.slice(i, i + 30));
      }

      const results: Transaction[] = [];
      for (const chunk of chunks) {
        const txnSnapshot = await collections.transactions
          .where("agentId", "in", chunk)
          .get();
        results.push(...txnSnapshot.docs.map((d) => d.data() as Transaction));
      }
      return results;
    } else {
      snapshot = await collections.transactions
        .where("agentId", "==", userId)
        .get();
    }

    return snapshot.docs.map((doc) => doc.data() as Transaction);
  }

  /**
   * Helper: filters applications by date range.
   * Compares the Firestore Timestamp `createdAt` against
   * the ISO string date boundaries from the client.
   *
   * The `to` date is adjusted to end-of-day (23:59:59.999)
   * so that items created on the end date are included.
   */
  private filterByDateRange(
    apps: Application[],
    from: string,
    to: string
  ): Application[] {
    const fromMs = new Date(from).getTime();
    // Use end-of-day for the 'to' boundary so the full day is included
    const toMs = new Date(to + "T23:59:59.999Z").getTime();
    return apps.filter((a) => {
      // createdAt is a Firestore Timestamp — use toMillis() to compare
      const ms = a.createdAt?.toMillis?.();
      if (!ms) return false; // Skip if createdAt is missing or not a Timestamp
      return ms >= fromMs && ms <= toMs;
    });
  }

  /**
   * Helper: filters transactions by date range.
   * Same end-of-day adjustment as filterByDateRange.
   */
  private filterTransactionsByDateRange(
    txns: Transaction[],
    from: string,
    to: string
  ): Transaction[] {
    const fromMs = new Date(from).getTime();
    const toMs = new Date(to + "T23:59:59.999Z").getTime();
    return txns.filter((t) => {
      const ms = t.createdAt?.toMillis?.();
      if (!ms) return false;
      return ms >= fromMs && ms <= toMs;
    });
  }

  /**
   * GET /analytics/kpis
   *
   * Computes key performance indicators:
   * - totalCases: number of cases in the date range
   * - totalRevenue: sum of completed transaction amounts
   * - conversionRate: approved / (approved + rejected) as percentage
   * - avgProcessingDays: average days from creation to completion
   *
   * Each KPI includes a "change" value comparing the current period
   * to a previous period of the same length (e.g., last 30d vs prior 30d).
   */
  async getKPIs(
    role: string,
    userId: string,
    agencyId: string | undefined,
    from: string,
    to: string
  ): Promise<AnalyticsKPIs> {
    // Fetch all data for this role (date filtering done in memory)
    const [allApps, allTxns] = await Promise.all([
      this.getApplicationsForRole(role, userId, agencyId),
      this.getTransactionsForRole(role, userId, agencyId),
    ]);

    // Current period
    const currentApps = this.filterByDateRange(allApps, from, to);
    const currentTxns = this.filterTransactionsByDateRange(allTxns, from, to);

    // Previous period (same duration, shifted back)
    const periodMs = new Date(to).getTime() - new Date(from).getTime();
    const prevFrom = new Date(new Date(from).getTime() - periodMs).toISOString();
    const prevTo = from;
    const prevApps = this.filterByDateRange(allApps, prevFrom, prevTo);
    const prevTxns = this.filterTransactionsByDateRange(allTxns, prevFrom, prevTo);

    // --- Total Cases ---
    const totalCases = currentApps.length;
    const prevTotalCases = prevApps.length;
    const totalCasesChange = this.percentChange(prevTotalCases, totalCases);

    // --- Total Revenue (sum of completed transactions, in cents) ---
    const totalRevenue = currentTxns
      .filter((t) => t.status === "completed")
      .reduce((sum, t) => sum + t.amount, 0);
    const prevRevenue = prevTxns
      .filter((t) => t.status === "completed")
      .reduce((sum, t) => sum + t.amount, 0);
    const totalRevenueChange = this.percentChange(prevRevenue, totalRevenue);

    // --- Conversion Rate (approved / decided) ---
    const approved = currentApps.filter((a) => a.status === "approved").length;
    const decided = currentApps.filter((a) =>
      ["approved", "rejected"].includes(a.status)
    ).length;
    const conversionRate = decided > 0 ? (approved / decided) * 100 : 0;

    const prevApproved = prevApps.filter((a) => a.status === "approved").length;
    const prevDecided = prevApps.filter((a) =>
      ["approved", "rejected"].includes(a.status)
    ).length;
    const prevConversionRate = prevDecided > 0 ? (prevApproved / prevDecided) * 100 : 0;
    const conversionRateChange = prevConversionRate > 0
      ? conversionRate - prevConversionRate
      : 0;

    // --- Average Processing Days ---
    const processingDays = this.computeProcessingDays(currentApps);
    const prevProcessingDays = this.computeProcessingDays(prevApps);
    const avgProcessingDaysChange = prevProcessingDays > 0
      ? processingDays - prevProcessingDays
      : 0;

    return {
      totalCases,
      totalCasesChange: Math.round(totalCasesChange * 10) / 10,
      totalRevenue,
      totalRevenueChange: Math.round(totalRevenueChange * 10) / 10,
      conversionRate: Math.round(conversionRate * 10) / 10,
      conversionRateChange: Math.round(conversionRateChange * 10) / 10,
      avgProcessingDays: Math.round(processingDays),
      avgProcessingDaysChange: Math.round(avgProcessingDaysChange),
    };
  }

  /**
   * GET /analytics/case-trends
   *
   * Returns monthly case counts within the date range.
   * Used by the bar chart on the analytics dashboard.
   */
  async getCaseTrends(
    role: string,
    userId: string,
    agencyId: string | undefined,
    from: string,
    to: string
  ): Promise<MonthlyDataPoint[]> {
    const allApps = await this.getApplicationsForRole(role, userId, agencyId);
    const filtered = this.filterByDateRange(allApps, from, to);

    // Group applications by month
    const months = this.monthsBetween(from, to);
    const counts: Record<string, number> = {};

    for (const app of filtered) {
      const d = app.createdAt.toDate();
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
      counts[key] = (counts[key] || 0) + 1;
    }

    return months.map((m) => ({
      month: m.month,
      label: m.label,
      value: counts[m.month] || 0,
    }));
  }

  /**
   * GET /analytics/revenue-trends
   *
   * Returns monthly revenue totals (completed transactions) within the date range.
   * Used by the line chart on the analytics dashboard.
   */
  async getRevenueTrends(
    role: string,
    userId: string,
    agencyId: string | undefined,
    from: string,
    to: string
  ): Promise<MonthlyDataPoint[]> {
    const allTxns = await this.getTransactionsForRole(role, userId, agencyId);
    const filtered = this.filterTransactionsByDateRange(allTxns, from, to)
      .filter((t) => t.status === "completed");

    // Group revenue by month
    const months = this.monthsBetween(from, to);
    const sums: Record<string, number> = {};

    for (const txn of filtered) {
      const d = txn.createdAt.toDate();
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
      sums[key] = (sums[key] || 0) + txn.amount;
    }

    return months.map((m) => ({
      month: m.month,
      label: m.label,
      value: sums[m.month] || 0,
    }));
  }

  /**
   * GET /analytics/agent-metrics
   *
   * Returns per-agent performance stats within the date range.
   * Used by the agent performance table on the analytics dashboard.
   *
   * Metrics per agent:
   * - activeCases: non-terminal cases
   * - completedCases: approved + rejected
   * - successRate: approved / completed as percentage
   * - revenueGenerated: sum of amountPaid on their cases
   * - avgProcessingDays: average days to completion
   */
  async getAgentMetrics(
    role: string,
    userId: string,
    agencyId: string | undefined,
    from: string,
    to: string
  ): Promise<AgentMetric[]> {
    const allApps = await this.getApplicationsForRole(role, userId, agencyId);
    const filtered = this.filterByDateRange(allApps, from, to);

    // Look up agent display names for the result
    const agentIds = new Set(filtered.map((a) => a.agentId).filter(Boolean) as string[]);
    const agentNames = await this.getAgentDisplayNames(Array.from(agentIds));

    // Group by agentId and compute per-agent stats
    const agentMap = new Map<string, {
      active: number;
      completed: number;
      approved: number;
      revenue: number;
      days: number[];
    }>();

    for (const app of filtered) {
      if (!app.agentId) continue;

      if (!agentMap.has(app.agentId)) {
        agentMap.set(app.agentId, { active: 0, completed: 0, approved: 0, revenue: 0, days: [] });
      }
      const agent = agentMap.get(app.agentId)!;

      // Categorize by terminal vs active status
      if (["approved", "rejected"].includes(app.status)) {
        agent.completed++;
        if (app.status === "approved") agent.approved++;
        // Track processing time for completed cases
        if (app.completedAt) {
          const days = (app.completedAt.toMillis() - app.createdAt.toMillis()) / (1000 * 60 * 60 * 24);
          agent.days.push(days);
        }
      } else if (!["draft", "withdrawn", "expired"].includes(app.status)) {
        agent.active++;
      }

      // Revenue from what the client has paid
      agent.revenue += app.amountPaid;
    }

    // Convert to response array
    return Array.from(agentMap.entries()).map(([agentId, data]) => ({
      agentId,
      agentName: agentNames.get(agentId) || agentId,
      activeCases: data.active,
      completedCases: data.completed,
      successRate: data.completed > 0
        ? Math.round((data.approved / data.completed) * 1000) / 10
        : 0,
      revenueGenerated: data.revenue,
      avgProcessingDays: data.days.length > 0
        ? Math.round(data.days.reduce((a, b) => a + b, 0) / data.days.length)
        : 0,
    }));
  }

  /**
   * GET /analytics/status-pipeline
   *
   * Returns case counts grouped by application status.
   * Used by the conversion funnel visualization.
   * Not date-filtered — shows the current snapshot of all cases.
   */
  async getStatusPipeline(
    role: string,
    userId: string,
    agencyId?: string
  ): Promise<StatusPipelineData> {
    const allApps = await this.getApplicationsForRole(role, userId, agencyId);

    // Count applications by status
    const pipeline: StatusPipelineData = {
      draft: 0,
      pending_payment: 0,
      pending_documents: 0,
      under_review: 0,
      submitted_to_embassy: 0,
      interview_scheduled: 0,
      approved: 0,
      rejected: 0,
    };

    for (const app of allApps) {
      if (app.status in pipeline) {
        pipeline[app.status as keyof StatusPipelineData]++;
      }
    }

    return pipeline;
  }

  // ============================================
  // PRIVATE HELPERS
  // ============================================

  /**
   * Computes average processing days for applications that have
   * a completedAt timestamp (approved or rejected).
   */
  private computeProcessingDays(apps: Application[]): number {
    const days = apps
      .filter((a) => a.completedAt)
      .map((a) => {
        return (a.completedAt!.toMillis() - a.createdAt.toMillis()) / (1000 * 60 * 60 * 24);
      });

    if (days.length === 0) return 0;
    return days.reduce((a, b) => a + b, 0) / days.length;
  }

  /**
   * Computes percent change between two values.
   * Returns 0 when the previous value is 0 (avoids division by zero).
   */
  private percentChange(prev: number, current: number): number {
    if (prev === 0) return current > 0 ? 100 : 0;
    return ((current - prev) / prev) * 100;
  }

  /** Short month labels for chart axis */
  private static MONTHS_SHORT = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
  ];

  /**
   * Generates an array of month entries between two dates.
   * Ensures charts have entries for every month, even if count is 0.
   */
  private monthsBetween(from: string, to: string): { month: string; label: string }[] {
    const result: { month: string; label: string }[] = [];
    const start = new Date(from);
    const end = new Date(to);
    const cursor = new Date(start.getFullYear(), start.getMonth(), 1);

    while (cursor <= end) {
      const key = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, "0")}`;
      result.push({ month: key, label: AnalyticsService.MONTHS_SHORT[cursor.getMonth()] });
      cursor.setMonth(cursor.getMonth() + 1);
    }

    return result;
  }

  /**
   * Looks up agent display names from the agents collection.
   * Returns a Map of userId → displayName for efficient lookup.
   */
  private async getAgentDisplayNames(
    agentUserIds: string[]
  ): Promise<Map<string, string>> {
    const nameMap = new Map<string, string>();
    if (agentUserIds.length === 0) return nameMap;

    // Firestore 'in' queries support max 30 values
    const chunks: string[][] = [];
    for (let i = 0; i < agentUserIds.length; i += 30) {
      chunks.push(agentUserIds.slice(i, i + 30));
    }

    for (const chunk of chunks) {
      const snapshot = await collections.agents
        .where("userId", "in", chunk)
        .get();
      for (const doc of snapshot.docs) {
        const data = doc.data();
        nameMap.set(data.userId, data.displayName || data.userId);
      }
    }

    return nameMap;
  }
}

// ============================================
// RESPONSE TYPES
// Mirrors portal's src/types/api.ts analytics types
// ============================================

export interface AnalyticsKPIs {
  totalCases: number;
  totalCasesChange: number;
  totalRevenue: number;
  totalRevenueChange: number;
  conversionRate: number;
  conversionRateChange: number;
  avgProcessingDays: number;
  avgProcessingDaysChange: number;
}

export interface MonthlyDataPoint {
  month: string;
  label: string;
  value: number;
}

export interface AgentMetric {
  agentId: string;
  agentName: string;
  activeCases: number;
  completedCases: number;
  successRate: number;
  revenueGenerated: number;
  avgProcessingDays: number;
}

export interface StatusPipelineData {
  draft: number;
  pending_payment: number;
  pending_documents: number;
  under_review: number;
  submitted_to_embassy: number;
  interview_scheduled: number;
  approved: number;
  rejected: number;
}

export interface EventSummaryItem {
  event: string;
  count: number;
}

export interface ActiveUsersData {
  totalUniqueUsers: number;
  totalSessions: number;
  avgDailyActiveUsers: number;
  dailyBreakdown: { date: string; count: number }[];
}

export interface PageViewItem {
  page: string;
  views: number;
}

/** Singleton instance */
export const analyticsService = new AnalyticsService();
