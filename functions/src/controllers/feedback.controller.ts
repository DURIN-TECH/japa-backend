// ============================================
// Feedback controller (issue #257)
// ============================================
//
// POST /feedback/screenshot-url  mint a signed PUT URL for the screenshot
// POST /feedback                 validate and store a note, email the team
//
// Both sit behind `verifyAuth` (any signed-in role). Identity (user id, email,
// role) is taken from the verified token, never from the body.

import { Response } from "express";
import { ROLES } from "@durin-tech/authz";
import type { AuthenticatedRequest } from "../middleware/auth";
import { sendError, sendSuccess } from "../utils/response";
import { validateStoragePath } from "../utils/storage-paths";
import { storageService } from "../services/storage.service";
import { feedbackService, type NewFeedback } from "../services/feedback.service";
import type { FeedbackKind } from "../types";

// ============================================
// Limits
// ============================================

export const MAX_MESSAGE_LENGTH = 2000;
export const MAX_ROUTE_LENGTH = 200;
const MAX_SHORT_FIELD_LENGTH = 50;

/** Screenshot formats the app can produce. */
export const ALLOWED_SCREENSHOT_CONTENT_TYPES = ["image/png", "image/jpeg"];

const KINDS: FeedbackKind[] = ["bug", "idea"];
const PLATFORMS = ["ios", "android", "web"];

/** App environments: letters, digits, dash, underscore (e.g. dev, prod). */
const APP_ENV_PATTERN = /^[a-z0-9_-]{1,20}$/;

/** A trimmed, non-empty string no longer than `max`, else null. */
function shortString(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const v = value.trim();
  return v.length > 0 && v.length <= max ? v : null;
}

/**
 * Validate the POST /feedback body. Returns the clean fields, or the message
 * to send back with a 400. `userId` is needed to scope the screenshot path.
 */
export function validateFeedbackBody(
  body: Record<string, unknown> | undefined,
  userId: string
): { ok: true; value: Omit<NewFeedback, "userId" | "userEmail" | "role"> } | { ok: false; message: string } {
  const b = body ?? {};

  if (typeof b.kind !== "string" || !KINDS.includes(b.kind as FeedbackKind)) {
    return { ok: false, message: "kind must be 'bug' or 'idea'" };
  }

  if (typeof b.message !== "string") return { ok: false, message: "message is required" };
  const message = b.message.trim();
  if (message.length < 1 || message.length > MAX_MESSAGE_LENGTH) {
    return { ok: false, message: `message must be 1 to ${MAX_MESSAGE_LENGTH} characters` };
  }

  const route = shortString(b.route, MAX_ROUTE_LENGTH);
  if (!route) return { ok: false, message: `route is required (max ${MAX_ROUTE_LENGTH} characters)` };

  const appVersion = shortString(b.appVersion, MAX_SHORT_FIELD_LENGTH);
  if (!appVersion) return { ok: false, message: "appVersion is required" };

  const platform = typeof b.platform === "string" ? b.platform.trim().toLowerCase() : "";
  if (!PLATFORMS.includes(platform)) return { ok: false, message: "platform must be ios, android or web" };

  // Optional device details: absent becomes "unknown"; present but malformed is refused.
  let osVersion = "unknown";
  if (b.osVersion !== undefined && b.osVersion !== null && b.osVersion !== "") {
    const v = shortString(b.osVersion, MAX_SHORT_FIELD_LENGTH);
    if (!v) return { ok: false, message: "osVersion is invalid" };
    osVersion = v;
  }
  let appEnv = "unknown";
  if (b.appEnv !== undefined && b.appEnv !== null && b.appEnv !== "") {
    if (typeof b.appEnv !== "string" || !APP_ENV_PATTERN.test(b.appEnv)) {
      return { ok: false, message: "appEnv is invalid" };
    }
    appEnv = b.appEnv;
  }

  // Optional screenshot: must be an object the backend issued for THIS user.
  let screenshotPath: string | null = null;
  if (b.screenshotPath !== undefined && b.screenshotPath !== null) {
    const checked = validateStoragePath(b.screenshotPath, { purpose: "feedback-screenshot", userId });
    if (!checked.ok) {
      return { ok: false, message: "screenshotPath does not belong to this user" };
    }
    screenshotPath = checked.key;
  }

  return {
    ok: true,
    value: { kind: b.kind as FeedbackKind, message, route, appVersion, platform, osVersion, appEnv, screenshotPath },
  };
}

// ============================================
// Handlers
// ============================================

export class FeedbackController {
  /** POST /feedback/screenshot-url: `{ fileName, contentType }` -> `{ uploadUrl, storagePath }`. */
  async getScreenshotUploadUrl(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const userId = req.userId!;
      const { fileName, contentType } = req.body ?? {};

      if (typeof fileName !== "string" || !fileName || typeof contentType !== "string" || !contentType) {
        sendError(res, "VALIDATION_ERROR", "fileName and contentType are required", 400);
        return;
      }
      if (fileName.length > 200) {
        sendError(res, "VALIDATION_ERROR", "fileName is too long", 400);
        return;
      }
      if (!ALLOWED_SCREENSHOT_CONTENT_TYPES.includes(contentType)) {
        sendError(
          res,
          "VALIDATION_ERROR",
          `Invalid content type. Allowed: ${ALLOWED_SCREENSHOT_CONTENT_TYPES.join(", ")}`,
          400
        );
        return;
      }

      // Abuse guard: a user may mint only so many upload URLs per hour.
      if (!(await feedbackService.allowScreenshotUrl(userId))) {
        res.setHeader("Retry-After", "3600");
        sendError(res, "RATE_LIMITED", "Too many uploads. Please try again later.", 429);
        return;
      }

      const { uploadUrl, storagePath, uploadHeaders } = await storageService.getSignedFeedbackScreenshotUploadUrl(
        userId,
        fileName,
        contentType
      );
      sendSuccess(res, { uploadUrl, storagePath, uploadHeaders });
    } catch (error) {
      console.error("Error getting feedback screenshot upload URL:", error);
      sendError(res, "INTERNAL_ERROR", "Something went wrong", 500);
    }
  }

  /** POST /feedback: validate, rate limit, store, email. Returns 201 `{ id }`. */
  async create(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const userId = req.userId!;

      const parsed = validateFeedbackBody(req.body, userId);
      if (!parsed.ok) {
        sendError(res, "VALIDATION_ERROR", parsed.message, 400);
        return;
      }

      const result = await feedbackService.submit({
        ...parsed.value,
        userId,
        userEmail: req.user?.email ?? "",
        // Role from the verified claims; a token with none is a client.
        role: req.authz?.role ?? ROLES.CLIENT,
      });

      if (!result.ok) {
        res.setHeader("Retry-After", String(result.retryAfterSeconds));
        sendError(res, "RATE_LIMITED", "Too much feedback in the last hour. Please try again later.", 429);
        return;
      }

      sendSuccess(res, { id: result.id, screenshotAttached: result.screenshotAttached }, "Feedback received", 201);
    } catch (error) {
      console.error("Error saving feedback:", error);
      sendError(res, "INTERNAL_ERROR", "Something went wrong", 500);
    }
  }
}

export const feedbackController = new FeedbackController();
