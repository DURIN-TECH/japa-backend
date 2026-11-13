// ============================================
// Unit tests: the shared message-access helper (issue #172)
// ============================================
//
// The helper over the in-memory Firestore. State changes go through the REAL
// settings service (approve, revoke, switch, account-wide) so the tests prove
// the rule reads what the writes produce, with nothing cached in between.

import assert from "node:assert/strict";
import { before, beforeEach, describe, test } from "node:test";
import { Timestamp } from "firebase-admin/firestore";
import { ROLES } from "@durin-tech/authz";
import { store } from "../helpers/fake-firestore";
import {
  AGENT_DOC, AGENT_USER, APPLICANT, CONV,
  installMessageAccessFakes, resetMessageAccess, seedAccountWideOff, seedApproval, seedChat, seedMessage, seedPlan, setRole,
} from "./harness";
import { aiMessageAccessService } from "../../src/services/ai-message-access.service";
import { messageAccessService, type MessageAccessPrincipal } from "../../src/services/message-access.service";
import { CURRENT_APPROVAL_WORDING } from "../../src/services/message-access/wording";

const asApplicant: MessageAccessPrincipal = { uid: APPLICANT, role: ROLES.CLIENT, agencyId: null };
const asAgent: MessageAccessPrincipal = { uid: AGENT_USER, role: ROLES.AGENT, agencyId: null };
const asAdmin: MessageAccessPrincipal = { uid: "uid-admin", role: ROLES.ADMIN, agencyId: null };

/** Message ids the helper released, in order. */
async function released(principal: MessageAccessPrincipal = asAdmin, convId = CONV): Promise<string[]> {
  return (await messageAccessService.getMessagesForAi(convId, principal)).map((m) => m.id);
}

before(async () => {
  await installMessageAccessFakes();
});
beforeEach(() => {
  resetMessageAccess();
  seedChat();
});

const BOTH = ["m-app-1", "m-agent-1", "m-app-2"];
const APPLICANT_ONLY = ["m-app-1", "m-app-2"];
const AGENT_ONLY = ["m-agent-1"];

