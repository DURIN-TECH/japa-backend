import { Router } from "express";
import { verifyAuth } from "../middleware/auth";
import {
  listConversations,
  createConversation,
  getMessages,
  sendMessage,
  markAsRead,
  deleteConversation,
} from "../controllers/messaging.controller";

const router = Router();

// All messaging routes require authentication
router.use(verifyAuth);

// Conversation routes
router.get("/", listConversations);
router.post("/", createConversation);

// Message routes (nested under conversation)
router.get("/:id/messages", getMessages);
router.post("/:id/messages", sendMessage);

// Mark as read
router.put("/:id/read", markAsRead);

// Delete conversation
router.delete("/:id", deleteConversation);

export const messagingRoutes = router;
