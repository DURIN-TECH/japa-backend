// ============================================
// Unit tests — an agent books only for a client they already work with (issue #246)
// ============================================
//
// Hermetic (test/consultations/harness.ts): in-memory Firestore, Paystack
// stubbed. The agent-initiated path of POST /consultations (the caller has an
// agent profile, body `userId` = the client).
//
// What is covered, by acceptance criterion:
//  - a client with no link to the caller: 403 FORBIDDEN, nothing written, no
//    quote locked, no Paystack checkout, no notification;
//  - a client of ANOTHER agent / agency (application, conversation and
//    consultation all exist, but with someone else): the same 403;
//  - a `userId` that does not exist: the same 403, byte for byte, and the
//    users collection is never read before the refusal;
//  - a conversation counts only when its `agentId` is the caller's agent
//    DOCUMENT id (never their uid);
//  - `applicationId` must be that client's application with this agent or
//    agency: a foreign, another-client's or unknown id is 403;
//  - a genuine client books as before (201 with requiresPayment,
//    authorizationUrl and reference) through EACH relationship: application
//    by agent, application by agency, conversation, earlier consultation by
//    agent, earlier consultation by agency (any status);
//  - the client-initiated path (body `agentId`) is unchanged.
import { test, describe, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { defineAbilitiesFor, ROLES } from "@durin-tech/authz";
import type { AuthzSubject } from "@durin-tech/authz";

import { writes } from "../helpers/fake-firestore";
import { useHarness, harness, captureRes, docsIn, seed, T0 } from "./harness";
import { consultationController } from "../../src/controllers/consultation.controller";
import { notificationService } from "../../src/services/notification.service";

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Every notification sent during a test. */
const notified: unknown[] = [];
/** Every read of a `users/{id}` document during a test (the refusal must come before any). */
const userReads: string[] = [];

before(async () => {
  await useHarness();
  (notificationService as any).notifyUser = async (n: unknown) => {
    notified.push(n);
  };
  // Record reads of user documents: wrap the fake `users` collection's doc().
  const firebase: any = await import("../../src/utils/firebase");
  const users = firebase.collections.users;
  const realDoc = users.doc.bind(users);
  users.doc = (id?: string) => {
    const ref = realDoc(id);
    const realGet = ref.get.bind(ref);
    ref.get = async () => {
      userReads.push(ref.id);
      return realGet();
    };
    return ref;
  };
});
beforeEach(async () => {
  harness.reset();
  notified.length = 0;
  userReads.length = 0;
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  console.log = () => {};
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  console.error = () => {};

  // The caller: agent 1 (doc id "agent1", uid "uid-agent1") of agency A, $10 fee.
  await seed("agents", "agent1", {
    userId: "uid-agent1", agencyId: "agency-a", displayName: "Ada Agent", verificationStatus: "verified",
    isAvailable: true, consultationFeeUsd: { amountMinor: 1_000, currency: "USD" }, createdAt: T0,
  });
  // Another agent, of agency B (doc id "agent2", uid "uid-agent2").
  await seed("agents", "agent2", {
    userId: "uid-agent2", agencyId: "agency-b", displayName: "Bola Agent", verificationStatus: "verified",
    isAvailable: true, consultationFeeUsd: { amountMinor: 1_000, currency: "USD" }, createdAt: T0,
  });
  // Two real client accounts.
  await seed("users", "uid-client1", { email: "delivered+client1@resend.dev", firstName: "Chi", lastName: "Client", createdAt: T0 });
  await seed("users", "uid-client2", { email: "delivered+client2@resend.dev", firstName: "Dayo", lastName: "Other", createdAt: T0 });
  writes.length = 0;
});

// ============================================
// Principals and helpers
// ============================================

/** Agent 1 as verifyAuth resolves them (a member of agency A). */
const agent1: AuthzSubject = { uid: "uid-agent1", role: ROLES.AGENT, agencyId: "agency-a" };
/** Agent 1 as an INDEPENDENT agent (no agency on the principal). */
const agent1Solo: AuthzSubject = { uid: "uid-agent1", role: ROLES.AGENT, agencyId: null };

/** Seed a doc and forget the write, so `writes` holds only what the request wrote. */
async function given(collection: string, id: string, data: Record<string, unknown>) {
  await seed(collection, id, { createdAt: T0, ...data });
  writes.length = 0;
}

/** POST /consultations as `p` with a body. */
async function book(p: AuthzSubject, body: Record<string, unknown>) {
  const { out, res } = captureRes();
  await consultationController.createConsultation(
    {
      userId: p.uid, authz: p, ability: defineAbilitiesFor(p), entitlements: null,
      body: { type: "initial", scheduledDate: "2026-12-01", scheduledTime: "10:00", ...body },
    } as any,
    res
  );
  return out;
}

/** The refusal: 403, and NOTHING happened (no write, no quote, no checkout, no notification, no user read). */
function assertForbidden(out: { status: number; body: any }, label: string) {
  assert.equal(out.status, 403, `${label}: ${JSON.stringify(out.body)}`);
  assert.equal(out.body.error, "FORBIDDEN", label);
  assert.equal(out.body.data, undefined, label);
  assert.deepEqual(writes, [], `${label}: nothing written`);
  assert.equal(harness.charges.length, 0, `${label}: no Paystack checkout`);
  assert.deepEqual(notified, [], `${label}: nothing sent`);
  assert.deepEqual(userReads, [], `${label}: the client's user doc was not read`);
  // The response names nobody.
  assert.ok(!JSON.stringify(out.body).includes("resend.dev"), label);
  assert.ok(!JSON.stringify(out.body).includes("Chi"), label);
}

/** A paid booking for client 1 by agent 1, as before the change. */
function assertBooked(out: { status: number; body: any }, label: string) {
  assert.equal(out.status, 201, `${label}: ${JSON.stringify(out.body)}`);
  const d = out.body.data;
  assert.equal(d.userId, "uid-client1", label);
  assert.equal(d.agentId, "uid-agent1", label);
  assert.equal(d.status, "pending_payment", label);
  assert.equal(d.requiresPayment, true, label);
  assert.ok(d.authorizationUrl, label);
  assert.ok(d.reference, label);
  assert.equal(d.clientName, "Chi Client", label);
  assert.equal(d.clientEmail, "delivered+client1@resend.dev", label);
  // The checkout is the client's, for the agent's own fee ($10 = ₦15,000).
  assert.equal(harness.charges.length, 1, label);
  assert.equal(harness.charges[0].email, "delivered+client1@resend.dev", label);
  assert.equal(harness.charges[0].amount.amountMinor, 1_500_000, label);
}

/** The bookings stored by the request under test (not the seeded earlier ones). */
function newBookings(seededIds: string[] = []) {
  return docsIn("consultations").filter(([id]) => !seededIds.includes(id));
}

// ============================================
// Refused
// ============================================

describe("agent-initiated booking — not the caller's client", () => {
  test("a client with no link to the caller: 403, nothing written or sent", async () => {
    const out = await book(agent1, { userId: "uid-client1" });
    assertForbidden(out, "unrelated");
    assert.equal(docsIn("consultations").length, 0);
  });

  test("a client of another agent and another agency: 403", async () => {
    // Client 1 works with agent 2 / agency B in every way, and not with the caller.
    await given("applications", "app-b", { userId: "uid-client1", agentId: "uid-agent2", agencyId: "agency-b" });
    await given("conversations", "conv-b", { userId: "uid-client1", agentId: "agent2" });
    await given("consultations", "old-b", {
      userId: "uid-client1", agentId: "uid-agent2", agencyId: "agency-b", status: "completed", paymentStatus: "paid",
    });
    // The caller works with a DIFFERENT client (client 2) in every way.
    await given("applications", "app-a2", { userId: "uid-client2", agentId: "uid-agent1", agencyId: "agency-a" });
    await given("conversations", "conv-a2", { userId: "uid-client2", agentId: "agent1" });
    await given("consultations", "old-a2", {
      userId: "uid-client2", agentId: "uid-agent1", agencyId: "agency-a", status: "completed", paymentStatus: "paid",
    });
    const out = await book(agent1, { userId: "uid-client1" });
    assertForbidden(out, "another agency's client");
    assert.equal(newBookings(["old-b", "old-a2"]).length, 0);
  });

  test("a userId that does not exist gets exactly the same 403 as a stranger", async () => {
    const stranger = await book(agent1, { userId: "uid-client1" });
    const missing = await book(agent1, { userId: "uid-nobody" });
    assertForbidden(missing, "nonexistent");
    assert.equal(missing.status, stranger.status);
    assert.deepEqual(missing.body, stranger.body);
  });

  test("a conversation counts only by the agent DOCUMENT id, never the agent's uid", async () => {
    // Stored with the caller's UID in agentId: not how conversations are keyed.
    await given("conversations", "conv-uid", { userId: "uid-client1", agentId: "uid-agent1" });
    assertForbidden(await book(agent1, { userId: "uid-client1" }), "conversation keyed by uid");
  });

  test("an application or consultation keyed by the agent DOCUMENT id is not a link (those use the uid)", async () => {
    await given("applications", "app-doc", { userId: "uid-client1", agentId: "agent1" });
    await given("consultations", "old-doc", { userId: "uid-client1", agentId: "agent1", status: "completed" });
    assertForbidden(await book(agent1Solo, { userId: "uid-client1" }), "keyed by doc id");
  });

  test("an independent agent is not linked through docs that merely have no agency", async () => {
    // Self-serve application and a booking with another agent: no agencyId on either.
    await given("applications", "app-self", { userId: "uid-client1" });
    await given("consultations", "old-other", { userId: "uid-client1", agentId: "uid-agent2", status: "completed" });
    assertForbidden(await book(agent1Solo, { userId: "uid-client1" }), "independent agent");
  });

  test("the refusal comes before pricing: an agent with a FREE fee is refused too", async () => {
    await given("agents", "agent1", {
      userId: "uid-agent1", agencyId: "agency-a", displayName: "Ada Agent", verificationStatus: "verified", isAvailable: true,
    });
    assertForbidden(await book(agent1, { userId: "uid-client1" }), "free fee");
    assert.equal(docsIn("consultations").length, 0);
  });

  test("a userId that is not a plain id is 400, nothing written", async () => {
    for (const bad of [{ $ne: "" }, 7, ["uid-client1"], "  ", "users/uid-client1"]) {
      const out = await book(agent1, { userId: bad });
      assert.equal(out.status, 400, JSON.stringify(bad));
      assert.equal(out.body.error, "VALIDATION_ERROR", JSON.stringify(bad));
      assert.deepEqual(writes, [], JSON.stringify(bad));
      assert.deepEqual(userReads, [], JSON.stringify(bad));
    }
  });
});

// ============================================
// applicationId
// ============================================

describe("agent-initiated booking — applicationId", () => {
  beforeEach(async () => {
    // Client 1 IS the caller's client (an earlier conversation).
    await given("conversations", "conv-a", { userId: "uid-client1", agentId: "agent1" });
  });

  test("another agency's application of the same client: 403", async () => {
    await given("applications", "app-b", { userId: "uid-client1", agentId: "uid-agent2", agencyId: "agency-b" });
    assertForbidden(await book(agent1, { userId: "uid-client1", applicationId: "app-b" }), "foreign application");
    assert.equal(docsIn("consultations").length, 0);
  });

  test("another client's application with this agent: 403", async () => {
    await given("applications", "app-c2", { userId: "uid-client2", agentId: "uid-agent1", agencyId: "agency-a" });
    assertForbidden(await book(agent1, { userId: "uid-client1", applicationId: "app-c2" }), "another client's application");
  });

  test("an application id that does not exist: 403", async () => {
    assertForbidden(await book(agent1, { userId: "uid-client1", applicationId: "app-nope" }), "unknown application");
  });

  test("a self-serve application (no agent, no agency) is not the caller's: 403", async () => {
    await given("applications", "app-self", { userId: "uid-client1" });
    assertForbidden(await book(agent1Solo, { userId: "uid-client1", applicationId: "app-self" }), "self-serve application");
  });

  test("an applicationId that is not a plain id is 400", async () => {
    for (const bad of [{ id: "app-a" }, 5, "applications/app-a"]) {
      const out = await book(agent1, { userId: "uid-client1", applicationId: bad });
      assert.equal(out.status, 400, JSON.stringify(bad));
      assert.equal(out.body.error, "VALIDATION_ERROR");
      assert.deepEqual(writes, []);
    }
  });

  test("the client's application assigned to this agent: 201, linked on the booking", async () => {
    await given("applications", "app-a", { userId: "uid-client1", agentId: "uid-agent1" });
    const out = await book(agent1, { userId: "uid-client1", applicationId: "app-a" });
    assertBooked(out, "own application");
    assert.equal(out.body.data.applicationId, "app-a");
    assert.equal(docsIn("consultations")[0][1].applicationId, "app-a");
  });

  test("the client's application in the caller's agency (assigned to a colleague): 201", async () => {
    await given("applications", "app-ag", { userId: "uid-client1", agentId: "uid-colleague", agencyId: "agency-a" });
    const out = await book(agent1, { userId: "uid-client1", applicationId: "app-ag" });
    assertBooked(out, "agency application");
    assert.equal(out.body.data.applicationId, "app-ag");
  });
});

// ============================================
// Genuine clients, one relationship at a time
// ============================================

describe("agent-initiated booking — a genuine client books as before", () => {
  test("via an application assigned to the agent", async () => {
    await given("applications", "app-a", { userId: "uid-client1", agentId: "uid-agent1" });
    assertBooked(await book(agent1Solo, { userId: "uid-client1" }), "application by agent");
    assert.equal(docsIn("consultations").length, 1);
  });

  test("via an application of the agent's agency", async () => {
    await given("applications", "app-ag", { userId: "uid-client1", agentId: "uid-colleague", agencyId: "agency-a" });
    const out = await book(agent1, { userId: "uid-client1" });
    assertBooked(out, "application by agency");
    // Filed under the caller's resolved agency, as before.
    assert.equal(out.body.data.agencyId, "agency-a");
  });

  test("via a conversation with the agent (agent DOCUMENT id)", async () => {
    await given("conversations", "conv-a", { userId: "uid-client1", agentId: "agent1" });
    assertBooked(await book(agent1, { userId: "uid-client1" }), "conversation");
  });

  test("via an earlier consultation with the agent, in any status", async () => {
    for (const status of ["completed", "cancelled", "pending_payment", "no_show"]) {
      harness.reset();
      await given("agents", "agent1", {
        userId: "uid-agent1", displayName: "Ada Agent", verificationStatus: "verified", isAvailable: true,
        consultationFeeUsd: { amountMinor: 1_000, currency: "USD" },
      });
      await given("users", "uid-client1", { email: "delivered+client1@resend.dev", firstName: "Chi", lastName: "Client" });
      await given("consultations", "old-a", { userId: "uid-client1", agentId: "uid-agent1", status, paymentStatus: "pending" });
      assertBooked(await book(agent1Solo, { userId: "uid-client1" }), `earlier consultation (${status})`);
      assert.equal(newBookings(["old-a"]).length, 1, status);
    }
  });

  test("via an earlier consultation with the agent's agency (another agent's booking)", async () => {
    await given("consultations", "old-ag", {
      userId: "uid-client1", agentId: "uid-colleague", agencyId: "agency-a", status: "cancelled", paymentStatus: "pending",
    });
    assertBooked(await book(agent1, { userId: "uid-client1" }), "earlier consultation by agency");
  });

  test("the booking stores the quote and checkout as before", async () => {
    await given("conversations", "conv-a", { userId: "uid-client1", agentId: "agent1" });
    const out = await book(agent1, { userId: "uid-client1" });
    assertBooked(out, "stored");
    const stored = docsIn("consultations")[0][1];
    assert.equal(stored.priceUsdCents, 1_000);
    assert.equal(stored.chargedAmountMinor, 1_500_000);
    assert.equal(stored.transactionId, out.body.data.reference);
    assert.ok(stored.quoteExpiresAt);
  });
});

// ============================================
// Client-initiated path: unchanged
// ============================================

describe("client-initiated booking (body agentId) is unchanged", () => {
  const client1: AuthzSubject = { uid: "uid-client1", role: ROLES.CLIENT, agencyId: null };

  test("a client books an agent they have never dealt with: 201", async () => {
    // Agency B must be approved for its agent to be bookable (issue #180).
    await given("agencies", "agency-b", { name: "Bola Visas", status: "approved" });
    const out = await book(client1, { agentId: "agent2" });
    assert.equal(out.status, 201, JSON.stringify(out.body));
    assert.equal(out.body.data.userId, "uid-client1");
    assert.equal(out.body.data.agentId, "uid-agent2");
    assert.equal(out.body.data.requiresPayment, true);
    assert.ok(out.body.data.reference);
  });

  test("a body userId is ignored for a client: they can only book for themselves", async () => {
    await given("agencies", "agency-b", { name: "Bola Visas", status: "approved" });
    const out = await book(client1, { agentId: "agent2", userId: "uid-client2" });
    assert.equal(out.status, 201, JSON.stringify(out.body));
    assert.equal(out.body.data.userId, "uid-client1");
    assert.equal(harness.charges[0].email, "delivered+client1@resend.dev");
  });
});
