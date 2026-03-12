import { collections, subcollections, db, increment } from "../utils/firebase";
import { Conversation, Message } from "../types";
import { Timestamp } from "firebase-admin/firestore";

class MessagingService {
  /**
   * Get conversations for a user (as either user or agent).
   */
  async getConversations(userId: string, agentId?: string): Promise<Conversation[]> {
    const results: Conversation[] = [];

    // Get conversations where user is the client
    const userSnap = await collections.conversations
      .where("userId", "==", userId)
      .orderBy("lastMessageAt", "desc")
      .get();
    userSnap.docs.forEach((doc) => results.push(doc.data() as Conversation));

    // If user is also an agent, get agent conversations
    if (agentId) {
      const agentSnap = await collections.conversations
        .where("agentId", "==", agentId)
        .orderBy("lastMessageAt", "desc")
        .get();
      const existingIds = new Set(results.map((c) => c.id));
      agentSnap.docs.forEach((doc) => {
        if (!existingIds.has(doc.id)) {
          results.push(doc.data() as Conversation);
        }
      });
    }

    // Sort combined results by lastMessageAt descending
    results.sort((a, b) => b.lastMessageAt.toMillis() - a.lastMessageAt.toMillis());
    return results;
  }

  /**
   * Get a single conversation by ID.
   */
  async getConversationById(conversationId: string): Promise<Conversation | null> {
    const doc = await collections.conversations.doc(conversationId).get();
    if (!doc.exists) return null;
    return doc.data() as Conversation;
  }

  /**
   * Create or get existing conversation between a user and agent.
   */
  async getOrCreateConversation(
    userId: string,
    agentId: string,
    applicationId?: string
  ): Promise<Conversation> {
    // Check for existing conversation
    let query = collections.conversations
      .where("userId", "==", userId)
      .where("agentId", "==", agentId);

    if (applicationId) {
      query = query.where("applicationId", "==", applicationId);
    }

    const existing = await query.limit(1).get();
    if (!existing.empty) {
      return existing.docs[0].data() as Conversation;
    }

    // Create new conversation
    const docRef = collections.conversations.doc();
    const now = Timestamp.now();
    const conversation: Conversation = {
      id: docRef.id,
      userId,
      agentId,
      applicationId,
      lastMessageAt: now,
      unreadCountUser: 0,
      unreadCountAgent: 0,
      createdAt: now,
      updatedAt: now,
    };

    await docRef.set(conversation);
    return conversation;
  }

  /**
   * Get messages for a conversation, paginated.
   */
  async getMessages(
    conversationId: string,
    limit = 50,
    beforeTimestamp?: Timestamp
  ): Promise<Message[]> {
    let query = subcollections
      .messages(conversationId)
      .orderBy("createdAt", "desc")
      .limit(limit);

    if (beforeTimestamp) {
      query = query.where("createdAt", "<", beforeTimestamp);
    }

    const snapshot = await query.get();
    return snapshot.docs.map((doc) => doc.data() as Message).reverse();
  }

  /**
   * Send a message in a conversation.
   */
  async sendMessage(
    conversationId: string,
    senderId: string,
    senderType: "user" | "agent",
    content: string,
    attachmentUrls?: string[]
  ): Promise<Message> {
    const msgRef = subcollections.messages(conversationId).doc();
    const now = Timestamp.now();

    const message: Message = {
      id: msgRef.id,
      conversationId,
      senderId,
      senderType,
      content,
      attachmentUrls,
      isRead: false,
      createdAt: now,
    };

    // Write message and update conversation in a batch
    const unreadField = senderType === "agent" ? "unreadCountUser" : "unreadCountAgent";
    const convRef = collections.conversations.doc(conversationId);

    const batch = db.batch();
    batch.set(msgRef, message);
    batch.update(convRef, {
      lastMessage: content.substring(0, 100),
      lastMessageAt: now,
      updatedAt: now,
      [unreadField]: increment(1),
    });

    await batch.commit();
    return message;
  }

  /**
   * Mark messages as read in a conversation.
   */
  async markAsRead(conversationId: string, userId: string, isAgent: boolean): Promise<void> {
    // Reset the appropriate unread count
    const unreadField = isAgent ? "unreadCountAgent" : "unreadCountUser";
    await collections.conversations.doc(conversationId).update({
      [unreadField]: 0,
      updatedAt: Timestamp.now(),
    });

    // Mark individual messages as read
    const snapshot = await subcollections
      .messages(conversationId)
      .where("isRead", "==", false)
      .where("senderType", "==", isAgent ? "user" : "agent")
      .get();

    if (snapshot.empty) return;

    const batch = db.batch();
    const now = Timestamp.now();
    for (const doc of snapshot.docs) {
      batch.update(doc.ref, { isRead: true, readAt: now });
    }
    await batch.commit();
  }

  /**
   * Delete a conversation and all its messages.
   */
  async deleteConversation(conversationId: string): Promise<void> {
    // Delete all messages first
    const messages = await subcollections.messages(conversationId).get();
    if (!messages.empty) {
      const batch = db.batch();
      for (const doc of messages.docs) {
        batch.delete(doc.ref);
      }
      await batch.commit();
    }

    // Delete conversation
    await collections.conversations.doc(conversationId).delete();
  }
}

export const messagingService = new MessagingService();
