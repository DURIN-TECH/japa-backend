import { Response } from "express";
import { AuthenticatedRequest } from "../middleware/auth";
import { messagingService } from "../services/messaging.service";
import { notificationService } from "../services/notification.service";
import { userService } from "../services/user.service";
import { sendSuccess, sendCreated, sendError, sendNotFound, sendForbidden } from "../utils/response";
import { collections } from "../utils/firebase";
import { Conversation, Agent, AiMessageAccessRecord } from "../types";
import {
  aiMessageAccessService,
  type ConversationAiAccessView,
} from "../services/ai-message-access.service";

/**
 * Check if the authenticated user is a participant in the conversation.
 */
async function isParticipant(userId: string, agentId: string | null, conversationId: string): Promise<boolean> {
  const conv = await messagingService.getConversationById(conversationId);
  if (!conv) return false;
  return conv.userId === userId || conv.agentId === agentId;
}

/**
 * Get the agent ID for the authenticated user (if they are an agent).
 */
async function getAgentId(userId: string): Promise<string | null> {
  const snap = await collections.agents
    .where("userId", "==", userId)
    .limit(1)
    .get();
  if (snap.empty) return null;
  return snap.docs[0].id;
}

/**
 * Notify the participant who DIDN'T send the message.
 *
 * Resolving the recipient is asymmetric, and the asymmetry is easy to get
 * wrong: `Conversation.userId` is a USER uid, but `Conversation.agentId` is an
 * agent DOCUMENT id. Notifications are addressed by user uid, so the agent side
 * needs a lookup through the `agents` collection first.
 *
 * Channel selection is left to the central policy (`channelsForType`), which
 * maps `message_received` to in-app only — deliberately, so a chat exchange
 * doesn't generate an email per message. The in-app record is what drives the
 * portal's unread badge.
 *
 * @param senderType Which side sent it, as already derived by the caller.
 * @param senderUid  The sending user's uid — used for their display name.
 */
async function notifyRecipient(
  conv: Conversation,
  senderType: "agent" | "user",
  senderUid: string,
  content: string
): Promise<void> {
  // Resolve the recipient and the sender's name CONCURRENTLY. They're
  // independent lookups, and running them in series put an extra Firestore
  // round trip between the message being sent and the notification existing —
  // latency the recipient sees directly.
  const [recipientUid, senderName] = await Promise.all([
    (async (): Promise<string | null> => {
      if (senderType === "agent") {
        // Agent wrote → the client receives it. userId is already a uid.
        return conv.userId;
      }
      // Client wrote → the agent receives it. conv.agentId is a DOC id, so map
      // it back to the owning user account.
      const agentDoc = await collections.agents.doc(conv.agentId).get();
      return agentDoc.exists
        ? ((agentDoc.data() as { userId?: string }).userId ?? null)
        : null;
    })(),
    userService.getDisplayName(senderUid).then((name) => name || "Someone"),
  ]);

  // No resolvable recipient (orphaned agent doc) — nothing to do.
  if (!recipientUid || recipientUid === senderUid) return;

  // Preview the message rather than just saying "you have a new message" — the
  // recipient can often act on it (or decide not to) without opening the thread.
  const preview =
    content.length > 120 ? `${content.slice(0, 117)}…` : content;

  await notificationService.notifyUser({
    userId: recipientUid,
    type: "message_received",
    title: `New message from ${senderName}`,
    body: preview,
    // Channels intentionally omitted — see the policy note above.
    relatedEntityType: "message",
    relatedEntityId: conv.id,
    data: { conversationId: conv.id },
  });
}

// ============================================
// AI message access view (issue #172)
// ============================================

/**
 * Turn stored conversations into API conversations for ONE participant:
 *  - strips the old per-side switch fields (`aiAccessOffUser/Agent`, retired in
 *    #209 and ignored everywhere) so they never reach a client;
 *  - adds `aiAccess`: { myAiAccess, accountWideOff, otherSwitchedOff, qualifies }
 *    (see ConversationAiAccessView).
 *
 * `aiAccess` is `null` when it could not be computed (a failed read). Clients
 * must treat null as "unknown", never as "on". It never exposes the other
 * person's approval or plan: `otherSwitchedOff` is a single yes/no that also
 * covers their account-wide setting.
 *
 * Reads are shared across the list: the caller's record + plan once, and each
 * distinct other person's record once.
 */
