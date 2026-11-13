// ============================================
// Unit tests: batch path through the helper (issue #172)
// ============================================
//
// A TEST-ONLY consumer builds a batch of provider requests from the helper's
// output. Shows (1) a switched-off chat and a non-qualifying person produce
// nothing, (2) only the qualifying chat's qualifying messages are in the request
// list, and (3) a switch turned off after the batch was built but before it is
// sent is caught by the re-check at send time and the request is dropped.
// No route exposes any of this.

import assert from "node:assert/strict";
import { before, beforeEach, describe, test } from "node:test";
import { ROLES } from "@durin-tech/authz";
import { installMessageAccessFakes, resetMessageAccess, seedApproval, seedChat, seedMessage, seedPlan } from "./harness";
import { aiMessageAccessService } from "../../src/services/ai-message-access.service";
import { messageAccessService, type AiMessageBatchItem, type MessageAccessPrincipal } from "../../src/services/message-access.service";

const admin: MessageAccessPrincipal = { uid: "uid-admin", role: ROLES.ADMIN, agencyId: null };

/** Test-only consumer: shapes helper output into provider-style requests. */
function toRequests(items: AiMessageBatchItem[]): { custom_id: string; texts: string[] }[] {
  return items.map((i) => ({ custom_id: i.conversationId, texts: i.messages.map((m) => m.content) }));
}

before(async () => {
  await installMessageAccessFakes();
});

beforeEach(() => {
  resetMessageAccess();
  // c-off: both qualify but the applicant switched the chat off.
  seedChat({ convId: "c-off", applicantUid: "app-off", agentUid: "ag-off", agentDocId: "agd-off", aiAccessOffUser: true });
  seedApproval("app-off");
  seedApproval("ag-off");
  // c-none: nobody qualifies.
  seedChat({ convId: "c-none", applicantUid: "app-none", agentUid: "ag-none", agentDocId: "agd-none" });
  // c-ok: only the applicant qualifies (plan), so only their messages may appear.
  seedChat({ convId: "c-ok", applicantUid: "app-ok", agentUid: "ag-ok", agentDocId: "agd-ok" });
  seedPlan("app-ok");
});

describe("batch built through the helper", () => {
  test("contains only the qualifying chat's qualifying messages", async () => {
    const items = await messageAccessService.buildAiMessageBatch(admin, ["c-off", "c-none", "c-ok", "c-missing"]);
    assert.deepEqual(toRequests(items), [{ custom_id: "c-ok", texts: ["applicant words", "applicant again"] }]);
  });

  test("duplicate ids do not duplicate a request", async () => {
    const items = await messageAccessService.buildAiMessageBatch(admin, ["c-ok", "c-ok"]);
    assert.equal(items.length, 1);
  });

  test("a chat switched off after the batch is built is dropped at send time", async () => {
    const built = await messageAccessService.buildAiMessageBatch(admin, ["c-ok"]);
    assert.equal(built.length, 1);
    // The applicant switches the chat off between build and send.
    await aiMessageAccessService.setChatSwitch("c-ok", "app-ok", null, true);
    const toSend = await messageAccessService.recheckAiMessageBatch(admin, built);
    assert.deepEqual(toRequests(toSend), []);
  });

  test("an unchanged chat survives the re-check with the same messages", async () => {
    const built = await messageAccessService.buildAiMessageBatch(admin, ["c-ok"]);
    const toSend = await messageAccessService.recheckAiMessageBatch(admin, built);
    assert.deepEqual(toRequests(toSend), toRequests(built));
  });

  test("approval withdrawn or account-wide off after build also drops the request", async () => {
    await aiMessageAccessService.approve("app-none", "ai-message-access-approval.draft-1");
    const built = await messageAccessService.buildAiMessageBatch(admin, ["c-ok", "c-none"]);
    assert.equal(built.length, 2);
    await aiMessageAccessService.revoke("app-none");
    await aiMessageAccessService.setAccountWideOff("app-ok", true);
    assert.deepEqual(await messageAccessService.recheckAiMessageBatch(admin, built), []);
  });

  test("a re-check only ever returns messages that were in the original item", async () => {
    const built = await messageAccessService.buildAiMessageBatch(admin, ["c-ok"]);
    const trimmed = [{ ...built[0], messages: built[0].messages.slice(0, 1) }];
    const out = await messageAccessService.recheckAiMessageBatch(admin, trimmed);
    assert.deepEqual(out[0].messages.map((m) => m.id), [built[0].messages[0].id]);
  });

  test("the re-check covers exactly what the build released, even past 200 messages and after the chat grew", async () => {
    for (let i = 0; i < 250; i++) seedMessage("c-ok", `big-${i}`, "app-ok", "user", `w${i}`, 100 + i);
    const built = await messageAccessService.buildAiMessageBatch(admin, ["c-ok"], 500);
    const builtCount = built[0].messages.length;
    assert.ok(builtCount > 200, "build used the larger window");
    // The chat gains newer messages after the build.
    for (let i = 0; i < 100; i++) seedMessage("c-ok", `late-${i}`, "app-ok", "user", `l${i}`, 5000 + i);
    const out = await messageAccessService.recheckAiMessageBatch(admin, built);
    assert.equal(out[0].messages.length, builtCount, "no older message silently lost at send time");
    assert.ok(out[0].messages.every((m) => !m.id.startsWith("late-")), "and no message the build did not release is added");
  });
});