describe("rule through the helper (state built with the real writers)", () => {
  test("neither approval nor plan: nothing", async () => {
    assert.deepEqual(await released(), []);
  });

  test("approval only (both): both people's messages", async () => {
    await aiMessageAccessService.approve(APPLICANT, CURRENT_APPROVAL_WORDING.versionId);
    await aiMessageAccessService.approve(AGENT_USER, CURRENT_APPROVAL_WORDING.versionId);
    assert.deepEqual(await released(), BOTH);
  });

  test("plan only (both): both people's messages", async () => {
    seedPlan(APPLICANT);
    seedPlan(AGENT_USER);
    assert.deepEqual(await released(), BOTH);
  });

  test("approval and plan together: still just their own messages, once", async () => {
    seedApproval(APPLICANT);
    seedPlan(APPLICANT);
    assert.deepEqual(await released(), APPLICANT_ONLY);
  });

  test("lapsed plan: nothing from that person", async () => {
    seedPlan(APPLICANT, "past_due");
    assert.deepEqual(await released(), []);
  });

  test("plan without the AI feature: nothing", async () => {
    seedPlan(APPLICANT, "active", false);
    assert.deepEqual(await released(), []);
  });

  test("unresolved entitlements (no document): nothing", async () => {
    // No entitlement doc, no approval: fail closed.
    assert.deepEqual(await released(), []);
  });

  test("revoked approval: stops counting from that moment", async () => {
    await aiMessageAccessService.approve(APPLICANT, CURRENT_APPROVAL_WORDING.versionId);
    assert.deepEqual(await released(), APPLICANT_ONLY);
    await aiMessageAccessService.revoke(APPLICANT);
    assert.deepEqual(await released(), []);
    // Approving again works and creates a new record.
    await aiMessageAccessService.approve(APPLICANT, CURRENT_APPROVAL_WORDING.versionId);
    assert.deepEqual(await released(), APPLICANT_ONLY);
  });

  test("one qualifying person: the other person's messages are not in the output", async () => {
    seedApproval(APPLICANT);
    assert.deepEqual(await released(), APPLICANT_ONLY);
    resetMessageAccess();
    seedChat();
    seedPlan(AGENT_USER);
    assert.deepEqual(await released(), AGENT_ONLY);
  });

  test("switched off by the applicant, by the agent, by both then back on by one (stays off)", async () => {
    seedApproval(APPLICANT);
    seedApproval(AGENT_USER);
    assert.deepEqual(await released(), BOTH);

    await aiMessageAccessService.setChatSwitch(CONV, APPLICANT, null, true);
    assert.deepEqual(await released(), [], "applicant off");
    await aiMessageAccessService.setChatSwitch(CONV, APPLICANT, null, false);
    assert.deepEqual(await released(), BOTH, "applicant back on");

    await aiMessageAccessService.setChatSwitch(CONV, AGENT_USER, AGENT_DOC, true);
    assert.deepEqual(await released(), [], "agent off");

    await aiMessageAccessService.setChatSwitch(CONV, APPLICANT, null, true); // both off
    await aiMessageAccessService.setChatSwitch(CONV, APPLICANT, null, false); // applicant back on
    assert.deepEqual(await released(), [], "agent still off: stays off");
    await aiMessageAccessService.setChatSwitch(CONV, AGENT_USER, AGENT_DOC, false);
    assert.deepEqual(await released(), BOTH, "both on again");
  });

  test("a person who does not qualify can still switch their side off, and it holds back the other's messages", async () => {
    seedApproval(APPLICANT); // agent has neither approval nor plan
    assert.deepEqual(await released(), APPLICANT_ONLY);
    await aiMessageAccessService.setChatSwitch(CONV, AGENT_USER, AGENT_DOC, true);
    assert.deepEqual(await released(), [], "agent (not qualifying) switched off: nothing is released");
  });

  describe("account-wide off", () => {
    test("plan + account-wide off: nothing", async () => {
      seedPlan(APPLICANT);
      await aiMessageAccessService.setAccountWideOff(APPLICANT, true);
      assert.deepEqual(await released(), []);
    });
    test("approval + account-wide off: nothing, then back on: per-chat switches apply as before", async () => {
      seedApproval(APPLICANT);
      seedApproval(AGENT_USER);
      await aiMessageAccessService.setAccountWideOff(APPLICANT, true);
      assert.deepEqual(await released(), [], "off");
      await aiMessageAccessService.setAccountWideOff(APPLICANT, false);
      assert.deepEqual(await released(), BOTH, "back on, chat switch untouched (on)");
      await aiMessageAccessService.setChatSwitch(CONV, AGENT_USER, AGENT_DOC, true);
      await aiMessageAccessService.setAccountWideOff(APPLICANT, true);
      await aiMessageAccessService.setAccountWideOff(APPLICANT, false);
      assert.deepEqual(await released(), [], "the agent's chat switch still applies");
    });
    test("applies to a chat created AFTER the setting (new chats)", async () => {
      seedApproval(APPLICANT);
      await aiMessageAccessService.setAccountWideOff(APPLICANT, true);
      seedChat({ convId: "conv-new" });
      assert.deepEqual(await released(asAdmin, "conv-new"), []);
    });
    test("the other person's account-wide off blocks the whole chat", async () => {
      seedApproval(APPLICANT);
      seedAccountWideOff(AGENT_USER);
      assert.deepEqual(await released(), []);
    });
  });

  test("agent covered by an agency plan counts as subscribed", async () => {
    resetMessageAccess();
    seedChat({ agencyId: "agency-a" });
    seedPlan("agency-a"); // entitlements are keyed by the agency, not the agent
    assert.deepEqual(await released(), AGENT_ONLY);
  });
});

describe("read-time evaluation", () => {
  test("messages sent before approval are released once the rule holds now", async () => {
    // All three messages pre-date the approval below (createdAt 10/20/30).
    assert.deepEqual(await released(), []);
    seedApproval(APPLICANT); // grantedAt 5ms is irrelevant: nothing is stored per message
    store.set(`aiMessageAccess/${APPLICANT}`, {
      ...store.get(`aiMessageAccess/${APPLICANT}`)!,
      approval: { ...(store.get(`aiMessageAccess/${APPLICANT}`)!.approval as object), grantedAt: Timestamp.fromMillis(99999) },
    });
    assert.deepEqual(await released(), APPLICANT_ONLY, "older messages follow today's state");
  });

  test("a switch takes effect on the very next call", async () => {
    seedApproval(APPLICANT);
    assert.deepEqual(await released(), APPLICANT_ONLY);
    await aiMessageAccessService.setChatSwitch(CONV, APPLICANT, null, true);
    assert.deepEqual(await released(), []);
  });
});

