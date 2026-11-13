// ============================================
// Unit tests: pinned wording (issue #172)
// ============================================
// Pins the text the design spec amendment requires, so a change is deliberate.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { CURRENT_APPROVAL_WORDING, CURRENT_NOTICE_WORDING, wordingText } from "../../src/services/message-access/wording";

describe("wording (draft-1, amended)", () => {
  test("version ids are unchanged and marked draft", () => {
    assert.equal(CURRENT_APPROVAL_WORDING.versionId, "ai-message-access-approval.draft-1");
    assert.equal(CURRENT_NOTICE_WORDING.versionId, "ai-message-access-notice.draft-1");
    assert.equal(CURRENT_APPROVAL_WORDING.draft && CURRENT_NOTICE_WORDING.draft, true);
  });
  test("approval paragraph 3 matches the amendment exactly", () => {
    assert.equal(
      CURRENT_APPROVAL_WORDING.paragraphs[2],
      "I can switch AI access off or on for any chat, or for all my chats at once, at any time. The other person in a chat can switch it off for that chat too. While a chat is switched off, nothing in it is read."
    );
    assert.equal(CURRENT_APPROVAL_WORDING.paragraphs.length, 4);
    assert.ok(wordingText(CURRENT_APPROVAL_WORDING).includes("for all my chats at once"));
  });
  test("notice note line matches the amendment", () => {
    assert.equal(
      CURRENT_NOTICE_WORDING.note,
      "You’ll find this switch at the top of every chat. To keep AI out of all your chats at once, go to AI message access in your settings."
    );
  });
});
