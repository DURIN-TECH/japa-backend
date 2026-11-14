// ============================================
// Unit tests — creating a payment request in US dollars (issue #181)
// ============================================
//
// POST /payment-requests (controller called directly, as the route does after
// verifyAuth, the "payments.request" entitlement and the agency compliance
// gate). Covers:
//  - the dollar amount: whole cents, USD or no currency, anything else 400;
//    the old `currency || "NGN"` default is gone;
//  - what is stored: `priceUsd` Money, mirrored in `amount` (cents) + "USD",
//    plus the agent / agency / client / application ids; no rate is read;
//  - per-agency isolation: another agency's agent, an independent agent on a
//    case with no agency, and a read-only colleague get 403 and nothing is
//    written;
//  - the compliance gate (requireAgencyVerified) still guards the route;
//  - the copy: explicit currency codes, no hard-coded naira sign.
import { test, describe, before, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  usePaymentRequestHarness,
  resetPaymentRequests,
  reqFor,
  sent,
  agentA,
  colleagueA,
  ownerA,
  agentB,
  independent,
  clientNg,
  APP_A,
  APP_B,
  APP_NONE,
  harness,
} from "./helpers";
import { captureRes, docsIn } from "../consultations/harness";
import { writes } from "../helpers/fake-firestore";
import { paymentRequestController } from "../../src/controllers/payment-request.controller";
import { requireAgencyVerified } from "../../src/middleware/authz";
import { complianceService } from "../../src/services/compliance.service";

/* eslint-disable @typescript-eslint/no-explicit-any */

before(async () => {
  await usePaymentRequestHarness();
});
beforeEach(async () => {
  await resetPaymentRequests();
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  console.error = () => {};
});

/** POST /payment-requests as `who` with `body`. */
async function create(who: any, body: Record<string, unknown>) {
  const { out, res } = captureRes();
  await paymentRequestController.createPaymentRequest(reqFor(who, { body }), res);
  return out;
}

/** A valid body for agency A's case. */
const valid = (extra: Record<string, unknown> = {}) => ({
  applicationId: APP_A,
  amount: "150.00",
  description: "Visa Processing Fee",
  category: "visa_fee",
  ...extra,
});

describe("POST /payment-requests: the dollar amount", () => {
  test("stores priceUsd Money and mirrors it as US cents in amount/currency, with the ids", async () => {
    const out = await create(agentA, valid());
    assert.equal(out.status, 201, JSON.stringify(out.body));
    const stored = docsIn("paymentRequests");
    assert.equal(stored.length, 1);
    const [, pr] = stored[0];
    assert.deepEqual(pr.priceUsd, { amountMinor: 15_000, currency: "USD" });
    assert.equal(pr.amount, 15_000);
    assert.equal(pr.currency, "USD");
    assert.equal(pr.applicationId, APP_A);
    assert.equal(pr.agentId, "prof-agent-a");
    assert.equal(pr.agencyId, "agency-a");
    assert.equal(pr.clientId, clientNg.uid);
    assert.equal(pr.status, "pending");
    // No quote yet: the local amount is decided when the client pays.
    assert.equal(pr.chargedAmountMinor, undefined);
    assert.equal(pr.fxRate, undefined);
    // The response carries the display string with an explicit code.
    assert.equal(out.body.data.amountDisplay, "USD 150.00");
    assert.equal(out.body.data.legacy, false);
  });

  test("currency \"USD\" is accepted; a JSON number of dollars is accepted", async () => {
    assert.equal((await create(agentA, valid({ amount: 12.5, currency: "USD" }))).status, 201);
    const [, pr] = docsIn("paymentRequests")[0];
    assert.deepEqual(pr.priceUsd, { amountMinor: 1_250, currency: "USD" });
  });

  for (const [label, extra] of [
    ["currency NGN", { currency: "NGN" }],
    ["currency GHS", { currency: "GHS" }],
    ["currency as a number", { currency: 566 }],
    ["fractional cents", { amount: "12.505" }],
    ["negative", { amount: "-5" }],
    ["zero", { amount: "0" }],
    ["missing amount", { amount: undefined }],
    ["amount as a Money map", { amount: { amountMinor: 1000, currency: "USD" } }],
    ["over the price cap (an old kobo number)", { amount: 15_000_000 }],
    ["not a number", { amount: "abc" }],
  ] as Array<[string, Record<string, unknown>]>) {
    test(`400 and nothing written: ${label}`, async () => {
      const out = await create(agentA, valid(extra));
      assert.equal(out.status, 400, JSON.stringify(out.body));
      assert.equal(out.body.error, "VALIDATION_ERROR");
      assert.equal(docsIn("paymentRequests").length, 0);
    });
  }

  test("missing applicationId or description is 400", async () => {
    assert.equal((await create(agentA, valid({ applicationId: undefined }))).status, 400);
    assert.equal((await create(agentA, valid({ description: "  " }))).status, 400);
    assert.equal((await create(agentA, valid({ category: "bribe" }))).status, 400);
    assert.equal(docsIn("paymentRequests").length, 0);
  });

  test("no rate is needed to create a request (pricing happens at checkout)", async () => {
    harness.rateStore.docs.clear();
    assert.equal((await create(agentA, valid())).status, 201);
  });
});

