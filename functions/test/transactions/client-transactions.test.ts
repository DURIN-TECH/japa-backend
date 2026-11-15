// ============================================
// Unit tests — issue #292: a client's payment history on GET /transactions
// ============================================
//
// Before #292 the controller read the scope from the `role` query parameter
// and defaulted to "agent", so a client (who sends no `role`) was looked up
// as an AGENT, matched nothing and always got `[]`.
//
// The contract checked here:
//  - a CLIENT gets their own rows (the ones whose payer `userId` is them:
//    consultation booking fees and payment-request charges), with no `role`
//    or with `role=client`;
//  - a client NEVER gets another client's rows, and passing
//    `role=agent|owner|admin` changes nothing (no wider scope);
//  - agents, owners and admins are scoped exactly as before.
//
// Runs on the in-memory Firestore of the payment-request harness
// (test/payment-requests/helpers.ts): no emulator, no network, no Paystack.
// The rows are built with the REAL builders the settlement paths use
// (`buildConsultationFee`, `buildPaymentRequestPayment`), so the tests would
// fail if those ever stopped recording the payer in `userId`.
import { test, describe, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Timestamp } from "firebase-admin/firestore";
import { ROLES } from "@durin-tech/authz";
import type { AuthzSubject } from "@durin-tech/authz";

import {
  usePaymentRequestHarness,
  resetPaymentRequests,
  reqFor,
  agentA,
  colleagueA,
  ownerA,
  agentB,
  clientNg,
  clientGh,
  APP_A,
  APP_A_GH,
} from "../payment-requests/helpers";
import { captureRes, seed, NOW_ISO } from "../consultations/harness";
import { transactionController } from "../../src/controllers/transaction.controller";
import { transactionService } from "../../src/services/transaction.service";
import type { PaymentRequest, Transaction } from "../../src/types";

/* eslint-disable @typescript-eslint/no-explicit-any */

// ============================================
// Principals not in the shared helpers
// ============================================

/** A platform admin (no agency). */
const admin: AuthzSubject = { uid: "uid-admin", role: ROLES.ADMIN, agencyId: null };
/** A client with no transactions at all. */
const clientNew: AuthzSubject = { uid: "uid-client-new", role: ROLES.CLIENT, agencyId: null };

// ============================================
// Fixtures
// ============================================

/** A timestamp `minutes` after the harness clock, so rows have a known order. */
const at = (minutes: number) =>
  Timestamp.fromMillis(new Date(NOW_ISO).getTime() + minutes * 60_000);

/** Ids of the seeded rows (see `seedTransactions`). */
const TX = {
  ngConsultation: "tx-ng-consultation", // Nigerian client, agent A, NGN
  ngRequest: "tx-ng-request", // Nigerian client, agent A, NGN, on APP_A
  ngRequestAgentB: "tx-ng-request-b", // Nigerian client, agent B (other agency), USD
  ghConsultation: "tx-gh-consultation", // Ghanaian client, agent A, GHS
  ghRequest: "tx-gh-request", // Ghanaian client, colleague A, GHS, on APP_A_GH
  withdrawalA: "tx-withdrawal-a", // agent A's payout (userId = agent A)
};

/** A minimal payment request, as the settlement reads it. */
function request(id: string, clientId: string, agentProfileId: string, applicationId: string): PaymentRequest {
  return {
    id,
    clientId,
    agentId: agentProfileId,
    applicationId,
    description: "Visa Processing Fee",
    category: "service_fee",
  } as unknown as PaymentRequest;
}

/**
 * Seed two clients' payments across two agencies, plus an agent's payout.
 * Built with the real builders, then stored as the settlement would.
 */
