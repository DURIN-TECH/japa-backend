import { collections } from "../utils/firebase";
import { Notification } from "../types";
import { Timestamp } from "firebase-admin/firestore";

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