describe("POST /payment-requests: per-agency isolation", () => {
  test("another agency's agent gets 403 and nothing is written", async () => {
    const before = writes.length;
    const out = await create(agentB, valid());
    assert.equal(out.status, 403);
    assert.equal(docsIn("paymentRequests").length, 0);
    assert.equal(writes.length, before);
    assert.equal(sent.length, 0);
  });

  test("agency A's agent cannot bill agency B's case", async () => {
    const out = await create(agentA, valid({ applicationId: APP_B }));
    assert.equal(out.status, 403);
    assert.equal(docsIn("paymentRequests").length, 0);
  });

  test("an independent agent cannot bill a case with no agency (the old check let them)", async () => {
    const out = await create(independent, valid({ applicationId: APP_NONE }));
    assert.equal(out.status, 403);
    assert.equal(docsIn("paymentRequests").length, 0);
  });

  test("a same-agency colleague who is not assigned has read access only: 403", async () => {
    const out = await create(colleagueA, valid());
    assert.equal(out.status, 403);
    assert.equal(docsIn("paymentRequests").length, 0);
  });

  test("the agency's owner may bill the agency's case", async () => {
    const out = await create(ownerA, valid());
    assert.equal(out.status, 201, JSON.stringify(out.body));
    assert.equal(docsIn("paymentRequests")[0][1].agentId, "prof-owner-a");
  });

  test("a user with no agent profile gets 403", async () => {
    const out = await create(clientNg, valid());
    assert.equal(out.status, 403);
  });

  test("an unknown case is 404", async () => {
    assert.equal((await create(agentA, valid({ applicationId: "nope" }))).status, 404);
  });

  test("agent lists are per agent and per agency", async () => {
    await create(agentA, valid());
    await create(ownerA, valid());
    const list = async (who: any, role: string) => {
      const { out, res } = captureRes();
      await paymentRequestController.getPaymentRequests(reqFor(who, { query: { role } }), res);
      return out.body.data as any[];
    };
    assert.equal((await list(agentA, "agent")).length, 1);
    assert.equal((await list(agentB, "agent")).length, 0);
    assert.equal((await list(ownerA, "owner")).length, 2);
    // An owner of another agency asking as owner gets 403 (not B's agent).
    const { out, res } = captureRes();
    await paymentRequestController.getPaymentRequests(reqFor(agentB, { query: { role: "owner" } }), res);
    assert.equal(out.status, 403);
  });
});

describe("POST /payment-requests: the compliance gate still applies", () => {
  test("requireAgencyVerified refuses an unverified agency and lets a verified one through", async () => {
    const original = complianceService.isVerified;
    try {
      (complianceService as any).isVerified = async (agencyId: string) => agencyId === "agency-a";
      const gate = requireAgencyVerified("request or receive payments");
      const run = async (who: any) => {
        const { out, res } = captureRes();
        let nextCalled = false;
        await gate(reqFor(who), res, () => { nextCalled = true; });
        return { out, nextCalled };
      };
      assert.equal((await run(agentA)).nextCalled, true);
      const refused = await run(agentB);
      assert.equal(refused.nextCalled, false);
      assert.equal(refused.out.status, 403);
      assert.equal(refused.out.body.error, "COMPLIANCE_REQUIRED");
      // An agent with no agency is refused too.
      assert.equal((await run(independent)).nextCalled, false);
    } finally {
      (complianceService as any).isVerified = original;
    }
  });
});

describe("POST /payment-requests: copy", () => {
  test("the client is told the dollar price with an explicit code, no naira sign", async () => {
    await create(agentA, valid());
    assert.equal(sent.length, 1);
    assert.equal(sent[0].userId, clientNg.uid);
    assert.match(sent[0].body, /USD 150\.00/);
    assert.doesNotMatch(sent[0].body, /₦/);
  });
});
