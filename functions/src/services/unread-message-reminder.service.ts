/**
 * Unread-message email reminders.
 *
 * A message that lands in the portal fires an in-app record and a push
 * (`message_received`) and nothing else — deliberately, so an active chat doesn't
 * generate an email per line. But those channels only work for someone who is
 * looking. This sweep covers the case where nobody was: when a message has sat
 * unread for over an hour, the side that hasn't read it gets ONE email saying
 * there's a new message, with a link straight to that thread on the portal.
 *
 * Symmetric by design — clients and agents are nudged by exactly the same rule,
 * each linked to their own view of the same conversation.
 *
 * Idempotency: `unreadReminderSentAt{User,Agent}` is stamped after a successful
 * send, and a side is skipped while its stamp is newer than `lastMessageAt`. So a
 * backlog nags once, a NEW message re-arms the nudge, and reading the thread ends
 * it (the unread count drops to zero).
 */
import { collections } from "../utils/firebase";
import { Conversation } from "../types";
import { messagingService } from "./messaging.service";
import { notificationService } from "./notification.service";
import { userService } from "./user.service";
import { EMAIL_BRANDING } from "./email/branding";

/** How long a message must sit unread before the nudge goes out. */
const REMINDER_AFTER_MS = 60 * 60 * 1000; // 1 hour

/**
 * Oldest activity the sweep considers. Bounds the query (see
 * `findConversationsWithRecentMessages`) and stops a scheduler outage from
 * emitting a pile of days-late "new message" emails when it recovers.
 */
const SWEEP_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours

/** Which participant is being reminded. Mirrors `Message.senderType`. */
type Side = "user" | "agent";

/** Counters returned for the scheduler's log line. */
export interface UnreadReminderRunResult {
  conversationsScanned: number;
  remindersSent: number;
  errors: number;
}

class UnreadMessageReminderService {
  /**
   * Portal deep link to a conversation, for the side being reminded.
   *
   * The two audiences read the same thread through different shells — clients at
   * `/client/messages`, agent-side users at `/messaging` — so the link has to be
   * built per recipient. Both pages select a thread from `?conversationId=`.
   */
  private threadUrl(side: Side, conversationId: string): string {
    const base = side === "agent" ? "/messaging" : "/client/messages";
    return `${EMAIL_BRANDING.appUrl}${base}?conversationId=${encodeURIComponent(
      conversationId
    )}`;
  }

  /**
   * Resolve the uid to email for one side of a conversation.
   *
   * Asymmetric, and the same trap `notifyRecipient` documents: `userId` is
   * already a uid, but `agentId` is an agent DOCUMENT id that has to be mapped
   * back to the owning account. Returns null for an orphaned agent record.
   */
  private async recipientUid(
    conversation: Conversation,
    side: Side
  ): Promise<string | null> {
    if (side === "user") return conversation.userId;

    const agentDoc = await collections.agents.doc(conversation.agentId).get();
    return agentDoc.exists
      ? ((agentDoc.data() as { userId?: string }).userId ?? null)
      : null;
  }

  /**
   * Display name of the person on the OTHER side — who the message is from.
   * Falls back to a neutral label rather than failing the reminder.
   */
  private async senderName(
    conversation: Conversation,
    side: Side
  ): Promise<string> {
    // Reminding the client => the message came from their agent.
    if (side === "user") {
      const agentDoc = await collections.agents.doc(conversation.agentId).get();
      const displayName = (agentDoc.data() as { displayName?: string } | undefined)
        ?.displayName;
      return displayName || "Your agent";
    }

    // Reminding the agent => the message came from the client.
    const name = await userService.getDisplayName(conversation.userId).catch(() => "");
    return name || "A client";
  }

