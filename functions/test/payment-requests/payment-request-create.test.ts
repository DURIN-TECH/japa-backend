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
//  - the copy: explicit currency codes, no hard-coded naira sign;
//  - issue #337 (an owner bills a case assigned to someone else): the owner
//    of the case's agency may, the owner of ANOTHER agency may not, an owner
//    of an unverified agency is stopped by the compliance gate, and the
//    compliance file the seed writes on the demo agency passes that gate.
import { test, describe, before, beforeEach } from "node:test";
import { ROLES } from "@durin-tech/authz";
import type { AuthzSubject } from "@durin-tech/authz";
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
  seed,
} from "./helpers";
import { captureRes, docsIn } from "../consultations/harness";
import { writes } from "../helpers/fake-firestore";
import { paymentRequestController } from "../../src/controllers/payment-request.controller";
import { requireAgencyVerified } from "../../src/middleware/authz";
import { complianceService } from "../../src/services/compliance.service";
// Issue #337: the compliance file the seed writes on the demo agency. Imported
// AFTER the controller on purpose: the seed module calls getFirestore() when
// it loads, which needs the Admin app utils/firebase initialises.
import {
  buildSeedAgencyCompliance,
  SEED_AGENCY_ID,
  SEED_COMPLIANCE_REVIEWER_UID,
} from "../../src/data/seed-portal-data";

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

// ============================================
// Issue #337: owners
// ============================================

/**
 * The OWNER of agency B (the helpers only have B's member agent). Has an
 * agent profile of their own (seeded per test by `seedOwnerB`), so a refusal
 * is the case rule speaking, not the "no agent profile" check before it.
 */
const ownerB: AuthzSubject = { uid: "uid-owner-b", role: ROLES.OWNER, agencyId: "agency-b" };

/** Agency B's owner agent profile (doc id = profile id). */
async function seedOwnerB(): Promise<void> {
  await seed("agents", "prof-owner-b", { userId: ownerB.uid, agencyId: "agency-b", displayName: "Bisi Owner" });
}

/**
 * Run the route's compliance gate (`requireAgencyVerified`) as `who`, with
 * the REAL `complianceService.isVerified` reading the fake `agencies`
 * collection. Returns whether the request was let through and the response.
 */
