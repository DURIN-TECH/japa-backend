// ============================================
// Unit tests: pinned wording (issue #172)
// ============================================
// Pins the text the design spec amendment requires, so a change is deliberate.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  APPROVAL_WORDING_HISTORY,
  CURRENT_APPROVAL_WORDING,
  CURRENT_NOTICE_WORDING,
  findApprovalWording,
  wordingText,
} from "../../src/services/message-access/wording";

describe("wording (approval draft-2, notice draft-1)", () => {
  test("current ids are approval draft-2 and notice draft-1, both marked draft", () => {
    assert.equal(CURRENT_APPROVAL_WORDING.versionId, "ai-message-access-approval.draft-2");
    assert.equal(CURRENT_NOTICE_WORDING.versionId, "ai-message-access-notice.draft-1");
    assert.equal(CURRENT_APPROVAL_WORDING.draft && CURRENT_NOTICE_WORDING.draft, true);
  });
  test("approval draft-2 is one short paragraph, exactly as dictated", () => {
    assert.deepEqual(CURRENT_APPROVAL_WORDING.paragraphs, [
      "Seli’s AI may read the messages I send in my chats. I can switch this off for all my chats, and withdraw this approval, at any time.",
    ]);
  });
  test("draft-1 stays in the history with its original text", () => {
    const d1 = findApprovalWording("ai-message-access-approval.draft-1");
    assert.ok(d1);
    assert.equal(APPROVAL_WORDING_HISTORY[0], d1);
    assert.equal(d1.paragraphs.length, 4);
    assert.ok(d1.paragraphs[0].startsWith("I agree that Seli’s AI may read and analyse"));
    assert.ok(wordingText(d1).includes("for all my chats at once"));
  });
  test("approval wording never states retention, provider terms or redaction (#128)", () => {
    assert.doesNotMatch(wordingText(CURRENT_APPROVAL_WORDING), /retain|retention|provider|redact|days|stored for/i);
  });
  test("notice note line matches the amendment", () => {
    assert.equal(
      CURRENT_NOTICE_WORDING.note,
      "You’ll find this switch at the top of every chat. To keep AI out of all your chats at once, go to AI message access in your settings."
    );
  });
});
