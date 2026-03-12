import { Router } from "express";
import { notificationController } from "../controllers/notification.controller";
import { verifyAuth } from "../middleware/auth";

const router = Router();

// Static routes before parameterized routes
router.get("/unread-count", verifyAuth, (req, res) =>
  notificationController.getUnreadCount(req, res)
);

router.put("/read-all", verifyAuth, (req, res) =>
  notificationController.markAllRead(req, res)
);

router.get("/", verifyAuth, (req, res) =>
  notificationController.getNotifications(req, res)
);

router.put("/:id/read", verifyAuth, (req, res) =>
  notificationController.markAsRead(req, res)
);

router.delete("/:id", verifyAuth, (req, res) =>
  notificationController.deleteNotification(req, res)
);

export { router as notificationRoutes };
