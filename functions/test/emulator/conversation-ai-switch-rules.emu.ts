// ============================================
// Emulator test: clients cannot write the AI chat switch directly (issue #172)
// ============================================
//
// Run with `npm run test:emulator`. The repo's real firestore.rules through
// @firebase/rules-unit-testing. The per-side AI switch on a conversation
// (`aiAccessOffUser` / `aiAccessOffAgent`) may only be written by the backend
// (PUT /conversations/:id/ai-access), which enforces "own side only" and writes
// the audit record. A participant who writes the field from a client SDK is
// refused, whether by update, create or deleting the field; ordinary updates by
// a participant still work.

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

describe("conversation AI switch is backend-only", () => {
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

  test("the switch fields were never written", async () => {
    await withoutRules(async (db) => {
      const d = (await db.collection("conversations").doc(CONV).get()).data();
      assert.equal(d.aiAccessOffUser, undefined);
      assert.equal(d.aiAccessOffAgent, undefined);
    });
  });
});
