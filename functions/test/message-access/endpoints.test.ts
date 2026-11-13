// ============================================
// Unit tests: AI message access endpoints (issue #172)
// ============================================
//
// The real controllers and services over the in-memory Firestore; request and
// response are plain objects (no HTTP server). Covers: own-data-only (403 and no
// change), the approval record (exact server-side wording, version check),
// revoke and re-approve, the account-wide setting, the notice dismissal, the
// per-chat switch (participant-only, own side only, 404/403), the conversation
// response (own state, yes/no for the other side, nothing of the other person's
// approval or plan, no raw per-side fields), and the audit trail (written for
// every change, append-only, admin-only route).

import assert from "node:assert/strict";
import { before, beforeEach, describe, test } from "node:test";
import { ROLES } from "@durin-tech/authz";
import { store } from "../helpers/fake-firestore";
import {
  AGENT_USER, APPLICANT, CONV,
  auditRows, installMessageAccessFakes, resetMessageAccess, seedApproval, seedChat, seedPlan,
} from "./harness";
import { aiMessageAccessController } from "../../src/controllers/ai-message-access.controller";
import { getConversation, listConversations, setAiAccess } from "../../src/controllers/messaging.controller";
import { adminUsersRouter, userRoutes } from "../../src/routes/user.routes";
import { verifyAdmin } from "../../src/middleware/auth";
import { CURRENT_APPROVAL_WORDING, CURRENT_NOTICE_WORDING, wordingText } from "../../src/services/message-access/wording";

/* eslint-disable @typescript-eslint/no-explicit-any */

/** A response that records what the handler sent. */
function mockRes() {
  const res: any = { statusCode: 200, body: undefined };
  res.status = (c: number) => ((res.statusCode = c), res);
  res.json = (b: unknown) => ((res.body = b), res);
  return res;
}

/** A request from `uid` (role client unless given). */
function req(uid: string, over: Record<string, unknown> = {}, role: string = ROLES.CLIENT): any {
  return { userId: uid, authz: { uid, role, agencyId: null }, body: {}, query: {}, params: {}, ip: "203.0.113.9", ...over };
}
const agentReq = (over: Record<string, unknown> = {}) => req(AGENT_USER, over, ROLES.AGENT);

/** Snapshot of the whole fake store, to prove a refused call changed nothing. */
const snapshot = () => JSON.stringify([...store.entries()]);

before(async () => {
  await installMessageAccessFakes();
});
beforeEach(() => {
  resetMessageAccess();
  seedChat();
});

