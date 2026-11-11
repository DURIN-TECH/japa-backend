import type { Timestamp } from "firebase-admin/firestore";

// ============================================
// ASK-ANYWHERE CHAT — TYPES (issue #45)
// ============================================
//
// Two collections hold chat state, both backend-only (no firestore.rules match):
//
//   aiConversations/{conversationId}            one per (application, user)
//   aiConversations/{id}/messages/{messageId}   the turns, oldest first by createdAt
//   aiChatUsage/{uid}_{YYYY-MM-DD}              per-user rate and spend counters
//
// The conversation id is DERIVED: sha256(applicationId + ":" + uid). A caller
// can therefore only ever address their own conversation; there is no "list
// conversations of an application" query, so one agency's (or one user's)
// history cannot be retrieved by another by construction. Access to the
// application is still checked on every request (checkApplicationAccess).
//
// Pure module: types and constants only.

/** The entitlement feature key that gates chat. SEPARATE from `ai.case_officer`. */
export const CHAT_FEATURE_KEY = "ai.chat";

/** Longest user message accepted (characters, after trimming). */
export const CHAT_MAX_MESSAGE_CHARS = 1000;

/** Turns (user + assistant pairs) one conversation may hold before it must be cleared. */
export const CHAT_MAX_TURNS_PER_CONVERSATION = 200;

/** What kind of reply an assistant message is. Lets the UI render the empty states. */
export const CHAT_REPLY_KINDS = [
  // A model answer grounded in the stored assessment, rubric and application facts.
  "answer",
  // No succeeded assessment exists: fixed text, offers to run one. No model call.
  "no_assessment",
  // An assessment is queued or running: fixed text. No model call.
  "assessment_pending",
  // The route has no approved rubric: fixed text. No model call.
  "no_rubric",
  // The user message addressed the model (injection signal): fixed text. No model call.
  "declined",
  // The model answer failed a code-side check and was replaced by fixed text.
  "withheld",
] as const;
export type ChatReplyKind = (typeof CHAT_REPLY_KINDS)[number];

/** One citation attached to an answer. Copied from the approved rubric, never from model text. */
export interface ChatCitation {
  criterionId: string;
  title: string;
  ruleRef: string | null;
  sourceUrl: string;
  sourceQuote: string;
}

/** Token usage of one model call, as the API reported it. */
export interface ChatUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/** `aiConversations/{id}`. */
export interface AiConversation {
  id: string;
  applicationId: string;
  // The one user this conversation belongs to. Only they can read or clear it.
  userId: string;
  agencyId: string | null;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  // Number of user messages stored (the cap counts these).
  turnCount: number;
}

/** `aiConversations/{id}/messages/{messageId}`. */
export interface AiChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: Timestamp;
  // The tier the caller was on when the turn was written. A turn written on the
  // full tier is never shown to, or fed to the model for, a caller who is on
  // the free tier now (a downgrade must not expose earlier full-tier answers).
  tier: "free" | "full";
  // Assistant messages only.
  kind: ChatReplyKind | null;
  citations: ChatCitation[];
  assessmentId: string | null;
  rubricVersion: number | null;
  // True on a user message that tripped the injection check.
  suspicious: boolean;
  // Assistant messages that came from a model call only.
  usage: ChatUsage | null;
  promptVersion: string | null;
  model: string | null;
}
