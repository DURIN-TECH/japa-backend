import { ROLES, type Role } from "@durin-tech/authz";
import { collections, subcollections } from "../utils/firebase";
import { aiMessageAccessService, isApprovalActive } from "./ai-message-access.service";
import { decideMessageAccess, type AccessParty } from "./message-access/access-rule";
import type { Agent, Conversation, Message } from "../types";

// ============================================
// Message access for AI: THE choke point (issue #172)
// ============================================
//
// This file is the ONLY code allowed to return chat message content for AI use.
// Anything that wants to feed messages to a model (now or in a later feature)
// must call `messageAccessService.getMessagesForAi` (or the batch builders
// below). The no-bypass test (test/message-access/no-bypass.test.ts) fails the
// build when another file both reads the messages collection and talks to a
// model provider.
//
// What it guarantees:
//  - FAIL CLOSED. Missing conversation, unresolved participant, failed read,
//    unresolved entitlements, an unknown principal: the answer is "nothing" (an
//    empty list), never "everything" and never a thrown message that a caller
//    might swallow into "no filter".
//  - EVALUATED AT READ TIME. The rule (access-rule.ts) is applied against
//    today's approvals, plans and switches on every call. Nothing is stored per
//    message and nothing is cached, so a message sent before someone approved,
//    or before they switched a chat back on, is released only if the rule holds
//    NOW; and a revoke or switch takes effect on the very next call.
//  - ONLY THE QUALIFYING PERSON'S MESSAGES. In a chat where one person
//    qualifies, the other person's messages are not in the output.
//  - THE CALLER MUST BE ALLOWED TO SEE THE CHAT. The acting principal must be a
//    participant, an admin, or an owner/agent of the agency the agent
//    participant belongs to. An agency B principal gets nothing for an agency A
//    chat. (The calling feature still applies its own access check first; this
//    is the backstop so a bug there cannot leak a chat.)

/** Who is asking for the messages (same shape as the request's authz subject). */
export interface MessageAccessPrincipal {
  uid: string;
  role: Role;
  agencyId: string | null;
}

/** One conversation's released messages, for building a model request. */
export interface AiMessageBatchItem {
  conversationId: string;
  /** Only qualifying senders' messages, oldest first. Never empty (empty items are dropped). */
  messages: Message[];
}

/** Default and maximum number of most-recent messages one call reads. */
const DEFAULT_MESSAGE_LIMIT = 200;
const MAX_MESSAGE_LIMIT = 500;

/** The resolved two parties of a conversation. */
interface Participants {
  applicantUid: string;
  agentUid: string;
  /** The agent's agency (undefined for an independent agent). */
  agentAgencyId?: string;
}

class MessageAccessService {
  /** Resolve both parties' user uids. Null when the agent document is missing/unusable (fail closed). */
  private async resolveParticipants(conv: Conversation): Promise<Participants | null> {
    if (!conv.userId || !conv.agentId) return null;
    const agentSnap = await collections.agents.doc(conv.agentId).get();
    if (!agentSnap.exists) return null;
    const agent = agentSnap.data() as Agent;
    if (!agent.userId) return null;
    return { applicantUid: conv.userId, agentUid: agent.userId, agentAgencyId: agent.agencyId };
  }

  /** May this principal see this chat at all? Participant, admin, or same agency as the agent participant. */
  private principalMaySee(principal: MessageAccessPrincipal, p: Participants): boolean {
    if (!principal?.uid) return false;
    if (principal.role === ROLES.ADMIN) return true;
    if (principal.uid === p.applicantUid || principal.uid === p.agentUid) return true;
    // Agency colleagues: owner or agent role AND a matching, non-empty agency id.
    // A client (or anyone with no agency) never matches through the agency.
    const agencyRole = principal.role === ROLES.OWNER || principal.role === ROLES.AGENT;
    return agencyRole && !!principal.agencyId && principal.agencyId === p.agentAgencyId;
  }