describe("own approval: read and change", () => {
  test("GET returns the caller's state and the current wording", async () => {
    const res = mockRes();
    await aiMessageAccessController.getState(req(APPLICANT), res);
    assert.equal(res.statusCode, 200);
    const d = res.body.data;
    assert.equal(d.approved, false);
    assert.equal(d.hasAiPlan, false);
    assert.equal(d.qualifies, false);
    assert.equal(d.planOnly, false);
    assert.equal(d.accountWideOff, false);
    assert.equal(d.noticeDismissed, false);
    assert.equal(d.currentApprovalWording.versionId, CURRENT_APPROVAL_WORDING.versionId);
    assert.equal(d.currentApprovalWording.text, wordingText(CURRENT_APPROVAL_WORDING));
    assert.equal(d.currentApprovalWording.draft, true);
    assert.equal(d.noticeWording.versionId, CURRENT_NOTICE_WORDING.versionId);
  });

  test("an approval stored under draft-1 stays active and keeps its stored version and text (#193)", async () => {
    seedApproval(APPLICANT);
    const res = mockRes();
    await aiMessageAccessController.getState(req(APPLICANT), res);
    assert.equal(res.body.data.approved, true);
    assert.equal(res.body.data.wordingVersion, "ai-message-access-approval.draft-1");
    assert.equal(res.body.data.wording, "x"); // the seeded stored text, not the current wording
    assert.notEqual(res.body.data.wordingVersion, CURRENT_APPROVAL_WORDING.versionId);
  });

  test("approve stores user, time, version and the EXACT server-side wording, even if the client sends other text", async () => {
    const res = mockRes();
    await aiMessageAccessController.approve(
      req(APPLICANT, { body: { wordingVersion: CURRENT_APPROVAL_WORDING.versionId, wording: "client forged text", userId: APPLICANT } }),
      res
    );
    assert.equal(res.statusCode, 200);
    const rec: any = store.get(`aiMessageAccess/${APPLICANT}`);
    assert.equal(rec.approval.userId, APPLICANT);
    assert.equal(rec.approval.wordingVersion, CURRENT_APPROVAL_WORDING.versionId);
    assert.equal(rec.approval.wording, wordingText(CURRENT_APPROVAL_WORDING));
    assert.ok(rec.approval.grantedAt);
    assert.equal(rec.approval.revokedAt, undefined);
    assert.equal(res.body.data.approved, true);
    assert.equal(res.body.data.wording, wordingText(CURRENT_APPROVAL_WORDING));
  });

  test("approve with an unknown or stale version: 409 and nothing stored; missing version: 400", async () => {
    let res = mockRes();
    await aiMessageAccessController.approve(req(APPLICANT, { body: { wordingVersion: "ai-message-access-approval.draft-1" } }), res);
    assert.equal(res.statusCode, 409);
    assert.equal(res.body.error, "WORDING_VERSION_MISMATCH");
    assert.equal(store.has(`aiMessageAccess/${APPLICANT}`), false);
    assert.equal(auditRows().length, 0);
    res = mockRes();
    await aiMessageAccessController.approve(req(APPLICANT, { body: {} }), res);
    assert.equal(res.statusCode, 400);
  });

  test("a request naming another user id (body or query) is refused with 403 and changes nothing", async () => {
    const before = snapshot();
    for (const handler of ["getState", "approve", "revoke", "setAccountWideOff", "dismissNotice"] as const) {
      for (const where of ["body", "query"] as const) {
        const res = mockRes();
        const r = req(APPLICANT, {
          body: { wordingVersion: CURRENT_APPROVAL_WORDING.versionId, off: true },
          query: {},
        });
        r[where] = { ...r[where], userId: AGENT_USER };
        await (aiMessageAccessController as any)[handler](r, res);
        assert.equal(res.statusCode, 403, `${handler} via ${where}`);
      }
    }
    assert.equal(snapshot(), before, "nothing was written");
  });

  test("revoke stops the approval from counting; approving again creates a new record", async () => {
    await aiMessageAccessController.approve(req(APPLICANT, { body: { wordingVersion: CURRENT_APPROVAL_WORDING.versionId } }), mockRes());
    const first: any = (store.get(`aiMessageAccess/${APPLICANT}`) as any).approval;
    const res = mockRes();
    await aiMessageAccessController.revoke(req(APPLICANT), res);
    assert.equal(res.body.data.approved, false);
    assert.equal(res.body.data.wording, null);
    assert.ok((store.get(`aiMessageAccess/${APPLICANT}`) as any).approval.revokedAt, "old record stamped revoked");

    await aiMessageAccessController.approve(req(APPLICANT, { body: { wordingVersion: CURRENT_APPROVAL_WORDING.versionId } }), mockRes());
    const second: any = (store.get(`aiMessageAccess/${APPLICANT}`) as any).approval;
    assert.equal(second.revokedAt, undefined, "the new record is not revoked");
    assert.notEqual(second.grantedAt, undefined);
    assert.ok(second.grantedAt.toMillis() >= first.grantedAt.toMillis());
    assert.deepEqual(auditRows().map((r) => r.action), ["approval_granted", "approval_revoked", "approval_granted"]);
  });

  test("approving twice does not duplicate the record or the audit row; revoking when not approved is a no-op", async () => {
    await aiMessageAccessController.revoke(req(APPLICANT), mockRes());
    assert.equal(auditRows().length, 0);
    for (let i = 0; i < 2; i++) {
      await aiMessageAccessController.approve(req(APPLICANT, { body: { wordingVersion: CURRENT_APPROVAL_WORDING.versionId } }), mockRes());
    }
    assert.equal(auditRows().length, 1);
  });

  test("plan-only is reported (plan, no approval)", async () => {
    seedPlan(APPLICANT);
    const res = mockRes();
    await aiMessageAccessController.getState(req(APPLICANT), res);
    assert.equal(res.body.data.hasAiPlan, true);
    assert.equal(res.body.data.planOnly, true);
    assert.equal(res.body.data.qualifies, true);
  });
});

