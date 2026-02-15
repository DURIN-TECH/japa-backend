import { Response } from "express";
import { AuthenticatedRequest } from "../middleware/auth";
import { notificationService } from "../services/notification.service";
import {
  sendSuccess,
  sendError,
  ErrorMessages,
} from "../utils/response";

export class NotificationController {
  /**
   * GET /notifications?limit=50
   * Get the current user's notifications.
   */
  async getNotifications(
    req: AuthenticatedRequest,
    res: Response
  ): Promise<void> {
    try {
      const userId = req.userId!;
      const limit = Math.min(100, parseInt(req.query.limit as string) || 50);

      const notifications = await notificationService.getNotificationsForUser(
        userId,
        limit
      );

      sendSuccess(res, notifications);
    } catch (error) {
      console.error("Error getting notifications:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  /**
   * GET /notifications/unread-count
   * Get the unread notification count for the current user.
   */
  async getUnreadCount(
    req: AuthenticatedRequest,
    res: Response
  ): Promise<void> {
    try {
      const userId = req.userId!;
      const count = await notificationService.getUnreadCount(userId);
      sendSuccess(res, { count });
    } catch (error) {
      console.error("Error getting unread count:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  /**
   * PUT /notifications/:id/read
   * Mark a single notification as read.
   */
  async markAsRead(
    req: AuthenticatedRequest,
    res: Response
  ): Promise<void> {
    try {
      const userId = req.userId!;
      const { id } = req.params;

      const notification = await notificationService.getNotificationById(id);
      if (!notification) {
        sendError(res, "NOT_FOUND", ErrorMessages.NOT_FOUND, 404);
        return;
      }

      // Only the notification owner can mark it as read
      if (notification.userId !== userId) {
        sendError(res, "FORBIDDEN", ErrorMessages.FORBIDDEN, 403);
        return;
      }

      await notificationService.markAsRead(id);
      sendSuccess(res, { success: true });
    } catch (error) {
      console.error("Error marking notification as read:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  /**
   * PUT /notifications/read-all
   * Mark all notifications as read for the current user.
   */
  async markAllRead(
    req: AuthenticatedRequest,
    res: Response
  ): Promise<void> {
    try {
      const userId = req.userId!;
      const count = await notificationService.markAllAsRead(userId);
      sendSuccess(res, { marked: count });
    } catch (error) {
      console.error("Error marking all notifications as read:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  /**
   * DELETE /notifications/:id
   * Delete a notification.
   */
  async deleteNotification(
    req: AuthenticatedRequest,
    res: Response
  ): Promise<void> {
    try {
      const userId = req.userId!;
      const { id } = req.params;

      const notification = await notificationService.getNotificationById(id);
      if (!notification) {
        sendError(res, "NOT_FOUND", ErrorMessages.NOT_FOUND, 404);
        return;
      }

      if (notification.userId !== userId) {
        sendError(res, "FORBIDDEN", ErrorMessages.FORBIDDEN, 403);
        return;
      }

      await notificationService.deleteNotification(id);
      sendSuccess(res, { success: true });
    } catch (error) {
      console.error("Error deleting notification:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }
}

export const notificationController = new NotificationController();
