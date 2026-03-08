/**
 * Analytics Controller
 *
 * Handles incoming analytics event batches from the portal
 * and mobile apps, plus serves aggregated analytics data
 * for the dashboard.
 *
 * Endpoints:
 *   POST /analytics/events          — Ingest a batch of analytics events
 *   GET  /analytics/kpis            — Dashboard KPI cards
 *   GET  /analytics/case-trends     — Monthly case counts (bar chart)
 *   GET  /analytics/revenue-trends  — Monthly revenue totals (line chart)
 *   GET  /analytics/agent-metrics   — Per-agent performance table
 *   GET  /analytics/status-pipeline — Case counts by status (funnel)
 */

import { Response } from "express";
import { AuthenticatedRequest } from "../middleware/auth";
import {
  analyticsService,
  AnalyticsEventInput,
} from "../services/analytics.service";
import { Agent } from "../types";
import { sendSuccess, sendError, ErrorMessages } from "../utils/response";
import { collections } from "../utils/firebase";

export class AnalyticsController {
  // ============================================
  // POST /analytics/events — Event Ingestion
  // ============================================

  /**
   * POST /analytics/events
   *
   * Accepts a batch of analytics events from the portal tracker.
   * The tracker batches events client-side and flushes them every
   * 30 seconds or when the buffer reaches 20 events.
   *
   * Request body:
   * {
   *   events: AnalyticsEventInput[]  — Array of event objects
   * }
   *
   * The authenticated user's ID from the auth token is used
   * as the canonical userId (not the client-sent one), preventing
   * any spoofing of user attribution.
   */
  async ingestEvents(
    req: AuthenticatedRequest,
    res: Response
  ): Promise<void> {
    try {
      const { events } = req.body;

      // Validate that events is an array
      if (!Array.isArray(events)) {
        sendError(
          res,
          "VALIDATION_ERROR",
          "Request body must contain an 'events' array",
          400
        );
        return;
      }

      // Determine the source from the request (portal or mobile)
      const source = (req.headers["x-analytics-source"] as string) || "portal";

      // Ingest events — the service handles validation and batched writes
      const count = await analyticsService.ingestEvents(
        events as AnalyticsEventInput[],
        source,
        req.userId // Authenticated user ID from Firebase token
      );

      // Return the number of events successfully ingested
      sendSuccess(res, { ingested: count });
    } catch (error) {
      console.error("Error ingesting analytics events:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  // ============================================
  // GET /analytics/kpis — Dashboard KPI Cards
  // ============================================

  /**
   * GET /analytics/kpis
   *
   * Returns key performance indicators for the analytics dashboard:
   * - totalCases (with period-over-period change)
   * - totalRevenue (with change)
   * - conversionRate (with change)
   * - avgProcessingDays (with change)
   *
   * Query params:
   *   role: "admin" | "owner" | "agent" — determines data scope
   *   from: ISO date string — start of date range
   *   to:   ISO date string — end of date range
   *
   * The role determines what data the user can see:
   *   - admin: all cases across the platform
   *   - owner: all cases within their agency
   *   - agent: only cases assigned to them
   */
  async getKPIs(
    req: AuthenticatedRequest,
    res: Response
  ): Promise<void> {
    try {
      // Extract and validate query params
      const { role, from, to } = req.query;

      const validationError = this.validateAnalyticsParams(req, role as string);
      if (validationError) {
        sendError(res, "VALIDATION_ERROR", validationError, 400);
        return;
      }

      // Check role-based authorization (admin claim, agency owner, etc.)
      const authResult = await this.authorizeAndResolve(req, role as string);
      if (!authResult.authorized) {
        sendError(res, "FORBIDDEN", authResult.error!, 403);
        return;
      }

      // Fetch KPIs from the analytics service
      const kpis = await analyticsService.getKPIs(
        role as string,
        req.userId!,
        authResult.agencyId,
        (from as string) || this.defaultFrom(),
        (to as string) || this.defaultTo()
      );

      sendSuccess(res, kpis);
    } catch (error) {
      console.error("Error fetching analytics KPIs:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  // ============================================
  // GET /analytics/case-trends — Monthly Bar Chart
  // ============================================

  /**
   * GET /analytics/case-trends
   *
   * Returns monthly case counts for the bar chart visualization.
   * Each data point has { month, label, value }.
   *
   * Query params: same as getKPIs (role, from, to)
   */
  async getCaseTrends(
    req: AuthenticatedRequest,
    res: Response
  ): Promise<void> {
    try {
      const { role, from, to } = req.query;
      const validationError = this.validateAnalyticsParams(req, role as string);
      if (validationError) {
        sendError(res, "VALIDATION_ERROR", validationError, 400);
        return;
      }

      const authResult = await this.authorizeAndResolve(req, role as string);
      if (!authResult.authorized) {
        sendError(res, "FORBIDDEN", authResult.error!, 403);
        return;
      }

      // Fetch monthly case trend data from the service
      const trends = await analyticsService.getCaseTrends(
        role as string,
        req.userId!,
        authResult.agencyId,
        (from as string) || this.defaultFrom(),
        (to as string) || this.defaultTo()
      );

      sendSuccess(res, trends);
    } catch (error) {
      console.error("Error fetching case trends:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  // ============================================
  // GET /analytics/revenue-trends — Monthly Line Chart
  // ============================================

  /**
   * GET /analytics/revenue-trends
   *
   * Returns monthly revenue totals (completed transactions)
   * for the line chart visualization.
   * Each data point has { month, label, value }.
   *
   * Query params: same as getKPIs (role, from, to)
   */
  async getRevenueTrends(
    req: AuthenticatedRequest,
    res: Response
  ): Promise<void> {
    try {
      const { role, from, to } = req.query;
      const validationError = this.validateAnalyticsParams(req, role as string);
      if (validationError) {
        sendError(res, "VALIDATION_ERROR", validationError, 400);
        return;
      }

      const authResult = await this.authorizeAndResolve(req, role as string);
      if (!authResult.authorized) {
        sendError(res, "FORBIDDEN", authResult.error!, 403);
        return;
      }

      // Fetch monthly revenue trend data from the service
      const trends = await analyticsService.getRevenueTrends(
        role as string,
        req.userId!,
        authResult.agencyId,
        (from as string) || this.defaultFrom(),
        (to as string) || this.defaultTo()
      );

      sendSuccess(res, trends);
    } catch (error) {
      console.error("Error fetching revenue trends:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  // ============================================
  // GET /analytics/agent-metrics — Agent Performance Table
  // ============================================

  /**
   * GET /analytics/agent-metrics
   *
   * Returns per-agent performance data for the agent table:
   * - agentName, activeCases, completedCases
   * - successRate, revenueGenerated, avgProcessingDays
   *
   * Only available to admin and owner roles (agents can't
   * see other agents' metrics).
   *
   * Query params: same as getKPIs (role, from, to)
   */
  async getAgentMetrics(
    req: AuthenticatedRequest,
    res: Response
  ): Promise<void> {
    try {
      const { role, from, to } = req.query;
      const validationError = this.validateAnalyticsParams(req, role as string);
      if (validationError) {
        sendError(res, "VALIDATION_ERROR", validationError, 400);
        return;
      }

      // Agent metrics are only meaningful for admin/owner roles —
      // an individual agent can't see other agents' performance
      if (role === "agent") {
        sendError(
          res,
          "FORBIDDEN",
          "Agent metrics require admin or owner role",
          403
        );
        return;
      }

      const authResult = await this.authorizeAndResolve(req, role as string);
      if (!authResult.authorized) {
        sendError(res, "FORBIDDEN", authResult.error!, 403);
        return;
      }

      // Fetch per-agent metrics from the service
      const metrics = await analyticsService.getAgentMetrics(
        role as string,
        req.userId!,
        authResult.agencyId,
        (from as string) || this.defaultFrom(),
        (to as string) || this.defaultTo()
      );

      sendSuccess(res, metrics);
    } catch (error) {
      console.error("Error fetching agent metrics:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  // ============================================
  // GET /analytics/status-pipeline — Conversion Funnel
  // ============================================

  /**
   * GET /analytics/status-pipeline
   *
   * Returns case counts grouped by application status for the
   * conversion funnel visualization. This is a current snapshot —
   * not filtered by date range.
   *
   * Query params:
   *   role: "admin" | "owner" | "agent" — determines data scope
   */
  async getStatusPipeline(
    req: AuthenticatedRequest,
    res: Response
  ): Promise<void> {
    try {
      const { role } = req.query;
      const validationError = this.validateAnalyticsParams(req, role as string);
      if (validationError) {
        sendError(res, "VALIDATION_ERROR", validationError, 400);
        return;
      }

      const authResult = await this.authorizeAndResolve(req, role as string);
      if (!authResult.authorized) {
        sendError(res, "FORBIDDEN", authResult.error!, 403);
        return;
      }

      // Fetch status pipeline — no date range needed (current snapshot)
      const pipeline = await analyticsService.getStatusPipeline(
        role as string,
        req.userId!,
        authResult.agencyId
      );

      sendSuccess(res, pipeline);
    } catch (error) {
      console.error("Error fetching status pipeline:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  // ============================================
  // PRIVATE HELPERS
  // ============================================

  /**
   * Validates common analytics query params.
   * Returns an error message string if invalid, or null if valid.
   */
  private validateAnalyticsParams(
    req: AuthenticatedRequest,
    role: string
  ): string | null {
    // userId must be present (set by verifyAuth middleware)
    if (!req.userId) {
      return "Authentication required";
    }

    // Role must be one of the allowed values
    const allowedRoles = ["admin", "owner", "agent"];
    if (!role || !allowedRoles.includes(role)) {
      return "Query param 'role' is required and must be one of: admin, owner, agent";
    }

    return null;
  }

  /**
   * Authorizes the user for the requested role and resolves
   * the agencyId if the role is "owner".
   *
   * Returns { authorized: true, agencyId? } on success,
   * or { authorized: false, error } on failure.
   *
   * Role checks:
   *   - admin: user must have admin custom claim
   *   - owner: user must be an agent with agencyRole === "owner"
   *   - agent: any authenticated user (their own data)
   */
  private async authorizeAndResolve(
    req: AuthenticatedRequest,
    role: string
  ): Promise<{ authorized: boolean; agencyId?: string; error?: string }> {
    if (role === "admin") {
      // Admin role requires the admin custom claim on the Firebase token
      if (!req.user?.admin) {
        return { authorized: false, error: "Admin access required" };
      }
      return { authorized: true };
    }

    if (role === "owner") {
      // Owner role requires the user to be an agent with owner agencyRole
      const agent = await this.getAgentForUser(req.userId!);
      if (!agent?.agencyId || agent.agencyRole !== "owner") {
        return { authorized: false, error: "Agency owner access required" };
      }
      // Return the agencyId so the service can scope data to this agency
      return { authorized: true, agencyId: agent.agencyId };
    }

    // Agent role: any authenticated user can see their own data
    return { authorized: true };
  }

  /**
   * Looks up the Agent document for a given userId.
   * Used to resolve agencyId and agencyRole for owner authorization.
   */
  private async getAgentForUser(userId: string): Promise<Agent | null> {
    const snapshot = await collections.agents
      .where("userId", "==", userId)
      .limit(1)
      .get();

    if (snapshot.empty) return null;
    return snapshot.docs[0].data() as Agent;
  }

  /**
   * Default "from" date: 6 months ago.
   * Used when the client doesn't provide a date range.
   */
  private defaultFrom(): string {
    const d = new Date();
    d.setMonth(d.getMonth() - 6);
    return d.toISOString().split("T")[0];
  }

  /**
   * Default "to" date: today.
   * Used when the client doesn't provide a date range.
   */
  private defaultTo(): string {
    return new Date().toISOString().split("T")[0];
  }
}

/** Singleton controller instance */
export const analyticsController = new AnalyticsController();