describe("account-wide off and the one-time notice", () => {
  test("setting it on and off is audited, validated, and visible in the state", async () => {
    let res = mockRes();
    await aiMessageAccessController.setAccountWideOff(req(APPLICANT, { body: { off: "yes" } }), res);
    assert.equal(res.statusCode, 400);
    res = mockRes();
    await aiMessageAccessController.setAccountWideOff(req(APPLICANT, { body: { off: true } }), res);
    assert.equal(res.body.data.accountWideOff, true);
    await aiMessageAccessController.setAccountWideOff(req(APPLICANT, { body: { off: true } }), mockRes()); // unchanged
    res = mockRes();
    await aiMessageAccessController.setAccountWideOff(req(APPLICANT, { body: { off: false } }), res);
    assert.equal(res.body.data.accountWideOff, false);
    assert.deepEqual(auditRows().map((r) => [r.action, r.newValue]), [["account_wide_off_enabled", true], ["account_wide_off_disabled", false]]);
  });

  test("dismissal is stored on the server and survives (another device reads the same state)", async () => {
    seedPlan(APPLICANT);
    const res = mockRes();
    await aiMessageAccessController.dismissNotice(req(APPLICANT), res);
    assert.equal(res.body.data.noticeDismissed, true);
    const again = mockRes();
    await aiMessageAccessController.getState(req(APPLICANT), again);
    assert.equal(again.body.data.noticeDismissed, true);
    assert.equal((store.get(`aiMessageAccess/${APPLICANT}`) as any).noticeDismissedVersion, CURRENT_NOTICE_WORDING.versionId);
  });

  test("a dismissal does not erase an approval", async () => {
    seedApproval(APPLICANT);
    await aiMessageAccessController.dismissNotice(req(APPLICANT), mockRes());
    const res = mockRes();
    await aiMessageAccessController.getState(req(APPLICANT), res);
    assert.equal(res.body.data.approved, true);
  });
});

describe("per-chat switch", () => {
  test("applicant switches own side only; the agent's side is untouched; audit says who/what/which chat", async () => {
    const res = mockRes();
    await setAiAccess(req(APPLICANT, { params: { id: CONV }, body: { off: true } }), res);
    assert.equal(res.statusCode, 200);
    const conv: any = store.get(`conversations/${CONV}`);
    assert.equal(conv.aiAccessOffUser, true);
    assert.equal(conv.aiAccessOffAgent, undefined);
    assert.deepEqual(auditRows().map((r) => ({ a: r.actorUid, act: r.action, c: r.conversationId, s: r.side, v: r.newValue })), [
      { a: APPLICANT, act: "chat_switched_off", c: CONV, s: "user", v: true },
    ]);
  });

  test("agent switches own side only", async () => {
    await setAiAccess(agentReq({ params: { id: CONV }, body: { off: true } }), mockRes());
    const conv: any = store.get(`conversations/${CONV}`);
    assert.equal(conv.aiAccessOffAgent, true);
    assert.equal(conv.aiAccessOffUser, undefined);
  });

  test("a participant can never change the other side, even by naming it in the body", async () => {
    await setAiAccess(req(APPLICANT, { params: { id: CONV }, body: { off: true, side: "agent", aiAccessOffAgent: true } }), mockRes());
    const conv: any = store.get(`conversations/${CONV}`);
    assert.equal(conv.aiAccessOffAgent, undefined);
    // Switching back on only undoes the caller's own side.
    await setAiAccess(agentReq({ params: { id: CONV }, body: { off: true } }), mockRes());
    await setAiAccess(req(APPLICANT, { params: { id: CONV }, body: { off: false } }), mockRes());
    const after: any = store.get(`conversations/${CONV}`);
    assert.equal(after.aiAccessOffUser, false);
    assert.equal(after.aiAccessOffAgent, true, "the agent's switch stays off");
  });

  test("a non-participant gets 403 and nothing changes; an unknown id gets 404; a bad body gets 400", async () => {
    const before = snapshot();
    let res = mockRes();
    await setAiAccess(req("uid-stranger", { params: { id: CONV }, body: { off: true } }), res);
    assert.equal(res.statusCode, 403);
    res = mockRes();
    await setAiAccess(req("uid-stranger", { params: { id: "no-such" }, body: { off: true } }), res);
    assert.equal(res.statusCode, 404);
    res = mockRes();
    await setAiAccess(req(APPLICANT, { params: { id: CONV }, body: { off: "no" } }), res);
    assert.equal(res.statusCode, 400);
    assert.equal(snapshot(), before);
  });

  test("an agent of another agency who is not a participant is refused", async () => {
    store.set("agents/agent-doc-b", { id: "agent-doc-b", userId: "uid-agent-b", agencyId: "agency-b" });
    const res = mockRes();
    await setAiAccess(req("uid-agent-b", { params: { id: CONV }, body: { off: true } }, ROLES.AGENT), res);
    assert.equal(res.statusCode, 403);
    assert.equal((store.get(`conversations/${CONV}`) as any).aiAccessOffAgent, undefined);
  });

  test("a caller who matches BOTH sides (id-swap) changes only the applicant side, never the other", async () => {
    // The attack state: the agent has written their own uid into conv.userId.
    store.set(`conversations/${CONV}`, { ...(store.get(`conversations/${CONV}`) as object), userId: AGENT_USER, aiAccessOffUser: true });
    await setAiAccess(agentReq({ params: { id: CONV }, body: { off: false } }), mockRes());
    const conv: any = store.get(`conversations/${CONV}`);
    // One side only: the applicant-side field is the one the caller matched first,
    // and the agent side is untouched (no both-sides write).
    assert.equal(conv.aiAccessOffAgent, undefined);
    assert.equal(auditRows().length, 1);
  });

  test("switching to the value it already has writes no audit row", async () => {
    await setAiAccess(req(APPLICANT, { params: { id: CONV }, body: { off: false } }), mockRes());
    assert.equal(auditRows().length, 0);
  });

  test("works for a person who does not qualify (owner decision)", async () => {
    const res = mockRes();
    await setAiAccess(req(APPLICANT, { params: { id: CONV }, body: { off: true } }), res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.data.aiAccess.qualifies, false);
    assert.equal(res.body.data.aiAccess.myAiAccess, "off");
  });
});

