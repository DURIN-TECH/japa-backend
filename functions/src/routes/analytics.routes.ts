/**
 * Analytics Routes
 *
 * Mounts analytics endpoints:
 *   POST /analytics/events          — Ingest batched analytics events
 *   GET  /analytics/kpis            — Dashboard KPI cards (totals + changes)
 *   GET  /analytics/case-trends     — Monthly case counts for bar chart
 *   GET  /analytics/revenue-trends  — Monthly revenue totals for line chart
 *   GET  /analytics/agent-metrics   — Per-agent performance table
 *   GET  /analytics/status-pipeline — Case counts by status for funnel
 *
 * All routes require authentication via the verifyAuth middleware.
 * The "role" query param on GET routes controls data scoping:
 *   - admin: sees all platform data (requires admin claim)
 *   - owner: sees all agency data (requires owner agencyRole)
 *   - agent: sees only their assigned data
 */

import { Router } from "express";
import { analyticsController } from "../controllers/analytics.controller";
import { verifyAuth } from "../middleware/auth";

const router = Router();

// ============================================
// EVENT INGESTION
// ============================================

// POST /analytics/events — Ingest a batch of analytics events
// Requires auth so we can trust the userId attribution
router.post("/events", verifyAuth, (req, res) =>
  analyticsController.ingestEvents(req, res)
);

// ============================================
// DASHBOARD DATA ENDPOINTS
// ============================================

// GET /analytics/kpis — Key performance indicators with period-over-period changes
// Query params: role (admin|owner|agent), from (ISO date), to (ISO date)
router.get("/kpis", verifyAuth, (req, res) =>
  analyticsController.getKPIs(req, res)
);

// GET /analytics/case-trends — Monthly case counts for the bar chart
// Query params: role, from, to
router.get("/case-trends", verifyAuth, (req, res) =>
  analyticsController.getCaseTrends(req, res)
);

// GET /analytics/revenue-trends — Monthly revenue totals for the line chart
// Query params: role, from, to
router.get("/revenue-trends", verifyAuth, (req, res) =>
  analyticsController.getRevenueTrends(req, res)
);

// GET /analytics/agent-metrics — Per-agent performance data for the table
// Query params: role (admin|owner only), from, to
router.get("/agent-metrics", verifyAuth, (req, res) =>
  analyticsController.getAgentMetrics(req, res)
);

// GET /analytics/status-pipeline — Case counts by status for the funnel
// Query params: role (no date range — shows current snapshot)
router.get("/status-pipeline", verifyAuth, (req, res) =>
  analyticsController.getStatusPipeline(req, res)
);

// ============================================
// EVENT-LEVEL ANALYTICS (admin only)
// ============================================

// GET /analytics/event-summary — Event counts grouped by event name
// Query params: from, to, source (optional), events (optional comma-separated)
router.get("/event-summary", verifyAuth, (req, res) =>
  analyticsController.getEventSummary(req, res)
);

// GET /analytics/active-users — Unique user and session counts
// Query params: from, to, source (optional)
router.get("/active-users", verifyAuth, (req, res) =>
  analyticsController.getActiveUsers(req, res)
);

// GET /analytics/top-pages — Page view rankings by traffic
// Query params: from, to, source (optional), limit (optional)
router.get("/top-pages", verifyAuth, (req, res) =>
  analyticsController.getTopPages(req, res)
);

export { router as analyticsRoutes };
