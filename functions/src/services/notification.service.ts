import { collections, messaging } from "../utils/firebase";
import {
  Notification,
  NotificationType,
  NotificationChannel,
} from "../types";
import { Timestamp } from "firebase-admin/firestore";
import { emailService } from "./email/email.service";

// Input for the unified, multi-channel notifier. A single call fans out to every
// requested channel (in-app record, push, email, sms). Channels are best-effort and
// independent — one failing never blocks the others or the caller.
export interface NotifyUserInput {
  userId: string; // Recipient's Firebase UID (also the users/{uid} doc id)
  type: NotificationType;
  title: string;
  body: string;
  // Which channels to deliver on. Defaults to ["in_app", "push"] when omitted.
  channels?: NotificationChannel[];
  // Deep-link metadata stored on the in-app record and sent in the push payload.
  relatedEntityType?: Notification["relatedEntityType"];
  relatedEntityId?: string;
  actionUrl?: string;
  // Extra string key/values merged into the FCM data payload (must be strings).
  data?: Record<string, string>;
}

class NotificationService {
  /**
   * Get notifications for a user, ordered by most recent first.
   */
  async getNotificationsForUser(
    userId: string,
    limit = 50
  ): Promise<Notification[]> {
    const snapshot = await collections.notifications
      .where("userId", "==", userId)
      .orderBy("createdAt", "desc")
      .limit(limit)
      .get();

    return snapshot.docs.map((doc) => doc.data() as Notification);
  }

  /**
   * Get unread count for a user.
   */
  async getUnreadCount(userId: string): Promise<number> {
    const snapshot = await collections.notifications
      .where("userId", "==", userId)
      .where("isRead", "==", false)
      .count()
      .get();

    return snapshot.data().count;
  }

  /**
   * Get a single notification by ID.
   */
  async getNotificationById(
    notificationId: string
  ): Promise<Notification | null> {
    const doc = await collections.notifications.doc(notificationId).get();
    if (!doc.exists) return null;
    return doc.data() as Notification;
  }

  /**
   * Create a notification.
   */
  async createNotification(
    data: Omit<Notification, "id" | "isRead" | "readAt" | "createdAt">
  ): Promise<Notification> {
    const docRef = collections.notifications.doc();
    const notification: Notification = {
      ...data,
      id: docRef.id,
      isRead: false,
      createdAt: Timestamp.now(),
    };

    await docRef.set(notification);
    return notification;
  }

  /**
   * Unified multi-channel notifier.
   *
   * Delivers a single logical notification across the requested channels. Each
   * channel is dispatched independently and best-effort: a failure in one (e.g. a
   * push token rejected by FCM) is logged and swallowed so the others — and the
   * caller's request — still succeed.
   *
   * Channel behaviour today:
   *  - in_app: writes a Firestore notification record (the existing pattern).
   *  - push:   REAL — sends FCM to the recipient's registered device tokens.
   *  - email:  STUB — logs + records a `notificationDeliveries` row (no real send).
   *  - sms:    STUB — logs + records a `notificationDeliveries` row (no real send).
   *
   * The email/sms stubs exist so the architecture is end-to-end today and a real
   * provider (SendGrid/Twilio) is a localized drop-in later — callers don't change.
   */
  async notifyUser(input: NotifyUserInput): Promise<void> {
    const channels = input.channels ?? ["in_app", "push"];

    // Load the recipient once — needed for push tokens (fcmTokens) and for the
    // email/sms stub destinations (email/phone).
    const userDoc = await collections.users.doc(input.userId).get();
    const user = userDoc.exists ? userDoc.data() : null;

    // --- in_app ---------------------------------------------------------------
    if (channels.includes("in_app")) {
      try {
        await this.createNotification({
          userId: input.userId,
          type: input.type,
          title: input.title,
          body: input.body,
          actionUrl: input.actionUrl,
          relatedEntityType: input.relatedEntityType,
          relatedEntityId: input.relatedEntityId,
        });
      } catch (err) {
        console.error("[notifyUser] in_app delivery failed:", err);
      }
    }

    // --- push (REAL FCM) ------------------------------------------------------
    if (channels.includes("push")) {
      const tokens = user?.fcmTokens ?? [];
      if (tokens.length > 0) {
        try {
          await messaging.sendEachForMulticast({
            tokens,
            notification: { title: input.title, body: input.body },
            // All FCM data values must be strings.
            data: {
              type: input.type,
              ...(input.relatedEntityId
                ? { relatedEntityId: input.relatedEntityId }
                : {}),
              ...(input.relatedEntityType
                ? { relatedEntityType: input.relatedEntityType }
                : {}),
              ...(input.data ?? {}),
            },
          });
        } catch (err) {
          // Never fail the request because a push couldn't be delivered.
          console.error("[notifyUser] push delivery failed:", err);
        }
      }
    }

    // --- email (REAL via provider, with safe fallback) ------------------------
    if (channels.includes("email")) {
      await this.deliverEmail(user?.email, input);
    }

    // --- sms (STUB) -----------------------------------------------------------
    if (channels.includes("sms")) {
      await this.recordStubDelivery(
        "sms",
        user?.phone,
        input
      );
    }
  }