describe("conversation response", () => {
  test("own state, yes/no for the other side, qualifies; no raw fields; nothing of the other person's approval or plan", async () => {
    seedApproval(AGENT_USER);
    seedPlan(AGENT_USER);
    seedPlan(APPLICANT);
    await setAiAccess(agentReq({ params: { id: CONV }, body: { off: true } }), mockRes());

    const res = mockRes();
    await getConversation(req(APPLICANT, { params: { id: CONV } }), res);
    const d = res.body.data;
    assert.deepEqual(d.aiAccess, {
      myAiAccess: "on",
      myChatSwitchOff: false,
      accountWideOff: false,
      otherSwitchedOff: true,
      qualifies: true,
    });
    assert.equal("aiAccessOffUser" in d, false);
    assert.equal("aiAccessOffAgent" in d, false);
    const text = JSON.stringify(d);
    assert.ok(!text.includes("wordingVersion") && !text.includes("approval") && !text.includes("entitlement"));
  });

  test("account-wide off reads as off for me, and as 'the other person switched off' for them", async () => {
    await aiMessageAccessController.setAccountWideOff(req(APPLICANT, { body: { off: true } }), mockRes());
    const mine = mockRes();
    await getConversation(req(APPLICANT, { params: { id: CONV } }), mine);
    assert.equal(mine.body.data.aiAccess.myAiAccess, "off");
    assert.equal(mine.body.data.aiAccess.myChatSwitchOff, false);
    assert.equal(mine.body.data.aiAccess.accountWideOff, true);
    const theirs = mockRes();
    await getConversation(agentReq({ params: { id: CONV } }), theirs);
    assert.equal(theirs.body.data.aiAccess.otherSwitchedOff, true);
    assert.equal(theirs.body.data.aiAccess.myAiAccess, "on");
  });

  test("`qualifies` comes from the database-resolved plan, not the token claims", async () => {
    seedPlan(APPLICANT); // the DB says this client has an AI plan
    const res = mockRes();
    // Token claims say admin (no plan): a stale token must not change the label.
    await getConversation(req(APPLICANT, { params: { id: CONV } }, ROLES.ADMIN), res);
    assert.equal(res.body.data.aiAccess.qualifies, true);
  });

  test("an old conversation with no switch fields reads as on", async () => {
    const res = mockRes();
    await getConversation(req(APPLICANT, { params: { id: CONV } }), res);
    assert.equal(res.body.data.aiAccess.myAiAccess, "on");
    assert.equal(res.body.data.aiAccess.otherSwitchedOff, false);
  });

  test("GET /conversations/:id: 404 unknown, 403 stranger", async () => {
    let res = mockRes();
    await getConversation(req(APPLICANT, { params: { id: "nope" } }), res);
    assert.equal(res.statusCode, 404);
    res = mockRes();
    await getConversation(req("uid-stranger", { params: { id: CONV } }), res);
    assert.equal(res.statusCode, 403);
  });

  test("the list carries the same view and strips the raw fields", async () => {
    await setAiAccess(req(APPLICANT, { params: { id: CONV }, body: { off: true } }), mockRes());
    store.set(`users/${APPLICANT}`, { firstName: "A", lastName: "B", email: "delivered+applicant@resend.dev" });
    const res = mockRes();
    await listConversations(req(APPLICANT), res);
    assert.equal(res.statusCode, 200);
    const [c] = res.body.data;
    assert.equal(c.aiAccess.myAiAccess, "off");
    assert.equal(c.aiAccess.myChatSwitchOff, true);
    assert.equal("aiAccessOffUser" in c, false);
    assert.equal("aiAccessOffAgent" in c, false);
  });
});