async function withAiAccess<T extends Conversation>(
  convs: T[],
  req: AuthenticatedRequest
): Promise<(Omit<T, "aiAccessOffUser" | "aiAccessOffAgent"> & { aiAccess: ConversationAiAccessView | null })[]> {
  const userId = req.userId!;
  // Caller's own record + plan, once. A failure leaves `me` null -> aiAccess null.
  const mePromise: Promise<{ record: AiMessageAccessRecord | null; hasAiPlan: boolean } | null> = (async () => {
    try {
      const [record, hasAiPlan] = await Promise.all([
        aiMessageAccessService.getRecord(userId),
        // Same source as the access check (resolved from the database, not token claims).
        aiMessageAccessService.uidHasAiPlan(userId),
      ]);
      return { record, hasAiPlan };
    } catch (e) {
      console.error("[messaging] AI access state failed:", (e as Error)?.message);
      return null;
    }
  })();

  // Per-request caches so a long list does not re-read the same person.
  const agentUidCache = new Map<string, Promise<string | null>>();
  const recordCache = new Map<string, Promise<AiMessageAccessRecord | null>>();
  const agentUid = (agentDocId: string) => {
    if (!agentUidCache.has(agentDocId)) {
      agentUidCache.set(
        agentDocId,
        collections.agents.doc(agentDocId).get().then((d) => (d.exists ? ((d.data() as Agent).userId ?? null) : null))
      );
    }
    return agentUidCache.get(agentDocId)!;
  };
  const recordOf = (uid: string) => {
    if (!recordCache.has(uid)) recordCache.set(uid, aiMessageAccessService.getRecord(uid));
    return recordCache.get(uid)!;
  };

  return Promise.all(
    convs.map(async (conv) => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { aiAccessOffUser, aiAccessOffAgent, ...rest } = conv;
      let aiAccess: ConversationAiAccessView | null = null;
      try {
        const me = await mePromise;
        if (me) {
          const side: "user" | "agent" = conv.userId === userId ? "user" : "agent";
          const otherUid = side === "user" ? await agentUid(conv.agentId) : conv.userId;
          const otherRecord = otherUid ? await recordOf(otherUid) : null;
          aiAccess = aiMessageAccessService.buildConversationView(me, otherRecord, !!otherUid);
        }
      } catch (e) {
        console.error("[messaging] AI access view failed:", (e as Error)?.message);
      }
      return { ...rest, aiAccess };
    })
  );
}

/** Add participant names to a conversation (list + single-conversation responses). */
async function withNames<T extends Conversation>(conv: T) {
  const [userDoc, agentDoc] = await Promise.all([
    collections.users.doc(conv.userId).get(),
    collections.agents.doc(conv.agentId).get(),
  ]);
  const userData = userDoc.data();
  const agentData = agentDoc.data();
  return {
    userName: userData ? `${userData.firstName} ${userData.lastName}` : "Unknown",
    userEmail: userData?.email,
    agentName: agentData?.displayName || "Unknown",
  };
}

/**
 * GET /conversations — list conversations for the authenticated user
 */
export async function listConversations(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const userId = req.userId!;
    const agentId = await getAgentId(userId);
    const conversations = await messagingService.getConversations(userId, agentId || undefined);

    // Enrich with participant names and the caller's AI-access view (#172).
    const withAccess = await withAiAccess(conversations, req);
    const enriched = await Promise.all(
      withAccess.map(async (conv, i) => ({ ...conv, ...(await withNames(conversations[i])) }))
    );

    sendSuccess(res, enriched);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed to fetch conversations";
    sendError(res, "INTERNAL_ERROR", message, 500);
  }
}

/**
 * POST /conversations — create or get existing conversation
 */
export async function createConversation(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const userId = req.userId!;
    const { participantId, applicationId } = req.body;

    if (!participantId) {
      sendError(res, "VALIDATION_ERROR", "participantId is required", 400);
      return;
    }

    // Determine who is the user and who is the agent
    const callerAgentId = await getAgentId(userId);
    let convUserId: string;
    let convAgentId: string;

    if (callerAgentId) {
      // Caller is an agent, participantId is a user
      convAgentId = callerAgentId;
      convUserId = participantId;
    } else {
      // Caller is a user, participantId should be an agent
      convUserId = userId;
      convAgentId = participantId;
    }

    const conversation = await messagingService.getOrCreateConversation(
      convUserId,
      convAgentId,
      applicationId
    );

    // Same shape as the list: own AI-access view in, old per-side fields out.
    const [withAccess] = await withAiAccess([conversation], req);
    sendCreated(res, withAccess);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed to create conversation";
    sendError(res, "INTERNAL_ERROR", message, 500);
  }
}

