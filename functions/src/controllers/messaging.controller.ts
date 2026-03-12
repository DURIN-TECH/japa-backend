import { Response } from "express";
import { AuthenticatedRequest } from "../middleware/auth";
import { messagingService } from "../services/messaging.service";
import { sendSuccess, sendCreated, sendError, sendNotFound, sendForbidden } from "../utils/response";
import { collections } from "../utils/firebase";

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
 * GET /conversations — list conversations for the authenticated user
 */
export async function listConversations(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const userId = req.userId!;
    const agentId = await getAgentId(userId);
    const conversations = await messagingService.getConversations(userId, agentId || undefined);

    // Enrich with participant names
    const enriched = await Promise.all(
      conversations.map(async (conv) => {
        const [userDoc, agentDoc] = await Promise.all([
          collections.users.doc(conv.userId).get(),
          collections.agents.doc(conv.agentId).get(),
        ]);
        const userData = userDoc.data();
        const agentData = agentDoc.data();
        return {
          ...conv,
          userName: userData ? `${userData.firstName} ${userData.lastName}` : "Unknown",
          userEmail: userData?.email,
          agentName: agentData?.displayName || "Unknown",
        };
      })
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

    sendCreated(res, conversation);
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
