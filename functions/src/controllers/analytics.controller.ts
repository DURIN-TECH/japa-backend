/**
 * Analytics Controller
 *
 * Handles incoming analytics event batches from the portal
 * and mobile apps. Events are validated and stored in Firestore
 * via the analytics service.
 *
 * Endpoints:
 *   POST /analytics/events — Ingest a batch of analytics events
 */

import { Response } from "express";
import { AuthenticatedRequest } from "../middleware/auth";
import { analyticsService, AnalyticsEventInput } from "../services/analytics.service";
import { sendSuccess, sendError, ErrorMessages } from "../utils/response";

export class AnalyticsController {
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
}

/** Singleton controller instance */
export const analyticsController = new AnalyticsController();
