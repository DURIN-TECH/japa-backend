// ============================================
// Unit tests — the agent consultation fee in US dollars (issue #179), hermetic
// ============================================
// (Was the #148 naira-marker suite; the marker and the naira fee are gone.)
//  - createAgent starts at $0.00 (or the validated fee), writes no naira field
//    and no #148 marker;
//  - updateAgent writes the dollar Money, REMOVES the old naira fee and its
//    marker (replace, not shadow), and refuses a bad value or an old naira
//    key with nothing written;
//  - an agent can only change their OWN fee: PUT /agents/me resolves the
//    agent from the token, never from the body;
//  (The guest-booking checks that lived here moved to
//  test/consultations/consultation-charge.test.ts with issue #180.)
import { test, describe, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Timestamp } from "firebase-admin/firestore";

import { installFakes, resetStore, fakeCollection, store, writes } from "../helpers/fake-firestore";
import { agentService } from "../../src/services/agent.service";
import { agentController } from "../../src/controllers/agent.controller";

before(async () => {
  await installFakes();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const firebase: any = await import("../../src/utils/firebase");
  firebase.collections.agents = fakeCollection("agents");
});
beforeEach(() => {
  resetStore();
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  console.log = () => {};
});

const agentDoc = (id: string) => store.get(`agents/${id}`) as Record<string, unknown>;
const T0 = Timestamp.fromMillis(1_700_000_000_000);

/** Minimal res that records status + body. */
function captureRes() {
  const out: { status: number; body: any } = { status: 0, body: undefined }; // eslint-disable-line @typescript-eslint/no-explicit-any
  const res = {
    status: (n: number) => ((out.status = n), res),
    json: (b: unknown) => ((out.body = b), res),
  };
  return { out, res };
}

describe("createAgent", () => {
  test("a new agent starts at $0.00 with no naira field and no #148 marker", async () => {
    const a = await agentService.createAgent({
      userId: "u1", displayName: "Ada", bio: "b", yearsOfExperience: 1,
      specializations: [], languages: ["English"], featuredVisas: [],
    });
    assert.deepEqual(agentDoc(a.id).consultationFeeUsd, { amountMinor: 0, currency: "USD" });
    assert.equal("consultationFee" in agentDoc(a.id), false);
    assert.equal("consultationFeeUnit" in agentDoc(a.id), false);
  });

  test("POST /agents validates the dollar fee: 400 on bad values or the naira key, nothing created", async () => {
    const base = { displayName: "Ada", bio: "b", yearsOfExperience: 1, specializations: ["x"], languages: ["English"] };
    for (const body of [
      { ...base, consultationFee: 5000 },
      { ...base, consultationFeeUsd: 10 },
      { ...base, consultationFeeUsd: { amount: "10.001" } },
      { ...base, consultationFeeUsd: { amount: 10, currency: "NGN" } },
      { ...base, consultationFeeUsd: { amount: -1 } },
    ]) {
      const { out, res } = captureRes();
      await agentController.createAgent({ userId: "u1", body } as never, res as never);
      assert.equal(out.status, 400, JSON.stringify(body));
    }
    assert.equal([...store.keys()].filter((k) => k.startsWith("agents/")).length, 0);

    const { out, res } = captureRes();
    await agentController.createAgent({ userId: "u1", body: { ...base, consultationFeeUsd: { amount: "10.00" } } } as never, res as never);
    assert.equal(out.status, 201);
    assert.deepEqual(out.body.data.consultationFeeUsd, { amountMinor: 1000, currency: "USD" });
  });
});

describe("updateAgent / PUT /agents/me", () => {
  /** An agent doc as it looks before the migration (naira fee + #148 marker). */
  async function seedOld(id = "a1", userId = "u1") {
    await fakeCollection("agents").doc(id).set({
      id, userId, verificationStatus: "pending", consultationFee: 5000, consultationFeeUnit: "naira", createdAt: T0,
    });
  }

  test("writes the dollar fee and removes the old naira fee and marker", async () => {
    await seedOld();
    await agentService.updateAgent("a1", { consultationFeeUsd: { amount: "10.50", currency: "USD" } });
    assert.deepEqual(agentDoc("a1").consultationFeeUsd, { amountMinor: 1050, currency: "USD" });
    assert.equal("consultationFee" in agentDoc("a1"), false);
    assert.equal("consultationFeeUnit" in agentDoc("a1"), false);
  });

  test("an unrelated edit leaves the fee alone", async () => {
    await seedOld();
    await agentService.updateAgent("a1", { bio: "new bio" });
    assert.equal(agentDoc("a1").consultationFee, 5000);
    assert.equal("consultationFeeUsd" in agentDoc("a1"), false);
  });

  test("bad values and old naira keys are 400 and write nothing", async () => {
    await seedOld();
    for (const body of [
      { consultationFee: 6000 },
      { consultationFeeUnit: "kobo" },
      { consultationFeeUsd: 10 },
      { consultationFeeUsd: "10" },
      { consultationFeeUsd: { amount: "abc" } },
      { consultationFeeUsd: { amount: Infinity } },
      { consultationFeeUsd: { amount: "100000.01" } },
      { consultationFeeUsd: { amount: 5, currency: "EUR" } },
      { consultationFeeUsd: { amountMinor: 500, currency: "USD" } },
      { bio: "ok", consultationFeeUsd: { amount: "1.234" } },
    ]) {
      writes.length = 0;
      const { out, res } = captureRes();
      await agentController.updateMyAgentProfile({ userId: "u1", body } as never, res as never);
      assert.equal(out.status, 400, JSON.stringify(body));
      assert.equal(out.body.error, "VALIDATION_ERROR");
      assert.deepEqual(writes, [], JSON.stringify(body));
    }
    assert.equal(agentDoc("a1").bio, undefined);
    assert.equal(agentDoc("a1").consultationFee, 5000);
  });

  test("an agent changes only their own fee: the target comes from the token, not the body", async () => {
    await seedOld("a1", "u1");
    await seedOld("a2", "u2");
    const { out, res } = captureRes();
    await agentController.updateMyAgentProfile(
      { userId: "u1", body: { id: "a2", userId: "u2", consultationFeeUsd: { amount: "20" } } } as never,
      res as never
    );
    assert.equal(out.status, 200);
    assert.deepEqual(agentDoc("a1").consultationFeeUsd, { amountMinor: 2000, currency: "USD" });
    assert.equal(agentDoc("a1").userId, "u1");
    // The other agent is untouched.
    assert.equal(agentDoc("a2").consultationFee, 5000);
    assert.equal("consultationFeeUsd" in agentDoc("a2"), false);
  });
});

// The guest-booking charge path and its verify (#179's fail-closed check and
// the kobo transaction check) moved to test/consultations/consultation-charge.test.ts
// when issue #180 replaced the 503 placeholder with the real charge.