  /**
   * Has this side already been nudged about the current unread backlog?
   *
   * True while the stamp is at or after `lastMessageAt`. A message arriving later
   * pushes `lastMessageAt` past the stamp and re-arms the nudge, which is exactly
   * the behaviour we want: remind once per burst, not once per hour forever.
   */
  private alreadyReminded(conversation: Conversation, side: Side): boolean {
    const sentAt =
      side === "agent"
        ? conversation.unreadReminderSentAtAgent
        : conversation.unreadReminderSentAtUser;
    if (!sentAt) return false;
    return sentAt.toMillis() >= conversation.lastMessageAt.toMillis();
  }

  /** Unread count for one side. */
  private unreadCount(conversation: Conversation, side: Side): number {
    return side === "agent"
      ? (conversation.unreadCountAgent ?? 0)
      : (conversation.unreadCountUser ?? 0);
  }

  /**
   * Send the nudge to one side of one conversation.
   *
   * Returns true when an email was dispatched (and the stamp written). The stamp
   * is written only after `notifyUser` resolves, so a failure mid-run is retried
   * on the next tick instead of being silently dropped.
   */
  private async remindSide(
    conversation: Conversation,
    side: Side
  ): Promise<boolean> {
    const recipient = await this.recipientUid(conversation, side);
    if (!recipient) return false;

    const unread = this.unreadCount(conversation, side);
    const from = await this.senderName(conversation, side);

    // Lead with the fact, then the preview. `lastMessage` is already truncated to
    // 100 chars when the message is written, so it's safe to inline verbatim.
    const countPhrase =
      unread > 1 ? `${unread} unread messages` : "a new message";
    const preview = conversation.lastMessage?.trim()
      ? `\n\n"${conversation.lastMessage.trim()}"`
      : "";

    await notificationService.notifyUser({
      userId: recipient,
      type: "message_unread_reminder",
      title: "You have a new message",
      body:
        `You have ${countPhrase} from ${from} that you haven't read yet.` +
        preview +
        "\n\nOpen the conversation to read and reply.",
      // Explicit per-recipient deep link — the event template has no `path` of
      // its own precisely because clients and agents land on different pages.
      actionUrl: this.threadUrl(side, conversation.id),
      relatedEntityType: "message",
      relatedEntityId: conversation.id,
      // Co-brand the email with the agency handling THIS case, rather than
      // whichever application the recipient most recently touched.
      brandApplicationId: conversation.applicationId,
      // Channels come from the policy (email only) — see notification-policy.ts.
    });

    await messagingService.recordUnreadReminderSent(conversation.id, side);
    return true;
  }

  /**
   * One sweep. Called by the scheduled function; safe to run as often as you like
   * since the per-side stamp is what prevents duplicates, not the cadence.
   */
  async run(now: Date = new Date()): Promise<UnreadReminderRunResult> {
    const olderThan = new Date(now.getTime() - REMINDER_AFTER_MS);
    const notBefore = new Date(now.getTime() - SWEEP_WINDOW_MS);

    const conversations = await messagingService.findConversationsWithRecentMessages(
      notBefore,
      olderThan
    );

    let remindersSent = 0;
    let errors = 0;

    for (const conversation of conversations) {
      // Both sides are checked independently: a thread where each party left the
      // other on read owes a reminder in both directions.
      for (const side of ["user", "agent"] as Side[]) {
        if (this.unreadCount(conversation, side) <= 0) continue;
        if (this.alreadyReminded(conversation, side)) continue;

        try {
          if (await this.remindSide(conversation, side)) remindersSent += 1;
        } catch (err) {
          // One bad conversation must not abort the sweep.
          errors += 1;
          console.error(
            `[unread-reminder] ${side} reminder failed for conversation ` +
              `${conversation.id}:`,
            err
          );
        }
      }
    }

    return {
      conversationsScanned: conversations.length,
      remindersSent,
      errors,
    };
  }
}

export const unreadMessageReminderService = new UnreadMessageReminderService();

// Re-exported for tests / callers that need to reason about the cadence without
// duplicating the literals.
export const UNREAD_REMINDER_CONSTANTS = {
  REMINDER_AFTER_MS,
  SWEEP_WINDOW_MS,
} as const;