/**
 * GET /conversations/:id/messages — get messages for a conversation
 */
export async function getMessages(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const userId = req.userId!;
    const conversationId = req.params.id;
    const agentId = await getAgentId(userId);

    if (!(await isParticipant(userId, agentId, conversationId))) {
      sendForbidden(res);
      return;
    }

    const limit = parseInt(req.query.limit as string) || 50;
    const messages = await messagingService.getMessages(conversationId, limit);
    sendSuccess(res, messages);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed to fetch messages";
    sendError(res, "INTERNAL_ERROR", message, 500);
  }
}

/**
 * POST /conversations/:id/messages — send a message
 */
export async function sendMessage(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const userId = req.userId!;
    const conversationId = req.params.id;
    const { content, attachmentUrls } = req.body;

    if (!content?.trim()) {
      sendError(res, "VALIDATION_ERROR", "Message content is required", 400);
      return;
    }

    const agentId = await getAgentId(userId);

    if (!(await isParticipant(userId, agentId, conversationId))) {
      sendForbidden(res);
      return;
    }

    const conv = await messagingService.getConversationById(conversationId);
    if (!conv) {
      sendNotFound(res, "Conversation not found");
      return;
    }

    const senderType = conv.agentId === agentId ? "agent" : "user";
    const msg = await messagingService.sendMessage(
      conversationId,
      userId,
      senderType,
      content.trim(),
      attachmentUrls
    );

    // Tell the OTHER participant, BEFORE responding.
    //
    // This is deliberately awaited rather than fire-and-forget. Cloud Functions
    // throttles CPU once the response is sent, so background work kicked off
    // after `sendCreated` runs at the platform's convenience — which showed up
    // as a multi-second, variable delay before the recipient's bell updated.
    // Awaiting costs the SENDER ~one round trip and makes the recipient's
    // notification deterministic. (It also matches every other controller here.)
    //
    // Still fail-soft: a notification error must never fail a message that was
    // already written, so it's caught and logged rather than propagated.
    try {
      await notifyRecipient(conv, senderType, userId, content.trim());
    } catch (e) {
      console.error("[messaging] recipient notify failed:", e);
    }

    sendCreated(res, msg);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed to send message";
    sendError(res, "INTERNAL_ERROR", message, 500);
  }
}

/**
 * PUT /conversations/:id/read — mark conversation as read
 */
export async function markAsRead(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const userId = req.userId!;
    const conversationId = req.params.id;
    const agentId = await getAgentId(userId);

    if (!(await isParticipant(userId, agentId, conversationId))) {
      sendForbidden(res);
      return;
    }

    const conv = await messagingService.getConversationById(conversationId);
    if (!conv) {
      sendNotFound(res, "Conversation not found");
      return;
    }

    const isAgent = conv.agentId === agentId;
    await messagingService.markAsRead(conversationId, userId, isAgent);
    sendSuccess(res, { success: true });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed to mark as read";
    sendError(res, "INTERNAL_ERROR", message, 500);
  }
}

/**
 * DELETE /conversations/:id — delete a conversation
 */
export async function deleteConversation(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const userId = req.userId!;
    const conversationId = req.params.id;
    const agentId = await getAgentId(userId);

    if (!(await isParticipant(userId, agentId, conversationId))) {
      sendForbidden(res);
      return;
    }

    await messagingService.deleteConversation(conversationId);
    sendSuccess(res, { deleted: true });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed to delete conversation";
    sendError(res, "INTERNAL_ERROR", message, 500);
  }
}

/**
 * GET /conversations/:id — one conversation, with names and the caller's
 * AI-access view (issue #172). Lets a client refetch a single chat after a
 * switch or an approval without reloading the whole list.
 * 404 unknown id, 403 not a participant.
 */
export async function getConversation(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const userId = req.userId!;
    const conv = await messagingService.getConversationById(req.params.id);
    if (!conv) {
      sendNotFound(res, "Conversation not found");
      return;
    }
    const agentId = await getAgentId(userId);
    if (!(await isParticipant(userId, agentId, req.params.id))) {
      sendForbidden(res);
      return;
    }
    const [withAccess] = await withAiAccess([conv], req);
    sendSuccess(res, { ...withAccess, ...(await withNames(conv)) });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed to fetch conversation";
    sendError(res, "INTERNAL_ERROR", message, 500);
  }
}
