/**
 * Analytics Routes
 *
 * Mounts the analytics event ingestion endpoint.
 * All routes require authentication so we can attribute
 * events to verified users.
 */

import { Router } from "express";
import { analyticsController } from "../controllers/analytics.controller";
import { verifyAuth } from "../middleware/auth";

const router = Router();

// POST /analytics/events — Ingest a batch of analytics events
// Requires auth so we can trust the userId attribution
router.post("/events", verifyAuth, (req, res) =>
  analyticsController.ingestEvents(req, res)
);

export { router as analyticsRoutes };
