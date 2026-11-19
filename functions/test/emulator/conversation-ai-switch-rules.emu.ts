// ============================================
// Emulator test: conversation update allow-list and the retired switch fields (#172, #209)
// ============================================
//
// Run with `npm run test:emulator`. The repo's real firestore.rules through
// @firebase/rules-unit-testing. The per-chat AI switch was retired in #209 (the
// backend route is gone and the old fields are ignored), but the rules still
// refuse any client write of `aiAccessOffUser` / `aiAccessOffAgent`, and still
// allow a participant to update ONLY the allow-listed fields (the id-swap and
// allow-list cases below). Ordinary updates by a participant still work.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

import { clientDb, isDenied, resetEmulators, rulesEnv, withoutRules } from "./helpers";

/* eslint-disable @typescript-eslint/no-explicit-any */

const APPLICANT = "applicant-uid";
const AGENT_USER = "agent-user-uid";
const CONV = "conv-1";

before(async () => {
  await resetEmulators();
  await withoutRules(async (db) => {
    await db.collection("agents").doc("agent-doc-1").set({ userId: AGENT_USER, displayName: "A" });
    await db.collection("conversations").doc(CONV).set({
      id: CONV,
      userId: APPLICANT,
      agentId: "agent-doc-1",
      unreadCountUser: 0,
      unreadCountAgent: 0,
    });
  });
});

after(async () => {
  await (await rulesEnv()).cleanup();
});

describe("conversation ids are not client-writable; retired switch fields stay refused", () => {
  test("applicant cannot set or clear either switch field by update", async () => {
    const db = await clientDb(APPLICANT, { role: "client", agencyId: null });
    const ref = db.collection("conversations").doc(CONV);
    assert.equal(await isDenied(ref.update({ aiAccessOffUser: true })), true);
    assert.equal(await isDenied(ref.update({ aiAccessOffAgent: true })), true);
    assert.equal(await isDenied(ref.update({ aiAccessOffUser: false, unreadCountUser: 1 })), true);
  });

  test("agent cannot set either switch field by update", async () => {
    const db = await clientDb(AGENT_USER, { role: "agent", agencyId: null });
    const ref = db.collection("conversations").doc(CONV);
    assert.equal(await isDenied(ref.update({ aiAccessOffAgent: true })), true);
    assert.equal(await isDenied(ref.update({ aiAccessOffUser: true })), true);
  });

  test("a new conversation cannot be created carrying a switch value", async () => {
    const db = await clientDb(APPLICANT, { role: "client", agencyId: null });
    const ref = db.collection("conversations").doc("conv-new");
    assert.equal(await isDenied(ref.set({ id: "conv-new", userId: APPLICANT, agentId: "agent-doc-1", aiAccessOffAgent: true })), true);
  });

  test("a participant can still make an ordinary update", async () => {
    const db = await clientDb(APPLICANT, { role: "client", agencyId: null });
    assert.equal(await isDenied(db.collection("conversations").doc(CONV).update({ unreadCountUser: 5 })), false);
  });

  test("a participant cannot rewrite userId or agentId (the id-swap override attack)", async () => {
    // The AI access check resolves the two people of a chat from userId and
    // agentId, so a client must never be able to rewrite either one (for example
    // an agent writing their own uid into userId).
    const agent = await clientDb(AGENT_USER, { role: "agent", agencyId: null });
    const ref = agent.collection("conversations").doc(CONV);
    assert.equal(await isDenied(ref.update({ userId: AGENT_USER })), true);
    assert.equal(await isDenied(ref.update({ agentId: "agent-doc-other" })), true);
    // The applicant cannot repoint the agent side either.
    const applicant = await clientDb(APPLICANT, { role: "client", agencyId: null });
    assert.equal(await isDenied(applicant.collection("conversations").doc(CONV).update({ agentId: "x" })), true);
  });

  test("any field outside the allow-list is refused, even beside an allowed one", async () => {
    const db = await clientDb(APPLICANT, { role: "client", agencyId: null });
    const ref = db.collection("conversations").doc(CONV);
    assert.equal(await isDenied(ref.update({ lastMessage: "forged" })), true);
    // (A write that sets a field to the value it already has changes nothing, so it is
    // not a "changed key" and is allowed: use a field whose value really changes.)
    assert.equal(await isDenied(ref.update({ unreadCountUser: 0, lastMessage: "x" })), true);
    assert.equal(await isDenied(ref.update({ unreadCountUser: 0, userId: "someone-else" })), true);
    assert.equal(await isDenied(ref.update({ unreadCountUser: 0, aiAccessOffAgent: true })), true);
  });

  test("ids and switch fields were never changed", async () => {
    await withoutRules(async (db) => {
      const d = (await db.collection("conversations").doc(CONV).get()).data();
      assert.equal(d.userId, APPLICANT);
      assert.equal(d.agentId, "agent-doc-1");
    });
  });

  test("the switch fields were never written", async () => {
    await withoutRules(async (db) => {
      const d = (await db.collection("conversations").doc(CONV).get()).data();
      assert.equal(d.aiAccessOffUser, undefined);
      assert.equal(d.aiAccessOffAgent, undefined);
    });
  });
});