  /** Read one party's status for the rule. Throws on a failed read (the caller fails closed). */
  private async partyStatus(uid: string): Promise<AccessParty> {
    const [record, hasAiPlan] = await Promise.all([
      aiMessageAccessService.getRecord(uid),
      aiMessageAccessService.uidHasAiPlan(uid),
    ]);
    return {
      approved: isApprovalActive(record),
      hasAiPlan,
      accountWideOff: record?.accountWideOff === true,
    };
  }

  /**
   * The messages of one chat that may be used for AI right now, or [].
   *
   * Never throws: any failure returns [] (fail closed), logged without content.
   *
   * @param limit most recent N messages to consider (default 200, max 500)
   */
  async getMessagesForAi(
    conversationId: string,
    principal: MessageAccessPrincipal,
    limit: number = DEFAULT_MESSAGE_LIMIT
  ): Promise<Message[]> {
    try {
      const convSnap = await collections.conversations.doc(conversationId).get();
      if (!convSnap.exists) return [];
      const conv = convSnap.data() as Conversation;

      const participants = await this.resolveParticipants(conv);
      if (!participants) return [];
      if (!this.principalMaySee(principal, participants)) return [];

      // Both parties' status is read BEFORE any message is read, so a chat that
      // is off or has nobody qualifying never even loads its content.
      const [applicant, agent] = await Promise.all([
        this.partyStatus(participants.applicantUid),
        this.partyStatus(participants.agentUid),
      ]);
      const decision = decideMessageAccess({
        switchOffUser: conv.aiAccessOffUser === true,
        switchOffAgent: conv.aiAccessOffAgent === true,
        applicant,
        agent,
      });
      if (decision.chatOff || (!decision.applicantReleased && !decision.agentReleased)) return [];

      const cap = Math.min(Math.max(1, Math.floor(limit) || DEFAULT_MESSAGE_LIMIT), MAX_MESSAGE_LIMIT);
      const snap = await subcollections
        .messages(conversationId)
        .orderBy("createdAt", "desc")
        .limit(cap)
        .get();
      const messages = snap.docs.map((d) => d.data() as Message).reverse();

      // Filter by the SENDER's uid (`senderId`), never by the `senderType` label.
      // A sender who is neither participant is not released (fail closed).
      return messages.filter(
        (m) =>
          (m.senderId === participants.applicantUid && decision.applicantReleased) ||
          (m.senderId === participants.agentUid && decision.agentReleased)
      );
    } catch (error) {
      console.error("[message-access] read failed; releasing nothing:", (error as Error)?.message);
      return [];
    }
  }

  /**
   * Gather the released messages of several chats for one batch of model
   * requests. Chats with nothing releasable are left out entirely.
   */
  async buildAiMessageBatch(
    principal: MessageAccessPrincipal,
    conversationIds: string[],
    limit?: number
  ): Promise<AiMessageBatchItem[]> {
    const items: AiMessageBatchItem[] = [];
    for (const conversationId of [...new Set(conversationIds)]) {
      const messages = await this.getMessagesForAi(conversationId, principal, limit);
      if (messages.length > 0) items.push({ conversationId, messages });
    }
    return items;
  }

  /**
   * Re-check an already built batch RIGHT BEFORE it is sent to the provider.
   *
   * A batch can sit for a while between "built" and "sent". If someone switched
   * a chat off (or withdrew approval, or the plan lapsed) in between, the stale
   * request must not go out. This re-runs the rule for every item: an item that
   * no longer releases anything is dropped, and an item keeps only messages the
   * rule still releases (matched by message id, so edited content can never slip
   * in: the content comes from the fresh read, not from the old item).
   */
  async recheckAiMessageBatch(
    principal: MessageAccessPrincipal,
    items: AiMessageBatchItem[]
  ): Promise<AiMessageBatchItem[]> {
    const fresh: AiMessageBatchItem[] = [];
    for (const item of items) {
      const allowedNow = await this.getMessagesForAi(item.conversationId, principal);
      const wantedIds = new Set(item.messages.map((m) => m.id));
      const messages = allowedNow.filter((m) => wantedIds.has(m.id));
      if (messages.length > 0) fresh.push({ conversationId: item.conversationId, messages });
    }
    return fresh;
  }
}

export const messageAccessService = new MessageAccessService();
