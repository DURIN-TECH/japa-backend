// ============================================
// Unit tests — consultation fee units (issue #148), hermetic (in-memory Firestore)
// ============================================
//  - every server-side writer of Agent.consultationFee stamps `consultationFeeUnit: "naira"`;
//    a client cannot set/clear the marker through PUT /agents/me;
//  - the two windows the review named: a fee edited through updateAgent after the deploy
//    is NOT converted by a first migration run, and a re-run converts nothing;
//  - the guest-booking verify path records a Transaction.amount in KOBO (₦50,000 -> 5,000,000).
import { test, describe, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Timestamp } from "firebase-admin/firestore";

import { installFakes, resetStore, fakeCollection, fakeRunTransaction, store } from "../helpers/fake-firestore";
import { agentService } from "../../src/services/agent.service";
import { transactionService } from "../../src/services/transaction.service";
import { consultationService } from "../../src/services/consultation.service";
import { paystackProvider } from "../../src/services/billing/paystack.provider";
import { consultationController } from "../../src/controllers/consultation.controller";
import { migrateAgentFees } from "../../src/scripts/migrate-agent-consultation-fee-to-naira";

const CUTOFF = Date.parse("2026-11-20T09:00:00Z");
const BEFORE = CUTOFF - 86_400_000;

before(async () => {
  await installFakes();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const firebase: any = await import("../../src/utils/firebase");
  firebase.collections.transactions = fakeCollection("transactions");
  firebase.collections.consultations = fakeCollection("consultations");
});
beforeEach(() => {
  resetStore();
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  console.log = () => {};
});

const agentDoc = (id: string) => store.get(`agents/${id}`) as Record<string, unknown>;
const deps = () => ({ agents: fakeCollection("agents") as never, runTransaction: fakeRunTransaction });

describe("the marker is server-owned", () => {
  test("createAgent stamps the marker", async () => {
    const a = await agentService.createAgent({
      userId: "u1", displayName: "Ada", bio: "b", yearsOfExperience: 1,
      specializations: [], languages: ["English"], featuredVisas: [], consultationFee: 5000,
    } as never);
    assert.equal(agentDoc(a.id).consultationFeeUnit, "naira");
  });

  test("updateAgent stamps it with a fee; a client-sent marker is dropped; an unrelated edit does not stamp", async () => {
    await fakeCollection("agents").doc("a1").set({
      id: "a1", userId: "u1", verificationStatus: "pending", consultationFee: 500000, createdAt: Timestamp.fromMillis(BEFORE),
    });
    await agentService.updateAgent("a1", { bio: "new bio", consultationFeeUnit: "naira" } as never);
    assert.equal(agentDoc("a1").consultationFeeUnit, undefined); // not stamped, client value dropped
    assert.equal(agentDoc("a1").consultationFee, 500000);
    await agentService.updateAgent("a1", { consultationFee: 5000, consultationFeeUnit: "kobo" } as never);
    assert.equal(agentDoc("a1").consultationFeeUnit, "naira"); // server value, not the client's
    assert.equal(agentDoc("a1").consultationFee, 5000);
  });
});

describe("migration windows", () => {
  test("agent created before the cutoff, fee set in naira via updateAgent after the deploy, is NOT converted", async () => {
    await fakeCollection("agents").doc("a1").set({
      id: "a1", userId: "u1", verificationStatus: "pending", consultationFee: 0, createdAt: Timestamp.fromMillis(BEFORE),
    });
    await agentService.updateAgent("a1", { consultationFee: 5000 });
    const c = await migrateAgentFees(CUTOFF, true, deps());
    assert.equal(c.converted, 0);
    assert.equal(agentDoc("a1").consultationFee, 5000);
  });

  test("a no-fee agent marked by run 1 keeps a later first fee through run 2", async () => {
    await fakeCollection("agents").doc("a2").set({ id: "a2", userId: "u2", createdAt: Timestamp.fromMillis(BEFORE) });
    await migrateAgentFees(CUTOFF, true, deps());
    assert.equal(agentDoc("a2").consultationFeeUnit, "naira");
    // Simulate a fee written without the backend stamp path: the marker already protects it.
    await fakeCollection("agents").doc("a2").update({ consultationFee: 5000 });
    const again = await migrateAgentFees(CUTOFF, true, deps());
    assert.equal(again.converted, 0);
    assert.equal(agentDoc("a2").consultationFee, 5000);
  });
});

describe("guest booking verify records the transaction in kobo", () => {
  test("a ₦50,000 booking records Transaction.amount 5,000,000", async () => {
    const consultation = {
      id: "c1", userId: "guest1", agentId: "owner1", clientName: "G", clientEmail: "delivered+g@resend.dev",
      agentName: "A", type: "initial", scheduledTime: "10:00", timezone: "Africa/Lagos",
      status: "pending_payment", paymentStatus: "pending", fee: 50000,
    };
    const restore = [
      paystackProvider.getTransactionMetadata,
      consultationService.getConsultationById,
      consultationService.updateConsultation,
    ];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ps: any = paystackProvider, cs: any = consultationService;
    ps.getTransactionMetadata = async () => ({ status: "success", metadata: { purpose: "consultation", consultationId: "c1" } });
    cs.getConsultationById = async () => consultation;
    cs.updateConsultation = async () => ({ ...consultation, paymentStatus: "paid" });
    try {
      let status = 0;
      const res = { status: (n: number) => ((status = n), res), json: () => res };
      await consultationController.verifyPublicConsultation({ body: { reference: "ref-1" } } as never, res as never);
      assert.ok(status === 0 || status === 200);
      // createConsultationFee is fire-and-forget behind .catch; let it settle.
      await new Promise((r) => setTimeout(r, 10));
      const txs = [...store.entries()].filter(([k]) => k.startsWith("transactions/"));
      assert.equal(txs.length, 1);
      assert.equal(txs[0][1].amount, 5_000_000);
      void transactionService;
    } finally {
      [ps.getTransactionMetadata, cs.getConsultationById, cs.updateConsultation] = restore;
    }
  });
});
