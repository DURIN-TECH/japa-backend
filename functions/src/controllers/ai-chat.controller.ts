import { Response } from "express";
import { ROLES } from "@durin-tech/authz";
import { AuthenticatedRequest } from "../middleware/auth";
import { paymentRequired } from "../middleware/authz";
import { collections } from "../utils/firebase";
import { checkApplicationAccessForRequest } from "../utils/access";
import { sendError, sendSuccess, sendNotFound, sendForbidden } from "../utils/response";
import type { Application } from "../types";
import { CHAT_MAX_MESSAGE_CHARS } from "../types/ai-chat";
import { aiChatService, type ChatPrincipal } from "../services/ai-chat.service";
import { tierFor, type AssessmentTier } from "../services/ai/tier-serializer";

// ============================================
// AI CHAT — HANDLERS (issue #45)
// ============================================
//
// Mounted at /ai (routes/ai.routes.ts), behind verifyAuth:
//
//   POST   /ai/applications/:id/chat   ask one question   { message }
//   GET    /ai/applications/:id/chat   the caller's own history
//   DELETE /ai/applications/:id/chat   clear the caller's own history
//
// Every handler does, in order:
//   1. load the application (404);
//   2. checkApplicationAccess `read` on it (403 FORBIDDEN): a cross-agency
//      caller stops here, and history is addressed by (application, uid) so one
//      user's or agency's history is never reachable by another;
//   3. the chat entitlement gate (`ai.case_officer`, no separate chat key), which FAILS CLOSED (see chatGate);
//   4. the tier (same function as the assessment routes) so the answer is
//      grounded only in what that caller may already see.

/** The caller as the service wants it. Always from the verified token. */
function principalOf(req: AuthenticatedRequest): ChatPrincipal | null {
  const uid = req.authz?.uid;
  if (!uid) return null;
  return { uid, role: req.authz?.role, agencyId: req.authz?.agencyId ?? null };
}

/**
 * The entitlement gate for chat. Differs from `requireFeature` on purpose:
 * that middleware lets a caller with UNRESOLVED entitlements through; chat
 * spends money, so unresolved means no.
 *   admin                                          -> allowed
 *   entitlements not resolved                      -> "unresolved" (403)
 *   resolved and plan includes `ai.case_officer`   -> allowed
 *   resolved, feature absent / plan lapsed         -> "locked" (402)
 *
 * Product decision: chat is NOT a separately sold feature. It rides on the AI
 * case officer, so every paid plan that has `FEATURES.AI_CASE_OFFICER` gets it
 * with no extra catalog key or seeding. The "has the feature" question is
 * answered by `tierFor` (the same function the assessment routes use), so the
 * entitlement rule lives in exactly one place: tier "full" == has the feature
 * (or admin). We only add the extra "unresolved" branch on top, because
 * `tierFor` folds unresolved into "free" and chat must tell the two apart
 * (403 vs 402).
 */
function chatGate(req: AuthenticatedRequest): "ok" | "unresolved" | "locked" {
  if (req.authz?.role === ROLES.ADMIN) return "ok";
  if (!req.entitlements) return "unresolved";
  return tierFor(req.authz?.role, req.entitlements) === "full" ? "ok" : "locked";
}

/** The application for a path id, or null. */
async function loadApplication(id: string): Promise<Application | null> {
  const snap = await collections.applications.doc(id).get();
  return snap.exists ? ({ id: snap.id, ...snap.data() } as Application) : null;
}

/** Steps 1-4 shared by every handler. Sends the error response and returns null on failure. */
async function authorize(
  req: AuthenticatedRequest,
  res: Response
): Promise<{ app: Application; principal: ChatPrincipal; tier: AssessmentTier } | null> {
  const app = await loadApplication(req.params.id);
  if (!app) {
    sendNotFound(res, "Application not found");
    return null;
  }
  const principal = principalOf(req);
  if (!principal || !checkApplicationAccessForRequest(req, app, "read")) {
    sendForbidden(res);
    return null;
  }
  const gate = chatGate(req);
  if (gate === "unresolved") {
    sendError(res, "ENTITLEMENTS_UNAVAILABLE", "We couldn't confirm your plan, so chat is unavailable right now.", 403);
    return null;
  }
  if (gate === "locked") {
    paymentRequired(res, "Chat is not included in your plan. Upgrade to use the AI case officer and chat.");
    return null;
  }
  return { app, principal, tier: tierFor(req.authz?.role, req.entitlements) };
}

export class AiChatController {
  /** POST /ai/applications/:id/chat  { message } */
  async ask(req: AuthenticatedRequest, res: Response): Promise<void> {
    const ctx = await authorize(req, res);
    if (!ctx) return;

    // Only `message` is read from the body, and only as a bounded string.
    const message = typeof req.body?.message === "string" ? req.body.message.trim() : "";
    if (message.length === 0 || message.length > CHAT_MAX_MESSAGE_CHARS) {
      return sendError(res, "VALIDATION_ERROR", `message is required and must be at most ${CHAT_MAX_MESSAGE_CHARS} characters.`, 400);
    }

    const outcome = await aiChatService.ask(ctx.app, ctx.principal, ctx.tier, message);
    switch (outcome.kind) {
    case "reply":
      return sendSuccess(res, outcome.reply);
    case "rate_limited":
      return sendError(
        res,
        "RATE_LIMITED",
        outcome.scope === "hour"
          ? "You've asked a lot in the last hour. Please try again a little later."
          : "You've reached today's chat limit. It resets at midnight UTC.",
        429
      );
    case "spend_cap":
      return sendError(res, "SPEND_CAP_REACHED", "You've reached today's chat allowance. It resets at midnight UTC.", 429);
    case "global_cap":
      return sendError(res, "DAILY_CAP_REACHED", "Chat is very busy today. Please try again tomorrow.", 429);
    case "conversation_full":
      return sendError(res, "CONVERSATION_FULL", "This conversation is full. Clear it to start a new one.", 409);
    case "forbidden":
      return sendForbidden(res);
    case "disabled":
      return sendError(res, "AI_DISABLED", "Chat is switched off right now.", 503);
    case "settings_unavailable":
    case "not_configured":
      return sendError(res, "CHAT_UNAVAILABLE", "Chat is unavailable right now.", 503);
    case "provider_error":
      return sendError(res, "CHAT_UNAVAILABLE", "I couldn't answer that just now. Please try again.", 502);
    }
  }

  /** GET /ai/applications/:id/chat: the caller's own history, oldest first. */
  async history(req: AuthenticatedRequest, res: Response): Promise<void> {
    const ctx = await authorize(req, res);
    if (!ctx) return;
    sendSuccess(res, { messages: await aiChatService.history(ctx.app, ctx.principal, ctx.tier) });
  }

  /** DELETE /ai/applications/:id/chat: clear the caller's own conversation. */
  async clear(req: AuthenticatedRequest, res: Response): Promise<void> {
    const ctx = await authorize(req, res);
    if (!ctx) return;
    await aiChatService.clear(ctx.app, ctx.principal);
    sendSuccess(res, { cleared: true });
  }
}

export const aiChatController = new AiChatController();