describe("who may ask", () => {
  beforeEach(() => {
    seedApproval(APPLICANT);
    seedApproval(AGENT_USER);
  });

  test("participants and admin get the chat", async () => {
    assert.deepEqual(await released(asApplicant), BOTH);
    assert.deepEqual(await released(asAgent), BOTH);
    assert.deepEqual(await released(asAdmin), BOTH);
  });

  test("owner of the agent's own agency gets it", async () => {
    resetMessageAccess();
    seedChat({ agencyId: "agency-a" });
    seedApproval(APPLICANT);
    seedApproval(AGENT_USER);
    assert.deepEqual(await released({ uid: "uid-owner-a", role: ROLES.OWNER, agencyId: "agency-a" }), BOTH);
    assert.deepEqual(await released({ uid: "uid-agent-a2", role: ROLES.AGENT, agencyId: "agency-a" }), BOTH);
  });

  test("owner or agent of agency B gets nothing for an agency A chat", async () => {
    resetMessageAccess();
    seedChat({ agencyId: "agency-a" });
    seedApproval(APPLICANT);
    seedApproval(AGENT_USER);
    setRole("uid-owner-b", ROLES.OWNER, "agency-b");
    assert.deepEqual(await released({ uid: "uid-owner-b", role: ROLES.OWNER, agencyId: "agency-b" }), []);
    assert.deepEqual(await released({ uid: "uid-agent-b1", role: ROLES.AGENT, agencyId: "agency-b" }), []);
  });

  test("a stranger client, an independent agent with no agency, and a missing principal get nothing", async () => {
    assert.deepEqual(await released({ uid: "uid-other-client", role: ROLES.CLIENT, agencyId: null }), []);
    assert.deepEqual(await released({ uid: "uid-indep", role: ROLES.AGENT, agencyId: null }), []);
    assert.deepEqual(await released({ uid: "", role: ROLES.ADMIN, agencyId: null }), []);
  });

  test("an independent-agent chat is not reachable through a null/undefined agency match", async () => {
    // agent doc has no agencyId; a principal with agencyId null must not match undefined.
    assert.deepEqual(await released({ uid: "uid-x", role: ROLES.OWNER, agencyId: null }), []);
  });
});

describe("fail closed", () => {
  beforeEach(() => {
    seedApproval(APPLICANT);
    seedApproval(AGENT_USER);
  });

  test("missing conversation", async () => {
    assert.deepEqual(await released(asAdmin, "nope"), []);
  });

  test("missing agent document", async () => {
    store.delete(`agents/${AGENT_DOC}`);
    assert.deepEqual(await released(), []);
  });

  test("a failed entitlement/approval read returns nothing (and never throws)", async () => {
    const orig = aiMessageAccessService.getRecord;
    aiMessageAccessService.getRecord = async () => { throw new Error("boom"); };
    try {
      assert.deepEqual(await released(), []);
    } finally {
      aiMessageAccessService.getRecord = orig;
    }
  });

  test("a message from someone who is neither participant is never released", async () => {
    seedMessage(CONV, "m-stranger", "uid-stranger", "user", "intruder", 40);
    assert.ok(!(await released()).includes("m-stranger"));
  });

  test("filters by senderId, not by the senderType label", async () => {
    // Mislabelled: sent by the agent's uid but typed "user". Still the agent's message.
    seedMessage(CONV, "m-mislabel", AGENT_USER, "user", "label lies", 50);
    store.set(`aiMessageAccess/${AGENT_USER}`, { userId: AGENT_USER, accountWideOff: false, updatedAt: Timestamp.now() }); // agent loses approval
    assert.ok(!(await released()).includes("m-mislabel"));
    assert.ok((await released()).includes("m-app-1"));
  });
});
