import { Router } from "express";
import { verifyAuth } from "../middleware/auth";
import { requireFeature } from "../middleware/authz";
import { FEATURES } from "@durin-tech/authz";
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

// Conversation routes — starting a conversation + sending messages require the
// "messaging" entitlement.
router.get("/", listConversations);
router.post("/", requireFeature(FEATURES.MESSAGING), createConversation);

// Message routes (nested under conversation)
router.get("/:id/messages", getMessages);
router.post("/:id/messages", requireFeature(FEATURES.MESSAGING), sendMessage);

// Mark as read
router.put("/:id/read", markAsRead);

// Delete conversation
router.delete("/:id", deleteConversation);

export const messagingRoutes = router;