async function seedTransactions(): Promise<void> {
  const rows: Transaction[] = [
    // Nigerian client: a paid consultation booking with agent A (NGN kobo).
    transactionService.buildConsultationFee(TX.ngConsultation, at(1), {
      consultationId: "consult-ng",
      clientUserId: clientNg.uid,
      agentUserId: agentA.uid,
      amount: 7_500_000,
      currency: "NGN",
      reference: "ref-ng-consult",
    }),
    // Nigerian client: a paid payment request from agent A on their case.
    transactionService.buildPaymentRequestPayment(TX.ngRequest, at(2), {
      paymentRequest: request("pr-ng", clientNg.uid, "prof-agent-a", APP_A),
      agentUserId: agentA.uid,
      amount: 22_500_000,
      currency: "NGN",
      reference: "ref-ng-request",
    }),
    // Nigerian client again, but paid to agent B in ANOTHER agency, in USD.
    transactionService.buildPaymentRequestPayment(TX.ngRequestAgentB, at(3), {
      paymentRequest: request("pr-ng-b", clientNg.uid, "prof-agent-b", "app-b"),
      agentUserId: agentB.uid,
      amount: 15_000,
      currency: "USD",
      reference: "ref-ng-request-b",
    }),
    // Ghanaian client: a consultation with the SAME agent A (GHS pesewas).
    transactionService.buildConsultationFee(TX.ghConsultation, at(4), {
      consultationId: "consult-gh",
      clientUserId: clientGh.uid,
      agentUserId: agentA.uid,
      amount: 75_000,
      currency: "GHS",
      reference: "ref-gh-consult",
    }),
    // Ghanaian client: a payment request from agent A's colleague.
    transactionService.buildPaymentRequestPayment(TX.ghRequest, at(5), {
      paymentRequest: request("pr-gh", clientGh.uid, "prof-agent-a2", APP_A_GH),
      agentUserId: colleagueA.uid,
      amount: 225_000,
      currency: "GHS",
      reference: "ref-gh-request",
    }),
  ];
  for (const row of rows) await seed("transactions", row.id, row as unknown as Record<string, unknown>);

  // Agent A's payout: `userId` AND `agentId` are the agent's own uid.
  await seed("transactions", TX.withdrawalA, {
    userId: agentA.uid,
    agentId: agentA.uid,
    type: "withdrawal",
    amount: 1_000_000,
    currency: "NGN",
    status: "pending",
    isEscrow: false,
    paymentProvider: "manual",
    description: "Withdrawal",
    createdAt: at(6),
    updatedAt: at(6),
  });
}

/** GET /transactions as `who` with the given query string values. */
async function list(who: AuthzSubject, query: Record<string, unknown> = {}) {
  const { out, res } = captureRes();
  await transactionController.getTransactions(reqFor(who, { query }), res);
  return out;
}

/** The ids of a 200 response's rows, in the order returned. */
function ids(out: { status: number; body: any }): string[] {
  assert.equal(out.status, 200, JSON.stringify(out.body));
  return (out.body.data as Transaction[]).map((t) => t.id);
}

before(async () => {
  await usePaymentRequestHarness();
});
beforeEach(async () => {
  await resetPaymentRequests();
  await seedTransactions();
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  console.error = () => {};
});

// ============================================
// A client sees their own payments
// ============================================

describe("GET /transactions as a client (issue #292)", () => {
  test("no role: the client's paid consultation and payment-request charges, newest first", async () => {
    const out = await list(clientNg);
    assert.deepEqual(ids(out), [TX.ngRequestAgentB, TX.ngRequest, TX.ngConsultation]);
    // Every row is the caller's own.
    for (const t of out.body.data as Transaction[]) assert.equal(t.userId, clientNg.uid);
  });

  test("role=client returns the same rows as no role", async () => {
    assert.deepEqual(ids(await list(clientNg, { role: ROLES.CLIENT })), ids(await list(clientNg)));
  });

  test("covers both kinds of payment: consultation_fee and the payment-request charge", async () => {
    const rows = (await list(clientNg)).body.data as Transaction[];
    const consultation = rows.find((t) => t.id === TX.ngConsultation)!;
    const charge = rows.find((t) => t.id === TX.ngRequest)!;
    assert.equal(consultation.type, "consultation_fee");
    assert.equal(consultation.consultationId, "consult-ng");
    assert.equal(charge.type, "escrow_release");
    assert.equal(charge.paymentRequestId, "pr-ng");
  });

  test("money is returned per row in its own currency, untouched", async () => {
    const rows = (await list(clientNg)).body.data as Transaction[];
    const byId = Object.fromEntries(rows.map((t) => [t.id, [t.amount, t.currency]]));
    assert.deepEqual(byId, {
      [TX.ngConsultation]: [7_500_000, "NGN"],
      [TX.ngRequest]: [22_500_000, "NGN"],
      [TX.ngRequestAgentB]: [15_000, "USD"],
    });
  });

  test("a client with no payments gets an empty list, not an error", async () => {
    assert.deepEqual(ids(await list(clientNew)), []);
  });

  test("filters narrow the client's own rows only", async () => {
    assert.deepEqual(ids(await list(clientNg, { applicationId: APP_A })), [TX.ngRequest]);
    assert.deepEqual(ids(await list(clientNg, { status: "completed" })), [TX.ngConsultation]);
    // Another client's case id finds nothing: the payer scope still applies.
    assert.deepEqual(ids(await list(clientNg, { applicationId: APP_A_GH })), []);
    // Date window (inclusive): only the row at +2 minutes.
    assert.deepEqual(
      ids(await list(clientNg, { startDate: at(2).toDate().toISOString(), endDate: at(2).toDate().toISOString() })),
      [TX.ngRequest]
    );
    // A date that does not parse is ignored.
    assert.equal(ids(await list(clientNg, { startDate: "not-a-date" })).length, 3);
  });
});