async function runComplianceGate(who: AuthzSubject) {
  const gate = requireAgencyVerified("request or receive payments");
  const { out, res } = captureRes();
  let nextCalled = false;
  await gate(reqFor(who), res, () => { nextCalled = true; });
  return { out, nextCalled };
}

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
    // #337: the wording the portal and QA see for a read-only colleague.
    assert.equal(out.body.message, "Not authorized for this application");
    assert.equal(docsIn("paymentRequests").length, 0);
    assert.equal(sent.length, 0);
  });

  test("the agency's owner may bill the agency's case", async () => {
    const out = await create(ownerA, valid());
    assert.equal(out.status, 201, JSON.stringify(out.body));
    assert.equal(docsIn("paymentRequests")[0][1].agentId, "prof-owner-a");
  });

  // Issue #337: the case here (APP_A) is assigned to agentA, NOT to the
  // owner. The owner still bills it, under their OWN agent profile, and the
  // case's client is told.
  test("#337: the owner bills a case assigned to another agent; the request carries the owner's profile and the agency, and the client is notified", async () => {
    const out = await create(ownerA, valid({ amount: "50.00", description: "Document review" }));
    assert.equal(out.status, 201, JSON.stringify(out.body));
    const stored = docsIn("paymentRequests");
    assert.equal(stored.length, 1);
    const [, pr] = stored[0];
    assert.equal(pr.agentId, "prof-owner-a"); // the owner's profile, not the assigned agent's
    assert.notEqual(pr.agentId, "prof-agent-a");
    assert.equal(pr.agencyId, "agency-a");
    assert.equal(pr.applicationId, APP_A);
    assert.equal(pr.clientId, clientNg.uid);
    assert.deepEqual(pr.priceUsd, { amountMinor: 5_000, currency: "USD" });
    // One payment_request notification, to the case's client.
    assert.equal(sent.length, 1);
    assert.equal(sent[0].userId, clientNg.uid);
    assert.equal(sent[0].type, "payment_request");
  });

  // Issue #337: being an owner is not enough; it must be the owner of the
  // CASE'S agency. Agency B's owner has an agent profile and a verified role,
  // and is still refused on agency A's case, with nothing written or sent.
  test("#337: the owner of another agency gets 403 on this agency's case and nothing is written", async () => {
    await seedOwnerB();
    const before = writes.length;
    const out = await create(ownerB, valid());
    assert.equal(out.status, 403, JSON.stringify(out.body));
    assert.equal(out.body.message, "Not authorized for this application");
    assert.equal(docsIn("paymentRequests").length, 0);
    assert.equal(writes.length, before);
    assert.equal(sent.length, 0);
  });

  test("#337: that same owner may bill their own agency's case (the refusal above is about the agency, not the role)", async () => {
    await seedOwnerB();
    const out = await create(ownerB, valid({ applicationId: APP_B }));
    assert.equal(out.status, 201, JSON.stringify(out.body));
    const [, pr] = docsIn("paymentRequests")[0];
    assert.equal(pr.agentId, "prof-owner-b");
    assert.equal(pr.agencyId, "agency-b");
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

// ============================================
// Issue #337: the compliance gate for OWNERS, on stored agency documents
// ============================================
// The test above replaces `isVerified`. These run the real one against the
// fake `agencies` collection, so they pin what the gate reads off the agency
// document: `compliance.status === "verified"`, nothing else.
describe("POST /payment-requests: #337 an owner and the compliance gate", () => {
  // Every way an agency can be "not verified", including the shape the seed
  // used to write: approved, with NO compliance field at all.
  for (const [label, agencyDoc] of [
    ["no compliance field (the seeded agency before #337)", { status: "approved" }],
    ["not_started", { status: "approved", compliance: { status: "not_started" } }],
    ["in_progress", { status: "approved", compliance: { status: "in_progress" } }],
    ["under_review", { status: "approved", compliance: { status: "under_review" } }],
    ["rejected", { status: "approved", compliance: { status: "rejected" } }],
  ] as Array<[string, Record<string, unknown>]>) {
    test(`an owner of an unverified agency gets 403 COMPLIANCE_REQUIRED: ${label}`, async () => {
      await seed("agencies", "agency-a", { name: "Agency A", ownerId: ownerA.uid, ...agencyDoc });
      const { out, nextCalled } = await runComplianceGate(ownerA);
      assert.equal(nextCalled, false);
      assert.equal(out.status, 403);
      assert.equal(out.body.error, "COMPLIANCE_REQUIRED");
    });
  }

  test("an owner whose agency document does not exist is refused too", async () => {
    const { out, nextCalled } = await runComplianceGate(ownerA);
    assert.equal(nextCalled, false);
    assert.equal(out.body.error, "COMPLIANCE_REQUIRED");
  });

  test("the compliance file the seed writes on the demo agency lets its owner AND its member agents through", async () => {
    // Exactly what `seedAgency()` stores under `compliance`.
    await seed("agencies", SEED_AGENCY_ID, {
      name: "Seli Immigration Services",
      status: "approved",
      compliance: buildSeedAgencyCompliance(),
    });
    const seedOwner: AuthzSubject = { uid: "seed-user-owner-001", role: ROLES.OWNER, agencyId: SEED_AGENCY_ID };
    const seedMember: AuthzSubject = { uid: "seed-user-agent-001", role: ROLES.AGENT, agencyId: SEED_AGENCY_ID };
    assert.equal((await runComplianceGate(seedOwner)).nextCalled, true);
    // The gate is per agency: members pass it too (the CASE rule, not this
    // gate, is what keeps a colleague read-only).
    assert.equal((await runComplianceGate(seedMember)).nextCalled, true);
    assert.equal(await complianceService.isVerified(SEED_AGENCY_ID), true);
  });

  test("the seeded compliance file is a verified file with a full admin review record and no invented KYC data", () => {
    const file = buildSeedAgencyCompliance() as unknown as Record<string, any>;
    assert.equal(file.status, "verified");
    // What `npm run audit:agencies` needs for a decided file
    // (COMPLIANCE_DECISION_WITHOUT_REVIEW / COMPLIANCE_REVIEWER_NOT_ADMIN).
    assert.equal(file.reviewedBy, SEED_COMPLIANCE_REVIEWER_UID);
    assert.equal(SEED_COMPLIANCE_REVIEWER_UID, "seed-user-admin-001");
    assert.ok(file.submittedAt && file.reviewedAt);
    // Submitted before it was reviewed, both in the past.
    assert.ok(file.submittedAt.toMillis() < file.reviewedAt.toMillis());
    assert.ok(file.reviewedAt.toMillis() < Date.now());
    // Only the four review fields: no BVN, ID number, RC number, TIN, bank
    // account or document path is made up for demo data.
    assert.deepEqual(Object.keys(file).sort(), ["reviewedAt", "reviewedBy", "status", "submittedAt"]);
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
