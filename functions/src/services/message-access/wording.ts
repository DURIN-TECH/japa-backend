// ============================================
// AI message access: versioned wording (issue #172)
// ============================================
//
// The ONE place on the backend where the approval wording and the one-time
// notice wording live. The mobile and portal apps mirror this text, but the
// server is the authority: when a person approves, the server stores THIS
// text (looked up by version id), never text the client sends. That way the
// stored "exact wording shown" cannot be forged or drift from what a version
// id means.
//
// !! DRAFT — needs owner or legal sign-off before release. !!
// The wording deliberately states no retention period, no AI-provider terms
// and nothing about redaction: none of those are decided yet (see #128).
//
// To change the wording: add a NEW version id (never edit a published one in
// place, an approval stored against an old id must keep matching its text),
// point `CURRENT_*` at it, and keep the old entry in the `*_HISTORY` list.

/** One versioned block of wording. */
export interface WordingVersion {
  /** Stable id stored on the approval record, e.g. "ai-message-access-approval.draft-1". */
  versionId: string;
  /** True until the owner or legal signs the text off. Surface it in the UI. */
  draft: boolean;
  /** Short heading (the notice title, the approval card heading). */
  title: string;
  /** The paragraphs shown, in order. Curly apostrophes on purpose (design spec). */
  paragraphs: string[];
  /** Optional closing line shown under the paragraphs (the notice's note line). Not part of stored approval text. */
  note?: string;
}

// ---- Approval wording ---------------------------------------------------------

/**
 * Approval wording, draft 1 (design spec, 2026-11-13). Role-neutral on purpose.
 *
 * EDITED IN PLACE, ONCE: paragraph 3 was changed to match the "Design spec
 * amendment" on #172 (account-wide off). The version id stays `draft-1` because
 * nothing has been released and no approval has been stored against the old text.
 * After release, never edit a version: add `draft-2`/`v1` instead.
 */
export const APPROVAL_WORDING_DRAFT_1: WordingVersion = {
  versionId: "ai-message-access-approval.draft-1",
  draft: true,
  title: "AI message access",
  paragraphs: [
    "I agree that Seli’s AI may read and analyse the messages I send in my chats on Seli, to provide intelligent analysis.",
    "This covers my own messages only. The other person’s messages are covered only by their own choices.",
    "I can switch AI access off or on for any chat, or for all my chats at once, at any time. The other person in a chat can switch it off for that chat too. While a chat is switched off, nothing in it is read.",
    "I can withdraw this approval at any time in my settings. From that moment, my messages are no longer read on the basis of this approval.",
  ],
};

/**
 * Approval wording, draft 2 (issue #193). The owner found draft 1 too long, so
 * this is ONE short paragraph (reworded in place before release: no per-chat
 * mention, owner change 2 on #193). A new id (draft 1 above is untouched): approvals
 * stored under draft 1 stay active and keep their own stored text, nobody is
 * asked to re-approve. Like draft 1, it states no retention period, no
 * AI-provider terms and nothing about redaction (undecided, see #128).
 */
export const APPROVAL_WORDING_DRAFT_2: WordingVersion = {
  versionId: "ai-message-access-approval.draft-2",
  draft: true,
  title: "AI message access",
  paragraphs: [
    "Seli’s AI may read the messages I send in my chats. I can switch this off for all my chats, and withdraw this approval, at any time.",
  ],
};

/** Every approval wording ever published, oldest first. Lookup by version id. */
export const APPROVAL_WORDING_HISTORY: readonly WordingVersion[] = [APPROVAL_WORDING_DRAFT_1, APPROVAL_WORDING_DRAFT_2];

/** The approval wording shown today. */
export const CURRENT_APPROVAL_WORDING: WordingVersion = APPROVAL_WORDING_DRAFT_2;

// ---- One-time notice wording (people who qualify through a plan) ----------------

/**
 * Notice wording, draft 1 (design spec, 2026-11-13). The `note` line was added
 * in place to match the "Design spec amendment" on #172 (same one-time edit of
 * `draft-1` as the approval wording above; nothing has been released).
 */
export const NOTICE_WORDING_DRAFT_1: WordingVersion = {
  versionId: "ai-message-access-notice.draft-1",
  draft: true,
  title: "The plan you’re on includes AI",
  paragraphs: [
    "That means Seli’s AI may read and analyse the messages you send in your chats on Seli, to provide intelligent analysis. It covers your own messages only.",
    "You’re in control. Switch AI access off or on for any chat, at any time. While a chat is switched off, nothing in it is read.",
  ],
  note: "You’ll find this switch at the top of every chat. To keep AI out of all your chats at once, go to AI message access in your settings.",
};

/** Every notice wording ever published, oldest first. */
export const NOTICE_WORDING_HISTORY: readonly WordingVersion[] = [NOTICE_WORDING_DRAFT_1];

/** The notice wording shown today. */
export const CURRENT_NOTICE_WORDING: WordingVersion = NOTICE_WORDING_DRAFT_1;

// ---- Helpers --------------------------------------------------------------------

/** The exact text stored on an approval record: the paragraphs joined by a blank line. */
export function wordingText(w: WordingVersion): string {
  return w.paragraphs.join("\n\n");
}

/** Find a published approval wording by version id (undefined for an unknown id). */
export function findApprovalWording(versionId: string): WordingVersion | undefined {
  return APPROVAL_WORDING_HISTORY.find((w) => w.versionId === versionId);
}
