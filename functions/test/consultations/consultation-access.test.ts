// ============================================
// Unit tests — who sees a priced booking and its transaction (issue #180)
// ============================================
//
// The snapshot fields (amount charged, rate) are new on consultations and
// transactions; these checks show they do not widen access:
//  - GET /consultations/:id: the booking's own client and its agency's owner
//    see it (snapshot included); another client and an agent or owner of a
//    DIFFERENT agency get 403;
//  - GET /consultations?role=client lists only the caller's own bookings;
//  - GET /transactions (agent): an agent sees only transactions where they
//    are the agent, never another agent's (or another agency's) fee.
// Requests carry a REAL CASL ability from @durin-tech/authz, as verifyAuth
// leaves them.
import { test, describe, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { defineAbilitiesFor, ROLES } from "@durin-tech/authz";
import type { AuthzSubject } from "@durin-tech/authz";

import { useHarness, harness, captureRes, seed, T0 } from "./harness";
import { consultationController } from "../../src/controllers/consultation.controller";
import { transactionController } from "../../src/controllers/transaction.controller";

/* eslint-disable @typescript-eslint/no-explicit-any */

before(async () => {
  await useHarness();
});
beforeEach(async () => {
  harness.reset();
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  console.error = () => {};
  // Agency A's paid, priced booking for client 1 (guest flow: owner A is the agent).
  await seed("consultations", "c-a", {
    userId: "uid-client1", agentId: "uid-owner-a", agencyId: "agency-a", status: "scheduled", paymentStatus: "paid",
    scheduledDate: T0, priceUsdCents: 10_000, chargedCurrency: "NGN", chargedAmountMinor: 15_000_000,
    fxRate: 1500, fxRateAsOf: T0, fxRateSource: "cbn", fxMarginBps: 0, createdAt: T0,
  });
  // Agency B's booking for client 2.
  await seed("consultations", "c-b", {
    userId: "uid-client2", agentId: "uid-owner-b", agencyId: "agency-b", status: "scheduled", paymentStatus: "paid",
    scheduledDate: T0, priceUsdCents: 2_000, chargedCurrency: "GHS", chargedAmountMinor: 30_000, createdAt: T0,
  });
  // The fee transactions that settled them.
  await seed("transactions", "t-a", {
    userId: "uid-client1", agentId: "uid-owner-a", consultationId: "c-a", type: "consultation_fee", status: "completed",
    amount: 15_000_000, currency: "NGN", priceUsdCents: 10_000, fxRate: 1500, createdAt: T0,
  });
  await seed("transactions", "t-b", {
    userId: "uid-client2", agentId: "uid-owner-b", consultationId: "c-b", type: "consultation_fee", status: "completed",
    amount: 30_000, currency: "GHS", priceUsdCents: 2_000, fxRate: 15, createdAt: T0,
  });
});

/** A request for `p` as verifyAuth leaves it. */
function reqFor(p: AuthzSubject, extra: Record<string, unknown> = {}): any {
  return { userId: p.uid, authz: p, ability: defineAbilitiesFor(p), entitlements: null, query: {}, params: {}, ...extra };
}

const client1: AuthzSubject = { uid: "uid-client1", role: ROLES.CLIENT, agencyId: null };
const client2: AuthzSubject = { uid: "uid-client2", role: ROLES.CLIENT, agencyId: null };
const ownerA: AuthzSubject = { uid: "uid-owner-a", role: ROLES.OWNER, agencyId: "agency-a" };
const ownerB: AuthzSubject = { uid: "uid-owner-b", role: ROLES.OWNER, agencyId: "agency-b" };
const agentB: AuthzSubject = { uid: "uid-agent-b", role: ROLES.AGENT, agencyId: "agency-b" };

describe("GET /consultations/:id with the snapshot fields", () => {
  test("the booking's own client sees it, snapshot included", async () => {
    const { out, res } = captureRes();
    await consultationController.getConsultation(reqFor(client1, { params: { id: "c-a" } }), res);
    assert.ok(out.status === 0 || out.status === 200);
    assert.equal(out.body.data.chargedAmountMinor, 15_000_000);
    assert.equal(out.body.data.fxRate, 1500);
  });

  test("its agency's owner sees it", async () => {
    const { out, res } = captureRes();
    await consultationController.getConsultation(reqFor(ownerA, { params: { id: "c-a" } }), res);
    assert.ok(out.status === 0 || out.status === 200);
  });

  test("another client, another agency's owner and agent get 403", async () => {
    for (const p of [client2, ownerB, agentB]) {
      const { out, res } = captureRes();
      await consultationController.getConsultation(reqFor(p, { params: { id: "c-a" } }), res);
      assert.equal(out.status, 403, p.uid);
      assert.equal(out.body.data, undefined, p.uid);
    }
  });
});

describe("listing", () => {
  test("a client lists only their own bookings", async () => {
    const { out, res } = captureRes();
    await consultationController.getConsultations(reqFor(client1, { query: { role: ROLES.CLIENT } }), res);
    assert.deepEqual(out.body.data.map((c: any) => c.id), ["c-a"]);
  });

  test("an agent sees only their own transactions, never another agency's fee", async () => {
    const { out, res } = captureRes();
    await transactionController.getTransactions(reqFor(ownerB, { query: { role: ROLES.AGENT } }), res);
    assert.deepEqual(out.body.data.map((t: any) => t.id), ["t-b"]);
    assert.equal(out.body.data[0].currency, "GHS");
    assert.equal(out.body.data[0].priceUsdCents, 2_000);
  });
});