// ============================================
// A client never sees anyone else's rows
// ============================================

describe("GET /transactions never leaks across clients (issue #292)", () => {
  test("two clients of the same agent each see only their own rows", async () => {
    const ng = ids(await list(clientNg));
    const gh = ids(await list(clientGh));
    assert.deepEqual(gh, [TX.ghRequest, TX.ghConsultation]);
    // No row appears in both lists.
    assert.deepEqual(ng.filter((id) => gh.includes(id)), []);
  });

  // Every value a client could put in `role`, including junk and a repeated
  // parameter (Express parses `?role=a&role=b` as an array).
  const roleValues: unknown[] = [
    ROLES.AGENT, ROLES.OWNER, ROLES.ADMIN, "superuser", "", ["admin", "client"], ["admin"],
  ];
  for (const role of roleValues) {
    test(`a client passing role=${JSON.stringify(role)} still gets only their own rows`, async () => {
      const out = await list(clientGh, { role });
      assert.deepEqual(ids(out), [TX.ghRequest, TX.ghConsultation]);
      for (const t of out.body.data as Transaction[]) assert.equal(t.userId, clientGh.uid);
    });
  }

  test("a caller with no resolved principal falls to the own-rows scope, never wider", async () => {
    const { out, res } = captureRes();
    const req = reqFor(clientGh, { query: { role: ROLES.ADMIN } });
    delete req.authz;
    await transactionController.getTransactions(req, res);
    assert.deepEqual(ids(out), [TX.ghRequest, TX.ghConsultation]);
  });

  test("the service returns nothing for an empty uid", async () => {
    assert.deepEqual(await transactionService.getTransactionsForClient(""), []);
  });

  test("a row that only names the client as its AGENT is not in their payment history", async () => {
    // A row that names the client as AGENT must not count as theirs.
    await seed("transactions", "tx-agent-named", {
      userId: "uid-someone-else", agentId: clientNg.uid, type: "consultation_fee",
      amount: 1, currency: "NGN", status: "completed", createdAt: at(9), updatedAt: at(9),
    });
    const rows = await transactionService.getTransactionsForClient(clientNg.uid);
    assert.ok(!rows.some((t) => t.id === "tx-agent-named"));
  });
});

// ============================================
// Agents, owners and admins: unchanged
// ============================================

describe("GET /transactions for agent-side callers is unchanged (issue #292)", () => {
  test("agent, no role: the rows where they are the agent (withdrawal included)", async () => {
    assert.deepEqual(ids(await list(agentA)), [
      TX.withdrawalA, TX.ghConsultation, TX.ngRequest, TX.ngConsultation,
    ]);
  });

  test("agent, role=agent: the same rows", async () => {
    assert.deepEqual(ids(await list(agentA, { role: ROLES.AGENT })), ids(await list(agentA)));
  });

  test("agent in another agency sees only their own rows", async () => {
    assert.deepEqual(ids(await list(agentB)), [TX.ngRequestAgentB]);
  });

  test("agent asking for owner or admin scope is refused", async () => {
    assert.equal((await list(agentA, { role: ROLES.OWNER })).status, 403);
    assert.equal((await list(agentA, { role: ROLES.ADMIN })).status, 403);
  });

  test("owner, role=owner: every row of the agency's agents, none of another agency's", async () => {
    assert.deepEqual(ids(await list(ownerA, { role: ROLES.OWNER })), [
      TX.withdrawalA, TX.ghRequest, TX.ghConsultation, TX.ngRequest, TX.ngConsultation,
    ]);
  });

  test("owner asking for admin scope is refused", async () => {
    assert.equal((await list(ownerA, { role: ROLES.ADMIN })).status, 403);
  });

  test("admin, role=admin: every transaction", async () => {
    assert.equal(ids(await list(admin, { role: ROLES.ADMIN })).length, 6);
  });

  test("admin, no role: the agent default (rows where the admin is the agent: none)", async () => {
    assert.deepEqual(ids(await list(admin)), []);
  });

  test("role=client for an agent: their own payer rows, without payouts", async () => {
    // Agent A paid for a consultation as a customer.
    const own = transactionService.buildConsultationFee("tx-agent-as-payer", at(7), {
      consultationId: "consult-agent", clientUserId: agentA.uid, agentUserId: agentB.uid,
      amount: 100, currency: "NGN", reference: "ref-agent-payer",
    });
    await seed("transactions", own.id, own as unknown as Record<string, unknown>);
    // The withdrawal (userId = agent A) is a payout, not a payment made.
    assert.deepEqual(ids(await list(agentA, { role: ROLES.CLIENT })), ["tx-agent-as-payer"]);
  });
});