describe("audit trail", () => {
  test("every approval, revoke, switch and account-wide change writes who/what/which chat/new value/time", async () => {
    await aiMessageAccessController.approve(req(APPLICANT, { body: { wordingVersion: CURRENT_APPROVAL_WORDING.versionId } }), mockRes());
    await aiMessageAccessController.revoke(req(APPLICANT), mockRes());
    await setAiAccess(req(APPLICANT, { params: { id: CONV }, body: { off: true } }), mockRes());
    await setAiAccess(req(APPLICANT, { params: { id: CONV }, body: { off: false } }), mockRes());
    await aiMessageAccessController.setAccountWideOff(req(APPLICANT, { body: { off: true } }), mockRes());
    const rows = auditRows();
    assert.deepEqual(rows.map((r) => r.action), [
      "approval_granted", "approval_revoked", "chat_switched_off", "chat_switched_on", "account_wide_off_enabled",
    ]);
    for (const r of rows) {
      assert.equal(r.actorUid, APPLICANT);
      assert.equal(r.subjectUid, APPLICANT);
      assert.equal(typeof r.newValue, "boolean");
      assert.ok(r.createdAt && r.id);
    }
    assert.equal(rows[0].wordingVersion, CURRENT_APPROVAL_WORDING.versionId);
    assert.equal(rows[2].conversationId, CONV);
  });

  test("the admin read route is behind verifyAdmin, and nothing can edit or delete audit rows", () => {
    // The audit route on the admin router: GET only, with verifyAdmin in its stack.
    const layers = (adminUsersRouter as any).stack.filter((l: any) => l.route?.path?.includes("ai-message-access-audit"));
    assert.equal(layers.length, 1);
    assert.deepEqual(Object.keys(layers[0].route.methods), ["get"]);
    assert.ok(layers[0].route.stack.some((s: any) => s.handle === verifyAdmin));
    // No route anywhere on the user router mentions the audit trail (so no write path).
    const userAudit = (userRoutes as any).stack.filter((l: any) => String(l.route?.path ?? "").includes("audit"));
    assert.equal(userAudit.length, 0);
  });

  test("admin route returns the person's rows (ordered by time, newest first)", async () => {
    await aiMessageAccessController.setAccountWideOff(req(APPLICANT, { body: { off: true } }), mockRes());
    await aiMessageAccessController.setAccountWideOff(req(APPLICANT, { body: { off: false } }), mockRes());
    const res = mockRes();
    await aiMessageAccessController.listAudit({ params: { uid: APPLICANT }, query: {} } as any, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.data.length, 2);
    // Both writes can land in the same millisecond, so assert the set and the order key.
    assert.deepEqual(res.body.data.map((r: any) => r.action).sort(), ["account_wide_off_disabled", "account_wide_off_enabled"]);
    assert.ok(res.body.data[0].createdAt.toMillis() >= res.body.data[1].createdAt.toMillis());
  });
});
