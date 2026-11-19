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
  getConversation,
} from "../controllers/messaging.controller";

const router = Router();

// All messaging routes require authentication
router.use(verifyAuth);

// Conversation routes — starting a conversation + sending messages require the
// "messaging" entitlement.
router.get("/", listConversations);
router.post("/", requireFeature(FEATURES.MESSAGING), createConversation);

// One conversation (with the caller's AI-access view). There is no per-chat AI
// switch route any more (retired in #209): AI access is off only through the
// account-wide setting.
router.get("/:id", getConversation);

// Message routes (nested under conversation)
router.get("/:id/messages", getMessages);
router.post("/:id/messages", requireFeature(FEATURES.MESSAGING), sendMessage);

// Mark as read
router.put("/:id/read", markAsRead);

// Delete conversation
router.delete("/:id", deleteConversation);

export const messagingRoutes = router;