  /**
   * Deliver a notification by email through the configured provider and record an
   * auditable `notificationDeliveries` row (status "sent"/"failed").
   *
   * Safe-rollout: when the provider isn't configured (no API key) or there's no
   * address on file, it falls back to the stub/log path — so nothing breaks until
   * email is set up, and email turns on automatically once the secret is present.
   */
  private async deliverEmail(
    to: string | undefined,
    input: NotifyUserInput
  ): Promise<void> {
    if (!to || !emailService.isConfigured) {
      await this.recordStubDelivery("email", to, input);
      return;
    }

    let status: "sent" | "failed" = "failed";
    let providerId: string | null = null;
    let error: string | null = null;
    try {
      const result = await emailService.sendNotification({
        to,
        subject: input.title,
        title: input.title,
        body: input.body,
        actionUrl: input.actionUrl,
      });
      status = result.status === "sent" ? "sent" : "failed";
      providerId = result.providerId ?? null;
      error = result.error ?? null;
      if (result.status !== "sent") {
        console.error(`[notifyUser] email ${result.status}: ${result.error}`);
      }
    } catch (err) {
      error = (err as Error).message;
      console.error("[notifyUser] email delivery failed:", err);
    }

    try {
      await collections.notificationDeliveries.add({
        channel: "email",
        to,
        userId: input.userId,
        subject: input.title,
        body: input.body,
        type: input.type,
        relatedEntityType: input.relatedEntityType ?? null,
        relatedEntityId: input.relatedEntityId ?? null,
        status,
        providerId,
        error,
        createdAt: Timestamp.now(),
      });
    } catch (err) {
      console.error("[notifyUser] email delivery record failed:", err);
    }
  }

  /**
   * Stub delivery helper for email/sms. Logs the message and records an auditable
   * row in `notificationDeliveries` with status "stubbed". Replace the body of this
   * method (or branch by channel) with a real SendGrid/Twilio call when ready —
   * nothing else in the codebase needs to change.
   */
  private async recordStubDelivery(
    channel: "email" | "sms",
    to: string | undefined,
    input: NotifyUserInput
  ): Promise<void> {
    try {
      console.log(
        `[${channel.toUpperCase()} stub] -> ${to ?? "(no destination on file)"}: ` +
          `${input.title} — ${input.body}`
      );
      await collections.notificationDeliveries.add({
        channel,
        to: to ?? null,
        userId: input.userId,
        subject: input.title,
        body: input.body,
        type: input.type,
        relatedEntityType: input.relatedEntityType ?? null,
        relatedEntityId: input.relatedEntityId ?? null,
        // "stubbed" = not actually sent; flips to "sent"/"failed" once wired up.
        status: "stubbed",
        createdAt: Timestamp.now(),
      });
    } catch (err) {
      console.error(`[notifyUser] ${channel} stub delivery failed:`, err);
    }
  }

  /**
   * Mark a single notification as read.
   */
  async markAsRead(notificationId: string): Promise<void> {
    await collections.notifications.doc(notificationId).update({
      isRead: true,
      readAt: Timestamp.now(),
    });
  }

  /**
   * Mark all notifications as read for a user.
   */
  async markAllAsRead(userId: string): Promise<number> {
    const snapshot = await collections.notifications
      .where("userId", "==", userId)
      .where("isRead", "==", false)
      .get();

    if (snapshot.empty) return 0;

    const batch = collections.notifications.firestore.batch();
    const now = Timestamp.now();

    for (const doc of snapshot.docs) {
      batch.update(doc.ref, { isRead: true, readAt: now });
    }

    await batch.commit();
    return snapshot.size;
  }

  /**
   * Delete a notification.
   */
  async deleteNotification(notificationId: string): Promise<void> {
    await collections.notifications.doc(notificationId).delete();
  }
}

export const notificationService = new NotificationService();
