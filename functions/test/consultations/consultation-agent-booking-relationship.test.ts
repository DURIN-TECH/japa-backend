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
//
// Issue #321 (what COUNTS as a relationship), a counting and a non-counting
// case for each source:
//  - guest booking from the public page: unpaid and free do not count, paid
//    does (seeded rows, and end to end through the real public route);
//  - a booking an agent made: unpaid and free do not count, paid does;
//  - a booking the signed-in client made: counts, even free or unpaid;
//  - a row from before #321 (no `bookedVia`): counts only when paid;
//  - `paymentStatus: "paid"` with no `paidAt` (a free booking) never counts,
//    and does not hide a really paid one next to it;
//  - a conversation: counts when the client started it or has sent a message
//    in it; not when the agent started it and only the agent wrote (seeded,
//    and end to end through POST /conversations);
//  - new rows store `bookedVia` / `startedBy`;
//  - a `userId` / `applicationId` of `.`, `..`, `__x__` or over 1500 bytes is
//    400 before any read.
import { test, describe, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { defineAbilitiesFor, ROLES } from "@durin-tech/authz";
import type { AuthzSubject } from "@durin-tech/authz";

import { writes } from "../helpers/fake-firestore";
import { useHarness, harness, captureRes, docsIn, seed, T0, paystackPaid } from "./harness";
import { consultationController } from "../../src/controllers/consultation.controller";
import { createConversation } from "../../src/controllers/messaging.controller";
import { messagingService } from "../../src/services/messaging.service";
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

/** Ids Firestore refuses as a document id (issue #321): each must be a 400, never a 500. */
const BAD_DOC_IDS = [".", "..", "__x__", "__name__", "____", "a/b", "/", "x".repeat(1501), "é".repeat(751)];

/** Every relationship query run since the last reset (collection name per `where`). */
const reads: string[] = [];
let readsCounted = false;
/** Record every `where` on the three relationship collections (idempotent). */
async function countReads() {
  if (readsCounted) return;
  readsCounted = true;
  const firebase: any = await import("../../src/utils/firebase");
  for (const name of ["applications", "conversations", "consultations"]) {
    const col = firebase.collections[name];
    const realWhere = col.where.bind(col);
    col.where = (...args: unknown[]) => {
      reads.push(name);
      return realWhere(...args);
    };
    const realDoc = col.doc.bind(col);
    col.doc = (id?: string) => {
      const ref = realDoc(id);
      const realGet = ref.get.bind(ref);
      ref.get = async () => {
        reads.push(name);
        return realGet();
      };
      return ref;
    };
  }
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
    // (Each is the kind that COUNTS under #321: client-started, client-booked and paid.)
    await given("conversations", "conv-b", { userId: "uid-client1", agentId: "agent2", startedBy: "user" });
    await given("consultations", "old-b", {
      userId: "uid-client1", agentId: "uid-agent2", agencyId: "agency-b", status: "completed", paymentStatus: "paid",
      bookedVia: "client", paidAt: T0,
    });
    // The caller works with a DIFFERENT client (client 2) in every way.
    await given("applications", "app-a2", { userId: "uid-client2", agentId: "uid-agent1", agencyId: "agency-a" });
    await given("conversations", "conv-a2", { userId: "uid-client2", agentId: "agent1", startedBy: "user" });
    await given("consultations", "old-a2", {
      userId: "uid-client2", agentId: "uid-agent1", agencyId: "agency-a", status: "completed", paymentStatus: "paid",
      bookedVia: "client", paidAt: T0,
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
    await given("conversations", "conv-uid", { userId: "uid-client1", agentId: "uid-agent1", startedBy: "user" });
    assertForbidden(await book(agent1, { userId: "uid-client1" }), "conversation keyed by uid");
  });

  test("an application or consultation keyed by the agent DOCUMENT id is not a link (those use the uid)", async () => {
    await given("applications", "app-doc", { userId: "uid-client1", agentId: "agent1" });
    await given("consultations", "old-doc", {
      userId: "uid-client1", agentId: "agent1", status: "completed", bookedVia: "client", paymentStatus: "paid", paidAt: T0,
    });
    assertForbidden(await book(agent1Solo, { userId: "uid-client1" }), "keyed by doc id");
  });

  test("an independent agent is not linked through docs that merely have no agency", async () => {
    // Self-serve application and a booking with another agent: no agencyId on either.
    await given("applications", "app-self", { userId: "uid-client1" });
    await given("consultations", "old-other", {
      userId: "uid-client1", agentId: "uid-agent2", status: "completed", bookedVia: "client", paymentStatus: "paid", paidAt: T0,
    });
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

  test("#321: a userId Firestore cannot use as a document id is 400 before any read, never 500", async () => {
    await countReads();
    for (const bad of BAD_DOC_IDS) {
      reads.length = 0;
      const out = await book(agent1, { userId: bad });
      const label = bad.length > 20 ? `${bad.length} chars` : bad;
      assert.equal(out.status, 400, label);
      assert.equal(out.body.error, "VALIDATION_ERROR", label);
      assert.deepEqual(writes, [], label);
      assert.deepEqual(userReads, [], label);
      // Only the caller's own agent profile was looked up: no relationship query ran.
      assert.deepEqual(reads, [], `${label}: no relationship query`);
    }
  });
});

// ============================================
// applicationId
// ============================================

describe("agent-initiated booking — applicationId", () => {
  beforeEach(async () => {
    // Client 1 IS the caller's client (a conversation the client started).
    await given("conversations", "conv-a", { userId: "uid-client1", agentId: "agent1", startedBy: "user" });
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

  test("#321: an applicationId Firestore cannot use as a document id is 400 before any read, never 500", async () => {
    await countReads();
    for (const bad of BAD_DOC_IDS) {
      reads.length = 0;
      const out = await book(agent1, { userId: "uid-client1", applicationId: bad });
      const label = bad.length > 20 ? `${bad.length} chars` : bad;
      assert.equal(out.status, 400, label);
      assert.equal(out.body.error, "VALIDATION_ERROR", label);
      assert.deepEqual(writes, [], label);
      assert.deepEqual(userReads, [], label);
      assert.deepEqual(reads, [], `${label}: no relationship query`);
    }
  });

  test("#321: an id of exactly 1500 bytes is still an id (403 for a stranger, not 400)", async () => {
    const out = await book(agent1, { userId: "u".repeat(1500) });
    assert.equal(out.status, 403);
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

  test("via a conversation the client started with the agent (agent DOCUMENT id)", async () => {
    await given("conversations", "conv-a", { userId: "uid-client1", agentId: "agent1", startedBy: "user" });
    assertBooked(await book(agent1, { userId: "uid-client1" }), "conversation");
  });

  test("via an earlier consultation the client booked with the agent, in any status", async () => {
    for (const status of ["completed", "cancelled", "pending_payment", "no_show"]) {
      harness.reset();
      await given("agents", "agent1", {
        userId: "uid-agent1", displayName: "Ada Agent", verificationStatus: "verified", isAvailable: true,
        consultationFeeUsd: { amountMinor: 1_000, currency: "USD" },
      });
      await given("users", "uid-client1", { email: "delivered+client1@resend.dev", firstName: "Chi", lastName: "Client" });
      await given("consultations", "old-a", {
        userId: "uid-client1", agentId: "uid-agent1", status, paymentStatus: "pending", bookedVia: "client",
      });
      assertBooked(await book(agent1Solo, { userId: "uid-client1" }), `earlier consultation (${status})`);
      assert.equal(newBookings(["old-a"]).length, 1, status);
    }
  });

  test("via an earlier consultation the client booked with the agent's agency (a colleague's booking)", async () => {
    await given("consultations", "old-ag", {
      userId: "uid-client1", agentId: "uid-colleague", agencyId: "agency-a", status: "cancelled", paymentStatus: "pending",
      bookedVia: "client",
    });
    assertBooked(await book(agent1, { userId: "uid-client1" }), "earlier consultation by agency");
  });

  test("the booking stores the quote and checkout as before, and that an agent made it", async () => {
    await given("conversations", "conv-a", { userId: "uid-client1", agentId: "agent1", startedBy: "user" });
    const out = await book(agent1, { userId: "uid-client1" });
    assertBooked(out, "stored");
    const stored = docsIn("consultations")[0][1];
    assert.equal(stored.priceUsdCents, 1_000);
    assert.equal(stored.chargedAmountMinor, 1_500_000);
    assert.equal(stored.transactionId, out.body.data.reference);
    assert.ok(stored.quoteExpiresAt);
    // Issue #321: how it was booked is stored, once, at creation.
    assert.equal(stored.bookedVia, "agent");
  });
});

// ============================================
// Issue #321: what counts as a relationship
// ============================================

/** Agent 1's agent doc WITHOUT an agency (for the independent-agent cases). */
async function soloAgent1() {
  await given("agents", "agent1", {
    userId: "uid-agent1", displayName: "Ada Agent", verificationStatus: "verified", isAvailable: true,
    consultationFeeUsd: { amountMinor: 1_000, currency: "USD" },
  });
}

/** An earlier consultation of client 1 with agent 1 (uid), plus `over`. */
async function earlier(id: string, over: Record<string, unknown>) {
  await given("consultations", id, { userId: "uid-client1", agentId: "uid-agent1", status: "scheduled", ...over });
}

/** A message in conversation `convId`. */
async function message(convId: string, id: string, senderId: string, senderType: "user" | "agent") {
  await seed(`conversations/${convId}/messages`, id, {
    conversationId: convId, senderId, senderType, content: "hello", isRead: false, createdAt: T0,
  });
  writes.length = 0;
}

describe("#321 — an earlier consultation counts only if the client booked it or it was paid", () => {
  /** [label, the stored fields, does it count?] */
  const CASES: Array<[string, Record<string, unknown>, boolean]> = [
    // Guest booking from the public page.
    ["guest, unpaid", { bookedVia: "public_page", status: "pending_payment", paymentStatus: "pending", priceUsdCents: 1_000 }, false],
    ["guest, free", { bookedVia: "public_page", paymentStatus: "paid", priceUsdCents: 0 }, false],
    ["guest, paid", { bookedVia: "public_page", paymentStatus: "paid", priceUsdCents: 1_000, paidAt: T0 }, true],
    // Booked by an agent.
    ["agent-made, unpaid", { bookedVia: "agent", status: "pending_payment", paymentStatus: "pending", priceUsdCents: 1_000 }, false],
    ["agent-made, free", { bookedVia: "agent", paymentStatus: "paid", priceUsdCents: 0 }, false],
    ["agent-made, paid", { bookedVia: "agent", paymentStatus: "paid", priceUsdCents: 1_000, paidAt: T0 }, true],
    // Booked by the signed-in client.
    ["client-made, free", { bookedVia: "client", paymentStatus: "paid", priceUsdCents: 0 }, true],
    ["client-made, unpaid", { bookedVia: "client", status: "pending_payment", paymentStatus: "pending", priceUsdCents: 1_000 }, true],
    // Rows from before #321 (no bookedVia): only the paid check.
    ["no bookedVia, unpaid", { status: "pending_payment", paymentStatus: "pending" }, false],
    ["no bookedVia, free (paid with no paidAt)", { status: "completed", paymentStatus: "paid" }, false],
    ["no bookedVia, paid", { status: "completed", paymentStatus: "paid", paidAt: T0 }, true],
    // paidAt alone is not "paid": the payment was refunded.
    ["refunded", { bookedVia: "agent", status: "cancelled", paymentStatus: "refunded", paidAt: T0 }, false],
    // An unknown bookedVia value is not "client".
    ["unknown bookedVia", { bookedVia: "Client", paymentStatus: "pending" }, false],
  ];

  for (const [label, fields, counts] of CASES) {
    test(`with the agent — ${label}: ${counts ? "201" : "403"}`, async () => {
      await soloAgent1();
      await earlier("old-a", fields);
      const out = await book(agent1Solo, { userId: "uid-client1" });
      if (counts) {
        assertBooked(out, label);
      } else {
        assertForbidden(out, label);
        assert.equal(newBookings(["old-a"]).length, 0, label);
      }
    });

    test(`with the agent's agency (a colleague's booking) — ${label}: ${counts ? "201" : "403"}`, async () => {
      await earlier("old-ag", { ...fields, agentId: "uid-colleague", agencyId: "agency-a" });
      const out = await book(agent1, { userId: "uid-client1" });
      if (counts) {
        assertBooked(out, label);
      } else {
        assertForbidden(out, label);
        assert.equal(newBookings(["old-ag"]).length, 0, label);
      }
    });
  }

  test("an agency booking does not count for an agent whose principal has no agency", async () => {
    await soloAgent1();
    await earlier("old-ag", { agentId: "uid-colleague", agencyId: "agency-a", bookedVia: "client", paymentStatus: "paid", paidAt: T0 });
    assertForbidden(await book(agent1Solo, { userId: "uid-client1" }), "agency link without an agency");
  });

  test("free bookings next to a paid one do not hide it", async () => {
    await soloAgent1();
    // Many free agent-made bookings (paymentStatus paid, no paidAt) and ONE really paid.
    for (let i = 0; i < 6; i++) await earlier(`free-${i}`, { bookedVia: "agent", paymentStatus: "paid", priceUsdCents: 0 });
    assertForbidden(await book(agent1Solo, { userId: "uid-client1" }), "free only");
    await earlier("zz-paid", { bookedVia: "agent", paymentStatus: "paid", priceUsdCents: 1_000, paidAt: T0 });
    assertBooked(await book(agent1Solo, { userId: "uid-client1" }), "free + paid");
  });

  test("an agent cannot build a relationship by booking: their own unpaid booking never unlocks the next one", async () => {
    // The first booking is legitimate (a conversation the client started)...
    await given("conversations", "conv-a", { userId: "uid-client1", agentId: "agent1", startedBy: "user" });
    assertBooked(await book(agent1, { userId: "uid-client1" }), "first");
    const [firstId, first] = docsIn("consultations")[0];
    assert.equal(first.bookedVia, "agent");
    assert.equal(first.paidAt, undefined);
    // ...then that link goes away: the unpaid agent-made booking alone is not one.
    harness.reset();
    notified.length = 0;
    userReads.length = 0;
    await given("agents", "agent1", {
      userId: "uid-agent1", agencyId: "agency-a", displayName: "Ada Agent", verificationStatus: "verified",
      isAvailable: true, consultationFeeUsd: { amountMinor: 1_000, currency: "USD" },
    });
    await given("users", "uid-client1", { email: "delivered+client1@resend.dev", firstName: "Chi", lastName: "Client" });
    await given("consultations", firstId, first);
    assertForbidden(await book(agent1, { userId: "uid-client1" }), "own unpaid booking");
  });
});

describe("#321 — a guest booking from the public page (the real route)", () => {
  /** Agency A with a public page; its owner is agent 1 (the guest flow books the owner). */
  async function agencyA(feeMinor: number | null) {
    await given("agencies", "agency-a", {
      name: "Acme Visas", slug: "acme", status: "approved", ownerId: "uid-agent1", ownerName: "Ada Agent", services: [],
      ...(feeMinor === null ? {} : { consultationFeeUsd: { amountMinor: feeMinor, currency: "USD" } }),
    });
  }
  /** Someone types client 1's email into agency A's public booking form. */
  async function guestBook() {
    const { out, res } = captureRes();
    await consultationController.createPublicConsultation(
      {
        params: { slug: "acme" },
        body: {
          clientName: "Chi Client", clientEmail: "delivered+client1@resend.dev",
          scheduledDate: "2026-12-01", scheduledTime: "10:00",
        },
      } as any,
      res
    );
    assert.equal(out.status, 201, JSON.stringify(out.body));
    return out.body.data as { consultationId: string; reference?: string };
  }
  /** Forget what the guest booking wrote, sent and read, so the assertions see only the agent's request. */
  function forget() {
    writes.length = 0;
    notified.length = 0;
    userReads.length = 0;
    harness.charges.length = 0;
  }
  /** The owner of agency A, as verifyAuth resolves them. */
  const ownerA: AuthzSubject = { uid: "uid-agent1", role: ROLES.OWNER, agencyId: "agency-a" };

  test("a FREE guest booking for an existing client's email: the agency's agent then books for that uid: 403, nothing written", async () => {
    await agencyA(null);
    const guest = await guestBook();
    const stored = docsIn("consultations").find(([id]) => id === guest.consultationId)![1];
    // It landed on the EXISTING account, for the agency, free, marked as a guest booking.
    assert.equal(stored.userId, "uid-client1");
    assert.equal(stored.agencyId, "agency-a");
    assert.equal(stored.priceUsdCents, 0);
    assert.equal(stored.paymentStatus, "paid");
    assert.equal(stored.paidAt, undefined);
    assert.equal(stored.bookedVia, "public_page");
    forget();

    for (const caller of [agent1, ownerA]) {
      assertForbidden(await book(caller, { userId: "uid-client1" }), `free guest booking (${caller.role})`);
      assert.equal(newBookings([guest.consultationId]).length, 0);
    }
  });

  test("an UNPAID guest booking does not count; once the guest PAYS it does", async () => {
    await agencyA(10_000);
    const guest = await guestBook();
    assert.ok(guest.reference, "a paid agency opens a checkout");
    assert.equal(docsIn("consultations").find(([id]) => id === guest.consultationId)![1].bookedVia, "public_page");
    forget();

    // Checkout open, not paid: no relationship.
    assertForbidden(await book(agent1, { userId: "uid-client1" }), "unpaid guest booking");

    // The guest pays ($100 = NGN 150,000) and the return leg confirms it.
    paystackPaid(guest.reference!, guest.consultationId, { amountMinor: 15_000_000, currency: "NGN" });
    const verified = captureRes();
    await consultationController.verifyPublicConsultation({ body: { reference: guest.reference } } as any, verified.res);
    const paid = docsIn("consultations").find(([id]) => id === guest.consultationId)![1];
    assert.equal(paid.paymentStatus, "paid", JSON.stringify(verified.out.body));
    assert.ok(paid.paidAt, "settlePayment stamps paidAt");
    forget();

    // Now the client really paid this agency: its agent may book for them.
    assertBooked(await book(agent1, { userId: "uid-client1" }), "paid guest booking");
  });
});

describe("#321 — a conversation counts only if the client started it or wrote in it", () => {
  test("agent-started, no message at all: 403", async () => {
    await given("conversations", "conv-a", { userId: "uid-client1", agentId: "agent1", startedBy: "agent" });
    assertForbidden(await book(agent1, { userId: "uid-client1" }), "agent-started, empty");
  });

  test("agent-started, only the agent wrote: 403", async () => {
    await given("conversations", "conv-a", { userId: "uid-client1", agentId: "agent1", startedBy: "agent" });
    await message("conv-a", "m1", "uid-agent1", "agent");
    await message("conv-a", "m2", "uid-agent1", "agent");
    assertForbidden(await book(agent1, { userId: "uid-client1" }), "agent-started, agent messages only");
  });

  test("agent-started, the client has sent a message: 201", async () => {
    await given("conversations", "conv-a", { userId: "uid-client1", agentId: "agent1", startedBy: "agent" });
    await message("conv-a", "m1", "uid-agent1", "agent");
    await message("conv-a", "m2", "uid-client1", "user");
    assertBooked(await book(agent1, { userId: "uid-client1" }), "client message");
  });

  test("client-started with no message yet: 201", async () => {
    await given("conversations", "conv-a", { userId: "uid-client1", agentId: "agent1", startedBy: "user" });
    assertBooked(await book(agent1, { userId: "uid-client1" }), "client-started");
  });

  test("a conversation from before #321 (no startedBy): 403 until the client has written in it", async () => {
    await given("conversations", "conv-a", { userId: "uid-client1", agentId: "agent1" });
    await message("conv-a", "m1", "uid-agent1", "agent");
    assertForbidden(await book(agent1, { userId: "uid-client1" }), "legacy, agent only");
    await message("conv-a", "m2", "uid-client1", "user");
    assertBooked(await book(agent1, { userId: "uid-client1" }), "legacy, client wrote");
  });

  test("a message must be the CLIENT's by both senderType and senderId", async () => {
    await given("conversations", "conv-a", { userId: "uid-client1", agentId: "agent1", startedBy: "agent" });
    // Labelled "user" but written by the agent's uid; and the client's uid labelled "agent".
    await message("conv-a", "m1", "uid-agent1", "user");
    await message("conv-a", "m2", "uid-client1", "agent");
    // Another user's "user" message.
    await message("conv-a", "m3", "uid-client2", "user");
    assertForbidden(await book(agent1, { userId: "uid-client1" }), "not the client's message");
  });

  test("the client's message in a conversation with ANOTHER agent is not a link to the caller", async () => {
    await given("conversations", "conv-b", { userId: "uid-client1", agentId: "agent2", startedBy: "agent" });
    await message("conv-b", "m1", "uid-client1", "user");
    await given("conversations", "conv-a", { userId: "uid-client1", agentId: "agent1", startedBy: "agent" });
    assertForbidden(await book(agent1, { userId: "uid-client1" }), "message with another agent");
  });

  test("the client's message is found in any of the pair's conversations (one per application)", async () => {
    await given("conversations", "conv-1", { userId: "uid-client1", agentId: "agent1", startedBy: "agent", applicationId: "app-1" });
    await given("conversations", "conv-2", { userId: "uid-client1", agentId: "agent1", startedBy: "agent", applicationId: "app-2" });
    await given("conversations", "conv-3", { userId: "uid-client1", agentId: "agent1", startedBy: "agent" });
    await message("conv-3", "m1", "uid-client1", "user");
    assertBooked(await book(agent1, { userId: "uid-client1" }), "third conversation");
  });
});

describe("#321 — POST /conversations records who started it", () => {
  /** POST /conversations as `p`. */
  async function open(p: AuthzSubject, body: Record<string, unknown>) {
    const { out, res } = captureRes();
    await createConversation(
      { userId: p.uid, authz: p, ability: defineAbilitiesFor(p), entitlements: null, body, params: {}, query: {} } as any,
      res
    );
    assert.equal(out.status, 201, JSON.stringify(out.body));
    return out.body.data as { id: string };
  }
  const client1: AuthzSubject = { uid: "uid-client1", role: ROLES.CLIENT, agencyId: null };

  test("the check from the issue: an agent opens a conversation with a stranger's uid and writes in it, then books: 403", async () => {
    const conv = await open(agent1, { participantId: "uid-client1" });
    const stored = docsIn("conversations").find(([id]) => id === conv.id)![1];
    assert.equal(stored.userId, "uid-client1");
    assert.equal(stored.agentId, "agent1");
    assert.equal(stored.startedBy, "agent");
    // The agent's message, as POST /conversations/:id/messages stores it.
    await message(conv.id, "m1", "uid-agent1", "agent");
    notified.length = 0;
    userReads.length = 0;

    assertForbidden(await book(agent1, { userId: "uid-client1" }), "agent-opened conversation");
    assert.equal(docsIn("consultations").length, 0);
  });

  test("a conversation the CLIENT opens is stored startedBy user, and the agent may then book", async () => {
    const conv = await open(client1, { participantId: "agent1" });
    const stored = docsIn("conversations").find(([id]) => id === conv.id)![1];
    assert.equal(stored.userId, "uid-client1");
    assert.equal(stored.agentId, "agent1");
    assert.equal(stored.startedBy, "user");
    writes.length = 0;
    notified.length = 0;
    userReads.length = 0;

    assertBooked(await book(agent1, { userId: "uid-client1" }), "client-opened conversation");
  });

  test("the client opening a chat the agent started does not rewrite startedBy", async () => {
    const byAgent = await open(agent1, { participantId: "uid-client1" });
    const again = await open(client1, { participantId: "agent1" });
    assert.equal(again.id, byAgent.id, "the same conversation is returned");
    assert.equal(docsIn("conversations").length, 1);
    assert.equal(docsIn("conversations")[0][1].startedBy, "agent");
    writes.length = 0;
    notified.length = 0;
    userReads.length = 0;
    assertForbidden(await book(agent1, { userId: "uid-client1" }), "still agent-started");
  });

  test("getOrCreateConversation defaults to agent (the side that does not count)", async () => {
    // The backend callers that do not say who started it (an agent creating an
    // application, a payment-request rejection) must never make a relationship.
    const conv = await messagingService.getOrCreateConversation("uid-client1", "agent1", "app-x");
    assert.equal(conv.startedBy, "agent");
    assert.equal(docsIn("conversations")[0][1].startedBy, "agent");
    writes.length = 0;
    assertForbidden(await book(agent1, { userId: "uid-client1" }), "default startedBy");
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
    // Issue #321: stored as booked by the client themselves.
    assert.equal(docsIn("consultations")[0][1].bookedVia, "client");
  });

  test("#321: after the client books an agent themselves (even unpaid), that agent may book for them", async () => {
    await given("agencies", "agency-b", { name: "Bola Visas", status: "approved" });
    const own = await book(client1, { agentId: "agent2" });
    assert.equal(own.status, 201, JSON.stringify(own.body));
    writes.length = 0;
    notified.length = 0;
    userReads.length = 0;
    harness.charges.length = 0;
    const agent2: AuthzSubject = { uid: "uid-agent2", role: ROLES.AGENT, agencyId: "agency-b" };
    const out = await book(agent2, { userId: "uid-client1" });
    assert.equal(out.status, 201, JSON.stringify(out.body));
    assert.equal(out.body.data.agentId, "uid-agent2");
    // Agent 1 (another agency) still may not.
    writes.length = 0;
    harness.charges.length = 0;
    userReads.length = 0;
    assertForbidden(await book(agent1, { userId: "uid-client1" }), "another agent");
  });

  test("a body userId is ignored for a client: they can only book for themselves", async () => {
    await given("agencies", "agency-b", { name: "Bola Visas", status: "approved" });
    const out = await book(client1, { agentId: "agent2", userId: "uid-client2" });
    assert.equal(out.status, 201, JSON.stringify(out.body));
    assert.equal(out.body.data.userId, "uid-client1");
    assert.equal(harness.charges[0].email, "delivered+client1@resend.dev");
  });
});
