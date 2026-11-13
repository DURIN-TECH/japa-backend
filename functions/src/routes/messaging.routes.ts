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
  setAiAccess,
} from "../controllers/messaging.controller";

const router = Router();

// All messaging routes require authentication
router.use(verifyAuth);

// Conversation routes — starting a conversation + sending messages require the
// "messaging" entitlement.
router.get("/", listConversations);
router.post("/", requireFeature(FEATURES.MESSAGING), createConversation);

// One conversation (with the caller's AI-access view), and the per-chat AI
// access switch (issue #172). Any participant can switch their OWN side; it is
// a privacy control so it is not behind the messaging entitlement.
router.get("/:id", getConversation);
router.put("/:id/ai-access", setAiAccess);

// Message routes (nested under conversation)
router.get("/:id/messages", getMessages);
router.post("/:id/messages", requireFeature(FEATURES.MESSAGING), sendMessage);

// Mark as read
router.put("/:id/read", markAsRead);

// Delete conversation
router.delete("/:id", deleteConversation);

export const messagingRoutes = router;
